const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { JobRunner, JobStore } = require("../src/services/job-runner");

async function waitFor(condition, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for condition.");
}

test("JobRunner runs multiple jobs up to maxConcurrency", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-job-runner-"));
  const started = [];
  let activeCount = 0;
  let maxActiveCount = 0;

  const turnitinService = {
    async submitUsingPool({ jobId, onLog }) {
      started.push(jobId);
      activeCount += 1;
      maxActiveCount = Math.max(maxActiveCount, activeCount);
      onLog(`start ${jobId}`);
      await new Promise((resolve) => setTimeout(resolve, 120));
      activeCount -= 1;
      return {
        status: "submitted",
        jobId,
      };
    },
  };

  const jobStore = new JobStore();
  const runner = new JobRunner({
    jobStore,
    turnitinService,
    maxConcurrency: 2,
  });

  for (const name of ["one.pdf", "two.pdf", "three.pdf"]) {
    const filePath = path.join(dir, name);
    await fs.writeFile(filePath, name);
    runner.enqueue({
      filePath,
      originalName: name,
      title: name,
      reportOptions: {},
    });
  }

  await waitFor(() => !runner.isBusy(), 5000);

  const jobs = jobStore.list(3);
  assert.equal(maxActiveCount, 2);
  assert.equal(started.length, 3);
  assert.deepEqual(
    jobs.map((job) => job.status).sort(),
    ["completed", "completed", "completed"]
  );

  await fs.rm(dir, { recursive: true, force: true });
});

test("JobRunner uses dynamic max concurrency provider when available", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-job-runner-dynamic-"));
  let activeCount = 0;
  let maxActiveCount = 0;

  const turnitinService = {
    async submitUsingPool({ jobId }) {
      activeCount += 1;
      maxActiveCount = Math.max(maxActiveCount, activeCount);
      await new Promise((resolve) => setTimeout(resolve, 100));
      activeCount -= 1;
      return {
        status: "submitted",
        jobId,
      };
    },
  };

  const jobStore = new JobStore();
  const runner = new JobRunner({
    jobStore,
    turnitinService,
    maxConcurrency: 1,
    getMaxConcurrency: async () => 3,
  });

  for (const name of ["one.pdf", "two.pdf", "three.pdf"]) {
    const filePath = path.join(dir, name);
    await fs.writeFile(filePath, name);
    runner.enqueue({
      filePath,
      originalName: name,
      title: name,
      reportOptions: {},
    });
  }

  await waitFor(() => !runner.isBusy(), 5000);
  assert.equal(maxActiveCount, 3);

  await fs.rm(dir, { recursive: true, force: true });
});

test("JobRunner emits lifecycle events for queue, logs, and completion", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-job-runner-events-"));
  const filePath = path.join(dir, "paper.pdf");
  await fs.writeFile(filePath, "paper");

  const turnitinService = {
    async submitUsingPool({ jobId, onLog }) {
      onLog(`login ${jobId}`);
      onLog(`upload ${jobId}`);
      return {
        status: "submitted",
        jobId,
        similarity: "12%",
      };
    },
  };

  const runner = new JobRunner({
    jobStore: new JobStore(),
    turnitinService,
  });

  const events = [];
  runner.on("job:queued", (job) => events.push(["queued", job.id]));
  runner.on("job:started", (job) => events.push(["started", job.id]));
  runner.on("job:log", (entry) => events.push(["log", entry.log.message]));
  runner.on("job:completed", (job) => events.push(["completed", job.result.similarity]));

  const job = runner.enqueue({
    filePath,
    originalName: "paper.pdf",
    title: "paper",
    reportOptions: null,
  });

  await waitFor(() => !runner.isBusy(), 3000);

  assert.deepEqual(events, [
    ["queued", job.id],
    ["started", job.id],
    ["log", `login ${job.id}`],
    ["log", `upload ${job.id}`],
    ["completed", "12%"],
  ]);

  await fs.rm(dir, { recursive: true, force: true });
});

test("JobRunner stores partial similarity progress while the job is still running", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-job-runner-progress-"));
  const filePath = path.join(dir, "paper.pdf");
  await fs.writeFile(filePath, "paper");

  const turnitinService = {
    async submitUsingPool({ jobId, onProgress }) {
      onProgress({
        status: "submitted",
        jobId,
        similarity: "51%",
        artifacts: {
          digitalReceipt: "/storage/reports/job/digital-receipt.pdf",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 120));
      return {
        status: "submitted",
        jobId,
        similarity: "51%",
        artifacts: {
          digitalReceipt: "/storage/reports/job/digital-receipt.pdf",
        },
      };
    },
  };

  const jobStore = new JobStore();
  const runner = new JobRunner({
    jobStore,
    turnitinService,
  });
  const progressEvents = [];
  runner.on("job:progress", (job) => progressEvents.push(job.result.similarity));

  const job = runner.enqueue({
    filePath,
    originalName: "paper.pdf",
    title: "paper",
    reportOptions: null,
  });

  await waitFor(() => jobStore.get(job.id)?.result?.similarity === "51%", 3000);
  assert.equal(jobStore.get(job.id)?.status, "running");
  assert.deepEqual(progressEvents, ["51%"]);

  await waitFor(() => jobStore.get(job.id)?.status === "completed", 3000);

  await fs.rm(dir, { recursive: true, force: true });
});

