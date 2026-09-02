import { describe, expect, it } from "vitest";

import { createTaskActivityHistoryWindow } from "../../src/interfaces/http/task-activity-history.js";

describe("TaskActivityHistoryWindow", () => {
  it.each([
    [[], []],
    [["activity-1"], ["activity-1"]],
    [
      ["activity-1", "activity-2"],
      ["activity-1", "activity-2"],
    ],
  ])("shows a complete short history", (activities, expected) => {
    const history = createTaskActivityHistoryWindow();

    history.open("task-1");

    expect(history.view("task-1", activities)).toEqual({
      visibleActivities: expected,
      hiddenCount: 0,
    });
  });

  it("starts with the latest two activities in chronological order", () => {
    const history = createTaskActivityHistoryWindow();

    history.open("task-1");

    expect(
      history.view("task-1", ["activity-1", "activity-2", "activity-3"]),
    ).toEqual({
      visibleActivities: ["activity-2", "activity-3"],
      hiddenCount: 1,
    });
  });

  it("reveals at most two earlier activities per request without gaps", () => {
    const history = createTaskActivityHistoryWindow();
    const activities = [
      "activity-1",
      "activity-2",
      "activity-3",
      "activity-4",
      "activity-5",
    ];
    history.open("task-1");

    expect(history.revealEarlier("task-1", activities)).toEqual({
      visibleActivities: [
        "activity-2",
        "activity-3",
        "activity-4",
        "activity-5",
      ],
      hiddenCount: 1,
    });
    expect(history.revealEarlier("task-1", activities)).toEqual({
      visibleActivities: activities,
      hiddenCount: 0,
    });
    expect(history.revealEarlier("task-1", activities)).toEqual({
      visibleActivities: activities,
      hiddenCount: 0,
    });
  });

  it("keeps expansion for a refresh of the same task", () => {
    const history = createTaskActivityHistoryWindow();
    const activities = [
      "activity-1",
      "activity-2",
      "activity-3",
      "activity-4",
    ];
    history.open("task-1");
    history.revealEarlier("task-1", activities);

    expect(history.view("task-1", activities).visibleActivities).toEqual(
      activities,
    );
  });

  it("keeps already revealed activities visible when new progress arrives", () => {
    const history = createTaskActivityHistoryWindow();
    const activities = [
      "activity-1",
      "activity-2",
      "activity-3",
      "activity-4",
    ];
    history.open("task-1");
    history.revealEarlier("task-1", activities);

    expect(
      history.view("task-1", [...activities, "activity-5"]),
    ).toEqual({
      visibleActivities: [...activities, "activity-5"],
      hiddenCount: 0,
    });
  });

  it("resets when switching tasks or reopening a closed task", () => {
    const history = createTaskActivityHistoryWindow();
    const activities = [
      "activity-1",
      "activity-2",
      "activity-3",
      "activity-4",
    ];
    history.open("task-1");
    history.revealEarlier("task-1", activities);

    history.open("task-2");
    expect(history.view("task-2", activities).visibleActivities).toEqual([
      "activity-3",
      "activity-4",
    ]);

    history.close();
    history.open("task-1");
    expect(history.view("task-1", activities).visibleActivities).toEqual([
      "activity-3",
      "activity-4",
    ]);
  });
});
