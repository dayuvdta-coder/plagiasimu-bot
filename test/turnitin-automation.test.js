const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { TurnitinAutomation } = require("../src/services/turnitin-automation");

function createAutomation(overrides = {}) {
  return new TurnitinAutomation({
    defaultExcludeMatchesWordCount: 10,
    maxAttemptsPerAssignment: 3,
    maxSubmissionsPerAssignment: 2,
    similarityPollIntervalMs: 5000,
    reportArtifactsRefreshMs: 5000,
    reportArtifactsWaitMs: 30 * 1000,
    ...overrides,
  });
}

test("getBrowserLaunchOptions disables Chromium sandbox when configured off", () => {
  const automation = createAutomation({
    headless: true,
    chromiumSandbox: false,
  });

  assert.deepEqual(automation.getBrowserLaunchOptions(), {
    headless: true,
    chromiumSandbox: false,
    args: ["--no-sandbox"],
  });
});

test("getBrowserLaunchOptions keeps Chromium sandbox enabled by default", () => {
  const automation = createAutomation({
    headless: false,
    chromiumSandbox: true,
  });

  assert.deepEqual(automation.getBrowserLaunchOptions(), {
    headless: false,
    chromiumSandbox: true,
    args: [],
  });
});

test("normalizeReportOptions keeps default exclude matches threshold", () => {
  const automation = createAutomation();
  const result = automation.normalizeReportOptions({
    excludeQuotes: true,
    excludeBibliography: false,
    excludeMatches: true,
  });

  assert.equal(result.excludeQuotes, true);
  assert.equal(result.excludeBibliography, false);
  assert.equal(result.excludeMatches, true);
  assert.equal(result.excludeMatchesWordCount, 10);
});

test("normalizeReportOptions keeps custom exclude matches threshold when valid", () => {
  const automation = createAutomation();
  const result = automation.normalizeReportOptions({
    excludeMatches: true,
    excludeMatchesWordCount: 14,
  });

  assert.equal(result.excludeMatches, true);
  assert.equal(result.excludeMatchesWordCount, 14);
});

test("normalizeReportOptions tolerates null payloads", () => {
  const automation = createAutomation();
  const result = automation.normalizeReportOptions(null);

  assert.equal(result.excludeQuotes, false);
  assert.equal(result.excludeBibliography, false);
  assert.equal(result.excludeMatches, false);
  assert.equal(result.excludeMatchesWordCount, 10);
});

test("orderAssignmentsForSelection skips save to repository assignments", () => {
  const automation = createAutomation();
  const ordered = automation.orderAssignmentsForSelection([
    {
      name: "A. Originality Check - Save to Repository for Copyright",
      key: "assignment-a",
      rawText: "A. Originality Check - Save to Repository for Copyright",
    },
    {
      name: "1. Originality Check - No Repository",
      key: "assignment-1",
      rawText: "1. Originality Check - No Repository",
    },
  ]);

  assert.deepEqual(
    ordered.map((assignment) => assignment.key),
    ["assignment-1"]
  );
});

test("orderAssignmentsForSelection skips assignments that already reached local usage limit", () => {
  const automation = createAutomation();
  const ordered = automation.orderAssignmentsForSelection(
    [
      {
        name: "Assignment 1",
        key: "assignment-1",
        rawText: "Assignment 1 Open",
      },
      {
        name: "Assignment 2",
        key: "assignment-2",
        rawText: "Assignment 2 Open",
      },
    ],
    {
      assignments: {
        "assignment-1": {
          successCount: 2,
        },
        "assignment-2": {
          successCount: 1,
        },
      },
    }
  );

  assert.deepEqual(
    ordered.map((assignment) => assignment.key),
    ["assignment-2"]
  );
});

test("isTransientNavigationError marks reset errors as retryable", () => {
  const automation = createAutomation();
  assert.equal(
    automation.isTransientNavigationError(
      new Error("page.goto: net::ERR_CONNECTION_RESET at https://www.turnitin.com/")
    ),
    true
  );
});

test("isRetryableLoginBootstrapError retries login surface timeout", () => {
  const automation = createAutomation();
  assert.equal(
    automation.isRetryableLoginBootstrapError(
      new Error("Halaman login Turnitin tidak siap setelah menunggu challenge.")
    ),
    true
  );
});

test("looksLikeTurnitinReportText recognizes Turnitin report markers", () => {
  const automation = createAutomation();
  assert.equal(
    automation.looksLikeTurnitinReportText(`
      ORIGINALITY REPORT
      96% SIMILARITY INDEX
      PRIMARY SOURCES
      Submission ID: 2897030641
    `),
    true
  );
});

test("extractTurnitinReportSimilarity reads spaced percentage from current view text", () => {
  const automation = createAutomation();
  assert.equal(
    automation.extractTurnitinReportSimilarity(`
      ORIGINALITY REPORT
      51
      %
      SIMILARITY INDEX
    `),
    "51%"
  );
});

test("looksLikeTurnitinReportText rejects original thesis content", () => {
  const automation = createAutomation();
  assert.equal(
    automation.looksLikeTurnitinReportText(`
      SKRIPSI
      PENGARUH PERSEPSI HARGA, KUALITAS PRODUK DAN PERSAINGAN
      ALIPIYAH NUR AZIZAH
    `),
    false
  );
});

test("extractViewerPaperId reads paper id from Feedback Studio URL", () => {
  const automation = createAutomation();
  assert.equal(
    automation.extractViewerPaperId(
      "https://ev.turnitin.com/app/carta/en_us/?u=1196058493&ro=103&student_user=1&o=2896835337&lang=en_us&s=1"
    ),
    "2896835337"
  );
});

test("extractViewerPaperId returns null for invalid viewer URL", () => {
  const automation = createAutomation();
  assert.equal(automation.extractViewerPaperId("chrome-error://chromewebdata/"), null);
});

test("buildCurrentViewExportName uses original name, similarity, and short job id", () => {
  const automation = createAutomation();
  assert.equal(
    automation.buildCurrentViewExportName({
      sourcePath: "/tmp/similarity-report.pdf",
      originalName: "SKRIPSI ALIPIYAH NUR AZIZAH.pdf",
      similarity: "99%",
      jobId: "c8784b66-89c4-4c3b-aab9-96b5a78af1e6",
    }),
    "SKRIPSI-ALIPIYAH-NUR-AZIZAH--99pct--c8784b66.pdf"
  );
});

