import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

interface CodriveLogOptions {
  now?: () => Date;
  writeToTerminal?: (text: string) => void;
}

const utcTimestamp =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+(.*)$/;
const jsonTimestamp =
  /^\{"timestamp":"([^"]+)",(.*)\}$/;

export class CodriveLog {
  private readonly fileDescriptor: number;
  private readonly now: () => Date;
  private readonly writeToTerminal: (text: string) => void;
  private readonly pendingLines = new Map<string, string>();

  constructor(readonly path: string, options: CodriveLogOptions = {}) {
    mkdirSync(dirname(path), { recursive: true });
    this.fileDescriptor = openSync(path, "a", 0o600);
    chmodSync(path, 0o600);
    this.now = options.now ?? (() => new Date());
    this.writeToTerminal =
      options.writeToTerminal ?? ((text) => process.stderr.write(text));
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

  close(): void {
    for (const [source, line] of this.pendingLines) {
      if (line) this.writeProcessLine(source, line);
    }
    this.pendingLines.clear();
    closeSync(this.fileDescriptor);
  }

  private writeProcessLine(source: string, rawLine: string): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
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
    writeSync(this.fileDescriptor, line);
    this.writeToTerminal(line);
  }
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
