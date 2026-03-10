const test = require("node:test");
const assert = require("node:assert/strict");
const { TurnitinService } = require("../src/services/turnitin-service");

function createService(overrides = {}) {
  return new TurnitinService({
    config: {
      maxSubmissionsPerAssignment: 2,
      maxAttemptsPerAssignment: 2,
      similarityFollowUpWaitMs: 60 * 1000,
      currentViewFollowUpAttemptMs: 15 * 1000,
      currentViewMaxAttempts: 4,
      ...overrides,
    },
    stateStore: {},
  });
}

test("claimAvailableAccount avoids accounts already claimed by another job", async () => {
  const service = createService();
  const accounts = [
    { email: "a@example.com" },
    { email: "b@example.com" },
  ];

  const first = await service.claimAvailableAccount(accounts, { jobId: "job-1" });
  const second = await service.claimAvailableAccount(accounts, { jobId: "job-2" });

  assert.equal(first.email, "a@example.com");
  assert.equal(second.email, "b@example.com");
});

test("claimAvailableAccount waits until a matching account is released", async () => {
  const service = createService();
  const accounts = [
    { email: "a@example.com" },
    { email: "b@example.com" },
  ];

  await service.claimAvailableAccount(accounts, { jobId: "job-1" });
  await service.claimAvailableAccount(accounts, { jobId: "job-2" });

  let resolved = false;
  const waitingClaim = service
    .claimAvailableAccount(accounts, {
      excludedEmails: new Set(["b@example.com"]),
      jobId: "job-3",
    })
    .then((account) => {
      resolved = true;
      return account;
    });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(resolved, false);

  service.releaseClaimedAccount("a@example.com", "job-1");
  const claimed = await waitingClaim;

  assert.equal(claimed.email, "a@example.com");
});

test("getMaxConcurrency follows account count when configured cap is auto", async () => {
  const service = new TurnitinService({
    config: {
      maxConcurrentJobs: 0,
    },
    stateStore: {},
  });
  service.getAccounts = async () => [
    { email: "a@example.com" },
    { email: "b@example.com" },
    { email: "c@example.com" },
  ];

  assert.equal(await service.getMaxConcurrency(), 3);
});

test("getMaxConcurrency respects configured cap when present", async () => {
  const service = new TurnitinService({
    config: {
      maxConcurrentJobs: 2,
      maxSubmissionsPerAssignment: 2,
      maxAttemptsPerAssignment: 2,
    },
    stateStore: {},
  });
  service.getAccounts = async () => [
    { email: "a@example.com" },
    { email: "b@example.com" },
    { email: "c@example.com" },
  ];

  assert.equal(await service.getMaxConcurrency(), 2);
});

test("getMaxConcurrency follows total configured account count in auto mode", async () => {
  const service = new TurnitinService({
    config: {
      maxConcurrentJobs: 0,
      maxSubmissionsPerAssignment: 2,
      maxAttemptsPerAssignment: 2,
    },
    stateStore: {
      projectAccountSummaries(accounts) {
        return accounts.map((account) => {
          if (account.email === "usable@example.com") {
            return {
              accountEmail: account.email,
              scannedAt: "2026-03-08T01:00:00.000Z",
              classes: [
                {
                  name: "Class A",
                  assignments: [
                    {
                      name: "Assignment 1",
                      key: "assignment-1",
                      rawText: "Assignment 1 Open",
                    },
                  ],
                },
              ],
              lastError: null,
            };
          }

          if (account.email === "exhausted@example.com") {
            return {
              accountEmail: account.email,
              scannedAt: "2026-03-08T01:00:00.000Z",
              classes: [
                {
                  name: "Class B",
                  assignments: [
                    {
                      name: "Assignment 2",
                      key: "assignment-2",
                      rawText: "Assignment 2 Open",
                    },
                  ],
                },
              ],
              lastError: null,
            };
          }

          return {
            accountEmail: account.email,
            scannedAt: null,
            classes: [],
            lastError: null,
          };
        });
      },
      getSelectionHints(accountEmail) {
        if (accountEmail === "exhausted@example.com") {
          return {
            classes: {
              "Class B": {
                assignments: {
                  "assignment-2": {
                    successCount: 2,
                  },
                },
              },
            },
          };
        }

        return { classes: {} };
      },
    },
  });
  service.getAccounts = async () => [
    { email: "exhausted@example.com" },
    { email: "usable@example.com" },
    { email: "unknown@example.com" },
  ];

  assert.equal(await service.getMaxConcurrency(), 3);
});

