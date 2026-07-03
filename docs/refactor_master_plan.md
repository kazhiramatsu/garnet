# garnet 完全リファクタリング & 世界最速化 基本計画

## Context（なぜやるか）

313 セッションかけて Rust オラクルからの忠実移植で **typed selfhost fixpoint** まで到達した。その過程で「byte-parity 最優先」の規律がコード品質を意図的に犠牲にしてきた結果、次が蓄積している:

- **無駄**: 手書き IR walker ~10 個の重複（emitc.ts 内 + emit.ts/devirt.ts 間）、emit.ts(boxed)/emitc.ts(typed) の二重 emitter、生成 blob（emitc_sections_gen.ts の Rust ダンプ静的スナップショット）、`any` 型 150+ 箇所、巨大単一ファイル（emitc.ts 6,335 行 / exporter.ts 11,074 行 / ts_rt.c 9,877 行）、stale スクリプト、**リポ直下のゴミファイル（a, a.c, a.ts, b.ts, labels.json 等）**
- **バグ（silent 系）**: 2^53 跨ぎ int ループ精度（根因特定済み: `nfJoin` が range を落としつつ `i64Safe` を保持 / `nfI64Value()` が無範囲で i64Safe を主張）、JSON.stringify depth>256 が catch 不能 abort、JSON.parse の深入力 SIGSEGV、selfhost の 64MB スタック要件（switch→ネスト If lowering が根因）
- **性能**: 実測ベースライン（2026-06-11）— self IR (23.4MB, 538 関数, 66,270 命令) の emit が **node 30.8s / Rust 23.7s / native typed tsan ~600s**。native の 20 倍差はランタイム（Map/Set が線形走査・GC 閾値 64K alloc・全 reflike local の root/unroot・クロージャ呼び出し毎 malloc）、node/Rust の ~25s はアルゴリズム（whole-program 数値解析を ~70 回再実行）。プロパティアクセスは O(n) 線形走査で shapes/IC なし。
- **重大事実**: **リポジトリに .git が存在しない**（巻き戻し不能状態でこの規模のリファクタは不可）。`./garnet` ドライバは ts/native 経路に今も `TSAOT_UNTYPED=1` を強制（typed パイプライン未配線）。

**目標**: フェーズ分けで上記を完全解決し、AOT の閉世界性を武器に「実行速度 × コンパイル速度」の両軸で世界最速の TypeScript 処理系にする。

## 拘束条件（ユーザー決定・全フェーズ binding）

| # | 決定 |
|---|---|
| 1 | **byte-parity は段階的卒業**: 機械的リファクタ期のみ回帰検出器として維持 → 卒業後は V8 差分 + conformance + bundler + perf ゲートが唯一の真実。Rust analyzer は attic へアーカイブ（CI から除外、ツリーに保存） |
| 2 | **コンパイラ速度は実行速度と同列の第一級目標**（self-compile 600s → 秒台へ） |
| 3 | **意味論ギャップは silent 系のみ修正**（2^53 精度・abort/SIGSEGV 系）。bigint / Array.prototype monkey-patch は loud reject のまま明示的スコープ外として文書化 |
| 4 | **巨大ファイル分割も tsaot→garnet 改名も実施**（それぞれ専用フェーズ・ゲート緑維持） |
| 5 | **self-host 制約は恒久**: analyzer_ts の全ファイルは garnet 自身でコンパイル可能を維持（for-of 内 continue 不可 / call 引数 spread 不可 / 分割代入束縛の closure capture 不可 / 限定 stdlib）。新ファイル追加ごとに typed gate |

## 検証体制の二層構造（全フェーズ共通原則）

- **挙動不変の変更**（純移動・walker 統一・解析キャッシュ）→ `emitc_diff.sh`（Rust byte-parity 327/327）が等価性を機械証明
- **IR/出力 C が変わる変更** → V8 差分（conformance 327 + bundler 39 + golden_iter 96 + tsc-subset + typed fixpoint）で意味論、bench budget で性能
- **ランタイムのみの変更**（ts_rt.c）→ emitted C 不変なので parity 無関係。conformance + unit + GC stress + bench で検証。**卒業前でも実施可能**（これが Phase 2 を前倒しできる鍵）
- 例外設計: exporter の lowering 変更は Rust/TS 両方が同じ IR を消費するため **parity は保たれる**（switch 平坦化を卒業前に実施できる根拠）

---

## フェーズ一覧と依存

