function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildLines(text) {
  return String(text || "")
    .split(/\n+/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
}

function slugify(text) {
  return normalizeWhitespace(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function deriveTitle(lines, controlLabel) {
  const controlText = normalizeWhitespace(controlLabel).toLowerCase();
  const ignoredPatterns = [
    /^open$/i,
    /^submit$/i,
    /^resubmit$/i,
    /^view$/i,
    /^upload submission$/i,
    /^upload and review$/i,
    /^submit to turnitin$/i,
    /^file upload$/i,
    /\bsubmitted\b/i,
    /\bsimilarity\b/i,
    /\bdigital receipt\b/i,
    /\bfeedback\b/i,
    /\bdue\b/i,
    /\bstart\b/i,
    /\bpost\b/i,
    /\bgrade\b/i,
    /^\d{1,3}%$/,
  ];

  for (const line of lines) {
    const lowered = line.toLowerCase();
    if (!line || lowered === controlText) {
      continue;
    }

    if (ignoredPatterns.some((pattern) => pattern.test(line))) {
      continue;
    }

    return line;
  }

  return lines.find((line) => line.toLowerCase() !== controlText) || "Untitled";
}

function dedupeActions(actions) {
  const deduped = new Map();

  for (const action of actions) {
    const key = normalizeWhitespace(action.containerText || action.label).toLowerCase();
    const currentScore =
      (/^open$/i.test(action.label) ? 4 : 0) +
      (/^submit$/i.test(action.label) ? 3 : 0) +
      (/^resubmit$/i.test(action.label) ? 2 : 0) +
      (action.href ? 1 : 0) +
      (action.disabled ? 0 : 1);
    const existing = deduped.get(key);

    if (!existing || currentScore > existing.score) {
      deduped.set(key, { score: currentScore, action });
    }
  }

  return [...deduped.values()].map((entry) => entry.action);
}

function classifyClassAction(action) {
  const lines = action.containerLines?.length
    ? action.containerLines
    : buildLines(action.containerText);

  return {
    ...action,
    name: deriveTitle(lines, action.label),
  };
}

function classifyAssignmentAction(action) {
  const lines = action.containerLines?.length
    ? action.containerLines
    : buildLines(action.containerText);
  const rawText = normalizeWhitespace(action.containerText);
  const combined = `${action.label} ${rawText}`;
  const similarityMatch = combined.match(/\b(100|[1-9]?\d)%/);
  const usedByText = /\b(submitted|resubmission|digital receipt|paper title|receipt|view report|feedback studio)\b/i.test(
    combined
  );
  const availableByLabel = /^(open|submit)$/i.test(action.label);
  const name = deriveTitle(lines, action.label);

  let status = "unknown";
  if (similarityMatch || usedByText) {
    status = "used";
  } else if (availableByLabel && !action.disabled) {
    status = "available";
  }

  return {
    ...action,
    key: slugify(name),
    name,
    similarity: similarityMatch ? similarityMatch[0] : null,
    status,
    rawText,
  };
}

function classifyAssignmentDashboardState({
  bodyText = "",
  title = "",
  actionLabels = [],
} = {}) {
  const combined = normalizeWhitespace([title, bodyText, ...actionLabels].join(" "));
  const similarityMatch = combined.match(/\b(100|[1-9]?\d)%/);
  const hasUsedMarkers =
    !!similarityMatch ||
    /\b(resubmit paper|confirm resubmission|download digital receipt|feedback studio|view similarity matches|paper title|uploaded)\b/i.test(
      combined
    );
  const hasAvailableMarkers =
    /\b(you have no active papers in this assignment|upload submission|start submission|submit paper|file upload|upload a paper)\b/i.test(
      combined
    );

  let status = "unknown";
  if (hasUsedMarkers) {
    status = "used";
  } else if (hasAvailableMarkers) {
    status = "available";
  }

  return {
    status,
    similarity: similarityMatch ? similarityMatch[0] : null,
  };
}

module.exports = {
  buildLines,
  classifyAssignmentAction,
  classifyAssignmentDashboardState,
  classifyClassAction,
  dedupeActions,
  normalizeWhitespace,
  slugify,
};
