# `export` の値共有 — ModuleEnvironment と Ref 型による設計(ESM 専用)

`module_linkage.md` の追補。**tsaot は ESM のみをサポートする。** CommonJS
(`require` / `module.exports` / `exports.x`) は v1/v2 を通じて loud reject。
本書では ESM の import/export の値共有を、ModuleEnvironment と Ref 型で表現
する設計を定める。実装はしない。データ構造と Inst レベルまで設計する。

## 0. なぜ ESM のみか

CJS と ESM は表面的に似て非なるもので、両方サポートすると複雑性が倍になる:

- **live binding の有無**: ESM の `export let x` は importer 側から live に
  見える。CJS の `module.exports.x` はプロパティ読み(`require` 後の
  destructure は snapshot)。意味論が根本から違う。
- **export 形の決定タイミング**: ESM は構文的に静的(`export` 宣言で確定)。
  CJS は `module.exports` への代入を実行して初めて決まる(動的)。tsaot の
  型駆動・静的解析の方針には ESM が圧倒的に合う。
- **require の実行モデル**: CJS は同期実行 + キャッシュ + 循環時の部分初期化
  という独自の実行モデルを持つ。ESM は静的リンク + postorder init。
- **TypeScript の実態**: `.ts` の現代コードは圧倒的に ESM。`module.exports`
  を手書きする `.ts` は稀。

したがって tsaot は **ESM 単一モジュールモデル** を採用し、CJS 構文
(`require()`, `module.exports`, `exports.x`, `import x = require()`,
`export =`) はすべて明示的に loud reject する。

V8 リファレンスとの整合性: 単一ファイルで import の無いコードは CJS でも
ESM でも transpile 結果が同一(検証済み)。よって既存の V8 オラクル
(transpileModule)はそのまま有効。将来 import を含むテストを追加する際は
オラクルを ESM (`module: ESNext`) に切り替える。

---

## 1. 前案の何が誤りだったか

前案: ESM の `export let x = 0` を tsaot の `GLOBALS[i]` に置く。

問題:
- **名前衝突**: モジュール A の `export let x` とモジュール B の `export let x`
  が「グローバル」を共有してしまう。別 i を振っても、それは
  GlobalEnvironment ではなく「モジュールローカルな名前付きスロット」であって
  `GLOBALS[]` の誤用。
- **`globalThis` との混線**: ESM の `export let x` は `globalThis` に乗らない
  のが spec。`GLOBALS[]` に置くと将来 `globalThis.x` を実装したとき分離困難。
- **概念の混乱**: spec の `GlobalEnvironment` と `ModuleEnvironment` は別の
  Environment Record。tsaot は両者を別に表現すべき。

正しいモデル:
- 各モジュールは自分の `ModuleEnvironment` を持つ
- `ModuleEnvironment` の中に `let`/`const`/`var`/`function`/`class` の binding
- `import { x } from "./B"` で得られる main の `x` binding は、**B モジュールの
  `x` binding を指す参照**
- 「参照」は **生ポインタではなく Ref 型**(振る舞いが変わるため)

`GLOBALS[]` / `LoadGlobal` / `StoreGlobal` は **真のグローバル**(`globalThis.x`
への書き込み、ホスト注入グローバル)のための infrastructure として残す。
export の値共有には使わない。

---

## 2. Ref 型の必要性

「Ref 型」を入れる動機を spec の挙動で説明する。

### 2.1 振る舞いが違うケース

**(a) 同じモジュール内のローカル変数**

```ts
let x = 0;
function read() { return x; }
function bump() { x++; }
```

ローカル `x` への read/write は普通の slot 読み書き。`x` が closure に capture
されると `ts_object` セルになる(tsaot の現状の機構)。

**(b) ESM の export**

```ts
// counter.mjs
export let x = 0;
```

```ts
// main.mjs
import { x } from "./counter.mjs";
x;                    // OK: live read(counter.mjs の x の現在値)
x = 1;                // ERROR: assignment to constant variable(静的に弾く)
```

importer 側で **read は許可、write は静的にエラー**。「他モジュールの slot を
指すポインタ」だけでは表現できない。**書き込み時の振る舞いが違う**。

**(c) namespace import**

```ts
import * as ns from "./counter.mjs";
ns.x;                 // live read
ns.x = 1;             // TypeError(実行時、frozen object 由来)
```

