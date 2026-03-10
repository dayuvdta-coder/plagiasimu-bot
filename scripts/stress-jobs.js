#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");
const { Blob } = require("buffer");
const {
  buildStressTestSubmissions,
  parseStressTestArgs,
} = require("../src/services/stress-test");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDuration(ms) {
  const safeMs = Math.max(0, Number(ms) || 0);
  const totalSeconds = Math.round(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function formatTime(value = Date.now()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Pontianak",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function usage() {
  return [
    "Usage:",
    "  npm run stress -- [options] <file1.pdf> [file2.pdf ...]",
    "",
    "Options:",
    "  --endpoint <url>              API base URL. Default: http://127.0.0.1:3101",
    "  --title-prefix <text>         Prefix judul submission stress test.",
    "  --username <text>             Username panel. Default: PANEL_AUTH_USERNAME/Andri14",
    "  --password <text>             Password panel. Default: PANEL_AUTH_PASSWORD/Andri14",
    "  --repeat <n>                  Ulangi daftar file n kali.",
    "  --poll-ms <ms>                Interval polling status job. Default: 5000",
    "  --timeout-ms <ms>             Batas tunggu semua job selesai. Default: 2700000",
    "  --stagger-ms <ms>             Jeda antar submit request. Default: 0",
    "  --serial                      Tunggu 1 job selesai dulu sebelum submit berikutnya.",
    "  --exclude-quotes              Aktifkan exclude quotes.",
    "  --exclude-bibliography        Aktifkan exclude bibliography.",
    "  --exclude-matches             Aktifkan exclude matches.",
    "  --word-count <n>              Threshold exclude matches. Default: 10",
    "  --help                        Tampilkan bantuan ini.",
    "",
    "Examples:",
    "  npm run stress -- ./samples/a.pdf ./samples/b.pdf",
    "  npm run stress -- --repeat 7 --title-prefix 'Queue Burn-In' ./samples/a.pdf",
  ].join("\n");
}

function createApiClient(baseUrl) {
  let cookieHeader = "";

  return {
    async fetchJson(pathname, init = {}) {
      const headers = new Headers(init.headers || {});
      if (cookieHeader) {
        headers.set("cookie", cookieHeader);
      }

      const response = await fetch(`${baseUrl}${pathname}`, {
        ...init,
        headers,
      });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) {
        cookieHeader = setCookie.split(";")[0];
      }

      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch (error) {
        payload = text;
      }

      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}: ${text}`.trim());
      }

      return payload;
    },
  };
}

async function ensureAuthenticated({ apiClient, username, password }) {
  const session = await apiClient.fetchJson(`/api/auth/session`).catch(() => null);
  if (session?.authenticated) {
    return;
  }

  await apiClient.fetchJson(`/api/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      username,
      password,
    }),
  });
}

async function submitJob({ apiClient, submission, reportOptions }) {
  const fileBuffer = await fs.readFile(submission.filePath);
  const form = new FormData();
  form.append(
    "document",
    new Blob([fileBuffer], { type: "application/pdf" }),
    path.basename(submission.filePath)
  );
  form.append("title", submission.title);
  if (reportOptions.excludeQuotes) {
    form.append("excludeQuotes", "on");
  }
  if (reportOptions.excludeBibliography) {
    form.append("excludeBibliography", "on");
  }
  if (reportOptions.excludeMatches) {
    form.append("excludeMatches", "on");
  }
  form.append("excludeMatchesWordCount", String(reportOptions.excludeMatchesWordCount || 10));

  const job = await apiClient.fetchJson(`/api/jobs`, {
    method: "POST",
    body: form,
  });

  return {
    ...job,
    sourceFile: submission.filePath,
  };
}

async function waitForPendingJobs({
  apiClient,
  pending,
  finished,
  options,
  startedAt,
}) {
  while (pending.size) {
    if (Date.now() - startedAt > options.timeoutMs) {
      throw new Error(
        `Stress test timeout setelah ${formatDuration(options.timeoutMs)}. Job belum selesai: ${[
          ...pending,
        ].join(", ")}`
      );
    }

    const health = await apiClient.fetchJson(`/api/health`).catch((error) => ({
      error: error.message,
    }));
    if (!health.error) {
      console.log(
        `[health] running=${health.runningJobCount} queued=${health.queuedJobCount} recoveries=${health.stalledPumpRecoveries}`
      );
    } else {
      console.log(`[health] error=${health.error}`);
    }

    const results = await Promise.all(
      [...pending].map((jobId) =>
        apiClient.fetchJson(`/api/jobs/${jobId}`)
          .then((job) => ({ ok: true, job }))
          .catch((error) => ({ ok: false, error }))
      )
    );

    for (const result of results) {
      if (!result.ok) {
        console.log(`[job] error=${result.error.message}`);
        continue;
      }

      const { job } = result;
      if (!["completed", "failed", "cancelled"].includes(job.status)) {
        continue;
      }

      pending.delete(job.id);
      finished.push({
        id: job.id,
        title: job.title,
        status: job.status,
        similarity: job.result?.similarity || null,
        accountEmail: job.result?.accountEmail || null,
        finishedAt: job.result?.finishedAt || job.updatedAt,
        error: job.error?.message || null,
      });
      console.log(
        `[done] ${job.id} status=${job.status} similarity=${job.result?.similarity || "-"}`
      );
    }

    if (pending.size) {
      await sleep(options.pollMs);
    }
  }
}

async function main() {
  const options = parseStressTestArgs(process.argv.slice(2));
  if (options.help || !options.files.length) {
    console.log(usage());
    process.exit(options.help ? 0 : 1);
  }

  const submissions = buildStressTestSubmissions({
    files: options.files,
    repeat: options.repeat,
    titlePrefix: options.titlePrefix,
  });

  for (const submission of submissions) {
    await fs.access(submission.filePath);
  }

  console.log(
    `Mulai stress test ${submissions.length} job ke ${options.endpoint} pada ${formatTime()} (${options.serial ? "serial" : "parallel"}).`
  );
  const apiClient = createApiClient(options.endpoint);

  await ensureAuthenticated({
    apiClient,
    username: options.username,
    password: options.password,
  });

  const submittedJobs = [];
  const pending = new Set();
  const finished = [];
  const startedAt = Date.now();
  for (const [index, submission] of submissions.entries()) {
    const job = await submitJob({
      apiClient,
      submission,
      reportOptions: options.reportOptions,
    });
    submittedJobs.push({
      id: job.id,
      title: job.title,
      originalName: job.originalName,
      sourceFile: submission.filePath,
      submittedAt: Date.now(),
      status: job.status,
    });
    pending.add(job.id);
    console.log(
      `[submit ${index + 1}/${submissions.length}] ${job.id} ${job.title} <- ${submission.filePath}`
    );
    if (options.serial) {
      await waitForPendingJobs({
        apiClient,
        pending,
        finished,
        options,
        startedAt,
      });
    }
    if (options.staggerMs > 0 && index < submissions.length - 1) {
      await sleep(options.staggerMs);
    }
  }
  await waitForPendingJobs({
    apiClient,
    pending,
    finished,
    options,
    startedAt,
  });

  const reportDir = path.join(process.cwd(), "storage", "runtime");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `stress-test-${Date.now()}.json`);
  const report = {
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    endpoint: options.endpoint,
    submissions,
    finished,
  };
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

  const failedCount = finished.filter((job) => job.status !== "completed").length;
  console.log(
    `Selesai. total=${finished.length} failed=${failedCount} report=${reportPath}`
  );
  process.exit(failedCount ? 1 : 0);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