test("rankAccountsForJobs prioritizes usable accounts before exhausted ones", () => {
  const service = new TurnitinService({
    config: {
      maxSubmissionsPerAssignment: 2,
      maxAttemptsPerAssignment: 2,
    },
    stateStore: {
      projectAccountSummaries(accounts) {
        return accounts.map((account) => ({
          accountEmail: account.email,
          scannedAt: "2026-03-08T01:00:00.000Z",
          classes: [
            {
              name: account.email === "usable@example.com" ? "Class A" : "Class B",
              assignments: [
                {
                  name: "Assignment 1",
                  key: "assignment-1",
                  rawText: "Assignment 1 Open",
                },
              ],
            },
          ],
          lastError: null,
        }));
      },
      getSelectionHints(accountEmail) {
        if (accountEmail === "exhausted@example.com") {
          return {
            classes: {
              "Class B": {
                assignments: {
                  "assignment-1": {
                    successCount: 2,
                  },
                },
              },
            },
          };
        }

        return { classes: {} };
      },
    },
  });

  const ranked = service.rankAccountsForJobs([
    { email: "exhausted@example.com" },
    { email: "usable@example.com" },
  ]);

  assert.deepEqual(
    ranked.map((account) => account.email),
    ["usable@example.com", "exhausted@example.com"]
  );
});

test("buildAccountUsageSummaries exposes empty, reusable, exhausted, and excluded assignments", () => {
  const service = new TurnitinService({
    config: {
      maxSubmissionsPerAssignment: 2,
      maxAttemptsPerAssignment: 2,
    },
    stateStore: {
      projectAccountSummaries(accounts) {
        return accounts.map((account) => ({
          accountEmail: account.email,
          scannedAt: "2026-03-10T01:00:00.000Z",
          totals: {
            classes: 1,
            assignments: 4,
            available: 4,
            used: 0,
          },
          classes: [
            {
              name: "Class A",
              assignments: [
                {
                  name: "Assignment Empty",
                  key: "assignment-empty",
                  status: "available",
                  rawText: "Assignment Empty Open",
                },
                {
                  name: "Assignment Reuse",
                  key: "assignment-reuse",
                  status: "available",
                  rawText: "Assignment Reuse Open",
                },
                {
                  name: "Assignment Full",
                  key: "assignment-full",
                  status: "available",
                  rawText: "Assignment Full Open",
                },
                {
                  name: "Assignment Repo",
                  key: "assignment-repo",
                  status: "available",
                  rawText: "Assignment Repo Save to Repository",
                },
              ],
            },
          ],
          lastError: null,
        }));
      },
      getSelectionHints(accountEmail) {
        if (accountEmail !== "usable@example.com") {
          return { classes: {} };
        }

        return {
          classes: {
            "Class A": {
              assignments: {
                "assignment-reuse": {
                  attemptCount: 1,
                  successCount: 1,
                },
                "assignment-full": {
                  attemptCount: 2,
                  successCount: 2,
                },
              },
            },
          },
        };
      },
    },
  });

  const [summary] = service.buildAccountUsageSummaries([
    { email: "usable@example.com" },
  ]);

  const assignments = Object.fromEntries(
    summary.classes[0].assignments.map((assignment) => [assignment.key, assignment])
  );

  assert.equal(assignments["assignment-empty"].usage.effectiveStatus, "empty");
  assert.equal(assignments["assignment-empty"].usage.recommendedAction, "submit");
  assert.equal(assignments["assignment-reuse"].usage.effectiveStatus, "used-reusable");
  assert.equal(assignments["assignment-reuse"].usage.canResubmitNow, true);
  assert.equal(assignments["assignment-reuse"].usage.remainingSubmissions, 1);
  assert.equal(assignments["assignment-full"].usage.effectiveStatus, "used-exhausted");
  assert.equal(assignments["assignment-full"].usage.canSubmitNow, false);
  assert.equal(assignments["assignment-repo"].usage.effectiveStatus, "repository-excluded");
  assert.equal(summary.usageTotals.emptyAssignments, 1);
  assert.equal(summary.usageTotals.reusableAssignments, 1);
  assert.equal(summary.usageTotals.exhaustedAssignments, 1);
  assert.equal(summary.usageTotals.repositoryExcludedAssignments, 1);
});

