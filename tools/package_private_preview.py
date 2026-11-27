"""Build a private Windows launcher ZIP from one committed revision."""

import argparse
import io
import subprocess
import sys
from pathlib import Path
from zipfile import ZipFile

if __package__:
    from .private_preview_policy import FIXTURES, FIXTURE_DIRECTORY
    from .private_preview_revision import MANIFEST, TOOLS_DIRECTORY, RevisionError, committed_revision, git
else:
    from private_preview_policy import FIXTURES, FIXTURE_DIRECTORY
    from private_preview_revision import MANIFEST, TOOLS_DIRECTORY, RevisionError, committed_revision, git


FILES = (
    "tools/Abrir Granitrans Teste.cmd",
    "tools/Instalar Granitrans Teste.cmd",
    "tools/private-preview-requirements.txt",
    "tools/private_preview.py",
    "tools/private_preview_policy.py",
    "tools/private_preview_revision.py",
    "docs/testar-v02-windows.md",
    *((FIXTURE_DIRECTORY / name).as_posix() for name in (*FIXTURES, "expected.json")),
)
MANIFEST_PATH = "tools/" + MANIFEST


def package(repository, selected_revision, output):
    revision = committed_revision(repository, selected_revision)
    original = git(repository, "archive", "--format=zip", revision, "--", *FILES, binary=True).stdout
    data = io.BytesIO(original)
    with ZipFile(data, "a") as archive:
        included = {name for name in archive.namelist() if not name.endswith("/")}
        if included != set(FILES):
            raise ValueError("O arquivo Git não contém exatamente os ficheiros do lançador.")
        archive.writestr(MANIFEST_PATH, revision + "\r\n")
    with output.open("xb") as file:
        file.write(data.getbuffer())
    return revision


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision", default="HEAD")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        revision = package(TOOLS_DIRECTORY.parent, args.revision, args.output)
    except (OSError, ValueError, RevisionError, subprocess.SubprocessError) as error:
        print(f"Falha ao criar o ZIP: {error}", file=sys.stderr)
        return 1
    print(f"Revisão incluída: {revision}\nZIP: {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
