import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CodexTaskDispatcher } from "./application/codex-task-dispatcher.js";
import { CodexProjectExecutor } from "./application/codex-project-executor.js";
import { LifecycleRecorder } from "./application/lifecycle-recorder.js";
import { RecoveryManager } from "./application/recovery-manager.js";
import { SystemSettingsService } from "./application/system-settings-service.js";
import { SystemUpdateService } from "./application/system-update-service.js";
import { UpgradeCoordinator } from "./application/upgrade-coordinator.js";
import { WorkflowEngine } from "./application/workflow-engine.js";
import { CodexAppServerClient } from "./infrastructure/codex-app-server-client.js";
import { CodriveLog } from "./infrastructure/codrive-log.js";
import { ConfigStore, type CodriveConfig } from "./infrastructure/config-store.js";
import { InstanceLock } from "./infrastructure/instance-lock.js";
import { DetachedUpgradeLauncher } from "./infrastructure/detached-upgrade-launcher.js";
import { PackageVersionService } from "./infrastructure/package-version-service.js";
import { readPackageVersion } from "./infrastructure/package-metadata.js";
import { ProjectStore } from "./infrastructure/project-store.js";
import { SkillInstaller } from "./infrastructure/skill-installer.js";
import { UpgradeStateStore } from "./infrastructure/upgrade-state-store.js";
import { createHttpServer } from "./interfaces/http/server.js";

export class CodriveServer {
  private readonly configStore: ConfigStore;
  private readonly lock: InstanceLock;
  private codex: CodexAppServerClient | null = null;
  private recovery: RecoveryManager | null = null;
  private http: ReturnType<typeof createHttpServer> | null = null;
  private config: CodriveConfig | null = null;
  private log: CodriveLog | null = null;
  private updateRecoveryTimer: NodeJS.Timeout | null = null;
  private ready = false;

  constructor(stateDirectory?: string) {
    this.configStore = new ConfigStore(stateDirectory);
    this.lock = new InstanceLock(this.configStore.stateDirectory);
  }

  async start(): Promise<{ url: string; config: CodriveConfig; logPath: string }> {
    this.ready = false;
    this.config = await this.configStore.loadOrCreate();
    this.log = new CodriveLog(join(this.config.stateDirectory, "codrive.log"));
    this.log.info("Codrive is starting");
    try {
      await this.lock.acquire();
    } catch (error) {
      this.log.error(
        "codrive",
        error instanceof Error ? error.message : String(error),
      );
      this.log.close();
      this.log = null;
      throw error;
    }

    try {
      const store = new ProjectStore(this.config.stateDirectory);
      await store.initialize();
      const version = await readPackageVersion();
      this.codex = new CodexAppServerClient({
        ...(this.config.codexExecutable
          ? { executable: this.config.codexExecutable }
          : {}),
        version,
        onStderr: (text) => this.log!.write("codex", text),
      });
      await this.codex.start();
      const dispatcher = new CodexTaskDispatcher(this.codex);
      const projectExecutor = new CodexProjectExecutor(this.codex);
      const lifecycle = new LifecycleRecorder(store, {
        onEvent: (event) => this.log!.event(event),
      });
      const workflow = new WorkflowEngine(
        store,
        dispatcher,
        {
          maxConcurrentTasks: this.config.maxConcurrentTasks,
          models: this.config.models,
        },
        projectExecutor,
        lifecycle,
      );
      const settingsService = new SystemSettingsService(
        this.configStore,
        workflow,
        this.codex,
      );
      const skillInstaller = new SkillInstaller();
      const versions = new PackageVersionService({
        currentVersion: version,
        stateDirectory: this.config.stateDirectory,
      });
      const upgradeStore = new UpgradeStateStore(this.config.stateDirectory);
      const upgrades = new UpgradeCoordinator({
        store: upgradeStore,
        versions,
        launcher: new DetachedUpgradeLauncher(
          fileURLToPath(new URL("./interfaces/cli/index.js", import.meta.url)),
        ),
        stateDirectory: this.config.stateDirectory,
      });
      await upgrades.reconcile();
      this.updateRecoveryTimer = setInterval(() => {
        void upgrades.reconcile().catch((error: unknown) => {
          this.log?.error(
            "updates",
            error instanceof Error ? error.message : String(error),
          );
        });
      }, 1_000);
      this.updateRecoveryTimer.unref();
      const systemUpdateService = new SystemUpdateService(
        versions,
        upgrades,
        skillInstaller,
      );
      this.http = createHttpServer({
        store,
        workflow,
        skillInstaller,
        settingsService,
        systemUpdateService,
        currentVersion: version,
        accessToken: this.config.accessToken,
        isReady: () => this.ready,
        onError: (message) => this.log!.error("http", message),
      });
      await this.http.listen({ host: this.config.host, port: this.config.port });
      const address = this.http.server.address() as AddressInfo;
      if (this.config.port !== address.port) {
        this.config = { ...this.config, port: address.port };
        await this.configStore.save(this.config);
      }

      this.recovery = new RecoveryManager(store, workflow, this.codex);
      await this.recovery.start();
      this.ready = true;
      void versions.refresh().catch((error: unknown) => {
        this.log?.error(
          "updates",
          error instanceof Error ? error.message : String(error),
        );
      });
      const url = `http://${this.config.host}:${this.config.port}`;
      this.log.info(`Codrive is running at ${url}`);
      return {
        url,
        config: this.config,
        logPath: this.log.path,
      };
    } catch (error) {
      this.log?.error(
        "codrive",
        error instanceof Error ? error.message : String(error),
      );
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.ready = false;
    if (this.updateRecoveryTimer) clearInterval(this.updateRecoveryTimer);
    this.updateRecoveryTimer = null;
    this.recovery?.stop();
    this.recovery = null;
    await this.http?.close();
    this.http = null;
    await this.codex?.stop();
    this.codex = null;
    await this.lock.release();
    this.log?.info("Codrive stopped");
    this.log?.close();
    this.log = null;
  }
}
