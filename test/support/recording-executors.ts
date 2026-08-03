import type { ProjectExecutor } from "../../src/application/project-executor.js";
import type {
  DispatchRequest,
  TaskDispatcher,
} from "../../src/application/task-dispatcher.js";
import type { Project } from "../../src/domain/types.js";

export class RecordingTaskDispatcher implements TaskDispatcher {
  readonly opened: DispatchRequest[] = [];
  readonly started: Array<DispatchRequest & { threadId: string }> = [];
  readonly reminders: Array<DispatchRequest & { threadId: string }> = [];
  readonly interrupted: DispatchRequest[] = [];
  beforeStartTurn?: (request: DispatchRequest, threadId: string) => Promise<void>;

  async openThread(request: DispatchRequest): Promise<string> {
    this.opened.push(request);
    return `task_thread_${this.opened.length}`;
  }

  async startTurn(request: DispatchRequest, threadId: string): Promise<string> {
    await this.beforeStartTurn?.(request, threadId);
    this.started.push({ ...request, threadId });
    return `task_turn_${this.started.length}`;
  }

  async requestReport(
    request: DispatchRequest,
    threadId: string,
  ): Promise<string> {
    this.reminders.push({ ...request, threadId });
    return `task_reminder_${this.reminders.length}`;
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
