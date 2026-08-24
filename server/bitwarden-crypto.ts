// Bitwarden Secrets Manager access-token + EncString crypto.
// Official protocol (sdk-internal): no native SDK — packaging forbids
// bare imports in shipped server files. node:crypto only.
//
// Access token: `0.{uuid}.{clientSecret}:{b64 16-byte key}`
// EncString type 2: `2.{b64 iv}|{b64 data}|{b64 mac}` (AES-256-CBC + HMAC-SHA256).
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ENC_TYPE_AES256_HMAC = "2";
const IV_LEN = 16;
const MAC_LEN = 32;
const KEY_LEN = 64;
const SHARE_SECRET_LEN = 16;

export interface ParsedAccessToken {
  accessTokenId: string;
  clientSecret: string;
  /** 64-byte AES-256-CBC + HMAC-SHA256 composite key. */
  encryptionKey: Buffer;
}

export function parseAccessToken(raw: string): ParsedAccessToken {
  const token = raw.trim();
  const colon = token.indexOf(":");
  if (colon <= 0) throw new Error("invalid Bitwarden access token");
  const first = token.slice(0, colon);
  const keyB64 = token.slice(colon + 1);
  const parts = first.split(".");
  if (parts.length !== 3) throw new Error("invalid Bitwarden access token");
  const [version, accessTokenId, clientSecret] = parts;
  if (version !== "0" || !accessTokenId || !clientSecret) throw new Error("invalid Bitwarden access token");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(accessTokenId)) {
    throw new Error("invalid Bitwarden access token");
  }
  let secret: Buffer;
  try {
    secret = Buffer.from(keyB64, "base64");
  } catch {
    throw new Error("invalid Bitwarden access token");
  }
  if (secret.length !== SHARE_SECRET_LEN) throw new Error("invalid Bitwarden access token");
  return {
    accessTokenId,
    clientSecret,
    encryptionKey: deriveShareableKey(secret, "accesstoken", "sm-access-token"),
  };
}

/** Official `derive_shareable_key`: HMAC-SHA256("bitwarden-{name}", secret) then HKDF-Expand. */
export function deriveShareableKey(secret: Buffer, name: string, info?: string): Buffer {
  if (secret.length !== SHARE_SECRET_LEN) throw new Error("invalid shareable key secret");
  const prk = createHmac("sha256", `bitwarden-${name}`).update(secret).digest();
  return hkdfExpand(prk, info ?? "", KEY_LEN);
}

/** RFC 5869 HKDF-Expand (SHA-256). Bitwarden uses expand-only after the HMAC extract. */
export function hkdfExpand(prk: Buffer, info: string, length: number): Buffer {
  const hashLen = 32;
  const n = Math.ceil(length / hashLen);
  if (n > 255) throw new Error("hkdf expand too long");
  const okm = Buffer.alloc(n * hashLen);
  let prev = Buffer.alloc(0);
  const infoBuf = Buffer.from(info, "utf8");
  for (let i = 1; i <= n; i++) {
    const hmac = createHmac("sha256", prk);
    hmac.update(prev);
    hmac.update(infoBuf);
    hmac.update(Buffer.from([i]));
    prev = hmac.digest();
    prev.copy(okm, (i - 1) * hashLen);
  }
  return okm.subarray(0, length);
}

export function encryptEncString(plaintext: Buffer | string, key: Buffer): string {
  if (key.length !== KEY_LEN) throw new Error("invalid symmetric key");
  const iv = randomBytes(IV_LEN);
  const encKey = key.subarray(0, 32);
  const macKey = key.subarray(32, 64);
  const cipher = createCipheriv("aes-256-cbc", encKey, iv);
  const data = Buffer.concat([cipher.update(typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext), cipher.final()]);
  const mac = createHmac("sha256", macKey).update(iv).update(data).digest();
  return `${ENC_TYPE_AES256_HMAC}.${iv.toString("base64")}|${data.toString("base64")}|${mac.toString("base64")}`;
}

export function decryptEncString(enc: string, key: Buffer): Buffer {
  if (key.length !== KEY_LEN) throw new Error("invalid symmetric key");
  const text = enc.trim();
  const dot = text.indexOf(".");
  if (dot < 0) throw new Error("invalid enc string");
  const type = text.slice(0, dot);
  const rest = text.slice(dot + 1);
  const pieces = rest.split("|");
  if (type !== ENC_TYPE_AES256_HMAC || pieces.length !== 3) throw new Error("unsupported enc string");
  const iv = Buffer.from(pieces[0]!, "base64");
  const data = Buffer.from(pieces[1]!, "base64");
  const mac = Buffer.from(pieces[2]!, "base64");
  if (iv.length !== IV_LEN || mac.length !== MAC_LEN || data.length === 0) throw new Error("invalid enc string");
  const encKey = key.subarray(0, 32);
  const macKey = key.subarray(32, 64);
  const expected = createHmac("sha256", macKey).update(iv).update(data).digest();
  if (expected.length !== mac.length || !timingSafeEqual(expected, mac)) throw new Error("enc string mac mismatch");
  const decipher = createDecipheriv("aes-256-cbc", encKey, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export function decryptEncStringUtf8(enc: string, key: Buffer): string {
  return decryptEncString(enc, key).toString("utf8");
}

/** Organization key from the identity encrypted_payload JSON (`encryptionKey` b64). */
export function organizationKeyFromPayload(decryptedJson: Buffer): Buffer {
  const parsed = JSON.parse(decryptedJson.toString("utf8")) as { encryptionKey?: unknown };
  if (typeof parsed.encryptionKey !== "string" || !parsed.encryptionKey) throw new Error("identity payload missing encryptionKey");
  const key = Buffer.from(parsed.encryptionKey, "base64");
  if (key.length !== KEY_LEN) throw new Error("invalid organization key");
  return key;
}

export function decodeSymmetricKey(b64: string): Buffer {
  const key = Buffer.from(b64, "base64");
  if (key.length !== KEY_LEN) throw new Error("invalid symmetric key");
  return key;
}
