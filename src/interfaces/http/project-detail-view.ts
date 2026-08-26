import type { ProjectSnapshot } from "../../domain/types.js";
import {
  hasProductFacts,
  productDocumentDigest,
} from "../../domain/product-facts.js";
import { createBoardView } from "./board-view.js";

export function createProjectDetailView(
  snapshot: ProjectSnapshot,
  productDocument: string,
) {
  const board = createBoardView([snapshot])[0]!;
  const { project } = snapshot;
  const { attention, ...projectView } = board.project;
  const tasksById = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const documentDigest = productDocumentDigest(productDocument);
  return {
    project: {
      ...projectView,
      repositoryPath: project.repositoryPath,
      defaultBranch: project.defaultBranch,
      productFacts: {
        status:
          hasProductFacts(productDocument) &&
          documentDigest === project.productFacts.digest
            ? "current"
            : "modified",
        revision: project.productFacts.revision,
        acceptedDigest: project.productFacts.digest,
        documentDigest,
      },
      createdAt: project.createdAt,
    },
    productDocument,
    attention,
    tasks: board.tasks.map((taskView) => ({
      ...taskView,
      currentExecution: tasksById.get(taskView.id)?.currentExecution ?? null,
    })),
  };
}
