import path from "node:path";

export type IntegrationMode = "live" | "mock";

export interface Config {
  port: number;
  /** Origin the browser uses; also the base of the Fo OAuth redirect URL. */
  appOrigin: string;
  /** Extra origins allowed to call the API (the Vite dev server). */
  devOrigins: string[];
  dataDir: string;
  claudeMode: IntegrationMode;
  anthropicModel: string;
  foMode: IntegrationMode;
  foMcpUrl: string;
}

function mode(value: string | undefined, fallback: IntegrationMode): IntegrationMode {
  if (value === undefined || value === "") return fallback;
  if (value === "live" || value === "mock") return value;
  throw new Error(`Expected "live" or "mock", got "${value}"`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8787);
  // PAPERCHASE_MODE sets both integrations; CLAUDE_MODE / FO_MODE override one at a time.
  // There is no silent fallback: live stays live even when it is not configured or fails.
  const base = mode(env.PAPERCHASE_MODE, "live");
  return {
    port,
    appOrigin: env.APP_ORIGIN ?? `http://localhost:${port}`,
    devOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"],
    dataDir: path.resolve(env.DATA_DIR ?? ".data"),
    claudeMode: mode(env.CLAUDE_MODE, base),
    anthropicModel: env.ANTHROPIC_MODEL ?? "claude-opus-5-5",
    foMode: mode(env.FO_MODE, base),
    foMcpUrl: env.FO_MCP_URL ?? "https://mcp.api.wajo.ai/fo",
  };
}

/** Whether the Anthropic SDK has any credential source it can find on its own. */
export function claudeCredentialsPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE);
}
