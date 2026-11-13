import { parsePages, photoPackagePrice, quote } from '../lib/core.js';
import { createCropWorkspace } from './crop-workspace.js';
import { escapeHtml } from './html.js';
import { createPhotoPackageSelector } from './photo-ui.js';

const $ = (s, ctx = document) => ctx.querySelector(s);
const $$ = (s, ctx = document) => ctx.querySelectorAll(s);

const esc = escapeHtml;
const money = n => '₹' + (Number(n || 0) / 100).toFixed(2);
const formatBytes = b => (b / 1024 / 1024).toFixed(2) + ' MB';

let config = null;
let files = [];
let pageCounts = [];
let draft = null;
let previewBusy = false;
let cropWorkspace = null;
let pkgSelector = null;
let currentStep = 1;
const maxSteps = 4;
let stateChangeCallback = null;
let originalFile = null;
let appliedCrop = null;
let cropApproved = false;

// Service definitions with metadata
const SERVICES = [
  {
    id: 'document',
    icon: '📄',
    title: 'Document Print',
    desc: 'PDF, JPG, PNG · Page range & copies',
    supports: { multiFile: true, passport: false },
  },
  {
    id: 'passport',
    icon: '🪪',
    title: 'Passport Photos',
    desc: '35×45mm · 5/10/20/30 per set',
    supports: { multiFile: false, passport: true },
  },
  {
    id: 'id',
    icon: '🪪',
    title: 'ID / Aadhaar Card',
    desc: 'Front & back on one A4 sheet',
    supports: { multiFile: false, passport: false },
  },
  {
    id: 'resume',
    icon: '📋',
    title: 'Resume Print',
    desc: 'Clean, professional resume printing',
    supports: { multiFile: true, passport: false },
  },
];

// Passport package defaults (paise)
const PASSPORT_DEFAULTS = { 5: 3000, 10: 6000, 20: 12000, 30: 18000 };

// Customer options state
let customerOptions = {
  service: 'document',
  color: 'bw',
  copies: 1,
  paper: 'A4',
  range: '',
  mobile: '',
  orientation: 'portrait',
  duplex: false,
  method: 'cash',
  photoQty: 5,
};

// Persist preferences to localStorage
const STORAGE_KEY = 'shri-print-prefs';
function loadPrefs() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      customerOptions = { ...customerOptions, ...parsed };
    }
  } catch {}
}
function savePrefs() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(customerOptions));
  } catch {}
}

// Toast system
function toast(message, type = 'info', duration = 4000) {
  let container = $('#toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const icons = {
    success:
      '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    error:
      '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>',
    warning:
      '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
    info: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>',
  };
  el.innerHTML = `${icons[type] || icons.info}<span>${esc(message)}</span>`;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => {
    el.classList.remove('visible');
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// Utility: create element with attributes and children
function el(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  Object.entries(attrs).forEach(([key, val]) => {
    if (key.startsWith('on') && typeof val === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), val);
    } else if (key === 'class') {
      element.className = val;
    } else if (key === 'dataset') {
      Object.entries(val).forEach(([k, v]) => (element.dataset[k] = v));
    } else if (key === 'style' && typeof val === 'object') {
      Object.assign(element.style, val);
    } else {
      element.setAttribute(key, val);
    }
  });
  children.flat().forEach(child => {
    if (child instanceof Node) element.appendChild(child);
    else if (child != null) element.appendChild(document.createTextNode(String(child)));
  });
  return element;
}

// Safe element assignment helper
function setText(el, text) {
  if (el) el.textContent = text;
}
function setDisabled(el, disabled) {
  if (el) el.disabled = disabled;
}
function setValue(el, value) {
  if (el) el.value = value;
}
function setStyleDisplay(el, display) {
  if (el) el.style.display = display;
}
function setInnerHTML(el, html) {
  if (el) el.innerHTML = html;
}
function setClassName(el, className) {
  if (el) el.className = className;
}

// Main render function
function renderCustomerPage() {
  const app = $('#app');
  const isPassport = customerOptions.service === 'passport';

  app.innerHTML = `
    <a href="#main-content" class="skip-link">Skip to main content</a>
    <header class="customer-head" role="banner">
      <a class="logo" href="/"><img src="/icon.svg" alt="">SHRI Print</a>
      <div class="shop-tag">${esc(config.shopName)}<br><small>Customer Print Desk</small></div>
    </header>
    <main id="main-content" class="customer" role="main">
      ${renderStepper()}
      <div class="customer-layout">
        <div class="steps-container">
          ${renderStep1()}
          ${renderStep2()}
          ${renderStep3()}
          ${renderStep4()}
        </div>
        <aside class="summary-card" aria-label="Order summary">
          ${renderSummary()}
        </aside>
      </div>
    </main>
    ${renderCropModal()}
  `;

  if (isPassport) {
    pkgSelector = createPhotoPackageSelector(config);
    pkgSelector.setValues(customerOptions);
    $('#pkg-selector').appendChild(pkgSelector.element);
  } else pkgSelector = null;
  renderFilePreviews();
  bindAllEvents();
  updateQuote();
  updateStepVisibility();
}

