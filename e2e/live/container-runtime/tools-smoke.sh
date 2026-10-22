#!/usr/bin/env bash
# Copied into the test's own container; this fixture is not shipped in the image.
set -euo pipefail

phase=${1:?initial or restart}
probe_root=${2:?absolute scratch directory}
case "$phase" in initial|restart) ;; *) exit 2 ;; esac
case "$probe_root" in /workspace/runtime-smoke-*/deterministic) ;; *) echo 'Invalid scratch directory' >&2; exit 2 ;; esac
test "$(id -un)" = claude
mkdir -p "$probe_root"
cd "$probe_root"

export UV_CACHE_DIR="$probe_root/uv-cache"
export UV_TOOL_DIR="$probe_root/uv-tools"
export UV_TOOL_BIN_DIR="$probe_root/uv-bin"
export UV_PYTHON_DOWNLOADS=never
export BUN_INSTALL_CACHE_DIR="$probe_root/bun-cache"
runtime_python=$(command -v python3)

version() { printf 'RUNTIME\t%s\t%s\n' "$1" "$2"; }
check() { printf 'CHECK\t%s\tok\n' "$1"; }
version node "$(node -p 'process.versions.node')"
version python "$(python3 -c 'import platform; print(platform.python_version())')"
version uv "$(uv --version | awk '{print $2}')"
version bun "$(bun --version)"
version rclone "$(rclone version | sed -n '1s/^rclone v//p')"
version typescript "$(tsc --version | awk '{print $2}')"
version ts-node "$(ts-node --version | sed 's/^v//')"

check_copied_venv() {
  test ! -L copied-venv/bin/python3
  test "$(copied-venv/bin/python3 -c 'import platform; print(platform.python_version())')" = "$(python3 -c 'import platform; print(platform.python_version())')"
  copied-venv/bin/python3 -m pip --version
  for probe_python in python python3 python3.11; do
    "copied-venv/bin/$probe_python" - <<'PY'
import bz2, ctypes, lzma, sqlite3, ssl, sys
import numpy as np
assert sys.prefix != sys.base_prefix
assert ssl.create_default_context()
assert ctypes.CDLL(None)
assert sqlite3.connect(':memory:').execute('SELECT 19 + 23').fetchone()[0] == 42
assert bz2.decompress(bz2.compress(b'copies')) == b'copies'
assert lzma.decompress(lzma.compress(b'copies')) == b'copies'
assert np.__version__ == '2.2.6'
assert int(np.array([19, 23]).sum()) == 42
assert np.linalg.det(np.eye(3)) == 1
PY
  done
}

if [ "$phase" = initial ]; then
  # Preserve the former absolute aliases used by existing workspace venvs.
  for alias in /usr/bin/python /usr/bin/python3 /usr/bin/python3.11; do
    test "$(readlink -f "$runtime_python")" = "$(readlink -f "$alias")"
  done
  /usr/bin/python3.10 -c 'import ssl, sqlite3, bz2, lzma; assert ssl.create_default_context()'
  python3 - <<'PY'
import bz2, csv, ctypes, hashlib, io, json, lzma, pathlib, sqlite3, ssl, sys, tomllib, urllib.request, zlib
from datetime import datetime
from zoneinfo import ZoneInfo
assert '/opt/python/' in str(pathlib.Path(sys.executable).resolve())
payload = b'runtime-smoke\x00\xff'
for codec in (bz2, lzma, zlib):
    assert codec.decompress(codec.compress(payload)) == payload
assert json.loads(json.dumps({'answer': 42}))['answer'] == 42
assert tomllib.loads('answer = 42')['answer'] == 42
assert list(csv.reader(io.StringIO('a,b\n1,2\n')))[1] == ['1', '2']
assert hashlib.sha256(payload).hexdigest()
context = ssl.create_default_context()
# OpenSSL may load capath certificates lazily, so an empty pre-handshake
# get_ca_certs() does not mean verification is broken. Exercise real TLS.
with urllib.request.urlopen('https://pypi.org/simple/six/', context=context, timeout=30) as response:
    assert response.status == 200
