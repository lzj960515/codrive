import type {
  CreateTaskInput,
  PlanningExecution,
  ProjectPlanningState,
  TaskDefinitionChanges,
} from "./types.js";

export interface Milestone {
  id: string;
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  definitionVersion: number;
  status: "active" | "done";
  planning: ProjectPlanningState;
  threadId?: string;
  currentExecution?: PlanningExecution<"assess_milestone", MilestoneReport>;
  latestAssessmentActivityId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMilestoneInput {
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  tasks?: Omit<CreateTaskInput, "milestoneId">[];
}

export interface UpdateMilestoneDefinitionInput {
  milestoneId: string;
  expectedDefinitionVersion: number;
  decisionSummary: string;
  changes: Pick<
    CreateMilestoneInput,
    "title" | "description" | "acceptanceCriteria"
  >;
}

export interface TaskDiscoveryInput {
  taskId: string;
  attemptId: string;
  requestId: string;
  summary: string;
  evidence: string[];
  affectedTaskIds?: string[];
}

/** 一条处置可以替代旧问题，也可以保留明确的交付前置条件。 */
export interface MilestoneResolution {
  sourceActivityIds: string[];
  summary: string;
  question?: string;
  affectedTaskIds?: string[];
  waitForTaskIds?: string[];
}

export interface MilestonePlan {
  tasks?: Array<Omit<CreateTaskInput, "milestoneId"> & { key: string }>;
  updates?: Array<{
    taskId: string;
    expectedUpdatedAt: string;
    changes: TaskDefinitionChanges;
  }>;
  cancellations?: Array<{
    taskId: string;
    expectedUpdatedAt: string;
    reason: string;
    decisionBasis: "user_confirmed" | "agent_decision";
  }>;
  resolutions?: MilestoneResolution[];
}

export interface MilestoneReport {
  milestoneId: string;
  attemptId: string;
  reportOpportunityId: string;
  definitionVersion: number;
  planningRevision: number;
  outcome: "progress" | "needs_input" | "blocked" | "completed";
  summary: string;
  evidence?: string[];
  plan?: MilestonePlan;
}

interface MilestoneActivityBase {
  id: string;
  projectId: string;
  milestoneId: string;
  occurredAt: string;
  summary: string;
}
export type MilestoneActivity =
  | (MilestoneActivityBase & {
      type: "discovery";
      taskId: string;
      attemptId: string;
      requestId: string;
      evidence: string[];
      affectedTaskIds: string[];
    })
  | (MilestoneActivityBase & {
      type: "assessment";
      report: MilestoneReport;
      createdTaskIds: string[];
      appliedAt?: string;
    })
  | (MilestoneActivityBase & {
      type: "resolution";
      resolution: MilestoneResolution;
      assessmentActivityId: string;
    });

export interface MilestoneActivityProjection {
  unresolvedActivities: MilestoneActivity[];
  restrictedTaskIds: string[];
  latestAssessment: Extract<MilestoneActivity, { type: "assessment" }> | null;
}
