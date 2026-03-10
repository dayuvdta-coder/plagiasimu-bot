const fs = require("fs/promises");
const { randomUUID } = require("crypto");
const { EventEmitter } = require("events");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createAbortError(message = "Job dibatalkan.") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

class JobStore {
  constructor() {
    this.jobs = new Map();
  }

  create(payload) {
    const now = new Date().toISOString();
    const job = {
      id: randomUUID(),
      status: "queued",
      createdAt: now,
      updatedAt: now,
      originalName: payload.originalName,
      title: payload.title,
      reportOptions: payload.reportOptions || null,
      queuePosition: 0,
      logs: [],
      result: null,
      error: null,
    };

    this.jobs.set(job.id, job);
    return clone(job);
  }

  setQueuePositions(queueItems) {
    for (const [index, item] of queueItems.entries()) {
      const job = this.jobs.get(item.jobId);
      if (!job) {
        continue;
      }

      job.queuePosition = index + 1;
      job.updatedAt = new Date().toISOString();
    }
  }

  update(jobId, updater) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return null;
    }

    updater(job);
    job.updatedAt = new Date().toISOString();
    return clone(job);
  }

  appendLog(jobId, message) {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, message };
    const job = this.update(jobId, (job) => {
      job.logs.push({ timestamp, message });
      job.logs = job.logs.slice(-100);
    });
    return job ? { job, logEntry } : null;
  }

  get(jobId) {
    const job = this.jobs.get(jobId);
    return job ? clone(job) : null;
  }

  updateResult(jobId, partialResult) {
    if (!partialResult || typeof partialResult !== "object") {
      return this.get(jobId);
    }

    return this.update(jobId, (job) => {
      const previousResult = job.result || {};
      job.result = {
        ...previousResult,
        ...clone(partialResult),
        artifacts: {
          ...(previousResult.artifacts || {}),
          ...clone(partialResult.artifacts || {}),
        },
      };
    });
  }

  list(limit = 20) {
    return [...this.jobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((job) => clone(job));
  }
}

class JobRunner extends EventEmitter {
  constructor({
    jobStore,
    turnitinService,
    maxConcurrency = 1,
    getMaxConcurrency = null,
    retryPumpDelayMs = 1000,
    enqueueWatchdogDelayMs = 250,
    stalledPumpThresholdMs = 5000,
  }) {
    super();
    this.jobStore = jobStore;
    this.turnitinService = turnitinService;
    this.queue = [];
    this.maxConcurrency = Math.max(1, Number(maxConcurrency) || 1);
    this.getMaxConcurrency = getMaxConcurrency;
    this.retryPumpDelayMs = Math.max(25, Number(retryPumpDelayMs) || 1000);
    this.enqueueWatchdogDelayMs = Math.max(25, Number(enqueueWatchdogDelayMs) || 250);
    this.stalledPumpThresholdMs = Math.max(
      this.enqueueWatchdogDelayMs,
      Number(stalledPumpThresholdMs) || 5000
    );
    this.runningJobIds = new Set();
    this.pumpInFlight = null;
    this.lastPumpError = null;
    this.pumpRetryTimer = null;
    this.enqueueWatchdogTimer = null;
    this.pumpStartedAt = null;
    this.pumpSettledAt = null;
    this.stalledPumpRecoveries = 0;
    this.jobAbortControllers = new Map();
    this.cancelledJobIds = new Set();
  }

  get runningJobId() {
    return this.listRunningJobIds()[0] || null;
  }

  get runningCount() {
    return this.runningJobIds.size;
  }

  get queuedCount() {
    return this.queue.length;
  }

  listRunningJobIds() {
    return [...this.runningJobIds];
  }

  enqueue(payload, { autoStart = true } = {}) {
    const job = this.jobStore.create(payload);
    this.queue.push({ jobId: job.id, payload });
    this.jobStore.setQueuePositions(this.queue);
    const queuedJob = this.jobStore.get(job.id);
    this.emitSafe("job:queued", queuedJob);
    if (autoStart) {
      this.scheduleEnqueueWatchdog();
      void this.requestPump();
    }
    return queuedJob;
  }

  cancel(jobId, { reason = "Dibatalkan oleh pengguna." } = {}) {
    const currentJob = this.jobStore.get(jobId);
    if (!currentJob) {
      return null;
    }

    if (["completed", "failed", "cancelled"].includes(currentJob.status)) {
      return currentJob;
    }

    const queuedIndex = this.queue.findIndex((item) => item.jobId === jobId);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.jobStore.setQueuePositions(this.queue);
      const cancelledJob = this.jobStore.update(jobId, (job) => {
        job.status = "cancelled";
        job.queuePosition = 0;
        job.error = {
          message: reason,
        };
      });
      this.jobStore.appendLog(jobId, reason);
      this.emitSafe("job:cancelled", this.jobStore.get(jobId) || cancelledJob);
      void this.requestPump();
      return this.jobStore.get(jobId) || cancelledJob;
    }

    if (this.runningJobIds.has(jobId)) {
      this.cancelledJobIds.add(jobId);
      const cancelledJob = this.jobStore.update(jobId, (job) => {
        job.status = "cancelled";
        job.error = {
          message: reason,
        };
      });
      this.jobStore.appendLog(jobId, reason);
      this.jobAbortControllers.get(jobId)?.abort(createAbortError(reason));
      this.emitSafe("job:cancelled", this.jobStore.get(jobId) || cancelledJob);
      return this.jobStore.get(jobId) || cancelledJob;
    }