assert ctypes.CDLL(None)
assert datetime(2026, 1, 1, tzinfo=ZoneInfo('America/New_York')).utcoffset().total_seconds() == -18000
assert datetime(2026, 7, 1, tzinfo=ZoneInfo('America/New_York')).utcoffset().total_seconds() == -14400
with sqlite3.connect('stdlib.sqlite') as db:
    db.execute('CREATE TABLE probe (answer INTEGER)')
    db.execute('INSERT INTO probe VALUES (42)')
    assert db.execute('SELECT answer FROM probe').fetchone() == (42,)
PY
  check python-stdlib

  # This supported nonroot workflow must not fail due to PEP 668. Keep its
  # user site in the test workspace so it can also be checked after replacement.
  export PYTHONUSERBASE="$probe_root/pip-user"
  python3 -m pip install --user --disable-pip-version-check --index-url https://pypi.org/simple six==1.17.0
  python3 -c 'import six; assert six.__version__ == "1.17.0"'
  check pip-user

  python3 -m venv stdlib-venv
  stdlib-venv/bin/python -m pip --version
  stdlib-venv/bin/python -c 'import sys; assert sys.prefix != sys.base_prefix'
  check stdlib-venv

  # A copied executable cannot follow the managed binary's original directory;
  # this specifically exercises the compatibility stdlib path in the image.
  python3 -m venv --copies copied-venv
  uv pip install --python copied-venv/bin/python3 --index-url https://pypi.org/simple --only-binary :all: numpy==2.2.6
  check_copied_venv
  check copied-venv

  uv venv --python "$runtime_python" uv-venv
  uv pip install --python uv-venv/bin/python --index-url https://pypi.org/simple six==1.17.0
  uv-venv/bin/python -c 'import six; assert six.__version__ == "1.17.0"'
  check uv-venv

  uv pip install --python uv-venv/bin/python --index-url https://pypi.org/simple --only-binary :all: numpy==2.2.6
  uv-venv/bin/python -c 'import numpy as np; assert np.__version__ == "2.2.6"; assert int(np.array([19, 23]).sum()) == 42; assert np.linalg.det(np.eye(3)) == 1'
  check native-wheel

  mkdir uv-project
  cat > uv-project/pyproject.toml <<'TOML'
