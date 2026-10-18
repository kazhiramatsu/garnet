//! Escape IR — the contract between the TypeScript exporter (classic `tsc`
//! compiler API) and the Rust escape analyzer. P0 schema, version 1.
//!
//! Wire format: JSON. This file is the Rust half; `escape_ir.ts` is the
//! TypeScript half and MUST stay byte-compatible. Compatibility rules:
//!   * every struct uses `rename_all = "camelCase"`,
//!   * every tagged union uses `tag = "kind"` + `rename_all_fields = "camelCase"`,
//!   * ids are bare integers (serde `transparent`) that index their table.
//!
//! Id → table mapping (an id equals the element's index in its table):
//!   TypeId      -> Program.types
//!   FieldId     -> Program.fields
//!   SignatureId -> Program.signatures
//!   GlobalId    -> Program.globals
//!   FunctionId  -> Program.functions
//!   ScopeId     -> Program.scopes
//!   BindingId   -> Program.bindings
//!   LocalId     -> Function.locals          (per-function namespace)
//!   SiteId      -> NOT a table index; a program-global key for EscapeResult.
//!
//! Design split (see also TypeInfo):
//!   * The ANALYZER reads only the cheap projection (`Local.ref_kind`,
//!     `FieldId`s, resolved `CalleeRef`) and never needs the TypeTable.
//!   * CODEGEN reads the heavy `TypeShape` via `type_id` for layout/sizing.
//!
//! Requires serde >= 1.0.157 for `rename_all_fields`.

use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;

macro_rules! id_newtype {
    ($name:ident) => {
        #[derive(
            Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
        )]
        #[serde(transparent)]
        pub struct $name(pub u32);
    };
}

id_newtype!(TypeId);
id_newtype!(FieldId);
id_newtype!(SignatureId);
id_newtype!(GlobalId);
id_newtype!(FunctionId);
id_newtype!(ScopeId);
id_newtype!(BindingId);
id_newtype!(LocalId);
id_newtype!(SiteId);
id_newtype!(ClassId);
id_newtype!(Name);

