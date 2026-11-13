import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { defaults, hmac } from '../lib/core.js';
import { prepareDocuments as _prepareDocuments } from '../lib/documents.js';
import {
  verifyPaymentCapture as _verifyPaymentCapture,
  verifyPaymentVerification as _verifyPaymentVerification,
  verifyWebhookSignature as _verifyWebhookSignature,
} from '../lib/payment.js';
import { testPage as _testPage } from '../lib/test-page.js';
import { storage } from '../local/storage.mjs';
import { cleanup, handler } from '../worker/app.js';

const originalFetch = globalThis.fetch;

async function generateSyntheticPdf(pages = 2, text = 'SYNTHETIC TEST') {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595.276, 841.89]);
    page.drawText(`${text} PAGE ${i + 1}`, { x: 50, y: 750, size: 24 });
    page.drawText(`Generated: ${new Date().toISOString()}`, { x: 50, y: 720, size: 10 });
  }
  return doc.save();
}

function generateSyntheticPng() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD2kAAAAASUVORK5CYII=',
    'base64'
  );
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`ASSERTION FAILED: ${message} - expected ${expected}, got ${actual}`);
  }
}

function _assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`ASSERTION FAILED: ${message} - expected ${e}, got ${a}`);
  }
}

async function runBot(outPath) {
  const root = await mkdtemp(join(tmpdir(), 'shri-print-customer-bot-'));
  const store = await storage(root);

  const env = {
    ...store,
    CUSTOMER_PAYMENT_POLICY: 'legacy',
    ADMIN_TOKEN: 'test-admin-token-synthetic',
    AGENT_TOKEN: 'test-agent-token-synthetic',
    RAZORPAY_KEY_ID: 'rzp_test_synthetic',
    RAZORPAY_KEY_SECRET: 'test-razorpay-secret-synthetic',
    RAZORPAY_WEBHOOK_SECRET: 'test-webhook-secret-synthetic',
  };

  const clientId = 'test-client-synthetic-' + crypto.randomUUID();
  const results = {
    cashOrder: null,
    onlineOrder: null,
    upiOrder: null,
    passportOrders: {},
    concurrentClaim: null,
    duplicateCapture: null,
    invalidAmount: null,
    invalidSignature: null,
    upiSelfReport: null,
    cleanup: null,
    errors: [],
  };

  let _settingsApplied = false;
  let printerId = null;

  async function call(path, body, role = '', method) {
    // Each upload represents a separate synthetic customer, preserving production limits.
    const headers = {
      'x-shri-client': path === '/api/orders' ? clientId + crypto.randomUUID() : clientId,
    };
    if (role) {
      headers.Authorization = 'Bearer ' + (role === 'admin' ? env.ADMIN_TOKEN : env.AGENT_TOKEN);
    }
    if (body && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
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
      data = await r.clone().json();
    } catch {}
    return { r, data, status: r.status };
  }

  async function setupSettings() {
    const r = await call(
      '/api/admin/settings',
      {
        ...defaults,
        cash: true,
        cashAuto: false,
        online: true,
        upi: 'test@upi',
        mapping: { bw: '', color: '' },
        photoPackages: { 5: 3000, 10: 6000, 20: 12000, 30: 18000 },
      },
      'admin'
    );
    assertEqual(r.status, 200, 'Settings setup failed');
    _settingsApplied = true;
  }

  async function setupPrinter() {
    const r = await call(
      '/api/admin/printers',
      {
        name: 'SYNTHETIC PRINTER',
        brand: 'Test',
        model: 'Synthetic',
        capability: 'bw',
        connection: 'USB',
      },
      'admin'
    );
    assertEqual(r.status, 200, 'Printer creation failed');
    const row = await store.DB.prepare('SELECT id FROM printers').first();
    printerId = row.id;
    const r2 = await call(
      '/api/admin/settings',
      {
        ...defaults,
        cash: true,
        cashAuto: false,
        online: true,
        upi: 'test@upi',
        mapping: { bw: printerId, color: '' },
        photoPackages: { 5: 3000, 10: 6000, 20: 12000, 30: 18000 },
      },
      'admin'
    );
    assertEqual(r2.status, 200, 'Printer mapping failed');
  }

  async function orderPdf(options = {}) {
    const pdfBytes = await generateSyntheticPdf(2, 'CASH ORDER');
    const form = new FormData();
    form.append('files', new File([pdfBytes], 'cash-test.pdf'));
    form.append(
      'options',
      JSON.stringify({
        service: 'document',
        color: 'bw',
        paper: 'A4',
        copies: 1,
        range: '1-2',
        orientation: 'portrait',
        duplex: false,
        method: 'cash',
        mobile: '',
        ...options,
      })
    );
    const r = await call('/api/orders', form);
    assertEqual(r.status, 201, 'Order creation failed');
    return r.data;
  }

  async function orderOnline(options = {}) {
    const pdfBytes = await generateSyntheticPdf(2, 'ONLINE ORDER');
    const form = new FormData();
    form.append('files', new File([pdfBytes], 'online-test.pdf'));
    form.append(
      'options',
      JSON.stringify({
        service: 'document',
        color: 'bw',
        paper: 'A4',
        copies: 1,
        range: '1-2',
        orientation: 'portrait',
        duplex: false,
        method: 'online',
        mobile: '',
        ...options,
      })
    );
    const r = await call('/api/orders', form);
    assertEqual(r.status, 201, 'Online order creation failed');
    return r.data;
  }

  async function orderUpi(options = {}) {
    const pdfBytes = await generateSyntheticPdf(2, 'UPI ORDER');
    const form = new FormData();
    form.append('files', new File([pdfBytes], 'upi-test.pdf'));
    form.append(
      'options',
      JSON.stringify({
        service: 'document',
        color: 'bw',
        paper: 'A4',
        copies: 1,
        range: '1-2',
        orientation: 'portrait',
        duplex: false,
        method: 'upi',
        mobile: '',
        ...options,
      })
    );
    const r = await call('/api/orders', form);
    assertEqual(r.status, 201, 'UPI order creation failed');
    return r.data;
  }

  async function orderPassport(photoQty) {
    const png = generateSyntheticPng();
    const form = new FormData();
    form.append('files', new File([png], `passport-${photoQty}.png`));
    form.append(
      'options',
      JSON.stringify({
        service: 'passport',
        color: 'color',
        paper: 'A4',
        copies: 1,
        range: '',
        orientation: 'portrait',
        duplex: false,
        method: 'cash',
        mobile: '',
        photoQty,
      })
    );
    const r = await call('/api/orders', form);
    assertEqual(r.status, 201, `Passport ${photoQty} order creation failed`);
    return r.data;
  }

  try {
    await setupSettings();
    await setupPrinter();

    // ===== CASH ORDER (Pay at Desk) =====
    const cashOrder = await orderPdf({ amount: 1 });
    assertEqual(cashOrder.status, 'draft', 'Cash order should be draft');
    assertEqual(cashOrder.method, 'cash', 'Cash order method');

    const cashConfirm = await call('/api/orders/' + cashOrder.token + '/confirm', {});
    assertEqual(cashConfirm.status, 200, 'Cash confirm failed');
    assertEqual(cashConfirm.data.status, 'awaiting_approval', 'Cash order should await approval');

    // Assert no claim before admin approval
    const claimBefore = await call('/api/agent/claim', { mode: 'live' }, 'agent');
    assertEqual(claimBefore.data.job, null, 'No job should be claimable before approval');

    // Admin approve
    const orderId = (
      await store.DB.prepare('SELECT id FROM orders WHERE token=?').bind(cashOrder.token).first()
    ).id;
    await call('/api/admin/orders/' + orderId, { action: 'approve', confirmed: true }, 'admin');

    const afterApprove = await call('/api/orders/' + cashOrder.token);
    assertEqual(afterApprove.data.status, 'queued', 'Cash order should be queued after approval');
    assertEqual(
      afterApprove.data.payment,
      'paid',
      'Cash order payment should be paid after approval'
    );

    // Claim as mocked agent
    const claimCash = await call('/api/agent/claim', { mode: 'live' }, 'agent');
    assertEqual(claimCash.status, 200, 'Claim failed');
    assert.ok(claimCash.data.job, 'Job should be claimed');
    const cashClaim = claimCash.data.job;
    assertEqual(cashClaim.status, 'claimed', 'Job status should be claimed');
    assert.ok(cashClaim.claim, 'Claim should have lease token');

    // Download prepared PDF
    const fileResp = await handler(
      new Request('http://localhost/api/agent/file/' + cashClaim.id, {
        headers: { Authorization: 'Bearer ' + env.AGENT_TOKEN, 'x-claim': cashClaim.claim },
      }),
      env
    );
    assertEqual(fileResp.status, 200, 'File download failed');
    const pdfBytes = await fileResp.arrayBuffer();
    assert(pdfBytes.byteLength > 100, 'Downloaded PDF should have content');

    // Submit result with proper lease
    const resultCash = await call(
      '/api/agent/result/' + cashClaim.id,
      { claim: cashClaim.claim, status: 'submitted' },
      'agent'
    );
    assertEqual(resultCash.status, 200, 'Result submission failed');

    // Require explicit admin physical-paper confirmation
    const afterSubmit = await call('/api/orders/' + cashOrder.token);
    assertEqual(afterSubmit.data.status, 'submitted', 'Order should be submitted');

    await call('/api/admin/orders/' + cashClaim.id, { action: 'printed' }, 'admin');
    const afterPrinted = await call('/api/orders/' + cashOrder.token);
    assertEqual(
      afterPrinted.data.status,
      'printed',
      'Order should be printed after admin confirmation'
    );

    results.cashOrder = {
      token: cashOrder.token,
      status: afterPrinted.data.status,
      payment: afterPrinted.data.payment,
      claimed: true,
      printed: true,
    };

    // ===== ONLINE ORDER (Razorpay) =====
    const onlineOrder = await orderOnline();
    assertEqual(onlineOrder.status, 'draft', 'Online order should be draft');

    await call('/api/orders/' + onlineOrder.token + '/confirm', {});
    const afterConfirm = await call('/api/orders/' + onlineOrder.token);
    assertEqual(afterConfirm.data.status, 'awaiting_payment', 'Online order should await payment');

    // Stub Razorpay fetch - track checkout calls for consistent IDs per order
    let checkoutCounter = 0;
    const orderIdMap = new Map(); // token -> {orderId, paymentId}
    globalThis.fetch = async (url, init) => {
      const isPost = init?.method === 'POST';
      if (isPost) {
        // POST /orders - create order
        checkoutCounter++;
        const orderId = 'order_synthetic_' + checkoutCounter;
        const paymentId = 'pay_synthetic_' + checkoutCounter;
        // Store for this order's subsequent GET
        // We can't easily know which order this is for here, so use a simple approach:
        // The last created order gets these IDs
        orderIdMap.set('last', { orderId, paymentId });
        return new Response(JSON.stringify({ id: orderId }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // GET /payments/:id - fetch payment details
      // Return the last created order's IDs
      const last = orderIdMap.get('last') || {
        orderId: 'order_synthetic_1',
        paymentId: 'pay_synthetic_1',
      };
      return new Response(
        JSON.stringify({
          id: last.paymentId,
          order_id: last.orderId,
          amount: 600,
          currency: 'INR',
          status: 'captured',
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    };

    const checkout = await call('/api/orders/' + onlineOrder.token + '/checkout', {});
    assertEqual(checkout.status, 200, 'Checkout failed');
    assertEqual(checkout.data.amount, 600, 'Checkout amount');
    const onlineOrderGatewayId = checkout.data.order_id;
    const onlineOrderPaymentId = orderIdMap.get('last').paymentId;

    // Verify with payment_id that matches what GET /payments/:id returns
    const sig = await hmac(
      env.RAZORPAY_KEY_SECRET,
      onlineOrderGatewayId + '|' + onlineOrderPaymentId
    );
    const verifyResp = await call('/api/orders/' + onlineOrder.token + '/verify', {
      razorpay_order_id: onlineOrderGatewayId,
      razorpay_payment_id: onlineOrderPaymentId,
      razorpay_signature: sig,
    });
    assertEqual(verifyResp.status, 200, 'Verify should succeed');

    const afterVerify = await call('/api/orders/' + onlineOrder.token);
    assertEqual(afterVerify.data.payment, 'paid', 'Online payment should be paid after verify');
    assertEqual(
      afterVerify.data.status,
      'queued',
      'Online order should auto-queue (NO admin approve)'
    );

    // Claim exactly once with concurrent attempts
    const [claim1, claim2] = await Promise.all([
      call('/api/agent/claim', { mode: 'live' }, 'agent'),
      call('/api/agent/claim', { mode: 'live' }, 'agent'),
    ]);
    const successfulClaims = [claim1, claim2].filter(c => c.data.job);
    assertEqual(successfulClaims.length, 1, 'Exactly one concurrent claim should succeed');
    const onlineClaim = successfulClaims[0].data.job;
    assertEqual(onlineClaim.status, 'claimed', 'Online claim status');

    // Download prepared PDF
    const fileResp2 = await handler(
      new Request('http://localhost/api/agent/file/' + onlineClaim.id, {
        headers: { Authorization: 'Bearer ' + env.AGENT_TOKEN, 'x-claim': onlineClaim.claim },
      }),
      env
    );
    assertEqual(fileResp2.status, 200, 'Online file download failed');

    // Report submitted
    await call(
      '/api/agent/result/' + onlineClaim.id,
      { claim: onlineClaim.claim, status: 'submitted' },
      'agent'
    );

    // Require explicit admin physical-paper confirmation
    const afterOnlineSubmit = await call('/api/orders/' + onlineOrder.token);
    assertEqual(afterOnlineSubmit.data.status, 'submitted', 'Online order should be submitted');

    await call('/api/admin/orders/' + onlineClaim.id, { action: 'printed' }, 'admin');
    const afterOnlinePrinted = await call('/api/orders/' + onlineOrder.token);
    assertEqual(
      afterOnlinePrinted.data.status,
      'printed',
      'Online order should be printed after admin confirmation'
    );

    results.onlineOrder = {
      token: onlineOrder.token,
      status: afterOnlinePrinted.data.status,
      payment: afterOnlinePrinted.data.payment,
      claimed: true,
      printed: true,
      autoQueued: true,
    };

    // ===== DUPLICATE CAPTURE TEST =====
    const dupOrder = await orderOnline();
    await call('/api/orders/' + dupOrder.token + '/confirm', {});
    const checkout2 = await call('/api/orders/' + dupOrder.token + '/checkout', {});

    // First webhook
    const raw1 = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_dup',
            order_id: checkout2.data.order_id,
            amount: 600,
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    });
    const webhookSig1 = await hmac(env.RAZORPAY_WEBHOOK_SECRET, raw1);
    await handler(
      new Request('http://localhost/api/payments/webhook', {
        method: 'POST',
        headers: { 'x-razorpay-signature': webhookSig1 },
        body: raw1,
      }),
      env
    );

    // Second webhook (duplicate)
    await handler(
      new Request('http://localhost/api/payments/webhook', {
        method: 'POST',
        headers: { 'x-razorpay-signature': webhookSig1 },
        body: raw1,
      }),
      env
    );

    const afterDup = await call('/api/orders/' + dupOrder.token);
    assertEqual(afterDup.data.payment, 'paid', 'Duplicate capture should not affect payment');
    assertEqual(afterDup.data.status, 'queued', 'Duplicate capture should not create second queue');

    // Check audit events - only one should be recorded
    const orderRow = await store.DB.prepare('SELECT id FROM orders WHERE token=?')
      .bind(dupOrder.token)
      .first();
    const events = await store.DB.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE order_id=? AND action='Online payment verified by provider'"
    )
      .bind(orderRow.id)
      .first();
    assertEqual(events.n, 1, 'Only one audit event for duplicate webhooks');

    results.duplicateCapture = {
      token: dupOrder.token,
      status: afterDup.data.status,
      eventsRecorded: events.n,
      duplicateRejected: true,
    };

    // ===== INVALID AMOUNT TEST =====
    const badAmountOrder = await orderOnline();
    await call('/api/orders/' + badAmountOrder.token + '/confirm', {});
    const checkout3 = await call('/api/orders/' + badAmountOrder.token + '/checkout', {});

    const rawBadAmount = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_bad_amount',
            order_id: checkout3.data.order_id,
            amount: 500, // Wrong amount
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    });
    const sigBadAmount = await hmac(env.RAZORPAY_WEBHOOK_SECRET, rawBadAmount);
    await handler(
      new Request('http://localhost/api/payments/webhook', {
        method: 'POST',
        headers: { 'x-razorpay-signature': sigBadAmount },
        body: rawBadAmount,
      }),
      env
    );

    const afterBadAmount = await call('/api/orders/' + badAmountOrder.token);
    assertEqual(afterBadAmount.data.payment, 'pending', 'Invalid amount should not mark paid');
    assertEqual(afterBadAmount.data.status, 'awaiting_payment', 'Invalid amount should not queue');

    results.invalidAmount = {
      token: badAmountOrder.token,
      status: afterBadAmount.data.status,
      payment: afterBadAmount.data.payment,
      rejected: true,
    };

    // ===== INVALID SIGNATURE TEST =====
    const badSigOrder = await orderOnline();
    await call('/api/orders/' + badSigOrder.token + '/confirm', {});
    const checkout4 = await call('/api/orders/' + badSigOrder.token + '/checkout', {});

    const rawBadSig = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_bad_sig',
            order_id: checkout4.data.order_id,
            amount: 600,
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    });
    const sigBadSig = 'invalid-signature';
    await handler(
      new Request('http://localhost/api/payments/webhook', {
        method: 'POST',
        headers: { 'x-razorpay-signature': sigBadSig },
        body: rawBadSig,
      }),
      env
    );

    const afterBadSig = await call('/api/orders/' + badSigOrder.token);
    assertEqual(afterBadSig.data.payment, 'pending', 'Invalid signature should not mark paid');
    assertEqual(afterBadSig.data.status, 'awaiting_payment', 'Invalid signature should not queue');

    results.invalidSignature = {
      token: badSigOrder.token,
      status: afterBadSig.data.status,
      payment: afterBadSig.data.payment,
      rejected: true,
    };

    // ===== UPI SELF-REPORT TEST =====
    const upiOrder = await orderUpi();
    await call('/api/orders/' + upiOrder.token + '/confirm', {});
    await call('/api/orders/' + upiOrder.token + '/upi-sent', {});

    const afterUpiReport = await call('/api/orders/' + upiOrder.token);
    assertEqual(afterUpiReport.data.payment, 'reported', 'UPI self-report should mark reported');
    assertEqual(
      afterUpiReport.data.status,
      'awaiting_payment',
      'UPI self-report should NOT auto-queue'
    );

    results.upiOrder = {
      token: upiOrder.token,
      status: afterUpiReport.data.status,
      payment: afterUpiReport.data.payment,
      selfReported: true,
      notAutoQueued: true,
    };

    // ===== PASSPORT ORDERS (5, 10, 20, 30) =====
    for (const qty of [5, 10, 20, 30]) {
      const passportOrder = await orderPassport(qty);
      const expectedPrice = defaults.photoPackages[qty];
      assertEqual(
        passportOrder.amount,
        expectedPrice,
        `Passport ${qty} price should be ${expectedPrice}`
      );

      await call('/api/orders/' + passportOrder.token + '/confirm', {});
      const afterPassportConfirm = await call('/api/orders/' + passportOrder.token);
      assertEqual(
        afterPassportConfirm.data.status,
        'awaiting_approval',
        `Passport ${qty} should await approval`
      );

      // Verify prepared PDF is exactly one A4 page
      const fileResp = await call('/api/orders/' + passportOrder.token + '/file');
      const pdfDoc = await PDFDocument.load(await fileResp.r.arrayBuffer());
      assertEqual(pdfDoc.getPageCount(), 1, `Passport ${qty} should be exactly 1 page`);
      const page = pdfDoc.getPage(0);
      assert.ok(Math.abs(page.getWidth() - 595.276) < 0.01, `Passport ${qty} should be A4 width`);
      assert.ok(Math.abs(page.getHeight() - 841.89) < 0.01, `Passport ${qty} should be A4 height`);

      results.passportOrders[qty] = {
        token: passportOrder.token,
        amount: passportOrder.amount,
        expectedPrice,
        pages: pdfDoc.getPageCount(),
        pageWidth: page.getWidth(),
        pageHeight: page.getHeight(),
        singleA4: true,
      };
    }

    // ===== CONCURRENT CLAIM TEST (already tested in online order) =====
    results.concurrentClaim = {
      tested: true,
      exactlyOneSucceeded: successfulClaims.length === 1,
    };

    // ===== CLEANUP =====
    const removed = await cleanup(env);
    results.cleanup = { removed };
  } catch (e) {
    results.errors.push({ message: e.message, stack: e.stack });
    throw e;
  } finally {
    globalThis.fetch = originalFetch;
    store.db.close();
    await rm(root, { recursive: true, force: true });
  }

  const summary = {
    mock: true,
    provider: 'MOCK Razorpay (stubbed fetch)',
    agent: 'MOCK agent (direct API calls)',
    realPaymentVerified: false,
    realPhysicalPaperVerified: false,
    timestamp: new Date().toISOString(),
    results,
    passed: results.errors.length === 0,
  };

  const output = JSON.stringify(summary, null, 2);
  if (outPath) {
    await import('node:fs/promises').then(fs => fs.writeFile(outPath, output));
  } else {
    console.log(output);
  }

  if (results.errors.length > 0) {
    process.exitCode = 1;
  }
}

const args = process.argv.slice(2);
let outPath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out' && i + 1 < args.length) {
    outPath = args[i + 1];
  }
}

runBot(outPath).catch(e => {
  console.error('BOT FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});
