# Object.defineProperty — プロパティ属性（descriptor）設計ドキュメント（合意用ドラフト）

## 0. このドキュメントの目的

現状 `Object.defineProperty` は **データ記述子のデフォルト形**（`{ value }` で
`enumerable`/`writable`/`configurable` が省略または全部 `true`）と、**関数値の
アクセサ形**（`{ get: ()=>..., set: (v)=>... }`）の 2 つだけを受理し、それ以外は
`unsupported` で loud-reject している（exporter.ts 957-1063、8 件の reject）。

このドキュメントは、**`enumerable`/`writable`/`configurable` を正しくモデル化**し、
さらに付随する以下を一貫した設計の下に実装するための計画である:

- `Object.defineProperty` のデフォルト属性（**省略時は全部 `false`**）と任意属性の honor
- `Object.defineProperties`
- `Object.getOwnPropertyDescriptor` / `getOwnPropertyDescriptors`
- アクセサのメソッド省略形 `{ get() {} }`
- `writable: false` / `configurable: false` の振る舞い（write 無視 / delete 無視）
- 列挙（`Object.keys`/`for-in`/`JSON`/spread）が `enumerable` を尊重すること

**前提となる土台**: `property_model_redesign.md`（段階 A-1〜A-2c-1 実装済み）と
`accessor_props_design.md`（アクセサの関数値形は実装済み）。本設計はこれらの上に乗り、
それらの不変条件（正準パスの 1 箇所集約、`ts_key` tagged-key、shape/PIC 予約）を
**壊さない**ことを最優先制約とする。

> 実装上の正準パスの実体（コードで確認済み）: 設計ドキュメント
> `property_model_redesign.md` は正準 API を `ts_prop_get/set/...` と表記するが、
> **実装は既存の `ts_get`/`ts_set`/`ts_delete_prop` を正準パスに格上げした形**で、
> `ts_prop_*` という別名関数は作られていない。列挙のみ `ts_prop_own_enum` という
> 専用関数として新設済み。本ドキュメントでは以後、実在する名前
> （`ts_get`/`ts_set`/`ts_delete_prop`/`ts_prop_own_enum`）で記述する。
> `delete obj.prop` は `DeleteField` IR → `ts_delete_prop` で**実装済み**
> （configurable の honor が可能）。GC kind は現在 `TS_KIND_ACCESSOR=9` が最大なので、
> 新設する data-desc は **`TS_KIND_PROPDESC=10`**。

---

## 1. 現状の構造（事実）

### 1.1 ランタイムのプロパティ表現（属性フラグが無い）

```c
typedef struct { ts_key key; tsv val; } ts_prop;     // ts_rt.h:143 — フラグ無し
```

- `ts_object.props` は `ts_prop[]`（lazy 確保）。`key` は 32bit `ts_key`（tag は STRING のみ
  実値使用、SYMBOL/INDEX/WKSYM は予約）。
- **アクセサは既にモデル化済み**: `ts_accessor { getter, setter, g_this, s_this }`（kind
  `TS_KIND_ACCESSOR`）を prop の `val` に OBJECT-tagged で格納。`ts_get`/`ts_set` が
  `is_accessor()` を見て getter/setter を起動する（`accessor_props_design.md` 実装済み）。
- typed class instance のフィールドは C struct（`->fN`）に格納され、prop map を通らない
  （hot path）。属性の概念は「**動的 prop に乗るプロパティ**」にのみ必要。

### 1.2 列挙の正準パス（実装済み・ここに属性を効かせる）

`ts_prop_own_enum(obj, cb, ud)`（段階 A-2b-2 で実装、8 箇所の列挙が共用）が唯一の列挙経路。
現状は「struct field を宣言順 → prop map の data props を挿入順」で訪問し、accessor slot は
スキップする。**`enumerable` 属性を効かせるのはこの 1 箇所**で済む（設計の最大の利点）。

### 1.3 現状 exporter が受理/拒否する形（事実）

| descriptor 形 | 現状 |
|---|---|
| `{ value: v }`（属性省略） | 受理 → `StoreFieldDynamic`（= enumerable かつ writable な普通の prop） |
| `{ value: v, enumerable: true, writable: true }` | 受理（全 true は普通の prop と一致するという前提） |
| `{ value: v, enumerable: false }` 等 | **reject**（"per-property flags not modeled"） |
| `{ get: fn, set: fn }`（関数値） | 受理 → `ts_define_accessor_dyn` |
| `{ get() {} }`（メソッド省略形） | **reject**（lifting がid付けしない） |
| `{ get: fn, enumerable: true }` 等 | **reject**（accessor は常に non-enumerable 扱い） |
| `{ value, get }` 両方 | **reject**（spec でも TypeError） |
| 非リテラル descriptor | **reject**（形を静的に検査できない） |

