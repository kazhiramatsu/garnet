# 統一オブジェクトモデル設計 (Unified Object Model)

## 0. 動機と方針 (Kaz)

JS 意味論では **すべてのオブジェクト**（plain object / class instance / Array / Map / Set /
Function / ...）が `Object.prototype` を proto チェーン経由で継承し、

- 継承メソッド (`arr.hasOwnProperty`, `arr.toString`, `m.constructor`)
- インスタンスへのカスタム named プロパティ (`arr.custom = 99`)
- `Object.keys(arr)` へのその反映

を持つ。よって **すべての GC オブジェクトは proto + prop-map(動的プロパティ基盤)を持つべき**。

### 設計原則（Kaz）
1. **動的アクセスが発生する場合は、常に従来の JS オブジェクトモデル（proto + prop-map）で動作する**
   — これが「常に正しい」ベースライン。
2. **最適化（struct 化・`->fN` 直アクセス・unboxed・静的メソッド dispatch）は、TypeScript の型で
   安全と判断できる場合のみ**適用する。
3. **最適化を壊す要因をマークし、それが存在する値・クラスは最適化ルートに乗せず、ベースライン
   （動的モデル）で動かす**。

この原則は既に tsaot のクラス最適化に部分実装されている（`stable`/`unstable` 判定。§2 参照）。
本設計はそれを **全オブジェクト種に一般化**し、特に配列が proto + prop-map を持つようにする。

## 1. 現状

| 種別 | proto | prop-map | 備考 |
|------|-------|----------|------|
| plain object / class instance / proto / Date (`TS_KIND_OBJECT`) | ✓ | ✓ | `ts_object {h, proto, props, cap, len, shape}`。class struct は先頭に `ts_object header` を埋め込み済み |
| Array (`ts_array`) | ✗ | ✗ | `{h, data, len, cap}` |
| Function (`ts_func`) | ✗ | ✗ | `{h, code, env, envlen}` |
| Map (`ts_map`) | ✗ | ✗ | `{h, keys, vals, len, cap}` |
| Set (`ts_set_t`) | ✗ | ✗ | `{h, elems, len, cap}` |
| Promise / Coro / Accessor | ✗ | ✗ | 内部値。ユーザがプロパティ付与する想定は薄いが、proto は持つべき |

直近のメモリ安全ガード（`ts_get`/`ts_set` で `kind != TS_KIND_OBJECT` なら早期 return）は、
`ts_array` を `ts_object` として読む heap-overflow を防ぐ応急措置。本設計の完成で撤去できる。

## 2. 既存の「最適化を壊す要因」検出（流用・拡張する資産）

`exporter/class_extract.ts` が以下を検出し `stable = false` + `reasons` を記録済み:
- `prototype-mutation` / `prototype-assign`（prototype 上書き）
- `method-reassign` / `dynamic-prop-write`（宣言外プロパティへの動的書き込み）
- `dynamic-elem-write` / `dynamic-this-write`（`this[expr] = ...`）
- `Object.defineProperty` / `Object.assign` 等 `Object.*`、`Object.*-on-prototype`
- `delete-member`、`computed-method-name`/`computed-field-name`、mixin、`constructor-returns-value`

段階Bで codegen 側 `struct_direct_offset(c, field, classes)` が `c.stable` を確認し、stable な
クラスのみ `->fN` 直アクセス、unstable は正準パス（`ts_get`/`ts_set`）にフォールバック済み。

→ **方針3 はクラスについては実装済み**。本設計はこの考え方を配列等にも適用する（型で `number[]`
等と判る配列は要素 fast path、`any` や動的プロパティ付与があれば動的モデル）。

## 3. 提案レイアウト: 共通オブジェクトヘッダ

class struct が `ts_object header` を先頭に埋め込んで proto/props を得ているのと同じ方式を、全
オブジェクト種に適用する。**共通プレフィックス `ts_obj_common` を各構造体の先頭に置く**:

```c
typedef struct ts_obj_common {
  ts_gc_header h;
  struct ts_object* proto;   /* prototype chain */
  ts_prop* props; uint32_t pcap, plen;  /* dynamic named-property map (遅延確保) */
  uint32_t shape;            /* PIC 予約 (§6 of property_model_redesign) */
} ts_obj_common;
```

`ts_object` はこの共通部のみ（= 現状の `ts_object` と同一レイアウト）。各特殊型は先頭に共通部を
持ち、後ろに固有フィールド:

```c
typedef struct ts_array {
  ts_obj_common o;           /* proto + prop-map (遅延) */
  tsv* data; uint32_t len, cap;   /* 要素 fast path */
} ts_array;
typedef struct ts_func { ts_obj_common o; void* code; tsv* env; uint32_t envlen; } ts_func;
typedef struct ts_map  { ts_obj_common o; tsv* keys; tsv* vals; uint32_t len, cap; } ts_map;
typedef struct ts_set_t{ ts_obj_common o; tsv* elems; uint32_t len, cap; } ts_set_t;
/* promise/coro/accessor も同様に先頭に ts_obj_common */
```

