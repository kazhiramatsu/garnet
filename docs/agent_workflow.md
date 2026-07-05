# garnet — エージェント実務ガイド（build / 調査 / デバッグ / 検索 / テスト）

これを読めば「garnet でバグを一件潰して安全にコミットする」までの手が一通り分かる、という実務書。
方針・規律は [`CLAUDE.md`](../CLAUDE.md)、初回セットアップ手順は [`CLAUDE_CODE_HANDOFF.md`](../CLAUDE_CODE_HANDOFF.md)、
進捗の真の情報源は [`docs/TODO.md` の末尾](./TODO.md)。**まず TODO.md の tail を読む**のが全ての起点。

garnet は TypeScript → C の AOT コンパイラ。パイプライン:

```
  in.ts ──(exporter/ = TS)──▶ IR(JSON) ──(analyzer/ = Rust, bin名 tsaot)──▶ C ──(cc)──▶ native
                                          └ emit_c.rs が IR→C
  native は runtime/ts_rt.c（共有ランタイム, json_core.c を unity include）をリンク
```

- `exporter/` … TS→IR。フロントエンド唯一の実装（TypeScript）。cell/capture・スコープ解決・型駆動情報付与。
- `analyzer/` … Rust。**メイン実装**。escape/devirt/sroa/i64 解析 + `emit_c.rs`。cargo binary 名は `tsaot`。
- `analyzer_ts/` … 凍結された TS 版 analyzer（**変更禁止**）。役割は ①旗艦ベンチ ②byte-parity オラクル。
- `runtime/ts_rt.c` … NaN-boxing・オブジェクトモデル・GC・stdlib。**メイン開発対象**。

---

## 1. ビルド

3 つの成果物を個別にビルドできる（全部やるのは `scripts/setup.sh`）。**変更した層だけ**再ビルドすればよい。

```bash
# exporter（exporter.ts を変えたら。出力は exporter/exporter.js = .gitignore 済みの build 成果物）
cd exporter && ./node_modules/.bin/tsc exporter.ts class_extract.ts \
  --module commonjs --target es2020 --skipLibCheck --moduleResolution node --esModuleInterop
# analyzer（Rust。emit_c.rs 等を変えたら）
cd analyzer && cargo build --release          # → analyzer/target/release/tsaot
# runtime（ts_rt.c を変えたら。build/rt.o は多くのハーネスが使う共有キャッシュ）
gcc -O2 -c runtime/ts_rt.c -Iruntime -o build/rt.o
```

### garnet ドライバ（1 プログラムを手でコンパイル）

```bash
./garnet foo.ts            # foo.c を emit して native `foo` にビルド
./garnet -o foo.c foo.ts   # 出力 C 名を指定（★ -o は必ず .c で終える。実行ファイルは .c を除いた名前）
./garnet -c foo.ts         # C だけ emit（cc しない）
./garnet -S foo.ts         # C を stdout へ
```

主要 env: `TSAOT_UNTYPED=1`（全 any = 型駆動最適化 OFF・正しい JS 意味論だが遅い。ill-typed 入力の検証に必須）、
`TSAOT_CC="gcc -O2"`（既定 `cc -O2`）、`TSAOT_ANALYZER=rust|ts|native`、`--rt-stats`（下記）、`--profile`。

> ★ **落とし穴**: `./garnet -o out out.ts`（.c なし）は out を object として ld に渡し「unknown file type」で失敗する。
> 必ず `-o out.c` にして `./out` を実行する。

---

## 2. 中心の作業ループ = V8 差分テスト

garnet の規律は **「V8(=node) と出力を比較してバグを 1 件ずつ潰す」**。決まった型は次の通り。

### 2.1 オラクルの作り方（node = V8）

garnet は `module: ESNext` で吐くので、オラクルも **ESM(.mjs) にして strict 意味論を揃える**（sloppy 差を出さない）。

```bash
# in.ts を V8 で実行した結果（= 期待値）
node -e '
  const ts=require("./exporter/node_modules/typescript"),fs=require("fs");
  const js=ts.transpileModule(fs.readFileSync("in.ts","utf8"),
    {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  fs.writeFileSync("in.mjs",js);'
node in.mjs
```

既製の差分ハーネスもある（`scripts/difftest.sh` を source して `dt "name" 'function main(){...}main();'`）。
ただし **★ zsh から bash 前提スクリプトを source すると `$CC` の word-splitting 差で古いバイナリを実行し続ける事故**が起きる
（CLAUDE.md 教訓）。**プローブは必ず bash ファイルに切り出して `bash probe.sh` で回す**こと。

