import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, type Component } from "@earendil-works/pi-tui";
import { vi } from "vitest";
import { createMockTheme } from "./mocks";

export const DOWN = "\u001b[B";
export const ESC = "\u001b";
export const ENTER = "\r";

/** Opt-in public factory driver. No synthetic review result or native answer. */
export function installCustomUI(ctx: ExtensionContext, script?: (driver: Driver) => void) {
  const rendered: string[] = [];
  const components: Component[] = [];
  const reviewedMaterial: string[] = [];
  let component: Component;
  let doneCount = 0;
  let width = 120;
  let rows = 40;
  let scriptThrew = false;
  let scriptError: unknown;
  const driver = {
    rendered,
    components,
    reviewedMaterial,
    get doneCount() {
      return doneCount;
    },
    resize(w: number, r: number) {
      width = w;
      rows = r;
      return driver.render();
    },
    render() {
      const text = component.render(width).join("\n");
      rendered.push(text);
      return text;
    },
    press(key: string) {
      component.handleInput?.(key);
      return driver.render();
    },
    open(index: number) {
      for (let i = 0; i < index; i++) driver.press(DOWN);
      return driver.press(ENTER);
    },
    scrollAll() {
      let previous = driver.render();
      for (let i = 0; i < 10000; i++) {
        const next = driver.press(DOWN);
        if (next === previous) return;
        previous = next;
      }
      throw new Error("Detail scrolling did not reach the end");
    },
    reviewAll() {
      const before = doneCount;
      for (let page = 0; page < 10000; page++) {
        const lines = driver.render().split("\n");
        if (!lines[1]?.startsWith("第 ")) throw new Error("Expected a real scope review page");
        // Formatted browsing is not exact-source review evidence.
        if (lines[0] === "只读核对（非作答）") reviewedMaterial.push(...lines.slice(3, -2));
        driver.press(ENTER);
        if (doneCount !== before) return;
      }
      throw new Error("Scope review did not finish");
    },
    assertNoScriptErrors() {
      if (scriptThrew) throw scriptError;
    },
  };
  const theme = createMockTheme();
  vi.mocked(theme.fg).mockImplementation((_color, text) => text);
  const custom = vi.fn(
    (factory: any) =>
      new Promise((resolve) => {
        component = factory(
          {
            terminal: {
              get rows() {
                return rows;
              },
            },
            requestRender: vi.fn(),
          },
          theme,
          new KeybindingsManager(TUI_KEYBINDINGS),
          (value: unknown) => {
            doneCount++;
            resolve(value);
          },
        );
        components.push(component);
        driver.render();
        try {
          script?.(driver);
        } catch (error) {
          scriptThrew = true;
          scriptError = error;
          throw error;
        }
      }),
  );
  Object.assign(ctx.ui, { custom });
  return Object.assign(driver, { custom });
}

interface Driver {
  rendered: string[];
  components: Component[];
  readonly doneCount: number;
  reviewedMaterial: string[];
  reviewAll(): void;
  resize(width: number, rows: number): string;
  render(): string;
  press(key: string): string;
  open(index: number): string;
  scrollAll(): void;
  assertNoScriptErrors(): void;
}
