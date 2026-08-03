import type { Project, Task } from "../domain/types.js";

export interface DispatchRequest {
  project: Project;
  task: Task;
}

export interface TaskDispatcher {
  openThread(request: DispatchRequest): Promise<string>;
  startTurn(request: DispatchRequest, threadId: string): Promise<string>;
  requestReport(request: DispatchRequest, threadId: string): Promise<string>;
  interrupt(request: DispatchRequest): Promise<void>;
}
