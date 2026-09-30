const MAX_WIDTH = 1024;
const JPEG_QUALITY = 0.7;

/**
 * Client-side resize + re-encode before upload. Ported from
 * oxa-poster-tour's lib/image-compression.ts (duplicated, not imported —
 * no shared package between these repos), with this app's own limits:
 * max 1024px *width* (height proportional) and JPEG quality 0.7.
 *
 * Same low-memory approach as the original: read dimensions via a plain
 * <img> onload first, then let createImageBitmap decode directly at the
 * target size — a full-resolution decode followed by a separate
 * downscale was enough to OOM-crash low-RAM Android devices there.
 *
 * Never blocks the upload: any failure (old browser, decode error,
 * unusual format) falls back to the original file.
 */
export async function compressImageFile(file: File | Blob): Promise<File | Blob> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const { naturalWidth, naturalHeight } = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("failed to read image dimensions"));
      img.src = objectUrl;
    });

    const scale = Math.min(1, MAX_WIDTH / naturalWidth);
    const width = Math.round(naturalWidth * scale);
    const height = Math.round(naturalHeight * scale);

    // imageOrientation: "from-image" bakes the EXIF rotation tag into
    // the decoded pixels — without it, a canvas draw ignores EXIF and
    // can silently re-encode a phone photo sideways/upside down.
    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: "medium",
    });

    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    if (!blob) return file;

    // A tiny/already-simple source image can occasionally re-encode
    // larger than the original — only use the compressed version when
    // it's actually smaller.
    return blob.size < file.size ? blob : file;
  } catch (err) {
    console.error("[compressImageFile] compression failed, uploading original file:", err);
    return file;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
