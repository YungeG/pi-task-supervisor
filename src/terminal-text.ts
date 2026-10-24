const unsafeTerminalCharacter = /[\p{Cc}\p{Cf}\p{Cs}]/u;

/** Escape untrusted display data before adding trusted theme ANSI. Never change canonical data. */
export function safeTerminalText(text: string): string {
  return Array.from(text, (character) => {
    if (character === "\n" || character === "\t" || !unsafeTerminalCharacter.test(character))
      return character;
    return `\\u{${character.codePointAt(0)?.toString(16).toUpperCase()}}`;
  }).join("");
}
