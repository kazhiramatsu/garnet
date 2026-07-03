# Symbol サポート — 設計ドキュメント

## 0. 目的

Symbol 関連をまとめて実装する。現状（実機確認済み）:

| 機能 | 現状 |
|---|---|
| `Symbol(desc)` | reject |
| `obj[sym]` をキーに使う | reject |
| object-literal `{ [Symbol.iterator]() {} }` | reject（computed-name メソッド） |
| class `[Symbol.iterator]() {}` | **動く**（WKSYM 経由で実装済み） |
| `Symbol.for(k)` / `Symbol.keyFor` | reject |
| `Symbol.iterator` を値として使う | 壊れる（method-id 誤解決） |
| `typeof sym` / `sym === sym` | 未実装 |
| `sym.description` / `sym.toString()` | 未実装 |

これを、既存の tagged-key 土台（property_model_redesign.md §3.6）の上に実装する。

## 1. 現状の土台（コードで確認済み）

### 1.1 キー空間（ts_rt.h）— レンジ分割で実装済み
`ts_key` は uint32_t。3 partition:
- STRING: 0 〜 (field id / method 名前 id は internField/internName で採番)
- METHOD: `TS_METHOD_KEY_BASE = 1_000_000` 〜（`TS_KEY_METHOD(id)`）
- WKSYM:  `TS_WKSYM_KEY_BASE = 2_000_000_000` 〜（`TS_KEY_WKSYM(id)`）
  well-known id 固定: iterator=0, asyncIterator=1, toPrimitive=2, hasInstance=3, toStringTag=4。
- SYMBOL tag は enum に予約済みだが**物理キー空間は未割当**（ユーザ Symbol 未実装のため）。

WKSYM のおかげで **class の `[Symbol.iterator]()` は既に動く**（`TS_KEY_WKSYM(ITERATOR)` に登録、
for-of が同じ key で引く）。これがユーザ Symbol 実装の参考形。

### 1.2 NaN-box selector — 空きが無い（重要な制約）
selector 0xFFF8〜0xFFFD の 6 個（OBJECT/STRING/FUNC/BOOL/UNDEF/NULL）が全て使用済み。
**新しい primitive selector を symbol に割けない。** → Symbol は **OBJECT-tagged な heap 値**
（専用 GC kind）で表現し、`typeof`/`===` でその kind を見分ける（accessor=kind 9 と同型）。

### 1.3 GC kind
`TS_KIND_ACCESSOR=9` が最大。`TS_KIND_SYMBOL=10` を新設。

## 2. 設計

### 2.1 ユーザ Symbol のランタイム表現
property_model_redesign.md の設計に準拠:
```c
typedef struct { ts_gc_header h; uint32_t sym_id; uint32_t flags; tsv description; } ts_symbol;
// kind = TS_KIND_SYMBOL。OBJECT selector で box（ts_obj(sym)）。
// sym_id: プロセス内で一意に採番（グローバルカウンタ）。=== は sym_id 一致（heap identity）。
// flags: bit0=registered (Symbol.for で作られた=レジストリ管理)。将来 well-known/private 用に予約。
// description: Symbol(desc) の desc 文字列（無ければ undefined）。
```
- 採番カウンタ `g_next_sym_id` は **WKSYM/method/index と食い合わない専用空間**。
  プロパティキーに使うとき `ts_key` は uint32_t で全 partition を 1 空間に詰めているので、
  ユーザ symbol を **STRING/METHOD/WKSYM と衝突しない高位レンジ**に置く必要がある。
  → **`TS_USERSYM_KEY_BASE`** を新設（例: 2_100_000_000、WKSYM(2e9)より上、uint32 上限 4.29e9 未満）。
  `obj[sym]` のキーは `TS_USERSYM_KEY_BASE + sym->sym_id`。sym_id は 0,1,2... と採番。
  （注: 数十万 symbol で枯渇しうるが、AOT 対象規模では十分。将来 64bit 化で拡張可能。）

### 2.2 `typeof` / `===`
- `ts_typeof`: OBJECT selector かつ kind==SYMBOL なら `"symbol"`。
- `===` (`ts_strict_eq`): **確認済み — 末尾が `return a==b`（OBJECT 同士はポインタ一致）**。
  したがって **同一 ts_symbol ポインタなら `===` は自動的に true**。`Symbol(desc)` は毎回別ポインタ
  なので別物（正しい）、`Symbol.for(k)` はレジストリでシングルトン化すれば同一ポインタ＝true、
  well-known もシングルトンにすれば同一ポインタ＝true。**sym_id 比較は不要**（ポインタ一致で済む）。
  → 設計簡略化: ts_strict_eq に symbol 特例を足す必要すらない。

