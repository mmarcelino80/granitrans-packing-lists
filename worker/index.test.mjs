import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandler } from './index.mjs';

const app = 'https://packing.example.test';
const worker = 'https://packing.preview-fixture.workers.dev';
const endpoint = `${worker}/extract`;
const guideRequestId = 'ec79c21d-8a2a-4e1d-8040-e24fed6d3f48';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAsTj2FAAAAABJRU5ErkJggg==', 'base64');
const operator = 'operador@example.test';
const secondOperator = 'revisor@example.test';
const issuer = 'https://packing-fixture.cloudflareaccess.com';
const env = {
  APP_ORIGIN: app,
  WORKER_ORIGIN: worker,
  ACCESS_TEAM_DOMAIN: new URL(issuer).hostname,
  ACCESS_AUD: 'synthetic packing list access audience',
  EXTRACTION_ENABLED: 'true',
  ALLOWED_EMAILS: `${operator},${secondOperator}`,
  SESSION_SECRET: 'synthetic signing fixture, never deployed',
  OPENAI_API_KEY: 'synthetic API fixture, never sent',
};

const accessKey = await crypto.subtle.generateKey({
  name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]),
}, true, ['sign', 'verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', accessKey.publicKey), kid: 'access-key-fixture' };

async function accessFetcher(url) {
  assert.equal(url, `${issuer}/cdn-cgi/access/certs`);
  return Response.json({ keys: [jwk] });
}

async function makeAccess(email = operator) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = { email, iss: issuer, aud: [env.ACCESS_AUD], exp: Math.floor(Date.now() / 1000) + 120 };
  const unsigned = `${encode({ alg: 'RS256', kid: jwk.kid })}.${encode(claims)}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', accessKey.privateKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${Buffer.from(signature).toString('base64url')}`;
}

async function makeBearer(email = operator) {
  const payload = Buffer.from(JSON.stringify({
    email,
    expiresAt: Date.now() + 60_000,
    origin: app,
  })).toString('base64url');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const unsigned = 'v1.' + payload;
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(unsigned));
  return 'Bearer ' + unsigned + '.' + Buffer.from(signed).toString('base64url');
}

function extractRequest({ url = endpoint, origin = app, authorization, access, name = 'Guia%20sint%C3%A9tica.png', requestId = guideRequestId } = {}) {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Origin': origin,
      'Content-Type': 'image/png',
      'X-Guide-Name': name,
      ...(requestId !== null ? { 'X-Guide-Request': requestId } : {}),
      ...(authorization ? { Authorization: authorization } : {}),
      ...(access ? { 'Cf-Access-Jwt-Assertion': access } : {}),
    },
    body: png,
  });
}

function quota(status) {
  return {
    idFromName: () => 'synthetic-instance',
    get: () => ({ fetch: async () => new Response(null, { status }) }),
  };
}

test('disabled runtime and cross-origin or unauthenticated calls cannot start an extraction', async () => {
  let calls = 0;
  const handler = createHandler(async () => { calls++; assert.fail('unexpected invocation'); }, { accessFetcher });
  const [authorization, access, mismatched] = await Promise.all([makeBearer(), makeAccess(), makeAccess(secondOperator)]);
  assert.equal((await handler(extractRequest({ authorization, access }), { ...env, EXTRACTION_ENABLED: 'false' })).status, 503);
  const crossOrigin = await handler(extractRequest({ origin: 'https://other.example.test' }), env);
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.headers.get('Access-Control-Allow-Origin'), null);
  const unauthorized = await handler(extractRequest(), env);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('Access-Control-Allow-Origin'), app);
  assert.equal((await handler(extractRequest({ authorization }), env)).status, 401);
  assert.equal((await handler(extractRequest({ access }), env)).status, 401);
  const wrongAccount = await handler(extractRequest({ authorization, access: mismatched }), env);
  assert.equal(wrongAccount.status, 403);
  assert.equal((await wrongAccount.json()).code, 'session_identity_mismatch');
  const wrongHost = await handler(extractRequest({ url: 'https://other.example.test/extract', authorization, access }), env);
  assert.equal(wrongHost.status, 403);
  assert.equal(wrongHost.headers.get('Access-Control-Allow-Origin'), null);
  for (const [name, value, code] of [
    ['WORKER_ORIGIN', worker + '/', 'worker_origin_invalid'],
    ['APP_ORIGIN', app + '/', 'app_origin_invalid'],
  ]) {
    const response = await handler(new Request(worker + '/auth'), { ...env, [name]: value });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'A extração ainda não está configurada.', code });
  }
  assert.equal(calls, 0);
});