test("inspectAssignment attaches local usage context for a specific assignment", async () => {
  const service = new TurnitinService({
    config: {
      maxSubmissionsPerAssignment: 2,
      maxAttemptsPerAssignment: 2,
    },
    stateStore: {
      projectAccountSummaries(accounts) {
        return accounts.map((account) => ({
          accountEmail: account.email,
          scannedAt: "2026-03-10T01:00:00.000Z",
          totals: {
            classes: 1,
            assignments: 1,
            available: 1,
            used: 0,
          },
          classes: [
            {
              name: "Class A",
              assignments: [
                {
                  name: "Assignment 1",
                  key: "assignment-1",
                  status: "available",
                  rawText: "Assignment 1 Open",
                },
              ],
            },
          ],
          lastError: null,
        }));
      },
      getSelectionHints() {
        return {
          classes: {
            "Class A": {
              assignments: {
                "assignment-1": {
                  attemptCount: 1,
                  successCount: 1,
                },
              },
            },
          },
        };
      },
    },
  });

  service.getAccounts = async () => [{ email: "usable@example.com" }];
  service.automation.inspectAssignment = async () => ({
    status: "ready",
    accountEmail: "usable@example.com",
    selection: {
      className: "Class A",
      assignmentName: "Assignment 1",
      assignmentKey: "assignment-1",
      assignmentUrl: "https://www.turnitin.com/assignment/1",
    },
    dashboard: {
      status: "used",
      canSubmit: true,
      submissionMode: "resubmit",
    },
  });

  const result = await service.inspectAssignment({
    accountIndex: 0,
    className: "Class A",
    assignmentKey: "assignment-1",
  });

  assert.equal(result.configuredLimits.maxSubmissionsPerAssignment, 2);
  assert.equal(result.localAssignment.className, "Class A");
  assert.equal(result.localUsage.canResubmitNow, true);
  assert.equal(result.localUsage.recommendedAction, "resubmit");
});

