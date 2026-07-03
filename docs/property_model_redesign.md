# プロパティモデル再設計 — 設計ドキュメント（合意用ドラフト）

Status: PROPOSAL（実装前・合意待ち）
Author: tsaot
関連: object_prototype_design.md, accessor_props_design.md, coerce_design.md

---

## 0. このドキュメントの目的

`in` / `hasOwnProperty` / `Object.hasOwn` / `Object.entries` / `Object.prototype` /
アクセサ の実装で繰り返しバグが出た。原因は機能の難しさではなく、プロパティ処理の
**構造**にある。本ドキュメントはその構造的原因を特定し、最小侵襲かつ将来 PIC を
載せられる統一モデルへの移行を設計する。実装は本設計の合意後に着手する。

---

## 1. 現状の構造（事実）

### 1.1 プロパティの格納場所が 3 つあり、統一インターフェースがない

| # | 格納場所 | アクセス手段 | 列挙 | accessor | proto |
|---|---------|------------|------|----------|-------|
| 1 | typed struct field (`ClassN->fN`) | `LoadField`/`StoreField` の直アクセス | ✗ | ✗ | ✗ |
| 2 | prop map (`ts_object.props`) | `ts_get`/`ts_set`/`find_slot` | ○ | ○ | ○ |
| 3 | accessor (`ts_accessor`) | prop map の値として、`ts_get`/`ts_set` 内で分岐 | (skip) | ○ | ○ |

- 経路2+3（動的経路）は `ts_get`/`ts_set` に綺麗に統一されている。**これは良い。**
- 経路1（最適化経路）は完全に別物で、accessor も proto も列挙も無視する。
- `class_has_field` / `class_reg_*`（class descriptor）は、経路1のオブジェクトを
  経路2的な操作（`in`/`hasOwn`/enumerate）から見えるようにするための **後付けの橋**。

### 1.2 「enumerated class」という最適化オフのバケツ

`compute_enumerated_classes`（emit_c.rs）は「JSON.stringify / Object.keys/values/entries /
spread / rest に流れるクラス」を集め、`local_class.retain(|_,c| !enumerated.contains(c))`
で **そのクラスだけ struct 最適化を無効化** し prop map に落とす。
- これは「最適化（struct）と汎用性（prop map）を両立できない」ことの回避策。
- 判定漏れ（観測できないデータフロー、新しい列挙系 API）で静かに壊れる。
- 例: フィールド初期化子バグ（後述）と同じ「経路の穴」を生む温床。

### 1.3 SROA escape を症状ごとに後付け

`interproc.rs` で `Print` / `HasField` / `HasFieldDynamic` / `BinOp "+"` …と、
「オブジェクトの実体を実行時に要求する操作」を **発見のたびに個別追記** している。
「どの操作が実体を要求するか」のルールが一元化されていないため、新操作で必ず忘れる。

### 1.4 これらが生んだ実際のバグ（履歴）

- `console.log(obj)` が undefined（Print が escape を立てていなかった）
- `"x" in d` が undefined（HasField が escape を立てていなかった）
- `"" + new P()` が undefined（BinOp + が escape を立てていなかった）
- 継承クラスフィールドが `in`/`hasOwn` で見えない（経路1が descriptor を見ていなかった）
- `"toString" in o` が false（method-key と field-key の名前空間ミスマッチ）
- フィールド初期化子のみ（ctor なし）のクラスで `c.a` が NaN（経路の穴・別バグ）

すべて「同じ意味の操作を、3 経路それぞれに手書きし、どれか 1 つを忘れる」パターン。

---

## 2. 設計目標

1. **単一の正準プロパティ操作**にすべてを通す。get/set/has/own/enumerate/delete。
2. struct 最適化は正準操作の**下**で透過的に行う（呼び出し側は最適化を意識しない）。
3. 新機能・新 API を足すとき、**触る場所が 1 箇所**になる。
4. 「enumerated class」逃げ道を**廃止**する。
5. SROA escape を**単一ルール**に統一する。
6. **perf 回帰ゼロ**（typed_field ~185ms / obj ~205ms を死守）。
7. 将来 PIC を**自然に載せられる**土台にする（§6）。

非目標（今回やらない）: PIC 本体の実装（ただしデータ構造は本設計で確定し土台を用意する、§6）、
shape の完全な hidden-class 化。
**フィールド初期化子バグは本設計に取り込む**（§3.5。プロパティ処理と密接なため）。

---

## 3. 提案するモデル

### 3.1 「フィールドは常に prop map に存在する」を不変条件にする

最大の構造的決断: **typed struct field を「prop map のキャッシュ」と位置づける**。
- 正準の真実は prop map（経路2）。struct field（経路1）はその一部を unbox 高速化した**写像**。
- これにより列挙・has・accessor・proto はすべて prop map ベースの**単一実装**で済む。
- struct アクセスは「prop map に必ず対応スロットがある」前提で offset 直読みする最適化。

ただし naive にやると「struct とは別に prop map も持つ」=二重メモリ・二重書き込みで
perf 死。そこで段階的に、まず**意味（正準パス）を統一**し、最適化は「証明できる場合だけ
prop map を経由せず struct を直読み」する形にする（§3.3）。

### 3.2 正準プロパティ操作 API（runtime）

すべての経路がこの 6 関数のどれかを呼ぶ。実装は **1 箇所**:

```
tsv  ts_prop_get(tsv obj, uint32_t key);              // get（accessor 起動・proto walk 込み）
void ts_prop_set(tsv obj, uint32_t key, tsv val);     // set（accessor・proto・own 作成）
int  ts_prop_has(tsv obj, uint32_t key);              // `in`（proto walk 込み）
int  ts_prop_has_own(tsv obj, uint32_t key);          // hasOwn（own のみ）
int  ts_prop_delete(tsv obj, uint32_t key);           // delete
// 列挙: コールバックで own enumerable data key を順に渡す（keys/values/entries/JSON/dir/assign/spread が共用）
void ts_prop_own_enum(tsv obj, void (*cb)(uint32_t key, tsv val, void* ud), void* ud);
```

- これらが「struct field（descriptor 経由）→ prop map → accessor → proto chain」を
  **正しい順序で 1 回だけ**処理する。
- 既存の `ts_get`/`ts_set` は `ts_prop_get`/`ts_prop_set` の薄い別名にする（後方互換）。
- 列挙系（`ts_object_keys/values/entries`、`json_stringify`、`inspect`、`assign`、
  `copy_props`、`object_rest`）はすべて `ts_prop_own_enum` を呼ぶだけにする
  → 現在 35 箇所に散った列挙ロジックが 1 箇所に集約。
- `is_object_proto_name`（well-known 名の `in` 特例）も `ts_prop_has` 内 1 箇所に閉じる。

### 3.3 struct 最適化は「証明できるときだけ」の直読み

`LoadField`/`StoreField` の直 struct アクセス（`->fN`）は、次が**静的に証明できる**ときのみ:
- `obj` の class が確定（`local_class`）、かつ
- その class が **stable**（実行時 proto mutation / 動的 this-write がない）、かつ
- field がそのクラスの own/inherited data field（accessor でない）であることが確定。

