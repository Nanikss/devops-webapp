'use strict';

const request = require('supertest');
const { createApp } = require('../src/app');
const { FlagStore } = require('../src/flags');
const { createMetrics } = require('../src/metrics');
const { createLogger } = require('../src/logger');

function build() {
  const store = new FlagStore({
    'dark-mode': { enabled: true, rolloutPercent: 100, description: 'Dark theme' },
    'new-quote-flow': { enabled: true, rolloutPercent: 25 },
  });
  return createApp({ store, metrics: createMetrics(), logger: createLogger({ level: 'silent' }) }).app;
}

describe('flags API', () => {
  let app;
  beforeEach(() => {
    app = build();
  });

  test('GET /api/flags lists the seeded flags sorted by key', async () => {
    const res = await request(app).get('/api/flags').expect(200);
    expect(res.body.flags.map((f) => f.key)).toEqual(['dark-mode', 'new-quote-flow']);
  });

  test('GET /api/flags/:key returns one flag, or 404', async () => {
    const res = await request(app).get('/api/flags/dark-mode').expect(200);
    expect(res.body).toMatchObject({ key: 'dark-mode', enabled: true, rolloutPercent: 100 });
    await request(app).get('/api/flags/nope').expect(404);
  });

  test('PUT creates a new flag (201) and then updates it (200)', async () => {
    await request(app).put('/api/flags/beta').send({ enabled: true, rolloutPercent: 10 }).expect(201);
    const updated = await request(app).put('/api/flags/beta').send({ enabled: false, rolloutPercent: 0 }).expect(200);
    expect(updated.body).toMatchObject({ key: 'beta', enabled: false, rolloutPercent: 0 });

    const res = await request(app).get('/api/flags/beta').expect(200);
    expect(res.body.enabled).toBe(false);
  });

  test('PUT rejects invalid bodies with 400 and a list of problems', async () => {
    const res = await request(app).put('/api/flags/beta').send({ enabled: 'yes', rolloutPercent: 101 }).expect(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining(['enabled must be a boolean', 'rolloutPercent must be an integer between 0 and 100']),
    );
    await request(app).get('/api/flags/beta').expect(404);
  });

  test('PUT rejects an invalid key and malformed JSON', async () => {
    await request(app).put('/api/flags/Bad%20Key').send({ enabled: true, rolloutPercent: 1 }).expect(400);
    const res = await request(app)
      .put('/api/flags/beta')
      .set('Content-Type', 'application/json')
      .send('{"enabled": tru')
      .expect(400);
    expect(res.body.error).toBe('malformed JSON body');
  });

  test('evaluate returns a stable answer per user', async () => {
    const first = await request(app).get('/api/flags/new-quote-flow/evaluate?userId=u-42').expect(200);
    const second = await request(app).get('/api/flags/new-quote-flow/evaluate?userId=u-42').expect(200);
    expect(second.body).toEqual(first.body);
    expect(first.body).toMatchObject({ key: 'new-quote-flow', userId: 'u-42', rolloutPercent: 25 });
    expect(typeof first.body.enabled).toBe('boolean');
  });

  test('evaluate requires userId and a known flag', async () => {
    await request(app).get('/api/flags/new-quote-flow/evaluate').expect(400);
    await request(app).get('/api/flags/nope/evaluate?userId=u-1').expect(404);
  });

  test('unknown routes return JSON 404', async () => {
    const res = await request(app).get('/nothing-here').expect(404);
    expect(res.body).toEqual({ error: 'not found' });
  });
});
