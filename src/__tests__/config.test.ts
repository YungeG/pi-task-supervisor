import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONFIG,
  loadConfig,
  resetConfig,
  resolvePhasePrompt,
  type ContinuousTasksConfig,
} from "../config";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
vi.mock("node:os", () => ({ homedir: vi.fn(() => "/home/test") }));
vi.mock("node:path", () => ({
  join: vi.fn((...parts: string[]) => parts.join("/")),
  resolve: vi.fn((path: string) => path),
}));

import { readFile } from "node:fs/promises";

const mockReadFile = vi.mocked(readFile);

function validConfig(overrides: Partial<ContinuousTasksConfig> = {}): ContinuousTasksConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

describe("config", () => {
  beforeEach(() => {
    resetConfig();
    mockReadFile.mockReset();
    delete process.env.PI_CODING_AGENT_DIR;
  });

  describe("loadConfig", () => {
    it("returns defaults when the file does not exist", async () => {
      const error = new Error("missing") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      mockReadFile.mockRejectedValue(error);

      await expect(loadConfig()).resolves.toEqual(DEFAULT_CONFIG);
    });

    it.each(["not valid json {{{", JSON.stringify("a string"), JSON.stringify(null)])(
      "returns defaults for invalid input: %s",
      async (raw) => {
        mockReadFile.mockResolvedValue(raw);
        await expect(loadConfig()).resolves.toEqual(DEFAULT_CONFIG);
      },
    );

    it("loads partial settings with defaults", async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ countdownMs: 10 }));
      await expect(loadConfig()).resolves.toEqual({ ...DEFAULT_CONFIG, countdownMs: 10 });
    });

    it("loads a bounded valid config", async () => {
      const expected = validConfig({
        countdownMs: 2500,
        maxStagnantSettles: 8,
        requireCompletionEvidence: false,
        phaseCompletionPromptTemplate: "Phase {phase} complete!",
      });
      mockReadFile.mockResolvedValue(JSON.stringify(expected));

      await expect(loadConfig()).resolves.toEqual(expected);
    });

    it.each([
      { countdownMs: -1 },
      { countdownMs: 60_001 },
      { maxStagnantSettles: 0 },
      { maxStagnantSettles: 21 },
      { requireCompletionEvidence: "yes" },
      { phaseCompletionPromptTemplate: 123 },
    ])("fails closed for invalid bounded settings: %j", async (overrides) => {
      mockReadFile.mockResolvedValue(JSON.stringify({ ...validConfig(), ...overrides }));
      await expect(loadConfig()).resolves.toEqual(DEFAULT_CONFIG);
    });

    it("loads independent bounded cache budgets without a lifetime receipt cap", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({ receiptCache: { maxEntries: 1, maxBytes: 16_384 } }),
      );
      await expect(loadConfig()).resolves.toMatchObject({
        receiptCache: { maxEntries: 1, maxBytes: 16_384 },
      });
    });

    it.each([
      null,
      "unlimited",
      { maxEntries: 0 },
      { maxEntries: 4097 },
      { maxBytes: 1 },
      { maxBytes: 67_108_865 },
      { maxBytes: "1000000" },
    ])("rejects invalid cache configuration %j", async (receiptCache) => {
      mockReadFile.mockResolvedValue(JSON.stringify({ receiptCache }));
      await expect(loadConfig()).resolves.toEqual(DEFAULT_CONFIG);
    });

    it("fails closed on unreadable configuration", async () => {
      const error = new Error("permission denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      mockReadFile.mockRejectedValue(error);

      await expect(loadConfig()).resolves.toEqual(DEFAULT_CONFIG);
    });

    it("caches the decoded config", async () => {
      mockReadFile.mockResolvedValue(JSON.stringify(validConfig()));
      const first = await loadConfig();
      const second = await loadConfig();

      expect(mockReadFile).toHaveBeenCalledTimes(1);
      expect(first).toBe(second);
    });
  });

  describe("resolvePhasePrompt", () => {
    it("returns undefined for a missing template", () => {
      expect(resolvePhasePrompt(undefined, 1)).toBeUndefined();
      expect(resolvePhasePrompt("", 1)).toBeUndefined();
    });

    it("replaces every phase placeholder", () => {
      expect(resolvePhasePrompt("Phase {phase} of {phase}", 3)).toBe("Phase 3 of 3");
    });
  });

  describe("resetConfig", () => {
    it("causes the next load to re-read the file", async () => {
      mockReadFile.mockResolvedValueOnce(JSON.stringify(validConfig({ countdownMs: 1 })));
      await expect(loadConfig()).resolves.toMatchObject({ countdownMs: 1 });

      resetConfig();
      mockReadFile.mockResolvedValueOnce(JSON.stringify(validConfig({ countdownMs: 2 })));
      await expect(loadConfig()).resolves.toMatchObject({ countdownMs: 2 });
      expect(mockReadFile).toHaveBeenCalledTimes(2);
    });
  });
});
