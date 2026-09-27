#!/usr/bin/env bash
set -Eeuo pipefail

release_id=geod-analytics-20260927-03
archive=/srv/laogao/staging/geod-website-analytics-20260927-03/site.tar.gz
release=/srv/laogao/releases/geod-website/$release_id
current=/srv/laogao/current/geod-website
old=/srv/laogao/releases/geod-website/geod-analytics-20260927-02
expected_hash=7623ca22405ae93f56d2fb5420f83d05b4565858398aababa36d5bd64b5dfb8d
switched=false

rollback() {
  if [[ "$switched" == true ]]; then
    ln -s "$old" "${current}.rollback-${release_id}"
    mv -Tf "${current}.rollback-${release_id}" "$current"
    echo "Rolled website back to $old" >&2
  fi
}
trap rollback ERR

[[ "$(readlink -f "$current")" == "$old" ]]
[[ ! -e "$release" ]]
printf '%s  %s\n' "$expected_hash" "$archive" | sha256sum -c -
tar -tzf "$archive" >/dev/null
mkdir -p "$release"
tar -xzf "$archive" -C "$release"
test -s "$release/index.html"
test -s "$release/browser.html"
test -s "$release/cli.html"
test -s "$release/mcp.html"
test -s "$release/disclaimer.html"

ln -s "$release" "${current}.next-${release_id}"
mv -Tf "${current}.next-${release_id}" "$current"
switched=true

for path in / /browser /cli /mcp /disclaimer; do
  curl --fail --silent --show-error --max-time 10 -o /dev/null "https://geod.laogao.xyz${path}"
done

switched=false
trap - ERR
echo "GeoD website release $release_id is live; rollback target $old"
