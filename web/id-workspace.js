import { validateCorners } from '../lib/id-card.js';

function localImageTask(request) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('/id-worker.js', { type: 'module' });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(Error('Image processing timed out. Please try a smaller photo.'));
    }, 45000);
    const finish = (error, value) => {
      clearTimeout(timer);
      worker.terminate();
      error ? reject(error) : resolve(value);
    };
    worker.onmessage = event =>
      event.data.ok ? finish(null, event.data) : finish(Error(event.data.error));
    worker.onerror = () =>
      finish(Error('Local image processing could not start. Please reload and try again.'));
    worker.postMessage(request);
  });
}
const pixels = source =>
  source
    .getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, source.width, source.height);
export async function autoCropIdCard(file, { format = 'plastic' } = {}) {
  try {
    const result = await localImageTask({ action: 'auto', file, format });
    return result.blob ? result : null;
  } catch {
    return null;
  }
}

// All image detection/correction is local; the caller controls private order storage.
export async function editIdCard(file, { format = 'plastic', title = 'ID card' } = {}) {
  const bitmap = await createImageBitmap(file);
  const dialog = document.createElement('dialog');
  dialog.className = 'id-editor';
  const heading = document.createElement('h2');
  heading.textContent = title + ' · crop & straighten';
  const hint = document.createElement('p');
  hint.textContent =
    'Drag the four numbered corners onto the card edges. Check the text is upright. Everything stays on this device.';
  const status = document.createElement('p');
  status.className = 'id-editor-status';
  status.setAttribute('role', 'status');
  const tools = document.createElement('div');
  tools.className = 'id-editor-tools';
  const scroller = document.createElement('div');
  scroller.className = 'id-editor-viewport';
  const canvas = document.createElement('canvas');
  canvas.tabIndex = 0;
  canvas.setAttribute(
    'aria-label',
    'Card corners: Tab selects a numbered corner, arrow keys move it.'
  );
  canvas.style.touchAction = 'none';
  scroller.append(canvas);
  const cornersControls = document.createElement('div');
  cornersControls.className = 'id-corner-controls';
  const footer = document.createElement('div');
  footer.className = 'id-editor-footer';
  const preview = document.createElement('canvas');
  preview.className = 'id-corrected-preview';
  preview.hidden = true;
  preview.setAttribute('aria-label', 'Corrected card preview');
  const ctx = canvas.getContext('2d');
  let source,
    rotation = 0,
    corners,
    _suggested,
    confidence = 0,
    active = 0,
    dragging = false,
    zoom = 1,
    busy = false,
    settled = false;
  let resolvePromise;
  const result = new Promise(resolve => (resolvePromise = resolve));
  function finish(value) {
    if (settled) return;
    settled = true;
    bitmap.close();
    dialog.close();
    dialog.remove();
    resolvePromise(value);
  }
  function button(label, handler, parent = tools) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', handler);
    parent.append(b);
    return b;
  }
  function render() {
    if (!source || !corners) return;
    const width = Math.max(160, Math.min((scroller.clientWidth || 560) - 28, 620));
    const scale =
      Math.min(width / source.width, Math.min(390, innerHeight * 0.42) / source.height) * zoom;
    canvas.width = Math.round(source.width * scale);
    canvas.height = Math.round(source.height * scale);
    canvas.style.width = canvas.width + 'px';
    canvas.style.height = canvas.height + 'px';
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#162e3d88';
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    ctx.moveTo(corners[0].x * scale, corners[0].y * scale);
    for (let i = 3; i >= 0; i--) ctx.lineTo(corners[i].x * scale, corners[i].y * scale);
    ctx.closePath();
    ctx.fill('evenodd');
    ctx.strokeStyle = '#65ffd8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    corners.forEach((p, i) =>
      i ? ctx.lineTo(p.x * scale, p.y * scale) : ctx.moveTo(p.x * scale, p.y * scale)
    );
    ctx.closePath();
    ctx.stroke();
    corners.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x * scale, p.y * scale, 13, 0, Math.PI * 2);
      ctx.fillStyle = i === active ? '#f17a40' : '#fff9e8';
      ctx.fill();
      ctx.strokeStyle = '#254e49';
      ctx.stroke();
      ctx.fillStyle = '#183f3b';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), p.x * scale, p.y * scale);
    });
    const valid = validateCorners(corners, source.width, source.height);
    apply.disabled = !valid.valid || busy;
    check.disabled = !valid.valid || busy;
    [...cornersControls.children].forEach((b, i) =>
      b.setAttribute('aria-pressed', String(i === active))
    );
  }
  function sourceFromRotation() {
    source = document.createElement('canvas');
    const swap = rotation % 180 !== 0;
    const s = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * s),
      h = Math.round(bitmap.height * s);
    source.width = swap ? h : w;
    source.height = swap ? w : h;
    const c = source.getContext('2d');
    c.translate(source.width / 2, source.height / 2);
    c.rotate((rotation * Math.PI) / 180);
    c.drawImage(bitmap, -w / 2, -h / 2, w, h);
  }
  async function detect() {
    status.textContent = 'Finding card edges…';
    busy = true;
    apply.disabled = true;
    check.disabled = true;
    await new Promise(r => requestAnimationFrame(r));
    try {
      const found = await localImageTask({ action: 'detect', image: pixels(source), format });
      confidence = found.confidence;
      corners = found.corners || [
        { x: 0, y: 0 },
        { x: source.width - 1, y: 0 },
        { x: source.width - 1, y: source.height - 1 },
        { x: 0, y: source.height - 1 },
      ];
      _suggested = corners.map(p => ({ ...p }));
      status.textContent =
        (found.reason || 'Check the suggested crop.') +
        ' Boundary score: ' +
        Math.round(confidence * 100) +
        '%.';
    } catch {
      corners = [
        { x: 0, y: 0 },
        { x: source.width - 1, y: 0 },
        { x: source.width - 1, y: source.height - 1 },
        { x: 0, y: source.height - 1 },
      ];
      _suggested = corners.map(p => ({ ...p }));
      status.textContent = 'Automatic detection unavailable. Position the four corners manually.';
    } finally {
      busy = false;
      render();
    }
  }
  function changed() {
    preview.hidden = true;
    status.textContent =
      'Corners adjusted. Preview the correction and check that no details are cut off.';
    render();
  }
  button('↶ Rotate', async () => {
    if (busy) return;
    rotation = (rotation + 270) % 360;
    zoom = 1;
    sourceFromRotation();
    await detect();
  });
  button('↷ Rotate', async () => {
    if (busy) return;
    rotation = (rotation + 90) % 360;
    zoom = 1;
    sourceFromRotation();
    await detect();
  });
  button('Reset', async () => {
    if (busy) return;
    rotation = 0;
    zoom = 1;
    sourceFromRotation();
    preview.hidden = true;
    await detect();
  });
  button('− Zoom', () => {
    zoom = Math.max(1, zoom - 0.25);
    render();
  });
  button('+ Zoom', () => {
    zoom = Math.min(3, zoom + 0.25);
    render();
  });
  for (let i = 0; i < 4; i++) {
    const b = button(
      'Corner ' + (i + 1),
      () => {
        active = i;
        canvas.focus();
        render();
      },
      cornersControls
    );
    b.setAttribute('aria-label', 'Select corner ' + (i + 1) + '; use arrow keys to adjust');
  }
  async function correctedBlob() {
    return (await localImageTask({ action: 'correct', image: pixels(source), corners, format }))
      .blob;
  }
  const check = button(
    'Preview correction',
    async () => {
      if (busy) return;
      busy = true;
      render();
      status.textContent = 'Straightening preview…';
      try {
        const blob = await correctedBlob(),
          image = await createImageBitmap(blob);
        preview.width = image.width;
        preview.height = image.height;
        preview.getContext('2d').drawImage(image, 0, 0);
        image.close();
        preview.hidden = false;
        status.textContent =
          'Corrected preview below. Check all text, photo and codes before Apply.';
      } catch (e) {
        status.textContent = e.message;
      } finally {
        busy = false;
        render();
      }
    },
    tools
  );
  button('Cancel', () => finish(null), footer);
  const apply = button(
    'Apply crop',
    async () => {
      if (busy) return;
      busy = true;
      render();
      status.textContent = 'Straightening card…';
      try {
        const blob = await correctedBlob();
        if (!blob) throw Error('Image could not be saved.');
        finish({ blob, corners: corners.map(p => ({ ...p })), rotation, confidence });
      } catch (e) {
        status.textContent = e.message;
        busy = false;
        render();
      }
    },
    footer
  );
  apply.className = 'primary';
  function point(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(source.width - 1, ((e.clientX - r.left) / r.width) * source.width)),
      y: Math.max(0, Math.min(source.height - 1, ((e.clientY - r.top) / r.height) * source.height)),
    };
  }
  canvas.addEventListener('pointerdown', e => {
    if (busy || !corners) return;
    const r = canvas.getBoundingClientRect();
    let distance = Infinity;
    corners.forEach((p, i) => {
      const d = Math.hypot(
        e.clientX - r.left - (p.x / source.width) * r.width,
        e.clientY - r.top - (p.y / source.height) * r.height
      );
      if (d < distance) {
        distance = d;
        active = i;
      }
    });
    if (distance > 45) return;
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    render();
  });
  canvas.addEventListener('pointermove', e => {
    if (!dragging) return;
    corners[active] = point(e);
    changed();
  });
  for (const event of ['pointerup', 'pointercancel'])
    canvas.addEventListener(event, () => (dragging = false));
  canvas.addEventListener('keydown', e => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
      e.key
    ];
    if (!d || busy) return;
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    corners[active].x = Math.max(0, Math.min(source.width - 1, corners[active].x + d[0] * step));
    corners[active].y = Math.max(0, Math.min(source.height - 1, corners[active].y + d[1] * step));
    changed();
  });
  dialog.addEventListener('cancel', e => {
    e.preventDefault();
    if (!busy) finish(null);
  });
  dialog.append(heading, hint, status, tools, scroller, cornersControls, preview, footer);
  document.body.append(dialog);
  dialog.showModal();
  sourceFromRotation();
  await detect();
  return result;
}
