import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/__tests__/setup.ts"],
    // Bound native Session fixture WIP; keep every scenario, timeout and coverage gate.
    maxWorkers: 4,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/__tests__/**",
        "src/**/*.test.ts",
        "src/**/setup.ts",
        "src/**/helpers/**",
        "src/**/*.d.ts",
        "src/types.ts",
        "src/types/**",
      ],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