// ---------------------------------------------------------------------------
// Top-level program (exporter -> analyzer)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Program {
    pub version: u32,
    /// Gate for strict-only TypeScript type-based optimizations. It is metadata
    /// for future passes; current analyzer/codegen keeps existing conservative
    /// behavior unless a pass explicitly consults this field.
    #[serde(default, rename = "strictTypeOptimizations")]
    pub strict_type_optimizations: StrictTypeOptimizations,
    pub types: Vec<TypeInfo>,
    pub fields: Vec<FieldInfo>,
    pub signatures: Vec<SignatureInfo>,
    pub globals: Vec<GlobalInfo>,
    pub scopes: Vec<Scope>,
    pub bindings: Vec<Binding>,
    pub functions: Vec<Function>,
    /// Functions reachable from outside the analyzed unit. Their parameters
    /// and return are external roots (treated as opaque / escaping sources).
    pub exports: Vec<FunctionId>,
    /// Per-site codegen metadata (multiplicity, layout-determinability, kind).
    /// Consumed by codegen, ignored by the analyzer; defaults to empty.
    #[serde(default)]
    pub site_meta: Vec<SiteMeta>,
    /// Class hierarchy for the devirtualization pass; defaults to empty.
    #[serde(default)]
    pub classes: Vec<ClassDef>,
    /// Object.prototype methods (name + runtime C fn + method-name id) to register
    /// on the shared Object.prototype. Defaults to empty for older inputs.
    #[serde(default, rename = "objectProtoMethods")]
    pub object_proto_methods: Vec<ObjectProtoMethod>,
    /// Array.prototype methods (unified object model): name -> runtime ts_code
    /// wrapper + interned method-name id. Emitted setup registers each on the
    /// runtime Array.prototype under TS_KEY_METHOD(id) so dynamic `arr.method()`
    /// resolves through the prototype chain. Same shape as object_proto_methods.
    #[serde(default, rename = "arrayProtoMethods")]
    pub array_proto_methods: Vec<ObjectProtoMethod>,
    /// Promise.prototype methods (then/catch/finally) registered so `p.then` etc.
    /// resolve as first-class method VALUES via ts_get's promise dispatch. Same shape.
    #[serde(default, rename = "promiseProtoMethods")]
    pub promise_proto_methods: Vec<ObjectProtoMethod>,
    /// Map.prototype / Set.prototype methods (followon to U-5): same shape.
    #[serde(default, rename = "mapProtoMethods")]
    pub map_proto_methods: Vec<ObjectProtoMethod>,
    #[serde(default, rename = "setProtoMethods")]
    pub set_proto_methods: Vec<ObjectProtoMethod>,
    #[serde(default, rename = "weakMapProtoMethods")]
    pub weak_map_proto_methods: Vec<ObjectProtoMethod>,
    #[serde(default, rename = "weakSetProtoMethods")]
    pub weak_set_proto_methods: Vec<ObjectProtoMethod>,
    #[serde(default, rename = "headersProtoMethods")]
    pub headers_proto_methods: Vec<ObjectProtoMethod>,
    #[serde(default, rename = "functionProtoMethods")]
    pub function_proto_methods: Vec<ObjectProtoMethod>,
    #[serde(default, rename = "stringProtoMethods")]
    pub string_proto_methods: Vec<ObjectProtoMethod>,
    #[serde(default, rename = "regexpProtoMethods")]
    pub regexp_proto_methods: Vec<ObjectProtoMethod>,
    #[serde(default, rename = "numberProtoMethods")]
    pub number_proto_methods: Vec<ObjectProtoMethod>,
    #[serde(default, rename = "booleanProtoMethods")]
    pub boolean_proto_methods: Vec<ObjectProtoMethod>,
    /// Method-name ids that actually denote a well-known symbol key
    /// (`[Symbol.iterator]` etc.). Codegen emits TS_KEY_WKSYM(wksym_id) for these
    /// instead of TS_KEY_METHOD(name_id), so the key is stable and lands in the
    /// reserved WKSYM range (property_model_redesign §3.6). Defaults to empty.
    #[serde(default, rename = "wellKnownSymbols")]
    pub well_known_symbols: Vec<WellKnownSymbol>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StrictTypeOptimizations {
    pub enabled: bool,
    pub strict_profile: bool,
    pub diagnostic_clean: bool,
    pub diagnostic_count: usize,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub options: StrictTypeOptimizationOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StrictTypeOptimizationOptions {
    pub no_implicit_any: bool,
    pub strict_null_checks: bool,
    pub strict_function_types: bool,
    pub strict_bind_call_apply: bool,
    pub strict_property_initialization: bool,
    pub no_implicit_this: bool,
    pub use_unknown_in_catch_variables: bool,
    pub always_strict: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WellKnownSymbol {
    /// the method-name id the exporter assigned to this `[Symbol.X]` method
    pub name_id: Name,
    /// the fixed well-known symbol id (TS_WKSYM_ITERATOR=0, ASYNC_ITERATOR=1, ...)
    pub wksym_id: u32,
}

/// One Object.prototype method: its method-name id (for the METHOD_KEY_BASE key)
/// and the runtime C function name that implements it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectProtoMethod {
    pub name: String,
    pub runtime: String,
    #[serde(rename = "methodId")]
    pub method_id: u32,
}

/// A class as seen by the devirt pass (mirrors class_extract.ts output).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassDef {
    pub id: ClassId,
    #[serde(default)]
    pub name: Option<String>,
    pub parent: Option<ClassId>,
    pub own_methods: Vec<MethodDef>,
    pub own_fields: Vec<Name>,
    pub instantiated: bool,
    pub stable: bool,
    /// Monomorphization: concrete scalar type per field id, when a generic class
    /// is instantiated with a uniform concrete type argument (RTA-style). A field
    /// listed here with "number" is emitted as an unboxed C double instead of tsv.
    /// Empty/absent fields default to the boxed tsv representation.
    #[serde(default)]
    pub field_types: std::collections::BTreeMap<String, String>,
    /// Diagnostic: why the class was demoted to unstable (empty if stable).
    #[serde(default)]
    pub reasons: Vec<String>,
    /// If this class `extends` a built-in Error-family constructor (no user-class
    /// parent), the error kind index (0=Error,1=TypeError,...). Its prototype chains
    /// to the shared runtime Error.prototype so `instance instanceof Error` holds
    /// and `name` is inherited. None = not an Error subclass.
    #[serde(default)]
    pub error_proto_kind: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodDef {
    pub name: Name,
    /// Original string property name for prototype reflection. This is absent for
    /// private/well-known-symbol/internal pseudo methods that are not string-named
    /// own properties on `C.prototype`.
    #[serde(default)]
    pub prop_name: Option<String>,
    #[serde(default)]
    pub prop_name_units: Vec<u16>,
    pub func: FunctionId,
    pub kind: MethodKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MethodKind {
    Method,
    Getter,
    Setter,
}

/// Codegen-facing metadata for an allocation site. The analyzer never reads
/// this; it lets the backend pick a strategy (stack / arena / heap).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteMeta {
    pub site: SiteId,
    /// How many times the site runs per frame activation (single vs loop/many).
    pub multiplicity: Multiplicity,
    /// Whether the allocated object's layout/size is statically known.
    pub layout_determinable: bool,
    pub kind: AllocKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Multiplicity {
    /// At most once per frame activation (slot reuse / scalar replacement safe).
    Once,
    /// Possibly many per frame (loop / per-iteration); single slot is unsound.
    Many,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AllocKind {
    Object,
    Array,
    Closure,
    Cell,
}

// ---------------------------------------------------------------------------
// Interned types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeInfo {
    pub id: TypeId,
    /// Cheap projection consumed by the analyzer (track vs ignore).
    pub ref_kind: RefKind,
    /// Hint for codegen's stack-eligibility check. Codegen makes the final
    /// call (NoEscape ∧ layout-determinable ⇒ stack); this is just precomputed.
    pub layout_determinable: bool,
    /// Full structural shape; consumed by codegen for layout/size.
    pub shape: TypeShape,
    /// Debug only.
    #[serde(default)]
    pub display: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    Reference,
    Primitive,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum TypeShape {
    Object {
        fields: Vec<FieldEntry>,
    },
    Array {
        elem: TypeId,
    },
    Union {
        members: Vec<TypeId>,
    },
    Primitive {
        prim: PrimitiveKind,
    },
    Function,
    /// `any` / `unknown` — layout not determinable.
    Any,
    /// Uninstantiated type parameter — layout not determinable.
    OpenGeneric,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldEntry {
    pub field: FieldId,
    pub type_id: TypeId,
    #[serde(default)]
    pub optional: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrimitiveKind {
    Number,
    String,
    Boolean,
    Bigint,
    Symbol,
    Null,
    Undefined,
    Void,
    Never,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldInfo {
    pub id: FieldId,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub name_units: Vec<u16>,
    /// Declaring type. (name + declaring type) gives field-sensitivity its key.
    pub declaring_type: TypeId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureInfo {
    pub id: SignatureId,
    pub params: Vec<TypeId>,
    pub ret: TypeId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalInfo {
    pub id: GlobalId,
    pub name: String,
    #[serde(default)]
    pub type_id: Option<TypeId>,
}

// ---------------------------------------------------------------------------
// Lexical scoping (JS/TS semantics)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub id: ScopeId,
    pub kind: ScopeKind,
    /// Lexical parent; None for the root (module/global).
    #[serde(default)]
    pub parent: Option<ScopeId>,
    /// Nearest enclosing function activation; None at module/global scope.
    #[serde(default)]
    pub function: Option<FunctionId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScopeKind {
    /// Top-level module scope (TS source files are modules).
    Module,
    /// Ambient global (globalThis); mostly a resolution target.
    Global,
    /// Function / method / arrow / constructor body. `var` and params hoist here.
    Function,
    /// `{ }` block. `let` / `const` / class / block function decls live here.
    Block,
    /// Loop header (`for` / `for-in` / `for-of`). `let`/`const` here are per-iteration.
    For,
    /// `catch` clause; holds the catch parameter.
    Catch,
    /// `with` (sloppy only; illegal in modules). Opaque → analyzer stays conservative.
    With,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub id: BindingId,
    pub name: String,
    pub decl_kind: DeclKind,
    /// Scope the binding lives in AFTER hoisting:
    ///   Var             -> nearest Function / Module / Global scope,
    ///   Let/Const/Class -> the immediate Block / For scope,
    ///   Param           -> the Function scope,
    ///   CatchParam      -> the Catch scope,
    ///   FunctionDecl    -> nearest Function/Module (sloppy) or Block (strict/modules).
    pub scope: ScopeId,
    pub type_id: TypeId,
    /// `const` / import are immutable → single-assignment (SSA-like) precision.
    pub mutable: bool,
    /// Subject to the temporal dead zone (let/const/class). Informational only:
    /// it does NOT affect the flow-insensitive connection graph.
    #[serde(default)]
    pub tdz: bool,
    /// Loop-header `let`/`const` gets a FRESH binding per iteration: the cell is
    /// allocated inside the loop body, so each iteration's closures capture a
    /// distinct cell. Contrast `var`, which shares one function-scoped cell.
    #[serde(default)]
    pub per_iteration: bool,
    /// Inner functions that close over this binding (free-variable result).
    /// Non-empty ⇒ the cell may outlive its declaring activation, so the
    /// binding's escape tracks the escape of the capturing closure object(s).
    /// Empty ⇒ the binding needs no cell and stays a pure stack value.
    #[serde(default)]
    pub captured_by: Vec<FunctionId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeclKind {
    Var,
    Let,
    Const,
    Param,
    FunctionDecl,
    ClassDecl,
    CatchParam,
    Import,
    Builtin,
}

// ---------------------------------------------------------------------------
// Functions and the normalized instruction stream
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Function {
    pub id: FunctionId,
    #[serde(default)]
    pub name: Option<String>,
    /// Subset of `locals` (by id) that are the incoming parameters.
    pub params: Vec<LocalId>,
    pub ret: TypeId,
    pub locals: Vec<Local>,
    /// v1: flow-insensitive flat list. Swap for a block list to go flow-sensitive.
    pub body: Vec<Inst>,
    pub is_exported: bool,
    /// Typed-field codegen: parameter-local-id -> class id, when a parameter is
    /// declared with a (specialized) class type. Lets the callee use the typed
    /// struct layout (`->fN`) for that parameter instead of dynamic `ts_get`,
    /// keeping it consistent with how the object's fields were written.
    #[serde(default)]
    pub param_classes: std::collections::BTreeMap<String, u32>,
    /// Index into `params` of a rest parameter (`...args`), if the function has
    /// one. The callee gathers args[restIndex..nargs] into an array for it.
    #[serde(default)]
    pub rest_param: Option<u32>,
    /// True if this is an `async function`.
    #[serde(default)]
    pub is_async: bool,
    /// True if this is a generator (`function*`); lowered to a state machine
    /// driven by .next() rather than the event loop.
    #[serde(default)]
    pub is_generator: bool,
    /// Number of leading `params` that are captured cells (the closure
    /// environment threaded by the creating or directly calling function).
    /// The production emitter passes them through the runtime's environment
    /// register; the argument array then holds only the real arguments.
    #[serde(default)]
    pub capture_count: u32,
    /// True if the function reads args[0] as `this` (methods, accessors, and
    /// functions written with an explicit `this` parameter). Used so that
    /// Function.prototype.call/apply/bind inject thisArg at args[0] only for
    /// callees that actually consume it (free functions ignore thisArg, per JS).
    #[serde(default)]
    pub takes_this: bool,
    /// JS `Function.prototype.length`: number of leading parameters with no
    /// default value, before the first defaulted/rest parameter (excludes a
    /// leading explicit `this`). Set on the boxed function value as a VALUE.
    #[serde(default)]
    pub arity: u32,
    /// True for ordinary function declarations/expressions that have an own
    /// non-enumerable "prototype" data property. False for arrows, methods,
    /// accessors, builtins, and synthetic functions.
    #[serde(default)]
    pub has_prototype: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Local {
    pub id: LocalId,
    pub type_id: TypeId,
    /// Inlined so the analyzer is self-contained without the TypeTable.
    pub ref_kind: RefKind,
    /// Source binding this local materializes; None for synthetic temporaries.
    #[serde(default)]
    pub binding: Option<BindingId>,
    #[serde(default)]
    pub name: Option<String>,
    /// True when the frontend typed this local's source as a *pure nullable
    /// number* (`number|undefined`/`number|null`, no other reference member).
    /// §254 boxes these for correctness; §261 uses this flag to recover perf
    /// by unboxing the arithmetic-only ones (flow-sensitive, see emit_c).
    #[serde(default)]
    pub nullable_numeric: bool,
}

/// One captured variable in a closure. `binding` is the source cell; `cell`
/// is the local in the *creating* function that holds a reference to that cell
/// (the exporter threads it into scope, so the analyzer never does a
/// cross-function lookup). Verifier invariant: `locals[cell].binding == Some(binding)`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    pub binding: BindingId,
    pub cell: LocalId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum Inst {
    AllocObject {
        dst: LocalId,
        type_id: TypeId,
        site: SiteId,
        #[serde(default)]
        class_id: Option<ClassId>,
        #[serde(default)]
        proto: Option<LocalId>,
    },
    AllocArray {
        dst: LocalId,
        elem_type: TypeId,
        site: SiteId,
    },
    /// Captured cells become fields of the closure object. Each capture pairs
    /// the source binding with the local (in this function) holding its cell.
    AllocClosure {
        dst: LocalId,
        func: FunctionId,
        captures: Vec<Capture>,
        site: SiteId,
    },
    Copy {
        dst: LocalId,
        src: LocalId,
    },
    LoadField {
        dst: LocalId,
        obj: LocalId,
        field: FieldId,
    },
    StoreField {
        obj: LocalId,
        field: FieldId,
        src: LocalId,
    },
    /// First-class builtin PROTOTYPE method value: `recv.method` read as a value
    /// (not called). Loads the boxed (unbound) prototype method via ts_get with a
    /// method key. `recv` is evaluated (side effects) but the method is shared.
    LoadMethodValue {
        dst: LocalId,
        recv: LocalId,
        method: u32,
    },
    /// First-class builtin STATIC function value: `Math.sqrt`/`console.log`/...
    /// read as a value. Boxes a generated adapter (ts_code) as a ts_func.
    LoadBuiltinFn {
        dst: LocalId,
        builtin: String,
    },
    /// A CLASS used as a runtime VALUE (`const K = C`): box the constructor cfunc +
    /// captured cells as a ts_func carrying class_id. Like AllocClosure but for a
    /// class, so `new K()` can construct via ts_construct.
    AllocClassValue {
        dst: LocalId,
        class_id: u32,
        ctor: FunctionId,
        captures: Vec<Capture>,
    },
    /// `new K(args)` where K is a class VALUE — construct an instance at runtime
    /// from the class value (reads class_id, allocates, calls the ctor).
    /// `poly`: the constructed class is one of several runtime candidates (a
    /// `cond ? A : B` value whose static type collapsed to one member, or a true
    /// union). The `dst`'s static class annotation is then untrustworthy, so devirt
    /// taints it and forces dynamic dispatch on any method call reaching it (see
    /// devirt::compute_poly_taint). Defaults to false (a monomorphic class value,
    /// where the static class equals the runtime class).
    NewDynamic {
        dst: LocalId,
        callee: LocalId,
        args: Vec<LocalId>,
        #[serde(default)]
        poly: bool,
    },
    /// Index-insensitive: all elements collapse to one element node.
    LoadElem {
        dst: LocalId,
        arr: LocalId,
    },
    StoreElem {
        arr: LocalId,
        src: LocalId,
    },
    Call {
        #[serde(default)]
        dst: Option<LocalId>,
        callee: CalleeRef,
        #[serde(default)]
        recv: Option<LocalId>,
        args: Vec<LocalId>,
        #[serde(default)]
        resolved_sig: Option<SignatureId>,
    },
    Return {
        #[serde(default)]
        src: Option<LocalId>,
    },
    /// `yield operand`: in a generator, hand `operand` to the .next() caller and
    /// suspend; on resume, dst receives the value passed to the next .next(v).
    Yield {
        dst: Option<LocalId>,
        operand: LocalId,
    },
    /// `await operand`: suspend until the awaited Promise settles, resume with
    /// its value in dst (a rejected promise raises at this point).
    Await {
        dst: Option<LocalId>,
        operand: LocalId,
    },
    /// v1 sink: thrown value escapes globally (refine with catch modeling later).
    Throw {
        src: LocalId,
    },
    /// try { try_body } catch (catch_var) { catch_body } finally { finally_body }.
    /// catch_var is the local bound to the caught exception (None for `catch {}`
    /// without binding). finally_body runs on both normal and caught paths.
    TryCatch {
        try_body: Vec<Inst>,
        catch_var: Option<LocalId>,
        catch_body: Vec<Inst>,
        #[serde(default)]
        finally_body: Vec<Inst>,
    },
    StoreGlobal {
        gref: GlobalId,
        src: LocalId,
    },
    LoadGlobal {
        dst: LocalId,
        gref: GlobalId,
    },
    /// Codegen-only: materialize a constant. The analyzer treats the dst as a
    /// fresh non-escaping primitive/string (sound: constants don't alias).
    Const {
        dst: LocalId,
        value: ConstVal,
    },
    /// Codegen-only: a binary/unary operation producing a value.
    BinOp {
        dst: LocalId,
        op: String,
        lhs: LocalId,
        rhs: LocalId,
    },
    /// Codegen-only: a unary operation (`!`, unary `-`) producing a value.
    UnOp {
        dst: LocalId,
        op: String,
        operand: LocalId,
    },
    /// Codegen-only: indexed array read `dst = arr[idx]`.
    LoadIndex {
        dst: LocalId,
        arr: LocalId,
        index: LocalId,
    },
    /// Codegen-only: indexed array write `arr[idx] = src`.
    StoreIndex {
        arr: LocalId,
        index: LocalId,
        src: LocalId,
    },
    /// Codegen-only: `dst = arr.length`.
    ArrayLen {
        dst: LocalId,
        arr: LocalId,
    },
    /// Codegen-only: `dst = str.length` for statically-known string receivers.
    StringLen {
        dst: LocalId,
        src: LocalId,
    },
    /// Codegen-only: `arr.push(src)`.
    ArrayPush {
        arr: LocalId,
        src: LocalId,
    },
    /// Append all elements of `src` (an array) to `arr`: array-literal spread.
    ArrayPushAll {
        arr: LocalId,
        src: LocalId,
    },
    /// `"key" in obj` with a statically-known field id.
    HasField {
        dst: LocalId,
        obj: LocalId,
        field: FieldId,
    },
    /// `keyStr in obj` with a dynamic (runtime) string key.
    HasFieldDynamic {
        dst: LocalId,
        obj: LocalId,
        key: LocalId,
    },
    /// `v.length` where v's kind is not statically known: string len or array len.
    GenericLen {
        dst: LocalId,
        src: LocalId,
    },
    /// `obj[keyStr]`: dynamic string-keyed property load (interns key at runtime).
    LoadFieldDynamic {
        dst: LocalId,
        obj: LocalId,
        key: LocalId,
    },
    /// `obj[keyStr] = v`: dynamic string-keyed property store.
    StoreFieldDynamic {
        obj: LocalId,
        key: LocalId,
        src: LocalId,
    },
    /// `delete obj.field` with a statically-known field id. `method` is the
    /// METHOD-space name id when the name is also interned as a method name:
    /// a prototype-method store writes BOTH key spaces (StoreField +
    /// StoreMethod, the dynamic-dispatch bridge), so delete must clear both —
    /// otherwise the METHOD-side dispatch fallback keeps resolving a deleted
    /// method (reads saw it gone, calls still succeeded).
    DeleteField {
        dst: Option<LocalId>,
        obj: LocalId,
        field: FieldId,
        #[serde(default)]
        method: Option<u32>,
    },
    /// `[a, ...rest]`: rest = arr.slice(start).
    ArraySlice {
        dst: LocalId,
        arr: LocalId,
        start: LocalId,
    },
    /// `{a, ...rest}`: rest = own enumerable props of src minus `exclude` keys.
    ObjectRest {
        dst: LocalId,
        src: LocalId,
        exclude: Vec<FieldId>,
    },
    /// Object spread `{...src}`: copy src's own enumerable props into dst.
    ObjectCopyProps {
        dst: LocalId,
        src: LocalId,
    },
    /// new operator step 4 (unified_object_model §10): result of `new C()` when C's
    /// constructor may return a value. `dst = ts_construct_result(inst, ret)` —
    /// the returned object if `ret` is object-like, else the allocated `inst`.
    ConstructResult {
        dst: LocalId,
        inst: LocalId,
        ret: LocalId,
    },
    /// A call whose argument list contains spreads (`f(a, ...b, c)`). The args are
    /// a sequence of specs (single value or spread-array) assembled into a
    /// dynamic-length buffer at codegen time.
    CallSpread {
        dst: Option<LocalId>,
        callee: CalleeRef,
        recv: Option<LocalId>,
        arg_specs: Vec<ArgSpec>,
    },
    /// Codegen-only: loop break / continue. `up` is how many loop-nesting levels
    /// out the target loop is (0 = innermost = a plain break/continue; >=1 = a
    /// labeled multi-level jump, emitted as a goto to that loop's label).
    Break {
        #[serde(default)]
        up: u32,
    },
    Continue {
        #[serde(default)]
        up: u32,
    },
    /// Codegen-only: load the compiler-managed prototype object of a class, so
    /// runtime prototype mutation (`C.prototype.m = …`) targets the same object
    /// the dynamic-dispatch path reads from.
    LoadClassProto {
        dst: LocalId,
        class_id: ClassId,
    },
    /// Codegen-only: `C.prototype.m = fnValue` — reassign a method on the class
    /// prototype, keyed in the same method-key space the dynamic dispatch reads.
    StoreProtoMethod {
        class_id: ClassId,
        method: Name,
        src: LocalId,
    },
    /// Codegen-only: `proto.m = fnValue` where `proto` is the actual runtime
    /// class prototype object, not the per-class template.
    StoreMethod {
        obj: LocalId,
        method: Name,
        src: LocalId,
    },
    /// `Object.getPrototypeOf(obj)` -> obj's prototype (or null).
    GetProto {
        dst: LocalId,
        obj: LocalId,
    },
    /// A standard-library method call resolved to a runtime helper, e.g.
    /// `arr.map(cb)` -> builtin "array.map". The receiver is `recv`; `args` are
    /// the call arguments. emit_c maps the builtin name to a ts_* runtime call.
    CallBuiltin {
        dst: Option<LocalId>,
        builtin: String,
        recv: LocalId,
        args: Vec<LocalId>,
    },
    /// A static/namespace builtin call with no receiver value, e.g.
    /// `Math.sqrt(x)` -> "math.sqrt", `Number.isInteger(x)` -> "number.isInteger",
    /// `parseInt(s)` -> "global.parseInt". codegen maps to a runtime/libm call.
    CallBuiltinStatic {
        dst: Option<LocalId>,
        builtin: String,
        args: Vec<LocalId>,
    },
    /// `new Map()` / `new Set()` -> allocate a runtime Map/Set container.
    NewMap {
        dst: LocalId,
    },
    NewSet {
        dst: LocalId,
    },
    /// `Object.setPrototypeOf(obj, proto)` -> relink obj's prototype, yield obj.
    SetProto {
        dst: Option<LocalId>,
        obj: LocalId,
        proto: LocalId,
    },
    /// Codegen-only: console.log(src).
    Print {
        src: LocalId,
    },
    /// Codegen-only structured control flow: run `body` while `cond` is truthy,
    /// re-evaluating `cond_body` (the IR that recomputes `cond`) each iteration.
    /// Flow-insensitive analysis already saw the body's instructions flattened,
    /// so this only affects codegen, not the escape result.
    Loop {
        cond: LocalId,
        cond_body: Vec<Inst>,
        body: Vec<Inst>,
    },
    /// Codegen-only: if `cond` truthy run `then_body` else `else_body`.
    If {
        cond: LocalId,
        then_body: Vec<Inst>,
        else_body: Vec<Inst>,
    },
}

/// Deserialize an f64 that may arrive as a JSON number OR a numeric string.
/// serde_json mis-rounds large integer-valued floats written WITHOUT an exponent
/// (e.g. `123456789012345680000`) by ~1 ULP when they overflow u64 and fall back
/// to its float path. The exporter therefore emits such values as a numeric STRING
/// (exponential form), which we parse here with Rust's std f64 parser — that one
/// is correctly rounded. Plain numbers (the common case) pass through unchanged.
fn de_f64_lenient<'de, D>(d: D) -> Result<f64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::{self, Visitor};
    struct V;
    impl<'de> Visitor<'de> for V {
        type Value = f64;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("a number or a numeric string")
        }
        fn visit_f64<E>(self, v: f64) -> Result<f64, E> {
            Ok(v)
        }
        fn visit_i64<E>(self, v: i64) -> Result<f64, E> {
            Ok(v as f64)
        }
        fn visit_u64<E>(self, v: u64) -> Result<f64, E> {
            Ok(v as f64)
        }
        fn visit_str<E: de::Error>(self, v: &str) -> Result<f64, E> {
            v.parse::<f64>().map_err(de::Error::custom)
        }
    }
    d.deserialize_any(V)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum ConstVal {
    Num {
        #[serde(deserialize_with = "de_f64_lenient")]
        value: f64,
    },
    Str {
        value: String,
    },
    Str16 {
        units: Vec<u16>,
    },
    Bool {
        value: bool,
    },
    Undef,
    Null,
    /// NaN / +Infinity / -Infinity — these are not valid JSON numbers, so they
    /// get their own tags rather than riding in `Num`.
    NaN,
    PosInf,
    NegInf,
    /// Negative zero. JS's JSON.stringify(-0) === "0" normalizes the sign away, so
    /// the exporter can't carry -0 as a `Num`; it emits this tag for the `-0`/`-0.0`
    /// literal. Codegen materializes it as the double -0.0 (never an int local).
    NegZero,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum CalleeRef {
    /// Resolved by the type checker (devirtualized).
    Direct { func: FunctionId },
    /// Small candidate set (union receiver / overload set).
    Set { funcs: Vec<FunctionId> },
    /// A method call not yet resolved by the devirt pass: receiver's static
    /// class + method name + whether the receiver is trustworthy as that class.
    /// The devirt pass rewrites this into Direct / Set / Unknown.
    Method {
        recv_class: ClassId,
        method: Name,
        recv_stable: bool,
        /// Field-key id for the SAME name as `method` (interned in the field-key
        /// space). Lets codegen try the own-property (field-key) slot before the
        /// prototype method-key, so an own data/method property shadows a
        /// prototype method (JS own->prototype order) and object-literal methods /
        /// `{g: fn}` properties are callable. None = no field-key fallback.
        #[serde(default)]
        method_field: Option<FieldId>,
    },
    /// A call through a first-class function value held in a local (a closure
    /// stored in a variable, then invoked: `const f = () => ...; f()`). codegen
    /// emits `ts_call(value, args)`, which prepends the closure's captured env.
    Value { local: LocalId },
    /// External / unresolved → analyzer treats args + recv conservatively.
    Unknown,
}

/// One entry in a spread-containing argument list.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ArgSpec {
    /// A single argument value.
    Single { local: LocalId },
    /// `...arr`: splice all elements of this array into the call.
    Spread { local: LocalId },
}

// ---------------------------------------------------------------------------
// Result (analyzer -> codegen)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EscapeResult {
    pub version: u32,
    pub sites: Vec<SiteEscape>,
    /// Sites whose object is stored into some container (object field / array
    /// elem), i.e. it appears in the solver's field map. Such a value can
    /// outlive a loop iteration while still being NoEscape at function level,
    /// so codegen must not give it a per-iteration reused stack slot
    /// (s316 silent-miscompile: class instance kept only via arr.push /
    /// arr[i] = x collapsed to one C stack cell).
    /// serde(skip): 凍結 analyzer_ts と diff する escape ダンプの形式は変えない。
    #[serde(skip, default)]
    pub contained_sites: std::collections::BTreeSet<u32>,
    /// Escape/lifetime-proven old-generation candidates. This stays out of the
    /// serialized frozen-analyzer parity format; the production code generator
    /// consumes it in-process. Candidates are deliberately narrow:
    /// single-shot GlobalEscape sites in `__module_init`, plus loop allocation
    /// sites whose values form a retained chain or are appended to an
    /// outer-lifetime container.
    #[serde(skip, default)]
    pub pretenure_sites: std::collections::BTreeSet<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteEscape {
    pub site: SiteId,
    pub state: EscapeState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EscapeState {
    NoEscape,
    ArgEscape,
    GlobalEscape,
}
