import { PDFDocument, rgb } from 'pdf-lib';
export async function testPage(shop) {
  const pdf = await PDFDocument.create();
  const p = pdf.addPage([595.276, 841.89]);
  p.drawRectangle({
    x: 35,
    y: 35,
    width: 525,
    height: 770,
    borderWidth: 1,
    borderColor: rgb(0.2, 0.2, 0.2),
  });
  const lines = [
    'SHRI PRINT - PRINTER TEST',
    shop,
    '',
    'This is a synthetic setup test. No customer information.',
    'A4 / Black & White / 1 copy / Single sided',
    '',
    'Check: all text visible, no clipping, correct printer.',
    'Windows acceptance does not prove physical output.',
    'Confirm the paper at the counter after checking it.',
    '',
    new Date().toISOString(),
  ];
  lines.forEach((line, i) =>
    p.drawText(line.replace(/[^\x20-\x7E]/g, '?'), {
      x: 55,
      y: 760 - i * 30,
      size: i === 0 ? 22 : 12,
    })
  );
  return pdf.save();
}
