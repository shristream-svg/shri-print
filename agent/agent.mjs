import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../lib/logger.js';
import { exec, inventory, printDocument } from './engine.mjs';

const log = logger.child('agent');
const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
await mkdir('runtime/agent-cache', { recursive: true });

const agentScript = fileURLToPath(import.meta.url)
  .replaceAll('\\', '/')
  .toLowerCase();

async function ownsProcess(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const env = { ...process.env };
  delete env.PSModulePath;
  try {
    const { stdout } = await exec(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
      ],
      { env, windowsHide: true, timeout: 8000 }
    );
    return stdout.replaceAll('\\', '/').toLowerCase().includes(agentScript);
  } catch {
    return true;
  }
}

let lock;
try {
  lock = await open('runtime/agent.lock', 'wx');
} catch (e) {
  if (e.code !== 'EEXIST') throw e;
  const pid = Number(await readFile('runtime/agent.lock', 'utf8'));
  if (await ownsProcess(pid)) {
    log.info('SHRI Print Agent is already running, exiting.');
    process.exit(0);
  }
  await unlink('runtime/agent.lock');
  lock = await open('runtime/agent.lock', 'wx');
}
await lock.writeFile(String(process.pid));

let writeQueue = Promise.resolve();
function save(name, data) {
  const value = JSON.stringify(data, null, 2);
  const next = writeQueue.then(async () => {
    await writeFile(name + '.tmp', value, { mode: 0o600 });
    await rename(name + '.tmp', name);
  });
  writeQueue = next.catch(() => {});
  return next;
}

let config,
  printers = [],
  inventoryAt = 0,
  heartbeatAt = 0,
  printing = false,
  stopped = false;
let inventoryBusy = false,
  heartbeatBusy = false,
  lastError = null,
  lastInventoryAttempt = 0,
  lastCleanup = 0;

const journalFile = 'runtime/agent-journal.json';
let journal = {};
try {
  journal = JSON.parse(await readFile(journalFile, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}

// Mark interrupted jobs as failed on startup
for (const entry of Object.values(journal)) {
  if (!entry.ack && entry.status === 'started') {
    entry.status = 'failed';
    entry.error =
      'Agent was interrupted during printing. Output is uncertain. Check physical paper and Windows queue before a manual retry.';
  }
}
await save(journalFile, journal);

async function readConfig() {
  const c = JSON.parse((await readFile('agent/config.json', 'utf8')).replace(/^\uFEFF/, ''));
  const u = new URL(c.server);
  if (
    u.protocol !== 'https:' &&
    !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))
  ) {
    throw new Error('Use HTTPS for a remote server.');
  }
  if (!['live', 'dry-run'].includes(c.mode)) {
    throw new Error('Invalid agent mode.');
  }
  return c;
}

async function saveHealth() {
  await save('runtime/agent-health.json', {
    pid: process.pid,
    mode: config?.mode || 'unknown',
    heartbeatAt,
    inventoryAt,
    printing,
    lastError,
    server: config?.server || '',
  });
}

async function request(c, url, body, extra = {}) {
  const r = await fetch(c.server.replace(/\/$/, '') + url, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer ' + c.token,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) {
    let msg = 'HTTP ' + r.status;
    try {
      msg = (await r.json()).error || msg;
    } catch {}
    throw new Error(msg);
  }
  return r;
}

async function heartbeat() {
  if (stopped || heartbeatBusy) return;
  heartbeatBusy = true;
  try {
    config = await readConfig();
    const c = { ...config };
    await request(c, '/api/agent/heartbeat', {
      id: c.id || 'shri-shop-pc',
      printers,
      mode: c.mode,
    });
    heartbeatAt = Date.now();
    await saveHealth();
    log.debug('Heartbeat sent', { mode: c.mode, printerCount: printers.length });
  } catch (e) {
    lastError = 'Connection: ' + e.message;
    log.error('Heartbeat failed', { error: e.message });
    await saveHealth().catch(() => {});
  } finally {
    heartbeatBusy = false;
  }
}

async function refreshInventory() {
  if (inventoryBusy || printing || stopped) return;
  inventoryBusy = true;
  lastInventoryAttempt = Date.now();
  try {
    printers = await inventory();
    inventoryAt = Date.now();
    lastError = null;
    log.debug('Inventory refreshed', { count: printers.length });
  } catch (e) {
    lastError = 'Printers: ' + e.message;
    log.error('Inventory failed', { error: e.message });
  } finally {
    inventoryBusy = false;
    await saveHealth().catch(() => {});
  }
}

