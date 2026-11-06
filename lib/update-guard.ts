"use client";

import { useEffect } from "react";

/**
 * Keeps the "new version" pop-up (components/UpdateAvailableBanner.tsx) away
 * while someone is uploading or editing (2026-10-31, Mobit) — a reload then
 * would lose staged photos or a half-filled form. Busy = any component that
 * called useUpdateGuard(true) is mounted, OR a text field / textarea / select
 * currently has the focus. The pop-up appears as soon as nothing is busy.
 */
const blockers = new Set<symbol>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

export function useUpdateGuard(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const token = Symbol("update-guard");
    blockers.add(token);
    notify();
    return () => {
      blockers.delete(token);
      notify();
    };
  }, [active]);
}

function editingField(): boolean {
  const el = typeof document !== "undefined" ? document.activeElement : null;
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) {
    return !["button", "submit", "checkbox", "radio", "file", "range", "reset", "image"].includes(el.type);
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

export function isUpdateBlocked(): boolean {
  return blockers.size > 0 || editingField();
}

/** Calls `fn` whenever the busy state may have changed (guards, focus). */
export function subscribeUpdateGuard(fn: () => void): () => void {
  listeners.add(fn);
  document.addEventListener("focusin", fn);
  document.addEventListener("focusout", fn);
  return () => {
    listeners.delete(fn);
    document.removeEventListener("focusin", fn);
    document.removeEventListener("focusout", fn);
  };
}
