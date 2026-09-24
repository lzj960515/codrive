import { z } from "zod";

import { hasProductFacts } from "../../domain/product-facts.js";

const taskInputSchema = z.object({
  milestoneId: z.string().min(1).optional(),
  title: z.string().min(1),
  taskDocumentPath: z.string().trim().min(1),
  order: z.number().int().positive().optional(),
}).strict();

const milestoneDefinitionSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
}).strict();

const milestoneInputSchema = milestoneDefinitionSchema.extend({
  tasks: z.array(taskInputSchema.omit({ milestoneId: true })).optional(),
});

const projectInputSchema = z.object({
  name: z.string().min(1),
  repositoryPath: z.string().min(1),
  defaultBranch: z.string().min(1).default("main"),
  productDocument: z
    .string()
    .refine(hasProductFacts, "PROJECT.md must contain product facts"),
  tasks: z.array(taskInputSchema),
  milestones: z.array(milestoneInputSchema).optional(),
}).refine(({ tasks, milestones }) => tasks.length > 0 || (milestones?.length ?? 0) > 0,
  "Provide initial tasks or a milestone");

const taskReportSchema = z.object({
  taskId: z.string().min(1),
  attemptId: z.string().min(1),
  reportOpportunityId: z.string().min(1),
  outcome: z.enum([
    "completed",
    "approved",
    "changes_requested",
    "work_required",
    "needs_review",
    "needs_input",
    "blocked",
  ]),
  summary: z.string().min(1),
  workspacePath: z.string().optional(),
  baseCommit: z.string().optional(),
  candidateCommit: z.string().optional(),
  reviewedMainCommit: z.string().optional(),
  mergedCommit: z.string().optional(),
  tests: z.string().optional(),
  findings: z.array(z.string()).optional(),
  question: z.string().optional(),
  resumeAt: z.string().optional(),
  resumePrompt: z.string().optional(),
});

const projectReportSchema = z.object({
  reportOpportunityId: z.string().min(1),
  projectId: z.string().min(1),
  attemptId: z.string().min(1),
  outcome: z.enum([
    "selected",
    "wait_for_active_tasks",
    "needs_input",
    "blocked",
  ]),
  summary: z.string().min(1),
  taskIds: z.array(z.string().min(1)).optional(),
  question: z.string().optional(),
});


const cancellationDecisionSchema = {
  decisionBasis: z.enum(["user_confirmed", "agent_decision"]),
  reason: z.string().trim().min(1).max(2_000),
};

