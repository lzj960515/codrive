#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const [command, ...args] = process.argv.slice(2);
let result;
let isWrite = false;
if (command === "local-projects" && args.length === 0) {
  result = await request("/api/local-projects");
} else if (command === "slack-context" && args.length <= 1) {
  const threadId = (args[0] ?? process.env.CODEX_THREAD_ID)?.trim();
  if (!threadId) fail("slack-context requires a Codex thread ID or CODEX_THREAD_ID");
  result = await request(`/api/slack/context/${encodeURIComponent(threadId)}`);
} else if (command === "slack-status" && args.length === 0) {
  result = await request("/api/slack");
} else if (command === "slack-channels" && args.length === 0) {
  result = await request("/api/slack/channels");
} else if (command === "slack-configure") {
  const settings = await readJsonFileArgument(args, "slack-configure");
  result = await sendCommand("slack.configure", settings);
  isWrite = true;
} else if (command === "slack-bind" && args[0]) {
  const [projectId, ...inputArgs] = args;
  const payload = parseJsonArgument(inputArgs, "slack-bind");
  result = await sendCommand("slack.bind", { ...payload, projectId });
  isWrite = true;
} else if (command === "slack-create-channel" && args[0]) {
  const [projectId, ...inputArgs] = args;
  const payload = parseJsonArgument(inputArgs, "slack-create-channel");
  result = await sendCommand("slack.create_project_channel", { ...payload, projectId });
  isWrite = true;
} else if (command === "slack-report" && args[0]) {
  const [projectId, ...inputArgs] = args;
  const payload = parseJsonArgument(inputArgs, "slack-report");
  result = await sendCommand("slack.report", { ...payload, projectId });
  isWrite = true;
} else if (command === "slack-send-file") {
  const payload = parseJsonArgument(args, "slack-send-file");
  result = await sendCommand("slack.send_file", payload);
  isWrite = true;
} else if (command === "reply-decision") {
  const payload = parseJsonArgument(args, "reply-decision");
  result = await sendCommand("decision.reply", payload);
  isWrite = true;
} else if (command === "board" && args.length === 0) {
  result = await request("/api/board");
} else if (command === "archived" && args.length === 0) {
  result = await request("/api/board/archived");
} else if (command === "project" && args.length === 1) {
  result = await request(`/api/projects/${encodeURIComponent(args[0])}`);
} else if (command === "task" && args.length === 1) {
  result = await request(`/api/tasks/${encodeURIComponent(args[0])}`);
} else if (command === "milestone" && args.length === 1) {
  result = await request(`/api/contexts/milestones/${encodeURIComponent(args[0])}`);
} else if (command === "milestone-update" && args[0]) {
  const [id, ...inputArgs] = args;
  const payload = parseJsonArgument(inputArgs, "milestone-update");
  result = await sendCommand("milestone.update_definition", { ...payload, milestoneId: id });
  isWrite = true;
} else if (command === "settings" && args.length === 0) {
  result = await request("/api/system/settings");
} else if (command === "update-settings") {
  const settings = parseJsonArgument(args, "update-settings");
  result = await sendCommand("system.update_settings", settings);
  isWrite = true;
} else if (command === "project-control" && args[0] && args[1]) {
  const [id, action, ...inputArgs] = args;
  const decision =
    action === "cancel"
      ? readCancellationDecision(
          parseJsonArgument(inputArgs, "project-control cancel"),
        )
      : noJsonInput(inputArgs, "project-control");
  result = await sendCommand("project.control", {
    projectId: id,
    action,
    ...decision,
  });
  isWrite = true;
} else if (command === "task-control" && args[0] && args[1]) {
  const [id, action, ...inputArgs] = args;
  const details =
    action === "cancel"
      ? readCancellationDecision(
          parseJsonArgument(inputArgs, "task-control cancel"),
        )
      : action === "reschedule"
        ? readResumeSchedule(
            parseJsonArgument(inputArgs, "task-control reschedule"),
          )
        : noJsonInput(inputArgs, "task-control");
  result = await sendCommand("task.control", { taskId: id, action, ...details });
  isWrite = true;
} else if (command === "task-update" && args[0]) {
  const [id, ...inputArgs] = args;
  const payload = parseJsonArgument(inputArgs, "task-update");
  const update = await taskDefinitionUpdate(id, payload);
  result = await sendCommand("task.update_definition", update);
  isWrite = true;
} else if (command === "product-document-changed" && args[0]) {
  const [id, ...inputArgs] = args;
  const payload = parseJsonArgument(inputArgs, "product-document-changed");
  const change = await productDocumentChange(id, payload);
  result = await sendCommand("project.update_product_document", {
    projectId: id,
    ...change,
  });
  isWrite = true;
} else {
  fail(
    "Usage: codrive-control <local-projects|board|archived|project|task|milestone|milestone-update|settings|update-settings|project-control|task-control|task-update|product-document-changed|slack-context|slack-status|slack-channels|slack-configure|slack-bind|slack-create-channel|slack-report|slack-send-file|reply-decision> ...",
  );
}
print(isWrite ? { ok: true, result } : result);