### 2.3 `Symbol(desc)` / `Symbol.for(key)` / `Symbol.keyFor(sym)`
- `Symbol(desc)`: 新しい ts_symbol を採番して生成（毎回ユニーク）。`Symbol()` は desc=undefined。
  ランタイム `ts_symbol_new(tsv desc)`。
- `Symbol.for(key)`: グローバル `desc->ts_symbol` レジストリ（文字列キー）。同じ key なら同一 symbol。
  ランタイム `ts_symbol_for(tsv key)`。`registered` flag を立てる。
- `Symbol.keyFor(sym)`: registered symbol の登録キー文字列を返す（非登録は undefined）。
- exporter: `Symbol(...)` 呼び出し / `Symbol.for(...)` / `Symbol.keyFor(...)` を builtin に lower
  （`symbol.new` / `symbol.for` / `symbol.keyFor`）。

### 2.4 well-known symbol を値として使う: `Symbol.iterator` 等
- 現状 `Symbol.iterator` を**値**として参照すると method-id 誤解決で壊れる。
- well-known symbol も「symbol 値」として取り出せる必要がある（`obj[Symbol.iterator]` の key 計算、
  `const k = Symbol.iterator` など）。
- 設計: well-known symbol それぞれに対応する **シングルトン ts_symbol** を用意し（sym_id は
  WKSYM レンジに対応づけ）、`Symbol.iterator` 参照でそのシングルトンを返す。
  `obj[Symbol.iterator]` のキー化は、その symbol が well-known なら `TS_KEY_WKSYM(wksym_id)` に
  マップ（class メソッド登録と同じ key になり整合）、ユーザ symbol なら USERSYM レンジ。
- exporter: `Symbol.iterator`/`asyncIterator`/`toPrimitive`/`hasInstance`/`toStringTag` の
  PropertyAccess を「well-known symbol 値」ノードとして扱い、値が要るときはシングルトン取得、
  computed key `[Symbol.iterator]` として使うときは WKSYM key に解決。

### 2.5 Symbol をプロパティキーに: `obj[sym] = v` / `obj[sym]`
- computed key の lowering で、キー式の型が symbol（or well-known symbol 参照）なら、
  StoreField/LoadField を **symbol-key 経路**にする。
  - well-known: `TS_KEY_WKSYM(id)`（静的に確定）。
  - ユーザ symbol: 実行時に `TS_USERSYM_KEY_BASE + sym->sym_id` を計算する **動的キー経路**
    （StoreFieldDynamic/LoadFieldDynamic 相当、ただし symbol を文字列化せず symbol-key 化する
    新しい runtime ヘルパ `ts_get_sym`/`ts_set_sym` か、ts_set_dyn の拡張）。
- 注意: 既存の `ts_set_dyn`/`ts_get_dyn`（runtime 2310/2292）は **確認済みでキーを
  `ts_to_string_v` で文字列化する**。symbol をここに通すと `"Symbol(...)"` 文字列キーになって
  壊れる。→ symbol を文字列化せず symbol-key 化する **専用 runtime ヘルパ
  `ts_set_symkey`/`ts_get_symkey`**（引数 symbol から well-known なら `TS_KEY_WKSYM(id)`、
  ユーザなら `TS_USERSYM_KEY_BASE + sym_id` を作って ts_set/ts_get）を新設。exporter は computed
  key の型が symbol のときこの経路を emit。

### 2.6 object-literal `{ [Symbol.iterator]() {} }`
- §2.4/§2.5 が入れば computed-name メソッドの key が WKSYM/USERSYM に解決できる。
- object literal lowering（前タスクで method/accessor 対応済み）の computed-name メソッド分岐を
  追加: キーが well-known symbol なら `ts_set(obj, TS_KEY_WKSYM(id), closure)`、ユーザ symbol なら
  動的 symbol-key。これで `{ [Symbol.iterator]() {} }` が for-of と整合（class と同じ仕組み）。

