"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import {
  DEFAULT_CONFIRMATION_MESSAGE,
  DEFAULT_TERMS_TEXT,
  parseRegistrationSettings,
} from "@/lib/registration-settings";

const labelClass = "mb-1.5 block text-sm font-medium text-[#201E1B]";
const textareaClass =
  "block w-full rounded-xl border border-[#E2DFD6] bg-white px-4 py-3 text-base leading-relaxed text-[#201E1B] focus:border-[#201E1B] focus:outline-none";
const beigeButton =
  "w-full rounded-2xl border border-[#BDB6A2] bg-[#E9E4D6] px-4 py-4 text-base font-semibold text-[#201E1B] disabled:opacity-40";
const plainButton =
  "rounded-xl border border-[#D6D1C3] bg-white px-3 py-2 text-sm font-semibold text-[#201E1B] disabled:opacity-40";


/**
 * "🔗 Add link": inserts [Label](https://…) at the cursor of a textarea (the label
 * can be renamed any time by editing the text in the brackets). If some text is
 * selected it becomes the label.
 */
function LinkInserter({
  textareaRef,
  value,
  onChange,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const range = useRef<[number, number]>([0, 0]);

  function openForm() {
    const ta = textareaRef.current;
    const start = ta?.selectionStart ?? value.length;
    const end = ta?.selectionEnd ?? value.length;
    range.current = [start, end];
    setLabel(value.slice(start, end).replace(/[\[\]\n]/g, ""));
    setUrl("");
    setError(null);
    setOpen(true);
  }

  function insert() {
    const text = label.trim();
    let href = url.trim();
    if (!text) return setError("Please enter the text that should be shown.");
    if (!href) return setError("Please enter the link.");
    if (!/^https?:\/\//i.test(href)) href = `https://${href}`;
    if (/\s/.test(href) || !/^https?:\/\/[^/]+\.[^/]+/i.test(href)) return setError("That doesn't look like a valid link.");
    href = href.replace(/\)/g, "%29");
    const [start, end] = range.current;
    const md = `[${text.replace(/[\[\]]/g, "")}](${href})`;
    onChange(value.slice(0, start) + md + value.slice(end));
    setOpen(false);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(start + md.length, start + md.length);
      }
    });
  }

  if (!open) {
    return (
      <button type="button" onClick={openForm} className={plainButton}>
        🔗 Add link
      </button>
    );
  }
  return (
    <div className="w-full space-y-2 rounded-xl border border-[#E2DFD6] bg-[#FBF9F4] p-3">
      <div>
        <label className="mb-1 block text-xs font-medium text-[#5C5850]">Text shown</label>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. House rules"
          className="block w-full min-w-0 rounded-xl border border-[#E2DFD6] bg-white px-3 py-2.5 text-base"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-[#5C5850]">Link</label>
        <input
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…"
          className="block w-full min-w-0 rounded-xl border border-[#E2DFD6] bg-white px-3 py-2.5 text-base"
        />
      </div>
      {error && <p className="text-sm text-red-800">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => setOpen(false)} className={plainButton}>
          Cancel
        </button>
        <button
          type="button"
          onClick={insert}
          className="rounded-xl border border-[#BDB6A2] bg-[#E9E4D6] px-3 py-2 text-sm font-semibold text-[#201E1B]"
        >
          Insert
        </button>
      </div>
    </div>
  );
}

/**
 * Crew → Registrations → Settings: the texts of the public registration form.
 * Saved at flyerSettings/registration; /register falls back to the built-in
 * defaults for anything empty.
 */
