// The Worker bundle must treat this browser script as data. Serializing a compiled function
// would leave bundler helpers behind when the function runs in the separate browser page.
export const authBridgeScript = String.raw`async function startAuthBridge({ target, nonce, token, expiresAt }) {
  const opener = window.opener;
  const statusNode = document.getElementById('status');
  const headers = { Authorization: 'Bearer ' + token };
  let processing = false;

  function notify(data) {
    if (nonce && opener) opener.postMessage({ ...data, nonce }, target);
  }

  async function verifySession() {
    try {
      const response = await fetch('/session-check', {
        method: 'POST', headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        referrerPolicy: 'origin',
        signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json();
      return response.ok && result.authenticated === true;
    } catch {
      return false;
    }
  }

  if (!await verifySession()) {
    statusNode.textContent = 'Não foi possível confirmar a sessão Cloudflare Access.';
    notify({ type: 'granitrans:auth-error', status: 401 });
    return;
  }

  if (!nonce || !opener) {
    statusNode.textContent = 'Identidade e sessão verificadas. Nenhuma guia foi enviada.';
    return;
  }

  statusNode.textContent = 'Sessão confirmada. Mantenha esta janela aberta e volte à aplicação.';
  window.addEventListener('message', async (event) => {
    if (event.origin !== target || event.source !== opener || event.data?.nonce !== nonce
      || event.data?.type !== 'granitrans:extract') return;
    const { requestId, file } = event.data;
    if (typeof requestId !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(requestId)
      || !(file instanceof File)) return;

    const result = (status, body) => notify({ type: 'granitrans:result', requestId, status, result: body });
    if (Date.now() >= expiresAt) {
      result(401, { error: 'A sessão expirou. Volte a autenticar-se.' });
      return;
    }
    if (processing) {
      result(409, { error: 'Já existe uma leitura em curso nesta sessão.' });
      return;
    }
    const type = /\.jpe?g$/iu.test(file.name) ? 'image/jpeg' : /\.png$/iu.test(file.name) ? 'image/png'
      : /\.pdf$/iu.test(file.name) ? 'application/pdf' : 'application/octet-stream';
    processing = true;
    try {
      const response = await fetch('/extract', {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': type,
          'X-Guide-Name': encodeURIComponent(file.name),
          'X-Guide-Request': requestId,
        },
        body: file,
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'origin',
        signal: AbortSignal.timeout(54_000),
      });
      result(response.status, await response.json().catch(() => null));
    } catch {
      result(0, null);
    } finally {
      processing = false;
    }
  });
  notify({ type: 'granitrans:session', expiresAt });
}`;
