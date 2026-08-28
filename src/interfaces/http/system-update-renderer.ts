interface SystemUpdateElement {
  textContent: string | null;
  innerHTML: string;
  hidden: boolean;
  disabled: boolean;
  dataset: Record<string, string>;
  style: { width: string };
}

interface ResourceStatus {
  state: string;
  bundledVersion: string;
  installedVersion?: string | null;
  conflictPaths: string[];
}

interface SystemUpdateProjection {
  version?: {
    currentVersion?: string;
    latestVersion?: string | null;
    updateAvailable?: boolean;
    lastCheckedAt?: string | null;
    checkError?: { summary: string } | null;
    checking?: boolean;
  } | null;
  upgrade?: {
    targetVersion: string;
    phase: string;
    updatedAt: string;
    phaseStartedAt?: Record<string, string>;
    error?: { summary: string };
  } | null;
  resources: {
    state: string;
    bundledVersion: string;
    managedSkillCount: number;
    managedHookCount: number;
    skills: ResourceStatus & { managedSkillCount: number };
    hook: ResourceStatus & { managedHookCount: number };
  };
  hookRuntime?: {
    state: "ready" | "review_required" | "disabled" | "missing" | "unavailable";
    definitionCount: number;
  } | null;
}

interface SystemUpdateRendererOptions {
  getElementById(id: string): SystemUpdateElement;
  label(state: string): string;
  formatTime(value?: string | null): string;
  escapeHtml(value: unknown): string;
}

