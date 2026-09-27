#!/usr/bin/env bash
set -Eeuo pipefail

release_id=geod-redesign-20260927-01
archive=/srv/laogao/staging/geod-website-redesign-20260927-01/site.tar.gz
release=/srv/laogao/releases/geod-website/$release_id
current=/srv/laogao/current/geod-website
old=/srv/laogao/releases/geod-website/geod-analytics-20260927-03
expected_hash=1585478625e378129f55c2605210562007cbd6007120a3e84dabb92d04f41336
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
for page in index browser cli mcp login dashboard history disclaimer; do
  test -s "$release/$page.html"
done

ln -s "$release" "${current}.next-${release_id}"
mv -Tf "${current}.next-${release_id}" "$current"
switched=true

for path in / /browser /cli /mcp /login /dashboard /history /disclaimer; do
  curl --fail --silent --show-error --max-time 10 -o /dev/null "https://geod.laogao.xyz${path}"
done

switched=false
trap - ERR
echo "GeoD website release $release_id is live; rollback target $old"
