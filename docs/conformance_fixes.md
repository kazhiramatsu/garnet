# Conformance 網羅テストで洗い出したバグと修正

V8 差分テスト（/tmp/dt.sh: TS→tsaot 実行 vs typescript transpile→node 実行を突き合わせ）で
言語機能の隅を網羅的に検査し、以下の実バグを発見・修正した。各修正後に full CI 緑・perf 中立を確認。

## セッション 1（数値・演算子・強制変換）

1. **大整数リテラルの int64 オーバーフロー**: `1e21` が `9.22e18`（LLONG_MAX 由来）に化けた。
   原因: emit_c の整数リテラル int-unbox 判定が `value.fract()==0.0` だけで magnitude 無制限。
   修正: safe-integer 上限 `|v| <= 2^53 (9007199254740992.0)` を追加（infer_int_locals の
   Const 判定 + collect_nonzero_consts の 2 箇所）。2^53 超の整数値は double 据え置き。

2. **数値フォーマット（ts_fmt_num）**: (a) `Infinity`/`-Infinity` が `inf`/`-inf`、(b) `1e20` が
   `1e+20`（JS は全桁十進 `100000000000000000000`）、(c) 指数表記 `1e-7` が C の `1e-07`。
   修正: Infinity 特例、`d==floor(d) && |d|<1e21` は `%.0f`、指数部の 2 桁ゼロ詰めを 1 桁化
   （`e-07`→`e-7`、ただし 3 桁 `e+100` は保持）。

3. **算術演算子の文字列強制変換**: `"5"*2`→NaN、`"10"-"3"`→NaN。原因: `ctx.num`（生ビット
   再解釈 ts_to_num）を使用。修正: `ts_number_coerce`（文字列パース＋ToPrimitive）を使う
   `numc` ヘルパ導入、`- * / %`・単項マイナスに適用。unboxed double は従来どおり直接（perf 不変）。

4. **比較演算子の強制変換**: `1<"2"`→false、`"a"<"b"`→false（辞書順）、`null==undefined`→false。
   修正: runtime に `ts_relational(a,b,op)`（Abstract Relational Comparison: 両 string は
   辞書順、他は ToNumber）と `ts_loose_eq`（`==` の null/undefined・number/string・bool・object
   横断強制変換）を新設。emit_c で両 unboxed 以外の `< <= > >= == !=` をこれらにルーティング。
   `=== !==` は ts_strict_eq 据え置き。両 unboxed の数値 fast path は維持（perf 不変）。

5. **parseInt の hex/符号/空白**: `parseInt("0x1F")`→0。原因: 単項時 radix=10 固定で `0x` 自動検出
   が効かず、strtol が `0` で停止。修正: ts_parse_int を JS 仕様（radix 0/未指定で `0x`/`0X` を
   base16 自動検出、先頭空白スキップ、符号処理）に書き換え、exporter のデフォルト radix を 10→0。
   注: JS は base 0 でも先頭 `0` 単独は十進（C strtol の 8 進と違う）。

## セッション 2（reduce・デフォルト引数・アロー this）

6. **reduce の初期値なし**: `[1,2,3].reduce((a,b)=>a*b)`→0（正 6）。原因: 初期値省略を `undefined`
   初期値と区別できず、`ts_array_reduce` が undefined を accumulator にしていた。修正: `has_init`
   フラグを追加（initial value 省略時は最初の要素を accumulator にし index 1 から走査、空配列は
   undefined）。GC root + callback 後の配列再フェッチも追加。emit_c の array.reduce は has(1) を、
   ts_arrproto_reduce は n>2 を has_init として渡す。

7. **デフォルト引数**: `f(a,b=10,c=a+b)` のデフォルト式が一切評価されず（`f(1)`→1、正 22）。原因:
   パラメータ処理に initializer の扱いが無かった。修正: デフォルト付きパラメータを reference local に
   強制（int-unbox 抑止して undefined 観測可能に）し、source 順に `if (param===undefined) param =
   <default>` を emit（後続デフォルトが前のパラメータを参照可能）。明示的 undefined でも発火、
   文字列デフォルト・前パラメータ参照とも V8 一致。

8. **アロー関数の this 字句捕捉**: `(()=>this.v)()` 等でアローが enclosing の `this` を捕捉できず
   undefined だった。原因: `this` 参照時に `ctx.thisLocal` 未設定（アローは自身の this を持たない）
   だと新規 undefined local を作っていた。修正は 2 段階:
   (a) exporter: lexical-this 用 synthetic symbol を導入。`this` を使うアローは enclosing の `this` を
       cell（`{__value: this}`）に詰めて捕捉（既存の cell-threading 経路に合流）。アロー本体は
       cell.__value から `this` を読む。`arrowUsesThis`（nested arrow は辿るが non-arrow function 境界
       で停止）で検出。
   (b) analyzer/sroa: クラスメソッド内アローで SROA 競合が判明。インスタンスが scalar-replace される
       とアローの lexical-this cell が箱詰めすべき実体 `this` が消える。`captures_this` 述語（本体に
       AllocClosure があり `this`(param0) を StoreField するメソッド）を新設し、(i) そのメソッドの
       SROA-inline をスキップ、(ii) find_sroa_targets でそのレシーバを scalar-replace 対象から除外。
   検証 vs V8: obj method / class method / IIFE / nested arrow / returned closure / map callback /
   一般 callback すべて一致。全 CI 緑、conf 79/79、perf 中立（obj_kernel 202ms, inherit_sroa 84ms。
   captures_this は this をクロージャ捕捉する稀なメソッドのみ対象、kernel は不変）。

## セッション 3（イテレーション: Map/Set for-of・spread・seeding・array.entries）

9. **ジェネレータ/Set/Map/文字列の spread**: `[...g()]` が空配列（silent miscompile）。原因:
   `ts_array_push_all` が非配列 src を黙って無視。修正: generator（`.next()` を done まで駆動、
   value/done は interned field 名で取得）、Set（要素）、Map（[k,v] ペア）、文字列（文字）に対応。

10. **new Map([...]) / new Set([...]) の iterable seeding**: 頻出だが reject。修正: `ts_map_seed`/
    `ts_set_seed`（spread ロジックで iterable を配列化してから充填）。exporter は new Map/Set の引数を
    map.seed/set.seed builtin に。ジェネレータからの seeding も動作。

11. **Map/Set の for-of**: `for (const [k,v] of map)` / `for (const x of set)` が配列インデックス
    ループに落ちて失敗。修正: (a) 配列インデックスループを `lowerArrayIndexForOf` ヘルパに抽出し、
    分割代入ループ変数（`[k,v]`）に対応（lowerBindingPattern を per-iteration で呼ぶ）。(b) for-of で
    Map/Set を **resolveIterator より前に** 判定（型上 iterable に見えるが runtime に .next() が無いため、
    後に置くと誤駆動）。map は entries()、set は values() を配列化して index 反復。

12. **array.entries() / keys() / values() / map.entries()**: 未実装だった。runtime ヘルパ
    （ts_array_entries/keys_arr/values_arr, ts_map_entries）+ emit_c + exporter の arrayMethods/
    mapMethods allowlist + builtinReceiverKind の arrayReturning 検出（これらが配列を返すと認識させ、
    for-of/spread/チェインが解決）。`for (const [i,v] of a.entries())` も動作。

検証 vs V8: 全項目一致。全 CI 緑、conf 81/81、perf 中立（int_kernel 395ms, obj_kernel 207ms,
inherit_sroa 83ms。lowerArrayIndexForOf は単純識別子ケースのループ構造を保存、hot path 不変）。
stale negative test 更新（reject-stdlib の Map 構築引数・m.entries() → Set.union/Set.intersection）。
追加 conformance: maps_sets/seed_and_iterate.ts, iteration/spread_and_entries.ts。

## セッション 4（演算子: 分割代入・複合代入・Object.is）

13. **分割代入の代入文（宣言でない）**: `[a,b]=[b,a]` のスワップが `1 2`（変わらず、silent
    miscompile）。原因: `lowerAssignTarget` が identifier/property/element しか扱わず、
    ArrayLiteral/ObjectLiteral パターン（代入ターゲット）で書き戻しを一切しなかった。修正:
    配列パターン（要素を rhs[i] から読んで再帰代入、hole/`...rest`=slice 対応）とオブジェクト
    パターン（shorthand/rename/default）を追加。**shorthand `{x}` の罠**: getSymbolAtLocation(p.name)
    はプロパティ symbol を返すので getShorthandAssignmentValueSymbol で変数 symbol を解決して
    既存ローカルに書く（誤って fresh local に書いて値が反映されないバグを回避）。

14. **複合代入の不足分**: `**= &= |= ^= <<= >>= >>>=` 未対応。compound テーブルに追加。

15. **論理代入 `??= &&= ||=`**: 未対応（reject）。短絡セマンティクスで実装（a の truthy/falsy/
    nullish を判定し、必要時のみ rhs を評価して代入）。`0 ??= x` は 0 のまま（nullish のみ）。

16. **Object.is**: 未実装。runtime `ts_object_is`（SameValue: NaN===NaN, +0!==-0 を signbit で
    区別、他は ===）。namespaceBuiltin で is を fall-through させ専用ハンドラで処理。
    注: `Object.is(-0, 0)` は **-0 リテラル/算術の表現限界**で true になる（整数 unbox 経路が 0 の
    符号を落とすため）。-0 は Object.is / 1/x===-Infinity / console.log(-0) でしか観測されない
    ニッチケースで、修正には整数ゼロの hot path を deopt する必要があり、コスト>便益と判断して
    既知の限界として据え置き（他の Object.is は全て V8 一致）。

検証 vs V8: 全項目一致（-0 除く）。全 CI 緑、conf 84/84、perf 中立（int 397ms, obj 208ms）。
追加 conformance: operators/{destructure_assign, compound_assign, object_is}.ts。

## セッション 5（ポリモーフィック仮想ディスパッチ・super・配列エスケープ）

17. **super() で親に明示コンストラクタが無いと `ts_dynamic_method_unsupported()` 残留**:
    `super()` のコールイ解決で親の `:ctor` が undefined だと callee が初期値 Unknown のまま
    codegen で `ts_dynamic_method_unsupported()` を吐き、サブクラス ctor が inline された先で
    abort（生きてるコードは正しい値を計算済みなのに dead な placeholder が実行される）。
    修正: 親に明示 ctor が無い場合は emitImplicitConstruction で親の暗黙構築（フィールド初期化子
    ＋親チェイン）を `this` 上で実行（no-op にすると親フィールド初期化子が漏れる: `class A{tag="base"}`）。
    祖父母チェイン・引数付き super() も確認。

18. **StoreIndex のレシーバが scalar-replace 除外されない（segfault）**: 配列にオブジェクトを
    格納（エスケープ）しても find_sroa_targets が StoreElem しか disqualify せず StoreIndex を
    見ていなかった。`new Sq(2)` 等が scalar-replace されたまま配列に未初期化オブジェクトローカルが
    入り segfault。修正: StoreIndex の src も disqualify。

19. **多重実装の仮想ディスパッチが先頭 impl だけ呼ぶ**: `CalleeRef::Set` が codegen で
    `funcs.first()` を呼ぶだけのスタブで、混在型コレクション（`Shape[]` に `Sq`/`Ci`）で誤った
    monomorphic 呼び出しになっていた。修正: devirt で多重 impl の Dispatch::Virtual を
    CalleeRef::Method（動的プロトタイプ・ルックアップ）に書き換え。各インスタンスの実プロトタイプ
    経由で正しくディスパッチ。base-class-typed 変数経由 / 混在配列 / 3 型階層すべて V8 一致。
    devirt_tests 更新（多重 impl → 動的 Method、レシーバは保守的に GlobalEscape: 動的ディスパッチ
    先が不透明なため。単一 impl は従来どおり Direct で精度・perf 不変）。

検証 vs V8: 全項目一致。全 CI 緑、conf 86/86、perf 中立（obj 201ms, inherit_sroa 81ms, int 382ms。
captures_this 同様、保守的エスケープは多重 impl の稀な呼び出しのみ対象、kernel は単一 impl で不変）。
追加 conformance: classes/{polymorphism, super_implicit_ctor}.ts。

## セッション 6（エラー処理: Error/サブクラス・nested try）

20. **`class X extends Error` で super(m) が message を設定しない**: Error は user class でないので
    parentIdOf が undefined → セッション5 の super-no-ctor 分岐が暗黙構築（何もしない）に落ち、
    `this.message` が未設定で `e.message` が undefined。修正: `extendsBuiltinError` 述語（parentName が
    Error/TypeError/RangeError/... で user class でない）を新設し、`super(m)` で `this.message = m` を設定。
    追加フィールドも動作。

21. **`new Error(msg)` ビルトインが message を設定しない**: 専用ハンドラが無く空オブジェクトを alloc
    していた。修正: new Error/TypeError/RangeError/... を専用処理し `message`（引数）と `name`（種別文字列）
    を設定。これにより **nested try の再throw（`throw new Error("outer")`）も message が正しく伝播**
    （以前 undefined だったのは Error の message 未設定が原因で、try/catch 機構自体は正常だった）。

注: `e instanceof Error` は loud-reject のまま（Error をコンストラクタ値としてモデル化していないため。
我々の Error は tagged object で、instanceof の faithful な実装は別途必要）。silent miscompile では
ないので許容。

検証 vs V8: throw/catch、Error サブクラス、TypeError 等の .name、nested try 再throw、同一エラー再throw、
非 Error 値の throw、finally、ループ内 try すべて一致。全 CI 緑、conf 87/87、perf 中立（obj 203ms）。
追加 conformance: errors/throw_and_catch.ts。

## セッション 7（stdlib: Math.cbrt 精度・Array.fill 範囲）

22. **Math.cbrt が正しく丸められない**: glibc の cbrt は correctly-rounded でなく `cbrt(27)`→
    `3.0000000000000004`（V8 は厳密に 3）。原因は実行時 libm の精度（コンパイル時定数畳み込みでは
    GCC が高精度に計算するため standalone では露見しない）。修正: ts_math_cbrt に Newton ステップ
    1 回（y -= (y³-x)/(3y²)）を追加して libm seed を V8 一致値に研磨。完全立方は厳密、cbrt(2) 等も
    全桁一致、負値も対応。

23. **Array.prototype.fill が start/end を無視**: `[1,2,3,4].fill(0,1,3)` が全要素を 0 に
    （正 `1,0,0,4`）。ts_array_fill が範囲引数を見ず常に全体を埋めていた。修正: start/end（負 index
    対応、[0,len] にクランプ）を受け取るよう拡張。emit_c は has フラグ付きで n(1)/n(2) を、
    arrproto_fill は n>2/n>3 で渡す。引数なし・start のみ・負 index すべて V8 一致。

検証 vs V8: 全項目一致。全 CI 緑、conf 88/88、perf 中立（float 252ms）。
追加 conformance: stdlib/math_array_methods.ts。

## セッション 8（optional chaining の短絡 + SROA 健全化）

24. **optional chaining (`?.`) が短絡していなかった（silent miscompile）**: exporter は `?.` トークンを
    無視して通常の `.`/`[]`/`()` として lowering していた。プロパティ読みは LoadField-on-undefined が
    undefined を返すため偶然一致していたが、(a) optional call (`o.g?.()`, `o?.()`) はメソッド非存在/
    nullish callee で「not a function」abort、(b) **短絡されるべき末尾の副作用が実行される**
    （`o?.b[(n++,0)]` で n が 0→1 になる silent miscompile）という不一致があった。
    修正: exporter に `lowerOptionalChain` を新設。`ts.isOptionalChain` で chain の最外（短絡境界）を
    検出し、各 `?.` リンクのレシーバ（`.expression`）を一度だけ評価して `optChainBound` にメモ化、
    nullish なら全体を `undefined` に短絡、そうでなければ root を通常パスで再 lowering（`?.` を無視）して
    値を得る。**既存の call/method/builtin dispatch 機構を完全に再利用**（メモ化で二重評価を防止）。
    検証 vs V8: 短絡（深いプロパティ/要素/メソッド連鎖）、副作用の非実行、optional call（非存在→undefined,
    存在→呼出, 引数付きはクラスメソッド/builtin 経由で OK）、多段ガード、`?? デフォルト` 併用、
    クラスインスタンス/配列/文字列/Map レシーバ、いずれも一致。

25. **SROA の disqualify がブロックリスト方式で参照読みを取りこぼしていた（#24 の前提修正）**: #24 で
    クラスインスタンスに対し `nullish` UnOp を導入したところ、`find_sroa_targets` の `scan` が `UnOp`
    を無視（catch-all `_ => {}`）していたため、スカラ置換されたオブジェクトの参照（未実体化の局所）を
    nullish 判定し、常に true→短絡→undefined になった。SROA の `rewrite_body` がスカラ置換オブジェクトを
    扱えるのは LoadField/StoreField(obj)/Copy/Direct 非capturing call のみ。それ以外でオブジェクトの
    **参照値**を読む全命令（BinOp/UnOp/比較/真偽 If・Loop cond/Print/動的・添字アクセス/各種 builtin/
    spread 等）を disqualify するよう scan を拡張。保守的（過剰 disqualify は最適化を見送るだけで誤訳しない）。
    これにより `c===null`/`if(c)`/`typeof c` 等の潜在的な同種バグも解消。perf 中立（kernel は LoadField/
    StoreField/Direct call のみで disqualify 対象外、obj 152ms・inherit_sroa 69ms）。

26. **（移植バグ修正）`run_unit_tests.sh` の `mod` 書き換え sed が macOS で no-op**: `\b`（単語境界）を
    使っており **BSD sed（macOS）は `\b` 非対応**のため `mod X;` が書き換わらず、テスト bin が
    `src/bin/X.rs` を探して E0583（全 unit テストがコンパイル不能）。`(^|[[:space:]])mod ...` に変更
    （GNU/BSD 両対応）。これで全 unit-test スイートが macOS でも通過。

スコープ外で露見した既知バグ（未修正・正直に flag）: **オブジェクト/`any` のフィールドに格納した
クロージャをメソッド呼び出し（`o.g(args)`）すると引数がずれる silent miscompile**（`o.g(21)`→0,
`o.g(3,4)`→3。`?.` の有無に関係なく再現、直接呼び `g(21)` や class メソッドは正常）。動的メソッド
dispatch（methodField 経由）で recv/this とユーザ引数のレイアウトが食い違うのが原因と推定。次セッション候補。

検証 vs V8: 全項目一致。全 CI 緑（conf 89/89, ci_fast/unit/bench-correct1,2/bench-perf すべて PASS）。
perf 中立（int 263ms, float 121ms, obj 152ms, generic 142ms, generic_fn 265ms, typed_field 128ms,
inherit_sroa 69ms — 全 budget 内）。追加 conformance: operators/optional_chaining.ts。

## セッション 9（動的メソッド dispatch の引数ずれ silent miscompile）

27. **オブジェクト/`any` のフィールドに格納したクロージャをメソッド呼び出しすると引数がずれる
    （silent miscompile）**: `const o:any={g:(n)=>n*2}; o.g(21)` が 0 を返す（正 42）。`o.g(3,4)` は
    3（正 7）。`?.` の有無に無関係（セッション8で発見、別バグとして flag していたもの）。
    原因: 動的メソッド dispatch（emit_c の `CalleeRef::Method`）は常に `_a[0]=recv(this)` を渡して
    `ts_call` を呼ぶが、`ts_call` は `this` の有無を判別しない。フィールドに入った arrow/通常関数は
    `this` スロットを消費しない（`takes_this=0`）ため、レシーバが第1引数として渡り、実引数が1つずれる。
    無引数 arrow（`o.f?.()`）が偶然動いていたのは、引数が無く ずれが観測されなかったため。
    修正(3点):
    (a) **runtime `ts_call_method` 新設**: `args[0]=this` 前提のメソッド呼び出しで、対象が `takes_this`
       なら従来通り、そうでなければ（arrow/関数値）先頭レシーバを落として呼ぶ（`ts_call_value` の逆）。
       emit_c の `CalleeRef::Method`（`Call`/`CallSpread` 両方）を `ts_call`→`ts_call_method` に変更。
    (b) **`takes_this` フラグの正しい伝播**: クラスメソッドは args[0] を this として読むのに、プロトタイプ
       登録（emit_c line 169）が `ts_make_fn`（フラグ=0）で登録していた。IR には正しく `takesThis=true`
       があるので `ts_make_fn_t(..., tt)` で伝播。Object.prototype メソッド（toString/valueOf/
       hasOwnProperty, 全て args[0]=this を読む）も同様に `ts_make_fn_t(...,1)` に。
    (c) **builtin プロトタイプ register の `takes_this`**: `ts_{array,map,set,function}_proto_register`
       が `ts_make_fn`（=0）で登録 → call/apply/bind や any 経由の arr.map 等が (a) のドロップで
       レシーバを失い破綻。これらは全て args[0]=receiver を読むので `ts_make_fn_t(...,1)` に。
       （`func_call_apply_bind` golden の回帰で検出。）
    検証 vs V8: arrow フィールド 0/1/2 引数・spread、this 参照メソッド+複数引数、クラスメソッド/可変長/
    継承メソッドの any 経由、Object.prototype・Array.reduce・Map.forEach の動的 dispatch、
    call/apply/bind すべて一致。

既知の限界（既存・未変更）: 文字列を `any` 型にすると組み込み文字列メソッドが dispatch されず loud-reject
（NaN-boxing で文字列はプロトタイプを持つヒープオブジェクトでないため。配列/Map/Set は動的 dispatch 可）。
エラーメッセージが具体型を付ける回避策を案内するので silent miscompile ではない。

検証 vs V8: 全項目一致。全 CI 緑（conf 90/90, ci_fast/unit/bench-correct1,2/bench-perf すべて PASS）。
perf 中立（全 kernel budget 内）。追加 conformance: object_methods/field_function_dispatch.ts。

## セッション 10（any 型文字列のメソッド動的 dispatch）

28. **`any` 型の文字列で組み込みメソッドが reject される（限界の解消）**: `const s:any="hi"; s.toUpperCase()`
    が「method is not a function」で abort していた。配列/Map/Set/オブジェクトは共通ヘッダ（`proto`
    ポインタ）を持ち `ts_get` がプロトタイプ鎖を辿って `g_{array,map,set}_proto` の登録メソッドに到達
    する（=`any` でも動的 dispatch 済み）が、文字列/数値はプリミティブで共通ヘッダを持たず `ts_get` が
    即 undefined を返していた。なお exporter/analyzer は既に any 文字列メソッドを動的 Method dispatch
    として出力済みで、足りないのは runtime の `String.prototype` だけだった。
    修正: 配列 proto と同じパターンで `g_string_proto` を新設。(a) `ts_strproto_*` ラッパ（`(tsv*,int)`
    規約, args[0]=this, 既存 `ts_str_*` へ委譲, 数値/真偽は ts_num/ts_bool で box）を 22 メソッド分追加
    （toUpperCase/toLowerCase/slice/substring/indexOf/lastIndexOf/includes/startsWith/endsWith/
    charAt/charCodeAt/at/concat/repeat/trim/trimStart/trimEnd/split/padStart/padEnd/replace/replaceAll）。
    (b) `ts_get` の冒頭に文字列分岐を追加し、文字列レシーバは `g_string_proto` 鎖（→ Object.prototype）
    を辿る。(c) exporter に `stringProtoMethods` テーブル、emit_c に `ts_setup_string_proto` + setup 呼出、
    escape_ir に `string_proto_methods` フィールド。全て takes_this=1 で登録（セッション9 の ts_call_method
    がレシーバを正しく this として渡す）。
    **静的型付き文字列の fast path（CallBuiltin "string.X"）は不変**なので hot path に影響なし。
    検証 vs V8: toUpperCase/slice/substring/indexOf/includes/split/padStart/charCodeAt/at/replaceAll/
    startsWith/trim/repeat/concat、連鎖呼び出し、optional chaining 併用、すべて一致。

注（残る限界）: 数値・真偽値のメソッド（`(5 as any).toFixed(2)` 等）はまだ proto 未整備で reject。
同じ仕組み（`g_number_proto`）で拡張可能。文字列が最頻だったため本セッションは文字列のみ対応。

検証 vs V8: 全項目一致。全 CI 緑（conf 91/91, ci_fast/unit/bench-correct1,2/bench-perf すべて PASS）。
perf 中立（全 kernel budget 内）。追加 conformance: strings/any_string_methods.ts。

## セッション 11（any 型数値のメソッド動的 dispatch — g_number_proto）

29. **`any` 型の数値で組み込みメソッドが reject される（セッション10 の数値版）**: `(x as any).toFixed(2)`
    等が dispatch されず reject していた。セッション10 の文字列 proto と同一パターンで `g_number_proto`
    を追加。runtime に `ts_numproto_{toFixed,toString,toPrecision,valueOf}` ラッパ（args[0]=this,
    既存 `ts_number_to_{fixed,string_radix,precision}` へ委譲）、`ts_get` の冒頭に数値分岐
    （`ts_is_num` → `g_number_proto` 鎖 → Object.prototype）、exporter の `numberProtoMethods` テーブル、
    emit_c の `ts_setup_number_proto`、escape_ir の `number_proto_methods` フィールド。全て takes_this=1。
    数値の `toString(radix)` は `g_number_proto` が Object.prototype より先に解決されるので基数指定も正しく
    動く。静的型付き数値の fast path は不変（unboxed 経路を一切触らない）。
    検証 vs V8: toFixed(0/2/省略)・toString(10/16/2/8)・toPrecision・valueOf・負値・optional chaining、
    すべて一致。

注（残る限界）: 真偽値メソッド（`(true as any).toString()`）は未対応。同じ仕組み（`g_boolean_proto`）で
拡張可能だが、用途が稀なため見送り。

検証 vs V8: 全項目一致。全 CI 緑（conf 92/92, ci_fast/unit/bench-correct1,2/bench-perf すべて PASS）。
perf 中立（全 kernel budget 内）。追加 conformance: numbers/any_number_methods.ts。

## セッション 12（不足ビルトインの実装: Array.from / Object.getOwnPropertyNames / String.fromCodePoint）

30. **`Array.from` 全形態が未対応**: iterable（配列/Set/Map/文字列/ジェネレータ）・array-like（`{length}`）・
    map 関数付き、いずれも reject していた。runtime に `ts_array_from(src)`（iterable は `ts_array_push_all`
    を再利用、ジェネレータは `__coro` フィールドで検出、array-like は `length` まで位置読み）と
    `ts_array_from_mapped(src, fn)`（fn(element, index) を適用）を追加。exporter `namespaceBuiltin` に
    `Array.from`（argc 1/2）、emit_c で 1 引数→`ts_array_from`/2 引数→`ts_array_from_mapped`。
    検証 vs V8: 配列コピー/map関数/Set重複除去/Map [k,v]/文字列分解/ジェネレータ/`{length}` range idiom、一致。
    stale negative test 更新（`Array.from` → `copyWithin`（未対応）に差し替え）。

31. **`Object.getOwnPropertyNames` 未対応**: このモデルは全 own プロパティが列挙可なので `Object.keys`
    と一致。`object.getOwnPropertyNames` → `ts_object_keys` に委譲。

32. **`String.fromCodePoint` 未対応**: `fromCharCode`（単バイト切り詰め）と違い完全な Unicode コードポイント
    を UTF-8 エンコード。`ts_string_from_code_point`（1〜4バイト UTF-8）追加。emoji/アクセント付き文字/
    ASCII 混在すべて V8 の UTF-8 出力と一致。

検証 vs V8: 全項目一致。全 CI 緑（conf 94/94, ci_fast/unit/bench すべて PASS）。perf 中立。
追加 conformance: arrays/array_from.ts, stdlib/object_string_statics.ts。

## セッション 13（JSON.stringify の整形出力 space）

33. **`JSON.stringify(value, replacer, space)` の space（整形）未対応**: 第3引数の space が reject されて
    いた。`json_stringify_val` に `indent`（レベルごとのインデント単位文字列, NULL=compact）を通し、
    `jb_indent`（改行+depth×indent、compact 時 no-op）で配列/オブジェクト/Map に改行＋インデント＋
    `": "` を挿入。空 `{}`/`[]` は1行のまま。**compact 出力はバイト不変**（jb_indent が no-op）。
    runtime `ts_json_stringify_indent(v, space)`（space は数値→空白数 clamp10 / 文字列→先頭10文字）追加。
    exporter は `JSON.stringify` 専用分岐を新設: 第2引数(replacer)が `null`/`undefined` リテラルのときのみ
    対応（**関数/配列 replacer は出力を変えるので loud-reject**）、space 有り→`json.stringify.indent`、
    無し→従来 `json.stringify`。
    検証 vs V8: 数値インデント/ネスト/トップレベル配列/タブ文字列インデント/空オブジェクト・配列/
    undefined replacer/深いネスト/compact、すべて一致。関数 replacer は exit 3 で reject。

検証 vs V8: 全項目一致。全 CI 緑（conf 95/95, ci_fast/unit/bench すべて PASS）。perf 中立。
追加 conformance: stdlib/json_stringify_space.ts。

## セッション 14（Object.create / Object.freeze / Object.isFrozen）

34. **`Object.create` / `Object.freeze` / `Object.isFrozen` 未対応**:
    - `Object.create(proto)`: `ts_object_create` — bare object（proto=NULL）を作り、proto が propbag なら
      その proto を設定。`Object.create(null)` は proto=NULL のまま。プロパティ記述子付き 2引数形は reject。
    - `Object.freeze` / `Object.isFrozen`: 未使用の `shape` ワード（将来 PIC 用、現状常に0）の bit0 を
      frozen フラグに転用。`ts_object_freeze` がセット、`ts_set`（プロパティ書き込み）と配列ミューテータ
      （`ts_array_set`=要素書き込み+push, pop/shift/unshift/reverse/fill/sort）が frozen を見て書き込みを
      no-op（sloppy モードの「黙って無視」に一致）。構造体フィールドは増やさず offset 不変。
    検証 vs V8: freeze 後のプロパティ/要素書き込み無視・freeze の戻り値同一性・isFrozen・create(null)/
    create(proto)（継承メソッド/フィールド+own プロパティ）・浅い freeze（ネストは凍結されない）、一致。
    stale negative test 更新（`Object.freeze` → `Object.seal`（未対応））。

既知の限界: **frozen 配列に対する破壊的メソッド（pop/sort 等）は node では TypeError を throw するが、
tsaot は no-op**（配列は破壊されず値は正しいが、throw が出ない）。要素書き込み無視は一致。throw 欠落のみの
差異で silent な値の誤りではない。Object.seal/preventExtensions、create の記述子引数は未対応（reject）。

検証 vs V8: 全項目一致。全 CI 緑（conf 96/96, ci_fast/unit/bench すべて PASS）。perf 中立。
追加 conformance: object_methods/freeze_create.ts。

## セッション 15（Date: コンポーネントコンストラクタ + インスタンスメソッド群）

35. **`Date` が no-arg + getTime/valueOf しか対応していなかった**: 以下を実装。
    - **コンストラクタ**: `new Date(epochMs)`（数値1引数）、`new Date(y,mo,d?,h?,mi?,s?,ms?)`
      （コンポーネント形, **ローカル時刻**, 省略時 day=1/他0）。文字列/Date 引数は loud-reject（日付文字列
      パースは未実装→NaN を黙って返さない）。
    - **runtime**: `ts_date_from_components`（`mktime` でローカル時刻解釈＋桁あふれ正規化、年0-99→1900-1999）、
      `ts_date_component(ms, which)`（`localtime_r`/`gmtime_r` で分解。which 下位=フィールド, |16=UTC 版,
      8=getTimezoneOffset 分）、`ts_date_to_iso`（UTC ISO 文字列）。
    - **インスタンスメソッド**: getFullYear/getMonth/getDate/getDay/getHours/getMinutes/getSeconds/
      getMilliseconds/getTimezoneOffset と各 getUTC* 版、toISOString。getTime/valueOf は既存のまま。
    ローカル時刻系は **C の `localtime_r`/`mktime` がシステム TZ を使う**ので、同一マシンで動く node と一致
    （差分ハーネスも同一マシンで比較するため常に整合）。
    検証 vs V8: コンポーネント構築＋ローカル getter、桁あふれ正規化、デフォルト、ミリ秒、epoch-ms 往復、
    UTC getter 群、toISOString、getTimezoneOffset の型、すべて一致。
    stale negative test 更新（`new Date(0)`/`getFullYear` → `new Date("...")`（文字列パース未対応）/
    `toLocaleDateString`（未対応メソッド））。

既知の限界: 日付文字列パース（`new Date("2020-01-01")`）、`toString`/`toLocaleString` 系（TZ 名を含む
V8 の正確な書式の再現が困難）、`setX` 系セッターは未対応（loud-reject）。

検証 vs V8: 全項目一致。全 CI 緑（conf 97/97, ci_fast/unit/bench すべて PASS）。perf 中立。
追加 conformance: stdlib/date_methods.ts。

## セッション 16（JSON.parse の reviver）

36. **`JSON.parse(text, reviver)` の reviver 未対応**: パース結果を **ボトムアップ**で走査し各要素/プロパティに
    reviver(key, value) を適用（spec の InternalizeJSONProperty）。`undefined` を返すとプロパティ削除
    （配列要素は dense モデルでは hole==undefined）。runtime `json_internalize`（再帰: 配列は index 文字列化、
    オブジェクトは `ts_object_keys` のスナップショットを走査して `ts_get`/`ts_set`/`ts_delete_prop`）+
    `ts_json_parse_reviver`（トップレベルは空文字列キーで呼ぶ。非関数 reviver は無視＝JS 準拠）。
    exporter は JSON.parse を argc 1/2 許可、emit_c は args 2個で `ts_json_parse_reviver`。reviver は
    plain callback（this=undefined）として呼ぶ（holder を this に使う reviver は非モデル化）。
    検証 vs V8: 数値変換・ネスト深さ優先・配列要素・undefined 削除・全キー訪問（空キー含む）・
    プリミティブ top-level・reviver なし、すべて一致。

検証 vs V8: 全項目一致。全 CI 緑（conf 98/98, ci_fast/unit/bench すべて PASS）。perf 中立。
追加 conformance: stdlib/json_parse_reviver.ts。

## セッション 17（Object.seal / preventExtensions / isSealed / isExtensible）

