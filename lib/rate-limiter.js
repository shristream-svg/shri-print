/**
 * Rate limiter for API endpoints
 * In-memory sliding window rate limiter with configurable limits
 */

// import { randomBytes } from 'node:crypto'; // unused

class RateLimiter {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 60000; // 1 minute default
    this.maxRequests = options.maxRequests || 100; // 100 requests per window
    this.keyPrefix = options.keyPrefix || 'rl:';
    this.store = new Map();
    this.cleanupInterval = null;
    this.startCleanup();
  }

  startCleanup() {
    this.cleanupInterval = setInterval(() => this.cleanup(), this.windowMs * 2);
    this.cleanupInterval.unref();
  }

  cleanup() {
    const now = Date.now();
    for (const [key, record] of this.store.entries()) {
      // Remove entries older than 2 windows
      if (now - record.windowStart > this.windowMs * 2) {
        this.store.delete(key);
      }
    }
  }

  _getWindowKey(identifier) {
    const windowStart = Date.now() - (Date.now() % this.windowMs);
    return `${this.keyPrefix}${identifier}:${windowStart}`;
  }

  check(identifier) {
    const key = this._getWindowKey(identifier);
    const now = Date.now();
    const windowStart = now - (now % this.windowMs);

    let record = this.store.get(key);
    if (!record) {
      record = { count: 0, windowStart, identifiers: new Set() };
      this.store.set(key, record);
    }

    record.count++;
    record.identifiers.add(identifier);

    const remaining = Math.max(0, this.maxRequests - record.count);
    const resetTime = windowStart + this.windowMs;

    return {
      allowed: record.count <= this.maxRequests,
      remaining,
      resetTime,
      total: record.count,
      limit: this.maxRequests,
    };
  }

  middleware() {
    return async (request, _env, _ctx) => {
      const ip =
        request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';

      const result = this.check(ip);

      // Add rate limit headers
      const headers = new Headers();
      headers.set('X-RateLimit-Limit', String(result.limit));
      headers.set('X-RateLimit-Remaining', String(result.remaining));
      headers.set('X-RateLimit-Reset', String(Math.ceil(result.resetTime / 1000)));

      if (!result.allowed) {
        const retryAfter = Math.ceil((result.resetTime - Date.now()) / 1000);
        headers.set('Retry-After', String(retryAfter));

        return new Response(
          JSON.stringify({
            error: 'Too many requests',
            message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
            retryAfter,
          }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              ...Object.fromEntries(headers),
            },
          }
        );
      }

      // Store rate limit info for downstream use
      request.rateLimit = result;
      return null; // Continue to next handler
    };
  }

  // Create a limiter for specific endpoints with different limits
  static createEndpointLimiter(endpoint, options = {}) {
    return new RateLimiter({
      windowMs: options.windowMs || 60000,
      maxRequests: options.maxRequests || 100,
      keyPrefix: `rl:${endpoint}:`,
    });
  }

  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.store.clear();
  }
}

// Pre-configured limiters for different endpoint types
export const limiters = {
  // Strict rate limiting for auth endpoints
  auth: new RateLimiter({ windowMs: 900000, maxRequests: 5, keyPrefix: 'rl:auth:' }), // 5 per 15 min

  // Moderate rate limiting for order creation
  orders: new RateLimiter({ windowMs: 60000, maxRequests: 30, keyPrefix: 'rl:orders:' }), // 30 per min

  // Generous rate limiting for file uploads
  upload: new RateLimiter({ windowMs: 60000, maxRequests: 10, keyPrefix: 'rl:upload:' }), // 10 per min

  // API endpoints
  api: new RateLimiter({ windowMs: 60000, maxRequests: 100, keyPrefix: 'rl:api:' }), // 100 per min

  // Webhook endpoints (higher limit for provider callbacks)
  webhook: new RateLimiter({ windowMs: 60000, maxRequests: 200, keyPrefix: 'rl:webhook:' }), // 200 per min

  // Admin endpoints
  admin: new RateLimiter({ windowMs: 60000, maxRequests: 200, keyPrefix: 'rl:admin:' }), // 200 per min
};

export { RateLimiter };