### 2.7 `sym.description` / `sym.toString()`
- `description`: ts_symbol.description を返す（LoadField 特例 or builtin）。
- `toString()`: `"Symbol(desc)"` 文字列を構築。
- 優先度低（段階 3）。

## 3. 段階

- **段階 1（ユーザ Symbol コア）**: ts_symbol 構造体 + kind、`ts_symbol_new`、typeof、===、
  `Symbol()`/`Symbol(desc)` の exporter lower。`obj[sym]=v`/`obj[sym]` の symbol-key 経路
  （USERSYM レンジ + symbol 専用動的キー runtime）。description。
- **段階 2（well-known symbol 値 + computed key）**: `Symbol.iterator` 等の値参照（シングルトン）、
  `obj[Symbol.iterator]` の WKSYM key 解決、object-literal `{ [Symbol.iterator]() {} }`。
  → これで for-of/iterator プロトコルが obj リテラルでも完全に動く。
- **段階 3（レジストリ + 補助）**: `Symbol.for`/`Symbol.keyFor`、`sym.toString()`、
  `Symbol.asyncIterator`/`toPrimitive`/`hasInstance`/`toStringTag` の値参照と効果。

各段階 full CI green + perf 中立（hot path は struct field 直読みで symbol を通らないので影響無の見込み。
ただし computed key / ts_set_dyn の分岐追加が動的プロパティ経路に乗るので obj_kernel 計測）。

## 4. リスク

- **selector 枯渇**: 既述。symbol は OBJECT+kind で表現するため primitive selector 不要。
- **キー空間衝突**: USERSYM レンジを WKSYM(2e9) の上に置き、uint32 上限内に収める。sym_id 採番が
  USERSYM レンジ幅を超えないこと（実用上問題なし、要 assert）。
- **文字列化の誤り**: symbol キーを絶対に文字列化しない（専用経路）。`Object.keys` は symbol キーを
  列挙しない（JS 仕様）= prop_enum_data が symbol-key partition をスキップする述語を追加。
- **=== とレジストリ**: `Symbol.for` の同一性はレジストリでシングルトン化して保証。
- **GC**: ts_symbol.description を gc_mark でマーク。well-known シングルトンは永続 root。

## 5. 非目標（今回スコープ外）

- private symbol（`#x` クラス private field）— 既存実装があり別機構。
- `Symbol.toPrimitive` による型変換の実効果（hint 付き ToPrimitive）— 段階 3 でも値参照のみ、
  変換ロジックは別途。
- Symbol を WeakMap キー等の高度な用途。

## 6. 実装結果

### 段階 1（ユーザ Symbol コア）— DONE
- runtime: `ts_symbol { sym_id; wksym; registered; description }`（kind TS_KIND_SYMBOL=10、
  OBJECT-tagged）。`ts_symbol_new`（g_next_sym_id 採番）、`ts_is_symbol`、`ts_symbol_description`、
  `ts_symbol_key`（well-known→TS_KEY_WKSYM, 通常→TS_KEY_USERSYM(sym_id)）、`ts_set_symkey`/
  `ts_get_symkey`（文字列化せず symbol-key で ts_set/ts_get）。`ts_typeof` に symbol 追加。
  `===` は既存の `ts_strict_eq` 末尾 `a==b`（ポインタ一致）で自動的に正しい（sym_id 比較不要）。
  gc_mark に symbol.description を追加。USERSYM キー空間 `TS_USERSYM_KEY_BASE=2.1e9`。
- emit_c: builtin `symbol.new`→ts_symbol_new、`symbol.get`→ts_get_symkey、`symbol.set`→
  ts_set_symkey（void 専用ブロック）、`symbol.description`→ts_symbol_description。
- exporter: `Symbol(desc)`→symbol.new。computed key `obj[userSym]` の read/write を symbol.get/
  symbol.set へ（isSymbolKeyExpr で symbol 型判定、wellKnownSymbolId で well-known と区別）。
  `sym.description`→symbol.description。well-known computed key（obj[Symbol.iterator]）と
  Symbol.for は段階2/3 として明示 reject 継続。
- 列挙: symbol キーは WKSYM/USERSYM レンジ（≥2e9）で既存の ts_key_is_method(≥1e6) チェックが
  自動的に弾くので Object.keys に出ない（追加変更不要）。
