#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { CodriveServer } from "../../codrive-server.js";
import { SystemUpgradeRunner } from "../../application/system-upgrade-runner.js";
import {
  UpgradeCoordinator,
  type UpgradeRequest,
} from "../../application/upgrade-coordinator.js";
import { ConfigStore } from "../../infrastructure/config-store.js";
import { LocalServiceManager } from "../../infrastructure/local-service-manager.js";
import { ManagedResourceInstaller } from "../../infrastructure/managed-resource-installer.js";
import { NpmPackageUpgrader } from "../../infrastructure/npm-package-upgrader.js";
import { PackageVersionService } from "../../infrastructure/package-version-service.js";
import { readPackageVersion } from "../../infrastructure/package-metadata.js";
import {
  MINIMUM_NODE_MAJOR,
  supportsNodeVersion,
} from "../../infrastructure/runtime-requirements.js";
import { UpgradeStateStore } from "../../infrastructure/upgrade-state-store.js";
import type {
  PackageVersionStatus,
  UpgradeState,
} from "../../domain/system-update.js";

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
      await upgrade();
      break;
    case "_upgrade-worker":
      await runDetachedUpgradeWorker(args);
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

async function upgrade(): Promise<void> {
  const configStore = new ConfigStore();
  const config = await configStore.loadOrCreate();
  const service = localService();
  const serviceStatus = await service.status();
  if (serviceStatus.state !== "stopped") {
    const running = await service.start();
    if (await supportsUnifiedUpdateApi(running.url, config.accessToken)) {
      await upgradeThroughRunningService(config, running.url);
      return;
    }
    process.stdout.write(
      "The running Codrive predates unified updates; continuing with the compatible local updater.\n",
    );
  }

  const currentVersion = await readPackageVersion();
  const versions = new PackageVersionService({
    currentVersion,
    stateDirectory: config.stateDirectory,
  });
  process.stdout.write("Checking the latest stable Codrive release...\n");
  const checked = await versions.refresh({ force: true });
  if (checked.checkError || !checked.latestVersion) {
    throw new Error(checked.checkError?.summary ?? "npm did not return a version");
  }
  if (!checked.updateAvailable) {
    process.stdout.write(`Codrive ${currentVersion} is already current.\n`);
    await new ManagedResourceInstaller().install();
    process.stdout.write(
      "Codrive's 4 managed Skills and 1 managed Hook are synchronized.\n",
    );
    return;
  }

  const store = new UpgradeStateStore(config.stateDirectory);
  const coordinator = new UpgradeCoordinator({
    store,
    versions,
    launcher: { launch: async () => process.pid },
    stateDirectory: config.stateDirectory,
  });
  const operation = await coordinator.start(checked.latestVersion);
  if (operation.workerPid !== process.pid) {
    throw new Error(
      `Codrive is already updating to ${operation.targetVersion} in process ${operation.workerPid ?? "unknown"}`,
    );
  }
  const request: UpgradeRequest = {
    operationId: operation.operationId,
    targetVersion: operation.targetVersion,
    stateDirectory: config.stateDirectory,
  };
  process.stdout.write(`Updating Codrive to ${request.targetVersion}...\n`);
  await createUpgradeRunner(store).run(request);
  process.stdout.write(
    `Codrive ${request.targetVersion} and its managed resources are ready.\n`,
  );
}

async function supportsUnifiedUpdateApi(
  serviceUrl: string,
  accessToken: string,
): Promise<boolean> {
  const response = await fetch(`${serviceUrl}/api/system`, {
    headers: { "x-codrive-token": accessToken },
  });
  if (!response.ok) throw new Error(await response.text());
  const system = (await response.json()) as { version?: unknown };
  return typeof system.version === "object" && system.version !== null;
}

async function upgradeThroughRunningService(
  config: Awaited<ReturnType<ConfigStore["read"]>>,
  serviceUrl: string,
): Promise<void> {
  process.stdout.write("Checking the latest stable Codrive release...\n");
  const checked = await sendSystemCommand(serviceUrl, config.accessToken, {
    type: "system.check_for_updates",
    payload: {},
  });
  if (checked.version.checkError || !checked.version.latestVersion) {
    throw new Error(
      checked.version.checkError?.summary ?? "npm did not return a version",
    );
  }
  if (!checked.version.updateAvailable) {
    process.stdout.write(
      `Codrive ${checked.version.currentVersion} is already current.\n`,
    );
    await sendSystemCommand(serviceUrl, config.accessToken, {
      type: "system.install_resources",
      payload: {},
    });
    process.stdout.write(
      "Codrive's 4 managed Skills and 1 managed Hook are synchronized.\n",
    );
    return;
  }

  const accepted = await sendSystemCommand(serviceUrl, config.accessToken, {
    type: "system.start_upgrade",
    payload: { targetVersion: checked.version.latestVersion },
  });
  if (!accepted.upgrade) throw new Error("Codrive did not accept the update");
  process.stdout.write(`Updating Codrive to ${accepted.upgrade.targetVersion}...\n`);
  const completed = await waitForUpgradeCompletion(
    new UpgradeStateStore(config.stateDirectory),
    accepted.upgrade.operationId,
  );
  if (completed.phase === "failed") {
    throw new Error(completed.error?.summary ?? "Codrive update failed");
  }
  process.stdout.write(
    `Codrive ${completed.targetVersion} and its managed resources are ready.\n`,
  );
}

