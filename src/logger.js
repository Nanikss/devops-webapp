'use strict';

// Minimal structured logger: one JSON object per line on stdout, which is what
// `kubectl logs` and most log shippers (Fluent Bit, Loki, CloudWatch) expect.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function serialize(fields) {
  if (!fields) return {};
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value instanceof Error ? { message: value.message, stack: value.stack } : value;
  }
  return out;
}

function createLogger({ level = process.env.LOG_LEVEL || 'info', stream = process.stdout } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(lvl, msg, fields) {
    if (LEVELS[lvl] < threshold) return;
    const line = { time: new Date().toISOString(), level: lvl, msg, ...serialize(fields) };
    stream.write(`${JSON.stringify(line)}\n`);
  }

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}

module.exports = { createLogger };
