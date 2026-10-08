"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { MAX_AUDIO_SECONDS, prepareChatFile, type PreparedMedia } from "@/lib/chat-media";

const EMOJIS = [
  "😀", "😂", "🤣", "😊", "😍", "😘", "😎", "🤩", "🥳", "😉", "🙂", "😅",
  "😢", "😭", "😡", "🤔", "😴", "🤗", "🙄", "😬", "😱", "🤯", "🥵", "🥶",
  "👍", "👎", "👏", "🙌", "🙏", "💪", "👋", "🤝", "✌️", "🤙", "👌", "🫶",
  "❤️", "🔥", "✨", "🎉", "💯", "✅", "❌", "⚠️", "📍", "🛵", "🏍️", "⛽",
  "☀️", "🌴", "🌊", "🍹", "🍺", "🍕", "🥥", "🍜", "📦", "📸", "🎶", "🕐",
];

function pickRecorderMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? "";
}

function fmt(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

/**
 * Message input for chats: text, emoji picker, photo/video attach and voice
 * messages. Storage + Firestore writes are done by the parent via the callbacks.
 */
export default function ChatComposer({
  placeholder = "Type a message…",
  inputClassName,
  onSendText,
  onSendMedia,
}: {
  placeholder?: string;
  inputClassName: string;
  onSendText: (text: string) => Promise<void>;
  onSendMedia: (media: PreparedMedia) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);

  const fileRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onSendMediaRef = useRef(onSendMedia);
  onSendMediaRef.current = onSendMedia;
  const canRecord = typeof window !== "undefined" && typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices;

  function cleanupRecording() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    setRecording(false);
    setSeconds(0);
  }

  useEffect(() => {
    return () => {
      discardRef.current = true;
      if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
      cleanupRecording();
    };
  }, []);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (err) {
      console.error("[chat] send failed:", err);
      setError(err instanceof Error && err.message ? err.message : "Sending failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function sendText() {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    await run(async () => {
      await onSendText(trimmed);
      setText("");
      setEmojiOpen(false);
    });
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await run(async () => {
      const media = await prepareChatFile(file);
      await onSendMedia(media);
    });
  }

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickRecorderMime();
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      chunksRef.current = [];
      discardRef.current = false;
      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      rec.onstop = () => {
        const type = rec.mimeType || mime || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        const discard = discardRef.current;
        cleanupRecording();
        if (discard || blob.size === 0) return;
        void run(() => onSendMediaRef.current({ type: "audio", blob, contentType: type }));
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
      setSeconds(0);
      const startedAt = Date.now();
      timerRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        setSeconds(elapsed);
        if (elapsed >= MAX_AUDIO_SECONDS && recorderRef.current?.state === "recording") recorderRef.current.stop();
      }, 500);
    } catch (err) {
      console.error("[chat] microphone failed:", err);
      cleanupRecording();
      setError("Couldn't access the microphone. Please allow microphone access in your browser.");
    }
  }

  function stopRecording(discard: boolean) {
    discardRef.current = discard;
    if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
    else cleanupRecording();
  }

  const iconButton =
    "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#E2DFD6] bg-white text-xl disabled:opacity-40";

  return (
    <div>
      {error && <p className="mb-2 text-sm text-red-800">{error}</p>}

      {emojiOpen && !recording && (
        <div className="mb-2 grid max-h-40 grid-cols-8 gap-1 overflow-y-auto rounded-xl border border-[#E2DFD6] bg-white p-2 sm:grid-cols-12">
          {EMOJIS.map((em) => (
            <button
              key={em}
              type="button"
              onClick={() => setText((t) => t + em)}
              className="h-9 rounded-lg text-xl hover:bg-[#F1EFE8]"
            >
              {em}
            </button>
          ))}
        </div>
      )}

      {recording ? (
        <div className="flex items-center gap-2">
          <span className="flex-1 text-sm font-semibold text-red-700">
            ● Recording {fmt(seconds)} <span className="font-normal text-[#5C5850]">/ {fmt(MAX_AUDIO_SECONDS)}</span>
          </span>
          <button
            type="button"
            onClick={() => stopRecording(true)}
            className="h-11 rounded-xl border border-[#E2DFD6] bg-white px-4 text-sm font-semibold"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => stopRecording(false)}
            className="h-11 rounded-xl border border-[#BDB6A2] bg-[#E9E4D6] px-4 text-sm font-semibold text-[#201E1B]"
          >
            Send
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <input ref={fileRef} type="file" accept="image/*,video/*" onChange={onFile} className="hidden" />
          <button
            type="button"
            aria-label="Attach photo or video"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className={iconButton}
          >
            📎
          </button>
          <button
            type="button"
            aria-label="Emojis"
            aria-pressed={emojiOpen}
            onClick={() => setEmojiOpen((o) => !o)}
            className={iconButton}
          >
            🙂
          </button>
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void sendText();
            }}
            placeholder={busy ? "Sending…" : placeholder}
            className={`${inputClassName} min-w-0 flex-1`}
          />
          {text.trim() || !canRecord ? (
            <button
              type="button"
              onClick={sendText}
              disabled={busy || !text.trim()}
              className="h-11 shrink-0 rounded-xl border border-[#BDB6A2] bg-[#E9E4D6] px-4 text-sm font-semibold text-[#201E1B] disabled:opacity-40"
            >
              Send
            </button>
          ) : (
            <button type="button" aria-label="Record voice message" disabled={busy} onClick={startRecording} className={iconButton}>
              🎤
            </button>
          )}
        </div>
      )}
    </div>
  );
}
