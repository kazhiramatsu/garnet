# tsaot — V8差分コンフォーマンス作業の引き継ぎ（Claude Code 用）

あなたは **tsaot**（TypeScript → C の AOT コンパイラ。TypeScript で書かれ、自己ホスティングを目標）の
コンフォーマンス改善を継続します。日本語ユーザー Kaz のプロジェクトです。**応答は日本語で**。

このドキュメントだけ読めば即作業開始できます。まず「セットアップ」を実行し、規律を理解し、
ワークフローに従って V8 差分で見つかったバグを 1 件ずつ潰してください。

> **このリポジトリは zip から展開された自己完結チェックアウトです。** すべてのコマンドは
> **リポジトリのルート（この `CLAUDE_CODE_HANDOFF.md` がある場所）からの相対パス**で動きます。
> 絶対パス（`/home/claude` や `/tmp` など）には依存しません。以下では、ルートを指す場合は `$ROOT`、
> シェルでは「ルートに `cd` してから」を前提にします。

---

## 0. セットアップ（最初に必ず実行）

リポジトリのルートで一度だけ:

```bash
bash scripts/setup.sh
```

これが以下を全部やります（すべて repo 相対）:
1. `exporter/` で `npm install`（typescript を取得。`registry.npmjs.org` への通信が必要）
2. exporter ビルド（`tsc` → `exporter/exporter.js`）
3. analyzer ビルド（`cargo build --release` → `analyzer/target/release/tsaot`）
4. ランタイム precompile（`gcc -c runtime/ts_rt.c` → `build/rt.o`）

> `npm install` が失敗する場合はネットワーク設定で `registry.npmjs.org` が許可されているか確認。

> **macOS について**: スクリプト群は **macOS（bash 3.2 / BSD date）でも動く**ように書かれています
> （`mapfile`・`declare -A`・`date +%s%3N` は使っていません）。Linux と同じく `bash scripts/setup.sh`
> で立ち上がります。バッチ全体タイムアウトを使う `run_tsc_conformance.sh` だけ `gtimeout`（coreutils）
> があると便利ですが、無くても動きます（タイムアウトしないだけ）。macOS の `gcc` は Apple clang の
> エイリアスでそのまま使えます。Python 3 が `now_ms` のミリ秒計測に使われます（無ければ perl /
> gdate / date / 秒精度の順にフォールバック）。

サニティチェック:
```bash
bash scripts/run_conformance.sh exhaustive | tail -1   # 期待: PASS=88 FAIL=0 / 88
```

### 個別ビルド（編集後の再ビルド。setup.sh の中身と同じ）
- **exporter 編集後**:
  ```bash
  (cd exporter && ./node_modules/.bin/tsc exporter.ts class_extract.ts \
     --module commonjs --target es2020 --skipLibCheck --moduleResolution node --esModuleInterop)
  ```
  ※ この tsc フラグは正確にこの通り（`--skipLibCheck --moduleResolution node --esModuleInterop` 必須）。
- **analyzer 編集後**: `(cd analyzer && cargo build --release 2>&1 | grep -E "^error")`
- **runtime 編集後**: `gcc -O2 -c runtime/ts_rt.c -Iruntime -o build/rt.o`（**毎回 build/rt.o を作り直す**）

---

## 1. パイプライン全体像

```
TS ソース
  → exporter（npm の typescript API を使用、exporter.ts）
  → Escape IR JSON
  → Rust アナライザ（devirt → escape → SROA → monomorphization → codegen、emit_c.rs）
  → C コード（NaN-boxing ランタイム ts_rt.c とリンク）
  → gcc → ネイティブ実行ファイル
```

**3つの編集対象:**
- `exporter/exporter.ts` — TS AST → IR の lowering（TypeScript で記述）
- `analyzer/src/*.rs` — IR 最適化と C 生成（`emit_c.rs` `sroa.rs` `devirt.rs` `escape_ir.rs` が主）
- `runtime/ts_rt.c` / `runtime/ts_rt.h` — C ランタイム（組み込み関数の実体）

