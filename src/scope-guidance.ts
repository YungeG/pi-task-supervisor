/** Display and error guidance only. Nothing here admits tools or grants authority. */
export const SCOPE_METADATA_REQUEST =
  "保持当前Goal暂停，只读取当前批准与契约原件，保留权限id/action/target/environment/required、prohibitions和preparation，提交完整plan、contract和reason到propose_scope_revision。业务limits及相应验收条件可提出精确修订，仍须review-scope；Supervisor硬限制、已用计数与历史未知不清零，不存在另一个预算命令。不要recover、重跑业务、重新Start或重建看板；来源或静止条件不满足时只报告阻塞。";
export const SCOPE_METADATA_HANDOFF = `Main未排队；pause不会自动提交修订。若要修订范围，请发送给Main：${SCOPE_METADATA_REQUEST}`;

export class ScopeProposalError extends Error {
  constructor(
    readonly code:
      | "SCOPE_SOURCE_UNKNOWN"
      | "SCOPE_NOT_HELD"
      | "SCOPE_PENDING"
      | "SCOPE_UNSETTLED"
      | "SCOPE_NOT_COMPILED"
      | "SCOPE_PLAN_OBJECTS"
      | "SCOPE_PROPOSAL_INVALID"
      | "SCOPE_UNREVIEWABLE",
    message: string,
    readonly next: string,
  ) {
    super(message);
  }
  get guidance() {
    return {
      code: this.code,
      actor: this.code === "SCOPE_NOT_HELD" ? ("user" as const) : ("Main" as const),
      next: this.next,
      remaining:
        "Metadata only; original permission/Start/holds/budgets stay intact. No business execution or approval from this result.",
    };
  }
}

export const SCOPE_CORRECT_MATERIAL =
  "Main: correct the complete proposal/definition material to fit native capacity; preserve every required condition. Do not repeat the same failing review ID, omit fields, raise limits or replay business";
export class ScopeReviewabilityError extends ScopeProposalError {
  constructor(message: string, next = SCOPE_CORRECT_MATERIAL) {
    super("SCOPE_UNREVIEWABLE", message, next);
  }
}
