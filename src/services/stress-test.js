const path = require("path");

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function parseStressTestArgs(argv = []) {
  const options = {
    endpoint: "http://127.0.0.1:3101",
    titlePrefix: "",
    username: String(process.env.PANEL_AUTH_USERNAME || "Andri14").trim() || "Andri14",
    password: String(process.env.PANEL_AUTH_PASSWORD || "Andri14"),
    repeat: 1,
    pollMs: 5000,
    timeoutMs: 45 * 60 * 1000,
    staggerMs: 0,
    serial: false,
    help: false,
    reportOptions: {
      excludeQuotes: false,
      excludeBibliography: false,
      excludeMatches: false,
      excludeMatchesWordCount: 10,
    },
    files: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || "");
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--endpoint":
        options.endpoint = String(argv[index + 1] || options.endpoint).trim() || options.endpoint;
        index += 1;
        break;
      case "--title-prefix":
        options.titlePrefix = String(argv[index + 1] || "").trim();
        index += 1;
        break;
      case "--username":
        options.username = String(argv[index + 1] || "").trim() || options.username;
        index += 1;
        break;
      case "--password":
        options.password = String(argv[index + 1] || "");
        index += 1;
        break;
      case "--repeat":
        options.repeat = parsePositiveInteger(argv[index + 1], options.repeat);
        index += 1;
        break;
      case "--poll-ms":
        options.pollMs = parsePositiveInteger(argv[index + 1], options.pollMs);
        index += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = parsePositiveInteger(argv[index + 1], options.timeoutMs);
        index += 1;
        break;
      case "--stagger-ms":
        options.staggerMs = parsePositiveInteger(argv[index + 1], options.staggerMs);
        index += 1;
        break;
      case "--serial":
        options.serial = true;
        break;
      case "--exclude-quotes":
        options.reportOptions.excludeQuotes = true;
        break;
      case "--exclude-bibliography":
        options.reportOptions.excludeBibliography = true;
        break;
      case "--exclude-matches":
        options.reportOptions.excludeMatches = true;
        break;
      case "--word-count":
        options.reportOptions.excludeMatchesWordCount = parsePositiveInteger(
          argv[index + 1],
          options.reportOptions.excludeMatchesWordCount
        );
        index += 1;
        break;
      default:
        options.files.push(arg);
        break;
    }
  }

  return options;
}

function buildStressTestSubmissions({ files = [], repeat = 1, titlePrefix = "" } = {}) {
  const normalizedFiles = (files || []).map((value) => String(value || "").trim()).filter(Boolean);
  const normalizedRepeat = Math.max(1, parsePositiveInteger(repeat, 1));
  const total = normalizedFiles.length * normalizedRepeat;
  const submissions = [];

  for (let repeatIndex = 0; repeatIndex < normalizedRepeat; repeatIndex += 1) {
    for (const filePath of normalizedFiles) {
      const fallbackTitle = path.parse(filePath).name || "Stress Test";
      const baseTitle = String(titlePrefix || "").trim() || fallbackTitle;
      const title = total > 1 ? `${baseTitle} (${submissions.length + 1})` : baseTitle;
      submissions.push({
        filePath,
        title,
      });
    }
  }

  return submissions;
}

module.exports = {
  buildStressTestSubmissions,
  parseStressTestArgs,
};
