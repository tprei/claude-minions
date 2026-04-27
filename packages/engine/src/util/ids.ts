import { customAlphabet, nanoid } from "nanoid";

const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const slugger = customAlphabet(SLUG_ALPHABET, 10);

export function newSlug(prefix?: string): string {
  const s = slugger();
  return prefix ? `${prefix}-${s}` : s;
}

export function newId(): string {
  return nanoid(16);
}

export function newEventId(): string {
  return nanoid(20);
}
