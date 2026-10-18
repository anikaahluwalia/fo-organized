import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { claudeCredentialsPresent, loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { ClaudeReader, MockReader } from "./extractor.ts";
import { createHttpServer, type OAuthFlow } from "./http.ts";
import { LiveFoClient } from "./fo/live.ts";
import { MockFoClient } from "./fo/mock.ts";
import { DbOAuthProvider } from "./fo/oauth.ts";
import type { FoClient } from "./fo/types.ts";
import { FakeDrive } from "./google/fake.ts";
import { LiveDrive } from "./google/live.ts";
import { FakeGmail, GMAIL_READONLY, LiveGmail, type GmailAdapter } from "./google/gmail.ts";
import { GoogleAuth } from "./google/oauth.ts";
import type { DriveAdapter } from "./google/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const db = openDb(path.join(config.dataDir, "fo-rganized.db"));

// Each integration is live or mock by configuration only. A live integration that fails stays a
// visible failure; it is never swapped for a mock behind the user's back.
let drive: DriveAdapter;
let gmail: GmailAdapter;
let googleFlow: OAuthFlow | null = null;
let googleAuth: GoogleAuth | null = null;
if (config.driveMode === "live") {
  googleAuth = new GoogleAuth(db, {
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    redirectUri: `${config.appOrigin}/api/google/oauth/callback`,
    scopes: config.google.scopes,
  });
  const auth = googleAuth;
  drive = new LiveDrive(auth);
  gmail = new LiveGmail(auth);
  googleFlow = {
    begin: async (opts) => auth.beginAuth(opts?.gmail ? [GMAIL_READONLY] : []),
    finish: (code, state) => auth.finishAuth(code, state),
    disconnect: () => auth.disconnect(),
  };
} else {
  drive = new FakeDrive("mock");
  gmail = new FakeGmail();
}

let fo: FoClient;
let foFlow: OAuthFlow | null = null;
if (config.foMode === "live") {
  const live = new LiveFoClient(config.foMcpUrl, new DbOAuthProvider(db, `${config.appOrigin}/api/fo/oauth/callback`));
  fo = live;
  foFlow = {
    begin: async () => {
      const r = await live.beginAuth();
      if ("authorizationUrl" in r) return r.authorizationUrl;
      return `${config.appOrigin}/?connected=Fo`;
    },
    finish: (code, state) => live.finishAuth(code, state),
    disconnect: () => live.disconnect(),
  };
} else {
  fo = new MockFoClient();
}

const credentials = claudeCredentialsPresent();
const reader = config.claudeMode === "live" ? new ClaudeReader(config.anthropicModel) : new MockReader();
const app = createApp({
  db,
  drive,
  gmail,
  reader,
  fo,
  anthropicModel: config.anthropicModel,
  claudeCredentialsDetected: credentials,
  google: { scopes: config.google.scopeLabel, missingScopes: () => googleAuth?.missingScopes() ?? [] },
  watchIntervalSeconds: config.watchIntervalSeconds,
  publicUrl: config.publicUrl,
  foWebhook: Boolean(config.foWebhookSecret && config.publicUrl),
  workspacePollSeconds: config.workspacePollSeconds,
});
app.recover();
app.start();

const server = createHttpServer(app, config, { google: googleFlow, fo: foFlow }, path.resolve(here, "../web/dist"));
server.listen(config.port, "127.0.0.1", () => {
  console.log(`Kiki is running at ${config.appOrigin}`);
  console.log(`  Google Drive: ${config.driveMode === "live" ? (config.google.clientId ? `live (${config.google.scopeLabel} scopes)` : "live, but GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET aren't set") : "MOCK (in-memory, nothing touches your Drive)"}`);
  console.log(`  Claude reading: ${config.claudeMode === "live" ? `live (${config.anthropicModel})${credentials ? "" : ", but no ANTHROPIC_API_KEY was found"}` : "MOCK (pattern reader)"}`);
  console.log(`  Fo: ${config.foMode === "live" ? `live (${config.foMcpUrl})` : "MOCK (nothing is sent)"}`);
  console.log(`  Answer links: ${config.publicUrl ?? "off (KIKI_PUBLIC_URL isn't set)"}`);
  console.log(`  Fo webhook: ${config.foWebhookSecret && config.publicUrl ? `on, at ${config.publicUrl}/hooks/fo` : "off (FO_WEBHOOK_SECRET isn't set)"}`);
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
