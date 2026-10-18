/**
 * Signing in to Kiki, for when she's online and anyone can reach her address. There's one account
 * holder and one password (KIKI_PASSWORD, server-side only). A session is a random token in an
 * HttpOnly cookie; Kiki keeps only its hash, so a copy of her database can't sign anyone in.
 * Answer links and Fo's webhook carry their own proof (the link's token, Wajo's signature) and
 * don't need it; neither does the paired side panel, which has its own token.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { kvGet, kvSet, type Db } from "./db.ts";

export const SESSION_COOKIE = "kiki_session";
const SESSION_DAYS = 30;
/** Wrong passwords from one place before it has to wait, and how long. */
const LOCK_AFTER = 10;
const LOCK_MS = 15 * 60_000;

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
const key = (token: string) => `session.${digest(token).toString("hex")}`;

/** The same time whatever's typed, so timing doesn't tell how close a guess was. */
export function passwordMatches(expected: string, given: string): boolean {
  return timingSafeEqual(digest(expected), digest(given));
}

export function startSession(db: Db): { token: string; maxAgeSeconds: number } {
  const token = randomBytes(32).toString("base64url");
  kvSet(db, key(token), new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString());
  return { token, maxAgeSeconds: SESSION_DAYS * 86_400 };
}

export function sessionValid(db: Db, token: string | null): boolean {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const until = kvGet(db, key(token));
  return Boolean(until && Date.parse(until) > Date.now());
}

export function endSession(db: Db, token: string | null): void {
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) kvSet(db, key(token), undefined);
}

export function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || null;
  }
  return null;
}

export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

/** Wrong passwords, counted per place they come from: too many and that place waits a while. */
export class LoginLimiter {
  private readonly failures = new Map<string, { n: number; until: number }>();

  waitMs(from: string, now = Date.now()): number {
    const f = this.failures.get(from);
    return f && f.until > now ? f.until - now : 0;
  }

  failed(from: string, now = Date.now()): void {
    const f = this.failures.get(from) ?? { n: 0, until: 0 };
    f.n += 1;
    if (f.n >= LOCK_AFTER) {
      f.until = now + LOCK_MS;
      f.n = 0;
    }
    this.failures.set(from, f);
    if (this.failures.size > 10_000) this.failures.clear();
  }

  succeeded(from: string): void {
    this.failures.delete(from);
  }
}

/** Where to go after signing in: a path on this site only. */
export function safeNext(next: string | null | undefined): string {
  return next && /^\/(?![/\\])[\w\-./?=&%]*$/.test(next) && !next.startsWith("/login") ? next : "/";
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function loginPage(next: string, notice?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kiki</title>
<style>
:root{--bg:#fff7f9;--ink:#3a2620;--muted:#7a6460;--line:#f0d5dc;--accent:#3a2620}
@media (prefers-color-scheme:dark){:root{--bg:#1f1719;--ink:#f7e9ec;--muted:#c9b3b8;--line:#4a3438;--accent:#f4b6c4}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,system-ui,sans-serif}
main{max-width:360px;margin:0 auto;padding:64px 16px}
h1{font-size:24px;margin:0 0 4px}p{color:var(--muted);margin:0 0 20px}
label{display:block;font-size:14px;color:var(--muted);margin:0 0 6px}
input{width:100%;box-sizing:border-box;font:inherit;padding:12px;border:1px solid var(--line);border-radius:12px;background:transparent;color:var(--ink);margin:0 0 12px}
button{width:100%;font:inherit;padding:12px;border-radius:999px;border:0;background:var(--accent);color:var(--bg)}
.note{border:1px solid var(--line);border-radius:12px;padding:10px 12px;color:var(--ink)}
</style></head><body><main>
<h1>Kiki</h1><p>Sign in to see your folder and decisions.</p>
${notice ? `<p class="note">${esc(notice)}</p>` : ""}
<form method="post" action="/login">
  <input type="hidden" name="next" value="${esc(next)}">
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
  <button>Sign in</button>
</form>
</main></body></html>`;
}
