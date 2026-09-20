import { useCallback, useEffect, useState } from "react";
import { readLocal, writeLocal } from "./storage";

const listeners = new Map<string, Set<() => void>>();

function notify(suffix: string): void {
  listeners.get(suffix)?.forEach((listener) => listener());
}

function readBooleanPref(suffix: string, defaultOn: boolean): boolean {
  const raw = readLocal(suffix);
  if (raw === null) return defaultOn;
  return raw !== "false";
}

/**
 * Boolean localStorage pref under `cook.<suffix>`. Default ON matches Always approve
 * (`readLocal(key) !== "false"` when defaultOn). Writes notify every mounted consumer
 * so Settings toggles hide/show rails without a reload.
 */
export function useBooleanPref(suffix: string, defaultOn = true): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState(() => readBooleanPref(suffix, defaultOn));

  useEffect(() => {
    const onChange = () => setValue(readBooleanPref(suffix, defaultOn));
    let set = listeners.get(suffix);
    if (!set) {
      set = new Set();
      listeners.set(suffix, set);
    }
    set.add(onChange);
    return () => {
      set!.delete(onChange);
      if (set!.size === 0) listeners.delete(suffix);
    };
  }, [suffix, defaultOn]);

  const set = useCallback(
    (next: boolean) => {
      writeLocal(suffix, String(next));
      setValue(next);
      notify(suffix);
    },
    [suffix],
  );

  return [value, set];
}

export const COMPOSER_SHOW_TPS_KEY = "composerShowTps";
export const COMPOSER_SHOW_DIFFSTAT_KEY = "composerShowDiffstat";
