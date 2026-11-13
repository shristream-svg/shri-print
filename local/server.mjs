import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHealthChecks as _runHealthChecks, healthHandler } from '../lib/health.js';
import { logger } from '../lib/logger.js';
import { limiters } from '../lib/rate-limiter.js';
import { storage } from './storage.mjs';

const log = logger.child('local-server');
const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);

await mkdir('runtime', { recursive: true });

let secrets;
try {
  secrets = JSON.parse(await readFile('runtime/secrets.json', 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
  secrets = {
    ADMIN_TOKEN: randomBytes(32).toString('hex'),
    AGENT_TOKEN: randomBytes(32).toString('hex'),
  };
  await writeFile('runtime/secrets.json', JSON.stringify(secrets), { mode: 0o600 });
}

const store = await storage(path.join(root, 'runtime'));
const env = { ...secrets, ...store, LOCAL_SERVER: true };
for (const k of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']) {
  if (process.env[k]) env[k] = process.env[k];
}

const worker = await import('../dist/server/index.js');
const port = Number(process.env.SHRI_PORT || 4888);
const isLocal = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);

// Apply rate limiting
const rateLimiter = limiters.api;

const server = http.createServer(async (req, res) => {
  const startTime = Date.now();
  const requestId = randomBytes(8).toString('hex');

  try {
    const host = req.headers.host || `localhost:${port}`;
    const url = new URL(req.url, `http://${host}`);

    // Host validation
    if (
      !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host) &&
      !/^192\.168\.\d+\.\d+(?::\d+)?$/.test(host) &&
      !/^10\.\d+\.\d+\.\d+(?::\d+)?$/.test(host)
    ) {
      res.writeHead(403);
      res.end('Use the configured shop address.');
      return;
    }

    // Health check endpoint (no auth, no rate limit)
    if (url.pathname === '/api/health' || url.pathname === '/api/health/full') {
      const response = await healthHandler(
        req,
        {
          ...env,
          DB: store.db,
        },
        {
          cloudUrl: env.CLOUD_SERVER,
        }
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
      return;
    }

    // Local login endpoint
    if (url.pathname === '/local-login') {
      if (!isLocal(req.socket.remoteAddress)) {
        res.writeHead(403);
        res.end('Use this shortcut on the shop computer.');
        return;
      }
      let conf;
      try {
        conf = JSON.parse((await readFile('agent/config.json', 'utf8')).replace(/^\uFEFF/, ''));
      } catch {}
      if (conf?.server.startsWith('https://') && url.searchParams.get('local') !== '1') {
        const { hmac } = await import('../lib/core.js');
        const expires = String(Date.now() + 60000);
        const nonce = randomUUID();
        const query = new URLSearchParams({
          expires,
          nonce,
          signature: await hmac(env.ADMIN_TOKEN, `desktop|${expires}|${nonce}`),
        });
        res.writeHead(302, {
          Location: `${conf.server.replace(/\/$/, '')}/api/desktop-login?${query}`,
          'Referrer-Policy': 'no-referrer',
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }
      const r = await worker.default.fetch(
        new Request(`${url.origin}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: env.ADMIN_TOKEN }),
        }),
        env,
        {}
      );
      res.writeHead(302, {
        Location: '/admin',
        'Set-Cookie': r.headers.get('set-cookie'),
      });
      res.end();
      return;
    }

    // Apply rate limiting for API endpoints
    const rlResult = rateLimiter.check(req.socket.remoteAddress || 'unknown');
    if (!rlResult.allowed) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'X-RateLimit-Limit': String(rlResult.limit),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.ceil(rlResult.resetTime / 1000)),
        'Retry-After': String(Math.ceil((rlResult.resetTime - Date.now()) / 1000)),
      });
      res.end(
        JSON.stringify({
          error: 'Too many requests',
          retryAfter: Math.ceil((rlResult.resetTime - Date.now()) / 1000),
        })
      );
      return;
    }

    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', String(rlResult.limit));
    res.setHeader('X-RateLimit-Remaining', String(rlResult.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(rlResult.resetTime / 1000)));

    // Local agent mode control
    if (url.pathname === '/api/local/agent-mode') {
      if (!isLocal(req.socket.remoteAddress) || req.method !== 'POST') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end('{"error":"Open the shop panel on localhost to control this PC."}');
        return;
      }
      const check = await worker.default.fetch(
        new Request(`${url.origin}/api/admin/state`, { headers }),
        env,
        {}
      );
      if (check.status !== 200) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":"Shop sign in required."}');
        return;
      }
      if (req.headers.origin && req.headers.origin !== url.origin) {
        res.writeHead(403);
        res.end();
        return;
      }
      const b = JSON.parse(Buffer.concat(chunks));
      if (!['live', 'dry-run'].includes(b.mode)) throw new Error('Invalid mode');
      const conf = JSON.parse(await readFile('agent/config.json', 'utf8'));
      conf.mode = b.mode;
      await writeFile('agent/config.json.tmp', JSON.stringify(conf, null, 2));
      await rename('agent/config.json.tmp', 'agent/config.json');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }

    // Local status endpoint
    if (url.pathname === '/api/local/status' && req.method === 'GET') {
      if (!isLocal(req.socket.remoteAddress)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end('{"error":"Local access only."}');
        return;
      }
      let health = {};
      try {
        health = JSON.parse(await readFile('runtime/agent-health.json', 'utf8'));
      } catch (_e) {}
      let agentConf = {};
      try {
        agentConf = JSON.parse(
          (await readFile('agent/config.json', 'utf8')).replace(/^\uFEFF/, '')
        );
      } catch (_e) {}
      const lockPid = Number(await readFile('runtime/agent.lock', 'utf8').catch(() => '0'));
      let alive = false;
      try {
        if (Number.isInteger(lockPid) && lockPid > 0 && health.pid === lockPid) {
          process.kill(lockPid, 0);
          alive = true;
        }
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          pid: lockPid,
          alive,
          mode: agentConf.mode || 'unknown',
          heartbeatAt: health.heartbeatAt || null,
          inventoryAt: health.inventoryAt || null,
          printing: health.printing || false,
          lastError: health.lastError || null,
          server: health.server || agentConf.server || '',
          now: Date.now(),
        })
      );
      return;
    }

    // Read request body
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v && !['x-shri-client', 'cf-connecting-ip'].includes(k)) {
        headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      }
    }
    headers.set('x-shri-client', req.socket.remoteAddress || 'unknown');

    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 43 * 1024 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Maximum combined upload size is 40 MB.' }));
        return;
      }
      chunks.push(chunk);
    }

    // Forward to worker
    const request = new Request(url, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });

    const response = await worker.default.fetch(request, env, {
      waitUntil: p => p.catch(() => {}),
    });

    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    log.error('Request error', { error: e.message, stack: e.stack, requestId });
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"The local server could not complete the request."}');
    }
  } finally {
    const duration = Date.now() - startTime;
    log.request(req.method, req.url, res.statusCode || 0, duration, { requestId });
  }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    log.info('SHRI Print server is already running.');
    process.exit(0);
  }
  log.error('Server error', { error: e.message });
  process.exit(1);
});

server.listen(port, '::1', () => {
  log.startup('SHRI Print local server', { port, url: `http://localhost:${port}/local-login` });
});

// Periodic cleanup
const cleanupInterval = setInterval(async () => {
  try {
    const r = await worker.default.fetch(
      new Request(`http://localhost:${port}/api/admin/cleanup`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` },
      }),
      env,
      {}
    );
    if (!r.ok) log.warn('Cleanup pending');
  } catch (e) {
    log.error('Cleanup error', { error: e.message });
  }
}, 3600000);
cleanupInterval.unref();

// Graceful shutdown
process.on('SIGTERM', () => {
  log.shutdown('SHRI Print local server');
  server.close(() => {
    store.db.close();
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  log.shutdown('SHRI Print local server (SIGINT)');
  server.close(() => {
    store.db.close();
    process.exit(0);
  });
});