**単一ファイルのコンパイル＆実行（デバッグの基本。すべて repo 相対）:**
```bash
cd "$ROOT"                                                       # ルートに居ること（mkdir -p build しておく）
echo 'function main(){console.log([1,2,3].reduce((a,b)=>a*b));}main();' > build/t.ts
node exporter/exporter.js build/t.ts build/t.json build/tl.json  # TS → IR JSON（UNSUPPORTED が出たら exporter が reject）
analyzer/target/release/tsaot build/t.json emit > build/t.c      # IR JSON → C
gcc -O2 build/t.c build/rt.o -Iruntime -lm -lcurl -o build/t     # C → 実行ファイル
./build/t                                                        # 実行（直接！サブシェルに入れない）
```

IR の中身を見たいとき:
```bash
python3 -c "import json;d=json.load(open('build/t.json'));[print(i) for f in d['functions'] for i in f.get('body',[])]"
```

---

## 2. 規律（厳守。Kaz はここに非常に厳しい）

1. **黙って間違えるな（loud-reject over silent-miscompile）**。未対応機能は `this.unsupported(node, "理由")`
   で明示的に reject させる。**最悪なのは間違った結果を黙って出すこと（silent miscompile）**。差分で
   `DIFF`（誤った値）が出たら最優先。`REJECT` は次点。

2. **コードを読んでから直す。推測で書かない**。該当する lowering / codegen / runtime を grep して実際の
   挙動を確認してから設計する。

3. **正しさ優先、ただし hot path の perf は守る**。数値・整数の高速経路（unboxed double / long long）を
   壊さない。強制変換などのロジックを足すときも、両 unboxed の fast path は温存する。

4. **影響範囲の大きい変更（SROA/devirt/escape など中核最適化）は特に慎重に**。保守的に倒す
   （例: 動的ディスパッチ先のレシーバは escape 扱いにする）のは安全側として許容。

5. **正直に**。「実装した」「正直に reject した」「別の既存バグ」を区別して報告する。スコープ外でも
   露見したバグは正直に flag する。

6. **各修正の後、必ず full CI を通してから次へ**（手順は §5）。CI が通る前に次のバグに進まない。

7. **マイルストーンごとに docs 記録**（§6）。記録せずに次に進むと作業が失われる。

---

## 3. 差分ハーネス（バグ発見の主力ツール）

`scripts/difftest.sh` が tsaot の出力と node（typescript で TS を JS にしてから eval）の出力を突き合わせる。
**repo 相対で動く**ので、ルートに `cd` してから `source` するだけ:

```bash
cd "$ROOT"
mkdir -p build
cat > build/r.sh <<'SH'
#!/bin/bash
source scripts/difftest.sh        # ROOT を自動検出し、build/noderun.js を生成し、dt() を定義
dt "test name"  'function main(){ ... }main();'
dt "another"    'function main(){ ... }main();'
SH
bash build/r.sh
```

注意点:
- シェルは sh のことがあるので、`source` を**インラインで使わず必ず `bash build/r.sh` 経由**で。
- `difftest.sh` は `exporter/node_modules`, `exporter/exporter.js`, `analyzer/target/release/tsaot`,
  `build/rt.o` が揃っている前提（無ければ `bash scripts/setup.sh`）。
- **runtime を編集したら必ず `gcc -O2 -c runtime/ts_rt.c -Iruntime -o build/rt.o` で作り直す。**
  exporter 編集後は tsc 再ビルド、analyzer 編集後は cargo 再ビルド（§0）。

判定: `OK`=一致 / `DIFF`=誤った値（最優先で修正）/ `REJECT`=未対応（exporter が明示的に拒否）。

---

## 4. ワークフロー（1バグあたり）

1. **探索**: あるカテゴリ（§7「探索候補」参照）について `dt` を 5〜15 個書いて流す。`DIFF`/`REJECT` を探す。
2. **再現を最小化**: 失敗ケースを単一 .ts に落とし、`build/t.json` の IR と `build/t.c` の生成コードを見て
   **どの段（exporter / analyzer / runtime）が原因か**を特定する。推測しない。
3. **設計**: 原因の段の該当コードを読み、最小で正しい修正を考える。hot path を壊さないか確認。
4. **実装 → 再ビルド → `dt` で V8 一致を確認**（関連ケースも複数）。
5. **full CI gate**（§5）。緑になるまで次に進まない。stale な negative test が落ちたら更新する
   （実装した機能を今も reject するテストは現状に合わせる）。
