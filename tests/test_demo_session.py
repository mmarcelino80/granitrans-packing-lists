import unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from shutil import which
from threading import Thread

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
PROJECT_PATH = "/granitrans-packing-lists/"
GUIDE = {
    "name": "guia-de-teste.pdf",
    "mimeType": "application/pdf",
    "buffer": b"%PDF-1.4\n% Ficheiro de teste\n%%EOF",
}


class StaticHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        return super().translate_path(path.removeprefix(PROJECT_PATH))

    def log_message(self, _format, *_args):
        pass


class DemoSessionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(
            ("127.0.0.1", 0), partial(StaticHandler, directory=ROOT)
        )
        cls.addClassCleanup(cls.server.server_close)
        Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.addClassCleanup(cls.server.shutdown)
        cls.url = f"http://127.0.0.1:{cls.server.server_port}{PROJECT_PATH}"

        playwright = sync_playwright().start()
        cls.addClassCleanup(playwright.stop)
        cls.browser = playwright.chromium.launch(executable_path=which("chromium"))
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        context = self.browser.new_context(locale="pt-PT", timezone_id="Europe/Lisbon")
        self.addCleanup(context.close)
        self.page = context.new_page()
        self.page.goto(self.url)

    def add_custom_destination(self, name):
        self.page.locator("#custom-toggle").click()
        self.page.locator("#custom-name").fill(name)
        self.page.get_by_role("button", name="Adicionar destino", exact=True).click()

    def add_material(self, destination, description):
        button = self.page.get_by_role("button", name=f"Adicionar material: {destination}", exact=True)
        group = self.page.locator(".material-group").filter(has=button)
        button.click()
        row = group.locator(".material-row").last
        row.get_by_label("Quantidade").fill("2")
        row.get_by_label("Unidade").fill("Chapa")
        row.get_by_label("Descrição").fill(description)
        row.get_by_label("Observações").fill("stock")

    def assert_demo_blocks_export(self):
        for button in ("#approve", "#download", "#share"):
            expect(self.page.locator(button)).to_be_disabled()
        email = self.page.locator("#email-link")
        expect(email).to_be_hidden()
        self.assertIsNone(email.get_attribute("href"))
        expect(self.page.locator("#demo-warning")).to_be_visible()
        expect(self.page.locator("#txt-preview")).to_contain_text("DADOS FICTÍCIOS")

    def close_demo(self, confirm):
        shown_dialogs = []

        def handle(dialog):
            shown_dialogs.append(dialog.type)
            if confirm:
                dialog.accept()
            else:
                dialog.dismiss()

        self.page.once("dialog", handle)
        self.page.locator("#clear-demo").click()
        self.assertEqual(shown_dialogs, ["confirm"])

    def test_demo_cannot_export_after_replacing_all_materials(self):
        page = self.page
        original_date = page.locator("#date").input_value()
        original_introduction = page.locator("#introduction").input_value()
        page.locator("#load-demo").click()
        self.assert_demo_blocks_export()

        page.locator("#date").fill("2026-12-04")
        page.locator("#introduction").fill("Introdução fictícia editada.")
        page.locator("#guides").set_input_files(GUIDE)
        self.add_custom_destination("Armazém de teste")
        rows = page.locator(".material-row")
        self.assertGreater(rows.count(), 0)
        while rows.count():
            rows.first.get_by_role("button", name="Remover material").click()
        self.assert_demo_blocks_export()

        self.add_material("Armazém de teste", "Série de teste / REF-DEMO")
        demo_text = page.locator("#txt-preview").text_content()
        self.assertIn("REF-DEMO", demo_text)
        page.locator("#approve").dispatch_event("click")
        self.assert_demo_blocks_export()

        self.close_demo(confirm=False)
        expect(page.locator("#date")).to_have_value("2026-12-04")
        expect(page.locator("#introduction")).to_have_value("Introdução fictícia editada.")
        expect(page.locator("#route-summary")).to_contain_text("Armazém de teste")
        expect(page.locator("#file-list")).to_contain_text(GUIDE["name"])
        expect(page.locator("#txt-preview")).to_have_text(demo_text)
        self.assert_demo_blocks_export()

        self.close_demo(confirm=True)
        expect(page.locator("#demo-warning")).to_be_hidden()
        expect(page.locator("#date")).to_have_value(original_date)
        expect(page.locator("#introduction")).to_have_value(original_introduction)
        expect(page.locator("#route-summary")).to_be_hidden()
        expect(page.locator("#custom-list > li")).to_have_count(0)
        expect(page.locator("#custom-name")).to_have_value("")
        expect(page.locator("#file-list > li")).to_have_count(0)
        expect(rows).to_have_count(0)
        expect(page.locator("#txt-preview")).not_to_contain_text("DADOS FICTÍCIOS")
        expect(page.locator("#load-demo")).to_be_enabled()

        page.get_by_role("button", name="Paris", exact=True).click()
        self.add_material("Paris", "Série de teste / REF-EXPEDIÇÃO")
        page.locator("#approve").click()
        with page.expect_download() as exported:
            page.locator("#download").click()
        downloaded = exported.value.path().read_text(encoding="utf-8")
        self.assertIn("REF-EXPEDIÇÃO", downloaded)
        self.assertNotIn("DADOS FICTÍCIOS", downloaded)
        self.assertEqual(downloaded, page.locator("#txt-preview").text_content())

    def test_demo_cannot_overwrite_an_edited_draft(self):
        page = self.page

        def enter_custom_name():
            page.locator("#custom-toggle").click()
            page.locator("#custom-name").fill("Destino por adicionar")

        def remove_selected_custom_destination():
            self.add_custom_destination("Armazém já registado")
            page.get_by_role("button", name="Armazém já registado", exact=True).click()

        edits = {
            "data": lambda: page.locator("#date").fill("2026-12-04"),
            "introdução": lambda: page.locator("#introduction").fill("Texto por rever."),
            "destino": lambda: page.get_by_role("button", name="Paris", exact=True).click(),
            "destino personalizado em edição": enter_custom_name,
            "destino personalizado fora da rota": remove_selected_custom_destination,
            "guia": lambda: page.locator("#guides").set_input_files(GUIDE),
        }
        def snapshot():
            return (
                *(page.locator(selector).input_value() for selector in ("#date", "#introduction", "#custom-name")),
                *(page.locator(selector).text_content() for selector in ("#route-text", "#file-list", "#custom-list", "#txt-preview")),
            )

        for field, edit in edits.items():
            with self.subTest(field=field):
                page.reload()
                edit()
                before = snapshot()
                load_demo = page.locator("#load-demo")
                self.assertTrue(load_demo.is_hidden() or load_demo.is_disabled())

                # Exercise the action guard independently of the button's rendering.
                load_demo.dispatch_event("click")

                expect(page.locator("#demo-warning")).to_be_hidden()
                expect(page.locator("#clear-demo")).to_be_hidden()
                self.assertEqual(snapshot(), before)
                expect(page.locator(".material-row")).to_have_count(0)
