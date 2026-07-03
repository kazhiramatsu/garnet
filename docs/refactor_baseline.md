# refactor baseline — P0 固定値（2026-07-03・セッション315）

リファクタ計画（`docs/refactor_master_plan.md` v2）の全 perf 判断の基準点。
以後、各フェーズ末にこのファイルへ追記していく（上書きしない）。

- 環境: Darwin arm64 (macOS 25.5.0), `cc -O2` (Apple clang), node v25.2.1
- 「†」= バックグラウンドで GC stress 等が並走していた時間帯の参考値
  （教訓: マシン負荷下のベンチ絶対値は不可信 — A/B は同条件で取り直す）。
- **運用方針（ユーザー指示・2026-07-03）**: 数分以上 CPU 100% 級のジョブ
  （gc / bench / full / typed / native emit）は勝手に実行しない。時間枠を
  ユーザーと合意した「計測ウィンドウ」で実行し、本ファイルに追記する。

## ゲート結果と所要時間（P0 完了時点）

| gate | 結果 | 所要 | 備考 |
|---|---|---|---|
| `gate parity` | **PASS** identical=327 / UNPORTED=0 / DIFF=0 / skip=0 | 28.2s | batch export キャッシュ利用時 |
| `gate ir-parity snap`+比較 | **PASS** 2,095 ファイル自己一致 | 35.9s（比較のみ ~18s） | exporter 出力の決定性を実証 |
| `gate conf all` | **PASS** 330/330 | 未計時 | basic 3 + exhaustive 327。export+transpile 330 は 2.7s |
| `gate bundler` | **PASS** 39/39 | 未計時 | helper 移設後の検証で完走 |
| `gate unit` | **PASS**（runtime + analyzer 全スイート） | 10.7s† | |
| `gate iter` | **PASS** 48 cases | 25.5s† | 計画の「golden_iter 96」は実測 **48 cases**（計画側の誤記） |
| `gate gc` | **中断（未完走）** | — | classes_* 台まで無 FAIL で進行後、低負荷方針により停止。完走は計測ウィンドウで |
| `gate bench` / `gate quick` / `gate full` / `gate typed` | **延期** | — | 低負荷方針。計測ウィンドウで実行し追記 |

## self-compile ステージ分割（旗艦ベンチ・`scripts/bench_selfcompile.sh`）

対象: 凍結 analyzer_ts（selfhost_typed.ts）。IR **23,418,729 B**（23.4MB）、
生成 C **5,593,546 B**（5.59MB）。rust vs node emit は **byte-identical**（parity 同梱検査で確認済み）。

| ステージ | best ms | 条件 |
|---|---|---|
| export（node, typed） | 1,452† | --runs 1 検証実行 |
| emit-rust | 24,584† | 同上（s314 実測 23.7s と整合） |
| emit-node（凍結TS） | 35,338† | 同上（s314 実測 30.8s と整合） |
| emit-native（garnet 製 tsan） | 未計測 | s314 実測 ~600s + 64MB stack。計測ウィンドウで |
| cc（5.59MB 単一 TU + link） | 未計測 | 計測ウィンドウで（P2d --jobs の基準値） |

負荷ゼロでの取り直し（--runs 3・cc 込み）とパス内部分割（devirt/escape/sroa/
fixpoint 別、P2 で analyzer 計装後）は計測ウィンドウで追記。JSON は
`build/bench_history/` に蓄積される（検証実行分: 20260703T070816Z_selfcompile.json）。

## ランタイム統計の初期観測（`garnet --rt-stats`）

smoke プログラム（10 要素 for ループ + console.log 1 回）ですら:

- `find_prop`: 860 calls, **avg_probe=12.63**（O(n) 線形走査の実測）
- `intern`: 298 calls, **avg_probe=98.78**（動的 intern が O(#fields) memcmp）
- alloc 264 回 / 27.5KB, handle_cap 65,536（最小構成でも 512KB の handle 表）

→ P2a（Map/Set・intern・find_prop のハッシュ化、GC 閾値、closure malloc 除去）の
事実基盤。ワークロード別（selfhost native 実行時等）の統計は P2a 着手時に取得。

## GC マイクロベンチ（`scripts/bench_gc.sh`・スイート全体 ~19s で完走）

負荷ゼロ状態・runs=3 best・typed（rust analyzer）。**GC 改善（P2a/P6）の判断はこれが基準**。
カウンタ系（回数・alloc・プローブ長・malloc 数）は決定値なので負荷非依存。
wall/pause の A/B は「生成 C 共有 + `TSAOT_RT_OBJ` で旧/新 stats rt.o を交互差し替え（ABAB）」で取る
（GC 内部の変更は ABI 不変なのでこれが成立する）。重い `gate gc`（threshold=1+ASan）は
correctness 専用として役割分担 — 速さはこちら、正しさはあちら。

| bench | wall ms | minor | full | pause ms | max pause ms | alloc MB | 特記 |
|---|---|---|---|---|---|---|---|
| gc_shortlived | 182 | 45 | 0 | 1.11 | 2.23 | 192.0 | nursery 回収の支配ケース |
| gc_survivors | 110 | 16 | **13** | 2.50 | **7.36** | 96.0 | full GC 頻発 = full 閾値 262,144 の実挙動 |
| gc_mapset_churn | 760 | 0 | 0 | 0 | 0 | ~0 | **map_find avg_probe=2,219.58**。Map エントリは realloc 配列（GC 外）と判明 |
| gc_closures | 222 | 61 | 0 | 1.20 | 3.79 | 352.0 | **env_malloc=4,000,000**（呼び出し 4M 回ぶん） |
| gc_strings | 1,194 | 6 | 0 | 3.28 | 5.18 | 536.5 | 大粒 alloc は GC 頻度より alloc/copy コスト側 |

初回観測の含意（P2a の定量的出発点）:
- Map churn の 760ms はほぼ全て O(n) 線形走査（プローブ 2,219/回）→ ハッシュ索引で桁が変わるはず
- closure 呼び出しは 1 call = 1 malloc が実測で確定（4M call / 222ms）→ スタックバッファ化の効果は直接測れる
- full GC の max pause 7.4ms（10 万 live）→ P6 bump nursery / lazy handle の前後比較指標
- 結果 JSON は `build/bench_history/<UTC>_gc.json` に蓄積（初回: 20260703T073141Z_gc.json）

## エンジン比較（`scripts/run_engine_benchmarks.sh`）

- node v25.2.1（サブセット検証）: string_scan_kernel 131.2ms PASS。
  kernel プロトコル（`module.exports={kernel,BENCH_N}`）を持たない .js
  （self-executing スクリプト形）は NO_KERNEL としてスキップ集計 — サイレント省略しない。
- 全行の node / bun / deno 計測は計測ウィンドウで実行し追記。
- classics / escape-hardened 動的系スイートの追加は次セッション以降（P0 残）。

## 既知の注記

- 計画中の「conformance 327」は exhaustive tier のみの数。gate は basic 込み 330。
- bundler fixture 内の生成物・`build/` は .gitignore 済み（各ハーネスが再生成）。
- `TSAOT_RT_STATS` はコンパイル時 opt-in（`-DTSAOT_RT_STATS` / `garnet --rt-stats`）。
  既定ビルドはマクロが空になりホットパス影響ゼロ（conf all 330/330 で無退行確認）。

## 計測ウィンドウ 2026-07-03（セッション316）

- **`gate gc` O2 部分: PASS 18/18**（focused conformance, threshold=1, normal O2）。
- **`gate gc` ASan 部分: 環境ブロッカーで実行不能** — Apple clang 17.0.0 (clang-1700.6.4.2,
  CLT 26.3) の libclang_rt ASan が macOS 26.5.1 で**起動時デッドロック**する。
  `AsanInitInternal → InitializeShadowMemory → get_dyld_hdr → _Block_copy → malloc →
  ASan init 再入 → 自分の StaticSpinMutex を待って sched_yield 永久スピン`（sample で確認）。
  `int main(){return 0;}` の最小 ASan バイナリでも再現 = garnet 非依存。
  前セッションの「classes_* 台で長時間化」も実体はこれ（1 バイナリが CPU 96 分スピン）。
  **対処候補: Xcode/CLT 更新、または homebrew gcc（実 GCC の libasan）**。解消までは
  `TSAOT_GC_STRESS_ASAN=0 TSAOT_GC_STRESS_RUNTIME_ASAN=0` で O2 部分のみ運用。
- 運用知見: 長時間ジョブは `taskpolicy -b -p <pid>` で E-core 限定にでき、体感負荷を
  ほぼゼロにできる（wall 計測には使わない。correctness 専用）。
- **`gate bench`: PASS 99/99（全行 correct + 予算内）、所要 63s**（逐次 1 コア・nice 10・
  アイドルマシン）。当初見積 ~10 分は過大だった — スイート全体が軽い。
- **`bench_selfcompile.sh --runs 3`（負荷ゼロ・best-of-3・所要 180s）— † 無しの確定値**:
  export **1,344ms** / emit-rust **22,487ms** / emit-node **29,269ms** / **cc 6,343ms（初計測
  = P2d --jobs 分割の基準値）**。IR 23,418,729B / C 5,593,546B / rust vs node parity=identical。
  JSON: build/bench_history/20260703T093859Z_selfcompile.json。
  （P0 検証実行の † 値より export -7% / emit-rust -9% / emit-node -17% — 負荷の影響幅の実例）
- **`gate full`: FULL PASS、所要 767s（12.8 分）** — conf 327/327 PASS、devirt/escape 327
  identical、native build ok、diffall/native-escape 327 identical、fixpoint ok。
- **`gate typed` / emit-native / エンジン比較全行: ミルストーン計測へ延期**（ユーザー決定:
  重い selfhost 系ベンチを毎回流すのは厳しい → 日常計測は軽量セットに切り替え）。

### 日常計測セット（毎セッション可・合計 ~90s・全て逐次 1 コア）

| 用途 | コマンド | 所要 |
|---|---|---|
| コンパイルステージ A/B | `scripts/bench_selfcompile.sh --src tests/conformance/exhaustive/classes/extends_same_name_scopes.ts --runs 5` | ~4s |
| GC/ランタイム | `scripts/bench_gc.sh` | ~19s |
| perf budget 回帰 | `scripts/gate.sh bench` | ~63s |

- `bench_selfcompile.sh` に **`--src <file.ts>` / `--label`** を追加（軽量計測モード）。
  初回計測（extends_same_name_scopes.ts・250 行級・runs=5 best）:
  **export 267ms / emit-rust 17ms / emit-node 68ms / cc 134ms**、IR 125,726B / C 103,237B /
  parity identical。小入力はプロセス起動が支配的なので**同一入力の前後差分でのみ判断**。
  既定（selfhost 入力）の無退行は runs=1 で確認済み（IR/C バイト・parity 従来値と一致）。
  注: conformance の一部（replaceAll 使用等）は単体 export だと lib 設定で型エラーになる —
  軽量入力に使うファイルは export が通るものを選ぶ。

### GC ベンチ拡充（P0 残の classics / escape-hardened、同日）

新 fixture 3 本（V8 差分 OK・スイートは 8 本になり全体 ~30s のまま）:

| bench | wall ms | minor | full | pause ms | max p ms | alloc MB | 特記 |
|---|---|---|---|---|---|---|---|
| gc_binarytrees | 116 | 16 | **4** | 1.59 | 3.92 | 111.0 | Boehm 系クラシック。survivors 以外で唯一 full GC を踏む |
| gc_cycles | 48 | 18 | 0 | 0.83 | 1.23 | 105.6 | 閉サイクルごみの回収（mark/sweep の対サイクル検証） |
| gc_escape_poly | 151 | 30 | 0 | 1.12 | 2.21 | 128.0 | 多相境界越えで escape/SROA に消されない alloc 圧の下限 |

- **ランタイムの実弱点を発見: `gc_scan_refs` は再帰マークで、深いポインタ鎖
  （~10^5 ノード級の一本鎖リスト）でスタックガードに激突して SIGSEGV** する
  （クラッシュレポートで確認: `gc_alloc → ts_gc_collect → gc_scan_refs` の深い再帰）。
  V8 の GC は任意深さのグラフを処理できるため意味論ギャップ（loud crash だが要修正）。
  **worklist 化（iterative marking）を P2a/P6 の課題に追加**。修正後は深鎖 fixture を
  ベンチ or conformance に昇格させる。

## 既知 parity DIFF リスト（miscompile 修正由来・単調増加を許容）

**ポリシー（ユーザー決定・2026-07-03/04・binding**）: rust 側で silent miscompile を修正すると
凍結 analyzer_ts（同一アルゴリズムの双子）と emit が恒久的に食い違う。**受容して本リストで管理**
し、凍結ソースは触らない。**再同期はミルストーン**（速度改善が貯まり、selfhost で「本当に効果が
あるか」を fixpoint/byte 一致込みで検証したくなった時点）で、蓄積修正の一括移植 or P4 parity 卒業
のどちらかを選ぶ。selfhost の**ベンチマークとしての役割は無傷**（凍結ソースを入力として
コンパイルする速度・生成 native の実行速度は今後も常に有効。修正後の garnet は凍結ソースを
以前より正しくコンパイルする）。

現在の期待値: **emitc parity = identical 325 / DIFF 5**（2026-07-04・s316 修正後）:

| プログラム | 由来 |
|---|---|
| classes_sroa_contained_escape（新規テスト） | 修正#1: 凍結側は contained ループ alloc を sobj スタック化 |
| classes_sroa_narrowed_nullable_reads（新規） | 修正#2a/2b |
| classes_sroa_try_body_uses（新規） | 修正#2c（+ 数値スカラ型の随伴差 long long↔double） |
| closures_forof_loop_capture | 修正#1: site 14 Stack→FrameArena（**注釈コメントのみの差**） |
| errors_super_assign_throws | 修正#1/#2 の随伴（要一行調査・害なしは conf 333 で確認済み） |

運用: gate parity / gate full の diffall・nescape 系は上記件数までは PASS 扱いとする
（ゲートスクリプトへの許容リスト実装は追作業。それまでは目視で件数一致を確認）。

## 計測ウィンドウで取るものリスト（チェックリスト）

ユーザーと時間枠を合意してから、負荷ゼロ状態で順に実行・追記する:

1. `nice -n 19 scripts/gate.sh gc`（完走・所要時間）
2. `nice -n 19 scripts/gate.sh bench`（全行 RESULT/TIME/BUDGET 表）
3. `nice -n 19 scripts/bench_selfcompile.sh`（--runs 3・cc 込み）
4. `nice -n 19 scripts/gate.sh full` → `nice -n 19 scripts/gate.sh typed`（所要時間）
5. typed 完走後: `scripts/bench_selfcompile.sh --native "$TMPDIR/typed_selfhost/tsan_typed"`
   （emit-native の単発計測 = KPI「~600s」の基準固定）
6. `scripts/run_engine_benchmarks.sh node`（全行。bun/deno はインストール後）