test('preflight accepts only the Pages origin, POST and an allowed header set even while disabled', async () => {
  const unexpected = async () => { assert.fail('unexpected network invocation'); };
  const handler = createHandler(unexpected, { accessFetcher: unexpected });
  const disabled = { ...env, EXTRACTION_ENABLED: 'false' };
  const options = (origin = app, method = 'POST', requested = 'content-type, Authorization, X-GUIDE-REQUEST, x-guide-name') => (
    new Request(endpoint, { method: 'OPTIONS', headers: {
      Origin: origin, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': requested,
    } })
  );
  const response = await handler(options(), disabled);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), app);
  assert.match(response.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  assert.match(response.headers.get('Access-Control-Allow-Headers'), /X-Guide-Request/);
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), 'true');
  assert.match(response.headers.get('Vary'), /Access-Control-Request-Headers/);
  const wrongOrigin = await handler(options('https://other.example.test'), disabled);
  assert.equal(wrongOrigin.status, 403);
  assert.equal(wrongOrigin.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await handler(options(worker), disabled)).status, 403);
  assert.equal((await handler(options(app, 'GET'), disabled)).status, 405);
  const wrongHeaders = await handler(options(app, 'POST', 'content-type, X-Unknown'), disabled);
  assert.equal(wrongHeaders.status, 403);
  assert.equal(wrongHeaders.headers.get('Access-Control-Allow-Headers'), null);
});

test('standalone GET /auth can validate Access with extraction disabled', async () => {
  const handler = createHandler(async () => { assert.fail('unexpected upstream invocation'); }, { accessFetcher });
  const url = `${worker}/auth`;
  const disabled = { ...env, EXTRACTION_ENABLED: 'false' };
  assert.equal((await handler(new Request(url), disabled)).status, 401);
  const authenticated = await handler(new Request(url, { headers: {
    'Cf-Access-Jwt-Assertion': await makeAccess(),
  } }), disabled);
  assert.equal(authenticated.status, 200);
  assert.match(authenticated.headers.get('Content-Type'), /^text\/html/);
  assert.equal(authenticated.headers.get('Cache-Control'), 'no-store');
  assert.equal(authenticated.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await handler(new Request(url, { method: 'POST' }), disabled)).status, 405);
});

test('session check requires the same Worker origin and matching identities even while disabled', async () => {
  const unexpected = async () => { assert.fail('unexpected upstream invocation'); };
  const handler = createHandler(unexpected, { accessFetcher });
  const [authorization, access, otherAccess] = await Promise.all([makeBearer(), makeAccess(), makeAccess(secondOperator)]);
  const check = ({ origin = worker, token = authorization, assertion = access } = {}) => new Request(`${worker}/session-check`, {
    method: 'POST', headers: {
      Origin: origin,
      ...(token ? { Authorization: token } : {}),
      ...(assertion ? { 'Cf-Access-Jwt-Assertion': assertion } : {}),
    },
  });
  const disabled = {
    ...env, EXTRACTION_ENABLED: 'false', OPENAI_API_KEY: '', USAGE_QUOTA: { get: unexpected },
  };
  const accepted = await handler(check(), disabled);
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { authenticated: true });
  assert.equal(accepted.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await handler(check({ origin: app }), disabled)).status, 403);
  assert.equal((await handler(check({ token: null }), disabled)).status, 401);
  assert.equal((await handler(check({ assertion: null }), disabled)).status, 401);
  assert.equal((await handler(check({ assertion: otherAccess }), disabled)).status, 403);
});

test('quota is enforced before a Responses API request; successful calls include verified provenance', async () => {
  let calls = 0;
  const handler = createHandler(async (url, request) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(JSON.parse(request.body).store, false);
    return Response.json({
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({
        loadingWarehouse: null, unloadingWarehouse: null, loadingDate: null,
        pages: [{ page: 1, lines: [], totals: [], issues: [] }], totals: [], issues: [],
      }) }] }],
    });
  }, { accessFetcher });
  const [authorization, access] = await Promise.all([makeBearer(), makeAccess()]);
  const auth = { authorization, access };
  const absentId = await handler(extractRequest({ ...auth, requestId: null }), {
    ...env, USAGE_QUOTA: quota(204),
  });
  assert.equal(absentId.status, 400);
  assert.equal((await absentId.json()).code, 'invalid_request_id');

  const invalidId = await handler(extractRequest({ ...auth, requestId: 'incorrect' }), {
    ...env, USAGE_QUOTA: quota(204),
  });
  assert.equal(invalidId.status, 400);

  const invalidName = await handler(extractRequest({ ...auth, name: '%2Fpath.png' }), {
    ...env, USAGE_QUOTA: quota(204),
  });
  assert.equal(invalidName.status, 400);

  const rateLimited = await handler(extractRequest(auth), { ...env, USAGE_QUOTA: quota(429) });
  assert.equal(rateLimited.status, 429);
  assert.ok(Number(rateLimited.headers.get('Retry-After')) > 0);
  const duplicate = await handler(extractRequest(auth), { ...env, USAGE_QUOTA: quota(409) });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, 'duplicate_request');
  assert.equal(calls, 0);

  const accepted = await handler(extractRequest(auth), { ...env, USAGE_QUOTA: quota(204) });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get('Access-Control-Allow-Origin'), app);
  const [document] = (await accepted.json()).documents;
  assert.equal(document.name, 'Guia sintética.png');
  assert.match(document.id, /^[a-f0-9]{64}$/);
  assert.equal(document.pages[0].page, 1);
  const bridgeAccepted = await handler(extractRequest({ ...auth, origin: worker }), { ...env, USAGE_QUOTA: quota(204) });
  assert.equal(bridgeAccepted.status, 200);
  assert.equal(bridgeAccepted.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(calls, 2);
});