### 遅延 prop-map（perf 保全 / 方針1・2）
- `props = NULL, pcap = plen = 0` が初期状態。**named プロパティを実際に付与するまで prop-map は
  確保しない**（V8 の fast→dictionary 降格に相当）。
- ホットな配列要素アクセス `ts_array_get/set` は `data/len/cap` のみ触る。共通部が前置されることで
  これらのフィールドオフセットが後ろにずれるだけで、ロジック・計算量は不変。
- `ts_get(arr, key)`:
  1. 配列特有の特別扱い（`"length"` → `len`、整数 index → 要素）
  2. 自身の prop-map（`props`、空なら即スキップ）
  3. proto チェーン（`arr.o.proto` = Array.prototype → Object.prototype）
  これらは「動的アクセス時のみ」通る。型付き配列の `arr.join()` 等は従来通り静的 builtin dispatch。

## 4. proto の設置

- `g_object_proto`（既存）に加え、`g_array_proto` / `g_function_proto` / `g_map_proto` /
  `g_set_proto` を追加。各々 `proto = g_object_proto`。
- Array.prototype 上に配列 builtin（`join`/`indexOf`/`slice`/...）を `ts_func` として登録すれば、
  `any` 型の `arr.method()` が proto チェーン経由で解決できる（動的ルートの完成）。
  - builtin を `ts_func` でラップする薄いブリッジが要る（recv = args[0]）。callback を取る
    `map`/`filter` も `ts_call` 経由で動く。
- `ts_new_array` 等で `o.proto = g_array_proto` を設定。

## 5. ts_get / ts_set の一般化

`kind != TS_KIND_OBJECT` ガードを撤去し、共通部 `ts_obj_common` に対して動作させる:
- struct field（class descriptor）チェック → 自身の prop-map → proto チェーン、の現行ロジックを
  共通部基準に。
- 配列/Map/Set は `ts_get` で「特有の組み込みプロパティ（length/size）」を先に解決してから
  prop-map・proto に進む。
- `ts_set` も同様。配列に `arr.custom = 99` を付けると prop-map を遅延確保して格納。以後その配列は
  「named プロパティ持ち」。`Object.keys(arr)` は要素キー（"0".."n"）＋ named プロパティを列挙
  （§3.6 の整数キー先出し順序がそのまま効く）。

## 6. 列挙 (`ts_prop_own_enum`) の一般化

現在 `ts_prop_own_enum` は `kind != OBJECT` を弾いている。配列の `Object.keys` は
「整数 index キー("0".."len-1") を昇順 → prop-map の named キーを挿入順」。既存の整数キー先出し
ロジック（`prop_key_is_array_index`）と統合し、配列の要素を index キーとして列挙、その後 prop-map。

## 7. 段階的移行（behavior-invariance gate 付き）

各段階で「全 CI 緑 + ASan クリーン + perf 無退行」を確認:

- **U-1**: `ts_obj_common` 型を定義。`ts_object` を `ts_obj_common` で表現（レイアウト不変）。
  GC scan/free を共通部基準に整理。— 振る舞い完全不変。
- **U-2**: `ts_array` に共通部を前置（`{o, data, len, cap}`）。`ts_array_get/set` 等 ~91 箇所の
  フィールドアクセスを `a->data`→そのまま（共通部前置でオフセットのみ変化、メンバ名不変なら無修正）。
  `ts_new_array` で `o.proto = g_array_proto`、prop-map は遅延（NULL）。GC を更新。
  メモリ安全ガードはまだ残す。— 配列確保サイズ増のみ、振る舞い不変。
- **U-3**: `g_array_proto` を設置し Array.prototype builtin を `ts_func` ラッパで登録。
  `ts_get`/`ts_set` のガードを撤去し共通部で動作。配列の `length`/要素特別扱い + prop-map + proto。
  `any` 型 `arr.method()` が proto 経由で解決。`arr.custom=99` が prop-map に格納。
- **U-4**: `ts_prop_own_enum` を配列対応（index キー + named キー）。`Object.keys(arr)` 等が JS 一致。
- **U-5**: Map/Set/Function にも共通部を前置し proto 設置（同パターン）。
- 各段階で「型付き配列の要素 fast path が機械語不変」「obj_kernel 等 perf 無退行」を確認。

## 8. 最適化ルートとの関係（方針2・3 の徹底）

- 型で `number[]` 等と判り、かつ動的プロパティ付与・proto 上書きの無い配列は、要素 fast path と
  静的 builtin dispatch を維持（現状の最適化を温存）。
