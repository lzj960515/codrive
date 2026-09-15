import type { CodexGateway } from "./codex-gateway.js";
import type { PlanningExecutor, PlanningRequest } from "./planning-executor.js";

export class CodexPlanningExecutor implements PlanningExecutor {
  constructor(private readonly codex: CodexGateway) {}
  async openThread({ project, milestone }: PlanningRequest): Promise<string> {
    const threadId = milestone ? milestone.threadId : project.planningThreadId;
    const title = milestone
      ? `[里程碑] ${milestone.title}`
      : `[调度] ${project.name}`;
    if (threadId) {
      await this.codex.resumeThread(threadId, project.repositoryPath);
      await this.codex.setThreadName(threadId, title);
      return threadId;
    }
    return this.codex.startThread(project.repositoryPath, title);
  }
  startTurn(request: PlanningRequest, threadId: string): Promise<string> {
    return this.turn(request, threadId, false);
  }
  requestReport(request: PlanningRequest, threadId: string): Promise<string> {
    return this.turn(request, threadId, true);
  }
  private turn(
    { project, milestone }: PlanningRequest,
    threadId: string,
    reminder: boolean,
  ): Promise<string> {
    const execution = (milestone ?? project).currentExecution!;
    const target = milestone ? `里程碑 ${milestone.id}` : `项目 ${project.id}`;
    const action = reminder
      ? "汇报当前处理结果"
      : milestone
      ? "评估当前证据并推进阶段目标"
      : "选择当前适合开始的任务";
    return this.codex.startTurn(
      threadId,
      project.repositoryPath,
      `请使用 $codrive-task 为${target}${action}。先读取当前 context 中的执行身份与事实。`,
      execution.modelRouting.model,
      execution.modelRouting.reasoningEffort,
    );
  }
  async interrupt({ project, milestone }: PlanningRequest): Promise<void> {
    const execution = (milestone ?? project).currentExecution;
    if (execution?.threadId && execution.turnId)
      await this.codex.interruptTurn(execution.threadId, execution.turnId);
  }
  async activeTurnId(threadId: string): Promise<string | undefined> {
    return (await this.codex.readTurnSnapshot(threadId, "")).activeTurnIds[0];
  }
  isThreadActive(threadId: string): Promise<boolean> {
    return this.codex.isThreadActive(threadId);
  }
}