test("findSimilarityScoreLink prefers a visible similarity link with percentage text", async () => {
  const automation = createAutomation();
  const genericLink = {
    isVisible: async () => true,
    evaluate: async () => "View Similarity matches in Feedback Studio",
    locator() {
      return {
        innerText: async () => "Paper without percentage",
      };
    },
  };
  const scoreLink = {
    isVisible: async () => true,
    evaluate: async () => "100%. View Similarity matches in Feedback Studio",
    locator() {
      return {
        innerText: async () => "Paper title 100%",
      };
    },
  };
  const page = {
    locator(selector) {
      if (selector === 'a.similarity-open, a[title*="Similarity matches" i]') {
        return {
          count: async () => 2,
          nth(index) {
            return index === 0 ? genericLink : scoreLink;
          },
        };
      }

      throw new Error(`Unexpected selector ${selector}`);
    },
  };

  const result = await automation.findSimilarityScoreLink(page);
  assert.equal(result, scoreLink);
});

test("resolveViewerReferenceUrl falls back to reportUrl when popup URL has no paper id", () => {
  const automation = createAutomation();
  assert.equal(
    automation.resolveViewerReferenceUrl({
      viewerPage: {
        url() {
          return "https://ev.turnitin.com/app/carta/en_us/";
        },
      },
      reportUrl:
        "https://ev.turnitin.com/app/carta/en_us/?o=2897050579&ro=103&student_user=1&lang=en_us&u=1196058493&s=1",
    }),
    "https://ev.turnitin.com/app/carta/en_us/?o=2897050579&ro=103&student_user=1&lang=en_us&u=1196058493&s=1"
  );
});

test("isCompletePdfResponse ignores partial range PDF responses", () => {
  const automation = createAutomation();

  assert.equal(
    automation.isCompletePdfResponse({
      headers() {
        return {
          "content-type": "application/pdf",
          "content-range": "bytes 0-65535/5953757",
        };
      },
      status() {
        return 206;
      },
      url() {
        return "https://viewer.example/similarity-report.pdf";
      },
    }),
    false
  );

  assert.equal(
    automation.isCompletePdfResponse({
      headers() {
        return {
          "content-type": "application/pdf",
        };
      },
      status() {
        return 200;
      },
      url() {
        return "https://viewer.example/similarity-report.pdf";
      },
    }),
    true
  );
});

test("waitForSimilarity refreshes using configured poll interval", async () => {
  const automation = createAutomation();
  const waits = [];
  const logs = [];
  let attempts = 0;

  automation.extractSimilarity = async () => {
    attempts += 1;
    return attempts >= 3 ? "96%" : null;
  };

  const result = await automation.waitForSimilarity(
    {
      waitForTimeout: async (ms) => {
        waits.push(ms);
      },
      reload: async () => {},
    },
    (message) => logs.push(message),
    20 * 1000
  );

  assert.equal(result, "96%");
  assert.deepEqual(waits, [5000, 1200, 5000, 1200]);
  assert.equal(
    logs.filter((message) => message.includes("tunggu 5 detik lalu refresh.")).length,
    2
  );
});

test("waitForSubmissionSignals keeps refreshing until dashboard similarity appears", async () => {
  const automation = createAutomation();
  const waits = [];
  const logs = [];
  let checks = 0;
  let similarityChecks = 0;

  automation.extractSimilarity = async () => {
    similarityChecks += 1;
    return similarityChecks >= 3 ? "51%" : null;
  };
  automation.inspectAssignmentArtifactSurface = async () => {
    checks += 1;
    return checks >= 2
      ? {
          hasDownload: false,
          hasReceipt: true,
          hasViewer: false,
          reportUrl: null,
        }
      : {
          hasDownload: false,
          hasReceipt: false,
          hasViewer: false,
          reportUrl: null,
        };
  };

  const result = await automation.waitForSubmissionSignals(
    {
      waitForTimeout: async (ms) => {
        waits.push(ms);
      },
      url: () =>
        "https://www.turnitin.com/assignment/type/paper/dashboard/1?lang=en_us",
      goto: async () => {},
      reload: async () => {},
    },
    {
      assignmentUrl: "https://www.turnitin.com/assignment/type/paper/dashboard/1?lang=en_us",
      onLog: (message) => logs.push(message),
      timeoutMs: 20 * 1000,
    }
  );

  assert.equal(result.similarity, "51%");
  assert.equal(result.surface.hasReceipt, true);
  assert.deepEqual(waits, [5000, 1200, 5000, 1200]);
  assert.ok(
    logs.some((message) =>
      message.includes("Permukaan report sudah muncul, tetap tunggu angka similarity di dashboard.")
    )
  );
  assert.ok(logs.some((message) => message.includes("Similarity terdeteksi: 51%")));
});

test("captureArtifacts reuses known similarity and extends artifact waiting for follow-up", async () => {
  const automation = createAutomation();
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-artifacts-"));
  const logs = [];
  let capturedArtifactTimeout = null;

  automation.hasViewerSessionCookie = async () => false;
  automation.waitForSimilarity = async () => {
    throw new Error("waitForSimilarity should not run when knownSimilarity is present");
  };
  automation.waitForAssignmentArtifactsReady = async (_page, options) => {
    capturedArtifactTimeout = options.timeoutMs;
    return {
      hasDownload: false,
      hasReceipt: false,
      hasViewer: false,
      reportUrl: null,
    };
  };
  automation.downloadAssignmentArtifacts = async () => ({});
  automation.openReportViewer = async () => ({
    viewerPage: null,
    reportUrl: null,
    closeViewerPage: false,
  });
  automation.resolveFinalSimilarity = async ({ similarity }) => similarity;

  try {
    const result = await automation.captureArtifacts({
      page: {
        screenshot: async () => {},
        url: () => "https://www.turnitin.com/assignment/type/paper/dashboard/179106902?lang=en_us",
        waitForTimeout: async () => {},
      },
      context: {},
      reportDir,
      assignmentUrl:
        "https://www.turnitin.com/assignment/type/paper/dashboard/179106902?lang=en_us",
      originalName: "document.pdf",
      reportOptions: {},
      knownSimilarity: "96%",
      similarityTimeoutMs: 48 * 60 * 1000,
      artifactWaitTimeoutMs: 48 * 60 * 1000,
      onLog: (message) => logs.push(message),
    });

    assert.equal(result.similarity, "96%");
    assert.equal(result.similarityStatus, "ready");
    assert.equal(capturedArtifactTimeout, 48 * 60 * 1000);
    assert.ok(
      logs.some((message) =>
        message.includes("Similarity sesi awal tetap dipakai (96%)")
      )
    );
  } finally {
    await fs.rm(reportDir, { recursive: true, force: true });
  }
});