### 1.4 現状の意味的な誤り（黙って間違えている箇所）

**重大**: 現状 `{ value: v }`（属性省略）を「普通の enumerable な prop」として
`StoreFieldDynamic` している。だが JS 仕様では **`Object.defineProperty` で省略された属性は
`false`**（`{}` リテラルでの代入 `o.x = v` とは違う）。つまり:

```js
const o = {};
o.a = 1;                                   // a は enumerable:true
Object.defineProperty(o, "b", {value: 2}); // b は enumerable:FALSE
Object.keys(o);  // V8: ["a"]   ← b は出ない
```

現状 tsaot は `b` も enumerable 扱いで `["a","b"]` を返す（黙ってずれる）。
これは属性フラグが無いことに起因する **既存の silent miscompile**。本設計で塞ぐ。

---

## 2. 設計目標

1. **`enumerable`/`writable`/`configurable` を per-property で表現する。** ただし
   hot path（typed struct field）には一切のコストを乗せない。
2. **正準パスに閉じる。** 列挙は `ts_prop_own_enum` の 1 箇所、write 抑止は `ts_set`/
   `ts_prop_set` の 1 箇所、delete 抑止は `ts_prop_delete` の 1 箇所。散らさない。
3. **shape/PIC（§6）と整合。** 将来 `ts_shape_field` に属性を持たせる拡張と矛盾しない
   データ構造を選ぶ。
4. **「黙って間違えない」。** モデル化できない属性の組み合わせ（後述）は引き続き loud-reject。
   ただし reject の範囲を**最小化**する（今は機能ごと丸ごと拒否している）。
5. **後方互換。** 既存の golden/bench が全て不変で通る。`ts_object` のレイアウトは変えない
   （shape スロットの二の舞を避ける）。

---

## 3. 提案するモデル

### 3.1 属性ビットをどこに置くか（3 案の比較 → 案 A 採択 ← Kaz 決定）

per-property の属性 3bit（enumerable/writable/configurable）の格納場所が核心。

**案 A: `ts_prop` に `uint8_t flags` を足す。 ← 採択（Kaz 決定: メモリ増 OK・速度低下 NG）**
```c
typedef struct { ts_key key; tsv val; uint8_t flags; } ts_prop;
// flags ビット: bit0=enumerable, bit1=writable, bit2=configurable
//   既定（リテラル/代入で作る素のプロパティ）= 0b111（全 true）
//   未初期化スロット・既存コードが flags を書かない経路は「全 true」を意味する
//   ように、ビットの極性を「立っていれば許可」にする（後述の互換初期化に注意）。
```
- 長所: **最も素直で、read 経路に unwrap が無い**（速度面で案 B より有利＝Kaz の「遅いの NG」に
  合致）。各 prop が自分の属性を直接持つ。accessor は既存 `ts_accessor` のまま（変更最小）。
- 短所: `ts_prop` が `{key:4, val:8}` の 12→padding で 16byte だったところに flags+padding で
  **24byte** に増える（key4 + pad4 + val8 + flags1 + pad7）。動的オブジェクトの prop map が
  1.5 倍。**typed struct（hot path）は prop map を使わないので kernel ベンチは無影響**。
  obj_kernel（動的 prop 多用）で perf を必ず確認する。
- **互換の肝（最重要）**: 既存コードが `ts_prop` を作る経路（`find_slot` で新スロット作成、
  `ts_set` の素直な store など）はすべて **flags を 0b111（全 true）で初期化**しなければ
  ならない。さもないと「既存の普通のプロパティが enumerable:false 扱い」になって全 golden が
  壊れる。→ スロット確保を 1 箇所（`find_slot` 系）に集約し、そこで `flags = TS_PROP_DEFAULT`
  (=0b111) を必ずセットする。`calloc` の 0 初期化に頼らない（0 = 全 false なので逆に危険）。
- **shape 整合**: 将来 shape 導入時は `ts_shape_field.numeric_mask_or_flags`（§6.1 で予約済み）に
  属性を移す。それまで prop が直接持つ。移行は `ts_prop_own_enum` 等の flags 参照を shape 参照に
  差し替えるだけ。