### 2.2 バグ探し（差分ハント）のプローブ雛形

多カテゴリを一気に node と比較して DIFF 行だけ拾う。`bash` ファイルで:

```bash
#!/usr/bin/env bash
ROOT=/Users/hiramatsu/dev/garnet; W=/tmp/hunt; mkdir -p "$W"
run(){ echo "$2" > "$W/t.ts"
  node -e 'const ts=require("'"$ROOT"'/exporter/node_modules/typescript"),fs=require("fs");
    fs.writeFileSync("'"$W"'/t.mjs",ts.transpileModule(fs.readFileSync("'"$W"'/t.ts","utf8"),
    {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);'
  local no=$(node "$W/t.mjs" 2>&1|tr '\n' '|')
  "$ROOT/garnet" -o "$W/t.c" "$W/t.ts" >/dev/null 2>&1 || { printf "%-20s BUILDFAIL\n" "$1"; return; }
  local ao=$("$W/t" 2>&1|tr '\n' '|')
  [ "$no" = "$ao" ] || printf "*** %-16s node=[%s] aot=[%s]\n" "$1" "$no" "$ao"
}
run "toFixed -0" 'console.log((-0).toFixed(2));'
run "ws eq"       'const x:any="\t"; console.log(x==0);'   # 型エラー回避に any / TSAOT_UNTYPED=1
# ... 40〜50 ケース並べる
```

判定のコツ:
- **REJECT / BUILDFAIL は多くが非バグ**: ①ill-typed TS（`0==""`, `[]+{}` 等は strict TS で型エラー→ garnet は loud に refuse。
  意味論を試すには `TSAOT_UNTYPED=1`）②未実装 stdlib は "UNSUPPORTED"（loud reject = 健全。silent miscompile ではない）
  ③TS lib target 由来（`toSorted` は es2023）。
- **良性 DIFF に注意**: 例外の出力差（node は ESM の verbose stack、garnet は 1 行）や、`-0` の inspect 表示など。
  **挙動が同じか**を見る（両者とも throw / 同じ数値）。

---

## 3. デバッグ手順（クラッシュ・誤値）

原則: **理論より計測**。最小再現 → メカニズムを掴む probe。

1. **最小化**: 反復数 N を振る（N=0/1/2…）、機能を1つずつ削る（capture を外す/ escape を止める）。
   「手展開は通るがループだと落ちる」等の**境界**を掴む。
2. **env ノブで切り分け**（挙動を変えて症状の相関を見る＝症状数 = メカニズム回数の相関が決定打）:
   - `TSAOT_GC_YOUNG_THRESHOLD=1` … 毎 alloc で minor GC（moving を最強ストレス）
   - `TSAOT_DISABLE_MOVING_MINOR=1` … minor moving を止める（moving 起因か切り分け）
   - `TSAOT_GC_MOVE_CORO=0` / `TSAOT_GC_MOVE_PROMISE=1` … coro/promise の移動可否
   - `TSAOT_GC_AGE_THRESHOLD=2` … aging（昇格猶予）を入れて move 回数を変える
   - `TSAOT_GC_ZAP=1` … 死亡/moved-from セルを 0xDD 毒化（use-after-free 検出。**綺麗な undefined/全ゼロ
     = 未 mark 死亡 + 領域再利用のシグネチャ**、0xDD = moved-from 読み）
   - `TSAOT_GC_NURSERY=0` … bump nursery を切る
   - `TSAOT_UNTYPED=1` … 型駆動最適化(SROA/unbox)が原因か切り分け
3. **バックトレース**（クラッシュが一瞬なら軽い）:
   ```bash
   cat > /tmp/bt.lldb <<EOF
   settings set target.input-path /tmp/input     # stdin 入力の場合
   run
   bt 16
   quit
   EOF
   ( ulimit -s 65520; lldb -b -s /tmp/bt.lldb ./binary ) | grep -E "frame #|stop reason"
   ```
   selfhost native 等スタックが深いものは `ulimit -s 65520`。
4. **ASan**: `gcc -O1 -g -fsanitize=address -DTS_ASAN_ENABLED ...`。**★ ただし ASan 限定のガード
   （`ts_heap_ptr` の可読性 probe 等）が非 ASan 本番のバグを隠すことがある**（C1 の教訓）。非 ASan でも再現するか必ず確認。