[project]
name = "container-runtime-smoke"
version = "0.0.0"
requires-python = ">=3.11"
dependencies = ["six==1.17.0"]
TOML
  uv lock --project uv-project --python "$runtime_python" --index-url https://pypi.org/simple
  uv sync --project uv-project --python "$runtime_python" --frozen
  uv run --project uv-project --frozen --no-sync python -c 'import six, sqlite3; assert six.__version__ == "1.17.0"; assert sqlite3.connect(":memory:").execute("SELECT 42").fetchone()[0] == 42'
  check uv-project

  uv tool install --python "$runtime_python" --index-url https://pypi.org/simple wheel==0.45.1
  "$UV_TOOL_BIN_DIR/wheel" version
  check uv-tool
  uvx --python "$runtime_python" --index-url https://pypi.org/simple --from wheel==0.45.1 wheel version
  check uvx

  cat > node-probe.cjs <<'JS'
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const server = createServer((_request, response) => response.end('node-fetch-ok'))
server.listen(0, '127.0.0.1', async () => {
  try {
    assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}`)).text(), 'node-fetch-ok')
    assert.equal(Buffer.from('runtime').toString(), 'runtime')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
  finally { server.closeAllConnections(); server.close() }
})
JS
  node node-probe.cjs
  printf 'const answer: number = 42; console.log(answer)\n' > typescript-probe.ts
  tsc typescript-probe.ts --target ES2020 --module commonjs --outDir compiled
  test "$(node compiled/typescript-probe.js)" = 42
  test "$(ts-node --skip-project --compiler-options '{"module":"CommonJS"}' typescript-probe.ts)" = 42
  check node-typescript

  mkdir -p bun-project fixture-lib
  printf '{"name":"fixture-lib","version":"1.0.0","main":"index.js"}\n' > fixture-lib/package.json
  printf 'module.exports = { answer: 42 }\n' > fixture-lib/index.js
  printf '{"name":"bun-runtime-smoke","private":true,"dependencies":{"fixture-lib":"file:../fixture-lib"}}\n' > bun-project/package.json
  cat > bun-project/index.ts <<'TS'
import { answer } from 'fixture-lib'
const value: number = answer
if (value !== 42) throw new Error('Local dependency did not resolve')
const server = Bun.serve({ port: 0, fetch: () => new Response(String(value)) })
try {
  if (await (await fetch(`http://127.0.0.1:${server.port}`)).text() !== '42') throw new Error('Bun server failed')
} finally { server.stop(true) }
TS
  (cd bun-project && bun install --no-progress && bun run index.ts)
  check bun

  mkdir archive-source tar-output zip-output
  printf 'round-trip\000bytes\377\n' > archive-source/sample.bin
  tar -czf sample.tar.gz -C archive-source sample.bin
  tar -xzf sample.tar.gz -C tar-output
  (cd archive-source && zip -q ../sample.zip sample.bin)
  unzip -q sample.zip -d zip-output
  cmp archive-source/sample.bin tar-output/sample.bin
  cmp archive-source/sample.bin zip-output/sample.bin
  check archives

  ffmpeg -hide_banner -loglevel error -f lavfi -i sine=frequency=440:duration=0.2 -y tone.wav
  test "$(ffprobe -v error -show_entries stream=codec_type -of default=noprint_wrappers=1:nokey=1 tone.wav)" = audio
  python3 - <<'PY'
from pathlib import Path
stream = b'BT /F1 12 Tf 20 100 Td (runtime-smoke-pdf) Tj ET'
objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>', b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'\nendstream']
pdf = bytearray(b'%PDF-1.4\n'); offsets = [0]
for index, obj in enumerate(objects, 1):
    offsets.append(len(pdf)); pdf += f'{index} 0 obj\n'.encode() + obj + b'\nendobj\n'
xref = len(pdf)
pdf += f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode()
for offset in offsets[1:]: pdf += f'{offset:010d} 00000 n \n'.encode()
pdf += f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
Path('sample.pdf').write_bytes(pdf)
PY
  pdftotext sample.pdf sample.txt
  grep -q runtime-smoke-pdf sample.txt
  check media

  rclone copy archive-source rclone-copy --config /dev/null
  rclone check archive-source rclone-copy --config /dev/null --one-way
  cmp archive-source/sample.bin rclone-copy/sample.bin
  check rclone
  python3 /opt/gamut/bin/list-sessions.py --help >/dev/null
  python3 /opt/gamut/bin/read-session.py --help >/dev/null
  check python-helpers
else
  # No network or installation: these environments must survive replacement.
  PYTHONUSERBASE="$probe_root/pip-user" python3 -c 'import six; assert six.__version__ == "1.17.0"'
  check persisted-pip-user
  stdlib-venv/bin/python -c 'import ssl, sqlite3, sys; assert sys.prefix != sys.base_prefix'
  check persisted-stdlib-venv
  check_copied_venv
  check persisted-copied-venv
  uv-venv/bin/python -c 'import six; assert six.__version__ == "1.17.0"'
  check persisted-uv-venv
  uv-venv/bin/python -c 'import numpy as np; assert int(np.array([19, 23]).sum()) == 42; assert np.linalg.det(np.eye(3)) == 1'
  check persisted-native-wheel
  uv run --offline --project uv-project --frozen --no-sync python -c 'import six; assert six.__version__ == "1.17.0"'
  check persisted-uv-project
  "$UV_TOOL_BIN_DIR/wheel" version
  check persisted-uv-tool
  (cd bun-project && bun run index.ts)
  check persisted-bun
  python3 -c 'import sqlite3; assert sqlite3.connect("stdlib.sqlite").execute("SELECT answer FROM probe").fetchone()[0] == 42'
  cmp archive-source/sample.bin rclone-copy/sample.bin
  check persisted-files
fi
