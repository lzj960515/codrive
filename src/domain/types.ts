export type ProjectStatus =
  | "active"
  | "evaluating"
  | "waiting_for_input"
  | "stalled"
  | "completed"
  | "blocked"
  | "cancelled";

export type SchedulingStatus = "running" | "paused";
export type ProjectAction = "select_tasks" | "evaluate_product";

export type PlanningChangeReason =
  | "project_registered"
  | "work_added"
  | "tasks_created"
  | "task_completed"
  | "task_cancelled"
  | "project_decision_recorded"
  | "concurrency_changed"
  | "manual_replan";

export type SelectionDecisionOutcome =
  | "selected"
  | "wait_for_active_tasks"
  | "needs_input"
  | "blocked";

export type SelectionWakeCondition =
  | "task_completed"
  | "project_decision_recorded"
  | "manual_replan";

export type SelectionNextAction =
  | "wait_for_task_completion"
  | "record_project_decision"
  | "resolve_blocker_and_replan";

export interface SelectionDecision {
  revision: number;
  outcome: SelectionDecisionOutcome;
  summary: string;
  taskIds: string[];
  question?: string;
  wakeCondition: SelectionWakeCondition;
  nextAction: SelectionNextAction;
  decidedAt: string;
}

export interface ProjectPlanningState {
  revision: number;
  changedAt: string;
  changeReason: PlanningChangeReason;
  concurrencyLimit?: number;
  lastDecision?: SelectionDecision;
}

export type LifecycleEventSource =
  | "http"
  | "skill"
  | "scheduler"
  | "recovery"
  | "app_server"
  | "system";

export type LifecycleEventComponent =
  | "http"
  | "workflow"
  | "recovery"
  | "app_server"
  | "store";

export interface LifecycleState {
  status: string;
  scheduling?: SchedulingStatus;
  requestedAction?: ProjectAction | TaskAction | null;
  attemptId?: string;
  action?: ProjectAction | TaskAction;
  executionStatus?: ExecutionStatus;
  threadId?: string;
  turnId?: string;
}

export interface Project {
  id: string;
  name: string;
  repositoryPath: string;
  defaultBranch: string;
  status: ProjectStatus;
  scheduling: SchedulingStatus;
  requestedAction: ProjectAction | null;
  planning: ProjectPlanningState;
  currentExecution?: ProjectExecution;
  latestReport?: ProjectReport;
  contextNotes?: string[];
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
  planningRevision?: number;
  selectionCapacity?: number;
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

export interface LifecycleEvent {
  schemaVersion?: 1;
  eventId: string;
  type: string;
  component?: LifecycleEventComponent;
  source?: LifecycleEventSource;
  projectId?: string;
  taskId?: string;
  attemptId?: string;
  threadId?: string;
  turnId?: string;
  commandId?: string;
  correlationId?: string;
  causationId?: string;
  occurredAt: string;
  before?: LifecycleState;
  after?: LifecycleState;
  decision?: string;
  result?: string;
  reason?: string;
  durationMs?: number;
  data?: Record<string, unknown>;
}

export interface CodriveEvent extends LifecycleEvent {
  projectId: string;
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
      payload: {
        projectId: string;
        action: "pause" | "resume" | "retry" | "replan" | "cancel";
      };
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
