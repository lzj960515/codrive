import type {
  MilestoneActivity,
  MilestoneActivityProjection,
} from "./milestone.js";

export function projectMilestoneActivities(
  activities: readonly MilestoneActivity[],
): MilestoneActivityProjection {
  const unresolved = new Map<string, MilestoneActivity>();
  let latestAssessment: MilestoneActivityProjection["latestAssessment"] = null;
  for (const activity of activities) {
    if (activity.type === "assessment") {
      latestAssessment = activity;
    } else if (activity.type === "discovery") {
      unresolved.set(activity.id, activity);
    } else {
      for (const sourceId of activity.resolution.sourceActivityIds)
        unresolved.delete(sourceId);
      if (
        activity.resolution.question ||
        activity.resolution.waitForTaskIds?.length
      ) {
        unresolved.set(activity.id, activity);
      }
    }
  }
  const unresolvedActivities = [...unresolved.values()];
  const restrictedTaskIds = [
    ...new Set(
      unresolvedActivities.flatMap((activity) =>
        activity.type === "resolution"
          ? activity.resolution.affectedTaskIds ?? []
          : [],
      ),
    ),
  ];
  return { unresolvedActivities, restrictedTaskIds, latestAssessment };
}
