import {
  parsePages,
  paymentProfile,
  photoPackagePrice,
  quote,
  validateOptions,
} from '../lib/core.js';
import { createCropWorkspace } from './crop-workspace.js';
import { escapeHtml } from './html.js';
import { autoCropIdCard, editIdCard } from './id-workspace.js';
import { createPhotoPackageSelector } from './photo-ui.js';
import { createResumeBuilder } from './resume-builder.js';
import { studioArt, welcomeScene } from './studio-art.js';

const esc = escapeHtml;
const money = n => '₹' + (Number(n || 0) / 100).toFixed(2);

const SERVICES = [
  {
    id: 'document',
    icon: '📄',
    name: 'Document Print',
    desc: 'PDF, JPG, PNG · Page range & copies',
  },
  { id: 'id', icon: '🪪', name: 'ID / Aadhaar Card', desc: 'Front & back on one A4 sheet' },
  { id: 'resume', icon: '📋', name: 'Resume Maker', desc: 'Choose format & font · A4 · ₹30' },
];

const STORAGE_KEY = 'shri-csp-v3';
const MAX_FILES = 10;
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_TOTAL_SIZE = 40 * 1024 * 1024;

let config = null;
let visitId = null;
let visitKeepaliveTimer = null;
let visitRetryCount = 0;
const MAX_VISIT_RETRIES = 3;

const state = {
  screen: 'service',
  service: null,
  files: [],
  pageCounts: [],
  originalFile: null,
  idOriginals: [],
  idApplied: [],
  idEditing: false,
  cropWorkspace: null,
  cropApproved: false,
  appliedCrop: null,
  pkgSelector: null,
  resumeBuilder: null,
  resumeFile: null,
  options: {
    service: null,
    color: 'bw',
    copies: 1,
    paper: 'A4',
    range: '',
    orientation: 'portrait',
    duplex: false,
    mobile: '',
    photoQty: 5,
  },
  draft: null,
  previewBusy: false,
  submitting: false,
};

function loadPrefs() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      state.options = { ...state.options, ...parsed.options };
      state.service = parsed.service;
    }
  } catch {}
}

function savePrefs() {
  try {
    const { customerName, mobile, notes, ...printOptions } = state.options;
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ service: state.service || 'document', options: printOptions })
    );
  } catch {}
}

function $(sel, ctx = document) {
  return ctx.querySelector(sel);
}
function $$(sel, ctx = document) {
  return ctx.querySelectorAll(sel);
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k.startsWith('on') && typeof v === 'function')
      e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.entries(v).forEach(([dk, dv]) => (e.dataset[dk] = dv));
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else e.setAttribute(k, v);
  });
  children.flat().forEach(c => {
    if (c instanceof Node) e.appendChild(c);
    else if (c != null) e.appendChild(document.createTextNode(String(c)));
  });
  return e;
}

function toast(msg, type = 'info') {
  let c = $('#csp-toasts');
  if (!c) {
    c = el('div', { id: 'csp-toasts', class: 'csp-toast-container' });
    document.body.appendChild(c);
  }
  const t = el('div', { class: `csp-toast csp-toast-${type}` }, msg);
  c.appendChild(t);
  setTimeout(() => {
    t.style.animation = 'csp-toast-in 0.2s reverse';
    setTimeout(() => t.remove(), 200);
  }, 3500);
}

function showScreen(name) {
  $$('.csp-screen').forEach(s => s.classList.toggle('active', s.dataset.screen === name));
  state.screen = name;
  if (name === 'settings') updateSettingsUI();
  if (name === 'final') renderFinalPage();
  updateBreadcrumb();
  updateBottomBar();
  persistVisit({ stage: screenToStage(name) });
}

function screenToStage(s) {
  return (
    {
      service: 'opened',
      upload: 'upload',
      settings: 'settings',
      crop: 'settings',
      resume: 'upload',
      review: 'review',
    }[s] || 'opened'
  );
}

function updateBreadcrumb() {
  const labels = {
    service: 'Service',
    upload: 'Upload',
    settings: 'Settings',
    crop: 'Crop',
    resume: 'Resume',
    review: 'Review',
  };
  const steps = ['service', 'upload', 'settings', 'review'];
  const currentIdx = steps.indexOf(
    state.screen.replace('crop', 'settings').replace('resume', 'upload')
  );
  const stepNodes = steps.slice(0, currentIdx + 1).map((s, i) =>
    el(
      'span',
      {
        class: 'csp-breadcrumb-item' + (i ? ' csp-breadcrumb-sep' : ''),
        style: 'display:inline-flex;align-items:center;gap:4px;',
      },
      i ? el('span', { class: 'csp-breadcrumb-sep' }, '›') : null,
      el('span', { class: i === currentIdx ? 'csp-breadcrumb-current' : '' }, labels[s])
    )
  );
  $('#csp-breadcrumb').replaceChildren(...stepNodes);
}

function persistVisit(extra = {}) {
  if (!visitId) return;
  const filesInfo = state.files.map((f, i) => ({
    name: f.name,
    size: f.size,
    pages: state.pageCounts[i] || 1,
  }));
  const payload = {
    id: visitId,
    service: state.service,
    stage: extra.stage || screenToStage(state.screen),
    files: filesInfo,
    options: {
      color: state.options.color,
      copies: state.options.copies,
      paper: state.options.paper,
      duplex: state.options.duplex,
      method: state.options.method,
      paymentChannel: state.options.paymentChannel,
    },
    orderToken: state.draft?.token,
    ...extra,
  };
  fetch('/api/visits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {
    visitRetryCount++;
    if (visitRetryCount < MAX_VISIT_RETRIES)
      setTimeout(() => persistVisit(extra), 1000 * visitRetryCount);
  });
}

function startVisitKeepalive() {
  stopVisitKeepalive();
  visitKeepaliveTimer = setInterval(() => persistVisit(), 30000);
}
function stopVisitKeepalive() {
  if (visitKeepaliveTimer) {
    clearInterval(visitKeepaliveTimer);
    visitKeepaliveTimer = null;
  }
}

async function initVisit() {
  visitId = crypto.randomUUID();
  await persistVisit({ stage: 'opened', service: 'document' });
  startVisitKeepalive();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') persistVisit();
  });
}

function renderApp() {
  const app = $('#app');
  app.innerHTML = '';
  app.className = 'csp-app';
  document.body.className = 'customer-v3-page';

  app.appendChild(
    el(
      'header',
      { class: 'csp-topbar' },
      el(
        'a',
        { class: 'csp-logo', href: '/' },
        el('span', { class: 'csp-logo-mark', 'aria-hidden': 'true' }, 'S'),
        el('span', { class: 'csp-logo-text' }, config.shopName || 'SHRI CSC CENTER')
      ),
      el(
        'div',
        { class: 'csp-topbar-right' },
        el('span', { class: 'csp-shop-tag' }, 'Customer Print Desk')
      )
    )
  );

  const main = el('main', { class: 'csp-main' });
  main.appendChild(
    el('nav', { id: 'csp-breadcrumb', class: 'csp-breadcrumb', 'aria-label': 'Progress' })
  );

  const screens = [
    renderServiceScreen(),
    renderUploadScreen(),
    renderSettingsScreen(),
    renderCropScreen(),
    renderResumeScreen(),
    renderReviewScreen(),
  ];
  screens.forEach(s => main.appendChild(s));
  app.appendChild(main);

  app.appendChild(renderBottomBar());
  app.appendChild(renderCropModal());

  if (!$('#csp-toasts')) {
    document.body.appendChild(el('div', { id: 'csp-toasts', class: 'csp-toast-container' }));
  }

  bindServiceEvents();
  bindUploadEvents();
  const contact = el(
    'section',
    { class: 'csp-contact-card' },
    el('h3', {}, 'Your details'),
    el(
      'p',
      { class: 'csp-hint' },
      'Optional, so staff can identify your files and instructions. Order files and basic connection details are stored privately for fulfilment.'
    )
  );
  for (const id of ['#csp-customer-name', '#csp-mobile', '#csp-order-notes']) {
    const field = $(id)?.closest('.csp-settings-section');
    if (field) contact.appendChild(field);
  }
  $('.csp-screen[data-screen="settings"] .csp-panel-body').appendChild(contact);
  bindSettingsEvents();
  bindCropEvents();
  bindBottomBarEvents();
  bindReviewEvents();

  // Keep first screen unselected.
  if (state.service) {
    applyServiceDefaults();
    showScreen('upload');
  } else {
    showScreen('service');
  }
}

function renderServiceScreen() {
  return el(
    'section',
    { class: 'csp-screen', 'data-screen': 'service' },
    el(
      'div',
      { class: 'csp-panel service-studio' },
      welcomeScene(),
      el(
        'div',
        { class: 'csp-panel-head' },
        el('h2', { class: 'csp-panel-title' }, 'What are we making?'),
        el('p', { class: 'csp-panel-subtitle' }, 'What would you like us to prepare?')
      ),
      el(
        'div',
        { class: 'csp-panel-body' },
        el(
          'div',
          { class: 'csp-service-grid', role: 'radiogroup', 'aria-label': 'Print services' },
          ...SERVICES.map(s =>
            el(
              'button',
              {
                class: 'csp-service-btn',
                type: 'button',
                role: 'radio',
                'aria-checked': 'false',
                'data-service': s.id,
                tabindex: '0',
              },
              el(
                'span',
                { class: 'csp-service-icon', 'aria-hidden': 'true' },
                studioArt(s.id === 'document' ? 'print' : s.id)
              ),
              el(
                'div',
                { class: 'csp-service-info' },
                el('strong', { class: 'csp-service-name' }, s.name),
                el('span', { class: 'csp-service-desc' }, s.desc)
              )
            )
          )
        )
      )
    )
  );
}

