export interface ExecutionActivityView {
  key: string;
  label: string;
  occurredAt?: string;
  waiting: boolean;
}

interface ExecutionActivityRendererOptions {
  getHost(): HTMLElement | null;
  createElement(tagName: string): HTMLElement;
  formatTime(value: string): string;
  schedule(callback: () => void, delay: number): unknown;
}

export function createExecutionActivityRenderer(
  options: ExecutionActivityRendererOptions,
): (activity: ExecutionActivityView) => void {
  let targetHost: HTMLElement | null = null;
  let targetKey: string | null = null;
  let revision = 0;

  return (activity) => {
    const host = options.getHost();
    if (!host) return;
    if (host === targetHost && activity.key === targetKey) return;

    targetHost = host;
    targetKey = activity.key;
    const renderRevision = ++revision;
    const next = options.createElement("div");
    next.className = activity.waiting
      ? "current-activity-entry current-activity-waiting entering"
      : "current-activity-entry entering";
    next.dataset.activityKey = activity.key;

    const marker = options.createElement("span");
    marker.className = "current-activity-marker";
    marker.setAttribute("aria-hidden", "true");
    const copy = options.createElement("span");
    copy.textContent = activity.label;
    next.append(marker, copy);
    if (activity.occurredAt) {
      const occurredAt = options.createElement("time") as HTMLTimeElement;
      occurredAt.dateTime = activity.occurredAt;
      occurredAt.textContent = options.formatTime(activity.occurredAt);
      next.append(occurredAt);
    }

    const previous = host.firstElementChild as HTMLElement | null;
    for (const child of Array.from(host.children)) {
      if (child !== previous) child.remove();
    }
    if (!previous) {
      host.replaceChildren(next);
      next.classList.remove("entering");
      return;
    }

    previous.classList.add("leaving");
    host.append(next);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (
        renderRevision !== revision ||
        targetHost !== host ||
        targetKey !== activity.key
      ) {
        next.remove();
        return;
      }
      if (!next.isConnected) return;
      next.classList.remove("entering");
      host.replaceChildren(next);
    };
    previous.addEventListener("animationend", finish, { once: true });
    options.schedule(finish, 360);
  };
}
