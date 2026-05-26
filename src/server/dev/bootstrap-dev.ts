import "dotenv/config";
import { spawn } from "node:child_process";
import { createAutoOpenBrowserRunner } from "./autoOpenBrowser";
import { resolveDevBrowserConfig } from "./config";

type ChildName = "server" | "client";

const autoOpenBrowser = createAutoOpenBrowserRunner();
const children = new Map<ChildName, ReturnType<typeof spawn>>();
let shuttingDown = false;

async function main() {
  const config = resolveDevBrowserConfig(process.env);

  children.set("server", spawnDevProcess("server", ["run", "dev:server"]));
  children.set("client", spawnDevProcess("client", ["run", "dev:client"]));

  void autoOpenBrowser(config);
}

void main().catch((error) => {
  console.error(
    `[dev:bootstrap] failed to start dev processes: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  process.exit(1);
});

process.once("SIGINT", () => {
  shutdown("SIGINT", 0);
});

process.once("SIGTERM", () => {
  shutdown("SIGTERM", 0);
});

function spawnDevProcess(name: ChildName, args: string[]) {
  const child = spawn(getNpmCommand(), args, {
    stdio: "inherit",
    env: process.env
  });

  child.once("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }

    const exitCode = typeof code === "number" ? code : 0;
    console.log(
      `[dev:bootstrap] ${name} exited${signal ? ` with signal ${signal}` : ` with code ${exitCode}`}`
    );
    shutdown(signal ?? "SIGTERM", exitCode);
  });

  child.once("error", (error) => {
    if (shuttingDown) {
      return;
    }

    console.error(`[dev:bootstrap] ${name} failed to start: ${error.message}`);
    shutdown("SIGTERM", 1);
  });

  return child;
}

function shutdown(signal: NodeJS.Signals, exitCode: number) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  for (const child of children.values()) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
  process.exit(exitCode);
}

function getNpmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
