#!/bin/sh
# launcher-test.sh — offline tests for atlas/bin/atlas.
#
# CI-safe by construction: curl, cosign, and gh are stubbed with local fixtures
# — no network is ever touched. The launcher + pin files are copied into a sandbox
# dir so the repo's real cli-checksums (which pins release digests, not test
# fixtures) never interferes. Run from anywhere:
#   sh atlas/bin/launcher-test.sh
#
# Asserts:
#   1. unauthenticated MCP startup exits 3 before any download
#   2. the launcher composes the correct release URLs
#   3. args pass through to the downloaded binary (--version reaches the stub)
#   4. a verified second invocation skips the download (cache hit), while a
#      tampered cached binary is deleted and replaced
#   4. a release-checksums.txt mismatch aborts and deletes the download
#   5. a pinned-digest (cli-checksums) mismatch fails closed
#   6. a missing/duplicate pinned entry and invalid version fail closed
#   7. stale-prune age gate: fresh .download.* dirs survive, hour-old ones die
#   8. concurrent first-runs both succeed (no mutual download deletion)
#   9. cosign verifies the target-specific bundle against the exact builder
#      workflow/tag + GitHub OIDC issuer, and a MISMATCH is fatal
#  10. verification does not call GitHub's private attestation API
#  11. a network/rate-limit Sigstore failure skips with a notice
#  11b. a missing bundle skips with a notice after checksums pass
#  12. upgrade: a cached OLD version plus a new pinned version downloads the
#      new binary, digest-verifies it, and leaves the old cache alone —
#      superseded version caches are pruned ONLY by the 30-day age policy
#      (a month-old superseded dir dies; the pinned dir survives any age)
set -u

TEST_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
VERSION=$(tr -d ' \t\r\n' < "$TEST_DIR/cli-version")
REPO="${ATLAS_PLUGIN_REPO:-Palisades-Labs/atlas-agent-plugins}"
BASE_URL="https://github.com/$REPO/releases/download/atlas-cli-v$VERSION"

# Resolve the host target the same way the launcher does.
case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux)  OS=linux ;;
  *) echo "launcher-test: unsupported test host $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=x64 ;;
  *) echo "launcher-test: unsupported test host arch $(uname -m)" >&2; exit 1 ;;
esac
TARGET="$OS-$ARCH"

if command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  sha256() { sha256sum "$1" | awk '{print $1}'; }
fi

WORK=$(mktemp -d) || exit 1
trap 'rm -rf "$WORK"' EXIT INT TERM

FIXTURES="$WORK/fixtures"
STUB_BIN="$WORK/stub-bin"
SANDBOX="$WORK/launcher-bin"
CURL_LOG="$WORK/curl.log"
COSIGN_LOG="$WORK/cosign.log"
GH_LOG="$WORK/gh.log"
COSIGN_FAIL_FLAG="$WORK/cosign-fail"
COSIGN_NETFAIL_FLAG="$WORK/cosign-netfail"
BUNDLE_MISSING_FLAG="$WORK/bundle-missing"
mkdir -p "$FIXTURES" "$STUB_BIN" "$SANDBOX"
: > "$CURL_LOG"
: > "$COSIGN_LOG"
: > "$GH_LOG"
export FIXTURES CURL_LOG COSIGN_LOG GH_LOG COSIGN_FAIL_FLAG COSIGN_NETFAIL_FLAG BUNDLE_MISSING_FLAG

# Sandboxed launcher: the real script + version pin, but a cli-checksums we
# control (the repo's real one pins release digests, not our fixtures).
cp "$TEST_DIR/atlas" "$SANDBOX/atlas"
cp "$TEST_DIR/cli-version" "$SANDBOX/cli-version"
chmod +x "$SANDBOX/atlas"
LAUNCHER="$SANDBOX/atlas"

# Fixture "binary": a script that echoes its args so passthrough is observable.
cat > "$FIXTURES/atlas-binary" << 'EOF'
#!/bin/sh
printf 'atlas-stub invoked with args: %s\n' "$*"
EOF
chmod +x "$FIXTURES/atlas-binary"