**案 B: 属性を「特殊な値ラッパ」に押し込む（accessor と同型）。**
非デフォルト属性を持つ data property を `ts_data_desc` heap ラッパに包む。
- 長所: `ts_prop` レイアウト不変・メモリ最小。
- 短所: 属性付き prop の **read に 1 段 unwrap**（速度に僅かに不利）。Kaz は「メモリ増 OK・
  速度低下 NG」なので、この短所が決定打となり**不採択**。

**案 C: 並列ビットマップ。** prop add/delete のたびに 2 配列同期＝バグ温床。却下。

→ **案 A 採択（Kaz 決定）。** メモリ 1.5 倍（動的 prop のみ）を許容し、read 経路に unwrap を
入れない＝速度優先。typed struct hot path は無影響。互換は「スロット確保時に flags=0b111 を
必ずセット」の 1 点に集約して担保する。

### 3.2 「デフォルト属性」の定義（2 つの異なるデフォルトに注意）

JS には**属性のデフォルトが文脈で 2 つある**。ここを取り違えると 1.4 のような silent bug になる:

| 生成経路 | enumerable | writable | configurable |
|---|---|---|---|
| リテラル `{a:1}` / 代入 `o.a=1` | **true** | **true** | **true** |
| `Object.defineProperty(o,"a",{value:1})`（省略） | **false** | **false** | **false** |
| `Object.defineProperty` で明示指定 | 指定値 | 指定値 | 指定値 |

tsaot の値表現での対応:
- 「全部 true」= **素の値**（ラッパ無し）。リテラル/代入はこれを作る。**現状通り**。
- 「1 つでも false がある」= `ts_data_desc` ラッパ。`defineProperty` の省略形 `{value}` は
  **3 つとも false** なので必ずラッパになる（これが 1.4 の修正点）。

### 3.3 正準パスの変更（3 箇所のみ）

**(a) 列挙 `ts_prop_own_enum`（enumerable を尊重）**
```
prop の val が:
  - ts_accessor       -> スキップ（現状通り。defineProperty accessor は enumerable:false 既定）
  - ts_data_desc      -> desc.enumerable が真のときだけ cb(key, desc.value)
  - それ以外（素の値） -> cb(key, val)（= enumerable:true 扱い、現状通り）
struct field          -> 常に enumerable（クラスフィールドは enumerable:true）。現状通り。
```
これで `Object.keys`/`values`/`entries`/`JSON.stringify`/`assign`/spread/`object_rest`/
`for-in`（実装あれば）の 8 経路すべてが一括で `enumerable` を尊重する。

**(b) 書き込み `ts_set`/`ts_prop_set`（writable を尊重）**
```
own slot が見つかり、その val が:
  - ts_accessor    -> setter 起動（現状通り）
  - ts_data_desc   -> desc.writable が真なら desc.value = v; 偽なら NO-OP（sloppy。strict は throw だが v1 は no-op）
  - 素の値          -> 上書き（現状通り）
（proto chain のアクセサ探索も現状通り）
```

**(c) 削除 `ts_delete_prop`（configurable を尊重）**
```
own slot が ts_data_desc かつ desc.configurable が偽 -> delete を NO-OP（false を返す。strict は throw）
それ以外 -> 現状通り削除
```
※ `delete obj.prop` は `DeleteField` IR → `ts_delete_prop` で実装済み（確認済み）。
configurable:false の delete 抑止はこの 1 箇所に追加すれば honor できる。なお
configurable は「属性の再構成禁止・data↔accessor 変換禁止」も含むが、v1 は **delete 抑止のみ**
honor し、再 define の禁止は別途（過剰実装を避ける）。

**(d) 読み取り `ts_get`/`ts_prop_get`（data_desc の unwrap）**
```
slot の val が ts_data_desc -> desc.value を返す（unwrap）
（accessor は現状通り getter 起動）
```

### 3.4 GC

`ts_data_desc` を GC kind `TS_KIND_PROPDESC` として登録し、`gc_mark` に
「`desc.value` を mark」のケースを追加（accessor が getter/setter を mark するのと同型）。
calloc 確保・sweeper が解放。**accessor の GC 実装をそのままなぞる**ので低リスク。

### 3.5 ランタイム API

