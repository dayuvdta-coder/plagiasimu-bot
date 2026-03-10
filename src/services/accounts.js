const fs = require("fs/promises");

function parseAccountsFromText(text) {
  return text
    .split(/\r?\n/)
    .map((line, index) => ({
      line: line.trim(),
      index: index + 1,
    }))
    .filter((entry) => entry.line && !entry.line.startsWith("#"))
    .map((entry) => {
      const [emailPart, ...passwordParts] = entry.line
        .split("|")
        .map((part) => part.trim());
      const email = emailPart || "";
      const password = passwordParts.join("|").trim();

      if (!email || !password) {
        throw new Error(
          `Format akun tidak valid di baris ${entry.index}. Gunakan "email | password".`
        );
      }

      return {
        email,
        password,
        sourceLine: entry.index,
      };
    });
}

async function readAccounts(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const accounts = parseAccountsFromText(raw);

  if (!accounts.length) {
    throw new Error("File akun kosong. Tambahkan minimal satu akun Turnitin.");
  }

  return accounts;
}

function maskEmail(email) {
  const [localPart = "", domain = ""] = String(email).split("@");
  const visible = localPart.slice(0, 3);
  return `${visible}${"*".repeat(Math.max(localPart.length - 3, 2))}@${domain}`;
}

module.exports = {
  maskEmail,
  parseAccountsFromText,
  readAccounts,
};