この条件を満たさなければ `ts_prop_get`/`ts_prop_set`（正準パス）にフォールバック。
- 現状の `field_path` + `local_class` 判定をこの 3 条件に厳密化する。
- **`enumerated_classes` を廃止**: 列挙は正準パス経由で struct field も見えるので、
  「列挙されるから struct をやめる」は不要になる。列挙系が
  `ts_prop_own_enum` を呼び、それが class descriptor で struct field を列挙する。
- これにより「struct 最適化されたクラスでも `Object.keys` が正しく動く」。

### 3.4 SROA escape の単一ルール

「**正準パス（`ts_prop_*`）にオブジェクトを渡す操作は、そのオブジェクトをエスケープさせる**」
を interproc.rs の**単一の分類関数**にする:

```
fn op_forces_materialization(inst) -> &[LocalId]  // 実体を要求するオペランド列を返す
```

- Print / HasField / HasFieldDynamic / BinOp("+") / LoadFieldDynamic / StoreFieldDynamic /
  CallBuiltin(列挙系) … をこの 1 関数で列挙。新操作はここに 1 行足すだけ。
- 「struct 直読みできる（§3.3 の条件を満たす）LoadField/StoreField」は実体要求しない
  （SROA 可能なまま）。それ以外は要求する。ルールが escape 解析と最適化条件で**一致**する。

### 3.5 フィールド初期化子（`class C { a = 1 }`）の正しい構築

**現状のバグ（事実確認済み）**: exporter の `new C()` lowering（exporter.ts ~434）は、
明示コンストラクタ `${classId}:ctor` があればそれを呼ぶが、**フィールド初期化子
（`a = 1` の初期化式）をどのコード経路にも lower していない**。`ownFields` には
記録される（レイアウト用）が初期化式が捨てられる。結果、明示 ctor を持たないクラスで
`c.a` が未初期化（NaN/undefined）になる。これはプロパティ処理そのものの欠落であり、
本再設計に取り込む。

**JS セマンティクス**: フィールド初期化子は構築時に実行される。
- 明示 ctor がある場合: `super(...)` 呼び出しの**直後**（super が無ければ ctor 本体の
  **先頭**）に、宣言順で各初期化子 `this.f = <init>` が走る。
- 明示 ctor が無い場合: 暗黙 ctor が `super(...args)`（継承時）＋初期化子を実行する。
- 初期化子は `this` 上の通常のプロパティ書き込み = **正準パス `ts_prop_set` と同じ経路**を
  通るべき（数値 field なら struct 直書き最適化が効く）。

**設計**: class-extract で各クラスの「フィールド初期化子リスト」
`[(field_id, initializer_expr_node)]`（宣言順、初期化子を持つものだけ）を収集する。
exporter の構築 lowering を次に統一する:

- IR レベルで「初期化子を実行する合成 prologue」を用意し、ctor の有無に関わらず
  構築時に必ず走らせる。具体的には 2 案あり、合意したい（§7-6）:
  - **案 A**: 明示 ctor の本体先頭（super 呼び出し直後）に初期化子の `StoreField` 列を
    挿入。明示 ctor が無ければ初期化子だけの暗黙 ctor 関数を合成。`new` は常に ctor を呼ぶ。
  - **案 B**: `new` の lowering 側で、AllocObject 直後（継承時は親 ctor 実行後）に
    初期化子 `StoreField` 列を出し、その後で（あれば）明示 ctor を呼ぶ。
  - 推奨は **案 A**（JS の評価順 — super→初期化子→ctor 本体 — を最も忠実に再現でき、
    継承・super・this 参照初期化子も自然に扱える）。
- いずれも初期化子の書き込みは `StoreField`（正準パス or 証明可能時 struct 直書き）を使う。
  これにより「初期化子・ctor 代入・外部代入」がすべて同じプロパティ経路を通り、
  §3.1/§3.3 の不変条件に乗る（経路の穴が原理的に消える）。
- フィールド初期化子の中で `this.other` を参照するケースは宣言順評価で自然に動く。

**検証**: `class C { a = 1; b = 2 }` の `new C().a`、初期化子付き継承、初期化子と明示 ctor
併存、初期化子が他フィールド/メソッドを参照、を V8 比較。golden 追加。

### 3.6 統一キー空間（V8 流 tagged key）と Symbol/Index の収容（実装は後・設計は今）

**V8 の事実（調査済み）**: V8 はプロパティを 3 系統に分ける（資料）:
1. **elements**（integer-indexed: `arr[0]`, `obj[5]`）— 連続バッキングストア、index 直アクセス、昇順列挙。
2. **named string key**（`obj.x`）— hidden class の descriptor。
3. **named symbol key**（`obj[sym]`）— 同じく descriptor。Symbol は String ではなく `Name` 系の
   一意 heap object。`Symbol("x")` と `"x"` は別キー。well-known/`Symbol.for`/private symbol あり。
キーは「単一 id 空間のレンジ分割」ではなく **tagged key**（`enum { String(id) | Symbol(id) }` +
elements は別管理）。→ **旧 §3.6 のレンジ分割案は撤回**し、これに合わせる。

**tsaot のキー設計（確定）**: プロパティキーを **3 種の直交した tagged key** とする。
各 id 空間は独立で食い合わない（Kaz の「32bit で足りるか」への構造的回答: 分離するから足りる）。

```
PropertyKey (tsaot):
  ├─ Index(uint32_t)    // integer-indexed。配列 elements / プレーンオブジェクトの数値キー。
  │                     //   id 化しない＝整数値そのもの。JS array index は 2^32-1 まで。枯渇概念なし。
  ├─ String(StringId)   // named string key（メソッド名も String）。コンパイル時 intern、独立 32bit。
  └─ Symbol(SymbolId)   // named symbol key。実行時採番、独立 32bit。well-known も Symbol 空間の予約 id。
```

物理表現は **64bit tagged key**（`ts_key = uint64_t`）に確定:
```
// ts_rt.h 単一定義（analyzer は emit 時にこの定数を参照、METHOD_KEY_BASE 二重定義を解消）
//   上位 8bit = tag、下位 32bit = id（中間は予約）
enum ts_key_tag { TS_K_STRING=0, TS_K_SYMBOL=1, TS_K_INDEX=2, TS_K_WKSYM=3 /* well-known symbol */ };
//   ts_key_make(tag,id) / ts_key_tag(k) / ts_key_id(k)
//   ts_key_is_string(k) / ts_key_is_symbol(k) / ts_key_is_index(k)
//   ts_key_is_enumerable_data(k): 列挙対象（string データ + index）。method/symbol/accessor は別規則。
```
- `ts_prop.key` を `ts_key`(64bit) に拡張。**コスト = 動的オブジェクトの prop map のキーが
  4→8byte**。typed struct（hot path）は struct field 直アクセスで prop map を使わないので**無影響**。
  メソッド名は String レンジ（旧 METHOD_KEY_BASE 相当を tag=STRING のサブ規則 or 別 tag に整理）。
- 散在する `key >= METHOD_KEY_BASE` 比較・`field_enumerable` を `ts_key_*` 述語に集約。
  将来 Symbol/Index の扱いを変えるとき触るのは述語の中だけ。

**構造体最適化との関係（Kaz の問い「struct に落とす処理は問題ないか」への答え: 問題なし）**:
- 構造体に落ちるのは **String key の静的フィールドのみ**。これは IR レベルで既に分離されている
  （実証: `c.x`→`LoadField{field=StringId}`、`o[i]`→`LoadIndex`、`o[sym]`/動的→
  `LoadFieldDynamic`）。`field_path`/`own_fields`/`ts_class_field.name_id` は元から String id。
