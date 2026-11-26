import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExtractionClient } from './extraction-client.mjs';

const origin = 'https://packing-api.example';
const guide = new File(['synthetic test'], 'guia.png', { type: 'image/png' });
const attempt = 'guide-request-1';
const document = {
  id: 'f'.repeat(64),
  name: guide.name,
  pages: [{ page: 1, lines: [{ issues: [] }], issues: [], totals: [] }],
  issues: [],
  totals: [],
};

function fakeWindow() {
  const timers = new Map();
  const popups = [];
  const page = new EventTarget();
  let lastTimer = 0;
  let nonces = 0;

  page.crypto = { randomUUID: () => 'nonce-' + ++nonces };
  page.open = (url, target) => {
    const popup = {
      url: new URL(url),
      target,
      closed: false,
      messages: [],
      close() { this.closed = true; },
      postMessage(data, targetOrigin) { this.messages.push({ data, targetOrigin }); },
    };
    popups.push(popup);
    return popup;
  };
  page.setTimeout = (callback, duration) => {
    timers.set(++lastTimer, { callback, duration });
    return lastTimer;
  };
  page.setInterval = page.setTimeout;
  page.clearTimeout = (id) => { timers.delete(id); };
  page.clearInterval = page.clearTimeout;

  function fireTimer(duration) {
    const timer = [...timers.values()].find((item) => item.duration === duration);
    assert(timer, `Expected a ${duration}ms timer`);
    timer.callback();
  }

  function fromPopup(popup, payload, { source = popup, from = origin } = {}) {
    page.dispatchEvent(Object.assign(new Event('message'), {
      source, origin: from, data: { nonce: popup.url.searchParams.get('nonce'), ...payload },
    }));
  }

  function confirm(popup, overrides) {
    fromPopup(popup, { type: 'granitrans:session', expiresAt: Date.now() + 120_000, ...overrides });
  }

  function result(popup, status, body, { requestId = attempt, ...event } = {}) {
    fromPopup(popup, { type: 'granitrans:result', requestId, status, result: body }, event);
  }

  return { page, popups, timers, fireTimer, fromPopup, confirm, result };
}

async function login(client, window) {
  const pending = client.login();
  const popup = window.popups.at(-1);
  window.confirm(popup);
  return { popup, handle: await pending };
}

test('keeps a trusted popup open and sends the guide only to its exact origin', async () => {
  const window = fakeWindow();
  const client = createExtractionClient(origin, window.page);
  const pending = client.login();
  assert.equal(client.login(), pending);
  const [popup] = window.popups;

  assert.equal(popup.url.origin + popup.url.pathname, origin + '/auth');
  assert.deepEqual([...popup.url.searchParams.keys()], ['nonce']);
  assert.equal(popup.target, '_blank');
  const fakeSession = { type: 'granitrans:session', expiresAt: 1 };
  window.fromPopup(popup, fakeSession, { from: 'https://untrusted.example' });
  window.fromPopup(popup, fakeSession, { source: {} });
  window.confirm(popup);
  const handle = await pending;
  assert.equal(await client.login(), handle);
  assert.equal(typeof handle, 'symbol');
  assert.equal(popup.closed, false);
  assert.equal(window.popups.length, 1);

  const presented = client.extract(guide, handle, attempt);
  assert.deepEqual(popup.messages, [{
    targetOrigin: origin,
    data: { type: 'granitrans:extract', nonce: popup.url.searchParams.get('nonce'), requestId: attempt, file: guide },
  }]);
  window.result(popup, 401, { error: 'fora de ordem' }, { requestId: 'different-attempt' });
  window.result(popup, 401, { error: 'origem errada' }, { from: 'https://untrusted.example' });
  window.fromPopup(popup, {
    type: 'granitrans:result', nonce: 'wrong-nonce', requestId: attempt, status: 401, result: null,
  });
  window.result(popup, 200, { documents: [document] });
  assert.deepEqual(await presented, document);
  assert.equal(popup.closed, false);
  assert.equal(window.timers.size, 0);
});

