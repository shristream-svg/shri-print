import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defaults, hmac, quote, validateSettings } from '../lib/core.js';
import { storage } from '../local/storage.mjs';
import { cleanup, handler } from '../worker/app.js';
const { PDFDocument } = createRequire(new URL('../package.json', import.meta.url))('pdf-lib');

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'shri-v3-audit-'));
  const store = await storage(root);
  const env = {
    ...store,
    CUSTOMER_PAYMENT_POLICY: 'legacy',
    ADMIN_TOKEN: 'audit-admin',
    AGENT_TOKEN: 'audit-agent',
    RAZORPAY_KEY_ID: 'rzp_test_audit',
    RAZORPAY_KEY_SECRET: 'audit-secret',
    RAZORPAY_WEBHOOK_SECRET: 'audit-hook',
  };
  const ip = crypto.randomUUID();
  async function call(path, body, role = '', extra = {}) {
    const headers = { 'x-shri-client': ip, ...extra };
    if (role)
      headers.Authorization = 'Bearer ' + (role === 'admin' ? env.ADMIN_TOKEN : env.AGENT_TOKEN);
    if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const response = await handler(
      new Request('http://localhost' + path, {
        method: body ? 'POST' : 'GET',
        headers,
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      }),
      env
    );
    const data = await response.json();
    return { status: response.status, data };
  }
  async function setting(extra = {}) {
    const result = await call(
      '/api/admin/settings',
      { ...structuredClone(defaults), online: true, ...extra },
      'admin'
    );
    assert.equal(result.status, 200, JSON.stringify(result.data));
  }
  async function create(extra = {}) {
    const doc = await PDFDocument.create();
    doc.addPage().drawText('SYNTHETIC AUDIT PAGE 1');
    doc.addPage().drawText('SYNTHETIC AUDIT PAGE 2');
    const form = new FormData();
    form.append('files', new File([await doc.save()], 'audit.pdf', { type: 'application/pdf' }));
    form.append(
      'options',
      JSON.stringify({
        service: 'document',
        color: 'bw',
        copies: 1,
        paper: 'A4',
        duplex: false,
        orientation: 'portrait',
        range: '',
        method: 'cash',
        ...extra,
      })
    );
    const result = await call('/api/orders', form);
    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.ok(result.data.token);
    const row = await store.DB.prepare('SELECT id FROM orders WHERE token=?')
      .bind(result.data.token)
      .first();
    return { ...result.data, id: row.id };
  }
  try {
    await fn({ call, setting, create, env, store });
  } finally {
    store.db.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('audit: hosted payment freezes trusted link and never queues on self-report', () =>
  fixture(async ({ call, setting, create }) => {
    const link = 'https://razorpay.me/@synthetic-audit';
    await setting({ hostedPaymentUrl: link });
    const config = await call('/api/config');
    assert.equal(config.data.hostedPaymentUrl, link);
    assert.equal(config.data.upiAvailable, true);
    const order = await create({
      method: 'upi',
      paymentChannel: 'razorpay_link',
      hostedPaymentUrl: 'https://evil.invalid',
    });
    assert.equal(order.amount, 600);
    assert.equal(order.options.hostedPaymentUrl, link);
    await setting({ hostedPaymentUrl: 'https://razorpay.me/@changed-audit' });
    assert.equal((await call('/api/orders/' + order.token)).data.options.hostedPaymentUrl, link);
    assert.equal(
      (await call('/api/orders/' + order.token + '/confirm', {})).data.status,
      'awaiting_payment'
    );
    assert.equal((await call('/api/orders/' + order.token + '/upi-sent', {})).status, 200);
    const after = (await call('/api/orders/' + order.token)).data;
    assert.equal(after.payment, 'reported');
    assert.equal(after.status, 'awaiting_payment');
    const invalid = await call(
      '/api/admin/settings',
      { ...structuredClone(defaults), hostedPaymentUrl: 'https://razorpay.me.evil.invalid/@fake' },
      'admin'
    );
    assert.equal(invalid.status, 400);
  }));

test('audit: visits survive cleanup and admin sees updated file details without public access', () =>
  fixture(async ({ call, store, env }) => {
    const id = crypto.randomUUID();
    const visit = {
      id,
      service: 'document',
      stage: 'upload',
      files: [{ name: 'audit.pdf', size: 100, pages: 2 }],
      options: { copies: 1, color: 'bw', paper: 'A4', duplex: false, method: 'cash' },
    };
    assert.equal((await call('/api/visits', visit)).status, 200);
    assert.equal((await call('/api/admin/live?after=0')).status, 401);
    await cleanup(env);
    const live = await call('/api/admin/live?after=0', null, 'admin');
    assert.equal(live.status, 200);
    assert.ok(live.data.now > 0);
    const v = live.data.visits.find(v => v.id === id);
    assert.ok(v, 'Fresh visit must survive JSON timestamp cleanup');
    assert.equal(v.files[0].pages, 2);
    assert.equal(
      (
        await call('/api/visits', {
          ...visit,
          options: { ...visit.options, secret: 'x'.repeat(25000) },
        })
      ).status,
      413
    );
    await store.DB.prepare('UPDATE settings SET value=? WHERE id=?')
      .bind(JSON.stringify({ ...visit, updated: Date.now() - 700000 }), 'visit:' + id)
      .run();
    await cleanup(env);
    assert.equal(
      (await call('/api/admin/live?after=0', null, 'admin')).data.visits.some(v => v.id === id),
      false
    );
  }));

test('audit: manual duplex remains unpaid until receipt and cancelled late capture cannot revive it', () =>
  fixture(async ({ call, setting, create, store, env }) => {
    await setting();
    const order = await create({ duplex: true, method: 'online', manualDuplex: false });
    assert.equal(order.amount, 500);
    assert.equal(order.options.manualDuplex, true);
    const confirmed = await call('/api/orders/' + order.token + '/confirm', {});
    assert.equal(confirmed.data.status, 'awaiting_payment');
    assert.notEqual(confirmed.data.payment, 'paid');
    await store.DB.prepare('UPDATE orders SET gateway=? WHERE id=?')
      .bind('order_audit_gateway', order.id)
      .run();
    assert.equal(
      (await call('/api/admin/orders/' + order.id, { action: 'cancel' }, 'admin')).status,
      200
    );
    const payload = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_audit',
            order_id: 'order_audit_gateway',
            amount: 500,
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    };
    const body = JSON.stringify(payload),
      signature = await hmac(env.RAZORPAY_WEBHOOK_SECRET, body);
    const r = await handler(
      new Request('http://localhost/api/payments/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signature },
        body,
      }),
      env
    );
    assert.equal(r.status, 200);
    const after = (await call('/api/orders/' + order.token)).data;
    assert.equal(after.payment, 'paid');
    assert.equal(after.status, 'cancelled');
  }));