test("captureArtifacts tries direct viewer PDF endpoint before reopening viewer when no viewer filters are requested", async () => {
  const automation = createAutomation();
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-artifacts-direct-"));
  const logs = [];
  let directDownloadCalls = 0;

  automation.waitForAssignmentArtifactsReady = async () => {
    throw new Error("waitForAssignmentArtifactsReady should be skipped when reportUrl is known");
  };
  automation.downloadAssignmentArtifacts = async () => {
    throw new Error("downloadAssignmentArtifacts should be skipped when artifacts already exist");
  };
  automation.hasViewerSessionCookie = async () => true;
  automation.applyViewerReportOptions = async () => ({
    excludeQuotes: false,
    excludeBibliography: false,
    excludeMatches: false,
    excludeMatchesWordCount: 10,
  });
  automation.downloadViewerPdfFromReportUrl = async ({ reportUrl, similarity, onLog }) => {
    directDownloadCalls += 1;
    assert.equal(reportUrl, "https://ev.turnitin.com/app/carta/en_us/?o=123");
    assert.equal(similarity, "96%");
    onLog("Current View PDF berhasil diunduh langsung dari endpoint viewer.");
    return "/storage/reports/job/similarity-report.pdf";
  };
  automation.openReportViewer = async () => {
    throw new Error("openReportViewer should not run when direct endpoint succeeds");
  };
  automation.resolveFinalSimilarity = async ({ similarity }) => similarity;

  try {
    const result = await automation.captureArtifacts({
      page: {
        screenshot: async () => {},
        url: () => "https://www.turnitin.com/assignment/type/paper/dashboard/179106902?lang=en_us",
        waitForTimeout: async () => {},
      },
      context: {},
      reportDir,
      assignmentUrl:
        "https://www.turnitin.com/assignment/type/paper/dashboard/179106902?lang=en_us",
      originalName: "document.pdf",
      reportOptions: {},
      knownSimilarity: "96%",
      knownReportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=123",
      existingArtifacts: {
        originalFile: "/storage/reports/job/document.pdf",
        digitalReceipt: "/storage/reports/job/digital-receipt.pdf",
        viewerScreenshot: "/storage/reports/job/similarity-report.png",
      },
      similarityTimeoutMs: 48 * 60 * 1000,
      artifactWaitTimeoutMs: 48 * 60 * 1000,
      onLog: (message) => logs.push(message),
    });

    assert.equal(directDownloadCalls, 1);
    assert.equal(result.artifacts.viewerPdf, "/storage/reports/job/similarity-report.pdf");
    assert.equal(
      result.artifacts.digitalReceipt,
      "/storage/reports/job/digital-receipt.pdf"
    );
    assert.ok(
      logs.some((message) =>
        message.includes("Current View PDF berhasil diunduh langsung dari endpoint viewer.")
      )
    );
  } finally {
    await fs.rm(reportDir, { recursive: true, force: true });
  }
});

test("captureArtifacts uses dashboard similarity and report url before opening viewer UI when no viewer filters are requested", async () => {
  const automation = createAutomation();
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-artifacts-dashboard-"));
  const logs = [];
  let appliedFilters = 0;
  let directDownloadCalls = 0;

  automation.waitForSubmissionSignals = async () => ({
    similarity: "51%",
    surface: {
      hasDownload: false,
      hasReceipt: true,
      hasViewer: false,
      reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=456",
    },
  });
  automation.downloadAssignmentArtifacts = async () => ({
    originalFile: "/storage/reports/job/document.pdf",
    digitalReceipt: "/storage/reports/job/digital-receipt.pdf",
  });
  automation.hasViewerSessionCookie = async () => true;
  automation.applyViewerReportOptions = async ({ viewerPage, reportUrl }) => {
    appliedFilters += 1;
    assert.equal(viewerPage, undefined);
    assert.equal(reportUrl, "https://ev.turnitin.com/app/carta/en_us/?o=456");
    return {
      excludeQuotes: false,
      excludeBibliography: false,
      excludeMatches: false,
      excludeMatchesWordCount: 10,
    };
  };
  automation.downloadViewerPdfFromReportUrl = async ({ reportUrl, similarity, onLog }) => {
    directDownloadCalls += 1;
    assert.equal(reportUrl, "https://ev.turnitin.com/app/carta/en_us/?o=456");
    assert.equal(similarity, "51%");
    onLog(
      "Current View PDF berhasil diunduh langsung setelah similarity muncul di dashboard."
    );
    return "/storage/reports/job/similarity-report.pdf";
  };
  automation.openReportViewer = async () => {
    throw new Error("openReportViewer should not run when dashboard similarity path succeeds");
  };
  automation.resolveFinalSimilarity = async ({ similarity }) => similarity;

  try {
    const result = await automation.captureArtifacts({
      page: {
        screenshot: async () => {},
        url: () => "https://www.turnitin.com/assignment/type/paper/dashboard/179106902?lang=en_us",
        waitForTimeout: async () => {},
      },
      context: {},
      reportDir,
      assignmentUrl:
        "https://www.turnitin.com/assignment/type/paper/dashboard/179106902?lang=en_us",
      originalName: "document.pdf",
      reportOptions: {},
      similarityTimeoutMs: 48 * 60 * 1000,
      artifactWaitTimeoutMs: 48 * 60 * 1000,
      onLog: (message) => logs.push(message),
    });

    assert.equal(appliedFilters, 1);
    assert.equal(directDownloadCalls, 1);
    assert.equal(result.similarity, "51%");
    assert.equal(result.artifacts.viewerPdf, "/storage/reports/job/similarity-report.pdf");
    assert.ok(
      logs.some((message) =>
        message.includes(
          "Current View PDF berhasil diunduh langsung setelah similarity muncul di dashboard."
        )
      )
    );
  } finally {
    await fs.rm(reportDir, { recursive: true, force: true });
  }
});

