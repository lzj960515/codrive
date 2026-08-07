#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const [command, id, ...args] = process.argv.slice(2);

if (command === "context" && id) {
  print(await request(`/api/contexts/tasks/${encodeURIComponent(id)}`));
} else if (command === "resolve") {
  const values = [id, ...args];
  const cwdIndex = values.indexOf("--cwd");
  const cwd = cwdIndex >= 0 ? values[cwdIndex + 1] : process.cwd();
  print(await request(`/api/contexts/resolve?cwd=${encodeURIComponent(resolve(cwd))}`));
} else if (command === "report" && id) {
  const payload = JSON.parse(await readStdin());
  print(await sendCommand("task.report", { taskId: id, ...payload }));
} else if (command === "project-context" && id) {
  print(await request(`/api/contexts/projects/${encodeURIComponent(id)}`));
} else if (command === "project-report" && id) {
  const payload = JSON.parse(await readStdin());
  print(await sendCommand("project.report", { projectId: id, ...payload }));
} else {
  fail("Usage: codrive-task <context|resolve|report|project-context|project-report> <id> [--cwd path]");
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
    headers: { "content-type": "application/json", "x-codrive-token": config.accessToken, "x-codrive-source": "skill" },
  });
  if (!response.ok) fail(`Codrive ${response.status}: ${await response.text()}`);
  return response.json();
}

async function loadConfig() {
  const directory = process.env.CODEDRIVE_HOME ?? join(homedir(), ".codrive");
  return JSON.parse(await readFile(join(directory, "config.json"), "utf8"));
}

async function readStdin() {
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value;
}

function print(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function fail(message) { process.stderr.write(`${message}\n`); process.exit(1); }