function renderUploadScreen() {
  return el(
    'section',
    { class: 'csp-screen', 'data-screen': 'upload' },
    el(
      'div',
      { class: 'csp-panel', id: 'csp-upload-panel' },
      el(
        'div',
        { class: 'csp-panel-head' },
        el('h2', { class: 'csp-panel-title', id: 'csp-upload-title' }, ''),
        el('p', { class: 'csp-panel-subtitle', id: 'csp-upload-subtitle' }, '')
      ),
      el(
        'div',
        { class: 'csp-panel-body' },
        el('div', { id: 'csp-service-specific', class: 'csp-service-specific' }),
        el(
          'div',
          {
            class: 'csp-upload-zone',
            id: 'csp-upload-zone',
            tabindex: '0',
            role: 'button',
            'aria-label': 'Upload files',
          },
          el(
            'svg',
            {
              class: 'csp-upload-icon',
              viewBox: '0 0 24 24',
              fill: 'none',
              stroke: 'currentColor',
              'stroke-width': '1.5',
              'aria-hidden': 'true',
            },
            el('path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }),
            el('polyline', { points: '17 8 12 3 7 8' }),
            el('line', { x1: '12', y1: '3', x2: '12', y2: '15' })
          ),
          el('strong', { class: 'csp-upload-title', id: 'csp-zone-title' }, ''),
          el('span', { class: 'csp-upload-hint', id: 'csp-zone-hint' }, ''),
          el('div', {
            class: 'csp-upload-formats',
            id: 'csp-zone-formats',
            'aria-label': 'Accepted formats',
          }),
          el('input', {
            class: 'csp-upload-input',
            type: 'file',
            id: 'csp-file-input',
            'aria-label': 'Select files',
          })
        ),
        el('div', {
          class: 'csp-file-list',
          id: 'csp-file-list',
          role: 'list',
          'aria-label': 'Selected files',
        }),
        el(
          'p',
          { class: 'csp-hint' },
          `Files are removed after ${config?.retentionHours || 24} hours. Keep your order link private.`
        )
      )
    )
  );
}

function renderSettingsScreen() {
  return el(
    'section',
    { class: 'csp-screen', 'data-screen': 'settings' },
    el(
      'div',
      { class: 'csp-panel' },
      el(
        'div',
        { class: 'csp-panel-head' },
        el('h2', { class: 'csp-panel-title' }, 'Print Settings'),
        el('p', { class: 'csp-panel-subtitle' }, 'Configure your print options')
      ),
      el(
        'div',
        { class: 'csp-panel-body' },
        el(
          'div',
          { class: 'csp-settings-section' },
          el('h3', { class: 'csp-section-title' }, 'Print Mode'),
          el(
            'div',
            { class: 'csp-segmented', role: 'radiogroup', 'aria-label': 'Print mode' },
            el(
              'button',
              {
                type: 'button',
                class: 'csp-segmented-btn',
                role: 'radio',
                'aria-checked': 'true',
                'data-color': 'bw',
                tabindex: '0',
              },
              'B&W'
            ),
            el(
              'button',
              {
                type: 'button',
                class: 'csp-segmented-btn',
                role: 'radio',
                'aria-checked': 'false',
                'data-color': 'color',
                tabindex: '0',
              },
              'Color'
            )
          )
        ),
        el(
          'div',
          { class: 'csp-settings-section' },
          el('h3', { class: 'csp-section-title' }, 'Copies'),
          el(
            'div',
            { class: 'csp-stepper', role: 'group', 'aria-label': 'Number of copies' },
            el(
              'button',
              {
                type: 'button',
                class: 'csp-stepper-btn',
                'data-action': 'decrease',
                'aria-label': 'Decrease copies',
              },
              '−'
            ),
            el(
              'span',
              { class: 'csp-stepper-value', id: 'csp-copies-value', 'aria-live': 'polite' },
              '1'
            ),
            el(
              'button',
              {
                type: 'button',
                class: 'csp-stepper-btn',
                'data-action': 'increase',
                'aria-label': 'Increase copies',
              },
              '+'
            )
          )
        ),
        el(
          'div',
          { class: 'csp-settings-section' },
          el('h3', { class: 'csp-section-title' }, 'Sides'),
          el(
            'div',
            { class: 'csp-segmented', role: 'radiogroup', 'aria-label': 'Single or double sided' },
            el(
              'button',
              {
                type: 'button',
                class: 'csp-segmented-btn',
                role: 'radio',
                'aria-checked': 'true',
                'data-duplex': 'false',
                tabindex: '0',
              },
              'Single sided'
            ),
            el(
              'button',
              {
                type: 'button',
                class: 'csp-segmented-btn',
                role: 'radio',
                'aria-checked': 'false',
                'data-duplex': 'true',
                tabindex: '0',
              },
              'Double sided'
            )
          ),
          el(
            'p',
            { class: 'csp-hint', id: 'csp-duplex-hint' },
            'B&W A4 duplex: ₹5 per both-side sheet; odd last page ₹3. Applied per copy.'
          )
        ),
        el(
          'details',
          { class: 'csp-accordion', id: 'csp-more-settings' },
          el(
            'summary',
            { class: 'csp-accordion-summary' },
            'More settings',
            el(
              'svg',
              {
                class: 'csp-accordion-chevron',
                viewBox: '0 0 24 24',
                fill: 'none',
                stroke: 'currentColor',
                'stroke-width': '2',
                'aria-hidden': 'true',
              },
              el('polyline', { points: '6 9 12 15 18 9' })
            )
          ),
          el(
            'div',
            { class: 'csp-accordion-body' },
            el(
              'div',
              { class: 'csp-settings-section' },
              el('label', { class: 'csp-label', for: 'csp-paper' }, 'Paper Size'),
              el(
                'select',
                { class: 'csp-select', id: 'csp-paper', 'aria-label': 'Paper size' },
                ...['A4', 'A3', 'A2', 'A1'].map(v => el('option', { value: v }, v))
              )
            ),
            el(
              'div',
              { class: 'csp-settings-section' },
              el('label', { class: 'csp-label', for: 'csp-orientation' }, 'Orientation'),
              el(
                'select',
                { class: 'csp-select', id: 'csp-orientation', 'aria-label': 'Orientation' },
                el('option', { value: 'portrait' }, 'Portrait'),
                el('option', { value: 'landscape' }, 'Landscape')
              )
            ),
            el(
              'div',
              { class: 'csp-settings-section' },
              el('label', { class: 'csp-label', for: 'csp-range' }, 'Page Range'),
              el('input', {
                class: 'csp-input',
                type: 'text',
                id: 'csp-range',
                placeholder: 'e.g. 1-3,5',
                'aria-label': 'Page range',
              }),
              el('p', { class: 'csp-hint' }, 'Leave blank for all pages')
            ),
            el(
              'div',
              { class: 'csp-settings-section' },
              el('label', { class: 'csp-label', for: 'csp-customer-name' }, 'Name (optional)'),
              el('input', {
                class: 'csp-input',
                type: 'text',
                id: 'csp-customer-name',
                maxlength: '80',
                autocomplete: 'name',
                'aria-label': 'Customer name',
              })
            ),
            el(
              'div',
              { class: 'csp-settings-section' },
              el('label', { class: 'csp-label', for: 'csp-mobile' }, 'Mobile (optional)'),
              el('input', {
                class: 'csp-input',
                type: 'tel',
                id: 'csp-mobile',
                placeholder: '10-digit number',
                maxlength: '10',
                inputmode: 'numeric',
                'aria-label': 'Mobile number',
              })
            ),
            el(
              'div',
              { class: 'csp-settings-section' },
              el(
                'label',
                { class: 'csp-label', for: 'csp-order-notes' },
                'Instructions (optional)'
              ),
              el('textarea', {
                class: 'csp-input',
                id: 'csp-order-notes',
                rows: '2',
                maxlength: '300',
                placeholder: 'Anything staff should know',
                'aria-label': 'Order instructions',
              })
            )
          )
        )
      ),
      el(
        'div',
        { class: 'csp-settings-section' },
        el('h3', { class: 'csp-section-title' }, 'Payment Method'),
        el('div', {
          class: 'csp-segmented',
          role: 'radiogroup',
          'aria-label': 'Payment method',
          id: 'csp-method-segmented',
        })
      ),
      el(
        'div',
        { class: 'csp-price-line', id: 'csp-price-line' },
        el('span', {}, 'Estimated'),
        el('strong', { id: 'csp-price-value' }, '₹0.00')
      ),
      el(
        'p',
        { class: 'csp-price-help', id: 'csp-price-help' },
        'Select files to calculate your total.'
      )
    )
  );
}

function renderCropScreen() {
  return el(
    'section',
    { class: 'csp-screen', 'data-screen': 'crop' },
    el(
      'div',
      { class: 'csp-panel' },
      el(
        'div',
        { class: 'csp-panel-head' },
        el('h2', { class: 'csp-panel-title' }, 'Crop & Align Photo'),
        el(
          'p',
          { class: 'csp-panel-subtitle' },
          'Adjust the crop to frame the face. 35:45 aspect ratio maintained.'
        )
      ),
      el(
        'div',
        { class: 'csp-panel-body' },
        el('div', { id: 'csp-crop-host', class: 'csp-crop-host' }),
        el(
          'p',
          { class: 'csp-hint' },
          'Choose a clear portrait. Photos are processed on this device; check the final PDF before sending.'
        )
      )
    )
  );
}

function renderResumeScreen() {
  return el(
    'section',
    { class: 'csp-screen', 'data-screen': 'resume' },
    el(
      'div',
      { class: 'csp-panel' },
      el(
        'div',
        { class: 'csp-panel-head' },
        el('h2', { class: 'csp-panel-title' }, 'Resume'),
        el('p', { class: 'csp-panel-subtitle' }, 'Upload existing or create a new resume')
      ),
      el('div', { class: 'csp-panel-body' }, el('div', { id: 'csp-resume-root' }))
    )
  );
}

function renderReviewScreen() {
  return el(
    'section',
    { class: 'csp-screen', 'data-screen': 'review' },
    el(
      'div',
      { class: 'csp-panel' },
      el(
        'div',
        { class: 'csp-panel-head' },
        el('h2', { class: 'csp-panel-title' }, 'Review & Confirm'),
        el('p', { class: 'csp-panel-subtitle' }, 'Check everything looks correct before sending')
      ),
      el(
        'div',
        { class: 'csp-panel-body', id: 'csp-review-body' },
        el(
          'p',
          { class: 'csp-hint', style: 'text-align:center;padding:40px 0;' },
          'Preparing preview…'
        )
      )
    )
  );
}

function renderBottomBar() {
  return el(
    'div',
    { class: 'csp-bottombar', id: 'csp-bottombar' },
    el(
      'div',
      { class: 'csp-bottombar-inner' },
      el('button', { type: 'button', class: 'csp-btn secondary', id: 'csp-btn-back' }, 'Back'),
      el(
        'button',
        { type: 'button', class: 'csp-btn primary', id: 'csp-btn-next' },
        el('span', { id: 'csp-btn-next-text' }, 'Next'),
        el('span', { class: 'csp-spinner', style: 'display:none' })
      )
    )
  );
}

function renderCropModal() {
  return el(
    'div',
    {
      class: 'csp-crop-modal',
      id: 'csp-crop-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'csp-crop-title',
    },
    el(
      'div',
      { class: 'csp-crop-content' },
      el(
        'header',
        { class: 'csp-crop-header' },
        el('h2', { id: 'csp-crop-title', class: 'csp-crop-title' }, 'Crop & Align'),
        el('span', { id: 'csp-crop-status', class: 'csp-crop-status' }, 'Loading…')
      ),
      el(
        'div',
        { class: 'csp-crop-toolbar', role: 'toolbar', 'aria-label': 'Crop tools' },
        el(
          'div',
          { class: 'csp-crop-toolbar-group' },
          el(
            'button',
            {
              type: 'button',
              class: 'csp-crop-tool',
              id: 'csp-crop-zoom-out',
              'aria-label': 'Zoom out',
            },
            '−'
          ),
          el('input', {
            type: 'range',
            id: 'csp-crop-zoom-range',
            min: '1',
            max: '3',
            step: '0.1',
            value: '1',
            'aria-label': 'Zoom level',
          }),
          el(
            'button',
            {
              type: 'button',
              class: 'csp-crop-tool',
              id: 'csp-crop-zoom-in',
              'aria-label': 'Zoom in',
            },
            '+'
          ),
          el(
            'button',
            {
              type: 'button',
              class: 'csp-crop-tool',
              id: 'csp-crop-zoom-reset',
              'aria-label': 'Reset zoom',
            },
            '1:1'
          )
        ),
        el(
          'div',
          { class: 'csp-crop-toolbar-group' },
          el(
            'button',
            {
              type: 'button',
              class: 'csp-crop-tool',
              id: 'csp-crop-rotate-left',
              'aria-label': 'Rotate left',
            },
            '↶ 90°'
          ),
          el(
            'button',
            {
              type: 'button',
              class: 'csp-crop-tool',
              id: 'csp-crop-rotate-right',
              'aria-label': 'Rotate right',
            },
            '↷ 90°'
          )
        ),
        el(
          'div',
          { class: 'csp-crop-toolbar-group' },
          el(
            'button',
            {
              type: 'button',
              class: 'csp-crop-tool',
              id: 'csp-crop-reset',
              'aria-label': 'Reset to face detection',
            },
            'Reset'
          )
        )
      ),
      el('div', { id: 'csp-crop-host-modal', class: 'csp-crop-host' }),
      el(
        'footer',
        { class: 'csp-crop-footer' },
        el(
          'button',
          { type: 'button', class: 'csp-btn secondary', id: 'csp-crop-cancel' },
          'Cancel'
        ),
        el(
          'button',
          { type: 'button', class: 'csp-btn primary', id: 'csp-crop-apply' },
          el('span', {}, 'Apply Crop'),
          el('span', { class: 'csp-spinner', style: 'display:none' })
        )
      )
    )
  );
}

function updateUploadUI() {
  const isPassport = state.service === 'passport';
  const isID = state.service === 'id';
  const isResume = state.service === 'resume';
  const accept = isPassport
    ? 'image/jpeg,image/png'
    : isResume
      ? 'application/pdf,image/jpeg,image/png'
      : 'application/pdf,image/jpeg,image/png';
  const multiple = !isPassport && !isID;
  const hint = isPassport
    ? 'One portrait JPG/PNG · up to 25 MB'
    : isID
      ? 'Front & back JPG/PNG · up to 25 MB each'
      : isResume
        ? 'PDF, JPG or PNG · up to 25 MB each · 40 MB total'
        : 'PDF, JPG or PNG · up to 25 MB each · 40 MB total';

  $('#csp-upload-title').textContent = isPassport
    ? 'Upload Passport Photo'
    : isID
      ? 'Upload ID Card'
      : isResume
        ? 'Resume Maker'
        : 'Upload Documents';
  $('#csp-upload-subtitle').textContent = isPassport
    ? '35×45 mm · color only'
    : isID
      ? 'Front & back on one A4 sheet'
      : isResume
        ? '₹30 includes your generated resume and one A4 copy'
        : 'Page range & copies';
  $('#csp-zone-title').textContent = isPassport
    ? 'Upload Passport Photo'
    : isID
      ? 'Upload ID Card Images'
      : isResume
        ? 'Upload Resume'
        : 'Upload Documents';
  $('#csp-zone-hint').textContent = hint;
  const uploadZone = $('#csp-upload-zone');
  uploadZone.hidden = isResume;
  uploadZone.style.display = isResume ? 'none' : '';

  const formatsEl = $('#csp-zone-formats');
  formatsEl.replaceChildren(
    ...accept
      .split(',')
      .map(f => el('span', { class: 'csp-upload-format' }, f.replace('.', '').toUpperCase()))
  );

  const fileInput = $('#csp-file-input');
  fileInput.accept = accept;
  fileInput.multiple = multiple;
  fileInput.disabled = isResume;

  const specific = $('#csp-service-specific');
  specific.innerHTML = '';
  if (isPassport && state.pkgSelector) {
    specific.appendChild(state.pkgSelector.element);
  } else if (isID) {
    specific.appendChild(
      el(
        'p',
        { class: 'csp-id-instruction' },
        'Upload front first, then back. Clear cards crop automatically on this device. Check the PDF or use Adjust crop. Originals are saved privately with your order so shop staff can correct the crop.'
      )
    );
    const format = el(
      'select',
      { class: 'csp-select', id: 'csp-id-format', 'aria-label': 'ID print format' },
      el('option', { value: 'plastic' }, 'Plastic card · 85.6 × 54 mm'),
      el('option', { value: 'paper' }, 'Paper Aadhaar / other ID · keep proportions')
    );
    format.value = state.options.idFormat || 'plastic';
    format.disabled = state.idEditing;
    format.addEventListener('change', async () => {
      state.options.idFormat = format.value;
      state.idApplied = [];
      state.draft = null;
      state.files = [...state.idOriginals];
      renderFilePreviews();
      updateBottomBar();
      await editPendingIdSides();
    });
    specific.appendChild(el('label', { class: 'csp-label' }, 'Card format', format));
    const single = el('input', { type: 'checkbox', id: 'csp-id-single' });
    single.checked = state.options.idSingle === true;
    single.disabled = state.files.length > 1 || state.idEditing;
    single.addEventListener('change', () => {
      state.options.idSingle = single.checked;
      state.draft = null;
      updatePrice();
      updateBottomBar();
      updateUploadUI();
    });
    specific.appendChild(
      el(
        'label',
        { class: 'csp-checkbox-line' },
        single,
        el('span', {}, 'Print one side only (intentional)')
      )
    );
    if (state.files.length === 2) {
      const swap = el(
        'button',
        {
          type: 'button',
          class: 'csp-btn secondary',
          onClick: () => {
            if (state.idEditing) return;
            state.files.reverse();
            state.idOriginals.reverse();
            state.idApplied.reverse();
            state.draft = null;
            renderFilePreviews();
            updateBottomBar();
          },
        },
        'Swap front / back'
      );
      swap.disabled = state.idEditing;
      specific.appendChild(swap);
    }
  } else if (isResume && state.resumeBuilder) {
    specific.appendChild(state.resumeBuilder.element);
  }
}

function renderFilePreviews() {
  const list = $('#csp-file-list');
  if (state.files.length === 0) {
    list.innerHTML = '';
    list.style.display = 'none';
    return;
  }
  list.style.display = 'flex';
  list.querySelectorAll('img[src^="blob:"]').forEach(img => URL.revokeObjectURL(img.src));
  list.innerHTML = '';
  state.files.forEach((f, i) => {
    const pages = state.pageCounts[i] || 1;
    const isImage = f.type.startsWith('image/');
    // Create removable × button with visible dark contrast, 44px tap target
    const removeBtn = el(
      'button',
      {
        class: 'csp-file-remove',
        'data-index': i,
        'aria-label': `Remove ${esc(f.name)}`,
        style:
          'width:44px;height:44px;border-radius:calc(var(--csp-radius-pill));border:1.5px solid var(--csp-ink);background:#12304a;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:20px;cursor:pointer;transition:all 0.15s;',
      },
      '×'
    );
    removeBtn.addEventListener('mouseover', () => {
      removeBtn.style.background = '#d64550';
      removeBtn.style.color = '#fff';
    });
    removeBtn.addEventListener('mouseout', () => {
      removeBtn.style.background = '#12304a';
      removeBtn.style.color = '#fff';
    });
    removeBtn.addEventListener('focus', () => {
      removeBtn.style.background = '#0e76c4';
      removeBtn.style.color = '#fff';
    });
    removeBtn.addEventListener('blur', () => {
      removeBtn.style.background = '#12304a';
      removeBtn.style.color = '#fff';
    });

    list.appendChild(
      el(
        'div',
        { class: 'csp-file-item', role: 'listitem' },
        isImage
          ? el('img', {
              class: 'csp-file-icon',
              src: URL.createObjectURL(f),
              alt: '',
              style: 'object-fit:cover;',
            })
          : el(
              'div',
              {
                class: 'csp-file-icon',
                'aria-hidden': 'true',
                style:
                  'width:32px;height:32px;border-radius:8px;background:#0a5a96;color:#d8ecfa;display:flex;align-items:center;justify-content:center;font-size:16px;',
              },
              '📄'
            ),
        el(
          'div',
          { class: 'csp-file-info' },
          el('div', { class: 'csp-file-name' }, f.name),
          el(
            'div',
            { class: 'csp-file-meta' },
            state.service === 'id'
              ? `${i ? 'Back' : 'Front'} · ${state.idApplied[i] ? 'Crop applied' : 'Crop needs checking'}`
              : `${pages} page(s) · ${(f.size / 1024 / 1024).toFixed(2)} MB`
          ),
          state.service === 'id'
            ? el(
                'button',
                {
                  type: 'button',
                  class: 'csp-btn secondary',
                  'data-id-edit': i,
                  onClick: () => editIdSide(i),
                },
                'Adjust crop'
              )
            : null
        ),
        removeBtn
      )
    );
  });
}

function updateSettingsUI() {
  const isPassport = state.service === 'passport';
  const isID = state.service === 'id';

  $$('.csp-segmented-btn[data-color]').forEach(b => {
    b.classList.toggle('active', b.dataset.color === state.options.color);
    b.setAttribute('aria-checked', b.dataset.color === state.options.color);
  });

  $('#csp-copies-value').textContent = state.options.copies;

  const sidesSection = $('.csp-segmented[aria-label="Single or double sided"]').closest(
    '.csp-settings-section'
  );
  const fixedLayout = isID || state.service === 'resume';
  sidesSection.hidden = fixedLayout;
  let layoutNote = $('#csp-fixed-layout-note');
  if (!layoutNote) {
    layoutNote = el('p', { id: 'csp-fixed-layout-note', class: 'csp-hint' });
    sidesSection.before(layoutNote);
  }
  layoutNote.hidden = !fixedLayout;
  layoutNote.textContent = isID
    ? state.options.idSingle
      ? 'One selected ID side on one A4 sheet.'
      : 'Front and back together on one A4 sheet.'
    : 'Resume package includes one single-sided A4 copy.';

  $$('.csp-segmented-btn[data-duplex]').forEach(b => {
    const active = b.dataset.duplex === String(state.options.duplex);
    b.classList.toggle('active', active);
    b.setAttribute('aria-checked', active);
  });

  const duplexHint = $('#csp-duplex-hint');
  if (state.options.color === 'bw' && state.options.paper === 'A4' && state.options.duplex) {
    duplexHint.textContent =
      'B&W A4 duplex: ₹5 per both-side sheet; odd last page ₹3. Applied per copy.';
  } else if (state.options.duplex) {
    duplexHint.textContent = 'Double-sided printing applies per copy.';
  } else {
    duplexHint.textContent = 'Single-sided printing.';
  }

  $('#csp-paper').value = state.options.paper;
  $('#csp-orientation').value = state.options.orientation;
  $('#csp-range').value = state.options.range;
  $('#csp-mobile').value = state.options.mobile;
  $('#csp-customer-name').value = state.options.customerName || '';
  $('#csp-order-notes').value = state.options.notes || '';

  if (isPassport || isID || state.service === 'resume') {
    $('#csp-paper').disabled = true;
    $('#csp-orientation').disabled = true;
    $('#csp-range').disabled = true;
    $$('.csp-segmented-btn[data-color]').forEach(b => (b.disabled = isPassport));
    $$('.csp-segmented-btn[data-duplex]').forEach(b => (b.disabled = true));
    if (isPassport) {
      state.options.paper = 'A4';
      state.options.color = 'color';
      state.options.orientation = 'portrait';
      state.options.duplex = false;
      state.options.range = '';
    }
    if (isID) {
      state.options.paper = 'A4';
      state.options.orientation = 'portrait';
      state.options.duplex = false;
      state.options.range = '';
    }
    if (state.service === 'resume') {
      state.options.paper = 'A4';
      state.options.orientation = 'portrait';
      state.options.duplex = false;
      state.options.range = '';
      state.options.copies = 1;
    }
  } else {
    $('#csp-paper').disabled = false;
    $('#csp-orientation').disabled = false;
    $('#csp-range').disabled = false;
    $$('.csp-segmented-btn[data-color]').forEach(b => (b.disabled = false));
    $$('.csp-segmented-btn[data-duplex]').forEach(b => (b.disabled = false));
  }
  $('#csp-copies-value')
    .parentElement.querySelectorAll('button')
    .forEach(b => (b.disabled = state.service === 'resume'));
  $('#csp-copies-value').textContent = state.options.copies;

  renderMethodSegmented();
  updatePrice();
  debouncedPersistVisit();
}

function renderMethodSegmented() {
  const container = $('#csp-method-segmented');
  const methods = [];
  methods.push(['cash', 'Pay at Desk']);

  let currentMethod = state.options.method;
  if (!methods.some(m => m[0] === currentMethod)) {
    currentMethod = methods[0][0];
  }
  state.options.method = currentMethod;

  const nodes = methods.map(([v, n]) =>
    el(
      'button',
      {
        type: 'button',
        class: 'csp-segmented-btn' + (v === currentMethod ? ' active' : ''),
        role: 'radio',
        'aria-checked': v === currentMethod,
        'data-method': v,
        tabindex: '0',
      },
      n
    )
  );
  container.replaceChildren(...nodes);
}

function updatePrice() {
  const isPassport = state.service === 'passport';
  const isID = state.service === 'id';
  let amount = 0,
    error = 'Select files to calculate your total.',
    lines = [];

  try {
    if (isPassport) {
      if (!state.files.length) throw new Error('Upload a photo first.');
      amount = photoPackagePrice(state.options.photoQty, config) * state.options.copies;
      error = `${state.options.photoQty} photos × ${state.options.copies} set(s) on A4 · final total confirmed by server`;
    } else if (state.service === 'resume') {
      if (!state.files.length || state.pageCounts.length !== state.files.length)
        throw new Error('Create or upload a resume first.');
      amount = 3000;
      error = 'Resume service · ₹30 · one A4 copy · final total confirmed by server';
    } else if (isID) {
      if (!idSidesReady()) throw new Error('Upload required sides and apply each crop first.');
      if (state.files.some(f => f.type === 'application/pdf'))
        throw new Error('ID images must be JPG/PNG.');
      const count = 1;
      amount = quote(count, state.options, config);
      error = `${count} page × ${state.options.copies} copies · ${state.options.paper} · ${state.options.color === 'bw' ? 'B&W' : 'Color'} · server confirms total`;
    } else {
      if (!state.files.length || state.pageCounts.length !== state.files.length)
        throw new Error('Upload documents first.');
      if (
        state.files.length > MAX_FILES ||
        state.files.some(f => f.size > MAX_FILE_SIZE) ||
        state.files.reduce((s, f) => s + f.size, 0) > MAX_TOTAL_SIZE
      ) {
        throw new Error(`Use up to ${MAX_FILES} files, 25 MB each, 40 MB total.`);
      }
      const totalPages = state.pageCounts.reduce((a, b) => a + b, 0);
      const selected = parsePages(state.options.range, totalPages).length;
      amount = quote(selected, state.options, config);
      error = `${selected} pages × ${state.options.copies} copies · ${state.options.paper} · ${state.options.color === 'bw' ? 'B&W' : 'Color'} · server confirms total`;
    }
  } catch (e) {
    error = e.message;
  }

  $('#csp-price-value').textContent = money(amount);
  $('#csp-price-help').textContent = error;
}

function updateBottomBar() {
  const back = $('#csp-btn-back');
  const next = $('#csp-btn-next');
  const nextText = $('#csp-btn-next-text');
  const spinner = next.querySelector('.csp-spinner');
  const bottombar = $('#csp-bottombar');

  // Hide bottom bar on service screen
  if (state.screen === 'service') {
    bottombar.style.display = 'none';
  } else if (state.screen === 'final') {
    // Final screen: show Back, hide Next
    bottombar.style.display = 'flex';
    back.style.display = 'flex';
    next.style.display = 'none';
  } else {
    bottombar.style.display = 'flex';
  }

  const canGoBack = state.screen !== 'service' && state.screen !== 'final';
  const canGoNext = canProceed();

  if (state.screen !== 'final') {
    next.style.display = 'flex';
  }
  next.disabled = !canGoNext || state.previewBusy || state.submitting;
  $('#csp-bottombar').style.display = state.screen === 'service' ? 'none' : '';

  const labels = {
    service: 'Continue',
    upload: 'Next',
    settings: 'Next',
    crop: 'Next',
    resume: 'Next',
    review: 'Confirm & send to counter',
  };
  nextText.textContent = labels[state.screen] || 'Next';
}

function validateRange(range, total) {
  try {
    parsePages(range, total);
    return true;
  } catch {
    return false;
  }
}
function canProceed() {
  const isPassport = state.service === 'passport';
  const isID = state.service === 'id';
  const isResume = state.service === 'resume';

  switch (state.screen) {
    case 'service':
      return !!state.service;
    case 'upload':
      if (isPassport)
        return state.files.length === 1 && state.pageCounts.length === 1 && state.cropApproved;
      if (isID) return idSidesReady();
      if (isResume)
        return (
          !!state.resumeFile &&
          state.files.length === 1 &&
          state.files[0] === state.resumeFile &&
          state.pageCounts.length === 1
        );
      return state.files.length > 0 && state.pageCounts.length === state.files.length;
    case 'settings': {
      if (
        isResume &&
        (!state.resumeFile || state.files.length !== 1 || state.files[0] !== state.resumeFile)
      )
        return false;
      if (isID && !idSidesReady()) return false;
      if (!state.files.length || state.pageCounts.length !== state.files.length) return false;
      const totalPages = state.pageCounts.reduce((a, b) => a + b, 0);
      if (!validateRange(state.options.range, totalPages)) return false;
      return true;
    }
    case 'crop':
      return state.cropApproved;
    case 'resume':
      return !!state.resumeFile && state.files.length === 1 && state.files[0] === state.resumeFile;
    case 'review':
      return !!state.draft && $('#csp-review-check')?.checked;
    default:
      return false;
  }
}

function applyServiceDefaults() {
  const isPassport = state.service === 'passport';
  const isID = state.service === 'id';
  const isResume = state.service === 'resume';

  if (isPassport) {
    state.options.paper = 'A4';
    state.options.color = 'color';
    state.options.orientation = 'portrait';
    state.options.duplex = false;
    state.options.range = '';
    state.options.copies = Math.min(10, state.options.copies);
    if (!state.pkgSelector) {
      state.pkgSelector = createPhotoPackageSelector(config);
      state.pkgSelector.setOnChange(v => {
        state.options.photoQty = v.photoQty;
        state.options.copies = v.copies;
        savePrefs();
        updatePrice();
        updateBottomBar();
      });
    }
    state.pkgSelector.setValues(state.options);
  } else if (isID) {
    state.options.idFormat ||= 'plastic';
    state.options.idSingle = state.options.idSingle === true;
    state.options.paper = 'A4';
    state.options.orientation = 'portrait';
    state.options.duplex = false;
    state.options.range = '';
    state.options.copies = 1;
  } else if (isResume) {
    state.options.paper = 'A4';
    state.options.orientation = 'portrait';
    state.options.duplex = false;
    state.options.range = '';
    state.options.copies = 1;
    if (!state.resumeBuilder) {
      state.resumeBuilder = createResumeBuilder({
        onFile: file => {
          state.resumeFile = file;
          state.files = [file];
          setTimeout(async () => {
            try {
              const { PDFDocument } = await import('pdf-lib');
              const doc = await PDFDocument.load(await file.arrayBuffer());
              state.pageCounts = [doc.getPageCount()];
            } catch {
              state.pageCounts = [1];
            }
            renderFilePreviews();
            updatePrice();
            updateBottomBar();
            updateUploadUI();
            persistVisit({ stage: 'upload' });
          }, 100);
        },
        onClear: () => {
          state.resumeFile = null;
          state.files = [];
          state.pageCounts = [];
          state.draft = null;
          renderFilePreviews();
          updatePrice();
          updateBottomBar();
        },
      });
      $('#csp-resume-root').appendChild(state.resumeBuilder.element);
    }
  }
  savePrefs();
}

function idSidesReady() {
  const required = state.options.idSingle ? 1 : 2;
  return (
    !state.idEditing &&
    state.files.length === required &&
    state.pageCounts.length === required &&
    state.files.every(
      (f, i) => state.idApplied[i] === true && ['image/jpeg', 'image/png'].includes(f.type)
    )
  );
}

async function editIdSide(index, automatic = false) {
  if (state.idEditing || !state.idOriginals[index]) return false;
  state.idEditing = true;
  updateBottomBar();
  $('#csp-btn-back').disabled = true;
  $$('#csp-id-format, #csp-id-single, [data-id-edit]').forEach(
    control => (control.disabled = true)
  );
  const panel = $('#csp-upload-panel');
  panel?.setAttribute('aria-busy', 'true');
  const progress = el(
    'p',
    { class: 'id-processing-status', role: 'status' },
    'Finding and straightening card edges…'
  );
  $('#csp-file-list')?.before(progress);
  try {
    const options = {
      format: state.options.idFormat || 'plastic',
      title: index === 0 ? 'Front' : 'Back',
    };
    let result = automatic ? await autoCropIdCard(state.idOriginals[index], options) : null;
    const usedAuto = !!result;
    if (!result) {
      progress.textContent = "Please check this card's corners manually.";
      result = await editIdCard(state.idOriginals[index], options);
    }
    if (!result) return false;
    if (!(result.blob instanceof Blob) || !result.blob.size)
      throw new Error('Crop could not be prepared. Please try again.');
    const type = result.blob.type || 'image/jpeg';
    state.files[index] = new File(
      [result.blob],
      `id-${index ? 'back' : 'front'}-corrected.${type === 'image/png' ? 'png' : 'jpg'}`,
      { type }
    );
    state.idApplied[index] = true;
    state.pageCounts[index] = 1;
    state.draft = null;
    if (usedAuto)
      toast('Card cropped automatically. Check the preview or use Adjust crop.', 'success');
    return true;
  } catch (e) {
    toast(e.message || 'Could not crop this image. Please try again.', 'error');
    return false;
  } finally {
    progress.remove();
    panel?.removeAttribute('aria-busy');
    $('#csp-btn-back').disabled = false;
    state.idEditing = false;
    renderFilePreviews();
    updatePrice();
    updateBottomBar();
    updateUploadUI();
    persistVisit({ stage: 'upload' });
  }
}

async function editPendingIdSides() {
  for (let i = 0; i < state.files.length; i++) {
    if (!state.idApplied[i] && !(await editIdSide(i, true))) break;
  }
}

async function handleFiles(fileList) {
  if (state.idEditing) return;
  if (state.service === 'resume') {
    toast('Use Resume Maker to generate your resume first.', 'info');
    return;
  }
  const newFiles = [...fileList];
  if (!newFiles.length) return;
  const isPassport = state.service === 'passport';
  const isID = state.service === 'id';

  // MIME validation
  const allowedPassport = ['image/jpeg', 'image/png'];
  const allowedID = ['image/jpeg', 'image/png'];
  const allowedDoc = ['application/pdf', 'image/jpeg', 'image/png'];

  if (isPassport) {
    if (newFiles.length > 1) {
      toast('Passport photos: only one photo allowed', 'warning');
      return;
    }
    if (!allowedPassport.includes(newFiles[0]?.type)) {
      toast('Passport photos must be JPG or PNG', 'error');
      return;
    }
  }
  if (isID) {
    const maxSides = state.options.idSingle ? 1 : 2;
    if (newFiles.length > maxSides - state.files.length) {
      toast(`ID card: only ${maxSides - state.files.length} more image(s) allowed`, 'warning');
      return;
    }
    if (!newFiles.every(f => allowedID.includes(f.type))) {
      toast('ID images must be JPG/PNG', 'error');
      return;
    }
  }
  if (!isPassport && !isID) {
    if (!newFiles.every(f => allowedDoc.includes(f.type))) {
      toast('Only PDF, JPG, or PNG files allowed', 'error');
      return;
    }
  }

  if (isPassport && newFiles[0]?.type === 'application/pdf') {
    toast('Passport photos must be JPG or PNG', 'error');
    return;
  }

  for (const f of newFiles) {
    if (f.size > MAX_FILE_SIZE) {
      toast(`${esc(f.name)} exceeds 25 MB limit`, 'error');
      return;
    }
  }
  const totalSize = [...state.files, ...newFiles].reduce((s, f) => s + f.size, 0);
  if (totalSize > MAX_TOTAL_SIZE) {
    toast('Total upload size exceeds 40 MB', 'error');
    return;
  }
  if ([...state.files, ...newFiles].length > MAX_FILES) {
    toast(`Maximum ${MAX_FILES} files allowed`, 'error');
    return;
  }

  if (state.cropWorkspace) {
    state.cropWorkspace.destroy();
    state.cropWorkspace = null;
  }
  closeCropModal();

  if (isID) state.idOriginals.push(...newFiles);
  state.draft = null;
  state.files = isPassport
    ? newFiles
    : isID
      ? [...state.files, ...newFiles].slice(0, 2)
      : [...state.files, ...newFiles].slice(0, MAX_FILES);
  state.pageCounts = [];

  try {
    for (const f of state.files) {
      if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) {
        const { PDFDocument } = await import('pdf-lib');
        const doc = await PDFDocument.load(await f.arrayBuffer());
        state.pageCounts.push(doc.getPageCount());
      } else {
        state.pageCounts.push(1);
      }
    }
    renderFilePreviews();
    updatePrice();
    updateBottomBar();
    persistVisit({ stage: 'upload' });

    if (isPassport && state.files.length === 1) {
      state.originalFile = state.files[0];
      state.appliedCrop = null;
      state.cropApproved = false;
      openCropModal();
    } else if (isID) {
      await editPendingIdSides();
    }
  } catch {
    toast('A PDF could not be read. Unlock it or choose another file.', 'error');
    state.pageCounts = [];
    renderFilePreviews();
    updatePrice();
    updateBottomBar();
  }
}

