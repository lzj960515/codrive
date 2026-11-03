import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SlackConversation, SlackInputReceipt } from "../../src/domain/slack-state.js";
import { SlackStateStore } from "../../src/infrastructure/slack-state-store.js";

const conversation: SlackConversation = {
  id: "channel_thread:T_owner:C_project:1762141200.000001/../../private",
  conversationType: "channel_thread",
  teamId: "T_owner",
  channelId: "C_project",
  threadTs: "1762141200.000001",
  projectId: "project_login",
  codexThreadId: "codex_thread_login",
  createdAt: "2026-11-03T03:00:00.000Z",
  updatedAt: "2026-11-03T03:00:00.000Z",
};

const input: SlackInputReceipt = {
  id: "event_login_failure",
  conversationId: conversation.id,
  projectId: "project_login",
  status: "running",
  turnId: "turn_login",
  target: { kind: "slack", teamId: "T_owner", channelId: "C_project", threadTs: "1762141200.000001" },
  message: {
    eventId: "event_login_failure",
    teamId: "T_owner",
    channelId: "C_project",
    channelType: "channel",
    userId: "U_owner",
    text: "提交登录后仍然停留在登录页",
    messageTs: "1762141200.000001",
  },
  createdAt: "2026-11-03T03:00:00.000Z",
  updatedAt: "2026-11-03T03:00:01.000Z",
};

describe("SlackStateStore", () => {
  let directory: string;
  let store: SlackStateStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "codrive-slack-state-"));
    store = new SlackStateStore(directory);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("restores the original project, conversation and in-flight message after restart", async () => {
    await store.saveConversation(conversation);
    await store.saveInput(input);

    const restarted = new SlackStateStore(directory);
    expect(await restarted.getConversation(conversation.id)).toEqual(conversation);
    expect(await restarted.getInput(input.id)).toEqual(input);
    expect(await restarted.listConversations()).toEqual([conversation]);
    expect(await restarted.listInputs()).toEqual([input]);
    expect(await restarted.getDelivery("never-created")).toBeNull();
    expect(await restarted.listDeliveries()).toEqual([]);

    const files = await readdir(join(directory, "slack", "conversations"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    const path = join(directory, "slack", "conversations", files[0]!);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(conversation);
  });

  it("keeps missing records empty but surfaces corrupted persisted messages", async () => {
    expect(await store.getInput("missing")).toBeNull();
    await store.saveInput(input);
    const [file] = await readdir(join(directory, "slack", "inputs"));
    await writeFile(join(directory, "slack", "inputs", file!), "{invalid JSON", "utf8");

    await expect(store.getInput(input.id)).rejects.toThrow(SyntaxError);
    await expect(store.listInputs()).rejects.toThrow(SyntaxError);
    expect(await store.getConversation("unrelated-missing")).toBeNull();
  });
});