- `any` 型、動的プロパティ付与、proto 操作が絡む場合のみ動的モデル（proto+prop-map）に乗る。
- これはクラスの `stable`/`unstable` と同じ構図。配列にも「最適化を壊す要因」（`arr[expr]=v` で
  非整数キー、`arr.x=v` の named 付与、`Object.setPrototypeOf(arr,...)` 等）のマークを将来導入し、
  無ければ fast path、有れば動的、と分岐できる（U-3 以降の拡張）。

## 9. リスクと留意

- **GC**: 共通部前置で全種のフィールドオフセットが変わる。GC の mark/free（`gc_collect`）が各 kind の
  ポインタ（`data`/`keys`/`env` 等）を正しく辿るよう、オフセット変更に追随必須。ASan + リーク確認。
- **emit 側**: class struct は既に `ts_object header` 前置なので影響なし。配列リテラル構築や
  `sobj`/`hobj` 経路の確保サイズ計算を確認。
- **perf**: 配列 +~40B/インスタンス。ホットループは要素 fast path（機械語不変）なので CPU 影響は
  確保サイズ起因のみ。obj/typed_field/int/float/inherit カーネルで実測し budget 内を確認。
- **ブラスト半径**: ~91 箇所の `ts_array` フィールドアクセス。メンバ名を変えず共通部を前置すれば
  多くは無修正（`a->data` 等はそのまま）。`sizeof(ts_array)` 依存箇所のみ要確認。

## 10. `new` 演算子の正確なセマンティクス (ECMA-262 準拠)

参考: 「JavaScript の new 演算子の意味」 nanto_vi, Days on the Moon (2005-10-24)
https://nanto.asablo.jp/blog/2005/10/24/118564
（典拠: ECMA-262 3rd 11.2.2 new 演算子 / 13.2.2 [[Construct]]）

`new F(args)` の動作は以下の 4 段階（記事の要約）:

1. **新しいオブジェクトを作る。**
2. **そのオブジェクトの `[[Prototype]]`（`__proto__`）に `F.prototype` の値を設定する。**
   - `F.prototype` がオブジェクトでない（プリミティブ）なら、代わりに `Object.prototype` を設定。
3. **`F` を呼び出す。** `this` = 1 で作ったオブジェクト、引数は `new` に与えられたものをそのまま。
4. **3 の返り値がオブジェクトならそれを返す。そうでなければ 1 で作ったオブジェクトを返す。**
   - 「オブジェクトである」= プリミティブ値（string / number / boolean / undefined / null）でない。
     `new String("s")` 等はオブジェクト、`"s"`/`123`/`true` 等はプリミティブ。

擬似コード（記事より）:
```
Function.prototype.construct = function () {
  var newInstance = new Object();
  if (this.prototype instanceof Object)
    newInstance.__proto__ = this.prototype;
  var returnValue = this.apply(newInstance, arguments);
  if (returnValue instanceof Object) return returnValue;   // step 4
  return newInstance;
};
```

### この設計（統一オブジェクトモデル）との接続
本設計で全オブジェクトが proto を持つことで、`new` の step 1〜2 が一貫して表現できる:
- step 1: `ts_obj_common` を持つインスタンスを確保（class struct / plain object）。
- step 2: `o.proto = F.prototype`（= 当該クラスの CLASS_PROTO。`F.prototype` が非オブジェクトの
  特殊ケースは tsaot では型で除外されるため通常 CLASS_PROTO 固定。ただし動的経路では
  「`F.prototype` がオブジェクトでなければ `g_object_proto`」のフォールバックを正確に実装する）。
- step 3: コンストラクタ呼び出し（recv = インスタンス、フィールド初期化子は §3.5 case A で ctor 本体に
  注入済み）。
- step 4: **コンストラクタの返り値がオブジェクトならそれを `new` の値とする**。

### tsaot の現状と差異（要修正・実測で確認済み）
現状の `new C()` lowering は AllocObject → Call(ctor, recv=inst) → インスタンスを返す、で **step 4 を
実装していない**（ctor の返り値を捨てている）。検証:
- `class A { constructor(){ this.x=1; return {x:99}; } }` → V8 は `new A().x === 99`（返り値の
  オブジェクト）だが、tsaot は ctor 返り値を捨ててインスタンスを使う（さらに現状 codegen が壊れ
  `v2 undeclared` を出す）。`constructor-returns-value` は unstable マークするのみで未実装。
- `class B { constructor(){ this.x=7; return 42; } }` → V8 は `new B().x === 7`（プリミティブ返り値は
  無視）。tsaot もインスタンスを使うのでこちらは結果的に一致。

### 修正方針（new step 4 の正確な実装）
A. **ctor 呼び出しに dst を付け、返り値を受け取る。**
B. **ctor が値を返しうるか（`constructor-returns-value`）に応じて分岐:**
   - 返さない（多数派・型で確定）: 従来通りインスタンスをそのまま `new` の値に（最適化ルート維持。
     余分な分岐ゼロ）。
   - 返しうる: ランタイム `ts_construct_result(inst, ret)` で step 4 を実装 ——
     `return ts_is_object_like(ret) ? ret : inst;`（object-like = プリミティブ以外。文字列・数値・
     真偽・undefined・null を除く NaN-box selector 判定）。
   この分岐は「最適化を壊す要因（ctor が値を返す）をマークし、無ければ最適化ルート」という本設計の
   方針 3 にそのまま乗る。