- 検証 vs V8: typeof(symbol)/identity(false true)/description(desc, undefined)/obj[sym]=42 読み書き/
  別シンボル別キー(1 2)/symbol キー非列挙(keys.length 0)。全 CI 緑、conf 71/71、perf 中立
  (obj_kernel 206ms, typed_field 187ms)。stale negative test 更新（Symbol() の reject 除去、
  Symbol.for と obj[Symbol.iterator] の reject 残置）。追加 conformance: symbol/user_symbol.ts。

### 段階 2（well-known symbol 値 + computed key）— DONE
- runtime: well-known シングルトン `ts_wksym(id)`（iterator..toStringTag の 5 個、永続 GC root、
  各 ts_symbol の wksym フィールドに id。ts_symbol_key が TS_KEY_WKSYM(id) を返すのでクラス
  `[Symbol.iterator]()` と同じキー）。
- exporter:
  - `Symbol.iterator` 等を**値**として参照 → `symbol.wksym:<id>` builtin（シングルトン取得）。
    typeof→symbol、=== はポインタ一致で true。
  - `obj[Symbol.iterator]` read/write を symbol.get/symbol.set に統一（well-known もユーザも
    symbol 値経由。isSymbolKeyExpr で判定、wellKnownSymbolId で区別は不要になり値経由に一本化）。
  - object-literal computed-name Symbol メソッド `{ [Symbol.iterator]() {} }` → symbol.set で
    symbol-key 格納（this=object でリフト）。assignIds / free-var seeding を computed-name Symbol
    メソッドにも拡張。
  - `resolveIterator` を非クラスの `[Symbol.iterator]` オブジェクト（object literal 等）に対応:
    `typeHasSymbolIterator`（TS 型の `__@iterator@N` メンバ検出）で判定し、`obj[Symbol.iterator]()`
    を symbol.get→Value callee 呼び出しで取得、`.next()` は emitIterNext。
  - `emitIterNext` に methodField を追加（iterator の `next()` が object-literal の field-key
    メソッドでも own→prototype フォールバックで解決）。
- emit_c: `symbol.wksym:<id>` → ts_wksym(id) 専用ブロック。
- 検証 vs V8: Symbol.iterator 値(typeof symbol, 同一性 true)、obj[Symbol.iterator] 読み書き(42)、
  **for-of over object literal の custom iterator(0 1 2、外側可変キャプチャ版・メソッドローカル版とも)**。
  全 CI 緑、conf 73/73、perf 中立(obj_kernel 203ms)。stale negative test 更新
  (reject-async/reject-symbol)。追加 conformance: symbol/wellknown_iterator.ts。

### 段階 2 で発見・修正した別バグ（クロージャセル、Symbol 非依存）
object-literal メソッドが**2 段以上ネストした外側の可変変数をキャプチャ**すると、セル共有
されず値コピーになっていた（例: `{make(){return{step(){return i++;}}}}` で i++ が共有されず
NaN/不更新）。原因: `collectNested` が object-literal メソッド/アクセサを `/* method/ctor
boundary: skip body */` で free-var 解析からスキップしていたため、内側メソッドのキャプチャが
外へ伝播せず cell 昇格されなかった。アロー関数は isLiftable で正しく処理されていた。
修正: `isObjLitFn` 述語を新設し、collectNested で object-literal メソッド/アクセサを nested
function 境界として収集（アロー同様 freeVars が伝播）。検証: method->method / arrow->method /
single-level すべて V8 一致。conformance: object_methods/nested_capture.ts。

### 段階 3（レジストリ + 補助）— DONE
- runtime: グローバル Symbol レジストリ（key 文字列→singleton ts_symbol、線形探索の小テーブル、
  registered=1、永続 root）。`ts_symbol_for(key)`（同一 key で同一 symbol、=== はポインタ一致）、
  `ts_symbol_key_for(sym)`（registered の登録 key or undefined）、`ts_symbol_tostring(sym)`
  （"Symbol(desc)"、desc 無しは "Symbol()"）。
- exporter: `Symbol.for(k)`→symbol.for、`Symbol.keyFor(s)`→symbol.keyFor、symbol 型レシーバの
  `.toString()`→symbol.toString。
- emit_c: symbol.for/keyFor/toString。
- 検証 vs V8: Symbol.for 同一性(同 key true, 別 key false)、keyFor(登録 hi / 未登録 undefined)、
  toString(Symbol(desc) / Symbol())、レジストリ symbol を key に使う(o[Symbol.for("k")]=99 で同一キー)。
  全 CI 緑、conf 74/74、perf 中立(obj_kernel 206ms)。追加 conformance: symbol/registry.ts。
