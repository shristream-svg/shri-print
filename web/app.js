import QRCode from 'qrcode';
import { openAdminJob } from './admin-job.js';
import { initCustomer } from './customer-v3.js';
import { isCheckoutBusy, openOnlineCheckout } from './payment-ui.js';
import { initProductUI } from './product-ui.js';

const $ = s => document.querySelector(s),
  esc = s =>
    String(s ?? '').replace(
      /[&<>"']/g,
      c =>
        ({
          '&': '&#38;',
          '<': '&#60;',
          '>': '&#62;',
          '"': '&#34;',
          "'": "'",
        })[c]
    );
const money = n => '₹' + (Number(n || 0) / 100).toFixed(2),
  date = n =>
    new Date(n).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
const labels = {
  held: 'Paused · adjust',
  draft: 'Customer preparing',
  awaiting_approval: 'Pay at desk',
  awaiting_payment: 'Awaiting payment',
  queued: 'Queued',
  claimed: 'Sent to agent',
  submitted: 'Windows accepted',
  printed: 'Paper confirmed',
  failed: 'Print failed',
  cancelled: 'Cancelled',
  expired: 'Document expired',
  manual_duplex: 'At desk — double-sided',
};
const badge = (text, type = '') => `<span class="badge ${type}">${esc(text)}</span>`;
const statusBadge = s =>
  badge(
    labels[s] || s,
    ['printed'].includes(s)
      ? 'good'
      : ['failed', 'cancelled', 'expired'].includes(s)
        ? 'bad'
        : ['draft', 'awaiting_payment', 'awaiting_approval', 'manual_duplex'].includes(s)
          ? 'warn'
          : 'info'
  );
const logo = `<a class="logo" href="/"><span class="logo-mark" aria-hidden="true">S</span>SHRI Print</a>`;
let config,
  state,
  view = 'dashboard',
  liveInFlight = false,
  liveAbortController = null,
  liveBackoff = 1000,
  lastLiveSync = 0,
  liveTimer = null,
  liveGeneration = 0,
  receiptInFlight = false,
  receiptAbortController = null,
  lastReceiptKey = null,
  receiptTimer = null,
  receiptGeneration = 0,
  currentOrderToken = null;
async function api(path, body, method) {
  const r = await fetch(path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body instanceof FormData ? {} : body ? { 'Content-Type': 'application/json' } : {},
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
function toast(s) {
  $('#toast').textContent = s;
  $('#toast').classList.add('visible');
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4500);
}
function bind(id, event, fn) {
  const el = $(id);
  if (el) el.addEventListener(event, fn);
}
async function action(fn) {
  try {
    await fn();
  } catch (e) {
    toast(e.message);
  }
}
async function qr(selector, text, width = 200) {
  const image = $(selector);
  if (image)
    image.src = await QRCode.toDataURL(text, {
      width,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#122d29', light: '#ffffff' },
    });
}
function modal(title, text, button, callback, check = '') {
  const d = $('#dialog');
  $('#dialog-content').innerHTML =
    `<h2>${esc(title)}</h2><p>${esc(text)}</p>${check ? `<label class="checkline"><input id="modal-check" type="checkbox">${esc(check)}</label>` : ''}<div class="row"><button id="modal-ok" ${check ? 'disabled' : ''}>${esc(button)}</button><button id="modal-close" class="secondary">Back</button></div>`;
  d.showModal();
  bind('#modal-close', 'click', () => d.close());
  bind('#modal-check', 'change', e => ($('#modal-ok').disabled = !e.target.checked));
  bind('#modal-ok', 'click', async () => {
    $('#modal-ok').disabled = true;
    try {
      await callback();
      d.close();
    } catch (e) {
      toast(e.message);
      $('#modal-ok').disabled = false;
    }
  });
}
function download(name, data, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function getPaymentLabel(order) {
  const opts = order.options || {};
  if (order.method === 'upi' && opts.paymentChannel === 'razorpay_link') return 'Razorpay';
  if (order.method === 'upi') return 'UPI QR';
  if (order.method === 'online') return 'Online';
  if (order.method === 'cash') return 'Cash at desk';
  return order.method;
}

function getPaymentProfileForOrder(order) {
  const opts = order.options || {};
  if (order.method === 'upi' && opts.paymentProfile) return opts.paymentProfile;
  if (order.method === 'upi' && opts.paymentChannel === 'razorpay_link') {
    return { hostedPaymentUrl: opts.hostedPaymentUrl, payee: opts.payee || config.payee };
  }
  return config.paymentProfile || { upi: config.upi, payee: config.payee, qr: config.paymentQr };
}

async function renderStatus(token) {
  const d = await api('/api/orders/' + token);
  if (d.method === 'cash') {
    document.body.className = 'customer-v3-page';
    const text = {
      held: 'Staff is adjusting your print',
      awaiting_approval: 'Please pay at the counter',
      queued: 'Payment received — waiting to print',
      claimed: 'Printing request sent',
      submitted: 'Windows accepted your print',
      printed: 'Ready for pickup',
      manual_duplex: 'Staff is printing both sides',
      failed: 'Please contact the counter',
      cancelled: 'Request cancelled',
      expired: 'File expired — please upload again',
    };
    $('#app').innerHTML =
      customerHeader() +
      `<main class="cash-receipt"><section class="card"><span class="eyebrow">ORDER #${esc(d.id.slice(0, 8).toUpperCase())}</span><h1>${esc(text[d.status] || 'Preparing your request')}</h1><div class="cash-total">${money(d.amount)}</div><p>${d.payment === 'paid' ? 'Cash received and confirmed by staff.' : 'Staff will confirm cash received before printing.'}</p><p class="cash-status" role="status">${d.payment === 'paid' ? 'Payment confirmed' : 'Waiting for counter confirmation'}</p><small>${d.pages} page(s) × ${d.options.copies} · ${esc(d.options.paper)}</small><a class="button secondary" href="/">New print request</a></section></main>`;
    return;
  }
  const paymentProfile = getPaymentProfileForOrder(d);
  if (d.status === 'draft') {
    const _draft = d;
    const _renderReview = () => {};
    return;
  }
  const _done = ['queued', 'claimed', 'submitted', 'printed'].includes(d.status),
    _printed = d.status === 'printed';
  const pickupCode = d.id.slice(0, 8).toUpperCase();
  const paymentLabel = getPaymentLabel(d);
  const paymentStatus =
    d.payment === 'paid'
      ? 'Verified'
      : d.payment === 'reported'
        ? 'Reported — awaiting verification'
        : 'Pending';
  const statusLine1 =
    d.status === 'awaiting_approval'
      ? 'Waiting for shop to confirm payment'
      : d.status === 'awaiting_payment'
        ? `Payment pending — ${paymentLabel}`
        : d.status === 'queued'
          ? 'Queued for printing'
          : d.status === 'claimed'
            ? 'Sent to print agent'
            : d.status === 'submitted'
              ? 'Windows accepted — collecting at counter'
              : d.status === 'printed'
                ? 'Ready for pickup'
                : d.status === 'manual_duplex'
                  ? 'Waiting for staff to print both sides'
                  : d.status === 'failed'
                    ? 'Print failed — contact shop'
                    : d.status === 'cancelled'
                      ? 'Cancelled'
                      : d.status === 'expired'
                        ? 'Expired — re-upload required'
                        : 'Processing';
  const printed = d.status === 'printed';
  const statusLine2 = printed
    ? `Pickup code: ${pickupCode}`
    : d.payment !== 'paid'
      ? paymentStatus
      : '';
  $('#app').innerHTML =
    customerHeader() +
    `<main class="customer"><section class="card wide-card receipt-card"><div class="receipt-head"><div class="eyebrow">REQUEST ${esc(pickupCode)}</div><h1 class="status-title">${esc(labels[d.status] || d.status)}</h1>${statusBadge(d.status)}</div><p class="receipt-status">${esc(statusLine1)}</p>${statusLine2 ? `<p class="receipt-sub">${esc(statusLine2)}</p>` : ''}<div class="metric-strip"><div><strong>${money(d.amount)}</strong><small>${paymentLabel} · ${esc(d.payment)}</small></div><div><strong>${d.options.service === 'passport' ? d.options.photoQty * d.options.copies : d.pages * d.options.copies}</strong><small>${d.options.service === 'passport' ? 'photos' : 'page copies'} · ${esc(d.options.paper)}</small></div></div>${d.status === 'awaiting_payment' && d.method === 'upi' ? renderUpiSection(d, paymentProfile) : d.status === 'awaiting_payment' && d.method === 'online' ? `<div class="receipt-actions"><button id="pay-online" class="primary">${d.options.paymentChannel === 'razorpay_link' ? 'Open Razorpay Payment Page' : 'Pay Online'}</button></div>` : d.payment !== 'paid' && d.method !== 'cash' && ['awaiting_approval', 'awaiting_payment'].includes(d.status) ? `<div class="receipt-actions"><button id="upi-sent" class="secondary">I paid — report payment</button></div>` : ''}${d.status === 'printed' || d.status === 'submitted' ? `<div class="receipt-actions"><button id="refresh-status" class="secondary">Refresh status</button></div>` : ''}</section></main>`;
  if (d.status === 'awaiting_payment' && d.method === 'upi') {
    const upiLink =
      'upi://pay?' +
      new URLSearchParams({
        pa: paymentProfile.upi || '',
        pn: paymentProfile.payee || config.payee,
        am: (d.amount / 100).toFixed(2),
        cu: 'INR',
        tn: 'Print ' + token.slice(0, 8),
      });
    if (paymentProfile.upi) qr('#upi-qr', upiLink);
    else if (paymentProfile.qr)
      $('#upi-qr').src = '/api/payment-qr/' + encodeURIComponent(paymentProfile.qr);
    else if (paymentProfile.hostedPaymentUrl) {
      if ($('#upi-qr')) $('#upi-qr').style.display = 'none';
      $('#upi-qr-link').href = paymentProfile.hostedPaymentUrl;
      $('#upi-qr-link').style.display = 'inline-flex';
    } else qr('#upi-qr', upiLink);
    bind('#upi-sent', 'click', () =>
      action(async () => {
        await api('/api/orders/' + token + '/upi-sent', {});
        await renderStatus(token);
      })
    );
    if (paymentProfile.hostedPaymentUrl) {
      bind('#upi-qr-link', 'click', e => {
        e.preventDefault();
        window.open(e.currentTarget.href, '_blank', 'noopener,noreferrer');
      });
    }
  }
  bind('#refresh-status', 'click', () => action(() => renderStatus(token)));
  bind('#pay-online', 'click', () =>
    action(async () => {
      await openOnlineCheckout({
        token,
        api,
        onVerified: () => renderStatus(token),
        onError: e => toast(e.message),
      });
    })
  );
}

function renderUpiSection(order, profile) {
  const amount = (order.amount / 100).toFixed(2);
  const _upiLink =
    'upi://pay?' +
    new URLSearchParams({
      pa: profile.upi || '',
      pn: profile.payee || config.payee,
      am: amount,
      cu: 'INR',
      tn: 'Print ' + order.token.slice(0, 8),
    });
  const hasQr = !!profile.qr && !profile.upi;
  const hasHosted = !!profile.hostedPaymentUrl;
  return `
    <div class="upi-section">
      <div class="upi-qr-wrap">
        ${hasQr ? `<img id="upi-qr" class="qr" alt="UPI QR" src="/api/payment-qr/${encodeURIComponent(profile.qr)}">` : ''}
        ${!hasQr && !hasHosted ? `<img id="upi-qr" class="qr" alt="UPI QR">` : ''}
        ${hasHosted ? `<a id="upi-qr-link" class="button primary" href="#" style="display:none;margin-top:8px;">Open Razorpay Payment Page ↗</a>` : ''}
      </div>
      <div class="upi-details">
        <div class="row"><strong>Amount:</strong><span>${money(order.amount)}</span></div>
        <div class="row"><strong>Payee:</strong><span>${esc(profile.payee || config.payee)}</span></div>
        ${profile.upi ? `<div class="row"><strong>UPI:</strong><span>${esc(profile.upi)}</span></div>` : ''}
        <button id="upi-sent" class="button secondary">I paid — report payment</button>
        <p class="muted">Shop verifies payment. Click "I paid" only after you have completed the transfer.</p>
      </div>
    </div>`;
}

function customerHeader() {
  return `<header class="customer-head spread">${logo}<div class="shop-tag">${esc(config.shopName)}<br><small>Customer print desk</small></div></header>`;
}
function renderCustomer() {
  initCustomer(config, (opts, files) => {
    /* state change callback */
  });
}

async function adminApp() {
  if (!config.admin) {
    renderLogin();
    return;
  }
  state = await api('/api/admin/state');
  view = location.hash.slice(1) || 'dashboard';
  if (!nav.some(n => n[0] === view) && view !== 'poster') view = 'dashboard';
  $('#app').innerHTML =
    `<aside class="sidebar">${logo}<nav>${nav.map(([v, i, n]) => `<a href="/admin#${v}" class="${v === view ? 'active' : ''}"><span class="navicon">${{ D: '▦', J: '▧', DL: '↧', P: '▣', R: '▤', S: '⚙' }[i] || i}</span>${n}</a>`).join('')}</nav><div class="sidefoot"><strong>${esc(state.settings.shopName || 'SHRI CSC CENTER')}</strong><br><small>Your shop · Your print system</small><br><button id="logout" class="plain">Sign out</button></div></aside><main class="workspace"><header class="topbar spread"><div><div class="eyebrow">SHOP PANEL</div><h1>${view === 'poster' ? 'Counter poster' : nav.find(n => n[0] === view)?.[2]}</h1></div><a class="button" href="/" target="_blank" rel="noopener">Open Print Page ↗</a></header><div id="admin-content" class="stack"></div></main>`;
  bind('#logout', 'click', () =>
    action(async () => {
      await api('/api/logout', {});
      location.reload();
    })
  );
  ({
    dashboard: renderDashboard,
    jobs: renderAllJobs,
    printers: renderPrinters,
    settings: () => {
      renderSettings();
      renderPaymentProfiles();
    },
    reports: renderReports,
    downloads: renderDownloads,
    poster: renderPoster,
  })[view]();
  startLivePolling();
}

function renderLogin() {
  $('#app').innerHTML =
    `<section class="card login">${logo}<h1>Shop sign in</h1><p class="muted">Manage your printers, payments and print queue.</p><form id="login-form"><div class="field"><label for="admin-key">Admin key</label><input id="admin-key" type="password" autocomplete="current-password" required placeholder="Enter your private admin key"></div><button>Open shop panel</button><p class="form-error" id="login-error"></p></form><p class="help">On the shop PC, use the SHRI Print desktop shortcut for automatic local sign in.</p><a href="/">← Customer print page</a></section>`;
  bind('#login-form', 'submit', async e => {
    e.preventDefault();
    try {
      await api('/api/login', { token: $('#admin-key').value });
      location.reload();
    } catch (e) {
      $('#login-error').textContent = e.message;
    }
  });
}

function agentInfo() {
  const active = state.agents.filter(a => state.now - a.seen < 35000),
    live = active.some(a => a.mode === 'live');
  return { active, live, online: active.length > 0 };
}

function agentBar() {
  const a = agentInfo();
  const agentAge = a.active.length ? Math.min(...a.active.map(ag => state.now - ag.seen)) : null;
  const isStale = agentAge !== null && agentAge > 120000;
  return `<section class="card agentbar ${a.online ? 'online' : ''} spread"><div><div class="eyebrow">LIVE PRINT CHECK</div><h2>${a.online ? (a.live ? 'Print agent online' : 'Agent connected · test mode') : 'Print agent offline'}</h2><p class="muted">${a.live ? 'Ready to receive approved jobs.' : a.online ? `${isStale ? '⚠ Agent stale (>2min) — check agent. ' : ''}Switch the agent to Live to send jobs to Windows.` : 'Start the Windows agent on your shop computer.'}</p></div><div class="status-right">${badge(a.live ? 'Live' : a.online ? 'Dry run' : 'Offline', a.live ? 'good' : 'warn')}${isStale ? '<br><span class="badge warn">Stale</span>' : ''}<br><small>${state.printers.length} configured printer(s)</small></div></section>`;
}

function jobTable(orders, actions = true) {
  if (!orders.length)
    return '<div class="empty"><strong>No print requests yet</strong>Share your counter QR. New requests will appear here.</div>';
  return `<div class="joblist"><table class="jobtable"><thead><tr><th>Job</th><th>Customer / file</th><th>Print</th><th>Amount / payment</th><th>Status</th>${actions ? '<th>Actions</th>' : ''}</tr></thead><tbody>${orders
    .map(o => {
      const options = JSON.parse(o.options),
        names = JSON.parse(o.names);
      const isManualDuplex = o.status === 'manual_duplex';
      return `<tr data-order-id="${esc(o.id)}"><td><b>#${o.id.slice(0, 8).toUpperCase()}</b><small>${date(o.created)}</small></td><td><div class="file">${esc(names.join(', '))}</div><small>${esc(options.mobile || 'No mobile')}</small></td><td>${o.pages} × ${options.copies} · ${options.color === 'bw' ? 'B&W' : 'Color'}${options.duplex ? ' · Duplex' : ''}<small>${esc(options.paper)} · ${esc(options.orientation)}</small></td><td><b>${money(o.amount)}</b><small>${esc(getPaymentLabel({ ...o, options }))} · ${esc(o.payment)}</small></td><td>${statusBadge(o.status)}${o.error ? `<small class="error">${esc(o.error)}</small>` : ''}${o.status === 'claimed' && state.now - o.updated > 120000 ? '<small class="form-error">Agent interrupted? Check Windows queue. Never retry a possibly printed job blindly.</small>' : ''}${isManualDuplex ? '<small class="warn">Download PDF, print odd pages first, flip the stack as your printer requires, then print even pages. Check both sides before confirming.</small>' : ''}</td>${actions ? `<td><div class="job-actions"><button class="secondary" data-preview="${o.id}">Preview & adjust</button>${['cash', 'upi'].includes(o.method) && o.payment !== 'paid' && ['queued', 'awaiting_approval', 'awaiting_payment', 'submitted', 'printed', 'manual_duplex'].includes(o.status) ? `<button data-order="${o.id}" data-action="${o.method === 'cash' && o.status === 'awaiting_approval' ? 'cash_received' : 'approve'}" class="yellow">Cash received — Print ${money(o.amount)}</button>` : ''}${o.status === 'submitted' ? `<button data-order="${o.id}" data-action="printed">Paper confirmed</button>` : ''}${isManualDuplex ? `<a class="button secondary" href="/api/orders/${o.token}/file" target="_blank" rel="noopener">Open duplex PDF</a><button data-order="${o.id}" data-action="manual-duplex-done" class="primary">Both sides printed & checked</button>` : ''}${o.status === 'claimed' && state.now - o.updated > 120000 ? `<button data-order="${o.id}" data-action="recover" class="danger">Resolve interrupted</button>` : ''}${o.status === 'failed' && o.file ? `<button data-order="${o.id}" data-action="retry" class="secondary">Retry</button>` : ''}${!['claimed', 'submitted', 'printed', 'cancelled', 'expired', 'manual_duplex'].includes(o.status) ? `<button data-order="${o.id}" data-action="cancel" class="plain">Cancel</button>` : ''}</div></td>` : ''}</tr>`;
    })
    .join('')}</tbody></table></div>`;
}

function bindJobs() {
  document.querySelectorAll('[data-preview]').forEach(b => {
    if (b.dataset.bound) return;
    b.dataset.bound = 'true';
    b.onclick = () =>
      openAdminJob(
        state.orders.find(o => o.id === b.dataset.preview),
        { api, refresh: adminApp, money }
      );
  });
  const container = $('#admin-content');
  container.querySelectorAll('[data-order]').forEach(b => {
    if (b.dataset.bound) return;
    b.dataset.bound = 'true';
    b.addEventListener('click', () => {
      const a = b.dataset.action;
      if (a === 'cash_received') {
        b.disabled = true;
        b.textContent = 'Sending to print…';
        action(async () => {
          await api('/api/admin/orders/' + b.dataset.order, { action: 'cash_received' });
          await adminApp();
          toast('Cash recorded. Print request sent.');
        }).finally(() => {
          b.disabled = false;
          b.textContent = 'Cash received — Print';
        });
        return;
      }
      const messages = {
        recover: [
          'Resolve interrupted print',
          'Stop the agent first. Check physical paper and the Windows queue. This marks the attempt as failed; it does not print again.',
          'Mark attempt failed',
          'I stopped the agent and checked the printer.',
        ],
        approve: [
          'Confirm payment received',
          'Check cash received or verify the exact transfer in your bank/merchant app. A customer screenshot or report is not proof of receipt.',
          'Payment received',
          'I verified the full payment.',
        ],
        printed: [
          'Confirm paper output',
          'Mark ready only after checking that all pages and copies came out correctly.',
          'Mark paper confirmed',
          'I checked the physical paper output.',
        ],
        'manual-duplex-done': [
          'Confirm both sides printed',
          'Staff has printed front and back and verified all pages. This completes the double-sided job.',
          'Mark double-sided done',
          'I printed both sides and checked the output.',
        ],
        retry: [
          'Retry print request',
          'Check the physical printer and Windows queue first. Retrying can duplicate pages if the previous command partially printed.',
          'Retry print',
          'I checked the queue and want to retry.',
        ],
        cancel: [
          'Cancel request',
          'This stops an unclaimed request. A payment refund, if needed, must be handled separately.',
          'Cancel request',
          'I want to cancel this print request.',
        ],
      };
      const [title, text, button, check] = messages[a];
      modal(
        title,
        text,
        button,
        async () => {
          await api('/api/admin/orders/' + b.dataset.order, { action: a, confirmed: true });
          await adminApp();
          toast('Request updated.');
        },
        check
      );
    });
  });
}

function renderVisitsInbox() {
  const visits = (state.visits || []).filter(v => v.stage !== 'submitted');
  if (!visits.length)
    return '<div class="empty"><strong>No customers preparing</strong>Visits appear when customers select service/files on phone.</div>';
  const draftTokens = new Set(
    (state.orders || []).filter(o => o.status === 'draft').map(o => o.token)
  );
  return `<section class="card"><div class="spread section-head"><h2>Customers preparing</h2></div><div class="list-stack">${visits
    .filter(v => !draftTokens.has(v.orderToken))
    .map(v => {
      const opts = v.options || {};
      const files = (v.files || []).map(f => `${esc(f.name)} (${f.pages}p)`).join(', ');
      return `<div class="visit-item" style="padding:12px;border-bottom:1px solid var(--line-soft);display:flex;gap:12px;align-items:flex-start;"><div style="flex:1"><div style="font-weight:700;color:var(--ink)">${esc(v.service === 'passport' ? 'Passport Photos' : v.service === 'id' ? 'ID Card' : v.service === 'resume' ? 'Resume' : 'Document')}</div><div style="font-size:11px;color:var(--muted)">${files}</div><div style="font-size:11px;color:var(--faint)">Color: ${opts.color === 'bw' ? 'B&W' : 'Color'} · Copies: ${opts.copies || 1} · Paper: ${opts.paper || 'A4'}${opts.duplex ? ' · Duplex' : ''}</div><div style="font-size:10px;color:var(--faint);margin-top:4px">Stage: ${esc(v.stage)} · ${new Date(v.updated || Date.now()).toLocaleTimeString()}</div></div></div>`;
    })
    .join('')}</div></section>`;
}

function renderDashboard() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()),
    orders = state.orders.filter(
      o =>
        new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(o.created) ===
          today && o.status !== 'draft'
    );
  const collected = orders.filter(o => o.payment === 'paid').reduce((s, o) => s + o.amount, 0);
  const syncBadge = lastLiveSync
    ? `<span id="live-sync-status" class="badge info">Last synced ${new Date(lastLiveSync).toLocaleTimeString()}</span>`
    : `<span id="live-sync-status" class="badge warn">Connecting…</span>`;
  $('#admin-content').innerHTML =
    `<section id="counter-inbox" class="card">${counterInbox()}</section><section id="uploads-inbox" class="card">${uploadsInbox()}</section>` +
    agentBar() +
    `<div class="stats">${[
      ["TODAY'S JOBS", orders.length, 'Customer print requests'],
      [
        'WAITING',
        orders.filter(o =>
          ['queued', 'held', 'awaiting_approval', 'awaiting_payment', 'manual_duplex'].includes(
            o.status
          )
        ).length,
        'Awaiting payment or agent',
      ],
      ['PRINTED', orders.filter(o => o.status === 'printed').length, 'Physical output confirmed'],
      ['COLLECTED', money(collected), 'Verified customer payments'],
    ]
      .map(
        ([n, v, s]) =>
          `<section class="card stat"><div class="eyebrow">${n}</div><strong>${v}</strong><small>${s}</small></section>`
      )
      .join(
        ''
      )}</div><div class="grid2 dashboard-columns"><section class="card qr-card"><div><div class="eyebrow">CUSTOMER QR</div><h2>Scan. Upload. Print.</h2><p class="muted">Let customers send documents directly from their phone.</p><div class="row" style="margin-top:18px"><a class="button secondary" href="/admin#poster">Counter poster</a><button id="copy-link" class="plain">Copy link</button></div></div><img id="customer-qr" class="qr" alt="Customer print QR code"></section><section class="card"><h2>Your print desk</h2><p class="muted">Set up once. Manage everything here.</p><div class="stack" style="gap:0;margin-top:12px">${[
      ['printers', 'Map your printers', 'Choose where B&W and color jobs go'],
      ['settings', 'Pricing & payments', 'Set page rates and counter approval'],
      ['downloads', 'Windows print agent', 'Connect your shop computer'],
    ]
      .map(
        ([v, n, t]) =>
          `<a class="spread download-step" href="/admin#${v}"><div><strong>${n}</strong><br><small>${t}</small></div><b>→</b></a>`
      )
      .join(
        ''
      )}</div></section></div><div id="visits-inbox">${renderVisitsInbox()}</div><section class="card"><div class="spread section-head"><div><h2>Recent print jobs</h2><p class="help">Payment verified → queued → agent → printed. ${syncBadge}</p></div></div><div id="job-table-wrap">${jobTable(orders.slice(0, 50))}</div></section>`;
  qr('#customer-qr', location.origin + '/', 260);
  bind('#copy-link', 'click', () => {
    navigator.clipboard.writeText(location.origin + '/');
    toast('Link copied');
  });
  bindJobs();
}

async function startLivePolling() {
  stopLivePolling();
  const myGen = ++liveGeneration;
  let cursor = state.now || 0;
  const poll = async () => {
    if (myGen !== liveGeneration) return;
    if (isCheckoutBusy() || liveInFlight) {
      liveTimer = setTimeout(poll, document.visibilityState === 'visible' ? 1000 : 3000);
      return;
    }
    liveInFlight = true;
    liveAbortController = new AbortController();
    try {
      const after = Math.max(0, cursor - 1);
      const res = await fetch(`/api/admin/live?after=${after}`, {
        signal: liveAbortController.signal,
      });
      if (!res.ok) throw new Error('Live poll failed');
      const data = await res.json();
      if (myGen !== liveGeneration) return;
      if (data.orders) {
        announceCashOrders(data.orders);
        mergeOrdersDelta(data.orders);
      }
      if (data.agents) state.agents = data.agents;
      if (data.visits) state.visits = data.visits;
      if (data.now) {
        state.now = data.now;
        cursor = data.now;
      }
      lastLiveSync = Date.now();
      liveBackoff = 1000;
      updateDashboardIslands();
    } catch (e) {
      if (e.name !== 'AbortError' && myGen === liveGeneration) {
        liveBackoff = Math.min(liveBackoff * 1.5, 10000);
        console.warn('Live poll error:', e.message);
      }
    } finally {
      if (myGen === liveGeneration) {
        liveInFlight = false;
        liveTimer = setTimeout(poll, document.visibilityState === 'visible' ? 1000 : 3000);
      }
    }
  };
  liveTimer = setTimeout(poll, 0);
}

function stopLivePolling() {
  liveGeneration++;
  if (liveTimer) {
    clearTimeout(liveTimer);
    liveTimer = null;
  }
  if (liveAbortController) {
    liveAbortController.abort();
    liveAbortController = null;
  }
  liveInFlight = false;
}

function mergeOrdersDelta(delta) {
  const byId = new Map(state.orders.map(o => [o.id, o]));
  for (const o of delta) byId.set(o.id, o);
  state.orders = Array.from(byId.values())
    .sort((a, b) => b.created - a.created)
    .slice(0, 1000);
}

function updateDashboardIslands() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const todays = state.orders.filter(
    o =>
      o.status !== 'draft' &&
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(o.created)) ===
        today
  );
  const values = [
    todays.length,
    todays.filter(o =>
      ['queued', 'held', 'awaiting_approval', 'awaiting_payment', 'manual_duplex'].includes(
        o.status
      )
    ).length,
    todays.filter(o => o.status === 'printed').length,
    money(todays.filter(o => o.payment === 'paid').reduce((n, o) => n + o.amount, 0)),
  ];
  document.querySelectorAll('.stats .stat>strong').forEach((el, i) => {
    if (values[i] !== undefined) el.textContent = values[i];
  });
  if ($('#uploads-inbox')) $('#uploads-inbox').innerHTML = uploadsInbox();
  if (view === 'jobs') renderAllJobRows();
  if ($('#counter-inbox')) $('#counter-inbox').innerHTML = counterInbox();
  const agentBarEl = document.querySelector('.agentbar');
  if (agentBarEl) agentBarEl.outerHTML = agentBar();
  const visitsEl = $('#visits-inbox');
  if (visitsEl) visitsEl.innerHTML = renderVisitsInbox();
  if ($('#dialog').open) return;
  const jobWrap = $('#job-table-wrap');
  if (jobWrap) {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const orders = state.orders.filter(
      o =>
        new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(o.created) ===
          today && o.status !== 'draft'
    );
    jobWrap.innerHTML = jobTable(orders.slice(0, 50));
    bindJobs();
  }
  const syncBadge = document.querySelector('#live-sync-status');
  if (syncBadge)
    syncBadge.outerHTML = lastLiveSync
      ? `<span id="live-sync-status" class="badge info">Last synced ${new Date(lastLiveSync).toLocaleTimeString()}</span>`
      : `<span class="badge warn">Reconnecting…</span>`;
}

function renderPrinters() {
  const inventories = state.agents.flatMap(a => {
    try {
      return JSON.parse(a.inventory);
    } catch {
      return [];
    }
  });
  const unique = [...new Map(inventories.map(p => [p.Name, p])).values()];
  $('#admin-content').innerHTML =
    agentBar() +
    `<div class="grid2"><section class="card"><h2>Add printer</h2><p class="muted">Use the exact Windows printer name.</p><form id="printer-form"><div class="grid2"><div class="field"><label for="brand">Brand</label><select id="brand">${['Epson', 'Canon', 'HP', 'Brother', 'Samsung', 'Xerox', 'Ricoh', 'Kyocera', 'Other'].map(v => `<option>${v}</option>`).join('')}</select></div><div class="field"><label for="model">Model</label><input id="model" placeholder="e.g. L8050"></div></div><div class="field"><label for="printer-name">Windows printer name</label><input id="printer-name" list="windows-printers" required placeholder="Exact name from Windows"><datalist id="windows-printers">${unique.map(p => `<option value="${esc(p.Name)}">`).join('')}</datalist></div><div class="grid2"><div class="field"><label for="capability">Capability</label><select id="capability"><option value="color">Color + B&W</option><option value="bw">B&W only</option></select></div><div class="field"><label for="connection">Connection</label><select id="connection"><option>USB</option><option>Wi-Fi</option><option>Network</option></select></div></div><button style="margin-top:16px">Add printer</button></form>${unique.length ? `<div class="field"><label>Detected by Windows agent</label><div class="agent-inventory">${unique.map(p => `<div class="download-step"><strong>${esc(p.Name)}</strong><br><small>${esc(p.PrinterStatus)} · ${esc(p.DriverName)}</small></div>`).join('')}</div></div>` : ''}</section><section class="card"><h2>Configured printers</h2><p class="muted">Mapping sends each customer job to the right printer.</p>${state.printers.length ? state.printers.map(p => `<div class="printer-item"><div class="row"><span class="printer-icon">▤</span><div><strong>${esc(p.model || p.name)}</strong><br><small>${esc(p.name)} · ${p.capability === 'color' ? 'Color+B&W' : 'B&W only'}</small></div></div><div class="inline-actions">${p.capability === 'color' ? `<button data-printer="${p.id}" data-action="map-color" class="${state.settings.colorPrinter === p.id ? 'primary' : 'secondary'}">Map Color</button>` : ''}${p.capability === 'bw' || p.capability === 'color' ? `<button data-printer="${p.id}" data-action="map-bw" class="${state.settings.bwPrinter === p.id ? 'primary' : 'secondary'}">Map B&W</button>` : ''}<button data-printer="${p.id}" data-action="remove" class="danger plain">Remove</button></div></div>`).join('') : '<p class="muted">No printers mapped yet.</p>'}</section></div>`;
  bind('#printer-form', 'submit', e => {
    e.preventDefault();
    action(async () => {
      const data = {
        brand: $('#brand').value,
        model: $('#model').value,
        name: $('#printer-name').value,
        capability: $('#capability').value,
        connection: $('#connection').value,
      };
      await api('/api/admin/printers', data);
      await adminApp();
      toast('Printer added.');
    });
  });
  document.querySelectorAll('[data-printer]').forEach(b =>
    b.addEventListener('click', () =>
      action(async () => {
        await api('/api/admin/printers/' + b.dataset.printer, { action: b.dataset.action });
        await adminApp();
        toast('Printer mapping updated.');
      })
    )
  );
}

function renderSettings() {
  const s = state.settings;
  $('#admin-content').innerHTML =
    `<form id="settings-form" class="stack"><div class="grid2"><section class="card"><h2>Customer print price</h2><p class="muted">Progressive pricing per page copy, in rupees.</p><div class="price-table field"><span>Print mode</span><span class="eyebrow">PAGE 1</span><span class="eyebrow">PAGES 2–10</span><span class="eyebrow">PAGES 11+</span>${['bw', 'color'].map(mode => `<strong>${mode === 'bw' ? 'Black & white' : 'Color'}</strong>${s.rates[mode].map((n, i) => `<input type="number" min="0" max="1000" step="0.01" id="rate-${mode}-${i}" aria-label="${mode} tier ${i + 1}" value="${(n / 100).toFixed(2)}" required>`).join('')}`).join('')}</div><p class="help">Page 1 uses the first rate; pages 2–10 use the middle rate; page 11 onward uses the bulk rate. Applied across all selected pages × copies.</p><p class="help">Paper multiplier: A4 ×1 · A3 ×2 · A2 ×4 · A1 ×8. Duplex does not reduce the charged page count. Confirm paper support in your printer driver.</p><div class="field"><label for="duplex-price">Duplex sheet price (₹ per both-side B&W A4 sheet)</label><input type="number" id="duplex-price" min="0" max="5000" step="0.01" value="${(s.duplexSheetPrice || 500) / 100}" required><p class="help">Odd last sheet uses normal one-page price. Copies are independent.</p></div><h2 style="margin-top:25px">Customer payment options</h2><label class="checkline"><input type="checkbox" id="cash" ${s.cash ? 'checked' : ''}><span>Cash at counter<br><small>Customer pays directly at your desk.</small></span></label><div class="field"><label for="cash-mode">Cash order printing</label><select id="cash-mode"><option value="approve" ${!s.cashAuto ? 'selected' : ''}>Approve payment before print</option><option value="auto" ${s.cashAuto ? 'selected' : ''}>Auto print cash requests immediately</option></select></div><h3 style="margin-top:22px">Quick UPI setup (optional)</h3><div class="field"><label for="upi-id">UPI ID</label><input id="upi-id" value="${esc(s.upi)}" placeholder="yourshop@bank" autocomplete="off"></div><div class="field"><label for="payee">Payee name</label><input id="payee" value="${esc(s.payee)}" maxlength="80"></div><div class="field"><label for="hosted-payment-url">Razorpay hosted payment URL (optional)</label><input id="hosted-payment-url" type="url" value="${esc(s.hostedPaymentUrl || '')}" placeholder="https://razorpay.me/yourshop"><p class="help">HTTPS razorpay.me link. Enables "Razorpay Link" as a payment choice. Server validates host and freezes URL per order.</p></div><p class="help">Use QR profiles above to upload or switch different payment QRs. A saved active profile overrides this quick UPI.</p><h2 style="margin-top:25px">Shop identity</h2><div class="field"><label for="shop-name">Shop name</label><input id="shop-name" value="${esc(s.shopName)}" required></div><div class="field"><label for="subtitle">Subtitle</label><input id="subtitle" value="${esc(s.subtitle || '')}" placeholder="e.g. CSC Center · Print & Services"></div><div class="field"><label for="retention">File retention (hours)</label><input id="retention" type="number" min="1" max="168" value="${s.retentionHours || 24}"></div></section><section class="card"><h2>Passport photo packages</h2><p class="muted">35 × 45 mm · A4 color · per set. All prices can be changed.</p><div class="grid2">${[5, 10, 20, 30].map(q => '<div class="field"><label for="photo-price-' + q + '">' + q + ' photos (₹)</label><input id="photo-price-' + q + '" type="number" min="0" max="500" step="0.01" required value="' + (s.photoPackages?.[q] ?? { 5: 3000, 10: 6000, 20: 12000, 30: 18000 }[q]) / 100 + '"></div>').join('')}</div></section></div><div class="form-actions"><button type="submit" class="primary">Save settings</button></div></form>`;
  $('#settings-form').insertAdjacentHTML(
    'afterbegin',
    `<section class="card"><div class="eyebrow">AUTOMATIC PRINTING</div><h2>Payment & printer readiness</h2><p class="muted">Connected online payments print automatically after verified confirmation. Your uploaded bank/UPI QR uses shop approval.</p><div class="readiness-grid">${[
      ['Merchant connection', state.paymentReadiness?.gatewayConfigured],
      ['Payment webhook', state.paymentReadiness?.webhookConfigured],
      ['PC live agent', state.paymentReadiness?.liveAgentOnline],
      ['B&W mapping', state.paymentReadiness?.mappedBwReady],
      ['Color mapping', state.paymentReadiness?.mappedColorReady],
    ]
      .map(
        ([n, ok]) =>
          '<div class="readiness-item"><span>' +
          n +
          '</span>' +
          badge(ok ? 'Ready' : 'Setup needed', ok ? 'good' : 'warn') +
          '</div>'
      )
      .join(
        ''
      )}</div><p class="help">A UPI ID or QR image alone cannot confirm receipt. Set up the merchant provider connection for automatic confirmation.</p></section>`
  );
  bind('#settings-form', 'submit', e => {
    e.preventDefault();
    action(async () => {
      const updated = {
        ...s,
        shopName: $('#shop-name').value.trim(),
        subtitle: $('#subtitle').value,
        cash: $('#cash').checked,
        cashAuto: $('#cash-mode').value === 'auto',
        upi: $('#upi-id').value.trim(),
        payee: $('#payee').value.trim(),
        hostedPaymentUrl: $('#hosted-payment-url').value.trim(),
        online: s.online,
        retentionHours: Number($('#retention').value),
        duplexSheetPrice: Math.round(Number($('#duplex-price').value) * 100),
        rates: {},
      };
      updated.photoPackages = Object.fromEntries(
        [5, 10, 20, 30].map(q => [q, Math.round(Number($('#photo-price-' + q).value) * 100)])
      );
      for (const mode of ['bw', 'color'])
        updated.rates[mode] = [0, 1, 2].map(i =>
          Math.round(Number($('#rate-' + mode + '-' + i).value) * 100)
        );
      await api('/api/admin/settings', updated);
      await adminApp();
      toast('Settings saved.');
    });
  });
  bind('#cleanup', 'click', () =>
    action(async () => {
      const r = await api('/api/admin/cleanup', {});
      toast(r.removed + ' expired document(s) removed.');
    })
  );
}

function renderReports() {
  const orders = state.orders.filter(o => o.status !== 'draft');
  $('#admin-content').innerHTML =
    `<section class="card"><div class="filters"><div><label for="search">Search jobs</label><input id="search" placeholder="Job, filename or mobile"></div><div><label for="filter-status">Print status</label><select id="filter-status"><option value="">All statuses</option>${Object.entries(
      labels
    )
      .filter(([k]) => k !== 'draft')
      .map(([k, v]) => `<option value="${k}">${v}</option>`)
      .join(
        ''
      )}</select></div><div><label for="filter-payment">Payment</label><select id="filter-payment"><option value="">All payments</option><option value="paid">Verified / paid</option><option value="pending">Pending</option><option value="reported">Customer reported</option></select></div><div><label for="filter-from">From</label><input id="filter-from" type="date"></div><div><label for="filter-to">To</label><input id="filter-to" type="date"></div></div><div class="row" style="margin-top:16px"><button id="apply-filter">Check report</button><button id="export" class="secondary">Export CSV</button><button id="clear-filter" class="plain">Clear</button></div></section><section class="card"><h2>Print & payment data</h2><div id="report-totals"></div><div id="report-rows"></div></section>`;
  let filtered = orders;
  const apply = () => {
    const search = $('#search').value.toLowerCase(),
      status = $('#filter-status').value,
      payment = $('#filter-payment').value,
      from = $('#filter-from').value,
      to = $('#filter-to').value;
    filtered = orders.filter(o => {
      const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(o.created);
      return (
        (!search || (o.id + o.names + o.options).toLowerCase().includes(search)) &&
        (!status || o.status === status) &&
        (!payment || o.payment === payment) &&
        (!from || d >= from) &&
        (!to || d <= to)
      );
    });
    $('#report-rows').innerHTML = jobTable(filtered, false);
    $('#report-totals').innerHTML =
      `<div class="metric-strip"><div><strong>${filtered.length}</strong><small>Jobs found</small></div><div><strong>${money(filtered.filter(o => o.payment === 'paid').reduce((s, o) => s + o.amount, 0))}</strong><small>Verified payments</small></div><div><strong>${money(filtered.reduce((s, o) => s + o.amount, 0))}</strong><small>Total order value</small></div></div>`;
  };
  bind('#apply-filter', 'click', apply);
  bind('#clear-filter', 'click', () => {
    $('#search').value = '';
    $('#filter-status').value = '';
    $('#filter-payment').value = '';
    $('#filter-from').value = '';
    $('#filter-to').value = '';
    apply();
  });
  bind('#export', 'click', () =>
    action(async () => {
      const csv = [
        'Job ID,Created,Service,Files,Pages×Copies,Paper,Color,Amount,Method,Payment,Status',
        ...filtered.map(o => {
          const opts = JSON.parse(o.options),
            names = JSON.parse(o.names);
          return `"${o.id}",${date(o.created)},${opts.service},"${names.join(';')}",${o.pages}×${opts.copies},${opts.paper},${opts.color},${o.amount},${o.method},${o.payment},${o.status}`;
        }),
      ].join('\n');
      download('report-' + new Date().toISOString().slice(0, 10) + '.csv', csv, 'text/csv');
    })
  );
  apply();
}

function renderDownloads() {
  const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  $('#admin-content').innerHTML =
    `<div class="grid2"><section class="card qr-card"><div><div class="eyebrow">COUNTER QR</div><h2>One scan. Less waiting.</h2><p class="muted">Customers upload directly from their phone.</p><a class="button secondary" href="/admin#poster" style="margin-top:18px">Preview & print poster</a></div><img id="download-qr" class="qr" alt="Customer QR"></section><section class="card"><div class="eyebrow">WINDOWS SOFTWARE</div><h2 style="margin-top:7px">SHRI Print Agent</h2><p class="muted">Connect your PC's installed printers to this website.</p><div class="download-step"><b>1</b>Start SHRI Print from the desktop shortcut.</div><div class="download-step"><b>2</b>Use the printer names detected by the agent.</div><div class="download-step"><b>3</b>Save B&W and color mapping.</div><div class="download-step"><b>4</b>Switch the agent to Live after checking setup.</div><div class="row" style="margin-top:18px"><button id="agent-config" class="secondary">Download agent config</button><button id="agent-bundle" class="plain">Agent setup notes</button></div><p class="help">Configuration contains a private agent key. Keep it on your shop computer.</p></section></div><section class="card"><h2>Connection checklist</h2><p class="muted">${agentInfo().online ? 'A Windows agent is connected.' : 'No active Windows agent yet.'} Website address: ${esc(location.origin)}</p><p class="help">The local installation includes the agent, a startup task, PDF print engine and launch shortcuts. Config can point to your public deployment. Cloud uploads and the local backup queue are separate databases.</p><div class="row field"><button id="test-print" class="yellow">Print one test page</button>${isLocalhost ? `<button id="local-test" class="secondary">Set local agent to test mode</button><button id="local-live" class="primary">Enable live printing on this PC</button>` : `<a class="button secondary" href="http://localhost:4888/local-login?local=1#downloads">Open PC controls</a>`}</div><p class="help">Desktop app users: use the native "Connection status" menu for safe reconnect.</p></section>`;
  qr('#download-qr', location.origin + '/', 260);
  bind('#agent-config', 'click', () =>
    action(async () => {
      const r = await api('/api/admin/agent-config');
      download('agent-config.json', JSON.stringify(r, null, 2));
    })
  );
  bind('#agent-bundle', 'click', () =>
    action(async () => {
      const r = await api('/api/admin/agent-bundle');
      download('agent-bundle.txt', r);
    })
  );
  bind('#test-print', 'click', () =>
    action(async () => {
      await api('/api/admin/test-print');
      toast('Test page sent to mapped printers.');
    })
  );
  if (isLocalhost) {
    bind('#local-test', 'click', () =>
      action(async () => {
        if (window.shriPrintDesktop) {
          await window.shriPrintDesktop.setMode('dry-run');
          toast('Agent set to test mode.');
        } else {
          await api('/api/local/agent-mode', { mode: 'dry-run' });
          toast('Agent set to test mode.');
        }
        await adminApp();
      })
    );
    bind('#local-live', 'click', () =>
      action(async () => {
        if (window.shriPrintDesktop) {
          await window.shriPrintDesktop.setMode('live');
          toast('Agent set to live mode.');
        } else {
          await api('/api/local/agent-mode', { mode: 'live' });
          toast('Agent set to live mode.');
        }
        await adminApp();
      })
    );
  }
}