`ns` 自体は frozen object。`ns.x` の読みは getter 経由で live。書きは frozen
で TypeError。**namespace の各プロパティが live binding を指す**。

### 2.2 つまり

「他の変数への参照」は 2 つの異なる振る舞いを持つ(CJS を切ったので 2 つ):

| 形式 | read | write |
|---|---|---|
| ローカル変数(セル) | slot 読み | slot 書き |
| ESM import の binding | export 元の live | 静的エラー(コンパイル時拒否) |

これらを全部「セルへのポインタ」で表現すると、書き込みの振る舞いの違い
(slot 書きか静的エラーか)が消える。**Ref 型として区別する** ことで lowering
と verifier が正しく判定できる。

---

## 3. 新しい IR 概念

### 3.1 `Binding` の拡張

既存の `Binding` 構造体 (`escape_ir.rs:319` 付近) に kind を加える:

```rust
pub struct Binding {
    pub id: BindingId,
    pub name: String,
    pub decl_kind: DeclKind,   // 既存: Var/Let/Const/Param/FunctionDecl/ClassDecl/CatchParam/Import/Builtin
    pub scope: ScopeId,
    pub type_id: TypeId,
    pub mutable: bool,
    pub tdz: bool,
    pub binding_kind: BindingKind,  // NEW: 値表現の種別
    // ...
}

pub enum BindingKind {
    /// 通常のローカル変数。値はその function frame に格納、closure 経由で
    /// capture されるとセル化される。今までの全ての binding はこれ。
    Local,

    /// このモジュールが export している binding(let/var/const)。
    /// 実体はセルで、Local と同じ読み書き。ただし is_exported = true で
    /// GC root 化され、他モジュールから ImportRef で参照される。
    LocalExport,

    /// 他 ESM モジュールから import した live binding への参照。
    /// 読み: 指し先の現在値を返す(LoadImport opcode)。
    /// 書き: コンパイル時エラー(exporter が loud reject)。
    ImportRef {
        from_module: ModuleId,
        from_binding: BindingId,
    },
}
```

CJS 用のバリアント(`CjsModuleExports` / `CjsImport`)は **入れない**。

### 3.2 `RefKind` の拡張(値分類)

既存の `RefKind` (`exporter.ts:23`):

```ts
type RefKind = "reference" | "primitive" | "unknown";
```

に **ref-to-other-binding** の概念を足す:

```ts
type RefKind =
  | "primitive"      // 既存: unboxed scalar
  | "reference"      // 既存: boxed reference (ts_object 値)
  | "unknown"        // 既存: type-erased / any
  | "import_ref";    // NEW: ImportRef binding の値表現
```

`import_ref` は実行時には「指し先の cell」を持つ。read 時に LoadImport で
間接化される。write は IR 生成時に拒否。

### 3.3 新 Inst 群

```rust
/// Read through an import ref. `src` is a local whose binding is an
/// ImportRef. Codegen: ts_get(src, FIELD_VALUE) — cell read。
/// verifier は「モジュール境界を越える読み」と認識する。
LoadImport { dst: LocalId, src: LocalId },

/// Materialize a namespace object for `import * as ns from "./B"`.
/// `module` は対象モジュール id。結果は frozen object で、各プロパティが
/// 対応する ImportRef を読む getter。
AllocNamespace { dst: LocalId, module: ModuleId, site: SiteId },
```

ImportRef への write opcode は **存在しない**。exporter が IR 生成段階で loud
reject する。verifier は「ImportRef binding を src とする store は IR に
あってはならない」を保証する。

### 3.4 ModuleInfo

```rust
pub struct ModuleInfo {
    pub id: ModuleId,
    pub name: String,          // canonical path, e.g. "./counter"
    pub init_fn: FunctionId,   // この module の __module_init_<N>
    pub exports: Vec<ExportEntry>,
    pub imports: Vec<ImportEntry>,
}

pub struct ExportEntry {
    pub name: String,          // public な名前(`export { foo as bar }` の bar)
    pub binding: BindingId,    // このモジュール内の binding(LocalExport)
    pub kind: ExportKind,      // Value | Function | Class | Default
}

pub struct ImportEntry {
    pub local: BindingId,      // このモジュール内の ImportRef binding
    pub from_module: ModuleId, // 指し先のモジュール
    pub from_binding: BindingId, // 指し先のモジュール内の binding(LocalExport)
}

pub enum ExportKind { Value, Function, Class, Default }
```