test("captureArtifacts waits for popup viewer bootstrap before downloading current view", async () => {
  const automation = createAutomation();
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-artifacts-bootstrap-"));
  const logs = [];
  let directDownloadCalls = 0;
  let openedViewer = 0;

  automation.waitForSubmissionSignals = async () => ({
    similarity: "96%",
    surface: {
      hasDownload: false,
      hasReceipt: true,
      hasViewer: true,
      reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=789",
    },
  });
  automation.downloadAssignmentArtifacts = async () => ({
    originalFile: "/storage/reports/job/document.pdf",
    digitalReceipt: "/storage/reports/job/digital-receipt.pdf",
  });
  automation.hasViewerSessionCookie = async () => false;
  automation.openReportViewer = async () => {
    openedViewer += 1;
    return {
      viewerPage: {
        url: () => "https://ev.turnitin.com/app/carta/en_us/?o=789",
        waitForTimeout: async () => {},
        close: async () => {},
      },
      reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=789",
      closeViewerPage: true,
    };
  };
  automation.waitForViewerBootstrap = async () => true;
  automation.applyViewerReportOptions = async ({ viewerPage, reportUrl }) => {
    assert.equal(typeof viewerPage.url, "function");
    assert.equal(reportUrl, "https://ev.turnitin.com/app/carta/en_us/?o=789");
    return {
      excludeQuotes: false,
      excludeBibliography: false,
      excludeMatches: false,
      excludeMatchesWordCount: 10,
    };
  };
  automation.downloadViewerPdfFromReportUrl = async ({ reportUrl, similarity, onLog }) => {
    directDownloadCalls += 1;
    assert.equal(reportUrl, "https://ev.turnitin.com/app/carta/en_us/?o=789");
    assert.equal(similarity, "96%");
    onLog("Current View PDF berhasil diunduh langsung setelah Feedback Studio terbuka.");
    return "/storage/reports/job/similarity-report.pdf";
  };
  automation.resolveFinalSimilarity = async ({ similarity }) => similarity;

  try {
    const result = await automation.captureArtifacts({
      page: {
        screenshot: async () => {},
        url: () => "https://www.turnitin.com/assignment/type/paper/dashboard/179106902?lang=en_us",
        waitForTimeout: async () => {},
      },
      context: {},
      reportDir,
      assignmentUrl:
        "https://www.turnitin.com/assignment/type/paper/dashboard/179106902?lang=en_us",
      originalName: "document.pdf",
      reportOptions: {},
      similarityTimeoutMs: 48 * 60 * 1000,
      artifactWaitTimeoutMs: 48 * 60 * 1000,
      onLog: (message) => logs.push(message),
    });

    assert.equal(openedViewer, 1);
    assert.equal(directDownloadCalls, 1);
    assert.equal(result.artifacts.viewerPdf, "/storage/reports/job/similarity-report.pdf");
    assert.ok(
      logs.some((message) =>
        message.includes(
          "Current View PDF berhasil diunduh langsung setelah Feedback Studio terbuka."
        )
      )
    );
  } finally {
    await fs.rm(reportDir, { recursive: true, force: true });
  }
});

test("captureArtifacts prefers queue current view after popup viewer bootstrap when no viewer filters are requested", async () => {
  const automation = createAutomation();
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-artifacts-queue-"));
  const logs = [];
  let queueDownloadCalls = 0;

  automation.waitForSubmissionSignals = async () => ({
    similarity: "96%",
    surface: {
      hasDownload: false,
      hasReceipt: true,
      hasViewer: true,
      reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=789",
    },
  });
  automation.downloadAssignmentArtifacts = async () => ({
    originalFile: "/storage/reports/job/document.pdf",
    digitalReceipt: "/storage/reports/job/digital-receipt.pdf",
  });
  automation.hasViewerSessionCookie = async () => false;
  automation.openReportViewer = async () => ({
    viewerPage: {
      url: () => "https://ev.turnitin.com/app/carta/en_us/?o=789",
      waitForTimeout: async () => {},
      close: async () => {},
    },
    reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=789",
    closeViewerPage: true,
  });
  automation.waitForViewerBootstrap = async () => true;
  automation.applyViewerReportOptions = async () => ({
    excludeQuotes: false,
    excludeBibliography: false,
    excludeMatches: false,
    excludeMatchesWordCount: 10,
  });
  automation.downloadQueuedViewerPdfFromReportUrl = async ({ reportUrl, similarity, onLog }) => {
    queueDownloadCalls += 1;
    assert.equal(reportUrl, "https://ev.turnitin.com/app/carta/en_us/?o=789");
    assert.equal(similarity, "96%");
    onLog("Current View PDF berhasil diunduh dari queue Feedback Studio.");
    return "/storage/reports/job/similarity-report.pdf";
  };
  automation.downloadViewerPdfFromReportUrl = async () => {
    throw new Error("downloadViewerPdfFromReportUrl should be skipped when queue download succeeds");
  };
  automation.resolveFinalSimilarity = async ({ similarity }) => similarity;

  try {
    const result = await automation.captureArtifacts({
      page: {
        screenshot: async () => {},
        url: () => "https://www.turnitin.com/assignment/type/paper/dashboard/179106902?lang=en_us",
        waitForTimeout: async () => {},
      },
      context: {
        request: {},
      },
      reportDir,
      assignmentUrl:
        "https://www.turnitin.com/assignment/type/paper/dashboard/179106902?lang=en_us",
      originalName: "document.pdf",
      reportOptions: {},
      similarityTimeoutMs: 48 * 60 * 1000,
      artifactWaitTimeoutMs: 48 * 60 * 1000,
      onLog: (message) => logs.push(message),
    });

    assert.equal(queueDownloadCalls, 1);
    assert.equal(result.artifacts.viewerPdf, "/storage/reports/job/similarity-report.pdf");
    assert.ok(
      logs.some((message) =>
        message.includes("Current View PDF berhasil diunduh dari queue Feedback Studio.")
      )
    );
  } finally {
    await fs.rm(reportDir, { recursive: true, force: true });
  }
});

