import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/build/pdf.mjs';
GlobalWorkerOptions.workerSrc = '/pdf.worker.js';
const label = document.querySelector('#page-label'),
  message = document.querySelector('#message'),
  canvas = document.querySelector('canvas'),
  prev = document.querySelector('#previous'),
  next = document.querySelector('#next');
let pdf,
  pageNumber = 1,
  rendering = false;
async function render() {
  if (rendering || !pdf) return;
  rendering = true;
  prev.disabled = next.disabled = true;
  try {
    const page = await pdf.getPage(pageNumber),
      base = page.getViewport({ scale: 1 }),
      width = Math.max(240, document.documentElement.clientWidth - 35),
      scale = Math.min(1.6, width / base.width),
      viewport = page.getViewport({ scale }),
      output = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.floor(viewport.width * output);
    canvas.height = Math.floor(viewport.height * output);
    canvas.style.width = Math.floor(viewport.width) + 'px';
    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport,
      transform: output === 1 ? null : [output, 0, 0, output, 0, 0],
    }).promise;
    message.hidden = true;
    label.textContent = 'Page ' + pageNumber + ' of ' + pdf.numPages;
    canvas.setAttribute('aria-label', 'Prepared print page ' + pageNumber + ' of ' + pdf.numPages);
    page.cleanup();
  } catch (_e) {
    message.hidden = false;
    message.textContent =
      'Preview could not render. Use the PDF download link below to check your file.';
  } finally {
    rendering = false;
    prev.disabled = pageNumber <= 1;
    next.disabled = pageNumber >= pdf.numPages;
  }
}
prev.addEventListener('click', () => {
  if (!rendering && pageNumber > 1) {
    pageNumber--;
    render();
  }
});
next.addEventListener('click', () => {
  if (!rendering && pageNumber < pdf.numPages) {
    pageNumber++;
    render();
  }
});
try {
  const token = new URL(location.href).searchParams.get('order');
  if (!/^[a-f0-9-]{60,90}$/.test(token || '')) throw new Error('Invalid order');
  pdf = await getDocument({
    url: '/api/orders/' + token + '/file',
    isEvalSupported: false,
    useSystemFonts: true,
    enableXfa: false,
  }).promise;
  await render();
} catch (_e) {
  label.textContent = 'Preview unavailable';
  message.textContent =
    'The file could not be opened. It may have expired. Please upload again or use the PDF download link.';
}