test('audit: color pricing and legacy settings remain valid', () => {
  assert.equal(
    quote(
      2,
      { service: 'document', color: 'color', copies: 1, paper: 'A4', duplex: true },
      defaults
    ),
    1600
  );
  for (const count of [-1, 0, 1.5, NaN])
    assert.throws(() =>
      quote(
        count,
        { service: 'document', color: 'bw', copies: 1, paper: 'A4', duplex: true },
        defaults
      )
    );
  const legacy = structuredClone(defaults);
  delete legacy.duplexSheetPrice;
  delete legacy.hostedPaymentUrl;
  assert.doesNotThrow(() => validateSettings(legacy));
});

test('v4: cash confirmation never trusts saved cashAuto and rejects new online requests', () =>
  fixture(async ({ call, setting, create, env }) => {
    env.CUSTOMER_PAYMENT_POLICY = 'cash';
    await setting({ cashAuto: true });
    const o = await create();
    const c = await call('/api/orders/' + o.token + '/confirm', {});
    assert.equal(c.data.payment, 'pending');
    assert.equal(c.data.status, 'awaiting_approval');
    await assert.rejects(() => create({ method: 'online' }));
  }));

test('cash_received needs admin, queues once, and keeps duplex held', () =>
  fixture(async ({ call, create, store }) => {
    const o = await create({ duplex: true, manualDuplex: false });
    await call('/api/orders/' + o.token + '/confirm', {});
    assert.equal(
      (await call('/api/admin/orders/' + o.id, { action: 'cash_received' })).status,
      401
    );
    assert.equal(
      (await call('/api/admin/orders/' + o.id, { action: 'cash_received' }, 'admin')).status,
      200
    );
    assert.equal(
      (await call('/api/admin/orders/' + o.id, { action: 'cash_received' }, 'admin')).status,
      200
    );
    const row = await store.DB.prepare('SELECT * FROM orders WHERE id=?').bind(o.id).first();
    assert.equal(row.payment, 'paid');
    assert.equal(row.status, 'manual_duplex');
    assert.equal(
      (
        await store.DB.prepare(
          "SELECT count(*) AS n FROM events WHERE order_id=? AND action='Operator: cash_received'"
        )
          .bind(o.id)
          .first()
      ).n,
      1
    );
  }));
