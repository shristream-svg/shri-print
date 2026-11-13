import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { generatePDF, validateData } from '../web/resume-builder.js';

const data = {
  template: 'clean',
  name: 'Synthetic Customer',
  phone: '9876543210',
  email: 'synthetic@example.test',
  city: 'Test City',
  summary: 'Customer service and office work.',
  education: [
    { degree: 'Senior secondary', institution: 'Synthetic school', year: '2020', details: '' },
  ],
  experience: [],
  skills: 'Typing, spreadsheets, customer service',
};
test('resume requires name and validates contacts only when supplied', () => {
  assert.deepEqual(validateData({ ...data, phone: '', email: '' }), []);
  assert.ok(validateData({ ...data, name: '' }).includes('Name is required'));
  assert.ok(validateData({ ...data, phone: '123' }).includes('Phone must be 10 digits'));
  assert.ok(validateData({ ...data, email: 'invalid' }).includes('Invalid email format'));
});
test('resume font choice changes actual embedded PDF typeface while retaining A4 output', async () => {
  for (const [font, expected] of [
    ['modern', 'Helvetica'],
    ['classic', 'Times-Roman'],
    ['mono', 'Courier'],
  ]) {
    const file = await generatePDF({ ...data, font });
    const pdf = await PDFDocument.load(await file.arrayBuffer());
    assert.equal(pdf.getPageCount(), 1);
    assert.ok(Math.abs(pdf.getPage(0).getWidth() - 595.28) < 0.01);
    const objects = pdf.context
      .enumerateIndirectObjects()
      .map(([, object]) => object.toString())
      .join('\n');
    assert.ok(objects.includes(`/BaseFont /${expected}`), `${font} should embed ${expected}`);
  }
});
