#!/usr/bin/env node
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
  const decision = action === "cancel" ? await readCancellationDecision() : {};
  result = await sendCommand("task.control", { taskId: id, action, ...decision });
}
else if (command === "record-decision" && id) {
  const payload = JSON.parse(await readStdin());
  result = await sendCommand("project.record_decision", { projectId: id, ...payload });
} else fail("Usage: codrive-control <board|project|task|settings|update-settings|project-control|task-control|record-decision> ...");
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
function print(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function fail(message) { process.stderr.write(`${message}\n`); process.exit(1); }
