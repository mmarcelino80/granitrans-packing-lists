import { startAuthBridge } from './auth-bridge.mjs';

const SESSION_TTL = 15 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const QUOTA_KEY = 'daily';
const QUOTA_OBJECT = 'packing-list-v02';
const MAX_USER_DAILY = 25;
const MAX_GLOBAL_DAILY = 50;
const EMAIL_PATTERN = /^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8', { fatal: true });

export class SecurityError extends Error {
  constructor(status, message, { retryAfter, code } = {}) {
    super(message);
    this.name = 'SecurityError';
    this.status = status;
    this.retryAfter = retryAfter;
    this.code = code;
  }
}

function unauthorized() {
  return new SecurityError(401, 'Inicie sessão para ler as guias.');
}

function serviceUnavailable(code) {
  return new SecurityError(503, 'O serviço de leitura está temporariamente indisponível.', { code });
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function allowedEmails(env) {
  const emails = typeof env.ALLOWED_EMAILS === 'string' ? env.ALLOWED_EMAILS.split(',').map(normalizeEmail) : null;
  if (!emails || emails.length < 1 || emails.length > 2 ||
      new Set(emails).size !== emails.length || emails.some(email => !EMAIL_PATTERN.test(email))) {
    throw serviceUnavailable('access_allowlist_invalid');
  }
  return emails;
}

function ensureAllowed(email, env) {
  if (!allowedEmails(env).includes(email)) {
    throw new SecurityError(403, 'Esta conta não tem acesso à leitura de guias.');
  }
}

function accessIssuer(value) {
  const origin = typeof value === 'string' ? value.replace(/\/$/u, '') : '';
  const host = origin.replace(/^https:\/\//u, '');
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/u.test(host)) {
    throw serviceUnavailable('access_config_invalid');
  }
  return 'https://' + host;
}

function appOrigin(env) {
  let parsed;
  try {
    parsed = new URL(env.APP_ORIGIN);
  } catch {
    throw serviceUnavailable('app_origin_invalid');
  }
  if (parsed.protocol !== 'https:' || env.APP_ORIGIN !== parsed.origin) {
    throw serviceUnavailable('app_origin_invalid');
  }
  return parsed.origin;
}

function encode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decode(value) {
  if (!BASE64URL.test(value)) throw unauthorized();
  try {
    return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), byte => byte.charCodeAt(0));
  } catch {
    throw unauthorized();
  }
}

function tokenParts(token) {
  if (typeof token !== 'string' || token.length > 16000) throw unauthorized();
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every(part => BASE64URL.test(part))) throw unauthorized();
  return parts;
}

function parseJson(part) {
  try {
    const value = JSON.parse(DECODER.decode(decode(part)));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    throw unauthorized();
  }
  throw unauthorized();
}

