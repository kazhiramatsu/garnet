# オブジェクトリテラルの method / accessor メンバ — 設計ドキュメント

## 0. 目的

オブジェクトリテラル内の以下 3 形を実装する（現状 loud-reject、exporter.ts:696）:

```js
const o = {
  greet() { return this.v; },     // MethodDeclaration
  get x() { return this.v; },      // GetAccessorDeclaration
  set x(v) { this.v = v; },        // SetAccessorDeclaration
};
```

`this` は定義時のオブジェクト（`o`）にバインドする。

## 1. 現状の事実（コードで確認済み）

### 1.1 オブジェクトリテラル lowering（exporter.ts:659-699）
PropertyAssignment（`{x:1}` / `{g: fn}`）・computed key・shorthand・spread を処理し、
それ以外（Method/Get/SetAccessor）は `this.unsupported(p, "object literal member ...")`。
通常プロパティは `StoreField{obj, field: internField(name), src}` で **field-key 空間**に格納。

### 1.2 メソッド呼び出し `o.g()` の解決（exporter.ts:1170-1193 / emit_c.rs:2085-2089）
非 builtin・非クラス（any）レシーバの `o.g()` は `callee = Method{recvClass:0xffffffff,
method: internName("g")}`。codegen の dynamic path は
`ts_get(recv, TS_KEY_METHOD(internName_id))` で **method-key 空間**を引く
（`method_key_str`、emit_c.rs:737）。

### 1.3 重要な非対称（バグの根）
- `{g: fn}` は **field-key** に格納される。
- `o.g()` 呼び出しは **method-key** を引く。
- → キー空間が食い違い「method is not a function」になる（実証済み）。
- 一方 `const f = o.g; f()`（取り出して呼ぶ）は LoadField（field-key）なので動く（実証済み）。

### 1.4 V8 の意味論（実証済み・設計の指針）
```
const o = { greet(){ return 42; } };
typeof o.greet  // "function"   ← 値として取れる
o.greet()       // 42
const m=o.greet; m()  // 42       ← 取り出しても呼べる
Object.keys(o)  // ['greet']     ← 列挙される（enumerable な通常プロパティ）
```
**結論**: JS のオブジェクトリテラル method は「関数値を持つ enumerable な通常プロパティ」に
過ぎない。クラス method（prototype 上・非列挙）とは別物。method-key 空間（内部最適化）に
入れてはいけない。`o.greet`（LoadField）・`Object.keys`・JSON すべてが見える **field-key** に
格納するのが正しい。

## 2. 設計

### 2.1 格納: 通常の enumerable プロパティ（field-key）
3 形すべて、リフトしたクロージャ（or accessor）を **field-key** で格納する:
- **method** `{ greet() {} }`: クロージャをリフト（this=object, thisParam=true）し
  `StoreField{obj, field: internField("greet"), src: closure}`。= `{greet: fn}` と同じ格納。
- **get/set** `{ get x(){}, set x(v){} }`: 既存の accessor 機構（ts_define_accessor_attr、
  defineProperty で実装済み）を流用。`object.defineAccessor:<g>:<s>:<enum>:<conf>` builtin で
  `obj` に accessor を field-key 格納。**オブジェクトリテラルの accessor は enumerable**
  （V8: `Object.keys({get x(){return 1}})` → `['x']`）なので enum=1, conf=1 で定義。

### 2.2 呼び出し `o.greet()` のキー解決順（own → prototype）

**重要な訂正（V8 で確認）**: JS のプロパティ探索は own → prototype の順で、**own が
prototype を隠す**（shadowing）。
```js
class C { constructor(){ this.run = ()=>1; } run(){ return 2; } }
new C().run()   // V8: 1  ← own field が prototype method を隠す
```
現状 tsaot はこのケースで TypeError（method-key しか引かず own field を見ない）= **既存バグ**。

