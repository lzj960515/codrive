import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  Project,
  ProjectSnapshot,
  Task,
  TaskActivity,
} from "../src/domain/types.js";
import { ProjectStore } from "../src/infrastructure/project-store.js";
import { renderBoardPage } from "../src/interfaces/http/board.js";
import { createHttpServer } from "../src/interfaces/http/server.js";

// README artwork always rebuilds this synthetic store instead of reading local state.
const demoHome = join(process.cwd(), "tmp", "readme-board-demo-home");
const timestamp = "2026-08-13T09:30:00.000+08:00";

await seedDemoState();

const store = new ProjectStore(demoHome);
await store.initialize();

const server = createHttpServer({
  store,
  workflow: {
    execute: async () => {
      throw new Error("The README demo is read-only");
    },
  } as never,
  skillInstaller: {
    getStatus: async () => ({
      state: "current",
      bundledVersion: "0.6.1",
      managedSkillCount: 4,
      conflictPaths: [],
    }),
    install: async () => {
      throw new Error("The README demo is read-only");
    },
  } as never,
  settingsService: {
    read: async () => ({
      settings: {
        maxConcurrentTasks: 4,
        models: { primary: "gpt-5.6-sol", fallback: "gpt-5.6-terra" },
      },
      availableModels: [],
    }),
    update: async () => {
      throw new Error("The README demo is read-only");
    },
  } as never,
  systemUpdateService: {
    read: async () => ({
      version: {
        currentVersion: "0.6.1",
        latestVersion: "0.6.1",
        updateAvailable: false,
        checking: false,
        lastCheckedAt: timestamp,
      },
      upgrade: null,
      skills: {
        state: "current",
        bundledVersion: "0.6.1",
        managedSkillCount: 4,
        conflictPaths: [],
      },
    }),
    refresh: async () => {
      throw new Error("The README demo is read-only");
    },
    start: async () => {
      throw new Error("The README demo is read-only");
    },
    installSkills: async () => {
      throw new Error("The README demo is read-only");
    },
  } as never,
  currentVersion: "0.6.1",
  accessToken: "readme-demo-token",
});

server.get("/capture", async (_request, reply) => {
  const page = renderBoardPage("readme-demo-token").replace(
    "</body>",
    `<script>
      const captureTimer = window.setInterval(() => {
        const task = document.querySelector('[data-task="task_demo_00_lumaquill_studio_03"]');
        if (!task) return;
        window.clearInterval(captureTimer);
        task.click();
      }, 50);
    </script></body>`,
  );
  return reply.type("text/html; charset=utf-8").send(page);
});

