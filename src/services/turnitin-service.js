const path = require("path");
const { readAccounts, maskEmail } = require("./accounts");
const { TurnitinAutomation } = require("./turnitin-automation");
const { hasCurrentViewPdf } = require("./report-links");

function noop() {}
const DEFAULT_CURRENT_VIEW_FOLLOW_UP_ATTEMPT_MS = 5 * 60 * 1000;

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

function sleepWithSignal(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
      resolve();
    }, Math.max(0, Number(ms) || 0));

    let abortListener = null;
    if (signal) {
      abortListener = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abortListener);
        reject(normalizeAbortReason(signal.reason));
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }
  });
}

function shouldFollowUpSubmission(result = {}) {
  if (result.status !== "submitted") {
    return false;
  }

  return !hasCurrentViewPdf(result);
}

function mergeFollowUpSubmissionResult(result = {}, followUp = {}) {
  return {
    ...result,
    finishedAt: new Date().toISOString(),
    dashboardSimilarity:
      followUp.dashboardSimilarity ||
      result.dashboardSimilarity ||
      result.similarity ||
      null,
    currentViewSimilarity: followUp.currentViewSimilarity || result.currentViewSimilarity || null,
    similarity: followUp.similarity || result.similarity,
    similarityStatus: followUp.similarityStatus || result.similarityStatus,
    reportUrl: followUp.reportUrl || result.reportUrl,
    studioUrl: followUp.studioUrl || result.studioUrl,
    artifacts: {
      ...(result.artifacts || {}),
      ...(followUp.artifacts || {}),
    },
    reportOptions: followUp.reportOptions || result.reportOptions,
  };
}

class TurnitinService {
  constructor({ config, stateStore }) {
    this.config = config;
    this.stateStore = stateStore;
    this.automation = new TurnitinAutomation(config);
    this.accountClaims = new Map();
    this.accountAvailabilityWaiters = [];
  }

  async getAccounts() {
    return readAccounts(this.config.accountsFile);
  }

  summarizeAccountsForJobs(accounts = []) {
    const summaries = this.stateStore?.projectAccountSummaries
      ? this.stateStore.projectAccountSummaries(accounts)
      : [];
    const summaryByEmail = new Map(
      summaries.map((summary) => [summary.accountEmail, summary])
    );

    return accounts.map((account, index) => {
      const summary = summaryByEmail.get(account.email) || null;
      return {
        account,
        index,
        availability: this.getAccountJobAvailability(summary),
      };
    });
  }

  getAccountJobAvailability(summary) {
    if (!summary || !summary.scannedAt) {
      return "unknown";
    }

    const classes = Array.isArray(summary.classes) ? summary.classes : [];
    if (!classes.length) {
      return summary.lastError ? "unknown" : "exhausted";
    }

    const selectionHints = this.stateStore?.getSelectionHints
      ? this.stateStore.getSelectionHints(summary.accountEmail)
      : { classes: {} };
    const hasUsableAssignment = classes.some((classItem) => {
      const classHint = selectionHints.classes?.[classItem.name] || null;
      const orderedAssignments = this.automation.orderAssignmentsForSelection(
        classItem.assignments || [],
        classHint
      );

      return orderedAssignments.some((assignment) => {
        const history = classHint?.assignments?.[assignment.key] || {};
        return !this.automation.hasReachedAssignmentRetryLimit(history);
      });
    });

    return hasUsableAssignment ? "usable" : "exhausted";
  }

  rankAccountsForJobs(accounts = []) {
    const rank = {
      usable: 2,
      unknown: 1,
      exhausted: 0,
    };

    return this.summarizeAccountsForJobs(accounts)
      .sort(
        (left, right) =>
          rank[right.availability] - rank[left.availability] || left.index - right.index
      )
      .map((entry) => entry.account);
  }

