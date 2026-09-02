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

export interface TaskDispatchSkillAvailability {
  readonly codeReviewSkillAvailable: boolean;
}

export class CodexTaskDispatcher implements TaskDispatcher {
  constructor(
    private readonly codex: CodexGateway,
    private readonly config: TaskDispatchConfigReader,
    private readonly skillAvailability: TaskDispatchSkillAvailability,
  ) {}

  async attachConversation(
    request: DispatchRequest,
  ): Promise<TaskConversationAttachment> {
    const cwd = conversationDirectory(request);
    const existingThreadId = conversationThreadId(request);
    if (existingThreadId) {
      await this.resumeThread(request, existingThreadId);
      return { threadId: existingThreadId, disposition: "resumed" };
    }

    const threadId = await this.codex.startThread(
      cwd,
      conversationTitle(request),
    );
    return { threadId, disposition: "created" };
  }

  async resumeThread(request: DispatchRequest, threadId: string): Promise<void> {
    await this.codex.resumeThread(threadId, conversationDirectory(request));
    if (isReviewConversation(request)) {
      await this.codex.setThreadName(threadId, conversationTitle(request));
    }
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
    const codeReviewAvailable =
      isReviewConversation(request) &&
      this.skillAvailability.codeReviewSkillAvailable;
    if (request.task.origin?.kind === "semantic_atlas_maintenance") {
      return codeReviewAvailable
        ? `${instruction}，并加载 $code-review 执行独立审查；` +
            "同时加载 $semantic-atlas-maintenance 处理该维护任务。"
        : `${instruction}，并加载 $semantic-atlas-maintenance 处理该维护任务。`;
    }

    const config = await this.config.read();
    if (!(config.semanticAtlas?.automaticMaintenance ?? false)) {
      return codeReviewAvailable
        ? `${instruction}，并加载 $code-review 执行独立审查。`
        : `${instruction}。`;
    }
    return codeReviewAvailable
      ? `${instruction}，并加载 $code-review 执行独立审查；` +
          "同时加载 $semantic-atlas，由该 Skill 根据任务内容决定是否执行业务理解与记录。"
      : `${instruction}，并加载 $semantic-atlas；` +
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
  return isReviewConversation(request)
    ? request.activity.conversations.reviewThreadId
    : request.activity.conversations.workThreadId;
}

function conversationTitle(request: DispatchRequest): string {
  return isReviewConversation(request)
    ? `[review] ${request.task.title}`
    : request.task.title;
}

function isReviewConversation(request: DispatchRequest): boolean {
  return request.task.currentExecution?.action === "review";
}

function conversationDirectory({ project }: DispatchRequest): string {
  return project.repositoryPath;
}