```
P0 足場・計測 ─► P1 構造統一(parityロック) ─► P3 typed本配線 ─► P4 卒業+boxed引退 ─► P5 silentバグ根治
      │                                                                │
      └─► P2 コンパイラ高速化I(並行可) ──────────────────────────────┘
                                                P5 ─► P6 実行性能(hot path) ─► P7 AOT差別化 ─► P8 改名+公開ベンチ
```

| Phase | 内容 | 規模目安 |
|---|---|---|
| P0 | 足場（git/ゲート統一/棚卸し/計測基盤/ベースライン） | 1–2 セッション |
| P1 | 構造統一: IR 型・walker 統一・emit_core・3 大ファイル分割 | 6–9 |
| P2 | コンパイラ高速化 I: ランタイムデータ構造 + 解析アルゴリズム + switch 平坦化 | 4–6 |
| P3 | typed パイプライン本配線 + native アナライザ既定化 | 1–2 |
| P4 | 卒業: オラクル拡張→ゲートフリップ→Rust attic + boxed 引退 + 生成 C スリム化 | 3–4 |
| P5 | silent バグ根治: 2^53 / 深度系 / label quirk / loud 点検 | 2–3 |
| P6 | 実行性能: shapes+PIC / interning / StringBuilder / GC / call ABI | 5–7 |
| P7 | AOT 差別化: typed ABI 全面化 / element kinds / init snapshot / PGO / LTO+jump table | 5–8 |
| P8 | tsaot→garnet 改名 + 「世界最速」公開ベンチ検証 | 2–3 |

---

## Phase 0: 足場 — VCS・ゲート一本化・計測基盤

**ゴール**: 「壊したら 1 コマンドで検知、1 コマンドで巻き戻し、1 コマンドで計測」。

1. **`git init` + 初期コミット**（最優先・着手前提条件）。`.gitignore` 整備（node_modules/dist/build/target）→ タグ `baseline-s313`。以後フェーズ完了ごとにタグ。
2. **棚卸し**: リポ直下のゴミ削除（`a` `a.c` `a.ts` `b.ts` `labels.json` `program.json` `sites.json`）、dead な `exporter/escape_ir.ts`(+.js) 削除（import ゼロ確認済み）。`scripts/lib/` へ helper 移設（mimalloc_flags / regexp_link_flags / mftest→lib/mf.sh — **mftest は bundler テストが source する load-bearing**、stale ではない）。`run_golden_iter.sh` は削除せず卒業オラクルに編入予定としてマーク。
3. **`scripts/gate.sh` 新設**（薄い dispatcher、既存スクリプト挙動不変）: `gate quick|full|typed|parity|conf|selfconf|bundler|unit|gc|bench|bench-correct|tsc|iter|ir-parity|ci`。`gate ir-parity` は新実装（conformance 330 + bundler 39 + selfhost の batch export を byte 比較 — P1 exporter 分割の専用ゲート）。
4. **計測基盤**（性能側 P0）:
   - ベンチスイート拡張（`benchmarks/manifest.tsv` に suite/engines 列追加）: classics（richards/deltablue/splay/navier-stokes/crypto を素直な TS で）、**escape-hardened 動的系**（出力を消費して最適化で消えない megamorphic property / proto chain / `obj[k]` / Map・Set churn 10³–10⁶ / JSON 1–50MB round-trip）、**self-compile をステージ分割計測のベンチに昇格**（JSON parse / devirt / escape+sroa / fixpoints / emit / cc / total）、startup 維持。
   - エンジン比較ハーネス `run_engine_benchmarks.sh <node|bun|deno>`（warmed best-of-N、結果 JSON を `build/bench_history/` に蓄積）。
   - プロファイル導線: `garnet --profile`（-g -fno-omit-frame-pointer）+ `scripts/profile_bench.sh`（macOS: xctrace/sample、Linux: perf+flamegraph）。
   - **ランタイム統計カウンタ `TSAOT_RT_STATS=1`**（新設 ~50 行 ifdef）: minor/full GC 回数・pause 合計・alloc バイト・handle 表サイズ・map_find/find_prop プローブ長ヒスト・ts_call malloc 回数・concat 回数/バイト・root push 回数。以後の全 perf 判断の事実基盤。
5. **ベースライン記録**: 全ゲート結果・所要時間・全ベンチ数値を `docs/refactor_baseline.md` に固定。

**ゲート**: 既存全スクリプト緑（包むだけ）。**リスク**: mf 移設で bundler 破損 → 前後で `gate bundler`。

---

## Phase 1: 構造統一 — typed IR・walker・emit_core・3 大ファイル分割（parity ロック）