function renderPoster() {
  $('#admin-content').innerHTML =
    `<div class="noprint row"><button id="print-poster">Print / save poster</button><a class="button secondary" href="/admin#downloads">Back</a></div><section class="poster"><div class="logo" style="justify-content:center">${logo}</div><div class="eyebrow" style="margin-top:24px">${esc(state.settings.shopName || 'SHRI CSC CENTER')}</div><h1 style="margin-top:10px">SCAN.<br>UPLOAD.<br>PRINT.</h1><img id="poster-qr" alt="Scan to print"><ol><li>Scan this QR with your phone</li><li>Upload & choose print settings</li><li>Pay and collect at the counter</li></ol><p style="margin-top:24px;font-size:13px;overflow-wrap:anywhere">${esc(location.origin)}</p><p class="help">PDF · JPG · PNG · Passport photos · ID cards</p></section>`;
  qr('#poster-qr', location.origin + '/', 600);
  bind('#print-poster', 'click', () => window.print());
}

function renderPaymentProfiles() {
  const s = state.settings,
    profiles = s.paymentProfiles || [];
  $('#admin-content').insertAdjacentHTML(
    'afterbegin',
    `<section class="card"><div class="spread"><div><div class="eyebrow">YOUR PAYMENT QRs</div><h2>Upload, save & switch QR</h2><p class="muted">Save up to 8 bank or merchant QRs. Choose the one new orders should use.</p></div>${badge(profiles.length + ' saved', 'info')}</div><div class="grid2 field"><div><label for="qr-label">QR profile name</label><input id="qr-label" maxlength="60" placeholder="e.g. PhonePe counter / Bank 2"></div><div><label for="qr-payee">Payee name</label><input id="qr-payee" maxlength="80" value="${esc(s.payee || s.shopName)}"></div><div><label for="qr-upload">Upload payment QR image</label><input id="qr-upload" type="file" accept="image/png,image/jpeg"><p class="help">JPG/PNG · up to 500 KB · max 2000 × 2000 pixels. Upload a clear, cropped merchant QR.</p></div><div><label for="qr-upi">Or enter UPI ID for amount-based QR</label><input id="qr-upi" placeholder="yourshop@bank"><p class="help">Uploaded images are displayed as supplied. UPI IDs generate a QR with the exact order amount.</p></div></div><button type="button" id="save-qr" style="margin-top:15px">Add QR & make active</button><div class="form-error" id="qr-error"></div><div class="grid3 field">${profiles.map(p => `<div class="printer-item"><div class="spread"><strong>${esc(p.label)}</strong>${p.id === s.activePaymentProfile ? badge('Active', 'good') : badge('Saved')}</div><img id="profile-${p.id}" class="mini-qr" alt="${esc(p.label)} payment QR" style="margin:10px 0"><p class="help">${esc(p.payee)}${p.upi ? '<br>' + esc(p.upi) : ''}</p><div class="row field"><button type="button" class="secondary use-qr" data-id="${p.id}" ${p.id === s.activePaymentProfile ? 'disabled' : ''}>Use this QR</button><button type="button" class="plain remove-qr" data-id="${p.id}">Remove</button></div></div>`).join('')}</div>${profiles.length ? '' : '<p class="help">No QR uploaded yet. Add your preferred QR to get started.</p>'}</section>`
  );
  for (const p of profiles) {
    if (p.qr) $('#profile-' + p.id).src = '/api/payment-qr/' + encodeURIComponent(p.qr);
    else
      qr(
        '#profile-' + p.id,
        'upi://pay?' + new URLSearchParams({ pa: p.upi, pn: p.payee, cu: 'INR' })
      );
  }
  bind('#save-qr', 'click', async () => {
    const button = $('#save-qr');
    button.disabled = true;
    $('#qr-error').textContent = '';
    try {
      if (profiles.length >= 8)
        throw new Error('Save up to 8 QR profiles. Remove an old one first.');
      const label = $('#qr-label').value.trim(),
        payee = $('#qr-payee').value.trim(),
        upi = $('#qr-upi').value.trim(),
        file = $('#qr-upload').files[0];
      if (!label) throw new Error('Enter a QR profile name.');
      if (!file && !upi) throw new Error('Upload a QR image or enter a UPI ID.');
      let image = '';
      if (file) {
        if (file.size > 512 * 1024) throw new Error('QR image must be under 500 KB.');
        const form = new FormData();
        form.append('file', file);
        image = (await api('/api/admin/payment-qr', form)).qr;
      }
      const profile = { id: crypto.randomUUID(), label, payee, upi: image ? '' : upi, qr: image };
      await api('/api/admin/settings', {
        ...s,
        paymentProfiles: [...profiles, profile],
        activePaymentProfile: profile.id,
      });
      await adminApp();
      toast('Payment QR saved and activated.');
    } catch (e) {
      $('#qr-error').textContent = e.message;
      button.disabled = false;
    }
  });
  document.querySelectorAll('.use-qr').forEach(b =>
    b.addEventListener('click', () =>
      action(async () => {
        await api('/api/admin/settings', { ...s, activePaymentProfile: b.dataset.id });
        await adminApp();
        toast('Active payment QR changed.');
      })
    )
  );
  document.querySelectorAll('.remove-qr').forEach(b =>
    b.addEventListener('click', () =>
      action(async () => {
        await api('/api/admin/settings', {
          ...s,
          paymentProfiles: profiles.filter(p => p.id !== b.dataset.id),
          activePaymentProfile:
            s.activePaymentProfile === b.dataset.id ? '' : s.activePaymentProfile,
        });
        await adminApp();
        toast('QR removed from selection. Existing requests keep their original QR.');
      })
    )
  );
}

