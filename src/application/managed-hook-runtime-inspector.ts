import {
  inspectManagedHookRuntime,
  type ManagedHookRuntimeStatus,
  type RuntimeHookDefinition,
} from "../domain/managed-hook.js";

export interface HookRuntimeGateway {
  listHooks(cwds: string[]): Promise<RuntimeHookDefinition[]>;
}

export interface HookRuntimeStatusReader {
  read(): Promise<ManagedHookRuntimeStatus>;
}

export class ManagedHookRuntimeInspector implements HookRuntimeStatusReader {
  constructor(
    private readonly gateway: HookRuntimeGateway,
    private readonly cwd = process.cwd(),
  ) {}

  async read(): Promise<ManagedHookRuntimeStatus> {
    try {
      return inspectManagedHookRuntime(
        await this.gateway.listHooks([this.cwd]),
      );
    } catch {
      return { state: "unavailable", definitionCount: 0 };
    }
  }
}
