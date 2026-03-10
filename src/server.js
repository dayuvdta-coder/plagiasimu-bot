const fs = require("fs/promises");
const path = require("path");
const express = require("express");
const multer = require("multer");
const config = require("./config");
const { appendAccounts, parseAccountsFromText, removeAccount } = require("./services/accounts");
const { StateStore } = require("./services/state-store");
const { JobRunner, JobStore } = require("./services/job-runner");
const {
  buildPanelAuthState,
  createSessionToken,
  parseCookieHeader,
  safeEqualText,
  validateSessionToken,
} = require("./services/panel-auth");
const { TelegramBotService } = require("./services/telegram-bot");
const {
  pickCurrentViewUrl,
  sanitizeResultArtifacts,
} = require("./services/report-links");
const { PakasirPaymentService } = require("./services/pakasir-payment");
const { TurnitinService } = require("./services/turnitin-service");

async function ensureDirectories() {
  await fs.mkdir(config.storage.uploadsDir, { recursive: true });
  await fs.mkdir(config.storage.reportsDir, { recursive: true });
  await fs.mkdir(config.storage.runtimeDir, { recursive: true });
}

function parseReportOptions(body = {}) {
  const excludeMatchesWordCount = Number(body.excludeMatchesWordCount);
  return {
    excludeQuotes: body.excludeQuotes === "on" || body.excludeQuotes === "true",
    excludeBibliography:
      body.excludeBibliography === "on" || body.excludeBibliography === "true",
    excludeMatches: body.excludeMatches === "on" || body.excludeMatches === "true",
    excludeMatchesWordCount:
      Number.isInteger(excludeMatchesWordCount) && excludeMatchesWordCount > 0
        ? excludeMatchesWordCount
        : config.defaultExcludeMatchesWordCount,
  };
}

function normalizeUploadedFiles(req) {
  return Array.isArray(req.files) ? req.files.filter(Boolean) : [];
}

function buildPanelCookieOptions(panelAuth) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: panelAuth.secureCookie === true,
    maxAge: panelAuth.sessionTtlMs,
    path: "/",
  };
}

function buildPanelClearCookieOptions(panelAuth) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: panelAuth.secureCookie === true,
    path: "/",
  };
}

function buildSubmissionTitle({ requestedTitle = "", fileName = "", index = 0, total = 1 } = {}) {
  const normalizedTitle = String(requestedTitle || "").trim();
  if (!normalizedTitle) {
    return path.parse(fileName).name || "Turnitin Submission";
  }

  if (total <= 1) {
    return normalizedTitle;
  }

  return `${normalizedTitle} (${index + 1})`;
}

function mergeJobWithSubmission(job, submission) {
  if (!job && !submission) {
    return null;
  }

  if (!job && submission) {
    const artifacts = submission.artifacts || {};
    return {
      id: submission.jobId,
      status: "completed",
      createdAt: submission.finishedAt || new Date().toISOString(),
      updatedAt: submission.finishedAt || new Date().toISOString(),
      originalName: path.basename(artifacts.originalFile || ""),
      title: submission.assignmentName || `Job ${submission.jobId}`,
      reportOptions: submission.reportOptions || null,
      queuePosition: 0,
      logs: [],
      result: {
        ...submission,
        studioUrl: pickCurrentViewUrl(submission) || submission.studioUrl || null,
      },
      error: null,
    };
  }

  if (!submission) {
    return job;
  }

  const jobResult = job.result || {};
  const mergedArtifacts = {
    ...(jobResult.artifacts || {}),
    ...(submission.artifacts || {}),
  };

  return {
    ...job,
    reportOptions: job.reportOptions || submission.reportOptions || null,
    result: {
      ...jobResult,
      ...submission,
      artifacts: mergedArtifacts,
      studioUrl:
        pickCurrentViewUrl({
          studioUrl: submission.studioUrl || jobResult.studioUrl || null,
          reportUrl: submission.reportUrl || jobResult.reportUrl || null,
          artifacts: mergedArtifacts,
        }) ||
        submission.studioUrl ||
        jobResult.studioUrl ||
        null,
    },
  };
}

