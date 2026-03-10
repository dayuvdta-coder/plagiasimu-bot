const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const {
  appendAccount,
  listAccounts,
  parseAccountsFromText,
  removeAccount,
} = require("../src/services/accounts");

test("parseAccountsFromText parses simple rows", () => {
  const accounts = parseAccountsFromText(`
    user1@example.com | pass1
    user2@example.com | pass2
  `);

  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].email, "user1@example.com");
  assert.equal(accounts[1].password, "pass2");
});

test("parseAccountsFromText preserves pipe in password", () => {
  const accounts = parseAccountsFromText("user@example.com | pass|with|pipe");
  assert.equal(accounts[0].password, "pass|with|pipe");
});

test("appendAccount adds a new account without removing comments", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-accounts-"));
  const filePath = path.join(dir, "akun-turnitin.txt");
  await fs.writeFile(filePath, "# pool akun\nuser1@example.com | pass1\n", "utf8");

  const result = await appendAccount(filePath, {
    email: "user2@example.com",
    password: "pass2",
  });

  const raw = await fs.readFile(filePath, "utf8");
  const accounts = await listAccounts(filePath);
  assert.equal(result.totalAccounts, 2);
  assert.match(raw, /^# pool akun\nuser1@example.com \| pass1\nuser2@example.com \| pass2\n$/);
  assert.equal(accounts.length, 2);

  await fs.rm(dir, { recursive: true, force: true });
});

test("removeAccount deletes the selected account and keeps comments", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "turnitin-accounts-"));
  const filePath = path.join(dir, "akun-turnitin.txt");
  await fs.writeFile(
    filePath,
    "# pool akun\nuser1@example.com | pass1\nuser2@example.com | pass2\n",
    "utf8"
  );

  const result = await removeAccount(filePath, "user1@example.com");

  const raw = await fs.readFile(filePath, "utf8");
  const accounts = await listAccounts(filePath);
  assert.equal(result.totalAccounts, 1);
  assert.equal(result.removedAccount.email, "user1@example.com");
  assert.match(raw, /^# pool akun\nuser2@example.com \| pass2\n$/);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].email, "user2@example.com");

  await fs.rm(dir, { recursive: true, force: true });
});
