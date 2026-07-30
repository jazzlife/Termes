import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const MAX_MEMORY_BYTES = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, keyLength: number, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, { N: n, r, p, maxmem: MAX_MEMORY_BYTES }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashMemberPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const digest = await derive(password, salt, KEY_BYTES, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("base64url"), digest.toString("base64url")].join("$");
}

export async function verifyMemberPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, "base64url");
    expected = Buffer.from(parts[5]!, "base64url");
  } catch {
    return false;
  }
  if (salt.byteLength !== SALT_BYTES || expected.byteLength !== KEY_BYTES) return false;
  const actual = await derive(password, salt, expected.byteLength, n, r, p);
  return timingSafeEqual(expected, actual);
}