test('adjust reprices same order with strict CAS and cannot alter paid request', () =>
  fixture(async ({ call, create, store }) => {
    const o = await create();
    await call('/api/orders/' + o.token + '/confirm', {});
    const before = (await call('/api/orders/' + o.token)).data;
    const r = await call(
      '/api/admin/orders/' + o.id,
      { action: 'adjust', version: before.version, options: { copies: 2, duplex: true } },
      'admin'
    );
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.order.id, o.id);
    assert.equal(r.data.order.token, o.token);
    assert.equal(r.data.order.amount, 1000);
    assert.equal(r.data.order.options.manualDuplex, true);
    assert.equal(r.data.order.status, 'awaiting_approval');
    assert.equal((await store.DB.prepare('SELECT count(*) AS n FROM orders').first()).n, 1);
    assert.notEqual(r.data.order.version, before.version);
    assert.equal(
      (
        await call(
          '/api/admin/orders/' + o.id,
          { action: 'adjust', version: before.version, options: { copies: 3 } },
          'admin'
        )
      ).status,
      409
    );
    assert.equal(
      (
        await call(
          '/api/admin/orders/' + o.id,
          { action: 'adjust', version: r.data.order.version, options: { service: 'resume' } },
          'admin'
        )
      ).status,
      400
    );
    await call('/api/admin/orders/' + o.id, { action: 'cash_received' }, 'admin');
    assert.equal(
      (
        await call(
          '/api/admin/orders/' + o.id,
          { action: 'adjust', version: r.data.order.version, options: { copies: 3 } },
          'admin'
        )
      ).status,
      409
    );
  }));
test('concurrent adjust versus cash cannot overwrite paid state', () =>
  fixture(async ({ call, create, store }) => {
    const o = await create();
    await call('/api/orders/' + o.token + '/confirm', {});
    const version = (await call('/api/orders/' + o.token)).data.version;
    const results = await Promise.all([
      call(
        '/api/admin/orders/' + o.id,
        { action: 'adjust', version, options: { copies: 3 } },
        'admin'
      ),
      call('/api/admin/orders/' + o.id, { action: 'cash_received' }, 'admin'),
    ]);
    assert.ok(results.every(r => [200, 409].includes(r.status)));
    const row = await store.DB.prepare('SELECT * FROM orders WHERE id=?').bind(o.id).first();
    assert.equal(row.amount, quote(row.pages, JSON.parse(row.options), defaults));
    assert.equal((await store.DB.prepare('SELECT count(*) AS n FROM orders').first()).n, 1);
  }));
test('resume fixedRs30 server quote and copyduplex restrictions', () =>
  fixture(async ({ create }) => {
    assert.equal((await create({ service: 'resume' })).amount, 3000);
    await assert.rejects(() => create({ service: 'resume', copies: 2 }));
    await assert.rejects(() => create({ service: 'resume', duplex: true }));
  }));
test('local spoofed metadata cannot appear in public order or admin IP', () =>
  fixture(async ({ create, store, env }) => {
    env.LOCAL_SERVER = true;
    const o = await create({ customerMetadata: { ip: 'forged' } });
    assert.equal(o.options.customerMetadata, undefined);
    const opts = JSON.parse(
      (await store.DB.prepare('SELECT options FROM orders WHERE id=?').bind(o.id).first()).options
    );
    assert.equal(opts.customerMetadata.ip, null);
    assert.equal(opts.customerMetadata.source, 'unavailable/local');
  }));