function openCropModal() {
  const modal = $('#csp-crop-modal');
  const host = $('#csp-crop-host-modal');
  modal.classList.add('active');
  document.body.style.overflow = 'hidden';

  if (!state.cropWorkspace) {
    state.cropWorkspace = createCropWorkspace();
    host.appendChild(state.cropWorkspace.element);
    state.cropWorkspace.setCallbacks({
      onCropChange: crop => {
        state.cropApproved = false;
        updateCropStatus('Crop suggested · adjust and press Apply', 'warning');
        $('#csp-crop-apply').disabled = !crop;
      },
      onError: err => toast(err.message, 'error'),
    });
    state.cropWorkspace
      .loadImage(state.originalFile || state.files[0])
      .catch(e => toast(e.message, 'error'));
  } else {
    host.appendChild(state.cropWorkspace.element);
    state.cropWorkspace.drawPreview();
    $('#csp-crop-apply').disabled = !state.cropWorkspace.getCrop();
    updateCropStatus(
      state.cropApproved ? 'Crop applied' : 'Crop suggested · adjust and press Apply',
      state.cropApproved ? 'good' : 'warning'
    );
  }
  const range = $('#csp-crop-zoom-range');
  if (range && state.cropWorkspace) range.value = state.cropWorkspace.getZoom?.() || 1;
}