test("getPoolAlertSnapshot marks warning when usable pool is low", async () => {
  const service = new TurnitinService({
    config: {
      maxSubmissionsPerAssignment: 2,
      maxAttemptsPerAssignment: 2,
      poolAlerts: {
        enabled: true,
        usableAccountsThreshold: 2,
        submittableAssignmentsThreshold: 6,
      },
    },
    stateStore: {
      projectAccountSummaries(accounts) {
        return accounts.map((account) => ({
          accountEmail: account.email,
          scannedAt: "2026-03-10T01:00:00.000Z",
          totals: {
            classes: 1,
            assignments: 1,
            available: 1,
            used: 0,
          },
          classes: [
            {
              name: "Class A",
              assignments: [
                {
                  name: "Assignment 1",
                  key: "assignment-1",
                  status: account.email === "usable@example.com" ? "available" : "used",
                  rawText:
                    account.email === "usable@example.com"
                      ? "Assignment 1 Open"
                      : "Assignment 1 Submitted 20%",
                  similarity: account.email === "usable@example.com" ? null : "20%",
                },
              ],
            },
          ],
          lastError: null,
        }));
      },
      getSelectionHints(accountEmail) {
        if (accountEmail === "exhausted@example.com") {
          return {
            classes: {
              "Class A": {
                assignments: {
                  "assignment-1": {
                    successCount: 2,
                    attemptCount: 2,
                  },
                },
              },
            },
          };
        }

        return { classes: {} };
      },
    },
  });

  service.getAccounts = async () => [
    { email: "usable@example.com" },
    { email: "exhausted@example.com" },
  ];

  const snapshot = await service.getPoolAlertSnapshot();

  assert.equal(snapshot.level, "warning");
  assert.equal(snapshot.totals.accountCount, 2);
  assert.equal(snapshot.totals.usableAccounts, 1);
  assert.equal(snapshot.shouldNotifyAdmin, true);
});

test("scanAllAccounts uses bounded concurrency and preserves account order", async () => {
  const scanStarts = [];
  const scanFinishes = [];
  let activeScans = 0;
  let maxActiveScans = 0;

  const service = new TurnitinService({
    config: {
      scanConcurrency: 2,
      maxSubmissionsPerAssignment: 2,
      maxAttemptsPerAssignment: 2,
    },
    stateStore: {
      async setAccountSummaries() {},
    },
  });
  service.getAccounts = async () => [
    { email: "a@example.com" },
    { email: "b@example.com" },
    { email: "c@example.com" },
  ];
  service.automation.scanAccount = async (account) => {
    scanStarts.push(account.email);
    activeScans += 1;
    maxActiveScans = Math.max(maxActiveScans, activeScans);
    await new Promise((resolve) => setTimeout(resolve, account.email === "a@example.com" ? 40 : 10));
    activeScans -= 1;
    scanFinishes.push(account.email);
    return {
      accountEmail: account.email,
      scannedAt: "2026-03-09T01:00:00.000Z",
      totals: {
        classes: 1,
        assignments: 1,
        available: 1,
        used: 0,
      },
      classes: [],
      lastError: null,
    };
  };

  const summaries = await service.scanAllAccounts();

  assert.equal(maxActiveScans, 2);
  assert.deepEqual(scanStarts.slice(0, 2), ["a@example.com", "b@example.com"]);
  assert.deepEqual(
    summaries.map((summary) => summary.accountEmail),
    ["a@example.com", "b@example.com", "c@example.com"]
  );
  assert.ok(scanFinishes.includes("c@example.com"));
});