await server.listen({ host: "127.0.0.1", port: 0 });
const address = server.server.address();
if (!address || typeof address === "string") throw new Error("Demo server did not bind");
process.stdout.write(`DEMO_URL=http://127.0.0.1:${address.port}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
}

async function seedDemoState() {
  const state = demoProjects();
  await rm(demoHome, { recursive: true, force: true });
  await mkdir(join(demoHome, "projects"), { recursive: true });
  await writeFile(
    join(demoHome, "state-schema.json"),
    `${JSON.stringify({ schemaVersion: 2, migratedAt: timestamp }, null, 2)}\n`,
    "utf8",
  );

  for (const { project, tasks, activities, productDocument } of state) {
    const projectDirectory = join(demoHome, "projects", project.id);
    const tasksDirectory = join(projectDirectory, "tasks");
    await mkdir(tasksDirectory, { recursive: true });
    await writeJson(join(projectDirectory, "project.json"), project);
    await writeFile(join(projectDirectory, "PROJECT.md"), productDocument, "utf8");
    await Promise.all(
      tasks.map((task) => writeJson(join(tasksDirectory, `${task.id}.json`), task)),
    );
    await writeFile(
      join(projectDirectory, "events.ndjson"),
      activities
        .map((activity) =>
          JSON.stringify({
            schemaVersion: 1,
            eventId: `event_${activity.id}`,
            type: "task.activity_recorded",
            component: "store",
            source: "skill",
            projectId: project.id,
            taskId: activity.taskId,
            occurredAt: activity.occurredAt,
            data: { activity },
          }),
        )
        .join("\n") + "\n",
      "utf8",
    );
  }
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function demoProjects(): Array<
  ProjectSnapshot & { activities: TaskActivity[]; productDocument: string }
> {
  return [
    lumaquillProject(),
    simpleProject("project_10_fieldloom", "Fieldloom 研究台", [
      ["归档访谈摘录", "done"],
      ["生成主题聚类", "developing"],
      ["审阅洞察卡片", "backlog"],
    ]),
    simpleProject("project_20_signalnest", "Signalnest 发布中心", [
      ["整理发布清单", "done"],
      ["验证回滚流程", "reviewing"],
      ["准备发布公告", "backlog"],
      ["同步支持手册", "backlog"],
    ]),
  ];
}

function lumaquillProject(): ProjectSnapshot & {
  activities: TaskActivity[];
  productDocument: string;
} {
  const projectId = "project_00_lumaquill_studio";
  const project = baseProject(projectId, "Lumaquill 内容工作室");
  const tasks: Task[] = [
    task(projectId, 1, "梳理下季度选题池", "汇总读者问题并形成可排期的主题清单。", "backlog"),
    {
      ...task(projectId, 2, "搭建选题协作流", "让编辑、设计与审核围绕同一份简报推进。", "developing"),
      requestedAction: "develop",
      currentExecution: execution("develop", "running", "thread_demo_editorial_flow"),
    },
    {
      ...task(projectId, 3, "校验发布前质量门", "在内容进入排期前自动核对标题、链接与授权信息。", "reviewing"),
      acceptanceCriteria: [
        "缺失标题、失效链接与授权状态会阻止发布",
        "独立审查可追溯到候选提交与验证结果",
      ],
      requestedAction: "review",
      currentExecution: execution("review", "running", "thread_demo_quality_review"),
    },
    {
      ...task(projectId, 4, "合入内容日历筛选", "按渠道、负责人和发布日期筛选内容日历。", "integrating"),
      requestedAction: "integrate",
      currentExecution: execution("integrate", "awaiting_report", "thread_demo_calendar_merge"),
    },
    {
      ...task(projectId, 5, "确定首批发布渠道", "为首轮内容确定邮件、博客与播客的优先级。", "waiting_for_input"),
      requestedAction: "develop",
    },
    task(projectId, 6, "生成周度复盘摘要", "汇总发布表现、读者反馈与下周动作。", "backlog"),
    task(projectId, 7, "建立内容资产目录", "统一索引图片、音频与引用来源。", "done"),
  ];

  return {
    project,
    tasks,
    activities: [
      activity(projectId, tasks[2]!.id, "activity_quality_developed", {
        type: "development_completed",
        action: "develop",
        outcome: "completed",
        attemptId: "attempt_demo_quality_development",
        summary: "质量门已覆盖标题、链接和授权状态，并提供清晰的失败说明。",
        occurredAt: "2026-08-12T15:20:00.000+08:00",
        threadId: "thread_demo_quality_development",
        evidence: {
          workspacePath: "/demo/lumaquill-studio/.worktrees/quality-gate",
          baseCommit: "4c2a8d1",
          candidateCommit: "8b31f0a",
          tests: "pnpm test · 42 passed\npnpm typecheck · passed",
        },
      }),
    ],
    productDocument: "# Lumaquill 内容工作室\n\n让小型内容团队从选题到发布保持一份可追溯的进度。\n",
  };
}

function simpleProject(
  id: string,
  name: string,
  entries: Array<[string, Task["status"]]>,
): ProjectSnapshot & { activities: TaskActivity[]; productDocument: string } {
  return {
    project: baseProject(id, name),
    tasks: entries.map(([title, status], index) =>
      task(id, index + 1, title, "在清晰的验收边界内持续推进这项工作。", status),
    ),
    activities: [],
    productDocument: `# ${name}\n\n隔离演示项目。\n`,
  };
}

function baseProject(id: string, name: string): Project {
  return {
    id,
    name,
    repositoryPath: `/demo/${id.replace("project_", "")}`,
    defaultBranch: "main",
    status: "active",
    scheduling: "running",
    requestedAction: null,
    planning: {
      revision: 3,
      evaluatedRevision: 3,
      changedAt: timestamp,
      changeReason: "task_completed",
    },
    createdAt: "2026-08-08T10:00:00.000+08:00",
    updatedAt: timestamp,
  };
}

function task(
  projectId: string,
  order: number,
  title: string,
  description: string,
  status: Task["status"],
): Task {
  return {
    id: `task_demo_${projectId.slice(8)}_${String(order).padStart(2, "0")}`,
    projectId,
    title,
    description,
    acceptanceCriteria: ["交付结果符合当前产品目标", "验证结果记录在任务活动中"],
    order,
    status,
    requestedAction: status === "done" || status === "backlog" ? null : "develop",
    createdAt: "2026-08-08T10:00:00.000+08:00",
    updatedAt: `2026-08-${String(10 + Math.min(order, 3)).padStart(2, "0")}T09:30:00.000+08:00`,
  };
}

function execution(
  action: "develop" | "review" | "integrate",
  status: "running" | "awaiting_report",
  threadId: string,
) {
  return {
    attemptId: `attempt_demo_${action}`,
    action,
    status,
    threadId,
    turnId: `turn_demo_${action}`,
    turnStartedAt: timestamp,
    startedAt: timestamp,
    modelRouting: { model: "gpt-5.6-sol", route: "primary" as const, retryCount: 0 },
  };
}

function activity(
  projectId: string,
  taskId: string,
  id: string,
  value: Omit<TaskActivity, "id" | "projectId" | "taskId">,
): TaskActivity {
  return { id, projectId, taskId, ...value };
}