test("captureArtifacts prefers viewer-driven download when viewer filters are requested", async () => {
  const automation = createAutomation();
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-artifacts-filtered-"));
  const logs = [];
  let openViewerCalls = 0;
  let menuDownloadCalls = 0;

  automation.waitForSubmissionSignals = async () => ({
    similarity: "95%",
    surface: {
      hasDownload: false,
      hasReceipt: true,
      hasViewer: true,
      reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=789",
    },
  });
  automation.downloadAssignmentArtifacts = async () => ({
    originalFile: "/storage/reports/job/document.pdf",
    digitalReceipt: "/storage/reports/job/digital-receipt.pdf",
  });
  automation.hasViewerSessionCookie = async () => true;
  automation.openReportViewer = async () => {
    openViewerCalls += 1;
    return {
      viewerPage: {
        url: () => "https://ev.turnitin.com/app/carta/en_us/?o=789",
        waitForTimeout: async () => {},
        screenshot: async () => {},
        close: async () => {},
      },
      reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=789",
      closeViewerPage: true,
    };
  };
  automation.waitForViewerBootstrap = async () => true;
  automation.waitForViewerReady = async () => {};
  automation.applyViewerReportOptions = async ({ viewerPage, reportUrl }) => {
    assert.equal(typeof viewerPage.url, "function");
    assert.equal(reportUrl, "https://ev.turnitin.com/app/carta/en_us/?o=789");
    return {
      excludeQuotes: true,
      excludeBibliography: true,
      excludeMatches: true,
      excludeMatchesWordCount: 10,
    };
  };
  automation.downloadQueuedViewerPdfFromReportUrl = async () => {
    throw new Error("queue fast-path should be skipped when viewer filters are requested");
  };
  automation.downloadViewerPdfFromReportUrl = async () => {
    throw new Error("direct viewer endpoint should be skipped when viewer filters are requested");
  };
  automation.downloadViewerPdf = async ({ reportUrl, similarity, onLog }) => {
    menuDownloadCalls += 1;
    assert.equal(reportUrl, "https://ev.turnitin.com/app/carta/en_us/?o=789");
    assert.equal(similarity, "95%");
    onLog("Current View PDF berhasil diunduh dari queue viewer.");
    return "/storage/reports/job/similarity-report.pdf";
  };
  automation.resolveFinalSimilarity = async () => "37%";

  try {
    const result = await automation.captureArtifacts({
      page: {
        screenshot: async () => {},
        url: () => "https://www.turnitin.com/assignment/type/paper/dashboard/179106902?lang=en_us",
        waitForTimeout: async () => {},
      },
      context: {
        request: {},
      },
      reportDir,
      assignmentUrl:
        "https://www.turnitin.com/assignment/type/paper/dashboard/179106902?lang=en_us",
      originalName: "document.pdf",
      reportOptions: {
        excludeQuotes: true,
        excludeBibliography: true,
        excludeMatches: true,
      },
      similarityTimeoutMs: 48 * 60 * 1000,
      artifactWaitTimeoutMs: 48 * 60 * 1000,
      onLog: (message) => logs.push(message),
    });

    assert.equal(openViewerCalls, 1);
    assert.equal(menuDownloadCalls, 1);
    assert.equal(result.artifacts.viewerPdf, "/storage/reports/job/similarity-report.pdf");
    assert.equal(result.dashboardSimilarity, "95%");
    assert.equal(result.similarity, "37%");
    assert.ok(
      logs.some((message) =>
        message.includes("Current View PDF berhasil diunduh dari queue viewer.")
      )
    );
  } finally {
    await fs.rm(reportDir, { recursive: true, force: true });
  }
});

test("captureArtifacts discards stale viewer PDF when its filter states do not match and redownloads", async () => {
  const automation = createAutomation();
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-artifacts-stale-filter-"));
  const logs = [];
  let menuDownloadCalls = 0;

  automation.waitForSubmissionSignals = async () => ({
    similarity: "80%",
    surface: {
      hasDownload: false,
      hasReceipt: true,
      hasViewer: true,
      reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=999",
    },
  });
  automation.downloadAssignmentArtifacts = async () => ({
    originalFile: "/storage/reports/job/document.pdf",
    digitalReceipt: "/storage/reports/job/digital-receipt.pdf",
  });
  automation.readTurnitinReportPdfMetadata = async (pdfPath) => {
    if (pdfPath.endsWith("similarity-report.pdf")) {
      return {
        valid: true,
        similarity: "80%",
        filterStates: {
          excludeQuotes: false,
          excludeBibliography: false,
          excludeMatches: false,
          excludeMatchesWordCount: null,
        },
      };
    }
    return {
      valid: false,
      similarity: null,
      filterStates: {
        excludeQuotes: null,
        excludeBibliography: null,
        excludeMatches: null,
        excludeMatchesWordCount: null,
      },
    };
  };
  automation.hasViewerSessionCookie = async () => true;
  automation.openReportViewer = async () => ({
    viewerPage: {
      url: () => "https://ev.turnitin.com/app/carta/en_us/?o=999",
      waitForTimeout: async () => {},
      screenshot: async () => {},
      close: async () => {},
    },
    reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=999",
    closeViewerPage: true,
  });
  automation.waitForViewerBootstrap = async () => true;
  automation.waitForViewerReady = async () => {};
  automation.applyViewerReportOptions = async () => ({
    excludeQuotes: true,
    excludeBibliography: true,
    excludeMatches: true,
    excludeMatchesWordCount: 10,
  });
  automation.downloadViewerPdf = async ({ similarity, onLog }) => {
    menuDownloadCalls += 1;
    assert.equal(similarity, "80%");
    onLog("Current View PDF berhasil diunduh dari queue viewer.");
    return "/storage/reports/job/similarity-report.pdf";
  };
  automation.resolveFinalSimilarity = async ({ similarity }) => similarity;

  try {
    const result = await automation.captureArtifacts({
      page: {
        screenshot: async () => {},
        url: () => "https://www.turnitin.com/assignment/type/paper/dashboard/179106902?lang=en_us",
        waitForTimeout: async () => {},
      },
      context: {
        request: {},
      },
      reportDir,
      assignmentUrl:
        "https://www.turnitin.com/assignment/type/paper/dashboard/179106902?lang=en_us",
      originalName: "document.pdf",
      existingArtifacts: {
        viewerPdf: "/storage/reports/job/similarity-report.pdf",
      },
      reportOptions: {
        excludeQuotes: true,
        excludeBibliography: true,
        excludeMatches: true,
      },
      similarityTimeoutMs: 48 * 60 * 1000,
      artifactWaitTimeoutMs: 48 * 60 * 1000,
      onLog: (message) => logs.push(message),
    });

    assert.equal(menuDownloadCalls, 1);
    assert.equal(result.artifacts.viewerPdf, "/storage/reports/job/similarity-report.pdf");
    assert.ok(
      logs.some((message) =>
        message.includes("Current View PDF lama tidak cocok dengan filter yang diminta, unduh ulang.")
      )
    );
  } finally {
    await fs.rm(reportDir, { recursive: true, force: true });
  }
});

test("applyViewerReportOptions falls back to viewer UI when options payload is unavailable", async () => {
  const automation = createAutomation();
  const logs = [];
  let uiFallbackCalls = 0;

  automation.applyViewerReportOptionsInViewer = async ({ viewerPage, reportOptions, onLog }) => {
    uiFallbackCalls += 1;
    assert.equal(viewerPage.url(), "https://ev.turnitin.com/app/carta/en_us/?o=123");
    assert.equal(reportOptions.excludeQuotes, true);
    assert.equal(reportOptions.excludeBibliography, true);
    onLog("Fallback UI viewer dijalankan.");
    return true;
  };

  const result = await automation.applyViewerReportOptions({
    viewerPage: {
      url: () => "https://ev.turnitin.com/app/carta/en_us/?o=123",
    },
    context: {
      request: {
        get: async () => ({
          ok: () => true,
          json: async () => ({}),
        }),
      },
    },
    reportOptions: {
      excludeQuotes: true,
      excludeBibliography: true,
    },
    reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=123",
    onLog: (message) => logs.push(message),
  });

  assert.equal(uiFallbackCalls, 1);
  assert.equal(result.excludeQuotes, true);
  assert.ok(logs.some((message) => message.includes("Fallback UI viewer dijalankan.")));
  assert.ok(
    !logs.some((message) => message.includes("Payload opsi similarity viewer tidak tersedia"))
  );
});

