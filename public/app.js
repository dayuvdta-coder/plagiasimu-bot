const bootScreen = document.getElementById("bootScreen");
const authScreen = document.getElementById("authScreen");
const dashboardShell = document.getElementById("dashboardShell");
const loginForm = document.getElementById("loginForm");
const loginButton = document.getElementById("loginButton");
const loginError = document.getElementById("loginError");
const logoutButton = document.getElementById("logoutButton");
const sessionBadge = document.getElementById("sessionBadge");
const runtimeMeta = document.getElementById("runtimeMeta");
const runtimeAlert = document.getElementById("runtimeAlert");
const queueBoard = document.getElementById("queueBoard");
const focusSummary = document.getElementById("focusSummary");
const healthNote = document.getElementById("healthNote");
const accountsGrid = document.getElementById("accountsGrid");
const accountsMeta = document.getElementById("accountsMeta");
const refreshAccountsButton = document.getElementById("refreshAccounts");
const submitForm = document.getElementById("submitForm");
const submitButton = document.getElementById("submitButton");
const jobState = document.getElementById("jobState");
const jobCopyStatus = document.getElementById("jobCopyStatus");
const copyLogsButton = document.getElementById("copyLogsButton");
const copyErrorButton = document.getElementById("copyErrorButton");
const jobLogs = document.getElementById("jobLogs");
const jobResult = document.getElementById("jobResult");
const recentJobs = document.getElementById("recentJobs");

const INDONESIA_TIME_ZONE = "Asia/Jakarta";
const INDONESIA_TIME_LABEL = "WIB";

