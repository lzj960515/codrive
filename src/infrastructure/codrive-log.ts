import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { stripVTControlCharacters } from "node:util";

import type { LifecycleEvent } from "../domain/types.js";

interface CodriveLogOptions {
  now?: () => Date;
  writeToTerminal?: (text: string) => void;
  maxBytes?: number;
  archiveMaxBytes?: number;
  archiveMaxAgeMs?: number;
}

const utcTimestamp =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+(.*)$/;
const jsonTimestamp =
  /^\{"timestamp":"([^"]+)",(.*)\}$/;
const defaultMaxBytes = 10 * 1024 * 1024;
const defaultArchiveMaxAgeMs = 7 * 24 * 60 * 60 * 1_000;
const maximumTimerDelayMs = 2_147_483_647;

export class CodriveLog {
  private fileDescriptor: number;
  private currentBytes: number;
  private readonly maxBytes: number;
  private readonly archiveMaxBytes: number;
  private readonly archiveMaxAgeMs: number;
  private readonly now: () => Date;
  private readonly writeToTerminal: (text: string) => void;
  private readonly pendingLines = new Map<string, string>();
  private archiveExpiryTimer: NodeJS.Timeout | null = null;

  constructor(readonly path: string, options: CodriveLogOptions = {}) {
    mkdirSync(dirname(path), { recursive: true });
    this.maxBytes = options.maxBytes ?? defaultMaxBytes;
    this.archiveMaxBytes = options.archiveMaxBytes ?? this.maxBytes;
    this.archiveMaxAgeMs =
      options.archiveMaxAgeMs ?? defaultArchiveMaxAgeMs;
    this.now = options.now ?? (() => new Date());
    this.writeToTerminal =
      options.writeToTerminal ?? ((text) => process.stderr.write(text));
    this.enforceArchiveRetention();
    this.fileDescriptor = openSync(path, "a", 0o600);
    chmodSync(path, 0o600);
    this.currentBytes = statSync(path).size;
    this.rotateIfNeeded(0);
  }

  write(source: string, text: string): void {
    const buffered = `${this.pendingLines.get(source) ?? ""}${text}`;
    const lines = buffered.split("\n");
    this.pendingLines.set(source, lines.pop()!);
    for (const line of lines) this.writeProcessLine(source, line);
  }

  info(message: string): void {
    this.writeLine("codrive", "INFO", message, this.now());
  }

  error(source: string, message: string): void {
    this.writeLine(source, "ERROR", message, this.now());
  }

  event(event: LifecycleEvent): void {
    const { state: _state, ...details } = event as LifecycleEvent & {
      state?: unknown;
    };
    const safeDetails =
      details.type === "task.activity_recorded"
        ? { ...details, data: { activityRecorded: true } }
        : details;
    this.writeLine(
      "lifecycle",
      "EVENT",
      JSON.stringify(safeDetails),
      new Date(event.occurredAt),
    );
  }

  close(): void {
    this.clearArchiveExpiryTimer();
    for (const [source, line] of this.pendingLines) {
      if (line) this.writeProcessLine(source, line);
    }
    this.pendingLines.clear();
    closeSync(this.fileDescriptor);
  }

  private writeProcessLine(source: string, rawLine: string): void {
    const normalizedLine = stripVTControlCharacters(rawLine);
    const line = normalizedLine.endsWith("\r")
      ? normalizedLine.slice(0, -1)
      : normalizedLine;
    if (!line) return;
    const timestamped = utcTimestamp.exec(line);
    if (timestamped) {
      this.writeLine(source, "", timestamped[2]!, new Date(timestamped[1]!));
      return;
    }
    const structured = jsonTimestamp.exec(line);
    if (structured) {
      this.writeLine(source, "", `{${structured[2]!}}`, new Date(structured[1]!));
      return;
    }
    this.writeLine(source, "", line, this.now());
  }

