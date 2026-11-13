import { degrees, PDFDocument, rgb } from 'pdf-lib';
import { ensure, parsePages, validateOptions } from './core.js';
const mm = n => (n * 72) / 25.4;
async function image(pdf, bytes) {
  try {
    if (bytes[0] === 137 && bytes[1] === 80) return await pdf.embedPng(bytes);
    if (bytes[0] === 255 && bytes[1] === 216) return await pdf.embedJpg(bytes);
  } catch {}
  ensure(false, 'Use a valid JPG or PNG image.');
}
function _fit(page, img, x, y, w, h, cover = false) {
  const scale = (cover ? Math.max : Math.min)(w / img.width, h / img.height);
  const iw = img.width * scale,
    ih = img.height * scale;
  page.drawImage(img, {
    x: x + (w - iw) / 2,
    y: y + (h - ih) / 2,
    width: iw,
    height: ih,
  });
}
function pageSize(options) {
  const sizes = { A4: [210, 297], A3: [297, 420], A2: [420, 594], A1: [594, 841] },
    size = sizes[options.paper].map(mm);
  return options.orientation === 'landscape' ? size.reverse() : size;
}
function drawRotated(page, drawable, width, height, rotation, isPage = false, box = null) {
  const angle = ((rotation % 360) + 360) % 360,
    swap = angle === 90 || angle === 270,
    rw = swap ? height : width,
    rh = swap ? width : height;
  const margin = mm(8),
    bounds = box || {
      x: margin,
      y: margin,
      width: page.getWidth() - 2 * margin,
      height: page.getHeight() - 2 * margin,
    },
    scale = Math.min(bounds.width / rw, bounds.height / rh),
    w = width * scale,
    h = height * scale;
  let x = bounds.x + (bounds.width - rw * scale) / 2,
    y = bounds.y + (bounds.height - rh * scale) / 2;
  if (angle === 90) x += h;
  else if (angle === 180) {
    x += w;
    y += h;
  } else if (angle === 270) y += w;
  const opts = { x, y, width: w, height: h, rotate: degrees(angle) };
  if (isPage) page.drawPage(drawable, opts);
  else page.drawImage(drawable, opts);
}
export async function validateQrImage(file) {
  ensure(
    file && typeof file.arrayBuffer === 'function' && file.size > 0 && file.size <= 512 * 1024,
    'Choose a JPG/PNG QR image under 500 KB.'
  );
  const bytes = new Uint8Array(await file.arrayBuffer());
  const png = bytes[0] === 137 && bytes[1] === 80;
  if (png) {
    ensure(bytes.length >= 24, 'Invalid PNG.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    ensure(
      view.getUint32(16) <= 2000 && view.getUint32(20) <= 2000,
      'QR image must be at most 2000 × 2000 pixels.'
    );
  }
  const doc = await PDFDocument.create();
  const img = await image(doc, bytes);
  ensure(img.width <= 2000 && img.height <= 2000, 'QR image must be at most 2000 × 2000 pixels.');
  return { bytes, extension: png ? 'png' : 'jpg' };
}
function layoutPassport(page, img, photoQty, mm, rotation = 0) {
  const qty = photoQty || 30;
  const cols = 5;
  const rows = Math.ceil(qty / cols);
  const pageW = mm(210);
  const pageH = mm(297);
  const photoW = mm(35);
  const photoH = mm(45);
  // Use 2mm gaps for 30 photos (6 rows): 6*45 + 5*2 = 280mm, leaving 8.5mm top/bottom margins
  const gapX = mm(4);
  const gapY = mm(2);
  const totalW = cols * photoW + (cols - 1) * gapX;
  const _totalH = rows * photoH + (rows - 1) * gapY;
  const startX = (pageW - totalW) / 2;
  const startY = pageH - mm(8.5);
  let count = 0;
  for (let row = 0; row < rows && count < qty; row++) {
    for (let col = 0; col < cols && count < qty; col++) {
      const x = startX + col * (photoW + gapX);
      const y = startY - (row + 1) * photoH - row * gapY;
      drawRotated(page, img, img.width, img.height, rotation, false, {
        x,
        y,
        width: photoW,
        height: photoH,
      });
      page.drawRectangle({
        x,
        y,
        width: photoW,
        height: photoH,
        borderColor: rgb(0.8, 0.8, 0.8),
        borderWidth: 0.25,
      });
      count++;
    }
  }
}
// Millimetre geometry keeps the physical A4 photocopy placement explicit.
export function idPlacement(width, height, format = 'plastic', sideIndex = 0) {
  ensure(
    Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0,
    'Invalid ID dimensions.'
  );
  ensure(['plastic', 'paper'].includes(format), 'Invalid ID format.');
  ensure(sideIndex === 0 || sideIndex === 1, 'Invalid ID side.');
  const boundW = format === 'plastic' ? 85.6 : 100;
  const boundH = format === 'plastic' ? 54 : 75;
  const scale = Math.min(boundW / width, boundH / height);
  const w = width * scale,
    h = height * scale;
  const top = sideIndex === 0 ? 25 : format === 'plastic' ? 205 : 195;
  return { x: (210 - w) / 2, y: 297 - top - h, width: w, height: h };
}