したがって dynamic method call のキー解決は **field-key（own）を先に、method-key
（prototype 相当）を後に**引く:
```c
tsv _mv = ts_get(recv, <FIELD_KEY(field_id)>);          // own プロパティ（field-key）優先
if (!ts_is_callable(_mv)) _mv = ts_get(recv, TS_KEY_METHOD(method_id)); // prototype method
if (!ts_is_callable(_mv)) ts_dynamic_method_missing(method_id);
```
- object-literal method / `{g: fn}` / own field の関数 → 1 回目（field-key）で hit。
- クラスインスタンスの prototype method → own になければ 2 回目（method-key）で hit。
- own field が同名 method を隠すケース → field-key 先なので V8 一致（既存バグも解消）。
- **perf 懸念**: クラスメソッド呼び出しが毎回 field-key を先に引く。own prop map が空/小
  ならコストは小さいが、hot path（obj_kernel / typed_field のメソッド呼び出し）で要計測。
  退行するなら「devirt で静的にクラスメソッドと確定できる呼び出しは従来の単一 method-key
  直行を維持し、Dynamic（recvClass=0xffffffff）のみ own→proto フォールバック」に限定する
  （静的クラス確定のメソッド呼び出しは struct/vtable 直行で ts_get すら通らないはずなので、
  この限定で hot path は不変になる見込み）。まず計測。

### 2.3 name-id と field-id の橋渡し
`internName`（method 名空間）と `internField`（field 空間）は別 ID 空間で、同じ文字列でも
ID が違う。codegen の Method callee は name-id しか持たない。フォールバックで field-key を
引くには、その名前の field-id が要る。
**方針**: exporter で Method callee を作るとき、その名前の **field-id も内部 intern して
Method callee に `method_field: FieldId` を持たせる**（同じ文字列を internField で引く）。
codegen は `TS_KEY_METHOD(method_id)` で外して `<field_id>` でフォールバック。
- IR の `CalleeRef::Method` に `method_field: Option<FieldId>` を追加（後方互換: 既存は None）。
- exporter の Method callee 生成 2 箇所（1176-1192）で `internField(name)` も呼んで設定。
- escape/devirt は素通り（callee の付加情報、オペランド数不変）。

### 2.4 リフト機構（this バインド）
defineProperty の method-shorthand 実装（lowerDefineOneProperty / assignIds / free-var
seeding）で確立済みのものを流用:
- assignIds（exporter.ts:368）: object-literal 内 `MethodDeclaration name=="get"||"set"` に
  fnId 付与済み。これを **全 MethodDeclaration / GetAccessor / SetAccessor**（object-literal の
  メンバ）に拡張する。
- free-var seeding walk（4078 付近）: 同上、object-literal の method/accessor メンバを allFns に。
- lowerClosure(node, hint, /*thisParam*/ true): this=object としてリフト（実績あり）。

## 3. 段階

- **段階 1（method `{ g(){} }`）**: 格納（StoreField, field-key, this バインド closure）+
  呼び出しフォールバック（method-key→field-key）+ CalleeRef::Method.method_field 追加。
- **段階 2（get/set accessor）**: 既存 ts_define_accessor_attr を流用、enumerable=1 で格納。
  `o.x` 読みは ts_get の accessor 起動経路（実装済み）、`o.x=v` は ts_set の setter 経路（実装済み）。

各段階 full CI green（conf/ci_fast/unit/correct1,2/perf）。perf 中立必須（hot path 不変）。

## 4. リスク

- **method-key→field-key フォールバックの perf**: dynamic method call に ts_get 1 回追加。
  ただし hit 時（クラスインスタンス）は 1 回目で返るので追加コストなし。miss 時のみ 2 回目。
  hot path（クラスメソッド）は不変。obj_kernel で確認。
- **enumerable**: object-literal method/accessor は列挙される（V8 準拠）。class method は非列挙
  （prototype）。両者で振る舞いが違うのは正しい。
- **既存 `{g: fn}` プロパティ**: 2.2 のフォールバックで初めて `o.g()` が動くようになる（副次的改善）。

## 5. 実装結果（DONE）

### 段階 1（method `{ g(){} }`）+ 段階 2（accessor `{ get/set }`）両方 DONE。

- **格納（exporter, object literal lowering）**: 設計どおり通常プロパティとして格納。
  - method-shorthand `{ greet() {} }`: `lowerClosure(this=object)` でリフトし
    `StoreField{field: internField(name)}`（field-key）。= `{greet: fn}` と同一格納。
  - accessor `{ get x(){}, set x(v){} }`: 名前ごとに get/set を**事前ペアリング**して単一の
    `object.defineAccessor:<g>:<s>:1:1` builtin で定義（enumerable=1, configurable=1。V8 の
    object-literal accessor は列挙される）。2 つの AST メンバ（get と set）を 1 プロパティに
    集約することで「後勝ち上書きで getter が消える」破綻を回避。