async function sanitizeSubmission(submission) {
  if (!submission) {
    return submission;
  }

  return sanitizeResultArtifacts(submission, {
    storageDir: config.storage.dir,
  });
}

async function sanitizeJob(job) {
  if (!job?.result) {
    return job;
  }

  return {
    ...job,
    result: await sanitizeResultArtifacts(job.result, {
      storageDir: config.storage.dir,
    }),
  };
}

async function sanitizeJobs(jobs = []) {
  return Promise.all((jobs || []).map((job) => sanitizeJob(job)));
}

async function sanitizeSubmissions(submissions = []) {
  return Promise.all((submissions || []).map((submission) => sanitizeSubmission(submission)));
}

async function buildAccountsUsageResponse({
  turnitinService,
  stateStore,
  refreshed = false,
  configuredAccounts = null,
  accountsFileError = null,
} = {}) {
  return {
    refreshed,
    accounts: configuredAccounts
      ? turnitinService.buildAccountUsageSummaries(configuredAccounts)
      : turnitinService.enrichAccountSummaries(stateStore.listAccountSummaries()),
    accountsFileError,
    recentSubmissions: await sanitizeSubmissions(stateStore.listRecentSubmissions()),
  };
}

function resolvePanelSession(req) {
  const panelAuth = req.app.locals.panelAuth;
  if (!panelAuth?.enabled) {
    return {
      username: panelAuth?.username || null,
      expiresAt: null,
    };
  }

  const cookies = parseCookieHeader(req.headers.cookie || "");
  const session = validateSessionToken(cookies[panelAuth.sessionCookieName], {
    username: panelAuth.username,
    secret: panelAuth.sessionSecret,
  });
  return session.valid ? session : null;
}

function requirePanelAuth(req, res, next) {
  const panelAuth = req.app.locals.panelAuth;
  const session = resolvePanelSession(req);
  if (!panelAuth?.enabled || session) {
    req.panelSession = session;
    return next();
  }

  return res.status(401).json({
    error: "Login diperlukan.",
    code: "AUTH_REQUIRED",
  });
}

