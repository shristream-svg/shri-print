import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFArray, PDFDocument, decodePDFRawStream } from 'pdf-lib';
import { idPlacement, prepareDocuments } from '../lib/documents.js';

const options = {
  service: 'id',
  color: 'bw',
  paper: 'A4',
  copies: 1,
  range: '',
  orientation: 'portrait',
  duplex: false,
  method: 'cash',
  mobile: '',
};
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD2kAAAAASUVORK5CYII=',
  'base64'
);
const file = () => new File([png], 'synthetic-side.png', { type: 'image/png' });
const mm = n => (n * 72) / 25.4;

test('plastic ID placement has physical card size and separated fronts, with no ratio stretch', () => {
  const front = idPlacement(856, 540, 'plastic', 0),
    back = idPlacement(1712, 1080, 'plastic', 1);
  assert.ok(Math.abs(front.width - 85.6) < 1e-10);
  assert.ok(Math.abs(front.height - 54) < 1e-10);
  assert.deepEqual({ ...front, y: back.y }, back);
  assert.ok(Math.abs(front.y - (back.y + back.height) - 126) < 1e-10);
  assert.equal(front.x, 62.2);
  assert.equal(front.y + front.height, 272);
  assert.equal(back.y + back.height, 92);
  assert.ok(Math.abs(back.y - 38) < 1e-10);
  assert.equal(front.x + front.width / 2, 105);
  assert.equal(back.x + back.width / 2, 105);
  const portrait = idPlacement(400, 700, 'plastic', 0);
  assert.ok(Math.abs(portrait.width / portrait.height - 400 / 700) < 1e-10);
  assert.ok(portrait.height <= 54 && portrait.width <= 85.6);
});

test('paper Aadhaar keeps source proportions within its box, independent of source pixel size', () => {
  for (const [w, h] of [
    [1200, 400],
    [400, 1200],
    [860, 540],
  ]) {
    const box = idPlacement(w, h, 'paper', 1);
    assert.ok(Math.abs(box.width / box.height - w / h) < 1e-10);
    assert.ok(box.width <= 100 && box.height <= 75);
    assert.ok(Math.abs(box.x + box.width / 2 - 105) < 1e-10);
    assert.ok(Math.abs(box.y + box.height - 102) < 1e-10);
    assert.ok(box.y >= 27 && box.x > 0 && box.x + box.width < 210);
  }
  assert.throws(() => idPlacement(100, 100, 'invented'));
  assert.throws(() => idPlacement(NaN, 100));
});

test('generated ID PDF embeds two images on one physical A4 page using expected fitting matrix', async () => {
  const out = await prepareDocuments([file(), file()], options);
  assert.equal(out.pages, 1);
  const pdf = await PDFDocument.load(out.bytes),
    page = pdf.getPage(0);
  assert.ok(Math.abs(page.getWidth() - mm(210)) < 0.01);
  assert.ok(Math.abs(page.getHeight() - mm(297)) < 0.01);
  const contents = page.node.Contents();
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map(ref => pdf.context.lookup(ref))
      : [contents];
  const text = streams
    .map(stream => new TextDecoder().decode(decodePDFRawStream(stream).decode()))
    .join('\n');
  assert.equal((text.match(/\/Image-[^\s]+ Do/g) || []).length, 2);
  // Synthetic square inputs stay square instead of being distorted to a card ratio.
  assert.equal(
    (text.match(new RegExp(`${mm(54).toFixed(8).slice(0, 7)}`, 'g')) || []).length >= 2,
    true
  );
});

test('single-side mode must be deliberate, invalid format/paper cannot enter PDF layout', async () => {
  await assert.rejects(() => prepareDocuments([file()], options), /front and back/);
  const out = await prepareDocuments([file()], { ...options, idSingle: true, idFormat: 'paper' });
  assert.equal((await PDFDocument.load(out.bytes)).getPageCount(), 1);
  await assert.rejects(
    () => prepareDocuments([file(), file()], { ...options, idSingle: true }),
    /one JPG/
  );
  await assert.rejects(
    () => prepareDocuments([file(), file()], { ...options, idFormat: 'unknown' }),
    /format/
  );
  await assert.rejects(
    () => prepareDocuments([file(), file()], { ...options, paper: 'A3' }),
    /portrait A4/
  );
  await assert.rejects(
    () => prepareDocuments([file(), file()], { ...options, duplex: true }),
    /single sided/
  );
});

test('document quarter-turn changes actual PDF drawing matrix inside requested paper geometry', async () => {
  const source = await PDFDocument.create();
  source.addPage([200, 300]).drawText('SYNTHETIC ROTATION');
  const out = await prepareDocuments(
    [new File([await source.save()], 'rotation.pdf', { type: 'application/pdf' })],
    { ...options, service: 'document', paper: 'A3', orientation: 'landscape', rotation: 90 }
  );
  const pdf = await PDFDocument.load(out.bytes),
    page = pdf.getPage(0);
  assert.ok(Math.abs(page.getWidth() - mm(420)) < 0.01);
  assert.ok(Math.abs(page.getHeight() - mm(297)) < 0.01);
  const refs = page.node.Contents(),
    streams = refs instanceof PDFArray ? refs.asArray().map(r => pdf.context.lookup(r)) : [refs];
  const text = streams
    .map(s => new TextDecoder().decode(decodePDFRawStream(s).decode()))
    .join('\n');
  const matrices = [
    ...text.matchAll(/([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) cm/g),
  ].map(m => m.slice(1).map(Number));
  assert.ok(
    matrices.some(
      m => Math.abs(m[0]) < 1e-10 && m[1] === 1 && m[2] === -1 && Math.abs(m[3]) < 1e-10
    ),
    'Output contains a real90degree content transform'
  );
  await assert.rejects(
    () => prepareDocuments([file()], { ...options, idSingle: true, rotation: 45 }),
    /rotation/
  );
});