test('ID originals stay private; recrop replaces same unpaid order with CAS and expires originals', () =>
  fixture(async ({ call, store, env }) => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD2kAAAAASUVORK5CYII=',
      'base64'
    );
    const form = new FormData();
    for (let i = 0; i < 2; i++) {
      form.append('files', new File([png], 'corrected-' + i + '.png', { type: 'image/png' }));
      form.append('originals', new File([png], 'original-' + i + '.png', { type: 'image/png' }));
    }
    form.append(
      'options',
      JSON.stringify({
        service: 'id',
        color: 'bw',
        copies: 1,
        paper: 'A4',
        duplex: false,
        orientation: 'portrait',
        range: '',
        method: 'cash',
        idFormat: 'plastic',
      })
    );
    const created = await call('/api/orders', form);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const o = created.data;
    assert.equal(o.options.idOriginals, undefined);
    assert.equal(o.options.customerMetadata, undefined);
    const row = await store.DB.prepare('SELECT * FROM orders WHERE id=?').bind(o.id).first(),
      originals = JSON.parse(row.options).idOriginals;
    assert.equal(originals.length, 2);
    const getOriginal = role =>
      handler(
        new Request('http://localhost/api/admin/orders/' + o.id + '/original/0', {
          headers: role ? { Authorization: 'Bearer ' + env.ADMIN_TOKEN } : {},
        }),
        env
      );
    assert.equal((await getOriginal(false)).status, 401);
    const raw = await getOriginal(true);
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get('cache-control'), 'no-store');
    assert.deepEqual(new Uint8Array(await raw.arrayBuffer()), new Uint8Array(png));
    const recrop = version => {
      const f = new FormData();
      for (let i = 0; i < 2; i++)
        f.append('files', new File([png], 'recrop-' + i + '.png', { type: 'image/png' }));
      f.append('version', version);
      return call('/api/admin/orders/' + o.id + '/recrop', f, 'admin');
    };
    const changed = await recrop(o.version);
    assert.equal(changed.status, 200, JSON.stringify(changed.data));
    assert.equal(changed.data.order.id, o.id);
    assert.equal(changed.data.order.amount, o.amount);
    assert.notEqual(changed.data.order.version, o.version);
    assert.equal(await store.BUCKET.get(row.file), null);
    assert.equal((await recrop(o.version)).status, 409);
    assert.equal((await store.DB.prepare('SELECT count(*) AS n FROM orders').first()).n, 1);
    await store.DB.prepare('UPDATE orders SET created=? WHERE id=?')
      .bind(Date.now() - 25 * 3600000, o.id)
      .run();
    await cleanup(env);
    assert.equal(await store.BUCKET.get(originals[0].key), null);
    assert.equal((await getOriginal(true)).status, 410);
  }));

test('edge IP derives from platform context and never public headers alone', () =>
  fixture(async ({ call, env }) => {
    const visit = {
      id: crypto.randomUUID(),
      service: 'document',
      stage: 'upload',
      files: [],
      options: {},
    };
    const make = cf => {
      const req = new Request('http://localhost/api/visits', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'cf-connecting-ip': '203.0.113.99',
          'x-forwarded-for': 'spoof',
          'user-agent': 'Mozilla Android',
        },
        body: JSON.stringify(visit),
      });
      if (cf) Object.defineProperty(req, 'cf', { value: { country: 'IN' } });
      return req;
    };
    assert.equal((await handler(make(false), env)).status, 200);
    let v = (await call('/api/admin/live?after=0', null, 'admin')).data.visits.find(
      v => v.id === visit.id
    );
    assert.equal(v.customerMetadata.ip, null);
    assert.equal((await handler(make(true), env)).status, 200);
    v = (await call('/api/admin/live?after=0', null, 'admin')).data.visits.find(
      v => v.id === visit.id
    );
    assert.equal(v.customerMetadata.ip, '203.0.113.99');
    assert.equal(v.customerMetadata.city, undefined);
    assert.match(v.customerMetadata.device, /reported/);
    env.LOCAL_SERVER = true;
    await handler(make(true), env);
    v = (await call('/api/admin/live?after=0', null, 'admin')).data.visits.find(
      v => v.id === visit.id
    );
    assert.equal(v.customerMetadata.ip, null);
  }));

