import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PDFArray, PDFDocument, decodePDFRawStream } from 'pdf-lib';
import { printArgs } from '../agent/engine.mjs';
import {
  defaults,
  hmac,
  parsePages,
  photoPackagePrice,
  progressivePrice,
  quote,
  validateOptions,
  validateSettings,
} from '../lib/core.js';
import { prepareDocuments } from '../lib/documents.js';
import {
  verifyPaymentCapture,
  verifyPaymentVerification,
  verifyWebhookSignature,
} from '../lib/payment.js';
import { storage } from '../local/storage.mjs';
import { cleanup, handler } from '../worker/app.js';
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
};
let pdfBytes;
const doc = await PDFDocument.create();
for (let i = 0; i < 12; i++) doc.addPage().drawText('SHRI PRINT SYNTHETIC TEST ' + (i + 1));
pdfBytes = await doc.save();
test('strict page ranges, deduplication and ascending order', () => {
  assert.deepEqual(parsePages('3,1-3,5', 5), [1, 2, 3, 5]);
  assert.equal(parsePages('', 12).length, 12);
  for (const range of ['1,', '0', '3-1', '1-99', '1-2-3', 'x', '-1', '1.5'])
    assert.throws(() => parsePages(range, 12));
});
test('progressive tier boundaries, copies and paper multipliers', () => {
  assert.equal(progressivePrice(1, [300, 250, 200]), 300);
  assert.equal(progressivePrice(2, [300, 250, 200]), 550);
  assert.equal(progressivePrice(10, [300, 250, 200]), 2550);
  assert.equal(progressivePrice(11, [300, 250, 200]), 2750);
  assert.equal(
    quote(
      6,
      { ...options, copies: 2, paper: 'A3' },
      { ...defaults, rates: { bw: [300, 250, 200] } }
    ),
    5900
  );
});
test('server selects actual PDF pages and rejects encrypted/garbage files', async () => {
  const out = await prepareDocuments([new File([pdfBytes], 'test.pdf')], {
    ...options,
    range: '12,2-3',
  });
  assert.equal(out.pages, 3);
  assert.deepEqual(out.selected, [2, 3, 12]);
  assert.equal((await PDFDocument.load(out.bytes)).getPageCount(), 3);
  await assert.rejects(() => prepareDocuments([new File(['garbage'], 'x.pdf')], options));
  await assert.rejects(() =>
    prepareDocuments([new File([pdfBytes], 'x.pdf')], {
      ...options,
      copies: 101,
    })
  );
});
test('passport and ID sheets are exactly one A4 page', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD2kAAAAASUVORK5CYII=',
    'base64'
  );
  for (const service of ['passport', 'id']) {
    const files = Array.from(
      { length: service === 'id' ? 2 : 1 },
      () => new File([png], 'fixture.png')
    );
    const opts = { ...options, service };
    if (service === 'passport') {
      opts.photoQty = 5;
      opts.color = 'color';
      opts.paper = 'A4';
      opts.orientation = 'portrait';
      opts.duplex = false;
    }
    const out = await prepareDocuments(files, opts);
    const pdf = await PDFDocument.load(out.bytes);
    assert.equal(pdf.getPageCount(), 1);
    assert.ok(Math.abs(pdf.getPage(0).getWidth() - 595.276) < 0.01);
  }
});
test('engine uses exact printer argument and selected print options without shell interpolation', () => {
  const args = printArgs(
    {
      printer: 'Epson " ; arbitrary',
      options: { ...options, copies: 2, color: 'color', duplex: true },
    },
    'C:\\test.pdf'
  );
  assert.equal(args[1], 'Epson " ; arbitrary');
  assert.match(args[3], /2x,color,duplexlong/);
  assert.ok(args.includes('-silent'));
});

test('payment module verifies webhook signature', async () => {
  const secret = 'test-webhook-secret';
  const raw = JSON.stringify({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: 'pay_test',
          order_id: 'order_test',
          amount: 600,
          currency: 'INR',
          status: 'captured',
        },
      },
    },
  });
  const sig = await hmac(secret, raw);
  await verifyWebhookSignature(raw, sig, secret);
  await assert.rejects(
    () => verifyWebhookSignature(raw, 'invalid', secret),
    /Invalid webhook signature/
  );
  await assert.rejects(
    () => verifyWebhookSignature('{}', sig, secret),
    /Invalid webhook signature/
  );
});

test('payment module verifies payment verification signature', async () => {
  const secret = 'test-razorpay-secret';
  const order = { gateway: 'order_test', amount: 600, currency: 'INR' };
  const b = {
    razorpay_order_id: 'order_test',
    razorpay_payment_id: 'pay_test',
    razorpay_signature: await hmac(secret, 'order_test|pay_test'),
  };
  await verifyPaymentVerification(order, b, secret);
  await assert.rejects(
    () => verifyPaymentVerification({ ...order, gateway: 'other' }, b, secret),
    /order ID mismatch/
  );
  await assert.rejects(
    () => verifyPaymentVerification(order, { ...b, razorpay_signature: 'bad' }, secret),
    /Payment signature is invalid/
  );
});

test('payment module verifies exact capture amount/currency/status', () => {
  const order = { gateway: 'order_test', amount: 600, currency: 'INR' };
  verifyPaymentCapture(
    {
      order_id: 'order_test',
      amount: 600,
      currency: 'INR',
      status: 'captured',
    },
    order
  );
  assert.throws(
    () =>
      verifyPaymentCapture(
        {
          order_id: 'order_test',
          amount: 500,
          currency: 'INR',
          status: 'captured',
        },
        order
      ),
    /amount does not match/
  );
  assert.throws(
    () =>
      verifyPaymentCapture(
        {
          order_id: 'order_test',
          amount: 600,
          currency: 'USD',
          status: 'captured',
        },
        order
      ),
    /currency does not match/
  );
  assert.throws(
    () =>
      verifyPaymentCapture(
        {
          order_id: 'order_test',
          amount: 600,
          currency: 'INR',
          status: 'authorized',
        },
        order
      ),
    /not captured/
  );
  assert.throws(
    () =>
      verifyPaymentCapture(
        { order_id: 'other', amount: 600, currency: 'INR', status: 'captured' },
        order
      ),
    /order ID does not match/
  );
});

