// Controller-independent registered-check wire identity.
import { Type } from "typebox";
export const RunCheckParams = Type.Object(
  { checkId: Type.String({ minLength: 1, maxLength: 100 }) },
  { additionalProperties: false },
);
