import type { ProjectSnapshot } from "../../domain/types.js";
import { createBoardView } from "./board-view.js";

export function createProjectDetailView(
  snapshot: ProjectSnapshot,
  productDocument: string,
) {
  const board = createBoardView([snapshot])[0]!;
  const { project } = snapshot;
  const tasksById = new Map(snapshot.tasks.map((task) => [task.id, task]));
  return {
    project: {
      ...board.project,
      repositoryPath: project.repositoryPath,
      defaultBranch: project.defaultBranch,
      contextNotes: project.contextNotes ?? [],
      currentExecution: project.currentExecution ?? null,
      createdAt: project.createdAt,
    },
    productDocument,
    planningNotice: board.project.planningNotice,
    tasks: board.tasks.map((taskView) => ({
      ...taskView,
      currentExecution: tasksById.get(taskView.id)?.currentExecution ?? null,
    })),
  };
}
