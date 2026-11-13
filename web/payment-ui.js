let razorpayLoadPromise = null;
let razorpayLoadErrorTime = 0;
let checkoutBusy = false;
let currentPayButton = null;

const RAZORPAY_SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js';
const RAZORPAY_LOAD_RETRY_DELAY = 30000;

function loadRazorpayScript() {
  if (razorpayLoadPromise) {
    const now = Date.now();
    if (razorpayLoadErrorTime && now - razorpayLoadErrorTime > RAZORPAY_LOAD_RETRY_DELAY) {
      razorpayLoadPromise = null;
      razorpayLoadErrorTime = 0;
    } else {
      return razorpayLoadPromise;
    }
  }

  razorpayLoadPromise = new Promise((resolve, reject) => {
    if (window.Razorpay) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = RAZORPAY_SCRIPT_URL;
    const timeout = setTimeout(() => {
      script.remove();
      razorpayLoadPromise = null;
      reject(new Error('Checkout timed out. Check your connection and retry.'));
    }, 15000);
    script.onload = () => {
      clearTimeout(timeout);
      resolve();
    };
    script.onerror = () => {
      clearTimeout(timeout);
      script.remove();
      razorpayLoadErrorTime = Date.now();
      razorpayLoadPromise = null;
      reject(new Error('Could not load payment checkout. Check your connection and try again.'));
    };
    document.head.append(script);
  });

  return razorpayLoadPromise;
}

function setBusy(busy, button) {
  checkoutBusy = busy;
  if (button) {
    currentPayButton = button;
    button.disabled = busy;
    button.dataset.originalText = button.dataset.originalText || button.textContent;
    button.textContent = busy ? 'Processing…' : button.dataset.originalText;
  } else if (currentPayButton && !busy) {
    currentPayButton.disabled = false;
    currentPayButton.textContent = currentPayButton.dataset.originalText || 'Pay Online';
    currentPayButton = null;
  }
}

export function isCheckoutBusy() {
  return checkoutBusy;
}

export async function openOnlineCheckout({ token, api, onVerified, onBusy, onError }) {
  if (checkoutBusy) {
    const msg = 'A payment is already in progress. Please wait or refresh the page.';
    onBusy?.(msg);
    onError?.(new Error(msg));
    return;
  }

  const payButton =
    document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
  setBusy(true, payButton);
  onBusy?.('Opening payment checkout…');

  try {
    await loadRazorpayScript();

    const payload = await api(`/api/orders/${token}/checkout`, {});

    const handler = new window.Razorpay({
      ...payload,
      handler: async response => {
        onBusy?.('Verifying payment…');
        try {
          await api(`/api/orders/${token}/verify`, response);
          await onVerified?.();
        } catch (e) {
          onError?.(e);
        } finally {
          setBusy(false);
        }
      },
      modal: {
        ondismiss: () => {
          setBusy(false);
          onError?.(
            new Error(
              'Checkout closed. If your account was debited, wait for verification or contact the shop before retrying.'
            )
          );
        },
      },
      theme: { color: '#11766e' },
    });

    handler.on('payment.failed', response => {
      setBusy(false);
      onError?.(
        new Error(
          response.error?.description ||
            'Payment did not complete. Check the order status before retrying.'
        )
      );
    });
    handler.open();
  } catch (e) {
    setBusy(false);
    onError?.(e);
  }
}
