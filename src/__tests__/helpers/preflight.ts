import { vi } from "vitest";
import { lifecycle } from "./lifecycle";

/** SDK persistence boundary: appends have actual unique branch identities, not a fixed fake leaf. */
export function preflightLifecycle() {
  const h = lifecycle();
  const entries: Array<{
    type: "custom";
    id: string;
    parentId: string | null;
    timestamp: string;
    customType: string;
    data: unknown;
  }> = [];
  let leaf: string | null = null;
  vi.mocked(h.ctx.sessionManager.getBranch).mockImplementation(() => entries);
  vi.mocked(h.ctx.sessionManager.getLeafId).mockImplementation(() => leaf);
  h.mock.appendEntry.mockImplementation((customType: string, data: unknown) => {
    const id = `entry-${entries.length + 1}`;
    entries.push({
      type: "custom",
      id,
      parentId: leaf,
      timestamp: new Date().toISOString(),
      customType,
      data: structuredClone(data),
    });
    leaf = id;
  });
  return { ...h, entries };
}

export const localProposal = {
  summary: "Implement the local fixture with a bounded dependency option",
  steps: ["Inspect current code", "Implement approved changes", "Run local validation"],
  acceptance: ["Local validation passes"],
  permissions: [
    {
      id: "A1",
      action: "Modify the approved source and tests",
      target: "Current repository source and tests",
      environment: "Local checkout only",
      required: true,
      limits: "No external changes or new dependencies",
      risks: "Reversible local file changes",
      fallback: "Keep the current implementation if approval is refused",
      reconfirm: "New paths, goals or external effects",
    },
    {
      id: "A2",
      action: "Install a specific optional dependency",
      target: "Approved fixture dependency only",
      environment: "Local checkout only",
      required: false,
      limits: "One explicitly named dependency",
      risks: "Dependency and lock-file change",
      fallback: "Use the documented no-new-dependency route",
      reconfirm: "Package or source changes",
    },
  ],
  prohibitions: ["No push, publication, deployment or credential changes"],
  reconfirm: ["Material scope changes require a new exact proposal"],
};
