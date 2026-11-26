import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import { QuotaCounter, accessLogin, authenticate, reserveQuota, verifyAccessToken } from './security.mjs';

const issuer = 'https://granitrans.cloudflareaccess.com';
const now = Date.parse('2026-11-19T12:00:00Z');
const domain = 'https://packing-list.example.workers.dev';
const env = {
  ACCESS_TEAM_DOMAIN: issuer,
  ACCESS_AUD: 'packing-list-access-test',
  APP_ORIGIN: 'https://mmarcelino80.github.io',
  ALLOWED_EMAILS: 'one@example.com, TWO@example.com',
  SESSION_SECRET: 'test-only secret deliberately configured for unit tests',
};
const claims = {
  iss: issuer,
  aud: [env.ACCESS_AUD],
  email: 'One@example.com',
  exp: now / 1000 + 20 * 60,
};
let privateKey;
let publicKey;

before(async () => {
  const pair = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  }, true, ['sign', 'verify']);
  privateKey = pair.privateKey;
  publicKey = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'test-key' };
});

function jsonPart(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function accessToken(overrides = {}, headerOverrides = {}) {
  const header = jsonPart({ alg: 'RS256', kid: 'test-key', ...headerOverrides });
  const payload = jsonPart({ ...claims, ...overrides });
  const unsigned = header + '.' + payload;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, Buffer.from(unsigned));
  return unsigned + '.' + Buffer.from(signature).toString('base64url');
}

async function keySet(url, options) {
  assert.equal(url, issuer + '/cdn-cgi/access/certs');
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  return Response.json({ keys: [publicKey] });
}

const authDependencies = { now, fetchImpl: keySet };

test('accepts an Access RS256 JWT for the configured issuer, audience and account', async () => {
  assert.deepEqual(await verifyAccessToken(await accessToken(), env, authDependencies), {
    email: 'one@example.com',
    expiresAt: claims.exp * 1000,
  });
});

test('refuses missing, invalid or wrongly scoped Access credentials', async () => {
  const wrongTokens = [
    null,
    await accessToken({ iss: 'https://other.cloudflareaccess.com' }),
    await accessToken({ aud: ['other-application'] }),
    await accessToken({ exp: now / 1000 }),
    await accessToken({ nbf: now / 1000 + 5 }),
    await accessToken({}, { kid: 'unknown' }),
    await accessToken({}, { alg: 'HS256' }),
  ];
  const [header, payload, signature] = (await accessToken()).split('.');
  wrongTokens.push(header + '.' + payload + '.' + flippedSignature(signature));

  for (const token of wrongTokens) {
    await assert.rejects(verifyAccessToken(token, env, authDependencies), { status: 401 });
  }

  await assert.rejects(
    verifyAccessToken(await accessToken({ email: 'outsider@example.com' }), env, authDependencies),
    { status: 403 },
  );
  await assert.rejects(
    verifyAccessToken(await accessToken(), { ...env, ALLOWED_EMAILS: 'one@a.com,two@a.com,three@a.com' }, authDependencies),
    { status: 503 },
  );
});

test('fails closed when the Access key provider is unavailable', async () => {
  await assert.rejects(verifyAccessToken(await accessToken(), env, {
    now,
    fetchImpl: async () => new Response(null, { status: 503 }),
  }), { status: 503 });
});

function flippedSignature(signature) {
  return (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
}

function sessionRequest(token) {
  return new Request(domain + '/extract', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
}

test('popup issues a short verified session scoped to the exact application origin and nonce', async () => {
  const nonce = 'c'.repeat(43);
  const request = new Request(domain + '/auth?nonce=' + nonce, {
    headers: { 'Cf-Access-Jwt-Assertion': await accessToken() },
  });
  const response = await accessLogin(request, env, authDependencies);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.ok(response.headers.get('Content-Security-Policy').includes("frame-ancestors 'none'"));
  const [match, payload] = (await response.text()).match(/\}\)\((\{"target":[^\n]+\})\);<\/script>/u);
  assert.ok(match);
  const { target, nonce: returnedNonce, token, expiresAt } = JSON.parse(payload);
  assert.equal(target, env.APP_ORIGIN);
  assert.equal(returnedNonce, nonce);
  assert.equal(expiresAt, now + 15 * 60 * 1000);

  assert.equal(await authenticate(sessionRequest(token), env, now), 'one@example.com');
  await assert.rejects(authenticate(sessionRequest(token), env, expiresAt), { status: 401 });
  await assert.rejects(authenticate(sessionRequest(token), { ...env, APP_ORIGIN: 'https://other.example.com' }, now), { status: 401 });
  await assert.rejects(authenticate(sessionRequest(token), { ...env, ALLOWED_EMAILS: 'two@example.com' }, now), { status: 403 });
  await assert.rejects(authenticate(sessionRequest(token), { ...env, SESSION_SECRET: '' }, now), { status: 503 });
  const [version, signed, signature] = token.split('.');
  await assert.rejects(authenticate(sessionRequest(version + '.' + signed + '.' + flippedSignature(signature)), env, now), { status: 401 });
});

