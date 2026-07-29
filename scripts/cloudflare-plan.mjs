export const R2_STANDARD_FREE_TIER = Object.freeze({
  storageGBMonth: 10,
  classAOperations: 1_000_000,
  classBOperations: 10_000_000,
  egress: "free",
});

export function classifyWorkersPlan(accountType, usageModel) {
  const normalizedAccountType = String(accountType || "").trim().toLowerCase();
  const normalizedUsageModel = String(usageModel || "").trim().toLowerCase();

  if (normalizedAccountType === "enterprise") {
    return {
      kind: "enterprise",
      label: "Workers 企业版",
      usageModel: normalizedUsageModel,
      certain: true,
    };
  }

  if (normalizedUsageModel === "standard") {
    return {
      kind: "paid",
      label: "Workers 付费版（Standard）",
      usageModel: normalizedUsageModel,
      certain: true,
    };
  }

  if (normalizedUsageModel === "unbound") {
    return {
      kind: "paid",
      label: "Workers 旧版付费（Unbound）",
      usageModel: normalizedUsageModel,
      certain: true,
    };
  }

  if (normalizedUsageModel === "bundled") {
    return {
      kind: "legacy",
      label: "Workers 旧版 Bundled",
      usageModel: normalizedUsageModel,
      certain: false,
    };
  }

  return {
    kind: "unknown",
    label: "Workers 套餐未能自动识别",
    usageModel: normalizedUsageModel,
    certain: false,
  };
}
