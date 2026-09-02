import { describe, expect, it } from "vitest";

import { createViewStateElementLocator } from "../../src/interfaces/http/view-state-element-locator.js";

class TestElement {
  readonly id: string;
  focused = false;

  constructor(
    id: string,
    private readonly attributes: Record<string, string>,
  ) {
    this.id = id;
  }

  hasAttribute(attribute: string): boolean {
    return Object.hasOwn(this.attributes, attribute);
  }

  getAttribute(attribute: string): string | null {
    return this.attributes[attribute] ?? null;
  }

  focus(): void {
    this.focused = true;
  }
}

describe("ViewStateElementLocator", () => {
  it.each([
    ["history reveal", { "data-reveal-activities": "" }],
    ["revealed activity", { "data-activity-entry": "activity-1" }],
  ])("restores focus to a rerendered %s", (_name, attributes) => {
    let renderedElements = [new TestElement("", attributes)];
    const locator = createViewStateElementLocator<TestElement>({
      findById: (value) =>
        renderedElements.find((element) => element.id === value) ?? null,
      findByAttribute: (attribute) =>
        renderedElements.filter((element) => element.hasAttribute(attribute)),
    });
    const activeIdentity = locator.identify(renderedElements[0]!);

    const distractorAttributes = Object.hasOwn(
      attributes,
      "data-activity-entry",
    )
      ? { "data-activity-entry": "activity-other" }
      : { "data-task": "task-other" };
    renderedElements = [
      new TestElement("", distractorAttributes),
      new TestElement("", attributes),
    ];
    const restoredElement = locator.find(activeIdentity);
    restoredElement?.focus();

    expect(activeIdentity).not.toBeNull();
    expect(restoredElement).toBe(renderedElements[1]);
    expect(renderedElements[1]!.focused).toBe(true);
  });

  it("preserves an element ID as the strongest identity", () => {
    const element = new TestElement("task-detail", {
      "data-task": "task-1",
    });
    const locator = createViewStateElementLocator<TestElement>({
      findById: (value) => (value === element.id ? element : null),
      findByAttribute: () => [],
    });

    const identity = locator.identify(element);

    expect(identity).toEqual({ attribute: "id", value: "task-detail" });
    expect(locator.find(identity)).toBe(element);
  });
});
