import { useCallback, useState } from "react";
import { post } from "./api.ts";

export function useAction(refresh: () => Promise<void>) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (key: string, fn: () => Promise<unknown>) => {
      setBusy(key);
      setError(null);
      try {
        await fn();
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );
  return { busy, error, run, setError };
}

export type Act = ReturnType<typeof useAction>;

export function Badge({ kind, children }: { kind: "live" | "mock" | "demo" | "problem" | "plain"; children: React.ReactNode }) {
  return <span className={`badge ${kind === "plain" ? "" : `badge--${kind}`}`}>{children}</span>;
}

export const connectGoogle = (act: Act, gmail = false) =>
  act.run(gmail ? "connect-gmail" : "connect-google", async () => {
    const r = await post<{ authorizationUrl: string }>("/api/google/connect", gmail ? { gmail: true } : {});
    window.location.href = r.authorizationUrl;
  });

export const connectFo = (act: Act) =>
  act.run("connect-fo", async () => {
    const r = await post<{ authorizationUrl: string }>("/api/fo/connect");
    window.location.href = r.authorizationUrl;
  });

export const docWord = (t: string) => (t === "other" || t === "unknown" ? "Document" : t.charAt(0).toUpperCase() + t.slice(1));

export const joinPath = (path: string, name: string) => (path ? `${path}/${name}` : name);

const ICONS = {
  activity: "M3 12h4l3-8 4 16 3-8h4",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  settings: "M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  folderCheck: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 13l2 2 4-4",
  folderPlus: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10v6M9 13h6",
  folderQuestion: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM10.5 11.5a1.5 1.5 0 1 1 2 1.4c-.4.2-.5.5-.5.9M12 16.5v.01",
  chevronDown: "M6 9l6 6 6-6",
  chevronRight: "M9 6l6 6-6 6",
  arrowRight: "M5 12h14M13 6l6 6-6 6",
  external: "M7 17L17 7M9 7h8v8",
  check: "M5 12.5l4.5 4.5L19 7",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5",
  fileCheck: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 14l2 2 4-4",
  fileMove: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 14h6M13 12l2 2-2 2",
  copy: "M9 9h10v12H9zM5 15V3h10",
  history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2",
  listCheck: "M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17M11 6h9M11 12h9M11 18h9",
  refresh: "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5",
  message: "M4 5h16v11H9l-5 4z",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  alert: "M12 3l9.5 17h-19zM12 10v4M12 17v.01",
  mail: "M3 6h18v12H3zM3 7l9 6 9-6",
  undo: "M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3",
} as const;

export type IconName = keyof typeof ICONS;

/** A line icon in the text colour. Decorative: the words beside it say what it means. */
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={ICONS[name]} />
    </svg>
  );
}

export type Theme = "light" | "dark" | "system";

/** A ?theme=dark or ?theme=light in the address wins for that visit (screenshots); otherwise what you chose. */
export function initialTheme(): Theme {
  try {
    const forced = new URLSearchParams(window.location.search).get("theme");
    if (forced === "light" || forced === "dark") return forced;
    const saved = window.localStorage.getItem("kiki.theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme, remember: boolean) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  if (!remember) return;
  try {
    if (theme === "system") window.localStorage.removeItem("kiki.theme");
    else window.localStorage.setItem("kiki.theme", theme);
  } catch {
    // Private windows can refuse storage; the choice still holds for this visit.
  }
}
