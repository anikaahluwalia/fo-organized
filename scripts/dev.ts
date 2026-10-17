// Runs the API server (with --watch) and the Vite dev server together. Ctrl+C stops both.
import { spawn, type ChildProcess } from "node:child_process";

const children: ChildProcess[] = [
  spawn(process.execPath, ["--env-file-if-exists=.env", "--disable-warning=ExperimentalWarning", "--watch", "server/index.ts"], { stdio: "inherit" }),
  spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["vite"], { stdio: "inherit" }),
];

function stop(): void {
  for (const child of children) child.kill("SIGTERM");
}
for (const child of children) child.on("exit", (code) => {
  stop();
  process.exitCode = code ?? 0;
});
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
