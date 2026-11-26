import { ExtractionError, UPSTREAM_TIMEOUT_MS, extractDocument, readDocument } from './extraction.mjs';
import { SecurityError, accessLogin, authenticate, authenticateAccess, reserveQuota } from './security.mjs';

export { QuotaCounter } from './security.mjs';

const EXTRACT_HEADERS = ['Authorization', 'Content-Type', 'X-Guide-Name', 'X-Guide-Request'];
const PERMITTED_REQUEST_HEADERS = new Set(EXTRACT_HEADERS.map((header) => header.toLowerCase()));

function headers(origin) {
  return {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Vary': 'Origin',
    ...(origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' } : {}),
  };
}

function reply(value, status, origin, extra = {}) {
  return Response.json(value, { status, headers: { ...headers(origin), ...extra } });
}

function httpsOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.origin === value) return url.origin;
  } catch {
    // Invalid configuration fails closed.
  }
  return null;
}

function preflight(request, origin) {
  if (!origin) return reply({ error: 'Origem não autorizada.' }, 403, null);

  const vary = { Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers' };
  if (request.headers.get('Access-Control-Request-Method') !== 'POST') {
    return reply({ error: 'Método não permitido.' }, 405, origin, { ...vary, Allow: 'POST, OPTIONS' });
  }
  const requested = request.headers.get('Access-Control-Request-Headers');
  if (requested && requested.split(',').some((header) => !PERMITTED_REQUEST_HEADERS.has(header.trim().toLowerCase()))) {
    return reply({ error: 'Cabeçalhos não autorizados.' }, 403, origin, vary);
  }

  return new Response(null, { status: 204, headers: {
    ...headers(origin),
    ...vary,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': EXTRACT_HEADERS.join(', '),
    'Access-Control-Max-Age': '600',
  } });
}

async function authenticateSession(request, env, dependencies) {
  const email = await authenticate(request, env);
  const accessEmail = await authenticateAccess(request, env, dependencies);
  if (accessEmail !== email) {
    throw new SecurityError(403, 'A conta do Access não corresponde à sessão da aplicação.', { code: 'session_identity_mismatch' });
  }
  return email;
}

function fileName(request) {
  let name;
  try {
    name = decodeURIComponent(request.headers.get('X-Guide-Name') ?? '').normalize('NFC');
  } catch {
    throw new ExtractionError(400, 'invalid_name', 'Nome de ficheiro inválido.');
  }
  if (!name.trim() || name.length > 180 || /[\u0000-\u001f\u007f/\\]/u.test(name)) {
    throw new ExtractionError(400, 'invalid_name', 'Nome de ficheiro inválido.');
  }
  return name;
}

export function createHandler(fetcher = fetch, { accessFetcher = fetch } = {}) {
  const accessDependencies = { fetchImpl: accessFetcher };
  return async function handle(request, env) {
    const url = new URL(request.url);
    const configuredOrigin = httpsOrigin(env.APP_ORIGIN);
    const workerOrigin = httpsOrigin(env.WORKER_ORIGIN);
    if (!configuredOrigin || !workerOrigin) {
      return reply({ error: 'A extração ainda não está configurada.' }, 503, null);
    }
    if (url.origin !== workerOrigin) return reply({ error: 'Servidor não autorizado.' }, 403, null);

    const { pathname } = url;
    const suppliedOrigin = request.headers.get('Origin');
    const origin = pathname === '/extract' && suppliedOrigin === configuredOrigin ? configuredOrigin : null;

    try {
      if (pathname === '/auth') {
        if (request.method !== 'GET') return reply({ error: 'Método não permitido.' }, 405, null, { Allow: 'GET' });
        return await accessLogin(request, env, accessDependencies);
      }
      if (pathname === '/session-check') {
        if (suppliedOrigin !== workerOrigin) return reply({ error: 'Origem não autorizada.' }, 403, null);
        if (request.method !== 'POST') return reply({ error: 'Método não permitido.' }, 405, null, { Allow: 'POST' });
        await authenticateSession(request, env, accessDependencies);
        return reply({ authenticated: true }, 200, null);
      }
      if (pathname !== '/extract') return reply({ error: 'Operação desconhecida.' }, 404, origin);
      if (request.method === 'OPTIONS') return preflight(request, origin);
      if (!origin && suppliedOrigin !== workerOrigin) return reply({ error: 'Origem não autorizada.' }, 403, null);
      if (request.method !== 'POST') return reply({ error: 'Método não permitido.' }, 405, origin, { Allow: 'POST, OPTIONS' });
      const email = await authenticateSession(request, env, accessDependencies);
      if (env.EXTRACTION_ENABLED !== 'true') {
        return reply({ error: 'A extração ainda não está disponível.' }, 503, origin);
      }
      if (!env.OPENAI_API_KEY) return reply({ error: 'A extração ainda não está configurada.' }, 503, origin);
      const requestId = request.headers.get('X-Guide-Request')?.toLowerCase() ?? '';
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(requestId)) {
        throw new ExtractionError(400, 'invalid_request_id', 'O identificador do pedido de leitura é inválido.');
      }
      const name = fileName(request);
      const file = await readDocument(request);
      const digest = await crypto.subtle.digest('SHA-256', file.bytes);
      const id = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      // Reject repeated attempts and reserve quota together before calling OpenAI.
      await reserveQuota(env, email, { documentId: id, requestId });
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]);
      const document = await extractDocument({ ...file, id, name }, { apiKey: env.OPENAI_API_KEY, fetcher, signal });
      return reply({ documents: [document] }, 200, origin);
    } catch (error) {
      if (error instanceof SecurityError || error instanceof ExtractionError) {
        const extra = error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {};
        return reply({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status, origin, extra);
      }
      return reply({ error: 'Não foi possível confirmar o resultado da leitura.', code: 'ambiguous_request' }, 502, origin);
    }
  };
}

export default { fetch: createHandler() };
