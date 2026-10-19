#!/bin/sh
# Inside the box: put this fixture into ee's local mirror and deploy it as an app (the path a GitHub repo takes after fetch).
set -eu
SRC=/tmp/fixture-src
rm -rf "$SRC" && cp -r /fixture "$SRC" && cd "$SRC"
git init -q -b main && git -c user.name=t -c user.email=t@t add -A && git -c user.name=t -c user.email=t@t commit -qm "fixture ${1:-v1}"
MIRROR=/var/lib/ee/company/sources/fixture.git
[ -d "$MIRROR" ] || git init -q --bare "$MIRROR"
git push -q -f "$MIRROR" main:refs/remotes/origin/main
REV=$(git rev-parse HEAD)
call() { curl -s --unix-socket /run/ee/control/ee.sock -H 'content-type: application/json' -X "$1" "http://ee$2" -d "$3"; echo; }
call POST /v1/apps "{\"name\":\"fixture\",\"source\":{\"kind\":\"git\",\"mirror\":\"sources/fixture.git\",\"ref\":\"main\",\"rev\":\"$REV\"},\"env\":{\"GREETING\":\"${2:-hello}\"},\"secrets\":[],\"deploy\":{\"auto\":false},\"author\":\"e2e\"}"
