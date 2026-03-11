const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const storageDir = path.join(rootDir, "storage");
const inferredUserHome = rootDir.startsWith("/home/")
  ? rootDir.split(path.sep).slice(0, 3).join(path.sep)
  : process.env.HOME || rootDir;
const configuredCurrentViewExportPath = process.env.TURNITIN_CURRENT_VIEW_EXPORT_PATH || "";
const defaultCurrentViewExportDir = path.join(inferredUserHome, "Videos");

function numberFromEnv(name, fallback) {
  const value = process.env[name];
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanFromEnv(name, fallback = false) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (!value) {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }

  return fallback;
}

function concurrencyCapFromEnv(name) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (!value || value === "auto") {
    return 0;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }

  return Math.floor(parsed);
}

function listFromEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function defaultChromiumSandboxEnabled() {
  if (typeof process.getuid !== "function") {
    return true;
  }

  try {
    return process.getuid() !== 0;
  } catch (error) {
    return true;
  }
}

module.exports = {
  rootDir,
  host: process.env.HOST || "127.0.0.1",
  port: numberFromEnv("PORT", 3000),
  loginUrl:
    process.env.TURNITIN_LOGIN_URL ||
    "https://www.turnitin.com/login_page.asp?lang=en_us",
  accountsFile:
    process.env.TURNITIN_ACCOUNTS_FILE || path.join(rootDir, "akun turnitin"),
  headless: process.env.TURNITIN_HEADLESS !== "false",
  scanCacheMs: numberFromEnv("TURNITIN_SCAN_CACHE_MS", 10 * 60 * 1000),
  similarityWaitMs: numberFromEnv(
    "TURNITIN_SIMILARITY_WAIT_MS",
    12 * 60 * 1000
  ),
  similarityPollIntervalMs: numberFromEnv(
    "TURNITIN_SIMILARITY_POLL_INTERVAL_MS",
    5 * 1000
  ),
  similarityFollowUpWaitMs: numberFromEnv(
    "TURNITIN_SIMILARITY_FOLLOW_UP_WAIT_MS",
    48 * 60 * 1000
  ),
  currentViewFollowUpAttemptMs: numberFromEnv(
    "TURNITIN_CURRENT_VIEW_FOLLOW_UP_ATTEMPT_MS",
    5 * 60 * 1000
  ),
  currentViewMaxAttempts: Math.max(
    1,
    numberFromEnv("TURNITIN_CURRENT_VIEW_MAX_ATTEMPTS", 4)
  ),
  currentViewMenuTimeoutMs: numberFromEnv(
    "TURNITIN_CURRENT_VIEW_MENU_TIMEOUT_MS",
    6 * 1000
  ),
  currentViewQueueTimeoutMs: numberFromEnv(
    "TURNITIN_CURRENT_VIEW_QUEUE_TIMEOUT_MS",
    90 * 1000
  ),
  currentViewDownloadTimeoutMs: numberFromEnv(
    "TURNITIN_CURRENT_VIEW_DOWNLOAD_TIMEOUT_MS",
    120 * 1000
  ),
  loginBootstrapRetries: numberFromEnv("TURNITIN_LOGIN_BOOTSTRAP_RETRIES", 3),
  loginSurfaceTimeoutMs: numberFromEnv(
    "TURNITIN_LOGIN_SURFACE_TIMEOUT_MS",
    90 * 1000
  ),
  navigationRetryDelayMs: numberFromEnv(
    "TURNITIN_NAVIGATION_RETRY_DELAY_MS",
    3 * 1000
  ),
  reportArtifactsWaitMs: numberFromEnv(
    "TURNITIN_REPORT_ARTIFACTS_WAIT_MS",
    30 * 1000
  ),
  reportArtifactsRefreshMs: numberFromEnv(
    "TURNITIN_REPORT_ARTIFACTS_REFRESH_MS",
    5 * 1000
  ),
  maxConcurrentJobs: concurrencyCapFromEnv("TURNITIN_MAX_CONCURRENT_JOBS"),
  maxAttemptsPerAssignment: numberFromEnv(
    "TURNITIN_MAX_ATTEMPTS_PER_ASSIGNMENT",
    2
  ),
  maxSubmissionsPerAssignment: numberFromEnv(
    "TURNITIN_MAX_SUBMISSIONS_PER_ASSIGNMENT",
    2
  ),
  scanConcurrency: Math.max(1, numberFromEnv("TURNITIN_SCAN_CONCURRENCY", 2)),
  defaultExcludeMatchesWordCount: numberFromEnv(
    "TURNITIN_EXCLUDE_MATCHES_WORD_COUNT",
    10
  ),
  poolAlerts: {
    enabled: booleanFromEnv("TURNITIN_POOL_ALERT_ENABLED", true),
    usableAccountsThreshold: Math.max(
      0,
      numberFromEnv("TURNITIN_POOL_ALERT_USABLE_ACCOUNTS_THRESHOLD", 2)
    ),
    submittableAssignmentsThreshold: Math.max(
      0,
      numberFromEnv("TURNITIN_POOL_ALERT_SUBMITTABLE_ASSIGNMENTS_THRESHOLD", 6)
    ),
    pollIntervalMs: Math.max(
      15000,
      numberFromEnv("TURNITIN_POOL_ALERT_POLL_INTERVAL_MS", 60000)
    ),
  },
  browserTimeoutMs: numberFromEnv("TURNITIN_BROWSER_TIMEOUT_MS", 45 * 1000),
  chromiumSandbox: booleanFromEnv(
    "TURNITIN_CHROMIUM_SANDBOX",
    defaultChromiumSandboxEnabled()
  ),
  maxFileBytes: numberFromEnv("TURNITIN_MAX_FILE_MB", 50) * 1024 * 1024,
  uiLanguageLabel: process.env.TURNITIN_LANGUAGE_LABEL || "English (US)",
  storage: {
    dir: storageDir,
    uploadsDir: path.join(storageDir, "uploads"),
    reportsDir: path.join(storageDir, "reports"),
    runtimeDir: path.join(storageDir, "runtime"),
    stateFile: path.join(storageDir, "state.json"),
    currentViewExportDir:
      process.env.TURNITIN_CURRENT_VIEW_EXPORT_DIR ||
      (configuredCurrentViewExportPath
        ? path.dirname(configuredCurrentViewExportPath)
        : defaultCurrentViewExportDir),
    currentViewLatestExportPath: configuredCurrentViewExportPath || null,
  },
  telegram: {
    botToken: String(process.env.TELEGRAM_BOT_TOKEN || "").trim(),
    enabled:
      booleanFromEnv("TELEGRAM_BOT_ENABLED", true) &&
      Boolean(String(process.env.TELEGRAM_BOT_TOKEN || "").trim()),
    allowedChatIds: listFromEnv("TELEGRAM_ALLOWED_CHAT_IDS"),
    restrictGeneralAccess: booleanFromEnv("TELEGRAM_RESTRICT_GENERAL_ACCESS", false),
    adminChatIds: listFromEnv("TELEGRAM_ADMIN_CHAT_IDS"),
    pollingTimeoutSeconds: numberFromEnv("TELEGRAM_POLL_TIMEOUT_SECONDS", 30),
    retryDelayMs: numberFromEnv("TELEGRAM_RETRY_DELAY_MS", 5000),
    sendRetryAttempts: numberFromEnv("TELEGRAM_SEND_RETRY_ATTEMPTS", 3),
    downloadMaxFileBytes:
      numberFromEnv("TELEGRAM_DOWNLOAD_MAX_FILE_MB", 20) * 1024 * 1024,
    sendMaxFileBytes: numberFromEnv("TELEGRAM_SEND_MAX_FILE_MB", 50) * 1024 * 1024,
    statusPollIntervalMs: numberFromEnv("TELEGRAM_STATUS_POLL_INTERVAL_MS", 15000),
    titlePromptTimeoutMs: numberFromEnv("TELEGRAM_TITLE_PROMPT_TIMEOUT_MS", 60 * 1000),
    progressUpdateThrottleMs: numberFromEnv(
      "TELEGRAM_PROGRESS_UPDATE_THROTTLE_MS",
      5000
    ),
    adminAlertCooldownMs: Math.max(
      0,
      numberFromEnv("TELEGRAM_ADMIN_ALERT_COOLDOWN_MS", 30 * 60 * 1000)
    ),
  },
  pakasir: {
    enabled: booleanFromEnv("PAKASIR_ENABLED", false),
    baseUrl:
      String(process.env.PAKASIR_BASE_URL || "https://app.pakasir.com").trim() ||
      "https://app.pakasir.com",
    project: String(process.env.PAKASIR_PROJECT || "").trim(),
    apiKey: String(process.env.PAKASIR_API_KEY || "").trim(),
    amount: Math.max(0, numberFromEnv("PAKASIR_AMOUNT", 0)),
    method: String(process.env.PAKASIR_METHOD || "qris").trim().toLowerCase() || "qris",
    qrisOnly: booleanFromEnv("PAKASIR_QRIS_ONLY", true),
    redirectUrl: String(process.env.PAKASIR_REDIRECT_URL || "").trim(),
    webhookPath:
      String(process.env.PAKASIR_WEBHOOK_PATH || "/api/payments/pakasir/webhook").trim() ||
      "/api/payments/pakasir/webhook",
    statusPollIntervalMs: Math.max(
      5000,
      numberFromEnv("PAKASIR_STATUS_POLL_INTERVAL_MS", 15000)
    ),
  },
  panelAuth: {
    enabled: booleanFromEnv("PANEL_AUTH_ENABLED", true),
    username: String(process.env.PANEL_AUTH_USERNAME || "Andri14").trim() || "Andri14",
    password: String(process.env.PANEL_AUTH_PASSWORD || "Andri14"),
    sessionSecret: String(process.env.PANEL_SESSION_SECRET || "").trim(),
    sessionCookieName:
      String(process.env.PANEL_SESSION_COOKIE_NAME || "").trim() ||
      "turnitin_admin_session",
    sessionTtlMs: numberFromEnv("PANEL_SESSION_TTL_MS", 24 * 60 * 60 * 1000),
    secureCookie: booleanFromEnv("PANEL_SESSION_SECURE_COOKIE", false),
  },
};