# Checksum manifest covering all 4 targets. Only the host target's hash is
# real — the other 3 binaries are absent, so this also proves the launcher
# FILTERS the manifest instead of checking it whole.
GOOD_HASH=$(sha256 "$FIXTURES/atlas-binary")
BOGUS_HASH="deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
: > "$FIXTURES/checksums-good.txt"
for t in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
  if [ "$t" = "$TARGET" ]; then
    printf '%s  atlas-%s\n' "$GOOD_HASH" "$t" >> "$FIXTURES/checksums-good.txt"
  else
    printf '%s  atlas-%s\n' "$BOGUS_HASH" "$t" >> "$FIXTURES/checksums-good.txt"
  fi
done
# Bad manifest: wrong hash for the host target too.
sed "s/^$GOOD_HASH/$BOGUS_HASH/" "$FIXTURES/checksums-good.txt" > "$FIXTURES/checksums-bad.txt"
cp "$FIXTURES/checksums-good.txt" "$FIXTURES/checksums.txt"
printf '{"fixture":"keyless-sigstore-bundle"}\n' > "$FIXTURES/atlas.sigstore.json"

# Pinned-digest file variants (same line format as checksums.txt).
cp "$FIXTURES/checksums-good.txt" "$FIXTURES/pin-good"
cp "$FIXTURES/checksums-bad.txt"  "$FIXTURES/pin-bad"
grep -v " atlas-$TARGET\$" "$FIXTURES/checksums-good.txt" > "$FIXTURES/pin-missing-entry"
cp "$FIXTURES/pin-good" "$SANDBOX/cli-checksums"

# curl stub: records the requested URL, serves the matching fixture.
cat > "$STUB_BIN/curl" << 'EOF'
#!/bin/sh
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s\n' "$url" >> "$CURL_LOG"
case "$url" in
  */checksums.txt) cp "$FIXTURES/checksums.txt" "$out" ;;
  */atlas-*.sigstore.json)
    [ -e "$BUNDLE_MISSING_FLAG" ] && exit 22
    cp "$FIXTURES/atlas.sigstore.json" "$out"
    ;;
  */atlas-*)       cp "$FIXTURES/atlas-binary" "$out" ;;
  *) exit 22 ;;
esac
EOF
chmod +x "$STUB_BIN/curl"

# cosign stub: records the invocation; behavior is driven by flag files.
#   COSIGN_NETFAIL_FLAG → verify-blob fails with a network-y stderr
#   COSIGN_FAIL_FLAG    → verify-blob fails with a signature MISMATCH stderr
cat > "$STUB_BIN/cosign" << 'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$COSIGN_LOG"
if [ -e "$COSIGN_FAIL_FLAG" ]; then
  echo "signature verification failed: bundle digest does not match the artifact" >&2
  exit 1
fi
if [ -e "$COSIGN_NETFAIL_FLAG" ]; then
  echo "failed to connect to tuf-repo-cdn.sigstore.dev: dial tcp: i/o timeout" >&2
  exit 1
fi
exit 0
EOF
chmod +x "$STUB_BIN/cosign"

# A failing gh stub proves the launcher no longer depends on GitHub's private
# repository attestation API.
cat > "$STUB_BIN/gh" << 'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$GH_LOG"
exit 99
EOF
chmod +x "$STUB_BIN/gh"

PATH="$STUB_BIN:$PATH"
export PATH

FAILURES=0
pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

# --- Test 1: MCP auto-start without credentials fails before any download.
XDG_CACHE_HOME="$WORK/cache-no-auth"
export XDG_CACHE_HOME
NO_AUTH_CONFIG="$WORK/config-no-auth"
mkdir -p "$NO_AUTH_CONFIG"
COUNT_BEFORE_NO_AUTH=$(wc -l < "$CURL_LOG" | tr -d ' ')
NO_AUTH_OUT=$(ATLAS_API_KEY='' ATLAS_CONFIG_HOME="$NO_AUTH_CONFIG" "$LAUNCHER" mcp 2>&1)
NO_AUTH_STATUS=$?
COUNT_AFTER_NO_AUTH=$(wc -l < "$CURL_LOG" | tr -d ' ')

if [ "$NO_AUTH_STATUS" -eq 3 ]; then
  pass "unauthenticated MCP startup exits 3"
else
  fail "unauthenticated MCP startup exits 3 (got $NO_AUTH_STATUS; output: $NO_AUTH_OUT)"