function closeCropModal() {
  const modal = $('#csp-crop-modal');
  modal.classList.remove('active');
  document.body.style.overflow = '';
}

function updateCropStatus(text, type) {
  const el = $('#csp-crop-status');
  el.textContent = text;
  el.className = 'csp-crop-status' + (type ? ' ' + type : '');
}

async function applyCrop() {
  if (!state.cropWorkspace) return;
  const btn = $('#csp-crop-apply');
  const spinner = btn.querySelector('.csp-spinner');
  btn.disabled = true;
  spinner.style.display = 'inline-block';
  btn.querySelector('span:first-child').textContent = 'Applying…';

  try {
    const blob = await state.cropWorkspace.getCroppedBlob();
    if (blob) {
      state.files = [new File([blob], 'cropped-passport.jpg', { type: 'image/jpeg' })];
      state.appliedCrop = state.cropWorkspace.getCrop();
      state.cropApproved = true;
      state.pageCounts = [1];
      renderFilePreviews();
      updatePrice();
      updateBottomBar();
      toast('Crop applied successfully', 'success');
      updateCropStatus('Crop applied', 'good');
    }
    closeCropModal();
    showScreen('settings');
  } catch (e) {
    toast('Failed to apply crop', 'error');
  } finally {
    btn.disabled = false;
    spinner.style.display = 'none';
    btn.querySelector('span:first-child').textContent = 'Apply Crop';
  }
}