  private writeLine(
    source: string,
    level: string,
    message: string,
    timestamp: Date,
  ): void {
    const prefix = `[${formatLocalTimestamp(timestamp)}] [${source}]`;
    const line = `${prefix}${level ? ` ${level}` : ""} ${message}\n`;
    const lineBytes = Buffer.byteLength(line);
    this.rotateIfNeeded(lineBytes);
    writeSync(this.fileDescriptor, line);
    this.currentBytes += lineBytes;
    this.writeToTerminal(line);
  }

  private rotateIfNeeded(incomingBytes: number): void {
    if (
      this.maxBytes <= 0 ||
      this.currentBytes === 0 ||
      this.currentBytes + incomingBytes <= this.maxBytes
    ) {
      return;
    }
    closeSync(this.fileDescriptor);
    const archivePath = `${this.path}.1`;
    removeFileIfExists(archivePath);
    renameSync(this.path, archivePath);
    this.enforceArchiveRetention();
    this.fileDescriptor = openSync(this.path, "a", 0o600);
    chmodSync(this.path, 0o600);
    this.currentBytes = 0;
  }

  private enforceArchiveRetention(): void {
    this.clearArchiveExpiryTimer();
    const archivePath = `${this.path}.1`;
    let archiveStats;
    try {
      archiveStats = statSync(archivePath);
    } catch (error) {
      if (isFileNotFound(error)) return;
      throw error;
    }

    const archiveAgeMs = this.now().getTime() - archiveStats.mtimeMs;
    if (this.archiveMaxAgeMs > 0 && archiveAgeMs >= this.archiveMaxAgeMs) {
      unlinkSync(archivePath);
      return;
    }
    if (
      this.archiveMaxBytes <= 0 ||
      archiveStats.size <= this.archiveMaxBytes
    ) {
      this.scheduleArchiveExpiry(archiveStats.mtimeMs);
      return;
    }

    const readBytes = Math.min(
      archiveStats.size,
      this.archiveMaxBytes + 1,
    );
    const tail = Buffer.allocUnsafe(readBytes);
    const archiveFile = openSync(archivePath, "r");
    try {
      readSync(
        archiveFile,
        tail,
        0,
        readBytes,
        archiveStats.size - readBytes,
      );
    } finally {
      closeSync(archiveFile);
    }

    const overflowBytes = readBytes - this.archiveMaxBytes;
    let retainedStart = overflowBytes;
    if (overflowBytes > 0 && tail[overflowBytes - 1] !== 0x0a) {
      const nextLineBreak = tail.indexOf(0x0a, overflowBytes);
      retainedStart = nextLineBreak === -1 ? tail.length : nextLineBreak + 1;
    }
    writeFileSync(archivePath, tail.subarray(retainedStart), { mode: 0o600 });
    chmodSync(archivePath, 0o600);
    utimesSync(archivePath, archiveStats.atime, archiveStats.mtime);
    this.scheduleArchiveExpiry(archiveStats.mtimeMs);
  }

  private scheduleArchiveExpiry(archiveModifiedAt: number): void {
    if (this.archiveMaxAgeMs <= 0) return;
    const expiresAt = archiveModifiedAt + this.archiveMaxAgeMs;
    const delayMs = Math.min(
      Math.max(0, expiresAt - this.now().getTime()),
      maximumTimerDelayMs,
    );
    this.archiveExpiryTimer = setTimeout(() => {
      this.archiveExpiryTimer = null;
      this.enforceArchiveRetention();
    }, delayMs);
    this.archiveExpiryTimer.unref();
  }

  private clearArchiveExpiryTimer(): void {
    if (this.archiveExpiryTimer) clearTimeout(this.archiveExpiryTimer);
    this.archiveExpiryTimer = null;
  }
}

function removeFileIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  }
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function formatLocalTimestamp(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffset / 60);
  const offsetRemainder = absoluteOffset % 60;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    `${String(date.getMilliseconds()).padStart(3, "0")} ` +
    `${offsetSign}${pad(offsetHours)}:${pad(offsetRemainder)}`
  );
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
