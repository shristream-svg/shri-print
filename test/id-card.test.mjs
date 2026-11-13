import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateOutputSize,
  detectDocumentPixels,
  homography,
  ID_CARD_FORMATS,
  transformPoint,
  validateCorners,
  warpImageData,
} from '../lib/id-card.js';
const polygon = [
  { x: 42, y: 35 },
  { x: 235, y: 58 },
  { x: 217, y: 160 },
  { x: 26, y: 142 },
];
const inside = (x, y, p) => {
  let yes = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const a = p[i],
      b = p[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) yes = !yes;
  }
  return yes;
};
function fixture(polygons = [polygon]) {
  const width = 280,
    height = 200,
    data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4,
        c = polygons.some(p => inside(x, y, p)) ? 240 : 35;
      data[i] = data[i + 1] = data[i + 2] = c;
      data[i + 3] = 255;
    }
  return { width, height, data };
}
test('detect tilted perspective card boundaries without assuming axis-aligned box', () => {
  const r = detectDocumentPixels(fixture());
  assert.ok(r.confidence > 0.6, r.reason);
  r.corners.forEach((p, i) =>
    assert.ok(Math.hypot(p.x - polygon[i].x, p.y - polygon[i].y) < 6, JSON.stringify(r))
  );
});
test('uniform/lowcontrast images honestly require manual positioning', () => {
  const f = fixture([]),
    r = detectDocumentPixels(f);
  assert.equal(r.corners, null);
  assert.equal(r.confidence, 0);
});
test('separate similarly-sized cards are ambiguous', () => {
  const a = [
      { x: 15, y: 35 },
      { x: 120, y: 35 },
      { x: 120, y: 110 },
      { x: 15, y: 110 },
    ],
    b = a.map(p => ({ x: p.x + 140, y: p.y + 30 }));
  const r = detectDocumentPixels(fixture([a, b]));
  assert.equal(r.corners, null);
  assert.match(r.reason, /Multiple/);
});
test('cropped-off corners are not reported as confidently detected', () => {
  const p = polygon.map(p => ({ x: p.x - 65, y: p.y })),
    r = detectDocumentPixels(fixture([p]));
  assert.equal(r.corners, null);
});
test('manual full-image crop valid while duplicate or concave corners rejected', () => {
  assert.equal(
    validateCorners(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 60 },
        { x: 0, y: 60 },
      ],
      100,
      60
    ).valid,
    true
  );
  assert.equal(
    validateCorners(
      [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 100, y: 60 },
        { x: 0, y: 60 },
      ],
      100,
      60
    ).valid,
    false
  );
  assert.equal(
    validateCorners(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 20, y: 20 },
        { x: 0, y: 60 },
      ],
      100,
      60
    ).valid,
    false
  );
});
test('homography maps four destination corners exactly into skewed source', () => {
  const dest = [
      { x: 0, y: 0 },
      { x: 99, y: 0 },
      { x: 99, y: 59 },
      { x: 0, y: 59 },
    ],
    h = homography(dest, polygon);
  dest.forEach((p, i) => {
    const q = transformPoint(h, p.x, p.y);
    assert.ok(Math.hypot(q.x - polygon[i].x, q.y - polygon[i].y) < 1e-7);
  });
});
test('inverse projective sampling retains source coordinates and opaque pixels', () => {
  const width = 280,
    height = 200,
    data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = x;
      data[i + 1] = y;
      data[i + 2] = 17;
      data[i + 3] = 255;
    }
  const out = warpImageData({ width, height, data }, polygon, 100, 60);
  for (const [x, y, index] of [
    [0, 0, 0],
    [99, 0, 1],
    [99, 59, 2],
    [0, 59, 3],
  ]) {
    const i = (y * 100 + x) * 4;
    assert.ok(Math.abs(out.data[i] - polygon[index].x) <= 1);
    assert.ok(Math.abs(out.data[i + 1] - polygon[index].y) <= 1);
    assert.equal(out.data[i + 3], 255);
  }
  const middle = (30 * 100 + 50) * 4,
    h = homography(
      [
        { x: 0, y: 0 },
        { x: 99, y: 0 },
        { x: 99, y: 59 },
        { x: 0, y: 59 },
      ],
      polygon
    ),
    q = transformPoint(h, 50, 30);
  assert.ok(Math.abs(out.data[middle] - q.x) <= 1);
  assert.ok(Math.abs(out.data[middle + 1] - q.y) <= 1);
});
test('paper output retains measured proportions and output allocations bounded', () => {
  const p = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 100 },
      { x: 0, y: 100 },
    ],
    size = calculateOutputSize(p, ID_CARD_FORMATS.paper);
  assert.equal(size.width / size.height, 2);
  assert.throws(() => warpImageData(fixture(), polygon, 10000, 10000), /size/);
  assert.throws(
    () => detectDocumentPixels({ width: 1000, height: 1000, data: new Uint8ClampedArray(4000000) }),
    /downsampled/
  );
});

