import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { kvGet, kvSet, type Db } from "./db.ts";
import { AppError, badRequest } from "./errors.ts";

const CODE_KEY = "extension.pairing_code";
const TOKENS_KEY = "extension.tokens";
const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;

interface PairingCode {
  hash: string;
  expiresAt: number;
  attempts: number;
}

interface PairedToken {
  origin: string;
  hash: string;
  createdAt: string;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function tokens(db: Db): PairedToken[] {
  const raw = kvGet(db, TOKENS_KEY);
  return raw ? (JSON.parse(raw) as PairedToken[]) : [];
}

/** Shown in the web app; typed into the side panel. One use, ten minutes, five tries. */
export function createPairingCode(db: Db): { code: string; expiresAt: string } {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = Date.now() + CODE_TTL_MS;
  kvSet(db, CODE_KEY, JSON.stringify({ hash: sha(code), expiresAt, attempts: 0 } satisfies PairingCode));
  return { code, expiresAt: new Date(expiresAt).toISOString() };
}

/** Exchanges the code for a token bound to the extension's origin. Only the token's hash is kept. */
export function pairExtension(db: Db, origin: string, code: string): { token: string } {
  if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) throw badRequest("Only the Kiki Chrome extension can pair.");
  const raw = kvGet(db, CODE_KEY);
  const pending = raw ? (JSON.parse(raw) as PairingCode) : null;
  if (!pending || pending.expiresAt < Date.now()) {
    kvSet(db, CODE_KEY, undefined);
    throw new AppError(403, "That pairing code expired. Make a new one in the Kiki web app.");
  }
  const ok = /^\d{6}$/.test(code) && timingSafeEqual(Buffer.from(sha(code)), Buffer.from(pending.hash));
  if (!ok) {
    pending.attempts += 1;
    kvSet(db, CODE_KEY, pending.attempts >= MAX_ATTEMPTS ? undefined : JSON.stringify(pending));
    throw new AppError(403, pending.attempts >= MAX_ATTEMPTS ? "Too many wrong codes. Make a new one in the web app." : "That code isn't right.");
  }
  kvSet(db, CODE_KEY, undefined);
  const token = randomBytes(32).toString("base64url");
  const others = tokens(db).filter((t) => t.origin !== origin);
  kvSet(db, TOKENS_KEY, JSON.stringify([...others, { origin, hash: sha(token), createdAt: new Date().toISOString() }]));
  return { token };
}

export function verifyExtensionToken(db: Db, origin: string, header: string | undefined): boolean {
  const token = /^Bearer (.+)$/.exec(header ?? "")?.[1];
  if (!token) return false;
  const expected = tokens(db).find((t) => t.origin === origin);
  if (!expected) return false;
  return timingSafeEqual(Buffer.from(sha(token)), Buffer.from(expected.hash));
}

export function unpairAll(db: Db): void {
  kvSet(db, TOKENS_KEY, undefined);
  kvSet(db, CODE_KEY, undefined);
}

export function extensionPaired(db: Db): boolean {
  return tokens(db).length > 0;
}