  async getMaxConcurrency() {
    const accounts = await this.getAccounts().catch(() => []);
    const accountCount = Math.max(1, accounts.length || 0);
    const configuredCap = Number(this.config.maxConcurrentJobs || 0);
    if (configuredCap > 0) {
      return Math.max(1, Math.min(configuredCap, accountCount));
    }

    return accountCount;
  }

  async scanAllAccounts(onLog = noop) {
    const accounts = await this.getAccounts();
    const summaries = new Array(accounts.length);
    const concurrency = Math.max(
      1,
      Math.min(Number(this.config.scanConcurrency) || 2, accounts.length || 1)
    );
    let nextIndex = 0;

    const runWorker = async () => {
      while (nextIndex < accounts.length) {
        const index = nextIndex;
        nextIndex += 1;
        const account = accounts[index];
        const masked = maskEmail(account.email);
        onLog(`Scan akun ${masked}`);

        try {
          summaries[index] = await this.automation.scanAccount(account, onLog);
        } catch (error) {
          summaries[index] = {
            accountEmail: account.email,
            scannedAt: new Date().toISOString(),
            totals: {
              classes: 0,
              assignments: 0,
              available: 0,
              used: 0,
            },
            classes: [],
            lastError: error.message,
          };
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => runWorker()));

    await this.stateStore.setAccountSummaries(summaries);
    return summaries;
  }

  getAssignmentUsageLimits() {
    return {
      maxAttemptsPerAssignment: Number(this.config.maxAttemptsPerAssignment) || 0,
      maxSubmissionsPerAssignment: Number(this.config.maxSubmissionsPerAssignment) || 0,
    };
  }

  buildAssignmentUsage(assignment = {}, history = {}) {
    const attemptCount = Number(
      history.attemptCount !== undefined ? history.attemptCount : assignment.attemptCount || 0
    );
    const successCount = Number(
      history.successCount !== undefined ? history.successCount : assignment.successCount || 0
    );
    const failureCount = Number(
      history.failureCount !== undefined ? history.failureCount : assignment.failureCount || 0
    );
    const limits = this.getAssignmentUsageLimits();
    const remainingAttempts = Math.max(0, limits.maxAttemptsPerAssignment - attemptCount);
    const remainingSubmissions = Math.max(0, limits.maxSubmissionsPerAssignment - successCount);
    const retryLimitReached = this.automation.hasReachedAssignmentRetryLimit({ attemptCount });
    const usageLimitReached = this.automation.hasReachedAssignmentUsageLimit({ successCount });
    const isRepositoryExcluded = this.automation.isRepositorySavingAssignment(assignment);
    const dashboardStatus = assignment.status || "unknown";
    const hasLocalUsage = successCount > 0;
    const hasContent = dashboardStatus === "used" || hasLocalUsage;
    const canSubmitNow =
      !isRepositoryExcluded && !retryLimitReached && !usageLimitReached;
    const canResubmitNow = canSubmitNow && hasContent;

    let effectiveStatus = "unknown";
    if (isRepositoryExcluded) {
      effectiveStatus = "repository-excluded";
    } else if (!hasContent && dashboardStatus === "available") {
      effectiveStatus = canSubmitNow ? "empty" : "blocked-empty";
    } else if (hasContent) {
      effectiveStatus = canSubmitNow ? "used-reusable" : "used-exhausted";
    }

    return {
      dashboardStatus,
      dashboardSimilarity: assignment.similarity || null,
      hasContent,
      hasLocalUsage,
      isRepositoryExcluded,
      canSubmitNow,
      canResubmitNow,
      recommendedAction: canSubmitNow ? (hasContent ? "resubmit" : "submit") : "skip",
      effectiveStatus,
      attemptCount,
      successCount,
      failureCount,
      remainingAttempts,
      remainingSubmissions,
      retryLimitReached,
      usageLimitReached,
      lastAttemptStatus:
        history.lastAttemptStatus !== undefined
          ? history.lastAttemptStatus
          : assignment.lastAttemptStatus || null,
      lastAttemptAt:
        history.lastAttemptAt !== undefined
          ? history.lastAttemptAt
          : assignment.lastAttemptAt || assignment.lastSubmittedAt || null,
      lastJobId:
        history.lastJobId !== undefined ? history.lastJobId : assignment.lastJobId || null,
      limits,
    };
  }

  summarizeAssignmentUsage(assignments = []) {
    return assignments.reduce(
      (totals, assignment) => {
        totals.totalAssignments += 1;
        totals.localAttempts += Number(assignment.usage?.attemptCount || 0);
        totals.localSuccesses += Number(assignment.usage?.successCount || 0);
        totals.localFailures += Number(assignment.usage?.failureCount || 0);

        switch (assignment.usage?.effectiveStatus) {
          case "empty":
            totals.emptyAssignments += 1;
            break;
          case "blocked-empty":
            totals.blockedEmptyAssignments += 1;
            break;
          case "used-reusable":
            totals.reusableAssignments += 1;
            break;
          case "used-exhausted":
            totals.exhaustedAssignments += 1;
            break;
          case "repository-excluded":
            totals.repositoryExcludedAssignments += 1;
            break;
          default:
            totals.unknownAssignments += 1;
            break;
        }

        if (assignment.usage?.canSubmitNow) {
          totals.submittableAssignments += 1;
        }

        if (assignment.usage?.canResubmitNow) {
          totals.resubmittableAssignments += 1;
        }

        return totals;
      },
      {
        totalAssignments: 0,
        emptyAssignments: 0,
        blockedEmptyAssignments: 0,
        reusableAssignments: 0,
        exhaustedAssignments: 0,
        repositoryExcludedAssignments: 0,
        unknownAssignments: 0,
        submittableAssignments: 0,
        resubmittableAssignments: 0,
        localAttempts: 0,
        localSuccesses: 0,
        localFailures: 0,
      }
    );
  }

  enrichAccountSummary(summary = null) {
    if (!summary) {
      return null;
    }

    const selectionHints = this.stateStore?.getSelectionHints
      ? this.stateStore.getSelectionHints(summary.accountEmail)
      : { classes: {} };

    const classes = (summary.classes || []).map((classItem) => {
      const classHint = selectionHints.classes?.[classItem.name] || null;
      const assignments = (classItem.assignments || []).map((assignment) => {
        const history = classHint?.assignments?.[assignment.key] || assignment;
        return {
          ...assignment,
          usage: this.buildAssignmentUsage(assignment, history),
        };
      });

      return {
        ...classItem,
        assignments,
        usageTotals: this.summarizeAssignmentUsage(assignments),
      };
    });

    return {
      ...summary,
      classes,
      availability: this.getAccountJobAvailability(summary),
      usageTotals: this.summarizeAssignmentUsage(
        classes.flatMap((classItem) => classItem.assignments || [])
      ),
    };
  }

  enrichAccountSummaries(summaries = []) {
    return (summaries || []).map((summary) => this.enrichAccountSummary(summary));
  }

  buildAccountUsageSummaries(accounts = []) {
    const summaries = this.stateStore?.projectAccountSummaries
      ? this.stateStore.projectAccountSummaries(accounts)
      : [];
    return this.enrichAccountSummaries(summaries);
  }

  getPoolAlertThresholds() {
    const poolAlerts = this.config.poolAlerts || {};
    return {
      enabled: poolAlerts.enabled !== false,
      usableAccountsThreshold: Math.max(
        0,
        Number(poolAlerts.usableAccountsThreshold) || 0
      ),
      submittableAssignmentsThreshold: Math.max(
        0,
        Number(poolAlerts.submittableAssignmentsThreshold) || 0
      ),
    };
  }

  summarizePoolUsage(summaries = []) {
    return (summaries || []).reduce(
      (totals, summary) => {
        const usageTotals = summary.usageTotals || {};
        totals.accountCount += 1;
        totals.totalAssignments += Number(usageTotals.totalAssignments || 0);
        totals.submittableAssignments += Number(usageTotals.submittableAssignments || 0);
        totals.resubmittableAssignments += Number(usageTotals.resubmittableAssignments || 0);
        totals.emptyAssignments += Number(usageTotals.emptyAssignments || 0);
        totals.exhaustedAssignments += Number(usageTotals.exhaustedAssignments || 0);
        totals.repositoryExcludedAssignments += Number(
          usageTotals.repositoryExcludedAssignments || 0
        );
        totals.unknownAssignments += Number(usageTotals.unknownAssignments || 0);

        switch (String(summary.availability || "unknown").trim().toLowerCase()) {
          case "usable":
            totals.usableAccounts += 1;
            break;
          case "exhausted":
            totals.exhaustedAccounts += 1;
            break;
          default:
            totals.unknownAccounts += 1;
            break;
        }

        return totals;
      },
      {
        accountCount: 0,
        usableAccounts: 0,
        exhaustedAccounts: 0,
        unknownAccounts: 0,
        totalAssignments: 0,
        submittableAssignments: 0,
        resubmittableAssignments: 0,
        emptyAssignments: 0,
        exhaustedAssignments: 0,
        repositoryExcludedAssignments: 0,
        unknownAssignments: 0,
      }
    );
  }

  buildPoolAlertSnapshot(accounts = []) {
    const summaries = this.buildAccountUsageSummaries(accounts);
    const totals = this.summarizePoolUsage(summaries);
    const thresholds = this.getPoolAlertThresholds();

    let level = "healthy";
    let headline = "Pool akun masih aman.";

    if (!totals.accountCount) {
      level = "critical";
      headline = "Tidak ada akun Turnitin yang terdaftar.";
    } else if (!totals.usableAccounts || !totals.submittableAssignments) {
      level = "critical";
      headline = "Pool akun hampir habis.";
    } else if (
      (thresholds.usableAccountsThreshold > 0 &&
        totals.usableAccounts <= thresholds.usableAccountsThreshold) ||
      (thresholds.submittableAssignmentsThreshold > 0 &&
        totals.submittableAssignments <= thresholds.submittableAssignmentsThreshold)
    ) {
      level = "warning";
      headline = "Pool akun mulai menipis.";
    }

    const summaryText = `${totals.usableAccounts}/${totals.accountCount} akun usable • ${totals.submittableAssignments} assignment siap • ${totals.resubmittableAssignments} slot resubmit`;
    const detailText =
      level === "healthy"
        ? `Pool masih aman. ${summaryText}.`
        : `${headline} ${summaryText}.`;

    return {
      level,
      headline,
      detailText,
      thresholds,
      totals,
      shouldNotifyAdmin: thresholds.enabled && level !== "healthy",
      generatedAt: new Date().toISOString(),
    };
  }

  async getPoolAlertSnapshot() {
    const accounts = await this.getAccounts().catch(() => []);
    return this.buildPoolAlertSnapshot(accounts);
  }

  findAssignmentInUsageSummaries(
    summaries = [],
    { accountEmail = null, className = null, assignmentKey = null, assignmentName = null } = {}
  ) {
    for (const summary of summaries || []) {
      if (accountEmail && summary.accountEmail !== accountEmail) {
        continue;
      }

      for (const classItem of summary.classes || []) {
        if (
          className &&
          String(classItem.name || "").trim().toLowerCase() !==
            String(className || "").trim().toLowerCase()
        ) {
          continue;
        }

        for (const assignment of classItem.assignments || []) {
          const keyMatches = assignmentKey && assignment.key === assignmentKey;
          const nameMatches =
            assignmentName &&
            String(assignment.name || "").trim().toLowerCase() ===
              String(assignmentName || "").trim().toLowerCase();
          if (!keyMatches && !nameMatches) {
            continue;
          }

          return {
            accountEmail: summary.accountEmail,
            className: classItem.name,
            assignment,
          };
        }
      }
    }

    return null;
  }

  attachLocalAssignmentContext(account, result = {}) {
    const usageSummaries = this.buildAccountUsageSummaries(account ? [account] : []);
    const localAssignment = this.findAssignmentInUsageSummaries(usageSummaries, {
      accountEmail: account?.email || null,
      className: result.selection?.className || result.query?.className || null,
      assignmentKey: result.selection?.assignmentKey || result.query?.assignmentKey || null,
      assignmentName: result.selection?.assignmentName || result.query?.assignmentName || null,
    });

    return {
      ...result,
      configuredLimits: this.getAssignmentUsageLimits(),
      localAssignment,
      localUsage: localAssignment?.assignment?.usage || null,
    };
  }

  async inspectNextAssignment({ accountIndex = 0, onLog = noop, openUpload = false } = {}) {
    const accounts = await this.getAccounts();
    const account = accounts[accountIndex];
    if (!account) {
      throw new Error(`Akun index ${accountIndex} tidak ditemukan.`);
    }

    const result = await this.automation.inspectNextAssignment(account, {
      onLog,
      openUpload,
      selectionHints: this.stateStore.getSelectionHints(account.email),
    });
    return this.attachLocalAssignmentContext(account, result);
  }

  async inspectAssignment({
    accountIndex = 0,
    className = null,
    assignmentKey = null,
    assignmentName = null,
    onLog = noop,
    openUpload = false,
  } = {}) {
    const accounts = await this.getAccounts();
    const account = accounts[accountIndex];
    if (!account) {
      throw new Error(`Akun index ${accountIndex} tidak ditemukan.`);
    }

    const result = await this.automation.inspectAssignment(account, {
      className,
      assignmentKey,
      assignmentName,
      onLog,
      openUpload,
    });
    return this.attachLocalAssignmentContext(account, result);
  }

  async claimAvailableAccount(
    accounts,
    { excludedEmails = new Set(), jobId = null, onLog = noop, signal = null } = {}
  ) {
    throwIfAborted(signal);
    const excluded = new Set(
      [...excludedEmails].map((value) => String(value || "").trim()).filter(Boolean)
    );
    if (!accounts.some((account) => !excluded.has(account.email))) {
      return null;
    }

    let waitLogged = false;

    while (true) {
      throwIfAborted(signal);
      const availableAccount = accounts.find(
        (account) => !excluded.has(account.email) && !this.accountClaims.has(account.email)
      );
      if (availableAccount) {
        this.accountClaims.set(availableAccount.email, {
          jobId,
          claimedAt: new Date().toISOString(),
        });
        return availableAccount;
      }

      if (!waitLogged) {
        onLog("Semua akun sedang dipakai job lain, tunggu slot akun kosong.");
        waitLogged = true;
      }

      await this.waitForAccountAvailability(signal);
    }
  }

  waitForAccountAvailability(signal = null) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          cleanup();
          resolve();
        },
      };
      const cleanup = () => {
        this.accountAvailabilityWaiters = this.accountAvailabilityWaiters.filter(
          (entry) => entry !== waiter
        );
        if (signal && abortListener) {
          signal.removeEventListener("abort", abortListener);
        }
      };
      let abortListener = null;
      if (signal) {
        abortListener = () => {
          cleanup();
          reject(normalizeAbortReason(signal.reason));
        };
        signal.addEventListener("abort", abortListener, { once: true });
      }
      this.accountAvailabilityWaiters.push(waiter);
    });
  }

  releaseClaimedAccount(accountEmail, jobId = null) {
    const claim = this.accountClaims.get(accountEmail);
    if (!claim) {
      return false;
    }

    if (jobId && claim.jobId && claim.jobId !== jobId) {
      return false;
    }

    this.accountClaims.delete(accountEmail);
    const waiters = this.accountAvailabilityWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.resolve();
    }
    return true;
  }

  getCurrentViewFollowUpAttemptMs(remainingMs = 0) {
    const configured = Number(this.config.currentViewFollowUpAttemptMs);
    const preferred =
      configured > 0 ? configured : DEFAULT_CURRENT_VIEW_FOLLOW_UP_ATTEMPT_MS;
    const remaining = Number(remainingMs);
    if (remaining > 0) {
      return Math.max(1000, Math.min(remaining, preferred));
    }

    return Math.max(15 * 1000, preferred);
  }

  getCurrentViewMaxAttempts() {
    return Math.max(1, Number(this.config.currentViewMaxAttempts) || 4);
  }

  async waitForCurrentViewPdfInSession({
    page,
    context,
    account,
    result,
    originalName,
    reportOptions,
    reportDir,
    onLog = noop,
    onProgress = noop,
    signal = null,
  }) {
    throwIfAborted(signal);
    let nextResult = { ...result };
    if (!shouldFollowUpSubmission(nextResult)) {
      return nextResult;
    }

    const totalWaitMs = Math.max(
      15 * 1000,
      Number(this.config.similarityFollowUpWaitMs) || 48 * 60 * 1000
    );
    const deadline = Date.now() + totalWaitMs;
    const maxAttempts = this.getCurrentViewMaxAttempts();
    let attempt = 0;

    while (
      shouldFollowUpSubmission(nextResult) &&
      Date.now() < deadline &&
      attempt < maxAttempts
    ) {
      throwIfAborted(signal);
      const remainingMs = deadline - Date.now();
      const waitTimeoutMs = this.getCurrentViewFollowUpAttemptMs(remainingMs);

      onLog(
        attempt === 0
          ? nextResult.similarityStatus === "pending"
            ? "Similarity belum tersedia dalam sesi awal, lanjut pantau assignment yang sama."
            : "Current View PDF belum tersedia dalam sesi awal, lanjut pantau assignment yang sama."
          : `Current View PDF belum tersedia, ulang cek assignment yang sama (${attempt + 1}).`
      );

      try {
        const followUp = await this.automation.resumePendingSubmissionInSession({
          page,
          context,
          account,
          classUrl: nextResult.classUrl,
          assignmentUrl: nextResult.assignmentUrl,
          className: nextResult.className,
          assignmentName: nextResult.assignmentName,
          originalName,
          reportOptions,
          reportDir,
          knownSimilarity: nextResult.similarity,
          knownReportUrl: nextResult.reportUrl,
          existingArtifacts: nextResult.artifacts || {},
          waitTimeoutMs,
          forceLogin: false,
          onLog,
        });

        nextResult = mergeFollowUpSubmissionResult(nextResult, followUp);
        onProgress(nextResult);
      } catch (error) {
        if (error?.name === "AbortError") {
          throw normalizeAbortReason(signal?.reason || error);
        }
        onLog(`Pemantauan lanjutan submission gagal: ${error.message}`);

        const pauseMs = Math.min(5000, Math.max(0, deadline - Date.now()));
        if (pauseMs > 0) {
          await sleepWithSignal(pauseMs, signal);
        }
      }

      attempt += 1;
    }

    if (shouldFollowUpSubmission(nextResult)) {
      if (attempt >= maxAttempts) {
        onLog(
          `Batas retry Current View PDF tercapai (${maxAttempts}x), job disimpan tanpa PDF Current View.`
        );
      } else {
        onLog("Batas tunggu Current View PDF habis, job disimpan tanpa PDF Current View.");
      }
    }

    return nextResult;
  }

  async waitForCurrentViewPdf({
    account,
    result,
    originalName,
    reportOptions,
    reportDir,
    onLog = noop,
    onProgress = noop,
    signal = null,
  }) {
    return this.automation.withAuthenticatedSession(account, onLog, ({ page, context }) =>
      this.waitForCurrentViewPdfInSession({
        page,
        context,
        account,
        result,
        originalName,
        reportOptions,
        reportDir,
        onLog,
        onProgress,
        signal,
      })
    , { signal });
  }

  async submitUsingPool({
    filePath,
    originalName,
    title,
    reportOptions,
    jobId,
    onLog = noop,
    onProgress = noop,
    signal = null,
  }) {
    throwIfAborted(signal);
    const accounts = this.rankAccountsForJobs(await this.getAccounts());
    const failures = [];
    const exhaustedAccounts = new Set();

    while (exhaustedAccounts.size < accounts.length) {
      throwIfAborted(signal);
      const account = await this.claimAvailableAccount(accounts, {
        excludedEmails: exhaustedAccounts,
        jobId,
        onLog,
        signal,
      });
      if (!account) {
        break;
      }

      let preferredSelection = null;

      try {
        while (true) {
          throwIfAborted(signal);
          onLog(
            preferredSelection
              ? `Coba ulang assignment ${preferredSelection.assignmentName} pada akun ${maskEmail(
                  account.email
                )}`
              : `Mencoba akun ${maskEmail(account.email)}`
          );

          try {
            const reportDir = path.join(this.config.storage.reportsDir, jobId);
            const selectionHints = this.stateStore.getSelectionHints(account.email);
            let result = await this.automation.withAuthenticatedSession(
              account,
              onLog,
              async ({ page, context }) => {
                throwIfAborted(signal);
                let submissionResult = await this.automation.submitWithAccountInSession({
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
                });

                preferredSelection = null;
                if (submissionResult.status === "submitted") {
                  onProgress(submissionResult);
                }

                submissionResult = await this.waitForCurrentViewPdfInSession({
                  page,
                  context,
                  account,
                  result: submissionResult,
                  originalName,
                  reportOptions,
                  reportDir,
                  onLog,
                  onProgress,
                  signal,
                });
                return submissionResult;
              },
              { signal }
            );

            if (result.accountSummary && result.accountSummary.partial === false) {
              await this.stateStore.setAccountSummary(result.accountSummary);
            }

            if (result.status === "submitted") {
              await this.stateStore.recordSubmission(result);
              return result;
            }

            onLog(`Akun ${maskEmail(account.email)} tidak punya assignment yang siap dipakai.`);
            break;
          } catch (error) {
            if (error?.name === "AbortError") {
              throw normalizeAbortReason(signal?.reason || error);
            }
            const assignmentContext = error.assignmentContext
              ? {
                  ...error.assignmentContext,
                  accountEmail: account.email,
                  jobId,
                  attemptedAt: new Date().toISOString(),
                }
              : null;

            if (assignmentContext) {
              const failureInfo = await this.stateStore.recordAssignmentFailure(
                assignmentContext
              );
              onLog(
                `Assignment ${assignmentContext.assignmentName} error: ${error.message}`
              );
              if (
                failureInfo &&
                failureInfo.attemptCount < this.config.maxAttemptsPerAssignment
              ) {
                preferredSelection = assignmentContext;
                onLog(
                  `Assignment ${assignmentContext.assignmentName} gagal, ulang assignment yang sama (${failureInfo.attemptCount}/${this.config.maxAttemptsPerAssignment}).`
                );
                continue;
              }

              if (failureInfo) {
                preferredSelection = null;
                onLog(
                  `Batas retry assignment ${assignmentContext.assignmentName} tercapai, lanjut ke assignment berikutnya pada akun yang sama.`
                );
                continue;
              }
            }

            failures.push(`${account.email}: ${error.message}`);
            onLog(`Error akun ${maskEmail(account.email)}: ${error.message}`);
            onLog(`Akun ${maskEmail(account.email)} gagal, lanjut ke akun berikutnya.`);
            break;
          }
        }
      } finally {
        exhaustedAccounts.add(account.email);
        this.releaseClaimedAccount(account.email, jobId);
      }
    }

    const detail = failures.length ? ` Detail: ${failures.join(" | ")}` : "";
    throw new Error(
      `Semua assignment pada semua akun terlihat sudah terpakai atau tidak bisa dipakai.${detail}`
    );
  }
}

module.exports = {
  TurnitinService,
};