test("waitForCurrentViewPdf keeps retrying until viewer PDF is available", async () => {
  const service = createService();
  const logs = [];
  const progress = [];
  const waitTimeouts = [];
  let sessionCount = 0;
  let attempts = 0;

  service.automation.withAuthenticatedSession = async (_account, _onLog, run) => {
    sessionCount += 1;
    return run({
      page: { url: () => "https://www.turnitin.com/assignment/1" },
      context: {},
    });
  };
  service.automation.resumePendingSubmissionInSession = async ({
    knownSimilarity,
    knownReportUrl,
    existingArtifacts,
    waitTimeoutMs,
  }) => {
    attempts += 1;
    waitTimeouts.push(waitTimeoutMs);
    assert.equal(knownSimilarity, "96%");
    assert.equal(knownReportUrl, "https://ev.turnitin.com/app/carta/en_us/?o=123");
    assert.equal(
      existingArtifacts.viewerScreenshot,
      "/storage/reports/job/similarity-report.png"
    );

    if (attempts === 1) {
      return {
        similarity: "96%",
        similarityStatus: "ready",
        reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=123",
        studioUrl: "/storage/reports/job/similarity-report.png",
        artifacts: {
          viewerScreenshot: "/storage/reports/job/similarity-report.png",
        },
      };
    }

    return {
      similarity: "11%",
      similarityStatus: "ready",
      reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=123",
      studioUrl: "/storage/reports/job/similarity-report.pdf",
      artifacts: {
        viewerPdf: "/storage/reports/job/similarity-report.pdf",
      },
    };
  };

  const result = await service.waitForCurrentViewPdf({
    account: { email: "usable@example.com" },
    result: {
      status: "submitted",
      similarity: "96%",
      similarityStatus: "ready",
      classUrl: "https://www.turnitin.com/class/1",
      assignmentUrl: "https://www.turnitin.com/assignment/1",
      className: "Class A",
      assignmentName: "Assignment 1",
      reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=123",
      artifacts: {
        viewerScreenshot: "/storage/reports/job/similarity-report.png",
      },
    },
    originalName: "document.pdf",
    reportOptions: {
      excludeQuotes: true,
    },
    reportDir: "/tmp/report-job",
    onLog: (message) => logs.push(message),
    onProgress: (partialResult) => progress.push(partialResult),
  });

  assert.equal(attempts, 2);
  assert.equal(sessionCount, 1);
  assert.deepEqual(waitTimeouts, [15000, 15000]);
  assert.equal(result.similarity, "11%");
  assert.deepEqual(progress.map((entry) => entry.similarity), ["96%", "11%"]);
  assert.equal(result.artifacts.viewerPdf, "/storage/reports/job/similarity-report.pdf");
  assert.ok(
    logs.some((message) =>
      message.includes("Current View PDF belum tersedia dalam sesi awal")
    )
  );
  assert.ok(
    logs.some((message) => message.includes("Current View PDF belum tersedia, ulang cek"))
  );
});

test("waitForCurrentViewPdf stops after configured max attempts when viewer PDF never appears", async () => {
  const service = createService({
    similarityFollowUpWaitMs: 10 * 60 * 1000,
    currentViewMaxAttempts: 3,
  });
  const logs = [];
  let attempts = 0;

  service.automation.withAuthenticatedSession = async (_account, _onLog, run) =>
    run({
      page: { url: () => "https://www.turnitin.com/assignment/1" },
      context: {},
    });
  service.automation.resumePendingSubmissionInSession = async () => {
    attempts += 1;
    return {
      similarity: "99%",
      similarityStatus: "ready",
      reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=123",
      studioUrl: "/storage/reports/job/similarity-report.png",
      artifacts: {
        viewerScreenshot: "/storage/reports/job/similarity-report.png",
      },
    };
  };

  const result = await service.waitForCurrentViewPdf({
    account: { email: "usable@example.com" },
    result: {
      status: "submitted",
      similarity: "99%",
      similarityStatus: "ready",
      classUrl: "https://www.turnitin.com/class/1",
      assignmentUrl: "https://www.turnitin.com/assignment/1",
      className: "Class A",
      assignmentName: "Assignment 1",
      reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=123",
      artifacts: {
        viewerScreenshot: "/storage/reports/job/similarity-report.png",
      },
    },
    originalName: "document.pdf",
    reportOptions: {
      excludeQuotes: true,
    },
    reportDir: "/tmp/report-job",
    onLog: (message) => logs.push(message),
  });

  assert.equal(attempts, 3);
  assert.equal(result.similarity, "99%");
  assert.equal(result.artifacts.viewerPdf, undefined);
  assert.ok(
    logs.some((message) =>
      message.includes("Batas retry Current View PDF tercapai (3x)")
    )
  );
});

