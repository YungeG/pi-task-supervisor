/** Pure budget policy. Unknown/invalid counters never become a zero allowance. */
export const SUPERVISOR_LIMITS = {
  tasks: 100,
  reviews: 40,
  continuations: 20,
  stagnant: 3,
} as const;
export interface SupervisorBudgetAssessment {
  status: "available" | "exhausted" | "unknown";
  spentReviews: number | null;
  continuations: number | null;
  reason?: string;
}
export function assessSupervisorBudget(
  state: Readonly<{ reviews: number; continuations: number }>,
  extraCalls: number | undefined,
): SupervisorBudgetAssessment {
  const valid = (value: number | undefined): value is number =>
    value !== undefined && Number.isSafeInteger(value) && value >= 0;
  if (
    !valid(state.reviews) ||
    !valid(state.continuations) ||
    !valid(extraCalls) ||
    !Number.isSafeInteger(state.reviews + extraCalls)
  )
    return {
      status: "unknown",
      spentReviews: null,
      continuations: null,
      reason:
        "Supervisor call budget is unknown/inconsistent; inspect original accounting before control; no budget is inferred",
    };
  const spentReviews = state.reviews + extraCalls;
  if (
    spentReviews >= SUPERVISOR_LIMITS.reviews ||
    state.continuations >= SUPERVISOR_LIMITS.continuations
  )
    return {
      status: "exhausted",
      spentReviews,
      continuations: state.continuations,
      reason:
        "Same-Goal review/continuation budget exhausted; recover cannot refill it. Inspect spent usage and explicitly decide whether to end this Goal and plan an independent successor; old accounting stays unchanged",
    };
  return { status: "available", spentReviews, continuations: state.continuations };
}
