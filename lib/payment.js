import { ensure, hmac, safeEqual } from './core.js';

export async function verifyWebhookSignature(raw, signature, webhookSecret) {
  ensure(typeof raw === 'string', 'Raw body must be a string.');
  ensure(typeof signature === 'string', 'Signature must be a string.');
  ensure(typeof webhookSecret === 'string', 'Webhook secret must be a string.');
  ensure(safeEqual(signature, await hmac(webhookSecret, raw)), 'Invalid webhook signature.', 403);
  return true;
}

export async function verifyPaymentVerification(order, b, razorpayKeySecret) {
  ensure(order.gateway, 'Invalid payment order.: missing gateway.');
  ensure(b.razorpay_order_id === order.gateway, 'Invalid payment order.: order ID mismatch.');
  ensure(
    safeEqual(
      b.razorpay_signature,
      await hmac(razorpayKeySecret, order.gateway + '|' + b.razorpay_payment_id)
    ),
    'Payment signature is invalid.',
    403
  );
  return true;
}

export function verifyPaymentCapture(payment, order) {
  ensure(payment.order_id === order.gateway, 'Payment order ID does not match the order.');
  ensure(payment.amount === order.amount, 'Payment amount does not match the order amount.');
  ensure(
    payment.currency === order.currency || payment.currency === 'INR',
    'Payment currency does not match the order currency.'
  );
  ensure(payment.status === 'captured', 'Payment is not captured yet.');
  return true;
}
