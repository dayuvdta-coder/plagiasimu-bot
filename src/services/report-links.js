const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const pdfValidationCache = new Map();

async function hasPdfSignature(filePath) {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(5);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.toString("ascii", 0, bytesRead) === "%PDF-";
    } finally {
      await handle.close();
    }
  } catch (error) {
    return false;
  }
}

async function isReadablePdf(filePath) {
  try {
    await execFileAsync("pdfinfo", [filePath], {
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return hasPdfSignature(filePath);
    }

    return false;
  }
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fsSync.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function areFilesByteIdentical(firstPath, secondPath) {
  if (!firstPath || !secondPath) {
    return false;
  }

  const resolvedFirst = path.resolve(firstPath);
  const resolvedSecond = path.resolve(secondPath);
  if (resolvedFirst === resolvedSecond) {
    return true;
  }

  let firstStats = null;
  let secondStats = null;
  try {
    [firstStats, secondStats] = await Promise.all([fs.stat(resolvedFirst), fs.stat(resolvedSecond)]);
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }

  if (firstStats.size !== secondStats.size) {
    return false;
  }

  const [firstHash, secondHash] = await Promise.all([
    hashFile(resolvedFirst),
    hashFile(resolvedSecond),
  ]);
  return firstHash === secondHash;
}

function normalizeReportText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function getTurnitinTextMarkers(text) {
  const normalized = normalizeReportText(text);
  const classicMarkers = [
    /originality report/i,
    /similarity index/i,
    /primary sources/i,
    /submission id:/i,
    /exclude quotes/i,
    /exclude bibliography/i,
  ];
  const coverPageMarkers = [
    /submission date:/i,
    /submission id:/i,
    /file name:/i,
    /word count:/i,
    /character count:/i,
  ];

  return {
    normalized,
    classicMarkerHits: classicMarkers.filter((pattern) => pattern.test(normalized)).length,
    coverPageHits: coverPageMarkers.filter((pattern) => pattern.test(normalized)).length,
  };
}

function hasExplicitTurnitinFilterStates(filterStates = {}) {
  return ["excludeQuotes", "excludeBibliography", "excludeMatches"].some(
    (key) => filterStates[key] !== null && filterStates[key] !== undefined
  );
}

function pickStudioUrl({ reportUrl = null, artifacts = {} } = {}) {
  return artifacts.viewerPdf || artifacts.viewerScreenshot || reportUrl || null;
}

function pickCurrentViewUrl({ studioUrl = null, reportUrl = null, artifacts = {} } = {}) {
  return artifacts.viewerPdf || studioUrl || reportUrl || null;
}

function hasCurrentViewPdf({ studioUrl = null, reportUrl = null, artifacts = {} } = {}) {
  const currentViewUrl = pickCurrentViewUrl({
    studioUrl,
    reportUrl,
    artifacts,
  });
  return /\.pdf(?:$|\?)/i.test(String(currentViewUrl || ""));
}

function isLikelyViewerUrl(value) {
  const text = String(value || "").trim();
  if (!text) {
    return false;
  }

  return (
    /turnitin\.com/i.test(text) &&
    (/feedback|viewer|report|paper/i.test(text) ||
      /\/app\/carta\//i.test(text) ||
      /[?&]o=\d+/i.test(text)) &&
    !/guides\.turnitin\.com|help\.turnitin\.com|forumbee/i.test(text)
  );
}

function looksLikeTurnitinReportText(text) {
  const { normalized, classicMarkerHits, coverPageHits } = getTurnitinTextMarkers(text);
  if (!normalized) {
    return false;
  }
  if (classicMarkerHits >= 2) {
    return true;
  }
  return /submission id:/i.test(normalized) && coverPageHits >= 4;
}

function isIncompleteTurnitinReportText(text) {
  const { normalized, classicMarkerHits, coverPageHits } = getTurnitinTextMarkers(text);
  if (!normalized) {
    return false;
  }

  const metadataOnlyCover =
    /submission id:/i.test(normalized) &&
    coverPageHits >= 4 &&
    classicMarkerHits < 2;
  if (!metadataOnlyCover) {
    return false;
  }

  const similarity = extractTurnitinReportSimilarityFromText(normalized);
  const filterStates = extractTurnitinReportFilterStatesFromText(normalized);
  return !similarity && !hasExplicitTurnitinFilterStates(filterStates);
}

function extractTurnitinReportSimilarityFromText(text) {
  const normalized = normalizeReportText(text);
  if (!normalized) {
    return null;
  }

  const reportIndex = normalized.search(/\boriginality report\b/i);
  let reportScope = normalized;
  if (reportIndex >= 0) {
    reportScope = normalized.slice(reportIndex);
    const reportEnd = reportScope.search(
      /\b(internet sources|publications|student papers|primary sources|exclude quotes|exclude bibliography)\b/i
    );
    if (reportEnd > 0) {
      reportScope = reportScope.slice(0, reportEnd);
    }
  }

  const similarityIndexMatch = reportScope.match(/\bsimilarity index\b/i);
  if (similarityIndexMatch) {
    const similarityIndex = similarityIndexMatch.index || 0;
    const before = reportScope.slice(Math.max(0, similarityIndex - 120), similarityIndex);
    const beforePercentages = [...before.matchAll(/\b(100|[1-9]?\d)\s*%/g)];
    if (beforePercentages.length) {
      return `${beforePercentages[beforePercentages.length - 1][1]}%`;
    }

    const after = reportScope.slice(similarityIndex, similarityIndex + 24);
    const afterPercentages = [...after.matchAll(/\b(100|[1-9]?\d)\s*%/g)];
    if (afterPercentages.length) {
      return `${afterPercentages[0][1]}%`;
    }
  }

  const patterns = [
    /\boriginality report\b[^0-9]{0,40}(100|[1-9]?\d)\s*%\s*similarity index\b/i,
    /\b(100|[1-9]?\d)\s*%\s*similarity index\b/i,
    /\bsimilarity index\b[^0-9]{0,12}(100|[1-9]?\d)\s*%/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      return `${match[1]}%`;
    }
  }

  return null;
}

function extractTurnitinReportFilterStatesFromText(text) {
  const normalized = normalizeReportText(text);
  if (!normalized) {
    return {
      excludeQuotes: null,
      excludeBibliography: null,
      excludeMatches: null,
      excludeMatchesWordCount: null,
    };
  }

  const readBinaryState = (label) => {
    const match = normalized.match(new RegExp(`${label}\\s*(On|Off)`, "i"));
    if (!match) {
      return null;
    }
    return match[1].toLowerCase() === "on";
  };

  const excludeMatchesMatch = normalized.match(
    /Exclude matches(?:\s*<\s*(\d+)\s*words?)?\s*(On|Off)/i
  );
  const excludeMatchesThresholdOnlyMatch = normalized.match(
    /Exclude matches\s*<\s*(\d+)\s*words?/i
  );

  return {
    excludeQuotes: readBinaryState("Exclude quotes"),
    excludeBibliography: readBinaryState("Exclude bibliography"),
    excludeMatches: excludeMatchesMatch
      ? excludeMatchesMatch[2].toLowerCase() === "on"
      : excludeMatchesThresholdOnlyMatch
        ? true
        : null,
    excludeMatchesWordCount: excludeMatchesMatch?.[1]
      ? Number.parseInt(excludeMatchesMatch[1], 10)
      : excludeMatchesThresholdOnlyMatch?.[1]
        ? Number.parseInt(excludeMatchesThresholdOnlyMatch[1], 10)
        : null,
  };
}

function normalizeRequestedReportOptions(reportOptions = {}, defaultExcludeMatchesWordCount = 10) {
  const safeReportOptions =
    reportOptions && typeof reportOptions === "object" ? reportOptions : {};
  const excludeMatchesWordCount = Number(safeReportOptions.excludeMatchesWordCount);
  return {
    excludeQuotes: Boolean(safeReportOptions.excludeQuotes),
    excludeBibliography: Boolean(safeReportOptions.excludeBibliography),
    excludeMatches: Boolean(safeReportOptions.excludeMatches),
    excludeMatchesWordCount:
      Number.isInteger(excludeMatchesWordCount) && excludeMatchesWordCount > 0
        ? excludeMatchesWordCount
        : defaultExcludeMatchesWordCount,
  };
}

function doesPdfMatchRequestedReportOptions(
  pdfMetadata = {},
  reportOptions = {},
  { defaultExcludeMatchesWordCount = 10 } = {}
) {
  const expected = normalizeRequestedReportOptions(
    reportOptions,
    defaultExcludeMatchesWordCount
  );
  const actual = pdfMetadata?.filterStates || {};

  for (const key of ["excludeQuotes", "excludeBibliography", "excludeMatches"]) {
    if (actual[key] === null || actual[key] === undefined) {
      continue;
    }
    if (Boolean(actual[key]) !== Boolean(expected[key])) {
      return false;
    }
  }

  if (
    expected.excludeMatches &&
    actual.excludeMatchesWordCount !== null &&
    actual.excludeMatchesWordCount !== undefined &&
    Number(actual.excludeMatchesWordCount) !== Number(expected.excludeMatchesWordCount)
  ) {
    return false;
  }

  return true;
}

function isLocalStoragePdfUrl(value) {
  return /^\/storage\/reports\/.+\.pdf(?:$|\?)/i.test(String(value || ""));
}

function resolveStorageUrlPath(storageDir, value) {
  const text = String(value || "").trim();
  if (!text.startsWith("/storage/")) {
    return null;
  }

  const relativePath = text.replace(/^\/storage\//, "");
  return path.join(storageDir, relativePath);
}

async function isLikelyTurnitinReportPdfPath(filePath) {
  const metadata = await readTurnitinReportPdfMetadata(filePath);
  return metadata.valid;
}

async function readTurnitinReportPdfMetadata(filePath) {
  if (!filePath) {
    return {
      valid: false,
      isPdf: false,
      readable: false,
      similarity: null,
      filterStates: {
        excludeQuotes: null,
        excludeBibliography: null,
        excludeMatches: null,
        excludeMatchesWordCount: null,
      },
    };
  }

  let stats = null;
  try {
    stats = await fs.stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        valid: false,
        isPdf: false,
        readable: false,
        similarity: null,
        filterStates: {
          excludeQuotes: null,
          excludeBibliography: null,
          excludeMatches: null,
          excludeMatchesWordCount: null,
        },
      };
    }
    throw error;
  }

  const cached = pdfValidationCache.get(filePath);
  if (
    cached &&
    cached.mtimeMs === stats.mtimeMs &&
    cached.size === stats.size
  ) {
    return {
      valid: cached.valid,
      isPdf: cached.isPdf || false,
      readable: cached.readable || false,
      similarity: cached.similarity || null,
      filterStates: cached.filterStates || {
        excludeQuotes: null,
        excludeBibliography: null,
        excludeMatches: null,
        excludeMatchesWordCount: null,
      },
    };
  }

  let valid = false;
  const isPdf = await hasPdfSignature(filePath);
  const readable = isPdf ? await isReadablePdf(filePath) : false;
  let similarity = null;
  let filterStates = {
    excludeQuotes: null,
    excludeBibliography: null,
    excludeMatches: null,
    excludeMatchesWordCount: null,
  };
  try {
    const { stdout } = await execFileAsync("pdftotext", [filePath, "-"], {
      maxBuffer: 10 * 1024 * 1024,
    });
    valid = looksLikeTurnitinReportText(stdout);
    similarity = valid ? extractTurnitinReportSimilarityFromText(stdout) : null;
    filterStates = valid ? extractTurnitinReportFilterStatesFromText(stdout) : filterStates;
    if (valid && isIncompleteTurnitinReportText(stdout)) {
      valid = false;
      similarity = null;
      filterStates = {
        excludeQuotes: null,
        excludeBibliography: null,
        excludeMatches: null,
        excludeMatchesWordCount: null,
      };
    }
  } catch (error) {
    valid = error.code === "ENOENT";
    similarity = null;
  }

  pdfValidationCache.set(filePath, {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    valid,
    isPdf,
    readable,
    similarity,
    filterStates,
  });
  return {
    valid,
    isPdf,
    readable,
    similarity,
    filterStates,
  };
}

