#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { CodriveServer } from "../../codrive-server.js";
import { ConfigStore } from "../../infrastructure/config-store.js";
import { LocalServiceManager } from "../../infrastructure/local-service-manager.js";
import { NpmPackageUpgrader } from "../../infrastructure/npm-package-upgrader.js";
import { readPackageVersion } from "../../infrastructure/package-metadata.js";
import {
  MINIMUM_NODE_MAJOR,
  supportsNodeVersion,
} from "../../infrastructure/runtime-requirements.js";
import { SkillInstaller } from "../../infrastructure/skill-installer.js";

const [command = "start", ...args] = process.argv.slice(2);

try {
  switch (command) {
    case "start":
      await startService();
      break;
    case "serve":
      await serveForeground();
      break;
    case "stop":
      await stopService();
      break;
    case "restart":
      await restartService();
      break;
    case "upgrade":
      upgrade();
      break;
    case "setup":
      await setup();
      break;
    case "status":
      await status();
      break;
    case "doctor":
      await doctor();
      break;
    case "import":
      await importProject(args[0]);
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    case "version":
    case "--version":
    case "-v":
      process.stdout.write(`${await readPackageVersion()}\n`);
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  process.stderr.write(`Codrive: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function localService(): LocalServiceManager {
  return new LocalServiceManager({ entryPath: fileURLToPath(import.meta.url) });
}

async function startService(): Promise<void> {
  const result = await localService().start();
  process.stdout.write(
    result.outcome === "started"
      ? `Codrive started at ${result.url}\n`
      : `Codrive is already running at ${result.url}\n`,
  );
}

async function stopService(): Promise<void> {
  const result = await localService().stop();
  process.stdout.write(
    result.outcome === "stopped"
      ? "Codrive stopped.\n"
      : "Codrive is already stopped.\n",
  );
}

async function restartService(): Promise<void> {
  const result = await localService().restart();
  process.stdout.write(`Codrive restarted at ${result.url}\n`);
}

function upgrade(): void {
  process.stdout.write("Installing the latest Codrive release...\n");
  new NpmPackageUpgrader().upgrade();
  process.stdout.write("Codrive was upgraded and restarted.\n");
}

async function serveForeground(): Promise<void> {
  const server = new CodriveServer();
  const started = await server.start();
  process.stdout.write(`Codrive is running at ${started.url}\n`);
  process.stdout.write(`State: ${started.config.stateDirectory}\n`);
  process.stdout.write(`Logs: ${started.logPath}\n`);
  process.stdout.write(
    "Codex tasks run non-interactively with full local access to complete Git workflows.\n",
  );

  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await server.stop();
      resolve();
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
  });
}

async function setup(): Promise<void> {
  const configStore = new ConfigStore();
  const config = await configStore.loadOrCreate();
  const installed = await new SkillInstaller().install();
  process.stdout.write(`Codrive state initialized at ${config.stateDirectory}\n`);
  process.stdout.write(`Installed ${installed.length} Skills:\n${installed.map((path) => `- ${path}`).join("\n")}\n`);
  await doctor();
}

async function status(): Promise<void> {
  const current = await localService().status();
  if (current.state === "running") {
    process.stdout.write(`Codrive is running at ${current.url}\n`);
    return;
  }
  if (current.state === "starting") {
    process.stdout.write(`Codrive is starting with PID ${current.pid}.\n`);
    return;
  }
  process.stdout.write("Codrive is not running. Start it with codrive.\n");
  process.exitCode = 1;
}

async function doctor(): Promise<void> {
  const require = createRequire(import.meta.url);
  const script = require.resolve("@openai/codex/bin/codex.js");
  const codex = spawnSync(process.execPath, [script, "--version"], { encoding: "utf8" });
  const login = spawnSync(process.execPath, [script, "login", "status"], {
    encoding: "utf8",
  });
  const checks = [
    {
      name: `Node.js ${MINIMUM_NODE_MAJOR}+`,
      ok: supportsNodeVersion(process.versions.node),
      detail: process.version,
    },
    {
      name: "Codex executable",
      ok: codex.status === 0,
      detail: (codex.stdout || codex.stderr).trim(),
    },
    {
      name: "Codex login",
      ok: login.status === 0,
      detail: (login.stdout || login.stderr).trim(),
    },
  ];
  for (const check of checks) {
    process.stdout.write(`${check.ok ? "OK" : "FAIL"}  ${check.name}  ${check.detail}\n`);
  }
  if (checks.some(({ ok }) => !ok)) process.exitCode = 1;
}

async function importProject(path?: string): Promise<void> {
  if (!path) throw new Error("Usage: codrive import <project.json>");
  const config = await new ConfigStore().read();
  const payload = await readFile(path, "utf8");
  const response = await fetch(`http://${config.host}:${config.port}/api/commands`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codrive-token": config.accessToken,
    },
    body: JSON.stringify({ type: "project.register", payload: JSON.parse(payload) }),
  });
  if (!response.ok) throw new Error(await response.text());
  process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);
}

function printHelp(): void {
  process.stdout.write(`Codrive\n\nUsage:\n  codrive                         Start Codrive in the background\n  codrive start                   Start Codrive in the background\n  codrive stop                    Stop Codrive\n  codrive restart                 Restart Codrive\n  codrive upgrade                 Install the latest release and restart\n  codrive status                  Show service status\n  codrive setup                   Install Codrive Skills\n  codrive doctor                  Check Node.js, Codex, and login\n  codrive import <project.json>   Import a product\n  codrive serve                   Run in the foreground\n  codrive --version               Show the installed version\n`);
}
