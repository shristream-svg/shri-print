export const PHOTO_ASPECT = 35 / 45;
export const PHOTO_MM = { width: 35, height: 45 };
export const FACE_DETECTOR_VERSION = '0.10.3';

let faceDetectorInstance = null;
let faceDetectorUnavailable = false;

async function loadFaceDetector() {
  if (faceDetectorUnavailable) return { detector: null, unavailable: true };
  if (faceDetectorInstance) return { detector: faceDetectorInstance, unavailable: false };

  try {
    const { FilesetResolver, FaceDetector } = await import(
      `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${FACE_DETECTOR_VERSION}`
    );
    const wasmRoot = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${FACE_DETECTOR_VERSION}/wasm`;
    const vision = await FilesetResolver.forVisionTasks(wasmRoot);
    const detector = await FaceDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite`,
        delegate: 'GPU',
      },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.5,
    });
    faceDetectorInstance = detector;
    return { detector, unavailable: false };
  } catch (e) {
    faceDetectorUnavailable = true;
    console.warn('Face detector unavailable:', e.message);
    return { detector: null, unavailable: true };
  }
}

export async function detectFaces(imageBitmap) {
  const { detector, unavailable } = await loadFaceDetector();
  if (unavailable || !detector) return { detections: [], unavailable: true };
  try {
    const result = detector.detect(imageBitmap);
    return { detections: result.detections || [], unavailable: false };
  } catch (e) {
    console.warn('Face detection failed:', e.message);
    return { detections: [], unavailable: true };
  }
}

export function releaseFaceDetector() {
  if (faceDetectorInstance) {
    faceDetectorInstance = null;
  }
}

export function faceBoxToCrop(detection, imageWidth, imageHeight) {
  const box = detection.boundingBox;
  const cx = box.originX + box.width / 2;
  const _cy = box.originY + box.height / 2;
  const headTop = box.originY;
  const faceHeight = box.height;

  const marginTop = faceHeight * 0.4;
  const cropHeight = Math.min(faceHeight * 2.2, imageHeight * 0.9);
  const cropWidth = cropHeight * PHOTO_ASPECT;

  if (cropWidth > imageWidth) {
    const scale = imageWidth / cropWidth;
    return {
      x: 0,
      y: Math.max(0, Math.min(imageHeight - cropHeight * scale, headTop - marginTop * scale)),
      width: imageWidth,
      height: cropHeight * scale,
      rotation: 0,
    };
  }

  let x = cx - cropWidth / 2;
  let y = headTop - marginTop;

  x = Math.max(0, Math.min(imageWidth - cropWidth, x));
  y = Math.max(0, Math.min(imageHeight - cropHeight, y));

  return { x, y, width: cropWidth, height: cropHeight, rotation: 0 };
}

export function clampCrop(crop, imageWidth, imageHeight) {
  const { x: _x, y: _y, width: _width, height: _height, rotation = 0 } = crop;
  let x = _x,
    y = _y,
    width = _width,
    height = _height;

  const targetAspect = PHOTO_ASPECT;
  const currentAspect = width / height;

  if (Math.abs(currentAspect - targetAspect) > 0.001) {
    if (currentAspect > targetAspect) {
      width = height * targetAspect;
    } else {
      height = width / targetAspect;
    }
  }

  if (width > imageWidth || height > imageHeight) {
    const scale = Math.min(imageWidth / width, imageHeight / height);
    width *= scale;
    height *= scale;
  }

  x = Math.max(0, Math.min(imageWidth - width, x));
  y = Math.max(0, Math.min(imageHeight - height, y));

  return { x, y, width, height, rotation };
}

function rotateImageBitmap(imageBitmap, rotation) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const w = imageBitmap.width;
  const h = imageBitmap.height;
  const newW = Math.abs(w * cos) + Math.abs(h * sin);
  const newH = Math.abs(w * sin) + Math.abs(h * cos);
  canvas.width = Math.round(newW);
  canvas.height = Math.round(newH);
  ctx.translate(newW / 2, newH / 2);
  ctx.rotate(rad);
  ctx.drawImage(imageBitmap, -w / 2, -h / 2, w, h);
  return canvas;
}

export async function applyCrop(imageBitmap, crop, sourceRotation = 0) {
  const { x, y, width, height, rotation = 0 } = crop;

  // First apply source rotation
  let sourceBitmap = imageBitmap;
  if (sourceRotation !== 0) {
    const canvas = rotateImageBitmap(imageBitmap, sourceRotation);
    sourceBitmap = await createImageBitmap(canvas);
  }

  // Then apply crop rotation if any
  if (rotation !== 0) {
    const canvas = rotateImageBitmap(sourceBitmap, rotation);
    sourceBitmap = await createImageBitmap(canvas);
  }

  const canvas = document.createElement('canvas');
  canvas.width = 700;
  canvas.height = 900;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.drawImage(sourceBitmap, x, y, width, height, 0, 0, canvas.width, canvas.height);

  return canvas;
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.92) {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

export function calculatePreviewCrop(crop, previewWidth, previewHeight, imageWidth, imageHeight) {
  const scale = Math.min(previewWidth / imageWidth, previewHeight / imageHeight);
  return {
    x: crop.x * scale,
    y: crop.y * scale,
    width: crop.width * scale,
    height: crop.height * scale,
    rotation: crop.rotation || 0,
  };
}
