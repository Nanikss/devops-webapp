'use strict';

const client = require('prom-client');

// Each app instance gets its own registry so tests don't leak metrics into each other.
function createMetrics() {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });

  const flagEvaluations = new client.Counter({
    name: 'flag_evaluations_total',
    help: 'Flag evaluations by flag and result',
    labelNames: ['flag', 'result'],
    registers: [registry],
  });

  return { registry, httpDuration, flagEvaluations };
}

module.exports = { createMetrics };
