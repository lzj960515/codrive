import { appendFile, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServerClient } from "../../src/infrastructure/codex-app-server-client.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });

describe("Codex conversation ownership", () => {
  it.each(["completed", "interrupted", "failed"])("releases a %s turn and reloads the same conversation before replying", async (status) => {
    const { client, complete, requests } = await fixture();
    const thread = await client.startThread("/workspace", "Decision");
    const turn = await client.startTurn(thread, "/workspace", "Work", "model", "low");
    expect((await requests()).some((r) => r.method === "thread/unsubscribe")).toBe(false);
    await complete(thread, turn, status);
    expect((await requests()).filter((r) => r.method === "thread/unsubscribe")).toHaveLength(1);
    await client.startTurn(thread, "/workspace", "User decision", "model", "low");
    const methods = (await requests()).map((r) => r.method);
    expect(methods.slice(methods.indexOf("thread/unsubscribe"))).toEqual([
      "thread/unsubscribe", "thread/resume", "turn/start",
    ]);
  });

  it("ignores late completion of an earlier turn while the next turn is active", async () => {
    const { client, complete, requests } = await fixture();
    const thread = await client.startThread("/workspace", "Decision");
    const first = await client.startTurn(thread, "/workspace", "Work", "model", "low");
    await complete(thread, first);
    const second = await client.startTurn(thread, "/workspace", "Continue", "model", "low");
    await complete(thread, first);
    expect((await requests()).filter((r) => r.method === "thread/unsubscribe")).toHaveLength(1);
    await complete(thread, second);
    expect((await requests()).filter((r) => r.method === "thread/unsubscribe")).toHaveLength(2);
  });

  it("releases the known turn when it completes while resume is still responding", async () => {
    const { client, requests } = await fixture();
    const thread = await client.startThread("/workspace", "Decision");
    await client.startTurn(thread, "/workspace", "Work", "model", "low");
    const completed = new Promise<void>((resolve) => client.onNotification((notification) => {
      if (notification.method === "turn/completed") resolve();
    }));
    await client.resumeThread(thread, "/finish-during-resume");
    await completed;
    expect((await requests()).filter((request) => request.method === "thread/unsubscribe")).toHaveLength(1);
  });

  it("handles completion arriving before the turn/start response", async () => {
    const { client, requests } = await fixture();
    const thread = await client.startThread("/workspace", "Fast turn");
    const completed = new Promise<void>((resolve) => client.onNotification((n) => {
      if (n.method === "turn/completed") resolve();
    }));
    await client.startTurn(thread, "/workspace", "complete-before-response", "model", "low");
    await completed;
    expect((await requests()).filter((r) => r.method === "thread/unsubscribe")).toHaveLength(1);
  });

  it("releases an idle conversation when sending a new turn fails", async () => {
    const { client, requests } = await fixture();
    const thread = await client.startThread("/workspace", "Decision");
    await expect(client.startTurn(thread, "/workspace", "fail-before-turn", "model", "low"))
      .rejects.toThrow("turn rejected");
    expect((await requests()).filter((request) => request.method === "thread/unsubscribe")).toHaveLength(1);
    await expect(client.startTurn(thread, "/workspace", "Retry decision", "model", "low")).resolves.toBeTruthy();
  });

  it("keeps an active turn subscribed when another start request fails", async () => {
    const { client, requests } = await fixture();
    const thread = await client.startThread("/workspace", "Active work");
    await client.startTurn(thread, "/workspace", "Work", "model", "low");
    await expect(client.startTurn(thread, "/workspace", "fail-before-turn", "model", "low"))
      .rejects.toThrow("turn rejected");
    expect((await requests()).filter((request) => request.method === "thread/unsubscribe")).toHaveLength(0);
  });

  it("keeps completion observable when unsubscribe fails and does not silently drop the error", async () => {
    const { client, complete, errors } = await fixture(true);
    const thread = await client.startThread("/workspace", "Decision");
    const turn = await client.startTurn(thread, "/workspace", "Work", "model", "low");
    await complete(thread, turn);
    expect(errors.join(" ")).toContain("unsubscribe");
    await expect(client.startTurn(thread, "/workspace", "Retry", "model", "low")).resolves.toBeTruthy();
  });
});