function resetCrop() {
  if (state.cropWorkspace) {
    state.cropWorkspace.reset();
    state.cropApproved = false;
    updateCropStatus('Crop suggested · press Apply', 'warning');
    $('#csp-crop-apply').disabled = !state.cropWorkspace.getCrop();
  }
}

function handleCropTool(id) {
  if (!state.cropWorkspace) return;
  switch (id) {
    case 'csp-crop-zoom-in':
      state.cropWorkspace.zoom(state.cropWorkspace.getZoom() * 1.2);
      break;
    case 'csp-crop-zoom-out':
      state.cropWorkspace.zoom(state.cropWorkspace.getZoom() / 1.2);
      break;
    case 'csp-crop-zoom-reset':
      state.cropWorkspace.resetZoom();
      break;
    case 'csp-crop-rotate-left':
      state.cropWorkspace.rotate(-90);
      break;
    case 'csp-crop-rotate-right':
      state.cropWorkspace.rotate(90);
      break;
  }
  const range = $('#csp-crop-zoom-range');
  if (range) range.value = state.cropWorkspace.getZoom?.() || 1;
}

async function preparePreview() {
  if (state.previewBusy || !canProceed()) return;
  state.previewBusy = true;
  const next = $('#csp-btn-next');
  const nextText = $('#csp-btn-next-text');
  const spinner = next.querySelector('.csp-spinner');
  next.disabled = true;
  nextText.textContent = 'Preparing…';
  spinner.style.display = 'inline-block';

  try {
    const form = new FormData();
    for (const f of state.files) form.append('files', f);
    if (state.service === 'id')
      for (const original of state.idOriginals) form.append('originals', original);
    form.append('options', JSON.stringify(state.options));

    const res = await fetch('/api/orders', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');

    state.draft = data;
    renderReview();
    showScreen('review');
    persistVisit({ stage: 'review', orderToken: data.token });
    toast('Preview ready. Please review and confirm.', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    state.previewBusy = false;
    spinner.style.display = 'none';
    updateBottomBar();
  }
}

let reviewPreviewGeneration = 0;
let disposeReviewPreview = null;

function createInlinePdfPreview(token) {
  disposeReviewPreview?.();
  const generation = ++reviewPreviewGeneration;
  const frame = el('div', {
    class: 'csp-preview-frame csp-inline-preview',
    style:
      'height:auto;min-height:180px;display:flex;flex-direction:column;gap:10px;padding:10px;overflow:hidden;',
  });
  const status = el(
    'p',
    { role: 'status', style: 'margin:0;font-size:12px;line-height:1.5;' },
    'Loading your prepared print preview…'
  );
  const canvas = el('canvas', {
    class: 'csp-inline-preview-canvas',
    'aria-label': 'Prepared print preview',
    style: 'display:none;max-width:100%;height:auto;align-self:center;background:white;',
  });
  const previous = el(
    'button',
    { type: 'button', class: 'csp-btn secondary', 'aria-label': 'Previous preview page' },
    '←'
  );
  const next = el(
    'button',
    { type: 'button', class: 'csp-btn secondary', 'aria-label': 'Next preview page' },
    '→'
  );
  previous.disabled = next.disabled = true;
  const label = el(
    'span',
    {
      role: 'status',
      style: 'font-size:12px;line-height:1.4;text-align:center;flex:1;min-width:0;',
    },
    'Preparing page…'
  );
  const retry = el('button', { type: 'button', class: 'csp-btn secondary' }, 'Retry preview');
  retry.hidden = true;
  retry.addEventListener('click', () => {
    const check = $('#csp-review-check');
    if (check) {
      check.checked = false;
      check.disabled = true;
      updateBottomBar();
    }
    frame.replaceWith(createInlinePdfPreview(token));
  });
  frame.append(
    status,
    canvas,
    el(
      'div',
      {
        class: 'csp-inline-preview-toolbar',
        style: 'display:flex;align-items:center;gap:8px;min-width:0;',
      },
      previous,
      label,
      next
    ),
    retry,
    el(
      'a',
      {
        href: `/preview?order=${encodeURIComponent(token)}`,
        target: '_blank',
        rel: 'noopener',
        style: 'font-size:12px;overflow-wrap:anywhere;text-align:center;',
      },
      'Open full preview ↗'
    )
  );

  let pdf = null,
    loadingTask = null,
    renderTask = null,
    pageNumber = 1,
    busy = false,
    disposed = false;
  let lastWidth = 0,
    resizeTimer = null;
  const alive = () =>
    !disposed && generation === reviewPreviewGeneration && state.draft?.token === token;
  const updateControls = () => {
    previous.disabled = busy || !pdf || pageNumber <= 1;
    next.disabled = busy || !pdf || pageNumber >= pdf.numPages;
  };
  async function drawPage() {
    if (!alive() || !pdf || busy) return;
    busy = true;
    updateControls();
    let page;
    try {
      // The review screen is made visible immediately after mounting this frame.
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (!alive() || !frame.isConnected) return;
      const width = frame.clientWidth - 20;
      if (width <= 0) return;
      lastWidth = width;
      page = await pdf.getPage(pageNumber);
      if (!alive()) return;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(1.6, Math.max(80, width) / base.width) });
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.ceil(viewport.width * outputScale);
      canvas.height = Math.ceil(viewport.height * outputScale);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.display = 'block';
      status.hidden = false;
      status.textContent = 'Rendering page…';
      renderTask = page.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
        transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
      });
      await renderTask.promise;
      if (!alive()) return;
      status.hidden = true;
      const check = $('#csp-review-check');
      if (pageNumber === 1 && check) {
        check.disabled = false;
        updateBottomBar();
      }
      label.textContent = `Page ${pageNumber} of ${pdf.numPages}`;
      canvas.setAttribute('aria-label', `Prepared print page ${pageNumber} of ${pdf.numPages}`);
    } catch (error) {
      if (!alive() || error?.name === 'RenderingCancelledException') return;
      status.hidden = false;
      status.textContent =
        'This preview could not render. Open the full preview below and check your file before confirming.';
      label.textContent = 'Preview unavailable';
      retry.hidden = false;
    } finally {
      page?.cleanup();
      renderTask = null;
      busy = false;
      if (alive()) updateControls();
    }
  }
  previous.addEventListener('click', () => {
    if (!busy && pdf && pageNumber > 1) {
      pageNumber--;
      drawPage();
    }
  });
  next.addEventListener('click', () => {
    if (!busy && pdf && pageNumber < pdf.numPages) {
      pageNumber++;
      drawPage();
    }
  });
  const observer = new ResizeObserver(() => {
    const width = frame.clientWidth - 20;
    if (width <= 0 || Math.abs(width - lastWidth) < 2 || busy || !pdf) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => drawPage(), 120);
  });
  observer.observe(frame);
  disposeReviewPreview = () => {
    disposed = true;
    observer.disconnect();
    clearTimeout(resizeTimer);
    renderTask?.cancel();
    if (loadingTask) loadingTask.destroy().catch(() => {});
  };
  (async () => {
    try {
      const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist/build/pdf.mjs');
      if (!alive()) return;
      GlobalWorkerOptions.workerSrc = '/pdf.worker.js';
      loadingTask = getDocument({
        url: `/api/orders/${encodeURIComponent(token)}/file`,
        isEvalSupported: false,
        useSystemFonts: true,
        enableXfa: false,
      });
      pdf = await loadingTask.promise;
      if (!alive()) return;
      await drawPage();
    } catch {
      if (!alive()) return;
      status.hidden = false;
      status.textContent =
        'Your file could not be opened. It may have expired. Try Open full preview below, or go Back and upload again.';
      label.textContent = 'Preview unavailable';
      retry.hidden = false;
    }
  })();
  return frame;
}