`ModuleKind` enum は不要(ESM only)。

---

## 4. ランタイム表現

### 4.1 LocalExport binding

実装上は **既存のセル機構そのまま**。`__module_init_<B>` のフレームで
`AllocObject` して `ts_object` を確保、`StoreField .VALUE` で初期化、GC root
として登録(export されているので生存期間がプログラム全体)。

```c
static tsv MODULE_B_x;   // GC root, 中身は ts_object (cell)

void __module_init_B(void) {
  MODULE_B_x = ts_new_object();
  ts_gc_root(&MODULE_B_x);
  ts_set(MODULE_B_x, FIELD_VALUE, ts_num(0));  // export let x = 0
  // ...
}
```

B 内部の `x` 参照は `ts_get(MODULE_B_x, FIELD_VALUE)` と
`ts_set(MODULE_B_x, FIELD_VALUE, ...)`。既存のセル lowering と全く同じ。

### 4.2 ImportRef binding

importer A は import した時点で参照を確立:

```c
static tsv MODULE_A_x;   // ImportRef を保持する slot

void __module_init_A(void) {
  // 必須: B が先に init されている(リンカが順序保証)
  MODULE_A_x = MODULE_B_x;   // 同じ cell オブジェクトを共有
  ts_gc_root(&MODULE_A_x);
}
```

A 内部での `x` 参照は **`LoadImport` opcode**:

```c
// LoadImport dst src=MODULE_A_x → dst = MODULE_A_x.VALUE
tsv val = ts_get(MODULE_A_x, FIELD_VALUE);
```

`MODULE_A_x` 自体が cell オブジェクトを保持しているので一段間接。A 側コードで
`x = 1` のような write は **exporter が IR 生成時に loud reject**。

#### 4.2.1 「ローカル変数 ↔ ImportRef」の連続性

cell mechanism と ImportRef は **物理レイアウトが同じ**(両方とも
「`ts_object` の `.VALUE` フィールドが現在値」)。違いは:

- ローカル変数: cell を作るのも読み書きするのも同じモジュール内
- ImportRef: cell を作るのは export 元、読むのは import 側、書くのは export 元のみ

既存の cell 機構を「モジュール境界を越えて参照可能にする」だけで物理表現は
完成する。**新しいランタイム機構は不要**。新規追加は IR レベルの区別だけ。

### 4.3 関数と class の export

`export function f() {...}` の場合、`f` は再代入不可な const-like binding
(spec 上、関数宣言は immutable な binding)。

- B 側: `f` は普通の functionId、`__module_init_B` 内では fnRef value
- importer A 側: `import { f } from "./B"` は **f の static functionId を
  import**。A 側の `f(...)` 呼び出しは `Call Direct { func: B's fId }`

ImportRef を経由しない **direct reference**。理由:
- ESM の関数 binding は再代入不可なので、間接化の必要が無い
- パフォーマンス上、direct call の方が圧倒的に速い

ただし B 側で `f` がモジュール変数を capture している場合(`scope_resolution.md`
§7 の escape hatch 不適用ケース)、`f` は cell-bound closure として表現され、
import 側も cell 経由でアクセス。linker が決定する。

class も同様。`export class C` は classId による direct reference。

#### 4.3.1 統一的な見方

ESM export は 2 種類:

- **値 export**(`let`/`var`/`const`): ImportRef 経由(cell + LoadImport)
- **静的 export**(`function`/`class`): direct reference(linker が
  functionId/classId を解決)

これは spec の binding mutability に対応(`export let x` は mutable、
`export function f` は immutable)。

### 4.4 namespace import (`import * as ns from "./B"`)

`ns` は Module Namespace Object(spec §18)。性質:

- **read-only view**: 各プロパティは対応する binding の live read。`ns.x` は
  毎回 export 元の現在値を返す(getter 経由)。
- **書き込み不可**: `ns.x = 1` は実行時 TypeError(spec §18.2 の `setProperty`
  は常に false)。
- **exportNames は固定でソート済み**(spec §18.2)。`Object.keys(ns)` は
  ソートされた export 名のリスト。
- **`default` も含む**(namespace は `export *` と違い default を含む)。
- **存在しない名前は `undefined`**(throw ではない)。

