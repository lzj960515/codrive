import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CodexAppServerClient } from "../../src/infrastructure/codex-app-server-client.js";

describe("packaged Codex Hook runtime", () => {
  it("loads asynchronous command Hooks and reports their trust state", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codrive-codex-hooks-"));
    await writeFile(
      join(codexHome, "hooks.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: "true",
                  async: true,
                  timeout: 2,
                },
              ],
            },
          ],
        },
      }),
      "utf8",
    );
    const client = new CodexAppServerClient({
      env: { ...process.env, CODEX_HOME: codexHome },
    });

    try {
      const inspection = await client.inspectHooks(process.cwd());
      expect(inspection.warnings).not.toContainEqual(
        expect.stringContaining("async hooks are not supported"),
      );
      expect(inspection.hooks).toContainEqual(
        expect.objectContaining({
          eventName: "postToolUse",
          command: "true",
          enabled: true,
          trustStatus: "untrusted",
        }),
      );
    } finally {
      await client.stop();
    }
  });

  it("reloads user Hook configuration after the App Server has started", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codrive-codex-hooks-"));
    const client = new CodexAppServerClient({
      env: { ...process.env, CODEX_HOME: codexHome },
    });

    try {
      await expect(client.inspectHooks(process.cwd())).resolves.toMatchObject({
        hooks: [],
      });
      await writeFile(
        join(codexHome, "hooks.json"),
        JSON.stringify({
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: "true", async: true }] }],
          },
        }),
        "utf8",
      );

      await expect(client.inspectHooks(process.cwd())).resolves.toMatchObject({
        hooks: [
          expect.objectContaining({
            eventName: "stop",
            command: "true",
            trustStatus: "untrusted",
          }),
        ],
      });
    } finally {
      await client.stop();
    }
  });
});
