export interface MentionToken {
  start: number;
  end: number;
  query: string;
}

export function currentMentionToken(value: string, caret: number): MentionToken | null {
  if (caret <= 0 || caret > value.length) return null;
  let start = caret;
  while (start > 0 && !/\s/.test(value[start - 1] ?? "")) {
    start--;
  }
  const token = value.slice(start, caret);
  if (!token.startsWith("@")) return null;
  return { start, end: caret, query: token.slice(1) };
}

export function replaceMentionToken(
  value: string,
  token: { start: number; end: number },
  replacement: string,
): { value: string; caret: number } {
  const next = value.slice(0, token.start) + replacement + " " + value.slice(token.end);
  const caret = token.start + replacement.length + 1;
  return { value: next, caret };
}
