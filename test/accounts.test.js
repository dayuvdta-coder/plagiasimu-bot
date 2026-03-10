const test = require("node:test");
const assert = require("node:assert/strict");
const { parseAccountsFromText } = require("../src/services/accounts");

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