- rejects_symbol.sh を**否定テスト→肯定 smoke テスト**に転換（Symbol 全実装済みのため、
  Symbol.for/keyFor/toString/obj[Symbol.*] が動くことを検証）。

## 7. 完了状態

Symbol は当初の全 reject（Symbol()/obj[sym]/{[Symbol.iterator]()}/Symbol.for/Symbol.iterator 値）が
解消され、ユーザ Symbol・well-known symbol・computed key・iterator プロトコル・レジストリ・
description/toString まで一通り実装。**for-of over object literal の custom iterator** が動作。
非目標（§5）は据え置き: private symbol（#x、別機構）、Symbol.toPrimitive の coercion 効果
（値参照とキー化は可能だが Number(o) 等の変換フックは未実装）、WeakMap キー等。

## 8. 落ち葉拾い（追加対応）

### 8.1 Symbol.toPrimitive の coercion 効果（§5 非目標を解消）
ToPrimitive を実装し、`Number(o)` / `String(o)` / `+` が valueOf / toString /
Symbol.toPrimitive を spec 順で呼ぶようにした。
- runtime: `ts_to_primitive(v, hint)`（hint 0=number,1=string,2=default）。
  Symbol.toPrimitive（TS_KEY_WKSYM(TO_PRIMITIVE)）を最優先、無ければ hint に応じて
  valueOf→toString（number/default）/ toString→valueOf（string）。`g_valueof_key` を新設
  （emit_c で object_proto の valueOf method-key を ts_set_valueof_key で登録）。
- `ts_number_coerce`（Number()）: object は ts_to_primitive(.,0) 経由。
- `ts_add`（`+`）: 数値どうしの fast path はそのまま（perf 不変）。object オペランドは
  ts_to_primitive(.,2=default) してから再帰。
- `ts_to_string_v`（String()/テンプレート）: object は Symbol.toPrimitive("string") を先に試す。
- 検証 vs V8: valueOf(Number 42, + 47)、toString(String hi, + hi!)、Symbol.toPrimitive の
  hint 別(number 7 / string str / default def)。conf 75/75、perf 中立(数値 + は fast path)。
  追加 conformance: coercion/to_primitive.ts。
- 注: private symbol（#x のクラス private field/method）は既に**完全動作**していた
  （別機構。field 読み書き/mutate、private method、`#x in o` brand check、同名 #x の別クラス独立、
  private static まで V8 一致）。唯一 **private accessor（get/set #p）が segfault** していたので
  loud-reject に変更（黙って間違えない。完全対応は private-name accessor plumbing が要る別タスク）。

### 8.2 private accessor 完全対応（§8.1 の loud-reject を解消）
`get #p()` / `set #p()`（private accessor）を完全実装。前回の調査で segfault していたのを
loud-reject に倒していたが、機構を調べると登録漏れだけが原因と判明し、本対応で完全化。
- 判明した事実: class_extract は private accessor を既に ownMethods に name="#p"(# 込み) で
  記録済み。findMember/hasGetter/hasSetter は name 一致で引くので private 名でもそのまま機能。
  PropertyAccess の getter 検出（`this.#p` 読み）は node.name.text="#p"、setter 検出
  （`this.#p = v`）は lhs.name.text="#p" で、いずれも内部的に internName("get #p")/
  internName("set #p") を呼ぶ。methodDecls の callName も `get ${m.name}`="get #p" で一致。
  → アクセサ機構は private 名でそのまま動く設計だった。
- 修正: exporter の class メンバ処理（main pass + spec pass）で、getter/setter の登録条件を
  `isIdentifier(m.name)` から `isIdentifier(m.name) || isPrivateIdentifier(m.name)` に拡張
  （前回入れた loud-reject を撤去）。これだけで読み/書き/getter のみ/setter のみ/private method
  との共存すべてが動く。
- 検証 vs V8: get+set(5)、getter-only(20)、setter-only 副作用(1 2)、private accessor + private
  method 共存(2)、式中の private getter(10)。public accessor / private field は regression なし。
  perf 中立(obj_kernel 205ms, typed_field 182ms。private accessor を持つクラスのみアクセサ
  dispatch、hot path 不変)。全 CI 緑、conf 76/76。追加 conformance:
  object_methods/private_accessor.ts。