export default function RegistrationSettingsPanel({
  adminEmail,
  onBack,
}: {
  adminEmail: string;
  onBack: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const termsRef = useRef<HTMLTextAreaElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const [terms, setTerms] = useState(DEFAULT_TERMS_TEXT);
  const [message, setMessage] = useState(DEFAULT_CONFIRMATION_MESSAGE);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askReset, setAskReset] = useState<"terms" | "message" | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDoc(doc(db, "flyerSettings", "registration"))
      .then((snap) => {
        if (cancelled) return;
        if (snap.exists()) {
          const s = parseRegistrationSettings(snap.data());
          setTerms(s.termsText);
          setMessage(s.confirmationMessage);
        }
        setLoaded(true);
      })
      .catch((err) => {
        console.error("[admin] registration settings load failed:", err);
        if (!cancelled) {
          setError("Couldn't load the saved texts — showing the defaults. Saving will still work.");
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    if (!terms.trim() || !message.trim()) {
      setError("Both texts need some content (use “Reset to default” to go back to the original).");
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await setDoc(
        doc(db, "flyerSettings", "registration"),
        {
          termsText: terms.trim(),
          confirmationMessage: message.trim(),
          updatedAt: serverTimestamp(),
          updatedBy: adminEmail,
        },
        { merge: true },
      );
      setSaved(true);
    } catch (err) {
      console.error("[admin] registration settings save failed:", err);
      setError("Saving failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function doReset() {
    if (askReset === "terms") setTerms(DEFAULT_TERMS_TEXT);
    if (askReset === "message") setMessage(DEFAULT_CONFIRMATION_MESSAGE);
    setAskReset(null);
    setSaved(false);
  }

  return (
    // Bottom padding: the fixed "Share registration link" bar of the dashboard would otherwise cover the Save button.
    <div className="pb-32">
      <button type="button" onClick={onBack} className="mb-4 text-sm text-[#5C5850] underline">
        ← Back to registrations
      </button>
      <h2 className="mb-1 text-xl font-semibold">Registration settings</h2>
      <p className="mb-5 text-sm text-[#5C5850]">
        These texts appear on the public registration form. Changes apply as soon as you save.
      </p>

      {!loaded && <p className="text-[#5C5850]">Loading…</p>}

      {loaded && (
        <div className="space-y-6">
          <div>
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <label htmlFor="termsText" className="text-sm font-medium">
                Volunteer Terms &amp; Conditions
              </label>
              <button type="button" onClick={() => setAskReset("terms")} className={plainButton}>
                Reset to default
              </button>
            </div>
            <textarea
              id="termsText"
              ref={termsRef}
              rows={18}
              value={terms}
              onChange={(e) => {
                setTerms(e.target.value);
                setSaved(false);
              }}
              className={textareaClass}
            />
            <div className="mt-2">
              <LinkInserter
                textareaRef={termsRef}
                value={terms}
                onChange={(v) => {
                  setTerms(v);
                  setSaved(false);
                }}
              />
            </div>
            <p className="mt-2 text-xs text-[#8A857A]">
              Shown in the pop-up behind “Volunteer Terms &amp; Conditions”. Line breaks are kept; leave a blank line
              between sections. Links look like [Text](https://…) — use “Add link”, and rename a link any time by
              editing the text in the square brackets.
            </p>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <label htmlFor="confirmationMessage" className="text-sm font-medium">
                Message after sending the registration
              </label>
              <button type="button" onClick={() => setAskReset("message")} className={plainButton}>
                Reset to default
              </button>
            </div>
            <textarea
              id="confirmationMessage"
              ref={messageRef}
              rows={5}
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
                setSaved(false);
              }}
              className={textareaClass}
            />
            <div className="mt-2">
              <LinkInserter
                textareaRef={messageRef}
                value={message}
                onChange={(v) => {
                  setMessage(v);
                  setSaved(false);
                }}
              />
            </div>
            <p className="mt-2 text-xs text-[#8A857A]">
              Appears under “Thanks, &lt;first name&gt;!”. Use {"{name}"} to insert the first name inside the text. Links work here too (“Add link”).
            </p>
          </div>

          {askReset && (
            <div className="rounded-xl border border-red-300 bg-red-50 p-3">
              <p className="mb-2.5 text-sm text-red-900">
                Replace the {askReset === "terms" ? "Terms & Conditions" : "confirmation message"} with the original
                text? (Not saved until you press Save.)
              </p>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setAskReset(null)} className={plainButton}>
                  Keep my text
                </button>
                <button
                  type="button"
                  onClick={doReset}
                  className="rounded-xl bg-red-700 px-3 py-2 text-sm font-semibold text-white"
                >
                  Reset
                </button>
              </div>
            </div>
          )}

          {error && (
            <div role="alert" className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
              {error}
            </div>
          )}

          <button type="button" disabled={busy} onClick={save} className={beigeButton}>
            {busy ? "Saving…" : saved ? "✓ Saved" : "Save"}
          </button>
        </div>
      )}
    </div>
  );
}
