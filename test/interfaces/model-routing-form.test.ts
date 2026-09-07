import { describe, expect, it } from "vitest";
import { createModelRoutingForm } from "../../src/interfaces/http/model-routing-form.js";

const models = [
  {
    id: "gpt-6-astra", displayName: "GPT-6 Astra", description: "", isDefault: true,
    defaultReasoningEffort: "low" as const,
    supportedReasoningEfforts: [
      { reasoningEffort: "low" as const, description: "Fast" },
      { reasoningEffort: "high" as const, description: "Thorough" },
      { reasoningEffort: "ultra" as const, description: "Deepest" },
    ],
  },
  {
    id: "other", displayName: "Other", description: "", isDefault: false,
    defaultReasoningEffort: "low" as const,
    supportedReasoningEfforts: [
      { reasoningEffort: "low" as const, description: "Fast" },
      { reasoningEffort: "high" as const, description: "Thorough" },
    ],
  },
];

function setup() {
  const fields = {
    primary: { value: "gpt-6-astra", innerHTML: "", disabled: false, onchange: () => {} },
    fallback: { value: "other", innerHTML: "", disabled: false, onchange: () => {} },
    primaryReasoningEffort: { value: "ultra", innerHTML: "", disabled: false },
    fallbackReasoningEffort: { value: "high", innerHTML: "", disabled: false },
  };
  const form = {
    elements: { namedItem: (name: keyof typeof fields) => fields[name] },
  } as unknown as HTMLFormElement;
  const modelForm = createModelRoutingForm(models, (value) => String(value));
  const binding = modelForm.bind(form);
  return { fields, form, modelForm, binding };
}

describe("model routing form", () => {
  it("uses the selected model's supported efforts and leaves the default unspecified", () => {
    const { modelForm, fields, form } = setup();
    const options = modelForm.reasoningOptions("gpt-6-astra");
    expect(options).toContain('value="ultra"');
    expect(options).toContain('value="" selected');
    expect(options).toContain("模型默认（low）");
    expect(modelForm.reasoningOptions("other")).not.toContain('value="ultra"');
    fields.primaryReasoningEffort.value = "";
    expect(modelForm.read(form)).toEqual({
      primary: "gpt-6-astra", fallback: "other", fallbackReasoningEffort: "high",
    });
  });

  it("clears an unsupported effort on model changes and keeps each route independent", () => {
    const { fields, modelForm, form } = setup();
    fields.primary.value = "other";
    fields.primary.onchange();
    expect(fields.primaryReasoningEffort.value).toBe("");
    expect(fields.fallbackReasoningEffort.value).toBe("high");
    fields.primaryReasoningEffort.value = "high";
    fields.primary.value = "gpt-6-astra";
    fields.primary.onchange();
    expect(modelForm.read(form)).toEqual({
      primary: "gpt-6-astra", fallback: "other",
      primaryReasoningEffort: "high", fallbackReasoningEffort: "high",
    });
  });

  it("disables both model and effort controls when a project inherits global settings", () => {
    const { fields, binding } = setup();
    binding.setDisabled(true);
    expect(Object.values(fields).every((field) => field.disabled)).toBe(true);
    binding.setDisabled(false);
    expect(Object.values(fields).every((field) => !field.disabled)).toBe(true);
    expect(fields.primaryReasoningEffort.value).toBe("ultra");
  });
});
