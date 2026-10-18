#!/usr/bin/env bash
# Also runnable alone to verify the converter without assembling the whole image.
set -euo pipefail
RUNTIME_STAGE="${1:?Pass the runtime staging directory}"
PDF_STAGE="$RUNTIME_STAGE/poppler"
mkdir -p "$RUNTIME_STAGE/bin" "$PDF_STAGE/bin" "$PDF_STAGE/lib"
PDF_REAL="$(readlink -f "$(command -v pdftoppm)")"
INFO_REAL="$(readlink -f "$(command -v pdfinfo)")"
PDF_LOADER="$(patchelf --print-interpreter "$PDF_REAL")"
test -x "$PDF_REAL"
test -x "$PDF_LOADER"
cp -L "$PDF_REAL" "$PDF_STAGE/bin/pdftoppm.bin"
cp -L "$INFO_REAL" "$PDF_STAGE/bin/pdfinfo.bin"
cp -L "$PDF_LOADER" "$PDF_STAGE/lib/ld-linux.so"
mapfile -t PDF_LIBRARIES < <(
  { ldd "$PDF_REAL"; ldd "$INFO_REAL"; } | awk '$2 == "=>" && $3 ~ /^\// { print $3 }' | sort -u
)
test "${#PDF_LIBRARIES[@]}" -gt 0
for library in "${PDF_LIBRARIES[@]}"; do
  cp -L "$library" "$PDF_STAGE/lib/$(basename "$library")"
done
cat >"$RUNTIME_STAGE/bin/pdftoppm" <<'EOF'
#!/bin/sh
set -eu
unset LD_AUDIT LD_LIBRARY_PATH
script_dir="${0%/*}"
runtime_dir="$(CDPATH= cd -- "$script_dir/.." && pwd)"
exec "$runtime_dir/poppler/lib/ld-linux.so" \
  --library-path "$runtime_dir/poppler/lib" \
  "$runtime_dir/poppler/bin/pdftoppm.bin" "$@"
EOF
chmod 0755 "$RUNTIME_STAGE/bin/pdftoppm" "$PDF_STAGE/bin/pdftoppm.bin" "$PDF_STAGE/lib/ld-linux.so"
cat >"$RUNTIME_STAGE/bin/pdfinfo" <<'EOF'
#!/bin/sh
set -eu
unset LD_AUDIT LD_LIBRARY_PATH
script_dir="${0%/*}"
runtime_dir="$(CDPATH= cd -- "$script_dir/.." && pwd)"
exec "$runtime_dir/poppler/lib/ld-linux.so" \
  --library-path "$runtime_dir/poppler/lib" \
  "$runtime_dir/poppler/bin/pdfinfo.bin" "$@"
EOF
chmod 0755 "$RUNTIME_STAGE/bin/pdfinfo" "$PDF_STAGE/bin/pdfinfo.bin"
env -i PATH=/usr/bin:/bin "$RUNTIME_STAGE/bin/pdftoppm" -v
env -i PATH=/usr/bin:/bin "$RUNTIME_STAGE/bin/pdfinfo" -v
node "$(dirname "${BASH_SOURCE[0]}")/check-pdf-runtime.mjs" "$RUNTIME_STAGE/bin/pdftoppm" "$RUNTIME_STAGE/bin/pdfinfo"