test('complete queue, access, payment and recovery lifecycle', async t => {
  const root = await mkdtemp(join(tmpdir(), 'shri-print-test-'));
  const store = await storage(root);
  const env = {
    ...store,
    CUSTOMER_PAYMENT_POLICY: 'legacy',
    ADMIN_TOKEN: 'test-admin',
    AGENT_TOKEN: 'test-agent',
    RAZORPAY_KEY_ID: 'rzp_test_fixture',
    RAZORPAY_KEY_SECRET: 'test-secret',
    RAZORPAY_WEBHOOK_SECRET: 'test-webhook',
  };
  let seq = 0;
  async function call(path, body, role = '', method) {
    const headers = {};
    if (role)
      headers.Authorization = 'Bearer ' + (role === 'admin' ? env.ADMIN_TOKEN : env.AGENT_TOKEN);
    if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const r = await handler(
      new Request('http://localhost' + path, {
        method: method || (body ? 'POST' : 'GET'),
        headers,
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      }),
      env
    );
    let data;
    try {
      data = await r.json();
    } catch {}
    return { r, data };
  }
  async function order(extra = {}) {
    const f = new FormData();
    f.append('files', new File([pdfBytes], 'SYNTHETIC-' + ++seq + '.pdf'));
    f.append('options', JSON.stringify({ ...options, ...extra, range: '1-2', amount: 1 }));
    const r = await call('/api/orders', f);
    assert.equal(r.r.status, 201, JSON.stringify(r.data));
    return r.data;
  }
  try {
    await t.test('admin and agent data stay protected', async () => {
      assert.equal((await call('/api/admin/state')).r.status, 401);
      assert.equal((await call('/api/agent/claim', { mode: 'live' })).r.status, 401);
      const r = await handler(
        new Request('http://localhost/api/admin/settings', {
          method: 'POST',
          headers: {
            Origin: 'https://evil.invalid',
            Authorization: 'Bearer test-admin',
          },
          body: '{}',
        }),
        env
      );
      assert.equal(r.status, 403);
    });
    await t.test('desktop sign-in tickets expire and cannot be replayed', async () => {
      const expires = String(Date.now() + 60000),
        nonce = crypto.randomUUID(),
        signature = await hmac(env.ADMIN_TOKEN, 'desktop|' + expires + '|' + nonce);
      const path = '/api/desktop-login?' + new URLSearchParams({ expires, nonce, signature });
      const first = await handler(new Request('http://localhost' + path), env);
      assert.equal(first.status, 302);
      assert.match(first.headers.get('set-cookie'), /HttpOnly/);
      assert.equal((await handler(new Request('http://localhost' + path), env)).status, 401);
      assert.equal(
        (await call('/api/desktop-login?expires=0&nonce=' + nonce + '&signature=' + signature)).r
          .status,
        401
      );
    });
    await t.test(
      'invalid and forged-price uploads fail or are repriced on the server',
      async () => {
        const o = await order();
        assert.equal(o.amount, 600);
        assert.equal(o.status, 'draft');
        const f = new FormData();
        f.append('files', new File(['not a PDF'], 'bad.pdf'));
        f.append('options', JSON.stringify(options));
        assert.equal((await call('/api/orders', f)).r.status, 400);
      }
    );
    const o = await order();
    await t.test('cash requires confirmation and shop approval', async () => {
      assert.equal(
        (await call('/api/orders/' + o.token + '/confirm', {})).data.status,
        'awaiting_approval'
      );
      assert.equal((await call('/api/agent/claim', { mode: 'live' }, 'agent')).data.job, null);
      await call(
        '/api/admin/orders/' +
          (await store.DB.prepare('SELECT id FROM orders WHERE token=?').bind(o.token).first()).id,
        { action: 'approve', confirmed: true },
        'admin'
      );
    });
    let printerId;
    await t.test('printer capability rules and mapping', async () => {
      assert.equal(
        (
          await call(
            '/api/admin/printers',
            {
              name: 'TEST PRINTER',
              brand: 'Test',
              model: 'Synthetic',
              capability: 'bw',
              connection: 'USB',
            },
            'admin'
          )
        ).r.status,
        200
      );
      printerId = (await store.DB.prepare('SELECT id FROM printers').first()).id;
      assert.equal(
        (
          await call(
            '/api/admin/settings',
            { ...defaults, mapping: { bw: printerId, color: printerId } },
            'admin'
          )
        ).r.status,
        400
      );
      assert.equal(
        (
          await call(
            '/api/admin/settings',
            { ...defaults, mapping: { bw: printerId, color: '' } },
            'admin'
          )
        ).r.status,
        200
      );
      assert.equal(
        (await call('/api/admin/printers/' + printerId, null, 'admin', 'DELETE')).r.status,
        400
      );
    });
    let claim;
    await t.test('atomic claim prevents two agents printing the same job', async () => {
      assert.equal((await call('/api/agent/claim', { mode: 'dry-run' }, 'agent')).r.status, 400);
      const results = await Promise.all([
        call('/api/agent/claim', { mode: 'live' }, 'agent'),
        call('/api/agent/claim', { mode: 'live' }, 'agent'),
      ]);
      assert.equal(results.filter(r => r.data.job).length, 1);
      claim = results.find(r => r.data.job).data.job;
      assert.equal(claim.printer, 'TEST PRINTER');
    });
    await t.test('agent cannot claim printed output and cannot forge a lease', async () => {
      assert.equal(
        (
          await call(
            '/api/agent/result/' + claim.id,
            { claim: 'wrong', status: 'submitted' },
            'agent'
          )
        ).r.status,
        403
      );
      assert.equal(
        (
          await call(
            '/api/agent/result/' + claim.id,
            { claim: claim.claim, status: 'printed' },
            'agent'
          )
        ).r.status,
        400
      );
      assert.equal(
        (
          await call(
            '/api/agent/result/' + claim.id,
            { claim: claim.claim, status: 'submitted' },
            'agent'
          )
        ).r.status,
        200
      );
      assert.equal((await call('/api/orders/' + o.token)).data.status, 'submitted');
      assert.equal(
        (await call('/api/admin/orders/' + claim.id, { action: 'printed' }, 'admin')).r.status,
        200
      );
    });
    await t.test('UPI customer report does not mark payment paid or queue it', async () => {
      await call(
        '/api/admin/settings',
        {
          ...defaults,
          upi: 'test@upi',
          mapping: { bw: printerId, color: '' },
        },
        'admin'
      );
      const upi = await order({ method: 'upi' });
      await call('/api/orders/' + upi.token + '/confirm', {});
      await call('/api/orders/' + upi.token + '/upi-sent', {});
      const status = (await call('/api/orders/' + upi.token)).data;
      assert.equal(status.payment, 'reported');
      assert.equal(status.status, 'awaiting_payment');
    });
    await t.test(
      'uploaded QR profiles can switch without changing existing order payment details',
      async () => {
        const png = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD2kAAAAASUVORK5CYII=',
          'base64'
        );
        const form = new FormData();
        form.append('file', new File([png], 'synthetic-qr.png'));
        assert.equal((await call('/api/admin/payment-qr', form)).r.status, 401);
        const uploaded = await call('/api/admin/payment-qr', form, 'admin');
        assert.equal(uploaded.r.status, 200);
        const a = {
            id: crypto.randomUUID(),
            label: 'QR A',
            payee: 'Synthetic A',
            upi: '',
            qr: uploaded.data.qr,
          },
          b = {
            id: crypto.randomUUID(),
            label: 'QR B',
            payee: 'Synthetic B',
            upi: 'synthetic@upi',
            qr: '',
          };
        const settings = {
          ...defaults,
          cash: false,
          paymentProfiles: [a, b],
          activePaymentProfile: a.id,
          mapping: { bw: printerId, color: '' },
        };
        assert.equal((await call('/api/admin/settings', settings, 'admin')).r.status, 200);
        assert.equal((await call('/api/config')).data.upiAvailable, true);
        assert.equal((await call('/api/config')).data.paymentProfiles, undefined);
        const old = await order({ method: 'upi' });
        assert.equal(old.options.paymentProfile.qr, a.qr);
        assert.equal(
          (await call('/api/admin/settings', { ...settings, activePaymentProfile: b.id }, 'admin'))
            .r.status,
          200
        );
        const newer = await order({ method: 'upi' });
        assert.equal(newer.options.paymentProfile.upi, b.upi);
        assert.equal((await call('/api/orders/' + old.token)).data.options.paymentProfile.qr, a.qr);
        const image = await handler(new Request('http://localhost/api/payment-qr/' + a.qr), env);
        assert.equal(image.status, 200);
        assert.equal(image.headers.get('content-type'), 'image/png');
        const bad = new FormData();
        bad.append('file', new File(['<script>evil</script>'], 'bad.svg'));
        assert.equal((await call('/api/admin/payment-qr', bad, 'admin')).r.status, 400);
      }
    );
    await t.test(
      'Razorpay signatures, captured amounts and webhook replay are checked',
      async () => {
        await call(
          '/api/admin/settings',
          { ...defaults, online: true, mapping: { bw: printerId, color: '' } },
          'admin'
        );
        const online = await order({ method: 'online' });
        await call('/api/orders/' + online.token + '/confirm', {});
        const original = globalThis.fetch;
        try {
          globalThis.fetch = async (url, init) =>
            new Response(
              JSON.stringify(
                init?.method === 'POST'
                  ? { id: 'order_fixture' }
                  : {
                      id: 'pay_fixture',
                      order_id: 'order_fixture',
                      amount: 600,
                      currency: 'INR',
                      status: 'captured',
                    }
              ),
              { headers: { 'Content-Type': 'application/json' } }
            );
          const checkout = await call('/api/orders/' + online.token + '/checkout', {});
          assert.equal(checkout.data.amount, 600);
          assert.equal(
            (
              await call('/api/orders/' + online.token + '/verify', {
                razorpay_order_id: 'order_fixture',
                razorpay_payment_id: 'pay_fixture',
                razorpay_signature: 'forged',
              })
            ).r.status,
            403
          );
          const signature = await hmac(env.RAZORPAY_KEY_SECRET, 'order_fixture|pay_fixture');
          assert.equal(
            (
              await call('/api/orders/' + online.token + '/verify', {
                razorpay_order_id: 'order_fixture',
                razorpay_payment_id: 'pay_fixture',
                razorpay_signature: signature,
              })
            ).r.status,
            200
          );
          assert.equal((await call('/api/orders/' + online.token)).data.payment, 'paid');
          const raw = JSON.stringify({
            event: 'payment.captured',
            payload: {
              payment: {
                entity: {
                  id: 'pay_fixture',
                  order_id: 'order_fixture',
                  amount: 600,
                  currency: 'INR',
                  status: 'captured',
                },
              },
            },
          });
          for (let n = 0; n < 2; n++)
            assert.equal(
              (
                await handler(
                  new Request('http://localhost/api/payments/webhook', {
                    method: 'POST',
                    headers: {
                      'x-razorpay-signature': await hmac(env.RAZORPAY_WEBHOOK_SECRET, raw),
                    },
                    body: raw,
                  }),
                  env
                )
              ).status,
              200
            );
        } finally {
          globalThis.fetch = original;
        }
      }
    );
    await t.test('retention removes stored documents and prevents queued printing', async () => {
      await store.DB.prepare('UPDATE orders SET created = ?')
        .bind(Date.now() - 48 * 3600000)
        .run();
      assert.ok((await cleanup(env)) > 0);
      const row = await store.DB.prepare('SELECT * FROM orders WHERE token=?')
        .bind(o.token)
        .first();
      assert.equal(row.file, '');
      assert.equal((await call('/api/orders/' + o.token + '/file')).r.status, 410);
      const queued = await store.DB.prepare(
        "SELECT COUNT(*) AS n FROM orders WHERE status='queued'"
      ).first();
      assert.equal(queued.n, 0);
    });
    await t.test('synthetic test prints require admin, mapping and live agent', async () => {
      assert.equal((await call('/api/admin/test-print', {})).r.status, 401);
      assert.equal((await call('/api/admin/test-print', {}, 'admin')).r.status, 400);
      await call('/api/agent/heartbeat', { id: 'test-agent', mode: 'live', printers: [] }, 'agent');
      const r = await call('/api/admin/test-print', {}, 'admin');
      assert.equal(r.r.status, 200);
      const order = (await call('/api/orders/' + r.data.token)).data;
      assert.equal(order.amount, 0);
      assert.equal(order.status, 'queued');
      assert.equal(order.options.synthetic, true);
    });
  } finally {
    store.db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('verified online payment auto-queues without admin approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shri-print-pay-'));
  const store = await storage(root);
  const clientId = 'test-client-' + crypto.randomUUID();
  const env = {
    ...store,
    CUSTOMER_PAYMENT_POLICY: 'legacy',
    ADMIN_TOKEN: 'test-admin',
    AGENT_TOKEN: 'test-agent',
    RAZORPAY_KEY_ID: 'rzp_test_fixture',
    RAZORPAY_KEY_SECRET: 'test-secret',
    RAZORPAY_WEBHOOK_SECRET: 'test-webhook',
  };
  async function call(path, body, role = '', method) {
    const headers = { 'x-shri-client': clientId };
    if (role)
      headers.Authorization = 'Bearer ' + (role === 'admin' ? env.ADMIN_TOKEN : env.AGENT_TOKEN);
    if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const r = await handler(
      new Request('http://localhost' + path, {
        method: method || (body ? 'POST' : 'GET'),
        headers,
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      }),
      env
    );
    let data;
    try {
      data = await r.json();
    } catch {}
    return { r, data };
  }
  await call(
    '/api/admin/settings',
    { ...defaults, online: true, mapping: { bw: '', color: '' } },
    'admin'
  );
  const printer = await call(
    '/api/admin/printers',
    {
      name: 'TEST PRINTER',
      brand: 'Test',
      model: 'Synthetic',
      capability: 'bw',
      connection: 'USB',
    },
    'admin'
  );
  assert.equal(printer.r.status, 200);
  const printerId = (await store.DB.prepare('SELECT id FROM printers').first()).id;
  await call(
    '/api/admin/settings',
    { ...defaults, online: true, mapping: { bw: printerId, color: '' } },
    'admin'
  );
  const online = await (async () => {
    const f = new FormData();
    f.append('files', new File([pdfBytes], 'pay-test.pdf'));
    f.append('options', JSON.stringify({ ...options, method: 'online', range: '1-2' }));
    const r = await call('/api/orders', f);
    assert.equal(r.r.status, 201);
    return r.data;
  })();
  await call('/api/orders/' + online.token + '/confirm', {});
  assert.equal((await call('/api/orders/' + online.token)).data.status, 'awaiting_payment');

  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) =>
      new Response(
        JSON.stringify(
          init?.method === 'POST'
            ? { id: 'order_webhook' }
            : {
                id: 'pay_webhook',
                order_id: 'order_webhook',
                amount: 600,
                currency: 'INR',
                status: 'captured',
              }
        ),
        { headers: { 'Content-Type': 'application/json' } }
      );
    const checkout = await call('/api/orders/' + online.token + '/checkout', {});
    assert.equal(checkout.r.status, 200);
    const sig = await hmac(env.RAZORPAY_KEY_SECRET, checkout.data.order_id + '|' + 'pay_webhook');
    await call('/api/orders/' + online.token + '/verify', {
      razorpay_order_id: checkout.data.order_id,
      razorpay_payment_id: 'pay_webhook',
      razorpay_signature: sig,
    });
    const afterVerify = await call('/api/orders/' + online.token);
    assert.equal(afterVerify.data.payment, 'paid');
    assert.equal(afterVerify.data.status, 'queued');

    const claim = await call('/api/agent/claim', { mode: 'live' }, 'agent');
    assert.ok(claim.data.job);
    assert.equal(claim.data.job.status, 'claimed');

    const orderRow = await store.DB.prepare('SELECT payment_id FROM orders WHERE token=?')
      .bind(online.token)
      .first();
    assert.equal(orderRow.payment_id, 'pay_webhook');
  } finally {
    globalThis.fetch = original;
  }
  store.db.close();
  await rm(root, { recursive: true, force: true });
});

