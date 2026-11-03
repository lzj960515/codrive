import { isDeepStrictEqual } from "node:util";

import { WorkflowConflictError } from "../domain/errors.js";
import { SlackDeliveryError, type SlackTransport } from "../domain/slack.js";
import type { SlackDeliveryRecord } from "../domain/slack-state.js";
import type { SlackStateStore } from "../infrastructure/slack-state-store.js";

/** 只负责结果送达；重试发送不重新触发产生结果的业务工作。 */
export class SlackDeliveryService {
  private readonly inFlight = new Map<string, Promise<SlackDeliveryRecord>>();

  constructor(
    private readonly store: SlackStateStore,
    private readonly transport: Pick<SlackTransport, "sendMessage">,
    private readonly teamId: string,
  ) {}

  async deliver(record: SlackDeliveryRecord): Promise<SlackDeliveryRecord> {
    const previous = this.inFlight.get(record.id);
    // 同一请求串行送达；上一轮失败已保存并向调用方抛出，本轮仍可恢复。
    const operation = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(() => this.deliverRecord(record));
    this.inFlight.set(record.id, operation);
    try {
      return await operation;
    } finally {
      if (this.inFlight.get(record.id) === operation) this.inFlight.delete(record.id);
    }
  }

  async flushPending(onError: (error: unknown) => void): Promise<void> {
    for (const delivery of await this.store.listDeliveries()) {
      if (delivery.sentAt) continue;
      try {
        await this.deliver(delivery);
      } catch (error) {
        onError(error);
      }
    }
  }

  private async deliverRecord(request: SlackDeliveryRecord): Promise<SlackDeliveryRecord> {
    this.assertWorkspace(request);
    const existing = await this.store.getDelivery(request.id);
    if (existing) this.assertWorkspace(existing);
    if (existing && (
      !isDeepStrictEqual(existing.target, request.target) ||
      existing.markdown !== request.markdown
    )) {
      throw new WorkflowConflictError(
        `Slack delivery ${request.id} was already registered with a different body or destination`,
      );
    }
    if (existing?.sentAt) return existing;
    const delivery = existing ?? request;
    await this.store.saveDelivery(delivery);

    let response: { messageTs: string };
    try {
      response = await this.transport.sendMessage(delivery.target, delivery.markdown, delivery.progress);
    } catch (error) {
      const failed: SlackDeliveryRecord = {
        ...delivery,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof SlackDeliveryError && error.progress
          ? { progress: error.progress }
          : {}),
      };
      await this.store.saveDelivery(failed);
      throw error;
    }

    const sent: SlackDeliveryRecord = {
      ...delivery,
      messageTs: response.messageTs,
      sentAt: new Date().toISOString(),
    };
    delete sent.error;
    delete sent.progress;
    await this.store.saveDelivery(sent);
    return sent;
  }

  private assertWorkspace(delivery: SlackDeliveryRecord): void {
    if (delivery.target.teamId !== this.teamId) {
      throw new WorkflowConflictError(
        `Slack delivery ${delivery.id} belongs to another workspace`,
      );
    }
  }
}