```c
// AllocNamespace dst module=B site=...
tsv ns = ts_new_namespace_object(B_module_id);
//   exportNames はソート済み: ["bump", "counter", "default", ...]
//   各 own-property は getter:
//     "counter" → LoadImport from MODULE_B_counter (live, TDZ チェック付き)
//     "bump"    → B's bump as a fn value (direct)
//   [[Set]] は常に失敗(read-only)
```

namespace の各プロパティ read は §4.2 の `LoadImport` と同じ TDZ チェックを
通す(循環 import 中に未初期化 binding を namespace 経由で読むと
ReferenceError)。

最適化: namespace object の構築コストは高いので、

- `ns` を別の関数に渡したり変数に代入する場合 → AllocNamespace で実体化
- `ns.x` のように propaccess の receiver としてのみ使う場合 → AllocNamespace
  を作らず、その場で対応する LoadImport / direct reference に置換

linker の責務。

### 4.5 default export

`export default expr` は名前 `default` の export として扱う。

- `export default 42` → 名前 `default`, kind=Value, `__module_init_B` 内で評価
- `export default function f() {}` → 名前 `default`, kind=Function
- `export default class C {}` → 名前 `default`, kind=Class

importer 側: `import X from "./B"` は `import { default as X } from "./B"` と
等価。§4.2 / §4.3 と同じ機制。

### 4.6 再エクスポート

```ts
// b.mjs
export { v } from "./c.mjs";
```

B のエクスポートテーブルの `v` エントリは **c.mjs の v binding を直接指す**。
リンカが alias chain を辿って解決:

```rust
// b.mjs の ExportEntry:
ExportEntry {
  name: "v",
  binding: BindingId(c.mjs の v),  // ← c.mjs の binding を直接指す
  kind: ExportKind::Value,
}
```

importer A が `import { v } from "./B"` した場合、A の ImportRef は **c.mjs の
v** を from_module/from_binding にする(B を経由しない)。chain の
オーバーヘッドが消える。

`export * from "./c.mjs"` も同様。リンク時に c の全 export を B の export として
平坦に登録。名前衝突は spec のルール(`export *` 同士の衝突は ambiguous、その
名前を import すると参照エラー)に従う。`default` は `export *` では再エクスポート
されない(spec §10.4 の注意点)。

### 4.7 side-effect import / 全 import 形の対応表

提示された ESM 仕様書 §6.8 の import 形をすべて網羅する:

| 構文 | localName | tsaot の表現 |
|---|---|---|
| `import v from "mod"` | `v` | ImportRef(target=`default`)or direct ref |
| `import * as ns from "mod"` | `ns` | namespace binding(§4.4)|
| `import { x } from "mod"` | `x` | ImportRef(target=`x`)|
| `import { x as y } from "mod"` | `y` | ImportRef(target=`x`)、local 名は `y` |
| `import "mod"` | なし | **local binding を作らない**。依存として link/evaluate 対象に追加するのみ |
| `import type { T } from "mod"` | (型のみ) | **erase**(ランタイム表現なし)|

`import "./setup.mjs"`(side-effect import)は binding を作らないが、`setup.mjs`
の `__module_init` は依存として **postorder で評価される**(spec §9.4)。
tsaot はモジュールグラフの辺としては張るが ImportEntry は作らない。

renamed import (`import { x as y }`)では、**`y` のみが local binding**。`x` と
いう名前は importer の ModuleEnvironment には作られない(実測確認済み:
renamed import 後に元名を参照すると ReferenceError)。

### 4.8 strict-mode 不変条件(spec §21, §22)

ESM は常に strict mode code(spec §2.1)。tsaot が ESM をサポートする際の
不変条件:

- **top-level `this` は `undefined`**(spec §21)。`scope_resolution.md` §9 で
  既に module-level `this` を loud reject としているが、v2 で ESM を本実装する
  際は `undefined` として扱うのが正しい(reject から `undefined` 返しに変更)。
- **未宣言識別子への代入は ReferenceError**(spec §11.2)。sloppy mode の
  暗黙グローバル生成は起きない。tsaot は未解決識別子を loud reject(コンパイル
  時に検出できる)。
- **`delete 識別子` は SyntaxError**(spec §22.4)。これは TS checker が静的に
  弾く。tsaot は追加チェック不要。
- **import binding への代入は TypeError/SyntaxError**(spec §13.2)。tsaot は
  §4.2 の通り IR 生成時に loud reject。

---

## 5. リンカ

