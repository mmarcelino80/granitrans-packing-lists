"""Open an isolated Windows Edge session for Granitrans v0.2 acceptance testing."""

import csv
import json
import os
import posixpath
import re
import secrets
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from time import monotonic, time
from urllib.parse import parse_qs, unquote, urlsplit

from playwright.sync_api import Error as BrowserError, sync_playwright

if __package__:
    from . import private_preview_policy as policy
else:
    import private_preview_policy as policy


APP_URL = policy.APP_URL
WORKER_ORIGIN = policy.WORKER_ORIGIN
SIM_WORKER_ORIGIN = "https://packing-list-simulation.example.test"
APP_TITLE = "Granitrans v0.2 — Ambiente de testes"
APPROVED_COMMIT = "d34fa31df4316ecc7e125c9fa26f6e2689f0b8ea"
MODES = {"simulation": "Simulação", "auth": "Autenticação", "live": "Extração real"}
NONCE = re.compile(r"[A-Za-z0-9_-]{32,128}")
SCRIPT = "text/javascript; charset=utf-8"
APP_FILES = {
    "index.html": "text/html; charset=utf-8",
    "styles.css": "text/css; charset=utf-8",
    "manifest.webmanifest": "application/manifest+json",
    **dict.fromkeys(
        ["app.mjs", "packing-list.mjs", "extraction-client.mjs", "guides.mjs", "review.mjs",
         "logistics.mjs", "logistics-ui.mjs", "packing-pdf.mjs", "assets/pdf-lib.min.js"], SCRIPT
    ),
    **dict.fromkeys(
        [
            "assets/apple-touch-icon.png", "assets/granitrans-logo.png", "assets/granitrans-symbol.png",
            "assets/icon-192.png", "assets/icon-512.png",
        ],
        "image/png",
    ),
    "assets/app-icons.svg": "image/svg+xml",
}
APP_SECURITY = {
    "Cache-Control": "no-store",
    "Content-Security-Policy": (
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; "
        "connect-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
    ),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
}
BANNER_CSS = """
#private-preview { background: #fff6dc; color: #211805; padding: .7rem 1rem;
  border-bottom: 1px solid #a87923; text-align: center; }
#private-preview p { margin: .25rem 0 0; }
#private-preview button { margin: .5rem auto 0; }
"""
AUTH_ACTION = """
import { createExtractionClient } from './extraction-client.mjs';

const client = createExtractionClient(%s);
const button = document.querySelector('#private-preview-login');
const status = document.querySelector('#private-preview-status');
button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = 'A aguardar a confirmação da sessão…';
  try {
    await client.login();
    status.textContent = 'Identidade e sessão verificadas. Nenhuma guia foi enviada.';
  } catch {
    status.textContent = 'Não foi possível confirmar a sessão. Volte a tentar.';
  } finally {
    button.disabled = false;
  }
});
"""


class PreviewError(RuntimeError):
    """A failure that can be reported without exposing browser or request data."""


def verify_checkout(source):
    def git(*args):
        return subprocess.run(
            ["git", "-C", str(source), *args], capture_output=True, text=True, check=True, timeout=20,
        ).stdout.strip()

    try:
        if Path(git("rev-parse", "--show-toplevel")).resolve() != source.resolve():
            raise PreviewError("A pasta indicada não é a raiz da cópia de testes.")
        if git("rev-parse", "HEAD") != APPROVED_COMMIT or git("status", "--porcelain"):
            raise PreviewError("A cópia de testes deve estar limpa na revisão aprovada. Execute a instalação inicial.")
    except (OSError, subprocess.SubprocessError):
        raise PreviewError("Não foi possível verificar a cópia de testes. Execute a instalação inicial.") from None


def is_real_extract(url):
    parts = urlsplit(url)
    if parts.hostname != urlsplit(WORKER_ORIGIN).hostname:
        return False
    # Block variants that a browser or edge could normalize to the extraction endpoint.
    path = posixpath.normpath("/" + unquote(parts.path).replace("\\", "/").lstrip("/"))
    return path.lower() == "/extract"


def is_popup_frame(request, origin):
    try:
        frame_url = urlsplit(request.frame.url)
    except BrowserError:
        return False
    query = parse_qs(frame_url.query, keep_blank_values=True)
    nonce = query.get("nonce", [])
    return (
        frame_url.scheme + "://" + frame_url.netloc == origin
        and frame_url.path == "/auth"
        and not frame_url.fragment
        and set(query) == {"nonce"}
        and len(nonce) == 1
        and NONCE.fullmatch(nonce[0]) is not None
    )