test('webhook idempotency: duplicate captured events do not double-queue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shri-print-idem-'));
  const store = await storage(root);
  const clientId = 'test-client-' + crypto.randomUUID();
  const env = {
    ...store,
    CUSTOMER_PAYMENT_POLICY: 'legacy',
    ADMIN_TOKEN: 'test-admin',
    AGENT_TOKEN: 'test-agent',
    RAZORPAY_KEY_ID: 'rzp_test_fixture',
    RAZORPAY_KEY_SECRET: 'test-secret',
    RAZORPAY_WEBHOOK_SECRET: 'test-webhook',
  };
  async function call(path, body, role = '', method) {
    const headers = { 'x-shri-client': clientId };
    if (role)
      headers.Authorization = 'Bearer ' + (role === 'admin' ? env.ADMIN_TOKEN : env.AGENT_TOKEN);
    if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const r = await handler(
      new Request('http://localhost' + path, {
        method: method || (body ? 'POST' : 'GET'),
        headers,
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      }),
      env
    );
    let data;
    try {
      data = await r.json();
    } catch {}
    return { r, data };
  }
  await call(
    '/api/admin/settings',
    { ...defaults, online: true, mapping: { bw: '', color: '' } },
    'admin'
  );
  const online = await (async () => {
    const f = new FormData();
    f.append('files', new File([pdfBytes], 'idem-test.pdf'));
    f.append('options', JSON.stringify({ ...options, method: 'online', range: '1-2' }));
    const r = await call('/api/orders', f);
    assert.equal(r.r.status, 201);
    return r.data;
  })();
  await call('/api/orders/' + online.token + '/confirm', {});

  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) =>
      new Response(
        JSON.stringify(
          init?.method === 'POST'
            ? { id: 'order_idem' }
            : {
                id: 'pay_idem',
                order_id: 'order_idem',
                amount: 600,
                currency: 'INR',
                status: 'captured',
              }
        ),
        { headers: { 'Content-Type': 'application/json' } }
      );
    const checkout = await call('/api/orders/' + online.token + '/checkout', {});
    assert.equal(checkout.r.status, 200);
    const raw = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_idem',
            order_id: checkout.data.order_id,
            amount: 600,
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    });
    const sig = await hmac(env.RAZORPAY_WEBHOOK_SECRET, raw);

    for (let i = 0; i < 5; i++) {
      const r = await handler(
        new Request('http://localhost/api/payments/webhook', {
          method: 'POST',
          headers: { 'x-razorpay-signature': sig },
          body: raw,
        }),
        env
      );
      assert.equal(r.status, 200);
    }

    const orderAfter = await call('/api/orders/' + online.token);
    assert.equal(orderAfter.data.payment, 'paid');
    assert.equal(orderAfter.data.status, 'queued');

    const events = await store.DB.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE order_id=? AND action='Online payment verified by provider'"
    )
      .bind(
        (await store.DB.prepare('SELECT id FROM orders WHERE token=?').bind(online.token).first())
          .id
      )
      .first();
    assert.equal(events.n, 1, 'Only one audit event should be recorded for duplicate webhooks');
  } finally {
    globalThis.fetch = original;
  }
  store.db.close();
  await rm(root, { recursive: true, force: true });
});

