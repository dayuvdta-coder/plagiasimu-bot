const fs = require("fs/promises");
const path = require("path");

const SIMPLE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

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

function normalizeAccountEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function validateAccountInput({ email, password } = {}) {
  const normalizedEmail = String(email || "").trim();
  const normalizedPassword = String(password || "").trim();

  if (!normalizedEmail || !normalizedPassword) {
    throw new Error('Format akun tidak valid. Gunakan "email@example.com | password".');
  }

  if (!SIMPLE_EMAIL_PATTERN.test(normalizedEmail)) {
    throw new Error("Format email akun tidak valid.");
  }

  return {
    email: normalizedEmail,
    password: normalizedPassword,
  };
}

async function loadAccountsFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return {
      raw,
      lines: raw.split(/\r?\n/),
      accounts: parseAccountsFromText(raw),
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        raw: "",
        lines: [],
        accounts: [],
      };
    }

    throw error;
  }
}

async function listAccounts(filePath) {
  const { accounts } = await loadAccountsFile(filePath);
  return accounts;
}

function buildAccountLine({ email, password }) {
  return `${String(email || "").trim()} | ${String(password || "").trim()}`;
}

async function appendAccount(filePath, { email, password } = {}) {
  const nextAccount = validateAccountInput({ email, password });
  const file = await loadAccountsFile(filePath);
  const duplicate = file.accounts.find(
    (account) => normalizeAccountEmail(account.email) === normalizeAccountEmail(nextAccount.email)
  );
  if (duplicate) {
    throw new Error("Akun sudah ada di file pool.");
  }

  const nextLine = buildAccountLine(nextAccount);
  const nextRaw = file.raw.trim()
    ? file.raw.endsWith("\n")
      ? `${file.raw}${nextLine}\n`
      : `${file.raw}\n${nextLine}\n`
    : `${nextLine}\n`;

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, nextRaw, "utf8");

  return {
    account: {
      ...nextAccount,
      sourceLine: nextRaw.split(/\r?\n/).findIndex((line) => line === nextLine) + 1,
    },
    totalAccounts: file.accounts.length + 1,
  };
}

async function removeAccount(filePath, email) {
  const normalizedEmail = normalizeAccountEmail(email);
  if (!normalizedEmail) {
    throw new Error("Email akun yang akan dihapus wajib diisi.");
  }

  const file = await loadAccountsFile(filePath);
  if (!file.accounts.length) {
    throw new Error("File akun masih kosong.");
  }

  const account = file.accounts.find(
    (entry) => normalizeAccountEmail(entry.email) === normalizedEmail
  );
  if (!account) {
    throw new Error("Akun tidak ditemukan di file pool.");
  }

  if (file.accounts.length <= 1) {
    throw new Error("Akun terakhir tidak bisa dihapus. Sisakan minimal satu akun.");
  }

  const nextLines = [...file.lines];
  const rawLineIndex = Math.max(0, Number(account.sourceLine || 1) - 1);
  nextLines.splice(rawLineIndex, 1);
  let nextRaw = nextLines.join("\n");
  if (nextRaw && !nextRaw.endsWith("\n")) {
    nextRaw = `${nextRaw}\n`;
  }

  await fs.writeFile(filePath, nextRaw, "utf8");

  return {
    removedAccount: account,
    totalAccounts: file.accounts.length - 1,
  };
}

module.exports = {
  appendAccount,
  listAccounts,
  maskEmail,
  normalizeAccountEmail,
  parseAccountsFromText,
  readAccounts,
  removeAccount,
};
