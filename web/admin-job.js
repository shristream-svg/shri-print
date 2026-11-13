import { editIdCard } from './id-workspace.js';

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const time = value => (value ? new Date(value).toLocaleString() : 'Not recorded');
const size = value =>
  Number.isFinite(value)
    ? value >= 1048576
      ? (value / 1048576).toFixed(1) + ' MB'
      : Math.max(1, Math.round(value / 1024)) + ' KB'
    : 'Unknown size';

export async function openAdminJob(initial, { api, refresh, money }) {
  let order = initial,
    opts = JSON.parse(initial.options),
    closed = false,
    mutating = false,
    rendering = false,
    pdf,
    loadingTask,
    renderTask,
    generation = 0,
    pageNo = 1,
    activeTab = 'settings';
  const dialog = el('dialog', 'job-workspace studio-job'),
    header = el('header', 'job-studio-head'),
    title = el('h2', null, 'Job Studio · #' + order.id.slice(0, 8).toUpperCase()),
    close = el('button', null, 'Close');
  close.type = 'button';
  header.append(title, close);
  const summary = el('div', 'job-summary-strip'),
    grid = el('div', 'job-workspace-grid'),
    viewer = el('section', 'job-pdf-viewer'),
    aside = el('section', 'job-inspector');
  const previewTitle = el('h3', null, 'Prepared print preview'),
    status = el('p', null, 'Loading prepared PDF…'),
    canvas = el('canvas'),
    toolbar = el('div', 'job-preview-toolbar'),
    prev = el('button', null, '←'),
    next = el('button', null, '→'),
    pageLabel = el('span');
  status.setAttribute('role', 'status');
  prev.type = next.type = 'button';
  prev.setAttribute('aria-label', 'Previous PDF page');
  next.setAttribute('aria-label', 'Next PDF page');
  toolbar.append(prev, pageLabel, next);
  viewer.append(previewTitle, status, canvas, toolbar);
  const tabs = el('div', 'job-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Job information');
  const panel = el('div', 'job-tab-panel');
  panel.id = 'job-studio-panel';
  panel.setAttribute('role', 'tabpanel');
  const footer = el('footer', 'job-studio-footer'),
    feedback = el('p', 'job-feedback');
  feedback.setAttribute('role', 'status');
  footer.append(feedback);
  aside.append(tabs, panel);
  grid.append(viewer, aside);
  dialog.append(header, summary, grid, footer);
  document.body.append(dialog);
  dialog.showModal();
  let fieldset;
  const pendingEdits = new Map();
  function dispose() {
    if (mutating) {
      feedback.textContent = 'Please wait for the current update to finish.';
      return;
    }
    closed = true;
    generation++;
    renderTask?.cancel();
    loadingTask?.destroy?.().catch(() => {});
    dialog.close();
    dialog.remove();
  }
  close.onclick = dispose;
  dialog.addEventListener('cancel', e => {
    e.preventDefault();
    dispose();
  });
  const version = () => String(order.updated);
  const editable = () =>
    order.method === 'cash' &&
    ((order.payment === 'pending' && ['draft', 'awaiting_approval'].includes(order.status)) ||
      (order.payment === 'paid' && order.status === 'held'));
  function detail(parent, label, value) {
    const row = el('div', 'job-detail-row'),
      labelNode = el('strong', null, label),
      valueNode = el(
        'span',
        null,
        value === undefined || value === null || value === '' ? 'Not provided' : String(value)
      );
    row.append(labelNode, valueNode);
    parent.append(row);
  }
  function button(label, handler, primary = false) {
    const b = el('button', primary ? 'primary' : '', label);
    b.type = 'button';
    b.onclick = handler;
    return b;
  }
  async function runMutation(work) {
    if (mutating) return;
    mutating = true;
    dialog.setAttribute('aria-busy', 'true');
    close.disabled = true;
    if (fieldset) fieldset.disabled = true;
    footer.querySelectorAll('button').forEach(b => (b.disabled = true));
    try {
      await work();
    } catch (e) {
      feedback.textContent = e.message || 'Update failed. Reload this job and try again.';
    } finally {
      mutating = false;
      dialog.removeAttribute('aria-busy');
      close.disabled = false;
      if (fieldset) fieldset.disabled = !editable();
      footer
        .querySelectorAll('button')
        .forEach(b => (b.disabled = b.dataset.unavailable === 'true'));
    }
  }
  async function reloadJob(message) {
    await refresh();
    const state = await api('/api/admin/state'),
      fresh = state.orders.find(o => o.id === order.id);
    if (!fresh) throw Error('This job is no longer available.');
    order = fresh;
    opts = JSON.parse(fresh.options);
    pendingEdits.clear();
    pageNo = 1;
    build();
    feedback.textContent = message;
    await loadPreview();
  }
  function build() {
    summary.replaceChildren();
    for (const text of [
      order.status.replaceAll('_', ' '),
      order.payment + ' · ' + money(order.amount),
      order.pages +
        ' page' +
        (order.pages === 1 ? '' : 's') +
        ' · ' +
        opts.copies +
        ' cop' +
        (opts.copies === 1 ? 'y' : 'ies'),
    ])
      summary.append(el('span', null, text));
    tabs.replaceChildren();
    for (const [id, label] of [
      ['settings', 'Print settings'],
      ['files', 'Uploaded files'],
      ['details', 'Order details'],
    ]) {
      const b = button(label, () => {
        if (mutating) return;
        activeTab = id;
        build();
      });
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-controls', panel.id);
      b.setAttribute('aria-selected', String(id === activeTab));
      b.id = 'job-tab-' + id;
      b.tabIndex = id === activeTab ? 0 : -1;
      b.onkeydown = e => {
        if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
        e.preventDefault();
        const ids = ['settings', 'files', 'details'],
          i = ids.indexOf(activeTab);
        activeTab = ids[(i + (e.key === 'ArrowRight' ? 1 : 2)) % 3];
        build();
        tabs.querySelector('[aria-selected="true"]').focus();
      };
      tabs.append(b);
    }
    panel.setAttribute('aria-labelledby', 'job-tab-' + activeTab);
    panel.replaceChildren();
    footer.replaceChildren(feedback);
    fieldset = null;
    if (activeTab === 'settings') settings();
    else if (activeTab === 'files') files();
    else details();
    if (order.payment === 'paid' && order.status === 'queued')
      footer.append(
        button(
          'Pause & adjust',
          () =>
            runMutation(async () => {
              feedback.textContent = 'Pausing before the printer claims this job…';
              await api('/api/admin/orders/' + order.id, { action: 'hold', version: version() });
              await reloadJob('Job paused safely. Adjust settings, then resume printing.');
            }),
          true
        )
      );
    if (order.payment === 'paid' && order.status === 'held')
      footer.append(
        button(
          'Resume printing',
          () =>
            runMutation(async () => {
              feedback.textContent = 'Releasing held job…';
              await api('/api/admin/orders/' + order.id, { action: 'release', version: version() });
              await reloadJob('Job released. Preview shows the saved file.');
            }),
          true
        )
      );
  }
  function settings() {
    panel.append(el('h3', null, 'Print settings'));
    if (order.status === 'held')
      panel.append(
        el(
          'p',
          'notice',
          'Printing is paused. Paid orders can only be changed when the total stays the same. Save first, then resume printing.'
        )
      );
    else if (!editable())
      panel.append(
        el(
          'p',
          'notice',
          order.status === 'queued'
            ? 'Pause this queued job before adjusting. If the printer claims it first, editing stays locked.'
            : 'This job has reached the printer or is closed. Editing is locked.'
        )
      );
    const sourceAvailable = !!(opts.preparedSources?.length || opts.sourceFiles?.length),
      isId = opts.service === 'id',
      isResume = opts.service === 'resume',
      isPhoto = opts.service === 'passport';
    if (!sourceAvailable)
      panel.append(
        el(
          'p',
          'notice',
          'This older request has no retained source files. Copies, print mode and contact details remain available; document layout changes require a new upload.'
        )
      );
    const form = el('form', 'job-edit-form');
    fieldset = el('fieldset');
    fieldset.disabled = !editable();
    const controls = new Map();
    function field(
      key,
      label,
      { type = 'text', choices, min, max, maxLength, fixed = false, geometry = false } = {}
    ) {
      if (fixed) return;
      const wrap = el('label', 'job-field'),
        caption = el('span', null, label);
      let input;
      if (choices) {
        input = el('select');
        for (const [value, text] of choices) {
          const option = el('option', null, text);
          option.value = value;
          input.append(option);
        }
      } else {
        input = el(type === 'textarea' ? 'textarea' : 'input');
        if (type !== 'textarea') input.type = type;
      }
      const currentValue = pendingEdits.has(key) ? pendingEdits.get(key) : opts[key];
      if (type === 'checkbox') {
        input.checked = !!currentValue;
        wrap.classList.add('job-checkbox');
      } else input.value = currentValue ?? (key === 'rotation' ? 0 : '');
      if (min !== undefined) input.min = String(min);
      if (max !== undefined) input.max = String(max);
      if (maxLength) input.maxLength = maxLength;
      if (type === 'number') {
        input.step = '1';
        input.required = true;
      }
      if (key === 'mobile') {
        input.inputMode = 'numeric';
        input.pattern = '[0-9]{10}';
        input.placeholder = 'Optional10-digit number';
      }
      if (geometry && !sourceAvailable) input.disabled = true;
      input.name = key;
      input.setAttribute('aria-label', label);
      wrap.append(caption, input);
      fieldset.append(wrap);
      controls.set(key, { input, type, geometry });
      input.addEventListener('input', () =>
        pendingEdits.set(key, type === 'checkbox' ? input.checked : input.value)
      );
    }
    field('copies', isPhoto ? 'Photo sets' : 'Copies', {
      type: 'number',
      min: 1,
      max: isPhoto ? 10 : 100,
      fixed: isResume,
    });
    field('color', 'Print mode', {
      choices: [
        ['bw', 'B&W'],
        ['color', 'Color'],
      ],
      fixed: isPhoto,
    });
    field('duplex', 'Double-sided printing', {
      type: 'checkbox',
      fixed: isId || isResume || isPhoto,
    });
    field('paper', 'Paper size', {
      choices: ['A4', 'A3', 'A2', 'A1'].map(x => [x, x]),
      fixed: isId || isResume || isPhoto,
      geometry: true,
    });
    field('orientation', 'Page orientation', {
      choices: [
        ['portrait', 'Portrait'],
        ['landscape', 'Landscape'],
      ],
      fixed: isId || isPhoto || isResume,
      geometry: true,
    });
    field('range', 'Pages from original files', {
      maxLength: 3999,
      geometry: true,
      fixed: isId || isPhoto,
    });
    field('rotation', 'Rotate content', {
      choices: [
        [0, 'No rotation'],
        [90, '90°'],
        [180, '180°'],
        [270, '270°'],
      ],
      geometry: true,
    });
    if (isId) {
      field('idFormat', 'ID format', {
        choices: [
          ['plastic', 'Plastic card · actual size'],
          ['paper', 'Paper ID · keep proportions'],
        ],
        geometry: true,
      });
      field('swapSides', 'Swap front and back', {
        type: 'checkbox',
        geometry: true,
        fixed: opts.idSingle === true,
      });
    }
    field('customerName', 'Customer name', { maxLength: 80 });
    field('mobile', 'Mobile number', { type: 'tel', maxLength: 10 });
    field('notes', 'Print instructions', { type: 'textarea', maxLength: 300 });
    form.append(fieldset);
    panel.append(form);
    if (isId)
      panel.append(
        el('p', 'job-fixed-options', 'ID photocopy: one portrait A4 sheet, single sided.')
      );
    if (isResume)
      panel.append(
        el('p', 'job-fixed-options', 'Resume service: A4, one printed copy, single sided · ₹30.')
      );
    if (isPhoto)
      panel.append(
        el('p', 'job-fixed-options', 'Passport photos: color, portrait A4, single sided.')
      );
    form.onsubmit = e => {
      e.preventDefault();
      if (!editable() || !form.reportValidity()) return;
      const changed = {};
      for (const [key, { input, type }] of controls) {
        if (input.disabled) continue;
        const value =
          type === 'checkbox'
            ? input.checked
            : key === 'copies' || key === 'rotation'
              ? Number(input.value)
              : input.value.trim();
        const original = opts[key] ?? (key === 'rotation' ? 0 : type === 'checkbox' ? false : '');
        if (value !== original) changed[key] = value;
      }
      if (!Object.keys(changed).length) {
        feedback.textContent = 'No settings changed.';
        return;
      }
      runMutation(async () => {
        feedback.textContent = 'Rebuilding print preview from retained source…';
        await api('/api/admin/orders/' + order.id, {
          action: 'adjust',
          version: version(),
          options: changed,
        });
        await reloadJob('Saved. The preview and total now show the updated print file.');
      });
    };
    if (editable()) {
      footer.append(button('Save changes & update preview', () => form.requestSubmit(), true));
      if (isId) {
        const crop = button('Adjust ID crop', () => runMutation(recrop));
        crop.disabled = !(opts.idOriginals?.length || opts.sourceFiles?.length);
        if (crop.disabled) {
          crop.dataset.unavailable = 'true';
        }
        if (crop.disabled)
          crop.title = 'Original ID images were not retained for this older request.';
        footer.append(crop);
      }
    }
  }
  function files() {
    panel.append(el('h3', null, 'Uploaded files'));
    const sources = opts.sourceFiles || opts.idOriginals || [],
      manifest = opts.uploadManifest?.length
        ? opts.uploadManifest
        : sources.length
          ? sources
          : JSON.parse(order.names).map((name, index) => ({ name, index }));
    if (!sources.length)
      panel.append(
        el(
          'p',
          'notice',
          'Original downloads are unavailable for this older request. The prepared PDF remains visible on the left.'
        )
      );
    manifest.forEach((f, index) => {
      const card = el('article', 'source-file');
      card.append(el('h4', null, f.name || 'File ' + (index + 1)));
      detail(card, 'Type', f.type || 'Not recorded');
      detail(card, 'Size', size(f.size));
      detail(card, 'Original pages', f.pages);
      detail(card, 'Received', time(f.receivedAt || order.created));
      if (sources[index]) {
        const link = el('a', null, 'Download original');
        link.href = '/api/admin/orders/' + order.id + '/original/' + index;
        link.download = f.name || 'original';
        card.append(link);
      }
      panel.append(card);
    });
  }
  function details() {
    panel.append(el('h3', null, 'Order details'));
    for (const [label, value] of [
      ['Order number', order.id],
      ['Service', opts.service],
      ['Status', order.status],
      ['Payment', order.payment],
      ['Total', money(order.amount)],
      ['Prepared pages', order.pages],
      ['Copies', opts.copies],
      ['Paper', opts.paper + ' · ' + opts.orientation],
      ['Printer', order.printer || 'Shop mapping when queued'],
      ['Received', time(order.created)],
      ['Last updated', time(order.updated)],
      ['Customer', opts.customerName],
      ['Mobile', opts.mobile],
      ['Instructions', opts.notes || opts.customerNotes],
    ])
      detail(panel, label, value);
    panel.append(el('h3', null, 'Connection details'));
    const m = opts.customerMetadata || {};
    for (const [label, value] of [
      ['IP address', m.ip || 'Unavailable / local'],
      ['Device', m.device || 'Not recorded'],
      ['User agent', m.userAgent || 'Not recorded'],
      ['Metadata source', m.source || 'Not recorded'],
      ['Connection received', time(m.receivedAt || order.created)],
    ])
      detail(panel, label, value);
    panel.append(
      el(
        'p',
        'job-fixed-options',
        'Device and user-agent information is browser reported. IP is recorded only from the trusted hosting connection.'
      )
    );
  }
  async function recrop() {
    feedback.textContent = 'Loading original ID sides…';
    const corrected = [];
    for (let i = 0; i < (opts.idSingle ? 1 : 2); i++) {
      const response = await fetch('/api/admin/orders/' + order.id + '/original/' + i, {
        cache: 'no-store',
      });
      if (!response.ok)
        throw Error('Original ID images are unavailable or expired. Upload again to recrop.');
      const blob = await response.blob(),
        edited = await editIdCard(new File([blob], 'original-' + i, { type: blob.type }), {
          format: opts.idFormat || 'plastic',
          title: i ? 'Back side' : 'Front side',
        });
      if (!edited) {
        feedback.textContent = 'Crop cancelled. The saved order and originals are unchanged.';
        return;
      }
      corrected.push(edited.blob);
    }
    feedback.textContent = 'Saving corrected sides…';
    const form = new FormData();
    form.append('version', version());
    corrected.forEach((blob, i) =>
      form.append('files', new File([blob], 'corrected-' + i + '.png', { type: 'image/png' }))
    );
    await api('/api/admin/orders/' + order.id + '/recrop', form);
    await reloadJob('ID crop saved. Check both sides in the updated PDF preview.');
  }
  async function render() {
    if (!pdf || closed || rendering) return;
    const ticket = generation;
    rendering = true;
    prev.disabled = next.disabled = true;
    try {
      const page = await pdf.getPage(pageNo);
      if (closed || ticket !== generation) return;
      const base = page.getViewport({ scale: 1 }),
        viewport = page.getViewport({
          scale: Math.min(1.5, Math.max(200, viewer.clientWidth - 32) / base.width),
        }),
        dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.ceil(viewport.width * dpr);
      canvas.height = Math.ceil(viewport.height * dpr);
      canvas.style.width = Math.floor(viewport.width) + 'px';
      renderTask = page.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
        transform: [dpr, 0, 0, dpr, 0, 0],
      });
      await renderTask.promise;
      if (closed || ticket !== generation) return;
      status.textContent = '';
      pageLabel.textContent = pageNo + ' / ' + pdf.numPages;
      page.cleanup();
    } catch (e) {
      if (!closed && ticket === generation && e.name !== 'RenderingCancelledException')
        status.textContent = 'Preview could not render: ' + e.message;
    } finally {
      if (ticket === generation) rendering = false;
      if (!closed && ticket === generation) {
        prev.disabled = pageNo <= 1;
        next.disabled = !pdf || pageNo >= pdf.numPages;
      }
    }
  }
  async function loadPreview() {
    const ticket = ++generation;
    renderTask?.cancel();
    if (loadingTask) {
      await loadingTask.destroy().catch(() => {});
    }
    pdf = null;
    rendering = false;
    status.textContent = 'Loading prepared PDF…';
    canvas.width = canvas.height = 0;
    prev.disabled = next.disabled = true;
    try {
      const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist/build/pdf.mjs');
      if (closed || ticket !== generation) return;
      GlobalWorkerOptions.workerSrc = '/pdf.worker.js';
      loadingTask = getDocument({
        url: '/api/orders/' + order.token + '/file?v=' + version(),
        isEvalSupported: false,
        useSystemFonts: true,
      });
      const loaded = await loadingTask.promise;
      if (closed || ticket !== generation) return;
      pdf = loaded;
      await render();
    } catch (e) {
      if (!closed && ticket === generation)
        status.textContent = 'Preview unavailable: ' + e.message;
    }
  }
  prev.onclick = () => {
    if (!rendering && pageNo > 1) {
      pageNo--;
      render();
    }
  };
  next.onclick = () => {
    if (!rendering && pdf && pageNo < pdf.numPages) {
      pageNo++;
      render();
    }
  };
  build();
  await loadPreview();
}