- **呼び出し（emit_c, dynamic method dispatch）**: own→prototype 順に修正。
  - `CalleeRef::Method` に `method_field: Option<FieldId>`（同名の field-key）を追加。
  - dynamic method call は `ts_get(recv, field_key)`（own）を先に引き、callable でなければ
    `ts_get(recv, TS_KEY_METHOD(method_id))`（prototype）にフォールバック。helper
    `emit_method_value_lookup`。devirt の Dynamic 経路で method_field を保存。
  - これにより object-literal method / `{g: fn}` / own field の関数がメソッド構文で呼べる。
    クラスメソッドは devirt で Direct/struct 直行（dynamic path を通らない）なので perf 不変。
- **lift 機構**: assignIds と free-var seeding walk を object-literal の全 method/accessor
  メンバ（Method/Get/SetAccessorDeclaration、識別子・文字列名）に拡張。
- **検証 vs V8**: method(42)/this(10)/値取得・keys・call の一貫性/get(5)/get+set(7)/accessor
  enumerable(keys に出る)/`{g:fn}` 呼び出し(9)/data がメソッドを後勝ち上書き(1)。
  computed-name メソッド `{ [Symbol.iterator]() {} }` は引き続き reject（computed 名は別途）。
- perf 中立（obj_kernel 204ms, typed_field 183ms）。全 CI 緑、conf 69/69。
- stale negative test 更新: rejects_async.sh の "object-literal iterator" を
  "computed-name iterator method" に差し替え（plain method は now supported）。
- 追加 conformance: object_methods/{method_shorthand, accessors, property_function_call}.ts。

### 既知の別バグ（本タスク外・要別途対応）
調査中に発見: **サブクラスのインスタンスフィールドが親クラスの同名メソッドを shadow する**
有効な TS パターン
```ts
class Base { greet(){ return 2; } }
class Derived extends Base { greet = () => 1; }
new Derived().greet()   // V8: 1, tsaot: 2 (誤)
```
が、devirt が静的に親メソッドへ解決し（さらに定数畳み込みで body をインライン）、own field の
shadow を無視する。これは devirt の健全性問題で、object-literal メソッドとは独立。
※ なお `class C { run; run(){} }`（同一クラスで field と method 同名）は TS 自体が
"Duplicate identifier" で弾くので非問題。サブクラス shadow のみが有効 TS で残る。
対策案（別タスク）: クラスに own field と同名の（自分 or 継承）メソッドがある場合、その
メソッド呼び出しの devirt を抑止して dynamic（own→proto フォールバック）に落とす。

## 6. devirt field-shadows-method バグ修正（DONE）

§5 で「別バグ・要別途」とした、サブクラスのインスタンスフィールドが親メソッドを shadow する
ケースを修正。
- **原因**: exporter が `recvClass !== undefined && classHasMethod(recvClass, name)` で静的
  Method callee を作り、devirt が prototype メソッドへ Direct 解決 → own field の shadow を無視。
- **修正**: `classHasField(classId, name)`（クラス chain を歩いて instance field 名を検索）を新設。
  メソッド呼び出しの callee 決定で、**同名の instance field がある場合は静的 devirt を抑止**し、
  dynamic 経路（recvClass=0xffffffff）に落とす。dynamic 経路は §2.2 の own(field-key)→
  prototype(method-key) フォールバックなので、shadow する field を先に見つけて正しく呼ぶ。
  prototype メソッドは method-key に登録済みなので、shadow が無い継承メソッドは 2 段目で hit。
- **検証 vs V8**: `class D extends B { greet = ()=>1 }` over `B { greet(){return 2} }` → 1（修正前 2）、
  field shadows inherited method → 20、shadow 無し継承メソッド → 2（regression なし）、
  通常クラスメソッド → 3（regression なし）。
- perf 中立（obj_kernel 205ms, typed_field 182ms, inherit_sroa 82ms）。同名 field/method を持つ
  クラスのみ dynamic 経路（稀）なので hot path 不変。全 CI 緑、conf 70/70。
- 追加 conformance: object_methods/field_shadows_method.ts。
