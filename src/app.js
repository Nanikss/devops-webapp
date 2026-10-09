'use strict';

const express = require('express');
const { validateFlag, isValidKey } = require('./flags');

const OPS_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

function createApp({ store, logger, metrics, version = process.env.APP_VERSION || 'dev' }) {
  const app = express();
  // Shared with the server: flipped to true on SIGTERM so /readyz starts failing.
  const state = { shuttingDown: false };

  app.disable('x-powered-by');

  // Request metrics + access log. Registered first so it also sees body-parser errors.
  app.use((req, res, next) => {
    const stopTimer = metrics.httpDuration.startTimer();
    res.on('finish', () => {
      const route = req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      const seconds = stopTimer({ method: req.method, route, status_code: res.statusCode });
      const log = OPS_PATHS.has(req.path) ? logger.debug : logger.info;
      log('request', {
        method: req.method,
        path: req.path,
        route,
        status: res.statusCode,
        durationMs: Math.round(seconds * 1000),
      });
    });
    next();
  });

  app.use(express.json({ limit: '10kb' }));

  // --- ops endpoints ---------------------------------------------------------

  // Liveness: the process is up and the event loop is responding. Deliberately
  // checks nothing external, so a dependency outage never triggers restarts.
  app.get('/healthz', (req, res) => {
    res.json({ status: 'ok' });
  });

  // Readiness: should this pod receive traffic right now?
  app.get('/readyz', (req, res) => {
    if (state.shuttingDown) return res.status(503).json({ status: 'shutting_down' });
    return res.json({ status: 'ready', flags: store.size });
  });

  app.get('/version', (req, res) => {
    res.json({ version, node: process.version });
  });

  app.get('/metrics', async (req, res, next) => {
    try {
      res.set('Content-Type', metrics.registry.contentType);
      res.send(await metrics.registry.metrics());
    } catch (err) {
      next(err);
    }
  });

  // --- flags API -------------------------------------------------------------

  app.get('/api/flags', (req, res) => {
    res.json({ flags: store.list() });
  });

  app.get('/api/flags/:key', (req, res) => {
    const flag = store.get(req.params.key);
    if (!flag) return res.status(404).json({ error: `flag "${req.params.key}" not found` });
    return res.json(flag);
  });

  app.put('/api/flags/:key', (req, res) => {
    const { key } = req.params;
    if (!isValidKey(key)) {
      return res.status(400).json({ error: 'invalid flag key', details: ['key must match ^[a-z0-9][a-z0-9._-]{0,63}$'] });
    }
    const errors = validateFlag(req.body);
    if (errors.length) return res.status(400).json({ error: 'invalid flag', details: errors });

    const existed = store.has(key);
    const flag = store.set(key, req.body);
    logger.info('flag updated', { key, enabled: flag.enabled, rolloutPercent: flag.rolloutPercent, created: !existed });
    return res.status(existed ? 200 : 201).json(flag);
  });

  app.get('/api/flags/:key/evaluate', (req, res) => {
    const { userId } = req.query;
    if (typeof userId !== 'string' || userId.length === 0 || userId.length > 256) {
      return res.status(400).json({ error: 'userId query parameter is required (1-256 characters)' });
    }
    const result = store.evaluate(req.params.key, userId);
    if (!result) return res.status(404).json({ error: `flag "${req.params.key}" not found` });
    metrics.flagEvaluations.inc({ flag: result.key, result: String(result.enabled) });
    return res.json(result);
  });

  // --- fallbacks -------------------------------------------------------------

  app.use((req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  // Express recognises error handlers by their four arguments, so `next` stays.
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) {
      logger.error('unhandled error', { err, path: req.path });
      return res.status(500).json({ error: 'internal error' });
    }
    // body-parser errors: malformed JSON (400), body too large (413)
    return res.status(status).json({ error: err.type === 'entity.parse.failed' ? 'malformed JSON body' : err.message });
  });

  return { app, state };
}

module.exports = { createApp };
