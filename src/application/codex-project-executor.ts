import type { Project } from "../domain/types.js";
import type { CodexGateway } from "./codex-gateway.js";
import type { ProjectExecutor } from "./project-executor.js";

export class CodexProjectExecutor implements ProjectExecutor {
  constructor(private readonly codex: CodexGateway) {}

  async openThread(project: Project): Promise<string> {
    const existingThreadId = project.currentExecution?.threadId;
    if (existingThreadId) {
      await this.codex.resumeThread(existingThreadId, project.repositoryPath);
      return existingThreadId;
    }
    return this.codex.startThread(
      project.repositoryPath,
      `[Codrive Selection] ${project.name}`,
      { ephemeral: true },
    );
  }

  startTurn(project: Project, threadId: string): Promise<string> {
    return this.codex.startTurn(
      threadId,
      project.repositoryPath,
      `请使用 $codrive-task 为项目 ${project.id} 选择当前适合开始的任务。`,
      project.currentExecution!.modelRouting.model,
    );
  }

  requestReport(project: Project, threadId: string): Promise<string> {
    return this.codex.startTurn(
      threadId,
      project.repositoryPath,
      `请使用 $codrive-task 汇报项目 ${project.id} 的当前处理结果。`,
      project.currentExecution!.modelRouting.model,
    );
  }

  async interrupt(project: Project): Promise<void> {
    const execution = project.currentExecution;
    if (execution?.threadId && execution.turnId) {
      await this.codex.interruptTurn(execution.threadId, execution.turnId);
    }
  }
}
