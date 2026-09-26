import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const viteEntry = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
const children = [
  spawn(process.execPath, ["scripts/api-server.mjs"], { stdio: "inherit" }),
  spawn(process.execPath, [viteEntry, "--host", "127.0.0.1"], { stdio: "inherit" }),
];

let stopping = false;

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => process.exit(exitCode), 100);
}

for (const child of children) {
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (!stopping && code !== null && code !== 0) {
      console.error(`Development service stopped with code ${code}${signal ? ` (${signal})` : ""}.`);
      stop(code);
    }
  });
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