async function main() {
  await ensureDirectories();

  const stateStore = new StateStore(config.storage.stateFile);
  await stateStore.init();
  const panelAuth = buildPanelAuthState(config);

  const turnitinService = new TurnitinService({
    config,
    stateStore,
  });
  const jobStore = new JobStore();
  const jobRunner = new JobRunner({
    jobStore,
    turnitinService,
    maxConcurrency: config.maxConcurrentJobs || 1,
    getMaxConcurrency: () => turnitinService.getMaxConcurrency(),
  });
  const pakasirPaymentService = new PakasirPaymentService({
    config,
  });
  const telegramBot = new TelegramBotService({
    config,
    jobRunner,
    stateStore,
    paymentService: pakasirPaymentService,
    turnitinService,
  });

  async function buildPoolAlertPayload() {
    return turnitinService.getPoolAlertSnapshot();
  }

  async function notifyAdminPoolAlert({ force = false } = {}) {
    if (!telegramBot?.canSendAdminAlerts?.()) {
      return null;
    }

    const poolAlert = await buildPoolAlertPayload();
    return telegramBot.notifyAdminPoolAlert(poolAlert, {
      force,
      runtime: {
        runningJobCount: jobRunner.runningCount,
        queuedJobCount: jobRunner.queuedCount,
      },
    });
  }

  const app = express();
  const upload = multer({
    dest: config.storage.uploadsDir,
    limits: {
      fileSize: config.maxFileBytes,
    },
  });

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.locals.panelAuth = panelAuth;

  app.post(config.pakasir.webhookPath, async (req, res) => {
    if (!telegramBot?.isPaymentEnabled?.()) {
      return res.status(404).json({
        error: "Webhook payment tidak aktif.",
      });
    }

    try {
      const result = await telegramBot.handlePakasirWebhook(req.body || {});
      return res.json({
        ok: true,
        result,
      });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error.message,
      });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    if (!panelAuth?.enabled) {
      return res.json({
        authenticated: true,
        username: panelAuth.username,
        disabled: true,
      });
    }

    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const valid =
      safeEqualText(username, panelAuth.username) &&
      safeEqualText(password, panelAuth.password);
    if (!valid) {
      return res.status(401).json({
        error: "Username atau password salah.",
        code: "AUTH_INVALID",
      });
    }

    const session = createSessionToken({
      username: panelAuth.username,
      secret: panelAuth.sessionSecret,
      ttlMs: panelAuth.sessionTtlMs,
    });
    res.cookie(panelAuth.sessionCookieName, session.token, buildPanelCookieOptions(panelAuth));
    return res.json({
      authenticated: true,
      username: panelAuth.username,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  });

  app.post("/api/auth/logout", (req, res) => {
    res.clearCookie(panelAuth.sessionCookieName, buildPanelClearCookieOptions(panelAuth));
    return res.json({
      authenticated: false,
    });
  });

  app.get("/api/auth/session", (req, res) => {
    const session = resolvePanelSession(req);
    return res.json({
      authenticated: Boolean(!panelAuth?.enabled || session),
      enabled: Boolean(panelAuth?.enabled),
      username: session?.username || (panelAuth?.enabled ? null : panelAuth.username),
      expiresAt: session?.expiresAt ? new Date(session.expiresAt).toISOString() : null,
    });
  });

  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/auth/")) {
      return next();
    }

    return requirePanelAuth(req, res, next);
  });

  app.use("/storage", requirePanelAuth, express.static(config.storage.dir));
  app.use(express.static(path.join(config.rootDir, "public")));

  app.get("/api/health", async (req, res) => {
    const accounts = await turnitinService.getAccounts().catch(() => []);
    const effectiveMaxConcurrentJobs = await turnitinService
      .getMaxConcurrency()
      .catch(() => Math.max(1, config.maxConcurrentJobs || 1));
    const poolAlert = await buildPoolAlertPayload().catch(() => null);
    res.json({
      ok: true,
      host: config.host,
      port: config.port,
      accountCount: accounts.length,
      runningJobId: jobRunner.runningJobId,
      runningJobIds: jobRunner.listRunningJobIds(),
      runningJobCount: jobRunner.runningCount,
      queuedJobCount: jobRunner.queuedCount,
      maxConcurrentJobs: effectiveMaxConcurrentJobs,
      configuredMaxConcurrentJobs: config.maxConcurrentJobs || "auto",
      lastPumpError: jobRunner.lastPumpError,
      pumpInFlight: Boolean(jobRunner.pumpInFlight),
      pumpStartedAt: jobRunner.pumpStartedAt,
      pumpSettledAt: jobRunner.pumpSettledAt,
      stalledPumpRecoveries: jobRunner.stalledPumpRecoveries,
      panelAuthEnabled: panelAuth.enabled,
      pakasirEnabled: pakasirPaymentService.isConfigured(),
      poolAlert,
    });
  });

  app.get("/api/accounts", async (req, res) => {
    const wantsRefresh = req.query.refresh === "1";
    if (wantsRefresh && jobRunner.isBusy()) {
      return res.status(409).json({
        error: "Scan tidak bisa jalan saat ada submission yang sedang diproses.",
      });
    }

    if (!wantsRefresh) {
      let configuredAccounts = null;
      let accountsFileError = null;
      try {
        configuredAccounts = await turnitinService.getAccounts();
      } catch (error) {
        accountsFileError = error.message;
      }

      return res.json(
        await buildAccountsUsageResponse({
          turnitinService,
          stateStore,
          refreshed: false,
          configuredAccounts,
          accountsFileError,
        })
      );
    }

    try {
      await turnitinService.scanAllAccounts();
      const configuredAccounts = await turnitinService.getAccounts();
      return res.json(
        await buildAccountsUsageResponse({
          turnitinService,
          stateStore,
          refreshed: true,
          configuredAccounts,
        })
      );
    } catch (error) {
      return res.status(500).json({
        error: error.message,
      });
    }
  });

  app.post("/api/accounts", async (req, res) => {
    const accountsText = String(req.body?.accountsText || "").trim();
    if (!accountsText) {
      return res.status(400).json({
        error: "Isi akun tidak boleh kosong.",
      });
    }

    try {
      const accountsToAdd = parseAccountsFromText(accountsText).map((account) => ({
        email: account.email,
        password: account.password,
      }));
      const mutation = await appendAccounts(config.accountsFile, accountsToAdd);
      const configuredAccounts = await turnitinService.getAccounts();
      return res.json({
        mutation,
        ...(await buildAccountsUsageResponse({
          turnitinService,
          stateStore,
          refreshed: false,
          configuredAccounts,
        })),
      });
    } catch (error) {
      return res.status(400).json({
        error: error.message,
      });
    }
  });

  app.delete("/api/accounts", async (req, res) => {
    const email = String(req.body?.email || "").trim();
    if (!email) {
      return res.status(400).json({
        error: "Email akun yang akan dihapus wajib diisi.",
      });
    }

    if (jobRunner.isBusy()) {
      return res.status(409).json({
        error: "Hapus akun ditunda dulu. Queue masih berjalan atau ada job yang menunggu.",
      });
    }

    try {
      const mutation = await removeAccount(config.accountsFile, email);
      const configuredAccounts = await turnitinService.getAccounts();
      return res.json({
        mutation,
        ...(await buildAccountsUsageResponse({
          turnitinService,
          stateStore,
          refreshed: false,
          configuredAccounts,
        })),
      });
    } catch (error) {
      return res.status(400).json({
        error: error.message,
      });
    }
  });

  app.get("/api/accounts/usage", async (req, res) => {
    const wantsRefresh = req.query.refresh === "1";
    if (wantsRefresh && jobRunner.isBusy()) {
      return res.status(409).json({
        error: "Scan tidak bisa jalan saat ada submission yang sedang diproses.",
      });
    }

    let configuredAccounts = null;
    let accountsFileError = null;
    try {
      configuredAccounts = await turnitinService.getAccounts();
    } catch (error) {
      accountsFileError = error.message;
    }

    try {
      if (wantsRefresh && configuredAccounts) {
        await turnitinService.scanAllAccounts();
      }

      return res.json({
        limits: turnitinService.getAssignmentUsageLimits(),
        ...(await buildAccountsUsageResponse({
          turnitinService,
          stateStore,
          refreshed: wantsRefresh,
          configuredAccounts,
          accountsFileError,
        })),
      });
    } catch (error) {
      return res.status(500).json({
        error: error.message,
      });
    }
  });

  app.get("/api/jobs", async (req, res) => {
    const effectiveMaxConcurrentJobs = await turnitinService
      .getMaxConcurrency()
      .catch(() => Math.max(1, config.maxConcurrentJobs || 1));
    const poolAlert = await buildPoolAlertPayload().catch(() => null);
    res.json({
      jobs: await sanitizeJobs(jobStore.list()),
      recentSubmissions: await sanitizeSubmissions(stateStore.listRecentSubmissions()),
      runningJobId: jobRunner.runningJobId,
      runningJobIds: jobRunner.listRunningJobIds(),
      runningJobCount: jobRunner.runningCount,
      queuedJobCount: jobRunner.queuedCount,
      maxConcurrentJobs: effectiveMaxConcurrentJobs,
      configuredMaxConcurrentJobs: config.maxConcurrentJobs || "auto",
      lastPumpError: jobRunner.lastPumpError,
      pumpInFlight: Boolean(jobRunner.pumpInFlight),
      pumpStartedAt: jobRunner.pumpStartedAt,
      pumpSettledAt: jobRunner.pumpSettledAt,
      stalledPumpRecoveries: jobRunner.stalledPumpRecoveries,
      poolAlert,
    });
  });

  app.get("/api/jobs/:id", async (req, res) => {
    const recentSubmission = stateStore
      .listRecentSubmissions()
      .find((submission) => submission.jobId === req.params.id);
    const job = mergeJobWithSubmission(jobStore.get(req.params.id), recentSubmission);
    if (!job) {
      return res.status(404).json({
        error: "Job tidak ditemukan.",
      });
    }

    return res.json(await sanitizeJob(job));
  });

  app.get("/api/debug/assignment", async (req, res) => {
    if (jobRunner.isBusy()) {
      return res.status(409).json({
        error: "Debug assignment tidak bisa jalan saat queue sedang aktif.",
      });
    }

    try {
      const accountIndex = Number(req.query.accountIndex || 0);
      const openUpload = req.query.openUpload === "1";
      const assignmentKey = String(req.query.assignmentKey || "").trim() || null;
      const assignmentName = String(req.query.assignmentName || "").trim() || null;
      const className = String(req.query.className || "").trim() || null;
      const result =
        assignmentKey || assignmentName
          ? await turnitinService.inspectAssignment({
              accountIndex,
              className,
              assignmentKey,
              assignmentName,
              openUpload,
            })
          : await turnitinService.inspectNextAssignment({
              accountIndex,
              openUpload,
            });
      return res.json(result);
    } catch (error) {
      return res.status(500).json({
        error: error.message,
      });
    }
  });

  app.post("/api/jobs", upload.array("document"), async (req, res) => {
    const uploadedFiles = normalizeUploadedFiles(req);
    if (!uploadedFiles.length) {
      return res.status(400).json({
        error: "File dokumen wajib diunggah.",
      });
    }

    const reportOptions = parseReportOptions(req.body);
    const requestedTitle = String(req.body.title || "").trim();
    const jobs = uploadedFiles.map((file, index) =>
      jobRunner.enqueue({
        filePath: file.path,
        originalName: file.originalname,
        title: buildSubmissionTitle({
          requestedTitle,
          fileName: file.originalname,
          index,
          total: uploadedFiles.length,
        }),
        reportOptions,
      })
    );

    await jobRunner.requestPump();

    if (jobs.length === 1) {
      return res.status(202).json(jobs[0]);
    }

    return res.status(202).json({
      accepted: jobs.length,
      jobs,
    });
  });

  app.get("*", (req, res) => {
    res.sendFile(path.join(config.rootDir, "public", "index.html"));
  });

  app.listen(config.port, config.host, () => {
    console.log(
      `Turnitin web automation listening on http://${config.host}:${config.port}`
    );
  });
  if (telegramBot.start()) {
    console.log("Telegram bot is active.");
  }

  if (config.poolAlerts?.enabled !== false) {
    const intervalMs = Math.max(15000, Number(config.poolAlerts?.pollIntervalMs) || 60000);
    setInterval(() => {
      void notifyAdminPoolAlert().catch((error) => {
        console.error(`Admin pool alert failed: ${error.message}`);
      });
    }, intervalMs);
    setTimeout(() => {
      void buildPoolAlertPayload()
        .then((poolAlert) => {
          if (!poolAlert?.shouldNotifyAdmin) {
            return null;
          }

          return notifyAdminPoolAlert({ force: true });
        })
        .catch((error) => {
          console.error(`Initial admin pool alert failed: ${error.message}`);
        });
    }, 5000);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