    return currentJob;
  }

  isBusy() {
    return Boolean(this.runningJobIds.size || this.queue.length);
  }

  async resolveMaxConcurrency() {
    const resolved = this.getMaxConcurrency
      ? await this.getMaxConcurrency()
      : this.maxConcurrency;
    return Math.max(1, Number(resolved) || 1);
  }

  schedulePumpRetry(delayMs = this.retryPumpDelayMs) {
    if (this.pumpRetryTimer) {
      return;
    }

    this.pumpRetryTimer = setTimeout(() => {
      this.pumpRetryTimer = null;
      void this.requestPump();
    }, Math.max(25, Number(delayMs) || this.retryPumpDelayMs));
    this.pumpRetryTimer.unref?.();
  }

  scheduleEnqueueWatchdog(delayMs = this.enqueueWatchdogDelayMs) {
    if (this.enqueueWatchdogTimer) {
      return;
    }

    this.enqueueWatchdogTimer = setTimeout(() => {
      this.enqueueWatchdogTimer = null;
      if (!this.queue.length) {
        return;
      }

      if (this.runningJobIds.size === 0) {
        this.recoverStalledPump();
        void this.requestPump();
      }

      if (this.queue.length) {
        this.scheduleEnqueueWatchdog();
      }
    }, Math.max(25, Number(delayMs) || this.enqueueWatchdogDelayMs));
    this.enqueueWatchdogTimer.unref?.();
  }

  isPumpStale(now = Date.now()) {
    if (!this.queue.length || this.runningJobIds.size > 0 || !this.pumpInFlight) {
      return false;
    }

    if (!this.pumpStartedAt) {
      return false;
    }

    const startedAt = Date.parse(this.pumpStartedAt);
    if (!Number.isFinite(startedAt)) {
      return false;
    }

    return now - startedAt >= this.stalledPumpThresholdMs;
  }

  recoverStalledPump(now = Date.now()) {
    if (!this.isPumpStale(now)) {
      return false;
    }

    this.pumpInFlight = null;
    this.pumpStartedAt = null;
    this.pumpSettledAt = new Date(now).toISOString();
    this.stalledPumpRecoveries += 1;
    this.lastPumpError = {
      message: "Recovered stalled job pump while queued jobs were idle.",
      timestamp: this.pumpSettledAt,
    };
    return true;
  }

  async requestPump() {
    try {
      await this.pump();
      if (!this.queue.length) {
        this.lastPumpError = null;
      }
    } catch (error) {
      this.lastPumpError = {
        message: error.message,
        timestamp: new Date().toISOString(),
      };
      console.error("JobRunner pump error:", error);
      if (this.queue.length) {
        this.schedulePumpRetry();
      }
    }
  }

  async pump() {
    this.recoverStalledPump();
    if (this.pumpInFlight) {
      return this.pumpInFlight;
    }

    this.pumpStartedAt = new Date().toISOString();
    this.pumpInFlight = (async () => {
      try {
        this.lastPumpError = null;
        while (this.queue.length) {
          const maxConcurrency = await this.resolveMaxConcurrency();
          if (this.runningJobIds.size >= maxConcurrency) {
            break;
          }

          const next = this.queue.shift();
          this.runningJobIds.add(next.jobId);
          this.jobStore.setQueuePositions(this.queue);

          this.jobStore.update(next.jobId, (job) => {
            job.status = "running";
            job.queuePosition = 0;
          });
          this.emitSafe("job:started", this.jobStore.get(next.jobId));

          void this.runJob(next);
        }
      } finally {
        this.pumpInFlight = null;
        this.pumpSettledAt = new Date().toISOString();
        if (this.queue.length) {
          const maxConcurrency = await this.resolveMaxConcurrency().catch(() => 1);
          if (this.runningJobIds.size < maxConcurrency) {
            void this.requestPump();
          }
        }
      }
    })();

    return this.pumpInFlight;
  }

  emitSafe(eventName, payload) {
    for (const listener of this.listeners(eventName)) {
      try {
        listener(payload);
      } catch (error) {
        console.error(`JobRunner listener error on ${eventName}:`, error);
      }
    }
  }

  async runJob(next) {
    const abortController = new AbortController();
    this.jobAbortControllers.set(next.jobId, abortController);

    try {
      const result = await this.turnitinService.submitUsingPool({
        ...next.payload,
        jobId: next.jobId,
        signal: abortController.signal,
        onLog: (message) => {
          if (this.cancelledJobIds.has(next.jobId)) {
            return;
          }
          const entry = this.jobStore.appendLog(next.jobId, message);
          if (entry) {
            this.emitSafe("job:log", {
              job: entry.job,
              log: entry.logEntry,
            });
          }
        },
        onProgress: (partialResult) => {
          if (this.cancelledJobIds.has(next.jobId)) {
            return;
          }
          const job = this.jobStore.updateResult(next.jobId, partialResult);
          if (job) {
            this.emitSafe("job:progress", job);
          }
        },
      });

      if (this.cancelledJobIds.has(next.jobId)) {
        return;
      }

      const completedJob = this.jobStore.update(next.jobId, (job) => {
        job.status = "completed";
        job.result = result;
      });
      this.emitSafe("job:completed", completedJob);
    } catch (error) {
      if (this.cancelledJobIds.has(next.jobId) || error?.name === "AbortError") {
        return;
      }

      const failedJob = this.jobStore.update(next.jobId, (job) => {
        job.status = "failed";
        job.error = {
          message: error.message,
        };
      });
      this.emitSafe("job:failed", failedJob);
    } finally {
      this.jobAbortControllers.delete(next.jobId);
      this.cancelledJobIds.delete(next.jobId);
      this.runningJobIds.delete(next.jobId);
      await fs.unlink(next.payload.filePath).catch(() => null);
      void this.requestPump();
    }
  }
}

module.exports = {
  JobRunner,
  JobStore,
};
