import type { CodexGateway } from "./codex-gateway.js";
import type {
  DispatchRequest,
  TaskConversationAttachment,
  TaskDispatcher,
  TurnDispatchResult,
} from "./task-dispatcher.js";

interface TaskDispatchConfigReader {
  read(): Promise<{
    semanticAtlas?: { automaticMaintenance: boolean };
  }>;
}

export class CodexTaskDispatcher implements TaskDispatcher {
  constructor(
    private readonly codex: CodexGateway,
    private readonly config: TaskDispatchConfigReader,
  ) {}

  async attachConversation(
    request: DispatchRequest,
  ): Promise<TaskConversationAttachment> {
    const cwd = conversationDirectory(request);
    const existingThreadId = conversationThreadId(request);
    if (existingThreadId) {
      await this.codex.resumeThread(existingThreadId, cwd);
      return { threadId: existingThreadId, disposition: "resumed" };
    }

    const threadId = await this.codex.startThread(cwd, request.task.title);
    return { threadId, disposition: "created" };
  }

  async resumeThread(request: DispatchRequest, threadId: string): Promise<void> {
    await this.codex.resumeThread(threadId, conversationDirectory(request));
  }

  async startTurn(
    request: DispatchRequest,
    threadId: string,
  ): Promise<TurnDispatchResult> {
    return this.startWhenConversationIsIdle(
      threadId,
      conversationDirectory(request),
      await this.taskPrompt(request),
      request.task.currentExecution!.modelRouting.model,
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
      request.task.currentExecution!.modelRouting.model,
    );
  }

  async resumeScheduledTurn(
    request: DispatchRequest,
    threadId: string,
    resumePrompt: string,
  ): Promise<TurnDispatchResult> {
    const taskPrompt = await this.taskPrompt(request, true);
    const prompt =
      `任务 ${request.task.id} 的计划等待已经结束。` +
      `${taskPrompt}\n\n` +
      `等待前保存的执行检查点：\n${resumePrompt}`;
    return this.startWhenConversationIsIdle(
      threadId,
      conversationDirectory(request),
      prompt,
      request.task.currentExecution!.modelRouting.model,
    );
  }

  async interrupt(request: DispatchRequest): Promise<void> {
    const execution = request.task.currentExecution;
    if (execution?.threadId && execution.turnId) {
      await this.codex.interruptTurn(execution.threadId, execution.turnId);
    }
  }

  private async taskPrompt(
    request: DispatchRequest,
    scheduledResume = false,
  ): Promise<string> {
    const instruction = scheduledResume
      ? `请使用 $codrive-task 重新读取任务 ${request.task.id} 的当前上下文并继续原阶段`
      : `请使用 $codrive-task 处理任务 ${request.task.id} 的当前阶段`;
    if (request.task.origin?.kind === "semantic_atlas_maintenance") {
      return `${instruction}，并加载 $semantic-atlas-maintenance 处理该维护任务。`;
    }

    const config = await this.config.read();
    if (!(config.semanticAtlas?.automaticMaintenance ?? false)) {
      return `${instruction}。`;
    }
    return `${instruction}，并加载 $semantic-atlas；` +
      "由该 Skill 根据任务内容决定是否执行业务理解与记录。";
  }

  private async startWhenConversationIsIdle(
    threadId: string,
    cwd: string,
    prompt: string,
    model: string,
  ): Promise<TurnDispatchResult> {
    if (await this.codex.isThreadActive(threadId)) {
      return { status: "conversation_active" };
    }
    return {
      status: "started",
      turnId: await this.codex.startTurn(threadId, cwd, prompt, model),
    };
  }
}

function conversationThreadId(request: DispatchRequest): string | undefined {
  const action = request.task.currentExecution?.action;
  return action === "review"
    ? request.activity.conversations.reviewThreadId
    : request.activity.conversations.workThreadId;
}

function conversationDirectory({ project }: DispatchRequest): string {
  return project.repositoryPath;
}