- よって tagged 化しても struct 最適化のキー解決は **String レンジを使うだけで変更不要**。
- 段階 B の「証明できるとき struct 直読み」発火条件に「**かつ key が String レンジ**」を 1 つ足すのみ。
  Symbol/Index キーは自動的に正準パス（prop map / elements）へフォールバック。
  → V8 の「in-object slot は named string、symbol は descriptor、index は elements」と同型。
- shape（§6）の `ts_shape_field.key` も `ts_key`。struct field=`{String(id),data-in-struct,offset}`、
  symbol prop=`{Symbol(id),data-in-propmap}`、index=elements 側。3 種を区別して持てる。

**重要バグ（現状から在る穴。tagged 化とは独立だが本再設計で塞ぐ）**:
- `c["x"]=v`（動的 string key、struct field と同名）が **struct field を更新せず prop map に書き、
  `c.x`(struct直読み)と食い違う**（実証: AOT `undefined`、V8 `99`）。
- プレーンオブジェクトの数値キー `o[0]=v` が `StoreIndex`→`ts_array_set`（配列経路）に誤誘導され
  **完全に壊れる**（実証: AOT `undefined`、`Object.keys` 空。V8 `a`, `0,5`）。
- どちらも §3.1 の「正準パス `ts_prop_set` が struct descriptor と key 種別で 1 箇所振り分け」で塞ぐ。
  String key で struct field なら offset 書き、なければ prop map。Index はプレーンオブジェクトでは
  prop map（文字列 "N" 相当の Index キー、配列の elements 高速路は別維持＝**案 I-B 合意済み**）。

**well-known symbol の id 割り当て表（確定・予約。tag=WKSYM）**:
| symbol | wksym id | 現状の偽装文字列 |
|--------|----------|------------------|
| Symbol.iterator | 0 | `@@iterator` |
| Symbol.asyncIterator | 1 | `@@asyncIterator` |
| Symbol.toPrimitive | 2 | （未） |
| Symbol.hasInstance | 3 | （未） |
| Symbol.toStringTag | 4 | （未） |

**ユーザ Symbol のランタイム表現（設計のみ・実装は別タスク。資料 §8 の設計に準拠）**:
```
typedef struct { ts_gc_header h; uint32_t sym_id; uint32_t flags; tsv description; } ts_symbol;
//   flags: well_known / in_public_registry / private_kind(Public/Internal/FieldName/Brand)
//   typeof -> "symbol"; a===b は sym_id（=heap identity）一致; obj[sym] は
//   ts_key_make(TS_K_SYMBOL, sym->sym_id) をキーに ts_prop_set。
//   Symbol.for(desc) は global desc->sym_id レジストリ（別タスク）。
//   private symbol（#x のクラス private field）は将来 private_kind で同機構に乗る。
```

**段階との関係**: 段階 A-2 で `ts_key`（tagged）確定・述語集約・WKSYM 表確定・`ts_prop.key` 64bit 化
（Symbol/Index 実装はしないが契約と物理表現を固定）。プレーンオブジェクト数値キーの I-B 化と
`c["x"]` 二重化解消は段階 A〜B（正準パス統一）で。well-known の `@@iterator`→`WKSYM` 移行は段階 D。
ユーザ Symbol 実装・`typeof`・`Symbol.for`・private symbol は**別タスク**（このとき `ts_prop_*`/
shape/struct 最適化を作り直さずに済むことを本節が保証）。

**（C0）即時の健全化（先行実施）**: 黙って間違える経路を loud reject 化。
`o[Symbol.iterator]=fn`（空出力誤動作）/ generator `*[Symbol.iterator]`（runtime 失敗）/
`Symbol(...)`/`Symbol.for(...)`/Symbol を値として使用（未定義呼び出し）/ プレーンオブジェクトの
数値キー（配列誤誘導で誤動作）→ いずれも明示拒否 or 段階実装まで reject。「黙って間違えない」原則。

## 4. 移行戦略（段階的・各段階で振る舞い不変 + full CI + perf）

各段階は独立にコミット可能で、その段階だけで全テストが緑になることを必須とする。

- **段階 A（意味の統一・振る舞い不変）**
  - **キー空間 `ts_key` の確定（§3.6, V8 流 tagged key）**: `TS_METHOD_KEY_BASE` 二重定義を解消し、
    tagged key（tag=String/Symbol/Index/WKSYM + 32bit id、物理は 64bit `ts_key`）+
    `ts_key_make`/`ts_key_tag`/`ts_key_is_string`/`is_symbol`/`is_index`/`is_enumerable_data`
    述語を `ts_rt.h` に新設。`ts_prop.key` を `uint32_t`→`ts_key`(64bit) に拡張。散在する
    `key >= METHOD_KEY_BASE` 比較と `field_enumerable` をこの述語経由に集約。Symbol/Index/WKSYM
    レンジを予約（Symbol 実装はしない）。WKSYM 割り当て表を確定。**この時点で挙動不変**
    （String/method キーの解決結果が変わらないことを全 golden で確認。prop map メモリは
    動的オブジェクトのみ 4→8byte 増、typed struct hot path は無影響→perf 確認）。
  - `ts_prop_get/set/has/has_own/delete/own_enum` を runtime に新設。
  - 中身は現在の `ts_get`/`ts_set`/`ts_has_prop`/`ts_has_own` のロジックを移植 + 統合
    （struct descriptor も get/set/has で見るよう統一）。
  - 列挙系 6 箇所を `ts_prop_own_enum` 経由に書き換え。
  - `ts_get`/`ts_set` は別名化。**この段階で既存 golden/CI/perf が全部緑**であることを確認。
  - **PIC 土台**: `ts_object` に shape スロット 1 ワードを予約済み（A-1 完了）。
  - 期待: フィールド初期化子バグ以外の挙動は完全不変。struct field も get/has で見えるように
    なるので `class_has_field` 個別パッチを撤去できる。

- **段階 B（最適化条件の厳密化）**
  - `LoadField`/`StoreField` の typed path 発火を §3.3 の 3 条件に厳密化。
  - `enumerated_classes` 機構を撤去（`compute_enumerated_classes` と `retain` を削除）。
  - 列挙系が正準パス経由で struct field を見るので、列挙されるクラスも struct のままで可。
  - **perf 厳守**: typed_field/obj kernel が悪化しないこと。むしろ enumerated 抑制が
    減るので一部改善の可能性。悪化したら条件を調整。

- **段階 C（escape ルール一元化）**
  - `op_forces_materialization` を導入し、interproc.rs の個別 escape 追記を置換。
  - 既存の escape 挙動と**完全一致**することを golden で確認（特に Print/in/+/console.dir）。

- **段階 D（クリーンアップ）**
  - `class_has_field` / `class_reg_field_*` のうち正準パスに吸収されたものを削除/整理。
  - well-known symbol を文字列偽装 `@@iterator` から `TS_KEY_WKSYM` 予約 id へ移行（§3.6）。
    挙動不変（同じイテレータが見つかる）を golden で確認。
  - ドキュメント更新、TODO 反映。

