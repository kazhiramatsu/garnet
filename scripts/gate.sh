#!/usr/bin/env bash
# gate.sh — 全回帰ゲートの一枚扉（薄い dispatcher。既存スクリプトの挙動は変えない）。
#
# usage: scripts/gate.sh <cmd> [args...]
#
#   quick               selfhost_gate.sh quick（凍結TS build + selfconf + 3-way smoke）
#   full                selfhost_gate.sh（+ devirt/escape dump / native / diffall / fixpoint）
#   typed | selfbench   typed_selfhost.sh（typed selfhost: parity+diffall+gen3 fixpoint。
#                       selfbench は P4b で自己完結版（pinned 入力+参照C）に置換予定）
#   parity [filter]     emitc_diff.sh（Rust emit vs 凍結TS emitc の byte 比較）+ PASS/FAIL 判定
#   conf [tier] [flt]   run_conformance.sh（tier 省略時 all = basic+exhaustive）
#   selfconf [filter]   analyzer_conformance.sh（凍結TS の V8 差分）+ PASS/FAIL 判定
#   bundler             run_bundler_tests.sh（39 fixture）
#   unit                run_runtime_tests.sh + run_unit_tests.sh
#   gc                  run_gc_stress.sh
#   bench [filter]      run_benchmarks.sh（correctness + time budget）
#   bench-correct       ci_bench_correct1.sh + ci_bench_correct2.sh（budget なし全シャード）
#   tsc <root> <mode>   run_tsc_conformance.sh <ts-root> <runtime|loud> [filter]
#   iter                run_golden_iter.sh（96 iteration goldens）
#   ir-parity [snap]    exporter IR の byte 不変ゲート（P1a exporter 分割用・下記）
#   ci                  ci_fast.sh（cargo build + unit + negative 一式）
#
# ir-parity: exporter リファクタの回帰検出器。
#   scripts/gate.sh ir-parity snap   … 現在の exporter 出力を build/ir_parity/snap に固定
#   scripts/gate.sh ir-parity        … 再 export して snap と byte 比較（差分=FAIL）
#   コーパス: conformance basic+exhaustive の typed/untyped batch export
#           + bundler 39 fixture（typed・REJECT はマーカー化）
#           + selfhost_typed.ts(typed) / selfhost.ts(untyped)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
S="$ROOT/scripts"