tsaot は全モジュールを単一バイナリにコンパイルする。リンクは **コンパイル時**
に解決済み(動的ロード無し)。

提示された ESM 仕様書 §15 の 3 フェーズ(Load/Parse → Link/Instantiate →
Evaluate)との対応:

| spec フェーズ | tsaot での担当 | タイミング |
|---|---|---|
| Load / Parse | exporter が全モジュールを TS checker でパース | コンパイル時 |
| Link / Instantiate | exporter + linker が binding/export table/import ref を確定し IR を生成 | コンパイル時 |
| Evaluate | 生成された `__module_init_<N>` を postorder で実行 | 実行時 |

spec の `ModuleStatus`(new/loaded/linking/linked/evaluating/evaluated/
errored)のうち、**Load〜Link は全部コンパイル時に解決される** ので、ランタイム
には evaluating/evaluated に相当する状態しか残らない。AOT の利点で、循環の SCC
検出やリンクエラーはコンパイル時に確定する。

### 5.1 リンクの過程(コンパイル時)

1. **モジュールグラフ構築**: エントリファイルから `import`/`export from`/
   side-effect import (`import "./x"`) の静的辺をたどり、関与する全モジュールを
   列挙(spec §15.1 Load + requestedModules 収集)
2. **シンボル解決**: 各 import について TS checker の alias を辿って **所有
   モジュール + binding** を特定。再エクスポート chain は最終所有者まで平坦化。
   `export *` の名前衝突は ambiguous として検出(spec §10.4 ResolveExport)
3. **SCC 検出**: モジュールグラフに DFS で強連結成分を求める(spec §17.2)。
   循環は SCC 単位で扱う。**ただし AOT なので SCC 内の binding 確定は全部
   コンパイル時**。ランタイムには評価順序(postorder)だけ残る
4. **コード生成**: 各モジュール用の `__module_init_<N>` を生成。エントリ
   ポイントから全モジュールの init を postorder で順次呼び出し
5. **セルアドレス確定**: export された binding のセルは `__module_init_<N>` 内で
   確保され、グローバル static に保存。importer はその static を直接参照

### 5.2 循環インポートと TDZ(重要な訂正)

ESM の循環:

```ts
// x.mjs
import { yfn } from "./y.mjs";
export let xval = 100;
export function xfn() { return xval; }
console.log(yfn());      // y.mjs の関数を呼ぶ(関数は前方解決済み)

// y.mjs
import { xval, xfn } from "./x.mjs";
export function yfn() { return xfn(); }  // 実行時には xfn は初期化済み
```

ESM では「binding の解決はリンク時、値の参照は実行時」。関数経由のアクセスは
循環でも動く(実測確認済み)。

**ここで前案を訂正する。** 前案は「TDZ は TS checker に委ね、実行時チェックを
emit しない」(`scope_resolution.md` §6.3 の単一モジュール内方針)としていた
が、**循環 import の TDZ は TS checker が静的に検出できない実行時条件** である
(実測で確認: 下記コードは tsc では無エラー、実行時に ReferenceError):

```ts
// a.mjs
import { b } from "./b.mjs";
export let a = "A";
console.log(b);          // b が未初期化なら ReferenceError(実行時)

// b.mjs
import { a } from "./a.mjs";
export let b = "B";
console.log(a);          // a.mjs を先に評価していなければ ReferenceError
```

`node a.mjs` 実行で `Cannot access 'a' before initialization` が出る(検証
済み)。tsc は循環依存の評価順序を静的に追えないため、このエラーを **コンパイル
時に出せない**。

したがって **ImportRef の読みには実行時 TDZ チェックが必要**。これは単一
モジュール内の `let`/`const` TDZ(`scope_resolution.md` §6.3 で TS checker に
委ねるとした)とは別の話。区別:

- **同一モジュール内の `let`/`const` TDZ**: ソース順で静的に判定可能 → TS
  checker に委ねる(従来方針を維持)。
- **循環 import 越しの ImportRef TDZ**: 評価順序依存の実行時条件 → tsaot が
  **実行時チェックを emit する**。

実装: セル(`ts_object`)に「初期化済みか」のフラグを持たせる。提示された
ESM 仕様書 §6.6 の `Cell { initialized, mutable, value }` モデルに対応する。
tsaot では:

- export された binding のセルは `__module_init_<B>` で確保された時点では
  **uninitialized**(`let`/`const` の場合)。初期化子の実行で initialized に
  なる。`var`/`function` は確保時点で initialized(hoist)。