37. **Object 整合性レベルの残り（seal/preventExtensions/isSealed/isExtensible）未対応**: セッション14 の
    frozen フラグ（`shape` bit0）を拡張し、bit1=non-extensible（preventExtensions）/ bit2=sealed（seal）を
    追加。`ts_set` のプロパティ追加パス（step 3）に `shape & (2|4)` ガード（既存プロパティへの書き込みは
    許可、新規追加のみ禁止）、`ts_delete_prop` に `shape & (1|4)` ガード（frozen/sealed は削除不可）。
    seal=値変更可・追加削除不可、preventExtensions=追加のみ不可（書き込み・削除可）、freeze=全不可。
    `isSealed`=(frozen|sealed)、`isExtensible`=フラグ無し、と整合（freeze は sealed かつ non-extensible）。
    検証 vs V8: seal の追加/削除禁止＋値変更可、preventExtensions の追加禁止＋削除可、isSealed/isExtensible、
    frozen が sealed かつ非 extensible、sealed は frozen でない、すべて一致。
    stale negative test 更新（`Object.seal` → `Object.getOwnPropertySymbols`（symbol キー own プロパティ未モデル化））。

検証 vs V8: 全項目一致。全 CI 緑（conf 99/99, ci_fast/unit/bench すべて PASS）。perf 中立。
追加 conformance: object_methods/seal_extensions.ts。

## セッション 18（generator.return() + number|undefined のアンボックス silent miscompile）

38. **`generator.return(v)` 未対応で abort（DIFF）**: `it.return(99)` が「method is not a function」で
    中断していた（node は `{value:99,done:true}`）。`.next()`/`.throw()` と同じ経路で `.return()` を実装。
    - **exporter**: `isGeneratorType` レシーバの `.return(v)` を `generator.return` builtin に lower。
    - **emit_c**: `generator.return` → `ts_gen_return(recv, arg)`。
    - **runtime `ts_gen_return`**: 強制リターン。`{value:v, done:true}` を返し以後 exhausted。
      - 未開始/トップレベル yield で停止中/既に done → クリーンに `c->done=1`（本体は以降走らない）。
      - **try/finally の中で停止中（`eh_top>0 || fin_top>0`）→ loud-reject（abort）**: 強制リターンは
        本来 finally を走らせるが、その injection は未実装。黙って finally を飛ばす silent miscompile を
        避けるため明示的に落とす（spec の return-completion injection は将来課題）。
    検証 vs V8: 基本（next→return→exhausted）/done フラグ/未開始/既 done/引数なし（value=undefined）/
    for-of 早期 break、すべて一致。

39. **`number | undefined`（`void`/`null` 含む）union がアンボックスされ undefined が NaN になる
    silent miscompile**: ジェネレータ結果の `.value` は型が `number | void`（done 時 undefined）だが、
    `classify` が `Void|Undefined|Null` を unboxable primitive 扱い→union 全 primitive→raw double で保持→
    格納された `undefined`（TS_UNDEFINED）を `ts_to_num` で読むと **NaN**。`it.next().value`（done 後）や
    `String(r.value)` が `undefined` でなく `NaN` を出していた（#38 とは独立の既存バグ）。
    修正: `classify` の union 分岐で「number-like メンバと nullish（void/undefined/null）メンバが共存」したら
    `reference`（boxed）に倒す。純 number は primitive 維持（hot path 不変）、純 undefined/void も従来通り。
    検証 vs V8: 末尾超え `.next().value`、`.return()` の value、すべて undefined 一致。perf 中立
    （int/float/obj/generic/typed_field/inherit_sroa 全 kernel budget 内）。
    残限界: `any` 型のジェネレータ（`const it:any=g(); it.next()`）はプロト非経由で動的 dispatch 不可→
    loud-reject（具体型を促すメッセージ。silent miscompile ではない）。

検証 vs V8: 全項目一致。全 CI 緑（conf 100/100, ci_fast/unit/bench すべて PASS）。perf 中立。
追加 conformance: iteration/generator_return.ts。

## セッション 19（Array.sort() デフォルト比較 + Array.includes の SameValueZero）

40. **`Array.sort()`（コンパレータ無し）が数値順で並べていた silent miscompile**: spec のデフォルト
    コンパレータは要素を**文字列化して辞書順**比較する。`[3,1,2,10,20].sort()` は node では
    `1,10,2,20,3` だが tsaot は `1,2,3,10,20`（数値順）を返していた。原因: `default_cmp` が
    両者 number のとき数値比較する fast path を持っていた。修正: その数値特例を削除し常に文字列比較。
    あわせて **undefined は末尾**にソート（spec の SortCompare: undefined 同士=0, 片方のみ undefined は
    後ろ）も実装。コンパレータ有りの `.sort((a,b)=>a-b)` は不変（数値順維持）。

41. **`Array.includes(NaN)` が false（silent miscompile）**: `includes` は `indexOf`（strict ===, NaN≠NaN）に
    委譲していたが、spec では **SameValueZero**（NaN===NaN, +0===-0）を使う。`[1,NaN,3].includes(NaN)` は
    node では true。修正: `ts_array_includes` を独立実装し、strict-eq に加え「探索値も要素も NaN なら一致」を
    判定。+0/-0 は既に strict で一致するので NaN のみ追加。`indexOf` は strict のまま（NaN 探索は -1 で正）。
    検証 vs V8: デフォルト/文字列/undefined ソート、コンパレータ有り、includes(NaN/通常/-0)、すべて一致。

検証 vs V8: 全項目一致。全 CI 緑（conf 101/101, ci_fast/unit/bench すべて PASS）。perf 中立。
追加 conformance: arrays/sort_default_includes.ts。

## セッション 20（switch のフォールスルー silent miscompile + String.split の limit）

42. **`switch` の非空ケースがフォールスルーせず排他扱いになる silent miscompile**: 旧 lowering は
    switch を排他 if/else-if 連鎖にしており（コメントにも「非空ボディのフォールスルーは排他で近似」と
    明記）、`case 1: r+="a"; case 2: r+="b"; break;` が node の `"ab"` ではなく `"a"` を返していた。
    discipline（loud-reject over silent-miscompile）に反する黙った誤りなので**正しいフォールスルーを実装**。
    新モデル（2 部構成）:
    - **(1) matched 計算**: 各 case 式を**ソース順に遅延評価**（短絡, 最初の一致で停止）し、一致した
      clause のインデックスを `matched` に。どの case も不一致なら default の index、default も無ければ
      番兵 `n`（=どの clause も実行しない）。
    - **(2) 一回限りの break 可能ループ**: 全 clause を順に歩き、`matched` の位置で `active` フラグを立て
      **以降ずっと true**（=フォールスルー）。末尾に無条件 `Break` を置いて単一パスで抜ける。
      ループは `Loop{cond:true, body:[..., Break]}` で表現（emit_c の for(;;)+break）。
    これで非空フォールスルー / 空ラベルグルーピング（`case 1: case 2:`）/ 中間 default / default からの
    フォールスルー / ネストループ内 break / 副作用付き case 式、すべて統一的に正しく動く。
    switch 文脈の `break` は実 `Break`（旧モデルでは no-op だった）に変更。`continue`-in-switch は
    外側ループ対象のため従来通り loud-reject。
    検証 vs V8: 全パターン一致。

43. **`String.split(sep, limit)` の limit 無視（silent miscompile）**: `"a,b,c,d".split(",",2)` が limit を
    無視して全 4 要素を返していた（node は `["a","b"]`）。`ts_str_split` に limit 引数追加（ToUint32,
    undefined=無制限, 0=空配列）、結果が limit 要素に達したら打ち切り。emit_c は `v(1)` を渡し、
    strproto_split も 3 引数化。空セパレータ（各文字分割）にも limit を適用。
    検証 vs V8: limit 2/0/大きい値/無し/空セパレータ/any 型文字列、すべて一致。

検証 vs V8: 全項目一致。全 CI 緑（conf 103/103, ci_fast/unit/bench すべて PASS）。perf 中立
（int/float/obj/generic/generic_fn/typed_field/inherit_sroa 全 kernel budget 内, switch はベンチ hot path 外）。
追加 conformance: control/switch_fallthrough.ts, strings/split_limit.ts。

## セッション 21（不足ビルトイン: Array.reduceRight / Array.copyWithin / Math.max・min の 0・1 引数）

44. **`Array.reduceRight` 未対応（REJECT）**: 右畳み込み。`ts_array_reduce_right`（init 有=末尾から、
    init 無=最終要素を種に index len-2 から右→左、空配列は undefined。cb 呼び出しは GC root + 配列再フェッチ）。
    emit_c `array.reduceRight`→`ts_array_reduce_right(r,v(0),v(1),has(1))`、exporter allowlist + プロト登録
    （`ts_arrproto_reduceRight`）、any 経由動的 dispatch も可。
45. **`Array.copyWithin` 未対応（REJECT）**: `copyWithin(target,start,end?)` をインプレースで（負 index は末尾
    から、[0,len] クランプ、重なりは memmove、length 不変、frozen は no-op）。emit_c `array.copyWithin`
    →`ts_array_copy_within(r,n(0),n(1),n(2),has(2))`、allowlist + プロト登録。
46. **`Math.max()` / `Math.min()` の 0・1 引数が誤り**: 旧 lowering は `>=2` 引数のみ畳み込み、0 引数は
    汎用 2-arg ハンドラで `max2(0,0)=0`（正: -Infinity/+Infinity）、1 引数は `max2(x,0)`（負値 silent miscompile,
    例 `Math.max(-5)`→0）。修正: 恒等値（max=-Infinity, min=+Infinity, IR の NegInf/PosInf const）を種に
    **全引数を畳み込む**統一形に。0 引数→恒等値、1 引数→ToNumber(arg)、N 引数→正しい畳み込み、NaN 伝播。
    検証 vs V8: reduceRight（init 有無/文字列構築/index 順）、copyWithin（基本/start-end/負/チェーン/any）、
    Math.max・min（0/1/N/NaN）、すべて一致。
    既知の限界: `Math.max("5","12" as any)`（文字列引数）は `as any` 必須（TS が通常エラー）で n() が
    文字列を coerce せず NaN。pre-existing かつ degenerate。同様に init 無 reduce/reduceRight で cb が
    宣言型（number）に反し文字列を返す型違反コードは acc が unboxed double のため誤り（既存 reduce と同挙動,
    boxing は数値 hot path を失うため据置）。

検証 vs V8: 全項目一致。全 CI 緑（conf 104/104, ci_fast/unit/bench すべて PASS）。perf 中立。
stale negative test 更新（reject-stdlib の `copyWithin` → `toSorted`（ES2023 immutable methods 未対応））。
追加 conformance: arrays/reduce_right_copywithin.ts。

## セッション 22（indexOf/lastIndexOf の fromIndex + 可変長 concat + Array.splice）

47. **`Array.indexOf`/`lastIndexOf` が fromIndex 引数を無視（silent miscompile）**: `[1,2,3,2,1].indexOf(2,2)`
    は node では 3 だが tsaot は 1。`ts_array_indexof`/`ts_array_lastindexof` に from/has_from 追加（負は末尾
    から、indexOf は max(0,from) から前方、lastIndexOf は min(from,len-1) から後方）。emit_c に n(1)/has(1)、
    プロト wrapper も 4 引数化。
48. **`String.indexOf`/`lastIndexOf` も fromIndex 無視（silent miscompile）**: 配列版と同じ修正を文字列に。
    `"ababab".indexOf("a",1)`→2。空 needle の戻り（clamp(from,0,len)）も spec 準拠。emit_c/プロト wrapper 更新。
    `ts_str_includes` は from なし呼び出しに修正。
49. **`Array.concat` が単一引数のみ・非配列引数を脱落（silent miscompile）**: `[1].concat([2,3],4,[5])` が
    `[1,2,3]` を返していた（正 `[1,2,3,4,5]`）。runtime `ts_array_concat(x,y)` を「y が配列なら spread、
    それ以外は 1 要素として append」に修正（旧は非配列を黙って無視）。exporter は可変長 concat を 2 引数 concat の
    連鎖に畳み込み（引数なし→slice で浅いコピー）。any 経由のプロト wrapper `ts_arrproto_concat` も全引数 fold に。
50. **`Array.splice` 未対応（REJECT）→実装**: `splice(start, deleteCount?, ...items)` をインプレース（配列 identity
    維持: data バッファを `[0,s)+items+[s+del,n)` で再構築、malloc↔代入間に GC 無し）。削除要素の配列を返す。
    引数規則: 0 個→削除 0、1 個→末尾まで削除、>=2→deleteCount 指定。負 start は末尾から、deleteCount は
    [0,len-start] クランプ。frozen は no-op（throw 欠落は既知）。exporter は items を配列リテラルとして構築し
    `array.splice`（dc 有）/`array.spliceEnd`（dc 無=末尾まで）に振り分け、emit_c + プロト wrapper + allowlist 追加。
    検証 vs V8: replace/delete/insert-only/負 start/引数なし/dc オーバーフロー/空結果/any/伸長、すべて一致。

検証 vs V8: 全項目一致。全 CI 緑（conf 105/105, ci_fast/unit/bench すべて PASS）。perf 中立。
追加 conformance: arrays/splice_indexof_concat.ts。

## セッション 23（new Array コンストラクタ + 小数 toString の指数/十進境界）

51. **`new Array(...)` が未対応でプレーンオブジェクトを alloc していた silent miscompile**: `new Array(3)`→
    length 0、`new Array(1,2,3)`→空、`new Array(3).fill(0)`→空。NewExpression に Array 分岐が無く
    ユーザクラス経路に落ちて OBJECT を alloc していた。実装: **単一数値引数=length**（n 個の undefined,
    runtime `ts_array_new_length`）、**それ以外の引数列=要素**（AllocArray+ArrayPush）。引数の型が NumberLike
    かを checker で判定し length/elements を振り分け。`new Array("x")`→`["x"]`、`new Array()`→空も一致。
    **付随バグ**: `ts_new_array` の予備容量は `calloc` のゼロビット（=数値 0、undefined ではない）なので、
    length を伸ばすだけだとホールが 0 になる。`ts_array_new_length` は各スロットを TS_UNDEFINED で明示的に
    push して埋める（`new Array(2)[0]`→undefined, 旧 0）。
52. **小数の toString が 1e-6 を `"1e-6"` と指数表記（silent miscompile）**: V8 は分数を 1e-6 まで十進
    （`(0.000001).toString()`→`"0.000001"`）、1e-7 以下で指数（`"1e-7"`）。C の `%g` は 1e-5 から指数に
    切り替わるため 1e-5/1e-6 がずれていた。`ts_fmt_num` で「buf に 'e' を含み magnitude が [1e-6,1) の分数」を
    最短 round-trip の `%f`（固定小数）で再フォーマット。1e-7 以下は指数のまま、大きい数(>=1e21)も不変。
    検証 vs V8: 0.000001/0.00001/0.0000001/1.5e-6/負値小数/混在/1e-10・5e-8・2.5e30/1e21、すべて一致。

検証 vs V8: 全項目一致。全 CI 緑（conf 107/107, ci_fast/unit/bench すべて PASS）。perf 中立。
追加 conformance: arrays/new_array_ctor.ts, numbers/small_fraction_tostring.ts。

## セッション 24（可変長 Math.hypot/String.concat + global isNaN/isFinite 強制変換 + codePointAt）

53. **`Math.hypot` が 2 引数のみ（REJECT）**: hypot は結合的（sqrt(a²+b²+c²)=hypot(hypot(a,b),c)）なので
    max/min の畳み込み特例に hypot を追加。種は 0（hypot()=0, hypot(0,x)=|x|）。0/1/N 引数すべて対応。
54. **`String.concat` が単一引数のみ（silent miscompile）**: `"a".concat("b","c","d")`→`"ab"`。プロト wrapper は
    可変長対応済だったが静的 string 経路の emit が v(0) のみ。exporter で array.concat と同様に可変長を
    `string.concat`（=ts_add）連鎖に畳み込み（0 引数→レシーバ）。
55. **`isNaN`/`isFinite`（global）が引数を ToNumber 強制変換しない（silent miscompile）**: `isNaN("abc")` は
    node では true（"abc"→NaN）だが tsaot は false。global 版は `Number.isNaN`/`isFinite` と違い ToNumber を
    かける。emit_c を `isnan(ts_number_coerce(x))`/`isfinite(ts_number_coerce(x))` に変更。Number.* 版は不変
    （強制変換しない仕様）。
56. **`String.codePointAt` 未対応（REJECT）→実装**: バイト（UTF-8）格納モデルに合わせ、バイト index から
    UTF-8 シーケンスをデコード（ASCII は charCodeAt と一致、範囲外は undefined）。runtime
    `ts_str_codepointat`、emit_c `string.codePointAt`、stringMethods allowlist + プロト登録
    （`ts_strproto_codePointAt`）。any 経由も可。
    検証 vs V8: hypot(3引数/1/0/2)、concat(複数/1/0/any)、isNaN/isFinite(文字列強制変換)、codePointAt(ASCII/範囲外/any)、
    すべて一致。

検証 vs V8: 全項目一致。全 CI 緑（conf 108/108, ci_fast/unit/bench すべて PASS）。perf 中立。
追加 conformance: stdlib/variadic_and_coercion.ts。

## セッション 25（substring 引数スワップ + startsWith/endsWith 位置引数 + join の null/undefined + Array.toString）

57. **`String.substring` が `ts_str_slice` に誤ルーティング（silent miscompile）**: substring は slice と違い
    start>end で**引数をスワップ**し、負値は 0 にクランプ（end からではない）。`"hello".substring(3,1)`→
    node `"el"` だが tsaot は `""`。専用 `ts_str_substring` を新設（emit_c `string.substring` を分離、プロト
    wrapper `ts_strproto_substring`）。slice は不変。
58. **`String.startsWith`/`endsWith` が位置引数を無視（silent miscompile）**: `"hello".startsWith("llo",2)`→
    node true だが tsaot false。`ts_str_startswith` に position、`ts_str_endswith` に endPosition を追加
    （emit_c に n(1)/has(1)、プロト wrapper も 4 引数化）。
59. **`Array.join` が undefined/null 要素を `"undefined"`/`"null"` と描画（silent miscompile）**: spec では空文字列。
    `[1,undefined,3,null].join(",")`→node `"1,,3,"`。`ts_array_join` で undefined/null 要素をスキップ（空文字列）。
    あわせて **セパレータ undefined→`","`**（`[1,2,3].join()`/`join(undefined)` のデフォルト, spec 準拠）も修正。
    GC root も追加。
60. **`Array.toString` 未対応（REJECT）→実装**: `arr.toString()` = `join(",")`。emit_c `array.toString`、
    allowlist + プロト登録（`ts_arrproto_toString`）。`String([1,[2,3]])` のネスト toString も一致。
    検証 vs V8: substring(スワップ/通常/負)、slice 不変、startsWith/endsWith(位置)、join(null/undefined/no-arg/custom)、
    Array.toString(静的/any/ネスト)、すべて一致。

検証 vs V8: 全項目一致。全 CI 緑（conf 109/109, ci_fast/unit/bench すべて PASS）。perf 中立。
追加 conformance: strings/substring_position.ts。

### pending（影響大/要設計, 未着手）
- **`(1.45).toFixed(1)` が `"1.5"`（node `"1.4"`）**: 1.45 は double で 1.4499999... のため V8 は "1.4"。
  現行の「ゼロから離れる丸め」を明示適用すると 1.45→1.5 になり不一致。正しくは IEEE754 の実値に基づく
  丸め（V8 は Grisu/Ryū 系の正確な十進変換）。`ts_number_to_fixed` の丸めロジック全面見直しが必要で
  影響範囲が大きいため pending。`(-1.5).toFixed(0)`→"-2" 等の単純ケースは一致。

## セッション 26（Array() 関数呼び出し形式 + String.replace の $ パターン）

61. **`Array(...)`（`new` 無し呼び出し）が「value is not a function」で abort（silent miscompile）**: `new Array`
    のみ対応で、`Array(3)` / `Array(3).fill(0).map(...)` 等の関数呼び出し形式が落ちていた。`new Array` の構築
    ロジックを `lowerArrayConstruct` ヘルパに切り出し、NewExpression 経路と bare-call 経路（`isBuiltinSymbol`
    で Array 判定）の両方から呼ぶ。単一数値=length / それ以外=要素 のセマンティクスは共通。
