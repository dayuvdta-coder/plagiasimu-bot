const test = require("node:test");
const assert = require("node:assert/strict");
const { createHandler } = require("../api/payments/pakasir/webhook");

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

test("Vercel Pakasir webhook handler responds to health checks", async () => {
  const handler = createHandler({
    env: {},
    fetchImpl: async () => {
      throw new Error("No fetch expected");
    },
    logger: {
      log() {},
      error() {},
    },
  });
  const res = createResponse();

  await handler(
    {
      method: "GET",
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body?.ok, true);
  assert.equal(res.body?.service, "pakasir-webhook-dev");
});

test("Vercel Pakasir webhook handler verifies incoming webhook payload", async () => {
  const requests = [];
  const handler = createHandler({
    env: {
      PAKASIR_ENABLED: "true",
      PAKASIR_PROJECT: "plagiasimu-bot",
      PAKASIR_API_KEY: "secret",
      PAKASIR_AMOUNT: "5500",
    },
    fetchImpl: async (url) => {
      requests.push(url);
      return jsonResponse({
        transaction: {
          amount: 5500,
          order_id: "PLG-TEST-5500",
          project: "plagiasimu-bot",
          status: "completed",
          payment_method: "qris",
          completed_at: "2026-03-10T12:00:00.000Z",
        },
      });
    },
    logger: {
      log() {},
      error() {},
    },
  });
  const res = createResponse();

  await handler(
    {
      method: "POST",
      body: {
        amount: 5500,
        order_id: "PLG-TEST-5500",
        project: "plagiasimu-bot",
        status: "completed",
        payment_method: "qris",
        completed_at: "2026-03-10T12:00:00.000Z",
      },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body?.ok, true);
  assert.equal(res.body?.verification?.completed, true);
  assert.equal(res.body?.verification?.transaction?.orderId, "PLG-TEST-5500");
  assert.match(requests[0] || "", /transactiondetail/);
});