test("applyViewerReportOptions captures filtered similarity from viewer options API", async () => {
  const automation = createAutomation();
  const requests = [];
  let getCallCount = 0;
  let firstGetHeaders = null;
  let putHeaders = null;

  const result = await automation.applyViewerReportOptions({
    viewerPage: {
      url: () => "https://ev.turnitin.com/app/carta/en_us/?o=123&lang=en_us",
      waitForTimeout: async () => {},
    },
    context: {
      request: {
        get: async (url, options = {}) => {
          requests.push(url);
          getCallCount += 1;
          if (!firstGetHeaders) {
            firstGetHeaders = options.headers || null;
          }
          return {
            ok: () => true,
            json: async () => ({
              OriginalityOptions: [
                {
                  exclude_quotes: getCallCount > 1 ? 1 : 0,
                  exclude_biblio: getCallCount > 1 ? 1 : 0,
                  exclude_small_matches: 0,
                },
              ],
            }),
          };
        },
        put: async (_url, options = {}) => {
          putHeaders = options.headers || null;
          return {
          ok: () => true,
          json: async () => ({
            report: {
              overlap: 75,
            },
          }),
          };
        },
      },
    },
    reportOptions: {
      excludeQuotes: true,
      excludeBibliography: true,
      excludeMatches: false,
    },
    reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=123&lang=en_us",
    onLog() {},
  });

  assert.equal(result.excludeQuotes, true);
  assert.equal(result.excludeBibliography, true);
  assert.equal(result.viewerSimilarity, "75%");
  assert.ok(requests.every((url) => /similarity\/options/i.test(url)));
  assert.equal(firstGetHeaders?.referer, "https://ev.turnitin.com/app/carta/en_us/?o=123&lang=en_us");
  assert.equal(firstGetHeaders?.["x-requested-with"], "XMLHttpRequest");
  assert.equal(firstGetHeaders?.["x-palladium"], "1");
  assert.equal(putHeaders?.referer, "https://ev.turnitin.com/app/carta/en_us/?o=123&lang=en_us");
  assert.equal(putHeaders?.["content-type"], "application/json");
});

test("applyViewerReportOptions falls back to browser-context fetch when APIRequestContext fails", async () => {
  const automation = createAutomation();
  let getCallCount = 0;
  let putCallCount = 0;

  const result = await automation.applyViewerReportOptions({
    viewerPage: {
      url: () => "https://ev.turnitin.com/app/carta/en_us/?o=123&lang=en_us",
      waitForTimeout: async () => {},
      evaluate: async (_pageFunction, args) => {
        if (args.requestMethod === "GET") {
          getCallCount += 1;
          return {
            ok: true,
            status: 200,
            headers: {
              "content-type": "application/json; charset=utf-8",
            },
            text: JSON.stringify({
              OriginalityOptions: [
                {
                  exclude_quotes: getCallCount > 1 ? 1 : 0,
                  exclude_biblio: getCallCount > 1 ? 1 : 0,
                  exclude_small_matches: 0,
                },
              ],
              ...(getCallCount > 1
                ? {
                    report: {
                      overlap: 15,
                    },
                  }
                : {}),
            }),
          };
        }

        putCallCount += 1;
        return {
          ok: true,
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
          },
          text: JSON.stringify({
            report: {
              overlap: 15,
            },
          }),
        };
      },
    },
    context: {
      request: {
        get: async () => null,
        put: async () => null,
      },
    },
    reportOptions: {
      excludeQuotes: true,
      excludeBibliography: true,
      excludeMatches: false,
    },
    reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=123&lang=en_us",
    onLog() {},
  });

  assert.equal(putCallCount, 1);
  assert.equal(getCallCount >= 2, true);
  assert.equal(result.viewerSimilarity, "15%");
  assert.equal(result.viewerFiltersConfirmed, true);
});

test("applyViewerReportOptions retries similarity options endpoint before falling back", async () => {
  const automation = createAutomation();
  let getCallCount = 0;
  let uiFallbackCalls = 0;

  automation.applyViewerReportOptionsInViewer = async () => {
    uiFallbackCalls += 1;
    return true;
  };
  automation.waitForViewerReportOptionsSync = async () => ({
    currentOptions: {
      exclude_quotes: 1,
      exclude_biblio: 1,
      exclude_small_matches: 0,
    },
    viewerSimilarity: "44%",
  });

  const result = await automation.applyViewerReportOptions({
    viewerPage: {
      url: () => "https://ev.turnitin.com/app/carta/en_us/?o=123&lang=en_us",
      waitForTimeout: async () => {},
    },
    context: {
      request: {
        get: async () => {
          getCallCount += 1;
          if (getCallCount < 3) {
            return null;
          }
          return {
            ok: () => true,
            json: async () => ({
              OriginalityOptions: [
                {
                  exclude_quotes: 0,
                  exclude_biblio: 0,
                  exclude_small_matches: 0,
                },
              ],
            }),
          };
        },
        put: async () => ({
          ok: () => true,
          json: async () => ({
            report: {
              overlap: 44,
            },
          }),
        }),
      },
    },
    reportOptions: {
      excludeQuotes: true,
      excludeBibliography: true,
      excludeMatches: false,
    },
    reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=123&lang=en_us",
    onLog() {},
  });

  assert.equal(getCallCount, 3);
  assert.equal(uiFallbackCalls, 0);
  assert.equal(result.viewerSimilarity, "44%");
  assert.equal(result.viewerFiltersConfirmed, true);
});

