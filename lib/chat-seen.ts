/** "Last seen" markers for the group chat, kept per browser (no server round trip). */

export function readSeen(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function writeSeen(key: string, ms: number): void {
  try {
    window.localStorage.setItem(key, String(ms));
  } catch {
    // Storage unavailable (private mode etc.): the dot just won't persist.
  }
}
