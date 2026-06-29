#!/usr/bin/env node

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const DEFAULT_KEY_PATH = path.join(
  os.homedir(),
  ".config",
  "termes",
  "server-access.key",
);
const DEFAULT_SECRET_PATH = path.join("secrets", "server-access.enc.json");

function usage() {
  console.error(`Usage:
  node scripts/secrets.mjs encrypt <plaintext-json> [encrypted-json]
  node scripts/secrets.mjs decrypt [encrypted-json]
  node scripts/secrets.mjs env [encrypted-json]

Environment:
  TERMES_SECRETS_KEY  Override key file path.

The key file must contain a 64-character hex AES-256 key.`);
  process.exit(2);
}

async function assertReadable(filePath) {
  try {
    await access(filePath, constants.R_OK);
  } catch {
    throw new Error(`File is not readable: ${filePath}`);
  }
}

async function loadKey() {
  const keyPath = process.env.TERMES_SECRETS_KEY || DEFAULT_KEY_PATH;
  await assertReadable(keyPath);
  const raw = (await readFile(keyPath, "utf8")).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`Invalid key format at ${keyPath}; expected 64 hex characters.`);
  }
  return Buffer.from(raw, "hex");
}

async function encrypt(plainPath, encryptedPath) {
  await assertReadable(plainPath);
  const key = await loadKey();
  const plaintext = await readFile(plainPath);
  JSON.parse(plaintext.toString("utf8"));

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload = {
    version: 1,
    alg: "aes-256-gcm",
    createdAt: new Date().toISOString(),
    keyRef: process.env.TERMES_SECRETS_KEY || DEFAULT_KEY_PATH,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };

  await mkdir(path.dirname(encryptedPath), { recursive: true });
  await writeFile(encryptedPath, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
}

async function decrypt(encryptedPath) {
  await assertReadable(encryptedPath);
  const key = await loadKey();
  const payload = JSON.parse(await readFile(encryptedPath, "utf8"));

  if (payload.alg !== "aes-256-gcm") {
    throw new Error(`Unsupported encryption algorithm: ${payload.alg}`);
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(payload.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);

  return JSON.parse(plaintext.toString("utf8"));
}

function shellEscape(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function emitEnv(secret) {
  const lines = [
    ["TERMES_SERVER_HOST", secret.server.host],
    ["TERMES_SSH_USER", secret.ssh.username],
    ["TERMES_SSH_PASSWORD", secret.ssh.password],
    ["TERMES_PORTAINER_USER", secret.portainer.username],
    ["TERMES_PORTAINER_PASSWORD", secret.portainer.password],
    ["TERMES_NPM_USER", secret.npm.username],
    ["TERMES_NPM_PASSWORD", secret.npm.password],
  ];

  for (const [key, value] of lines) {
    console.log(`export ${key}=${shellEscape(value)}`);
  }
}

async function main() {
  const [command, arg1, arg2] = process.argv.slice(2);
  const encryptedPath = arg2 || arg1 || DEFAULT_SECRET_PATH;

  try {
    if (command === "encrypt") {
      if (!arg1) usage();
      await encrypt(arg1, arg2 || DEFAULT_SECRET_PATH);
      console.log(`Encrypted secrets written to ${arg2 || DEFAULT_SECRET_PATH}`);
      return;
    }

    if (command === "decrypt") {
      const target = arg1 || DEFAULT_SECRET_PATH;
      const secret = await decrypt(target);
      console.log(JSON.stringify(secret, null, 2));
      return;
    }

    if (command === "env") {
      const target = arg1 || DEFAULT_SECRET_PATH;
      const secret = await decrypt(target);
      emitEnv(secret);
      return;
    }

    usage();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (!existsSync(DEFAULT_SECRET_PATH) && process.argv[2] !== "encrypt") {
  // The command-specific error below is clearer once the file exists. Keep this
  // guard only as an early hint for a fresh checkout.
}

await main();
