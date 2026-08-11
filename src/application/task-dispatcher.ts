import type { Project, Task } from "../domain/types.js";
import type { TaskActivityProjection } from "../domain/task-activity.js";

export interface DispatchRequest {
  project: Project;
  task: Task;
  activity: TaskActivityProjection;
}

export type TurnDispatchResult =
  | { status: "started"; turnId: string }
  | { status: "conversation_active" };

export interface TaskDispatcher {
  openThread(request: DispatchRequest): Promise<string>;
  startTurn(
    request: DispatchRequest,
    threadId: string,
  ): Promise<TurnDispatchResult>;
  requestReport(
    request: DispatchRequest,
    threadId: string,
  ): Promise<TurnDispatchResult>;
  interrupt(request: DispatchRequest): Promise<void>;
}
