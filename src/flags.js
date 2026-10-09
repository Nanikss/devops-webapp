'use strict';

const crypto = require('crypto');
const fs = require('fs');

const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ALLOWED_FIELDS = ['enabled', 'rolloutPercent', 'description'];

function isValidKey(key) {
  return typeof key === 'string' && KEY_PATTERN.test(key);
}

// Returns a list of validation errors (empty when the flag is valid).
function validateFlag(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return ['flag must be a JSON object'];
  }
  const errors = [];
  for (const field of Object.keys(input)) {
    if (!ALLOWED_FIELDS.includes(field)) errors.push(`unknown field "${field}"`);
  }
  if (typeof input.enabled !== 'boolean') {
    errors.push('enabled must be a boolean');
  }
  const pct = input.rolloutPercent;
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
    errors.push('rolloutPercent must be an integer between 0 and 100');
  }
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 200)) {
    errors.push('description must be a string of at most 200 characters');
  }
  return errors;
}

// Stable bucket 0-99 for a (flag, user) pair. Hashing key+userId means the same
// user always gets the same answer, and different flags roll out to different
// slices of users instead of always hitting the same 10%.
function bucketFor(key, userId) {
  const digest = crypto.createHash('sha256').update(`${key}:${userId}`).digest();
  return digest.readUInt32BE(0) % 100;
}

class FlagStore {
  constructor(initial = {}) {
    this.flags = new Map();
    for (const [key, flag] of Object.entries(initial)) this.set(key, flag);
  }

  get size() {
    return this.flags.size;
  }

  list() {
    return [...this.flags.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  get(key) {
    return this.flags.get(key) || null;
  }

  has(key) {
    return this.flags.has(key);
  }

  set(key, { enabled, rolloutPercent, description }) {
    const flag = { key, enabled, rolloutPercent, updatedAt: new Date().toISOString() };
    if (description !== undefined) flag.description = description;
    this.flags.set(key, flag);
    return flag;
  }

  evaluate(key, userId) {
    const flag = this.get(key);
    if (!flag) return null;
    const bucket = bucketFor(key, userId);
    let reason;
    if (!flag.enabled) reason = 'disabled';
    else if (bucket < flag.rolloutPercent) reason = 'in_rollout';
    else reason = 'outside_rollout';
    return {
      key,
      userId,
      enabled: reason === 'in_rollout',
      reason,
      bucket,
      rolloutPercent: flag.rolloutPercent,
    };
  }
}

// Loads the seed file. In Kubernetes this file is a ConfigMap mounted as a volume.
// Any problem throws, so a bad config fails the pod at startup (visible as
// CrashLoopBackOff) instead of serving wrong flags.
function loadFlagsFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read flags file ${file}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`flags file ${file} is not valid JSON: ${err.message}`);
  }

  const flags = parsed && parsed.flags;
  if (flags === null || typeof flags !== 'object' || Array.isArray(flags)) {
    throw new Error(`flags file ${file} must contain a "flags" object`);
  }
  for (const [key, flag] of Object.entries(flags)) {
    if (!isValidKey(key)) throw new Error(`flags file ${file}: invalid flag key "${key}"`);
    const errors = validateFlag(flag);
    if (errors.length) throw new Error(`flags file ${file}: flag "${key}": ${errors.join('; ')}`);
  }
  return new FlagStore(flags);
}

module.exports = { FlagStore, loadFlagsFile, validateFlag, isValidKey, bucketFor };