6. **conformance テスト追加**（§6）。
7. **docs 記録**（§6）。

---

## 5. full CI gate（各修正の後、必ず全部通す。すべて repo 相対）

**推奨: 並列ドライバ 1 本で全ゲート（約 2x 速い, ~40s warm）。**
```bash
cd "$ROOT"
bash scripts/ci_par.sh        # exit 0 = 全緑。ビルド1回→正しさ系を並列→perfは単独計測。サマリ表示。
```

従来の逐次版（個別に確認したいとき）:
```bash
cd "$ROOT"
gcc -O2 -c runtime/ts_rt.c -Iruntime -o build/rt.o 2>&1 | grep -i error   # ランタイム編集時
bash scripts/run_conformance.sh basic        | tail -1   # PASS=3 FAIL=0 / 3
bash scripts/run_conformance.sh exhaustive   | tail -1   # PASS=88（+追加分）FAIL=0
bash scripts/ci_fast.sh                       | tail -1   # CI-FAST PASSED
bash scripts/run_unit_tests.sh                | tail -1   # [unit] all unit-test suites passed
bash scripts/ci_bench_correct1.sh             | tail -1   # CI-BENCH-CORRECT-1 PASSED
bash scripts/ci_bench_correct2.sh             | tail -1   # CI-BENCH-CORRECT-2 PASSED
bash scripts/ci_bench_perf.sh                 | grep -E "all benchmarks|FAIL"
```

> CI スクリプトは内部で自分のルートを検出し、`exporter/node_modules/.bin/tsc` を repo 相対で使う。
> bench はランタイムをリンクするので `build/rt.o` を用意しておくこと。

**perf 予算（超えたら回帰。budget は右の数字）:**
| kernel | 目安(ms) | budget |
|---|---|---|
| int_kernel | ~382 | 520 |
| float_kernel | ~252 | 480 |
| obj_kernel | ~203 | 290 |
| generic_kernel | ~198 | 260 |
| generic_fn_kernel | ~382 | 520 |
| typed_field_kernel | ~188 | 240 |
| inherit_sroa_kernel | ~81 | 130 |

**重要な落とし穴:**
- **CI は stdout のみ比較し、exit code は見ない**。`$(... 2>&1)` のサブシェルで実行すると `$?` が誤解を招く。
  **実行ファイルは直接実行して確認すること**（例: `./build/t`）。
- nproc=1。bench は時間がかかるので `timeout 260 bash scripts/ci_bench_perf.sh` を付けてよい。

---

## 6. 記録（マイルストーンごと）

1. **conformance テスト追加**: `tests/conformance/exhaustive/<category>/<name>.ts` に置く。
   各 `console.log` の右にコメントで期待値を書く。`bash scripts/run_conformance.sh exhaustive` の
   ハーネスが node と自動で突き合わせるので、PASS 数が増えれば V8 一致が取れた証拠。
   既存カテゴリ: arrays, classes, closures, coercion, control, errors, generics, hoisting,
   iteration, maps_sets, numbers, object_methods, objects, operators, private, statics, stdlib,
   strings, symbol, toplevel など。

2. **docs 記録**: `docs/conformance_fixes.md`（セッション単位で番号付きに追記。過去 23 項目あり）と
   `docs/TODO.md`（1行サマリを追記）。原因・修正・検証・perf 影響を簡潔に。

> このチェックアウトは zip 展開物なので、成果は git commit するか、Kaz に渡すために
> ディレクトリごと再 zip してください（`node_modules` と `target` と `build` は除外推奨）:
> ```bash
> cd "$(dirname "$ROOT")"
> zip -rq tsaot.zip "$(basename "$ROOT")" \
>   -x '*/exporter/node_modules/*' -x '*/analyzer/target/*' -x '*/build/*' -x '*/.git/*'
> ```

---

## 7. すぐ着手できる既知のバグ・探索候補

### 既知バグ（未修正、すぐ直せる）
- **optional chaining on `any` レシーバ**: `const o:any={f:()=>9}; o.g?.()` が
  「method is not a function」で abort（node は undefined）。`o.f?.()`（存在する側）は OK。
  any-typed レシーバの optional call で、メソッド非存在時に undefined を返すべき。