function sendCommand(type, payload) {
  return request("/api/commands", {
    method: "POST",
    body: JSON.stringify({ type, payload }),
  });
}

async function request(path, options = {}) {
  const stateDirectory =
    process.env.CODEDRIVE_HOME ?? join(homedir(), ".codrive");
  const config = JSON.parse(
    await readFile(join(stateDirectory, "config.json"), "utf8"),
  );
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

async function readJsonFileArgument(args, commandName) {
  if (args.length !== 2 || args[0] !== "--json-file" || !args[1]) {
    fail(`${commandName} requires --json-file <path>`);
  }
  let contents;
  try {
    contents = await readFile(args[1], "utf8");
  } catch {
    fail(`${commandName} could not read the JSON file`);
  }
  let payload;
  try {
    payload = JSON.parse(contents);
  } catch {
    fail("Invalid JSON supplied in --json-file");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("--json-file payload must be a JSON object");
  }
  return payload;
}
function noJsonInput(args, commandName) {
  if (args.length > 0) fail(`${commandName} does not accept --json`);
  return {};
}

function readCancellationDecision(payload) {
  if (!["user_confirmed", "agent_decision"].includes(payload.decisionBasis)) {
    fail("Cancellation decisionBasis must be user_confirmed or agent_decision");
  }
  if (typeof payload.reason !== "string" || !payload.reason.trim()) {
    fail("Cancellation reason is required");
  }
  return { decisionBasis: payload.decisionBasis, reason: payload.reason.trim() };
}

function readResumeSchedule(payload) {
  if (typeof payload.resumeAt !== "string" || !payload.resumeAt.trim()) {
    fail("Scheduled resumeAt is required");
  }
  return { resumeAt: payload.resumeAt.trim() };
}

async function taskDefinitionUpdate(taskId, payload) {
  if (
    typeof payload.expectedUpdatedAt !== "string" ||
    !payload.expectedUpdatedAt
  ) {
    fail("Task update expectedUpdatedAt is required");
  }
  if (
    typeof payload.decisionSummary !== "string" ||
    !payload.decisionSummary.trim()
  ) {
    fail("Task update decisionSummary is required");
  }
  if (
    !payload.changes ||
    typeof payload.changes !== "object" ||
    Array.isArray(payload.changes)
  ) {
    fail("Task update changes must be a JSON object");
  }

  let documentChange;
  if (payload.productDocumentChange !== undefined) {
    if (
      !payload.productDocumentChange ||
      typeof payload.productDocumentChange !== "object" ||
      Array.isArray(payload.productDocumentChange)
    ) {
      fail("Task update productDocumentChange must be a JSON object");
    }
    const detail = await request(`/api/tasks/${encodeURIComponent(taskId)}`);
    const acceptedChange = await productDocumentChange(detail.task.projectId, {
      ...payload.productDocumentChange,
      decisionSummary: payload.decisionSummary,
    });
    const { decisionSummary: _decisionSummary, ...change } = acceptedChange;
    documentChange = change;
  }

  return {
    taskId,
    expectedUpdatedAt: payload.expectedUpdatedAt,
    decisionSummary: payload.decisionSummary.trim(),
    changes: payload.changes,
    ...(documentChange ? { productDocumentChange: documentChange } : {}),
  };
}

async function productDocumentChange(projectId, payload) {
  if (!Number.isInteger(payload.expectedRevision) || payload.expectedRevision < 1) {
    fail("Product document expectedRevision must be a positive integer");
  }
  if (typeof payload.expectedDigest !== "string" || !payload.expectedDigest) {
    fail("Product document expectedDigest is required");
  }
  if (
    typeof payload.decisionSummary !== "string" ||
    !payload.decisionSummary.trim()
  ) {
    fail("Product document decisionSummary is required");
  }
  const context = await request(
    `/api/contexts/projects/${encodeURIComponent(projectId)}`,
  );
  const document = await readFile(context.projectDocument, "utf8");
  return {
    decisionSummary: payload.decisionSummary.trim(),
    expectedRevision: payload.expectedRevision,
    expectedDigest: payload.expectedDigest,
    documentDigest: `sha256:${createHash("sha256").update(document).digest("hex")}`,
  };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