5. **ランタイム計測 `--rt-stats`**（`-DTSAOT_RT_STATS`）: GC 回数/pause、alloc、handle_alloc、find_prop/intern/map_find
   のプローブ長ヒスト、call_env_malloc、concat を stderr（`TSAOT_RT_STATS_FILE=path` でファイル）へ。
   perf 判断は「avg でなく分布(hist)とワークロード依存性」で見る。
6. **ランタイムに一時計装**: `runtime/ts_rt.c` を `/tmp` にコピー → `fprintf(stderr,...); fflush(stderr);` を挿して
   `gcc -O2 -c copy.c -o rt_dbg.o` → 生成 C とリンク。cell の kind / スロット値 / 昇格・退避の時系列を追う。
   **stderr は fflush 必須**（クラッシュ前フラッシュされずロストする）。
7. **生成 C を読む**: `./garnet -c -o /tmp/x.c x.ts` して `awk '/static tsv fn_0_main/,/^}/' /tmp/x.c`。
   FrameArena/Stack/Heap の alloc site 注釈、cell の AllocObject 位置、ts_call の env 等が見える。

---

## 4. プロジェクト検索マップ（どこに何があるか）

| 探すもの | 場所 / grep |
|---|---|
| いま何をしているか・直近の決定 | `docs/TODO.md` の**末尾**（セッション番号順・唯一の真） |
| 機能別の設計意図 | `docs/*_design.md`（classes / generators / exceptions / async / capture_lowering …） |
| GC 全体計画・現在地 | `docs/gc_moving_plan.md`、Rust 移行計画 `docs/refactor_master_plan.md` |
| ランタイム実装（stdlib / GC / boxing） | `runtime/ts_rt.c`（440KB・1 ファイル）、`runtime/ts_rt.h`（型・inline・NaN-box マクロ） |
| ある JS API の実装 | `grep -nE "ts_<name>\|\"<method>\"" runtime/ts_rt.c` |
| 数値/文字列/coercion の変換 | `ts_number_coerce` / `ts_to_num`(生ビット再解釈) / `ts_str_*` / `ts_math_*2` |
| IR→C の emit | `analyzer/src/emit_c.rs`、alloc 戦略は `analyzer/src/codegen.rs`(`decide`) |
| exporter のスコープ/capture | `exporter/exporter.ts`（`cellBindings` / `cellAccess` / `captureLoopBody` / `setupForOfCaptureCells`） |
| conformance テスト | `tests/conformance/exhaustive/<category>/*.ts`（V8 オラクル・別 expected 不要） |
| 実行/ゲートのスクリプト | `scripts/*.sh`（一枚扉は `scripts/gate.sh`） |

`ts.Symbol` キーイング + checker の alias 解決で module linking がほぼ無料、という whole-program 前提を頭に置く。

---

## 5. バグを潰した後のテスト（変更種別で必要ゲートが変わる）

まず**変更の種別**を判定する。これで必要な検証が決まる:

| 種別 | 例 | 生成 C | 必要ゲート |
|---|---|---|---|
| **A. ランタイムのみ** | `ts_rt.c` の挙動修正 | **不変** | conf + unit + gc（+ 影響あれば bench）。**parity 無関係**（emitc_diff は生成 C 比較なので） |
| **B. exporter / 出力変更** | IR/生成 C が変わる修正 | 変わる | conf + bundler + selfconf + **emitc_diff**（凍結双子と食い違えば allowlist へ） |
| **C. 挙動不変 Rust リファクタ** | emit_c.rs の非機能変更 | byte 不変が狙い | **emitc_diff で byte-parity** が主。conf/unit も |

コマンド（一枚扉 `scripts/gate.sh <cmd>`）:

```bash
scripts/gate.sh conf all      # 全 conformance（V8 差分）★主ゲート
scripts/gate.sh unit          # runtime 単体 + analyzer 単体
scripts/gate.sh gc            # GC ストレス（threshold=1 × O2/ASan/runtime）
scripts/gate.sh bundler       # モジュールバンドル 39 fixture
scripts/gate.sh bench [flt]   # 99 ベンチの correctness + 時間 budget
scripts/gate.sh selfconf      # 凍結双子の V8 差分
scripts/gate.sh parity        # = scripts/emitc_diff.sh（Rust emit vs 凍結TS emitc の byte）
scripts/gate.sh ir-parity     # exporter 出力の決定性（snap 比較）
```