fi
if [ "$NO_AUTH_OUT" = "run 'atlas login' first, then restart your agent" ]; then
  pass "unauthenticated MCP startup gives the exact login/restart guidance"
else
  fail "unauthenticated MCP startup gives login/restart guidance (got: $NO_AUTH_OUT)"
fi
if [ "$COUNT_BEFORE_NO_AUTH" = "$COUNT_AFTER_NO_AUTH" ]; then
  pass "unauthenticated MCP startup performs no download"
else
  fail "unauthenticated MCP startup performs no download (curl $COUNT_BEFORE_NO_AUTH→$COUNT_AFTER_NO_AUTH)"
fi

# --- Tests 2 + 3: fresh cache → downloads from the right URLs, args pass through
XDG_CACHE_HOME="$WORK/cache-main"
export XDG_CACHE_HOME
OUT=$("$LAUNCHER" --version 2>&1)
STATUS=$?

if [ "$STATUS" -eq 0 ]; then
  pass "fresh run exits 0"
else
  fail "fresh run exits 0 (got $STATUS; output: $OUT)"
fi

if grep -qx "$BASE_URL/atlas-$TARGET" "$CURL_LOG"; then
  pass "binary URL composed correctly ($BASE_URL/atlas-$TARGET)"
else
  fail "binary URL composed correctly (curl log: $(cat "$CURL_LOG"))"
fi

if grep -qx "$BASE_URL/checksums.txt" "$CURL_LOG"; then
  pass "checksums URL composed correctly ($BASE_URL/checksums.txt)"
else
  fail "checksums URL composed correctly (curl log: $(cat "$CURL_LOG"))"
fi

case "$OUT" in
  *"is not cached — downloading and verifying it"*"atlas-stub invoked with args: --version"*)
    pass "first download is explained and args pass through to the binary"
    ;;
  *) fail "first download is explained and args pass through to the binary (got: $OUT)" ;;
esac

# --- Test: target-specific keyless bundle verification ran
if grep -q "^verify-blob " "$COSIGN_LOG"; then
  pass "cosign verify-blob runs when cosign is present"
else
  fail "cosign verify-blob runs when cosign is present (cosign log: $(cat "$COSIGN_LOG"))"
fi

if grep -q -- "--bundle .*atlas-$TARGET.sigstore.json --certificate-identity https://github.com/blast-double/auto-prospector/.github/workflows/release-cli.yml@refs/tags/cli-v$VERSION --certificate-oidc-issuer https://token.actions.githubusercontent.com" "$COSIGN_LOG"; then
  pass "Sigstore verification pins the target bundle, workflow tag identity, and OIDC issuer"
else
  fail "Sigstore verification pins the target bundle, workflow tag identity, and OIDC issuer (cosign log: $(cat "$COSIGN_LOG"))"
fi

if grep -qx "$BASE_URL/atlas-$TARGET.sigstore.json" "$CURL_LOG"; then
  pass "target-specific Sigstore bundle URL composed correctly"
else
  fail "target-specific Sigstore bundle URL composed correctly (curl log: $(cat "$CURL_LOG"))"
fi

# --- Test 3: second invocation skips the download (cache hit)
COUNT_BEFORE=$(wc -l < "$CURL_LOG" | tr -d ' ')
OUT2=$("$LAUNCHER" --check-cache-hit 2>&1)
STATUS2=$?
COUNT_AFTER=$(wc -l < "$CURL_LOG" | tr -d ' ')

if [ "$STATUS2" -eq 0 ] && [ "$OUT2" = "atlas-stub invoked with args: --check-cache-hit" ]; then
  pass "second invocation still execs the binary"
else
  fail "second invocation still execs the binary (status $STATUS2; got: $OUT2)"
fi

if [ "$COUNT_BEFORE" = "$COUNT_AFTER" ]; then
  pass "second invocation skips download (curl calls: $COUNT_BEFORE before, $COUNT_AFTER after)"
else
  fail "second invocation skips download (curl calls: $COUNT_BEFORE before, $COUNT_AFTER after)"
fi