- **段階 C0（即時健全化・Symbol の黙る誤動作を loud reject）**: 段階順とは独立に**先行**で
  実施可。§3.6（C）の 3 点（`o[Symbol.iterator]=fn` の空出力誤動作 / generator
  `*[Symbol.iterator]` の runtime 失敗 / `Symbol(...)` 等の未定義呼び出し）を
  loud reject 化。「黙って間違えない」原則の即時適用。negative test 追加。

- **段階 E（フィールド初期化子・§3.5）**
  - class-extract に初期化子リスト収集を追加。`new`/ctor lowering を案 A で統一。
  - 段階 A〜D で正準パスが固まっているので、初期化子の書き込みはその経路に自然に乗る。
  - golden 追加（初期化子のみ / 継承 / ctor 併存 / this 参照）。V8 比較必須。

各段階後: ci_fast + 3 bench shard（個別）+ ASan + 代表 V8 比較。zip + 新鮮抽出検証。

---

## 5. リスクと緩和

- **R1 perf 回帰**: 最大リスク。段階 B で typed path が誤って狭まると kernel が遅くなる。
  緩和: 各段階で perf bench 必須。発火条件は「現状 struct 化されているケースを最低限維持」
  を下限に調整。typed_field は §3.3 の 3 条件を**確実に**満たすので直読み継続。
- **R2 振る舞い回帰**: get/set/列挙の統合でエッジケース（accessor + 継承 + 数値 field）が
  壊れる。緩和: 段階 A は「振る舞い不変リファクタ」と位置づけ、既存 golden 全緑を gate に。
- **R3 二重格納の罠**: 「struct field を prop map のキャッシュ」と説明したが、実際に両方に
  メモリを持つと遅い。緩和: 段階 A では prop map を**追加せず**、正準パスが struct を
  descriptor 経由で読む（現状の class_reg_field_value を get/has/enum で共用）。prop map と
  struct の二重持ちは**しない**。将来 PIC で shape を導入するときに再検討（§6）。
- **R4 GC**: 列挙コールバック中の GC で base ポインタが動く。緩和: 既存実装同様
  各 push 後に `ts_ptr(obj)` を再取得するパターンを正準パスに集約。
- **R5 スコープ膨張**: 8000 行に触れる誘惑。緩和: 段階を厳守し、フィールド初期化子バグや
  PIC は本タスクに含めない。

---

## 6. PIC への接続とデータ構造の事前確定（設計ミスが響く箇所）

PIC（polymorphic inline cache）の本質: `obj.x` の実行時に観測した **shape → offset** を
コールサイト近傍にキャッシュし、次回同 shape なら分岐 1〜数個で直アクセス。本再設計の
`ts_prop_get/set` がその挿入点。今の「コンパイル時に struct か prop map か決め打ち」構造の
上には載らない。以下、**今のうちに確定しておくべきデータ構造**を定義する（実装は別タスクだが、
本再設計の runtime/IR がこれと矛盾しないことを保証する）。

### 6.1 Shape（hidden class）— オブジェクトの形

すべてのオブジェクトに「shape id」を持たせる。shape は「キー集合 + 各キーの
種別(data/accessor) + データの格納場所(struct offset or prop slot)」を表す不変記述子。

```
typedef uint32_t ts_shape_id;          // 0 = "no shape" (legacy/dynamic) を予約

typedef struct {
  ts_key   key;                        // 統一キー（§3.6: field/method/wksym/user-symbol を含む不透明 32bit）
  uint16_t kind;                       // 0=data-in-struct, 1=data-in-propmap, 2=accessor
  uint16_t slot;                       // kind=0: struct field index / kind=1: prop slot 予約
  uint32_t offset;                     // kind=0: struct 内バイトオフセット（unbox 判定込み）
} ts_shape_field;

typedef struct ts_shape {
  ts_shape_id   id;
  uint32_t      nfields;
  ts_shape_field* fields;              // 宣言順（列挙順 = JS の挿入順）
  struct ts_shape* parent;             // 1 フィールド追加前の shape（遷移の親）
  /* transition: key 追加で生成される子 shape のキャッシュ（小さな線形 or ハッシュ） */
  uint32_t      ntrans; ts_shape_trans* trans;
  uint8_t       numeric_mask_or_flags; // 将来拡張（例: frozen, has-accessor）
} ts_shape;

typedef struct { uint32_t key; ts_shape* to; } ts_shape_trans;
```

- **stable な class** は構築時に固定 shape を 1 つ持つ（= 現在の class descriptor を
  shape に格上げしたもの。`ts_class_field` がほぼそのまま `ts_shape_field` になる）。
- **動的オブジェクト**（`{}`/`obj.x=...` で形が育つ）は、空 shape から始まり、キー追加ごとに
  `trans` をたどって（無ければ生成して）子 shape へ遷移する。同じ順序で同じキーを足した
  オブジェクトは**同一 shape を共有**する（hidden-class の肝）。
- `ts_object` に `ts_shape* shape`（または `ts_shape_id`）フィールドを 1 つ追加する。
  → **本再設計の段階 A で、この 1 ワードを今のうちに `ts_object` に予約しておく**
  （未使用でも構造体に置く）。後から構造体レイアウトを変えると全 struct クラスの
  offset 計算に波及するため、**ここが「設計ミスが響く」最重要ポイント**。

### 6.2 Inline cache（コールサイト側）

各プロパティアクセスサイト（`LoadField`/`StoreField` codegen）に小さな IC を持たせる:

```
typedef struct {
  ts_shape_id shape;     // 観測した shape（0 = empty/未観測）
  uint32_t    offset;    // そのとき有効な struct offset（data-in-struct のみ）
  uint8_t     kind;      // hit 時の高速経路種別
} ts_ic_entry;

/* 単相: ts_ic_entry を 1 個。多相: 小さな配列（N=4 程度）+ あふれたら megamorphic。 */
```

codegen が emit する形（概念）:
```
if (LIKELY(obj->shape->id == IC.shape)) {  v = ((Class*)obj)->@(IC.offset);  }   // monomorphic hit
else { v = ts_prop_get_ic(obj, key, &IC); }                                       // miss -> 正準 + IC 更新
```
- `ts_prop_get_ic` は §3.2 の正準 `ts_prop_get` に「miss 時の IC 充填」を足したもの。
- 段階 B の「静的に証明できるとき直読み」は、この **monomorphic hit を静的に確定できた
  特殊ケース**。PIC はそれを「実行時に観測して確定」へ一般化する。**設計は完全に地続き**。

### 6.3 本再設計がこの土台と矛盾しないための制約（今守ること）

1. `ts_object` に shape スロット 1 ワードを**段階 A で予約**（未使用可）。レイアウト後方互換を確保。
2. class descriptor（`ts_class_field`）の構造を §6.1 `ts_shape_field` に**素直に拡張できる
   形**に保つ（key/kind/offset を持つ）。今回 named struct 化する `ts_class_reg` を将来
   `ts_shape` に発展させられるようにする。
3. 正準パス `ts_prop_*` のシグネチャは PIC 版（`*_ic`）を後付けできるよう、key を
   `uint32_t`（internField 空間）で統一（既に統一済み）。
4. 列挙順 = 挿入順（shape の fields 順）を正準パスで保証 → PIC 後も列挙が安定。

順序: 本再設計（shape スロット予約まで）→（別タスク）shape 遷移 + IC 実装。

---

## 7. 合意事項（Kaz の回答を反映済み）

