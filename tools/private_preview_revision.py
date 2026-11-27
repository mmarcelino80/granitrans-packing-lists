"""Select the exact revision carried by a private Windows test package."""

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path


REPOSITORY = "https://github.com/mmarcelino80/granitrans-packing-lists.git"
MANIFEST = "private-preview-revision.txt"
TOOLS_DIRECTORY = Path(__file__).resolve().parent
COMMIT = re.compile(r"[0-9a-f]{40}")


class RevisionError(RuntimeError):
    """A revision or checkout failed the launcher's checks."""


def git(directory, *args, check=True, binary=False):
    environment = os.environ.copy()
    for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"):
        environment.pop(name, None)
    decoding = {} if binary else {"encoding": "utf-8", "errors": "replace"}
    return subprocess.run(
        ["git", "-C", str(directory), *args],
        capture_output=True, check=check, timeout=20, env=environment, **decoding,
    )


def repository_at(directory):
    repository = Path(git(directory, "rev-parse", "--show-toplevel").stdout.strip()).resolve()
    if repository != directory.resolve():
        raise RevisionError("A pasta indicada não é a raiz da cópia Git.")
    origin = git(directory, "config", "--local", "--get", "remote.origin.url").stdout.rstrip("\r\n")
    if origin != REPOSITORY:
        raise RevisionError("A origem Git da cópia não corresponde ao repositório Granitrans.")


def committed_revision(directory, revision="HEAD"):
    result = git(directory, "rev-parse", "--verify", "--end-of-options", revision + "^{commit}", check=False)
    resolved = result.stdout.strip()
    if result.returncode != 0 or not COMMIT.fullmatch(resolved):
        raise RevisionError("O Git não identificou um commit completo para a revisão indicada.")
    return resolved


def resolve_revision(tools_directory=TOOLS_DIRECTORY):
    manifest = tools_directory / MANIFEST
    try:
        contents = manifest.read_bytes()
    except FileNotFoundError:
        repository = tools_directory.parent
        try:
            repository_at(repository)
            if git(repository, "status", "--porcelain=v1", "--untracked-files=all", "--", tools_directory.name).stdout:
                raise RevisionError("Os ficheiros do lançador têm alterações. Use uma revisão Git guardada ou o ZIP privado.")
            git(repository, "cat-file", "-e", f"HEAD:{tools_directory.name}/private_preview_revision.py")
            return committed_revision(repository)
        except (OSError, subprocess.SubprocessError):
            raise RevisionError(f"Não foi possível identificar a revisão. Mantenha {MANIFEST} junto dos ficheiros do lançador.") from None
    except OSError:
        raise RevisionError(f"Não foi possível ler {MANIFEST}.") from None

    if not re.fullmatch(rb"[0-9a-f]{40}(?:\r?\n)?", contents):
        raise RevisionError(f"O ficheiro {MANIFEST} deve conter um único SHA completo.")
    return contents.decode("ascii").rstrip("\r\n")


def verify_checkout(directory, revision):
    if not COMMIT.fullmatch(revision):
        raise RevisionError("O identificador da revisão é inválido.")
    try:
        repository_at(directory)
        if committed_revision(directory) != revision:
            raise RevisionError(f"A cópia Git não está na revisão {revision}.")
        if git(directory, "symbolic-ref", "--quiet", "HEAD", check=False).returncode != 1:
            raise RevisionError("A cópia de testes deve ter o HEAD destacado.")
        tracked_state = git(directory, "ls-files", "-v", "-z").stdout
        if any(entry[0] == "S" or entry[0].islower() for entry in tracked_state.split("\0") if entry):
            raise RevisionError("O índice Git tem ficheiros excluídos da verificação.")
        if git(directory, "status", "--porcelain=v1", "--untracked-files=all").stdout:
            raise RevisionError("A cópia de testes tem alterações locais.")
    except (OSError, subprocess.SubprocessError):
        raise RevisionError("Não foi possível verificar a cópia de testes. Execute a instalação inicial.") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-checkout", type=Path)
    parser.add_argument("--revision")
    options = parser.parse_args()
    try:
        revision = resolve_revision()
        if options.verify_checkout is None:
            print(revision)
        else:
            if options.revision != revision:
                raise RevisionError("A revisão do lançador mudou durante a instalação.")
            verify_checkout(options.verify_checkout, revision)
    except RevisionError as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
