# garnet 完全リファクタリング & 世界最速化 基本計画（v2: Rust 主軸）

## 改訂履歴

- **v2（2026-07-03・セッション315・ユーザー決定）**: **開発主体をセルフホスト（analyzer_ts）から Rust（analyzer/）へ戻す**。typed selfhost は §313 で達成済みだが、native の self-compile が ~600s と実用外のため、セルフホストは「性能を測る指標（旗艦ベンチマーク）+ 機械的リファクタ期の byte-parity オラクル」に役割変更。v1 の P3（typed 本配線）/ P4（Rust attic 卒業・boxed 引退）は逆転・簡素化。
- v1（2026-06-11・セッション314）: 初版（セルフホスト主軸）。

## Context（なぜやるか）

313 セッションかけて Rust オラクルからの忠実移植で typed selfhost fixpoint まで到達した。しかし self IR (23.4MB, 538 関数, 66,270 命令) の emit は **node 30.8s / Rust 23.7s / native typed ~600s** で、セルフホストを開発主体・出荷物にするのは実用的でない（v2 で撤回）。一方、移植期の「byte-parity 最優先」規律が犠牲にしてきた品質問題と、実装によらないアルゴリズム問題・silent バグは残っている:

- **無駄（live なもの）**: 巨大単一ファイル — `exporter.ts` 11,074 行 / `ts_rt.c` 9,877 行 / **`emit_c.rs` ~14,500 行（メイン実装になったので第一級の分割対象）**。stale スクリプト。
  ※ v1 で挙げた emitc.ts の重複 walker・二重 emitter・生成 blob・`any` 150+ は**凍結ツリー内**となり保守コストが消えるため対象外（コンパイル可能性のみ守る）。リポ直下のゴミは s315 で削除済み。
- **バグ（silent 系）**: 2^53 跨ぎ int ループ精度（根因は TS 移植時に特定・Rust も同一ロジック: range を落とす join が i64Safe を保持 / 無範囲のまま i64 値を主張）、JSON.stringify depth>256 の catch 不能 abort、JSON.parse 深入力 SIGSEGV、selfhost の 64MB スタック要件（switch→ネスト If lowering が根因）。
- **性能**: native の 20 倍差はランタイム（Map/Set 線形走査・GC 閾値 64K alloc・全 reflike local の root/unroot・クロージャ呼び出し毎 malloc）＝**garnet が生成する全プログラムの品質問題**。node/Rust の ~25s は whole-program 数値解析を ~70 回再実行するアルゴリズム問題＝**Rust 側で修正**。プロパティアクセスは O(n) 線形走査で shapes/IC なし。
- **現状の食い違い**: `./garnet` ドライバの既定は `TSAOT_ANALYZER=ts`（boxed・`TSAOT_UNTYPED=1` 強制）のまま＝Rust メイン化と不整合 → P3 で反転。VCS は s315 で導入済み（`baseline-s313`）。

**目標**: フェーズ分けで上記を完全解決し、AOT の閉世界性を武器に「実行速度 × コンパイル速度」の両軸で世界最速の TypeScript 処理系にする。コンパイル速度の主体は Rust 実装。

## 役割分担（v2 の核）

| コンポーネント | 役割 | 開発 |
|---|---|---|
| `exporter/`（TS, node） | フロントエンド TS→IR。唯一の実装 | **メイン開発対象**（分割・switch 平坦化） |
| `analyzer/`（Rust） | IR→C。**メイン実装** | **凍結解除・開発主体**（高速化・silent バグ根治・P6/P7 最適化すべて） |
| `analyzer_ts/`（TS） | ① 旗艦ベンチマーク（66k 命令の実プログラム負荷）② 機械的 Rust リファクタ期の byte-parity オラクル | **凍結（s313 状態）**。ソース変更禁止・新機能移植なし。garnet でのコンパイル可能性のみ維持 |
| `runtime/ts_rt.c` | 共有ランタイム | メイン開発対象（変わらず） |

## 拘束条件（ユーザー決定・全フェーズ binding）

| # | 決定 |
|---|---|
| 1 | **Rust がメイン実装**（v2・2026-07-03）。byte-parity は「Rust の挙動不変リファクタ」の回帰検出器として維持 → Rust の出力を意図的に変える最初の変更（P5）の前にオラクル拡張（P4a）して卒業。analyzer_ts は attic にせず**凍結ベンチマーク**として保持 |
| 2 | **コンパイラ速度は実行速度と同列の第一級目標**（Rust self-emit 23.7s → 秒台前半、cc 段の並列化込みで全段短縮） |
| 3 | **意味論ギャップは silent 系のみ修正**（2^53 精度・abort/SIGSEGV 系）。bigint / Array.prototype monkey-patch は loud reject のまま明示的スコープ外 |
| 4 | **巨大ファイル分割は exporter.ts / ts_rt.c / emit_c.rs に実施**（凍結 analyzer_ts のファイルは対象外）。tsaot→garnet 改名も実施（cargo bin 名も P8 で改名） |
| 5 | **self-host 制約は受動化**: analyzer_ts は凍結なので新規違反は発生しない。exporter/analyzer/runtime の変更が selfhost ベンチのコンパイル・実行を壊さないことを bench ゲートが守る。例外的に凍結ソースへ触れてよいのは「コンパイル可能性を守る最小修正」のみ（出力不変を parity で証明） |