1. ✅ 「フィールドの正準は統一操作、struct は証明可能時の直読み最適化」（§3.1, §3.3）。
2. ✅ 段階 A〜E の順序、各段階「振る舞い不変 + 全 CI 緑」を gate に。
3. ✅ `enumerated_classes` 撤去（§3.3, 段階 B）。
4. ✅ **フィールド初期化子バグは本タスクに取り込む**（§3.5, 段階 E。プロパティ処理と密接）。
   PIC 本体は別タスクだが、**データ構造（shape / IC）は本設計で確定し、段階 A で
   `ts_object` に shape スロット 1 ワードを予約**して土台を用意する（§6）。
5. ✅ perf 下限は**これまでと同レベル**: typed_field ~185-190ms / obj ~205-210ms /
   int ~390-400ms / float ~250ms / その他現状値を上限とする。各段階で回帰ゼロを死守。

### 残る確認（実装中に判断、合意あれば先に）
- §7-6: フィールド初期化子の lowering は**案 A**（明示 ctor 先頭 / 暗黙 ctor 合成）で進める。
  異論あれば変更。

### Symbol / キー空間の扱い（合意済み: V8 流 tagged key + I-B）
- 現状: ランタイムに Symbol 表現なし。`[Symbol.iterator]` をクラスメソッドで構文マッチし
  文字列 `@@iterator` に偽装するのみ。`Symbol()`/`o[sym]`/generator `*[Symbol.iterator]` は
  未実装/黙って誤動作。**加えてプレーンオブジェクトの数値キー `o[0]=v` が配列経路に誤誘導され
  壊れる**、`c["x"]=v` が struct field と二重化する穴も実証済み（§3.6）。
- 決定（Kaz の V8 調査を反映）: キーは「単一空間のレンジ分割」を撤回し、**V8 流 tagged key**
  に確定。3 種直交（Index / String / Symbol）+ WKSYM 予約、物理 64bit `ts_key`、各 id 空間
  独立で食い合わない。これが「32bit で足りるか」への構造的回答（空間を分離するから足りる）。
- **構造体最適化との両立は確認済み**（§3.6）: struct に落ちるのは String key 静的サイトのみで
  IR 上既に分離。発火条件に「key が String」を 1 つ足すだけ。Symbol/Index は正準パスへ。
  shape も `ts_key` で 3 種を区別保持 → PIC と整合（V8 の elements/named 分離と同型）。
- プレーンオブジェクトの数値キーは **案 I-B**（prop map で扱う、配列の elements 高速路は別維持。
  「プレーンオブジェクトを配列扱いする需要はない＝遅くてよい」で合意）。
- 実装は別タスク（ユーザ Symbol 採番・`typeof`・`Symbol.for`・private symbol）。本設計が
  「そのとき `ts_prop_*`/shape/struct 最適化を作り直さない」ことを保証。即時 loud reject（C0）は先行。

---

## 8. 付録: ベンチ実行の高速化（別件・対応済み）

`scripts/run_benchmarks.sh` が各ベンチで `ts_rt.c`（~2100 行）を毎回 `-O2` 再コンパイル
していた（60+ 回）。サンドボックスは **シングルコア（nproc=1）** のため並列化は無効
（コンテキストスイッチで悪化しうる）。代わりに **`ts_rt.c` をループ前に 1 度だけ
`ts_rt.o` にコンパイルし、各ベンチはそれをリンク**するよう変更。correct1 シャードが
~130-200s → ~65s に短縮（測定済み、correctness/perf 不変）。本再設計の各段階検証が速くなる。


---

## 9. 実装進捗

- **段階 A-1 (shape スロット予約) — DONE**: `ts_object` に `uint32_t shape`（§6）を追加。
  gc_alloc は calloc で 0 初期化、ts_new_sized 経由のヒープ struct も 0、stack alloc 経路
  （emit_c.rs sobj）に `shape=0` 明示初期化を追加。offsetof ベースなので struct クラスの
  field offset は自動再計算され影響なし。全 CI 緑、perf 中立（typed_field 181ms, obj 203ms,
  int 380ms — 退行なし）。ベンチは ts_rt.o 共有化で correct1 が ~65s に短縮済み（§8）。
- 次: 段階 A-2（正準パス ts_prop_* 新設・列挙系の統一）。

- **段階 A-2a (キー種別判定の述語集約) — DONE**: runtime に `ts_key_is_method` /
  `ts_key_is_enumerable_field` を新設し、散在していた `key >= TS_METHOD_KEY_BASE` 比較
  (field_enumerable / copy_props / object_rest の 3 箇所) をこれ経由に集約。キー空間の
  レンジ知識が 1 箇所に閉じ、将来の tagged-key 化（Index/String/Symbol、64bit）で触る場所が
  限定される。型は uint32_t のまま・**振る舞い完全不変**（列挙系 golden を JS ref と直接比較で
  一致確認、ci_fast 緑、perf 中立 typed_field 182ms / obj 203ms）。
  併せて run_golden_iter.sh を ts_rt.o 共有化（golden 全 40 件が ~83s で完走、以前はタイムアウト）。
- 次: A-2b（`ts_prop_get/set/has/has_own/own_enum` 正準パス新設・列挙系を統一）、
  A-2c（`ts_prop.key` を 64bit `ts_key` 化・tagged tag 導入・Index/Symbol/WKSYM 予約）。

- **段階 A-2b-1 (正準 get/set が struct field を見る) — DONE**: ts_get/ts_set に
  class_field_lookup/struct_field_get/struct_field_set を追加し、key が typed class
  instance の struct field なら offset 直読み/直書きするよう統一（最適化された struct store と
  動的 prop map store の橋渡し）。併せて interproc.rs の LoadFieldDynamic/StoreFieldDynamic が
  obj をエスケープするよう修正（動的キーアクセスは実体を要求）。
  → 現状の 2 バグを解消: `c["x"]=v`（動的 string が struct field と二重化）と、動的アクセスが
  唯一の用途のときオブジェクトが SROA で消えて undefined 化、の両方を V8 一致に（dbl/dr テスト）。
  全 CI 緑（runtime/golden40/ci_fast/correct1/correct2）。perf: typed_field 186ms、
  obj_kernel ~218ms（hot loop は完全 SROA 維持、機械語不変＝単核の測定変動。予算 290 内）。
- 次: A-2b-2（列挙系 6 箇所を ts_prop_own_enum に統一、class_has_field 個別パッチ撤去）、
  A-2c（ts_prop.key を 64bit ts_key 化・tag 導入）。

- **段階 A-2b-2 (列挙系の単一化) — DONE**: 単一の正準列挙関数
  `ts_prop_own_enum(obj, cb, ud)` を新設（struct field を宣言順 → prop map data props を
  挿入順で訪問、GC 安全に obj を再解決、caller が root 責任）。8 つの列挙箇所
  （Object.keys/values/entries, JSON.stringify, console inspect, Object.assign, object spread,
  object rest）をすべてこれ経由のコールバックに書き換え。散在していた「struct descriptor +
  prop map を二重に手書きで歩く」コードが 1 箇所に集約され、`class_has_field` 個別パッチや
  inspect の class-instance/plain-object 二重分岐を撤去。
  → 全 CI 緑（runtime/golden40/ci_fast/correct1/correct2）、perf 中立（typed_field 181ms,
  obj_kernel 202ms）。plain object + class instance の keys/values/entries/JSON/assign/spread/
  rest/inspect すべて V8 一致を確認。
  既知の軽微な非対応（A-2b-2 とは無関係・元から）: console.log(classInstance) が V8 の
  `ClassName { ... }` に対し `{ ... }`（クラス名プレフィックス未表示）。別途対応。
