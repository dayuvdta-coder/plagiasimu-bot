const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildStressTestSubmissions,
  parseStressTestArgs,
} = require("../src/services/stress-test");

test("parseStressTestArgs reads endpoint, repeat, and report flags", () => {
  const options = parseStressTestArgs([
    "--endpoint",
    "http://127.0.0.1:9999",
    "--serial",
    "--repeat",
    "3",
    "--poll-ms",
    "2000",
    "--timeout-ms",
    "60000",
    "--stagger-ms",
    "500",
    "--title-prefix",
    "Queue Burn-In",
    "--username",
    "Andri14",
    "--password",
    "Andri14",
    "--exclude-quotes",
    "--exclude-bibliography",
    "--exclude-matches",
    "--word-count",
    "15",
    "a.pdf",
    "b.pdf",
  ]);

  assert.equal(options.endpoint, "http://127.0.0.1:9999");
  assert.equal(options.serial, true);
  assert.equal(options.repeat, 3);
  assert.equal(options.pollMs, 2000);
  assert.equal(options.timeoutMs, 60000);
  assert.equal(options.staggerMs, 500);
  assert.equal(options.titlePrefix, "Queue Burn-In");
  assert.equal(options.username, "Andri14");
  assert.equal(options.password, "Andri14");
  assert.deepEqual(options.files, ["a.pdf", "b.pdf"]);
  assert.deepEqual(options.reportOptions, {
    excludeQuotes: true,
    excludeBibliography: true,
    excludeMatches: true,
    excludeMatchesWordCount: 15,
  });
});

test("buildStressTestSubmissions expands repeat count and numbers titles", () => {
  const submissions = buildStressTestSubmissions({
    files: ["/tmp/one.pdf", "/tmp/two.pdf"],
    repeat: 2,
    titlePrefix: "Queue Burn-In",
  });

  assert.deepEqual(
    submissions.map((entry) => entry.title),
    [
      "Queue Burn-In (1)",
      "Queue Burn-In (2)",
      "Queue Burn-In (3)",
      "Queue Burn-In (4)",
    ]
  );
  assert.deepEqual(
    submissions.map((entry) => entry.filePath),
    ["/tmp/one.pdf", "/tmp/two.pdf", "/tmp/one.pdf", "/tmp/two.pdf"]
  );
});