## 検証体制の二層構造（役割反転して維持）

- **Rust の挙動不変の変更**（純移動・解析キャッシュ・worklist 化）→ `emitc_diff.sh`（凍結 analyzer_ts との byte-parity 327/327）が等価性を機械証明。**検出器は対称なので、オラクルの向きが逆でも同じスクリプトがそのまま働く**
- **IR/出力 C が変わる変更** → V8 差分（conformance 327 + bundler 39 + golden_iter 96 + tsc-subset + selfhost 系）で意味論、bench budget で性能
- **ランタイムのみの変更**（ts_rt.c）→ emitted C 不変なので parity 無関係。conformance + unit + GC stress + bench で検証（**卒業前でも実施可能＝P2a を前倒しできる鍵**）
- **exporter の lowering 変更**は Rust / 凍結 TS の両方が同じ IR を消費するため parity は保たれる（switch 平坦化を卒業前に実施できる根拠）。ただし**新 IR 命令の追加は凍結 TS が UnknownInst で loud reject するため卒業後に限る**（P2c は既存命令による flat 化で実施）

---

## フェーズ一覧と依存

```
P0 足場(git済・計測) ─► P1 構造統一(exporter/ts_rt/emit_c, parityロック) ─► P3 Rust既定化 ─► P4 卒業+selfhostベンチ自己完結化 ─► P5 silentバグ根治
      │                                                                       (小粒・前倒し可)                                        │
      └─► P2 コンパイラ高速化I(並行可) ─────────────────────────────────────────────────────────────────────────────────────────────┘
                                                                        P5 ─► P6 実行性能(hot path) ─► P7 AOT差別化 ─► P8 改名+公開ベンチ
```

| Phase | 内容 | 規模目安 |
|---|---|---|
| P0 | 足場（git ✅ / ゲート統一 / 棚卸し残 / 計測基盤 / ベースライン） | 残 1–2 セッション |
| P1 | 構造統一: exporter.ts / ts_rt.c / emit_c.rs の分割（parity ロック） | 6–9 |
| P2 | コンパイラ高速化 I: ランタイム + Rust 解析アルゴリズム + switch 平坦化 + 並列 cc | 4–6 |
| P3 | ドライバの Rust 既定化 | 1 |
| P4 | parity 卒業: オラクル拡張 → selfhost ベンチ自己完結化 → ゲートフリップ + 生成 C スリム化 | 2–3 |
| P5 | silent バグ根治: 2^53 / 深度系 / label quirk / loud 点検（Rust + runtime） | 2–3 |
| P6 | 実行性能: shapes+PIC / interning / StringBuilder / GC / call ABI | 5–7 |
| P7 | AOT 差別化: typed ABI 全面化 / element kinds / init snapshot / PGO / LTO+jump table | 5–8 |
| P8 | tsaot→garnet 改名 + 「世界最速」公開ベンチ検証 | 2–3 |

---

## Phase 0: 足場 — VCS・ゲート一本化・計測基盤

**ゴール**: 「壊したら 1 コマンドで検知、1 コマンドで巻き戻し、1 コマンドで計測」。

1. ✅ **`git init` + 初期コミット**（s315: `f29b891`、タグ `baseline-s313`、.gitignore 整備済み）。以後フェーズ完了ごとにタグ。
2. **棚卸し（残り）**: ルートゴミ・dead escape_ir・迷子 .o は s315 で削除済み。残: `scripts/lib/` へ helper 移設（mimalloc_flags / regexp_link_flags / mftest→lib/mf.sh — **mftest は bundler テストが source する load-bearing**）。`run_golden_iter.sh` は削除せず P4a でゲート編入予定としてマーク。
3. **`scripts/gate.sh` 新設**（薄い dispatcher、既存スクリプト挙動不変）: `gate quick|full|typed|parity|conf|selfconf|bundler|unit|gc|bench|bench-correct|tsc|iter|ir-parity|selfbench|ci`。`gate ir-parity` は新実装（conformance 330 + bundler 39 + selfhost の batch export を byte 比較 — P1 exporter 分割の専用ゲート）。`gate selfbench` は selfhost ベンチ（P4b で自己完結化するまでは typed_selfhost.sh 相当）。
4. **計測基盤**（性能側 P0）:
   - ベンチスイート拡張（`benchmarks/manifest.tsv` に suite/engines 列追加）: classics（richards/deltablue/splay/navier-stokes/crypto を素直な TS で）、**escape-hardened 動的系**（出力を消費して最適化で消えない megamorphic property / proto chain / `obj[k]` / Map・Set churn 10³–10⁶ / JSON 1–50MB round-trip）、**self-compile をステージ分割計測のベンチに昇格**（JSON parse / devirt / escape+sroa / fixpoints / emit / cc / total — **Rust・node・native selfhost の 3 実装で計測**）、startup 維持。
   - エンジン比較ハーネス `run_engine_benchmarks.sh <node|bun|deno>`（warmed best-of-N、結果 JSON を `build/bench_history/` に蓄積）。
   - プロファイル導線: `garnet --profile`（-g -fno-omit-frame-pointer）+ `scripts/profile_bench.sh`（macOS: xctrace/sample、Linux: perf+flamegraph）。**Rust 側は `cargo build --profile release-debug` 等で同様に**（P2b のホットスポット特定に必須）。
   - **ランタイム統計カウンタ `TSAOT_RT_STATS=1`**（新設 ~50 行 ifdef）: minor/full GC 回数・pause 合計・alloc バイト・handle 表サイズ・map_find/find_prop プローブ長ヒスト・ts_call malloc 回数・concat 回数/バイト・root push 回数。以後の全 perf 判断の事実基盤。