- 次: A-2c（ts_prop.key を 64bit ts_key 化・tag 導入・Index/Symbol/WKSYM 予約）。

- **段階 A-2c-1 (ts_key 抽象と tag の導入・METHOD_KEY_BASE 一元化) — DONE**: ts_rt.h に
  `ts_key`(uint32_t)型・`enum ts_key_tag{STRING/SYMBOL/INDEX/WKSYM}`・`TS_METHOD_KEY_BASE`・
  `TS_KEY_METHOD(id)` マクロを定義（単一ソース）。runtime/emit_c.rs の METHOD_KEY_BASE 二重定義を
  解消し、emit は `1000000u + id` の直書きをやめ `TS_KEY_METHOD(id)` を出力。runtime の key 系
  シグネチャ（ts_get/ts_set/has/has_own/delete/define_accessor/find_slot/class_field_lookup 等）を
  uint32_t→ts_key に統一。STRING tag は現状値そのままなので**振る舞い完全不変**
  （TS_KEY_METHOD(id)=1000000+id と値同一）。全 CI 緑、perf 中立（typed_field 182ms, obj 209ms）。
  Symbol/Index/WKSYM tag は予約（未使用）。物理 64bit 化は Symbol/Index 実装時に prop.key を
  広げる別ステップ（A-2c-2）に分離（今 64bit にしてもメモリ増のみで利得ゼロのため）。

### 発見した既存バグ（A-2c とは無関係・要修正）
- `const c = new C(); c.x`（同一関数内で構築直後にフィールド読み）が **NaN/undefined**。
  原因: LoadField が local_class 不明（Copy 経由で class が伝播していない）→ ts_get に
  フォールバック。一方その唯一の用途だとオブジェクトが SROA で消去され、ts_get(undefined) に
  なる。明示 ctor 付きでも発生。golden は this.field（メソッド内）や for-of 経由なのでこの
  経路を踏まず、すり抜けていた。
  → 段階 B（struct 直読みの発火条件厳密化＝local_class を Copy で伝播 + 証明不能時のみ正準パス）
  および段階 C（LoadField フォールバック時に obj をエスケープ）で塞ぐ。または local_class が
  Copy/Phi を追うよう collect_local_class を拡張。フィールド初期化子バグ（段階 E）とも近い。

- **段階 B (struct 最適化の厳密化・enumerated_classes 撤去) — DONE**
  - **enumerated_classes 撤去**: 実は A-2b で列挙が ts_prop_own_enum（descriptor-aware）に
    統一された時点で enumerated_classes は空集合に無効化され compute_* は dead code 化していた。
    本段階で完全撤去: compute_enumerated_classes 関数削除、emit_class_layout/descriptors/
    field_chain/emit_function から enumerated パラメータの引き回しを除去、local_class.retain の
    no-op を削除。列挙されるクラスも struct 最適化されるようになり（JSON/keys/spread が正準パス
    経由で struct field を見る）、最適化を諦める逃げ道が消えた。
  - **struct 直読み条件の厳密化**: 新ヘルパー `struct_direct_offset(c, field, classes)` を導入し、
    LoadField/StoreField の `->fN` 直アクセスを「class 既知 + **stable** + field が struct slot に
    解決」のときのみ発火。unstable クラスは正準パス（ts_get/ts_set、A-2b で struct field を
    descriptor 経由で読む）にフォールバック。発火条件が 1 箇所に集約され、§3.3 の設計通りに。
  - 検証: 全 CI 緑（runtime/golden40/ci_fast/correct1/correct2）。perf 中立（typed_field 187ms,
    obj_kernel 204-221ms＝測定変動、inherit 82ms — hot class はすべて stable なので struct 直読み
    維持、退行なし）。enmig（JSON/keys に流れるクラスが struct 最適化される）も V8 一致。

### 【訂正】A-2c で「発見した」とした local_class バグは実在せず
  A-2c 記録の「const c = new C(); c.x が NaN」は**スタールな analyzer バイナリのアーティファクト**
  だった。クリーンビルドで再検証した結果、SROA は copy-alias 解決込みで正しく動作し、明示 ctor
  付きの `new C().x` / method 併用は全て V8 一致（m2=hi 1, m3=1）。残る `0`/NaN は**フィールド
  初期化子のみ（ctor なし）の既知バグ（段階 E）**だけ。段階 B で local_class の修正は不要だった
  （collect_local_class は元から Copy を伝播、SROA も alias を解決していた）。誠実な訂正として記録。

- **段階 C (SROA escape の単一ルール化) — DONE**: interproc.rs に散在していた
  「materialization escape」（`C::Copy(Ref::Global, ..)` を症状ごとに追記）を、単一の分類関数
  `op_forces_materialization(inst) -> Vec<LocalId>` に一元化。これは「ランタイムが実体（heap
  object）を読む経路にオブジェクトを渡す操作」のオペランドを返す: Print（inspect）/ BinOp"+"
  （toString 強制）/ HasField・HasFieldDynamic（in・hasOwn の構造走査）/ LoadFieldDynamic・
  StoreFieldDynamic（動的キーアクセス）/ ObjectCopyProps（spread 列挙）/ StoreProtoMethod・
  SetProto（proto 操作）/ Yield・Await（コルーチン境界）/ Throw・StoreGlobal（外部流出）。
  build_constraints のループ先頭で 1 回呼び、各 arm からは redundant な Copy(Global,..) を削除し
  構造的制約（dst External / Store エイリアス）だけ残した。新しい「実体を要求する op」を足すときは
  この関数に 1 arm 追加するだけ（散在追記が不要に）。§3.4 完了。
  検証: escape 依存の全ケース（Print/+/in/動的アクセス/spread）が V8 一致、全 CI 緑、perf 中立
  （typed_field 187ms, obj 206ms, inherit 82ms — SROA 判定不変を確認）。振る舞い完全不変の
  リファクタ。

### 段階の残り
- 段階 D: クリーンアップ（class_has_field 等の死蔵コード整理）、@@iterator → WKSYM 移行。
- 段階 E: フィールド初期化子バグ（ctor なしクラスの初期化子未実行）。段階 B の訂正により、
  これが残る唯一の正当な未修正バグと確定。
- 段階 C0: Symbol の黙る誤動作を loud reject（独立・任意のタイミングで可）。

- **段階 E (フィールド初期化子バグ修正) — DONE**: `class C { a = <expr> }` の初期化子が new 時に
  実行されず c.a が NaN/undefined になる既存バグを修正（§3.5 案A）。
  実装: exporter に `emitFieldInitializers`（クラスの own field 初期化子を宣言順に StoreField で
  emit、this を対象オブジェクトに束縛し `y = this.x + 5` のような this 参照も解決）と
  `emitImplicitConstruction`（ctor なしクラス用: 親 ctor に args を渡してチェーン後、own 初期化子を
  実行＝暗黙の default ctor 相当）を追加。明示 ctor を持つクラスは lowerFunctionLike の 3c で
  ctor 本体先頭に初期化子を注入（param-property の 3b の直後）。これにより super() → 親 ctor →
  親初期化子 が正しく連鎖。
  検証（すべて V8 一致）: フラット（a=1,b=2）/ this 参照初期化子（y=this.x+5）/ 初期化子+明示ctor /
  初期化子→ctor変異（二重化なし）/ param-property併用 / 継承（Base 初期化子が super 経由で実行、
  Derived/ctorなし派生 D2）。golden `field_init` 追加。全 CI 緑、perf 中立（typed_field 191ms,
  obj 222ms, inherit 85ms — 予算内）。
  → これで段階 B の訂正で「残る唯一の正当な未修正バグ」とした項目が解消。

