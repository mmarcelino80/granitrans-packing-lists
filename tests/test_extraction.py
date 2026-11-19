import base64
import hashlib
import json
import unittest
from functools import partial
from http.server import ThreadingHTTPServer
from shutil import which
from threading import Thread
from time import time
from urllib.parse import parse_qs, unquote, urlsplit

from playwright.sync_api import expect, sync_playwright

from test_demo_session import PROJECT_PATH, ROOT, StaticHandler


WORKER = "https://packing-api.example"
SESSION = "session-sintetica-de-teste"
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL7kAAAAASUVORK5CYII="
)
GUIDE = {"name": "guia-fictícia.png", "mimeType": "image/png", "buffer": PNG}
QUOTA_ERROR = "Limite diário de análise atingido."


def sample_document(identifier, name):
    first = {
        "quantity": "2",
        "unit": "Chapa",
        "description": "Quartzo de teste",
        "commercialName": "Série Beta",
        "thickness": "2 cm",
        "finish": "mate",
        "reference": "REF-DEMO",
        "client": "CLIENTE-DEMO",
        "destination": "Paris",
        "unloadingLocation": "Porta 2",
        "notes": "stock",
        "issues": [],
    }
    second = {
        **first,
        "quantity": None,
        "description": "Material a excluir",
        "destination": "Destino por confirmar",
        "issues": [{"field": "quantity", "reason": "illegible", "detail": "Quantidade ilegível."}],
    }
    return {
        "id": identifier,
        "name": name,
        "pages": [{"page": 1, "lines": [first, second], "totals": [], "issues": []}],
        "totals": [{"scope": "document", "destination": None, "unit": "Chapa", "quantity": "6"}],
        "issues": [],
    }


class ExtractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(
            ("127.0.0.1", 0), partial(StaticHandler, directory=ROOT)
        )
        cls.addClassCleanup(cls.server.server_close)
        Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.addClassCleanup(cls.server.shutdown)
        cls.origin = f"http://127.0.0.1:{cls.server.server_port}"
        cls.url = cls.origin + PROJECT_PATH

        playwright = sync_playwright().start()
        cls.addClassCleanup(playwright.stop)
        cls.browser = playwright.chromium.launch(executable_path=which("chromium"))
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.context = self.browser.new_context(locale="pt-PT", timezone_id="Europe/Lisbon")
        self.addCleanup(self.context.close)
        self.logins = []
        self.uploads = []
        self.unexpected_requests = []
        self.error_status = None
        self.context.route("**/*", self.intercept)
        self.configured = True
        self.page = self.context.new_page()

    def intercept(self, route):
        request = route.request
        if request.url == self.url + "extraction-config.mjs" and self.configured:
            route.fulfill(
                content_type="text/javascript",
                body=f"export const extractionWorkerUrl = {json.dumps(WORKER)};",
            )
            return
        if request.url.startswith(self.origin + "/"):
            route.continue_()
            return
        if request.url.startswith(WORKER + "/auth?"):
            nonce = parse_qs(urlsplit(request.url).query)["nonce"][0]
            self.logins.append(nonce)
            payload = {
                "type": "granitrans:session",
                "nonce": nonce,
                "token": SESSION,
                "expiresAt": int(time() * 1000) + 15 * 60 * 1000,
            }
            route.fulfill(
                content_type="text/html",
                body=f"<script>window.opener.postMessage({json.dumps(payload)}, {json.dumps(self.origin)})</script>",
            )
            return
        if request.url == WORKER + "/extract":
            cors = {"Access-Control-Allow-Origin": self.origin}
            if request.method == "OPTIONS":
                route.fulfill(
                    status=204,
                    headers={
                        **cors,
                        "Access-Control-Allow-Methods": "POST, OPTIONS",
                        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Guide-Name",
                    },
                )
                return
            if request.method == "POST":
                raw = request.post_data_buffer
                self.uploads.append((request.all_headers(), raw))
                if self.error_status:
                    route.fulfill(status=self.error_status, headers=cors, json={"error": QUOTA_ERROR})
                else:
                    name = unquote(request.header_value("X-Guide-Name"))
                    identifier = hashlib.sha256(raw).hexdigest()
                    document = sample_document(identifier, name)
                    route.fulfill(headers=cors, json={"documents": [document]})
                return
        self.unexpected_requests.append((request.method, request.url))
        route.abort()

    def prepare_manual_material(self):
        page = self.page
        page.get_by_role("button", name="Paris", exact=True).click()
        page.get_by_role("button", name="Adicionar material: Paris", exact=True).click()
        row = page.locator("#material-groups .material-row").last
        row.get_by_label("Quantidade").fill("1")
        row.get_by_label("Descrição").fill("Material manual de teste")

    def assert_upload(self):
        self.assertEqual(len(self.uploads), 1)
        headers, data = self.uploads[0]
        self.assertEqual(data, PNG)
        self.assertEqual(headers["origin"], self.origin)
        self.assertEqual(headers["authorization"], "Bearer " + SESSION)
        self.assertEqual(headers["content-type"], "image/png")
        self.assertEqual(unquote(headers["x-guide-name"]), GUIDE["name"])
        self.assertNotIn("cookie", headers)
        self.assertFalse(self.unexpected_requests)

    def test_extraction_waits_for_review_and_imports_only_accepted_materials(self):
        page = self.page
        page.goto(self.url)
        self.prepare_manual_material()
        page.locator("#approve").click()
        expect(page.locator("#download")).to_be_enabled()
        page.locator("#guides").set_input_files([GUIDE, {**GUIDE, "name": "cópia.png"}])
        page.locator("#analyze-guides").click()

        review = page.locator("#extraction-review")
        expect(review).to_be_visible()
        expect(page.locator("#approve")).to_be_disabled()
        expect(page.locator("#download")).to_be_disabled()
        expect(page.locator("#share")).to_be_disabled()
        expect(page.locator("#material-groups .material-row")).to_have_count(1)
        expect(page.locator("#txt-preview")).not_to_contain_text("REF-DEMO")
        expect(page.locator("#review-rows")).to_contain_text(GUIDE["name"])
        expect(page.locator("#review-totals")).to_contain_text("pág. 1")
        expect(page.locator("#apply-review")).to_be_disabled()
        self.assertEqual(len(self.logins), 1)
        self.assert_upload()

        first, second = page.locator("#review-rows details").all()
        first.locator("summary").click()
        expect(first.get_by_label("Destino final", exact=True)).to_have_value("Paris")
        first.get_by_label("Quantidade", exact=True).fill("3")
        second.locator("summary").click()
        second.get_by_role("button", name="Excluir linha", exact=True).click()
        expect(page.locator("#review-totals")).to_contain_text("calculado: 3")
        expect(page.locator("#review-issues")).to_contain_text("difere")
        expect(page.locator("#apply-review")).to_be_disabled()
        page.locator("#review-issues").get_by_role("button", name="Conferido na guia").click()
        page.locator("#apply-review").click()

        expect(review).to_be_hidden()
        expect(page.locator("#material-groups .material-row")).to_have_count(2)
        expect(page.locator("#txt-preview")).to_contain_text(
            "Quartzo de teste, Série Beta, 2 cm, mate, REF-DEMO"
        )
        expect(page.locator("#txt-preview")).to_contain_text("descarga em Porta 2")
        expect(page.locator("#txt-preview")).not_to_contain_text("Material a excluir")
        expect(page.locator("#download")).to_be_disabled()

        page.locator("#analyze-guides").click()
        expect(page.locator("#analysis-status")).to_contain_text("Nenhuma guia nova")
        self.assert_upload()
        self.assertEqual(len(self.logins), 1)
        page.locator("#approve").click()
        with page.expect_download() as exported:
            page.locator("#download").click()
        actual = exported.value.path().read_bytes().decode("utf-8")
        self.assertEqual(actual, page.locator("#txt-preview").text_content())
        self.assertIn("-3 Chapas", actual)
        self.assertFalse(self.unexpected_requests)

    def test_quota_error_allows_explicit_manual_review(self):
        self.error_status = 429
        page = self.page
        page.goto(self.url)
        self.prepare_manual_material()
        page.locator("#guides").set_input_files(GUIDE)
        page.locator("#analyze-guides").click()
        expect(page.locator("#analysis-status")).to_have_text(QUOTA_ERROR)
        expect(page.locator("#extraction-review")).to_be_hidden()
        expect(page.locator("#approve")).to_be_disabled()
        expect(page.locator("#material-groups .material-row")).to_have_count(1)
        self.assert_upload()

        page.once("dialog", lambda dialog: dialog.accept())
        page.locator("#continue-manual").click()
        page.locator("#approve").click()
        expect(page.locator("#download")).to_be_enabled()
        expect(page.locator("#txt-preview")).to_contain_text("Material manual de teste")
        self.assert_upload()

    def test_default_configuration_keeps_guides_local(self):
        self.configured = False
        page = self.page
        page.goto(self.url)
        page.locator("#guides").set_input_files(GUIDE)
        expect(page.locator("#file-list")).to_contain_text(GUIDE["name"])
        expect(page.locator("#analysis-actions")).to_be_hidden()
        expect(page.locator("#extraction-review")).to_be_hidden()
        expect(page.locator("#material-groups .material-row")).to_have_count(0)
        self.assertFalse(self.logins or self.uploads or self.unexpected_requests)
