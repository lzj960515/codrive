import { WorkflowConflictError } from "../domain/errors.js";
import type { ModelRoutingSettings } from "../domain/types.js";
import type { ConfigStore } from "../infrastructure/config-store.js";
import type { CodexModelOption } from "./codex-gateway.js";
import type { WorkflowEngine } from "./workflow-engine.js";

export interface RuntimeSettingsInput {
  maxConcurrentTasks: number;
  models: ModelRoutingSettings;
}

export interface ModelCatalog {
  listModels(): Promise<CodexModelOption[]>;
}

export class SystemSettingsService {
  constructor(
    private readonly configStore: ConfigStore,
    private readonly workflow: WorkflowEngine,
    private readonly modelCatalog: ModelCatalog,
  ) {}

  async read() {
    const [config, availableModels] = await Promise.all([
      this.configStore.read(),
      this.modelCatalog.listModels(),
    ]);
    return {
      settings: {
        maxConcurrentTasks: config.maxConcurrentTasks,
        models: config.models,
      },
      availableModels,
    };
  }

  async update(input: RuntimeSettingsInput) {
    const availableModels = await this.modelCatalog.listModels();
    validateSettings(input, availableModels);
    const current = await this.configStore.read();
    await this.configStore.save({ ...current, ...input });
    await this.workflow.updateRuntimeSettings(input);
    return { settings: input, availableModels };
  }
}

function validateSettings(
  input: RuntimeSettingsInput,
  availableModels: CodexModelOption[],
): void {
  if (!Number.isInteger(input.maxConcurrentTasks) || input.maxConcurrentTasks < 1) {
    throw new WorkflowConflictError("Concurrent tasks must be a positive integer");
  }
  if (input.models.primary === input.models.fallback) {
    throw new WorkflowConflictError(
      "Fallback model must differ from the primary model",
    );
  }
  const availableModelIds = new Set(availableModels.map(({ id }) => id));
  for (const model of [input.models.primary, input.models.fallback]) {
    if (!availableModelIds.has(model)) {
      throw new WorkflowConflictError(`Model ${model} is not available`);
    }
  }
}