let sessionState = null;
let activeJobId = null;
let pollTimer = null;
let jobsRefreshTimer = null;
let accountsRefreshTimer = null;
let jobCopyFeedbackTimer = null;
let displayedJob = null;
let recentSubmissionHistory = [];
let currentJobs = [];
let currentAccounts = [];
let runtimeSnapshot = null;

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatTimestamp(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: INDONESIA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${INDONESIA_TIME_LABEL}`;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function getAccountUsageTotals(account = {}) {
  const usageTotals = account.usageTotals || {};
  return {
    totalAssignments: toNumber(usageTotals.totalAssignments, account.totals?.assignments || 0),
    emptyAssignments: toNumber(usageTotals.emptyAssignments, account.totals?.available || 0),
    blockedEmptyAssignments: toNumber(usageTotals.blockedEmptyAssignments, 0),
    reusableAssignments: toNumber(usageTotals.reusableAssignments, 0),
    exhaustedAssignments: toNumber(usageTotals.exhaustedAssignments, account.totals?.used || 0),
    repositoryExcludedAssignments: toNumber(usageTotals.repositoryExcludedAssignments, 0),
    unknownAssignments: toNumber(usageTotals.unknownAssignments, 0),
    submittableAssignments: toNumber(usageTotals.submittableAssignments, account.totals?.available || 0),
    resubmittableAssignments: toNumber(usageTotals.resubmittableAssignments, 0),
  };
}

function getAccountAvailabilityMeta(availability = "unknown") {
  switch (String(availability || "unknown").trim().toLowerCase()) {
    case "usable":
      return {
        label: "Masih siap",
        className: "usable",
      };
    case "exhausted":
      return {
        label: "Habis lokal",
        className: "exhausted",
      };
    default:
      return {
        label: "Belum pasti",
        className: "unknown",
      };
  }
}

function getAssignmentUsageMeta(assignment = {}) {
  const effectiveStatus = String(
    assignment.usage?.effectiveStatus || assignment.status || "unknown"
  ).trim();

  switch (effectiveStatus) {
    case "empty":
      return {
        label: "Belum dipakai",
        className: "empty",
      };
    case "used-reusable":
      return {
        label: "Bisa resubmit",
        className: "reusable",
      };
    case "used-exhausted":
      return {
        label: "Slot habis",
        className: "exhausted",
      };
    case "blocked-empty":
      return {
        label: "Kosong tapi terkunci",
        className: "blocked",
      };
    case "repository-excluded":
      return {
        label: "Repository skip",
        className: "excluded",
      };
    default:
      return {
        label: "Belum jelas",
        className: "unknown",
      };
  }
}

function buildAssignmentUsageNote(assignment = {}) {
  const usage = assignment.usage || {};
  const successCount = toNumber(usage.successCount, 0);
  const remainingSubmissions = toNumber(usage.remainingSubmissions, 0);
  const attemptCount = toNumber(usage.attemptCount, 0);
  const remainingAttempts = toNumber(usage.remainingAttempts, 0);
  const similarity = usage.dashboardSimilarity || assignment.similarity || null;
  const lastAttemptAt = usage.lastAttemptAt ? formatTimestamp(usage.lastAttemptAt) : null;
  const status = String(usage.effectiveStatus || assignment.status || "unknown").trim();
  const parts = [];

  if (status === "empty") {
    parts.push(`Belum ada submission lokal`);
    parts.push(`Sisa ${remainingSubmissions} slot`);
  } else if (status === "used-reusable") {
    parts.push(`Sudah dipakai ${successCount}x`);
    parts.push(`Sisa ${remainingSubmissions} slot`);
  } else if (status === "used-exhausted") {
    parts.push(`Sudah dipakai ${successCount}x`);
    parts.push(`Slot lokal habis`);
  } else if (status === "blocked-empty") {
    parts.push(`Belum dipakai`);
    parts.push(`Retry lokal habis`);
  } else if (status === "repository-excluded") {
    parts.push(`Mode Save to Repository dilewati`);
  } else {
    parts.push(`Status belum stabil dari scan terakhir`);
  }

  if (attemptCount > 0) {
    parts.push(`Attempt ${attemptCount}`);
  }

  if (remainingAttempts > 0 && (status === "used-reusable" || status === "empty")) {
    parts.push(`Retry sisa ${remainingAttempts}`);
  }

  if (similarity) {
    parts.push(`Similarity ${similarity}`);
  }

  if (lastAttemptAt && status !== "empty") {
    parts.push(`Terakhir ${lastAttemptAt}`);
  }

  return parts.join(" • ");
}

function sortAssignmentsForPanel(assignments = []) {
  const priority = {
    empty: 0,
    "used-reusable": 1,
    "blocked-empty": 2,
    unknown: 3,
    "used-exhausted": 4,
    "repository-excluded": 5,
  };

  return [...assignments].sort((left, right) => {
    const leftStatus = String(left.usage?.effectiveStatus || left.status || "unknown").trim();
    const rightStatus = String(right.usage?.effectiveStatus || right.status || "unknown").trim();
    const leftPriority = priority[leftStatus] ?? priority.unknown;
    const rightPriority = priority[rightStatus] ?? priority.unknown;

    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    return String(left.name || "").localeCompare(String(right.name || ""));
  });
}

function sortAccountsForPanel(accounts = []) {
  const availabilityRank = {
    usable: 0,
    unknown: 1,
    exhausted: 2,
  };

  return [...accounts].sort((left, right) => {
    const leftAvailability = String(left.availability || "unknown").trim().toLowerCase();
    const rightAvailability = String(right.availability || "unknown").trim().toLowerCase();
    const leftRank = availabilityRank[leftAvailability] ?? availabilityRank.unknown;
    const rightRank = availabilityRank[rightAvailability] ?? availabilityRank.unknown;

    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    const leftUsage = getAccountUsageTotals(left);
    const rightUsage = getAccountUsageTotals(right);
    if (leftUsage.submittableAssignments !== rightUsage.submittableAssignments) {
      return rightUsage.submittableAssignments - leftUsage.submittableAssignments;
    }

    return String(left.accountEmail || "").localeCompare(String(right.accountEmail || ""));
  });
}

function aggregateAccountUsage(accounts = []) {
  return accounts.reduce(
    (summary, account) => {
      const usageTotals = getAccountUsageTotals(account);
      summary.accounts += 1;
      summary.classes += toNumber(account.totals?.classes, 0);
      summary.assignments += usageTotals.totalAssignments;
      summary.empty += usageTotals.emptyAssignments;
      summary.reusable += usageTotals.reusableAssignments;
      summary.exhausted += usageTotals.exhaustedAssignments;
      summary.excluded += usageTotals.repositoryExcludedAssignments;
      summary.submittable += usageTotals.submittableAssignments;
      summary.resubmittable += usageTotals.resubmittableAssignments;

      const availability = String(account.availability || "").trim().toLowerCase();
      if (availability === "usable") {
        summary.usableAccounts += 1;
      } else if (availability === "exhausted") {
        summary.exhaustedAccounts += 1;
      } else {
        summary.unknownAccounts += 1;
      }

      return summary;
    },
    {
      accounts: 0,
      classes: 0,
      assignments: 0,
      empty: 0,
      reusable: 0,
      exhausted: 0,
      excluded: 0,
      submittable: 0,
      resubmittable: 0,
      usableAccounts: 0,
      exhaustedAccounts: 0,
      unknownAccounts: 0,
    }
  );
}

function renderExternalLink(url, label, className = "") {
  if (!url) {
    return "";
  }

  return `<a class="${className}" href="${escapeHtml(
    url
  )}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
}

function isLocalCurrentViewPdf(url) {
  return /^\/storage\/reports\/.+\.pdf(?:$|\?)/i.test(String(url || ""));
}

function renderCurrentViewLink(url, className = "") {
  if (!url || !isLocalCurrentViewPdf(url)) {
    return "";
  }

  return renderExternalLink(url, "Download Current View PDF", className);
}

function renderCurrentViewPending(className = "") {
  return `<span class="${className}">Current View PDF belum tersedia</span>`;
}

function formatLogEntry(entry) {
  return `[${formatTimestamp(entry.timestamp)}] ${entry.message}`;
}

function getJobLogsText(job) {
  if (!job?.logs?.length) {
    return "";
  }

  return job.logs.map((entry) => formatLogEntry(entry)).join("\n");
}

function getJobErrorText(job) {
  if (!job?.error?.message) {
    return "";
  }

  const lines = [
    `Job Title: ${job.title || "-"}`,
    `Original File: ${job.originalName || "-"}`,
    `Job ID: ${job.id || "-"}`,
    `Status: ${job.status || "-"}`,
    `Error: ${job.error.message}`,
  ];

  const logsText = getJobLogsText(job);
  if (logsText) {
    lines.push("", "Logs:", logsText);
  }

  return lines.join("\n");
}

