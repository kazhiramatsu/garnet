# 世代別 moving GC 実装プラン（v1・2026-07-03 セッション316）

ユーザー決定: **GC を世代別 moving GC にする**。本書はその実装プラン。
master plan との関係: P6（bump nursery / lazy handle）の前倒し + P2a の GC 隣接項目を統合。
perf 判断の基準値は `docs/refactor_baseline.md`（2026-07-03 計測ウィンドウ）を使う。

## 0. 現状の正確な把握（ts_rt.c 実測・s316 時点）

すでにあるもの（§313 までの資産）:
- **世代分離**: young/old リスト + `TS_GEN_NONHEAP`（stack/SROA 直ポインタ）。
  閾値は**オブジェクト数**基準（young 65,536 / full 262,144・full 後に live×2 へ再設定）。
- **remembered set + write barrier**: `ts_write_barrier(owner, value)`（ts_rt.h:1139 インライン、
  old→young ストアで `ts_gc_remember`）。coro は保守的に毎 GC 再 remember。
- **minor moving は既定 ON**: 生存セルを malloc 新セルへ**浅い memcpy**（props/env 等の
  payload 配列はポインタごと移送）→ **handle 表を張り替え**（`gc_handle_move`）→ 旧セル free。
  tsv のビットパターンは handle id なので**参照の書き換えは一切不要**（この設計が moving の
  正しさを支えている）。pin（`pin_depth`）で移動不可を表現。動的 pin は現状
  `ts_coro_resume_v` の 1 箇所のみ。
- **精密ルート**: 明示 root スタック（`ts_gc_root(&local)` = tsv* を登録。address-taken に
  なるので opaque call 越しにコンパイラはメモリへ再ロードする）+ symbol 表 + async ルート。
- moving 耐性の conformance 群（moving_minor_relocation / generational_remembered_set /
  *_safepoints / MOVE_CORO・MOVE_PROMISE 強制フラグ）。

足りないもの（= 本プランの対象）:
1. **アロケータが calloc/セル + handle/セル + 連結リスト**。moving の旨味（バンプ確保）が無い。
   実測: gc_shortlived 3M alloc = 175ms、handle_alloc == alloc_count（全 alloc が handle 消費）。
2. **マークが再帰** → 深いポインタ鎖（10^5 級）で SIGSEGV（s316 発見・クラッシュレポート確認済み）。
3. 参照が全て handle 表間接（deref 毎に 1 段の依存ロード。`ts_heap_ptr` は ts_rt.h インライン）。
4. 閾値がバイトでなく個数基準（可変長セル、特に文字列で圧力を誤推定）。

補足（本プランの対象外だが隣接）:
- closure の `env_malloc`（4M 回/222ms）は **GC セルではなく ts_call の一時 scratch 配列**
  （ts_rt.c の ts_call: malloc→呼出→free）。P2a の「スタックバッファ化」で解決する別項目。
- Map/Set の O(n) 走査（probe 2,219）も P2a。ただし **オブジェクトキーのハッシュ設計は
  Phase C と干渉**する（§Phase C リスク参照）— アドレス由来ハッシュ禁止。

## 1. 目標アーキテクチャ

```
young = ①bump nursery（連続チャンク・小型 movable セル専用・確保=ポインタ加算）
        ②unpooled young（従来 malloc リスト: 大型セル・coro/promise・pin 想定種）
minor GC = worklist マーク → nursery 生存者を old へ評価コピー（既存 move 経路を流用）
           + unpooled young は従来どおり sweep → アリーナ一括リセット
old   = malloc セル・mark/sweep（非 moving のまま。compaction は Phase D でデータ駆動判断）
参照  = Phase C で handle 間接を全廃し直ポインタ + 退避時 Cheney 書き換えへ
```

段階は 4 つ。**A（安全基盤）→ B（bump nursery = 本丸）→ C（参照刷新）→ D（任意）**。
各フェーズは独立に着地し、いつでも止まれる（B まででも実利が出る構成）。

---

## Phase A — マークの worklist 化（挙動不変・クラッシュ修正）

