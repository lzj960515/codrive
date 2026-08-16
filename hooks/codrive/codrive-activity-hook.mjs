import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const supportedEvents = new Set([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
]);

// Hook output must never affect the Codex turn, including when Codrive is offline.
process.stdout.write("{}\n");

try {
  const input = await readHookInput();
  const activity = safeActivity(input);
  if (activity) await sendActivity(activity);
} catch {
  // Activity reporting is best-effort and has no authority over the Codex turn.
}

async function readHookInput() {
  let contents = "";
  for await (const chunk of process.stdin) {
    contents += chunk;
    if (contents.length > 1_000_000) throw new Error("Hook input is too large");
  }
  return JSON.parse(contents);
}

function safeActivity(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const sessionId = safeString(input.session_id);
  const turnId = safeString(input.turn_id);
  const event = safeString(input.hook_event_name);
  if (!sessionId || !turnId || !event || !supportedEvents.has(event)) return null;
  const toolName = safeString(input.tool_name);
  return {
    schemaVersion: 1,
    session_id: sessionId,
    turn_id: turnId,
    hook_event_name: event,
    ...(toolName ? { tool_name: toolName } : {}),
    occurred_at: new Date().toISOString(),
  };
}

async function sendActivity(activity) {
  const stateDirectory = process.env.CODEDRIVE_HOME ?? join(homedir(), ".codrive");
  const config = JSON.parse(await readFile(join(stateDirectory, "config.json"), "utf8"));
  if (
    config?.host !== "127.0.0.1" ||
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65_535 ||
    !safeString(config.accessToken)
  ) {
    return;
  }
  await fetch(`http://127.0.0.1:${config.port}/api/hooks/activity`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codrive-token": config.accessToken,
    },
    body: JSON.stringify(activity),
    signal: AbortSignal.timeout(500),
  });
}

function safeString(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200
    ? value
    : null;
}