def local_assets(source, mode, case):
    assets = {
        APP_URL + name: (mime, (source / name).read_bytes())
        for name, mime in APP_FILES.items()
    }
    title = APP_TITLE + " · " + MODES[mode]
    content = (
        f'<aside id="private-preview" aria-label="Ambiente de testes"><strong>{title}</strong>'
        '<p>Use apenas guias sintéticas. Reserve o TXT para revisão local.</p>'
    )
    if case is not None:
        content += f'<p>Guia autorizada nesta sessão: <strong>{case}</strong></p>'
    if mode == "auth":
        content += (
            '<button id="private-preview-login" type="button">Verificar autenticação</button>'
            '<p id="private-preview-status" role="status"></p>'
        )
        assets[APP_URL + "private-preview-auth.mjs"] = (SCRIPT, AUTH_ACTION % json.dumps(WORKER_ORIGIN))
    content += "</aside>"
    mime, html = assets[APP_URL + "index.html"]
    html = html.decode("utf-8").replace("<body>", "<body>\n" + content, 1)
    html = html.replace("<title>Granitrans — Packing List</title>", f"<title>{title}</title>", 1)
    if mode == "auth":
        html = html.replace("</head>", '  <script type="module" src="./private-preview-auth.mjs"></script>\n</head>', 1)
    assets[APP_URL] = assets[APP_URL + "index.html"] = (mime, html)
    mime, css = assets[APP_URL + "styles.css"]
    assets[APP_URL + "styles.css"] = (mime, css.decode("utf-8") + BANNER_CSS)
    target = {"simulation": SIM_WORKER_ORIGIN, "auth": "", "live": WORKER_ORIGIN}[mode]
    assets[policy.APP_CONFIG_URL] = (SCRIPT, f"export const extractionWorkerUrl = {json.dumps(target)}; export const logisticsEnabled = true;")
    return assets


def simulated_worker(source, start):
    fixture_json = source / policy.FIXTURE_DIRECTORY / "expected.json"
    cases = {case["file"]: case["expected"] for case in json.loads(fixture_json.read_text(encoding="utf-8"))["cases"]}
    bridge_source = (source / "worker" / "auth-bridge.mjs").read_text(encoding="utf-8")
    bridge = re.fullmatch(r"[\s\S]*?export const authBridgeScript = String\.raw`([^\x60]+)`;\s*", bridge_source)
    if bridge is None or "${" in bridge[1] or "</script" in bridge[1].lower():
        raise PreviewError("A versão local da janela de autenticação simulada é incompatível.")
    token = "sessao-sintetica"
    headers = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}

    def serve(route):
        request = route.request
        url = urlsplit(request.url)
        if request.method == "GET" and url.path == "/auth":
            nonce = parse_qs(url.query).get("nonce", [""])[0]
            if NONCE.fullmatch(nonce):
                csp_nonce = secrets.token_urlsafe(24)
                config = json.dumps({
                    "target": policy.APP_ORIGIN, "nonce": nonce, "token": token,
                    "expiresAt": int(time() * 1000) + 900_000,
                })
                route.fulfill(
                    content_type="text/html; charset=utf-8",
                    headers={
                        **headers,
                        "Content-Security-Policy": (
                            f"default-src 'none'; script-src 'nonce-{csp_nonce}'; connect-src 'self'; "
                            "frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
                        ),
                        "Referrer-Policy": "no-referrer",
                    },
                    body=(
                        '<!doctype html><html lang="pt-PT"><meta charset="utf-8"><title>Simulação Granitrans</title>'
                        '<p id="status" role="status">A confirmar a sessão simulada…</p>'
                        f'<script nonce="{csp_nonce}">({bridge[1]})({config});</script></html>'
                    ),
                )
                return
        if (
            request.method != "POST"
            or url.query
            or url.path not in {"/session-check", "/extract"}
            or not is_popup_frame(request, SIM_WORKER_ORIGIN)
            or request.header_value("origin") != SIM_WORKER_ORIGIN
            or request.header_value("authorization") != "Bearer " + token
        ):
            route.abort()
            return
        if url.path == "/session-check":
            route.fulfill(headers=headers, json={"authenticated": True})
            return
        body = request.post_data_buffer
        spec = next((fixture for fixture in policy.FIXTURES.values() if fixture.matches(body)), None)
        if not spec:
            route.fulfill(status=400, headers=headers, json={
                "error": "A simulação aceita apenas as três guias sintéticas aprovadas.",
            })
            return
        start(request, spec.name)
        route.fulfill(headers=headers, json={"documents": [
            {**cases[spec.name], "name": spec.name, "id": spec.sha256},
        ]})

    return serve


