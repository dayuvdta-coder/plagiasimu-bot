const { randomUUID } = require("crypto");
const { URL } = require("url");

function normalizeStatus(value) {
  return String(value || "pending")
    .trim()
    .toLowerCase() || "pending";
}

function normalizeAmount(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : Math.max(0, Number(fallback) || 0);
}

function normalizeTransaction(transaction = {}) {
  const amount = normalizeAmount(transaction.amount);
  return {
    amount,
    orderId: String(transaction.order_id || "").trim(),
    project: String(transaction.project || "").trim(),
    status: normalizeStatus(transaction.status),
    paymentMethod: String(transaction.payment_method || "").trim().toLowerCase() || null,
    completedAt: transaction.completed_at || null,
  };
}

function normalizePaymentCreation(payment = {}) {
  return {
    project: String(payment.project || "").trim(),
    orderId: String(payment.order_id || "").trim(),
    amount: normalizeAmount(payment.amount),
    totalPayment: normalizeAmount(payment.total_payment || payment.total || payment.amount),
    fee: normalizeAmount(payment.fee),
    received: normalizeAmount(payment.received || payment.amount),
    paymentMethod: String(payment.payment_method || "").trim().toLowerCase() || null,
    paymentNumber: String(payment.payment_number || "").trim() || null,
    expiredAt: payment.expired_at || null,
  };
}

class PakasirPaymentService {
  constructor({ config, fetchImpl = null, logger = console }) {
    this.config = config;
    this.fetchImpl = fetchImpl || globalThis.fetch?.bind(globalThis) || null;
    this.logger = logger;
  }

  get paymentConfig() {
    return this.config?.pakasir || {};
  }

  isConfigured() {
    const cfg = this.paymentConfig;
    return Boolean(
      cfg?.enabled &&
        cfg?.project &&
        cfg?.apiKey &&
        normalizeAmount(cfg?.amount) > 0
    );
  }

  createOrderId({ chatId = "", prefix = "PLG" } = {}) {
    const date = new Date();
    const stamp = [
      String(date.getUTCFullYear()).slice(-2),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
    ].join("");
    const chatSuffix = String(chatId || "")
      .replace(/\D+/g, "")
      .slice(-6);
    const nonce = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
    return [prefix, stamp, chatSuffix || "TG", nonce].join("-");
  }

  buildCheckoutUrl({
    orderId,
    amount = this.paymentConfig.amount,
    redirectUrl = this.paymentConfig.redirectUrl,
    qrisOnly = this.paymentConfig.qrisOnly,
  } = {}) {
    const cfg = this.paymentConfig;
    const cleanOrderId = String(orderId || "").trim();
    if (!cleanOrderId) {
      throw new Error("orderId pembayaran wajib diisi.");
    }

    const normalizedAmount = normalizeAmount(amount, cfg.amount);
    if (normalizedAmount <= 0) {
      throw new Error("amount pembayaran Pakasir belum valid.");
    }

    const baseUrl = String(cfg.baseUrl || "https://app.pakasir.com").replace(/\/+$/, "");
    const route = String(cfg.method || "qris").trim().toLowerCase() === "paypal" ? "paypal" : "pay";
    const url = new URL(`${baseUrl}/${route}/${encodeURIComponent(cfg.project)}/${normalizedAmount}`);
    url.searchParams.set("order_id", cleanOrderId);
    if (redirectUrl) {
      url.searchParams.set("redirect", String(redirectUrl));
    }
    if (route === "pay" && qrisOnly) {
      url.searchParams.set("qris_only", "1");
    }
    return url.toString();
  }

  async getTransactionDetail({ orderId, amount = this.paymentConfig.amount } = {}) {
    this.ensureConfigured();
    const cfg = this.paymentConfig;
    const url = new URL(`${String(cfg.baseUrl || "https://app.pakasir.com").replace(/\/+$/, "")}/api/transactiondetail`);
    url.searchParams.set("project", String(cfg.project));
    url.searchParams.set("amount", String(normalizeAmount(amount, cfg.amount)));
    url.searchParams.set("order_id", String(orderId || "").trim());
    url.searchParams.set("api_key", String(cfg.apiKey));
    const data = await this.requestJson(url.toString(), {
      method: "GET",
      label: "transactiondetail",
    });
    return {
      transaction: normalizeTransaction(data?.transaction || {}),
      raw: data,
    };
  }

  async createTransaction({
    orderId,
    amount = this.paymentConfig.amount,
    method = this.paymentConfig.method,
  } = {}) {
    this.ensureConfigured();
    const cfg = this.paymentConfig;
    const normalizedMethod = String(method || cfg.method || "qris").trim().toLowerCase() || "qris";
    const data = await this.requestJson(
      `${String(cfg.baseUrl || "https://app.pakasir.com").replace(/\/+$/, "")}/api/transactioncreate/${normalizedMethod}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          project: String(cfg.project),
          order_id: String(orderId || "").trim(),
          amount: normalizeAmount(amount, cfg.amount),
          api_key: String(cfg.apiKey),
        }),
        label: "transactioncreate",
      }
    );
    return {
      payment: normalizePaymentCreation(data?.payment || {}),
      raw: data,
    };
  }

  async cancelTransaction({ orderId, amount = this.paymentConfig.amount } = {}) {
    this.ensureConfigured();
    const cfg = this.paymentConfig;
    const data = await this.requestJson(
      `${String(cfg.baseUrl || "https://app.pakasir.com").replace(/\/+$/, "")}/api/transactioncancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          project: String(cfg.project),
          order_id: String(orderId || "").trim(),
          amount: normalizeAmount(amount, cfg.amount),
          api_key: String(cfg.apiKey),
        }),
        label: "transactioncancel",
      }
    );
    return {
      transaction: normalizeTransaction(data?.transaction || data?.payment || {}),
      raw: data,
    };
  }

  async verifyWebhookPayload(payload = {}) {
    const transaction = normalizeTransaction(payload);
    if (!transaction.orderId || transaction.amount <= 0) {
      throw new Error("Webhook Pakasir tidak berisi order_id/amount yang valid.");
    }

    const detail = await this.getTransactionDetail({
      orderId: transaction.orderId,
      amount: transaction.amount,
    });
    if (
      !detail.transaction.orderId ||
      detail.transaction.orderId !== transaction.orderId ||
      detail.transaction.amount !== transaction.amount
    ) {
      throw new Error("Detail transaksi Pakasir tidak cocok dengan webhook.");
    }

    return {
      transaction: detail.transaction,
      completed: detail.transaction.status === "completed",
      raw: payload,
    };
  }

  ensureConfigured() {
    if (!this.isConfigured()) {
      throw new Error("Konfigurasi Pakasir belum lengkap.");
    }
  }

  async requestJson(url, { method = "GET", headers = {}, body = null, label = "request" } = {}) {
    if (!this.fetchImpl) {
      throw new Error("Fetch API tidak tersedia untuk Pakasir request.");
    }

    const response = await this.fetchImpl(url, {
      method,
      headers,
      body,
    });
    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      throw new Error(`Pakasir ${label} mengembalikan respons non-JSON.`);
    }

    if (!response.ok) {
      throw new Error(
        data?.message ||
          data?.error ||
          `Pakasir ${label} gagal dengan HTTP ${response.status}.`
      );
    }

    return data;
  }
}

module.exports = {
  PakasirPaymentService,
  normalizePaymentCreation,
  normalizeStatus,
  normalizeTransaction,
};
