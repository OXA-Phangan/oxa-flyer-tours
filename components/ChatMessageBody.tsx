"use client";

import { useEffect, useState } from "react";
import { chatMediaUrl, type ChatMediaType } from "@/lib/chat-media";

/**
 * Text and/or media of one chat message. Media files are deleted 7 days
 * after check-out, so a missing file is a normal state ("Media deleted").
 */
export default function ChatMessageBody({
  text,
  mediaType,
  mediaPath,
}: {
  text?: string;
  mediaType?: ChatMediaType | null;
  mediaPath?: string | null;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "deleted">("loading");

  useEffect(() => {
    if (!mediaType || !mediaPath) return;
    let cancelled = false;
    chatMediaUrl(mediaPath)
      .then((u) => {
        if (cancelled) return;
        setUrl(u);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("deleted");
      });
    return () => {
      cancelled = true;
    };
  }, [mediaType, mediaPath]);

  return (
    <>
      {mediaType && mediaPath && (
        <div className={text ? "mb-1.5" : ""}>
          {state === "loading" && <span className="text-xs opacity-70">Loading…</span>}
          {state === "deleted" && <span className="text-xs italic opacity-70">Media deleted</span>}
          {state === "ready" && url && mediaType === "image" && (
            <a href={url} target="_blank" rel="noopener noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt="Photo" className="max-h-60 max-w-full rounded-lg" />
            </a>
          )}
          {state === "ready" && url && mediaType === "video" && (
            <video src={url} controls playsInline preload="metadata" className="max-h-60 max-w-full rounded-lg" />
          )}
          {state === "ready" && url && mediaType === "audio" && (
            <audio src={url} controls preload="metadata" className="h-10 max-w-full" />
          )}
        </div>
      )}
      {text ? <span className="whitespace-pre-wrap break-words">{text}</span> : null}
    </>
  );
}
