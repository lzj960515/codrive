import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { WebClient } from "@slack/web-api";

import type { SlackIncomingFile, SlackLocalFile } from "../../domain/slack.js";
import type { SlackReplyTarget } from "../../domain/work-source.js";

/** 文件内容沿现有收件上下文交给 Codex；本层只负责 Slack 与本机的字节传输。 */
export class SlackFiles {
  constructor(
    private readonly stateDirectory: string,
    private readonly botToken: string,
    private readonly client: WebClient,
  ) {}

  async download(teamId: string, files: SlackIncomingFile[]): Promise<SlackLocalFile[]> {
    const local: SlackLocalFile[] = [];
    for (const file of files) local.push(await this.downloadFile(teamId, file));
    return local;
  }

  async upload(
    target: SlackReplyTarget,
    input: { filePath: string; title?: string; comment?: string },
  ): Promise<{ id: string; name: string; permalink?: string }> {
    const filePath = resolve(input.filePath);
    if (!(await stat(filePath)).isFile()) throw new Error("请选择一个可读取的本机文件。");
    const filename = basename(filePath);
    const contents = {
      file: filePath,
      filename,
      ...(input.title ? { title: input.title } : {}),
      ...(input.comment ? { initial_comment: input.comment } : {}),
    };
    const result = target.threadTs
      ? await this.client.filesUploadV2({ ...contents, channel_id: target.channelId, thread_ts: target.threadTs })
      : await this.client.filesUploadV2({ ...contents, channel_id: target.channelId });
    if (!result.ok) throw new Error("Slack 未确认文件上传成功。");
    for (const completion of result.files) {
      if (!completion.ok) throw new Error(completion.error ?? "Slack 未确认文件已经发到目标会话。");
    }
    const uploaded = result.files.flatMap((completion) => completion.files ?? [])[0];
    if (!uploaded?.id) throw new Error("Slack 没有返回实际上传的文件身份。");
    return {
      id: uploaded.id,
      name: uploaded.name ?? filename,
      ...(uploaded.permalink ? { permalink: uploaded.permalink } : {}),
    };
  }

  private async downloadFile(teamId: string, reference: SlackIncomingFile): Promise<SlackLocalFile> {
    const file = await this.fileMetadata(reference);
    const downloadUrl = file.url_private_download ?? file.url_private;
    if (!downloadUrl) throw new Error("Slack 尚未提供附件的下载资料，请稍后重试。");
    const url = new URL(downloadUrl);
    if (!this.isSlackFileHost(url)) {
      throw new Error("当前附件不是 Slack 托管的私有文件，请直接上传文件后重试。");
    }
    const name = file.name || file.id;
    const identity = createHash("sha256").update(`${teamId}:${file.id}`).digest("hex");
    const directory = join(this.stateDirectory, "slack", "files", identity);
    const path = join(directory, this.localFilename(name, file.id));
    const local: SlackLocalFile = {
      id: file.id,
      name,
      path,
      ...(file.mimetype ? { mimetype: file.mimetype } : {}),
    };
    if (await this.isDownloaded(path)) return local;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      const response = await this.readFileResponse(url);
      if (!response.ok) throw new Error(`Slack 文件下载失败（HTTP ${response.status}）。`);
      if (!response.body) throw new Error("Slack 文件下载没有返回内容。");
      const content = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
      await pipeline(content, createWriteStream(temporaryPath, { mode: 0o600 }));
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    return local;
  }

  private async fileMetadata(file: SlackIncomingFile): Promise<SlackIncomingFile> {
    if (file.url_private_download || file.url_private) return file;
    const result = await this.client.files.info({ file: file.id });
    if (!result.ok || !result.file) throw new Error(result.error ?? "Slack 尚未提供附件的下载资料。");
    return {
      id: file.id,
      ...(result.file.name ? { name: result.file.name } : {}),
      ...(result.file.mimetype ? { mimetype: result.file.mimetype } : {}),
      ...(result.file.url_private ? { url_private: result.file.url_private } : {}),
      ...(result.file.url_private_download ? { url_private_download: result.file.url_private_download } : {}),
    };
  }

  private async readFileResponse(initial: URL): Promise<Response> {
    let url = initial;
    const signal = AbortSignal.timeout(60_000);
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (url.protocol !== "https:") throw new Error("Slack 文件下载需要安全的 HTTPS 地址。");
      // 外部文件可能借用 url_private；每一跳单独判断，凭据只发送给准确的 Slack 文件主机。
      const headers = this.isSlackFileHost(url) ? { Authorization: `Bearer ${this.botToken}` } : {};
      const response = await fetch(url, { headers, redirect: "manual", signal });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Slack 文件下载的跳转没有目标地址。");
      url = new URL(location, url);
    }
    throw new Error("Slack 文件下载发生了过多跳转。");
  }

  private isSlackFileHost(url: URL): boolean {
    return url.protocol === "https:" && !url.username && !url.password &&
      (url.hostname === "files.slack.com" || url.hostname === "files-origin.slack.com");
  }

  private localFilename(name: string, fallback: string): string {
    let filename = basename(name.replaceAll("\\", "/")).replace(/[\u0000-\u001f]/g, "_");
    if (!filename || filename === "." || filename === "..") filename = fallback;
    // 留出原子写临时后缀的空间，同时保留完整的 Unicode 字符。
    while (Buffer.byteLength(filename, "utf8") > 180) filename = [...filename].slice(0, -1).join("");
    return filename;
  }

  private async isDownloaded(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }
}
