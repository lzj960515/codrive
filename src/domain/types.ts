export type ProjectStatus =
  | "active"
  | "selecting_tasks"
  | "evaluating"
  | "waiting_for_input"
  | "stalled"
  | "completed"
  | "blocked"
  | "cancelled";

export type SchedulingStatus = "running" | "paused";
export type ProjectAction = "select_tasks" | "evaluate_product";

export interface Project {
  id: string;
  name: string;
  repositoryPath: string;
  defaultBranch: string;
  status: ProjectStatus;
  scheduling: SchedulingStatus;
  requestedAction: ProjectAction | null;
  currentExecution?: ProjectExecution;
  latestReport?: ProjectReport;
  contextNotes?: string[];
  lastSelectionFingerprint?: string;
  lastEvaluationFingerprint?: string;
  stagnantEvaluationRounds?: number;
  createdAt: string;
  updatedAt: string;
}

export type ProjectReportOutcome =
  | "selected"
  | "wait_for_active_tasks"
  | "completed"
  | "tasks_required"
  | "needs_input"
  | "blocked";

export interface ProjectReport {
  projectId: string;
  attemptId: string;
  outcome: ProjectReportOutcome;
  summary: string;
  taskIds?: string[];
  tasks?: CreateTaskInput[];
  productDocument?: string;
  question?: string;
}

export interface ProjectExecution {
  attemptId: string;
  action: ProjectAction;
  status: ExecutionStatus;
  threadId?: string;
  turnId?: string;
  startedAt: string;
  finishedAt?: string;
  turnCompletedAt?: string;
  report?: ProjectReport;
  reportReminderCount?: number;
  progressFingerprint?: string;
  leaseExpiresAt?: string;
}

export type TaskStatus =
  | "backlog"
  | "developing"
  | "reviewing"
  | "changes_requested"
  | "integrating"
  | "waiting_for_input"
  | "blocked"
  | "done"
  | "cancelled";

export type TaskAction = "develop" | "rework" | "review" | "integrate";

export type ExecutionStatus =
  | "pending"
  | "running"
  | "awaiting_report"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "interrupted";

export interface TaskExecution {
  attemptId: string;
  action: TaskAction;
  threadId?: string;
  turnId?: string;
  status: ExecutionStatus;
  startedAt: string;
  finishedAt?: string;
  turnCompletedAt?: string;
  report?: TaskReport;
  reportReminderCount?: number;
  leaseExpiresAt?: string;
}

export interface ReviewAttempt {
  attemptId: string;
  threadId?: string;
  outcome?: TaskReportOutcome;
  createdAt: string;
  completedAt?: string;
}

export type TaskReportOutcome =
  | "completed"
  | "approved"
  | "changes_requested"
  | "needs_review"
  | "needs_input"
  | "blocked";

export interface TaskReport {
  taskId: string;
  attemptId: string;
  outcome: TaskReportOutcome;
  summary: string;
  workspacePath?: string;
  baseCommit?: string;
  candidateCommit?: string;
  reviewedMainCommit?: string;
  mergedCommit?: string;
  tests?: string;
  findings?: string[];
  question?: string;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  order: number;
  status: TaskStatus;
  requestedAction: TaskAction | null;
  developmentThreadId?: string;
  reviewAttempts: ReviewAttempt[];
  currentExecution?: TaskExecution;
  workspacePath?: string;
  baseCommit?: string;
  candidateCommit?: string;
  reviewedMainCommit?: string;
  mergedCommit?: string;
  latestReport?: TaskReport;
  createdAt: string;
  updatedAt: string;
}

export interface CodriveEvent {
  eventId: string;
  type: string;
  projectId: string;
  taskId?: string;
  attemptId?: string;
  occurredAt: string;
  data?: Record<string, unknown>;
  state?: {
    project?: Project;
    task?: Task;
  };
}

export interface ProjectSnapshot {
  project: Project;
  tasks: Task[];
}

export interface CreateTaskInput {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  order?: number;
}

export interface CreateProjectInput {
  name: string;
  repositoryPath: string;
  defaultBranch: string;
  productDocument: string;
  tasks: CreateTaskInput[];
}

export type CodriveCommand =
  | { type: "project.register"; payload: CreateProjectInput }
  | {
      type: "project.add_work";
      payload: {
        projectId: string;
        tasks: CreateTaskInput[];
        productDocument?: string;
      };
    }
  | {
      type: "project.control";
      payload: { projectId: string; action: "pause" | "resume" | "cancel" };
    }
  | {
      type: "project.record_decision";
      payload: { projectId: string; decision: string; productDocument?: string };
    }
  | {
      type: "task.control";
      payload: { taskId: string; action: "retry" | "cancel" };
    }
  | { type: "task.report"; payload: TaskReport }
  | { type: "project.report"; payload: ProjectReport };
