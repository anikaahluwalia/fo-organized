// Secrets never reach what Kiki shows, saves or logs: an API key in a library's error is blacked
// out, a malformed secret variable stops her from starting (named, not shown), and error text saved
// before is cleaned when she starts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { configProblems, loadConfig } from "../server/config.ts";
import { openDb, run } from "../server/db.ts";
import { malformedSecrets, redact, scrubSaved } from "../server/secrets.ts";

const KEY = "sk-ant-api03-" + "x".repeat(40);

test("an API key inside an error message is blacked out, whatever its shape", () => {
  const env = { ANTHROPIC_API_KEY: `${KEY} # ANTHROPIC_MODEL=claude-opus-5-5` };
  const message = `Headers.append: "${KEY} # ANTHROPIC_MODEL=claude-opus-5-5" is an invalid header value.`;
  const clean = redact(message, env);
  assert.doesNotMatch(clean, /sk-ant/);
  assert.match(clean, /\[hidden\]/);
  assert.doesNotMatch(redact(`Authorization: Bearer wak_${"y".repeat(30)}`, {}), /wak_y/);
  assert.equal(redact("Couldn't reach Claude.", env), "Couldn't reach Claude.", "ordinary text is left alone");
});

test("a secret variable with a comment or space after it stops Kiki from starting, named but not shown", () => {
  const env = { ANTHROPIC_API_KEY: `${KEY} # model`, FO_API_KEY: "wak_abc" };
  assert.deepEqual(malformedSecrets(env), ["ANTHROPIC_API_KEY"]);
  const problems = configProblems(loadConfig(env), env);
  assert.match(problems.join(" "), /ANTHROPIC_API_KEY has a space or a comment in it/);
  assert.doesNotMatch(problems.join(" "), /sk-ant/);
});

test("error text saved before is cleaned when Kiki starts", () => {
  const db = openDb(":memory:");
  run(db, "INSERT INTO workspaces (id, root_file_id, name, origin, mode, active, created_at) VALUES ('w', 'r', 'W', 'selected', 'mock', 1, '2026-01-01')");
  run(db, "INSERT INTO documents (id, workspace_id, file_id, read_status, read_error, updated_at) VALUES ('d', 'w', 'f', 'failed', ?, '2026-01-01')", `Headers.append: "${KEY}" is an invalid header value.`);
  assert.equal(scrubSaved(db, {}), 1);
  const saved = (db.prepare("SELECT read_error FROM documents WHERE id = 'd'").get() as { read_error: string }).read_error;
  assert.doesNotMatch(saved, /sk-ant/);
});
