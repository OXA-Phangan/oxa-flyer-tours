"use client";

import { useEffect, useState } from "react";

const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? "";
const POLL_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Notices when a new deployment has landed while this tab/PWA stayed open,
 * and asks the user to reload. Next.js never reloads an open tab on its own,
 * so without this a tab left open across a deploy keeps running the old
 * bundle indefinitely.
 *
 * Checks app/api/version on every return to visibility (phones mostly resume
 * from background rather than sit visible) plus every 10 min while visible,
 * never while hidden. Prompts rather than auto-reloads — a forced reload
 * could discard a half-filled form or an in-progress photo upload — and is
 * deliberately not dismissible. Failures (offline etc.) are silent; the next
 * check just tries again. Inert in local dev (no BUILD_ID).
 *
 * `sticky`, not `fixed`: it occupies its own space in the flow, so it pushes
 * page content down instead of covering the top row, while staying pinned on
 * scroll. Rendered once from the root layout, so it covers /admin and /v/*.
 */
export function UpdateAvailableBanner() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (!BUILD_ID || stale) return;
    let cancelled = false;

    async function check() {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const { version } = (await res.json()) as { version: string };
        if (!cancelled && version && version !== BUILD_ID) setStale(true);
      } catch {
        // Offline or transient — retry on the next trigger.
      }
    }

    const interval = window.setInterval(check, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    check();
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, [stale]);

  if (!stale) return null;

  return (
    <div
      role="status"
      className="sticky top-0 z-[60] flex items-center justify-between gap-3 bg-[#201E1B] px-4 py-2 text-xs text-white"
    >
      <span>A new version is available.</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="shrink-0 rounded-md bg-white px-3 py-1 font-semibold text-[#201E1B]"
      >
        Update
      </button>
    </div>
  );
}
