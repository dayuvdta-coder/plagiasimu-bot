const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const {
  doesPdfMatchRequestedReportOptions,
  extractTurnitinReportFilterStatesFromText,
  extractTurnitinReportSimilarityFromText,
  hasCurrentViewPdf,
  isLikelyViewerUrl,
  looksLikeTurnitinReportText,
  pickCurrentViewUrl,
  pickStudioUrl,
  sanitizeResultArtifacts,
} = require("../src/services/report-links");

function createMinimalPdfBuffer(text = "Hello PDF") {
  const streamContent = `BT\n/F1 12 Tf\n72 120 Td\n(${text}) Tj\nET\n`;
  const lines = [
    "%PDF-1.4",
    "1 0 obj",
    "<< /Type /Catalog /Pages 2 0 R >>",
    "endobj",
    "2 0 obj",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "endobj",
    "3 0 obj",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>",
    "endobj",
    "4 0 obj",
    `<< /Length ${Buffer.byteLength(streamContent, "utf8")} >>`,
    "stream",
    streamContent.trimEnd(),
    "endstream",
    "endobj",
  ];

  const offsets = [];
  let body = "";
  for (const line of lines) {
    if (/^\d+ \d+ obj$/.test(line)) {
      offsets.push(Buffer.byteLength(body, "utf8"));
    }
    body += `${line}\n`;
  }

  const xrefOffset = Buffer.byteLength(body, "utf8");
  body += "xref\n";
  body += `0 ${offsets.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += "trailer\n";
  body += `<< /Size ${offsets.length + 1} /Root 1 0 R >>\n`;
  body += "startxref\n";
  body += `${xrefOffset}\n`;
  body += "%%EOF\n";
  return Buffer.from(body, "utf8");
}

test("pickStudioUrl prefers local PDF artifact", () => {
  const result = pickStudioUrl({
    reportUrl: "https://www.turnitin.com/viewer/report/123",
    artifacts: {
      viewerScreenshot: "/storage/reports/job/similarity-report.png",
      viewerPdf: "/storage/reports/job/similarity-report.pdf",
    },
  });

  assert.equal(result, "/storage/reports/job/similarity-report.pdf");
});

test("pickStudioUrl falls back to screenshot then report URL", () => {
  const screenshotResult = pickStudioUrl({
    reportUrl: "https://www.turnitin.com/viewer/report/123",
    artifacts: {
      viewerScreenshot: "/storage/reports/job/similarity-report.png",
    },
  });
  const reportResult = pickStudioUrl({
    reportUrl: "https://www.turnitin.com/viewer/report/123",
    artifacts: {},
  });

  assert.equal(screenshotResult, "/storage/reports/job/similarity-report.png");
  assert.equal(reportResult, "https://www.turnitin.com/viewer/report/123");
});

test("pickCurrentViewUrl prefers viewer PDF over screenshot or remote viewer", () => {
  const result = pickCurrentViewUrl({
    studioUrl: "/storage/reports/job/similarity-report.png",
    reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=123",
    artifacts: {
      viewerPdf: "/storage/reports/job/similarity-report.pdf",
    },
  });

  assert.equal(result, "/storage/reports/job/similarity-report.pdf");
});

test("hasCurrentViewPdf only returns true for PDF current view", () => {
  assert.equal(
    hasCurrentViewPdf({
      studioUrl: "/storage/reports/job/similarity-report.pdf",
      artifacts: {},
    }),
    true
  );
  assert.equal(
    hasCurrentViewPdf({
      studioUrl: "/storage/reports/job/similarity-report.png",
      reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=123",
      artifacts: {},
    }),
    false
  );
});

test("isLikelyViewerUrl ignores help pages and accepts viewer URLs", () => {
  assert.equal(isLikelyViewerUrl("https://www.turnitin.com/viewer/report/123"), true);
  assert.equal(
    isLikelyViewerUrl("https://ev.turnitin.com/app/carta/en_us/?u=1&ro=103&o=123&lang=en_us&s=1"),
    true
  );
  assert.equal(
    isLikelyViewerUrl("https://guides.turnitin.com/hc/en-us/articles/123456789"),
    false
  );
  assert.equal(isLikelyViewerUrl("chrome-error://chromewebdata/"), false);
});

test("looksLikeTurnitinReportText recognizes Turnitin markers", () => {
  assert.equal(
    looksLikeTurnitinReportText(`
      ORIGINALITY REPORT
      96% SIMILARITY INDEX
      PRIMARY SOURCES
      Submission ID: 123456
    `),
    true
  );
});

test("looksLikeTurnitinReportText recognizes metadata-only viewer cover pages", () => {
  assert.equal(
    looksLikeTurnitinReportText(`
      Filter Compare All On
      by Andi Nugroho
      Submission date: 09-Mar-2026 10:30PM (UTC+0900)
      Submission ID: 2898579776
      File name: c0afb17b6e2787be36863703d864a24c (2.29M)
      Word count: 23367
      Character count: 153253
    `),
    true
  );
});

test("extractTurnitinReportSimilarityFromText reads similarity from current view text", () => {
  assert.equal(
    extractTurnitinReportSimilarityFromText(`
      punyaku
      ORIGINALITY REPORT

      51

      %
      SIMILARITY INDEX
    `),
    "51%"
  );
});

test("extractTurnitinReportSimilarityFromText prefers report similarity over source percentages", () => {
  assert.equal(
    extractTurnitinReportSimilarityFromText(`
      NASKAH_PUBLIKASI_ILMIAH
      ORIGINALITY REPORT
      100
      100%
      %
      SIMILARITY INDEX
      INTERNET SOURCES
      32%
      42%
      PUBLICATIONS
      STUDENT PAPERS
      PRIMARY SOURCES
    `),
    "100%"
  );
});

test("extractTurnitinReportFilterStatesFromText reads current view filter states", () => {
  assert.deepEqual(
    extractTurnitinReportFilterStatesFromText(`
      Exclude quotes
      On
      Exclude bibliography
      On
      Exclude matches < 10 words
      Off
    `),
    {
      excludeQuotes: true,
      excludeBibliography: true,
      excludeMatches: false,
      excludeMatchesWordCount: 10,
    }
  );
});

test("extractTurnitinReportFilterStatesFromText reads threshold-only exclude matches state as enabled", () => {
  assert.deepEqual(
    extractTurnitinReportFilterStatesFromText(`
      Exclude quotes
      On
      Exclude bibliography
      On
      Exclude matches
      < 10 words
    `),
    {
      excludeQuotes: true,
      excludeBibliography: true,
      excludeMatches: true,
      excludeMatchesWordCount: 10,
    }
  );
});

test("doesPdfMatchRequestedReportOptions rejects mismatched filter states", () => {
  assert.equal(
    doesPdfMatchRequestedReportOptions(
      {
        filterStates: {
          excludeQuotes: false,
          excludeBibliography: false,
          excludeMatches: false,
          excludeMatchesWordCount: null,
        },
      },
      {
        excludeQuotes: true,
        excludeBibliography: true,
        excludeMatches: true,
        excludeMatchesWordCount: 10,
      }
    ),
    false
  );
});

test("sanitizeResultArtifacts removes missing local viewer PDF and falls back to report URL", async () => {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-report-links-"));
  const sanitized = await sanitizeResultArtifacts(
    {
      similarity: "99%",
      studioUrl: "/storage/reports/job/similarity-report.pdf",
      reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=123",
      artifacts: {
        viewerPdf: "/storage/reports/job/similarity-report.pdf",
        viewerScreenshot: "/storage/reports/job/similarity-report.png",
      },
    },
    { storageDir }
  );

  assert.equal(sanitized.artifacts.viewerPdf, undefined);
  assert.equal(sanitized.studioUrl, "/storage/reports/job/similarity-report.png");
  assert.equal(sanitized.dashboardSimilarity, "99%");
  assert.equal(sanitized.similarity, "99%");
});

test("sanitizeResultArtifacts removes local PDF when similarity report markers are unreadable", async () => {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-report-links-"));
  const reportsDir = path.join(storageDir, "reports", "job");
  await fs.mkdir(reportsDir, { recursive: true });
  await fs.writeFile(
    path.join(reportsDir, "similarity-report.pdf"),
    createMinimalPdfBuffer("Fallback current view")
  );

  const sanitized = await sanitizeResultArtifacts(
    {
      studioUrl: "/storage/reports/job/similarity-report.pdf",
      reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=123",
      artifacts: {
        viewerPdf: "/storage/reports/job/similarity-report.pdf",
        viewerScreenshot: "/storage/reports/job/similarity-report.png",
      },
    },
    { storageDir }
  );

  assert.equal(sanitized.artifacts.viewerPdf, undefined);
  assert.equal(sanitized.studioUrl, "/storage/reports/job/similarity-report.png");
  assert.equal(sanitized.currentViewSimilarity, null);

  await fs.rm(storageDir, { recursive: true, force: true });
});

test("sanitizeResultArtifacts removes truncated local PDF fallback", async () => {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-report-links-"));
  const reportsDir = path.join(storageDir, "reports", "job");
  await fs.mkdir(reportsDir, { recursive: true });
  await fs.writeFile(
    path.join(reportsDir, "similarity-report.pdf"),
    Buffer.from("%PDF-1.4\ntruncated viewer response")
  );

  const sanitized = await sanitizeResultArtifacts(
    {
      studioUrl: "/storage/reports/job/similarity-report.pdf",
      reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=123",
      artifacts: {
        viewerPdf: "/storage/reports/job/similarity-report.pdf",
        viewerScreenshot: "/storage/reports/job/similarity-report.png",
      },
    },
    { storageDir }
  );

  assert.equal(sanitized.artifacts.viewerPdf, undefined);
  assert.equal(sanitized.studioUrl, "/storage/reports/job/similarity-report.png");

  await fs.rm(storageDir, { recursive: true, force: true });
});

test("sanitizeResultArtifacts drops viewer PDF when it matches the original submission file", async () => {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-report-links-"));
  const reportsDir = path.join(storageDir, "reports", "job");
  await fs.mkdir(reportsDir, { recursive: true });
  const duplicatePdf = Buffer.from("%PDF-1.4\nsame uploaded source pdf\n");
  await fs.writeFile(path.join(reportsDir, "uploaded.pdf"), duplicatePdf);
  await fs.writeFile(path.join(reportsDir, "similarity-report.pdf"), duplicatePdf);

  const sanitized = await sanitizeResultArtifacts(
    {
      studioUrl: "/storage/reports/job/similarity-report.pdf",
      reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=123",
      artifacts: {
        originalFile: "/storage/reports/job/uploaded.pdf",
        viewerPdf: "/storage/reports/job/similarity-report.pdf",
        viewerScreenshot: "/storage/reports/job/similarity-report.png",
      },
    },
    { storageDir }
  );

  assert.equal(sanitized.artifacts.viewerPdf, undefined);
  assert.equal(sanitized.studioUrl, "/storage/reports/job/similarity-report.png");

  await fs.rm(storageDir, { recursive: true, force: true });
});

test("sanitizeResultArtifacts drops viewer PDF when requested filter states do not match", async () => {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-report-links-"));
  const reportsDir = path.join(storageDir, "reports", "job");
  await fs.mkdir(reportsDir, { recursive: true });
  await fs.writeFile(
    path.join(reportsDir, "similarity-report.pdf"),
    createMinimalPdfBuffer(
      "Originality Report Submission ID: 123 Exclude quotes Off Exclude bibliography Off Exclude matches Off"
    )
  );

  const sanitized = await sanitizeResultArtifacts(
    {
      similarity: "63%",
      dashboardSimilarity: "100%",
      reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=123",
      studioUrl: "/storage/reports/job/similarity-report.pdf",
      reportOptions: {
        excludeQuotes: true,
        excludeBibliography: true,
        excludeMatches: true,
        excludeMatchesWordCount: 10,
      },
      artifacts: {
        viewerPdf: "/storage/reports/job/similarity-report.pdf",
        viewerScreenshot: "/storage/reports/job/similarity-report.png",
      },
    },
    { storageDir }
  );

  assert.equal(sanitized.artifacts.viewerPdf, undefined);
  assert.equal(sanitized.studioUrl, "/storage/reports/job/similarity-report.png");
  assert.equal(sanitized.dashboardSimilarity, "100%");
  assert.equal(sanitized.currentViewSimilarity, null);
  assert.equal(sanitized.similarity, null);

  await fs.rm(storageDir, { recursive: true, force: true });
});

test("sanitizeResultArtifacts keeps dashboard similarity as fallback when filtered current view is unavailable", async () => {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-report-links-"));

  const sanitized = await sanitizeResultArtifacts(
    {
      similarity: "80%",
      reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=123",
      studioUrl: "/storage/reports/job/similarity-report.png",
      reportOptions: {
        excludeQuotes: true,
        excludeBibliography: true,
        excludeMatches: false,
        excludeMatchesWordCount: 10,
      },
      artifacts: {
        viewerScreenshot: "/storage/reports/job/similarity-report.png",
      },
    },
    { storageDir }
  );

  assert.equal(sanitized.dashboardSimilarity, "80%");
  assert.equal(sanitized.currentViewSimilarity, null);
  assert.equal(sanitized.similarity, null);

  await fs.rm(storageDir, { recursive: true, force: true });
});

test("sanitizeResultArtifacts keeps provided current view similarity for filtered jobs without local PDF", async () => {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-report-links-"));

  const sanitized = await sanitizeResultArtifacts(
    {
      similarity: "75%",
      currentViewSimilarity: "75%",
      dashboardSimilarity: "80%",
      reportUrl: "https://ev.turnitin.com/app/carta/en_us/?o=123",
      studioUrl: "/storage/reports/job/similarity-report.png",
      reportOptions: {
        excludeQuotes: true,
        excludeBibliography: true,
        excludeMatches: false,
        excludeMatchesWordCount: 10,
      },
      artifacts: {
        viewerScreenshot: "/storage/reports/job/similarity-report.png",
      },
    },
    { storageDir }
  );

  assert.equal(sanitized.dashboardSimilarity, "80%");
  assert.equal(sanitized.currentViewSimilarity, null);
  assert.equal(sanitized.similarity, null);

  await fs.rm(storageDir, { recursive: true, force: true });
});

test("sanitizeResultArtifacts restores local current view PDF from studioUrl when artifact field is missing", async () => {
  const sanitized = await sanitizeResultArtifacts(
    {
      studioUrl: "/storage/reports/job/similarity-report.pdf",
      artifacts: {},
    }
  );

  assert.equal(sanitized.artifacts.viewerPdf, "/storage/reports/job/similarity-report.pdf");
  assert.equal(sanitized.studioUrl, "/storage/reports/job/similarity-report.pdf");
});
