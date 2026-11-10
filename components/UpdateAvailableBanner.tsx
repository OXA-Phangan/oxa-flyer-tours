"use client";

import { useEffect, useState } from "react";
import { isUpdateBlocked, subscribeUpdateGuard } from "@/lib/update-guard";

const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? "";
const POLL_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Notices when a new deployment has landed while this tab/PWA stayed open,
 * and asks the user to reload. Next.js never reloads an open tab on its
 * own, so without this a tab left open across a deploy keeps running the
 * old bundle indefinitely — the 2026-09-23 checklist `checkedAt` incident
 * was exactly that (a stale tab writing ticks with the pre-`checkedAt`
 * toggle code hours after the fix was live).
 *
 * Checks app/api/version on every return to visibility (phones mostly
 * resume from background rather than sit visible) plus every 10 min while
 * visible, never while hidden. Prompts rather than auto-reloads — a forced
 * reload could discard staged proof photos or a half-filled form — and is
 * only snoozable (see below). Failures (offline etc.) are silent; the
 * next check just tries again. Inert in local dev (no BUILD_ID).
 *
 * Shown as a centered pop-up over the page (2026-10-31, Mobit: the thin
 * top bar was overlooked by many employees). "Reload" is the big button;
 * it waits while someone is uploading or editing (lib/update-guard.ts), and
 * "Later" still hides it for 5 minutes as a fallback.
 */
// Same wording as the Employee Portal's pop-up.
const TEXTS = {
  en: { message: "A new version is available.", reloadLabel: "Reload", laterLabel: "Later" },
  th: { message: "มีเวอร์ชันใหม่แล้ว", reloadLabel: "โหลดใหม่", laterLabel: "ภายหลัง" },
  mm: { message: "ဗားရှင်းအသစ် ရနိုင်ပါပြီ။", reloadLabel: "ပြန်ဖွင့်ရန်", laterLabel: "နောက်မှ" },
} as const;

export function UpdateAvailableBanner() {
  // No language switch in this app: follow the device language (Thai / Burmese).
  const [lang, setLang] = useState<"en" | "th" | "mm">("en");
  useEffect(() => {
    const l = (navigator.language || "en").toLowerCase();
    setLang(l.startsWith("th") ? "th" : l.startsWith("my") ? "mm" : "en");
  }, []);
  const { message, reloadLabel, laterLabel } = TEXTS[lang];
  const [stale, setStale] = useState(false);
  const [snoozedUntil, setSnoozedUntil] = useState(0);
  const [, setTick] = useState(0);
  // Not while uploading or editing (lib/update-guard.ts) — shown as soon as
  // that's over. focusout fires before the next field gets focus, so the
  // check waits a moment to avoid flashing between two fields.
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    let timer = 0;
    const update = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setBlocked(isUpdateBlocked()), 300);
    };
    setBlocked(isUpdateBlocked());
    const unsubscribe = subscribeUpdateGuard(update);
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  // Re-show after "Later": re-render once the snooze has run out.
  useEffect(() => {
    if (snoozedUntil === 0) return;
    const id = window.setTimeout(() => setTick((n) => n + 1), Math.max(0, snoozedUntil - Date.now()) + 50);
    return () => window.clearTimeout(id);
  }, [snoozedUntil]);

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

  if (!stale || blocked || Date.now() < snoozedUntil) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 px-6">
      <div
        role="alertdialog"
        aria-modal="true"
        className="max-w-full rounded-[24px] border border-[#CFC7B4] bg-[#F5F3EF]/75 p-[30px] text-center shadow-xl backdrop-blur-[6px]"
      >
        <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="#4A4438" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mx-auto" aria-hidden="true">
          <path d="M20 11A8.1 8.1 0 0 0 4.5 9M4 5v4h4" />
          <path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />
        </svg>
        <p className="mt-3 whitespace-nowrap text-[18px] font-semibold text-[#2A2620]">{message}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-5 w-full rounded-2xl border border-[#B5AC96] bg-[#E4DDC9] px-4 py-3.5 text-[16px] font-semibold text-[#2A2620] active:bg-[#D9D1BC]"
        >
          {reloadLabel}
        </button>
        <button
          type="button"
          onClick={() => setSnoozedUntil(Date.now() + 5 * 60 * 1000)}
          className="mt-3 text-[13px] text-[#8A8578] underline"
        >
          {laterLabel}
        </button>
      </div>
    </div>
  );
}
