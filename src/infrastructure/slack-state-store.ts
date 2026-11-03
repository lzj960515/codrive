import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  SlackConversation,
  SlackDeliveryRecord,
  SlackInputReceipt,
} from "../domain/slack-state.js";

type Collection = "conversations" | "inputs" | "deliveries";
type SlackRecord = SlackConversation | SlackInputReceipt | SlackDeliveryRecord;

export class SlackStateStore {
  private readonly directory: string;
  private initialization: Promise<void> | null = null;

  constructor(stateDirectory: string) {
    this.directory = join(stateDirectory, "slack");
  }

  async initialize(): Promise<void> {
    this.initialization ??= this.initializeCollections();
    await this.initialization;
  }

  getConversation(id: string): Promise<SlackConversation | null> {
    return this.readRecord("conversations", id);
  }

  saveConversation(conversation: SlackConversation): Promise<void> {
    return this.saveRecord("conversations", conversation);
  }

  listConversations(): Promise<SlackConversation[]> {
    return this.listRecords("conversations");
  }

  getInput(id: string): Promise<SlackInputReceipt | null> {
    return this.readRecord("inputs", id);
  }

  saveInput(receipt: SlackInputReceipt): Promise<void> {
    return this.saveRecord("inputs", receipt);
  }

  listInputs(): Promise<SlackInputReceipt[]> {
    return this.listRecords("inputs");
  }

  getDelivery(id: string): Promise<SlackDeliveryRecord | null> {
    return this.readRecord("deliveries", id);
  }

  saveDelivery(delivery: SlackDeliveryRecord): Promise<void> {
    return this.saveRecord("deliveries", delivery);
  }

  listDeliveries(): Promise<SlackDeliveryRecord[]> {
    return this.listRecords("deliveries");
  }

  private async initializeCollections(): Promise<void> {
    await Promise.all((["conversations", "inputs", "deliveries"] as const).map(
      (collection) => mkdir(join(this.directory, collection), { recursive: true, mode: 0o700 }),
    ));
  }

  private recordPath(collection: Collection, id: string): string {
    if (!id.trim()) throw new Error("Slack record identity must not be empty");
    // 外部事件和讨论串身份可含分隔符，仅将摘要用作本机文件名。
    const filename = `${createHash("sha256").update(id).digest("hex")}.json`;
    return join(this.directory, collection, filename);
  }

  private async readRecord<T extends SlackRecord>(collection: Collection, id: string): Promise<T | null> {
    await this.initialize();
    try {
      const record = JSON.parse(await readFile(this.recordPath(collection, id), "utf8")) as T;
      if (record.id !== id) throw new Error(`Slack ${collection} record identity does not match ${id}`);
      return record;
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  private async saveRecord(collection: Collection, record: SlackRecord): Promise<void> {
    await this.initialize();
    const path = this.recordPath(collection, record.id);
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  }

  private async listRecords<T extends SlackRecord>(collection: Collection): Promise<T[]> {
    await this.initialize();
    const directory = join(this.directory, collection);
    const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
    const records = await Promise.all(files.map(async (file) =>
      JSON.parse(await readFile(join(directory, file), "utf8")) as T,
    ));
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
