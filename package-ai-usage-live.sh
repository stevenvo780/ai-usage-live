#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="${VERSION:-$(node -p "require('./package.json').version" 2>/dev/null || echo 0.5.5)}"
PKG_NAME="ai-usage-live"
BUILD_DIR="$ROOT/build/${PKG_NAME}_${VERSION}_all"
DIST_DIR="$ROOT/dist"

rm -rf "$ROOT/build" "$ROOT/dist"/*.deb 2>/dev/null || true
rm -rf "$BUILD_DIR"
mkdir -p \
  "$BUILD_DIR/DEBIAN" \
  "$BUILD_DIR/opt/ai-usage-live" \
  "$BUILD_DIR/usr/bin" \
  "$BUILD_DIR/usr/share/doc/ai-usage-live"

install -m 0755 "$ROOT/ai-usage-tui.mjs" "$BUILD_DIR/opt/ai-usage-live/ai-usage-tui.mjs"
install -m 0755 "$ROOT/gemini-quota-capture.py" "$BUILD_DIR/opt/ai-usage-live/gemini-quota-capture.py"
install -m 0755 "$ROOT/antigravity-usage-capture.py" "$BUILD_DIR/opt/ai-usage-live/antigravity-usage-capture.py"
install -m 0755 "$ROOT/ai-usage.sh" "$BUILD_DIR/opt/ai-usage-live/ai-usage.sh"
install -m 0755 "$ROOT/ai-usage-quota" "$BUILD_DIR/opt/ai-usage-live/ai-usage-quota"
install -m 0644 "$ROOT/LICENSE" "$BUILD_DIR/usr/share/doc/ai-usage-live/LICENSE"
install -m 0644 "$ROOT/README.md" "$BUILD_DIR/usr/share/doc/ai-usage-live/README.md"

cat > "$BUILD_DIR/usr/bin/ai-usage-live" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
exec node /opt/ai-usage-live/ai-usage-tui.mjs "$@"
WRAPPER

cat > "$BUILD_DIR/usr/bin/ai-usage" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
exec /opt/ai-usage-live/ai-usage.sh "$@"
WRAPPER

cat > "$BUILD_DIR/usr/bin/ai-usage-quota" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
exec /opt/ai-usage-live/ai-usage-quota "$@"
WRAPPER

chmod 0755 "$BUILD_DIR/usr/bin/ai-usage-live" "$BUILD_DIR/usr/bin/ai-usage" "$BUILD_DIR/usr/bin/ai-usage-quota"

cat > "$BUILD_DIR/DEBIAN/control" <<CONTROL
Package: ai-usage-live
Version: $VERSION
Section: utils
Priority: optional
Architecture: all
Depends: nodejs, npm, python3
Maintainer: Local Codex <local@example.invalid>
Description: Terminal dashboard for local AI CLI usage
 Provides a btop-style terminal dashboard for Claude Code, Codex CLI,
 Gemini CLI, Antigravity, MiniMax, and OpenCode Go. Usage is read from local files
 through ccusage where supported, plus provider quota APIs where available.
CONTROL

mkdir -p "$DIST_DIR"
dpkg-deb --build "$BUILD_DIR" "$DIST_DIR/${PKG_NAME}_${VERSION}_all.deb"
echo "$DIST_DIR/${PKG_NAME}_${VERSION}_all.deb"
