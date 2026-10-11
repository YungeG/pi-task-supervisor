import { vi } from "vitest";
import type * as PiTUI from "@earendil-works/pi-tui";

/** Mock Text class for testing */
class MockText {
  constructor(
    private _text: string,
    _x: number,
    _y: number,
  ) {}

  toString(): string {
    return this._text;
  }

  render(_width: number): string[] {
    if (this._text === "") {
      return [];
    }
    return this._text.split("\n");
  }
}

// Mock Text only; exercise real terminal-width and control-sequence utilities.
vi.mock("@earendil-works/pi-tui", async (importOriginal) => ({
  ...(await importOriginal<typeof PiTUI>()),
  Text: MockText,
}));
