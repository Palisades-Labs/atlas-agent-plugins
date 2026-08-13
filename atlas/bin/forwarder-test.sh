#!/bin/sh
# Offline active-version and rollback regression for atlas-forwarder.
set -u

TEST_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
FORWARDER="$TEST_DIR/atlas-forwarder"
# shellcheck disable=SC2016
MCP_COMMAND='if [ -n "$CLAUDE_PLUGIN_ROOT" ]; then exec "$CLAUDE_PLUGIN_ROOT/bin/atlas" mcp; fi; exec ./bin/atlas mcp'

WORK=$(mktemp -d) || exit 1
trap 'rm -rf "$WORK"' EXIT INT TERM

STUB_BIN="$WORK/stub-bin"
CLAUDE_STATE="$WORK/claude-state.json"
CODEX_STATE="$WORK/codex-state.json"
CONFIG_HOME="$WORK/config"
INSTALL_PATH="$WORK/local/bin/atlas"
CODEX_HOME="$WORK/codex-home"
mkdir -p "$STUB_BIN" "$CONFIG_HOME" "$(dirname -- "$INSTALL_PATH")"
export CLAUDE_STATE CODEX_STATE CODEX_HOME

cat > "$STUB_BIN/claude" <<'EOF'
#!/bin/sh
[ "$*" = "plugin list --json" ] || exit 2
cat "$CLAUDE_STATE"
EOF
cat > "$STUB_BIN/codex" <<'EOF'
#!/bin/sh
[ "$*" = "plugin list --json" ] || exit 2
cat "$CODEX_STATE"
EOF
chmod +x "$STUB_BIN/claude" "$STUB_BIN/codex"
PATH="$STUB_BIN:$PATH"
export PATH

make_plugin() {
  root=$1
  version=$2
  mkdir -p "$root/bin" "$root/.claude-plugin"
  cat > "$root/.claude-plugin/plugin.json" <<EOF
{"name":"atlas","version":"$version"}
EOF
  cat > "$root/bin/atlas" <<EOF
#!/bin/sh
case "\${1:-}" in
  mcp) printf '%s:mcp\\n' '$version' ;;
  *) printf '%s:terminal:%s\\n' '$version' "\$*" ;;
esac
EOF
  chmod +x "$root/bin/atlas"
  cp "$FORWARDER" "$root/bin/atlas-forwarder"
  chmod +x "$root/bin/atlas-forwarder"
}

CLAUDE_OLD="$WORK/claude/cache/atlas-plugins/atlas/0.1.5"
CLAUDE_NEW="$WORK/claude/cache/atlas-plugins/atlas/0.1.6"
CODEX_OLD="$CODEX_HOME/plugins/cache/atlas-plugins/atlas/0.1.5"
CODEX_NEW="$CODEX_HOME/plugins/cache/atlas-plugins/atlas/0.1.6"
make_plugin "$CLAUDE_OLD" "0.1.5"
make_plugin "$CLAUDE_NEW" "0.1.6"
make_plugin "$CODEX_OLD" "0.1.5"
make_plugin "$CODEX_NEW" "0.1.6"

# Make mtime actively misleading: the old Claude cache is newer while the new
# Codex cache is newer. Every transition below must still follow host state.
touch -t 202601010000 "$CLAUDE_NEW" "$CODEX_OLD"
touch -t 202602010000 "$CLAUDE_OLD" "$CODEX_NEW"

write_claude_state() {
  root=$1
  version=$2
  cat > "$CLAUDE_STATE" <<EOF
[
  {
    "id": "atlas@atlas-plugins",
    "version": "$version",
    "scope": "user",
    "enabled": true,
    "installPath": "$root"
  }
]
EOF
}

write_codex_state() {
  version=$1
  cat > "$CODEX_STATE" <<EOF
{
  "installed": [
    {
      "pluginId": "atlas@atlas-plugins",
      "name": "atlas",
      "marketplaceName": "atlas-plugins",
      "version": "$version",
      "installed": true,
      "enabled": true,
      "source": {
        "source": "git",
        "url": "https://example.invalid/atlas-agent-plugins"
      }
    }
  ],
  "available": []
}
EOF
}

FAILURES=0
pass() { printf 'PASS: %s\n' "$1"; }
fail() {
  printf 'FAIL: %s\n' "$1"
  FAILURES=$((FAILURES + 1))
}

assert_equal() {
  label=$1
  expected=$2
  actual=$3
  if [ "$actual" = "$expected" ]; then
    pass "$label"
  else
    fail "$label (expected: $expected; got: $actual)"
  fi
}

assert_claude_leg() {
  version=$1
  root=$2
  write_claude_state "$root" "$version"
  terminal=$(
    ATLAS_FORWARDER_CONFIG_HOME="$CONFIG_HOME" \
      "$INSTALL_PATH" --version
  )
  mcp=$(
    CLAUDE_PLUGIN_ROOT="$root" sh -c "$MCP_COMMAND"
  )
  assert_equal "Claude terminal follows active $version" "$version:terminal:--version" "$terminal"
  assert_equal "Claude MCP follows active $version" "$version:mcp" "$mcp"
}

assert_codex_leg() {
  version=$1
  root=$2
  write_codex_state "$version"
  terminal=$(
    ATLAS_FORWARDER_CONFIG_HOME="$CONFIG_HOME" \
      "$INSTALL_PATH" --version
  )
  mcp=$(
    cd "$root" && CLAUDE_PLUGIN_ROOT='' sh -c "$MCP_COMMAND"
  )
  assert_equal "Codex terminal follows active $version" "$version:terminal:--version" "$terminal"
  assert_equal "Codex MCP follows active $version" "$version:mcp" "$mcp"
}

# Install from active N-1, then prove N-1 → N → N-1 → N. The installed shim
# never changes; only the host's active record does.
write_claude_state "$CLAUDE_OLD" "0.1.5"
ATLAS_FORWARDER_CONFIG_HOME="$CONFIG_HOME" \
ATLAS_FORWARDER_INSTALL_PATH="$INSTALL_PATH" \
  "$FORWARDER" --forwarder-install claude >/dev/null
assert_claude_leg "0.1.5" "$CLAUDE_OLD"
assert_claude_leg "0.1.6" "$CLAUDE_NEW"
assert_claude_leg "0.1.5" "$CLAUDE_OLD"
assert_claude_leg "0.1.6" "$CLAUDE_NEW"

# Switch the same stable shim to Codex and repeat the full rollback sequence.
write_codex_state "0.1.5"
ATLAS_FORWARDER_CONFIG_HOME="$CONFIG_HOME" \
  "$INSTALL_PATH" --forwarder-select-host codex >/dev/null
assert_codex_leg "0.1.5" "$CODEX_OLD"
assert_codex_leg "0.1.6" "$CODEX_NEW"
assert_codex_leg "0.1.5" "$CODEX_OLD"
assert_codex_leg "0.1.6" "$CODEX_NEW"

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "forwarder-test: ALL TESTS PASSED"
  exit 0
fi
echo "forwarder-test: $FAILURES TEST(S) FAILED"
exit 1
