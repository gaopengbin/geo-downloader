#!/usr/bin/env bash
set -Eeuo pipefail

config=/etc/nginx/sites-available/geod-website
backup=/etc/nginx/sites-available/geod-website.pre-redesign-20260927

[[ ! -e "$backup" ]]
sudo cp -p "$config" "$backup"

restore() {
  sudo cp -p "$backup" "$config"
  sudo nginx -t
  sudo systemctl reload nginx
}
trap restore ERR

sudo python3 - "$config" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
content = path.read_text()
needle = "    location /api/ { return 404; }\n"
assert content.count(needle) == 1
assert "location = /login {" not in content
content = content.replace(needle, needle + "    location = /login { try_files /login.html =404; }\n")
path.write_text(content)
PY

sudo nginx -t
sudo systemctl reload nginx
trap - ERR
echo "GeoD login route enabled; backup: $backup"
