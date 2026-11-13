import {
  defaults,
  ensure,
  hmac,
  paymentProfile,
  publicOrder,
  quote,
  safeEqual,
  validateOptions,
  validateSettings,
} from '../lib/core.js';
import { inspectSourceFile, prepareDocuments, validateQrImage } from '../lib/documents.js';
import {
  verifyPaymentCapture,
  verifyPaymentVerification,
  verifyWebhookSignature,
} from '../lib/payment.js';
import { testPage } from '../lib/test-page.js';
import { assets } from './assets.generated.js';
const json = (v, status = 200, headers = {}) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
const now = () => Date.now();
const id = () => crypto.randomUUID();
const limits = new Map();
let lastCleanup = 0;
const run = (env, sql, ...args) =>
  env.DB.prepare(sql)
    .bind(...args)
    .run();
const one = (env, sql, ...args) =>
  env.DB.prepare(sql)
    .bind(...args)
    .first();
const all = async (env, sql, ...args) =>
  (
    await env.DB.prepare(sql)
      .bind(...args)
      .all()
  ).results;
async function settings(env) {
  const row = await one(env, 'SELECT value FROM settings WHERE id = ?', 'shop');
  return row ? { ...defaults, ...JSON.parse(row.value) } : structuredClone(defaults);
}
async function event(env, order, action) {
  await run(
    env,
    'INSERT INTO events (id,order_id,created,action) VALUES (?,?,?,?)',
    id(),
    order,
    now(),
    action
  );
}
async function session(env) {
  const payload = String(now() + 12 * 3600000);
  return payload + '.' + (await hmac(env.ADMIN_TOKEN, payload));
}
async function admin(req, env) {
  const bearer = req.headers.get('authorization')?.replace(/^Bearer /, '');
  if (env.ADMIN_TOKEN && safeEqual(bearer, env.ADMIN_TOKEN)) return true;
  const cookie = req.headers.get('cookie')?.match(/(?:^|;\s*)shri_session=([^;]+)/)?.[1];
  if (!cookie || !env.ADMIN_TOKEN) return false;
  const [expiry, sig] = cookie.split('.');
  return (
    Number(expiry) > now() &&
    Number(expiry) < now() + 13 * 3600000 &&
    safeEqual(sig, await hmac(env.ADMIN_TOKEN, expiry))
  );
}
const agent = (req, env) =>
  !!env.AGENT_TOKEN &&
  safeEqual(req.headers.get('authorization')?.replace(/^Bearer /, ''), env.AGENT_TOKEN);
