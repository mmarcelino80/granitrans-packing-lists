import hashlib
import json
import re
import unittest
from pathlib import Path
from shutil import which
from subprocess import run
from time import time
from unicodedata import normalize
from urllib.parse import parse_qs, unquote, urlsplit

from playwright.sync_api import expect, sync_playwright

from test_extraction import PNG, sample_document
from tools.private_preview import SIM_WORKER_ORIGIN, configure_preview
from tools.private_preview_policy import APP_ORIGIN, APP_URL, WORKER_ORIGIN, load_fixture


ROOT = Path(__file__).resolve().parents[1]
CASE = "foto-guia-espessura.png"
SESSION = "session-sintetica-da-pre-visualizacao"
ACCESS_COOKIE = "CF_Authorization=acesso-sintetico"


class PrivatePreviewBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bridge = run(
            [
                "node", "--input-type=module", "-e",
                "import { authBridgeScript } from './worker/auth-bridge.mjs'; process.stdout.write(authBridgeScript);",
            ],
            cwd=ROOT, check=True, capture_output=True, encoding="utf-8",
        ).stdout
        cls.fixture = load_fixture(ROOT, CASE)
        playwright = sync_playwright().start()
        cls.addClassCleanup(playwright.stop)
        # The route backend fulfills requests locally. Any accidental continue()
        # bypasses our stub but can reach only this unavailable loopback proxy.
        cls.browser = playwright.chromium.launch(
            executable_path=which("chromium"),
            proxy={"server": "http://127.0.0.1:1"},
        )
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.context = self.browser.new_context(locale="pt-PT", service_workers="block", offline=True)
        self.addCleanup(self.context.close)
        self.requests = []
        self.french_success = False
        self.backend = []
        self.metrics = []
        self.unexpected = []
        self.context.on("request", lambda request: self.requests.append(request.url))
        self.context.route("**/*", self.route_backend)

    def tearDown(self):
        self.assertEqual(self.unexpected, [])

    def route_backend(self, route):
        request = route.request
        parsed = urlsplit(request.url)
        if f"{parsed.scheme}://{parsed.netloc}" != WORKER_ORIGIN:
            self.unexpected.append((request.method, request.url))
            route.abort()
            return

        method_path = (request.method, parsed.path)
        if method_path == ("GET", "/auth"):
            nonce = parse_qs(parsed.query).get("nonce", [None])[0]
            self.backend.append(("auth", nonce))
            config = {
                "target": APP_ORIGIN,
                "nonce": nonce,
                "token": SESSION,
                "expiresAt": int(time() * 1000) + 15 * 60 * 1000,
            }
            route.fulfill(
                content_type="text/html; charset=utf-8",
                headers={
                    "Set-Cookie": ACCESS_COOKIE + "; Path=/; Secure; HttpOnly; SameSite=Lax",
                    "Referrer-Policy": "no-referrer",
                    "Content-Security-Policy": "default-src 'none'; connect-src 'self'; script-src 'nonce-test'",
                },
                body=f"<p id='status'>Sessão de teste</p><script nonce='test'>({self.bridge})({json.dumps(config)});</script>",
            )
            return
        if method_path == ("POST", "/session-check"):
            self.backend.append(("session", request.frame.url, request.all_headers()))
            route.fulfill(json={"authenticated": True})
            return
        if method_path == ("POST", "/extract"):
            headers = request.all_headers()
            body = request.post_data_buffer
            self.backend.append(("extract", request.frame.url, headers, body))
            name = unquote(headers["x-guide-name"])
            document = sample_document(hashlib.sha256(body).hexdigest(), name)
            document.update(loadingWarehouse="Braga", unloadingWarehouse="Negrais", loadingDate="2026-11-26")
            if self.french_success:
                document["unloadingWarehouse"] = "Paris"
                document["pages"][0]["lines"] = document["pages"][0]["lines"][:1]
                document["totals"] = []
            route.fulfill(json={"documents": [document]})
            return
        self.unexpected.append(method_path)
        route.abort()

    def open_preview(self, **options):
        configure_preview(self.context, ROOT, record=lambda *metric: self.metrics.append(metric), **options)
        page = self.context.new_page()
        response = page.goto(APP_URL)
        self.assertEqual(response.status, 200)
        self.assertEqual(page.url, APP_URL)
        expect(page.get_by_role("heading", name="Packing List", exact=True, level=1)).to_be_visible()
        expect(page.locator("#private-preview")).to_be_visible()
        return page, response

    def assert_popup_requests_are_same_origin(self):
        for kind, *details in self.backend:
            if kind not in {"session", "extract"}:
                continue
            source, headers = details[:2]
            self.assertTrue(source.startswith(WORKER_ORIGIN + "/auth?"))
            self.assertEqual(headers.get("origin"), WORKER_ORIGIN)
            self.assertEqual(headers.get("authorization"), "Bearer " + SESSION)
            self.assertIn(ACCESS_COOKIE, headers.get("cookie", ""))

    def assert_metric(self, mode, case):
        self.assertEqual(len(self.metrics), 1)
        self.assertEqual(len(self.metrics[0]), 4)
        self.assertEqual(self.metrics[0][:3], (mode, case, 200))
        self.assertIs(type(self.metrics[0][3]), int)
        self.assertGreaterEqual(self.metrics[0][3], 0)

    def assert_no_individual_review(self, page):
        expect(page.locator("#materials, #extraction-review, #apply-review, #continue-manual, #preview, #export")).to_have_count(0)
        expect(page.get_by_text("Acrescentar materiais revistos", exact=True)).to_have_count(0)

    def analyze_simulated(self, page, case):
        page.locator("#guides").set_input_files(load_fixture(ROOT, case).file_payload())
        with page.expect_popup() as opened:
            page.locator("#analyze-guides").click()
        popup = opened.value
        popup.wait_for_url(SIM_WORKER_ORIGIN + "/auth?*")
        expect(page.locator(".logistics-document textarea")).to_be_visible()
        expect(page.locator("#private-preview")).to_contain_text(re.compile("simula", re.I))
        self.assert_no_individual_review(page)
        self.assertFalse(self.backend)
        self.assertFalse(any(url.startswith(WORKER_ORIGIN + "/") for url in self.requests))
        self.assert_metric("simulation", case)

    def test_default_simulation_uses_local_app_popup_and_no_external_server(self):
        page, response = self.open_preview()
        banner = page.locator("#private-preview")
        expect(banner).to_contain_text(re.compile("simula", re.I))
        policy = response.headers["content-security-policy"]
        self.assertIn("default-src 'none'", policy)
        self.assertIn("connect-src 'self'", policy)
        self.assertIn("script-src 'self'", policy)
        alternate = self.context.new_page()
        alternate.goto(APP_URL + "index.html")
        expect(alternate.locator("#private-preview")).to_contain_text(re.compile("simula", re.I))
        alternate.close()

        violation = page.evaluate("""
            async () => {
                const blocked = new Promise(resolve => {
                    addEventListener('securitypolicyviolation', event => resolve(event.violatedDirective), {once: true});
                    setTimeout(() => resolve(null), 1000);
                });
                await fetch('https://never-allowed.example.test/probe').catch(() => {});
                return blocked;
            }
        """)
        self.assertEqual(violation, "connect-src")

        self.analyze_simulated(page, CASE)

    def test_simulation_preserves_illegible_jpg_quantity(self):
        page, _ = self.open_preview()
        self.analyze_simulated(page, "foto-guia-ilegivel.jpg")
        expect(page.locator(".logistics-results ul")).to_contain_text("A mancha tapa")
        expect(page.locator(".logistics-document textarea")).to_have_value(re.compile(r"\? palettes"))
        expect(page.get_by_role("button", name="Aprovar", exact=True).last).to_be_disabled()

    def test_simulation_preserves_two_pdf_pages(self):
        page, _ = self.open_preview()
        self.analyze_simulated(page, "guia-duas-paginas.pdf")
        expect(page.locator(".logistics-document textarea")).to_have_value(
            re.compile(r"Quartzito Aurora Teste 20 mm Satinado[\s\S]*Ladrilho Íris Teste 10 mm Mate[\s\S]*8 caballetes de hierro")
        )

    def test_desktop_separates_unloading_sites_and_requires_reapproval_after_edit(self):
        page, _ = self.open_preview()
        self.assert_no_individual_review(page)
        page.locator("#guides").set_input_files([
            load_fixture(ROOT, name).file_payload() for name in (CASE, "guia-duas-paginas.pdf")
        ])
        page.locator("#analyze-guides").click()
        cards = page.locator(".logistics-document")
        expect(cards).to_have_count(2)
        self.assert_no_individual_review(page)
        expect(cards.nth(0)).to_contain_text("Descarga em Negrais")
        expect(cards.nth(1)).to_contain_text("Descarga en Santiago")
        first = cards.first
        approve = first.get_by_role("button", name="Aprovar", exact=True)
        download = first.get_by_role("button", name="Descarregar PDF")
        expect(download).to_be_disabled()
        approve.click()
        expect(download).to_be_enabled()
        editor = first.locator("textarea")
        approved_line = "Conferência — ação | ¡Atención! Envío | Œuvre\u202f: déjà."
        editor.fill(editor.input_value() + "\n".join(["", *[approved_line] * 85]))
        expect(download).to_be_disabled()
        approve.click()
        with page.expect_download() as saved:
            download.click()
        self.assertTrue(saved.value.path().read_bytes().startswith(b"%PDF"))
        if which("pdftotext"):
            extracted = run(
                ["pdftotext", "-raw", str(saved.value.path()), "-"],
                check=True, capture_output=True, encoding="utf-8",
            ).stdout
            expected = normalize("NFC", approved_line).replace("\u202f", " ")
            actual = normalize("NFC", extracted).replace("\u202f", " ")
            self.assertEqual(actual.count(expected), 85)

    def test_mobile_preserves_french_route_and_blocks_unresolved_source(self):
        page, _ = self.open_preview()
        page.set_viewport_size({"width": 390, "height": 844})
        self.assert_no_individual_review(page)
        page.get_by_role("button", name="Thionville", exact=True).click()
        page.get_by_role("button", name="Paris", exact=True).click()
        page.locator("#guides").set_input_files(load_fixture(ROOT, "foto-guia-ilegivel.jpg").file_payload())
        page.locator("#analyze-guides").click()
        result = page.locator(".logistics-document")
        expect(result.locator("pre")).to_contain_text("com primeira descarga em Thionville")
        expect(result.locator("pre")).to_contain_text("Bonjour")
        self.assert_no_individual_review(page)
        expect(result.get_by_role("button", name="Aprovar", exact=True)).to_be_disabled()
        expect(result.get_by_role("link", name="Preparar email")).to_be_hidden()

    def test_mobile_approval_prepares_fixed_recipient_email(self):
        self.french_success = True
        page, _ = self.open_preview(mode="live", case=CASE)
        page.set_viewport_size({"width": 390, "height": 844})
        page.get_by_role("button", name="Paris", exact=True).click()
        page.locator("#guides").set_input_files(self.fixture.file_payload())
        page.locator("#analyze-guides").click()
        result = page.locator(".logistics-document")
        expect(result.locator("pre")).to_contain_text("Bonjour")
        email = result.get_by_role("link", name="Preparar email")
        expect(email).to_be_hidden()
        result.get_by_role("button", name="Aprovar", exact=True).click()
        expect(email).to_have_attribute("href", re.compile(r"^mailto:mralo@granitrans\.pt\?"))

    def test_auth_mode_checks_session_and_blocks_extract_even_from_popup(self):
        page, _ = self.open_preview(mode="auth")
        expect(page.locator("#private-preview")).to_contain_text(re.compile("autentica", re.I))
        expect(page.locator("#analysis-actions")).to_be_hidden()
        with page.expect_popup() as opened:
            page.locator("#private-preview-login").click()
        popup = opened.value
        popup.wait_for_url(WORKER_ORIGIN + "/auth?*")
        expect(page.locator("#private-preview-status")).to_contain_text(
            re.compile("confirmad|verificad|conclu", re.I)
        )
        self.assertEqual([request[0] for request in self.backend], ["auth", "session"])
        blocked = popup.evaluate("""
            async ({ token, name, bytes }) => {
                try {
                    return !(await fetch('/extract', {
                        method: 'POST',
                        referrerPolicy: 'origin',
                        headers: {
                            'Authorization': 'Bearer ' + token,
                            'Content-Type': 'image/png',
                            'X-Guide-Name': encodeURIComponent(name),
                            'X-Guide-Request': crypto.randomUUID(),
                        },
                        body: new Uint8Array(bytes),
                    })).ok;
                } catch {
                    return true;
                }
            }
        """, {"token": SESSION, "name": CASE, "bytes": list(self.fixture.body)})
        self.assertTrue(blocked)
        self.assertEqual([request[0] for request in self.backend], ["auth", "session"])
        self.assertFalse(self.metrics)
        self.assert_popup_requests_are_same_origin()

    def test_live_mode_only_forwards_one_copy_of_exact_selected_fixture(self):
        page, _ = self.open_preview(mode="live", case=CASE)
        expect(page.locator("#private-preview")).to_contain_text(re.compile("sintétic", re.I))
        expect(page.locator("#private-preview")).to_contain_text(CASE)
        good = self.fixture.file_payload()
        tampered = {**good, "buffer": self.fixture.body[:-1] + bytes([self.fixture.body[-1] ^ 1])}
        unlisted = {"name": "guia-fora-da-lista.png", "mimeType": "image/png", "buffer": PNG}
        other_case = load_fixture(ROOT, "foto-guia-ilegivel.jpg").file_payload()
        page.locator("#guides").set_input_files([unlisted, tampered, other_case, good])
        with page.expect_popup() as opened:
            page.locator("#analyze-guides").click()
        popup = opened.value
        popup.wait_for_url(WORKER_ORIGIN + "/auth?*")
        expect(page.locator(".logistics-document")).to_have_count(1)
        expect(page.locator(".logistics-results ul")).to_contain_text("guias por analisar")
        expect(page.locator(".logistics-document").get_by_role("button", name="Aprovar", exact=True)).to_be_disabled()
        uploads = [record for record in self.backend if record[0] == "extract"]
        self.assertEqual(len(uploads), 1)
        _, _, headers, body = uploads[0]
        self.assertEqual(body, self.fixture.body)
        self.assertEqual(unquote(headers["x-guide-name"]), CASE)

        popup.close()
        page.reload()
        page.locator("#guides").set_input_files(good)
        page.locator("#analyze-guides").click()
        expect(page.locator("#analysis-status")).to_contain_text("Não foi possível")
        expect(page.locator(".logistics-document")).to_have_count(0)
        self.assertEqual(len([record for record in self.backend if record[0] == "extract"]), 1)
        self.assert_metric("live", CASE)
        self.assert_popup_requests_are_same_origin()