**ゴール**: 重複と `any` の根絶、責務単位のモジュール構造。**1 移動 = 1 `gate parity`** の粒度で純移動を貫く（emit 順序・speculative emit・ラベル副作用は 1 文字も変えない）。

### 1a. 統一 typed IR + ir_walk（2–3 セッション）
- `scripts/gen/gen_ir_types.js`（一回限り）で `analyzer/src/escape_ir.rs`（987 行、serde internally-tagged + camelCase が規則的）から **全 57 命令の TS interface を機械生成 → 以後手所有**。`ir.ts`（現 99 行）を置換。`RawInst` は `UnknownInst`（loud 用）として union 末尾に残す。
- `analyzer_ts/src/ir_walk.ts` 新設（self-host 制約準拠）: `forEachChildBody`（Loop/If/TryCatch の子 body 列挙の**唯一の定義箇所**）/ `flattenBody` / `definedLocal` / `usedLocals`・`forEachUsedLocal` / `mapLocals`（sroa の remapInstOperands 核）/ `walkBodies`。**`FunctionIndex`**（関数ごとに flatten 結果と def/use 索引を 1 回だけ構築）も置く — P2 の挿入点。
- walker を 1 個ずつ置換 → 都度 `gate parity`: `instDefLocal`/`jsonDomDefinedDst`（同一確認済み）→ `definedLocal` に集約、`collectDefs`、`flattenInst`×2 + devirt `flattenInsts`、再帰骨格（bodyExitsAbruptly / collectLoopNonnegSubs / scalar-slice validate / jsonDomEscapesBody）。
- **罠（§311 教訓の昇格）**: json_dom 系の対象命令集合は意図的に汎用 def/use と異なる（ArraySlice は uses に無い等）。**意味論テーブルは統一しない** — 統一するのは再帰骨格のみ。等価性は parity が機械証明。
- 置換した関数から `any`→`Inst` へ。新規・移動コードは typed 必須（一括置換はしない）。

### 1b. emitc.ts 分割 + emit_core 抽出（3–4 セッション）
実測セクション境界での分割マップ（**フラット命名** — サブディレクトリ import は self-host 未実証のため）:

| 新ファイル | 元 emitc.ts 行 | 内容 |
|---|---|---|
| `emit_core.ts` | 21–166 + emit.ts 44–70 | cname/fnSym 統一・cStringLit・cBytesLit・rustF64Debug・ラベル採番・UnportedError（emit.ts からの import 歪み解消） |
| `emitc_adapters.ts` | 166–352 | fnval adapter テーブル |
| `emitc_strings.ts` | 352–438 | 静的文字列テーブル |
| `emitc_class.ts` | 438–687, 2479–2551 | class layout/descriptors/proto setups |
| `emitc_opt_slice.ts` | 687–1164 | scalar string slices |
| `emitc_opt_fused.ts` | 1164–2114 | fused loops + select4 |
| `emitc_opt_jsondom.ts` | 2114–2479 | JSON DOM fast path |
| `emitc_infer_numeric.ts` | 2551–2935 | NumFact lattice + infer_numeric_analysis |
| `emitc_infer_classify.ts` | 2935–3214 | unboxed/class 分類 |
| `emitc_infer_interproc.ts` | 3214–3831 | indirect/param facts/i64・f64 fast |
| `emitc_ctx.ts` | 3831–3988 | EmitCtx + アクセサ（**leaf モジュール** — 循環防止の要） |
| `emitc_coroutine.ts` | 3988–4400 | Flat/flattenCf/SM resume |
| `emitc_inst.ts` / `emitc_builtins.ts` | 4400–5890 | emit_inst dispatch / CallBuiltin ~150 arm |
| `emitc.ts`（残置） | 5890–6335 | emitProgramC = driver |

- emit.ts(boxed) の cname/literals/flattenCf/proto-setup を emit_core / emitc_coroutine の共有実装に差し替え（boxed 側ゲート = `gate full` の diffall+fixpoint）。
- `emitc_sections_gen.ts` はここでは触らない（P4 で根治）。
- フェーズ末に `gate typed` 必須（**分割後 multi-module selfhost が garnet でコンパイルできることの実証**）。