export function createSystemUpdateRenderer(
  options: SystemUpdateRendererOptions,
) {
  const activeUpdatePhases = [
    "checking",
    "installing",
    "stopping",
    "migrating",
    "restarting",
    "syncing_resources",
  ];
  const updatePhaseCopy: Record<string, [string, number]> = {
    checking: ["正在固定目标版本", 8],
    installing: ["正在安装 Codrive", 28],
    stopping: ["正在停止旧服务", 42],
    migrating: ["正在迁移本地状态", 58],
    syncing_resources: ["正在同步托管资源", 76],
    restarting: ["正在启动新服务", 90],
    succeeded: ["更新完成", 100],
    failed: ["更新未完成", 100],
  };
  return function renderSystemUpdate(
    systemUpdate: SystemUpdateProjection,
    updateActionError: string | null,
  ): { shouldPoll: boolean; resourcesInstalled: boolean } {
    const { version, upgrade, resources } = systemUpdate;
    const { skills, hook } = resources;
    const resourcesInstalled = resources.state === "current";
    const hookRuntimeState = systemUpdate.hookRuntime?.state;
    const hookRuntimeNeedsAction =
      hook.state === "current" &&
      ["review_required", "disabled", "missing"].includes(
        hookRuntimeState ?? "",
      );
    const active = Boolean(
      upgrade && activeUpdatePhases.includes(upgrade.phase),
    );

    const triggerCopy = active
      ? updatePhaseCopy[upgrade!.phase]![0]
      : version?.updateAvailable
        ? `新版本 ${version.latestVersion} 可用`
        : resources.state === "conflict"
          ? "本地托管资源冲突待处理"
          : hookRuntimeNeedsAction
            ? "Codex Hook 待审核启用"
            : version?.latestVersion && resourcesInstalled
              ? "Codrive 与托管资源已对齐"
              : resourcesInstalled
                ? "等待稳定版检查"
                : "托管资源需要补齐";
    options.getElementById("update-trigger-copy").textContent = triggerCopy;
    options.getElementById("update-trigger-icon").textContent = active
      ? "↻"
      : version?.updateAvailable
        ? "↑"
        : hookRuntimeNeedsAction
          ? "!"
          : resourcesInstalled
            ? "✓"
            : "+";
    options.getElementById("update-trigger").dataset.state = active
      ? "active"
      : version?.updateAvailable || !resourcesInstalled || hookRuntimeNeedsAction
        ? "attention"
        : "current";

    options.getElementById("update-current-version").textContent =
      version?.currentVersion ?? resources.bundledVersion;
    options.getElementById("update-latest-version").textContent =
      version?.latestVersion ?? "待检查";
    options.getElementById("update-skills").textContent =
      skills.state === "current"
        ? `${skills.managedSkillCount} / ${skills.managedSkillCount} 已对齐`
        : options.label(skills.state);
    options.getElementById("update-hook").textContent =
      hook.state !== "current"
        ? options.label(hook.state)
        : hookRuntimeState === "ready"
          ? `${hook.managedHookCount} / ${hook.managedHookCount} 已启用`
          : hookRuntimeState === "review_required"
            ? "待 Codex 信任"
            : hookRuntimeState === "disabled"
              ? "已被 Codex 禁用"
              : hookRuntimeState === "missing"
                ? "Codex 未载入"
                : hookRuntimeState === "unavailable"
                  ? "已安装 · 状态待确认"
                  : `${hook.managedHookCount} / ${hook.managedHookCount} 已对齐`;
    options.getElementById("update-checked-at").textContent =
      options.formatTime(version?.lastCheckedAt);
    options.getElementById("update-check-result").textContent =
      version?.checkError?.summary ??
      (version?.latestVersion
        ? "npm latest 稳定版已读取"
        : "等待首次检查");

    const progress = options.getElementById("update-progress");
    progress.hidden = !upgrade;
    if (upgrade) {
      const phase = updatePhaseCopy[upgrade.phase] ?? [upgrade.phase, 0];
      options.getElementById("update-phase").textContent = phase[0];
      options.getElementById("update-progress-bar").style.width = `${phase[1]}%`;
      options.getElementById("update-phase-time").textContent =
        options.formatTime(upgrade.updatedAt);
      progress.dataset.phase = upgrade.phase;
    }
    const timeline = options.getElementById("update-timeline");
    const timelinePhases = Object.entries(upgrade?.phaseStartedAt ?? {});
    timeline.hidden = timelinePhases.length === 0;
    timeline.innerHTML = timelinePhases
      .map(
        ([phase, occurredAt]) =>
          `<div><span>${options.escapeHtml((updatePhaseCopy[phase] ?? [phase])[0])}</span><time>${options.escapeHtml(options.formatTime(occurredAt))}</time></div>`,
      )
      .join("");

    const conflictDetails: string[] = [];
    if (skills.state === "conflict") {
      conflictDetails.push(
        `<b>保留了本地同名 Skill</b><code>${options.escapeHtml(skills.conflictPaths.join("\n"))}</code>`,
      );
    }
    if (hook.state === "conflict") {
      conflictDetails.push(
        `<b>保留了本地 Codex Hook</b><code>${options.escapeHtml(hook.conflictPaths.join("\n"))}</code>`,
      );
    }
    const conflict = options.getElementById("update-conflict");
    conflict.hidden = conflictDetails.length === 0;
    conflict.innerHTML = conflictDetails.length
      ? `<p>Codrive 不会覆盖未托管文件。请先移动冲突路径，再重新同步：</p>${conflictDetails.join("")}`
      : "";

    const hookTrust = options.getElementById("update-hook-trust");
    hookTrust.hidden = !hookRuntimeNeedsAction;
    hookTrust.innerHTML = hookRuntimeNeedsAction
      ? `<b>还需在 Codex 中审核 Hook</b><p>运行 <code>/hooks</code>，审核并信任四条 Codrive activity Hook 定义，然后点击“重新检查”。Codex 会跳过尚未信任或已被禁用的 Hook。</p>`
      : "";

    const missingResources = [
      ...(skills.state === "current"
        ? []
        : [`${skills.managedSkillCount} 个托管 Skills`]),
      ...(hook.state === "current"
        ? []
        : [`${hook.managedHookCount} 个托管 Hook`]),
    ];
    const summary = upgrade?.phase === "failed"
      ? upgrade.error?.summary ?? "更新未完成，可以安全重试。"
      : active
        ? `目标版本 ${upgrade!.targetVersion} 已固定。页面断线时，独立进程仍会继续。`
        : version?.updateAvailable
          ? `Codrive ${version.latestVersion} 与该版本随附的 4 个托管 Skills、1 个托管 Hook 将在一次操作中更新。`
          : version?.checkError
            ? "无法确认 npm latest 稳定版；看板与任务调度不受影响，可以重新检查。"
            : hookRuntimeNeedsAction
              ? "托管 Hook 已安装；完成 Codex 的安全审核后，任务活动才会实时推送到看板。"
              : version?.latestVersion && resourcesInstalled
                ? "当前已是最新稳定版，Codrive 与随包托管资源保持一致。"
                : `Codrive 已安装；需要从当前包补齐 ${missingResources.join(" 和 ")}。`;
    options.getElementById("update-summary").textContent = summary;

    const primary = options.getElementById("update-primary");
    primary.disabled =
      active || resources.state === "conflict" || Boolean(version?.checking);
    primary.textContent = active
      ? "更新进行中"
      : version?.updateAvailable
        ? upgrade?.phase === "failed"
          ? "重试更新"
          : "更新 Codrive 与托管资源"
        : version?.latestVersion && resourcesInstalled
          ? "已是最新版"
          : resourcesInstalled
            ? "等待版本检查"
            : "补齐托管资源";
    if (
      upgrade?.phase === "failed" &&
      upgrade.targetVersion === version?.currentVersion &&
      !resourcesInstalled
    ) {
      primary.textContent = "补齐托管资源";
    }
    if (!version?.updateAvailable && resourcesInstalled) primary.disabled = true;
    options.getElementById("update-check").disabled =
      active || Boolean(version?.checking);
    options.getElementById("update-status").textContent =
      updateActionError ??
      upgrade?.error?.summary ??
      version?.checkError?.summary ??
      "";
    options.getElementById("update-fallback").hidden =
      upgrade?.phase !== "failed" && !version?.checkError;
    return {
      shouldPoll: active || Boolean(version?.checking) || !version?.lastCheckedAt,
      resourcesInstalled,
    };
  };
}
