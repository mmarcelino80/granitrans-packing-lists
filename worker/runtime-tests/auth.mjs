import worker, { createHandler } from '../index.mjs';
import { extractDocument } from '../extraction.mjs';

const control = 'https://runtime-control.example.test/';
const encode = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
const jsonPart = (value) => encode(new TextEncoder().encode(JSON.stringify(value)));

function equal(actual, expected, step) {
  if (actual !== expected) throw new Error(`${step}: expected ${expected}, got ${actual}`);
}

async function accessFixture(env) {
  const algorithm = {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  };
  const pair = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const { n, e } = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const key = { kid: 'offline-test', kty: 'RSA', alg: 'RS256', use: 'sig', n, e };
  const unsigned = [
    jsonPart({ alg: key.alg, kid: key.kid }),
    jsonPart({
      iss: 'https://' + env.ACCESS_TEAM_DOMAIN,
      aud: [env.ACCESS_AUD],
      exp: Math.floor(Date.now() / 1000) + 900,
      email: 'operator@example.test',
    }),
  ].join('.');
  const signed = await crypto.subtle.sign(algorithm, pair.privateKey, new TextEncoder().encode(unsigned));
  return { key, token: unsigned + '.' + encode(new Uint8Array(signed)) };
}

async function configure(env, key, status) {
  await env.OUTBOUND_FIXTURE.fetch(control, {
    method: 'PUT',
    body: JSON.stringify({ key, status }),
  });
}

async function requests(env) {
  return (await env.OUTBOUND_FIXTURE.fetch(control)).json();
}

export default {
  async test(_controller, env) {
    const { key, token } = await accessFixture(env);
    const access = { 'Cf-Access-Jwt-Assertion': token };
    const auth = () => new Request(env.WORKER_ORIGIN + '/auth', { headers: access });
    await configure(env, key, 200);

    // Reinsert precisely the original Fetch option. Workerd must reject it before I/O.
    const original = createHandler(undefined, {
      accessFetcher: (url, options) => fetch(url, { ...options, redirect: 'error' }),
    });
    equal((await original(auth(), env)).status, 503, 'original /auth');
    equal((await requests(env)).jwksRequests, 0, 'original JWKS calls');

    const response = await worker.fetch(auth(), env);
    equal(response.status, 200, 'corrected /auth');
    const html = await response.text();
    const tokenMatch = /"token":"([a-zA-Z0-9_.-]+)"/u.exec(html);
    if (!tokenMatch) throw new Error('Missing synthetic session');
    const session = await worker.fetch(new Request(env.WORKER_ORIGIN + '/session-check', {
      method: 'POST',
      headers: { ...access, Origin: env.WORKER_ORIGIN, Authorization: 'Bearer ' + tokenMatch[1] },
    }), env);
    equal(session.status, 200, '/session-check with extraction off and no quota binding');
    equal((await session.json()).authenticated, true, 'validated session');
    equal((await requests(env)).openAIRequests, 0, 'authentication OpenAI calls');

    await configure(env, key, 302);
    const redirected = await worker.fetch(auth(), env);
    equal(redirected.status, 503, 'JWKS redirect');
    equal((await redirected.json()).code, 'access_jwks_redirect', 'JWKS redirect diagnostic');
    equal((await requests(env)).jwksRequests, 3, 'JWKS calls with no follow');

    let rejection;
    try {
      await extractDocument({
        id: 'offline-test',
        name: 'fictitious.png',
        mimeType: 'image/png',
        bytes: new Uint8Array([137, 80, 78, 71]),
      }, { apiKey: 'synthetic-fixture' });
    } catch (error) {
      rejection = error;
    }
    equal(rejection?.code, 'extraction_rejected', 'OpenAI redirect in the offline service');
    equal((await requests(env)).openAIRequests, 1, 'simulated OpenAI calls with no follow');
  },
};