### 1c. exporter.ts 分割（3–4 セッション、1b と並行可）
- 分割: `wire.ts`（toWireProgram/サロゲート処理/精度保持数値 — 純関数）/ `builtins_table.ts` / `diagnostics.ts`（unsupported 機構）/ `lower_expr.ts` / `lower_regexp.ts`（2115–2740 行、高凝集）/ `lower_stmt.ts` / `modules_linkage.ts` / `scan_free.ts`（freeVars 不動点 — **一塊で移動**）/ `exporter.ts`（Exporter クラス＝オーケストレータ残置）。メソッドは `ex: Exporter` 第一引数の自由関数へ機械変換。node 専用なので self-host 制約なし。
- **single/batch 統一**: single を「要素数 1 の batch」に（§304 の lib 設定差 TS2550 を根絶）。
- **専用ゲート `gate ir-parity`**（IR byte 不変）が主役 + conf + bundler + typed。

### 1d. ts_rt.c 分割 — unity build（2–3 セッション、いつでも並行可）
- `runtime/src/` に 10 部品（rt_gc / rt_value / rt_string / rt_array / rt_scalar / rt_object / rt_json / rt_error_eh / rt_async / rt_fetch、実測セクション境界）。**ts_rt.c は部品を順に `#include` する unity build に**（`cc -O2` の単一 TU インライン性能と `build/rt.o` の作り方を不変に保つ）。`rt_internal.h` 新設で前方宣言を整理、重複 typedef（ts_class_reg ×3 等）を dedupe。公開 ABI（ts_rt.h）不変、`nm build/rt.o` のシンボル差分ゼロ確認。
- ゲート: conf + unit + gc + bundler + bench A/B（中立性）。

**P1 全体のリスク**: モジュール循環（→ emitc_ctx を leaf に、コールバック注入）/ self-host 制約違反（→ 新ファイルごと typed gate）/ ラベル副作用の破壊（→ speculative emit は P5 まで不可侵）。

---

## Phase 2: コンパイラ高速化 I — self-compile 600s→60s 級（P1 と並行可）

**ゴール**: native typed tsan の self-compile **600s → ≤60s**（ランタイム側）+ node/Rust の **~25s → ≤5s**（アルゴリズム側）。卒業前に実施可能（ランタイム変更は parity 無関係、解析キャッシュは出力同一、switch 平坦化は IR 共有で parity 保持）。

