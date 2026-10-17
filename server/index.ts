import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { claudeCredentialsPresent, loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { ClaudeExtractor, MockExtractor } from "./extractor.ts";
import { createHttpServer, type FoAuth } from "./http.ts";
import { LiveFoClient } from "./fo/live.ts";
import { MockFoClient } from "./fo/mock.ts";
import { DbOAuthProvider } from "./fo/oauth.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const db = openDb(path.join(config.dataDir, "paperchase.db"));

let foAuth: FoAuth | null = null;
let fo;
if (config.foMode === "live") {
  const live = new LiveFoClient(config.foMcpUrl, new DbOAuthProvider(db, `${config.appOrigin}/api/fo/oauth/callback`));
  foAuth = { begin: () => live.beginAuth(), finish: (code, state) => live.finishAuth(code, state), disconnect: () => live.disconnect() };
  fo = live;
} else {
  fo = new MockFoClient();
}

const credentials = claudeCredentialsPresent();
const extractor = config.claudeMode === "live" ? new ClaudeExtractor(config.anthropicModel) : new MockExtractor();
const app = createApp({ db, fo, extractor, anthropicModel: config.anthropicModel, claudeCredentialsDetected: credentials });
app.recover();

const server = createHttpServer(app, config, foAuth, path.resolve(here, "../web/dist"));
server.listen(config.port, "127.0.0.1", () => {
  console.log(`Paper Chase is running at ${config.appOrigin}`);
  console.log(`  Claude extraction: ${config.claudeMode === "live" ? `live (${config.anthropicModel})${credentials ? "" : ", but no ANTHROPIC_API_KEY was found"}` : "MOCK"}`);
  console.log(`  Fo: ${config.foMode === "live" ? `live (${config.foMcpUrl})` : "MOCK, nothing is sent"}`);
});

function shutdown(): void {
  app.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
