const fs = require("fs/promises");
const path = require("path");

const DEFAULT_STATE = {
  version: 2,
  updatedAt: null,
  accounts: {},
  submissions: [],
  payments: {},
};

const ASSIGNMENT_LOCAL_FIELDS = [
  "attemptCount",
  "successCount",
  "failureCount",
  "lastAttemptStatus",
  "lastAttemptAt",
  "lastSubmittedAt",
  "lastJobId",
  "reportUrl",
  "studioUrl",
];

const CLASS_LOCAL_FIELDS = ["nextAssignmentKey", "lastAssignmentKey", "lastAttemptAt"];
const ASSIGNMENT_HISTORY_FIELDS = [
  "attemptCount",
  "successCount",
  "failureCount",
  "lastAttemptStatus",
  "lastAttemptAt",
];
const CLASS_HISTORY_FIELDS = ["nextAssignmentKey", "lastAssignmentKey", "lastAttemptAt"];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function refreshSummaryCounts(summary) {
  const classes = Array.isArray(summary.classes) ? summary.classes : [];

  for (const classItem of classes) {
    const assignments = Array.isArray(classItem.assignments) ? classItem.assignments : [];
    classItem.totalAssignments = assignments.length;
    classItem.availableAssignments = assignments.filter(
      (assignment) => assignment.status === "available"
    ).length;
    classItem.usedAssignments = assignments.filter(
      (assignment) => assignment.status === "used"
    ).length;
  }

  summary.totals = {
    classes: classes.length,
    assignments: classes.reduce(
      (count, classItem) => count + (classItem.totalAssignments || 0),
      0
    ),
    available: classes.reduce(
      (count, classItem) => count + (classItem.availableAssignments || 0),
      0
    ),
    used: classes.reduce((count, classItem) => count + (classItem.usedAssignments || 0), 0),
  };
}

function copyLocalFields(source, target, fields) {
  if (!source || !target) {
    return;
  }

  for (const field of fields) {
    if (source[field] !== undefined) {
      target[field] = clone(source[field]);
    }
  }
}

function mergeSummaryHistory(previousSummary, nextSummary) {
  if (!previousSummary) {
    return clone(nextSummary);
  }

  const merged = clone(nextSummary);

  for (const classItem of merged.classes || []) {
    const previousClass = (previousSummary.classes || []).find(
      (entry) => entry.name === classItem.name
    );
    copyLocalFields(previousClass, classItem, CLASS_LOCAL_FIELDS);

    for (const assignment of classItem.assignments || []) {
      const previousAssignment = (previousClass?.assignments || []).find(
        (entry) => entry.key === assignment.key || entry.name === assignment.name
      );
      copyLocalFields(previousAssignment, assignment, ASSIGNMENT_LOCAL_FIELDS);
    }
  }

  refreshSummaryCounts(merged);
  return merged;
}

function findClass(summary, className) {
  return (summary?.classes || []).find((entry) => entry.name === className) || null;
}

function findAssignment(classItem, assignmentKey, assignmentName) {
  return (
    (classItem?.assignments || []).find(
      (entry) => entry.key === assignmentKey || entry.name === assignmentName
    ) || null
  );
}

function advanceClassPointer(classItem, assignmentKey) {
  if (!classItem?.assignments?.length) {
    return;
  }

  const index = classItem.assignments.findIndex((entry) => entry.key === assignmentKey);
  if (index < 0) {
    return;
  }

  const nextAssignment = classItem.assignments[(index + 1) % classItem.assignments.length];
  classItem.nextAssignmentKey = nextAssignment?.key || assignmentKey;
  classItem.lastAssignmentKey = assignmentKey;
}

function updateAssignmentAttempt(assignment, fields = {}) {
  assignment.attemptCount = Number(assignment.attemptCount || 0) + 1;
  assignment.successCount = Number(assignment.successCount || 0) + Number(fields.successCount || 0);
  assignment.failureCount = Number(assignment.failureCount || 0) + Number(fields.failureCount || 0);
  assignment.lastAttemptStatus = fields.lastAttemptStatus || assignment.lastAttemptStatus || null;
  assignment.lastAttemptAt = fields.lastAttemptAt || new Date().toISOString();
  assignment.lastJobId = fields.lastJobId || assignment.lastJobId || null;
}

