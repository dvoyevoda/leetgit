"""Build the Chrome Web Store package from the standalone Chrome extension."""

import argparse
import hashlib
import json
from pathlib import Path
from tempfile import NamedTemporaryFile
from zipfile import ZIP_STORED, ZipFile, ZipInfo


EXTENSION = Path(__file__).resolve().parents[1] / "extension"
RUNTIME_FILES = (
    "app.js",
    "background.js",
    "commit.js",
    "github.js",
    "icons/128.png",
    "icons/16.png",
    "icons/24.png",
    "icons/32.png",
    "icons/48.png",
    "icons/mark.svg",
    "leetcode-feedback.js",
    "leetcode.js",
    "page-bridge.js",
    "popup.css",
    "popup.html",
    "popup.js",
    "problem-badges.js",
    "problem-context.js",
    "problem-description.js",
    "problem-status.js",
    "repository.js",
    "solution.js",
)


def package_files():
    manifest = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))
    short_name = manifest.get("short_name", manifest["name"])
    manifest["name"] = f"{short_name} - LeetCode to GitHub Sync"
    manifest["short_name"] = short_name
    manifest["permissions"] = [
        permission for permission in manifest["permissions"] if permission != "identity"
    ]
    manifest.pop("optional_host_permissions", None)
    files = {
        "config.js": b"export const workerOrigin = '';\n",
        "manifest.json": (json.dumps(manifest, indent=2, ensure_ascii=False) + "\n").encode("utf-8"),
    }
    for name in RUNTIME_FILES:
        source = EXTENSION / name
        if source.resolve() != source or not source.is_file():
            raise ValueError(f"Expected a regular runtime file at {source}")
        files[name] = source.read_bytes()
    return files


def build_zip(destination):
    files = package_files()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=destination.parent, suffix=".zip", delete=False) as output:
        temporary_path = Path(output.name)
    try:
        with ZipFile(temporary_path, "w") as archive:
            for name, content in sorted(files.items()):
                entry = ZipInfo(name, (1980, 1, 1, 0, 0, 0))
                entry.create_system = 3
                entry.external_attr = 0o100644 << 16
                # Storing small files directly keeps archive bytes independent of compression versions.
                archive.writestr(entry, content, compress_type=ZIP_STORED)
        temporary_path.replace(destination)
    finally:
        temporary_path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="Path to the Chrome Web Store ZIP")
    arguments = parser.parse_args()
    if arguments.output.suffix.lower() != ".zip":
        parser.error("the output filename must end in .zip")
    build_zip(arguments.output)
    digest = hashlib.sha256(arguments.output.read_bytes()).hexdigest()
    print(arguments.output)
    print(f"SHA-256 {digest}")


if __name__ == "__main__":
    main()
