const fs = require("fs/promises");
const https = require("https");
const path = require("path");
const { randomUUID } = require("crypto");
const QRCode = require("qrcode");
const { URL } = require("url");
const {
  appendAccounts,
  listAccounts,
  maskEmail,
  parseAccountsFromText,
  removeAccount,
} = require("./accounts");
const { sanitizeResultArtifacts } = require("./report-links");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFilename(value, fallback = "document") {
  const normalized = String(value || "")
    .split(/[\\/]/)
    .pop()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function normalizeDisplayFilename(value, fallback = "document.pdf") {
  const normalized = String(value || "")
    .split(/[\\/]/)
    .pop()
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || fallback;
}

function buildResultDocumentFilename(originalName, fallback = "similarity-report.pdf") {
  const displayName = normalizeDisplayFilename(originalName, fallback);
  const parsed = path.parse(displayName);
  const baseName = String(parsed.name || parsed.base || "")
    .replace(/"/g, "")
    .trim();
  return `${baseName || path.parse(fallback).name || "similarity-report"}.pdf`;
}

function buildResultDocumentCaption(originalName, similarity = null) {
  const label = truncate(normalizeDisplayFilename(originalName, "similarity-report.pdf"), 160);
  return similarity ? `${label} • ${similarity}` : label;
}

const TELEGRAM_BOT_LABEL = "Plagiasimu Bot";
const ADMIN_COMMANDS = new Set([
  "/admin",
  "/health",
  "/pool",
  "/accounts",
  "/accountlist",
  "/accountadd",
  "/accountdel",
  "/accountdelete",
  "/accountremove",
]);
const PAYMENT_TERMINAL_STATUSES = new Set(["completed", "cancelled", "expired", "failed"]);

function resolveStorageUrlPath(storageDir, value) {
  const text = String(value || "").trim();
  if (!text.startsWith("/storage/")) {
    return null;
  }

  return path.join(storageDir, text.replace(/^\/storage\//, ""));
}

function shortJobId(jobId) {
  return String(jobId || "").slice(0, 8) || "-";
}

function shortOrderId(orderId) {
  return String(orderId || "").slice(-10) || "-";
}

function truncate(value, maxLength = 120) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatCurrencyIdr(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return "Rp 0";
  }

  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(amount);
}

function buildPaymentQrCaption(payment) {
  return [
    `${TELEGRAM_BOT_LABEL} • QRIS`,
    `Invoice ${payment.orderId}`,
    `Total Bayar ${formatCurrencyIdr(payment.totalPayment || payment.amount)}`,
    payment.expiredAt ? `Expired ${formatTimeWib(payment.expiredAt)} WIB` : null,
    "Scan QR ini langsung dari chat untuk bayar.",
  ]
    .filter(Boolean)
    .join("\n");
}

function isInlineReplyMarkup(replyMarkup) {
  return Boolean(replyMarkup && typeof replyMarkup === "object" && replyMarkup.inline_keyboard);
}

function createAbortError() {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function buildMultipartBody({
  fields = {},
  fieldName,
  filename,
  contentType,
  fileBuffer,
}) {
  const boundary = `----turnitin-telegram-${randomUUID()}`;
  const chunks = [];

  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    chunks.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
          `${String(value)}\r\n`
      )
    );
  }

  chunks.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${fieldName}"; filename="${String(
          filename || "file"
        ).replace(/"/g, "")}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`
    )
  );
  chunks.push(fileBuffer);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  return {
    boundary,
    body: Buffer.concat(chunks),
  };
}

function formatTimeWib(value = Date.now()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatDurationRough(ms) {
  const safeMs = Math.max(0, Number(ms) || 0);
  const totalMinutes = Math.round(safeMs / (60 * 1000));
  if (totalMinutes <= 1) {
    return "kurang dari 1 menit";
  }

  if (totalMinutes < 60) {
    return `sekitar ${totalMinutes} menit`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!minutes) {
    return `sekitar ${hours} jam`;
  }

  return `sekitar ${hours} jam ${minutes} menit`;
}

function humanizeLabel(value, fallback = "-") {
  const text = String(value || "")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!text) {
    return fallback;
  }

  return text.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function maskEmailLikeText(text) {
  return String(text || "").replace(
    /\b([a-z0-9._%+-]{1,64})@([a-z0-9.-]+\.[a-z]{2,})\b/gi,
    (_, localPart, domain) => {
      const visible = localPart.slice(0, 3);
      return `${visible}${"*".repeat(Math.max(localPart.length - 3, 2))}@${domain}`;
    }
  );
}

function shouldReplaceStatusMessageAfterEditError(error) {
  const message = String(error?.message || "").toLowerCase();
  if (!message) {
    return false;
  }

  return (
    /message to edit not found/.test(message) ||
    /message identifier is not specified/.test(message) ||
    /chat not found/.test(message)
  );
}

function isRetryableTelegramTransportError(error) {
  if (!error || error.name === "AbortError") {
    return false;
  }

  const code = String(error.code || "").toUpperCase();
  if (["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNREFUSED", "UND_ERR_SOCKET"].includes(code)) {
    return true;
  }

  const message = String(error.message || "").toLowerCase();
  if (!message) {
    return false;
  }

  return (
    /econnreset/.test(message) ||
    /etimedout/.test(message) ||
    /socket hang up/.test(message) ||
    /network socket disconnected/.test(message) ||
    /fetch failed/.test(message) ||
    /connection reset/.test(message)
  );
}

class TelegramBotService {
  constructor({
    config,
    jobRunner,
    stateStore = null,
    paymentService = null,
    turnitinService = null,
    fetchImpl = null,
    logger = console,
  }) {
    this.config = config;
    this.jobRunner = jobRunner;
    this.jobStore = jobRunner?.jobStore || null;
    this.stateStore = stateStore;
    this.paymentService = paymentService;
    this.turnitinService = turnitinService;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.running = false;
    this.offset = 0;
    this.abortController = null;
    this.listenersAttached = false;
    this.boundListeners = null;
    this.jobContexts = new Map();
    this.chatJobHistory = new Map();
    this.chatProfiles = new Map();
    this.pendingSubmissions = new Map();
    this.pendingPayments = new Map();
    this.paymentRefreshLocks = new Map();
    this.chatReadyMessages = new Map();
    this.statusPollTimer = null;
    this.adminAlertState = {
      lastLevel: "healthy",
      lastKey: "",
      lastSentAt: 0,
    };
    this.restorePendingPayments();
  }

  get telegramConfig() {
    return this.config.telegram || {};
  }

  get pakasirConfig() {
    return this.config.pakasir || {};
  }

  get apiBaseUrl() {
    return `https://api.telegram.org/bot${this.telegramConfig.botToken}`;
  }

  get fileBaseUrl() {
    return `https://api.telegram.org/file/bot${this.telegramConfig.botToken}`;
  }

  isEnabled() {
    return Boolean(this.telegramConfig.enabled && this.telegramConfig.botToken);
  }

  isPaymentEnabled() {
    return Boolean(this.paymentService?.isConfigured?.());
  }

  getAdminChatIds() {
    const adminChatIds = this.telegramConfig.adminChatIds || [];
    return adminChatIds.map((value) => String(value || "").trim()).filter(Boolean);
  }

  isAdminChat(chatId) {
    return this.getAdminChatIds().includes(String(chatId));
  }

  isAdminCommand(command) {
    return ADMIN_COMMANDS.has(String(command || "").trim().toLowerCase());
  }

  canSendAdminAlerts() {
    return this.isEnabled() && this.getAdminChatIds().length > 0;
  }

  restorePendingPayments() {
    if (!this.stateStore?.listPendingPayments) {
      return;
    }

    const records = this.stateStore.listPendingPayments(100);
    for (const record of records) {
      const orderId = String(record?.orderId || "").trim();
      if (!orderId) {
        continue;
      }

      this.pendingPayments.set(orderId, {
        ...record,
        statusMessageId:
          record?.statusMessageKind === "photo"
            ? record?.qrMessageId || record?.statusMessageId || null
            : record?.statusMessageId || null,
        statusMessageKind:
          record?.statusMessageKind || (record?.qrMessageId ? "photo" : "text"),
        lastStatusText: null,
        lastReplyMarkupKey: "",
        lastQrMediaKey: "",
      });
    }
  }

  start() {
    if (!this.isEnabled()) {
      return false;
    }

    if (this.running) {
      return true;
    }

    this.running = true;
    this.attachJobRunnerListeners();
    this.statusPollTimer = setInterval(() => {
      void this.pollTrackedJobs();
    }, Math.max(5000, Number(this.telegramConfig.statusPollIntervalMs || 15000)));
    void this.pollLoop();
    this.logger.log("Telegram bot polling started.");
    return true;
  }

  stop() {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
    if (this.statusPollTimer) {
      clearInterval(this.statusPollTimer);
      this.statusPollTimer = null;
    }
    this.detachJobRunnerListeners();
  }

  attachJobRunnerListeners() {
    if (this.listenersAttached || !this.jobRunner) {
      return;
    }

    this.boundListeners = {
      started: (job) => void this.handleJobStarted(job),
      log: (entry) => void this.handleJobLog(entry),
      completed: (job) => void this.handleJobCompleted(job),
      failed: (job) => void this.handleJobFailed(job),
      cancelled: (job) => void this.handleJobCancelled(job),
    };

    this.jobRunner.on("job:started", this.boundListeners.started);
    this.jobRunner.on("job:log", this.boundListeners.log);
    this.jobRunner.on("job:completed", this.boundListeners.completed);
    this.jobRunner.on("job:failed", this.boundListeners.failed);
    this.jobRunner.on("job:cancelled", this.boundListeners.cancelled);
    this.listenersAttached = true;
  }

  detachJobRunnerListeners() {
    if (!this.listenersAttached || !this.boundListeners || !this.jobRunner) {
      return;
    }

    this.jobRunner.off("job:started", this.boundListeners.started);
    this.jobRunner.off("job:log", this.boundListeners.log);
    this.jobRunner.off("job:completed", this.boundListeners.completed);
    this.jobRunner.off("job:failed", this.boundListeners.failed);
    this.jobRunner.off("job:cancelled", this.boundListeners.cancelled);
    this.boundListeners = null;
    this.listenersAttached = false;
  }

  async pollLoop() {
    while (this.running) {
      this.abortController = new AbortController();

      try {
        const updates = await this.getUpdates({
          offset: this.offset,
          timeout: this.telegramConfig.pollingTimeoutSeconds,
          signal: this.abortController.signal,
        });

        for (const update of updates) {
          this.offset = Math.max(this.offset, Number(update.update_id || 0) + 1);
          await this.handleUpdate(update);
        }
      } catch (error) {
        if (!this.running && error.name === "AbortError") {
          break;
        }

        this.logger.error(`Telegram polling error: ${error.message}`);
        await sleep(this.telegramConfig.retryDelayMs || 5000);
      } finally {
        this.abortController = null;
      }
    }
  }

  async getUpdates({ offset = 0, timeout = 30, signal } = {}) {
    return this.apiRequest(
      "getUpdates",
      {
        offset,
        timeout,
        allowed_updates: ["message", "callback_query"],
      },
      { signal }
    );
  }

  async handleUpdate(update) {
    const callbackQuery = update?.callback_query;
    if (callbackQuery) {
      await this.handleCallbackQuery(callbackQuery);
      return;
    }

    const message = update?.message;
    const chatId = message?.chat?.id;
    if (!message || chatId === undefined || chatId === null) {
      return;
    }

    try {
      this.rememberChatProfile(message);
      if (!this.isAuthorizedChat(chatId)) {
        if (message.text || message.document) {
          await this.sendMessage(
            chatId,
            "Chat ini belum diizinkan untuk memakai bot Turnitin ini."
          ).catch(() => null);
        }
        return;
      }

      const pendingSubmission = this.pendingSubmissions.get(String(chatId)) || null;
      if (message.document) {
        await this.handleDocumentMessage(message);
        return;
      }

      const text = String(message.text || "").trim();
      if (!text) {
        return;
      }

      const command = text.split(/\s+/, 1)[0].toLowerCase();
      if (this.isAdminCommand(command)) {
        if (!this.isAdminChat(chatId)) {
          await this.sendAdminAccessDenied(chatId);
          return;
        }

        await this.handleAdminCommand(chatId, text);
        return;
      }

      const filterPreset = this.resolveFilterPreset(text);
      if (pendingSubmission) {
        if (command === "/cancel" || /^batal$/i.test(text)) {
          await this.cancelPendingSubmission(chatId);
          return;
        }

        if (command === "/status") {
          await this.sendStatus(chatId);
          return;
        }

        if (pendingSubmission.step === "filter") {
          if (filterPreset) {
            await this.finalizePendingSubmission(chatId, {
              reportOptions: filterPreset.reportOptions,
            });
            return;
          }

          if (command === "/skip") {
            await this.finalizePendingSubmission(chatId, {
              reportOptions: this.buildDefaultReportOptions(),
            });
            return;
          }

          await this.promptFilterSelection(chatId);
          return;
        }

        if (command === "/skip" || /^pakai nama file$/i.test(text)) {
          await this.promptFilterSelection(chatId, {
            title: this.buildDefaultTitle(pendingSubmission.originalName),
          });
          return;
        }

        if (filterPreset) {
          await this.promptTitleSelection(chatId);
          return;
        }

        if (!text.startsWith("/")) {
          await this.promptFilterSelection(chatId, {
            title: text,
          });
          return;
        }
      }

      if (/^lanjut cek dokumen$/i.test(text)) {
        return;
      }

      if (command === "/start" || command === "/help") {
        if (command === "/start") {
          await this.sendStartWelcome(message);
        } else {
          await this.sendHelp(chatId);
        }
        return;
      }

      if (command === "/status") {
        await this.sendStatus(chatId);
        return;
      }

      if (command === "/skip" || command === "/cancel" || /^batal$/i.test(text)) {
        if (await this.cancelLatestActiveJob(chatId)) {
          return;
        }
        if (await this.cancelLatestPendingPayment(chatId)) {
          return;
        }
        return;
      }

      if (filterPreset || /^pakai nama file$/i.test(text)) {
        await this.sendMessage(chatId, "Kirim file dulu, lalu pilih judul dan filter.", {
          replyMarkup: this.buildNextActionReplyMarkup(),
        });
        return;
      }

      await this.sendMessage(
        chatId,
        "Kirim file sebagai document. Bot akan pakai 1 pesan progres sampai selesai.",
        {
          replyMarkup: this.buildNextActionReplyMarkup(),
        }
      );
    } catch (error) {
      this.logger.error(`Telegram update handling error: ${error.message}`);
      await this.sendMessage(
        chatId,
        `Permintaan gagal diproses: ${truncate(error.message, 160)}`
      ).catch(() => null);
    }
  }

  async handleCallbackQuery(callbackQuery) {
    const callbackId = callbackQuery?.id;
    const message = callbackQuery?.message || null;
    const chatId = message?.chat?.id;
    const messageId = message?.message_id || null;
    const data = String(callbackQuery?.data || "").trim();
    if (!callbackId || chatId === undefined || chatId === null || !messageId || !data) {
      return;
    }

    try {
      if (!this.isAuthorizedChat(chatId)) {
        await this.answerCallbackQuery(callbackId, "Chat ini tidak diizinkan.");
        return;
      }

      if (data === "draft:title:default") {
        await this.promptFilterSelection(chatId, {
          title: this.buildDefaultTitle(
            this.pendingSubmissions.get(String(chatId))?.originalName || "Turnitin Submission"
          ),
          messageId,
        });
        await this.answerCallbackQuery(callbackId);
        return;
      }

      if (data === "draft:cancel") {
        await this.cancelPendingSubmission(chatId, { messageId });
        await this.answerCallbackQuery(callbackId, "Dibatalkan.");
        return;
      }

      if (data.startsWith("draft:filter:")) {
        const presetKey = data.split(":").slice(2).join(":");
        const preset = this.resolveFilterPreset(presetKey);
        if (!preset) {
          await this.answerCallbackQuery(callbackId, "Filter tidak valid.");
          return;
        }

        await this.finalizePendingSubmission(chatId, {
          reportOptions: preset.reportOptions,
          messageId,
        });
        await this.answerCallbackQuery(callbackId, preset.label);
        return;
      }

      if (data.startsWith("job:cancel:")) {
        const jobId = data.slice("job:cancel:".length);
        const context = this.jobContexts.get(jobId);
        if (!context || context.chatId !== chatId) {
          await this.answerCallbackQuery(callbackId, "Job tidak aktif.");
          return;
        }

        const cancelledJob = this.jobRunner?.cancel
          ? this.jobRunner.cancel(jobId, {
              reason: "Dibatalkan dari Telegram.",
            })
          : null;
        await this.answerCallbackQuery(
          callbackId,
          cancelledJob ? "Job dihentikan." : "Job tidak aktif."
        );
        return;
      }

      if (data.startsWith("payment:check:")) {
        const orderId = data.slice("payment:check:".length);
        const payment = this.pendingPayments.get(orderId);
        if (!payment || String(payment.chatId) !== String(chatId)) {
          await this.answerCallbackQuery(callbackId, "Invoice tidak aktif.");
          return;
        }

        const result = await this.refreshPendingPaymentStatus(orderId, {
          force: true,
        });
        if (result.code === "PAYMENT_COMPLETED") {
          await this.answerCallbackQuery(callbackId, "Pembayaran terkonfirmasi.");
          return;
        }

        if (result.code === "PAYMENT_NOT_CREATED") {
          await this.answerCallbackQuery(callbackId, "Buka Bayar Sekarang dulu.");
          return;
        }

        await this.answerCallbackQuery(
          callbackId,
          `Status pembayaran: ${String(result.status || payment.providerStatus || payment.status || "pending")}`
        );
        return;
      }

      if (data.startsWith("payment:cancel:")) {
        const orderId = data.slice("payment:cancel:".length);
        const payment = this.pendingPayments.get(orderId);
        if (!payment || String(payment.chatId) !== String(chatId)) {
          await this.answerCallbackQuery(callbackId, "Invoice tidak aktif.");
          return;
        }

        await this.cancelPendingPayment(orderId, {
          notice: "Invoice dibatalkan dari Telegram. Kirim file lagi untuk mulai ulang.",
        });
        await this.answerCallbackQuery(callbackId, "Invoice dibatalkan.");
        return;
      }

      if (data === "bot:new") {
        await this.answerCallbackQuery(callbackId, "Kirim file baru sebagai document.");
        return;
      }

      await this.answerCallbackQuery(callbackId);
    } catch (error) {
      this.logger.error(`Telegram callback handling error: ${error.message}`);
      await this.answerCallbackQuery(callbackId, "Aksi gagal diproses.").catch(() => null);
    }
  }

  isAuthorizedChat(chatId) {
    const allowed = this.telegramConfig.allowedChatIds || [];
    if (!allowed.length) {
      return true;
    }

    return allowed.includes(String(chatId));
  }

  rememberChatProfile(message) {
    const chatId = message?.chat?.id;
    if (chatId === undefined || chatId === null) {
      return null;
    }

    const profile = {
      chatId,
      chatType: String(message?.chat?.type || "private"),
      firstName: String(message?.from?.first_name || message?.chat?.first_name || "").trim(),
      lastName: String(message?.from?.last_name || message?.chat?.last_name || "").trim(),
      username: String(message?.from?.username || message?.chat?.username || "").trim(),
      languageCode: String(message?.from?.language_code || "").trim(),
      isAuthorized: this.isAuthorizedChat(chatId),
      isAdmin: this.isAdminChat(chatId),
      updatedAt: new Date().toISOString(),
    };
    profile.displayName = [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim();
    this.chatProfiles.set(String(chatId), profile);
    return profile;
  }

  getChatProfile(chatId) {
    return this.chatProfiles.get(String(chatId)) || null;
  }

  buildWelcomeText(message) {
    const profile = this.rememberChatProfile(message) || this.getChatProfile(message?.chat?.id) || {};
    const paymentEnabled = this.isPaymentEnabled();
    const displayName = profile.displayName || profile.username || "Pengguna";
    const paymentMethod = String(this.pakasirConfig.method || "qris").toUpperCase();
    const chatType = humanizeLabel(profile.chatType, "-");
    const language = String(profile.languageCode || "").trim().toUpperCase() || "-";
    const paymentLines = paymentEnabled
      ? [
          "Pembayaran",
          `Status: Aktif`,
          `Metode: ${paymentMethod}`,
          `Tarif: ${formatCurrencyIdr(this.pakasirConfig.amount)} per dokumen`,
        ]
      : [
          "Pembayaran",
          "Status: Nonaktif",
        ];
    const steps = paymentEnabled
      ? [
          "1. Kirim file sebagai document.",
          "2. Pilih judul dan filter.",
          "3. Selesaikan pembayaran invoice.",
          "4. Bot akan memproses dokumen setelah pembayaran terkonfirmasi.",
        ]
      : [
          "1. Kirim file sebagai document.",
          "2. Pilih judul dan filter.",
          "3. Bot akan langsung memproses dokumen.",
        ];

    return [
      `${TELEGRAM_BOT_LABEL}`,
      "",
      `Selamat datang, ${displayName}.`,
      "Bot ini siap menerima dokumen dan memproses cek similarity dari chat ini.",
      "",
      "Informasi Akun",
      `Nama: ${profile.displayName || "-"}`,
      `Username: ${profile.username ? `@${profile.username}` : "-"}`,
      `Chat ID: ${profile.chatId || "-"}`,
      `Tipe Chat: ${chatType}`,
      `Bahasa: ${language}`,
      `Status Akses: ${profile.isAuthorized ? "Diizinkan" : "Belum diizinkan"}`,
      `Akses Admin: ${profile.isAdmin ? "Ya" : "Tidak"}`,
      "",
      ...paymentLines,
      "",
      "Cara Pakai",
      ...steps,
      "",
      "Perintah Cepat",
      "/status - cek progres terakhir",
      "/cancel - batalkan draft, invoice pending, atau job aktif",
      ...(profile.isAdmin
        ? [
            "",
            "Perintah Admin",
            "/admin - ringkasan runtime bot",
            "/health - status queue dan pool",
            "/pool - ringkasan akun Turnitin",
            "/accounts list - daftar akun di file pool",
            "/accounts add email@example.com | password",
            "/accounts del email@example.com",
          ]
        : []),
    ].join("\n");
  }

  async sendStartWelcome(message) {
    const chatId = message?.chat?.id;
    if (chatId === undefined || chatId === null) {
      return null;
    }

    return this.sendMessage(chatId, this.buildWelcomeText(message), {
      replyMarkup: this.buildNextActionReplyMarkup(),
    });
  }

  async sendAdminAccessDenied(chatId) {
    return this.sendMessage(
      chatId,
      "Perintah admin hanya bisa dipakai oleh chat admin yang terdaftar."
    );
  }

  parseAdminCommandInput(text) {
    const raw = String(text || "").trim();
    const [commandToken = ""] = raw.split(/\s+/, 1);
    const command = commandToken.toLowerCase();
    const rest = raw.slice(commandToken.length).trim();
    return {
      raw,
      command,
      rest,
    };
  }

  buildAdminAccountsHelpText() {
    return [
      `${TELEGRAM_BOT_LABEL} • Kelola Akun`,
      "Gunakan salah satu format ini:",
      "/accounts - ringkasan pool akun",
      "/accounts list",
      "/accounts add email@example.com | password",
      "/accounts del email@example.com",
    ].join("\n");
  }

  resolveAdminAccountsAction(commandInput = {}) {
    const command = String(commandInput.command || "").trim().toLowerCase();
    const rest = String(commandInput.rest || "").trim();

    if (command === "/accountlist") {
      return {
        action: "list",
        payload: "",
      };
    }

    if (["/accountdel", "/accountdelete", "/accountremove"].includes(command)) {
      return {
        action: "delete",
        payload: rest,
      };
    }

    if (command === "/accountadd") {
      return {
        action: "add",
        payload: rest,
      };
    }

    if (command !== "/accounts") {
      return {
        action: null,
        payload: rest,
      };
    }

    if (!rest) {
      return {
        action: "summary",
        payload: "",
      };
    }

    const [subcommandToken = ""] = rest.split(/\s+/, 1);
    const payload = rest.slice(subcommandToken.length).trim();
    const subcommand = subcommandToken.toLowerCase();

    if (!subcommand || ["summary", "pool"].includes(subcommand)) {
      return {
        action: "summary",
        payload,
      };
    }

    if (["list", "ls"].includes(subcommand)) {
      return {
        action: "list",
        payload,
      };
    }

    if (["add", "new", "append"].includes(subcommand)) {
      return {
        action: "add",
        payload,
      };
    }

    if (["del", "delete", "remove", "rm"].includes(subcommand)) {
      return {
        action: "delete",
        payload,
      };
    }

    return {
      action: null,
      payload: rest,
    };
  }

  parseAdminAccountBatch(payload) {
    const accounts = parseAccountsFromText(String(payload || "").trim());
    if (!accounts.length) {
      throw new Error('Format tambah akun tidak valid. Gunakan "email@example.com | password".');
    }

    return accounts.map((account) => ({
      email: account.email,
      password: account.password,
    }));
  }

  parseAdminAccountEmail(payload) {
    const email = String(payload || "").trim();
    if (!email) {
      throw new Error("Email akun yang akan dihapus wajib diisi.");
    }

    return email;
  }

  async listConfiguredAccounts() {
    return listAccounts(this.config.accountsFile);
  }

  buildConfiguredAccountsText(accounts = []) {
    const lines = [
      `${TELEGRAM_BOT_LABEL} • File Akun`,
      `Total ${accounts.length} akun terdaftar.`,
    ];

    if (!accounts.length) {
      lines.push("File akun masih kosong.");
      return lines.join("\n");
    }

    lines.push("");
    accounts.slice(0, 20).forEach((account, index) => {
      lines.push(`${index + 1}. ${account.email}`);
    });

    if (accounts.length > 20) {
      lines.push(`+${accounts.length - 20} akun lainnya tidak ditampilkan.`);
    }

    return lines.join("\n");
  }

  async handleAdminAccountsCommand(chatId, commandInput = {}) {
    const operation = this.resolveAdminAccountsAction(commandInput);
    if (operation.action === "summary") {
      const snapshot = await this.collectAdminRuntimeSnapshot();
      await this.sendMessage(chatId, this.buildAdminPoolText(snapshot));
      return;
    }

    if (operation.action === "list") {
      const accounts = await this.listConfiguredAccounts();
      await this.sendMessage(chatId, this.buildConfiguredAccountsText(accounts));
      return;
    }

    if (operation.action === "add") {
      const accounts = this.parseAdminAccountBatch(operation.payload);
      const result = await appendAccounts(this.config.accountsFile, accounts);
      if (!result.addedAccounts.length) {
        await this.sendMessage(
          chatId,
          [
            `${TELEGRAM_BOT_LABEL} • Kelola Akun`,
            "Tidak ada akun baru yang ditambahkan.",
            result.skippedAccounts.length
              ? `Semua akun sudah ada: ${result.skippedAccounts.slice(0, 5).join(", ")}`
              : "Periksa format perintah dan coba lagi.",
          ].join("\n")
        );
        return;
      }

      await this.sendMessage(
        chatId,
        [
          `${TELEGRAM_BOT_LABEL} • Kelola Akun`,
          `${result.addedAccounts.length} akun berhasil ditambahkan.`,
          `Email pertama: ${result.addedAccounts[0].email}`,
          result.skippedAccounts.length
            ? `Duplikat dilewati: ${result.skippedAccounts.length}`
            : null,
          `Total akun: ${result.totalAccounts}`,
        ]
          .filter(Boolean)
          .join("\n")
      );
      return;
    }

    if (operation.action === "delete") {
      const email = this.parseAdminAccountEmail(operation.payload);
      const result = await removeAccount(this.config.accountsFile, email);
      await this.sendMessage(
        chatId,
        [
          `${TELEGRAM_BOT_LABEL} • Kelola Akun`,
          "Akun berhasil dihapus dari file pool.",
          `Email: ${result.removedAccount.email}`,
          `Sisa akun: ${result.totalAccounts}`,
        ].join("\n")
      );
      return;
    }

    await this.sendMessage(chatId, this.buildAdminAccountsHelpText());
  }

  async collectAdminRuntimeSnapshot() {
    const runtime = {
      runningJobCount: Number(this.jobRunner?.runningCount) || 0,
      queuedJobCount: Number(this.jobRunner?.queuedCount) || 0,
      maxConcurrentJobs: this.turnitinService?.getMaxConcurrency
        ? await this.turnitinService.getMaxConcurrency().catch(() => null)
        : null,
    };

    if (!this.turnitinService) {
      return {
        runtime,
        poolAlert: null,
        accountSummaries: [],
      };
    }

    const accounts = await this.turnitinService.getAccounts().catch(() => []);
    const accountSummaries = this.turnitinService.buildAccountUsageSummaries
      ? this.turnitinService.buildAccountUsageSummaries(accounts)
      : [];
    const poolAlert = this.turnitinService.buildPoolAlertSnapshot
      ? this.turnitinService.buildPoolAlertSnapshot(accounts)
      : this.turnitinService.getPoolAlertSnapshot
        ? await this.turnitinService.getPoolAlertSnapshot().catch(() => null)
        : null;

    return {
      runtime,
      poolAlert,
      accountSummaries,
    };
  }

  buildAdminOverviewText(chatId, snapshot = {}) {
    const runtime = snapshot.runtime || {};
    const poolAlert = snapshot.poolAlert || {};
    const totals = poolAlert.totals || {};
    const paymentEnabled = this.isPaymentEnabled();
    const paymentMethod = String(this.pakasirConfig.method || "qris").toUpperCase();
    const queueLine = [
      `Queue ${Number(runtime.runningJobCount) || 0} running`,
      `${Number(runtime.queuedJobCount) || 0} queued`,
      Number(runtime.maxConcurrentJobs) > 0 ? `max ${Number(runtime.maxConcurrentJobs)}` : null,
    ]
      .filter(Boolean)
      .join(" • ");

    return [
      `${TELEGRAM_BOT_LABEL} • Admin`,
      `Chat ID ${chatId}`,
      queueLine,
      paymentEnabled
        ? `Pembayaran Aktif • ${paymentMethod} • ${formatCurrencyIdr(
            this.pakasirConfig.amount
          )} per dokumen`
        : "Pembayaran Nonaktif",
      poolAlert.headline || "Pool akun belum tersedia.",
      poolAlert.detailText ||
        `Akun usable ${Number(totals.usableAccounts) || 0}/${Number(totals.accountCount) || 0}`,
      "",
      "Perintah Admin",
      "/health - status queue dan pool",
      "/pool - ringkasan akun Turnitin",
      "/accounts list - daftar akun di file pool",
      "/accounts add email@example.com | password",
      "/accounts del email@example.com",
    ].join("\n");
  }

  buildAdminHealthText(snapshot = {}) {
    const runtime = snapshot.runtime || {};
    const poolAlert = snapshot.poolAlert || {};
    const totals = poolAlert.totals || {};

    return [
      `${TELEGRAM_BOT_LABEL} • Admin Health`,
      `Queue ${Number(runtime.runningJobCount) || 0} running • ${Number(
        runtime.queuedJobCount
      ) || 0} queued`,
      Number(runtime.maxConcurrentJobs) > 0
        ? `Max Parallel ${Number(runtime.maxConcurrentJobs)}`
        : null,
      `Status Pool ${humanizeLabel(poolAlert.level || "unknown", "Unknown")}`,
      `Akun usable ${Number(totals.usableAccounts) || 0}/${Number(totals.accountCount) || 0}`,
      `Assignment siap ${Number(totals.submittableAssignments) || 0}`,
      `Slot resubmit ${Number(totals.resubmittableAssignments) || 0}`,
      `Pembayaran ${this.isPaymentEnabled() ? "Aktif" : "Nonaktif"}`,
      poolAlert.generatedAt ? `Update ${formatTimeWib(poolAlert.generatedAt)} WIB` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  buildAdminPoolText(snapshot = {}) {
    const poolAlert = snapshot.poolAlert || {};
    const accountSummaries = Array.isArray(snapshot.accountSummaries)
      ? snapshot.accountSummaries
      : [];

    const lines = [
      `${TELEGRAM_BOT_LABEL} • Pool Akun`,
      poolAlert.detailText || "Belum ada ringkasan akun.",
    ];

    if (!accountSummaries.length) {
      lines.push("Belum ada data scan akun untuk ditampilkan.");
      return lines.join("\n");
    }

    lines.push("");
    accountSummaries.slice(0, 12).forEach((summary, index) => {
      const totals = summary.usageTotals || {};
      lines.push(
        `${index + 1}. ${maskEmail(summary.accountEmail || "-")} • ${humanizeLabel(
          summary.availability || "unknown",
          "Unknown"
        )} • submit ${Number(totals.submittableAssignments) || 0} • resubmit ${Number(
          totals.resubmittableAssignments
        ) || 0} • kosong ${Number(totals.emptyAssignments) || 0} • habis ${Number(
          totals.exhaustedAssignments
        ) || 0}`
      );
    });

    if (accountSummaries.length > 12) {
      lines.push(`+${accountSummaries.length - 12} akun lainnya tidak ditampilkan.`);
    }

    return lines.join("\n");
  }

  async handleAdminCommand(chatId, text) {
    const commandInput = this.parseAdminCommandInput(text);
    const normalizedCommand = commandInput.command;

    if (
      normalizedCommand === "/accounts" ||
      normalizedCommand === "/accountlist" ||
      normalizedCommand === "/accountadd" ||
      normalizedCommand === "/accountdel" ||
      normalizedCommand === "/accountdelete" ||
      normalizedCommand === "/accountremove"
    ) {
      await this.handleAdminAccountsCommand(chatId, commandInput);
      return;
    }

    const snapshot = await this.collectAdminRuntimeSnapshot();

    if (normalizedCommand === "/health") {
      await this.sendMessage(chatId, this.buildAdminHealthText(snapshot));
      return;
    }

    if (normalizedCommand === "/pool") {
      await this.sendMessage(chatId, this.buildAdminPoolText(snapshot));
      return;
    }

    await this.sendMessage(chatId, this.buildAdminOverviewText(chatId, snapshot));
  }

  buildAdminPoolAlertText(snapshot = {}, runtime = {}) {
    const totals = snapshot.totals || {};
    const severityLabel =
      snapshot.level === "critical"
        ? "KRITIS"
        : snapshot.level === "warning"
          ? "WARNING"
          : "NORMAL";

    return [
      `${TELEGRAM_BOT_LABEL} • Alert Admin`,
      `Status ${severityLabel}`,
      snapshot.headline || "Status pool diperbarui.",
      `Akun usable ${Number(totals.usableAccounts) || 0}/${Number(totals.accountCount) || 0}`,
      `Assignment siap ${Number(totals.submittableAssignments) || 0}`,
      `Slot resubmit ${Number(totals.resubmittableAssignments) || 0}`,
      `Queue ${Number(runtime.runningJobCount) || 0} running • ${Number(runtime.queuedJobCount) || 0} queued`,
      `Threshold ${Number(snapshot.thresholds?.usableAccountsThreshold) || 0} akun • ${Number(
        snapshot.thresholds?.submittableAssignmentsThreshold
      ) || 0} assignment`,
      `Waktu ${formatTimeWib(snapshot.generatedAt || Date.now())} WIB`,
    ].join("\n");
  }

  async notifyAdminPoolAlert(snapshot = {}, { runtime = {}, force = false } = {}) {
    if (!this.canSendAdminAlerts()) {
      return {
        sent: false,
        reason: "ADMIN_CHAT_NOT_CONFIGURED",
      };
    }

    const nextLevel = String(snapshot.level || "healthy").trim().toLowerCase();
    const nextKey = [
      nextLevel,
      Number(snapshot?.totals?.usableAccounts) || 0,
      Number(snapshot?.totals?.submittableAssignments) || 0,
      Number(runtime?.runningJobCount) || 0,
      Number(runtime?.queuedJobCount) || 0,
    ].join(":");
    const cooldownMs = Math.max(0, Number(this.telegramConfig.adminAlertCooldownMs) || 0);
    const now = Date.now();
    const levelChanged = nextLevel !== this.adminAlertState.lastLevel;
    const keyChanged = nextKey !== this.adminAlertState.lastKey;
    const cooldownElapsed = now - Number(this.adminAlertState.lastSentAt || 0) >= cooldownMs;
    const shouldSend =
      force ||
      (nextLevel === "healthy"
        ? this.adminAlertState.lastLevel !== "healthy"
        : levelChanged || (keyChanged && cooldownElapsed));

    if (!shouldSend) {
      return {
        sent: false,
        reason: "ADMIN_ALERT_THROTTLED",
      };
    }

    const text = this.buildAdminPoolAlertText(snapshot, runtime);
    const adminChatIds = this.getAdminChatIds();
    const results = await Promise.allSettled(
      adminChatIds.map((chatId) => this.sendMessage(chatId, text))
    );

    const successCount = results.filter((result) => result.status === "fulfilled").length;
    if (successCount > 0) {
      this.adminAlertState = {
        lastLevel: nextLevel,
        lastKey: nextKey,
        lastSentAt: now,
      };
    }

    return {
      sent: successCount > 0,
      successCount,
      total: adminChatIds.length,
      reason: successCount > 0 ? null : "ADMIN_ALERT_FAILED",
    };
  }

  async handleDocumentMessage(message) {
    const chatId = message.chat.id;
    const chatKey = String(chatId);
    this.rememberChatProfile(message);
    const document = message.document;
    if (!document?.file_id) {
      await this.sendMessage(chatId, "File document Telegram tidak valid.");
      return;
    }

    const captionTitle = this.extractCaptionTitle(message);
    const captionFilter = this.extractCaptionFilter(message);

    const pendingDraft = this.pendingSubmissions.get(chatKey) || null;
    if (pendingDraft) {
      if (captionFilter) {
        const download = await this.downloadTelegramDocument(document);
        const reusableMessageId = this.chatReadyMessages.get(chatKey) || null;
        this.chatReadyMessages.delete(chatKey);
        await this.submitPreparedSubmission(chatId, {
          filePath: download.filePath,
          originalName: download.originalName,
          title: captionTitle || this.buildDefaultTitle(download.originalName),
          reportOptions: captionFilter.reportOptions,
          statusMessageId: reusableMessageId,
          message,
        });
        return;
      }

      await this.sendMessage(
        chatId,
        pendingDraft.step === "filter"
          ? "Selesaikan pilihan filter draft yang aktif dulu, atau kirim file baru dengan caption `filter: off|standar|lengkap` agar langsung masuk queue."
          : "Selesaikan judul draft yang aktif dulu, atau kirim file baru dengan caption `filter: off|standar|lengkap` agar langsung masuk queue.",
        {
          replyMarkup:
            pendingDraft.step === "filter"
              ? this.buildDraftFilterReplyMarkup()
              : this.buildDraftTitleReplyMarkup(),
        }
      );
      return;
    }

    if (
      Number(document.file_size || 0) > 0 &&
      Number(document.file_size || 0) > this.config.maxFileBytes
    ) {
      await this.sendMessage(
        chatId,
        `Ukuran file melebihi batas ${Math.round(this.config.maxFileBytes / (1024 * 1024))} MB.`
      );
      return;
    }

    const download = await this.downloadTelegramDocument(document);
    const reusableMessageId = this.chatReadyMessages.get(chatKey) || null;
    this.chatReadyMessages.delete(chatKey);
    if (captionFilter) {
      await this.submitPreparedSubmission(chatId, {
        filePath: download.filePath,
        originalName: download.originalName,
        title: captionTitle || this.buildDefaultTitle(download.originalName),
        reportOptions: captionFilter.reportOptions,
        statusMessageId: reusableMessageId,
        message,
      });
      return;
    }

    this.pendingSubmissions.set(chatKey, {
      chatId,
      filePath: download.filePath,
      originalName: download.originalName,
      title: captionTitle || "",
      step: captionTitle ? "filter" : "title",
      reportOptions: null,
      statusMessageId: reusableMessageId,
      receivedAt: Date.now(),
      expiresAt: Date.now() + Number(this.telegramConfig.titlePromptTimeoutMs || 60000),
    });

    if (captionTitle) {
      await this.promptFilterSelection(chatId);
      return;
    }

    await this.promptTitleSelection(chatId);
  }

  async sendHelp(chatId) {
    const paymentEnabled = this.isPaymentEnabled();
    await this.sendMessage(
      chatId,
      [
        "Kirim file sebagai document.",
        "Judul bisa diketik atau pakai nama file.",
        "Filter: Off, Standar, atau Lengkap.",
        paymentEnabled
          ? `Setelah judul/filter siap, bot kirim invoice ${formatCurrencyIdr(
              this.pakasirConfig.amount
            )} sebelum dokumen diproses.`
          : "Setelah judul/filter siap, dokumen langsung masuk queue.",
        "Untuk banyak file sekaligus, pakai caption `filter: off|standar|lengkap` agar langsung diproses sesuai alur aktif.",
        "Bot akan update 1 pesan progres sampai selesai.",
        ...(this.isAdminChat(chatId)
          ? [
              "",
              "Perintah admin:",
              "/admin - ringkasan runtime bot",
              "/health - status queue dan pool",
              "/pool - ringkasan akun Turnitin",
              "/accounts list - daftar akun di file pool",
              "/accounts add email@example.com | password",
              "/accounts del email@example.com",
            ]
          : []),
      ].join("\n"),
      {
        replyMarkup: this.buildNextActionReplyMarkup(),
      }
    );
  }

  async sendStatus(chatId) {
    const pending = this.pendingSubmissions.get(String(chatId)) || null;
    const pendingPayments = this.listPendingPaymentsForChat(chatId, 3);
    const jobIds = this.chatJobHistory.get(String(chatId)) || [];
    if (!jobIds.length && !pending && !pendingPayments.length) {
      await this.sendMessage(chatId, "Belum ada job dari chat ini.");
      return;
    }

    const lines = [];
    if (pending) {
      const remainingMs = Math.max(0, pending.expiresAt - Date.now());
      lines.push(
        `draft ${pending.step === "filter" ? "filter" : "judul"} | ${formatDurationRough(
          remainingMs
        )} | ${truncate(pending.originalName, 36)}`
      );
    }

    lines.push(
      ...pendingPayments.map(
        (payment) =>
          `payment ${payment.status || "pending"} | ${formatCurrencyIdr(payment.amount)} | ${truncate(
            payment.originalName,
            28
          )} | ${shortOrderId(payment.orderId)}`
      )
    );

    if (this.jobStore) {
      const jobs = jobIds
        .map((jobId) => this.jobStore.get(jobId))
        .filter(Boolean)
        .slice(0, 5);
      lines.push(...jobs.map((job) => this.buildCompactJobLine(job)));
    }

    await this.sendMessage(chatId, `Status job:\n${lines.join("\n")}`, {
      replyMarkup: this.buildNextActionReplyMarkup(),
    });
  }

  extractCaptionTitle(message) {
    return String(message.caption || "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !/^filter\s*:/i.test(line))
      .find(Boolean) || "";
  }

  extractCaptionFilter(message) {
    const line = String(message.caption || "")
      .split("\n")
      .map((value) => value.trim())
      .find((value) => /^filter\s*:/i.test(value));
    if (!line) {
      return null;
    }

    return this.resolveFilterPreset(line.replace(/^filter\s*:/i, "").trim());
  }

  rememberChatJob(chatId, jobId) {
    const key = String(chatId);
    const existing = this.chatJobHistory.get(key) || [];
    const next = [jobId, ...existing.filter((value) => value !== jobId)].slice(0, 20);
    this.chatJobHistory.set(key, next);

    const dropped = existing.slice(19);
    for (const droppedJobId of dropped) {
      if (!next.includes(droppedJobId)) {
        this.jobContexts.delete(droppedJobId);
      }
    }
  }

  listPendingPaymentsForChat(chatId, limit = 5) {
    return [...this.pendingPayments.values()]
      .filter(
        (payment) =>
          String(payment?.chatId) === String(chatId) &&
          !PAYMENT_TERMINAL_STATUSES.has(String(payment?.status || "pending").toLowerCase())
      )
      .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))
      .slice(0, limit);
  }

  findLatestPendingPaymentForChat(chatId) {
    return this.listPendingPaymentsForChat(chatId, 1)[0] || null;
  }

  buildDefaultTitle(originalName) {
    return path.parse(originalName).name || "Turnitin Submission";
  }

  buildDefaultReportOptions() {
    return {
      excludeQuotes: false,
      excludeBibliography: false,
      excludeMatches: false,
      excludeMatchesWordCount: Number(this.config.defaultExcludeMatchesWordCount) || 10,
    };
  }

  buildStandardReportOptions() {
    return {
      excludeQuotes: true,
      excludeBibliography: true,
      excludeMatches: false,
      excludeMatchesWordCount: Number(this.config.defaultExcludeMatchesWordCount) || 10,
    };
  }

  buildFullReportOptions() {
    return {
      excludeQuotes: true,
      excludeBibliography: true,
      excludeMatches: true,
      excludeMatchesWordCount: Number(this.config.defaultExcludeMatchesWordCount) || 10,
    };
  }

  resolveFilterPreset(value) {
    const normalized = String(value || "")
      .trim()
      .toLowerCase();
    if (!normalized) {
      return null;
    }

    if (
      normalized === "draft:filter:off" ||
      /^(filter\s*)?(off|default|tanpa filter|mati semua)$/i.test(normalized)
    ) {
      return {
        label: "Filter Off",
        reportOptions: this.buildDefaultReportOptions(),
      };
    }

    if (
      normalized === "draft:filter:standard" ||
      /^(filter\s*)?(standar|standard|q\+b|quotes?\s*\+\s*biblio(graphy)?|quotes?\s*biblio(graphy)?)$/i.test(
        normalized
      )
    ) {
      return {
        label: "Filter Standar",
        reportOptions: this.buildStandardReportOptions(),
      };
    }

    if (
      normalized === "draft:filter:full" ||
      /^(filter\s*)?(lengkap|full|all on|semua filter|q\+b\+m)$/i.test(normalized)
    ) {
      return {
        label: "Filter Lengkap",
        reportOptions: this.buildFullReportOptions(),
      };
    }

    return null;
  }

  buildDraftTitleReplyMarkup() {
    return {
      keyboard: [[{ text: "Pakai nama file" }], [{ text: "Batal" }]],
      resize_keyboard: true,
      one_time_keyboard: true,
      input_field_placeholder: "Ketik judul atau pakai nama file",
    };
  }

  buildDraftFilterReplyMarkup() {
    return {
      keyboard: [
        [{ text: "Filter Off" }, { text: "Filter Standar" }],
        [{ text: "Filter Lengkap" }],
        [{ text: "Batal" }],
      ],
      resize_keyboard: true,
      one_time_keyboard: true,
      input_field_placeholder: "Pilih filter",
    };
  }

  buildActiveJobReplyMarkup() {
    return {
      inline_keyboard: [[{ text: "Batal", callback_data: "job:cancel:active" }]],
    };
  }

  buildNextActionReplyMarkup() {
    return {
      keyboard: [[{ text: "Lanjut Cek Dokumen" }]],
      resize_keyboard: true,
      one_time_keyboard: true,
      input_field_placeholder: "Tekan lanjut untuk cek dokumen baru",
    };
  }

  buildJobCancelInlineReplyMarkup(jobId) {
    return {
      inline_keyboard: [[{ text: "Batal", callback_data: `job:cancel:${jobId}` }]],
    };
  }

  buildNextActionInlineReplyMarkup() {
    return {
      inline_keyboard: [[{ text: "Lanjut Cek Dokumen", callback_data: "bot:new" }]],
    };
  }

  buildProgressBar(progressPercent) {
    const safePercent = clamp(Number(progressPercent) || 0, 0, 100);
    const totalSlots = 10;
    const filled = clamp(Math.round((safePercent / 100) * totalSlots), 0, totalSlots);
    return `[${"#".repeat(filled)}${"-".repeat(totalSlots - filled)}]`;
  }

  buildTitlePromptText(originalName) {
    return [
      TELEGRAM_BOT_LABEL,
      `${this.buildProgressBar(0)} 0%`,
      truncate(originalName, 64),
      "Ketik judul atau pakai nama file.",
    ].join("\n");
  }

  buildFilterPromptText(originalName) {
    return [
      TELEGRAM_BOT_LABEL,
      `${this.buildProgressBar(0)} 0%`,
      truncate(originalName, 64),
      "Pilih filter:",
      "Off = tanpa filter",
      "Standar = kecualikan kutipan + daftar pustaka",
      `Lengkap = Standar + kecualikan match < ${Number(
        this.config.defaultExcludeMatchesWordCount
      ) || 10} kata`,
    ].join("\n");
  }

  buildReadyText() {
    return [
      TELEGRAM_BOT_LABEL,
      `${this.buildProgressBar(0)} 0%`,
      "Siap cek dokumen baru.",
      "Kirim file sebagai document.",
    ].join("\n");
  }

  buildPaymentReplyMarkup(payment) {
    return {
      inline_keyboard: [
        [{ text: "Bayar Sekarang", url: payment.paymentUrl }],
        [
          { text: "Cek Pembayaran", callback_data: `payment:check:${payment.orderId}` },
          { text: "Batal", callback_data: `payment:cancel:${payment.orderId}` },
        ],
      ],
    };
  }

  buildPaymentPendingText(payment) {
    return [
      TELEGRAM_BOT_LABEL,
      `${this.buildProgressBar(12)} 12%`,
      truncate(payment.originalName || payment.title, 64),
      "Menunggu Pembayaran",
      `Invoice ${payment.orderId}`,
      `Tagihan ${formatCurrencyIdr(payment.amount)}`,
      payment.totalPayment && Number(payment.totalPayment) > Number(payment.amount)
        ? `Total Bayar ${formatCurrencyIdr(payment.totalPayment)}`
        : null,
      `Metode ${String(payment.paymentMethod || this.pakasirConfig.method || "qris").toUpperCase()}`,
      payment.expiredAt ? `Expired ${formatTimeWib(payment.expiredAt)} WIB` : null,
      payment.paymentMethod === "qris"
        ? "Scan QRIS di chat ini atau tekan Bayar Sekarang, lalu tekan Cek Pembayaran setelah transfer selesai."
        : "Klik Bayar Sekarang lalu tekan Cek Pembayaran setelah transfer selesai.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  buildPaymentCancelledText(payment, notice = "Invoice dibatalkan. Kirim file lagi untuk mulai ulang.") {
    return [
      TELEGRAM_BOT_LABEL,
      `${this.buildProgressBar(0)} 0%`,
      truncate(payment.originalName || payment.title, 64),
      "Pembayaran Dibatalkan",
      notice,
    ].join("\n");
  }

  buildCompactJobLine(job) {
    const progress = `${String(this.estimateProgressPercent(job)).padStart(2, "0")}%`;
    const similarity = job.result?.similarity ? ` • ${job.result.similarity}` : "";
    return `${progress} • ${job.status}${similarity} • ${truncate(
      job.originalName || job.title,
      28
    )}`;
  }

  findLatestActiveJobForChat(chatId) {
    const jobIds = this.chatJobHistory.get(String(chatId)) || [];
    if (!this.jobStore) {
      return [...this.jobContexts.entries()]
        .filter(([, context]) => context?.chatId === chatId)
        .map(([jobId]) => ({ id: jobId, status: "running" }))
        .find(Boolean) || null;
    }

    for (const jobId of jobIds) {
      const job = this.jobStore.get(jobId);
      if (job && ["queued", "running"].includes(job.status)) {
        return job;
      }
    }

    for (const [jobId, context] of this.jobContexts.entries()) {
      if (context?.chatId !== chatId) {
        continue;
      }

      const job = this.jobStore.get(jobId);
      if (job && ["queued", "running"].includes(job.status)) {
        return job;
      }
    }

    return null;
  }

  async cancelLatestActiveJob(chatId) {
    const job = this.findLatestActiveJobForChat(chatId);
    if (!job || typeof this.jobRunner?.cancel !== "function") {
      return false;
    }

    this.jobRunner.cancel(job.id, {
      reason: "Dibatalkan dari Telegram.",
    });
    return true;
  }

  async showReadyState(chatId) {
    const key = String(chatId);
    const messageId = this.chatReadyMessages.get(key) || null;
    const response = await this.replaceChatMessage(chatId, messageId, this.buildReadyText(), {
      replyMarkup: this.buildNextActionReplyMarkup(),
    });
    if (response?.message_id) {
      this.chatReadyMessages.set(key, response.message_id);
    }
    return response;
  }

  async persistPendingPayment(payment) {
    if (!this.stateStore?.upsertPayment) {
      return payment;
    }

    return this.stateStore.upsertPayment({
      ...payment,
      lastStatusText: undefined,
      lastReplyMarkupKey: undefined,
    });
  }

  async updateStoredPayment(orderId, updates = {}) {
    if (!this.stateStore?.updatePayment) {
      const current = this.pendingPayments.get(orderId) || null;
      return current ? { ...current, ...updates } : null;
    }

    try {
      return await this.stateStore.updatePayment(orderId, updates);
    } catch (error) {
      this.logger.error(`State payment update failed: ${error.message}`);
      return null;
    }
  }

  async upsertPendingPaymentMessage(orderId, { text = null, replyMarkup = null } = {}) {
    const payment = this.pendingPayments.get(orderId);
    if (!payment) {
      return null;
    }

    const paymentText = text || this.buildPaymentPendingText(payment);
    const markup = replyMarkup || this.buildPaymentReplyMarkup(payment);
    const replyMarkupKey = JSON.stringify(markup || null);
    const qrImagePath = await this.ensurePaymentQrImage(payment);
    const wantsPhotoMessage = Boolean(qrImagePath);
    const nextStatusMessageKind = wantsPhotoMessage ? "photo" : "text";
    const qrMediaKey = wantsPhotoMessage
      ? `${String(payment.paymentNumber || "").trim()}::${String(qrImagePath || "").trim()}`
      : "";
    if (
      payment.lastStatusText === paymentText &&
      payment.lastReplyMarkupKey === replyMarkupKey &&
      payment.statusMessageId &&
      payment.statusMessageKind === nextStatusMessageKind &&
      payment.lastQrMediaKey === qrMediaKey
    ) {
      return payment;
    }

    let response = null;
    if (wantsPhotoMessage) {
      if (payment.statusMessageId && payment.statusMessageKind === "photo") {
        try {
          if (payment.lastQrMediaKey && payment.lastQrMediaKey === qrMediaKey) {
            response = await this.editMessageCaption(
              payment.chatId,
              payment.statusMessageId,
              paymentText,
              {
                replyMarkup: markup,
              }
            );
          } else {
            response = await this.editPhotoMessage(
              payment.chatId,
              payment.statusMessageId,
              qrImagePath,
              {
                caption: paymentText,
                replyMarkup: markup,
              }
            );
          }
        } catch (error) {
          if (!shouldReplaceStatusMessageAfterEditError(error)) {
            throw error;
          }
        }
      }

      if (!response) {
        if (payment.statusMessageId) {
          await this.deleteMessage(payment.chatId, payment.statusMessageId).catch(() => null);
        }
        response = await this.sendPhoto(payment.chatId, qrImagePath, {
          caption: paymentText,
          replyMarkup: markup,
        });
      }
    } else if (payment.statusMessageKind === "photo" && payment.statusMessageId) {
      response = await this.replaceChatMessage(
        payment.chatId,
        payment.statusMessageId,
        paymentText,
        {
          replyMarkup: markup,
        }
      );
    } else {
      response = await this.upsertChatMessage(
        payment.chatId,
        payment.statusMessageId,
        paymentText,
        {
          replyMarkup: markup,
        }
      );
    }

    if (response?.message_id) {
      payment.statusMessageId = response.message_id;
    }
    payment.statusMessageKind = nextStatusMessageKind;
    payment.lastStatusText = paymentText;
    payment.lastReplyMarkupKey = replyMarkupKey;
    payment.lastQrMediaKey = qrMediaKey;
    await this.updateStoredPayment(orderId, {
      statusMessageId: payment.statusMessageId,
      statusMessageKind: payment.statusMessageKind,
      status: payment.status,
      providerStatus: payment.providerStatus || payment.status,
      lastCheckedAt: payment.lastCheckedAt || null,
      completedAt: payment.completedAt || null,
      cancelledAt: payment.cancelledAt || null,
      qrMessageId: payment.statusMessageKind === "photo" ? payment.statusMessageId : null,
      qrImagePath: qrImagePath || payment.qrImagePath || null,
    });
    return payment;
  }

  async ensurePaymentQrImage(payment) {
    if (
      !payment ||
      String(payment.paymentMethod || "").toLowerCase() !== "qris" ||
      !String(payment.paymentNumber || "").trim()
    ) {
      return null;
    }

    const paymentNumber = String(payment.paymentNumber || "").trim();
    if (payment.qrImagePath) {
      try {
        if (payment.qrImageValue === paymentNumber) {
          await fs.access(payment.qrImagePath);
          return payment.qrImagePath;
        }
      } catch (error) {
      }
    }

    const qrDir = path.join(this.config.storage.runtimeDir, "payment-qris");
    await fs.mkdir(qrDir, { recursive: true });
    const filePath = path.join(
      qrDir,
      `${sanitizeFilename(payment.orderId || "payment", "payment")}.png`
    );
    const buffer = await QRCode.toBuffer(paymentNumber, {
      type: "png",
      width: 720,
      margin: 2,
      errorCorrectionLevel: "M",
    });
    await fs.writeFile(filePath, buffer);
    payment.qrImagePath = filePath;
    payment.qrImageValue = paymentNumber;
    await this.updateStoredPayment(payment.orderId, {
      qrImagePath: filePath,
      qrImageValue: paymentNumber,
    });
    return filePath;
  }

  async submitPreparedSubmission(
    chatId,
    {
      filePath,
      originalName,
      title,
      reportOptions = null,
      initialNotice = "",
      statusMessageId = null,
      message = null,
    } = {}
  ) {
    if (message) {
      this.rememberChatProfile(message);
    }

    if (!this.isPaymentEnabled()) {
      return this.enqueueSubmission(chatId, {
        filePath,
        originalName,
        title,
        reportOptions,
        initialNotice,
        statusMessageId,
      });
    }

    const safeTitle = truncate(title || this.buildDefaultTitle(originalName), 120);
    const now = new Date().toISOString();
    const orderId = this.paymentService.createOrderId({ chatId });
    let createdPayment = null;
    try {
      createdPayment = await this.paymentService.createTransaction({
        orderId,
        amount: Number(this.pakasirConfig.amount) || 0,
        method: this.pakasirConfig.method,
      });
    } catch (error) {
      await fs.unlink(filePath).catch(() => null);
      throw error;
    }
    const payment = {
      orderId,
      provider: "pakasir",
      chatId,
      originalName,
      title: safeTitle,
      reportOptions: reportOptions || this.buildDefaultReportOptions(),
      filePath,
      amount: Number(this.pakasirConfig.amount) || 0,
      totalPayment: createdPayment?.payment?.totalPayment || Number(this.pakasirConfig.amount) || 0,
      fee: createdPayment?.payment?.fee || 0,
      paymentMethod:
        createdPayment?.payment?.paymentMethod ||
        String(this.pakasirConfig.method || "qris").toLowerCase(),
      paymentNumber: createdPayment?.payment?.paymentNumber || null,
      expiredAt: createdPayment?.payment?.expiredAt || null,
      paymentUrl: this.paymentService.buildCheckoutUrl({ orderId }),
      project: this.pakasirConfig.project,
      status: "pending",
      providerStatus: "pending",
      createdAt: now,
      updatedAt: now,
      statusMessageId,
      initialNotice,
      user: this.getChatProfile(chatId),
      lastCheckedAt: null,
      completedAt: null,
      cancelledAt: null,
      verifiedAt: null,
      lastStatusText: null,
      lastReplyMarkupKey: "",
      lastQrMediaKey: "",
      statusMessageKind: statusMessageId ? "text" : null,
    };

    this.pendingPayments.set(orderId, payment);
    await this.persistPendingPayment(payment);
    await this.upsertPendingPaymentMessage(orderId, {
      text: [initialNotice, this.buildPaymentPendingText(payment)].filter(Boolean).join("\n\n"),
      replyMarkup: this.buildPaymentReplyMarkup(payment),
    });
    return payment;
  }

  async withPaymentRefreshLock(orderId, handler) {
    if (this.paymentRefreshLocks.has(orderId)) {
      return this.paymentRefreshLocks.get(orderId);
    }

    const pending = (async () => {
      try {
        return await handler();
      } finally {
        this.paymentRefreshLocks.delete(orderId);
      }
    })();
    this.paymentRefreshLocks.set(orderId, pending);
    return pending;
  }

  async refreshPendingPaymentStatus(orderId, { force = false } = {}) {
    const payment = this.pendingPayments.get(orderId);
    if (!payment) {
      return {
        ok: false,
        code: "PAYMENT_NOT_FOUND",
      };
    }

    if (!this.isPaymentEnabled()) {
      return {
        ok: false,
        code: "PAYMENT_DISABLED",
      };
    }

    const intervalMs = Math.max(
      5000,
      Number(this.pakasirConfig.statusPollIntervalMs || 15000)
    );
    const lastCheckedAtMs = Date.parse(payment.lastCheckedAt || "");
    if (
      !force &&
      Number.isFinite(lastCheckedAtMs) &&
      Date.now() - lastCheckedAtMs < intervalMs
    ) {
      return {
        ok: true,
        code: "PAYMENT_THROTTLED",
        payment,
        status: payment.status,
      };
    }

    return this.withPaymentRefreshLock(orderId, async () => {
      let detail = null;
      try {
        detail = await this.paymentService.getTransactionDetail({
          orderId: payment.orderId,
          amount: payment.amount,
        });
      } catch (error) {
        payment.lastCheckedAt = new Date().toISOString();
        await this.updateStoredPayment(orderId, {
          lastCheckedAt: payment.lastCheckedAt,
        });
        const message = String(error.message || "").toLowerCase();
        if (/not found|tidak ditemukan|404/.test(message)) {
          return {
            ok: true,
            code: "PAYMENT_NOT_CREATED",
            payment,
            status: payment.status,
          };
        }

        throw error;
      }

      const transaction = detail?.transaction || {};
      const status = String(transaction.status || payment.status || "pending").toLowerCase();
      payment.status = status === "completed" ? "completed" : "pending";
      payment.providerStatus = status;
      payment.lastCheckedAt = new Date().toISOString();
      if (transaction.completedAt) {
        payment.completedAt = transaction.completedAt;
      }
      await this.updateStoredPayment(orderId, {
        status: payment.status,
        providerStatus: payment.providerStatus,
        paymentMethod: transaction.paymentMethod || payment.paymentMethod,
        lastCheckedAt: payment.lastCheckedAt,
        completedAt: payment.completedAt || null,
      });

      if (status === "completed") {
        const job = await this.completePendingPayment(orderId, {
          transaction,
          source: "detail",
        });
        return {
          ok: true,
          code: "PAYMENT_COMPLETED",
          payment,
          status: status,
          job,
        };
      }

      await this.upsertPendingPaymentMessage(orderId);
      return {
        ok: true,
        code: "PAYMENT_PENDING",
        payment,
        status,
      };
    });
  }

  async completePendingPayment(orderId, { transaction = null, source = "detail" } = {}) {
    const payment = this.pendingPayments.get(orderId);
    if (!payment) {
      return null;
    }

    if (payment.status === "completed" && payment.jobId) {
      return this.jobStore?.get(payment.jobId) || null;
    }

    payment.status = "completed";
    payment.providerStatus = String(transaction?.status || "completed").toLowerCase();
    payment.completedAt = transaction?.completedAt || payment.completedAt || new Date().toISOString();
    payment.verifiedAt = new Date().toISOString();
    await this.updateStoredPayment(orderId, {
      status: payment.status,
      providerStatus: payment.providerStatus,
      paymentMethod: transaction?.paymentMethod || payment.paymentMethod,
      completedAt: payment.completedAt,
      verifiedAt: payment.verifiedAt,
      verificationSource: source,
    });

    let statusMessageId = payment.statusMessageId || null;
    if (payment.statusMessageKind === "photo" && statusMessageId) {
      await this.deleteMessage(payment.chatId, statusMessageId).catch(() => null);
      statusMessageId = null;
    }

    const job = await this.enqueueSubmission(payment.chatId, {
      filePath: payment.filePath,
      originalName: payment.originalName,
      title: payment.title,
      reportOptions: payment.reportOptions,
      initialNotice: `Pembayaran ${formatCurrencyIdr(payment.amount)} terkonfirmasi. Dokumen masuk queue.`,
      statusMessageId,
    });
    await this.updateStoredPayment(orderId, {
      jobId: job?.id || null,
    });
    this.pendingPayments.delete(orderId);
    return job;
  }

  async cancelPendingPayment(orderId, { notice = "Invoice dibatalkan. Kirim file lagi untuk mulai ulang." } = {}) {
    const payment = this.pendingPayments.get(orderId);
    if (!payment) {
      return false;
    }

    if (this.isPaymentEnabled()) {
      await this.paymentService
        .cancelTransaction({
          orderId: payment.orderId,
          amount: payment.amount,
        })
        .catch((error) => {
          throw new Error(`Gagal membatalkan invoice: ${truncate(error.message, 160)}`);
        });
    }

    payment.status = "cancelled";
    payment.providerStatus = "cancelled";
    payment.cancelledAt = new Date().toISOString();
    await this.updateStoredPayment(orderId, {
      status: payment.status,
      providerStatus: payment.providerStatus,
      cancelledAt: payment.cancelledAt,
    });
    await fs.unlink(payment.filePath).catch(() => null);
    const response = await this.replaceChatMessage(
      payment.chatId,
      payment.statusMessageId || null,
      this.buildPaymentCancelledText(payment, notice),
      {
        replyMarkup: this.buildNextActionReplyMarkup(),
      }
    ).catch(() => null);
    payment.statusMessageId = response?.message_id || null;
    payment.statusMessageKind = "text";
    await this.updateStoredPayment(orderId, {
      statusMessageId: payment.statusMessageId,
      statusMessageKind: payment.statusMessageKind,
    });
    if (payment.statusMessageId) {
      this.chatReadyMessages.set(String(payment.chatId), payment.statusMessageId);
    }
    this.pendingPayments.delete(orderId);
    return true;
  }

  async cancelLatestPendingPayment(chatId) {
    const payment = this.findLatestPendingPaymentForChat(chatId);
    if (!payment) {
      return false;
    }

    await this.cancelPendingPayment(payment.orderId, {
      notice: "Invoice dibatalkan dari Telegram. Kirim file lagi untuk mulai ulang.",
    });
    return true;
  }

  async pollPendingPayments() {
    if (!this.pendingPayments.size || !this.isPaymentEnabled()) {
      return;
    }

    for (const payment of [...this.pendingPayments.values()]) {
      await this.refreshPendingPaymentStatus(payment.orderId).catch((error) => {
        this.logger.error(`Payment status poll failed: ${error.message}`);
      });
    }
  }

  async handlePakasirWebhook(payload = {}) {
    if (!this.isPaymentEnabled()) {
      return {
        ok: false,
        code: "PAYMENT_DISABLED",
      };
    }

    const verified = await this.paymentService.verifyWebhookPayload(payload);
    const orderId = verified.transaction.orderId;
    const payment = this.pendingPayments.get(orderId) || this.stateStore?.getPayment?.(orderId);
    if (!payment) {
      return {
        ok: true,
        code: "PAYMENT_UNKNOWN",
        orderId,
      };
    }

    if (!this.pendingPayments.has(orderId)) {
      this.pendingPayments.set(orderId, {
        ...payment,
        lastStatusText: null,
        lastReplyMarkupKey: "",
      });
    }

    if (verified.completed) {
      const job = await this.completePendingPayment(orderId, {
        transaction: verified.transaction,
        source: "webhook",
      });
      return {
        ok: true,
        code: "PAYMENT_COMPLETED",
        orderId,
        jobId: job?.id || null,
      };
    }

    return {
      ok: true,
      code: "PAYMENT_IGNORED",
      orderId,
      status: verified.transaction.status,
    };
  }

  async promptTitleSelection(chatId, { messageId = null } = {}) {
    const key = String(chatId);
    const draft = this.pendingSubmissions.get(key);
    if (!draft) {
      await this.sendMessage(chatId, "Tidak ada dokumen yang sedang menunggu judul.");
      return null;
    }

    const response = await this.replaceChatMessage(
      chatId,
      messageId || draft.statusMessageId,
      this.buildTitlePromptText(draft.originalName),
      {
        replyMarkup: this.buildDraftTitleReplyMarkup(),
      }
    );
    draft.statusMessageId = response?.message_id || messageId || draft.statusMessageId;
    return draft;
  }

  async promptFilterSelection(chatId, { title, messageId = null } = {}) {
    const key = String(chatId);
    const draft = this.pendingSubmissions.get(key);
    if (!draft) {
      await this.sendMessage(chatId, "Tidak ada dokumen yang sedang menunggu judul.");
      return null;
    }

    draft.title = truncate(title || draft.title || this.buildDefaultTitle(draft.originalName), 120);
    draft.step = "filter";
    draft.reportOptions = null;
    draft.expiresAt = Date.now() + Number(this.telegramConfig.titlePromptTimeoutMs || 60000);

    const response = await this.replaceChatMessage(
      chatId,
      messageId || draft.statusMessageId,
      this.buildFilterPromptText(draft.originalName),
      {
        replyMarkup: this.buildDraftFilterReplyMarkup(),
      }
    );
    draft.statusMessageId = response?.message_id || messageId || draft.statusMessageId;
    return draft;
  }

  async finalizePendingSubmission(
    chatId,
    { title, reportOptions = null, messageId = null } = {}
  ) {
    const key = String(chatId);
    const draft = this.pendingSubmissions.get(key);
    if (!draft) {
      await this.sendMessage(chatId, "Tidak ada dokumen yang sedang menunggu judul.");
      return null;
    }

    this.pendingSubmissions.delete(key);
    const statusMessageId = this.isPaymentEnabled()
      ? messageId || draft.statusMessageId || null
      : null;
    if (!this.isPaymentEnabled()) {
      await this.deleteMessage(chatId, messageId || draft.statusMessageId).catch(() => null);
    }
    return this.submitPreparedSubmission(chatId, {
      filePath: draft.filePath,
      originalName: draft.originalName,
      title: truncate(title || draft.title || this.buildDefaultTitle(draft.originalName), 120),
      reportOptions: reportOptions || draft.reportOptions || this.buildDefaultReportOptions(),
      statusMessageId,
    });
  }

  async cancelPendingSubmission(
    chatId,
    { notice = "Permintaan dibatalkan.", messageId = null } = {}
  ) {
    const key = String(chatId);
    const draft = this.pendingSubmissions.get(key);
    if (!draft) {
      await this.sendMessage(chatId, "Tidak ada dokumen yang sedang menunggu judul.");
      return false;
    }

    this.pendingSubmissions.delete(key);
    await fs.unlink(draft.filePath).catch(() => null);
    const response = await this.replaceChatMessage(
      chatId,
      messageId || draft.statusMessageId,
      [
        TELEGRAM_BOT_LABEL,
        `${this.buildProgressBar(0)} 0%`,
        "Dibatalkan.",
        notice,
      ].join("\n"),
      {
        replyMarkup: this.buildNextActionReplyMarkup(),
      }
    ).catch(() => null);
    if (response?.message_id) {
      this.chatReadyMessages.set(key, response.message_id);
    }
    return true;
  }

  async flushExpiredPendingSubmissions() {
    const expiredDrafts = [...this.pendingSubmissions.values()].filter(
      (draft) => Number(draft.expiresAt || 0) <= Date.now()
    );

    for (const draft of expiredDrafts) {
      await this.cancelPendingSubmission(draft.chatId, {
        notice: "Waktu isi judul/filter habis. Kirim file lagi untuk mulai ulang.",
        messageId: draft.statusMessageId,
      }).catch((error) => {
        this.logger.error(`Draft auto-submit failed: ${error.message}`);
      });
    }
  }

  async enqueueSubmission(
    chatId,
    {
      filePath,
      originalName,
      title,
      reportOptions = null,
      initialNotice = "",
      statusMessageId = null,
    } = {}
  ) {
    const safeTitle = truncate(title || this.buildDefaultTitle(originalName), 120);
    const job = this.jobRunner.enqueue(
      {
        filePath,
        originalName,
        title: safeTitle,
        reportOptions: reportOptions || this.buildDefaultReportOptions(),
      },
      {
        autoStart: false,
      }
    );

    const queuedText = this.buildQueuedText(job, {
      fileName: originalName,
      title: safeTitle,
    });
    const context = {
      chatId,
      fileName: originalName,
      title: safeTitle,
      statusMessageId,
      lastStatusText: null,
      lastReplyMarkupKey: "",
      lastVisibleLogMessage: "Menunggu giliran proses.",
      lastProgressUpdateAt: 0,
    };

    this.jobContexts.set(job.id, context);
    this.rememberChatJob(chatId, job.id);

    const fullText = [initialNotice, queuedText].filter(Boolean).join("\n\n");
    await this.updateTrackedStatus(job.id, fullText, {
      replyMarkup: this.buildJobCancelInlineReplyMarkup(job.id),
    });
    this.jobRunner.scheduleEnqueueWatchdog?.();
    await this.jobRunner.requestPump?.();
    return job;
  }

  async pollTrackedJobs() {
    await this.flushExpiredPendingSubmissions();
    await this.pollPendingPayments();
    if (!this.jobStore) {
      return;
    }

    const liveJobs = [...this.jobContexts.entries()]
      .map(([jobId, context]) => ({
        context,
        job: this.jobStore.get(jobId),
      }))
      .filter((entry) => entry.job && ["queued", "running"].includes(entry.job.status));

    for (const entry of liveJobs) {
      const text =
        entry.job.status === "queued"
          ? this.buildQueuedText(entry.job, entry.context)
          : this.buildRunningText(entry.job);
      await this.updateTrackedStatus(entry.job.id, text, {
        replyMarkup: this.buildJobCancelInlineReplyMarkup(entry.job.id),
      }).catch((error) => {
        this.logger.error(`Tracked status update failed: ${error.message}`);
      });
    }
  }

  async handleJobStarted(job) {
    await this.updateTrackedStatus(job?.id, this.buildRunningText(job), {
      replyMarkup: this.buildJobCancelInlineReplyMarkup(job?.id),
    });
  }

  async handleJobLog(entry) {
    const job = entry?.job;
    const log = entry?.log;
    const context = this.jobContexts.get(job?.id);
    if (!context || !log) {
      return;
    }

    context.lastVisibleLogMessage = this.summarizeUserLog(log.message);
    const now = Date.now();
    const throttleMs = Number(this.telegramConfig.progressUpdateThrottleMs || 5000);
    if (now - context.lastProgressUpdateAt < throttleMs) {
      return;
    }

    context.lastProgressUpdateAt = now;
    await this.updateTrackedStatus(job.id, this.buildRunningText(job, log.message), {
      replyMarkup: this.buildJobCancelInlineReplyMarkup(job.id),
    });
  }

  async handleJobCompleted(job) {
    const context = this.jobContexts.get(job?.id);
    if (!context) {
      return;
    }

    const deliveredJob = await this.sanitizeJobForDelivery(job);
    await this.updateTrackedStatus(job.id, this.buildCompletedText(deliveredJob), {
      replyMarkup: this.buildNextActionInlineReplyMarkup(),
    });
    const pinnedMessageId = await this.sendResultArtifacts(deliveredJob, {
      rawJob: job,
    });
    if (pinnedMessageId) {
      await this.pinMessage(context.chatId, pinnedMessageId).catch(() => null);
    }
  }

  async handleJobFailed(job) {
    await this.updateTrackedStatus(job?.id, this.buildFailedText(job), {
      replyMarkup: this.buildNextActionInlineReplyMarkup(),
    });
  }

  async handleJobCancelled(job) {
    await this.updateTrackedStatus(job?.id, this.buildCancelledText(job), {
      replyMarkup: this.buildNextActionInlineReplyMarkup(),
    });
  }

  buildQueuedText(job, { fileName, title } = {}) {
    return [
      ...this.buildCompactHeader(
        { ...job, originalName: fileName || job?.originalName, title: title || job?.title },
        "Menunggu",
        this.estimateProgressPercent(job)
      ),
      `Estimasi ${this.buildEtaLabel(job)}`,
      "Menunggu giliran proses.",
    ].join("\n");
  }

  buildRunningText(job, latestLog = null) {
    const rawLatestLog =
      latestLog || (Array.isArray(job?.logs) && job.logs.length ? job.logs[job.logs.length - 1]?.message : "");
    return [
      ...this.buildCompactHeader(job, "Diproses", this.estimateProgressPercent(job, rawLatestLog)),
      `Estimasi ${this.buildEtaLabel(job)}`,
      "Sistem sedang memproses dokumen.",
    ].join("\n");
  }

  buildCompletedText(job) {
    const result = job?.result || {};
    return [
      ...this.buildCompactHeader(job, "Selesai", 100),
      this.buildCompletedSimilarityLine(result),
      `Durasi ${this.buildElapsedLabel(job)}`,
    ].join("\n");
  }

  buildCompletedSimilarityLine(result = {}) {
    const similarity = String(result?.similarity || "").trim();
    if (similarity) {
      return `Similarity ${similarity}`;
    }

    const dashboardSimilarity = String(result?.dashboardSimilarity || "").trim();
    if (dashboardSimilarity) {
      return `Similarity ${dashboardSimilarity} (dashboard)`;
    }

    return "Similarity belum tersedia";
  }

  buildFailedText(job) {
    return [
      ...this.buildCompactHeader(job, "Gagal", this.estimateProgressPercent(job)),
      "Proses belum berhasil. Coba ulang beberapa saat lagi.",
    ].join("\n");
  }

  buildCancelledText(job) {
    return [
      ...this.buildCompactHeader(job, "Batal", this.estimateProgressPercent(job)),
      "Proses dihentikan.",
    ].join("\n");
  }

  buildEtaLabel(job) {
    if (!job || ["completed", "failed"].includes(job.status)) {
      return "selesai";
    }

    const remainingMs = this.estimateRemainingMs(job);
    return `${formatDurationRough(remainingMs)} lagi`;
  }

  buildElapsedLabel(job) {
    const createdAtMs = Date.parse(job?.createdAt || "");
    const finishedAtMs = Date.parse(job?.result?.finishedAt || "");
    if (!Number.isFinite(createdAtMs)) {
      return "-";
    }

    const end = Number.isFinite(finishedAtMs) ? finishedAtMs : Date.now();
    return formatDurationRough(Math.max(0, end - createdAtMs));
  }

  estimateRemainingMs(job) {
    const averageTotalMs = this.estimateAverageTotalJobMs();
    const createdAtMs = Date.parse(job?.createdAt || "");
    const elapsedMs = Number.isFinite(createdAtMs) ? Math.max(0, Date.now() - createdAtMs) : 0;

    if (job.status === "queued") {
      const queueFactor = Math.max(1, Number(job.queuePosition || 1));
      return averageTotalMs * queueFactor;
    }

    if (job.status === "running") {
      return Math.max(2 * 60 * 1000, averageTotalMs - elapsedMs);
    }

    return 0;
  }

  estimateAverageTotalJobMs() {
    const fallback = Math.max(
      8 * 60 * 1000,
      Math.min(20 * 60 * 1000, Number(this.config.similarityWaitMs || 12 * 60 * 1000) + 3 * 60 * 1000)
    );
    if (!this.jobStore || typeof this.jobStore.list !== "function") {
      return fallback;
    }

    const durations = this.jobStore
      .list(30)
      .filter((job) => job.status === "completed" && job.result?.finishedAt)
      .map((job) => {
        const createdAtMs = Date.parse(job.createdAt || "");
        const finishedAtMs = Date.parse(job.result?.finishedAt || "");
        if (!Number.isFinite(createdAtMs) || !Number.isFinite(finishedAtMs)) {
          return null;
        }
        return Math.max(0, finishedAtMs - createdAtMs);
      })
      .filter((value) => Number.isFinite(value) && value > 0);

    if (!durations.length) {
      return fallback;
    }

    return Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length);
  }

  buildCompactHeader(job, statusLabel, progressPercent) {
    const safeProgress = clamp(Math.round(Number(progressPercent) || 0), 0, 100);
    return [
      TELEGRAM_BOT_LABEL,
      `${this.buildProgressBar(safeProgress)} ${safeProgress}%`,
      `${shortJobId(job?.id)} • ${truncate(job?.originalName || job?.title, 64)}`,
      statusLabel,
    ];
  }

  estimateProgressPercent(job, latestLog = null) {
    if (!job) {
      return 0;
    }

    if (job.status === "completed") {
      return 100;
    }

    const latestMessage =
      String(latestLog || job.logs?.[job.logs.length - 1]?.message || "").toLowerCase();
    if (job.status === "failed") {
      return clamp(job.result?.artifacts?.viewerPdf ? 99 : 100, 0, 100);
    }
    if (job.status === "queued") {
      return 5;
    }
    if (/current view pdf berhasil|salinan current view disimpan/.test(latestMessage)) {
      return 99;
    }
    if (/feedback studio|viewer|queue feedback studio|queue viewer|filter viewer/.test(latestMessage)) {
      return 92;
    }
    if (/digital receipt|artefak file asli|artifact/.test(latestMessage)) {
      return 86;
    }
    if (/similarity terdeteksi/.test(latestMessage)) {
      return 80;
    }
    if (/similarity dan current view belum muncul|menunggu konfirmasi submission/.test(latestMessage)) {
      return 72;
    }
    if (/submit to turnitin/.test(latestMessage)) {
      return 64;
    }
    if (/upload and review|memasang file|form upload|modal upload/.test(latestMessage)) {
      return 50;
    }
    if (/assignment kosong ditemukan|assignment dipilih|siap dipakai ulang/.test(latestMessage)) {
      return 38;
    }
    if (/cek kelas|periksa assignment|repository/.test(latestMessage)) {
      return 26;
    }
    if (/waf challenge|login/.test(latestMessage)) {
      return 14;
    }
    if (/mencoba akun/.test(latestMessage)) {
      return 8;
    }

    return 12;
  }

  summarizeUserLog(message) {
    const raw = String(message || "").trim();
    if (!raw) {
      return "";
    }

    const normalized = raw.toLowerCase();
    if (/semua akun sedang dipakai/.test(normalized)) {
      return "Persiapan antrean.";
    }
    if (/mencoba akun|coba ulang assignment/.test(normalized)) {
      return "Sinkronisasi akses.";
    }
    if (/save to repository|repository/.test(normalized)) {
      return "Validasi tujuan.";
    }
    if (/cek kelas|periksa assignment/.test(normalized)) {
      return "Validasi tujuan.";
    }
    if (/batas retry assignment|batas retry lokal/.test(normalized)) {
      return "Penyesuaian rute.";
    }
    if (/dipakai .*mencapai batas lokal/.test(normalized)) {
      return "Kapasitas penuh.";
    }
    if (/assignment kosong ditemukan|assignment siap dipakai ulang|assignment dipilih/.test(normalized)) {
      return "Slot ditemukan.";
    }
    if (/alur upload|upload submission|mengunggah|unggah|modal upload|form upload|memasang file|file sudah terpasang/.test(normalized)) {
      return "Sinkronisasi dokumen.";
    }
    if (/submit to turnitin|konfirmasi submission/.test(normalized)) {
      return "Finalisasi kirim.";
    }
    if (/similarity belum tersedia|current view belum tersedia|menunggu similarity|cek similarity/.test(normalized)) {
      return "Analisis berjalan.";
    }
    if (/similarity terdeteksi/.test(normalized)) {
      return "Analisis terdeteksi.";
    }
    if (/digital receipt|file asli|artifact/.test(normalized)) {
      return "Sinkronisasi hasil.";
    }
    if (/feedback studio|viewer|laporan/.test(normalized)) {
      return "Finalisasi laporan.";
    }
    if (/current view pdf berhasil|salinan current view disimpan/.test(normalized)) {
      return "Laporan siap.";
    }
    if (/akun .* gagal|slot akun/i.test(raw)) {
      return "Akses perlu diulang.";
    }
    if (/tidak punya assignment|sudah terpakai|tidak bisa dipakai/.test(normalized)) {
      return "Tujuan tidak tersedia.";
    }
    if (/login/.test(normalized)) {
      return "Sinkronisasi akses.";
    }

    return this.sanitizeSensitiveText(raw);
  }

  summarizeFailure(message) {
    const raw = String(message || "").trim();
    const normalized = raw.toLowerCase();
    if (/semua assignment.*tidak bisa dipakai|semua assignment.*sudah terpakai/.test(normalized)) {
      return "Semua assignment yang aman tampaknya sedang habis, terkunci, atau sudah melewati batas lokal.";
    }
    if (/login turnitin gagal|login tidak berpindah/.test(normalized)) {
      return "Login ke Turnitin gagal. Cek akun pool atau tantangan login tambahan.";
    }

    return this.sanitizeSensitiveText(raw);
  }

  sanitizeSensitiveText(message) {
    return truncate(
      maskEmailLikeText(
        String(message || "")
          .replace(/https?:\/\/\S+/gi, "[tautan-disensor]")
          .replace(/debugHtml=\S+/gi, "debugHtml=[disensor]")
          .replace(/debugShot=\S+/gi, "debugShot=[disensor]")
          .replace(/debugJson=\S+/gi, "debugJson=[disensor]")
          .replace(/\/storage\/\S+/gi, "[file-lokal]")
          .replace(/\b(pass(word)?|token)\b[^,\n]*/gi, "[rahasia-disensor]")
      ),
      180
    );
  }

  async pinMessage(chatId, messageId) {
    return this.apiRequest("pinChatMessage", {
      chat_id: chatId,
      message_id: messageId,
      disable_notification: true,
    });
  }

  async updateTrackedStatus(jobId, text, { replyMarkup = null } = {}) {
    const context = this.jobContexts.get(jobId);
    const replyMarkupKey = JSON.stringify(replyMarkup || null);
    if (
      !context ||
      !text ||
      (context.lastStatusText === text && context.lastReplyMarkupKey === replyMarkupKey)
    ) {
      return;
    }

    if (!context.statusMessageId) {
      const response = await this.sendMessage(context.chatId, text, { replyMarkup });
      context.statusMessageId = response?.message_id || null;
      context.lastStatusText = text;
      context.lastReplyMarkupKey = replyMarkupKey;
      return;
    }

    try {
      await this.editMessageText(context.chatId, context.statusMessageId, text, {
        replyMarkup,
      });
      context.lastStatusText = text;
      context.lastReplyMarkupKey = replyMarkupKey;
    } catch (error) {
      if (!shouldReplaceStatusMessageAfterEditError(error)) {
        context.lastStatusText = text;
        context.lastReplyMarkupKey = replyMarkupKey;
        return;
      }
      const response = await this.sendMessage(context.chatId, text, {
        replyMarkup,
      }).catch(() => null);
      if (response?.message_id) {
        context.statusMessageId = response.message_id;
      }
      context.lastStatusText = text;
      context.lastReplyMarkupKey = replyMarkupKey;
    }
  }

  async upsertChatMessage(chatId, messageId, text, { replyMarkup = null } = {}) {
    if (!messageId) {
      return this.sendMessage(chatId, text, { replyMarkup });
    }

    try {
      return await this.editMessageText(chatId, messageId, text, { replyMarkup });
    } catch (error) {
      return this.sendMessage(chatId, text, { replyMarkup });
    }
  }

  async replaceChatMessage(chatId, messageId, text, { replyMarkup = null } = {}) {
    if (messageId) {
      await this.deleteMessage(chatId, messageId).catch(() => null);
    }

    return this.sendMessage(chatId, text, { replyMarkup });
  }

  async sanitizeJobForDelivery(job) {
    if (!job?.result) {
      return job;
    }

    try {
      return {
        ...job,
        result: await sanitizeResultArtifacts(job.result, {
          storageDir: this.config.storage.dir,
        }),
      };
    } catch (error) {
      this.logger.error(`Telegram result sanitization failed: ${error.message}`);
      return job;
    }
  }

  async sendResultArtifacts(job, { rawJob = null } = {}) {
    const context = this.jobContexts.get(job?.id);
    const chatId = context?.chatId;
    if (!chatId) {
      return null;
    }

    const sourceJob = rawJob || job;
    const deliveredJob = rawJob ? job : await this.sanitizeJobForDelivery(job);
    const files = this.collectResultArtifacts(deliveredJob);
    if (!files.length) {
      if (sourceJob?.result?.artifacts?.viewerPdf && !deliveredJob?.result?.artifacts?.viewerPdf) {
        this.logger.log(
          `Telegram artifact skipped for job ${job?.id || "-"} because viewer PDF did not pass delivery sanitization.`
        );
      }
      return null;
    }

    let pinCandidateMessageId = null;
    for (const item of files) {
      try {
        let response = null;
        if (item.method === "sendPhoto") {
          response = await this.sendPhoto(chatId, item.path, { caption: item.caption });
        } else {
          response = await this.sendDocument(chatId, item.path, {
            caption: item.caption,
            filename: item.filename,
          });
        }
        if (!pinCandidateMessageId && response?.message_id) {
          pinCandidateMessageId = response.message_id;
        }
      } catch (error) {
        await this.sendMessage(
          chatId,
          `Gagal mengirim ${item.label}: ${truncate(error.message, 160)}`
        ).catch(() => null);
      }
    }

    return pinCandidateMessageId;
  }

  collectResultArtifacts(job) {
    const result = job?.result || {};
    const artifacts = result?.artifacts || {};
    const originalName = job?.originalName || result?.originalName || null;
    const candidates = [
      {
        key: "viewerPdf",
        label: "current view PDF",
        method: "sendDocument",
        filename: buildResultDocumentFilename(originalName),
        caption: buildResultDocumentCaption(originalName, result.similarity || null),
      },
    ];

    const files = [];
    for (const candidate of candidates) {
      const filePath = resolveStorageUrlPath(this.config.storage.dir, artifacts[candidate.key]);
      if (!filePath) {
        continue;
      }

      files.push({
        ...candidate,
        path: filePath,
      });
    }

    return files;
  }

  async downloadTelegramDocument(document) {
    const file = await this.apiRequest("getFile", {
      file_id: document.file_id,
    });
    if (!file?.file_path) {
      throw new Error("Telegram tidak mengembalikan file_path.");
    }

    const preferredName = sanitizeFilename(
      document.file_name || path.basename(file.file_path),
      `telegram-${document.file_unique_id || "document"}`
    );
    const ext = path.extname(preferredName);
    const storageName = `${randomUUID()}${ext}`;
    const targetPath = path.join(this.config.storage.uploadsDir, storageName);
    const buffer = await this.bufferRequest(`${this.fileBaseUrl}/${file.file_path}`);
    await fs.writeFile(targetPath, buffer);
    return {
      filePath: targetPath,
      originalName: preferredName,
    };
  }

  async apiRequest(method, payload = {}, { signal } = {}) {
    const data = await this.jsonRequest(`${this.apiBaseUrl}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload || {}),
      signal,
      label: method,
    });
    return data.result;
  }

  async sendMessage(chatId, text, { replyMarkup = null } = {}) {
    const payload = {
      chat_id: chatId,
      text,
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }

    return this.apiRequest("sendMessage", payload);
  }

  async editMessageText(chatId, messageId, text, { replyMarkup = null } = {}) {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      text,
    };
    if (isInlineReplyMarkup(replyMarkup)) {
      payload.reply_markup = replyMarkup;
    }

    return this.apiRequest("editMessageText", payload);
  }

  async editMessageCaption(chatId, messageId, caption, { replyMarkup = null } = {}) {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      caption,
    };
    if (isInlineReplyMarkup(replyMarkup)) {
      payload.reply_markup = replyMarkup;
    }

    return this.apiRequest("editMessageCaption", payload);
  }

  async answerCallbackQuery(callbackQueryId, text = "") {
    const payload = {
      callback_query_id: callbackQueryId,
    };
    if (text) {
      payload.text = text;
    }

    return this.apiRequest("answerCallbackQuery", payload);
  }

  async deleteMessage(chatId, messageId) {
    if (!chatId || !messageId) {
      return false;
    }

    return this.apiRequest("deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
  }

  async sendDocument(chatId, filePath, { caption = "", filename = null, replyMarkup = null } = {}) {
    return this.sendMultipartFile("sendDocument", "document", chatId, filePath, {
      caption,
      filename,
      contentType: "application/octet-stream",
      replyMarkup,
    });
  }

  async sendPhoto(chatId, filePath, { caption = "", replyMarkup = null } = {}) {
    return this.sendMultipartFile("sendPhoto", "photo", chatId, filePath, {
      caption,
      filename: path.basename(filePath),
      contentType: "image/png",
      replyMarkup,
    });
  }

  async editPhotoMessage(chatId, messageId, filePath, { caption = "", replyMarkup = null } = {}) {
    const buffer = await fs.readFile(filePath);
    const fieldName = "photo";
    const multipart = buildMultipartBody({
      fields: {
        chat_id: String(chatId),
        message_id: String(messageId),
        media: JSON.stringify({
          type: "photo",
          media: `attach://${fieldName}`,
          caption,
        }),
        reply_markup: isInlineReplyMarkup(replyMarkup) ? JSON.stringify(replyMarkup) : null,
      },
      fieldName,
      filename: path.basename(filePath),
      contentType: "image/png",
      fileBuffer: buffer,
    });

    const data = await this.jsonRequest(`${this.apiBaseUrl}/editMessageMedia`, {
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${multipart.boundary}`,
        "content-length": String(multipart.body.length),
      },
      body: multipart.body,
      label: "editMessageMedia",
    });
    return data.result;
  }

  async sendMultipartFile(
    method,
    fieldName,
    chatId,
    filePath,
    { caption = "", filename = null, contentType = "application/octet-stream", replyMarkup = null } = {}
  ) {
    const buffer = await fs.readFile(filePath);
    const maxAttempts = Math.max(1, Number(this.telegramConfig.sendRetryAttempts) || 3);
    const retryDelayMs = Math.max(0, Number(this.telegramConfig.retryDelayMs) || 5000);
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const multipart = buildMultipartBody({
          fields: {
            chat_id: String(chatId),
            caption,
            reply_markup: isInlineReplyMarkup(replyMarkup) ? JSON.stringify(replyMarkup) : null,
          },
          fieldName,
          filename: filename || path.basename(filePath),
          contentType,
          fileBuffer: buffer,
        });

        const data = await this.jsonRequest(`${this.apiBaseUrl}/${method}`, {
          method: "POST",
          headers: {
            "content-type": `multipart/form-data; boundary=${multipart.boundary}`,
            "content-length": String(multipart.body.length),
          },
          body: multipart.body,
          label: method,
        });
        return data.result;
      } catch (error) {
        lastError = error;
        if (!isRetryableTelegramTransportError(error) || attempt >= maxAttempts) {
          throw error;
        }

        this.logger.error(
          `Telegram ${method} gagal sementara (${error.message}), retry ${attempt + 1}/${maxAttempts}.`
        );
        await sleep(retryDelayMs);
      }
    }

    throw lastError;
  }

  async jsonRequest(url, { method = "GET", headers = {}, body = null, signal, label } = {}) {
    if (this.fetchImpl) {
      const response = await this.fetchImpl(url, {
        method,
        headers,
        body,
        signal,
      });

      let data = null;
      try {
        data = await response.json();
      } catch (error) {
        throw new Error(`Telegram ${label || method} mengembalikan respons non-JSON.`);
      }

      if (!response.ok || !data?.ok) {
        throw new Error(
          data?.description || `Telegram ${label || method} gagal dengan HTTP ${response.status}.`
        );
      }

      return data;
    }

    const response = await this.httpsRequest(url, {
      method,
      headers,
      body,
      signal,
    });
    let data = null;
    try {
      data = JSON.parse(response.body.toString("utf8"));
    } catch (error) {
      throw new Error(`Telegram ${label || method} mengembalikan respons non-JSON.`);
    }

    if (!response.ok || !data?.ok) {
      throw new Error(
        data?.description || `Telegram ${label || method} gagal dengan HTTP ${response.status}.`
      );
    }

    return data;
  }

  async bufferRequest(url, { signal } = {}) {
    if (this.fetchImpl) {
      const response = await this.fetchImpl(url, {
        method: "GET",
        signal,
      });
      if (!response.ok) {
        throw new Error(`Download file Telegram gagal (${response.status}).`);
      }

      return Buffer.from(await response.arrayBuffer());
    }

    const response = await this.httpsRequest(url, {
      method: "GET",
      signal,
    });
    if (!response.ok) {
      throw new Error(`Download file Telegram gagal (${response.status}).`);
    }

    return response.body;
  }

  async httpsRequest(urlText, { method = "GET", headers = {}, body = null, signal } = {}) {
    const url = new URL(urlText);
    const normalizedBody =
      body === null || body === undefined
        ? null
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(String(body));
    const requestHeaders = {
      ...headers,
    };
    if (normalizedBody && requestHeaders["content-length"] === undefined) {
      requestHeaders["content-length"] = String(normalizedBody.length);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const finalize = (fn, value) => {
        if (settled) {
          return;
        }
        settled = true;
        fn(value);
      };

      const request = https.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method,
          headers: requestHeaders,
          family: 4,
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            finalize(resolve, {
              status: Number(response.statusCode || 0),
              ok: Number(response.statusCode || 0) >= 200 && Number(response.statusCode || 0) < 300,
              headers: response.headers,
              body: Buffer.concat(chunks),
            });
          });
        }
      );

      request.on("error", (error) => finalize(reject, error));

      let abortListener = null;
      if (signal) {
        if (signal.aborted) {
          request.destroy(createAbortError());
        } else {
          abortListener = () => request.destroy(createAbortError());
          signal.addEventListener("abort", abortListener, { once: true });
        }
      }

      request.on("close", () => {
        if (signal && abortListener) {
          signal.removeEventListener("abort", abortListener);
        }
      });

      if (normalizedBody) {
        request.write(normalizedBody);
      }
      request.end();
    });
  }
}

module.exports = {
  TelegramBotService,
  resolveStorageUrlPath,
  sanitizeFilename,
};
