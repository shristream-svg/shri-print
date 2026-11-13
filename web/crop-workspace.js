import {
  applyCrop,
  canvasToBlob,
  clampCrop,
  detectFaces,
  faceBoxToCrop,
  PHOTO_ASPECT,
} from '../lib/photo.js';

// Crop and preview share coordinates in the already rotated source image.
export function createCropWorkspace() {
  const element = document.createElement('div');
  element.className = 'crop-workspace';
  const canvas = document.createElement('canvas');
  canvas.className = 'crop-canvas';
  canvas.style.touchAction = 'none';
  canvas.setAttribute('aria-label', 'Drag the frame to position your portrait');
  element.append(canvas);
  const ctx = canvas.getContext('2d');
  let original,
    source,
    crop,
    suggested,
    detectedCrop,
    scale = 1,
    zoomLevel = 1,
    rotation = 0,
    generation = 0,
    drag = null,
    callbacks = {};
  const status = (text, type = 'info') => {
    const e = document.querySelector('#crop-status');
    if (e) {
      e.textContent = text;
      e.className = 'crop-status ' + type;
    }
  };
  const centre = image => {
    const h = Math.min(image.height * 0.94, (image.width * 0.94) / PHOTO_ASPECT);
    return {
      x: (image.width - h * PHOTO_ASPECT) / 2,
      y: (image.height - h) / 2,
      width: h * PHOTO_ASPECT,
      height: h,
      rotation: 0,
    };
  };
  function changed() {
    drawPreview();
    callbacks.onCropChange?.(crop);
    status('Crop suggested · adjust and press Apply');
  }
  function drawPreview() {
    if (!source || !crop) return;
    const available = Math.max(200, Math.min(element.parentElement?.clientWidth || 560, 640));
    scale = Math.min(available / source.width, 400 / source.height, 1);
    canvas.width = Math.round(source.width * scale);
    canvas.height = Math.round(source.height * scale);
    canvas.style.width = canvas.width + 'px';
    canvas.style.height = canvas.height + 'px';
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    const x = crop.x * scale,
      y = crop.y * scale,
      w = crop.width * scale,
      h = crop.height * scale;
    ctx.fillStyle = 'rgba(7,18,33,.58)';
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    ctx.rect(x, y, w, h);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#35e0bd';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,.45)';
    ctx.lineWidth = 1;
    for (const t of [1 / 3, 2 / 3]) {
      ctx.beginPath();
      ctx.moveTo(x + w * t, y);
      ctx.lineTo(x + w * t, y + h);
      ctx.moveTo(x, y + h * t);
      ctx.lineTo(x + w, y + h * t);
      ctx.stroke();
    }
  }
  function rotateSource() {
    const c = document.createElement('canvas');
    const swap = rotation % 180 !== 0;
    c.width = swap ? original.height : original.width;
    c.height = swap ? original.width : original.height;
    const cx = c.getContext('2d');
    cx.translate(c.width / 2, c.height / 2);
    cx.rotate((rotation * Math.PI) / 180);
    cx.drawImage(original, -original.width / 2, -original.height / 2);
    source = c;
  }
  async function loadImage(file) {
    const ticket = ++generation;
    status('Loading photo and face detector…');
    const bitmap = await createImageBitmap(file);
    if (ticket !== generation) {
      bitmap.close();
      return;
    }
    original?.close?.();
    original = bitmap;
    rotation = 0;
    rotateSource();
    crop = centre(source);
    suggested = { ...crop };
    zoomLevel = 1;
    drawPreview();
    const result = await detectFaces(original);
    if (ticket !== generation) return;
    if (result.detections.length === 1) {
      crop = clampCrop(
        faceBoxToCrop(result.detections[0], source.width, source.height),
        source.width,
        source.height
      );
      suggested = { ...crop };
    }
    detectedCrop = { ...crop };
    callbacks.onCropChange?.(crop);
    drawPreview();
    status(
      result.unavailable
        ? 'Face detector unavailable · position manually, then Apply'
        : result.detections.length === 1
          ? 'Face detected · crop suggested · press Apply'
          : result.detections.length > 1
            ? 'Multiple faces · position the intended face, then Apply'
            : 'No face detected · position manually, then Apply',
      result.unavailable || result.detections.length !== 1 ? 'warning' : 'info'
    );
  }
  function zoom(value) {
    if (!source || !crop) return;
    zoomLevel = Math.max(1, Math.min(3, Number(value) || 1));
    const cx = crop.x + crop.width / 2,
      cy = crop.y + crop.height / 2;
    const h = suggested.height / zoomLevel;
    crop = clampCrop(
      { x: cx - (h * PHOTO_ASPECT) / 2, y: cy - h / 2, width: h * PHOTO_ASPECT, height: h },
      source.width,
      source.height
    );
    changed();
  }
  function rotate(delta) {
    if (!original) return;
    rotation = (((rotation + delta) % 360) + 360) % 360;
    rotateSource();
    crop = rotation === 0 && detectedCrop ? { ...detectedCrop } : centre(source);
    suggested = { ...crop };
    zoomLevel = 1;
    changed();
  }
  function point(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) * canvas.width) / r.width / scale,
      y: ((e.clientY - r.top) * canvas.height) / r.height / scale,
    };
  }
  canvas.addEventListener('pointerdown', e => {
    if (!crop) return;
    e.preventDefault();
    drag = { point: point(e), crop: { ...crop } };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag) return;
    const p = point(e);
    crop = clampCrop(
      { ...drag.crop, x: drag.crop.x + p.x - drag.point.x, y: drag.crop.y + p.y - drag.point.y },
      source.width,
      source.height
    );
    changed();
  });
  for (const event of ['pointerup', 'pointercancel'])
    canvas.addEventListener(event, () => (drag = null));
  return {
    element,
    loadImage,
    drawPreview,
    getCrop: () => crop,
    getZoom: () => zoomLevel,
    zoom,
    resetZoom: () => zoom(1),
    rotate,
    reset() {
      if (!original) return;
      rotation = 0;
      rotateSource();
      crop = detectedCrop ? { ...detectedCrop } : centre(source);
      suggested = { ...crop };
      zoomLevel = 1;
      changed();
    },
    setCallbacks(c) {
      callbacks = c || {};
    },
    async getCroppedBlob() {
      if (!source || !crop) throw Error('Choose a photo first.');
      return canvasToBlob(await applyCrop(source, { ...crop, rotation: 0 }, 0));
    },
    destroy() {
      generation++;
      original?.close?.();
      original = source = crop = null;
      element.remove();
    },
  };
}