test('wrong amount/currency/order in webhook cannot queue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shri-print-bad-'));
  const store = await storage(root);
  const clientId = 'test-client-' + crypto.randomUUID();
  const env = {
    ...store,
    CUSTOMER_PAYMENT_POLICY: 'legacy',
    ADMIN_TOKEN: 'test-admin',
    AGENT_TOKEN: 'test-agent',
    RAZORPAY_KEY_ID: 'rzp_test_fixture',
    RAZORPAY_KEY_SECRET: 'test-secret',
    RAZORPAY_WEBHOOK_SECRET: 'test-webhook',
  };
  async function call(path, body, role = '', method) {
    const headers = { 'x-shri-client': clientId };
    if (role)
      headers.Authorization = 'Bearer ' + (role === 'admin' ? env.ADMIN_TOKEN : env.AGENT_TOKEN);
    if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const r = await handler(
      new Request('http://localhost' + path, {
        method: method || (body ? 'POST' : 'GET'),
        headers,
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      }),
      env
    );
    let data;
    try {
      data = await r.json();
    } catch {}
    return { r, data };
  }
  await call(
    '/api/admin/settings',
    { ...defaults, online: true, mapping: { bw: '', color: '' } },
    'admin'
  );
  const online = await (async () => {
    const f = new FormData();
    f.append('files', new File([pdfBytes], 'bad-test.pdf'));
    f.append('options', JSON.stringify({ ...options, method: 'online', range: '1-2' }));
    const r = await call('/api/orders', f);
    assert.equal(r.r.status, 201);
    return r.data;
  })();
  await call('/api/orders/' + online.token + '/confirm', {});

  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) =>
      new Response(
        JSON.stringify(
          init?.method === 'POST'
            ? { id: 'order_bad' }
            : {
                id: 'pay_bad',
                order_id: 'order_bad',
                amount: 600,
                currency: 'INR',
                status: 'captured',
              }
        ),
        { headers: { 'Content-Type': 'application/json' } }
      );
    const checkout = await call('/api/orders/' + online.token + '/checkout', {});
    assert.equal(checkout.r.status, 200);

    const wrongAmount = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_bad',
            order_id: checkout.data.order_id,
            amount: 500,
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    });
    const sig = await hmac(env.RAZORPAY_WEBHOOK_SECRET, wrongAmount);
    await handler(
      new Request('http://localhost/api/payments/webhook', {
        method: 'POST',
        headers: { 'x-razorpay-signature': sig },
        body: wrongAmount,
      }),
      env
    );
    assert.equal((await call('/api/orders/' + online.token)).data.payment, 'pending');

    const wrongCurrency = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_bad2',
            order_id: checkout.data.order_id,
            amount: 600,
            currency: 'USD',
            status: 'captured',
          },
        },
      },
    });
    const sig2 = await hmac(env.RAZORPAY_WEBHOOK_SECRET, wrongCurrency);
    await handler(
      new Request('http://localhost/api/payments/webhook', {
        method: 'POST',
        headers: { 'x-razorpay-signature': sig2 },
        body: wrongCurrency,
      }),
      env
    );
    assert.equal((await call('/api/orders/' + online.token)).data.payment, 'pending');

    const wrongOrder = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_bad3',
            order_id: 'other_order',
            amount: 600,
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    });
    const sig3 = await hmac(env.RAZORPAY_WEBHOOK_SECRET, wrongOrder);
    await handler(
      new Request('http://localhost/api/payments/webhook', {
        method: 'POST',
        headers: { 'x-razorpay-signature': sig3 },
        body: wrongOrder,
      }),
      env
    );
    assert.equal((await call('/api/orders/' + online.token)).data.payment, 'pending');

    const notCaptured = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_bad4',
            order_id: checkout.data.order_id,
            amount: 600,
            currency: 'INR',
            status: 'authorized',
          },
        },
      },
    });
    const sig4 = await hmac(env.RAZORPAY_WEBHOOK_SECRET, notCaptured);
    await handler(
      new Request('http://localhost/api/payments/webhook', {
        method: 'POST',
        headers: { 'x-razorpay-signature': sig4 },
        body: notCaptured,
      }),
      env
    );
    assert.equal((await call('/api/orders/' + online.token)).data.payment, 'pending');
  } finally {
    globalThis.fetch = original;
  }
  store.db.close();
  await rm(root, { recursive: true, force: true });
});

