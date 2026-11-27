import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

from tools.package_private_preview import FILES, MANIFEST_PATH, package
from tools.private_preview_revision import (
    MANIFEST, REPOSITORY, RevisionError, committed_revision, git, resolve_revision, verify_checkout,
)


class PrivatePreviewRevisionTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="granitrans-revisao-")
        self.addCleanup(directory.cleanup)
        self.base = Path(directory.name)
        self.repository = self.base / "Git com espaços"
        self.repository.mkdir()
        git(self.repository, "init", "-q")
        git(self.repository, "remote", "add", "origin", REPOSITORY)
        for name in FILES:
            path = self.repository / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("Ficheiro da revisão inicial\n", encoding="utf-8")
        self.first = self.commit("Primeira revisão")

    def commit(self, message):
        git(self.repository, "add", "--all")
        git(
            self.repository, "-c", "user.name=Teste", "-c", "user.email=preview@example.test",
            "commit", "-qm", message,
        )
        return committed_revision(self.repository)

    def test_artifact_uses_only_the_selected_commit_and_carries_its_exact_revision(self):
        source = self.repository / "tools/private_preview.py"
        source.write_bytes(b"committed change\n")
        second = self.commit("Segunda revisão")
        source.write_bytes(b"not committed\n")
        target = self.base / "Instalador privado.zip"

        self.assertEqual(package(self.repository, second, target), second)
        with ZipFile(target) as archive:
            self.assertEqual(archive.read("tools/private_preview.py"), b"committed change\n")
            self.assertEqual(archive.read(MANIFEST_PATH), (second + "\r\n").encode("ascii"))
            self.assertEqual({name for name in archive.namelist() if not name.endswith("/")}, {*FILES, MANIFEST_PATH})
            archive.extractall(self.base / "ZIP extraído")
        self.assertEqual(resolve_revision(self.base / "ZIP extraído" / "tools"), second)

    def test_unknown_revision_produces_no_artifact(self):
        target = self.base / "Não deve existir.zip"
        with self.assertRaisesRegex(RevisionError, "não identificou um commit"):
            package(self.repository, "missing-revision", target)
        self.assertFalse(target.exists())

    def test_checkout_tools_follow_exact_head_and_reject_tampered_tools(self):
        tools = self.repository / "tools"
        self.assertEqual(resolve_revision(tools), self.first)
        source = tools / "private_preview.py"
        source.write_bytes(b"updated launcher\n")
        with self.assertRaisesRegex(RevisionError, "têm alterações"):
            resolve_revision(tools)
        second = self.commit("Atualiza o lançador")
        self.assertEqual(resolve_revision(tools), second)

    def test_malformed_package_manifest_fails_closed_even_inside_repository(self):
        tools = self.repository / "tools"
        for data in (b"HEAD\n", b"f" * 39, b"f" * 40 + b"\nextra\n"):
            with self.subTest(data=data):
                (tools / MANIFEST).write_bytes(data)
                with self.assertRaisesRegex(RevisionError, "SHA completo"):
                    resolve_revision(tools)

    def test_installation_requires_exact_origin_and_clean_detached_revision(self):
        with self.assertRaisesRegex(RevisionError, "HEAD destacado"):
            verify_checkout(self.repository, self.first)

        git(self.repository, "checkout", "--detach", self.first)
        verify_checkout(self.repository, self.first)
        with self.assertRaisesRegex(RevisionError, "não está na revisão"):
            verify_checkout(self.repository, "f" * 40)
        with self.assertRaisesRegex(RevisionError, "raiz"):
            verify_checkout(self.repository / "tools", self.first)

        git(self.repository, "update-index", "--assume-unchanged", "tools/private_preview.py")
        with self.assertRaisesRegex(RevisionError, "excluídos da verificação"):
            verify_checkout(self.repository, self.first)
        git(self.repository, "update-index", "--no-assume-unchanged", "tools/private_preview.py")

        (self.repository / "untracked.txt").write_bytes(b"user change")
        with self.assertRaisesRegex(RevisionError, "tem alterações locais"):
            verify_checkout(self.repository, self.first)
        (self.repository / "untracked.txt").unlink()
        git(self.repository, "remote", "set-url", "origin", "https://example.test/repo.git")
        with self.assertRaisesRegex(RevisionError, "origem Git"):
            verify_checkout(self.repository, self.first)


if __name__ == "__main__":
    unittest.main()