function renderReportOptions(options = {}) {
  const labels = [];
  if (options.excludeQuotes) {
    labels.push("Exclude quotes");
  }
  if (options.excludeBibliography) {
    labels.push("Exclude bibliography");
  }
  if (options.excludeMatches) {
    labels.push(`Exclude matches < ${Number(options.excludeMatchesWordCount) || 10} words`);
  }

  return labels.length ? labels.join(" • ") : "Default viewer filters";
}

function getFocusedJobSummary() {
  return (
    findJobById(activeJobId) ||
    currentJobs.find((job) => job.status === "running") ||
    currentJobs.find((job) => job.status === "queued") ||
    currentJobs[0] ||
    null
  );
}

function renderOperationalHero() {
  if (!queueBoard || !focusSummary || !healthNote) {
    return;
  }

  const runtime = runtimeSnapshot || {};
  const pool = aggregateAccountUsage(currentAccounts);
  const focusedJob = getFocusedJobSummary();
  const maxParallel = runtime.maxConcurrentJobs ?? runtime.configuredMaxConcurrentJobs ?? "-";
  const queueStateLabel = Number(runtime.runningJobCount) > 0 ? "Aktif" : "Tenang";

  queueBoard.innerHTML = `
    <div class="overview-card-topline">
      <span class="overview-kicker">Queue Window</span>
      <span class="usage-chip overview">${queueStateLabel}</span>
    </div>
    <div class="overview-main-number">${Number(runtime.runningJobCount) || 0}<small>running</small></div>
    <div class="overview-gridline">
      <div><span>Queued</span><strong>${Number(runtime.queuedJobCount) || 0}</strong></div>
      <div><span>Max Parallel</span><strong>${escapeHtml(maxParallel)}</strong></div>
      <div><span>Pool Ready</span><strong>${pool.submittable}</strong></div>
      <div><span>Resubmit</span><strong>${pool.resubmittable}</strong></div>
    </div>
    <div class="overview-footnote">
      ${
        runtime.lastPumpError?.message
          ? `Queue terakhir memberi warning: ${escapeHtml(runtime.lastPumpError.message)}`
          : `Watchdog recovery: ${Number(runtime.stalledPumpRecoveries) || 0} • Akun usable: ${pool.usableAccounts}/${pool.accounts || 0}`
      }
    </div>
  `;

  if (focusedJob) {
    const focusedSimilarity =
      focusedJob.result?.currentViewSimilarity ||
      focusedJob.result?.dashboardSimilarity ||
      focusedJob.result?.similarity ||
      "-";

    focusSummary.innerHTML = `
      <div class="overview-card-topline">
        <span class="overview-kicker">Focus Job</span>
        <span class="badge ${escapeHtml(focusedJob.status)}">${escapeHtml(focusedJob.status)}</span>
      </div>
      <div class="overview-title">${escapeHtml(
        focusedJob.title || focusedJob.originalName || focusedJob.id
      )}</div>
      <div class="overview-subtitle">${escapeHtml(
        focusedJob.originalName || focusedJob.result?.accountEmail || "Belum ada file"
      )}</div>
      <div class="overview-list">
        <div><span>Similarity</span><strong>${escapeHtml(focusedSimilarity)}</strong></div>
        <div><span>Updated</span><strong>${escapeHtml(
          formatTimestamp(
            focusedJob.updatedAt || focusedJob.result?.finishedAt || focusedJob.createdAt || null
          )
        )}</strong></div>
      </div>
      <div class="overview-footnote">${
        focusedJob.result?.assignmentName
          ? `Assignment: ${escapeHtml(focusedJob.result.assignmentName)}`
          : `Job ID: ${escapeHtml(focusedJob.id || "-")}`
      }</div>
    `;
  } else {
    focusSummary.innerHTML = `
      <div class="overview-card-topline">
        <span class="overview-kicker">Focus Job</span>
        <span class="usage-chip overview">Idle</span>
      </div>
      <div class="overview-title">Belum ada job yang dipilih</div>
      <div class="overview-subtitle">Upload dokumen baru atau klik item dari Recent Results untuk memfokuskan inspeksi job.</div>
    `;
  }

  healthNote.innerHTML = `
    <div class="health-line">
      <strong>Pool saat ini</strong>
      <span>${pool.empty} assignment kosong, ${pool.reusable} reusable, ${pool.exhausted} habis lokal.</span>
    </div>
    <div class="health-line">
      <strong>Saran cepat</strong>
      <span>${
        pool.submittable > 0
          ? `${pool.submittable} assignment masih siap dipakai sekarang.`
          : "Belum ada slot siap pakai. Lakukan refresh scan atau tunggu pool bergeser."
      }</span>
    </div>
  `;
}

function setLoginFeedback(message = "", variant = "error") {
  if (!message) {
    loginError.textContent = "";
    loginError.className = "auth-feedback hidden";
    return;
  }

  loginError.textContent = message;
  loginError.className = `auth-feedback ${variant}`;
}

function setJobCopyFeedback(message, variant = "info") {
  clearTimeout(jobCopyFeedbackTimer);
  jobCopyStatus.textContent = message;
  jobCopyStatus.className = `copy-feedback ${variant}`;

  if (variant !== "muted") {
    jobCopyFeedbackTimer = setTimeout(() => {
      if (displayedJob) {
        updateJobCopyState(displayedJob);
      } else {
        setJobCopyFeedback("Pilih job untuk menyalin log atau error.", "muted");
      }
    }, 2200);
  }
}