test('cancelled/expired order with later payment stays recorded but never prints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shri-print-cancel-'));
  const store = await storage(root);
  const clientId = 'test-client-' + crypto.randomUUID();
  const env = {
    ...store,
    CUSTOMER_PAYMENT_POLICY: 'legacy',
    ADMIN_TOKEN: 'test-admin',
    AGENT_TOKEN: 'test-agent',
    RAZORPAY_KEY_ID: 'rzp_test_fixture',
    RAZORPAY_KEY_SECRET: 'test-secret',
    RAZORPAY_WEBHOOK_SECRET: 'test-webhook',
  };
  async function call(path, body, role = '', method) {
    const headers = { 'x-shri-client': clientId };
    if (role)
      headers.Authorization = 'Bearer ' + (role === 'admin' ? env.ADMIN_TOKEN : env.AGENT_TOKEN);
    if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const r = await handler(
      new Request('http://localhost' + path, {
        method: method || (body ? 'POST' : 'GET'),
        headers,
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      }),
      env
    );
    let data;
    try {
      data = await r.json();
    } catch {}
    return { r, data };
  }
  await call(
    '/api/admin/settings',
    { ...defaults, online: true, mapping: { bw: '', color: '' } },
    'admin'
  );
  const online = await (async () => {
    const f = new FormData();
    f.append('files', new File([pdfBytes], 'cancel-test.pdf'));
    f.append('options', JSON.stringify({ ...options, method: 'online', range: '1-2' }));
    const r = await call('/api/orders', f);
    assert.equal(r.r.status, 201);
    return r.data;
  })();
  await call('/api/orders/' + online.token + '/confirm', {});

  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) =>
      new Response(
        JSON.stringify(
          init?.method === 'POST'
            ? { id: 'order_cancel' }
            : {
                id: 'pay_cancel',
                order_id: 'order_cancel',
                amount: 600,
                currency: 'INR',
                status: 'captured',
              }
        ),
        { headers: { 'Content-Type': 'application/json' } }
      );
    const checkout = await call('/api/orders/' + online.token + '/checkout', {});
    assert.equal(checkout.r.status, 200);

    await call(
      '/api/admin/orders/' +
        (await store.DB.prepare('SELECT id FROM orders WHERE token=?').bind(online.token).first())
          .id,
      { action: 'cancel', confirmed: true },
      'admin'
    );
    assert.equal((await call('/api/orders/' + online.token)).data.status, 'cancelled');

    const raw = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_cancel',
            order_id: checkout.data.order_id,
            amount: 600,
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    });
    const sig = await hmac(env.RAZORPAY_WEBHOOK_SECRET, raw);
    await handler(
      new Request('http://localhost/api/payments/webhook', {
        method: 'POST',
        headers: { 'x-razorpay-signature': sig },
        body: raw,
      }),
      env
    );

    const after = await call('/api/orders/' + online.token);
    assert.equal(after.data.payment, 'paid');
    assert.equal(after.data.status, 'cancelled');
    const orderRow = await store.DB.prepare('SELECT payment_id FROM orders WHERE token=?')
      .bind(online.token)
      .first();
    assert.ok(orderRow.payment_id);
    assert.equal(after.data.status, 'cancelled', 'Cancelled order must not be revived to queued');
  } finally {
    globalThis.fetch = original;
  }
  store.db.close();
  await rm(root, { recursive: true, force: true });
});