function renderReview() {
  const body = $('#csp-review-body');
  if (!state.draft) return;
  const d = state.draft;

  body.innerHTML = '';
  body.appendChild(createInlinePdfPreview(d.token));

  const summary = el('div', { class: 'csp-settings-section', style: 'padding:8px 0;' });
  summary.innerHTML = `
    <div style="font-size:12px;line-height:1.5;color:var(--csp-text);">
      <div><strong>Service:</strong> ${esc(SERVICES.find(s => s.id === d.options.service)?.name)}</div>
      <div><strong>Pages × Copies:</strong> ${d.pages} × ${d.options.copies}</div>
      <div><strong>Paper / Mode:</strong> ${esc(d.options.paper)} · ${d.options.color === 'bw' ? 'B&W' : 'Color'}</div>
      <div><strong>Total:</strong> ${money(d.amount)}</div>
    </div>
  `;
  body.appendChild(summary);

  const checkbox = el(
    'label',
    { class: 'csp-checkbox-line', style: 'margin:12px 0;' },
    el('input', {
      type: 'checkbox',
      id: 'csp-review-check',
      class: 'csp-checkbox-input',
      disabled: 'disabled',
    }),
    el('span', {}, 'I checked the preview, page selection, and print settings are correct')
  );
  body.appendChild(checkbox);

  body.appendChild(
    el(
      'div',
      { class: 'counter-notice' },
      el('strong', {}, 'Please pay ' + money(d.amount) + ' at the counter'),
      el('p', {}, 'Send your request. Staff will confirm cash received and start printing.')
    )
  );
  $('#csp-review-check').addEventListener('change', updateBottomBar);
}