function setSessionScreen(authenticated) {
  authScreen.classList.toggle("hidden", authenticated);
  dashboardShell.classList.toggle("hidden", !authenticated);
  if (authenticated) {
    sessionBadge.textContent = sessionState?.username || "Admin";
  } else {
    sessionBadge.textContent = "-";
  }
}

function setBootState(active) {
  document.body.classList.toggle("is-booting", Boolean(active));
  if (bootScreen) {
    bootScreen.classList.toggle("hidden", !active);
  }
}

function clearTimers() {
  clearInterval(pollTimer);
  clearInterval(jobsRefreshTimer);
  clearInterval(accountsRefreshTimer);
  pollTimer = null;
  jobsRefreshTimer = null;
  accountsRefreshTimer = null;
}

function resetDashboard() {
  currentJobs = [];
  currentAccounts = [];
  runtimeSnapshot = null;
  recentSubmissionHistory = [];
  activeJobId = null;
  displayedJob = null;
  runtimeMeta.innerHTML = "";
  runtimeAlert.className = "runtime-alert hidden";
  runtimeAlert.innerHTML = "";
  if (queueBoard) {
    queueBoard.innerHTML = "";
  }
  if (focusSummary) {
    focusSummary.innerHTML = "";
  }
  if (healthNote) {
    healthNote.innerHTML = "";
  }
  accountsMeta.innerHTML = "";
  accountsGrid.innerHTML = "";
  recentJobs.innerHTML = "";
  renderEmptyJobState("Belum ada job aktif.");
}

function handleUnauthorized(message = "Sesi admin berakhir. Silakan login lagi.") {
  clearTimers();
  sessionState = null;
  setSessionScreen(false);
  resetDashboard();
  setLoginFeedback(message, "error");
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    return text;
  }
}

async function apiFetch(url, options = {}) {
  const nextOptions = {
    credentials: "same-origin",
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers || {}),
    },
  };

  if (
    nextOptions.body &&
    !(nextOptions.body instanceof FormData) &&
    typeof nextOptions.body === "object"
  ) {
    nextOptions.headers["Content-Type"] = "application/json";
    nextOptions.body = JSON.stringify(nextOptions.body);
  }

  const response = await fetch(url, nextOptions);
  const payload = await parseResponse(response);
  if (response.status === 401) {
    handleUnauthorized(payload?.error || "Login admin dibutuhkan.");
    const error = new Error(payload?.error || "Login admin dibutuhkan.");
    error.authRequired = true;
    throw error;
  }

  if (!response.ok) {
    throw new Error(payload?.error || payload || "Request gagal.");
  }

  return payload;
}

function renderEmptyJobState(message = "Belum ada job aktif.") {
  displayedJob = null;
  jobState.className = "job-empty";
  jobState.textContent = message;
  jobLogs.classList.add("hidden");
  jobLogs.textContent = "";
  jobResult.classList.add("hidden");
  jobResult.innerHTML = "";
  updateJobCopyState(null);
  renderOperationalHero();
}

function updateJobCopyState(job) {
  const logsText = getJobLogsText(job);
  const errorText = getJobErrorText(job);

  copyLogsButton.disabled = !logsText;
  copyErrorButton.disabled = !errorText;

  if (!job) {
    setJobCopyFeedback("Pilih job untuk menyalin log atau error.", "muted");
    return;
  }

  if (errorText) {
    setJobCopyFeedback("Error job siap dicopy untuk laporan atau debugging.", "muted");
    return;
  }

  if (logsText) {
    setJobCopyFeedback("Log job siap dicopy langsung dari panel ini.", "muted");
    return;
  }

  setJobCopyFeedback("Job ini belum punya log atau error untuk dicopy.", "muted");
}

async function copyTextToClipboard(text) {
  if (!text) {
    throw new Error("Tidak ada isi untuk dicopy.");
  }

  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  const success = document.execCommand("copy");
  document.body.removeChild(textarea);

  if (!success) {
    throw new Error("Browser menolak aksi copy.");
  }
}

function renderRuntimeMeta(payload = {}) {
  runtimeMeta.innerHTML = `
    <div class="runtime-pill">
      <span>Running</span>
      <strong>${Number(payload.runningJobCount) || 0}</strong>
    </div>
    <div class="runtime-pill">
      <span>Queued</span>
      <strong>${Number(payload.queuedJobCount) || 0}</strong>
    </div>
    <div class="runtime-pill">
      <span>Max Parallel</span>
      <strong>${escapeHtml(payload.maxConcurrentJobs ?? "-")}</strong>
    </div>
    <div class="runtime-pill">
      <span>Recoveries</span>
      <strong>${Number(payload.stalledPumpRecoveries) || 0}</strong>
    </div>
  `;

  const poolAlert = payload.poolAlert || null;
  if (poolAlert?.level === "critical") {
    runtimeAlert.className = "runtime-alert danger";
    runtimeAlert.innerHTML = `
      <strong>Pool Hampir Habis</strong>
      <span>${escapeHtml(poolAlert.detailText || poolAlert.headline || "Slot akun hampir habis.")}</span>
    `;
    return;
  }

  if (poolAlert?.level === "warning") {
    runtimeAlert.className = "runtime-alert warning";
    runtimeAlert.innerHTML = `
      <strong>Pool Menipis</strong>
      <span>${escapeHtml(poolAlert.detailText || poolAlert.headline || "Slot akun mulai menipis.")}</span>
    `;
    return;
  }

  if (payload.lastPumpError?.message) {
    runtimeAlert.className = "runtime-alert warning";
    runtimeAlert.innerHTML = `
      <strong>Queue Warning</strong>
      <span>${escapeHtml(payload.lastPumpError.message)}</span>
    `;
    return;
  }

  if (Number(payload.stalledPumpRecoveries) > 0) {
    runtimeAlert.className = "runtime-alert info";
    runtimeAlert.innerHTML = `
      <strong>Queue Recovery</strong>
      <span>Watchdog sudah melakukan ${Number(payload.stalledPumpRecoveries)} recovery pump.</span>
    `;
    return;
  }

  runtimeAlert.className = "runtime-alert ok";
  runtimeAlert.innerHTML = `
    <strong>Queue Stable</strong>
    <span>Runner aktif dan tidak ada pump error terakhir.</span>
  `;
}

