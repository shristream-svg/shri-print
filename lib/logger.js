/**
 * Structured logging utility for SHRI Print
 * Provides consistent logging with levels, context, and JSON output
 */

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  NONE: 4,
};

const DEFAULT_LEVEL = process.env.NODE_ENV === 'production' ? LOG_LEVELS.INFO : LOG_LEVELS.DEBUG;

class Logger {
  constructor(context = '', level = DEFAULT_LEVEL) {
    this.context = context;
    this.level = level;
    this.startTime = Date.now();
  }

  child(context) {
    const child = new Logger(`${this.context}:${context}`, this.level);
    child.startTime = this.startTime;
    return child;
  }

  setLevel(level) {
    if (typeof level === 'string') {
      this.level = LOG_LEVELS[level.toUpperCase()] ?? DEFAULT_LEVEL;
    } else {
      this.level = level;
    }
  }

  _log(level, message, meta = {}) {
    if (level < this.level) return;

    const timestamp = new Date().toISOString();
    const elapsed = Date.now() - this.startTime;
    const logEntry = {
      timestamp,
      level: Object.keys(LOG_LEVELS).find(k => LOG_LEVELS[k] === level) || 'UNKNOWN',
      context: this.context,
      message,
      elapsed,
      ...meta,
    };

    // Console output with colors for development
    if (process.env.NODE_ENV !== 'production') {
      const colors = {
        DEBUG: '\x1b[36m', // cyan
        INFO: '\x1b[32m', // green
        WARN: '\x1b[33m', // yellow
        ERROR: '\x1b[31m', // red
      };
      const reset = '\x1b[0m';
      const color = colors[logEntry.level] || '';
      console.log(
        `${color}[${timestamp}] [${logEntry.level}] [${this.context}]${reset} ${message}`,
        meta && Object.keys(meta).length ? meta : ''
      );
    } else {
      // JSON output for production
      console.log(JSON.stringify(logEntry));
    }
  }

  debug(message, meta) {
    this._log(LOG_LEVELS.DEBUG, message, meta);
  }
  info(message, meta) {
    this._log(LOG_LEVELS.INFO, message, meta);
  }
  warn(message, meta) {
    this._log(LOG_LEVELS.WARN, message, meta);
  }
  error(message, meta) {
    this._log(LOG_LEVELS.ERROR, message, meta);
  }

  // Convenience methods
  request(method, url, status, duration, meta) {
    this.info(`${method} ${url} ${status} ${duration}ms`, {
      method,
      url,
      status,
      duration,
      ...meta,
    });
  }

  startup(component, meta) {
    this.info(`Starting ${component}`, { component, ...meta });
  }

  shutdown(component, meta) {
    this.info(`Shutting down ${component}`, { component, ...meta });
  }

  audit(action, details) {
    this.info(`AUDIT: ${action}`, { audit: true, action, ...details });
  }
}

// Default logger instance
const logger = new Logger('shri-print');

export { LOG_LEVELS, Logger, logger };