test('expired-by-created-time order with later payment stays recorded but never queues', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shri-print-expired-'));
  const store = await storage(root);
  const clientId = 'test-client-' + crypto.randomUUID();
  const env = {
    ...store,
    CUSTOMER_PAYMENT_POLICY: 'legacy',
    ADMIN_TOKEN: 'test-admin',
    AGENT_TOKEN: 'test-agent',
    RAZORPAY_KEY_ID: 'rzp_test_fixture',
    RAZORPAY_KEY_SECRET: 'test-secret',
    RAZORPAY_WEBHOOK_SECRET: 'test-webhook',
  };
  async function call(path, body, role = '', method) {
    const headers = { 'x-shri-client': clientId };
    if (role)
      headers.Authorization = 'Bearer ' + (role === 'admin' ? env.ADMIN_TOKEN : env.AGENT_TOKEN);
    if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const r = await handler(
      new Request('http://localhost' + path, {
        method: method || (body ? 'POST' : 'GET'),
        headers,
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      }),
      env
    );
    let data;
    try {
      data = await r.json();
    } catch {}
    return { r, data };
  }
  await call(
    '/api/admin/settings',
    { ...defaults, online: true, retentionHours: 1, mapping: { bw: '', color: '' } },
    'admin'
  );
  const online = await (async () => {
    const f = new FormData();
    f.append('files', new File([pdfBytes], 'expired-test.pdf'));
    f.append('options', JSON.stringify({ ...options, method: 'online', range: '1-2' }));
    const r = await call('/api/orders', f);
    assert.equal(r.r.status, 201);
    return r.data;
  })();
  await call('/api/orders/' + online.token + '/confirm', {});

  await store.DB.prepare('UPDATE orders SET created = ? WHERE token = ?')
    .bind(Date.now() - 2 * 3600000, online.token)
    .run();

  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) =>
      new Response(
        JSON.stringify(
          init?.method === 'POST'
            ? { id: 'order_expired' }
            : {
                id: 'pay_expired',
                order_id: 'order_expired',
                amount: 600,
                currency: 'INR',
                status: 'captured',
              }
        ),
        { headers: { 'Content-Type': 'application/json' } }
      );
    const checkout = await call('/api/orders/' + online.token + '/checkout', {});
    assert.equal(checkout.r.status, 200);

    const raw = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_expired',
            order_id: checkout.data.order_id,
            amount: 600,
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    });
    const sig = await hmac(env.RAZORPAY_WEBHOOK_SECRET, raw);
    await handler(
      new Request('http://localhost/api/payments/webhook', {
        method: 'POST',
        headers: { 'x-razorpay-signature': sig },
        body: raw,
      }),
      env
    );

    const after = await call('/api/orders/' + online.token);
    assert.equal(after.data.payment, 'paid');
    assert.notEqual(after.data.status, 'queued');
    const orderRow = await store.DB.prepare('SELECT payment_id FROM orders WHERE token=?')
      .bind(online.token)
      .first();
    assert.ok(orderRow.payment_id, 'Payment recorded for review/refund');
    assert.equal(after.data.status, 'expired', 'Expired order must not be revived to queued');
  } finally {
    globalThis.fetch = original;
  }
  store.db.close();
  await rm(root, { recursive: true, force: true });
});