**目的**: 再帰 `gc_scan_refs`/`gc_scan_young_refs` を明示スタックに置換。深鎖 SIGSEGV の修正。
B 以降の全フェーズが評価コピー中に同じ走査を使うため、最初にやる。

変更（ts_rt.c 内・~200 行）:
- 共有 growable スタック `g_markstack`（初期 8,192 エントリ・×2 成長・GC 間で再利用。
  成長失敗は loud に abort）。mark-on-push（push 時に mark を立てて重複 push を防ぐ）。
- per-kind のフィールド列挙を**単一イテレータに統合**し、full/minor は薄いラッパで共有
  （現在は gc_scan_refs / gc_scan_young_refs の二重実装 — 挙動不変のまま重複解消）。
- NONHEAP（stack/SROA）セルは現状 mark ガード無しで走査される。worklist 化に合わせて
  「push 時 mark + 訪問リストに記録 → GC 終了時に一括 mark クリア」を導入
  （NONHEAP は sweep リストに載らないので明示クリアが要る。理論上の stack-obj 循環と
  重複走査の両方を塞ぐ）。
- coro フレーム／async ルートの列挙は不変。

**新テスト**:
- `benchmarks/gc/gc_deep_chain.ts`: ~30 万ノードの一本鎖を構築→ minor GC を踏ませ→走査
  checksum。**現状は SIGSEGV する（= 修正の証明）**。修正後は bench 兼深マーク pause 指標。
- conformance（`exhaustive/gc/` 新設 or 既存カテゴリ）に ~15 万ノード版を追加（既定閾値で
  minor 1 回は必ず踏む）。**gate gc の FILTER には入れない**（threshold=1 だと二次関数的に
  遅くなるため。FILTER は明示リストなので勝手には入らない）。

**出口基準**: 深鎖 fixture が dt OK（現状 SIGSEGV→PASS）/ bench_gc ABAB で wall・pause 差が
ノイズ内 / gate gc O2 PASS / conf all 330 + bundler 39 / gate bench 99 予算内。

規模感: 1 セッション以内・単一コミット。

---

## Phase B — bump nursery（moving GC の性能化・本丸）

**状態 (s317)**: B-1（アリーナ+確保）/ B-2（評価コピー・pinned 退避・full 統一）実装・検証済み。
**B-3（バイト基準閾値）のみ未着手**（survivors の full 頻度最適化と合わせて次回）。
実測は下の出口基準表の「B 実測」列。

**目的**: young を連続アリーナ化し、確保 = ポインタ加算・解放 = アリーナ一括リセットにする。
死んだ短命オブジェクトのコストをゼロ近くへ（今は死ぬセルにも calloc+free+handle が掛かる）。

### B-1 アリーナと確保経路
- チャンク 256KB × N（`posix_memalign` で 256KB 整列 — Phase C のポインタ→チャンク逆引きと
  retained-chunk 管理の布石）。既定容量 4MB（現行 65,536 個 × 平均 64B ≒ 4.2MB と同等）。
  `TSAOT_GC_NURSERY_BYTES` で override。
- **`TSAOT_GC_YOUNG_THRESHOLD`（個数）は互換維持**: 設定時は「バイト枯渇 or 個数到達」の
  OR でトリガ（gate gc の threshold=1 ストレス意味論を保存する）。
- fast path（**単一予測分岐**の連なり・ホットパス規律）:
  小型（< 4KB）かつ movable-kind かつ coro/promise 以外 → bump 確保
  （`memset(cell,0,sz)` — 現行 calloc のゼロ初期化に依存するコードがあるため当面保持。
  `h->size` は必ず実サイズを格納 = アリーナ線形歩行に必要）。
- slow path: 大型セル（gc_strings の 500MB 級 inline 文字列など）と coro/promise は
  **unpooled young（従来 calloc + young リスト）** — 従来コードそのまま。
  大型を old 直行にしない理由: 今日の実測で大型短命文字列は minor で即回収されており
  （gc_strings minor=6/full=0）、old 直行にすると full まで滞留して RSS が悪化するため。
- handle は B では**従来どおり全セルに発行**（B = メモリ配置、C = 参照方式、と関心を分離）。

