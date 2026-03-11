const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { TelegramBotService } = require("../src/services/telegram-bot");

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

async function createConfig() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-telegram-bot-"));
  return {
    dir,
    config: {
      accountsFile: path.join(dir, "akun-turnitin.txt"),
      maxFileBytes: 50 * 1024 * 1024,
      storage: {
        dir,
        uploadsDir: path.join(dir, "uploads"),
        runtimeDir: path.join(dir, "runtime"),
      },
      telegram: {
        botToken: "123:abc",
        enabled: true,
        allowedChatIds: [],
        restrictGeneralAccess: false,
        adminChatIds: [],
        pollingTimeoutSeconds: 1,
        retryDelayMs: 10,
        statusPollIntervalMs: 5000,
        titlePromptTimeoutMs: 60 * 1000,
        progressUpdateThrottleMs: 0,
        adminAlertCooldownMs: 60 * 1000,
      },
      pakasir: {
        enabled: false,
        baseUrl: "https://app.pakasir.com",
        project: "",
        apiKey: "",
        amount: 0,
        method: "qris",
        qrisOnly: true,
        redirectUrl: "",
        webhookPath: "/api/payments/pakasir/webhook",
        statusPollIntervalMs: 15000,
      },
    },
  };
}

function createMemoryStateStore(seedPayments = []) {
  const payments = new Map(seedPayments.map((payment) => [payment.orderId, { ...payment }]));
  return {
    listPendingPayments() {
      return [...payments.values()].filter(
        (payment) => !["completed", "cancelled", "expired", "failed"].includes(payment.status)
      );
    },
    getPayment(orderId) {
      const payment = payments.get(String(orderId));
      return payment ? { ...payment } : null;
    },
    async upsertPayment(payment) {
      payments.set(payment.orderId, { ...(payments.get(payment.orderId) || {}), ...payment });
      return this.getPayment(payment.orderId);
    },
    async updatePayment(orderId, updates = {}) {
      const current = payments.get(String(orderId));
      if (!current) {
        throw new Error("payment not found");
      }
      payments.set(String(orderId), { ...current, ...updates, orderId: String(orderId) });
      return this.getPayment(orderId);
    },
    snapshot() {
      return [...payments.values()].map((payment) => ({ ...payment }));
    },
  };
}