die() { echo "[gate] $*" >&2; exit 1; }
usage() { sed -n '2,30p' "$S/gate.sh" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

# ---------------------------------------------------------------- ir-parity --
IRP_DIR="$ROOT/build/ir_parity"

irp_build_corpus() { # $1 = dest dir（conf_typed/ conf_untyped/ bundler/ self/ を作る）
  local dest="$1" w
  w="$(mktemp -d)"
  rm -rf "$dest"
  mkdir -p "$dest/conf_typed" "$dest/conf_untyped" "$dest/bundler" "$dest/self"
  [ -f "$ROOT/exporter/exporter.js" ] || die "exporter not built (run scripts/setup.sh)"

  # conformance corpus (basic + exhaustive) — batch export, typed & untyped
  local list="$w/list.tsv"; : > "$list"
  local ts rel slug
  for ts in $(find tests/conformance/basic tests/conformance/exhaustive -name '*.ts' 2>/dev/null | sort); do
    rel="${ts#tests/conformance/}"; slug="${rel%.ts}"; slug="${slug//\//__}"
    printf '%s\t%s\n' "$slug" "$ROOT/$ts" >> "$list"
  done
  node exporter/exporter.js --batch "$list" "$dest/conf_typed" >"$w/t.status" 2>"$w/t.err" || true
  TSAOT_UNTYPED=1 node exporter/exporter.js --batch "$list" "$dest/conf_untyped" >"$w/u.status" 2>"$w/u.err" || true

  # bundler corpus — module graphs, one export per entry (typed)
  local d name
  for d in tests/bundler/*/; do
    [ -f "$d/entry.ts" ] || continue
    name="$(basename "$d")"
    if ! node exporter/exporter.js "$ROOT/$d/entry.ts" \
         "$dest/bundler/$name.program.json" "$dest/bundler/$name.labels.json" \
         >/dev/null 2>"$w/b.err"; then
      # 意図的 REJECT fixture は診断行をマーカーとして固定（診断の安定性も parity 対象）
      grep -i "UNSUPPORTED" "$w/b.err" | head -3 > "$dest/bundler/$name.REJECT"
      rm -f "$dest/bundler/$name.program.json" "$dest/bundler/$name.labels.json"
    fi
  done

  # selfhost corpus — the big real program (typed) + boxed variant (untyped)
  node exporter/exporter.js analyzer_ts/src/selfhost_typed.ts \
    "$dest/self/selfhost_typed.program.json" "$dest/self/selfhost_typed.labels.json" \
    >/dev/null 2>&1 || die "typed export of selfhost_typed.ts failed"
  TSAOT_UNTYPED=1 node exporter/exporter.js analyzer_ts/src/selfhost.ts \
    "$dest/self/selfhost.program.json" "$dest/self/selfhost.labels.json" \
    >/dev/null 2>&1 || die "untyped export of selfhost.ts failed"

  rm -rf "$w"
}

irp_snap() {
  echo "[ir-parity] building snapshot corpus (conf typed/untyped + bundler + selfhost)…"
  irp_build_corpus "$IRP_DIR/snap"
  local n; n=$(find "$IRP_DIR/snap" -type f | wc -l | tr -d ' ')
  ( cd "$IRP_DIR/snap" && find . -type f | sort | xargs shasum -a 256 ) > "$IRP_DIR/snap.sha256"
  echo "[ir-parity] snapshot fixed: $n files under build/ir_parity/snap"
}

irp_compare() {
  [ -d "$IRP_DIR/snap" ] || die "no snapshot — run: scripts/gate.sh ir-parity snap"
  echo "[ir-parity] re-exporting current corpus…"
  irp_build_corpus "$IRP_DIR/cur"
  local same=0 diff_=0 missing=0 extra=0 f rel
  while IFS= read -r rel; do
    if [ ! -f "$IRP_DIR/cur/$rel" ]; then
      echo "  MISSING: $rel"; missing=$((missing+1))
    elif cmp -s "$IRP_DIR/snap/$rel" "$IRP_DIR/cur/$rel"; then
      same=$((same+1))
    else
      echo "  DIFF: $rel"; diff_=$((diff_+1))
    fi
  done < <(cd "$IRP_DIR/snap" && find . -type f | sort)
  while IFS= read -r rel; do
    [ -f "$IRP_DIR/snap/$rel" ] || { echo "  EXTRA: $rel"; extra=$((extra+1)); }
  done < <(cd "$IRP_DIR/cur" && find . -type f | sort)
  echo "[ir-parity] identical=$same diff=$diff_ missing=$missing extra=$extra"
  if [ $((diff_+missing+extra)) -eq 0 ]; then
    echo "[ir-parity] PASS"
  else
    echo "[ir-parity] FAIL（差分の中身: diff build/ir_parity/{snap,cur}/<path>）"
    return 1
  fi
}

# ------------------------------------------------------------------ parity --
run_parity() {
  local out
  out="$(bash "$S/emitc_diff.sh" "${1:-}")" || true
  printf '%s\n' "$out"
  local sum
  sum="$(printf '%s\n' "$out" | grep '^emitc:')" || die "parity: summary line missing"
  case "$sum" in
    *"UNPORTED=0"*) ;; *) die "parity FAIL: $sum" ;;
  esac
  case "$sum" in
    *"DIFF=0"*) ;; *) die "parity FAIL: $sum" ;;
  esac
  echo "[gate] parity PASS ($sum)"
}

run_selfconf() {
  local out
  out="$(bash "$S/analyzer_conformance.sh" "${1:-}" 2>&1)" || true
  printf '%s\n' "$out" | tail -20
  local sum
  sum="$(printf '%s\n' "$out" | grep 'total=' | tail -1)" || die "selfconf: summary missing"
  case "$sum" in *"CCFAIL=0"*) ;; *) die "selfconf FAIL: $sum" ;; esac
  case "$sum" in *"DIFF=0"*)   ;; *) die "selfconf FAIL: $sum" ;; esac
  case "$sum" in *"UNPORTED=0"*) ;; *) die "selfconf FAIL: $sum" ;; esac
  echo "[gate] selfconf PASS ($sum)"
}

# -------------------------------------------------------------------- main --
cmd="${1:-help}"; shift 2>/dev/null || true
case "$cmd" in
  quick)        exec bash "$S/selfhost_gate.sh" quick ;;
  full)         exec bash "$S/selfhost_gate.sh" ;;
  typed|selfbench) exec bash "$S/typed_selfhost.sh" ;;
  parity)       run_parity "${1:-}" ;;
  conf)         exec bash "$S/run_conformance.sh" "${1:-all}" "${2:-}" ;;
  selfconf)     run_selfconf "${1:-}" ;;
  bundler)      exec bash "$S/run_bundler_tests.sh" ;;
  unit)         rc=0
                bash "$S/run_runtime_tests.sh" || rc=1
                bash "$S/run_unit_tests.sh" || rc=1
                [ $rc -eq 0 ] && echo "[gate] unit PASS" || die "unit FAIL"
                ;;
  gc)           exec bash "$S/run_gc_stress.sh" ;;
  bench)        exec bash "$S/run_benchmarks.sh" "${1:-}" ;;
  bench-correct) rc=0
                bash "$S/ci_bench_correct1.sh" || rc=1
                bash "$S/ci_bench_correct2.sh" || rc=1
                [ $rc -eq 0 ] && echo "[gate] bench-correct PASS" || die "bench-correct FAIL"
                ;;
  tsc)          exec bash "$S/run_tsc_conformance.sh" "$@" ;;
  iter)         exec bash "$S/run_golden_iter.sh" ;;
  ir-parity)    case "${1:-}" in
                  snap) irp_snap ;;
                  "")   irp_compare ;;
                  *)    die "ir-parity: unknown subcommand '${1}' (use: snap / なし=比較)" ;;
                esac ;;
  ci)           exec bash "$S/ci_fast.sh" ;;
  help|-h|--help) usage 0 ;;
  *)            echo "[gate] unknown command: $cmd"; usage 1 ;;
esac
