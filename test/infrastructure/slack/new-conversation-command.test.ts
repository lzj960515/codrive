import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SlackConversationContext, SlackConversationControls } from "../../../src/domain/slack.js";
import { BoltSlackTransport } from "../../../src/infrastructure/slack/slack-transport.js";

type SlashCommandInput = {
  command: { team_id: string; user_id: string; channel_id: string; text: string };
  ack(): Promise<void>;
  respond(message: Record<string, unknown>): Promise<void>;
};

const { commands } = vi.hoisted(() => ({
  commands: new Map<string, (input: SlashCommandInput) => Promise<void>>(),
}));

vi.mock("@slack/bolt", () => ({
  LogLevel: { WARN: "warn" },
  App: class {
    event() {}
    command(name: string, handler: (input: SlashCommandInput) => Promise<void>) { commands.set(name, handler); }
    action() {}
    shortcut() {}
    error() {}
    async start() {}
    async stop() {}
  },
}));

function command(context: SlackConversationContext, responses: Array<Record<string, unknown>>): SlashCommandInput {
  return {
    command: { team_id: context.teamId, user_id: context.userId, channel_id: context.channelId, text: "" },
    ack: async () => {},
    respond: async (message) => { responses.push(message); },
  };
}

async function startTransport(controls: SlackConversationControls) {
  const onError = vi.fn();
  const transport = new BoltSlackTransport({
    stateDirectory: "/unused-for-conversation-command",
    botToken: "xoxb-test-only", appToken: "xapp-test-only", onError,
  });
  await transport.start(async () => {}, {
    read: async (): Promise<never> => { throw new Error("本测试不修改模型"); },
    select: async (): Promise<never> => { throw new Error("本测试不修改模型"); },
  }, {
    read: async (): Promise<never> => { throw new Error("本测试不查询会话状态"); },
  }, controls);
  const handle = commands.get("/new");
  expect(handle).toBeDefined();
  return { transport, onError, handle: handle! };
}

describe("Slack /new command", () => {
  beforeEach(() => { commands.clear(); });

  it("confirms the new conversation privately only after the application completes it", async () => {
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => { complete = resolve; });
    const received: SlackConversationContext[] = [];
    const { transport, onError, handle } = await startTransport({
      startNew: async (context) => { received.push(context); await pending; },
    });
    const context = { teamId: "T_owner", userId: "U_owner", channelId: "D_owner" };
    const responses: Array<Record<string, unknown>> = [];
    const execution = handle(command(context, responses));
    await vi.waitFor(() => { expect(received).toEqual([context]); });
    expect(responses).toEqual([]);
    complete();
    await execution;
    expect(responses).toEqual([{ response_type: "ephemeral", text: expect.stringContaining("新会话已开启") }]);
    expect(onError).not.toHaveBeenCalled();
    await transport.stop();
  });

  it("does not claim that a completed reset failed when its confirmation cannot be delivered", async () => {
    let opened = false;
    const { transport, onError, handle } = await startTransport({
      startNew: async () => { opened = true; },
    });
    const responses: Array<Record<string, unknown>> = [];
    const input = command({ teamId: "T_owner", userId: "U_owner", channelId: "D_owner" }, responses);
    input.respond = async (message) => {
      responses.push(message);
      throw new Error("Slack confirmation temporarily unavailable");
    };
    await expect(handle(input)).rejects.toThrow("confirmation temporarily unavailable");
    expect(opened).toBe(true);
    expect(responses).toEqual([{ response_type: "ephemeral", text: expect.stringContaining("新会话已开启") }]);
    expect(onError).not.toHaveBeenCalled();
    await transport.stop();
  });

  it.each([
    { context: { teamId: "T_other", userId: "U_owner", channelId: "D_owner" }, reason: "该命令不属于当前授权工作区。" },
    { context: { teamId: "T_owner", userId: "U_other", channelId: "D_owner" }, reason: "该命令仅限授权用户本人。" },
    { context: { teamId: "T_owner", userId: "U_owner", channelId: "C_project" }, reason: "频道中的新根消息已经建立独立会话；/new 仅用于机器人私信。" },
  ])("keeps an application rejection local to its command and leaves the next command available: $reason", async ({ context, reason }) => {
    let rejected = false;
    const { transport, onError, handle } = await startTransport({
      startNew: async () => {
        if (!rejected) { rejected = true; throw new Error(reason); }
      },
    });
    const responses: Array<Record<string, unknown>> = [];
    await handle(command(context, responses));
    expect(responses).toEqual([{ response_type: "ephemeral", text: expect.stringContaining(reason) }]);
    expect(String(responses[0]?.text)).not.toContain("新会话已开启");
    expect(onError).not.toHaveBeenCalled();
    await handle(command({ teamId: "T_owner", userId: "U_owner", channelId: "D_owner" }, responses));
    expect(responses[1]).toEqual({ response_type: "ephemeral", text: expect.stringContaining("新会话已开启") });
    expect(onError).not.toHaveBeenCalled();
    await transport.stop();
  });
});
