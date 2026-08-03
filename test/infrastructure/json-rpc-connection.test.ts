import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { JsonRpcConnection } from "../../src/infrastructure/json-rpc-connection.js";

describe("JsonRpcConnection", () => {
  it("matches line-delimited responses to requests", async () => {
    const serverOutput = new PassThrough();
    const clientOutput = new PassThrough();
    const connection = new JsonRpcConnection(serverOutput, clientOutput);

    const request = connection.request<{ value: string }>("example/read", {
      id: "item_1",
    });
    const line = await readLine(clientOutput);
    const message = JSON.parse(line) as { id: number };
    serverOutput.write(
      `${JSON.stringify({ id: message.id, result: { value: "ok" } })}\n`,
    );

    await expect(request).resolves.toEqual({ value: "ok" });
    connection.close();
  });

  it("emits server notifications without treating them as responses", async () => {
    const serverOutput = new PassThrough();
    const clientOutput = new PassThrough();
    const connection = new JsonRpcConnection(serverOutput, clientOutput);
    const listener = vi.fn();
    connection.onNotification(listener);

    serverOutput.write(
      `${JSON.stringify({ method: "turn/completed", params: { turn: { id: "turn_1" } } })}\n`,
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(listener).toHaveBeenCalledWith({
      method: "turn/completed",
      params: { turn: { id: "turn_1" } },
    });
    connection.close();
  });
});

async function readLine(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    stream.once("data", (data: Buffer) => resolve(data.toString("utf8").trim()));
  });
}
