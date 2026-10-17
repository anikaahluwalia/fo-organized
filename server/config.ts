import path from "node:path";

export type IntegrationMode = "live" | "mock";

/**
 * Default Drive scopes, chosen to be as narrow as the workflow allows (see README):
 * - drive.readonly: read the content of existing documents to extract facts (restricted scope).
 * - drive.metadata: rename and move existing files; files.update accepts it (restricted scope).
 * - drive.file: create folders and the index file Kiki maintains (non-sensitive scope).
 * Kiki cannot rewrite the content of files it didn't create with these. GOOGLE_DRIVE_SCOPES=full
 * switches to the single broad "drive" scope if Google rejects the combination for an account.
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
  dataDir: string;
  claudeMode: IntegrationMode;
  anthropicModel: string;
  foMode: IntegrationMode;
  foMcpUrl: string;
  driveMode: IntegrationMode;
  google: { clientId: string | null; clientSecret: string | null; scopes: string[]; scopeLabel: "narrow" | "full" };
  /** Seconds between checks of a watched Fo conversation. */
  watchIntervalSeconds: number;
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
  const full = env.GOOGLE_DRIVE_SCOPES === "full";
  const driveMode = mode(env.DRIVE_MODE, base);
  return {
    port,
    appOrigin: env.APP_ORIGIN ?? `http://localhost:${port}`,
    devOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"],
    dataDir: path.resolve(env.DATA_DIR ?? ".data"),
    claudeMode: mode(env.CLAUDE_MODE, base),
    anthropicModel: env.ANTHROPIC_MODEL ?? "claude-opus-5-5",
    foMode: mode(env.FO_MODE, base),
    foMcpUrl: env.FO_MCP_URL ?? "https://mcp.api.wajo.ai/fo",
    driveMode,
    google: {
      clientId: env.GOOGLE_CLIENT_ID || null,
      clientSecret: env.GOOGLE_CLIENT_SECRET || null,
      scopes: full ? FULL_DRIVE_SCOPES : NARROW_DRIVE_SCOPES,
      scopeLabel: full ? "full" : "narrow",
    },
    watchIntervalSeconds: Number(env.WATCH_INTERVAL_SECONDS ?? (env.FO_MODE === "mock" || base === "mock" ? 3 : 30)),
  };
}

/** Whether the Anthropic SDK has any credential source it can find on its own. */
export function claudeCredentialsPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE);
}