function renderStats(accounts) {
  const totals = accounts.reduce(
    (result, account) => {
      const usageTotals = getAccountUsageTotals(account);
      result.accounts += 1;
      result.classes += account.totals?.classes || 0;
      result.assignments += usageTotals.totalAssignments;
      result.empty += usageTotals.emptyAssignments;
      result.reusable += usageTotals.reusableAssignments;
      result.exhausted += usageTotals.exhaustedAssignments;
      result.excluded += usageTotals.repositoryExcludedAssignments;
      return result;
    },
    {
      accounts: 0,
      classes: 0,
      assignments: 0,
      empty: 0,
      reusable: 0,
      exhausted: 0,
      excluded: 0,
    }
  );

  accountsMeta.innerHTML = `
    <div class="stat"><span>Total akun</span><strong>${totals.accounts}</strong></div>
    <div class="stat"><span>Total kelas</span><strong>${totals.classes}</strong></div>
    <div class="stat"><span>Total assignment</span><strong>${totals.assignments}</strong></div>
    <div class="stat"><span>Belum dipakai</span><strong>${totals.empty}</strong></div>
    <div class="stat"><span>Bisa resubmit</span><strong>${totals.reusable}</strong></div>
    <div class="stat"><span>Slot habis</span><strong>${totals.exhausted}</strong></div>
    <div class="stat"><span>Repository skip</span><strong>${totals.excluded}</strong></div>
  `;
}

function renderAccounts(accounts) {
  if (!accounts.length) {
    currentAccounts = [];
    accountsGrid.innerHTML = `
      <article class="card account-card empty">
        <h3>Belum ada data scan</h3>
        <p>Tekan “Refresh Scan” untuk membaca kelas dan assignment dari akun Turnitin.</p>
      </article>
    `;
    accountsMeta.innerHTML = "";
    renderOperationalHero();
    return;
  }

  currentAccounts = accounts;
  renderStats(accounts);
  accountsGrid.innerHTML = sortAccountsForPanel(accounts)
    .map((account) => {
      const usageTotals = getAccountUsageTotals(account);
      const availability = getAccountAvailabilityMeta(account.availability);
      const classItems = (account.classes || [])
        .slice(0, 3)
        .map(
          (classItem) => {
            const sortedAssignments = sortAssignmentsForPanel(classItem.assignments || []);
            const visibleAssignments = sortedAssignments.slice(0, 6);
            const hiddenAssignments = Math.max(0, sortedAssignments.length - visibleAssignments.length);
            const assignmentItems = visibleAssignments
              .map((assignment) => {
                const usageMeta = getAssignmentUsageMeta(assignment);
                return `
                  <li class="assignment-status-item">
                    <div class="assignment-status-copy">
                      <strong>${escapeHtml(assignment.name)}</strong>
                      <span>${escapeHtml(buildAssignmentUsageNote(assignment))}</span>
                    </div>
                    <span class="usage-chip ${escapeHtml(usageMeta.className)}">${escapeHtml(
                      usageMeta.label
                    )}</span>
                  </li>
                `;
              })
              .join("");

            return `
              <div class="assignment-class-card">
                <div class="assignment-class-head">
                  <span>${escapeHtml(classItem.name)}</span>
                  <strong>${toNumber(
                    classItem.usageTotals?.submittableAssignments,
                    classItem.availableAssignments || 0
                  )} siap</strong>
                </div>
                ${
                  assignmentItems
                    ? `<ul class="assignment-status-list">${assignmentItems}</ul>`
                    : `<p class="muted">Tidak ada assignment yang berhasil terbaca.</p>`
                }
                ${
                  hiddenAssignments > 0
                    ? `<p class="assignment-more">+${hiddenAssignments} assignment lain disembunyikan.</p>`
                    : ""
                }
              </div>
            `;
          }
        )
        .join("");

      return `
        <article class="card account-card">
          <div class="card-topline">
            <h3>${escapeHtml(account.accountEmail)}</h3>
            <span class="mini-badge">${escapeHtml(formatTimestamp(account.scannedAt))}</span>
          </div>
          <div class="usage-strip">
            <span class="usage-chip availability ${escapeHtml(availability.className)}">${escapeHtml(
              availability.label
            )}</span>
            <span class="usage-chip empty">Kosong ${usageTotals.emptyAssignments}</span>
            <span class="usage-chip reusable">Resubmit ${usageTotals.reusableAssignments}</span>
            <span class="usage-chip exhausted">Habis ${usageTotals.exhaustedAssignments}</span>
            ${
              usageTotals.repositoryExcludedAssignments > 0
                ? `<span class="usage-chip excluded">Repo skip ${usageTotals.repositoryExcludedAssignments}</span>`
                : ""
            }
          </div>
          <div class="account-totals">
            <div><span>Classes</span><strong>${account.totals?.classes || 0}</strong></div>
            <div><span>Assignments</span><strong>${usageTotals.totalAssignments}</strong></div>
            <div><span>Siap dipakai</span><strong>${usageTotals.submittableAssignments}</strong></div>
            <div><span>Bisa resubmit</span><strong>${usageTotals.resubmittableAssignments}</strong></div>
          </div>
          ${
            account.lastError
              ? `<p class="inline-error"><strong>Error:</strong> ${escapeHtml(account.lastError)}</p>`
              : ""
          }
          ${
            classItems
              ? `<div class="account-assignment-groups">${classItems}</div>`
              : "<p class=\"muted\">Tidak ada kelas yang berhasil terdeteksi.</p>"
          }
        </article>
      `;
    })
    .join("");
  renderOperationalHero();
}