### B-2 minor GC（評価コピー）
- マーク（A の worklist）は不変。
- **アリーナ線形歩行**で生存判定: marked → 既存 `gc_move_young_to_old`（malloc+浅 memcpy+
  handle 張替え）を流用して old へ評価コピー / unmarked → `gc_free_cell` の payload 解放のみ
  （セル本体はアリーナのもの・free(h) しない）。unpooled young は従来ロジックそのまま。
- 走査後、全チャンクの bump をリセット（チャンクは保持して再利用・realloc churn 無し）。
- **pin 対応（防御経路）**: coro/promise を unpooled に隔離したので「アリーナ内 pinned」は
  現状構成では発生しない（動的 pin は coro resume のみ）。ただし防御として:
  pinned セルを含むチャンクは retained リストへ退避し、当該セルを「pinned young リスト」
  （gc_next を流用）で追跡 → 次回 minor で pin が解けていれば評価コピーしてチャンク解放。
  `RT_STATS` に `retained_chunks` カウンタ（**全ベンチで 0 のはず** — 0 でなければ設計前提が
  崩れたサイン）。
- **full GC の統一**: 現行 full は young 生存者をその場 gen-flip するが、アリーナセルは
  その場昇格できない（セル memory がチャンク内在で、old sweep の free(h) と非整合）。
  → **アリーナセルは full GC でも評価コピーで退去**（「アリーナのセルはコピーで出るか死ぬか」
  に一本化）。unpooled young は従来どおり gen-flip。

### B-3 バイト基準の閾値
- full トリガを個数から **live bytes 基準**へ（`alloc_bytes` 系の計上は RT_STATS に既にある。
  非 stats ビルドでも byte 計上だけは常設カウンタへ昇格）。再設定則は live×2 + 最低ヘッドルーム
  を踏襲。nursery は容量そのものが予算になる。

### 検証・出口基準
- correctness: gate gc O2（threshold=1 が**毎 alloc 評価コピー**を叩く最強ストレスになる）
  + MOVE_CORO/PROMISE/BOTH 行列 + conf all + bundler + gate full。
- perf（bench_gc ABAB・アイドルマシン。ts_rt.h 不変なので rt.o 差替えプロトコル有効）:

| 指標 | 現状 (s316) | B 出口目標 | **B 実測 (s317 ABAB・旧→新)** |
|---|---|---|---|
| gc_shortlived wall | 175ms | **≤ 100ms** | 160→**135ms (-15.6%)** 未達※ |
| gc_binarytrees wall | 116ms | ≤ 90ms | 107→**99ms (-7.5%)** 惜敗 |
| gc_escape_poly wall | 151ms | ≤ 110ms | 136→**118ms (-13.2%)** 惜敗 |
| gc_survivors max pause | 6.32ms | ≤ 6.5ms（非回帰） | 6.97ms（full GC のアリーナ評価コピー分。full 側は B-3 のバイト閾値で頻度を最適化予定） |
| gc_strings / gc_cycles / mapset | 1096 / 48 / 750ms | 非回帰（ノイズ内） | 1073/**25 (-29%)**/747ms ✓（+ closures 202→172・deep_chain 33→28） |
| gate bench | 99/99 予算内 | 99/99 維持（gc_churn 系 budget 100/160ms） | **99/99 PASS** ✓ |

※ **s317 実測の教訓**: bump 化後の shortlived 残コストは GC pause でなく（総 pause 28.65ms/136ms）
**ミューテータ側の per-alloc handle churn**（3M alloc = 3M handle_alloc、nursery 網羅率 100% でも残る）。
≤100ms は handle を全廃する **Phase C の出口へ繰り越し**（C 目標 ≤60ms は据え置き妥当）。
nursery 自体は設計どおり動作: 全ベンチ bump 網羅率 100%・retained_chunks=0（pin 退避経路は
JSON.parse 関数値呼び出し + threshold=1 の専用 probe で retained=1→回収まで実証済み）。

- **kill-switch**: `TSAOT_GC_NURSERY=0` で全種 unpooled（= 現行アロケータ）に落とす env を
  1 マイルストーン期間だけ持つ（単一予測分岐・ホットパス規律準拠）。selfhost ミルストーン
  green 後に撤去。
- ミルストーン（要ユーザー合意の計測ウィンドウ）: selfhost native emit の wall/RSS 比較。