test('a timeout closes the old channel and retains the same attempt ID for explicit retry', async () => {
  const window = fakeWindow();
  const client = createExtractionClient(origin, window.page);
  const first = await login(client, window);
  const unknown = client.extract(guide, first.handle, attempt);
  window.fireTimer(55_000);
  await assert.rejects(unknown, (error) => !error.alreadyAccepted && !error.canStartNewAttempt);
  assert.equal(first.popup.closed, true);
  assert.equal(window.popups.length, 1);

  const renewed = await login(client, window);
  assert.notEqual(renewed.handle, first.handle);
  assert.notEqual(renewed.popup.url.search, first.popup.url.search);
  const presented = client.extract(guide, renewed.handle, attempt);
  window.result(first.popup, 409, { code: 'duplicate_request', error: 'Resposta antiga' });
  assert.equal(renewed.popup.messages[0].data.requestId, attempt);
  window.result(renewed.popup, 200, { documents: [document] });
  assert.deepEqual(await presented, document);
  assert.equal(window.timers.size, 0);
});

test('marks only explicit recognized Worker outcomes and invalidates a session on 401', async () => {
  const window = fakeWindow();
  const client = createExtractionClient(origin, window.page);
  const { popup, handle } = await login(client, window);

  for (const [status, code, alreadyAccepted, canStartNewAttempt] of [
    [409, 'duplicate_request', true, false],
    [502, 'invalid_extraction', false, true],
    [503, 'extraction_busy', false, true],
    [401, 'extraction_busy', false, false],
  ]) {
    const requestId = 'guide-request-' + status;
    const presented = client.extract(guide, handle, requestId);
    window.result(popup, status, { error: 'Estado de teste', code }, { requestId });
    await assert.rejects(presented, { alreadyAccepted, canStartNewAttempt });
  }
  assert.equal(popup.closed, true);
  assert.equal(window.popups.length, 1);
  await assert.rejects(client.extract(guide, handle, 'no-session'), /sessão de análise terminou/u);
});

test('handles blocked and closed login windows without sending data', async () => {
  const blocked = fakeWindow();
  blocked.page.open = () => null;
  await assert.rejects(createExtractionClient(origin, blocked.page).login(), /Autorize a abertura/u);

  const window = fakeWindow();
  const client = createExtractionClient(origin, window.page);
  const pending = client.login();
  const [popup] = window.popups;
  popup.close();
  window.fireTimer(500);
  await assert.rejects(pending, /A autenticação não foi concluída/u);
  assert.deepEqual(popup.messages, []);
  assert.equal(window.timers.size, 0);
});

test('a relayed lost response keeps the batch open without granting a new attempt', async () => {
  const window = fakeWindow();
  const client = createExtractionClient(origin, window.page);
  const { popup, handle } = await login(client, window);
  const lost = client.extract(guide, handle, attempt);
  window.result(popup, 0, null);
  await assert.rejects(lost, { alreadyAccepted: false, canStartNewAttempt: false });
  const nextAttempt = 'guide-request-2';
  const next = client.extract(guide, handle, nextAttempt);
  window.result(popup, 200, { documents: [document] }, { requestId: nextAttempt });
  assert.deepEqual(await next, document);
  assert.equal(popup.closed, false);
  assert.equal(window.popups.length, 1);
});

test('rejects a malformed extraction result', async () => {
  const window = fakeWindow();
  const client = createExtractionClient(origin, window.page);
  const { popup, handle } = await login(client, window);
  const presented = client.extract(guide, handle, attempt);
  window.result(popup, 200, { documents: [{ ...document, pages: [{}] }] });
  await assert.rejects(presented, /Não foi possível confirmar/u);
  assert.equal(popup.closed, false);
});