function clearLocalHistory(summary) {
  for (const classItem of summary.classes || []) {
    for (const field of CLASS_LOCAL_FIELDS) {
      delete classItem[field];
    }

    for (const assignment of classItem.assignments || []) {
      for (const field of ASSIGNMENT_LOCAL_FIELDS) {
        delete assignment[field];
      }
    }
  }
}

function hasLocalHistory(summary) {
  for (const classItem of summary?.classes || []) {
    if (CLASS_HISTORY_FIELDS.some((field) => classItem[field] !== undefined)) {
      return true;
    }

    for (const assignment of classItem.assignments || []) {
      if (ASSIGNMENT_HISTORY_FIELDS.some((field) => assignment[field] !== undefined)) {
        return true;
      }
    }
  }

  return false;
}

function buildEmptyAccountSummary(account = {}) {
  return {
    accountEmail: account.email || "",
    accountSourceLine: account.sourceLine || null,
    scannedAt: null,
    totals: {
      classes: 0,
      assignments: 0,
      available: 0,
      used: 0,
    },
    classes: [],
    lastError: null,
  };
}

function normalizePaymentStatus(status) {
  return String(status || "pending")
    .trim()
    .toLowerCase() || "pending";
}

function isTerminalPaymentStatus(status) {
  return ["completed", "cancelled", "expired", "failed"].includes(
    normalizePaymentStatus(status)
  );
}

