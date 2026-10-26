// The logo QR (ADR-059) on a canvas, for the share dialog and the family invitation.
import { qrPlan, qrRaster } from '../../shared/qr';

/** About `width` px across, whole pixels a module. */
export function qrCanvas(text: string, width: number): HTMLCanvasElement {
  const scale = Math.max(1, Math.round(width / qrPlan(text).side));
  const { width: w, height: h, rgba } = qrRaster(text, scale);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')?.putImageData(new ImageData(rgba, w, h), 0, 0);
  return c;
}

export const qrDataUrl = (text: string, width: number) =>
  qrCanvas(text, width).toDataURL('image/png');
