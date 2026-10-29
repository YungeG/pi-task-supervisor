import { expect, it } from "vitest";
import { assessSupervisorBudget } from "../supervisor-budget";
it.each([
  [39, 0, 0, "available"],
  [39, 0, 1, "exhausted"],
  [0, 20, 0, "exhausted"],
  [40, 0, 0, "exhausted"],
] as const)(
  "accounts reviews=%s continuations=%s extra=%s without resetting spent limits",
  (reviews, continuations, extra, status) => {
    const state = Object.freeze({ reviews, continuations });
    expect(assessSupervisorBudget(state, extra)).toMatchObject({
      status,
      spentReviews: reviews + extra,
      continuations,
    });
  },
);
it.each([undefined, NaN, -1, Infinity, 0.5])(
  "keeps unknown/invalid extra call usage %s unknown",
  (extra) => {
    expect(assessSupervisorBudget({ reviews: 0, continuations: 0 }, extra)).toMatchObject({
      status: "unknown",
      spentReviews: null,
      continuations: null,
    });
  },
);
it.each([
  { reviews: NaN, continuations: 0 },
  { reviews: 0, continuations: -1 },
  { reviews: Number.MAX_SAFE_INTEGER, continuations: 0 },
])("rejects inconsistent counters without inferring zero", (state) => {
  expect(assessSupervisorBudget(state, 1).status).toBe("unknown");
});