class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = clone(DEFAULT_STATE);
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.state = {
        ...clone(DEFAULT_STATE),
        ...JSON.parse(raw),
      };
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }

      await this.save();
    }

    this.rehydrateAccountSummariesFromSubmissions();
    this.rehydrateSelectionHistory();
    await this.save();
  }

  async save() {
    this.state.updatedAt = new Date().toISOString();
    await fs.writeFile(this.filePath, JSON.stringify(this.state, null, 2));
  }

  listAccountSummaries() {
    return Object.values(this.state.accounts).sort((left, right) =>
      String(left.accountEmail).localeCompare(String(right.accountEmail))
    );
  }

  projectAccountSummaries(accounts = []) {
    return accounts.map((account) => {
      const summary = clone(
        this.state.accounts[account.email] || buildEmptyAccountSummary(account)
      );
      summary.accountEmail = account.email;
      summary.accountSourceLine = account.sourceLine || summary.accountSourceLine || null;
      refreshSummaryCounts(summary);
      return summary;
    });
  }

  listRecentSubmissions(limit = 20) {
    return clone(this.state.submissions.slice(0, limit));
  }

  listPayments(limit = 50) {
    return Object.values(this.state.payments || {})
      .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))
      .slice(0, limit)
      .map((payment) => clone(payment));
  }

  listPendingPayments(limit = 100) {
    return this.listPayments(Number(limit) || 100).filter(
      (payment) => !isTerminalPaymentStatus(payment?.status)
    );
  }

  getPayment(orderId) {
    const payment = this.state.payments?.[String(orderId || "").trim()];
    return payment ? clone(payment) : null;
  }

  async setAccountSummary(summary) {
    this.state.accounts[summary.accountEmail] = mergeSummaryHistory(
      this.state.accounts[summary.accountEmail],
      summary
    );
    await this.save();
  }

  async setAccountSummaries(summaries) {
    for (const summary of summaries) {
      this.state.accounts[summary.accountEmail] = mergeSummaryHistory(
        this.state.accounts[summary.accountEmail],
        summary
      );
    }

    await this.save();
  }

  getSelectionHints(accountEmail) {
    const summary = this.state.accounts[accountEmail];
    if (!summary) {
      return { classes: {} };
    }

    const classes = {};
    for (const classItem of summary.classes || []) {
      classes[classItem.name] = {
        nextAssignmentKey: classItem.nextAssignmentKey || null,
        assignments: Object.fromEntries(
          (classItem.assignments || []).map((assignment) => [
            assignment.key,
            {
              attemptCount: Number(assignment.attemptCount || 0),
              successCount: Number(assignment.successCount || 0),
              failureCount: Number(assignment.failureCount || 0),
              lastAttemptStatus: assignment.lastAttemptStatus || null,
              lastAttemptAt:
                assignment.lastAttemptAt || assignment.lastSubmittedAt || null,
              lastJobId: assignment.lastJobId || null,
            },
          ])
        ),
      };
    }

    return { classes };
  }

  rehydrateAccountSummariesFromSubmissions() {
    const orderedSubmissions = [...this.state.submissions].sort((left, right) =>
      String(left.finishedAt || "").localeCompare(String(right.finishedAt || ""))
    );

    for (const submission of orderedSubmissions) {
      if (!submission?.accountEmail || !submission?.accountSummary) {
        continue;
      }

      this.state.accounts[submission.accountEmail] = mergeSummaryHistory(
        this.state.accounts[submission.accountEmail],
        {
          ...submission.accountSummary,
          accountEmail: submission.accountEmail,
        }
      );
    }
  }

  rehydrateSelectionHistory() {
    const accountEmailsToBackfill = Object.entries(this.state.accounts)
      .filter(([, summary]) => !hasLocalHistory(summary))
      .map(([accountEmail]) => accountEmail);
    const accountEmailSet = new Set(accountEmailsToBackfill);

    for (const accountEmail of accountEmailsToBackfill) {
      clearLocalHistory(this.state.accounts[accountEmail]);
    }

    const orderedSubmissions = [...this.state.submissions]
      .filter(
        (submission) =>
          submission?.accountEmail &&
          submission?.className &&
          accountEmailSet.has(submission.accountEmail)
      )
      .sort((left, right) =>
        String(left.finishedAt || "").localeCompare(String(right.finishedAt || ""))
      );

    for (const submission of orderedSubmissions) {
      const summary = this.state.accounts[submission.accountEmail];
      const classItem = findClass(summary, submission.className);
      const assignment = findAssignment(
        classItem,
        submission.assignmentKey,
        submission.assignmentName
      );
      if (!summary || !classItem || !assignment) {
        continue;
      }

      assignment.status = "used";
      assignment.similarity = submission.similarity || assignment.similarity || null;
      assignment.reportUrl = submission.reportUrl || assignment.reportUrl || null;
      assignment.studioUrl = submission.studioUrl || assignment.studioUrl || null;
      assignment.lastSubmittedAt = submission.finishedAt || assignment.lastSubmittedAt || null;
      updateAssignmentAttempt(assignment, {
        successCount: 1,
        lastAttemptStatus: "submitted",
        lastAttemptAt: submission.finishedAt,
        lastJobId: submission.jobId,
      });
      advanceClassPointer(classItem, assignment.key);
      classItem.lastAttemptAt = assignment.lastAttemptAt;
    }

    for (const accountEmail of accountEmailsToBackfill) {
      const summary = this.state.accounts[accountEmail];
      refreshSummaryCounts(summary);
    }
  }

  async recordAssignmentFailure({
    accountEmail,
    className,
    assignmentKey,
    assignmentName,
    jobId,
    attemptedAt,
  }) {
    const summary = this.state.accounts[accountEmail];
    const classItem = findClass(summary, className);
    const assignment = findAssignment(classItem, assignmentKey, assignmentName);
    if (!summary || !classItem || !assignment) {
      return null;
    }

    updateAssignmentAttempt(assignment, {
      failureCount: 1,
      lastAttemptStatus: "failed",
      lastAttemptAt: attemptedAt,
      lastJobId: jobId,
    });
    classItem.nextAssignmentKey = assignment.key;
    classItem.lastAssignmentKey = assignment.key;
    classItem.lastAttemptAt = assignment.lastAttemptAt;
    summary.scannedAt = new Date().toISOString();
    refreshSummaryCounts(summary);
    await this.save();

    return clone({
      assignmentKey: assignment.key,
      attemptCount: assignment.attemptCount,
      successCount: assignment.successCount,
      failureCount: assignment.failureCount,
      lastAttemptStatus: assignment.lastAttemptStatus,
      lastAttemptAt: assignment.lastAttemptAt,
    });
  }

  async recordSubmission(result) {
    this.state.submissions.unshift(clone(result));
    this.state.submissions = this.state.submissions.slice(0, 50);

    if (result.accountSummary) {
      this.state.accounts[result.accountEmail] = mergeSummaryHistory(
        this.state.accounts[result.accountEmail],
        {
          ...result.accountSummary,
          accountEmail: result.accountEmail,
        }
      );
    }

    const summary = this.state.accounts[result.accountEmail];
    if (summary) {
      const classItem = findClass(summary, result.className);
      const assignment = findAssignment(
        classItem,
        result.assignmentKey,
        result.assignmentName
      );
      if (classItem && assignment) {
        assignment.status = "used";
        assignment.similarity = result.similarity || assignment.similarity || null;
        assignment.reportUrl = result.reportUrl || assignment.reportUrl || null;
        assignment.studioUrl = result.studioUrl || assignment.studioUrl || null;
        assignment.lastSubmittedAt = result.finishedAt || new Date().toISOString();
        updateAssignmentAttempt(assignment, {
          successCount: 1,
          lastAttemptStatus: "submitted",
          lastAttemptAt: result.finishedAt,
          lastJobId: result.jobId,
        });
        advanceClassPointer(classItem, assignment.key);
        classItem.lastAttemptAt = assignment.lastAttemptAt;
      }

      summary.scannedAt = new Date().toISOString();
      refreshSummaryCounts(summary);
    }

    await this.save();
  }

  async upsertPayment(payment) {
    const orderId = String(payment?.orderId || "").trim();
    if (!orderId) {
      throw new Error("orderId pembayaran wajib diisi.");
    }

    const previous = this.state.payments[orderId] || null;
    this.state.payments[orderId] = {
      ...(previous ? clone(previous) : {}),
      ...clone(payment),
      orderId,
      status: normalizePaymentStatus(payment?.status || previous?.status || "pending"),
      createdAt: payment?.createdAt || previous?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.trimPayments();
    await this.save();
    return clone(this.state.payments[orderId]);
  }

  async updatePayment(orderId, updates = {}) {
    const normalizedOrderId = String(orderId || "").trim();
    if (!normalizedOrderId) {
      throw new Error("orderId pembayaran wajib diisi.");
    }

    const existing = this.state.payments[normalizedOrderId];
    if (!existing) {
      throw new Error(`Pembayaran ${normalizedOrderId} tidak ditemukan.`);
    }

    this.state.payments[normalizedOrderId] = {
      ...clone(existing),
      ...clone(updates),
      orderId: normalizedOrderId,
      status: normalizePaymentStatus(updates?.status || existing.status || "pending"),
      createdAt: existing.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.trimPayments();
    await this.save();
    return clone(this.state.payments[normalizedOrderId]);
  }

  trimPayments(limit = 200) {
    const entries = Object.entries(this.state.payments || {});
    if (entries.length <= limit) {
      return;
    }

    const removable = entries
      .map(([orderId, payment]) => ({
        orderId,
        payment,
      }))
      .filter((entry) => isTerminalPaymentStatus(entry.payment?.status))
      .sort((left, right) =>
        String(left.payment?.updatedAt || left.payment?.createdAt || "").localeCompare(
          String(right.payment?.updatedAt || right.payment?.createdAt || "")
        )
      );

    for (const entry of removable) {
      if (Object.keys(this.state.payments || {}).length <= limit) {
        break;
      }
      delete this.state.payments[entry.orderId];
    }
  }
}

module.exports = {
  StateStore,
};
