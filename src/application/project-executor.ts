import type { Project } from "../domain/types.js";

export interface ProjectExecutor {
  openThread(project: Project): Promise<string>;
  startTurn(project: Project, threadId: string): Promise<string>;
  requestReport(project: Project, threadId: string): Promise<string>;
  interrupt(project: Project): Promise<void>;
}