function renderStepper() {
  const steps = [
    { num: 1, label: 'Service' },
    { num: 2, label: 'Upload' },
    { num: 3, label: customerOptions.service === 'passport' ? 'Crop' : 'Settings' },
    { num: 4, label: 'Review' },
  ];
  return `
    <nav class="stepper" aria-label="Order steps">
      ${steps
        .map(
          (s, i) => `
        <div class="stepper-item ${i < currentStep - 1 ? 'completed' : i === currentStep - 1 ? 'active' : ''}" data-step="${s.num}">
          <div class="stepper-step" aria-current="${i === currentStep - 1 ? 'step' : 'false'}">${s.num}</div>
          <span class="stepper-label">${esc(s.label)}</span>
        </div>
      `
        )
        .join('')}
    </nav>
  `;
}

function renderStep1() {
  return `
    <section class="step-panel card" data-step="1" role="region" aria-labelledby="step1-title">
      <div class="card-header">
        <div>
          <span class="eyebrow">STEP 1</span>
          <h2 id="step1-title" class="card-title">Choose Print Service</h2>
          <p class="card-subtitle">What would you like us to prepare?</p>
        </div>
      </div>
      <div class="service-grid" role="radiogroup" aria-label="Print services">
        ${SERVICES.map(
          s => `
          <label class="service-card ${customerOptions.service === s.id ? 'selected' : ''}" data-service="${s.id}" tabindex="0" role="radio" aria-checked="${customerOptions.service === s.id}">
            <input type="radio" name="service" value="${s.id}" ${customerOptions.service === s.id ? 'checked' : ''} class="sr-only">
            <div class="service-card-icon" aria-hidden="true">${s.icon}</div>
            <strong class="service-card-title">${esc(s.title)}</strong>
            <small class="service-card-desc">${esc(s.desc)}</small>
            <span class="service-card-check" aria-hidden="true">✓</span>
          </label>
        `
        ).join('')}
      </div>
    </section>
  `;
}

function renderStep2() {
  const isPassport = customerOptions.service === 'passport';
  const accept = isPassport ? 'image/jpeg,image/png' : 'application/pdf,image/jpeg,image/png';
  const multiple = !isPassport;
  const hint = isPassport
    ? 'One portrait JPG/PNG · up to 25 MB'
    : 'PDF, JPG or PNG · up to 25 MB each · 40 MB total';

  let html = `
    <section class="step-panel card" data-step="2" role="region" aria-labelledby="step2-title" style="display: none;">
      <div class="card-header">
        <div>
          <span class="eyebrow">STEP 2</span>
          <h2 id="step2-title" class="card-title">${isPassport ? 'Upload Photo' : 'Upload Documents'}</h2>
          <p class="card-subtitle">${esc(hint)}</p>
        </div>
      </div>
  `;

  if (isPassport) {
    html += `
      <div id="passport-packages" class="mb-6">
        <h3 class="form-label mb-3">Choose Photo Package</h3>
        <div class="package-grid" id="pkg-selector" role="radiogroup" aria-label="Photo packages"></div>
      </div>
    `;
  }

  html += `
      <div class="upload-zone" id="upload-zone" tabindex="0" role="button" aria-label="${isPassport ? 'Upload passport photo' : 'Upload documents'}" aria-describedby="upload-hint">
        <svg class="upload-zone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="17 8 12 3 7 8"></polyline>
          <line x1="12" y1="3" x2="12" y2="15"></line>
        </svg>
        <strong class="upload-zone-title">${isPassport ? 'Upload Passport Photo' : 'Upload Documents'}</strong>
        <p class="upload-zone-hint" id="upload-hint">${esc(hint)}</p>
        <div class="upload-zone-formats" aria-label="Accepted formats">
          ${accept
            .split(',')
            .map(
              f =>
                `<span class="upload-zone-format">${esc(f.replace('.', '').toUpperCase())}</span>`
            )
            .join('')}
        </div>
        <input type="file" id="files" ${multiple ? 'multiple' : ''} accept="${accept}" aria-label="Select files" hidden>
      </div>
      <div id="file-preview-grid" class="file-preview-grid" role="list" aria-label="Selected files" style="display: none;"></div>
      <p class="form-hint" style="margin-top: 12px;">Files are removed after ${config.retentionHours} hours. Keep your order link private.</p>
    </section>
  `;

  return html;
}