async function submitOrder() {
  if (state.submitting || !state.draft) return;
  state.submitting = true;
  const next = $('#csp-btn-next');
  const nextText = $('#csp-btn-next-text');
  const spinner = next.querySelector('.csp-spinner');
  next.disabled = true;
  nextText.textContent = 'Sending…';
  spinner.style.display = 'inline-block';

  try {
    const latestResponse = await fetch(`/api/orders/${state.draft.token}`, { cache: 'no-store' });
    if (!latestResponse.ok) throw Error('Could not refresh this request. Please try again.');
    const latest = await latestResponse.json();
    if (latest.version !== state.draft.version) {
      state.draft = latest;
      state.submitting = false;
      renderReview();
      showScreen('review');
      spinner.style.display = 'none';
      toast(
        'Staff updated this request. Check the refreshed preview and total before confirming.',
        'warning'
      );
      return;
    }
    const res = await fetch(`/api/orders/${state.draft.token}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: state.draft.version }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not send request.');
    persistVisit({ stage: 'submitted', orderToken: state.draft.token });
    stopVisitKeepalive();
    location.href = `/order/${state.draft.token}`;
  } catch (e) {
    toast(e.message, 'error');
    state.submitting = false;
    spinner.style.display = 'none';
    nextText.textContent = 'Confirm & send to counter';

    updateBottomBar();
  }
}

function renderFinalPage() {
  const d = state.draft;
  const app = $('#app');
  app.innerHTML = '';
  app.className = 'csp-app';
  document.body.className = 'customer-v3-page';

  const pickupCode = d.id ? d.id.slice(0, 8).toUpperCase() : '—';

  app.appendChild(
    el(
      'header',
      { class: 'csp-topbar' },
      el(
        'a',
        { class: 'csp-logo', href: '/' },
        el('span', { class: 'csp-logo-mark', 'aria-hidden': 'true' }, 'S'),
        el('span', { class: 'csp-logo-text' }, config.shopName || 'SHRI CSC CENTER')
      ),
      el(
        'div',
        { class: 'csp-topbar-right' },
        el('span', { class: 'csp-shop-tag' }, 'Customer Print Desk')
      )
    )
  );

  const main = el('main', { class: 'csp-main' });
  main.appendChild(
    el('nav', { id: 'csp-breadcrumb', class: 'csp-breadcrumb', 'aria-label': 'Progress' })
  );

  main.appendChild(
    el(
      'section',
      { class: 'csp-screen', 'data-screen': 'final' },
      el(
        'div',
        { class: 'csp-panel' },
        el(
          'div',
          { class: 'csp-panel-head' },
          el('h2', { class: 'csp-panel-title' }, 'Order Submitted'),
          el('p', { class: 'csp-panel-subtitle' }, 'Your print request is being processed')
        ),
        el(
          'div',
          { class: 'csp-panel-body' },
          el(
            'div',
            { style: 'text-align:center;padding:24px 0;' },
            el(
              'div',
              {
                class: 'csp-order-code',
                style: 'font-size:24px;font-weight:800;color:var(--csp-ink);margin-bottom:8px;',
              },
              `#${pickupCode}`
            ),
            el(
              'div',
              {
                style:
                  'font-size:18px;font-weight:700;color:var(--csp-accent-deep);margin-bottom:16px;',
              },
              money(d.amount)
            ),
            el(
              'div',
              { style: 'font-size:13px;color:var(--csp-muted);margin-bottom:32px;' },
              'Please pay ₹' + (d.amount / 100).toFixed(2) + ' at the counter.'
            ),
            el(
              'div',
              { style: 'font-size:12px;color:var(--csp-faint);line-height:1.5;' },
              'Staff will confirm payment and start printing.'
            )
          ),
          el(
            'div',
            { style: 'display:flex;gap:12px;justify-content:flex-end;margin-top:16px;' },
            el(
              'button',
              {
                type: 'button',
                class: 'csp-btn secondary',
                id: 'csp-final-back',
                style: 'min-height:44px;padding:8px 16px;font-size:12px;',
              },
              'Back'
            ),
            el(
              'span',
              { style: 'color:var(--csp-muted);font-size:12px;' },
              'Waiting for counter confirmation...'
            )
          )
        )
      )
    )
  );

  app.appendChild(main);
  app.appendChild(renderBottomBar());

  if (!$('#csp-toasts')) {
    document.body.appendChild(el('div', { id: 'csp-toasts', class: 'csp-toast-container' }));
  }

  bindFinalEvents();
}

