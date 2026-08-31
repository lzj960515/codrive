#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const [command, ...args] = process.argv.slice(2);
if (command !== "register") {
  fail("Usage: codrive-forge register --json <payload>");
}
const payload = parseJsonArgument(args, "register");
const result = await request("/api/commands", {
  method: "POST",
  body: JSON.stringify({ type: "project.register", payload }),
});
print({ ok: true, result });

async function request(path, options) {
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

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
