const { PakasirPaymentService } = require("../../../src/services/pakasir-payment");

function getConfigFromEnv(env = process.env) {
  return {
    pakasir: {
      enabled: String(env.PAKASIR_ENABLED || "").trim().toLowerCase() === "true",
      baseUrl:
        String(env.PAKASIR_BASE_URL || "https://app.pakasir.com").trim() ||
        "https://app.pakasir.com",
      project: String(env.PAKASIR_PROJECT || "").trim(),
      apiKey: String(env.PAKASIR_API_KEY || "").trim(),
      amount: Number(env.PAKASIR_AMOUNT || 0) || 0,
      method: String(env.PAKASIR_METHOD || "qris").trim().toLowerCase() || "qris",
      qrisOnly: String(env.PAKASIR_QRIS_ONLY || "").trim().toLowerCase() !== "false",
      redirectUrl: String(env.PAKASIR_REDIRECT_URL || "").trim(),
      webhookPath:
        String(env.PAKASIR_WEBHOOK_PATH || "/api/payments/pakasir/webhook").trim() ||
        "/api/payments/pakasir/webhook",
      statusPollIntervalMs: Number(env.PAKASIR_STATUS_POLL_INTERVAL_MS || 15000) || 15000,
    },
  };
}

async function readBody(req) {
  if (req?.body && typeof req.body === "object") {
    return req.body;
  }

  if (typeof req?.body === "string" && req.body.trim()) {
    return JSON.parse(req.body);
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

async function maybeForwardWebhook(payload, env = process.env, fetchImpl = globalThis.fetch) {
  const targetUrl = String(env.PAKASIR_FORWARD_WEBHOOK_URL || "").trim();
  if (!targetUrl) {
    return null;
  }

  if (typeof fetchImpl !== "function") {
    throw new Error("Fetch API tidak tersedia untuk forward webhook.");
  }

  const response = await fetchImpl(targetUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload || {}),
  });
  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    data = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

function createHandler({
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  return async function handler(req, res) {
    if (req.method === "GET") {
      return res.status(200).json({
        ok: true,
        service: "pakasir-webhook-dev",
        path: "/api/payments/pakasir/webhook",
        pakasirConfigured: Boolean(
          String(env.PAKASIR_PROJECT || "").trim() && String(env.PAKASIR_API_KEY || "").trim()
        ),
        forwardTargetConfigured: Boolean(String(env.PAKASIR_FORWARD_WEBHOOK_URL || "").trim()),
        now: new Date().toISOString(),
      });
    }

    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed.",
      });
    }

    try {
      const payload = await readBody(req);
      const paymentService = new PakasirPaymentService({
        config: getConfigFromEnv(env),
        fetchImpl,
        logger,
      });

      let verification = null;
      if (paymentService.isConfigured()) {
        verification = await paymentService.verifyWebhookPayload(payload);
      }

      const forwarded = await maybeForwardWebhook(payload, env, fetchImpl);
      return res.status(200).json({
        ok: true,
        received: true,
        forwarded,
        verification: verification
          ? {
              completed: verification.completed,
              transaction: verification.transaction,
            }
          : null,
        webhook: {
          orderId: String(payload?.order_id || "").trim() || null,
          status: String(payload?.status || "").trim() || null,
        },
      });
    } catch (error) {
      logger.error?.(`Vercel Pakasir webhook error: ${error.message}`);
      return res.status(400).json({
        ok: false,
        error: error.message,
      });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