async function finish(c, entry) {
  if (entry.server && entry.server.replace(/\/$/, '') !== c.server.replace(/\/$/, '')) {
    throw new Error(
      'Pending print result belongs to a different server. Restore its configured server before proceeding.'
    );
  }
  await request(c, '/api/agent/result/' + entry.id, {
    claim: entry.claim,
    status: entry.status,
    error: entry.error,
  });
  entry.ack = true;
  await save(journalFile, journal);
  try {
    await unlink(path.join(root, 'runtime/agent-cache', entry.id + '.pdf'));
  } catch {}
}

config = await readConfig();

const heartbeatTimer = setInterval(() => {
  void heartbeat();
}, 5000);
const inventoryTimer = setInterval(() => {
  if (Date.now() - lastInventoryAttempt >= 20000) void refreshInventory();
}, 2000);

void heartbeat();
void refreshInventory();
log.startup('SHRI Print Agent', { mode: config.mode, server: config.server });

async function stop() {
  stopped = true;
  clearInterval(heartbeatTimer);
  clearInterval(inventoryTimer);
  if (printing) return;
  await writeQueue;
  await lock.close();
  if (Number(await readFile('runtime/agent.lock', 'utf8').catch(() => 0)) === process.pid) {
    await unlink('runtime/agent.lock');
  }
  log.shutdown('SHRI Print Agent');
  process.exit(0);
}

process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

while (!stopped) {
  try {
    config = await readConfig();
    const c = { ...config };

    // Finish any unacknowledged jobs
    for (const entry of Object.values(journal)) {
      if (!entry.ack) await finish(c, entry);
    }

    // Process print jobs in live mode
    if (c.mode === 'live' && !inventoryBusy && inventoryAt && Date.now() - inventoryAt < 60000) {
      const { job, download } = await (
        await request(c, '/api/agent/claim', { mode: 'live' })
      ).json();
      if (job) {
        if (journal[job.claim]) {
          await request(c, '/api/agent/result/' + job.id, {
            claim: job.claim,
            status: 'failed',
            error: 'Duplicate delivery of an attempted lease. Check paper before retrying.',
          });
          continue;
        }
        printing = true;
        await saveHealth();
        const entry = {
          id: job.id,
          claim: job.claim,
          status: 'started',
          created: Date.now(),
          server: c.server,
        };
        journal[job.claim] = entry;
        await save(journalFile, journal);

        const file = path.join(root, 'runtime/agent-cache', job.id + '.pdf');
        try {
          const bytes = new Uint8Array(
            await (await request(c, download, null, { 'x-claim': job.claim })).arrayBuffer()
          );
          if (
            bytes.length > 45 * 1024 * 1024 ||
            new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-'
          ) {
            throw new Error('Invalid PDF received from print server.');
          }
          await writeFile(file, bytes, { mode: 0o600 });
          await printDocument(
            c.engine || path.join(root, 'runtime/bin/SumatraPDF.exe'),
            job,
            file,
            printers
          );
          entry.status = 'submitted';
          entry.error = null;
          log.info('Windows accepted job', { jobId: job.id.slice(0, 8), printer: job.printer });
        } catch (e) {
          entry.status = 'failed';
          entry.error = e.killed
            ? 'Print command timed out. Output is uncertain. Check Windows queue before retrying.'
            : e.message;
          log.error('Print failed', { jobId: job.id.slice(0, 8), error: entry.error });
        } finally {
          printing = false;
          await save(journalFile, journal);
          await saveHealth();
        }
        await finish(c, entry);
      }
    }

    // Cleanup old journal entries
    if (Date.now() - lastCleanup > 3600000) {
      for (const [k, v] of Object.entries(journal)) {
        if (v.ack && v.created < Date.now() - 30 * 86400000) delete journal[k];
      }
      await save(journalFile, journal);
      lastCleanup = Date.now();
    }
  } catch (e) {
    lastError = e.message;
    log.error('Agent loop error', { error: e.message, stack: e.stack });
    await saveHealth().catch(() => {});
  }
  await new Promise(resolve => setTimeout(resolve, 2000));
}

await stop();