function normalizeRecentJobEntries(jobs = [], submissions = []) {
  const seen = new Set();
  const entries = [];

  for (const job of jobs) {
    const result = job.result || {};
    const artifacts = result.artifacts || {};
    const key = job.id || result.jobId;
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    entries.push({
      id: key,
      title: job.title || result.assignmentName || `Job ${key}`,
      subtitle: job.originalName || result.assignmentName || "-",
      status: job.status || result.similarityStatus || "-",
      timestamp: job.updatedAt || job.createdAt || result.finishedAt || "-",
      similarity: result.similarity || result.dashboardSimilarity || null,
      currentViewUrl: artifacts.viewerPdf || "",
      receiptUrl: artifacts.digitalReceipt || "",
      originalFileUrl: artifacts.originalFile || "",
    });
  }

  for (const submission of submissions) {
    const artifacts = submission.artifacts || {};
    const key = submission.jobId;
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    entries.push({
      id: key,
      title: submission.assignmentName || `Job ${key}`,
      subtitle: submission.accountEmail || "-",
      status: submission.similarityStatus || submission.status || "submitted",
      timestamp: submission.finishedAt || "-",
      similarity:
        submission.currentViewSimilarity || submission.dashboardSimilarity || submission.similarity || null,
      currentViewUrl: artifacts.viewerPdf || "",
      receiptUrl: artifacts.digitalReceipt || "",
      originalFileUrl: artifacts.originalFile || "",
    });
  }

  return entries;
}

function renderRecentJobs(jobs = [], submissions = []) {
  const entries = normalizeRecentJobEntries(jobs, submissions);
  if (!entries.length) {
    recentJobs.innerHTML = `
      <article class="card recent-card empty">
        <h3>Belum ada job</h3>
        <p>Upload file pertama untuk mulai.</p>
      </article>
    `;
    return;
  }

  recentJobs.innerHTML = entries
    .map(
      (job) => `
        <article class="card recent-card ${
          activeJobId === job.id ? "is-active" : ""
        }" data-job-id="${escapeHtml(job.id)}">
          <div class="card-topline">
            <h3>${escapeHtml(job.title)}</h3>
            <span class="badge ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span>
          </div>
          <p>${escapeHtml(job.subtitle)}</p>
          <div class="recent-meta">
            <span>${escapeHtml(formatTimestamp(job.timestamp))}</span>
            <strong>${escapeHtml(job.similarity || "-")}</strong>
          </div>
          <div class="recent-links">
            ${
              job.currentViewUrl
                ? renderCurrentViewLink(job.currentViewUrl, "text-link")
                : renderCurrentViewPending("muted")
            }
            ${job.receiptUrl ? renderExternalLink(job.receiptUrl, "Digital receipt", "text-link") : ""}
            ${job.originalFileUrl ? renderExternalLink(job.originalFileUrl, "Uploaded source", "text-link") : ""}
          </div>
        </article>
      `
    )
    .join("");
}

