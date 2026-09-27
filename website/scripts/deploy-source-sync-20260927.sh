#!/usr/bin/env bash
set -Eeuo pipefail

release_id=geod-source-sync-20260927-abc4b9b
archive=/srv/laogao/staging/geod-source-sync-20260927/geod-website-sources-abc4b9b.tar.gz
expected_hash=a961bc64a931f135ea61dede4ade493c34a61711d61fe313c8c6ecec75dca6d7
release=/srv/laogao/releases/geod-website/$release_id
previous=/srv/laogao/releases/geod-website/geod-source-sync-20260927-f08303f
current=/srv/laogao/current/geod-website
switched=false

rollback() {
  if [[ "$switched" == true ]]; then
    ln -s "$previous" "${current}.rollback-${release_id}"
    mv -Tf "${current}.rollback-${release_id}" "$current"
    echo "Rolled GeoD website back to $previous" >&2
  fi
}
trap rollback ERR

[[ "$(readlink -f "$current")" == "$previous" ]]
[[ ! -e "$release" ]]
test "$(curl --silent --show-error --max-time 8 -o /dev/null -w '%{http_code}' https://geod.laogao.xyz/api/account/sources)" = 401
printf '%s  %s\n' "$expected_hash" "$archive" | sha256sum -c -
tar -tzf "$archive" >/dev/null
mkdir -p "$release"
tar -xzf "$archive" -C "$release"
test -s "$release/index.html"
test -s "$release/browser.html"
grep -Rql '将本机' "$release/_next/static/chunks" || grep -Rql 'GeoD 账号' "$release/_next/static/chunks"

ln -s "$release" "${current}.next-${release_id}"
mv -Tf "${current}.next-${release_id}" "$current"
switched=true

curl --fail --silent --show-error --max-time 8 https://geod.laogao.xyz/browser >/dev/null
curl --fail --silent --show-error --max-time 8 https://geod.laogao.xyz/ >/dev/null
switched=false
trap - ERR
echo "GeoD website $release_id is live; rollback target $previous"