- `LoadImport` の codegen は、初期化フラグを確認してから値を返す:
  ```c
  // LoadImport dst src=MODULE_A_x
  if (!ts_cell_initialized(MODULE_A_x)) ts_throw_tdz("x");
  dst = ts_get(MODULE_A_x, FIELD_VALUE);
  ```
- 同一モジュール内の通常セル読み(`LoadField`)には TDZ チェックを入れない
  (静的に保証されるため)。`LoadImport` のみがチェックを持つ。

これは v2 の話。v1 は単一ファイルなので循環 import は起き得ず、`LoadImport`
自体が emit されない。ただし **セルに initialized フラグを持たせる設計** は
v1 の段階で `ts_object` 表現に組み込んでおく(後付けだと runtime レイアウト
変更になり高コスト)。詳細は §7 で。

### 5.3 これは GlobalEnvironment 機構とは別物

export された binding のセルは **モジュール毎の static**(`MODULE_B_x`)で
あって、`GLOBALS[]` ではない。`GLOBALS[]`/`LoadGlobal`/`StoreGlobal` は真の
グローバル(`globalThis`、ホスト注入)専用。両者は別レイヤー。

提示された ESM 仕様書 §3 の階層に対応:

```
Realm
  └─ GlobalEnvironment           ← tsaot の GLOBALS[] / builtins
       ├─ globalThis
       ├─ built-in globals (console, Array, ...)
       └─ global lexical bindings
ModuleRecord(B)
  └─ ModuleEnvironment           ← tsaot の per-module cells (MODULE_B_x)
       ├─ import bindings (ImportRef)
       └─ top-level var/let/const/function/class bindings
```

`ModuleEnvironment.[[OuterEnv]] = GlobalEnvironment`(仕様書 §6.2)に対応し、
tsaot のスコープチェーン解決順序は:
```
ローカル → 外側関数(capture) → ModuleEnvironment(import含む) → Global builtins
```

---

## 6. 全体像

### 6.1 BindingKind の最終形

```rust
pub enum BindingKind {
    Local,        // 普通のローカル変数(closure 経由でセル化)
    LocalExport,  // このモジュールが export する binding(セル + GC root)
    ImportRef { from_module: ModuleId, from_binding: BindingId },  // ESM import
}
```

### 6.2 Inst の追加

```rust
LoadImport { dst: LocalId, src: LocalId },
AllocNamespace { dst: LocalId, module: ModuleId, site: SiteId },
```

### 6.3 lowering 規則の要点

| ソース | tsaot の lowering |
|---|---|
| `let x = 1` at module top (not exported) | `Local` binding, AllocObject (cell), StoreField .VALUE = 1 |
| `export let x = 1` | `LocalExport` binding, AllocObject, StoreField, GC root |
| `let x` 参照(同一モジュール内、cell 化済み) | `LoadField cell FIELD_VALUE` |
| `x = 2` 同左 | `StoreField cell FIELD_VALUE = 2` |
| `import { x } from "./B"` | `ImportRef` binding 作成、linker 時に from_binding 確定 |
| `x` 参照(importer 側、ImportRef) | `LoadImport src=ImportRef_local` |
| `x = 2` 同左 | **exporter が loud reject**(static const-like) |
| `import * as ns` 参照 | linker が ns プロパティアクセスを観察、即時 LoadImport 等に最適化、または AllocNamespace で実体化 |
| `export function f` | linker が外部参照可能にする(direct reference) |
| `import { f } from "./B"`, `f()` | `Call Direct { func: B::fId }` |
| `export class C` | direct class reference(classId) |
| `export default expr` | 名前 `default` の export |
| `export { v } from "./c"` | 再エクスポート、最終所有者まで平坦化 |
| `require(...)` / `module.exports` / `exports.x` / `export =` / `import x = require()` | **loud reject**(CJS は非サポート) |

### 6.4 analyzer の影響

`scope_redesign_analyzer_impact.md` の更新内容:

- **escape_ir.rs**: `BindingKind` enum 追加、`Inst::LoadImport` /
  `Inst::AllocNamespace` 追加、`ModuleInfo` / `ExportEntry` / `ImportEntry`
  追加。Global infrastructure はそのまま。