C. **暗黙コンストラクタ（ctor なし）/ フィールド初期化子のみのクラスは値を返さないので、常にインスタンス**
   （現状維持）。
D. 親クラスの ctor が値を返す継承ケースも step 4 が連鎖するよう、`super()` 呼び出しの戻り値の扱いを
   ECMA に合わせる（派生クラスの super 返り値がオブジェクトならそれが this になる ES2015 セマンティクス。
   ただし tsaot の現行クラスモデルの範囲で段階的に）。

### 移行段階への追加
- **U-6 (new step 4)**: ctor 呼び出しに dst を付与。`constructor-returns-value` クラスのみ
  `ts_construct_result` 経由でランタイム判定（object 返り値を採用）。それ以外は現状の高速経路維持。
  golden（object 返り / primitive 返り / ctor なし / 継承）で V8 一致を確認。U-1〜U-5 とは独立に
  実装可能（proto 統一の前後どちらでもよいが、step 2 の proto 設定一貫化のため U-3 以降が望ましい）。

---
## 実装ログ

- **U-1 DONE**: `ts_obj_common` 型を導入し `typedef struct ts_obj_common ts_object;`。レイアウト完全
  不変（sizeof 48, proto@16, props@24, shape@40）。GC・既存コードは無修正。CI 緑。
- **U-2 DONE**: `ts_array` に `ts_obj_common o;` を前置（`{o, data, len, cap}`、sizeof 64, data@48）。
  メンバ名 data/len/cap 保持で `a->data` 等は無修正。`ts_new_array` は gc_alloc(calloc) で o.proto/
  o.props=NULL 初期。GC mark を `a->o.props[i].val`/`a->o.proto` も辿るよう、free を `a->o.props` も
  解放するよう更新。ASan クリーン、perf 中立（要素 fast path の機械語不変、確保サイズ +16B のみ）。
- **U-3 DONE**: Array.prototype を実装。
  - runtime: `ts_arrproto_*`（26 個）= 各 array builtin を ts_code シグネチャ（this=args[0]、JS 既定
    引数）でラップ。`g_array_proto`（proto=g_object_proto）+ `ts_array_proto_init/register`。
    `ts_new_array` で `o.proto=g_array_proto`。
  - ts_get/ts_set のガードを `kind != OBJECT && kind != ARRAY` に緩和。OBJECT と ARRAY は
    ts_obj_common が offset 0 で alias するので共通ヘッダ（proto + 遅延 prop-map）で動作。class_field_
    lookup は OBJECT のみ（配列は class descriptor を持たない）。func/map/set は U-5 まで従来通り除外。
  - exporter: `arrayProtoMethods`（name/runtime/methodId、26 メソッド）を emit。emit_c が
    `ts_setup_array_proto()` を生成し、各メソッドを `TS_KEY_METHOD(id)` で proto に登録、main で
    object proto の後に呼ぶ。Program に `array_proto_methods` フィールド追加（test fixtures 6 個も更新）。
  - 成果（V8 一致・ASan クリーン）: **any 型配列の動的メソッド（join/indexOf/includes/slice/map/
    filter 等、コールバック付き含む）が proto 経由で正しく解決**。**配列へのカスタム named プロパティ
    `a.custom=99` が遅延 prop-map に格納**。型付き配列の静的 fast path は不変。golden any_array_methods
    追加（計 44）。runtime_anymethod_safe を「array は動く / map・set は安全に loud-fail」に更新。
    全 CI 緑、perf 中立（typed_field 183ms, obj 202ms, int 382ms）。
  - これにより当初の「arr:any.join() の heap-overflow」は単に安全化されるだけでなく **正しく動作** する
    ようになった。

### 残り
- **U-4**: `ts_prop_own_enum` を配列対応（index キー昇順 + named キー）。Object.keys(arr) 等を JS 一致に。
- **U-5**: Map/Set/Function/Promise/Coro に共通ヘッダを前置 + proto 設置。ガードを完全撤去可能に。
- **U-6**: new 演算子 step 4（ctor が object を返したらそれを採用、§10）。

