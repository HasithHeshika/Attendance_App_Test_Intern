'use client';
// Canvas downscale + JPEG re-encode, shared by the two paths that need a smaller image: the
// bill READ (Gemini/tesseract — see resizeImageForOcr in ocr.ts) and the bill UPLOAD (see
// uploadCloudFile in services/cloudStorageService.ts). Kept in its own module so neither path
// has to import the other's baggage — ocr.ts pulls in tesseract, the upload path pulls in
// firebase.

export interface ResizeOpts {
  /** Longest edge, in pixels, the result may have. */
  maxDim: number;
  /** JPEG quality, 0-1. */
  quality: number;
  /** Re-encode even a within-bounds image when it is bigger than this many bytes. */
  maxBytes?: number;
}

// Returns the ORIGINAL file when it isn't an image, when it's already inside both limits, or
// when anything in the pipeline fails — uploading a slower, larger photo is fine; silently
// losing a bill because a resize hiccuped is not.
export async function resizeImage(file: File, opts: ResizeOpts): Promise<File> {
  if (!file.type.startsWith('image/')) return file;
  try {
    const bitmap  = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    const overDim = longest > opts.maxDim;
    const overMax = opts.maxBytes != null && file.size > opts.maxBytes;
    if (!overDim && !overMax) { bitmap.close?.(); return file; }

    const scale = overDim ? opts.maxDim / longest : 1;
    const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) { bitmap.close?.(); return file; }
    // JPEG has no alpha channel: without this fill, the transparent parts of a screenshotted
    // bill come out black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', opts.quality));
    if (!blob) return file;
    // Re-encoding an already-small image can make it BIGGER (a flat-colour PNG is the usual
    // culprit). When we weren't shrinking the dimensions anyway, keep the smaller original.
    if (!overDim && blob.size >= file.size) return file;
    return new File([blob], jpgName(file.name), { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

// Swap the extension of a filename — or of a whole relative path — for .jpg. The re-encode
// always produces JPEG, so a bill left named ".png"/".heic" would misdescribe its own bytes.
// A path whose last segment has no extension gets one appended; a dot in a FOLDER name (e.g.
// "Alta Vision Ltd./2026/09/bill") is not an extension and must not be clobbered.
export function jpgName(name: string): string {
  return /\.[^./]+$/.test(name) ? name.replace(/\.[^./]+$/, '.jpg') : `${name}.jpg`;
}
