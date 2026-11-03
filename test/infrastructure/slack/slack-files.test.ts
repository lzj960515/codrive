import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { WebClient } from "@slack/web-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SlackFiles } from "../../../src/infrastructure/slack/slack-files.js";

describe("Slack 双向文件传输", () => {
  let directory: string;
  const token = "private-bot-token";
  const info = vi.fn();
  const filesUploadV2 = vi.fn();
  const download = vi.fn<typeof fetch>();
  let files: SlackFiles;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "codrive-slack-files-"));
    info.mockReset();
    filesUploadV2.mockReset();
    download.mockReset();
    vi.stubGlobal("fetch", download);
    files = new SlackFiles(directory, token, { files: { info }, filesUploadV2 } as unknown as WebClient);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });

  it("保存原文件字节与类型，重复文件复用已下载内容且文件名不会逃出状态目录", async () => {
    const bytes = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
    download.mockResolvedValue(new Response(bytes));
    const input = { id: "F_picture", name: "../../截图.png", mimetype: "image/png", url_private_download: "https://files.slack.com/files-pri/T_owner-F_picture/shot.png" };
    const [first] = await files.download("T_owner", [input]);
    const [repeated] = await files.download("T_owner", [input]);
    expect(first).toMatchObject({ id: "F_picture", name: "../../截图.png", mimetype: "image/png" });
    expect(repeated).toEqual(first);
    expect(relative(directory, first!.path).startsWith("slack/files/")).toBe(true);
    expect(await readFile(first!.path)).toEqual(bytes);
    expect((await stat(first!.path)).mode & 0o777).toBe(0o600);
    expect(download).toHaveBeenCalledTimes(1);
    expect(new Headers(download.mock.calls[0]![1]?.headers).get("Authorization")).toBe(`Bearer ${token}`);
    expect(info).not.toHaveBeenCalled();
  });

  it("事件只带文件身份时读取实际文件资料，并隔离不同工作区的本机副本", async () => {
    info.mockResolvedValue({ ok: true, file: { id: "F_document", name: "report.pdf", mimetype: "application/pdf", url_private: "https://files.slack.com/files-pri/T_owner-F_document/report.pdf" } });
    download.mockImplementation(async () => new Response("%PDF-1.7 test"));
    const [first] = await files.download("T_owner", [{ id: "F_document" }]);
    const [other] = await files.download("T_other", [{ id: "F_document" }]);
    expect(await readFile(first!.path, "utf8")).toBe("%PDF-1.7 test");
    expect(first!.mimetype).toBe("application/pdf");
    expect(other!.path).not.toBe(first!.path);
    expect(info).toHaveBeenCalledWith({ file: "F_document" });
  });

  it.each([
    "https://files.slack.com.attacker.test/private.pdf",
    "http://files.slack.com/private.pdf",
    "https://outside.test/private.pdf",
  ])("不向非 Slack 私有文件网址泄漏凭据：%s", async (url) => {
    await expect(files.download("T_owner", [{ id: "F_remote", name: "remote.pdf", url_private: url }])).rejects.toThrow("Slack 托管");
    expect(download).not.toHaveBeenCalled();
  });

  it("Slack 文件跳转到其他主机时移除凭据，同时保留实际文件内容", async () => {
    download.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://download.example.test/signed-file" } }));
    download.mockResolvedValueOnce(new Response("signed file contents"));
    const [file] = await files.download("T_owner", [{ id: "F_signed", name: "signed.txt", url_private: "https://files.slack.com/files-pri/T_owner-F_signed/signed.txt" }]);
    expect(await readFile(file!.path, "utf8")).toBe("signed file contents");
    expect(new Headers(download.mock.calls[0]![1]?.headers).get("Authorization")).toBe(`Bearer ${token}`);
    expect(new Headers(download.mock.calls[1]![1]?.headers).get("Authorization")).toBeNull();
    expect(download.mock.calls.every(([, options]) => options?.redirect === "manual")).toBe(true);
  });

  it("下载失败保留失败事实，下一次成功后再产生可供读取的文件", async () => {
    download.mockResolvedValueOnce(new Response("not allowed", { status: 403 }));
    const input = { id: "F_failed", name: "data.csv", url_private: "https://files.slack.com/files-pri/T_owner-F_failed/data.csv" };
    await expect(files.download("T_owner", [input])).rejects.toThrow("403");
    download.mockResolvedValueOnce(new Response("name,value\nvisits,120"));
    const [file] = await files.download("T_owner", [input]);
    expect(await readFile(file!.path, "utf8")).toContain("visits,120");
    expect(await readdir(dirname(file!.path))).toEqual(["data.csv"]);
  });

  it("向原讨论串上传本机文件并只返回 Slack 确认的文件身份和链接", async () => {
    const path = join(directory, "数据.csv");
    await writeFile(path, "name,value\nvisits,120");
    filesUploadV2.mockResolvedValue({ ok: true, files: [{ ok: true, files: [{ id: "F_uploaded", name: "数据.csv", permalink: "https://workspace.slack.com/files/U/F_uploaded" }] }] });
    const result = await files.upload({ kind: "slack", teamId: "T_owner", channelId: "C_project", threadTs: "100.001" }, { filePath: path, title: "昨日数据", comment: "请查收。" });
    expect(result).toEqual({ id: "F_uploaded", name: "数据.csv", permalink: "https://workspace.slack.com/files/U/F_uploaded" });
    expect(filesUploadV2).toHaveBeenCalledWith({ channel_id: "C_project", thread_ts: "100.001", file: path, filename: "数据.csv", title: "昨日数据", initial_comment: "请查收。" });
  });

  it("文件不存在或上传没有实际成功回执时明确失败", async () => {
    const target = { kind: "slack" as const, teamId: "T_owner", channelId: "D_owner" };
    await expect(files.upload(target, { filePath: join(directory, "missing.txt") })).rejects.toThrow();
    expect(filesUploadV2).not.toHaveBeenCalled();
    const filePath = join(directory, "report.txt");
    await writeFile(filePath, "report");
    filesUploadV2.mockResolvedValue({ ok: true, files: [{ ok: false, error: "not_in_channel" }] });
    await expect(files.upload(target, { filePath })).rejects.toThrow("not_in_channel");
    filesUploadV2.mockResolvedValue({ ok: true, files: [{ ok: true, files: [] }] });
    await expect(files.upload(target, { filePath })).rejects.toThrow("文件身份");
  });
});
