"""Read GeoD CLI/MCP usage, locally or through the pinned production SSH connection."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--remote', action='store_true')
parser.add_argument('--days', type=int, default=7)
parser.add_argument('--directory', default='/srv/laogao/data/geod-mcp/usage')
parser.add_argument('--accounts', default='/srv/laogao/data/geod-studio/accounts/store.json')
parser.add_argument('--include-excluded', action='store_true')
parser.add_argument('--output', type=Path)
args = parser.parse_args()
arguments = ['--days', str(args.days), '--directory', args.directory, '--accounts', args.accounts]
if args.include_excluded:
    arguments.append('--include-excluded')
source = root/'services/tools-analytics/report.py'
if args.remote:
    home = Path.home()
    known = home/'.codex/skills/laogao-tencent-deploy/references/known_hosts'
    key = home/'.ssh/laogao_tencent_ed25519'
    if not known.is_file() or not key.is_file():
        raise SystemExit('Pinned SSH configuration is unavailable')
    command = ['ssh', '-i', str(key), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
               '-o', 'ConnectTimeout=15', '-o', 'UserKnownHostsFile='+str(known), 'ubuntu@62.234.147.130', 'python3 -']
    payload = 'import sys\nsys.argv=' + repr(['report.py', *arguments]) + '\n' + source.read_text(encoding='utf-8')
else:
    command, payload = [sys.executable, '-X', 'utf8', str(source), *arguments], None
completed = subprocess.run(command, input=payload, text=True, encoding='utf-8', capture_output=True, timeout=90)
if completed.returncode:
    raise SystemExit('Read-only tools usage query failed; no service changes were made')
value = json.loads(completed.stdout)
if args.output:
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(value, ensure_ascii=False, indent=2))
