import type { Project } from "../domain/types.js";
import type { Milestone } from "../domain/milestone.js";

export interface PlanningRequest {
  project: Project;
  milestone?: Milestone;
}
export interface PlanningExecutor {
  replyToDecision(
    request: PlanningRequest,
    threadId: string,
    message: string,
  ): Promise<string>;
  openThread(request: PlanningRequest): Promise<string>;
  startTurn(request: PlanningRequest, threadId: string): Promise<string>;
  requestReport(request: PlanningRequest, threadId: string): Promise<string>;
  interrupt(request: PlanningRequest): Promise<void>;
  activeTurnId?(threadId: string): Promise<string | undefined>;
  isThreadActive?(threadId: string): Promise<boolean>;
}