const nav = [
  ['dashboard', 'D', 'Dashboard'],
  ['jobs', 'J', 'Jobs & files'],
  ['downloads', 'DL', 'Downloads & QR'],
  ['printers', 'P', 'Printers'],
  ['reports', 'R', 'Reports'],
  ['settings', 'S', 'Settings'],
];

async function boot() {
  try {
    config = await api('/api/config');
    const match = location.pathname.match(/^\/order\/([a-f0-9-]{60,90})$/);
    if (match) {
      currentOrderToken = match[1];
      await renderStatus(currentOrderToken);
      startReceiptPolling(currentOrderToken);
    } else if (location.pathname.startsWith('/admin')) await adminApp();
    else renderCustomer();
  } catch (e) {
    $('#app').innerHTML =
      `<section class="card login"><h1>Could not open print desk</h1><p class="form-error">${esc(e.message)}</p><a class="button secondary" href="/">Try again</a></section>`;
  }
}

window.addEventListener('hashchange', () => {
  if (location.pathname.startsWith('/admin')) action(adminApp);
});

function startReceiptPolling(token) {
  stopReceiptPolling();
  const myGen = ++receiptGeneration;
  currentOrderToken = token;
  const poll = async () => {
    if (myGen !== receiptGeneration) return;
    if (
      document.visibilityState !== 'visible' ||
      $('#dialog').open ||
      isCheckoutBusy() ||
      receiptInFlight
    ) {
      receiptTimer = setTimeout(poll, 1000);
      return;
    }
    receiptInFlight = true;
    receiptAbortController = new AbortController();
    try {
      const res = await fetch(`/api/orders/${token}`, { signal: receiptAbortController.signal });
      if (!res.ok) throw new Error('Receipt poll failed');
      const data = await res.json();
      if (myGen !== receiptGeneration) return;
      const key = `${data.status}|${data.payment}|${data.updated || 0}`;
      if (key !== lastReceiptKey) {
        lastReceiptKey = key;
        await renderStatus(token);
      }
    } catch (e) {
      if (e.name !== 'AbortError' && myGen === receiptGeneration)
        console.warn('Receipt poll error:', e.message);
    } finally {
      if (myGen === receiptGeneration) {
        receiptInFlight = false;
        receiptTimer = setTimeout(poll, 1000);
      }
    }
  };
  poll();
}