test("TelegramBotService downloads a Telegram document and enqueues a job", async () => {
  const { dir, config } = await createConfig();
  await fs.mkdir(config.storage.uploadsDir, { recursive: true });

  const requests = [];
  const sendPhotoPayloads = [];
  let queuedPayload = null;
  let enqueueOptions = null;
  const jobRunner = {
    jobStore: {
      get() {
        return null;
      },
    },
    enqueue(payload, options) {
      queuedPayload = payload;
      enqueueOptions = options || null;
      return {
        id: "job-12345678",
        originalName: payload.originalName,
        title: payload.title,
        queuePosition: 1,
      };
    },
    async requestPump() {},
    scheduleEnqueueWatchdog() {},
    on() {},
    off() {},
  };

  const service = new TelegramBotService({
    config,
    jobRunner,
    fetchImpl: async (url, options = {}) => {
      requests.push({
        url,
        method: options.method || "GET",
      });

      if (url.endsWith("/getFile")) {
        return jsonResponse({
          ok: true,
          result: {
            file_path: "documents/paper.pdf",
          },
        });
      }

      if (url.endsWith("/sendMessage")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 77,
          },
        });
      }

      if (url.endsWith("/documents/paper.pdf")) {
        return new Response(Buffer.from("pdf-content"), {
          status: 200,
          headers: {
            "content-type": "application/pdf",
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });

  await service.handleDocumentMessage({
    chat: { id: 1001 },
    from: { id: 2002 },
    document: {
      file_id: "file-1",
      file_name: "paper.pdf",
      file_size: 1024,
    },
    caption: "Judul Dari Telegram\nfilter: off",
  });

  assert.ok(queuedPayload);
  assert.equal(queuedPayload.originalName, "paper.pdf");
  assert.equal(queuedPayload.title, "Judul Dari Telegram");
  assert.deepEqual(queuedPayload.reportOptions, {
    excludeQuotes: false,
    excludeBibliography: false,
    excludeMatches: false,
    excludeMatchesWordCount: 10,
  });
  assert.deepEqual(enqueueOptions, { autoStart: false });
  assert.match(queuedPayload.filePath, /uploads/);
  assert.equal(await fs.readFile(queuedPayload.filePath, "utf8"), "pdf-content");
  assert.deepEqual(
    requests.map((entry) => path.basename(entry.url)),
    ["getFile", "paper.pdf", "sendMessage"]
  );

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService rejects oversized incoming Telegram documents with a clear limit message", async () => {
  const { dir, config } = await createConfig();
  const requests = [];
  const service = new TelegramBotService({
    config: {
      ...config,
      telegram: {
        ...config.telegram,
        downloadMaxFileBytes: 20 * 1024 * 1024,
      },
    },
    jobRunner: {
      jobStore: {
        get() {
          return null;
        },
      },
      on() {},
      off() {},
    },
    fetchImpl: async (url, options = {}) => {
      const payload = options.body ? JSON.parse(options.body) : null;
      requests.push({
        url,
        payload,
      });

      if (url.endsWith("/sendMessage")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 11,
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });

  await service.handleDocumentMessage({
    chat: { id: 1001 },
    document: {
      file_id: "big-file-1",
      file_name: "big.pdf",
      file_size: 25 * 1024 * 1024,
    },
  });

  assert.equal(requests.some((entry) => entry.url.endsWith("/getFile")), false);
  assert.match(requests[0]?.payload?.text || "", /File terlalu besar untuk diproses lewat bot Telegram/);
  assert.match(requests[0]?.payload?.text || "", /20 MB/);
  assert.match(requests[0]?.payload?.text || "", /panel web/);

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService surfaces a friendly message when Telegram rejects oversized getFile downloads", async () => {
  const { dir, config } = await createConfig();
  const requests = [];
  const service = new TelegramBotService({
    config,
    jobRunner: {
      jobStore: {
        get() {
          return null;
        },
      },
      on() {},
      off() {},
    },
    fetchImpl: async (url, options = {}) => {
      const payload = options.body ? JSON.parse(options.body) : null;
      requests.push({
        url,
        payload,
      });

      if (url.endsWith("/getFile")) {
        return jsonResponse({
          ok: false,
          description: "Bad Request: file is too big",
        }, 400);
      }

      if (url.endsWith("/sendMessage")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 12,
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });

  await service.handleUpdate({
    message: {
      chat: { id: 1001 },
      document: {
        file_id: "big-file-2",
        file_name: "big-remote.pdf",
        file_size: 0,
      },
    },
  });

  const outboundMessage = requests.find((entry) => entry.url.endsWith("/sendMessage"));
  assert.ok(outboundMessage);
  assert.match(outboundMessage.payload?.text || "", /File terlalu besar untuk diproses lewat bot Telegram/);
  assert.doesNotMatch(outboundMessage.payload?.text || "", /Permintaan gagal diproses/);

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService /start shows welcome text with chat details", async () => {
  const { dir, config } = await createConfig();
  const requests = [];
  const service = new TelegramBotService({
    config,
    jobRunner: {
      jobStore: {
        get() {
          return null;
        },
      },
      on() {},
      off() {},
    },
    fetchImpl: async (url, options = {}) => {
      const payload = options.body ? JSON.parse(options.body) : null;
      requests.push({
        url,
        payload,
      });

      if (url.endsWith("/sendMessage")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 300,
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });

  await service.handleUpdate({
    message: {
      chat: {
        id: 1001,
        type: "private",
      },
      from: {
        id: 1001,
        first_name: "Alice",
        last_name: "Doe",
        username: "alice",
        language_code: "id",
      },
      text: "/start",
    },
  });

  const payload = requests.find((entry) => entry.url.endsWith("/sendMessage"))?.payload;
  assert.match(payload?.text || "", /^Plagiasimu Bot/m);
  assert.match(payload?.text || "", /Selamat datang, Alice Doe\./);
  assert.match(payload?.text || "", /Informasi Akun/);
  assert.match(payload?.text || "", /Nama: Alice Doe/);
  assert.match(payload?.text || "", /Username: @alice/);
  assert.match(payload?.text || "", /Chat ID: 1001/);
  assert.match(payload?.text || "", /Status Akses: Diizinkan/);
  assert.match(payload?.text || "", /Akses Admin: Tidak/);
  assert.match(payload?.text || "", /Pembayaran\nStatus: Nonaktif/);
  assert.match(payload?.text || "", /Perintah Cepat/);

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService rejects admin commands from non-admin chats", async () => {
  const { dir, config } = await createConfig();
  config.telegram.allowedChatIds = ["1001"];
  config.telegram.adminChatIds = ["2002"];

  const requests = [];
  const service = new TelegramBotService({
    config,
    jobRunner: {
      jobStore: {
        get() {
          return null;
        },
      },
      on() {},
      off() {},
    },
    fetchImpl: async (url, options = {}) => {
      const payload = options.body ? JSON.parse(options.body) : null;
      requests.push({
        url,
        payload,
      });

      if (url.endsWith("/sendMessage")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 320,
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });

  await service.handleUpdate({
    message: {
      chat: {
        id: 1001,
        type: "private",
      },
      from: {
        id: 1001,
        first_name: "Alice",
      },
      text: "/admin",
    },
  });

  const payload = requests.find((entry) => entry.url.endsWith("/sendMessage"))?.payload;
  assert.match(payload?.text || "", /Perintah admin hanya bisa dipakai/);

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService keeps public bot access open when general restriction is disabled", async () => {
  const { dir, config } = await createConfig();
  config.telegram.allowedChatIds = ["2002"];
  config.telegram.adminChatIds = ["2002"];
  config.telegram.restrictGeneralAccess = false;

  const requests = [];
  const service = new TelegramBotService({
    config,
    jobRunner: {
      jobStore: {
        get() {
          return null;
        },
      },
      on() {},
      off() {},
    },
    fetchImpl: async (url, options = {}) => {
      const payload = options.body ? JSON.parse(options.body) : null;
      requests.push({
        url,
        payload,
      });

      if (url.endsWith("/sendMessage")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 325,
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });

  await service.handleUpdate({
    message: {
      chat: {
        id: 1001,
        type: "private",
      },
      from: {
        id: 1001,
        first_name: "Bob",
      },
      text: "/start",
    },
  });

  const payload = requests.find((entry) => entry.url.endsWith("/sendMessage"))?.payload;
  assert.match(payload?.text || "", /^Plagiasimu Bot/m);
  assert.doesNotMatch(payload?.text || "", /belum diizinkan/i);

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService blocks public access only when general restriction is enabled", async () => {
  const { dir, config } = await createConfig();
  config.telegram.allowedChatIds = ["2002"];
  config.telegram.adminChatIds = ["2002"];
  config.telegram.restrictGeneralAccess = true;

  const requests = [];
  const service = new TelegramBotService({
    config,
    jobRunner: {
      jobStore: {
        get() {
          return null;
        },
      },
      on() {},
      off() {},
    },
    fetchImpl: async (url, options = {}) => {
      const payload = options.body ? JSON.parse(options.body) : null;
      requests.push({
        url,
        payload,
      });

      if (url.endsWith("/sendMessage")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 326,
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });

  await service.handleUpdate({
    message: {
      chat: {
        id: 1001,
        type: "private",
      },
      from: {
        id: 1001,
        first_name: "Bob",
      },
      text: "/start",
    },
  });

  const payload = requests.find((entry) => entry.url.endsWith("/sendMessage"))?.payload;
  assert.match(payload?.text || "", /Chat ini belum diizinkan/);

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService allows admin commands only for configured admin chats", async () => {
  const { dir, config } = await createConfig();
  config.telegram.allowedChatIds = ["2002"];
  config.telegram.adminChatIds = ["2002"];

  const requests = [];
  const turnitinService = {
    async getMaxConcurrency() {
      return 7;
    },
    async getAccounts() {
      return [
        { email: "one@example.com" },
        { email: "two@example.com" },
      ];
    },
    buildAccountUsageSummaries() {
      return [
        {
          accountEmail: "one@example.com",
          availability: "usable",
          usageTotals: {
            submittableAssignments: 4,
            resubmittableAssignments: 1,
            emptyAssignments: 2,
            exhaustedAssignments: 3,
          },
        },
        {
          accountEmail: "two@example.com",
          availability: "exhausted",
          usageTotals: {
            submittableAssignments: 0,
            resubmittableAssignments: 0,
            emptyAssignments: 0,
            exhaustedAssignments: 8,
          },
        },
      ];
    },
    buildPoolAlertSnapshot() {
      return {
        level: "warning",
        headline: "Pool akun mulai menipis.",
        detailText: "Pool akun mulai menipis. 1/2 akun usable • 4 assignment siap • 1 slot resubmit.",
        totals: {
          accountCount: 2,
          usableAccounts: 1,
          submittableAssignments: 4,
          resubmittableAssignments: 1,
        },
        generatedAt: "2026-03-10T12:00:00.000Z",
      };
    },
  };

  const service = new TelegramBotService({
    config,
    jobRunner: {
      runningCount: 1,
      queuedCount: 2,
      jobStore: {
        get() {
          return null;
        },
      },
      on() {},
      off() {},
    },
    turnitinService,
    fetchImpl: async (url, options = {}) => {
      const payload = options.body ? JSON.parse(options.body) : null;
      requests.push({
        url,
        payload,
      });

      if (url.endsWith("/sendMessage")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 330 + requests.length,
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });

  await service.handleUpdate({
    message: {
      chat: {
        id: 2002,
        type: "private",
      },
      from: {
        id: 2002,
        first_name: "Admin",
      },
      text: "/admin",
    },
  });

  await service.handleUpdate({
    message: {
      chat: {
        id: 2002,
        type: "private",
      },
      from: {
        id: 2002,
        first_name: "Admin",
      },
      text: "/pool",
    },
  });

  const adminPayload = requests[0]?.payload;
  const poolPayload = requests[1]?.payload;
  assert.match(adminPayload?.text || "", /Plagiasimu Bot • Admin/);
  assert.match(adminPayload?.text || "", /Queue 1 running • 2 queued • max 7/);
  assert.match(adminPayload?.text || "", /Perintah Admin/);
  assert.match(adminPayload?.text || "", /\/pool - ringkasan akun Turnitin/);
  assert.match(poolPayload?.text || "", /Plagiasimu Bot • Pool Akun/);
  assert.match(poolPayload?.text || "", /one\*\*@example\.com/);
  assert.match(poolPayload?.text || "", /two\*\*@example\.com/);

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService replies when the quick button lanjut cek dokumen is pressed", async () => {
  const { dir, config } = await createConfig();

  const requests = [];
  const service = new TelegramBotService({
    config,
    jobRunner: {
      jobStore: {
        get() {
          return null;
        },
      },
      on() {},
      off() {},
    },
    fetchImpl: async (url, options = {}) => {
      const payload = options.body ? JSON.parse(options.body) : null;
      requests.push({
        url,
        payload,
      });

      if (url.endsWith("/sendMessage")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 327,
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });

  await service.handleUpdate({
    message: {
      chat: {
        id: 1001,
        type: "private",
      },
      from: {
        id: 1001,
        first_name: "Bob",
      },
      text: "Lanjut Cek Dokumen",
    },
  });

  const payload = requests.find((entry) => entry.url.endsWith("/sendMessage"))?.payload;
  assert.match(payload?.text || "", /Kirim file baru sebagai document/);

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService lets admin list, bulk-add, and delete pool accounts via Telegram commands", async () => {
  const { dir, config } = await createConfig();
  config.telegram.allowedChatIds = ["2002"];
  config.telegram.adminChatIds = ["2002"];
  await fs.writeFile(config.accountsFile, "user1@example.com | pass1\n", "utf8");

  const requests = [];
  const service = new TelegramBotService({
    config,
    jobRunner: {
      runningCount: 0,
      queuedCount: 0,
      jobStore: {
        get() {
          return null;
        },
      },
      on() {},
      off() {},
    },
    fetchImpl: async (url, options = {}) => {
      const payload = options.body ? JSON.parse(options.body) : null;
      requests.push({
        url,
        payload,
      });

      if (url.endsWith("/sendMessage")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 500 + requests.length,
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });

  const buildMessage = (text) => ({
    message: {
      chat: {
        id: 2002,
        type: "private",
      },
      from: {
        id: 2002,
        first_name: "Admin",
      },
      text,
    },
  });

  await service.handleUpdate(buildMessage("/accounts list"));
  await service.handleUpdate(
    buildMessage("/accounts add user2@example.com\n| pass2\n\nuser3@example.com\n| pass3")
  );
  await service.handleUpdate(buildMessage("/accountlist"));
  await service.handleUpdate(buildMessage("/accounts del user3@example.com"));

  const firstPayload = requests[0]?.payload;
  const secondPayload = requests[1]?.payload;
  const thirdPayload = requests[2]?.payload;
  const fourthPayload = requests[3]?.payload;
  const accounts = await fs.readFile(config.accountsFile, "utf8");

  assert.match(firstPayload?.text || "", /Total 1 akun terdaftar\./);
  assert.match(firstPayload?.text || "", /1\. user1@example\.com/);
  assert.match(secondPayload?.text || "", /2 akun berhasil ditambahkan\./);
  assert.match(secondPayload?.text || "", /Email pertama: user2@example\.com/);
  assert.match(thirdPayload?.text || "", /Total 3 akun terdaftar\./);
  assert.match(thirdPayload?.text || "", /2\. user2@example\.com/);
  assert.match(thirdPayload?.text || "", /3\. user3@example\.com/);
  assert.match(fourthPayload?.text || "", /Akun berhasil dihapus dari file pool\./);
  assert.match(fourthPayload?.text || "", /Sisa akun: 2/);
  assert.equal(accounts, "user1@example.com | pass1\nuser2@example.com | pass2\n");

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService sends pool alert only to configured admin chats", async () => {
  const { dir, config } = await createConfig();
  config.telegram.adminChatIds = ["6669292550"];
  config.telegram.adminAlertCooldownMs = 60 * 1000;

  const requests = [];
  const service = new TelegramBotService({
    config,
    jobRunner: {
      jobStore: {
        get() {
          return null;
        },
      },
      on() {},
      off() {},
    },
    fetchImpl: async (url, options = {}) => {
      const payload = options.body ? JSON.parse(options.body) : null;
      requests.push({
        url,
        payload,
      });

      if (url.endsWith("/sendMessage")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 901,
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });

  const first = await service.notifyAdminPoolAlert(
    {
      level: "warning",
      headline: "Pool akun mulai menipis.",
      detailText: "Pool akun mulai menipis. 1/2 akun usable • 3 assignment siap • 1 slot resubmit.",
      thresholds: {
        usableAccountsThreshold: 2,
        submittableAssignmentsThreshold: 6,
      },
      totals: {
        accountCount: 2,
        usableAccounts: 1,
        submittableAssignments: 3,
        resubmittableAssignments: 1,
      },
      generatedAt: "2026-03-10T11:30:00.000Z",
    },
    {
      runtime: {
        runningJobCount: 0,
        queuedJobCount: 2,
      },
    }
  );

  const second = await service.notifyAdminPoolAlert(
    {
      level: "warning",
      headline: "Pool akun mulai menipis.",
      detailText: "Pool akun mulai menipis. 1/2 akun usable • 3 assignment siap • 1 slot resubmit.",
      thresholds: {
        usableAccountsThreshold: 2,
        submittableAssignmentsThreshold: 6,
      },
      totals: {
        accountCount: 2,
        usableAccounts: 1,
        submittableAssignments: 3,
        resubmittableAssignments: 1,
      },
      generatedAt: "2026-03-10T11:31:00.000Z",
    },
    {
      runtime: {
        runningJobCount: 0,
        queuedJobCount: 2,
      },
    }
  );

  assert.equal(first.sent, true);
  assert.equal(second.sent, false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].payload.chat_id, "6669292550");
  assert.match(requests[0].payload.text, /Alert Admin/);

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService lets admin manually confirm a completed payment and release the job", async () => {
  const { dir, config } = await createConfig();
  config.telegram.adminChatIds = ["2002"];
  config.pakasir = {
    ...config.pakasir,
    enabled: true,
    project: "plagiasimu-bot",
    apiKey: "secret",
    amount: 5500,
    method: "qris",
    qrisOnly: true,
  };

  const stateStore = createMemoryStateStore([
    {
      orderId: "PLG-MANUAL-001",
      status: "pending",
      amount: 5500,
      totalPayment: 5849,
      paymentMethod: "qris",
      chatId: 1001,
      originalName: "manual.pdf",
      title: "manual",
      filePath: "/tmp/manual.pdf",
      reportOptions: {
        excludeQuotes: true,
        excludeBibliography: true,
        excludeMatches: false,
        excludeMatchesWordCount: 10,
      },
      createdAt: "2026-03-10T14:00:00.000Z",
    },
  ]);

  const requests = [];
  let queuedPayload = null;
  const jobRunner = {
    jobStore: {
      get(jobId) {
        return jobId === "job-manual-001" ? { id: jobId } : null;
      },
    },
    enqueue(payload, options) {
      queuedPayload = { payload, options };
      return {
        id: "job-manual-001",
        originalName: payload.originalName,
        title: payload.title,
        queuePosition: 1,
      };
    },
    async requestPump() {},
    scheduleEnqueueWatchdog() {},
    on() {},
    off() {},
  };

  const service = new TelegramBotService({
    config,
    jobRunner,
    stateStore,
    paymentService: {
      isConfigured() {
        return true;
      },
      async getTransactionDetail() {
        return {
          transaction: {
            orderId: "PLG-MANUAL-001",
            amount: 5500,
            project: "plagiasimu-bot",
            status: "completed",
            paymentMethod: "qris",
            completedAt: "2026-03-10T21:40:00.000Z",
          },
        };
      },
    },
    fetchImpl: async (url, options = {}) => {
      const payload = options.body ? JSON.parse(options.body) : null;
      requests.push({
        url,
        payload,
      });

      if (url.endsWith("/sendMessage")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 1200 + requests.length,
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });

  await service.handleUpdate({
    message: {
      chat: {
        id: 2002,
        type: "private",
      },
      from: {
        id: 2002,
        first_name: "Admin",
      },
      text: "/paymentcheck PLG-MANUAL-001",
    },
  });

  const adminPayload = requests.find(
    (entry) =>
      entry.url.endsWith("/sendMessage") && String(entry.payload?.chat_id) === "2002"
  )?.payload;
  const userPayload = requests.find(
    (entry) =>
      entry.url.endsWith("/sendMessage") && String(entry.payload?.chat_id) === "1001"
  )?.payload;

  assert.ok(queuedPayload);
  assert.equal(queuedPayload.payload.originalName, "manual.pdf");
  assert.deepEqual(queuedPayload.options, { autoStart: false });
  assert.equal(stateStore.getPayment("PLG-MANUAL-001")?.status, "completed");
  assert.equal(stateStore.getPayment("PLG-MANUAL-001")?.jobId, "job-manual-001");
  assert.equal(stateStore.getPayment("PLG-MANUAL-001")?.verificationSource, "admin-manual-check");
  assert.match(adminPayload?.text || "", /Manual Payment Check/);
  assert.match(adminPayload?.text || "", /Status Provider completed/);
  assert.match(adminPayload?.text || "", /Job ID job-manual-001/);
  assert.match(adminPayload?.text || "", /dilepas ke queue/i);
  assert.match(userPayload?.text || "", /Pembayaran Rp/);

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService manual payment check does not release provider-completed payments without local state", async () => {
  const { dir, config } = await createConfig();
  config.telegram.adminChatIds = ["2002"];
  config.pakasir = {
    ...config.pakasir,
    enabled: true,
    project: "plagiasimu-bot",
    apiKey: "secret",
    amount: 5500,
    method: "qris",
    qrisOnly: true,
  };

  let enqueueCount = 0;
  const requests = [];
  const service = new TelegramBotService({
    config,
    jobRunner: {
      jobStore: {
        get() {
          return null;
        },
      },
      enqueue() {
        enqueueCount += 1;
        return {
          id: "job-should-not-run",
          queuePosition: 1,
        };
      },
      async requestPump() {},
      scheduleEnqueueWatchdog() {},
      on() {},
      off() {},
    },
    stateStore: createMemoryStateStore(),
    paymentService: {
      isConfigured() {
        return true;
      },
      async getTransactionDetail() {
        return {
          transaction: {
            orderId: "PLG-MANUAL-404",
            amount: 5500,
            project: "plagiasimu-bot",
            status: "completed",
            paymentMethod: "qris",
            completedAt: "2026-03-10T21:41:00.000Z",
          },
        };
      },
    },
    fetchImpl: async (url, options = {}) => {
      const payload = options.body ? JSON.parse(options.body) : null;
      requests.push({
        url,
        payload,
      });

      if (url.endsWith("/sendMessage")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 1300,
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });

  await service.handleUpdate({
    message: {
      chat: {
        id: 2002,
        type: "private",
      },
      from: {
        id: 2002,
        first_name: "Admin",
      },
      text: "/paymentcheck PLG-MANUAL-404",
    },
  });

  const adminPayload = requests.find((entry) => entry.url.endsWith("/sendMessage"))?.payload;
  assert.equal(enqueueCount, 0);
  assert.match(adminPayload?.text || "", /Status Provider completed/);
  assert.match(adminPayload?.text || "", /state lokal invoice tidak ditemukan/i);

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService lets admin manually approve a local payment when gateway status is stuck", async () => {
  const { dir, config } = await createConfig();
  config.telegram.adminChatIds = ["2002"];

  const stateStore = createMemoryStateStore([
    {
      orderId: "PLG-APPROVE-001",
      status: "pending",
      amount: 5500,
      totalPayment: 5849,
      paymentMethod: "qris",
      chatId: 1001,
      originalName: "stuck.pdf",
      title: "stuck",
      filePath: "/tmp/stuck.pdf",
      reportOptions: {
        excludeQuotes: true,
        excludeBibliography: true,
        excludeMatches: false,
        excludeMatchesWordCount: 10,
      },
      createdAt: "2026-03-10T14:30:00.000Z",
    },
  ]);

  const requests = [];
  let queuedPayload = null;
  const service = new TelegramBotService({
    config,
    jobRunner: {
      jobStore: {
        get(jobId) {
          return jobId === "job-approve-001" ? { id: jobId } : null;
        },
      },
      enqueue(payload, options) {
        queuedPayload = { payload, options };
        return {
          id: "job-approve-001",
          originalName: payload.originalName,
          title: payload.title,
          queuePosition: 1,
        };
      },
      async requestPump() {},
      scheduleEnqueueWatchdog() {},
      on() {},
      off() {},
    },
    stateStore,
    fetchImpl: async (url, options = {}) => {
      const payload = options.body ? JSON.parse(options.body) : null;
      requests.push({
        url,
        payload,
      });

      if (url.endsWith("/sendMessage")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 1350 + requests.length,
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });

  await service.handleUpdate({
    message: {
      chat: {
        id: 2002,
        type: "private",
      },
      from: {
        id: 2002,
        first_name: "Admin",
      },
      text: "/paymentapprove PLG-APPROVE-001",
    },
  });

  const adminPayload = requests.find(
    (entry) =>
      entry.url.endsWith("/sendMessage") && String(entry.payload?.chat_id) === "2002"
  )?.payload;
  const userPayload = requests.find(
    (entry) =>
      entry.url.endsWith("/sendMessage") && String(entry.payload?.chat_id) === "1001"
  )?.payload;

  assert.ok(queuedPayload);
  assert.equal(queuedPayload.payload.originalName, "stuck.pdf");
  assert.deepEqual(queuedPayload.options, { autoStart: false });
  assert.equal(stateStore.getPayment("PLG-APPROVE-001")?.status, "completed");
  assert.equal(stateStore.getPayment("PLG-APPROVE-001")?.jobId, "job-approve-001");
  assert.equal(
    stateStore.getPayment("PLG-APPROVE-001")?.verificationSource,
    "admin-manual-approve"
  );
  assert.match(adminPayload?.text || "", /Manual Payment Approve/);
  assert.match(adminPayload?.text || "", /di-acc manual oleh admin/i);
  assert.match(userPayload?.text || "", /Pembayaran Rp/);

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService blocks manual payment approve when local invoice is missing", async () => {
  const { dir, config } = await createConfig();
  config.telegram.adminChatIds = ["2002"];

  let enqueueCount = 0;
  const requests = [];
  const service = new TelegramBotService({
    config,
    jobRunner: {
      jobStore: {
        get() {
          return null;
        },
      },
      enqueue() {
        enqueueCount += 1;
        return {
          id: "job-should-not-run",
          queuePosition: 1,
        };
      },
      async requestPump() {},
      scheduleEnqueueWatchdog() {},
      on() {},
      off() {},
    },
    stateStore: createMemoryStateStore(),
    fetchImpl: async (url, options = {}) => {
      const payload = options.body ? JSON.parse(options.body) : null;
      requests.push({
        url,
        payload,
      });

      if (url.endsWith("/sendMessage")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 1400,
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });

  await service.handleUpdate({
    message: {
      chat: {
        id: 2002,
        type: "private",
      },
      from: {
        id: 2002,
        first_name: "Admin",
      },
      text: "/paymentapprove PLG-APPROVE-404",
    },
  });

  const adminPayload = requests.find((entry) => entry.url.endsWith("/sendMessage"))?.payload;
  assert.equal(enqueueCount, 0);
  assert.match(adminPayload?.text || "", /Manual Payment Approve/);
  assert.match(adminPayload?.text || "", /invoice tidak ditemukan di state lokal/i);

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService creates a Pakasir invoice before enqueue when payment is enabled", async () => {
  const { dir, config } = await createConfig();
  await fs.mkdir(config.storage.uploadsDir, { recursive: true });
  const stateStore = createMemoryStateStore();
  const requests = [];
  const sendPhotoPayloads = [];
  let queuedPayload = null;

  config.pakasir = {
    ...config.pakasir,
    enabled: true,
    project: "plagiasimu-bot",
    apiKey: "secret",
    amount: 22000,
    method: "qris",
    qrisOnly: true,
  };

  const jobRunner = {
    jobStore: {
      get() {
        return null;
      },
    },
    enqueue(payload) {
      queuedPayload = payload;
      return {
        id: "job-payment-should-not-run",
        originalName: payload.originalName,
        title: payload.title,
        queuePosition: 1,
      };
    },
    async requestPump() {},
    scheduleEnqueueWatchdog() {},
    on() {},
    off() {},
  };

  const service = new TelegramBotService({
    config,
    jobRunner,
    stateStore,
    paymentService: {
      isConfigured() {
        return true;
      },
      createOrderId() {
        return "PLG-TEST-001";
      },
      async createTransaction() {
        return {
          payment: {
            orderId: "PLG-TEST-001",
            amount: 22000,
            totalPayment: 22349,
            fee: 349,
            paymentMethod: "qris",
            paymentNumber: "000201...",
            expiredAt: "2026-03-10T12:00:00.000Z",
          },
        };
      },
      buildCheckoutUrl() {
        return "https://app.pakasir.com/pay/plagiasimu-bot/22000?order_id=PLG-TEST-001&qris_only=1";
      },
    },
    fetchImpl: async (url, options = {}) => {
      const payload =
        options.body && !Buffer.isBuffer(options.body) ? JSON.parse(options.body) : null;
      requests.push({
        url,
        payload,
      });

      if (url.endsWith("/getFile")) {
        return jsonResponse({
          ok: true,
          result: {
            file_path: "documents/paid.pdf",
          },
        });
      }

      if (url.endsWith("/documents/paid.pdf")) {
        return new Response(Buffer.from("payment-file"), {
          status: 200,
          headers: {
            "content-type": "application/pdf",
          },
        });
      }

      if (url.endsWith("/sendMessage")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 401,
          },
        });
      }

      if (url.endsWith("/sendPhoto")) {
        sendPhotoPayloads.push(
          Buffer.isBuffer(options.body) ? options.body.toString("utf8") : String(options.body)
        );
        return jsonResponse({
          ok: true,
          result: {
            message_id: 400,
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });

  await service.handleDocumentMessage({
    chat: { id: 1001, type: "private" },
    from: { id: 1001, first_name: "Alice", username: "alice" },
    document: {
      file_id: "paid-file-1",
      file_name: "paid.pdf",
      file_size: 1024,
    },
    caption: "Invoice Dulu\nfilter: off",
  });

  assert.equal(queuedPayload, null);
  assert.equal(service.pendingPayments.size, 1);
  const payment = stateStore.getPayment("PLG-TEST-001");
  assert.equal(payment?.status, "pending");
  assert.equal(payment?.amount, 22000);
  assert.equal(payment?.totalPayment, 22349);
  assert.equal(payment?.originalName, "paid.pdf");
  assert.equal(sendPhotoPayloads.length, 1);
  assert.equal(requests.filter((entry) => entry.url.endsWith("/sendMessage")).length, 0);
  assert.match(sendPhotoPayloads[0] || "", /Menunggu Pembayaran/);
  assert.match(sendPhotoPayloads[0] || "", /Invoice PLG-TEST-001/);
  assert.match(sendPhotoPayloads[0] || "", /Tagihan Rp\s*22\.000/);
  assert.match(sendPhotoPayloads[0] || "", /Total Bayar Rp\s*22\.349/);
  assert.match(sendPhotoPayloads[0] || "", /https:\/\/app\.pakasir\.com\/pay\/plagiasimu-bot\/22000\?order_id=PLG-TEST-001&qris_only=1/);

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService enqueues the document only after Pakasir payment is completed", async () => {
  const { dir, config } = await createConfig();
  const stateStore = createMemoryStateStore();
  const requests = [];
  let queuedPayload = null;

  config.pakasir = {
    ...config.pakasir,
    enabled: true,
    project: "plagiasimu-bot",
    apiKey: "secret",
    amount: 22000,
    method: "qris",
    qrisOnly: true,
    statusPollIntervalMs: 5000,
  };

  const jobRunner = {
    jobStore: {
      get() {
        return null;
      },
    },
    enqueue(payload, options) {
      queuedPayload = {
        payload,
        options,
      };
      return {
        id: "job-after-payment",
        originalName: payload.originalName,
        title: payload.title,
        queuePosition: 1,
      };
    },
    async requestPump() {},
    scheduleEnqueueWatchdog() {},
    on() {},
    off() {},
  };

  const service = new TelegramBotService({
    config,
    jobRunner,
    stateStore,
    paymentService: {
      isConfigured() {
        return true;
      },
      createOrderId() {
        return "PLG-TEST-002";
      },
      async createTransaction() {
        return {
          payment: {
            orderId: "PLG-TEST-002",
            amount: 22000,
            totalPayment: 22349,
            fee: 349,
            paymentMethod: "qris",
            paymentNumber: "000201...",
            expiredAt: "2026-03-10T12:00:00.000Z",
          },
        };
      },
      buildCheckoutUrl() {
        return "https://app.pakasir.com/pay/plagiasimu-bot/22000?order_id=PLG-TEST-002&qris_only=1";
      },
      async getTransactionDetail() {
        return {
          transaction: {
            orderId: "PLG-TEST-002",
            amount: 22000,
            project: "plagiasimu-bot",
            status: "completed",
            paymentMethod: "qris",
            completedAt: "2026-03-10T10:00:00.000Z",
          },
        };
      },
    },
    fetchImpl: async (url, options = {}) => {
      const payload =
        options.body && !Buffer.isBuffer(options.body) ? JSON.parse(options.body) : null;
      requests.push({
        url,
        payload,
      });

      if (url.endsWith("/sendMessage")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 501,
          },
        });
      }

      if (url.endsWith("/editMessageText")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 501,
          },
        });
      }

      if (url.endsWith("/sendPhoto")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 500,
          },
        });
      }

      if (url.endsWith("/deleteMessage")) {
        return jsonResponse({
          ok: true,
          result: true,
        });
      }

      if (url.endsWith("/answerCallbackQuery")) {
        return jsonResponse({
          ok: true,
          result: true,
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });

  await service.submitPreparedSubmission(1001, {
    filePath: "/tmp/upload-payment.pdf",
    originalName: "upload-payment.pdf",
    title: "upload-payment",
    reportOptions: {
      excludeQuotes: false,
      excludeBibliography: false,
      excludeMatches: false,
      excludeMatchesWordCount: 10,
    },
  });

  assert.equal(queuedPayload, null);
  await service.handleCallbackQuery({
    id: "callback-1",
    message: {
      message_id: 501,
      chat: { id: 1001 },
    },
    data: "payment:check:PLG-TEST-002",
  });

  assert.ok(queuedPayload);
  assert.equal(queuedPayload.payload.originalName, "upload-payment.pdf");
  assert.equal(queuedPayload.payload.title, "upload-payment");
  assert.deepEqual(queuedPayload.options, { autoStart: false });
  assert.equal(
    requests.filter((entry) => entry.url.endsWith("/sendPhoto")).length,
    1
  );
  assert.equal(
    requests.filter((entry) => entry.url.endsWith("/deleteMessage")).length,
    1
  );
  assert.equal(
    requests.filter((entry) => entry.url.endsWith("/sendMessage")).length,
    1
  );
  assert.equal(service.pendingPayments.size, 0);
  assert.equal(stateStore.getPayment("PLG-TEST-002")?.status, "completed");
  assert.equal(stateStore.getPayment("PLG-TEST-002")?.jobId, "job-after-payment");
  assert.equal(
    requests.find((entry) => entry.url.endsWith("/answerCallbackQuery"))?.payload?.text,
    "Pembayaran terkonfirmasi."
  );

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService keeps one draft message and applies keyboard filter selection", async () => {
  const { dir, config } = await createConfig();
  await fs.mkdir(config.storage.uploadsDir, { recursive: true });

  const requests = [];
  let queuedPayload = null;
  const jobRunner = {
    jobStore: {
      get() {
        return null;
      },
    },
    enqueue(payload) {
      queuedPayload = payload;
      return {
        id: "job-pending-title",
        originalName: payload.originalName,
        title: payload.title,
        queuePosition: 1,
      };
    },
    on() {},
    off() {},
  };

  const service = new TelegramBotService({
    config,
    jobRunner,
    fetchImpl: async (url, options = {}) => {
      requests.push({
        url,
        method: options.method || "GET",
      });

      if (url.endsWith("/getFile")) {
        return jsonResponse({
          ok: true,
          result: {
            file_path: "documents/draft.pdf",
          },
        });
      }

      if (url.endsWith("/sendMessage")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id:
              requests.filter((entry) => entry.url.endsWith("/sendMessage")).length + 76,
          },
        });
      }

      if (url.endsWith("/deleteMessage")) {
        return jsonResponse({
          ok: true,
          result: true,
        });
      }

      if (url.endsWith("/documents/draft.pdf")) {
        return new Response(Buffer.from("draft-content"), {
          status: 200,
          headers: {
            "content-type": "application/pdf",
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });

  await service.handleDocumentMessage({
    chat: { id: 1001 },
    document: {
      file_id: "file-2",
      file_name: "draft.pdf",
      file_size: 1024,
    },
    caption: "",
  });

  assert.equal(queuedPayload, null);
  assert.equal(service.pendingSubmissions.size, 1);
  assert.equal(service.pendingSubmissions.get("1001")?.statusMessageId, 77);

  await service.handleUpdate({
    message: {
      chat: { id: 1001 },
      text: "Judul Custom Baru",
    },
  });

  assert.equal(queuedPayload, null);
  assert.equal(service.pendingSubmissions.get("1001")?.step, "filter");

  await service.handleUpdate({
    message: {
      chat: { id: 1001 },
      text: "Filter Lengkap",
    },
  });

  assert.ok(queuedPayload);
  assert.equal(queuedPayload.title, "Judul Custom Baru");
  assert.deepEqual(queuedPayload.reportOptions, {
    excludeQuotes: true,
    excludeBibliography: true,
    excludeMatches: true,
    excludeMatchesWordCount: 10,
  });
  assert.equal(service.pendingSubmissions.size, 0);
  assert.equal(
    requests.filter((entry) => entry.url.endsWith("/sendMessage")).length,
    3
  );
  assert.equal(
    requests.filter((entry) => entry.url.endsWith("/deleteMessage")).length,
    2
  );
  assert.equal(
    requests.filter((entry) => entry.url.endsWith("/answerCallbackQuery")).length,
    0
  );

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService keeps reply keyboard staged and does not accept filter before title", async () => {
  const { dir, config } = await createConfig();
  await fs.mkdir(config.storage.uploadsDir, { recursive: true });

  const requests = [];
  let queuedPayload = null;
  const jobRunner = {
    jobStore: {
      get() {
        return null;
      },
    },
    enqueue(payload) {
      queuedPayload = payload;
      return {
        id: "job-stage-flow",
        originalName: payload.originalName,
        title: payload.title,
        queuePosition: 1,
      };
    },
    on() {},
    off() {},
  };

  const service = new TelegramBotService({
    config,
    jobRunner,
    fetchImpl: async (url, options = {}) => {
      const payload = options.body ? JSON.parse(options.body) : null;
      requests.push({
        url,
        method: options.method || "GET",
        payload,
      });

      if (url.endsWith("/getFile")) {
        return jsonResponse({
          ok: true,
          result: {
            file_path: "documents/staged.pdf",
          },
        });
      }

      if (url.endsWith("/sendMessage")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id:
              requests.filter((entry) => entry.url.endsWith("/sendMessage")).length + 90,
          },
        });
      }

      if (url.endsWith("/deleteMessage")) {
        return jsonResponse({
          ok: true,
          result: true,
        });
      }

      if (url.endsWith("/documents/staged.pdf")) {
        return new Response(Buffer.from("staged-content"), {
          status: 200,
          headers: {
            "content-type": "application/pdf",
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });

  await service.handleDocumentMessage({
    chat: { id: 1001 },
    document: {
      file_id: "file-3",
      file_name: "staged.pdf",
      file_size: 1024,
    },
    caption: "",
  });

  const firstPrompt = requests.find((entry) => entry.url.endsWith("/sendMessage"));
  assert.deepEqual(firstPrompt?.payload?.reply_markup?.keyboard, [
    [{ text: "Pakai nama file" }],
    [{ text: "Batal" }],
  ]);

  await service.handleUpdate({
    message: {
      chat: { id: 1001 },
      text: "Filter Lengkap",
    },
  });

  assert.equal(queuedPayload, null);
  assert.equal(service.pendingSubmissions.get("1001")?.step, "title");

  const secondPrompt = requests.filter((entry) => entry.url.endsWith("/sendMessage"))[1];
  assert.deepEqual(secondPrompt?.payload?.reply_markup?.keyboard, [
    [{ text: "Pakai nama file" }],
    [{ text: "Batal" }],
  ]);

  await service.handleUpdate({
    message: {
      chat: { id: 1001 },
      text: "Pakai nama file",
    },
  });

  assert.equal(queuedPayload, null);
  assert.equal(service.pendingSubmissions.get("1001")?.step, "filter");

  const thirdPrompt = requests.filter((entry) => entry.url.endsWith("/sendMessage"))[2];
  assert.deepEqual(thirdPrompt?.payload?.reply_markup?.keyboard, [
    [{ text: "Filter Off" }, { text: "Filter Standar" }],
    [{ text: "Filter Lengkap" }],
    [{ text: "Batal" }],
  ]);

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService auto-enqueues caption-filtered documents even while another draft is pending", async () => {
  const { dir, config } = await createConfig();
  await fs.mkdir(config.storage.uploadsDir, { recursive: true });

  const requests = [];
  const queuedPayloads = [];
  const jobRunner = {
    jobStore: {
      get() {
        return null;
      },
    },
    enqueue(payload, options) {
      queuedPayloads.push({ payload, options: options || null });
      return {
        id: `job-batch-${queuedPayloads.length}`,
        originalName: payload.originalName,
        title: payload.title,
        queuePosition: queuedPayloads.length,
      };
    },
    async requestPump() {},
    scheduleEnqueueWatchdog() {},
    on() {},
    off() {},
  };

  const service = new TelegramBotService({
    config,
    jobRunner,
    fetchImpl: async (url, options = {}) => {
      requests.push({
        url,
        payload: options.body ? JSON.parse(options.body) : null,
      });

      if (url.endsWith("/getFile")) {
        const fileId = requests.filter((entry) => entry.url.endsWith("/getFile")).length;
        return jsonResponse({
          ok: true,
          result: {
            file_path: `documents/file-${fileId}.pdf`,
          },
        });
      }

      if (/\/documents\/file-\d+\.pdf$/.test(url)) {
        return new Response(Buffer.from("pdf-content"), {
          status: 200,
          headers: {
            "content-type": "application/pdf",
          },
        });
      }

      if (url.endsWith("/sendMessage")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: requests.filter((entry) => entry.url.endsWith("/sendMessage")).length + 200,
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });

  await service.handleDocumentMessage({
    chat: { id: 1001 },
    document: {
      file_id: "file-1",
      file_name: "draft-first.pdf",
      file_size: 1024,
    },
    caption: "",
  });

  assert.equal(service.pendingSubmissions.get("1001")?.step, "title");
  assert.equal(queuedPayloads.length, 0);

  await service.handleDocumentMessage({
    chat: { id: 1001 },
    document: {
      file_id: "file-2",
      file_name: "batch-second.pdf",
      file_size: 1024,
    },
    caption: "filter: standar",
  });

  assert.equal(queuedPayloads.length, 1);
  assert.equal(queuedPayloads[0].payload.originalName, "batch-second.pdf");
  assert.equal(queuedPayloads[0].payload.title, "batch-second");
  assert.deepEqual(queuedPayloads[0].payload.reportOptions, {
    excludeQuotes: true,
    excludeBibliography: true,
    excludeMatches: false,
    excludeMatchesWordCount: 10,
  });
  assert.deepEqual(queuedPayloads[0].options, { autoStart: false });
  assert.equal(service.pendingSubmissions.get("1001")?.originalName, "draft-first.pdf");

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService cancels a running job from the reply keyboard", async () => {
  const { dir, config } = await createConfig();

  const cancelled = [];
  const jobRunner = {
    jobStore: {
      get() {
        return {
          id: "job-inline-cancel",
          status: "running",
        };
      },
    },
    cancel(jobId, options) {
      cancelled.push([jobId, options?.reason]);
      return {
        id: jobId,
        status: "cancelled",
      };
    },
    on() {},
    off() {},
  };

  const service = new TelegramBotService({
    config,
    jobRunner,
    fetchImpl: async () => {
      throw new Error("No Telegram API call expected.");
    },
    logger: {
      log() {},
      error() {},
    },
  });

  service.jobContexts.set("job-inline-cancel", {
    chatId: 1001,
    statusMessageId: 77,
    lastStatusText: null,
    lastReplyMarkupKey: "",
    lastVisibleLogMessage: null,
    lastProgressUpdateAt: 0,
  });

  await service.handleUpdate({
    message: {
      chat: { id: 1001 },
      text: "Batal",
    },
  });

  assert.deepEqual(cancelled, [["job-inline-cancel", "Dibatalkan dari Telegram."]]);

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService ignores stale cancel text when no active job exists", async () => {
  const { dir, config } = await createConfig();

  const sent = [];
  const service = new TelegramBotService({
    config,
    jobRunner: {
      jobStore: {
        get() {
          return null;
        },
      },
      on() {},
      off() {},
    },
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith("/sendMessage")) {
        sent.push(JSON.parse(options.body));
        return jsonResponse({
          ok: true,
          result: {
            message_id: 321,
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });

  await service.handleUpdate({
    message: {
      chat: { id: 1001 },
      text: "Batal",
    },
  });

  assert.equal(sent.length, 0);

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService expires pending drafts without auto-enqueue", async () => {
  const { dir, config } = await createConfig();
  await fs.mkdir(config.storage.uploadsDir, { recursive: true });

  const requests = [];
  let enqueueCount = 0;
  const stagedFilePath = path.join(config.storage.uploadsDir, "expired.pdf");
  await fs.writeFile(stagedFilePath, "expired-content");
  const jobRunner = {
    jobStore: {
      get() {
        return null;
      },
    },
    enqueue() {
      enqueueCount += 1;
      return {
        id: "job-should-not-run",
        queuePosition: 1,
      };
    },
    on() {},
    off() {},
  };

  const service = new TelegramBotService({
    config,
    jobRunner,
    fetchImpl: async (url, options = {}) => {
      requests.push({
        url,
        payload: options.body ? JSON.parse(options.body) : null,
      });

      if (url.endsWith("/sendMessage")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 701,
          },
        });
      }

      if (url.endsWith("/editMessageText")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 700,
          },
        });
      }

      if (url.endsWith("/deleteMessage")) {
        return jsonResponse({
          ok: true,
          result: true,
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });

  service.pendingSubmissions.set("1001", {
    chatId: 1001,
    filePath: stagedFilePath,
    originalName: "expired.pdf",
    title: "",
    step: "title",
    reportOptions: null,
    statusMessageId: 700,
    receivedAt: Date.now() - 120000,
    expiresAt: Date.now() - 1000,
  });

  await service.flushExpiredPendingSubmissions();

  assert.equal(enqueueCount, 0);
  assert.equal(service.pendingSubmissions.size, 0);
  assert.equal(
    requests.filter((entry) => entry.url.endsWith("/sendMessage")).length,
    1
  );
  assert.equal(
    requests.filter((entry) => entry.url.endsWith("/editMessageText")).length,
    0
  );
  assert.equal(
    requests.filter((entry) => entry.url.endsWith("/deleteMessage")).length,
    1
  );
  assert.deepEqual(
    requests.find((entry) => entry.url.endsWith("/sendMessage"))?.payload?.reply_markup?.keyboard,
    [[{ text: "Lanjut Cek Dokumen" }]]
  );
  await assert.rejects(fs.access(stagedFilePath));

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService edits status and sends result artifacts when a job completes", async () => {
  const { dir, config } = await createConfig();
  const reportDir = path.join(dir, "reports", "job-1");
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, "similarity-report.pdf"), "pdf");
  await fs.writeFile(path.join(reportDir, "digital-receipt.pdf"), "receipt");
  await fs.writeFile(path.join(reportDir, "submission-status.png"), "png");

  const fetchCalls = [];
  const sendDocumentPayloads = [];
  const jobRunner = Object.assign(new EventEmitter(), {
    jobStore: {
      get() {
        return null;
      },
    },
  });

  const service = new TelegramBotService({
    config: {
      ...config,
      storage: {
        ...config.storage,
        dir,
      },
    },
    jobRunner,
    fetchImpl: async (url, options = {}) => {
      fetchCalls.push({
        url,
        method: options.method || "GET",
      });

      if (url.endsWith("/editMessageText")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 55,
          },
        });
      }

      if (url.endsWith("/sendDocument")) {
        sendDocumentPayloads.push({
          body: Buffer.isBuffer(options.body) ? options.body.toString("utf8") : String(options.body),
        });
        return jsonResponse({
          ok: true,
          result: {
            message_id: 88,
          },
        });
      }

      if (url.endsWith("/sendPhoto")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 99,
          },
        });
      }

      if (url.endsWith("/sendMessage")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 111,
          },
        });
      }

      if (url.endsWith("/pinChatMessage")) {
        return jsonResponse({
          ok: true,
          result: true,
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });
  service.sanitizeJobForDelivery = async (job) => job;

  service.jobContexts.set("job-1", {
    chatId: 1001,
    statusMessageId: 55,
    lastStatusText: null,
    lastVisibleLogMessage: null,
    lastProgressUpdateAt: 0,
  });

  const job = {
    id: "job-1",
    originalName: "paper revisi final.docx",
    title: "paper",
    logs: [],
    result: {
      similarity: "15%",
      reportOptions: {
        excludeQuotes: true,
        excludeBibliography: true,
        excludeMatches: false,
        excludeMatchesWordCount: 10,
      },
      className: "Class A",
      assignmentName: "Assignment B",
      artifacts: {
        viewerPdf: "/storage/reports/job-1/similarity-report.pdf",
        digitalReceipt: "/storage/reports/job-1/digital-receipt.pdf",
        submissionStatusImage: "/storage/reports/job-1/submission-status.png",
      },
    },
  };

  await service.handleJobStarted(job);
  await service.handleJobLog({
    job: {
      ...job,
      logs: [
        {
          timestamp: "2026-03-08T00:00:00.000Z",
          message: "Upload selesai",
        },
      ],
    },
    log: {
      timestamp: "2026-03-08T00:00:00.000Z",
      message: "Upload selesai",
    },
  });
  await service.handleJobCompleted(job);

  assert.equal(
    fetchCalls.filter((entry) => entry.url.endsWith("/editMessageText")).length >= 2,
    true
  );
  assert.equal(
    fetchCalls.filter((entry) => entry.url.endsWith("/sendMessage")).length,
    0
  );
  assert.equal(
    fetchCalls.filter((entry) => entry.url.endsWith("/sendDocument")).length,
    1
  );
  assert.equal(
    fetchCalls.filter((entry) => entry.url.endsWith("/sendPhoto")).length,
    0
  );
  assert.equal(
    fetchCalls.filter((entry) => entry.url.endsWith("/pinChatMessage")).length,
    1
  );
  assert.match(sendDocumentPayloads[0]?.body || "", /filename="paper revisi final\.pdf"/);
  assert.match(
    sendDocumentPayloads[0]?.body || "",
    /name="caption"\r\n\r\npaper revisi final\.docx • 15% • Standar/
  );

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService skips invalid filtered viewer PDF without sending an extra warning chat", async () => {
  const { dir, config } = await createConfig();
  const reportDir = path.join(dir, "reports", "job-invalid");
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, "similarity-report.pdf"), "pdf");

  const fetchCalls = [];
  const service = new TelegramBotService({
    config: {
      ...config,
      storage: {
        ...config.storage,
        dir,
      },
    },
    jobRunner: Object.assign(new EventEmitter(), {
      jobStore: {
        get() {
          return null;
        },
      },
    }),
    fetchImpl: async (url, options = {}) => {
      fetchCalls.push({
        url,
        method: options.method || "GET",
      });

      if (url.endsWith("/editMessageText")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 55,
          },
        });
      }

      if (url.endsWith("/sendMessage")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 111,
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });
  service.sanitizeJobForDelivery = async (job) => ({
    ...job,
    result: {
      ...(job.result || {}),
      artifacts: {},
    },
  });

  service.jobContexts.set("job-invalid", {
    chatId: 1001,
    statusMessageId: 55,
    lastStatusText: null,
    lastVisibleLogMessage: null,
    lastProgressUpdateAt: 0,
  });

  await service.handleJobCompleted({
    id: "job-invalid",
    originalName: "paper.pdf",
    title: "paper",
    createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    result: {
      similarity: "34%",
      finishedAt: new Date().toISOString(),
      reportOptions: {
        excludeQuotes: true,
        excludeBibliography: true,
        excludeMatches: false,
        excludeMatchesWordCount: 10,
      },
      artifacts: {
        viewerPdf: "/storage/reports/job-invalid/similarity-report.pdf",
      },
    },
  });

  assert.equal(
    fetchCalls.filter((entry) => entry.url.endsWith("/sendDocument")).length,
    0
  );
  assert.equal(
    fetchCalls.filter((entry) => entry.url.endsWith("/pinChatMessage")).length,
    0
  );
  assert.equal(
    fetchCalls.filter((entry) => entry.url.endsWith("/sendMessage")).length,
    0
  );

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService keeps QRIS invoice in one photo message by editing the caption", async () => {
  const { dir, config } = await createConfig();
  const requests = [];
  const stateStore = createMemoryStateStore();
  const service = new TelegramBotService({
    config,
    jobRunner: {
      jobStore: {
        get() {
          return null;
        },
      },
      on() {},
      off() {},
    },
    stateStore,
    fetchImpl: async (url, options = {}) => {
      requests.push({
        url,
        body: Buffer.isBuffer(options.body) ? options.body.toString("utf8") : String(options.body || ""),
      });

      if (url.endsWith("/editMessageCaption")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 700,
          },
        });
      }

      if (url.endsWith("/sendPhoto")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 700,
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });

  const payment = {
    orderId: "PLG-EDIT-CAPTION",
    chatId: 1001,
    originalName: "caption.pdf",
    title: "caption",
    amount: 5500,
    totalPayment: 5849,
    paymentMethod: "qris",
    paymentNumber: "000201-A",
    paymentUrl: "https://app.pakasir.com/pay/test/5500?order_id=PLG-EDIT-CAPTION",
    status: "pending",
    providerStatus: "pending",
    statusMessageId: 700,
    statusMessageKind: "photo",
    lastStatusText: "old",
    lastReplyMarkupKey: "",
    lastQrMediaKey: "",
  };
  service.pendingPayments.set(payment.orderId, payment);
  const qrImagePath = await service.ensurePaymentQrImage(payment);
  payment.lastQrMediaKey = `${payment.paymentNumber}::${qrImagePath}`;

  await service.upsertPendingPaymentMessage(payment.orderId);

  assert.equal(
    requests.filter((entry) => entry.url.endsWith("/sendPhoto")).length,
    0
  );
  assert.equal(
    requests.filter((entry) => entry.url.endsWith("/editMessageCaption")).length,
    1
  );

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService updates the existing QRIS invoice message when the QR changes", async () => {
  const { dir, config } = await createConfig();
  const requests = [];
  const stateStore = createMemoryStateStore();
  const service = new TelegramBotService({
    config,
    jobRunner: {
      jobStore: {
        get() {
          return null;
        },
      },
      on() {},
      off() {},
    },
    stateStore,
    fetchImpl: async (url, options = {}) => {
      requests.push({
        url,
        body: Buffer.isBuffer(options.body) ? options.body.toString("utf8") : String(options.body || ""),
      });

      if (url.endsWith("/editMessageMedia")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 701,
          },
        });
      }

      if (url.endsWith("/sendPhoto")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 701,
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });

  const payment = {
    orderId: "PLG-EDIT-MEDIA",
    chatId: 1001,
    originalName: "media.pdf",
    title: "media",
    amount: 5500,
    totalPayment: 5849,
    paymentMethod: "qris",
    paymentNumber: "000201-OLD",
    paymentUrl: "https://app.pakasir.com/pay/test/5500?order_id=PLG-EDIT-MEDIA",
    status: "pending",
    providerStatus: "pending",
    statusMessageId: 701,
    statusMessageKind: "photo",
    lastStatusText: "old",
    lastReplyMarkupKey: "",
    lastQrMediaKey: "",
  };
  service.pendingPayments.set(payment.orderId, payment);
  const firstQrImagePath = await service.ensurePaymentQrImage(payment);
  payment.lastQrMediaKey = `${payment.paymentNumber}::${firstQrImagePath}`;
  payment.paymentNumber = "000201-NEW";
  payment.qrImagePath = null;
  payment.qrImageValue = null;

  await service.upsertPendingPaymentMessage(payment.orderId);

  assert.equal(
    requests.filter((entry) => entry.url.endsWith("/sendPhoto")).length,
    0
  );
  assert.equal(
    requests.filter((entry) => entry.url.endsWith("/editMessageMedia")).length,
    1
  );
  assert.match(
    requests.find((entry) => entry.url.endsWith("/editMessageMedia"))?.body || "",
    /attach:\/\/photo/
  );

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService retries current view upload when Telegram sendDocument resets the connection", async () => {
  const { dir, config } = await createConfig();
  const reportDir = path.join(dir, "reports", "job-retry");
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, "similarity-report.pdf"), "pdf");

  const fetchCalls = [];
  let sendDocumentAttempts = 0;
  const loggerErrors = [];
  const service = new TelegramBotService({
    config: {
      ...config,
      telegram: {
        ...config.telegram,
        retryDelayMs: 1,
        sendRetryAttempts: 3,
      },
      storage: {
        ...config.storage,
        dir,
      },
    },
    jobRunner: Object.assign(new EventEmitter(), {
      jobStore: {
        get() {
          return null;
        },
      },
    }),
    fetchImpl: async (url, options = {}) => {
      fetchCalls.push({
        url,
        method: options.method || "GET",
      });

      if (url.endsWith("/editMessageText")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 55,
          },
        });
      }

      if (url.endsWith("/sendDocument")) {
        sendDocumentAttempts += 1;
        if (sendDocumentAttempts === 1) {
          const error = new Error("read ECONNRESET");
          error.code = "ECONNRESET";
          throw error;
        }
        return jsonResponse({
          ok: true,
          result: {
            message_id: 188,
          },
        });
      }

      if (url.endsWith("/pinChatMessage")) {
        return jsonResponse({
          ok: true,
          result: true,
        });
      }

      if (url.endsWith("/sendMessage")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 111,
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error(message) {
        loggerErrors.push(message);
      },
    },
  });
  service.sanitizeJobForDelivery = async (job) => job;

  service.jobContexts.set("job-retry", {
    chatId: 1001,
    statusMessageId: 55,
    lastStatusText: null,
    lastVisibleLogMessage: null,
    lastProgressUpdateAt: 0,
  });

  await service.handleJobCompleted({
    id: "job-retry",
    originalName: "paper.pdf",
    title: "paper",
    createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    result: {
      similarity: "70%",
      finishedAt: new Date().toISOString(),
      artifacts: {
        viewerPdf: "/storage/reports/job-retry/similarity-report.pdf",
      },
    },
  });

  assert.equal(sendDocumentAttempts, 2);
  assert.equal(
    fetchCalls.filter((entry) => entry.url.endsWith("/sendMessage")).length,
    0
  );
  assert.equal(
    fetchCalls.filter((entry) => entry.url.endsWith("/pinChatMessage")).length,
    1
  );
  assert.equal(
    loggerErrors.some((message) => message.includes("Telegram sendDocument gagal sementara")),
    true
  );

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService reports a friendly message when current view exceeds Telegram send limit", async () => {
  const { dir, config } = await createConfig();
  const reportDir = path.join(dir, "reports", "job-too-big");
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, "similarity-report.pdf"), "pdf-too-big");

  const fetchCalls = [];
  const service = new TelegramBotService({
    config: {
      ...config,
      telegram: {
        ...config.telegram,
        sendMaxFileBytes: 3,
      },
      storage: {
        ...config.storage,
        dir,
      },
    },
    jobRunner: Object.assign(new EventEmitter(), {
      jobStore: {
        get() {
          return null;
        },
      },
    }),
    fetchImpl: async (url, options = {}) => {
      const payload = options.body ? JSON.parse(options.body) : null;
      fetchCalls.push({
        url,
        payload,
      });

      if (url.endsWith("/editMessageText")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 55,
          },
        });
      }

      if (url.endsWith("/sendMessage")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 201,
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });
  service.sanitizeJobForDelivery = async (job) => job;

  service.jobContexts.set("job-too-big", {
    chatId: 1001,
    statusMessageId: 55,
    lastStatusText: null,
    lastVisibleLogMessage: null,
    lastProgressUpdateAt: 0,
  });

  await service.handleJobCompleted({
    id: "job-too-big",
    originalName: "hasil.pdf",
    title: "hasil",
    createdAt: new Date(Date.now() - 60 * 1000).toISOString(),
    result: {
      similarity: "44%",
      finishedAt: new Date().toISOString(),
      artifacts: {
        viewerPdf: "/storage/reports/job-too-big/similarity-report.pdf",
      },
    },
  });

  assert.equal(
    fetchCalls.filter((entry) => entry.url.endsWith("/sendDocument")).length,
    0
  );
  const warningMessage = fetchCalls.find((entry) => entry.url.endsWith("/sendMessage"));
  assert.ok(warningMessage);
  assert.match(
    warningMessage.payload?.text || "",
    /terlalu besar untuk dikirim balik lewat Telegram/
  );
  assert.match(warningMessage.payload?.text || "", /panel web\/server/);

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService does not create a new status message when Telegram edit fails with a non-replacement error", async () => {
  const { dir, config } = await createConfig();
  const fetchCalls = [];

  const service = new TelegramBotService({
    config,
    jobRunner: {
      jobStore: {
        get() {
          return null;
        },
      },
      on() {},
      off() {},
    },
    fetchImpl: async (url, options = {}) => {
      fetchCalls.push({
        url,
        payload: options.body ? JSON.parse(options.body) : null,
      });

      if (url.endsWith("/editMessageText")) {
        return jsonResponse(
          {
            ok: false,
            description: "Bad Request: message can't be edited",
          },
          400
        );
      }

      if (url.endsWith("/sendMessage")) {
        return jsonResponse({
          ok: true,
          result: {
            message_id: 999,
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    },
    logger: {
      log() {},
      error() {},
    },
  });

  service.jobContexts.set("job-edit-error", {
    chatId: 1001,
    statusMessageId: 55,
    lastStatusText: null,
    lastReplyMarkupKey: "",
    lastVisibleLogMessage: null,
    lastProgressUpdateAt: 0,
  });

  await service.handleJobStarted({
    id: "job-edit-error",
    status: "running",
    originalName: "paper.pdf",
    createdAt: new Date().toISOString(),
    logs: [],
  });

  assert.equal(
    fetchCalls.filter((entry) => entry.url.endsWith("/editMessageText")).length,
    1
  );
  assert.equal(
    fetchCalls.filter((entry) => entry.url.endsWith("/sendMessage")).length,
    0
  );
  assert.equal(service.jobContexts.get("job-edit-error")?.statusMessageId, 55);

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService uses ETA and generic public status text", async () => {
  const { dir, config } = await createConfig();

  const service = new TelegramBotService({
    config,
    jobRunner: {
      jobStore: {
        list() {
          return [];
        },
        get() {
          return null;
        },
      },
      on() {},
      off() {},
    },
    fetchImpl: async () => {
      throw new Error("No Telegram API call expected.");
    },
    logger: {
      log() {},
      error() {},
    },
  });

  const runningJob = {
    id: "job-eta-1",
    status: "running",
    originalName: "paper.pdf",
    reportOptions: {
      excludeQuotes: true,
      excludeBibliography: true,
      excludeMatches: false,
      excludeMatchesWordCount: 10,
    },
    createdAt: new Date(Date.now() - 60 * 1000).toISOString(),
    logs: [
      {
        timestamp: new Date().toISOString(),
        message: "Cek kelas (New) 서강대학교 (Sogang University)",
      },
    ],
  };
  const queuedJob = {
    id: "job-eta-2",
    status: "queued",
    originalName: "paper.pdf",
    reportOptions: {
      excludeQuotes: false,
      excludeBibliography: false,
      excludeMatches: false,
      excludeMatchesWordCount: 10,
    },
    queuePosition: 2,
    createdAt: new Date().toISOString(),
  };
  const completedJob = {
    id: "job-eta-3",
    status: "completed",
    originalName: "paper.pdf",
    createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    result: {
      similarity: "12%",
      reportOptions: {
        excludeQuotes: true,
        excludeBibliography: true,
        excludeMatches: true,
        excludeMatchesWordCount: 10,
      },
      finishedAt: new Date().toISOString(),
    },
  };

  const queuedText = service.buildQueuedText(queuedJob);
  const runningText = service.buildRunningText(runningJob);
  const completedText = service.buildCompletedText(completedJob);
  const failedText = service.buildFailedText({
    id: "job-eta-4",
    status: "failed",
    originalName: "paper.pdf",
    error: {
      message: "Login ke turnitin@example.com gagal.",
    },
  });

  assert.match(queuedText, /^Plagiasimu Bot$/m);
  assert.match(queuedText, /Filter Tanpa Filter/);
  assert.match(queuedText, /Estimasi /);
  assert.match(queuedText, /Menunggu giliran proses\./);
  assert.match(runningText, /^Plagiasimu Bot$/m);
  assert.match(runningText, /Filter Standar/);
  assert.match(runningText, /Estimasi /);
  assert.match(runningText, /Sistem sedang memproses dokumen\./);
  assert.doesNotMatch(runningText, /Cek kelas/);
  assert.doesNotMatch(runningText, /Validasi tujuan/);
  assert.match(completedText, /^Plagiasimu Bot$/m);
  assert.match(completedText, /Similarity 12%/);
  assert.match(
    completedText,
    /Filter Lengkap • Exclude quotes \+ exclude bibliography \+ exclude matches < 10 kata/
  );
  assert.match(completedText, /Durasi /);
  assert.match(failedText, /^Plagiasimu Bot$/m);
  assert.match(failedText, /Filter Tanpa Filter/);
  assert.match(failedText, /Proses belum berhasil\. Coba ulang beberapa saat lagi\./);

  await fs.rm(dir, { recursive: true, force: true });
});

test("TelegramBotService buildCompletedText shows dashboard similarity fallback for filtered jobs", async () => {
  const { dir, config } = await createConfig();
  const service = new TelegramBotService({
    config,
    jobRunner: {
      jobStore: {
        get() {
          return null;
        },
      },
      on() {},
      off() {},
    },
    fetchImpl: async () => {
      throw new Error("No Telegram API call expected.");
    },
    logger: {
      log() {},
      error() {},
    },
  });

  const completedText = service.buildCompletedText({
    id: "job-filtered-dashboard",
    status: "completed",
    originalName: "paper.pdf",
    createdAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
    result: {
      similarity: null,
      dashboardSimilarity: "80%",
      reportOptions: {
        excludeQuotes: true,
        excludeBibliography: true,
        excludeMatches: false,
        excludeMatchesWordCount: 10,
      },
      finishedAt: new Date().toISOString(),
    },
  });

  assert.match(completedText, /Similarity 80% \(dashboard\)/);
  assert.match(completedText, /Filter Standar • Exclude quotes \+ exclude bibliography/);

  await fs.rm(dir, { recursive: true, force: true });
});