test('rejects popup without a valid nonce and /extract with no bearer', async () => {
  await assert.rejects(accessLogin(new Request(domain + '/auth?nonce=oops'), env, authDependencies), { status: 400 });
  await assert.rejects(authenticate(new Request(domain + '/extract'), env, now), { status: 401 });
});

test('standalone /auth prepares a verification without an opener nonce', async () => {
  const headers = { 'Cf-Access-Jwt-Assertion': await accessToken() };
  const page = await accessLogin(new Request(domain + '/auth', { headers }), env, authDependencies);
  assert.match(await page.text(), /"nonce":null/);
  assert.match(page.headers.get('Content-Security-Policy'), /connect-src 'self'/);
  await assert.rejects(accessLogin(new Request(domain + '/auth'), env, authDependencies), { status: 401 });
});

function quotaBinding(options, initial = []) {
  const entries = new Map(initial);
  let pending = Promise.resolve();
  const storage = {
    transaction(callback) {
      const result = pending.then(() => callback({
        get: async key => structuredClone(entries.get(key)),
        put: async (key, value) => entries.set(key, structuredClone(value)),
      }));
      pending = result.catch(() => {});
      return result;
    },
  };
  const instance = new QuotaCounter({ storage }, options);
  const binding = {
    idFromName: name => name,
    get: () => ({ fetch: (url, init) => instance.fetch(new Request(url, init)) }),
  };
  return { entries, binding };
}

function attempt(documentId = 'a'.repeat(64), requestId = crypto.randomUUID()) {
  return { documentId, requestId };
}

test('reserves quotas for authorized accounts with atomic global and per-user limits', async () => {
  const options = { ...env, QUOTA_PER_USER_DAILY: '2', QUOTA_GLOBAL_DAILY: '3' };
  const { entries, binding } = quotaBinding(options);
  options.USAGE_QUOTA = binding;

  const results = await Promise.allSettled(
    Array.from({ length: 4 }, () => reserveQuota(options, 'one@example.com', attempt())),
  );
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  for (const result of results.filter(result => result.status === 'rejected')) {
    assert.equal(result.reason.status, 429);
    assert.ok(result.reason.retryAfter > 0 && result.reason.retryAfter <= 86400);
  }
  await reserveQuota(options, 'two@example.com', attempt());
  await assert.rejects(reserveQuota(options, 'two@example.com', attempt()), { status: 429 });
  await assert.rejects(reserveQuota(options, 'outside@example.com', attempt()), { status: 403 });

  const daily = entries.get('daily');
  assert.equal(daily.total, 3);
  assert.deepEqual(Object.values(daily.users), [2, 1]);
  assert.ok(Object.keys(daily.users).every(user => /^[A-Za-z0-9_-]{43}$/u.test(user)));
});

test('default quota admits 25 requests per user and restores capacity at midnight UTC', async (context) => {
  let clock = Date.parse('2030-01-31T23:59:55Z');
  context.mock.method(Date, 'now', () => clock);
  const options = { ...env };
  const { entries, binding } = quotaBinding(options);
  options.USAGE_QUOTA = binding;
  const firstDay = Array.from({ length: 25 }, () => attempt());
  const duplicateError = { status: 409, code: 'duplicate_request' };

  await Promise.all(firstDay.map((request) => reserveQuota(options, 'one@example.com', request)));
  await assert.rejects(reserveQuota(options, 'one@example.com', attempt()), { status: 429, retryAfter: 5 });
  await assert.rejects(reserveQuota(options, 'one@example.com', firstDay[0]), duplicateError);
  const usage = entries.get('daily');
  assert.equal(usage.total, 25);
  assert.deepEqual(Object.values(usage.users), [25]);

  clock = Date.parse('2030-02-01T00:00:00Z');
  await assert.rejects(reserveQuota(options, 'one@example.com', firstDay[0]), duplicateError);
  await reserveQuota(options, 'one@example.com', attempt());
  await assert.rejects(reserveQuota(options, 'one@example.com', firstDay[0]), duplicateError);
  const nextDay = entries.get('daily');
  assert.equal(nextDay.day, usage.day + 1);
  assert.equal(nextDay.total, 1);
  assert.deepEqual(Object.values(nextDay.users), [1]);
});