interface SystemUpdateResponse {
  version: PackageVersionStatus;
  upgrade: UpgradeState | null;
}

async function sendSystemCommand(
  serviceUrl: string,
  accessToken: string,
  command: Record<string, unknown>,
): Promise<SystemUpdateResponse> {
  const response = await fetch(`${serviceUrl}/api/commands`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codrive-token": accessToken,
    },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as SystemUpdateResponse;
}

async function waitForUpgradeCompletion(
  store: UpgradeStateStore,
  operationId: string,
): Promise<UpgradeState> {
  while (true) {
    const state = await store.read();
    if (state?.operationId === operationId && ["succeeded", "failed"].includes(state.phase)) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function runDetachedUpgradeWorker(args: string[]): Promise<void> {
  const [operationId, targetVersion] = args;
  if (!operationId || !targetVersion) {
    throw new Error("Invalid detached update request");
  }
  const config = await new ConfigStore().read();
  const request = {
    operationId,
    targetVersion,
    stateDirectory: config.stateDirectory,
  };
  const store = new UpgradeStateStore(config.stateDirectory);
  await waitForWorkerOwnership(store, operationId);
  await createUpgradeRunner(store).run(request);
}

function createUpgradeRunner(store: UpgradeStateStore): SystemUpgradeRunner {
  return new SystemUpgradeRunner({
    store,
    packageUpgrader: new NpmPackageUpgrader(),
    installResources: async (packageRoot, targetVersion) => {
      const installer = ManagedResourceInstaller.fromPackageRoot(
        packageRoot,
        targetVersion,
      );
      await installer.install();
      return installer.getStatus();
    },
    verifyHealth: verifyUpdatedService,
  });
}

async function waitForWorkerOwnership(
  store: UpgradeStateStore,
  operationId: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() <= deadline) {
    const state = await store.read();
    if (state?.operationId === operationId && state.workerPid === process.pid) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The update worker was not recorded as the active operation");
}

async function verifyUpdatedService(targetVersion: string): Promise<void> {
  const config = await new ConfigStore().read();
  const url = `http://${config.host}:${config.port}/api/health`;
  const deadline = Date.now() + 60_000;
  while (Date.now() <= deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        const health = (await response.json()) as {
          status?: string;
          version?: string;
        };
        if (health.status === "ok" && health.version === targetVersion) return;
        if (health.status === "ok" && health.version !== targetVersion) {
          throw new Error(
            `Codrive restarted with version ${health.version ?? "unknown"}, expected ${targetVersion}`,
          );
        }
      }
    } catch (error) {
      if (error instanceof Error && /expected/.test(error.message)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Codrive ${targetVersion} to become healthy`);
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
  const installed = await new ManagedResourceInstaller().install();
  process.stdout.write(`Codrive state initialized at ${config.stateDirectory}\n`);
  process.stdout.write(
    `Installed 4 managed Skills and 1 managed Hook:\n${[
      ...installed.skillPaths,
      installed.hookPath,
    ].map((path) => `- ${path}`).join("\n")}\n`,
  );
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
  const resources = await new ManagedResourceInstaller().getStatus();
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
    {
      name: "Managed Codrive resources",
      ok: resources.state === "current",
      detail:
        resources.state === "current"
          ? `${resources.managedSkillCount} Skills + ${resources.managedHookCount} Hook`
          : [resources.state, ...resources.conflictPaths].join(" "),
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
  process.stdout.write(`Codrive\n\nUsage:\n  codrive                         Start Codrive in the background\n  codrive start                   Start Codrive in the background\n  codrive stop                    Stop Codrive\n  codrive restart                 Restart Codrive\n  codrive upgrade                 Install the latest release and restart\n  codrive status                  Show service status\n  codrive setup                   Install Codrive Skills and Hook\n  codrive doctor                  Check runtime, Codex, login, and managed resources\n  codrive import <project.json>   Import a product\n  codrive serve                   Run in the foreground\n  codrive --version               Show the installed version\n`);
}