```c
// 非デフォルト属性つき data property を own slot に定義（既存なら再定義）。
// 3 属性すべて true のときはラッパを作らず素の値で格納（高速パス・メモリ節約）。
void ts_define_data(tsv obj, ts_key key, tsv value,
                    int enumerable, int writable, int configurable);
void ts_define_data_dyn(tsv obj, tsv keyv, tsv value, int e, int w, int c); // 動的キー版

// getOwnPropertyDescriptor 用: own プロパティの記述子オブジェクトを構築して返す
// （{value,writable,enumerable,configurable} or {get,set,enumerable,configurable}）。
// own に無ければ undefined。
tsv ts_get_own_property_descriptor(tsv obj, tsv keyv);
```
- `ts_define_accessor` は既存（属性は常に false 既定）。本設計で
  「accessor + 明示 enumerable」も honor するなら `ts_accessor` にも enumerable bit を足すか、
  accessor も `ts_data_desc` と同じ属性 3bit を持つよう拡張する（§3.7 で扱う）。

### 3.6 exporter の変更（reject の最小化）

`Object.defineProperty(obj, key, desc)` の lowering を全面的に書き換える。
descriptor がオブジェクトリテラルのとき、メンバを分類:

```
data 記述子（value あり、get/set 無し）:
  e = enumerable の指定値（省略時 false）
  w = writable の指定値（省略時 false）
  c = configurable の指定値（省略時 false）
  -> ts_define_data_dyn(obj, key, value, e, w, c)
     （e=w=c=true のときランタイムが自動で素値格納に最適化。exporter は気にしない）

accessor 記述子（get/set あり、value 無し）:
  関数値形 { get: fn } -> 現状通り closure 化（accessor_props_design.md 実装済み）
  メソッド省略形 { get() {} } -> §3.8 で対応（lifting に id を付ける）
  e/c の指定 -> ts_define_accessor に属性を渡す（§3.7）

value と get/set 両方 -> 引き続き loud-reject（spec でも TypeError なので正しい拒否）
非リテラル descriptor -> 引き続き loud-reject（形を静的に読めない。動的 descriptor は別タスク）
enumerable/writable/configurable が非 boolean-literal（変数等）-> loud-reject
  （静的に値が読めないため。`{writable: someVar}` は稀。動的版は別タスク）
```

**これにより現状の 8 reject のうち 4 つ（per-property flags / accessor+attr /
accessor shorthand / value-without-descriptor）が解消**し、残る reject は
「value+get/set 両方」「非リテラル descriptor」「非リテラル属性値」の**正当な 3 つ**に絞られる。

### 3.7 accessor の属性（enumerable/configurable）

現状 accessor は常に non-enumerable 固定。`defineProperty` の accessor 既定も
enumerable:false なので、**多くの場合これで正しい**。ただし `{ get: fn, enumerable: true }`
は現状 reject。これを honor するには `ts_accessor` に属性ビットを足す:
```c
typedef struct { ts_gc_header h; tsv getter, setter; uint8_t g_this, s_this;
                 uint8_t enumerable, configurable; } ts_accessor;  // +2 byte
```
- `ts_prop_own_enum` の accessor 分岐を「`enumerable` が真なら getter を起動して
  その値を cb に渡す」に変更（列挙時に getter を呼ぶのは V8 と同じ挙動）。
- **判断ポイント（要合意）**: enumerable accessor は稀。段階を分け、**まず data property
  の属性を完成**させ（§4 段階 1-2）、enumerable accessor は段階 3 で対応 or 引き続き
  reject、とする。過剰実装を避ける。

### 3.8 アクセサのメソッド省略形 `{ get() {} }`

現状 reject の理由は「`GetAccessorDeclaration` に lifting が fn id を付けない」。
対応は exporter の lifting プリパスで、defineProperty の descriptor 内の
`{ get() {} }`/`{ set() {} }`（`ts.isGetAccessorDeclaration`/`isSetAccessorDeclaration` を
持つ ObjectLiteral メンバ）にも fn id を割り当て、関数値形と同じく closure 化する。
- メソッド省略形は **function-expression 相当（`this` = オブジェクト）** なので
  `g_this/s_this = 1`。
- これは局所的な lifting 拡張。**判断ポイント（要合意）**: 段階 3 に回すか同時にやるか。

### 3.9 `Object.getOwnPropertyDescriptor` / `defineProperties`

- `getOwnPropertyDescriptor(obj, key)`: ランタイム `ts_get_own_property_descriptor` が
  own slot を見て記述子オブジェクトを構築。data は `{value,writable,enumerable,configurable}`、
  accessor は `{get,set,enumerable,configurable}`、struct field は
  `{value, writable:true, enumerable:true, configurable:true}`（クラスフィールド既定）。
- `getOwnPropertyDescriptors(obj)`: own 全キーで上記を集めたオブジェクト。`ts_prop_own_enum`
  を「全 own（enumerable 問わず）」版で回す内部 enum が要る（列挙用とは別の callback）。