test('default global quota rejects the 51st request even from a newly authorized user', async () => {
  const options = { ...env };
  const { entries, binding } = quotaBinding(options);
  options.USAGE_QUOTA = binding;

  await Promise.all(Array.from({ length: 25 }, () => reserveQuota(options, 'one@example.com', attempt())));
  await Promise.all(Array.from({ length: 25 }, () => reserveQuota(options, 'two@example.com', attempt())));
  const updated = { ...options, ALLOWED_EMAILS: 'one@example.com,three@example.com' };
  await assert.rejects(reserveQuota(updated, 'three@example.com', attempt()), { status: 429 });
  const usage = entries.get('daily');
  assert.equal(usage.total, 50);
  assert.deepEqual(Object.values(usage.users), [25, 25]);
});

test('admits a concurrent or later repeat only once per account, document and request', async () => {
  const options = { ...env, QUOTA_PER_USER_DAILY: '4', QUOTA_GLOBAL_DAILY: '4' };
  const { entries, binding } = quotaBinding(options);
  options.USAGE_QUOTA = binding;
  const sameAttempt = attempt();
  const duplicateError = { status: 409, code: 'duplicate_request' };

  const results = await Promise.allSettled(
    Array.from({ length: 4 }, () => reserveQuota(options, 'one@example.com', sameAttempt)),
  );
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  for (const result of results.filter(({ status }) => status === 'rejected')) {
    assert.equal(result.reason.status, duplicateError.status);
    assert.equal(result.reason.code, duplicateError.code);
  }
  await reserveQuota(options, 'two@example.com', sameAttempt);
  await reserveQuota(options, 'one@example.com', attempt('b'.repeat(64), sameAttempt.requestId));
  await reserveQuota(options, 'one@example.com', attempt());
  await assert.rejects(reserveQuota(options, 'one@example.com', sameAttempt), duplicateError);
  assert.equal(entries.get('daily').total, 4);
  const stored = JSON.stringify(entries.get('daily'));
  assert.ok(!stored.includes(sameAttempt.documentId));
  assert.ok(!stored.includes(sameAttempt.requestId));
  assert.ok(!stored.includes('one@example.com'));
});

test('checks previous-day admissions without consuming the new day quota', async () => {
  const options = { ...env, QUOTA_PER_USER_DAILY: '1', QUOTA_GLOBAL_DAILY: '1' };
  const { entries, binding } = quotaBinding(options);
  options.USAGE_QUOTA = binding;
  const oldAttempt = attempt();
  await reserveQuota(options, 'one@example.com', oldAttempt);
  const yesterday = entries.get('daily');
  entries.set('daily', { ...yesterday, day: yesterday.day - 1 });

  await assert.rejects(reserveQuota(options, 'one@example.com', oldAttempt), { status: 409 });
  await reserveQuota(options, 'one@example.com', attempt());
  assert.equal(entries.get('daily').total, 1);
  await assert.rejects(reserveQuota(options, 'one@example.com', oldAttempt), { status: 409 });
});

test('resets prior-day quota and fails closed when configuration, binding or storage fails', async () => {
  const options = { ...env, QUOTA_PER_USER_DAILY: '1', QUOTA_GLOBAL_DAILY: '1' };
  const { entries, binding } = quotaBinding(options, [['daily', { day: 0, total: 3, users: {} }]]);
  options.USAGE_QUOTA = binding;
  await reserveQuota(options, 'one@example.com', attempt());
  assert.equal(entries.get('daily').total, 1);
  assert.ok(entries.get('daily').day > 0);

  await assert.rejects(reserveQuota(env, 'one@example.com', attempt()), { status: 503 });
  await assert.rejects(reserveQuota({ ...options, QUOTA_PER_USER_DAILY: '26' }, 'one@example.com', attempt()), { status: 503 });
  await assert.rejects(reserveQuota({ ...options, QUOTA_GLOBAL_DAILY: '51' }, 'one@example.com', attempt()), { status: 503 });
  await assert.rejects(reserveQuota({ ...options, QUOTA_GLOBAL_DAILY: '0' }, 'one@example.com', attempt()), { status: 503 });
  await assert.rejects(reserveQuota({
    ...options,
    USAGE_QUOTA: { ...binding, get: () => { throw new Error('storage failed'); } },
  }, 'one@example.com', attempt()), { status: 503 });
});