test('concurrent verify and webhook do not duplicate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shri-print-conc-'));
  const store = await storage(root);
  const clientId = 'test-client-' + crypto.randomUUID();
  const env = {
    ...store,
    CUSTOMER_PAYMENT_POLICY: 'legacy',
    ADMIN_TOKEN: 'test-admin',
    AGENT_TOKEN: 'test-agent',
    RAZORPAY_KEY_ID: 'rzp_test_fixture',
    RAZORPAY_KEY_SECRET: 'test-secret',
    RAZORPAY_WEBHOOK_SECRET: 'test-webhook',
  };
  async function call(path, body, role = '', method) {
    const headers = { 'x-shri-client': clientId };
    if (role)
      headers.Authorization = 'Bearer ' + (role === 'admin' ? env.ADMIN_TOKEN : env.AGENT_TOKEN);
    if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const r = await handler(
      new Request('http://localhost' + path, {
        method: method || (body ? 'POST' : 'GET'),
        headers,
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      }),
      env
    );
    let data;
    try {
      data = await r.json();
    } catch {}
    return { r, data };
  }
  await call(
    '/api/admin/settings',
    { ...defaults, online: true, mapping: { bw: '', color: '' } },
    'admin'
  );
  const online = await (async () => {
    const f = new FormData();
    f.append('files', new File([pdfBytes], 'conc-test.pdf'));
    f.append('options', JSON.stringify({ ...options, method: 'online', range: '1-2' }));
    const r = await call('/api/orders', f);
    assert.equal(r.r.status, 201);
    return r.data;
  })();
  await call('/api/orders/' + online.token + '/confirm', {});

  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) =>
      new Response(
        JSON.stringify(
          init?.method === 'POST'
            ? { id: 'order_conc' }
            : {
                id: 'pay_conc',
                order_id: 'order_conc',
                amount: 600,
                currency: 'INR',
                status: 'captured',
              }
        ),
        { headers: { 'Content-Type': 'application/json' } }
      );
    const checkout = await call('/api/orders/' + online.token + '/checkout', {});
    assert.equal(checkout.r.status, 200);
    const sig = await hmac(env.RAZORPAY_KEY_SECRET, checkout.data.order_id + '|' + 'pay_conc');
    const raw = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_conc',
            order_id: checkout.data.order_id,
            amount: 600,
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    });
    const webhookSig = await hmac(env.RAZORPAY_WEBHOOK_SECRET, raw);

    const [verifyResult, webhookResult] = await Promise.all([
      call('/api/orders/' + online.token + '/verify', {
        razorpay_order_id: checkout.data.order_id,
        razorpay_payment_id: 'pay_conc',
        razorpay_signature: sig,
      }),
      handler(
        new Request('http://localhost/api/payments/webhook', {
          method: 'POST',
          headers: { 'x-razorpay-signature': webhookSig },
          body: raw,
        }),
        env
      ),
    ]);

    const after = await call('/api/orders/' + online.token);
    assert.equal(after.data.payment, 'paid');
    assert.equal(after.data.status, 'queued');
    const orderRow = await store.DB.prepare('SELECT payment_id FROM orders WHERE token=?')
      .bind(online.token)
      .first();
    assert.equal(orderRow.payment_id, 'pay_conc');

    const events = await store.DB.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE order_id=? AND action='Online payment verified by provider'"
    )
      .bind(
        (await store.DB.prepare('SELECT id FROM orders WHERE token=?').bind(online.token).first())
          .id
      )
      .first();
    assert.equal(events.n, 1, 'Concurrent verify+webhook should record single audit event');
  } finally {
    globalThis.fetch = original;
  }
  store.db.close();
  await rm(root, { recursive: true, force: true });
});

test('photo package prices and quantity validation', () => {
  const s = { ...defaults, photoPackages: { 5: 3000, 10: 6000, 20: 12000, 30: 18000 } };
  assert.equal(photoPackagePrice(5, s), 3000);
  assert.equal(photoPackagePrice(10, s), 6000);
  assert.equal(photoPackagePrice(20, s), 12000);
  assert.equal(photoPackagePrice(30, s), 18000);
  assert.throws(() => photoPackagePrice(7, s), /Invalid photo package/);
  assert.throws(() => photoPackagePrice(100, s), /Invalid photo package/);

  const legacySettings = { ...defaults };
  delete legacySettings.photoPackages;
  assert.equal(photoPackagePrice(5, legacySettings), 3000);
  assert.equal(photoPackagePrice(10, legacySettings), 6000);

  const partialSettings = { ...defaults, photoPackages: { 5: 3000, 10: 5000 } };
  assert.equal(photoPackagePrice(5, partialSettings), 3000);
  assert.equal(photoPackagePrice(10, partialSettings), 5000);
  assert.equal(photoPackagePrice(20, partialSettings), 12000);
  assert.equal(photoPackagePrice(30, partialSettings), 18000);

  const zeroPriceSettings = {
    ...defaults,
    photoPackages: { 5: 3000, 10: 0, 20: 12000, 30: 18000 },
  };
  assert.equal(photoPackagePrice(10, zeroPriceSettings), 0);
});

test('passport quote uses photo package price not page rates', () => {
  const opts = {
    service: 'passport',
    photoQty: 5,
    copies: 2,
    paper: 'A4',
    color: 'color',
    orientation: 'portrait',
    duplex: false,
  };
  const amount = quote(1, opts, defaults);
  assert.equal(amount, 6000);

  const opts10 = { ...opts, photoQty: 10 };
  assert.equal(quote(1, opts10, defaults), 12000);
});

test('passport options validation enforces constraints', () => {
  const base = {
    ...options,
    service: 'passport',
    photoQty: 5,
    copies: 1,
    paper: 'A4',
    color: 'color',
    orientation: 'portrait',
    duplex: false,
  };
  validateOptions(base);
  assert.throws(() => validateOptions({ ...base, photoQty: 7 }), /Invalid photo package/);
  assert.throws(() => validateOptions({ ...base, copies: 11 }), /Photo sets must be 1.10/);
  assert.throws(() => validateOptions({ ...base, paper: 'A3' }), /Passport photos use A4 paper/);
  assert.throws(() => validateOptions({ ...base, color: 'bw' }), /Passport photos are color only/);
  assert.throws(
    () => validateOptions({ ...base, orientation: 'landscape' }),
    /Passport photos use portrait orientation/
  );
  assert.throws(
    () => validateOptions({ ...base, duplex: true }),
    /Passport photos are single-sided/
  );
});

test('passport PDF generates exact photoQty frames on one A4 page', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD2kAAAAASUVORK5CYII=',
    'base64'
  );
  for (const qty of [5, 10, 20, 30]) {
    const opts = {
      ...options,
      service: 'passport',
      photoQty: qty,
      color: 'color',
      paper: 'A4',
      orientation: 'portrait',
      duplex: false,
    };
    const out = await prepareDocuments([new File([png], 'fixture.png')], opts);
    const pdf = await PDFDocument.load(out.bytes);
    assert.equal(pdf.getPageCount(), 1);
    const page = pdf.getPage(0);
    assert.ok(Math.abs(page.getWidth() - 595.276) < 0.01);
    assert.ok(Math.abs(page.getHeight() - 841.89) < 0.01);
    const contents = page.node.Contents();
    let text = '';
    for (let i = 0; i < contents.size(); i++)
      text += new TextDecoder().decode(
        decodePDFRawStream(pdf.context.lookup(contents.get(i))).decode()
      );
    assert.equal((text.match(/\bDo\b/g) || []).length, qty, 'Exact photo placements');
    const frames = text.split(/\n?Q\s*/).filter(b => /\nS\s*$/.test(b));
    assert.equal(frames.length, qty, 'Exact cutting frames');
    for (const block of frames) {
      const translation = block.match(/1 0 0 1 ([\d.-]+) ([\d.-]+) cm/);
      const height = Number(block.match(/0 ([\d.]+) l/)[1]);
      const width = Number(block.match(/([\d.]+) 0 l/)[1]);
      const x = Number(translation[1]),
        y = Number(translation[2]),
        mm = 72 / 25.4;
      assert.ok(
        Math.abs(width / mm - 35) < 0.001 && Math.abs(height / mm - 45) < 0.001,
        'Exact physical 35 x 45 mm'
      );
      assert.ok(
        x >= 8 * mm &&
          y >= 8 * mm &&
          x + width <= page.getWidth() - 8 * mm &&
          y + height <= page.getHeight() - 8 * mm,
        'Frames stay in 8 mm printable margins'
      );
    }
  }
});