async function sanitizeResultArtifacts(result, { storageDir } = {}) {
  if (!result) {
    return result;
  }

  const artifacts = {
    ...(result.artifacts || {}),
  };
  const requestedReportOptions = result.reportOptions
    ? normalizeRequestedReportOptions(result.reportOptions)
    : null;
  const requiresCurrentViewSimilarity = Boolean(
    requestedReportOptions &&
      (requestedReportOptions.excludeQuotes ||
        requestedReportOptions.excludeBibliography ||
        requestedReportOptions.excludeMatches)
  );
  let dashboardSimilarity = result.dashboardSimilarity || null;
  let currentViewSimilarity = result.currentViewSimilarity || null;
  const originalFilePath =
    storageDir && artifacts.originalFile
      ? resolveStorageUrlPath(storageDir, artifacts.originalFile)
      : null;

  if (
    storageDir &&
    artifacts.viewerPdf &&
    isLocalStoragePdfUrl(artifacts.viewerPdf)
  ) {
    const viewerPdfPath = resolveStorageUrlPath(storageDir, artifacts.viewerPdf);
      const viewerPdfMatchesOriginal =
      originalFilePath && (await areFilesByteIdentical(viewerPdfPath, originalFilePath));
    if (viewerPdfMatchesOriginal) {
      delete artifacts.viewerPdf;
    } else {
      const viewerPdfMetadata = await readTurnitinReportPdfMetadata(viewerPdfPath);
      if (!viewerPdfMetadata.valid) {
        delete artifacts.viewerPdf;
      } else if (
        requestedReportOptions &&
        !doesPdfMatchRequestedReportOptions(viewerPdfMetadata, requestedReportOptions)
      ) {
        delete artifacts.viewerPdf;
      } else {
        currentViewSimilarity = viewerPdfMetadata.similarity || null;
      }
    }
  }

  const reportUrl = isLikelyViewerUrl(result.reportUrl)
    ? result.reportUrl
    : isLikelyViewerUrl(result.studioUrl)
      ? result.studioUrl
      : null;
  let studioUrl = result.studioUrl || null;

  if (
    storageDir &&
    studioUrl &&
    isLocalStoragePdfUrl(studioUrl)
  ) {
    const studioPath = resolveStorageUrlPath(storageDir, studioUrl);
    const studioMatchesOriginal =
      originalFilePath && (await areFilesByteIdentical(studioPath, originalFilePath));
    if (studioMatchesOriginal) {
      studioUrl = null;
    } else {
      const studioMetadata = await readTurnitinReportPdfMetadata(studioPath);
      if (!studioMetadata.valid) {
        studioUrl = null;
      } else if (
        requestedReportOptions &&
        !doesPdfMatchRequestedReportOptions(studioMetadata, requestedReportOptions)
      ) {
        studioUrl = null;
      } else if (!currentViewSimilarity) {
        currentViewSimilarity = studioMetadata.similarity || null;
      }
    }
  }

  if (!artifacts.viewerPdf && isLocalStoragePdfUrl(studioUrl)) {
    artifacts.viewerPdf = studioUrl;
  }

  if (
    requestedReportOptions &&
    (requestedReportOptions.excludeQuotes ||
      requestedReportOptions.excludeBibliography ||
      requestedReportOptions.excludeMatches) &&
    !artifacts.viewerPdf
  ) {
    currentViewSimilarity = null;
  }

  if (!dashboardSimilarity) {
    if (!requiresCurrentViewSimilarity) {
      dashboardSimilarity = result.similarity || null;
    } else if (!currentViewSimilarity) {
      dashboardSimilarity = result.similarity || null;
    }
  }

  return {
    ...result,
    artifacts,
    dashboardSimilarity,
    currentViewSimilarity,
    similarity:
      currentViewSimilarity || (!requiresCurrentViewSimilarity ? dashboardSimilarity : null) || null,
    reportUrl,
    studioUrl:
      pickStudioUrl({
        reportUrl,
        artifacts,
      }) ||
      studioUrl ||
      null,
  };
}

module.exports = {
  areFilesByteIdentical,
  doesPdfMatchRequestedReportOptions,
  extractTurnitinReportFilterStatesFromText,
  extractTurnitinReportSimilarityFromText,
  hasCurrentViewPdf,
  isIncompleteTurnitinReportText,
  isLikelyViewerUrl,
  isLocalStoragePdfUrl,
  looksLikeTurnitinReportText,
  pickCurrentViewUrl,
  pickStudioUrl,
  readTurnitinReportPdfMetadata,
  sanitizeResultArtifacts,
};