test("downloadQueuedViewerPdfFromReportUrl polls queue until PDF buffer is ready", async () => {
  const automation = createAutomation({
    currentViewQueueTimeoutMs: 5 * 1000,
  });
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-viewer-queue-"));
  let pollCount = 0;

  automation.saveValidatedViewerPdf = async ({ pdfPath, pdfBuffer }) => {
    assert.equal(pdfPath, path.join(reportDir, "similarity-report.pdf"));
    assert.equal(pdfBuffer.subarray(0, 5).toString(), "%PDF-");
    return pdfPath;
  };

  try {
    const result = await automation.downloadQueuedViewerPdfFromReportUrl({
      context: {
        request: {
          post: async () => ({
            status: () => 202,
            ok: () => false,
            text: async () =>
              JSON.stringify({
                ready: 0,
                url: "https://ev.turnitin.com/student/paper/123/queue_pdf/sas:abc?lang=en_us",
              }),
            headers: () => ({}),
          }),
          get: async () => {
            pollCount += 1;
            if (pollCount === 1) {
              return {
                status: () => 200,
                headers: () => ({
                  "content-length": "0",
                }),
                body: async () => Buffer.alloc(0),
              };
            }

            return {
              status: () => 200,
              headers: () => ({
                "content-type": "application/pdf",
              }),
              body: async () => Buffer.from("%PDF-1.4\nqueued report"),
            };
          },
        },
      },
      reportDir,
      originalName: "document.pdf",
      similarity: "96%",
      reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=123&lang=en_us",
      failureLog: null,
      successLog: null,
    });

    assert.equal(
      result,
      `/storage/reports/${path.basename(reportDir)}/similarity-report.pdf`
    );
    assert.equal(pollCount, 2);
  } finally {
    await fs.rm(reportDir, { recursive: true, force: true });
  }
});

test("downloadQueuedViewerPdfFromReportUrl follows ready queue URL before downloading PDF", async () => {
  const automation = createAutomation({
    currentViewQueueTimeoutMs: 5 * 1000,
    currentViewDownloadTimeoutMs: 60 * 1000,
  });
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-viewer-queue-ready-"));
  const requestedUrls = [];

  automation.saveValidatedViewerPdf = async ({ pdfPath, pdfBuffer }) => {
    assert.equal(pdfPath, path.join(reportDir, "similarity-report.pdf"));
    assert.equal(pdfBuffer.subarray(0, 5).toString(), "%PDF-");
    return pdfPath;
  };

  try {
    const result = await automation.downloadQueuedViewerPdfFromReportUrl({
      context: {
        request: {
          post: async () => ({
            status: () => 202,
            ok: () => false,
            text: async () =>
              JSON.stringify({
                ready: 0,
                url: "https://ev.turnitin.com/student/paper/123/queue_pdf/sas:abc?lang=en_us",
              }),
            headers: () => ({}),
          }),
          get: async (url) => {
            requestedUrls.push(url);
            if (/ready=1/i.test(url)) {
              return {
                ok: () => true,
                headers: () => ({
                  "content-type": "application/pdf",
                }),
                body: async () => Buffer.from("%PDF-1.4\nqueued ready report"),
              };
            }

            return {
              status: () => 200,
              headers: () => ({
                "content-type": "application/json",
              }),
              body: async () =>
                Buffer.from(
                  JSON.stringify({
                    ready: 1,
                    url: "https://ev.turnitin.com/student/paper/123/queue_pdf/sas:abc?ready=1&lang=en_us",
                  })
                ),
            };
          },
        },
      },
      reportDir,
      originalName: "document.pdf",
      similarity: "96%",
      reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=123&lang=en_us",
      failureLog: null,
      successLog: null,
    });

    assert.equal(
      result,
      `/storage/reports/${path.basename(reportDir)}/similarity-report.pdf`
    );
    assert.ok(requestedUrls.some((url) => /ready=1/i.test(url)));
  } finally {
    await fs.rm(reportDir, { recursive: true, force: true });
  }
});

test("downloadQueuedViewerPdfFromReportUrl forwards expected viewer filters to immediate PDF URLs", async () => {
  const automation = createAutomation();
  const expectedReportOptions = {
    excludeQuotes: true,
    excludeBibliography: true,
    excludeMatches: false,
    excludeMatchesWordCount: 10,
  };
  let forwardedOptions = null;

  automation.fetchViewerPdfFromResolvedUrl = async ({ pdfUrl, expectedReportOptions: options }) => {
    assert.equal(pdfUrl, "https://ev.turnitin.com/download/report.pdf");
    forwardedOptions = options;
    return "/storage/reports/job/similarity-report.pdf";
  };

  const result = await automation.downloadQueuedViewerPdfFromReportUrl({
    context: {
      request: {
        post: async () => ({
          status: () => 202,
          ok: () => false,
          text: async () =>
            JSON.stringify({
              url: "https://ev.turnitin.com/download/report.pdf",
            }),
          headers: () => ({}),
        }),
      },
    },
    reportDir: "/tmp/report-dir",
    originalName: "document.pdf",
    expectedReportOptions,
    reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=123&lang=en_us",
    failureLog: null,
    successLog: null,
  });

  assert.equal(result, "/storage/reports/job/similarity-report.pdf");
  assert.deepEqual(forwardedOptions, expectedReportOptions);
});

test("downloadQueuedViewerPdfFromReportUrl forwards expected viewer filters to nested PDF URLs", async () => {
  const automation = createAutomation();
  const expectedReportOptions = {
    excludeQuotes: true,
    excludeBibliography: true,
    excludeMatches: false,
    excludeMatchesWordCount: 10,
  };
  let forwardedOptions = null;

  automation.fetchViewerPdfFromResolvedUrl = async ({ pdfUrl, expectedReportOptions: options }) => {
    assert.equal(pdfUrl, "https://cdn.turnitin.test/report.pdf");
    forwardedOptions = options;
    return "/storage/reports/job/similarity-report.pdf";
  };

  const result = await automation.downloadQueuedViewerPdfFromReportUrl({
    context: {
      request: {
        post: async () => ({
          status: () => 202,
          ok: () => false,
          text: async () =>
            JSON.stringify({
              data: {
                files: [
                  {
                    href: "https://cdn.turnitin.test/report.pdf",
                  },
                ],
              },
            }),
          headers: () => ({}),
        }),
      },
    },
    reportDir: "/tmp/report-dir",
    originalName: "document.pdf",
    expectedReportOptions,
    reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=123&lang=en_us",
    failureLog: null,
    successLog: null,
  });

  assert.equal(result, "/storage/reports/job/similarity-report.pdf");
  assert.deepEqual(forwardedOptions, expectedReportOptions);
});

