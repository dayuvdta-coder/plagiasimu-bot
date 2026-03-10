const fs = require("fs/promises");
const path = require("path");

const SIMPLE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

function parseAccountsFromText(text) {
  const rows = String(text || "").split(/\r?\n/);
  const accounts = [];
  let pendingEmail = null;

  for (let index = 0; index < rows.length; index += 1) {
    const sourceLine = index + 1;
    const line = String(rows[index] || "").trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    if (pendingEmail) {
      if (!line.startsWith("|")) {
        throw new Error(
          `Format akun tidak valid di baris ${pendingEmail.sourceLine}. Gunakan "email | password".`
        );
      }

      const password = line.slice(1).trim();
      if (!pendingEmail.email || !password) {
        throw new Error(
          `Format akun tidak valid di baris ${pendingEmail.sourceLine}. Gunakan "email | password".`
        );
      }

      accounts.push({
        email: pendingEmail.email,
        password,
        sourceLine: pendingEmail.sourceLine,
        sourceLineStart: pendingEmail.sourceLine,
        sourceLineEnd: sourceLine,
      });
      pendingEmail = null;
      continue;
    }

    const pipeIndex = line.indexOf("|");
    if (pipeIndex >= 0) {
      const email = line.slice(0, pipeIndex).trim();
      const password = line.slice(pipeIndex + 1).trim();
      if (!email || !password) {
        throw new Error(
          `Format akun tidak valid di baris ${sourceLine}. Gunakan "email | password".`
        );
      }

      accounts.push({
        email,
        password,
        sourceLine,
        sourceLineStart: sourceLine,
        sourceLineEnd: sourceLine,
      });
      continue;
    }

    pendingEmail = {
      email: line,
      sourceLine,
    };
  }

  if (pendingEmail) {
    throw new Error(
      `Format akun tidak valid di baris ${pendingEmail.sourceLine}. Gunakan "email | password".`
    );
  }

  return accounts;
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
  const result = await appendAccounts(filePath, [{ email, password }]);
  if (!result.addedAccounts.length) {
    if (result.skippedAccounts.length) {
      throw new Error("Akun sudah ada di file pool.");
    }
    throw new Error("Tidak ada akun baru yang ditambahkan.");
  }

  const [account] = result.addedAccounts;
  return {
    account,
    totalAccounts: result.totalAccounts,
  };
}

async function appendAccounts(filePath, items = []) {
  const file = await loadAccountsFile(filePath);
  const existingEmails = new Set(
    file.accounts.map((account) => normalizeAccountEmail(account.email))
  );
  const seenBatchEmails = new Set();
  const addedAccounts = [];
  const skippedAccounts = [];

  for (const item of items) {
    const nextAccount = validateAccountInput(item);
    const normalizedEmail = normalizeAccountEmail(nextAccount.email);
    if (existingEmails.has(normalizedEmail) || seenBatchEmails.has(normalizedEmail)) {
      skippedAccounts.push(nextAccount.email);
      continue;
    }

    seenBatchEmails.add(normalizedEmail);
    addedAccounts.push(nextAccount);
  }

  if (!addedAccounts.length) {
    return {
      addedAccounts: [],
      skippedAccounts,
      totalAccounts: file.accounts.length,
    };
  }

  const appendedText = addedAccounts.map((account) => buildAccountLine(account)).join("\n");
  const nextRaw = file.raw.trim()
    ? file.raw.endsWith("\n")
      ? `${file.raw}${appendedText}\n`
      : `${file.raw}\n${appendedText}\n`
    : `${appendedText}\n`;

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, nextRaw, "utf8");

  return {
    addedAccounts,
    skippedAccounts,
    totalAccounts: file.accounts.length + addedAccounts.length,
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
  const rawLineStartIndex = Math.max(0, Number(account.sourceLineStart || account.sourceLine || 1) - 1);
  const rawLineEndIndex = Math.max(
    rawLineStartIndex,
    Number(account.sourceLineEnd || account.sourceLine || 1) - 1
  );
  nextLines.splice(rawLineStartIndex, rawLineEndIndex - rawLineStartIndex + 1);
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
  appendAccounts,
  listAccounts,
  maskEmail,
  normalizeAccountEmail,
  parseAccountsFromText,
  readAccounts,
  removeAccount,
};
