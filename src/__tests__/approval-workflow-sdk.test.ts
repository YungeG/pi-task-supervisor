// Actual offline SDK/native-check producer with native component simulation.
// Not real-person identity, CLI/PTY, or installed-product acceptance.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ownedCodemode } from "./helpers/owned-codemode";
import { localProposal } from "./helpers/preflight";
import type { AcceptanceFact } from "../acceptance-journal";

const checker = `import pathlib,unittest
class Output(unittest.TestCase):
 def test_output(self):
  self.assertEqual(pathlib.Path('input.txt').read_text(),'owned\\n')
  self.assertEqual(pathlib.Path('result.txt').read_text(),'made')
`;
const work =
  'await tools.get_ready_tasks({count:1}); await tools.advance_tasks({transitions:[{id:"t-1.1"}]}); await tools.owned_write({}); const proof=await tools.run_check({checkId:"output"}); text(await tools.advance_tasks({transitions:[{id:"t-1.1",evidence:{summary:"Actual required Python output check",refs:[{kind:"command",label:"Declared Python",status:"passed",ref:"tool:"+proof.id,exitCode:0}]}}]}));';

it.each([
  { preparing: false, fixtureError: false },
  { preparing: true, fixtureError: false },
  { preparing: false, fixtureError: true },
])(
  "consumes consolidated Python output according to actual SDK execution (preparing=$preparing, fixtureError=$fixtureError)",
  async ({ preparing, fixtureError }) => {
    let checkerRoot: string | undefined,
      verified = false;
    try {
      const source =
        checker +
        (fixtureError
          ? "\n @classmethod\n def tearDownClass(cls): raise AssertionError('sdk-fixture-failure')\n"
          : "");
      const result = await ownedCodemode(fixtureError ? "nonzero-check" : "normal", {
        prepare: (dir) => {
          checkerRoot = preparing ? dir + "-checker" : dir;
          if (preparing) mkdirSync(checkerRoot, { mode: 0o700 });
          else writeFileSync(join(checkerRoot, "test_output.py"), source);
        },
        checkTool: "run_check",
        workCode: work,
        approvalWorkflow: {
          contract: () => ({
            version: 1,
            scopeId: "owned-output",
            inputs: ["input.txt"],
            artifacts: ["result.txt"],
            environment: { profileId: "owned", values: {} },
            requirements: [
              {
                requirementId: "output",
                source: "Owned original SDK specification",
                text: "Create output and run its declared actual Python method",
                required: true,
              },
            ],
            checks: [
              {
                kind: "automatic",
                checkId: "output",
                requirementIds: ["output"],
                script: "test_output.py",
                checkerFiles: ["test_output.py"],
                configs: [],
                args: [],
                timeoutMs: 1000,
                runtime: "python-unittest-v1",
                checkerRoot: checkerRoot!,
                permissionId: "A3",
                tests: ["test_output.Output.test_output"],
                expected: {
                  minTests: 1,
                  requiredCases: ["test_output.Output.test_output"],
                  allowedSkipped: [],
                },
              },
            ],
          }),
          proposal: () => ({
            ...localProposal,
            permissions: [
              ...localProposal.permissions,
              {
                ...localProposal.permissions[0]!,
                id: "A3",
                target: checkerRoot!,
                action: "Create exact declared checker and execute fixed Python unittest profile",
                environment: "Owned test roots only",
                limits:
                  "Only the declared checker files; read declared product data; write scratch only in a new private /tmp directory; no network or subprocess",
              },
            ],
            ...(preparing
              ? {
                  preparation: {
                    checkIds: ["output"],
                    steps: [
                      "Create the exact missing owned checker before native definition review",
                    ],
                    permissionIds: ["A1", "A3"],
                  },
                }
              : {}),
          }),
          produce: (dir) => {
            writeFileSync(join(dir, "result.txt"), "made");
          },
          ...(preparing
            ? {
                prepareChecker: () => {
                  writeFileSync(join(checkerRoot!, "test_output.py"), source);
                },
              }
            : {}),
        },
      });
      expect(result.errors).toEqual([]);
      expect(
        result.state?.status,
        JSON.stringify({ state: result.state, notices: result.notices }),
      ).toBe(fixtureError ? "paused" : "completed");
      const facts = result.branch.flatMap((row) =>
        row.type === "custom" && row.customType === "continuous-tasks:acceptance-facts"
          ? [row.data as AcceptanceFact]
          : [],
      );
      expect(facts.find((row) => row.kind === "acceptance-contract-bound")?.authority.kind).toBe(
        preparing ? "native-reviewed" : "preflight-reviewed",
      );
      const observation = facts.find((row) => row.kind === "acceptance-check-observed");
      expect(observation).toMatchObject({
        closed: true,
        exitCode: fixtureError ? 1 : 0,
        invocation: { profile: { id: "python-unittest-v1" } },
        result: { passed: 1 },
        temporary: { cleanup: "removed" },
      });
      expect(observation?.pid).toBeGreaterThan(0);
      if (fixtureError) {
        const final = [...result.branch]
          .reverse()
          .find((row) => row.type === "custom" && row.customType === "continuous-tasks:snapshot");
        expect(
          final?.type === "custom" &&
            (final.data as { tasks: { status: string }[] }).tasks[0]?.status,
        ).not.toBe("done");
        expect(result.state?.status).not.toBe("completed");
      }
      expect(facts.filter((row) => row.kind === "acceptance-contract-control")).toHaveLength(
        preparing ? 1 : 0,
      );
      const controls = result.branch.flatMap((row) =>
        row.type === "custom" && row.customType === "continuous-tasks:preflight-control"
          ? [row.data as { kind?: string }]
          : [],
      );
      expect(controls.filter((row) => row.kind === "approve")).toHaveLength(1);
      expect(controls.filter((row) => row.kind === "start")).toHaveLength(1);
      verified = true;
    } finally {
      if (preparing && checkerRoot && verified) rmSync(checkerRoot, { recursive: true });
      else if (preparing && checkerRoot)
        console.error("Owned external checker failure retained:", checkerRoot);
    }
  },
  20000,
);