- `Object.defineProperties(obj, descs)`: `descs` の各 own プロパティについて
  `defineProperty` 相当を繰り返す。exporter で展開（descs がリテラルなら静的展開、
  非リテラルは reject）。
- **判断ポイント（要合意）**: これらは段階 2-3。getOwnPropertyDescriptor は需要が読めるので
  優先度を聞きたい。

---

## 4. 移行戦略（段階的・各段階で full CI + perf 不変）

各段階は独立にコミット可能で、full CI green（conformance/ci_fast/unit/correct1,2/perf）を
ゲートにする。`property_model_redesign.md` の規律を踏襲。

- **段階 0（健全化・先行）**: 現状の `{value}` 省略形が enumerable:true で誤動作している
  バグ（§1.4）を、**まず loud-reject 化**するか、段階 1 で一気に直すか決める。
  → 段階 1 をすぐやるなら 0 はスキップ可（直す方が良い）。

- **段階 1（data property の属性・コア）**: `ts_data_desc` + kind `TS_KIND_PROPDESC` 追加、
  GC mark、`ts_define_data[_dyn]`、正準パス 3 箇所（enum/set/get、delete があれば 4 箇所）の
  data_desc 分岐、exporter の data 記述子 lowering 書き換え（省略時 false を honor）。
  検証: `defineProperty({value})` が `Object.keys` に出ない、`writable:false` で write 無視、
  全部 true 指定が素値と同一挙動、を V8 と一致。**reject 2 件解消**（per-property flags /
  value-without-descriptor）。

- **段階 2（getOwnPropertyDescriptor + defineProperties）**: ランタイム記述子構築 +
  exporter。リテラル descriptors の静的展開。

- **段階 3（accessor の属性 + メソッド省略形）**: `ts_accessor` に enumerable/configurable、
  メソッド省略形 lifting、enumerable accessor の列挙時 getter 起動。**reject 2 件解消**
  （accessor+attr / accessor shorthand）。

各段階後、残る `unsupported` は意味的に正当なものだけ（value+get/set 両方、非リテラル
descriptor、非リテラル属性値）に収束する。

---

## 5. リスクと緩和

- **hot path 退行**: `ts_get`/`ts_set` に data_desc 分岐が 1 つ増える。ただし**動的 prop の
  slot を見つけた後**のみで、typed struct field path（`->fN` 直読み）は通らない。accessor の
  `is_accessor()` チェックが既に同じ位置にあり perf 中立だった実績があるので、同型の
  `is_data_desc()` も中立のはず。obj_kernel ベンチで確認。
- **レイアウト後方互換**: `ts_prop` も `ts_object` も変えない（案 B の眼目）。既存 golden の
  オブジェクトは全て素値格納のまま。
- **二重ラップ**: `defineProperty` で同じ key を再定義したとき、古い desc を捨てて新 desc に
  差し替え（ラップのネスト禁止）。`ts_define_data` 内で is_data_desc/is_accessor を見て
  in-place 更新。
- **GC**: data_desc の value を mark 漏れすると UAF。accessor の実装をなぞり、ASan で確認。
- **enumerable の伝播**: `Object.assign`/spread は **enumerable own のみ** コピーが正しい。
  正準 `ts_prop_own_enum` に閉じているので 1 箇所直せば全経路で正しくなる（設計の利点）。

---

## 6. shape/PIC との整合（今守ること）

`property_model_redesign.md` §6 の制約に従う:
1. `ts_object` レイアウトは変えない（shape スロットは予約済み・本設計でも触らない）。
2. 属性は当面 `ts_data_desc`/`ts_accessor` の値ラッパに持つが、shape 導入時は
   `ts_shape_field.numeric_mask_or_flags`（予約済み）へ移す。正準パスの「data_desc 分岐」
   1 箇所を「shape の flags 参照」に差し替えるだけで済む形にしておく。
3. 列挙順 = 挿入順を維持（`ts_prop_own_enum` が既に保証）。属性導入で順序は変えない。

---

## 7. 合意したい論点（Kaz への確認）

1. **段階 1 の範囲**: §1.4 の既存バグ（省略 `{value}` が enumerable 誤り）は段階 1 で
   「直す」で良いか（loud-reject を経由せず一気に正す）。golden に該当ケースが無いことは
   確認するが、もし依存している箇所があれば挙動が変わる。
2. **案 B（値ラッパ）で良いか**: hot path 無影響・レイアウト不変を取り、属性付き prop に
   heap 1 個のコストを許容する設計。案 A（`ts_prop` に flags 追加、+メモリだが unwrap 不要）と
   どちらが好みか。
