const types = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };

export function createExtractionClient(workerUrl, page = window) {
  const url = new URL(workerUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('O serviço de análise precisa de um endereço HTTPS sem caminho.');
  }
  let session;
  let signingIn;

  function login() {
    if (session?.expiresAt > Date.now() + 5000) return Promise.resolve(session.token);
    if (signingIn) return signingIn;
    const nonce = page.crypto.randomUUID();
    const endpoint = new URL('/auth', url);
    endpoint.searchParams.set('nonce', nonce);
    const popup = page.open(endpoint.href, '_blank', 'popup,width=530,height=690');
    if (!popup) return Promise.reject(new Error('Autorize a abertura da janela de autenticação.'));
    signingIn = new Promise((resolve, reject) => {
      const timer = page.setInterval(() => {
        if (popup.closed || Date.now() > deadline) {
          cleanup();
          reject(new Error('A autenticação não foi concluída.'));
        }
      }, 500);
      const deadline = Date.now() + 120_000;
      function cleanup() {
        page.clearInterval(timer);
        page.removeEventListener('message', receive);
        popup.close();
      }
      function receive(event) {
        if (event.source !== popup || event.origin !== url.origin) return;
        const { type, nonce: returned, token, expiresAt } = event.data ?? {};
        if (type !== 'granitrans:session' || returned !== nonce || typeof token !== 'string'
          || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
        session = { token, expiresAt };
        cleanup();
        resolve(token);
      }
      page.addEventListener('message', receive);
    }).finally(() => { signingIn = null; });
    return signingIn;
  }

  async function extract(file, token) {
    const extension = file.name.split('.').at(-1).toLowerCase();
    const response = await page.fetch(new URL('/extract', url), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': types[extension] ?? 'application/octet-stream',
        'X-Guide-Name': encodeURIComponent(file.name),
      },
      body: file,
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(55_000),
    });
    const result = await response.json().catch(() => null);
    if (response.status === 401) session = null;
    if (!response.ok || !Array.isArray(result?.documents) || result.documents.length !== 1) {
      throw new Error(typeof result?.error === 'string' ? result.error : 'Não foi possível analisar a guia.');
    }
    return result.documents[0];
  }

  return { login, extract };
}
