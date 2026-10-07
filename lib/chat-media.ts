import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { storage } from "@/lib/firebase";
import { compressImageFile } from "@/lib/image-compression";
import { generateToken } from "@/lib/token";

/**
 * Media in chat messages.
 *
 * Storage paths (deleted by the cleanupExpiredFlyerChatMedia Cloud Function,
 * 7 days after the sender's check-out — see cloud-functions.flyer-chat-media-cleanup.js.txt):
 *   flyerChat/{volunteerToken}/{id}.{ext}        direct chat with that volunteer
 *   flyerChat/group/{volunteerToken}/{id}.{ext}  group chat, sent by that volunteer
 *   flyerChat/group/admin/{id}.{ext}             group chat, sent by OXA (7 days after upload)
 *
 * The message doc stores mediaType + mediaPath; once the file is deleted the
 * chat simply shows "Media deleted" (getDownloadURL fails with object-not-found).
 */
export type ChatMediaType = "image" | "video" | "audio";

export const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
export const MAX_VIDEO_SECONDS = 30;
export const MAX_AUDIO_SECONDS = 120;

export const MEDIA_LABEL: Record<ChatMediaType, string> = {
  image: "📷 Photo",
  video: "🎥 Video",
  audio: "🎤 Voice message",
};

/** Short text for thread previews / notifications. */
export function messagePreview(text: string | undefined, mediaType: ChatMediaType | null | undefined): string {
  if (mediaType) return text?.trim() ? `${MEDIA_LABEL[mediaType]} ${text.trim()}` : MEDIA_LABEL[mediaType];
  return text ?? "";
}

function extensionFor(contentType: string, fallback: string): string {
  const t = contentType.toLowerCase();
  if (t.includes("webm")) return "webm";
  if (t.includes("mp4") || t.includes("m4a") || t.includes("aac")) return t.startsWith("audio") ? "m4a" : "mp4";
  if (t.includes("quicktime")) return "mov";
  if (t.includes("ogg")) return "ogg";
  if (t.includes("mpeg")) return "mp3";
  if (t.includes("jpeg") || t.includes("jpg")) return "jpg";
  if (t.includes("png")) return "png";
  return fallback;
}

/** Reads a video's duration in seconds (NaN if the browser can't read it). */
function videoDurationSeconds(file: Blob): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(v.duration);
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(NaN);
    };
    v.src = url;
  });
}

export type PreparedMedia = { type: ChatMediaType; blob: Blob; contentType: string };

/**
 * Validates + compresses a picked file. Photos are resized/re-encoded; videos
 * can't be re-encoded in the browser, so they are limited in size and length.
 * Throws an Error with a user-facing message when the file isn't acceptable.
 */
export async function prepareChatFile(file: File): Promise<PreparedMedia> {
  if (file.type.startsWith("image/")) {
    const blob = await compressImageFile(file);
    return { type: "image", blob, contentType: blob.type || "image/jpeg" };
  }
  if (file.type.startsWith("video/")) {
    if (file.size > MAX_VIDEO_BYTES) {
      throw new Error(`This video is too large. Please send a shorter one (max ${MAX_VIDEO_SECONDS} s / 25 MB).`);
    }
    const seconds = await videoDurationSeconds(file);
    if (Number.isFinite(seconds) && seconds > MAX_VIDEO_SECONDS + 1) {
      throw new Error(`This video is too long. Max ${MAX_VIDEO_SECONDS} seconds.`);
    }
    return { type: "video", blob: file, contentType: file.type };
  }
  throw new Error("Please choose a photo or a video.");
}

/**
 * Uploads prepared media. `folder` is the path below flyerChat/, e.g.
 * `${token}` (direct) or `group/${token}` / `group/admin` (group).
 */
export async function uploadChatMedia(folder: string, media: PreparedMedia): Promise<string> {
  const fallback = media.type === "image" ? "jpg" : media.type === "video" ? "mp4" : "webm";
  const path = `flyerChat/${folder}/${generateToken()}.${extensionFor(media.contentType, fallback)}`;
  await uploadBytes(ref(storage, path), media.blob, { contentType: media.contentType });
  return path;
}

export async function chatMediaUrl(path: string): Promise<string> {
  return getDownloadURL(ref(storage, path));
}
