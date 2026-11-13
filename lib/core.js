export const defaults = {
  shopName: 'SHRI CYBER CAFE',
  subtitle: 'Bahadurgarh · Scan. Upload. Print.',
  rates: { bw: [300, 300, 300], color: [800, 800, 800] },
  cash: true,
  cashAuto: false,
  upi: '',
  payee: 'SHRI CYBER CAFE',
  paymentProfiles: [],
  activePaymentProfile: '',
  online: false,
  mapping: { bw: '', color: '' },
  retentionHours: 24,
  photoPackages: { 5: 3000, 10: 6000, 20: 12000, 30: 18000 },
  duplexSheetPrice: 500,
  hostedPaymentUrl: '',
};
export function paymentProfile(s) {
  return (
    s.paymentProfiles?.find(p => p.id === s.activePaymentProfile) ||
    (s.upi
      ? {
          id: 'legacy',
          label: 'UPI payment',
          upi: s.upi,
          payee: s.payee,
          qr: '',
        }
      : null)
  );
}
export function ensure(ok, message, status = 400) {
  if (!ok) throw Object.assign(new Error(message), { status });
}
export function parsePages(input, total) {
  ensure(
    Number.isInteger(total) && total > 0 && total <= 1000,
    'Document must contain 1–1000 pages.'
  );
  if (!input?.trim()) return Array.from({ length: total }, (_, i) => i + 1);
  ensure(typeof input === 'string' && input.length < 4000, 'Page range is too long.');
  const out = new Set();
  for (const segment of input.split(',')) {
    const m = segment.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    ensure(m, 'Use page numbers like 1-3,5.');
    const a = Number(m[1]),
      b = Number(m[2] ?? m[1]);
    ensure(a >= 1 && a <= b && b <= total, 'Page range is outside the document.');
    for (let i = a; i <= b; i++) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}
export function progressivePrice(count, rates) {
  ensure(Number.isInteger(count) && count > 0 && count <= 100000, 'Invalid page count.');
  ensure(
    Array.isArray(rates) &&
      rates.length === 3 &&
      rates.every(x => Number.isInteger(x) && x >= 0 && x <= 100000),
    'Invalid price tiers.'
  );
  return (
    rates[0] + Math.min(Math.max(count - 1, 0), 9) * rates[1] + Math.max(count - 10, 0) * rates[2]
  );
}
export function photoPackagePrice(qty, s) {
  const p = s.photoPackages || defaults.photoPackages;
  ensure([5, 10, 20, 30].includes(qty), 'Invalid photo package quantity.');
  const price = p[qty];
  return price !== undefined && price !== null ? price : defaults.photoPackages[qty];
}
export function validateOptions(o) {
  ensure(['document', 'resume', 'passport', 'id'].includes(o.service), 'Unknown service.');
  ensure(['bw', 'color'].includes(o.color), 'Choose a print mode.');
  ensure(['A4', 'A3', 'A2', 'A1'].includes(o.paper), 'Invalid paper size.');
  ensure(
    Number.isInteger(o.copies) && o.copies >= 1 && o.copies <= 100,
    'Copies must be between 1 and 100.'
  );
  ensure(['portrait', 'landscape'].includes(o.orientation), 'Invalid orientation.');
  ensure(typeof o.duplex === 'boolean', 'Invalid duplex choice.');
  // Cash-only for new customer flow; upi/online preserved for existing orders accounting
  ensure(
    o.method === 'cash' || o.method === 'upi' || o.method === 'online',
    'Choose a payment method.'
  );
  ensure(!o.mobile || /^\d{10}$/.test(o.mobile), 'Enter a 10-digit mobile number.');
  if (o.service === 'passport') {
    ensure([5, 10, 20, 30].includes(o.photoQty), 'Invalid photo package.');
    ensure(
      Number.isInteger(o.copies) && o.copies >= 1 && o.copies <= 10,
      'Photo sets must be 1-10.'
    );
    ensure(o.paper === 'A4', 'Passport photos use A4 paper.');
    ensure(o.color === 'color', 'Passport photos are color only.');
    ensure(o.orientation === 'portrait', 'Passport photos use portrait orientation.');
    ensure(o.duplex === false, 'Passport photos are single-sided.');
  }
  if (o.service === 'resume') {
    ensure(o.paper === 'A4', 'Resume uses A4 paper.');
    ensure(o.copies === 1, 'Resume includes one printed copy.');
    ensure(o.duplex === false, 'Resume is single-sided.');
  }
  ensure(o.rotation === undefined || [0, 90, 180, 270].includes(o.rotation), 'Invalid rotation.');
  ensure(o.swapSides === undefined || typeof o.swapSides === 'boolean', 'Invalid side order.');
  return o;
}
export function quote(count, o, s) {
  ensure(Number.isInteger(count) && count > 0 && count <= 100000, 'Invalid page count.');
  if (o.service === 'resume') return 3000;
  if (o.service === 'passport') {
    return photoPackagePrice(o.photoQty, s) * o.copies;
  }
  if (o.duplex && o.color === 'color') {
    return (
      progressivePrice(count * o.copies, s.rates.color) * { A4: 1, A3: 2, A2: 4, A1: 8 }[o.paper]
    );
  }
  const duplexPrice = s.duplexSheetPrice ?? defaults.duplexSheetPrice;
  if (o.duplex) {
    const sheets = Math.floor(count / 2);
    const odd = count % 2;
    const bwFirst = s.rates.bw[0];
    return (
      (sheets * duplexPrice + odd * bwFirst) * o.copies * { A4: 1, A3: 2, A2: 4, A1: 8 }[o.paper]
    );
  }
  return (
    progressivePrice(count * o.copies, s.rates[o.color]) * { A4: 1, A3: 2, A2: 4, A1: 8 }[o.paper]
  );
}
export function validateSettings(s) {
  s = {
    ...s,
    duplexSheetPrice: s.duplexSheetPrice ?? defaults.duplexSheetPrice,
    hostedPaymentUrl: s.hostedPaymentUrl ?? '',
  };
  ensure(
    typeof s.shopName === 'string' && s.shopName.trim().length > 0 && s.shopName.length <= 80,
    'Enter the shop name.'
  );
  ensure(typeof s.subtitle === 'string' && s.subtitle.length <= 160, 'Subtitle is too long.');
  for (const rates of Object.values(s.rates)) progressivePrice(1, rates);
  ensure(s.rates.bw && s.rates.color, 'Both price tiers are required.');
  ensure(
    typeof s.cash === 'boolean' && typeof s.cashAuto === 'boolean' && typeof s.online === 'boolean',
    'Invalid payment settings.'
  );
  ensure(
    typeof s.upi === 'string' &&
      (!s.upi || /^[a-zA-Z0-9.\-_]{2,}@[a-zA-Z0-9.\-_]{2,}$/.test(s.upi)),
    'Enter a valid UPI ID.'
  );
  ensure(typeof s.payee === 'string' && s.payee.length <= 80, 'Payee name is too long.');
  ensure(
    Array.isArray(s.paymentProfiles || []) && (s.paymentProfiles || []).length <= 8,
    'Save up to 8 payment QR profiles.'
  );
  for (const p of s.paymentProfiles || []) {
    ensure(
      /^[a-f0-9-]{36}$/.test(p.id || '') &&
        typeof p.label === 'string' &&
        p.label.trim() &&
        p.label.length <= 60 &&
        typeof p.payee === 'string' &&
        p.payee.length <= 80,
      'Invalid QR profile.'
    );
    ensure(
      (p.qr && /^[a-f0-9-]{36}\.(png|jpg)$/.test(p.qr)) ||
        (p.upi && /^[a-zA-Z0-9.\-_]{2,}@[a-zA-Z0-9.\-_]{2,}$/.test(p.upi)),
      'Each QR profile needs a QR image or valid UPI ID.'
    );
  }
  ensure(
    !s.activePaymentProfile || (s.paymentProfiles || []).some(p => p.id === s.activePaymentProfile),
    'Active QR profile was not found.'
  );
  ensure(s.cash || paymentProfile(s) || s.online, 'Enable at least one payment method.');
  ensure(
    Number.isInteger(s.retentionHours) && s.retentionHours >= 1 && s.retentionHours <= 168,
    'Document retention must be 1–168 hours.'
  );
  if (s.photoPackages) {
    ensure(typeof s.photoPackages === 'object', 'Photo packages must be an object.');
    for (const [k, v] of Object.entries(s.photoPackages)) {
      ensure([5, 10, 20, 30].includes(Number(k)), 'Invalid photo package quantity.');
      ensure(
        Number.isInteger(v) && v >= 0 && v <= 50000,
        'Photo package price must be 0–500 rupees.'
      );
    }
  }
  ensure(
    Number.isInteger(s.duplexSheetPrice) && s.duplexSheetPrice >= 0 && s.duplexSheetPrice <= 100000,
    'Duplex sheet price must be 0–1000 rupees.'
  );
  ensure(
    typeof s.hostedPaymentUrl === 'string' &&
      (!s.hostedPaymentUrl ||
        (() => {
          try {
            const u = new URL(s.hostedPaymentUrl);
            return (
              u.protocol === 'https:' &&
              u.hostname === 'razorpay.me' &&
              s.hostedPaymentUrl.length <= 500
            );
          } catch {
            return false;
          }
        })()),
    'Hosted payment URL must be a valid HTTPS razorpay.me link under 500 characters.'
  );
  return s;
}
export function publicOrder(o) {
  const {
    customerMetadata: _customerMetadata,
    idOriginals: _idOriginals,
    sourceFiles: _sourceFiles,
    preparedSources: _preparedSources,
    uploadManifest: _uploadManifest,
    ...safeOptions
  } = JSON.parse(o.options);
  return {
    version: String(o.updated),
    id: o.id,
    updated: o.updated,
    token: o.token,
    created: o.created,
    pages: o.pages,
    amount: o.amount,
    method: o.method,
    payment: o.payment,
    status: o.status,
    options: safeOptions,
    error: o.error,
  };
}
export async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)))]
    .map(x => x.toString(16).padStart(2, '0'))
    .join('');
}
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