test("JobRunner retries queued jobs after a transient pump error", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-job-runner-retry-"));
  const filePath = path.join(dir, "paper.pdf");
  await fs.writeFile(filePath, "paper");

  let concurrencyChecks = 0;
  const turnitinService = {
    async submitUsingPool({ jobId }) {
      return {
        status: "submitted",
        jobId,
      };
    },
  };

  const jobStore = new JobStore();
  const runner = new JobRunner({
    jobStore,
    turnitinService,
    retryPumpDelayMs: 25,
    getMaxConcurrency: async () => {
      concurrencyChecks += 1;
      if (concurrencyChecks === 1) {
        throw new Error("temporary concurrency lookup failure");
      }
      return 1;
    },
  });

  const job = runner.enqueue({
    filePath,
    originalName: "paper.pdf",
    title: "paper",
    reportOptions: null,
  });

  await waitFor(() => jobStore.get(job.id)?.status === "completed", 3000);
  assert.ok(concurrencyChecks >= 2);
  assert.equal(runner.lastPumpError, null);

  await fs.rm(dir, { recursive: true, force: true });
});

test("JobRunner re-kicks pump when a queued job remains idle after enqueue", async () => {
  const runner = new JobRunner({
    jobStore: new JobStore(),
    turnitinService: {
      async submitUsingPool() {
        throw new Error("submitUsingPool should not run in this watchdog test");
      },
    },
    enqueueWatchdogDelayMs: 25,
  });

  let pumpCalls = 0;
  runner.requestPump = async () => {
    pumpCalls += 1;
  };

  runner.enqueue({
    filePath: "/tmp/paper.pdf",
    originalName: "paper.pdf",
    title: "paper",
    reportOptions: null,
  });

  await waitFor(() => pumpCalls >= 2, 1000);
  assert.ok(pumpCalls >= 2);
});

test("JobRunner recovers a stale in-flight pump and starts the queued job", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-job-runner-stale-pump-"));
  const filePath = path.join(dir, "paper.pdf");
  await fs.writeFile(filePath, "paper");

  const turnitinService = {
    async submitUsingPool({ jobId }) {
      return {
        status: "submitted",
        jobId,
      };
    },
  };

  const jobStore = new JobStore();
  const runner = new JobRunner({
    jobStore,
    turnitinService,
    enqueueWatchdogDelayMs: 25,
    stalledPumpThresholdMs: 25,
  });

  runner.pumpInFlight = new Promise(() => {});
  runner.pumpStartedAt = new Date(Date.now() - 250).toISOString();

  const job = runner.enqueue({
    filePath,
    originalName: "paper.pdf",
    title: "paper",
    reportOptions: null,
  });

  await waitFor(() => jobStore.get(job.id)?.status === "completed", 3000);
  assert.equal(runner.stalledPumpRecoveries, 1);

  await fs.rm(dir, { recursive: true, force: true });
});

test("JobRunner cancels a queued job before it starts", async () => {
  const runner = new JobRunner({
    jobStore: new JobStore(),
    turnitinService: {
      async submitUsingPool() {
        throw new Error("queued job should not start after cancel");
      },
    },
  });

  runner.requestPump = async () => {};
  const job = runner.enqueue({
    filePath: "/tmp/paper.pdf",
    originalName: "paper.pdf",
    title: "paper",
    reportOptions: null,
  });

  const cancelled = runner.cancel(job.id, {
    reason: "Dibatalkan dari test.",
  });

  assert.equal(cancelled?.status, "cancelled");
  assert.equal(runner.queuedCount, 0);
  assert.equal(runner.jobStore.get(job.id)?.status, "cancelled");
});

test("JobRunner cancels a running job and keeps it from completing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-job-runner-cancel-"));
  const filePath = path.join(dir, "paper.pdf");
  await fs.writeFile(filePath, "paper");

  let started = false;
  const turnitinService = {
    async submitUsingPool({ signal }) {
      started = true;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 500);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true }
        );
      });
      return {
        status: "submitted",
      };
    },
  };

  const jobStore = new JobStore();
  const runner = new JobRunner({
    jobStore,
    turnitinService,
  });

  const cancelledEvents = [];
  runner.on("job:cancelled", (job) => cancelledEvents.push(job.id));

  const job = runner.enqueue({
    filePath,
    originalName: "paper.pdf",
    title: "paper",
    reportOptions: null,
  });

  await waitFor(() => started && jobStore.get(job.id)?.status === "running", 3000);
  const cancelled = runner.cancel(job.id, {
    reason: "Dibatalkan dari test.",
  });

  assert.equal(cancelled?.status, "cancelled");
  await waitFor(() => !runner.isBusy(), 3000);
  assert.deepEqual(cancelledEvents, [job.id]);
  assert.equal(jobStore.get(job.id)?.status, "cancelled");

  await fs.rm(dir, { recursive: true, force: true });
});
