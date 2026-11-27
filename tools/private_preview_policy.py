"""Allow only the explicitly selected synthetic guide in the private preview."""

from collections.abc import Mapping
from dataclasses import dataclass, field
from hashlib import sha256
from pathlib import Path
from threading import Lock
from types import MappingProxyType


APP_ORIGIN = "https://mmarcelino80.github.io"
APP_URL = APP_ORIGIN + "/granitrans-packing-lists/"
APP_CONFIG_URL = APP_URL + "extraction-config.mjs"
WORKER_ORIGIN = "https://granitrans-packing-list-extraction.mmarcelino-pt.workers.dev"
WORKER_AUTH_URL = WORKER_ORIGIN + "/auth"
WORKER_SESSION_CHECK_URL = WORKER_ORIGIN + "/session-check"
WORKER_EXTRACT_URL = WORKER_ORIGIN + "/extract"
FIXTURE_DIRECTORY = Path("tests", "fixtures", "gpt-6-luna")


class FixtureError(ValueError):
    """The file choice or checkout contents do not match the approved fixture."""


@dataclass(frozen=True)
class FixtureSpec:
    name: str
    mime_type: str
    size: int
    sha256: str

    def matches(self, body: bytes | None) -> bool:
        return (
            isinstance(body, bytes)
            and len(body) == self.size
            and sha256(body).hexdigest() == self.sha256
        )


FIXTURES: Mapping[str, FixtureSpec] = MappingProxyType({
    spec.name: spec for spec in (
        FixtureSpec(
            "foto-guia-espessura.png", "image/png", 59998,
            "0375769e715eefc106aa8f3c17bfddf367bd78af69b1432db16d50c54c72ce84",
        ),
        FixtureSpec(
            "foto-guia-ilegivel.jpg", "image/jpeg", 96426,
            "7186966823b0b9dfa16c5e7debc50967cc72d16e020c4d0f4be0152950a0c1c9",
        ),
        FixtureSpec(
            "guia-duas-paginas.pdf", "application/pdf", 2928,
            "21038044ff81cb060fe6731f2883e3527bf42773ed47031889956563dbfe4ec4",
        ),
    )
})


def _fixture_spec(name: str) -> FixtureSpec:
    if not isinstance(name, str) or name not in FIXTURES:
        raise FixtureError("Selecione uma das três guias sintéticas aprovadas.")
    return FIXTURES[name]


@dataclass(frozen=True)
class VerifiedFixture:
    spec: FixtureSpec
    body: bytes = field(repr=False)

    def file_payload(self) -> dict[str, str | bytes]:
        return {"name": self.spec.name, "mimeType": self.spec.mime_type, "buffer": self.body}


def load_fixture(source: Path, name: str) -> VerifiedFixture:
    """Read the fixture from the approved checkout and verify its exact bytes."""
    spec = _fixture_spec(name)
    try:
        canonical = source.resolve(strict=True) / FIXTURE_DIRECTORY / spec.name
        resolved = canonical.resolve(strict=True)
        if resolved != canonical or not resolved.is_file():
            raise FixtureError("A guia sintética deve estar no caminho previsto no checkout aprovado.")
        with resolved.open("rb") as fixture:
            body = fixture.read(spec.size + 1)
    except (OSError, RuntimeError):
        raise FixtureError("Não foi possível ler a guia sintética no checkout aprovado.") from None

    if not spec.matches(body):
        raise FixtureError("O conteúdo da guia sintética difere da versão aprovada.")
    return VerifiedFixture(spec, body)


class ExtractGate:
    """Authorize at most one outbound extraction in a preview run."""

    def __init__(self, fixture_name: str | None):
        self._fixture = _fixture_spec(fixture_name) if fixture_name is not None else None
        self._consumed = False
        self._lock = Lock()

    @property
    def consumed(self) -> bool:
        with self._lock:
            return self._consumed

    def allow(self, method: str, url: str, body: bytes | None, content_type: str | None) -> bool:
        """Check the exact URL, method, MIME type and bytes of the intercepted request."""
        fixture = self._fixture
        if (
            fixture is None
            or method != "POST"
            or url != WORKER_EXTRACT_URL
            or content_type != fixture.mime_type
        ):
            return False

        with self._lock:
            if self._consumed or not fixture.matches(body):
                return False
            self._consumed = True
            return True
