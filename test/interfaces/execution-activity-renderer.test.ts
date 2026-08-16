import { describe, expect, it } from "vitest";

import { createExecutionActivityRenderer } from "../../src/interfaces/http/execution-activity-renderer.js";

describe("ExecutionActivityRenderer", () => {
  it("finishes a three-signal animation window on the newest activity", () => {
    const host = new FakeElement("section");
    const scheduled: Array<() => void> = [];
    const render = createExecutionActivityRenderer({
      getHost: () => host as unknown as HTMLElement,
      createElement: (tagName) =>
        new FakeElement(tagName) as unknown as HTMLElement,
      formatTime: (value) => value,
      schedule: (callback) => {
        scheduled.push(callback);
      },
    });

    render(activity("reading", "正在读取源码"));
    render(activity("editing", "正在编辑文件"));
    render(activity("tests", "正在运行测试"));

    expect(host.children.map(activityLabel)).toEqual([
      "正在读取源码",
      "正在运行测试",
    ]);
    for (const callback of scheduled) callback();
    expect(host.children.map(activityLabel)).toEqual(["正在运行测试"]);
  });
});

function activity(key: string, label: string) {
  return {
    key,
    label,
    occurredAt: `2026-08-16T01:00:0${key.length}.000Z`,
    waiting: false,
  };
}

function activityLabel(element: FakeElement): string {
  return element.children[1]?.textContent ?? "";
}

class FakeClassList {
  readonly values = new Set<string>();

  add(...names: string[]): void {
    for (const name of names) this.values.add(name);
  }

  remove(...names: string[]): void {
    for (const name of names) this.values.delete(name);
  }
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly classList = new FakeClassList();
  readonly dataset: Record<string, string> = {};
  className = "";
  dateTime = "";
  textContent = "";
  private parent: FakeElement | null = null;

  constructor(readonly tagName: string) {}

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get isConnected(): boolean {
    return this.parent !== null;
  }

  append(...elements: FakeElement[]): void {
    for (const element of elements) {
      element.remove();
      element.parent = this;
      this.children.push(element);
    }
  }

  replaceChildren(...elements: FakeElement[]): void {
    for (const child of this.children) child.parent = null;
    this.children.length = 0;
    this.append(...elements);
  }

  remove(): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }

  setAttribute(): void {}

  addEventListener(): void {}
}