test('all source files have private manifest, original download and rebuild restores excluded pages', () =>
  fixture(async ({ call, create, store, env }) => {
    const o = await create({ range: '1' });
    assert.equal(o.pages, 1);
    assert.equal(o.options.uploadManifest, undefined);
    assert.equal(o.options.sourceFiles, undefined);
    const row = await store.DB.prepare('SELECT * FROM orders WHERE id=?').bind(o.id).first(),
      opts = JSON.parse(row.options);
    assert.equal(opts.uploadManifest[0].name, 'audit.pdf');
    assert.equal(opts.uploadManifest[0].pages, 2);
    assert.ok(opts.uploadManifest[0].size > 0);
    assert.ok(opts.uploadManifest[0].receivedAt >= row.created);
    const raw = await handler(
      new Request('http://localhost/api/admin/orders/' + o.id + '/original/0', {
        headers: { Authorization: 'Bearer ' + env.ADMIN_TOKEN },
      }),
      env
    );
    assert.equal(raw.status, 200);
    assert.equal((await PDFDocument.load(await raw.arrayBuffer())).getPageCount(), 2);
    const r = await call(
      '/api/admin/orders/' + o.id,
      {
        action: 'adjust',
        version: o.version,
        options: { range: '', paper: 'A3', orientation: 'landscape', rotation: 90 },
      },
      'admin'
    );
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.order.pages, 2);
    assert.equal(r.data.order.amount, 1200);
    const changed = await store.DB.prepare('SELECT * FROM orders WHERE id=?').bind(o.id).first(),
      object = await store.BUCKET.get(changed.file),
      pdf = await PDFDocument.load(object.body);
    assert.equal(pdf.getPageCount(), 2);
    assert.ok(Math.abs(pdf.getPage(0).getWidth() - (420 * 72) / 25.4) < 0.01);
    assert.ok(Math.abs(pdf.getPage(0).getHeight() - (297 * 72) / 25.4) < 0.01);
    await store.DB.prepare('UPDATE orders SET created=? WHERE id=?')
      .bind(Date.now() - 25 * 3600000, o.id)
      .run();
    await cleanup(env);
    assert.equal(await store.BUCKET.get(opts.sourceFiles[0].key), null);
  }));

test('paid queued job must be held before source edit, total cannot change, release is CAS', () =>
  fixture(async ({ call, create, store }) => {
    const o = await create();
    await call('/api/orders/' + o.token + '/confirm', {});
    await call('/api/admin/orders/' + o.id, { action: 'cash_received' }, 'admin');
    let current = (await call('/api/orders/' + o.token)).data;
    assert.equal(
      (
        await call(
          '/api/admin/orders/' + o.id,
          { action: 'adjust', version: current.version, options: { rotation: 90 } },
          'admin'
        )
      ).status,
      409
    );
    const held = await call(
      '/api/admin/orders/' + o.id,
      { action: 'hold', version: current.version },
      'admin'
    );
    assert.equal(held.status, 200);
    assert.equal(held.data.order.status, 'held');
    current = held.data.order;
    assert.equal(
      (
        await call(
          '/api/admin/orders/' + o.id,
          { action: 'adjust', version: current.version, options: { copies: 2 } },
          'admin'
        )
      ).status,
      409
    );
    const edit = await call(
      '/api/admin/orders/' + o.id,
      {
        action: 'adjust',
        version: current.version,
        options: { orientation: 'landscape', rotation: 90 },
      },
      'admin'
    );
    assert.equal(edit.status, 200, JSON.stringify(edit.data));
    assert.equal(edit.data.order.status, 'held');
    assert.equal(edit.data.order.amount, o.amount);
    assert.equal(
      (
        await call(
          '/api/admin/orders/' + o.id,
          { action: 'release', version: current.version },
          'admin'
        )
      ).status,
      409
    );
    const released = await call(
      '/api/admin/orders/' + o.id,
      { action: 'release', version: edit.data.order.version },
      'admin'
    );
    assert.equal(released.status, 200);
    assert.equal(released.data.order.status, 'queued');
    assert.equal(
      (
        await call(
          '/api/admin/orders/' + o.id,
          { action: 'release', version: edit.data.order.version },
          'admin'
        )
      ).status,
      409
    );
  }));

