const LOGIN_TIMEOUT = 120_000;
const EXTRACTION_TIMEOUT = 55_000;
const LOGIN_ERROR = 'A autenticação não foi concluída. Volte a analisar para iniciar sessão.';
const EXPIRED_SESSION = 'A sessão de análise terminou. Volte a analisar para iniciar sessão.';
const UNKNOWN_RESULT = 'Não foi possível confirmar o resultado da guia. Volte a analisar para consultar a mesma tentativa.';
const RETRYABLE_STATUS = new Map([
  ['extraction_rejected', 502], ['extraction_busy', 503], ['invalid_extraction', 502],
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordList(value) {
  return Array.isArray(value) && value.every(isRecord);
}

function validDocument(document) {
  // The Worker validates every extracted field. Verify the structure consumed by the review UI.
  return isRecord(document)
    && typeof document.id === 'string' && /^[a-f0-9]{64}$/u.test(document.id)
    && typeof document.name === 'string' && Boolean(document.name.trim())
    && recordList(document.issues) && recordList(document.totals)
    && recordList(document.pages) && document.pages.length > 0
    && document.pages.every((entry, index) => entry.page === index + 1
      && recordList(entry.issues) && recordList(entry.totals) && recordList(entry.lines)
      && entry.lines.every((line) => recordList(line.issues)));
}

export function createExtractionClient(workerUrl, page = window) {
  const url = new URL(workerUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('O serviço de análise precisa de um endereço HTTPS sem caminho.');
  }
  let session;
  let signingIn;

  function active(bridge) {
    return bridge && !bridge.popup.closed && bridge.expiresAt > Date.now() + 5000;
  }

  function retire(bridge) {
    if (session === bridge) session = null;
    if (!bridge.popup.closed) bridge.popup.close();
  }

  function waitForMessage(bridge, { accepts, duration, failureMessage, send }) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + duration;
      function cleanup() {
        page.removeEventListener('message', receive);
        page.clearInterval(watcher);
        page.clearTimeout(timer);
      }
      function fail() {
        cleanup();
        reject(new Error(failureMessage));
      }
      function expired() {
        if (!bridge.popup.closed && Date.now() < deadline) return false;
        fail();
        return true;
      }
      function receive(event) {
        if (event.source !== bridge.popup || event.origin !== url.origin || expired()) return;
        const data = event.data;
        if (!isRecord(data) || data.nonce !== bridge.nonce || !accepts(data)) return;
        cleanup();
        resolve(data);
      }
      const watcher = page.setInterval(expired, 500);
      const timer = page.setTimeout(fail, duration);
      page.addEventListener('message', receive);
      try {
        send?.();
      } catch {
        fail();
      }
    });
  }

  function login() {
    if (active(session)) return Promise.resolve(session.handle);
    if (signingIn) return signingIn;
    if (session) retire(session);

    const nonce = page.crypto.randomUUID();
    const endpoint = new URL('/auth', url);
    endpoint.searchParams.set('nonce', nonce);
    const popup = page.open(endpoint.href, '_blank', 'popup,width=440,height=575');
    if (!popup) return Promise.reject(new Error('Autorize a abertura da janela de autenticação.'));

    const bridge = { popup, nonce, handle: Symbol(), expiresAt: 0, busy: false };
    signingIn = waitForMessage(bridge, {
      duration: LOGIN_TIMEOUT,
      failureMessage: LOGIN_ERROR,
      accepts: ({ type }) => type === 'granitrans:session' || type === 'granitrans:auth-error',
    }).then(({ type, expiresAt }) => {
      if (type === 'granitrans:auth-error') {
        throw new Error('Não foi possível autorizar esta conta. Confirme o acesso e volte a analisar.');
      }
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || popup.closed) {
        throw new Error(LOGIN_ERROR);
      }
      bridge.expiresAt = expiresAt;
      session = bridge;
      return bridge.handle;
    }).catch((error) => {
      retire(bridge);
      throw error;
    }).finally(() => { signingIn = null; });
    return signingIn;
  }

  async function extract(file, handle, requestId) {
    const bridge = session;
    if (!active(bridge)) {
      if (bridge) retire(bridge);
      throw new Error(EXPIRED_SESSION);
    }
    if (bridge.handle !== handle) throw new Error(EXPIRED_SESSION);
    if (bridge.busy) throw new Error('Já existe uma guia em análise nesta sessão.');

    bridge.busy = true;
    let reply;
    try {
      reply = await waitForMessage(bridge, {
        duration: EXTRACTION_TIMEOUT,
        failureMessage: UNKNOWN_RESULT,
        accepts: (data) => data.type === 'granitrans:result' && data.requestId === requestId,
        send: () => bridge.popup.postMessage({
          type: 'granitrans:extract', nonce: bridge.nonce, requestId, file,
        }, url.origin),
      });
    } catch (error) {
      // A completion was never relayed. Retire this channel before retrying the same attempt ID.
      retire(bridge);
      throw error;
    } finally {
      bridge.busy = false;
    }

    const { status, result } = reply;
    const document = result?.documents?.[0];
    if (status === 200 && Array.isArray(result?.documents) && result.documents.length === 1
      && validDocument(document)) {
      return document;
    }

    const sessionExpired = status === 401 || (status === 403 && result?.code === 'session_identity_mismatch');
    if (sessionExpired) retire(bridge);
    const hasApiError = Number.isSafeInteger(status) && status >= 400 && status <= 599
      && isRecord(result) && typeof result.error === 'string' && result.error.trim();
    const error = new Error(sessionExpired ? EXPIRED_SESSION : hasApiError ? result.error : UNKNOWN_RESULT);
    error.alreadyAccepted = Boolean(hasApiError && status === 409 && result.code === 'duplicate_request');
    // Only explicit Worker responses can end an ambiguous attempt or permit a new request ID.
    error.canStartNewAttempt = Boolean(hasApiError && RETRYABLE_STATUS.get(result.code) === status);
    throw error;
  }

  return { login, extract };
}