def configure_preview(context, source, mode="simulation", case=None, record=None):
    if mode not in MODES or (mode == "live") != (case is not None):
        raise PreviewError("Escolha um modo e, para extração real, uma guia sintética.")
    gate = policy.ExtractGate(case)
    assets = local_assets(source, mode, case)
    in_flight = {}

    def start(request, fixture_name):
        if record is not None:
            in_flight[request] = (monotonic(), fixture_name)

    def finish(request, status=None):
        if request not in in_flight:
            return
        started, fixture_name = in_flight.pop(request)
        elapsed_ms = round((monotonic() - started) * 1000)
        if status is None:
            response = request.response()
            status = response.status if response else "falha de transporte"
        record(mode, fixture_name, status, elapsed_ms)

    context.on("requestfinished", finish)
    context.on("requestfailed", lambda request: finish(request, "falha de transporte"))

    def serve_app(route):
        asset = assets.get(route.request.url)
        if route.request.method != "GET" or asset is None:
            route.abort()
            return
        mime, body = asset
        route.fulfill(content_type=mime, body=body, headers=APP_SECURITY)

    if mode == "simulation":
        simulate = simulated_worker(source, start)

        def offline(route):
            url = route.request.url
            if url.startswith(policy.APP_ORIGIN + "/"):
                serve_app(route)
            elif url.startswith(SIM_WORKER_ORIGIN + "/"):
                simulate(route)
            else:
                route.abort()

        context.route("**/*", offline)
        return

    def restrict_extract(route):
        request = route.request
        if (mode != "live" or not is_popup_frame(request, WORKER_ORIGIN)
                or request.header_value("origin") != WORKER_ORIGIN):
            route.abort()
            return
        if not gate.allow(
            request.method, request.url, request.post_data_buffer, request.header_value("content-type"),
        ):
            route.abort()
            return
        start(request, case)
        route.fallback()

    context.route(is_real_extract, restrict_extract)
    context.route(policy.APP_ORIGIN + "/**", serve_app)


def choose_mode():
    print(APP_TITLE)
    print("1 — Simulação (predefinição)\n2 — Autenticação\n3 — Extração real")
    option = input("Modo [1]: ").strip() or "1"
    mode = {"1": "simulation", "2": "auth", "3": "live"}.get(option)
    if mode is None:
        raise PreviewError("Opção de modo inválida.")
    if mode != "live":
        return mode, None
    print("Uma leitura real usa a quota do Worker e pode ter custo na API.")
    for number, name in enumerate(policy.FIXTURES, 1):
        print(f"{number} — {name}")
    choice = {str(i): name for i, name in enumerate(policy.FIXTURES, 1)}.get(input("Guia sintética: ").strip())
    if choice is None:
        raise PreviewError("Guia sintética inválida.")
    if input("Escreva EXTRAIR para armar um único pedido desta guia: ").strip() != "EXTRAIR":
        raise PreviewError("Extração cancelada.")
    return mode, choice


def write_metric(mode, filename, status, elapsed_ms):
    valid_status = (isinstance(status, int) and 100 <= status <= 599) or status == "falha de transporte"
    if (mode not in {"simulation", "live"} or filename not in policy.FIXTURES
            or not valid_status or type(elapsed_ms) is not int or elapsed_ms < 0):
        return
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    print(f"{MODES[mode]} | {filename} | {status} | {elapsed_ms} ms", flush=True)
    try:
        report_path = Path(os.environ["LOCALAPPDATA"]) / "GranitransV02Teste" / "leituras.csv"
        report_path.parent.mkdir(parents=True, exist_ok=True)
        with report_path.open("a", encoding="utf-8", newline="") as report:
            latest = csv.writer(report)
            if report.tell() == 0:
                latest.writerow(("data_utc", "modo", "guia_sintetica", "resultado", "duracao_ms"))
            latest.writerow((now, MODES[mode], filename, status, elapsed_ms))
    except (OSError, KeyError):
        print("Não foi possível guardar a duração no ficheiro local.", file=sys.stderr, flush=True)


def run_preview(source, mode, case):
    fixture = policy.load_fixture(source, case) if case is not None else None
    launch_options = {"channel": "msedge", "headless": False, "args": ["--start-maximized"]}
    if mode == "simulation":
        # No browser egress even if it attempts a request outside the HTTP routing hooks.
        launch_options["proxy"] = {"server": "http://127.0.0.1:9", "bypass": "<-loopback>"}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(**launch_options)
        context = browser.new_context(locale="pt-PT", service_workers="block", no_viewport=True)
        configure_preview(context, source, mode=mode, case=case, record=write_metric)
        page = context.new_page()
        page.goto(APP_URL)
        if fixture is not None:
            page.locator("#guides").set_input_files(fixture.file_payload())
        print("Feche o separador da aplicação para terminar a sessão de teste.", flush=True)
        page.wait_for_event("close", timeout=0)
        context.close()
        browser.close()


def main():
    import argparse

    parser = argparse.ArgumentParser(description=APP_TITLE)
    parser.add_argument("--source", required=True, type=Path, help="Cópia local independente da aplicação")
    args = parser.parse_args()
    try:
        verify_checkout(args.source)
        mode, case = choose_mode()
        run_preview(args.source, mode, case)
    except (PreviewError, policy.FixtureError) as error:
        print(str(error), file=sys.stderr)
        return 1
    except (BrowserError, OSError, KeyError, ValueError):
        print("Não foi possível iniciar ou concluir a sessão de teste. Verifique o Edge e a instalação.", file=sys.stderr)
        return 1
    except (EOFError, KeyboardInterrupt):
        print("\nSessão de teste terminada.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
