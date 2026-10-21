// Image thumbnails off the main thread: decode → scale to ≤ 320 px → WebP (SPEC §5.2).
const MAX = 320;

self.onmessage = async (e: MessageEvent<{ id: string; file: File }>) => {
  const { id, file } = e.data;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.75 });
    self.postMessage({ id, blob: blob.type === 'image/webp' ? blob : null });
  } catch {
    self.postMessage({ id, blob: null });
  }
};