5. **ベースライン記録**: 全ゲート結果・所要時間・全ベンチ数値を `docs/refactor_baseline.md` に固定。

**ゲート**: 既存全スクリプト緑（包むだけ）。**リスク**: mf 移設で bundler 破損 → 前後で `gate bundler`。

---

## Phase 1: 構造統一 — 3 大ファイル分割（parity ロック）

**ゴール**: メイン実装（exporter / emit_c.rs / ts_rt.c）を責務単位のモジュール構造に。**1 移動 = 1 `gate parity`** の粒度で純移動を貫く（emit 順序・speculative emit・ラベル副作用は 1 文字も変えない）。
v1 の 1a/1b（TS 側 ir_walk・emitc.ts 分割・`any` 根絶）は**撤回** — 凍結ツリーに投資しない。

### 1a. exporter.ts 分割（3–4 セッション）
- 分割: `wire.ts`（toWireProgram/サロゲート処理/精度保持数値 — 純関数）/ `builtins_table.ts` / `diagnostics.ts`（unsupported 機構）/ `lower_expr.ts` / `lower_regexp.ts`（2115–2740 行、高凝集）/ `lower_stmt.ts` / `modules_linkage.ts` / `scan_free.ts`（freeVars 不動点 — **一塊で移動**）/ `exporter.ts`（Exporter クラス＝オーケストレータ残置）。メソッドは `ex: Exporter` 第一引数の自由関数へ機械変換。node 専用なので self-host 制約なし。
- **single/batch 統一**: single を「要素数 1 の batch」に（§304 の lib 設定差 TS2550 を根絶）。
- **専用ゲート `gate ir-parity`**（IR byte 不変）が主役 + conf + bundler + selfbench。

### 1b. ts_rt.c 分割 — unity build（2–3 セッション、いつでも並行可）
- `runtime/src/` に 10 部品（rt_gc / rt_value / rt_string / rt_array / rt_scalar / rt_object / rt_json / rt_error_eh / rt_async / rt_fetch、実測セクション境界）。**ts_rt.c は部品を順に `#include` する unity build に**（`cc -O2` の単一 TU インライン性能と `build/rt.o` の作り方を不変に保つ）。`rt_internal.h` 新設で前方宣言を整理、重複 typedef（ts_class_reg ×3 等）を dedupe。公開 ABI（ts_rt.h）不変、`nm build/rt.o` のシンボル差分ゼロ確認。
- ゲート: conf + unit + gc + bundler + bench A/B（中立性）。

### 1c. emit_c.rs 分割（2–3 セッション・v2 新設）
~14,500 行を実測セクション境界で Rust モジュールへ純移動（`mod` 化 + `pub(crate)` 可視性の機械的付与のみ。string_metrics / string_materialization / string_plan は既に別ファイル）。分割マップ目安（行番号は §309–312 の実測アンカー）:

| 新モジュール | 元 emit_c.rs 行（目安） | 内容 |
|---|---|---|
| `emit_c/class_layout.rs` | 1075〜 | class layout / descriptors / proto setups |
| `emit_c/scalar_slice.rs` | 2533〜 | scalar string slices |
| `emit_c/infer.rs` | 3334〜4862 | NumFact lattice / indirect / param facts / i64・f64 fast |
| `emit_c/coroutine.rs` | 4938〜 | Flat / flatten_cf / SM resume |
| `emit_c/fused_loops.rs` | 〜9246〜12515 近辺 | fused metric/polymorphic loops + select4 |
| `emit_c/inst.rs` | 13468〜 | emit_inst dispatch |
| `emit_c/builtins.rs` | 13636〜 / 14423〜 | CallBuiltinStatic / CallBuiltin の全 arm |
| `emit_c.rs`（残置） | 冒頭 + 末尾 | EmitCtx・cname 系・emit_program = driver |

