#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const [command, projectId, ...args] = process.argv.slice(2);
if (!projectId || !["show", "add", "milestone-create"].includes(command)) {
  fail("Usage: codrive-work <show|add|milestone-create> <project-id>");
}
if (command === "show") {
  if (args.length > 0) fail("Usage: codrive-work show <project-id>");
  print(await request(`/api/contexts/projects/${encodeURIComponent(projectId)}`));
} else {
  const payload = parseJsonArgument(args, command);
  if (command === "milestone-create") {
    const result = await request("/api/commands", {
      method: "POST",
      body: JSON.stringify({ type: "milestone.create", payload: { ...payload, projectId } }),
    });
    print({ ok: true, result });
  } else {
    const productDocumentChange = await readProductDocumentChange(projectId, payload);
    const result = await request("/api/commands", {
      method: "POST",
      body: JSON.stringify({
        type: "project.add_work",
        payload: { ...payload, projectId, ...(productDocumentChange ? { productDocumentChange } : {}) },
      }),
    });
    print({ ok: true, result });
  }
}

async function readProductDocumentChange(projectId, payload) {
  if (payload.productDocumentChange === undefined) return undefined;
  const change = payload.productDocumentChange;
  if (!change || typeof change !== "object" || Array.isArray(change)) {
    fail("productDocumentChange must be a JSON object");
  }
  const context = await request(`/api/contexts/projects/${encodeURIComponent(projectId)}`);
  const document = await readFile(context.projectDocument, "utf8");
  return {
    ...change,
    documentDigest: `sha256:${createHash("sha256").update(document).digest("hex")}`,
  };
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

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
