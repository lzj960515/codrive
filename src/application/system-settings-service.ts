import { WorkflowConflictError } from "../domain/errors.js";
import type { ModelRoutingSettings } from "../domain/types.js";
import type { SemanticAtlasClient } from "../domain/semantic-atlas.js";
import type { ConfigStore } from "../infrastructure/config-store.js";
import type { CodexModelOption } from "./codex-gateway.js";
import type { WorkflowEngine } from "./workflow-engine.js";

export interface RuntimeSettingsInput {
  maxConcurrentTasks: number;
  models: ModelRoutingSettings;
  semanticAtlasAutomaticMaintenance?: boolean;
}

export interface ProjectModelSettingsInput {
  modelConfig: ModelRoutingSettings | null;
}

export interface ModelCatalog {
  listModels(): Promise<CodexModelOption[]>;
}

export interface SemanticAtlasSettingsCoordinator {
  settingsChanged(): Promise<void>;
}

export class SystemSettingsService {
  constructor(
    private readonly configStore: ConfigStore,
    private readonly workflow: WorkflowEngine,
    private readonly modelCatalog: ModelCatalog,
    private readonly semanticAtlas: Pick<SemanticAtlasClient, "readInstallation"> = {
      readInstallation: async () => ({ installed: false }),
    },
    private readonly maintenance: SemanticAtlasSettingsCoordinator = {
      settingsChanged: async () => undefined,
    },
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async read() {
    const [config, availableModels, installation] = await Promise.all([
      this.configStore.read(),
      this.modelCatalog.listModels(),
      this.semanticAtlas.readInstallation(),
    ]);
    return {
      settings: {
        maxConcurrentTasks: config.maxConcurrentTasks,
        models: config.models,
      },
      availableModels,
      semanticAtlas: {
        installed: installation.installed,
        automaticMaintenance: config.semanticAtlas?.automaticMaintenance ?? false,
      },
    };
  }

  async update(input: RuntimeSettingsInput) {
    const [availableModels, installation] = await Promise.all([
      this.modelCatalog.listModels(),
      this.semanticAtlas.readInstallation(),
    ]);
    validateSettings(input, availableModels);
    const current = await this.configStore.read();
    const requestedAutomaticMaintenance = input.semanticAtlasAutomaticMaintenance;
    const automaticMaintenance = requestedAutomaticMaintenance
      ?? current.semanticAtlas?.automaticMaintenance
      ?? false;
    if (requestedAutomaticMaintenance === true && !installation.installed) {
      throw new WorkflowConflictError(
        "Semantic Atlas must be installed before automatic maintenance can be enabled",
      );
    }
    const wasEnabled = current.semanticAtlas?.automaticMaintenance ?? false;
    const semanticAtlas = {
      automaticMaintenance,
      ...(!wasEnabled && automaticMaintenance
        ? { enabledAt: this.now() }
        : current.semanticAtlas?.enabledAt
        ? { enabledAt: current.semanticAtlas.enabledAt }
        : {}),
    };
    await this.configStore.save({
      ...current,
      maxConcurrentTasks: input.maxConcurrentTasks,
      models: input.models,
      semanticAtlas,
    });
    await this.workflow.updateRuntimeSettings(input);
    await this.maintenance.settingsChanged();
    return {
      settings: {
        maxConcurrentTasks: input.maxConcurrentTasks,
        models: input.models,
      },
      availableModels,
      semanticAtlas: { installed: installation.installed, automaticMaintenance },
    };
  }

  async readProject(projectId: string) {
    const [config, availableModels, modelConfig] = await Promise.all([
      this.configStore.read(),
      this.modelCatalog.listModels(),
      this.workflow.readProjectModelConfig(projectId),
    ]);
    return projectSettingsResponse(config.models, availableModels, modelConfig);
  }

  async updateProject(projectId: string, input: ProjectModelSettingsInput) {
    const [config, availableModels] = await Promise.all([
      this.configStore.read(),
      this.modelCatalog.listModels(),
    ]);
    if (input.modelConfig) validateModels(input.modelConfig, availableModels);
    await this.workflow.updateProjectModelConfig(projectId, input.modelConfig);
    return projectSettingsResponse(
      config.models,
      availableModels,
      input.modelConfig,
    );
  }
}

function validateSettings(
  input: RuntimeSettingsInput,
  availableModels: CodexModelOption[],
): void {
  if (!Number.isInteger(input.maxConcurrentTasks) || input.maxConcurrentTasks < 1) {
    throw new WorkflowConflictError("Concurrent tasks must be a positive integer");
  }
  validateModels(input.models, availableModels);
}

function validateModels(
  models: ModelRoutingSettings,
  availableModels: CodexModelOption[],
): void {
  if (models.primary === models.fallback) {
    throw new WorkflowConflictError(
      "Fallback model must differ from the primary model",
    );
  }
  const availableModelIds = new Set(availableModels.map(({ id }) => id));
  for (const model of [models.primary, models.fallback]) {
    if (!availableModelIds.has(model)) {
      throw new WorkflowConflictError(`Model ${model} is not available`);
    }
  }
}

function projectSettingsResponse(
  globalModels: ModelRoutingSettings,
  availableModels: CodexModelOption[],
  modelConfig: ModelRoutingSettings | null,
) {
  return {
    settings: {
      modelConfig,
      effectiveModels: modelConfig ?? globalModels,
      source: modelConfig ? ("project" as const) : ("global" as const),
    },
    globalModels,
    availableModels,
  };
}
