const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { StateStore } = require("../src/services/state-store");

async function createStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-state-store-"));
  const filePath = path.join(dir, "state.json");
  const store = new StateStore(filePath);
  await store.init();
  return { store, dir };
}

function buildSummary() {
  return {
    accountEmail: "tester@example.com",
    partial: false,
    scannedAt: "2026-03-08T01:00:00.000Z",
    totals: {
      classes: 1,
      assignments: 2,
      available: 2,
      used: 0,
    },
    classes: [
      {
        name: "Class A",
        url: "https://example.com/class-a",
        totalAssignments: 2,
        availableAssignments: 2,
        usedAssignments: 0,
        assignments: [
          {
            name: "Assignment 1",
            key: "assignment-1",
            similarity: null,
            status: "available",
            rawText: "Assignment 1 Open",
          },
          {
            name: "Assignment 2",
            key: "assignment-2",
            similarity: null,
            status: "available",
            rawText: "Assignment 2 Open",
          },
        ],
      },
    ],
  };
}

test("recordAssignmentFailure keeps pointer on the same assignment", async () => {
  const { store, dir } = await createStore();
  await store.setAccountSummary(buildSummary());

  const failureInfo = await store.recordAssignmentFailure({
    accountEmail: "tester@example.com",
    className: "Class A",
    assignmentKey: "assignment-1",
    assignmentName: "Assignment 1",
    jobId: "job-failed",
    attemptedAt: "2026-03-08T01:10:00.000Z",
  });

  const hints = store.getSelectionHints("tester@example.com");
  assert.equal(failureInfo.attemptCount, 1);
  assert.equal(failureInfo.failureCount, 1);
  assert.equal(hints.classes["Class A"].nextAssignmentKey, "assignment-1");
  assert.equal(hints.classes["Class A"].assignments["assignment-1"].attemptCount, 1);

  await fs.rm(dir, { recursive: true, force: true });
});

test("recordSubmission advances pointer and preserves local history on refresh", async () => {
  const { store, dir } = await createStore();
  await store.setAccountSummary(buildSummary());

  await store.recordSubmission({
    status: "submitted",
    jobId: "job-success",
    finishedAt: "2026-03-08T01:20:00.000Z",
    accountEmail: "tester@example.com",
    className: "Class A",
    assignmentName: "Assignment 1",
    assignmentKey: "assignment-1",
    similarity: "12%",
    similarityStatus: "ready",
    reportUrl: "https://example.com/report",
    studioUrl: "/storage/reports/job-success/similarity-report.pdf",
    artifacts: {
      viewerPdf: "/storage/reports/job-success/similarity-report.pdf",
    },
  });

  let hints = store.getSelectionHints("tester@example.com");
  assert.equal(hints.classes["Class A"].nextAssignmentKey, "assignment-2");
  assert.equal(hints.classes["Class A"].assignments["assignment-1"].successCount, 1);
  assert.equal(hints.classes["Class A"].assignments["assignment-1"].attemptCount, 1);

  const refreshedSummary = buildSummary();
  refreshedSummary.scannedAt = "2026-03-08T01:30:00.000Z";
  refreshedSummary.classes[0].assignments[0].status = "used";
  refreshedSummary.classes[0].assignments[0].similarity = "12%";
  await store.setAccountSummary(refreshedSummary);

  hints = store.getSelectionHints("tester@example.com");
  assert.equal(hints.classes["Class A"].nextAssignmentKey, "assignment-2");
  assert.equal(hints.classes["Class A"].assignments["assignment-1"].successCount, 1);

  const savedSummary = store.listAccountSummaries()[0];
  assert.equal(savedSummary.classes[0].assignments[0].studioUrl, "/storage/reports/job-success/similarity-report.pdf");

  await fs.rm(dir, { recursive: true, force: true });
});

test("projectAccountSummaries follows configured account file order and adds unscanned accounts", async () => {
  const { store, dir } = await createStore();
  await store.setAccountSummary(buildSummary());

  const projected = store.projectAccountSummaries([
    {
      email: "new@example.com",
      sourceLine: 1,
    },
    {
      email: "tester@example.com",
      sourceLine: 2,
    },
  ]);

  assert.deepEqual(
    projected.map((entry) => entry.accountEmail),
    ["new@example.com", "tester@example.com"]
  );
  assert.equal(projected[0].scannedAt, null);
  assert.equal(projected[0].totals.classes, 0);
  assert.equal(projected[0].accountSourceLine, 1);
  assert.equal(projected[1].classes[0].name, "Class A");

  await fs.rm(dir, { recursive: true, force: true });
});

test("init backfills missing account summaries from saved submissions", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-state-store-"));
  const filePath = path.join(dir, "state.json");
  const summary = buildSummary();

  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        version: 1,
        updatedAt: "2026-03-08T01:00:00.000Z",
        accounts: {},
        submissions: [
          {
            status: "submitted",
            jobId: "job-success",
            finishedAt: "2026-03-08T01:20:00.000Z",
            accountEmail: "tester@example.com",
            className: "Class A",
            assignmentName: "Assignment 1",
            assignmentKey: "assignment-1",
            similarity: "12%",
            similarityStatus: "ready",
            reportUrl: "https://example.com/report",
            studioUrl: "/storage/reports/job-success/similarity-report.pdf",
            artifacts: {
              viewerPdf: "/storage/reports/job-success/similarity-report.pdf",
            },
            accountSummary: {
              ...summary,
              partial: true,
            },
          },
        ],
      },
      null,
      2
    )
  );

  const store = new StateStore(filePath);
  await store.init();

  const projected = store.projectAccountSummaries([
    {
      email: "tester@example.com",
      sourceLine: 1,
    },
  ]);

  assert.equal(projected[0].totals.classes, 1);
  assert.equal(projected[0].classes[0].name, "Class A");
  assert.equal(projected[0].classes[0].assignments[0].status, "used");
  assert.equal(projected[0].classes[0].assignments[0].similarity, "12%");

  await fs.rm(dir, { recursive: true, force: true });
});