- **U-4 DONE**: `ts_prop_own_enum` を配列対応。配列の場合まずインデックスキー("0".."len-1"、値=要素、
  ts_intern_field で文字列キー化）を順に列挙し、その後 common header の named prop map を列挙。JSON/
  console-inspect は配列専用パスが先にあるため影響なし（{} でなく [] のまま）。spread {...arr} の
  ts_object_copy_props と Object.assign が配列ソースを受け付けるよう修正（従来は ts_is_array で skip）。
  成果（V8 一致・ASan クリーン）: Object.keys(arr)=0,1,2 / values=要素 / custom 付き=0,1,2,custom /
  entries=[["0",..],..] / {...arr}={"0":..} / Object.assign(t,arr)。golden array_enum 追加（計 45）。
  全 CI 緑、perf 中立（obj 205ms, typed_field 168ms, int 385ms）。
  注: any 型 2 要素配列の分割代入 `const [k,v] of entries` は別経路（配列分割代入）の既存課題で U-4 とは
  独立（entries 自体・非分割の for-of は正しい）。

### 残り
- **U-5**: Map/Set/Function/Promise/Coro に共通ヘッダ前置 + proto 設置。ガードを完全撤去可能に。
- **U-6**: new 演算子 step 4（§10）。

- **U-6 DONE (new 演算子 step 4)**: ctor が値を返しうるクラス（class_extract が
  `constructor-returns-value` でマーク済み）でのみ、new lowering が ctor 呼び出しに dst を付けて返り値を
  捕捉し、`ConstructResult{dst,inst,ret}` を発行。codegen は `ts_construct_result(inst, ret)` を emit
  （ret が object-like ならそれ、primitive/undefined/null ならインスタンス）。escape 解析は
  op_forces_materialization に inst+ret を追加し、escape arm で dst をインスタンスの alias として扱う。
  ランタイム `ts_construct_result` は number/string/bool/undef/null を primitive と判定（それ以外＝
  plain object/array/func/map/set は object-like）。
  値を返さない多数派クラスは従来の高速パス（ConstructResult を発行しない、ctor 呼び出しに dst 無し）を
  維持＝方針3そのまま。
  検証（V8 一致・ASan クリーン）: object 返り 99 5 / primitive 返り 7（無視）/ 通常 3 / array 返り 3 1
  （array も object-like）。通常クラスは ts_construct_result を 0 回（高速パス維持）。golden
  new_ctor_return 追加（計 46）。unit テスト 7 件 PASS（ConstructResult は exhaustive match を壊さず）。
  当初の `v2 undeclared`（ctor 返り値を捨てて codegen が壊れる）バグ解消。
  U-1〜U-5 と独立に実装（proto 統一の前後どちらでも可）。今回は U-5 前に先行実装。

### 残り
- **U-5**: Map/Set/Function/Promise/Coro に共通ヘッダ前置 + proto 設置（U-2/U-3 と同パターン）。
  これで ts_get/ts_set のガードを完全撤去でき、map:any.method() 等も proto 経由で解決可能に。

- **U-5 DONE（func/map/set 共通ヘッダ化、proto 設置は部分）**: ts_func/ts_map/ts_set_t に
  `ts_obj_common o;` を前置（U-2 と同パターン、メンバ名 code/env/keys/vals/elems 保持で本体無修正）。
  GC mark を各 o.props/o.proto も辿るよう、free を o.props も解放するよう更新。ts_get/ts_set のガードを
  `kind_has_common_header(kind)`（OBJECT/ARRAY/FUNC/MAP/SET）に一般化。promise/coro/accessor は内部
  オブジェクトで property-bag receiver にならないため共通ヘッダ非対象（従来通りガード外）。
  proto は NULL 初期。Map/Set/Function プロトタイプへの builtin ラッパ登録（U-3 の配列と同じ仕組み）は
  フォローオン。今回の主眼はメモリ安全性の確立（共通ヘッダで ts_get/ts_set が安全動作）と統一モデルの
  構造的完成。
  検証（V8 一致・ASan クリーン）: Map.set/get/size, Set.add/has/size, クロージャ呼び出し、500 回ループの
  GC stress（375250）。map:any.keys() は共通ヘッダ経由で安全に loud-fail（overflow なし、ガード
  band-aid 不要に）。runtime + golden 緑。
  注: ts_object/ts_array/ts_func/ts_map/ts_set_t が全て ts_obj_common 前置で統一。当初の
  「kind != TS_KIND_OBJECT ガード（band-aid）」は kind_has_common_header による正当な分類に置き換わった。

### フォローオン（任意）
- Map/Set/Function プロトタイプに builtin を ts_func ラッパで登録（U-3 の配列と同パターン）→ any 型の
  m.get()/s.has()/fn.call() 等を proto 経由で解決。現状は静的 dispatch で動き、any 型のみ loud-fail。
- promise/coro/accessor の共通ヘッダ化（必要になれば。現状 property-bag receiver にならず不要）。

- **フォローオン DONE (Map/Set プロトタイプへの builtin 登録)**: U-3 の配列と同じ仕組みで Map.prototype /
  Set.prototype を実装。
  - runtime: ts_mapproto_*（set/get/has/delete/clear/keys/values/forEach）/ ts_setproto_*（add/has/
    delete/clear/values/forEach）= 各 builtin を ts_code でラップ。g_map_proto/g_set_proto
    （proto=g_object_proto）+ init/register。ts_new_map/ts_new_set で o.proto を設定。`size` は
    プロパティ（メソッドでない）ので登録対象外（CallBuiltin map.size/set.size の高速パス）。
  - exporter: mapProtoMethods/setProtoMethods を emit。emit_c が ts_setup_map_proto/ts_setup_set_proto
    を生成し main で呼ぶ。Program に map_proto_methods/set_proto_methods 追加（fixtures 6 個更新）。
  - 成果（V8 一致・ASan クリーン）: **any 型 Map/Set の動的メソッド（get/has/delete/forEach 等、
    コールバック付き含む）が proto 経由で解決**。型付き Map/Set は静的 dispatch を維持（proto は動的
    パスのみに作用）。golden any_mapset_methods 追加（計 47）。runtime_anymethod_safe を「array/map/set
    すべて正しく解決」に更新。

### フル CI（U-5 + U-6 + フォローオン）
全グリーン: unit 7 件 / ci_fast（reject-symbol, anymethod-safe 含む）/ golden 47 / perf 全 budget 内
（obj 207ms, typed_field 187ms, int 392ms, float 250ms, inherit 83ms, generic 198ms）/ correct1 /
correct2。統一オブジェクトモデル U-1〜U-6 + フォローオン完了。

- **フォローオン DONE (Function.prototype: call/apply/bind)**: JS 意味論を V8 で確認の上実装。
  - 意味論: f.call(thisArg,a,b)=this=thisArg+個別引数 / f.apply(thisArg,[a,b])=配列引数 /
    f.bind(thisArg,...partial)=this と先頭引数を固定した新関数 / free 関数(this 無し)は thisArg 無視。
  - runtime: ts_func に `uint8_t takes_this`（callee が args[0] を this として読むか）。ts_make_fn が
    f->o.proto=g_function_proto を設定、takes_this 付き変種 ts_make_fn_t。invoke_with_this（takes_this の
    ときのみ thisArg を args[0] に注入）。ts_funcproto_call/apply/bind。ts_bound_thunk（env=[target,
    thisArg,partial...] を捕捉、ts_call が env を prepend）。g_function_proto + init/register。
  - ts_get/ts_set のエントリガードを `ts_is_propbag(v)=ts_is_obj(v)||ts_is_func(v)` に拡張（**関数は
    TS_SEL_FUNC セレクタを持ち TS_SEL_OBJECT でないため、従来 ts_get が関数値を弾いていたバグを修正**。
    配列/Map/Set は OBJECT セレクタなので元々通っていた）。
  - exporter: トップレベル関数を値として参照する箇所（f.call の f、コールバック）で AllocClosure を発行し
    ts_func 化（従来 TS_UNDEFINED のままだったバグを修正）。明示的 `this` パラメータ
    （function f(this:T,...)）を thisParam として検出し通常パラメータループからスキップ＋takesThis=true。
    Function struct に takes_this、Program に function_proto_methods。emit_c は fn_takes_this マップを
    Ctx に通し AllocClosure で ts_make_fn_t(...,tt) を発行、ts_setup_function_proto を生成。
  - **this パラメータ関数の直接呼び出し**（f(1,2)）: Direct 呼び出しサイトで callee が funcTakesThisIds に
    含まれるとき undefined の this スロットを args 先頭に prepend。**Value/コールバック呼び出し**
    （const g=f; g(1,2) / apply2(f)）: ts_call_value が takes_this の callee に undefined this を注入
    （ts_call は method 経由で this が既に args[0] にあるため不変）。
  - **任意式の callee 呼び出し**（greet.bind(o)("World") など、callee が CallExpression）: Unknown
    fallback で callee を値に lower し Value 呼び出し（従来 dynamic-dispatch-unsupported で落ちていた）。
  - 検証（V8 一致・ASan クリーン）: call 103 / apply 107 / bind 部分適用 115 / bind 150 / 直接呼び出し 3 /
    Value 呼び出し 9 / free 関数 call 7 / free bind 15 / bind 即時呼び出し Hello World。通常コールバック
    （map/reduce/高階関数）は takes_this=0 で ts_call 委譲のため不変。golden func_call_apply_bind 追加（計 48）。

### フル CI（Function.prototype フォローオン）
全グリーン: unit 7 / ci_fast / golden 48 / perf 全 budget 内（obj 204ms, typed_field 181ms, int 380ms,
float 251ms, inherit 85ms, generic 193ms）/ correct1 / correct2。

### 残るフォローオン（任意）
- fn.name / fn.length（メタ情報。現状未実装、必要時に）。
- promise/coro/accessor の共通ヘッダ化（property-bag receiver にならず不要）。

## ベンチ高速化 + 階層化テスト基盤 + 網羅テスト(session 3)

### ベンチ高速化(約33倍)
測定でボトルネックを特定: 1ベンチあたり export 約1.8s(node 起動 + tsc Program 構築)、解析 3ms、コンパイル 148ms。
- exporter に **`--batch` モード** 追加(`exporter.ts:batchMain`):
  - 当初「全ファイルを1つの `ts.Program` に入れる」案は壊した(各ベンチが global script で `function main()` 等が衝突)
  - **正解**: `lib.*.d.ts` をキャッシュする共有 CompilerHost + ファイルごと独立 Program。初回 1.0s、以降 18ms/ファイル
- **`--transpile-batch` モード** 追加: `ts.transpileModule` で型を剥がして V8 リファレンス .js を生成(`if(typeof main==='function')main();` を末尾に付加)
- `run_benchmarks.sh` をバッチ対応に書き換え、`scripts/run_conformance.sh` を新設
- 結果: 全62ベンチ export を 3.4s に、golden iter 48件を 16s に短縮(従来 ~90s)

### 階層化テスト基盤(`tests/conformance/{basic,exhaustive}/`)
- **V8 が唯一の正解**(手書きの expected 値は持たない、`--transpile-batch` で自動生成)
- ファイルを置くだけでテスト追加可能
- `TSAOT_CONF_SHARD=i/n` で分散実行可能
- basic(3件、回帰ネット) / exhaustive(34件、10カテゴリ: numbers/strings/arrays/objects/control/closures/classes/generics/maps_sets/iteration)

### 網羅テストが発見し、修正したバグ(全 V8 一致・ASan クリーン)

**数値・型系**:
- 数値レシーバメソッド `.toFixed()`/`toString(radix)`/`toPrecision()` — number ビルトイン種別追加 + ランタイム(half-away-from-zero で V8 に一致)
- 文字列 `lastIndexOf`
- **単項マイナスの float が int に切り捨て**(`Math.abs(-3.14)→3` の重大バグ)— `infer_int_locals` に UnOp 処理追加、結果の int 性は演算子と被演算子で決定
- ビット演算子 `& | ^ << >> >>>`、`**`、`~` — JS ToInt32/ToUint32(NaN/Inf→0、truncate toward 0、mod 2^32)で実装。`ts_to_int32(double)`/`ts_to_uint32(double)` を `ts_rt.h` に追加。`~x` は常に int32 を返す
- 可変長 `Math.max/min` — ネスト2引数に畳み込み
- `isNaN`/`isFinite`/`NaN`/`Infinity` グローバル — **`ConstVal::NaN/PosInf/NegInf`** 追加(NaN/Inf は有効な JSON 数値でないため専用タグが必要)、`collect_non_numeric_consts` でこれらを numeric 扱いに

**制御構文・コレクション**:
- **switch フォールスルー**(`case 1: case 2: case 3: <body>`)— 空ボディ case の `===` 比較を短絡 If(`||` BinOp は codegen 未対応)で OR グループ化
- **可変長 `array.push(4,5)`** — 全引数を append、結果は新しい長さ
- **`map.keys()`/`values()` の for-of** — ビルトイン配列返り値は dynamic iterator protocol ではなく配列反復を優先(generator/custom iterator は従来通り `resolveIterator` 経由)
- **文字列の for-of**(`for(ch of "abc")`)— `GenericLen` + `string.charAt` で文字反復
- **for ループ内 `continue`** — incrementor を cond_body 先頭に移動(first フラグでガード)、loop kind "forc" を追加。`continue` が cond_body へジャンプ → incrementor が走る。perf カーネル全 budget 内、回帰なし

**クロージャ**:
- **キャプチャされた仮引数がセルに初期化されない**(重大バグ): `function compose(f,g){ return x=>f(g(x)); }` で f,g が undefined → "value is not a function"。関数入口で `StoreField(cell, VALUE, paramLocal)` を発行(`this` 除く)
- **任意式の callee 呼び出し**(`greet.bind(o)("World")` 等、callee が CallExpression)— Unknown fallback で callee を値に lower し Value 呼び出し

### 進捗
- exhaustive: 20 → 31/34 パス
- 残り3件は `KNOWN_GAPS.md` 記録済み・高リスクのため保留:
  - `classes__basic`/`methods` — インライナの局所衝突(`Math.sqrt(this.x*this.x+this.y*this.y)` のインライン時、sqrt 引数局所が誤番号付け; free 関数の `Math.sqrt(x*x+y*y)` は動く)
  - `closures__capture` — ループ `let i` のイテレーションごとキャプチャ(per-iteration セル割当が必要)

### フル CI(全シャード)
unit 7 / ci_fast / golden 48 / perf 全 budget 内 / correct1 / correct2 すべてグリーン。

## 残ギャップ完全解消(session 4)

### Bug 1: インライナ局所漏れ
**症状**: `class Point { dist(){ return Math.sqrt(this.x*this.x+this.y*this.y); } }` がインライン化されると、`sqrt` の引数局所が誤番号付けされ(計算した sum が別局所、`sqrt` は未初期化局所を読む)、`p.dist()` が 0 を返す。

**原因**: `analyzer/src/sroa.rs::inline_callee` の `other => out.push(other.clone())` フォールスルー。`CallBuiltinStatic`、`AllocClosure`、`If`/`Loop`/`TryCatch`(ネスト本体)、その他多数の variant が **operand を remap せずに raw clone** されていた。

**修正**: `remap_inst_operands(inst, &m)` ヘルパを追加。`Inst` 全 variant を網羅(Rust が compile-time に exhaustiveness を検証)し、ネスト本体は再帰 remap。`subst` は `callee.locals` から事前構築するため、本体内の全 LocalId をカバー。

### Bug 1.5: SROA が非数値フィールドを Primitive(double)として確保
**症状**: `class Stack { items: number[] = []; }` で `items` スカラが double として作られ、`ts_to_num(配列ポインタ)` で値が破壊される。`classes__methods` が `0 NaN 0` を出力。

**原因**: `process_function` の `fresh(next, new_locals, false)` がフィールド型に関係なく全スカラを Primitive にしていた。

**修正**: `is_numeric = numeric_fields.contains(&(cls, f))` で判定し、numeric は Primitive、それ以外は Reference に。

### Bug 1.6: `.push(x)` がレシーバを確認せずに ArrayPush に lower
**症状**: 上記修正後も `classes__methods` が `0 NaN 0`。ユーザクラスの `Stack#push` メソッド呼び出しがインスタンスを配列扱いして `ArrayPush` 化されていた。

**原因**: exporter の早期パス(`fnx.name.text === "push" && argc === 1`)が無条件に `ArrayPush` を発行。

**修正**: `builtinReceiverKind === "array"` でガード。

### Bug 1.7: `numeric_fields` の継承伝播漏れ(性能リグレッション)
**症状**: Bug 1.5 修正後、`inherit_sroa_kernel` が **192ms vs 130ms budget で SLOW**。

**原因**: `IntBox extends Base<number>` のとき、SROA ターゲットが IntBox(class id 1)で `numeric_fields.contains((1, 2))` を検索するが、`numeric_fields` には `(Base$number=2, value=2)` しか入っていない。継承フィールドが numeric として認識されず、スカラが Reference になり、ホットループで box/unbox 往復が発生。

**修正**: `numeric_fields` 構築後、親チェーンを歩いて `(descendant_cls, fid)` を全子孫に伝播。`inherit_sroa_kernel` を 91ms に回復。

### Bug 2: ループ `let` のイテレーションごとキャプチャ
**症状**: `for(let i=0;i<3;i++){fns.push(()=>i);}` で全クロージャが i=3 を見る(V8: 0 1 2)。

**原因**: prologue でセルを 1 個だけ確保しループ全体で共有。仕様(ECMA-262 §14.7.4.2 ForBodyEvaluation)では各イテレーションで新しい binding を作成し、closure capture は body 時点の値を保持するべき。

**設計上の重要ポイント** (`docs/inliner_and_loop_let_capture.md`):
- 仕様の順序: body → CreatePerIterationEnvironment(値を新環境へコピー) → update(新環境を変更) → test
- つまり update は **次のイテレーションのセルを変更する**(現イテレーションのセルではない)。iter-N の body 中に capture されたクロージャは iter-N のセル(update 前の値)を保持し続ける

**修正**: `for` 文 lowering で captured-let を検出(`initializer.flags & NodeFlags.Let` かつ単一 identifier 宣言子かつ symbol が `cellBindings` に存在)。検出時に per-iteration セル割当の構造を生成:

```
init_cell = AllocObject(site_init);
cellLocal = init_cell;
cellLocal.value = E_init;
first = true;
Loop {
  cond_body: {
    if (!first) {
      prev = cellLocal.value;        // 現セル(iter-N)の値
      cellLocal = AllocObject(site_per);  // iter-N+1 のセル
      cellLocal.value = prev;
      update;                          // iter-N+1 のセルを変更
    }
    first = false;
    cond_local = <cond using cellLocal>
  }
  body: { BODY }   // cellAccess を cellLocal にオーバーライド
}
```

`continue` は `forc` ループの C `continue`(cond_body へジャンプ)で正しく動く。prologue のセル割当は dead code(gcc が除去)。

### 追加 conformance テスト

- `closures/capture_continue.ts`: captured `let i` + `continue` の交互作用
- `closures/capture_mutate.ts`: クロージャが i と arr[i] の両方を参照
- `closures/capture_no_alloc.ts`: 非キャプチャ `let i` の単一セル経路(性能回帰ネット)

### 最終状態(session 4 完了)

- **exhaustive: 31/34 → 37/37 PASS**(新3テスト含む)
- basic 3/3, golden 48, perf 全カーネル budget 内, correct1, correct2, ci_fast すべてグリーン
- 既知の coverage ギャップなし