**新機能/修正には conformance に最小テストを追加**する（`tests/conformance/exhaustive/<cat>/xxx.ts` を置くだけ。
V8 がオラクルなので expected ファイル不要。ただし**既定は typed** = ill-typed だと REJECT されるので、
loose coercion 等は `any` を使って typed-valid にするか別枠で）。

### emitc_diff で凍結双子と食い違ったら

exporter/analyzer 変更で新しい IR/最適化パターンが出ると、**凍結された `analyzer_ts` と Rust が食い違う**ことがある。
- **両方が正しい出力**（V8 一致）で差が alloc 戦略名（Stack↔FrameArena 等・挙動同一）なら → **良性**。
  `scripts/frozen_known_diffs.tsv` に `parity\t<category>/<slug>\t<理由>` 行を追加して allowlist（DIFF→KNOWN）。
- 凍結が誤値を出すなら → 凍結は変更禁止なので同様に allowlist（Rust が production・正）で記録。

### 完了基準（CLAUDE.md）

**conformance 全緑 + unit + bench(perf budget) + bundler 全緑**、加えて GC を触れば gate gc、exporter を触れば selfconf/emitc_diff。
**perf 回帰ゼロ**（ホットパスに分岐を足すなら単一予測分岐で gate）。

---

## 6. コミット

- **メッセージは英語**（ユーザー指示）。本文は「何を・なぜ」＋末尾に `Verified:` 行（回した全ゲートの結果）。
  silent miscompile 修正には `Lesson:` 段を付けることも。
- **main への直線コミット**運用（単独プロジェクト・履歴が全て main）。**ユーザーが「commit して」と言うまでコミットしない**。
- コード内部識別子・cargo binary 名は今も `tsaot`（改名は blast radius 大で保留中）。明示指示なく一括置換しない。
- 進捗は**必ず `docs/TODO.md` 末尾に追記**（メモリには進捗を入れない）。

---

## 7. ハマりどころ（hard-won・毎回刺さる）

- **zsh vs bash**: bash 前提の関数（`dt` 等）を zsh から source しない。プローブは bash ファイルに切り出す。
- **`garnet -o` は `.c` 必須**（§1）。
- **ASan 限定ガードは非 ASan 本番のバグを隠す**。非 ASan の大入力でも必ず確認（C1 のクラッシュはこれで露見）。
- **selfhost ミルストーンは規模依存 UB の唯一の網**: 小入力の conformance が全緑でも、66k 命令の selfhost で初めて落ちる
  バグがある（`scripts/bench_selfcompile.sh` の emit-native は数百秒＝重い。**要時間枠合意**）。
- **重いゲート/ベンチはバックグラウンド放置しない**: 前面 + watchdog（stuck した fixture バイナリを etime×cpu で検出して kill）。
  マシン負荷下の絶対値は不可信 → **A/B は同一入力の交互実行(ABAB)**、rt.o 差替え or フルビルド比較で。
- **-0（負ゼロ）**: `< 0` 判定（-0 は非負扱い）と符号ビット判定で挙動が分岐する。`%f`/printf は -0 を "-0" と印字するので
  絶対値経路は `fabs` を通す。
- **cell / capture**: ループ変数を closure がキャプチャするとき、変数書き込みは capture cell 経由（StoreField VALUE）。
  ループ**本体**宣言の captured `const`/`let` は反復ごとに fresh cell（`emitPerIterationBodyCells`）。
- **型駆動最適化(unbox/SROA)は値を落としやすい**。`never`/conditional 型・per-body 処理に注意し安全側へ。
- **METHOD キー vs FIELD キーの名前空間ミスマッチ**が silent-DIFF の常連。二重格納は全ミューテーション操作で対称に。

---

## 8. 30 秒サマリ（最短の一件潰し）

1. `docs/TODO.md` の tail を読む。
2. bash プローブで node(V8) と garnet 出力を比較 → DIFF を最小再現。
3. `runtime/ts_rt.c` か `exporter/exporter.ts` を狙い撃ち修正（生成 C / lldb / RT_STATS / 一時計装で確認）。
4. `tests/conformance/exhaustive/…` に回帰テスト追加。
5. 変更種別に応じ `scripts/gate.sh conf all` + unit (+ gc / bundler / selfconf / emitc_diff)。
6. `docs/TODO.md` 末尾にセッション追記。ユーザーの指示でコミット（英語・`Verified:` 行）。
