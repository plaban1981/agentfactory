import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Symmetric encryption for secrets we store at rest (e.g. GitHub OAuth tokens).
// Output format: base64url(iv).base64url(authTag).base64url(ciphertext)

function key() {
  const secret = process.env.TOKEN_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be set to a random string of at least 32 characters.");
  }
  return createHash("sha256").update(secret).digest();
}

export function encrypt(plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

export function decrypt(payload: string) {
  const [iv, tag, data] = payload.split(".").map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
