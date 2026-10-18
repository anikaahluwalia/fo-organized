import path from "node:path";

export type IntegrationMode = "live" | "mock";

/**
 * Drive scopes. Organizing files you put in Drive yourself needs the broad "drive" scope: tested
 * live, drive.readonly + drive.metadata + drive.file can read such a file but Google refuses to
 * move or rename it (403 "The user has not granted the app write access to the file"), because
 * drive.file only covers files the app created or the user opened with it. Restricting Kiki to one
 * folder is enforced by the app, not by the scope. GOOGLE_DRIVE_SCOPES=narrow keeps the narrower
 * set, which only works for files Kiki uploaded herself.
 */
export const NARROW_DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.metadata",
  "https://www.googleapis.com/auth/drive.file",
];
export const FULL_DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive"];

export interface Config {
  port: number;
  /** Origin the browser uses; also the base of the OAuth redirect URLs. */
  appOrigin: string;
  /** Extra origins allowed to call the API (the Vite dev server). */
  devOrigins: string[];
  /**
   * Kiki's public https address (a tunnel to this machine), so answer links in Fo's texts open on
   * your phone. Only the answer pages are served there. Null: texts carry no link.
   */
  publicUrl: string | null;
  /** The signing secret of Kiki's Fo webhook (registered in Wajo, pointing at <publicUrl>/hooks/fo). */
  foWebhookSecret: string | null;
  dataDir: string;
  claudeMode: IntegrationMode;
  anthropicModel: string;
  foMode: IntegrationMode;
  foMcpUrl: string;
  /** A Wajo API key for Fo (wak_…), in place of signing in. Never logged or sent to the browser. */
  foApiKey: string | null;
  driveMode: IntegrationMode;
  google: { clientId: string | null; clientSecret: string | null; scopes: string[]; scopeLabel: "narrow" | "full" };
  /** Seconds between checks of a watched Fo conversation. */
  watchIntervalSeconds: number;
  /** Seconds between read-only looks at the workspace folder, so Kiki notices new files. */
  workspacePollSeconds: number;
}

function mode(value: string | undefined, fallback: IntegrationMode): IntegrationMode {
  if (value === undefined || value === "") return fallback;
  if (value === "live" || value === "mock") return value;
  throw new Error(`Expected "live" or "mock", got "${value}"`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8787);
  // KIKI_MODE sets every integration; CLAUDE_MODE / FO_MODE / DRIVE_MODE override one at a time.
  // There is no silent fallback: live stays live even when it isn't configured or fails.
  const base = mode(env.KIKI_MODE, "live");
  const full = env.GOOGLE_DRIVE_SCOPES !== "narrow";
  const driveMode = mode(env.DRIVE_MODE, base);
  return {
    port,
    appOrigin: env.APP_ORIGIN ?? `http://localhost:${port}`,
    devOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"],
    publicUrl: /^https:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(env.KIKI_PUBLIC_URL ?? "") ? env.KIKI_PUBLIC_URL!.replace(/\/$/, "") : null,
    foWebhookSecret: env.FO_WEBHOOK_SECRET || null,
    dataDir: path.resolve(env.DATA_DIR ?? ".data"),
    claudeMode: mode(env.CLAUDE_MODE, base),
    anthropicModel: env.ANTHROPIC_MODEL ?? "claude-opus-5-5",
    foMode: mode(env.FO_MODE, base),
    foMcpUrl: env.FO_MCP_URL ?? "https://mcp.api.wajo.ai/fo",
    foApiKey: /^wak_\S+$/.test(env.FO_API_KEY ?? "") ? env.FO_API_KEY! : null,
    driveMode,
    google: {
      clientId: env.GOOGLE_CLIENT_ID || null,
      clientSecret: env.GOOGLE_CLIENT_SECRET || null,
      scopes: full ? FULL_DRIVE_SCOPES : NARROW_DRIVE_SCOPES,
      scopeLabel: full ? "full" : "narrow",
    },
    watchIntervalSeconds: Number(env.WATCH_INTERVAL_SECONDS ?? (env.FO_MODE === "mock" || base === "mock" ? 3 : 30)),
    workspacePollSeconds: Number(env.WORKSPACE_POLL_SECONDS ?? (driveMode === "mock" ? 4 : 10)),
  };
}

/** Whether the Anthropic SDK has any credential source it can find on its own. */
export function claudeCredentialsPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE);
}
