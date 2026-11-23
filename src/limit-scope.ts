/**
 * What a usage-limit refusal covers. A Claude plan has, beside the account's own 5-hour and weekly windows, a weekly
 * allowance for one model at a time; a refusal on that one leaves the others working, and Claude Code answers it with
 * "switch models". Every other limit refuses the whole account, whichever model the run was using.
 */
export type LimitScope = {
  /** `account` refuses every model; `model` only the one its label names. */
  kind: "account" | "model";
  /** The limit in the provider's own words: `weekly limit`, `Fable limit`, `5-hour limit`. */
  label: string;
};

/** Whether a refusal of this limit says the account has no allowance at all, rather than one model's share of it. */
export function spendsAccount(limit: LimitScope | undefined): boolean {
  return limit?.kind !== "model";
}

/** The `rateLimitType` values Claude Code's refusal record carries, as its own schema lists them. */
export const claudeRateLimits = [
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_overage_included",
  "overage",
] as const;
export type ClaudeRateLimit = (typeof claudeRateLimits)[number];

/**
 * What each of those refuses, named as Claude Code's own limit labels name them: `seven_day_overage_included` is the
 * model-scoped weekly allowance it shows as the Fable limit, not the all-models week `seven_day` is.
 */
export function claudeLimitScope(type: ClaudeRateLimit): LimitScope {
  switch (type) {
    case "five_hour":
      return { kind: "account", label: "5-hour limit" };
    case "seven_day":
      return { kind: "account", label: "weekly limit" };
    case "overage":
      return { kind: "account", label: "usage credit limit" };
    case "seven_day_opus":
      return { kind: "model", label: "Opus limit" };
    case "seven_day_sonnet":
      return { kind: "model", label: "Sonnet limit" };
    case "seven_day_overage_included":
      return { kind: "model", label: "Fable limit" };
  }
}

/**
 * The rate limit `value` names, if it is one. A record naming none, or naming one this version does not know, refuses
 * the account as it always has: an unknown limit is not evidence that the account still has allowance.
 */
export function claudeRateLimit(value: unknown): ClaudeRateLimit | undefined {
  return claudeRateLimits.find((type) => type === value);
}