function scene({
  width = 400,
  height = 300,
  card = [
    { x: 65, y: 70 },
    { x: 330, y: 85 },
    { x: 315, y: 246 },
    { x: 48, y: 223 },
  ],
  background = (x, y) => 195 + x * 0.04,
  cardTone = (x, y) => 235 - x * 0.03,
  extra = () => null,
} = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let value = inside(x, y, card) ? cardTone(x, y) : background(x, y);
      const override = extra(x, y);
      if (override !== null) value = override;
      data[i] = data[i + 1] = data[i + 2] = Math.max(0, Math.min(255, value));
      data[i + 3] = 255;
    }
  return { width, height, data };
}
function nearCorners(result, expected, tolerance = 7) {
  assert.ok(result.corners, result.reason);
  result.corners.forEach((p, i) =>
    assert.ok(
      Math.hypot(p.x - expected[i].x, p.y - expected[i].y) < tolerance,
      JSON.stringify(result)
    )
  );
}
const shadowCard = [
  { x: 65, y: 70 },
  { x: 330, y: 85 },
  { x: 315, y: 246 },
  { x: 48, y: 223 },
];
test('weak shadowed outer card wins over black internal QR and photo borders', () => {
  const image = scene({
    card: shadowCard,
    background: (x, y) => 210 - x * 0.04,
    cardTone: (x, y) => 226 - x * 0.04,
    extra: (x, y) =>
      (x > 90 && x < 145 && y > 110 && y < 165) || (x > 235 && x < 285 && y > 155 && y < 205)
        ? 30
        : null,
  });
  const result = detectDocumentPixels(image);
  nearCorners(result, shadowCard);
  assert.ok(result.confidence >= 0.85, JSON.stringify(result));
});
test('separate small clutter does not replace a complete large perspective card', () => {
  const image = scene({
    card: shadowCard,
    background: () => 50,
    cardTone: () => 235,
    extra: (x, y) => (x > 10 && x < 39 && y > 15 && y < 44 ? 250 : null),
  });
  const result = detectDocumentPixels(image);
  nearCorners(result, shadowCard);
  assert.ok(result.confidence >= 0.85, JSON.stringify(result));
});
test('clockwise and anticlockwise rotated plastic cards preserve four outer corners', () => {
  for (const angle of [-0.45, 0.45]) {
    const c = Math.cos(angle),
      s = Math.sin(angle),
      card = [
        [-125, -79],
        [125, -79],
        [125, 79],
        [-125, 79],
      ].map(([x, y]) => ({ x: 200 + x * c - y * s, y: 160 + x * s + y * c }));
    const result = detectDocumentPixels(
      scene({ width: 400, height: 320, card, background: () => 80, cardTone: () => 240 })
    );
    nearCorners(result, card, 8);
    assert.ok(result.confidence >= 0.85, JSON.stringify(result));
  }
});
test('already cropped card is retained whole without trimming its text or codes', () => {
  const image = scene({
    width: 320,
    height: 202,
    card: [
      { x: 0, y: 0 },
      { x: 320, y: 0 },
      { x: 320, y: 202 },
      { x: 0, y: 202 },
    ],
    cardTone: () => 240,
    extra: (x, y) =>
      (x > 30 && x < 80 && y > 40 && y < 105) || (x > 230 && x < 280 && y > 110 && y < 160)
        ? 25
        : null,
  });
  const result = detectDocumentPixels(image);
  assert.equal(result.method, 'already-cropped');
  assert.ok(result.confidence >= 0.85);
  assert.deepEqual(result.corners, [
    { x: 0, y: 0 },
    { x: 319, y: 0 },
    { x: 319, y: 201 },
    { x: 0, y: 201 },
  ]);
  assert.notEqual(detectDocumentPixels(image, { format: 'paper' }).method, 'already-cropped');
});
test('portrait card dimensions are not squeezed to landscape during correction', () => {
  const points = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 317 },
    { x: 0, y: 317 },
  ];
  const size = calculateOutputSize(points, ID_CARD_FORMATS.generic);
  assert.ok(size.height > size.width);
  assert.ok(Math.abs(size.width / size.height - 54 / 85.6) < 0.005);
});
test('inner QR/text blocks alone cannot establish the outer card on a square uncropped photo', () => {
  const image = scene({
    width: 320,
    height: 320,
    card: [],
    background: () => 220,
    extra: (x, y) => (x > 75 && x < 245 && y > 75 && y < 245 ? 25 : null),
  });
  const result = detectDocumentPixels(image);
  assert.ok(result.confidence < 0.85, result.reason);
  assert.ok(detectDocumentPixels(image, { format: 'paper' }).confidence < 0.85);
});
test('soft shadow and blur can be detected while missing corners still require review', () => {
  const image = scene({ card: shadowCard, background: () => 205, cardTone: () => 231 });
  for (let pass = 0; pass < 3; pass++) {
    const original = image.data.slice();
    for (let y = 1; y < image.height - 1; y++)
      for (let x = 1; x < image.width - 1; x++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) sum += original[((y + dy) * image.width + x + dx) * 4];
        const i = (y * image.width + x) * 4;
        image.data[i] = image.data[i + 1] = image.data[i + 2] = sum / 9;
      }
  }
  const result = detectDocumentPixels(image);
  nearCorners(result, shadowCard, 9);
  assert.ok(result.confidence >= 0.85, JSON.stringify(result));
  const clipped = scene({
    width: 320,
    height: 202,
    card: [
      { x: -35, y: 20 },
      { x: 275, y: 40 },
      { x: 260, y: 190 },
      { x: -40, y: 170 },
    ],
    background: () => 210,
    cardTone: () => 226,
  });
  const partial = detectDocumentPixels(clipped);
  assert.ok(partial.confidence < 0.85, JSON.stringify(partial));
});
test('dark internal rectangular panels are suggestions rather than auto-cropped documents', () => {
  const image = scene({
    card: [],
    background: () => 235,
    extra: (x, y) => (x > 80 && x < 315 && y > 85 && y < 230 ? 25 : null),
  });
  const result = detectDocumentPixels(image);
  assert.ok(result.confidence < 0.85, JSON.stringify(result));
});
