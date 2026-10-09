'use strict';

const path = require('path');
const request = require('supertest');
const { createApp } = require('../src/app');
const { FlagStore } = require('../src/flags');
const { createMetrics } = require('../src/metrics');
const { createLogger } = require('../src/logger');
const { start } = require('../src/server');

const silent = createLogger({ level: 'silent' });
const FLAGS_FILE = path.join(__dirname, '..', 'config', 'flags.json');

function build(opts = {}) {
  const store = new FlagStore({ beta: { enabled: true, rolloutPercent: 50 } });
  return createApp({ store, metrics: createMetrics(), logger: silent, ...opts });
}

describe('ops endpoints', () => {
  test('/healthz returns ok', async () => {
    const res = await request(build().app).get('/healthz').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  test('/readyz is 200 normally and 503 once shutdown has started', async () => {
    const { app, state } = build();
    await request(app).get('/readyz').expect(200);
    state.shuttingDown = true;
    const res = await request(app).get('/readyz').expect(503);
    expect(res.body.status).toBe('shutting_down');
  });

  test('/version reports the configured version', async () => {
    const res = await request(build({ version: 'abc1234' }).app).get('/version').expect(200);
    expect(res.body.version).toBe('abc1234');
  });

  test('/metrics exposes default metrics and the request histogram', async () => {
    const { app } = build();
    await request(app).get('/api/flags/beta/evaluate?userId=u-1').expect(200);
    const res = await request(app).get('/metrics').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('# TYPE http_request_duration_seconds histogram');
    expect(res.text).toMatch(
      /http_request_duration_seconds_bucket\{le="0\.005",method="GET",route="\/api\/flags\/:key\/evaluate",status_code="200"\}/,
    );
    expect(res.text).toContain('process_cpu_user_seconds_total');
    expect(res.text).toMatch(/flag_evaluations_total\{flag="beta",result="(true|false)"\} 1/);
  });
});

describe('server lifecycle', () => {
  test('graceful shutdown: readiness fails first, then the server closes', async () => {
    const { server, shutdown } = await start({ port: 0, flagsFile: FLAGS_FILE, shutdownDelayMs: 300, logger: silent });
    await request(server).get('/readyz').expect(200);

    const done = shutdown('SIGTERM');
    // During the delay the pod still serves traffic but reports not ready.
    await request(server).get('/readyz').expect(503);
    await request(server).get('/api/flags').expect(200);

    await done;
    expect(server.listening).toBe(false);
  });

  test('startup fails fast when FLAGS_FILE is invalid', async () => {
    await expect(start({ port: 0, flagsFile: path.join(__dirname, 'missing.json'), logger: silent })).rejects.toThrow(
      /cannot read flags file/,
    );
  });
});
