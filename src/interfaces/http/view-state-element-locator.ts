export interface ViewStateElement {
  id: string;
  hasAttribute(attribute: string): boolean;
  getAttribute(attribute: string): string | null;
}

export interface ViewStateElementIdentity {
  attribute: string;
  value: string;
}

export interface ViewStateElementLocator<TElement extends ViewStateElement> {
  identify(element: TElement): ViewStateElementIdentity | null;
  find(identity: ViewStateElementIdentity | null): TElement | null;
}

export function createViewStateElementLocator<
  TElement extends ViewStateElement,
>(dependencies: {
  findById(value: string): TElement | null;
  findByAttribute(attribute: string): TElement[];
}): ViewStateElementLocator<TElement> {
  const stableAttributes = [
    "data-task",
    "data-project",
    "data-project-action",
    "data-copy-task-id",
    "data-task-sort",
    "data-retry",
    "data-continue-now",
    "data-reschedule",
    "data-reschedule-at",
    "data-reveal-activities",
    "data-activity-entry",
    "data-activity-thread",
    "name",
  ];

  return {
    identify(element) {
      if (element.id) return { attribute: "id", value: element.id };
      for (const attribute of stableAttributes) {
        if (element.hasAttribute(attribute)) {
          return {
            attribute,
            value: element.getAttribute(attribute) ?? "",
          };
        }
      }
      return null;
    },
    find(identity) {
      if (!identity) return null;
      if (identity.attribute === "id") {
        return dependencies.findById(identity.value);
      }
      return (
        dependencies
          .findByAttribute(identity.attribute)
          .find(
            (element) =>
              element.getAttribute(identity.attribute) === identity.value,
          ) ?? null
      );
    },
  };
}