- **interproc.rs**: `LoadImport` は `LoadField` と同シェイプ(他オブジェクトの
  field 読み)→ 1 arm 追加。`AllocNamespace` は frozen object + getter 群 →
  常に External 扱いで OK(1 arm)。
- **sroa.rs**: `LoadImport` の src は cell なので materialize 必要
  (`LoadField` の obj と同扱い)。`AllocNamespace` の dst も materialize。
- **devirt.rs**: 影響なし。
- **emit_c.rs**: `LoadImport` → `ts_get(src, FIELD_VALUE)` 一発。
  `AllocNamespace` → frozen object + getter 群。
- **call_graph.rs**: 影響なし。

ImportRef を扱うために interproc が「モジュール境界を越える alias」を追跡する
必要は無い。ImportRef の src local 自体が普通の `ts_object` 値で、その alias
解析は既存通り。LoadImport は LoadField と同じシェイプ。

---

## 7. v1 で予約しておくもの

v1 は単一ファイル ESM モジュール(import/export 無し)。multi-file linkage は
v2。v1 で予約する IR 拡張:

1. **`Binding.binding_kind: BindingKind`** を追加。v1 では全 binding が
   `BindingKind::Local`(モジュールスコープ binding も含む — v1 は単一モジュール
   なので export されても参照する他モジュールが無い)。
2. **`Inst::LoadImport`、`Inst::AllocNamespace`** を IR enum に登録。v1 では
   emitter は emit しない。analyzer/codegen の arm は `unreachable!()` か
   明確なエラーで埋め、v2 で実装。
3. **`ModuleInfo`/`ExportEntry`/`ImportEntry`** を `Program` に追加。v1 では
   1 個の ModuleInfo(エントリファイル)、空の imports、`is_exported=true` の
   binding に対応する exports。
4. **`RefKind` に `import_ref`** を追加(exporter)。v1 では使わない。
5. **CJS 構文の loud reject** は v1 の Step 0 で実施(`module_linkage.md` §4.1)。
   `require` / `module.exports` / `exports.x` / `export =` /
   `import x = require()` を明示的に unsupported に。

6. **【新規・要注意】セルの initialized フラグ**: 提示された ESM 仕様書 §6.6 の
   `Cell { initialized, mutable, value }` モデルに従い、tsaot のセル
   (`ts_object`)に「初期化済みか」を表現する手段を予約する。これは循環 import
   越しの TDZ チェック(§5.2)に必須。

   **ここが後付け困難なので v1 で決めておく価値がある**: 今のセルは `ts_object`
   の `.VALUE` フィールド一つ。initialized フラグの置き場所として選択肢:
   - (a) セル `ts_object` のヘッダのフラグビットを 1 本使う(レイアウト変更、
     しかし全 ts_object に効くので慎重に)
   - (b) `.VALUE` の初期値を特別な番兵値 `TS_UNINITIALIZED`(`TS_UNDEFINED` とは
     別の NaN-box タグ)にして、read 時に番兵なら TDZ throw
   - (c) セルに 2 つ目のフィールド `.INITIALIZED` を持たせる

   **推奨は (b)**: NaN-boxing に `TS_UNINITIALIZED` タグを 1 つ足すだけで、
   セルのレイアウトは不変、`LoadImport` の codegen は「読んだ値が
   TS_UNINITIALIZED なら throw」になる。単一モジュール内の通常 `let`/`const`
   セルにも応用でき(ただし v1 では TS checker 任せなので使わない)、将来
   一貫した TDZ 機構になる。

   v1 では TDZ チェックを emit しないが、**`TS_UNINITIALIZED` タグの予約だけは
   v1 の NaN-boxing 設計に入れておく**(タグ空間は有限なので後から押し込むのは
   面倒)。ランタイムに番兵値の定義と `ts_is_uninitialized()` を足すのは数行。

---

## 8. 「Ref 型」の位置づけまとめ

「他の変数への参照を持つ新しい型」は tsaot では 3 レイヤーに分かれる:

| レイヤー | 表現 |
|---|---|
| IR の値分類 (`RefKind`) | `import_ref` バリアント(値が live import binding であることを示す) |
| IR の binding 分類 (`BindingKind`) | `ImportRef { from_module, from_binding }`(binding 自身の種別) |
| IR の opcode | `LoadImport` で読みを明示。write は IR レベルで存在しない(exporter が拒否) |

これらが揃って初めて:
- analyzer が「これは live binding read だ」と認識
- codegen が「LoadImport は src cell の .VALUE を読む(初期化チェック付き)」と
  一意に lower