test("submitUsingPool keeps initial submission and current view follow-up in one authenticated session", async () => {
  const progress = [];
  let sessionCount = 0;
  const service = new TurnitinService({
    config: {
      maxSubmissionsPerAssignment: 2,
      maxAttemptsPerAssignment: 2,
      storage: {
        reportsDir: "/tmp/turnitin-test-reports",
      },
    },
    stateStore: {
      getSelectionHints() {
        return { classes: {} };
      },
      async recordSubmission() {},
      async setAccountSummary() {},
    },
  });
  const account = { email: "usable@example.com" };

  service.getAccounts = async () => [account];
  service.claimAvailableAccount = async () => account;
  service.releaseClaimedAccount = () => true;
  service.automation.withAuthenticatedSession = async (_account, _onLog, run) => {
    sessionCount += 1;
    return run({
      page: {},
      context: {},
    });
  };
  service.automation.submitWithAccountInSession = async () => ({
    status: "submitted",
    similarity: "51%",
    similarityStatus: "ready",
    accountEmail: account.email,
    className: "Class A",
    classUrl: "https://www.turnitin.com/class/1",
    assignmentName: "Assignment 1",
    assignmentKey: "assignment-1",
    assignmentUrl: "https://www.turnitin.com/assignment/1",
    reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=123",
    artifacts: {
      digitalReceipt: "/storage/reports/job/digital-receipt.pdf",
    },
  });
  service.waitForCurrentViewPdfInSession = async ({ result, onProgress }) => {
    const nextResult = {
      ...result,
      artifacts: {
        ...result.artifacts,
        viewerPdf: "/storage/reports/job/similarity-report.pdf",
      },
    };
    onProgress(nextResult);
    return nextResult;
  };

  const result = await service.submitUsingPool({
    filePath: "/tmp/document.pdf",
    originalName: "document.pdf",
    title: "document",
    reportOptions: {
      excludeQuotes: true,
    },
    jobId: "job-1",
    onProgress: (partialResult) => progress.push(partialResult),
  });

  assert.equal(sessionCount, 1);
  assert.equal(progress.length, 2);
  assert.equal(progress[0].similarity, "51%");
  assert.equal(progress[1].artifacts.viewerPdf, "/storage/reports/job/similarity-report.pdf");
  assert.equal(result.artifacts.viewerPdf, "/storage/reports/job/similarity-report.pdf");
});

test("waitForCurrentViewPdfInSession preserves dashboard similarity when filtered current view stays unavailable", async () => {
  const service = createService({
    similarityFollowUpWaitMs: 15 * 1000,
    currentViewFollowUpAttemptMs: 1000,
    currentViewMaxAttempts: 1,
  });

  service.automation.resumePendingSubmissionInSession = async () => ({
    similarity: null,
    similarityStatus: "ready",
    studioUrl: "/storage/reports/job/similarity-report.png",
    artifacts: {
      viewerScreenshot: "/storage/reports/job/similarity-report.png",
      viewerPdf: null,
    },
  });

  const result = await service.waitForCurrentViewPdfInSession({
    page: {},
    context: {},
    account: { email: "usable@example.com" },
    result: {
      status: "submitted",
      similarity: "80%",
      similarityStatus: "ready",
      className: "Class A",
      classUrl: "https://www.turnitin.com/class/1",
      assignmentName: "Assignment 1",
      assignmentUrl: "https://www.turnitin.com/assignment/1",
      reportOptions: {
        excludeQuotes: true,
        excludeBibliography: true,
        excludeMatches: false,
        excludeMatchesWordCount: 10,
      },
      artifacts: {
        digitalReceipt: "/storage/reports/job/digital-receipt.pdf",
      },
    },
    originalName: "document.pdf",
    reportOptions: {
      excludeQuotes: true,
      excludeBibliography: true,
      excludeMatches: false,
      excludeMatchesWordCount: 10,
    },
    reportDir: "/tmp/turnitin-test-reports/job",
    onLog() {},
    onProgress() {},
  });

  assert.equal(result.dashboardSimilarity, "80%");
  assert.equal(result.similarity, "80%");
  assert.equal(result.artifacts.viewerPdf, null);
  assert.equal(result.artifacts.viewerScreenshot, "/storage/reports/job/similarity-report.png");
});