export async function prepareDocuments(files, options) {
  validateOptions(options);
  ensure(files.length > 0 && files.length <= 10, 'Select 1–10 files.');
  ensure(
    files.reduce((n, f) => n + f.size, 0) <= 40 * 1024 * 1024,
    'Combined uploads must be under 40 MB.'
  );
  for (const f of files)
    ensure(f.size > 0 && f.size <= 25 * 1024 * 1024, 'Each file must be 1 byte to 25 MB.');
  const pdf = await PDFDocument.create();
  if (options.service === 'passport') {
    ensure(files.length === 1, 'Passport sheets need one JPG/PNG photo.');
    const img = await image(pdf, new Uint8Array(await files[0].arrayBuffer()));
    const page = pdf.addPage([mm(210), mm(297)]);
    layoutPassport(page, img, options.photoQty, mm, options.rotation || 0);
  } else if (options.service === 'id') {
    const single = options.idSingle === true;
    ensure(
      files.length === (single ? 1 : 2),
      single
        ? 'Single-side ID layout needs one JPG/PNG image.'
        : 'ID layout needs front and back JPG/PNG images, in that order.'
    );
    const format = options.idFormat || 'plastic';
    const sides = options.swapSides === true ? [...files].reverse() : files;
    ensure(['plastic', 'paper'].includes(format), 'Choose plastic-card or paper-ID format.');
    ensure(
      options.paper === 'A4' && options.orientation === 'portrait' && options.duplex === false,
      'ID photocopies use one portrait A4 sheet, single sided.'
    );
    const page = pdf.addPage([mm(210), mm(297)]);
    for (let i = 0; i < sides.length; i++) {
      const img = await image(pdf, new Uint8Array(await sides[i].arrayBuffer()));
      const swapped = [90, 270].includes(options.rotation || 0);
      const box = idPlacement(
        swapped ? img.height : img.width,
        swapped ? img.width : img.height,
        format,
        i
      );
      // Local corner correction already rectifies perspective; fitting never stretches pixels.
      drawRotated(page, img, img.width, img.height, options.rotation || 0, false, {
        x: mm(box.x),
        y: mm(box.y),
        width: mm(box.width),
        height: mm(box.height),
      });
    }
  } else {
    for (const f of files) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-') {
        let source;
        try {
          source = await PDFDocument.load(bytes, { updateMetadata: false });
        } catch {
          ensure(false, 'PDF cannot be read. Unlock encrypted PDFs before uploading.');
        }
        ensure(
          source.getPageCount() > 0 && source.getPageCount() + pdf.getPageCount() <= 1000,
          'Maximum 1000 pages per order.'
        );
        for (const sourcePage of source.getPages()) {
          const embedded = await pdf.embedPage(sourcePage),
            page = pdf.addPage(pageSize(options));
          drawRotated(
            page,
            embedded,
            embedded.width,
            embedded.height,
            (sourcePage.getRotation().angle || 0) + (options.rotation || 0),
            true
          );
        }
      } else {
        const img = await image(pdf, bytes);
        const page = pdf.addPage(pageSize(options));
        drawRotated(page, img, img.width, img.height, options.rotation || 0);
      }
    }
  }
  const total = pdf.getPageCount(),
    selected = parsePages(options.range, total),
    out = await PDFDocument.create();
  const selectedPages = await out.copyPages(
    pdf,
    selected.map(x => x - 1)
  );
  selectedPages.forEach(p => out.addPage(p));
  out.setTitle('SHRI Print document');
  out.setProducer('SHRI Print');
  return {
    bytes: await out.save(),
    pages: selected.length,
    originalPages: total,
    selected,
  };
}

export async function inspectSourceFile(file) {
  ensure(
    file &&
      typeof file.arrayBuffer === 'function' &&
      file.size > 0 &&
      file.size <= 25 * 1024 * 1024,
    'Invalid source file.'
  );
  const bytes = new Uint8Array(await file.arrayBuffer());
  let type,
    pages = 1;
  if (new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-') {
    let pdf;
    try {
      pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    } catch {
      ensure(false, 'Source PDF cannot be read.');
    }
    pages = pdf.getPageCount();
    ensure(pages > 0 && pages <= 1000, 'Maximum1000 pages per source.');
    type = 'application/pdf';
  } else {
    const pdf = await PDFDocument.create();
    await image(pdf, bytes);
    type = bytes[0] === 137 ? 'image/png' : 'image/jpeg';
  }
  return {
    name: String(file.name || 'upload')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f]/g, '')
      .slice(0, 150),
    type,
    size: file.size,
    pages,
  };
}
