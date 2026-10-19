import type { AppView } from "../../shared/api.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function parse<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  // Signed out (the session ran out, or you signed out elsewhere): back to the sign-in page.
  if (res.status === 401 && body.code === "login") window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, body.code);
  return body as T;
}

export async function getState(): Promise<AppView> {
  return parse<AppView>(await fetch("/api/state", { cache: "no-store" }));
}

export async function post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
  return parse<T>(await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
}

export const newId = () => crypto.randomUUID();

/** "just now", "4 minutes ago", "2 hours ago", then the date. */
export function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function time(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
