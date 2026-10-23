"""Run CLI/MCP regression tests with an isolated, explicitly disabled local telemetry default."""
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
env = dict(os.environ, GEOD_TEST_BIN=str(root/'target/debug/geod.exe'), GEOD_TELEMETRY='0')
files = sorted(str(p) for p in (root/'packages/geod-mcp/test').glob('*.test.mjs'))
result = subprocess.run(['node', '--test', *files], cwd=root, env=env, capture_output=True, text=True, encoding='utf-8', errors='replace')
out = root/'artifacts/tools-usage-tests'
out.mkdir(parents=True, exist_ok=True)
(out/'mcp.log').write_text(result.stdout + result.stderr, encoding='utf-8')
print('\n'.join((result.stdout + result.stderr).splitlines()[-45:]))
sys.exit(result.returncode)