function renderStep3() {
  const isPassport = customerOptions.service === 'passport';

  if (isPassport) {
    return `
      <section class="step-panel card" data-step="3" role="region" aria-labelledby="step3-title" style="display: none;">
        <div class="card-header">
          <div>
            <span class="eyebrow">STEP 3</span>
            <h2 id="step3-title" class="card-title">Crop & Align Photo</h2>
            <p class="card-subtitle">Adjust the crop to frame the face. 35:45 aspect ratio maintained.</p>
          </div>
        </div>
        <div class="crop-section" id="crop-section" style="display: none;">
          <p id="crop-approval">Apply your crop before continuing.</p><button type="button" id="edit-crop" class="btn btn-secondary">Open crop editor</button>
        </div>
        <p class="form-hint" style="margin-top: 12px;">Choose a clear portrait. Photos are processed on this device; check the final PDF before sending.</p>${renderPaymentFields()}
      </section>
    `;
  }

  return `
    <section class="step-panel card" data-step="3" role="region" aria-labelledby="step3-title" style="display: none;">
      <div class="card-header">
        <div>
          <span class="eyebrow">STEP 3</span>
          <h2 id="step3-title" class="card-title">Print Settings</h2>
          <p class="card-subtitle">Configure your print options</p>
        </div>
      </div>
      <div class="grid grid-2">
        <div class="form-field">
          <label class="form-label">Print Mode</label>
          <div class="flex gap-2" role="radiogroup" aria-label="Print mode">
            ${[
              ['bw', 'Black & White'],
              ['color', 'Color'],
            ]
              .map(
                ([v, n]) => `
              <label class="btn btn-outline flex-1 ${customerOptions.color === v ? 'btn-primary' : ''}" data-color="${v}" tabindex="0" role="radio" aria-checked="${customerOptions.color === v}">
                <input type="radio" name="color" value="${v}" ${customerOptions.color === v ? 'checked' : ''} class="sr-only">
                ${esc(n)}
              </label>
            `
              )
              .join('')}
          </div>
        </div>
        <div class="form-field">
          <label class="form-label">Paper Size</label>
          <select id="paper" class="input select" aria-label="Paper size">
            ${['A4', 'A3', 'A2', 'A1'].map(v => `<option value="${v}" ${customerOptions.paper === v ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="form-field">
          <label class="form-label">Copies</label>
          <input type="number" id="copies" class="input" min="1" max="100" value="${customerOptions.copies}" aria-label="Number of copies">
        </div>
        <div class="form-field">
          <label class="form-label">Orientation</label>
          <select id="orientation" class="input select" aria-label="Orientation">
            ${[
              ['portrait', 'Portrait'],
              ['landscape', 'Landscape'],
            ]
              .map(
                ([v, n]) =>
                  `<option value="${v}" ${customerOptions.orientation === v ? 'selected' : ''}>${esc(n)}</option>`
              )
              .join('')}
          </select>
        </div>
        <div class="form-field">
          <label class="form-label checkbox">
            <input type="checkbox" id="duplex" class="sr-only" ${customerOptions.duplex ? 'checked' : ''}>
            <span class="box" aria-hidden="true"></span>
            <span class="checkbox-label">Duplex (double-sided)</span>
          </label>
        </div>
        <div class="form-field">
          <label class="form-label" for="range">Page Range</label>
          <input type="text" id="range" class="input" placeholder="e.g. 1-3,5" value="${esc(customerOptions.range)}" aria-label="Page range">
          <p class="form-hint">Leave blank for all pages</p>
        </div>
      </div>
      <div class="form-field mt-4">
        <label class="form-label">Payment Method</label>
        <div class="flex gap-2 flex-wrap" role="radiogroup" aria-label="Payment method">
          ${[
            ['cash', '💵 Pay at Desk'],
            ['upi', '📱 UPI QR'],
            ['online', '💳 Online'],
          ]
            .filter(([v]) =>
              v === 'cash'
                ? config.cash
                : v === 'upi'
                  ? config.upiAvailable
                  : v === 'online'
                    ? config.online
                    : false
            )
            .map(
              ([v, n]) => `
            <label class="btn btn-outline ${customerOptions.method === v ? 'btn-primary' : ''}" data-method="${v}" tabindex="0" role="radio" aria-checked="${customerOptions.method === v}">
              <input type="radio" name="method" value="${v}" ${customerOptions.method === v ? 'checked' : ''} class="sr-only">
              ${esc(n)}
            </label>
          `
            )
            .join('')}
        </div>
      </div>
      <div class="form-field">
        <label class="form-label" for="mobile">Mobile (optional)</label>
        <input type="tel" id="mobile" class="input" placeholder="10-digit number" value="${esc(customerOptions.mobile)}" maxlength="10" inputmode="numeric" aria-label="Mobile number">
      </div>
    </section>
  `;
}

function renderStep4() {
  return `
    <section class="step-panel card" data-step="4" role="region" aria-labelledby="step4-title" style="display: none;">
      <div class="card-header">
        <div>
          <span class="eyebrow">STEP 4</span>
          <h2 id="step4-title" class="card-title">Review & Confirm</h2>
          <p class="card-subtitle">Check everything looks correct before sending</p>
        </div>
      </div>
      <div id="review-content">
        <p class="form-hint text-center py-8">Complete the previous steps to see your order summary.</p>
      </div>
      <div class="card-footer" id="review-actions" style="display: none;">
        <button type="button" class="btn btn-secondary" id="back-to-edit">← Back to Edit</button>
        <button type="button" class="btn btn-primary btn-lg btn-block" id="confirm-order" disabled>
          <span id="confirm-text">Confirm & Continue</span>
          <span class="spinner spinner-sm" style="display: none;"></span>
        </button>
      </div>
    </section>
  `;
}

function renderSummary() {
  return `
    <div class="summary-header">
      <h3 class="summary-title">Order Summary</h3>
    </div>
    <div class="summary-lines" id="quote-lines"></div>
    <div class="summary-line summary-total"><span>Total</span><strong id="quote-total">₹0.00</strong></div>
    <p class="form-hint" id="quote-help"></p>
    <div class="summary-actions">
      <button type="button" class="btn btn-secondary btn-block" id="summary-back" style="display: none;">← Back to Edit</button>
      <button type="button" class="btn btn-primary btn-lg btn-block" id="summary-continue" disabled>
        <span id="summary-continue-text">Continue to Review</span>
        <span class="spinner spinner-sm" style="display: none;"></span>
      </button>
    </div>
    <p class="form-hint text-center" style="margin-top: 12px;">Final total confirmed by server</p>
  `;
}

function renderCropModal() {
  return `
    <div class="crop-modal" id="crop-modal" role="dialog" aria-modal="true" aria-labelledby="crop-title" style="display: none;">
      <div class="crop-modal-content">
        <header class="crop-header">
          <h2 id="crop-title" class="crop-title">Crop & Align</h2>
          <span class="crop-status info" id="crop-status">Loading...</span>
        </header>
        <div class="crop-toolbar" role="toolbar" aria-label="Crop tools">
          <div class="crop-toolbar-group">
            <button class="crop-btn" id="crop-zoom-out" aria-label="Zoom out" title="Zoom out">−</button>
            <input type="range" id="crop-zoom-range" min="1" max="3" step="0.1" value="1" aria-label="Zoom level" style="width: 120px;">
            <button class="crop-btn" id="crop-zoom-in" aria-label="Zoom in" title="Zoom in">+</button>
            <button class="crop-btn" id="crop-zoom-reset" aria-label="Reset zoom" title="Reset zoom">1:1</button>
          </div>
          <div class="crop-toolbar-group">
            <button class="crop-btn" id="crop-rotate-left" aria-label="Rotate left" title="Rotate left">↶ 90°</button>
            <button class="crop-btn" id="crop-rotate-right" aria-label="Rotate right" title="Rotate right">↷ 90°</button>
          </div>
          <div class="crop-toolbar-group">
            <button class="crop-btn" id="crop-reset" aria-label="Reset crop" title="Reset to face detection">Reset</button>
          </div>
        </div>
        <div id="crop-host"></div>
        <footer class="crop-footer">
          <button class="btn btn-secondary" id="crop-cancel">Cancel</button>
          <button class="btn btn-primary btn-lg" id="crop-apply" disabled>
            <span>Apply Crop</span>
            <span class="spinner spinner-sm" style="display: none;"></span>
          </button>
        </footer>
      </div>
    </div>
  `;
}

// Event binding
function bindAllEvents() {
  // Service selection
  $$('.service-card[data-service]').forEach(card => {
    card.addEventListener('click', () => selectService(card.dataset.service));
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectService(card.dataset.service);
      }
    });
  });

  // Color buttons
  $$('[data-color]').forEach(btn =>
    btn.addEventListener('click', () => setColor(btn.dataset.color))
  );

  // Paper, orientation, duplex, range
  const paperEl = $('#paper');
  if (paperEl)
    paperEl.addEventListener('change', e => {
      customerOptions.paper = e.target.value;
      savePrefs();
      updateQuote();
    });
  const orientationEl = $('#orientation');
  if (orientationEl)
    orientationEl.addEventListener('change', e => {
      customerOptions.orientation = e.target.value;
      savePrefs();
      updateQuote();
    });
  const copiesEl = $('#copies');
  if (copiesEl)
    copiesEl.addEventListener('input', e => {
      customerOptions.copies = Math.max(1, Math.min(100, parseInt(e.target.value) || 1));
      savePrefs();
      updateQuote();
      updateSetsUI();
    });
  const duplexEl = $('#duplex');
  if (duplexEl)
    duplexEl.addEventListener('change', e => {
      customerOptions.duplex = e.target.checked;
      savePrefs();
      updateQuote();
    });
  const rangeEl = $('#range');
  if (rangeEl)
    rangeEl.addEventListener('input', e => {
      customerOptions.range = e.target.value;
      savePrefs();
      updateQuote();
    });

  // Method buttons
  $$('[data-method]').forEach(btn =>
    btn.addEventListener('click', () => setMethod(btn.dataset.method))
  );

  // Mobile input
  const mobileEl = $('#mobile');
  if (mobileEl)
    mobileEl.addEventListener('input', e => {
      customerOptions.mobile = e.target.value.replace(/\D/g, '').slice(0, 10);
      savePrefs();
    });

  // Passport package selector
  if (pkgSelector) {
    pkgSelector.setOnChange(values => {
      customerOptions.photoQty = values.photoQty;
      customerOptions.copies = values.copies;
      savePrefs();
      updateQuote();
      updateSetsUI();
    });
  }

  // Upload zone
  const uploadZone = $('#upload-zone');
  const fileInput = $('#files');
  if (uploadZone && fileInput) {
    uploadZone.addEventListener('click', e => {
      if (e.target !== fileInput) fileInput.click();
    });
    uploadZone.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
      }
    });
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
      uploadZone.addEventListener(evt, e => {
        e.preventDefault();
        e.stopPropagation();
        if (evt === 'dragenter' || evt === 'dragover') {
          uploadZone.classList.add('dragover');
        } else {
          uploadZone.classList.remove('dragover');
        }
        if (evt === 'drop') handleFiles(e.dataTransfer.files);
      });
    });
    fileInput.addEventListener('change', e => handleFiles(e.target.files));
  }

  // Navigation
  const backToEdit = $('#back-to-edit');
  if (backToEdit) backToEdit.addEventListener('click', () => goToStep(1));
  const summaryBack = $('#summary-back');
  if (summaryBack)
    summaryBack.addEventListener('click', () => goToStep(currentStep > 1 ? currentStep - 1 : 1));
  const summaryContinue = $('#summary-continue');
  if (summaryContinue)
    summaryContinue.addEventListener('click', () => {
      if (currentStep === 3) handleConfirmOrder();
      else goToStep(Math.min(currentStep + 1, maxSteps));
    });
  const confirmOrder = $('#confirm-order');
  if (confirmOrder) confirmOrder.addEventListener('click', handleFinalConfirm);

  bindCropEditor();
  // Crop modal
  const cropCancel = $('#crop-cancel');
  if (cropCancel) cropCancel.addEventListener('click', closeCropModal);
  const cropApply = $('#crop-apply');
  if (cropApply) cropApply.addEventListener('click', applyCrop);
  const cropReset = $('#crop-reset');
  if (cropReset) cropReset.addEventListener('click', resetCrop);
  $$(
    '#crop-zoom-in, #crop-zoom-out, #crop-zoom-reset, #crop-rotate-left, #crop-rotate-right'
  ).forEach(btn => {
    btn.addEventListener('click', () => handleCropTool(btn.id));
  });
  const cropZoomRange = $('#crop-zoom-range');
  if (cropZoomRange)
    cropZoomRange.addEventListener('input', e => {
      if (cropWorkspace) cropWorkspace.zoom(parseFloat(e.target.value));
    });
  const cropModal = $('#crop-modal');
  if (cropModal)
    cropModal.addEventListener('click', e => {
      if (e.target === e.currentTarget) closeCropModal();
    });
}

// Service selection
function selectService(serviceId) {
  const wasPassport = customerOptions.service === 'passport';
  if (serviceId !== customerOptions.service) {
    files = [];
    pageCounts = [];
    draft = null;
    originalFile = null;
    cropApproved = false;
    appliedCrop = null;
    cropWorkspace?.destroy();
    cropWorkspace = null;
  }
  customerOptions.service = serviceId;
  savePrefs();

  // Reset passport-specific options
  if (serviceId === 'passport') {
    customerOptions.range = '';
    customerOptions.paper = 'A4';
    customerOptions.color = 'color';
    customerOptions.orientation = 'portrait';
    customerOptions.duplex = false;
  } else if (wasPassport) {
    // Reset from passport defaults
    customerOptions.copies = 1;
  }
  savePrefs();

  currentStep = 1;
  renderCustomerPage();
}

// Color selection
function setColor(color) {
  customerOptions.color = color;
  savePrefs();
  updateQuote();
  renderCustomerPage();
}

// Method selection
function setMethod(method) {
  customerOptions.method = method;
  savePrefs();
  updateQuote();
  renderCustomerPage();
}

// Step navigation
function goToStep(step) {
  if (step < 1 || step > maxSteps) return;
  if (step > currentStep && !canProceed()) {
    toast('Please complete the current step first', 'warning');
    return;
  }
  if (step < 4) draft = null;
  currentStep = step;
  updateStepVisibility();
  updateQuote();
}

function canProceed() {
  switch (currentStep) {
    case 1:
      return !!customerOptions.service;
    case 2:
      return files.length > 0 && pageCounts.length === files.length;
    case 3:
      return (
        files.length > 0 &&
        pageCounts.length === files.length &&
        (customerOptions.service !== 'passport' || cropApproved)
      );
    case 4:
      return !!draft && !!$('#review-check')?.checked;
    default:
      return false;
  }
}

function updateStepVisibility() {
  $$('.step-panel[data-step]').forEach(panel => {
    const step = parseInt(panel.dataset.step);
    panel.style.display = step === currentStep ? 'block' : 'none';
  });
  $$('.stepper-item').forEach((item, i) => {
    const step = i + 1;
    item.classList.toggle('completed', step < currentStep);
    item.classList.toggle('active', step === currentStep);
    const stepEl = item.querySelector('.stepper-step');
    if (stepEl) stepEl.setAttribute('aria-current', step === currentStep ? 'step' : 'false');
  });

  // Update summary card buttons
  const summaryBack = $('#summary-back');
  const summaryContinue = $('#summary-continue');
  const continueText = $('#summary-continue-text');

  if (currentStep < maxSteps) {
    setStyleDisplay(summaryBack, currentStep > 1 ? 'block' : 'none');
    setStyleDisplay(summaryContinue, 'block');
    if (continueText) {
      continueText.textContent =
        currentStep === 1
          ? 'Continue to Upload'
          : currentStep === 2
            ? 'Continue to ' + (customerOptions.service === 'passport' ? 'Crop' : 'Settings')
            : 'Continue to Review';
    }
  } else {
    setStyleDisplay(summaryBack, 'block');
    setStyleDisplay(summaryContinue, 'none');
  }
}

// File handling
async function handleFiles(fileList) {
  const newFiles = [...fileList];
  const isPassport = customerOptions.service === 'passport';

  if (isPassport && newFiles.length > 1) {
    toast('Passport photos: only one photo allowed', 'warning');
    return;
  }

  if (isPassport && newFiles[0]?.type === 'application/pdf') {
    toast('Passport photos must be JPG or PNG', 'error');
    return;
  }

  // Validate sizes
  for (const file of newFiles) {
    if (file.size > 25 * 1024 * 1024) {
      toast(`${esc(file.name)} exceeds 25 MB limit`, 'error');
      return;
    }
  }
  const totalSize = [...files, ...newFiles].reduce((s, f) => s + f.size, 0);
  if (totalSize > 40 * 1024 * 1024) {
    toast('Total upload size exceeds 40 MB', 'error');
    return;
  }

  files = isPassport ? newFiles : [...files, ...newFiles].slice(0, 10);
  pageCounts = [];

  if (cropWorkspace) {
    cropWorkspace.destroy();
    cropWorkspace = null;
  }
  closeCropModal();

  try {
    for (const file of files) {
      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        const { PDFDocument } = await import('pdf-lib');
        const doc = await PDFDocument.load(await file.arrayBuffer());
        pageCounts.push(doc.getPageCount());
      } else {
        pageCounts.push(1);
      }
    }
    renderFilePreviews();
    updateQuote();

    if (isPassport && files.length === 1) {
      originalFile = files[0];
      appliedCrop = null;
      cropApproved = false;
      openCropModal();
    }
  } catch {
    toast('A PDF could not be read. Unlock it or choose another file.', 'error');
    pageCounts = [];
  }
}

function renderFilePreviews() {
  const grid = $('#file-preview-grid');
  if (!grid) return;

  if (files.length === 0) {
    grid.style.display = 'none';
    return;
  }

  grid.style.display = 'grid';
  grid.innerHTML = files
    .map(
      (f, i) => `
    <div class="file-preview-item" role="listitem" data-index="${i}">
      ${f.type.startsWith('image/') ? `<img class="file-preview-thumb" src="${URL.createObjectURL(f)}" alt="">` : `<div class="file-preview-thumb" style="display:flex;align-items:center;justify-content:center;color:var(--color-text-muted);font-size:24px;">📄</div>`}
      <div class="file-preview-info">
        <div class="file-preview-name">${esc(f.name)}</div>
        <div class="file-preview-meta">${pageCounts[i]} page(s) · ${formatBytes(f.size)}</div>
      </div>
      <button class="file-preview-remove" data-index="${i}" aria-label="Remove ${esc(f.name)}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
    </div>
  `
    )
    .join('');

  $$('.file-preview-remove', grid).forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      files.splice(idx, 1);
      pageCounts.splice(idx, 1);
      if (cropWorkspace) {
        cropWorkspace.destroy();
        cropWorkspace = null;
        closeCropModal();
      }
      renderFilePreviews();
      updateQuote();
    });
  });
}

// Crop modal
function openCropModal() {
  if (!files.length || customerOptions.service !== 'passport') return;

  const modal = $('#crop-modal');
  setStyleDisplay(modal, 'flex');
  document.body.style.overflow = 'hidden';

  const cropSection = $('#crop-section');
  const cropWorkspaceEl = $('#crop-host');
  if (cropSection) setStyleDisplay(cropSection, 'block');

  if (!cropWorkspace) {
    cropWorkspace = createCropWorkspace();
    if (cropWorkspaceEl) cropWorkspaceEl.appendChild(cropWorkspace.element);
    cropWorkspace.setCallbacks({
      onCropChange: crop => {
        cropApproved = false;
        updateQuote();
        const applyBtn = $('#crop-apply');
        setDisabled(applyBtn, !crop);
        // Don't update files yet - wait for explicit Apply
      },
      onError: err => toast(err.message, 'error'),
    });
    cropWorkspace.loadImage(originalFile || files[0]).catch(e => toast(e.message, 'error'));
  } else {
    cropWorkspaceEl?.appendChild(cropWorkspace.element);
    cropWorkspace.drawPreview();
    setDisabled($('#crop-apply'), !cropWorkspace.getCrop());
  }

  const cropZoomRange = $('#crop-zoom-range');
  if (cropZoomRange && cropWorkspace) cropZoomRange.value = cropWorkspace.getZoom?.() || 1;
}

function closeCropModal() {
  const modal = $('#crop-modal');
  setStyleDisplay(modal, 'none');
  document.body.style.overflow = '';
}

function resetCrop() {
  if (cropWorkspace) {
    cropWorkspace.reset();
    cropApproved = false;
    const status = $('#crop-status');
    if (status) {
      setText(status, 'Crop suggested · press Apply');
      setClassName(status, 'crop-status info');
    }
    const applyBtn = $('#crop-apply');
    setDisabled(applyBtn, !cropWorkspace.getCrop());
  }
}

function handleCropTool(id) {
  if (!cropWorkspace) return;
  switch (id) {
    case 'crop-zoom-in':
      cropWorkspace.zoom(cropWorkspace.getZoom() * 1.2);
      break;
    case 'crop-zoom-out':
      cropWorkspace.zoom(cropWorkspace.getZoom() / 1.2);
      break;
    case 'crop-zoom-reset':
      cropWorkspace.resetZoom();
      break;
    case 'crop-rotate-left':
      cropWorkspace.rotate(-90);
      break;
    case 'crop-rotate-right':
      cropWorkspace.rotate(90);
      break;
  }
  const range = $('#crop-zoom-range');
  if (range) range.value = cropWorkspace.getZoom();
}

async function applyCrop() {
  if (!cropWorkspace) return;
  const applyBtn = $('#crop-apply');
  setDisabled(applyBtn, true);
  const spinner = applyBtn.querySelector('.spinner-sm');
  if (spinner) spinner.style.display = 'inline-block';
  const btnText = applyBtn.querySelector('span:first-child');
  if (btnText) btnText.textContent = 'Applying...';

  try {
    const blob = await cropWorkspace.getCroppedBlob();
    if (blob) {
      files = [new File([blob], 'cropped-passport.jpg', { type: 'image/jpeg' })];
      appliedCrop = cropWorkspace.getCrop();
      cropApproved = true;
      renderFilePreviews();
      updateQuote();
      toast('Crop applied successfully', 'success');
      const status = $('#crop-status');
      if (status) {
        setText(status, 'Crop applied');
        setClassName(status, 'crop-status good');
      }
    }
    setText($('#crop-approval'), 'Crop applied. Ready for PDF preview.');
    closeCropModal();
    updateQuote();
  } catch (e) {
    toast('Failed to apply crop', 'error');
  } finally {
    setDisabled(applyBtn, false);
    if (spinner) spinner.style.display = 'none';
    if (btnText) btnText.textContent = 'Apply Crop';
  }
}

// Quote calculation
function updateQuote() {
  const isPassport = customerOptions.service === 'passport';
  let amount = 0,
    count = 0,
    error = 'Select files to calculate your total.';
  let lines = [];

  try {
    if (!isPassport && (!files.length || pageCounts.length !== files.length))
      throw new Error(error);
    if (
      files.length > 10 ||
      files.some(f => f.size > 25 * 1024 * 1024) ||
      files.reduce((s, f) => s + f.size, 0) > 40 * 1024 * 1024
    ) {
      throw new Error('Use up to 10 files, 25 MB each and 40 MB combined.');
    }
    if (
      isPassport &&
      files.length > 0 &&
      (files.length !== 1 || files[0].type === 'application/pdf')
    ) {
      throw new Error('Passport photos need one JPG/PNG.');
    }
    if (
      customerOptions.service === 'id' &&
      (files.length !== 2 || files.some(f => f.type === 'application/pdf'))
    ) {
      throw new Error('Choose front and back JPG/PNG images.');
    }
    count = parsePages(
      customerOptions.range,
      isPassport ? 1 : pageCounts.reduce((a, b) => a + b, 0)
    ).length;
    if (
      !Number.isInteger(customerOptions.copies) ||
      customerOptions.copies < 1 ||
      customerOptions.copies > 100
    ) {
      throw new Error('Copies must be 1–100.');
    }
    amount = quote(count, customerOptions, config);
    error = isPassport
      ? `${customerOptions.photoQty * customerOptions.copies} photos · ${customerOptions.copies} set(s) on A4`
      : `${count * customerOptions.copies} page copies · final total confirmed by the server`;

    if (isPassport) {
      lines = [
        {
          label: 'Photo Package',
          value: `${customerOptions.photoQty} photos × ${customerOptions.copies} sets`,
        },
        { label: 'Paper / Mode', value: 'A4 · Color' },
        { label: 'Total Photos', value: `${customerOptions.photoQty * customerOptions.copies}` },
        {
          label: 'Price per Set',
          value: money(photoPackagePrice(customerOptions.photoQty, config)),
        },
      ];
    } else {
      lines = [
        { label: 'Documents', value: `${files.length}` },
        { label: 'Selected Pages × Copies', value: `${count} × ${customerOptions.copies}` },
        {
          label: 'Paper / Mode',
          value: `${customerOptions.paper} · ${customerOptions.color === 'bw' ? 'B&W' : 'Color'}`,
        },
      ];
    }
  } catch (e) {
    error = e.message;
  }

  // Update summary card
  const quoteLines = $('#quote-lines');
  setInnerHTML(
    quoteLines,
    lines
      .map(
        l => `
    <div class="summary-line">
      <span class="summary-line-label">${esc(l.label)}</span>
      <span class="summary-line-value">${esc(l.value)}</span>
    </div>
  `
      )
      .join('')
  );

  setText($('#quote-total'), money(amount));
  setText($('#quote-help'), error);
  setText($('#total-photos'), customerOptions.photoQty * customerOptions.copies);

  // Enable/disable continue buttons
  const canProceedNow = canProceed();
  $$('#summary-continue, #confirm-order').forEach(btn => (btn.disabled = !canProceedNow));
}

function updateSetsUI() {
  const val = $('#sets-value');
  setText(val, customerOptions.copies);
  const decBtn = $(".sets-counter-btn[data-action='decrease']");
  const incBtn = $(".sets-counter-btn[data-action='increase']");
  setDisabled(decBtn, customerOptions.copies <= 1);
  setDisabled(incBtn, customerOptions.copies >= 10);
}

// Review step
async function handleConfirmOrder() {
  if (previewBusy || !canProceed()) return;
  previewBusy = true;
  const confirmBtn = $('#confirm-order');
  const confirmText = $('#confirm-text');
  const spinner = confirmBtn?.querySelector('.spinner-sm');

  setDisabled(confirmBtn, true);
  if (confirmText) confirmText.textContent = 'Preparing preview…';
  setDisabled($('#summary-continue'), true);
  setText($('#summary-continue-text'), 'Preparing PDF…');
  if (spinner) spinner.style.display = 'inline-block';

  try {
    const form = new FormData();
    for (const file of files) form.append('files', file);
    form.append('options', JSON.stringify(customerOptions));

    const response = await fetch('/api/orders', { method: 'POST', body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed');

    draft = data;
    renderReview();
    currentStep = 4;
    updateStepVisibility();
    updateQuote();
    toast('Preview ready. Please review and confirm.', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    previewBusy = false;
    setDisabled(confirmBtn, currentStep === 4 ? !$('#review-check')?.checked : false);
    if (confirmText)
      confirmText.textContent = currentStep === 4 ? 'Confirm & Send' : 'Confirm & Continue';
    if (spinner) spinner.style.display = 'none';
  }
}

async function handleFinalConfirm() {
  const confirmBtn = $('#confirm-order');
  const confirmText = $('#confirm-text');
  const spinner = confirmBtn?.querySelector('.spinner-sm');

  if (!draft) return;

  setDisabled(confirmBtn, true);
  if (confirmText) confirmText.textContent = 'Sending to printer…';
  if (spinner) spinner.style.display = 'inline-block';

  try {
    if (!$('#review-check')?.checked) throw new Error('Please check the PDF preview first.');
    const result = await fetch('/api/orders/' + draft.token + '/confirm', { method: 'POST' });
    const response = await result.json();
    if (!result.ok) throw new Error(response.error || 'Could not send request.');
    location.href = '/order/' + draft.token;
  } catch (e) {
    toast(e.message, 'error');
    setDisabled(confirmBtn, false);
    const ct = $('#confirm-text');
    if (ct) ct.textContent = 'Confirm & Send';
    const sp = confirmBtn?.querySelector('.spinner-sm');
    if (sp) sp.style.display = 'none';
  }
}

function renderReview() {
  const reviewContent = $('#review-content');
  const reviewActions = $('#review-actions');
  if (!reviewContent || !reviewActions || !draft) return;

  const d = draft;
  const isPassport = d.options.service === 'passport';

  setInnerHTML(
    reviewContent,
    `
    <div class="card mb-4">
      <iframe class="preview" title="Prepared PDF preview" src="/preview?order=${d.token}" style="width:100%;height:400px;border:none;border-radius:var(--radius-md);"></iframe>
      <div class="flex gap-2 mt-4">
        <a class="btn btn-secondary" href="/api/orders/${d.token}/file" download="print-preview.pdf">Download PDF</a>
      </div>
    </div>
    <div class="grid grid-2 mb-4">
      <div class="card p-4">
        <h4 class="font-semibold mb-2">Order Details</h4>
        <div class="space-2 text-sm">
          <div class="flex justify-between"><span class="text-muted">Service</span><span>${esc(SERVICES.find(s => s.id === d.options.service)?.title)}</span></div>
          <div class="flex justify-between"><span class="text-muted">${isPassport ? 'Photos × Sets' : 'Pages × Copies'}</span><span>${isPassport ? d.options.photoQty : d.pages} × ${d.options.copies}</span></div>
          <div class="flex justify-between"><span class="text-muted">Paper / Mode</span><span>${esc(d.options.paper)} · ${d.options.color === 'bw' ? 'B&W' : 'Color'}</span></div>
          <div class="flex justify-between"><span class="text-muted">Total</span><span class="font-semibold">${money(d.amount)}</span></div>
        </div>
      </div>
      <div class="card p-4">
        <h4 class="font-semibold mb-2">Payment</h4>
        <div class="space-2 text-sm">
          <div class="flex justify-between"><span class="text-muted">Method</span><span>${d.method === 'cash' ? 'Pay at Desk' : d.method === 'upi' ? 'UPI QR' : 'Online'}</span></div>
          <div class="flex justify-between"><span class="text-muted">Status</span><span class="badge badge-${d.payment === 'paid' ? 'success' : 'warning'}">${d.payment === 'paid' ? 'Paid' : 'Pending'}</span></div>
        </div>
      </div>
    </div>
    <label class="checkline">
      <input type="checkbox" id="review-check">
      <span>I confirm the preview, page selection, and print settings are correct</span>
    </label>
  `
  );

  setStyleDisplay(reviewActions, 'flex');

  // Update button for final confirmation
  const confirmBtn = $('#confirm-order');
  const confirmText = $('#confirm-text');
  if (confirmBtn && confirmText) {
    confirmText.textContent = 'Confirm & Send';
    confirmBtn.disabled = true;
  }

  const reviewCheck = $('#review-check');
  if (reviewCheck)
    reviewCheck.addEventListener('change', e => {
      if (confirmBtn) confirmBtn.disabled = !e.target.checked;
    });

  const backToEdit = $('#back-to-edit');
  if (backToEdit) backToEdit.addEventListener('click', () => goToStep(1));
}

// Initialize
export function initCustomer(configData, callback) {
  config = configData;
  stateChangeCallback = callback;
  loadPrefs();
  if (
    (customerOptions.method === 'online' && !config.online) ||
    (customerOptions.method === 'upi' && !config.upiAvailable) ||
    (customerOptions.method === 'cash' && !config.cash)
  )
    customerOptions.method = config.cash ? 'cash' : config.upiAvailable ? 'upi' : 'online';
  if (customerOptions.service === 'passport')
    Object.assign(customerOptions, {
      paper: 'A4',
      color: 'color',
      orientation: 'portrait',
      duplex: false,
      copies: Math.min(10, customerOptions.copies),
    });
  renderCustomerPage();
}

// Helper to add sr-only class for accessibility
const style = document.createElement('style');
style.textContent = `
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  .mb-3 { margin-bottom: var(--space-3); }
  .mb-4 { margin-bottom: var(--space-4); }
  .mt-4 { margin-top: var(--space-4); }
  .p-4 { padding: var(--space-4); }
  .space-2 > * + * { margin-top: var(--space-2); }
  .text-center { text-align: center; }
  .text-muted { color: var(--color-text-muted); }
  .font-semibold { font-weight: var(--font-weight-semibold); }
  .flex { display: flex; }
  .gap-2 { gap: var(--space-2); }
  .justify-between { justify-content: space-between; }
  .space-1 { gap: var(--space-1); }
`;
document.head.appendChild(style);
function bindCropEditor() {
  const button = $('#edit-crop');
  if (button) button.onclick = openCropModal;
}
function renderPaymentFields() {
  return (
    '<div class="form-field mt-4"><label class="form-label">Payment method</label><div class="flex gap-2 flex-wrap">' +
    [
      ['cash', 'Pay at desk'],
      ['upi', 'UPI QR · shop verification'],
      ['online', 'Online · automatic confirmation'],
    ]
      .filter(([v]) =>
        v === 'cash' ? config.cash : v === 'upi' ? config.upiAvailable : config.online
      )
      .map(
        ([v, n]) =>
          '<button type="button" class="btn ' +
          (customerOptions.method === v ? 'btn-primary' : 'btn-secondary') +
          '" data-method="' +
          v +
          '">' +
          n +
          '</button>'
      )
      .join('') +
    '</div></div>'
  );
}
