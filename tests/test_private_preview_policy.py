import csv
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from tools.private_preview import PreviewError, choose_mode, write_metric
from tools.private_preview_policy import (
    APP_CONFIG_URL,
    APP_URL,
    FIXTURE_DIRECTORY,
    FIXTURES,
    WORKER_EXTRACT_URL,
    ExtractGate,
    FixtureError,
    load_fixture,
)


ROOT = Path(__file__).resolve().parents[1]
PNG = "foto-guia-espessura.png"
JPG = "foto-guia-ilegivel.jpg"
PDF = "guia-duas-paginas.pdf"


class PrivatePreviewPolicyTests(unittest.TestCase):
    def test_menu_defaults_to_simulation_and_requires_explicit_live_confirmation(self):
        with redirect_stdout(StringIO()):
            with patch("builtins.input", return_value=""):
                self.assertEqual(choose_mode(), ("simulation", None))
            with patch("builtins.input", return_value="2"):
                self.assertEqual(choose_mode(), ("auth", None))
            with patch("builtins.input", side_effect=["3", "1", ""]), self.assertRaises(PreviewError):
                choose_mode()
            with patch("builtins.input", side_effect=["3", "1", "EXTRAIR"]):
                self.assertEqual(choose_mode(), ("live", PNG))

    def test_local_log_records_only_approved_case_and_fixed_metric_fields(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"LOCALAPPDATA": directory}):
            console = StringIO()
            with redirect_stdout(console):
                write_metric("simulation", PNG, 200, 123)
                write_metric("live", JPG, "falha de transporte", 154)
                write_metric("auth", JPG, 200, 0)
                write_metric("live", "nome-comercial.pdf", 200, 1)
                write_metric("live", PDF, "Bearer valor-sintetico", 1)
            path = Path(directory) / "GranitransV02Teste" / "leituras.csv"
            with path.open(encoding="utf-8", newline="") as stream:
                columns, simulated, live = csv.reader(stream)
            self.assertEqual(columns, ["data_utc", "modo", "guia_sintetica", "resultado", "duracao_ms"])
            self.assertEqual(simulated[1:], ["Simulação", PNG, "200", "123"])
            self.assertEqual(live[1:], ["Extração real", JPG, "falha de transporte", "154"])
            self.assertEqual(len(console.getvalue().splitlines()), 2)

    def test_all_approved_checkout_files_verify_and_supply_in_memory_uploads(self):
        self.assertEqual(set(FIXTURES), {PNG, JPG, PDF})
        self.assertEqual(APP_URL, "https://mmarcelino80.github.io/granitrans-packing-lists/")
        self.assertEqual(APP_CONFIG_URL, APP_URL + "extraction-config.mjs")
        for name in FIXTURES:
            with self.subTest(name=name):
                fixture = load_fixture(ROOT, name)
                self.assertTrue(fixture.spec.matches(fixture.body))
                self.assertEqual(fixture.file_payload(), {
                    "name": name,
                    "mimeType": FIXTURES[name].mime_type,
                    "buffer": fixture.body,
                })

    def test_unknown_names_and_path_overrides_fail_before_loading(self):
        for name in ("expected.json", PNG.upper(), f"../{PNG}", str(ROOT / FIXTURE_DIRECTORY / PNG)):
            with self.subTest(name=name), self.assertRaises(FixtureError):
                load_fixture(ROOT, name)
        with self.assertRaises(FixtureError):
            ExtractGate("guia-comercial.pdf")

    def test_fixture_with_same_name_and_size_but_different_bytes_is_rejected(self):
        original = load_fixture(ROOT, PNG).body
        changed = bytes([original[0] ^ 1]) + original[1:]
        with tempfile.TemporaryDirectory() as directory:
            checkout = Path(directory)
            expected = checkout / FIXTURE_DIRECTORY / PNG
            expected.parent.mkdir(parents=True)
            expected.write_bytes(changed)
            with self.assertRaisesRegex(FixtureError, "difere da versão aprovada"):
                load_fixture(checkout, PNG)

    def test_fixture_link_outside_checkout_is_refused_even_with_approved_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            checkout = Path(directory)
            expected = checkout / FIXTURE_DIRECTORY / JPG
            expected.parent.mkdir(parents=True)
            try:
                expected.symlink_to(ROOT / FIXTURE_DIRECTORY / JPG)
            except OSError:
                self.skipTest("Creating symlinks is unavailable on this test account")
            with self.assertRaisesRegex(FixtureError, "caminho previsto"):
                load_fixture(checkout, JPG)

    def test_no_selected_fixture_denies_any_extraction(self):
        fixture = load_fixture(ROOT, PDF)
        gate = ExtractGate(None)
        self.assertFalse(gate.allow("POST", WORKER_EXTRACT_URL, fixture.body, fixture.spec.mime_type))
        self.assertFalse(gate.consumed)

    def test_only_selected_actual_bytes_and_exact_request_are_allowed_once(self):
        fixture = load_fixture(ROOT, PNG)
        other = load_fixture(ROOT, JPG)
        body = fixture.body
        mime = fixture.spec.mime_type
        gate = ExtractGate(PNG)
        denied = (
            ("GET", WORKER_EXTRACT_URL, body, mime),
            ("POST", WORKER_EXTRACT_URL + "?alternate=true", body, mime),
            ("POST", WORKER_EXTRACT_URL + "/", body, mime),
            ("POST", "https://other.example.test/extract", body, mime),
            ("POST", WORKER_EXTRACT_URL, None, mime),
            ("POST", WORKER_EXTRACT_URL, body, None),
            ("POST", WORKER_EXTRACT_URL, body, "image/jpeg"),
            ("POST", WORKER_EXTRACT_URL, other.body, mime),
            ("POST", WORKER_EXTRACT_URL, other.body, other.spec.mime_type),
            ("POST", WORKER_EXTRACT_URL, body[:-1] + bytes([body[-1] ^ 1]), mime),
        )
        self.assertTrue(all(not gate.allow(*request) for request in denied))
        self.assertFalse(gate.consumed)
        self.assertTrue(gate.allow("POST", WORKER_EXTRACT_URL, body, mime))
        self.assertTrue(gate.consumed)
        self.assertFalse(gate.allow("POST", WORKER_EXTRACT_URL, body, mime))

    def test_duplicate_requests_cannot_race_the_one_shot_gate(self):
        fixture = load_fixture(ROOT, PNG)
        gate = ExtractGate(PNG)
        with ThreadPoolExecutor(max_workers=4) as pool:
            attempts = [pool.submit(
                gate.allow, "POST", WORKER_EXTRACT_URL, fixture.body, fixture.spec.mime_type,
            ) for _ in range(8)]
            self.assertEqual(sum(attempt.result() for attempt in attempts), 1)


if __name__ == "__main__":
    unittest.main()