interface Request { method: string; params: Record<string, unknown> }
async function fixture(failUnsubscribe = false) {
  const directory = await mkdtemp(join(tmpdir(), "codrive-release-"));
  const trace = join(directory, "requests.ndjson");
  const control = join(directory, "notifications.ndjson");
  const executable = join(directory, "codex.mjs");
  await writeFile(control, "");
  await writeFile(executable, fakeRuntime(trace, control, failUnsubscribe));
  await chmod(executable, 0o755);
  const errors: string[] = [];
  const client = new CodexAppServerClient({ executable, onStderr: (text) => errors.push(text) });
  cleanup.push(async () => { await client.stop(); await rm(directory, { recursive: true, force: true }); });
  const requests = async (): Promise<Request[]> => (await readFile(trace, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const complete = async (threadId: string, turnId: string, status = "completed") => {
    const observed = new Promise<void>((resolve) => {
      const off = client.onNotification((n) => {
        if (n.method === "turn/completed" && (n.params as {turn:{id:string}}).turn.id === turnId) { off(); resolve(); }
      });
    });
    await appendFile(control, JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: turnId, status } } }) + "\n");
    await observed;
  };
  return { client, complete, requests, errors };
}

function fakeRuntime(trace: string, control: string, failUnsubscribe: boolean): string {
  return `#!/usr/bin/env node
import { appendFileSync, readFileSync, watchFile } from 'node:fs';
import { createInterface } from 'node:readline';
const trace = ${JSON.stringify(trace)};
const control = ${JSON.stringify(control)};
const threads = new Map();
let turnCounter = 0, threadCounter = 0, notificationCount = 0;
let failUnsubscribe = ${JSON.stringify(failUnsubscribe)};
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
function notify(message) {
 const state = threads.get(message.params.threadId);
 if (state && state.turnId === message.params.turn.id) state.active = false;
 send(message);
}
watchFile(control, { interval: 5 }, () => {
 const lines = readFileSync(control, 'utf8').trim().split('\\n').filter(Boolean);
 for (const line of lines.slice(notificationCount)) notify(JSON.parse(line));
 notificationCount = lines.length;
});
createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 appendFileSync(trace, line + '\\n');
 if (!('id' in request)) return;
 let result = {};
 const state = threads.get(request.params?.threadId);
 if (request.method === 'thread/start') {
  const id = 'thread_' + ++threadCounter;
  threads.set(id, { loaded:true, active:false });
  result = {thread:{id}};
 }
 if (request.method === 'thread/resume') {
  if (state.closing) { send({id:request.id,error:{code:-32600,message:'thread is closing'}}); return; }
  state.loaded = true;
  if (request.params.cwd === '/finish-during-resume') notify({method:'turn/completed',params:{threadId:request.params.threadId,turn:{id:state.turnId,status:'completed'}}});
  result = { thread: { id:request.params.threadId, status:{type:state.active?'active':'idle'}, turns:[] } };
 }
 if (request.method === 'thread/read') result = {thread:{status:{type:state.active?'active':'idle'},turns:state.active?[{id:state.turnId,status:'inProgress'}]:[]}};
 if (request.method === 'turn/start') {
  if (request.params.input[0].text === 'fail-before-turn') {send({id:request.id,error:{code:-32000,message:'turn rejected'}});return;}
  if (!state.loaded || state.closing) { send({id:request.id,error:{code:-32600,message:'thread not loaded'}}); return; }
  state.active = true;
  state.turnId = 'turn_' + ++turnCounter;
  result = {turn:{id:state.turnId}};
  if (request.params.input[0].text === 'complete-before-response') notify({method:'turn/completed',params:{threadId:request.params.threadId,turn:{id:state.turnId,status:'completed'}}});
 }
 if (request.method === 'thread/unsubscribe') {
  if (failUnsubscribe) { failUnsubscribe=false; send({id:request.id,error:{code:-32000,message:'unsubscribe failed'}}); return; }
  state.closing = true;
  result = {status:'unsubscribed'};
  setTimeout(() => {state.loaded=false;state.closing=false;send({method:'thread/closed',params:{threadId:request.params.threadId}});},25);
 }
 send({id:request.id,result});
});
`;
}
