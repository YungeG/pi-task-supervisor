// Isolated actual-CLI model fixture. Only model responses are synthetic: tool dispatch,
// native components, TTY identity, journal sources and finite processes stay real.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

const tool = (name: string, args: unknown, id: string) =>
  fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
const advice = (action: string, evidenceRefs: string[] = []) =>
  fauxAssistantMessage(
    JSON.stringify({
      action,
      message: "Owned offline CLI mechanism only",
      taskIds: action === "hold" ? [] : ["t-1.1"],
      evidenceRefs,
    }),
  );
export function approvalNativeResponses(
  scenario: string | undefined,
  branch: () => any[],
  legacyProposal: any,
) {
  if (process.env.GOAL_NATIVE_COLD_CHECK === "1") return [fauxAssistantMessage("GOAL_NATIVE_COLD_CHECK_DONE: readonly inspection only, no new controls")];
  if (scenario === "final-guidance") return finalValidationNativeResponses();
  if (
    ![
      "approval-existing",
      "approval-preparation",
      "approval-scope",
      "approval-resource",
      "approval-guidance",
      "permissions",
    ].includes(scenario ?? "")
  )
    return;
  const root = process.env.GOAL_NATIVE_OUT;
  if (!root) throw Error("No isolated CLI output workspace");
  const preparation = scenario === "approval-preparation",
    permissionOnly = scenario === "permissions",
    resource = scenario === "approval-resource";
  const capacityFiles = resource
    ? Array.from({ length: 31 }, (_, i) => `owned_${"界".repeat(70)}_${i}.py`)
    : [];
  for (const file of capacityFiles)
    writeFileSync(join(root, file), "# Owned unreadable-capacity fixture; never executed\n");
  const checkerRoot = preparation ? join(root, "owned-checker") : root;
  mkdirSync(checkerRoot, { recursive: true });
  writeFileSync(join(root, "input.txt"), "owned input\n");
  const checker =
    "import pathlib,unittest\nclass Output(unittest.TestCase):\n def test_output(self):\n  self.assertEqual(pathlib.Path('result.txt').read_text(),'made\\n')\n";
  if (!preparation && !permissionOnly) writeFileSync(join(checkerRoot, "test_output.py"), checker);
  const contract = {
    version: 1,
    scopeId: "native-cli-output",
    inputs: ["input.txt"],
    artifacts: permissionOnly ? [] : ["result.txt"],
    environment: { profileId: "owned-empty", values: {} },
    requirements: [
      {
        requirementId: "output",
        source: "Original owned native CLI Goal",
        text: permissionOnly
          ? "Inspect original physical confirmation without performing work"
          : "Produce exactly the declared output and actually run the finite check",
        required: true,
      },
    ],
    checks: permissionOnly
      ? [
          {
            kind: "manual",
            checkId: "scope",
            requirementIds: ["output"],
            question: "Is the original owned scope intact?",
            response: { kind: "choice", options: ["intact", "changed"] },
            expectedValue: "intact",
          },
        ]
      : [
          {
            kind: "automatic",
            checkId: "output",
            requirementIds: ["output"],
            script: "test_output.py",
            checkerFiles: ["test_output.py"],
            configs: [],
            args: [],
            timeoutMs: 1000,
            expected: {
              minTests: 1,
              requiredCases: ["test_output.Output.test_output"],
              allowedSkipped: [],
            },
            runtime: "python-unittest-v1",
            checkerRoot,
            permissionId: preparation ? "N2" : "N1",
            tests: ["test_output.Output.test_output"],
          },
        ],
  };
  const permission = (id: string, target: string, action: string) => ({
    id,
    target,
    action,
    environment: "Owned offline temporary fixture",
    required: true,
    limits: resource
      ? "Synthetic business allowance120 seconds/64 MiB; fixed Python profile remains separately bounded"
      : "Only declared fixture files, fixed Python and owned private /tmp scratch",
    risks: "Synthetic keys are not real human permission or product acceptance",
    fallback: "Stop without execution",
    reconfirm: "Any changed scope, root or execution profile",
  });
  const proposal = permissionOnly
    ? legacyProposal
    : {
        summary: "Owned offline CLI consolidated workflow",
        steps: [
          ...(preparation ? ["Create the declared checker only after independent Start"] : []),
          "Confirm concrete definitions before compilation",
          "Produce result.txt and actually execute the registered finite check",
        ],
        acceptance: [
          "Exactly one business approval and one separate Start; qualified current evidence is required",
        ],
        permissions: [
          permission(
            "N1",
            root,
            "Read declared input, create result.txt and run only the offered fixed profile",
          ),
          ...(preparation
            ? [
                permission(
                  "N2",
                  checkerRoot,
                  "Create/read the declared checker and run python-unittest-v1 with private temporary scratch",
                ),
              ]
            : []),
        ],
        prohibitions: [
          "No business sessions, network, repository, settings, installation, arbitrary executables or publication",
        ],
        reconfirm: ["Any changed root, formal profile or important acceptance condition"],
        ...(preparation
          ? {
              preparation: {
                checkIds: ["output"],
                permissionIds: ["N1", "N2"],
                steps: ["Create only test_output.py in the exact offered checker root"],
              },
            }
          : {}),
      };
  const result = (id: string) => {
    const row = branch().find(
      (row) =>
        row.type === "message" &&
        row.message.role === "toolResult" &&
        row.message.toolCallId === id,
    );
    const text = row?.message.content.find((part: any) => part.type === "text")?.text;
    if (!text) throw Error(`No actual SDK result for ${id}`);
    return JSON.parse(text);
  };
  const submit = () => {
    const rows = branch(),
      stored = [...rows].reverse().find((row) => row.customType === "continuous-tasks:preflight");
    const preflight =
      stored?.data.snapshot ??
      stored?.data ??
      [...rows]
        .reverse()
        .find(
          (row) =>
            row.customType === "continuous-tasks:supervisor" &&
            row.data?.kind === "transition-committed",
        )?.data.seed.preflight;
    const contractProposalId = result("native-contract").proposalId;
    if (!preflight?.preflightId || !contractProposalId)
      throw Error("Actual native planning references are missing");
    return tool(
      "submit_preflight",
      { preflightId: preflight.preflightId, proposal: { ...proposal, contractProposalId } },
      "native-submit",
    );
  };
  const planning = [
    tool("propose_contract", { proposal: contract }, "native-contract"),
    submit,
    fauxAssistantMessage(
      "GOAL_NATIVE_APPROVED_ONLY: definition/permission confirmation is not Start",
    ),
  ];
  if (process.env.GOAL_NATIVE_CANCEL_AFTER_START === "1")
    return [...planning, fauxAssistantMessage("GOAL_NATIVE_CANCEL_NO_BUSINESS: retained original Start, no business effect")];
  if (permissionOnly)
    return [
      ...planning,
      fauxAssistantMessage("GOAL_NATIVE_BUSINESS_NO_EFFECT: no business tool was invoked"),
      advice("hold"),
    ];
  const draft = tool(
    "write_tasks",
    {
      mode: "replace",
      phases: [
        {
          title: "Owned",
          tasks: [
            {
              title: "Native output",
              prompt: "Create the declared fixture output and obtain actual finite-check evidence",
              profile: "main",
            },
          ],
        },
      ],
    },
    "native-draft",
  );
  const compile = tool("compile_tasks", { finalAcceptanceTaskId: "t-1.1" }, "native-compile");
  const guidance = scenario === "approval-guidance";
  const scope = scenario === "approval-scope" || guidance || resource;
  const scopeProposal = (id: string) =>
    tool(
      "propose_scope_revision",
      {
        plan: {
          ...proposal,
          ...(resource
            ? {
                permissions: proposal.permissions.map((p: any) => ({
                  ...p,
                  limits:
                    "Future owned segment after explicit recover until finite check closes:600 seconds/256 MiB; count actual recorded process use and stop on exceedance. Missing historical measurements remain unknown; this text is not an OS quota",
                })),
              }
            : {}),
          acceptance: [
            resource
              ? "Future owned segment only:600 seconds/256 MiB, actual finite check timeout5000ms within unchanged Python cap; retain all historical obligations and stop on exceedance"
              : "Exactly declared output; precise synthetic timestamp exception A=1793178673175340907, B=1793178673175340907; every other original condition remains",
          ],
        },
        contract: {
          ...contract,
          requirements: contract.requirements.map((requirement) => ({
            ...requirement,
            text:
              requirement.text +
              (resource
                ? "; future owned segment allowance600 seconds/256 MiB after explicit recover; preserve unknown old measurements; finite check timeout5000ms"
                : "; exact synthetic exception A=1793178673175340907, B=1793178673175340907 only, never latest values"),
          })),
          ...(resource
            ? {
                checks: contract.checks.map((check) =>
                  check.kind === "automatic"
                    ? {
                        ...check,
                        timeoutMs: 5000,
                        ...(id === "native-scope-capacity-denied"
                          ? { checkerFiles: [check.script, ...capacityFiles] }
                          : {}),
                      }
                    : check,
                ),
              }
            : {}),
        },
        reason: resource
          ? "Amend prospective fixture business conditions only; retain original permission identity, Start, hard counters, profile caps and historical unknowns"
          : "Precisely amend existing synthetic conditions; preserve original Goal/permissions/Start/budgets and all other guards",
      },
      id,
    );
  return [
    ...planning,
    ...(preparation
      ? [
          draft,
          tool(
            "write",
            { path: join(checkerRoot, "test_output.py"), content: checker },
            "native-prepare",
          ),
          fauxAssistantMessage(
            "GOAL_NATIVE_CHECKER_PREPARED: request only concrete native definition review",
          ),
          advice("hold"),
          compile,
        ]
      : [draft, compile]),
    ...(resource
      ? [
          tool(
            "propose_contract",
            {
              proposal: {
                ...contract,
                requirements: contract.requirements.map((r) => ({
                  ...r,
                  text: r.text + " revised definition",
                })),
              },
            },
            "native-postcompile-contract-denied",
          ),
        ]
      : []),
    fauxAssistantMessage("GOAL_NATIVE_PLAN_CHECKPOINT"),
    ...(scope
      ? [
          ...(guidance
            ? [
                advice("next_batch"),
                scopeProposal("native-active-scope-denied"),
                fauxAssistantMessage(
                  "GOAL_NATIVE_ACTIVE_SCOPE_DENIED: user must pause, no automatic metadata turn",
                ),
                fauxAssistantMessage("GOAL_NATIVE_SCOPE_WAIT_ONE: no progress or scope authority"),
                fauxAssistantMessage(
                  "GOAL_NATIVE_SCOPE_WAIT_TWO: bounded stagnant hold, not permission",
                ),
              ]
            : [advice("hold")]),
          scopeProposal("native-scope-proposal"),
          ...(resource
            ? [scopeProposal("native-scope-repeat"), scopeProposal("native-scope-capacity-denied")]
            : []),
          fauxAssistantMessage(
            "GOAL_NATIVE_SCOPE_PROPOSED: native review and separate recovery are still required",
          ),
        ]
      : [advice("next_batch")]),
    tool("get_ready_tasks", { count: 1 }, "native-ready"),
    tool("advance_tasks", { transitions: [{ id: "t-1.1" }] }, "native-claim"),
    tool("write", { path: join(root, "result.txt"), content: "made\n" }, "native-produce"),
    tool("run_check", { checkId: "output" }, "native-check"),
    tool(
      "advance_tasks",
      {
        transitions: [
          {
            id: "t-1.1",
            evidence: {
              summary: "Actual registered finite CLI check",
              refs: [
                {
                  kind: "command",
                  label: "Original registered native check",
                  status: "passed",
                  ref: "tool:native-check",
                  exitCode: 0,
                },
              ],
            },
          },
        ],
      },
      "native-done",
    ),
    fauxAssistantMessage("GOAL_NATIVE_WORK_CHECKPOINT"),
    () => {
      const row = [...branch()]
        .reverse()
        .find(
          (row) =>
            row.customType === "continuous-tasks:receipt-ledger" &&
            row.data?.kind === "receipt" &&
            row.data.receipt.tool === "run_check",
        );
      if (!row?.data.receipt.id) throw Error("No original actual native-check receipt");
      return advice("accept", [row.data.receipt.id]);
    },
  ];
}
function finalValidationNativeResponses() {
  const root = process.env.GOAL_NATIVE_OUT!;
  writeFileSync(join(root, "input.txt"), "first owned nonempty input\n");
  const program = `const fs=require('node:fs'),a=require('node:assert/strict');const x=fs.readFileSync('input.txt','utf8');a.ok(x.trim().length>0);console.log('OWNED_NONEMPTY_VALIDATION_PASSED')`;
  const input = { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(program)}` };
  const complete = (id: string) =>
    tool(
      "advance_tasks",
      {
        transitions: [
          {
            id: "t-1.1",
            evidence: {
              summary: "Actual fixed nonempty input validation",
              refs: [
                {
                  kind: "command",
                  label: "Exact native Bash validation",
                  status: "passed",
                  ref: `tool:${id}`,
                  exitCode: 0,
                },
              ],
            },
          },
        ],
      },
      "final-native-done",
    );
  return [
    tool(
      "write_tasks",
      {
        mode: "replace",
        phases: [
          {
            title: "Owned final check",
            tasks: [
              {
                title: "Validate input",
                prompt: "Validate the nonempty input only",
                profile: "main",
              },
            ],
          },
        ],
      },
      "final-native-plan",
    ),
    tool("compile_tasks", { finalAcceptanceTaskId: "t-1.1" }, "final-native-compile"),
    fauxAssistantMessage("GOAL_FINAL_PLAN_CHECKPOINT"),
    advice("next_batch"),
    tool("get_ready_tasks", { count: 1 }, "final-native-ready"),
    tool("advance_tasks", { transitions: [{ id: "t-1.1" }] }, "final-native-reviewing"),
    tool("bash", input, "final-native-proof"),
    complete("final-native-proof"),
    fauxAssistantMessage("GOAL_FINAL_WORK_CHECKPOINT"),
    () => {
      throw Error("Owned final review unavailable; task completion must remain closed");
    },
    tool("bash", input, "new-final-native-proof"),
    fauxAssistantMessage("GOAL_FINAL_NEW_VALIDATION_RECORDED"),
    advice("accept", ["tool:new-final-native-proof"]),
  ];
}