# A cache hit is re-hashed every time. Replacing it with executable junk must
# trigger a delete + verified re-download rather than executing the junk.
printf '#!/bin/sh\necho TAMPERED\n' > "$WORK/cache-main/atlas-cli/$VERSION/atlas-$TARGET"
chmod +x "$WORK/cache-main/atlas-cli/$VERSION/atlas-$TARGET"
COUNT_BEFORE_TAMPER=$(wc -l < "$CURL_LOG" | tr -d ' ')
TAMPER_OUT=$("$LAUNCHER" --after-tamper 2>&1)
TAMPER_STATUS=$?
COUNT_AFTER_TAMPER=$(wc -l < "$CURL_LOG" | tr -d ' ')

case "$TAMPER_OUT" in
  *"cached atlas-$TARGET failed pinned digest verification"*"atlas-stub invoked with args: --after-tamper"*)
    if [ "$TAMPER_STATUS" -eq 0 ]; then
      pass "tampered cached binary is deleted and replaced before execution"
    else
      fail "tampered cached binary replacement exits 0 (got $TAMPER_STATUS)"
    fi
    ;;
  *) fail "tampered cached binary is deleted and replaced before execution (got: $TAMPER_OUT)" ;;
esac

if [ "$COUNT_AFTER_TAMPER" -eq $((COUNT_BEFORE_TAMPER + 3)) ]; then
  pass "tampered cache replacement fetches binary, checksums, and Sigstore bundle"
else
  fail "tampered cache replacement fetches 3 release assets (curl calls: $COUNT_BEFORE_TAMPER before, $COUNT_AFTER_TAMPER after)"
fi

# --- Test 4: release checksums.txt mismatch aborts and deletes the download
cp "$FIXTURES/checksums-bad.txt" "$FIXTURES/checksums.txt"
XDG_CACHE_HOME="$WORK/cache-badsum"
export XDG_CACHE_HOME
ERR_OUT=$("$LAUNCHER" --version 2>&1)
ERR_STATUS=$?

if [ "$ERR_STATUS" -eq 1 ]; then
  pass "release checksum mismatch exits 1"
else
  fail "release checksum mismatch exits 1 (got $ERR_STATUS; output: $ERR_OUT)"
fi

case "$ERR_OUT" in
  *"checksum verification failed"*) pass "release checksum mismatch reports a clear error" ;;
  *) fail "release checksum mismatch reports a clear error (got: $ERR_OUT)" ;;
esac

if [ ! -e "$WORK/cache-badsum/atlas-cli/$VERSION/atlas-$TARGET" ] \
   && [ -z "$(find "$WORK/cache-badsum" -name "atlas-$TARGET" 2>/dev/null)" ]; then
  pass "failed download is deleted (no cached binary left behind)"
else
  fail "failed download is deleted (found leftover binary under $WORK/cache-badsum)"
fi

cp "$FIXTURES/checksums-good.txt" "$FIXTURES/checksums.txt"

# --- Test 5: pinned-digest (cli-checksums) mismatch fails closed
cp "$FIXTURES/pin-bad" "$SANDBOX/cli-checksums"
XDG_CACHE_HOME="$WORK/cache-badpin"
export XDG_CACHE_HOME
PIN_OUT=$("$LAUNCHER" --version 2>&1)
PIN_STATUS=$?

if [ "$PIN_STATUS" -eq 1 ]; then
  pass "pinned digest mismatch exits 1 (fails closed)"
else
  fail "pinned digest mismatch exits 1 (got $PIN_STATUS; output: $PIN_OUT)"
fi

case "$PIN_OUT" in
  *"pinned digest verification failed"*) pass "pinned digest mismatch reports a clear error" ;;
  *) fail "pinned digest mismatch reports a clear error (got: $PIN_OUT)" ;;
esac

if [ -z "$(find "$WORK/cache-badpin" -name "atlas-$TARGET" 2>/dev/null)" ]; then
  pass "pinned-mismatch download is deleted"
else
  fail "pinned-mismatch download is deleted (found leftover binary under $WORK/cache-badpin)"
fi

# --- Test 6: missing pinned entry fails closed
cp "$FIXTURES/pin-missing-entry" "$SANDBOX/cli-checksums"
XDG_CACHE_HOME="$WORK/cache-nopin"
export XDG_CACHE_HOME
NOPIN_OUT=$("$LAUNCHER" --version 2>&1)
NOPIN_STATUS=$?

if [ "$NOPIN_STATUS" -eq 1 ]; then
  pass "missing pinned entry exits 1 (fails closed)"