function stopReceiptPolling() {
  receiptGeneration++;
  if (receiptTimer) {
    clearTimeout(receiptTimer);
    receiptTimer = null;
  }
  if (receiptAbortController) {
    receiptAbortController.abort();
    receiptAbortController = null;
  }
  receiptInFlight = false;
  lastReceiptKey = null;
  currentOrderToken = null;
}

function uploadsInbox() {
  const jobs = state.orders.filter(o => o.file && ['draft', 'held', 'queued'].includes(o.status));
  return (
    '<div class="spread"><div><span class="eyebrow">LIVE WORKBENCH</span><h2>Files ready to check <span class="badge">' +
    jobs.length +
    '</span></h2></div><a class="button secondary" href="/admin#jobs">All jobs & files ↗</a></div>' +
    jobTable(jobs.slice(0, 12))
  );
}
let allJobsPage = 0,
  allJobsRenderKey = '';
function renderAllJobs() {
  allJobsRenderKey = '';
  const c = $('#admin-content');
  c.innerHTML =
    '<section class="card"><h2>Every upload, in one place</h2><p class="help">Drafts, waiting, paused, queued and completed jobs. Files remain available until their retention expires.</p><div class="job-search row"><input id="job-search" aria-label="Search jobs and files" placeholder="Search file, customer, mobile or job ID"><select id="job-state" aria-label="Filter job status"><option value="">All statuses</option>' +
    Object.entries(labels)
      .map(([key, label]) => '<option value="' + key + '">' + esc(label) + '</option>')
      .join('') +
    '</select></div><div id="all-job-table"></div></section>';
  bind('#job-search', 'input', () => {
    allJobsPage = 0;
    renderAllJobRows();
  });
  bind('#job-state', 'change', () => {
    allJobsPage = 0;
    renderAllJobRows();
  });
  renderAllJobRows();
}
function renderAllJobRows() {
  if (!$('#all-job-table')) return;
  const q = ($('#job-search')?.value || '').toLowerCase(),
    filter = $('#job-state')?.value;
  const jobs = state.orders.filter(
    o =>
      (!filter || o.status === filter) &&
      (!q || (o.id + ' ' + o.names + ' ' + o.options).toLowerCase().includes(q))
  );
  const pages = Math.max(1, Math.ceil(jobs.length / 50));
  allJobsPage = Math.min(allJobsPage, pages - 1);
  const key =
    q +
    '|' +
    filter +
    '|' +
    allJobsPage +
    '|' +
    jobs.map(o => o.id + o.updated + o.status + o.payment).join(',');
  if (key === allJobsRenderKey) return;
  allJobsRenderKey = key;
  $('#all-job-table').innerHTML =
    '<p class="help">' +
    jobs.length +
    ' matching job(s) · Page ' +
    (allJobsPage + 1) +
    ' of ' +
    pages +
    '</p>' +
    jobTable(jobs.slice(allJobsPage * 50, allJobsPage * 50 + 50)) +
    '<div class="row"><button id="jobs-prev" ' +
    (allJobsPage ? '' : 'disabled') +
    '>Previous</button><button id="jobs-next" ' +
    (allJobsPage < pages - 1 ? '' : 'disabled') +
    '>Next jobs</button></div>';
  bind('#jobs-prev', 'click', () => {
    allJobsPage--;
    renderAllJobRows();
  });
  bind('#jobs-next', 'click', () => {
    allJobsPage++;
    renderAllJobRows();
  });
  bindJobs();
}
let cashAlertIds = new Set();
let cashAlertSince = Date.now();
try {
  const v = JSON.parse(sessionStorage.getItem('cash-alerts') || 'null');
  if (v) {
    cashAlertSince = v.since;
    cashAlertIds = new Set(v.ids);
  }
} catch {}
function counterInbox() {
  const orders = state.orders.filter(
    o => o.method === 'cash' && o.status === 'awaiting_approval' && o.payment !== 'paid'
  );
  return (
    '<h2>Payment waiting <span class="badge warn">' +
    orders.length +
    '</span></h2>' +
    jobTable(orders)
  );
}
function announceCashOrders(orders) {
  const fresh = orders.filter(
    o =>
      o.method === 'cash' &&
      o.status === 'awaiting_approval' &&
      o.payment !== 'paid' &&
      o.updated >= cashAlertSince &&
      !cashAlertIds.has(o.id)
  );
  for (const o of fresh) cashAlertIds.add(o.id);
  if (fresh.length) toast(fresh.length + ' new counter payment request(s)');
  sessionStorage.setItem(
    'cash-alerts',
    JSON.stringify({ since: cashAlertSince, ids: [...cashAlertIds].slice(-1000) })
  );
}
initProductUI();
await boot();
