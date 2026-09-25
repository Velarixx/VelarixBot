import { useEffect, useMemo, useState } from "react";
import { api, useStore, type Message } from "@/state/store";

export const HISTORY_WINDOW = 150;
const anchors = new Map<string, string | null>();
export function historyWindow(messages: Message[], anchor: string | null) {
  const found = anchor ? messages.findIndex((message) => message.id === anchor) : -1;
  const start = found < 0 ? Math.max(0, messages.length - HISTORY_WINDOW) : found;
  const end = Math.min(messages.length, start + HISTORY_WINDOW);
  return { start, end, messages: messages.slice(start, end), latest: end === messages.length };
}

/** Bounded DOM, with older pages loaded only when the reader asks for them. */
export function useHistoryWindow(threadId: string, messages: Message[], hasMore = false) {
  const { dispatch } = useStore();
  const [anchor, setAnchor] = useState<string | null>(() => anchors.get(threadId) ?? null);
  useEffect(() => { anchors.set(threadId, anchor); }, [threadId, anchor]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const window = useMemo(() => historyWindow(messages, anchor), [messages, anchor]);
  const earlier = async () => {
    if (loading) return;
    setError(null);
    if (window.start > 0) {
      setAnchor(messages[Math.max(0, window.start - 100)].id);
      return;
    }
    if (!hasMore || !messages[0]) return;
    setLoading(true);
    try {
      const page = await api(`/api/threads/${encodeURIComponent(threadId)}/messages?limit=100&before=${encodeURIComponent(messages[0].id)}`);
      dispatch({ type: "historyLoaded", threadId, messages: page.messages, hasMore: page.hasMore });
      setAnchor(page.messages[0]?.id ?? messages[0].id);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };
  const later = () => {
    const next = window.start + 100;
    setAnchor(next + HISTORY_WINDOW >= messages.length ? null : messages[next].id);
  };
  return { ...window, earlier, later, loading, error, hasEarlier: window.start > 0 || hasMore, hold: () => setAnchor(window.messages[0]?.id ?? null), jumpToLatest: () => setAnchor(null) };
}
