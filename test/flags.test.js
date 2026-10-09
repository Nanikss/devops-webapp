'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { FlagStore, loadFlagsFile, validateFlag } = require('../src/flags');

function writeTemp(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flags-test-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

const users = (n) => Array.from({ length: n }, (_, i) => `user-${i}`);

describe('validateFlag', () => {
  test('accepts a valid flag', () => {
    expect(validateFlag({ enabled: true, rolloutPercent: 50, description: 'x' })).toEqual([]);
  });

  test.each([
    [{ rolloutPercent: 10 }, 'enabled must be a boolean'],
    [{ enabled: 'yes', rolloutPercent: 10 }, 'enabled must be a boolean'],
    [{ enabled: true, rolloutPercent: 101 }, 'rolloutPercent must be an integer between 0 and 100'],
    [{ enabled: true, rolloutPercent: -1 }, 'rolloutPercent must be an integer between 0 and 100'],
    [{ enabled: true, rolloutPercent: 12.5 }, 'rolloutPercent must be an integer between 0 and 100'],
    [{ enabled: true, rolloutPercent: 10, owner: 'me' }, 'unknown field "owner"'],
    [[], 'flag must be a JSON object'],
  ])('rejects %j', (input, message) => {
    expect(validateFlag(input)).toContain(message);
  });
});

describe('evaluate', () => {
  test('is deterministic for the same flag and user, across store instances', () => {
    const a = new FlagStore({ beta: { enabled: true, rolloutPercent: 50 } });
    const b = new FlagStore({ beta: { enabled: true, rolloutPercent: 50 } });
    for (const user of users(50)) {
      const first = a.evaluate('beta', user);
      expect(a.evaluate('beta', user)).toEqual(first);
      expect(b.evaluate('beta', user).enabled).toBe(first.enabled);
    }
  });

  test('0% rollout enables nobody', () => {
    const store = new FlagStore({ beta: { enabled: true, rolloutPercent: 0 } });
    expect(users(1000).filter((u) => store.evaluate('beta', u).enabled)).toHaveLength(0);
  });

  test('100% rollout enables everybody', () => {
    const store = new FlagStore({ beta: { enabled: true, rolloutPercent: 100 } });
    expect(users(1000).every((u) => store.evaluate('beta', u).enabled)).toBe(true);
  });

  test('50% rollout enables roughly half of 1000 users', () => {
    const store = new FlagStore({ beta: { enabled: true, rolloutPercent: 50 } });
    const enabled = users(1000).filter((u) => store.evaluate('beta', u).enabled).length;
    expect(enabled).toBeGreaterThan(430);
    expect(enabled).toBeLessThan(570);
  });

  test('a disabled flag is off even at 100%', () => {
    const store = new FlagStore({ beta: { enabled: false, rolloutPercent: 100 } });
    const result = store.evaluate('beta', 'user-1');
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe('disabled');
  });

  test('raising the percentage only adds users, it never flips existing ones off', () => {
    const at20 = new FlagStore({ beta: { enabled: true, rolloutPercent: 20 } });
    const at60 = new FlagStore({ beta: { enabled: true, rolloutPercent: 60 } });
    for (const user of users(500)) {
      if (at20.evaluate('beta', user).enabled) expect(at60.evaluate('beta', user).enabled).toBe(true);
    }
  });

  test('returns null for an unknown flag', () => {
    expect(new FlagStore().evaluate('missing', 'user-1')).toBeNull();
  });
});

describe('loadFlagsFile', () => {
  test('loads flags from a JSON file', () => {
    const file = writeTemp('flags.json', JSON.stringify({ flags: { beta: { enabled: true, rolloutPercent: 5 } } }));
    const store = loadFlagsFile(file);
    expect(store.size).toBe(1);
    expect(store.get('beta')).toMatchObject({ key: 'beta', enabled: true, rolloutPercent: 5 });
  });

  test('throws a clear error when the file is missing', () => {
    expect(() => loadFlagsFile(path.join(os.tmpdir(), 'does-not-exist.json'))).toThrow(/cannot read flags file/);
  });

  test('throws on invalid JSON', () => {
    expect(() => loadFlagsFile(writeTemp('bad.json', '{ "flags": '))).toThrow(/not valid JSON/);
  });

  test('throws when the "flags" object is missing', () => {
    expect(() => loadFlagsFile(writeTemp('empty.json', '{}'))).toThrow(/must contain a "flags" object/);
  });

  test('throws and names the flag when one entry is invalid', () => {
    const file = writeTemp('invalid.json', JSON.stringify({ flags: { beta: { enabled: true, rolloutPercent: 150 } } }));
    expect(() => loadFlagsFile(file)).toThrow(/flag "beta": rolloutPercent/);
  });

  // The same loader runs in the pod, so a typo in a ConfigMap source fails CI
  // instead of crash-looping a rollout.
  test.each(['config/flags.json', 'k8s/base/flags.json', 'k8s/overlays/prod/flags.json'])('shipped %s is valid', (rel) => {
    expect(loadFlagsFile(path.join(__dirname, '..', rel)).size).toBeGreaterThan(0);
  });
});