規模感: ts_rt.c ~500 行・コミット 4 分割（alloc 経路 / 評価コピー / full 統一 / 閾値+stats）。
2〜4 セッション。

---

## Phase C — 参照方式の刷新（handle 間接の全廃）

**目的**: tsv を handle id から**直ポインタ**へ。deref = マスク+キャスト（表引き 1 段を除去）、
handle 発行コスト（今は全 alloc が負担）と handle 表自体を消す。ミューテータ速度の最大レバー。

**方式**: nursery 評価コピー時に **Cheney 式の参照書き換え**を行う。
- from セルのヘッダ（handle フィールドを転用）に forwarding pointer を残す。
- 参照に出会うたび: 未退避なら退避して書き換え / 退避済みなら forwarding 先へ書き換え。
- 書き換え対象 = rooted スロット（tsv* 経由で C ローカルも書き換わる — root 規律が
  そのまま可視性規律になる）+ 走査で辿る全セルフィールド + remset + coro フレーム +
  symbol/async 表。old は非 moving なので old への直ポインタは恒久安定 = handle 不要。
- 段階: **C0 監査+布石 → C1 直ポインタ切替（flag day）→ C2 handle 表撤去 → C3 ヘッダ縮小
  （handle u64 撤去で 32B→24B、identity hash に u32 転用）**。

**C0 で潰す前提（着手条件）**:
1. **ASan 復旧が必須**（CLT 更新 or homebrew 実 GCC。s316 発見の起動デッドロックが解けるまで
   C1 は凍結。**s318 再確認: CLT 17.0.0 のまま・`int main(){}` でも依然デッドロック**）。
   `TSAOT_GC_ZAP` は **s318 で導入済み**（moved-from/死亡セル本体を 0xDD 充填・env ゲート・
   GC コールドパスのみ。gate gc ZAP 行と最凶複合 probe（minor=1 × full 強制 × pin）green）。
   残: ZAP + threshold=1 での **conformance 全 fixture 完走**（C0 の root 漏れ在庫一掃・
   計測ウィンドウ級の時間が要るためユーザーと枠合意の上で）。
2. **P2a Map/Set ハッシュとの干渉**: オブジェクトキーのハッシュを**アドレス由来にしない**。
   **設計確定（s318）**: 単一 API `ts_obj_identity_hash(tsv)`（inline）に隠蔽し、P2a は
   これだけを使う。**格納値 = 生の一意 id**（分布はハッシュ表側で fibonacci mix
   `id * 2654435769u >> shift` を掛ける — 格納値を混ぜないことで id の由来を将来
   差し替え可能に保つ）。実体は段階で移行:
   - **B 期（今）**: handle id の下位 32bit（既に全セル一意・move で不変・追加コストゼロ）。
   - **C1 以降**: handle 撤去と同時に、C3 で空く旧 handle 領域の u32 へ **lazy 採番**
     （初参照時にグローバルカウンタから付与・0=未採番。moving はヘッダごと memcpy する
     ので自動追従）。切替は `ts_obj_identity_hash` の実装 1 箇所。
   - 禁止事項: アドレス由来（moving で壊れる）・handle を Map 実装が直接読む
     （C で消える）・格納値へのミックス済みハッシュ保存（表サイズ変更で再計算不能に
     なる形は不可、raw id 保存 + 使用時 mix に統一）。
3. **coro × setjmp/longjmp 監査**: yield 跨ぎの live 値はフレームセルへ spill されている
   （スキャン・書き換え可能）ことの emit 側確認。resume 区間内の allocating call を跨ぐ
   レジスタ内 tsv は root 規律の対象（今日は handle が免罪符になっている分、C では
   root 漏れ = 即 wild pointer。gate gc threshold=1 + ZAP + ASan の三段で炙る）。
4. root 漏れの既知クラス洗い出し: 今日の moving は「漏れても handle が生きていれば
   気づかない」— C 前に `TSAOT_GC_ZAP` + threshold=1 で全 conformance を完走させ、
   潜在漏れを先に摘む（これ自体が価値のある正しさ強化）。

