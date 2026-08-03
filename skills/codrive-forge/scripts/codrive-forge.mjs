#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

if (process.argv[2] !== "register") fail("Usage: codrive-forge register");
const payload = JSON.parse(await readStdin());
print(await request("/api/commands", {
  method: "POST",
  body: JSON.stringify({ type: "project.register", payload }),
}));

async function request(path, options) {
  const config = JSON.parse(await readFile(join(process.env.CODEDRIVE_HOME ?? join(homedir(), ".codrive"), "config.json"), "utf8"));
  const response = await fetch(`http://${config.host}:${config.port}${path}`, { ...options, headers: { "content-type": "application/json", "x-codrive-token": config.accessToken } });
  if (!response.ok) fail(`Codrive ${response.status}: ${await response.text()}`);
  return response.json();
}
async function readStdin() { let value = ""; for await (const chunk of process.stdin) value += chunk; return value; }
function print(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function fail(message) { process.stderr.write(`${message}\n`); process.exit(1); }
