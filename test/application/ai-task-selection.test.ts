import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { WorkflowEngine } from "../../src/application/workflow-engine.js";
import { ProjectStore } from "../../src/infrastructure/project-store.js";
import {
  RecordingProjectExecutor,
  RecordingTaskDispatcher,
} from "../support/recording-executors.js";

describe("AI task selection", () => {
  it("asks a temporary project task to select work before starting task conversations", async () => {
    const store = new ProjectStore(await mkdtemp(join(tmpdir(), "codrive-selection-")));
    const taskDispatcher = new RecordingTaskDispatcher();
    const projectExecutor = new RecordingProjectExecutor();
    const workflow = new WorkflowEngine(
      store,
      taskDispatcher,
      { maxConcurrentTasks: 2 },
      projectExecutor,
    );

    const created = await workflow.registerProject({
      name: "Game",
      repositoryPath: "/workspace/game",
      defaultBranch: "main",
      productDocument: "# Game\n",
      tasks: [
        {
          title: "Core loop",
          description: "Build the core loop",
          acceptanceCriteria: [],
        },
        {
          title: "Sound",
          description: "Add sound",
          acceptanceCriteria: [],
        },
      ],
    });

    expect(taskDispatcher.started).toHaveLength(0);
    expect(projectExecutor.started).toHaveLength(1);
    expect(projectExecutor.started[0]?.project).toMatchObject({
      id: created.project.id,
      status: "selecting_tasks",
      requestedAction: "select_tasks",
    });
  });
});
