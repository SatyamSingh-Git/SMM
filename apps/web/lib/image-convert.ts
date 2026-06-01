// Client-side image -> JPEG conversion via the Canvas API.
//
// Why client-side?
//   - Free (no Fly CPU/RAM per upload)
//   - No native deps in the API image (sharp is ~30MB)
//   - Browser handles PNG/WEBP/BMP/GIF natively
//
// Limits:
//   - HEIC/HEIF (iPhone) can't be decoded by Canvas. We throw a friendly
//     error so the user converts via Photos / Files first.
//   - Transparency is flattened over white (JPEG doesn't support alpha).
//     For our cute fashion / dance niche this is invisible (real photos),
//     but flagged here in case it ever matters.

const PASS_THROUGH_VIDEO = /^video\//;
const HEIC = /(^image\/heic$)|(^image\/heif$)|(\.heic$)|(\.heif$)/i;

export async function ensureJpeg(
  file: File,
  opts: { quality?: number; maxEdge?: number } = {}
): Promise<File> {
  if (PASS_THROUGH_VIDEO.test(file.type)) return file;
  if (file.type === "image/jpeg") return file;

  if (HEIC.test(file.type) || HEIC.test(file.name)) {
    throw new Error(
      "iPhone HEIC images can't be converted in the browser. Either:\n" +
        "• On iPhone: Settings → Camera → Formats → Most Compatible (captures as JPEG)\n" +
        "• Or open the file on your PC, export/save as JPEG, then upload."
    );
  }

  const img = await loadImage(file);
  const quality = opts.quality ?? 0.92;
  const maxEdge = opts.maxEdge ?? 1920; // Meta downscales > 1920 anyway

  // Optionally downscale very large images so the upload is faster.
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = longest > maxEdge ? maxEdge / longest : 1;
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable in this browser");

  // Flatten transparency over white — JPEG has no alpha channel.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", quality);
  });
  if (!blob) throw new Error("Failed to encode image as JPEG");

  const baseName = file.name.replace(/\.[^./\\]+$/, "") || "image";
  return new File([blob], `${baseName}.jpg`, {
    type: "image/jpeg",
    lastModified: Date.now(),
  });
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Couldn't read ${file.name} as an image`));
    };
    img.src = url;
  });
}
