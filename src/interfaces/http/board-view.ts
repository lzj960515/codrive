import type { ProjectSnapshot } from "../../domain/types.js";

export function createBoardView(snapshots: ProjectSnapshot[]) {
  return snapshots.map(({ project, tasks }) => ({
    project: {
      id: project.id,
      name: project.name,
      repositoryPath: project.repositoryPath,
      status: project.status,
      scheduling: project.scheduling,
      requestedAction: project.requestedAction,
      summary: project.latestReport?.summary ?? null,
      question: project.latestReport?.question ?? null,
      updatedAt: project.updatedAt,
    },
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
      order: task.order,
      status: task.status,
      requestedAction: task.requestedAction,
      summary: task.latestReport?.summary ?? null,
      question: task.latestReport?.question ?? null,
      report: task.latestReport
        ? {
            outcome: task.latestReport.outcome,
            summary: task.latestReport.summary,
            tests: task.latestReport.tests ?? null,
            findings: task.latestReport.findings ?? [],
            question: task.latestReport.question ?? null,
          }
        : null,
      executionStatus: task.currentExecution?.status ?? null,
      developmentThreadId: task.developmentThreadId ?? null,
      reviewThreadId: task.reviewAttempts.at(-1)?.threadId ?? null,
      reviewCount: task.reviewAttempts.length,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    })),
  }));
}
