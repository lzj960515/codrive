import type { AddressInfo } from "node:net";

import { CodexTaskDispatcher } from "./application/codex-task-dispatcher.js";
import { CodexProjectExecutor } from "./application/codex-project-executor.js";
import { RecoveryManager } from "./application/recovery-manager.js";
import { WorkflowEngine } from "./application/workflow-engine.js";
import { CodexAppServerClient } from "./infrastructure/codex-app-server-client.js";
import { ConfigStore, type CodriveConfig } from "./infrastructure/config-store.js";
import { InstanceLock } from "./infrastructure/instance-lock.js";
import { ProjectStore } from "./infrastructure/project-store.js";
import { SkillInstaller } from "./infrastructure/skill-installer.js";
import { createHttpServer } from "./interfaces/http/server.js";

export class CodriveServer {
  private readonly configStore: ConfigStore;
  private readonly lock: InstanceLock;
  private codex: CodexAppServerClient | null = null;
  private recovery: RecoveryManager | null = null;
  private http: ReturnType<typeof createHttpServer> | null = null;
  private config: CodriveConfig | null = null;

  constructor(stateDirectory?: string) {
    this.configStore = new ConfigStore(stateDirectory);
    this.lock = new InstanceLock(this.configStore.stateDirectory);
  }

  async start(): Promise<{ url: string; config: CodriveConfig }> {
    this.config = await this.configStore.loadOrCreate();
    await this.lock.acquire();

    try {
      const store = new ProjectStore(this.config.stateDirectory);
      await store.initialize();
      this.codex = new CodexAppServerClient({
        ...(this.config.codexExecutable
          ? { executable: this.config.codexExecutable }
          : {}),
        version: "0.2.0",
        onStderr: (text) => process.stderr.write(`[codex] ${text}`),
      });
      await this.codex.start();
      const dispatcher = new CodexTaskDispatcher(this.codex);
      const projectExecutor = new CodexProjectExecutor(this.codex);
      const workflow = new WorkflowEngine(store, dispatcher, {
        maxConcurrentTasks: this.config.maxConcurrentTasks,
      }, projectExecutor);
      this.http = createHttpServer({
        store,
        workflow,
        skillInstaller: new SkillInstaller(),
        accessToken: this.config.accessToken,
      });
      await this.http.listen({ host: this.config.host, port: this.config.port });
      const address = this.http.server.address() as AddressInfo;
      if (this.config.port !== address.port) {
        this.config = { ...this.config, port: address.port };
        await this.configStore.save(this.config);
      }

      this.recovery = new RecoveryManager(store, workflow, this.codex);
      await this.recovery.start();
      return {
        url: `http://${this.config.host}:${this.config.port}`,
        config: this.config,
      };
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.recovery?.stop();
    this.recovery = null;
    await this.http?.close();
    this.http = null;
    await this.codex?.stop();
    this.codex = null;
    await this.lock.release();
  }
}