- 分割中に見つかる Rust 内の重複 walker・dead arm は**発見のみ記録**（`docs/emit_c_findings.md`）— 統一・削除は挙動不変が自明な範囲を除き P5 以降。
- ゲート: 1 移動 = 1 `gate parity`（凍結 TS が検出器）+ フェーズ末 `gate full`。`cargo build` 時間の A/B も記録（分割で incremental build が改善するはず）。

**P1 全体のリスク**: モジュール循環（emit_c は EmitCtx を leaf に）/ 移設による bundler 破損（→ 前後 `gate bundler`）/ ラベル副作用の破壊（→ speculative emit は P5 まで不可侵）。

---

## Phase 2: コンパイラ高速化 I — Rust self-emit 23.7s→≤5s / native selfhost 600s→≤60s（P1 と並行可）

**ゴール**: ① Rust の self-emit **23.7s → ≤5s**（アルゴリズム側・メイン実装の実利）② native selfhost ベンチ **~600s → ≤60s**（ランタイム側＝生成コード品質の指標）③ cc 段の並列化。卒業前に実施可能（ランタイム変更は parity 無関係、解析キャッシュは出力同一、switch 平坦化は IR 共有で parity 保持）。

### 2a. ランタイムデータ構造（ts_rt.c のみ、emitted C 不変）
| 施策 | 根拠（実測） | 期待 |
|---|---|---|
| **ts_map/ts_set にハッシュ索引**（挿入順 key/val 配列は仕様順序のため維持 + open-addressing u32 index。文字列は既存 hash 再利用、数値は double bits mix、オブジェクトは handle id） | `map_find` が線形走査（ts_rt.c:3242、コメント自認）。解析は命令×エントリ×パスで実質二乗 | **5–10×**（selfhost ベンチ支配項） |
| **ts_intern_field のハッシュ化** | 動的 intern が O(#fields) memcmp（ts_rt.c:4539） | 動的キー多用コードで大 |
| **文字列 hash の遅延化**（hash=0 番兵、初参照で計算） | 全生成サイトで eager hash。emitter は使わない hash を数百万回計算 | 文字列構築系 1.2–2× |
| **find_prop の辞書フォールバック**（プロパティ数 >8 でハッシュ） | O(n) 走査（ts_rt.c:504）。P6 shapes までの暫定 | 中 |
| **GC 閾値見直し**（young 65,536 **alloc 回数** → ~1M 相当 or byte 会計、full floor を live set 比例に） | 64K alloc ごとに全 g_roots 走査（ts_rt.c:27,188） | 中–大 |
| **クロージャ呼び出しの malloc 除去**（合計 ≤16 slot はスタックバッファ） | ts_call が毎呼び出し malloc+copy+free（ts_rt.c:341–357）、ts_call_value は this 注入で二重 malloc | callback 多用コードで大 |

検証: conf + unit + `run_gc_stress.sh` + bench + RT_STATS 前後差分。**Map の挿入順イテレーションが仕様**なので順序退行は conformance が検出。

### 2b. 解析アルゴリズム（**Rust 実装**・出力 C 同一 → parity で等価性証明）
- **flatten キャッシュ**: sroa 後に関数ごとの flat 命令列と def/use 索引を 1 回だけ構築（`FunctionIndex` 相当を emit_c 内に新設）。現状 `infer_numeric_analysis`（emit_c.rs 3334〜）/ `infer_program_param_facts`（3985〜）/ `collect_i64_seed_param_facts` / `numeric_value_locs` / dom・slice 系が**関数あたり ~70–140 回** flatten を再実行（TS 移植時の実測と同型＝アルゴリズムは両実装共通）。localClassMap/unboxed 分類も per-function memoize。
- **fixpoint の worklist 化**: `infer_program_param_facts` の 8 回盲目 sweep → call graph（devirt 後に既知）上の worklist へ。`infer_i64_fast_funcs` の外 8×内 8（whole-program 再解析 ≤64 回）→ call-site 寄与のキャッシュ + 影響波及のみ再 join。**収束値は同一のはず → `gate parity` がそのまま等価性証明**（1 リリースの間、旧アルゴリズムとの一致 assert を debug ビルドに併設）。
- **emit 時の解析再実行排除**: 最終 emit ループの per-function な infer 再実行を収束済み解析のルックアップに。
- node 側（凍結 analyzer_ts）の ~25s は同根だが**直さない**（凍結）。むしろ「アルゴリズム改善前の基準実装」として比較軸に使える。
- 期待: whole-program 解析 ~70 回 → 2–3 回 + 小 worklist = **5–10×**。

### 2c. switch lowering 平坦化（exporter — IR が変わるが Rust/凍結 TS 共有で parity 保持）
- `buildMatch`（exporter.ts:9028–9071）の「case 数ぶんネストした If チェーン + 全 case 走査の active フラグ」→ **run-once breakable Loop の flat If 兄弟列**（matched=i; Break）。**既存 IR 命令のみで構成**（第一級 `Switch` 命令は凍結 TS が UnknownInst で reject するため卒業後の P7 で検討）。
- 一挙に 3 問題を解決: ① IR ネスト ~300 深（**64MB スタック要件と JSON 深度問題の根因**）→ O(1) 深、② 生成 C の O(cases) 逐次比較 dispatch、③ P7 jump table の前提（flat 形からのパターン検出）。
- 検証: conf + parity（両実装が新 IR で 327/327）+ selfbench（**`ulimit -s 65520` 撤去の実測**）+ bundler + bench-correct（control_switch 系注視）。深ネスト switch fixture を追加して再発防止。

### 2d. 並列 C バックエンド + 出力構築（Rust）
- `--jobs N`: 関数群を N 個の .c に分割 emit + 共有ヘッダ → 並列 cc + link（5.6MB 単一 TU の cc が serial tail。**~4–6×**、将来の incremental 再コンパイルの土台）。**既定は従来どおり単一 .c → parity 影響なし**（--jobs は opt-in）。
- 出力構築は P0 カウンタで concat コストを実測してから（Rust 側は String pre-reserve 等の低リスク改善のみ先行可）。
- JSON IR の binary 化は**計測ゲート付き保留**（P0 ステージ計測で >10% を占めたときのみ）。

---

## Phase 3: ドライバの Rust 既定化（1 セッション・P0 直後に前倒し可）

1. **既定反転**（garnet:81–116）: `TSAOT_ANALYZER` の既定を `ts` → **`rust`**（typed fast path が既定に。rust arm は元々 UNTYPED 強制なし）。`ts` / `native` arm はオラクル・ベンチ用に残置（ts は boxed+UNTYPED 強制のまま＝凍結時挙動を保存）。
2. ハーネスの経路統一: run_conformance / mf を「ドライバ経由 + TSAOT_ANALYZER 切替」へ（Rust 直指しの段階排除。オラクル比較は明示的に ts を指す）。
3. README / HANDOFF の既定説明更新。**ill-typed 入力は型エラーで loud 停止が既定になる**（従来 ts 既定は boxed で通していた）→ `--untyped` エスケープを明記。

**ゲート**: conf/bundler（rust 経由）+ selfbench + bench-correct。

---

## Phase 4: parity 卒業 — オラクル拡張 → selfhost ベンチ自己完結化 → フリップ

**順序厳守: 4a（オラクル拡張）→ 4c（フリップ）**。parity という超高感度検出器を失う前に検出網を増やす。Rust は退役しない（メイン実装）。analyzer_ts も退役しない（凍結ベンチ）。

### 4a. オラクル拡張
- `run_golden_iter.sh`（96 fixture）をドライバ経由に付け替え `gate iter` 常設化。`run_tsc_conformance.sh` を pass-list ゲートに昇格。
- P5 で直すバグを踏む **known-fail fixture を先に追加**（2^53 跨ぎ +/-、巨大 switch、深い JSON、深い再帰 stringify）。

### 4b. selfhost ベンチの自己完結化（Rust 進化と独立に）
- **入力も参照出力も凍結ソースから再導出可能**にする: 入力 IR = 凍結 analyzer_ts ソースの batch export（コンテンツハッシュを記録し、exporter 進化によるドリフトは「検知して意図的に再 pin」）。参照 C = `node analyzer_ts/dist/main.js <pinned IR> emitc`（凍結ロジックの出力。dist は凍結ソースから tsc で再構築可能）。
- **ゲート定義（diffall/fixpoint の恒久一般化）**: current garnet（Rust + 現行 runtime）で凍結ソースをコンパイルした native tsan が、pinned IR に対して**参照 C と byte 一致**の出力を出すこと。凍結ソースの挙動はソース不変ゆえ不変 → このゲートは「現行コンパイラが 66k 命令の実プログラムを正しくコンパイルできるか」を Rust の進化・runtime の ABI 変更と無関係に検証し続ける（P6 の ABI 変更もベンチ再ビルドで自動的に追随・検証される）。
- **ベンチ定義**: ① compile-speed: garnet が凍結 analyzer_ts をコンパイルする各ステージ時間 ② run-speed: その native が pinned IR を emit する時間（node 30.8s / Rust 23.7s を固定基準値として併記）③ correctness: 上記 byte 一致。
- typed fixpoint（gen2==gen3）は selfbench の correctness に包含される形で恒久化。

### 4c. ゲートフリップ
- P5 着手（Rust 出力の意図的変更）の直前に**最終 parity 証明を実行・記録**（`docs/parity_final.md` + git タグ `parity-final`）。
- CI 必須から外す: emitc_diff.sh / devirt・escape ダンプ比較 / 3-way smoke / Rust-vs-TS fixpoint。以後の真実は V8 差分系（conformance tier 拡張 / bundler / iter / tsc-subset）+ selfbench + bench + unit/gc。
- analyzer_ts ツリー・boxed emit.ts・ゲートスクリプトは**凍結のまま保持**（削除も attic 移動もしない＝selfbench の再導出基盤。ゼロ保守コスト）。

### 4d. 生成 C スリム化（Rust 側・出力が変わるので卒業後）
- **`ts_setup_global_object` の runtime 移管**: Rust が全プログラムに emit している静的セクション（~16KB）を ts_rt.c の通常関数へ移し、生成 C は呼び出し 1 行に（cc 短縮 + 生成 C 縮小）。**新シンボル追加のみで既存シンボルの意味は変えない**（凍結 emitter が出す旧形式 C も引き続きコンパイル可能に＝selfbench が検出器）。初期化順の既知罠（g_function_proto 後の box）に注意。
- 凍結側の対応物（emitc_sections_gen.ts の静的 blob）は凍結につき放置で無害。

---

## Phase 5: silent バグ根治（卒業後 — 出力 C が変わる。実装は Rust + runtime）

### 5a. 2^53 int 特化精度（最優先・emit_c.rs の数値推論）
- **lattice 二層化**: `i64Safe`（±2^53 以内**証明済み**）と `intValued`（整数だが大きさ未証明）を分離。① join の range 落ち時と i64 値化で i64Safe を**降格**、② unguarded `d+d` fast path は i64Safe のみ、③ `intValued` の +/- は **unboxed double に分類**（= V8 の double 丸めそのもの＝正確、box 化はしないので退行小）。
- **回収策**: ループ束縛帰納証明（`infer_loop_bounds`）— `i < n` で n が i64Safe・i 非減少・step 上界既知なら `i ≤ n+step` を証明し i64Safe 維持 → `for (i=0; i<arr.length; i++)` 系は全て int に残る。
- ガード付き i64（overflow 分岐）は [2^53,2^63) 証明可能時の opt-in として P6/P7 に引き継ぎ（2^63 超の `(long long)` UB 回避設計込み）。
- 検証: 4a の known-fail fixture が V8 一致へ + conf/bench 全緑 + int→f64 降格の退行測定。

### 5b. 深度系の監査と catch 可能化
| 箇所 | 現状 | 修正 |
|---|---|---|
| JSON.stringify depth>256 abort (ts_rt.c:5112) | catch 不能 | `ts_throw`（RangeError 相当）+ 上限 env 可変。主因は 2c で消滅済み |
| JSON.parse 再帰（5876–） | 深入力 SIGSEGV | depth カウンタ + catch 可能 throw |
| selfhost 64MB スタック | 2c で根治済確認 | `ulimit` ハック完全撤去（selfbench で実測） |
| exporter の他の O(source) ネスト | 監査 | optional chain/分割代入深度を grep、必要なら 2c 方式 |

### 5c. ラベル採番 quirk の卒業（emit_c.rs）
- Loop body の捨て emit（`try_emit_string_metric_loop_body` emit_c.rs:12515 — metric plan 不一致時の 2 回 emit）→ 純 shape 判定に置換。fdre の plan 経路 fresh-label → 単一経路に整理。ラベル番号は変わるが意味論不変（conf + selfbench + bundler で自己無撞着を確認）。

### 5d. loud-reject 総点検
- 「shouldn't happen で黙ってフォールバック」を grep 監査し throw/panic 化（§300 教訓の checklist 化、emit_c.rs / sroa.rs / exporter）。

---

## Phase 6: 実行性能 — ランタイム hot path

**ターゲット**: property kernels ≥3× / richards・deltablue ≥0.8×V8（stretch 1.0×）/ closure call ≥2× / gc churn ≥2× / **native selfhost ベンチさらに ~2×以上（≤60s → ≤10s 級）**。

| 施策 | 場所 | 内容 |
|---|---|---|
| **AOT shapes + per-site PIC** | runtime+emit_c+解析 | 閉世界 ⇒ 全 object-literal/class サイトにコンパイル時 shape id + slot 表。props を dense slot 配列に、`ts_object.shape` 語を本来の用途に。emitted C に per-site `static ts_pic {shape_id, slot}` — 単型ヒット＝比較+索引ロード。delete/exotic は辞書モード降格。`g_has_proxies` 式のグローバルゲートで段階投入 |
| **文字列 interning** | emit_c+runtime | 静的文字列は全て compile-time intern（hash+field-key id 前計算）。動的キーは runtime intern 表 → ポインタ等値 fast path（shapes と相乗） |
| **StringBuilder** | runtime+emit_c | `ts_sb`（指数成長）+ 既存 fused/metric パスの拡張で `s += ...` ループと多パーツ template literal を builder 化（selfhost の 5.6MB C 構築にも直撃）。ropes は明示的に見送り（views+builder で十分） |
| **root batching** | emit_c+runtime | n 回の `ts_gc_root` → **frame 構造体 1 push**（reflike locals を連続 frame struct に、静的 descriptor）。EH は既に root depth snapshot 方式なので合成可能。コルーチン（locals が frame 常駐）との整合に注意 |
| **GC: bump nursery + lazy handle** | runtime | per-object calloc → 連続 4–32MB nursery の bump alloc。**handle は最初に移動/昇格した時のみ割当**（短命オブジェクトの handle 表 store と間接参照を全廃）。minor GC は remset+roots から直接参照を fixup |
| **closure ABI** | emit_c+runtime | `f(env, args, nargs)` 署名で env をそのまま渡す（P2a の残り copy も全廃）。call/apply/bind/adapter への波及を一括 |
| **arity 特化 direct-call ABI** | emit_c | 既知 arity の直呼びに typed C 署名 `tsv f(tsv a0, tsv a1)`（i64/f64 clone 機構の tsv 一般化）— args 配列マテリアライズ排除 + C インライン解禁 |

検証: V8 差分（プロパティ意味論: 順序/descriptor/proto が安全網）+ 新スイート + RT_STATS 差分 + gc stress + **selfbench correctness（ABI 変更のたびに凍結ソースを現行ツールチェーンで再ビルド＝互換性の実地検証）**。

---

## Phase 7: AOT 差別化 — JIT にできない証明ベース最適化（実装は Rust）

**ターゲット**: classics geomean ≥1.0× node & bun / 数値配列 ≥1.5×V8 / startup ≥10× 維持 / **native selfhost run ≤ Rust self-emit ×2**（stretch: 同等）。

1. **whole-program shape 証明 → 直接 slot アクセス**: サイト単型 + shape sealed（動的 add 無し・Proxy 無し）を**証明**できたら PIC すら省略して `obj->slots[k]` 直書き。動的機能はグローバル program-facts フラグで escape hatch。
2. **fully-typed プログラムの boxed 経路全廃**: any が流入しない関数群は端から端まで native C 署名（tsv は I/O 境界のみ）。FN_TABLE には boxed thunk を残す。i64/f64 clone エンジンの全面一般化。
3. **配列 element kinds**: double-only 配列は `double[]` 非 box 格納（kind タグ + 非 double store で遷移）。int32 kind は計測の上判断。
4. **int32 vs i64 の計測タスク**: V8 SMI(31/32bit) との比較で「range 証明付き i64（チェック無し）」vs「int32+overflow 分岐」を int スイートで実測 → 結果がどちらでも public story に文書化（予想: スカラは i64 維持、配列要素のみ int32 検討）。
5. **module-init snapshot**: ビルド時に `__module_init` を計装ランタイムで実行 → 結果 heap を静的 C データに直列化（handle/proto 再配置表付き）。純粋性解析（I/O/Date/random 不在）でゲート。startup を構造的優位に。
6. **PGO ループ**: `garnet --pgo` — IR site id キーのカウンタ計装（call site/loop trip/PIC 多型度）→ 実行 → 再コンパイルで inlining budget・direct-vs-PIC・hot/cold 分割・`__builtin_expect` に反映。`cc -fprofile-use` 連鎖も。
7. **C レベル codegen**: `--lto`（-flto -O3）、TS_AOT_INLINE 監査（write barrier の remembered-set 経路が現状 call）、**2c の flat 形を本物の C `switch`/computed goto に**（第一級 Switch IR の導入もこの時点なら可 — parity 卒業済み。自前命令 dispatch が第一受益者）、コルーチン resume の computed goto 化。
8. **direct-threaded async**: await 連鎖の callee が静的既知なら microtask queue を経由せず直接 resume。queue は ring buffer 化。

各施策は独立フラグ + V8 差分フルコーパス + 専用ベンチで個別検証。

---

## Phase 8: 改名 + 「世界最速」公開検証

### 8a. tsaot→garnet rename
| 区分 | 対象 | 方針 |
|---|---|---|
| ユーザー向け env | TSAOT_CC/UNTYPED/ALLOW_UNSUPPORTED/USE_MIMALLOC/ANALYZER/LDLIBS 等 | `GARNET_*` 新設 + ドライバ冒頭で旧名マップ + 一回限り deprecation 警告 |
| runtime の getenv ノブ | TSAOT_GC_* / TSAOT_JSON_DEPTH 等 | `getenv("GARNET_…") ?: getenv("TSAOT_…")`（init 時のみ、ホットパス影響ゼロ） |
| 内部プラミング | TSAOT_NEEDS_*/REGEXP_*/FETCH_* 連絡変数、scripts の tsaot_prepare_* | alias なし一括置換 |
| **cargo bin** | `analyzer` の bin 名 `tsaot` | **改名する**（メイン実装として恒久化したため。scripts の参照を一括置換、フルゲートで検証） |
| メッセージ | `"tsaot:"` プレフィクス | `"garnet:"`（fixture EXPECT を事前 grep 監査） |
| **改名しない** | C シンボル `ts_*`/`tsv`/ts_rt.{c,h}、**凍結 analyzer_ts 内の識別子**、docs 履歴 | 明記して凍結 |

ゲート: フル一式 + `grep -rn "TSAOT_\|tsaot" --exclude-dir=analyzer_ts` の whitelist 照合（凍結ツリーは除外）。

### 8b. 公開ベンチマーク物語
- pinned node/bun/deno、cold/warm 両プロトコル、peak RSS 併記、全スイート（classics/honest-dynamic/strings/data-structures/JSON/startup/real-programs）。
- **受入基準**: classics・numeric・startup・real-programs の per-suite geomean ≥1.0× vs node **and** bun。**負けた行も分析付きで公開**（bench_results.md の正直文化をスケール）。
- **旗艦 real benchmark = selfhost**: ① garnet が自身の 66k 命令アナライザ（凍結 selfhost）を何秒でコンパイルできるか ② その native が 23.4MB IR を emit する時間 vs node 30.8s（固定基準）。「自己ホスト能力は §313 で実証済み・凍結ソースからいつでも再実証可能」を物語に含める（fixpoint は selfbench correctness として常時検証）。
- 継続防衛: nightly dashboard（P0 の bench_history）+ 回帰 bisect playbook。

---

## 成功基準（KPI）

| 指標 | 現状（実測） | 目標 |
|---|---|---|
| Rust self-emit（メイン実装のコンパイル速度） | 23.7s | **≤5s**（P2b） |
| garnet self-compile 全段（export+emit+cc、--jobs 込） | 未計測（P0 で固定） | P0 実測後に確定（仮: ≤30s） |
| native selfhost run（生成コード品質の旗艦指標） | ~600s + 64MB stack | **≤60s（P2）→ ≤10s 級（P6/P7）・デフォルト 8MB stack** |
| node 参照（凍結 analyzer_ts on node） | 30.8s | 凍結基準値として固定（比較軸） |
| conformance/bundler/selfbench | 全緑 | 全フェーズで全緑維持 |
| 2^53・abort/SIGSEGV 系 silent バグ | 既知 4 系統 | **0**（V8 一致 or catch 可能 throw） |
| classics geomean | 未計測 | ≥1.0× node & bun |
| property/dynamic kernels | O(n) 線形 | ≥3×現状、V8 比較で公開 |
| startup | 18× | ≥10× 維持 |
| 巨大ファイル | exporter.ts 11k / ts_rt.c 9.9k / emit_c.rs ~14.5k 行 | 3 本とも責務単位に分割（凍結ツリーは対象外） |
| analyzer_ts（凍結ベンチ） | typed selfhost 達成状態 | **selfbench（compile+run+byte 一致）緑維持** |

## リスク登録簿（全体）

| リスク | 緩和 |
|---|---|
| ~~無 VCS のまま着手~~ | **解消済み**（s315: git init + baseline-s313） |
| 凍結 analyzer_ts が exporter/emitter/runtime の進化でコンパイル・実行不能に | `gate selfbench` をフェーズ末必須に（壊れた瞬間に検知）。runtime は既存シンボルの意味変更禁止（追加は可） |
| parity 卒業前に Rust の出力変更が混入 | P5 まで「出力を変える変更は禁止」規律 + parity を CI 必須に維持 |
| 二重実装への逆戻り（Rust の変更を analyzer_ts へ「少しだけ」移植） | **禁止を明文化**（凍結。例外はコンパイル可能性を守る最小修正のみ・出力不変を parity で証明） |
| 卒業後の検出力低下 | 4a（コーパス拡張）→ 4c（フリップ）の順序固定、selfbench correctness 恒久維持 |
| fixpoint worklist 化の収束差 | parity で出力同一を証明 + 旧アルゴリズム一致 assert を debug ビルドに 1 リリース併設 |
| shapes/PIC のプロパティ意味論破壊 | グローバルゲート段階投入 + V8 差分（順序/descriptor/proto fixture 増強） |
| GC 改修（bump+lazy handle）の移動整合性 | RT_STATS + gc_stress + フラグ切替で旧実装併存期間 |
| bench 退行見逃し | 各フェーズ末 `gate bench-correct`、相対 budget（×V8 比）導入 |

## 検証手順（フェーズ共通テンプレート）

1. 内側ループ: 変更単位ごとに `gate parity`（卒業前・Rust の挙動不変変更）/ `gate conf`（卒業後）。ランタイムのみの変更は conf + unit + gc。
2. バッチ末: `gate quick` + 関連個別ゲート（bundler/unit/gc/bench-correct）
3. フェーズ末: `gate full` + `gate selfbench` + ベンチ計測を `docs/refactor_baseline.md` に追記 + git タグ
4. 記録: 進捗は従来どおり `docs/TODO.md` 末尾にセッション番号で追記

## スコープ外（明示）

- bigint（loud reject 維持・docs/KNOWN_GAPS.md に明記）
- Array.prototype monkey-patch（モデル外・同上）
- exporter の脱 node（TS checker 依存の根絶）— 本計画完了後の次期テーマとして記録のみ
- **セルフホスト開発の再開** — P6/P7 で生成コードが Rust 比 ~2× 圏に入れば技術的には再検討可能になるが、本計画では扱わない（selfbench の数値がその判断材料を自動的に蓄積する）
