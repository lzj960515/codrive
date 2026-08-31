#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const [command, ...args] = process.argv.slice(2);

if (command === "context" && args.length === 1) {
  const [id] = args;
  print(await request(`/api/contexts/tasks/${encodeURIComponent(id)}`));
} else if (command === "resolve") {
  const cwd = resolveCwd(args);
  print(
    await request(
      `/api/contexts/resolve?cwd=${encodeURIComponent(resolve(cwd))}`,
    ),
  );
} else if (command === "report" && args[0]) {
  const [id, ...inputArgs] = args;
  const payload = parseJsonArgument(inputArgs, "report");
  const result = await sendCommand("task.report", { ...payload, taskId: id });
  const activityId = await taskReportActivityId(id, payload);
  printSuccess(result, {
    activityId,
    reportOpportunityId: payload.reportOpportunityId,
  });
} else if (command === "project-context" && args.length === 1) {
  const [id] = args;
  print(await request(`/api/contexts/projects/${encodeURIComponent(id)}`));
} else if (command === "project-report" && args[0]) {
  const [id, ...inputArgs] = args;
  const payload = parseJsonArgument(inputArgs, "project-report");
  const result = await sendCommand("project.report", {
    ...payload,
    projectId: id,
  });
  printSuccess(result, {
    attemptId: payload.attemptId,
    outcome: payload.outcome,
  });
} else {
  fail(
    "Usage: codrive-task <context|resolve|report|project-context|project-report> <id> [--cwd path | --json payload]",
  );
}

function sendCommand(type, payload) {
  return request("/api/commands", {
    method: "POST",
    body: JSON.stringify({ type, payload }),
  });
}

async function request(path, options = {}) {
  const config = await loadConfig();
  const response = await fetch(`http://${config.host}:${config.port}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-codrive-token": config.accessToken,
      "x-codrive-source": "skill",
    },
  });
  if (!response.ok) fail(`Codrive ${response.status}: ${await response.text()}`);
  return response.json();
}

async function loadConfig() {
  const directory = process.env.CODEDRIVE_HOME ?? join(homedir(), ".codrive");
  return JSON.parse(await readFile(join(directory, "config.json"), "utf8"));
}

async function taskReportActivityId(taskId, payload) {
  const context = await request(
    `/api/contexts/tasks/${encodeURIComponent(taskId)}`,
  );
  const activity = context.activities.find(
    (candidate) =>
      candidate.attemptId === payload.attemptId &&
      candidate.reportOpportunityId === payload.reportOpportunityId,
  );
  if (!activity) {
    fail(
      "Codrive accepted the task report but did not return an activity receipt",
    );
  }
  return activity.id;
}

function resolveCwd(args) {
  if (args.length === 0) return process.cwd();
  if (args.length === 2 && args[0] === "--cwd" && args[1]) return args[1];
  fail("resolve accepts only --cwd <absolute-path>");
}

function parseJsonArgument(args, commandName) {
  if (args.length !== 2 || args[0] !== "--json" || !args[1]) {
    fail(`${commandName} requires --json <payload>`);
  }
  let payload;
  try {
    payload = JSON.parse(args[1]);
  } catch {
    fail("Invalid JSON supplied to --json");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("--json payload must be a JSON object");
  }
  return payload;
}

function printSuccess(result, receipt = {}) {
  print({ ok: true, ...receipt, result });
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
