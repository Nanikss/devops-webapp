'use strict';

const http = require('http');
const path = require('path');
const { createApp } = require('./app');
const { loadFlagsFile } = require('./flags');
const { createMetrics } = require('./metrics');
const { createLogger } = require('./logger');

const DEFAULT_FLAGS_FILE = path.join(__dirname, '..', 'config', 'flags.json');
const FORCE_EXIT_MS = 20000;

function envNumber(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : Number(value);
}

/**
 * Loads flags, starts the HTTP server and returns a shutdown function.
 *
 * Shutdown sequence (what Kubernetes needs for zero-downtime rollouts):
 *   1. mark not ready, so /readyz returns 503 and the pod leaves the Service endpoints
 *   2. keep serving for shutdownDelayMs while kube-proxy / ingress catch up
 *   3. stop accepting connections and let in-flight requests finish
 */
async function start({
  port = envNumber('PORT', 3000),
  flagsFile = process.env.FLAGS_FILE || DEFAULT_FLAGS_FILE,
  shutdownDelayMs = envNumber('SHUTDOWN_DELAY_MS', 0),
  logger = createLogger(),
} = {}) {
  const store = loadFlagsFile(flagsFile);
  const metrics = createMetrics();
  const { app, state } = createApp({ store, logger, metrics });
  const server = http.createServer(app);
  let shutdownPromise = null;

  function shutdown(signal = 'manual') {
    if (shutdownPromise) return shutdownPromise;
    state.shuttingDown = true;
    logger.info('shutdown started', { signal, delayMs: shutdownDelayMs });
    shutdownPromise = new Promise((resolve) => {
      setTimeout(() => {
        server.close(() => {
          logger.info('server closed');
          resolve();
        });
        if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      }, shutdownDelayMs);
    });
    return shutdownPromise;
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      logger.info('listening', { port: server.address().port, flagsFile, flags: store.size });
      resolve({ server, state, shutdown });
    });
  });
}

if (require.main === module) {
  const logger = createLogger();
  start({ logger })
    .then(({ shutdown }) => {
      const onSignal = (signal) => {
        setTimeout(() => {
          logger.error('graceful shutdown timed out, forcing exit');
          process.exit(1);
        }, FORCE_EXIT_MS).unref();
        shutdown(signal).then(() => process.exit(0));
      };
      process.once('SIGTERM', onSignal);
      process.once('SIGINT', onSignal);
    })
    .catch((err) => {
      logger.error('startup failed', { err });
      process.exit(1);
    });
}

module.exports = { start };
