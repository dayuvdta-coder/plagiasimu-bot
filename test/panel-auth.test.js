const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildPanelAuthState,
  createSessionToken,
  parseCookieHeader,
  safeEqualText,
  validateSessionToken,
} = require("../src/services/panel-auth");

test("safeEqualText matches equal strings and rejects different ones", () => {
  assert.equal(safeEqualText("Andri14", "Andri14"), true);
  assert.equal(safeEqualText("Andri14", "andri14"), false);
});

test("createSessionToken and validateSessionToken round-trip", () => {
  const session = createSessionToken({
    username: "Andri14",
    secret: "secret-key",
    ttlMs: 60_000,
    now: 1_000,
  });

  const validated = validateSessionToken(session.token, {
    username: "Andri14",
    secret: "secret-key",
    now: 2_000,
  });

  assert.equal(validated.valid, true);
  assert.equal(validated.username, "Andri14");
  assert.equal(validated.expiresAt, 61_000);
});

test("validateSessionToken rejects expired token", () => {
  const session = createSessionToken({
    username: "Andri14",
    secret: "secret-key",
    ttlMs: 60_000,
    now: 1_000,
  });

  const validated = validateSessionToken(session.token, {
    username: "Andri14",
    secret: "secret-key",
    now: 62_000,
  });

  assert.equal(validated.valid, false);
  assert.equal(validated.reason, "expired");
});

test("parseCookieHeader reads individual cookies", () => {
  const cookies = parseCookieHeader("foo=bar; turnitin_admin_session=abc123; theme=light");
  assert.equal(cookies.foo, "bar");
  assert.equal(cookies.turnitin_admin_session, "abc123");
  assert.equal(cookies.theme, "light");
});

test("buildPanelAuthState applies defaults and secret fallback", () => {
  const panelAuth = buildPanelAuthState({
    panelAuth: {
      username: "",
      password: "",
      sessionSecret: "",
    },
  });

  assert.equal(panelAuth.enabled, true);
  assert.equal(panelAuth.username, "Andri14");
  assert.equal(panelAuth.password, "Andri14");
  assert.match(panelAuth.sessionSecret, /Andri14/);
  assert.equal(panelAuth.sessionCookieName, "turnitin_admin_session");
});
