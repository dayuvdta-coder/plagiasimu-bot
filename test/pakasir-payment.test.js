const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PakasirPaymentService,
} = require("../src/services/pakasir-payment");

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function createConfig() {
  return {
    pakasir: {
      enabled: true,
      baseUrl: "https://app.pakasir.com",
      project: "plagiasimu-bot",
      apiKey: "secret",
      amount: 22000,
      method: "qris",
      qrisOnly: true,
      redirectUrl: "https://example.com/paid",
      webhookPath: "/api/payments/pakasir/webhook",
      statusPollIntervalMs: 15000,
    },
  };
}

test("PakasirPaymentService builds QRIS checkout URL", () => {
  const service = new PakasirPaymentService({
    config: createConfig(),
    fetchImpl: async () => {
      throw new Error("No fetch expected");
    },
  });

  const url = service.buildCheckoutUrl({
    orderId: "PLG-TEST-001",
  });

  assert.equal(
    url,
    "https://app.pakasir.com/pay/plagiasimu-bot/22000?order_id=PLG-TEST-001&redirect=https%3A%2F%2Fexample.com%2Fpaid&qris_only=1"
  );
});

test("PakasirPaymentService requests transaction detail and normalizes response", async () => {
  const requests = [];
  const service = new PakasirPaymentService({
    config: createConfig(),
    fetchImpl: async (url, options = {}) => {
      requests.push({
        url,
        method: options.method || "GET",
      });
      return jsonResponse({
        transaction: {
          amount: 22000,
          order_id: "PLG-TEST-002",
          project: "plagiasimu-bot",
          status: "completed",
          payment_method: "qris",
          completed_at: "2026-03-10T10:00:00.000Z",
        },
      });
    },
  });

  const result = await service.getTransactionDetail({
    orderId: "PLG-TEST-002",
  });

  assert.equal(requests[0]?.method, "GET");
  assert.match(requests[0]?.url || "", /project=plagiasimu-bot/);
  assert.match(requests[0]?.url || "", /order_id=PLG-TEST-002/);
  assert.equal(result.transaction.orderId, "PLG-TEST-002");
  assert.equal(result.transaction.status, "completed");
  assert.equal(result.transaction.paymentMethod, "qris");
});

test("PakasirPaymentService creates a transaction and normalizes payment payload", async () => {
  const requests = [];
  const service = new PakasirPaymentService({
    config: createConfig(),
    fetchImpl: async (url, options = {}) => {
      requests.push({
        url,
        method: options.method || "GET",
        body: options.body ? JSON.parse(options.body) : null,
      });
      return jsonResponse({
        payment: {
          project: "plagiasimu-bot",
          order_id: "PLG-TEST-004",
          amount: 5500,
          total_payment: 5849,
          fee: 349,
          received: 5500,
          payment_method: "qris",
          payment_number: "000201...",
          expired_at: "2026-03-10T12:00:00.000Z",
        },
      });
    },
  });

  const result = await service.createTransaction({
    orderId: "PLG-TEST-004",
    amount: 5500,
    method: "qris",
  });

  assert.equal(requests[0]?.method, "POST");
  assert.match(requests[0]?.url || "", /transactioncreate\/qris$/);
  assert.equal(requests[0]?.body?.order_id, "PLG-TEST-004");
  assert.equal(result.payment.orderId, "PLG-TEST-004");
  assert.equal(result.payment.totalPayment, 5849);
  assert.equal(result.payment.fee, 349);
});

test("PakasirPaymentService verifies webhook payload against transaction detail", async () => {
  const service = new PakasirPaymentService({
    config: createConfig(),
    fetchImpl: async () =>
      jsonResponse({
        transaction: {
          amount: 22000,
          order_id: "PLG-TEST-003",
          project: "plagiasimu-bot",
          status: "completed",
          payment_method: "qris",
          completed_at: "2026-03-10T10:00:00.000Z",
        },
      }),
  });

  const result = await service.verifyWebhookPayload({
    amount: 22000,
    order_id: "PLG-TEST-003",
    project: "plagiasimu-bot",
    status: "completed",
    payment_method: "qris",
    completed_at: "2026-03-10T10:00:00.000Z",
  });

  assert.equal(result.completed, true);
  assert.equal(result.transaction.orderId, "PLG-TEST-003");
  assert.equal(result.transaction.amount, 22000);
});