else
  fail "missing pinned entry exits 1 (got $NOPIN_STATUS; output: $NOPIN_OUT)"
fi

case "$NOPIN_OUT" in
  *"exactly one pinned digest"*) pass "missing pinned entry reports a clear error" ;;
  *) fail "missing pinned entry reports a clear error (got: $NOPIN_OUT)" ;;
esac

cp "$FIXTURES/pin-good" "$SANDBOX/cli-checksums"

# Duplicate pins are ambiguous and must fail before any download.
grep " atlas-$TARGET\$" "$FIXTURES/pin-good" >> "$SANDBOX/cli-checksums"
XDG_CACHE_HOME="$WORK/cache-duplicate-pin"
export XDG_CACHE_HOME
DUP_OUT=$("$LAUNCHER" --version 2>&1)
DUP_STATUS=$?
if [ "$DUP_STATUS" -eq 1 ]; then
  pass "duplicate pinned entry exits 1 (fails closed)"
else
  fail "duplicate pinned entry exits 1 (got $DUP_STATUS; output: $DUP_OUT)"
fi
cp "$FIXTURES/pin-good" "$SANDBOX/cli-checksums"

# The version is used in cache paths and release URLs; reject unsafe syntax.
printf '../unsafe\n' > "$SANDBOX/cli-version"
XDG_CACHE_HOME="$WORK/cache-invalid-version"
export XDG_CACHE_HOME
VERSION_OUT=$("$LAUNCHER" --version 2>&1)
VERSION_STATUS=$?
if [ "$VERSION_STATUS" -eq 1 ]; then
  pass "invalid cli-version exits 1 before path or network use"
else
  fail "invalid cli-version exits 1 (got $VERSION_STATUS; output: $VERSION_OUT)"
fi
cp "$TEST_DIR/cli-version" "$SANDBOX/cli-version"

# --- Test 7: stale-prune age gate — fresh .download.* dirs survive, old die
XDG_CACHE_HOME="$WORK/cache-prune"
export XDG_CACHE_HOME
PRUNE_CACHE="$WORK/cache-prune/atlas-cli/$VERSION"
mkdir -p "$PRUNE_CACHE/.download.fresh" "$PRUNE_CACHE/.download.old"
: > "$PRUNE_CACHE/.download.fresh/partial"
: > "$PRUNE_CACHE/.download.old/partial"
touch -t 202001010000 "$PRUNE_CACHE/.download.old"
"$LAUNCHER" --version >/dev/null 2>&1

if [ -d "$PRUNE_CACHE/.download.fresh" ]; then
  pass "fresh in-flight .download.* dir survives the prune (concurrency-safe)"
else
  fail "fresh in-flight .download.* dir survives the prune"
fi

if [ ! -d "$PRUNE_CACHE/.download.old" ]; then
  pass "hour-old stale .download.* dir is pruned"
else
  fail "hour-old stale .download.* dir is pruned"
fi

# --- Test 8: concurrent first-runs both succeed (no mutual deletion)
XDG_CACHE_HOME="$WORK/cache-race"
export XDG_CACHE_HOME
"$LAUNCHER" --race-a > "$WORK/race-a.out" 2>&1 &
PID_A=$!
"$LAUNCHER" --race-b > "$WORK/race-b.out" 2>&1 &
PID_B=$!
wait "$PID_A"; RACE_A=$?
wait "$PID_B"; RACE_B=$?

if [ "$RACE_A" -eq 0 ] && grep -q "atlas-stub invoked with args: --race-a" "$WORK/race-a.out"; then
  pass "concurrent first-run A succeeds"
else
  fail "concurrent first-run A succeeds (status $RACE_A; got: $(cat "$WORK/race-a.out"))"
fi

if [ "$RACE_B" -eq 0 ] && grep -q "atlas-stub invoked with args: --race-b" "$WORK/race-b.out"; then
  pass "concurrent first-run B succeeds"
else
  fail "concurrent first-run B succeeds (status $RACE_B; got: $(cat "$WORK/race-b.out"))"
fi

# --- Test 9: a present Sigstore bundle MISMATCH is fatal
: > "$COSIGN_FAIL_FLAG"
XDG_CACHE_HOME="$WORK/cache-cosign-fail"
export XDG_CACHE_HOME
SIGFAIL_OUT=$("$LAUNCHER" --version 2>&1)
SIGFAIL_STATUS=$?
rm -f "$COSIGN_FAIL_FLAG"