3. **accessor の属性（§3.7）とメソッド省略形（§3.8）**: 段階 3 に回す前提で良いか、
   それとも需要があるので段階 1-2 に含めたいか。
4. **getOwnPropertyDescriptor の優先度（§3.9）**: 段階 2 で良いか、不要なら後回し or 対象外。
5. **writable:false / configurable:false の strict 挙動**: v1 は **no-op**（sloppy mode 相当。
   throw しない）で良いか。strict throw は例外機構があるので可能だが、コンパイル時に strict 文脈を
   判定する必要があり、v1 は no-op が無難という提案。

（delete 経路は `DeleteField`/`ts_delete_prop` で実装済みを確認したので、当初の論点 6 は解消。
configurable:false の delete 抑止はそこに 1 箇所足すだけで honor できる。）

---

## 8. 実装進捗

- **段階 1（data property の属性・コア） — DONE。** 案 A（`ts_prop` に `uint8_t flags`）で実装。
  - runtime/ts_rt.h: `ts_prop` に `flags` 追加。`enum { TS_PROP_ENUMERABLE=1, WRITABLE=2,
    CONFIGURABLE=4, DEFAULT=0b111 }` と述語 `prop_is_enumerable/writable/configurable`。
  - runtime/ts_rt.c: スロット確保を `find_prop`（ts_prop* 返し、新スロットを
    `flags=TS_PROP_DEFAULT`=全 true で初期化）に集約。`find_slot` はその薄い別名（&val 返し、
    後方互換）。`ts_set` は own data slot が writable:false なら write を no-op。
    `prop_enum_data` に `prop_is_enumerable` を AND（列挙系 8 経路すべてに一括で効く）。
    `ts_delete_prop` は configurable:false なら delete を no-op（false 返し）。
    `ts_define_data[_dyn]`（e/w/c を受けて flags セット。全 true は素プロパティと同一挙動）新設。
  - analyzer/emit_c.rs: builtin `object.defineData:<e>:<w>:<c>` → `ts_define_data_dyn` を emit。
    （`CallBuiltinStatic` は全 arg を Global へエスケープさせるので obj は SROA 消去されない。）
  - exporter: defineProperty の data 記述子 lowering を書き換え。属性は **省略時 false**
    （Object.defineProperty 仕様。リテラル `{x:1}` の全 true とは別）を honor。boolean-literal 以外の
    属性値（`{writable: someVar}`）は loud-reject（動的記述子は別タスク）。
  - **§1.4 の既存 silent bug を修正**: 省略 `{value}` が enumerable:true 扱いで Object.keys に
    出ていたのを、正しく non-enumerable に。
  - **reject 2 件解消**（per-property flags / value-without-descriptor の前者）。残る reject は
    value+get/set 両方・非リテラル descriptor・非リテラル属性値・accessor+attr・accessor
    method-shorthand の 5 件（前 3 件は正当、後 2 件は段階 3）。
  - 検証 vs V8: 省略→非列挙(`a`)＋読取可(2)、writable:false→write 無視(1)、configurable:false→
    delete 無視(false 1)/true→削除(true undefined)、JSON/spread/values が enumerable 尊重、全 true→
    素プロパティ同一、非リテラル属性→reject。conf 61/61。
  - **stale な negative test を更新**: tests/rejects_bigint_etc.sh の "defineProperty
    enumerable:false" 行を削除（now supported）。accessor 系の reject は残置。
  - **perf 中立**（ts_prop 16→24byte だが hot path は struct field 経路で prop map 不使用）:
    obj_kernel 207ms（budget 290）、typed_field 188ms。全 CI 緑。
  - 追加 conformance: defineproperty/{data_attrs,writable,configurable,enum_paths}.ts。
- 次: 段階 2（getOwnPropertyDescriptor / defineProperties）、段階 3（accessor の属性 +
  メソッド省略形 `{ get() {} }`）。

