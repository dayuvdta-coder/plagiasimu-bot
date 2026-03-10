const fs = require("fs/promises");
const path = require("path");
const { chromium } = require("playwright");
const {
  classifyAssignmentAction,
  classifyAssignmentDashboardState,
  classifyClassAction,
  dedupeActions,
  normalizeWhitespace,
} = require("./turnitin-dom");
const {
  areFilesByteIdentical,
  doesPdfMatchRequestedReportOptions,
  extractTurnitinReportSimilarityFromText,
  isLikelyViewerUrl,
  looksLikeTurnitinReportText: detectTurnitinReportText,
  pickStudioUrl,
  readTurnitinReportPdfMetadata,
} = require("./report-links");

const CLICKABLE_SELECTOR =
  'a[href], button, input[type="submit"], input[type="button"], summary';
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

function noop() {}

function createAbortError(message = "Job dibatalkan.") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function normalizeAbortReason(reason) {
  if (reason instanceof Error) {
    return reason;
  }

  return createAbortError(String(reason || "Job dibatalkan."));
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw normalizeAbortReason(signal.reason);
  }
}

function sanitizeFilename(value, fallback = "artifact") {
  const normalized = String(value || "")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function reportArtifactUrl(reportDir, fileName) {
  return `/storage/reports/${path.basename(reportDir)}/${fileName}`;
}

function normalizeLabel(value) {
  return normalizeWhitespace(value).toLowerCase();
}

function normalizeSimilarityForFilename(similarity) {
  const numeric = String(similarity || "")
    .trim()
    .match(/\b(100|[1-9]?\d)%?\b/);
  return numeric ? `${numeric[1]}pct` : "pending";
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFeedbackStudioUrl({ paperId, userId, language = "en_us" } = {}) {
  if (!paperId || !userId) {
    return null;
  }

  const normalizedLanguage = String(language || "en_us")
    .trim()
    .toLowerCase()
    .replace("-", "_");
  return `https://ev.turnitin.com/app/carta/${normalizedLanguage}/?o=${paperId}&ro=103&student_user=1&lang=${normalizedLanguage}&u=${userId}&s=1`;
}

class TurnitinAutomation {
  constructor(config) {
    this.config = config;
  }

  getBrowserLaunchOptions() {
    const chromiumSandbox = this.config.chromiumSandbox !== false;
    return {
      headless: this.config.headless,
      chromiumSandbox,
      args: chromiumSandbox ? [] : ["--no-sandbox"],
    };
  }

  async withSession(run, { signal } = {}) {
    throwIfAborted(signal);
    const browser = await chromium.launch(this.getBrowserLaunchOptions());

    const context = await browser.newContext({
      acceptDownloads: true,
      locale: "en-US",
      userAgent: DEFAULT_USER_AGENT,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(this.config.browserTimeoutMs);
    let abortListener = null;

    if (signal) {
      abortListener = () => {
        void page.close().catch(() => null);
        void context.close().catch(() => null);
        void browser.close().catch(() => null);
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }

    try {
      throwIfAborted(signal);
      return await run({ browser, context, page, signal });
    } finally {
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
      await context.close().catch(() => null);
      await browser.close().catch(() => null);
    }
  }

  async withAuthenticatedSession(account, onLog = noop, run, { signal } = {}) {
    return this.withSession(async (session) => {
      throwIfAborted(signal);
      await this.login(session.page, account, onLog);
      throwIfAborted(signal);
      await this.ensureEnglish(session.page, onLog);
      throwIfAborted(signal);
      return run(session);
    }, { signal });
  }

  async scanAccount(account, onLog = noop) {
    return this.withSession(async ({ page }) => {
      await this.login(page, account, onLog);
      await this.ensureEnglish(page, onLog);
      const summary = await this.scanDashboard(page, onLog);
      return {
        ...summary,
        accountEmail: account.email,
      };
    });
  }

  async inspectNextAssignment(
    account,
    { onLog = noop, openUpload = false, selectionHints = null } = {}
  ) {
    return this.withSession(async ({ page }) => {
      await this.login(page, account, onLog);
      await this.ensureEnglish(page, onLog);
      const selection = await this.findAvailableAssignment(page, onLog, { selectionHints });
      if (!selection.target) {
        return {
          status: "no-available-assignment",
          accountEmail: account.email,
          accountSummary: {
            ...selection.summary,
            accountEmail: account.email,
          },
        };
      }

      let debug = await this.captureDebugSnapshot(page, "assignment-inspect", {
        includeJson: true,
      });
      let uploadDebug = null;

      if (openUpload) {
        const uploadFrame = await this.openUploadDialog(page, onLog).catch(() => null);
        if (uploadFrame) {
          uploadDebug = await this.captureDebugSnapshot(uploadFrame, "assignment-upload-frame", {
            includeJson: true,
          });
        }
      }

      return {
        status: "ready",
        accountEmail: account.email,
        selection: selection.target,
        debug,
        uploadDebug,
      };
    });
  }

  async inspectAssignment(
    account,
    {
      className = null,
      assignmentKey = null,
      assignmentName = null,
      onLog = noop,
      openUpload = false,
    } = {}
  ) {
    if (!assignmentKey && !assignmentName) {
      throw new Error("assignmentKey atau assignmentName wajib diisi untuk debug assignment.");
    }

    return this.withSession(async ({ page }) => {
      await this.login(page, account, onLog);
      await this.ensureEnglish(page, onLog);

      const homeUrl = page.url();
      const classes = [];
      const initialClassRows = await this.listClassRows(page);

      for (let index = 0; index < initialClassRows.length; index += 1) {
        await page.goto(homeUrl, { waitUntil: "domcontentloaded" }).catch(() => null);
        await page.waitForTimeout(700);

        const currentClassRows = await this.listClassRows(page);
        const classRow = currentClassRows[index];
        if (!classRow) {
          continue;
        }

        const classInfo = classifyClassAction({
          label: "Open",
          containerText: classRow.rowText || classRow.name,
          containerLines: [classRow.name],
        });
        onLog(`Cek kelas ${classInfo.name}`);
        await page.goto(classRow.href, { waitUntil: "domcontentloaded" }).catch(() => null);
        await page.waitForTimeout(1200);

        const classUrl = page.url();
        const assignmentActions = await this.listAssignmentActions(page);
        const classSummary = this.toClassSummary(classInfo.name, classUrl, assignmentActions);
        classes.push(classSummary);

        if (className && normalizeLabel(classInfo.name) !== normalizeLabel(className)) {
          continue;
        }

        const matchedAssignment = assignmentActions.find((assignment) =>
          this.isMatchingAssignmentTarget(assignment, { assignmentKey, assignmentName })
        );
        if (!matchedAssignment) {
          continue;
        }

        onLog(`Periksa assignment ${matchedAssignment.name}`);
        await page.goto(classUrl, { waitUntil: "domcontentloaded" }).catch(() => null);
        await page.waitForTimeout(1200);

        const currentAssignments = await this.listAssignmentActions(page);
        const currentAssignment = currentAssignments.find((assignment) =>
          this.isMatchingAssignmentTarget(assignment, { assignmentKey, assignmentName })
        );
        if (!currentAssignment) {
          continue;
        }

        await this.clickAction(page, currentAssignment.actionId);
        await page.waitForTimeout(1200);

        const opportunity = await this.inspectAssignmentOpportunity(page);
        this.updateClassSummaryAssignment(
          classSummary,
          currentAssignment.key,
          opportunity.dashboardState
        );

        const actions = dedupeActions(await this.listActions(page, []).catch(() => []));
        const actionSummaries = actions.map((action) => ({
          id: action.actionId || null,
          label: action.label || "",
          disabled: Boolean(action.disabled),
          href: action.href || null,
        }));

        let debug = await this.captureDebugSnapshot(page, "assignment-live-inspect", {
          includeJson: true,
        });
        let uploadDebug = null;

        if (openUpload && opportunity.canSubmit) {
          const uploadFrame = await this.openUploadDialog(page, onLog).catch(() => null);
          if (uploadFrame) {
            uploadDebug = await this.captureDebugSnapshot(
              uploadFrame,
              "assignment-live-upload-frame",
              {
                includeJson: true,
              }
            );
          }
        }

        return {
          status: "ready",
          accountEmail: account.email,
          query: {
            className,
            assignmentKey,
            assignmentName,
          },
          selection: {
            className: classInfo.name,
            classUrl,
            assignmentName: currentAssignment.name,
            assignmentKey: currentAssignment.key,
            assignmentUrl: page.url(),
          },
          rowAssignment: currentAssignment,
          dashboard: {
            ...opportunity.dashboardState,
            canSubmit: opportunity.canSubmit,
            submissionMode: opportunity.canSubmit
              ? opportunity.dashboardState.status === "used"
                ? "resubmit"
                : "submit"
              : null,
            actions: actionSummaries,
          },
          debug,
          uploadDebug,
          accountSummary: {
            ...this.buildSummarySnapshot(classes, true),
            accountEmail: account.email,
          },
        };
      }

      return {
        status: "assignment-not-found",
        accountEmail: account.email,
        query: {
          className,
          assignmentKey,
          assignmentName,
        },
        accountSummary: {
          ...this.buildSummarySnapshot(classes, false),
          accountEmail: account.email,
        },
      };
    });
  }

  async submitWithAccount({
    account,
    filePath,
    originalName,
    title,
    reportOptions,
    jobId,
    reportDir,
    selectionHints = null,
    preferredSelection = null,
    onLog = noop,
  }) {
    return this.withAuthenticatedSession(account, onLog, async ({ page, context }) =>
      this.submitWithAccountInSession({
        page,
        context,
        account,
        filePath,
        originalName,
        title,
        reportOptions,
        jobId,
        reportDir,
        selectionHints,
        preferredSelection,
        onLog,
      })
    );
  }

  async submitWithAccountInSession({
    page,
    context,
    account,
    filePath,
    originalName,
    title,
    reportOptions,
    jobId,
    reportDir,
    selectionHints = null,
    preferredSelection = null,
    onLog = noop,
  }) {
    const selection = await this.findAvailableAssignment(page, onLog, {
      selectionHints,
      preferredSelection,
    });
    if (!selection.target) {
      return {
        status: "no-available-assignment",
        accountEmail: account.email,
        accountSummary: {
          ...selection.summary,
          accountEmail: account.email,
        },
      };
    }

    onLog(`Assignment dipilih: ${selection.target.assignmentName}`);
    try {
      await this.uploadSubmission(page, {
        filePath,
        title,
        onLog,
      });

      const artifacts = await this.captureArtifacts({
        page,
        context,
        reportDir,
        assignmentUrl: selection.target.assignmentUrl,
        originalName,
        reportOptions,
        onLog,
      });

      return {
        status: "submitted",
        jobId,
        finishedAt: new Date().toISOString(),
        accountEmail: account.email,
        className: selection.target.className,
        classUrl: selection.target.classUrl,
        assignmentName: selection.target.assignmentName,
        assignmentKey: selection.target.assignmentKey,
        assignmentUrl: selection.target.assignmentUrl,
        similarity: artifacts.similarity,
        similarityStatus: artifacts.similarityStatus,
        reportUrl: artifacts.reportUrl,
        studioUrl: artifacts.studioUrl,
        artifacts: artifacts.artifacts,
        reportOptions: artifacts.reportOptions,
        accountSummary: {
          ...selection.summary,
          accountEmail: account.email,
        },
      };
    } catch (error) {
      error.assignmentContext = {
        accountEmail: account.email,
        className: selection.target.className,
        classUrl: selection.target.classUrl,
        assignmentName: selection.target.assignmentName,
        assignmentKey: selection.target.assignmentKey,
        assignmentUrl: selection.target.assignmentUrl,
      };
      throw error;
    }
  }

  async resumePendingSubmission({
    account,
    classUrl,
    assignmentUrl,
    className,
    assignmentName,
    originalName,
    reportOptions,
    reportDir,
    knownSimilarity = null,
    knownReportUrl = null,
    existingArtifacts = null,
    waitTimeoutMs = this.config.similarityFollowUpWaitMs,
    onLog = noop,
  }) {
    return this.withAuthenticatedSession(account, onLog, async ({ page, context }) =>
      this.resumePendingSubmissionInSession({
        page,
        context,
        account,
        classUrl,
        assignmentUrl,
        className,
        assignmentName,
        originalName,
        reportOptions,
        reportDir,
        knownSimilarity,
        knownReportUrl,
        existingArtifacts,
        waitTimeoutMs,
        forceLogin: false,
        onLog,
      })
    );
  }

  async resumePendingSubmissionInSession({
    page,
    context,
    account,
    classUrl,
    assignmentUrl,
    className,
    assignmentName,
    originalName,
    reportOptions,
    reportDir,
    knownSimilarity = null,
    knownReportUrl = null,
    existingArtifacts = null,
    waitTimeoutMs = this.config.similarityFollowUpWaitMs,
    forceLogin = false,
    onLog = noop,
  }) {
    let shouldLogin = forceLogin;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (shouldLogin) {
        await this.login(page, account, onLog);
        await this.ensureEnglish(page, onLog);
      }

      try {
        await this.openExistingAssignment(page, {
          classUrl,
          assignmentUrl,
          className,
          assignmentName,
          onLog,
        });
        break;
      } catch (error) {
        const loggedOut = await this.isLoginSurface(page).catch(() => false);
        if (attempt === 0 && !shouldLogin && loggedOut) {
          onLog("Sesi Turnitin habis, login ulang untuk melanjutkan pemantauan.");
          shouldLogin = true;
          continue;
        }
        throw error;
      }
    }

    return this.captureArtifacts({
      page,
      context,
      reportDir,
      assignmentUrl: page.url(),
      originalName,
      reportOptions,
      knownReportUrl,
      existingArtifacts,
      knownSimilarity,
      similarityTimeoutMs: waitTimeoutMs,
      artifactWaitTimeoutMs: waitTimeoutMs,
      onLog,
    });
  }

  async login(page, account, onLog) {
    onLog(`Login ke ${account.email}`);
    await this.openLoginPage(page, onLog);

    await this.dismissCommonBanners(page);
    try {
      await this.fillFirst(page, [
        { kind: "label", target: /email/i, value: account.email },
        { kind: "selector", target: 'input[type="email"]', value: account.email },
        { kind: "selector", target: 'input[name*="email" i]', value: account.email },
        { kind: "selector", target: 'input[id*="email" i]', value: account.email },
        { kind: "selector", target: 'input[name*="username" i]', value: account.email },
      ]);
      await this.fillFirst(page, [
        { kind: "label", target: /password/i, value: account.password },
        { kind: "selector", target: 'input[type="password"]', value: account.password },
        { kind: "selector", target: 'input[name*="pass" i]', value: account.password },
        { kind: "selector", target: 'input[id*="pass" i]', value: account.password },
      ]);

      await this.clickFirst(page, [
        { kind: "role", target: { role: "button", name: /log in|login|sign in/i } },
        { kind: "selector", target: 'input[type="submit"]' },
        { kind: "selector", target: 'button[type="submit"]' },
      ]);
    } catch (error) {
      const debug = await this.captureDebugSnapshot(page, "login");
      const title = await page.title().catch(() => "unknown");
      const bodyText = await this.readBodyText(page);
      throw new Error(
        `${error.message} | title=${title} | url=${page.url()} | body=${bodyText.slice(
          0,
          240
        )} | debugHtml=${debug.htmlPath} | debugShot=${debug.screenshotPath}`
      );
    }

    await page.waitForLoadState("domcontentloaded").catch(() => null);
    await page.waitForTimeout(1500);

    const bodyText = await this.readBodyText(page);
    if (/invalid|incorrect|try again|captcha/i.test(bodyText)) {
      const debug = await this.captureDebugSnapshot(page, "login-invalid");
      throw new Error(
        `Login Turnitin gagal. Cek akun atau ada challenge tambahan. debugHtml=${debug.htmlPath} debugShot=${debug.screenshotPath}`
      );
    }

    const openActions = await this.listActions(page, [/^open$/i]).catch(() => []);
    const classRows = await this.listClassRows(page).catch(() => []);
    if (!openActions.length && !classRows.length && /login_page|signin|login/i.test(page.url())) {
      const debug = await this.captureDebugSnapshot(page, "login-stuck");
      throw new Error(
        `Login tidak berpindah ke dashboard Turnitin. debugHtml=${debug.htmlPath} debugShot=${debug.screenshotPath}`
      );
    }
  }

  async ensureEnglish(page, onLog) {
    const languageButton = page.locator("#lang_submit-button").first();
    if (await languageButton.count()) {
      const currentLabel = normalizeWhitespace(
        await languageButton.innerText().catch(() => "")
      );

      if (!/^english$/i.test(currentLabel)) {
        onLog(
          `Mengganti bahasa dashboard ke English${currentLabel ? ` dari ${currentLabel}` : ""}.`
        );
        await languageButton.click().catch(() => null);
        await page.waitForTimeout(600);

        const englishOption = page
          .locator('a.yuimenuitemlabel, a[role="menuitem"]')
          .filter({ hasText: /^English$/i })
          .first();

        if (await englishOption.count()) {
          await englishOption.click().catch(() => null);
          await page.waitForLoadState("domcontentloaded").catch(() => null);
          await page.waitForTimeout(1200);
          return;
        }
      } else {
        return;
      }
    }

    const currentUrl = page.url();
    if (/lang=en(_us|_int)?/i.test(currentUrl)) {
      return;
    }

    const changedViaSelect = await page
      .locator("select")
      .evaluateAll((elements, label) => {
        for (const element of elements) {
          const options = [...element.options].map((option) => option.textContent || "");
          if (!options.some((option) => option.includes(label))) {
            continue;
          }

          element.value =
            [...element.options].find((option) => option.textContent?.includes(label))
              ?.value || element.value;
          element.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }

        return false;
      }, this.config.uiLanguageLabel)
      .catch(() => false);

    if (changedViaSelect) {
      onLog("Bahasa dashboard diubah ke English lewat dropdown.");
      await page.waitForTimeout(1200);
      return;
    }

    const languageActions = await this.listActions(page, [/English/i]).catch(() => []);
    if (languageActions.length) {
      onLog("Mencoba ganti bahasa ke English.");
      await this.clickAction(page, languageActions[0].actionId);
      await page.waitForTimeout(1200);
    }
  }

  async scanDashboard(page, onLog) {
    const homeUrl = page.url();
    const classes = [];
    const initialClassRows = await this.listClassRows(page);

    for (let index = 0; index < initialClassRows.length; index += 1) {
      await page.goto(homeUrl, { waitUntil: "domcontentloaded" }).catch(() => null);
      await page.waitForTimeout(700);

      const currentClassRows = await this.listClassRows(page);
      const classRow = currentClassRows[index];
      if (!classRow) {
        continue;
      }

      const classInfo = classifyClassAction({
        label: "Open",
        containerText: classRow.rowText || classRow.name,
        containerLines: [classRow.name],
      });
      onLog(`Scan kelas: ${classInfo.name}`);

      await page.goto(classRow.href, { waitUntil: "domcontentloaded" }).catch(() => null);
      await page.waitForTimeout(1200);

      const classUrl = page.url();
      const assignmentActions = await this.listAssignmentActions(page);
      classes.push(this.toClassSummary(classInfo.name, classUrl, assignmentActions));
    }

    return this.buildSummarySnapshot(classes, false);
  }

  async findAvailableAssignment(page, onLog, options = {}) {
    const selectionHints = options.selectionHints || {};
    const preferredSelection = options.preferredSelection || null;
    const homeUrl = page.url();
    const classes = [];
    const initialClassRows = await this.listClassRows(page);

    for (let index = 0; index < initialClassRows.length; index += 1) {
      await page.goto(homeUrl, { waitUntil: "domcontentloaded" }).catch(() => null);
      await page.waitForTimeout(700);

      const currentClassRows = await this.listClassRows(page);
      const classRow = currentClassRows[index];
      if (!classRow) {
        continue;
      }

      const classInfo = classifyClassAction({
        label: "Open",
        containerText: classRow.rowText || classRow.name,
        containerLines: [classRow.name],
      });
      onLog(`Cek kelas ${classInfo.name}`);
      await page.goto(classRow.href, { waitUntil: "domcontentloaded" }).catch(() => null);
      await page.waitForTimeout(1200);

      const classUrl = page.url();
      const classSummary = this.toClassSummary(
        classInfo.name,
        classUrl,
        await this.listAssignmentActions(page)
      );
      classes.push(classSummary);
      const excludedAssignments = classSummary.assignments.filter((assignment) =>
        this.isRepositorySavingAssignment(assignment)
      );
      for (const excludedAssignment of excludedAssignments) {
        onLog(
          `Lewati assignment ${excludedAssignment.name} karena tipe Save to Repository tidak dipakai.`
        );
      }
      const classHint = selectionHints.classes?.[classInfo.name] || null;
      for (const assignment of classSummary.assignments) {
        const history = classHint?.assignments?.[assignment.key] || {};
        if (this.hasReachedAssignmentUsageLimit(history)) {
          onLog(
            `Lewati assignment ${assignment.name} karena sudah dipakai ${Number(
              history.successCount || 0
            )}x dan mencapai batas lokal ${this.config.maxSubmissionsPerAssignment}x.`
          );
        }
      }
      const orderedKeys = this.orderAssignmentsForSelection(
        classSummary.assignments,
        classHint,
        preferredSelection && preferredSelection.className === classInfo.name
          ? preferredSelection
          : null
      );

      for (const orderedAssignment of orderedKeys) {
        const history = classHint?.assignments?.[orderedAssignment.key] || {};
        const attemptCount = Number(history.attemptCount || 0);
        const successCount = Number(history.successCount || 0);
        if (this.hasReachedAssignmentUsageLimit(history)) {
          onLog(
            `Lewati assignment ${orderedAssignment.name} karena sudah dipakai ${successCount}x dan mencapai batas lokal ${this.config.maxSubmissionsPerAssignment}x.`
          );
          continue;
        }

        if (this.hasReachedAssignmentRetryLimit(history)) {
          onLog(
            `Lewati assignment ${orderedAssignment.name} karena batas retry lokal ${this.config.maxAttemptsPerAssignment}x sudah tercapai.`
          );
          continue;
        }

        await page.goto(classUrl, { waitUntil: "domcontentloaded" }).catch(() => null);
        await page.waitForTimeout(1200);

        const currentAssignments = await this.listAssignmentActions(page);
        const nextAssignment = currentAssignments.find(
          (assignment) => assignment.key === orderedAssignment.key
        );
        if (!nextAssignment) {
          continue;
        }

        onLog(`Periksa assignment ${nextAssignment.name}`);
        await this.clickAction(page, nextAssignment.actionId);
        await page.waitForTimeout(1200);

        const opportunity = await this.inspectAssignmentOpportunity(page);
        this.updateClassSummaryAssignment(
          classSummary,
          nextAssignment.key,
          opportunity.dashboardState
        );

        if (opportunity.canSubmit) {
          onLog(
            opportunity.dashboardState.status === "used"
              ? `Assignment ${nextAssignment.name} siap dipakai ulang lewat resubmit.`
              : `Assignment kosong ditemukan di kelas ${classInfo.name}`
          );
          return {
            target: {
              className: classInfo.name,
              classUrl,
              assignmentName: nextAssignment.name,
              assignmentKey: nextAssignment.key,
              assignmentUrl: page.url(),
            },
            summary: this.buildSummarySnapshot(classes, true),
          };
        }

        if (opportunity.dashboardState.status === "used") {
          onLog(`Assignment ${nextAssignment.name} sudah berisi submission, lanjut.`);
          continue;
        }

        onLog(
          `Status assignment ${nextAssignment.name} belum jelas dari dashboard, lanjut ke kandidat berikutnya.`
        );
      }
    }

    return {
      target: null,
      summary: this.buildSummarySnapshot(classes, false),
    };
  }

  async openExistingAssignment(
    page,
    { classUrl, assignmentUrl, className, assignmentName, onLog = noop } = {}
  ) {
    if (assignmentUrl) {
      onLog("Membuka ulang halaman assignment untuk melanjutkan cek similarity.");
      await page.goto(assignmentUrl, { waitUntil: "domcontentloaded" }).catch(() => null);
      await page.waitForTimeout(1200).catch(() => null);

      if (
        await this.waitForAssignmentSurface(page, {
          assignmentUrl,
          timeoutMs: 10 * 1000,
        })
      ) {
        return;
      }
    }

    let resolvedClassUrl = classUrl;
    if (!resolvedClassUrl) {
      const classRows = await this.listClassRows(page);
      const classRow = classRows.find(
        (entry) => normalizeLabel(entry.name) === normalizeLabel(className)
      );
      resolvedClassUrl = classRow?.href || null;
    }

    if (!resolvedClassUrl) {
      throw new Error(`Kelas ${className} tidak ditemukan saat resume submission.`);
    }

    onLog(`Masuk lagi ke kelas ${className} untuk mengecek assignment.`);
    await page.goto(resolvedClassUrl, { waitUntil: "domcontentloaded" }).catch(() => null);
    await page.waitForTimeout(1200).catch(() => null);

    const assignments = await this.listAssignmentActions(page);
    const assignment = assignments.find(
      (entry) => normalizeLabel(entry.name) === normalizeLabel(assignmentName)
    );
    if (!assignment) {
      throw new Error(`Assignment ${assignmentName} tidak ditemukan saat resume submission.`);
    }

    onLog(`Membuka lagi assignment ${assignmentName}.`);
    if (assignment.href) {
      await page.goto(assignment.href, { waitUntil: "domcontentloaded" }).catch(() => null);
    } else {
      await this.clickAction(page, assignment.actionId);
    }
    await page.waitForTimeout(1200).catch(() => null);

    if (
      await this.waitForAssignmentSurface(page, {
        assignmentUrl: assignment.href || assignmentUrl || null,
        timeoutMs: 12 * 1000,
      })
    ) {
      return;
    }

    const debug = await this.captureDebugSnapshot(page, "resume-assignment-open-failed", {
      includeJson: true,
    });
    throw new Error(
      `Halaman assignment tidak berhasil dibuka saat resume submission. debugHtml=${debug.htmlPath} debugShot=${debug.screenshotPath} debugJson=${debug.jsonPath}`
    );
  }

  async waitForAssignmentSurface(
    page,
    { assignmentUrl = null, timeoutMs = 10 * 1000 } = {}
  ) {
    const deadline = Date.now() + timeoutMs;
    let retriedDirectUrl = false;

    while (Date.now() < deadline) {
      if (await this.isAssignmentSurface(page)) {
        return true;
      }

      if (
        assignmentUrl &&
        !retriedDirectUrl &&
        page.url() !== assignmentUrl &&
        Date.now() + 3000 >= deadline
      ) {
        retriedDirectUrl = true;
        await page.goto(assignmentUrl, { waitUntil: "domcontentloaded" }).catch(() => null);
      }

      await page.waitForTimeout(1000).catch(() => null);
    }

    return false;
  }

  async isAssignmentSurface(page) {
    const dashboardState = await this.inspectAssignmentDashboard(page).catch(() => ({
      status: "unknown",
    }));
    if (dashboardState.status !== "unknown") {
      return true;
    }

    const currentUrl = String(page?.url?.() || "");
    const bodyText = await this.readBodyText(page).catch(() => "");
    if (
      /\/assignment\/type\/paper\/dashboard\//i.test(currentUrl) &&
      /assignment dashboard|paper title|uploaded|download digital receipt|similarity/i.test(
        bodyText
      )
    ) {
      return true;
    }

    const assignmentControls = await page
      .locator(
        'button[id^="download-"], button[id^="receipt-"], a.similarity-open, a.default-open, a.grademark-open'
      )
      .count()
      .catch(() => 0);
    return assignmentControls > 0;
  }

  buildSummarySnapshot(classes, partial) {
    return {
      partial,
      scannedAt: new Date().toISOString(),
      totals: {
        classes: classes.length,
        assignments: classes.reduce(
          (count, classItem) => count + classItem.totalAssignments,
          0
        ),
        available: classes.reduce(
          (count, classItem) => count + classItem.availableAssignments,
          0
        ),
        used: classes.reduce((count, classItem) => count + classItem.usedAssignments, 0),
      },
      classes,
    };
  }

  toClassSummary(name, url, assignmentActions) {
    const assignments = assignmentActions.map((assignment) => ({
      name: assignment.name,
      key: assignment.key,
      similarity: assignment.similarity,
      status: assignment.status,
      rawText: assignment.rawText,
    }));

    return {
      name,
      url,
      totalAssignments: assignments.length,
      availableAssignments: assignments.filter(
        (assignment) => assignment.status === "available"
      ).length,
      usedAssignments: assignments.filter((assignment) => assignment.status === "used").length,
      assignments,
    };
  }

  updateClassSummaryAssignment(classSummary, assignmentKey, dashboardState) {
    const assignment = classSummary.assignments.find((entry) => entry.key === assignmentKey);
    if (!assignment) {
      return;
    }

    assignment.status = dashboardState.status || assignment.status;
    assignment.similarity = dashboardState.similarity || assignment.similarity || null;
    classSummary.availableAssignments = classSummary.assignments.filter(
      (entry) => entry.status === "available"
    ).length;
    classSummary.usedAssignments = classSummary.assignments.filter(
      (entry) => entry.status === "used"
    ).length;
  }

  isMatchingAssignmentTarget(
    assignment,
    { assignmentKey = null, assignmentName = null } = {}
  ) {
    if (!assignment) {
      return false;
    }

    if (assignmentKey && assignment.key === assignmentKey) {
      return true;
    }

    if (assignmentName && normalizeLabel(assignment.name) === normalizeLabel(assignmentName)) {
      return true;
    }

    return false;
  }

  async listAssignmentActions(page) {
    return dedupeActions(
      await this.listActions(page, [/^open$/i, /^submit$/i, /^resubmit$/i, /^view$/i])
    ).map((action) => classifyAssignmentAction(action));
  }

  async inspectAssignmentDashboard(page) {
    const title = await page.title().catch(() => "");
    const bodyText = await this.readScopeText(page);
    const actionLabels = await this.listActions(page, [])
      .then((actions) => actions.map((action) => action.label))
      .catch(() => []);
    return classifyAssignmentDashboardState({
      title,
      bodyText,
      actionLabels,
    });
  }

  async inspectAssignmentOpportunity(page) {
    const dashboardState = await this.inspectAssignmentDashboard(page);
    const canSubmitActions = await this.waitForActions(
      page,
      [
        /upload submission/i,
        /submit paper/i,
        /start submission/i,
        /file upload/i,
        /upload a paper/i,
        /resubmit paper/i,
        /^resubmit$/i,
      ],
      { enabledOnly: true, timeoutMs: 1500 }
    ).catch(() => []);

    return {
      dashboardState,
      canSubmit: canSubmitActions.length > 0,
    };
  }

  isRepositorySavingAssignment(assignment = {}) {
    const combined = normalizeLabel([assignment.name, assignment.rawText].join(" "));
    if (!combined) {
      return false;
    }

    if (/no repository|미 저장/i.test(combined)) {
      return false;
    }

    return /save to repository|repository for copyright|db 저장/i.test(combined);
  }

  hasReachedAssignmentRetryLimit(history = {}) {
    return Number(history.attemptCount || 0) >= this.config.maxAttemptsPerAssignment;
  }

  hasReachedAssignmentUsageLimit(history = {}) {
    return Number(history.successCount || 0) >= this.config.maxSubmissionsPerAssignment;
  }

  orderAssignmentsForSelection(assignments, classHint = null, preferredSelection = null) {
    if (!assignments.length) {
      return [];
    }

    const entries = assignments
      .filter((assignment) => !this.isRepositorySavingAssignment(assignment))
      .map((assignment) => ({
        ...assignment,
        attemptCount: Number(classHint?.assignments?.[assignment.key]?.attemptCount || 0),
        successCount: Number(classHint?.assignments?.[assignment.key]?.successCount || 0),
      }));
    const usableEntries = entries.filter(
      (assignment) => !this.hasReachedAssignmentUsageLimit(assignment)
    );
    const preferredIndex = preferredSelection
      ? usableEntries.findIndex(
          (assignment) =>
            assignment.key === preferredSelection.assignmentKey ||
            normalizeLabel(assignment.name) === normalizeLabel(preferredSelection.assignmentName)
        )
      : -1;

    if (
      preferredIndex >= 0 &&
      !this.hasReachedAssignmentRetryLimit(usableEntries[preferredIndex])
    ) {
      const preferred = usableEntries[preferredIndex];
      return [
        preferred,
        ...usableEntries.slice(0, preferredIndex),
        ...usableEntries.slice(preferredIndex + 1),
      ];
    }

    const startIndex = classHint?.nextAssignmentKey
      ? usableEntries.findIndex((assignment) => assignment.key === classHint.nextAssignmentKey)
      : -1;
    const rotated =
      startIndex > 0
        ? [...usableEntries.slice(startIndex), ...usableEntries.slice(0, startIndex)]
        : usableEntries;

    const reusable = rotated.filter(
      (assignment) => !this.hasReachedAssignmentRetryLimit(assignment)
    );
    const exhausted = rotated.filter(
      (assignment) => this.hasReachedAssignmentRetryLimit(assignment)
    );
    return [...reusable, ...exhausted];
  }

  async uploadSubmission(page, { filePath, title, onLog }) {
    onLog("Masuk ke alur upload submission.");

    let uploadScope = (await this.openUploadDialog(page, onLog).catch(() => null)) || page;

    if (!(await this.hasFileInput(uploadScope))) {
      uploadScope =
        (await this.waitForUploadScope(page, onLog, { timeoutMs: 20 * 1000 }).catch(
          () => null
        )) || uploadScope;
    }

    const fileUploadTab = await this.listActions(uploadScope, [/file upload/i]).catch(
      () => []
    );
    if (fileUploadTab.length) {
      await this.clickAction(uploadScope, fileUploadTab[0].actionId).catch(() => null);
      await uploadScope.waitForTimeout(800).catch(() => null);
    }

    await this.fillOptional(uploadScope, [
      { kind: "label", target: /submission title|title/i, value: title },
      { kind: "selector", target: 'input[name*="title" i]', value: title },
      { kind: "selector", target: 'input[id*="title" i]', value: title },
    ]);

    if (!(await this.hasFileInput(uploadScope))) {
      const debug = await this.captureDebugSnapshot(uploadScope, "upload-missing-file-input", {
        includeJson: true,
      });
      throw new Error(
        `Input file Turnitin tidak ditemukan di halaman submission. debugHtml=${debug.htmlPath} debugShot=${debug.screenshotPath} debugJson=${debug.jsonPath}`
      );
    }

    const fileInput = uploadScope.locator('input[type="file"]').first();

    onLog("Memasang file ke form upload Turnitin.");
    await this.withTimeout(
      fileInput.setInputFiles(filePath),
      30 * 1000,
      "setInputFiles timeout pada form upload Turnitin."
    );
    onLog("File sudah terpasang ke form upload.");
    await uploadScope.waitForTimeout(1200).catch(() => null);

    onLog("Menunggu tombol Upload and Review aktif.");
    const reviewActions = await this.waitForActions(
      uploadScope,
      [/upload and review/i, /review/i, /submit to turnitin/i, /^submit$/i],
      { enabledOnly: true, timeoutMs: 15 * 1000 }
    );

    if (!reviewActions.length) {
      const debug = await this.captureDebugSnapshot(uploadScope, "upload-missing-review-button", {
        includeJson: true,
      });
      throw new Error(
        `Tombol review/submission Turnitin tidak ditemukan. debugHtml=${debug.htmlPath} debugShot=${debug.screenshotPath} debugJson=${debug.jsonPath}`
      );
    }

    await this.clickAction(
      uploadScope,
      this.pickAction(reviewActions, [
        /upload and review/i,
        /review/i,
        /submit to turnitin/i,
        /^submit$/i,
      ]).actionId
    );
    onLog("Upload and Review diklik.");
    await uploadScope.waitForTimeout(1500).catch(() => null);

    const reviewState = await this.waitForUploadReviewOrComplete(uploadScope);
    if (reviewState.kind === "submit") {
      onLog("Tombol Submit to Turnitin muncul.");
      await this.clickAction(
        uploadScope,
        this.pickAction(reviewState.actions, [
          /submit to turnitin/i,
          /^submit$/i,
          /confirm/i,
          /yes/i,
        ]).actionId
      );
      onLog("Submit to Turnitin diklik.");
      await uploadScope.waitForTimeout(1500).catch(() => null);
    }

    onLog("Menunggu konfirmasi submission selesai.");
    await this.waitForUploadComplete(uploadScope);
  }

  async captureArtifacts({
    page,
    context,
    reportDir,
    assignmentUrl,
    originalName,
    reportOptions,
    knownReportUrl = null,
    existingArtifacts = null,
    knownSimilarity = null,
    similarityTimeoutMs,
    artifactWaitTimeoutMs = this.config.reportArtifactsWaitMs,
    onLog,
  }) {
    await fs.mkdir(reportDir, { recursive: true });

    const statusScreenshotPath = path.join(reportDir, "submission-status.png");
    await page.screenshot({ path: statusScreenshotPath, fullPage: true }).catch(() => null);

    if (assignmentUrl && page.url() !== assignmentUrl) {
      onLog("Kembali ke assignment untuk cek similarity.");
      await page.goto(assignmentUrl, { waitUntil: "domcontentloaded" }).catch(() => null);
      await page.waitForTimeout(1200);
    }

    let initialSurface = {
      hasDownload: false,
      hasReceipt: false,
      hasViewer: false,
      reportUrl: null,
    };
    let similarity = knownSimilarity || null;
    if (similarity) {
      onLog(
        `Similarity sesi awal tetap dipakai (${similarity}), fokus tunggu Feedback Studio dan receipt.`
      );
    } else {
      const signals = await this.waitForSubmissionSignals(page, {
        assignmentUrl,
        onLog,
        timeoutMs: similarityTimeoutMs,
      });
      similarity = signals.similarity || null;
      initialSurface = signals.surface || initialSurface;
    }
    const dashboardSimilarity = similarity || null;
    let currentViewSimilarity = null;
    const artifacts = {
      ...(existingArtifacts || {}),
      submissionStatusImage: reportArtifactUrl(reportDir, "submission-status.png"),
    };
    let reportUrl = knownReportUrl || null;
    const shouldWaitForArtifactSurface =
      !reportUrl &&
      !artifacts.originalFile &&
      !artifacts.digitalReceipt &&
      !initialSurface.hasViewer &&
      !initialSurface.hasReceipt &&
      !initialSurface.reportUrl;
    const artifactSurface = shouldWaitForArtifactSurface
      ? await this.waitForAssignmentArtifactsReady(page, {
          assignmentUrl,
          timeoutMs: artifactWaitTimeoutMs,
          onLog,
        })
      : initialSurface;

    if (!artifacts.originalFile || !artifacts.digitalReceipt) {
      Object.assign(
        artifacts,
        await this.downloadAssignmentArtifacts(page, reportDir, {
          originalName,
          onLog,
        })
      );
    }

    const normalizedReportOptions = this.normalizeReportOptions(reportOptions);
    const requiresViewerFilterAwareDownload = this.hasEnabledViewerFilters(
      normalizedReportOptions
    );
    let appliedReportOptions = normalizedReportOptions;
    const originalFilePath = artifacts.originalFile
      ? path.join(reportDir, path.basename(artifacts.originalFile))
      : null;

    reportUrl = reportUrl || artifactSurface.reportUrl || null;

    if (artifacts.viewerPdf) {
      const existingViewerPdfPath = path.join(
        reportDir,
        path.basename(String(artifacts.viewerPdf || ""))
      );
      const existingViewerPdfMetadata = await this.readTurnitinReportPdfMetadata(
        existingViewerPdfPath
      ).catch(() => null);
      const existingViewerPdfMatchesOriginal =
        originalFilePath &&
        (await areFilesByteIdentical(existingViewerPdfPath, originalFilePath).catch(() => false));
      if (
        existingViewerPdfMatchesOriginal ||
        !existingViewerPdfMetadata?.valid ||
        !this.doesPdfMatchRequestedReportOptions(
          existingViewerPdfMetadata,
          normalizedReportOptions
        )
      ) {
        onLog("Current View PDF lama tidak cocok dengan filter yang diminta, unduh ulang.");
        delete artifacts.viewerPdf;
      }
    }

    const hasViewerSession = await this.hasViewerSessionCookie(context);

    if (
      !requiresViewerFilterAwareDownload &&
      similarity &&
      reportUrl &&
      hasViewerSession
    ) {
      appliedReportOptions = await this.applyViewerReportOptions({
        context,
        reportOptions: normalizedReportOptions,
        reportUrl,
        onLog,
      });
      if (appliedReportOptions?.viewerSimilarity) {
        currentViewSimilarity = appliedReportOptions.viewerSimilarity;
      }
    }

    if (
      !requiresViewerFilterAwareDownload &&
      similarity &&
      reportUrl &&
      hasViewerSession &&
      !artifacts.viewerPdf
    ) {
      artifacts.viewerPdf = await this.downloadViewerPdfFromReportUrl({
        context,
        reportDir,
        originalName,
        originalFilePath,
        expectedReportOptions: appliedReportOptions,
        similarity: currentViewSimilarity || similarity,
        reportUrl,
        onLog,
        sourceLabel: knownSimilarity ? "endpoint follow-up" : "endpoint dashboard",
        successLog: knownSimilarity
          ? "Current View PDF berhasil diunduh langsung dari endpoint viewer."
          : "Current View PDF berhasil diunduh langsung setelah similarity muncul di dashboard.",
      });
    }

    if (!artifacts.viewerPdf) {
      try {
        const viewer = await this.openReportViewer(page, context, onLog);
        reportUrl = viewer.reportUrl || reportUrl || artifactSurface.reportUrl || null;
        const viewerPage = viewer.viewerPage;

        if (viewerPage) {
          try {
            const resolvedReportUrl =
              this.resolveViewerReferenceUrl({ viewerPage, reportUrl }) || reportUrl;
            reportUrl = resolvedReportUrl || reportUrl;

            const viewerBootstrapReady = await this.waitForViewerBootstrap({
              viewerPage,
              context,
              reportUrl,
            });

            if (viewerBootstrapReady) {
              if (requiresViewerFilterAwareDownload) {
                await this.waitForViewerReady(viewerPage, onLog);
              }
              appliedReportOptions = await this.applyViewerReportOptions({
                viewerPage,
                context,
                reportOptions: normalizedReportOptions,
                reportUrl,
                onLog,
              });
              if (appliedReportOptions?.viewerSimilarity) {
                currentViewSimilarity = appliedReportOptions.viewerSimilarity;
              }

              if (
                requiresViewerFilterAwareDownload &&
                !this.areViewerFiltersConfirmed(appliedReportOptions)
              ) {
                onLog("Filter viewer belum terkonfirmasi, coba sinkron ulang setelah viewer siap.");
                appliedReportOptions = await this.applyViewerReportOptions({
                  viewerPage,
                  context,
                  reportOptions: normalizedReportOptions,
                  reportUrl,
                  onLog,
                });
                if (appliedReportOptions?.viewerSimilarity) {
                  currentViewSimilarity = appliedReportOptions.viewerSimilarity;
                }
              }
            }

            if (
              !requiresViewerFilterAwareDownload &&
              !artifacts.viewerPdf &&
              similarity &&
              resolvedReportUrl &&
              viewerBootstrapReady
            ) {
              artifacts.viewerPdf = await this.downloadQueuedViewerPdfFromReportUrl({
                context,
                reportDir,
                originalName,
                originalFilePath,
                expectedReportOptions: appliedReportOptions,
                similarity: currentViewSimilarity || similarity,
                reportUrl: resolvedReportUrl,
                onLog,
                failureLog: null,
                successLog: "Current View PDF berhasil diunduh dari queue Feedback Studio.",
              });
            }

            if (
              !requiresViewerFilterAwareDownload &&
              !artifacts.viewerPdf &&
              similarity &&
              resolvedReportUrl &&
              viewerBootstrapReady
            ) {
              artifacts.viewerPdf = await this.downloadViewerPdfFromReportUrl({
                context,
                reportDir,
                originalName,
                originalFilePath,
                expectedReportOptions: appliedReportOptions,
                similarity: currentViewSimilarity || similarity,
                reportUrl: resolvedReportUrl,
                onLog,
                sourceLabel: "endpoint viewer",
                successLog:
                  "Current View PDF berhasil diunduh langsung setelah Feedback Studio terbuka.",
              });
            }

            if (!artifacts.viewerPdf) {
              await this.waitForViewerReady(viewerPage, onLog);

              const viewerScreenshotPath = path.join(reportDir, "similarity-report.png");
              await viewerPage
                .screenshot({ path: viewerScreenshotPath, fullPage: true })
                .catch(() => null);
              artifacts.viewerScreenshot = reportArtifactUrl(reportDir, "similarity-report.png");
              artifacts.viewerPdf = await this.downloadViewerPdf({
                viewerPage,
                context,
                reportDir,
                originalName,
                originalFilePath,
                expectedReportOptions: appliedReportOptions,
                similarity: currentViewSimilarity || similarity,
                reportUrl,
                onLog,
              });
            }
          } finally {
            if (viewer.closeViewerPage) {
              await viewerPage.close().catch(() => null);
            }
          }
        }
      } catch (error) {
        onLog(
          `Feedback Studio gagal diproses penuh, submission tetap disimpan. Detail: ${error.message}`
        );
      }
    }

    if (!reportUrl) {
      reportUrl = artifactSurface.reportUrl || null;
    }

    const finalSimilarity = await this.resolveFinalSimilarity({
      reportDir,
      similarity: currentViewSimilarity || similarity,
    });

    return {
      dashboardSimilarity,
      currentViewSimilarity: currentViewSimilarity || null,
      similarity: finalSimilarity,
      similarityStatus: finalSimilarity ? "ready" : "pending",
      reportUrl,
      studioUrl: pickStudioUrl({ reportUrl, artifacts }),
      artifacts,
      reportOptions: appliedReportOptions,
    };
  }

  normalizeReportOptions(reportOptions = {}) {
    const safeReportOptions =
      reportOptions && typeof reportOptions === "object" ? reportOptions : {};
    const excludeMatchesWordCount = Number(safeReportOptions.excludeMatchesWordCount);
    return {
      excludeQuotes: Boolean(safeReportOptions.excludeQuotes),
      excludeBibliography: Boolean(safeReportOptions.excludeBibliography),
      excludeMatches: Boolean(safeReportOptions.excludeMatches),
      excludeMatchesWordCount:
        Number.isInteger(excludeMatchesWordCount) && excludeMatchesWordCount > 0
          ? excludeMatchesWordCount
          : this.config.defaultExcludeMatchesWordCount,
    };
  }

  hasEnabledViewerFilters(reportOptions = {}) {
    const normalized = this.normalizeReportOptions(reportOptions);
    return (
      normalized.excludeQuotes ||
      normalized.excludeBibliography ||
      normalized.excludeMatches
    );
  }

  listEnabledViewerFilters(reportOptions = {}) {
    const normalized = this.normalizeReportOptions(reportOptions);
    const enabledFilters = [];
    if (normalized.excludeQuotes) {
      enabledFilters.push("exclude quotes");
    }
    if (normalized.excludeBibliography) {
      enabledFilters.push("exclude bibliography");
    }
    if (normalized.excludeMatches) {
      enabledFilters.push(`exclude matches < ${normalized.excludeMatchesWordCount} words`);
    }
    return enabledFilters;
  }

  doesPdfMatchRequestedReportOptions(pdfMetadata = {}, reportOptions = {}) {
    return doesPdfMatchRequestedReportOptions(pdfMetadata, reportOptions, {
      defaultExcludeMatchesWordCount: this.config.defaultExcludeMatchesWordCount,
    });
  }

  async downloadAssignmentArtifacts(page, reportDir, { originalName, onLog = noop } = {}) {
    const artifacts = {};

    const originalFilePath = await this.downloadPageArtifact(
      page,
      'button[id^="download-"]',
      path.join(
        reportDir,
        sanitizeFilename(originalName || "submitted-file", "submitted-file")
      ),
      { onLog, label: "file asli submission", reuseExisting: true }
    );
    if (originalFilePath) {
      artifacts.originalFile = reportArtifactUrl(reportDir, path.basename(originalFilePath));
    }

    const receiptPath = await this.downloadPageArtifact(
      page,
      'button[id^="receipt-"]',
      path.join(reportDir, "digital-receipt.pdf"),
      { onLog, label: "digital receipt", reuseExisting: true }
    );
    if (receiptPath) {
      artifacts.digitalReceipt = reportArtifactUrl(reportDir, path.basename(receiptPath));
    }

    return artifacts;
  }

  async downloadPageArtifact(
    page,
    selector,
    targetPath,
    { onLog = noop, label, reuseExisting = false } = {}
  ) {
    if (reuseExisting) {
      const existing = await fs
        .stat(targetPath)
        .then((stats) => (stats.isFile() ? targetPath : null))
        .catch(() => null);
      if (existing) {
        return existing;
      }
    }

    const button = page.locator(selector).first();
    if (!(await button.count().catch(() => 0))) {
      return null;
    }

    const downloadPromise = page.waitForEvent("download", { timeout: 15 * 1000 }).catch(
      () => null
    );
    await button.click().catch(() => null);
    const download = await downloadPromise;
    if (!download) {
      onLog(`Unduhan ${label} tidak muncul dari dashboard assignment.`);
      return null;
    }

    const finalPath = await this.resolveDownloadPath(targetPath, download.suggestedFilename());
    await download.saveAs(finalPath);
    onLog(`Artefak ${label} berhasil diunduh.`);
    return finalPath;
  }

  async resolveDownloadPath(targetPath, suggestedFilename) {
    const currentExt = path.extname(targetPath);
    const suggestedExt = path.extname(suggestedFilename || "");
    if (currentExt) {
      return targetPath;
    }

    return `${targetPath}${suggestedExt || ""}`;
  }

  async waitForViewerReady(viewerPage, onLog = noop) {
    await this.waitForViewerLanding(viewerPage).catch(() => null);
    const deadline = Date.now() + 20 * 1000;

    while (Date.now() < deadline) {
      const readyText = await this.readScopeText(viewerPage).catch(() => "");
      const hasToolbar =
        /filters and settings|submission information|text-only report|high resolution/i.test(
          readyText
        );
      const hasPageImage = await viewerPage
        .locator("img.page-image, canvas.pdf-canvas")
        .first()
        .isVisible()
        .catch(() => false);
      if (hasToolbar && hasPageImage) {
        return;
      }

      await viewerPage.waitForTimeout(1000).catch(() => null);
    }

    onLog("Viewer Feedback Studio tidak siap penuh, lanjut dengan state terbaik yang tersedia.");
  }

  async waitForViewerLanding(viewerPage, timeoutMs = 20 * 1000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (this.extractViewerPaperId(viewerPage.url())) {
        return true;
      }

      if (await this.looksLikeViewerPage(viewerPage)) {
        return true;
      }

      await viewerPage.waitForLoadState("domcontentloaded").catch(() => null);
      await viewerPage.waitForTimeout(1000).catch(() => null);
    }

    return false;
  }

  extractViewerPaperId(viewerUrl) {
    try {
      return new URL(viewerUrl).searchParams.get("o");
    } catch (error) {
      void error;
      return null;
    }
  }

  async inspectAssignmentArtifactSurface(page) {
    const counts = await Promise.all([
      page
        .locator('button[id^="download-"]')
        .count()
        .catch(() => 0),
      page
        .locator('button[id^="receipt-"]')
        .count()
        .catch(() => 0),
      page
        .locator(
          [
            'a.similarity-open',
            'a.default-open',
            'a.grademark-open',
            'a[title*="Feedback Studio" i]',
            'a[title*="Similarity matches" i]',
            'a[title*="View Instructor Feedback" i]',
          ].join(", ")
        )
        .count()
        .catch(() => 0),
    ]);
    const reportUrl = await this.extractReportUrl(page).catch(() => null);
    return {
      hasDownload: counts[0] > 0,
      hasReceipt: counts[1] > 0,
      hasViewer: counts[2] > 0 || isLikelyViewerUrl(reportUrl),
      reportUrl,
    };
  }

  async waitForAssignmentArtifactsReady(
    page,
    { assignmentUrl = null, onLog = noop, timeoutMs = this.config.reportArtifactsWaitMs } = {}
  ) {
    const deadline = Date.now() + timeoutMs;
    let waitLogged = false;
    const refreshMs = Math.max(1000, Number(this.config.reportArtifactsRefreshMs) || 5000);
    let nextRefreshAt = Date.now() + refreshMs;
    let lastSurface = {
      hasDownload: false,
      hasReceipt: false,
      hasViewer: false,
      reportUrl: null,
    };

    while (Date.now() < deadline) {
      lastSurface = await this.inspectAssignmentArtifactSurface(page);
      if (lastSurface.hasViewer || lastSurface.hasReceipt || lastSurface.reportUrl) {
        return lastSurface;
      }

      if (!waitLogged) {
        onLog("Menunggu tombol Feedback Studio dan digital receipt muncul.");
        waitLogged = true;
      }

      await page.waitForTimeout(1000).catch(() => null);

      if (assignmentUrl && Date.now() >= nextRefreshAt && Date.now() < deadline) {
        onLog("Tombol report belum muncul, refresh halaman assignment.");
        await page.goto(assignmentUrl, { waitUntil: "domcontentloaded" }).catch(() => null);
        await page.waitForTimeout(1200).catch(() => null);
        nextRefreshAt = Date.now() + refreshMs;
      }
    }

    return lastSurface;
  }

  async waitForSubmissionSignals(
    page,
    {
      assignmentUrl = null,
      onLog = noop,
      timeoutMs = this.config.similarityWaitMs,
      preferDashboardSimilarity = true,
    } = {}
  ) {
    const deadline = Date.now() + timeoutMs;
    const refreshMs = Math.max(1000, Number(this.config.similarityPollIntervalMs) || 5000);
    const logIntervalMs = Math.max(15000, refreshMs * 6);
    let nextLogAt = Date.now();
    let reportSurfaceLogged = false;
    let lastSurface = {
      hasDownload: false,
      hasReceipt: false,
      hasViewer: false,
      reportUrl: null,
    };

    while (Date.now() < deadline) {
      const [similarity, surface] = await Promise.all([
        this.extractSimilarity(page).catch(() => null),
        this.inspectAssignmentArtifactSurface(page).catch(() => lastSurface),
      ]);
      lastSurface = surface || lastSurface;

      if (similarity) {
        onLog(`Similarity terdeteksi: ${similarity}`);
        return {
          similarity,
          surface: lastSurface,
        };
      }

      if (lastSurface.hasViewer || lastSurface.hasReceipt || lastSurface.reportUrl) {
        if (!preferDashboardSimilarity) {
          onLog("Permukaan report sudah muncul, lanjut ambil artefak tanpa menunggu similarity.");
          return {
            similarity: null,
            surface: lastSurface,
          };
        }

        if (!reportSurfaceLogged) {
          onLog("Permukaan report sudah muncul, tetap tunggu angka similarity di dashboard.");
          reportSurfaceLogged = true;
        }
      }

      if (Date.now() >= nextLogAt) {
        onLog(
          `Similarity dan Current View belum muncul, cek lagi ${Math.round(
            refreshMs / 1000
          )} detik.`
        );
        nextLogAt = Date.now() + logIntervalMs;
      }

      await page.waitForTimeout(refreshMs).catch(() => null);
      if (assignmentUrl) {
        if (page.url() === assignmentUrl) {
          await page.reload({ waitUntil: "domcontentloaded" }).catch(() => null);
        } else {
          await page.goto(assignmentUrl, { waitUntil: "domcontentloaded" }).catch(() => null);
        }
      } else {
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => null);
      }
      await page.waitForTimeout(1200).catch(() => null);
    }

    return {
      similarity: null,
      surface: lastSurface,
    };
  }

  async applyViewerReportOptions({
    viewerPage = null,
    context,
    reportOptions,
    reportUrl = null,
    onLog = noop,
  }) {
    const normalized = this.normalizeReportOptions(reportOptions);
    if (
      !normalized.excludeQuotes &&
      !normalized.excludeBibliography &&
      !normalized.excludeMatches
    ) {
      return normalized;
    }

    const similarityEndpoint = this.buildViewerSimilarityOptionsUrl({ viewerPage, reportUrl });
    if (!similarityEndpoint) {
      onLog("URL viewer final tidak ditemukan, filter viewer dilewati.");
      return normalized;
    }

    const { optionsUrl } = similarityEndpoint;
    const requestHeaders = this.buildViewerQueueHeaders({
      referer: similarityEndpoint.viewerReferenceUrl,
    });
    const response = await this.waitForViewerSimilarityOptionsResponse({
      context,
      optionsUrl,
      headers: requestHeaders,
      viewerPage,
    });
    if (!response?.ok()) {
      if (!viewerPage) {
        onLog("Gagal membaca opsi similarity viewer, filter viewer dilewati.");
        return this.attachViewerProcessingMetadata(normalized, {
          viewerFiltersConfirmed: false,
        });
      }
      const appliedViaUi = await this.applyViewerReportOptionsInViewer({
        viewerPage,
        reportOptions: normalized,
        onLog,
      });
      if (!appliedViaUi) {
        onLog("Gagal membaca opsi similarity viewer, filter viewer dilewati.");
      }
      const synced = await this.waitForViewerReportOptionsSync({
        context,
        viewerPage,
        reportUrl,
        reportOptions: normalized,
      });
      return this.attachViewerProcessingMetadata(normalized, {
        viewerSimilarity: synced?.viewerSimilarity || null,
        viewerFiltersConfirmed: Boolean(synced),
      });
    }

    const data = await response.json().catch(() => ({}));
    const { currentOptions } = this.extractViewerSimilarityOptionsState(data);
    if (!currentOptions) {
      if (!viewerPage) {
        onLog("Payload opsi similarity viewer tidak tersedia, filter viewer dilewati.");
        return this.attachViewerProcessingMetadata(normalized, {
          viewerFiltersConfirmed: false,
        });
      }
      const appliedViaUi = await this.applyViewerReportOptionsInViewer({
        viewerPage,
        reportOptions: normalized,
        onLog,
      });
      if (!appliedViaUi) {
        onLog("Payload opsi similarity viewer tidak tersedia, filter viewer dilewati.");
      }
      const synced = await this.waitForViewerReportOptionsSync({
        context,
        viewerPage,
        reportUrl,
        reportOptions: normalized,
      });
      return this.attachViewerProcessingMetadata(normalized, {
        viewerSimilarity: synced?.viewerSimilarity || null,
        viewerFiltersConfirmed: Boolean(synced),
      });
    }

    const nextOptions = {
      ...currentOptions,
      exclude_quotes: normalized.excludeQuotes ? 1 : 0,
      exclude_biblio: normalized.excludeBibliography ? 1 : 0,
      exclude_small_matches: normalized.excludeMatches
        ? normalized.excludeMatchesWordCount
        : 0,
    };

    const changed =
      Number(currentOptions.exclude_quotes || 0) !== nextOptions.exclude_quotes ||
      Number(currentOptions.exclude_biblio || 0) !== nextOptions.exclude_biblio ||
      Number(currentOptions.exclude_small_matches || 0) !==
        nextOptions.exclude_small_matches;
    if (!changed) {
      return this.attachViewerProcessingMetadata(normalized, {
        viewerSimilarity: this.extractViewerSimilarityOptionsState(data).viewerSimilarity,
        viewerFiltersConfirmed: true,
      });
    }

    const enabledFilters = this.listEnabledViewerFilters(normalized);

    onLog(
      `Menerapkan filter viewer ${enabledFilters.join(", ")}.`
    );
    const updateResponse = await context.request.put(optionsUrl, {
      data: nextOptions,
      headers: {
        ...requestHeaders,
        "content-type": "application/json",
      },
    }).catch(() => null);
    if (!updateResponse?.ok()) {
      if (!viewerPage) {
        onLog("Update filter viewer gagal, melanjutkan tanpa perubahan filter.");
        return this.attachViewerProcessingMetadata(normalized, {
          viewerFiltersConfirmed: false,
        });
      }
      const appliedViaUi = await this.applyViewerReportOptionsInViewer({
        viewerPage,
        reportOptions: normalized,
        onLog,
      });
      if (!appliedViaUi) {
        onLog("Update filter viewer gagal, melanjutkan tanpa perubahan filter.");
      }
      const synced = await this.waitForViewerReportOptionsSync({
        context,
        viewerPage,
        reportUrl,
        reportOptions: normalized,
      });
      return this.attachViewerProcessingMetadata(normalized, {
        viewerSimilarity: synced?.viewerSimilarity || null,
        viewerFiltersConfirmed: Boolean(synced),
      });
    }

    const updatePayload = await updateResponse.json().catch(() => ({}));
    let viewerSimilarity = this.extractViewerSimilarityOptionsState(updatePayload).viewerSimilarity;
    const synced = await this.waitForViewerReportOptionsSync({
      context,
      viewerPage,
      reportUrl,
      reportOptions: normalized,
      onLog,
    });
    if (synced?.viewerSimilarity) {
      viewerSimilarity = synced.viewerSimilarity;
    }

    if (viewerPage) {
      await viewerPage.waitForTimeout(1200).catch(() => null);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    return this.attachViewerProcessingMetadata(normalized, {
      viewerSimilarity,
      viewerFiltersConfirmed: true,
    });
  }

  buildViewerSimilarityOptionsUrl({ viewerPage = null, reportUrl = null } = {}) {
    const viewerReferenceUrl = this.resolveViewerReferenceUrl({ viewerPage, reportUrl });
    if (!viewerReferenceUrl) {
      return null;
    }

    const viewerUrl = new URL(viewerReferenceUrl);
    const paperId = this.extractViewerPaperId(viewerReferenceUrl);
    const language = viewerUrl.searchParams.get("lang") || "en_us";
    if (!paperId) {
      return null;
    }

    return {
      viewerReferenceUrl,
      optionsUrl: `${viewerUrl.origin}/student/paper/${paperId}/similarity/options?lang=${language}&cv=1&output=json&tl=0`,
    };
  }

  extractViewerSimilarityOptionsState(data = {}) {
    const currentOptions =
      data?.OriginalityOptions?.[0] ||
      data?.originalityOptions?.[0] ||
      null;
    const overlap = Number(data?.report?.overlap);
    return {
      currentOptions,
      viewerSimilarity: Number.isFinite(overlap) ? `${overlap}%` : null,
    };
  }

  viewerSimilarityOptionsMatch(currentOptions, reportOptions = {}) {
    if (!currentOptions) {
      return false;
    }

    const normalized = this.normalizeReportOptions(reportOptions);
    return (
      Number(currentOptions.exclude_quotes || 0) === (normalized.excludeQuotes ? 1 : 0) &&
      Number(currentOptions.exclude_biblio || 0) === (normalized.excludeBibliography ? 1 : 0) &&
      Number(currentOptions.exclude_small_matches || 0) ===
        (normalized.excludeMatches ? normalized.excludeMatchesWordCount : 0)
    );
  }

  attachViewerSimilarityMetadata(reportOptions, viewerSimilarity = null) {
    if (!reportOptions || !viewerSimilarity) {
      return reportOptions;
    }

    Object.defineProperty(reportOptions, "viewerSimilarity", {
      value: viewerSimilarity,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    return reportOptions;
  }

  attachViewerFilterConfirmationMetadata(reportOptions, viewerFiltersConfirmed = null) {
    if (!reportOptions || viewerFiltersConfirmed === null || viewerFiltersConfirmed === undefined) {
      return reportOptions;
    }

    Object.defineProperty(reportOptions, "viewerFiltersConfirmed", {
      value: Boolean(viewerFiltersConfirmed),
      enumerable: false,
      configurable: true,
      writable: true,
    });
    return reportOptions;
  }

  attachViewerProcessingMetadata(
    reportOptions,
    { viewerSimilarity = null, viewerFiltersConfirmed = null } = {}
  ) {
    this.attachViewerSimilarityMetadata(reportOptions, viewerSimilarity);
    this.attachViewerFilterConfirmationMetadata(reportOptions, viewerFiltersConfirmed);
    return reportOptions;
  }

  areViewerFiltersConfirmed(reportOptions = null) {
    return reportOptions?.viewerFiltersConfirmed !== false;
  }

  pdfHasExplicitFilterStates(pdfMetadata = {}) {
    const filterStates = pdfMetadata?.filterStates || {};
    return ["excludeQuotes", "excludeBibliography", "excludeMatches"].some(
      (key) => filterStates[key] !== null && filterStates[key] !== undefined
    );
  }

  shouldEnforceViewerFilterValidation(expectedReportOptions = null, pdfMetadata = {}) {
    if (!expectedReportOptions) {
      return false;
    }

    if (!this.hasEnabledViewerFilters(expectedReportOptions)) {
      return true;
    }

    if (this.areViewerFiltersConfirmed(expectedReportOptions)) {
      return true;
    }

    return this.pdfHasExplicitFilterStates(pdfMetadata);
  }

  async waitForViewerSimilarityOptionsResponse({
    context,
    optionsUrl,
    headers,
    viewerPage = null,
    timeoutMs = 8000,
  } = {}) {
    if (!context?.request || !optionsUrl) {
      return null;
    }

    const deadline = Date.now() + Math.max(2000, Number(timeoutMs) || 8000);
    while (Date.now() < deadline) {
      const response = await context.request
        .get(optionsUrl, {
          headers,
        })
        .catch(() => null);
      if (response?.ok()) {
        return response;
      }

      if (viewerPage && typeof viewerPage.waitForTimeout === "function") {
        await viewerPage.waitForTimeout(800).catch(() => null);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }

    return null;
  }

  async waitForViewerReportOptionsSync({
    context,
    viewerPage = null,
    reportUrl = null,
    reportOptions = {},
    timeoutMs = 6000,
    onLog = noop,
  } = {}) {
    const similarityEndpoint = this.buildViewerSimilarityOptionsUrl({ viewerPage, reportUrl });
    if (!similarityEndpoint || !context?.request) {
      return null;
    }

    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 6000);
    while (Date.now() < deadline) {
    const response = await this.waitForViewerSimilarityOptionsResponse({
      context,
      optionsUrl: similarityEndpoint.optionsUrl,
      headers: this.buildViewerQueueHeaders({
        referer: similarityEndpoint.viewerReferenceUrl,
      }),
      viewerPage,
      timeoutMs,
    });
      if (response?.ok()) {
        const data = await response.json().catch(() => ({}));
        const parsed = this.extractViewerSimilarityOptionsState(data);
        if (this.viewerSimilarityOptionsMatch(parsed.currentOptions, reportOptions)) {
          return parsed;
        }
      }

      if (viewerPage && typeof viewerPage.waitForTimeout === "function") {
        await viewerPage.waitForTimeout(800).catch(() => null);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }

    onLog("Filter viewer backend belum sinkron penuh; export Current View bisa masih memakai state lama.");
    return null;
  }

  async applyViewerReportOptionsInViewer({
    viewerPage,
    reportOptions,
    onLog = noop,
  }) {
    if (!viewerPage) {
      return false;
    }

    const normalized = this.normalizeReportOptions(reportOptions);
    const enabledFilters = this.listEnabledViewerFilters(normalized);
    if (!enabledFilters.length) {
      return true;
    }

    let filterButton = viewerPage.locator('[title="Filters and Settings"]').first();
    if (!(await filterButton.count().catch(() => 0))) {
      filterButton = viewerPage.getByText(/^Filters and Settings$/i).first();
    }
    if ((await filterButton.count().catch(() => 0)) > 0) {
      await filterButton.click().catch(() => null);
      await viewerPage.waitForTimeout(600).catch(() => null);
    }

    const requestedBinaryFilters = [
      {
        key: "excludeQuotes",
        desired: normalized.excludeQuotes,
      },
      {
        key: "excludeBibliography",
        desired: normalized.excludeBibliography,
      },
    ];

    let hasChanges = false;
    let supportedFilterFound = false;
    for (const filter of requestedBinaryFilters) {
      const beforeStates = await this.readViewerFilterStates(viewerPage);
      if (beforeStates[filter.key] === null) {
        continue;
      }

      supportedFilterFound = true;
      if (beforeStates[filter.key] === filter.desired) {
        continue;
      }

      const toggled = await this.toggleViewerBinaryFilter(viewerPage, filter);
      if (!toggled) {
        continue;
      }

      const afterStates = await this.readViewerFilterStates(viewerPage);
      if (afterStates[filter.key] === filter.desired) {
        hasChanges = true;
      }
    }

    const excludeMatchesConfigured = await this.configureViewerExcludeMatches(viewerPage, {
      enabled: normalized.excludeMatches,
      wordCount: normalized.excludeMatchesWordCount,
    });
    if (excludeMatchesConfigured !== null) {
      supportedFilterFound = true;
      if (excludeMatchesConfigured) {
        hasChanges = true;
      }
    }

    if (hasChanges) {
      onLog(`Menerapkan filter viewer ${enabledFilters.join(", ")}.`);
      let applyButton = viewerPage.getByText(/^Apply Changes$/i).first();
      if (!(await applyButton.count().catch(() => 0))) {
        applyButton = viewerPage.locator("button").filter({ hasText: /^Apply Changes$/i }).first();
      }
      if ((await applyButton.count().catch(() => 0)) > 0) {
        await applyButton.click().catch(() => null);
      }
      await viewerPage.waitForTimeout(1200).catch(() => null);
    }

    if (!supportedFilterFound) {
      onLog("Kontrol filter viewer tidak ditemukan di UI, filter viewer dilewati.");
      return false;
    }

    const finalStates = await this.readViewerFilterStates(viewerPage);
    return (
      requestedBinaryFilters.every(
        (filter) => finalStates[filter.key] === null || finalStates[filter.key] === filter.desired
      ) &&
      (finalStates.excludeMatches === null ||
        finalStates.excludeMatches === normalized.excludeMatches) &&
      (!normalized.excludeMatches ||
        finalStates.excludeMatchesWordCount === null ||
        finalStates.excludeMatchesWordCount === normalized.excludeMatchesWordCount)
    );
  }

  async readViewerToggleState(locator) {
    const ariaChecked = String((await locator.getAttribute("aria-checked").catch(() => "")) || "");
    if (ariaChecked === "true") {
      return true;
    }
    if (ariaChecked === "false") {
      return false;
    }

    const className = String((await locator.getAttribute("class").catch(() => "")) || "");
    return /\bsel\b|\btoggled-on\b|\bchecked\b/i.test(className);
  }

  async readViewerFilterStates(viewerPage) {
    const quoteCheckbox = viewerPage.locator(".exclude-quotes-checkbox").first();
    const bibliographyCheckbox = viewerPage.locator(".exclude-biblio-checkbox").first();
    const wordsRadio = viewerPage
      .locator('.small-matches-radio-group [role="radio"]')
      .filter({ hasText: /^words$/i })
      .first();
    const noSizeRadio = viewerPage
      .locator('.small-matches-radio-group [role="radio"]')
      .filter({ hasText: /^Don't exclude by size$/i })
      .first();
    const wordCountInput = viewerPage.locator(".filter-inputs input").first();

    const excludeQuotes =
      (await quoteCheckbox.count().catch(() => 0)) > 0
        ? await this.readViewerToggleState(quoteCheckbox)
        : null;
    const excludeBibliography =
      (await bibliographyCheckbox.count().catch(() => 0)) > 0
        ? await this.readViewerToggleState(bibliographyCheckbox)
        : null;

    let excludeMatches = null;
    if ((await wordsRadio.count().catch(() => 0)) > 0) {
      excludeMatches = await this.readViewerToggleState(wordsRadio);
    } else if ((await noSizeRadio.count().catch(() => 0)) > 0) {
      excludeMatches = !(await this.readViewerToggleState(noSizeRadio));
    }

    const rawWordCount =
      (await wordCountInput.count().catch(() => 0)) > 0
        ? await wordCountInput.inputValue().catch(() => "")
        : "";
    const numericWordCount = Number.parseInt(String(rawWordCount || "").trim(), 10);

    return {
      excludeQuotes,
      excludeBibliography,
      excludeMatches,
      excludeMatchesWordCount: Number.isFinite(numericWordCount) ? numericWordCount : null,
    };
  }

  async toggleViewerBinaryFilter(viewerPage, { key, desired }) {
    const selectorByKey = {
      excludeQuotes: ".exclude-quotes-checkbox",
      excludeBibliography: ".exclude-biblio-checkbox",
    };
    const selector = selectorByKey[key];
    if (!selector) {
      return false;
    }

    const checkbox = viewerPage.locator(selector).first();
    if (!(await checkbox.count().catch(() => 0))) {
      return false;
    }

    const checked = await this.readViewerToggleState(checkbox);
    if (checked === desired) {
      return true;
    }

    const clicked = await checkbox
      .click({ timeout: 1000 })
      .then(() => true)
      .catch(() => false);
    if (!clicked) {
      return false;
    }

    await viewerPage.waitForTimeout(400).catch(() => null);
    const states = await this.readViewerFilterStates(viewerPage);
    return states[key] === desired;
  }

  async configureViewerExcludeMatches(viewerPage, { enabled, wordCount }) {
    const wordsRadio = viewerPage
      .locator('.small-matches-radio-group [role="radio"]')
      .filter({ hasText: /^words$/i })
      .first();
    const noSizeRadio = viewerPage
      .locator('.small-matches-radio-group [role="radio"]')
      .filter({ hasText: /^Don't exclude by size$/i })
      .first();
    if (
      !(await wordsRadio.count().catch(() => 0)) &&
      !(await noSizeRadio.count().catch(() => 0))
    ) {
      return null;
    }

    const before = await this.readViewerFilterStates(viewerPage);
    if (enabled) {
      if ((await wordsRadio.count().catch(() => 0)) > 0) {
        const selected = await this.readViewerToggleState(wordsRadio);
        if (!selected) {
          await wordsRadio.click().catch(() => null);
          await viewerPage.waitForTimeout(250).catch(() => null);
        }
      }

      const wordCountInput = viewerPage.locator(".filter-inputs input").first();
      if ((await wordCountInput.count().catch(() => 0)) > 0) {
        const desiredWordCount = String(wordCount);
        const currentWordCount = await wordCountInput.inputValue().catch(() => "");
        if (String(currentWordCount || "").trim() !== desiredWordCount) {
          await wordCountInput.fill(desiredWordCount).catch(() => null);
          await viewerPage.waitForTimeout(250).catch(() => null);
        }
      }
    } else if ((await noSizeRadio.count().catch(() => 0)) > 0) {
      const selected = await this.readViewerToggleState(noSizeRadio);
      if (!selected) {
        await noSizeRadio.click().catch(() => null);
        await viewerPage.waitForTimeout(250).catch(() => null);
      }
    }

    const after = await this.readViewerFilterStates(viewerPage);
    return (
      before.excludeMatches !== after.excludeMatches ||
      before.excludeMatchesWordCount !== after.excludeMatchesWordCount
    );
  }

  async downloadViewerPdf({
    viewerPage,
    context,
    reportDir,
    originalName = null,
    originalFilePath = null,
    expectedReportOptions = null,
    similarity = null,
    reportUrl = null,
    onLog = noop,
  }) {
    if (viewerPage && typeof viewerPage.locator === "function") {
      const menuDownloadPath = await this.downloadViewerPdfFromMenu({
        viewerPage,
        context,
        reportDir,
        originalName,
        originalFilePath,
        expectedReportOptions,
        similarity,
        reportUrl,
        onLog,
      });
      if (menuDownloadPath) {
        return menuDownloadPath;
      }
    }

    const queuedDownloadPath = await this.downloadQueuedViewerPdfFromReportUrl({
      context,
      reportDir,
      originalName,
      originalFilePath,
      expectedReportOptions,
      similarity,
      reportUrl: this.resolveViewerReferenceUrl({ viewerPage, reportUrl }),
      onLog,
      failureLog: null,
      successLog: "Current View PDF berhasil diunduh dari queue Feedback Studio.",
    });
    if (queuedDownloadPath) {
      return queuedDownloadPath;
    }

    return this.downloadViewerPdfFromReportUrl({
      context,
      reportDir,
      originalName,
      originalFilePath,
      expectedReportOptions,
      similarity,
      reportUrl: this.resolveViewerReferenceUrl({ viewerPage, reportUrl }),
      onLog,
    });
  }

  async downloadViewerPdfFromReportUrl({
    context,
    reportDir,
    originalName = null,
    originalFilePath = null,
    expectedReportOptions = null,
    similarity = null,
    reportUrl = null,
    onLog = noop,
    sourceLabel = "endpoint fallback",
    failureLog = "Endpoint PDF Feedback Studio gagal diunduh.",
    successLog = "PDF report Feedback Studio berhasil diunduh.",
  }) {
    const viewerReferenceUrl = this.resolveViewerReferenceUrl({ reportUrl });
    if (!viewerReferenceUrl) {
      onLog("Paper ID viewer tidak ditemukan, PDF report tidak diunduh.");
      return null;
    }

    const viewerUrl = new URL(viewerReferenceUrl);
    const paperId = this.extractViewerPaperId(viewerReferenceUrl);
    const language = viewerUrl.searchParams.get("lang") || "en_us";
    if (!paperId) {
      onLog("Paper ID viewer tidak ditemukan, PDF report tidak diunduh.");
      return null;
    }

    const pdfUrl = `${viewerUrl.origin}/student/paper/${paperId}/pdf?lang=${language}`;
    const pdfResponse = await context.request.get(pdfUrl).catch(() => null);
    if (!pdfResponse?.ok()) {
      if (failureLog) {
        onLog(failureLog);
      }
      return null;
    }

    const pdfPath = path.join(reportDir, "similarity-report.pdf");
    const savedPath = await this.saveValidatedViewerPdf({
      pdfPath,
      pdfBuffer: await pdfResponse.body(),
      originalFilePath,
      expectedReportOptions,
      exportOptions: {
        originalName,
        similarity,
      },
      onLog,
      sourceLabel,
    });
    if (!savedPath) {
      return null;
    }

    if (successLog) {
      onLog(successLog);
    }
    return reportArtifactUrl(reportDir, "similarity-report.pdf");
  }

  collectPayloadStrings(payload, values = []) {
    if (payload === null || payload === undefined) {
      return values;
    }

    if (typeof payload === "string") {
      const trimmed = payload.trim();
      if (trimmed) {
        values.push(trimmed);
      }
      return values;
    }

    if (Array.isArray(payload)) {
      for (const item of payload) {
        this.collectPayloadStrings(item, values);
      }
      return values;
    }

    if (typeof payload === "object") {
      for (const item of Object.values(payload)) {
        this.collectPayloadStrings(item, values);
      }
    }

    return values;
  }

  resolveAbsolutePayloadUrl(value, baseUrl = null) {
    const text = String(value || "").trim();
    if (!text) {
      return null;
    }

    try {
      return new URL(text, baseUrl || undefined).toString();
    } catch (error) {
      void error;
      return null;
    }
  }

  normalizeQueuePollUrl(value, { baseUrl = null } = {}) {
    const absoluteUrl = this.resolveAbsolutePayloadUrl(value, baseUrl);
    if (!absoluteUrl || !/\/queue_pdf\/sas:/i.test(absoluteUrl)) {
      return absoluteUrl;
    }

    try {
      const queueUrl = new URL(absoluteUrl);
      if (queueUrl.searchParams.get("ready") === "1") {
        return queueUrl.toString();
      }
      queueUrl.searchParams.set("cv", "1");
      queueUrl.searchParams.set("output", "json");
      return queueUrl.toString();
    } catch (error) {
      void error;
      return absoluteUrl;
    }
  }

  extractQueuePollUrlFromPayload(payload, { baseUrl = null } = {}) {
    const urls = this.collectPayloadStrings(payload)
      .map((value) => this.normalizeQueuePollUrl(value, { baseUrl }))
      .filter(Boolean);
    return (
      urls.find(
        (value) => /\/queue_pdf\/sas:/i.test(value) && !/[?&]ready=1(?:&|$)/i.test(value)
      ) || null
    );
  }

  extractPdfUrlFromPayload(payload, { baseUrl = null } = {}) {
    const urls = this.collectPayloadStrings(payload)
      .map((value) => this.resolveAbsolutePayloadUrl(value, baseUrl))
      .filter(Boolean);
    return (
      urls.find(
        (value) =>
          /\.pdf(?:$|[?#])/i.test(value) ||
          /amazonaws\.com|cloudfront\.net/i.test(value) ||
          (/\/queue_pdf\/sas:/i.test(value) && /[?&]ready=1(?:&|$)/i.test(value))
      ) || null
    );
  }

  looksLikePdfBuffer(buffer) {
    return Buffer.isBuffer(buffer) && buffer.length >= 5 && buffer.subarray(0, 5).toString() === "%PDF-";
  }

  buildViewerQueueHeaders({ referer = "", accept = "application/json, text/plain, */*" } = {}) {
    return {
      accept,
      "accept-language": "en-US",
      ...(referer ? { referer } : {}),
      "user-agent": DEFAULT_USER_AGENT,
      "x-requested-with": "XMLHttpRequest",
      "x-sproutcore-version": "1.11.0",
      "x-palladium": "1",
    };
  }

  normalizeQueuedPollUrl(queuePollUrl, { viewerOrigin, language = "en_us" } = {}) {
    const normalizedUrl = this.resolveAbsolutePayloadUrl(queuePollUrl, viewerOrigin);
    if (!normalizedUrl) {
      return null;
    }

    const url = new URL(normalizedUrl);
    url.searchParams.set("lang", language);
    if (url.searchParams.get("ready") === "1") {
      return url.toString();
    }
    url.searchParams.set("cv", "1");
    url.searchParams.set("output", "json");
    return url.toString();
  }

  async fetchViewerPdfFromResolvedUrl({
    context,
    pdfUrl,
    referer = "",
    reportDir,
    originalName = null,
    originalFilePath = null,
    expectedReportOptions = null,
    similarity = null,
    onLog = noop,
    sourceLabel = "queue viewer",
  }) {
    if (!pdfUrl || !context?.request) {
      return null;
    }

    const response = await context.request
      .get(pdfUrl, {
        maxRedirects: 3,
        timeout: Math.max(
          30 * 1000,
          Number(this.config.currentViewDownloadTimeoutMs) || 120 * 1000
        ),
        headers: {
          accept: "application/pdf, application/octet-stream, */*",
          ...(referer ? { referer } : {}),
          "x-requested-with": "XMLHttpRequest",
        },
      })
      .catch(() => null);
    if (!response?.ok()) {
      return null;
    }

    const pdfBuffer = await response.body().catch(() => null);
    if (!this.looksLikePdfBuffer(pdfBuffer)) {
      return null;
    }

    const pdfPath = path.join(reportDir, "similarity-report.pdf");
    const savedPath = await this.saveValidatedViewerPdf({
      pdfPath,
      pdfBuffer,
      originalFilePath,
      expectedReportOptions,
      exportOptions: {
        originalName,
        similarity,
      },
      onLog,
      sourceLabel,
    });
    return savedPath ? reportArtifactUrl(reportDir, "similarity-report.pdf") : null;
  }

  async downloadQueuedViewerPdfFromReportUrl({
    context,
    reportDir,
    originalName = null,
    originalFilePath = null,
    expectedReportOptions = null,
    similarity = null,
    reportUrl = null,
    initialPollUrl = null,
    initialPdfUrl = null,
    skipQueueRequest = false,
    onLog = noop,
    sourceLabel = "queue viewer",
    failureLog = "Queue Current View Feedback Studio gagal diunduh.",
    successLog = "Current View PDF berhasil diunduh dari queue Feedback Studio.",
  }) {
    if (!context?.request) {
      return null;
    }

    const viewerReferenceUrl = this.resolveViewerReferenceUrl({ reportUrl });
    if (!viewerReferenceUrl) {
      return null;
    }

    const viewerUrl = new URL(viewerReferenceUrl);
    const paperId = this.extractViewerPaperId(viewerReferenceUrl);
    const language = viewerUrl.searchParams.get("lang") || "en_us";
    if (!paperId) {
      return null;
    }

    let activePollUrl = this.normalizeQueuedPollUrl(initialPollUrl, {
      viewerOrigin: viewerUrl.origin,
      language,
    });
    let immediatePdfUrl = this.resolveAbsolutePayloadUrl(initialPdfUrl, viewerUrl.origin);
    let queuePayload = {};

    if (!activePollUrl && !immediatePdfUrl && !skipQueueRequest) {
      const requestHeaders = this.buildViewerQueueHeaders({
        referer: viewerReferenceUrl,
      });
      const queueUrl = `${viewerUrl.origin}/student/paper/${paperId}/queue_pdf?lang=${language}&cv=1&output=json`;
      const queueResponse = await context.request
        .post(queueUrl, {
          maxRedirects: 0,
          data: {
            as: 1,
            or_type: "similarity",
            or_translate_language: 0,
          },
          headers: {
            ...requestHeaders,
            "content-type": "application/json",
          },
        })
        .catch(() => null);

      if (!queueResponse || (queueResponse.status() !== 202 && !queueResponse.ok())) {
        if (failureLog) {
          onLog(failureLog);
        }
        return null;
      }

      const queuePayloadText = await queueResponse.text().catch(() => "");
      if (queuePayloadText) {
        try {
          queuePayload = JSON.parse(queuePayloadText);
        } catch (error) {
          void error;
          queuePayload = {};
        }
      }

      activePollUrl = this.normalizeQueuedPollUrl(
        this.extractQueuePollUrlFromPayload(queuePayload, { baseUrl: viewerUrl.origin }) ||
          this.resolveAbsolutePayloadUrl(
            queueResponse.headers().location || queueResponse.headers().Location || "",
            viewerUrl.origin
          ),
        {
          viewerOrigin: viewerUrl.origin,
          language,
        }
      );
      immediatePdfUrl =
        this.resolveAbsolutePayloadUrl(queuePayload.url || "", viewerUrl.origin) ||
        this.extractPdfUrlFromPayload(queuePayload, {
          baseUrl: viewerUrl.origin,
        });
    }
    if (immediatePdfUrl && /\/queue_pdf\/sas:/i.test(immediatePdfUrl)) {
      activePollUrl = this.normalizeQueuedPollUrl(immediatePdfUrl, {
        viewerOrigin: viewerUrl.origin,
        language,
      });
    }
    if (immediatePdfUrl && !/\/queue_pdf\/sas:/i.test(immediatePdfUrl)) {
      const pdfFromPayload = await this.fetchViewerPdfFromResolvedUrl({
        context,
        pdfUrl: immediatePdfUrl,
        referer: viewerReferenceUrl,
        reportDir,
        originalName,
        originalFilePath,
        expectedReportOptions,
        similarity,
        onLog,
        sourceLabel,
      });
      if (pdfFromPayload) {
        if (successLog) {
          onLog(successLog);
        }
        return pdfFromPayload;
      }
    }

    const nestedImmediatePdfUrl = this.extractPdfUrlFromPayload(queuePayload, {
      baseUrl: viewerUrl.origin,
    });
    if (nestedImmediatePdfUrl) {
      const pdfFromPayload = await this.fetchViewerPdfFromResolvedUrl({
        context,
        pdfUrl: nestedImmediatePdfUrl,
        referer: viewerReferenceUrl,
        reportDir,
        originalName,
        originalFilePath,
        expectedReportOptions,
        similarity,
        onLog,
        sourceLabel,
      });
      if (pdfFromPayload) {
        if (successLog) {
          onLog(successLog);
        }
        return pdfFromPayload;
      }
    }

    if (!activePollUrl) {
      if (failureLog) {
        onLog(failureLog);
      }
      return null;
    }

    const deadline =
      Date.now() + Math.max(15 * 1000, Number(this.config.currentViewQueueTimeoutMs) || 90 * 1000);
    while (Date.now() < deadline) {
      if (/[?&]ready=1(?:&|$)/i.test(activePollUrl)) {
        const pdfFromReadyUrl = await this.fetchViewerPdfFromResolvedUrl({
          context,
          pdfUrl: activePollUrl,
          referer: viewerReferenceUrl,
          reportDir,
          originalName,
          originalFilePath,
          similarity,
          onLog,
          sourceLabel,
        });
        if (pdfFromReadyUrl) {
          if (successLog) {
            onLog(successLog);
          }
          return pdfFromReadyUrl;
        }
      }

      const pollResponse = await context.request
        .get(activePollUrl, {
          maxRedirects: 0,
          headers: this.buildViewerQueueHeaders({
            referer: viewerReferenceUrl,
          }),
        })
        .catch(() => null);

      if (pollResponse) {
        const headers = pollResponse.headers();
        const rawLocationUrl = this.resolveAbsolutePayloadUrl(
          headers.location || headers.Location || "",
          activePollUrl
        );
        const locationUrl = /\/queue_pdf\/sas:/i.test(rawLocationUrl || "")
          ? this.normalizeQueuedPollUrl(rawLocationUrl, {
              viewerOrigin: viewerUrl.origin,
              language,
            })
          : rawLocationUrl;
        if (locationUrl) {
          if (/\/queue_pdf\/sas:/i.test(locationUrl)) {
            activePollUrl = locationUrl;
          } else {
            const pdfFromLocation = await this.fetchViewerPdfFromResolvedUrl({
              context,
              pdfUrl: locationUrl,
              referer: viewerReferenceUrl,
              reportDir,
              originalName,
              originalFilePath,
              expectedReportOptions,
              similarity,
              onLog,
              sourceLabel,
            });
            if (pdfFromLocation) {
              if (successLog) {
                onLog(successLog);
              }
              return pdfFromLocation;
            }
          }
        }

        const pollBody = await pollResponse.body().catch(() => null);
        if (this.looksLikePdfBuffer(pollBody)) {
          const pdfPath = path.join(reportDir, "similarity-report.pdf");
          const savedPath = await this.saveValidatedViewerPdf({
            pdfPath,
            pdfBuffer: pollBody,
            originalFilePath,
            expectedReportOptions,
            exportOptions: {
              originalName,
              similarity,
            },
            onLog,
            sourceLabel,
          });
          if (savedPath) {
            if (successLog) {
              onLog(successLog);
            }
            return reportArtifactUrl(reportDir, "similarity-report.pdf");
          }
        }

        if (pollBody?.length) {
          const pollText = pollBody.toString("utf8");
          let pollPayload = null;
          try {
            pollPayload = JSON.parse(pollText);
          } catch (error) {
            void error;
            pollPayload = null;
          }

          if (pollPayload) {
            const nextPollUrl = this.extractQueuePollUrlFromPayload(pollPayload, {
              baseUrl: activePollUrl,
            });
            if (nextPollUrl) {
              activePollUrl =
                this.normalizeQueuedPollUrl(nextPollUrl, {
                  viewerOrigin: viewerUrl.origin,
                  language,
                }) || activePollUrl;
            }

            const directPayloadUrl = this.resolveAbsolutePayloadUrl(
              pollPayload.url || "",
              activePollUrl
            );
            if (directPayloadUrl) {
              if (/\/queue_pdf\/sas:/i.test(directPayloadUrl)) {
                activePollUrl =
                  this.normalizeQueuedPollUrl(directPayloadUrl, {
                    viewerOrigin: viewerUrl.origin,
                    language,
                  }) || activePollUrl;
              } else {
                const pdfFromPayload = await this.fetchViewerPdfFromResolvedUrl({
                  context,
                  pdfUrl: directPayloadUrl,
                  referer: viewerReferenceUrl,
                  reportDir,
                  originalName,
                  originalFilePath,
                  expectedReportOptions,
                  similarity,
                  onLog,
                  sourceLabel,
                });
                if (pdfFromPayload) {
                  if (successLog) {
                    onLog(successLog);
                  }
                  return pdfFromPayload;
                }
              }
            }

            const payloadPdfUrl = this.extractPdfUrlFromPayload(pollPayload, {
              baseUrl: activePollUrl,
            });
            if (payloadPdfUrl) {
              const pdfFromPayload = await this.fetchViewerPdfFromResolvedUrl({
                context,
                pdfUrl: payloadPdfUrl,
                referer: viewerReferenceUrl,
                reportDir,
                originalName,
                originalFilePath,
                expectedReportOptions,
                similarity,
                onLog,
                sourceLabel,
              });
              if (pdfFromPayload) {
                if (successLog) {
                  onLog(successLog);
                }
                return pdfFromPayload;
              }
            }
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    if (failureLog) {
      onLog(failureLog);
    }
    return null;
  }

  async hasViewerSessionCookie(context) {
    const cookies = await context
      .cookies(["https://ev.turnitin.com"])
      .catch(() => []);
    return cookies.some(
      (cookie) =>
        cookie.name === "session-id" &&
        /(^|\.)ev\.turnitin\.com$/i.test(String(cookie.domain || ""))
    );
  }

  async probeViewerJsonEndpoint(context, url, { referer = "" } = {}) {
    const response = await context.request
      .get(url, {
        maxRedirects: 0,
        headers: this.buildViewerQueueHeaders({
          referer,
        }),
      })
      .catch(() => null);
    if (!response) {
      return false;
    }

    const contentType = String(response.headers()["content-type"] || "");
    return response.status() === 200 && /application\/json/i.test(contentType);
  }

  async waitForViewerBootstrap({
    viewerPage = null,
    context,
    reportUrl = null,
    timeoutMs = 15 * 1000,
  }) {
    const viewerReferenceUrl = this.resolveViewerReferenceUrl({ viewerPage, reportUrl });
    if (!viewerReferenceUrl) {
      return false;
    }

    const viewerUrl = new URL(viewerReferenceUrl);
    const paperId = this.extractViewerPaperId(viewerReferenceUrl);
    const language = viewerUrl.searchParams.get("lang") || "en_us";
    const configUrl = `${viewerUrl.origin}/application/config?lang=${language}&cv=1&output=json`;
    const paperUrl = paperId
      ? `${viewerUrl.origin}/student/paper/${paperId}?lang=${language}&cv=1&output=json`
      : null;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const hasViewerSession = await this.hasViewerSessionCookie(context);
      if (hasViewerSession) {
        const configReady = await this.probeViewerJsonEndpoint(context, configUrl, {
          referer: viewerReferenceUrl,
        });
        const paperReady = paperUrl
          ? await this.probeViewerJsonEndpoint(context, paperUrl, {
              referer: viewerReferenceUrl,
            })
          : true;
        if (configReady && paperReady) {
          return true;
        }
      }

      if (viewerPage) {
        await viewerPage.waitForTimeout(1000).catch(() => null);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    return false;
  }

  async downloadViewerPdfFromMenu({
    viewerPage,
    context,
    reportDir,
    originalName = null,
    originalFilePath = null,
    expectedReportOptions = null,
    similarity = null,
    reportUrl = null,
    onLog = noop,
  }) {
    const downloadButton = viewerPage
      .locator('[title="Download"], .sidebar-download-button')
      .first();
    if (!(await downloadButton.count().catch(() => 0))) {
      onLog("Tombol Download di Feedback Studio tidak ditemukan, pakai fallback endpoint.");
      return null;
    }

    await downloadButton.click().catch(() => null);
    await viewerPage.waitForTimeout(500).catch(() => null);

    const currentViewButton = viewerPage
      .locator('[aria-label="Current View"], .print-download-btn')
      .filter({ hasText: /^Current View$/i })
      .first();
    if (!(await currentViewButton.count().catch(() => 0))) {
      onLog("Opsi Current View tidak muncul dari menu download, pakai fallback endpoint.");
      return null;
    }

    let capturedPdfResponse = null;
    let queuedPollUrl = null;
    let queuedReadyUrl = null;
    const queueResponseTasks = new Set();
    const onResponse = (response) => {
      if (!capturedPdfResponse && this.isCompletePdfResponse(response)) {
        capturedPdfResponse = response;
      }

      if (!/\/queue_pdf\b/i.test(response.url())) {
        return;
      }

      const task = (async () => {
        const contentType = String(response.headers()["content-type"] || "");
        if (!/application\/json/i.test(contentType)) {
          return;
        }

        const payload = await response.json().catch(() => null);
        if (!payload) {
          return;
        }

        const payloadPollUrl = this.extractQueuePollUrlFromPayload(payload, {
          baseUrl: response.url(),
        });
        if (payloadPollUrl) {
          queuedPollUrl = payloadPollUrl;
        }

        const payloadPdfUrl = this.extractPdfUrlFromPayload(payload, {
          baseUrl: response.url(),
        });
        if (payloadPdfUrl) {
          queuedReadyUrl = payloadPdfUrl;
        }
      })();
      queueResponseTasks.add(task);
      task.finally(() => queueResponseTasks.delete(task));
    };
    context.on("response", onResponse);
    const eventTimeoutMs = Math.max(3000, Number(this.config.currentViewMenuTimeoutMs) || 6000);
    const settleTimeoutMs = Math.max(1500, Math.min(3500, Math.round(eventTimeoutMs / 2)));

    const pendingDownload = viewerPage.waitForEvent("download", { timeout: eventTimeoutMs }).catch(
      () => null
    );
    const pendingPopup = context.waitForEvent("page", { timeout: eventTimeoutMs }).catch(
      () => null
    );
    const previousUrl = viewerPage.url();
    await currentViewButton.click().catch(() => null);
    await viewerPage.waitForTimeout(settleTimeoutMs).catch(() => null);

    context.off("response", onResponse);

    const download = await pendingDownload;
    if (download) {
      context.off("response", onResponse);
      const pdfPath = path.join(reportDir, "similarity-report.pdf");
      const tempPath = path.join(reportDir, "similarity-report.menu.pdf");
      await download.saveAs(tempPath);
      const savedPath = await this.promoteValidatedViewerPdf({
        sourcePath: tempPath,
        targetPath: pdfPath,
        originalFilePath,
        expectedReportOptions,
        exportOptions: {
          originalName,
          similarity,
        },
        onLog,
        sourceLabel: "menu download",
      });
      if (savedPath) {
        onLog("Current View PDF berhasil diunduh dari menu viewer.");
        return reportArtifactUrl(reportDir, "similarity-report.pdf");
      }
    }

    if (capturedPdfResponse) {
      context.off("response", onResponse);
      const pdfPath = path.join(reportDir, "similarity-report.pdf");
      const savedPath = await this.saveValidatedViewerPdf({
        pdfPath,
        pdfBuffer: await capturedPdfResponse.body().catch(() => null),
        originalFilePath,
        expectedReportOptions,
        exportOptions: {
          originalName,
          similarity,
        },
        onLog,
        sourceLabel: "response PDF viewer",
      });
      if (savedPath) {
        onLog("Current View PDF berhasil ditangkap dari response viewer.");
        return reportArtifactUrl(reportDir, "similarity-report.pdf");
      }
    }

    const popup = await pendingPopup;
    if (popup) {
      context.off("response", onResponse);
      const popupPdf = await this.capturePdfFromPage(popup, context).catch(() => null);
      if (popupPdf) {
        const pdfPath = path.join(reportDir, "similarity-report.pdf");
        const savedPath = await this.saveValidatedViewerPdf({
          pdfPath,
          pdfBuffer: popupPdf,
          originalFilePath,
          expectedReportOptions,
          exportOptions: {
            originalName,
            similarity,
          },
          onLog,
          sourceLabel: "popup viewer",
        });
        await popup.close().catch(() => null);
        if (savedPath) {
          onLog("Current View PDF berhasil ditangkap dari popup viewer.");
          return reportArtifactUrl(reportDir, "similarity-report.pdf");
        }
      } else {
        await popup.close().catch(() => null);
      }
    }

    const navigatedPdf = await this.captureNavigatedPdfFromPage(viewerPage, context, previousUrl);
    if (navigatedPdf) {
      context.off("response", onResponse);
      const pdfPath = path.join(reportDir, "similarity-report.pdf");
      const savedPath = await this.saveValidatedViewerPdf({
        pdfPath,
        pdfBuffer: navigatedPdf,
        originalFilePath,
        expectedReportOptions,
        exportOptions: {
          originalName,
          similarity,
        },
        onLog,
        sourceLabel: "navigasi viewer",
      });
      if (savedPath) {
        onLog("Current View PDF berhasil ditangkap dari navigasi viewer.");
        return reportArtifactUrl(reportDir, "similarity-report.pdf");
      }
    }

    const pendingQueueTasks = [...queueResponseTasks];
    if (pendingQueueTasks.length) {
      await Promise.allSettled(pendingQueueTasks);
    }
    context.off("response", onResponse);

    const queuedDownloadPath = await this.downloadQueuedViewerPdfFromReportUrl({
      context,
      reportDir,
      originalName,
      originalFilePath,
      expectedReportOptions,
      similarity,
      reportUrl: this.resolveViewerReferenceUrl({ viewerPage, reportUrl }),
      initialPollUrl: queuedPollUrl,
      initialPdfUrl: queuedReadyUrl,
      skipQueueRequest: Boolean(queuedPollUrl || queuedReadyUrl),
      onLog,
      failureLog: null,
      successLog: "Current View PDF berhasil diunduh dari queue viewer.",
    });
    if (queuedDownloadPath) {
      return queuedDownloadPath;
    }

    onLog("Current View tidak memicu download browser dengan cepat, pakai fallback endpoint.");
    return null;
  }

  isCompletePdfResponse(response) {
    const headers = response.headers();
    const contentType = headers["content-type"] || headers["Content-Type"] || "";
    const contentRange = headers["content-range"] || headers["Content-Range"] || "";
    const looksLikePdf =
      /application\/pdf/i.test(contentType) || /\.pdf(?:$|\?)/i.test(response.url());
    return looksLikePdf && response.status() < 300 && response.status() !== 206 && !contentRange;
  }

  resolveViewerReferenceUrl({ viewerPage = null, reportUrl = null } = {}) {
    const viewerPageUrl = viewerPage?.url?.() || null;
    if (this.extractViewerPaperId(viewerPageUrl)) {
      return viewerPageUrl;
    }

    if (isLikelyViewerUrl(reportUrl)) {
      return reportUrl;
    }

    return viewerPageUrl || null;
  }

  buildCurrentViewExportName({ sourcePath, originalName, similarity, jobId } = {}) {
    const preferredName = path.parse(originalName || "").name || path.basename(sourcePath, ".pdf");
    const safeName = sanitizeFilename(preferredName, "similarity-report");
    const similarityPart = normalizeSimilarityForFilename(similarity);
    const jobPart = sanitizeFilename(String(jobId || "").slice(0, 8), "latest");
    return `${safeName}--${similarityPart}--${jobPart}.pdf`;
  }

  async exportCurrentViewCopy(
    sourcePath,
    { originalName = null, similarity = null, jobId = null } = {},
    onLog = noop
  ) {
    const exportDir = this.config.storage.currentViewExportDir;
    if (!exportDir) {
      return;
    }

    const resolvedJobId = jobId || path.basename(path.dirname(sourcePath));
    const targetPath = path.join(
      exportDir,
      this.buildCurrentViewExportName({
        sourcePath,
        originalName,
        similarity,
        jobId: resolvedJobId,
      })
    );

    await fs.mkdir(path.dirname(targetPath), { recursive: true }).catch(() => null);
    const copiedNamed = await fs
      .copyFile(sourcePath, targetPath)
      .then(() => true)
      .catch(() => false);
    if (copiedNamed) {
      onLog(`Salinan Current View disimpan ke ${targetPath}.`);
    }

    const latestTargetPath = this.config.storage.currentViewLatestExportPath;
    if (!latestTargetPath || latestTargetPath === targetPath) {
      return;
    }

    await fs.mkdir(path.dirname(latestTargetPath), { recursive: true }).catch(() => null);
    const copiedLatest = await fs
      .copyFile(sourcePath, latestTargetPath)
      .then(() => true)
      .catch(() => false);
    if (copiedLatest) {
      onLog(`Salinan Current View terbaru disimpan ke ${latestTargetPath}.`);
    }
  }

  async saveValidatedViewerPdf({
    pdfPath,
    pdfBuffer,
    originalFilePath = null,
    expectedReportOptions = null,
    exportOptions = {},
    onLog = noop,
    sourceLabel = "viewer",
  }) {
    if (!pdfBuffer || !pdfBuffer.length) {
      return null;
    }

    await fs.writeFile(pdfPath, pdfBuffer);
    const pdfMetadata = await this.readTurnitinReportPdfMetadata(pdfPath);
    if (!pdfMetadata.valid) {
      await fs.unlink(pdfPath).catch(() => null);
      onLog(
        pdfMetadata.readable
          ? `PDF ${sourceLabel} tidak berisi halaman Similarity Report Turnitin, file diabaikan.`
          : pdfMetadata.isPdf
            ? `PDF ${sourceLabel} tidak lengkap atau tidak bisa dibuka, file diabaikan.`
            : `PDF ${sourceLabel} tidak terlihat seperti Similarity Report Turnitin, file diabaikan.`
      );
      return null;
    }
    if (originalFilePath && (await areFilesByteIdentical(pdfPath, originalFilePath))) {
      await fs.unlink(pdfPath).catch(() => null);
      onLog(`PDF ${sourceLabel} identik dengan file submission asli, file diabaikan.`);
      return null;
    }
    if (
      expectedReportOptions &&
      this.shouldEnforceViewerFilterValidation(expectedReportOptions, pdfMetadata) &&
      !this.doesPdfMatchRequestedReportOptions(pdfMetadata, expectedReportOptions)
    ) {
      await fs.unlink(pdfPath).catch(() => null);
      onLog(`PDF ${sourceLabel} belum mengikuti filter viewer yang diminta, file diabaikan.`);
      return null;
    }
    await this.exportCurrentViewCopy(
      pdfPath,
      {
        ...exportOptions,
        similarity: pdfMetadata.similarity || exportOptions.similarity || null,
      },
      onLog
    );
    return pdfPath;
  }

  async promoteValidatedViewerPdf({
    sourcePath,
    targetPath,
    originalFilePath = null,
    expectedReportOptions = null,
    exportOptions = {},
    onLog = noop,
    sourceLabel = "viewer",
  }) {
    const pdfMetadata = await this.readTurnitinReportPdfMetadata(sourcePath);
    if (!pdfMetadata.valid) {
      await fs.unlink(sourcePath).catch(() => null);
      onLog(
        pdfMetadata.readable
          ? `PDF ${sourceLabel} tidak berisi halaman Similarity Report Turnitin, file diabaikan.`
          : pdfMetadata.isPdf
            ? `PDF ${sourceLabel} tidak lengkap atau tidak bisa dibuka, file diabaikan.`
            : `PDF ${sourceLabel} tidak terlihat seperti Similarity Report Turnitin, file diabaikan.`
      );
      return null;
    }
    if (originalFilePath && (await areFilesByteIdentical(sourcePath, originalFilePath))) {
      await fs.unlink(sourcePath).catch(() => null);
      onLog(`PDF ${sourceLabel} identik dengan file submission asli, file diabaikan.`);
      return null;
    }
    if (
      expectedReportOptions &&
      this.shouldEnforceViewerFilterValidation(expectedReportOptions, pdfMetadata) &&
      !this.doesPdfMatchRequestedReportOptions(pdfMetadata, expectedReportOptions)
    ) {
      await fs.unlink(sourcePath).catch(() => null);
      onLog(`PDF ${sourceLabel} belum mengikuti filter viewer yang diminta, file diabaikan.`);
      return null;
    }
    if (sourcePath !== targetPath) {
      await fs.rename(sourcePath, targetPath).catch(async () => {
        await fs.copyFile(sourcePath, targetPath).catch(() => null);
        await fs.unlink(sourcePath).catch(() => null);
      });
    }
    await this.exportCurrentViewCopy(
      targetPath,
      {
        ...exportOptions,
        similarity: pdfMetadata.similarity || exportOptions.similarity || null,
      },
      onLog
    );
    return targetPath;
  }

  async isLikelyTurnitinReportPdf(pdfPath) {
    const metadata = await this.readTurnitinReportPdfMetadata(pdfPath);
    return metadata.valid;
  }

  looksLikeTurnitinReportText(text) {
    return detectTurnitinReportText(text);
  }

  extractTurnitinReportSimilarity(text) {
    return extractTurnitinReportSimilarityFromText(text);
  }

  async readTurnitinReportPdfMetadata(pdfPath) {
    return readTurnitinReportPdfMetadata(pdfPath);
  }

  async resolveFinalSimilarity({ reportDir, similarity = null } = {}) {
    const pdfPath = path.join(reportDir, "similarity-report.pdf");
    const metadata = await this.readTurnitinReportPdfMetadata(pdfPath).catch(() => null);
    return metadata?.similarity || similarity || null;
  }

  async capturePdfFromPage(page, context) {
    await page.waitForLoadState("domcontentloaded").catch(() => null);
    await page.waitForTimeout(1200).catch(() => null);
    const pageUrl = page.url();

    if (/^blob:/i.test(pageUrl)) {
      const bytes = await page
        .evaluate(async () => {
          const response = await fetch(window.location.href);
          const buffer = await response.arrayBuffer();
          return Array.from(new Uint8Array(buffer));
        })
        .catch(() => null);
      return bytes ? Buffer.from(bytes) : null;
    }

    if (/^https?:/i.test(pageUrl)) {
      const response = await context.request.get(pageUrl).catch(() => null);
      if (response?.ok()) {
        return response.body();
      }
    }

    return null;
  }

  async captureNavigatedPdfFromPage(page, context, previousUrl) {
    if (page.url() === previousUrl) {
      return null;
    }

    return this.capturePdfFromPage(page, context);
  }

  async waitForSimilarity(page, onLog, timeoutMs = this.config.similarityWaitMs) {
    const deadline = Date.now() + timeoutMs;
    const pollIntervalMs = Math.max(1000, Number(this.config.similarityPollIntervalMs) || 5000);

    while (Date.now() < deadline) {
      const similarity = await this.extractSimilarity(page);
      if (similarity) {
        onLog(`Similarity terdeteksi: ${similarity}`);
        return similarity;
      }

      onLog(
        `Similarity belum muncul, tunggu ${Math.round(pollIntervalMs / 1000)} detik lalu refresh.`
      );
      await page.waitForTimeout(pollIntervalMs);
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => null);
      await page.waitForTimeout(1200);
    }

    return null;
  }

  async waitForUploadReviewOrComplete(page) {
    const deadline = Date.now() + 120 * 1000;

    while (Date.now() < deadline) {
      const text = await this.readBodyText(page).catch(() => "");
      if (
        /submission complete|submitted successfully|submission uploaded successfully|download digital receipt/i.test(
          text
        )
      ) {
        return { kind: "complete" };
      }

      const submitActions = await this.waitForActions(
        page,
        [/submit to turnitin/i, /^submit$/i, /confirm/i, /yes/i],
        { enabledOnly: true, timeoutMs: 1000 }
      ).catch(() => []);
      if (submitActions.length) {
        return { kind: "submit", actions: submitActions };
      }

      await page.waitForTimeout(1000).catch(() => null);
    }

    throw new Error("Tahap review/submit akhir Turnitin tidak muncul.");
  }

  async waitForUploadComplete(page) {
    const deadline = Date.now() + 120 * 1000;

    while (Date.now() < deadline) {
      const text = await this.readBodyText(page).catch(() => "");
      if (
        /submission complete|submitted successfully|submission uploaded successfully|download digital receipt/i.test(
          text
        )
      ) {
        return;
      }

      await page.waitForTimeout(1000).catch(() => null);
    }

    const debug = await this.captureDebugSnapshot(page, "upload-not-complete", {
      includeJson: true,
    });
    throw new Error(
      `Konfirmasi submission selesai tidak muncul. debugHtml=${debug.htmlPath} debugShot=${debug.screenshotPath} debugJson=${debug.jsonPath}`
    );
  }

  async dismissCommonBanners(page) {
    const actions = await this.listActions(page, [/accept/i, /agree/i]).catch(() => []);
    if (!actions.length) {
      return;
    }

    await this.clickAction(page, actions[0].actionId).catch(() => null);
    await page.waitForTimeout(600);
  }

  async extractSimilarity(page) {
    const bodyText = await this.readBodyText(page);
    const patterns = [
      /similarity(?: score)?[^0-9]{0,20}(100|[1-9]?\d)%/i,
      /(100|[1-9]?\d)%[^a-z]{0,20}similarity/i,
      /\b(100|[1-9]?\d)%/,
    ];

    for (const pattern of patterns) {
      const match = bodyText.match(pattern);
      if (match) {
        const value = match[1] || match[0];
        return value.endsWith("%") ? value : `${value}%`;
      }
    }

    return null;
  }

  async extractReportUrl(page) {
    const hrefs = await page
      .evaluate(() => {
        const clean = (value) => String(value || "").trim();
        const toAbsolute = (value) => {
          try {
            return new URL(value, window.location.href).toString();
          } catch (error) {
            void error;
            return null;
          }
        };
        const looksLikeUrlValue = (value) =>
          /^(https?:)?\/\//i.test(value) ||
          value.startsWith("/") ||
          value.startsWith("?") ||
          /turnitin|carta|viewer|report|student_user|[?&]o=\d+/i.test(value);
        const detectLanguage = () => {
          const url = new URL(window.location.href);
          const langParam = clean(url.searchParams.get("lang"));
          if (langParam) {
            return langParam.toLowerCase().replace("-", "_");
          }

          const docLang = clean(document.documentElement.getAttribute("lang"));
          if (docLang) {
            return docLang.toLowerCase().replace("-", "_");
          }

          return "en_us";
        };
        const findUserId = (row) => {
          const resubmit = row.querySelector('[id^="resubmit-"]');
          const resubmitId = clean(resubmit?.id);
          const resubmitMatch = resubmitId.match(/^resubmit-\d+-(\d+)$/i);
          if (resubmitMatch) {
            return resubmitMatch[1];
          }

          const pageText = document.documentElement.innerHTML;
          const instructorMatch = pageText.match(/instructor_id:\s*(\d+)/i);
          return instructorMatch ? instructorMatch[1] : null;
        };
        const buildViewerUrl = (paperId, userId, language) => {
          if (!paperId || !userId) {
            return null;
          }

          return `https://ev.turnitin.com/app/carta/${language}/?o=${paperId}&ro=103&student_user=1&lang=${language}&u=${userId}&s=1`;
        };
        const candidates = [];
        const language = detectLanguage();

        for (const row of document.querySelectorAll("tr[data-paper-id]")) {
          const paperId = clean(row.getAttribute("data-paper-id"));
          const hasViewerControl = row.querySelector(
            "a.similarity-open, a.default-open, a.grademark-open"
          );
          if (!paperId || !hasViewerControl) {
            continue;
          }

          const viewerUrl = buildViewerUrl(paperId, findUserId(row), language);
          if (viewerUrl) {
            candidates.push(viewerUrl);
          }
        }

        for (const element of document.querySelectorAll(
          'a[href], a.similarity-open, a.default-open, a.grademark-open'
        )) {
          const title = clean(element.getAttribute("title"));
          const classes = clean(element.className);
          const text = clean(
            `${element.textContent || ""} ${title} ${classes} ${
              element.getAttribute("aria-label") || ""
            }`
          );
          const looksLikeReportControl =
            /\bsimilarity-open\b|\bdefault-open\b|\bgrademark-open\b/i.test(classes) ||
            /view similarity|feedback studio|view instructor feedback|open paper/i.test(
              text
            );

          if (!looksLikeReportControl) {
            continue;
          }

          const attributeNames = element.getAttributeNames
            ? element.getAttributeNames()
            : [];
          for (const attributeName of attributeNames) {
            if (!/(href|url|viewer|report)/i.test(attributeName)) {
              continue;
            }

            const value = clean(element.getAttribute(attributeName));
            if (
              !value ||
              value === "#" ||
              /^javascript:/i.test(value) ||
              !looksLikeUrlValue(value)
            ) {
              continue;
            }

            const absolute = toAbsolute(value);
            if (absolute) {
              candidates.push(absolute);
            }
          }
        }

        return [...new Set(candidates)];
      })
      .catch(() => []);

    return hrefs.find((href) => isLikelyViewerUrl(href)) || null;
  }

  async openReportViewer(page, context, onLog = noop) {
    const directReportUrl = await this.extractReportUrl(page).catch(() => null);
    const openedViewer = await this.openReportViewerFromAssignment(page, context, onLog, {
      directReportUrl,
    }).catch(() => null);
    if (openedViewer) {
      return openedViewer;
    }

    if (isLikelyViewerUrl(directReportUrl)) {
      onLog("Menemukan URL report Turnitin, mencoba buka viewer.");
      const viewerPage = await context.newPage();
      await viewerPage
        .goto(directReportUrl, { waitUntil: "domcontentloaded" })
        .catch(() => null);
      await viewerPage.waitForTimeout(1200).catch(() => null);

      if (await this.looksLikeViewerPage(viewerPage)) {
        return {
          viewerPage,
          reportUrl: viewerPage.url(),
          closeViewerPage: true,
        };
      }

      await viewerPage.close().catch(() => null);
    }

    return {
      viewerPage: null,
      reportUrl: directReportUrl || null,
      closeViewerPage: false,
    };
  }

  async findSimilarityScoreLink(page) {
    const candidates = page.locator('a.similarity-open, a[title*="Similarity matches" i]');
    const candidateCount = await candidates.count().catch(() => 0);

    for (let index = 0; index < candidateCount; index += 1) {
      const candidate = candidates.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) {
        continue;
      }

      const candidateText = await candidate
        .evaluate((element) =>
          [
            element.innerText || "",
            element.textContent || "",
            element.getAttribute("title") || "",
            element.getAttribute("aria-label") || "",
          ]
            .join(" ")
            .replace(/\s+/g, " ")
            .trim()
        )
        .catch(() => "");
      if (/\b(100|[1-9]?\d)\s*%/.test(candidateText)) {
        return candidate;
      }

      const rowText = await candidate
        .locator("xpath=ancestor::tr[1]")
        .innerText()
        .then((value) => String(value || "").replace(/\s+/g, " ").trim())
        .catch(() => "");
      if (/\b(100|[1-9]?\d)\s*%/.test(rowText)) {
        return candidate;
      }
    }

    return null;
  }

  async openReportViewerFromAssignment(
    page,
    context,
    onLog = noop,
    { directReportUrl = null } = {}
  ) {
    const similarityScoreLink = await this.findSimilarityScoreLink(page);
    const entryPoints = [
      ...(similarityScoreLink
        ? [
            {
              locator: similarityScoreLink,
              log: "Membuka Feedback Studio dari angka similarity di dashboard.",
            },
          ]
        : []),
      {
        locator: page.locator('a.similarity-open').first(),
        log: "Membuka Feedback Studio dari halaman assignment.",
      },
      {
        locator: page.locator('a.default-open').first(),
        log: "Membuka Feedback Studio dari halaman assignment.",
      },
      {
        locator: page.locator('a.grademark-open').first(),
        log: "Membuka Feedback Studio dari halaman assignment.",
      },
      {
        locator: page.locator('a[title*="Feedback Studio" i]').first(),
        log: "Membuka Feedback Studio dari halaman assignment.",
      },
      {
        locator: page.locator('a[title*="Similarity matches" i]').first(),
        log: "Membuka Feedback Studio dari halaman assignment.",
      },
      {
        locator: page.locator('a[title*="View Instructor Feedback" i]').first(),
        log: "Membuka Feedback Studio dari halaman assignment.",
      },
    ];

    for (const entryPoint of entryPoints) {
      const locator = entryPoint.locator;
      if (!(await locator.count().catch(() => 0))) {
        continue;
      }

      if (!(await locator.isVisible().catch(() => false))) {
        continue;
      }

      onLog(entryPoint.log);
      const popupPromise = context.waitForEvent("page", { timeout: 8000 }).catch(
        () => null
      );
      const previousUrl = page.url();

      const clicked = await locator
        .click({ timeout: 2000 })
        .then(() => true)
        .catch(() => false);
      if (!clicked) {
        continue;
      }

      const popup = await popupPromise;
      if (popup) {
        await popup.waitForLoadState("domcontentloaded").catch(() => null);
        await popup.waitForTimeout(1200).catch(() => null);
        await this.waitForViewerLanding(popup).catch(() => null);
        if (!this.extractViewerPaperId(popup.url()) && isLikelyViewerUrl(directReportUrl)) {
          await popup.goto(directReportUrl, { waitUntil: "domcontentloaded" }).catch(() => null);
          await popup.waitForTimeout(1200).catch(() => null);
          await this.waitForViewerLanding(popup).catch(() => null);
        }

        return {
          viewerPage: popup,
          reportUrl:
            (isLikelyViewerUrl(popup.url()) ? popup.url() : null) || directReportUrl || null,
          closeViewerPage: true,
        };
      }

      await page.waitForTimeout(1500).catch(() => null);
      if (page.url() !== previousUrl) {
        await this.waitForViewerLanding(page).catch(() => null);
      }
      if (page.url() !== previousUrl && (await this.looksLikeViewerPage(page))) {
        return {
          viewerPage: page,
          reportUrl: page.url(),
          closeViewerPage: false,
        };
      }
    }

    return null;
  }

  async looksLikeViewerPage(page) {
    const title = await page.title().catch(() => "");
    const bodyText = await this.readBodyText(page).catch(() => "");
    return /match overview|all sources|source comparison|exclude quotes|exclude bibliography|feedback studio/i.test(
      `${title}\n${bodyText}`
    );
  }

  async readBodyText(page) {
    return this.readScopeText(page);
  }

  async fillFirst(page, attempts) {
    for (const attempt of attempts) {
      try {
        if (attempt.kind === "label") {
          const locator = page.getByLabel(attempt.target).first();
          if (await locator.count()) {
            await locator.fill(attempt.value);
            return true;
          }
        }

        if (attempt.kind === "selector") {
          const locator = page.locator(attempt.target).first();
          if (await locator.count()) {
            await locator.fill(attempt.value);
            return true;
          }
        }
      } catch (error) {
        void error;
      }
    }

    throw new Error("Field login/submission yang dibutuhkan tidak ditemukan.");
  }

  async fillOptional(page, attempts) {
    for (const attempt of attempts) {
      try {
        if (attempt.kind === "label") {
          const locator = page.getByLabel(attempt.target).first();
          if (await locator.count()) {
            await locator.fill(attempt.value);
            return true;
          }
        }

        if (attempt.kind === "selector") {
          const locator = page.locator(attempt.target).first();
          if (await locator.count()) {
            await locator.fill(attempt.value);
            return true;
          }
        }
      } catch (error) {
        void error;
      }
    }

    return false;
  }

  async clickFirst(page, attempts) {
    for (const attempt of attempts) {
      try {
        if (attempt.kind === "role") {
          const locator = page
            .getByRole(attempt.target.role, { name: attempt.target.name })
            .first();
          if (await locator.count()) {
            await locator.click();
            return true;
          }
        }

        if (attempt.kind === "selector") {
          const locator = page.locator(attempt.target).first();
          if (await locator.count()) {
            await locator.click();
            return true;
          }
        }
      } catch (error) {
        void error;
      }
    }

    throw new Error("Tombol aksi Turnitin tidak ditemukan.");
  }

  async listActions(page, patterns) {
    return page.evaluate(
      ({ clickableSelector, regexSources }) => {
        const isVisible = (element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            rect.width > 0 &&
            rect.height > 0
          );
        };

        const isDisabled = (element) =>
          element.matches(":disabled") ||
          element.getAttribute("aria-disabled") === "true" ||
          element.classList.contains("disabled");

        const clean = (value) =>
          String(value || "")
            .replace(/\s+/g, " ")
            .trim();

        const getLines = (element) =>
          String(element.innerText || element.textContent || "")
            .split(/\n+/)
            .map((line) => clean(line))
            .filter(Boolean)
            .slice(0, 20);

        const findContainer = (element) => {
          let current = element;

          while (current && current !== document.body) {
            const tagName = current.tagName?.toLowerCase() || "";
            const className =
              typeof current.className === "string" ? current.className : "";
            const lines = getLines(current);
            const textLength = lines.join(" ").length;

            if (
              textLength >= 8 &&
              textLength <= 1400 &&
              (["tr", "li", "article", "section"].includes(tagName) ||
                /\b(row|card|item|assignment|class|list|entry|module)\b/i.test(
                  className
                ))
            ) {
              return current;
            }

            current = current.parentElement;
          }

          return element.parentElement || element;
        };

        const patterns = regexSources.map((source) => new RegExp(source, "i"));
        let index = 0;

        return [...document.querySelectorAll(clickableSelector)]
          .map((element) => {
            const label = clean(
              element.innerText ||
                element.value ||
                element.getAttribute("aria-label") ||
                element.getAttribute("title")
            );

            if (!label || !isVisible(element)) {
              return null;
            }

            if (patterns.length && !patterns.some((pattern) => pattern.test(label))) {
              return null;
            }

            const actionId = `codex-action-${Date.now().toString(36)}-${index++}`;
            element.setAttribute("data-codex-click-id", actionId);
            const container = findContainer(element);
            const containerLines = getLines(container);

            return {
              actionId,
              label,
              href: element.href || null,
              disabled: isDisabled(element),
              containerText: containerLines.join("\n"),
              containerLines,
            };
          })
          .filter(Boolean);
      },
      {
        clickableSelector: CLICKABLE_SELECTOR,
        regexSources: patterns.map((pattern) => pattern.source || String(pattern)),
      }
    );
  }

  async listClassRows(page) {
    return page.evaluate(() => {
      const clean = (value) =>
        String(value || "")
          .replace(/\s+/g, " ")
          .trim();

      const toAbsolute = (href) => new URL(href, window.location.href).toString();
      const seen = new Set();
      const rows = [];

      for (const row of document.querySelectorAll("tr")) {
        const link =
          row.querySelector('td.class_name a[href]') ||
          row.querySelector('a[href*="/class/"][href*="student_home"]');
        if (!link) {
          continue;
        }

        const href = toAbsolute(link.getAttribute("href"));
        if (seen.has(href)) {
          continue;
        }

        const name = clean(link.textContent);
        const rowText = clean(row.innerText || row.textContent);
        if (!name) {
          continue;
        }

        seen.add(href);
        rows.push({ name, href, rowText });
      }

      return rows;
    });
  }

  async clickAction(page, actionId) {
    const locator = page.locator(`[data-codex-click-id="${actionId}"]`).first();
    if (!(await locator.count())) {
      throw new Error("Aksi Turnitin tidak bisa diklik lagi. DOM kemungkinan berubah.");
    }

    await locator.click();
    await page.waitForLoadState("domcontentloaded").catch(() => null);
    await page.waitForTimeout(500);
  }

  async readScopeText(scope) {
    return normalizeWhitespace(
      await scope
        .locator("body")
        .innerText()
        .catch(() => "")
    );
  }

  async hasFileInput(scope) {
    const count = await scope.locator('input[type="file"]').count().catch(() => 0);
    return count > 0;
  }

  async hasUploadSurface(scope) {
    if (await this.hasFileInput(scope)) {
      return true;
    }

    const text = await this.readScopeText(scope).catch(() => "");
    return /\b(file upload|upload and review|submission title|choose from this computer|browse)\b/i.test(
      text
    );
  }

  async hasResubmissionConfirmation(page) {
    const text = await this.readScopeText(page).catch(() => "");
    return /confirm resubmission/i.test(text);
  }

  async confirmResubmission(page) {
    await this.clickFirst(page, [
      { kind: "selector", target: 'button[id^="upload_type-"]' },
      { kind: "role", target: { role: "button", name: /^confirm$/i } },
      { kind: "role", target: { role: "button", name: /^yes$/i } },
    ]);
    await page.waitForTimeout(1200).catch(() => null);
  }

  async waitForUploadScope(page, onLog = noop, options = {}) {
    const timeoutMs = options.timeoutMs ?? 30 * 1000;
    const deadline = Date.now() + timeoutMs;
    let resubmissionLogged = false;

    while (Date.now() < deadline) {
      if (await this.hasResubmissionConfirmation(page)) {
        if (!resubmissionLogged) {
          onLog("Modal Confirm Resubmission muncul, klik Confirm lalu lanjut ke form upload.");
          resubmissionLogged = true;
        }
        await this.confirmResubmission(page).catch(() => null);
      }

      const uploadFrame = await this.waitForUploadFrame(page, 1000);
      if (uploadFrame && (await this.hasUploadSurface(uploadFrame))) {
        onLog("Form upload ditemukan di iframe modal Turnitin.");
        await uploadFrame.waitForLoadState("domcontentloaded").catch(() => null);
        await uploadFrame.waitForTimeout(1000).catch(() => null);
        return uploadFrame;
      }

      if (await this.hasUploadSurface(page)) {
        onLog("Form upload ditemukan langsung di halaman Turnitin.");
        await page.waitForLoadState("domcontentloaded").catch(() => null);
        await page.waitForTimeout(1000).catch(() => null);
        return page;
      }

      await page.waitForTimeout(500).catch(() => null);
    }

    return null;
  }

  async openUploadDialog(page, onLog = noop) {
    const uploadStartPatterns = [
      /upload submission/i,
      /submit paper/i,
      /start submission/i,
      /file upload/i,
      /upload a paper/i,
    ];

    const uploadStartActions = await this.waitForActions(page, uploadStartPatterns, {
      enabledOnly: true,
      timeoutMs: 15 * 1000,
    }).catch(() => []);
    if (!uploadStartActions.length) {
      return null;
    }

    const preferredAction = this.pickAction(uploadStartActions, [
      /upload submission/i,
      /submit paper/i,
      /upload a paper/i,
      /start submission/i,
      /file upload/i,
    ]);
    onLog("Membuka modal upload Turnitin.");
    await this.clickAction(page, preferredAction.actionId);
    await page.waitForTimeout(1200);
    return this.waitForUploadScope(page, onLog, { timeoutMs: 25 * 1000 });
  }

  async waitForActions(page, patterns, options = {}) {
    const enabledOnly = options.enabledOnly ?? false;
    const timeoutMs = options.timeoutMs ?? 10 * 1000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const actions = await this.listActions(page, patterns).catch(() => []);
      const filtered = enabledOnly
        ? actions.filter((action) => !action.disabled)
        : actions;

      if (filtered.length) {
        return filtered;
      }

      await page.waitForTimeout(500).catch(() => null);
    }

    return [];
  }

  async waitForUploadFrame(page, timeoutMs = 20 * 1000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const frame = page
        .frames()
        .find(
          (candidate) =>
            /t_submit\.asp|submit/i.test(candidate.url()) ||
            /upload-modal-iframe/i.test(candidate.name())
        );

      if (frame && frame.url() && frame.url() !== "about:blank") {
        return frame;
      }

      await page.waitForTimeout(500);
    }

    return null;
  }

  async withTimeout(promise, timeoutMs, message) {
    let timeoutHandle;

    return Promise.race([
      promise.finally(() => {
        clearTimeout(timeoutHandle);
      }),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  }

  pickAction(actions, patterns) {
    for (const pattern of patterns) {
      const match = actions.find((action) => pattern.test(action.label));
      if (match) {
        return match;
      }
    }

    return actions[0];
  }

  async waitForLoginSurface(page, onLog) {
    const deadline = Date.now() + this.config.loginSurfaceTimeoutMs;
    let challengeLogged = false;

    while (Date.now() < deadline) {
      if (await this.hasLoginFields(page)) {
        return;
      }

      const html = await page.content().catch(() => "");
      const bodyText = await this.readBodyText(page);
      const hasChallenge = /AwsWafIntegration|challenge-container|not a robot|verify that you're not a robot/i.test(
        `${html}\n${bodyText}`
      );

      if (hasChallenge && !challengeLogged) {
        onLog("Menunggu AWS WAF challenge Turnitin selesai.");
        challengeLogged = true;
      }

      await page.waitForTimeout(2500);
    }

    throw new Error("Halaman login Turnitin tidak siap setelah menunggu challenge.");
  }

  async openLoginPage(page, onLog = noop) {
    const attempts = Math.max(Number(this.config.loginBootstrapRetries) || 1, 1);

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await page.goto(this.config.loginUrl, {
          waitUntil: "domcontentloaded",
        });
        await this.waitForLoginSurface(page, onLog);
        return;
      } catch (error) {
        if (attempt >= attempts || !this.isRetryableLoginBootstrapError(error)) {
          throw error;
        }

        const reason = this.isTransientNavigationError(error)
          ? "navigasi login bermasalah"
          : "permukaan login belum siap";
        onLog(
          `Halaman login Turnitin akan dicoba ulang karena ${reason} (${attempt + 1}/${attempts}).`
        );
        await page.waitForTimeout(this.config.navigationRetryDelayMs * attempt).catch(
          () => null
        );
      }
    }
  }

  isTransientNavigationError(error) {
    const message = String(error?.message || error || "");
    return (
      /ERR_CONNECTION_RESET/i.test(message) ||
      /ERR_CONNECTION_CLOSED/i.test(message) ||
      /ERR_CONNECTION_ABORTED/i.test(message) ||
      /ERR_NETWORK_CHANGED/i.test(message) ||
      /ERR_HTTP2_PROTOCOL_ERROR/i.test(message) ||
      /ERR_TIMED_OUT/i.test(message) ||
      /Navigation timeout/i.test(message)
    );
  }

  isRetryableLoginBootstrapError(error) {
    const message = String(error?.message || error || "");
    return (
      this.isTransientNavigationError(message) ||
      /Halaman login Turnitin tidak siap setelah menunggu challenge\./i.test(message)
    );
  }

  async hasLoginFields(page) {
    const selectors = [
      'input[type="email"]',
      'input[type="password"]',
      'input[name*="email" i]',
      'input[id*="email" i]',
      'input[name*="pass" i]',
      'input[id*="pass" i]',
    ];

    for (const selector of selectors) {
      const count = await page.locator(selector).count().catch(() => 0);
      if (count) {
        return true;
      }
    }

    return false;
  }

  async isLoginSurface(page) {
    const currentUrl = String(page?.url?.() || "");
    if (/login_page|signin|login/i.test(currentUrl)) {
      return true;
    }

    return this.hasLoginFields(page);
  }

  async buildDebugPayload(page) {
    const bodyLocator = page.locator("body");
    const bodyText = await bodyLocator.innerText().catch(() => "");
    const inputs = await page
      .locator("input,button,select,textarea")
      .evaluateAll((elements) =>
        elements.map((element) => ({
          tag: element.tagName.toLowerCase(),
          type: element.getAttribute("type"),
          name: element.getAttribute("name"),
          id: element.getAttribute("id"),
          value: element.getAttribute("value"),
          placeholder: element.getAttribute("placeholder"),
          ariaLabel: element.getAttribute("aria-label"),
          text: String(element.innerText || "").replace(/\s+/g, " ").trim().slice(0, 160),
        }))
      )
      .catch(() => []);
    const links = await page
      .locator("a[href]")
      .evaluateAll((elements) =>
        elements.map((element) => ({
          text: String(element.innerText || element.textContent || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 160),
          href: element.href,
          title: element.getAttribute("title"),
        }))
      )
      .catch(() => []);
    const forms = await page
      .locator("form")
      .evaluateAll((elements) =>
        elements.map((element) => ({
          action: element.getAttribute("action"),
          method: element.getAttribute("method"),
          enctype: element.getAttribute("enctype"),
          text: String(element.innerText || element.textContent || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 600),
        }))
      )
      .catch(() => []);

    return {
      url: page.url(),
      title: await page.title().catch(() => ""),
      bodyText: normalizeWhitespace(bodyText).slice(0, 6000),
      inputs,
      links,
      forms,
      frames:
        typeof page.frames === "function"
          ? page.frames().map((frame) => ({
              name: frame.name(),
              url: frame.url(),
            }))
          : [],
    };
  }

  async captureDebugSnapshot(page, prefix, options = {}) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const screenshotPath = path.join(
      this.config.storage.runtimeDir,
      `${prefix}-${stamp}.png`
    );
    const htmlPath = path.join(this.config.storage.runtimeDir, `${prefix}-${stamp}.html`);
    const jsonPath = path.join(this.config.storage.runtimeDir, `${prefix}-${stamp}.json`);

    await fs.mkdir(this.config.storage.runtimeDir, { recursive: true });
    const screenshotTarget =
      typeof page.screenshot === "function"
        ? page
        : typeof page.page === "function"
          ? page.page()
          : null;
    if (screenshotTarget) {
      await screenshotTarget
        .screenshot({ path: screenshotPath, fullPage: true })
        .catch(() => null);
    }
    await fs.writeFile(htmlPath, await page.content().catch(() => ""));
    if (options.includeJson) {
      await fs.writeFile(
        jsonPath,
        JSON.stringify(await this.buildDebugPayload(page), null, 2)
      ).catch(() => null);
    }

    return {
      screenshotPath,
      htmlPath,
      jsonPath: options.includeJson ? jsonPath : null,
    };
  }
}

module.exports = {
  TurnitinAutomation,
};