if [ "$SIGFAIL_STATUS" -eq 1 ]; then
  pass "Sigstore bundle mismatch exits 1 (fatal when cosign is present)"
else
  fail "Sigstore bundle mismatch exits 1 (got $SIGFAIL_STATUS; output: $SIGFAIL_OUT)"
fi

case "$SIGFAIL_OUT" in
  *"Sigstore provenance verification failed"*) pass "Sigstore mismatch reports a clear error" ;;
  *) fail "Sigstore mismatch reports a clear error (got: $SIGFAIL_OUT)" ;;
esac

# --- Test 10: verification never calls GitHub's private attestation API
XDG_CACHE_HOME="$WORK/cache-no-gh-attest"
export XDG_CACHE_HOME
NO_GH_OUT=$("$LAUNCHER" --version 2>&1)
NO_GH_STATUS=$?

if [ "$NO_GH_STATUS" -eq 0 ]; then
  pass "Sigstore verification succeeds without GitHub repository access"
else
  fail "Sigstore verification succeeds without GitHub repository access (got $NO_GH_STATUS; output: $NO_GH_OUT)"
fi

case "$NO_GH_OUT" in
  *"atlas-stub invoked with args: --version"*) pass "bundle-verified run execs the binary" ;;
  *) fail "bundle-verified run execs the binary (got: $NO_GH_OUT)" ;;
esac

if [ -s "$GH_LOG" ]; then
  fail "launcher does not invoke gh for provenance verification (gh log: $(cat "$GH_LOG"))"
else
  pass "launcher does not invoke gh for provenance verification"
fi

# --- Test 11: network/rate-limit Sigstore failure skips with a notice
: > "$COSIGN_NETFAIL_FLAG"
XDG_CACHE_HOME="$WORK/cache-cosign-net"
export XDG_CACHE_HOME
NET_OUT=$("$LAUNCHER" --version 2>&1)
NET_STATUS=$?
rm -f "$COSIGN_NETFAIL_FLAG"

if [ "$NET_STATUS" -eq 0 ]; then
  pass "network Sigstore failure does not block the launch (exit 0)"
else
  fail "network Sigstore failure does not block the launch (got $NET_STATUS; output: $NET_OUT)"
fi

case "$NET_OUT" in
  *"Sigstore verification could not run (network/tooling failure) — skipping"*) pass "network Sigstore failure emits the skip notice" ;;
  *) fail "network Sigstore failure emits the skip notice (got: $NET_OUT)" ;;
esac

case "$NET_OUT" in
  *"atlas-stub invoked with args: --version"*) pass "network-failure run still execs the binary" ;;
  *) fail "network-failure run still execs the binary (got: $NET_OUT)" ;;
esac

# --- Test 11b: missing signed bundle skips after both checksum checks pass
: > "$BUNDLE_MISSING_FLAG"
XDG_CACHE_HOME="$WORK/cache-missing-bundle"
export XDG_CACHE_HOME
NOATT_OUT=$("$LAUNCHER" --version 2>&1)
NOATT_STATUS=$?
rm -f "$BUNDLE_MISSING_FLAG"

if [ "$NOATT_STATUS" -eq 0 ]; then
  pass "missing Sigstore bundle does not block the launch after checksums pass"
else
  fail "missing Sigstore bundle does not block the launch (got $NOATT_STATUS; output: $NOATT_OUT)"
fi

case "$NOATT_OUT" in
  *"Sigstore bundle is unavailable — skipping provenance verification"*) pass "missing bundle emits the skip notice" ;;
  *) fail "missing bundle emits the skip notice (got: $NOATT_OUT)" ;;
esac

case "$NOATT_OUT" in
  *"atlas-stub invoked with args: --version"*) pass "missing-bundle run still execs the binary" ;;
  *) fail "missing-bundle run still execs the binary (got: $NOATT_OUT)" ;;
esac

