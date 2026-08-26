#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const [command, id, action] = process.argv.slice(2);
let result;
if (command === "board") result = await request("/api/board");
else if (command === "project" && id) result = await request(`/api/projects/${encodeURIComponent(id)}`);
else if (command === "task" && id) result = await request(`/api/tasks/${encodeURIComponent(id)}`);
else if (command === "settings") result = await request("/api/system/settings");
else if (command === "update-settings") result = await sendCommand("system.update_settings", JSON.parse(await readStdin()));
else if (command === "project-control" && id && action) {
  const decision = action === "cancel" ? await readCancellationDecision() : {};
  result = await sendCommand("project.control", { projectId: id, action, ...decision });
} else if (command === "task-control" && id && action) {
  const details = action === "cancel"
    ? await readCancellationDecision()
    : action === "reschedule"
      ? await readResumeSchedule()
      : {};
  result = await sendCommand("task.control", { taskId: id, action, ...details });
}
else if (command === "product-document-changed" && id) {
  const payload = JSON.parse(await readStdin());
  const change = await productDocumentChange(id, payload);
  result = await sendCommand("project.update_product_document", { projectId: id, ...change });
} else fail("Usage: codrive-control <board|project|task|settings|update-settings|project-control|task-control|product-document-changed> ...");
print(result);

function sendCommand(type, payload) {
  return request("/api/commands", {
    method: "POST",
    body: JSON.stringify({ type, payload }),
  });
}

async function request(path, options = {}) {
  const config = JSON.parse(await readFile(join(process.env.CODEDRIVE_HOME ?? join(homedir(), ".codrive"), "config.json"), "utf8"));
  const response = await fetch(`http://${config.host}:${config.port}${path}`, { ...options, headers: { "content-type": "application/json", "x-codrive-token": config.accessToken, "x-codrive-source": "skill" } });
  if (!response.ok) fail(`Codrive ${response.status}: ${await response.text()}`);
  return response.json();
}

async function readStdin() { let value = ""; for await (const chunk of process.stdin) value += chunk; return value; }
async function readCancellationDecision() {
  const payload = JSON.parse(await readStdin());
  if (!["user_confirmed", "agent_decision"].includes(payload.decisionBasis)) {
    fail("Cancellation decisionBasis must be user_confirmed or agent_decision");
  }
  if (typeof payload.reason !== "string" || !payload.reason.trim()) {
    fail("Cancellation reason is required");
  }
  return { decisionBasis: payload.decisionBasis, reason: payload.reason.trim() };
}
async function readResumeSchedule() {
  const payload = JSON.parse(await readStdin());
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
  if (typeof payload.decisionSummary !== "string" || !payload.decisionSummary.trim()) {
    fail("Product document decisionSummary is required");
  }
  const context = await request(`/api/contexts/projects/${encodeURIComponent(projectId)}`);
  const document = await readFile(context.projectDocument, "utf8");
  return {
    decisionSummary: payload.decisionSummary.trim(),
    expectedRevision: payload.expectedRevision,
    expectedDigest: payload.expectedDigest,
    documentDigest: `sha256:${createHash("sha256").update(document).digest("hex")}`,
  };
}
function print(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function fail(message) { process.stderr.write(`${message}\n`); process.exit(1); }