function renderJob(job) {
  displayedJob = job;
  jobState.className = "job-state";
  jobState.innerHTML = `
    <div>
      <strong>${escapeHtml(job.title)}</strong>
      <div class="muted">${escapeHtml(job.originalName)}</div>
      <div class="muted">Job ID: ${escapeHtml(job.id)}</div>
    </div>
    <span class="badge ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span>
  `;

  if (job.logs?.length) {
    jobLogs.classList.remove("hidden");
    jobLogs.textContent = getJobLogsText(job);
    jobLogs.scrollTop = jobLogs.scrollHeight;
  } else {
    jobLogs.classList.add("hidden");
    jobLogs.textContent = "";
  }

  if (job.result) {
    const artifacts = job.result.artifacts || {};
    const currentViewUrl = artifacts.viewerPdf || "";
    const reportOptions = job.result.reportOptions || job.reportOptions || {};
    jobResult.className = "result";
    jobResult.classList.remove("hidden");
    jobResult.innerHTML = `
      <div class="result-grid">
        <div><strong>Account</strong><span>${escapeHtml(job.result.accountEmail || "-")}</span></div>
        <div><strong>Class</strong><span>${escapeHtml(job.result.className || "-")}</span></div>
        <div><strong>Assignment</strong><span>${escapeHtml(job.result.assignmentName || "-")}</span></div>
        <div><strong>Similarity</strong><span>${escapeHtml(job.result.similarity || "-")}</span></div>
        <div><strong>Status</strong><span>${escapeHtml(job.result.similarityStatus || "-")}</span></div>
        <div><strong>Filters</strong><span>${escapeHtml(renderReportOptions(reportOptions))}</span></div>
        ${
          currentViewUrl
            ? `<div class="result-link">${renderCurrentViewLink(currentViewUrl, "text-link")}</div>`
            : `<div class="result-link">${renderCurrentViewPending("muted")}</div>`
        }
        ${
          artifacts.submissionStatusImage
            ? `<div class="result-link">${renderExternalLink(
                artifacts.submissionStatusImage,
                "Submission status image",
                "text-link"
              )}</div>`
            : ""
        }
        ${
          artifacts.viewerScreenshot
            ? `<div class="result-link">${renderExternalLink(
                artifacts.viewerScreenshot,
                "Report screenshot",
                "text-link"
              )}</div>`
            : ""
        }
        ${
          artifacts.digitalReceipt
            ? `<div class="result-link">${renderExternalLink(
                artifacts.digitalReceipt,
                "Digital receipt",
                "text-link"
              )}</div>`
            : ""
        }
        ${
          artifacts.originalFile
            ? `<div class="result-link">${renderExternalLink(
                artifacts.originalFile,
                "Uploaded source file",
                "text-link"
              )}</div>`
            : ""
        }
      </div>
    `;
  } else if (job.error) {
    jobResult.className = "result error";
    jobResult.classList.remove("hidden");
    jobResult.innerHTML = `<strong>Gagal:</strong> ${escapeHtml(job.error.message)}`;
  } else {
    jobResult.classList.add("hidden");
    jobResult.innerHTML = "";
  }

  updateJobCopyState(job);
  renderOperationalHero();
}

function normalizeQueuedJobs(payload) {
  if (Array.isArray(payload?.jobs)) {
    return payload.jobs;
  }

  if (payload?.id) {
    return [payload];
  }

  return [];
}

function findJobById(jobId) {
  return currentJobs.find((job) => job.id === jobId) || null;
}

async function fetchAccounts(refresh = false, { background = false } = {}) {
  if (!background) {
    refreshAccountsButton.disabled = true;
  }

  try {
    const data = await apiFetch(`/api/accounts/usage${refresh ? "?refresh=1" : ""}`);
    recentSubmissionHistory = data.recentSubmissions || recentSubmissionHistory;
    renderAccounts(data.accounts || []);
    renderRecentJobs(currentJobs, recentSubmissionHistory);
  } catch (error) {
    if (!background && !error.authRequired) {
      accountsGrid.innerHTML = `
        <article class="card account-card empty">
          <h3>Gagal memuat account summary</h3>
          <p>${escapeHtml(error.message)}</p>
        </article>
      `;
    }
  } finally {
    if (!background) {
      refreshAccountsButton.disabled = false;
    }
  }
}

async function fetchJobs() {
  const data = await apiFetch("/api/jobs");
  runtimeSnapshot = data;
  currentJobs = data.jobs || [];
  recentSubmissionHistory = data.recentSubmissions || recentSubmissionHistory;
  renderRuntimeMeta(data);
  renderOperationalHero();

  const selectedJob =
    findJobById(activeJobId) ||
    currentJobs.find((job) => job.status === "running" || job.status === "queued") ||
    currentJobs[0] ||
    null;

  if (!selectedJob) {
    const latestRecentJobId = recentSubmissionHistory[0]?.jobId || null;
    activeJobId = latestRecentJobId;
    renderRecentJobs(currentJobs, recentSubmissionHistory);
    if (latestRecentJobId) {
      await fetchJob(latestRecentJobId);
    } else {
      renderEmptyJobState();
    }
    clearInterval(pollTimer);
    pollTimer = null;
    return;
  }

  activeJobId = selectedJob.id;
  renderRecentJobs(currentJobs, recentSubmissionHistory);
  renderJob(selectedJob);
  ensureSelectedJobPolling();
}

async function fetchJob(jobId) {
  const job = await apiFetch(`/api/jobs/${jobId}`);
  renderJob(job);
  return job;
}

function ensureSelectedJobPolling() {
  const selectedJob = findJobById(activeJobId);
  if (!selectedJob || (selectedJob.status !== "running" && selectedJob.status !== "queued")) {
    clearInterval(pollTimer);
    pollTimer = null;
    return;
  }

  if (pollTimer) {
    return;
  }

  pollTimer = setInterval(async () => {
    if (!activeJobId) {
      return;
    }

    try {
      const job = await fetchJob(activeJobId);
      await fetchJobs();
      if (job.status === "completed" || job.status === "failed") {
        clearInterval(pollTimer);
        pollTimer = null;
        await fetchAccounts(false);
      }
    } catch (error) {
      if (!error.authRequired) {
        console.error(error);
      }
    }
  }, 5000);
}