### 残り
- 段階 D: クリーンアップ（class_has_field 等の死蔵コード整理）、@@iterator → WKSYM 移行。
- 段階 C0: Symbol の黙る誤動作を loud reject（独立）。

- **段階 D (クリーンアップ + @@iterator→WKSYM 移行) — DONE**
  - **死蔵コード整理**: class_has_field を class_field_lookup へ委譲（重複していたフィールド走査
    ロジックを統合）。A-2b/B で列挙・enumerated 撤去は既に済んでいたため、残る整理はこの重複解消が
    中心。analyzer 側の 4 warnings（flatten_cf の mut fresh / SObj::Global / vtable_names / Ctx::cty）は
    本リファクタと無関係の既存死蔵コードのため触らず（スコープ外・低リスク優先）。
  - **@@iterator→WKSYM 移行**: A-2c-1 で予約した TS_K_WKSYM tag を実使用。ts_rt.h に
    TS_WKSYM_KEY_BASE(2e9) + TS_KEY_WKSYM(id) + enum ts_wksym_id（iterator=0, asyncIterator=1,
    toPrimitive=2, hasInstance=3, toStringTag=4）を定義。Program に well_known_symbols（name_id→
    wksym_id）を追加し、exporter が @@iterator/@@asyncIterator の intern id をこれに記録。codegen は
    method_key_str() で該当 name_id を TS_KEY_WKSYM(id) に変換（クラスメソッド登録・StoreProtoMethod・
    動的 method dispatch の 3 箇所を集約）。これにより well-known symbol キーが position 非依存の
    安定値になり、将来 obj[Symbol.iterator] が同一キーに解決できる土台ができた（文字列偽装の
    位置依存 intern id を脱却）。
  - 検証: 全 CI 緑（runtime/golden41/unit7/ci_fast/correct1/correct2）、perf 中立（typed_field 188ms,
    obj 206ms）。非ジェネレータ [Symbol.iterator] の for-of が WKSYM キー経由で V8 一致。test fixtures
    6 ファイルに well_known_symbols: vec![] を追加。
  - 既知の未修正（D の範囲外）: generator `*[Symbol.iterator]()` は iterator-protocol 側の別問題で
    まだ動かない（返却された generator の .next() dispatch 失敗）。WKSYM 移行とは独立。要別途。

### 残り
- 段階 C0: Symbol の黙る誤動作を loud reject（独立）。生成器 [Symbol.iterator] や obj[Symbol.x]=
  などの未対応経路を明示拒否。

- **バグ修正: generator `*[Symbol.iterator]()` の for-of — DONE**
  原因: クラスの [Symbol.iterator] が *generator method* の場合、それを呼ぶと OUR generator
  オブジェクトが返るが、for-of の lowering はそれを「カスタムイテレータ」とみなし .next() を
  プロトタイプ method dispatch（ts_get(gen, methodkey "next")）で呼んでいた。generator オブジェクトは
  next を generator.next builtin で進めるため "method id 1 not found" で abort していた。
  修正: class_extract の MethodInfo に isGenerator フラグを追加（method 宣言の asteriskToken で判定）。
  exporter に classMethodIsGenerator(classId, name) を追加し、for-of lowering で iterable の
  [Symbol.iterator]/[Symbol.asyncIterator] が generator method なら useBuiltin=true として
  generator.next / asyncgen.next builtin 経由で進めるよう分岐（throw/return も builtin 経路に乗る）。
  検証（すべて V8 一致, ASan クリーン）: 基本（yield 1..3 → 6）/ break 中断（iterator close）/
  this 参照 generator method（Pair）/ 再イテレーション（毎回新 generator）/ async generator
  *[Symbol.asyncIterator]() + for await / yield* 委譲。golden `gen_symbol_iterator` 追加（計 42）。
  全 CI 緑、perf 中立（typed_field 191ms, obj 227ms）。
  → これで段階 D で「範囲外・要別途」とした generator iterator バグが解消。

### 残り
- 段階 C0: Symbol の黙る誤動作を loud reject（独立）。obj[Symbol.x]=fn（クラス外）、
  Symbol("k")/Symbol.for() など未対応経路を明示拒否。

- **段階 C0 (Symbol 黙る誤動作の loud reject + 整数キー case I-B) — DONE**
  - **loud reject**（黙って間違える経路を明示拒否）: exporter で
    Symbol(...) / Symbol.for(...) / Symbol.keyFor(...) 呼び出し、obj[Symbol.*] の読み書き
    （クラスメソッド宣言 [Symbol.iterator]() は wellKnownMethodName 経路で別扱い・影響なし）を
    unsupported() で compile-time 拒否（従来は実行時 trap / silently 消失していた）。判定に
    isSymbolKeyExpr() を追加。tests/rejects_symbol.sh を新設し ci_fast に組み込み。
  - **整数キー case I-B（loud reject ではなく正しく実装）**: plain object の数値キー o[0]=v は
    従来 StoreIndex→ts_array_set で非配列に対し silently no-op、o[0] も undefined だった。any 型は
    配列と静的区別できず over-reject になるため拒否ではなく修正: ts_array_get/set が非配列オブジェクト
    に対し数値 i を文字列キー "i" に intern して ts_get/ts_set にフォールバック（配列は従来の高速
    element パス維持）。さらに正準列挙 ts_prop_own_enum に JS のプロパティ順序（整数インデックスキーを
    昇順で先、文字列キーを挿入順）を実装。prop_key_is_array_index() で判定、整数キーが無ければ
    （通常ケース）従来の挿入順パスに直行＝perf 影響なし。1 箇所修正で keys/values/entries/JSON/
    inspect/assign/spread/rest すべてに反映（A-2b-2 集約の恩恵）。
  - 検証（V8 一致・ASan クリーン）: Symbol 系 4 経路の reject、整数キー値（o[0..2], o["name"]）、
    JSON.stringify 順序 {"0","1","2","name"}、Object.keys/values 順序、配列高速パス維持。
    golden int_keys 追加（計 43）、negative rejects_symbol 追加。全 CI 緑、perf 中立
    （typed_field 193ms, obj 227ms）。
  - 既知の別バグ（C0 範囲外・要別途）: arr: any = [...] に対する arr.join() 等の method dispatch が
    ts_get→find_slot で ts_array を ts_object として読み heap-buffer-overflow（ASan 検出）。Symbol/
    整数キーとは無関係の「any 型配列へのメソッド dispatch」問題。別途修正要。

### 設計 §3 の実装状況
§3.1 正準パス / §3.2 列挙統一 / §3.3 struct 最適化厳密化 / §3.4 escape 一元化 / §3.5 フィールド
初期化子 / §3.6 キー空間（tag・WKSYM・整数キー I-B）— **すべて実装完了**。実害バグ（フィールド
初期化子・generator [Symbol.iterator]・整数キー silently-wrong）も解消。残るのは Symbol 値の本実装
（別タスク）と、上記 any-array method dispatch バグ。

