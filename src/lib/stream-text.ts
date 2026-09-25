import { appendStreamingResponseText } from "../../server/response-options";

/** Text deltas notify only the conversation that displays them. */
export function createStreamText() {
  const raw = new Map<string, string>();
  const visible = new Map<string, string>();
  const listeners = new Map<string, Set<() => void>>();
  const scheduled = new Set<string>();
  const notify = (id: string) => {
    if (typeof requestAnimationFrame !== "function") { listeners.get(id)?.forEach((listener) => listener()); return; }
    if (scheduled.has(id)) return;
    scheduled.add(id);
    requestAnimationFrame(() => {
      scheduled.delete(id);
      listeners.get(id)?.forEach((listener) => listener());
    });
  };
  return {
    get: (id: string) => visible.get(id) ?? "",
    subscribe(id: string, listener: () => void) {
      const set = listeners.get(id) ?? new Set();
      listeners.set(id, set);
      set.add(listener);
      return () => { set.delete(listener); };
    },
    append(id: string, delta: string) {
      const next = appendStreamingResponseText(raw.get(id) ?? "", delta);
      raw.set(id, next.raw);
      if (visible.get(id) === next.visible) return;
      visible.set(id, next.visible);
      notify(id);
    },
    clear(id: string) {
      raw.delete(id);
      visible.delete(id);
      listeners.get(id)?.forEach((listener) => listener());
    },
  };
}
