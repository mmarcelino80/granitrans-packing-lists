import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandler } from './index.mjs';

const app = 'https://packing.example.test';
const endpoint = 'https://api.example.test/extract';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAsTj2FAAAAABJRU5ErkJggg==', 'base64');
const env = {
  APP_ORIGIN: app,
  EXTRACTION_ENABLED: 'true',
  ALLOWED_EMAILS: 'operador@example.test',
  SESSION_SECRET: 'synthetic signing fixture, never deployed',
  OPENAI_API_KEY: 'synthetic API fixture, never sent',
};

async function makeBearer() {
  const payload = Buffer.from(JSON.stringify({
    email: env.ALLOWED_EMAILS,
    expiresAt: Date.now() + 60_000,
    origin: app,
  })).toString('base64url');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const unsigned = 'v1.' + payload;
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(unsigned));
  return 'Bearer ' + unsigned + '.' + Buffer.from(signed).toString('base64url');
}

function extractRequest({ origin = app, authorization, name = 'Guia%20sint%C3%A9tica.png' } = {}) {
  return new Request(endpoint, {
    method: 'POST',
    headers: {
      'Origin': origin,
      'Content-Type': 'image/png',
      'X-Guide-Name': name,
      ...(authorization ? { Authorization: authorization } : {}),
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
  const handler = createHandler(async () => { calls++; throw new Error('unexpected invocation'); });
  assert.equal((await handler(extractRequest(), { ...env, EXTRACTION_ENABLED: 'false' })).status, 503);
  const crossOrigin = await handler(extractRequest({ origin: 'https://other.example.test' }), env);
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.headers.get('Access-Control-Allow-Origin'), null);
  const unauthorized = await handler(extractRequest(), env);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('Access-Control-Allow-Origin'), app);
  assert.equal(calls, 0);
});

test('preflight is origin-scoped and does not make an authenticated request', async () => {
  const handler = createHandler(async () => { assert.fail('unexpected invocation'); });
  const response = await handler(new Request(endpoint, {
    method: 'OPTIONS',
    headers: { Origin: app, 'Access-Control-Request-Method': 'POST' },
  }), env);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), app);
  assert.match(response.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
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
        pages: [{ page: 1, lines: [], totals: [], issues: [] }], totals: [], issues: [],
      }) }] }],
    });
  });
  const authorization = await makeBearer();
  const invalidName = await handler(extractRequest({ authorization, name: '%2Fpath.png' }), {
    ...env, USAGE_QUOTA: quota(204),
  });
  assert.equal(invalidName.status, 400);

  const rateLimited = await handler(extractRequest({ authorization }), { ...env, USAGE_QUOTA: quota(429) });
  assert.equal(rateLimited.status, 429);
  assert.ok(Number(rateLimited.headers.get('Retry-After')) > 0);
  assert.equal(calls, 0);

  const accepted = await handler(extractRequest({ authorization }), { ...env, USAGE_QUOTA: quota(204) });
  assert.equal(accepted.status, 200);
  const [document] = (await accepted.json()).documents;
  assert.equal(document.name, 'Guia sintética.png');
  assert.match(document.id, /^[a-f0-9]{64}$/);
  assert.equal(document.pages[0].page, 1);
  assert.equal(calls, 1);
});