export async function verifyAccessToken(token, env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const issuer = accessIssuer(env.ACCESS_TEAM_DOMAIN);
  const audience = env.ACCESS_AUD;
  if (typeof audience !== 'string' || !audience.trim()) throw serviceUnavailable('access_config_invalid');

  const [headerPart, claimPart, signature] = tokenParts(token);
  const header = parseJson(headerPart);
  const claims = parseJson(claimPart);
  const currentSeconds = Math.floor(now / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid ||
      claims.iss !== issuer || !audiences.includes(audience) ||
      !Number.isSafeInteger(claims.exp) || claims.exp <= currentSeconds ||
      (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > currentSeconds))) {
    throw unauthorized();
  }

  let response;
  try {
    response = await fetchImpl(issuer + '/cdn-cgi/access/certs', {
      redirect: 'manual', signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw serviceUnavailable('access_jwks_transport');
  }
  const redirected = response.status >= 300 && response.status < 400;
  if (redirected || !response.ok) {
    response.body?.cancel().catch(() => {});
    throw serviceUnavailable(redirected ? 'access_jwks_redirect' : 'access_jwks_http');
  }

  let keys;
  try {
    ({ keys } = await response.json());
  } catch {
    throw serviceUnavailable('access_jwks_invalid');
  }
  if (!Array.isArray(keys)) throw serviceUnavailable('access_jwks_invalid');

  const jwk = keys.find(key => key?.kid === header.kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256'));
  if (!jwk) throw unauthorized();

  let key;
  try {
    key = await crypto.subtle.importKey(
      'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
    );
  } catch {
    throw serviceUnavailable('access_rsa_import_failed');
  }
  const signatureBytes = decode(signature);
  let valid;
  try {
    valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', key, signatureBytes, ENCODER.encode(headerPart + '.' + claimPart),
    );
  } catch {
    throw serviceUnavailable('access_rsa_verify_failed');
  }
  if (!valid) throw unauthorized();

  const email = normalizeEmail(claims.email);
  ensureAllowed(email, env);
  return { email, expiresAt: claims.exp * 1000 };
}

async function sessionKey(env) {
  if (typeof env.SESSION_SECRET !== 'string' || env.SESSION_SECRET.length < 32) {
    throw serviceUnavailable('session_secret_invalid');
  }
  try {
    return await crypto.subtle.importKey(
      'raw', ENCODER.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
  } catch {
    throw serviceUnavailable('session_crypto_failed');
  }
}

async function signSession({ email, expiresAt }, env) {
  const payload = encode(ENCODER.encode(JSON.stringify({ email, expiresAt, origin: appOrigin(env) })));
  const unsigned = 'v1.' + payload;
  const key = await sessionKey(env);
  let signature;
  try {
    signature = await crypto.subtle.sign('HMAC', key, ENCODER.encode(unsigned));
  } catch {
    throw serviceUnavailable('session_crypto_failed');
  }
  return unsigned + '.' + encode(new Uint8Array(signature));
}

export async function accessLogin(request, env, dependencies = {}) {
  const nonce = new URL(request.url).searchParams.get('nonce');
  if (nonce !== null && !/^[A-Za-z0-9_-]{32,128}$/u.test(nonce)) {
    throw new SecurityError(400, 'Volte à aplicação e inicie sessão.');
  }

  const now = dependencies.now ?? Date.now();
  const claims = await verifyAccessToken(request.headers.get('Cf-Access-Jwt-Assertion'), env, { ...dependencies, now });
  const expiresAt = Math.min(claims.expiresAt, now + SESSION_TTL);
  const token = await signSession({ email: claims.email, expiresAt }, env);
  const config = JSON.stringify({ target: appOrigin(env), nonce, token, expiresAt });
  const scriptNonce = encode(crypto.getRandomValues(new Uint8Array(24)));

  return new Response(
    `<!doctype html><html lang="pt-PT"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Packing List</title><p id="status" role="status">A verificar a sessão Cloudflare Access…</p><script nonce="${scriptNonce}">(${startAuthBridge.toString()})(${config});</script></html>`,
    {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${scriptNonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}

export async function authenticateAccess(request, env, dependencies) {
  const claims = await verifyAccessToken(request.headers.get('Cf-Access-Jwt-Assertion'), env, dependencies);
  return claims.email;
}

export async function authenticate(request, env, now = Date.now()) {
  const authorization = request.headers.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ')) throw unauthorized();
  const [version, payload, signature] = tokenParts(authorization.slice('Bearer '.length));
  if (version !== 'v1') throw unauthorized();

  const key = await sessionKey(env);
  const signatureBytes = decode(signature);
  let valid;
  try {
    valid = await crypto.subtle.verify('HMAC', key, signatureBytes, ENCODER.encode(version + '.' + payload));
  } catch {
    throw serviceUnavailable('session_crypto_failed');
  }
  if (!valid) throw unauthorized();

  const claims = parseJson(payload);
  if (!Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= now || claims.origin !== appOrigin(env)) {
    throw unauthorized();
  }
  const email = normalizeEmail(claims.email);
  ensureAllowed(email, env);
  return email;
}

function dailyLimit(value, max) {
  if (value === undefined) return max;
  const number = Number(value);
  if (!/^\d+$/u.test(String(value)) || !Number.isSafeInteger(number) || number < 1 || number > max) {
    throw serviceUnavailable();
  }
  return number;
}

function getLimits(env) {
  const perUser = dailyLimit(env.QUOTA_PER_USER_DAILY, MAX_USER_DAILY);
  const global = dailyLimit(env.QUOTA_GLOBAL_DAILY, MAX_GLOBAL_DAILY);
  if (perUser > global) throw serviceUnavailable();
  return { perUser, global };
}

export async function reserveQuota(env, email, { documentId, requestId }) {
  ensureAllowed(email, env);
  const { perUser, global } = getLimits(env);
  const binding = env.USAGE_QUOTA;

  let result;
  try {
    const [user, attempt] = await Promise.all([
      crypto.subtle.digest('SHA-256', ENCODER.encode(email)),
      crypto.subtle.digest('SHA-256', ENCODER.encode(JSON.stringify([email, documentId, requestId]))),
    ]);
    const quota = binding.get(binding.idFromName(QUOTA_OBJECT));
    result = await quota.fetch('https://quota.internal/reserve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: encode(new Uint8Array(user)), attempt: encode(new Uint8Array(attempt)) }),
    });
  } catch {
    throw serviceUnavailable();
  }

  if (result.status === 204) return;
  if (result.status === 409) {
    throw new SecurityError(409, 'Este pedido já foi aceite. Confira esta guia manualmente para evitar uma cobrança repetida.', { code: 'duplicate_request' });
  }
  if (result.status === 429) {
    const retryAfter = Math.ceil((DAY - (Date.now() % DAY)) / 1000);
    throw new SecurityError(429, `O limite diário de leituras foi atingido (${perUser} por utilizador, ${global} no total). Tente novamente depois da meia-noite UTC.`, { retryAfter });
  }
  throw serviceUnavailable();
}

export class QuotaCounter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/reserve') {
      return new Response(null, { status: 404 });
    }
    let identifiers;
    try {
      identifiers = await request.json();
    } catch {
      return new Response(null, { status: 400 });
    }
    const { user, attempt } = identifiers ?? {};
    const digest = /^[A-Za-z0-9_-]{43}$/u;
    if (typeof user !== 'string' || typeof attempt !== 'string' || !digest.test(user) || !digest.test(attempt)) {
      return new Response(null, { status: 400 });
    }

    const limits = getLimits(this.env);
    const status = await this.state.storage.transaction(async transaction => {
      const day = Math.floor(Date.now() / DAY);
      const previous = await transaction.get(QUOTA_KEY);
      const usage = previous?.day === day ? previous : {
        day,
        total: 0,
        users: {},
        attempts: [],
        previousAttempts: previous?.day === day - 1 ? previous.attempts ?? [] : [],
      };
      usage.attempts ??= [];
      if (usage.attempts.includes(attempt) || usage.previousAttempts?.includes(attempt)) return 409;
      const count = Object.hasOwn(usage.users, user) ? usage.users[user] : 0;
      if (count >= limits.perUser || usage.total >= limits.global) return 429;

      usage.users[user] = count + 1;
      usage.total += 1;
      usage.attempts.push(attempt);
      await transaction.put(QUOTA_KEY, usage);
      return 204;
    });

    return new Response(null, { status });
  }
}
