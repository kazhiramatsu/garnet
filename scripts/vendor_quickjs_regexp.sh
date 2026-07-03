#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${TSAOT_QUICKJS_VERSION:-}"
if [[ -n "${TSAOT_QUICKJS_TARBALL:-}" ]]; then
  TARBALL_NAME="${TSAOT_QUICKJS_TARBALL_NAME:-$(basename "$TSAOT_QUICKJS_TARBALL")}"
  URL="${TSAOT_QUICKJS_URL:-local:$TSAOT_QUICKJS_TARBALL}"
else
  TARBALL_NAME="${TSAOT_QUICKJS_TARBALL_NAME:-quickjs-2025-09-13-2.tar.xz}"
  URL="${TSAOT_QUICKJS_URL:-https://bellard.org/quickjs/${TARBALL_NAME}}"
fi
VENDOR_DIR="$ROOT/runtime/regexp/quickjs"
UPSTREAM_DIR="$VENDOR_DIR/upstream"
WORK="$(mktemp -d)"

cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT

tarball="$WORK/$TARBALL_NAME"
if [[ -n "${TSAOT_QUICKJS_TARBALL:-}" ]]; then
  cp "$TSAOT_QUICKJS_TARBALL" "$tarball"
else
  curl -L --fail --show-error -o "$tarball" "$URL"
fi

mkdir -p "$WORK/src"
tar -xf "$tarball" -C "$WORK/src"
top="$(find "$WORK/src" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [[ -z "$top" ]]; then
  echo "vendor-quickjs: tarball did not contain a top-level source directory" >&2
  exit 1
fi

required=(
  LICENSE
  cutils.h
  libregexp.c
  libregexp.h
  libregexp-opcode.h
  libunicode.c
  libunicode.h
  libunicode-table.h
  list.h
)
optional=(
  VERSION
  cutils.c
)

missing=0
for f in "${required[@]}"; do
  if [[ ! -f "$top/$f" ]]; then
    echo "vendor-quickjs: missing $f in tarball" >&2
    missing=1
  fi
done
if [[ "$missing" -ne 0 ]]; then
  exit 1
fi

mkdir -p "$UPSTREAM_DIR"
for f in "${required[@]}"; do
  cp "$top/$f" "$UPSTREAM_DIR/$f"
done
imported=("${required[@]}")
for f in "${optional[@]}"; do
  if [[ -f "$top/$f" ]]; then
    cp "$top/$f" "$UPSTREAM_DIR/$f"
    imported+=("$f")
  else
    rm -f "$UPSTREAM_DIR/$f"
  fi
done

if [[ -z "$VERSION" ]]; then
  if [[ -f "$top/VERSION" ]]; then
    VERSION="$(tr -d '\r\n' < "$top/VERSION")"
  else
    VERSION="$(basename "$top" | sed 's/^quickjs[-_]//')"
  fi
fi

sha_cmd=""
if command -v shasum >/dev/null 2>&1; then
  sha_cmd="shasum -a 256"
elif command -v sha256sum >/dev/null 2>&1; then
  sha_cmd="sha256sum"
fi
sha256=""
if [[ -n "$sha_cmd" ]]; then
  sha256="$($sha_cmd "$tarball" | awk '{print $1}')"
fi

cat > "$VENDOR_DIR/IMPORT.md" <<EOF
# QuickJS import

- Version: $VERSION
- Tarball: $TARBALL_NAME
- Source URL: $URL
- SHA-256: ${sha256:-unknown}
- Imported files:
$(printf '  - %s\n' "${imported[@]}")

Only the optional RegExp runtime may include these files. Do not include
QuickJS headers from \`runtime/ts_rt.c\`.
EOF

echo "vendor-quickjs: imported QuickJS $VERSION RegExp sources into $UPSTREAM_DIR"
