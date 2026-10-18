/**
 * Keeping secrets out of what Kiki shows, saves and logs. An error from a library can carry the
 * value it choked on (an API key in a header, say); before any error text reaches the app, the
 * database or the log, the secrets Kiki holds, and anything shaped like one, are blacked out.
 */
import { all, run, type Db } from "./db.ts";

const SECRET_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GOOGLE_CLIENT_SECRET", "FO_API_KEY", "FO_WEBHOOK_SECRET", "KIKI_PASSWORD"];
const SHAPES = [/sk-ant-[A-Za-z0-9_-]{8,}/g, /\bwak_[A-Za-z0-9_-]{8,}/g, /\bwhsec_[A-Za-z0-9+/=_-]{8,}/g, /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, /\bya29\.[A-Za-z0-9._-]{8,}/g, /\b1\/\/[A-Za-z0-9._-]{16,}/g];

export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const name of SECRET_VARS) {
    const value = env[name];
    if (!value || value.length < 8) continue;
    // The value as set, and its first word (what was meant to be the secret when a comment rode along).
    for (const v of new Set([value, value.trim().split(/\s+/)[0]!])) if (v.length >= 8) out = out.split(v).join("[hidden]");
  }
  for (const shape of SHAPES) out = out.replace(shape, "[hidden]");
  return out;
}

/** Secret variables set with something besides the secret (a space, a "# comment"): named, never shown. */
export function malformedSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  return ["ANTHROPIC_API_KEY", "FO_API_KEY", "FO_WEBHOOK_SECRET", "GOOGLE_CLIENT_SECRET"].filter((name) => env[name] !== undefined && env[name] !== "" && /\s|#/.test(env[name]!));
}

/** On start: error text saved before it was blacked out (a document's read error, a Fo request's failure) is cleaned. */
export function scrubSaved(db: Db, env: NodeJS.ProcessEnv = process.env): number {
  let n = 0;
  for (const [table, column] of [
    ["documents", "read_error"],
    ["fo_tasks", "failure_detail"],
    ["fo_tasks", "poll_error"],
  ] as const) {
    for (const row of all<{ rowid: number; text: string }>(db, `SELECT rowid, ${column} AS text FROM ${table} WHERE ${column} IS NOT NULL`)) {
      const clean = redact(row.text, env);
      if (clean !== row.text) {
        run(db, `UPDATE ${table} SET ${column} = ? WHERE rowid = ?`, clean, row.rowid);
        n++;
      }
    }
  }
  return n;
}
