const test = require("node:test");
const assert = require("node:assert/strict");

function loadConfigFresh() {
  const modulePath = require.resolve("../src/config");
  delete require.cache[modulePath];
  return require("../src/config");
}

test("config defaults Chromium sandbox based on current user id", () => {
  const previousValue = process.env.TURNITIN_CHROMIUM_SANDBOX;
  delete process.env.TURNITIN_CHROMIUM_SANDBOX;

  try {
    const config = loadConfigFresh();
    const expected =
      typeof process.getuid === "function" ? process.getuid() !== 0 : true;
    assert.equal(config.chromiumSandbox, expected);
  } finally {
    if (previousValue === undefined) {
      delete process.env.TURNITIN_CHROMIUM_SANDBOX;
    } else {
      process.env.TURNITIN_CHROMIUM_SANDBOX = previousValue;
    }
    loadConfigFresh();
  }
});

test("config lets TURNITIN_CHROMIUM_SANDBOX override launch behavior", () => {
  const previousValue = process.env.TURNITIN_CHROMIUM_SANDBOX;
  process.env.TURNITIN_CHROMIUM_SANDBOX = "true";

  try {
    const config = loadConfigFresh();
    assert.equal(config.chromiumSandbox, true);
  } finally {
    if (previousValue === undefined) {
      delete process.env.TURNITIN_CHROMIUM_SANDBOX;
    } else {
      process.env.TURNITIN_CHROMIUM_SANDBOX = previousValue;
    }
    loadConfigFresh();
  }
});

test("config exposes a minimum current view retry limit", () => {
  const previousValue = process.env.TURNITIN_CURRENT_VIEW_MAX_ATTEMPTS;
  process.env.TURNITIN_CURRENT_VIEW_MAX_ATTEMPTS = "0";

  try {
    const config = loadConfigFresh();
    assert.equal(config.currentViewMaxAttempts, 1);
  } finally {
    if (previousValue === undefined) {
      delete process.env.TURNITIN_CURRENT_VIEW_MAX_ATTEMPTS;
    } else {
      process.env.TURNITIN_CURRENT_VIEW_MAX_ATTEMPTS = previousValue;
    }
    loadConfigFresh();
  }
});

test("config exposes overridable current view download timeout", () => {
  const previousValue = process.env.TURNITIN_CURRENT_VIEW_DOWNLOAD_TIMEOUT_MS;
  process.env.TURNITIN_CURRENT_VIEW_DOWNLOAD_TIMEOUT_MS = "90000";

  try {
    const config = loadConfigFresh();
    assert.equal(config.currentViewDownloadTimeoutMs, 90000);
  } finally {
    if (previousValue === undefined) {
      delete process.env.TURNITIN_CURRENT_VIEW_DOWNLOAD_TIMEOUT_MS;
    } else {
      process.env.TURNITIN_CURRENT_VIEW_DOWNLOAD_TIMEOUT_MS = previousValue;
    }
    loadConfigFresh();
  }
});

test("config exposes default panel auth credentials", () => {
  const previousEnabled = process.env.PANEL_AUTH_ENABLED;
  const previousUsername = process.env.PANEL_AUTH_USERNAME;
  const previousPassword = process.env.PANEL_AUTH_PASSWORD;
  delete process.env.PANEL_AUTH_ENABLED;
  delete process.env.PANEL_AUTH_USERNAME;
  delete process.env.PANEL_AUTH_PASSWORD;

  try {
    const config = loadConfigFresh();
    assert.equal(config.panelAuth.enabled, true);
    assert.equal(config.panelAuth.username, "Andri14");
    assert.equal(config.panelAuth.password, "Andri14");
    assert.equal(config.panelAuth.sessionCookieName, "turnitin_admin_session");
  } finally {
    if (previousEnabled === undefined) {
      delete process.env.PANEL_AUTH_ENABLED;
    } else {
      process.env.PANEL_AUTH_ENABLED = previousEnabled;
    }
    if (previousUsername === undefined) {
      delete process.env.PANEL_AUTH_USERNAME;
    } else {
      process.env.PANEL_AUTH_USERNAME = previousUsername;
    }
    if (previousPassword === undefined) {
      delete process.env.PANEL_AUTH_PASSWORD;
    } else {
      process.env.PANEL_AUTH_PASSWORD = previousPassword;
    }
    loadConfigFresh();
  }
});

test("config parses admin alert chat ids and pool alert thresholds", () => {
  const previousAdminChatIds = process.env.TELEGRAM_ADMIN_CHAT_IDS;
  const previousRestrictGeneralAccess = process.env.TELEGRAM_RESTRICT_GENERAL_ACCESS;
  const previousAccountThreshold = process.env.TURNITIN_POOL_ALERT_USABLE_ACCOUNTS_THRESHOLD;
  const previousAssignmentThreshold =
    process.env.TURNITIN_POOL_ALERT_SUBMITTABLE_ASSIGNMENTS_THRESHOLD;

  process.env.TELEGRAM_ADMIN_CHAT_IDS = "6669292550, 123456";
  process.env.TELEGRAM_RESTRICT_GENERAL_ACCESS = "true";
  process.env.TURNITIN_POOL_ALERT_USABLE_ACCOUNTS_THRESHOLD = "3";
  process.env.TURNITIN_POOL_ALERT_SUBMITTABLE_ASSIGNMENTS_THRESHOLD = "9";

  try {
    const config = loadConfigFresh();
    assert.deepEqual(config.telegram.adminChatIds, ["6669292550", "123456"]);
    assert.equal(config.telegram.restrictGeneralAccess, true);
    assert.equal(config.poolAlerts.usableAccountsThreshold, 3);
    assert.equal(config.poolAlerts.submittableAssignmentsThreshold, 9);
  } finally {
    if (previousAdminChatIds === undefined) {
      delete process.env.TELEGRAM_ADMIN_CHAT_IDS;
    } else {
      process.env.TELEGRAM_ADMIN_CHAT_IDS = previousAdminChatIds;
    }
    if (previousRestrictGeneralAccess === undefined) {
      delete process.env.TELEGRAM_RESTRICT_GENERAL_ACCESS;
    } else {
      process.env.TELEGRAM_RESTRICT_GENERAL_ACCESS = previousRestrictGeneralAccess;
    }
    if (previousAccountThreshold === undefined) {
      delete process.env.TURNITIN_POOL_ALERT_USABLE_ACCOUNTS_THRESHOLD;
    } else {
      process.env.TURNITIN_POOL_ALERT_USABLE_ACCOUNTS_THRESHOLD = previousAccountThreshold;
    }
    if (previousAssignmentThreshold === undefined) {
      delete process.env.TURNITIN_POOL_ALERT_SUBMITTABLE_ASSIGNMENTS_THRESHOLD;
    } else {
      process.env.TURNITIN_POOL_ALERT_SUBMITTABLE_ASSIGNMENTS_THRESHOLD =
        previousAssignmentThreshold;
    }
    loadConfigFresh();
  }
});