- verifier が「ImportRef binding への write は IR にあってはならない」を保証
- 将来の最適化(同一モジュール内 export binding のインライン化など)が型情報を使う

「生ポインタ」では一切表現できない情報がここに乗る。

### 8.1 提示された ESM 仕様書との用語対応

提示された仕様書(VM 実装視点)と tsaot(AOT コンパイラ視点)の用語対応:

| 仕様書の概念 | tsaot での対応 |
|---|---|
| `ModuleEnvironment` | モジュール毎のセル群 + exporter のシンボル解決 |
| `ModuleFrame` / `Cell[]` | export された binding は `static tsv MODULE_B_x`(GC root された ts_object セル) |
| `Cell { initialized, mutable, value }` | `ts_object` の `.VALUE` + `TS_UNINITIALIZED` 番兵(§7-6)+ mutable は IR の binding_kind / TS const 性で静的に決定 |
| `ImportBinding { targetModule, targetSlot }` | `BindingKind::ImportRef { from_module, from_binding }` |
| `DirectBinding` | `BindingKind::Local` / `LocalExport` |
| `ModuleNamespaceObject` | `Inst::AllocNamespace` が生成する read-only オブジェクト |
| `ExportTable` / `ResolveExport` | linker のコンパイル時シンボル解決(`ModuleInfo.exports`)|
| Load / Link / Evaluate(spec §15)| Load+Link はコンパイル時、Evaluate は `__module_init_<N>` 実行時 |
| `ModuleStatus` 状態機械 | コンパイル時に解決(ランタイムには評価順序のみ残る)|
| SCC 検出(spec §17.2)| linker がコンパイル時に実施 |

**根本的な違い**: 仕様書は **インタプリタ VM**(Link/Evaluate を実行時に行う)
を想定。tsaot は **AOT コンパイラ** なので Load/Link を全部コンパイル時に潰す。
ランタイムに残るのは Evaluate(各モジュールの `__module_init` を postorder で
呼ぶ)と、循環 import の TDZ 番兵チェックだけ。これにより spec の
`ModuleStatus`/SCC 機構の大半がコンパイル時に消える。

---

## 9. 確認したい設計判断

1. **ESM only**(CJS 構文はすべて loud reject)。これで OK?
2. **「Ref 型」を IR の binding_kind / RefKind / opcode の 3 レイヤーで表現**。OK?
3. **ImportRef の write は IR レベルで表現せず、exporter が静的に loud reject**
   (spec の "assignment to constant" を静的翻訳)。OK?
4. **関数と class の export は ImportRef を経由せず direct reference**。OK?
5. **namespace import は 2 段最適化**(propaccess のみなら LoadImport に直接
   lower、変数化されるなら namespace object 実体化)。OK?
6. **v1 で BindingKind / LoadImport / AllocNamespace / ModuleInfo / import_ref
   を IR に予約**(実装は v2)。OK?
7. **循環 import 越しの TDZ は実行時チェック**。`LoadImport` は番兵値
   `TS_UNINITIALIZED` を確認してから読む。単一モジュール内 `let`/`const` の
   TDZ は従来通り TS checker 任せ(静的)、ここだけ実行時チェックを emit。
   そのために **NaN-boxing に `TS_UNINITIALIZED` タグを v1 で予約**。OK?

**全 7 点 確認済み(合意完了)。** 設計は固まった。

### 9.1 性能上の位置づけ(確定事項)

変数の import(`export let`/`const` の live binding を `LoadImport` で読む)は
**遅くてよい**。理由と帰結:

- 実コードで変数 import は稀。import の大多数は関数・クラス・型であり、それらは
  ImportRef を経由せず **direct call / direct reference**(チェック無し、最速)。
- したがって `LoadImport` の TDZ 番兵チェック(`TS_UNINITIALIZED` 判定の分岐)の
  コストは **許容**。ホットパスに乗る可能性が低く、最適化の優先度は低い。
- まとめ:
  - **速いまま維持**: 関数/クラスの import(direct)、同一モジュール内の通常の
    変数アクセス(`LoadField`、チェック無し)、既存の全ベンチマーク
  - **遅くてよい**: 変数 import の read(`LoadImport` + 番兵チェック)
- この割り切りにより、将来 closure-call devirt のような追加最適化を変数 import に
  入れる必要は当面ない。