- **整数キー設計の修正（Kaz の指摘: a["0"] vs a[0]、a[1.5] の区別）— DONE**
  指摘により C0 の整数キー実装の根本的な誤りが判明:
  (1) 旧 indexAccessKind は「キーが数値型なら無条件に number パス（配列前提の StoreIndex/LoadIndex
      → ts_array_set/get）」とし、plain object でも配列命令に lower していた。
  (2) C0 で追加した ts_array_set/get の非配列フォールバックは snprintf("%u") で整数化しており、
      a[1.5] が "1" に切り詰められ a[1.0] と衝突していた（a[1.5] の値消失・keys 不正）。
  **設計判断（Kaz の問い「整数キーを別領域に持つべきか」への結論）**: 持つべきでない。JS 仕様では
  プロパティキーは常に文字列で、a[0] と a["0"] は同一キー（0 は ToString で "0"）。V8 も意味論的には
  別領域でなく、a[0]≡a["0"]。よって「整数キーは文字列キーに ToString 正規化して一本化」が正しい。
  修正:
  - indexAccessKind: number パス（配列 element 高速路）は base が *配列と確証できるとき* (および
    string の char access) のみ。plain object / any の数値キーは string パス（StoreFieldDynamic/
    LoadFieldDynamic → ts_set_dyn/ts_get_dyn）に回す。ts_set_dyn は既に ToString 正規化済み
    （1.5→"1.5", 1.0→"1", 0→"0"）。
  - ts_get_dyn を ts_set_dyn と対称化: 非配列オブジェクトの数値キーを ToString して ts_get に委譲
    （従来は undefined を返していた）。
  - C0 で入れた ts_array_set/get の snprintf 整数化フォールバックは撤去（誤り）。整数キー先出し順序は
    ts_prop_own_enum の prop_key_is_array_index で正しく実装済み（文字列キー上で判定するので正規化後の
    "0"/"1" を正しく拾う）。
  - ついでに既存バグも修正: str[i] 文字アクセス（LoadIndex→ts_array_get が文字列非対応で undefined
    だった）を ts_array_get に文字列ケース追加（負数 wraparound なし、.at() と区別）で V8 一致に。
  検証（V8 一致・ASan クリーン）: a["0"]&a[0]→{"0":2}/keys 長1、a[1.0]/a[1.5]/a["01"] 区別→1,1.5,01、
  整数キー昇順先出し {"0","1","2","name"}、配列高速路維持、str[i] 文字アクセス。golden int_keys を
  エッジケース込みに拡充。全 CI 緑、perf 中立（typed_field 192ms, obj 227ms, int 437ms, float 149ms）。

### 既知の別バグ（今回スコープ外・要別途、いずれも純配列/int-unbox 経路で本件と無関係）
- number[] 疎配列 + unboxed-int 累算器で a[i]||0 が INT64_MIN 化（undefined 要素の int キャスト問題）。
- arr: any = [...] への arr.join() 等 method dispatch が ts_get→find_slot で ts_array を ts_object
  として読み heap-buffer-overflow（ASan 検出済）。

- **バグ修正: any 型配列/Map/Set へのメソッド dispatch の heap-buffer-overflow — DONE**
  原因: 配列/関数/Map/Set は OBJECT NaN-box selector を持つ（ts_is_obj が true）が、ts_object の
  prop-map レイアウト（->props/->len）とは異なる構造体。arr:any への arr.join() などは静的型が失われ
  動的 dispatch ts_get(arr, methodkey) に落ち、ts_get が ts_array を ts_object として読み o->props/
  o->len（実際は a->data/a->cap）を走査 → find_slot で確保領域外read（ASan 検出の heap-buffer-overflow）。
  修正: ts_get/ts_set 冒頭に `o->h.kind != TS_KIND_OBJECT なら早期 return` ガードを追加。prop-map
  レイアウトを使うのは TS_KIND_OBJECT（plain object/クラスインスタンス/proto/Date）のみで、array/func/
  map/set/promise/coro は別構造体なので prop-map 走査してはならない。これらは動的 ts_get で undefined を
  返し、呼び出し側の ts_is_callable チェックが「メソッド未発見」を loud な TypeError に変える（メモリ
  破壊ではなく安全な明示失敗）。ts_dynamic_method_missing の診断も「any 型なら具体型を付けよ」と
  actionable に改善。
  検証（ASan クリーン）: arr:any.join() / map:any.keys() が overflow せず loud-fail。型付き配列
  （number[]）のメソッドは従来通り静的 builtin で正しく動作（join/map/filter, V8 一致）。全 CI 緑、
  perf 中立（typed_field 186ms, obj 206ms）。tests/runtime_anymethod_safe.sh（ASan で overflow しない
  ことを検証）を新設し ci_fast に組込み。
  既知の制限（範囲外・別途）: any 型配列/Map/Set への *動的*メソッド呼び出しは完全対応せず loud-fail。
  完全対応には各 builtin を名前で解決する runtime prototype（callback 取る map/filter の closure 連携
  含む）が必要で中規模機能。具体型を付ければ静的 dispatch で動く（推奨・診断で誘導）。

### 設計上の既知の不正確さ（Kaz 指摘: 配列も Object.prototype を継承し prop-map を持つべき）
JS 意味論では配列/Map/Set も Object.prototype を（proto チェーン経由で）継承し、
hasOwnProperty/toString/constructor などの継承メソッドや、インスタンスへのカスタム named
プロパティ（arr.custom=99）、Object.keys へのその反映を持つ。よって本来すべての「オブジェクト」は
ts_object の prop-map レイアウト + proto を持つべき。

現状の tsaot は ts_array = {h, data, len, cap} と最小構造で prop-map も proto も持たず、配列メソッドは
静的 builtin allowlist で dispatch している。直近で入れた ts_get/ts_set の `kind != TS_KIND_OBJECT
なら早期 return` ガードは、ts_array を ts_object として読む heap-overflow を防ぐ応急措置であり、
「配列に prop-map なし」という仕様的に不正確な前提を固定化している（技術的負債）。

評価:
- メモリ安全性は確保（overflow→loud-fail、退行なし）。
- 型付き配列の主要継承メソッド（join/indexOf/includes/slice/map/filter/length/concat 等）は静的
  dispatch で V8 一致。実用上の大半をカバー。
- 未対応（loud-fail）: any 型配列の動的メソッド呼び出し、配列インスタンスへのカスタム named
  プロパティ、配列の継承メソッドの proto チェーン解決。

完全な是正（別タスク・要設計ドキュメント・高ブラスト半径）:
- ts_array を ts_object レイアウト互換にする（先頭に proto/props/pcap/plen/shape を共有、末尾に
  data/alen/acap）。影響 ~91 箇所のフィールドアクセス + 全配列 +~40B。
- V8 流の「配列は普段軽量、named プロパティ付与時のみ prop-map を確保（遅延 props=NULL 初期）」
  にすればホット配列の perf を保てる。ts_get は配列の data/length 特別扱い + 遅延 prop-map + 配列
  proto（Array.prototype builtins 登録）チェーンの順で解決。
- これにより arr.custom=99 / any 型 arr.method() / Object.keys(arr) が JS 仕様通りに。