test("resumePendingSubmissionInSession reuses current browser session before relogin", async () => {
  const automation = createAutomation();
  const calls = [];

  automation.login = async () => {
    calls.push("login");
  };
  automation.ensureEnglish = async () => {
    calls.push("english");
  };
  automation.openExistingAssignment = async () => {
    calls.push("open");
  };
  automation.captureArtifacts = async () => {
    calls.push("capture");
    return {
      similarity: "96%",
      similarityStatus: "ready",
      reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=123",
      studioUrl: "/storage/reports/job/similarity-report.pdf",
      artifacts: {
        viewerPdf: "/storage/reports/job/similarity-report.pdf",
      },
    };
  };

  const result = await automation.resumePendingSubmissionInSession({
    page: {
      url: () => "https://www.turnitin.com/assignment/1",
    },
    context: {},
    account: {
      email: "user@example.com",
      password: "secret",
    },
    classUrl: "https://www.turnitin.com/class/1",
    assignmentUrl: "https://www.turnitin.com/assignment/1",
    className: "Class A",
    assignmentName: "Assignment 1",
    originalName: "document.pdf",
    reportOptions: {},
    reportDir: "/tmp/report-job",
    knownSimilarity: "96%",
    waitTimeoutMs: 15 * 1000,
    forceLogin: false,
  });

  assert.deepEqual(calls, ["open", "capture"]);
  assert.equal(result.artifacts.viewerPdf, "/storage/reports/job/similarity-report.pdf");
});

test("downloadPageArtifact reuses existing file when requested", async () => {
  const automation = createAutomation();
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-page-artifact-"));
  const targetPath = path.join(reportDir, "digital-receipt.pdf");
  await fs.writeFile(targetPath, "existing");

  const page = {
    locator() {
      throw new Error("page.locator should not run when existing artifact is reused");
    },
  };

  try {
    const reusedPath = await automation.downloadPageArtifact(page, "button", targetPath, {
      reuseExisting: true,
      label: "digital receipt",
    });
    assert.equal(reusedPath, targetPath);
  } finally {
    await fs.rm(reportDir, { recursive: true, force: true });
  }
});

test("saveValidatedViewerPdf rejects PDF that matches the original submission file", async () => {
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-viewer-pdf-"));
  const automation = new TurnitinAutomation({
    ...createAutomation().config,
    storage: {},
  });
  const logs = [];
  const duplicatePdf = Buffer.from("%PDF-1.4\nsame uploaded source pdf\n");
  const originalFilePath = path.join(reportDir, "uploaded.pdf");
  const pdfPath = path.join(reportDir, "similarity-report.pdf");

  await fs.writeFile(originalFilePath, duplicatePdf);
  automation.readTurnitinReportPdfMetadata = async () => ({
    valid: true,
    isPdf: true,
    readable: true,
    similarity: null,
  });

  try {
    const result = await automation.saveValidatedViewerPdf({
      pdfPath,
      pdfBuffer: duplicatePdf,
      originalFilePath,
      onLog: (message) => logs.push(message),
      sourceLabel: "endpoint fallback",
    });

    assert.equal(result, null);
    await assert.rejects(fs.stat(pdfPath));
    assert.ok(logs.some((message) => message.includes("identik dengan file submission asli")));
  } finally {
    await fs.rm(reportDir, { recursive: true, force: true });
  }
});

test("saveValidatedViewerPdf rejects truncated PDF response", async () => {
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-viewer-pdf-"));
  const automation = new TurnitinAutomation({
    ...createAutomation().config,
    storage: {},
  });
  const logs = [];
  const pdfPath = path.join(reportDir, "similarity-report.pdf");

  try {
    const result = await automation.saveValidatedViewerPdf({
      pdfPath,
      pdfBuffer: Buffer.from("%PDF-1.4\ntruncated viewer response"),
      onLog: (message) => logs.push(message),
      sourceLabel: "response PDF viewer",
    });

    assert.equal(result, null);
    await assert.rejects(fs.stat(pdfPath));
    assert.ok(logs.some((message) => message.includes("tidak lengkap atau tidak bisa dibuka")));
  } finally {
    await fs.rm(reportDir, { recursive: true, force: true });
  }
});

test("saveValidatedViewerPdf rejects PDF when requested viewer filters are not reflected in the report", async () => {
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-viewer-pdf-"));
  const automation = new TurnitinAutomation({
    ...createAutomation().config,
    storage: {},
  });
  const logs = [];
  const pdfPath = path.join(reportDir, "similarity-report.pdf");

  automation.readTurnitinReportPdfMetadata = async () => ({
    valid: true,
    isPdf: true,
    readable: true,
    similarity: "80%",
    filterStates: {
      excludeQuotes: false,
      excludeBibliography: false,
      excludeMatches: false,
      excludeMatchesWordCount: null,
    },
  });

  try {
    const result = await automation.saveValidatedViewerPdf({
      pdfPath,
      pdfBuffer: Buffer.from("%PDF-1.4\nfake filtered response"),
      expectedReportOptions: {
        excludeQuotes: true,
        excludeBibliography: true,
        excludeMatches: false,
        excludeMatchesWordCount: 10,
      },
      onLog: (message) => logs.push(message),
      sourceLabel: "queue viewer",
    });

    assert.equal(result, null);
    await assert.rejects(fs.stat(pdfPath));
    assert.ok(
      logs.some((message) => message.includes("belum mengikuti filter viewer yang diminta"))
    );
  } finally {
    await fs.rm(reportDir, { recursive: true, force: true });
  }
});

test("saveValidatedViewerPdf keeps valid report when viewer filters were not confirmed and PDF metadata has no filter state", async () => {
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-viewer-pdf-"));
  const automation = new TurnitinAutomation({
    ...createAutomation().config,
    storage: {},
  });
  const logs = [];
  const pdfPath = path.join(reportDir, "similarity-report.pdf");

  automation.readTurnitinReportPdfMetadata = async () => ({
    valid: true,
    isPdf: true,
    readable: true,
    similarity: "80%",
    filterStates: {
      excludeQuotes: null,
      excludeBibliography: null,
      excludeMatches: null,
      excludeMatchesWordCount: null,
    },
  });
  automation.exportCurrentViewCopy = async () => {};

  try {
    const expectedReportOptions = {
      excludeQuotes: true,
      excludeBibliography: true,
      excludeMatches: false,
      excludeMatchesWordCount: 10,
    };
    Object.defineProperty(expectedReportOptions, "viewerFiltersConfirmed", {
      value: false,
      enumerable: false,
      configurable: true,
      writable: true,
    });

    const result = await automation.saveValidatedViewerPdf({
      pdfPath,
      pdfBuffer: Buffer.from("%PDF-1.4\nfake filtered response"),
      expectedReportOptions,
      onLog: (message) => logs.push(message),
      sourceLabel: "queue viewer",
    });

    assert.equal(result, pdfPath);
    assert.equal(logs.some((message) => message.includes("belum mengikuti filter viewer")), false);
  } finally {
    await fs.rm(reportDir, { recursive: true, force: true });
  }
});
