import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

const hookScript = resolve("hooks/codrive/codrive-activity-hook.mjs");

describe("managed Codrive activity Hook", () => {
  it("forwards only safe turn identity and activity fields", async () => {
    let receivedBody = "";
    let receivedToken: string | undefined;
    const server = createServer((request, response) => {
      receivedToken = request.headers["x-codrive-token"] as string | undefined;
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        receivedBody += chunk;
      });
      request.on("end", () => {
        response.writeHead(202, { "content-type": "application/json" });
        response.end('{"accepted":true}');
      });
    });
    await new Promise<void>((resolveListen) =>
      server.listen(0, "127.0.0.1", resolveListen),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    const stateDirectory = await createStateDirectory(address.port);

    try {
      const result = await runHook(stateDirectory, {
        session_id: "session-live",
        turn_id: "turn-live",
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        prompt: "SECRET_PROMPT",
        cwd: "/SECRET/PATH",
        transcript_path: "/SECRET/TRANSCRIPT",
        tool_input: { command: "pnpm test -- SECRET_COMMAND" },
        tool_response: "SECRET_OUTPUT",
      });

      expect(result).toMatchObject({ code: 0, stdout: "{}\n", stderr: "" });
      expect(receivedToken).toBe("hook-token");
      expect(JSON.parse(receivedBody)).toEqual({
        schemaVersion: 1,
        session_id: "session-live",
        turn_id: "turn-live",
        hook_event_name: "PostToolUse",
        tool_name: "test_command",
        occurred_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
      expect(receivedBody).not.toContain("SECRET");
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("exits successfully when input is incomplete or Codrive is unavailable", async () => {
    const stateDirectory = await createStateDirectory(1);

    await expect(runHook(stateDirectory, { hook_event_name: "Stop" })).resolves
      .toMatchObject({ code: 0, stdout: "{}\n", stderr: "" });
    await expect(
      runHook(stateDirectory, {
        session_id: "session-live",
        turn_id: "turn-live",
        hook_event_name: "Stop",
      }),
    ).resolves.toMatchObject({ code: 0, stdout: "{}\n", stderr: "" });
  });
});

async function createStateDirectory(port: number): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codrive-hook-script-"));
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({
      schemaVersion: 2,
      host: "127.0.0.1",
      port,
      accessToken: "hook-token",
    }),
    "utf8",
  );
  return directory;
}

function runHook(
  stateDirectory: string,
  input: Record<string, unknown>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [hookScript], {
      env: { ...process.env, CODEDRIVE_HOME: stateDirectory },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectRun);
    child.once("exit", (code) => resolveRun({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}