62. **`String.replace`/`replaceAll` が置換文字列の `$` パターンを展開しない（silent miscompile）**:
    `"hello".replace("l","[$&]")`→node `"he[l]lo"` だが tsaot は `"he[$&]lo"`（リテラル）。`$$`→`$`、`$&`→マッチ、
    `` $` ``→前方、`$'`→後方 を `expand_replacement` で展開（$n グループ参照は regex 専用なので非対応）。
    置換文字列に `$` が無ければ従来通りそのまま append（fast path）。GC root + ポインタ再フェッチで安全化。
    検証 vs V8: Array(n/elems/str/empty/fill-map), new Array 不変, replace($&/$$/$`/$'/replaceAll/plain/no-dollar/any), すべて一致。

検証 vs V8: 全項目一致。全 CI 緑（conf 110/110, ci_fast/unit/bench すべて PASS）。perf 中立。
追加 conformance: strings/replace_patterns.ts。

### pending 追記（影響大/要設計）
- **`typeof Math.max` → `"undefined"`（node `"function"`）**: 組み込みメソッドを first-class 関数値として
  モデル化していない（呼び出し時のみ特別扱い）。値として参照すると undefined。組み込みを関数値化する
  大きな変更が必要なため pending。
- **ラベル付き `continue outer`（多段ジャンプ）**: 既知の loud-reject（multi-level jump 未モデル化）。

## セッション 27（Array.push / unshift の複数引数と戻り値）

63. **`Array.push`/`unshift` の複数引数・戻り値が壊れていた（silent miscompile）**:
    - `push(a,b)`: emit が `ts_num((double)len)`（tsv）を返しつつ arm を `numeric=true` にしていたため、
      数値スロットに boxed 値を入れて garbage（例 `4613937818241073152`）。`(double)ts_array_len(r)`（生 double）に修正。
    - `unshift(a,b,c)`: 単一引数（`v(0)`）しか処理せず、複数引数を取りこぼし＋順序も誤り。emit を逆順 fold の
      ブロック（`[a,b,c,...既存]`）にし戻り値=新 length。any 経由のプロト wrapper `ts_arrproto_unshift` も
      逆順ループに修正（push の wrapper は既にループ済）。
    - **`arr.push(x)`（単一引数）の最適化が戻り値に配列を返していた**: `arr.push(x)`→`ArrayPush`（配列を返す）
      の fast path は戻り値破棄時のみ正しい。`const len=a.push(3)` 等で length を使うと配列が返り誤り
      （`len*2`→NaN）。fast path を **ExpressionStatement（破棄文脈）限定**にガードし、値利用時は length を
      正しく返す `array.push` builtin に流す。破棄文脈の hot path は不変。
    検証 vs V8: push/unshift（複数/単一/戻り値利用/ループ内/any）、push 破棄文脈、すべて一致。

検証 vs V8: 全項目一致。全 CI 緑（conf 111/111, ci_fast/unit/bench すべて PASS）。perf 中立。
追加 conformance: arrays/push_unshift_return.ts。

## セッション 28（Object.fromEntries が非配列イテラブルを受け付けない）

64. **`Object.fromEntries(map)` 等の非配列イテラブルが空オブジェクトになる（silent miscompile）**:
    `ts_object_from_entries` は `ts_is_array` のときしか処理せず、Map/Set/generator を渡すと `{}` を返し、
    `.a`→NaN（値型 number ゆえ）。修正: 非配列なら `ts_array_push_all` で [k,v] ペア配列に materialize
    してから処理（push_all は Map を [k,v] ペアに展開済）。配列はそのまま通過（fast path）。
    検証 vs V8: Map / 配列 / Object.entries().map() / generator、すべて一致。

検証 vs V8: 全項目一致。全 CI 緑（conf 112/112, ci_fast/unit/bench すべて PASS）。perf 中立。
追加 conformance: object_methods/from_entries_iterable.ts。

## セッション 29（Number.toPrecision の指数/十進判定と指数書式）

65. **`Number.toPrecision` が `%g` 任せで判定・書式が V8 とずれる（silent miscompile）**:
    `(0.00001234).toPrecision(2)`→aot `"1.2e-05"`(node `"0.000012"`)、`(123456).toPrecision(3)`→
    aot `"1.23e+05"`(node `"1.23e+5"`)。spec 準拠で再実装: まず `%.{p-1}e` で仮数を p 桁に丸め（printf が
    丸めと桁上がり 9.99→1.0e+1 を正しく処理）、その指数 e を取得。**e < -6 または e >= p で指数表記、
    それ以外は固定小数**（固定の小数桁=p-1-e）。指数書式は 2 桁指数の先頭ゼロを除去（`e+05`→`e+5`）。
    桁上がり（9.99→10, 9.95→9.9 等）も %e の丸め結果から正しく分岐。0/NaN/Infinity も処理。
    検証 vs V8: 小/大/通常/整数/0/負/境界(1e-4,1e-7)/桁上がり(99.9,9.99,9.95,9999)/any、すべて一致。

検証 vs V8: 全項目一致。全 CI 緑（conf 113/113, ci_fast/unit/bench すべて PASS）。perf 中立。
追加 conformance: numbers/to_precision.ts。
注: toPrecision の丸めは printf の丸めに委譲（差分ハーネスは同一マシンの node と比較するため整合）。

## セッション 30（Promise.resolve / Promise.reject + 他 Promise static の loud-reject）

66. **`Promise.resolve(v)` / `Promise.reject(v)` 未対応で実行時 abort（misleading）**: これらは exporter で
    検出されず、汎用の動的メソッドディスパッチに落ちて「method is not a function」で abort していた
    （silent miscompile 寄り: コンパイルは通るが誤コード）。runtime には既に `ts_promise_resolved`/
    `ts_promise_rejected` があるので exporter で `Promise.resolve/reject` を検出し `promise.resolve`/
    `promise.reject` builtin に、emit_c で各 runtime に接続。`await Promise.resolve(x)` / `await Promise.reject(e)`
    （try/catch 捕捉）が動く。**他の Promise static（all/race/allSettled/any）は明示的に loud-reject**
    （誤った動的ディスパッチ→実行時 abort を、クリーンな exporter reject に置換）。
    検証 vs V8: resolve(数値/オブジェクト)/reject+catch/await 連鎖/ユーザ async 関数、すべて一致。

検証 vs V8: 全項目一致。全 CI 緑（conf 114/114, ci_fast/unit/bench すべて PASS）。perf 中立。
追加 conformance: closures/promise_resolve_reject.ts。

### pending 追記
- **Promise.all / race / allSettled / any と .then / .catch / .finally**: スケジューラ/コールバック登録の
  実装が必要（中規模機能）。現状 static 群は loud-reject、`.then` 等は promise 値へのメソッド呼びとして
  実行時 abort（受け手が Promise 型と判る場合の loud-reject 化も将来課題）。

## セッション 31（String.replace の空パターン）

67. **`"abc".replace("","X")` が空パターンで文字列を変更しない（silent miscompile）**: 空パターンは
    index 0 でマッチ（replace→`"Xabc"`）、replaceAll は各文字間＋両端でマッチ（`"XaXbXcX"`）。旧 `ts_str_replace`
    は `p->len==0` で文字列を素通しにしていた。空パターン専用分岐を追加（replace は先頭に rep、replaceAll は
    各文字の間と末尾に rep を挿入）。GC root 付き。通常の置換・$ パターンは不変。
    検証 vs V8: replace/replaceAll の空パターン（通常文字列・空文字列）、通常置換、$ パターン、すべて一致。

検証 vs V8: 全項目一致。全 CI 緑（conf 114/114, ci_fast/unit/bench すべて PASS）。perf 中立。
conformance: strings/replace_patterns.ts に空パターンケース追加。
注: Math.sign(-0)→0（node -0）は既知の -0 表現の限界（整数 unbox が符号落ち, pending）。

## セッション 32（Number の 0b/0o プレフィックス + Math.max/min/hypot のスプレッド）

68. **`Number("0b101")`/`Number("0o17")` が NaN（silent miscompile）**: `Number()` は strtod 任せで、strtod は
    0x（16進）は扱うが JS 固有の 0b（2進）/0o（8進）は扱わない。`ts_number_coerce` の文字列分岐に 0b/0o 判定を
    追加（先頭空白スキップ→prefix 検出→`strtoll(base 2|8)`、桁無しや余分文字は NaN）。0x・通常・空文字・空白は不変。
69. **`Math.max(...arr)` 等スプレッド引数が REJECT**: 可変長畳み込みは静的引数のみ対応で、スプレッドは
    実行時長が不定のため畳めなかった。スプレッド引数があれば全引数を配列に materialize（AllocArray +
    ArrayPush/ArrayPushAll）して runtime `ts_math_max_arr`/`min_arr`/`hypot_arr`（各要素 ToNumber 強制変換、
    max/min は NaN 伝播、種 -Inf/+Inf/0）に渡す。混在 `Math.max(1,...a,5)` や空スプレッドも対応。
    検証 vs V8: Number(0b/0o/0x/不正/通常)、Math.max/min/hypot のスプレッド（純/混在/NaN/空/明示引数）、すべて一致。

検証 vs V8: 全項目一致。全 CI 緑（conf 115/115, ci_fast/unit/bench すべて PASS）。perf 中立。
追加 conformance: numbers/number_prefixes_math_spread.ts。

## セッション 33（Array.includes の fromIndex + Number.toString(radix) の小数部）

70. **`Array.includes(x, fromIndex)` が fromIndex を無視（silent miscompile）**: indexOf は修正済だったが
    includes は未対応。`[1,2,3].includes(1,1)`→node false だが tsaot true。`ts_array_includes` に from/has_from
    追加（負は末尾から）。SameValueZero/NaN 一致は維持。emit_c に n(1)/has(1)、プロト wrapper 4 引数化。
71. **`(255.5).toString(16)` が小数部を捨てる（silent miscompile）**: radix 変換が整数部のみ。`"ff.8"`→`"ff"`。
    Steele & White 法で小数部を実装: 残り小数が half-ULP（`nextafter` で算出）以内になるまで桁を出力し、
    最終桁を丸め（桁上がりは小数桁→整数桁へ '.' をまたいで伝播、MSB 超えは '1' 挿入）。これにより**終端する
    小数（偶数基数/2 冪基数, 255.5→ff.8）も非終端の奇数基数（(0.1).toString(3)）も V8 と一致**する最短表現を生成。
    整数部は double 除算でオーバーフロー回避。Infinity/-Infinity/NaN も処理。
    検証 vs V8: includes(from/負/SVZ)、toString(終端/非終端 base2-36/負/丸め桁上がり/整数/小数)、すべて一致。

検証 vs V8: 全項目一致。全 CI 緑（conf 116/116, ci_fast/unit/bench すべて PASS）。perf 中立。
追加 conformance: numbers/tostring_radix_fraction.ts。
注: 小数の桁数/丸めは printf でなく明示算出（nextafter ベース）。同一マシン node と一致。

## セッション 34（do-while の break/continue 対応 + 本体二重生成の解消）

72. **do-while 内の `break`/`continue` が loud-reject（既知の限界）+ 本体が IR に二重生成されていた**:
    旧 lowering は本体を「プレリュード（1回）+ Loop（条件付き再実行）」として**2 回 emit**し、プレリュード側の
    break/continue は loop に対応づかないため reject していた。単一 Loop に作り替え: `first` フラグで初回は
    top-of-loop 条件を真にし、2 回目以降は条件を再評価（condBody 内で `cond = first ? true : COND; first=0`）。
    `continue` は Loop が condBody を再実行する＝条件再チェックなので do-while 意味論と一致、`break` も通常の
    ループ機構で動く。本体は 1 回のみ生成。
    **バグ修正（実装中に発見）**: 当初 condLocal を primitive(double) にして条件(boxed boolean, 例 `i<5`)を
    Copy したため `ts_to_num(bool)=NaN`→`NaN!=0` が常に真で**無限ループ**に。condLocal を reference(boxed)化し
    truthy() で判定するよう修正。
    検証 vs V8: do-while の continue/break/初回必ず実行/false 条件/ネスト break/for 内 do-while/通常 while 不変、
    すべて一致。

検証 vs V8: 全項目一致。全 CI 緑（conf 117/117, ci_fast/unit/bench すべて PASS）。perf 中立。
追加 conformance: control/do_while.ts。既知の限界から「do-while の break/continue」を解消。

## セッション 35（static フィールド継承 + struct 重複メンバ codegen バグ）

73. **static フィールドの継承が未対応（silent miscompile）**: `class A{static x=5}class B extends A{}` で `B.x`→
    NaN（node 5）。旧 lowering は `classStaticGlobal.has(cid)` のときのみ static アクセスと認識し、自身に static
    コンテナを持たない B では素通り→generic 読みで NaN。修正: static フィールド宣言名を `classStaticFieldNames`
    に収集し、アクセス時に **その static を宣言する最寄りクラス（自身→祖先）のコンテナから読む**
    （`staticFieldClassOf`）。override は宣言する subclass を優先＝シャドウ。3 段継承・継承+独自・型付き、すべて一致。
74. **同名フィールドを持つ 2 クラスが prefix 継承で struct 重複メンバを生成し gcc エラー（pre-existing codegen バグ）**:
    `struct Class1 { ... tsv f2; tsv f2; }`（親 Class0 の f2 + 自身の f2）。`emit_field_chain` が親→自身の順に
    own_fields を出力する際、祖先が既に宣言した field id を重複出力していた。seen セットを通して**祖先が宣言済みの
    field はスキップ**（prefix 継承/同名再宣言は同一スロット再利用）するよう修正。static override（`P.v`/`Q.v`）が
    コンパイル可能に。**コア codegen 変更のため inherit_sroa 等の bench で perf・正しさを検証（全 budget 内）**。
    検証 vs V8: static 継承（basic/3段/継承+独自/override/型付き/メソッド経由）、すべて一致。

検証 vs V8: 全項目一致。全 CI 緑（conf 118/118, ci_fast/unit/bench すべて PASS, inherit_sroa 70ms<130）。perf 中立。
追加 conformance: statics/static_inheritance.ts。

## セッション 36（static メソッド継承）

75. **static メソッドの継承が未対応（silent miscompile）**: `class A{static make(){return 42}}class B extends A{}` で
    `B.make()` が見つからず空出力（node 42）。static 呼び出しサイトは `staticMethodFunc.get(cid:static:name)` を
    自身のみで引いていた。クラス chain を `parentIdOf` で遡って祖先の static メソッドを解決するよう修正
    （#73 の static フィールド継承と同じパターン）。override は最寄り subclass を優先。
    検証 vs V8: 継承/引数付き/3 段/override/独自/フィールド併用、すべて一致。

検証 vs V8: 全項目一致。全 CI 緑（conf 118/118, ci_fast/unit/bench すべて PASS）。perf 中立。
conformance: statics/static_inheritance.ts に static メソッド継承ケース追加。
注: `Object.fromEntries(...)` 等で存在しないキー `o.a`（型 number, index signature）を読むと NaN（node undefined）。
これは「欠損プロパティを number として unbox→NaN」の既知クラス（unboxing 最適化のトレードオフ, pending）。

## セッション 37（オブジェクトリテラルの数値キー）

76. **オブジェクトリテラルの数値キー（`{0:"a",1:"b"}`）が loud-reject**: 直接（非 computed）PropertyAssignment は
    Identifier/StringLiteral キーのみ処理し、数値リテラルキー（`0:`, `1:`, `1.5:`）は未対応で reject。JS では
    数値キーはその文字列形（"0", "1", "1.5"）になる。第1分岐に `ts.isNumericLiteral(p.name)` を追加し
    `String(Number(text))` で intern（computed 数値キーの既存処理と同じ）。
    検証 vs V8: 数値キー定義/`o[0]`・`o["0"]` アクセス/混在キー/小数キー/JSON 化/文字列キー不変、すべて一致。

検証 vs V8: 全項目一致。全 CI 緑（conf 119/119, ci_fast/unit/bench すべて PASS）。perf 中立。
追加 conformance: objects/numeric_keys.ts。

## セッション 38（String.split の負の limit）

77. **`"a,b,c".split(",",-1)` が空配列（silent miscompile）**: limit を `(uint32_t)ts_to_num(limit)` で変換して
    いたが、負の double→unsigned キャストは未定義動作（この環境では 0 相当→空配列）。spec は ToUint32 なので
    `split(sep,-1)`→4294967295（事実上無制限）。`(uint32_t)(int64_t)ts_to_num(limit)` で正しく ToUint32 ラップ。
    検証 vs V8: 負 limit / limit 2 / limit 0 / 大きい limit、すべて一致。

検証 vs V8: 全項目一致。全 CI 緑（conf 119/119, ci_fast/unit/bench すべて PASS）。perf 中立。
conformance: strings/split_limit.ts に負 limit ケース追加。

## セッション 39（String.includes の position 引数）

78. **`"hello".includes("lo",10)` が position 引数を無視（silent miscompile）**: node では false（開始位置が
    末尾超え）だが tsaot は true。`ts_str_includes` が `ts_str_indexof(s,needle,0,0)` と固定 0 で呼んでいた。
    pos/has_pos 引数を追加し indexof に伝播（emit_c に n(1)/has(1)、プロト wrapper 4 引数化）。
    検証 vs V8: 末尾超え position / 見つかる position / position なし / 空 needle / any、すべて一致。

検証 vs V8: 全項目一致。全 CI 緑（conf 120/120, ci_fast/unit/bench すべて PASS）。perf 中立。
追加 conformance: strings/includes_position.ts。

## セッション 40（parseInt の符号直後の空白/二重符号）

79. **`parseInt("- 5")` が -5（silent miscompile, 正 NaN）**: 先頭空白＋符号を手動処理した後 `strtol` を呼ぶが、
    strtol 自身が先頭空白をスキップ＆もう一つの符号を消費するため、符号直後の空白（`"- 5"`）や二重符号（`"--5"`,
    `"+-5"`）を誤って受理。JS は符号直後に数字が必須。strtol 呼び出し前に「現在位置が空白/符号なら NaN」ガードを追加。
    検証 vs V8: `"- 5"`/`"--5"`/`"+-5"`→NaN、通常/基数/空/`"-0x10"`/`"+0xFF"`（符号付き hex）すべて一致。

検証 vs V8: 全項目一致。全 CI 緑（conf 121/121, ci_fast/unit/bench すべて PASS）。perf 中立。
追加 conformance: numbers/parseint_sign.ts。
注: `(n).toLocaleString()`（桁区切り 1,000,000）はロケール依存で未実装（loud-reject, pending）。

## セッション 41（単項 + の ToNumber 強制変換）

80. **単項 `+x` が文字列/null を強制変換しない（silent miscompile）**: `+""`→空(正 0)、`+"abc"`→"abc"(正 NaN)、
    `+null`→"null"(正 0)。`+x` を `Copy dst(primitive)=operand` で済ませており、非数値オペランドを
    ToNumber しなかった（`+"42"` は偶然 42 に見えていた）。修正: オペランド型が **NumberLike なら identity Copy
    （unboxed 高速経路維持）、それ以外は `number.coerce`（ts_number_coerce=ToNumber）**。null/undefined/string/
    any/object すべて正しく coerce（""→0, "abc"→NaN, null→0, undefined→NaN, object→ToPrimitive）。
    検証 vs V8: 文字列/any/数値/bool/null/undefined/空白/0x/式中、すべて一致。perf 中立（数値は Copy のまま）。

検証 vs V8: 全項目一致。全 CI 緑（conf 122/122, ci_fast/unit/bench すべて PASS, 全 kernel budget 内）。
追加 conformance: coercion/unary_plus.ts。

既知の限界（セッション41 探索で判明, 修正中の test を調整）: exporter は `strict: false` でコンパイルするため
TS が型から `| undefined` を消去する。よって **未初期化の `let u: number | undefined` は `number` 扱い
（unboxed double, デフォルト 0）になり、未代入で読むと `undefined` でなく `0`**（node は undefined）。
`string | undefined` 等（reference 側）や `any` は undefined 維持で正しい。未初期化変数を読むのは稀かつ
コードスメルで、strict:true 化は型分類全体に波及するため pending。

## ツール改善（CI 並列化）

**`scripts/ci_par.sh` を追加（並列 CI ゲート）**: 従来は 6 ゲート（conformance basic+exhaustive / ci_fast /
bench-correct 1&2 / bench-perf）を逐次実行し、各々が cargo/tsc を再ビルドしていた。新ドライバは:
1. **analyzer(cargo) と exporter(tsc) を最初に 1 回だけ並列ビルド**（以降のゲートの再ビルドガードが no-op に）。
2. **正しさ系ゲートを並列実行**（conformance basic/exhaustive, unit/runtime/golden/fetch/negative,
   bench-correct 1&2）。各ゲートは `mktemp -d` で scratch を隔離するので並列でも競合しない（10 コア）。
3. **perf（タイミング計測）だけ単独実行**（並列 CPU 負荷は budget を誤って膨らませるため隔離必須）。
4. pass/fail サマリ表示、失敗ゲートのログ末尾を出力。

計測（同一マシン, warm）: **逐次 6 ゲート 79.2s → 並列 42.4s（約 2x）**。cold（フル cargo build 込み）は ~91s。
`bash scripts/ci_par.sh` 単一コマンドで全ゲート（exit 0=全緑）。bash 3.2 互換（`declare -A` 不使用、rc ファイル方式）。
正しさ・perf 判定は従来と同等（perf は単独実行で計測精度維持）。

## セッション 42（pending #1 解決: `return this` + SROA の silent miscompile）

81. **メソッドが `return this` し、その戻り値経由でフィールドを読むと silent miscompile（pending #1, 実害最大）**:
    `class B{v=0;add(n){this.v+=n;return this;}}` で `const r=b.add(5); r.v`→NaN、`b.add(1).add(2)` チェーンも空。
    原因: SROA が `b` のフィールドをスカラ（d-local）に置換するが、`add` がインライン展開で `return this` →
    呼び出しの dst がレシーバの**エイリアス**になり、`ts_get(オブジェクトポインタ, field)` で読まれるため、
    スカラ値とオブジェクト実体（未書戻し=stale）が乖離。
    **保守的修正（§4 のエスケープ拡大の方針に沿う）**: `returns_receiver(callee)` 述語を新設
    （callee が param0=`this` を直接 or copy 経由で Return するか）。Direct メソッド呼び出しで callee が
    `returns_receiver`（または既存の `captures_this`）ならレシーバを **scalar-replace 除外**（escape 扱い）。
    レシーバは実オブジェクトとして残り、戻り値エイリアス経由のフィールド読みが正しく動く。
    **perf 検証（コア SROA 変更ゆえ重点）**: `returns_receiver` は `return this` するメソッドのレシーバのみ
    除外。kernel 群（inherit_sroa 67/130, obj 151/290, typed_field 129/240）は `return this` を使わないため
    **全 budget 内・回帰なし**。
    検証 vs V8: single/chain2/chain3/nochain/typed/copy 経由 this/通常メソッド（this 非返却）、すべて一致。

検証 vs V8: 全項目一致。全 CI 緑（conf 123/123, ci_par 全 PASS, perf 全 budget 内）。
追加 conformance: classes/return_this_chain.ts。**pending #1 を解決。**

## セッション 43（pending: Number.toFixed の丸め）

82. **`(1.45).toFixed(1)`→"1.5"（正 "1.4"）, `(2.675).toFixed(2)`→"2.68"（正 "2.67"）の丸め誤り（pending 解決）**:
    旧実装は `x * 10^d` で浮動小数スケールしてから半数切り上げしていたが、`1.45*10` 等のスケールで FP 誤差が
    生じ tie に化けて誤って切り上げていた。**修正: double の正確な十進展開（`%.{d+30}f` のガード桁）に対して
    d 桁目を手動で half-away 丸め**（桁上がりは桁列インクリメントで伝播, MSB 超えは '1' 前置）。これにより
    1.45(=1.4499...)→1.4 / 2.675(=2.67499...)→2.67 と、**正確な tie（2.5→3, 0.125→0.13, 0.375→0.38）の
    away 丸め**を両立。NaN/Infinity/|x|>=1e21（指数フォールバック）/負値/-0 回避/ゼロ詰めも処理。
    検証 vs V8: 1.45/2.675/1.005/各種 tie/桁上がり(9.95→9.9,9.99→10.0,9.999→10.00)/負/大きい数/ゼロ詰め、
    すべて一致。

検証 vs V8: 全項目一致。全 CI 緑（conf 124/124, ci_par 全 PASS, perf 全 budget 内）。
追加 conformance: numbers/to_fixed.ts。**pending（toFixed 丸め）を解決。**

## セッション 44（pending: ラベル付き多段 break/continue）

83. **ラベル付き多段 `break L` / `continue L`（外側ループ対象）が loud-reject だった（pending 解決）**:
    `outer: for{ for{ break outer } }` 等が「multi-level jump not yet modeled」で拒否されていた。
    **設計: depth-indexed labeled-goto**（既存の loop ラベル基盤を再利用）。
    - **IR**（escape_ir.rs）: `Break,`/`Continue,` を `Break { up:u32 }`/`Continue { up:u32 }` に
      （`#[serde(default)]`, up=ターゲットまでのループ階層数, 0=最内=従来挙動, 既存 IR は up=0 にデシリアライズ）。
    - **exporter**: ラベル付き break/continue を switch/innermost 特例より前で処理するよう再構成。targetLabel を
      loopLabels で最内から外へ探索して depth d を算出。d=0 は従来通り。d≥1 は多段: `{kind:Break,up:d}` /
      （continue は**ターゲットループ種別が continue-safe (while/forc/forof_gen) のときのみ**）`{kind:Continue,up:d}`。
    - **emit_c 構造化パス**: `Inst::Loop` が出す関数スコープの `L<top>`/`L<end>` ラベルと `loop_labels` スタックを
      利用し、up≥1 は `goto L<end_target>`（break）/`goto L<top_target>`（continue, cond_body 再実行=増分）。
      関数スコープラベルなので入れ子 for(;;) からの goto は合法 C。
    - **emit_c async/generator フラットパス**: `idx = loops.len()-1-up` でターゲットを選択。
    - **安全策（保守的）**: 多段(up≥1)が try/finally 内にある場合は loud-reject（構造化 finally パスは単一ループのみ
      モデル化のため）。多段 continue のターゲットが for-of-array（増分が body 末尾）の場合も loud-reject。
    検証 vs V8: 2/3段 break、while/forc/forof_gen への continue、switch 内からの break outer、最内ラベル(degenerate)、
    **async 関数・generator の多段 break/continue（フラットパス）**、すべて一致。reject: forof-array への continue、
    try/finally 内の多段ジャンプ、すべてクリーンに loud-reject。

検証 vs V8: 全項目一致。全 CI 緑（conf 125/125, ci_par 全 PASS, perf 全 budget 内・回帰なし）。
追加 conformance: control/labeled_break_continue.ts。stale negative test 更新（rejects_syntax.sh: 多段 continue→
forof-array continue + finally 内多段の reject に差し替え）。**pending（ラベル付き多段 break/continue）を解決。**

### 既知の限界（多段 break/continue）
try/finally の中／を跨ぐ多段 break/continue は未対応（loud-reject）。for-of-array 外側への多段 continue も loud-reject。

## セッション 45（pending: Promise.all / Promise.race + 潜在的 coro GC バグ）

84. **`Promise.all` / `Promise.race` 未対応（loud-reject）→実装**: async ランタイムは coroutine ベースで
    promise の waiter は coroutine のみ（.then コールバック無し）。combinator は「出力 promise + 各入力ごとの
    軽量アダプタ coroutine」で実装。
    - **runtime**: `ts_promise` に `comb_remaining`/`comb_results` 追加（ts_promise_new で 0/undefined 初期化、
      gc_mark_async PROMISE で comb_results をマーク）。アダプタ構造体 `ts_comb {ts_coro c; tsv out_v; double idx;}`
      （out_v/idx は ts_coro 後ろ＝frame scan 対象, out_v=promise はマーク, idx=double は誤マークされない）。
      `comb_all_resume`（結果配列へ idx 位置に格納, 残数 0 で resolve, 最初の reject で reject）/`comb_race_resume`
      （最初の settle で確定）。`ts_promise_all`/`ts_promise_race`（非配列は ts_array_push_all で materialize,
      **alloc ループ前に outv/arrv を ts_gc_root**）。
    - **emit_c**: `promise.all`→`ts_promise_all(v(0))`, `promise.race`→`ts_promise_race(v(0))`。
    - **exporter**: Promise namespace で all/race を許可（allSettled/any は loud-reject 継続）。
85. **潜在的 GC バグ修正（`ts_coro_alloc`/`ts_coro_new`）**: coroutine を gc_alloc した直後、未 root のまま
    `c->ret=ts_promise_new()` を呼ぶ窓があり、その alloc が GC を誘発すると**まだ参照されていない coro が回収**
    される（かつ frame_size 未設定で frame scan も不正）。通常 async（1 呼び出し=1 coro）では顕在化しにくいが、
    Promise.all が 1 回で 20 アダプタを連続生成するため露見（GC stress で結果が NaN に）。修正: frame_size を
    先に設定＋c->ret=NULL にしてから coro を ts_gc_root し、c->ret 確保後に unroot。**全 async 経路に効く潜在バグ**。
    検証 vs V8: all(混在/空/順序/map async/reject)、race(resolve/reject/async producer)、Set/generator over、
    ネスト、GC stress(50×20→9500, 30×10→1350)、すべて一致。allSettled は loud-reject 継続。

検証 vs V8: 全項目一致。全 CI 緑（conf 126/126, ci_par 全 PASS, perf 全 budget 内, async bench 緑）。
追加 conformance: closures/promise_all_race.ts。**pending（Promise.all/race）を解決。**
既知の限界: 入力が「pending な promise に解決する promise」の再帰的アンラップは非対応（既存 v1 thenable 簡略化と同様）; allSettled/any 未実装。

## セッション 46（pending: Promise .then/.catch/.finally + allSettled/any）

86. **Promise インスタンスメソッド `.then`/`.catch`/`.finally` + statics `allSettled`/`any` 実装**:
    session 45 の combinator パターンを拡張。`.then` のコールバックはユーザ関数で**throw しうる**のが新点。
    - **runtime ヘルパ `ts_call_catching(fn,args,n,*threw)`**: setjmp(ts_eh_push の handler buf) で囲んで
      `ts_call_value`、throw されたら GC root depth 復元＋handler pop して捕捉値を返す（構造化 try/catch と同型）。
    - **`.then`/`.catch`/`.finally`**: アダプタ `ts_then {ts_coro c; tsv out_v; tsv cb0; tsv cb1;}`。
      `then_resume`（fulfill→cb0/reject→cb1、未指定はパススルー、コールバック結果で out を resolve（thenable は
      ts_promise_resolve が採用）、throw なら reject）。`finally_resume`（onFinally を無引数で呼び、throw なら
      その reject、それ以外は**元の値/理由をパススルー**）。`ts_promise_then/catch/finally`（GC root しつつ登録）。
    - **`allSettled`/`any`**: `ts_comb` 再利用。allSettled は never-reject で各要素を `{status,value|reason}`
      （`ts_allsettled_result`）に。any は最初の fulfill で resolve、全 reject で `ts_aggregate_error`
      （`{name:"AggregateError",message:"All promises were rejected",errors}`）で reject。空配列: allSettled→[]、
      any→AggregateError。
    - **emit_c**: promise.then→ts_promise_then(r,v(0),v(1)), catch/finally 同様, allSettled/any statics。
    - **exporter**: builtinReceiverKind に "promise"（sym.name==="Promise" or /^Promise(Like)?</）、
      builtinMethodName2 に then/catch/finally、statics に allSettled/any。
    検証 vs V8: then(変換/連鎖/promise返却採用/throw捕捉/onRejected引数)、catch(reject捕捉/fulfillスキップ)、
    finally(両経路/パススルー/throw)、allSettled(混在/全成功/空)、any(最初fulfill/全reject AggregateError/空/混在)、
    GC stress、すべて一致。

検証 vs V8: 全項目一致。全 CI 緑（conf 127/127, ci_par 全 PASS, perf 全 budget 内, async bench 緑）。
追加 conformance: closures/promise_then_combinators.ts。**pending（Promise .then/.catch/.finally + allSettled/any）を解決。**
既知の限界: コールバック/onFinally が pending promise を返す場合の再帰的待機は非対応（v1 thenable 簡略化）; e instanceof AggregateError は false（タグ付きオブジェクトでコンストラクタ非モデル化）。

## セッション 47（pending: クラス computed メンバ名）

87. **クラス computed メンバ名（リテラルキー）`["m"](){}`/`get ["x"](){}`/`["k"]=v`/`static [...]` 実装**:
    従来は well-known symbol（`[Symbol.iterator]`/`[Symbol.asyncIterator]`）以外の computed
    クラスメンバを**全て silently drop し class を stable=false** にしていた（メソッド本体が一切
    lower されず `obj.m()` がメソッドを見つけられない silent-miscompile リスク）。string/numeric
    **リテラル**キーは通常の named メンバと意味的に同一なので、コンパイル時に文字列キーへ解決して
    named パスへ流す。dynamic（変数/式/ユーザ symbol）computed 名は従来どおり stable=false で
    loud-reject（実体は未 lower → 実行時 TypeError、silent な誤値ではない）。
    - **新ヘルパ `memberKeyName(nameNode)`**（`exporter/class_extract.ts` に export）:
      Identifier/StringLiteral/PrivateIdentifier→`.text`、NumericLiteral→`String(Number(text))`、
      ComputedPropertyName は式が string/numeric リテラルのときのみ解決、それ以外（dynamic/symbol）は
      `undefined`。object-literal computed キー（`exporter.ts:869-887`）の既存処理と同型。
      well-known symbol は `undefined` を返すので既存 wellKnownSym/wkName 経路が優先のまま。
    - **class_extract.ts メンバループ**: silent-drop を `mn = wellKnownSym ?? memberKeyName(...)`
      に置換し、`undefined`（=dynamic）のときだけ stable=false continue。リテラルキーは ownMethods/
      ownFields に入り class は stable のまま（devirt/monomorphization 継続）。
    - **exporter.ts**: setupClasses の登録ガード 6 箇所（static method/static field collect/instance
      method/getter/setter/static field init）と monomorphization clone の `ts.isIdentifier(...)`
      チェーンを `memberKeyName(m.name) !== undefined` に緩和し、解決済み文字列をキーに使用。
      instance field init は `if (isComputedPropertyName) continue;` を削除し memberKeyName で解決
      （dynamic は静的スロット無しで skip）。static field init は string-literal static field が
      collect されながら init されない既存ギャップも併せて解消。
    - **analyzer（devirt.rs/emit_c.rs）/runtime は無改変**: `internName`/`internField`/devirt は
      interned Name id（文字列）ベースで構文形を見ない。`["m"]` 由来の "m" は `m()` と同一 devirt。
    検証 vs V8: computed メソッド/getter/setter/field/numeric field/static computed、devirt hot path
    （computed-literal メソッドを homogeneous 配列上で集計）、named+computed 同名衝突（last-wins）、
    `[Symbol.iterator]` 回帰、dynamic computed（`const k="m"; [k](){}`）は loud（実行時 TypeError）。
    全 CI 緑（conf 128/128, ci_par 全 PASS, perf 全 budget 内）。
    追加 conformance: classes/computed_member_names.ts。**pending（クラス computed メンバ名）を解決。**
    既知の限界: dynamic/symbol-keyed computed メンバは loud-reject 継続（stable=false）; named と
    computed-literal が同一キーに解決する場合は methodFunc 上書きで last-wins（JS 準拠）。

## セッション 48（pending: クラス dynamic/symbol-keyed computed メンバ）

88. **クラス dynamic / symbol-keyed computed メンバ（`[k](){}`/`[sym]=v`/`[k]=v`）実装**:
    セッション47 はリテラルキー（`["m"]`）を vtable 経路に通した。本件は**実行時にしかキーが
    決まらない** dynamic（変数/式）・symbol キー。これらは vtable/固定レイアウトに入れられず
    （class は stable=false）、**construction 時にインスタンスへ動的プロパティとして install** する。
    従来は class_extract で silently drop され、`c[k]()` は実行時に「method not a function」だった。
    - **install（exporter のみ）**: `installDynamicMember(ctx,obj,m,thisParam)` を新設し、
      `emitFieldInitializers`（インスタンス）から呼ぶ。object-literal computed メンバ処理
      （exporter.ts ~861-938）と同型: string/numeric キー→`StoreFieldDynamic`（ts_set_dyn が実行時
      intern）、symbol キー→`symbol.set` builtin（ts_set_symkey）。メソッドは `lowerClosure`(this は
      呼び出し時バインド) で data-property closure 化。fnId は assignIds で事前採番
      （`isDynComputedInstallMethod`）。`memberKeyName`/`wellKnownMethodName` が共に undefined の
      computed メンバだけが対象（リテラル・@@iterator は従来経路）。
    - **dispatch**: `c.foo()` は stable=false で sentinel recvClass→`emit_method_value_lookup` が
      own field-key を先に引く（install した closure を発見）。`c[k]()`/`c[sym]()` は
      element-access call として lower（下記修正）。
    - **`o[k]()` の this バインド修正（汎用バグ修正）**: 従来 element-access call は Value fallback で
      `ts_call_value`（this=undefined）になり、`c[k]()` のメソッド this が壊れていた。exporter で
      `o[k](...)` を base を1回評価→メンバ load→`recv=base` の Value callee に lower し、emit_c で
      **recv 付き Value callee は `ts_call_method`**（recv を this）に。`arr[i]()` 等も JS 準拠に改善。
    - **idempotency ガード**: `lowerFunctionLike` に loweredFnIds ガード追加。explicit-ctor の無い
      クラスを複数箇所で `new` すると field-init closure が new サイト毎に lower され同一 id 重複
      （sort のみで dedup 無し→C 再定義）になる潜在バグも解消。
    - **loud-reject（silent miscompile 回避）**: (a) **explicit constructor を持つクラスの dynamic/
      symbol メンバ**（install が ctor 本体に移り、キー/本体の自由変数を ctor が capture できない
      既存制約。`field = outerLocal` 初期化子も同様に壊れる既知の制約）; (b) **static** dynamic/symbol
      メンバ（クラス識別子を値として使うと static container に解決されない既存ギャップ。`const cc=C;
      cc.named` も壊れる）; (c) dynamic/symbol の **getter/setter**・**generator/async メソッド**。
      いずれも this.unsupported でコンパイル時拒否。
    検証 vs V8 全一致: dynamic field/method, symbol field/method, [Symbol.toPrimitive] 格納,
    mixed（named+dynamic 同居）, 継承（explicit-ctor 無し）, リテラル・@@iterator 回帰。reject 各種は
    loud。全 CI 緑（conf 129/129, ci_par 全 PASS, perf 全 budget 内）。
    追加 conformance: classes/computed_dynamic_members.ts。reject: rejects_syntax.sh に 3 件追加。
    **pending（クラス dynamic/symbol computed メンバ）を解決。**
    既知の限界: explicit-ctor / static / accessor / generator-async の dynamic-key 形は loud-reject;
    インスタンス computed キーは（per-instantiation でなく）construction 毎に評価。

## セッション 49（§48 の根因: field=outerLocal + explicit-ctor の capture）

89. **クラス field initializer / dynamic-key の constructor capture（module-scope 解決）**:
    §48 は explicit-ctor を持つクラスの dynamic/symbol computed メンバを一律 loud-reject にした。
    根因は**既存の capture ギャップ**で、素の field initializer も壊れていた:
    `const z=7; class C { x=z; constructor(){} }` → `new C().x` が 0（silent miscompile）。
    field initializer と computed key は **constructor 本体内**で lower される（emitFieldInitializers,
    ctor から呼ばれる）が、module-cell の publish 解析は method **本体**（freeVars）と **static**
    field initializer（Step F）しか走査せず、**instance** field init/key を見ないため、参照された
    module binding が publish されず ctor 内で空ローカルを読む。explicit-ctor が無い場合は new サイト
    （caller scope）で inline 実行されるため解決でき、explicit-ctor の時だけ顕在化していた。
    - **module-scope**: ctor 本体が module const を読むのは**既に動く**（publish 済み cell を
      LoadGlobal）。欠けていたのは field-init/key 由来の参照の publish のみ。**Step F'** を追加:
      Step F と同型に、各クラスの instance field initializer + dynamic computed key 式 + install
      する dynamic method 本体を走査し module-scope 参照を moduleCellGlobal へ publish。さらに
      installed dynamic method を **method-like**（lowerClosure に classId 伝播）で lower し、
      module-cell binding を capture せず LoadGlobal で読むよう修正（従来は普通の closure として
      capture しようとし、ctor は当該 cell を持たず missingCell→NaN だった）。
    - **function-local**（関数内に宣言したクラスが囲み関数のローカルを参照）: ctor は Direct 呼び
      出しで cell を thread できず（directCallCellArgs は module cell のみ）、根本的に不可。
      `memberCapturesFunctionLocal` / `anyFunctionLocalCapture`（symbolOwnerFunction が
      moduleInitNode 以外＝囲み関数ローカル）で検出し loud-reject。これにより **素の
      `field = functionLocal` + explicit-ctor の従来 silent-0 も loud-reject 化**（silent→loud）。
    - §48 の「explicit-ctor は一律 reject」を撤廃し、module-scope/無 capture は許可、function-local
      capture のみ reject に絞った。
    検証 vs V8: module-scope field-init/dynamic-key/symbol-field/method-body-capture + explicit-ctor
    が全一致、継承・no-ctor・literal・[Symbol.iterator] 回帰。function-local + explicit-ctor（field
    init / dynamic member）は loud-reject。全 CI 緑（conf 129/129, ci_par 全 PASS, perf 全 budget 内）。
    conformance: classes/computed_dynamic_members.ts に explicit-ctor + module-capture を追加。
    rejects_syntax.sh の §48 explicit-ctor 行を function-local-capture 版へ更新。
    既知の限界: 関数内クラスが囲み関数ローカルを field init/computed key/method body で参照し、かつ
    explicit-ctor を持つ場合は loud-reject（module scope へ移すか explicit-ctor を外せば可）。

## セッション 50（function-local capture を constructor へスレッド）

90. **関数内クラスの function-local capture を constructor にスレッド（principled ABI）**:
    §49 は explicit-ctor を持つ関数内クラスが囲み関数のローカルを field init/computed key/method body
    で参照する場合を loud-reject にしていた（ctor は Direct 呼び出しで cell を thread できないため）。
    本セッションで **constructor へ cell をスレッド**して解決（factory 関数パターンが動く）。
    - **principled ABI（ad-hoc 並べ替えなし）**: lifted 関数の prologue は元々 `[cells…, this, params]`
      順（emitCells→emitThis）。ctor 呼び出しがインスタンスを `recv`（=_a[0]）で渡すのが唯一の障害
      だったが、**`recv` は「this を _a[0] に置く」糖衣**にすぎない。cell がある時は `recv` を使わず
      `recv=undefined, args=[...cells, instance, ...realArgs]` で Direct 呼び出し → prologue 順と完全一致。
      prologue 改変も ctor 特例順序も不要（`emitCtorCall` ヘルパに集約）。
    - **freeVars(ctor) 拡張**: ctor 本体だけでなくクラスの instance field initializer / dynamic computed
      key 式 / install する dynamic method 本体（nested）も走査 → ctor の自由変数に capture が入る。
      module-scope は isMethodLike フィルタで GLOBALS 経由（§49）、function-local は cell param 化。
    - **cellBindings**: methodDecls（ctor 含む）と install dynamic method の freeVars を追加 → 囲み関数が
      cell を確保し、`new`/`super` 側が thread できる。
    - **ctorCellArgs / emitCtorCall**: `sortedFreeVars(ctor).filter(!moduleCellGlobal)` を prologue と同順で
      cell args 化。`new C()`（+ctorReturns）/ `super(...)` / emitImplicitConstruction の親 ctor 呼び出しで
      スレッド。cell が呼び出し側 cellAccess に無い（真の cross-scope）場合は `missingCell` で黙らせず
      **loud-reject**。
    - **transitive capture**: `new C()` / `super(...)` を「ctor 呼び出し」とみなし、呼ばれる ctor の
      function-local 自由変数を呼び出し元関数の自由変数へ伝播（freeVars）。これで nested 関数からの
      `new`・親が local を capture する super も同一スコープ内なら動く。
    - **NAMED (vtable) メソッド/accessor の function-local capture は loud-reject 化**: vtable/static
      dispatch は固定 ABI で cell を thread 不可（従来は silent NaN）。ctor/field-init/dynamic-member は
      Direct でスレッド可なので対象外、module-scope capture も GLOBALS 経由で対象外。silent→loud。
    検証 vs V8: factory(field/dynkey/method-body/ctor-param/multi-new)、継承 super、nested/deep-nest new
    の transitive、ctor 本体直接 capture（旧 case G）、module-scope 回帰、no-ctor dynamic 回帰、全一致。
    vtable メソッドの function-local capture は loud-reject。全 CI 緑（conf 129/129, ci_par 全 PASS, perf
    全 budget 内）。conformance: classes/computed_dynamic_members.ts に factory + 継承を追加。
    rejects_syntax.sh: §49 の explicit-ctor 行 → vtable-method-capture 行へ更新。
    既知の限界: クラス値が宣言スコープ外へ escape して（変数経由で）instantiate され、cell が呼び出し側に
    無い場合は loud-reject（クラスを closure 化しないと不可）。

90b. **`new X()` の非クラス/非組込みを loud-reject（silent miscompile 解消）**:
    §90 の「クラス値が escape して変数経由 instantiate」を調査した結果、実体は loud-reject ではなく
    **silent miscompile** だった。`new` の lowering は `node.expression` が識別子でその symbol が
    `classSymToId` で解決できる時だけ ctor/field-init を走らせ、解決できないと**空オブジェクトを返す
    だけ**（ctor も field init もスキップ）→ フィールド undefined。これは capture と無関係で、
    `const K=C; new K()`（変数に入ったクラス値）や `new Promise(...)`（未対応組込み）も同様に黙って誤る。
    修正: new-expression の `classId === undefined` 分岐（Array/Map/Set/Date/Error 等の組込みは手前で
    return 済み）で `this.unsupported(...)` を呼び loud-reject。`new ClassName()`・組込み・factory 同一
    スコープ（§90）には影響なし。検証: `new K()`(capture有無)・`new Promise(...)` は REJECT、
    `new ClassName()`/Array/Map/Set/Date/Error/factory は accepted。全 CI 緑（conf 129/129, 既存テストは
    この silent 経路に依存していなかった）。rejects_syntax.sh に 2 件追加。
    補足: クラスを first-class なランタイム値（捕捉環境を運ぶ closure）にすれば `new K()` も動かせるが、
    クラスをコンパイル時 descriptor として扱う現モデルの大改修になるため別案件。

## セッション 51（new Promise(executor) 実装）

91. **`new Promise((resolve, reject) => {...})` 実装**:
    §45-46 で Promise の static/instance API は揃っていたが、明示的な `new Promise(executor)`
    コンストラクタ形式は未配線で、§90 までは silent に空オブジェクト→loud-reject だった。実装。
    - **ランタイム ABI 変更不要の発見**: runtime に FN_TABLE は無く、`ts_call` は `f->code`（生 C 関数
      ポインタ `ts_code=tsv(*)(tsv*,int)`）を `f->env` 前置で呼ぶだけ。なので `resolve`/`reject` は
      **既存 `ts_make_fn(code, env, envlen)` で作る普通の `ts_func` クロージャ**にできる（`code`=C thunk、
      `env[0]`=束縛 promise）。`gc_alloc`=calloc(0埋め)なので `takes_this=0`、`resolve(v)` 呼び出しは
      `ts_call_value`→`ts_call` が env 前置して thunk に `[promise, v]` を渡す。GC は TS_KIND_FUNC の env を
      マークするので束縛 promise は生存。
    - **runtime**: `ts_resolve_thunk`/`ts_reject_thunk`（static）+ `ts_promise_new_executor(executor)` —
      pending promise を作り resolve/reject を束縛、executor を `ts_call_catching`（setjmp+EH）で同期実行、
      throw したら reject。settle-once は `ts_promise_settle` の既存ガードで自動（最初の呼び出しが勝つ）。
      arrow/function-expression executor は `ts_call_value` が `takes_this` で this 整列。
    - **emit_c**: CallBuiltinStatic に `"promise.new" => ts_promise_new_executor(v(0))`。
    - **exporter**: new-expression に `ctorName === "Promise"` 分岐（executor を closure 値に lower→
      CallBuiltinStatic "promise.new"）。§90 の非クラス reject より前で return。
    検証 vs V8: resolve/reject/throw/await/チェーン/settle-once(resolve勝ち)/settled-promise採用/
    Promise.all 連携/GC stress(2000)、全一致。全 CI 緑（conf 130/130, ci_par 全 PASS, perf 全 budget 内）。
    conformance: closures/new_promise.ts 追加。rejects_syntax.sh の「unsupported builtin ctor」行を
    new Promise→new WeakMap へ更新（new Promise が動くようになったため）。
    既知の限界: **pending promise / thenable での resolve は V8 の追加 microtask tick を再現しない**
    （settled inner promise は同期採用するため、別の async chain と log が interleave する順序が 1 tick
    ずれうる。値は正しい。`ts_promise_resolve` の v1 簡略化）。

## セッション 52（Promise 採用を Promises/A+ 準拠に: async + pending chaining）

92. **`ts_promise_resolve` の thenable 採用を adapter coro 化**:
    §51 で残した既知の限界を修正。旧実装は promise で resolve した時、settled inner promise を
    **同期採用**（tick 無し）し、**pending inner promise は採用せず放置**（チェーンされず outer が
    永久 pending = 実バグ）だった。これを **inner promise に adapter coro を登録**する方式へ変更
    （既存の then/combinator パターンと同型）。`ts_await_register` が settled→microq push（追加 tick）/
    pending→waiter 追加（チェーン）を両方さばくので、それだけで両欠陥が解消。
    - runtime に `ts_adopt{ts_coro c; tsv out_v;}` + `adopt_resume`（inner の settled 状態 c->result/
      rejected を outer へ転送。fulfilled は ts_promise_resolve で再帰採用、rejected は ts_promise_reject）。
      `ts_promise_resolve(p,v)` は `ts_is_promise(v)` のとき `ts_coro_alloc(sizeof(ts_adopt),adopt_resume)`
      →`out_v=ts_obj(p)`→`ts_await_register(v,&w->c)`。非 promise は従来どおり ts_promise_settle。
    - GC: promise の waiters[] と coro frame 保守スキャン（out_v）で adapter/outer が生存（§45 規律踏襲、
      ts_coro_alloc が frame_size 設定＋ret 確保前 root）。
    - 影響範囲: promise を渡しうる呼び出し元（new Promise の resolve / .then が promise を返す /
      Promise.resolve(promise)）は全て Promises/A+ 的に非同期採用が正。combinator/finally/IO は具体値のみ。
    検証 vs V8: 追加 tick の順序（settled 採用が同期でなくなった）, **pending chaining**（resolve した
    inner が後で settle→outer も settle, 旧来バグ）, 再帰採用, reject 採用, 全一致。全 CI 緑
    （conf 130/130, ci_par 全 PASS, perf 中立, async bench 緑）。closures/new_promise.ts 拡張。
    **§51 の「pending promise / thenable 採用」限界を解消。**
    既知の残限界: thenable 採用の microtask **tick 数**は V8 と厳密一致しない（V8 は
    PromiseResolveThenableJob で +1 tick 余分。当方は 1 tick 採用）。await/チェーンせず別 async chain との
    interleave を tick 単位で数える場合のみ観測可能（値は正しい）。自己解決サイクル
    （`new Promise(r=>r(p))` で p が outer 自身）は V8 の TypeError でなく outer が pending のまま（稀）。

## セッション 53（式評価順序 / sequence points）

93. **式評価順序の silent miscompile を修正（operand snapshot + assignment target-before-RHS）**:
    bare 変数読みが canonical local id をそのまま返し（snapshot されない）、書き込み(`=`/`++`)が同じ
    canonical local を **in-place Copy** するため、複数 operand を1命令でまとめて consume する式で
    後続 sibling の mutation が既読 operand に遡及していた。確認済み（全 node 不一致）:
    `i+i++`→11(10), `i===i++`→false(true), `console.log(i,i++,i)`→`6 5 6`(`5 5 6`),
    `f(i,(i=99))`→`99 99`, `new C(i,i++)`→`6 5 6`; さらに代入順序 `a[i]=i++`, `a[key()]=i`(RHS 純粋でも),
    `o.x=(o={x:2},7)` も誤り。
    - **SSA-rebind は回避**: analyzer は flow-insensitive 非SSA（escape は body を flatten し stable
      LocalId で keying、ループは phi 無しの goto、1変数=1 canonical local で join 自動）。SSA 化は
      Phi IR+escape join+SROA copy-alias+int-inference union+codegen merge への大波及で高リスク。
    - **(A) 読み側 snapshot**: `lowerSequenced(exprs)` — 各 operand を左→右に lower し、後続 sibling が
      `mayHaveSideEffect`（`++`/`--`/代入/call/new/tagged-template/await/yield/delete を subtree に含む）
      かつ produced local が `isMutableStorageLocal`（canonical 変数スロット＝`ctx.storageLocals`、
      ensureLocal/ensureLocalAlias で追跡）なら `Copy` で fresh local に snapshot。二項演算・全呼び出し
      引数（Call/CallSpread/CallBuiltin/CallBuiltinStatic/new）・メソッド受け手に適用。bare 変数読み
      だけが alias する（LoadIndex/LoadField/sub-BinOp/call は既に fresh local に materialize）ので
      snapshot は最小、かつ副作用 sibling がある時だけ → 副作用無しの hot loop は不変。
    - **(B) 代入 target を RHS より前に評価**（常に。RHS 純粋でも `a[key()]=i`/`target().x=i` が壊れる
      ため）: `lowerAssignRefPre` が element/plain-property target の object/key を RHS 前に lower し、
      RHS が副作用を持つ時は storage-local の object/key を snapshot。`lowerAssignTarget` に pre 引数を
      追加。static-field/`C.prototype.m`/setter は eval-order 非依存なので従来 path（`isPlainFieldStoreTarget`
      で判定）。
    - 変更は **exporter のみ**（`Inst::Copy` + 既存 Store を再利用、analyzer/runtime/emit_c 不変）。
    検証 vs V8 全一致（二項/比較/引数/nested/new/`a[i]=i++`/`a[key()]=i`/`o.x=(o=…)`/副作用無し制御、
    static/setter/this-field 回帰）。全 CI 緑（conf 131/131, ci_par 全 PASS, **perf 全 budget 内**＝
    snapshot は hot kernel に出ない）。conformance: expressions/eval_order.ts。
    既知の残: getter/Proxy の member-read 副作用は未検出（member read を pure 扱い）; compound assign
    `a[i]+=v` の computed-target 二重評価; 分割代入 target 順序（別 follow-up）。

94. **NaN の真偽値変換が truthy 扱いの silent miscompile を修正（unboxed double truthy に NaN ガード）**:
    `emit_c` の `truthy()` が unboxed double を `(d != 0)` で判定していたため、C では `NaN != 0` が
    true となり JS の「NaN は falsy」と乖離。`if (NaN)`/`!NaN`/`NaN && x`/`NaN || x`/`NaN ? a : b`/
    `while (NaN)` の全てで誤った分岐を取る silent miscompile（確認済み、全 node 不一致: `if(NaN)`→t、
    `!NaN`→false、`NaN&&"y"`→"y"、`NaN||"z"`→"z"、`Math.sqrt(-1)?1:0`→1、`NaN?10:20`→10）。
    - 修正: `truthy()` を 3 分岐に。int_local（long long、NaN を取り得ない）は従来どおり `(d != 0)`、
      非 int の unboxed double のみ `(d != 0 && d == d)`（`d == d` は NaN で false なので NaN→falsy）、
      boxed は従来どおり `ts_truthy(v)`。
    - **perf 中立の根拠**: 比較結果（`<`/`==` 等）と `!` 結果は `infer_int_locals` で int_local 化
      されるため、hot loop の条件（`i < n`）や `cmp_truthy_only` 経路は **int_local 分岐**を通り NaN
      ガードが付かない。`&& d == d` が付くのは「NaN を取り得る生 double」を真偽文脈で使う稀なケースのみ。
    検証 vs V8 全一致（if/ternary/&&/||/!/while/field/array elem、`!!NaN`/`!!-0`→false・`!!1`/`!!0.5`→true、
    3.14 truthy・0.0 falsy の回帰）。全 CI 緑（conf 132/132, ci_par 全 PASS, **perf 全 budget 内**）。
    変更は **emit_c のみ**（exporter/runtime 不変）。conformance: coercion/nan_truthiness.ts。

95. **compound assignment の computed-target 二重評価 silent miscompile を修正（ref を一度評価して read/write 共有）**:
    `a[i] += v` の旧 lowering は read を `lowerExpr(node.left)`、write を `lowerAssignTarget(node.left, res)`
    で別々に行い、target reference（object と key）を **二度評価**していた。確認済み（全 node 不一致）:
    - `a[i++] += 5` → `i` を 2 回インクリメント＋read/write が別スロット（aot `10 2` / 正 `15 1`）
    - `a[i] += (i = 1, 5)` → write が RHS で変わった index へ（aot `10 15 1` / 正 `15 20 1`）
    - `getObj().x += 5` → `getObj()` を 2 回呼ぶ（aot count `2` / 正 `1`）
    - 修正: §53 の `lowerAssignRefPre`（target の object/key を **一度だけ**評価し、RHS が変えうる bare
      obj/key を `Copy` で snapshot＝JS は target を RHS より前に確定）を再利用。新ヘルパ `lowerReadFromRef`
      が pre 済みの obj/key から `LoadField`/`LoadIndex`/`LoadFieldDynamic`/`symbol.get` で現在値を読む。
      compound 分岐を「ref 評価 → read → RHS 評価 → BinOp → 同 ref へ write」に再構成。
    - 対象は **element access** と **plain-field property**（getter/setter 無し＝`isPlainFieldStoreTarget`
      かつ `!hasGetter`）のみ。identifier / static field / prototype / setter / getter は double-eval
      ハザードが無い（or accessor 経路）ので従来の simple path 据置。
    - **perf**: write 側の object/key 再評価が消えるため IR 命令はむしろ減る → 中立（全 budget 内）。
    検証 vs V8 全一致（postfix index・RHS が index/receiver を変更・member 上の index・string-keyed +
    side-effecting key・全 compound 演算子 `-= *= /= %= &= |= ^= <<= >>= **=`・string 連結・getter/setter・
    static field・closure cell の回帰）。全 CI 緑（conf 133/133, ci_par 全 PASS, perf 全 budget 内）。
    変更は **exporter のみ**（analyzer/runtime/emit_c 不変）。conformance: expressions/compound_assign_order.ts。
    関連残課題: 分割代入（destructuring assignment）の target 評価順序は **既に正しい**（computed target
    `[a[i++]]=xs` / `({x:a[i++]}=o)` も V8 一致、computed property **名** `{[k()]:t}` のみ loud-reject）。
    getter / Proxy の member-read 副作用は未検出のまま（documented residual; object model 拡張時に再設計）。

96. **単項 `~` の文字列/bool/null coercion 欠落の silent miscompile を修正（num→numc で ToNumber 経由に統一）**:
    JS のビット演算は各オペランドに ToInt32(ToNumber(x)) を適用する。二項ビット演算（`& | ^ << >> >>>`）は
    `ctx.numc`（boxed→`ts_number_coerce`＝ToNumber: 文字列を parse、bool→0/1、null→0、object→ToPrimitive）
    を使い既に正しかったが、単項 `~` だけ `ctx.num`（boxed→`ts_to_num`＝非数値タグで NaN を返す → ToInt32(NaN)=0）
    を使っていた。確認済み（全 node 不一致）: `~~"5"`→`0`(正 5)、`~"5"`→`-1`(正 -6)、`~~"5.9"`→`0`(正 5)、
    `~~true`→`0`(正 1)。これは TS 上は any 経由だが `~~x` の truncate-to-int32 idiom で現実的に踏む。
    - 修正: `emit_c.rs` の `Inst::UnOp` `"~"` 分岐を `ctx.num(operand)` → `ctx.numc(operand)` に変更。
      生成式は `((double)(~ts_to_int32(ts_number_coerce(x))))` ＝ ToInt32(ToNumber(x)) で二項と同一経路。
    - **perf 中立**: unboxed オペランド（hot path の生 double/int）は `num`/`numc` とも `d{id}` を返すので
      生成 C は完全に同一。差が出るのは boxed オペランドのみ（`ts_to_num`→`ts_number_coerce`）。
    検証 vs V8 全一致（string / float-string / 負 / 空文字 `""`→0 / garbage→0 / 前後空白 / hex / bool / null /
    undefined / 配列 ToPrimitive / NaN / Infinity / ToInt32 の 2^32 wrap / `~~` idiom 混在リスト / unboxed hot loop）。
    全 CI 緑（conf 134/134, ci_par 全 PASS, perf 全 budget 内）。変更は **emit_c のみ**（exporter/runtime 不変）。
    conformance: coercion/bitwise_not_coercion.ts。
    関連残課題（別件・既存限界、本修正と無関係）: 純オブジェクトの **user-defined `valueOf` による ToPrimitive**
    は二項 `&` / 単項 `-` / `+` / `*` / `Number()` の全数値 coercion で未対応（`ts_to_primitive` が object
    literal の `valueOf` メソッドを呼ばず NaN/`[object Object]` になる）。これはオブジェクトモデル全体の別案件。

97. **オブジェクトリテラルの user-defined `valueOf`/`toString` による ToPrimitive を全数値/文字列 coercion で有効化（silent miscompile 修正）**:
    `const o = {valueOf(){return 5;}}` のようなプレーンオブジェクトの自前メソッドが ToPrimitive で
    呼ばれず、`o & 7`/`-o`/`o*2`/`o+1`/`Number(o)`/`String({toString(){return "hi"}})` がすべて
    NaN/`[object Object]` になっていた（確認済み、全 node 不一致）。
    - **ルートコーズ**: object literal のメソッド `{valueOf(){}}` は `StoreField(obj, internField("valueOf"), fn)`
      で **FIELD キー**（小整数）のデータプロパティとして格納される。一方 runtime の `ts_to_primitive`/
      `ts_to_string_v` は `g_valueof_key`/`g_tostring_key`（= **METHOD キー** `TS_KEY_METHOD`、Object.prototype
      登録由来）で `ts_get` するため、own の FIELD キーメソッドに決して当たらない。（配列 `~~[7]` が動くのは
      Array.prototype.toString が METHOD キーで proto チェーン上にあるため。）参照サイトは runtime に 2 箇所のみ。
    - **修正（runtime のみ, `ts_rt.c`）**: ① `ts_to_primitive` のメソッド探索を「FIELD キー（own object-literal
      メソッド）先 → 無ければ METHOD キー（prototype/builtin）」順に変更（own がシャドウ、JS 仕様 `o.valueOf` は
      own を先に解決）。FIELD キーは `ts_intern_field("valueOf"/"toString")` で初回 1 回遅延解決しキャッシュ
      （`ts_prim_field_init`/`ts_prim_method` ヘルパ新設）。② `ts_to_string_v` の object 分岐の独自 METHOD キー
      toString lookup を廃し、修正済み `ts_to_primitive(v, 1)`（string hint）へ委譲。
    - **付随 2 件**: ③ `%` の int-const fast-path（`emit_c.rs` 2438）が `ctx.num`（= `ts_to_num`、object/string で
      NaN）を使っていた → `ctx.numc`（ToNumber）に（`o % 3`/`"17" % 5`）。unboxed は両者 `d{id}` で hot path 不変。
      ④ テンプレートリテラル `` `${o}` `` が `acc + e`（`ts_add` = default hint → valueOf 優先）で lower され
      `${ {valueOf:1,toString:"2"} }`→`1`（正 `2`）になっていた → 各補間式を `string.coerce`（`ts_to_string_v`
      = string hint → toString 優先）で ToString してから concat（`exporter.ts` template lowering）。
    - **perf 中立**: ToPrimitive はオブジェクト被演算子の coercion 時のみ呼ばれ、数値/文字列 hot path は手前で
      return される。`%` fast-path と template の primitive 補間は生成コード/コストとも実質不変。
    検証 vs V8 全一致（valueOf 全数値演算子 `& | ^ << >> >>> ~~ - + * / % < >`/toString 文字列化/hint 優先
    （number→valueOf, string→toString）/Symbol.toPrimitive 優先/valueOf が object を返す→toString フォールバック/
    closure-captured valueOf/テンプレート各種/配列・クラスインスタンス・プレーン object 既定値の回帰/unboxed hot loop）。
    全 CI 緑（conf 135/135, ci_par 全 PASS, perf 全 budget 内）。変更は **runtime + emit_c(`%` の 1 トークン) +
    exporter(template)**。conformance: coercion/object_to_primitive.ts。
    既知の残: valueOf/toString が **getter/Proxy** 経由で定義されるケースは未検出（member-read 副作用の
    documented residual と同根）。

98. **String.replace/replaceAll の関数 replacer を実装（無音 no-op silent miscompile 修正）**:
    `"abc".replace("b", m => m.toUpperCase())` が置換せず原文 `"abc"` を返していた（正 `"aBc"`、replacer 関数が
    一度も呼ばれない）。原因: `ts_str_replace` が `rep` を `as_str` で文字列化し、関数値は NULL になって早期 return
    で原文を返していた。
    - 修正（**runtime のみ**, `ts_rt.c`）: `rep_is_fn = ts_is_callable(rep)` を判定。関数なら各マッチ位置で
      `ts_str_replace_call(rep, matched, offset, s)` = `ts_call(rep, [matched, ts_num(offset), s], 3)` を呼び、
      戻り値を `ts_to_string_v` で文字列化して置換片とする（callback 規約は array.map/filter/reduce と同じ生 `ts_call`）。
      literal-string パターンでは matched == パターン文字列。空パターン経路（offset 0 / 各文字間 / 末尾）と
      非空パターン経路の両方を関数対応化し、`has_dollar` 計算は `r` が NULL（関数 replacer）のとき skip。
    - exporter は既に replacer を第 2 引数 `v(1)` として渡しており（関数値も string も同じ経路）、runtime 側が
      無視していただけ → **runtime のみで完結**（exporter/emit_c 不変）。
    検証 vs V8 全一致（基本変換/offset・whole-string 引数/replace は先頭 1 件・replaceAll は全件/no-match で未呼出/
    return 値の ToString 強制/多文字パターン/closure-captured replacer/空パターン replace・replaceAll/$ パターン・
    文字列 replacer の回帰）。全 CI 緑（conf 136/136, ci_par 全 PASS, perf 全 budget 内）。
    conformance: strings/replace_function.ts。既知の残: regex パターン（`$n` 後方参照・`/g` フラグ）は未実装で別途 REJECT。

99. **オブジェクトリテラルのショートハンドプロパティ `{a}` が値を読まない silent miscompile を修正（symbolOf 中央 redirect）**:
    `const a=1,b=2; const o={a,b}` が `o.a===0, o.b===0` になっていた（`{a:a}` 明示形は正常）。
    - **ルートコーズ**: shorthand プロパティ名 identifier に対する `getSymbolAtLocation` は **プロパティ symbol**
      （参照先の変数 `a` ではない）を返す。`symbolOf` はこれをそのまま使うため、(a) 自由変数/capture 解析
      （`scan`/`symbolOwnerFunction`）が変数を「captured」と認識せず、(b) `lowerIdentifier` が `ensureLocal` で
      新しい空ローカル（default 0/undefined）を作って読む。とくに closure cell / module-scope / nested-function
      捕捉のケースは capture 解析が参照を見逃して publish されず、全て 0 になる。
    - **修正（exporter のみ・中央 1 箇所）**: `symbolOf(node)` を「`node` が ShorthandPropertyAssignment の
      `name` identifier なら `checker.getShorthandAssignmentValueSymbol(parent)`（＝値 binding）を返す」よう redirect。
      これで自由変数解析・owner 判定・lowering の全経路が一貫して値 binding に解決される（`isVarRef` は既に
      shorthand 名を var ref 扱い＝true）。プロパティ field 名は `p.name.text`（symbol 非依存）なので影響なし。
    検証 vs V8 全一致（基本/single/mixed/string 値/JSON/param→object+`this` メソッド/2 リテラル間の再代入/
    destructuring round-trip/spread 併用/closure cell 捕捉/module-scope binding/nested-function 捕捉/関数値 shorthand）。
    全 CI 緑（conf 137/137, ci_par 全 PASS, perf 全 budget 内）。conformance: objects/shorthand.ts。

100. **生の数値値に対するメソッドの値参照（`(5).toString` 等）が未宣言識別子の C を生成する codegen バグを修正＋loud-reject 化**:
    `const f = (5).toString`（メソッドを**呼ばずに値として**参照）が、生成 C に未宣言の `v{id}` を出力して
    **C コンパイル失敗**していた。原因: `emit_c.rs` の `Inst::LoadField` fallback が `ts_get(v{obj}, key)` と
    raw boxed 名を使うが、receiver が unboxed な int/double local（`d{obj}`）の場合 `v{obj}` は存在しない。
    - 修正 (a) **emit_c**: LoadField fallback を `ts_get(ctx.val(obj), key)` に変更（`ctx.val` が unboxed 数値を
      `ts_num((double)d{})` 等で box する）→ 未宣言識別子を出さない（防御的・一般的な codegen 正しさ）。
    - 修正 (b) **exporter**: プロパティアクセス fallback で `refKindOf(receiver) === "primitive"`（unboxed 数値
      receiver）なら **loud-reject**。数値はデータプロパティを持たず、一級組込みメソッド値を表現しないため。
      codegen 修正だけだと「compile error → silent undefined（`typeof` が "function" でなく "undefined"）」に
      なり silent miscompile を新規発生させてしまう（規律違反）ので、loud-reject が正しい。
    - 数値メソッドの**呼び出し**（`(5).toFixed(2)`/`(255).toString(16)`）は call path 経由で**無影響**。
    検証: 数値メソッド値参照は clean REJECT、数値メソッド呼び出し・オブジェクト/クラスフィールド読み・`.length`・
    テンプレート `${n}`・computed 数値キーの回帰なし。全 CI 緑（conf 137/137, perf 全 budget 内）。
    rejects_syntax.sh に1件追加。
    既知の残（別件）: string/array/`console` のメソッドを値として参照（`[1,2].push`・`console.log` を渡す等）は
    reference receiver のため pre-existing の silent undefined（一級組込み関数値ギャップ、pending の
    「typeof Math.max → undefined」と同根）。

101. **一級組込みメソッド/関数値（first-class builtin method & function values）を実装（silent undefined 解消）**:
    組込みメソッド/関数を**呼ばずに値として**参照すると全て silent undefined だった（`[1,4,9].map(Math.sqrt)`,
    `const f=console.log; f(42)`, `typeof Math.max`, `arr.push.bind(arr)`, `["1","2"].map(Number)` 等）。
    - **IR**（`escape_ir.rs`）: `LoadMethodValue{dst,recv,method}`（prototype メソッド値）と
      `LoadBuiltinFn{dst,builtin}`（namespace 静的関数値）を追加。escape/SROA は recv を保守的に escape、
      dst を External 扱い。
    - **emit_c**: `LoadMethodValue` → `ts_get(ctx.val(recv), TS_KEY_METHOD(id))`（proto に既登録のボックス済み
      メソッドを取得。string/number primitive も proto へ dispatch、undefined receiver でも graceful）。
      `LoadBuiltinFn` → `ts_make_fn_t(<生成アダプタ>, 0, 0, 0)`。値参照された builtin のみ生成 C にアダプタ
      `static tsv ts_fnval_*(tsv* a,int n){...}` を出力（`fnval_adapter_body` テーブル、呼び出しパスと同じ
      runtime helper/libm を再利用。Math 1/2 引数・可変長 max/min/hypot・Number/Object/JSON/Array/String 静的・
      console.log/error・global parseInt/parseFloat/isNaN/isFinite/String/Number/Boolean）。
    - **exporter**: プロパティアクセスの value 位置で (A) namespace 静的関数（`builtinFnValueName`）/
      (B) prototype メソッド（`builtinReceiverKind`+`builtinMethodName2` → `LoadMethodValue`、§100 の
      primitive-receiver reject を置換）を検出。`lowerIdentifier` で bare global（`globalFnValueName`）。
      未対応の namespace 静的値（Object.assign / Promise.resolve 等）は **loud-reject**（silent undefined 解消）。
    - **初期化順序バグ修正**: `ts_setup_function_proto()` を array/map/set proto setup の **前**（object の直後）へ
      移動。`ts_make_fn` は生成時に `f->proto = g_function_proto` を焼くため、g_function_proto 未初期化のまま
      登録された array/map/set のメソッド fn は proto=NULL となり `arr.push.call/.bind/.apply` が
      Function.prototype を解決できなかった（string/number は後で登録され動いていた）。
    - **typeof**: `ts_typeof(ts_func)` が既に `"function"` を返すため自動で直る。
    - **意味論**: メソッド値は JS 同様 unbound（`.bind()`/`.call()`/`.apply()` で束縛して動く）。bare detached
      call（`const m=arr.push; m(3)`）は this=undefined で 0/undefined（V8 は throw、稀・非破壊・非 crash）。
    検証 vs V8 全一致（callback: map/forEach/filter に Math.*/String/Number/Boolean/parseFloat、変数化:
    Object.keys/JSON.stringify/parseInt/console.log、typeof、proto メソッド値 + bind/call/apply、可変長 Math.max/min、
    回帰: 全 call 不変・namespace const・getter・class method・static field・Symbol.iterator）。全 CI 緑（conf 138/138,
    perf 全 budget 内）。conformance: stdlib/first_class_builtins.ts。rejects_syntax.sh 更新。
    既知の残（別件）: 可変長/特殊 static（Object.assign/defineProperty/Promise.*/symbol.*/date.*）の値は loud-reject;
    forEach/map がコールバックに第3引数（配列）を渡さない（既存・別件）。

102. **`new K()`（変数に入ったクラス値の instantiate）を実装（§50b の loud-reject を解消, monomorphic）**:
    `const K = C; new K()` と factory `const K = makeClass(z); new K()` が動くようになった（従来は loud-reject）。
    ユーザ提案「クラスは関数の一種だからクロージャ値に classId を持たせる」を採用。
    - **Phase B**（exporter のみ）: `new`(exporter.ts) で symbol/name 解決が失敗した後、new 式の**結果型**
      （＝インスタンス型 C）から classId を解決し、既存の AllocObject + ctor 経路をそのまま走らせる。
      class_extract の RTA `instantiated` マークにも同じ結果型フォールバックを追加（これが無いと
      `ts_register_classes` にフィールド記述子が出ず、`new K().inc().inc().v` の動的 `ts_get` が NaN になった）。
    - **Phase A**（runtime + IR + exporter）: クラス値 = `ts_func{ code=ctor, env=捕捉セル, class_id }`
      （class_id は cid+1、0=非クラス）。runtime に `ts_make_class_value` / `ts_construct`（class_id から
      `ts_new_sized` で typed インスタンスを確保し proto を設定、ctor を `ts_call` ＝ env 前置で
      `[cells…, this, args]`、ECMA の constructor-returns-object 規則）/ `ts_register_class_meta`（全 instantiated
      クラスの instance size + prototype を class_id 索引で登録）。IR に `AllocClassValue` / `NewDynamic`
      （escape_ir、interproc/sroa は保守的 arm）。exporter は lowerIdentifier で明示 ctor クラスの識別子を
      `AllocClassValue` に値化（instantiated もマーク）、`new K()` の明示 ctor monomorphic を `NewDynamic`
      （factory の捕捉セルを実行時に thread）、no-ctor monomorphic を静的 B。typeof は ts_func→"function" で自動。
    - **安全策（silent 回避）**: TS は polymorphic `cond ? B : A` を単一の静的型に collapse するため、構築・
      メソッド devirt・フィールドアクセスが全て破綻する。`classValueIsMonomorphic`（const かつ初期化子がクラス
      識別子 or factory 呼び出し）でない場合、union 結果型、no-ctor + 関数ローカル capture は **すべて loud-reject**。
    検証 vs V8 全一致（const K=C / メソッド / return-this チェーン / 継承フィールド / ctor 引数 / factory 単一・
    複数インスタンス独立 / typeof / constructor-returns-object / nested capture / GC stress 2000）。polymorphic /
    no-ctor+capture / any 引数 / element-access ctor は clean REJECT。全 CI 緑（conf 139/139, perf 全 budget 内）。
    conformance: classes/class_value_new.ts、rejects_syntax.sh 更新。
    既知の残（follow-up）: polymorphic クラス値（結果に対する動的 devirt が必要）、no-ctor + 関数ローカル capture
    （construct-thunk 合成が必要）、any 型引数のクラス値 / element-access コンストラクタ（`new ctors[0]()`）。

103. **class インスタンスメソッドの一級値化（`c.m` を値として、`.bind`/`.call`/`.apply`）**:
    `const f = c.m; f.bind(c)()` / `c.m.call(c, x)` / `c.m.apply(c, [x])` が `TypeError: method is not a function`
    になっていた。原因: `c.m`（値）が generic `LoadField`（**FIELD キー** `internField("m")`）に落ちるが、class メソッドは
    `CLASS_PROTO[classId]` に **METHOD キー** `TS_KEY_METHOD(internName("m"))` で登録されているため undefined になり、その
    `.bind` 等が失敗していた。
    - 修正（**exporter のみ**）: プロパティアクセス値 lowering の getter チェック直後に分岐を追加。
      `classOfExpr(receiver)` が class かつ `classHasMethod`（own + 継承、`findMember` が親チェーンを辿る）かつ
      `!classHasField`（同名インスタンスフィールドがシャドウする場合は除外）なら、§61 の
      `LoadMethodValue{recv, method:internName(name)}` を emit。`ts_get(instance, TS_KEY_METHOD(id))` が CLASS_PROTO
      から boxed メソッドを返す（proto=g_function_proto は §62 の初期化順修正で保証）→ `.bind`/`.call`/`.apply` が動く。
    - `c.m()` メソッド CALL は CallExpression の devirt（Method callee）で処理され `c.m` を値化しないので無影響。
      object-literal メソッド（field キー格納）・arrow-function フィールド・既存 devirt も無影響。runtime/IR は無改変。
    - 意味論: unbound（JS と一致）。bare detached call（`const f=c.m; f()`）は this=undefined（V8 は throw、当方は
      undefined/no-op、非破壊・非 crash、§61 と同じ既知挙動）。
    検証 vs V8 全一致（bind/call/apply/typeof/継承メソッド値/`this.m.bind(this)`/callback 化/partial application/
    メソッド呼び出し・return-this チェーン・arrow フィールド・object-literal メソッドの回帰）。全 CI 緑（conf 144/144,
    perf 全 budget 内, unit 全 PASS）。conformance: classes/method_value.ts。
    既知の残（follow-up）: static メソッド値（`C.staticMethod`）、computed/symbol 名メソッド値は対象外。

104. **静的メンバの完成（静的メソッドの一級値化 + 静的メソッド内 `this` 束縛）**:
    §65（インスタンスメソッド値）の続き。静的フィールド値 `C.x`（read/write）は動作していたが、(1) 静的**メソッド**を
    値として参照（`const f = C.make` / `C.m.bind(...)` / `[1,2].map(M.double)` / `typeof C.m`）が全滅（undefined/
    TypeError）、(2) 静的メソッド内の `this`（`static getV(){ return this.v }` を `C.getV()` で呼ぶ）が **NaN**（silent
    miscompile）だった。原因: 静的メソッドは「`this` 無しのプレーン関数」（`Direct` call で this を渡さない、`thisParam=
    false` で `ctx.thisLocal` 未設定→`this` が未初期化ローカル読み）で、値化する経路も無かった。
    - 修正（**exporter のみ**, runtime/IR 無改変）:
      - (A) プロパティアクセスで静的フィールド read より**前**に静的メソッド値分岐を追加。`findStaticMethod(cid, name)`
        （`staticMethodFunc` を親チェーン walk、継承対応）で解決できたら `AllocClosure{func: staticFnId, captures: []}`
        でボックス化。`C.m()` の CALL は CallExpression の Direct 解決で処理され `C.m` を値化しないので無影響。
      - (B) `lowerFunctionLike` の `emitThis` に「静的メソッド（`!thisParam && isMethodDeclaration && isStaticMember &&
        classStaticGlobal.has(classId)`）なら `thisLocal = LoadGlobal(静的コンテナ)`」を追加。`currentClass` は非設定
        （コンテナは plain object なので `this.x` を typed-struct でなく generic `LoadField`/`StoreField` でコンテナの
        field-key に当てる）。静的メソッド cfunc は自身のコンテナを内部ロードするので、直接呼び・値経由呼び両方で
        `this`=コンテナに解決され、`.bind`/`.call`/`.apply`/callback で動く（takes_this=0）。
    検証 vs V8 全一致（静的メソッド値の `f()`/bind/call/apply/callback/typeof/継承メソッド値、`this.staticField` の
    read & write、static factory、直接呼び・静的フィールド read/write・インスタンスメソッド/§65 class メソッド値の回帰）。
    全 CI 緑（conf 145/145, perf 全 budget 内, unit 全 PASS）。conformance: classes/static_members.ts。
    既知の残（許容/別件）: detached 静的メソッド値（`const f=C.get; f()` で get が `this` 使用）は当方は this=コンテナで
    動くが V8 は throw（silent ではなく寛容な逸脱）; 継承静的フィールドの `this` 経由参照、`this.otherStaticMethod()`、
    bind の thisArg 上書きは対象外。**一級メソッド/関数値は §61(ビルトイン)+§64(length/name)+§65(class)+§66(static) で完備**。

105. **静的メソッド内の `this.X` を静的メンバへ解決（this 経由の静的メソッド呼び/継承静的フィールド）**:
    §66 の続き。静的メソッド内の `this.staticMethod()`（別の静的メソッドを `this` 経由で呼ぶ）と
    `this.inheritedStaticField`（親が宣言した静的フィールドを `this` 経由で read）が **DIFF（silent miscompile）**
    だった。原因: §66 は `thisLocal = LoadGlobal(own コンテナ)` を束縛し `this.X` をコンテナ object への generic
    field アクセスとして処理するため、(a) 静的メソッド・(b) 継承した静的フィールド（宣言クラスのコンテナにある）に
    届かない。
    - 修正（**exporter のみ**, runtime/IR 無改変）: `FnCtx` に `staticClass?: number` を追加し、`lowerFunctionLike` の
      emitThis 静的分岐で `ctx.staticClass = classId` を設定（`thisLocal=コンテナ` は維持、`currentClass` は非設定）。
      `this.X`（ThisKeyword + staticClass）を静的メンバとして解決:
      - read: `findStaticMethod(staticClass, name)`（継承 walk）成立→静的メソッド値（AllocClosure）;
        `staticFieldClassOf` 成立→宣言クラスのコンテナから `LoadGlobal + LoadField`（継承フィールド対応）。
      - call: `this.m()` → `findStaticMethod` → `Direct` call。
      - write: `this.x = v` → **own** 静的フィールドのみ自クラスのコンテナへ `StoreField`。継承した静的フィールドの
        write は JS の shadowing own-property 意味論（サブクラスに own プロパティを作る）が当方の per-class コンテナ
        モデルで再現できないため **loud-reject**（silent 回避）。
    検証 vs V8 全一致（`this.staticMethod()` 呼び/`this` 経由の継承フィールド read/`this` でメソッド値取得/own フィールド
    write/静的メソッド相互の `this` 呼び、直接呼び・静的メソッド値・`return this`・`ClassName.staticX` の回帰）。
    全 CI 緑（conf 146/146, perf 全 budget 内, unit 全 PASS）。conformance: classes/static_this.ts。
    既知の残（別件）: 静的 getter/setter（`static get v()` は別機構で未対応、`C.v`/`this.v` とも getter 未起動）、
    `super.staticMethod()`、継承静的フィールドの `this` write（loud-reject）、detached 静的メソッド値で `this` 使用
    （§66 の許容逸脱）。

106. **静的 getter/setter（`static get v()` / `static set v(x)`）**: §67 で残課題だった静的アクセサを実装。
    現状は単なる未対応ではなく **silent miscompile** だった: `setupClasses` のメンバ走査が静的メソッド/フィールド/ブロック
    にしか `isStatic` 判定を持たず、getter/setter 分岐に `isStatic` チェックが無いため、`static get v()` が汎用 accessor
    分岐に落ちて `methodFunc[\`${classId}:getter:v\`]`（**インスタンス getter**＝プロトタイプ）として誤登録されていた。
    → `C.v`（クラス上）では起動されず、`new C().v`（インスタンス）で誤起動＝両方向に不一致。
    - 修正（**exporter のみ**, runtime/IR/analyzer 無改変・静的メソッド §66/§67 の仕組みを踏襲）:
      - 新マップ `staticGetterFunc`/`staticSetterFunc`（`${classId}:static:${name}`→fnId）+ チェーン walk ヘルパ
        `findStaticGetter`/`findStaticSetter`（継承対応）。
      - setup ループで `isStatic` の get/set accessor を静的メソッドブロック直後に捕捉して `continue`（誤インスタンス登録の
        阻止）、`methodDecls.push({thisName:""})` で `this`=コンテナのプレーン関数として lower。アクセサ名は
        `classStaticFieldNames` には**追加しない**（データ read/write 経路に拾わせず、アクセサを先に intercept）。
      - `emitThis` の静的分岐条件を `isMethodDeclaration || isGetAccessorDeclaration || isSetAccessorDeclaration` に拡張
        → アクセサ本体の `this`=静的コンテナ + `ctx.staticClass` 設定（`this.otherStatic`/`this.staticMethod()` が動く）。
      - read `C.v` / `this.v`: 静的フィールド read より**前**に `findStaticGetter` → 成立で getter を `Direct` call（args:[]）。
      - write `C.v=rhs` / `this.v=rhs`: コンテナ store より**前**に `findStaticSetter` → 成立で setter を `Direct` call
        （args:[rhs]）。setter 無し（getter のみ）への代入は strict モード（ES module）で TypeError なので **loud-reject**
        （サイレントにコンテナへ shadow data prop を書いて getter に無視される誤コンパイルを回避）。
    検証 vs V8 全一致（`C.v` get/`C.v=` set roundtrip、計算 getter（複数静的フィールド参照）、getter→静的メソッド呼び、
    静的メソッド内の `this.v`/`this.v=`、継承 `Derived.tag`（基底の静的 getter 起動）、**静的 getter とインスタンス
    getter 同名の非混同** `Dual.v`=static / `new Dual().v`=instance、静的フィールド/メソッドの回帰）。
    全 CI 緑（conf 147/147, perf 全 budget 内, unit 全 PASS）。conformance: classes/static_accessor.ts;
    reject: getter-only 静的代入（rejects_syntax.sh）。
    既知の残（別件・静的メソッドと同じ制約）: 継承静的アクセサをサブクラス経由で起動した時の `this` は常に宣言クラスの
    コンテナ（shadow する稀ケースで親側を読む、静的メソッドと一貫）、computed/symbol 名の静的アクセサ（既に loud-reject）、
    `cc=C; cc.v`（クラス値経由）。**静的メンバは field/method/this/getter/setter で完備**。

107. **継承静的アクセサのサブクラス経由 `this`（subclass-aware static accessor `this`）**: §68 の残課題。継承した静的
    getter/setter をサブクラス経由で起動したとき `this` が宣言クラス固定で、サブクラスが静的フィールドを shadow すると
    **DIFF（silent miscompile）**だった。例: `class A{static _v=1; static get v(){return this._v}} class B extends A{static _v=99}`
    で `B.v` が JS=99（this=B→B._v）に対し当方=1（this=A 固定）。原因: 静的アクセサは宣言クラス D を classId として lower され
    `emitThis` が `ctx.staticClass=D` を設定、`this.X` はコンパイル時に staticClass=D 起点で解決されるため、受信クラス
    R=B でも常に D=A の view を読む（単一の lower 済み関数は staticClass を 1 つしか持てない）。
    - 修正（**exporter のみ**, runtime/IR/analyzer 無改変）: 「staticClass を宣言クラス D ではなく受信クラス R にすれば
      既存のコンパイル時解決がそのまま正しい」点を使い、**継承アクセサを受信クラス R 用にモノモーフィズム**（同一 AST
      ノードを別 fnId・classId=R で再 lower → Direct 呼び）。既存の汎用関数モノモーフィズム `specializeGenericCall`
      （`allocSpecFn` + 同一ノード再 lower、idempotency ガードは fnId キー）と同型。
      - 新ヘルパ: `resolveStaticGetter`/`resolveStaticSetter`（チェーン walk で宣言クラス D も返す）、
        `staticShadowsBetween(R,D)`（`[R,D)` に独自 static を持つクラスがあれば true＝override しうる、無ければ R と D で
        解決一致のため特殊化不要）、`specializeStaticAccessor(R, declFnId)`（メモ化・`lowerFunctionLike(node, specId,
        false, false, R)`・C 名に `$s{R}` 付与）、`staticGetterFnFor`/`staticSetterFnFor`（受信クラス R で解決し必要時のみ特殊化）。
      - `emitThis` 静的分岐の条件を `classStaticGlobal.has(classId)` → `staticContainerClassOf(classId)!==undefined` に緩和し、
        `thisLocal` を最寄り祖先コンテナから取る（R が独自 static 無しの継承専用クラスでも動く＝推移ケース）。非特殊化
        （classId=D）は `staticContainerClassOf(D)=D` で従来と同一・無影響。
      - read `C.v`/`this.v`・write `C.v=`/`this.v=` の 4 site を `staticGetterFnFor`/`staticSetterFnFor` に置換。
    検証 vs V8 全一致（直接 shadow `A.v`=1/`B.v`=99、setter 独立、計算 getter shadow（`B.area`=30）、推移 `C extends B`
    で C 独自コンテナ無し→B の `_v` を読む、アクセサ内アクセサ `B.vPlus`、非 shadow 継承（特殊化不要パス）、§68/§67/§66 回帰）。
    全 CI 緑（conf 148/148, perf 全 budget 内, unit 全 PASS）。conformance: classes/static_accessor_inherit.ts。
    既知の残（別件）: **静的メソッド**の subclass-aware this（§108 で解消）; computed/symbol 静的アクセサ（loud-reject）、
    `cc=C; cc.v`（クラス値経由）、`super.staticX`。

108. **静的メソッドの subclass-aware `this`（`B.staticMethod()` が shadow を読む）**: §69 で「値化と両立しにくい」と
    保留した残課題を解消。`class A{static _v=1; static show(){return this._v}} class B extends A{static _v=7}` で `B.show()`
    が JS=7（this=B→B._v）に対し当方=1（this=A 固定）の **DIFF（silent miscompile）**。原因は §69 と同一（静的メソッドも
    宣言クラス D で lower され `this.X` がコンパイル時 staticClass=D 起点で解決）。
    - 解消の要点（**「両立しにくい」の正体**）: §66 の値化は `B.m`（値）を宣言クラスの fnId で box するが、**値化サイトも
      受信クラスを静的に知っている**（`const f=B.m` の R=B、`this.m`（値）の R=ctx.staticClass）。よって値化サイトでも
      R 用特殊化 fnId を box すれば、direct 呼び `B.m()` と値経由 `const f=B.m; f()` が **同一の R view** を読み不整合が消える。
    - 修正（**exporter のみ**, runtime/IR/analyzer 無改変）: §69 のモノモーフィズム機構を静的メソッドへ一般化。§69 の
      `specializeStaticAccessor`→`specializeStaticMember`、マップ `staticAccessorSpec`→`staticMemberSpec` に改名（本体は
      任意の静的メンバノードを classId=R で再 lower、汎用）。`resolveStaticMethod`（宣言クラス D も返す）+ `staticMethodFnFor`
      （`staticShadowsBetween` 成立時のみ R 特殊化）を追加。静的メソッド 4 site を置換: 値化 `C.m`/`this.m`（AllocClosure の
      func を `staticMethodFnFor` 結果に）、direct 呼び `C.m()`（インライン chain walk を `staticMethodFnFor` に）/`this.m()`。
      これでメソッド→継承 getter→フィールドの相互再帰特殊化もメモ化で連鎖（§69 のアクセサ特殊化と統合）。
    検証 vs V8 全一致（direct shadow `B.show()`=7、メソッド→継承 getter `B.showV()`=7、メソッド→override 静的メソッド
    `B.a()`=21、推移 `C extends B` の `C.show()`/`C.a()`、§69/§68/§67/§66 回帰）。値経由 `const f=B.m; f()` は JS では
    detached this=undefined で **throw**（§66 の寛容な逸脱を踏襲、R=B view に統一）のため V8 比較テストには載せないが、
    差分確認で direct と同一 view（`7|1`）かつ AllocClosure-over-spec が emit/escape を通ることを確認。
    全 CI 緑（conf 149/149, perf 全 budget 内, unit 全 PASS）。conformance: classes/static_method_inherit_this.ts。
    **静的メンバ subclass-aware this は field/method/getter/setter で完備（§69+§108）**。
    既知の残（別件）: `C.m.bind(thisArg)` の thisArg 無視（§66 既知残）、`cc=C; cc.m()`（クラス値経由）、`super.staticM()`、
    computed/symbol 名の静的メンバ。

109. **静的メンバをランタイムオブジェクトモデルへ統一（`C.m.bind/call/apply(thisArg)` を honor）**: §66 以来の最大の残課題
    `C.m.bind/call/apply(thisArg)` が thisArg を無視する問題を解消。§66–§70 は静的メソッド/アクセサの `this.X` を
    **コンパイル時**に解決（静的コンテナへの LoadGlobal+LoadField、ランタイム this を無視）し、静的メソッド box を
    `takes_this=0` にしていたため、`invoke_with_this`（ts_rt.c）が bind/call/apply の thisArg を捨てていた。任意 thisArg を
    honor するには `this.X` を**ランタイム this から**読む必要があり、静的メンバ系を**ランタイムオブジェクトモデルへ
    作り直す大改修**（§66–§70 の compile-time 機構を置換）を実施。
    - **設計**（exporter 中心 + runtime 1 行）: (1) 静的コンテナをクラスチェーンで proto-link（`SetProto`）。has-or-inherits
      statics の全クラスにコンテナを付与（継承専用サブクラスも、`this.X=` の shadowing own-prop が JS 通りになるよう）。
      (2) 静的メソッドを `AllocClosure+StoreField`(field-key)、静的 getter/setter を `CallBuiltinStatic object.defineAccessor`
      でコンテナに登録（**新 IR 命令不要**、既存命令の組合せ）。(3) 静的メソッド/アクセサ本体を `this`=arg0 パラメータ
      （takes_this=1、currentClass 非設定＝プレーンオブジェクト）で lower（新 `staticThis` モード）→ `this.X` read/write は
      generic ts_get/ts_set、`this.m()` は動的 dispatch、すべて proto-walk でランタイム解決。(4) `C.m()` は
      `Direct(declFn, args:[container[receiver], ...])`、`C.v`/`C.v=` はコンテナへの ts_get/ts_set（accessor 自動起動）、
      `C.m` 値は takes_this=1 で box。(5) クラス値（`const K=C`）と no-ctor クラスの値参照をコンテナに proto-link/解決
      → `cc.staticX`/`cc.m()`/クラスを thisArg にした借用も解決。
    - **runtime 変更（最小）**: `ts_set_proto` を関数値にも適用（obj/func は ts_obj_common 先頭共有で proto 同一 offset）
      → クラス値→コンテナ link を可能に。`ts_array_map/filter/forEach/reduce/find/some/every/sort` 等の callback 呼びを
      `ts_call(cb)`→`ts_call_value(cb)` に（takes_this=1 の callback で element が this に食われ index にズレるのを修正、
      takes_this=0 では不変）。
    - **副次解消・簡素化**: §69/§70 のモノモーフィズム機構（specializeStaticMember/staticShadowsBetween/*FnFor 等）を
      **全削除**（subclass-aware this が proto 連鎖で自動化）。§67 の「継承静的フィールド `this` write は loud-reject」も
      **不要化**（ts_set がサブクラスのコンテナに own shadow prop を作る＝JS 通り）。`classOfExpr` が `typeof C`（construct
      signature 持ち＝static 側）を instance と誤分類して `this.staticMethod()` を空 vtable に devirt する潜在バグも修正。
    検証 vs V8 全一致（`.call(plainObj/instance/別クラス/同クラス)`・`.apply`・`.bind` + partial、間接 bind、callback
    `map(C.m.bind(...))`、`cc.staticX`/`cc.m()`、深い継承チェーン、static field-init `this`、module-cell capture 静的メソッド、
    getter→override メソッド、setter shadow、Object.keys 列挙性、instanceof、§66–§70 全回帰）。getter-only 代入は strict
    （class body）throw だが当方は ts_set で無視（sloppy eval 一致、in-method-strict のみ残）→ §68 の reject 撤去。
    全 CI 緑（conf 150/150, perf 全 budget 内, unit 全 PASS）。conformance: classes/static_bind_call_apply.ts。
    **静的メンバは field/method/getter/setter/this/bind-call-apply/クラス値経由まで JS 準拠で完備**。
    既知の残（別件）: detached `const f=C.m; f()`（this=undefined で this 使用メソッドは JS throw、当方は undefined 読み）、
    getter-only 代入の in-method strict throw、`super.staticM()`、computed/symbol 名の静的メンバ。

110. **`super.staticMethod()` / `super.staticField`（静的メンバの super 参照）**: §71 の残課題。静的メソッド/アクセサ内の
    `super.X` が loud-reject（`expression SuperKeyword`）だった。原因: インスタンスの `super.m()` は `ctx.currentClass`
    （定義クラス）で解決するが、§71 で静的本体は plain-this（currentClass 非設定）で lower するため super 分岐が不発火し
    `lowerExpr(super)` の汎用 catch-all に落ちていた。
    - 修正（**exporter のみ**, runtime/IR/analyzer 無改変）: §71 で削除した `FnCtx.staticClass`（定義クラス）を**super 解決
      専用に復活**（emitThis の staticThis 分岐 + lowerStaticInit で設定。`this.X` は §71 で generic 化済みなので staticClass
      を見ず、再発火しない）。(a) `super.m()` 呼び: super-call 分岐に静的版を追加 → `resolveStaticMethod(parentIdOf(staticClass))`
      を **this=現在の受信者**（`ctx.thisLocal`）で Direct 呼び（親メソッドの `this.X` が subclass view を読む）。(b) `super.X`
      READ: プロパティアクセス read に静的 super 分岐を追加 → **getter → メソッド値 → field の順**で親から解決（getter は
      `staticGetterFnOf` で親 walk し this=受信者で Direct 起動、メソッド値は AllocClosure、field は親コンテナチェーンから
      LoadGlobal+LoadField）。getter を field より先に解く（field 経路の ts_get(parentContainer) は this=parentContainer に
      なり super セマンティクスを外すため）。
    検証 vs V8 全一致（`super.m()`→親メソッド呼び、`super.x`→親フィールド read（subclass shadow を見ない）、`super.getter`
    →親 getter を this=受信者で起動、`super.m()` 内 `this.X` が subclass view、3 段チェーン `C→B→A`、インスタンス super 回帰）。
    全 CI 緑（conf 151/151, perf 全 budget 内, unit 全 PASS）。conformance: classes/super_static.ts。
    既知の残（別件）: `super.x = v`（super 書き込み、loud-reject 維持）、detached `const f=C.m; f()`、getter-only 代入の
    in-method strict throw、computed/symbol 名の静的メンバ。

111. **well-known symbol 静的メソッド（`static [Symbol.iterator]()` 等）**: §72 残の computed/symbol 静的メンバのうち、
    **silent miscompile** だった well-known symbol 静的メソッドを実装。`isDynComputedMember` は well-known symbol を除外する
    （exporter.ts:3230）ため静的 reject（5786）が発火せず、`memberKeyName` も computed 名で undefined なので静的メソッド/
    フィールド/アクセサの各 catch を素通りし、汎用 fallthrough で `mname = wkName`（"@@iterator"）→ **インスタンス
    `${classId}:method:@@iterator`（プロトタイプ vtable）に誤登録**されていた（§68 の静的 getter→インスタンス誤登録と同型）。
    → `C[Symbol.iterator]`（静的）は undefined、`new C()[Symbol.iterator]`（インスタンス）が誤起動。なお user-symbol/動的文字列
    静的メンバ・symbol 静的 field/accessor は `isDynComputedMember` true で既に loud-reject（安全）。
    - 修正（**exporter のみ**, runtime/IR/analyzer 無改変・§71 のコンテナ + 既存 symbol 機構を流用）: setupClasses で
      `isStatic && wellKnownMethodName(m) && isMethodDeclaration` を汎用 fallthrough より前に捕捉し、staticThis（takes_this=1）
      で lower（誤インスタンス登録の阻止）。lowerStaticInit でコンテナに `symbol.set(container, Symbol.x, boxedMethod)` 登録
      （`symbol.set`→ts_set_symkey→ts_set(container, TS_KEY_WKSYM(N))；インスタンスの @@iterator は CLASS_PROTO 上の同キーだが
      別オブジェクトなので非混同）。read `C[Symbol.x]`（symbol.get）/ `for...of C` / `[...C]` は §71 で `C`→コンテナ解決済み +
      既存 symbol.get/iterator 取得（proto walk）で動く（継承も解決）。変更不要。
    検証 vs V8 全一致（`typeof C[Symbol.iterator]`=function、`[...C]`/`for...of C`（非 generator iterator）、generator
    `static *[Symbol.iterator]()` の `[...C]`、generator 内 `this`=コンテナ、継承 `[...SubGen]`、**静的/インスタンス
    [Symbol.iterator] 同名の非混同**、§71/§72 全回帰）。全 CI 緑（conf 152/152, perf 全 budget 内, unit 全 PASS）。
    conformance: classes/static_symbol_method.ts。
    既知の残（別件・**いずれも pre-existing で loud**）: `for...of` over a **generator** `[Symbol.iterator]`（§112 で解消）、
    `yield*` over an array、静的メソッドが返す nested closure からの静的フィールド参照（`Range.count`）、symbol 静的
    field/accessor の loud-reject、`Symbol.hasInstance` の instanceof フック（メンバ登録/read は可だが演算子 dispatch は対象外）。

112. **`for...of` over a generator `[Symbol.iterator]`**: §73 で見つけた pre-existing バグ。`for (const x of obj)` で
    `obj[Symbol.iterator]` が generator メソッド（`*[Symbol.iterator]()`）だと crash（spread `[...obj]` は動く）。**2 つの
    別バグの複合**だった:
    - (a) **object literal の誤分類**: `isGeneratorType` の `/\bGenerator</`（型文字列のどこかに "Generator<" を含めば真）が
      `{ [Symbol.iterator](): Generator<...> }` のメンバ戻り型にマッチし、object literal 自身を generator と誤判定 →
      `ts_gen_next(obj)` を**オブジェクト直接**に呼んでいた（反復子を取得しない）。修正: `/\bGenerator</` を**型が自身の
      `next` プロパティを持つ**条件でゲート（real generator は next/return/throw を持つ、iterable は持たない）。
      `isAsyncGeneratorType` も同様。
    - (b) **for-of ステップが generator 非対応**: for-of の動的ステップ `emitIterNext` は `.next()` メソッド dispatch で、
      generator `[Symbol.iterator]()` が返す当方の generator オブジェクト（`next` プロパティ無し）で crash。`useBuiltin`
      （generator.next ビルトイン）は `isIterable && classMethodIsGenerator` のときだけ true で objSymIterable では false。
      修正: 新 runtime ヘルパ `ts_iter_step(iter, sent, nmk)` を導入し emitIterNext から呼ぶ。spread の `ts_array_push_all`
      同様、`next` を **field-key→method-key の順**で探し（`nmk`=interned "next" method key を exporter から渡す。class
      iterator の prototype method `next()` も拾う＝**重要な無回帰**）、無ければ `ts_gen_next` にフォールバック。
    検証 vs V8 全一致（object literal/静的クラス/変数経由の generator `[Symbol.iterator]` for-of・spread・早期 break、
    class iterator（`[Symbol.iterator](){return this}` + prototype `next()`）の for-of/`yield*`、plain iterator object、
    直接 generator、iterable class、array/Map/string for-of、§71–§73 全回帰）。一度 class iterator（method-key `next`）を
    field-key only で壊して気づき、両キー探索に修正（counter/iterator_close ベンチで検出）。
    全 CI 緑（conf 153/153, perf 全 budget 内, unit + 全ベンチ correct）。conformance: iteration/generator_symbol_iterator_forof.ts。
    変更: runtime/ts_rt.c(+ts_rt.h)（`ts_iter_step`）、analyzer/src/emit_c.rs（`iter.step:<id>` arm）、exporter（`emitIterNext`
    を CallBuiltin 化 + `isGeneratorType`/`isAsyncGeneratorType` 厳格化）。

## セッション 75（well-known symbol §73 周辺の再検証 — symbol データプロパティ + toStringTag）

> 残候補①②（well-known symbol 静的の silent miscompile 疑い）を再検証した結果、**①②は silent でなく loud-reject** と判明
> （`static [Symbol.X]()` は exporter.ts:5796 の静的 dynamic/symbol reject が §73 ガード(5846)より前に発火、`Symbol.hasInstance`
> instanceof も非静的 RHS が loud-reject）。代わりに**この周辺の本物の silent miscompile 2 件**（#113/#114）を発見・修正した。

113. **オブジェクトリテラルの symbol データプロパティ `{ [sym]: v }` を誤キーに格納する silent miscompile を修正**:
    object literal の computed データプロパティ lowering（exporter）が symbol キーを特別扱いせず、`{ [sym]: v }` /
    `{ [Symbol.X]: v }` を `StoreFieldDynamic` に落としていた。runtime `ts_set_dyn` は symbol キーを `ts_to_string_v` で
    文字列化（symbol → `"[object Object]"`）するため、**全 symbol データプロパティが同一の誤った文字列キーへ衝突格納**され、
    `o[sym]` は `undefined`（確認: `{[s]:5}`→`o[s]`=undefined(正5)、複数 symbol も全滅 `undefined undefined 3`(正`1 2 3`)）。
    symbol **メソッド** `{ [sym](){} }` と element-access 書き込み `o[sym]=v` は既に `symbol.set` で正しく、データプロパティ
    経路だけ漏れていた。
    - 修正: computed-property 分岐（`isPropertyAssignment && isComputedPropertyName`）の先頭に `isSymbolKeyExpr(nameExpr)`
      ケースを追加し、key→value の順（JS computed-key 評価順）で lower して `CallBuiltinStatic "symbol.set"`（→`ts_set_symkey`）
      を emit。well-known / user / registered(`Symbol.for`) symbol いずれも symbol キー（WKSYM/USERSYM）へ格納。
    - 変更は **exporter のみ**（既存 `symbol.set` builtin 再利用、analyzer/runtime 不変）。`isSymbolKeyExpr` は `Symbol.X`
      か型 `symbol`/`unique symbol` のみ true ＝ 動的文字列キーは誤分類せず従来 path。
    検証 vs V8 全一致（user/wk/registered symbol データプロパティ、複数 symbol 非衝突、string/numeric キー共存、
    key-before-value 評価順、同記述の distinct symbol）。conformance: symbol/symbol_data_property.ts。

114. **`Symbol.toStringTag` が `Object.prototype.toString` / 文字列強制変換で無視される silent miscompile を修正**:
    `ts_objproto_toString`（runtime）が `"[object Object]"` をハードコードし `[Symbol.toStringTag]` を読まなかった。
    `o[Symbol.toStringTag]="Foo"` は格納できる（symbol.set→WKSYM キー）のに、`o.toString()`/`String(o)`/`` `${o}` ``/`""+o`
    が tag を反映せず `"[object Object]"` を返していた（V8 は `"[object Foo]"`）。
    - 修正: array ショートカット後、object に対し `ts_get(self, TS_KEY_WKSYM(TS_WKSYM_TO_STRING_TAG))` を読み、**文字列なら**
      `"[object " + tag + "]"` を構築して返す（非文字列/未設定は従来の `"[object Object]"`＝ES 仕様 builtin タグ既定）。tag の
      バイトをローカル buffer にコピーしてから単一 `ts_new_string` で確保（self は args[0] で GC root、heap は mark/sweep
      非移動＝GC 安全）。own `toString` があれば従来どおり ToPrimitive の FIELD キー探索で shadow される。
    - この 1 関数が `o.toString()`/`String(o)`/`` `${o}` ``/`""+o`（ToPrimitive→toString METHOD キー経由）全てに効く。
      数値/フィールド hot path は無関係＝**perf 中立**。変更は **runtime のみ**（exporter/analyzer 不変）。
    検証 vs V8 全一致（element-access/リテラル両形、空 tag→`[object ]`、非文字列 tag 無視、own toString shadow、
    string/number/default hint 別経路、多語 tag）。conformance: coercion/tostringtag.ts。
    残（loud, スコープ外）: `Object.prototype.toString.call(o)`（`.call` 経由は別途 REJECT）、`class { get [Symbol.toStringTag]() }`
    （dynamic getter loud-reject）、console.log(obj) の symbol プロパティ非表示（inspector の別ギャップ・pre-existing）。

> **CI**: correctness 系（conf 155/155 = +2, conf_basic, fast, bench_correct1/2）全 PASS。当日はマシン負荷（WindowServer/iTerm/
> Chrome/Zoom 稼働 + **バッテリーモードの CPU スロットリング**）で perf budget が一律超過したが、**runtime 変更を revert しても同一
> タイム**（int_kernel 538⇄540ms 等、誤差内）＝コード起因でなく環境要因と実証（#113/#114 とも hot path 不変で perf 中立）。
> → AC 電源復帰後に perf 全 budget 内で**緑化を確認済**（#115 と同 CI ラン）。

## セッション 76（`yield*` over a built-in iterable）

115. **`yield*` over a built-in iterable（array / string / Map / Set）を実装（loud-reject / runtime-crash → 正）**:
    `yield* [1,2,3]` / `yield* "ab"` は "yield* over a non-iterable" で **REJECT**、`yield* new Map(...)` / `yield* new Set(...)`
    は **runtime crash**（"value is not a function"）だった（common パターン）。根因: yield* の lowering（exporter.ts:2492）は
    `resolveIterator` で iterator driver を得るが、(a) built-in array/string は resolveIterator が undefined を返す（`typeHasSymbolIterator`
    が array/string を除外、for-of は別のインデックス路で処理）、(b) Map/Set は `typeHasSymbolIterator` が `__@iterator` prop で true
    になり driver を返すが、**ランタイムに array/string/Map/Set の `Symbol.iterator` も array-iterator オブジェクトも存在しない**
    （spread は直接インデックス、`ts_iter_step` は array で done 即返し）ため実行時クラッシュ。
    - 修正（**exporter のみ**, runtime/IR/analyzer 無改変）: yield* 分岐で **resolveIterator より前**に `builtinReceiverKind(innerExpr)`
      を判定し、array/string/Map/Set を **インデックス yield ループ**で処理。新 helper `emitIndexYieldLoop(ctx, arr, isString)` が
      `lowerArrayIndexForOf`(4129) のインデックス機構を踏襲し、本体で要素を Yield（generator suspend）する。array→`LoadIndex`+`ArrayLen`、
      string→`string.charAt`+`GenericLen`、Map/Set→`map.entries`/`set.values` で配列化してから array ループ。yield* 式の値は
      `undefined`（built-in iterator の return 値）。sent 値は破棄（built-in iterator は無視＝正）、throw 転送/return 無し（同上）。
      genuine 非 iterable / `any` は従来の `unsupported(...)` を維持（loud-reject 据置）。
    - 既存の resolveIterator 駆動 yield*（generator / custom iterable / iterator）と for-of は**無改変**＝回帰最小。
    検証 vs V8 全一致（array/string/tuple/空/変数/関数返り/Map[k,v]/Set dedup/二連/for 内/nested gen 委譲/return=undefined/
    sent 無視/early break/**async generator が sync array に委譲**/spread・for-of consumer、回帰: inner generator・custom iterable の
    yield*）。全 CI 緑（**conf 156/156 = +1, ci_par 全 PASS（perf 含む, AC 電源）, unit 全 PASS**）。conformance: iteration/yield_delegate.ts。
    **副産物（探索で発見した別件の pre-existing silent miscompile, 本修正と無関係）**: ⑪ **class generator method**
    （`class C { *gen(){ yield 7 } }`）が plain yield でも**空を返す**（全滅, silent）。⑫ **for-of の配列分割代入で generator 消費**
    （`for (const [a,b] of gen())` が `0 0`、index アクセス `e[0]` は OK, silent）。いずれも yield* と独立・要 difftest 着手候補。

## セッション 77（class の generator/async メソッドが空を返す — SROA インライナの状態機械ガード欠落）

116. **class の generator メソッド（`*gen()`）が空を返す silent miscompile を修正（+ async メソッドの同根バグ）**:
    `class C { *gen(){ yield 7; yield 8 } }` で `[...new C().gen()]` が**空**（V8 は `[7,8]`）＝ silent。free-function generator
    （`function* g(){}`）は正常。**影響大**（任意の名前付き instance generator メソッドが全滅）。
    - **根因（exporter→analyzer まで追跡）**: exporter は method を正しく generator マーク（`lowerMethod`→`lowerFunctionLike`、
      `isGenerator=!!node.asteriskToken` を serialize）、analyzer の `emit_generator_function` も正しい entry point を emit＝ここまで正常。
      真因は **SROA インライナ**（`analyzer/src/sroa.rs`）: (1) 受信者 SROA 経路のインライン判定（378）が `is_generator`/`is_async` を
      見ず、generator 本体（`Yield` は `Return` でない＝`returns_only_in_tail_position`=true を通過）を呼び出し側へ展開→ coroutine
      破壊→空。(2) さらに `find_sroa_targets`（190）が generator メソッドの受信者を SROA 候補から除外せず、`new C()` の AllocObject を
      除去→`this`=undefined で `this.field` を読み **segfault**（this 使用 generator/async のみ）。
      **非対称の説明**: free generator は recv=None 経路で `is_inlinable_free_fn` を通り `Yield` を弾く→インラインされず正常。
      method generator だけが受信者 SROA 経路に入りガード無しで壊れた。static `*gen()`（受信者=静的コンテナ global で SROA 非対象）と
      早期 return 付き generator（`returns_only_in_tail_position`=false）は偶然動いていた＝根因の精密な裏付け。
    - **修正（analyzer/src/sroa.rs のみ、4 箇所）**: ① 受信者 inline 判定（378）に `&& !callee.is_generator && !callee.is_async`。
      ② `inline_callee` の nested-`this` 再帰（651）を `.filter(|c| !c.is_generator && !c.is_async)` で generator/async は remapped Call
      へフォールバック。③ `is_inlinable_free_fn`（550 冒頭）に `if f.is_generator||f.is_async { return false }`（非 SROA path + 空
      generator edge）。④ **新ヘルパ `needs_materialized_this`**: generator/async メソッド（受信者がコルーチンフレームへ捕捉＝escape）
      または推移的に `this` 上の state-machine メソッドを呼ぶメソッドの受信者を `find_sroa_targets`（190）で SROA 候補から除外
      （materialize 維持）。**generator/async は状態機械なので決してインラインしない＋その受信者は実体化する**が原則。新フィールド追加
      なし＝unit テスト不変。**async メソッドの対称な潜在バグも同時修正**（従来 await でマスクされ偶然動いていたが `.then` 消費で破綻
      していた→真の Promise を返す）。
    検証 vs V8 全一致（instance/this 使用/params/変数受信/継承/nested `this.gen()`/static/早期 return/index 駆動/混在 gen+plain/
    複数インスタンス独立/gen が `yield* this.a()` で別 gen 呼び/async メソッド await・.then、回帰: free generator・非 gen メソッドの
    インライン・hot メソッドループ）。全 CI 緑（**conf 157/157 = +1, ci_par 全 PASS（bench_correct + perf 全 budget 内 AC 電源）, unit
    全 PASS**＝重いメソッドインライン bench に回帰なし）。conformance: classes/generator_method.ts。
    **副産物（別件 pre-existing, 本修正と無関係）**: ⑬ `typeof promise.then` が `undefined`（`Promise.resolve(1)`/free async fn でも同様
    ＝Promise のメソッド値アクセスの別ギャップ。await/.then 呼び出しは正常）。⑫（for-of の配列分割代入で generator 消費）は別候補で残置。

## セッション 78（for-of/for-await の分割代入が generator/iterable 駆動で展開されない）

117. **for-of / for-await の分割代入パターンが generator/iterable 駆動で展開されない silent miscompile を修正**:
    `function* g(){ yield [1,2]; yield [3,4] }` を `for (const [a,b] of g()) console.log(a,b)` で回すと `0 0`（V8 は `1 2`/`3 4`）。
    index アクセス `for (const e of g()) e[0]` は正常＝yielded 値自体は正しく、**分割代入パターンの展開**だけが壊れていた（候補⑫）。
    - **根因**: for-of が generator/custom-iterable を回す `lowerDrivenForLoop`（exporter.ts:4237）は、ループ変数を `bindForVar`（4140）で
      作るが、宣言名が Identifier でない（=分割代入パターン）と**使い捨ての一時ローカルを返すだけ**（4146）。ループ本体（4260）は
      `LoadField(loopVar, res, "value")` で yielded 値を temp に入れるが、**パターンの束縛（a,b）を一切代入しない**→0/undefined のまま。
      配列高速路 `lowerArrayIndexForOf` は `lowerBindingPattern`（4190）で正しく展開しており、**driven 経路だけこの展開が欠落**していた。
    - **修正（exporter のみ、~5 行）**: `lowerDrivenForLoop` で init から分割代入パターン（非 Identifier 名）を抽出し、ループ本体の
      `LoadField` 直後に `if (destructurePat) this.lowerBindingPattern(ctx, destructurePat, loopVar)` を挿入（配列高速路と同型）。
      `lowerBindingPattern` 再利用で array/object/nested/default/rest/hole/rename 全パターン対応。`bindForVar` は分割代入時に既に fresh
      temp を返すので無改変。**共用 `lowerDrivenForLoop` のため `for await` の分割代入も同時に修正**。analyzer/runtime 無改変。
    検証 vs V8 全一致（generator 上の array/object/nested/default/rest/hole/rename 分割代入、custom iterable、async generator の
    `for await` 分割代入、bindings が値で計算を駆動、回帰: 単純変数 for-of over generator・配列/Map 分割代入 for-of（高速路）・§76/§77 全件）。
    全 CI 緑（**conf 158/158 = +1, ci_par 全 PASS（perf 全 budget 内 AC 電源）, unit 全 PASS**）。conformance:
    iteration/forof_destructure_generator.ts。残候補: ⑩ console.log の symbol 非表示、⑬ typeof promise.then（低優先）。

## セッション 79（symbol キーのクラスメンバ reject をまとめて解消）

118. **symbol/動的キーのクラスメンバ loud-reject をまとめて feature 化**（候補 ②⑤⑥⑨）。次を全て install + 読み出し対応:
    static symbol メソッド（`static [Symbol.toPrimitive]()`/`[mySym]()`）、static symbol フィールド（`static [Symbol.x]=v`/`[mySym]=v`）、
    static symbol アクセサ（`static get/set [sym]()`）、instance symbol アクセサ（`get/set [Symbol.toStringTag]()`/`[mySym]()`）、
    および**動的文字列キーの静的メンバ**（`static [k]`、k は文字列変数）。
    - **核心の発見**: runtime はシンボルキーの**データプロパティ**は既に完全動作（`ts_set_symkey`/`ts_get_symkey`→`ts_symbol_key`→
      `ts_set`/`ts_get`、アクセサ起動 `is_accessor` もキータグ非依存）。唯一の欠落は**シンボルキーのアクセサ定義**で、
      `ts_define_accessor_dyn` がキーを `ts_to_string_v` で文字列化していた。well-known symbol の消費は wksym キー経由で配線済み
      （`ts_to_primitive`=`TS_KEY_WKSYM(TO_PRIMITIVE)`、`Object.prototype.toString`=`TS_KEY_WKSYM(TO_STRING_TAG)`）なので、static
      `[Symbol.toPrimitive]` をコンテナに / instance `[Symbol.toStringTag]` をインスタンスに install するだけで `+C`/`String(C)`/
      `String(obj)` が**無料で**参照する。
    - **修正**: (1) runtime に `ts_define_accessor_symkey`（`ts_define_accessor_attr` を `ts_symbol_key(sym)` でラップ、文字列化せず。
      ts_rt.c/.h、読み書き・起動は ts_get/ts_set がキータグ非依存で処理＝他変更不要）。(2) emit_c.rs に builtin
      `symbol.defineAccessor:g:s:e:c`（object.defineAccessor と同型で `ts_define_accessor_symkey` を emit）。(3) exporter:
      setupClasses の一律 static reject（5874）を撤廃し、symbol/動的キーの method/field/accessor を install 経路へ振り分け
      （メソッド/アクセサは §73 流の**ノード同一性**＝`this.fnId.get(m)` で install するため文字列名レジストリ不要、`thisName:""` で
      staticThis lower → this=コンテナ）。lowerStaticInit に symbol/動的の method（symbol.set / StoreFieldDynamic）・field・accessor
      （キー式 getText() で getter+setter を対化 → symbol.defineAccessor / object.defineAccessor）install を追加。instance symbol/動的
      アクセサは emitFieldInitializers に pre-pass（getText() グルーピング → defineAccessor）を追加し fnId は AST walk（499 付近の
      `isDynComputedInstallAccessor`）で付与。**重要な追加修正**: §49 の module-cell publish（Step F の static-init scan）が
      **静的 dynamic/symbol メンバのキー式・本体・初期化子を走査していなかった**ため、`const s=Symbol()` を key に使うと __static_init
      実行時に key が未公開（undefined）で install されなかった（`ts_set_symkey(container, UNDEF, fn)`=no-op）。Step F scan を Step F'
      （instance）同型に拡張して解消。
    - **loud-reject 維持（silent 回避）**: `static [Symbol.hasInstance]`（instanceof が hook を参照しないため、定義を許すと silent
      miscompile。ユーザ判断で feature 化は見送り、専用 reject）/ generator・async の symbol・動的キーメソッド（状態機械を
      data-property closure に install 不可、instance 既存 reject と整合）。
    検証 vs V8 全一致（static toPrimitive/user-symbol method/field/get-set accessor/継承/this=class、dyn-string static field/method、
    instance get/set accessor/toStringTag via String・template/getter-only/explicit-ctor、回帰: §73 well-known static iterator
    generator・既存 symbol 全件）。`rejects_syntax.sh` の「static dynamic computed member」「dynamic computed getter」は now-supported に
    なったため除去し `rejects_symbol.sh` に positive + 新 reject（hasInstance/gen/async）を追加。全 CI 緑（**conf 160/160 = +2, ci_par
    全 PASS（perf 全 budget 内 AC 電源）, unit 全 PASS**）。conformance: classes/static_symbol_members.ts, classes/instance_symbol_members.ts。
    残（別件・本修正対象外）: ⑧ `Object.prototype.toString.call(o)`（`.call` 経由が REJECT＝static/instance toStringTag を
    Object.prototype.toString で観測するテストは未掲載、直接 `[Symbol.toStringTag]` read と String(obj) で代替）、① Symbol.hasInstance
    instanceof フック（feature 未実装→**§80=#119 で実装**）。

## セッション 80（Symbol.hasInstance instanceof フックを実装＝候補①解決）

119. **`static [Symbol.hasInstance]` の instanceof フックを feature 化**（候補①、§79 で安全のため残した loud-reject を解禁）。
    `x instanceof C` が `C[Symbol.hasInstance](x)` を呼び（this=C）戻り値の ToBoolean を返す＝通常のプロト鎖アルゴリズムを上書き。
    §79 で `static [Symbol.hasInstance]` の定義は専用 reject にしていた（「instanceof が hook を参照しないと、定義許可は silent
    miscompile」）が、今回フック参照とセットで実装し解禁。
    - **§79 機構の再利用が鍵**: `static [Symbol.hasInstance](x){}` はただの symbol 静的メソッド＝§79 の install 経路で
      コンテナの `TS_KEY_WKSYM(TS_WKSYM_HAS_INSTANCE)`（=3）キーに boxed（takes_this=1）install される。コンテナはクラス鎖で
      proto-link 済み（§71）なので**継承 hook も `ts_get` で自動解決**。よって reject 解除 + instanceof 側の参照追加だけで完成。
    - **修正**: (1) runtime `ts_instanceof_hook(klass, obj)`（`ts_get(klass, WKSYM(3))`→`ts_call_method(h, [klass,obj], 2)`→
      `ts_bool(ts_truthy(...))`。GC root 不要＝ts_to_primitive の hook 呼びと同型の短命 args。ts_rt.c/.h）。(2) emit_c.rs に
      `instanceof.hook` arm（tsv bool を返すので ts_bool ラップ不要）。(3) exporter: setupClasses の static 振り分けから
      `isDynComputedHasInstance` reject を削除（→ symbol メソッド install 経路へ）、新ヘルパ `classHasHasInstanceHook(classId)`
      （自クラス+祖先で `static [Symbol.hasInstance]` を検出）、instanceof lowering で `rclass !== undefined &&
      classHasHasInstanceHook(rclass)` のとき LHS を lower → コンテナ LoadGlobal → `CallBuiltinStatic "instanceof.hook"
      [container, obj]`。**hook は通常アルゴリズムを上書きするため `staticallyTrue` ショートカットより前に分岐**（real instance でも
      hook が false を返せば false になる）。非静的 RHS は従来どおり reject、hook 無しクラスは従来のプロト鎖 `instanceof` builtin。
    検証 vs V8 全一致（hook always-true/条件付き true・false・LHS が object/primitive、proto-walk 上書き（new C() instanceof C=false）、
    継承（Sub に hook 無し→Base の hook 使用）、hook が this/クラス state 参照、回帰: hook 無しクラスのプロト鎖 instanceof・継承・
    §79 symbol メンバ全件）。`rejects_symbol.sh` の `rej "static [Symbol.hasInstance]"` を positive `ok` に変更。全 CI 緑
    （**conf 161/161 = +1, ci_par 全 PASS（perf 全 budget 内 AC 電源）, unit 全 PASS**）。conformance: classes/symbol_hasinstance.ts。
    残（別件）: ⑧ `Object.prototype.toString.call(o)`（`.call` 経由が REJECT→**§81=#120 で実装**）。

## セッション 81（Object.prototype.toString.call(o) の .call 経由を実装＝候補⑧解決）

120. **`Object.prototype.toString.call(x)` / `.apply(x)` を実装**（候補⑧）。従来 `Object.prototype` が first-class value
    未対応で loud-reject（exporter.ts「'Object.prototype' as a first-class value」）。これは値の内部型タグを取る定番イディオムで、
    `x.toString()`（最派生 toString へ dispatch）とは別物＝**仕様の Object.prototype.toString を任意の `this` に適用**し
    `[object Array]`/`[object Number]`/`[object Null]` 等のタグを返す。
    - **修正3ファイル**: (1) runtime `ts_objproto_tostring_call(v)`（仕様タグ: undefined→"[object Undefined]"、null→"[object Null]"、
      `[Symbol.toStringTag]` 文字列なら "[object <tag>]"（§75 #114 のバッファ構築踏襲）、以降 array/func/symbol/num/str/bool/object の
      型述語で builtin タグ。既存 `ts_objproto_toString`（o.toString() 用＝配列 join）は**流用せず別関数**で既存パスを乱さない）。
      (2) emit_c.rs の CallBuiltinStatic dispatch（~2109）に `object.protoToStringCall` arm。(3) exporter: ヘルパ
      `isObjectProtoToString(e)`（`Object.prototype.toString` チェーンを照合、`isBuiltinNamespaceRef(_,"Object")` 流用）+ CallExpression
      lowering 冒頭（Symbol 特例直後）で `(...).call/.apply` がそれに掛かれば args[0]（無ければ undefined）を recv に
      `CallBuiltinStatic "object.protoToStringCall"`。
    - **scope**: 直接イディオムのみ。`const f = Object.prototype.toString; f.call(o)`（値経由）と `Object.prototype.hasOwnProperty.call`
      等の他メソッドは loud-reject 維持（first-class builtin 値モデルが要る別件）。
    検証 vs V8 全一致（object/array/number/string/bool/null/undefined/function/class instance/[Symbol.toStringTag] override/`.apply`
    形式、回帰: `o.toString()` 直接（配列 join / "[object Object]"）不変、値経由は依然 loud-reject）。全 CI 緑
    （**conf 162/162 = +1, ci_par 全 PASS（perf 全 budget 内 AC 電源）, unit 全 PASS**）。conformance: coercion/objproto_tostring_call.ts。

## セッション 82（console.log/dir が symbol プロパティを非表示の silent miscompile）

121. **`console.log(obj)` / `console.dir(obj)` が symbol キーのプロパティを表示しない silent miscompile を修正**（候補⑩）。
    `console.log({ a:1, [Symbol("x")]:"X" })` を Node は `{ a: 1, Symbol(x): 'X' }` と表示するが当方は `{ a: 1 }`＝symbol
    プロパティを脱落（値は正しく格納済で `o[sym]` は読める＝表示のみの silent miscompile、conf は Node オラクルで DIFF 検出）。
    - **根因**: 構造インスペクタ `inspect_val`（ts_rt.c）はオブジェクトを `ts_prop_own_enum` で列挙するが、その enumerable
      フィルタが `ts_field_name(key)` を引くため **symbol キー（USERSYM/WKSYM レンジ）は field 表に無い→除外**。加えて
      プロパティキー（uint32）から symbol の description を復元する術が無い（`o[sym]=v` のキーは `TS_KEY_USERSYM(sym_id)` で
      symbol 値は残らず、`g_symreg` は Symbol.for 専用）。
    - **重要な制約**: `ts_prop_own_enum` は `Object.keys`/`values`/`entries`/`assign`/`JSON.stringify`/spread/`defineProperties`
      でも使われる。symbol は仕様上 Object.keys/JSON/for-in に出てはいけないので **`ts_prop_own_enum` は無改変**とし、symbol
      列挙は **inspector 内に閉じた別パス**で実装。
    - **修正（runtime のみ・exporter/analyzer 無改変）**: (1) `sym_id → description` の side table `g_sym_desc`（`ts_symbol_new`/
      `ts_symbol_for` で登録、append-only・sym_id 添字。GC は**内容を**マーク＝realloc 安全）。(2) インスペクタに symbol-prop
      パス追加: `inspect_symbol_key`（`Symbol(desc)` を出力。USERSYM は side table、WKSYM は `ts_wksym()→description`。`'`/`\` を
      `inspect_qstr` 同様にエスケープ）、`count_own_enum_sym_props`、`inspect_own_sym_props`（props 配列から enumerable な symbol
      キーを挿入順に。アクセサは `[Getter]/[Setter]` 非起動表示）。`inspect_val` のオブジェクト枝で **string プロパティの後**に
      symbol を出し、`{}` 判定に symbol 数も加味、先頭カンマ `first` を共有。
    - **Node 形式（v25, オラクル）**: `Symbol(desc): value`（**ブラケット無し**・クォート無し）、string キーの後。空 description は
      `Symbol()`、registered/well-known も description で表示（`Symbol(k)` / `Symbol(Symbol.iterator)`）。非 enumerable symbol
      アクセサ（§79 instance `get [Symbol.x]()`）は非表示＝Node 一致。
    - **scope**: plain object 対象（class instance も props の symbol を拾うがテストは plain object のみ＝当方は `ClassName {` タグ
      非出力の既知差異があるため）。Map/Set のインスペクタ枝は entries のみ（現状維持）。
    検証 vs V8 全一致（string+symbol 混在順・symbol のみ・空 desc・Symbol.for・複数 symbol 挿入順・well-known キー・nested・
    配列要素・値の型別整形・console.dir・非 enumerable のみ→`{}`・desc 内 quote/backslash エスケープ・GC ストレス 2000 symbol、
    **回帰: Object.keys/JSON.stringify に symbol 非出現**・symbol 無しオブジェクト/配列/Map/Set の従来表示・String(obj)）。全 CI 緑
    （**conf 163/163 = +1, ci_par 全 PASS（perf 全 budget 内 AC 電源）, unit 全 PASS**）。conformance: symbol/console_inspect.ts。

## セッション 83（typeof promise.then が undefined＝Promise メソッドの一級値化）

122. **`typeof promise.then` が undefined（`.then`/`.catch`/`.finally` の値アクセス）を修正**（候補⑬、§61 と同クラス）。
    値として参照すると undefined（`Promise.resolve(1).then`・free async fn 戻り値も同様。`promise.then(cb)` 呼び・`await` は正常）。
    - **根因（2 つ）**: (1) exporter の値化経路（1504）が `vrk !== "promise"` で promise を明示除外。(2) 除外を外しても
      `ts_get(promise, key)` が即 undefined（`ts_promise` は `ts_obj_common`/proto を持たず `kind_has_common_header(TS_KIND_PROMISE)`
      が false でガード）。両方の対処が必要。
    - **方針（最小・低リスク）**: `ts_get` が string/number プリミティブを**共有 proto**へ振り分けるのと同型に、promise 用共有
      proto `g_promise_proto`（then/catch/finally を boxed 登録）を用意し `ts_get(promise,key)` をそこへ委譲。**`ts_promise`
      構造体も promise の GC も無改変**（§45-46 GC バグ歴を踏まえ構造体レイアウト変更を回避）。array-proto パターン踏襲。
    - **修正（4 層）**: (1) runtime: `ts_promiseproto_then/catch/finally`（takes_this=1, args[0]=this promise。detached 呼び＝
      this 非 promise は ts_is_promise ガードで no-op＝クラッシュ回避・許容逸脱）+ `g_promise_proto`/`ts_promise_proto_init`（**明示
      GC-root**＝promise から参照されないため）/`register`（proto=NULL で then/catch/finally のみ公開＝他キーは従来どおり undefined）
      + `ts_get` に promise 分岐（string/number と同型の proto walk）。(2) escape_ir.rs: `promise_proto_methods` フィールド。
      (3) emit_c.rs: `ts_setup_promise_proto` emit + main で呼ぶ。(4) exporter: 1504 の `vrk !== "promise"` 除外を削除 +
      programJson に `promiseProtoMethods`。**unit テストの Program リテラル 6 ファイルに `promise_proto_methods: vec![]` 追加**
      （§64 教訓: Program 新フィールドは tests/*_tests.rs も要更新）。
    - **scope**: 値アクセス（typeof/代入/受け手付き呼び `p.then.call(p,cb)`/コールバック渡し）。CALL 経路（CallBuiltin "promise.then"）・
      await・combinators は無改変＝既存 Promise 全機能に回帰なし。detached `const f=p.then; f(cb)`（this 無し）は JS throw だが当方は
      undefined（クラッシュ無し・許容逸脱）。
    検証 vs V8 全一致（typeof then/catch/finally（var/`Promise.resolve(1).then`/async fn 戻り値）・`const f=p.then;typeof f`・
    `p.then.call(p,cb)` 解決・回帰: `p.then(cb)`/await/`Promise.all/race/allSettled/any`/catch・finally chain・promise の他キーは
    undefined のまま）。全 CI 緑（**conf 164/164 = +1, ci_par 全 PASS（perf 全 budget 内 AC 電源, async/promise bench 回帰なし）,
    unit 全 PASS**）。conformance: closures/promise_method_value.ts。

## セッション 84（-0 Step 1: リテラル -0 + console 表示。hot path 無変更）

123. **`-0`/`-0.0` リテラルの負ゼロを正しく表現**（既知限界 -0 の Step 1。実行時算術 -0 は perf リスクのため後回し＝ユーザ確定）。
    従来 `console.log(-0)`→"0"(Node "-0")、`Object.is(-0,0)`→true(Node false)、`1/-0`→Infinity(Node -Infinity) 等が誤り。
    - **真因（NaN-boxing は無罪）**: double -0.0 は memcpy box/unbox で符号ビット保持、`ts_object_is` も `signbit` 比較済み。
      問題は **int 特化最適化** `infer_int_locals`（emit_c.rs）が 0 値ローカルを C の `long long` に落とし、`(long long)(-0.0)==0`
      で符号消失。`-0` リテラルも「0 は int 適格＋単項 - は int 維持」で +0 化。加えて `ts_fmt_num` が -0.0 を `%lld` で "0" 表示
      （String には正しいが console には誤り）。probe で `Object.is(x,-0)`=true だったのは両辺 +0 の偶然。
    - **修正（hot path 無変更）**: (1) escape_ir.rs に `ConstVal::NegZero`（JS の `JSON.stringify(-0)`="0" で -0 を数値 IR に
      運べないため専用タグ。NaN/±Inf と同列）。(2) exporter: 単項マイナス lowering で `-0`/`-0.0`/`-(0)` リテラルを検出し NegZero
      const を emit。(3) emit_c: NegZero は infer_int_locals で int 不適格（Num/Bool のみ int 適格＝自動的に非 int）、Const codegen で
      `set_num(-0.0)`（double リテラルで符号保持）、collect_non_numeric_consts に numeric 追加。(4) runtime: `ts_print_to` と
      `inspect_val` の number 分岐に `if (d==0.0 && signbit(d)) "-0"` を ts_fmt_num の前に（**console/inspect のみ**。ts_fmt_num・
      ts_object_is は無改変＝String/template/JSON は "0" 維持、Object.is は既存 signbit）。
    - **直る**: `-0`/`-0.0` リテラル、`console.log(-0)`/`[-0]`/`{a:-0}`→"-0"、`Object.is(-0,0)`=false/`(-0,-0)`=true（本物）、
      `1/-0`=-Infinity、`-0.0` 変数経由の 1/x・console.log・Object.is、`-(0)`。**不変**: String/template/`+`/JSON="0"、`-0===0`=true。
    - **`Math.round` も追加修正（runtime 単独）**: `ts_math_round`(ts_rt.c:1541) は `floor(x+0.5)` で `[-0.5,-0]` の符号を落として
      いた→`if (r==0.0 && (x<0.0 || signbit(x))) return -0.0;` を追加。`Math.round(-0.2)`/`(-0.5)`/`(-0)`→-0、half-toward-+Inf
      （2.5→3, -2.5→-2）は不変。`Math.trunc/ceil/floor` は C 関数が -0 を保持するので元から正しい（**`Math.sign(-0)` も元から正しい**）。
    - **`Math.round` も追加修正（runtime 単独）**: 上記。
    - **定数算術の -0 も畳み込みで対応（追補・exporter のみ・ユーザ提案）**: 汎用畳み込み/peephole は無かったので、新ヘルパ
      `constNumValue(node)` が**定数数値式を native JS で評価**（exporter は JS で動くので `%`/`**`/ビット演算の意味論が exact、
      Rust 再実装の miscompile リスク無し）。lowerExpr 冒頭で binary/prefix/paren ノードを評価し、**結果が `Object.is(cv,-0)` の時
      だけ** NegZero const を emit（それ以外の定数結果は完全に従来どおり＝汎用畳み込みはせず NaN/±Inf タグ誤りリスクを負わない）。
      定数式は副作用無しなのでオペランド lowering skip は安全（`0*sideEffect()` は非定数→畳まれず副作用維持）。§84 の prefix
      リテラル -0 検出は constNumValue が包含するので削除・一本化。**直る**: `0*-1`・`-1*0`・`-4%2`・`0/-1`・`(2-2)*-1` 等の**定数**算術 -0。
    - **残る既知限界（Step 2-4・後回し、docs/TODO.md に設計保存）**: **runtime 変数**オペランドの -0（`-z`(z=var)・`0*y`・`a%b`）
      **のみ** int 特化で +0 のまま（constNumValue は undefined→畳まれない）。完全修正には `may_minus_zero` facts + range/非負性
      解析が要る（int 乗算ループの perf リスク大）。
    検証 vs V8 全一致（「直る」「不変」全件 + Math.round + 定数算術 -0 + 回帰: `0*1`/`-1*-1`/`0.1+0.2`/`1/(1*0)`=Inf）。残限界
    （runtime 変数 -0）は DIFF のまま＝想定内。全 CI 緑（**conf 165/165, ci_par 全 PASS（perf 全 budget 内＝hot path 無変更で中立,
    AC 電源）, unit 全 PASS**）。conformance: numbers/negative_zero.ts（リテラル/定数算術/Math の -0 を収録）。**残 won't-fix（runtime
    変数 -0）は `tests/known_neg_zero.sh` で現挙動 pin**（`-z`・`0*y`。Step 2-4 で直ったら CHANGED で検出→conformance へ移す）。
    検出: 構文上 `-0` は `PrefixUnary("-", NumericLiteral(0))`。constNumValue が `-0`/`-0.0`/`-0x0`/`-(0)`/定数算術を網羅
    （`f(-0)`/`let x=-0` も引数/変数経由で -0.0 保持を確認済）。

## セッション 85（`super.x = v` — super 経由の書き込み）

124. **`super.x = v`（super 経由の書き込み）を実装**（§72 残「super 書き込み loud-reject」を解消）。READ 側（super.x 静的 §72・
    super.m() §72/§73）の resolution を WRITE に対応付け（exporter のみ・runtime/analyzer 無改変）。
    - **JS 意味論**: 親プロトタイプから setter を解決し this=受信者で呼ぶ。無ければ受信者に own データを書く（現クラス自身の setter は飛ばす）。
    - **修正（exporter）**: (1) `staticSetterFnOf`（`staticGetterFnOf` の鏡像、staticSetterFunc をチェーン探索）。(2) `isPlainFieldStoreTarget`
      冒頭に super ガード（super.x は pre-eval 経路だと `lowerExpr(super)` で reject するので単純 `lowerAssignTarget` 経路へ）。
      (3) `lowerAssignTarget` の PropertyAccess 分岐先頭に super.x=v: **静的**=親静的 setter を Direct-call（this=container, args[this,v]）/
      無ければ container へ StoreField（own データ）。**インスタンス**=宣言済みデータ field を `this` へ StoreField（own、自クラス setter を飛ばす）。
    - **directcall setter の形**: `{kind:"Call", callee:{kind:"Direct",func}, args:[this, value]}`（1390/2197 と同型）。
    - **loud-reject 維持（安全・no crash/no silent）**: (a) **インスタンスで親が setter accessor** の super 書き込み＝親 setter への Direct
      call が **SROA で受信者が実体化されず segfault**（非エスケープ instance のとき。Direct call の escape は callee summary を使い setter は
      this を escape しないと判定→object が scalar-replace される）。plain StoreField だと setter を黙ってバイパス（silent）するので reject。
      静的 super setter は container が global で SROA 非対象＝安全に動く。(b) 親 getter-only の super 書き込み（JS throw）。(c) undeclared
      プロパティへの super 書き込み（`this.<undeclared>=v` 相当＝非エスケープ instance の dynamic prop が SROA で undefined になる既存限界。
      silent 回避のため reject）。**注**: super METHOD が field を書く（`super.init()` で this.x=v）のは非エスケープでも動く＝accessor setter の
      Direct call 経路だけが SROA で実体化されない（将来 SROA の受信者 materialize で解消可）。
    検証 vs V8 全一致（instance 宣言 field（継承/own）・static データ（own on container, 親不変）・static 親 setter・grandparent 静的 setter・
    `(super.x=v)` が rhs を返す・回帰 this.x=v/§72 super read/super.m()）。reject 確認（instance 親 setter / undeclared）。全 CI 緑
    （**conf 166/166 = +1, ci_par 全 PASS（perf 全 budget 内＝exporter のみ, AC 電源）, unit 全 PASS**）。conformance: classes/super_assign.ts、
    reject: rejects_syntax.sh。残（別件）: instance 親 accessor setter の super 書き込み（SROA 受信者 materialize 待ち）、instance super.x READ。

## セッション 86（super.x=v: instance 親 accessor setter も対応＝§124 の制限を解消）

125. **`super.x = v` で instance が親の accessor setter を呼ぶケースを解禁**（§124 で SROA segfault のため loud-reject にしていた残を解消。
    ユーザの洞察「非エスケープなら親も子も構造体に展開できるはず」が正しかった）。
    - **根因の精密化**: §124 では super-setter を `Call {Direct, args:[this, rhs]}`（recv 無し）で emit していた。SROA の `inline_callee`
      の nested-`this` 再帰（sroa.rs:688）は `this` が **`recv`** の Direct call だけを再帰展開する。super-**method** 呼びは
      `recv: ctx.thisLocal`（exporter.ts:2207）で emit されるため完全に scalar-replace されて動く（`super.init()` で `this._v=9` が
      scalar 代入 `v6=ts_num(9)` に化け、`new B()` は消去）。super-**setter** だけ `args[0]=this` だったので 688 にマッチせず、generic
      remap で `this` が消去済みオブジェクトを指し segfault していた。
    - **修正（exporter 1 行相当・SROA 無改変・materialize 不要）**: super-setter の Direct call を `recv: ctx.thisLocal, args:[rhs]` に変更
      （super-method と同じ形）。これで既存の inline_callee 再帰が setter 本体の `this.field` 書き込みを scalar 代入に展開＝**完全に
      scalar-replace、perf 退化なし**（むしろ最適化が効く）。instance branch の親 setter は `resolveMemberFunc(parent,"setter")` を Direct-call。
      §124 で入れた instance-親-setter の loud-reject を削除。
    - **検証 vs V8 全一致**: instance 親 setter（this=受信者、subclass の override を飛ばして親 setter / grandparent setter 解決）、
      非エスケープでも scalar-replace、エスケープ時も可、§124 の全ケース継続。残 loud-reject: getter-only super 書き込み（JS throw）、
      undeclared プロパティ（`this.<undeclared>=v` の既存 SROA 限界）、static で受信者が setter を override し親に無い稀ケース。
    全 CI 緑（**conf 166/166, ci_par 全 PASS（perf 全 budget 内＝exporter のみ・SROA 無改変, AC 電源）, unit 全 PASS**）。conformance:
    classes/super_assign.ts（instance 親 setter / skip-override / grandparent を追加）、reject 更新（rejects_syntax.sh）。
    **教訓**: 「super 呼びは recv で渡す」＝inline_callee の nested-this 再帰に乗せると、非エスケープオブジェクトが親メソッド/setter 込みで
    完全に scalar-replace される。新たに super 経由の呼びを emit する時は **args[0] ではなく recv** に this を置くこと。

## セッション 87（instance `super.x` READ）

126. **instance の `super.x` READ（super 経由のプロパティ読み）を実装**（§85/§86 の WRITE と対称。静的 super.x READ=§72、`super.m()` CALL=
    §72/2202 は実装済で、instance の読みだけ欠落していた）。exporter のみ・runtime/analyzer 無改変。compound `super.x += v` も解禁。
    - **JS 意味論（Node v25 実測）**: `super.x` は**親プロトタイプ**への [[Get]]（this=受信インスタンス）。親 getter→this=受信者で呼ぶ、
      親メソッド→関数値（typeof "function"）、**データフィールド→undefined**（インスタンスフィールドは prototype でなく各インスタンスの
      own prop なので super 経由では不可視。静的 super.x がフィールドを読めるのと異なる）、setter-only/不在→undefined。
    - **修正**: 静的 super.x READ（exporter.ts:1384）直後に instance 版を追加。`resolveMemberFunc(parent,"getter")`→`Call{Direct, recv:
      ctx.thisLocal, args:[]}`（**§86 の教訓どおり recv で this を渡し** inline_callee の nested-this 再帰に乗せ、非エスケープインスタンスで
      getter の `this.field` 読みを scalar 展開）、`resolveMemberFunc(parent,"method")`→`AllocClosure`（§72 静的 super method-value と同型）、
      それ以外（データフィールド/setter-only/不在）→`Const undefined`。既存 helper 流用、新規ヘルパ無し。
    検証 vs V8 全一致（super.field→undefined、typeof super.method→"function"、super.method()→call（回帰）、super.getter→値、getter が
    this 経由、setter-only/absent→undefined、compound `super.n+=5`→15、grandparent getter、非エスケープでも scalar-replace）。全 CI 緑
    （**conf 167/167 = +1, ci_par 全 PASS（perf 全 budget 内＝exporter のみ, AC 電源）, unit 全 PASS**）。conformance: classes/super_read.ts。
    これで `super.x` は instance/static とも READ/WRITE/CALL が JS 準拠で完備（残: super への書きの getter-only/undeclared/static-override 稀ケースのみ reject）。

## セッション 88（super 書き込みの残 reject 3 種を解消＝super.x=v 完全対応）

127. **`super.x = v` の残 loud-reject 3 種を解消**（getter-only / static-override / undeclared）。**Node v25 実測で正確な挙動を確定**:
    getter-only（親が getter のみ）の super 書き込みと static-override（受信クラスが独自 static setter を持ち親は持たない）は **JS が
    TypeError throw**、undeclared（`super.foo=v` で foo 未宣言、または B が prototype に setter）は **`this` に own データを書く**（throw しない）。
    - **修正（exporter のみ・runtime/analyzer 無改変）**: 新ヘルパ `emitThrowTypeError(ctx,node,msg)`（new Error 構築パターン exporter.ts:1042
      踏襲＝AllocObject + .message + .name="TypeError" + `Inst::Throw`。tsaot の catchable throw=ts_throw setjmp/longjmp + `errors/
      throw_and_catch.ts` 前例を活用）。(1) instance 親 getter-only → emitThrowTypeError。(2) static 親 getter-only・**受信者 override**
      （`staticSetterFunc.has(${staticClass}:static:${nm})`）→ emitThrowTypeError。(3) instance undeclared → **`StoreFieldDynamic`(this,nm,v)**
      に置換＝own データを書き、かつ SROA の find_sroa_targets が StoreFieldDynamic の obj を disqualify＝**非エスケープインスタンスでも
      materialize されて正しく動く**（`this.<undeclared>=v` の既存 SROA 限界を回避。B が prototype に setter を持つだけのケースも own データ＝
      instance setter は compile-time 解決で StoreFieldDynamic は起動しない＝JS の「own データを書き setter を飛ばす」と一致）。
    - **conformance は throw を必ず catch して `e.name`("TypeError") を比較**（uncaught は tsaot "Uncaught exception"+abort(134) vs Node
      TypeError+exit1 で stderr/exit が異なるため。.message は典型文言が V8 と違うので typeof のみ assert）。
    検証 vs V8 全一致（getter-only instance/static throw、static-override throw、undeclared→own データ（非エスケープ/escape 両方）、
    B-prototype-setter→own データ、throw 後の制御継続、回帰: §85/§86/§87 の super 全件）。**super.x=v は全ケース「正しく動く or 正しく throw」
    ＝loud-reject 全廃**。全 CI 緑（**conf 168/168 = +2, ci_par 全 PASS（perf 全 budget 内＝exporter のみ, AC 電源）, unit 全 PASS**）。
    conformance: errors/super_assign_throws.ts, classes/super_assign.ts（拡張）。rejects_syntax.sh から super 書き込み 2 件削除。
    **これで `super` 一式（instance/static の READ/WRITE/CALL）は JS 準拠で完全に reject フリー**（§72〜§88）。

## セッション 89（値経由 builtin メソッド: Object.prototype.{toString,hasOwnProperty,valueOf} 一級値化）

128. **`Object.prototype.{toString,hasOwnProperty,valueOf}` を一級関数値化**（値経由 builtin メソッド。§81 は `toString.call` 直接形のみ
    だった）。`const f = Object.prototype.toString; f.call([1,2])`→"[object Array]"、`typeof f`→"function"、
    `Object.prototype.hasOwnProperty.call(o,k)`、`.apply`/`.bind`、`Object.prototype.valueOf.call(o)===o` が全て動く。**exporter + emit_c
    のみ・runtime 無改変**（helper は全て既存）。
    - **鍵**: `LoadBuiltinFn` codegen（emit_c.rs:2349）は `takes_this=0` 固定だったが、Object.prototype メソッドは `.call(thisArg)` で受信者を
      args[0] に注入させるため **takes_this=1 が必要**（`ts_funcproto_call`/apply/bind は takes_this=1 の時だけ thisArg を args[0] に注入）。
    - **修正**: (1) exporter: `objectProtoMethodName(e)`（`isObjectProtoToString` を一般化、`Object.prototype.<m>` チェーン照合）+ PropertyAccess
      値ロワリングで `node.expression`(=Object.prototype、reject 元)を lower する**前**に検出し `LoadBuiltinFn{builtin:"objproto."+m}` を emit
      （これで値形も `.call` の受信者ロワリングも通る。§81 の toString.call 直接特例は高速路として残置）。(2) emit_c: LoadBuiltinFn で
      `objproto.*` を **takes_this=1** で box、`fnval_adapter_body` に 3 arm（toString→**`ts_objproto_tostring_call`**=spec タグ（dispatch 版
      の配列 join ではない）、hasOwnProperty→`ts_objproto_hasOwnProperty(a,n)`、valueOf→`ts_objproto_valueOf(a,n)`＝既存 (args,n) wrapper 委譲）。
    検証 vs V8 全一致（hasOwnProperty.call/apply/bind、toString 値の spec タグ全型、valueOf identity、typeof、class instance の hasOwn、
    HOF 渡し、回帰: §81 直接形・`o.toString()`/`o.hasOwnProperty()`/`o.valueOf()` 直接・Object.keys 値（Math.sqrt 系 LoadBuiltinFn））。
    全 CI 緑（**conf 169/169 = +1, ci_par 全 PASS（perf 全 budget 内＝exporter/emit_c のみ, AC 電源）, unit 全 PASS**）。conformance:
    object_methods/proto_method_values.ts。**スコープ外（reject 維持・follow-up）**: 他 builtin の proto メソッド値
    （`Array.prototype.slice.call(...)`/`String.prototype.x` 等＝"Array.prototype as a first-class value" 同類）。rejects_syntax.sh に 1 件追加。

## セッション 90（他 builtin の proto メソッド値: Array/String/Map/Set/Number.prototype.<m> 一級値化）

129. **`Array/String/Map/Set/Number.prototype.<method>` を一級関数値化**（§89=#128 の Object.prototype に続く follow-up「他 builtin の
    proto メソッド値」）。`Array.prototype.slice.call([1,2,3],1)`→[2,3]、`const m=Array.prototype.map; typeof m`→"function"、
    `String.prototype.toUpperCase.call("hi")`→"HI"、`Map.prototype.get.call(m,k)`、`Number.prototype.toFixed.call(3.14,2)`、`.apply`/`.bind`
    が全て動く。**runtime 無改変・解析パス無改変**（exporter + emit_c のみ）。
    - **鍵**: runtime の各 proto メソッドは既に boxed ts_func・takes_this=1 で proto オブジェクト（`g_array_proto` 等、固定 spec 全件登録）に
      `TS_KEY_METHOD` で在る。`LoadMethodValue{recv,method}`=`ts_get(recv,TS_KEY_METHOD)` は recv が proto オブジェクト自身でも own を発見＝
      インスタンス値形（§61）と同じ boxed メソッド。よって **recv を proto に差し替えるだけ**（ゲートも同じ `builtinMethodName2` 流用＝被覆同一）。
    - **修正**: (1) exporter `builtinProtoMethod(e)`（`<NS>.prototype.<m>` 照合、`objectProtoMethodName` の一般化版）+ PropertyAccess 値ロワリングで
      `node.expression`(=Array.prototype、reject 元)を lower する**前**に `LoadBuiltinFn{builtin:"protoobj."+kind}`(=proto オブジェクト)→
      `LoadMethodValue{recv,method}` を emit。(2) emit_c の LoadBuiltinFn codegen に `protoobj.*` 早期 return（`ts_array_proto()`/
      `ts_string_proto()`/`ts_map_proto()`/**`ts_set_proto_obj()`**/`ts_number_proto()`、adapter は fnval_adapter_body=None で非生成）。
    - **検証で判明した必須の追加修正**: `Array.prototype.slice.call(...)` の callee receiver `Array.prototype.slice` は型が `(...)=>any[]` で
      **`builtinReceiverKind` が末尾 `[]` を見て "array" と誤判定** → 呼び出し経路（exporter.ts:2167）で `builtinMethodName2("array","call")`=undefined
      になり reject していた（slice/map/reverse/fill/sort/flat/flatMap/copyWithin と、proto メソッドを変数に束ねた `const f=...; f.call()` 全般）。
      **根治**: `builtinReceiverKind` 冒頭で **callable な型（call signature を持つ値）は receiver kind を返さない**（`t.getCallSignatures().length>0`→undefined）。
      関数値は string/array/map/set/number メソッドの receiver になり得ないので安全。これで直接形も変数形も汎用 Method dispatch に落ち
      `.call`/`.apply`/`.bind` を g_function_proto 経由で動的ディスパッチ。
    全 CI 緑（**conf 170/170 = +1, ci_par 全 PASS（perf 全 budget 内＝exporter/emit_c のみ・AC 電源）, unit 全 PASS**）。conformance:
    object_methods/builtin_proto_method_values.ts。**スコープ外（reject 維持・follow-up）**: Function.prototype.{call,apply,bind}（function 種未収録・
    exotic）、素 `Array.prototype`、未収録メソッド（toSorted 等）。rejects_syntax.sh の旧「Array.prototype.slice 値=reject」は pass に転じたので
    上記 3 reject に差し替え。**既知 DIFF（宣伝せず）**: 外来 array-like receiver（`Array.prototype.slice.call("str")`）は runtime の
    `as_arr→null→空配列` 方針で `[]`（V8 相違・安全な miscompile・既存の array-like 非対応と同類、no-crash 確認済）。

129b. **#129 追補: `Function.prototype.{call,apply,bind}` も一級関数値化**（§90 スコープ外3件のうちユーザが #1 のみ選択して実装）。
    `const c=Function.prototype.call; typeof c`→"function"、`c.call(f, thisArg, ...args)`（method-borrow / uncurry-this。
    `Function.prototype.call.call(f,null,2,3)`→5 も）動く。**runtime 無改変・解析パス無改変**＝#129 の `protoobj.<kind>`/LoadMethodValue
    機構そのまま。**修正は2行**: (1) exporter `builtinProtoMethod` の kind union に `"function"` 追加＋Function 分岐
    （builtinMethodName2 に function 種が無いので literal set `{call,apply,bind}` で gate）。(2) emit_c の `protoobj.*` match に
    `"function" => "ts_function_proto"`。functionProtoSpec（call/apply/bind=ts_funcproto_* takes_this=1）と `ts_function_proto()` は既存。
    全 CI 緑（conf 170/170 維持＝既存 builtin_proto_method_values.ts に節追記）。**残（reject 維持・据え置き）**: 素 `Array.prototype`（#2・
    低価値+差異リスク）、未収録メソッド `toSorted` 等（#3・メソッド本体未実装＝別途）、Function.prototype の {call,apply,bind} 以外（toString 等）。
    rejects_syntax.sh は「Function.prototype.call 値=reject」を「Function.prototype.toString 値=reject（未収録 function メソッド）」に差替。

## セッション 91（class-as-value を全クラス ts_func 化 → 非静的 RHS instanceof）

130. **class-as-value を全クラス種で proper な `ts_func` 値に統一し、`x instanceof ctorVar`（非静的 RHS = ランタイム constructor 値）を実装**。
    従来 class-as-value は**明示 ctor クラスでしか正しく動かず**（no-ctor+statics→container オブジェクト＝`typeof`"object"誤、空/field-only→
    `undefined`＝既存バグ）、そのため非静的 instanceof を素で入れると field/空クラス RHS で **silent DIFF**（reject→誤 false）になっていた。
    - **(A) class-as-value 修正（exporter）**: no-ctor クラスに**合成コンストラクタ** `synthClassValueCtor(classId)` を生成（`lowerStaticInit` を雛形に
      AST ノード無しの FnCtx を組み、`this`=args[0]、body=`emitImplicitConstruction`＝field 初期化+親連鎖を再利用、id は `allocSpecFn()`）。
      class-as-value ロワリングの no-ctor フォールバック（exporter.ts:3083）を、合成 ctor での `AllocClassValue`＋container への SetProto＋
      `instantiated=true` に差し替え。これで empty/field/method/statics/ctor 全クラスの `const K=C` が `ts_func`（`typeof`"function"、`class_id`付き）。
      `methodFunc` には登録しない＝static `new`/`super`/`emitImplicitConstruction` は無改変（回帰最小）。fn-local を capture する field init のクラスは
      合成不可で従来動作（reject 維持）。
    - **(B) 非静的 instanceof（exporter+emit_c+runtime）**: reject（exporter.ts:2499）を dyn パスに差替＝RHS 型に construct signature がある
      （union 対応）時のみ `instanceof.dyn` を emit（`any` 型 RHS は silent-DIFF 回避で reject 継続）。emit_c に `instanceof.dyn` arm。runtime
      `ts_instanceof_dyn(obj,ctorv)`＝`C[Symbol.hasInstance]`→無ければ `class_id`→`g_class_proto_tab[cid]` で proto 鎖照合（既存 `ts_instanceof`/
      `ts_get`/WKSYM 再利用）。全クラスが class_id 付き ts_func になったので全クラス種で正しく動く。
    - **(C) class-value func を coercion/iteration で object 扱い（runtime）**: class 値を ts_func 化したことで、ToPrimitive/反復が `ts_is_obj` ガードで
      class 値を弾き static `[Symbol.toPrimitive]`/`[Symbol.iterator]` の coercion/spread が壊れた（static_symbol_members/method 回帰）。
      `ts_is_class_value(v)`（`ts_func`かつ`class_id!=0`）を追加し、`ts_to_primitive`/`ts_to_string_v`/`ts_add`/`ts_relational`/`ts_loose_eq`/
      `ts_number_coerce`/`ts_array_push_all`/`ts_array_from` の各 `ts_is_obj` ゲートに OR で混ぜた（**普通の関数 class_id==0 は不変**＝無回帰。
      class 値の proto 鎖は必ず Object.prototype.toString に届くので ToPrimitive は必ず primitive を返し無限再帰しない）。
    検証 vs V8 全一致（typeof empty/field/method/statics/ctor=function、instanceof dyn 全種＋union＋subclass＋dyn `Symbol.hasInstance`＋primitive LHS、
    static via no-ctor 値、coercion via static toPrimitive、回帰: 普通関数 coercion・class_value_new・static_*・symbol_hasinstance）。
    全 CI 緑（**conf 172/172 = +2, ci_par 全 PASS perf budget 内, unit 全 PASS**）。conformance: classes/class_value_typeof.ts, classes/instanceof_dynamic_rhs.ts。
    **残（reject 維持・スコープ外）**: ① `any` 型 RHS の instanceof、② fn-local capture する no-ctor クラスの値化、③ polymorphic no-ctor の動的 `new`。
    **既知 DIFF（既存・別件）**: `==`/`<` の ToPrimitive が "default" でなく "number" hint（`ts_loose_eq`/`ts_relational`＝[Symbol.toPrimitive]
    が number/default を区別する稀ケースのみ顕在化。本変更前から同挙動＝無回帰）。rejects_syntax.sh に `any` 型 RHS instanceof reject を追加。

## セッション 92（polymorphic class value の動的 new）

131. **polymorphic class value の動的 `new` を実装**（§91 で全クラスが ts_func 値になった土台の上）。`const K = cond ? A : B; new K()` と
    `new (cond ? A : B)()` が動く（従来 exporter.ts:1168/1200 で loud-reject）。**exporter のみ**（NewDynamic/ts_construct/synth ctor は §91 既存）。
    - **鍵となる発見**: poly `new` の安全性は「TS が結果型を union のまま推論するか単一型に潰すか」で決まる。**構造が異なる**クラス（`Dog{bark}`/
      `Bird{fly}`）や**共通基底のサブクラス**（`P extends Base`/`Q extends Base`）→ 結果型は union `A|B`（symbol 無し）→ `classOfExpr`=undefined →
      field/method が**動的ディスパッチ**（`ts_get` の class フィールド記述表で typed-struct を offset 読み、method は proto 鎖）＝**健全**。
      一方**構造が同一**のクラス（`A{x}`/`B{x}`）は TS が単一型に**潰す**ため devirt 先が実値と食い違い得る→**従来どおり reject 維持（健全）**。
    - **修正**: `lowerPolymorphicNew(ctx,node,hint)` を追加し、new-expression の**識別子ゲート（exporter.ts:1010）より前**で呼ぶ
      （識別子 callee `new K()` も非識別子 callee `new (cond?A:B)()` も拾う）。結果型が「既知クラスの union」なら、各メンバが構築可能
      （明示 ctor or fn-local を capture しない no-ctor＝§91 合成可）かつ「引数なし or 全メンバ明示 ctor」のとき `lowerExpr(callee)`→
      `NewDynamic{callee,args}` を emit。`ts_construct` が**ランタイム値の class_id**で正しいインスタンス確保＋ctor 呼び。`polyClassValue` 旧分岐は
      この helper 経由に統一。
    検証 vs V8 全一致（distinct-shape field/method override、共通基底サブクラスの override 動的ディスパッチ、`new (cond?A:B)()` 直接形、
    結果への instanceof、全明示 ctor で引数フォワード）。全 CI 緑（**conf 173/173 = +1, ci_par 全 PASS perf budget 内, unit**）。conformance:
    classes/new_polymorphic_class_value.ts。**残（reject 維持・健全）**: ① 引数あり poly `new` で no-ctor メンバ含む（§91 合成 ctor は引数を親へ
    フォワード不可）、② fn-local capture する no-ctor メンバ、③ 構造同一クラスの union（TS が単一型に潰し devirt 不健全）。rejects_syntax.sh に
    「引数あり poly new + no-ctor メンバ」reject を追加。

## セッション 93（class-as-value 整理リファクタ — 振る舞い不変・conf 増減なし）

132. **承認済リファクタ「class-as-value の整理」**（#89–#92 で積み上がった ad-hoc 化を構造整理。**新規バグ修正ではない**＝
    成功条件は **conf 173/173 維持**＝振る舞い不変。安全網は既存スイート: conf + rejects + golden + perf + unit）。
    - **① runtime（runtime/ts_rt.c）**: coercion/反復の 8 関数 10 ゲートに手で OR されていた `(ts_is_obj || ts_is_class_value)` を
      単一述語 `ts_object_like(v)`（:246）に集約し**機械置換**（純粋同値）。対象: `ts_to_primitive`/`ts_to_string_v`/`ts_add`/`ts_relational`/
      `ts_loose_eq`/`ts_number_coerce`/`ts_array_push_all`/`ts_array_from`。`ts_is_class_value` は `ts_object_like` 内と instanceof
      （`ts_instanceof_dyn`）のみに縮小＝「class value は object 的か」の判断を **1 箇所**に集約し、将来の coercion 経路追加でゲート漏れ
      （silent DIFF）を起こしにくくする。
    - **② exporter（exporter/exporter.ts）**: ~24 分岐の `new` ロワリングを **classify→dispatch** に再構成（各旧分岐と 1:1）:
      - `lowerNewBuiltin(ctx,node,ctorName,hint)`: Map/Set/Array/Date/Error 系/Promise（builtin 固有 reject も内包）。非 builtin は undefined。
      - `resolveNewTarget(node): NewTarget`: 分類のみ（IR 非 emit）。**副作用を旧順序で実施** — name-collision fallback、結果型クラス値解決
        （Phase B）、generic 特化（`specializedClassId`/`resolveSpecializedParent`）、RTA `recordInstantiationFieldTypes`。返り値は
        `valueDynamic`（明示 ctor の monomorphic 値→NewDynamic）/`staticClass`（classId or no-ctor 値、undefined=非クラス reject）/`reject`。
      - `lowerNewStaticClass(ctx,node,classId,hint)`: AllocObject + 明示 ctor（`ConstructResult` 含む）/ implicit 構築 / 非クラス loud-reject。
      - `NewTarget` 型を追加。poly union は従来どおり `lowerPolymorphicNew` pre-pass が処理（識別子ゲート内の旧 `polyClassValue` 防御分岐は
        **到達不能**と確認し reject アームに集約）。
    - **③（深い表現変更）は対象外**: `ts_func`+`class_id` タグを捨て「普通関数も object 扱い」へ完全統一するのは JS 的には正しいが
      `String(fn)`/`+fn`/`[...fn]` の挙動を変える（反復は crash リスク）ため高リスク・低利益＝**今回は触らず**コメントに将来検討と明記。
    - **教訓**: `unsupported()` は throw せず list に積むだけ＝reject アームは `unsupported()` の後に `return newLocal()` の形を保つ必要がある。
    検証: conf 173/173・basic 3/3・rejects_syntax 35/35・unsupported_stdlib PASS・**new 全経路 16 dt probe が V8 一致**（builtin seeded/Date/Error/
    Promise/Array・static ctor/implicit/ctorReturns/super・class-value explicit→NewDynamic/no-ctor→static・generic `Box<number>`・poly union・
    unknown-id→REJECT）・**ci_par 全緑**（perf 全 budget AC・unit）。**conf 数は不変**（リファクタ＝既存スイートが characterization）。

## セッション 94（配列: ES2023 change-by-copy 4 メソッド + 素の Array.prototype 値）

133. **ES2023 の change-array-by-copy 4 メソッド（`toSorted`/`toReversed`/`with`/`toSpliced`）と素の `Array.prototype` 値**を実装。
    残候補「素の Array.prototype 値 + 未収録メソッド（toSorted 等）」が**2 つの別物**だったのを両方解決（ユーザ確定: 両方・V8 厳密一致）。
    - **パート A（change-by-copy 4 メソッド）**: いずれも「**コピーを作ってから in-place 版を適用**」＝新配列を返し receiver 不変。
      - runtime（ts_rt.c）: `array_clone`（GC root 付きクローン helper）+ `ts_array_tosorted`（clone→`ts_array_sort`）/`ts_array_toreversed`
        （clone→`ts_array_reverse`）/`ts_array_with`（負 index 対応、範囲外は **`ts_throw_range_error` で RangeError throw**＝name/message
        付きオブジェクト）/`ts_array_tospliced`（splice の新バッファ構築を非破壊で）。ts_rt.h に 4 宣言。**GC 安全性（実装中に発見・修正）**:
        `array_clone` が `ts_new_array`→`gc_alloc` で**コレクションを起こし得る**ため、その間 live な heap 引数を root する必要がある＝
        `ts_array_with` は `val` を、`ts_array_tosorted` は comparator `cb` を clone の前後で `ts_gc_root`/`unroot`（`ts_array_concat` の y
        rooting と同型）。GC-stress probe（5000 回確保で強制コレクション）で val/cb/要素オブジェクトの生存を確認。
      - emit_c（emit_c.rs）: array arm 群に `array.toSorted`/`toReversed`/`with`/`toSpliced`/`toSplicedEnd`。**`toSpliced` の 1 引数形（delete-to-end）
        は splice 同様 `toSplicedEnd`（has_dc=0）に分岐**＝ビルド前に has_dc バグを発見し回避。
      - exporter（exporter.ts）: `builtinMethodName2` の array Set に 4 語追加。`toSpliced` は可変長 items のため splice 同型の分岐
        （items を AllocArray+ArrayPush、1 引数は toSplicedEnd）。**`builtinReceiverKind` の構造的チェーン検出**（4102 の arrayReturning.array）に
        4 語追加＝**ES2020 lib だと `.toSorted()` 戻り型が `any` 化しチェーン `.toReversed()` が any-dispatch で落ちる**問題を解消（既存
        `m.keys().join()` 救済と同型）。
    - **パート B（素の `Array.prototype` 値）**: `const p = Array.prototype` を値化（§90 はメソッド値のみ）。
      - runtime（ts_rt.c 1 行）: `ts_array_proto_init` の proto を `ts_new_proto()`（OBJECT）→**`ts_new_array(0)`（ARRAY）**化。
        `ts_array` は `ts_obj_common` 先頭埋め込みで `(ts_object*)` キャストが header にエイリアス安全（ts_rt.c:317 の不変条件）＝proto 鎖 walk・
        register・GC 全て kind 非依存。これで **`Array.isArray(Array.prototype)=true`（V8 一致）**・typeof="object"。String/Map/Set/Number
        proto は OBJECT のまま（V8 でも isArray=false）。
      - exporter（exporter.ts）: `bareBuiltinProtoKind(e)` helper（`<NS>.prototype` で NS=Array/String/Map/Set/Number、**Function 除外**
        ＝typeof "function" で別表現）+ PropertyAccess 値ロワリングで `builtinProtoMethod` チェック直後に素 proto を `LoadBuiltinFn{protoobj.<kind>}`
        として emit（§90 の早期 return が proto オブジェクトを返す＝emit_c 無改変、LoadMethodValue を付けないだけ）。
    - **rejects_syntax.sh**: 「bare Array.prototype」「Array.prototype.toSorted as value」を**削除**（now-supported）、代わりに「bare
      Function.prototype」reject を追加（typeof "function" でスコープ外）。
    - **教訓**: dt probe は `bash` プロセスで（zsh は difftest.sh の `[ == ]` 非対応）。新メソッドの戻り型がチェーンで `any` 化する問題は
      `builtinReceiverKind` の構造検出に追加で解決（lib バージョンに非依存）。
    検証: **新メソッド/素 proto の 27 dt probe が V8 一致**（toSorted default/cmp/str・toReversed・with pos/neg/idx0・toSpliced 1arg/2arg/insert/neg・
    with RangeError pos/neg・in-place 回帰 sort/reverse/splice・typeof/isArray/length/spread/identity・§90 メソッド値・通常配列回帰）。新 conformance:
    arrays/change_by_copy.ts, errors/array_with_range.ts, arrays/bare_prototype.ts（**conf 173→176**）。**ci_par 全緑**（perf 全 budget AC＝
    proto kind 変更でも配列 hot path 回帰なし・unit）。**スコープ外（reject 維持）**: 素 Function.prototype、未収録メソッド（group 等）、regex/BigInt。
    **既知差（conformance 非収録・無害）**: `console.log(Array.prototype)` は当方 `[]` / Node `Object(0) []`（proto 限定の表示差）。

## セッション 95（素の Function.prototype 値 — callable no-op 関数）

134. **素の `Function.prototype` を値化**（§94 の残＝proto 値の最後）。`Array.prototype` を ARRAY 化したのと**対称**に、`g_function_proto` を
    **実際の callable な `ts_func`（no-op・arity 0・name ""）** にする＝`typeof Function.prototype`="function"、`Function.prototype()`→undefined、
    `.length`=0、`.name`=""、identity 安定（全て V8 一致）。
    - runtime（ts_rt.c）: (1) no-op stub `ts_noop_fn(args,n){return TS_UNDEFINED;}`。(2) `g_function_proto` を `ts_object*`→**`ts_func*`** +
      GC-root holder `g_function_proto_v`（g_promise_proto_v 同型・**明示 root**＝関数ゼロでも生存）。(3) `ts_function_proto_init` を
      `ts_make_fn_t(ts_noop_fn,NULL,0,0)`→`ts_gc_root`→`g_function_proto->o.proto=g_object_proto`（**ブートストラップ循環**: ts_make_fn 内
      `f->o.proto=g_function_proto`(=NULL) を直後に Object.prototype で上書き＝JS の `Function.prototype.__proto__===Object.prototype`）。順序
      保証は emit_c の `ts_setup_object_proto()`→`ts_setup_function_proto()`（無条件 emit）。(4) **最重要＝box セレクタ**: `ts_function_proto()`
      アクセサと register を `ts_obj()`（OBJECT セレクタ 0xFFF8）→**`ts_func_v()`（FUNC セレクタ 0xFFFA）**に（さもないと typeof が "object" に
      化け、ts_get の func 分岐を通らない）。(5) `ts_make_fn` の `f->o.proto = (ts_object*)g_function_proto`（func は ts_obj_common 先頭埋め込みで
      cast 安全）。
    - exporter（ts）: `bareBuiltinProtoKind` に `["Function","function"]` 追加（戻り型に "function"）＝§94 の素 proto 経路をそのまま流用。
      **emit_c 無改変**（`protoobj.function`→`ts_function_proto()` は §90 #129b 既存）。
    - rejects_syntax.sh: 「bare Function.prototype」reject を削除（now-supported）。
    - 検証: **19 dt probe + 3 GC-stress probe が V8 一致**（typeof/no-op 呼び/length/name/identity・§90 call/apply/bind 値化回帰・**通常関数の全
      機能回帰** typeof/length/name/call/bind/apply/closure/class メソッド/HOF・GC-stress で関数 1 万生成下の proto 生存）。新 conformance:
      closures/function_prototype_value.ts（**conf 176→177**）。**ci_par 全緑**（perf 全 budget AC＝g_function_proto は全関数の proto＝ホットだが
      関数呼び hot path 回帰なし・unit）。
    - **発見した pre-existing 広域ギャップ（本タスク非導入・スコープ外）**: `o.toString`/`o.hasOwnProperty`/`o.valueOf` を**値として**読むと
      undefined（**任意のオブジェクト**で＝`({}).toString` も同様。CALL 形 `o.toString()` は正常）。Object.prototype メソッドが name キーでなく
      **method キー**で proto に登録されているため値読みが外す。§94 の `Array.prototype.hasOwnProperty` 値も同じ DIFF を既に内包（非収録）。
      Function.prototype 値化で `Function.prototype.toString` 値が reject→undefined になったが、これは**この広域ギャップの 1 インスタンス**で
      新種のバグではない（値読み専用・非 crash）。完全修正は「Object.prototype メソッドのインスタンス値化」＝別の大きな機能で後日。
    - **スコープ外（reject/DIFF 維持）**: 上記 inherited メソッド値ギャップ、`new Function.prototype()`、console.log/String の表示差（当方
      `[Function]`/Node `[Function (anonymous)] Object`）、`Object.getPrototypeOf(fn)`（func 引数で null を返す別の pre-existing gap）、regex/BigInt。

## セッション 96（Object.prototype メソッドのインスタンス値化）

135. **`o.toString` / `o.valueOf` / `o.hasOwnProperty` を**値として**読むと undefined**（§95 で発見の広域 silent DIFF。**任意の
    オブジェクト**で。CALL 形 `o.toString()` は正常）を修正。Node は関数値（`typeof o.toString`="function"、`o.hasOwnProperty.call(o,k)` 等が動く）。
    - **根本原因（キー名前空間ミスマッチ）**: Object.prototype メソッドは OBJECT_PROTO に **METHOD キー**`TS_KEY_METHOD(id)`（`[1M,∞)`）で
      登録。だが `o.toString` 値読みは generic fallback で `LoadField{field: internField}`＝**FIELD キー**（`[0,1M)`）に lower → 別名前空間で
      proto メソッドを miss → undefined。CALL が動くのは `emit_method_value_lookup` が own field キー → 無ければ METHOD キーで walk するから。
    - **修正（runtime helper + emit_c arm + exporter 1 分岐、新 IR なし）**: (1) runtime `ts_get_method_value(recv, field_key, method_key)`
      ＝own/継承データ（field キーで proto 鎖）が**存在すれば**（型不問・undefined 含む＝JS own shadow 厳密）それを返し、無ければ
      `ts_get(recv, METHOD キー)` で Object.prototype メソッドへ。(2) emit_c の早期 starts_with ブロックに `object.methodValue:<field>:<method>`
      arm（`symbol.wksym:` 同型）。(3) exporter の PropertyAccess 値ロワリング、vrk 経路の直後に分岐（name∈{toString,valueOf,hasOwnProperty}
      かつ非 primitive → `CallBuiltinStatic{object.methodValue:fid:mid}`）。own shadow は helper が厳密処理＝コンパイル時に own 有無不要。
    - **⚠ 実装中に発見・修正した pre-existing ブートストラップバグ（重要）**: `o.hasOwnProperty.call(o,k)` が初め crash（"method id 1 not a
      function"）。原因は **`ts_setup_object_proto()` が `ts_setup_function_proto()` より前に走る**ため、Object.prototype メソッドを
      `ts_make_fn_t` で box する時点で `g_function_proto`=NULL → boxed メソッドの `o.proto`=NULL → `.call`/`.apply`/`.bind` が
      Function.prototype.call を解決できない（§95 で g_function_proto を ts_func 化したが setup 順序は別問題＝**§95 以前から潜在**、ただし
      誰も objproto メソッドを値で読まなかったので不顕在）。**修正**: emit_c の `ts_setup_object_proto` を「OBJECT_PROTO 作成→install
      （g_object_proto 設定）→`ts_function_proto_init()`→**その後**メソッド box」に並べ替え（function_proto は Object.prototype に chain する
      ので install が先。後続の ts_setup_function_proto は init guard で冪等）。`arr.map.call` が動いていたのは array proto setup が
      function proto の**後**だったため（偶然）。
    - 検証: 13 dt probe + GC-stress が V8 一致（inherited 値化 typeof/.call/.bind/detached・配列/class インスタンス/any 受信・callback 渡し・
      **own shadow 回帰** own method/`{toString:42}`/`{hasOwnProperty:"s"}`・String(o)/`${o}`/+coercion 不変・§65/§89/§90 回帰・CALL 形回帰）。
      新 conformance: object_methods/proto_method_instance_values.ts（**conf 177→178**）。**ci_par 全緑**（proto setup 並べ替えは全 177 conf
      緑で無回帰確認・perf 全 budget AC・unit）。§95 で記録の残候補 #5 を解消。
    - **スコープ外（DIFF 維持）**: `arr.hasOwnProperty("0")`/`("length")`＝配列 index/length を own 扱いしない別の pre-existing gap（`ts_objproto_
      hasOwnProperty` の本体・CALL 形も同 DIFF＝本タスク無関係）、toLocaleString/isPrototypeOf/propertyIsEnumerable（OBJECT_PROTO 未登録）、regex/BigInt。

## セッション 97（hasOwnProperty / `in` の exotic own プロパティ）

136. **`hasOwnProperty`/`Object.hasOwn`/`in` が exotic own プロパティを正しく報告しない**（§96 でスコープ外にした残）を修正＝
    **配列の index/length・文字列の index/length・関数の length/name** を own 扱いせず常に false だった（CALL 形・値形とも同 DIFF）。
    加えて `in` 演算子が**非 canonical な index 文字列**（`"00"`/`"01"` 等）を配列の present property と誤判定する同根バグも一括修正。
    **runtime のみ（exporter/emit_c 無改変）**。
    - **根因（キー名前空間・メタ非走査）**: `ts_objproto_hasOwnProperty`→`ts_has_own_dyn`→`ts_has_own`（ts_rt.c:3456）は `class_has_field`+
      `find_slot`（prop map）のみ＝**配列要素ストレージ/文字列バイト/関数メタを見ず**、さらに `if(!ts_is_obj) return 0` で**文字列・関数
      receiver を弾く**。`ts_has_prop`（`in`、3219）の配列 index 判定は `strtol`＝`"00"`→0 で誤 true（canonical 検査なし）。
    - **修正（runtime 3 点）**: (1) 共有ヘルパ `ts_canonical_array_index(s,len)`＝canonical 配列 index 判定（先頭ゼロ拒否・全桁数字・
      `>=2³²-1` 拒否、`"00"`/`"01"`/`"-0"`/`"1e0"` を弾く）。(2) `ts_has_own` を種別分岐に拡張＝string（canonical index/length）・func
      （length/name＝常在、call/apply/bind は inherited で非 own）・array（canonical index/length）を追加（`ts_has_own_dyn` は receiver を
      そのまま渡すので無改変）。(3) `ts_has_prop`（`in`）の配列判定を canonical ヘルパに置換＋**関数 receiver 対応**（`!ts_is_obj` 早期
      return を func 分岐の前に移動し、own length/name + `is_function_proto_name`（call/apply/bind）+ proto 鎖 walk で Object.prototype の
      `is_object_proto_name`（toString/valueOf/hasOwnProperty）も拾う）。
    - **実装中の追加修正**: `"call" in fn` が初め false（METHOD キー登録の call/apply/bind を FIELD キー walk が外す＝§96 と同型の
      METHOD/FIELD ミスマッチ）→ `is_function_proto_name`（FIELD キー名で call/apply/bind 判定、`is_object_proto_name` と同型）を追加し func
      分岐で照合。`"toString" in fn` 等の inherited は既存 `is_object_proto_name` で proto walk が拾う。
    - 検証: 約 20 dt probe が V8 一致（配列 idx/len/非 canonical/2³²-1/数値キー/own set・文字列 idx/len・関数 length/name/call/anon/arrow・
      `in` 配列 canonical・`in fn` の call/apply/bind/inherited/own-set・**回帰** object 通常 hasOwn/`in obj`/`Object.keys(arr)`=index のみ/
      for-in/§96 値化）。新 conformance: object_methods/has_own_exotic.ts（**conf 178→179**）。**ci_par 全緑**（ts_has_own/ts_has_prop は
      `in`/for-in の hot path 可能性ありだが canonical ヘルパは軽量手書きループ＝perf 全 budget AC・全 178 conf 緑で無回帰）。§96 残の
      「配列 index/length gap」を解消。
    - **スコープ外（DIFF/未対応 維持）**: 関数の own `prototype`（`f.prototype`=undefined＝未モデル化、別 gap）、`"x" in fn` の constructor
      （未モデル化）、`Object.getOwnPropertyDescriptor(arr,"0")`（descriptor 構築は別経路）、toLocaleString 等（OBJECT_PROTO 未登録）、regex/BigInt。

## セッション 98（gen/async の symbol/動的キーメソッドを feature 化）

137. **user-symbol キー（`*[mySym]()`）/動的文字列キー（`*[k]()`）の generator・async・async-generator メソッドの loud-reject を解消**
    （残候補①、§79=#118 で symbol/動的キーの**通常**メソッド・フィールド・アクセサを feature 化した際に「状態機械を data-property
    closure に install 不可」として残していた reject）。instance + static の両方。**exporter のみ（analyzer/runtime/IR 無改変）**。
    - **メモリの「install 不可」は誤りだった（探索で確定）**: `AllocClosure { captures: [] }` は `ts_make_fn_t(fname, 0, 0, tt)` を emit し、
      これは **動作実証済みの vtable generator 登録（`ts_set(CLASS_PROTO[..], key, ts_make_fn_t(fname,0,0,tt))`、golden test
      `tests/golden/iter/gen_symbol_iterator.ts` が `this.a`/`this.b` capture 込みで実証）とバイト等価**。generator/async の entry point
      （emit_c.rs `emit_generator_function`/`emit_async_function`/`emit_asyncgen_function`）は `(tsv* args,int nargs)` の素の C 関数で、内部で
      `ts_gen_new(...)` / promise を返すだけ＝`ts_call`/`ts_call_method` は一様に呼べる（「generator 性」は entry point 内に閉じている）。
      runtime ABI（`ts_call` が closure env を prepend し `[cells…, this, realargs…]` を作る）は exporter の param 並び
      （`emitCells(); emitThis()`）と一致 → captures も this も正しく frame フィールドに入る。
    - **スコープの訂正**: `*[Symbol.iterator]()`（well-known symbol）は `isDynComputedMember` から除外され vtable 経路で**既に動く**ため
      対象外。真の gap は **user-symbol キー（型 `symbol`/`unique symbol`）と動的文字列キー**の gen/async メソッドのみ（旧 reject は
      `tests/rejects_symbol.sh:43-45` の 3 ケース）。
    - **修正（exporter 4 箇所）**: (1) `isDynComputedInstallMethod`＝gen/async を弾く 2 行（`asteriskToken`/`AsyncKeyword`）を削除
      → instance gen/async dyn/symbol メソッドが fnId 付与（assignIds walk）・nested-capture rollup・cellBindings walk の 3 経路に乗る
      （この helper はこの 3 箇所のみで使用＝削除で必要十分）。(2) `installDynamicMember`＝gen/async reject ブロックを削除し
      `lowerClosure(ctx, m, "dynmember", true, classId)` 経路へ（accessor reject は温存＝アクセサは構文上 generator になれない）。
      (3) `setupClasses` 静的経路＝`isDynComputedGenAsyncMethod` gate を削除し method-lift 分岐（fnId + `methodDecls.push({…,thisName:""})`
      staticThis）へ落とす（`lowerStaticInit` は gen/async 非依存で `AllocClosure`+`symbol.set`/`StoreFieldDynamic` を emit）。
      (4) dead helper `isDynComputedGenAsyncMethod` 削除 + 関連 doc コメント訂正。`lowerFunctionLike` は呼び出し経路非依存で
      `isGenerator`/`isAsync`（`node.asteriskToken`/async modifier）を検出＝install 経路でも body は状態機械として lower される。Step F/F'
      の module-cell publish は `isDynComputedMember`（gen/async 非依存）で body を走査済＝module-const capture も無改変でカバー。
    - **検証**: 実証スパイク（this capture 込み instance generator [mySym]）が V8 一致でメモリの主張を直接 refute。clean probe matrix
      が全 OK＝{instance, static} × {generator, async, async-generator} × {user-symbol(unique), dyn-string}・this capture（inst/static）・
      bidirectional `.next(v)`・await body・複数 symbol generator + fresh-each-call・no-ctor 即時 install・explicit-ctor の function-local
      capture（2 値 + this 混在）。**回帰**: well-known `*[Symbol.iterator]()`（vtable）・§79 plain symbol/dyn メソッド/field/accessor・
      static [Symbol.toPrimitive]/[Symbol.hasInstance]。新 conformance: classes/dynkey_generator_method.ts, symbol/symbol_gen_async_method.ts
      （**conf 179→181**）。**ci_par 全緑**（exporter の reject 削除のみ＝hot path/codegen 不変・perf 全 budget AC・unit）。
    - **既存ギャップ（本タスク非導入・無関係）**: `(c as any)[s]()` の **`any`-typed generator 消費**（for-of/`.next()`）は pre-existing の
      silent DIFF/loud TypeError（通常の named generator method を `as any` 経由で消費しても同様＝候補③「any 型ジェネレータ .next()」）。
      spread `[...]` は `any` でも動く。本機能のテストは `unique symbol` 型付け（typed 消費）or spread で回避。
    - **スコープ外（reject 維持）**: nested await 等の既存 async 制限（本変更で広げない）、動的キーアクセサの defensive reject（§79 で
      pre-pass 処理されるため通常到達しない）、regex/BigInt。

## セッション 99（poly-new 残ケース②③: fn-local capture no-ctor の class value 化 + 構造同一 union の動的 new）

138. **fn-local capture する no-ctor クラスの class value 化**（§92=#131 poly-new 残ケース②）。`const K = cond ? A : B; new K()` /
    `const K = A; new K()` で、no-ctor メンバのフィールド初期化子が**外側関数のローカルを capture**するケース（従来 reject）。**exporter のみ**
    （runtime/IR/emit_c 無改変）。
    - **鍵**: runtime/IR は既に capture を完備（`AllocClassValue{captures}`→`ts_make_class_value`→env を `ts_call` が prepend）。**明示 ctor の
      fn-local capture class value は既に動作**（`classValueCaptures`→AllocClassValue）。残ケース②は同じ配線を **no-ctor 合成 ctor
      `synthClassValueCtor`** にも適用するだけだった（合成 ctor は AST 無しの FnCtx で cellAccess が空だったのが唯一の壁）。
    - **修正（exporter）**: (1) `synthCtorFreeVars(classId)` 新規＝no-ctor チェーン（emitImplicitConstruction が再帰する範囲、explicit-ctor 親で
      停止）の field-init/dyn-key の fn-local capture を `bindingId` 順に収集（`freeVars` の ctor field-init scan を class ノード起点に拡張、
      module-scope は GLOBALS 経由で除外）。(2) `synthClassValueCtor` 改修＝`classCapturesFunctionLocal` reject を撤廃し、`frees` を **this の前**に
      cell params として積み `cellAccess` に登録（`emitCells` と同順）。(3) `synthClassValueCaptures(ctx,classId)` 新規＝値化サイトで同じ frees を
      `cellAccess` から解決（cross-scope は null→従来のコンテナ fallback）。(4) 値化サイト（lowerExpr 識別子）で captures を解決し
      `AllocClassValue{...captures}` を emit。(5) cellBindings prepass に no-ctor クラスの `synthCtorFreeVars` を追加（no-ctor は methodDecls に
      無いので明示 ctor の loop で拾えない＝この登録が無いと cell 未確保で誤 reject）。(6) gate 緩和: `lowerPolymorphicNew`/静的経路 3743 の
      `classCapturesFunctionLocal` reject を撤廃（3743 は no-ctor capturing を **valueDynamic**＝class value 経由 NewDynamic へ＝captures は値化
      サイトで解決済で health）。poly union は各枝の lowerExpr が AllocClassValue を作る性質で自動波及。
    - **健全性**: synth ctor の cell param 順と値化サイト captures 順を**同一の `synthCtorFreeVars`**で生成＝構造的に一致。cross-scope は必ず
      null→reject（garbage cell を thread しない）。parent が**明示 ctor で fn-local capture**するケースは v1 で保守的に loud-reject
      （emitCtorCall の cross-scope reject 経由）。
    - **検証**: dt probe 全 V8 一致（mono/poly capture・複数 capture 順序・module+fn-local 混在・factory 返却・loop site・fresh-per-call・
      明示 ctor capture 回帰）。`rejects_syntax.sh` の「no-ctor capturing class value」reject を削除。新 conformance:
      classes/class_value_noctor_capture.ts（**conf 181→182**）。ci_par 全緑（exporter のみ・perf 全 budget AC・unit）。

139. **構造同一クラスの union の動的 `new`（§92=#131 残ケース③）を analyzer 主導 poly-taint で健全に実装**。`const K = cond ? A : B; new K()`
    で **A,B が構造同一**（フィールド構成が同じ）の場合、TS が `A|B` を**単一型に潰す**ため従来 loud-reject（`classValueIsMonomorphic` false）。
    NewDynamic で正しく構築しても、下流 `o.m()` の devirt が `recv_class` をレシーバの静的型（潰れた A）から再導出し `Direct(A.m)` に固定＝
    実体 B で **silent miscompile** になる危険があったため。**exporter（seed）+ analyzer devirt（taint/consume）+ sroa（ガード）**。
    - **seed（exporter）**: `NewDynamic` に `poly: bool`（`#[serde(default)]`）追加。`collectClassValueCandidates(expr)` 新規＝callee の値フロー
      （`cond?A:B` / `||` / `??` / paren / as / const 一段 deref）でクラス候補を収集。`lowerPolymorphicNew` を「union（distinct shape）＝従来どおり
      poly=false（下流は union 型で既に dynamic）」と「**collapse（構造同一）＝candidates≥2 なら poly=true**」に分岐。
    - **propagate/consume（analyzer devirt.rs）**: `compute_poly_taint(f)`＝poly NewDynamic の dst を seed し、**Copy（双方向）/ConstructResult**で
      fixpoint 伝播。`rewrite_body` で Method-callee 呼びの **recv が tainted なら `Dispatch::Dynamic` 強制**（recv_class を無視＝実体 proto で
      dispatch）。**escape 検査（exhaustive match で全 Inst 分類＝新 variant は compile error で漏れ防止）**＝tainted が call 引数/return/throw/
      store/global/closure capture 等に現れたら **`std::process::exit(1)` で loud-fail**（silent miscompile より loud）。`instanceof`/`instanceof.dyn`
      の runtime builtin はオブジェクトを read するだけなので escape から除外（whitelist）。field load/store は構造同一＝同一 offset で health。
    - **instanceof の追加修正（重要）**: `o instanceof A` の exporter `staticallyTrue` ショートカット（潰れた静的型 A を信用し `Const true`）が
      poly 値で silent miscompile（実体 B でも true）。`exprMayBePolyInstance(left)`（new/const-chain は精密、let/var は `fnHasCollapsedPolyNew`
      でフォールバック、param/call/field は poly 不可＝false）で shortcut を抑止し**常に正しい runtime proto-walk** へ。poly new を含まない関数は
      無影響（perf 中立）。
    - **健全性の不変条件**: Direct 化は `recv_tainted==false` のときのみ。(1) 全 poly-new を seed、(2) Copy/ConstructResult で単調 over-approx
      伝播、(3) 関数境界を越える経路は loud-fail、(4) tainted recv は recv_class 不参照で無条件 Dynamic ⇒ silent miscompile 不能。
    - **検証**: dt probe 全 V8 一致（method/getter/setter/compound 動的 dispatch・alias・direct `new(c?A:B)()`・instanceof 実体反映・typeof・
      equality・loop・複数 poly）。escape ケース（return/call-arg/field-store）は analyzer loud-fail を確認（silent 無し）。回帰: §92 union escape・
      monomorphic value・通常 devirt（Shape サブクラス）・mono instanceof。新 conformance: classes/new_polymorphic_collapsed_union.ts
      （**conf 182→183**）。ci_par 全緑（perf 全 budget AC・unit）。
    - **スコープ外（reject/loud-fail 維持）**: poly 値が関数境界を越える使用（v1 は loud-fail・将来 interproc で）、値フローが関数呼び返り値を
      経由するケース（`pick(c) || B` 等は collectClassValueCandidates が辿れず安全に reject）、①引数フォワード（別タスク）、regex/BigInt。

## セッション 100（poly-new 残ケース①: 引数あり poly new で no-ctor メンバへの引数転送）

140. **引数あり polymorphic `new K(...args)` で no-ctor メンバへの引数転送**（§92=#131 残ケース①＝poly-new 残ケースの最後）。`const K = cond ? A : B;
    new K(5)` / `new (cond?A:B)(5)` で union メンバに**明示 ctor の無いクラス**が含まれるケース（従来 `args.length===0 || allExplicit` ゲートで
    loud-reject）。**exporter のみ（新 IR / runtime / emit_c 変更なし＝既存 `CallSpread` + rest-param を流用）**。
    - **注（既に動いていた範囲）**: モノモーフィック/直接形 `new C(5)`（no-ctor C extends 明示 ctor P）は `lowerNewStaticClass`→`emitImplicitConstruction`
      （実引数を固定配列で親 ctor へ）で**既に動作**。今回の gap は **poly 経路の共有合成 ctor `synthClassValueCtor`**（arity 0・引数を捨てる）が
      `NewDynamic`→`ts_construct`→`ts_call(synthFn,[inst,...args])` で呼ばれ、受け取った引数を no-ctor メンバの親へ転送できない点のみ。
    - **JS 意味論**: no-ctor の implicit ctor は (a) 明示 ctor 親なし → `constructor(){}`＝引数無視、(b) 明示 ctor 親あり → `constructor(...args){
      super(...args) }`＝親へ転送。
    - **修正（exporter）**: (1) `noCtorForwardKind(classId)`＝no-ctor チェーン（`emitImplicitConstruction` と同じ範囲）を辿り **"ignore"**（明示 ctor
      祖先なし＝引数無視）／**"forward"**（明示 ctor 親が cell 不要＝`super(...rest)` 転送可）／**"reject"**（明示 ctor 親が fn-local cell を capture
      ＝CallSpread は先頭固定引数 recv 1 個のみで cell を渡せない）を返す。(2) `synthClassValueCtor` を "forward" のとき `this` の後に **rest param**
      を追加（`ctx.restParam` + FnInfo `restParam`）し、新ヘルパ `emitImplicitConstructionForward(ctx,classId,tid,restLid)`＝最初の明示 ctor 親へ
      `CallSpread{recv:tid, argSpecs:[spread(restLid)], Direct(pctor)}` で転送し各 no-ctor クラスの field init を走らせる（emit_c.rs:606 が
      `args[rest_index..nargs]` を rest 配列に集約、CallSpread codegen が `_a[0]=recv`+spread で `pctor(_a,_n)`＝親 ctor の recv-form ABI `[this,
      ...realargs]` と一致）。rest 経由で `new K()`＝`super()`／`new K(5)`＝`super(5)` を引数数非依存に一様処理。(3) `lowerPolymorphicNew` ゲートを
      `args.length===0 || memberCids.every(cid => methodFunc.has(cid:ctor) || noCtorForwardKind(cid)!=="reject")` に緩和。
    - **検証**: dt probe 全 V8 一致（①A 引数無視・①B `super(x)`/多引数/field-init 併用/no-ctor 2 段中間クラス転送・回帰: §92 明示 ctor poly+引数・
      §99 ②③・no-arg poly・モノモーフィック `new C(arg)`）。新 conformance: classes/new_polymorphic_args_noctor.ts（**conf 183→184**）。
      `rejects_syntax.sh` の「poly new with args + no-ctor member」を①B-reject（**親明示 ctor が fn-local capture**）へ入替。ci_par 全緑（exporter
      のみ・class value は cold path＝hot path 不変・perf 全 budget AC・unit）。
    - **これで §92 poly-new 残ケース①②③が全て解決**＝polymorphic class value 動的 `new` は distinct-shape union / 共通基底サブクラス / 構造同一
      union（poly-taint）/ no-ctor capture / 引数転送まで JS 準拠で網羅。**残（v1 制限・loud）**: no-ctor メンバの親明示 ctor が fn-local capture +
      引数あり poly new（CallSpread 単一 recv 制約）、poly 値の関数境界越え（§99）。

## セッション 101（poly-new: 親明示 ctor が fn-local capture する no-ctor メンバの引数転送＝§100 残の解禁）

141. **引数あり poly `new` で「no-ctor メンバの親明示 ctor が fn-local を capture」するケースを解禁**（§100=#140 で残した最後の v1 制限）。
    **exporter のみ（新 IR/runtime/emit_c なし）**。
    - **§100 の前提「`CallSpread` は先頭固定引数を recv 1 個しか持てない」は誤りだった**: `CallSpread.argSpecs` は **複数の `Single` を `Spread` の前に
      並べられる**（emit_c の CallSpread codegen は `_a` に recv(任意)→各 argSpec を順に詰める）。よって recv 無し +
      `argSpecs=[Single(cell0)…Single(cellN), Single(this), Spread(rest)]` で **cells-form ctor ABI `[cells…, this, …realargs]`**（emitCtorCall の cells
      形）をそのまま再現できる。
    - **修正**: (1) `synthCtorFreeVars`＝no-ctor チェーンが明示 ctor 親で break する時、その**親 ctor の fn-local free vars も rollup**
      （`freeVars(ctorNodeOfClassId(parent))`、transitive）＝synth ctor の cell params とサイト captures の双方に親 ctor の cell が入り env 順一致。
      (2) `emitImplicitConstructionForward`＝`ctorCellArgs(ctx, pctor)` で親 cells を解決し recv 無し `[...cells, this, spread(rest)]` の CallSpread を
      emit（cells 空＝§100 の recv 形と等価で無回帰）。(3) `noCtorForwardKind` を "reject" 廃止＝"ignore"/"forward" の 2 値に。(4) `lowerPolymorphicNew`
      ゲートは no-ctor が常に引数処理可になり**poly-new の compile-time reject は払底**（真の cross-scope 値化のみ既存の container fallback→runtime 
      "not a constructor" abort＝loud）。
    - **検証**: dt probe 全 V8 一致（親 capture+引数転送・親 capture のみ・複数 cell・child field-init+親 capture 併用・2 段 no-ctor 中間・モノモーフィック
      `const K=C;new K(arg)`・回帰多数）。`rejects_syntax.sh` の §100 ①B-reject chk を削除（now-supported）。conformance:
      classes/new_polymorphic_args_noctor.ts に親 capture 転送ケースを追記（**conf 184 維持**＝既存ファイル拡張）。ci_par 全緑（exporter のみ・perf 全 budget AC・unit）。
    - **⚠ 発見した pre-existing 別バグ（本タスク非導入・要対処候補）**: `parentIdOf`（exporter.ts:6679）が **parent を NAME で解決**
      （`classInfos.findIndex(c => c.name === parentName)`）＝**異なるスコープの同名クラス**（`function f1(){class P{}…} function f2(){class P{}…}`）で
      `extends P` が**最初の同名 P に解決**される。プレーンな継承ですら **silent miscompile**（dt: `f1(){class P{p(){return 1}} class C extends P{}; new C().p()}` が
      `2` を返す）。本機能とは独立（§100 の非 capture forward でも同根）。本タスクの conformance は各スコープでクラス名を unique にして回避。**symbol ベースの
      parent 解決への修正は別タスク**（class_extract の parentName を classId 化＝広範囲）。

## セッション 102（`extends` の lexical 名前解決を symbol ベース化＝同名クラス parent 誤解決の silent miscompile 修正・JS ルール 7/8）

142. **`extends X` の parent 解決を NAME ベース → SYMBOL ベース**に変更し、§101 で発見した「異なるスコープの同名クラスで `extends P` が誤った P に解決される silent miscompile」を修正（JS class 名前解決ルール 7/8＝「extends は通常の外側スコープ lexical 解決」「class body の名前は extends 解決に使わない」の実装。ユーザ提示ルール全体の第一歩で、ランタイム TDZ/binding lifetime とは独立＝parent の**静的同定**のみ）。**exporter/class_extract のみ**（analyzer `ClassDef.parent` は classId を受け取るだけ＝無改変）。
    - **根因（name ベース解決の連鎖）**: class_extract `declareClass` が `extends` の symbol を捨て `parentName=expr.text` だけ保存 → `parentIdOf`(exporter.ts:6679) `findIndex(c=>c.name===parentName)`（最初の同名が勝つ）+ その呼び出し元 `findMember`/`isGeneratorMethod`/`staticContainerClassOf`/`staticFieldClassOf` + `ClassDef` シリアライズの `nameToId.get`（最後の同名が勝つ＝parentIdOf と非整合）+ class_extract `scanStability` 親チェーン walk。
    - **修正**: (1) `ClassInfo` に `parentSym?: ts.Symbol`（`extends` 識別子の `getSymbolAtLocation`）と `parentId?: number` を追加。(2) `extract()` が全クラス宣言後（`bySymbol` 充足）に `ci.parentId = bySymbol.get(ci.parentSym)` を一括解決（symbol のみ・name フォールバック無し＝宣言順非依存・scope-correct）。(3) `parentIdOf`/`scanStability`/`ClassDef` シリアライズを全て `parentId` 使用へ。(4) generic 特化のクローンに `parentSym`/`parentId` を伝播、`resolveSpecializedParent` が `parentId=specParent` を設定。
    - **`extendsBuiltinError`(6710) も同 symbol 化（ユーザ指摘）**: `classInfos.some(c=>c.name===p)` を `parentId !== undefined` に置換。`getSymbolAtLocation` は内側スコープ→外側→global/lib の順で解決するので、inner スコープに user `class Error{}` があれば parentId が立ち（user クラス継承＝builtin 扱いしない）、無ければ global builtin に解決＝parentId undefined となりその時だけ builtin 名集合で判定＝scope 正しい。**name フォールバックは入れない**（`extends Error`(真の builtin) で別スコープの無関係 user `Error` に誤束縛するため有害）。
    - **スコープ正しさの根拠**: TS のクラス symbol は宣言ごとに一意（interface と違いマージしない）、`extends P` 参照はレキシカル解決で正しい宣言 symbol に解決、`bySymbol` は `sym(decl.name)`（同じ getSymbolAtLocation）でキー付け＝宣言名 symbol と参照 symbol は同一。`instanceof`/`resolveSpecializedParent` と同一の解決パターン。**無回帰**: ユニーク名は symbol=name 同一 id（既存挙動不変）、binding edge（`const K=class P{}; extends K`）は今日も undefined で同値。
    - **検証**: dt probe 全 V8 一致（同名 2 関数の継承メソッド 1/2・field 10/20・super override・static field/method 継承・generator メソッド継承・user Error shadow 継承・builtin Error subclass の throw/catch `e.message`）。回帰: 単一スコープ継承・generic `extends Box<number>` 特化親・§92/§99/§100/§101 poly-new。新 conformance: classes/extends_same_name_scopes.ts（**conf 184→185**）。ci_par 全緑（exporter のみ・class 解析はビルド時＝hot path 不変・perf 全 budget AC・unit/devirt）。
    - **⚠ 本セッションで発見した別の pre-existing silent miscompile（同種・別経路・未対処）**: **`new <builtin名>()` の builtin 検出が NAME ベース**＝user クラスが builtin 名を shadow しても builtin に解決される。`function f(){ class Error{x=99} return new Error().x }` が AOT NaN / Node 99（`new Map()` 等も同様）。`extends` 経路（本修正）とは別の `lowerNewBuiltin`/builtin 名前判定の経路。symbol ベース判定（識別子が user クラス symbol に解決されるなら builtin 扱いしない）で直せるが**別タスク**。
    - **DEFER（JS ルールの残り・後段）**: TDZ（ルール 2/6/9＝`class C extends C`/初期化前参照→ReferenceError）、block scope binding lifetime（ルール 3）、class expression 名の内部限定可視性（ルール 5）、static field/block での自名参照（ルール 10）。いずれもランタイム binding 状態追跡が要で、lexical 解決に委ねる本修正と矛盾せず後付け可能。

## セッション 103（ビルトイン名を通常の識別子として扱う＝`new <builtin>()`/受信者種別の shadow-aware 化＝§102 発見バグ修正）

143. **user クラスがビルトイン名（Map/Set/Array/Error/Promise/Date…）を shadow した時に正しく user クラスを使う**よう修正（§102 発見の silent miscompile）。JS 仕様: ビルトイン名は予約語でなく通常の識別子＝レキシカルスコープで解決し user binding が shadow する（ユーザ提示仕様 §1/§23）。tsaot は AOT でランタイム Environment Record を持たないので、仕様の `ResolveBinding` は **TS チェッカーのコンパイル時スコープ解決に委譲**＝ビルトイン検出を NAME ベースから **symbol ベース（`isBuiltinSymbol`）** に統一する方針（§102 extends と同型）。**exporter のみ・既存 `isBuiltinSymbol`(exporter.ts:442) を流用**。
    - **監査結果**: ビルトイン検出はほぼ全経路で既に shadow-aware（`isBuiltinNamespaceRef`/`isBuiltinSymbol` 経由＝Math/JSON/Object/console/Symbol 名前空間・静的メソッド・グローバル関数 parseInt 等・値参照 globalFnValueName）。**未 gate は 2 経路のみ**。
    - **修正 (1) `new <builtin>()`**（new-expression 識別子ゲート exporter.ts:1053）: `lowerNewBuiltin` を **`!csym || isBuiltinSymbol(csym)` の時だけ**呼ぶ。user クラスが名を shadow すれば skip → `resolveNewTarget` が `classSymToId` で user クラスを構築。真のビルトイン（全宣言 .d.ts）は従来どおり。no-symbol は防御的に ambient 扱い（`isBuiltinNamespaceRef` と同方針）。これで `class Error{x=99}; new Error().x`→99（旧 AOT NaN）。
    - **修正 (2) `builtinReceiverKind`**(4413): 受信者の型シンボルが `sym.name==="Map"/"Set"/"Array"/"String"/"Promise"` で builtin 種別判定していた（NAME ベース）ため、user shadow クラスのインスタンスのメソッド呼びが builtin メソッドに誤ルートし loud-reject。`if (sym && !isBuiltinSymbol(sym)) return undefined;` を追加＝user 型は builtin 受信者でない→user メソッドへ通常 dispatch。array/tuple リテラル型（nominal symbol 無し）は従来の構造判定へ素通り。
    - **検証**: dt probe 全 V8 一致（user shadow の Map/Set/Array/Error/Promise/Date を new + メソッド/フィールド/継承、scope 分離で shadow と真 builtin が別解決、回帰: 真の Map/Set/Array/Promise メソッド・string/number 受信者・§102 extends builtin/user Error）。新 conformance: classes/builtin_name_shadowing.ts（**conf 185→186**）。ci_par 全緑（exporter のみ・hot path 不変・perf 全 budget AC・unit/devirt）。
    - **これで tsaot のビルトイン検出は new / namespace / global-fn / value-ref / 受信者種別の全経路で symbol ベース（shadow-aware）に統一**＝仕様 §1/§23 の AOT 実現。**スコープ外（AOT 非該当 or 別件）**: ランタイム Environment Record/Realm（§3-§13）、`globalThis.X===X` identity・`var Array` の global object binding・module vs script の global membership・import binding shadow（§5/§6/§15/§17/§18＝ランタイム global object モデル要）、TDZ/block-scope lifetime/class expression 名可視性（§102 DEFER）、regex/BigInt。

## セッション 104（scope/name-resolution 残課題: cyclic extends / class value name / globalThis）

144. **`cyclic/self extends` の exporter ハングを loud-reject 化し、`ClassName.name` と `globalThis` の silent DIFF を解消**。
    - **cyclic extends**: `class C extends C {}` / `class A extends B{}; class B extends A{}` は parentId チェーンが cycle になり、後続の
      member/static/parent walk が止まらない。`class_extract` の parentId 解決直後に visited-set で cycle を検出し、cycle 内クラスを
      `stable=false` + reason `cyclic-extends` にして parentId を切断。exporter `setupClasses` が該当クラスを `unsupported` にするため、
      コンパイラ DoS ではなく明示 reject になる。
    - **class value `.name`**: `ClassName.name` / `const K = C; K.name` が空/undefined になる差分を修正。`ClassDef.name` を IR schema に追加し、
      emit_c が `CLASS_NAME[]` を出力、`AllocClassValue` 後に `ts_set_fn_meta(v, FN_ARITY[ctor], CLASS_NAME[classId])` を呼ぶ。これで class value は
      既存の function metadata 経路（`ts_get(fn,"name"/"length")`）に乗る。`K.length` も ctor arity と一致。
    - **globalThis**: runtime global object モデルは未実装なので、ユーザーソース宣言に解決しない ambient `globalThis` は `lowerIdentifier` で
      loud-reject。`const globalThis = ...` のようなユーザー binding は通常スコープ解決に委譲して shadow を許す。
    - **テスト**: `classes/class_name.ts` を追加（conf **186→187**）。`rejects_syntax.sh` に self/mutual extends と ambient globalThis を追加。
      dt: class name OK、globalThis REJECT。`run_conformance.sh exhaustive` は 187/187、unit は全 suite pass、`ci_par` は conf/basic/bench/perf PASS。
      ただしこの sandbox では `run_fetch_test.sh` のローカル POST echo server bind が `PermissionError: [Errno 1] Operation not permitted` で失敗し、
      `ci_par` 全体は fast gate の fetch 部分のみ FAIL（実装差分とは無関係の環境制約）。

## Sealed and non-extensible arrays (session 352, slice AB)

An element store or `push` that added an element to a sealed or non-extensible
array (`Object.seal`, `Object.preventExtensions`) succeeded silently: the store
paths tested only the frozen bit (`ts_obj_integrity & 1`). V8 throws
`TypeError: Cannot add property N, object is not extensible` for a new element
and accepts a write to an element the array already has (sealed elements stay
writable; frozen ones do not).

`ts_array_set` now tests every integrity bit. Frozen throws as before (a read
only property for a present element, not extensible for a new one); sealed or
non-extensible stores to a present element and throws for an index past the
length or into a hole. The inline paths (`ts_array_set_inline`,
`ts_array_push_inline`) take any integrity bit to the slow path, so the hot
path's test is one compare against zero. Fixture `arrays/push_receivers`
(frozen, sealed, non-extensible: push, store, add, far add, a hole, several
arguments, the predicates, and the same through `any` and a bracket-named call).

Still open: a method call on an Array subclass instance (`class Stack extends
Array`; `s.push()` fails with "push is not a function").

## An instance's own property shadowing a class method (session 352, slice AF)

`(x as any).m = f` on a class instance adds an own property that shadows the
prototype method; a later `x.m()` must call `f`. The class extractor already
makes a class dispatch dynamically when a method-named property is written
through a receiver of that class, cast or not (`method-reassign`). Two paths
still reached the method directly:

- a virtual call through its class table (several implementations): the
  table path took any instance whose class word was in the interval. It now
  also requires the instance to carry no own dynamic properties (the sized
  head's sidecar pointer is NULL), one load and one branch beside the class
  word it already loads; an instance with own properties takes the prototype
  lookup, which honors the shadow. Knob `TSAOT_SHADOW_GUARD=0` (the parity
  oracle has no guard).
- a direct call to a method with one implementation after a write through a
  receiver of no known class (`const d = x as any; d.m = f`, an unknown
  object, `Object.defineProperty(anyObj, "m", ...)`, `anyObj[k] = f`). This
  stays a known gap. The obvious rule, "a method-named property written
  through a receiver of no known class makes every class with that method
  dynamic", was tried and withdrawn: on tsc-ts it fired for `write` (16
  classes), `kind` (14), `typeParameters`, `diagnostics`, `value`, `length`
  and nine more, names that plain objects share with class methods, marking
  47 classes unstable (6 before), and the compile ran seven times slower.
  That run also produced different compiler output, so the broadly dynamic
  mode itself has a latent defect worth its own investigation (TODO).

Fixture `classes/instance_method_shadow` (typed and cast shadows; base-typed,
subclass-typed and `any` calls; deletion restoring the method; a plain object
literal typed as the class; a single-implementation method shadowed through
a cast of the instance itself).

## An integer slot read through the inline cache (session 352, slice AH)

A class whose fields have typed slots (an enum-typed field is an int32 slot, a
`long long`; a number field a double) but whose dispatch is dynamic (its
prototype was mutated, or the class is unstable for another reason) reads and
writes every field through the runtime's property path, and that path's inline
cache read treated every numeric slot as a double: an int32 slot came back as
the double whose bits are the integer, a denormal such as 1.5e-323. The
descriptor path (`struct_field_get`, `class_reg_field_value`) and the write
path (`struct_field_set`) already distinguished the integer kind; only
`ts_prop_ic_struct_read` did not. Found by compiling tsc-ts with every class
dynamic (`TSAOT_DEBUG_ALL_UNSTABLE=1`, a debugging switch of the class
extractor; `TSAOT_DEBUG_UNSTABLE_CLASSES=<regex>` for a subset): the scanner
read its position fields as denormals and the parser looped forever, and with
the scanner alone dynamic the compile aborted with "an integer-typed field
receives 1.33e-322" when such a value was stored back. Fixture
`classes/int32_fields_dynamic_class` (strict export gives the slots their
kinds; before the fix it printed 1.5e-323 where V8 prints 3).

The debugging mode is the general way to exercise the dynamic paths with a
typed program: the whole conformance suite passes in it, and a defect of
tsc-ts in it is a defect of a dynamic path that an untyped program would hit.

## The program's main on a large stack (session 352, slice AI)

The generated program's `main` ran on the process's main thread, 8 MB on
macOS. A recursion V8 completes with its compact frames can overflow that
with the runtime's larger frames, and the dynamic paths' frames are larger
still: tsc-ts compiled with every class dynamic (the debugging mode above)
overflowed in the checker's recursion, a finite depth that completes on a
256 MB stack with output byte-identical to the typed build's. Isolate mode
already ran main on a 64 MB stack of its own; the default mode now does the
same: the header renames the generated `main` to `ts_user_main`, and the
runtime's `main` runs it on a thread whose stack is `TSAOT_MAIN_STACK_MB`
megabytes (256 unless set; 0 runs it on the process's thread as before). The
reservation is virtual. The collector takes the stack base of the thread
running each collection rather than caching the first one: the stack-check
build's exit-time collection runs on the process's thread after the program's
thread has ended, and a base cached from the program's thread sent that scan
across the gap between the two stacks (a segfault that lost the buffered
output; the GC stress gate caught it). Fixture `control/deep_recursion_dynamic` (two thousand
frames of dynamically dispatched methods: a sanity check that both engines
finish and that the knob's settings run; V8 itself overflows at about five
thousand of these frames, so the overflow this fixes, tsc-ts's checker in
the dynamic mode, cannot be a conformance fixture).

## super calls through a dynamic parent (session 352, slice AN)

`super.m()` was lowered as a direct call to the method the checker resolves
along the class chain, whatever the program does to the chain at run time: a
`Base.prototype.m = f` (a write the extractor sees, which makes `Base` dynamic
and every ordinary call on its instances a runtime lookup) was followed by
`sub.m()` but not by the `super.m()` inside the subclass's method, which kept
calling the class-body method. A relinked prototype
(`Object.setPrototypeOf(Sub.prototype, Other.prototype)`) was likewise
ignored. The static resolution now stands only along stable classes: when a
class between the parent and the one declaring the method is dynamic, the
exporter reads the method as JS does, from the home object's current
prototype (`GetProto` of the class value's `prototype`), the written property
(the field key, where a prototype write lands) first, then the class-body
method (the method key), and calls the value with the receiver. The method
body reaches its class value as any method reaches a module-scope binding
(the free-variable analysis counts such a `super` reference as a use of the
class binding, which the module init publishes in a global slot).
Fixtures: `classes/super_dynamic_parent`, `classes/dynamic_method_calls`.

Gaps kept: a class declared inside a function keeps the static resolution (a
method cannot capture its enclosing function's local, so the home object is
out of reach), and `super` inside an arrow function is a loud reject as
before.
