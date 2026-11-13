// Local image worker. No network requests or customer data leave this browser.
import {
  calculateOutputSize,
  detectDocumentPixels,
  ID_CARD_FORMATS,
  warpImageData,
} from '../lib/id-card.js';

async function sourceFromFile(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(
      Math.max(2, Math.round(bitmap.width * scale)),
      Math.max(2, Math.round(bitmap.height * scale))
    );
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    bitmap.close();
  }
}
function detection(source, format) {
  const scale = Math.min(1, 640 / Math.max(source.width, source.height));
  const small = new OffscreenCanvas(
    Math.max(2, Math.round(source.width * scale)),
    Math.max(2, Math.round(source.height * scale))
  );
  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, small.width, small.height);
  const found = detectDocumentPixels(ctx.getImageData(0, 0, small.width, small.height), { format });
  const corners =
    found.method === 'already-cropped'
      ? [
          { x: 0, y: 0 },
          { x: source.width - 1, y: 0 },
          { x: source.width - 1, y: source.height - 1 },
          { x: 0, y: source.height - 1 },
        ]
      : found.corners?.map(p => ({
          x: (p.x * source.width) / small.width,
          y: (p.y * source.height) / small.height,
        })) || null;
  return { ...found, corners };
}
async function correction(image, corners, format) {
  const size = calculateOutputSize(
    corners,
    format === 'paper' ? ID_CARD_FORMATS.paper : ID_CARD_FORMATS.generic
  );
  const out = warpImageData(image, corners, size.width, size.height);
  let canvas = new OffscreenCanvas(out.width, out.height);
  canvas.getContext('2d').putImageData(new ImageData(out.data, out.width, out.height), 0, 0);
  let rotation = 0;
  if (format !== 'paper' && out.height > out.width) {
    const landscape = new OffscreenCanvas(out.height, out.width),
      ctx = landscape.getContext('2d');
    ctx.translate(out.height, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(canvas, 0, 0);
    canvas = landscape;
    rotation = 90;
  }
  return { blob: await canvas.convertToBlob({ type: 'image/png' }), rotation };
}
self.onmessage = async event => {
  const request = event.data;
  try {
    if (request.action === 'correct') {
      const result = await correction(request.image, request.corners, request.format);
      self.postMessage({ ok: true, ...result });
      return;
    }
    let source;
    if (request.file) source = await sourceFromFile(request.file);
    else {
      source = new OffscreenCanvas(request.image.width, request.image.height);
      source
        .getContext('2d')
        .putImageData(
          new ImageData(request.image.data, request.image.width, request.image.height),
          0,
          0
        );
    }
    const found = detection(source, request.format);
    if (request.action === 'auto' && found.corners && found.confidence >= 0.85) {
      const image = source
        .getContext('2d', { willReadFrequently: true })
        .getImageData(0, 0, source.width, source.height);
      const result = await correction(image, found.corners, request.format);
      self.postMessage({ ok: true, ...found, ...result });
    } else self.postMessage({ ok: true, ...found });
  } catch (error) {
    self.postMessage({ ok: false, error: error.message || 'Image processing unavailable.' });
  }
};
