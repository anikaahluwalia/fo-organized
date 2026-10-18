// LIVE-X8: when the Drive or Fo connection check fails with an error (the Drive API isn't enabled
// in the Google Cloud project, Google is unreachable, Fo answers in a shape Kiki doesn't expect),
// /api/state carries the reason, but the web app only shows "Connect Google Drive" / "Connect Fo"
// and Kiki says "Connect Google Drive to start." Signing in again succeeds ("Connected Google
// Drive.") and the same button comes back: a loop with no explanation. The side panel shows the
// reason (extension/lib.js:235, 241); the web app drops it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveKiki } from "../../server/domain/kiki.ts";
import type { AppView } from "../../shared/api.ts";

const DRIVE_PROBLEM = "Drive refused: Google Drive API has not been used in project 123456 before or it is disabled.";
const FO_PROBLEM = "Fo's response wasn't in the documented format.";
const integrations: AppView["integrations"] = {
  drive: { mode: "live", connection: "error", account: null, message: DRIVE_PROBLEM, scopes: "full", missingScopes: [], gmail: "not_connected" },
  claude: { mode: "live", credentialsDetected: true, model: "claude-opus-5-5" },
  fo: { mode: "live", connection: "error", message: FO_PROBLEM },
};

test("Kiki says what's wrong with the Drive connection instead of asking you to connect again", () => {
  const kiki = deriveKiki({ integrations, workspace: null } as unknown as Omit<AppView, "kiki">);
  assert.match(`${kiki.label} ${kiki.detail ?? ""}`, /Drive API has not been used/, `Kiki says: ${JSON.stringify(kiki)}`);
});

/** Renders the web app's header tools and workspace card (bundled from web/src with rolldown). */
async function renderWeb(view: Partial<AppView>): Promise<string> {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const { rolldown } = await import("rolldown");
  const bundle = await rolldown({
    input: path.join(repo, "web/src/App.tsx"),
    external: (id: string) => /^react(-dom)?(\/|$)/.test(id),
    platform: "node",
    transform: { jsx: { runtime: "automatic" } },
    plugins: [{ name: "expose", transform: (code: string, id: string) => (id.endsWith("/web/src/App.tsx") ? `${code}\nexport { Integrations, WorkspaceCard };` : undefined) }],
  });
  const { output } = await bundle.generate({ format: "esm" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kiki-render-"));
  fs.symlinkSync(path.join(repo, "node_modules"), path.join(dir, "node_modules"));
  fs.writeFileSync(path.join(dir, "app.mjs"), output[0].code);
  const mod = (await import(pathToFileURL(path.join(dir, "app.mjs")).href)) as Record<string, unknown>;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const act = { busy: null, error: null, run: async () => undefined, setError: () => undefined };
  type Props = { view: Partial<AppView>; act: typeof act };
  const el = (name: string) => createElement(mod[name] as (props: Props) => null, { view, act });
  const html = renderToStaticMarkup(el("Integrations")) + renderToStaticMarkup(el("WorkspaceCard"));
  fs.rmSync(dir, { recursive: true, force: true }); // removes the node_modules link, not its target
  return html;
}

test("the web app shows why Drive and Fo aren't working, as the side panel does", async () => {
  const html = await renderWeb({ integrations, workspace: null });
  assert.ok(html.includes("Drive API has not been used") && html.includes(FO_PROBLEM.replace("'", "&#x27;")), `the page shows only: ${html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}`);
});
