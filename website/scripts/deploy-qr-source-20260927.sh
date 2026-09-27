#!/usr/bin/env bash
set -Eeuo pipefail

release_id=geod-qr-source-20260927-02
archive=/srv/laogao/staging/geod-website-qr-source-20260927-02/site.tar.gz
release=/srv/laogao/releases/geod-website/$release_id
current=/srv/laogao/current/geod-website
old=/srv/laogao/releases/geod-website/geod-redesign-20260927-01
expected_hash=65a6ece271be1a097f56ea234dad0cb7f72575c79ccdf6b36c05aa193d6348c4
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
test ! -e "$release/geod-site/wxq_sq.png"
test ! -e "$release/geod-site/gzh.jpg"
grep -q 'https://laogao.xyz/packages/qr-assets/wxq_sq.png' "$release/index.html"

ln -s "$release" "${current}.next-${release_id}"
mv -Tf "${current}.next-${release_id}" "$current"
switched=true

curl --fail --silent --show-error --max-time 10 -o /dev/null https://geod.laogao.xyz/
curl --fail --silent --show-error --max-time 10 -o /dev/null https://laogao.xyz/packages/qr-assets/wxq_sq.png
curl --fail --silent --show-error --max-time 10 -o /dev/null https://laogao.xyz/packages/qr-assets/gzh.jpg

switched=false
trap - ERR
echo "GeoD website release $release_id is live; rollback target $old"