**注意**: C1 は ts_rt.h のインライン（`ts_heap_ptr` 等）を変えるため、**rt.o 差替え ABAB は
不成立**。A/B は「同一生成 C を新旧ヘッダ+rt で各々フルビルド」で取る（fixture cc は
134ms、selfhost cc も 6.3s なので現実的）。env での新旧二重化はしない（二重実装禁止の精神。
切替はブランチ+ストレス行列で一発、戻しは revert）。

**出口基準**: handle_alloc = 0 / gc_shortlived **≤ 60ms** / obj_kernel 等 budget 余裕拡大 /
selfhost native emit で計測可能な改善 / 全ストレス行列（threshold=1 × MOVE 行列 × ZAP × ASan）
green。

規模感: 3〜6 セッション（C0 の監査が重い）。**B の実測を見てから正式 go/no-go**。

---

## Phase D — old 世代の後始末（任意・データ駆動）

- old compaction（mark-compact）は C の書き換え機構を general 化すれば可能だが、
  **RSS/断片化の実データが正当化するまでやらない**（mimalloc 併用が既に緩和策）。
- pause 制御（nursery 容量の適応化・incremental old marking）は selfhost native 級の
  実ワークロードで pause 目標超過が観測されてから。現状 max 7.4ms（10 万 live）は
  CLI AOT 用途では十分小さい。

---

## 横断プロトコル

- **コミット単位の検証**: 日常計測セット（compile A/B ~4s + bench_gc ~30s + gate bench 63s
  + gate gc O2）≒ 2 分。フェーズ末に gate full（767s）。重量系（selfhost native / typed /
  エンジン全行）は**ユーザーと合意した計測ウィンドウのみ**（低負荷 binding・s316）。
- **A/B は同条件 ABAB**（マシン負荷下の絶対値不可信の教訓）。B までは rt.o 差替え、C は
  フルビルド比較。
- 全フェーズ ts_rt.c 内で完結（emit/exporter 変更なし。例外は C0 の coro spill 監査のみ
  read-only で emit を見る）。P1 の emit_c.rs 分割と並走可能だが、**ts_rt.c を触る P2a 項目
  （Map/Set・intern・find_prop・env スタックバッファ）とはコミットを直列化**して衝突を避ける。
- 進捗は TODO.md 末尾へ、確定値は refactor_baseline.md へ追記（本書は判断が変わったら改訂）。

## リスク簿

| リスク | 影響 | 手当て |
|---|---|---|
| ASan 復旧が遅れる | C 着手不能 | A/B は O2 stress+ZAP で先行可。CLT 更新 or brew gcc を早期に試す |
| root 漏れの潜在在庫 | C で wild pointer 化 | C0 の ZAP+threshold=1 全 conformance 完走で先に摘む |
| calloc ゼロ初期化への隠れ依存 | B で未定義動作 | 当面 bump+memset で等価維持 → 後で kind 別に削る |
| アリーナ内 pin の想定外発生 | チャンク退避経路が動く | retained_chunks カウンタ=0 監視 + 防御実装は最初から入れる |
| P2a ハッシュがアドレス依存で設計される | C で Map 破壊 | identity hash を C0 で先に確定し P2a に供給 |
| 大型セルの滞留判断ミス | RSS 悪化 | 大型は unpooled young 維持（old 直行にしない）で現挙動保存 |

## 未決事項（ユーザー判断）

1. **着手順**: 推奨は A → B を連続で。P2a（Map ハッシュ等）を B の前に挟むかは好み
   （bench の mapset 760ms が目立つため先にやる価値はあるが、GC 方針が決まった今、
   A→B で moving の骨格を先に固める方を推奨）。
2. **CLT / Xcode 更新のタイミング**（C の前提。B までは不要）。
3. **B 完了時のミルストーン計測ウィンドウ**（selfhost native 比較・要時間枠合意）。

## 見積もり

| フェーズ | 規模 | 依存 |
|---|---|---|
| A worklist 化 | ~1 セッション | なし（今すぐ可） |
| B bump nursery | 2〜4 セッション | A |
| C 参照刷新 | 3〜6 セッション | B + ASan 復旧 + identity hash 設計 |
| D old 整理 | データ次第 | C（原則やらない前提で監視） |
