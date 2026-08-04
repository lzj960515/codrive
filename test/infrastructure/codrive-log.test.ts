import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CodriveLog,
  formatLocalTimestamp,
} from "../../src/infrastructure/codrive-log.js";

describe("CodriveLog", () => {
  it("writes Codex output to the terminal and a private file in local time", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-log-"));
    const logPath = join(directory, "codrive.log");
    let terminal = "";
    const log = new CodriveLog(logPath, {
      now: () => new Date("2026-08-04T03:10:00.000Z"),
      writeToTerminal: (text) => {
        terminal += text;
      },
    });

    log.write(
      "codex",
      "2026-08-04T03:05:37.362881Z ERROR codex_core::tools::router: apply_patch failed\n",
    );
    log.close();

    const expected = `[${formatLocalTimestamp(new Date("2026-08-04T03:05:37.362Z"))}] [codex] ERROR codex_core::tools::router: apply_patch failed\n`;
    const contents = await readFile(logPath, "utf8");
    expect(contents).toBe(expected);
    expect(terminal).toBe(expected);
    expect(contents).not.toContain("2026-08-04T03:05:37.362881Z");
    expect((await stat(logPath)).mode & 0o777).toBe(0o600);
  });

  it("buffers split process output until a complete line is available", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-log-"));
    const logPath = join(directory, "codrive.log");
    let terminal = "";
    const now = new Date("2026-08-04T03:10:00.000Z");
    const log = new CodriveLog(logPath, {
      now: () => now,
      writeToTerminal: (text) => {
        terminal += text;
      },
    });

    log.write("codex", "part one");
    expect(terminal).toBe("");
    log.write("codex", " and part two\n");
    log.info("Codrive is ready");
    log.close();

    const timestamp = formatLocalTimestamp(now);
    expect(await readFile(logPath, "utf8")).toBe(
      `[${timestamp}] [codex] part one and part two\n` +
      `[${timestamp}] [codrive] INFO Codrive is ready\n`,
    );
  });

  it("uses the embedded time from structured Codex logs without repeating UTC", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-log-"));
    const logPath = join(directory, "codrive.log");
    let terminal = "";
    const log = new CodriveLog(logPath, {
      writeToTerminal: (text) => {
        terminal += text;
      },
    });

    log.write(
      "codex",
      '{"timestamp":"2026-08-04T03:05:37.362881Z","level":"WARN","fields":{"message":"plugin sync skipped"}}\n',
    );
    log.close();

    const expected =
      `[${formatLocalTimestamp(new Date("2026-08-04T03:05:37.362Z"))}] [codex] ` +
      '{"level":"WARN","fields":{"message":"plugin sync skipped"}}\n';
    expect(await readFile(logPath, "utf8")).toBe(expected);
    expect(terminal).toBe(expected);
    expect(terminal).not.toContain("2026-08-04T03:05:37.362881Z");
  });
});
