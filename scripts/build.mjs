import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
const result = await build({
  entryPoints: ['web/app.js'],
  bundle: true,
  write: false,
  format: 'esm',
  target: 'es2022',
  minify: true,
});
const viewer = await build({
  entryPoints: ['web/viewer.js'],
  bundle: true,
  write: false,
  format: 'esm',
  target: 'es2022',
  minify: true,
});
const idWorker = await build({
  entryPoints: ['web/id-worker.js'],
  bundle: true,
  write: false,
  format: 'esm',
  target: 'es2022',
  minify: true,
});
const assets = {};
for (const [path, file, type] of [
  ['/index.html', 'web/index.html', 'text/html; charset=utf-8'],
  ['/style.css', 'web/style.css', 'text/css'],
  ['/customer-v3.css', 'web/customer-v3.css', 'text/css'],
  ['/warm-ui.css', 'web/warm-ui.css', 'text/css'],
  ['/icon.svg', 'web/icon.svg', 'image/svg+xml'],
])
  assets[path] = { body: await readFile(file, 'utf8'), type };
assets['/app.js'] = { body: result.outputFiles[0].text, type: 'text/javascript' };
assets['/studio-ui.css'] = { body: await readFile('web/studio-ui.css', 'utf8'), type: 'text/css' };
await writeFile(
  'worker/assets.generated.js',
  'export const assets=' + JSON.stringify(assets) + ';\n'
);
assets['/preview'] = {
  body: await readFile('web/viewer.html', 'utf8'),
  type: 'text/html; charset=utf-8',
};
assets['/viewer.js'] = { body: viewer.outputFiles[0].text, type: 'text/javascript' };
assets['/pdf.worker.js'] = {
  body: await readFile('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'utf8'),
  type: 'text/javascript',
};
assets['/id-worker.js'] = { body: idWorker.outputFiles[0].text, type: 'text/javascript' };
for (const weight of [400, 600, 700, 800])
  assets['/fonts/Nunito-' + weight + '.ttf'] = {
    body: (await readFile('web/fonts/Nunito-' + weight + '.ttf')).toString('base64'),
    base64: true,
    type: 'font/ttf',
  };
await writeFile(
  'worker/assets.generated.js',
  'export const assets=' + JSON.stringify(assets) + ';\n'
);
await mkdir('dist/server', { recursive: true });
await mkdir('dist/.openai', { recursive: true });
await build({
  entryPoints: ['worker/index.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: 'dist/server/index.js',
  minify: true,
});
await copyFile('.openai/hosting.json', 'dist/.openai/hosting.json');
// eslint-disable-next-line no-console
console.log('Built SHRI Print customer site and server.');
