#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_NAME="xai-grok-pager"   # binary do cargo build ra
APP_NAME="cook"             # tên lệnh bạn muốn gõ
COMPAT_ALIAS="thanh"        # 1-release PATH symlink → cook

# Thư mục cài: mặc định ~/.local/bin, ghi đè bằng $1 hoặc biến INSTALL_DIR
INSTALL_DIR="${1:-${INSTALL_DIR:-$HOME/.local/bin}}"

# Managed layout: binary cài vào $GROK_HOME/bin/cook (mặc định ~/.cook/bin/cook)
# — đúng chỗ updater (Ctrl+U / `cook update`) thay thế — rồi symlink
# $INSTALL_DIR/cook -> $GROK_HOME/bin/cook để lệnh `cook` luôn trỏ bản mới nhất.
# Home riêng ~/.cook (không dùng ~/.grok) để config/auth/sessions/bin tách hoàn
# toàn khỏi grok chính thức — chạy song song không đụng nhau.
# Compat: also symlink $INSTALL_DIR/thanh → cook for one release.
GROK_HOME_DIR="${GROK_HOME:-${COOK_HOME:-$HOME/.cook}}"
MANAGED_BIN_DIR="$GROK_HOME_DIR/bin"

cd "$REPO_DIR"

# A release build can need several GiB for linking, especially after a clean
# build or feature-set change. Refuse before Cargo starts rather than filling
# the volume mid-build and leaving a large set of partial artifacts behind.
# Set BUILD_MIN_FREE_GIB to a lower value only when the expected incremental
# build size is known.
BUILD_MIN_FREE_GIB="${BUILD_MIN_FREE_GIB:-8}"
case "$BUILD_MIN_FREE_GIB" in
  ''|*[!0-9]*)
    echo "ERROR: BUILD_MIN_FREE_GIB must be a whole number of GiB" >&2
    exit 2
    ;;
esac
BUILD_AVAILABLE_KIB="$(df -Pk "$REPO_DIR" | awk 'NR == 2 { print $4 }')"
BUILD_REQUIRED_KIB=$((BUILD_MIN_FREE_GIB * 1024 * 1024))
if [ -z "$BUILD_AVAILABLE_KIB" ] || [ "$BUILD_AVAILABLE_KIB" -lt "$BUILD_REQUIRED_KIB" ]; then
  echo "ERROR: need at least ${BUILD_MIN_FREE_GIB} GiB free to build safely; free disk space is too low." >&2
  echo "       Free space or rerun only for a known-small incremental build with BUILD_MIN_FREE_GIB=<GiB>." >&2
  exit 1
fi

# Cargo install (dotslash) cài vào ~/.cargo/bin; thêm vào PATH để script này
# tự dùng được ngay cả khi shell của user chưa có sẵn.
export PATH="$HOME/.cargo/bin:$PATH"

# ── Tìm protoc ──────────────────────────────────────────────────────
# Ưu tiên: (1) protoc hệ thống chạy được → (2) bin/protoc của repo
# (dotslash wrapper, tự tải protoc v29.3 từ GitHub releases) → (3) cài
# dotslash rồi dùng bin/protoc. Kiểm tra bằng cách CHẠY thử (--version),
# không chỉ `command -v` — một dotslash wrapper thiếu dotslash vẫn "tồn tại"
# nhưng không chạy được, khiến cargo build fail sâu bên trong prost.
protoc_on_path() {
  command -v protoc >/dev/null 2>&1 && protoc --version >/dev/null 2>&1
}
repo_protoc_ok() {
  command -v dotslash >/dev/null 2>&1 && "$REPO_DIR/bin/protoc" --version >/dev/null 2>&1
}

if protoc_on_path; then
  echo "==> Dùng protoc từ PATH: $(protoc --version 2>/dev/null | head -1)"
elif repo_protoc_ok; then
  echo "==> Dùng bin/protoc (dotslash wrapper) của repo"
else
  echo "==> Chưa có protoc chạy được. Cài 'dotslash' để dùng bin/protoc của repo..."
  if ! command -v dotslash >/dev/null 2>&1; then
    cargo install dotslash || {
      echo "ERROR: cài dotslash thất bại. Gợi ý: brew install protobuf" >&2
      exit 1
    }
  fi
  if ! repo_protoc_ok; then
    echo "ERROR: bin/protoc (dotslash wrapper) không chạy được dù đã có dotslash. Gợi ý: brew install protobuf" >&2
    exit 1
  fi
  echo "==> Dùng bin/protoc (dotslash wrapper) của repo"
fi

echo "==> Building $APP_NAME (release)..."
cargo build -p xai-grok-pager-bin --release

mkdir -p "$MANAGED_BIN_DIR" "$INSTALL_DIR"
install_cook() {
  install -m 755 "target/release/$BIN_NAME" "$MANAGED_BIN_DIR/$APP_NAME"
  ln -sf "$MANAGED_BIN_DIR/$APP_NAME" "$INSTALL_DIR/$APP_NAME"
  # One-release compat: `thanh` on PATH still works
  ln -sf "$MANAGED_BIN_DIR/$APP_NAME" "$INSTALL_DIR/$COMPAT_ALIAS"
}

if [ -w "$INSTALL_DIR" ]; then
  install_cook
else
  echo "==> $INSTALL_DIR không ghi được (cần quyền root), thử với sudo..."
  sudo sh -c "install -m 755 'target/release/$BIN_NAME' '$MANAGED_BIN_DIR/$APP_NAME' && ln -sf '$MANAGED_BIN_DIR/$APP_NAME' '$INSTALL_DIR/$APP_NAME' && ln -sf '$MANAGED_BIN_DIR/$APP_NAME' '$INSTALL_DIR/$COMPAT_ALIAS'"
fi

echo "==> Đã cài: $MANAGED_BIN_DIR/$APP_NAME (symlink: $INSTALL_DIR/$APP_NAME, compat: $INSTALL_DIR/$COMPAT_ALIAS)"
"$INSTALL_DIR/$APP_NAME" --version
