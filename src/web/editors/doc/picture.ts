// A picture put into a document (ADR-051): made at most 1600 px wide and kept in the document
// itself as PNG or JPEG, the formats Word shows.
const MAX = 1600;

export async function pictureUrl(file: File): Promise<string> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX / bmp.width);
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  // Pictures that may be see-through stay PNG; photos become JPEG.
  const png = /png|gif|webp|svg/.test(file.type);
  return canvas.toDataURL(png ? 'image/png' : 'image/jpeg', 0.85);
}