- **段階 2（getOwnPropertyDescriptor / getOwnPropertyDescriptors / defineProperties）— DONE。**
  - runtime: `ts_get_own_property_descriptor(obj, keyv)` 新設。own struct field（class
    instance）は `{value, writable:true, enumerable:true, configurable:true}`、prop-map の data
    は slot flags から `{value,writable,enumerable,configurable}`、accessor は
    `{get,set,enumerable,configurable}`（getter/setter は ts_accessor から、e/c は slot flags から）。
    own でなければ undefined。`ts_get_own_property_descriptors(obj)` は struct field（宣言順）+
    prop-map（挿入順、非列挙・accessor 含む）を全部走査して `{key: descriptor}` を構築。
    descriptor 構築ヘルパ build_data_descriptor / build_accessor_descriptor / ts_own_descriptor_by_key。
  - emit_c: `object.getOwnPropertyDescriptor` / `object.getOwnPropertyDescriptors` を runtime 呼び出しへ。
  - exporter: namespaceBuiltin に getOwnPropertyDescriptor(argc2)/getOwnPropertyDescriptors(argc1) 追加。
    `Object.defineProperties(obj, {k: desc, ...})` は object-literal を静的展開し、各エントリを
    lowerDefineOneProperty に流す（非リテラル descriptor map / 非リテラルキー / 非 object-literal
    descriptor 値は loud-reject）。defineProperty の単一記述子ロジックを lowerDefineOneProperty
    ヘルパに切り出して両者で共有。
  - 検証 vs V8: gOPD data（全 true）/ 定義済み非列挙（5 false false false）/ 存在しない→undefined /
    accessor（function undefined false true）、defineProperties（1 2 3 / keys=a）。
- **段階 3（accessor の属性 + メソッド省略形）— DONE。**
  - **重要発見**: `{ get() {} }` は GetAccessorDeclaration ではなく **MethodDeclaration named "get"**
    としてパースされる（`{ get x() {} }` が GetAccessor）。これを踏まえて分類（nm==="get"&&
    (PropertyAssignment||MethodDeclaration)）、assignIds（object-literal 内の method-shorthand
    get/set に fnId 付与）、free-var seeding walk（同 method を allFns に追加）を修正。lowerClosure
    で this=object（thisParam=true）として lift。
  - accessor 属性: ts_define_accessor を ts_define_accessor_attr（e/c 受け取り）にリファクタし、
    属性を**スロットの flags**に格納（accessor オブジェクトは getter/setter、slot flags が e/c。
    writable bit は accessor では未使用）。ts_define_accessor_dyn は e/c を受け取るよう拡張、
    emit_c の builtin を `object.defineAccessor:<gThis>:<sThis>:<enum>:<conf>` に拡張。
    これで gOPD が accessor の e/c を正しく報告。configurable:true を honor。
  - **enumerable:true は loud-reject**: 列挙モデル（prop_enum_data）は accessor slot を常にスキップ
    するので enumerable accessor を列挙できない。silent に間違えるより honest に拒否（設計 §3.7 の
    判断）。enumerable:false / 省略（既定）は正しく動く。
  - 検証 vs V8: shorthand get（42）/ shorthand get+set+this バッキング（7,25,25）/ 関数値形（regress 99）/
    gOPD accessor e/c=false / configurable:true honor / accessor 既定 non-enum（keys=a）/ enumerable:true → reject。
  - reject の最終状態: 残るは value+get/set 両方・非リテラル descriptor・非リテラル属性値・
    accessor+enumerable:true の **4 件のみ**（すべて意味的に正当 or モデル限界の honest reject）。
    当初 8 件の reject から、機能 6 件を実装で解消。
  - **stale negative test 更新**: tests/rejects_bigint_etc.sh の "defineProperty getter shorthand"
    行を削除（now supported）。"accessor + enumerable" は残置。
  - perf 中立（obj_kernel 201ms, typed_field 181ms、全 budget 内）。全 CI 緑、conf 64/64。
  - 追加 conformance: defineproperty/{get_own_descriptor, define_properties, accessor_shorthand}.ts。
- property_descriptors_design.md の全段階（1/2/3）完了。