function bindFinalEvents() {
  $('#csp-final-back').addEventListener('click', () => {
    // Go back to service screen, clearing the draft
    state.service = null;
    state.options = {
      service: null,
      color: 'bw',
      copies: 1,
      paper: 'A4',
      range: '',
      orientation: 'portrait',
      duplex: false,
      mobile: '',
      photoQty: 5,
    };
    state.files = [];
    state.pageCounts = [];
    state.draft = null;
    state.previewBusy = false;
    state.submitting = false;
    showScreen('service');
  });
}

function selectService(id) {
  const wasPassport = state.service === 'passport';
  if (id !== state.service) {
    state.files = [];
    state.pageCounts = [];
    state.draft = null;
    state.originalFile = null;
    state.appliedCrop = null;
    state.cropApproved = false;
    state.idOriginals = [];
    state.idApplied = [];
    if (state.cropWorkspace) {
      state.cropWorkspace.destroy();
      state.cropWorkspace = null;
    }
    closeCropModal();
  }
  state.service = id;
  state.options.service = id;
  applyServiceDefaults();
  updateUploadUI();
  showScreen('upload');
  persistVisit({ stage: 'opened', service: id });
}

function bindServiceEvents() {
  $$('.csp-service-btn[data-service]').forEach(btn => {
    btn.addEventListener('click', () => selectService(btn.dataset.service));
    btn.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectService(btn.dataset.service);
      }
    });
  });
}

function bindUploadEvents() {
  const zone = $('#csp-upload-zone');
  const input = $('#csp-file-input');
  zone.addEventListener('click', e => {
    if (e.target !== input) input.click();
  });
  zone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt =>
    zone.addEventListener(evt, e => {
      e.preventDefault();
      e.stopPropagation();
      if (evt === 'dragenter' || evt === 'dragover') zone.classList.add('dragover');
      else zone.classList.remove('dragover');
      if (evt === 'drop') handleFiles(e.dataTransfer.files);
    })
  );
  input.addEventListener('change', e => {
    const files = [...e.target.files];
    input.value = '';
    handleFiles(files);
  });

  $('#csp-file-list').addEventListener('click', e => {
    const btn = e.target.closest('.csp-file-remove');
    if (btn) {
      if (state.idEditing) return;
      const i = parseInt(btn.dataset.index);
      const removedFile = state.files[i];
      // Revoke object URL if it was an image preview
      const imgEl = btn.closest('.csp-file-item')?.querySelector('.csp-file-icon');
      if (imgEl && imgEl.tagName === 'IMG' && imgEl.src.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(imgEl.src);
        } catch {}
      }
      state.files.splice(i, 1);
      if (state.service === 'id') {
        state.idOriginals.splice(i, 1);
        state.idApplied.splice(i, 1);
        updateUploadUI();
      }
      state.pageCounts.splice(i, 1);
      if (state.cropWorkspace) {
        state.cropWorkspace.destroy();
        state.cropWorkspace = null;
        closeCropModal();
      }
      state.draft = null; // Invalidate draft when files change
      renderFilePreviews();
      updatePrice();
      updateBottomBar();
      persistVisit({ stage: 'upload' });
    }
  });
}

function bindSettingsEvents() {
  $$('.csp-segmented-btn[data-color]').forEach(b =>
    b.addEventListener('click', () => {
      state.options.color = b.dataset.color;
      savePrefs();
      updateSettingsUI();
    })
  );
  $$('.csp-segmented-btn[data-duplex]').forEach(b =>
    b.addEventListener('click', () => {
      state.options.duplex = b.dataset.duplex === 'true';
      savePrefs();
      updateSettingsUI();
    })
  );
  $('#csp-copies-value')
    .parentElement.querySelectorAll('.csp-stepper-btn')
    .forEach(b =>
      b.addEventListener('click', () => {
        const act = b.dataset.action;
        if (act === 'increase' && state.options.copies < 100) state.options.copies++;
        else if (act === 'decrease' && state.options.copies > 1) state.options.copies--;
        $('#csp-copies-value').textContent = state.options.copies;
        savePrefs();
        updateSettingsUI();
      })
    );
  $('#csp-paper').addEventListener('change', e => {
    state.options.paper = e.target.value;
    savePrefs();
    updateSettingsUI();
  });
  $('#csp-orientation').addEventListener('change', e => {
    state.options.orientation = e.target.value;
    savePrefs();
    updateSettingsUI();
  });
  function validateRange(range, totalPages) {
    if (!range.trim()) return true;
    try {
      parsePages(range, totalPages);
      return true;
    } catch {
      return false;
    }
  }

  $('#csp-range').addEventListener('input', e => {
    state.options.range = e.target.value;
    savePrefs();
    updatePrice();
    debouncedPersistVisit();
  });
  $('#csp-mobile').addEventListener('input', e => {
    state.options.mobile = e.target.value.replace(/\D/g, '').slice(0, 10);
    savePrefs();
  });
  $('#csp-customer-name').addEventListener('input', e => {
    state.options.customerName = e.target.value.slice(0, 80);
  });
  $('#csp-order-notes').addEventListener('input', e => {
    state.options.notes = e.target.value.slice(0, 300);
  });
  $('#csp-method-segmented').addEventListener('click', e => {
    const btn = e.target.closest('.csp-segmented-btn[data-method]');
    if (btn) {
      state.options.method = btn.dataset.method;
      state.options.paymentChannel = btn.dataset.channel || 'qr';
      savePrefs();
      updateSettingsUI();
    }
  });
}

function bindCropEvents() {
  $('#csp-crop-cancel').addEventListener('click', () => {
    closeCropModal();
    if (state.service === 'passport') {
      state.cropApproved = false;
      state.appliedCrop = null;
      // If we had a cropped file, revert to original
      if (
        state.originalFile &&
        state.files.length === 1 &&
        state.files[0].name === 'cropped-passport.jpg'
      ) {
        state.files = [state.originalFile];
        state.pageCounts = [1];
        renderFilePreviews();
        updatePrice();
        updateBottomBar();
      }
    }
    showScreen(state.service === 'passport' ? 'upload' : 'settings');
  });
  $('#csp-crop-apply').addEventListener('click', applyCrop);
  $('#csp-crop-reset').addEventListener('click', resetCrop);
  $$(
    '#csp-crop-zoom-in, #csp-crop-zoom-out, #csp-crop-zoom-reset, #csp-crop-rotate-left, #csp-crop-rotate-right'
  ).forEach(b => b.addEventListener('click', () => handleCropTool(b.id)));
  $('#csp-crop-zoom-range').addEventListener('input', e => {
    if (state.cropWorkspace) state.cropWorkspace.zoom(parseFloat(e.target.value));
  });
  $('#csp-crop-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeCropModal();
  });
}

function bindBottomBarEvents() {
  $('#csp-btn-back').addEventListener('click', () => {
    if (state.idEditing) return;
    const order = ['service', 'upload', 'settings', 'review'];
    const currentScreen = state.screen.replace('crop', 'settings').replace('resume', 'upload');
    const idx = order.indexOf(currentScreen);
    if (idx > 0) {
      const prevScreen = order[idx - 1];
      // If going back from settings to upload for passport, reopen crop modal if crop was approved
      if (
        prevScreen === 'upload' &&
        state.service === 'passport' &&
        state.cropApproved &&
        state.originalFile
      ) {
        showScreen('upload');
        setTimeout(() => openCropModal(), 100);
      } else {
        showScreen(prevScreen);
      }
    }
  });
  $('#csp-btn-next').addEventListener('click', () => {
    if (!canProceed()) return;
    if (state.screen === 'settings') {
      updateSettingsUI();
      preparePreview();
    } else {
      const nextMap = {
        service: 'upload',
        upload: 'settings',
        settings: 'review',
        crop: 'review',
        resume: 'review',
        review: 'submit',
      };
      const next = nextMap[state.screen];
      if (next === 'submit') submitOrder();
      else if (next) showScreen(next);
    }
  });
}

function bindReviewEvents() {}

let visitDebounceTimer = null;
function debouncedPersistVisit() {
  clearTimeout(visitDebounceTimer);
  visitDebounceTimer = setTimeout(() => persistVisit({ stage: 'settings' }), 500);
}

export function initCustomer(configData, callback) {
  config = configData;
  if (config.duplexSheetPrice == null) config.duplexSheetPrice = 500;
  // Always start from service screen - do not trust saved service preselect
  state.service = null;
  state.options = {
    service: null,
    color: 'bw',
    copies: 1,
    paper: 'A4',
    range: '',
    orientation: 'portrait',
    duplex: false,
    mobile: '',
    photoQty: 5,
  };
  visitId = crypto.randomUUID();
  initVisit().then(() => {
    renderApp();
    showScreen('service');
    callback?.({ ready: true });
  });
}
