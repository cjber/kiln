import { useCallback, useRef, useState } from "react";

/**
 * State the key handler reads when a key arrives. A paste or fast typing
 * delivers several keys before React re-renders the handler, so reading render
 * state would apply `/xy` as a filter, a close and a confirm.
 */
export function useLatest<T>(initial: T): [T, () => T, (next: T | ((current: T) => T)) => void] {
  const ref = useRef(initial);
  const [value, setValue] = useState(initial);
  const get = useCallback(() => ref.current, []);
  const set = useCallback((next: T | ((current: T) => T)) => {
    ref.current = typeof next === "function" ? (next as (current: T) => T)(ref.current) : next;
    setValue(ref.current);
  }, []);
  return [value, get, set];
}
