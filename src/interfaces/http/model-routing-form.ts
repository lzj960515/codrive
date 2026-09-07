import type { CodexModelOption } from "../../application/codex-gateway.js";
import type { ModelRoutingSettings } from "../../domain/types.js";

// 同一表单规则嵌入全局设置与项目详情，模型能力由 App Server 的目录提供。
export function createModelRoutingForm(
  availableModels: CodexModelOption[],
  escapeHtml: (value: unknown) => string,
) {
  const routes = ["primary", "fallback"] as const;

  function modelOptions(selected: string) {
    return availableModels
      .map((model) => {
        const selection = model.id === selected ? "selected" : "";
        return `<option value="${escapeHtml(model.id)}" ${selection}>${escapeHtml(model.displayName)}</option>`;
      })
      .join("");
  }

  function reasoningOptions(modelId: string, selected = "") {
    const model = availableModels.find((option) => option.id === modelId);
    const defaultLabel = model?.defaultReasoningEffort
      ? `模型默认（${model.defaultReasoningEffort}）`
      : "模型默认";
    const options = model?.supportedReasoningEfforts ?? [];
    const supportedSelection = options.some(
      (option) => option.reasoningEffort === selected,
    );
    const defaultOption = `<option value="" ${supportedSelection ? "" : "selected"}>${escapeHtml(defaultLabel)}</option>`;
    const effortOptions = options
      .map((option) => {
        const selection = option.reasoningEffort === selected ? "selected" : "";
        return `<option value="${escapeHtml(option.reasoningEffort)}" title="${escapeHtml(option.description)}" ${selection}>${escapeHtml(option.reasoningEffort)}</option>`;
      })
      .join("");
    return defaultOption + effortOptions;
  }

  function select(form: HTMLFormElement, name: string): HTMLSelectElement {
    return form.elements.namedItem(name) as HTMLSelectElement;
  }

  function updateReasoningOptions(
    modelSelect: HTMLSelectElement,
    effortSelect: HTMLSelectElement,
  ) {
    const model = availableModels.find(
      (option) => option.id === modelSelect.value,
    );
    const selected = effortSelect.value;
    const supported = model?.supportedReasoningEfforts.some(
      (option) => option.reasoningEffort === selected,
    );
    const nextEffort = supported ? selected : "";
    effortSelect.innerHTML = reasoningOptions(modelSelect.value, nextEffort);
    effortSelect.value = nextEffort;
  }

  function bind(form: HTMLFormElement) {
    for (const route of routes) {
      const modelSelect = select(form, route);
      const effortSelect = select(form, `${route}ReasoningEffort`);
      modelSelect.onchange = () => updateReasoningOptions(modelSelect, effortSelect);
    }
    return {
      setDisabled(disabled: boolean) {
        for (const route of routes) {
          select(form, route).disabled = disabled;
          select(form, `${route}ReasoningEffort`).disabled = disabled;
        }
      },
    };
  }

  function read(form: HTMLFormElement): ModelRoutingSettings {
    const models: ModelRoutingSettings = {
      primary: select(form, "primary").value,
      fallback: select(form, "fallback").value,
    };
    for (const route of routes) {
      const effort = select(form, `${route}ReasoningEffort`).value;
      if (effort) models[`${route}ReasoningEffort`] = effort;
    }
    return models;
  }

  function describe(
    models: ModelRoutingSettings,
    route: "primary" | "fallback",
  ) {
    const effort = models[`${route}ReasoningEffort`] || "模型默认";
    return `${models[route]} · ${effort}`;
  }

  return { modelOptions, reasoningOptions, bind, read, describe };
}
