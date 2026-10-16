import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { isSafeBoundedText } from "./validation";

const strict = { additionalProperties: false };
export const DecisionSpecSchema = Type.Union([
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal("authorization"),
      scope: Type.String({ minLength: 1, maxLength: 4000 }),
      prohibitions: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 20 }),
    },
    strict,
  ),
  Type.Object({ version: Type.Literal(1), kind: Type.Literal("choice") }, strict),
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal("information"),
      format: Type.Union([Type.Literal("text"), Type.Literal("integer"), Type.Literal("date")]),
    },
    strict,
  ),
]);
export type DecisionSpec = Static<typeof DecisionSpecSchema>;
export function validDecisionSpec(value: unknown): value is DecisionSpec {
  if (!Check(DecisionSpecSchema, value)) return false;
  return (
    value.kind !== "authorization" ||
    (isSafeBoundedText(value.scope, 4000) &&
      value.prohibitions.every((item) => isSafeBoundedText(item, 1000)))
  );
}
export function validDecisionInformation(spec: DecisionSpec, value: string): boolean {
  if (!isSafeBoundedText(value, 1000) || spec.kind !== "information") return false;
  if (spec.format === "text") return true;
  if (spec.format === "integer")
    return /^-?(?:0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value));
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
  );
}
