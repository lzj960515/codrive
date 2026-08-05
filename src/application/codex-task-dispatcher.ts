import type { Project, Task } from "../domain/types.js";
import type { CodexGateway } from "./codex-gateway.js";
import type {
  DispatchRequest,
  TaskDispatcher,
  TurnDispatchResult,
} from "./task-dispatcher.js";

export class CodexTaskDispatcher implements TaskDispatcher {
  constructor(private readonly codex: CodexGateway) {}

  async openThread(request: DispatchRequest): Promise<string> {
    const cwd = conversationDirectory(request);
    const existingThreadId = request.task.currentExecution?.threadId;
    if (existingThreadId) {
      await this.codex.resumeThread(existingThreadId, cwd);
      return existingThreadId;
    }

    if (request.task.currentExecution?.action === "review") {
      return this.codex.startThread(cwd, threadTitle(request.project, request.task));
    }
    if (request.task.developmentThreadId) {
      await this.codex.resumeThread(request.task.developmentThreadId, cwd);
      return request.task.developmentThreadId;
    }
    return this.codex.startThread(cwd, threadTitle(request.project, request.task));
  }

  startTurn(
    request: DispatchRequest,
    threadId: string,
  ): Promise<TurnDispatchResult> {
    return this.startWhenConversationIsIdle(
      threadId,
      conversationDirectory(request),
      `请使用 $codrive-task 处理任务 ${request.task.id} 的当前阶段。`,
    );
  }

  requestReport(
    request: DispatchRequest,
    threadId: string,
  ): Promise<TurnDispatchResult> {
    return this.startWhenConversationIsIdle(
      threadId,
      conversationDirectory(request),
      `请使用 $codrive-task 汇报任务 ${request.task.id} 的当前处理结果。`,
    );
  }

  async interrupt(request: DispatchRequest): Promise<void> {
    const execution = request.task.currentExecution;
    if (execution?.threadId && execution.turnId) {
      await this.codex.interruptTurn(execution.threadId, execution.turnId);
    }
  }

  private async startWhenConversationIsIdle(
    threadId: string,
    cwd: string,
    prompt: string,
  ): Promise<TurnDispatchResult> {
    if (await this.codex.isThreadActive(threadId)) {
      return { status: "conversation_active" };
    }
    return {
      status: "started",
      turnId: await this.codex.startTurn(threadId, cwd, prompt),
    };
  }
}

function conversationDirectory({ project }: DispatchRequest): string {
  return project.repositoryPath;
}

function threadTitle(project: Project, task: Task): string {
  if (task.currentExecution?.action === "review") {
    return `[Codrive Review #${task.reviewAttempts.length}] ${project.name} · ${task.title}`;
  }
  return `[Codrive] ${project.name} · ${task.title}`;
}
