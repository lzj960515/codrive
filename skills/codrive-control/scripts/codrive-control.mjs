#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const [command, ...args] = process.argv.slice(2);
let result;
let isWrite = false;
if (command === "board" && args.length === 0) {
  result = await request("/api/board");
} else if (command === "archived" && args.length === 0) {
  result = await request("/api/board/archived");
} else if (command === "project" && args.length === 1) {
  result = await request(`/api/projects/${encodeURIComponent(args[0])}`);
} else if (command === "task" && args.length === 1) {
  result = await request(`/api/tasks/${encodeURIComponent(args[0])}`);
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
    "Usage: codrive-control <board|archived|project|task|settings|update-settings|project-control|task-control|product-document-changed> ...",
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