### 2a. ランタイムデータ構造（ts_rt.c のみ、emitted C 不変）
| 施策 | 根拠（実測） | 期待 |
|---|---|---|
| **ts_map/ts_set にハッシュ索引**（挿入順 key/val 配列は仕様順序のため維持 + open-addressing u32 index。文字列は既存 hash 再利用、数値は double bits mix、オブジェクトは handle id） | `map_find` が線形走査（ts_rt.c:3242、コメント自認）。解析は命令×エントリ×パスで実質二乗 | **5–10×**（self-compile 支配項） |
| **ts_intern_field のハッシュ化** | 動的 intern が O(#fields) memcmp（ts_rt.c:4539） | 動的キー多用コードで大 |
| **文字列 hash の遅延化**（hash=0 番兵、初参照で計算） | 全生成サイトで eager hash。emitter は使わない hash を数百万回計算 | 文字列構築系 1.2–2× |
| **find_prop の辞書フォールバック**（プロパティ数 >8 でハッシュ） | O(n) 走査（ts_rt.c:504）。P6 shapes までの暫定 | 中 |
| **GC 閾値見直し**（young 65,536 **alloc 回数** → ~1M 相当 or byte 会計、full floor を live set 比例に） | 64K alloc ごとに全 g_roots 走査（ts_rt.c:27,188） | 中–大 |
| **クロージャ呼び出しの malloc 除去**（合計 ≤16 slot はスタックバッファ） | ts_call が毎呼び出し malloc+copy+free（ts_rt.c:341–357）、ts_call_value は this 注入で二重 malloc | callback 多用コードで大 |

検証: conf + unit + `run_gc_stress.sh` + bench + RT_STATS 前後差分。**Map の挿入順イテレーションが仕様**なので順序退行は conformance が検出。

### 2b. 解析アルゴリズム（analyzer_ts、出力 C 同一 → parity で等価性証明）
- **flatten キャッシュ**: sroa 後に `Map<funcId, FlatInst[]>` を 1 回構築（P1a の FunctionIndex）。現状 `inferNumericAnalysis`(emitc.ts:2694) / `inferProgramParamFacts`(3374) / `collectI64SeedParamFacts`(3692) / `numericValueLocs`(3520) / dom/slice 系が**関数あたり ~70–140 回** flatten を再実行。localClassMap/unboxedCandidates も per-function memoize。
- **fixpoint の worklist 化**: `inferProgramParamFacts` の 8 回盲目 sweep → call graph（devirt 後に既知）上の worklist へ。`inferI64FastFuncs` の 8×8（内側ごとに whole-program 再解析 ≤64 回）→ call-site 寄与のキャッシュ + 影響波及のみ再 join。**収束値は同一のはず → `gate parity` がそのまま等価性証明**（1 リリースの間、旧アルゴリズムとの一致 assert も併設）。
- **emit 時の解析再実行排除**: 最終 emit ループが per-function に inferNumericAnalysis+numericValueLocs を再実行（6060/6064, 6136/6138）→ 収束済み解析のルックアップに。
- 期待: whole-program 解析 ~70 回 → 2–3 回 + 小 worklist = **5–10×**（node/Rust/native 全てに効く）。

### 2c. switch lowering 平坦化（exporter — IR が変わるが Rust/TS 共有で parity 保持）
- `buildMatch`（exporter.ts:9028–9071）の「case 数ぶんネストした If チェーン + 全 case 走査の active フラグ」→ **run-once breakable Loop の flat If 兄弟列**（matched=i; Break）or 第一級 `Switch` IR。
- 一挙に 3 問題を解決: ① IR ネスト ~300 深（**64MB スタック要件と JSON 深度問題の根因**）→ O(1) 深、② 生成 C の O(cases) 逐次比較 dispatch、③ P7 jump table の前提。
- 検証: conf + parity（両実装が新 IR で 327/327）+ typed（**`ulimit -s 65520` 撤去の実測**）+ bundler + bench-correct（control_switch 系注視）。深ネスト switch fixture を追加して再発防止。

### 2d. 並列 C バックエンド + 出力構築
- `--jobs N`: 関数群を N 個の .c に分割 emit + 共有ヘッダ → 並列 cc + link（5.6MB 単一 TU の cc が serial tail。**~4–6×**、将来の incremental 再コンパイルの土台）。
- 出力構築は P0 カウンタで concat コストを実測してから（P6 StringBuilder と連動）。
- JSON IR の binary 化は**計測ゲート付き保留**（P0 ステージ計測で >10% を占めたときのみ）。

---

## Phase 3: typed パイプライン本配線 + native 既定化

1. **ドライバ改修**（garnet:81–116）: `TSAOT_ANALYZER=ts` を `main.js <ir> emitc`（typed: devirt→escape→sroa→emitc）へ。`--untyped` 時のみ TSAOT_UNTYPED=1。`native` の `TSAOT_UNTYPED=1` 強制を撤去し selfhost_typed バイナリ前提に。
2. **emitc-on-untyped 実験**: untyped IR を emitc に通して conformance 327 を計測 → 緑なら boxed emit.ts 引退条件①成立（不足は UNPORTED で loud 列挙）。
3. ハーネスの経路統一（run_conformance / mf を「ドライバ経由 + TSAOT_ANALYZER 切替」へ、Rust 直指しの段階排除）。
4. **native 既定化**: P2 完了後、native typed tsan が `node main.js` の wall-clock を上回り conformance 全緑になった時点で `TSAOT_ANALYZER=native` を既定に（自動ブートストラップ: 無ければ rust/ts でビルド）。

**ゲート**: conf/bundler（typed 経由）+ typed fixpoint + bench-correct。ill-typed 入力の既定動作変更（型エラー停止）を README に明記。

---

## Phase 4: 卒業 — 検証体制フリップ + Rust attic + boxed 引退 + 生成 C スリム化

**順序厳守: 4a（オラクル拡張）→ 4b（フリップ）**。parity という超高感度検出器を失う前に検出網を増やす。

### 4a. オラクル拡張
- `run_golden_iter.sh`（96 fixture）を Rust 直指しからドライバ経由に付け替え `gate iter` 常設化。`run_tsc_conformance.sh` を pass-list ゲートに昇格。
- 実プログラムオラクル: ① typed fixpoint の **gen1 を node emitc に変更**（脱 Rust）+ diffall 恒久化、② bundler 39、③ bench correct。
- P5 で直すバグを踏む **known-fail fixture を先に追加**（2^53 跨ぎ +/-、巨大 switch、深い JSON、深い再帰 stringify）。

### 4b. ゲートフリップ + Rust 退役
- 退役（attic 行き）: emitc_diff.sh / devirt・escape ダンプ比較 / 3-way smoke / _devirt_diff.cjs / ci_fast.sh の cargo CI。
- 残留・昇格: conformance（tier 拡張）/ 2-way smoke / diffall / typed fixpoint（gen1=node）/ ir-parity（exporter 用）/ bundler / tsc-subset / iter / bench / unit+gc。
- Rust 退役手順: 最終 parity 証明を実行・記録（`docs/rust_oracle_archive.md` + git タグ `parity-final`）→ `analyzer/` → `attic/analyzer-rust/`（cargo bin 名 `tsaot` は凍結のまま、再ビルド手順と serde_stacker 注意を README に）→ setup.sh から cargo 削除 → CLAUDE.md/HANDOFF 更新 → ドライバ `rust` arm は案内エラー化。

### 4c. boxed emitter 引退 + 生成 C スリム化
- 引退基準: ① P3 実験で emitc-on-untyped 327/327、② bundler 39 緑、③ boxed ゲートの役目を typed fixpoint+diffall が代替、④ RUNTIME_PREAMBLE 参照が emit.ts のみ。
- 実行: `--untyped` を「TSAOT_UNTYPED=1 export + emitc」へ → **emit.ts(1,884) + preamble_gen.ts(382) + gen_preamble_ts.js 削除**、selfhost.ts/boxed ゲート整理。
- **`ts_setup_global_object` の runtime 移管**: emitc_sections_gen.ts の静的 C スナップショット（16.3KB、Rust ダンプ由来＝卒業後は再生成不能）を ts_rt.c の通常関数へ移植、生成 C は呼び出し 1 行に（全プログラム ~16KB 減 = cc 短縮）。gen_emitc_sections.js 削除。初期化順の既知罠（g_function_proto 後の box）に注意。

---

## Phase 5: silent バグ根治（卒業後 — 出力 C が変わる）

### 5a. 2^53 int 特化精度（最優先）
- **lattice 二層化**: `i64Safe`（±2^53 以内**証明済み**）と `intValued`（整数だが大きさ未証明）を分離。① `nfJoin` の range 落ち時と `nfI64Value()` で i64Safe を**降格**、② unguarded `d+d` fast path は i64Safe のみ、③ `intValued` の +/- は **unboxed double に分類**（= V8 の double 丸めそのもの＝正確、box 化はしないので退行小）。
- **回収策**: ループ束縛帰納証明（`infer_loop_bounds`）— `i < n` で n が i64Safe・i 非減少・step 上界既知なら `i ≤ n+step` を証明し i64Safe 維持 → `for (i=0; i<arr.length; i++)` 系は全て int に残る。
- ガード付き i64（overflow 分岐）は [2^53,2^63) 証明可能時の opt-in として P6/P7 に引き継ぎ（2^63 超の `(long long)` UB 回避設計込み）。
- 検証: 4a の known-fail fixture が V8 一致へ + conf/bench 全緑 + int→f64 降格の退行測定。

### 5b. 深度系の監査と catch 可能化
| 箇所 | 現状 | 修正 |
|---|---|---|
| JSON.stringify depth>256 abort (ts_rt.c:5112) | catch 不能 | `ts_throw`（RangeError 相当）+ 上限 env 可変。主因は 2c で消滅済み |
| JSON.parse 再帰（5876–） | 深入力 SIGSEGV | depth カウンタ + catch 可能 throw |
| selfhost 64MB スタック | 2c で根治済確認 | `ulimit` ハック完全撤去 |
| exporter の他の O(source) ネスト | 監査 | optional chain/分割代入深度を grep、必要なら 2c 方式 |

### 5c. ラベル採番 quirk の卒業
- Loop body の捨て emit（metric plan 不一致時の 2 回 emit）→ 純 shape 判定に置換。fdre の plan 経路 fresh-label → 単一経路に整理。ラベル番号は変わるが意味論不変（conf + typed fixpoint + bundler で自己無撞着を確認）。

### 5d. loud-reject 総点検
- 「shouldn't happen で黙ってフォールバック」を grep 監査し throw 化（§300 教訓の checklist 化、emitc/sroa/exporter）。

---

## Phase 6: 実行性能 — ランタイム hot path

**ターゲット**: property kernels ≥3× / richards・deltablue ≥0.8×V8（stretch 1.0×）/ closure call ≥2× / gc churn ≥2× / self-compile さらに ~2×。

| 施策 | 場所 | 内容 |
|---|---|---|
| **AOT shapes + per-site PIC** | runtime+emitter+analyzer | 閉世界 ⇒ 全 object-literal/class サイトにコンパイル時 shape id + slot 表。props を dense slot 配列に、`ts_object.shape` 語を本来の用途に。emitted C に per-site `static ts_pic {shape_id, slot}` — 単型ヒット＝比較+索引ロード。delete/exotic は辞書モード降格。`g_has_proxies` 式のグローバルゲートで段階投入 |
| **文字列 interning** | emitter+runtime | 静的文字列は全て compile-time intern（hash+field-key id 前計算）。動的キーは runtime intern 表 → ポインタ等値 fast path（shapes と相乗） |
| **StringBuilder** | runtime+emitter | `ts_sb`（指数成長）+ 既存 fused/metric パスの拡張で `s += ...` ループと多パーツ template literal を builder 化（自前 emit の 5.6MB 構築にも直撃）。ropes は明示的に見送り（views+builder で十分） |
| **root batching** | emitter+runtime | n 回の `ts_gc_root` → **frame 構造体 1 push**（reflike locals を連続 frame struct に、静的 descriptor）。EH は既に root depth snapshot 方式なので合成可能。コルーチン（locals が frame 常駐）との整合に注意 |
| **GC: bump nursery + lazy handle** | runtime | per-object calloc → 連続 4–32MB nursery の bump alloc。**handle は最初に移動/昇格した時のみ割当**（短命オブジェクトの handle 表 store と間接参照を全廃）。minor GC は remset+roots から直接参照を fixup |
| **closure ABI** | emitter+runtime | `f(env, args, nargs)` 署名で env をそのまま渡す（P2a の残り copy も全廃）。call/apply/bind/adapter への波及を一括 |
| **arity 特化 direct-call ABI** | emitter | 既知 arity の直呼びに typed C 署名 `tsv f(tsv a0, tsv a1)`（i64/f64 clone 機構の tsv 一般化）— args 配列マテリアライズ排除 + C インライン解禁 |

検証: V8 差分（プロパティ意味論: 順序/descriptor/proto が安全網）+ 新スイート + RT_STATS 差分 + gc stress。

---

## Phase 7: AOT 差別化 — JIT にできない証明ベース最適化

**ターゲット**: classics geomean ≥1.0× node & bun / 数値配列 ≥1.5×V8 / startup ≥10× 維持 / typed self-compile ≤2× Rust 旧オラクル。

1. **whole-program shape 証明 → 直接 slot アクセス**: サイト単型 + shape sealed（動的 add 無し・Proxy 無し）を**証明**できたら PIC すら省略して `obj->slots[k]` 直書き。動的機能はグローバル program-facts フラグで escape hatch。
2. **fully-typed プログラムの boxed 経路全廃**: any が流入しない関数群は端から端まで native C 署名（tsv は I/O 境界のみ）。FN_TABLE には boxed thunk を残す。i64/f64 clone エンジンの全面一般化。
3. **配列 element kinds**: double-only 配列は `double[]` 非 box 格納（kind タグ + 非 double store で遷移）。int32 kind は計測の上判断。
4. **int32 vs i64 の計測タスク**: V8 SMI(31/32bit) との比較で「range 証明付き i64（チェック無し）」vs「int32+overflow 分岐」を int スイートで実測 → 結果がどちらでも public story に文書化（予想: スカラは i64 維持、配列要素のみ int32 検討）。
5. **module-init snapshot**: ビルド時に `__module_init` を計装ランタイムで実行 → 結果 heap を静的 C データに直列化（handle/proto 再配置表付き）。純粋性解析（I/O/Date/random 不在）でゲート。startup を構造的優位に。
6. **PGO ループ**: `garnet --pgo` — IR site id キーのカウンタ計装（call site/loop trip/PIC 多型度）→ 実行 → 再コンパイルで inlining budget・direct-vs-PIC・hot/cold 分割・`__builtin_expect` に反映。`cc -fprofile-use` 連鎖も。
7. **C レベル codegen**: `--lto`（-flto -O3）、TS_AOT_INLINE 監査（write barrier の remembered-set 経路が現状 call）、**2c の flat Switch IR を本物の C `switch`/computed goto に**（自前命令 dispatch が第一受益者）、コルーチン resume の computed goto 化。
8. **direct-threaded async**: await 連鎖の callee が静的既知なら microtask queue を経由せず直接 resume。queue は ring buffer 化。

各施策は独立フラグ + V8 差分フルコーパス + 専用ベンチで個別検証。

---

## Phase 8: 改名 + 「世界最速」公開検証

### 8a. tsaot→garnet rename（卒業後だから blast radius 最小）
| 区分 | 対象 | 方針 |
|---|---|---|
| ユーザー向け env | TSAOT_CC/UNTYPED/ALLOW_UNSUPPORTED/USE_MIMALLOC/ANALYZER/LDLIBS 等 | `GARNET_*` 新設 + ドライバ冒頭で旧名マップ + 一回限り deprecation 警告 |
| runtime の getenv ノブ | TSAOT_GC_* / TSAOT_JSON_DEPTH 等 | `getenv("GARNET_…") ?: getenv("TSAOT_…")`（init 時のみ、ホットパス影響ゼロ） |
| 内部プラミング | TSAOT_NEEDS_*/REGEXP_*/FETCH_* 連絡変数、scripts の tsaot_prepare_* | alias なし一括置換 |
| メッセージ | `"tsaot:"` プレフィクス | `"garnet:"`（fixture EXPECT を事前 grep 監査） |
| **改名しない** | C シンボル `ts_*`/`tsv`/ts_rt.{c,h}、attic の cargo bin、docs 履歴 | 明記して凍結 |

ゲート: フル一式 + `grep -rn "TSAOT_\|tsaot" --exclude-dir=attic` の whitelist 照合。

### 8b. 公開ベンチマーク物語
- pinned node/bun/deno、cold/warm 両プロトコル、peak RSS 併記、全スイート（classics/honest-dynamic/strings/data-structures/JSON/startup/real-programs）。
- **受入基準**: classics・numeric・startup・real-programs の per-suite geomean ≥1.0× vs node **and** bun。**負けた行も分析付きで公開**（bench_results.md の正直文化をスケール）。
- **旗艦 real benchmark = self-compile**: garnet 製 garnet が自分をコンパイルする時間が node 実行を上回り、旧 Rust オラクル比 ~2 倍以内（stretch: 同等）、デフォルトスタックで。
- 継続防衛: nightly dashboard（P0 の bench_history）+ 回帰 bisect playbook。

---

## 成功基準（KPI）

| 指標 | 現状（実測） | 目標 |
|---|---|---|
| self-compile（native typed） | ~600s + 64MB stack | **≤10s・デフォルト 8MB stack**（P2 で ≤60s → P6/P7 で ≤10s） |
| analyzer emit（node/旧Rust 比較軸） | 30.8s / 23.7s | node ≤5s（アルゴリズム修正は全実装に効く） |
| conformance/bundler/fixpoint | 全緑 | 全フェーズで全緑維持 |
| 2^53・abort/SIGSEGV 系 silent バグ | 既知 4 系統 | **0**（V8 一致 or catch 可能 throw） |
| classics geomean | 未計測 | ≥1.0× node & bun |
| property/dynamic kernels | O(n) 線形 | ≥3×現状、V8 比較で公開 |
| startup | 18× | ≥10× 維持 |
| 重複 walker / `any` / 巨大ファイル | ~10 個 / 150+ / 3 本 | 0 / 境界 typed 化 / 全分割 |
| Rust オラクル | CI 必須 | attic（最終 parity 証明をタグ付き記録） |

## リスク登録簿（全体）

| リスク | 緩和 |
|---|---|
| 無 VCS のまま着手 | **P0 で git init が全ての前提条件** |
| self-host 制約違反の新コード | 新ファイルごと `gate typed`、制約 checklist を docs 化 |
| walker 統一しすぎ（json_dom の意図差を汎用化） | 意味論テーブル不統一の設計 + 置換単位 parity |
| 卒業後の検出力低下 | 4a（コーパス拡張）→4b（フリップ）の順序固定、fixpoint/diffall 恒久維持 |
| fixpoint worklist 化の収束差 | parity で出力同一を証明 + 旧アルゴリズム一致 assert を 1 リリース併設 |
| shapes/PIC のプロパティ意味論破壊 | グローバルゲート段階投入 + V8 差分（順序/descriptor/proto fixture 増強） |
| GC 改修（bump+lazy handle）の移動整合性 | RT_STATS + gc_stress + フラグ切替で旧実装併存期間 |
| bench 退行見逃し | 各フェーズ末 `gate bench-correct`、相対 budget（×V8 比）導入 |

## 検証手順（フェーズ共通テンプレート）

1. 内側ループ: 変更単位ごとに `gate parity`（卒業前）/ `gate conf`（卒業後）
2. バッチ末: `gate quick` + 関連個別ゲート（bundler/unit/gc/bench-correct）
3. フェーズ末: `gate full` + `gate typed`（fixpoint）+ ベンチ計測を `docs/refactor_baseline.md` に追記 + git タグ
4. 記録: 進捗は従来どおり `docs/TODO.md` 末尾にセッション番号で追記

## スコープ外（明示）

- bigint（loud reject 維持・docs/KNOWN_GAPS.md に明記）
- Array.prototype monkey-patch（モデル外・同上）
- exporter の脱 node（TS checker 依存の根絶）— 本計画完了後の次期テーマとして記録のみ