# --- Test 12: upgrade scenario — cached old version + new pinned version.
# Simulates a plugin update: the user already has OLD_VERSION cached from
# previous runs, the updated plugin pins $VERSION. The launcher must download
# the new binary (digest-verified), run it, and leave the old cache dir alone
# (rollback safety) — superseded caches die ONLY via the 30-day age policy.
OLD_VERSION="0.0.0-previous"
XDG_CACHE_HOME="$WORK/cache-upgrade"
export XDG_CACHE_HOME
OLD_DIR="$WORK/cache-upgrade/atlas-cli/$OLD_VERSION"
ANCIENT_DIR="$WORK/cache-upgrade/atlas-cli/0.0.0-ancient"
mkdir -p "$OLD_DIR" "$ANCIENT_DIR"
cp "$FIXTURES/atlas-binary" "$OLD_DIR/atlas-$TARGET"
chmod +x "$OLD_DIR/atlas-$TARGET"
cp "$FIXTURES/atlas-binary" "$ANCIENT_DIR/atlas-$TARGET"
touch -t 202001010000 "$ANCIENT_DIR/atlas-$TARGET" "$ANCIENT_DIR"

COUNT_BEFORE_UPGRADE=$(wc -l < "$CURL_LOG" | tr -d ' ')
UP_OUT=$("$LAUNCHER" --after-upgrade 2>&1)
UP_STATUS=$?
COUNT_AFTER_UPGRADE=$(wc -l < "$CURL_LOG" | tr -d ' ')

if [ "$UP_STATUS" -eq 0 ] && printf '%s\n' "$UP_OUT" | grep -q "atlas-stub invoked with args: --after-upgrade"; then
  pass "upgrade run downloads and execs the NEW pinned version"
else
  fail "upgrade run downloads and execs the NEW pinned version (status $UP_STATUS; got: $UP_OUT)"
fi

# 3 fetches (binary + checksums.txt + Sigstore bundle) prove the new version was downloaded —
# the old cache did not satisfy the new pin.
if [ "$COUNT_AFTER_UPGRADE" -eq $((COUNT_BEFORE_UPGRADE + 3)) ]; then
  pass "upgrade fetches the new binary + checksums + Sigstore bundle (old cache does not satisfy the new pin)"
else
  fail "upgrade fetches all 3 release assets (curl calls: $COUNT_BEFORE_UPGRADE before, $COUNT_AFTER_UPGRADE after)"
fi

if [ -x "$WORK/cache-upgrade/atlas-cli/$VERSION/atlas-$TARGET" ]; then
  pass "new version binary is cached (digest-verified) under its own version dir"
else
  fail "new version binary is cached (digest-verified) under its own version dir"
fi

if [ -x "$OLD_DIR/atlas-$TARGET" ]; then
  pass "recently used superseded version survives the upgrade (rollback safety — age policy only)"
else
  fail "recently used superseded version survives the upgrade (old cache dir was deleted)"
fi

if [ ! -d "$ANCIENT_DIR" ]; then
  pass "month-old superseded version cache is pruned by the age policy"
else
  fail "month-old superseded version cache is pruned by the age policy"
fi

# Age policy never touches the PINNED version dir: backdate it and re-run —
# the cached binary must still be there (and exec'd, no re-download).
touch -t 202001010000 "$WORK/cache-upgrade/atlas-cli/$VERSION" "$WORK/cache-upgrade/atlas-cli/$VERSION/atlas-$TARGET"
COUNT_BEFORE_PINNED=$(wc -l < "$CURL_LOG" | tr -d ' ')
PINNED_OUT=$("$LAUNCHER" --pinned-age-check 2>&1)
PINNED_STATUS=$?
COUNT_AFTER_PINNED=$(wc -l < "$CURL_LOG" | tr -d ' ')

if [ "$PINNED_STATUS" -eq 0 ] && [ "$PINNED_OUT" = "atlas-stub invoked with args: --pinned-age-check" ] \
   && [ "$COUNT_BEFORE_PINNED" = "$COUNT_AFTER_PINNED" ]; then
  pass "pinned version dir survives the age policy regardless of age (cache hit, no re-download)"
else
  fail "pinned version dir survives the age policy regardless of age (status $PINNED_STATUS; curl $COUNT_BEFORE_PINNED→$COUNT_AFTER_PINNED; got: $PINNED_OUT)"
fi

# --- Summary
echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "launcher-test: ALL TESTS PASSED"
  exit 0
else
  echo "launcher-test: $FAILURES TEST(S) FAILED"
  exit 1
fi
