#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const [command, id, action] = process.argv.slice(2);
let result;
if (command === "board") result = await request("/api/board");
else if (command === "project" && id) result = findProject(await request("/api/board"), id);
else if (command === "task" && id) result = findTask(await request("/api/board"), id);
else if (command === "project-control" && id && action) result = await sendCommand("project.control", { projectId: id, action });
else if (command === "task-control" && id && action) result = await sendCommand("task.control", { taskId: id, action });
else if (command === "record-decision" && id) {
  const payload = JSON.parse(await readStdin());
  result = await sendCommand("project.record_decision", { projectId: id, ...payload });
} else fail("Usage: codrive-control <board|project|task|project-control|task-control|record-decision> ...");
print(result);

function sendCommand(type, payload) {
  return request("/api/commands", {
    method: "POST",
    body: JSON.stringify({ type, payload }),
  });
}

async function request(path, options = {}) {
  const config = JSON.parse(await readFile(join(process.env.CODEDRIVE_HOME ?? join(homedir(), ".codrive"), "config.json"), "utf8"));
  const response = await fetch(`http://${config.host}:${config.port}${path}`, { ...options, headers: { "content-type": "application/json", "x-codrive-token": config.accessToken } });
  if (!response.ok) fail(`Codrive ${response.status}: ${await response.text()}`);
  return response.json();
}

function findProject(board, projectId) {
  const project = board.find(({ project }) => project.id === projectId);
  if (!project) fail(`Project ${projectId} was not found`);
  return project;
}

function findTask(board, taskId) {
  const task = board.flatMap(({ tasks }) => tasks).find(({ id }) => id === taskId);
  if (!task) fail(`Task ${taskId} was not found`);
  return task;
}

async function readStdin() { let value = ""; for await (const chunk of process.stdin) value += chunk; return value; }
function print(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function fail(message) { process.stderr.write(`${message}\n`); process.exit(1); }
