export type ProjectStatus = "active" | "idle" | "cancelled";

export type SchedulingStatus = "running" | "paused";
export type ProjectAction = "select_tasks";

export interface ModelRoutingSettings {
  primary: string;
  fallback: string;
}

export type ModelRoute = "primary" | "fallback";

export interface ModelCapacityError {
  kind: "model_capacity";
  message: string;
  failedAt: string;
}

export interface ExecutionModelRouting {
  model: string;
  route: ModelRoute;
  retryCount: number;
  nextRetryAt?: string;
  lastError?: ModelCapacityError;
}

export type PlanningChangeReason =
  | "project_registered"
  | "work_added"
  | "task_completed"
  | "task_cancelled"
  | "project_decision_recorded"
  | "concurrency_changed"
  | "manual_replan";

export interface ProjectPlanningState {
  revision: number;
  evaluatedRevision?: number;
  changedAt: string;
  changeReason: PlanningChangeReason;
  concurrencyLimit?: number;
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

export type CancellationDecisionBasis = "user_confirmed" | "agent_decision";
export type CancellationActor = "codex" | "user";

export interface CancellationInput {
  cancelledBy: CancellationActor;
  decisionBasis: CancellationDecisionBasis;
  reason: string;
}

export interface Cancellation extends CancellationInput {
  cancelledAt: string;
}

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
  cancellation?: Cancellation;
  contextNotes?: string[];
  createdAt: string;
  updatedAt: string;
}

export type ProjectReportOutcome =
  | "selected"
  | "wait_for_active_tasks"
  | "needs_input"
  | "blocked";

export interface ProjectReport {
  projectId: string;
  attemptId: string;
  outcome: ProjectReportOutcome;
  summary: string;
  taskIds?: string[];
  question?: string;
}

export interface ProjectExecution {
  attemptId: string;
  action: ProjectAction;
  status: ExecutionStatus;
  threadId?: string;
  turnId?: string;
  startedAt: string;
  modelRouting: ExecutionModelRouting;
  finishedAt?: string;
  turnCompletedAt?: string;
  result?: ProjectReport;
  reportReminderCount?: number;
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
  | "retry_scheduled"
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
  modelRouting: ExecutionModelRouting;
  finishedAt?: string;
  turnCompletedAt?: string;
  submittedActivityId?: string;
  reportReminderCount?: number;
  leaseExpiresAt?: string;
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

export type TaskActivityType =
  | "development_completed"
  | "rework_completed"
  | "review_approved"
  | "review_changes_requested"
  | "review_requested"
  | "integration_completed"
  | "decision_requested"
  | "blocked"
  | "execution_failed"
  | "cancelled";

export interface TaskActivityEvidence {
  workspacePath?: string;
  baseCommit?: string;
  candidateCommit?: string;
  reviewedMainCommit?: string;
  mergedCommit?: string;
  tests?: string;
  findings?: string[];
  question?: string;
  reason?: string;
  decisionBasis?: CancellationDecisionBasis;
}

export interface TaskActivity {
  id: string;
  projectId: string;
  taskId: string;
  type: TaskActivityType;
  summary: string;
  occurredAt: string;
  attemptId?: string;
  action?: TaskAction;
  outcome?: TaskReportOutcome;
  threadId?: string;
  evidence?: TaskActivityEvidence;
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
  currentExecution?: TaskExecution;
  cancellation?: Cancellation;
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
      payload:
        | {
            projectId: string;
            action: "pause" | "resume" | "retry" | "replan";
          }
        | {
            projectId: string;
            action: "cancel";
            decisionBasis: CancellationDecisionBasis;
            reason: string;
          };
    }
  | {
      type: "project.record_decision";
      payload: { projectId: string; decision: string; productDocument?: string };
    }
  | {
      type: "task.control";
      payload:
        | { taskId: string; action: "retry" }
        | {
            taskId: string;
            action: "cancel";
            decisionBasis: CancellationDecisionBasis;
            reason: string;
          };
    }
  | { type: "task.report"; payload: TaskReport }
  | { type: "project.report"; payload: ProjectReport };
