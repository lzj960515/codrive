import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

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

  it("removes terminal styling before normalizing process output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-log-"));
    const logPath = join(directory, "codrive.log");
    const log = new CodriveLog(logPath, { writeToTerminal: () => undefined });

    log.write(
      "codex",
      "\u001b[2m2026-08-04T03:05:37.362881Z\u001b[0m \u001b[31mERROR\u001b[0m tool failed\n",
    );
    log.close();

    const contents = await readFile(logPath, "utf8");
    expect(contents).toBe(
      `[${formatLocalTimestamp(new Date("2026-08-04T03:05:37.362Z"))}] [codex] ERROR tool failed\n`,
    );
    expect(contents).not.toContain("\u001b");
  });

  it("writes lifecycle events without persisted report or conversation content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-log-"));
    const logPath = join(directory, "codrive.log");
    const log = new CodriveLog(logPath, { writeToTerminal: () => undefined });

    log.event({
      schemaVersion: 1,
      eventId: "event_1",
      type: "task.transitioned",
      component: "workflow",
      source: "http",
      projectId: "project_1",
      taskId: "task_1",
      attemptId: "attempt_1",
      occurredAt: "2026-08-04T03:05:37.362Z",
      before: { status: "blocked", executionStatus: "failed" },
      after: { status: "developing", executionStatus: "pending" },
      state: {
        task: {
          latestReport: { summary: "PRIVATE_REPORT_BODY_MUST_NOT_APPEAR" },
        },
      },
    } as never);
    log.close();

    const contents = await readFile(logPath, "utf8");
    expect(contents).toContain('[lifecycle] EVENT {"schemaVersion":1');
    expect(contents).toContain('"type":"task.transitioned"');
    expect(contents).toContain('"before":{"status":"blocked"');
    expect(contents).not.toContain("state");
    expect(contents).not.toContain("PRIVATE_REPORT_BODY_MUST_NOT_APPEAR");
  });

  it("rotates a full log before writing the next line", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-log-"));
    const logPath = join(directory, "codrive.log");
    const log = new CodriveLog(logPath, {
      maxBytes: 100,
      now: () => new Date("2026-08-04T03:10:00.000Z"),
      writeToTerminal: () => undefined,
    });

    log.info("first lifecycle message");
    log.info("second lifecycle message");
    log.close();

    expect(await readFile(`${logPath}.1`, "utf8")).toContain(
      "first lifecycle message",
    );
    expect(await readFile(logPath, "utf8")).toContain(
      "second lifecycle message",
    );
    expect(await readFile(logPath, "utf8")).not.toContain(
      "first lifecycle message",
    );
  });

  it("deletes an archive after its retention period expires", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-log-"));
    const logPath = join(directory, "codrive.log");
    const archivePath = `${logPath}.1`;
    const now = new Date("2026-08-11T00:00:00.000Z");
    const eightDaysAgo = new Date("2026-08-03T00:00:00.000Z");
    await writeFile(archivePath, "expired archive\n");
    await utimes(archivePath, eightDaysAgo, eightDaysAgo);

    const log = new CodriveLog(logPath, {
      now: () => now,
      archiveMaxAgeMs: 7 * 24 * 60 * 60 * 1_000,
      writeToTerminal: () => undefined,
    });
    log.close();

    await expect(stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes an archive when it expires while the log remains open", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T00:00:00.000Z"));
    const directory = await mkdtemp(join(tmpdir(), "codrive-log-"));
    const logPath = join(directory, "codrive.log");
    const archivePath = `${logPath}.1`;
    await writeFile(archivePath, "expiring archive\n");
    const createdAt = new Date(Date.now());
    await utimes(archivePath, createdAt, createdAt);

    const log = new CodriveLog(logPath, {
      now: () => new Date(Date.now()),
      archiveMaxAgeMs: 1_000,
      writeToTerminal: () => undefined,
    });

    try {
      await vi.advanceTimersByTimeAsync(999);
      expect(await readFile(archivePath, "utf8")).toBe("expiring archive\n");
      await vi.advanceTimersByTimeAsync(1);
      await expect(stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      log.close();
      vi.useRealTimers();
    }
  });

  it("trims an oversized archive to its most recent complete lines", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-log-"));
    const logPath = join(directory, "codrive.log");
    const archivePath = `${logPath}.1`;
    const recentLines = "recent first line\nrecent second line\n";
    await writeFile(archivePath, `obsolete archive line\n${recentLines}`);

    const log = new CodriveLog(logPath, {
      archiveMaxBytes: Buffer.byteLength(recentLines),
      writeToTerminal: () => undefined,
    });
    log.close();

    expect(await readFile(archivePath, "utf8")).toBe(recentLines);
    expect((await stat(archivePath)).size).toBeLessThanOrEqual(
      Buffer.byteLength(recentLines),
    );
  });

  it("keeps an archive that is within both retention limits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-log-"));
    const logPath = join(directory, "codrive.log");
    const archivePath = `${logPath}.1`;
    const contents = "recent archive\n";
    const now = new Date("2026-08-11T00:00:00.000Z");
    const oneDayAgo = new Date("2026-08-10T00:00:00.000Z");
    await writeFile(archivePath, contents);
    await utimes(archivePath, oneDayAgo, oneDayAgo);

    const log = new CodriveLog(logPath, {
      now: () => now,
      archiveMaxBytes: Buffer.byteLength(contents),
      archiveMaxAgeMs: 7 * 24 * 60 * 60 * 1_000,
      writeToTerminal: () => undefined,
    });
    log.close();

    expect(await readFile(archivePath, "utf8")).toBe(contents);
  });

  it("rotates and bounds an oversized current log when opening it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codrive-log-"));
    const logPath = join(directory, "codrive.log");
    const recentLine = "recent active line\n";
    await writeFile(logPath, `obsolete active line\n${recentLine}`);

    const log = new CodriveLog(logPath, {
      maxBytes: 20,
      archiveMaxBytes: Buffer.byteLength(recentLine),
      writeToTerminal: () => undefined,
    });
    log.close();

    expect(await readFile(logPath, "utf8")).toBe("");
    expect(await readFile(`${logPath}.1`, "utf8")).toBe(recentLine);
  });
});