test('agent claim racing HOLD permits one winner and held jobs cannot be claimed', () =>
  fixture(async ({ call, create, store }) => {
    const printer = crypto.randomUUID();
    await store.DB.prepare(
      'INSERT INTO printers(id,name,brand,model,capability,connection) VALUES(?,?,?,?,?,?)'
    )
      .bind(printer, 'SYNTHETIC PRINTER', 'TEST', 'TEST', 'bw', 'USB')
      .run();
    await call(
      '/api/admin/settings',
      { ...structuredClone(defaults), mapping: { bw: printer, color: '' } },
      'admin'
    );
    const o = await create();
    await call('/api/orders/' + o.token + '/confirm', {});
    await call('/api/admin/orders/' + o.id, { action: 'cash_received' }, 'admin');
    const current = (await call('/api/orders/' + o.token)).data;
    const [hold, claim] = await Promise.all([
      call('/api/admin/orders/' + o.id, { action: 'hold', version: current.version }, 'admin'),
      call('/api/agent/claim', { mode: 'live' }, 'agent'),
    ]);
    const row = await store.DB.prepare('SELECT * FROM orders WHERE id=?').bind(o.id).first();
    if (row.status === 'held') {
      assert.equal(hold.status, 200);
      assert.equal(claim.data.job, null);
      assert.equal((await call('/api/agent/claim', { mode: 'live' }, 'agent')).data.job, null);
    } else {
      assert.equal(row.status, 'claimed');
      assert.equal(hold.status, 409);
      assert.equal(claim.data.job.id, o.id);
      assert.equal(
        (
          await call(
            '/api/admin/orders/' + o.id,
            { action: 'hold', version: String(row.updated) },
            'admin'
          )
        ).status,
        409
      );
    }
  }));

test('operator contact edits normalize details, reject malformed values and preserve source metadata', () =>
  fixture(async ({ call, create, store }) => {
    const o = await create();
    const before = JSON.parse(
      (await store.DB.prepare('SELECT options FROM orders WHERE id=?').bind(o.id).first()).options
    );
    const edited = await call(
      '/api/admin/orders/' + o.id,
      {
        action: 'adjust',
        version: o.version,
        options: {
          customerName: '  Synthetic Customer  ',
          mobile: ' 9999999999 ',
          notes: '  Two copies please  ',
        },
      },
      'admin'
    );
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    assert.equal(edited.data.order.options.customerName, 'Synthetic Customer');
    assert.equal(edited.data.order.options.mobile, '9999999999');
    assert.equal(edited.data.order.options.notes, 'Two copies please');
    assert.equal(edited.data.order.amount, o.amount);
    const after = JSON.parse(
      (await store.DB.prepare('SELECT options FROM orders WHERE id=?').bind(o.id).first()).options
    );
    assert.deepEqual(after.customerMetadata, before.customerMetadata);
    assert.deepEqual(after.uploadManifest, before.uploadManifest);
    for (const options of [
      { customerName: 'x'.repeat(81) },
      { notes: 'x'.repeat(301) },
      { mobile: '123' },
      { mobile: 9999999999 },
      { customerName: { value: 'x' } },
      { customerMetadata: { ip: 'spoof' } },
    ])
      assert.equal(
        (
          await call(
            '/api/admin/orders/' + o.id,
            { action: 'adjust', version: edited.data.order.version, options },
            'admin'
          )
        ).status,
        400,
        JSON.stringify(options)
      );
    const final = (await call('/api/orders/' + o.token)).data;
    assert.equal(final.options.mobile, '9999999999');
    assert.equal(final.version, edited.data.order.version);
  }));

test('customer cannot confirm a stale preview after operator adjustment, latest version can confirm', () =>
  fixture(async ({ call, create }) => {
    const o = await create(),
      edited = await call(
        '/api/admin/orders/' + o.id,
        { action: 'adjust', version: o.version, options: { copies: 2 } },
        'admin'
      );
    assert.equal(edited.status, 200);
    assert.notEqual(edited.data.order.version, o.version);
    const stale = await call('/api/orders/' + o.token + '/confirm', { version: o.version });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.order.status, 'draft');
    assert.equal(stale.data.order.amount, 1200);
    assert.equal(stale.data.order.version, edited.data.order.version);
    const current = (await call('/api/orders/' + o.token)).data;
    assert.equal(current.status, 'draft');
    const confirmed = await call('/api/orders/' + o.token + '/confirm', {
      version: current.version,
    });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.data.status, 'awaiting_approval');
    assert.equal(confirmed.data.payment, 'pending');
    assert.equal(confirmed.data.amount, 1200);
    const legacy = await create();
    assert.equal((await call('/api/orders/' + legacy.token + '/confirm', {})).status, 200);
  }));
