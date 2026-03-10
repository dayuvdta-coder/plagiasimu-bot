const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");
const config = require("../src/config");
const { StateStore } = require("../src/services/state-store");
const { JobRunner, JobStore } = require("../src/services/job-runner");
const { TurnitinService } = require("../src/services/turnitin-service");
const { TelegramBotService } = require("../src/services/telegram-bot");

async function ensureDirs() {
  await fs.mkdir(config.storage.uploadsDir, { recursive: true });
  await fs.mkdir(config.storage.reportsDir, { recursive: true });
  await fs.mkdir(config.storage.runtimeDir, { recursive: true });
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    chatId: Number(process.env.TELEGRAM_BURST_CHAT_ID || process.env.TELEGRAM_ALLOWED_CHAT_IDS || 0),
    samplePath: process.env.TELEGRAM_BURST_SAMPLE || path.join(config.storage.runtimeDir, "api-seq-sample.pdf"),
    repeat: Math.max(1, Number(process.env.TELEGRAM_BURST_REPEAT || 3) || 3),
    timeoutMs: Math.max(60 * 1000, Number(process.env.TELEGRAM_BURST_TIMEOUT_MS || 45 * 60 * 1000) || 45 * 60 * 1000),
    titlePrefix: process.env.TELEGRAM_BURST_TITLE_PREFIX || "Bot Burst QA",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--chat-id") {
      options.chatId = Number(argv[index + 1] || 0);
      index += 1;
      continue;
    }
    if (arg === "--sample") {
      options.samplePath = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--repeat") {
      options.repeat = Math.max(1, Number(argv[index + 1] || 1) || 1);
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      options.timeoutMs = Math.max(60 * 1000, Number(argv[index + 1] || options.timeoutMs) || options.timeoutMs);
      index += 1;
      continue;
    }
    if (arg === "--title-prefix") {
      options.titlePrefix = String(argv[index + 1] || options.titlePrefix).trim() || options.titlePrefix;
      index += 1;
    }
  }

  if (!Number.isFinite(options.chatId) || options.chatId <= 0) {
    throw new Error("Chat ID Telegram burst test tidak valid.");
  }

  return options;
}

function buildCaption(index, titlePrefix) {
  const presets = ["off", "standar", "lengkap"];
  const filter = presets[index % presets.length];
  return {
    fileName: `${titlePrefix.replace(/[^a-z0-9]+/gi, "-")}-${index + 1}.pdf`,
    caption: `${titlePrefix} ${index + 1}\nfilter: ${filter}`,
  };
}

async function main() {
  const options = parseArgs();
  await ensureDirs();
  await fs.access(options.samplePath);
  const sampleStat = await fs.stat(options.samplePath);

  const stateStore = new StateStore(config.storage.stateFile);
  await stateStore.init();
  const turnitinService = new TurnitinService({
    config,
    stateStore,
  });
  const jobStore = new JobStore();
  const jobRunner = new JobRunner({
    jobStore,
    turnitinService,
    maxConcurrency: config.maxConcurrentJobs || 1,
    getMaxConcurrency: () => turnitinService.getMaxConcurrency(),
  });
  const bot = new TelegramBotService({
    config,
    jobRunner,
    logger: console,
  });
  bot.attachJobRunnerListeners();

  bot.downloadTelegramDocument = async (document) => {
    const targetPath = path.join(config.storage.uploadsDir, `${randomUUID()}.pdf`);
    await fs.copyFile(options.samplePath, targetPath);
    return {
      filePath: targetPath,
      originalName: document.file_name || "telegram-burst.pdf",
      fileSize: sampleStat.size,
      mimeType: "application/pdf",
    };
  };

  for (let index = 0; index < options.repeat; index += 1) {
    const submission = buildCaption(index, options.titlePrefix);
    await bot.handleDocumentMessage({
      chat: { id: options.chatId },
      from: { id: options.chatId },
      document: {
        file_id: randomUUID(),
        file_name: submission.fileName,
        file_size: sampleStat.size,
      },
      caption: submission.caption,
    });
  }

  const jobIds = (bot.chatJobHistory.get(String(options.chatId)) || []).slice(0, options.repeat).reverse();
  console.log(
    JSON.stringify(
      {
        phase: "enqueued",
        jobIds,
      },
      null,
      2
    )
  );

  const startedAt = Date.now();
  let lastSnapshotAt = 0;
  while (true) {
    const jobs = jobIds.map((jobId) => jobStore.get(jobId)).filter(Boolean);
    const liveJobs = jobs.filter((job) => ["queued", "running"].includes(job.status));
    const now = Date.now();

    if (now - lastSnapshotAt >= 15000) {
      lastSnapshotAt = now;
      console.log(
        JSON.stringify(
          {
            phase: "poll",
            running: jobRunner.runningCount,
            queued: jobRunner.queuedCount,
            jobs: jobs.map((job) => ({
              id: job.id,
              status: job.status,
              similarity: job.result?.similarity || null,
              lastLog: job.logs?.[job.logs.length - 1]?.message || null,
            })),
          },
          null,
          2
        )
      );
    }

    if (!liveJobs.length) {
      console.log(
        JSON.stringify(
          {
            phase: "final",
            jobs: jobs.map((job) => ({
              id: job.id,
              status: job.status,
              similarity: job.result?.similarity || null,
              error: job.error || null,
              artifacts: job.result?.artifacts || null,
            })),
          },
          null,
          2
        )
      );
      break;
    }

    if (now - startedAt > options.timeoutMs) {
      throw new Error("Telegram burst live test timed out.");
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
