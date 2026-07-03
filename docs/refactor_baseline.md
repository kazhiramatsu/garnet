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

## 計測ウィンドウで取るものリスト（チェックリスト）

ユーザーと時間枠を合意してから、負荷ゼロ状態で順に実行・追記する:

1. `nice -n 19 scripts/gate.sh gc`（完走・所要時間）
2. `nice -n 19 scripts/gate.sh bench`（全行 RESULT/TIME/BUDGET 表）
3. `nice -n 19 scripts/bench_selfcompile.sh`（--runs 3・cc 込み）
4. `nice -n 19 scripts/gate.sh full` → `nice -n 19 scripts/gate.sh typed`（所要時間）
5. typed 完走後: `scripts/bench_selfcompile.sh --native "$TMPDIR/typed_selfhost/tsan_typed"`
   （emit-native の単発計測 = KPI「~600s」の基準固定）
6. `scripts/run_engine_benchmarks.sh node`（全行。bun/deno はインストール後）
