/**
 * Health check utilities for SHRI Print
 * Provides comprehensive health checks for all system components
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * Check if a process is running
 */
async function checkProcess(pid) {
  if (!Number.isInteger(pid) || pid < 1) return { alive: false, reason: 'Invalid PID' };
  try {
    process.kill(pid, 0);
    return { alive: true };
  } catch {
    return { alive: false, reason: 'Process not found' };
  }
}

/**
 * Check database connectivity
 */
async function checkDatabase(db) {
  try {
    const result = await db.prepare('SELECT 1 as ok').first();
    return { healthy: !!result?.ok, latency: null };
  } catch (e) {
    return { healthy: false, error: e.message };
  }
}

/**
 * Check printer connectivity and status
 */
async function checkPrinters() {
  try {
    const printers = await exec(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
      Get-Printer | Select-Object Name, PrinterStatus, WorkOffline | ConvertTo-Json -Compress`,
      ],
      { windowsHide: true, timeout: 10000 }
    );

    const parsed = JSON.parse(printers.stdout.replace(/^\uFEFF/, ''));
    const printersArray = Array.isArray(parsed) ? parsed : [parsed];

    return {
      healthy: printersArray.length > 0,
      count: printersArray.length,
      printers: printersArray.map(p => ({
        name: p.Name,
        status: p.PrinterStatus,
        offline: p.WorkOffline,
      })),
    };
  } catch (e) {
    return { healthy: false, error: e.message };
  }
}

/**
 * Check disk space
 */
async function checkDiskSpace() {
  try {
    const { stdout } = await exec(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-PSDrive C | Select-Object Used, Free | ConvertTo-Json -Compress`,
      ],
      { windowsHide: true, timeout: 5000 }
    );

    const parsed = JSON.parse(stdout.replace(/^\uFEFF/, ''));
    const freeGB = parsed.Free / 1024 / 1024 / 1024;
    const usedGB = parsed.Used / 1024 / 1024 / 1024;

    return {
      healthy: freeGB > 1, // At least 1GB free
      freeGB: Math.round(freeGB * 100) / 100,
      usedGB: Math.round(usedGB * 100) / 100,
      totalGB: Math.round((freeGB + usedGB) * 100) / 100,
    };
  } catch (e) {
    return { healthy: false, error: e.message };
  }
}

/**
 * Check memory usage
 */
function checkMemory() {
  const usage = process.memoryUsage();
  const heapUsedMB = Math.round((usage.heapUsed / 1024 / 1024) * 100) / 100;
  const heapTotalMB = Math.round((usage.heapTotal / 1024 / 1024) * 100) / 100;
  const rssMB = Math.round((usage.rss / 1024 / 1024) * 100) / 100;

  return {
    healthy: heapUsedMB < 500, // Less than 500MB heap
    heapUsedMB,
    heapTotalMB,
    rssMB,
    externalMB: Math.round((usage.external / 1024 / 1024) * 100) / 100,
  };
}

/**
 * Check network connectivity to cloud server
 */
async function checkCloudConnectivity(cloudUrl) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${cloudUrl}/api/health`, {
      signal: controller.signal,
      method: 'GET',
    });
    clearTimeout(timeout);
    return {
      healthy: response.ok,
      status: response.status,
      latency: null, // Could add timing
    };
  } catch (e) {
    return { healthy: false, error: e.message };
  }
}

/**
 * Check agent health from agent-health.json
 */
async function checkAgentHealth() {
  try {
    const health = JSON.parse(await readFile(path.join(root, 'runtime/agent-health.json'), 'utf8'));
    const now = Date.now();
    const stale = now - (health.heartbeatAt || 0) > 60000; // Stale if no heartbeat for 60s

    return {
      healthy: !stale && health.pid,
      pid: health.pid,
      mode: health.mode,
      heartbeatAt: health.heartbeatAt,
      inventoryAt: health.inventoryAt,
      printing: health.printing,
      lastError: health.lastError,
      stale,
    };
  } catch (e) {
    return { healthy: false, error: e.message };
  }
}

/**
 * Comprehensive health check
 */
export async function runHealthChecks(options = {}) {
  const {
    db,
    cloudUrl,
    includeDisk = true,
    includeMemory = true,
    includePrinters = false, // Expensive, optional
    includeCloud = true,
  } = options;

  const startTime = Date.now();
  const checks = {};

  // Core checks (always run)
  checks.memory = includeMemory ? checkMemory() : { skipped: true };
  checks.disk = includeDisk ? await checkDiskSpace() : { skipped: true };
  checks.agent = await checkAgentHealth();

  // Optional checks
  if (includePrinters) checks.printers = await checkPrinters();
  if (includeCloud && cloudUrl) checks.cloud = await checkCloudConnectivity(cloudUrl);
  if (db) checks.database = await checkDatabase(db);

  // Overall health
  const criticalChecks = ['memory', 'disk', 'agent'];
  const optionalChecks = ['printers', 'cloud', 'database'];
  const allChecks = { ...checks };

  const criticalHealthy = criticalChecks.every(c => allChecks[c]?.healthy !== false);
  const optionalHealthy = optionalChecks.every(
    c => !allChecks[c] || allChecks[c]?.healthy !== false
  );

  const overall =
    criticalHealthy && optionalHealthy ? 'healthy' : criticalHealthy ? 'degraded' : 'unhealthy';

  return {
    status: overall,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    duration: Date.now() - startTime,
    checks,
  };
}

/**
 * Express/Worker compatible health endpoint handler
 */
export async function healthHandler(request, env, options = {}) {
  const health = await runHealthChecks({
    db: env?.DB,
    cloudUrl: options.cloudUrl,
    includePrinters: request?.url?.includes('full') || false,
  });

  const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503;

  return new Response(JSON.stringify(health, null, 2), {
    status: statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
}

export {
  checkAgentHealth,
  checkCloudConnectivity,
  checkDatabase,
  checkDiskSpace,
  checkMemory,
  checkPrinters,
  checkProcess,
};