function ensureBackgroundRefresh() {
  if (!jobsRefreshTimer) {
    jobsRefreshTimer = setInterval(() => {
      void fetchJobs().catch((error) => {
        if (!error.authRequired) {
          console.error(error);
        }
      });
    }, 5000);
  }

  if (!accountsRefreshTimer) {
    accountsRefreshTimer = setInterval(() => {
      void fetchAccounts(false, { background: true });
    }, 10000);
  }
}

async function hydrateDashboard() {
  await Promise.all([fetchAccounts(false), fetchJobs()]);
  ensureBackgroundRefresh();
}

async function restoreSession() {
  const response = await fetch("/api/auth/session", {
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
    },
  });
  const session = await parseResponse(response);
  if (!response.ok) {
    throw new Error(session?.error || "Gagal memeriksa sesi login.");
  }

  if (!session?.authenticated) {
    sessionState = null;
    setSessionScreen(false);
    return;
  }

  sessionState = session;
  setSessionScreen(true);
  setLoginFeedback("");
  await hydrateDashboard();
}

setBootState(true);

refreshAccountsButton.addEventListener("click", async () => {
  await fetchAccounts(true);
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setLoginFeedback("");
  loginButton.disabled = true;

  const formData = new FormData(loginForm);
  try {
    sessionState = await apiFetch("/api/auth/login", {
      method: "POST",
      body: {
        username: formData.get("username"),
        password: formData.get("password"),
      },
    });
    setSessionScreen(true);
    await hydrateDashboard();
    loginForm.reset();
  } catch (error) {
    if (!error.authRequired) {
      setLoginFeedback(error.message, "error");
    }
  } finally {
    loginButton.disabled = false;
  }
});

logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;
  try {
    await apiFetch("/api/auth/logout", {
      method: "POST",
    });
  } catch (error) {
    if (!error.authRequired) {
      console.error(error);
    }
  } finally {
    logoutButton.disabled = false;
    clearTimers();
    sessionState = null;
    setSessionScreen(false);
    resetDashboard();
    setLoginFeedback("Sesi admin ditutup.", "info");
  }
});

submitForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(submitForm);
  const selectedFiles = formData.getAll("document").filter((file) => file && file.name);
  if (!selectedFiles.length) {
    renderEmptyJobState("Pilih minimal satu file dulu.");
    return;
  }

  submitButton.disabled = true;
  jobState.className = "job-empty";
  jobState.textContent =
    selectedFiles.length > 1
      ? `Mengirim ${selectedFiles.length} file ke antrian...`
      : "Mengirim file ke antrian...";
  jobLogs.classList.add("hidden");
  jobResult.classList.add("hidden");

  try {
    const payload = await apiFetch("/api/jobs", {
      method: "POST",
      body: formData,
    });
    const queuedJobs = normalizeQueuedJobs(payload);
    if (!queuedJobs.length) {
      throw new Error("Server tidak mengembalikan job yang valid.");
    }

    activeJobId = queuedJobs[0].id;
    if (queuedJobs.length > 1) {
      renderEmptyJobState(
        `${queuedJobs.length} file masuk antrian. Menampilkan progres job pertama, sisanya berjalan otomatis sesuai slot akun yang tersedia.`
      );
    } else {
      renderJob(queuedJobs[0]);
    }
    submitForm.reset();
    clearInterval(pollTimer);
    pollTimer = null;
    await fetchJobs();
    ensureSelectedJobPolling();
    if (activeJobId) {
      await fetchJob(activeJobId);
    }
  } catch (error) {
    if (!error.authRequired) {
      renderEmptyJobState(error.message);
    }
  } finally {
    submitButton.disabled = false;
  }
});

recentJobs.addEventListener("click", async (event) => {
  if (event.target.closest("a")) {
    return;
  }

  const card = event.target.closest("[data-job-id]");
  if (!card) {
    return;
  }

  activeJobId = card.dataset.jobId || null;
  clearInterval(pollTimer);
  pollTimer = null;
  renderRecentJobs(currentJobs, recentSubmissionHistory);
  ensureSelectedJobPolling();
  if (activeJobId) {
    await fetchJob(activeJobId).catch((error) => {
      if (!error.authRequired) {
        renderEmptyJobState(error.message);
      }
    });
  }
});

copyLogsButton.addEventListener("click", async () => {
  const logsText = getJobLogsText(displayedJob);
  if (!logsText) {
    setJobCopyFeedback("Job ini belum punya log untuk dicopy.", "error");
    return;
  }

  try {
    await copyTextToClipboard(logsText);
    setJobCopyFeedback("Log berhasil dicopy.", "success");
  } catch (error) {
    setJobCopyFeedback(error.message, "error");
  }
});

copyErrorButton.addEventListener("click", async () => {
  const errorText = getJobErrorText(displayedJob);
  if (!errorText) {
    setJobCopyFeedback("Job ini belum punya error untuk dicopy.", "error");
    return;
  }

  try {
    await copyTextToClipboard(errorText);
    setJobCopyFeedback("Error berhasil dicopy.", "success");
  } catch (error) {
    setJobCopyFeedback(error.message, "error");
  }
});

void restoreSession()
  .catch((error) => {
    setSessionScreen(false);
    setLoginFeedback(error.message, "error");
  })
  .finally(() => {
    setBootState(false);
  });