test('crop geometry preserves 35:45 aspect and bounds', async () => {
  const { PHOTO_ASPECT, faceBoxToCrop, clampCrop } = await import('../lib/photo.js');
  const mockDetection = {
    boundingBox: { originX: 100, originY: 80, width: 60, height: 60 },
  };
  const crop = faceBoxToCrop(mockDetection, 800, 600);
  assert.ok(Math.abs(crop.width / crop.height - PHOTO_ASPECT) < 0.01);
  assert.ok(crop.x >= 0 && crop.y >= 0);
  assert.ok(crop.x + crop.width <= 800);
  assert.ok(crop.y + crop.height <= 600);

  const clamped = clampCrop({ x: -10, y: -5, width: 820, height: 610, rotation: 90 }, 800, 600);
  assert.ok(Math.abs(clamped.width / clamped.height - PHOTO_ASPECT) < 0.01);
  assert.ok(clamped.x >= 0 && clamped.y >= 0);
  assert.ok(clamped.x + clamped.width <= 800);
  assert.ok(clamped.y + clamped.height <= 600);

  const extremePortrait = clampCrop(
    { x: 0, y: 0, width: 100, height: 1000, rotation: 0 },
    800,
    600
  );
  assert.ok(Math.abs(extremePortrait.width / extremePortrait.height - PHOTO_ASPECT) < 0.01);
  assert.ok(extremePortrait.width <= 800 && extremePortrait.height <= 600);

  const extremeLandscape = clampCrop(
    { x: 0, y: 0, width: 1000, height: 100, rotation: 0 },
    800,
    600
  );
  assert.ok(Math.abs(extremeLandscape.width / extremeLandscape.height - PHOTO_ASPECT) < 0.01);
  assert.ok(extremeLandscape.width <= 800 && extremeLandscape.height <= 600);

  const rotated = clampCrop({ x: 100, y: 100, width: 100, height: 128, rotation: 90 }, 800, 600);
  assert.ok(rotated.rotation === 90);
  assert.ok(Math.abs(rotated.width / rotated.height - PHOTO_ASPECT) < 0.01);
});

// Browser-only test: applyCrop with rotation emits portrait 35:45 output
// Requires document.createElement, createImageBitmap - run in browser QA harness
// test("applyCrop with rotation emits portrait 35:45 output", async () => {
//   const { applyCrop } = await import("../lib/photo.js");
//   const canvas = document.createElement("canvas");
//   canvas.width = 400;
//   canvas.height = 300;
//   const ctx = canvas.getContext("2d");
//   ctx.fillStyle = "red";
//   ctx.fillRect(0, 0, 400, 300);
//   const bitmap = await createImageBitmap(canvas);
//
//   const crop = { x: 50, y: 30, width: 70, height: 90, rotation: 90 };
//   const outCanvas = await applyCrop(bitmap, crop);
//   assert.equal(outCanvas.width, Math.round(70));
//   assert.equal(outCanvas.height, Math.round(90));
//   assert.ok(Math.abs(outCanvas.width / outCanvas.height - 35/45) < 0.01);
//
//   const crop0 = { x: 50, y: 30, width: 70, height: 90, rotation: 0 };
//   const outCanvas0 = await applyCrop(bitmap, crop0);
//   assert.equal(outCanvas0.width, Math.round(70));
//   assert.equal(outCanvas0.height, Math.round(90));
//
//   const crop180 = { x: 50, y: 30, width: 70, height: 90, rotation: 180 };
//   const outCanvas180 = await applyCrop(bitmap, crop180);
//   assert.equal(outCanvas180.width, Math.round(70));
//   assert.equal(outCanvas180.height, Math.round(90));
//
//   const crop270 = { x: 50, y: 30, width: 70, height: 90, rotation: 270 };
//   const outCanvas270 = await applyCrop(bitmap, crop270);
//   assert.equal(outCanvas270.width, Math.round(70));
//   assert.equal(outCanvas270.height, Math.round(90));
// });

test('settings validation accepts photo packages with zero price', () => {
  const s = { ...defaults, photoPackages: { 5: 3000, 10: 0, 20: 12000, 30: 18000 } };
  validateSettings(s);
  assert.equal(s.photoPackages[10], 0);
});

test('settings validation for photo packages enforces constraints', () => {
  const validS = { ...defaults, photoPackages: { 5: 3000, 10: 6000, 20: 12000, 30: 18000 } };
  validateSettings(validS);

  assert.throws(
    () => validateSettings({ ...defaults, photoPackages: { 7: 1000 } }),
    /Invalid photo package quantity/
  );
  assert.throws(
    () => validateSettings({ ...defaults, photoPackages: { 5: -100 } }),
    /Photo package price must be 0.500 rupees/
  );
  assert.throws(
    () => validateSettings({ ...defaults, photoPackages: { 5: 60000 } }),
    /Photo package price must be 0.500 rupees/
  );

  // Partial settings retain defaults when quoted; validation need not mutate them.
  const partialS = { ...defaults, photoPackages: { 5: 3000, 10: 5000 } };
  validateSettings(partialS);
  assert.equal(photoPackagePrice(20, partialS), 12000);
  assert.equal(photoPackagePrice(30, partialS), 18000);

  // Explicitly changed 5-photo pricing must be honored too.
  const fiveFixed = { ...defaults, photoPackages: { 5: 5000, 10: 6000, 20: 12000, 30: 18000 } };
  validateSettings(fiveFixed);
  assert.equal(photoPackagePrice(5, fiveFixed), 5000);
});
