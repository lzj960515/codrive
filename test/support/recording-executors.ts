import type { ProjectExecutor } from "../../src/application/project-executor.js";
import type {
  DispatchRequest,
  TaskDispatcher,
  TurnDispatchResult,
} from "../../src/application/task-dispatcher.js";
import type { Project } from "../../src/domain/types.js";

export const testModels = {
  primary: "gpt-5.6-sol",
  fallback: "gpt-5.6-terra",
};

export function testModelRouting() {
  return {
    model: testModels.primary,
    route: "primary" as const,
    retryCount: 0,
  };
}

export class RecordingTaskDispatcher implements TaskDispatcher {
  readonly opened: DispatchRequest[] = [];
  readonly resumed: Array<DispatchRequest & { threadId: string }> = [];
  readonly started: Array<DispatchRequest & { threadId: string; model: string }> = [];
  readonly reminders: Array<DispatchRequest & { threadId: string; model: string }> = [];
  readonly scheduledResumes: Array<
    DispatchRequest & { threadId: string; model: string; resumePrompt: string }
  > = [];
  readonly interrupted: DispatchRequest[] = [];
  beforeStartTurn?: (request: DispatchRequest, threadId: string) => Promise<void>;
  beforeResumeThread?: (request: DispatchRequest, threadId: string) => Promise<void>;
  conversationActive = false;

  async openThread(request: DispatchRequest): Promise<string> {
    this.opened.push(request);
    return `task_thread_${this.opened.length}`;
  }

  async resumeThread(request: DispatchRequest, threadId: string): Promise<void> {
    await this.beforeResumeThread?.(request, threadId);
    this.resumed.push({ ...request, threadId });
  }

  async startTurn(
    request: DispatchRequest,
    threadId: string,
  ): Promise<TurnDispatchResult> {
    if (this.conversationActive) return { status: "conversation_active" };
    await this.beforeStartTurn?.(request, threadId);
    this.started.push({
      ...request,
      threadId,
      model: request.task.currentExecution!.modelRouting.model,
    });
    return { status: "started", turnId: `task_turn_${this.started.length}` };
  }

  async requestReport(
    request: DispatchRequest,
    threadId: string,
  ): Promise<TurnDispatchResult> {
    if (this.conversationActive) return { status: "conversation_active" };
    this.reminders.push({
      ...request,
      threadId,
      model: request.task.currentExecution!.modelRouting.model,
    });
    return {
      status: "started",
      turnId: `task_reminder_${this.reminders.length}`,
    };
  }

  async resumeScheduledTurn(
    request: DispatchRequest,
    threadId: string,
    resumePrompt: string,
  ): Promise<TurnDispatchResult> {
    if (this.conversationActive) return { status: "conversation_active" };
    this.scheduledResumes.push({
      ...request,
      threadId,
      resumePrompt,
      model: request.task.currentExecution!.modelRouting.model,
    });
    return {
      status: "started",
      turnId: `task_scheduled_resume_${this.scheduledResumes.length}`,
    };
  }

  async interrupt(request: DispatchRequest): Promise<void> {
    this.interrupted.push(request);
  }
}

export class RecordingProjectExecutor implements ProjectExecutor {
  readonly opened: Project[] = [];
  readonly started: Array<{ project: Project; threadId: string }> = [];
  readonly reminders: Array<{ project: Project; threadId: string }> = [];
  readonly interrupted: Project[] = [];
  beforeStartTurn?: (project: Project, threadId: string) => Promise<void>;

  async openThread(project: Project): Promise<string> {
    this.opened.push(project);
    return `project_thread_${this.opened.length}`;
  }

  async startTurn(project: Project, threadId: string): Promise<string> {
    await this.beforeStartTurn?.(project, threadId);
    this.started.push({ project, threadId });
    return `project_turn_${this.started.length}`;
  }

  async requestReport(project: Project, threadId: string): Promise<string> {
    this.reminders.push({ project, threadId });
    return `project_reminder_${this.reminders.length}`;
  }

  async interrupt(project: Project): Promise<void> {
    this.interrupted.push(project);
  }
}