- **段階 3 追補（enumerable accessor）— DONE。** 前回 honest reject にしていた
  `Object.defineProperty(o, k, { get..., enumerable: true })` を実装。
  - 設計判断の核: 列挙時に accessor の「値」を出すには getter 起動が必要だが、Object.keys は
    getter を呼んではいけない（V8 も呼ばない）。そこで **prop_enum_data から `!is_accessor`
    条件を外し**（enumerable bit のみで判定）、accessor の値解決は**値を消費する callback 側**で
    `enum_resolve_value(receiver, stored)`（accessor なら getter を this=receiver で起動、
    それ以外は素の値）を呼ぶ形に分離。Object.keys（cb_push_key）は値を使わないので getter を
    呼ばない＝副作用なし。Object.values/entries/JSON/assign/spread/rest は呼ぶ。
  - 各 enum callback の ctx に `recv`（ソースオブジェクト）を追加（getter の this 用）。
    enum_arr_ctx / enum_copy_ctx / json_obj_ctx / enum_rest_ctx すべてに recv 追加、setup 各所で設定。
  - console.log（inspect）は Node 同様 getter を**起動せず** `[Getter]`/`[Setter]`/`[Getter/Setter]`
    を表示（副作用回避）。cb_inspect_obj_prop に accessor 分岐追加。
  - exporter: enumerable:true の reject を削除、`object.defineAccessor:<g>:<s>:<enum>:<conf>` の
    enum ビットに enumAttr を渡す。
  - 検証 vs V8: enumerable accessor → keys(a,x)/values(1,2 getter起動)/JSON({"a":1,"x":2})、
    非列挙 accessor 既定 → keys(a) かつ直接読取(9)、console.log enum accessor → `{ a: 1, g: [Getter] }`、
    get+set → `[Getter/Setter]`、class-syntax getter は vtable 経由で非列挙（regression OK: x {"x":1}）。
  - **reject の最終状態: 3 件のみ**（value+get/set 両方・非リテラル descriptor・非リテラル属性値、
    すべて意味的に正当）。当初 8 件の reject から機能 5 件を実装で解消し、accessor enumeration も完了。
  - perf 中立（obj_kernel 206ms, typed_field 188ms）。全 CI 緑、conf 65/65。
  - stale negative test 更新: "accessor + enumerable" 行を削除。
  - 追加 conformance: defineproperty/enumerable_accessor.ts。

- **段階 4（動的 descriptor / 残り reject の解消）— DONE。** 静的に形を読めない descriptor を
  loud-reject していた残り全件を、ランタイム検査の動的パスで解消。
  - runtime: `ts_define_property(obj, keyv, desc)` を新設。descriptor の own プロパティ
    （value/get/set/enumerable/writable/configurable）を `ts_has_own`+`ts_get`+`ts_truthy` で
    実行時検査し、data/accessor を振り分け。属性は **キー不在時 false**（defineProperty 仕様）。
    value+get/set 併存は `ts_throw(TypeError 文字列)`（catch 可能）。getter/setter の this は
    関数の `takes_this` から g_this/s_this を決定（function-expr は this=receiver、arrow は lexical）。
    `ts_define_properties(obj, descs)` は `ts_prop_own_enum` で descs の各 own キーを回し
    `ts_define_property` を呼ぶ（cb_define_one/defprops_ctx）。配置は ts_get_own_property_descriptors
    の後（ts_prop_own_enum/ts_has_own/ts_get/ts_throw が scope に入る位置）。
  - emit_c: `object.definePropertyDyn` → `ts_define_property`、`object.definePropertiesDyn` →
    `ts_define_properties`（いずれも void なので専用 emit ブロック）。`CallBuiltinStatic` は全 arg を
    Global へエスケープさせるので obj/descriptor は SROA で消えない。
  - exporter: 非リテラル descriptor（変数等）・非リテラル属性値（`{value:1, writable:w}`）・
    非リテラル defineProperties map / 動的エントリは、reject ではなく descriptor オブジェクトを
    通常式として lower して動的パスへ。リテラル descriptor は従来の静的高速パスを維持。
    空 descriptor `{}` / value 無し（`{enumerable:true}` 等）は value=undefined を合成して許可
    （旧 reject を解消）。
  - 検証 vs V8: 動的 descriptor（42 x）/ 変数属性 writable:false（1）/ 空 `{}`（true undefined 0）/
    動的 defineProperties（1 2 a）/ value+get TypeError catch / 動的 accessor（fn get+set, 20）/
    dynamic arrow getter（5）/ 静的リテラル regression（9 x）。
  - **残る reject は 3 件のみ、すべて意味的に正当**: (1) リテラル descriptor の value+get/set 併存
    （spec TypeError をコンパイル時に loud-reject。動的形は runtime TypeError）、(2) get/set が
    関数でない（`{get:5}`）、(3) get/set の未対応な形。なお `{ get(){} }` を**変数**に入れた
    object literal は「object literal の method member」未対応（defineProperty とは別件の一般機能）。
  - perf 中立（obj_kernel 205ms, typed_field 182ms）。全 CI 緑、conf 66/66。
  - 追加 conformance: defineproperty/dynamic_descriptor.ts。
- **これで Object.defineProperty / defineProperties / getOwnPropertyDescriptor[s] は、
  data 属性・accessor 属性・method-shorthand・enumerable accessor・動的 descriptor まで穴なく実装完了。**
  当初 8 件の reject はすべて「実装」または「spec 上正当な拒否」に解決。
