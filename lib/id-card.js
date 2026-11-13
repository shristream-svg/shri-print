// Local-only document geometry. Detection is a suggestion; the operator confirms corners.
export const ID_CARD_FORMATS = {
  aadhaar: { width: 85.6, height: 54, name: 'Aadhaar PVC card' },
  pan: { width: 85.6, height: 54, name: 'PAN / standard card' },
  voter: { width: 85.6, height: 54, name: 'Voter ID card' },
  driving: { width: 85.6, height: 54, name: 'Driving licence card' },
  generic: { width: 85.6, height: 54, name: 'Standard ID card' },
  paper: { width: null, height: null, name: 'Paper Aadhaar / preserve proportions' },
};
export const DEFAULT_FORMAT = ID_CARD_FORMATS.aadhaar;
export const mmToPx = (mm, dpi = 300) => Math.round((mm * dpi) / 25.4);
export const pxToMm = (px, dpi = 300) => (px * 25.4) / dpi;
const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const area = p =>
  Math.abs(
    p.reduce((s, a, i) => {
      const b = p[(i + 1) % p.length];
      return s + a.x * b.y - b.x * a.y;
    }, 0)
  ) / 2;
export function orderCorners(points) {
  if (
    !Array.isArray(points) ||
    points.length !== 4 ||
    points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))
  )
    return null;
  const cx = points.reduce((s, p) => s + p.x, 0) / 4,
    cy = points.reduce((s, p) => s + p.y, 0) / 4;
  const p = points
    .map(p => ({ ...p }))
    .sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let start = 0;
  for (let i = 1; i < 4; i++) if (p[i].x + p[i].y < p[start].x + p[start].y) start = i;
  return [...p.slice(start), ...p.slice(0, start)];
}
export function validateCorners(points, width, height) {
  const p = orderCorners(points);
  if (!p) return { valid: false, reason: 'Set four finite corners.' };
  if (p.some(c => c.x < 0 || c.y < 0 || c.x > width || c.y > height))
    return { valid: false, reason: 'Keep corners inside the image.' };
  const turns = p.map((a, i) => cross(a, p[(i + 1) % 4], p[(i + 2) % 4]));
  if (turns.some(t => t <= 0.001) || area(p) < Math.max(16, width * height * 0.0001))
    return { valid: false, reason: 'Corners must enclose a clear, convex document.' };
  if (p.some((a, i) => Math.hypot(a.x - p[(i + 1) % 4].x, a.y - p[(i + 1) % 4].y) < 2))
    return { valid: false, reason: 'Move corners farther apart.' };
  return { valid: true, ordered: p, coverage: area(p) / (width * height) };
}
export function calculateOutputSize(points, format = DEFAULT_FORMAT) {
  const p = orderCorners(points);
  if (!p) throw Error('Four corners required.');
  const w =
    (Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) + Math.hypot(p[2].x - p[3].x, p[2].y - p[3].y)) /
    2;
  const h =
    (Math.hypot(p[3].x - p[0].x, p[3].y - p[0].y) + Math.hypot(p[2].x - p[1].x, p[2].y - p[1].y)) /
    2;
  // A 90-degree phone photo must not be squeezed into a landscape card.
  const ratio =
    format.width && format.height
      ? w < h
        ? format.height / format.width
        : format.width / format.height
      : w / h;
  // Source resolution is retained up to a bounded 1800px output; no claimed detail enhancement.
  const outW = Math.max(w, h * ratio),
    outH = outW / ratio;
  const scale = Math.min(1, 1800 / Math.max(outW, outH));
  return {
    width: Math.max(2, Math.round(outW * scale)),
    height: Math.max(2, Math.round(outH * scale)),
  };
}
function solve(a, b) {
  const n = b.length,
    m = a.map((r, i) => [...r, b[i]]);
  for (let k = 0; k < n; k++) {
    let pivot = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(m[i][k]) > Math.abs(m[pivot][k])) pivot = i;
    if (Math.abs(m[pivot][k]) < 1e-10) throw Error('Corners cannot form a perspective transform.');
    [m[k], m[pivot]] = [m[pivot], m[k]];
    const div = m[k][k];
    for (let j = k; j <= n; j++) m[k][j] /= div;
    for (let i = 0; i < n; i++)
      if (i !== k) {
        const f = m[i][k];
        for (let j = k; j <= n; j++) m[i][j] -= f * m[k][j];
      }
  }
  return m.map(r => r[n]);
}
export function homography(from, to) {
  const a = [],
    b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i],
      { x: u, y: v } = to[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  return [...solve(a, b), 1];
}
export function transformPoint(h, x, y) {
  const d = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / d, y: (h[3] * x + h[4] * y + h[5]) / d };
}
export function warpImageData(image, points, width, height) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    width * height > 4000000
  )
    throw Error('Invalid output size.');
  const validation = validateCorners(points, image.width, image.height);
  if (!validation.valid) throw Error(validation.reason);
  const source = validation.ordered;
  const inverse = homography(
    [
      { x: 0, y: 0 },
      { x: width - 1, y: 0 },
      { x: width - 1, y: height - 1 },
      { x: 0, y: height - 1 },
    ],
    source
  );
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const denominator = inverse[6] * x + inverse[7] * y + inverse[8];
      const sx = Math.max(
          0,
          Math.min(image.width - 1, (inverse[0] * x + inverse[1] * y + inverse[2]) / denominator)
        ),
        sy = Math.max(
          0,
          Math.min(image.height - 1, (inverse[3] * x + inverse[4] * y + inverse[5]) / denominator)
        );
      const x0 = Math.floor(sx),
        y0 = Math.floor(sy),
        x1 = Math.min(image.width - 1, x0 + 1),
        y1 = Math.min(image.height - 1, y0 + 1),
        fx = sx - x0,
        fy = sy - y0,
        di = (y * width + x) * 4;
      const i0 = (y0 * image.width + x0) * 4,
        i1 = (y0 * image.width + x1) * 4,
        i2 = (y1 * image.width + x0) * 4,
        i3 = (y1 * image.width + x1) * 4;
      const a0 = (image.data[i0 + 3] / 255) * (1 - fx) * (1 - fy),
        a1 = (image.data[i1 + 3] / 255) * fx * (1 - fy),
        a2 = (image.data[i2 + 3] / 255) * (1 - fx) * fy,
        a3 = (image.data[i3 + 3] / 255) * fx * fy,
        white = 255 * (1 - a0 - a1 - a2 - a3);
      for (let c = 0; c < 3; c++) {
        data[di + c] =
          image.data[i0 + c] * a0 +
          image.data[i1 + c] * a1 +
          image.data[i2 + c] * a2 +
          image.data[i3 + c] * a3 +
          white;
      }
      data[di + 3] = 255;
    }
  return { data, width, height };
}
export function createCorrectedImage(source, points, width, height) {
  const ctx = source.getContext?.('2d');
  let input;
  if (ctx) input = ctx.getImageData(0, 0, source.width, source.height);
  else {
    const c = document.createElement('canvas');
    c.width = source.width;
    c.height = source.height;
    const cx = c.getContext('2d');
    cx.drawImage(source, 0, 0);
    input = cx.getImageData(0, 0, c.width, c.height);
  }
  const out = warpImageData(input, points, width, height),
    canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(out.data, width, height), 0, 0);
  return canvas;
}
function hull(points) {
  const sorted = points.sort((a, b) => a.x - b.x || a.y - b.y),
    lo = [],
    hi = [];
  for (const p of sorted) {
    while (lo.length > 1 && cross(lo.at(-2), lo.at(-1), p) <= 0) lo.pop();
    lo.push(p);
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (hi.length > 1 && cross(hi.at(-2), hi.at(-1), p) <= 0) hi.pop();
    hi.push(p);
  }
  lo.pop();
  hi.pop();
  return lo.concat(hi);
}
function quad(points) {
  const p = hull(points);
  while (p.length > 4) {
    let k = 0,
      v = Infinity;
    for (let i = 0; i < p.length; i++) {
      const loss = Math.abs(cross(p[(i + p.length - 1) % p.length], p[i], p[(i + 1) % p.length]));
      if (loss < v) {
        v = loss;
        k = i;
      }
    }
    p.splice(k, 1);
  }
  return p.length === 4 ? orderCorners(p) : null;
}
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
function grayImage(image, divisor = 1) {
  const width = Math.max(2, Math.round(image.width / divisor)),
    height = Math.max(2, Math.round(image.height / divisor)),
    gray = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let value = 0,
        count = 0;
      for (let dy = 0; dy < divisor; dy++)
        for (let dx = 0; dx < divisor; dx++) {
          const sx = Math.min(image.width - 1, x * divisor + dx),
            sy = Math.min(image.height - 1, y * divisor + dy),
            i = (sy * image.width + sx) * 4;
          value +=
            (0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2]) *
              (image.data[i + 3] / 255) +
            255 * (1 - image.data[i + 3] / 255);
          count++;
        }
      gray[y * width + x] = value / count;
    }
  return { gray, width, height };
}
function sample(gray, w, h, x, y) {
  return gray[clamp(Math.round(y), 0, h - 1) * w + clamp(Math.round(x), 0, w - 1)];
}
function sideEvidence(points, gray, w, h) {
  const supports = [],
    contrasts = [],
    signs = [];
  let allPositive = 0,
    allSupported = 0;
  for (let side = 0; side < 4; side++) {
    const a = points[side],
      b = points[(side + 1) % 4],
      dx = b.x - a.x,
      dy = b.y - a.y,
      length = Math.hypot(dx, dy);
    const nx = -dy / length,
      ny = dx / length,
      steps = clamp(Math.round(length / 3), 16, 80);
    let supported = 0,
      totalContrast = 0,
      positive = 0,
      negative = 0;
    for (let j = 0; j < steps; j++) {
      const t = 0.07 + (0.86 * (j + 0.5)) / steps,
        x = a.x + dx * t,
        y = a.y + dy * t;
      let best = 0;
      // Allow a small localisation error while requiring contrast along the whole side.
      for (let offset = -1; offset <= 1; offset++) {
        const inside = sample(gray, w, h, x + nx * (3 + offset), y + ny * (3 + offset));
        const outside = sample(gray, w, h, x - nx * (3 - offset), y - ny * (3 - offset));
        const d = inside - outside;
        if (Math.abs(d) > Math.abs(best)) best = d;
      }
      if (Math.abs(best) >= 5) {
        supported++;
        best > 0 ? positive++ : negative++;
      }
      totalContrast += Math.abs(best);
    }
    supports.push(supported / steps);
    contrasts.push(totalContrast / steps);
    signs.push(Math.max(positive, negative) / Math.max(1, supported));
    allPositive += positive;
    allSupported += supported;
  }
  return {
    support: supports.reduce((s, n) => s + n, 0) / 4,
    minSupport: Math.min(...supports),
    contrast: contrasts.reduce((s, n) => s + n, 0) / 4,
    polarity: Math.min(...signs),
    lighterInside: allPositive / Math.max(1, allSupported),
  };
}
function geometry(points, w, h, format) {
  const valid = validateCorners(points, w, h);
  if (!valid.valid) return null;
  const lengths = points.map((a, i) =>
    Math.hypot(a.x - points[(i + 1) % 4].x, a.y - points[(i + 1) % 4].y)
  );
  if (Math.min(...lengths) < 12 || valid.coverage < 0.09 || valid.coverage > 0.96) return null;
  const ratio = (lengths[0] + lengths[2]) / (lengths[1] + lengths[3]),
    longRatio = Math.max(ratio, 1 / ratio);
  if (format !== 'paper' && (longRatio < 1.17 || longRatio > 2.25)) return null;
  if (format === 'paper' && (longRatio < 1.1 || longRatio > 4)) return null;
  if (
    Math.min(lengths[0], lengths[2]) / Math.max(lengths[0], lengths[2]) < 0.45 ||
    Math.min(lengths[1], lengths[3]) / Math.max(lengths[1], lengths[3]) < 0.45
  )
    return null;
  const angles = points.map((p, i) => {
    const a = points[(i + 3) % 4],
      b = points[(i + 1) % 4];
    return Math.abs(
      ((a.x - p.x) * (b.x - p.x) + (a.y - p.y) * (b.y - p.y)) /
        (Math.hypot(a.x - p.x, a.y - p.y) * Math.hypot(b.x - p.x, b.y - p.y))
    );
  });
  if (Math.max(...angles) > 0.78) return null;
  return {
    ...valid,
    aspect:
      format === 'paper' ? 1 : clamp(1 - Math.abs(Math.log(longRatio / (85.6 / 54))) / 0.5, 0, 1),
    longRatio,
  };
}
function lineThrough(points) {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length,
    cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  let xx = 0,
    xy = 0,
    yy = 0;
  for (const p of points) {
    xx += (p.x - cx) ** 2;
    xy += (p.x - cx) * (p.y - cy);
    yy += (p.y - cy) ** 2;
  }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy),
    nx = -Math.sin(angle),
    ny = Math.cos(angle);
  return { nx, ny, c: nx * cx + ny * cy };
}
function refineSides(points, boundary) {
  const lines = [];
  for (let i = 0; i < 4; i++) {
    const a = points[i],
      b = points[(i + 1) % 4],
      dx = b.x - a.x,
      dy = b.y - a.y,
      l = Math.hypot(dx, dy),
      near = [];
    for (const p of boundary) {
      const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (l * l),
        distance = Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / l;
      if (t > 0.08 && t < 0.92 && distance < 2.4) near.push(p);
    }
    if (near.length < 8) return points;
    lines.push(lineThrough(near));
  }
  const result = [];
  for (let i = 0; i < 4; i++) {
    const a = lines[(i + 3) % 4],
      b = lines[i],
      det = a.nx * b.ny - b.nx * a.ny;
    if (Math.abs(det) < 0.15) return points;
    const p = { x: (a.c * b.ny - b.c * a.ny) / det, y: (a.nx * b.c - b.nx * a.c) / det };
    if (Math.hypot(p.x - points[i].x, p.y - points[i].y) > 6) return points;
    result.push(p);
  }
  return result;
}
function components(mask, w, h, isEdge, visit) {
  const seen = new Uint8Array(mask.length),
    queue = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let head = 0,
      tail = 1,
      touches = false;
    queue[0] = start;
    seen[start] = 1;
    while (head < tail) {
      const i = queue[head++],
        x = i % w,
        y = Math.floor(i / w);
      if (x <= 1 || y <= 1 || x >= w - 2 || y >= h - 2) touches = true;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!isEdge && dx && dy) continue;
          const nx = x + dx,
            ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const j = ny * w + nx;
          if (mask[j] && !seen[j]) {
            seen[j] = 1;
            queue[tail++] = j;
          }
        }
    }
    if (touches || tail < (isEdge ? 35 : w * h * 0.06)) continue;
    const boundary = [];
    for (let q = 0; q < tail; q++) {
      const i = queue[q],
        x = i % w,
        y = Math.floor(i / w);
      if (isEdge || !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w])
        boundary.push({ x, y });
    }
    if (boundary.length > 12000) {
      const step = Math.ceil(boundary.length / 12000);
      visit(
        boundary.filter((_, i) => i % step === 0),
        tail
      );
    } else visit(boundary, tail);
  }
}
function candidatesAtScale(image, divisor, format) {
  const { gray, width: w, height: h } = grayImage(image, divisor),
    candidates = [],
    hist = new Uint32Array(256),
    magnitude = new Float32Array(gray.length);
  for (const n of gray) hist[clamp(Math.round(n), 0, 255)]++;
  let max = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x,
        gx =
          -gray[i - w - 1] +
          gray[i - w + 1] -
          2 * gray[i - 1] +
          2 * gray[i + 1] -
          gray[i + w - 1] +
          gray[i + w + 1],
        gy =
          -gray[i - w - 1] -
          2 * gray[i - w] -
          gray[i - w + 1] +
          gray[i + w - 1] +
          2 * gray[i + w] +
          gray[i + w + 1];
      magnitude[i] = Math.hypot(gx, gy);
      max = Math.max(max, magnitude[i]);
    }
  const add = (boundary, count, method) => {
    const originalQuad = quad(boundary);
    if (!originalQuad) return;
    const points = refineSides(originalQuad, boundary);
    const shape = geometry(points, w, h, format);
    if (!shape) return;
    if (points.some(p => p.x < 2 || p.y < 2 || p.x > w - 3 || p.y > h - 3)) return;
    const hullArea = area(hull(boundary));
    if (area(points) / hullArea < 0.8) return;
    if (method === 'foreground' && count / Math.max(1, area(points)) < 0.65) return;
    const evidence = sideEvidence(points, gray, w, h);
    if (evidence.support < 0.47 || evidence.minSupport < 0.32 || evidence.polarity < 0.6) return;
    candidates.push({
      corners: points.map(p => ({ x: p.x * divisor, y: p.y * divisor })),
      coverage: shape.coverage,
      aspect: shape.aspect,
      ...evidence,
      method,
    });
  };
  // Relative thresholds alone miss a faint card border when its QR has black edges.
  const edgeThresholds = [12, 28, Math.max(45, max * 0.09), Math.max(80, max * 0.22)];
  for (const threshold of [...new Set(edgeThresholds.map(Math.round))]) {
    const mask = Uint8Array.from(magnitude, n => (n >= threshold ? 1 : 0));
    components(mask, w, h, true, (p, n) => add(p, n, 'edges'));
  }
  const levels = [];
  for (let value = 0; value < 256; value++) if (hist[value]) levels.push(value);
  // Midpoints between dominant tones plus evenly spaced percentiles recover shadowed/weak outlines.
  const peaks = levels
      .filter(v => hist[v] > gray.length * 0.008)
      .sort((a, b) => hist[b] - hist[a])
      .slice(0, 8)
      .sort((a, b) => a - b),
    thresholds = [];
  for (let i = 1; i < peaks.length; i++)
    if (peaks[i] - peaks[i - 1] >= 5) thresholds.push((peaks[i] + peaks[i - 1]) / 2);
  for (const percentile of [0.15, 0.35, 0.55, 0.75, 0.9]) {
    let total = 0;
    for (let value = 0; value < 256; value++) {
      total += hist[value];
      if (total >= gray.length * percentile) {
        thresholds.push(value - 4, value + 4);
        break;
      }
    }
  }
  const selected = [...new Set(thresholds.map(n => clamp(Math.round(n), 2, 253)))].slice(0, 14);
  for (const threshold of selected)
    for (const bright of [true, false]) {
      const mask = Uint8Array.from(gray, n => ((bright ? n > threshold : n < threshold) ? 1 : 0));
      components(mask, w, h, false, (p, n) => add(p, n, 'foreground'));
    }
  return candidates;
}
function padded(points, w, h) {
  const cx = points.reduce((s, p) => s + p.x, 0) / 4,
    cy = points.reduce((s, p) => s + p.y, 0) / 4;
  return points.map(p => {
    const length = Math.hypot(p.x - cx, p.y - cy),
      factor = 1 + 1.4 / Math.max(1, length);
    return {
      x: clamp(cx + (p.x - cx) * factor, 0, w - 1),
      y: clamp(cy + (p.y - cy) * factor, 0, h - 1),
    };
  });
}
function fullFrameCandidate(image, format) {
  if (format === 'paper') return null;
  const { width: w, height: h, data } = image,
    ratio = Math.max(w / h, h / w);
  if (Math.abs(ratio / (85.6 / 54) - 1) > 0.045) return null;
  let min = 255,
    max = 0;
  const perimeter = [];
  for (let i = 0; i < data.length; i += 4) {
    const v = (data[i] + data[i + 1] + data[i + 2]) / 3;
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  if (max - min < 30) return null;
  for (let x = 0; x < w; x += Math.max(1, Math.floor(w / 80))) {
    perimeter.push((data[x * 4] + data[x * 4 + 1] + data[x * 4 + 2]) / 3);
    const j = ((h - 1) * w + x) * 4;
    perimeter.push((data[j] + data[j + 1] + data[j + 2]) / 3);
  }
  for (let y = 0; y < h; y += Math.max(1, Math.floor(h / 80))) {
    let j = y * w * 4;
    perimeter.push((data[j] + data[j + 1] + data[j + 2]) / 3);
    j = (y * w + w - 1) * 4;
    perimeter.push((data[j] + data[j + 1] + data[j + 2]) / 3);
  }
  perimeter.sort((a, b) => a - b);
  const spread =
    perimeter[Math.floor(perimeter.length * 0.9)] - perimeter[Math.floor(perimeter.length * 0.1)];
  if (spread > 8 || perimeter[Math.floor(perimeter.length * 0.5)] < 150) return null;
  return {
    corners: [
      { x: 0, y: 0 },
      { x: w - 1, y: 0 },
      { x: w - 1, y: h - 1 },
      { x: 0, y: h - 1 },
    ],
    confidence: 0.86,
    method: 'already-cropped',
    reason:
      'Card-shaped image retained in full. Check its orientation and final PDF; no edges were removed.',
  };
}
export function detectDocumentPixels(image, { format = 'plastic' } = {}) {
  const { width: w, height: h, data } = image;
  if (
    !Number.isInteger(w) ||
    !Number.isInteger(h) ||
    w < 8 ||
    h < 8 ||
    w > 640 ||
    h > 640 ||
    w * h > 640 * 640 ||
    data?.length !== w * h * 4
  )
    throw Error('Detection input must be downsampled to at most 640×640 pixels.');
  let low = 255,
    high = 0;
  for (let i = 0; i < data.length; i += 4) {
    const v = (data[i] + data[i + 1] + data[i + 2]) / 3;
    low = Math.min(low, v);
    high = Math.max(high, v);
  }
  if (high - low < 4)
    return {
      corners: null,
      confidence: 0,
      method: 'manual',
      reason: 'Low contrast or blank image. Position the card corners manually.',
    };
  const candidates = [
    ...candidatesAtScale(image, 1, format),
    ...(Math.min(w, h) >= 100 ? candidatesAtScale(image, 2, format) : []),
  ];
  const groups = [];
  for (const candidate of candidates) {
    const match = groups.find(
      g =>
        Math.abs(g.coverage - candidate.coverage) < 0.07 &&
        g.corners.every(
          (p, i) =>
            Math.hypot(p.x - candidate.corners[i].x, p.y - candidate.corners[i].y) <
            Math.max(6, Math.sqrt(w * h) * 0.025)
        )
    );
    if (match) {
      match.votes++;
      if (candidate.minSupport + candidate.support > match.minSupport + match.support)
        Object.assign(match, { ...candidate, votes: match.votes });
    } else groups.push({ ...candidate, votes: 1 });
  }
  for (const group of groups) {
    group.confidence = Math.min(
      0.97,
      0.43 +
        0.22 * group.support +
        0.1 * group.minSupport +
        0.06 * group.aspect +
        0.05 * clamp(group.coverage / 0.5, 0, 1) +
        0.06 * clamp(group.contrast / 25, 0, 1) +
        0.05 * clamp((group.votes - 1) / 3, 0, 1)
    );
    if (
      group.minSupport < 0.65 ||
      group.polarity < 0.8 ||
      group.coverage < 0.15 ||
      group.lighterInside < 0.7
    )
      group.confidence = Math.min(0.81, group.confidence);
    group.score = group.confidence + 0.18 * Math.sqrt(group.coverage);
  }
  groups.sort((a, b) => b.score - a.score);
  const top = groups[0];
  const fullFrame = fullFrameCandidate(image, format);
  if (fullFrame && (!top || top.coverage > 0.87 || top.confidence < 0.85)) return fullFrame;
  if (!top)
    return {
      corners: null,
      confidence: 0,
      method: 'manual',
      reason:
        'Complete document edges not found. Low contrast, clipping or clutter may need manual corners.',
    };
  const centre = points => ({
    x: points.reduce((s, p) => s + p.x, 0) / 4,
    y: points.reduce((s, p) => s + p.y, 0) / 4,
  });
  const competitor = groups.find(
    (g, i) =>
      i &&
      g.confidence >= 0.75 &&
      g.coverage > top.coverage * 0.45 &&
      !inside(centre(g.corners), top.corners) &&
      !inside(centre(top.corners), g.corners)
  );
  if (competitor)
    return {
      corners: null,
      confidence: 0,
      method: 'ambiguous',
      reason: 'Multiple possible documents found; select the intended card manually.',
    };
  // Prefer enclosing outer edges over nested pictures/QR boxes even if the border is fainter.
  const enclosing = groups.find(
    g =>
      g !== top && g.coverage > top.coverage * 1.35 && top.corners.every(p => inside(p, g.corners))
  );
  if (enclosing)
    return {
      corners: padded(enclosing.corners, w, h),
      confidence: Math.min(0.8, enclosing.confidence),
      method: 'uncertain-outer-border',
      reason: 'Outer and inner boundaries disagree. Check the full card manually.',
    };
  return {
    corners: padded(top.corners, w, h),
    confidence: top.confidence,
    method: 'multi-threshold-quad',
    metrics: {
      edgeSupport: top.support,
      minSideSupport: top.minSupport,
      contrast: top.contrast,
      coverage: top.coverage,
      observations: top.votes,
    },
    reason:
      top.confidence >= 0.85
        ? 'Complete four-sided card boundary found. Check the final PDF and orientation.'
        : 'A boundary was suggested with limited confidence. Check all four corners manually.',
  };
}
function inside(p, poly) {
  let yes = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      yes = !yes;
  }
  return yes;
}
export async function detectDocumentEdges(source, options = {}) {
  if (source.data instanceof Uint8ClampedArray) return detectDocumentPixels(source, options);
  const scale = Math.min(1, 640 / Math.max(source.width, source.height)),
    canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(source.width * scale));
  canvas.height = Math.max(2, Math.round(source.height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const result = detectDocumentPixels(ctx.getImageData(0, 0, canvas.width, canvas.height), options);
  return {
    ...result,
    corners:
      result.corners?.map(p => ({
        x: (p.x * source.width) / canvas.width,
        y: (p.y * source.height) / canvas.height,
      })) || null,
  };
}
// Public compatibility name used by the ID workspace.
export const rectifyImageData = warpImageData;