function rate(req, key, max) {
  const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-shri-client') || 'local';
  const k = key + ip;
  let value = limits.get(k);
  if (!value || value.until < now()) {
    value = { until: now() + 60000, count: 0 };
    limits.set(k, value);
  }
  ensure(++value.count <= max, 'Too many requests. Please wait a minute.', 429);
  if (limits.size > 10000) for (const [k, v] of limits) if (v.until < now()) limits.delete(k);
}
function validateCustomerDetails(options) {
  const clean = {};
  for (const [key, max] of [
    ['customerName', 80],
    ['notes', 300],
    ['mobile', 20],
  ])
    if (options[key] !== undefined) {
      ensure(
        typeof options[key] === 'string' && options[key].length <= max,
        'Invalid ' + key + '.'
      );
      clean[key] = options[key]
        .trim()
        .replace(key === 'notes' ? /[\x00-\x08\x0b\x0c\x0e-\x1f]/g : /[\x00-\x1f]/g, '');
    }
  ensure(!clean.mobile || /^\d{10}$/.test(clean.mobile), 'Enter a10-digit mobile number.');
  return clean;
}
function clientMetadata(req, env) {
  const trusted = !env.LOCAL_SERVER && !!req.cf && typeof req.cf === 'object';
  const clean = v => (typeof v === 'string' ? v.replace(/[\x00-\x1f]/g, '').slice(0, 100) : null);
  const ip = trusted ? clean(req.headers.get('cf-connecting-ip')) : null;
  const ua = clean(req.headers.get('user-agent'));
  return {
    source: trusted ? 'Cloudflare edge' : 'unavailable/local',
    ip: ip && /^[a-fA-F0-9:.]+$/.test(ip) ? ip : null,
    receivedAt: now(),
    userAgent: ua,
    device: ua
      ? /Android/i.test(ua)
        ? 'Android (browser reported)'
        : /iPhone|iPad/i.test(ua)
          ? 'iOS (browser reported)'
          : /Windows/i.test(ua)
            ? 'Windows (browser reported)'
            : 'Other browser (reported)'
      : 'Unknown',
  };
}
async function deriveManualDuplex(env, options, s) {
  if (!options.duplex) return false;
  const printers = await all(env, 'SELECT * FROM printers'),
    agents = await all(
      env,
      "SELECT inventory FROM agents WHERE mode='live' AND seen > ?",
      now() - 35000
    );
  const inventory = agents.flatMap(a => {
      try {
        return JSON.parse(a.inventory);
      } catch {
        return [];
      }
    }),
    target = printers.find(p => p.id === s.mapping[options.color]);
  return !target || !inventory.some(p => p.Name === target.name && p.CanDuplex === true);
}
async function retainedFiles(env, order, refs) {
  ensure(
    Array.isArray(refs) && refs.length > 0,
    'Source files were not retained for this older request. Upload again to change document layout.',
    409
  );
  const files = [];
  for (const ref of refs) {
    ensure(
      ref.key?.startsWith('originals/' + order.id + '/') ||
        ref.key?.startsWith('sources/' + order.id + '/'),
      'Invalid private source reference.',
      409
    );
    const object = await env.BUCKET.get(ref.key);
    ensure(object, 'Source file expired.', 410);
    const bytes = object.arrayBuffer
      ? await object.arrayBuffer()
      : await new Response(object.body).arrayBuffer();
    files.push(new File([bytes], ref.name || 'source', { type: ref.type }));
  }
  return files;
}
function editable(order) {
  return (
    order.method === 'cash' &&
    ((order.payment === 'pending' && ['draft', 'awaiting_approval'].includes(order.status)) ||
      (order.payment === 'paid' && order.status === 'held'))
  );
}
async function getOrder(env, token) {
  const row = await one(env, 'SELECT * FROM orders WHERE token = ?', token);
  ensure(row, 'Print request not found.', 404);
  return row;
}
async function apiRazor(env, path, body) {
  ensure(
    env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET,
    'Online payments have not been configured.',
    503
  );
  const response = await fetch('https://api.razorpay.com/v1/' + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: 'Basic ' + btoa(env.RAZORPAY_KEY_ID + ':' + env.RAZORPAY_KEY_SECRET),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  ensure(response.ok, 'Payment provider unavailable. Try again or pay at the desk.', 502);
  return data;
}
async function doMarkPaid(env, order, paymentId) {
  ensure(order.method === 'online', 'Wrong payment method.');
  const s = await settings(env),
    deadline = now() - s.retentionHours * 3600000;
  const target = JSON.parse(order.options).duplex === true ? 'manual_duplex' : 'queued';
  const result = await run(
    env,
    "UPDATE orders SET payment = 'paid', payment_id = ?, status = CASE WHEN status = 'awaiting_payment' AND created > ? AND file != '' THEN ? WHEN status = 'awaiting_payment' THEN 'expired' ELSE status END, updated = ? WHERE id = ? AND payment != 'paid'",
    paymentId,
    deadline,
    target,
    now(),
    order.id
  );
  if (result.meta.changes > 0) await event(env, order.id, 'Online payment verified by provider');
  return await getOrder(env, order.token);
}
function validateVisitBody(b) {
  ensure(b && typeof b === 'object' && !Array.isArray(b), 'Invalid visit payload.');
  ensure(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(b.id),
    'Invalid visit id.'
  );
  ensure(['document', 'passport', 'id', 'resume'].includes(b.service), 'Invalid service.');
  ensure(
    ['opened', 'upload', 'settings', 'review', 'submitted'].includes(b.stage),
    'Invalid stage.'
  );
  ensure(Array.isArray(b.files) && b.files.length <= 10, 'Max 10 files.');
  let total = 0;
  const files = b.files.map(f => {
    ensure(
      f && typeof f.name === 'string' && f.name.length > 0 && f.name.length <= 150,
      'Invalid file name.'
    );
    ensure(
      Number.isInteger(f.size) && f.size > 0 && f.size <= 25 * 1024 * 1024,
      'Invalid file size.'
    );
    ensure(Number.isInteger(f.pages) && f.pages >= 1 && f.pages <= 1000, 'Invalid page count.');
    total += f.size;
    return { name: f.name, size: f.size, pages: f.pages };
  });
  ensure(total <= 40 * 1024 * 1024, 'Total upload size exceeds 40 MB.');
  const o = b.options || {};
  ensure(typeof o === 'object' && !Array.isArray(o), 'Invalid options.');
  const options = {};
  for (const [k, values] of Object.entries({
    color: ['bw', 'color'],
    paper: ['A4', 'A3', 'A2', 'A1'],
    method: ['cash', 'upi', 'online'],
    paymentChannel: ['qr', 'razorpay_link'],
  }))
    if (o[k] !== undefined) {
      ensure(values.includes(o[k]), 'Invalid ' + k + '.');
      options[k] = o[k];
    }
  if (o.copies !== undefined) {
    ensure(Number.isInteger(o.copies) && o.copies >= 1 && o.copies <= 100, 'Invalid copies.');
    options.copies = o.copies;
  }
  if (o.duplex !== undefined) {
    ensure(typeof o.duplex === 'boolean', 'Invalid duplex.');
    options.duplex = o.duplex;
  }
  if (b.orderToken != null)
    ensure(
      typeof b.orderToken === 'string' && /^[a-f0-9-]{60,90}$/.test(b.orderToken),
      'Invalid order token.'
    );
  return {
    id: b.id,
    service: b.service,
    stage: b.stage,
    files,
    options,
    orderToken: b.orderToken || null,
  };
}
async function recentVisits(env, time) {
  const rows = await all(
    env,
    "SELECT id,value FROM settings WHERE id LIKE 'visit:%' AND json_extract(value,'$.updated') > ? AND json_extract(value,'$.stage') != 'submitted' AND (json_extract(value,'$.orderToken') IS NULL OR NOT EXISTS (SELECT 1 FROM orders WHERE token=json_extract(settings.value,'$.orderToken'))) ORDER BY json_extract(value,'$.updated') DESC LIMIT 50",
    time - 120000
  );
  return rows.map(row => ({ ...JSON.parse(row.value), id: row.id.slice(6) }));
}
async function cleanupVisits(env) {
  const cutoff = now() - 10 * 60 * 1000;
  const rows = await all(
    env,
    "SELECT id,value FROM settings WHERE id LIKE 'visit:%' AND json_extract(value,'$.updated')<?",
    cutoff
  );
  for (const row of rows) await run(env, 'DELETE FROM settings WHERE id = ?', row.id);
  const count = await one(env, "SELECT COUNT(*) AS n FROM settings WHERE id LIKE 'visit:%'");
  if (count.n > 500) {
    const excess = count.n - 500;
    const old = await all(
      env,
      "SELECT id FROM settings WHERE id LIKE 'visit:%' ORDER BY json_extract(value,'$.updated') LIMIT ?",
      excess
    );
    for (const row of old) await run(env, 'DELETE FROM settings WHERE id = ?', row.id);
  }
}
export async function cleanup(env) {
  const s = await settings(env);
  const expired = await all(
    env,
    "SELECT id,file,options FROM orders WHERE created < ? AND file != '' AND status NOT IN ('claimed') LIMIT 100",
    now() - s.retentionHours * 3600000
  );
  for (const row of expired) {
    await env.BUCKET.delete(row.file);
    for (const original of [
      ...(JSON.parse(row.options).sourceFiles || JSON.parse(row.options).idOriginals || []),
      ...(JSON.parse(row.options).preparedSources || []),
    ])
      if (
        original.key?.startsWith('originals/' + row.id + '/') ||
        original.key?.startsWith('sources/' + row.id + '/')
      )
        await env.BUCKET.delete(original.key);
    await run(
      env,
      "UPDATE orders SET file = '', status = CASE WHEN status IN ('draft','awaiting_payment','awaiting_approval','queued','manual_duplex','held') THEN 'expired' ELSE status END WHERE id = ?",
      row.id
    );
  }
  await run(
    env,
    "DELETE FROM settings WHERE id LIKE 'ticket:%' AND CAST(value AS INTEGER) < ?",
    now()
  );
  await cleanupVisits(env);
  return expired.length;
}
export async function handler(req, env) {
  try {
    const u = new URL(req.url),
      p = u.pathname;
    if (req.method !== 'GET' && req.method !== 'HEAD' && p !== '/api/payments/webhook') {
      const origin = req.headers.get('origin');
      ensure(!origin || origin === u.origin, 'Cross-site request rejected.', 403);
    }
    if (!p.startsWith('/api/')) {
      const asset =
        assets[p] ||
        (p === '/' || p.startsWith('/admin') || p.startsWith('/order/')
          ? assets['/index.html']
          : null);
      return asset
        ? new Response(
            asset.base64 ? Uint8Array.from(atob(asset.body), c => c.charCodeAt(0)) : asset.body,
            {
              headers: {
                'Content-Type': asset.type,
                'Cache-Control': 'no-cache',
                'X-Content-Type-Options': 'nosniff',
                'Referrer-Policy': 'no-referrer',
                'Content-Security-Policy':
                  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://checkout.razorpay.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self' blob: https://api.razorpay.com https://checkout.razorpay.com; connect-src 'self' https://api.razorpay.com https://cdn.jsdelivr.net https://storage.googleapis.com; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
              },
            }
          )
        : new Response('Not found', { status: 404 });
    }
    if (p === '/api/config') {
      const s = await settings(env);
      const onlineReady =
        s.online &&
        !!env.RAZORPAY_KEY_ID &&
        !!env.RAZORPAY_KEY_SECRET &&
        !!env.RAZORPAY_WEBHOOK_SECRET;
      const hasQr = !!paymentProfile(s);
      const hasHosted = !!s.hostedPaymentUrl;
      return json({
        ...s,
        paymentProfiles: undefined,
        activePaymentProfile: undefined,
        paymentProfile: paymentProfile(s),
        upiAvailable: hasQr || hasHosted,
        hostedPaymentUrl: hasHosted ? s.hostedPaymentUrl : undefined,
        qrAvailable: hasQr,
        local: !!env.LOCAL_SERVER,
        online: onlineReady,
        onlineConfigured:
          !!env.RAZORPAY_KEY_ID && !!env.RAZORPAY_KEY_SECRET && !!env.RAZORPAY_WEBHOOK_SECRET,
        admin: await admin(req, env),
        agentOnline: !!(await one(
          env,
          'SELECT id FROM agents WHERE seen > ? LIMIT 1',
          now() - 35000
        )),
      });
    }
    if (p === '/api/visits' && req.method === 'POST') {
      rate(req, 'visit', 120);
      const raw = await req.text();
      ensure(new TextEncoder().encode(raw).length <= 20 * 1024, 'Visit payload too large.', 413);
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        ensure(false, 'Invalid JSON.');
      }
      const b = validateVisitBody(payload),
        time = now();
      const val = JSON.stringify({
        ...b,
        customerMetadata: clientMetadata(req, env),
        created: time,
        updated: time,
      });
      await run(
        env,
        'INSERT INTO settings (id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value = excluded.value',
        'visit:' + b.id,
        val
      );
      await cleanupVisits(env);
      return json({ ok: true, id: b.id });
    }
    const qrRoute = p.match(/^\/api\/payment-qr\/([a-f0-9-]{36}\.(png|jpg))$/);
    if (qrRoute && req.method === 'GET') {
      const file = await env.BUCKET.get('payment-qr/' + qrRoute[1]);
      ensure(file, 'QR image not found.', 404);
      return new Response(file.body, {
        headers: {
          'Content-Type': qrRoute[2] === 'png' ? 'image/png' : 'image/jpeg',
          'Cache-Control': 'public, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    if (p === '/api/desktop-login' && req.method === 'GET') {
      const expires = u.searchParams.get('expires'),
        nonce = u.searchParams.get('nonce'),
        sig = u.searchParams.get('signature');
      ensure(
        env.ADMIN_TOKEN &&
          Number(expires) > now() &&
          Number(expires) < now() + 65000 &&
          /^[a-f0-9-]{36}$/.test(nonce || '') &&
          safeEqual(sig, await hmac(env.ADMIN_TOKEN, 'desktop|' + expires + '|' + nonce)),
        'Desktop sign in has expired. Open the desktop shortcut again.',
        401
      );
      const r = await run(
        env,
        'INSERT OR IGNORE INTO settings (id,value) VALUES (?,?)',
        'ticket:' + nonce,
        expires
      );
      ensure(r.meta.changes === 1, 'Desktop sign in was already used.', 401);
      return new Response(null, {
        status: 302,
        headers: {
          Location: '/admin',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'Set-Cookie': `shri_session=${await session(env)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${u.protocol === 'https:' ? '; Secure' : ''}`,
        },
      });
    }
    if (p === '/api/login' && req.method === 'POST') {
      rate(req, 'login', 8);
      ensure(env.ADMIN_TOKEN, 'Administrator setup is required.', 503);
      const b = await req.json();
      ensure(safeEqual(b.token, env.ADMIN_TOKEN), 'Incorrect admin key.', 401);
      return json({ ok: true }, 200, {
        'Set-Cookie': `shri_session=${await session(env)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${u.protocol === 'https:' ? '; Secure' : ''}`,
      });
    }
    if (p === '/api/logout' && req.method === 'POST')
      return json({ ok: true }, 200, {
        'Set-Cookie': 'shri_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
      });
    if (p === '/api/orders' && req.method === 'POST') {
      rate(req, 'upload', 8);
      ensure(
        Number(req.headers.get('content-length') || 0) <= 43 * 1024 * 1024,
        'Upload is too large.',
        413
      );
      const daily = await one(
        env,
        'SELECT COUNT(*) AS n FROM orders WHERE created > ?',
        now() - 86400000
      );
      ensure(daily.n < 500, 'Daily request limit reached. Please visit the desk.', 429);
      const form = await req.formData();
      const files = form.getAll('files');
      const options = JSON.parse(form.get('options') || '{}');
      ensure(
        env.CUSTOMER_PAYMENT_POLICY === 'legacy' || options.method === 'cash',
        'Please pay at the counter. Online payment is currently unavailable.'
      );
      const s = await settings(env);
      const onlineReady =
        s.online &&
        !!env.RAZORPAY_KEY_ID &&
        !!env.RAZORPAY_KEY_SECRET &&
        !!env.RAZORPAY_WEBHOOK_SECRET;
      const hasQr = !!paymentProfile(s);
      const hasHosted = !!s.hostedPaymentUrl;
      if (options.method === 'upi') {
        const channel = options.paymentChannel || (hasQr ? 'qr' : 'razorpay_link');
        if (channel === 'qr') ensure(hasQr, 'QR payment not configured.');
        if (channel === 'razorpay_link') ensure(hasHosted, 'Hosted payment link not configured.');
        options.paymentChannel = channel;
      }
      ensure(
        (options.method === 'cash' && s.cash) ||
          (options.method === 'upi' && (hasQr || hasHosted)) ||
          (options.method === 'online' && onlineReady),
        'This payment option is unavailable.'
      );
      if (options.method === 'upi') {
        if (options.paymentChannel === 'qr') options.paymentProfile = { ...paymentProfile(s) };
        if (options.paymentChannel === 'razorpay_link')
          options.hostedPaymentUrl = s.hostedPaymentUrl;
      }
      ensure(
        files.every(f => typeof f.arrayBuffer === 'function'),
        'Choose valid files.'
      );
      Object.assign(options, validateCustomerDetails(options));
      const doc = await prepareDocuments(files, options);
      const orderId = id(),
        token = id() + id().replaceAll('-', ''),
        file = 'jobs/' + orderId + '.pdf',
        time = now();
      let manualDuplex = false;
      if (options.duplex) {
        const printers = await all(env, 'SELECT * FROM printers');
        const liveAgents = await all(
          env,
          "SELECT inventory FROM agents WHERE mode='live' AND seen > ?",
          now() - 35000
        );
        const inventories = liveAgents.flatMap(a => {
          try {
            return JSON.parse(a.inventory);
          } catch {
            return [];
          }
        });
        const targetPrinter = s.mapping[options.color]
          ? printers.find(p => p.id === s.mapping[options.color])
          : null;
        const inv = targetPrinter ? inventories.find(p => p.Name === targetPrinter.name) : null;
        if (!inv || inv.CanDuplex !== true) manualDuplex = true;
      }
      const suppliedOriginals = form.getAll('originals'),
        originalFiles = suppliedOriginals.length ? suppliedOriginals : files;
      ensure(
        !suppliedOriginals.length || suppliedOriginals.length === files.length,
        'Supply one original for each uploaded file.'
      );
      ensure(
        [...files, ...suppliedOriginals].reduce((n, f) => n + (f.size || 0), 0) <= 40 * 1024 * 1024,
        'Combined uploads and originals must be under 40 MB.'
      );
      const sourceFiles = [],
        preparedSources = [],
        pendingSources = [],
        uploadManifest = [];
      for (let i = 0; i < originalFiles.length; i++) {
        const meta = await inspectSourceFile(originalFiles[i]),
          key = 'originals/' + orderId + '/' + i;
        sourceFiles.push({ ...meta, key });
        uploadManifest.push({
          index: i,
          ...meta,
          receivedAt: time,
          ip: clientMetadata(req, env).ip,
          userAgent: clientMetadata(req, env).userAgent,
        });
        pendingSources.push({ key, file: originalFiles[i] });
        if (['id', 'passport'].includes(options.service)) {
          const preparedMeta = await inspectSourceFile(files[i]),
            preparedKey = 'sources/' + orderId + '/' + i;
          preparedSources.push({ ...preparedMeta, key: preparedKey });
          pendingSources.push({ key: preparedKey, file: files[i] });
        } else preparedSources.push({ ...meta, key });
      }
      const idOriginals = options.service === 'id' ? sourceFiles : [];
      const finalOptions = {
        ...options,
        idOriginals,
        sourceFiles,
        preparedSources,
        uploadManifest,
        customerMetadata: clientMetadata(req, env),
        selected: doc.selected,
        originalPages: doc.originalPages,
        manualDuplex,
      };
      const amount = quote(doc.pages, options, s);
      const names = files.map(f =>
        String(f.name)
          .replace(/[\x00-\x1f]/g, '')
          .slice(0, 150)
      );
      await env.BUCKET.put(file, doc.bytes, { httpMetadata: { contentType: 'application/pdf' } });
      try {
        for (const source of pendingSources)
          await env.BUCKET.put(source.key, new Uint8Array(await source.file.arrayBuffer()));
        await run(
          env,
          'INSERT INTO orders (id,token,created,updated,names,options,pages,amount,method,payment,status,file) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          orderId,
          token,
          time,
          time,
          JSON.stringify(names),
          JSON.stringify(finalOptions),
          doc.pages,
          amount,
          options.method,
          'pending',
          'draft',
          file
        );
      } catch (e) {
        await env.BUCKET.delete(file);
        for (const source of pendingSources) await env.BUCKET.delete(source.key);
        throw e;
      }
      return json(publicOrder(await getOrder(env, token)), 201);
    }
    const om = p.match(
      /^\/api\/orders\/([a-f0-9-]{60,90})(?:\/(confirm|file|upi-sent|checkout|verify))?$/
    );
    if (om) {
      const order = await getOrder(env, om[1]),
        action = om[2];
      if (!action && req.method === 'GET') return json(publicOrder(order));
      if (action === 'file' && req.method === 'GET') {
        ensure(
          order.file && order.created > now() - (await settings(env)).retentionHours * 3600000,
          'Document has expired.',
          410
        );
        const object = await env.BUCKET.get(order.file);
        ensure(object, 'Document has expired.', 410);
        return new Response(object.body, {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'inline; filename="print-preview.pdf"',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': 'sandbox',
          },
        });
      }
      if (action === 'confirm' && req.method === 'POST') {
        if (order.status !== 'draft') return json(publicOrder(order));
        const raw = await req.text();
        ensure(raw.length <= 2048, 'Confirmation payload too large.', 413);
        let confirmation = {};
        if (raw.trim()) {
          try {
            confirmation = JSON.parse(raw);
          } catch {
            ensure(false, 'Invalid confirmation payload.');
          }
          ensure(
            confirmation && typeof confirmation === 'object' && !Array.isArray(confirmation),
            'Invalid confirmation payload.'
          );
        }
        if (confirmation.version !== undefined && confirmation.version !== String(order.updated))
          return json(
            {
              error: 'The shop changed this request. Review the updated preview before confirming.',
              order: publicOrder(order),
            },
            409
          );
        const s = await settings(env);
        ensure(
          order.file && order.created > now() - s.retentionHours * 3600000,
          'Document has expired. Please upload again.',
          410
        );
        const opts = JSON.parse(order.options);
        const manualDuplex = opts.manualDuplex === true; // Fixed: use opts.duplex to match client storage
        let status;
        if (order.method === 'cash') {
          // Cash approval is required for this release; cashAuto no longer auto-queues
          status = 'awaiting_approval';
        } else {
          status = 'awaiting_payment';
        }
        const confirmed = await run(
          env,
          "UPDATE orders SET status = ?, payment = CASE WHEN ? THEN 'paid' ELSE payment END, updated = ? WHERE id = ? AND status = 'draft' AND updated = ?",
          status,
          0,
          Math.max(now(), order.updated + 1),
          order.id,
          order.updated
        );
        if (confirmed.meta.changes !== 1) {
          const latest = await getOrder(env, order.token);
          return json(
            {
              error:
                'This request changed while confirming. Review the latest preview before trying again.',
              order: publicOrder(latest),
            },
            409
          );
        }
        await event(env, order.id, 'Customer confirmed request');
        return json(publicOrder(await getOrder(env, order.token)));
      }
      if (action === 'upi-sent' && req.method === 'POST') {
        ensure(
          order.method === 'upi' && order.status === 'awaiting_payment',
          'This request does not need a UPI payment report.'
        );
        await run(
          env,
          "UPDATE orders SET payment = 'reported', updated = ? WHERE id = ? AND payment = 'pending'",
          now(),
          order.id
        );
        return json({
          ok: true,
          message: 'Payment reported. The shop will check its bank app before printing.',
        });
      }
      if (action === 'checkout' && req.method === 'POST') {
        rate(req, 'checkout', 12);
        ensure(
          order.method === 'online' && order.status === 'awaiting_payment',
          'Request is not awaiting online payment.'
        );
        let gateway = order.gateway;
        if (!gateway) {
          const r = await apiRazor(env, 'orders', {
            amount: order.amount,
            currency: 'INR',
            receipt: order.id,
          });
          gateway = r.id;
          await run(
            env,
            'UPDATE orders SET gateway = ? WHERE id = ? AND gateway IS NULL',
            gateway,
            order.id
          );
          gateway = (await getOrder(env, order.token)).gateway;
        }
        return json({
          key: env.RAZORPAY_KEY_ID,
          order_id: gateway,
          amount: order.amount,
          currency: 'INR',
          name: (await settings(env)).shopName,
        });
      }
      if (action === 'verify' && req.method === 'POST') {
        const b = await req.json();
        await verifyPaymentVerification(order, b, env.RAZORPAY_KEY_SECRET);
        const payment = await apiRazor(
          env,
          'payments/' + encodeURIComponent(b.razorpay_payment_id)
        );
        await verifyPaymentCapture(payment, order);
        await doMarkPaid(env, order, payment.id);
        return json({ ok: true });
      }
      ensure(false, 'Action not supported.', 405);
    }
    if (p === '/api/payments/webhook' && req.method === 'POST') {
      ensure(env.RAZORPAY_WEBHOOK_SECRET, 'Webhook not configured.', 503);
      const raw = await req.text();
      await verifyWebhookSignature(
        raw,
        req.headers.get('x-razorpay-signature'),
        env.RAZORPAY_WEBHOOK_SECRET
      );
      const b = JSON.parse(raw),
        payment = b.payload?.payment?.entity;
      if (
        payment &&
        payment.status === 'captured' &&
        ['payment.captured', 'order.paid'].includes(b.event)
      ) {
        const order = await one(env, 'SELECT * FROM orders WHERE gateway = ?', payment.order_id);
        if (
          order &&
          payment.amount === order.amount &&
          payment.currency === 'INR' &&
          order.payment !== 'paid'
        )
          await doMarkPaid(env, order, payment.id);
      }
      return json({ ok: true });
    }
    if (p.startsWith('/api/admin/')) {
      ensure(await admin(req, env), 'Sign in to the shop panel.', 401);
      if (p === '/api/admin/state') {
        const s = await settings(env);
        const printers = await all(env, 'SELECT * FROM printers');
        const agents = await all(env, 'SELECT * FROM agents');
        const bwPrinter = s.mapping.bw ? printers.find(p => p.id === s.mapping.bw) : null;
        const colorPrinter = s.mapping.color ? printers.find(p => p.id === s.mapping.color) : null;
        const liveAgents = agents.filter(a => a.mode === 'live' && now() - a.seen <= 35000);
        const liveAgent = liveAgents[0];
        const inventories = liveAgents.flatMap(a => {
          try {
            return JSON.parse(a.inventory);
          } catch {
            return [];
          }
        });
        const available = p =>
          p &&
          !/offline|error|paperout|notavailable|dooropen|tonerlow/i.test(p.PrinterStatus || '') &&
          !/Microsoft Print to PDF|OneNote|XPS|Fax/i.test(p.Name || '');
        const bwInventory =
          !!bwPrinter && inventories.some(p => p.Name === bwPrinter.name && available(p));
        const colorInventory =
          !!colorPrinter &&
          colorPrinter.capability === 'color' &&
          inventories.some(
            p => p.Name === colorPrinter.name && p.SupportsColor !== false && available(p)
          );
        const paymentReadiness = {
          gatewayConfigured: !!env.RAZORPAY_KEY_ID && !!env.RAZORPAY_KEY_SECRET,
          webhookConfigured: !!env.RAZORPAY_WEBHOOK_SECRET,
          liveAgentOnline: !!liveAgent,
          mappedBwReady: !!bwPrinter && bwInventory,
          mappedColorReady: !!colorPrinter && colorInventory,
        };
        return json({
          settings: s,
          printers,
          agents,
          visits: await recentVisits(env, now()),
          orders: await all(env, 'SELECT * FROM orders ORDER BY created DESC LIMIT 1000'),
          now: now(),
          gatewayConfigured: !!env.RAZORPAY_KEY_ID && !!env.RAZORPAY_KEY_SECRET,
          paymentReadiness,
        });
      }
      if (p === '/api/admin/live' && req.method === 'GET') {
        const serverTime = now();
        const after = Number(u.searchParams.get('after') || '0');
        ensure(
          Number.isFinite(after) && after >= 0 && after <= serverTime + 60000,
          'Invalid sync cursor.'
        );
        const orders = await all(
          env,
          'SELECT * FROM orders WHERE updated >= ? ORDER BY updated DESC LIMIT 200',
          after
        );
        const agents = await all(env, 'SELECT id,mode,seen,inventory FROM agents');
        const visits = await recentVisits(env, serverTime);
        return json({ orders, agents, visits, now: serverTime });
      }
      if (p === '/api/admin/settings' && req.method === 'POST') {
        const s = validateSettings(await req.json());
        const printers = await all(env, 'SELECT * FROM printers');
        for (const mode of ['bw', 'color']) {
          const target = printers.find(p => p.id === s.mapping?.[mode]);
          ensure(!s.mapping?.[mode] || target, 'Selected printer no longer exists.');
          ensure(
            mode !== 'color' || !target || target.capability === 'color',
            'Color jobs require a color printer.'
          );
        }
        await run(
          env,
          'INSERT INTO settings (id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value = excluded.value',
          'shop',
          JSON.stringify(s)
        );
        return json({ ok: true });
      }
      if (p === '/api/admin/printers' && req.method === 'POST') {
        const b = await req.json();
        ensure(
          typeof b.name === 'string' && b.name.trim() && b.name.length <= 200,
          'Enter the exact Windows printer name.'
        );
        ensure(['bw', 'color'].includes(b.capability), 'Choose a printer capability.');
        ensure(['USB', 'Wi-Fi', 'Network'].includes(b.connection), 'Choose a connection.');
        await run(
          env,
          'INSERT INTO printers (id,name,brand,model,capability,connection) VALUES (?,?,?,?,?,?)',
          id(),
          b.name.trim(),
          String(b.brand || 'Other').slice(0, 60),
          String(b.model || '').slice(0, 100),
          b.capability,
          b.connection
        );
        return json({ ok: true });
      }
      const pm = p.match(/^\/api\/admin\/printers\/([a-f0-9-]+)$/);
      if (pm && req.method === 'DELETE') {
        const s = await settings(env);
        ensure(
          !Object.values(s.mapping).includes(pm[1]),
          'Change the printer mapping before removing this printer.'
        );
        await run(env, 'DELETE FROM printers WHERE id = ?', pm[1]);
        return json({ ok: true });
      }
      const originalMatch = p.match(/^\/api\/admin\/orders\/([a-f0-9-]+)\/original\/([0-9])$/);
      if (originalMatch && req.method === 'GET') {
        const order = await one(env, 'SELECT * FROM orders WHERE id = ?', originalMatch[1]);
        ensure(order, 'Request not found.', 404);
        ensure(
          order.file && order.created > now() - (await settings(env)).retentionHours * 3600000,
          'Document expired.',
          410
        );
        const options = JSON.parse(order.options),
          original = (options.sourceFiles || options.idOriginals)?.[Number(originalMatch[2])];
        ensure(
          original && original.key.startsWith('originals/' + order.id + '/'),
          'Original image was not retained for this request.',
          404
        );
        const image = await env.BUCKET.get(original.key);
        ensure(image, 'Original image expired.', 410);
        return new Response(image.body, {
          headers: {
            'Content-Type': original.type,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Content-Disposition':
              "attachment; filename*=UTF-8''" + encodeURIComponent(original.name || 'original'),
          },
        });
      }
      const recropMatch = p.match(/^\/api\/admin\/orders\/([a-f0-9-]+)\/recrop$/);
      if (recropMatch && req.method === 'POST') {
        const order = await one(env, 'SELECT * FROM orders WHERE id = ?', recropMatch[1]);
        ensure(order, 'Request not found.', 404);
        const opts = JSON.parse(order.options);
        ensure(
          editable(order) && opts.service === 'id',
          'Only unpaid or safely held ID requests can be recropped.',
          409
        );
        ensure(
          order.file && order.created > now() - (await settings(env)).retentionHours * 3600000,
          'Document expired.',
          410
        );
        const form = await req.formData();
        ensure(
          form.get('version') === String(order.updated),
          'Order changed; reload before recropping.',
          409
        );
        const files = form.getAll('files'),
          doc = await prepareDocuments(files, { ...opts, range: '', swapSides: false }),
          revision = id(),
          file = 'jobs/' + order.id + '-recrop-' + revision + '.pdf',
          time = Math.max(now(), order.updated + 1),
          preparedSources = [];
        for (let i = 0; i < files.length; i++)
          preparedSources.push({
            ...(await inspectSourceFile(files[i])),
            key: 'sources/' + order.id + '/' + revision + '/' + i,
          });
        const nextOptions = {
          ...opts,
          preparedSources,
          swapSides: false,
          selected: doc.selected,
          originalPages: doc.originalPages,
        };
        try {
          await env.BUCKET.put(file, doc.bytes, {
            httpMetadata: { contentType: 'application/pdf' },
          });
          for (let i = 0; i < files.length; i++)
            await env.BUCKET.put(
              preparedSources[i].key,
              new Uint8Array(await files[i].arrayBuffer())
            );
          const r = await run(
            env,
            "UPDATE orders SET file = ?, pages = ?, options = ?, updated = ? WHERE id = ? AND updated = ? AND method = 'cash' AND ((payment = 'pending' AND status IN ('draft','awaiting_approval')) OR (payment = 'paid' AND status = 'held'))",
            file,
            doc.pages,
            JSON.stringify(nextOptions),
            time,
            order.id,
            order.updated
          );
          ensure(r.meta.changes === 1, 'Order changed; recrop was not saved.', 409);
        } catch (e) {
          await env.BUCKET.delete(file);
          for (const ref of preparedSources) await env.BUCKET.delete(ref.key);
          throw e;
        }
        await event(env, order.id, 'Operator corrected ID crop');
        await env.BUCKET.delete(order.file);
        for (const ref of opts.preparedSources || [])
          if (ref.key?.startsWith('sources/' + order.id + '/')) await env.BUCKET.delete(ref.key);
        return json({ ok: true, order: publicOrder(await getOrder(env, order.token)) });
      }
      const am = p.match(/^\/api\/admin\/orders\/([a-f0-9-]+)$/);
      if (am && req.method === 'POST') {
        const order = await one(env, 'SELECT * FROM orders WHERE id = ?', am[1]);
        ensure(order, 'Request not found.', 404);
        const b = await req.json();
        const opts = JSON.parse(order.options);
        const manualDuplex = opts.manualDuplex === true;
        if (b.action === 'approve') {
          ensure(
            ['cash', 'upi'].includes(order.method) &&
              ['awaiting_approval', 'awaiting_payment', 'queued', 'submitted', 'printed'].includes(
                order.status
              ),
            'Request cannot be approved in this state.'
          );
          ensure(b.confirmed === true, 'Confirm receipt of payment.');
          ensure(
            order.file && order.created > now() - (await settings(env)).retentionHours * 3600000,
            'Document expired.',
            410
          );
          const newStatus = manualDuplex ? 'manual_duplex' : 'queued';
          await run(
            env,
            "UPDATE orders SET payment = 'paid', status = CASE WHEN status IN ('submitted','printed') THEN status ELSE ? END, updated = ? WHERE id = ? AND status IN ('awaiting_approval','awaiting_payment','queued','submitted','printed')",
            newStatus,
            now(),
            order.id
          );
        } else if (b.action === 'cash_received') {
          if (
            order.method === 'cash' &&
            order.payment === 'paid' &&
            ['queued', 'manual_duplex', 'claimed', 'submitted', 'printed'].includes(order.status)
          )
            return json({ ok: true, order: publicOrder(order) });
          ensure(
            order.method === 'cash' &&
              order.status === 'awaiting_approval' &&
              order.payment === 'pending',
            'Cash receipt only for unpaid cash requests awaiting approval.',
            409
          );
          ensure(
            order.file && order.created > now() - (await settings(env)).retentionHours * 3600000,
            'Document expired.',
            410
          );
          const newStatus = manualDuplex ? 'manual_duplex' : 'queued',
            time = Math.max(now(), order.updated + 1);
          const result = await run(
            env,
            "UPDATE orders SET payment = 'paid', status = ?, updated = ? WHERE id = ? AND status = 'awaiting_approval' AND payment = 'pending' AND updated = ?",
            newStatus,
            time,
            order.id,
            order.updated
          );
          ensure(result.meta.changes === 1, 'Order changed; reload before receiving cash.', 409);
        } else if (b.action === 'hold') {
          ensure(
            order.status === 'queued' && order.payment === 'paid',
            'Only paid queued jobs can be held before an agent claims them.',
            409
          );
          ensure(b.version === String(order.updated), 'Order changed; reload before holding.', 409);
          const r = await run(
            env,
            "UPDATE orders SET status = 'held', updated = ? WHERE id = ? AND updated = ? AND status = 'queued' AND payment = 'paid'",
            Math.max(now(), order.updated + 1),
            order.id,
            order.updated
          );
          ensure(
            r.meta.changes === 1,
            'The agent or another operator already changed this job.',
            409
          );
          await event(env, order.id, 'Operator held queued job for editing');
          return json({ ok: true, order: publicOrder(await getOrder(env, order.token)) });
        } else if (b.action === 'release') {
          ensure(
            order.status === 'held' && order.payment === 'paid',
            'Only paid held jobs can be released.',
            409
          );
          ensure(b.version === String(order.updated), 'Order changed; reload before release.', 409);
          const s = await settings(env);
          ensure(
            order.file && order.created > now() - s.retentionHours * 3600000,
            'Document expired.',
            410
          );
          const nextManual = await deriveManualDuplex(env, opts, s),
            nextOptions = { ...opts, manualDuplex: nextManual };
          const r = await run(
            env,
            "UPDATE orders SET status = ?, options = ?, updated = ? WHERE id = ? AND updated = ? AND status = 'held' AND payment = 'paid'",
            nextManual ? 'manual_duplex' : 'queued',
            JSON.stringify(nextOptions),
            Math.max(now(), order.updated + 1),
            order.id,
            order.updated
          );
          ensure(r.meta.changes === 1, 'Order changed; release was not saved.', 409);
          await event(env, order.id, 'Operator released held job');
          return json({ ok: true, order: publicOrder(await getOrder(env, order.token)) });
        } else if (b.action === 'adjust') {
          ensure(
            editable(order),
            'Hold a paid queued job before editing, or edit an unpaid cash request.',
            409
          );
          ensure(
            b.version === String(order.updated),
            'Order changed; reload before adjusting.',
            409
          );
          ensure(
            b.options && typeof b.options === 'object' && !Array.isArray(b.options),
            'New options required.'
          );
          ensure(
            Object.keys(b.options).length > 0 &&
              Object.keys(b.options).every(k =>
                [
                  'copies',
                  'color',
                  'duplex',
                  'paper',
                  'orientation',
                  'range',
                  'rotation',
                  'idFormat',
                  'swapSides',
                  'customerName',
                  'mobile',
                  'notes',
                ].includes(k)
              ),
            'Unsupported document adjustment.'
          );
          const s = await settings(env);
          ensure(
            order.file && order.created > now() - s.retentionHours * 3600000,
            'Document expired.',
            410
          );
          const nextOptions = { ...opts, ...b.options };
          Object.assign(nextOptions, validateCustomerDetails(nextOptions));
          validateOptions(nextOptions);
          nextOptions.manualDuplex = await deriveManualDuplex(env, nextOptions, s);
          const refs = opts.preparedSources || opts.sourceFiles;
          let doc,
            file = order.file;
          if (refs?.length) {
            const files = await retainedFiles(env, order, refs);
            doc = await prepareDocuments(files, nextOptions);
            file = 'jobs/' + order.id + '-edit-' + id() + '.pdf';
          } else {
            ensure(
              Object.keys(b.options).every(k =>
                ['copies', 'color', 'duplex', 'customerName', 'mobile', 'notes'].includes(k)
              ),
              'Original source unavailable for layout changes on this older request.',
              409
            );
            doc = {
              pages: order.pages,
              selected: opts.selected,
              originalPages: opts.originalPages,
            };
          }
          const amount = quote(doc.pages, nextOptions, s);
          ensure(
            order.payment !== 'paid' || amount === order.amount,
            'Paid held job changes must keep the paid total unchanged.',
            409
          );
          Object.assign(nextOptions, { selected: doc.selected, originalPages: doc.originalPages });
          if (doc.bytes)
            await env.BUCKET.put(file, doc.bytes, {
              httpMetadata: { contentType: 'application/pdf' },
            });
          try {
            const result = await run(
              env,
              "UPDATE orders SET options = ?, amount = ?, pages = ?, file = ?, updated = ? WHERE id = ? AND updated = ? AND method = 'cash' AND ((payment = 'pending' AND status IN ('draft','awaiting_approval')) OR (payment = 'paid' AND status = 'held'))",
              JSON.stringify(nextOptions),
              amount,
              doc.pages,
              file,
              Math.max(now(), order.updated + 1),
              order.id,
              order.updated
            );
            ensure(result.meta.changes === 1, 'Order changed; adjustment was not saved.', 409);
          } catch (e) {
            if (file !== order.file) await env.BUCKET.delete(file);
            throw e;
          }
          await event(env, order.id, 'Operator adjusted document from retained source');
          if (file !== order.file) await env.BUCKET.delete(order.file);
          return json({ ok: true, order: publicOrder(await getOrder(env, order.token)) });
        } else if (b.action === 'printed') {
          ensure(
            order.status === 'submitted',
            'Confirm paper output only after Windows accepted the job.'
          );
          await run(
            env,
            "UPDATE orders SET status = 'printed', updated = ? WHERE id = ? AND status = 'submitted'",
            now(),
            order.id
          );
        } else if (b.action === 'cancel') {
          ensure(
            !['claimed', 'submitted', 'printed', 'cancelled'].includes(order.status),
            'This request has already reached the printer or is closed.'
          );
          await run(
            env,
            "UPDATE orders SET status = 'cancelled', updated = ? WHERE id = ? AND status NOT IN ('claimed','submitted','printed','cancelled')",
            now(),
            order.id
          );
        } else if (b.action === 'recover') {
          ensure(
            order.status === 'claimed' && now() - order.updated > 120000,
            'Only interrupted claims older than 2 minutes can be recovered.'
          );
          ensure(b.confirmed === true, 'Check physical output and stop the agent first.');
          await run(
            env,
            "UPDATE orders SET status = 'failed', error = 'Operator resolved an interrupted claim. Verify paper and Windows queue before retry.', updated = ? WHERE id = ? AND status = 'claimed'",
            now(),
            order.id
          );
        } else if (b.action === 'retry') {
          ensure(order.status === 'failed', 'Only failed requests can be retried.');
          ensure(order.file, 'Document expired.');
          ensure(b.confirmed === true, 'Check paper and Windows queue before retrying.');
          await run(
            env,
            "UPDATE orders SET status = 'queued', claim = NULL, error = NULL, updated = ? WHERE id = ? AND status = 'failed'",
            now(),
            order.id
          );
        } else if (b.action === 'manual-duplex-done') {
          ensure(order.status === 'manual_duplex', 'Request is not awaiting manual duplex.');
          ensure(order.payment === 'paid', 'Payment not verified.');
          ensure(
            order.file && order.created > now() - (await settings(env)).retentionHours * 3600000,
            'Document expired.',
            410
          );
          ensure(b.confirmed === true, 'Confirm paper output for manual duplex.');
          await run(
            env,
            "UPDATE orders SET status = 'printed', updated = ? WHERE id = ? AND status = 'manual_duplex'",
            now(),
            order.id
          );
          await event(env, order.id, 'Manual duplex completed by operator');
        } else ensure(false, 'Unknown action.');
        await event(env, order.id, 'Operator: ' + b.action);
        return json({ ok: true });
      }
      if (p === '/api/admin/cleanup' && req.method === 'POST')
        return json({ removed: await cleanup(env) });
      if (p === '/api/admin/payment-qr' && req.method === 'POST') {
        const form = await req.formData();
        const image = await validateQrImage(form.get('file'));
        const key = id() + '.' + image.extension;
        await env.BUCKET.put('payment-qr/' + key, image.bytes, {
          httpMetadata: { contentType: image.extension === 'png' ? 'image/png' : 'image/jpeg' },
        });
        return json({ qr: key });
      }
      if (p === '/api/admin/test-print' && req.method === 'POST') {
        const s = await settings(env);
        ensure(s.mapping.bw, 'Map a B&W printer first.');
        ensure(
          await one(
            env,
            "SELECT id FROM agents WHERE seen > ? AND mode = 'live' LIMIT 1",
            now() - 35000
          ),
          'Enable the Windows agent in Live mode first.'
        );
        const orderId = id(),
          token = id() + id().replaceAll('-', ''),
          file = 'jobs/' + orderId + '.pdf',
          time = now();
        const options = {
          service: 'document',
          color: 'bw',
          paper: 'A4',
          copies: 1,
          range: '',
          orientation: 'portrait',
          duplex: false,
          method: 'cash',
          mobile: '',
          synthetic: true,
        };
        await env.BUCKET.put(file, await testPage(s.shopName));
        await run(
          env,
          'INSERT INTO orders (id,token,created,updated,names,options,pages,amount,method,payment,status,file) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          orderId,
          token,
          time,
          time,
          '["SHRI-Print-Test.pdf"]',
          JSON.stringify(options),
          1,
          0,
          'cash',
          'paid',
          'queued',
          file
        );
        return json({ ok: true, token });
      }
      if (p === '/api/admin/credentials' && req.method === 'GET')
        return json({ server: u.origin, token: env.AGENT_TOKEN, interval: 3000, mode: 'dry-run' });
    }
    if (p.startsWith('/api/agent/')) {
      ensure(agent(req, env), 'Agent authentication failed.', 401);
      if (p === '/api/agent/heartbeat' && req.method === 'POST') {
        const b = await req.json();
        ensure(
          typeof b.id === 'string' &&
            b.id.length <= 80 &&
            Array.isArray(b.printers) &&
            b.printers.length <= 200,
          'Invalid agent heartbeat.'
        );
        await run(
          env,
          'INSERT INTO agents (id,seen,inventory,mode) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET seen = excluded.seen, inventory = excluded.inventory, mode = excluded.mode',
          b.id,
          now(),
          JSON.stringify(b.printers).slice(0, 50000),
          b.mode === 'live' ? 'live' : 'dry-run'
        );
        if (now() - lastCleanup > 3600000) {
          await cleanup(env);
          lastCleanup = now();
        }
        return json({ ok: true });
      }
      if (p === '/api/agent/claim' && req.method === 'POST') {
        const b = await req.json();
        ensure(b.mode === 'live', 'Dry-run agents do not consume real print requests.');
        const candidates = await all(
          env,
          "SELECT * FROM orders WHERE status = 'queued' AND file != '' ORDER BY created LIMIT 20"
        );
        const s = await settings(env);
        for (const o of candidates) {
          const options = JSON.parse(o.options),
            printer = await one(
              env,
              'SELECT * FROM printers WHERE id = ?',
              s.mapping[options.color]
            );
          if (!printer) continue;
          const claim = id();
          const r = await run(
            env,
            "UPDATE orders SET status = 'claimed', claim = ?, printer = ?, updated = ? WHERE id = ? AND status = 'queued'",
            claim,
            printer.name,
            now(),
            o.id
          );
          if (r.meta.changes)
            return json({
              job: { ...o, status: 'claimed', claim, printer: printer.name, options },
              download: '/api/agent/file/' + o.id,
            });
        }
        return json({ job: null });
      }
      const fm = p.match(/^\/api\/agent\/file\/([a-f0-9-]+)$/);
      if (fm) {
        const o = await one(env, 'SELECT * FROM orders WHERE id = ?', fm[1]);
        ensure(o && o.file && o.status === 'claimed', 'Print file unavailable.', 404);
        ensure(safeEqual(req.headers.get('x-claim'), o.claim), 'Invalid job lease.', 403);
        const file = await env.BUCKET.get(o.file);
        ensure(file, 'Document expired.', 410);
        return new Response(file.body, {
          headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store' },
        });
      }
      const rm = p.match(/^\/api\/agent\/result\/([a-f0-9-]+)$/);
      if (rm && req.method === 'POST') {
        const b = await req.json();
        ensure(['submitted', 'failed'].includes(b.status), 'Invalid agent result.');
        const o = await one(env, 'SELECT * FROM orders WHERE id = ?', rm[1]);
        ensure(o && safeEqual(b.claim, o.claim), 'Invalid job lease.', 403);
        if (o.status === b.status) return json({ ok: true });
        ensure(o.status === 'claimed', 'Print request is already closed.', 409);
        await run(
          env,
          "UPDATE orders SET status = ?, error = ?, updated = ? WHERE id = ? AND status = 'claimed' AND claim = ?",
          b.status,
          String(b.error || '').slice(0, 500) || null,
          now(),
          o.id,
          b.claim
        );
        await event(env, o.id, 'Windows agent: ' + b.status);
        return json({ ok: true });
      }
    }
    return json({ error: 'Not found' }, 404);
  } catch (e) {
    return json(
      { error: e.status ? e.message : 'Server could not complete the request. Please try again.' },
      e.status || 500
    );
  }
}
export default {
  fetch: handler,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanup(env));
  },
};
