import { useShallow } from "zustand/react/shallow";

export { useShallow };

export function shallowPick<T extends object, K extends keyof T>(
  keys: K[],
): (state: T) => Pick<T, K> {
  return (state: T) => {
    const result = {} as Pick<T, K>;
    for (const k of keys) result[k] = state[k];
    return result;
  };
}
