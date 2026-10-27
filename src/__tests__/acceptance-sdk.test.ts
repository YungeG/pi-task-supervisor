// C1/C3 approved public acceptance seam: actual SDK/QuickJS/faux producer,
// original host receipts and native source binding. Not human/product proof.
import { writeFileSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { expect, it } from "vitest";
import { recognizeAcceptanceSuite } from "../acceptance-contract";
import { registerHostAcceptanceContract } from "../acceptance-runtime";
import { ownedCodemode } from "./helpers/owned-codemode";
import { ownedRecovery } from "./helpers/owned-codemode-recovery";
function ownedContract(extra = false) {
  return recognizeAcceptanceSuite("Owned covered SDK mechanism", {
    version: 1,
    scopeId: "owned-semantic",
    inputs: ["input.txt", "required-check.mjs"],
    artifacts: [],
    environment: { profileId: "owned-empty", values: {} },
    requirements: [
      {
        requirementId: "declared-check",
        source: "Host-recognized owned SDK sentinel specification",
        text: "The registered finite Node checker actually executes its required input test",
        required: true,
      },
      ...(extra
        ? [
            {
              requirementId: "second-condition",
              source: "Owned required multi-check specification",
              text: "A second fixed invocation must also execute",
              required: true,
            },
          ]
        : []),
    ],
    checks: [
      {
        checkId: "required-node",
        kind: "automatic",
        requirementIds: ["declared-check"],
        script: "required-check.mjs",
        checkerFiles: ["required-check.mjs"],
        configs: [],
        args: [],
        timeoutMs: 1000,
        expected: { minTests: 1, requiredCases: ["input"], allowedSkipped: [] },
      },
      ...(extra
        ? [
            {
              checkId: "second-node",
              kind: "automatic" as const,
              requirementIds: ["second-condition"],
              script: "required-check.mjs",
              checkerFiles: ["required-check.mjs"],
              configs: [],
              args: ["second-invocation"],
              timeoutMs: 1000,
              expected: { minTests: 1, requiredCases: ["input"], allowedSkipped: [] },
            },
          ]
        : []),
    ],
  });
}
async function fixture(
  workCode?: string,
  checkerBody?: string,
  directCheck = false,
  replaceAfterBind = false,
  extra = false,
) {
  const token = ownedContract(extra);
  const result = await ownedCodemode("normal", {
    workCode,
    directCheck,
    checkTool: workCode || directCheck ? "run_check" : undefined,
    prepare: (dir) => {
      writeFileSync(
        join(dir, "required-check.mjs"),
        checkerBody ??
          `import assert from 'node:assert/strict';import{readFileSync}from'node:fs';assert.equal(readFileSync(new URL('./input.txt',import.meta.url),'utf8'),'owned\\n');console.log(JSON.stringify({protocol:'check-result-v1',tests:1,passed:1,failed:0,skipped:0,requiredCases:{input:'passed'},skippedIds:[]}));`,
      );
    },
    goalStart: (pi, ctx) => {
      registerHostAcceptanceContract(pi, ctx, token);
      if (replaceAfterBind)
        writeFileSync(
          join(ctx.cwd, "required-check.mjs"),
          "// substituted no-op: process.exitCode=0\n",
        );
    },
  });
  const output = process.env.P7_SDK_FIXTURE;
  if (output && workCode === declaredWork && checkerBody === undefined) {
    if (
      dirname(resolve(output)) !== resolve(process.cwd(), "../control-remediation-artifacts") ||
      !/^p7-[a-z0-9-]+-fixture\.jsonl$/.test(basename(output))
    )
      throw Error("Owned P7 fixture output must use a fresh approved artifact path");
    writeFileSync(output, result.source, { flag: "wx" });
  }
  return result;
}
it("does not accept allDone and a successful different host check instead of the trusted declared checker", async () => {
  const result = await fixture();
  expect(result.errors).toEqual([]);
  expect(result.checks).toBe(1);
  expect(
    result.branch.some(
      (row) =>
        row.type === "custom" &&
        row.customType === "continuous-tasks:acceptance-facts" &&
        (row.data as { kind?: string }).kind === "acceptance-contract-bound",
    ),
  ).toBe(true);
  const snapshot = [...result.branch]
    .reverse()
    .find((row) => row.type === "custom" && row.customType === "continuous-tasks:snapshot");
  expect(
    snapshot?.type === "custom" &&
      (snapshot.data as { tasks: { status: string }[] }).tasks.every(
        (task) => task.status === "done",
      ),
  ).toBe(true);
  expect(result.state?.status).not.toBe("completed");
  expect(result.state?.reason).toMatch(/Acceptance contract.*declared-check/);
}, 20000);
const declaredWork =
  'await tools.get_ready_tasks({count:1}); await tools.advance_tasks({transitions:[{id:"t-1.1"}]}); const proof=await tools.run_check({checkId:"required-node"}); text(await tools.advance_tasks({transitions:[{id:"t-1.1",evidence:{summary:"Actual declared native checker",refs:[{kind:"command",label:"Registered Node check",status:"passed",ref:"tool:"+proof.id,exitCode:0}]}}]}));';
it("accepts only after the declared actual finite checker, original host receipt and quiet only-mode completion", async () => {
  const result = await fixture(declaredWork);
  expect(result.errors).toEqual([]);
  expect(result.state?.status, result.state?.reason).toBe("completed");
  expect(result.modelCalls).toBe(6);
  expect(
    result.branch.some(
      (row) =>
        row.type === "custom" &&
        row.customType === "continuous-tasks:acceptance-facts" &&
        (row.data as { kind?: string; closed?: boolean; exitCode?: number }).kind ===
          "acceptance-check-observed" &&
        (row.data as { closed?: boolean }).closed === true &&
        (row.data as { exitCode?: number }).exitCode === 0,
    ),
  ).toBe(true);
}, 20000);
it("uses actual top-level native tool calls in normal mode without requiring a fabricated container parent", async () => {
  const result = await fixture(undefined, undefined, true);
  expect(result.errors).toEqual([]);
  expect(result.state?.status, result.state?.reason).toBe("completed");
  expect(result.modelCalls).toBe(8);
  expect(
    result.branch.some(
      (row) =>
        row.type === "custom" &&
        row.customType === "continuous-tasks:control-facts" &&
        (row.data as { kind?: string; toolCallId?: string; parentId?: string | null }).kind ===
          "invocation-started" &&
        (row.data as { toolCallId?: string }).toolCallId === "owned-direct-check" &&
        (row.data as { parentId?: string | null }).parentId === null,
    ),
  ).toBe(true);
}, 20000);
it("rejects an actual no-op checker substitution after the immutable native definition was bound", async () => {
  const result = await fixture(declaredWork, undefined, false, true);
  expect(result.errors).toEqual([]);
  expect(result.state?.status).not.toBe("completed");
  expect(
    result.branch.some(
      (row) =>
        row.type === "custom" &&
        row.customType === "continuous-tasks:acceptance-facts" &&
        (row.data as { kind?: string }).kind === "acceptance-check-started",
    ),
  ).toBe(false);
}, 20000);
it.each([false, true])(
  "requires all distinct declared actual invocations (second executed=%s)",
  async (complete) => {
    const code = complete
      ? declaredWork.replace(
          'const proof=await tools.run_check({checkId:"required-node"});',
          'await tools.run_check({checkId:"required-node"}); const proof=await tools.run_check({checkId:"second-node"});',
        )
      : declaredWork;
    const result = await fixture(code, undefined, false, false, true);
    expect(result.errors).toEqual([]);
    if (complete) {
      expect(result.state?.status, result.state?.reason).toBe("completed");
      expect(result.modelCalls).toBe(6);
    } else {
      expect(result.state?.status).not.toBe("completed");
      expect(result.state?.reason).toContain("second-condition");
    }
  },
  20000,
);
it("restores sealed accepted contract history without inventing current checks, provider calls or replay", async () => {
  const source = await fixture(declaredWork);
  expect(source.state?.status).toBe("completed");
  const restored = await ownedRecovery(source.source, "accepted");
  expect(restored.errors).toEqual([]);
  expect(restored.modelCalls).toBe(0);
  expect(restored.initial).toBe(restored.before);
  expect(restored.before).toBe(restored.after);
  expect(restored.after).toBe(restored.repeated);
  const state = [...restored.branch]
    .reverse()
    .find(
      (row) =>
        row.type === "custom" &&
        row.customType === "continuous-tasks:supervisor" &&
        (row.data as { version?: number }).version === 3,
    );
  expect(state?.type === "custom" && (state.data as { status?: string }).status).toBe("completed");
}, 20000);
it.each(["empty", "invalid-json", "scalar", "wrong-protocol"])(
  "does not convert actual %s checker output into structured success",
  async (kind) => {
    const body =
      kind === "empty"
        ? "0;"
        : kind === "invalid-json"
          ? 'console.log("not-json");'
          : kind === "scalar"
            ? 'console.log("7");'
            : 'console.log(JSON.stringify({protocol:"not-check-result-v1"}));';
    const result = await fixture(declaredWork, body);
    expect(result.errors).toEqual([]);
    expect(result.state?.status).not.toBe("completed");
    expect(
      result.branch.find(
        (row) =>
          row.type === "custom" &&
          row.customType === "continuous-tasks:acceptance-facts" &&
          (row.data as { kind?: string }).kind === "acceptance-check-observed",
      ),
    ).toMatchObject({ data: { closed: true, exitCode: 0, result: null } });
  },
  20000,
);
it.each(["zero", "required-skip", "malformed", "nonzero"])(
  "retains a real %s result without accepting its exit-zero/label substitute",
  async (kind) => {
    const report =
      kind === "zero"
        ? {
            protocol: "check-result-v1",
            tests: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            requiredCases: {},
            skippedIds: [],
          }
        : kind === "required-skip"
          ? {
              protocol: "check-result-v1",
              tests: 1,
              passed: 0,
              failed: 0,
              skipped: 1,
              requiredCases: { input: "skipped" },
              skippedIds: ["input"],
            }
          : { protocol: "check-result-v1", passed: true };
    const body =
      kind === "nonzero"
        ? "process.exitCode=7;"
        : `console.log(${JSON.stringify(JSON.stringify(report))});`;
    const result = await fixture(declaredWork, body);
    expect(result.errors).toEqual([]);
    expect(result.state?.status).not.toBe("completed");
    const observed = result.branch.find(
      (row) =>
        row.type === "custom" &&
        row.customType === "continuous-tasks:acceptance-facts" &&
        (row.data as { kind?: string }).kind === "acceptance-check-observed",
    );
    expect(observed?.type === "custom" && observed.data).toMatchObject({
      closed: true,
      exitCode: kind === "nonzero" ? 7 : 0,
      termination: "exited",
      result:
        kind === "malformed" || kind === "nonzero"
          ? null
          : expect.objectContaining({ tests: kind === "zero" ? 0 : 1, passed: 0 }),
    });
  },
  20000,
);
it.each(["store", "root-error", "parallel-writer"])(
  "does not qualify a declared check across actual %s container effects",
  async (kind) => {
    const code =
      kind === "parallel-writer"
        ? declaredWork.replace(
            'const proof=await tools.run_check({checkId:"required-node"});',
            'const pending=tools.owned_wait_write({}); const proof=await tools.run_check({checkId:"required-node"}); await pending;',
          )
        : declaredWork +
          (kind === "store"
            ? 'store("owned-p7",{value:1});'
            : 'throw new Error("Owned P7 root failure");');
    const result = await fixture(code);
    expect(result.errors).toEqual([]);
    expect(result.state?.status).not.toBe("completed");
  },
  20000,
);
it("does not wash an actual tracked same-byte late writer with an equal byte fingerprint", async () => {
  const result = await fixture(
    declaredWork.replace(
      "text(await tools.advance_tasks",
      "await tools.owned_write({}); text(await tools.advance_tasks",
    ),
  );
  expect(result.errors).toEqual([]);
  expect(result.state?.status).not.toBe("completed");
  expect(
    result.branch.some(
      (row) =>
        row.type === "custom" &&
        row.customType === "continuous-tasks:control-facts" &&
        (row.data as { kind?: string; toolName?: string }).kind === "invocation-started" &&
        (row.data as { toolName?: string }).toolName === "owned_write",
    ),
  ).toBe(true);
}, 20000);
