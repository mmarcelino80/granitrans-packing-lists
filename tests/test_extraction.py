import base64
import hashlib
import json
import unittest
from datetime import datetime, timedelta, timezone
from functools import partial
from http.server import ThreadingHTTPServer
from shutil import which
from threading import Thread
from time import time
from urllib.parse import parse_qs, unquote, urlsplit
from zlib import crc32

from playwright.sync_api import expect, sync_playwright

from test_demo_session import PROJECT_PATH, ROOT, StaticHandler


WORKER = "https://packing-api.granitrans-tests.workers.dev"
SESSION = "session-sintetica-de-teste"
ACCESS_COOKIE = "CF_Authorization=acesso-sintetico"
STANDALONE_OK = "Identidade e sessão verificadas. Nenhuma guia foi enviada."
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


def numbered_guide(number):
    text = b"Comment\x00" + str(number).encode("ascii")
    chunk = b"tEXt" + text
    metadata = len(text).to_bytes(4, "big") + chunk + crc32(chunk).to_bytes(4, "big")
    return {**GUIDE, "name": f"guia-{number}.png", "buffer": PNG[:-12] + metadata + PNG[-12:]}


def distinct_document(identifier, name):
    document = sample_document(identifier, name)
    page = document["pages"][0]
    line = page["lines"][0]
    line["description"] = f"Quartzo de teste · {name}"
    page["lines"] = [line]
    if name != "guia-1.png":
        document["totals"] = []
    return document


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
        cls.bridge_script = (ROOT / "worker/auth-bridge.mjs").read_text(encoding="utf-8").replace(
            "export async function startAuthBridge", "async function startAuthBridge", 1
        )

        playwright = sync_playwright().start()
        cls.addClassCleanup(playwright.stop)
        cls.browser = playwright.chromium.launch(executable_path=which("chromium"))
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.context = self.browser.new_context(locale="pt-PT", timezone_id="Europe/Lisbon")
        self.addCleanup(self.context.close)
        self.logins = []
        self.session_checks = []
        self.bridge_requests = []
        self.uploads = []
        self.unexpected_requests = []
        self.error_status = None
        self.session_check_status = 200
        self.delay_login = False
        self.session_expires_at = None
        self.upload_outcomes = {}
        self.pending_uploads = {}
        self.document_factory = sample_document
        self.context.route("**/*", self.intercept)
        self.configured = True
        self.page = self.context.new_page()
        self.page.add_init_script("""
            window.sessionMessages = [];
            window.addEventListener('message', ({ data }) => {
                if (data?.type === 'granitrans:session') {
                    window.sessionMessages.push(Object.keys(data).sort());
                }
            });
        """)

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
        parsed = urlsplit(request.url)
        if request.method == "GET" and request.url.split("?", 1)[0] == WORKER + "/auth":
            nonce = parse_qs(parsed.query).get("nonce", [None])[0]
            self.logins.append(nonce)
            config = {
                "target": self.origin,
                "nonce": nonce,
                "token": SESSION,
                "expiresAt": self.session_expires_at or int(time() * 1000) + 15 * 60 * 1000,
            }
            invoke = "" if self.delay_login else "completeLogin();"
            route.fulfill(
                content_type="text/html; charset=utf-8",
                headers={
                    "Set-Cookie": ACCESS_COOKIE + "; Path=/; Secure; HttpOnly; SameSite=Lax",
                    "Referrer-Policy": "no-referrer",
                    "Content-Security-Policy": "default-src 'none'; connect-src 'self'; script-src 'nonce-test'",
                },
                body=(
                    f"<p id='status'>A confirmar sessão</p><script nonce='test'>{self.bridge_script}\n"
                    f"function completeLogin() {{ return startAuthBridge({json.dumps(config)}); }} "
                    f"{invoke}</script>"
                ),
            )
            return
        if request.method == "POST" and request.url in {WORKER + "/session-check", WORKER + "/extract"}:
            headers = request.all_headers()
            self.bridge_requests.append((parsed.path, request.frame.url, headers))
            if parsed.path == "/session-check":
                self.session_checks.append(headers)
                route.fulfill(
                    status=self.session_check_status,
                    json={"authenticated": self.session_check_status == 200},
                )
                return
            raw = request.post_data_buffer
            self.uploads.append((headers, raw))
            name = unquote(headers["x-guide-name"])
            outcomes = self.upload_outcomes.get(name, [])
            outcome = outcomes.pop(0) if outcomes else self.error_status
            if outcome == "hold":
                self.pending_uploads[name] = (route, raw)
            elif outcome == "lost":
                route.abort("failed")
            else:
                self.respond_to_upload(route, name, raw, outcome)
            return
        self.unexpected_requests.append((request.method, request.url))
        route.abort()

    def tearDown(self):
        self.assertFalse(self.unexpected_requests)
        for endpoint, source_url, headers in self.bridge_requests:
            self.assertTrue(source_url == WORKER + "/auth" or source_url.startswith(WORKER + "/auth?"))
            self.assertEqual(headers["origin"], WORKER)
            self.assertEqual(headers["authorization"], "Bearer " + SESSION)
            self.assertIn(ACCESS_COOKIE, headers["cookie"])
            if endpoint == "/extract":
                self.assertIn("nonce=", source_url)

    def respond_to_upload(self, route, name, raw, error_status=None):
        if error_status:
            message = QUOTA_ERROR if error_status == 429 else "A análise da guia falhou. Tente novamente."
            payload = {"error": message}
            if error_status == 502:
                payload["code"] = "extraction_rejected"
            if error_status == 409:
                payload["code"] = "duplicate_request"
            route.fulfill(status=error_status, json=payload)
            return
        identifier = hashlib.sha256(raw).hexdigest()
        document = self.document_factory(identifier, name)
        route.fulfill(json={"documents": [document]})

    def remove_guide(self, name):
        self.page.get_by_role("button", name=f"Remover {name}", exact=True).click()
        expect(self.page.locator("#file-list")).not_to_contain_text(name)

    def uploaded_names(self):
        return [unquote(headers["x-guide-name"]) for headers, _ in self.uploads]

    def review_document(self, name):
        heading = self.page.get_by_role("heading", name=name, exact=True)
        return self.page.locator("#review-rows section").filter(has=heading)

    def expand_review_row(self, name):
        row = self.review_document(name).locator("details").first
        if not row.get_by_label("Quantidade", exact=True).is_visible():
            row.locator("summary").click()
        return row

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
        self.assertTrue(self.session_checks)
        self.assertEqual(headers["content-type"], "image/png")
        self.assertEqual(unquote(headers["x-guide-name"]), GUIDE["name"])
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
        self.assertEqual(len(self.session_checks), 1)
        self.assertEqual(
            page.evaluate("window.sessionMessages"), [["expiresAt", "nonce", "type"]]
        )
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

    def test_removing_guide_during_login_excludes_it_and_prevents_a_second_analysis(self):
        self.delay_login = True
        self.document_factory = distinct_document
        page = self.page
        page.goto(self.url)
        self.prepare_manual_material()
        first, second = (numbered_guide(number) for number in (1, 2))
        page.locator("#guides").set_input_files([first, second])
        trigger = page.locator("#analyze-guides")
        with page.expect_popup() as popup_info:
            trigger.click()
        popup = popup_info.value
        popup.wait_for_function("typeof completeLogin === 'function'")
        expect(trigger).to_be_disabled()
        trigger.dispatch_event("click")
        self.remove_guide(first["name"])
        self.assertFalse(self.uploads)

        popup.evaluate("completeLogin()")
        expect(self.review_document(second["name"])).to_be_visible()
        expect(self.review_document(first["name"])).to_have_count(0)
        self.assertEqual(self.uploaded_names(), [second["name"]])
        self.assertEqual(len(self.logins), 1)
        self.assertFalse(self.unexpected_requests)

    def test_removing_queued_guide_during_previous_upload_never_sends_it(self):
        self.document_factory = distinct_document
        page = self.page
        page.goto(self.url)
        self.prepare_manual_material()
        first, removed, last = (numbered_guide(number) for number in (1, 2, 3))
        self.upload_outcomes[first["name"]] = ["hold"]
        page.locator("#guides").set_input_files([first, removed, last])
        with self.context.expect_event(
            "request",
            lambda request: request.url == WORKER + "/extract" and request.method == "POST",
        ):
            page.locator("#analyze-guides").click()
        self.remove_guide(removed["name"])
        self.assertEqual(self.uploaded_names(), [first["name"]])

        route, raw = self.pending_uploads.pop(first["name"])
        self.respond_to_upload(route, first["name"], raw)
        expect(self.review_document(first["name"])).to_be_visible()
        expect(self.review_document(last["name"])).to_be_visible()
        expect(self.review_document(removed["name"])).to_have_count(0)
        self.assertEqual(self.uploaded_names(), [first["name"], last["name"]])
        self.assertFalse(self.unexpected_requests)

    def test_partial_batch_retries_only_failed_guides_and_preserves_edits(self):
        self.document_factory = distinct_document
        page = self.page
        page.goto(self.url)
        self.prepare_manual_material()
        guides = [numbered_guide(number) for number in range(1, 6)]
        names = [guide["name"] for guide in guides]
        self.upload_outcomes = {names[1]: [502], names[3]: ["lost"]}
        page.locator("#guides").set_input_files(guides)
        trigger = page.locator("#analyze-guides")
        trigger.click()

        expect(page.locator("#continue-manual")).to_be_visible()
        expect(trigger).to_be_enabled()
        for failure in (names[1], names[3]):
            expect(page.locator("#analysis-status")).to_contain_text(failure)
        expect(page.locator("#review-rows section")).to_have_count(3)
        for name in (names[0], names[2], names[4]):
            expect(self.review_document(name)).to_be_visible()
        self.assertEqual(self.uploaded_names(), names)

        manual = page.locator("#material-groups .material-row").first
        manual.get_by_label("Descrição", exact=True).fill("Material manual editado")
        first = self.expand_review_row(names[0])
        first.get_by_label("Quantidade", exact=True).fill("3")
        first.get_by_label("Descrição", exact=True).fill("Material extraído editado")
        issues = page.locator("#review-issues")
        issues.get_by_role("button", name="Conferido na guia").click()
        expect(issues.get_by_role("button", name="Conferido na guia")).to_have_count(0)
        expect(page.locator("#apply-review")).to_be_disabled()
        expect(page.locator("#approve")).to_be_disabled()
        expect(page.locator("#download")).to_be_disabled()

        trigger.click()
        expect(page.locator("#continue-manual")).to_be_hidden()
        expect(page.locator("#review-rows section")).to_have_count(5)
        expect(page.locator("#apply-review")).to_be_enabled()
        self.assertEqual(self.uploaded_names(), names + [names[1], names[3]])
        self.assertEqual(len(self.logins), 1)

        request_ids = [headers["x-guide-request"] for headers, _ in self.uploads]
        self.assertEqual(len(set(request_ids[:5])), 5)
        self.assertNotEqual(request_ids[1], request_ids[5])
        self.assertEqual(request_ids[3], request_ids[6])
        first = self.expand_review_row(names[0])
        expect(first.get_by_label("Quantidade", exact=True)).to_have_value("3")
        expect(first.get_by_label("Descrição", exact=True)).to_have_value("Material extraído editado")
        expect(manual.get_by_label("Descrição", exact=True)).to_have_value("Material manual editado")
        expect(issues.get_by_role("button", name="Conferido na guia")).to_have_count(0)
        page.locator("#apply-review").click()
        expect(page.locator("#material-groups .material-row")).to_have_count(6)
        expect(page.locator("#txt-preview")).to_contain_text("-3 Chapas Material extraído editado")
        expect(page.locator("#txt-preview")).to_contain_text("Material manual editado")
        expect(page.locator("#download")).to_be_disabled()
        page.locator("#approve").click()
        expect(page.locator("#download")).to_be_enabled()
        self.assertFalse(self.unexpected_requests)

    def test_unrecoverable_duplicate_keeps_successes_available_for_manual_confirmation(self):
        self.document_factory = distinct_document
        page = self.page
        page.goto(self.url)
        self.prepare_manual_material()
        accepted, unresolved = (numbered_guide(number) for number in (3, 4))
        self.upload_outcomes[unresolved["name"]] = ["lost", 409, 409]
        page.locator("#guides").set_input_files([accepted, unresolved])
        trigger = page.locator("#analyze-guides")
        trigger.click()

        manual = page.locator("#continue-manual")
        apply = page.locator("#apply-review")
        expect(manual).to_be_visible()
        expect(self.review_document(accepted["name"])).to_be_visible()
        expect(apply).to_be_disabled()
        with self.context.expect_event(
            "response", lambda response: response.url == WORKER + "/extract" and response.status == 409
        ):
            trigger.click()
        expect(manual).to_be_visible()
        expect(self.review_document(accepted["name"])).to_be_visible()
        expect(apply).to_be_disabled()

        self.assertEqual(self.uploaded_names(), [accepted["name"], unresolved["name"], unresolved["name"]])
        request_ids = [headers["x-guide-request"] for headers, _ in self.uploads]
        self.assertEqual(request_ids[1], request_ids[2])

        trigger.dispatch_event("click")
        expect(manual).to_be_visible()
        page.once("dialog", lambda dialog: dialog.dismiss())
        manual.click()
        expect(apply).to_be_disabled()
        page.once("dialog", lambda dialog: dialog.accept())
        manual.click()
        expect(apply).to_be_enabled()
        apply.click()
        expect(page.locator("#material-groups .material-row")).to_have_count(2)
        expect(page.locator("#txt-preview")).to_contain_text(accepted["name"])
        expect(page.locator("#txt-preview")).not_to_contain_text(unresolved["name"])
        self.assertEqual(self.uploaded_names(), [accepted["name"], unresolved["name"], unresolved["name"]])
        self.assertFalse(self.unexpected_requests)

    def test_unconfirmed_request_is_not_retransmitted_after_deduplication_window(self):
        page = self.page
        page.goto(self.url)
        self.prepare_manual_material()
        self.upload_outcomes[GUIDE["name"]] = ["lost"]
        page.locator("#guides").set_input_files(GUIDE)
        trigger = page.locator("#analyze-guides")
        manual = page.locator("#continue-manual")
        trigger.click()
        expect(manual).to_be_visible()
        old_status = page.locator("#analysis-status").text_content()
        self.assert_upload()

        future = datetime.now(timezone.utc) + timedelta(hours=25)
        self.session_expires_at = int((future + timedelta(minutes=15)).timestamp() * 1000)
        page.clock.set_fixed_time(future)
        trigger.click()
        expect(manual).to_be_visible()
        expect(page.locator("#analysis-status")).not_to_have_text(old_status)
        expect(page.locator("#extraction-review")).to_be_hidden()
        expect(page.locator("#approve")).to_be_disabled()
        self.assert_upload()

        page.once("dialog", lambda dialog: dialog.accept())
        manual.click()
        page.locator("#approve").click()
        expect(page.locator("#download")).to_be_enabled()

    def test_reauthentication_does_not_rotate_an_attempt_with_uncertain_delivery(self):
        page = self.page
        page.goto(self.url)
        self.prepare_manual_material()
        self.upload_outcomes[GUIDE["name"]] = ["lost", 401]
        page.locator("#guides").set_input_files(GUIDE)
        trigger = page.locator("#analyze-guides")
        manual = page.locator("#continue-manual")
        trigger.click()
        expect(manual).to_be_visible()
        self.assert_upload()

        with self.context.expect_event(
            "response", lambda response: response.url == WORKER + "/extract" and response.status == 401
        ):
            trigger.click()
        expect(manual).to_be_visible()
        expect(trigger).to_be_enabled()
        self.assertEqual(len(self.uploads), 2)
        self.assertEqual(len(self.logins), 1)

        trigger.click()
        expect(self.review_document(GUIDE["name"])).to_be_visible()
        self.assertEqual(len(self.logins), 2)
        self.assertEqual(self.uploaded_names(), [GUIDE["name"]] * 3)
        request_ids = [headers["x-guide-request"] for headers, _ in self.uploads]
        self.assertEqual(len(set(request_ids)), 1)
        self.assertFalse(self.unexpected_requests)

    def test_standalone_authentication_checks_session_without_extracting(self):
        page = self.page
        page.goto(WORKER + "/auth")
        expect(page.locator("#status")).to_have_text(STANDALONE_OK)
        self.assertEqual(self.logins, [None])
        self.assertEqual(len(self.session_checks), 1)
        self.assertFalse(self.uploads)
        cookie = next(cookie for cookie in self.context.cookies(WORKER) if cookie["name"] == "CF_Authorization")
        self.assertTrue(cookie["httpOnly"] and cookie["secure"])
        self.assertEqual(cookie["sameSite"], "Lax")
        self.assertEqual(page.evaluate("document.cookie"), "")

    def test_rejected_session_check_never_uploads_a_guide(self):
        self.session_check_status = 401
        page = self.page
        page.goto(self.url)
        self.prepare_manual_material()
        page.locator("#guides").set_input_files(GUIDE)
        page.locator("#analyze-guides").click()
        expect(page.locator("#continue-manual")).to_be_visible()
        expect(page.locator("#extraction-review")).to_be_hidden()
        expect(page.locator("#approve")).to_be_disabled()
        self.assertEqual(len(self.logins), 1)
        self.assertEqual(len(self.session_checks), 1)
        self.assertFalse(self.uploads)
        self.assertEqual(page.evaluate("window.sessionMessages"), [])
