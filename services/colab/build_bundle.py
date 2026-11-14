"""Build only the standalone runner files, with deterministic hashes; no repo/env upload."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import zipfile

FILES = ('sns_studio_model_adapter.py', 'model-contract.json', 'requirements-colab.txt', 'drive_one_shot.py', 'run_inference.py')


def build_bundle(root: Path) -> tuple[bytes, str]:
    contents = {name: (root/name).read_bytes().replace(b'\r\n', b'\n') for name in FILES}
    manifest = {name: hashlib.sha256(data).hexdigest() for name, data in contents.items()}
    contents['bundle-manifest.json'] = json.dumps(manifest, sort_keys=True).encode()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_STORED) as archive:
        for name, data in sorted(contents.items()):
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o600 << 16
            archive.writestr(info, data)
    data = buffer.getvalue()
    return data, hashlib.sha256(data).hexdigest()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    data, sha = build_bundle(Path(__file__).parent)
    args.output.write_bytes(data)
    print(f'bundle SHA-256: {sha}')