const productDocumentChangeSchema = z.object({
  decisionSummary: z.string().trim().min(1).max(2_000),
  expectedRevision: z.number().int().positive(),
  expectedDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  documentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

const taskDefinitionChangesSchema = z
  .object({
    milestoneId: z.string().min(1).nullable().optional(),
    title: z.string().min(1).optional(),
    taskDocumentPath: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    acceptanceCriteria: z.array(z.string()).optional(),
  })
  .refine(
    ({ title, taskDocumentPath, description, acceptanceCriteria, milestoneId }) =>
      milestoneId !== undefined ||
      title !== undefined ||
      taskDocumentPath !== undefined ||
      description !== undefined ||
      acceptanceCriteria !== undefined,
    "Task definition changes must include at least one field",
  );

const modelRoutingSettingsSchema = z.object({
  primary: z.string().min(1),
  fallback: z.string().min(1),
  primaryReasoningEffort: z.string().min(1).optional(),
  fallbackReasoningEffort: z.string().min(1).optional(),
}).transform(({ primary, fallback, primaryReasoningEffort, fallbackReasoningEffort }) => ({
  primary,
  fallback,
  ...(primaryReasoningEffort === undefined ? {} : { primaryReasoningEffort }),
  ...(fallbackReasoningEffort === undefined ? {} : { fallbackReasoningEffort }),
}));

const milestoneResolutionSchema = z.object({
  sourceActivityIds: z.array(z.string().min(1)),
  summary: z.string().trim().min(1),
  question: z.string().trim().min(1).optional(),
  affectedTaskIds: z.array(z.string().min(1)).optional(),
  waitForTaskIds: z.array(z.string().min(1)).optional(),
}).strict();

const milestoneReportSchema = z.object({
  milestoneId: z.string().min(1),
  attemptId: z.string().min(1),
  reportOpportunityId: z.string().min(1),
  definitionVersion: z.number().int().positive(),
  planningRevision: z.number().int().positive(),
  outcome: z.enum(["progress", "needs_input", "blocked", "completed"]),
  summary: z.string().trim().min(1),
  evidence: z.array(z.string()).optional(),
  plan: z.object({
    tasks: z.array(taskInputSchema.omit({ milestoneId: true }).extend({ key: z.string().min(1) })).optional(),
    updates: z.array(z.object({
      taskId: z.string().min(1), expectedUpdatedAt: z.iso.datetime(),
      changes: taskDefinitionChangesSchema,
    }).strict()).optional(),
    cancellations: z.array(z.object({
      taskId: z.string().min(1), expectedUpdatedAt: z.iso.datetime(), reason: z.string().trim().min(1), decisionBasis: z.enum(["user_confirmed", "agent_decision"]),
    }).strict()).optional(),
    resolutions: z.array(milestoneResolutionSchema).optional(),
  }).strict().optional(),
}).strict();

export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("decision.reply"), payload: z.object({
    scope: z.enum(["task", "project", "milestone"]), id: z.string().min(1),
    reportOpportunityId: z.string().min(1), message: z.string().trim().min(1).max(20_000),
  }).strict() }).strict(),
  z.object({ type: z.literal("milestone.create"), payload: milestoneInputSchema.extend({ projectId: z.string().min(1) }) }).strict(),
  z.object({ type: z.literal("milestone.update_definition"), payload: z.object({
    milestoneId: z.string().min(1), expectedDefinitionVersion: z.number().int().positive(),
    decisionSummary: z.string().trim().min(1), changes: milestoneDefinitionSchema,
  }).strict() }).strict(),
  z.object({ type: z.literal("milestone.report"), payload: milestoneReportSchema }).strict(),
  z.object({ type: z.literal("task.report_discovery"), payload: z.object({
    taskId: z.string().min(1), attemptId: z.string().min(1), requestId: z.string().min(1),
    summary: z.string().trim().min(1), evidence: z.array(z.string()),
    affectedTaskIds: z.array(z.string().min(1)).optional(),
  }).strict() }).strict(),
  z.object({
    type: z.literal("system.install_resources"),
    payload: z.object({}),
  }),
  z.object({
    type: z.literal("system.check_for_updates"),
    payload: z.object({}),
  }),
  z.object({
    type: z.literal("system.start_upgrade"),
    payload: z.object({
      targetVersion: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
    }),
  }),
  z.object({
    type: z.literal("system.update_settings"),
    payload: z.object({
      maxConcurrentTasks: z.number().int().positive(),
      models: modelRoutingSettingsSchema,
      semanticAtlasAutomaticMaintenance: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal("project.update_settings"),
    payload: z.object({
      projectId: z.string().min(1),
      modelConfig: modelRoutingSettingsSchema.nullable(),
    }),
  }),
  z.object({ type: z.literal("project.register"), payload: projectInputSchema }),
  z.object({
    type: z.literal("project.add_work"),
    payload: z.object({
      projectId: z.string().min(1),
      tasks: z.array(taskInputSchema).min(1),
      decisionSummary: z.string().trim().min(1),
      productDocumentChange: productDocumentChangeSchema.omit({ decisionSummary: true }).optional(),
    }),
  }),
  z.object({
    type: z.literal("project.control"),
    payload: z.discriminatedUnion("action", [
      z.object({
        projectId: z.string().min(1),
        action: z.enum([
          "pause",
          "resume",
          "retry",
          "replan",
          "archive",
          "unarchive",
        ]),
      }),
      z.object({
        projectId: z.string().min(1),
        action: z.literal("cancel"),
        ...cancellationDecisionSchema,
      }),
    ]),
  }),
  z.object({
    type: z.literal("project.update_product_document"),
    payload: productDocumentChangeSchema.extend({
      projectId: z.string().min(1),
    }),
  }),
  z.object({
    type: z.literal("task.update_definition"),
    payload: z.object({
      taskId: z.string().min(1),
      expectedUpdatedAt: z.iso.datetime(),
      decisionSummary: z.string().trim().min(1).max(2_000),
      changes: taskDefinitionChangesSchema,
      productDocumentChange: productDocumentChangeSchema
        .omit({ decisionSummary: true })
        .optional(),
    }),
  }),
  z.object({
    type: z.literal("task.control"),
    payload: z.discriminatedUnion("action", [
      z.object({ taskId: z.string().min(1), action: z.literal("retry") }),
      z.object({ taskId: z.string().min(1), action: z.literal("continue") }),
      z.object({
        taskId: z.string().min(1),
        action: z.literal("reschedule"),
        resumeAt: z.string().min(1),
      }),
      z.object({
        taskId: z.string().min(1),
        action: z.literal("cancel"),
        ...cancellationDecisionSchema,
      }),
    ]),
  }),
  z.object({ type: z.literal("task.report"), payload: taskReportSchema }),
  z.object({ type: z.literal("project.report"), payload: projectReportSchema }),
]);
