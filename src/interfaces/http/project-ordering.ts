export const projectOrderStorageKey = "codrive.project-order.v1";

export type ProjectDropPosition = "before" | "after";

export function reconcileProjectOrder(
  projectIds: readonly string[],
  storedOrder: unknown,
): string[] {
  const remainingProjectIds = new Set(projectIds);
  const orderedProjectIds: string[] = [];
  const savedProjectIds = Array.isArray(storedOrder) ? storedOrder : [];

  for (const projectId of savedProjectIds) {
    if (typeof projectId !== "string" || !remainingProjectIds.delete(projectId)) {
      continue;
    }
    orderedProjectIds.push(projectId);
  }

  for (const projectId of projectIds) {
    if (remainingProjectIds.delete(projectId)) orderedProjectIds.push(projectId);
  }

  return orderedProjectIds;
}

export function moveProjectInOrder(
  projectIds: readonly string[],
  draggedProjectId: string,
  targetProjectId: string,
  position: ProjectDropPosition,
): string[] {
  const orderedProjectIds = [...new Set(projectIds)];
  if (draggedProjectId === targetProjectId) return orderedProjectIds;

  const draggedIndex = orderedProjectIds.indexOf(draggedProjectId);
  const targetIndex = orderedProjectIds.indexOf(targetProjectId);
  if (draggedIndex < 0 || targetIndex < 0) return orderedProjectIds;

  orderedProjectIds.splice(draggedIndex, 1);
  const destinationIndex = orderedProjectIds.indexOf(targetProjectId);
  orderedProjectIds.splice(
    position === "after" ? destinationIndex + 1 : destinationIndex,
    0,
    draggedProjectId,
  );
  return orderedProjectIds;
}
