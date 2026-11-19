import { ExtractionError, extractDocument, readDocument } from './extraction.mjs';
import { SecurityError, accessLogin, authenticate, reserveQuota } from './security.mjs';

export { QuotaCounter } from './security.mjs';

function headers(origin) {
  return {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Vary': 'Origin',
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
  };
}

function reply(value, status, origin, extra = {}) {
  return Response.json(value, { status, headers: { ...headers(origin), ...extra } });
}

function appOrigin(env) {
  try {
    const url = new URL(env.APP_ORIGIN);
    if (url.protocol === 'https:' && url.origin === env.APP_ORIGIN) return url.origin;
  } catch {
    // Invalid configuration fails closed.
  }
  return null;
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

export function createHandler(fetcher = fetch) {
  return async function handle(request, env) {
    const { pathname } = new URL(request.url);
    const configuredOrigin = appOrigin(env);
    const suppliedOrigin = request.headers.get('Origin');
    const origin = configuredOrigin && suppliedOrigin === configuredOrigin ? configuredOrigin : null;

    if (env.EXTRACTION_ENABLED !== 'true' || !configuredOrigin) {
      return reply({ error: 'A extração ainda não está disponível.' }, 503, origin);
    }

    try {
      if (pathname === '/auth' && request.method === 'GET') return await accessLogin(request, env);
      if (pathname !== '/extract') return reply({ error: 'Operação desconhecida.' }, 404, origin);
      if (!origin) return reply({ error: 'Origem não autorizada.' }, 403, null);
      if (request.method === 'OPTIONS') {
        if (request.headers.get('Access-Control-Request-Method') !== 'POST') {
          return reply({ error: 'Método não permitido.' }, 405, origin);
        }
        return new Response(null, { status: 204, headers: {
          ...headers(origin),
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Guide-Name, X-Guide-Request',
          'Access-Control-Max-Age': '600',
        } });
      }
      if (request.method !== 'POST') return reply({ error: 'Método não permitido.' }, 405, origin);
      const email = await authenticate(request, env);
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
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]);
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
