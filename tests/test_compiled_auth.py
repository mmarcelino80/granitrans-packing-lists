import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from shutil import which
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
APP = "https://packing-list.example.test"
WORKER = "https://packing-api.integration-tests.workers.dev"
COOKIE = {"name": "CF_Authorization", "value": "offline-access"}
COOKIE_PAIR = f"{COOKIE['name']}={COOKIE['value']}"
STANDALONE_OK = "Identidade e sessão verificadas. Nenhuma guia foi enviada."
POPUP_OK = "Sessão confirmada. Mantenha esta janela aberta e volte à aplicação."

# Compile the same entry point with esbuild's --keep-names option, as Wrangler does.
BUILD = """
import { build } from './worker/node_modules/esbuild/lib/main.js';
await build({
  entryPoints: ['worker/index.mjs'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  keepNames: true,
  drop: ['console'],
  outfile: process.argv[1],
});
"""

# The Chromium/Firefox network interceptor sends only synthetic requests here.
# An offline Access edge adds a fresh JWT when the browser supplies its fixture cookie.
RUN_WORKER = r"""
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const { createHandler } = await import(pathToFileURL(process.argv[1]));
const { app, worker, url, method, headers, cookie, body } = JSON.parse(readFileSync(0, 'utf8'));
const operator = 'operator@example.test';
const env = {
  APP_ORIGIN: app,
  WORKER_ORIGIN: worker,
  ACCESS_TEAM_DOMAIN: 'granitrans-integration.cloudflareaccess.com',
  ACCESS_AUD: 'offline-audience',
  ALLOWED_EMAILS: operator,
  SESSION_SECRET: 'synthetic-session-key-for-offline-browser-test',
  EXTRACTION_ENABLED: 'false',
};
const algorithm = {
  name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
};
const pair = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
const key = {
  ...await crypto.subtle.exportKey('jwk', pair.publicKey),
  kid: 'offline-key', alg: 'RS256', use: 'sig',
};
const issuer = 'https://' + env.ACCESS_TEAM_DOMAIN;
const encode = (data) => Buffer.from(JSON.stringify(data)).toString('base64url');
const unsigned = [
  encode({ alg: 'RS256', kid: key.kid }),
  encode({ iss: issuer, aud: [env.ACCESS_AUD], email: operator, exp: Math.floor(Date.now() / 1000) + 900 }),
].join('.');
const signature = await crypto.subtle.sign(algorithm, pair.privateKey, Buffer.from(unsigned));
if (headers.cookie?.split(/;\s*/u).includes(cookie)) {
  headers['Cf-Access-Jwt-Assertion'] = unsigned + '.' + Buffer.from(signature).toString('base64url');
}
let accessCalls = 0;
let extractionCalls = 0;
const handle = createHandler(async () => {
  extractionCalls++;
  throw new Error('Network disabled in browser regression');
}, {
  accessFetcher: async (address) => {
    accessCalls++;
    assert.equal(String(address), issuer + '/cdn-cgi/access/certs');
    return Response.json({ keys: [key] });
  },
});
const response = await handle(new Request(url, { method, headers, ...(body ? { body } : {}) }), env);
assert.equal(accessCalls, 1);
assert.equal(extractionCalls, 0);
process.stdout.write(JSON.stringify({
  status: response.status,
  headers: Object.fromEntries(response.headers),
  body: await response.text(),
}));
"""


class CompiledAuthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        bundle_dir = tempfile.TemporaryDirectory(prefix="granitrans-compiled-auth-")
        cls.addClassCleanup(bundle_dir.cleanup)
        cls.bundle = Path(bundle_dir.name) / "worker.mjs"
        subprocess.run(
            ["node", "--input-type=module", "--eval", BUILD, str(cls.bundle)],
            cwd=ROOT, check=True, timeout=30,
        )
        cls.playwright = sync_playwright().start()
        cls.addClassCleanup(cls.playwright.stop)

    def verify_browser(self, browser):
        context = browser.new_context()
        self.addCleanup(context.close)
        context.add_cookies([{
            **COOKIE, "url": WORKER, "httpOnly": True, "secure": True, "sameSite": "Lax",
        }])
        worker_requests = []
        unexpected = []

        def intercept(route):
            request = route.request
            if request.url == APP + "/":
                route.fulfill(
                    content_type="text/html; charset=utf-8",
                    body=f"""
                        <button id="login">Autenticar</button>
                        <script type="module">
                            import {{ createExtractionClient }} from '/extraction-client.mjs';
                            const client = createExtractionClient({json.dumps(WORKER)});
                            const openPopup = window.open.bind(window);
                            window.open = (...args) => {{
                                window.testPopup = openPopup(...args);
                                return window.testPopup;
                            }};
                            window.bridgeMessage = null;
                            document.getElementById('login').onclick = async () => {{
                                window.loginHandleType = typeof await client.login();
                            }};
                            window.addEventListener('message', (event) => {{
                                if (event.source === window.testPopup && event.origin === {json.dumps(WORKER)}) {{
                                    window.bridgeMessage = event.data;
                                }}
                            }});
                        </script>
                    """,
                )
                return
            if request.url == APP + "/extraction-client.mjs":
                route.fulfill(
                    content_type="text/javascript; charset=utf-8",
                    body=(ROOT / "extraction-client.mjs").read_text(encoding="utf-8"),
                )
                return
            auth = request.method == "GET" and request.url.split("?", 1)[0] == f"{WORKER}/auth"
            check = request.method == "POST" and request.url == f"{WORKER}/session-check"
            if not (auth or check):
                unexpected.append((request.method, request.url))
                route.abort()
                return
            headers = request.all_headers()
            payload = {
                "app": APP, "worker": WORKER, "url": request.url, "method": request.method,
                "headers": headers, "cookie": COOKIE_PAIR, "body": request.post_data,
            }
            completed = subprocess.run(
                ["node", "--input-type=module", "--eval", RUN_WORKER, str(self.bundle)],
                input=json.dumps(payload), capture_output=True, text=True, encoding="utf-8",
                cwd=ROOT, check=True, timeout=15,
            )
            response = json.loads(completed.stdout)
            worker_requests.append((request.url, headers, response["status"], response["headers"]))
            route.fulfill(**response)

        context.route("**/*", intercept)
        page_errors = []
        context.on("page", lambda page: page.on("pageerror", lambda error: page_errors.append(str(error))))
        standalone = context.new_page()
        standalone_response = standalone.goto(f"{WORKER}/auth")
        expect(standalone.locator("#status")).to_have_text(STANDALONE_OK)
        self.assertEqual(standalone_response.status, 200)
        self.assert_security_headers(standalone, standalone_response.all_headers())
        self.assertEqual(standalone.evaluate("document.cookie"), "")

        opener = context.new_page()
        opener.goto(APP + "/")
        with opener.expect_popup() as popup_info:
            opener.locator("#login").click()
        popup = popup_info.value
        expect(popup.locator("#status")).to_have_text(POPUP_OK)
        opener.wait_for_function("window.bridgeMessage !== null && window.loginHandleType === 'symbol'")
        popup_url = popup.url
        nonce = parse_qs(urlsplit(popup_url).query)["nonce"][0]
        message = opener.evaluate("window.bridgeMessage")
        self.assertEqual(set(message), {"type", "nonce", "expiresAt"})
        self.assertEqual(message["type"], "granitrans:session")
        self.assertEqual(message["nonce"], nonce)
        self.assertGreater(message["expiresAt"], opener.evaluate("Date.now()"))
        self.assertEqual(
            [url for url, *_ in worker_requests],
            [f"{WORKER}/auth", f"{WORKER}/session-check", popup_url, f"{WORKER}/session-check"],
        )
        self.assert_security_headers(popup, worker_requests[2][3])
        for url, headers, status, _ in worker_requests:
            self.assertEqual(status, 200)
            self.assertIn(COOKIE_PAIR, headers.get("cookie", ""))
            if url.endswith("/session-check"):
                self.assertEqual(headers.get("origin"), WORKER)
                self.assertTrue(headers.get("authorization", "").startswith("Bearer "))
        self.assertFalse(page_errors)
        self.assertFalse(unexpected)

    def assert_security_headers(self, page, headers):
        csp = headers["content-security-policy"]
        self.assertIn("default-src 'none'", csp)
        self.assertIn("connect-src 'self'", csp)
        self.assertIn("frame-ancestors 'none'", csp)
        nonce = page.locator("script").evaluate("script => script.nonce")
        self.assertRegex(nonce, r"^[A-Za-z0-9_-]+$")
        self.assertIn(f"script-src 'nonce-{nonce}'", csp)
        self.assertEqual(headers["referrer-policy"], "no-referrer")
        self.assertFalse(page.evaluate("""() => {
            const script = document.createElement('script');
            script.textContent = 'window.scriptWithoutNonceRan = true';
            document.head.append(script);
            script.remove();
            return Boolean(window.scriptWithoutNonceRan);
        }"""))

    def test_bundled_auth_in_chromium(self):
        browser = self.playwright.chromium.launch(executable_path=which("chromium"))
        self.addCleanup(browser.close)
        self.verify_browser(browser)

    def test_bundled_auth_in_firefox(self):
        if not Path(self.playwright.firefox.executable_path).is_file():
            self.skipTest("Firefox Playwright indisponível. Instale com python3 -m playwright install firefox.")
        browser = self.playwright.firefox.launch()
        self.addCleanup(browser.close)
        self.verify_browser(browser)
