const { createHash, createHmac, randomBytes, timingSafeEqual } = require("crypto");

function digestText(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest();
}

function safeEqualText(left, right) {
  return timingSafeEqual(digestText(left), digestText(right));
}

function signSessionPayload(payload, secret) {
  return createHmac("sha256", String(secret || ""))
    .update(String(payload || ""), "utf8")
    .digest("base64url");
}

function createSessionToken({ username, secret, ttlMs = 24 * 60 * 60 * 1000, now = Date.now() }) {
  const expiresAt = Number(now) + Math.max(60 * 1000, Number(ttlMs) || 0);
  const nonce = randomBytes(18).toString("base64url");
  const payload = `${String(username || "")}.${expiresAt}.${nonce}`;
  const signature = signSessionPayload(payload, secret);
  return {
    token: `${payload}.${signature}`,
    expiresAt,
  };
}

function validateSessionToken(token, { username, secret, now = Date.now() }) {
  const parts = String(token || "").split(".");
  if (parts.length < 4) {
    return {
      valid: false,
      reason: "malformed",
    };
  }

  const signature = parts.pop();
  const payload = parts.join(".");
  const expectedSignature = signSessionPayload(payload, secret);
  if (!safeEqualText(signature, expectedSignature)) {
    return {
      valid: false,
      reason: "bad_signature",
    };
  }

  const [tokenUsername, expiresAtText] = parts;
  if (!safeEqualText(tokenUsername, username)) {
    return {
      valid: false,
      reason: "wrong_user",
    };
  }

  const expiresAt = Number(expiresAtText);
  if (!Number.isFinite(expiresAt)) {
    return {
      valid: false,
      reason: "bad_expiry",
    };
  }

  if (Number(now) >= expiresAt) {
    return {
      valid: false,
      reason: "expired",
      expiresAt,
    };
  }

  return {
    valid: true,
    username: tokenUsername,
    expiresAt,
  };
}

function parseCookieHeader(headerValue = "") {
  const cookies = {};
  for (const rawPart of String(headerValue || "").split(";")) {
    const part = rawPart.trim();
    if (!part) {
      continue;
    }

    const separatorIndex = part.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const name = decodeURIComponent(part.slice(0, separatorIndex).trim());
    const value = decodeURIComponent(part.slice(separatorIndex + 1).trim());
    cookies[name] = value;
  }

  return cookies;
}

function buildPanelAuthState(config) {
  const panelConfig = config?.panelAuth || {};
  const username = String(panelConfig.username || "Andri14").trim() || "Andri14";
  const password = String(panelConfig.password || "Andri14");
  const sessionSecret =
    String(panelConfig.sessionSecret || "").trim() || `${username}:${password}:turnitin-panel`;

  return {
    enabled: panelConfig.enabled !== false,
    username,
    password,
    sessionSecret,
    sessionCookieName:
      String(panelConfig.sessionCookieName || "").trim() || "turnitin_admin_session",
    sessionTtlMs: Math.max(60 * 1000, Number(panelConfig.sessionTtlMs) || 24 * 60 * 60 * 1000),
    secureCookie: panelConfig.secureCookie === true,
  };
}

module.exports = {
  buildPanelAuthState,
  createSessionToken,
  parseCookieHeader,
  safeEqualText,
  validateSessionToken,
};