### 既知の限界（silent miscompile ではない。優先度低、触るなら設計から）
- `-0` 表現: 整数 unbox 経路が 0 の符号を落とす（`Object.is(-0,0)`→true, `console.log(-0)`→0）。
  修正には整数ゼロの hot path を deopt する必要があり、コスト>便益。
- `e instanceof Error`: builtin Error をコンストラクタ値としてモデル化していない（loud-reject）。
- 多段ラベル付き break/continue: multi-level jump 未モデル化（loud-reject）。

### 探索候補（`dt` を流してまだ見ていない隅を洗う）
- async/await の深掘り（Promise.all、async メソッド、エラー伝播、await 連鎖）
- tagged template literal（現状 reject。`` tag`a${1}b` ``）
- ジェネレータの応用（yield*、generator.return()/throw()、双方向 yield）
- 文字列メソッドの隅（matchAll, replace with regex, normalize, localeCompare, codePointAt）
- 正規表現（未対応なら reject か実装か設計判断）
- Date メソッド（現状 getTime/valueOf のみ）、JSON の replacer/reviver/space
- 数値の隅（BigInt、Number の各種境界、`toString(radix)` の全 radix、指数表記の細部）
- 分割代入のさらなる隅（ネスト＋デフォルト＋rest の組み合わせ、関数引数での分割）
- getter/setter の継承・override、static getter/setter、computed メソッド名
- スプレッドの隅（関数呼び出しでの `f(...a, x, ...b)`、object spread の上書き順）

各カテゴリで `dt` を 10 個ほど書いて流すのが効率的。`DIFF` が出たら最小化 → 段の特定 → 修正の順で。

---

## 8. コードの地図（よく触る場所）

**exporter/exporter.ts:**
- `lowerExpr` — 式の lowering の入口
- `lowerStmt` — 文の lowering（for-of は `isForOfStatement` 分岐、`lowerArrayIndexForOf` ヘルパ）
- `lowerAssignTarget` — 代入ターゲット（identifier/property/element/分割代入パターン）
- `lowerFunctionLike` — 関数本体・パラメータ（デフォルト引数、arrowThis cell）
- `lowerClosure` — クロージャ生成（arrowThis 捕捉）
- `builtinReceiverKind` / `namespaceBuiltin` — string/array/map/set/number/Object/Math/JSON 等の組み込み判定
- `arrayMethods` / `mapMethods` / `setMethods` の allowlist（メソッド追加時はここと emit_c の両方）
- NewExpression 分岐（Map/Set/Date/Error/ユーザクラス）
- `this.unsupported(node, "理由")` で loud-reject

**analyzer/src/:**
- `emit_c.rs` — C 生成。`CallBuiltin`/`CallBuiltinStatic` の文字列→C 関数マッピング。BinOp の強制変換ルーティング。整数 unbox 分類。
- `sroa.rs` — スカラ置換とインライン。`find_sroa_targets`（escape する受け手を disqualify）、`captures_this`、`inline_callee`。
- `devirt.rs` — 仮想ディスパッチ解決（Direct / 動的 Method / Unknown）。
- `escape_ir.rs` — IR の型定義（Inst の variant、CalleeRef）。

**runtime/ts_rt.c / ts_rt.h:**
- 組み込み関数の実体（`ts_array_*`, `ts_map_*`, `ts_set_*`, `ts_string_*`, `ts_math_*`, `ts_to_*`,
  `ts_object_is`, `ts_relational`, `ts_loose_eq` など）。新関数は .c に実体、.h にプロトタイプ。

---

## 9. これまでの実績（参考。docs/conformance_fixes.md に全 23 項目の詳細）

Symbol 3段階・ToPrimitive・private accessor → 数値フォーマット/強制変換/parseInt hex →
reduce 初期値なし/デフォルト引数/アロー this 捕捉 → spread・Map/Set seeding・for-of・array.entries →
分割代入/複合代入/論理代入/Object.is → ポリモーフィック仮想ディスパッチ/super/配列エスケープ →
Error/サブクラス/nested try → Math.cbrt 精度/Array.fill 範囲。現在 conformance 88/88、全 CI 緑。

---

頑張ってください。**まず `bash scripts/setup.sh` を実行し、§7 の探索候補から `dt` を流し始める**のが
最速の立ち上がりです。1件直すごとに §5 → §6 を回してください。日本語で報告を。
