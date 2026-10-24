//! emit_c — Escape IR -> C, with three layers, chosen per value by analysis:
//!
//!  1. UNBOXED numeric path: a `primitive` local is held as a raw C `double`,
//!     so hot arithmetic/loops never box/unbox through `tsv`. This is the key to
//!     matching/beating V8 on typed numeric code.
//!  2. SPECIALIZED class path: a known stable class instance is a prefix-layout
//!     C struct; fields are constant-offset members; NoEscape+determinable sites
//!     are stack-allocated; methods dispatch Direct/vtable.
//!  3. DYNAMIC fallback: `any`/unstable values are NaN-boxed `tsv` over the
//!     runtime object model. Always correct; the other layers are sound overlays.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write;

use crate::codegen::{decide, AllocStrategy};
use crate::devirt::ClassTable;
use crate::escape_ir::*;
use crate::string_materialization::{
    DynamicReplaceEscapeMaterialization, DynamicSplitJoinEscapeMaterialization,
    FunctionMaterializationPlan, LoopMaterializationPlan, MaterializationOp,
    StaticCaseTrimEscapeMaterialization, StaticReplaceEscapeMaterialization,
    StaticSplitJoinEscapeMaterialization, StringMaterializationPlan,
};
use crate::string_metrics::{
    CaseTrimMetric, FunctionMetricPlan, LoopMetricOp, LoopMetricPlan, MetricNeedle, MetricOp,
    StringMetricPlan,
};
use crate::string_plan::{LoopPath, PathEdge, PathSegment};

/// Dynamic-path property keys for methods are offset by a base (TS_METHOD_KEY_BASE)
/// so they never collide with field-id keys (which start at 0) in the runtime
/// property map. The base lives once in ts_rt.h; generated C uses TS_KEY_METHOD(id)
/// rather than open-coding the arithmetic here (property_model_redesign §3.6).

pub fn emit_program(program: &Program, result: &EscapeResult) -> String {
    let string_metric_plan = crate::string_metrics::analyze_program(program);
    let out = emit_program_with_string_metrics(program, result, &string_metric_plan);
    if iso_mode() {
        iso_site_caches(out)
    } else {
        out
    }
}

/// Threads, slice A1's accessor experiment (docs/threads_design.md;
/// `TSAOT_ISOLATE=1`): the program's per-isolate state (the site caches,
/// GLOBALS, CLASS_PROTO, OBJECT_PROTO) is reached through `TS_ISO()`, which
/// the runtime defines per `TS_ISO_MODE`. The default output is unchanged.
fn iso_mode() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("TSAOT_ISOLATE").as_deref() == Ok("1"))
}

/// The experiment's site caches: every `static ts_prop_ic NAME =
/// TS_PROP_IC_INIT;` becomes a pointer into the isolate's table,
/// `ts_prop_ic* const NAME = TS_ISO_IC(k);`, and every `&NAME` the pointer.
fn iso_site_caches(c: String) -> String {
    const DECL: &str = "static ts_prop_ic ";
    const INIT: &str = " = TS_PROP_IC_INIT;";
    let mut out = String::with_capacity(c.len() + c.len() / 16);
    let mut k = 0usize;
    let mut rest = c.as_str();
    while let Some(i) = rest.find(DECL) {
        let after = &rest[i + DECL.len()..];
        let name_len = after.find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_')).unwrap_or(after.len());
        if after[name_len..].starts_with(INIT) {
            out.push_str(&rest[..i]);
            let _ = write!(out, "ts_prop_ic* const {} = TS_ISO_IC({});", &after[..name_len], k);
            k += 1;
            rest = &after[name_len + INIT.len()..];
        } else {
            out.push_str(&rest[..i + DECL.len()]);
            rest = after;
        }
    }
    out.push_str(rest);
    let out = out
        .replace("&_ts_pic_", "_ts_pic_")
        .replace("&_ts_method_field_ic", "_ts_method_field_ic")
        .replace("&_ts_method_proto_ic", "_ts_method_proto_ic");
    out.replace("@@TS_ISO_NICS@@", &k.max(1).to_string())
}

pub fn emit_program_with_string_metrics(
    program: &Program,
    result: &EscapeResult,
    string_metric_plan: &StringMetricPlan,
) -> String {
    let string_materialization_plan = crate::string_materialization::analyze_program(program);
    emit_program_with_string_plans(
        program,
        result,
        string_metric_plan,
        &string_materialization_plan,
    )
}

fn builtin_needs_regexp(builtin: &str) -> bool {
    builtin == "global.RegExp" || builtin.starts_with("regexp.")
}

fn builtin_needs_unicode(builtin: &str) -> bool {
    matches!(
        builtin,
        "string.normalize"
            | "string.toUpperCase"
            | "string.toLowerCase"
            | "string.toLocaleUpperCase"
            | "string.toLocaleLowerCase"
    )
}

fn builtin_needs_fetch(builtin: &str) -> bool {
    matches!(builtin, "global.fetch" | "globalobj.fetch")
}

fn body_needs_regexp(body: &[Inst]) -> bool {
    body.iter().any(inst_needs_regexp)
}

fn inst_needs_regexp(inst: &Inst) -> bool {
    match inst {
        Inst::LoadBuiltinFn { builtin, .. }
        | Inst::CallBuiltin { builtin, .. }
        | Inst::CallBuiltinStatic { builtin, .. } => builtin_needs_regexp(builtin),
        Inst::Loop {
            cond_body, body, ..
        } => body_needs_regexp(cond_body) || body_needs_regexp(body),
        Inst::If {
            then_body,
            else_body,
            ..
        } => body_needs_regexp(then_body) || body_needs_regexp(else_body),
        Inst::TryCatch {
            try_body,
            catch_body,
            finally_body,
            ..
        } => {
            body_needs_regexp(try_body)
                || body_needs_regexp(catch_body)
                || body_needs_regexp(finally_body)
        }
        _ => false,
    }
}

fn program_needs_regexp(program: &Program) -> bool {
    program.functions.iter().any(|f| body_needs_regexp(&f.body))
}

fn body_needs_fetch(body: &[Inst]) -> bool {
    body.iter().any(inst_needs_fetch)
}

fn inst_needs_fetch(inst: &Inst) -> bool {
    match inst {
        Inst::LoadBuiltinFn { builtin, .. }
        | Inst::CallBuiltin { builtin, .. }
        | Inst::CallBuiltinStatic { builtin, .. } => builtin_needs_fetch(builtin),
        Inst::Loop {
            cond_body, body, ..
        } => body_needs_fetch(cond_body) || body_needs_fetch(body),
        Inst::If {
            then_body,
            else_body,
            ..
        } => body_needs_fetch(then_body) || body_needs_fetch(else_body),
        Inst::TryCatch {
            try_body,
            catch_body,
            finally_body,
            ..
        } => {
            body_needs_fetch(try_body)
                || body_needs_fetch(catch_body)
                || body_needs_fetch(finally_body)
        }
        _ => false,
    }
}

/// The typed array constructor values (docs/typed_arrays_design.md) are set
/// up as globals only for a program that names one as a value.
fn builtin_needs_typed_array_globals(builtin: &str) -> bool {
    matches!(
        builtin.strip_prefix("globalobj."),
        Some(
            "Int8Array"
                | "Uint8Array"
                | "Uint8ClampedArray"
                | "Int16Array"
                | "Uint16Array"
                | "Int32Array"
                | "Uint32Array"
                | "Float32Array"
                | "Float64Array"
                | "ArrayBuffer"
                | "SharedArrayBuffer"
                | "Atomics"
                | "TextEncoder"
                | "TextDecoder"
        )
    )
}

fn body_needs_typed_array_globals(body: &[Inst]) -> bool {
    body.iter().any(|inst| match inst {
        Inst::LoadBuiltinFn { builtin, .. }
        | Inst::CallBuiltin { builtin, .. }
        | Inst::CallBuiltinStatic { builtin, .. } => builtin_needs_typed_array_globals(builtin),
        Inst::Loop {
            cond_body, body, ..
        } => body_needs_typed_array_globals(cond_body) || body_needs_typed_array_globals(body),
        Inst::If {
            then_body,
            else_body,
            ..
        } => body_needs_typed_array_globals(then_body) || body_needs_typed_array_globals(else_body),
        Inst::TryCatch {
            try_body,
            catch_body,
            finally_body,
            ..
        } => {
            body_needs_typed_array_globals(try_body)
                || body_needs_typed_array_globals(catch_body)
                || body_needs_typed_array_globals(finally_body)
        }
        _ => false,
    })
}

fn program_needs_typed_array_globals(program: &Program) -> bool {
    program.functions.iter().any(|f| body_needs_typed_array_globals(&f.body))
}

fn program_needs_fetch(program: &Program) -> bool {
    program.functions.iter().any(|f| body_needs_fetch(&f.body))
}

fn body_needs_unicode(body: &[Inst], unicode_method_ids: &BTreeSet<u32>) -> bool {
    body_needs_unicode_with_facts(body, unicode_method_ids, &BTreeSet::new())
}

fn body_needs_unicode_with_facts(
    body: &[Inst],
    unicode_method_ids: &BTreeSet<u32>,
    initial_unicode_keys: &BTreeSet<u32>,
) -> bool {
    let mut unicode_key_locals = initial_unicode_keys.clone();
    for inst in body {
        if inst_needs_unicode(inst, unicode_method_ids, &unicode_key_locals) {
            return true;
        }
        update_unicode_key_facts(inst, &mut unicode_key_locals);
    }
    false
}

fn callee_needs_unicode(callee: &CalleeRef, unicode_method_ids: &BTreeSet<u32>) -> bool {
    matches!(
        callee,
        CalleeRef::Method { method, .. } if unicode_method_ids.contains(&method.0)
    )
}

fn const_value_is_unicode_method_key(value: &ConstVal) -> bool {
    const NAMES: [&str; 5] = [
        "normalize",
        "toUpperCase",
        "toLowerCase",
        "toLocaleUpperCase",
        "toLocaleLowerCase",
    ];
    match value {
        ConstVal::Str { value } => NAMES.contains(&value.as_str()),
        ConstVal::Str16 { units } => NAMES.iter().any(|name| {
            units.len() == name.len()
                && units
                    .iter()
                    .copied()
                    .zip(name.bytes())
                    .all(|(u, b)| u == u16::from(b))
        }),
        _ => false,
    }
}

fn update_unicode_key_facts(inst: &Inst, unicode_key_locals: &mut BTreeSet<u32>) {
    match inst {
        Inst::Const { dst, value } if const_value_is_unicode_method_key(value) => {
            unicode_key_locals.insert(dst.0);
        }
        Inst::Const { dst, .. } => {
            unicode_key_locals.remove(&dst.0);
        }
        Inst::Copy { dst, src } if unicode_key_locals.contains(&src.0) => {
            unicode_key_locals.insert(dst.0);
        }
        Inst::Copy { dst, .. } => {
            unicode_key_locals.remove(&dst.0);
        }
        _ => {}
    }
}

fn inst_needs_unicode(
    inst: &Inst,
    unicode_method_ids: &BTreeSet<u32>,
    unicode_key_locals: &BTreeSet<u32>,
) -> bool {
    match inst {
        Inst::LoadBuiltinFn { builtin, .. }
        | Inst::CallBuiltin { builtin, .. }
        | Inst::CallBuiltinStatic { builtin, .. } => builtin_needs_unicode(builtin),
        Inst::LoadMethodValue { method, .. } => unicode_method_ids.contains(method),
        Inst::LoadFieldDynamic { key, .. } => unicode_key_locals.contains(&key.0),
        Inst::Call { callee, .. } | Inst::CallSpread { callee, .. } => {
            callee_needs_unicode(callee, unicode_method_ids)
        }
        Inst::Loop {
            cond_body, body, ..
        } => {
            body_needs_unicode_with_facts(cond_body, unicode_method_ids, unicode_key_locals)
                || body_needs_unicode_with_facts(body, unicode_method_ids, unicode_key_locals)
        }
        Inst::If {
            then_body,
            else_body,
            ..
        } => {
            body_needs_unicode_with_facts(then_body, unicode_method_ids, unicode_key_locals)
                || body_needs_unicode_with_facts(else_body, unicode_method_ids, unicode_key_locals)
        }
        Inst::TryCatch {
            try_body,
            catch_body,
            finally_body,
            ..
        } => {
            body_needs_unicode_with_facts(try_body, unicode_method_ids, unicode_key_locals)
                || body_needs_unicode_with_facts(catch_body, unicode_method_ids, unicode_key_locals)
                || body_needs_unicode_with_facts(
                    finally_body,
                    unicode_method_ids,
                    unicode_key_locals,
                )
        }
        _ => false,
    }
}

fn program_needs_unicode(program: &Program) -> bool {
    let unicode_method_ids: BTreeSet<u32> = program
        .string_proto_methods
        .iter()
        .filter(|m| {
            matches!(
                m.name.as_str(),
                "normalize"
                    | "toUpperCase"
                    | "toLowerCase"
                    | "toLocaleUpperCase"
                    | "toLocaleLowerCase"
            )
        })
        .map(|m| m.method_id)
        .collect();
    program
        .functions
        .iter()
        .any(|f| body_needs_unicode(&f.body, &unicode_method_ids))
}

fn emit_program_with_string_plans(
    program: &Program,
    result: &EscapeResult,
    string_metric_plan: &StringMetricPlan,
    string_materialization_plan: &StringMaterializationPlan,
) -> String {
    let strat: BTreeMap<u32, AllocStrategy> = decide(program, result)
        .into_iter()
        .map(|d| (d.site.0, d.strategy))
        .collect();
    let _table = ClassTable::new(&program.classes);
    let classes: BTreeMap<u32, &ClassDef> = program.classes.iter().map(|c| (c.id.0, c)).collect();
    set_class_dfs(&program.classes);
    set_closed_receivers(program.closed_receivers.closed);
    set_method_classes(program);

    // Classes whose instances flow into a dynamic enumeration builtin
    // (JSON.stringify / Object.keys|values|entries). Such objects must keep their
    // properties in the prop map (not unboxed struct fields), so the runtime can
    // enumerate them. We therefore exclude these classes from the typed-struct
    // field layout and struct field access, falling back to ts_set/ts_get. This
    // trades some speed for correctness, but enumeration is rarely on a hot path.
    // A-2b/Stage-B: enumeration is unified via ts_prop_own_enum (descriptor-aware),
    // so the old "enumerated class" demotion (which forced fields into the prop map
    // and disabled struct optimization) is no longer needed and has been removed.
    let fclass = func_class(program);
    // Well-known symbol method-name id -> wksym id (§3.6): codegen emits a stable
    // TS_KEY_WKSYM key for these instead of a position-dependent method-name key.
    let wksym: BTreeMap<u32, u32> = program
        .well_known_symbols
        .iter()
        .map(|w| (w.name_id.0, w.wksym_id))
        .collect();

    let fn_names: BTreeMap<u32, String> = program
        .functions
        .iter()
        .map(|f| (f.id.0, cname(f)))
        .collect();
    let fn_takes_this: BTreeMap<u32, bool> = program
        .functions
        .iter()
        .map(|f| (f.id.0, f.takes_this))
        .collect();
    set_fn_capture_counts(program);
    set_type_field_counts(program);
    set_length_fields(program);
    let indirect_funcs = infer_indirect_funcs(program);
    let param_facts_by_func = infer_program_param_facts(program, &indirect_funcs);
    let i64_fast = infer_i64_fast_funcs(program, &indirect_funcs, &param_facts_by_func);
    let f64_fast = infer_f64_fast_funcs(program, &indirect_funcs, &i64_fast);
    let typed_keys_by_func = typed_key_locals(program);
    let static_strings = collect_static_string_literals(program);
    let needs_regexp = program_needs_regexp(program);
    let needs_unicode = program_needs_unicode(program);
    let needs_fetch = program_needs_fetch(program);
    let needs_typed_array_globals = program_needs_typed_array_globals(program);

    let mut s = String::new();
    s.push_str("/* generated by emit_c (unboxed numeric + specialized class + dynamic) */\n");
    s.push_str("#include \"ts_rt.h\"\n\n");
    if needs_regexp {
        s.push_str("#define TSAOT_NEEDS_REGEXP 1\n");
        s.push_str("#include \"regexp/ts_regexp_adapter.h\"\n\n");
    }
    if needs_unicode {
        s.push_str("#define TSAOT_NEEDS_UNICODE 1\n");
        s.push_str("#include \"unicode/ts_unicode_adapter.h\"\n\n");
    }
    if needs_fetch {
        s.push_str("#define TSAOT_NEEDS_FETCH 1\n\n");
    }
    s.push_str("#if defined(__GNUC__) || defined(__clang__)\n");
    s.push_str("#define TS_AOT_INLINE static inline __attribute__((always_inline))\n");
    s.push_str("#else\n");
    s.push_str("#define TS_AOT_INLINE static inline\n");
    s.push_str("#endif\n");
    if inline_hint_enabled() {
        s.push_str("#define TS_AOT_HINT static inline\n");
    }
    s.push_str("\n");

    emit_static_string_literals(&mut s, &static_strings);
    emit_class_layout(&mut s, &classes);

    for f in &program.functions {
        let _ = writeln!(s, "static tsv {}(tsv* args, int nargs);", cname(f));
    }
    let direct_sigs = direct_entry_sigs(program, &fclass, &param_facts_by_func, &i64_fast);
    let known_methods = known_method_closures(program);
    for f in &program.functions {
        if let Some(sig) = direct_sigs.get(&f.id.0) {
            let storage = direct_entry_storage(f);
            let _ = writeln!(s, "{} {} {}_d({});", storage, sig.c_ret(), cname(f), sig.c_params());
        }
    }
    if needs_regexp {
        s.push_str("static tsv ts_regexpproto_test(tsv* args, int nargs);\n");
        s.push_str("static tsv ts_regexpproto_exec(tsv* args, int nargs);\n");
    }
    for f in &program.functions {
        if let Some(info) = i64_fast.get(&f.id.0) {
            let params = if info.params.is_empty() {
                "void".to_string()
            } else {
                (0..info.params.len())
                    .map(|_| "long long")
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            let storage = if force_inline_numeric_func(f) {
                "TS_AOT_INLINE"
            } else if hint_body(f) {
                "TS_AOT_HINT"
            } else {
                "static"
            };
            let _ = writeln!(s, "{} long long {}({});", storage, i64_cname(f), params);
        }
    }
    for f in &program.functions {
        if let Some(info) = f64_fast.get(&f.id.0) {
            let params = if info.params.is_empty() {
                "void".to_string()
            } else {
                (0..info.params.len())
                    .map(|_| "double")
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            let storage = if force_inline_numeric_func(f) {
                "TS_AOT_INLINE"
            } else if hint_body(f) {
                "TS_AOT_HINT"
            } else {
                "static"
            };
            let _ = writeln!(s, "{} double {}({});", storage, f64_cname(f), params);
        }
    }
    s.push('\n');
    let maxid = program.functions.iter().map(|f| f.id.0).max().unwrap_or(0);
    // All four ABI metadata tables use the same sparse function-ID domain.
    // Index once instead of searching every function for every table entry.
    let mut functions_by_id = vec![None; maxid as usize + 1];
    for function in &program.functions {
        functions_by_id[function.id.0 as usize].get_or_insert(function);
    }
    s.push_str("typedef tsv (*ts_fn)(tsv*, int);\n");
    let _ = write!(s, "static ts_fn FN_TABLE[{}] = {{", maxid + 1);
    for i in 0..=maxid {
        match functions_by_id[i as usize] {
            Some(f) => {
                let _ = write!(s, "{}, ", cname(f));
            }
            None => {
                s.push_str("0, ");
            }
        }
    }
    s.push_str("};\n");
    emit_vtables(&mut s, program, &classes, &direct_sigs, &fn_takes_this, &|id| {
        functions_by_id.get(id as usize).copied().flatten().map(cname).unwrap_or_default()
    });
    // Per-function first-class metadata (`fn.length` arity, `fn.name`) indexed by
    // function id, set on a boxed function value in AllocClosure.
    let _ = write!(s, "static const uint32_t FN_ARITY[{}] = {{", maxid + 1);
    for i in 0..=maxid {
        let a = functions_by_id[i as usize]
            .map(|f| f.arity)
            .unwrap_or(0);
        let _ = write!(s, "{}, ", a);
    }
    s.push_str("};\n");
    let _ = write!(s, "static const char* FN_NAME[{}] = {{", maxid + 1);
    for i in 0..=maxid {
        let nm = functions_by_id[i as usize]
            .and_then(|f| f.name.as_deref())
            // a synthesized __module_init / anonymous fn has no JS name -> "".
            .filter(|n| !n.starts_with("__"))
            .unwrap_or("");
        let _ = write!(s, "{:?}, ", nm);
    }
    s.push_str("};\n\n");
    let _ = write!(
        s,
        "static const uint8_t FN_HAS_PROTOTYPE[{}] = {{",
        maxid + 1
    );
    for i in 0..=maxid {
        let hp = functions_by_id[i as usize]
            .map(|f| f.has_prototype)
            .unwrap_or(false);
        let _ = write!(s, "{}, ", if hp { 1 } else { 0 });
    }
    s.push_str("};\n\n");

    // Per-class prototype objects for the DYNAMIC dispatch path. Each class gets a
    // prototype object holding its methods (name-id key -> FN_TABLE index, stored
    // as a number, mirroring the closure convention). Instances that take the
    // dynamic path get their `proto` set to this; `obj.m()` then resolves via the
    // runtime prototype chain (`ts_get`) + an indirect FN_TABLE call. Prototypes
    // are GC roots (held in a static array, rooted in setup).
    let max_class = program.classes.iter().map(|c| c.id.0).max();
    let max_class_id = max_class.unwrap_or(0);
    let _ = write!(
        s,
        "static const char* CLASS_NAME[{}] = {{",
        max_class_id + 1
    );
    for i in 0..=max_class_id {
        let nm = program
            .classes
            .iter()
            .find(|c| c.id.0 == i)
            .and_then(|c| c.name.as_deref())
            .unwrap_or("");
        let _ = write!(s, "{:?}, ", nm);
    }
    s.push_str("};\n\n");
    // Object.prototype: a shared prototype carrying the modeled Object.prototype
    // methods under METHOD_KEY_BASE+id. Held in a rooted static; installed
    // via ts_install_object_proto so ts_new_object() chains new objects to it.
    if iso_mode() {
        s.push_str("#define OBJECT_PROTO (TS_ISO()->object_proto)\n");
    } else {
        s.push_str("static tsv OBJECT_PROTO;\n");
    }
    s.push_str("static void ts_setup_object_proto(void){\n");
    s.push_str("  OBJECT_PROTO = ts_new_proto(); ts_gc_root(&OBJECT_PROTO);\n");
    // Install Object.prototype, then init Function.prototype, BEFORE boxing the
    // methods below. The boxed methods (ts_make_fn_t) record their own proto as
    // g_function_proto at creation time; if it were still NULL, `o.toString.call`/
    // `.apply`/`.bind` (the boxed method taken as a value) couldn't resolve
    // Function.prototype.call. ts_function_proto_init chains Function.prototype to
    // Object.prototype, so Object.prototype must be installed first. (The later
    // ts_setup_function_proto() call is idempotent via the init guard.)
    s.push_str("  ts_install_object_proto(OBJECT_PROTO);\n");
    s.push_str("  ts_function_proto_init();\n");
    for m in &program.object_proto_methods {
        // Object.prototype methods read args[0]
        // as `this`, so they MUST carry takes_this=1: the dynamic method-dispatch
        // path (ts_call_method) drops the receiver for callees that lack it.
        let _ = writeln!(
            s,
            "  ts_object_proto_register(TS_KEY_METHOD({}u), {}, {});",
            m.method_id,
            c_string_lit(&m.name),
            m.runtime
        );
        // tell the runtime the toString method-key so ts_to_string_v can invoke a
        // (possibly user-overridden) toString during string coercion.
        if m.name == "toString" {
            let _ = writeln!(s, "  ts_set_tostring_key(TS_KEY_METHOD({}u));", m.method_id);
        }
        if m.name == "valueOf" {
            let _ = writeln!(s, "  ts_set_valueof_key(TS_KEY_METHOD({}u));", m.method_id);
        }
        // user `toJSON` method-key so JSON.stringify can invoke it on class instances.
        if m.name == "toJSON" {
            let _ = writeln!(s, "  ts_set_tojson_key(TS_KEY_METHOD({}u));", m.method_id);
        }
    }
    s.push_str("}\n\n");
    // Array.prototype setup (unified object model): register each array builtin
    // wrapper on the runtime Array.prototype under its method-key, so a dynamic
    // arr.method() (e.g. on an any-typed array) resolves via the prototype chain.
    s.push_str("static void ts_setup_array_proto(void){\n");
    s.push_str("  ts_array_proto_init();\n");
    for m in &program.array_proto_methods {
        let _ = writeln!(
            s,
            "  ts_array_proto_register(TS_KEY_METHOD({}u), {}, {});",
            m.method_id,
            c_string_lit(&m.name),
            m.runtime
        );
    }
    s.push_str("}\n\n");
    // Promise.prototype setup: then/catch/finally as first-class method values
    // (ts_get on a promise delegates to this proto by kind).
    s.push_str("static void ts_setup_promise_proto(void){\n");
    s.push_str("  ts_promise_proto_init();\n");
    for m in &program.promise_proto_methods {
        let _ = writeln!(
            s,
            "  ts_promise_proto_register(TS_KEY_METHOD({}u), {}, {});",
            m.method_id,
            c_string_lit(&m.name),
            m.runtime
        );
    }
    s.push_str("}\n\n");
    // Map.prototype / Set.prototype setup (followon to U-5): register each builtin
    // wrapper so a dynamic m.get()/s.has() (any-typed) resolves via the proto chain.
    s.push_str("static void ts_setup_map_proto(void){\n");
    s.push_str("  ts_map_proto_init();\n");
    for m in &program.map_proto_methods {
        let _ = writeln!(
            s,
            "  ts_map_proto_register(TS_KEY_METHOD({}u), {}, {});",
            m.method_id,
            c_string_lit(&m.name),
            m.runtime
        );
    }
    s.push_str("}\n\n");
    s.push_str("static void ts_setup_set_proto(void){\n");
    s.push_str("  ts_set_proto_init();\n");
    for m in &program.set_proto_methods {
        let _ = writeln!(
            s,
            "  ts_set_proto_register(TS_KEY_METHOD({}u), {}, {});",
            m.method_id,
            c_string_lit(&m.name),
            m.runtime
        );
    }
    s.push_str("}\n\n");
    s.push_str("static void ts_setup_weakmap_proto(void){\n");
    s.push_str("  ts_weakmap_proto_init();\n");
    for m in &program.weak_map_proto_methods {
        let _ = writeln!(
            s,
            "  ts_weakmap_proto_register(TS_KEY_METHOD({}u), {}, {});",
            m.method_id,
            c_string_lit(&m.name),
            m.runtime
        );
    }
    s.push_str("}\n\n");
    s.push_str("static void ts_setup_weakset_proto(void){\n");
    s.push_str("  ts_weakset_proto_init();\n");
    for m in &program.weak_set_proto_methods {
        let _ = writeln!(
            s,
            "  ts_weakset_proto_register(TS_KEY_METHOD({}u), {}, {});",
            m.method_id,
            c_string_lit(&m.name),
            m.runtime
        );
    }
    s.push_str("}\n\n");
    s.push_str("static void ts_setup_headers_proto(void){\n");
    s.push_str("  ts_headers_proto_init();\n");
    for m in &program.headers_proto_methods {
        let _ = writeln!(
            s,
            "  ts_headers_proto_register(TS_KEY_METHOD({}u), {}, {});",
            m.method_id,
            c_string_lit(&m.name),
            m.runtime
        );
    }
    s.push_str("}\n\n");
    s.push_str("static void ts_setup_function_proto(void){\n");
    s.push_str("  ts_function_proto_init();\n");
    for m in &program.function_proto_methods {
        let _ = writeln!(
            s,
            "  ts_function_proto_register(TS_KEY_METHOD({}u), {}, {});",
            m.method_id,
            c_string_lit(&m.name),
            m.runtime
        );
    }
    s.push_str("}\n\n");
    // String.prototype: registers builtin string methods so a call on an any-typed
    // string resolves dynamically through ts_get -> String.prototype.
    s.push_str("static void ts_setup_string_proto(void){\n");
    s.push_str("  ts_string_proto_init();\n");
    for m in &program.string_proto_methods {
        if m.name == "normalize" && !needs_unicode {
            continue;
        }
        let runtime = if needs_unicode && m.name == "toUpperCase" {
            "ts_unicode_strproto_toUpperCase"
        } else if needs_unicode && m.name == "toLowerCase" {
            "ts_unicode_strproto_toLowerCase"
        } else if needs_unicode && m.name == "toLocaleUpperCase" {
            "ts_unicode_strproto_toLocaleUpperCase"
        } else if needs_unicode && m.name == "toLocaleLowerCase" {
            "ts_unicode_strproto_toLocaleLowerCase"
        } else {
            &m.runtime
        };
        let _ = writeln!(
            s,
            "  ts_string_proto_register(TS_KEY_METHOD({}u), {}, {});",
            m.method_id,
            c_string_lit(&m.name),
            runtime
        );
    }
    s.push_str("}\n\n");
    if needs_regexp {
        s.push_str("static void ts_setup_regexp_proto(void){\n");
        s.push_str("  ts_regexp_proto_init();\n");
        for m in &program.regexp_proto_methods {
            let _ = writeln!(
                s,
                "  ts_regexp_proto_register(TS_KEY_METHOD({}u), {}, {});",
                m.method_id,
                c_string_lit(&m.name),
                m.runtime
            );
        }
        s.push_str("}\n\n");
        s.push_str("static tsv ts_regexpproto_test(tsv* args, int nargs){\n");
        s.push_str("  if(nargs < 1 || !ts_regexp_is_object(args[0])) { ts_throw_type_error_msg(\"RegExp.prototype.test called on incompatible receiver\"); return TS_UNDEFINED; }\n");
        s.push_str("  tsv input = nargs > 1 ? args[1] : TS_UNDEFINED;\n");
        s.push_str("  tsv s = ts_to_string_v(input);\n");
        s.push_str("  return ts_regexp_adapter_object_test_tsv(args[0], s);\n");
        s.push_str("}\n");
        s.push_str("static tsv ts_regexpproto_exec(tsv* args, int nargs){\n");
        s.push_str("  if(nargs < 1 || !ts_regexp_is_object(args[0])) { ts_throw_type_error_msg(\"RegExp.prototype.exec called on incompatible receiver\"); return TS_UNDEFINED; }\n");
        s.push_str("  tsv input = nargs > 1 ? args[1] : TS_UNDEFINED;\n");
        s.push_str("  tsv s = ts_to_string_v(input);\n");
        s.push_str("  return ts_regexp_adapter_object_exec_tsv(args[0], s);\n");
        s.push_str("}\n\n");
    } else {
        s.push_str("static void ts_setup_regexp_proto(void){}\n\n");
    }
    // Number.prototype: builtin number methods for any-typed number dispatch.
    s.push_str("static void ts_setup_number_proto(void){\n");
    s.push_str("  ts_number_proto_init();\n");
    for m in &program.number_proto_methods {
        let _ = writeln!(
            s,
            "  ts_number_proto_register(TS_KEY_METHOD({}u), {}, {});",
            m.method_id,
            c_string_lit(&m.name),
            m.runtime
        );
    }
    s.push_str("}\n\n");
    // Boolean.prototype: builtin boolean methods for any-typed boolean dispatch.
    s.push_str("static void ts_setup_boolean_proto(void){\n");
    s.push_str("  ts_boolean_proto_init();\n");
    for m in &program.boolean_proto_methods {
        let _ = writeln!(
            s,
            "  ts_boolean_proto_register(TS_KEY_METHOD({}u), {}, {});",
            m.method_id,
            c_string_lit(&m.name),
            m.runtime
        );
    }
    s.push_str("}\n\n");

    // Module-level globals (top-level `var`/`let`/`const`). Stored as a static
    // tsv array indexed by GlobalId, gc-rooted once at startup. LoadGlobal /
    // StoreGlobal compile to direct slot reads/writes. Default value is
    // TS_UNDEFINED (matching JS hoisted-var semantics — the binding exists
    // before the initializer runs).
    let nglobals = program.globals.len();
    if nglobals > 0 {
        if iso_mode() {
            let _ = writeln!(s, "static tsv GLOBALS_ISO0[{}];\n#define GLOBALS (TS_ISO()->globals)", nglobals);
        } else {
            let _ = writeln!(s, "static tsv GLOBALS[{}];", nglobals);
        }
        s.push_str("static void ts_setup_globals(void){\n");
        for g in &program.globals {
            let _ = writeln!(
                s,
                "  GLOBALS[{}] = TS_UNDEFINED; ts_gc_root(&GLOBALS[{}]);",
                g.id.0, g.id.0
            );
        }
        s.push_str("}\n\n");
    } else {
        s.push_str("static void ts_setup_globals(void){}\n\n");
    }

    if let Some(maxc) = max_class {
        if iso_mode() {
            let _ = writeln!(s, "static tsv CLASS_PROTO_ISO0[{}];\n#define CLASS_PROTO (TS_ISO()->class_proto)", maxc + 1);
        } else {
            let _ = writeln!(s, "static tsv CLASS_PROTO[{}];", maxc + 1);
        }
        s.push_str("static void ts_setup_prototypes(void){\n");
        for c in &program.classes {
            let _ = writeln!(
                s,
                "  CLASS_PROTO[{}] = ts_new_proto(); ts_gc_root(&CLASS_PROTO[{}]);",
                c.id.0, c.id.0
            );
            if class_index_enabled() {
                // a class prototype's mark (TS_CLS_PROTO, ts_rt.h)
                let _ = writeln!(s, "  ((ts_object*)ts_ptr(CLASS_PROTO[{}]))->cls = TS_CLS_PROTO;", c.id.0);
            }
        }
        // Link each prototype to its parent's prototype, forming a real JS
        // prototype chain (Sub.prototype.__proto__ = Base.prototype). Method
        // lookup walks this chain at runtime via ts_get, so inherited methods are
        // found on the parent prototype rather than being flattened/copied into
        // the child. This makes runtime parent-prototype mutation propagate to
        // subclasses, matching JS semantics.
        for c in &program.classes {
            if let Some(p) = c.parent {
                let _ = writeln!(
                    s,
                    "  ts_set_proto(CLASS_PROTO[{}], CLASS_PROTO[{}]);",
                    c.id.0, p.0
                );
            } else if let Some(kind) = c.error_proto_kind {
                // `class X extends Error`: chain X.prototype to the shared runtime
                // Error.prototype so instances are `instanceof Error` and inherit
                // `name`/`message` from it.
                let _ = writeln!(
                    s,
                    "  ts_set_proto(CLASS_PROTO[{}], ts_error_proto({}));",
                    c.id.0, kind
                );
            } else {
                // root class (no parent): chain its prototype to Object.prototype so
                // class instances inherit toString/valueOf/hasOwnProperty too.
                let _ = writeln!(s, "  ts_set_proto(CLASS_PROTO[{}], OBJECT_PROTO);", c.id.0);
            }
        }
        // Register ONLY each class's own methods on its own prototype; inherited
        // methods are resolved through the proto chain above (no flattening). Each
        // string-named method/accessor is also installed under its field key with
        // JS method attributes, so Object.getOwnPropertyNames/descriptors observe
        // `constructor,m,x` while dynamic dispatch can continue using method keys.
        for c in &program.classes {
            let ctor_key = field_key_str("constructor");
            let _ = writeln!(
                s,
                "  ts_define_data(CLASS_PROTO[{}], {}, TS_UNDEFINED, 0, 1, 1);",
                c.id.0, ctor_key
            );
            let mut accessors: Vec<(Vec<u16>, Option<String>, Option<String>)> = Vec::new();
            for (idx, m) in c.own_methods.iter().enumerate() {
                let mfn = program.functions.iter().find(|f| f.id.0 == m.func.0);
                let fname = mfn.map(cname).unwrap_or_else(|| format!("fn_{}", m.func.0));
                // Methods read args[0] as `this`; preserve takes_this so the dynamic
                // dispatch path (ts_call_method) keeps the receiver in slot 0 rather
                // than dropping it as it does for arrow/plain function values.
                let tt = if mfn.map(|f| f.takes_this).unwrap_or(true) {
                    1
                } else {
                    0
                };
                let var = format!("_c{}_m{}", c.id.0, idx);
                let _ = writeln!(s, "  tsv {} = ts_make_fn_t({}, 0, 0, {});", var, fname, tt);
                let _ = writeln!(
                    s,
                    "  ts_define_data(CLASS_PROTO[{}], {}, {}, 0, 1, 1);",
                    c.id.0,
                    method_key_str(m.name.0, &wksym),
                    var
                );
                if let Some(prop_units) = method_prop_name_units(m) {
                    let prop_key = field_key_units(&prop_units);
                    match m.kind {
                        MethodKind::Method => {
                            let _ = writeln!(
                                s,
                                "  ts_define_data(CLASS_PROTO[{}], {}, {}, 0, 1, 1);",
                                c.id.0, prop_key, var
                            );
                        }
                        MethodKind::Getter | MethodKind::Setter => {
                            let pos = match accessors
                                .iter()
                                .position(|(name, _, _)| name == &prop_units)
                            {
                                Some(pos) => pos,
                                None => {
                                    accessors.push((prop_units.clone(), None, None));
                                    accessors.len() - 1
                                }
                            };
                            if matches!(m.kind, MethodKind::Getter) {
                                accessors[pos].1 = Some(var.clone());
                            } else {
                                accessors[pos].2 = Some(var.clone());
                            }
                            let getter = accessors[pos].1.as_deref().unwrap_or("TS_UNDEFINED");
                            let setter = accessors[pos].2.as_deref().unwrap_or("TS_UNDEFINED");
                            let _ = writeln!(
                                s,
                                "  ts_define_accessor_attr(CLASS_PROTO[{}], {}, {}, {}, 1, 1, 0, 1);",
                                c.id.0, prop_key, getter, setter
                            );
                        }
                    }
                }
            }
        }
        s.push_str("}\n\n");
    }

    // Class field descriptors: let the runtime inspector (console.dir / console.log
    // of an object) render typed class instances as `{ field: value, ... }` by
    // reading struct fields at their offsets. Without this, instances whose fields
    // live in the typed C struct (not the prop map) would print as `{}`.
    emit_class_descriptors(&mut s, program);

    // First-class static builtin function VALUES: emit a ts_code adapter for each
    // distinct builtin actually referenced as a value (LoadBuiltinFn). Each adapter
    // boxes the same runtime helper/libm the call path uses. Only generated for
    // referenced builtins (no header changes, minimal output).
    {
        let mut builtins: BTreeSet<&str> = BTreeSet::new();
        fn scan<'a>(body: &'a [Inst], out: &mut BTreeSet<&'a str>) {
            for inst in body {
                match inst {
                    Inst::LoadBuiltinFn { builtin, .. } => {
                        out.insert(builtin.as_str());
                    }
                    Inst::Loop {
                        cond_body, body, ..
                    } => {
                        scan(cond_body, out);
                        scan(body, out);
                    }
                    Inst::If {
                        then_body,
                        else_body,
                        ..
                    } => {
                        scan(then_body, out);
                        scan(else_body, out);
                    }
                    Inst::TryCatch {
                        try_body,
                        catch_body,
                        finally_body,
                        ..
                    } => {
                        scan(try_body, out);
                        scan(catch_body, out);
                        scan(finally_body, out);
                    }
                    _ => {}
                }
            }
        }
        for f in &program.functions {
            scan(&f.body, &mut builtins);
        }
        for b in global_fn_value_builtins() {
            if *b == "global.fetch" && !needs_fetch {
                continue;
            }
            builtins.insert(b);
        }
        for b in &builtins {
            if let Some(body) = fnval_adapter_body(b) {
                let _ = writeln!(
                    s,
                    "static tsv {}(tsv* a, int n){{ (void)a; (void)n; {} }}",
                    fnval_adapter_name(b),
                    body
                );
            }
        }
    }
    emit_global_setup(&mut s, needs_fetch, needs_typed_array_globals);

    let empty_param_facts: BTreeMap<u32, NumFact> = BTreeMap::new();
    for f in &program.functions {
        let f_string_metrics = string_metric_plan.functions.get(&f.id.0);
        let f_string_materializations = string_materialization_plan.functions.get(&f.id.0);
        let pf = param_facts_by_func
            .get(&f.id.0)
            .unwrap_or(&empty_param_facts);
        if let Some(info) = i64_fast.get(&f.id.0) {
            emit_i64_function(
                &mut s,
                f,
                info,
                &strat,
                &classes,
                &fclass,
                &fn_names,
                &wksym,
                &fn_takes_this,
                &i64_fast,
                &f64_fast,
                &direct_sigs,
                &known_methods,
                &static_strings,
                f_string_metrics,
                f_string_materializations,
                typed_keys_by_func.get(&f.id.0),
            );
        }
        if let Some(info) = f64_fast.get(&f.id.0) {
            emit_f64_function(
                &mut s,
                f,
                info,
                &strat,
                &classes,
                &fclass,
                &fn_names,
                &wksym,
                &fn_takes_this,
                &i64_fast,
                &f64_fast,
                &direct_sigs,
                &known_methods,
                &static_strings,
                f_string_metrics,
                f_string_materializations,
                typed_keys_by_func.get(&f.id.0),
            );
        }
        emit_function(
            &mut s,
            f,
            &strat,
            &classes,
            &fclass,
            &fn_names,
            &wksym,
            &fn_takes_this,
            pf,
            &i64_fast,
            &f64_fast,
            &direct_sigs,
            &known_methods,
            &static_strings,
            f_string_metrics,
            f_string_materializations,
            typed_keys_by_func.get(&f.id.0),
        );
    }

    // Field-id -> name table, so JSON.stringify / Object.keys can recover string
    // property names at runtime, and JSON.parse can intern names to the same ids
    // the compiler used (dot access stays consistent).
    {
        let maxid = program.fields.iter().map(|f| f.id.0).max();
        if let Some(maxid) = maxid {
            let n = maxid + 1;
            let mut names: Vec<Vec<u8>> = vec![Vec::new(); n as usize];
            for f in &program.fields {
                if (f.id.0 as usize) < names.len() {
                    names[f.id.0 as usize] = field_key_bytes_from_units(&field_name_units(f));
                }
            }
            for (i, nm) in names.iter().enumerate() {
                let mut bytes = nm.clone();
                bytes.push(0);
                let _ = writeln!(
                    s,
                    "static const char FIELD_NAME_{}[] = {};",
                    i,
                    c_byte_array_lit(&bytes)
                );
            }
            let _ = writeln!(s, "static const char* const FIELD_NAMES[] = {{");
            for i in 0..names.len() {
                let _ = writeln!(s, "  FIELD_NAME_{},", i);
            }
            let _ = writeln!(s, "}};");
            let _ = writeln!(s, "static const uint32_t FIELD_NAME_LENS[] = {{");
            for nm in &names {
                let _ = writeln!(s, "  {}u,", nm.len());
            }
            let _ = writeln!(s, "}};");
            let _ = writeln!(s, "static const uint32_t FIELD_NAMES_COUNT = {};", n);
        } else {
            s.push_str("static const char* const FIELD_NAMES[] = {0};\nstatic const uint32_t FIELD_NAME_LENS[] = {0};\nstatic const uint32_t FIELD_NAMES_COUNT = 0;\n");
        }
    }

    // Step C entry policy: if a `__module_init` exists, it holds the top-level
    // statements (including any top-level `main();`), owns module-binding cells,
    // and threads them into the functions it calls — so running it executes the
    // program. If there's no __module_init (no top-level non-decl statements),
    // fall back to calling `main`, else the first function (legacy).
    let mut entry_fn = program
        .functions
        .iter()
        .find(|f| f.name.as_deref() == Some("__module_init"));
    if entry_fn.is_none() {
        entry_fn = program
            .functions
            .iter()
            .find(|f| f.name.as_deref() == Some("main"))
            .or_else(|| program.functions.first());
    }
    if iso_mode() {
        // the site caches' table, sized once every cache is numbered
        s.push_str("static ts_prop_ic TS_ICS_ISO0[@@TS_ISO_NICS@@];\n");
    }
    s.push_str("int main(void){\n");
    if iso_mode() {
        s.push_str("  TS_ISO()->ics = TS_ICS_ISO0;\n");
        if !program.globals.is_empty() {
            s.push_str("  TS_ISO()->globals = GLOBALS_ISO0;\n");
        }
        if max_class.is_some() {
            s.push_str("  TS_ISO()->class_proto = CLASS_PROTO_ISO0;\n");
        }
    }
    s.push_str("  ts_init_fields(FIELD_NAMES, FIELD_NAME_LENS, FIELD_NAMES_COUNT);\n");
    s.push_str("  ts_setup_object_proto();\n");
    // Function.prototype must be set up BEFORE the array/map/set prototypes: each
    // proto method is boxed via ts_make_fn (which records Function.prototype
    // at creation time), so if Function.prototype is still absent the boxed method has
    // no prototype and `arr.push.call/.bind/.apply` (the method taken as a value)
    // can't resolve Function.prototype.call. (object_proto stays first so the
    // function proto can chain to Object.prototype.)
    s.push_str("  ts_setup_function_proto();\n");
    s.push_str("  ts_setup_array_proto();\n");
    s.push_str("  ts_setup_promise_proto();\n");
    s.push_str("  ts_setup_map_proto();\n");
    s.push_str("  ts_setup_set_proto();\n");
    s.push_str("  ts_setup_weakmap_proto();\n");
    s.push_str("  ts_setup_weakset_proto();\n");
    s.push_str("  ts_setup_headers_proto();\n");
    s.push_str("  ts_setup_string_proto();\n");
    if needs_regexp {
        s.push_str("  ts_setup_regexp_proto();\n");
    }
    s.push_str("  ts_setup_number_proto();\n");
    s.push_str("  ts_setup_boolean_proto();\n");
    s.push_str("  ts_setup_global_object();\n");
    if closed_receivers() {
        // the runtime's raise points stop a closed program (an analysis miss)
        s.push_str("  g_closed_receivers = 1;\n");
    }
    if conservative_roots_enabled() {
        // the collectors scan the native stack for the roots the functions no
        // longer keep in frames (docs/conservative_roots_design.md)
        s.push_str("  g_conservative_roots = 1;\n");
    }
    s.push_str("  ts_setup_globals();\n");
    if site_stats_enabled() {
        s.push_str("  ts_site_stats_init((const char**)FN_NAME, (uint32_t)(sizeof(FN_NAME) / sizeof(FN_NAME[0])));\n");
    }
    if max_class.is_some() {
        s.push_str("  ts_setup_prototypes();\n");
    }
    s.push_str("  ts_register_classes();\n");
    if let Some(ff) = program
        .functions
        .iter()
        .find(|f| f.name.as_deref() == Some("__function_values_init"))
    {
        emit_entry_call(&mut s, ff);
    }
    // Step F: static initialization. When a __module_init exists it calls each
    // class's __static_init at the class's source position (so static
    // initializers observe earlier module bindings). Only when there is NO
    // __module_init (no top-level statements at all) do we call them here, in
    // function order, as a fallback.
    let has_module_init = program
        .functions
        .iter()
        .any(|f| f.name.as_deref() == Some("__module_init"));
    if !has_module_init {
        for f in program.functions.iter() {
            if let Some(n) = f.name.as_deref() {
                if n.starts_with("__static_init_") {
                    emit_entry_call(&mut s, f);
                }
            }
        }
    }
    if let Some(mf) = entry_fn {
        emit_entry_call(&mut s, mf);
    }
    // Drive the microtask/I/O event loop so async work (promises, fetch, awaits)
    // completes before the program exits, like a JS runtime.
    s.push_str("  ts_run_event_loop();\n");
    s.push_str("  if (getenv(\"TSAOT_GC_AT_EXIT\")) ts_gc_collect();\n  return 0;\n}\n");
    s
}

fn cname(f: &Function) -> String {
    match &f.name {
        Some(n) if !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') => {
            format!("fn_{}_{}", f.id.0, n)
        }
        _ => format!("fn_{}", f.id.0),
    }
}
fn i64_cname(f: &Function) -> String {
    format!("{}_i64", cname(f))
}
fn f64_cname(f: &Function) -> String {
    format!("{}_f64", cname(f))
}
fn struct_name(id: u32) -> String {
    format!("Class{}", id)
}

/// Depth-first class numbering (docs/class_index_dispatch_design.md): the
/// class forest walked from its roots in id order, children in id order. A
/// sized instance's header carries its class's index plus one (`cls`), so a
/// class and its subclasses are the interval `[index, index + span)`.
pub(crate) struct ClassDfs {
    index: BTreeMap<u32, u32>,
    span: BTreeMap<u32, u32>,
    /// The interval of a class describes its instances' prototype chains: the
    /// subtree is stable (nobody relinks its prototypes or redefines its
    /// methods) and its root extends nothing the table does not record (a
    /// library class, a class-valued constant, a mixin expression).
    ranged: BTreeSet<u32>,
}

thread_local! {
    static CLASS_DFS: std::cell::RefCell<std::rc::Rc<ClassDfs>> = std::cell::RefCell::new(std::rc::Rc::new(ClassDfs {
        index: BTreeMap::new(),
        span: BTreeMap::new(),
        ranged: BTreeSet::new(),
    }));
}

fn compute_class_dfs(classes: &[ClassDef]) -> ClassDfs {
    let ids: BTreeSet<u32> = classes.iter().map(|c| c.id.0).collect();
    let by_id: BTreeMap<u32, &ClassDef> = classes.iter().map(|c| (c.id.0, c)).collect();
    let mut children: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    let mut roots: Vec<u32> = Vec::new();
    for c in classes {
        match c.parent {
            Some(p) if ids.contains(&p.0) && p.0 != c.id.0 => children.entry(p.0).or_default().push(c.id.0),
            _ => roots.push(c.id.0),
        }
    }
    for v in children.values_mut() {
        v.sort_unstable();
    }
    roots.sort_unstable();
    let mut dfs = ClassDfs { index: BTreeMap::new(), span: BTreeMap::new(), ranged: BTreeSet::new() };
    let mut next = 0u32;
    fn visit(c: u32, children: &BTreeMap<u32, Vec<u32>>, dfs: &mut ClassDfs, next: &mut u32) {
        let lo = *next;
        dfs.index.insert(c, lo);
        *next += 1;
        if let Some(ch) = children.get(&c) {
            for &k in ch {
                visit(k, children, dfs, next);
            }
        }
        dfs.span.insert(c, *next - lo);
    }
    for &r in &roots {
        visit(r, &children, &mut dfs, &mut next);
    }
    let foreign_base = |c: &ClassDef| {
        c.reasons.iter().any(|r| {
            r.starts_with("extends-non-identifier") || r.starts_with("extends-value") || r.starts_with("extends-library") || r.starts_with("cyclic-extends")
        })
    };
    // A class extending a value or an expression may have any class of the
    // program as its runtime ancestor: no interval holds then.
    let user_foreign = classes.iter().any(|c| {
        c.reasons.iter().any(|r| r.starts_with("extends-non-identifier") || r.starts_with("extends-value") || r.starts_with("cyclic-extends"))
    });
    if user_foreign {
        return dfs;
    }
    // a class is ranged when every class of its subtree is stable and the
    // hierarchy's root extends nothing unrecorded
    let mut order: Vec<u32> = dfs.index.keys().copied().collect();
    order.sort_by_key(|c| dfs.index[c]);
    for &c in &order {
        let lo = dfs.index[&c];
        let span = dfs.span[&c];
        let mut root = c;
        while let Some(p) = by_id.get(&root).and_then(|cd| cd.parent).map(|p| p.0) {
            if !ids.contains(&p) || p == root {
                break;
            }
            root = p;
        }
        let root_ok = by_id.get(&root).map_or(false, |cd| !foreign_base(cd));
        let subtree_ok = order
            .iter()
            .filter(|k| {
                let i = dfs.index[k];
                i >= lo && i < lo + span
            })
            .all(|k| by_id.get(k).map_or(false, |cd| cd.stable && !foreign_base(cd)));
        if root_ok && subtree_ok {
            dfs.ranged.insert(c);
        }
    }
    dfs
}

fn set_class_dfs(classes: &[ClassDef]) {
    let d = std::rc::Rc::new(compute_class_dfs(classes));
    CLASS_DFS.with(|c| *c.borrow_mut() = d);
}

fn class_dfs() -> std::rc::Rc<ClassDfs> {
    CLASS_DFS.with(|c| c.borrow().clone())
}

/// TSAOT_CLASS_INDEX=0 keeps the class index out of the emitted C (the parity
/// oracle's text).
fn class_index_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_CLASS_INDEX").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// The header word of a sized instance of class `c` (its index plus one).
fn class_index_word(c: u32) -> u32 {
    class_dfs().index.get(&c).map_or(0, |i| i + 1)
}

/// A virtual call's dispatch table (docs/class_index_dispatch_design.md):
/// for each class of the receiver class's interval, in class index order,
/// the function implementing the method (none for an abstract class), and
/// the direct signature they all share (else the generic entries are used).
struct VtPlan {
    table: String,
    lo: u32,
    span: u32,
    sig: Option<DirectSig>,
}

thread_local! {
    static VT_PLANS: std::cell::RefCell<BTreeMap<(u32, u32), std::rc::Rc<VtPlan>>> = std::cell::RefCell::new(BTreeMap::new());
}

/// TSAOT_VTABLES=0 keeps virtual calls on the prototype lookup.
fn vtables_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_VTABLES").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

fn collect_method_calls(body: &[Inst], out: &mut BTreeSet<(u32, u32, Option<u32>)>) {
    for inst in body {
        match inst {
            Inst::Call {
                callee: CalleeRef::Method { recv_class, method, recv_stable: true, method_field },
                recv: Some(_),
                ..
            } if recv_class.0 != u32::MAX => {
                out.insert((recv_class.0, method.0, method_field.map(|f| f.0)));
            }
            Inst::If { then_body, else_body, .. } => {
                collect_method_calls(then_body, out);
                collect_method_calls(else_body, out);
            }
            Inst::Loop { cond_body, body, .. } => {
                collect_method_calls(cond_body, out);
                collect_method_calls(body, out);
            }
            Inst::TryCatch { try_body, catch_body, finally_body, .. } => {
                collect_method_calls(try_body, out);
                collect_method_calls(catch_body, out);
                collect_method_calls(finally_body, out);
            }
            _ => {}
        }
    }
}

/// The implementations a call of `method` on a receiver of class `c` can
/// reach, by class index, when a table can dispatch it: the interval's
/// classes are stable (no prototype relinked, no method reassigned), no
/// class on a chain has an own field of the method's name (an instance
/// property would shadow the method), the implementations take `this` and
/// capture nothing (a table entry has no environment), and there are two at
/// least (one is a direct call already).
fn plan_vtable(
    classes: &BTreeMap<u32, &ClassDef>,
    c: u32,
    method: u32,
    method_field: Option<u32>,
    direct_sigs: &BTreeMap<u32, DirectSig>,
    takes_this: &BTreeMap<u32, bool>,
) -> Option<(Vec<Option<u32>>, Option<DirectSig>)> {
    let dfs = class_dfs();
    let lo = *dfs.index.get(&c)?;
    let span = *dfs.span.get(&c)?;
    let mut by_index: BTreeMap<u32, u32> = BTreeMap::new();
    for (&k, &i) in &dfs.index {
        if i >= lo && i < lo + span {
            by_index.insert(i, k);
        }
    }
    let mut impls: Vec<Option<u32>> = Vec::with_capacity(span as usize);
    for i in lo..lo + span {
        let k = *by_index.get(&i)?;
        let kd = classes.get(&k)?;
        if !kd.stable {
            return None;
        }
        let mut found = None;
        let mut cur = Some(k);
        while let Some(id) = cur {
            let cd = classes.get(&id)?;
            if let Some(mf) = method_field {
                if cd.own_fields.iter().any(|f| f.0 == mf) {
                    return None;
                }
            }
            if found.is_none() {
                if let Some(m) = cd.own_methods.iter().find(|m| m.name.0 == method && m.kind == MethodKind::Method) {
                    found = Some(m.func.0);
                }
            }
            cur = cd.parent.map(|p| p.0);
        }
        impls.push(found);
    }
    let distinct: BTreeSet<u32> = impls.iter().flatten().copied().collect();
    if distinct.len() < 2 {
        return None;
    }
    for &f in &distinct {
        if callee_capture_count(f) != 0 || !takes_this.get(&f).copied().unwrap_or(false) {
            return None;
        }
    }
    let mut sig: Option<DirectSig> = None;
    let mut shared = true;
    for &f in &distinct {
        match (direct_sigs.get(&f), &sig) {
            (Some(d), None) => sig = Some(d.clone()),
            (Some(d), Some(prev)) => {
                if d.kinds != prev.kinds || d.ret != prev.ret {
                    shared = false;
                }
            }
            (None, _) => shared = false,
        }
    }
    let sig = if shared { sig } else { None };
    if let Some(d) = &sig {
        // `this` leads, boxed
        if d.kinds.first() != Some(&ParamKind::Boxed) {
            return None;
        }
    }
    Some((impls, sig))
}

/// Emit the dispatch tables of the program's virtual calls (after the
/// function prototypes) and remember their plans for the call sites.
fn emit_vtables(
    s: &mut String,
    program: &Program,
    classes: &BTreeMap<u32, &ClassDef>,
    direct_sigs: &BTreeMap<u32, DirectSig>,
    takes_this: &BTreeMap<u32, bool>,
    fn_name: &dyn Fn(u32) -> String,
) {
    VT_PLANS.with(|p| p.borrow_mut().clear());
    if !class_index_enabled() || !vtables_enabled() {
        return;
    }
    let mut calls: BTreeSet<(u32, u32, Option<u32>)> = BTreeSet::new();
    for f in &program.functions {
        collect_method_calls(&f.body, &mut calls);
    }
    let dfs = class_dfs();
    for (c, m, mf) in calls {
        if VT_PLANS.with(|p| p.borrow().contains_key(&(c, m))) {
            continue;
        }
        let Some((impls, sig)) = plan_vtable(classes, c, m, mf, direct_sigs, takes_this) else { continue };
        let table = format!("VT_{}_{}", c, m);
        let entries: Vec<String> = impls
            .iter()
            .map(|f| match f {
                Some(f) => {
                    if sig.is_some() {
                        format!("(void*){}_d", fn_name(*f))
                    } else {
                        format!("(void*){}", fn_name(*f))
                    }
                }
                None => "(void*)0".to_string(),
            })
            .collect();
        let _ = writeln!(s, "static void* const {}[{}] = {{{}}};", table, impls.len(), entries.join(", "));
        let plan = VtPlan { table, lo: dfs.index[&c] + 1, span: dfs.span[&c], sig };
        VT_PLANS.with(|p| p.borrow_mut().insert((c, m), std::rc::Rc::new(plan)));
    }
}

/// A virtual call through its table: a sized instance of the receiver class
/// or a subclass calls its class's implementation; anything else (or after a
/// prototype was relinked) takes the prototype lookup that follows.
fn emit_vtable_call(s: &mut String, ctx: &Ctx, plan: &VtPlan, argv: &[u32], dst: &Option<LocalId>) {
    let _ = writeln!(
        s,
        "    {{ ts_object* _vo = ts_is_obj(_a[0]) ? (ts_object*)ts_ptr(_a[0]) : NULL; uint32_t _vk = _vo ? _vo->cls - {lo}u : UINT32_MAX; void* _vf = (_vk < {span}u{relinked}{shadow}) ? {t}[_vk] : NULL;",
        lo = plan.lo,
        span = plan.span,
        relinked = relink_guard(),
        // an instance with own dynamic properties may shadow the method: the lookup path
        shadow = if shadow_guard_enabled() { " && !((const ts_sized_head*)_vo)->dyn" } else { "" },
        t = plan.table
    );
    s.push_str("    if (_vf) {
");
    match &plan.sig {
        Some(sig) => {
            let mut parts: Vec<String> = vec![ctx.val(argv[0])];
            for (i, kind) in sig.kinds.iter().enumerate().skip(1) {
                parts.push(match argv.get(i) {
                    Some(a) => match kind {
                        ParamKind::Boxed => ctx.val(*a),
                        ParamKind::F64 => ctx.num(*a),
                        ParamKind::I64 => {
                            if ctx.int_local.contains(a) {
                                format!("d{}", a)
                            } else {
                                format!("(long long)({})", ctx.num(*a))
                            }
                        }
                    },
                    None => match kind {
                        ParamKind::Boxed => "TS_UNDEFINED".to_string(),
                        ParamKind::F64 => "0.0".to_string(),
                        ParamKind::I64 => "0".to_string(),
                    },
                });
            }
            let call = format!("(({} (*)({}))_vf)({})", sig.c_ret(), sig.c_params(), parts.join(", "));
            s.push_str(&ctx.set_call_result(dst, &call, sig.ret));
        }
        None => {
            let call = format!("((ts_fn)_vf)(_a, {})", argv.len());
            match dst {
                Some(d) => s.push_str(&ctx.set_val(d.0, &call)),
                None => {
                    let _ = writeln!(s, "    {};", call);
                }
            }
        }
    }
    s.push_str("    } else {
");
}

/// Emit a class field-descriptor table + a registrar so the runtime inspector
/// can render typed class instances structurally. For each class we list its
/// fields in struct order (parent fields first) with: field-name id, byte offset
/// (via offsetof), and whether the slot is an unboxed double or a boxed tsv.
fn emit_class_descriptors(s: &mut String, program: &Program) {
    let classes: BTreeMap<u32, &ClassDef> = program.classes.iter().map(|c| (c.id.0, c)).collect();
    // the struct's members (emit_field_chain): a redeclared field keeps the
    // slot, and the kind, of the ancestor that declares it first
    fn chain(cid: u32, classes: &BTreeMap<u32, &ClassDef>, out: &mut Vec<(u32, u8)>) {
        if let Some(c) = classes.get(&cid) {
            if let Some(p) = c.parent {
                chain(p.0, classes, out);
            }
            for f in &c.own_fields {
                if out.iter().any(|(id, _)| *id == f.0) {
                    continue;
                }
                // the slot's kind: 0 a boxed tsv, 1 a double, 2 an integer (int32)
                let kind = match c.field_types.get(&f.0.to_string()).map(|t| t.as_str()) {
                    Some("int32") if int_fields_enabled() => 2u8,
                    Some("number") | Some("int32") => 1u8,
                    _ => 0u8,
                };
                out.push((f.0, kind));
            }
        }
    }
    let mut typed: Vec<(u32, Vec<(u32, u8)>)> = Vec::new();
    for c in &program.classes {
        if c.instantiated {
            let mut fields = Vec::new();
            chain(c.id.0, &classes, &mut fields);
            if !fields.is_empty() {
                typed.push((c.id.0, fields));
            }
        }
    }
    for (cid, fields) in &typed {
        let _ = writeln!(s, "static ts_class_field CLASS_FIELDS_{}[] = {{", cid);
        for (fid, kind) in fields {
            let _ = writeln!(
                s,
                "  {{ {}u, offsetof(struct {}, f{}), {} }},",
                fid,
                struct_name(*cid),
                fid,
                kind
            );
        }
        s.push_str("};\n");
    }
    let index_tab = class_index_enabled() && !program.classes.is_empty();
    if index_tab {
        let n = program.classes.iter().map(|c| c.id.0).max().unwrap_or(0) + 1;
        let words: Vec<String> = (0..n).map(|c| format!("{}u", class_index_word(c))).collect();
        let _ = writeln!(s, "static const uint32_t CLASS_INDEX_TAB[{}] = {{{}}};", n, words.join(", "));
    }
    s.push_str("static void ts_register_classes(void){\n");
    if index_tab {
        let n = program.classes.iter().map(|c| c.id.0).max().unwrap_or(0) + 1;
        let _ = writeln!(s, "  ts_register_class_indices(CLASS_INDEX_TAB, {}u);", n);
    }
    for (cid, fields) in &typed {
        let _ = writeln!(
            s,
            "  ts_register_class(CLASS_PROTO[{}], CLASS_FIELDS_{}, {});",
            cid,
            cid,
            fields.len()
        );
    }
    // Class VALUE support: register each instantiated class's instance size +
    // prototype by class id, so a runtime `new K()` (K a class value) can
    // allocate the right typed instance and wire its prototype.
    for c in &program.classes {
        if c.instantiated {
            if let Some((_, fields)) = typed.iter().find(|(cid, _)| *cid == c.id.0) {
                let _ = writeln!(s, "  ts_register_class_meta({}u, sizeof(struct {}), CLASS_PROTO[{}], CLASS_FIELDS_{}, {});",
                    c.id.0, struct_name(c.id.0), c.id.0, c.id.0, fields.len());
            } else {
                let _ = writeln!(
                    s,
                    "  ts_register_class_meta({}u, sizeof(struct {}), CLASS_PROTO[{}], NULL, 0);",
                    c.id.0,
                    struct_name(c.id.0),
                    c.id.0
                );
            }
        }
    }
    s.push_str("}\n\n");
}

fn func_class(program: &Program) -> BTreeMap<u32, u32> {
    let mut m = BTreeMap::new();
    for c in &program.classes {
        for meth in &c.own_methods {
            m.insert(meth.func.0, c.id.0);
        }
    }
    m
}

fn emit_class_layout(s: &mut String, classes: &BTreeMap<u32, &ClassDef>) {
    let order = topo_classes(classes);
    for &cid in &order {
        let _ = writeln!(
            s,
            "typedef struct {} {};",
            struct_name(cid),
            struct_name(cid)
        );
    }
    s.push('\n');
    for &cid in &order {
        let _ = writeln!(s, "struct {} {{", struct_name(cid));
        s.push_str("  ts_sized_head header;\n");
        let mut seen: std::collections::HashSet<u32> = std::collections::HashSet::new();
        emit_field_chain(s, cid, classes, &mut seen);
        let _ = writeln!(s, "}};");
    }
    s.push('\n');
}
fn emit_field_chain(
    s: &mut String,
    cid: u32,
    classes: &BTreeMap<u32, &ClassDef>,
    seen: &mut std::collections::HashSet<u32>,
) {
    if let Some(c) = classes.get(&cid) {
        if let Some(p) = c.parent {
            emit_field_chain(s, p.0, classes, seen);
        }
        for f in &c.own_fields {
            // A field already declared by an ancestor reuses that slot (prefix
            // inheritance / a subclass redeclaring an inherited field) — don't
            // emit a duplicate struct member.
            if !seen.insert(f.0) {
                continue;
            }
            // Monomorphized numeric fields are stored unboxed as a raw double;
            // everything else stays a boxed tsv. (Layout is shared across the
            // prefix-inheritance chain, so a subclass inherits the parent's
            // unboxed field at the same offset.)
            let numeric = c
                .field_types
                .get(&f.0.to_string())
                .map(|t| t == "number" || t == "int32")
                .unwrap_or(false);
            if numeric {
                let int32 = int_fields_enabled()
                    && c.field_types.get(&f.0.to_string()).map(|t| t == "int32").unwrap_or(false);
                let _ = writeln!(s, "  {} f{};", if int32 { "long long" } else { "double" }, f.0);
            } else {
                let _ = writeln!(s, "  tsv f{};", f.0);
            }
        }
    }
}
fn topo_classes(classes: &BTreeMap<u32, &ClassDef>) -> Vec<u32> {
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    fn visit(id: u32, c: &BTreeMap<u32, &ClassDef>, seen: &mut BTreeSet<u32>, out: &mut Vec<u32>) {
        if seen.contains(&id) {
            return;
        }
        if let Some(cd) = c.get(&id) {
            if let Some(p) = cd.parent {
                visit(p.0, c, seen, out);
            }
        }
        seen.insert(id);
        out.push(id);
    }
    for &id in classes.keys() {
        visit(id, classes, &mut seen, &mut out);
    }
    out
}

#[derive(Clone, Debug)]
struct I64FuncInfo {
    params: Vec<u32>,
    param_facts: BTreeMap<u32, NumFact>,
    ret_fact: NumFact,
}

#[derive(Clone, Debug)]
struct F64FuncInfo {
    params: Vec<u32>,
}

#[derive(Clone, Debug)]
struct LoopModResidue {
    ind: u32,
    rhs: u32,
    divisor: i64,
    var: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ScalarSliceKind {
    Slice,
    Substring,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ScalarStringSlice {
    root: u32,
    base: u32,
    scope: u32,
    kind: ScalarSliceKind,
    start: Option<u32>,
    end: Option<u32>,
    exact_len: Option<i64>,
}

struct Ctx<'a> {
    unboxed: BTreeSet<u32>,
    int_local: BTreeSet<u32>, // unboxed locals proven safe to store as int64_t
    /// Unboxed doubles whose every use is a bitwise operand (or a copy into
    /// such a local): ToInt32 once at each definition, `(int32_t)` at the uses.
    int32_use: BTreeSet<u32>,
    local_class: BTreeMap<u32, u32>,
    classes: &'a BTreeMap<u32, &'a ClassDef>,
    strat: &'a BTreeMap<u32, AllocStrategy>,
    fn_names: &'a BTreeMap<u32, String>,
    /// method-name id -> well-known-symbol id (for TS_KEY_WKSYM keys). §3.6.
    wksym: &'a BTreeMap<u32, u32>,
    /// fn id -> takes_this (reads args[0] as `this`); for call/apply/bind + closures.
    fn_takes_this: &'a BTreeMap<u32, bool>,
    /// Leading cell params of the function being emitted that arrive through
    /// the environment register (0 under the legacy merged convention).
    cur_capture_count: usize,
    /// Direct-call i64 clones. These are optional fast entries; generic tsv entries
    /// remain the public ABI and are used for dynamic/unsafe calls.
    i64_fast: &'a BTreeMap<u32, I64FuncInfo>,
    /// Direct-call f64 clones for numeric functions that are not proven i64-safe.
    /// The public ABI remains boxed; these clones are used only when all args are
    /// already tracked as numeric unboxed values.
    f64_fast: &'a BTreeMap<u32, F64FuncInfo>,
    /// Direct entry signatures of every eligible function (empty when disabled).
    direct_sigs: &'a BTreeMap<u32, DirectSig>,
    /// method keys stored exactly one closure function program-wide (known_method_closures)
    known_methods: &'a BTreeMap<u32, u32>,
    typeof_fusion: TypeofFusion,
    /// locals holding one `undefined`/`null`/boolean constant (see tag_consts_for)
    tag_consts: BTreeMap<u32, &'static str>,
    /// locals holding one string constant: (static literal id, length in code units)
    str_consts: BTreeMap<u32, (usize, u32)>,
    switch_plan: SwitchPlan,
    layouts: LayoutPlan,
    /// the root frame is linked only around slow paths (see lazy_frames_enabled)
    lazy_frame: bool,
    /// the lazy frame's locals live in C locals (lazy_homes_enabled); the
    /// fill and reload around a linked slow call
    lazy_homes: bool,
    lazy_spill: String,
    lazy_reload: String,
    /// a lazy frame with calls: the fill and reload of each inline-cache
    /// access's slow path (by instruction address), and the instruction
    /// being emitted
    point_spills: BTreeMap<usize, (String, String)>,
    cur_inst: std::cell::Cell<usize>,
    /// string accumulators of the function (string_accum.rs)
    accums: crate::string_accum::StringAccums,
    frame_nslots: usize,
    static_strings: &'a BTreeMap<Vec<u16>, usize>,
    string_metric_plan: Option<&'a FunctionMetricPlan>,
    string_materialization_plan: Option<&'a FunctionMaterializationPlan>,
    scalar_slices: &'a BTreeMap<u32, ScalarStringSlice>,
    json_locals: BTreeSet<u32>,
    json_roots: BTreeSet<u32>,
    /// Total count of instructions referencing a DOM local across the whole
    /// function body; used to detect loops whose DOM use is fully self-contained
    /// (see loop_body_frees_json_dom).
    dom_ref_total: usize,
    emit_path: std::cell::RefCell<Vec<PathSegment>>,
    numeric_value_local: BTreeSet<u32>,
    i64_mode: bool,
    /// the return kind of the direct entry whose body is being emitted
    ret_kind: RetKind,
    /// the prologue declared the function-scope stack cells (emit_stack_cell_decls);
    /// the coroutine emitters do not, so their closures stay on the heap
    stack_cells: bool,
    /// locals of numeric type in the IR (RefKind::Primitive), whatever their
    /// representation: a maybe-undefined or nullable numeric stays boxed
    prim_kind: BTreeSet<u32>,
    /// locals whose static type is `string` / a reference type (typed_key_locals)
    str_typed: BTreeSet<u32>,
    ref_typed: BTreeSet<u32>,
    f64_mode: bool,
    /// Boxed locals carried by a generated shadow-root frame. Empty for
    /// coroutine emitters and when frame roots are disabled.
    frame_locals: BTreeSet<u32>,
    /// coalesced frame slot of each frame local (None: one slot per local)
    frame_slot: Option<BTreeMap<u32, u32>>,
    nroot: usize,
    /// locals known to hold a nonzero integer constant (safe divisor for integer %)
    nonzero_int_const: BTreeSet<u32>,
    /// locals known to hold a nonzero integer value (constant or range-proven)
    nonzero_int: BTreeSet<u32>,
    /// integer constant value per local, when known.
    int_const: BTreeMap<u32, i64>,
    /// locals known to hold nonnegative integer values.
    nonnegative_int: BTreeSet<u32>,
    /// int locals provably within ±2^53: their +/- results can't cross the
    /// safe-integer boundary, so they skip the cross-2^53 double-rounding guard.
    /// label-id allocator for the plain finally lowering (interior mutability so
    /// emit_inst can allocate fresh labels through a shared &Ctx).
    label_ctr: std::cell::Cell<u32>,
    /// Stack of (top_label, end_label, handler_depth) for loops emitted in the plain finally
    /// path, so a break/continue crossing a finally can target the right loop.
    loop_labels: std::cell::RefCell<Vec<(u32, u32, u32)>>,
    /// typed-array receivers hoisted by the enclosing loops (slice P):
    /// local -> (element kind, the loop's top label)
    ta_hoisted: std::cell::RefCell<BTreeMap<u32, (u8, u32)>>,
    /// string receivers of `charCodeAt` whose view the enclosing loop read once:
    /// local -> the loop's top label
    sv_hoisted: std::cell::RefCell<BTreeMap<u32, u32>>,
    /// Active straight-line loop modulo residues. A `%` inside the current loop
    /// can read the residue instead of recomputing `ind % const`; the loop emitter
    /// advances the residue after the induction variable update.
    loop_mod_residues: std::cell::RefCell<Vec<BTreeMap<(u32, u32), LoopModResidue>>>,
    /// Enclosing finally contexts, with the loop scope at each protected entry.
    fin_stack: std::cell::RefCell<Vec<FinCtx>>,
    /// The pending completion value of a plain finally lives in the frame
    /// slot `F.p<depth>` (docs/gc_v2_design.md §6.6): a C local is not seen by
    /// the collector, and a young value moved by a collection in the finally
    /// body would be returned from its old address.
    fin_value_slots: bool,
    pendv_depth: std::cell::Cell<u32>,
    /// count of live C EH handlers pushed in the current emission path (so a goto
    /// that crosses them can emit the right number of ts_eh_pop()).
    eh_depth: std::cell::Cell<u32>,
}
impl<'a> Ctx<'a> {
    fn vname(&self, id: u32) -> String {
        if self.frame_locals.contains(&id) {
            if let Some(m) = &self.frame_slot {
                if let Some(sl) = m.get(&id) {
                    return if self.lazy_homes { format!("r{}", sl) } else { format!("F.s{}", sl) };
                }
            }
            if self.lazy_homes { format!("rv{}", id) } else { format!("F.v{}", id) }
        } else {
            format!("v{}", id)
        }
    }
    /// A runtime call returning a value that may run user code, from a
    /// function whose frame is lazy: the frame is linked around it like the
    /// inline-cache slow paths (with register homes, filled before and
    /// reloaded after). Other functions make the call as it is.
    fn lazy_linked(&self, call: &str) -> String {
        if self.lazy_frame {
            format!("({{ tsv _lz; {}_lz = {};{} _lz; }})", self.lazy_link(), call, self.lazy_unlink())
        } else {
            call.to_string()
        }
    }
    /// The same for a slow call answering an int (`ts_instanceof`).
    fn lazy_linked_int(&self, call: &str) -> String {
        if self.lazy_frame {
            format!("({{ int _lz; {}_lz = {};{} _lz; }})", self.lazy_link(), call, self.lazy_unlink())
        } else {
            call.to_string()
        }
    }
    /// The same for a call made as a statement.
    fn lazy_linked_stmt(&self, call: &str) -> String {
        if self.lazy_frame {
            format!("{{ {}{};{} }}", self.lazy_link(), call, self.lazy_unlink())
        } else {
            format!("{};", call)
        }
    }
    fn lazy_link(&self) -> String {
        let sp = if self.lazy_homes { self.spill_now() } else { "" };
        format!("{}ts_frame_push(&F.h, {}); ", sp, self.frame_nslots)
    }
    fn lazy_unlink(&self) -> String {
        let rl = if self.lazy_homes { self.reload_now() } else { "" };
        format!(" ts_frame_pop(&F.h);{}", rl)
    }
    /// The fill before a linked slow call of the instruction being emitted
    /// (every slot for a lazy frame without calls).
    fn spill_now(&self) -> &str {
        if self.point_spills.is_empty() {
            &self.lazy_spill
        } else {
            &self.point_spill_entry().0
        }
    }
    fn reload_now(&self) -> &str {
        if self.point_spills.is_empty() {
            &self.lazy_reload
        } else {
            &self.point_spill_entry().1
        }
    }
    fn point_spill_entry(&self) -> &(String, String) {
        self.point_spills
            .get(&self.cur_inst.get())
            .expect("lazy frame with calls: a slow path emitted outside its access instruction")
    }
    fn root_cleanup(&self) -> String {
        let mut parts = Vec::new();
        if self.nroot > 0 {
            parts.push(format!("ts_gc_unroot({});", self.nroot));
        }
        if !self.frame_locals.is_empty() && !self.lazy_frame {
            parts.push("ts_frame_pop(&F.h);".to_string());
        }
        parts.join(" ")
    }
    fn fn_name_of(&self, id: u32) -> String {
        self.fn_names
            .get(&id)
            .cloned()
            .unwrap_or_else(|| format!("fn_{}", id))
    }
    fn i64_name_of(&self, id: u32) -> String {
        self.fn_names
            .get(&id)
            .map(|n| format!("{}_i64", n))
            .unwrap_or_else(|| format!("fn_{}_i64", id))
    }
    fn f64_name_of(&self, id: u32) -> String {
        self.fn_names
            .get(&id)
            .map(|n| format!("{}_f64", n))
            .unwrap_or_else(|| format!("fn_{}_f64", id))
    }
    fn num(&self, id: u32) -> String {
        if self.json_locals.contains(&id) {
            format!("ts_json_dom_number(j{})", id)
        } else if self.unboxed.contains(&id) {
            format!("d{}", id)
        } else {
            format!("ts_to_num({})", self.vname(id))
        }
    }
    /// ToNumber coercion for arithmetic operands (`- * / %`, unary `-`): an
    /// unboxed double is used directly; a boxed value goes through
    /// ts_number_coerce, which parses numeric strings ("5" -> 5), applies
    /// ToPrimitive to objects, and yields NaN for non-numerics — matching JS,
    /// unlike ts_to_num (a raw bit reinterpret that returns garbage for strings).
    fn numc(&self, id: u32) -> String {
        if self.json_locals.contains(&id) {
            format!("ts_json_dom_number(j{})", id)
        } else if self.unboxed.contains(&id) {
            format!("d{}", id)
        } else {
            format!("ts_number_coerce({})", self.vname(id))
        }
    }
    fn numc_double(&self, id: u32) -> String {
        if self.json_locals.contains(&id) {
            format!("ts_json_dom_number(j{})", id)
        } else if self.unboxed.contains(&id) {
            format!("((double)d{})", id)
        } else {
            format!("ts_number_coerce({})", self.vname(id))
        }
    }
    /// ToInt32 of a bitwise operand: a cast for an int32-use local (it holds
    /// ToInt32 of its value) and for an int local (an integer wraps through
    /// uint32), the runtime conversion otherwise.
    fn bitwise_operand(&self, id: u32) -> String {
        if self.int32_use.contains(&id) {
            format!("((int32_t)d{})", id)
        } else if self.int_local.contains(&id) && int32_uses_enabled() {
            format!("((int32_t)(uint32_t)d{})", id)
        } else {
            format!("ts_to_int32({})", self.numc_double(id))
        }
    }
    /// ToUint32 of a shift count, masked to five bits.
    fn shift_count(&self, id: u32) -> String {
        if self.int32_use.contains(&id) {
            format!("((uint32_t)(int32_t)d{} & 31)", id)
        } else if self.int_local.contains(&id) && int32_uses_enabled() {
            format!("((uint32_t)d{} & 31)", id)
        } else {
            format!("(ts_to_uint32({}) & 31)", self.numc_double(id))
        }
    }
    fn val(&self, id: u32) -> String {
        if self.json_locals.contains(&id) {
            format!("ts_json_dom_to_tsv(j{})", id)
        } else if self.int_local.contains(&id) {
            format!("ts_num((double)d{})", id)
        } else if self.unboxed.contains(&id) {
            format!("ts_num(d{})", id)
        } else {
            self.vname(id)
        }
    }
    fn jval(&self, id: u32) -> String {
        if self.json_locals.contains(&id) {
            format!("j{}", id)
        } else {
            format!("ts_json_dom_parse({})", self.val(id))
        }
    }
    /// `a === b` as a bit compare when one side is a tag constant local
    /// (`undefined`, `null`, a boolean): (other operand, constant expression).
    fn tag_eq_operands(&self, a: u32, b: u32) -> Option<(u32, &'static str)> {
        let (x, t) = if let Some(t) = self.tag_consts.get(&b) {
            (a, *t)
        } else if let Some(t) = self.tag_consts.get(&a) {
            (b, *t)
        } else {
            return None;
        };
        if self.json_locals.contains(&x) {
            return None;
        }
        Some((x, t))
    }
    /// `a === b` with one side a string constant local: (other operand, the
    /// literal's expression, its length) for ts_eq_strlit.
    /// `x === n` with exactly one side an unboxed number: (the boxed side, the
    /// number's raw expression). Only a number can be strictly equal to a
    /// number, so the boxed side needs a tag test and a double compare.
    fn num_eq_operands(&self, lhs: u32, rhs: u32) -> Option<(u32, String)> {
        if !eq_num_enabled() {
            return None;
        }
        let lu = self.unboxed.contains(&lhs);
        let ru = self.unboxed.contains(&rhs);
        if lu && !ru {
            Some((rhs, self.numc(lhs)))
        } else if ru && !lu {
            Some((lhs, self.numc(rhs)))
        } else {
            None
        }
    }

    /// `a === b` with both operands marked reference-typed by the exporter
    /// (object types, null, undefined; docs/ref_eq_design.md): a heap cell has
    /// one reference and null and undefined one encoding each, so the bits
    /// answer; neither side can be a string or a number.
    fn ref_eq_operands(&self, a: u32, b: u32) -> bool {
        ref_eq_enabled()
            && self.ref_typed.contains(&a)
            && self.ref_typed.contains(&b)
            && !self.unboxed.contains(&a)
            && !self.unboxed.contains(&b)
            && !self.int_local.contains(&a)
            && !self.int_local.contains(&b)
            && !self.json_locals.contains(&a)
            && !self.json_locals.contains(&b)
    }

    fn str_eq_operands(&self, a: u32, b: u32) -> Option<(u32, String, u32)> {
        let (x, (id, len)) = if let Some(c) = self.str_consts.get(&b) {
            (a, *c)
        } else if let Some(c) = self.str_consts.get(&a) {
            (b, *c)
        } else {
            return None;
        };
        if self.json_locals.contains(&x) || self.unboxed.contains(&x) || self.int_local.contains(&x) {
            return None;
        }
        Some((x, format!("ts_str_v(&TS_STRLIT_{})", id), len))
    }
    /// Assignment of a direct entry's result, raw by the callee's return kind.
    fn set_call_result(&self, dst: &Option<LocalId>, call: &str, ret: RetKind) -> String {
        let Some(d) = dst else {
            return format!("  {};\n", call);
        };
        let id = d.0;
        match ret {
            RetKind::Boxed => self.set_val(id, call),
            RetKind::F64 => {
                if self.int_local.contains(&id) {
                    format!("  d{} = (long long)({});\n", id, call)
                } else {
                    self.set_num(id, call)
                }
            }
            RetKind::I64 => {
                if self.int_local.contains(&id) {
                    format!("  d{} = {};\n", id, call)
                } else {
                    self.set_num(id, &format!("(double)({})", call))
                }
            }
            RetKind::Bool => {
                if self.unboxed.contains(&id) {
                    format!("  d{} = {};\n", id, call)
                } else {
                    self.set_val(id, &format!("ts_bool({})", call))
                }
            }
        }
    }
    /// An integer-valued expression (`long long`) into a local: the integer
    /// local as it is, a double local widened, a boxed local boxed.
    fn set_int_or_num(&self, id: u32, e: &str) -> String {
        if self.int_local.contains(&id) {
            format!("  d{} = {};\n", id, e)
        } else {
            self.set_num(id, &format!("(double)({})", e))
        }
    }
    fn set_num(&self, id: u32, e: &str) -> String {
        if self.int32_use.contains(&id) {
            if int32_codegen_enabled() {
                format!("  d{} = ts_to_int32({});\n", id, e)
            } else {
                format!("  d{} = (double)ts_to_int32({});\n", id, e)
            }
        } else if self.unboxed.contains(&id) {
            format!("  d{} = {};\n", id, e)
        } else {
            format!("  {} = ts_num({});\n", self.vname(id), e)
        }
    }
    fn set_val(&self, id: u32, e: &str) -> String {
        if self.json_locals.contains(&id) {
            format!("  j{} = NULL; (void)({});\n", id, e)
        } else if self.int_local.contains(&id) {
            format!("  d{} = (long long)ts_to_num({});\n", id, e)
        } else if self.int32_use.contains(&id) {
            if int32_codegen_enabled() {
                format!("  d{} = ts_to_int32(ts_to_num({}));\n", id, e)
            } else {
                format!("  d{} = (double)ts_to_int32(ts_to_num({}));\n", id, e)
            }
        } else if self.unboxed.contains(&id) {
            format!("  d{} = ts_to_num({});\n", id, e)
        } else {
            format!("  {} = {};\n", self.vname(id), e)
        }
    }
    fn truthy(&self, id: u32) -> String {
        // int locals can never be NaN; a raw double is truthy iff it is non-zero
        // AND not NaN (NaN != 0 is true in C but NaN is falsy in JS).
        if self.json_locals.contains(&id) {
            format!("tjson_truthy(j{})", id)
        } else if self.int_local.contains(&id) {
            format!("(d{} != 0)", id)
        } else if self.unboxed.contains(&id) {
            format!("(d{0} != 0 && d{0} == d{0})", id)
        } else {
            format!("ts_truthy_fast({})", self.vname(id))
        }
    }
    fn fresh_label(&self) -> u32 {
        let n = self.label_ctr.get();
        self.label_ctr.set(n + 1);
        n
    }
    fn loop_mod_residue(&self, lhs: u32, rhs: u32) -> Option<LoopModResidue> {
        self.loop_mod_residues
            .borrow()
            .iter()
            .rev()
            .find_map(|m| m.get(&(lhs, rhs)).cloned())
    }
    fn scalar_slice(&self, id: u32) -> Option<&ScalarStringSlice> {
        self.scalar_slices.get(&id)
    }
    fn current_loop_path(&self) -> LoopPath {
        LoopPath(self.emit_path.borrow().clone())
    }
}

/// Conservative roots (docs/conservative_roots_design.md): no GC frame, no
/// per-local rooting; the collector scans the native stack. A function with a
/// try or a stack-allocated cell keeps its frame. The default;
/// TSAOT_CONSERVATIVE_ROOTS=0 keeps the frames (the parity oracle).
fn conservative_roots_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_CONSERVATIVE_ROOTS").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// TSAOT_INT32_CODEGEN=0 keeps the earlier int32 forms (the parity oracle):
/// int32-use locals as doubles, the ternary sign extension, typed-array
/// element loads through a double (docs/int32_codegen_design.md).
fn int32_codegen_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_INT32_CODEGEN").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}
/// A uint32 bit pattern `t` as the signed int32 it holds, widened to long
/// long: the xor-subtract form folds to one sign-extending move.
fn sext32_expr(t: &str) -> String {
    if int32_codegen_enabled() {
        format!("((long long)({t} ^ 0x80000000u) - 0x80000000LL)")
    } else {
        format!("({t} >= 0x80000000u) ? (long long){t} - 0x100000000LL : (long long){t}")
    }
}

/// TSAOT_MAP_NUM_INLINE=0 keeps `Map.get`/`Map.has` with an unboxed number key
/// a runtime call (the parity oracle); on, the indexed map's probe is in line.
fn map_num_inline_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_MAP_NUM_INLINE").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// TSAOT_SHADOW_GUARD=0 lets a virtual call through its table take an
/// instance that carries own dynamic properties (the parity oracle): on, such
/// an instance takes the prototype lookup, which honors an own property that
/// shadows the method (`(x as any).m = f` after the fact).
fn shadow_guard_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_SHADOW_GUARD").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// TSAOT_REF_EQ=0 keeps `===` of two reference-typed operands a call of
/// ts_strict_eq (the parity oracle): on, the operands' bits are compared
/// (docs/ref_eq_design.md).
fn ref_eq_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_REF_EQ").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// TSAOT_METHOD_SITE_IC=0 keeps a dynamic method call's method lookup in the
/// runtime alone (the parity oracle): on, the call site keeps a cache of its
/// method keyed by the receiver's class word (docs/pic_sized_inline_design.md,
/// "The dynamic call's method in a per-site cache").
fn method_site_ic_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_METHOD_SITE_IC").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// TSAOT_METHOD_SIZED_CACHE=0 keeps a dynamic method call's two cached reads
/// (the parity oracle): on, a call whose receiver the program types as a class
/// instance resolves the method through the runtime's cache by class word
/// (ts_rt.c ts_method_lookup_sized).
fn method_sized_cache_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_METHOD_SIZED_CACHE").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// TSAOT_SIZED_PIC_INLINE=0 keeps a field access of a class-typed receiver
/// whose class dispatches dynamically on the shaped inline cache (the parity
/// oracle): on, the site probes the sized entry in line (ts_rt.h
/// ts_get_sized_pic_inline) and skips the shaped probe such a receiver never hits.
fn sized_pic_inline_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_SIZED_PIC_INLINE").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// TSAOT_MAP_KEY_INLINE=0 keeps `map.get(k)` / `map.has(k)` / `set.has(k)` with
/// a boxed key as the runtime call (the parity oracle): on, a key the program
/// types as a string, or as an object, array or function, takes the indexed
/// collection's probe in line (ts_rt.h ts_map_get_str / ts_map_get_ref ...).
fn map_key_inline_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_MAP_KEY_INLINE").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// A function's locals by the key kind the frontend's checker named for them
/// (Local.ty_kind, set where a local is a collection key): strings, and
/// references (object, array or function types). Anything else names neither.
#[derive(Default, Clone)]
struct TypedKeyLocals {
    str_typed: BTreeSet<u32>,
    ref_typed: BTreeSet<u32>,
}

fn typed_key_locals(program: &Program) -> BTreeMap<u32, TypedKeyLocals> {
    let mut out: BTreeMap<u32, TypedKeyLocals> = BTreeMap::new();
    for f in &program.functions {
        let mut sets = TypedKeyLocals::default();
        for l in &f.locals {
            match l.ty_kind.as_deref() {
                Some("string") => {
                    sets.str_typed.insert(l.id.0);
                }
                Some("reference") => {
                    sets.ref_typed.insert(l.id.0);
                }
                _ => {}
            }
        }
        if !sets.str_typed.is_empty() || !sets.ref_typed.is_empty() {
            out.insert(f.id.0, sets);
        }
    }
    out
}

/// TSAOT_PUSH_INLINE=0 keeps `arr.push(v)` as the out-of-line runtime call (the
/// parity oracle): on, a push stores into a plain array with room in line.
fn push_inline_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_PUSH_INLINE").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// TSAOT_EQ_NUM=0 keeps `x === n` with one unboxed side as a generic strict
/// equality on a boxed n (the parity oracle): on, it is a tag test and a
/// double compare.
fn eq_num_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_EQ_NUM").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// TSAOT_STR_HOIST=0 keeps the per-use string view for `charCodeAt` (the parity
/// oracle): on, a loop reads a loop-invariant string receiver's view once
/// before the loop and each `charCodeAt` is a bounds test and a unit load.
fn str_hoist_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_STR_HOIST").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// TSAOT_TA_HOIST=0 keeps the per-use typed-array receiver test (the parity
/// oracle): slice P reads a loop-invariant receiver's test and length once
/// before the loop (docs/int32_codegen_design.md).
fn ta_hoist_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_TA_HOIST").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// TSAOT_IMUL_INLINE=0 keeps `Math.imul` a runtime call (the parity oracle).
fn imul_inline_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_IMUL_INLINE").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

fn frame_roots_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_FRAME_ROOTS").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

fn exception_setjmp_name() -> &'static str {
    if std::env::var("TSAOT_FAST_EXCEPTIONS").ok().as_deref() == Some("0") {
        "setjmp"
    } else {
        "ts_setjmp"
    }
}

/* Function declarations/expressions get an own `.prototype`. The production
   form defers the object to its first observation (ts_set_fn_prototype_lazy);
   TSAOT_LAZY_PROTO=0 keeps the eager legacy spelling for the frozen oracle. */
fn lazy_fn_prototype_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_LAZY_PROTO").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/* Closure environment ABI. In production a closure's captured cells reach the
   callee through the runtime's environment register (g_ts_cur_env): callers
   store the environment pointer right before the call and the callee prologue
   reads its cells from it, so the argument array holds only real arguments and
   ts_call no longer merges env and args into a fresh buffer. The frozen oracle
   predates this; TSAOT_CLOSURE_ENV_ABI=0 restores the merged convention. */
/// A `return` inside a plain `try` must pop the handlers it is leaving (one
/// `ts_eh_pop()` per live handler). TSAOT_EH_RETURN_POP=0 restores the frozen
/// emitter's output, which leaves the handlers dangling on the EH stack (a later
/// throw longjmps into the dead frame) and exists only for the parity oracle.
/// Boxed (non-numeric) fields of a sized class instance, parents first, in
/// struct order. These must start as `undefined`: the instance memory is zeroed
/// and a zero word is the number 0 under NaN-boxing.
/// Numeric (unboxed) fields of a sized class instance, parents first, in
/// struct order: a double or an integer slot, which starts at zero.
fn class_numeric_fields(cid: u32, classes: &BTreeMap<u32, &ClassDef>, out: &mut Vec<u32>) {
    if let Some(c) = classes.get(&cid) {
        if let Some(p) = c.parent {
            class_numeric_fields(p.0, classes, out);
        }
        for f in &c.own_fields {
            if numeric_field(cid, f.0, classes) {
                out.push(f.0);
            }
        }
    }
}
fn class_boxed_fields(cid: u32, classes: &BTreeMap<u32, &ClassDef>, out: &mut Vec<u32>) {
    if let Some(c) = classes.get(&cid) {
        if let Some(p) = c.parent {
            class_boxed_fields(p.0, classes, out);
        }
        for f in &c.own_fields {
            if !numeric_field(cid, f.0, classes) {
                out.push(f.0);
            }
        }
    }
}

/* Allocation-site pretenuring (docs/site_pretenuring_design.md): a heap
   class allocation names its site, whose survival feedback decides at run
   time whether it allocates young or old. TSAOT_SITE_PRETENURE=0 keeps the
   plain young allocation (the parity oracle's form). */
fn site_pretenure_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_SITE_PRETENURE").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// The runtime id of a heap allocation site (the IR site + 1; the runtime
/// table holds 65535), or None for a site that allocates as before: a
/// stack or statically pretenured one, one past the table, or every site
/// when the feedback is off.
fn alloc_site_id(site: u32, st: AllocStrategy) -> Option<u32> {
    const TS_ALLOC_SITE_MAX: u32 = 65535;
    if !site_pretenure_enabled() || matches!(st, AllocStrategy::Stack | AllocStrategy::PretenuredHeap) {
        return None;
    }
    let id = site.checked_add(1)?;
    (id <= TS_ALLOC_SITE_MAX).then_some(id)
}

/// TSAOT_UNDEF_FIELDS=0 skips the `undefined` initialization of boxed class
/// fields (the frozen emitter's behavior: unassigned fields read as 0). Parity
/// oracle only.
fn undef_fields_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_UNDEF_FIELDS").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// TSAOT_SITE_STATS=1: diagnostic build that reports closure creations per
/// site at exit (never on by default; the text differs from the parity oracle).
fn site_stats_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| matches!(std::env::var("TSAOT_SITE_STATS").as_deref(), Ok("1")))
}

fn eh_return_pop_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_EH_RETURN_POP").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}
fn closure_env_abi_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_CLOSURE_ENV_ABI").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}
/// Frame slot coalescing: reference locals whose live ranges do not overlap
/// share one rooted frame slot, so a call initializes (and the collector
/// scans) only as many slots as are simultaneously live. TSAOT_FRAME_COALESCE=0
/// keeps one slot per local (the frozen emission) for the parity oracle.
fn frame_coalesce_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_FRAME_COALESCE").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// The local an instruction writes, when its `dst` really is a definition
/// (ObjectCopyProps and SetProto read theirs; control flow has none).
fn inst_def(inst: &Inst) -> Option<u32> {
    match inst {
        Inst::AllocObject { dst, .. }
        | Inst::AllocArray { dst, .. }
        | Inst::AllocClosure { dst, .. }
        | Inst::Copy { dst, .. }
        | Inst::LoadField { dst, .. }
        | Inst::LoadMethodValue { dst, .. }
        | Inst::LoadBuiltinFn { dst, .. }
        | Inst::AllocClassValue { dst, .. }
        | Inst::NewDynamic { dst, .. }
        | Inst::LoadElem { dst, .. }
        | Inst::LoadGlobal { dst, .. }
        | Inst::Const { dst, .. }
        | Inst::BinOp { dst, .. }
        | Inst::UnOp { dst, .. }
        | Inst::LoadIndex { dst, .. }
        | Inst::ArrayLen { dst, .. }
        | Inst::StringLen { dst, .. }
        | Inst::HasField { dst, .. }
        | Inst::HasFieldDynamic { dst, .. }
        | Inst::GenericLen { dst, .. }
        | Inst::LoadFieldDynamic { dst, .. }
        | Inst::ArraySlice { dst, .. }
        | Inst::ObjectRest { dst, .. }
        | Inst::ConstructResult { dst, .. }
        | Inst::LoadClassProto { dst, .. }
        | Inst::GetProto { dst, .. }
        | Inst::NewMap { dst }
        | Inst::NewSet { dst } => Some(dst.0),
        Inst::Call { dst, .. }
        | Inst::CallSpread { dst, .. }
        | Inst::CallBuiltin { dst, .. }
        | Inst::CallBuiltinStatic { dst, .. }
        | Inst::Yield { dst, .. }
        | Inst::Await { dst, .. }
        | Inst::DeleteField { dst, .. } => dst.map(|d| d.0),
        _ => None,
    }
}

/// Every local an instruction mentions (definition included), through the
/// inliner's exhaustive operand remapper; not for the structured instructions.
fn inst_refs(inst: &Inst) -> Vec<u32> {
    let refs = std::cell::RefCell::new(Vec::new());
    let _ = crate::sroa::remap_inst_operands(inst, &|l: LocalId| {
        refs.borrow_mut().push(l.0);
        l
    });
    refs.into_inner()
}

struct FrameLayout {
    slot_of: BTreeMap<u32, u32>,
    nslots: u32,
}

/// Live-range walk over the structured body. A local may share a slot only
/// when its first reference is a definition and every later reference sits
/// inside the block of that definition (so each execution defines before it
/// uses); a reference inside a loop whose body lies inside the definition's
/// block keeps the local live to the end of that loop (it is loop-carried).
struct LiveWalk {
    pos: u32,
    parent: Vec<u32>,
    stack: Vec<u32>,
    loops: Vec<(u32, u32, u32)>, // (start, end, block that holds the Loop)
    loop_stack: Vec<usize>,
    first: BTreeMap<u32, (u32, Option<u32>)>, // (position, Some(def block) | None: never share)
    last: BTreeMap<u32, u32>,
    pending: Vec<(u32, usize)>,
    /// fused `typeof x === "lit"` compares (dst, lhs, rhs) -> x: the compare
    /// reads x, which must stay live (and keep its slot) until then.
    fused: BTreeMap<(u32, u32, u32), u32>,
}

impl LiveWalk {
    fn within(&self, mut b: u32, d: u32) -> bool {
        loop {
            if b == d {
                return true;
            }
            if b == 0 {
                return false;
            }
            b = self.parent[b as usize];
        }
    }
    fn block(&mut self) -> u32 {
        let id = self.parent.len() as u32;
        let cur = *self.stack.last().unwrap();
        self.parent.push(cur);
        id
    }
    fn touch_last(&mut self, id: u32, p: u32) {
        let e = self.last.entry(id).or_insert(p);
        if p > *e {
            *e = p;
        }
    }
    fn note_use(&mut self, id: u32, p: u32) {
        let blk = *self.stack.last().unwrap();
        match self.first.get(&id).copied() {
            None => {
                self.first.insert(id, (p, None));
            }
            Some((_, None)) => {}
            Some((fp, Some(d))) => {
                if !self.within(blk, d) {
                    self.first.insert(id, (fp, None));
                } else {
                    for &li in &self.loop_stack {
                        if self.within(self.loops[li].2, d) {
                            self.pending.push((id, li));
                        }
                    }
                }
            }
        }
        self.touch_last(id, p);
    }
    fn note_def(&mut self, id: u32, p: u32) {
        let blk = *self.stack.last().unwrap();
        if !self.first.contains_key(&id) {
            self.first.insert(id, (p, Some(blk)));
        }
        self.touch_last(id, p);
    }
    fn walk(&mut self, body: &[Inst]) {
        for inst in body {
            let p = self.pos;
            self.pos += 1;
            match inst {
                Inst::If {
                    cond,
                    then_body,
                    else_body,
                } => {
                    self.note_use(cond.0, p);
                    let b1 = self.block();
                    self.stack.push(b1);
                    self.walk(then_body);
                    self.stack.pop();
                    let b2 = self.block();
                    self.stack.push(b2);
                    self.walk(else_body);
                    self.stack.pop();
                }
                Inst::Loop {
                    cond,
                    cond_body,
                    body,
                } => {
                    let owner = *self.stack.last().unwrap();
                    let li = self.loops.len();
                    self.loops.push((p, u32::MAX, owner));
                    self.loop_stack.push(li);
                    let b1 = self.block();
                    self.stack.push(b1);
                    self.walk(cond_body);
                    let cp = self.pos;
                    self.pos += 1;
                    self.note_use(cond.0, cp);
                    self.stack.pop();
                    let b2 = self.block();
                    self.stack.push(b2);
                    self.walk(body);
                    self.stack.pop();
                    self.loop_stack.pop();
                    self.loops[li].1 = self.pos;
                    self.pos += 1;
                }
                Inst::TryCatch {
                    try_body,
                    catch_var,
                    catch_body,
                    finally_body,
                } => {
                    let b1 = self.block();
                    self.stack.push(b1);
                    self.walk(try_body);
                    self.stack.pop();
                    let b2 = self.block();
                    self.stack.push(b2);
                    if let Some(cv) = catch_var {
                        let q = self.pos;
                        self.pos += 1;
                        self.note_def(cv.0, q);
                    }
                    self.walk(catch_body);
                    self.stack.pop();
                    let b3 = self.block();
                    self.stack.push(b3);
                    self.walk(finally_body);
                    self.stack.pop();
                }
                leaf => {
                    if let Inst::BinOp { dst, lhs, rhs, .. } = leaf {
                        if let Some(&x) = self.fused.get(&(dst.0, lhs.0, rhs.0)) {
                            self.note_use(x, p);
                        }
                    }
                    let refs = inst_refs(leaf);
                    let def = inst_def(leaf);
                    for &r in &refs {
                        if Some(r) != def {
                            self.note_use(r, p);
                        }
                    }
                    if let Some(d) = def {
                        if refs.iter().filter(|&&r| r == d).count() >= 2 {
                            self.note_use(d, p);
                        } else {
                            self.note_def(d, p);
                        }
                    }
                }
            }
        }
    }
}

/// `Object.defineProperty` with a literal descriptor applies it the way
/// ValidateAndApplyPropertyDescriptor does (an existing property keeps the
/// fields the descriptor does not name). TSAOT_DEFINE_MERGE=0 keeps the
/// previous calls, which apply the absent fields as false (the parity oracle).
fn define_merge_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_DEFINE_MERGE").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// `TSAOT_FRAME_ELISION=0` keeps a frame slot for every reference local.
fn frame_elision_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_FRAME_ELISION").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// A leaf that may allocate or run user code: everything `body_is_gc_free`
/// does not accept (field and index accesses included: their slow paths may
/// call accessors).
fn leaf_may_collect(inst: &Inst, numeric: &BTreeSet<u32>) -> bool {
    !match inst {
        Inst::Const { .. }
        | Inst::Copy { .. }
        | Inst::Return { .. }
        | Inst::Break { .. }
        | Inst::Continue { .. }
        | Inst::LoadGlobal { .. }
        | Inst::StoreGlobal { .. }
        | Inst::ArrayLen { .. }
        | Inst::StringLen { .. } => true,
        Inst::UnOp { op, operand, .. } => match op.as_str() {
            "!" | "typeof" | "nullish" | "isundef" => true,
            _ => numeric.contains(&operand.0),
        },
        Inst::BinOp { op, lhs, rhs, .. } => match op.as_str() {
            "===" | "!==" => true,
            _ => numeric.contains(&lhs.0) && numeric.contains(&rhs.0),
        },
        _ => false,
    }
}

/// Backward liveness over the structured body (docs/frame_elision_design.md):
/// collects the reference locals that need a frame slot, those live after a
/// collection point (other than the value it defines) and those a collection
/// point reads without keeping them (a direct call of a function in `direct`
/// keeps the values it is passed).
struct NeedWalk<'a> {
    track: &'a BTreeSet<u32>,
    numeric: &'a BTreeSet<u32>,
    direct: &'a BTreeSet<u32>,
    fused: BTreeMap<(u32, u32, u32), u32>,
    /// per enclosing loop: (live after the loop, live at its head)
    loops: Vec<(BTreeSet<u32>, BTreeSet<u32>)>,
    needed: BTreeSet<u32>,
    /// treat the inline-cache accesses as points that do not collect (their
    /// slow paths link a lazy frame)
    relax_access: bool,
    /// per inline-cache access (by address): the locals its slow path must
    /// find in the frame (live after it, or read by it)
    points: Option<BTreeMap<usize, BTreeSet<u32>>>,
}

impl NeedWalk<'_> {
    fn block(&mut self, body: &[Inst], mut live: BTreeSet<u32>) -> BTreeSet<u32> {
        for inst in body.iter().rev() {
            live = self.inst(inst, live);
        }
        live
    }

    /// The locals live before `inst`, given those live after it.
    fn inst(&mut self, inst: &Inst, live: BTreeSet<u32>) -> BTreeSet<u32> {
        match inst {
            Inst::If {
                cond,
                then_body,
                else_body,
            } => {
                let mut l = self.block(then_body, live.clone());
                l.extend(self.block(else_body, live));
                if self.track.contains(&cond.0) {
                    l.insert(cond.0);
                }
                l
            }
            Inst::Loop {
                cond,
                cond_body,
                body,
            } => {
                // live at the head: the least fixpoint of
                // head = cond_body(after ∪ {cond} ∪ body(head))
                let mut head: BTreeSet<u32> = BTreeSet::new();
                loop {
                    self.loops.push((live.clone(), head.clone()));
                    let mut next = self.block(body, head.clone());
                    next.extend(live.iter().copied());
                    if self.track.contains(&cond.0) {
                        next.insert(cond.0);
                    }
                    let next = self.block(cond_body, next);
                    self.loops.pop();
                    if next.is_subset(&head) {
                        return head;
                    }
                    head.extend(next);
                }
            }
            Inst::TryCatch { .. } => {
                // not analyzed: the caller keeps every slot of a function with a try
                self.needed.extend(self.track.iter().copied());
                live
            }
            Inst::Return { src } => src.iter().map(|v| v.0).filter(|v| self.track.contains(v)).collect(),
            Inst::Break { up } => self.loops[self.loops.len() - 1 - *up as usize].0.clone(),
            Inst::Continue { up } => self.loops[self.loops.len() - 1 - *up as usize].1.clone(),
            leaf => {
                let def = inst_def(leaf);
                let refs = inst_refs(leaf);
                let mut uses: Vec<u32> = refs.iter().copied().filter(|&r| Some(r) != def).collect();
                if let Some(d) = def {
                    if refs.iter().filter(|&&r| r == d).count() >= 2 {
                        uses.push(d);
                    }
                }
                if let Inst::BinOp { dst, lhs, rhs, .. } = leaf {
                    if let Some(&x) = self.fused.get(&(dst.0, lhs.0, rhs.0)) {
                        uses.push(x);
                    }
                }
                let throws = matches!(leaf, Inst::Throw { .. });
                let access = is_access_point(leaf) || is_view_store_point(leaf, self.numeric);
                if access {
                    if let Some(points) = self.points.as_mut() {
                        let mut set: BTreeSet<u32> =
                            live.iter().copied().filter(|&x| Some(x) != def).collect();
                        set.extend(uses.iter().copied().filter(|u| self.track.contains(u)));
                        points.insert(leaf as *const Inst as usize, set);
                    }
                }
                if leaf_may_collect(leaf, self.numeric) && !(access && self.relax_access) {
                    if !throws {
                        for &x in &live {
                            if Some(x) != def {
                                self.needed.insert(x);
                            }
                        }
                    }
                    let kept: Vec<u32> = match leaf {
                        Inst::Call {
                            callee: CalleeRef::Direct { func },
                            args,
                            recv,
                            ..
                        } if self.direct.contains(&func.0) => args.iter().chain(recv.iter()).map(|a| a.0).collect(),
                        _ => Vec::new(),
                    };
                    for &u in &uses {
                        if self.track.contains(&u) && !kept.contains(&u) {
                            self.needed.insert(u);
                        }
                    }
                }
                let mut out = if throws { BTreeSet::new() } else { live };
                if let Some(d) = def {
                    out.remove(&d);
                }
                for u in uses {
                    if self.track.contains(&u) {
                        out.insert(u);
                    }
                }
                out
            }
        }
    }
}

/// The reference locals among `reflike` that need a frame slot, with the
/// inline-cache accesses counted as collection points or not
/// (`relax_access`), and, when `record`, each access's slow-path set.
fn frame_needed_locals(
    f: &Function,
    reflike: &[u32],
    numeric: &BTreeSet<u32>,
    fusion: &TypeofFusion,
    direct: &BTreeSet<u32>,
    relax_access: bool,
    record: bool,
) -> (BTreeSet<u32>, BTreeMap<usize, BTreeSet<u32>>) {
    let track: BTreeSet<u32> = reflike.iter().copied().collect();
    let mut w = NeedWalk {
        track: &track,
        numeric,
        direct,
        fused: fusion.fused.iter().map(|(k, (x, _, _))| (*k, *x)).collect(),
        loops: Vec::new(),
        needed: BTreeSet::new(),
        relax_access,
        points: if record { Some(BTreeMap::new()) } else { None },
    };
    w.block(&f.body, BTreeSet::new());
    (w.needed, w.points.unwrap_or_default())
}

/// The accesses whose slow path a lazy frame links (what `body_is_gc_free`
/// accepts besides the instructions that cannot collect).
fn is_access_point(inst: &Inst) -> bool {
    matches!(inst, Inst::LoadField { .. } | Inst::StoreField { .. } | Inst::LoadIndex { .. })
}

/// A store into a view element with a numeric value (TA2,
/// docs/typed_arrays_design.md): the in-line store cannot collect, its slow
/// path links the frame, as an access point's does. A boxed value keeps its
/// ToNumber, which may run user code, outside: the generic store.
fn is_view_store_point(inst: &Inst, numeric: &BTreeSet<u32>) -> bool {
    matches!(inst, Inst::StoreIndex { elem, src, .. } if *elem != 0 && numeric.contains(&src.0))
}

/// `TSAOT_LAZY_CALLS=0` keeps an eager frame in every function with calls.
fn lazy_calls_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_LAZY_CALLS").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// Does the body allocate a cell on the C stack (a closure or a class
/// instance with the `Stack` strategy)? Under conservative roots such a
/// function keeps its frame: the cell's off-stack buffers (a property map, an
/// environment) hold references the stack scan cannot see, and a stale
/// stack-tagged word must not be followed (docs/conservative_roots_design.md).
fn body_has_stack_cells(body: &[Inst], strat: &BTreeMap<u32, AllocStrategy>) -> bool {
    if !stack_closures_enabled() {
        return false;
    }
    let mut flat: Vec<&Inst> = Vec::new();
    flatten_inst(body, &mut flat);
    flat.iter().any(|inst| match inst {
        Inst::AllocClosure { site, .. } | Inst::AllocObject { site, class_id: Some(_), .. } => {
            strat.get(&site.0) == Some(&AllocStrategy::Stack)
        }
        _ => false,
    })
}

fn body_has_try(body: &[Inst]) -> bool {
    body.iter().any(|inst| match inst {
        Inst::TryCatch { .. } => true,
        Inst::If {
            then_body,
            else_body,
            ..
        } => body_has_try(then_body) || body_has_try(else_body),
        Inst::Loop {
            cond_body, body, ..
        } => body_has_try(cond_body) || body_has_try(body),
        _ => false,
    })
}

/// Drops from `reflike` the reference locals that need no frame slot
/// (`frame_needed_locals`). The caller has excluded the shapes the rule does
/// not cover: lazy frames, JSON locals and scalar slices (their values
/// materialize at uses). Functions with a `try` keep every slot (a catch or
/// finally body reads locals after a throw from anywhere in the try body),
/// as do those whose string plans replace loops by fused code. String
/// accumulators always keep theirs: `return` finishes the builder.
///
/// With `lazy_ok` (the function could hold a lazy frame with register homes),
/// a function whose other collection points need no slot gets a lazy frame:
/// the result maps each inline-cache access to the locals its slow path
/// spills (docs/frame_elision_design.md, round 2b).
fn elide_frame_locals(
    f: &Function,
    reflike: &mut Vec<u32>,
    numeric: &BTreeSet<u32>,
    fusion: &TypeofFusion,
    direct_sigs: &BTreeMap<u32, DirectSig>,
    string_plans: bool,
    lazy_ok: bool,
) -> Option<BTreeMap<usize, BTreeSet<u32>>> {
    if !frame_elision_enabled() || reflike.is_empty() || string_plans || body_has_try(&f.body) {
        return None;
    }
    let mut flat = Vec::new();
    flatten_inst(&f.body, &mut flat);
    let direct: BTreeSet<u32> = flat
        .iter()
        .filter_map(|inst| match inst {
            Inst::Call {
                callee: CalleeRef::Direct { func },
                ..
            } if direct_sigs.contains_key(&func.0) => Some(func.0),
            _ => None,
        })
        .collect();
    let lazy = lazy_ok && lazy_calls_enabled();
    let (mut needed, points) = frame_needed_locals(f, reflike, numeric, fusion, &direct, false, lazy);
    let mut forced: BTreeSet<u32> = BTreeSet::new();
    if string_accum_enabled() {
        let accums = crate::string_accum::string_accumulators(f);
        forced.extend(accums.locals.iter().copied());
        forced.extend(accums.temps.keys().copied());
    }
    needed.extend(forced.iter().copied().filter(|id| reflike.contains(id)));
    let mut plan = None;
    if lazy && forced.is_empty() && !needed.is_empty() {
        let (real, _) = frame_needed_locals(f, reflike, numeric, fusion, &direct, true, false);
        if real.is_empty() {
            plan = Some(points);
        }
    }
    reflike.retain(|id| needed.contains(id));
    plan
}

/// The fill before one linked slow call of a lazy frame with calls and the
/// reload after it: the slots of the locals the call must find, and
/// `undefined` in every other slot (a home not live here may hold a value
/// that went stale at a collection the frame did not see).
fn point_spill_reload(live: &BTreeSet<u32>, reflike: &[u32], layout: Option<&FrameLayout>) -> (String, String) {
    let (mut spill, mut reload) = (String::new(), String::new());
    match layout {
        Some(l) => {
            let occupied: BTreeSet<u32> = live.iter().filter_map(|id| l.slot_of.get(id).copied()).collect();
            for k in 0..l.nslots {
                if occupied.contains(&k) {
                    let _ = write!(spill, "F.s{0} = r{0}; ", k);
                    let _ = write!(reload, " r{0} = F.s{0};", k);
                } else {
                    let _ = write!(spill, "F.s{} = TS_UNDEFINED; ", k);
                }
            }
        }
        None => {
            for id in reflike {
                if live.contains(id) {
                    let _ = write!(spill, "F.v{0} = rv{0}; ", id);
                    let _ = write!(reload, " rv{0} = F.v{0};", id);
                } else {
                    let _ = write!(spill, "F.v{} = TS_UNDEFINED; ", id);
                }
            }
        }
    }
    (spill, reload)
}

fn compute_frame_layout(f: &Function, reflike: &[u32], fusion: &TypeofFusion) -> FrameLayout {
    let mut w = LiveWalk {
        pos: 1,
        parent: vec![0],
        stack: vec![0],
        loops: Vec::new(),
        loop_stack: Vec::new(),
        first: BTreeMap::new(),
        last: BTreeMap::new(),
        pending: Vec::new(),
        fused: fusion.fused.iter().map(|(k, (x, _, _))| (*k, *x)).collect(),
    };
    for prm in &f.params {
        w.first.insert(prm.0, (0, Some(0)));
        w.last.insert(prm.0, 0);
    }
    if let Some(r) = f.rest_param {
        w.first.insert(r, (0, Some(0)));
        w.last.insert(r, 0);
    }
    w.walk(&f.body);
    let pending = std::mem::take(&mut w.pending);
    for (id, li) in pending {
        let end = w.loops[li].1;
        w.touch_last(id, end);
    }
    let in_frame: BTreeSet<u32> = reflike.iter().copied().collect();
    let mut shareable: Vec<(u32, u32, u32)> = Vec::new();
    let mut dedicated: Vec<u32> = Vec::new();
    for &id in reflike {
        match w.first.get(&id) {
            Some((fp, Some(_))) => shareable.push((*fp, w.last[&id], id)),
            _ => dedicated.push(id),
        }
    }
    let _ = in_frame;
    shareable.sort_unstable();
    let mut slot_of = BTreeMap::new();
    let mut next: u32 = 0;
    let mut active: Vec<(u32, u32)> = Vec::new(); // (last, slot)
    let mut free: Vec<u32> = Vec::new();
    for (fp, lp, id) in shareable {
        let mut i = 0;
        while i < active.len() {
            if active[i].0 < fp {
                free.push(active[i].1);
                active.swap_remove(i);
            } else {
                i += 1;
            }
        }
        let slot = match free.pop() {
            Some(sl) => sl,
            None => {
                next += 1;
                next - 1
            }
        };
        slot_of.insert(id, slot);
        active.push((lp, slot));
    }
    for id in dedicated {
        slot_of.insert(id, next);
        next += 1;
    }
    FrameLayout { slot_of, nslots: next }
}

/// `TSAOT_FINALLY_SLOTS=0` keeps the pending completion value of a plain
/// finally in a C local (the previous emission, for A/B and diagnosis).
fn finally_slots_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_FINALLY_SLOTS").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// Frame slots for the pending completion values of plain finally blocks:
/// one per nesting level (a finally nested in any part of another, its
/// finally body included, needs its own while the outer one's value waits).
fn finally_value_slots(body: &[Inst]) -> u32 {
    body.iter()
        .map(|inst| match inst {
            Inst::Loop {
                cond_body, body, ..
            } => finally_value_slots(cond_body).max(finally_value_slots(body)),
            Inst::If {
                then_body,
                else_body,
                ..
            } => finally_value_slots(then_body).max(finally_value_slots(else_body)),
            Inst::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                let inner = finally_value_slots(try_body)
                    .max(finally_value_slots(catch_body))
                    .max(finally_value_slots(finally_body));
                inner + if finally_body.is_empty() { 0 } else { 1 }
            }
            _ => 0,
        })
        .max()
        .unwrap_or(0)
}

fn emit_frame_decl(s: &mut String, reflike: &[u32], layout: Option<&FrameLayout>, fin_slots: u32) {
    s.push_str("  struct { ts_frame_hdr h;");
    match layout {
        Some(l) => {
            for k in 0..l.nslots {
                let _ = write!(s, " tsv s{};", k);
            }
            for k in 0..fin_slots {
                let _ = write!(s, " tsv p{};", k);
            }
            s.push_str(" } F;\n");
            for k in 0..l.nslots {
                let _ = writeln!(s, "  F.s{} = TS_UNDEFINED;", k);
            }
        }
        None => {
            for id in reflike {
                let _ = write!(s, " tsv v{};", id);
            }
            for k in 0..fin_slots {
                let _ = write!(s, " tsv p{};", k);
            }
            s.push_str(" } F;\n");
            for id in reflike {
                let _ = writeln!(s, "  F.v{} = TS_UNDEFINED;", id);
            }
        }
    }
    for k in 0..fin_slots {
        let _ = writeln!(s, "  F.p{} = TS_UNDEFINED;", k);
    }
}

/// The frame of a lazy function with register homes: a spill area filled
/// only before a linked slow call, so declared uninitialized, and the homes.
fn emit_frame_decl_homes(
    s: &mut String,
    reflike: &[u32],
    layout: Option<&FrameLayout>,
    homes: bool,
    fin_slots: u32,
) {
    if !homes {
        emit_frame_decl(s, reflike, layout, fin_slots);
        return;
    }
    // lazy frames have no try (body_is_gc_free), so no finally value slots
    debug_assert!(fin_slots == 0);
    s.push_str("  struct { ts_frame_hdr h;");
    match layout {
        Some(l) => {
            for k in 0..l.nslots {
                let _ = write!(s, " tsv s{};", k);
            }
            s.push_str(" } F;\n");
            for k in 0..l.nslots {
                let _ = writeln!(s, "  tsv r{} = TS_UNDEFINED;", k);
            }
        }
        None => {
            for id in reflike {
                let _ = write!(s, " tsv v{};", id);
            }
            s.push_str(" } F;\n");
            for id in reflike {
                let _ = writeln!(s, "  tsv rv{} = TS_UNDEFINED;", id);
            }
        }
    }
}

fn frame_slot_count(reflike: &[u32], layout: Option<&FrameLayout>) -> usize {
    match layout {
        Some(l) => l.nslots as usize,
        None => reflike.len(),
    }
}

fn frame_local_name(id: u32, frame_locals: &BTreeSet<u32>, layout: Option<&FrameLayout>, homes: bool) -> String {
    if frame_locals.contains(&id) {
        if let Some(l) = layout {
            if let Some(sl) = l.slot_of.get(&id) {
                return if homes { format!("r{}", sl) } else { format!("F.s{}", sl) };
            }
        }
        if homes { format!("rv{}", id) } else { format!("F.v{}", id) }
    } else {
        format!("v{}", id)
    }
}

thread_local! {
    static FN_CAPTURE_COUNTS: std::cell::RefCell<BTreeMap<u32, u32>> =
        std::cell::RefCell::new(BTreeMap::new());
}
thread_local! {
    /// functions whose direct entry returns a raw boolean (direct_entry_sigs)
    static BOOL_CALLEES: std::cell::RefCell<BTreeSet<u32>> =
        std::cell::RefCell::new(BTreeSet::new());
}
fn set_bool_callees(set: &BTreeSet<u32>) {
    BOOL_CALLEES.with(|b| *b.borrow_mut() = set.clone());
}
fn is_bool_callee(func: u32) -> bool {
    BOOL_CALLEES.with(|b| b.borrow().contains(&func))
}
thread_local! {
    static TYPE_FIELD_COUNTS: std::cell::RefCell<BTreeMap<u32, u32>> =
        std::cell::RefCell::new(BTreeMap::new());
    static LENGTH_FIELDS: std::cell::RefCell<BTreeSet<u32>> =
        std::cell::RefCell::new(BTreeSet::new());
}
/// The field ids named `length`: a JSON DOM read of `length` is the array's
/// or string's length (or an object's member), not a DOM node.
fn set_length_fields(program: &Program) {
    let length: Vec<u16> = "length".encode_utf16().collect();
    LENGTH_FIELDS.with(|m| {
        let mut m = m.borrow_mut();
        m.clear();
        for f in &program.fields {
            if field_name_units(f) == length {
                m.insert(f.id.0);
            }
        }
    });
}
fn is_length_field(field: u32) -> bool {
    LENGTH_FIELDS.with(|m| m.borrow().contains(&field))
}
/// Object literal sizes for in-object slot allocation (type id -> field count).
fn set_type_field_counts(program: &Program) {
    TYPE_FIELD_COUNTS.with(|m| {
        let mut m = m.borrow_mut();
        m.clear();
        for t in &program.types {
            if let TypeShape::Object { fields } = &t.shape {
                m.insert(t.id.0, fields.len() as u32);
            }
        }
    });
}
fn type_field_count(type_id: u32) -> Option<u32> {
    TYPE_FIELD_COUNTS.with(|m| m.borrow().get(&type_id).copied())
}
/// TSAOT_INLINE_SLOTS=0 allocates object literals without an inline area
/// (`ts_new_object()`, the frozen emission) for the parity oracle.
fn inline_slots_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_INLINE_SLOTS").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}
fn set_fn_capture_counts(program: &Program) {
    FN_CAPTURE_COUNTS.with(|m| {
        let mut m = m.borrow_mut();
        m.clear();
        for f in &program.functions {
            m.insert(f.id.0, f.capture_count);
        }
    });
}
/// Leading cells a direct call must pass through the environment register.
fn callee_capture_count(func: u32) -> usize {
    if !closure_env_abi_enabled() {
        return 0;
    }
    FN_CAPTURE_COUNTS.with(|m| m.borrow().get(&func).copied().unwrap_or(0) as usize)
}
fn set_callee_capture_count(funcs: &[FunctionId]) -> usize {
    let first = funcs.first().map(|f| callee_capture_count(f.0)).unwrap_or(0);
    for f in funcs {
        if callee_capture_count(f.0) != first {
            panic!(
                "devirtualized call set mixes closure capture counts (fn {} vs fn {})",
                funcs[0].0, f.0
            );
        }
    }
    first
}
/// Entry calls from `main` never supplied cells: under the merged convention
/// `nargs` was 0 and the cell parameters read as undefined. Keep exactly that
/// state under the environment ABI by pointing the register at an undefined
/// buffer of the function's capture count.
fn emit_entry_call(s: &mut String, f: &Function) {
    let ncap = own_capture_count(f);
    if ncap > 0 {
        let _ = writeln!(
            s,
            "  {{ tsv _e[{0}]; for (int _i = 0; _i < {0}; _i++) _e[_i] = TS_UNDEFINED; g_ts_cur_env = _e; {1}(0, 0); }}",
            ncap,
            cname(f)
        );
    } else {
        let _ = writeln!(s, "  {}(0, 0);", cname(f));
    }
}
fn own_capture_count(f: &Function) -> usize {
    if closure_env_abi_enabled() {
        f.capture_count as usize
    } else {
        0
    }
}

/* `typeof x === "lit"` fusion (docs/typeof_test_design.md). The exporter lowers
   the test to `t = typeof x; c = "lit"; d = (t === c)`; the runtime's typeof
   builds a string and the compare walks it. When `t` is defined once, the
   compare follows it in the same block with only constants between (so `x`
   cannot change), and `c` is a string constant, the compare becomes a tag
   test on `x`, and temps used nowhere else are not materialized at all.
   TSAOT_TYPEOF_TEST=0 keeps the generic form (the parity oracle). */
fn typeof_test_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_TYPEOF_TEST").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

#[derive(Default)]
struct TypeofFusion {
    /// (compare dst, lhs, rhs) -> (typeof operand, literal, negated)
    fused: BTreeMap<(u32, u32, u32), (u32, String, bool)>,
    /// temps whose only use is a fused compare: not emitted
    skip: BTreeSet<u32>,
}

fn typeof_fusion_plan(f: &Function) -> TypeofFusion {
    let mut plan = TypeofFusion::default();
    if !typeof_test_enabled() {
        return plan;
    }
    let mut flat: Vec<&Inst> = Vec::new();
    flatten_inst(&f.body, &mut flat);
    let mut defs: BTreeMap<u32, u32> = BTreeMap::new();
    for inst in &flat {
        if let Some(d) = inst_def(inst) {
            *defs.entry(d).or_insert(0) += 1;
        }
    }
    let mut str_const: BTreeMap<u32, String> = BTreeMap::new();
    let mut typeof_temps: BTreeSet<u32> = BTreeSet::new();
    for inst in &flat {
        match inst {
            Inst::Const {
                dst,
                value: ConstVal::Str { value },
            } if defs.get(&dst.0) == Some(&1) => {
                str_const.insert(dst.0, value.clone());
            }
            Inst::UnOp { dst, op, .. } if op == "typeof" && defs.get(&dst.0) == Some(&1) => {
                typeof_temps.insert(dst.0);
            }
            _ => {}
        }
    }
    if typeof_temps.is_empty() || str_const.is_empty() {
        return plan;
    }
    // Instructions using each candidate temp (a temp used by exactly one
    // instruction, the fused compare, is never materialized).
    let cands: BTreeSet<u32> = typeof_temps.iter().chain(str_const.keys()).copied().collect();
    let mut uses: BTreeMap<u32, u32> = BTreeMap::new();
    for inst in &flat {
        match inst {
            // containers: only their condition is a read here (bodies are
            // flattened separately)
            Inst::If { cond, .. } | Inst::Loop { cond, .. } => {
                if cands.contains(&cond.0) {
                    *uses.entry(cond.0).or_insert(0) += 1;
                }
            }
            Inst::TryCatch { .. } => {}
            leaf => {
                let def = inst_def(leaf);
                let mut seen: BTreeSet<u32> = BTreeSet::new();
                for r in inst_refs(leaf) {
                    if Some(r) != def && cands.contains(&r) && seen.insert(r) {
                        *uses.entry(r).or_insert(0) += 1;
                    }
                }
            }
        }
    }
    fn scan(
        insts: &[Inst],
        typeof_temps: &BTreeSet<u32>,
        str_const: &BTreeMap<u32, String>,
        uses: &BTreeMap<u32, u32>,
        plan: &mut TypeofFusion,
        dup: &mut BTreeSet<(u32, u32, u32)>,
    ) {
        for (i, inst) in insts.iter().enumerate() {
            match inst {
                Inst::If {
                    then_body,
                    else_body,
                    ..
                } => {
                    scan(then_body, typeof_temps, str_const, uses, plan, dup);
                    scan(else_body, typeof_temps, str_const, uses, plan, dup);
                }
                Inst::Loop {
                    cond_body, body, ..
                } => {
                    scan(cond_body, typeof_temps, str_const, uses, plan, dup);
                    scan(body, typeof_temps, str_const, uses, plan, dup);
                }
                Inst::TryCatch {
                    try_body,
                    catch_body,
                    finally_body,
                    ..
                } => {
                    scan(try_body, typeof_temps, str_const, uses, plan, dup);
                    scan(catch_body, typeof_temps, str_const, uses, plan, dup);
                    scan(finally_body, typeof_temps, str_const, uses, plan, dup);
                }
                Inst::UnOp { dst, op, operand } if op == "typeof" && typeof_temps.contains(&dst.0) => {
                    let t = dst.0;
                    let x = operand.0;
                    let mut j = i + 1;
                    while j < insts.len() {
                        match &insts[j] {
                            Inst::Const { dst: cd, .. } if cd.0 != x && cd.0 != t => j += 1,
                            _ => break,
                        }
                    }
                    if j >= insts.len() {
                        continue;
                    }
                    if let Inst::BinOp { dst: d, op, lhs, rhs } = &insts[j] {
                        if op != "===" && op != "!==" {
                            continue;
                        }
                        let c = if lhs.0 == t && str_const.contains_key(&rhs.0) {
                            rhs.0
                        } else if rhs.0 == t && str_const.contains_key(&lhs.0) {
                            lhs.0
                        } else {
                            continue;
                        };
                        let key = (d.0, lhs.0, rhs.0);
                        if dup.contains(&key) {
                            plan.fused.remove(&key);
                            plan.skip.remove(&t);
                            plan.skip.remove(&c);
                            continue;
                        }
                        dup.insert(key);
                        plan.fused.insert(key, (x, str_const[&c].clone(), op == "!=="));
                        if uses.get(&t) == Some(&1) {
                            plan.skip.insert(t);
                        }
                        if uses.get(&c) == Some(&1) {
                            plan.skip.insert(c);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    let mut dup = BTreeSet::new();
    scan(&f.body, &typeof_temps, &str_const, &uses, &mut plan, &mut dup);
    plan
}

/// The tag test for `typeof x === lit` (mirrors ts_typeof's order).
fn typeof_test_expr(lit: &str, x: &str) -> String {
    match lit {
        "number" => format!("ts_typeof_is_number({})", x),
        "string" => format!("ts_typeof_is_string({})", x),
        "boolean" => format!("ts_typeof_is_boolean({})", x),
        "undefined" => format!("ts_typeof_is_undefined({})", x),
        "function" => format!("ts_typeof_is_function({})", x),
        "symbol" => format!("ts_typeof_is_symbol({})", x),
        "object" => format!("ts_typeof_is_object({})", x),
        _ => "0".to_string(),
    }
}

/* Chain-to-switch (docs/switch_chain_design.md). An if/else-if chain that
   tests one unboxed numeric local against integer constants — the exporter's
   lowering of a fall-through-free `switch`, or a hand-written chain — is
   emitted as a C `switch` so the C compiler builds a jump table or a binary
   search instead of a linear compare chain. The chain's own compare temps
   are left to dead-code elimination. TSAOT_SWITCH_TABLE=0 keeps the nested
   ifs (the parity oracle). */
fn switch_table_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_SWITCH_TABLE").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

const SWITCH_TABLE_MIN_CASES: usize = 4;

struct SwitchCase {
    values: Vec<i64>,
    /// a string chain's labels: (hash, literal id, length)
    str_values: Vec<(u32, usize, u32)>,
    body: Vec<Inst>,
    /// else-body indices from the head `If` down to this case's `If`
    path: Vec<usize>,
}

struct SwitchChain {
    disc: u32,
    cases: Vec<SwitchCase>,
    default_body: Vec<Inst>,
    default_path: Vec<usize>,
    /// a switch on string literals (docs/switch_strings_design.md): the
    /// discriminant's hash selects the case, which verifies its literals
    string: bool,
}

/// A case label of a switch chain: an int32, or a string literal by its hash,
/// literal id and length.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum SwitchKey {
    Num(i64),
    Str(u32, usize, u32),
}

/// TSAOT_STR_SWITCH=0 keeps a switch on string literals a chain of
/// comparisons (the parity oracle).
fn str_switch_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_STR_SWITCH").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

#[derive(Default)]
struct SwitchPlan {
    /// head `If` instruction (by address) -> chain
    heads: BTreeMap<usize, SwitchChain>,
}

fn switch_const_i32(value: f64) -> Option<i64> {
    if value.fract() != 0.0 || value < -2147483648.0 || value > 2147483647.0 {
        return None;
    }
    // -0 is === 0 in JS; the C case is 0 either way
    Some(value as i64)
}

/// One chain segment at `block[i..]`: `Const c; BinOp eq = (disc === c);
/// (UnOp miss = !eq; If miss { Const ck; BinOp eqk = (disc === ck); Copy eq = eqk })*;
/// If eq {..} else {..}`. Returns (values, index of the If) when the temps are
/// used only by the pattern.
fn match_switch_segment(
    block: &[Inst],
    i: usize,
    disc: Option<u32>,
    disc_ok: &dyn Fn(u32) -> bool,
    key_of: &dyn Fn(&ConstVal) -> Option<SwitchKey>,
    defs: &BTreeMap<u32, u32>,
    uses: &BTreeMap<u32, u32>,
) -> Option<(u32, Vec<SwitchKey>, usize)> {
    let single = |id: u32, n_uses: u32| defs.get(&id) == Some(&1) && uses.get(&id) == Some(&n_uses);
    let (c0, v0) = match block.get(i)? {
        Inst::Const { dst, value } => (dst.0, key_of(value)?),
        _ => return None,
    };
    let (eq, d) = match block.get(i + 1)? {
        Inst::BinOp { dst, op, lhs, rhs } if op == "===" && rhs.0 == c0 => (dst.0, lhs.0),
        _ => return None,
    };
    if let Some(want) = disc {
        if d != want {
            return None;
        }
    }
    if !disc_ok(d) || !single(c0, 1) || d == c0 || d == eq {
        return None;
    }
    let mut values = vec![v0];
    let mut j = i + 2;
    let mut eq_defs = 1u32;
    loop {
        let miss = match block.get(j) {
            Some(Inst::UnOp { dst, op, operand }) if op == "!" && operand.0 == eq => dst.0,
            _ => break,
        };
        let (then_body, else_body) = match block.get(j + 1) {
            Some(Inst::If {
                cond,
                then_body,
                else_body,
            }) if cond.0 == miss => (then_body, else_body),
            _ => break,
        };
        if !else_body.is_empty() || then_body.len() != 3 || !single(miss, 1) {
            return None;
        }
        let (ck, vk) = match &then_body[0] {
            Inst::Const { dst, value } => (dst.0, key_of(value)?),
            _ => return None,
        };
        let eqk = match &then_body[1] {
            Inst::BinOp { dst, op, lhs, rhs } if op == "===" && lhs.0 == d && rhs.0 == ck => dst.0,
            _ => return None,
        };
        match &then_body[2] {
            Inst::Copy { dst, src } if dst.0 == eq && src.0 == eqk => {}
            _ => return None,
        }
        if !single(ck, 1) || !single(eqk, 1) {
            return None;
        }
        values.push(vk);
        eq_defs += 1;
        j += 2;
    }
    match block.get(j) {
        Some(Inst::If { cond, .. }) if cond.0 == eq => {}
        _ => return None,
    }
    // eq: one BinOp definition plus one Copy per extra label; read by each
    // `!eq` and by the final If.
    if defs.get(&eq) != Some(&eq_defs) || uses.get(&eq) != Some(&(values.len() as u32)) {
        return None;
    }
    Some((d, values, j))
}

fn switch_plan_for(
    f: &Function,
    unboxed: &BTreeSet<u32>,
    int_local: &BTreeSet<u32>,
    static_strings: &BTreeMap<Vec<u16>, usize>,
) -> SwitchPlan {
    let mut plan = SwitchPlan::default();
    if !switch_table_enabled() {
        return plan;
    }
    let numeric: BTreeSet<u32> = unboxed.union(int_local).copied().collect();
    let mut flat: Vec<&Inst> = Vec::new();
    flatten_inst(&f.body, &mut flat);
    let mut defs: BTreeMap<u32, u32> = BTreeMap::new();
    let mut uses: BTreeMap<u32, u32> = BTreeMap::new();
    for inst in &flat {
        match inst {
            Inst::If { cond, .. } | Inst::Loop { cond, .. } => {
                *uses.entry(cond.0).or_insert(0) += 1;
            }
            Inst::TryCatch { .. } => {}
            leaf => {
                let def = inst_def(leaf);
                if let Some(d) = def {
                    *defs.entry(d).or_insert(0) += 1;
                }
                let mut seen: BTreeSet<u32> = BTreeSet::new();
                for r in inst_refs(leaf) {
                    if Some(r) != def && seen.insert(r) {
                        *uses.entry(r).or_insert(0) += 1;
                    }
                }
            }
        }
    }
    #[allow(clippy::too_many_arguments)]
    fn walk(
        block: &[Inst],
        string: bool,
        disc_ok: &dyn Fn(u32) -> bool,
        key_of: &dyn Fn(&ConstVal) -> Option<SwitchKey>,
        defs: &BTreeMap<u32, u32>,
        uses: &BTreeMap<u32, u32>,
        plan: &mut SwitchPlan,
    ) {
        let mut i = 0;
        while i < block.len() {
            // nested blocks first (a case body may hold its own chain)
            match &block[i] {
                Inst::If {
                    then_body,
                    else_body,
                    ..
                } => {
                    walk(then_body, string, disc_ok, key_of, defs, uses, plan);
                    walk(else_body, string, disc_ok, key_of, defs, uses, plan);
                }
                Inst::Loop {
                    cond_body, body, ..
                } => {
                    walk(cond_body, string, disc_ok, key_of, defs, uses, plan);
                    walk(body, string, disc_ok, key_of, defs, uses, plan);
                }
                Inst::TryCatch {
                    try_body,
                    catch_body,
                    finally_body,
                    ..
                } => {
                    walk(try_body, string, disc_ok, key_of, defs, uses, plan);
                    walk(catch_body, string, disc_ok, key_of, defs, uses, plan);
                    walk(finally_body, string, disc_ok, key_of, defs, uses, plan);
                }
                _ => {}
            }
            if let Some((disc, values, head_ix)) =
                match_switch_segment(block, i, None, disc_ok, key_of, defs, uses)
            {
                let mut cases: Vec<SwitchCase> = Vec::new();
                let mut seen: BTreeSet<SwitchKey> = BTreeSet::new();
                // a string chain: two different literals with one hash across
                // cases cannot share a C case label; the chain stays a comparison chain
                let mut seen_hash: BTreeMap<u32, usize> = BTreeMap::new();
                let mut ok = true;
                let mut path: Vec<usize> = Vec::new();
                let mut cur_values = values;
                let mut cur_if = &block[head_ix];
                let (default_body, default_path);
                loop {
                    let (then_body, else_body) = match cur_if {
                        Inst::If {
                            then_body,
                            else_body,
                            ..
                        } => (then_body, else_body),
                        _ => unreachable!(),
                    };
                    for v in &cur_values {
                        if !seen.insert(*v) {
                            ok = false;
                        }
                        if let SwitchKey::Str(h, id, _) = v {
                            match seen_hash.get(h) {
                                Some(other) if *other != *id => ok = false,
                                _ => {
                                    seen_hash.insert(*h, *id);
                                }
                            }
                        }
                    }
                    let taken = std::mem::take(&mut cur_values);
                    cases.push(SwitchCase {
                        values: taken
                            .iter()
                            .filter_map(|k| if let SwitchKey::Num(n) = k { Some(*n) } else { None })
                            .collect(),
                        str_values: taken
                            .iter()
                            .filter_map(|k| if let SwitchKey::Str(h, id, len) = k { Some((*h, *id, *len)) } else { None })
                            .collect(),
                        body: then_body.clone(),
                        path: path.clone(),
                    });
                    // a pure chain segment as the whole else-body continues the chain
                    match match_switch_segment(else_body, 0, Some(disc), disc_ok, key_of, defs, uses) {
                        Some((_, vals, ix)) if ix + 1 == else_body.len() => {
                            path.push(ix);
                            cur_values = vals;
                            cur_if = &else_body[ix];
                        }
                        _ => {
                            default_body = else_body.clone();
                            default_path = path.clone();
                            break;
                        }
                    }
                }
                if ok && cases.len() >= SWITCH_TABLE_MIN_CASES {
                    plan.heads.insert(
                        &block[head_ix] as *const Inst as usize,
                        SwitchChain {
                            disc,
                            cases,
                            default_body,
                            default_path,
                            string,
                        },
                    );
                }
                i = head_ix + 1;
                continue;
            }
            i += 1;
        }
    }
    if !numeric.is_empty() {
        let num_disc = |d: u32| numeric.contains(&d);
        let num_key = |v: &ConstVal| match v {
            ConstVal::Num { value } => switch_const_i32(*value).map(SwitchKey::Num),
            _ => None,
        };
        walk(&f.body, false, &num_disc, &num_key, &defs, &uses, &mut plan);
    }
    if str_switch_enabled() && str_eq_const_enabled() {
        // the discriminant a boxed local (a string compares as one only boxed),
        // the labels string literals of the static table, by their hash
        let str_disc = |d: u32| !numeric.contains(&d);
        let str_key = |v: &ConstVal| -> Option<SwitchKey> {
            let units: Vec<u16> = match v {
                ConstVal::Str { value } => str_units(value),
                ConstVal::Str16 { units } => units.clone(),
                _ => return None,
            };
            let id = *static_strings.get(&units)?;
            Some(SwitchKey::Str(c_strhash_units(&units), id, units.len() as u32))
        };
        walk(&f.body, true, &str_disc, &str_key, &defs, &uses, &mut plan);
    }
    plan
}

/// The smallest int32 no case of the chain has (INT32_MIN unless a case
/// takes it): a non-integral discriminant switches on it to reach the default.
fn switch_no_case_value(chain: &SwitchChain) -> String {
    let used: BTreeSet<i64> = chain.cases.iter().flat_map(|c| c.values.iter().copied()).collect();
    let mut v = i32::MIN as i64;
    while used.contains(&v) {
        v += 1;
    }
    if v == i32::MIN as i64 { "INT32_MIN".to_string() } else { v.to_string() }
}

fn emit_switch_chain(s: &mut String, chain: &SwitchChain, ctx: &Ctx) {
    let l = ctx.fresh_label();
    let is_int = ctx.int_local.contains(&chain.disc);
    if chain.string {
        // The discriminant's hash (a string's cached storage hash; anything
        // else a value no case has) selects the case, which verifies its
        // literals by content before running: a hash collision with another
        // string or a non-string discriminant reaches the default.
        let used: BTreeSet<u32> = chain.cases.iter().flat_map(|c| c.str_values.iter().map(|v| v.0)).collect();
        let mut none: u32 = 0xFFFF_FFFF;
        while used.contains(&none) {
            none -= 1;
        }
        let _ = writeln!(
            s,
            "  {{ uint32_t _sh{l} = ts_str_switch_hash({d}, {none}u); switch (_sh{l}) {{",
            l = l,
            d = ctx.val(chain.disc),
            none = none
        );
    } else if is_int {
        let _ = writeln!(s, "  switch (d{}) {{", chain.disc);
    } else {
        // ToInt32 of the double (one instruction on ARMv8.3: ts_to_int32), and
        // a value no case has when the double is not exactly that integer (a
        // fraction, NaN, an infinity, out of range): it reaches the default
        // through the switch's own bounds check. -0 converts to 0 and compares
        // equal, as `-0 === 0`.
        let _ = writeln!(
            s,
            "  {{ double _sw{l} = {d}; int32_t _si{l} = ts_to_int32(_sw{l}); if ((double)_si{l} != _sw{l}) _si{l} = {none}; switch (_si{l}) {{",
            l = l,
            d = ctx.num(chain.disc),
            none = switch_no_case_value(chain)
        );
    }
    let push_path = |ctx: &Ctx, path: &[usize]| {
        for &ix in path {
            ctx.emit_path.borrow_mut().push(PathSegment {
                edge: PathEdge::IfElse,
                index: ix,
            });
        }
    };
    let pop_path = |ctx: &Ctx, path: &[usize]| {
        for _ in path {
            ctx.emit_path.borrow_mut().pop();
        }
    };
    for case in &chain.cases {
        if chain.string {
            let mut labels: BTreeSet<u32> = BTreeSet::new();
            for (h, _, _) in &case.str_values {
                if labels.insert(*h) {
                    let _ = writeln!(s, "  case {}u:", h);
                }
            }
            let tests: Vec<String> = case
                .str_values
                .iter()
                .map(|(_, id, len)| format!("ts_eq_strlit({}, ts_str_v(&TS_STRLIT_{}), {}u)", ctx.val(chain.disc), id, len))
                .collect();
            let _ = writeln!(s, "  {{ if (!({})) goto L{}_sw;", tests.join(" || "), l);
        } else {
            for v in &case.values {
                let _ = writeln!(s, "  case {}:", v);
            }
            s.push_str("  {\n");
        }
        push_path(ctx, &case.path);
        emit_seq(s, &case.body, ctx, PathEdge::IfThen);
        pop_path(ctx, &case.path);
        s.push_str("  break; }\n");
    }
    let _ = writeln!(s, "  default: L{}_sw: ;", l);
    s.push_str("  {\n");
    push_path(ctx, &chain.default_path);
    emit_seq(s, &chain.default_body, ctx, PathEdge::IfElse);
    pop_path(ctx, &chain.default_path);
    s.push_str("  break; }\n");
    if is_int && !chain.string {
        s.push_str("  }\n");
    } else {
        s.push_str("  } }\n");
    }
}

/* Lazily linked root frames (docs/lazy_frames_design.md). A function whose
   body cannot reach a collection — no allocation, call, builtin, try/catch
   or coercing operator; only numeric arithmetic, strict equality, control
   flow, and property and element accesses whose slow paths are the only way
   into the runtime — declares and fills its root frame as before but does not
   link it: the inline-cache and element-read slow paths link it around their
   out-of-line call, the one place a collection or user code can start.
   TSAOT_LAZY_FRAMES=0 links every frame eagerly (the parity oracle). */
fn lazy_frames_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_LAZY_FRAMES").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// Lazy frames, round 2 (docs/lazy_frames_design.md): a lazy function's
/// reference locals live in C locals (`r{slot}`), the frame is filled from
/// them only before a linked slow call and they are reloaded after, so the
/// fast path touches no frame and a helper's body can stay a leaf.
/// TSAOT_LAZY_HOMES=0 keeps the frame slots as the locals' homes.
/// String accumulators (docs/string_accumulators_design.md): a local only
/// appended to, read for its length and returned is built in a private
/// buffer. TSAOT_STRING_ACCUM=0 keeps the generic `+` (the parity oracle).
fn string_accum_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_STRING_ACCUM").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// `arr.values()` / `keys()` / `entries()` as values are Array Iterator objects
/// (live: `next()` reads the array at each step). TSAOT_ARRAY_ITERATORS=0
/// keeps the array snapshots (the parity oracle).
fn array_iterators_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_ARRAY_ITERATORS").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// `Reflect.get(t, k, receiver)` / `Reflect.set(t, k, v, receiver)` pass the
/// receiver (getters and setters on t's chain see it; a set lands on it).
/// TSAOT_REFLECT_RECEIVER=0 keeps the receiver-less calls (the parity oracle).
fn reflect_receiver_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_REFLECT_RECEIVER").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

fn lazy_homes_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_LAZY_HOMES").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// The frame fill before a linked slow call and the reload after it, for a
/// lazy function with register homes.
fn lazy_spill_reload(reflike: &[u32], layout: Option<&FrameLayout>) -> (String, String) {
    let (mut spill, mut reload) = (String::new(), String::new());
    match layout {
        Some(l) => {
            for k in 0..l.nslots {
                let _ = write!(spill, "F.s{0} = r{0}; ", k);
                let _ = write!(reload, " r{0} = F.s{0};", k);
            }
        }
        None => {
            for id in reflike {
                let _ = write!(spill, "F.v{0} = rv{0}; ", id);
                let _ = write!(reload, " rv{0} = F.v{0};", id);
            }
        }
    }
    (spill, reload)
}

/// Every instruction of `body` is one the emitter turns into collection-free
/// C given the numeric (unboxed) locals, or a property/element access whose
/// slow path is wrapped when the frame is lazy.
fn body_is_gc_free(body: &[Inst], numeric: &BTreeSet<u32>) -> bool {
    body.iter().all(|inst| match inst {
        Inst::Const { .. }
        | Inst::Copy { .. }
        | Inst::Return { .. }
        | Inst::Break { .. }
        | Inst::Continue { .. }
        | Inst::LoadGlobal { .. }
        | Inst::StoreGlobal { .. }
        | Inst::ArrayLen { .. }
        | Inst::StringLen { .. } => true,
        // wrapped lazily at the slow path
        Inst::LoadField { .. } | Inst::StoreField { .. } | Inst::LoadIndex { .. } => true,
        // `x instanceof C` links around its chain walk; a class binding's
        // check only throws, leaving the function (a lazy body has no try)
        Inst::CallBuiltinStatic { builtin, .. }
            if builtin.starts_with("instanceof.class:") || builtin.starts_with("binding.check:") =>
        {
            true
        }
        Inst::StoreIndex { .. } if is_view_store_point(inst, numeric) => true,
        Inst::UnOp { op, operand, .. } => match op.as_str() {
            "!" | "typeof" | "nullish" | "isundef" => true,
            _ => numeric.contains(&operand.0),
        },
        Inst::BinOp { op, lhs, rhs, .. } => match op.as_str() {
            "===" | "!==" => true,
            _ => numeric.contains(&lhs.0) && numeric.contains(&rhs.0),
        },
        Inst::If {
            then_body,
            else_body,
            ..
        } => body_is_gc_free(then_body, numeric) && body_is_gc_free(else_body, numeric),
        Inst::Loop {
            cond_body, body, ..
        } => body_is_gc_free(cond_body, numeric) && body_is_gc_free(body, numeric),
        _ => false,
    })
}

/* Object literal and constructor layouts (docs/object_layout_design.md).
   An object literal is a fresh object followed by one store per property;
   a constructor function stores its properties into a fresh `this`. The
   property sequence is static, so the object is allocated directly in its
   final shape (one transition walk per site at first use) and the values
   are stored by slot, instead of one cached shape transition per property.
   TSAOT_LITERAL_LAYOUT=0 keeps the per-property additions (parity oracle). */
fn literal_layout_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_LITERAL_LAYOUT").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

#[derive(Default)]
struct LayoutPlan {
    /// AllocObject (by address) -> property keys in store order
    alloc: BTreeMap<usize, Vec<u32>>,
    /// StoreField (by address) -> (slot, true when guarded by the constructor adopt test)
    store: BTreeMap<usize, (u32, bool)>,
    /// first StoreField of a constructor's `this` sequence -> keys
    ctor_first: BTreeMap<usize, Vec<u32>>,
}

/// Stores into `obj` that follow `start` in `block` before anything else
/// touches `obj`: (keys, store addresses). Intervening instructions may not
/// mention `obj`; when `strict`, they may also not run user code.
fn collect_layout_stores(block: &[Inst], start: usize, obj: u32, strict: bool) -> (Vec<u32>, Vec<usize>) {
    let mut keys: Vec<u32> = Vec::new();
    let mut addrs: Vec<usize> = Vec::new();
    for inst in &block[start..] {
        match inst {
            Inst::StoreField { obj: o, field, src, .. } if o.0 == obj => {
                if src.0 == obj || keys.contains(&field.0) || keys.len() >= 255 {
                    break;
                }
                keys.push(field.0);
                addrs.push(inst as *const Inst as usize);
            }
            Inst::If { .. } | Inst::Loop { .. } | Inst::TryCatch { .. } => break,
            other => {
                if inst_def(other) == Some(obj) || inst_refs(other).contains(&obj) {
                    break;
                }
                if strict
                    && matches!(
                        other,
                        Inst::Call { .. }
                            | Inst::CallSpread { .. }
                            | Inst::CallBuiltin { .. }
                            | Inst::CallBuiltinStatic { .. }
                            | Inst::NewDynamic { .. }
                            | Inst::Throw { .. }
                            | Inst::Yield { .. }
                            | Inst::Await { .. }
                            | Inst::Print { .. }
                    )
                {
                    break;
                }
            }
        }
    }
    (keys, addrs)
}

fn layout_plan_for(f: &Function) -> LayoutPlan {
    let mut plan = LayoutPlan::default();
    if !literal_layout_enabled() || !prop_pic_enabled() || f.is_async || f.is_generator {
        return plan;
    }
    fn walk(block: &[Inst], plan: &mut LayoutPlan) {
        for (i, inst) in block.iter().enumerate() {
            match inst {
                Inst::AllocObject {
                    dst,
                    class_id: None,
                    proto: None,
                    ..
                } => {
                    let (keys, addrs) = collect_layout_stores(block, i + 1, dst.0, false);
                    if !keys.is_empty() {
                        for (slot, a) in addrs.iter().enumerate() {
                            plan.store.insert(*a, (slot as u32, false));
                        }
                        plan.alloc.insert(inst as *const Inst as usize, keys);
                    }
                }
                Inst::If {
                    then_body,
                    else_body,
                    ..
                } => {
                    walk(then_body, plan);
                    walk(else_body, plan);
                }
                Inst::Loop {
                    cond_body, body, ..
                } => {
                    walk(cond_body, plan);
                    walk(body, plan);
                }
                Inst::TryCatch {
                    try_body,
                    catch_body,
                    finally_body,
                    ..
                } => {
                    walk(try_body, plan);
                    walk(catch_body, plan);
                    walk(finally_body, plan);
                }
                _ => {}
            }
        }
    }
    walk(&f.body, &mut plan);
    // A constructor-style body: leading stores into `this` before anything
    // else can observe it. `this` is the first parameter AFTER the captured
    // cells (`capture_count` leading params): a module-level constructor that
    // reads module state (every `Node`/`Symbol`/`Type` constructor of the
    // TypeScript compiler) has a cell first, and `params.first()` named that
    // cell, so those constructors silently kept the per-property additions
    // (Session 350).
    // A class constructor's or method's `this` (its stores carry the
    // exporter's class hint) is a class instance: its fields are struct slots
    // the hinted stores reach directly, and a sized instance never adopts a
    // literal layout, so planning them sent every store to the property cache
    // (tsc-ts: the Node constructor, `FlowState.reset`).
    if f.takes_this {
        if let Some(this) = f.params.get(f.capture_count as usize) {
            let (keys, addrs) = collect_layout_stores(&f.body, 0, this.0, true);
            let hinted = addrs.iter().any(|a| {
                f.body.iter().any(|inst| {
                    inst as *const Inst as usize == *a && matches!(inst, Inst::StoreField { cls, .. } if *cls != 0)
                })
            });
            if keys.len() >= 2 && !hinted {
                for (slot, a) in addrs.iter().enumerate() {
                    plan.store.insert(*a, (slot as u32, true));
                }
                plan.ctor_first.insert(addrs[0], keys);
            }
        }
    }
    plan
}

fn emit_layout_decl(s: &mut String, id: u32, keys: &[u32]) {
    let ks: Vec<String> = keys.iter().map(|k| format!("{}u", k)).collect();
    let _ = writeln!(
        s,
        "  static const ts_key _ts_lk_{}[{}] = {{{}}}; static ts_lit_layout _ts_lit_{} = {{0u, {}u, _ts_lk_{}}};",
        id,
        keys.len(),
        ks.join(", "),
        id,
        keys.len(),
        id
    );
}

/* Direct-call entry points (docs/direct_entry_design.md). Every eligible
   function gets a second entry `fn_X_d(<typed params>)` whose parameters are
   C parameters, cells first; direct call sites call it, and the generic
   `fn_X(args, nargs)` entry becomes a forwarder that function values keep
   using. TSAOT_DIRECT_ENTRY=0 restores the single generic entry (the parity
   oracle). */
fn direct_entry_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_DIRECT_ENTRY").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    }) && closure_env_abi_enabled()
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ParamKind {
    Boxed,
    F64,
    I64,
}

/// How a direct entry returns its value: boxed, or raw when every `return`
/// of the body carries a raw numeric local (F64/I64) or a boolean produced
/// in place (Bool, a C `int` 0/1). The generic forwarder boxes it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum RetKind {
    Boxed,
    F64,
    I64,
    Bool,
}

/// The C signature of a function's direct entry: one kind per IR parameter
/// (captured cells first), in the representation the body uses for it, and
/// the return kind.
#[derive(Clone, Debug)]
struct DirectSig {
    kinds: Vec<ParamKind>,
    ret: RetKind,
}

impl DirectSig {
    fn c_ret(&self) -> &'static str {
        match self.ret {
            RetKind::Boxed => "tsv",
            RetKind::F64 => "double",
            RetKind::I64 => "long long",
            RetKind::Bool => "int",
        }
    }
    fn c_params(&self) -> String {
        if self.kinds.is_empty() {
            return "void".to_string();
        }
        self.kinds
            .iter()
            .enumerate()
            .map(|(i, k)| match k {
                ParamKind::Boxed => format!("tsv _p{}", i),
                ParamKind::F64 => format!("double _p{}", i),
                ParamKind::I64 => format!("long long _p{}", i),
            })
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// A body that reads `arguments.length` needs the argument count.
fn body_reads_arguments(body: &[Inst]) -> bool {
    let mut flat = Vec::new();
    flatten_inst(body, &mut flat);
    flat.iter().any(|inst| {
        matches!(inst, Inst::CallBuiltinStatic { builtin, .. } if builtin.starts_with("arguments."))
    })
}

fn direct_entry_eligible(f: &Function) -> bool {
    !f.is_async && !f.is_generator && f.rest_param.is_none() && !body_reads_arguments(&f.body)
}

/// Parameter kinds of every eligible function, from the classification the
/// body emitter uses (`unboxed_candidates` plus the numeric analysis).
fn direct_entry_sigs(
    program: &Program,
    fclass: &BTreeMap<u32, u32>,
    param_facts_by_func: &BTreeMap<u32, BTreeMap<u32, NumFact>>,
    i64_fast: &BTreeMap<u32, I64FuncInfo>,
) -> BTreeMap<u32, DirectSig> {
    let classes: BTreeMap<u32, &ClassDef> = program.classes.iter().map(|c| (c.id.0, c)).collect();
    let mut out = BTreeMap::new();
    if !direct_entry_enabled() {
        return out;
    }
    let return_facts = i64_return_facts(i64_fast);
    let empty: BTreeMap<u32, NumFact> = BTreeMap::new();
    // Raw-boolean returns feed each other (`return isX(n)`), so the
    // classification is iterated to a fixpoint over the set of functions
    // whose direct entry returns a raw boolean; the set only grows.
    let mut bool_callees: BTreeSet<u32> = BTreeSet::new();
    loop {
        set_bool_callees(&bool_callees);
        out.clear();
        let mut next_bool: BTreeSet<u32> = BTreeSet::new();
        for f in &program.functions {
            if !direct_entry_eligible(f) {
                continue;
            }
            let mut local_class = local_class_map(f);
            if let Some(&c) = fclass.get(&f.id.0) {
                if let Some(p0) = f.params.first() {
                    local_class.insert(p0.0, c);
                }
            }
            let unboxed = unboxed_candidates(f, &local_class);
            let pf = param_facts_by_func.get(&f.id.0).unwrap_or(&empty);
            let numeric = infer_numeric_analysis(&f.body, &unboxed, pf, &return_facts, &int32_field_loads(&f.body, &classes));
            let kinds = f
                .params
                .iter()
                .map(|p| param_kind(p.0, &numeric.int_local, &unboxed))
                .collect();
            let ret = direct_return_kind(f, &unboxed, &numeric.int_local);
            if ret == RetKind::Bool {
                next_bool.insert(f.id.0);
            }
            out.insert(f.id.0, DirectSig { kinds, ret });
        }
        if next_bool == bool_callees {
            break;
        }
        bool_callees = next_bool;
    }
    out
}

fn param_kind(id: u32, int_local: &BTreeSet<u32>, unboxed: &BTreeSet<u32>) -> ParamKind {
    if int_local.contains(&id) {
        ParamKind::I64
    } else if unboxed.contains(&id) {
        ParamKind::F64
    } else {
        ParamKind::Boxed
    }
}

/// The generic `(args, nargs)` entry of a function with a direct entry: read
/// the environment register and the argument array once and forward. A
/// missing argument keeps the value the generic prologue left in place.
fn emit_direct_forwarder(s: &mut String, f: &Function, sig: &DirectSig, ncap: usize) {
    let _ = writeln!(s, "static tsv {}(tsv* args, int nargs){{", cname(f));
    s.push_str("  (void)args; (void)nargs;\n");
    if ncap > 0 {
        s.push_str("  tsv* _env = g_ts_cur_env;\n");
    }
    let parts: Vec<String> = sig
        .kinds
        .iter()
        .enumerate()
        .map(|(i, k)| {
            if i < ncap {
                match k {
                    ParamKind::Boxed => format!("_env[{}]", i),
                    ParamKind::F64 => format!("ts_to_num(_env[{}])", i),
                    ParamKind::I64 => format!("(long long)ts_to_num(_env[{}])", i),
                }
            } else {
                let j = i - ncap;
                match k {
                    ParamKind::Boxed => format!("(nargs > {0} ? args[{0}] : TS_UNDEFINED)", j),
                    ParamKind::F64 => format!("(nargs > {0} ? ts_to_num(args[{0}]) : 0.0)", j),
                    ParamKind::I64 => {
                        format!("(nargs > {0} ? (long long)ts_to_num(args[{0}]) : 0)", j)
                    }
                }
            }
        })
        .collect();
    let call = format!("{}_d({})", cname(f), parts.join(", "));
    let boxed = match sig.ret {
        RetKind::Boxed => call,
        RetKind::F64 => format!("ts_num({})", call),
        RetKind::I64 => format!("ts_num((double)({}))", call),
        RetKind::Bool => format!("ts_bool({})", call),
    };
    let _ = writeln!(s, "  return {};\n}}\n", boxed);
}

/// The write barrier of a typed class field store (docs/single_thread_vs_scriptc.md):
/// `TSAOT_BARRIER_FAST=0` keeps the generic barrier on every boxed store (the
/// parity oracle sets it). On, the store's own untagged owner pointer feeds a
/// barrier that tests the owner's generation first, and a value the emitter
/// knows is a number, a boolean, undefined or null gets no barrier.
fn barrier_fast_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_BARRIER_FAST").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// A rendered value that cannot be a heap reference: a boxed number or
/// boolean, undefined, null.
fn non_heap_value_expr(e: &str) -> bool {
    e.starts_with("ts_num(") || e.starts_with("ts_bool(") || e == "TS_UNDEFINED" || e == "TS_NULL"
}

/// Static-slot hints (docs/static_slots_design.md): `TSAOT_STATIC_SLOTS=0`
/// ignores the exporter's `slots` on LoadField/StoreField.
fn static_slots_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_STATIC_SLOTS").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

fn prop_pic_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_PROP_PIC").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

fn emit_json_cleanup(s: &mut String, ctx: &Ctx) {
    if !ctx.json_roots.is_empty() {
        s.push_str("  ts_json_dom_scope_free(&_json_dom_scope);\n");
    }
}

fn emit_seq(s: &mut String, body: &[Inst], ctx: &Ctx, edge: PathEdge) {
    for (index, inst) in body.iter().enumerate() {
        emit_inst_at(s, inst, ctx, edge, index);
    }
}

fn emit_inst_at(s: &mut String, inst: &Inst, ctx: &Ctx, edge: PathEdge, index: usize) {
    ctx.emit_path.borrow_mut().push(PathSegment { edge, index });
    emit_inst(s, inst, ctx);
    ctx.emit_path.borrow_mut().pop();
}

const JS_SAFE_INT_I64: i64 = 9_007_199_254_740_992;
const JS_SAFE_INT_F64: f64 = 9_007_199_254_740_992.0;

#[derive(Clone, Debug, PartialEq, Eq)]
struct NumFact {
    i64_safe: bool,
    nonneg: bool,
    maybe_zero: bool,
    const_i64: Option<i64>,
    min_i64: Option<i64>,
    max_i64: Option<i64>,
}

impl NumFact {
    /// A value read from an integer slot: an int32.
    fn int32_value() -> Self {
        Self {
            i64_safe: true,
            nonneg: false,
            maybe_zero: true,
            const_i64: None,
            min_i64: Some(i32::MIN as i64),
            max_i64: Some(i32::MAX as i64),
        }
    }
    fn unknown() -> Self {
        Self {
            i64_safe: false,
            nonneg: false,
            maybe_zero: true,
            const_i64: None,
            min_i64: None,
            max_i64: None,
        }
    }
    fn bool_value() -> Self {
        Self::range(0, 1)
    }
    fn int_const(n: i64) -> Self {
        Self {
            i64_safe: true,
            nonneg: n >= 0,
            maybe_zero: n == 0,
            const_i64: Some(n),
            min_i64: Some(n),
            max_i64: Some(n),
        }
    }
    fn i64_value() -> Self {
        Self {
            i64_safe: true,
            nonneg: false,
            maybe_zero: true,
            const_i64: None,
            min_i64: None,
            max_i64: None,
        }
    }
    fn nonnegative_i64_value() -> Self {
        Self {
            i64_safe: true,
            nonneg: true,
            maybe_zero: true,
            const_i64: None,
            min_i64: None,
            max_i64: None,
        }
    }
    fn range(min: i64, max: i64) -> Self {
        if min == max {
            return Self::int_const(min);
        }
        Self {
            i64_safe: true,
            nonneg: min >= 0,
            maybe_zero: min <= 0 && max >= 0,
            const_i64: None,
            min_i64: Some(min),
            max_i64: Some(max),
        }
    }
    fn join(&self, other: &Self) -> Self {
        let (min_i64, max_i64) = match (self.min_i64, self.max_i64, other.min_i64, other.max_i64) {
            (Some(a_min), Some(a_max), Some(b_min), Some(b_max)) => {
                let min = a_min.min(b_min);
                let max = a_max.max(b_max);
                if range_width_ok(min, max) {
                    (Some(min), Some(max))
                } else {
                    (None, None)
                }
            }
            _ => (None, None),
        };
        Self {
            i64_safe: self.i64_safe && other.i64_safe,
            nonneg: self.nonneg && other.nonneg,
            maybe_zero: self.maybe_zero || other.maybe_zero,
            const_i64: if self.const_i64 == other.const_i64 {
                self.const_i64
            } else {
                None
            },
            min_i64,
            max_i64,
        }
    }
}

#[derive(Clone, Debug)]
struct NumericAnalysis {
    facts: BTreeMap<u32, NumFact>,
    int_local: BTreeSet<u32>,
    nonzero_int_const: BTreeSet<u32>,
    nonzero_int: BTreeSet<u32>,
    int_const: BTreeMap<u32, i64>,
    nonnegative_int: BTreeSet<u32>,
}

fn safe_i64_num(value: f64) -> Option<i64> {
    if value == 0.0 && value.is_sign_negative() {
        return None;
    }
    if value.fract() == 0.0 && value.abs() <= JS_SAFE_INT_F64 {
        Some(value as i64)
    } else {
        None
    }
}

fn checked_safe_i64(n: i128) -> Option<i64> {
    if n >= -(JS_SAFE_INT_I64 as i128) && n <= JS_SAFE_INT_I64 as i128 {
        Some(n as i64)
    } else {
        None
    }
}

const NUMFACT_RANGE_MAX_WIDTH: i128 = 4096;

fn range_width_ok(min: i64, max: i64) -> bool {
    min <= max && (max as i128 - min as i128) <= NUMFACT_RANGE_MAX_WIDTH
}

fn checked_range(min: i128, max: i128) -> Option<NumFact> {
    let min = checked_safe_i64(min)?;
    let max = checked_safe_i64(max)?;
    if min <= max && range_width_ok(min, max) {
        Some(NumFact::range(min, max))
    } else {
        None
    }
}

fn range_of(f: &NumFact) -> Option<(i64, i64)> {
    match (f.min_i64, f.max_i64) {
        (Some(min), Some(max)) => Some((min, max)),
        _ => None,
    }
}

fn local_class_map(f: &Function) -> BTreeMap<u32, u32> {
    let mut local_class: BTreeMap<u32, u32> = BTreeMap::new();
    for (pid, cid) in &f.param_classes {
        if let Ok(p) = pid.parse::<u32>() {
            local_class.insert(p, *cid);
        }
    }
    collect_local_class(&f.body, &mut local_class);
    local_class
}

// ---- Flow-sensitive boxing of maybe-undefined numerics --------------------------
//
// `a[i]` (number[]) and `obj[key]` (numeric index signature) are typed `number`
// by TS but can be `undefined` at runtime (out-of-bounds / hole / missing key).
// Unboxing them to a raw double makes the undefined read as NaN. That MATCHES JS
// for arithmetic consumers (`undefined + 1 === NaN`) but DIVERGES for consumers
// that OBSERVE the value (console.log, ===/!==, String/concat, store, return, call
// arg). So: keep such a value unboxed only when every consumer is arithmetic; box
// it (leave it out of `unboxed`) when any consumer observes it — then arithmetic
// users `numc`-unbox it (NaN, still correct) and observers read the boxed value
// (undefined preserved). Boxing is the conservative/correct direction.

/// Locals that may hold `undefined` despite a numeric (Primitive) type: dsts of
/// `LoadIndex`/`LoadFieldDynamic`, plus anything `Copy`d from such (the only
/// value-preserving edge — BinOp/UnOp/Call produce a definite number/NaN).
fn maybe_undef_numeric_locals(f: &Function) -> BTreeSet<u32> {
    let prim: BTreeSet<u32> = f
        .locals
        .iter()
        .filter(|l| matches!(l.ref_kind, RefKind::Primitive))
        .map(|l| l.id.0)
        .collect();
    let reference: BTreeSet<u32> = f
        .locals
        .iter()
        .filter(|l| matches!(l.ref_kind, RefKind::Reference))
        .map(|l| l.id.0)
        .collect();
    let mut flat: Vec<&Inst> = Vec::new();
    flatten_inst(&f.body, &mut flat);
    let mut set: BTreeSet<u32> = BTreeSet::new();
    // §261: a pure-nullable-number element read (`(number|undefined)[]`) is boxed
    // (Reference) by §254. Track it as maybe-undefined so the flow-sensitive pass
    // can unbox the arithmetic-only ones for perf while observed ones stay boxed.
    for l in &f.locals {
        if l.nullable_numeric {
            set.insert(l.id.0);
        }
    }
    for inst in &flat {
        match inst {
            Inst::LoadIndex { dst, .. } | Inst::LoadFieldDynamic { dst, .. } => {
                if prim.contains(&dst.0) {
                    set.insert(dst.0);
                }
            }
            // A boxed (Reference) value copied into a Primitive slot can carry an
            // `undefined` into a numeric local (e.g. SROA replaces a constant
            // out-of-bounds `a[5]` / short-destructure element with a Reference
            // undefined scalar; or `let n: number = anyVal`). Treat the Primitive
            // dst as maybe-undefined so an observing use boxes it.
            Inst::Copy { dst, src } if prim.contains(&dst.0) && reference.contains(&src.0) => {
                set.insert(dst.0);
            }
            _ => {}
        }
    }
    if set.is_empty() {
        return set;
    }
    let mut changed = true;
    while changed {
        changed = false;
        for inst in &flat {
            if let Inst::Copy { dst, src } = inst {
                if set.contains(&src.0) && prim.contains(&dst.0) && set.insert(dst.0) {
                    changed = true;
                }
            }
        }
    }
    set
}

/// Among `maybe_undef` locals, those that must be BOXED: ones with a direct
/// observing use, or the `src` of a `Copy` into a needs-box local (a boxed dest
/// can only hold undefined if its source is boxed too).
fn needs_box_numeric_locals(f: &Function, maybe_undef: &BTreeSet<u32>) -> BTreeSet<u32> {
    if maybe_undef.is_empty() {
        return BTreeSet::new();
    }
    let prim: BTreeSet<u32> = f
        .locals
        .iter()
        .filter(|l| matches!(l.ref_kind, RefKind::Primitive))
        .map(|l| l.id.0)
        .collect();
    let mut flat: Vec<&Inst> = Vec::new();
    flatten_inst(&f.body, &mut flat);
    let mut nb: BTreeSet<u32> = BTreeSet::new();
    let mut obs = |id: u32, nb: &mut BTreeSet<u32>| {
        if maybe_undef.contains(&id) {
            nb.insert(id);
        }
    };
    // direct observing uses (leaf instructions only; control-flow bodies are
    // flattened separately, so we never recurse a container's body here).
    for inst in &flat {
        match inst {
            Inst::BinOp { op, lhs, rhs, .. } => match op.as_str() {
                "-" | "*" | "/" | "%" | "**" | "&" | "|" | "^" | "<<" | ">>" | ">>>" | "<"
                | ">" | "<=" | ">=" => { /* numeric: undefined->NaN matches JS */ }
                "+" => {
                    // `+` may be string concatenation (ts_add). Safe only when the
                    // OTHER operand is provably numeric (Primitive); else observing.
                    if !prim.contains(&rhs.0) {
                        obs(lhs.0, &mut nb);
                    }
                    if !prim.contains(&lhs.0) {
                        obs(rhs.0, &mut nb);
                    }
                }
                _ => {
                    // == != === !== and anything else: observing.
                    obs(lhs.0, &mut nb);
                    obs(rhs.0, &mut nb);
                }
            },
            Inst::UnOp { op, operand, .. } => {
                if !matches!(op.as_str(), "-" | "+" | "~" | "!") {
                    // typeof / nullish / isundef observe the value.
                    obs(operand.0, &mut nb);
                }
            }
            // truthy condition (undefined and NaN are both falsy): safe.
            Inst::If { .. } | Inst::Loop { .. } => {}
            // catch_var is a fresh binding; bodies are flattened separately.
            Inst::TryCatch { .. } => {}
            // index operand is ToNumber'd (safe); arr is an array ref (never maybe_undef).
            Inst::LoadIndex { .. } => {}
            Inst::StoreIndex { src, .. } => obs(src.0, &mut nb),
            // A maybe-undef value copied into a slot we do NOT track as
            // maybe-undef (e.g. a boxed Reference local, or a nullable element
            // read assigned into a wider local) escapes our undefined-tracking:
            // reading the dst back as a value would observe the undefined as NaN,
            // so the source must stay boxed. Copies into a tracked dst are handled
            // by forward seeding (prim dst) + the backward propagation below.
            Inst::Copy { dst, src } => {
                if maybe_undef.contains(&src.0) && !maybe_undef.contains(&dst.0) {
                    obs(src.0, &mut nb);
                }
            }
            // every other consumer reads operands as values (boxed via `val`),
            // observing undefined. inst_uses_any does NOT recurse for leaf insts.
            other => {
                for &id in maybe_undef.iter() {
                    let one: BTreeSet<u32> = std::iter::once(id).collect();
                    if inst_uses_any(other, &one) {
                        nb.insert(id);
                    }
                }
            }
        }
    }
    // backward: a Copy whose dst must box forces its src to box too.
    let mut changed = true;
    while changed {
        changed = false;
        for inst in &flat {
            if let Inst::Copy { dst, src } = inst {
                if nb.contains(&dst.0) && maybe_undef.contains(&src.0) && nb.insert(src.0) {
                    changed = true;
                }
            }
        }
    }
    nb
}

fn unboxed_candidates(f: &Function, local_class: &BTreeMap<u32, u32>) -> BTreeSet<u32> {
    let mut non_numeric: BTreeSet<u32> = BTreeSet::new();
    collect_non_numeric_consts(&f.body, &mut non_numeric);
    let mut unboxed: BTreeSet<u32> = f
        .locals
        .iter()
        .filter(|l| matches!(l.ref_kind, RefKind::Primitive))
        .map(|l| l.id.0)
        .filter(|id| !local_class.contains_key(id))
        .filter(|id| !non_numeric.contains(id))
        .collect();
    let cmp_unbox = cmp_truthy_only(&f.body);
    for id in &cmp_unbox {
        if !local_class.contains_key(id) && !non_numeric.contains(id) {
            unboxed.insert(*id);
        }
    }
    // Flow-sensitive boxing: a maybe-undefined numeric (an `a[i]`/`obj[key]` read,
    // or a Copy of one) that is OBSERVED as a value must stay boxed so the runtime
    // `undefined` is preserved instead of unboxing to NaN. int_local ⊆ unboxed, so
    // this single exclusion also drops it from every fast/int path.
    let maybe_undef = maybe_undef_numeric_locals(f);
    let needs_box = needs_box_numeric_locals(f, &maybe_undef);
    for id in &needs_box {
        unboxed.remove(id);
    }
    // §261 (perf recovery, reverse of §254): a pure-nullable-number element read
    // is boxed by default for correctness. When it is consumed only by arithmetic
    // (not in needs_box), unbox it to a raw double — `undefined`->NaN matches JS
    // for those consumers, and this restores the hot-loop speed §254 gave up.
    // Reference locals are eligible here (decl emits `double`, no GC root); the
    // perf-only nature means a missing/false flag simply leaves it boxed (= §254).
    for l in &f.locals {
        if l.nullable_numeric
            && maybe_undef.contains(&l.id.0)
            && !needs_box.contains(&l.id.0)
            && !local_class.contains_key(&l.id.0)
            && !non_numeric.contains(&l.id.0)
        {
            unboxed.insert(l.id.0);
        }
    }
    // Boolean temporaries that only feed conditions, decided against the
    // final numeric set so a copy source is never raw while its target is boxed.
    // Parameters and catch variables receive their first value from outside the
    // instruction stream (a boxed boolean from the caller, the thrown value), so
    // a reassignment by a comparison never makes them raw: the direct entry's
    // parameter kinds follow this set, and a boxed `true` read as a number is
    // garbage (Session 350: `function g(flag: boolean) { if (flag) ...;
    // flag = a < b; if (flag) ... }` broke the compiler's narrowing).
    let outside_defined: BTreeSet<u32> = f
        .params
        .iter()
        .map(|p| p.0)
        .chain(collect_catch_vars(&f.body))
        .collect();
    for id in truthy_only_unbox(&f.body, &unboxed) {
        if !local_class.contains_key(&id) && !outside_defined.contains(&id) {
            unboxed.insert(id);
        }
    }
    // The returned booleans of a function whose direct entry returns a raw
    // boolean (direct_return_kind): produced in place, used only by returns
    // and conditions.
    for id in bool_return_locals(f) {
        if !local_class.contains_key(&id) {
            unboxed.insert(id);
        }
    }
    unboxed
}

/// Locals bound by `catch (e)` anywhere in the body (defined by the handler,
/// not by an instruction).
fn collect_catch_vars(body: &[Inst]) -> Vec<u32> {
    let mut flat: Vec<&Inst> = Vec::new();
    flatten_inst(body, &mut flat);
    flat.iter()
        .filter_map(|inst| match inst {
            Inst::TryCatch {
                catch_var: Some(c), ..
            } => Some(c.0),
            _ => None,
        })
        .collect()
}

fn flatten_inst<'a>(body: &'a [Inst], out: &mut Vec<&'a Inst>) {
    for i in body {
        out.push(i);
        match i {
            Inst::Loop {
                cond_body, body, ..
            } => {
                flatten_inst(cond_body, out);
                flatten_inst(body, out);
            }
            Inst::If {
                then_body,
                else_body,
                ..
            } => {
                flatten_inst(then_body, out);
                flatten_inst(else_body, out);
            }
            Inst::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                flatten_inst(try_body, out);
                flatten_inst(catch_body, out);
                flatten_inst(finally_body, out);
            }
            _ => {}
        }
    }
}

fn scalar_slice_kind(builtin: &str) -> Option<ScalarSliceKind> {
    match builtin {
        "string.slice" => Some(ScalarSliceKind::Slice),
        "string.substring" => Some(ScalarSliceKind::Substring),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ScalarAffine {
    base: Option<u32>,
    offset: i64,
}

fn scalar_affine_of(map: &BTreeMap<u32, ScalarAffine>, id: u32) -> ScalarAffine {
    map.get(&id).copied().unwrap_or(ScalarAffine {
        base: Some(id),
        offset: 0,
    })
}

fn scalar_slice_affines(body: &[Inst]) -> BTreeMap<u32, ScalarAffine> {
    let mut out = BTreeMap::new();
    for inst in body {
        match inst {
            Inst::Const { dst, value } => {
                if let ConstVal::Num { value } = value {
                    if let Some(n) = safe_i64_num(*value) {
                        out.insert(
                            dst.0,
                            ScalarAffine {
                                base: None,
                                offset: n,
                            },
                        );
                    }
                }
            }
            Inst::Copy { dst, src } => {
                if let Some(a) = out.get(&src.0).copied() {
                    if a.base == Some(dst.0) {
                        out.insert(
                            dst.0,
                            ScalarAffine {
                                base: Some(dst.0),
                                offset: 0,
                            },
                        );
                    } else {
                        out.insert(dst.0, a);
                    }
                }
            }
            Inst::BinOp { dst, op, lhs, rhs } if op == "+" || op == "-" => {
                let l = scalar_affine_of(&out, lhs.0);
                let r = scalar_affine_of(&out, rhs.0);
                let next = match (op.as_str(), l.base, r.base) {
                    ("+", base, None) => Some(ScalarAffine {
                        base,
                        offset: l.offset.saturating_add(r.offset),
                    }),
                    ("+", None, base) => Some(ScalarAffine {
                        base,
                        offset: r.offset.saturating_add(l.offset),
                    }),
                    ("-", base, None) => Some(ScalarAffine {
                        base,
                        offset: l.offset.saturating_sub(r.offset),
                    }),
                    _ => None,
                };
                if let Some(a) = next {
                    out.insert(dst.0, a);
                }
            }
            _ => {}
        }
    }
    out
}

fn scalar_slice_exact_len(
    kind: ScalarSliceKind,
    start: Option<u32>,
    end: Option<u32>,
    affines: &BTreeMap<u32, ScalarAffine>,
) -> Option<i64> {
    let (Some(start), Some(end)) = (start, end) else {
        return None;
    };
    let a = scalar_affine_of(affines, start);
    let b = scalar_affine_of(affines, end);
    if a.base != b.base {
        return None;
    }
    let delta = b.offset.checked_sub(a.offset)?;
    match kind {
        ScalarSliceKind::Slice if delta >= 0 => Some(delta),
        ScalarSliceKind::Substring => Some(delta.abs()),
        _ => None,
    }
}

fn json_dom_def_builtin(builtin: &str) -> bool {
    builtin == "json.dom.parse"
        || builtin == "json.dom.index"
        || builtin.starts_with("json.dom.get:")
}

fn json_dom_inst_scan(body: &[Inst], out: &mut BTreeSet<u32>) -> bool {
    let mut changed = false;
    for inst in body {
        match inst {
            Inst::CallBuiltinStatic {
                dst: Some(dst),
                builtin,
                ..
            } if json_dom_def_builtin(builtin) => {
                changed |= out.insert(dst.0);
            }
            Inst::Copy { dst, src } if out.contains(&src.0) => {
                changed |= out.insert(dst.0);
            }
            Inst::LoadField { dst, obj, field, .. } if out.contains(&obj.0) && !is_length_field(field.0) => {
                changed |= out.insert(dst.0);
            }
            Inst::LoadIndex { dst, arr, .. } if out.contains(&arr.0) => {
                changed |= out.insert(dst.0);
            }
            Inst::LoadFieldDynamic { dst, obj, .. } if out.contains(&obj.0) => {
                changed |= out.insert(dst.0);
            }
            Inst::Loop {
                cond_body, body, ..
            } => {
                changed |= json_dom_inst_scan(cond_body, out);
                changed |= json_dom_inst_scan(body, out);
            }
            Inst::If {
                then_body,
                else_body,
                ..
            } => {
                changed |= json_dom_inst_scan(then_body, out);
                changed |= json_dom_inst_scan(else_body, out);
            }
            Inst::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                changed |= json_dom_inst_scan(try_body, out);
                changed |= json_dom_inst_scan(catch_body, out);
                changed |= json_dom_inst_scan(finally_body, out);
            }
            _ => {}
        }
    }
    changed
}

fn collect_json_dom_locals(body: &[Inst]) -> BTreeSet<u32> {
    let mut out = BTreeSet::new();
    while json_dom_inst_scan(body, &mut out) {}
    if json_dom_has_mixed_defs(body, &out) {
        return BTreeSet::new();
    }
    // DOM values are materialized FRESH at every boxed use (val() emits
    // ts_json_dom_to_tsv), so a parsed tree that ESCAPES this function (call
    // argument, return, store, capture, ...) aliases a COPY: a callee's
    // mutation, or an identity (===) comparison, diverges from the raw-DOM
    // re-reads in this function — a silent miscompile (found by the
    // self-hosting analyzer, which mutates its JSON.parse'd IR in a callee).
    // Demote the whole function to the plain boxed parse in that case: only
    // read-only, value-faithful, identity-free uses keep the DOM fast path.
    if json_dom_escapes_body(body, &out) {
        return BTreeSet::new();
    }
    out
}

/// True if any DOM-flooded local is used in a position OTHER than the
/// read-only whitelist. Exhaustive over Inst so a new variant must be
/// classified here before it compiles (mirrors devirt's escape_locals).
fn json_dom_escapes_body(body: &[Inst], doms: &BTreeSet<u32>) -> bool {
    let d = |l: &LocalId| doms.contains(&l.0);
    for inst in body {
        let escapes = match inst {
            // -- recursion --
            Inst::Loop {
                cond_body, body, ..
            } => json_dom_escapes_body(cond_body, doms) || json_dom_escapes_body(body, doms),
            Inst::If {
                then_body,
                else_body,
                ..
            } => json_dom_escapes_body(then_body, doms) || json_dom_escapes_body(else_body, doms),
            Inst::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                json_dom_escapes_body(try_body, doms)
                    || json_dom_escapes_body(catch_body, doms)
                    || json_dom_escapes_body(finally_body, doms)
            }
            // -- whitelisted read-only / value-faithful uses --
            Inst::LoadField { .. }
            | Inst::LoadFieldDynamic { .. }
            | Inst::LoadIndex { .. }
            | Inst::Copy { .. }
            | Inst::ArrayLen { .. }
            | Inst::StringLen { .. }
            | Inst::GenericLen { .. }
            | Inst::HasField { .. }
            | Inst::HasFieldDynamic { .. }
            | Inst::UnOp { .. }
            | Inst::Print { .. }
            | Inst::Const { .. }
            | Inst::LoadGlobal { .. }
            | Inst::LoadBuiltinFn { .. }
            | Inst::LoadClassProto { .. }
            | Inst::LoadElem { .. }
            | Inst::NewMap { .. }
            | Inst::NewSet { .. }
            | Inst::AllocObject { .. }
            | Inst::AllocArray { .. }
            | Inst::Break { .. }
            | Inst::Continue { .. }
            | Inst::GetProto { .. }
            | Inst::LoadMethodValue { .. } => false,
            // eq exposes OBJECT IDENTITY of a materialized copy -> veto;
            // arithmetic / relational on (leaf) values stays value-faithful.
            Inst::BinOp { op, lhs, rhs, .. } => {
                matches!(op.as_str(), "===" | "!==" | "==" | "!=") && (d(lhs) || d(rhs))
            }
            // json.dom.* accessors and read-only stringify/console sinks are
            // the DOM fast path itself / value-faithful output.
            Inst::CallBuiltinStatic { builtin, args, .. } => {
                if builtin.starts_with("json.dom.")
                    || builtin.starts_with("json.stringify")
                    || builtin.starts_with("console.")
                {
                    false
                } else {
                    args.iter().any(|a| d(a))
                }
            }
            // -- everything below lets the tree escape / aliases it / mutates it --
            Inst::Call { recv, args, .. } => {
                recv.as_ref().map(d).unwrap_or(false) || args.iter().any(|a| d(a))
            }
            Inst::CallSpread {
                recv, arg_specs, ..
            } => {
                recv.as_ref().map(d).unwrap_or(false)
                    || arg_specs.iter().any(|a| match a {
                        ArgSpec::Single { local } | ArgSpec::Spread { local } => d(local),
                    })
            }
            Inst::CallBuiltin { recv, args, .. } => d(recv) || args.iter().any(|a| d(a)),
            Inst::NewDynamic { callee, args, .. } => d(callee) || args.iter().any(|a| d(a)),
            Inst::StoreField { obj, src, .. }
            | Inst::StoreFieldDynamic { obj, src, .. } => d(obj) || d(src),
            Inst::StoreIndex { arr, src, .. } => d(arr) || d(src),
            Inst::StoreElem { arr, src, .. } => d(arr) || d(src),
            Inst::StoreGlobal { src, .. } => d(src),
            Inst::ArrayPush { arr, src } | Inst::ArrayPushAll { arr, src } => d(arr) || d(src),
            Inst::StoreProtoMethod { src, .. } | Inst::StoreMethod { src, .. } => d(src),
            Inst::AllocClosure { captures, .. } | Inst::AllocClassValue { captures, .. } => {
                captures.iter().any(|c| d(&c.cell))
            }
            Inst::Return { src } => src.as_ref().map(d).unwrap_or(false),
            Inst::Throw { src } => d(src),
            Inst::Yield { operand, .. } | Inst::Await { operand, .. } => d(operand),
            Inst::SetProto { obj, proto, .. } => d(obj) || d(proto),
            Inst::DeleteField { obj, .. } => d(obj),
            Inst::ArraySlice { arr, .. } => d(arr),
            Inst::ObjectRest { src, .. } => d(src),
            Inst::ObjectCopyProps { dst, src } => d(dst) || d(src),
            Inst::ConstructResult { inst, ret, .. } => d(inst) || d(ret),
        };
        if escapes {
            if std::env::var("TSAOT_DEBUG_JSON_DOM").is_ok() { eprintln!("[json-dom-veto] {:?}", std::mem::discriminant(inst)); eprintln!("[json-dom-veto-inst] {}", format!("{:?}", inst).chars().take(160).collect::<String>()); }
            return true;
        }
    }
    false
}

fn json_dom_def_matches(inst: &Inst, candidates: &BTreeSet<u32>) -> bool {
    match inst {
        Inst::CallBuiltinStatic {
            dst: Some(dst),
            builtin,
            ..
        } if candidates.contains(&dst.0) && json_dom_def_builtin(builtin) => true,
        Inst::Copy { dst, src } if candidates.contains(&dst.0) && candidates.contains(&src.0) => {
            true
        }
        Inst::LoadField { dst, obj, field, .. }
            if candidates.contains(&dst.0) && candidates.contains(&obj.0) && !is_length_field(field.0) =>
        {
            true
        }
        Inst::LoadIndex { dst, arr, .. }
            if candidates.contains(&dst.0) && candidates.contains(&arr.0) =>
        {
            true
        }
        Inst::LoadFieldDynamic { dst, obj, .. }
            if candidates.contains(&dst.0) && candidates.contains(&obj.0) =>
        {
            true
        }
        _ => false,
    }
}

fn json_dom_defined_dst(inst: &Inst) -> Option<u32> {
    match inst {
        Inst::AllocObject { dst, .. }
        | Inst::AllocArray { dst, .. }
        | Inst::AllocClosure { dst, .. }
        | Inst::Copy { dst, .. }
        | Inst::LoadField { dst, .. }
        | Inst::LoadMethodValue { dst, .. }
        | Inst::LoadBuiltinFn { dst, .. }
        | Inst::AllocClassValue { dst, .. }
        | Inst::NewDynamic { dst, .. }
        | Inst::LoadElem { dst, .. }
        | Inst::Const { dst, .. }
        | Inst::BinOp { dst, .. }
        | Inst::UnOp { dst, .. }
        | Inst::LoadIndex { dst, .. }
        | Inst::ArrayLen { dst, .. }
        | Inst::StringLen { dst, .. }
        | Inst::HasField { dst, .. }
        | Inst::HasFieldDynamic { dst, .. }
        | Inst::GenericLen { dst, .. }
        | Inst::LoadFieldDynamic { dst, .. }
        | Inst::ArraySlice { dst, .. }
        | Inst::ObjectRest { dst, .. }
        | Inst::ObjectCopyProps { dst, .. }
        | Inst::ConstructResult { dst, .. }
        | Inst::LoadClassProto { dst, .. }
        | Inst::GetProto { dst, .. }
        | Inst::NewMap { dst }
        | Inst::NewSet { dst } => Some(dst.0),
        Inst::Call { dst, .. }
        | Inst::Yield { dst, .. }
        | Inst::Await { dst, .. }
        | Inst::DeleteField { dst, .. }
        | Inst::CallSpread { dst, .. }
        | Inst::CallBuiltin { dst, .. }
        | Inst::CallBuiltinStatic { dst, .. }
        | Inst::SetProto { dst, .. } => dst.map(|d| d.0),
        _ => None,
    }
}

fn json_dom_has_mixed_defs_body(body: &[Inst], candidates: &BTreeSet<u32>) -> bool {
    if candidates.is_empty() {
        return false;
    }
    for inst in body {
        if let Some(dst) = json_dom_defined_dst(inst) {
            if candidates.contains(&dst) && !json_dom_def_matches(inst, candidates) {
                return true;
            }
        }
        match inst {
            Inst::TryCatch {
                try_body,
                catch_var,
                catch_body,
                finally_body,
            } => {
                if catch_var.map_or(false, |c| candidates.contains(&c.0)) {
                    return true;
                }
                if json_dom_has_mixed_defs_body(try_body, candidates)
                    || json_dom_has_mixed_defs_body(catch_body, candidates)
                    || json_dom_has_mixed_defs_body(finally_body, candidates)
                {
                    return true;
                }
            }
            Inst::Loop {
                cond_body, body, ..
            } => {
                if json_dom_has_mixed_defs_body(cond_body, candidates)
                    || json_dom_has_mixed_defs_body(body, candidates)
                {
                    return true;
                }
            }
            Inst::If {
                then_body,
                else_body,
                ..
            } => {
                if json_dom_has_mixed_defs_body(then_body, candidates)
                    || json_dom_has_mixed_defs_body(else_body, candidates)
                {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

fn json_dom_has_mixed_defs(body: &[Inst], candidates: &BTreeSet<u32>) -> bool {
    json_dom_has_mixed_defs_body(body, candidates)
}

fn collect_json_dom_parse_roots_body(body: &[Inst], out: &mut BTreeSet<u32>) {
    for inst in body {
        match inst {
            Inst::CallBuiltinStatic {
                dst: Some(dst),
                builtin,
                ..
            } if builtin == "json.dom.parse" => {
                out.insert(dst.0);
            }
            Inst::Loop {
                cond_body, body, ..
            } => {
                collect_json_dom_parse_roots_body(cond_body, out);
                collect_json_dom_parse_roots_body(body, out);
            }
            Inst::If {
                then_body,
                else_body,
                ..
            } => {
                collect_json_dom_parse_roots_body(then_body, out);
                collect_json_dom_parse_roots_body(else_body, out);
            }
            Inst::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                collect_json_dom_parse_roots_body(try_body, out);
                collect_json_dom_parse_roots_body(catch_body, out);
                collect_json_dom_parse_roots_body(finally_body, out);
            }
            _ => {}
        }
    }
}

fn collect_json_dom_parse_roots(body: &[Inst]) -> BTreeSet<u32> {
    let mut out = BTreeSet::new();
    collect_json_dom_parse_roots_body(body, &mut out);
    out
}

// ---- Per-iteration JSON DOM scope freeing ------------------------------------
//
// JSON DOM roots (`tjson_value*` from `JSON.parse` on the DOM fast path) are not
// GC-managed; they are tracked in a function-level `_json_dom_scope` and freed
// once at function exit. Inside a loop that means every iteration's DOM stays
// live until the loop ends — unbounded accumulation. When a loop's DOM use is
// fully self-contained we can instead free the scope at the bottom of the loop
// body (per iteration). Two conditions make that sound:
//   (1) confinement: every instruction that references a DOM local lives inside
//       this loop's `body` (nothing before/after the loop, nothing in its
//       `cond_body`), so the scope only ever holds roots from the current
//       iteration; and
//   (2) no live-in: at the top of the loop body no DOM local is read before it
//       is (re)defined on every path, so freeing at the bottom can never leave a
//       dangling pointer that a later iteration reads.
// `ts_json_dom_scope_free` is idempotent, and the function-exit free remains as a
// backstop for roots left over on break/continue/return paths.

/// Does `inst` reference (define or shallowly use) any DOM local? Control-flow
/// nodes only count their own `cond` operand here; their child bodies are walked
/// separately by the recursive counter so each referencing instruction is
/// counted exactly once.
fn dom_inst_refs(inst: &Inst, locals: &BTreeSet<u32>) -> bool {
    if let Some(d) = json_dom_defined_dst(inst) {
        if locals.contains(&d) {
            return true;
        }
    }
    match inst {
        Inst::If { cond, .. } | Inst::Loop { cond, .. } => locals.contains(&cond.0),
        Inst::TryCatch { .. } => false,
        // Leaf instruction: inst_uses_any has no nested body to descend into here.
        other => inst_uses_any(other, locals),
    }
}

/// Count instructions (recursively) that reference a DOM local. Comparing the
/// whole-function count with a single loop body's count detects confinement:
/// equal (and non-zero) means no DOM-referencing instruction lives outside that
/// body.
fn dom_ref_count(body: &[Inst], locals: &BTreeSet<u32>) -> usize {
    let mut n = 0;
    for inst in body {
        if dom_inst_refs(inst, locals) {
            n += 1;
        }
        match inst {
            Inst::If {
                then_body,
                else_body,
                ..
            } => {
                n += dom_ref_count(then_body, locals);
                n += dom_ref_count(else_body, locals);
            }
            Inst::Loop {
                cond_body, body, ..
            } => {
                n += dom_ref_count(cond_body, locals);
                n += dom_ref_count(body, locals);
            }
            Inst::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                n += dom_ref_count(try_body, locals);
                n += dom_ref_count(catch_body, locals);
                n += dom_ref_count(finally_body, locals);
            }
            _ => {}
        }
    }
    n
}

/// Returns true if, treating `defined` as the DOM locals known-defined on entry,
/// every DOM-local use in `body` is dominated by a definition on all paths.
/// `defined` is updated to the set definitely-defined at block exit. A `false`
/// result means some DOM local may be read before being (re)defined — i.e. it is
/// live-in — so the block is not safe to free per iteration.
fn dom_defs_dominate_uses(
    body: &[Inst],
    locals: &BTreeSet<u32>,
    defined: &mut BTreeSet<u32>,
) -> bool {
    for inst in body {
        match inst {
            Inst::If {
                cond,
                then_body,
                else_body,
            } => {
                if locals.contains(&cond.0) && !defined.contains(&cond.0) {
                    return false;
                }
                let mut dt = defined.clone();
                if !dom_defs_dominate_uses(then_body, locals, &mut dt) {
                    return false;
                }
                let mut de = defined.clone();
                if !dom_defs_dominate_uses(else_body, locals, &mut de) {
                    return false;
                }
                *defined = dt.intersection(&de).cloned().collect();
            }
            Inst::Loop {
                cond,
                cond_body,
                body: loop_body,
            } => {
                if locals.contains(&cond.0) && !defined.contains(&cond.0) {
                    return false;
                }
                // A nested loop may iterate zero times, so its definitions are not
                // guaranteed; check its parts with a clone and discard their defs.
                let mut d = defined.clone();
                if !dom_defs_dominate_uses(cond_body, locals, &mut d) {
                    return false;
                }
                if !dom_defs_dominate_uses(loop_body, locals, &mut d) {
                    return false;
                }
            }
            Inst::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                // Exceptions make merge points irregular; verify each part in
                // isolation and propagate no definitions out (conservative).
                let mut dt = defined.clone();
                if !dom_defs_dominate_uses(try_body, locals, &mut dt) {
                    return false;
                }
                let mut dc = defined.clone();
                if !dom_defs_dominate_uses(catch_body, locals, &mut dc) {
                    return false;
                }
                let mut df = defined.clone();
                if !dom_defs_dominate_uses(finally_body, locals, &mut df) {
                    return false;
                }
            }
            other => {
                // Any DOM local used here must already be defined. `undef` is the
                // set of not-yet-defined DOM locals; if `other` uses one, the use
                // is potentially live-in.
                let undef: BTreeSet<u32> = locals.difference(defined).cloned().collect();
                if !undef.is_empty() && inst_uses_any(other, &undef) {
                    return false;
                }
                if let Some(d) = json_dom_defined_dst(other) {
                    if locals.contains(&d) {
                        defined.insert(d);
                    }
                }
            }
        }
    }
    true
}

/// Decide whether a loop with body `loop_body` may free the JSON DOM scope at the
/// bottom of each iteration: every DOM-referencing instruction must be confined
/// to this body (`dom_ref_total` is the whole-function count) and no DOM local
/// may be live-in at the top of the body.
fn loop_body_frees_json_dom(
    loop_body: &[Inst],
    locals: &BTreeSet<u32>,
    dom_ref_total: usize,
) -> bool {
    if locals.is_empty() || dom_ref_total == 0 {
        return false;
    }
    if dom_ref_count(loop_body, locals) != dom_ref_total {
        return false;
    }
    let mut defined = BTreeSet::new();
    dom_defs_dominate_uses(loop_body, locals, &mut defined)
}

fn body_has_json_dom(body: &[Inst]) -> bool {
    !collect_json_dom_locals(body).is_empty()
}

fn collect_scalar_string_slices(body: &[Inst]) -> BTreeMap<u32, ScalarStringSlice> {
    let mut candidates = BTreeMap::new();
    let mut invalid = BTreeSet::new();
    let mut next_scope = 1;
    collect_scalar_string_slices_body(body, 0, &mut next_scope, &mut candidates, &mut invalid);
    validate_scalar_string_slices(body, &candidates, &mut invalid);
    for spec in candidates.values() {
        if candidates.contains_key(&spec.base)
            || spec.start.map_or(false, |id| candidates.contains_key(&id))
            || spec.end.map_or(false, |id| candidates.contains_key(&id))
        {
            invalid.insert(spec.root);
        }
    }
    candidates.retain(|_, spec| !invalid.contains(&spec.root));
    candidates
}

fn collect_scalar_string_slices_body(
    body: &[Inst],
    scope: u32,
    next_scope: &mut u32,
    out: &mut BTreeMap<u32, ScalarStringSlice>,
    invalid: &mut BTreeSet<u32>,
) {
    let mut local: BTreeMap<u32, ScalarStringSlice> = BTreeMap::new();
    let affines = scalar_slice_affines(body);
    for inst in body {
        if let Inst::CallBuiltin {
            dst: Some(dst),
            builtin,
            recv,
            args,
        } = inst
        {
            if let Some(kind) = scalar_slice_kind(builtin) {
                let start = args.first().map(|a| a.0);
                let end = args.get(1).map(|a| a.0);
                let spec = ScalarStringSlice {
                    root: dst.0,
                    base: recv.0,
                    scope,
                    kind,
                    start,
                    end,
                    exact_len: scalar_slice_exact_len(kind, start, end, &affines),
                };
                if let Some(prev) = local.get(&dst.0) {
                    if prev != &spec {
                        invalid.insert(prev.root);
                        invalid.insert(spec.root);
                    }
                } else {
                    local.insert(dst.0, spec);
                }
            }
        }
    }

    loop {
        let mut changed = false;
        for inst in body {
            if let Inst::Copy { dst, src } = inst {
                if let Some(spec) = local.get(&src.0).cloned() {
                    if let Some(prev) = local.get(&dst.0) {
                        if prev != &spec {
                            invalid.insert(prev.root);
                            invalid.insert(spec.root);
                        }
                    } else {
                        local.insert(dst.0, spec);
                        changed = true;
                    }
                }
            }
        }
        if !changed {
            break;
        }
    }

    for (id, spec) in local {
        if let Some(prev) = out.get(&id) {
            if prev != &spec {
                invalid.insert(prev.root);
                invalid.insert(spec.root);
            }
        } else {
            out.insert(id, spec);
        }
    }

    for inst in body {
        match inst {
            Inst::Loop {
                cond_body, body, ..
            } => {
                let cond_scope = *next_scope;
                *next_scope += 1;
                collect_scalar_string_slices_body(cond_body, cond_scope, next_scope, out, invalid);
                let body_scope = *next_scope;
                *next_scope += 1;
                collect_scalar_string_slices_body(body, body_scope, next_scope, out, invalid);
            }
            Inst::If {
                then_body,
                else_body,
                ..
            } => {
                let then_scope = *next_scope;
                *next_scope += 1;
                collect_scalar_string_slices_body(then_body, then_scope, next_scope, out, invalid);
                let else_scope = *next_scope;
                *next_scope += 1;
                collect_scalar_string_slices_body(else_body, else_scope, next_scope, out, invalid);
            }
            Inst::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                let try_scope = *next_scope;
                *next_scope += 1;
                collect_scalar_string_slices_body(try_body, try_scope, next_scope, out, invalid);
                let catch_scope = *next_scope;
                *next_scope += 1;
                collect_scalar_string_slices_body(
                    catch_body,
                    catch_scope,
                    next_scope,
                    out,
                    invalid,
                );
                let finally_scope = *next_scope;
                *next_scope += 1;
                collect_scalar_string_slices_body(
                    finally_body,
                    finally_scope,
                    next_scope,
                    out,
                    invalid,
                );
            }
            _ => {}
        }
    }
}

fn invalidate_scalar_use(
    candidates: &BTreeMap<u32, ScalarStringSlice>,
    invalid: &mut BTreeSet<u32>,
    id: u32,
) {
    if let Some(spec) = candidates.get(&id) {
        invalid.insert(spec.root);
    }
}

fn validate_scalar_callee(
    callee: &CalleeRef,
    candidates: &BTreeMap<u32, ScalarStringSlice>,
    invalid: &mut BTreeSet<u32>,
) {
    if let CalleeRef::Value { local } = callee {
        invalidate_scalar_use(candidates, invalid, local.0);
    }
}

fn validate_scalar_arg_specs(
    arg_specs: &[ArgSpec],
    candidates: &BTreeMap<u32, ScalarStringSlice>,
    invalid: &mut BTreeSet<u32>,
) {
    for sp in arg_specs {
        match sp {
            ArgSpec::Single { local } | ArgSpec::Spread { local } => {
                invalidate_scalar_use(candidates, invalid, local.0)
            }
        }
    }
}

fn validate_scalar_string_slices(
    body: &[Inst],
    candidates: &BTreeMap<u32, ScalarStringSlice>,
    invalid: &mut BTreeSet<u32>,
) {
    fn same_root_in_scope(
        candidates: &BTreeMap<u32, ScalarStringSlice>,
        a: u32,
        b: u32,
        scope: u32,
    ) -> bool {
        match (candidates.get(&a), candidates.get(&b)) {
            (Some(x), Some(y)) => x.root == y.root && x.scope == scope && y.scope == scope,
            _ => false,
        }
    }

    fn candidate_in_scope(
        candidates: &BTreeMap<u32, ScalarStringSlice>,
        id: u32,
        scope: u32,
    ) -> bool {
        candidates
            .get(&id)
            .map_or(false, |spec| spec.scope == scope)
    }

    fn check_def(
        inst: &Inst,
        scope: u32,
        candidates: &BTreeMap<u32, ScalarStringSlice>,
        invalid: &mut BTreeSet<u32>,
    ) {
        let allowed = match inst {
            Inst::CallBuiltin {
                dst: Some(dst),
                builtin,
                ..
            } if scalar_slice_kind(builtin).is_some() => candidates
                .get(&dst.0)
                .map_or(false, |spec| spec.root == dst.0 && spec.scope == scope),
            Inst::Copy { dst, src } => same_root_in_scope(candidates, dst.0, src.0, scope),
            _ => false,
        };
        if !allowed {
            if let Some(def) = inst_def_local(inst) {
                if let Some(spec) = candidates.get(&def) {
                    invalid.insert(spec.root);
                }
            }
        }
    }

    fn walk(
        body: &[Inst],
        scope: u32,
        next_scope: &mut u32,
        candidates: &BTreeMap<u32, ScalarStringSlice>,
        invalid: &mut BTreeSet<u32>,
    ) {
        for inst in body {
            check_def(inst, scope, candidates, invalid);
            match inst {
                Inst::AllocObject { proto, .. } => {
                    if let Some(p) = proto {
                        invalidate_scalar_use(candidates, invalid, p.0);
                    }
                }
                Inst::AllocClosure { captures, .. } | Inst::AllocClassValue { captures, .. } => {
                    for c in captures {
                        invalidate_scalar_use(candidates, invalid, c.cell.0);
                    }
                }
                Inst::Copy { dst, src } => {
                    if !same_root_in_scope(candidates, dst.0, src.0, scope) {
                        invalidate_scalar_use(candidates, invalid, src.0);
                    }
                }
                Inst::LoadField { obj, .. }
                | Inst::LoadMethodValue { recv: obj, .. }
                | Inst::LoadElem { arr: obj, .. }
                | Inst::DeleteField { obj, .. }
                | Inst::ObjectRest { src: obj, .. }
                | Inst::ObjectCopyProps { src: obj, .. }
                | Inst::GetProto { obj, .. }
                | Inst::Print { src: obj } => {
                    invalidate_scalar_use(candidates, invalid, obj.0);
                }
                Inst::StoreField { obj, src, .. } | Inst::StoreElem { arr: obj, src } => {
                    invalidate_scalar_use(candidates, invalid, obj.0);
                    invalidate_scalar_use(candidates, invalid, src.0);
                }
                Inst::NewDynamic { callee, args, .. } => {
                    invalidate_scalar_use(candidates, invalid, callee.0);
                    for a in args {
                        invalidate_scalar_use(candidates, invalid, a.0);
                    }
                }
                Inst::Call {
                    callee, recv, args, ..
                } => {
                    validate_scalar_callee(callee, candidates, invalid);
                    if let Some(r) = recv {
                        invalidate_scalar_use(candidates, invalid, r.0);
                    }
                    for a in args {
                        invalidate_scalar_use(candidates, invalid, a.0);
                    }
                }
                Inst::Return { src } => {
                    if let Some(src) = src {
                        invalidate_scalar_use(candidates, invalid, src.0);
                    }
                }
                Inst::Yield { operand, .. } | Inst::Await { operand, .. } => {
                    invalidate_scalar_use(candidates, invalid, operand.0);
                }
                Inst::Throw { src } | Inst::StoreGlobal { src, .. } => {
                    invalidate_scalar_use(candidates, invalid, src.0);
                }
                Inst::BinOp { lhs, rhs, .. } => {
                    invalidate_scalar_use(candidates, invalid, lhs.0);
                    invalidate_scalar_use(candidates, invalid, rhs.0);
                }
                Inst::UnOp { operand, .. } => {
                    invalidate_scalar_use(candidates, invalid, operand.0);
                }
                Inst::LoadIndex { arr, index, .. } => {
                    invalidate_scalar_use(candidates, invalid, arr.0);
                    invalidate_scalar_use(candidates, invalid, index.0);
                }
                Inst::StoreIndex { arr, index, src, .. } => {
                    invalidate_scalar_use(candidates, invalid, arr.0);
                    invalidate_scalar_use(candidates, invalid, index.0);
                    invalidate_scalar_use(candidates, invalid, src.0);
                }
                Inst::ArrayLen { arr, .. } => invalidate_scalar_use(candidates, invalid, arr.0),
                Inst::StringLen { src, .. } => {
                    if candidates.contains_key(&src.0)
                        && !candidate_in_scope(candidates, src.0, scope)
                    {
                        invalidate_scalar_use(candidates, invalid, src.0);
                    }
                }
                Inst::ArrayPush { arr, src } | Inst::ArrayPushAll { arr, src } => {
                    invalidate_scalar_use(candidates, invalid, arr.0);
                    invalidate_scalar_use(candidates, invalid, src.0);
                }
                Inst::HasField { obj, .. } => invalidate_scalar_use(candidates, invalid, obj.0),
                Inst::HasFieldDynamic { obj, key, .. }
                | Inst::LoadFieldDynamic { obj, key, .. } => {
                    invalidate_scalar_use(candidates, invalid, obj.0);
                    invalidate_scalar_use(candidates, invalid, key.0);
                }
                Inst::StoreFieldDynamic { obj, key, src } => {
                    invalidate_scalar_use(candidates, invalid, obj.0);
                    invalidate_scalar_use(candidates, invalid, key.0);
                    invalidate_scalar_use(candidates, invalid, src.0);
                }
                Inst::GenericLen { src, .. } => invalidate_scalar_use(candidates, invalid, src.0),
                Inst::ArraySlice { arr, start, .. } => {
                    invalidate_scalar_use(candidates, invalid, arr.0);
                    invalidate_scalar_use(candidates, invalid, start.0);
                }
                Inst::ConstructResult { inst, ret, .. } => {
                    invalidate_scalar_use(candidates, invalid, inst.0);
                    invalidate_scalar_use(candidates, invalid, ret.0);
                }
                Inst::CallSpread {
                    callee,
                    recv,
                    arg_specs,
                    ..
                } => {
                    validate_scalar_callee(callee, candidates, invalid);
                    if let Some(r) = recv {
                        invalidate_scalar_use(candidates, invalid, r.0);
                    }
                    validate_scalar_arg_specs(arg_specs, candidates, invalid);
                }
                Inst::StoreProtoMethod { src, .. } => {
                    invalidate_scalar_use(candidates, invalid, src.0);
                }
                Inst::StoreMethod { obj, src, .. } => {
                    invalidate_scalar_use(candidates, invalid, obj.0);
                    invalidate_scalar_use(candidates, invalid, src.0);
                }
                Inst::CallBuiltin {
                    builtin,
                    recv,
                    args,
                    ..
                } if builtin == "string.charCodeAt" => {
                    for a in args {
                        invalidate_scalar_use(candidates, invalid, a.0);
                    }
                    if candidates.contains_key(&recv.0)
                        && !candidate_in_scope(candidates, recv.0, scope)
                    {
                        invalidate_scalar_use(candidates, invalid, recv.0);
                    }
                }
                Inst::CallBuiltin {
                    builtin,
                    recv,
                    args,
                    ..
                } => {
                    invalidate_scalar_use(candidates, invalid, recv.0);
                    for a in args {
                        invalidate_scalar_use(candidates, invalid, a.0);
                    }
                    if scalar_slice_kind(builtin).is_some() {
                        // The defining dst is handled as a def, not as a use.
                    }
                }
                Inst::CallBuiltinStatic { args, .. } => {
                    for a in args {
                        invalidate_scalar_use(candidates, invalid, a.0);
                    }
                }
                Inst::SetProto { obj, proto, .. } => {
                    invalidate_scalar_use(candidates, invalid, obj.0);
                    invalidate_scalar_use(candidates, invalid, proto.0);
                }
                Inst::Loop {
                    cond,
                    cond_body,
                    body,
                } => {
                    invalidate_scalar_use(candidates, invalid, cond.0);
                    let cond_scope = *next_scope;
                    *next_scope += 1;
                    walk(cond_body, cond_scope, next_scope, candidates, invalid);
                    let body_scope = *next_scope;
                    *next_scope += 1;
                    walk(body, body_scope, next_scope, candidates, invalid);
                }
                Inst::If {
                    cond,
                    then_body,
                    else_body,
                } => {
                    invalidate_scalar_use(candidates, invalid, cond.0);
                    let then_scope = *next_scope;
                    *next_scope += 1;
                    walk(then_body, then_scope, next_scope, candidates, invalid);
                    let else_scope = *next_scope;
                    *next_scope += 1;
                    walk(else_body, else_scope, next_scope, candidates, invalid);
                }
                Inst::TryCatch {
                    try_body,
                    catch_body,
                    finally_body,
                    ..
                } => {
                    let try_scope = *next_scope;
                    *next_scope += 1;
                    walk(try_body, try_scope, next_scope, candidates, invalid);
                    let catch_scope = *next_scope;
                    *next_scope += 1;
                    walk(catch_body, catch_scope, next_scope, candidates, invalid);
                    let finally_scope = *next_scope;
                    *next_scope += 1;
                    walk(finally_body, finally_scope, next_scope, candidates, invalid);
                }
                Inst::LoadGlobal { .. }
                | Inst::AllocArray { .. }
                | Inst::Const { .. }
                | Inst::Break { .. }
                | Inst::Continue { .. }
                | Inst::LoadClassProto { .. }
                | Inst::LoadBuiltinFn { .. }
                | Inst::NewMap { .. }
                | Inst::NewSet { .. } => {}
            }
        }
    }

    let mut next_scope = 1;
    walk(body, 0, &mut next_scope, candidates, invalid);
}

fn collect_loop_nonneg_subs(body: &[Inst], out: &mut BTreeSet<u32>) {
    fn relation(cond: LocalId, cond_body: &[Inst]) -> Option<(u32, u32)> {
        for inst in cond_body {
            if let Inst::BinOp { dst, op, lhs, rhs } = inst {
                if dst.0 == cond.0 && matches!(op.as_str(), "<" | "<=") {
                    return Some((lhs.0, rhs.0));
                }
            }
        }
        None
    }
    fn mark_subs(body: &[Inst], smaller: u32, larger: u32, out: &mut BTreeSet<u32>) {
        for inst in body {
            match inst {
                Inst::BinOp { dst, op, lhs, rhs }
                    if op == "-" && lhs.0 == larger && rhs.0 == smaller =>
                {
                    out.insert(dst.0);
                }
                Inst::Loop {
                    cond_body, body, ..
                } => {
                    mark_subs(cond_body, smaller, larger, out);
                    mark_subs(body, smaller, larger, out);
                }
                Inst::If {
                    then_body,
                    else_body,
                    ..
                } => {
                    mark_subs(then_body, smaller, larger, out);
                    mark_subs(else_body, smaller, larger, out);
                }
                Inst::TryCatch {
                    try_body,
                    catch_body,
                    finally_body,
                    ..
                } => {
                    mark_subs(try_body, smaller, larger, out);
                    mark_subs(catch_body, smaller, larger, out);
                    mark_subs(finally_body, smaller, larger, out);
                }
                _ => {}
            }
        }
    }
    for inst in body {
        match inst {
            Inst::Loop {
                cond,
                cond_body,
                body,
            } => {
                if let Some((smaller, larger)) = relation(*cond, cond_body) {
                    mark_subs(body, smaller, larger, out);
                }
                collect_loop_nonneg_subs(cond_body, out);
                collect_loop_nonneg_subs(body, out);
            }
            Inst::If {
                then_body,
                else_body,
                ..
            } => {
                collect_loop_nonneg_subs(then_body, out);
                collect_loop_nonneg_subs(else_body, out);
            }
            Inst::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                collect_loop_nonneg_subs(try_body, out);
                collect_loop_nonneg_subs(catch_body, out);
                collect_loop_nonneg_subs(finally_body, out);
            }
            _ => {}
        }
    }
}

fn inst_def_local(inst: &Inst) -> Option<u32> {
    match inst {
        Inst::AllocObject { dst, .. }
        | Inst::AllocArray { dst, .. }
        | Inst::AllocClosure { dst, .. }
        | Inst::Copy { dst, .. }
        | Inst::LoadField { dst, .. }
        | Inst::LoadMethodValue { dst, .. }
        | Inst::LoadBuiltinFn { dst, .. }
        | Inst::AllocClassValue { dst, .. }
        | Inst::NewDynamic { dst, .. }
        | Inst::LoadElem { dst, .. }
        | Inst::LoadGlobal { dst, .. }
        | Inst::Const { dst, .. }
        | Inst::BinOp { dst, .. }
        | Inst::UnOp { dst, .. }
        | Inst::LoadIndex { dst, .. }
        | Inst::ArrayLen { dst, .. }
        | Inst::StringLen { dst, .. }
        | Inst::HasField { dst, .. }
        | Inst::HasFieldDynamic { dst, .. }
        | Inst::GenericLen { dst, .. }
        | Inst::LoadFieldDynamic { dst, .. }
        | Inst::ArraySlice { dst, .. }
        | Inst::ObjectRest { dst, .. }
        | Inst::ObjectCopyProps { dst, .. }
        | Inst::ConstructResult { dst, .. }
        | Inst::LoadClassProto { dst, .. }
        | Inst::GetProto { dst, .. }
        | Inst::NewMap { dst }
        | Inst::NewSet { dst } => Some(dst.0),
        Inst::Call { dst: Some(dst), .. }
        | Inst::Yield { dst: Some(dst), .. }
        | Inst::Await { dst: Some(dst), .. }
        | Inst::DeleteField { dst: Some(dst), .. }
        | Inst::CallSpread { dst: Some(dst), .. }
        | Inst::CallBuiltin { dst: Some(dst), .. }
        | Inst::CallBuiltinStatic { dst: Some(dst), .. }
        | Inst::SetProto { dst: Some(dst), .. } => Some(dst.0),
        _ => None,
    }
}

fn callee_uses_any(callee: &CalleeRef, ids: &BTreeSet<u32>) -> bool {
    match callee {
        CalleeRef::Value { local } => ids.contains(&local.0),
        _ => false,
    }
}

fn arg_spec_uses_any(spec: &ArgSpec, ids: &BTreeSet<u32>) -> bool {
    match spec {
        ArgSpec::Single { local } | ArgSpec::Spread { local } => ids.contains(&local.0),
    }
}

fn inst_uses_any(inst: &Inst, ids: &BTreeSet<u32>) -> bool {
    match inst {
        Inst::AllocObject { proto, .. } => proto.map(|p| ids.contains(&p.0)).unwrap_or(false),
        Inst::AllocClosure { captures, .. } => captures.iter().any(|c| ids.contains(&c.cell.0)),
        Inst::Copy { src, .. }
        | Inst::StoreElem { src, .. }
        | Inst::Return { src: Some(src) }
        | Inst::Yield { operand: src, .. }
        | Inst::Await { operand: src, .. }
        | Inst::Throw { src }
        | Inst::StoreGlobal { src, .. }
        | Inst::UnOp { operand: src, .. }
        | Inst::ArrayPush { src, .. }
        | Inst::ArrayPushAll { src, .. }
        | Inst::ObjectRest { src, .. }
        | Inst::ObjectCopyProps { src, .. }
        | Inst::Print { src }
        | Inst::StoreProtoMethod { src, .. }
        | Inst::StoreMethod { src, .. } => ids.contains(&src.0),
        Inst::LoadField { obj, .. }
        | Inst::LoadMethodValue { recv: obj, .. }
        | Inst::NewDynamic { callee: obj, .. }
        | Inst::LoadElem { arr: obj, .. }
        | Inst::ArrayLen { arr: obj, .. }
        | Inst::StringLen { src: obj, .. }
        | Inst::GenericLen { src: obj, .. }
        | Inst::DeleteField { obj, .. }
        | Inst::GetProto { obj, .. } => ids.contains(&obj.0),
        Inst::StoreField { obj, src, .. }
        | Inst::SetProto {
            obj, proto: src, ..
        } => ids.contains(&obj.0) || ids.contains(&src.0),
        Inst::StoreFieldDynamic { obj, key, src } => {
            ids.contains(&obj.0) || ids.contains(&key.0) || ids.contains(&src.0)
        }
        Inst::StoreIndex { arr, index, src, .. } => {
            ids.contains(&arr.0) || ids.contains(&index.0) || ids.contains(&src.0)
        }
        Inst::AllocClassValue { captures, .. } => captures.iter().any(|c| ids.contains(&c.cell.0)),
        Inst::Call {
            callee, recv, args, ..
        } => {
            recv.map(|r| ids.contains(&r.0)).unwrap_or(false)
                || callee_uses_any(callee, ids)
                || args.iter().any(|a| ids.contains(&a.0))
        }
        Inst::CallSpread {
            callee,
            recv,
            arg_specs,
            ..
        } => {
            recv.map(|r| ids.contains(&r.0)).unwrap_or(false)
                || callee_uses_any(callee, ids)
                || arg_specs.iter().any(|a| arg_spec_uses_any(a, ids))
        }
        Inst::TryCatch {
            try_body,
            catch_body,
            finally_body,
            ..
        } => {
            try_body.iter().any(|i| inst_uses_any(i, ids))
                || catch_body.iter().any(|i| inst_uses_any(i, ids))
                || finally_body.iter().any(|i| inst_uses_any(i, ids))
        }
        Inst::BinOp { lhs, rhs, .. }
        | Inst::LoadIndex {
            arr: lhs,
            index: rhs,
            ..
        }
        | Inst::HasFieldDynamic {
            obj: lhs, key: rhs, ..
        }
        | Inst::LoadFieldDynamic {
            obj: lhs, key: rhs, ..
        } => ids.contains(&lhs.0) || ids.contains(&rhs.0),
        Inst::CallBuiltin { recv, args, .. } => {
            ids.contains(&recv.0) || args.iter().any(|a| ids.contains(&a.0))
        }
        Inst::CallBuiltinStatic { args, .. } => args.iter().any(|a| ids.contains(&a.0)),
        Inst::If {
            cond,
            then_body,
            else_body,
        } => {
            ids.contains(&cond.0)
                || then_body.iter().any(|i| inst_uses_any(i, ids))
                || else_body.iter().any(|i| inst_uses_any(i, ids))
        }
        Inst::Loop {
            cond,
            cond_body,
            body,
        } => {
            ids.contains(&cond.0)
                || cond_body.iter().any(|i| inst_uses_any(i, ids))
                || body.iter().any(|i| inst_uses_any(i, ids))
        }
        Inst::HasField { obj, .. } => ids.contains(&obj.0),
        Inst::ConstructResult { inst, ret, .. } => ids.contains(&inst.0) || ids.contains(&ret.0),
        _ => false,
    }
}

fn locals_used_after(body: &[Inst], from: usize, ids: &BTreeSet<u32>) -> bool {
    body.iter().skip(from).any(|inst| inst_uses_any(inst, ids))
}

fn is_straight_line_loop_part(body: &[Inst]) -> bool {
    body.iter().all(|inst| {
        !matches!(
            inst,
            Inst::Return { .. }
                | Inst::Yield { .. }
                | Inst::Await { .. }
                | Inst::Throw { .. }
                | Inst::TryCatch { .. }
                | Inst::Break { .. }
                | Inst::Continue { .. }
                | Inst::Loop { .. }
                | Inst::If { .. }
        )
    })
}

fn loop_increment_induction(cond_body: &[Inst], body: &[Inst], ctx: &Ctx) -> Option<u32> {
    if body.len() < 2 || !is_straight_line_loop_part(cond_body) || !is_straight_line_loop_part(body)
    {
        return None;
    }
    let (copy_inst, bin_inst) = (body.last()?, body.get(body.len().saturating_sub(2))?);
    let (ind, tmp) = match copy_inst {
        Inst::Copy { dst, src } => (dst.0, src.0),
        _ => return None,
    };
    let (add_dst, lhs, rhs) = match bin_inst {
        Inst::BinOp { dst, op, lhs, rhs } if op == "+" => (dst.0, lhs.0, rhs.0),
        _ => return None,
    };
    if add_dst != tmp || !ctx.int_local.contains(&ind) || !ctx.nonnegative_int.contains(&ind) {
        return None;
    }
    let is_inc_one = (lhs == ind && ctx.int_const.get(&rhs) == Some(&1))
        || (rhs == ind && ctx.int_const.get(&lhs) == Some(&1));
    if !is_inc_one {
        return None;
    }
    if cond_body
        .iter()
        .any(|inst| inst_def_local(inst) == Some(ind))
        || body[..body.len() - 1]
            .iter()
            .any(|inst| inst_def_local(inst) == Some(ind))
    {
        return None;
    }
    Some(ind)
}

fn loop_mod_residue_candidates(
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
    top_label: u32,
) -> Vec<LoopModResidue> {
    let Some(ind) = loop_increment_induction(cond_body, body, ctx) else {
        return Vec::new();
    };
    let mut out: BTreeMap<(u32, u32), LoopModResidue> = BTreeMap::new();
    for inst in body.iter().take(body.len().saturating_sub(2)) {
        if let Inst::BinOp { dst, op, lhs, rhs } = inst {
            if op == "%"
                && lhs.0 == ind
                && ctx.int_local.contains(&dst.0)
                && ctx.int_local.contains(&rhs.0)
            {
                if let Some(&divisor) = ctx.int_const.get(&rhs.0) {
                    if divisor > 1 {
                        let var = format!("_lm{}_{}_{}", top_label, ind, rhs.0);
                        out.entry((ind, rhs.0)).or_insert(LoopModResidue {
                            ind,
                            rhs: rhs.0,
                            divisor,
                            var,
                        });
                    }
                }
            }
        }
    }
    out.into_values().collect()
}

/// An ordered set of instruction indices. Dense indices make a bitset cheaper
/// than allocating/rebalancing tree nodes during every numeric-analysis sweep.
struct InstructionWorklist {
    words: Vec<u64>,
    first: usize,
}

impl InstructionWorklist {
    fn new(len: usize, filled: bool) -> Self {
        let mut words = vec![if filled { u64::MAX } else { 0 }; len.div_ceil(64)];
        if filled && len % 64 != 0 {
            *words.last_mut().unwrap() = (1u64 << (len % 64)) - 1;
        }
        let first = if filled { 0 } else { words.len() };
        Self { words, first }
    }

    fn insert(&mut self, index: usize) {
        let word = index / 64;
        self.words[word] |= 1u64 << (index % 64);
        self.first = self.first.min(word);
    }

    fn is_empty(&self) -> bool {
        self.first == self.words.len()
    }

    fn pop_first(&mut self) -> Option<usize> {
        if self.is_empty() {
            return None;
        }
        let word = self.first;
        let bits = self.words[word];
        self.words[word] = bits & (bits - 1);
        while self.first < self.words.len() && self.words[self.first] == 0 {
            self.first += 1;
        }
        Some(word * 64 + bits.trailing_zeros() as usize)
    }
}

#[cfg(test)]
mod instruction_worklist_tests {
    use super::InstructionWorklist;
    use std::collections::BTreeSet;

    #[test]
    fn matches_ordered_set_across_word_boundaries() {
        for len in [0, 1, 63, 64, 65, 129, 4097] {
            for filled in [false, true] {
                let mut work = InstructionWorklist::new(len, filled);
                let mut expected: BTreeSet<usize> = if filled {
                    (0..len).collect()
                } else {
                    BTreeSet::new()
                };
                let mut random = 0x12345678u32;
                for _ in 0..2000 {
                    random = random.wrapping_mul(1664525).wrapping_add(1013904223);
                    if len != 0 && random & 3 != 0 {
                        let index = (random >> 2) as usize % len;
                        work.insert(index);
                        expected.insert(index);
                    } else {
                        assert_eq!(work.pop_first(), expected.pop_first());
                    }
                    assert_eq!(work.is_empty(), expected.is_empty());
                }
                while !expected.is_empty() {
                    assert_eq!(work.pop_first(), expected.pop_first());
                }
                assert_eq!(work.pop_first(), None);
                assert!(work.is_empty());
                if len != 0 {
                    work.insert(0);
                    assert_eq!(work.pop_first(), Some(0));
                    assert_eq!(work.pop_first(), None);
                }
            }
        }
    }
}

/* ---- int32 locals for bitwise-only uses (docs/int32_use_locals_design.md) ----
   The checker's flag idiom reads a number once (`const t = target.flags`)
   and tests it against twenty constants (`t & TypeFlags.X`); every test
   applied ToInt32 to the double. An unboxed, non-parameter local whose every
   use is an operand of `& | ^ << >> >>>` or `~`, or a copy into another such
   local, holds ToInt32 of its value from the definition on: ToInt32 is a
   function of the value, so applying it once at each definition and casting
   at the uses is exactly the per-use semantics (NaN and infinities become 0,
   fractions truncate toward zero, out-of-range values wrap). The local stays
   a double, so every definition path keeps its type and only the conversion
   moves. TSAOT_INT32_USES=0 disables it (parity oracle). */
fn int32_uses_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_INT32_USES").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}
fn is_bitwise_op(op: &str) -> bool {
    matches!(op, "&" | "|" | "^" | "<<" | ">>" | ">>>")
}
/// A use of `x` in `body` that is not a bitwise operand, a `~` operand or a
/// copy into a candidate (nested bodies included).
fn int32_disallowed_use(body: &[Inst], x: u32, cands: &BTreeSet<u32>) -> bool {
    let one: BTreeSet<u32> = std::iter::once(x).collect();
    body.iter().any(|inst| match inst {
        Inst::BinOp { lhs, rhs, op, .. } => (lhs.0 == x || rhs.0 == x) && !is_bitwise_op(op),
        Inst::UnOp { operand, op, .. } => operand.0 == x && op != "~",
        Inst::Copy { dst, src } => src.0 == x && !cands.contains(&dst.0),
        Inst::If {
            cond,
            then_body,
            else_body,
        } => {
            cond.0 == x
                || int32_disallowed_use(then_body, x, cands)
                || int32_disallowed_use(else_body, x, cands)
        }
        Inst::Loop {
            cond,
            cond_body,
            body,
        } => {
            cond.0 == x
                || int32_disallowed_use(cond_body, x, cands)
                || int32_disallowed_use(body, x, cands)
        }
        Inst::TryCatch {
            try_body,
            catch_body,
            finally_body,
            ..
        } => {
            int32_disallowed_use(try_body, x, cands)
                || int32_disallowed_use(catch_body, x, cands)
                || int32_disallowed_use(finally_body, x, cands)
        }
        other => inst_uses_any(other, &one),
    })
}
fn int32_use_locals(f: &Function, unboxed: &BTreeSet<u32>, int_local: &BTreeSet<u32>) -> BTreeSet<u32> {
    if !int32_uses_enabled() {
        return BTreeSet::new();
    }
    let params: BTreeSet<u32> = f.params.iter().map(|p| p.0).collect();
    let mut cands: BTreeSet<u32> = unboxed
        .iter()
        .copied()
        .filter(|id| !int_local.contains(id) && !params.contains(id))
        .collect();
    loop {
        let snapshot = cands.clone();
        cands.retain(|&x| !int32_disallowed_use(&f.body, x, &snapshot));
        if cands.len() == snapshot.len() {
            break;
        }
    }
    cands
}

/// The field loads of a body that read an integer slot (an int32-tagged field
/// of the receiver's hinted class, the declaring ancestor's tag deciding):
/// their values are int32 for the numeric analysis.
fn int32_field_loads(body: &[Inst], classes: &BTreeMap<u32, &ClassDef>) -> BTreeSet<usize> {
    let mut out = BTreeSet::new();
    if !int_fields_enabled() {
        return out;
    }
    let mut flat: Vec<&Inst> = Vec::new();
    flatten_inst(body, &mut flat);
    for inst in &flat {
        if let Inst::LoadField { field, cls, .. } = inst {
            if *cls != 0 && int32_field(*cls - 1, field.0, classes) {
                out.insert(*inst as *const Inst as usize);
            }
        }
    }
    out
}

fn infer_numeric_analysis(
    body: &[Inst],
    unboxed: &BTreeSet<u32>,
    param_facts: &BTreeMap<u32, NumFact>,
    return_facts: &BTreeMap<u32, NumFact>,
    int32_loads: &BTreeSet<usize>,
) -> NumericAnalysis {
    let mut flat: Vec<&Inst> = Vec::new();
    flatten_inst(body, &mut flat);
    let mut loop_nonneg_subs = BTreeSet::new();
    collect_loop_nonneg_subs(body, &mut loop_nonneg_subs);

    let mut facts: BTreeMap<u32, NumFact> = param_facts.clone();
    let get = |facts: &BTreeMap<u32, NumFact>, id: u32| -> NumFact {
        facts.get(&id).cloned().unwrap_or_else(NumFact::unknown)
    };
    let merge = |facts: &mut BTreeMap<u32, NumFact>, id: u32, nf: NumFact| -> bool {
        let next = if let Some(old) = facts.get(&id) {
            old.join(&nf)
        } else {
            nf
        };
        if facts.get(&id) != Some(&next) {
            facts.insert(id, next);
            true
        } else {
            false
        }
    };

    // Keep the existing forward-sweep order, but revisit only definitions whose
    // inputs changed. Range widening in a small loop can otherwise force every
    // unrelated module initializer through thousands of full scans.
    let mut users: BTreeMap<u32, Vec<usize>> = BTreeMap::new();
    for (index, inst) in flat.iter().enumerate() {
        match inst {
            Inst::Copy { src, .. } => users.entry(src.0).or_default().push(index),
            Inst::UnOp { operand, .. } => users.entry(operand.0).or_default().push(index),
            Inst::BinOp { lhs, rhs, .. } => {
                users.entry(lhs.0).or_default().push(index);
                if lhs != rhs {
                    users.entry(rhs.0).or_default().push(index);
                }
            }
            _ => {}
        }
    }
    let mut dirty = InstructionWorklist::new(flat.len(), true);
    let mut next_sweep = InstructionWorklist::new(flat.len(), false);
    while !dirty.is_empty() {
        while let Some(index) = dirty.pop_first() {
            let inst = flat[index];
            let def: Option<(u32, NumFact)> = match inst {
                Inst::Const { dst, value } => {
                    let f = match value {
                        ConstVal::Num { value } => safe_i64_num(*value)
                            .map(NumFact::int_const)
                            .unwrap_or_else(NumFact::unknown),
                        ConstVal::Bool { value } => NumFact::int_const(if *value { 1 } else { 0 }),
                        ConstVal::NegZero | ConstVal::NaN | ConstVal::PosInf | ConstVal::NegInf => {
                            NumFact::unknown()
                        }
                        _ => NumFact::unknown(),
                    };
                    Some((dst.0, f))
                }
                Inst::Copy { dst, src } => Some((dst.0, get(&facts, src.0))),
                Inst::UnOp { dst, op, operand } => {
                    let a = get(&facts, operand.0);
                    let f = match op.as_str() {
                        "!" | "nullish" | "isundef" => NumFact::bool_value(),
                        "~" => NumFact {
                            i64_safe: true,
                            nonneg: false,
                            maybe_zero: true,
                            const_i64: None,
                            min_i64: None,
                            max_i64: None,
                        },
                        "+" => a,
                        "-" => {
                            if let Some(c) = a.const_i64 {
                                if c == 0 {
                                    NumFact::unknown()
                                } else {
                                    checked_safe_i64(-(c as i128))
                                        .map(NumFact::int_const)
                                        .unwrap_or_else(NumFact::unknown)
                                }
                            } else if a.i64_safe && !a.maybe_zero {
                                let (min_i64, max_i64) = range_of(&a)
                                    .and_then(|(min, max)| {
                                        checked_range(-(max as i128), -(min as i128))
                                    })
                                    .map(|nf| (nf.min_i64, nf.max_i64))
                                    .unwrap_or((None, None));
                                NumFact {
                                    i64_safe: true,
                                    nonneg: false,
                                    maybe_zero: false,
                                    const_i64: None,
                                    min_i64,
                                    max_i64,
                                }
                            } else {
                                NumFact::unknown()
                            }
                        }
                        _ => NumFact::unknown(),
                    };
                    Some((dst.0, f))
                }
                Inst::BinOp { dst, op, lhs, rhs } => {
                    let l = get(&facts, lhs.0);
                    let r = get(&facts, rhs.0);
                    let f = match op.as_str() {
                        "<" | "<=" | ">" | ">=" | "==" | "!=" | "===" | "!==" => {
                            NumFact::bool_value()
                        }
                        "&" | "|" | "^" | "<<" | ">>" => NumFact {
                            i64_safe: true,
                            nonneg: false,
                            maybe_zero: true,
                            const_i64: None,
                            min_i64: None,
                            max_i64: None,
                        },
                        ">>>" => NumFact {
                            i64_safe: true,
                            nonneg: true,
                            maybe_zero: true,
                            const_i64: None,
                            min_i64: None,
                            max_i64: None,
                        },
                        "+" => {
                            if let (Some(a), Some(b)) = (l.const_i64, r.const_i64) {
                                checked_safe_i64(a as i128 + b as i128)
                                    .map(NumFact::int_const)
                                    .unwrap_or_else(NumFact::unknown)
                            } else if l.i64_safe && r.i64_safe {
                                if let (Some((lmin, lmax)), Some((rmin, rmax))) =
                                    (range_of(&l), range_of(&r))
                                {
                                    checked_range(
                                        lmin as i128 + rmin as i128,
                                        lmax as i128 + rmax as i128,
                                    )
                                    .unwrap_or_else(|| {
                                        NumFact {
                                            i64_safe: true,
                                            nonneg: l.nonneg && r.nonneg,
                                            maybe_zero: l.maybe_zero && r.maybe_zero,
                                            const_i64: None,
                                            min_i64: None,
                                            max_i64: None,
                                        }
                                    })
                                } else {
                                    NumFact {
                                        i64_safe: true,
                                        nonneg: l.nonneg && r.nonneg,
                                        maybe_zero: l.maybe_zero && r.maybe_zero,
                                        const_i64: None,
                                        min_i64: None,
                                        max_i64: None,
                                    }
                                }
                            } else {
                                NumFact::unknown()
                            }
                        }
                        "-" => {
                            if let (Some(a), Some(b)) = (l.const_i64, r.const_i64) {
                                checked_safe_i64(a as i128 - b as i128)
                                    .map(NumFact::int_const)
                                    .unwrap_or_else(NumFact::unknown)
                            } else if l.i64_safe && r.i64_safe {
                                if let (Some((lmin, lmax)), Some((rmin, rmax))) =
                                    (range_of(&l), range_of(&r))
                                {
                                    checked_range(
                                        lmin as i128 - rmax as i128,
                                        lmax as i128 - rmin as i128,
                                    )
                                    .unwrap_or_else(|| {
                                        NumFact {
                                            i64_safe: true,
                                            nonneg: loop_nonneg_subs.contains(&dst.0),
                                            maybe_zero: true,
                                            const_i64: None,
                                            min_i64: None,
                                            max_i64: None,
                                        }
                                    })
                                } else {
                                    NumFact {
                                        i64_safe: true,
                                        nonneg: loop_nonneg_subs.contains(&dst.0),
                                        maybe_zero: true,
                                        const_i64: None,
                                        min_i64: None,
                                        max_i64: None,
                                    }
                                }
                            } else {
                                NumFact::unknown()
                            }
                        }
                        "*" => {
                            if let (Some(a), Some(b)) = (l.const_i64, r.const_i64) {
                                if (a == 0 && b < 0) || (b == 0 && a < 0) {
                                    NumFact::unknown()
                                } else {
                                    checked_safe_i64(a as i128 * b as i128)
                                        .map(NumFact::int_const)
                                        .unwrap_or_else(NumFact::unknown)
                                }
                            } else if l.i64_safe
                                && r.i64_safe
                                && (!l.maybe_zero || r.nonneg)
                                && (!r.maybe_zero || l.nonneg)
                            {
                                if let (Some((lmin, lmax)), Some((rmin, rmax))) =
                                    (range_of(&l), range_of(&r))
                                {
                                    let vals = [
                                        lmin as i128 * rmin as i128,
                                        lmin as i128 * rmax as i128,
                                        lmax as i128 * rmin as i128,
                                        lmax as i128 * rmax as i128,
                                    ];
                                    let min = *vals.iter().min().unwrap();
                                    let max = *vals.iter().max().unwrap();
                                    // Multiplication is i64-safe ONLY when the product
                                    // provably stays within ±2^53. Unlike +/-, a product of
                                    // two unbounded i64-safe values can reach ~2^106 and wrap
                                    // a long long (2^63) into garbage — JS (double) would
                                    // instead lose precision / go to Infinity. The width
                                    // limit only governs how precisely we keep the range, NOT
                                    // safety: a provably-±2^53 product stays i64 even when its
                                    // range is too wide to track (e.g. `(i%1000)*((n-i)%1000)`
                                    // → [0, 998001]), so hot integer kernels keep the fast
                                    // path. Only an unprovable / >2^53 product drops to double.
                                    if checked_safe_i64(min).is_some()
                                        && checked_safe_i64(max).is_some()
                                    {
                                        checked_range(min, max).unwrap_or_else(|| NumFact {
                                            i64_safe: true,
                                            nonneg: l.nonneg && r.nonneg,
                                            maybe_zero: l.maybe_zero || r.maybe_zero,
                                            const_i64: None,
                                            min_i64: None,
                                            max_i64: None,
                                        })
                                    } else {
                                        NumFact::unknown()
                                    }
                                } else {
                                    NumFact::unknown()
                                }
                            } else {
                                NumFact::unknown()
                            }
                        }
                        "%" => {
                            if let Some(b) = r.const_i64 {
                                if b != 0 && l.i64_safe && l.nonneg {
                                    if let Some(a) = l.const_i64 {
                                        NumFact::int_const(a % b)
                                    } else {
                                        let max = b.abs().saturating_sub(1);
                                        if range_width_ok(0, max) {
                                            NumFact::range(0, max)
                                        } else {
                                            NumFact {
                                                i64_safe: true,
                                                nonneg: true,
                                                maybe_zero: true,
                                                const_i64: None,
                                                min_i64: None,
                                                max_i64: None,
                                            }
                                        }
                                    }
                                } else {
                                    NumFact::unknown()
                                }
                            } else if l.i64_safe && l.nonneg && r.i64_safe && !r.maybe_zero {
                                if let Some((rmin, rmax)) = range_of(&r) {
                                    let max_abs = (rmin as i128).abs().max((rmax as i128).abs());
                                    checked_range(0, max_abs.saturating_sub(1)).unwrap_or_else(
                                        || NumFact {
                                            i64_safe: true,
                                            nonneg: true,
                                            maybe_zero: true,
                                            const_i64: None,
                                            min_i64: None,
                                            max_i64: None,
                                        },
                                    )
                                } else {
                                    NumFact {
                                        i64_safe: true,
                                        nonneg: true,
                                        maybe_zero: true,
                                        const_i64: None,
                                        min_i64: None,
                                        max_i64: None,
                                    }
                                }
                            } else {
                                NumFact::unknown()
                            }
                        }
                        _ => NumFact::unknown(),
                    };
                    Some((dst.0, f))
                }
                Inst::ArrayLen { dst, .. }
                | Inst::StringLen { dst, .. }
                | Inst::GenericLen { dst, .. } => Some((dst.0, NumFact::nonnegative_i64_value())),
                Inst::LoadField { dst, .. } if int32_loads.contains(&(inst as *const Inst as usize)) => {
                    Some((dst.0, NumFact::int32_value()))
                }
                Inst::LoadField { dst, .. }
                | Inst::LoadElem { dst, .. }
                | Inst::LoadGlobal { dst, .. }
                | Inst::LoadIndex { dst, .. }
                | Inst::HasField { dst, .. }
                | Inst::HasFieldDynamic { dst, .. }
                | Inst::LoadFieldDynamic { dst, .. }
                | Inst::DeleteField { dst: Some(dst), .. }
                | Inst::ArraySlice { dst, .. }
                | Inst::ObjectRest { dst, .. }
                | Inst::ObjectCopyProps { dst, .. }
                | Inst::ConstructResult { dst, .. }
                | Inst::LoadClassProto { dst, .. }
                | Inst::GetProto { dst, .. }
                | Inst::NewMap { dst }
                | Inst::NewSet { dst } => Some((dst.0, NumFact::unknown())),
                Inst::Call {
                    dst: Some(d),
                    callee: CalleeRef::Direct { func },
                    ..
                } => Some((
                    d.0,
                    return_facts
                        .get(&func.0)
                        .cloned()
                        .unwrap_or_else(NumFact::unknown),
                )),
                Inst::Call {
                    dst: Some(d),
                    callee: CalleeRef::Set { funcs },
                    ..
                } => {
                    let mut it = funcs.iter();
                    let f = if let Some(first) = it.next() {
                        let mut acc = return_facts
                            .get(&first.0)
                            .cloned()
                            .unwrap_or_else(NumFact::unknown);
                        for func in it {
                            acc = acc.join(
                                &return_facts
                                    .get(&func.0)
                                    .cloned()
                                    .unwrap_or_else(NumFact::unknown),
                            );
                        }
                        acc
                    } else {
                        NumFact::unknown()
                    };
                    Some((d.0, f))
                }
                Inst::CallBuiltin {
                    dst: Some(d),
                    builtin,
                    ..
                } => {
                    let f = match builtin.as_str() {
                        // An out-of-range index produces NaN, even when its
                        // static TypeScript type is number.
                        "string.charCodeAt" => NumFact::unknown(),
                        "string.indexOf" | "string.lastIndexOf" => NumFact::i64_value(),
                        _ => NumFact::unknown(),
                    };
                    Some((d.0, f))
                }
                Inst::CallBuiltinStatic {
                    dst: Some(d),
                    builtin,
                    ..
                } => {
                    let f = match builtin.as_str() {
                        "json.num.len" | "json.string.len" => NumFact::nonnegative_i64_value(),
                        "math.imul" if imul_inline_enabled() => NumFact::int32_value(),
                        _ => NumFact::unknown(),
                    };
                    Some((d.0, f))
                }
                Inst::Call { dst: Some(d), .. }
                | Inst::CallSpread { dst: Some(d), .. }
                | Inst::Yield { dst: Some(d), .. }
                | Inst::Await { dst: Some(d), .. }
                | Inst::SetProto { dst: Some(d), .. } => Some((d.0, NumFact::unknown())),
                _ => None,
            };
            if let Some((id, nf)) = def {
                if merge(&mut facts, id, nf) {
                    if let Some(dependents) = users.get(&id) {
                        for &user in dependents {
                            if user > index {
                                dirty.insert(user);
                            } else {
                                next_sweep.insert(user);
                            }
                        }
                    }
                }
            }
        }
        std::mem::swap(&mut dirty, &mut next_sweep);
    }

    let int_local: BTreeSet<u32> = facts
        .iter()
        .filter_map(|(id, f)| {
            if unboxed.contains(id) && f.i64_safe {
                Some(*id)
            } else {
                None
            }
        })
        .collect();
    let nonzero_int_const: BTreeSet<u32> = facts
        .iter()
        .filter_map(|(id, f)| {
            if matches!(f.const_i64, Some(n) if n != 0) {
                Some(*id)
            } else {
                None
            }
        })
        .collect();
    let nonzero_int: BTreeSet<u32> = facts
        .iter()
        .filter_map(|(id, f)| {
            if f.i64_safe && !f.maybe_zero {
                Some(*id)
            } else {
                None
            }
        })
        .collect();
    let int_const: BTreeMap<u32, i64> = facts
        .iter()
        .filter_map(|(id, f)| f.const_i64.map(|n| (*id, n)))
        .collect();
    let nonnegative_int: BTreeSet<u32> = facts
        .iter()
        .filter_map(|(id, f)| {
            if f.i64_safe && f.nonneg {
                Some(*id)
            } else {
                None
            }
        })
        .collect();
    NumericAnalysis {
        facts,
        int_local,
        nonzero_int_const,
        nonzero_int,
        int_const,
        nonnegative_int,
    }
}

fn infer_indirect_funcs(program: &Program) -> BTreeSet<u32> {
    let mut indirect: BTreeSet<u32> = program
        .functions
        .iter()
        .filter(|f| f.is_exported)
        .map(|f| f.id.0)
        .collect();
    let mut global_funcs: BTreeMap<u32, BTreeSet<u32>> = BTreeMap::new();

    fn add_all(dst: &mut BTreeSet<u32>, src: &BTreeSet<u32>) -> bool {
        let before = dst.len();
        dst.extend(src.iter().copied());
        dst.len() != before
    }
    fn mark_escape(
        v: LocalId,
        local_funcs: &BTreeMap<u32, BTreeSet<u32>>,
        indirect: &mut BTreeSet<u32>,
    ) -> bool {
        if let Some(fs) = local_funcs.get(&v.0) {
            add_all(indirect, fs)
        } else {
            false
        }
    }
    fn scan(
        body: &[Inst],
        local_funcs: &mut BTreeMap<u32, BTreeSet<u32>>,
        global_funcs: &mut BTreeMap<u32, BTreeSet<u32>>,
        indirect: &mut BTreeSet<u32>,
    ) -> bool {
        let mut changed = false;
        for inst in body {
            match inst {
                Inst::AllocClosure { dst, func, .. } => {
                    let e = local_funcs.entry(dst.0).or_default();
                    e.insert(func.0);
                }
                Inst::AllocClassValue { dst, ctor, .. } => {
                    let e = local_funcs.entry(dst.0).or_default();
                    e.insert(ctor.0);
                }
                Inst::Copy { dst, src } => {
                    let src_set = local_funcs.get(&src.0).cloned().unwrap_or_default();
                    if !src_set.is_empty() {
                        add_all(local_funcs.entry(dst.0).or_default(), &src_set);
                    }
                }
                Inst::StoreGlobal { gref, src } => {
                    let src_set = local_funcs.get(&src.0).cloned().unwrap_or_default();
                    if !src_set.is_empty()
                        && add_all(global_funcs.entry(gref.0).or_default(), &src_set)
                    {
                        changed = true;
                    }
                }
                Inst::LoadGlobal { dst, gref } => {
                    let src_set = global_funcs.get(&gref.0).cloned().unwrap_or_default();
                    if !src_set.is_empty() {
                        add_all(local_funcs.entry(dst.0).or_default(), &src_set);
                    }
                }
                Inst::Call {
                    callee: CalleeRef::Value { local },
                    recv,
                    args,
                    ..
                } => {
                    if mark_escape(*local, local_funcs, indirect) {
                        changed = true;
                    }
                    if let Some(r) = recv {
                        if mark_escape(*r, local_funcs, indirect) {
                            changed = true;
                        }
                    }
                    for a in args {
                        if mark_escape(*a, local_funcs, indirect) {
                            changed = true;
                        }
                    }
                }
                Inst::CallSpread {
                    callee: CalleeRef::Value { local },
                    recv,
                    arg_specs,
                    ..
                } => {
                    if mark_escape(*local, local_funcs, indirect) {
                        changed = true;
                    }
                    if let Some(r) = recv {
                        if mark_escape(*r, local_funcs, indirect) {
                            changed = true;
                        }
                    }
                    for sp in arg_specs {
                        let a = match sp {
                            ArgSpec::Single { local } | ArgSpec::Spread { local } => *local,
                        };
                        if mark_escape(a, local_funcs, indirect) {
                            changed = true;
                        }
                    }
                }
                Inst::Call { recv, args, .. } => {
                    if let Some(r) = recv {
                        if mark_escape(*r, local_funcs, indirect) {
                            changed = true;
                        }
                    }
                    for a in args {
                        if mark_escape(*a, local_funcs, indirect) {
                            changed = true;
                        }
                    }
                }
                Inst::CallSpread {
                    recv, arg_specs, ..
                } => {
                    if let Some(r) = recv {
                        if mark_escape(*r, local_funcs, indirect) {
                            changed = true;
                        }
                    }
                    for sp in arg_specs {
                        let a = match sp {
                            ArgSpec::Single { local } | ArgSpec::Spread { local } => *local,
                        };
                        if mark_escape(a, local_funcs, indirect) {
                            changed = true;
                        }
                    }
                }
                Inst::Return { src: Some(s) }
                | Inst::Throw { src: s }
                | Inst::StoreElem { src: s, .. }
                | Inst::StoreField { src: s, .. }
                | Inst::StoreFieldDynamic { src: s, .. }
                | Inst::ArrayPush { src: s, .. }
                | Inst::StoreProtoMethod { src: s, .. }
                | Inst::StoreMethod { src: s, .. }
                | Inst::Print { src: s } => {
                    if mark_escape(*s, local_funcs, indirect) {
                        changed = true;
                    }
                }
                Inst::Loop {
                    cond_body, body, ..
                } => {
                    if scan(cond_body, local_funcs, global_funcs, indirect) {
                        changed = true;
                    }
                    if scan(body, local_funcs, global_funcs, indirect) {
                        changed = true;
                    }
                }
                Inst::If {
                    then_body,
                    else_body,
                    ..
                } => {
                    if scan(then_body, local_funcs, global_funcs, indirect) {
                        changed = true;
                    }
                    if scan(else_body, local_funcs, global_funcs, indirect) {
                        changed = true;
                    }
                }
                Inst::TryCatch {
                    try_body,
                    catch_body,
                    finally_body,
                    ..
                } => {
                    if scan(try_body, local_funcs, global_funcs, indirect) {
                        changed = true;
                    }
                    if scan(catch_body, local_funcs, global_funcs, indirect) {
                        changed = true;
                    }
                    if scan(finally_body, local_funcs, global_funcs, indirect) {
                        changed = true;
                    }
                }
                _ => {}
            }
        }
        changed
    }

    let mut changed = true;
    while changed {
        changed = false;
        for f in &program.functions {
            let mut local_funcs: BTreeMap<u32, BTreeSet<u32>> = BTreeMap::new();
            if scan(&f.body, &mut local_funcs, &mut global_funcs, &mut indirect) {
                changed = true;
            }
        }
    }
    indirect
}

fn infer_program_param_facts(
    program: &Program,
    indirect: &BTreeSet<u32>,
) -> BTreeMap<u32, BTreeMap<u32, NumFact>> {
    let classes: BTreeMap<u32, &ClassDef> = program.classes.iter().map(|c| (c.id.0, c)).collect();
    let mut by_func: BTreeMap<u32, BTreeMap<u32, NumFact>> = BTreeMap::new();
    for f in &program.functions {
        let mut m = BTreeMap::new();
        for p in &f.params {
            m.insert(p.0, NumFact::unknown());
        }
        by_func.insert(f.id.0, m);
    }
    let fn_params: BTreeMap<u32, Vec<u32>> = program
        .functions
        .iter()
        .map(|f| (f.id.0, f.params.iter().map(|p| p.0).collect()))
        .collect();

    for _ in 0..8 {
        let mut seen: BTreeSet<(u32, usize)> = BTreeSet::new();
        let mut next: BTreeMap<u32, BTreeMap<u32, NumFact>> = BTreeMap::new();
        for f in &program.functions {
            let mut flat = Vec::new();
            flatten_inst(&f.body, &mut flat);
            // Only resolved calls to non-indirect functions with parameters can
            // contribute a parameter fact. Avoid solving unrelated callers.
            let eligible = |target: u32| {
                !indirect.contains(&target)
                    && fn_params
                        .get(&target)
                        .is_some_and(|params| !params.is_empty())
            };
            if !flat.iter().any(|inst| match inst {
                Inst::Call {
                    callee: CalleeRef::Direct { func },
                    ..
                } => eligible(func.0),
                Inst::Call {
                    callee: CalleeRef::Set { funcs },
                    ..
                } => funcs.iter().any(|func| eligible(func.0)),
                _ => false,
            }) {
                continue;
            }
            let param_facts = by_func.get(&f.id.0).cloned().unwrap_or_default();
            let local_class = local_class_map(f);
            let unboxed = unboxed_candidates(f, &local_class);
            let empty_return_facts: BTreeMap<u32, NumFact> = BTreeMap::new();
            let analysis =
                infer_numeric_analysis(&f.body, &unboxed, &param_facts, &empty_return_facts, &int32_field_loads(&f.body, &classes));
            for inst in flat {
                match inst {
                    Inst::Call {
                        callee, recv, args, ..
                    } => {
                        let mut argv: Vec<u32> = Vec::new();
                        if let Some(r) = recv {
                            argv.push(r.0);
                        }
                        argv.extend(args.iter().map(|a| a.0));
                        let targets: Vec<u32> = match callee {
                            CalleeRef::Direct { func } => vec![func.0],
                            CalleeRef::Set { funcs } => funcs.iter().map(|f| f.0).collect(),
                            _ => Vec::new(),
                        };
                        for target in targets {
                            if indirect.contains(&target) {
                                continue;
                            }
                            if let Some(params) = fn_params.get(&target) {
                                for (idx, p) in params.iter().enumerate() {
                                    let fact = argv
                                        .get(idx)
                                        .and_then(|a| analysis.facts.get(a))
                                        .cloned()
                                        .unwrap_or_else(NumFact::unknown);
                                    seen.insert((target, idx));
                                    let dst = next.entry(target).or_default();
                                    let merged = if let Some(old) = dst.get(p) {
                                        old.join(&fact)
                                    } else {
                                        fact
                                    };
                                    dst.insert(*p, merged);
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        for f in &program.functions {
            let entry = next.entry(f.id.0).or_default();
            for (idx, p) in f.params.iter().enumerate() {
                if indirect.contains(&f.id.0) || !seen.contains(&(f.id.0, idx)) {
                    entry.insert(p.0, NumFact::unknown());
                }
            }
        }
        if next == by_func {
            break;
        }
        by_func = next;
    }
    by_func
}

fn i64_return_facts(i64_fast: &BTreeMap<u32, I64FuncInfo>) -> BTreeMap<u32, NumFact> {
    i64_fast
        .iter()
        .map(|(id, info)| (*id, info.ret_fact.clone()))
        .collect()
}

fn numeric_fast_targets(
    i64_fast: &BTreeMap<u32, I64FuncInfo>,
    f64_fast: &BTreeMap<u32, F64FuncInfo>,
) -> BTreeSet<u32> {
    let mut out: BTreeSet<u32> = i64_fast.keys().copied().collect();
    out.extend(f64_fast.keys().copied());
    out
}

fn type_is_number(program: &Program, tid: TypeId) -> bool {
    if program.types.is_empty() {
        return true;
    }
    program
        .types
        .iter()
        .find(|t| t.id.0 == tid.0)
        .map(|t| {
            matches!(
                &t.shape,
                TypeShape::Primitive {
                    prim: PrimitiveKind::Number
                }
            )
        })
        .unwrap_or(false)
}

fn local_is_number(program: &Program, f: &Function, id: u32) -> bool {
    f.locals
        .iter()
        .find(|l| l.id.0 == id)
        .map(|l| {
            if program.types.is_empty() {
                matches!(l.ref_kind, RefKind::Primitive)
            } else {
                type_is_number(program, l.type_id)
            }
        })
        .unwrap_or(false)
}

fn i64_body_supported(body: &[Inst]) -> bool {
    for inst in body {
        let ok = match inst {
            Inst::Const { .. }
            | Inst::Copy { .. }
            | Inst::BinOp { .. }
            | Inst::UnOp { .. }
            | Inst::Return { .. }
            | Inst::Break { .. }
            | Inst::Continue { .. } => true,
            Inst::Call {
                callee: CalleeRef::Direct { .. },
                ..
            } => true,
            Inst::Loop {
                cond_body, body, ..
            } => i64_body_supported(cond_body) && i64_body_supported(body),
            Inst::If {
                then_body,
                else_body,
                ..
            } => i64_body_supported(then_body) && i64_body_supported(else_body),
            _ => false,
        };
        if !ok {
            return false;
        }
    }
    true
}

fn join_fact_slot(slot: &mut Option<NumFact>, fact: NumFact) {
    *slot = Some(if let Some(old) = slot.take() {
        old.join(&fact)
    } else {
        fact
    });
}

fn collect_return_fact(body: &[Inst], analysis: &NumericAnalysis) -> Option<NumFact> {
    fn walk(body: &[Inst], analysis: &NumericAnalysis, out: &mut Option<NumFact>) {
        for inst in body {
            match inst {
                Inst::Return { src: Some(v) } => {
                    join_fact_slot(
                        out,
                        analysis
                            .facts
                            .get(&v.0)
                            .cloned()
                            .unwrap_or_else(NumFact::unknown),
                    );
                }
                Inst::Return { src: None } => join_fact_slot(out, NumFact::unknown()),
                Inst::Loop {
                    cond_body, body, ..
                } => {
                    walk(cond_body, analysis, out);
                    walk(body, analysis, out);
                }
                Inst::If {
                    then_body,
                    else_body,
                    ..
                } => {
                    walk(then_body, analysis, out);
                    walk(else_body, analysis, out);
                }
                Inst::TryCatch {
                    try_body,
                    catch_body,
                    finally_body,
                    ..
                } => {
                    walk(try_body, analysis, out);
                    walk(catch_body, analysis, out);
                    walk(finally_body, analysis, out);
                }
                _ => {}
            }
        }
    }
    let mut out = None;
    walk(body, analysis, &mut out);
    out
}

/// Locals whose value is always a number: the params plus every local all of
/// whose definitions produce a number. This is a must-analysis (an optimistic
/// greatest fixpoint): a local starts numeric and is dropped as soon as one of
/// its definitions is not numeric under the current assumption. The previous
/// any-definition rule let `c ? true : g(n)` classify the merge local as
/// numeric, so a boolean-returning function got an f64 clone that reinterpreted
/// `true` as NaN.
fn numeric_value_locs(
    body: &[Inst],
    params: &[u32],
    numeric_call_targets: &BTreeSet<u32>,
) -> BTreeSet<u32> {
    let mut flat = Vec::new();
    flatten_inst(body, &mut flat);
    let mut numeric: BTreeSet<u32> = params.iter().copied().collect();
    for inst in &flat {
        if let Some(id) = inst_def(inst) {
            numeric.insert(id);
        }
    }
    let mut changed = true;
    while changed {
        changed = false;
        for inst in &flat {
            let def = match inst {
                Inst::Const {
                    dst,
                    value: ConstVal::Num { .. },
                } => Some((dst.0, true)),
                Inst::Const { dst, .. } => Some((dst.0, false)),
                Inst::Copy { dst, src } => Some((dst.0, numeric.contains(&src.0))),
                Inst::UnOp { dst, op, operand } => {
                    let is_num =
                        matches!(op.as_str(), "+" | "-" | "~") && numeric.contains(&operand.0);
                    Some((dst.0, is_num))
                }
                Inst::BinOp { dst, op, lhs, rhs } => {
                    let is_num = matches!(
                        op.as_str(),
                        "+" | "-" | "*" | "/" | "%" | "**" | "&" | "|" | "^" | "<<" | ">>" | ">>>"
                    ) && numeric.contains(&lhs.0)
                        && numeric.contains(&rhs.0);
                    Some((dst.0, is_num))
                }
                Inst::Call {
                    dst: Some(dst),
                    callee: CalleeRef::Direct { func },
                    ..
                } => Some((dst.0, numeric_call_targets.contains(&func.0))),
                Inst::CallBuiltin {
                    dst: Some(dst),
                    builtin,
                    ..
                } => Some((
                    dst.0,
                    matches!(
                        builtin.as_str(),
                        "string.charCodeAt" | "string.indexOf" | "string.lastIndexOf"
                    ),
                )),
                Inst::CallBuiltinStatic {
                    dst: Some(dst),
                    builtin,
                    ..
                } => Some((
                    dst.0,
                    matches!(builtin.as_str(), "json.num.len" | "json.string.len"),
                )),
                Inst::Call { dst: Some(dst), .. }
                | Inst::CallSpread { dst: Some(dst), .. }
                | Inst::Yield { dst: Some(dst), .. }
                | Inst::Await { dst: Some(dst), .. }
                | Inst::SetProto { dst: Some(dst), .. }
                | Inst::LoadField { dst, .. }
                | Inst::LoadElem { dst, .. }
                | Inst::LoadGlobal { dst, .. }
                | Inst::LoadIndex { dst, .. } => Some((dst.0, false)),
                Inst::ArrayLen { dst, .. }
                | Inst::StringLen { dst, .. }
                | Inst::GenericLen { dst, .. } => Some((dst.0, true)),
                Inst::HasField { dst, .. }
                | Inst::HasFieldDynamic { dst, .. }
                | Inst::LoadFieldDynamic { dst, .. }
                | Inst::DeleteField { dst: Some(dst), .. }
                | Inst::ArraySlice { dst, .. }
                | Inst::ObjectRest { dst, .. }
                | Inst::ObjectCopyProps { dst, .. }
                | Inst::ConstructResult { dst, .. }
                | Inst::LoadClassProto { dst, .. }
                | Inst::GetProto { dst, .. }
                | Inst::NewMap { dst }
                | Inst::NewSet { dst } => Some((dst.0, false)),
                // every other defining instruction yields a non-number
                other => inst_def(other).map(|d| (d, false)),
            };
            if let Some((id, false)) = def {
                if numeric.remove(&id) {
                    changed = true;
                }
            }
        }
    }
    numeric
}

/// Tiny leaf direct entries (docs/tiny_leaf_inline_design.md): a function of
/// at most twenty straight-line or `if` instructions that calls nothing and
/// allocates nothing (`getObjectFlags`, `isFreshLiteralType`, `getNodeId`, the
/// checker's accessors) can be emitted `always_inline`, so every direct call
/// site absorbs it; the generic entry keeps a real function. The compiler ran
/// 1.5% slower with it (3,089 functions, +2.2 MB of text), so the rule is OFF
/// unless TSAOT_TINY_INLINE=1 (Session 350); the parity oracle passes =0.
fn tiny_inline_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| matches!(std::env::var("TSAOT_TINY_INLINE").as_deref(), Ok("1")))
}
/// TSAOT_INLINE_HINT=1: a tiny leaf's direct entry is declared `static inline`,
/// a hint that raises clang's inlining budget for it while its cost model
/// still decides per site (the always-inline rule, `TSAOT_TINY_INLINE`, grew
/// the code 4% and cost 1.5% in Session 350; docs/tiny_leaf_inline_design.md).
fn inline_hint_enabled() -> bool {
    inline_hint_level() > 0
}
/// TSAOT_INLINE_HINT: 0 (default) no hint; 1 tiny leaves (`tiny_leaf_body`);
/// 2 also small bodies with calls (at most forty instructions, no loop, no
/// `try`, not a coroutine): the checker's accessors with one call inside.
fn inline_hint_level() -> u32 {
    static LEVEL: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    *LEVEL.get_or_init(|| match std::env::var("TSAOT_INLINE_HINT").as_deref() {
        Ok("1") => 1,
        Ok("2") => 2,
        _ => 0,
    })
}
/// A body of at most forty instructions in all, with calls but no loop, `try`
/// or coroutine: a candidate for the inline hint at level 2.
fn small_body_with_calls(f: &Function) -> bool {
    if f.is_async || f.is_generator {
        return false;
    }
    let mut flat: Vec<&Inst> = Vec::new();
    flatten_inst(&f.body, &mut flat);
    if flat.len() > 40 {
        return false;
    }
    !flat.iter().any(|i| matches!(i, Inst::Loop { .. } | Inst::TryCatch { .. }))
}
/// The body qualifies for the inline hint at the configured level.
fn hint_body(f: &Function) -> bool {
    match inline_hint_level() {
        0 => false,
        1 => tiny_leaf_body(f),
        _ => tiny_leaf_body(f) || small_body_with_calls(f),
    }
}
/// The storage class of a direct entry: forced inline for a tiny leaf under
/// `TSAOT_TINY_INLINE`, the inline hint under `TSAOT_INLINE_HINT`, else static.
fn direct_entry_storage(f: &Function) -> &'static str {
    if tiny_leaf_direct(f) {
        "TS_AOT_INLINE"
    } else if hint_body(f) {
        "TS_AOT_HINT"
    } else {
        "static"
    }
}
fn tiny_leaf_direct(f: &Function) -> bool {
    tiny_inline_enabled() && tiny_leaf_body(f)
}
/// A body of at most twenty constants, copies, arithmetic, field and index
/// reads and writes, `if`s and returns: no call, allocation, loop or `try`.
fn tiny_leaf_body(f: &Function) -> bool {
    if f.is_async || f.is_generator {
        return false;
    }
    fn walk(body: &[Inst], n: &mut usize) -> bool {
        for inst in body {
            *n += 1;
            if *n > 20 {
                return false;
            }
            match inst {
                Inst::Const { .. }
                | Inst::Copy { .. }
                | Inst::BinOp { .. }
                | Inst::UnOp { .. }
                | Inst::LoadField { .. }
                | Inst::StoreField { .. }
                | Inst::LoadIndex { .. }
                | Inst::GenericLen { .. }
                | Inst::Return { .. } => {}
                Inst::If { then_body, else_body, .. } => {
                    if !walk(then_body, n) || !walk(else_body, n) {
                        return false;
                    }
                }
                _ => return false,
            }
        }
        true
    }
    let mut n = 0;
    walk(&f.body, &mut n)
}

fn force_inline_numeric_func(f: &Function) -> bool {
    if f.is_async || f.is_generator || f.body.len() > 8 {
        return false;
    }
    f.body.iter().all(|inst| {
        matches!(
            inst,
            Inst::Const { .. }
                | Inst::Copy { .. }
                | Inst::BinOp { .. }
                | Inst::UnOp { .. }
                | Inst::LoadField { .. }
                | Inst::StoreField { .. }
                | Inst::Return { .. }
        )
    })
}

fn returns_numeric_values(
    body: &[Inst],
    params: &[u32],
    numeric_call_targets: &BTreeSet<u32>,
) -> bool {
    let numeric = numeric_value_locs(body, params, numeric_call_targets);
    fn check(body: &[Inst], numeric: &BTreeSet<u32>) -> bool {
        for inst in body {
            let ok = match inst {
                Inst::Return { src: Some(v) } => numeric.contains(&v.0),
                Inst::Return { src: None } => false,
                Inst::Loop {
                    cond_body, body, ..
                } => check(cond_body, numeric) && check(body, numeric),
                Inst::If {
                    then_body,
                    else_body,
                    ..
                } => check(then_body, numeric) && check(else_body, numeric),
                Inst::TryCatch {
                    try_body,
                    catch_body,
                    finally_body,
                    ..
                } => {
                    check(try_body, numeric)
                        && check(catch_body, numeric)
                        && check(finally_body, numeric)
                }
                _ => true,
            };
            if !ok {
                return false;
            }
        }
        true
    }
    check(body, &numeric)
}

fn direct_call_args_i64_safe(argv: &[u32], analysis: &NumericAnalysis) -> bool {
    argv.iter()
        .all(|a| analysis.facts.get(a).map(|f| f.i64_safe).unwrap_or(false))
}

fn validate_i64_direct_calls(
    body: &[Inst],
    analysis: &NumericAnalysis,
    candidates: &BTreeSet<u32>,
) -> bool {
    for inst in body {
        let ok = match inst {
            Inst::Call {
                callee: CalleeRef::Direct { func },
                recv,
                args,
                ..
            } if candidates.contains(&func.0) => {
                let mut argv = Vec::new();
                if let Some(r) = recv {
                    argv.push(r.0);
                }
                argv.extend(args.iter().map(|a| a.0));
                direct_call_args_i64_safe(&argv, analysis)
            }
            Inst::Loop {
                cond_body, body, ..
            } => {
                validate_i64_direct_calls(cond_body, analysis, candidates)
                    && validate_i64_direct_calls(body, analysis, candidates)
            }
            Inst::If {
                then_body,
                else_body,
                ..
            } => {
                validate_i64_direct_calls(then_body, analysis, candidates)
                    && validate_i64_direct_calls(else_body, analysis, candidates)
            }
            _ => true,
        };
        if !ok {
            return false;
        }
    }
    true
}

fn collect_i64_seed_param_facts(
    program: &Program,
    candidates: &BTreeSet<u32>,
    base_param_facts: &BTreeMap<u32, BTreeMap<u32, NumFact>>,
    return_facts: &BTreeMap<u32, NumFact>,
) -> BTreeMap<u32, BTreeMap<u32, NumFact>> {
    let classes: BTreeMap<u32, &ClassDef> = program.classes.iter().map(|c| (c.id.0, c)).collect();
    let fn_params: BTreeMap<u32, Vec<u32>> = program
        .functions
        .iter()
        .map(|f| (f.id.0, f.params.iter().map(|p| p.0).collect()))
        .collect();
    let mut out: BTreeMap<u32, BTreeMap<u32, NumFact>> = BTreeMap::new();
    for caller in &program.functions {
        let mut flat = Vec::new();
        flatten_inst(&caller.body, &mut flat);
        // This pass only consumes arguments at direct calls to candidates.
        if !flat.iter().any(|inst| {
            matches!(inst,
                Inst::Call { callee: CalleeRef::Direct { func }, .. }
                    if candidates.contains(&func.0))
        }) {
            continue;
        }
        let local_class = local_class_map(caller);
        let unboxed = unboxed_candidates(caller, &local_class);
        let empty = BTreeMap::new();
        let param_facts = base_param_facts.get(&caller.id.0).unwrap_or(&empty);
        let analysis = infer_numeric_analysis(&caller.body, &unboxed, param_facts, return_facts, &int32_field_loads(&caller.body, &classes));
        let caller_numeric_params: Vec<u32> = caller
            .params
            .iter()
            .map(|p| p.0)
            .filter(|p| local_is_number(program, caller, *p))
            .collect();
        let numeric_values = numeric_value_locs(&caller.body, &caller_numeric_params, candidates);
        for inst in flat {
            if let Inst::Call {
                callee: CalleeRef::Direct { func },
                recv,
                args,
                ..
            } = inst
            {
                if !candidates.contains(&func.0) {
                    continue;
                }
                let mut argv = Vec::new();
                if let Some(r) = recv {
                    argv.push(r.0);
                }
                argv.extend(args.iter().map(|a| a.0));
                let dst = out.entry(func.0).or_default();
                if let Some(params) = fn_params.get(&func.0) {
                    for (idx, p) in params.iter().enumerate() {
                        if let Some(arg) = argv.get(idx) {
                            if !numeric_values.contains(arg) {
                                continue;
                            }
                            if let Some(fact) =
                                analysis.facts.get(arg).cloned().filter(|f| f.i64_safe)
                            {
                                let merged = if let Some(old) = dst.get(p) {
                                    old.join(&fact)
                                } else {
                                    fact
                                };
                                dst.insert(*p, merged);
                            }
                        }
                    }
                }
            }
        }
    }
    out
}

fn infer_i64_fast_funcs(
    program: &Program,
    indirect: &BTreeSet<u32>,
    base_param_facts: &BTreeMap<u32, BTreeMap<u32, NumFact>>,
) -> BTreeMap<u32, I64FuncInfo> {
    let classes: BTreeMap<u32, &ClassDef> = program.classes.iter().map(|c| (c.id.0, c)).collect();
    let mut candidates: BTreeSet<u32> = program
        .functions
        .iter()
        .filter(|f| {
            !indirect.contains(&f.id.0)
                && !f.is_async
                && !f.is_generator
                && !f.takes_this
                && f.rest_param.is_none()
                && !body_has_json_dom(&f.body)
                && type_is_number(program, f.ret)
                && f.params.iter().all(|p| local_is_number(program, f, p.0))
                && i64_body_supported(&f.body)
        })
        .map(|f| f.id.0)
        .collect();
    let mut last_infos = BTreeMap::new();
    for _ in 0..8 {
        let mut ret_assumptions: BTreeMap<u32, NumFact> = candidates
            .iter()
            .map(|id| (*id, NumFact::i64_value()))
            .collect();
        let mut next_infos = BTreeMap::new();
        for _ in 0..8 {
            let seeds = collect_i64_seed_param_facts(
                program,
                &candidates,
                base_param_facts,
                &ret_assumptions,
            );
            let mut refined_returns = ret_assumptions.clone();
            let mut iter_infos = BTreeMap::new();
            for f in &program.functions {
                if !candidates.contains(&f.id.0) {
                    continue;
                }
                let params: Vec<u32> = f.params.iter().map(|p| p.0).collect();
                let Some(seed) = seeds.get(&f.id.0) else {
                    continue;
                };
                if params
                    .iter()
                    .any(|p| !seed.get(p).map(|nf| nf.i64_safe).unwrap_or(false))
                {
                    continue;
                }
                let local_class = local_class_map(f);
                let unboxed = unboxed_candidates(f, &local_class);
                if params.iter().any(|p| !unboxed.contains(p)) {
                    continue;
                }
                let analysis = infer_numeric_analysis(&f.body, &unboxed, seed, &ret_assumptions, &int32_field_loads(&f.body, &classes));
                if !validate_i64_direct_calls(&f.body, &analysis, &candidates) {
                    continue;
                }
                if !returns_numeric_values(&f.body, &params, &candidates) {
                    continue;
                }
                let ret_fact =
                    collect_return_fact(&f.body, &analysis).unwrap_or_else(NumFact::unknown);
                if !ret_fact.i64_safe {
                    continue;
                }
                refined_returns.insert(f.id.0, ret_fact.clone());
                iter_infos.insert(
                    f.id.0,
                    I64FuncInfo {
                        params,
                        param_facts: seed.clone(),
                        ret_fact,
                    },
                );
            }
            next_infos = iter_infos;
            if refined_returns == ret_assumptions {
                break;
            }
            ret_assumptions = refined_returns;
        }
        let next_candidates: BTreeSet<u32> = next_infos.keys().copied().collect();
        if next_candidates == candidates {
            return next_infos;
        }
        candidates = next_candidates;
        last_infos = next_infos;
        if candidates.is_empty() {
            break;
        }
    }
    last_infos
}

fn infer_f64_fast_funcs(
    program: &Program,
    indirect: &BTreeSet<u32>,
    i64_fast: &BTreeMap<u32, I64FuncInfo>,
) -> BTreeMap<u32, F64FuncInfo> {
    let mut candidates: BTreeSet<u32> = program
        .functions
        .iter()
        .filter(|f| {
            !indirect.contains(&f.id.0)
                && !f.is_async
                && !f.is_generator
                && !f.takes_this
                && f.rest_param.is_none()
                && !body_has_json_dom(&f.body)
                && type_is_number(program, f.ret)
                && f.params.iter().all(|p| local_is_number(program, f, p.0))
                && i64_body_supported(&f.body)
        })
        .map(|f| f.id.0)
        .collect();
    let mut last_infos = BTreeMap::new();
    for _ in 0..8 {
        let mut numeric_targets: BTreeSet<u32> = i64_fast.keys().copied().collect();
        numeric_targets.extend(candidates.iter().copied());
        let mut next_infos = BTreeMap::new();
        for f in &program.functions {
            if !candidates.contains(&f.id.0) {
                continue;
            }
            let params: Vec<u32> = f.params.iter().map(|p| p.0).collect();
            let local_class = local_class_map(f);
            let unboxed = unboxed_candidates(f, &local_class);
            if params.iter().any(|p| !unboxed.contains(p)) {
                continue;
            }
            if !returns_numeric_values(&f.body, &params, &numeric_targets) {
                continue;
            }
            next_infos.insert(f.id.0, F64FuncInfo { params });
        }
        let next_candidates: BTreeSet<u32> = next_infos.keys().copied().collect();
        if next_candidates == candidates {
            return next_infos;
        }
        candidates = next_candidates;
        last_infos = next_infos;
        if candidates.is_empty() {
            break;
        }
    }
    last_infos
}

fn emit_i64_function(
    s: &mut String,
    f: &Function,
    info: &I64FuncInfo,
    strat: &BTreeMap<u32, AllocStrategy>,
    classes: &BTreeMap<u32, &ClassDef>,
    fclass: &BTreeMap<u32, u32>,
    fn_names: &BTreeMap<u32, String>,
    wksym: &BTreeMap<u32, u32>,
    fn_takes_this: &BTreeMap<u32, bool>,
    i64_fast: &BTreeMap<u32, I64FuncInfo>,
    f64_fast: &BTreeMap<u32, F64FuncInfo>,
    direct_sigs: &BTreeMap<u32, DirectSig>,
    known_methods: &BTreeMap<u32, u32>,
    static_strings: &BTreeMap<Vec<u16>, usize>,
    string_metric_plan: Option<&FunctionMetricPlan>,
    string_materialization_plan: Option<&FunctionMaterializationPlan>,
    typed_keys: Option<&TypedKeyLocals>,
) {
    let mut local_class = local_class_map(f);
    if let Some(&c) = fclass.get(&f.id.0) {
        if let Some(p0) = f.params.first() {
            local_class.insert(p0.0, c);
        }
    }
    let unboxed = unboxed_candidates(f, &local_class);
    let return_facts = i64_return_facts(i64_fast);
    let numeric = infer_numeric_analysis(&f.body, &unboxed, &info.param_facts, &return_facts, &int32_field_loads(&f.body, classes));
    let mut int_local = numeric.int_local;
    for p in &info.params {
        int_local.insert(*p);
    }
    let nonzero_int_const = numeric.nonzero_int_const;
    let nonzero_int = numeric.nonzero_int;
    let int_const = numeric.int_const;
    let nonnegative_int = numeric.nonnegative_int;
    let numeric_targets = numeric_fast_targets(i64_fast, f64_fast);
    let numeric_value_local = numeric_value_locs(&f.body, &info.params, &numeric_targets);
    let params = if info.params.is_empty() {
        "void".to_string()
    } else {
        info.params
            .iter()
            .enumerate()
            .map(|(i, _)| format!("long long _p{}", i))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let storage = if force_inline_numeric_func(f) {
        "TS_AOT_INLINE"
    } else if hint_body(f) {
        "TS_AOT_HINT"
    } else {
        "static"
    };
    let mut reflike: Vec<u32> = f
        .locals
        .iter()
        .filter(|l| !matches!(l.ref_kind, RefKind::Primitive) && !unboxed.contains(&l.id.0))
        .map(|l| l.id.0)
        .collect();
    let typeof_fusion = typeof_fusion_plan(f);
    {
        let numeric_all: BTreeSet<u32> = unboxed.union(&int_local).copied().collect();
        let would_be_lazy = lazy_frames_enabled()
            && prop_pic_enabled()
            && f.rest_param.is_none()
            && body_is_gc_free(&f.body, &numeric_all);
        if frame_roots_enabled() && !would_be_lazy {
            let string_plans = string_metric_plan.is_some_and(|p| !p.loops.is_empty())
                || string_materialization_plan.is_some_and(|p| !p.loops.is_empty());
            let _ = elide_frame_locals(f, &mut reflike, &numeric_all, &typeof_fusion, direct_sigs, string_plans, false);
        }
    }
    let use_frame_roots = frame_roots_enabled() && !reflike.is_empty()
        && (!conservative_roots_enabled() || body_has_try(&f.body) || body_has_stack_cells(&f.body, strat));
    if use_frame_roots {
        reflike.sort_unstable();
    }
    let frame_locals: BTreeSet<u32> = if use_frame_roots {
        reflike.iter().copied().collect()
    } else {
        BTreeSet::new()
    };
    let frame_layout = if use_frame_roots && frame_coalesce_enabled() {
        Some(compute_frame_layout(f, &reflike, &typeof_fusion))
    } else {
        None
    };
    let _ = writeln!(s, "{} long long {}({}){{", storage, i64_cname(f), params);
    s.push_str(&method_this_check(f, &format!("_p{}", f.capture_count)));
    let int32_use_decl = if int32_codegen_enabled() {
        int32_use_locals(f, &unboxed, &int_local)
    } else {
        BTreeSet::new()
    };
    for l in &f.locals {
        if int_local.contains(&l.id.0) || int32_use_decl.contains(&l.id.0) {
            let _ = writeln!(s, "  long long d{} = 0;", l.id.0);
        } else if unboxed.contains(&l.id.0) {
            let _ = writeln!(s, "  double d{} = 0;", l.id.0);
        } else if !frame_locals.contains(&l.id.0) {
            let _ = writeln!(s, "  tsv v{} = TS_UNDEFINED;", l.id.0);
        }
    }
    let lazy_frame = use_frame_roots
        && lazy_frames_enabled()
        && prop_pic_enabled()
        && f.rest_param.is_none()
        // numeric clones carry no JSON roots
        && body_is_gc_free(&f.body, &unboxed.union(&int_local).copied().collect());
    let lazy_homes = lazy_frame && lazy_homes_enabled();
    let accums = if string_accum_enabled() {
        crate::string_accum::string_accumulators(f)
    } else {
        Default::default()
    };
    let (lazy_spill, lazy_reload) = if lazy_homes {
        lazy_spill_reload(&reflike, frame_layout.as_ref())
    } else {
        (String::new(), String::new())
    };
    emit_stack_cell_decls(s, &f.body, strat);
    let fin_slots = if use_frame_roots && !lazy_frame && finally_slots_enabled() {
        finally_value_slots(&f.body)
    } else {
        0
    };
    if use_frame_roots {
        emit_frame_decl_homes(s, &reflike, frame_layout.as_ref(), lazy_homes, fin_slots);
    }
    for (i, p) in info.params.iter().enumerate() {
        let _ = writeln!(s, "  d{} = _p{};", p, i);
    }
    let frame_nslots: usize = if use_frame_roots {
        frame_slot_count(&reflike, frame_layout.as_ref())
    } else {
        0
    };
    if use_frame_roots && !lazy_frame {
        let _ = writeln!(s, "  ts_frame_push(&F.h, {});", frame_slot_count(&reflike, frame_layout.as_ref()) + fin_slots as usize);
    } else if use_frame_roots {
        // lazy: the frame is linked only around slow paths (with register
        // homes it is also filled only there)
    } else if !conservative_roots_enabled() {
        for id in &reflike {
            let _ = writeln!(s, "  ts_gc_root(&v{});", id);
        }
    }
    let nroot = if use_frame_roots || conservative_roots_enabled() { 0 } else { reflike.len() };
    let scalar_slices: BTreeMap<u32, ScalarStringSlice> = BTreeMap::new();
    let json_locals: BTreeSet<u32> = BTreeSet::new();
    let json_roots: BTreeSet<u32> = BTreeSet::new();
    let ctx = Ctx {
        switch_plan: switch_plan_for(f, &unboxed, &int_local, static_strings),
        layouts: layout_plan_for(f),
        lazy_frame,
        lazy_homes,
        lazy_spill: lazy_spill.clone(),
        lazy_reload: lazy_reload.clone(),
        point_spills: BTreeMap::new(),
        cur_inst: std::cell::Cell::new(0),
        accums: accums.clone(),
        frame_nslots,
        int32_use: int32_use_locals(f, &unboxed, &int_local),
        unboxed,
        int_local,
        local_class,
        classes,
        strat,
        fn_names,
        wksym,
        fn_takes_this,
        cur_capture_count: own_capture_count(f),
        i64_fast,
        f64_fast,
        direct_sigs,
        known_methods,
        typeof_fusion,
        tag_consts: tag_consts_for(f),
        str_consts: str_consts_for(f, static_strings),
        static_strings,
        string_metric_plan,
        string_materialization_plan,
        scalar_slices: &scalar_slices,
        dom_ref_total: dom_ref_count(&f.body, &json_locals),
        json_locals,
        json_roots,
        emit_path: std::cell::RefCell::new(Vec::new()),
        numeric_value_local,
        i64_mode: true,
        ret_kind: RetKind::Boxed,
        stack_cells: true,
        prim_kind: prim_kind_locals(f),
        str_typed: typed_keys.map(|t| t.str_typed.clone()).unwrap_or_default(),
        ref_typed: typed_keys.map(|t| t.ref_typed.clone()).unwrap_or_default(),
        f64_mode: false,
        frame_locals,
        frame_slot: frame_layout.as_ref().map(|l| l.slot_of.clone()),
        nroot,
        nonzero_int_const,
        nonzero_int,
        int_const,
        nonnegative_int,
        label_ctr: std::cell::Cell::new(900000),
        loop_labels: std::cell::RefCell::new(Vec::new()),
        ta_hoisted: std::cell::RefCell::new(BTreeMap::new()),
        sv_hoisted: std::cell::RefCell::new(BTreeMap::new()),
        loop_mod_residues: std::cell::RefCell::new(Vec::new()),
        fin_stack: std::cell::RefCell::new(Vec::new()),
        fin_value_slots: fin_slots > 0,
        pendv_depth: std::cell::Cell::new(0),
        eh_depth: std::cell::Cell::new(0),
    };
    emit_seq(s, &f.body, &ctx, PathEdge::Function);
    emit_json_cleanup(s, &ctx);
    let cleanup = ctx.root_cleanup();
    if !cleanup.is_empty() {
        let _ = writeln!(s, "  {}", cleanup);
    }
    s.push_str("  return 0;\n}\n\n");
}

fn emit_f64_function(
    s: &mut String,
    f: &Function,
    info: &F64FuncInfo,
    strat: &BTreeMap<u32, AllocStrategy>,
    classes: &BTreeMap<u32, &ClassDef>,
    fclass: &BTreeMap<u32, u32>,
    fn_names: &BTreeMap<u32, String>,
    wksym: &BTreeMap<u32, u32>,
    fn_takes_this: &BTreeMap<u32, bool>,
    i64_fast: &BTreeMap<u32, I64FuncInfo>,
    f64_fast: &BTreeMap<u32, F64FuncInfo>,
    direct_sigs: &BTreeMap<u32, DirectSig>,
    known_methods: &BTreeMap<u32, u32>,
    static_strings: &BTreeMap<Vec<u16>, usize>,
    string_metric_plan: Option<&FunctionMetricPlan>,
    string_materialization_plan: Option<&FunctionMaterializationPlan>,
    typed_keys: Option<&TypedKeyLocals>,
) {
    let mut local_class = local_class_map(f);
    if let Some(&c) = fclass.get(&f.id.0) {
        if let Some(p0) = f.params.first() {
            local_class.insert(p0.0, c);
        }
    }
    let unboxed = unboxed_candidates(f, &local_class);
    let return_facts = i64_return_facts(i64_fast);
    let empty_param_facts: BTreeMap<u32, NumFact> = BTreeMap::new();
    let numeric = infer_numeric_analysis(&f.body, &unboxed, &empty_param_facts, &return_facts, &int32_field_loads(&f.body, classes));
    let mut int_local = numeric.int_local;
    for p in &info.params {
        int_local.remove(p);
    }
    let nonzero_int_const = numeric.nonzero_int_const;
    let nonzero_int = numeric.nonzero_int;
    let int_const = numeric.int_const;
    let nonnegative_int = numeric.nonnegative_int;
    let numeric_targets = numeric_fast_targets(i64_fast, f64_fast);
    let numeric_value_local = numeric_value_locs(&f.body, &info.params, &numeric_targets);
    let params = if info.params.is_empty() {
        "void".to_string()
    } else {
        info.params
            .iter()
            .enumerate()
            .map(|(i, _)| format!("double _p{}", i))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let storage = if force_inline_numeric_func(f) {
        "TS_AOT_INLINE"
    } else if hint_body(f) {
        "TS_AOT_HINT"
    } else {
        "static"
    };
    let mut reflike: Vec<u32> = f
        .locals
        .iter()
        .filter(|l| !matches!(l.ref_kind, RefKind::Primitive) && !unboxed.contains(&l.id.0))
        .map(|l| l.id.0)
        .collect();
    let typeof_fusion = typeof_fusion_plan(f);
    {
        let numeric_all: BTreeSet<u32> = unboxed.union(&int_local).copied().collect();
        let would_be_lazy = lazy_frames_enabled()
            && prop_pic_enabled()
            && f.rest_param.is_none()
            && body_is_gc_free(&f.body, &numeric_all);
        if frame_roots_enabled() && !would_be_lazy {
            let string_plans = string_metric_plan.is_some_and(|p| !p.loops.is_empty())
                || string_materialization_plan.is_some_and(|p| !p.loops.is_empty());
            let _ = elide_frame_locals(f, &mut reflike, &numeric_all, &typeof_fusion, direct_sigs, string_plans, false);
        }
    }
    let use_frame_roots = frame_roots_enabled() && !reflike.is_empty()
        && (!conservative_roots_enabled() || body_has_try(&f.body) || body_has_stack_cells(&f.body, strat));
    if use_frame_roots {
        reflike.sort_unstable();
    }
    let frame_locals: BTreeSet<u32> = if use_frame_roots {
        reflike.iter().copied().collect()
    } else {
        BTreeSet::new()
    };
    let frame_layout = if use_frame_roots && frame_coalesce_enabled() {
        Some(compute_frame_layout(f, &reflike, &typeof_fusion))
    } else {
        None
    };
    let _ = writeln!(s, "{} double {}({}){{", storage, f64_cname(f), params);
    s.push_str(&method_this_check(f, &format!("_p{}", f.capture_count)));
    let int32_use_decl = if int32_codegen_enabled() {
        int32_use_locals(f, &unboxed, &int_local)
    } else {
        BTreeSet::new()
    };
    for l in &f.locals {
        if int_local.contains(&l.id.0) || int32_use_decl.contains(&l.id.0) {
            let _ = writeln!(s, "  long long d{} = 0;", l.id.0);
        } else if unboxed.contains(&l.id.0) {
            let _ = writeln!(s, "  double d{} = 0;", l.id.0);
        } else if !frame_locals.contains(&l.id.0) {
            let _ = writeln!(s, "  tsv v{} = TS_UNDEFINED;", l.id.0);
        }
    }
    let lazy_frame = use_frame_roots
        && lazy_frames_enabled()
        && prop_pic_enabled()
        && f.rest_param.is_none()
        // numeric clones carry no JSON roots
        && body_is_gc_free(&f.body, &unboxed.union(&int_local).copied().collect());
    let lazy_homes = lazy_frame && lazy_homes_enabled();
    let accums = if string_accum_enabled() {
        crate::string_accum::string_accumulators(f)
    } else {
        Default::default()
    };
    let (lazy_spill, lazy_reload) = if lazy_homes {
        lazy_spill_reload(&reflike, frame_layout.as_ref())
    } else {
        (String::new(), String::new())
    };
    emit_stack_cell_decls(s, &f.body, strat);
    let fin_slots = if use_frame_roots && !lazy_frame && finally_slots_enabled() {
        finally_value_slots(&f.body)
    } else {
        0
    };
    if use_frame_roots {
        emit_frame_decl_homes(s, &reflike, frame_layout.as_ref(), lazy_homes, fin_slots);
    }
    for (i, p) in info.params.iter().enumerate() {
        let _ = writeln!(s, "  d{} = _p{};", p, i);
    }
    let frame_nslots: usize = if use_frame_roots {
        frame_slot_count(&reflike, frame_layout.as_ref())
    } else {
        0
    };
    if use_frame_roots && !lazy_frame {
        let _ = writeln!(s, "  ts_frame_push(&F.h, {});", frame_slot_count(&reflike, frame_layout.as_ref()) + fin_slots as usize);
    } else if use_frame_roots {
        // lazy: the frame is linked only around slow paths (with register
        // homes it is also filled only there)
    } else if !conservative_roots_enabled() {
        for id in &reflike {
            let _ = writeln!(s, "  ts_gc_root(&v{});", id);
        }
    }
    let nroot = if use_frame_roots || conservative_roots_enabled() { 0 } else { reflike.len() };
    let scalar_slices: BTreeMap<u32, ScalarStringSlice> = BTreeMap::new();
    let json_locals: BTreeSet<u32> = BTreeSet::new();
    let json_roots: BTreeSet<u32> = BTreeSet::new();
    let ctx = Ctx {
        switch_plan: switch_plan_for(f, &unboxed, &int_local, static_strings),
        layouts: layout_plan_for(f),
        lazy_frame,
        lazy_homes,
        lazy_spill: lazy_spill.clone(),
        lazy_reload: lazy_reload.clone(),
        point_spills: BTreeMap::new(),
        cur_inst: std::cell::Cell::new(0),
        accums: accums.clone(),
        frame_nslots,
        int32_use: int32_use_locals(f, &unboxed, &int_local),
        unboxed,
        int_local,
        local_class,
        classes,
        strat,
        fn_names,
        wksym,
        fn_takes_this,
        cur_capture_count: own_capture_count(f),
        i64_fast,
        f64_fast,
        direct_sigs,
        known_methods,
        typeof_fusion,
        tag_consts: tag_consts_for(f),
        str_consts: str_consts_for(f, static_strings),
        static_strings,
        string_metric_plan,
        string_materialization_plan,
        scalar_slices: &scalar_slices,
        dom_ref_total: dom_ref_count(&f.body, &json_locals),
        json_locals,
        json_roots,
        emit_path: std::cell::RefCell::new(Vec::new()),
        numeric_value_local,
        i64_mode: false,
        ret_kind: RetKind::Boxed,
        stack_cells: true,
        prim_kind: prim_kind_locals(f),
        str_typed: typed_keys.map(|t| t.str_typed.clone()).unwrap_or_default(),
        ref_typed: typed_keys.map(|t| t.ref_typed.clone()).unwrap_or_default(),
        f64_mode: true,
        frame_locals,
        frame_slot: frame_layout.as_ref().map(|l| l.slot_of.clone()),
        nroot,
        nonzero_int_const,
        nonzero_int,
        int_const,
        nonnegative_int,
        label_ctr: std::cell::Cell::new(900000),
        loop_labels: std::cell::RefCell::new(Vec::new()),
        ta_hoisted: std::cell::RefCell::new(BTreeMap::new()),
        sv_hoisted: std::cell::RefCell::new(BTreeMap::new()),
        loop_mod_residues: std::cell::RefCell::new(Vec::new()),
        fin_stack: std::cell::RefCell::new(Vec::new()),
        fin_value_slots: fin_slots > 0,
        pendv_depth: std::cell::Cell::new(0),
        eh_depth: std::cell::Cell::new(0),
    };
    emit_seq(s, &f.body, &ctx, PathEdge::Function);
    emit_json_cleanup(s, &ctx);
    let cleanup = ctx.root_cleanup();
    if !cleanup.is_empty() {
        let _ = writeln!(s, "  {}", cleanup);
    }
    s.push_str("  return 0.0;\n}\n\n");
}

fn emit_function(
    s: &mut String,
    f: &Function,
    strat: &BTreeMap<u32, AllocStrategy>,
    classes: &BTreeMap<u32, &ClassDef>,
    fclass: &BTreeMap<u32, u32>,
    fn_names: &BTreeMap<u32, String>,
    wksym: &BTreeMap<u32, u32>,
    fn_takes_this: &BTreeMap<u32, bool>,
    param_facts: &BTreeMap<u32, NumFact>,
    i64_fast: &BTreeMap<u32, I64FuncInfo>,
    f64_fast: &BTreeMap<u32, F64FuncInfo>,
    direct_sigs: &BTreeMap<u32, DirectSig>,
    known_methods: &BTreeMap<u32, u32>,
    static_strings: &BTreeMap<Vec<u16>, usize>,
    string_metric_plan: Option<&FunctionMetricPlan>,
    string_materialization_plan: Option<&FunctionMaterializationPlan>,
    typed_keys: Option<&TypedKeyLocals>,
) {
    let mut local_class = local_class_map(f);
    if let Some(&c) = fclass.get(&f.id.0) {
        if let Some(p0) = f.params.first() {
            local_class.insert(p0.0, c);
        }
    }
    // Note: struct-direct field access is additionally gated on class stability
    // at the use site (see struct_direct_offset); unstable classes fall back to
    // the canonical ts_get/ts_set path which reads struct fields via descriptor.

    let unboxed = unboxed_candidates(f, &local_class);
    let return_facts = i64_return_facts(i64_fast);
    let numeric = infer_numeric_analysis(&f.body, &unboxed, param_facts, &return_facts, &int32_field_loads(&f.body, classes));
    let int_local = numeric.int_local;
    let nonzero_int_const = numeric.nonzero_int_const;
    let nonzero_int = numeric.nonzero_int;
    let int_const = numeric.int_const;
    let nonnegative_int = numeric.nonnegative_int;
    let numeric_targets = numeric_fast_targets(i64_fast, f64_fast);
    let numeric_params: Vec<u32> = f.params.iter().map(|p| p.0).collect();
    let numeric_value_local = numeric_value_locs(&f.body, &numeric_params, &numeric_targets);
    let scalar_slices = collect_scalar_string_slices(&f.body);
    let json_locals = collect_json_dom_locals(&f.body);
    let json_roots = if json_locals.is_empty() {
        BTreeSet::new()
    } else {
        collect_json_dom_parse_roots(&f.body)
    };

    if f.is_async && f.is_generator {
        let scalar_slices: BTreeMap<u32, ScalarStringSlice> = BTreeMap::new();
        let json_locals: BTreeSet<u32> = BTreeSet::new();
        let json_roots: BTreeSet<u32> = BTreeSet::new();
        let ctx = Ctx {
            switch_plan: SwitchPlan::default(),
            layouts: LayoutPlan::default(),
            lazy_frame: false,
            lazy_homes: false,
            lazy_spill: String::new(),
            lazy_reload: String::new(),
            point_spills: BTreeMap::new(),
            cur_inst: std::cell::Cell::new(0),
            accums: Default::default(),
            frame_nslots: 0,
            int32_use: int32_use_locals(f, &unboxed, &int_local),
            unboxed,
            int_local,
            local_class,
            classes,
            strat,
            fn_names,
            wksym,
            fn_takes_this,
            cur_capture_count: own_capture_count(f),
            i64_fast,
            f64_fast,
            direct_sigs,
            known_methods,
            typeof_fusion: typeof_fusion_plan(f),
            tag_consts: tag_consts_for(f),
            str_consts: str_consts_for(f, static_strings),
            static_strings,
            string_metric_plan: None,
            string_materialization_plan: None,
            scalar_slices: &scalar_slices,
            dom_ref_total: dom_ref_count(&f.body, &json_locals),
            json_locals,
            json_roots,
            emit_path: std::cell::RefCell::new(Vec::new()),
            numeric_value_local,
            i64_mode: false,
            ret_kind: RetKind::Boxed,
            stack_cells: false,
            prim_kind: prim_kind_locals(f),
        str_typed: typed_keys.map(|t| t.str_typed.clone()).unwrap_or_default(),
        ref_typed: typed_keys.map(|t| t.ref_typed.clone()).unwrap_or_default(),
            f64_mode: false,
            frame_locals: BTreeSet::new(),
            frame_slot: None,
            nroot: 0,
            nonzero_int_const,
            nonzero_int,
            int_const,
            nonnegative_int,
            label_ctr: std::cell::Cell::new(900000),
            loop_labels: std::cell::RefCell::new(Vec::new()),
        ta_hoisted: std::cell::RefCell::new(BTreeMap::new()),
        sv_hoisted: std::cell::RefCell::new(BTreeMap::new()),
            loop_mod_residues: std::cell::RefCell::new(Vec::new()),
            fin_stack: std::cell::RefCell::new(Vec::new()),
            fin_value_slots: false,
            pendv_depth: std::cell::Cell::new(0),
            eh_depth: std::cell::Cell::new(0),
        };
        emit_asyncgen_function(s, f, &ctx);
        return;
    }
    if f.is_async {
        let scalar_slices: BTreeMap<u32, ScalarStringSlice> = BTreeMap::new();
        let json_locals: BTreeSet<u32> = BTreeSet::new();
        let json_roots: BTreeSet<u32> = BTreeSet::new();
        let ctx = Ctx {
            switch_plan: SwitchPlan::default(),
            layouts: LayoutPlan::default(),
            lazy_frame: false,
            lazy_homes: false,
            lazy_spill: String::new(),
            lazy_reload: String::new(),
            point_spills: BTreeMap::new(),
            cur_inst: std::cell::Cell::new(0),
            accums: Default::default(),
            frame_nslots: 0,
            int32_use: int32_use_locals(f, &unboxed, &int_local),
            unboxed,
            int_local,
            local_class,
            classes,
            strat,
            fn_names,
            wksym,
            fn_takes_this,
            cur_capture_count: own_capture_count(f),
            i64_fast,
            f64_fast,
            direct_sigs,
            known_methods,
            typeof_fusion: typeof_fusion_plan(f),
            tag_consts: tag_consts_for(f),
            str_consts: str_consts_for(f, static_strings),
            static_strings,
            string_metric_plan: None,
            string_materialization_plan: None,
            scalar_slices: &scalar_slices,
            dom_ref_total: dom_ref_count(&f.body, &json_locals),
            json_locals,
            json_roots,
            emit_path: std::cell::RefCell::new(Vec::new()),
            numeric_value_local,
            i64_mode: false,
            ret_kind: RetKind::Boxed,
            stack_cells: false,
            prim_kind: prim_kind_locals(f),
        str_typed: typed_keys.map(|t| t.str_typed.clone()).unwrap_or_default(),
        ref_typed: typed_keys.map(|t| t.ref_typed.clone()).unwrap_or_default(),
            f64_mode: false,
            frame_locals: BTreeSet::new(),
            frame_slot: None,
            nroot: 0,
            nonzero_int_const,
            nonzero_int,
            int_const,
            nonnegative_int,
            label_ctr: std::cell::Cell::new(900000),
            loop_labels: std::cell::RefCell::new(Vec::new()),
        ta_hoisted: std::cell::RefCell::new(BTreeMap::new()),
        sv_hoisted: std::cell::RefCell::new(BTreeMap::new()),
            loop_mod_residues: std::cell::RefCell::new(Vec::new()),
            fin_stack: std::cell::RefCell::new(Vec::new()),
            fin_value_slots: false,
            pendv_depth: std::cell::Cell::new(0),
            eh_depth: std::cell::Cell::new(0),
        };
        emit_async_function(s, f, &ctx);
        return;
    }
    if f.is_generator {
        let scalar_slices: BTreeMap<u32, ScalarStringSlice> = BTreeMap::new();
        let json_locals: BTreeSet<u32> = BTreeSet::new();
        let json_roots: BTreeSet<u32> = BTreeSet::new();
        let ctx = Ctx {
            switch_plan: SwitchPlan::default(),
            layouts: LayoutPlan::default(),
            lazy_frame: false,
            lazy_homes: false,
            lazy_spill: String::new(),
            lazy_reload: String::new(),
            point_spills: BTreeMap::new(),
            cur_inst: std::cell::Cell::new(0),
            accums: Default::default(),
            frame_nslots: 0,
            int32_use: int32_use_locals(f, &unboxed, &int_local),
            unboxed,
            int_local,
            local_class,
            classes,
            strat,
            fn_names,
            wksym,
            fn_takes_this,
            cur_capture_count: own_capture_count(f),
            i64_fast,
            f64_fast,
            direct_sigs,
            known_methods,
            typeof_fusion: typeof_fusion_plan(f),
            tag_consts: tag_consts_for(f),
            str_consts: str_consts_for(f, static_strings),
            static_strings,
            string_metric_plan: None,
            string_materialization_plan: None,
            scalar_slices: &scalar_slices,
            dom_ref_total: dom_ref_count(&f.body, &json_locals),
            json_locals,
            json_roots,
            emit_path: std::cell::RefCell::new(Vec::new()),
            numeric_value_local,
            i64_mode: false,
            ret_kind: RetKind::Boxed,
            stack_cells: false,
            prim_kind: prim_kind_locals(f),
        str_typed: typed_keys.map(|t| t.str_typed.clone()).unwrap_or_default(),
        ref_typed: typed_keys.map(|t| t.ref_typed.clone()).unwrap_or_default(),
            f64_mode: false,
            frame_locals: BTreeSet::new(),
            frame_slot: None,
            nroot: 0,
            nonzero_int_const,
            nonzero_int,
            int_const,
            nonnegative_int,
            label_ctr: std::cell::Cell::new(900000),
            loop_labels: std::cell::RefCell::new(Vec::new()),
        ta_hoisted: std::cell::RefCell::new(BTreeMap::new()),
        sv_hoisted: std::cell::RefCell::new(BTreeMap::new()),
            loop_mod_residues: std::cell::RefCell::new(Vec::new()),
            fin_stack: std::cell::RefCell::new(Vec::new()),
            fin_value_slots: false,
            pendv_depth: std::cell::Cell::new(0),
            eh_depth: std::cell::Cell::new(0),
        };
        emit_generator_function(s, f, &ctx);
        return;
    }

    let mut reflike: Vec<u32> = f
        .locals
        .iter()
        .filter(|l| {
            !matches!(l.ref_kind, RefKind::Primitive)
                && !unboxed.contains(&l.id.0)
                && !json_locals.contains(&l.id.0)
        })
        .map(|l| l.id.0)
        .collect();
    let typeof_fusion = typeof_fusion_plan(f);
    let switch_plan = switch_plan_for(f, &unboxed, &int_local, static_strings);
    let lazy_points = {
        let numeric_all: BTreeSet<u32> = unboxed.union(&int_local).copied().collect();
        let lazy_shape = lazy_frames_enabled() && prop_pic_enabled() && f.rest_param.is_none() && json_roots.is_empty();
        let would_be_lazy = lazy_shape && body_is_gc_free(&f.body, &numeric_all);
        if frame_roots_enabled() && !would_be_lazy && json_locals.is_empty() && scalar_slices.is_empty() {
            let string_plans = string_metric_plan.is_some_and(|p| !p.loops.is_empty())
                || string_materialization_plan.is_some_and(|p| !p.loops.is_empty());
            // a switch table emits copies of its case bodies, whose accesses
            // the plan (keyed by instruction) does not know
            let lazy_ok = lazy_shape
                && lazy_homes_enabled()
                && !f.is_async
                && !f.is_generator
                && switch_plan.heads.is_empty();
            elide_frame_locals(f, &mut reflike, &numeric_all, &typeof_fusion, direct_sigs, string_plans, lazy_ok)
        } else {
            None
        }
    };
    let use_frame_roots = frame_roots_enabled() && !reflike.is_empty()
        && (!conservative_roots_enabled() || body_has_try(&f.body) || body_has_stack_cells(&f.body, strat));
    if use_frame_roots {
        reflike.sort_unstable();
    }
    let frame_locals: BTreeSet<u32> = if use_frame_roots {
        reflike.iter().copied().collect()
    } else {
        BTreeSet::new()
    };
    let frame_layout = if use_frame_roots && frame_coalesce_enabled() {
        Some(compute_frame_layout(f, &reflike, &typeof_fusion))
    } else {
        None
    };
    let dsig = direct_sigs.get(&f.id.0);
    let ret_kind = dsig.map(|sg| sg.ret).unwrap_or(RetKind::Boxed);
    if let Some(sig) = dsig {
        // The body entry: parameters arrive as C parameters, cells first, in
        // the representation the body uses. The table was built from the same
        // classification; a disagreement would be a type error in the C.
        for (i, p) in f.params.iter().enumerate() {
            let kind = param_kind(p.0, &int_local, &unboxed);
            assert!(
                sig.kinds.get(i) == Some(&kind),
                "direct entry signature of fn {} disagrees with its body classification",
                f.id.0
            );
        }
        let storage = direct_entry_storage(f);
        let _ = writeln!(s, "{} {} {}_d({}){{", storage, sig.c_ret(), cname(f), sig.c_params());
        s.push_str(&method_this_check(f, &format!("_p{}", f.capture_count)));
    } else {
        let _ = writeln!(s, "static tsv {}(tsv* args, int nargs){{", cname(f));
        s.push_str("  (void)nargs;\n");
        s.push_str(&method_this_check(f, &format!("(nargs > {c} ? args[{c}] : TS_UNDEFINED)", c = f.capture_count)));
    }
    let int32_use_decl = if int32_codegen_enabled() {
        int32_use_locals(f, &unboxed, &int_local)
    } else {
        BTreeSet::new()
    };
    for l in &f.locals {
        if int_local.contains(&l.id.0) || int32_use_decl.contains(&l.id.0) {
            let _ = writeln!(s, "  long long d{} = 0;", l.id.0);
        } else if json_locals.contains(&l.id.0) {
            let _ = writeln!(s, "  tjson_value* j{} = NULL;", l.id.0);
        } else if unboxed.contains(&l.id.0) {
            let _ = writeln!(s, "  double d{} = 0;", l.id.0);
        } else if !frame_locals.contains(&l.id.0) {
            let _ = writeln!(s, "  tsv v{} = TS_UNDEFINED;", l.id.0);
        }
    }
    // a lazy frame with calls (round 2b): linked only around the inline-cache
    // slow paths, each filling the slots of the locals it must find
    let lazy_calls = use_frame_roots && lazy_points.is_some();
    let lazy_frame = use_frame_roots
        && (lazy_calls
            || (lazy_frames_enabled()
                && prop_pic_enabled()
                && f.rest_param.is_none()
                && json_roots.is_empty()
                && body_is_gc_free(&f.body, &unboxed.union(&int_local).copied().collect())));
    let lazy_homes = lazy_frame && (lazy_calls || lazy_homes_enabled());
    let accums = if string_accum_enabled() {
        crate::string_accum::string_accumulators(f)
    } else {
        Default::default()
    };
    let (lazy_spill, lazy_reload) = if lazy_homes {
        lazy_spill_reload(&reflike, frame_layout.as_ref())
    } else {
        (String::new(), String::new())
    };
    let point_spills: BTreeMap<usize, (String, String)> = match (&lazy_points, lazy_calls) {
        (Some(points), true) => points
            .iter()
            .map(|(addr, live)| (*addr, point_spill_reload(live, &reflike, frame_layout.as_ref())))
            .collect(),
        _ => BTreeMap::new(),
    };
    emit_stack_cell_decls(s, &f.body, strat);
    let fin_slots = if use_frame_roots && !lazy_frame && finally_slots_enabled() {
        finally_value_slots(&f.body)
    } else {
        0
    };
    if use_frame_roots {
        emit_frame_decl_homes(s, &reflike, frame_layout.as_ref(), lazy_homes, fin_slots);
    }
    if !json_roots.is_empty() {
        s.push_str("  ts_json_dom_scope _json_dom_scope = {0};\n");
    }
    let scalar_slice_roots: BTreeSet<u32> = scalar_slices.values().map(|spec| spec.root).collect();
    for id in &scalar_slice_roots {
        let _ = writeln!(
            s,
            "  tsv ss_base{} = TS_UNDEFINED; long long ss_start{} = 0, ss_len{} = 0; int ss_fast{} = 0;",
            id, id, id, id
        );
    }
    let ncap = own_capture_count(f);
    if ncap > 0 && dsig.is_none() {
        // Captured cells arrive through the environment register, which the
        // caller stored immediately before this call; read them first.
        s.push_str("  tsv* _env = g_ts_cur_env;\n");
    }
    for (i, p) in f.params.iter().enumerate() {
        if Some(p.0) == f.rest_param {
            continue;
        } // gathered separately below
        if dsig.is_some() {
            if int_local.contains(&p.0) || unboxed.contains(&p.0) {
                let _ = writeln!(s, "  d{} = _p{};", p.0, i);
            } else {
                let name = frame_local_name(p.0, &frame_locals, frame_layout.as_ref(), lazy_homes);
                let _ = writeln!(s, "  {} = _p{};", name, i);
            }
            continue;
        }
        if i < ncap {
            if int_local.contains(&p.0) {
                let _ = writeln!(s, "  d{} = (long long)ts_to_num(_env[{}]);", p.0, i);
            } else if unboxed.contains(&p.0) {
                let _ = writeln!(s, "  d{} = ts_to_num(_env[{}]);", p.0, i);
            } else {
                let name = frame_local_name(p.0, &frame_locals, frame_layout.as_ref(), lazy_homes);
                let _ = writeln!(s, "  {} = _env[{}];", name, i);
            }
            continue;
        }
        let j = i - ncap;
        if int_local.contains(&p.0) {
            let _ = writeln!(
                s,
                "  if (nargs > {}) d{} = (long long)ts_to_num(args[{}]);",
                j, p.0, j
            );
        } else if unboxed.contains(&p.0) {
            let _ = writeln!(s, "  if (nargs > {}) d{} = ts_to_num(args[{}]);", j, p.0, j);
        } else {
            let name = frame_local_name(p.0, &frame_locals, frame_layout.as_ref(), lazy_homes);
            let _ = writeln!(s, "  if (nargs > {}) {} = args[{}];", j, name, j);
        }
    }
    let frame_nslots: usize = if use_frame_roots {
        frame_slot_count(&reflike, frame_layout.as_ref())
    } else {
        0
    };
    if use_frame_roots && !lazy_frame {
        let _ = writeln!(s, "  ts_frame_push(&F.h, {});", frame_slot_count(&reflike, frame_layout.as_ref()) + fin_slots as usize);
    } else if use_frame_roots {
        // lazy: the frame is linked only around slow paths (with register
        // homes it is also filled only there)
    } else if !conservative_roots_enabled() {
        for id in &reflike {
            let _ = writeln!(s, "  ts_gc_root(&v{});", id);
        }
    }
    for id in &scalar_slice_roots {
        let _ = writeln!(s, "  ts_gc_root(&ss_base{});", id);
    }
    let nroot = scalar_slice_roots.len()
        + if use_frame_roots || conservative_roots_enabled() { 0 } else { reflike.len() };

    // Rest parameter: gather args[restIndex..nargs] into a fresh array. Root the
    // destination first because ts_array_push may allocate and trigger minor GC.
    if let Some(rest_id) = f.rest_param {
        let rest_index = f
            .params
            .iter()
            .position(|p| p.0 == rest_id)
            .unwrap_or(f.params.len().saturating_sub(1));
        let rest_name = frame_local_name(rest_id, &frame_locals, frame_layout.as_ref(), lazy_homes);
        let _ = writeln!(s, "  {} = ts_new_array(0);", rest_name);
        let _ = writeln!(
            s,
            "  for (int _ri = {}; _ri < nargs; _ri++) ts_array_push({}, args[_ri]);",
            rest_index.saturating_sub(ncap), rest_name
        );
    }

    let ctx = Ctx {

        switch_plan,

        layouts: layout_plan_for(f),

        lazy_frame,
        lazy_homes,
        lazy_spill: lazy_spill.clone(),
        lazy_reload: lazy_reload.clone(),
        point_spills,
        cur_inst: std::cell::Cell::new(0),
        accums: accums.clone(),

        frame_nslots,
        int32_use: int32_use_locals(f, &unboxed, &int_local),
        unboxed,
        int_local,
        local_class,
        classes,
        strat,
        fn_names,
        wksym,
        fn_takes_this,
        cur_capture_count: own_capture_count(f),
        i64_fast,
        f64_fast,
        direct_sigs,
        known_methods,
        typeof_fusion,
        tag_consts: tag_consts_for(f),
        str_consts: str_consts_for(f, static_strings),
        static_strings,
        string_metric_plan,
        string_materialization_plan,
        scalar_slices: &scalar_slices,
        dom_ref_total: dom_ref_count(&f.body, &json_locals),
        json_locals,
        json_roots,
        emit_path: std::cell::RefCell::new(Vec::new()),
        numeric_value_local,
        i64_mode: false,
        ret_kind: ret_kind,
        stack_cells: true,
        prim_kind: prim_kind_locals(f),
        str_typed: typed_keys.map(|t| t.str_typed.clone()).unwrap_or_default(),
        ref_typed: typed_keys.map(|t| t.ref_typed.clone()).unwrap_or_default(),
        f64_mode: false,
        frame_locals,
        frame_slot: frame_layout.as_ref().map(|l| l.slot_of.clone()),
        nroot,
        nonzero_int_const,
        nonzero_int,
        int_const,
        nonnegative_int,
        label_ctr: std::cell::Cell::new(900000),
        loop_labels: std::cell::RefCell::new(Vec::new()),
        ta_hoisted: std::cell::RefCell::new(BTreeMap::new()),
        sv_hoisted: std::cell::RefCell::new(BTreeMap::new()),
        loop_mod_residues: std::cell::RefCell::new(Vec::new()),
        fin_stack: std::cell::RefCell::new(Vec::new()),
        fin_value_slots: fin_slots > 0,
        pendv_depth: std::cell::Cell::new(0),
        eh_depth: std::cell::Cell::new(0),
    };
    emit_seq(s, &f.body, &ctx, PathEdge::Function);
    emit_json_cleanup(s, &ctx);
    let cleanup = ctx.root_cleanup();
    if !cleanup.is_empty() {
        let _ = writeln!(s, "  {}", cleanup);
    }
    let _ = writeln!(
        s,
        "  return {};\n}}\n",
        match ctx.ret_kind {
            RetKind::Boxed => "TS_UNDEFINED",
            RetKind::F64 => "0.0",
            _ => "0",
        }
    );
    if let Some(sig) = dsig {
        emit_direct_forwarder(s, f, sig, ncap);
    }
}

/// A local is integer-typed if every definition is an integer constant, an
/// int-param coercion, or an int-closed op (+,-,*,%) of integer locals. Least
/// fixpoint over the (flattened) instruction stream; division and comparisons
/// do not preserve int-ness for the result we store.
/// Comparison-result locals whose EVERY use is a truthiness context (the cond of
/// a Loop/If, or the operand of a `!`). Such a local is always a clean 0/1 and is
/// never observed AS a boolean value (printed, stored, passed, returned, combined),
/// so it can be kept unboxed as a raw int — eliminating the box/unbox around loop
/// and if conditions. Anything not provably truthy-only stays boxed (correctness:
/// e.g. `const b = i < n; console.log(b)` must print `true`, not `1`).
fn cmp_truthy_only(body: &[Inst]) -> BTreeSet<u32> {
    // 1. candidates: dst of a comparison BinOp.
    let mut cand: BTreeSet<u32> = BTreeSet::new();
    fn find_cmps(b: &[Inst], cand: &mut BTreeSet<u32>) {
        for i in b {
            match i {
                Inst::BinOp { dst, op, .. }
                    if matches!(
                        op.as_str(),
                        "<" | "<=" | ">" | ">=" | "==" | "!=" | "===" | "!=="
                    ) =>
                {
                    cand.insert(dst.0);
                }
                Inst::Loop {
                    cond_body, body, ..
                } => {
                    find_cmps(cond_body, cand);
                    find_cmps(body, cand);
                }
                Inst::If {
                    then_body,
                    else_body,
                    ..
                } => {
                    find_cmps(then_body, cand);
                    find_cmps(else_body, cand);
                }
                Inst::TryCatch {
                    try_body,
                    catch_body,
                    finally_body,
                    ..
                } => {
                    find_cmps(try_body, cand);
                    find_cmps(catch_body, cand);
                    find_cmps(finally_body, cand);
                }
                _ => {}
            }
        }
    }
    find_cmps(body, &mut cand);
    if cand.is_empty() {
        return cand;
    }

    // 2. disqualify any candidate that appears as a NON-truthy use. We tally every
    //    appearance of each candidate as a source/operand; truthy appearances are
    //    counted separately. A candidate survives iff total uses == truthy uses.
    let mut total: std::collections::BTreeMap<u32, u32> = std::collections::BTreeMap::new();
    let mut truthy: std::collections::BTreeMap<u32, u32> = std::collections::BTreeMap::new();
    let bump = |m: &mut std::collections::BTreeMap<u32, u32>, id: u32, cand: &BTreeSet<u32>| {
        if cand.contains(&id) {
            *m.entry(id).or_insert(0) += 1;
        }
    };
    fn walk(
        b: &[Inst],
        cand: &BTreeSet<u32>,
        total: &mut std::collections::BTreeMap<u32, u32>,
        truthy: &mut std::collections::BTreeMap<u32, u32>,
        bump: &dyn Fn(&mut std::collections::BTreeMap<u32, u32>, u32, &BTreeSet<u32>),
    ) {
        for i in b {
            // count every source/operand appearance into `total`.
            match i {
                Inst::Copy { src, .. } => bump(total, src.0, cand),
                Inst::LoadField { obj, .. } => bump(total, obj.0, cand),
                Inst::StoreField { obj, src, .. } => {
                    bump(total, obj.0, cand);
                    bump(total, src.0, cand);
                }
                Inst::LoadElem { arr, .. } => bump(total, arr.0, cand),
                Inst::StoreElem { arr, src } => {
                    bump(total, arr.0, cand);
                    bump(total, src.0, cand);
                }
                Inst::Call { recv, args, .. } => {
                    if let Some(r) = recv {
                        bump(total, r.0, cand);
                    }
                    for a in args {
                        bump(total, a.0, cand);
                    }
                }
                Inst::CallBuiltin { recv, args, .. } => {
                    bump(total, recv.0, cand);
                    for a in args {
                        bump(total, a.0, cand);
                    }
                }
                Inst::CallBuiltinStatic { args, .. } => {
                    for a in args {
                        bump(total, a.0, cand);
                    }
                }
                Inst::Return { src } => {
                    if let Some(s) = src {
                        bump(total, s.0, cand);
                    }
                }
                Inst::Yield { operand, .. } => bump(total, operand.0, cand),
                Inst::Await { operand, .. } => bump(total, operand.0, cand),
                Inst::Throw { src } => bump(total, src.0, cand),
                Inst::StoreGlobal { src, .. } => bump(total, src.0, cand),
                Inst::BinOp { lhs, rhs, .. } => {
                    bump(total, lhs.0, cand);
                    bump(total, rhs.0, cand);
                }
                Inst::UnOp { op, operand, .. } => {
                    bump(total, operand.0, cand);
                    if op == "!" {
                        bump(truthy, operand.0, cand);
                    }
                }
                Inst::LoadIndex { arr, index, .. } => {
                    bump(total, arr.0, cand);
                    bump(total, index.0, cand);
                }
                Inst::StoreIndex { arr, index, src, .. } => {
                    bump(total, arr.0, cand);
                    bump(total, index.0, cand);
                    bump(total, src.0, cand);
                }
                Inst::ArrayLen { arr, .. } => bump(total, arr.0, cand),
                Inst::StringLen { src, .. } => bump(total, src.0, cand),
                Inst::ArrayPush { arr, src } => {
                    bump(total, arr.0, cand);
                    bump(total, src.0, cand);
                }
                Inst::ArrayPushAll { arr, src } => {
                    bump(total, arr.0, cand);
                    bump(total, src.0, cand);
                }
                Inst::HasField { obj, .. } => bump(total, obj.0, cand),
                Inst::HasFieldDynamic { obj, key, .. } => {
                    bump(total, obj.0, cand);
                    bump(total, key.0, cand);
                }
                Inst::GenericLen { src, .. } => bump(total, src.0, cand),
                Inst::LoadFieldDynamic { obj, key, .. } => {
                    bump(total, obj.0, cand);
                    bump(total, key.0, cand);
                }
                Inst::StoreFieldDynamic { obj, key, src } => {
                    bump(total, obj.0, cand);
                    bump(total, key.0, cand);
                    bump(total, src.0, cand);
                }
                Inst::DeleteField { obj, .. } => bump(total, obj.0, cand),
                Inst::ArraySlice { arr, start, .. } => {
                    bump(total, arr.0, cand);
                    bump(total, start.0, cand);
                }
                Inst::ObjectRest { src, .. } => bump(total, src.0, cand),
                Inst::ObjectCopyProps { src, .. } => bump(total, src.0, cand),
                Inst::CallSpread {
                    recv, arg_specs, ..
                } => {
                    if let Some(r) = recv {
                        bump(total, r.0, cand);
                    }
                    for sp in arg_specs {
                        match sp {
                            ArgSpec::Single { local } | ArgSpec::Spread { local } => {
                                bump(total, local.0, cand)
                            }
                        }
                    }
                }
                Inst::SetProto { obj, proto, .. } => {
                    bump(total, obj.0, cand);
                    bump(total, proto.0, cand);
                }
                Inst::GetProto { obj, .. } => bump(total, obj.0, cand),
                Inst::StoreProtoMethod { src, .. } => bump(total, src.0, cand),
                Inst::StoreMethod { obj, src, .. } => {
                    bump(total, obj.0, cand);
                    bump(total, src.0, cand);
                }
                Inst::Print { src } => bump(total, src.0, cand),
                Inst::Loop {
                    cond,
                    cond_body,
                    body,
                    ..
                } => {
                    bump(total, cond.0, cand);
                    bump(truthy, cond.0, cand);
                    walk(cond_body, cand, total, truthy, bump);
                    walk(body, cand, total, truthy, bump);
                }
                Inst::If {
                    cond,
                    then_body,
                    else_body,
                } => {
                    bump(total, cond.0, cand);
                    bump(truthy, cond.0, cand);
                    walk(then_body, cand, total, truthy, bump);
                    walk(else_body, cand, total, truthy, bump);
                }
                Inst::TryCatch {
                    try_body,
                    catch_body,
                    finally_body,
                    ..
                } => {
                    walk(try_body, cand, total, truthy, bump);
                    walk(catch_body, cand, total, truthy, bump);
                    walk(finally_body, cand, total, truthy, bump);
                }
                // remaining variants reference no candidate source locals.
                _ => {}
            }
        }
    }
    walk(body, &cand, &mut total, &mut truthy, &bump);
    // survive iff every appearance is a truthy one (and it's used at least once;
    // an unused comparison result is harmless either way, keep boxed to be safe).
    cand.into_iter()
        .filter(|id| {
            let t = total.get(id).copied().unwrap_or(0);
            t > 0 && t == truthy.get(id).copied().unwrap_or(0)
        })
        .collect()
}

/* Boolean temporaries that only feed conditions (docs/truthy_unbox_design.md).
   The rule above unboxes a comparison result used only as a condition; the
   `!` results and the merge temporaries of `&&`/`||` (`t = a; if (t) t = b`)
   stayed boxed (`ts_bool`, a frame slot, `ts_truthy_fast` at the test).
   This generalization keeps a local raw when every definition is a
   comparison, a `!`, or a copy of a raw numeric or of another such local,
   and every use is a condition, a `!` operand, or a copy into another such
   local — a fixpoint, so a copy into a local that stays boxed disqualifies
   its source (a raw 0/1 must never be boxed as a number). An undefined
   path (a conditional definition) reads as 0, which is falsy, as undefined
   is. TSAOT_TRUTHY_UNBOX=0 keeps the comparison-only rule (parity oracle). */
fn tag_eq_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_TAG_EQ").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// Element access keys typed as numbers but not array indices
/// (docs/array_index_keys_design.md): int64 / double entry points instead of a
/// uint32 cast. TSAOT_INDEX_KEYS=0 keeps the previous emission (parity oracle).
fn index_keys_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_INDEX_KEYS").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}
fn inline_index_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_INLINE_INDEX").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// Locals whose every definition is the same `undefined`, `null` or boolean
/// constant, mapped to that constant's C expression. Those three kinds have a
/// single encoding each, so a strict comparison against such a local is a bit
/// compare of the other operand (numbers and strings are excluded: NaN, -0 and
/// string contents). Parameters and catch variables are defined outside the
/// instruction stream and never qualify.
/// `x === "literal"` (docs/string_switch_chains_design.md): a local whose every
/// definition is the same string constant, as (static literal id, length).
/// TSAOT_STR_EQ_CONST=0 keeps the generic strict equality (the parity oracle).
fn str_eq_const_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_STR_EQ_CONST").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

fn str_consts_for(f: &Function, static_strings: &BTreeMap<Vec<u16>, usize>) -> BTreeMap<u32, (usize, u32)> {
    let mut out: BTreeMap<u32, (usize, u32)> = BTreeMap::new();
    if !str_eq_const_enabled() {
        return out;
    }
    let mut flat: Vec<&Inst> = Vec::new();
    flatten_inst(&f.body, &mut flat);
    let mut seen: BTreeMap<u32, Option<Vec<u16>>> = BTreeMap::new();
    for inst in &flat {
        if let Inst::TryCatch { catch_var: Some(c), .. } = inst {
            seen.insert(c.0, None);
        }
        let Some(d) = inst_def(inst) else { continue };
        let units: Option<Vec<u16>> = match inst {
            Inst::Const { value: ConstVal::Str { value }, .. } => Some(str_units(value)),
            Inst::Const { value: ConstVal::Str16 { units }, .. } => Some(units.clone()),
            _ => None,
        };
        match seen.get(&d) {
            None => {
                seen.insert(d, units);
            }
            Some(prev) => {
                if *prev != units {
                    seen.insert(d, None);
                }
            }
        }
    }
    for p in &f.params {
        seen.insert(p.0, None);
    }
    for (d, units) in seen {
        if let Some(u) = units {
            if let Some(id) = static_strings.get(&u) {
                out.insert(d, (*id, u.len() as u32));
            }
        }
    }
    out
}

fn tag_consts_for(f: &Function) -> BTreeMap<u32, &'static str> {
    let mut out: BTreeMap<u32, &'static str> = BTreeMap::new();
    if !tag_eq_enabled() {
        return out;
    }
    let mut flat: Vec<&Inst> = Vec::new();
    flatten_inst(&f.body, &mut flat);
    let mut tag: BTreeMap<u32, Option<&'static str>> = BTreeMap::new();
    for inst in &flat {
        if let Inst::TryCatch {
            catch_var: Some(c), ..
        } = inst
        {
            tag.insert(c.0, None);
        }
        let Some(d) = inst_def(inst) else { continue };
        let t: Option<&'static str> = match inst {
            Inst::Const {
                value: ConstVal::Undef,
                ..
            } => Some("TS_UNDEFINED"),
            Inst::Const {
                value: ConstVal::Null,
                ..
            } => Some("TS_NULL"),
            Inst::Const {
                value: ConstVal::Bool { value },
                ..
            } => Some(if *value { "ts_bool(1)" } else { "ts_bool(0)" }),
            _ => None,
        };
        match tag.get(&d) {
            None => {
                tag.insert(d, t);
            }
            Some(prev) => {
                if *prev != t {
                    tag.insert(d, None);
                }
            }
        }
    }
    for p in &f.params {
        tag.insert(p.0, None);
    }
    for (id, t) in tag {
        if let Some(t) = t {
            out.insert(id, t);
        }
    }
    out
}

fn known_method_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_KNOWN_METHOD").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// Field keys under which the program stores exactly one closure function
/// (every `StoreField` of the key stores a single-definition `AllocClosure`
/// local of that function), mapped to the function. A guess for the dynamic
/// method call sites, verified at run time by the closure's code pointer
/// (see the call emission); any other store poisons the key.
fn known_method_closures(program: &Program) -> BTreeMap<u32, u32> {
    let mut out: BTreeMap<u32, u32> = BTreeMap::new();
    if !known_method_enabled() || !prop_pic_enabled() {
        return out;
    }
    // Some(func): exactly one closure function so far; None: poisoned
    let mut stored: BTreeMap<u32, Option<u32>> = BTreeMap::new();
    for f in &program.functions {
        let mut flat: Vec<&Inst> = Vec::new();
        flatten_inst(&f.body, &mut flat);
        let mut ndefs: BTreeMap<u32, u32> = BTreeMap::new();
        let mut closure_of: BTreeMap<u32, u32> = BTreeMap::new();
        for inst in &flat {
            if let Some(d) = inst_def(inst) {
                *ndefs.entry(d).or_insert(0) += 1;
            }
            if let Inst::AllocClosure { dst, func, .. } = inst {
                closure_of.insert(dst.0, func.0);
            }
        }
        for inst in &flat {
            if let Inst::StoreField { field, src, .. } = inst {
                let k = match closure_of.get(&src.0) {
                    Some(fid) if ndefs.get(&src.0) == Some(&1) => Some(*fid),
                    _ => None,
                };
                match stored.get(&field.0) {
                    None => {
                        stored.insert(field.0, k);
                    }
                    Some(prev) => {
                        if *prev != k {
                            stored.insert(field.0, None);
                        }
                    }
                }
            }
        }
    }
    for (field, k) in stored {
        if let Some(k) = k {
            out.insert(field, k);
        }
    }
    out
}

/// A dynamic method call whose key is one known closure program-wide: the
/// own-property lookup as today, then the guess verified by the closure's
/// code pointer and taken through the function's direct entry with the
/// closure's cells; the prototype lookup and `ts_call_method` otherwise.
/// `argv` is [receiver, args...] (already copied into `_a`). Returns false
/// when the site is left to the generic emission.
fn emit_known_method_call(
    s: &mut String,
    ctx: &Ctx,
    method_id: u32,
    method_field: u32,
    argv: &[u32],
    dst: &Option<LocalId>,
) -> bool {
    let Some(&k) = ctx.known_methods.get(&method_field) else { return false };
    let Some(sig) = ctx.direct_sigs.get(&k) else { return false };
    if argv.is_empty() {
        return false;
    }
    let ncap = callee_capture_count(k);
    let takes_this = *ctx.fn_takes_this.get(&k).unwrap_or(&false);
    let lead = ncap + usize::from(takes_this);
    if sig.kinds.len() < lead || sig.kinds[..lead].iter().any(|kd| !matches!(kd, ParamKind::Boxed)) {
        return false;
    }
    let mut parts: Vec<String> = (0..ncap).map(|i| format!("_kf->env[{}]", i)).collect();
    if takes_this {
        parts.push(ctx.val(argv[0]));
    }
    for (i, kind) in sig.kinds.iter().enumerate().skip(lead) {
        let a = argv.get(1 + i - lead);
        parts.push(match a {
            Some(a) => match kind {
                ParamKind::Boxed => ctx.val(*a),
                ParamKind::F64 => ctx.num(*a),
                ParamKind::I64 => {
                    if ctx.int_local.contains(a) {
                        format!("d{}", a)
                    } else {
                        format!("(long long)({})", ctx.num(*a))
                    }
                }
            },
            None => match kind {
                ParamKind::Boxed => "TS_UNDEFINED".to_string(),
                ParamKind::F64 => "0.0".to_string(),
                ParamKind::I64 => "0".to_string(),
            },
        });
    }
    let fname = ctx.fn_name_of(k);
    let _ = writeln!(s, "    ts_check_method_recv(_a[0], {}u);", method_field);
    s.push_str("    static ts_prop_ic _ts_method_field_ic = TS_PROP_IC_INIT;
");
    s.push_str("    static ts_prop_ic _ts_method_proto_ic = TS_PROP_IC_INIT;
");
    let _ = writeln!(
        s,
        "    tsv _mv = ts_get_pic_checked_inline(_a[0], {}u, &_ts_method_field_ic);",
        method_field
    );
    let _ = writeln!(
        s,
        "    if (ts_is_func(_mv) && ((ts_func*)ts_ptr(_mv))->code == (void*){}) {{",
        fname
    );
    s.push_str("      ts_func* _kf = (ts_func*)ts_ptr(_mv); (void)_kf;
");
    let direct = format!("{}_d({})", fname, parts.join(", "));
    s.push_str(&ctx.set_call_result(dst, &direct, sig.ret));
    s.push_str("    } else {
");
    let _ = writeln!(
        s,
        "      if (!ts_is_callable(_mv)) _mv = ts_get_pic_checked_inline(_a[0], {}, &_ts_method_proto_ic);",
        method_key_str(method_id, ctx.wksym)
    );
    let _ = writeln!(s, "      if (!ts_is_callable(_mv)) ts_dynamic_method_missing({}u);", method_field);
    let generic = format!("ts_call_method(_mv, _a, {})", argv.len());
    match dst {
        Some(d) => s.push_str(&ctx.set_val(d.0, &generic)),
        None => {
            let _ = writeln!(s, "      {};", generic);
        }
    }
    s.push_str("    }
");
    true
}

fn typed_returns_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_TYPED_RETURNS").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// The locals returned by the body's `return` instructions, and whether a
/// valueless `return` exists.
fn return_sources(body: &[Inst]) -> (Vec<u32>, bool) {
    let mut flat: Vec<&Inst> = Vec::new();
    flatten_inst(body, &mut flat);
    let mut srcs: Vec<u32> = Vec::new();
    let mut valueless = false;
    for inst in &flat {
        if let Inst::Return { src } = inst {
            match src {
                Some(v) => srcs.push(v.0),
                None => valueless = true,
            }
        }
    }
    (srcs, valueless)
}

/// Locals returned by the function when every `return` carries one and each
/// such local holds only booleans produced in place — comparisons, `!`,
/// boolean constants, calls to functions whose direct entry returns a raw
/// boolean, or copies of such locals — and is used only by returns,
/// conditions, `!` and those copies. Empty when any return disqualifies.
/// Parameters and catch variables are defined from outside and never qualify.
fn bool_return_locals(f: &Function) -> BTreeSet<u32> {
    if !typed_returns_enabled() {
        return BTreeSet::new();
    }
    let mut flat: Vec<&Inst> = Vec::new();
    flatten_inst(&f.body, &mut flat);
    let mut returned: BTreeSet<u32> = BTreeSet::new();
    for inst in &flat {
        if let Inst::Return { src } = inst {
            match src {
                Some(v) => {
                    returned.insert(v.0);
                }
                None => return BTreeSet::new(),
            }
        }
    }
    if returned.is_empty() {
        return BTreeSet::new();
    }
    let outside: BTreeSet<u32> = f
        .params
        .iter()
        .map(|p| p.0)
        .chain(collect_catch_vars(&f.body))
        .collect();
    let mut defs: BTreeMap<u32, Vec<Option<u32>>> = BTreeMap::new();
    let mut other_def: BTreeSet<u32> = BTreeSet::new();
    let mut total: BTreeMap<u32, u32> = BTreeMap::new();
    let mut ok_use: BTreeMap<u32, u32> = BTreeMap::new();
    let mut copies: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    for inst in &flat {
        match inst {
            Inst::If { cond, .. } | Inst::Loop { cond, .. } => {
                *total.entry(cond.0).or_insert(0) += 1;
                *ok_use.entry(cond.0).or_insert(0) += 1;
                continue;
            }
            Inst::TryCatch { .. } => continue,
            _ => {}
        }
        let def = inst_def(inst);
        match inst {
            Inst::BinOp { dst, op, .. }
                if matches!(
                    op.as_str(),
                    "<" | "<=" | ">" | ">=" | "==" | "!=" | "===" | "!=="
                ) =>
            {
                defs.entry(dst.0).or_default().push(None);
            }
            Inst::UnOp { dst, op, .. } if op == "!" => {
                defs.entry(dst.0).or_default().push(None);
            }
            Inst::Const {
                dst,
                value: ConstVal::Bool { .. },
            } => {
                defs.entry(dst.0).or_default().push(None);
            }
            Inst::Call {
                dst: Some(dst),
                callee: CalleeRef::Direct { func },
                ..
            } if is_bool_callee(func.0) => {
                defs.entry(dst.0).or_default().push(None);
            }
            Inst::Copy { dst, src } => {
                defs.entry(dst.0).or_default().push(Some(src.0));
                copies.entry(src.0).or_default().push(dst.0);
            }
            _ => {
                if let Some(d) = def {
                    other_def.insert(d);
                }
            }
        }
        let mut seen: BTreeSet<u32> = BTreeSet::new();
        for r in inst_refs(inst) {
            if Some(r) == def || !seen.insert(r) {
                continue;
            }
            *total.entry(r).or_insert(0) += 1;
            if matches!(inst, Inst::UnOp { op, .. } if op == "!") || matches!(inst, Inst::Return { .. }) {
                *ok_use.entry(r).or_insert(0) += 1;
            }
        }
    }
    let mut kept: BTreeSet<u32> = defs
        .keys()
        .copied()
        .filter(|id| !other_def.contains(id) && !outside.contains(id))
        .collect();
    loop {
        let mut drop: Vec<u32> = Vec::new();
        for &c in &kept {
            let defs_ok = defs[&c].iter().all(|d| d.map_or(true, |src| kept.contains(&src)));
            let into_kept = copies
                .get(&c)
                .map_or(0, |ds| ds.iter().filter(|d| kept.contains(d)).count() as u32);
            let tot = total.get(&c).copied().unwrap_or(0);
            let ok = ok_use.get(&c).copied().unwrap_or(0);
            if !defs_ok || tot == 0 || tot != ok + into_kept {
                drop.push(c);
            }
        }
        if drop.is_empty() {
            break;
        }
        for c in drop {
            kept.remove(&c);
        }
    }
    if returned.iter().all(|r| kept.contains(r)) {
        kept
    } else {
        BTreeSet::new()
    }
}

/// The return kind of a direct entry, from the body's classification.
fn direct_return_kind(f: &Function, unboxed: &BTreeSet<u32>, int_local: &BTreeSet<u32>) -> RetKind {
    if !typed_returns_enabled() {
        return RetKind::Boxed;
    }
    let (srcs, valueless) = return_sources(&f.body);
    if valueless || srcs.is_empty() {
        return RetKind::Boxed;
    }
    if !bool_return_locals(f).is_empty() {
        return RetKind::Bool;
    }
    if srcs.iter().all(|s| int_local.contains(s)) {
        return RetKind::I64;
    }
    if srcs.iter().all(|s| unboxed.contains(s)) {
        return RetKind::F64;
    }
    RetKind::Boxed
}

/// A spread call builds its argument array on the stack up to sixteen values
/// (TSAOT_SPREAD_STACK=0: always malloc, the frozen emitter's form).
fn spread_stack_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_SPREAD_STACK").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

fn stack_closures_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_STACK_CLOSURES").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// The guard of a typed class-field access (a struct offset): a receiver
/// without the sized-instance layout takes ts_get / ts_set
/// (docs/foreign_receivers_design.md). TSAOT_TYPED_SLOW=0 keeps the Proxy-only
/// guard of the frozen emitter (parity oracle).
/// The class a field access's receiver is read as: the analysis's (a
/// parameter's class, an allocation's), else the exporter's hint from the
/// receiver's static type (`cls`, docs/receiver_class_hints_design.md),
/// with what the hinted access must test.
fn receiver_class(ctx: &Ctx, obj: u32, cls: u32, field: u32) -> (Option<u32>, Option<HintGuard>) {
    let known = ctx.local_class.get(&obj).copied();
    // the analysis's class is flow-insensitive: a downcast's copy keeps the
    // parameter's class, which may lack the field the hint's class has
    if let Some(c) = known {
        if struct_direct_offset(c, field, ctx.classes).is_some() {
            return (Some(c), None);
        }
    }
    if cls != 0 && class_hints_enabled() {
        if let Some(g) = hint_guard(cls - 1, field, ctx.classes) {
            return (Some(cls - 1), Some(g));
        }
    }
    (known, None)
}

fn class_hints_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_CLASS_HINTS").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// What a hinted struct-offset access tests besides the receiver being an
/// object (its type is the program's claim; null or undefined takes the
/// generic access, which throws as V8 does). The slot belongs to the
/// topmost ancestor declaring the field (`numeric_field`'s rule).
enum HintGuard {
    /// The root of a hierarchy declares the field: every class of the
    /// hierarchy has it at the offset (a value of another hierarchy cannot be
    /// typed as the class, `class_extract.ts` pass 3).
    Root,
    /// A leaf class declares it: a downcast to the leaf may be wrong (`(n as
    /// Leaf).f` reads another kind of node's field there), so the receiver's
    /// prototype must be the leaf's.
    Leaf(u32),
    /// A class below the root declares it: the receiver must be a sized
    /// instance of that class or a subclass, by the class index
    /// (`cls - lo < span`, docs/class_index_dispatch_design.md).
    Range { lo: u32, span: u32 },
}

/// `None`: no struct access for the hint (an intermediate class declares
/// the field, or nobody does).
fn hint_guard(c: u32, field: u32, classes: &BTreeMap<u32, &ClassDef>) -> Option<HintGuard> {
    let mut decl = None;
    let mut cur = Some(c);
    while let Some(id) = cur {
        let Some(cd) = classes.get(&id) else { break };
        if cd.own_fields.iter().any(|f| f.0 == field) {
            decl = Some(id);
        }
        cur = cd.parent.map(|p| p.0);
    }
    let d = decl?;
    if classes.get(&d)?.parent.is_none() {
        return Some(HintGuard::Root);
    }
    if class_index_enabled() {
        let dfs = class_dfs();
        if let (Some(&i), Some(&span)) = (dfs.index.get(&d), dfs.span.get(&d)) {
            return Some(HintGuard::Range { lo: i + 1, span });
        }
    }
    if classes.values().any(|o| o.parent.map(|p| p.0) == Some(d)) {
        return None;
    }
    Some(HintGuard::Leaf(d))
}

/// `c`: the class whose struct offset the access uses.
fn receiver_guard(obj: &str, hint: &Option<HintGuard>, c: u32) -> String {
    match hint {
        None => typed_slow_guard_for(obj, c),
        Some(HintGuard::Root) => format!("!ts_is_obj({}) || ({})", obj, typed_slow_guard_for(obj, c)),
        Some(HintGuard::Leaf(d)) => format!(
            "!ts_is_obj({o}) || ((ts_object*)ts_ptr({o}))->proto != CLASS_PROTO[{d}] || ({g})",
            o = obj,
            d = d,
            g = typed_slow_guard(obj)
        ),
        // a class index in the declaring class's interval is a sized,
        // unrelinked instance of it or a subclass: the flag adds nothing
        Some(HintGuard::Range { lo, span }) => format!(
            "!ts_is_obj({o}) || (uint32_t)(((ts_object*)ts_ptr({o}))->cls - {lo}u) >= {span}u",
            o = obj,
            lo = lo,
            span = span
        ),
    }
}

/// The flag's test of a struct access through class `c`: once a foreign
/// receiver can exist, the receiver must be a sized, unrelinked instance of
/// `c` or a subclass (its class index in `c`'s interval), which a borrowed or
/// grafted method's `this` of another class is not; without class indices,
/// a sized instance at all (docs/closed_receivers_design.md, slice 2).
fn typed_slow_guard_for(obj: &str, c: u32) -> String {
    if !closed_receivers() && typed_slow_enabled() && class_index_enabled() {
        let dfs = class_dfs();
        if let (Some(&i), Some(&span)) = (dfs.index.get(&c), dfs.span.get(&c)) {
            return format!("(g_typed_slow & TS_TYPED_SLOW_ANY) && ts_typed_outside({}, {}u, {}u)", obj, i + 1, span);
        }
    }
    typed_slow_guard(obj)
}

/// The foreign-receiver flag guards (docs/foreign_receivers_design.md);
/// TSAOT_TYPED_SLOW=0 keeps the frozen emitter's Proxy-only test.
fn typed_slow_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_TYPED_SLOW").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

thread_local! {
    static CLOSED_RECEIVERS: std::cell::Cell<bool> = std::cell::Cell::new(false);
}

/// docs/closed_receivers_design.md: a program the exporter found closed never
/// raises g_typed_slow (nor makes a Proxy), so the flag's test is false for the
/// whole run. TSAOT_CLOSED_RECEIVERS=0 keeps the test.
fn set_closed_receivers(closed: bool) {
    let off = matches!(
        std::env::var("TSAOT_CLOSED_RECEIVERS").as_deref(),
        Ok("0") | Ok("false") | Ok("no") | Ok("off")
    );
    CLOSED_RECEIVERS.with(|c| c.set(closed && !off));
}

/// The test of `g_class_relinked` a class-interval dispatch adds (" && !g_class_relinked"),
/// or nothing in a closed program, which never relinks a prototype
/// (docs/closed_receivers_design.md): one global load less per kind test.
fn relink_guard() -> &'static str {
    if closed_receivers() { "" } else { " && !g_class_relinked" }
}

fn closed_receivers() -> bool {
    CLOSED_RECEIVERS.with(|c| c.get())
}

thread_local! {
    /// Instance methods and accessors of classes with struct fields: function
    /// id -> class id (`method_this_check`).
    static METHOD_CLASS: std::cell::RefCell<BTreeMap<u32, u32>> = std::cell::RefCell::new(BTreeMap::new());
}

fn set_method_classes(program: &Program) {
    let classes: BTreeMap<u32, &ClassDef> = program.classes.iter().map(|c| (c.id.0, c)).collect();
    let mut m = BTreeMap::new();
    for c in &program.classes {
        let mut sized = false;
        let mut cur = Some(c.id.0);
        while let Some(id) = cur {
            let Some(cd) = classes.get(&id) else { break };
            if !cd.own_fields.is_empty() {
                sized = true;
                break;
            }
            cur = cd.parent.map(|p| p.0);
        }
        if sized {
            for meth in &c.own_methods {
                m.insert(meth.func.0, c.id.0);
            }
        }
    }
    METHOD_CLASS.with(|x| *x.borrow_mut() = m);
}

/// A class method's entry in an open program (docs/closed_receivers_design.md,
/// slice 2): once a method may run with a foreign `this` (TS_TYPED_SLOW_THIS
/// alone), a receiver outside the method's class interval raises ANY, so the
/// typed accesses it reaches (`this`'s, and those it is passed on to) test
/// their receivers from then on. `this` is the C expression of the receiver.
fn method_this_check(f: &Function, this: &str) -> String {
    if closed_receivers() || !typed_slow_enabled() || !class_index_enabled() || !f.takes_this {
        return String::new();
    }
    let Some(c) = METHOD_CLASS.with(|m| m.borrow().get(&f.id.0).copied()) else {
        return String::new();
    };
    let dfs = class_dfs();
    let (Some(&i), Some(&span)) = (dfs.index.get(&c), dfs.span.get(&c)) else {
        return String::new();
    };
    format!(
        "  if (TS_RT_UNLIKELY(g_typed_slow == TS_TYPED_SLOW_THIS) && ts_typed_outside({}, {}u, {}u)) ts_foreign_this_seen();\n",
        this,
        i + 1,
        span
    )
}

fn typed_slow_guard(obj: &str) -> String {
    if closed_receivers() {
        "0".to_string()
    } else if typed_slow_enabled() {
        format!("(g_typed_slow & TS_TYPED_SLOW_ANY) && ts_typed_slow({})", obj)
    } else {
        format!("g_has_proxies && ts_is_proxy({})", obj)
    }
}

/// The program's own prototype relink (it may put a class with struct fields
/// behind an object without the layout); the frozen emitter's ts_set_proto
/// under TSAOT_TYPED_SLOW=0.
fn user_set_proto_fn() -> &'static str {
    if typed_slow_enabled() {
        "ts_set_proto_user"
    } else {
        "ts_set_proto"
    }
}

/// The IR locals of numeric type (RefKind::Primitive).
fn prim_kind_locals(f: &Function) -> BTreeSet<u32> {
    f.locals.iter().filter(|l| matches!(l.ref_kind, RefKind::Primitive)).map(|l| l.id.0).collect()
}

/// `a + b` with both operands numeric by type but one of them boxed (a
/// maybe-undefined or nullable numeric, e.g. `sum + (s?.length ?? 0)`): the
/// numeric addition with ToNumber of the boxed side (undefined -> NaN, as `+`
/// gives) instead of the generic ts_add. TSAOT_PRIM_ADD=0 keeps ts_add (the
/// frozen emitter's output).
fn prim_add_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(std::env::var("TSAOT_PRIM_ADD").as_deref(), Ok("0") | Ok("false") | Ok("no") | Ok("off"))
    })
}

/// TSAOT_STACK_CHECK=1: every `Stack` allocation goes to the runtime's
/// quarantine and dies with its activation (docs/stack_check_design.md); the
/// generated C must be compiled with -DTSAOT_STACK_CHECK.
fn stack_check_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        matches!(std::env::var("TSAOT_STACK_CHECK").as_deref(), Ok("1") | Ok("true") | Ok("yes") | Ok("on"))
    })
}

/// Function-scope declarations of the stack cells of a body: the `ts_func`
/// (and environment array) of every closure site with the `Stack` strategy
/// and the struct of every class-instance site with it. Declared in the
/// prologue, not at the site, so a value created inside an `if` block and
/// read after it does not dangle (the `Stack` strategy bounds the lifetime
/// by the frame, not by the C block).
fn emit_stack_cell_decls(s: &mut String, body: &[Inst], strat: &BTreeMap<u32, AllocStrategy>) {
    if stack_check_enabled() {
        // the cells live in the quarantine; the activation scopes them
        let mut flat: Vec<&Inst> = Vec::new();
        flatten_inst(body, &mut flat);
        let any_stack = flat.iter().any(|inst| match inst {
            Inst::AllocClosure { site, .. } | Inst::AllocObject { site, class_id: Some(_), .. } => {
                strat.get(&site.0) == Some(&AllocStrategy::Stack)
            }
            _ => false,
        });
        if any_stack {
            s.push_str("  TS_SC_ACTIVATION;\n");
        }
        return;
    }
    if !stack_closures_enabled() {
        return;
    }
    let mut flat: Vec<&Inst> = Vec::new();
    flatten_inst(body, &mut flat);
    for inst in &flat {
        match inst {
            Inst::AllocClosure {
                dst,
                captures,
                site,
                ..
            } if strat.get(&site.0) == Some(&AllocStrategy::Stack) => {
                let _ = writeln!(s, "  ts_func sfn{};", dst.0);
                if !captures.is_empty() {
                    let _ = writeln!(s, "  tsv senv{}[{}];", dst.0, captures.len());
                }
            }
            Inst::AllocObject {
                dst,
                site,
                class_id: Some(c),
                ..
            } if strat.get(&site.0) == Some(&AllocStrategy::Stack) => {
                let _ = writeln!(s, "  {} sobj{};", struct_name(c.0), dst.0);
            }
            _ => {}
        }
    }
}

fn value_call_fast_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_VALUE_CALL_FAST").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

fn truthy_unbox_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_TRUTHY_UNBOX").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

fn truthy_only_unbox(body: &[Inst], numeric: &BTreeSet<u32>) -> BTreeSet<u32> {
    let mut kept: BTreeSet<u32> = BTreeSet::new();
    if !truthy_unbox_enabled() {
        return kept;
    }
    let mut flat: Vec<&Inst> = Vec::new();
    flatten_inst(body, &mut flat);
    // definitions: Some(copy source) for a Copy, None for a comparison or `!`
    let mut defs: BTreeMap<u32, Vec<Option<u32>>> = BTreeMap::new();
    let mut other_def: BTreeSet<u32> = BTreeSet::new();
    let mut total: BTreeMap<u32, u32> = BTreeMap::new();
    let mut truthy: BTreeMap<u32, u32> = BTreeMap::new();
    let mut copies: BTreeMap<u32, Vec<u32>> = BTreeMap::new(); // src -> copy dsts
    for inst in &flat {
        match inst {
            Inst::If { cond, .. } | Inst::Loop { cond, .. } => {
                *total.entry(cond.0).or_insert(0) += 1;
                *truthy.entry(cond.0).or_insert(0) += 1;
                continue;
            }
            Inst::TryCatch { .. } => continue,
            _ => {}
        }
        let def = inst_def(inst);
        match inst {
            Inst::BinOp { dst, op, .. }
                if matches!(
                    op.as_str(),
                    "<" | "<=" | ">" | ">=" | "==" | "!=" | "===" | "!=="
                ) =>
            {
                defs.entry(dst.0).or_default().push(None);
            }
            Inst::UnOp { dst, op, .. } if op == "!" => {
                defs.entry(dst.0).or_default().push(None);
            }
            // a boolean constant is a raw 0/1 as well (the `first` flag of a
            // `for` loop with an update clause, `let done = false`)
            Inst::Const {
                dst,
                value: ConstVal::Bool { .. },
            } => {
                defs.entry(dst.0).or_default().push(None);
            }
            // the raw boolean result of a direct entry (direct_return_kind)
            Inst::Call {
                dst: Some(dst),
                callee: CalleeRef::Direct { func },
                ..
            } if is_bool_callee(func.0) => {
                defs.entry(dst.0).or_default().push(None);
            }
            Inst::Copy { dst, src } => {
                defs.entry(dst.0).or_default().push(Some(src.0));
                copies.entry(src.0).or_default().push(dst.0);
            }
            _ => {
                if let Some(d) = def {
                    other_def.insert(d);
                }
            }
        }
        let mut seen: BTreeSet<u32> = BTreeSet::new();
        for r in inst_refs(inst) {
            if Some(r) == def || !seen.insert(r) {
                continue;
            }
            *total.entry(r).or_insert(0) += 1;
            if matches!(inst, Inst::UnOp { op, .. } if op == "!") {
                *truthy.entry(r).or_insert(0) += 1;
            }
        }
    }
    for (id, dl) in &defs {
        if !other_def.contains(id) && !dl.is_empty() {
            kept.insert(*id);
        }
    }
    loop {
        let mut drop: Vec<u32> = Vec::new();
        for &c in &kept {
            let defs_ok = defs[&c]
                .iter()
                .all(|d| d.map_or(true, |src| numeric.contains(&src) || kept.contains(&src)));
            let into_kept = copies
                .get(&c)
                .map_or(0, |ds| ds.iter().filter(|d| kept.contains(d)).count() as u32);
            let tot = total.get(&c).copied().unwrap_or(0);
            let tru = truthy.get(&c).copied().unwrap_or(0);
            if !defs_ok || tot == 0 || tot != tru + into_kept {
                drop.push(c);
            }
        }
        if drop.is_empty() {
            break;
        }
        for c in drop {
            kept.remove(&c);
        }
    }
    kept
}

fn collect_local_class(body: &[Inst], out: &mut BTreeMap<u32, u32>) {
    for inst in body {
        match inst {
            Inst::AllocObject {
                dst,
                class_id: Some(c),
                ..
            } => {
                out.insert(dst.0, c.0);
            }
            Inst::Copy { dst, src } => {
                if let Some(&c) = out.get(&src.0) {
                    out.insert(dst.0, c);
                }
            }
            Inst::Loop {
                cond_body, body, ..
            } => {
                collect_local_class(cond_body, out);
                collect_local_class(body, out);
            }
            Inst::If {
                then_body,
                else_body,
                ..
            } => {
                collect_local_class(then_body, out);
                collect_local_class(else_body, out);
            }
            Inst::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                collect_local_class(try_body, out);
                collect_local_class(catch_body, out);
                collect_local_class(finally_body, out);
            }
            _ => {}
        }
    }
}

/// Locals that ever hold a non-numeric value (undef/null/bool/string const, or a
/// typeof result) cannot use the unboxed `double` representation; keep them boxed
/// `tsv`. Propagates through copies.
fn collect_non_numeric_consts(body: &[Inst], out: &mut BTreeSet<u32>) {
    for inst in body {
        match inst {
            Inst::Const { dst, value } => {
                // NaN / ±Infinity are numeric (unboxable doubles) like Num.
                let numeric = matches!(
                    value,
                    ConstVal::Num { .. }
                        | ConstVal::NaN
                        | ConstVal::PosInf
                        | ConstVal::NegInf
                        | ConstVal::NegZero
                );
                if !numeric {
                    out.insert(dst.0);
                }
            }
            Inst::UnOp { dst, op, .. } if op == "typeof" => {
                out.insert(dst.0);
            }
            // operand of a nullish/default-param undefined test must stay boxed
            // to observe undefined/null instead of a raw numeric payload.
            Inst::UnOp { operand, op, .. } if op == "nullish" || op == "isundef" => {
                out.insert(operand.0);
            }
            Inst::Copy { dst, src } => {
                if out.contains(&src.0) {
                    out.insert(dst.0);
                }
            }
            Inst::Loop {
                cond_body, body, ..
            } => {
                collect_non_numeric_consts(cond_body, out);
                collect_non_numeric_consts(body, out);
            }
            Inst::If {
                then_body,
                else_body,
                ..
            } => {
                collect_non_numeric_consts(then_body, out);
                collect_non_numeric_consts(else_body, out);
            }
            Inst::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                collect_non_numeric_consts(try_body, out);
                collect_non_numeric_consts(catch_body, out);
                collect_non_numeric_consts(finally_body, out);
            }
            _ => {}
        }
    }
}

/// Is (class `c`, field `field`) a monomorphized numeric (unboxed double) field?
/// The struct slot is the one of the topmost ancestor that declares the field
/// (`emit_field_chain` emits parents first and skips a redeclaration), so its
/// `field_types` entry decides, not a subclass's that redeclares the field (a
/// constructor assigning an inherited field): reading that slot by the
/// subclass's type took a boxed slot for a double.
/// TSAOT_INT_FIELDS=0 keeps an int32-tagged field a double (A/B; the oracle
/// never sees the tag: it exports without the strict profile).
fn int_fields_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_INT_FIELDS").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// Is (class `c`, field `field`) an integer slot (`long long`, holding an
/// int32: an enum-typed field, docs/int32_fields_design.md)? The declaring
/// ancestor's tag decides, as for `numeric_field`.
fn int32_field(c: u32, field: u32, classes: &BTreeMap<u32, &ClassDef>) -> bool {
    if !int_fields_enabled() {
        return false;
    }
    let mut decision = false;
    let mut cur = Some(c);
    while let Some(id) = cur {
        let Some(cd) = classes.get(&id) else { break };
        if cd.own_fields.iter().any(|f| f.0 == field) {
            decision = cd
                .field_types
                .get(&field.to_string())
                .map(|t| t == "int32")
                .unwrap_or(false);
        }
        cur = cd.parent.map(|p| p.0);
    }
    decision
}

fn numeric_field(c: u32, field: u32, classes: &BTreeMap<u32, &ClassDef>) -> bool {
    let mut decision = false;
    let mut cur = Some(c);
    while let Some(id) = cur {
        let Some(cd) = classes.get(&id) else { break };
        if cd.own_fields.iter().any(|f| f.0 == field) {
            decision = cd
                .field_types
                .get(&field.to_string())
                .map(|t| t == "number" || t == "int32")
                .unwrap_or(false);
        }
        cur = cd.parent.map(|p| p.0);
    }
    decision
}

/// The runtime property key (as a C expression) for a method-name id: a
/// well-known symbol method (`[Symbol.iterator]` etc.) uses its stable WKSYM key,
/// otherwise the ordinary method-key space. Single place that picks the encoding.
fn method_key_str(name_id: u32, wksym: &BTreeMap<u32, u32>) -> String {
    match wksym.get(&name_id) {
        Some(&w) => format!("TS_KEY_WKSYM({}u)", w),
        None => format!("TS_KEY_METHOD({}u)", name_id),
    }
}

fn c_bytes_lit(bytes: &[u8]) -> String {
    let mut esc = String::new();
    for &b in bytes {
        match b {
            b'\\' => esc.push_str("\\\\"),
            b'"' => esc.push_str("\\\""),
            b'\n' => esc.push_str("\\n"),
            b'\r' => esc.push_str("\\r"),
            b'\t' => esc.push_str("\\t"),
            0x20..=0x7e => esc.push(b as char),
            _ => esc.push_str(&format!("\\{:03o}", b)),
        }
    }
    format!("\"{}\"", esc)
}

fn c_string_lit(v: &str) -> String {
    c_bytes_lit(v.as_bytes())
}

fn str_units(v: &str) -> Vec<u16> {
    v.encode_utf16().collect()
}

fn field_name_units(f: &FieldInfo) -> Vec<u16> {
    if let Some(name) = &f.name {
        str_units(name)
    } else {
        f.name_units.clone()
    }
}

fn method_prop_name_units(m: &MethodDef) -> Option<Vec<u16>> {
    if let Some(name) = &m.prop_name {
        Some(str_units(name))
    } else if !m.prop_name_units.is_empty() {
        Some(m.prop_name_units.clone())
    } else {
        None
    }
}

fn utf8_bytes_for_cp(cp: u32, out: &mut Vec<u8>) {
    if cp < 0x80 {
        out.push(cp as u8);
    } else if cp < 0x800 {
        out.push((0xc0 | (cp >> 6)) as u8);
        out.push((0x80 | (cp & 0x3f)) as u8);
    } else if cp < 0x10000 {
        out.push((0xe0 | (cp >> 12)) as u8);
        out.push((0x80 | ((cp >> 6) & 0x3f)) as u8);
        out.push((0x80 | (cp & 0x3f)) as u8);
    } else {
        out.push((0xf0 | (cp >> 18)) as u8);
        out.push((0x80 | ((cp >> 12) & 0x3f)) as u8);
        out.push((0x80 | ((cp >> 6) & 0x3f)) as u8);
        out.push((0x80 | (cp & 0x3f)) as u8);
    }
}

fn field_key_bytes_from_units(units: &[u16]) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut i = 0;
    while i < units.len() {
        let mut cp = units[i] as u32;
        if (0xd800..=0xdbff).contains(&units[i]) && i + 1 < units.len() {
            let lo = units[i + 1];
            if (0xdc00..=0xdfff).contains(&lo) {
                cp = 0x10000 + ((((units[i] as u32) - 0xd800) << 10) | ((lo as u32) - 0xdc00));
                i += 1;
            }
        }
        utf8_bytes_for_cp(cp, &mut bytes);
        i += 1;
    }
    bytes
}

fn c_strhash_units(units: &[u16]) -> u32 {
    let mut h: u32 = 2_166_136_261;
    for &cu in units {
        h ^= (cu & 0xff) as u32;
        h = h.wrapping_mul(16_777_619);
        h ^= (cu >> 8) as u32;
        h = h.wrapping_mul(16_777_619);
    }
    h
}

fn c_strflags_expr_units(units: &[u16], is_static: bool) -> String {
    let mut parts = vec!["TS_STR_FLAG_HASHED"];
    if units.iter().all(|&u| u < 0x80) {
        parts.push("TS_STR_FLAG_ASCII");
    }
    if units.iter().any(|&u| u > 0xff) {
        parts.push("TS_STR_FLAG_UTF16");
    }
    if is_static {
        parts.push("TS_STR_FLAG_STATIC");
    }
    if parts.is_empty() {
        "0".to_string()
    } else {
        parts.join(" | ")
    }
}

fn c_string_storage_bytes_units(units: &[u16]) -> (usize, Vec<u8>) {
    let utf16 = units.iter().any(|&u| u > 0xff);
    let mut bytes = Vec::new();
    if utf16 {
        for &u in units {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        bytes.extend_from_slice(&[0, 0]);
    } else {
        for &u in units {
            bytes.push((u & 0xff) as u8);
        }
        bytes.push(0);
    }
    (units.len(), bytes)
}

fn c_byte_array_lit(bytes: &[u8]) -> String {
    let mut out = String::from("{");
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 {
            out.push_str(", ");
        }
        let _ = write!(out, "{}", b);
    }
    out.push('}');
    out
}

fn collect_static_string_literals(program: &Program) -> BTreeMap<Vec<u16>, usize> {
    fn walk(body: &[Inst], out: &mut BTreeSet<Vec<u16>>) {
        for inst in body {
            match inst {
                Inst::Const {
                    value: ConstVal::Str { value },
                    ..
                } => {
                    out.insert(str_units(value));
                }
                Inst::Const {
                    value: ConstVal::Str16 { units },
                    ..
                } => {
                    out.insert(units.clone());
                }
                Inst::Loop {
                    cond_body, body, ..
                } => {
                    walk(cond_body, out);
                    walk(body, out);
                }
                Inst::If {
                    then_body,
                    else_body,
                    ..
                } => {
                    walk(then_body, out);
                    walk(else_body, out);
                }
                Inst::TryCatch {
                    try_body,
                    catch_body,
                    finally_body,
                    ..
                } => {
                    walk(try_body, out);
                    walk(catch_body, out);
                    walk(finally_body, out);
                }
                _ => {}
            }
        }
    }

    let mut values = BTreeSet::new();
    for f in &program.functions {
        walk(&f.body, &mut values);
    }
    values
        .into_iter()
        .enumerate()
        .map(|(id, value)| (value, id))
        .collect()
}

fn emit_static_string_literals(s: &mut String, literals: &BTreeMap<Vec<u16>, usize>) {
    if literals.is_empty() {
        return;
    }
    s.push_str("/* static TS string literals: non-heap, immutable flat strings */\n");
    for (units, id) in literals {
        let (len, storage) = c_string_storage_bytes_units(units);
        let _ = writeln!(
            s,
            "static struct {{ ts_gc_header h; uint32_t len, hash, flags; tsv parent; uint32_t offset; char data[{}]; }} TS_STRLIT_{} = {{ {{ TS_KIND_STRING, 0, TS_GEN_NONHEAP, 0, 0 }}, {}u, {}u, {}, TS_UNDEFINED, 0u, {} }};",
            storage.len(),
            id,
            len,
            c_strhash_units(units),
            c_strflags_expr_units(units, true),
            c_byte_array_lit(&storage)
        );
    }
    s.push('\n');
}

fn field_key_units(units: &[u16]) -> String {
    let bytes = field_key_bytes_from_units(units);
    format!("ts_intern_field({}, {})", c_bytes_lit(&bytes), bytes.len())
}

fn field_key_str(name: &str) -> String {
    field_key_units(&str_units(name))
}

/// Emit the dynamic method-value lookup into `_mv`, honoring JS own->prototype
/// order: try the OWN property (field-key) first when a field-key id is known
/// (so an own data/method property or object-literal method shadows a prototype
/// method), then fall back to the prototype method-key. Without a field-key id
/// (legacy), only the method-key is tried.
fn emit_method_value_lookup(
    s: &mut String,
    recv_expr: &str,
    method_id: u32,
    method_field: Option<u32>,
    wksym: &BTreeMap<u32, u32>,
) {
    // Reading `recv.method` off null/undefined is a property-read TypeError
    // ("Cannot read properties of null (reading 'name')"), thrown before any
    // lookup. The field-key id (when known) carries the method name for the
    // message and for the "<name> is not a function" case below.
    let name_field = method_field.unwrap_or(0);
    let _ = writeln!(s, "    ts_check_method_recv({}, {}u);", recv_expr, name_field);
    match method_field {
        Some(fid) => {
            if prop_pic_enabled() {
                s.push_str("    static ts_prop_ic _ts_method_field_ic = TS_PROP_IC_INIT;\n");
                s.push_str("    static ts_prop_ic _ts_method_proto_ic = TS_PROP_IC_INIT;\n");
                let _ = writeln!(s, "    tsv _mv = ts_get_pic_checked_inline({}, {}u, &_ts_method_field_ic);", recv_expr, fid);
                let _ = writeln!(s, "    if (!ts_is_callable(_mv)) _mv = ts_get_pic_checked_inline({}, {}, &_ts_method_proto_ic);", recv_expr, method_key_str(method_id, wksym));
            } else {
                let _ = writeln!(s, "    tsv _mv = ts_get({}, {}u);", recv_expr, fid);
                let _ = writeln!(
                    s,
                    "    if (!ts_is_callable(_mv)) _mv = ts_get({}, {});",
                    recv_expr,
                    method_key_str(method_id, wksym)
                );
            }
        }
        None => {
            if prop_pic_enabled() {
                s.push_str("    static ts_prop_ic _ts_method_proto_ic = TS_PROP_IC_INIT;\n");
                let _ = writeln!(s, "    tsv _mv = ts_get_pic_checked_inline({}, {}, &_ts_method_proto_ic);", recv_expr, method_key_str(method_id, wksym));
            } else {
                let _ = writeln!(
                    s,
                    "    tsv _mv = ts_get({}, {});",
                    recv_expr,
                    method_key_str(method_id, wksym)
                );
            }
        }
    }
    let _ = writeln!(
        s,
        "    if (!ts_is_callable(_mv)) ts_dynamic_method_missing({}u);",
        name_field
    );
}

fn field_path(c: u32, field: u32, classes: &BTreeMap<u32, &ClassDef>) -> Option<String> {
    fn has(c: u32, field: u32, classes: &BTreeMap<u32, &ClassDef>) -> bool {
        if let Some(cd) = classes.get(&c) {
            if cd.own_fields.iter().any(|f| f.0 == field) {
                return true;
            }
            if let Some(p) = cd.parent {
                return has(p.0, field, classes);
            }
        }
        false
    }
    if has(c, field, classes) {
        Some(format!("f{}", field))
    } else {
        None
    }
}

/// Stage-B firing condition for reading/writing a field as a typed struct slot
/// (`->fN`) instead of the canonical property path (property_model_redesign §3.3).
/// Returns the struct offset string ONLY when it is provably sound:
///   - the receiver's class `c` is statically known (caller passes local_class), AND
///   - that class (and the class owning the field along the chain) is STABLE, i.e.
///     not prototype-mutated / not dynamically reshaped, so the field is guaranteed
///     to be a fixed data slot (never an accessor or proto override at runtime), AND
///   - the field resolves to a struct slot via field_path.
/// When unstable, we fall back to ts_get/ts_set, which now read/write the struct
/// field via the class descriptor anyway (A-2b), so behavior stays correct.
fn struct_direct_offset(c: u32, field: u32, classes: &BTreeMap<u32, &ClassDef>) -> Option<String> {
    if !classes.get(&c).map(|cd| cd.stable).unwrap_or(false) {
        return None;
    }
    field_path(c, field, classes)
}

/// Does this instruction list contain an Await nested inside a control-flow
/// construct (If/Loop/TryCatch)? v1 only supports top-level awaits, so a nested
/// await is rejected loudly by the exporter; this is a defensive codegen check.
fn await_nested(body: &[Inst]) -> bool {
    fn has_await(b: &[Inst]) -> bool {
        b.iter().any(|i| matches!(i, Inst::Await { .. }))
    }
    for inst in body {
        match inst {
            Inst::If {
                then_body,
                else_body,
                ..
            } => {
                if has_await(then_body)
                    || has_await(else_body)
                    || await_nested(then_body)
                    || await_nested(else_body)
                {
                    return true;
                }
            }
            Inst::Loop {
                cond_body, body, ..
            } => {
                if has_await(cond_body)
                    || has_await(body)
                    || await_nested(cond_body)
                    || await_nested(body)
                {
                    return true;
                }
            }
            Inst::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                if has_await(try_body)
                    || has_await(catch_body)
                    || has_await(finally_body)
                    || await_nested(try_body)
                    || await_nested(catch_body)
                    || await_nested(finally_body)
                {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

/// Async function -> state machine + coroutine frame.
/// Frame holds all locals (so they survive suspension). The body is split at
/// each top-level `Await` into states; each `await` parks the frame on the
/// awaited promise and returns to the scheduler, resuming at the next state.
/// Flat (goto-based) op for the general state-machine builder. Structured
/// control flow (If/Loop/Break/Continue) in async/generator bodies is flattened
/// into these so a `switch(state)` can `goto` to any resume point — letting
/// await/yield appear inside loops and conditionals.
enum Flat<'a> {
    Inst(&'a Inst),           // a leaf instruction emitted verbatim via emit_inst
    Label(u32),               // a jump target: `L<id>:`
    Goto(u32),                // `goto L<id>;`
    GotoIfFalse(u32, u32),    // `if (!truthy(cond)) goto L<id>;`  (cond_local, label)
    Suspend(&'a Inst),        // an Await or Yield (handled by the caller's emitter)
    Ret(&'a Option<LocalId>), // a Return (handled by the caller's emitter)
    // leave `n` coroutine try levels (pop their handlers) before a goto that
    // crosses them (break/continue out of a suspending try).
    TryLeave(u32),
    // try/catch that spans a suspension (coroutine EH). Carries label ids for the
    // catch entry and the after-try join, plus the catch variable.
    TryEnter {
        catch_label: u32,
    },
    TryNormalExit {
        after_label: u32,
    }, // end of try body reached without throw
    InCoroThrow {
        src: LocalId,
    }, // an explicit `throw` inside the coro try
    CatchLabel {
        catch_label: u32,
        catch_var: &'a Option<LocalId>,
    },
    AfterLabel {
        after_label: u32,
    },
    // finally support. FinallyEnterTry installs a handler whose catch target is the
    // finally block (capturing in-flight exceptions for re-throw after finally).
    FinallyEnterTry {
        fin_catch_label: u32,
    },
    // record "normal completion" then jump to the finally body.
    FinallyGotoNormal {
        fin_label: u32,
    },
    // the finally landing pad reached via the exception path: mark pending-throw.
    FinallyCatchLabel {
        fin_catch_label: u32,
        fin_label: u32,
    },
    // the shared finally body label.
    FinallyLabel {
        fin_label: u32,
    },
    // after the finally body: re-throw if pending, else fall through to after.
    FinallyDispatch {
        after_label: u32,
        outer_fin: Option<u32>,
    },
    // an abrupt completion (return/break/continue) occurring inside a finally
    // region: set the innermost finally's pending record then jump to it.
    // kind: 2 return, 3 break, 4 continue. For return, `value` is the source local.
    // For break/continue, `target` is the loop end/top label to resume after finally.
    FinallyAbrupt {
        kind: u8,
        value: Option<LocalId>,
        target: u32,
        fin_label: u32,
    },
}

/// Flatten a structured async/generator body into a flat goto stream.
/// `loops` is the stack of (top_label, end_label) for the enclosing loops, used
/// to resolve Break/Continue. `next_label` hands out fresh label ids.
/// A finally region active during flattening (innermost = last). `loops_at_entry`
/// is the loop-stack depth when the region's protected body began, so a
/// break/continue can tell whether its target loop is inside (plain goto) or
/// outside (must route through this finally) the region.
struct FinFrame {
    fin_label: u32,
    loops_at_entry: usize,
    // coroutine handler depth inside the finally's protected region (its own
    // handler included): an abrupt completion from deeper nested tries pops the
    // extra levels before jumping to the finally body.
    try_depth_at_entry: u32,
}

/// Emit the handler pops for leaving coroutine try levels `cur` -> `target`
/// (none under the frozen emission knob, which left them dangling).
fn push_try_leave(out: &mut Vec<Flat<'_>>, cur: u32, target: u32) {
    if eh_return_pop_enabled() && cur > target {
        out.push(Flat::TryLeave(cur - target));
    }
}

/// True when a break/continue in `body` targets a loop outside `body`
/// (`depth` = loops opened inside `body` around the current position).
fn body_escapes_loop(body: &[Inst], depth: u32) -> bool {
    body.iter().any(|i| match i {
        Inst::Break { up } | Inst::Continue { up } => *up >= depth,
        Inst::If {
            then_body,
            else_body,
            ..
        } => body_escapes_loop(then_body, depth) || body_escapes_loop(else_body, depth),
        Inst::Loop {
            cond_body, body, ..
        } => body_escapes_loop(cond_body, depth + 1) || body_escapes_loop(body, depth + 1),
        Inst::TryCatch {
            try_body,
            catch_body,
            finally_body,
            ..
        } => {
            body_escapes_loop(try_body, depth)
                || body_escapes_loop(catch_body, depth)
                || body_escapes_loop(finally_body, depth)
        }
        _ => false,
    })
}

/// `loops`: (top label, end label, coroutine try depth at loop entry).
/// `try_depth`: number of coroutine handler levels active at this point.
fn flatten_cf<'a>(
    body: &'a [Inst],
    out: &mut Vec<Flat<'a>>,
    loops: &mut Vec<(u32, u32, u32)>,
    fins: &mut Vec<FinFrame>,
    next_label: &mut u32,
    try_depth: u32,
) -> Result<(), String> {
    let fresh = |nl: &mut u32| {
        let id = *nl;
        *nl += 1;
        id
    };
    for inst in body {
        match inst {
            Inst::If {
                cond,
                then_body,
                else_body,
            } => {
                let l_else = fresh(next_label);
                let l_end = fresh(next_label);
                out.push(Flat::GotoIfFalse(cond.0, l_else));
                flatten_cf(then_body, out, loops, fins, next_label, try_depth)?;
                out.push(Flat::Goto(l_end));
                out.push(Flat::Label(l_else));
                flatten_cf(else_body, out, loops, fins, next_label, try_depth)?;
                out.push(Flat::Label(l_end));
            }
            Inst::Loop {
                cond,
                cond_body,
                body: lbody,
            } => {
                let l_top = fresh(next_label);
                let l_end = fresh(next_label);
                out.push(Flat::Label(l_top));
                flatten_cf(cond_body, out, loops, fins, next_label, try_depth)?;
                out.push(Flat::GotoIfFalse(cond.0, l_end));
                loops.push((l_top, l_end, try_depth));
                flatten_cf(lbody, out, loops, fins, next_label, try_depth)?;
                loops.pop();
                out.push(Flat::Goto(l_top));
                out.push(Flat::Label(l_end));
            }
            Inst::Break { up } => {
                // `up` levels out (0 = innermost). The exporter rejects up>=1 inside
                // any try/finally, so the finally branch only fires for up==0.
                let idx = loops
                    .len()
                    .checked_sub(1 + *up as usize)
                    .ok_or("break target outside loop in async/generator")?;
                let (_, end, loop_depth) = loops[idx];
                if let Some(f) = fins.last() {
                    if idx < f.loops_at_entry {
                        push_try_leave(out, try_depth, f.try_depth_at_entry);
                        out.push(Flat::FinallyAbrupt {
                            kind: 3,
                            value: None,
                            target: end,
                            fin_label: f.fin_label,
                        });
                        continue;
                    }
                }
                push_try_leave(out, try_depth, loop_depth);
                out.push(Flat::Goto(end));
            }
            Inst::Continue { up } => {
                let idx = loops
                    .len()
                    .checked_sub(1 + *up as usize)
                    .ok_or("continue target outside loop in async/generator")?;
                let (top, _, loop_depth) = loops[idx];
                if let Some(f) = fins.last() {
                    if idx < f.loops_at_entry {
                        push_try_leave(out, try_depth, f.try_depth_at_entry);
                        out.push(Flat::FinallyAbrupt {
                            kind: 4,
                            value: None,
                            target: top,
                            fin_label: f.fin_label,
                        });
                        continue;
                    }
                }
                push_try_leave(out, try_depth, loop_depth);
                out.push(Flat::Goto(top));
            }
            Inst::Await { .. } | Inst::Yield { .. } => out.push(Flat::Suspend(inst)),
            Inst::Return { src } => {
                // a return inside a finally region must run the finally(s) first.
                if let Some(f) = fins.last() {
                    push_try_leave(out, try_depth, f.try_depth_at_entry);
                    out.push(Flat::FinallyAbrupt {
                        kind: 2,
                        value: *src,
                        target: 0,
                        fin_label: f.fin_label,
                    });
                } else {
                    out.push(Flat::Ret(src));
                }
            }
            Inst::Throw { src } => {
                // If a coroutine try is active in the flat stream, route to its
                // catch via the dispatch; otherwise (no enclosing coro try here)
                // a plain ts_throw goes to the global handler. We can't know the
                // enclosing-try status locally, so InCoroThrow's emitter checks
                // _fr->c.eh_active at runtime and falls back to ts_throw.
                out.push(Flat::InCoroThrow { src: *src });
            }
            Inst::TryCatch {
                try_body,
                catch_var,
                catch_body,
                finally_body,
            } => {
                if !body_has_suspension(try_body)
                    && !body_has_suspension(catch_body)
                    && !body_has_suspension(finally_body)
                    && !(eh_return_pop_enabled()
                        && (body_has_return(try_body)
                            || body_has_return(catch_body)
                            || body_has_return(finally_body)
                            || body_escapes_loop(try_body, 0)
                            || body_escapes_loop(catch_body, 0)
                            || body_escapes_loop(finally_body, 0)))
                {
                    // No suspension anywhere in this try: keep it structured (emit_inst
                    // uses inline setjmp/longjmp, which is safe here). A `return`
                    // inside it must still complete the coroutine (resolve the
                    // promise / finish the generator) and pop the handlers, which
                    // only the flat lowering's Ret does, so such tries take the flat
                    // path (the frozen emitter emitted a raw C return there). The
                    // same goes for a break/continue leaving the try: the enclosing
                    // loop is flattened, so a structured C break has no target.
                    out.push(Flat::Inst(inst));
                    continue;
                }
                if !finally_body.is_empty() {
                    // finally with a suspension: use the finally-aware lowering, then
                    // continue flattening the rest of this body.
                    flatten_try_finally(
                        try_body,
                        catch_var,
                        catch_body,
                        finally_body,
                        out,
                        loops,
                        fins,
                        next_label,
                        try_depth,
                    )?;
                    continue;
                }
                // try { ...suspend... } catch (e) { ...maybe suspend... } (no finally)
                let catch_label = {
                    let id = *next_label;
                    *next_label += 1;
                    id
                };
                let after_label = {
                    let id = *next_label;
                    *next_label += 1;
                    id
                };
                out.push(Flat::TryEnter { catch_label });
                flatten_cf(try_body, out, loops, fins, next_label, try_depth + 1)?;
                out.push(Flat::TryNormalExit { after_label });
                out.push(Flat::CatchLabel {
                    catch_label,
                    catch_var,
                });
                // the catch body runs after its own handler was popped.
                flatten_cf(catch_body, out, loops, fins, next_label, try_depth)?;
                out.push(Flat::AfterLabel { after_label });
            }
            other => out.push(Flat::Inst(other)),
        }
    }
    Ok(())
}

/// Does this body contain an await/yield anywhere (including nested control flow)?
/// Flatten a try/catch/finally where a suspension appears somewhere, so the
/// finally block must be a re-enterable shared region (it may itself suspend).
/// Layout:
///   FinallyEnterTry(Lfc)        // handler -> finally-catch (captures throws)
///   [if catch present] TryEnter(Lc)  // inner handler -> user catch
///   <try body>
///   [if catch] TryNormalExit(after=Lcdone) ; CatchLabel(Lc,e) ; <catch> ; Label(Lcdone)
///   FinallyGotoNormal(Lf)       // pop finally handler, pending=normal, goto Lf
///   FinallyCatchLabel(Lfc,Lf)   // exception landing: pending=throw, save exc, goto Lf
///   FinallyLabel(Lf) ; <finally body> ; FinallyDispatch(after)
///   AfterLabel(after)
fn flatten_try_finally<'a>(
    try_body: &'a [Inst],
    catch_var: &'a Option<LocalId>,
    catch_body: &'a [Inst],
    finally_body: &'a [Inst],
    out: &mut Vec<Flat<'a>>,
    loops: &mut Vec<(u32, u32, u32)>,
    fins: &mut Vec<FinFrame>,
    next_label: &mut u32,
    try_depth: u32,
) -> Result<(), String> {
    let mut fresh = || {
        let id = *next_label;
        *next_label += 1;
        id
    };
    let fin_catch_label = fresh();
    let fin_label = fresh();
    let after_label = fresh();
    let has_catch = !catch_body.is_empty() || catch_var.is_some();

    out.push(Flat::FinallyEnterTry { fin_catch_label });
    // while flattening the protected region, this finally is innermost: an
    // abrupt completion (return/break/continue escaping it) routes through it.
    fins.push(FinFrame {
        fin_label,
        loops_at_entry: loops.len(),
        try_depth_at_entry: try_depth + 1,
    });
    if has_catch {
        let catch_label = fresh();
        let catch_done = fresh();
        out.push(Flat::TryEnter { catch_label });
        flatten_cf(try_body, out, loops, fins, next_label, try_depth + 2)?;
        out.push(Flat::TryNormalExit {
            after_label: catch_done,
        });
        out.push(Flat::CatchLabel {
            catch_label,
            catch_var,
        });
        flatten_cf(catch_body, out, loops, fins, next_label, try_depth + 1)?;
        out.push(Flat::AfterLabel {
            after_label: catch_done,
        });
        out.push(Flat::FinallyGotoNormal { fin_label });
    } else {
        flatten_cf(try_body, out, loops, fins, next_label, try_depth + 1)?;
        out.push(Flat::FinallyGotoNormal { fin_label });
    }
    out.push(Flat::FinallyCatchLabel {
        fin_catch_label,
        fin_label,
    });
    // leaving the protected region: the finally body is flattened in the OUTER
    // context (its own abrupt completions route to the next-outer finally).
    fins.pop();
    out.push(Flat::FinallyLabel { fin_label });
    flatten_cf(finally_body, out, loops, fins, next_label, try_depth)?;
    // if this finally is itself nested inside another finally, a non-normal
    // completion propagates to that outer finally; else it executes here.
    let outer_fin = fins.last().map(|f| f.fin_label);
    out.push(Flat::FinallyDispatch {
        after_label,
        outer_fin,
    });
    out.push(Flat::AfterLabel { after_label });
    Ok(())
}

/// True when `body` contains a `Return` at any structured nesting depth
/// (if/loop/try bodies; nested functions are separate IR functions).
fn body_has_return(body: &[Inst]) -> bool {
    body.iter().any(|i| match i {
        Inst::Return { .. } => true,
        Inst::If {
            then_body,
            else_body,
            ..
        } => body_has_return(then_body) || body_has_return(else_body),
        Inst::Loop {
            cond_body, body, ..
        } => body_has_return(cond_body) || body_has_return(body),
        Inst::TryCatch {
            try_body,
            catch_body,
            finally_body,
            ..
        } => {
            body_has_return(try_body)
                || body_has_return(catch_body)
                || body_has_return(finally_body)
        }
        _ => false,
    })
}

fn body_has_suspension(body: &[Inst]) -> bool {
    body.iter().any(|i| match i {
        Inst::Await { .. } | Inst::Yield { .. } => true,
        Inst::If {
            then_body,
            else_body,
            ..
        } => body_has_suspension(then_body) || body_has_suspension(else_body),
        Inst::Loop {
            cond_body, body, ..
        } => body_has_suspension(cond_body) || body_has_suspension(body),
        Inst::TryCatch {
            try_body,
            catch_body,
            finally_body,
            ..
        } => {
            body_has_suspension(try_body)
                || body_has_suspension(catch_body)
                || body_has_suspension(finally_body)
        }
        _ => false,
    })
}

#[derive(Clone, Copy, PartialEq)]
enum SmMode {
    Async,
    Generator,
    AsyncGenerator,
}

impl SmMode {
    /// Modes backed by a Promise: they install the catch-all reject handler and
    /// pop it across suspension points. (Async functions and async generators;
    /// plain generators are not promise-backed.)
    fn is_promise_backed(self) -> bool {
        matches!(self, SmMode::Async | SmMode::AsyncGenerator)
    }
}

/// Emit the resume-function body for an async/generator state machine: flatten
/// the body to gotos, assign a state to each suspension, and emit a dispatch
/// `switch` followed by the flat ops. Falls back nothing — flattening errors
/// (e.g. try/catch across a suspension) are prevented by exporter rejection, but
/// we degrade safely by emitting an abort if they slip through.
/// Emit the mode-specific "complete the coroutine with return value `val`" code:
/// resolve the function's promise (async / async-generator) or mark the generator
/// done. `val` is a C expression for the return value. This is the single source
/// of truth for coroutine completion, shared by the Ret path, the finally-dispatch
/// return path, and the fall-off-end path.
fn emit_completion(s: &mut String, mode: SmMode, val: &str) {
    match mode {
        SmMode::Async => {
            s.push_str("  ts_eh_pop();\n");
            let _ = writeln!(s, "  ts_promise_resolve_v(_fr->c.ret, {});", val);
            s.push_str("  return TS_UNDEFINED;\n");
        }
        SmMode::Generator => {
            let _ = writeln!(s, "  _fr->c.yielded = {};", val);
            s.push_str("  _fr->c.done = 1;\n  return TS_UNDEFINED;\n");
        }
        SmMode::AsyncGenerator => {
            s.push_str("  ts_eh_pop();\n  _fr->c.done = 1;\n");
            let _ = writeln!(
                s,
                "  ts_promise_resolve_v(_fr->c.ret, ts_iter_result({}, 1));",
                val
            );
            s.push_str("  return TS_UNDEFINED;\n");
        }
    }
}

fn emit_sm_resume_body(s: &mut String, f: &Function, ctx: &Ctx, mode: SmMode) {
    let mut flat: Vec<Flat> = Vec::new();
    let mut loops: Vec<(u32, u32, u32)> = Vec::new();
    let mut next_label = 0u32;
    let mut fins: Vec<FinFrame> = Vec::new();
    if let Err(_e) = flatten_cf(&f.body, &mut flat, &mut loops, &mut fins, &mut next_label, 0) {
        // Should be unreachable (exporter rejects unsupported constructs).
        s.push_str("  default: ;\n  }\n  ts_abort_msg(\"unsupported control flow in coroutine\");\n  return TS_UNDEFINED;\n");
        return;
    }

    let mut n_states = 1u32; // state 0
    for fl in &flat {
        if let Flat::Suspend(_) = fl {
            n_states += 1;
        }
    }

    // Collect catch labels of coroutine try/catch regions (for the longjmp
    // dispatch by eh_catch_state).
    let catch_labels: Vec<u32> = flat
        .iter()
        .filter_map(|fl| match fl {
            Flat::CatchLabel { catch_label, .. } => Some(*catch_label),
            Flat::FinallyCatchLabel {
                fin_catch_label, ..
            } => Some(*fin_catch_label),
            _ => None,
        })
        .collect();
    let has_coro_try = !catch_labels.is_empty();
    // all loop labels that a break/continue reaches THROUGH a finally (for the
    // FinallyDispatch goto-switch).
    let fin_targets: Vec<u32> = flat
        .iter()
        .filter_map(|fl| match fl {
            Flat::FinallyAbrupt { kind, target, .. } if *kind == 3 || *kind == 4 => Some(*target),
            _ => None,
        })
        .collect();

    // For async: an outermost catch-all so a throw not caught by any user handler
    // rejects the function's promise (instead of aborting). Pushed first (bottom of
    // the handler stack), re-armed on every resume entry.
    if mode.is_promise_backed() {
        let _ = writeln!(s, "  if ({}(_fr->c.reject_buf) != 0) {{", exception_setjmp_name());
        if mode == SmMode::AsyncGenerator {
            s.push_str("    _fr->c.done = 1;\n");
            s.push_str("    if (ts_is_gen_return_completion(ts_current_exception())) {\n");
            s.push_str("      tsv _ge = ts_current_exception(); ts_gc_root(&_ge);\n");
            s.push_str("      tsv _gv = ts_gen_return_completion_value(_ge); ts_gc_root(&_gv);\n");
            s.push_str("      ts_promise_resolve_v(_fr->c.ret, ts_iter_result(_gv, 1));\n");
            s.push_str("      ts_gc_unroot(2);\n      return TS_UNDEFINED;\n    }\n");
        }
        s.push_str("    ts_promise_reject_v(_fr->c.ret, ts_current_exception());\n");
        s.push_str("    return TS_UNDEFINED;\n");
        s.push_str("  }\n");
        s.push_str("  ts_eh_push_coro(&_fr->c.reject_buf);\n");
    }

    // Top-of-resume re-arm: if we re-enter while inside one or more coroutine
    // tries, set up the longjmp landing on the FRESH frame buf (the old C frame is
    // gone), and re-push the global handlers (one per active level) so cross-
    // function throws come back here.
    if has_coro_try {
        s.push_str("  if (_fr->c.eh_top > 0) {\n");
        let _ = writeln!(s, "    if ({}(_fr->c.eh_buf) != 0) {{", exception_setjmp_name());
        s.push_str("      int _t = --_fr->c.eh_top;\n");
        s.push_str("      ts_gc_set_root_depth(_fr->c.eh_gc_depth[_t]);\n");
        s.push_str("      ts_eh_pop();\n");
        s.push_str("      switch (_fr->c.eh_catch_state[_t]) {\n");
        for cl in &catch_labels {
            let _ = writeln!(s, "        case {}: goto LC{};", cl, cl);
        }
        s.push_str("        default: ;\n      }\n");
        s.push_str("    }\n");
        s.push_str(
            "    for (int _i = 0; _i < _fr->c.eh_top; _i++) ts_eh_push_coro(&_fr->c.eh_buf);\n",
        );
        s.push_str("  }\n");
    }

    // Dispatch to the resume label for the current state.
    s.push_str("  switch (_fr->c.state) {\n");
    for st in 0..n_states {
        let _ = writeln!(s, "  case {}: goto S{};", st, st);
    }
    s.push_str("  }\n");

    let mut cur_state = 0u32;
    let _ = writeln!(s, "  S{}: ;", cur_state);
    for fl in &flat {
        match fl {
            Flat::Inst(inst) => emit_inst(s, inst, ctx),
            Flat::Label(id) => {
                let _ = writeln!(s, "  L{}: ;", id);
            }
            Flat::Goto(id) => {
                let _ = writeln!(s, "  goto L{};", id);
            }
            Flat::TryLeave(n) => {
                // leaving coroutine try levels on a jump: pop their handlers so a
                // later throw cannot land in a catch that is no longer active.
                for _ in 0..*n {
                    s.push_str("  ts_eh_pop(); _fr->c.eh_top--;\n");
                }
            }
            Flat::GotoIfFalse(cond, id) => {
                let _ = writeln!(s, "  if (!{}) goto L{};", ctx.truthy(*cond), id);
            }
            Flat::TryEnter { catch_label } => {
                // push a handler: record catch target + gc depth at the top of the
                // stack, arm setjmp, push one global handler pointing at the buf.
                s.push_str("  {\n    int _t = ts_coro_eh_push_slot(&_fr->c);\n");
                s.push_str("    _fr->c.eh_gc_depth[_t] = ts_gc_root_depth();\n");
                let _ = writeln!(s, "    _fr->c.eh_catch_state[_t] = {};", catch_label);
                s.push_str("  }\n");
                let _ = writeln!(s, "  if ({}(_fr->c.eh_buf) != 0) {{", exception_setjmp_name());
                s.push_str("    int _t = --_fr->c.eh_top;\n");
                s.push_str("    ts_gc_set_root_depth(_fr->c.eh_gc_depth[_t]);\n");
                s.push_str("    ts_eh_pop();\n");
                let _ = writeln!(s, "    goto LC{};", catch_label);
                s.push_str("  }\n");
                s.push_str("  ts_eh_push_coro(&_fr->c.eh_buf);\n");
            }
            Flat::TryNormalExit { after_label } => {
                // try body completed without throwing: pop the innermost handler.
                s.push_str("  ts_eh_pop();\n  _fr->c.eh_top--;\n");
                let _ = writeln!(s, "  goto L{};", after_label);
            }
            Flat::InCoroThrow { src } => {
                // explicit throw: if a coro try is active, route to the innermost
                // catch via the frame buf; else go to the global handler.
                if has_coro_try {
                    s.push_str("  if (_fr->c.eh_top > 0) {\n");
                    let _ = writeln!(s, "    g_exception_set({});", ctx.val(src.0));
                    s.push_str("    int _t = --_fr->c.eh_top;\n");
                    s.push_str("    ts_eh_pop();\n");
                    s.push_str("    ts_gc_set_root_depth(_fr->c.eh_gc_depth[_t]);\n");
                    s.push_str("    switch (_fr->c.eh_catch_state[_t]) {\n");
                    for cl in &catch_labels {
                        let _ = writeln!(s, "      case {}: goto LC{};", cl, cl);
                    }
                    s.push_str("      default: ;\n    }\n");
                    s.push_str("  }\n");
                }
                let _ = writeln!(s, "  ts_throw({});", ctx.val(src.0));
            }
            Flat::CatchLabel {
                catch_label,
                catch_var,
            } => {
                let _ = writeln!(s, "  LC{}: ;", catch_label);
                s.push_str("  if (ts_is_gen_return_completion(ts_current_exception())) ts_throw(ts_current_exception());\n");
                if let Some(cv) = catch_var {
                    s.push_str(&ctx.set_val(cv.0, "ts_current_exception()"));
                }
            }
            Flat::AfterLabel { after_label } => {
                let _ = writeln!(s, "  L{}: ;", after_label);
            }
            Flat::FinallyEnterTry { fin_catch_label } => {
                // identical to TryEnter, but the catch target is the finally landing.
                s.push_str("  {\n    int _t = ts_coro_eh_push_slot(&_fr->c);\n");
                s.push_str("    _fr->c.eh_gc_depth[_t] = ts_gc_root_depth();\n");
                let _ = writeln!(s, "    _fr->c.eh_catch_state[_t] = {};", fin_catch_label);
                s.push_str("  }\n");
                let _ = writeln!(s, "  if ({}(_fr->c.eh_buf) != 0) {{", exception_setjmp_name());
                s.push_str("    int _t = --_fr->c.eh_top;\n");
                s.push_str("    ts_gc_set_root_depth(_fr->c.eh_gc_depth[_t]);\n");
                s.push_str("    ts_eh_pop();\n");
                let _ = writeln!(s, "    goto LC{};", fin_catch_label);
                s.push_str("  }\n");
                s.push_str("  ts_eh_push_coro(&_fr->c.eh_buf);\n");
            }
            Flat::FinallyGotoNormal { fin_label } => {
                // normal completion of try/catch: pop the finally handler, mark this
                // finally's pending = normal (no re-throw), then run the finally body.
                s.push_str("  ts_eh_pop();\n  _fr->c.eh_top--;\n");
                s.push_str(
                    "  { int _f = ts_coro_fin_push_slot(&_fr->c); _fr->c.fin_pending[_f] = 0; }\n",
                );
                let _ = writeln!(s, "  goto L{};", fin_label);
            }
            Flat::FinallyCatchLabel {
                fin_catch_label,
                fin_label,
            } => {
                // exception landed here (try or catch threw): save it for re-throw
                // after the finally body. An injected generator return is an
                // internal completion, not a user-catchable exception.
                let _ = writeln!(s, "  LC{}: ;", fin_catch_label);
                s.push_str("  { int _f = ts_coro_fin_push_slot(&_fr->c); tsv _e = ts_current_exception();\n");
                s.push_str(
                    "    _fr->c.fin_pending[_f] = ts_is_gen_return_completion(_e) ? 2 : 1;\n",
                );
                s.push_str("    _fr->c.fin_exc[_f] = ts_is_gen_return_completion(_e) ? ts_gen_return_completion_value(_e) : _e; }\n");
                let _ = writeln!(s, "  goto L{};", fin_label);
            }
            Flat::FinallyLabel { fin_label } => {
                let _ = writeln!(s, "  L{}: ;", fin_label);
            }
            Flat::FinallyAbrupt {
                kind,
                value,
                target,
                fin_label,
            } => {
                // an abrupt completion inside a finally region: pop the active EH
                // handlers down to the finally's protected level, record the
                // completion, and jump to the finally body.
                // (the finally handler itself is popped here as it's no longer
                // protecting; remaining outer handlers stay for re-throw/return.)
                s.push_str("  ts_eh_pop();\n  _fr->c.eh_top--;\n");
                let _ = writeln!(s, "  {{ int _f = ts_coro_fin_push_slot(&_fr->c); _fr->c.fin_pending[_f] = {}; _fr->c.fin_tgt[_f] = {};", kind, target);
                if let Some(v) = value {
                    let _ = writeln!(s, "    _fr->c.fin_exc[_f] = {};", ctx.val(v.0));
                }
                s.push_str("  }\n");
                let _ = writeln!(s, "  goto L{};", fin_label);
            }
            Flat::FinallyDispatch {
                after_label,
                outer_fin,
            } => {
                // after the finally body: act on the saved completion record.
                //   0 normal/1 throw/2 return/3 break/4 continue
                s.push_str("  { int _f = --_fr->c.fin_top; int _k = _fr->c.fin_pending[_f];\n");
                if let Some(ofin) = outer_fin {
                    // nested inside another finally: propagate any non-normal
                    // completion outward by pushing the outer finally's pending
                    // slot (copying the record) and jumping to the outer finally.
                    s.push_str("    if (_k != 0) {\n");
                    s.push_str("      int _of = ts_coro_fin_push_slot(&_fr->c);\n");
                    s.push_str("      _fr->c.fin_pending[_of] = _k;\n");
                    s.push_str("      _fr->c.fin_exc[_of] = _fr->c.fin_exc[_f];\n");
                    s.push_str("      _fr->c.fin_tgt[_of] = _fr->c.fin_tgt[_f];\n");
                    let _ = writeln!(s, "      goto L{};", ofin);
                    s.push_str("    }\n");
                    s.push_str("  }\n");
                    let _ = writeln!(s, "  goto L{};", after_label);
                } else {
                    // throw
                    s.push_str("    if (_k == 1) {\n");
                    if has_coro_try {
                        s.push_str("      if (_fr->c.eh_top > 0) {\n");
                        s.push_str("        g_exception_set(_fr->c.fin_exc[_f]);\n");
                        s.push_str("        int _t = --_fr->c.eh_top;\n");
                        s.push_str("        ts_eh_pop();\n");
                        s.push_str("        ts_gc_set_root_depth(_fr->c.eh_gc_depth[_t]);\n");
                        s.push_str("        switch (_fr->c.eh_catch_state[_t]) {\n");
                        for cl in &catch_labels {
                            let _ = writeln!(s, "          case {}: goto LC{};", cl, cl);
                        }
                        s.push_str("          default: ;\n        }\n");
                        s.push_str("      }\n");
                    }
                    s.push_str("      ts_throw(_fr->c.fin_exc[_f]);\n");
                    s.push_str("    }\n");
                    // return
                    s.push_str("    if (_k == 2) {\n");
                    if has_coro_try {
                        s.push_str(
                            "      while (_fr->c.eh_top > 0) { ts_eh_pop(); _fr->c.eh_top--; }\n",
                        );
                    }
                    emit_completion(s, mode, "_fr->c.fin_exc[_f]");
                    s.push_str("    }\n");
                    // break / continue
                    if !fin_targets.is_empty() {
                        s.push_str("    if (_k == 3 || _k == 4) {\n");
                        s.push_str("      switch (_fr->c.fin_tgt[_f]) {\n");
                        for t in &fin_targets {
                            let _ = writeln!(s, "        case {}: goto L{};", t, t);
                        }
                        s.push_str("        default: ;\n      }\n");
                        s.push_str("    }\n");
                    }
                    s.push_str("  }\n");
                    let _ = writeln!(s, "  goto L{};", after_label);
                }
            }
            Flat::Suspend(inst) => {
                cur_state += 1;
                // If coro tries are active, pop ALL global handlers before
                // returning (their bufs go stale once we leave this C frame); the
                // top-of-resume re-arm re-pushes eh_top of them on the next entry.
                let pop_if_active = |s: &mut String| {
                    if has_coro_try {
                        s.push_str("  for (int _i = 0; _i < _fr->c.eh_top; _i++) ts_eh_pop();\n");
                    }
                    // async catch-all also unwinds before returning to the scheduler;
                    // re-pushed at the next resume's top.
                    if mode.is_promise_backed() {
                        s.push_str("  ts_eh_pop();\n");
                    }
                };
                // After a suspension resume, `c->rejected` means "raise c->result as
                // an exception at this resume point" — used both by a rejected awaited
                // promise AND by generator .throw(e) injected at a yield point. Dispatch
                // to the innermost active coroutine catch, else ts_throw out of resume.
                let throw_guard = |s: &mut String| {
                    if has_coro_try {
                        s.push_str("  if (_fr->c.rejected) {\n");
                        s.push_str("    _fr->c.rejected = 0;\n");
                        s.push_str("    if (_fr->c.eh_top > 0) {\n");
                        s.push_str("      g_exception_set(_fr->c.result);\n");
                        s.push_str("      int _t = --_fr->c.eh_top;\n");
                        s.push_str("      ts_eh_pop();\n");
                        s.push_str("      ts_gc_set_root_depth(_fr->c.eh_gc_depth[_t]);\n");
                        s.push_str("      switch (_fr->c.eh_catch_state[_t]) {\n");
                        for cl in &catch_labels {
                            let _ = writeln!(s, "        case {}: goto LC{};", cl, cl);
                        }
                        s.push_str("        default: ;\n      }\n");
                        s.push_str("    }\n");
                        s.push_str("    ts_throw(_fr->c.result);\n");
                        s.push_str("  }\n");
                    } else {
                        s.push_str("  if (_fr->c.rejected) { _fr->c.rejected = 0; ts_throw(_fr->c.result); }\n");
                    }
                };
                match (mode, inst) {
                    (SmMode::Async, Inst::Await { dst, operand })
                    | (SmMode::AsyncGenerator, Inst::Await { dst, operand }) => {
                        let _ = writeln!(s, "  _fr->c.state = {};", cur_state);
                        let _ = writeln!(
                            s,
                            "  ts_await_register_v({}, ts_obj(&_fr->c));",
                            ctx.val(operand.0)
                        );
                        pop_if_active(s);
                        s.push_str("  return TS_UNDEFINED;\n");
                        let _ = writeln!(s, "  S{}: ;", cur_state);
                        // a rejected awaited promise = throw at the await point.
                        throw_guard(s);
                        if let Some(d) = dst {
                            s.push_str(&ctx.set_val(d.0, "_fr->c.result"));
                        }
                    }
                    (SmMode::Generator, Inst::Yield { dst, operand }) => {
                        let _ = writeln!(s, "  _fr->c.yielded = {};", ctx.val(operand.0));
                        let _ = writeln!(s, "  _fr->c.state = {};", cur_state);
                        pop_if_active(s);
                        s.push_str("  return TS_UNDEFINED;\n");
                        let _ = writeln!(s, "  S{}: ;", cur_state);
                        // .throw(e) injected at this yield resumes by raising e here.
                        throw_guard(s);
                        if let Some(d) = dst {
                            s.push_str(&ctx.set_val(d.0, "_fr->c.result"));
                        }
                    }
                    (SmMode::AsyncGenerator, Inst::Yield { dst, operand }) => {
                        // resolve the current next-promise with {value, done:false},
                        // then return to the .next() caller. The next .next() makes a
                        // fresh promise (c->ret) and resumes.
                        let _ = writeln!(s, "  _fr->c.state = {};", cur_state);
                        let _ = writeln!(
                            s,
                            "  ts_promise_resolve_v(_fr->c.ret, ts_iter_result({}, 0));",
                            ctx.val(operand.0)
                        );
                        pop_if_active(s);
                        s.push_str("  return TS_UNDEFINED;\n");
                        let _ = writeln!(s, "  S{}: ;", cur_state);
                        // .throw(e) injected at this yield resumes by raising e here.
                        throw_guard(s);
                        // value sent into the resuming .next(v) arrives in c->result.
                        if let Some(d) = dst {
                            s.push_str(&ctx.set_val(d.0, "_fr->c.result"));
                        }
                    }
                    _ => {
                        let _ = writeln!(s, "  S{}: ;", cur_state);
                    }
                }
            }
            Flat::Ret(src) => {
                let v = match src {
                    Some(v) => ctx.val(v.0),
                    None => "TS_UNDEFINED".to_string(),
                };
                // a return inside active coro tries pops all their handlers first.
                if has_coro_try {
                    s.push_str("  while (_fr->c.eh_top > 0) { ts_eh_pop(); _fr->c.eh_top--; }\n");
                }
                emit_completion(s, mode, &v);
            }
        }
    }
    emit_completion(s, mode, "TS_UNDEFINED");
}

/// Copy a coroutine entry's parameters into its frame. Captured cells come
/// from the environment register (stored by the caller right before this
/// entry ran; nothing between can invoke another closure), the real
/// arguments from the argument array.
fn emit_coroutine_param_copy(s: &mut String, f: &Function, ctx: &Ctx) {
    let ncap = own_capture_count(f);
    if ncap > 0 {
        s.push_str("  tsv* _env = g_ts_cur_env;\n");
    }
    for (i, p) in f.params.iter().enumerate() {
        if i < ncap {
            if ctx.int_local.contains(&p.0) {
                let _ = writeln!(s, "  _fr->d{} = (long long)ts_to_num(_env[{}]);", p.0, i);
            } else if ctx.unboxed.contains(&p.0) {
                let _ = writeln!(s, "  _fr->d{} = ts_to_num(_env[{}]);", p.0, i);
            } else {
                let _ = writeln!(s, "  _fr->v{} = _env[{}];", p.0, i);
            }
            continue;
        }
        let j = i - ncap;
        if ctx.int_local.contains(&p.0) {
            let _ = writeln!(
                s,
                "  if (nargs > {}) _fr->d{} = (long long)ts_to_num(args[{}]);",
                j, p.0, j
            );
        } else if ctx.unboxed.contains(&p.0) {
            let _ = writeln!(
                s,
                "  if (nargs > {}) _fr->d{} = ts_to_num(args[{}]);",
                j, p.0, j
            );
        } else {
            let _ = writeln!(s, "  if (nargs > {}) _fr->v{} = args[{}];", j, p.0, j);
        }
    }
}

/// `TSAOT_CORO_PRECISE=0` keeps the coroutine frames without a map (the
/// parity oracle's layout, scanned conservatively).
fn coro_precise_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_CORO_PRECISE").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// The frame struct of a coroutine: the `ts_coro` header, then the locals.
/// With the frame map the `tsv` locals come first and their count is returned
/// for the allocator, so the collector visits exactly those words
/// (docs/gc_v2_design.md §6.5 step 2b); without it (`None`) the locals keep
/// their declaration order and the frame is scanned conservatively.
fn emit_coro_frame_struct(s: &mut String, f: &Function, ctx: &Ctx, fname: &str) -> Option<usize> {
    let _ = writeln!(s, "typedef struct {}_frame {{ ts_coro c;", fname);
    let numeric = |id: u32| ctx.int_local.contains(&id) || ctx.unboxed.contains(&id);
    let field = |s: &mut String, id: u32| {
        if ctx.int_local.contains(&id) || (int32_codegen_enabled() && ctx.int32_use.contains(&id)) {
            let _ = writeln!(s, "  long long d{};", id);
        } else if ctx.unboxed.contains(&id) {
            let _ = writeln!(s, "  double d{};", id);
        } else {
            let _ = writeln!(s, "  tsv v{};", id);
        }
    };
    let nvals = if coro_precise_enabled() {
        let mut n = 0usize;
        for l in f.locals.iter().filter(|l| !numeric(l.id.0)) {
            field(s, l.id.0);
            n += 1;
        }
        for l in f.locals.iter().filter(|l| numeric(l.id.0)) {
            field(s, l.id.0);
        }
        Some(n)
    } else {
        for l in &f.locals {
            field(s, l.id.0);
        }
        None
    };
    let _ = writeln!(s, "}} {}_frame;", fname);
    nvals
}

fn emit_coro_alloc(s: &mut String, fname: &str, nvals: Option<usize>) {
    match nvals {
        Some(n) => {
            let _ = writeln!(
                s,
                "  tsv _cv = ts_coro_alloc_vn(sizeof({}_frame), {}_resume, {}u);",
                fname, fname, n
            );
        }
        None => {
            let _ = writeln!(
                s,
                "  tsv _cv = ts_coro_alloc_v(sizeof({}_frame), {}_resume);",
                fname, fname
            );
        }
    }
}

fn emit_async_function(s: &mut String, f: &Function, ctx: &Ctx) {
    let fname = cname(f);
    // Frame struct: header (ts_coro) + all locals as named fields (the tsv
    // locals first, with the frame map).
    let nvals = emit_coro_frame_struct(s, f, ctx, &fname);

    // resume function
    let _ = writeln!(s, "static tsv {}_resume(tsv _cv){{", fname);
    let _ = writeln!(s, "  {}_frame* _fr = ({}_frame*)ts_ptr(_cv);", fname, fname);
    // #define each local to the frame field, so emit_inst output is unchanged.
    for l in &f.locals {
        if ctx.int_local.contains(&l.id.0) || ctx.unboxed.contains(&l.id.0) {
            let _ = writeln!(s, "#define d{} (_fr->d{})", l.id.0, l.id.0);
        } else {
            let _ = writeln!(s, "#define v{} (_fr->v{})", l.id.0, l.id.0);
        }
    }
    emit_sm_resume_body(s, f, ctx, SmMode::Async);
    // undef the local macros
    for l in &f.locals {
        if ctx.int_local.contains(&l.id.0) || ctx.unboxed.contains(&l.id.0) {
            let _ = writeln!(s, "#undef d{}", l.id.0);
        } else {
            let _ = writeln!(s, "#undef v{}", l.id.0);
        }
    }
    s.push_str("}\n");

    // public entry: allocate frame, copy args into param fields, run resume once,
    // return the result promise.
    let _ = writeln!(s, "static tsv {}(tsv* args, int nargs){{", fname);
    s.push_str("  (void)nargs;\n");
    emit_coro_alloc(s, &fname, nvals);
    s.push_str("  ts_gc_root(&_cv);\n");
    let _ = writeln!(s, "  {}_frame* _fr = ({}_frame*)ts_ptr(_cv);", fname, fname);
    // copy params into frame fields
    emit_coroutine_param_copy(s, f, ctx);
    s.push_str("  tsv _ret = _fr->c.ret;\n");
    s.push_str("  ts_coro_resume_v(_cv);\n");
    s.push_str("  ts_gc_unroot(1);\n");
    s.push_str("  return _ret;\n}\n\n");
    let _ = await_nested; // (exporter rejects nested awaits; helper kept for clarity)
}

/// Generator function (`function*`) -> state machine + coroutine frame, driven by
/// .next() rather than the event loop. Reuses the same frame/resume scaffolding
/// as async; yield hands a value to the caller and suspends, Return marks done.
fn emit_generator_function(s: &mut String, f: &Function, ctx: &Ctx) {
    let fname = cname(f);
    // Frame struct (identical layout to async).
    let nvals = emit_coro_frame_struct(s, f, ctx, &fname);

    let _ = writeln!(s, "static tsv {}_resume(tsv _cv){{", fname);
    let _ = writeln!(s, "  {}_frame* _fr = ({}_frame*)ts_ptr(_cv);", fname, fname);
    for l in &f.locals {
        if ctx.int_local.contains(&l.id.0) || ctx.unboxed.contains(&l.id.0) {
            let _ = writeln!(s, "#define d{} (_fr->d{})", l.id.0, l.id.0);
        } else {
            let _ = writeln!(s, "#define v{} (_fr->v{})", l.id.0, l.id.0);
        }
    }
    emit_sm_resume_body(s, f, ctx, SmMode::Generator);
    for l in &f.locals {
        if ctx.int_local.contains(&l.id.0) || ctx.unboxed.contains(&l.id.0) {
            let _ = writeln!(s, "#undef d{}", l.id.0);
        } else {
            let _ = writeln!(s, "#undef v{}", l.id.0);
        }
    }
    s.push_str("}\n");

    // public entry: allocate frame, copy args, return a generator object WITHOUT
    // running the body (generators are lazy).
    let _ = writeln!(s, "static tsv {}(tsv* args, int nargs){{", fname);
    s.push_str("  (void)nargs;\n");
    emit_coro_alloc(s, &fname, nvals);
    s.push_str("  ts_gc_root(&_cv);\n");
    let _ = writeln!(s, "  {}_frame* _fr = ({}_frame*)ts_ptr(_cv);", fname, fname);
    emit_coroutine_param_copy(s, f, ctx);
    s.push_str("  tsv _gen = ts_gen_new_v(_cv);\n");
    s.push_str("  ts_gc_unroot(1);\n");
    s.push_str("  return _gen;\n}\n\n");
}

fn emit_asyncgen_function(s: &mut String, f: &Function, ctx: &Ctx) {
    let fname = cname(f);
    // Frame struct (identical layout to async/generator).
    let nvals = emit_coro_frame_struct(s, f, ctx, &fname);

    let _ = writeln!(s, "static tsv {}_resume(tsv _cv){{", fname);
    let _ = writeln!(s, "  {}_frame* _fr = ({}_frame*)ts_ptr(_cv);", fname, fname);
    for l in &f.locals {
        if ctx.int_local.contains(&l.id.0) || ctx.unboxed.contains(&l.id.0) {
            let _ = writeln!(s, "#define d{} (_fr->d{})", l.id.0, l.id.0);
        } else {
            let _ = writeln!(s, "#define v{} (_fr->v{})", l.id.0, l.id.0);
        }
    }
    emit_sm_resume_body(s, f, ctx, SmMode::AsyncGenerator);
    for l in &f.locals {
        if ctx.int_local.contains(&l.id.0) || ctx.unboxed.contains(&l.id.0) {
            let _ = writeln!(s, "#undef d{}", l.id.0);
        } else {
            let _ = writeln!(s, "#undef v{}", l.id.0);
        }
    }
    s.push_str("}\n");

    // public entry: lazy — allocate frame, copy args, return an async-generator
    // object WITHOUT running the body (driven by .next()).
    let _ = writeln!(s, "static tsv {}(tsv* args, int nargs){{", fname);
    s.push_str("  (void)nargs;\n");
    emit_coro_alloc(s, &fname, nvals);
    s.push_str("  ts_gc_root(&_cv);\n");
    let _ = writeln!(s, "  {}_frame* _fr = ({}_frame*)ts_ptr(_cv);", fname, fname);
    emit_coroutine_param_copy(s, f, ctx);
    s.push_str("  tsv _gen = ts_asyncgen_new_v(_cv);\n");
    s.push_str("  ts_gc_unroot(1);\n");
    s.push_str("  return _gen;\n}\n\n");
}

/// Completion-record context for the plain (non-coroutine) finally lowering.
/// `pend` is the C variable holding the pending completion kind; the finally
/// dispatch acts on it. Pending kinds: 0 normal, 1 return, 4 throw, 5+label jump.
#[derive(Clone)]
struct FinCtx {
    pend: String,   // e.g. "_pend0"
    pendv: String,  // pending return value var
    fin_label: u32, // goto target = the finally body
    base_eh_depth: u32,
    loops_at_entry: usize,
    // Pending jump code -> (target loop index, C label, live handler depth).
    jumps: std::rc::Rc<std::cell::RefCell<BTreeMap<u32, (usize, u32, u32)>>>,
}

/// Emit a body that is inside a finally-protected region. Return/Break/Continue
/// that escape the region are rewritten to "set pending completion + goto
/// finally". A break/continue targeting a loop that is INSIDE this body (nested
/// here) stays a normal C break/continue (handled by emitting that loop with real
/// C for/break). `loop_depth` tracks nesting of loops local to this guarded body.
fn emit_guarded(s: &mut String, body: &[Inst], ctx: &Ctx, fc: &FinCtx, loop_depth: u32) {
    for inst in body {
        match inst {
            Inst::Return { src } => {
                let v = match src {
                    Some(v) => ctx.val(v.0),
                    None => "TS_UNDEFINED".to_string(),
                };
                let pops = ctx.eh_depth.get().saturating_sub(fc.base_eh_depth);
                let pop_str = "ts_eh_pop(); ".repeat(pops as usize);
                let _ = writeln!(
                    s,
                    "  {} = {}; {} = 1; {}goto L{};",
                    fc.pendv, v, fc.pend, pop_str, fc.fin_label
                );
            }
            Inst::Break { up } | Inst::Continue { up } => {
                if (*up as usize) < loop_depth as usize {
                    emit_inst(s, inst, ctx);
                } else {
                    let labels = ctx.loop_labels.borrow();
                    let index = labels.len() - 1 - *up as usize;
                    let (top, end, eh_depth) = labels[index];
                    let label = if matches!(inst, Inst::Break { .. }) {
                        end
                    } else {
                        top
                    };
                    let code = 5 + label;
                    fc.jumps.borrow_mut().insert(code, (index, label, eh_depth));
                    let pops = ctx.eh_depth.get().saturating_sub(fc.base_eh_depth);
                    let pop_str = "ts_eh_pop(); ".repeat(pops as usize);
                    let _ = writeln!(
                        s,
                        "  {} = {}; {}goto L{};",
                        fc.pend, code, pop_str, fc.fin_label
                    );
                }
            }
            Inst::If {
                cond,
                then_body,
                else_body,
            } => {
                let _ = writeln!(s, "  if ({}) {{", ctx.truthy(cond.0));
                emit_guarded(s, then_body, ctx, fc, loop_depth);
                s.push_str("  } else {\n");
                emit_guarded(s, else_body, ctx, fc, loop_depth);
                s.push_str("  }\n");
            }
            Inst::Loop {
                cond,
                cond_body,
                body: lbody,
            } => {
                let top = ctx.fresh_label();
                let end = ctx.fresh_label();
                ctx.loop_labels
                    .borrow_mut()
                    .push((top, end, ctx.eh_depth.get()));
                let _ = writeln!(s, "  L{}: ;", top);
                s.push_str("  for (;;) {\n");
                emit_guarded(s, cond_body, ctx, fc, loop_depth + 1);
                let _ = writeln!(s, "    if (!{}) break;", ctx.truthy(cond.0));
                emit_guarded(s, lbody, ctx, fc, loop_depth + 1);
                s.push_str("  }\n");
                let _ = writeln!(s, "  L{}: ;", end);
                ctx.loop_labels.borrow_mut().pop();
            }
            // throw inside the guarded region still uses the EH path (the finally
            // handler set up by emit_plain_finally catches it).
            Inst::TryCatch {
                try_body,
                catch_var,
                catch_body,
                finally_body,
            } if !finally_body.is_empty() => {
                // A nested try/finally inside a guarded region: emit it via
                // emit_plain_finally, which pushes/pops the fin_stack so this inner
                // finally propagates its completion OUT to the current (fc) finally.
                emit_plain_finally(s, try_body, catch_var, catch_body, finally_body, ctx);
            }
            Inst::TryCatch {
                try_body,
                catch_var,
                catch_body,
                finally_body,
            } if finally_body.is_empty() => {
                let base_eh_depth = ctx.eh_depth.get();
                s.push_str("  {\n    ts_handler* _h = ts_eh_push();\n");
                let _ = writeln!(s, "    if ({}(_h->buf) == 0) {{", exception_setjmp_name());
                ctx.eh_depth.set(base_eh_depth + 1);
                emit_guarded(s, try_body, ctx, fc, loop_depth);
                s.push_str("      ts_eh_pop();\n");
                s.push_str("    } else {\n");
                s.push_str("      ts_gc_set_root_depth(_h->gc_root_len);\n");
                if frame_roots_enabled() {
                    s.push_str("      ts_frame_restore(_h->frame_top);\n");
                }
                s.push_str("      ts_eh_pop();\n");
                ctx.eh_depth.set(base_eh_depth);
                if let Some(cv) = catch_var {
                    s.push_str(&ctx.set_val(cv.0, "ts_current_exception()"));
                }
                emit_guarded(s, catch_body, ctx, fc, loop_depth);
                s.push_str("    }\n  }\n");
                ctx.eh_depth.set(base_eh_depth);
            }
            other => emit_inst(s, other, ctx),
        }
    }
}

/// Plain (non-coroutine) try/catch/finally where the protected region may exit
/// abruptly (return/break/continue/throw through the finally). Uses a completion
/// record in C locals + a setjmp handler for the throw path.
fn emit_plain_finally(
    s: &mut String,
    try_body: &[Inst],
    catch_var: &Option<LocalId>,
    catch_body: &[Inst],
    finally_body: &[Inst],
    ctx: &Ctx,
) {
    let fin_label = ctx.fresh_label();
    let after_label = ctx.fresh_label();
    let id = fin_label; // unique suffix for locals
    let pend = format!("_pend{}", id);
    let depth = ctx.pendv_depth.get();
    let pendv = if ctx.fin_value_slots {
        format!("F.p{}", depth)
    } else {
        format!("_pendv{}", id)
    };
    // record the EH depth visible to this finally's protected region; an inner
    // nested finally propagating outward must pop handlers down to this level.
    let base_eh_depth = ctx.eh_depth.get();
    let fc = FinCtx {
        pend: pend.clone(),
        pendv: pendv.clone(),
        fin_label,
        base_eh_depth,
        loops_at_entry: ctx.loop_labels.borrow().len(),
        jumps: std::rc::Rc::new(std::cell::RefCell::new(BTreeMap::new())),
    };
    // completion record locals: kind (0 normal,1 return,2 break,3 continue,4 throw)
    if ctx.fin_value_slots {
        let _ = writeln!(s, "  int {} = 0; {} = TS_UNDEFINED;", pend, pendv);
    } else {
        let _ = writeln!(s, "  int {} = 0; tsv {} = TS_UNDEFINED;", pend, pendv);
    }
    ctx.pendv_depth.set(depth + 1);
    let has_catch = !catch_body.is_empty() || catch_var.is_some();
    ctx.fin_stack.borrow_mut().push(fc.clone());
    // EH handler so a throw in try/catch lands and routes through the finally.
    s.push_str("  {\n    ts_handler* _h = ts_eh_push();\n");
    ctx.eh_depth.set(base_eh_depth + 1);
    let _ = writeln!(s, "    if ({}(_h->buf) == 0) {{", exception_setjmp_name());
    emit_guarded(s, try_body, ctx, &fc, 0);
    s.push_str("      ts_eh_pop();\n");
    let _ = writeln!(s, "      goto L{};", fin_label); // normal completion of try
    s.push_str("    } else {\n");
    s.push_str("      ts_gc_set_root_depth(_h->gc_root_len);\n");
    if frame_roots_enabled() {
        s.push_str("      ts_frame_restore(_h->frame_top);\n");
    }
    s.push_str("      ts_eh_pop();\n");
    if has_catch {
        if let Some(cv) = catch_var {
            s.push_str(&format!(
                "    {}",
                ctx.set_val(cv.0, "ts_current_exception()")
            ));
        }
        // catch body is itself guarded by the finally (it may return/throw/etc.)
        s.push_str("      {\n        ts_handler* _h2 = ts_eh_push();\n");
        // within the catch body, the live handler is _h2 (the outer _h was popped).
        ctx.eh_depth.set(base_eh_depth + 1);
        let _ = writeln!(s, "        if ({}(_h2->buf) == 0) {{", exception_setjmp_name());
        emit_guarded(s, catch_body, ctx, &fc, 0);
        s.push_str("          ts_eh_pop();\n");
        let _ = writeln!(s, "          goto L{};", fin_label);
        s.push_str("        } else {\n");
        s.push_str("          ts_gc_set_root_depth(_h2->gc_root_len);\n");
        if frame_roots_enabled() {
            s.push_str("          ts_frame_restore(_h2->frame_top);\n");
        }
        s.push_str("          ts_eh_pop();\n");
        let _ = writeln!(
            s,
            "          {} = 4; {} = ts_current_exception(); goto L{};",
            pend, pendv, fin_label
        );
        s.push_str("        }\n      }\n");
    } else {
        // no catch: a throw becomes pending-throw, finally runs then re-throws.
        let _ = writeln!(
            s,
            "      {} = 4; {} = ts_current_exception(); goto L{};",
            pend, pendv, fin_label
        );
    }
    s.push_str("    }\n  }\n");
    // leaving the protected region: restore EH depth and pop the finally context.
    ctx.eh_depth.set(base_eh_depth);
    ctx.fin_stack.borrow_mut().pop();
    let outer_fin = ctx.fin_stack.borrow().last().cloned();
    let _ = writeln!(s, "  L{}: ;", fin_label);
    if let Some(outer) = &outer_fin {
        let depth = ctx.loop_labels.borrow().len() - outer.loops_at_entry;
        emit_guarded(s, finally_body, ctx, outer, depth as u32);
    } else {
        for inst in finally_body {
            emit_inst(s, inst, ctx);
        }
    }
    let _ = writeln!(s, "  switch ({}) {{", pend);
    if let Some(outer) = &outer_fin {
        let pop_str =
            "ts_eh_pop(); ".repeat(base_eh_depth.saturating_sub(outer.base_eh_depth) as usize);
        let _ = writeln!(
            s,
            "    case 1: {}{} = 1; {} = {}; goto L{};",
            pop_str, outer.pend, outer.pendv, pendv, outer.fin_label
        );
    } else {
        let pop_str = "ts_eh_pop(); ".repeat(base_eh_depth as usize);
        let cleanup = ctx.root_cleanup();
        // The pending `return` value is boxed; a raw-returning entry (a
        // typed direct entry or a numeric clone) converts it here.
        let ret_expr = if ctx.i64_mode {
            format!("(long long)ts_to_num({})", pendv)
        } else if ctx.f64_mode {
            format!("ts_to_num({})", pendv)
        } else {
            match ctx.ret_kind {
                RetKind::Boxed => pendv.clone(),
                RetKind::F64 => format!("ts_to_num({})", pendv),
                RetKind::I64 => format!("(long long)ts_to_num({})", pendv),
                RetKind::Bool => format!("ts_truthy_fast({})", pendv),
            }
        };
        let _ = writeln!(s, "    case 1: {}{} return {};", pop_str, cleanup, ret_expr);
    }
    // A throw resumes the active EH chain, including an enclosing catch.
    // Jump completions only run outer finally blocks they actually leave.
    let _ = writeln!(s, "    case 4: ts_throw({});", pendv);
    for (&code, &(index, label, eh_depth)) in fc.jumps.borrow().iter() {
        if let Some(outer) = &outer_fin {
            if index < outer.loops_at_entry {
                outer
                    .jumps
                    .borrow_mut()
                    .insert(code, (index, label, eh_depth));
                let pop_str = "ts_eh_pop(); "
                    .repeat(base_eh_depth.saturating_sub(outer.base_eh_depth) as usize);
                let _ = writeln!(
                    s,
                    "    case {}: {}{} = {}; goto L{};",
                    code, pop_str, outer.pend, code, outer.fin_label
                );
                continue;
            }
        }
        let pop_str = "ts_eh_pop(); ".repeat(base_eh_depth.saturating_sub(eh_depth) as usize);
        let _ = writeln!(s, "    case {}: {}goto L{};", code, pop_str, label);
    }
    s.push_str("    default: ;\n  }\n");
    let _ = writeln!(s, "  L{}: ;", after_label);
    ctx.pendv_depth.set(depth);
}

/// C identifier for a static-builtin function-value adapter (`math.sqrt` -> `ts_fnval_math_sqrt`).
fn fnval_adapter_name(builtin: &str) -> String {
    format!("ts_fnval_{}", builtin.replace('.', "_"))
}

/// `TSAOT_MATH_COERCE=0` keeps Math's previous argument reads (a raw
/// reinterpretation of a boxed argument as a double, no ToNumber) for the
/// parity oracle.
fn math_coerce_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_MATH_COERCE").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// `TSAOT_PARSEINT_COERCE=0` keeps parseInt's previous radix read (raw
/// double bits of a boxed radix) for the parity oracle.
fn parseint_coerce_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_PARSEINT_COERCE").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// `TSAOT_NUMFMT_COERCE=0` keeps toFixed / toString / toPrecision's previous
/// calls (a raw argument, no RangeError) for the parity oracle.
fn numfmt_coerce_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_NUMFMT_COERCE").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
}

/// Full C body (statements incl. `return`) of a static-builtin function-value
/// adapter. `a`/`n` are the ts_code args. Each mirrors the call-path semantics
/// (same runtime helper / libm). Returns None for builtins NOT supported as
/// first-class values (the exporter loud-rejects those; this is defensive).
fn fnval_adapter_body(builtin: &str) -> Option<String> {
    // ToNumber of arg i (NaN if absent); boxed arg i (undefined if absent).
    let coerce = math_coerce_enabled();
    let num = |i: usize| {
        if coerce {
            format!("(n>{i}?ts_number_coerce(a[{i}]):(0.0/0.0))")
        } else {
            format!("(n>{i}?ts_to_num(a[{i}]):(0.0/0.0))")
        }
    };
    let val = |i: usize| format!("(n>{i}?a[{i}]:TS_UNDEFINED)");
    // libm 1-arg: ts_num(fn(num0))
    let m1 = |f: &str| Some(format!("return ts_num({}({}));", f, num(0)));
    // helper 1-arg numeric: ts_num(fn(num0))  (fn already returns double)
    let h1n = |f: &str| Some(format!("return ts_num({}({}));", f, num(0)));
    // helper taking a boxed value, returning numeric double
    let hv_n = |f: &str| Some(format!("return ts_num({}({}));", f, val(0)));
    // helper taking boxed value(s), returning a boxed tsv
    let hv = |expr: String| Some(format!("return {};", expr));
    match builtin {
        // ---- Math: libm 1-arg ----
        "math.sqrt" => m1("sqrt"), "math.abs" => m1("fabs"), "math.floor" => m1("floor"),
        "math.ceil" => m1("ceil"), "math.sin" => m1("sin"), "math.cos" => m1("cos"),
        "math.tan" => m1("tan"), "math.asin" => m1("asin"), "math.acos" => m1("acos"),
        "math.atan" => m1("atan"), "math.sinh" => m1("sinh"), "math.cosh" => m1("cosh"),
        "math.tanh" => m1("tanh"), "math.exp" => m1("exp"), "math.log" => m1("log"),
        "math.asinh" => m1("asinh"), "math.acosh" => m1("acosh"), "math.atanh" => m1("atanh"),
        "math.expm1" => m1("expm1"), "math.log1p" => m1("log1p"),
        "math.fround" => hv(format!("ts_num((double)(float)({}))", num(0))),
        "math.f16round" => hv(format!("ts_num(ts_math_f16round(ts_number_coerce({})))", val(0))),
        // ---- Math: runtime helper 1-arg ----
        "math.round" => h1n("ts_math_round"), "math.trunc" => h1n("ts_math_trunc"),
        "math.sign" => h1n("ts_math_sign"), "math.log2" => h1n("ts_math_log2"),
        "math.log10" => h1n("ts_math_log10"), "math.cbrt" => h1n("ts_math_cbrt"),
        "math.clz32" => h1n("ts_math_clz32"),
        // ---- Math: 2-arg ----
        "math.imul" => hv(format!("ts_num(ts_math_imul(ts_number_coerce({}), ts_number_coerce({})))", val(0), val(1))),
        // two arguments, coerced in order
        "math.pow" if coerce => Some(format!("double x0={}; double x1={}; return ts_num(pow(x0, x1));", num(0), num(1))),
        "math.atan2" if coerce => Some(format!("double x0={}; double x1={}; return ts_num(atan2(x0, x1));", num(0), num(1))),
        "math.pow" => hv(format!("ts_num(pow({}, {}))", num(0), num(1))),
        "math.atan2" => hv(format!("ts_num(atan2({}, {}))", num(0), num(1))),
        // ---- Math: variadic (NaN propagates) ----
        // every argument is coerced, in order, before the result is known
        "math.max" if coerce => Some("return ts_num(ts_math_max_args(a, n));".to_string()),
        "math.min" if coerce => Some("return ts_num(ts_math_min_args(a, n));".to_string()),
        "math.hypot" if coerce => Some("return ts_num(ts_math_hypot_args(a, n));".to_string()),
        "math.max" => Some("double m=-INFINITY; for(int i=0;i<n;i++){ double x=ts_to_num(a[i]); if(x!=x) return ts_num(0.0/0.0); if(x>m||(x==0&&m==0&&!signbit(x))) m=x; } return ts_num(m);".to_string()),
        "math.min" => Some("double m=INFINITY; for(int i=0;i<n;i++){ double x=ts_to_num(a[i]); if(x!=x) return ts_num(0.0/0.0); if(x<m||(x==0&&m==0&&signbit(x))) m=x; } return ts_num(m);".to_string()),
        "math.hypot" => Some("double s=0; for(int i=0;i<n;i++){ double x=ts_to_num(a[i]); s+=x*x; } return ts_num(sqrt(s));".to_string()),
        "math.random" => Some("return ts_num(ts_math_random());".to_string()),
        // ---- Number / global numeric ----
        "number.isInteger" => hv(format!("ts_bool(ts_number_is_integer({}))", val(0))),
        "number.isFinite" => hv(format!("ts_bool(ts_number_is_finite({}))", val(0))),
        "number.isNaN" => hv(format!("ts_bool(ts_number_is_nan({}))", val(0))),
        "number.isSafeInteger" => hv(format!("ts_bool(ts_number_is_safe_integer({}))", val(0))),
        "number.parseFloat" | "global.parseFloat" => hv_n("ts_parse_float"),
        "number.parseInt" | "global.parseInt" if parseint_coerce_enabled() => hv(format!("ts_num(ts_parse_int_v({}, {}))", val(0), val(1))),
        "number.parseInt" | "global.parseInt" => hv(format!("ts_num(ts_parse_int({}, (n>1?ts_to_num(a[1]):0.0)))", val(0))),
        "global.isNaN" => hv(format!("ts_bool(isnan(ts_number_coerce({})))", val(0))),
        "global.isFinite" => hv(format!("ts_bool(isfinite(ts_number_coerce({})))", val(0))),
        // ---- conversion functions (bare identifiers String/Number/Boolean) ----
        "global.String" => hv(format!("ts_to_string_v({})", val(0))),
        "global.Number" => hv(format!("ts_num(ts_number_coerce({}))", val(0))),
        "global.Boolean" => hv(format!("ts_bool(ts_truthy_fast({}))", val(0))),
        "global.Symbol" => hv(format!("ts_symbol_new({})", val(0))),
        "global.fetch" => hv(format!("ts_fetch({}, {})", val(0), val(1))),
        "global.Headers" => hv(format!("ts_headers_new({})", val(0))),
        "global.AbortController" => Some("return ts_abort_controller_new();".to_string()),
        "global.AbortSignal" => Some("return ts_abort_signal_new(0);".to_string()),
        "abortsignal.timeout" => hv(format!("ts_abort_signal_timeout({})", val(0))),
        "global.Array" => Some(format!(
            "if(n==1 && ts_is_num({})) return ts_array_new_length(ts_to_num({})); return ts_array_of(a, n);",
            val(0), val(0)
        )),
        "global.Object" => Some("if(n==0 || a[0]==TS_UNDEFINED || a[0]==TS_NULL) return ts_new_object(); return a[0];".to_string()),
        "global.Promise" => Some("if(n>0) return ts_promise_new_executor(a[0]); ts_unsupported_builtin(\"Promise constructor requires executor\"); return TS_UNDEFINED;".to_string()),
        "global.Map" => Some("ts_unsupported_builtin(\"Map constructor called without supported new lowering\"); return TS_UNDEFINED;".to_string()),
        "global.Set" => Some("ts_unsupported_builtin(\"Set constructor called without supported new lowering\"); return TS_UNDEFINED;".to_string()),
        "global.WeakMap" => Some("ts_unsupported_builtin(\"WeakMap constructor called without supported new lowering\"); return TS_UNDEFINED;".to_string()),
        "global.WeakSet" => Some("ts_unsupported_builtin(\"WeakSet constructor called without supported new lowering\"); return TS_UNDEFINED;".to_string()),
        "global.Date" => Some("ts_unsupported_builtin(\"Date constructor called as first-class value\"); return TS_UNDEFINED;".to_string()),
        "global.Function" => Some("ts_unsupported_builtin(\"Function constructor\"); return TS_UNDEFINED;".to_string()),
        "global.Error" | "global.TypeError" | "global.RangeError" | "global.SyntaxError" |
        "global.ReferenceError" | "global.EvalError" | "global.URIError" | "global.AggregateError" =>
            Some("tsv o=ts_new_object(); if(n>0) ts_set(o, ts_intern_field(\"message\",7), ts_to_string_v(a[0])); return o;".to_string()),
        // ---- console ----
        "console.log" => Some("ts_console_log(a, n); return TS_UNDEFINED;".to_string()),
        "console.error" => Some("ts_console_err(a, n); return TS_UNDEFINED;".to_string()),
        "console.dir" => Some("ts_console_dir(n>0?a[0]:TS_UNDEFINED); return TS_UNDEFINED;".to_string()),
        // ---- JSON ----
        "json.stringify" => hv(format!("ts_json_stringify({})", val(0))),
        "json.stringify.len" => hv(format!("ts_num(ts_json_stringify_len({}))", val(0))),
        "json.stringify.indent.len" => hv(format!("ts_num(ts_json_stringify_indent_len({}, {}))", val(0), val(1))),
        "json.num.len" => hv(format!("ts_num(ts_json_num_len(ts_number_coerce({})))", val(0))),
        "json.string.len" => hv(format!("ts_num(ts_json_string_len({}))", val(0))),
        "json.parse" => hv(format!("ts_json_parse({})", val(0))),
        // ---- Object ----
        "object.assign" => Some("return ts_object_assign(a, n);".to_string()),
        "object.create" => hv(format!("ts_object_create({})", val(0))),
        "object.getPrototypeOf" => hv(format!("ts_get_proto({})", val(0))),
        "object.setPrototypeOf" => hv(format!("{}({}, {})", user_set_proto_fn(), val(0), val(1))),
        "object.keys" => hv(format!("ts_object_keys({})", val(0))),
        "object.forInKeys" => hv(format!("ts_object_for_in_keys({})", val(0))),
        "object.getOwnPropertyNames" => hv(format!("ts_object_get_own_property_names({})", val(0))),
        "object.getOwnPropertySymbols" => hv(format!("ts_object_get_own_property_symbols({})", val(0))),
        "object.values" => hv(format!("ts_object_values({})", val(0))),
        "object.entries" => hv(format!("ts_object_entries({})", val(0))),
        "object.fromEntries" => hv(format!("ts_object_from_entries({})", val(0))),
        "object.freeze" => hv(format!("ts_object_freeze({})", val(0))),
        "object.seal" => hv(format!("ts_object_seal({})", val(0))),
        "object.preventExtensions" => hv(format!("ts_object_prevent_extensions({})", val(0))),
        "object.isFrozen" => hv(format!("ts_bool(ts_object_is_frozen({}))", val(0))),
        "object.isSealed" => hv(format!("ts_bool(ts_object_is_sealed({}))", val(0))),
        "object.isExtensible" => hv(format!("ts_bool(ts_object_is_extensible({}))", val(0))),
        "object.hasOwn" => hv(format!("ts_bool(ts_has_own_dyn({}, {}))", val(0), val(1))),
        "object.is" => hv(format!("ts_bool(ts_object_is({}, {}))", val(0), val(1))),
        "object.getOwnPropertyDescriptor" => hv(format!("ts_get_own_property_descriptor({}, {})", val(0), val(1))),
        "object.getOwnPropertyDescriptors" => hv(format!("ts_get_own_property_descriptors({})", val(0))),
        // ---- Object.prototype method VALUES (takes_this=1: a[0] is the receiver,
        // injected by Function.prototype.call/apply/bind). toString uses the spec
        // [[Class]]-tag variant (not the array-join dispatch one). ----
        "objproto.toString" => hv(format!("ts_objproto_tostring_call({})", val(0))),
        "objproto.toLocaleString" => Some("return ts_objproto_toLocaleString(a, n);".to_string()),
        "objproto.hasOwnProperty" => Some("return ts_objproto_hasOwnProperty(a, n);".to_string()),
        "objproto.isPrototypeOf" => Some("return ts_objproto_isPrototypeOf(a, n);".to_string()),
        "objproto.propertyIsEnumerable" => Some("return ts_objproto_propertyIsEnumerable(a, n);".to_string()),
        "objproto.valueOf" => Some("return ts_objproto_valueOf(a, n);".to_string()),
        // ---- Array statics ----
        "array.isArray" => hv(format!("ts_bool(ts_is_array_fast({}))", val(0))),
        "array.pushHole" => Some(format!("ts_array_push_hole({}); return TS_UNDEFINED;", val(0))),
        "array.from" => Some(format!("return n>1 ? ts_array_from_mapped({}, {}) : ts_array_from({});", val(0), val(1), val(0))),
        "array.of" => Some("return ts_array_of(a, n);".to_string()),
        // ---- String statics ----
        "string.fromCharCode" => Some("return ts_string_from_char_code(a, n);".to_string()),
        "string.fromCodePoint" => Some("return ts_string_from_code_point(a, n);".to_string()),
        // ---- Promise statics ----
        "promise.resolve" => hv(format!("ts_promise_resolved({})", val(0))),
        "promise.reject" => hv(format!("ts_promise_rejected({})", val(0))),
        "promise.all" => hv(format!("ts_promise_all({})", val(0))),
        "promise.race" => hv(format!("ts_promise_race({})", val(0))),
        "promise.allSettled" => hv(format!("ts_promise_allsettled({})", val(0))),
        "promise.any" => hv(format!("ts_promise_any({})", val(0))),
        // ---- RegExp optional QuickJS fallback ----
        "regexp.quickTest" => hv(format!(
            "ts_regexp_adapter_test_tsv({}, (uint32_t)ts_to_num({}), {})",
            val(0),
            val(1),
            val(2)
        )),
        "regexp.quickSearch" => hv(format!(
            "ts_num(ts_regexp_adapter_search_tsv({}, {}, (uint32_t)ts_to_num({})))",
            val(0),
            val(1),
            val(2)
        )),
        "regexp.quickExec" => hv(format!(
            "ts_regexp_adapter_exec_tsv({}, (uint32_t)ts_to_num({}), {})",
            val(0),
            val(1),
            val(2)
        )),
        "regexp.quickMatch" => hv(format!(
            "ts_regexp_adapter_match_tsv({}, {}, (uint32_t)ts_to_num({}))",
            val(0),
            val(1),
            val(2)
        )),
        "regexp.quickMatchAll" => hv(format!(
            "ts_regexp_adapter_match_all_tsv({}, {}, (uint32_t)ts_to_num({}))",
            val(0),
            val(1),
            val(2)
        )),
        "regexp.quickReplace" => hv(format!(
            "ts_regexp_adapter_replace_tsv({}, {}, (uint32_t)ts_to_num({}), {}, (int)ts_to_num({}))",
            val(0),
            val(1),
            val(2),
            val(3),
            val(4)
        )),
        "regexp.quickSplit" => hv(format!(
            "ts_regexp_adapter_split_tsv({}, {}, (uint32_t)ts_to_num({}), {})",
            val(0),
            val(1),
            val(2),
            val(3)
        )),
        "regexp.initObject" => hv(format!("ts_regexp_object_init({})", val(0))),
        "regexp.validateObject" => hv(format!("ts_regexp_adapter_validate_object_tsv({})", val(0))),
        // ---- Symbol statics ----
        "symbol.for" => hv(format!("ts_symbol_for({})", val(0))),
        "symbol.keyFor" => hv(format!("ts_symbol_key_for({})", val(0))),
        // ---- Date statics ----
        "date.now" => Some("return ts_date_now_ms();".to_string()),
        _ => None,
    }
}

fn global_fn_value_builtins() -> &'static [&'static str] {
    &[
        "global.parseInt",
        "global.parseFloat",
        "global.isNaN",
        "global.isFinite",
        "global.String",
        "global.Number",
        "global.Boolean",
        "global.Symbol",
        "global.fetch",
        "global.Array",
        "global.Object",
        "global.Promise",
        "global.Headers",
        "global.AbortController",
        "global.AbortSignal",
        "abortsignal.timeout",
        "global.Map",
        "global.Set",
        "global.WeakMap",
        "global.WeakSet",
        "global.Date",
        "global.Function",
        "global.Error",
        "global.TypeError",
        "global.RangeError",
        "global.SyntaxError",
        "global.ReferenceError",
        "global.EvalError",
        "global.URIError",
        "global.AggregateError",
        "console.log",
        "console.error",
        "console.dir",
        "json.stringify",
        "json.parse",
        "object.assign",
        "object.create",
        "object.getPrototypeOf",
        "object.setPrototypeOf",
        "object.keys",
        "object.getOwnPropertyNames",
        "object.getOwnPropertySymbols",
        "object.values",
        "object.entries",
        "object.fromEntries",
        "object.freeze",
        "object.seal",
        "object.preventExtensions",
        "object.isFrozen",
        "object.isSealed",
        "object.isExtensible",
        "object.hasOwn",
        "object.is",
        "object.getOwnPropertyDescriptor",
        "object.getOwnPropertyDescriptors",
        "array.isArray",
        "array.from",
        "array.of",
        "string.fromCharCode",
        "string.fromCodePoint",
        "number.isInteger",
        "number.isFinite",
        "number.isNaN",
        "number.isSafeInteger",
        "number.parseFloat",
        "number.parseInt",
        "promise.resolve",
        "promise.reject",
        "promise.all",
        "promise.race",
        "promise.allSettled",
        "promise.any",
        "symbol.for",
        "symbol.keyFor",
        "date.now",
        "math.sqrt",
        "math.abs",
        "math.floor",
        "math.ceil",
        "math.sin",
        "math.cos",
        "math.tan",
        "math.asin",
        "math.acos",
        "math.atan",
        "math.sinh",
        "math.cosh",
        "math.tanh",
        "math.exp",
        "math.log",
        "math.asinh",
        "math.acosh",
        "math.atanh",
        "math.expm1",
        "math.log1p",
        "math.fround",
        "math.f16round",
        "math.round",
        "math.trunc",
        "math.sign",
        "math.log2",
        "math.log10",
        "math.cbrt",
        "math.clz32",
        "math.imul",
        "math.pow",
        "math.atan2",
        "math.max",
        "math.min",
        "math.hypot",
        "math.random",
    ]
}

fn emit_global_setup(s: &mut String, needs_fetch: bool, needs_typed_array_globals: bool) {
    fn cstr(v: &str) -> String {
        format!("{:?}", v)
    }
    fn set_fn(s: &mut String, obj: &str, prop: &str, builtin: &str, arity: u32, name: &str) {
        let _ = writeln!(
            s,
            "  ts_define_data({}, ts_intern_field({}, (uint32_t)strlen({})), ts_make_global_fn({}, {}u, {}, 0), 0, 1, 1);",
            obj,
            cstr(prop),
            cstr(prop),
            fnval_adapter_name(builtin),
            arity,
            cstr(name)
        );
    }
    fn set_val(s: &mut String, obj: &str, prop: &str, expr: &str) {
        let _ = writeln!(
            s,
            "  ts_define_data({}, ts_intern_field({}, (uint32_t)strlen({})), {}, 0, 1, 1);",
            obj,
            cstr(prop),
            cstr(prop),
            expr
        );
    }
    fn root_local(s: &mut String, var: &str) {
        let _ = writeln!(s, "  ts_gc_root(&{});", var);
    }
    fn global_set_rooted(s: &mut String, name: &str, var: &str) {
        let _ = writeln!(s, "  ts_global_set({}, {});", cstr(name), var);
        s.push_str("  ts_gc_unroot(1);\n");
    }

    s.push_str("static tsv ts_make_global_fn(ts_code code, uint32_t arity, const char* name, int takes_this){\n");
    s.push_str("  tsv f = ts_make_fn_t(code, 0, 0, takes_this);\n");
    s.push_str("  ts_set_fn_meta(f, arity, name);\n");
    s.push_str("  return f;\n");
    s.push_str("}\n\n");

    s.push_str("static void ts_setup_global_object(void){\n");
    s.push_str("  ts_global_this_init();\n");
    s.push_str("  tsv _g = ts_global_this();\n");
    s.push_str("  ts_global_set(\"globalThis\", _g);\n");
    s.push_str("  ts_global_set(\"undefined\", TS_UNDEFINED);\n");
    s.push_str("  ts_global_set(\"NaN\", ts_num(0.0/0.0));\n");
    s.push_str("  ts_global_set(\"Infinity\", ts_num(1.0/0.0));\n");

    s.push_str("  tsv _Object = ts_make_global_fn(ts_fnval_global_Object, 1u, \"Object\", 0);\n");
    root_local(s, "_Object");
    set_val(s, "_Object", "prototype", "ts_object_proto()");
    set_val(s, "ts_object_proto()", "constructor", "_Object");
    set_fn(s, "_Object", "assign", "object.assign", 2, "assign");
    set_fn(s, "_Object", "create", "object.create", 1, "create");
    set_fn(
        s,
        "_Object",
        "getPrototypeOf",
        "object.getPrototypeOf",
        1,
        "getPrototypeOf",
    );
    set_fn(
        s,
        "_Object",
        "setPrototypeOf",
        "object.setPrototypeOf",
        2,
        "setPrototypeOf",
    );
    set_fn(s, "_Object", "keys", "object.keys", 1, "keys");
    set_fn(
        s,
        "_Object",
        "getOwnPropertyNames",
        "object.getOwnPropertyNames",
        1,
        "getOwnPropertyNames",
    );
    set_fn(
        s,
        "_Object",
        "getOwnPropertySymbols",
        "object.getOwnPropertySymbols",
        1,
        "getOwnPropertySymbols",
    );
    set_fn(s, "_Object", "values", "object.values", 1, "values");
    set_fn(s, "_Object", "entries", "object.entries", 1, "entries");
    set_fn(
        s,
        "_Object",
        "fromEntries",
        "object.fromEntries",
        1,
        "fromEntries",
    );
    set_fn(s, "_Object", "freeze", "object.freeze", 1, "freeze");
    set_fn(s, "_Object", "seal", "object.seal", 1, "seal");
    set_fn(
        s,
        "_Object",
        "preventExtensions",
        "object.preventExtensions",
        1,
        "preventExtensions",
    );
    set_fn(s, "_Object", "isFrozen", "object.isFrozen", 1, "isFrozen");
    set_fn(s, "_Object", "isSealed", "object.isSealed", 1, "isSealed");
    set_fn(
        s,
        "_Object",
        "isExtensible",
        "object.isExtensible",
        1,
        "isExtensible",
    );
    set_fn(s, "_Object", "hasOwn", "object.hasOwn", 2, "hasOwn");
    set_fn(s, "_Object", "is", "object.is", 2, "is");
    set_fn(
        s,
        "_Object",
        "getOwnPropertyDescriptor",
        "object.getOwnPropertyDescriptor",
        2,
        "getOwnPropertyDescriptor",
    );
    set_fn(
        s,
        "_Object",
        "getOwnPropertyDescriptors",
        "object.getOwnPropertyDescriptors",
        1,
        "getOwnPropertyDescriptors",
    );
    global_set_rooted(s, "Object", "_Object");

    s.push_str("  tsv _Array = ts_make_global_fn(ts_fnval_global_Array, 1u, \"Array\", 0);\n");
    root_local(s, "_Array");
    set_val(s, "_Array", "prototype", "ts_array_proto()");
    set_val(s, "ts_array_proto()", "constructor", "_Array");
    set_fn(s, "_Array", "isArray", "array.isArray", 1, "isArray");
    set_fn(s, "_Array", "from", "array.from", 1, "from");
    set_fn(s, "_Array", "of", "array.of", 0, "of");
    global_set_rooted(s, "Array", "_Array");

    s.push_str(
        "  tsv _Promise = ts_make_global_fn(ts_fnval_global_Promise, 1u, \"Promise\", 0);\n",
    );
    root_local(s, "_Promise");
    set_val(s, "_Promise", "prototype", "ts_promise_proto()");
    set_val(s, "ts_promise_proto()", "constructor", "_Promise");
    set_fn(s, "_Promise", "resolve", "promise.resolve", 1, "resolve");
    set_fn(s, "_Promise", "reject", "promise.reject", 1, "reject");
    set_fn(s, "_Promise", "all", "promise.all", 1, "all");
    set_fn(s, "_Promise", "race", "promise.race", 1, "race");
    set_fn(
        s,
        "_Promise",
        "allSettled",
        "promise.allSettled",
        1,
        "allSettled",
    );
    set_fn(s, "_Promise", "any", "promise.any", 1, "any");
    global_set_rooted(s, "Promise", "_Promise");

    s.push_str(
        "  tsv _Headers = ts_make_global_fn(ts_fnval_global_Headers, 1u, \"Headers\", 0);\n",
    );
    root_local(s, "_Headers");
    set_val(s, "_Headers", "prototype", "ts_headers_proto()");
    set_val(s, "ts_headers_proto()", "constructor", "_Headers");
    global_set_rooted(s, "Headers", "_Headers");

    s.push_str("  tsv _AbortController = ts_make_global_fn(ts_fnval_global_AbortController, 0u, \"AbortController\", 0);\n");
    root_local(s, "_AbortController");
    set_val(
        s,
        "_AbortController",
        "prototype",
        "ts_abort_controller_proto()",
    );
    set_val(
        s,
        "ts_abort_controller_proto()",
        "constructor",
        "_AbortController",
    );
    global_set_rooted(s, "AbortController", "_AbortController");

    s.push_str("  tsv _AbortSignal = ts_make_global_fn(ts_fnval_global_AbortSignal, 0u, \"AbortSignal\", 0);\n");
    root_local(s, "_AbortSignal");
    set_val(s, "_AbortSignal", "prototype", "ts_abort_signal_proto()");
    set_val(s, "ts_abort_signal_proto()", "constructor", "_AbortSignal");
    set_fn(
        s,
        "_AbortSignal",
        "timeout",
        "abortsignal.timeout",
        1,
        "timeout",
    );
    global_set_rooted(s, "AbortSignal", "_AbortSignal");

    s.push_str("  tsv _Map = ts_make_global_fn(ts_fnval_global_Map, 0u, \"Map\", 0);\n");
    root_local(s, "_Map");
    set_val(s, "_Map", "prototype", "ts_map_proto()");
    set_val(s, "ts_map_proto()", "constructor", "_Map");
    global_set_rooted(s, "Map", "_Map");
    s.push_str("  tsv _Set = ts_make_global_fn(ts_fnval_global_Set, 0u, \"Set\", 0);\n");
    root_local(s, "_Set");
    set_val(s, "_Set", "prototype", "ts_set_proto_obj()");
    set_val(s, "ts_set_proto_obj()", "constructor", "_Set");
    global_set_rooted(s, "Set", "_Set");
    s.push_str(
        "  tsv _WeakMap = ts_make_global_fn(ts_fnval_global_WeakMap, 0u, \"WeakMap\", 0);\n",
    );
    root_local(s, "_WeakMap");
    set_val(s, "_WeakMap", "prototype", "ts_weakmap_proto()");
    set_val(s, "ts_weakmap_proto()", "constructor", "_WeakMap");
    global_set_rooted(s, "WeakMap", "_WeakMap");
    s.push_str(
        "  tsv _WeakSet = ts_make_global_fn(ts_fnval_global_WeakSet, 0u, \"WeakSet\", 0);\n",
    );
    root_local(s, "_WeakSet");
    set_val(s, "_WeakSet", "prototype", "ts_weakset_proto_obj()");
    set_val(s, "ts_weakset_proto_obj()", "constructor", "_WeakSet");
    global_set_rooted(s, "WeakSet", "_WeakSet");

    s.push_str("  tsv _String = ts_make_global_fn(ts_fnval_global_String, 1u, \"String\", 0);\n");
    root_local(s, "_String");
    set_val(s, "_String", "prototype", "ts_string_proto()");
    set_val(s, "ts_string_proto()", "constructor", "_String");
    set_fn(
        s,
        "_String",
        "fromCharCode",
        "string.fromCharCode",
        1,
        "fromCharCode",
    );
    set_fn(
        s,
        "_String",
        "fromCodePoint",
        "string.fromCodePoint",
        1,
        "fromCodePoint",
    );
    global_set_rooted(s, "String", "_String");

    s.push_str("  tsv _Number = ts_make_global_fn(ts_fnval_global_Number, 1u, \"Number\", 0);\n");
    root_local(s, "_Number");
    set_val(s, "_Number", "prototype", "ts_number_proto()");
    set_val(s, "ts_number_proto()", "constructor", "_Number");
    set_fn(
        s,
        "_Number",
        "isInteger",
        "number.isInteger",
        1,
        "isInteger",
    );
    set_fn(s, "_Number", "isFinite", "number.isFinite", 1, "isFinite");
    set_fn(s, "_Number", "isNaN", "number.isNaN", 1, "isNaN");
    set_fn(
        s,
        "_Number",
        "isSafeInteger",
        "number.isSafeInteger",
        1,
        "isSafeInteger",
    );
    set_fn(
        s,
        "_Number",
        "parseFloat",
        "number.parseFloat",
        1,
        "parseFloat",
    );
    set_fn(s, "_Number", "parseInt", "number.parseInt", 2, "parseInt");
    set_val(
        s,
        "_Number",
        "MAX_SAFE_INTEGER",
        "ts_num(9007199254740991.0)",
    );
    set_val(
        s,
        "_Number",
        "MIN_SAFE_INTEGER",
        "ts_num(-9007199254740991.0)",
    );
    set_val(s, "_Number", "MAX_VALUE", "ts_num(1.7976931348623157e308)");
    set_val(s, "_Number", "MIN_VALUE", "ts_num(5e-324)");
    set_val(s, "_Number", "EPSILON", "ts_num(2.220446049250313e-16)");
    global_set_rooted(s, "Number", "_Number");

    s.push_str(
        "  tsv _Boolean = ts_make_global_fn(ts_fnval_global_Boolean, 1u, \"Boolean\", 0);\n",
    );
    root_local(s, "_Boolean");
    set_val(s, "_Boolean", "prototype", "ts_boolean_proto()");
    global_set_rooted(s, "Boolean", "_Boolean");

    /* Initialize well-known symbol singletons before rooting _Symbol. ts_wksym()
    installs permanent GC roots; pushing them above a short-lived setup local
    would violate the root stack's LIFO discipline. */
    s.push_str("  (void)ts_wksym(0u);\n");
    s.push_str("  tsv _Symbol = ts_make_global_fn(ts_fnval_global_Symbol, 0u, \"Symbol\", 0);\n");
    root_local(s, "_Symbol");
    set_val(s, "_Symbol", "prototype", "ts_new_object()");
    set_fn(s, "_Symbol", "for", "symbol.for", 1, "for");
    set_fn(s, "_Symbol", "keyFor", "symbol.keyFor", 1, "keyFor");
    set_val(s, "_Symbol", "iterator", "ts_wksym(0u)");
    set_val(s, "_Symbol", "asyncIterator", "ts_wksym(1u)");
    set_val(s, "_Symbol", "toPrimitive", "ts_wksym(2u)");
    set_val(s, "_Symbol", "hasInstance", "ts_wksym(3u)");
    set_val(s, "_Symbol", "toStringTag", "ts_wksym(4u)");
    global_set_rooted(s, "Symbol", "_Symbol");

    s.push_str(
        "  tsv _Function = ts_make_global_fn(ts_fnval_global_Function, 1u, \"Function\", 0);\n",
    );
    root_local(s, "_Function");
    set_val(s, "_Function", "prototype", "ts_function_proto()");
    set_val(s, "ts_function_proto()", "constructor", "_Function");
    global_set_rooted(s, "Function", "_Function");

    s.push_str("  tsv _Date = ts_make_global_fn(ts_fnval_global_Date, 7u, \"Date\", 0);\n");
    root_local(s, "_Date");
    set_val(s, "_Date", "prototype", "ts_new_object()");
    set_fn(s, "_Date", "now", "date.now", 0, "now");
    global_set_rooted(s, "Date", "_Date");

    for (idx, name) in [
        "Error",
        "TypeError",
        "RangeError",
        "SyntaxError",
        "ReferenceError",
        "EvalError",
        "URIError",
        "AggregateError",
    ]
    .iter()
    .enumerate()
    {
        let _ = writeln!(
            s,
            "  tsv _{} = ts_make_global_fn({}, 1u, {}, 0);",
            name,
            fnval_adapter_name(&format!("global.{}", name)),
            cstr(name)
        );
        root_local(s, &format!("_{}", name));
        // The constructor's `.prototype` is the shared runtime Error-family
        // prototype object (chained subtype -> Error -> Object), so `instanceof`
        // and inherited `name` work against `new Error()` instances.
        let _ = writeln!(
            s,
            "  ts_set_cstr(_{}, \"prototype\", ts_error_proto({}));",
            name, idx
        );
        // Wire `<proto>.constructor` back to the constructor value (mirrors
        // Function.prototype.constructor above), so `new TypeError().constructor`
        // is `TypeError` and `.constructor.name` is "TypeError" (not "Object",
        // inherited from Object.prototype). Subtype protos override the inherited
        // Error.prototype.constructor with their own constructor.
        set_val(s, &format!("ts_error_proto({})", idx), "constructor", &format!("_{}", name));
        global_set_rooted(s, name, &format!("_{}", name));
    }

    s.push_str("  tsv _Math = ts_new_object();\n");
    root_local(s, "_Math");
    for (prop, expr) in [
        ("PI", "ts_num(3.14159265358979323846264338327950288)"),
        ("E", "ts_num(2.71828182845904523536028747135266250)"),
        ("LN2", "ts_num(0.693147180559945309417232121458176568)"),
        ("LN10", "ts_num(2.30258509299404568401799145468436421)"),
        ("LOG2E", "ts_num(1.44269504088896340735992468100189214)"),
        ("LOG10E", "ts_num(0.434294481903251827651128918916605082)"),
        ("SQRT2", "ts_num(1.41421356237309504880168872420969808)"),
        ("SQRT1_2", "ts_num(0.707106781186547524400844362104849039)"),
    ] {
        set_val(s, "_Math", prop, expr);
    }
    for (prop, builtin, arity) in [
        ("sqrt", "math.sqrt", 1),
        ("abs", "math.abs", 1),
        ("floor", "math.floor", 1),
        ("ceil", "math.ceil", 1),
        ("round", "math.round", 1),
        ("trunc", "math.trunc", 1),
        ("sign", "math.sign", 1),
        ("sin", "math.sin", 1),
        ("cos", "math.cos", 1),
        ("tan", "math.tan", 1),
        ("asin", "math.asin", 1),
        ("acos", "math.acos", 1),
        ("atan", "math.atan", 1),
        ("sinh", "math.sinh", 1),
        ("cosh", "math.cosh", 1),
        ("tanh", "math.tanh", 1),
        ("exp", "math.exp", 1),
        ("log", "math.log", 1),
        ("log2", "math.log2", 1),
        ("log10", "math.log10", 1),
        ("cbrt", "math.cbrt", 1),
        ("asinh", "math.asinh", 1),
        ("acosh", "math.acosh", 1),
        ("atanh", "math.atanh", 1),
        ("expm1", "math.expm1", 1),
        ("log1p", "math.log1p", 1),
        ("fround", "math.fround", 1),
        ("f16round", "math.f16round", 1),
        ("clz32", "math.clz32", 1),
        ("imul", "math.imul", 2),
        ("pow", "math.pow", 2),
        ("atan2", "math.atan2", 2),
        ("max", "math.max", 2),
        ("min", "math.min", 2),
        ("hypot", "math.hypot", 2),
        ("random", "math.random", 0),
    ] {
        set_fn(s, "_Math", prop, builtin, arity, prop);
    }
    global_set_rooted(s, "Math", "_Math");

    s.push_str("  tsv _JSON = ts_new_object();\n");
    root_local(s, "_JSON");
    set_fn(s, "_JSON", "stringify", "json.stringify", 1, "stringify");
    set_fn(s, "_JSON", "parse", "json.parse", 2, "parse");
    global_set_rooted(s, "JSON", "_JSON");

    s.push_str("  tsv _console = ts_new_object();\n");
    root_local(s, "_console");
    set_fn(s, "_console", "log", "console.log", 0, "log");
    set_fn(s, "_console", "info", "console.log", 0, "info");
    set_fn(s, "_console", "debug", "console.log", 0, "debug");
    set_fn(s, "_console", "warn", "console.error", 0, "warn");
    set_fn(s, "_console", "error", "console.error", 0, "error");
    set_fn(s, "_console", "dir", "console.dir", 1, "dir");
    global_set_rooted(s, "console", "_console");

    s.push_str("  ts_global_set(\"parseInt\", ts_make_global_fn(ts_fnval_global_parseInt, 2u, \"parseInt\", 0));\n");
    s.push_str("  ts_global_set(\"parseFloat\", ts_make_global_fn(ts_fnval_global_parseFloat, 1u, \"parseFloat\", 0));\n");
    s.push_str(
        "  ts_global_set(\"isNaN\", ts_make_global_fn(ts_fnval_global_isNaN, 1u, \"isNaN\", 0));\n",
    );
    s.push_str("  ts_global_set(\"isFinite\", ts_make_global_fn(ts_fnval_global_isFinite, 1u, \"isFinite\", 0));\n");
    if needs_fetch {
        s.push_str(
            "  ts_global_set(\"fetch\", ts_make_global_fn(ts_fnval_global_fetch, 1u, \"fetch\", 0));\n",
        );
    }
    if needs_typed_array_globals {
        s.push_str("  ts_typed_array_globals();\n");
    }
    s.push_str("}\n\n");
}

/// A view element read (TA2, docs/typed_arrays_design.md): the typed load in
/// line; the generic element entry for any other receiver, element type or
/// index, linked like the array read's slow path. An unboxed destination
/// takes the double; a boxed one keeps undefined for an index out of range.
fn emit_view_load(s: &mut String, ctx: &Ctx, dst: u32, arr: u32, index: u32, elem: u8) {
    let a = ctx.val(arr);
    let int_key = ctx.unboxed.contains(&index) && ctx.int_local.contains(&index);
    let (try_fn, i, slow_fn) = if int_key {
        ("ts_ta_try_load_i", format!("d{}", index), "ts_array_get_key_i64")
    } else {
        ("ts_ta_try_load_f", ctx.num(index), "ts_array_get_key_f64")
    };
    let slow = ctx.lazy_linked(&format!("{}({}, {})", slow_fn, a, i));
    if int_key {
        let hoisted = ctx.ta_hoisted.borrow().get(&arr).copied();
        if let Some((helem, top)) = hoisted {
            if helem == elem {
                // the receiver's test and length were read before the loop
                let tah = format!("_tah{}_{}", arr, top);
                let inb = format!("((uint64_t)d{} < _tal{}_{})", index, arr, top);
                if int32_codegen_enabled() && elem <= 6 && ctx.int32_use.contains(&dst) {
                    let _ = writeln!(
                        s,
                        "  d{} = {} ? ts_ta_elem_load_i32({}->data, (uint32_t)d{}, {}) : ts_to_int32(ts_number_coerce({}));",
                        dst, inb, tah, index, elem, slow
                    );
                } else if ctx.unboxed.contains(&dst) && !ctx.int_local.contains(&dst) {
                    let e = format!(
                        "({} ? ts_ta_elem_load({}->data, (uint32_t)d{}, {}) : ts_number_coerce({}))",
                        inb, tah, index, elem, slow
                    );
                    s.push_str(&ctx.set_num(dst, &e));
                } else {
                    let e = format!(
                        "({} ? ts_num(ts_ta_elem_load({}->data, (uint32_t)d{}, {})) : {})",
                        inb, tah, index, elem, slow
                    );
                    s.push_str(&ctx.set_val(dst, &e));
                }
                return;
            }
        }
    }
    if int32_codegen_enabled() && int_key && elem <= 6 && ctx.int32_use.contains(&dst) {
        // an integer element kind (Int8 .. Uint32) read into a local that holds
        // ToInt32 of its value: the element as an int32 (Uint32 wraps), the
        // slow path converted once
        let _ = writeln!(
            s,
            "  d{} = ({{ int32_t _ti; if (!ts_ta_try_load_i32({}, {}, {}, &_ti)) _ti = ts_to_int32(ts_number_coerce({})); _ti; }});",
            dst, a, i, elem, slow
        );
        return;
    }
    if ctx.unboxed.contains(&dst) && !ctx.int_local.contains(&dst) {
        // a non-view receiver's element (an `any` cast) through ToNumber: a
        // string element reads its number, not its bits
        let conv = if int32_codegen_enabled() { "ts_number_coerce" } else { "ts_to_num" };
        let e = format!(
            "({{ double _ta; if (!{}({}, {}, {}, &_ta)) _ta = {}({}); _ta; }})",
            try_fn, a, i, elem, conv, slow
        );
        s.push_str(&ctx.set_num(dst, &e));
    } else {
        let e = format!(
            "({{ double _ta; tsv _tv; if ({}({}, {}, {}, &_ta)) _tv = ts_num(_ta); else _tv = {}; _tv; }})",
            try_fn, a, i, elem, slow
        );
        s.push_str(&ctx.set_val(dst, &e));
    }
}

/// A view element store of a numeric value (TA2): the converted store in
/// line; the generic element entry, linked, otherwise.
fn emit_view_store(s: &mut String, ctx: &Ctx, arr: u32, index: u32, src: u32, elem: u8) {
    let a = ctx.val(arr);
    let int_key = ctx.unboxed.contains(&index) && ctx.int_local.contains(&index);
    let (try_fn, i, slow_fn) = if int_key {
        ("ts_ta_try_store_i", format!("d{}", index), "ts_array_set_key_i64")
    } else {
        ("ts_ta_try_store_f", ctx.num(index), "ts_array_set_key_f64")
    };
    let slow = ctx.lazy_linked_stmt(&format!("{}({}, {}, ts_num(_tx))", slow_fn, a, i));
    if int_key {
        let hoisted = ctx.ta_hoisted.borrow().get(&arr).copied();
        if let Some((helem, top)) = hoisted {
            if helem == elem {
                let _ = writeln!(
                    s,
                    "  {{ double _tx = {}; if ((uint64_t)d{} < _tal{a}_{t}) ts_ta_elem_store(_tah{a}_{t}->data, (uint32_t)d{}, _tx, {}); else {} }}",
                    ctx.num(src),
                    index,
                    index,
                    elem,
                    slow,
                    a = arr,
                    t = top
                );
                return;
            }
        }
    }
    let _ = writeln!(
        s,
        "  {{ double _tx = {}; if (!{}({}, {}, _tx, {})) {} }}",
        ctx.num(src),
        try_fn,
        a,
        i,
        elem,
        slow
    );
}

fn emit_scalar_slice_calc(s: &mut String, dst: u32, spec: &ScalarStringSlice, ctx: &Ctx) {
    let base = ctx.val(spec.base);
    let len_tmp = format!("_ssn{}", dst);
    let start_tmp = format!("_ssa{}", dst);
    let end_tmp = format!("_ssb{}", dst);
    let start_expr = spec
        .start
        .map(|id| ctx.numc(id))
        .unwrap_or_else(|| "0".to_string());
    let end_expr = spec
        .end
        .map(|id| if ctx.unboxed.contains(&id) { ctx.numc(id) } else {
            format!("(ts_is_undefined_fast({}) ? (double){} : {})", ctx.val(id), len_tmp, ctx.numc(id))
        })
        .unwrap_or_else(|| len_tmp.clone());

    let _ = writeln!(
        s,
        "  {{ long long {} = (long long)ts_str_len_typed({});",
        len_tmp, base
    );
    let _ = writeln!(s, "    ss_base{} = {};", spec.root, base);
    if spec.start.map_or(true, |id| ctx.int_local.contains(&id)) {
        let _ = writeln!(s, "    long long {} = (long long)({});", start_tmp, start_expr);
    } else {
        let _ = writeln!(s,
            "    double _ssda{0} = {1};\n    long long {2} = isnan(_ssda{0}) ? 0 : (long long)fmax(-(double){3}, fmin((double){3}, _ssda{0}));",
            dst, start_expr, start_tmp, len_tmp);
    }
    if spec.end.map_or(true, |id| ctx.int_local.contains(&id)) {
        let _ = writeln!(s, "    long long {} = (long long)({});", end_tmp, end_expr);
    } else {
        let _ = writeln!(s,
            "    double _ssdb{0} = {1};\n    long long {2} = isnan(_ssdb{0}) ? 0 : (long long)fmax(-(double){3}, fmin((double){3}, _ssdb{0}));",
            dst, end_expr, end_tmp, len_tmp);
    }
    match spec.kind {
        ScalarSliceKind::Slice => {
            let _ = writeln!(
                s,
                "    if ((uint64_t){} <= (uint64_t){} && (uint64_t){} <= (uint64_t){} && {} >= {}) {{",
                start_tmp, len_tmp, end_tmp, len_tmp, end_tmp, start_tmp
            );
            let _ = writeln!(
                s,
                "      ss_start{} = {}; ss_len{} = {} - {}; ss_fast{} = 1;",
                spec.root, start_tmp, spec.root, end_tmp, start_tmp, spec.root
            );
            s.push_str("    } else {\n");
            let _ = writeln!(s, "      ss_fast{} = 0;", spec.root);
            let _ = writeln!(
                s,
                "      if ({} < 0) {} += {};",
                start_tmp, start_tmp, len_tmp
            );
            let _ = writeln!(s, "      if ({} < 0) {} += {};", end_tmp, end_tmp, len_tmp);
            let _ = writeln!(s, "      if ({} < 0) {} = 0;", start_tmp, start_tmp);
            let _ = writeln!(
                s,
                "      if ({} > {}) {} = {};",
                start_tmp, len_tmp, start_tmp, len_tmp
            );
            let _ = writeln!(s, "      if ({} < 0) {} = 0;", end_tmp, end_tmp);
            let _ = writeln!(
                s,
                "      if ({} > {}) {} = {};",
                end_tmp, len_tmp, end_tmp, len_tmp
            );
            let _ = writeln!(
                s,
                "      if ({} < {}) {} = {};",
                end_tmp, start_tmp, end_tmp, start_tmp
            );
            let _ = writeln!(
                s,
                "      ss_start{} = {}; ss_len{} = {} - {};",
                spec.root, start_tmp, spec.root, end_tmp, start_tmp
            );
            s.push_str("    }\n");
        }
        ScalarSliceKind::Substring => {
            let swap_tmp = format!("_sst{}", dst);
            let _ = writeln!(
                s,
                "    if ((uint64_t){} <= (uint64_t){} && (uint64_t){} <= (uint64_t){}) {{",
                start_tmp, len_tmp, end_tmp, len_tmp
            );
            let _ = writeln!(s, "      ss_fast{} = 1;", spec.root);
            let _ = writeln!(
                s,
                "      if ({} <= {}) {{ ss_start{} = {}; ss_len{} = {} - {}; }} else {{ ss_start{} = {}; ss_len{} = {} - {}; }}",
                start_tmp,
                end_tmp,
                spec.root,
                start_tmp,
                spec.root,
                end_tmp,
                start_tmp,
                spec.root,
                end_tmp,
                spec.root,
                start_tmp,
                end_tmp
            );
            s.push_str("    } else {\n");
            let _ = writeln!(s, "      ss_fast{} = 0;", spec.root);
            let _ = writeln!(s, "      if ({} < 0) {} = 0;", start_tmp, start_tmp);
            let _ = writeln!(
                s,
                "      if ({} > {}) {} = {};",
                start_tmp, len_tmp, start_tmp, len_tmp
            );
            let _ = writeln!(s, "      if ({} < 0) {} = 0;", end_tmp, end_tmp);
            let _ = writeln!(
                s,
                "      if ({} > {}) {} = {};",
                end_tmp, len_tmp, end_tmp, len_tmp
            );
            let _ = writeln!(
                s,
                "      if ({} > {}) {{ long long {} = {}; {} = {}; {} = {}; }}",
                start_tmp, end_tmp, swap_tmp, start_tmp, start_tmp, end_tmp, end_tmp, swap_tmp
            );
            let _ = writeln!(
                s,
                "      ss_start{} = {}; ss_len{} = {} - {};",
                spec.root, start_tmp, spec.root, end_tmp, start_tmp
            );
            s.push_str("    }\n");
        }
    }
    s.push_str("  }\n");
}

fn scalar_slice_charcodeat_expr(spec: &ScalarStringSlice, args: &[LocalId], ctx: &Ctx) -> String {
    let idx = match args.first() {
        Some(a) if ctx.int_const.contains_key(&a.0) => ctx.int_const[&a.0].to_string(),
        Some(a) if ctx.int_local.contains(&a.0) => format!("d{}", a.0),
        Some(a) => ctx.numc(a.0),
        None => "0".to_string(),
    };
    let len = spec
        .exact_len
        .map(|n| n.to_string())
        .unwrap_or_else(|| format!("ss_len{}", spec.root));
    format!(
        "ts_str_slice_charcodeat_typed(ss_base{}, ss_start{}, {}, {})",
        spec.root, spec.root, len, idx
    )
}

fn scalar_affine_expr(a: ScalarAffine, ctx: &Ctx) -> Option<String> {
    match a.base {
        Some(base) => {
            let b = ctx.num(base);
            match a.offset.cmp(&0) {
                std::cmp::Ordering::Equal => Some(b),
                std::cmp::Ordering::Greater => Some(format!("({} + {}LL)", b, a.offset)),
                std::cmp::Ordering::Less => Some(format!("({} - {}LL)", b, -a.offset)),
            }
        }
        None => Some(format!("{}LL", a.offset)),
    }
}

fn scalar_slice_fast_guard(
    spec: &ScalarStringSlice,
    affines: &BTreeMap<u32, ScalarAffine>,
    len_expr: &str,
    ctx: &Ctx,
) -> Option<String> {
    let start = scalar_affine_of(affines, spec.start?);
    let end = scalar_affine_of(affines, spec.end?);
    let a = scalar_affine_expr(start, ctx)?;
    let b = scalar_affine_expr(end, ctx)?;
    match spec.kind {
        ScalarSliceKind::Slice => Some(format!(
            "((uint64_t)({a}) <= (uint64_t)({len}) && (uint64_t)({b}) <= (uint64_t)({len}) && ({b}) >= ({a}))",
            a = a,
            b = b,
            len = len_expr
        )),
        ScalarSliceKind::Substring => Some(format!(
            "((uint64_t)({a}) <= (uint64_t)({len}) && (uint64_t)({b}) <= (uint64_t)({len}))",
            a = a,
            b = b,
            len = len_expr
        )),
    }
}

fn scalar_slice_start_affine(
    spec: &ScalarStringSlice,
    affines: &BTreeMap<u32, ScalarAffine>,
) -> Option<ScalarAffine> {
    let start = scalar_affine_of(affines, spec.start?);
    let end = spec.end.map(|id| scalar_affine_of(affines, id));
    match spec.kind {
        ScalarSliceKind::Slice => Some(start),
        ScalarSliceKind::Substring => {
            let end = end?;
            if start.base != end.base {
                return None;
            }
            if start.offset <= end.offset {
                Some(start)
            } else {
                Some(end)
            }
        }
    }
}

fn scalar_slice_char_affine(
    spec: &ScalarStringSlice,
    idx: i64,
    affines: &BTreeMap<u32, ScalarAffine>,
) -> Option<ScalarAffine> {
    let mut a = scalar_slice_start_affine(spec, affines)?;
    a.offset = a.offset.checked_add(idx)?;
    Some(a)
}

fn combined_scalar_slice_range_guard(
    specs: &[&ScalarStringSlice],
    affines: &BTreeMap<u32, ScalarAffine>,
    len_expr: &str,
    ctx: &Ctx,
) -> Option<String> {
    let mut base = None;
    let mut min_offset = i64::MAX;
    let mut max_offset = i64::MIN;
    for spec in specs {
        let start = scalar_affine_of(affines, spec.start?);
        let end = scalar_affine_of(affines, spec.end?);
        if start.base != end.base {
            return None;
        }
        if let Some(b) = base {
            if start.base != Some(b) {
                return None;
            }
        } else {
            base = start.base;
        }
        if spec.kind == ScalarSliceKind::Slice && end.offset < start.offset {
            return None;
        }
        min_offset = min_offset.min(start.offset).min(end.offset);
        max_offset = max_offset.max(start.offset).max(end.offset);
    }
    let base = base?;
    let min_expr = scalar_affine_expr(
        ScalarAffine {
            base: Some(base),
            offset: min_offset,
        },
        ctx,
    )?;
    let max_expr = scalar_affine_expr(
        ScalarAffine {
            base: Some(base),
            offset: max_offset,
        },
        ctx,
    )?;
    Some(format!(
        "(({}) >= 0 && (uint64_t)({}) <= (uint64_t)({}))",
        min_expr, max_expr, len_expr
    ))
}

fn fused_scalar_slice_loop_base(body: &[Inst], ctx: &Ctx) -> Option<u32> {
    if body.len() != 30 {
        return None;
    }
    let (
        Inst::CallBuiltin {
            dst: Some(slice1),
            builtin: builtin1,
            recv: base1,
            ..
        },
        Inst::Copy {
            dst: alias1,
            src: slice1_copy,
        },
        Inst::CallBuiltin {
            dst: Some(slice2),
            builtin: builtin2,
            recv: base2,
            ..
        },
        Inst::Copy {
            dst: alias2,
            src: slice2_copy,
        },
    ) = (&body[7], &body[8], &body[13], &body[14])
    else {
        return None;
    };
    if builtin1 != "string.slice"
        || builtin2 != "string.substring"
        || slice1.0 != slice1_copy.0
        || slice2.0 != slice2_copy.0
        || base1.0 != base2.0
        || ctx
            .scalar_slice(alias1.0)
            .and_then(|s| s.exact_len)
            .is_none()
        || ctx
            .scalar_slice(alias2.0)
            .and_then(|s| s.exact_len)
            .is_none()
        || body
            .iter()
            .any(|inst| inst_def_local(inst) == Some(base1.0))
    {
        return None;
    }
    Some(base1.0)
}

fn fused_scalar_slice_loop_precondition(
    body: &[Inst],
    ctx: &Ctx,
    view_var: &str,
) -> Option<String> {
    let (
        Inst::BinOp {
            dst: add_tmp,
            op: add_op,
            lhs: add_lhs,
            rhs: add_rhs,
        },
        Inst::Copy {
            dst: start_copy,
            src: add_src,
        },
        Inst::BinOp {
            dst: cmp_tmp,
            op: cmp_op,
            lhs: cmp_lhs,
            rhs: span,
        },
        Inst::If {
            cond,
            then_body,
            else_body,
        },
    ) = (&body[1], &body[2], &body[3], &body[4])
    else {
        return None;
    };
    if add_op != "+"
        || cmp_op != ">="
        || add_tmp.0 != add_src.0
        || cmp_tmp.0 != cond.0
        || cmp_lhs.0 != start_copy.0
        || !else_body.is_empty()
        || then_body.len() != 2
    {
        return None;
    }
    let start = start_copy.0;
    let inc = if add_lhs.0 == start {
        ctx.int_const.get(&add_rhs.0).copied()
    } else if add_rhs.0 == start {
        ctx.int_const.get(&add_lhs.0).copied()
    } else {
        None
    }?;
    let (
        Inst::BinOp {
            dst: sub_tmp,
            op: sub_op,
            lhs: sub_lhs,
            rhs: sub_rhs,
        },
        Inst::Copy {
            dst: sub_dst,
            src: sub_src,
        },
    ) = (&then_body[0], &then_body[1])
    else {
        return None;
    };
    if sub_op != "-"
        || sub_lhs.0 != start
        || sub_rhs.0 != span.0
        || sub_tmp.0 != sub_src.0
        || sub_dst.0 != start
    {
        return None;
    }

    let Inst::Copy {
        dst: alias1,
        src: _,
    } = &body[8]
    else {
        return None;
    };
    let Inst::Copy {
        dst: alias2,
        src: _,
    } = &body[14]
    else {
        return None;
    };
    let spec1 = ctx.scalar_slice(alias1.0)?;
    let spec2 = ctx.scalar_slice(alias2.0)?;
    let affines = scalar_slice_affines(body);
    let mut min_offset = i64::MAX;
    let mut max_offset = i64::MIN;
    for spec in [spec1, spec2] {
        let a = scalar_affine_of(&affines, spec.start?);
        let b = scalar_affine_of(&affines, spec.end?);
        if a.base != Some(start) || b.base != Some(start) {
            return None;
        }
        if spec.kind == ScalarSliceKind::Slice && b.offset < a.offset {
            return None;
        }
        min_offset = min_offset.min(a.offset).min(b.offset);
        max_offset = max_offset.max(a.offset).max(b.offset);
    }
    let Some(min_expr) = scalar_affine_expr(
        ScalarAffine {
            base: Some(start),
            offset: min_offset,
        },
        ctx,
    ) else {
        return None;
    };
    Some(format!(
        "({span} > {inc}LL && d{start} >= 0 && d{start} < {span} && ({min_expr}) >= 0 && (uint64_t)({span} + {max_offset}LL) <= (uint64_t)({view}.len))",
        span = ctx.num(span.0),
        inc = inc,
        start = start,
        min_expr = min_expr,
        max_offset = max_offset,
        view = view_var
    ))
}

fn try_emit_compact_fused_scalar_slice_loop_body(
    s: &mut String,
    body: &[Inst],
    ctx: &Ctx,
    view_var: &str,
    acc: u32,
    idx_expr1: &str,
    idx_expr2: &str,
    add_len: i64,
) -> Option<()> {
    if body.len() != 30 {
        return None;
    }
    if !matches!(&body[0], Inst::Const { .. }) || !matches!(&body[27], Inst::Const { .. }) {
        return None;
    }
    let (
        Inst::BinOp {
            dst: add_tmp,
            op: add_op,
            lhs: add_lhs,
            rhs: add_rhs,
        },
        Inst::Copy {
            dst: start_copy,
            src: add_src,
        },
        Inst::BinOp {
            dst: cmp_tmp,
            op: cmp_op,
            lhs: cmp_lhs,
            rhs: span,
        },
        Inst::If {
            cond,
            then_body,
            else_body,
        },
        Inst::BinOp {
            dst: counter_tmp,
            op: counter_op,
            lhs: counter_lhs,
            rhs: counter_rhs,
        },
        Inst::Copy {
            dst: counter_copy,
            src: counter_src,
        },
    ) = (&body[1], &body[2], &body[3], &body[4], &body[28], &body[29])
    else {
        return None;
    };
    if add_op != "+"
        || cmp_op != ">="
        || counter_op != "+"
        || add_tmp.0 != add_src.0
        || cmp_tmp.0 != cond.0
        || cmp_lhs.0 != start_copy.0
        || counter_tmp.0 != counter_src.0
        || !else_body.is_empty()
        || then_body.len() != 2
    {
        return None;
    }

    let start = start_copy.0;
    let start_inc = if add_lhs.0 == start {
        ctx.int_const.get(&add_rhs.0).copied()
    } else if add_rhs.0 == start {
        ctx.int_const.get(&add_lhs.0).copied()
    } else {
        None
    }?;
    if start_inc < 0 {
        return None;
    }

    let (
        Inst::BinOp {
            dst: sub_tmp,
            op: sub_op,
            lhs: sub_lhs,
            rhs: sub_rhs,
        },
        Inst::Copy {
            dst: sub_dst,
            src: sub_src,
        },
    ) = (&then_body[0], &then_body[1])
    else {
        return None;
    };
    if sub_op != "-"
        || sub_lhs.0 != start
        || sub_rhs.0 != span.0
        || sub_tmp.0 != sub_src.0
        || sub_dst.0 != start
    {
        return None;
    }

    let counter = counter_copy.0;
    let counter_inc = if counter_lhs.0 == counter {
        ctx.int_const.get(&counter_rhs.0).copied()
    } else if counter_rhs.0 == counter {
        ctx.int_const.get(&counter_lhs.0).copied()
    } else {
        None
    }?;
    if counter_inc < 0
        || !ctx.int_local.contains(&start)
        || !ctx.int_local.contains(&span.0)
        || !ctx.int_local.contains(&counter)
        || !ctx.int_local.contains(&acc)
    {
        return None;
    }

    let span_expr = ctx.num(span.0);
    let _ = writeln!(s, "  d{} += {}LL;", start, start_inc);
    let _ = writeln!(
        s,
        "  if (d{} >= {}) d{} -= {};",
        start, span_expr, start, span_expr
    );
    let _ = writeln!(
        s,
        "  d{} += (long long)ts_str_cu_at_view({}, {}) + (long long)ts_str_cu_at_view({}, {}) + {}LL;",
        acc, view_var, idx_expr1, view_var, idx_expr2, add_len
    );
    let _ = writeln!(s, "  d{} += {}LL;", counter, counter_inc);
    Some(())
}

fn fused_charcode_scan_loop_base(body: &[Inst]) -> Option<u32> {
    if body.len() != 12 {
        return None;
    }
    let Inst::CallBuiltin {
        dst: Some(_),
        builtin,
        recv,
        args,
    } = &body[6]
    else {
        return None;
    };
    if builtin != "string.charCodeAt"
        || args.len() != 1
        || body.iter().any(|inst| inst_def_local(inst) == Some(recv.0))
    {
        return None;
    }
    Some(recv.0)
}

fn fused_charcode_scan_loop_precondition(
    body: &[Inst],
    ctx: &Ctx,
    view_var: &str,
) -> Option<String> {
    let (
        Inst::BinOp {
            dst: add_tmp,
            op: add_op,
            lhs: add_lhs,
            rhs: add_rhs,
        },
        Inst::Copy {
            dst: idx_copy,
            src: add_src,
        },
        Inst::BinOp {
            dst: cmp_tmp,
            op: cmp_op,
            lhs: cmp_lhs,
            rhs: len,
        },
        Inst::If {
            cond,
            then_body,
            else_body,
        },
        Inst::CallBuiltin { args, .. },
    ) = (&body[1], &body[2], &body[3], &body[4], &body[6])
    else {
        return None;
    };
    if add_op != "+"
        || cmp_op != ">="
        || add_tmp.0 != add_src.0
        || cmp_tmp.0 != cond.0
        || cmp_lhs.0 != idx_copy.0
        || args.first().map(|a| a.0) != Some(idx_copy.0)
        || !else_body.is_empty()
        || then_body.len() != 2
    {
        return None;
    }
    let idx = idx_copy.0;
    let inc = if add_lhs.0 == idx {
        ctx.int_const.get(&add_rhs.0).copied()
    } else if add_rhs.0 == idx {
        ctx.int_const.get(&add_lhs.0).copied()
    } else {
        None
    }?;
    if inc < 0 || !ctx.int_local.contains(&idx) || !ctx.int_local.contains(&len.0) {
        return None;
    }
    let (
        Inst::BinOp {
            dst: sub_tmp,
            op: sub_op,
            lhs: sub_lhs,
            rhs: sub_rhs,
        },
        Inst::Copy {
            dst: sub_dst,
            src: sub_src,
        },
    ) = (&then_body[0], &then_body[1])
    else {
        return None;
    };
    if sub_op != "-"
        || sub_lhs.0 != idx
        || sub_rhs.0 != len.0
        || sub_tmp.0 != sub_src.0
        || sub_dst.0 != idx
    {
        return None;
    }
    let len_expr = ctx.num(len.0);
    Some(format!(
        "({len} > {inc}LL && d{idx} >= 0 && d{idx} < {len} && (uint64_t)({len}) <= (uint64_t)({view}.len))",
        len = len_expr,
        inc = inc,
        idx = idx,
        view = view_var
    ))
}

fn try_emit_fused_charcode_scan_loop_body(
    s: &mut String,
    body: &[Inst],
    ctx: &Ctx,
    view_var: &str,
) -> Option<()> {
    if body.len() != 12 {
        return None;
    }
    if !matches!(&body[0], Inst::Const { .. }) || !matches!(&body[9], Inst::Const { .. }) {
        return None;
    }
    let (
        Inst::BinOp {
            dst: add_tmp,
            op: add_op,
            lhs: add_lhs,
            rhs: add_rhs,
        },
        Inst::Copy {
            dst: idx_copy,
            src: add_src,
        },
        Inst::BinOp {
            dst: cmp_tmp,
            op: cmp_op,
            lhs: cmp_lhs,
            rhs: len,
        },
        Inst::If {
            cond,
            then_body,
            else_body,
        },
        Inst::Copy {
            dst: acc_alias,
            src: acc,
        },
        Inst::CallBuiltin {
            dst: Some(ch),
            builtin,
            args,
            ..
        },
        Inst::BinOp {
            dst: sum_tmp,
            op: sum_op,
            lhs: sum_lhs,
            rhs: sum_rhs,
        },
        Inst::Copy {
            dst: acc_dst,
            src: sum_src,
        },
        Inst::BinOp {
            dst: counter_tmp,
            op: counter_op,
            lhs: counter_lhs,
            rhs: counter_rhs,
        },
        Inst::Copy {
            dst: counter_copy,
            src: counter_src,
        },
    ) = (
        &body[1], &body[2], &body[3], &body[4], &body[5], &body[6], &body[7], &body[8], &body[10],
        &body[11],
    )
    else {
        return None;
    };
    if add_op != "+"
        || cmp_op != ">="
        || sum_op != "+"
        || counter_op != "+"
        || builtin != "string.charCodeAt"
        || add_tmp.0 != add_src.0
        || cmp_tmp.0 != cond.0
        || cmp_lhs.0 != idx_copy.0
        || args.first().map(|a| a.0) != Some(idx_copy.0)
        || sum_tmp.0 != sum_src.0
        || acc_dst.0 != acc.0
        || counter_tmp.0 != counter_src.0
        || !else_body.is_empty()
        || then_body.len() != 2
    {
        return None;
    }
    if !((sum_lhs.0 == acc_alias.0 && sum_rhs.0 == ch.0)
        || (sum_rhs.0 == acc_alias.0 && sum_lhs.0 == ch.0))
    {
        return None;
    }

    let idx = idx_copy.0;
    let idx_inc = if add_lhs.0 == idx {
        ctx.int_const.get(&add_rhs.0).copied()
    } else if add_rhs.0 == idx {
        ctx.int_const.get(&add_lhs.0).copied()
    } else {
        None
    }?;
    if idx_inc < 0 {
        return None;
    }
    let (
        Inst::BinOp {
            dst: sub_tmp,
            op: sub_op,
            lhs: sub_lhs,
            rhs: sub_rhs,
        },
        Inst::Copy {
            dst: sub_dst,
            src: sub_src,
        },
    ) = (&then_body[0], &then_body[1])
    else {
        return None;
    };
    if sub_op != "-"
        || sub_lhs.0 != idx
        || sub_rhs.0 != len.0
        || sub_tmp.0 != sub_src.0
        || sub_dst.0 != idx
    {
        return None;
    }

    let counter = counter_copy.0;
    let counter_inc = if counter_lhs.0 == counter {
        ctx.int_const.get(&counter_rhs.0).copied()
    } else if counter_rhs.0 == counter {
        ctx.int_const.get(&counter_lhs.0).copied()
    } else {
        None
    }?;
    if counter_inc < 0
        || !ctx.int_local.contains(&idx)
        || !ctx.int_local.contains(&len.0)
        || !ctx.int_local.contains(&counter)
        || !ctx.unboxed.contains(&acc.0)
    {
        return None;
    }

    let len_expr = ctx.num(len.0);
    let _ = writeln!(s, "  d{} += {}LL;", idx, idx_inc);
    let _ = writeln!(
        s,
        "  if (d{} >= {}) d{} -= {};",
        idx, len_expr, idx, len_expr
    );
    let _ = writeln!(
        s,
        "  d{} += (long long)ts_str_cu_at_view({}, (uint32_t)d{});",
        acc.0, view_var, idx
    );
    let _ = writeln!(s, "  d{} += {}LL;", counter, counter_inc);
    Some(())
}

fn static_string_expr_from_const(inst: &Inst, ctx: &Ctx) -> Option<String> {
    match inst {
        Inst::Const {
            value: ConstVal::Str { value },
            ..
        } => static_string_literal_expr(value, ctx),
        Inst::Const {
            value: ConstVal::Str16 { units },
            ..
        } => static_string_literal_expr_units(units, ctx),
        _ => None,
    }
}

fn static_string_literal_expr(value: &str, ctx: &Ctx) -> Option<String> {
    static_string_literal_expr_units(&str_units(value), ctx)
}

fn static_string_literal_expr_units(units: &[u16], ctx: &Ctx) -> Option<String> {
    let id = ctx.static_strings.get(units).copied()?;
    Some(format!("ts_str_v(&TS_STRLIT_{})", id))
}

fn emit_checked_loop<F>(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    ctx: &Ctx,
    mut emit_body: F,
) where
    F: FnMut(&mut String),
{
    s.push_str("  for (;;) {\n");
    for inst in cond_body {
        emit_inst(s, inst, ctx);
    }
    let _ = writeln!(s, "    if (!{}) break;", ctx.truthy(cond.0));
    emit_body(s);
    s.push_str("  }\n");
}

fn emit_runtime_loop(s: &mut String, cond: LocalId, cond_body: &[Inst], body: &[Inst], ctx: &Ctx) {
    emit_checked_loop(s, cond, cond_body, ctx, |s| {
        for inst in body {
            emit_inst(s, inst, ctx);
        }
    });
}

fn emit_select4_clamped(s: &mut String, dst: &str, expr: &str) {
    let _ = writeln!(
        s,
        "  long long {} = (long long){}; if ((uint64_t){} >= 4ULL) {} = 0;",
        dst, expr, dst, dst
    );
}

fn emit_tsv_array4(s: &mut String, name: &str, ctx: &Ctx, values: &[u32; 4]) {
    let _ = writeln!(
        s,
        "  tsv {}[4] = {{ {}, {}, {}, {} }};",
        name,
        ctx.val(values[0]),
        ctx.val(values[1]),
        ctx.val(values[2]),
        ctx.val(values[3])
    );
}

fn emit_tsv_undefined_array4(s: &mut String, name: &str) {
    let _ = writeln!(
        s,
        "  tsv {}[4] = {{ TS_UNDEFINED, TS_UNDEFINED, TS_UNDEFINED, TS_UNDEFINED }};",
        name
    );
}

fn try_emit_fused_string_search_loop(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
    top: u32,
) -> Option<()> {
    if body.len() != 20 {
        return None;
    }
    let (
        Inst::Copy {
            dst: acc_alias1,
            src: acc_src1,
        },
        needle1_const,
        Inst::CallBuiltin {
            dst: Some(index_res),
            builtin: index_builtin,
            recv: index_recv,
            args: index_args,
        },
        Inst::BinOp {
            dst: index_sum_tmp,
            op: index_sum_op,
            lhs: index_sum_lhs,
            rhs: index_sum_rhs,
        },
        Inst::Copy {
            dst: acc_after_index,
            src: index_sum_src,
        },
        Inst::Copy {
            dst: acc_alias2,
            src: acc_src2,
        },
        needle2_const,
        Inst::StringLen {
            dst: hay_len,
            src: len_src,
        },
        Inst::CallBuiltin {
            dst: Some(last_res),
            builtin: last_builtin,
            recv: last_recv,
            args: last_args,
        },
        Inst::BinOp {
            dst: last_sum_tmp,
            op: last_sum_op,
            lhs: last_sum_lhs,
            rhs: last_sum_rhs,
        },
        Inst::Copy {
            dst: acc_after_last,
            src: last_sum_src,
        },
        inc_const,
        Inst::BinOp {
            dst: from_add_tmp,
            op: from_add_op,
            lhs: from_add_lhs,
            rhs: from_add_rhs,
        },
        Inst::Copy {
            dst: from_copy,
            src: from_add_src,
        },
        wrap_const,
        Inst::BinOp {
            dst: wrap_cmp_tmp,
            op: wrap_cmp_op,
            lhs: wrap_cmp_lhs,
            rhs: wrap_cmp_rhs,
        },
        Inst::If {
            cond: wrap_cond,
            then_body,
            else_body,
        },
        counter_inc_const,
        Inst::BinOp {
            dst: counter_tmp,
            op: counter_op,
            lhs: counter_lhs,
            rhs: counter_rhs,
        },
        Inst::Copy {
            dst: counter_copy,
            src: counter_src,
        },
    ) = (
        &body[0], &body[1], &body[2], &body[3], &body[4], &body[5], &body[6], &body[7], &body[8],
        &body[9], &body[10], &body[11], &body[12], &body[13], &body[14], &body[15], &body[16],
        &body[17], &body[18], &body[19],
    )
    else {
        return None;
    };

    if index_builtin != "string.indexOf"
        || last_builtin != "string.lastIndexOf"
        || index_sum_op != "+"
        || last_sum_op != "+"
        || from_add_op != "+"
        || wrap_cmp_op != ">="
        || counter_op != "+"
        || index_recv.0 != last_recv.0
        || len_src.0 != index_recv.0
        || index_sum_tmp.0 != index_sum_src.0
        || last_sum_tmp.0 != last_sum_src.0
        || acc_after_index.0 != acc_src1.0
        || acc_after_last.0 != acc_after_index.0
        || acc_src2.0 != acc_after_index.0
        || wrap_cmp_tmp.0 != wrap_cond.0
        || wrap_cmp_lhs.0 != from_copy.0
        || wrap_cmp_rhs.0 != match_const_dst(wrap_const)?
        || from_add_tmp.0 != from_add_src.0
        || counter_tmp.0 != counter_src.0
        || !else_body.is_empty()
        || then_body.len() != 3
    {
        return None;
    }

    let acc = acc_after_last.0;
    if !((index_sum_lhs.0 == acc_alias1.0 && index_sum_rhs.0 == index_res.0)
        || (index_sum_rhs.0 == acc_alias1.0 && index_sum_lhs.0 == index_res.0))
        || !((last_sum_lhs.0 == acc_alias2.0 && last_sum_rhs.0 == last_res.0)
            || (last_sum_rhs.0 == acc_alias2.0 && last_sum_lhs.0 == last_res.0))
    {
        return None;
    }

    if index_args.len() != 2
        || last_args.len() != 2
        || index_args[0].0 != match_const_dst(needle1_const)?
        || last_args[0].0 != match_const_dst(needle2_const)?
        || last_args[1].0 != hay_len.0
    {
        return None;
    }
    let from = index_args[1].0;
    let inc = match_const_i64(inc_const, ctx)?;
    let wrap = match_const_i64(wrap_const, ctx)?;
    let counter_inc = match_const_i64(counter_inc_const, ctx)?;
    if inc < 0
        || counter_inc < 0
        || wrap <= inc
        || !ctx.int_local.contains(&from)
        || !ctx.int_local.contains(&acc)
    {
        return None;
    }

    let from_add_ok = if from_add_lhs.0 == from {
        from_add_rhs.0 == match_const_dst(inc_const)?
    } else if from_add_rhs.0 == from {
        from_add_lhs.0 == match_const_dst(inc_const)?
    } else {
        false
    };
    if !from_add_ok || from_copy.0 != from {
        return None;
    }

    let (
        Inst::Const { dst: wrap2_dst, .. },
        Inst::BinOp {
            dst: sub_tmp,
            op: sub_op,
            lhs: sub_lhs,
            rhs: sub_rhs,
        },
        Inst::Copy {
            dst: sub_dst,
            src: sub_src,
        },
    ) = (&then_body[0], &then_body[1], &then_body[2])
    else {
        return None;
    };
    if match_const_i64(&then_body[0], ctx)? != wrap
        || sub_op != "-"
        || sub_lhs.0 != from
        || sub_rhs.0 != wrap2_dst.0
        || sub_tmp.0 != sub_src.0
        || sub_dst.0 != from
    {
        return None;
    }

    let counter = counter_copy.0;
    let counter_ok = if counter_lhs.0 == counter {
        counter_rhs.0 == match_const_dst(counter_inc_const)?
    } else if counter_rhs.0 == counter {
        counter_lhs.0 == match_const_dst(counter_inc_const)?
    } else {
        false
    };
    if !counter_ok || !ctx.int_local.contains(&counter) {
        return None;
    }

    if body
        .iter()
        .any(|inst| inst_def_local(inst) == Some(index_recv.0))
    {
        return None;
    }

    let needle1 = static_string_expr_from_const(needle1_const, ctx)?;
    let needle2 = static_string_expr_from_const(needle2_const, ctx)?;
    let base = ctx.val(index_recv.0);
    let first_var = format!("_fs_first{}", top);
    let last_var = format!("_fs_last{}", top);
    let _ = writeln!(
        s,
        "  long long {} = (long long)ts_str_indexof_fast({}, {}, 0, 1);",
        first_var, base, needle1
    );
    let _ = writeln!(
        s,
        "  long long {} = (long long)ts_str_lastindexof_fast({}, {}, (double)ts_str_len_typed({}), 1);",
        last_var, base, needle2, base
    );
    let _ = writeln!(
        s,
        "  if ({} >= {}LL && d{} >= 0 && d{} < {}LL) {{",
        first_var, wrap, from, from, wrap
    );
    emit_checked_loop(s, cond, cond_body, ctx, |s| {
        let _ = writeln!(s, "  d{} += {} + {};", acc, first_var, last_var);
        let _ = writeln!(s, "  d{} += {}LL;", from, inc);
        let _ = writeln!(s, "  if (d{} >= {}LL) d{} -= {}LL;", from, wrap, from, wrap);
        let _ = writeln!(s, "  d{} += {}LL;", counter, counter_inc);
    });
    s.push_str("  } else {\n");
    emit_runtime_loop(s, cond, cond_body, body, ctx);
    s.push_str("  }\n");
    Some(())
}

fn match_const_dst(inst: &Inst) -> Option<u32> {
    match inst {
        Inst::Const { dst, .. } => Some(dst.0),
        _ => None,
    }
}

fn match_const_i64(inst: &Inst, ctx: &Ctx) -> Option<i64> {
    let dst = match_const_dst(inst)?;
    ctx.int_const.get(&dst).copied()
}

fn try_emit_fused_string_concat_loop(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
    top: u32,
) -> Option<()> {
    if body.len() != 9 {
        return None;
    }
    let (
        Inst::BinOp {
            dst: concat_tmp,
            op: concat_op,
            lhs: concat_lhs,
            rhs: concat_rhs,
        },
        Inst::Copy {
            dst: str_copy,
            src: concat_src,
        },
        Inst::StringLen {
            dst: len_after_concat,
            src: len_src,
        },
        threshold_const,
        Inst::BinOp {
            dst: cmp_tmp,
            op: cmp_op,
            lhs: cmp_lhs,
            rhs: cmp_rhs,
        },
        Inst::If {
            cond: if_cond,
            then_body,
            else_body,
        },
        counter_inc_const,
        Inst::BinOp {
            dst: counter_tmp,
            op: counter_op,
            lhs: counter_lhs,
            rhs: counter_rhs,
        },
        Inst::Copy {
            dst: counter_copy,
            src: counter_src,
        },
    ) = (
        &body[0], &body[1], &body[2], &body[3], &body[4], &body[5], &body[6], &body[7], &body[8],
    )
    else {
        return None;
    };
    if concat_op != "+"
        || cmp_op != ">="
        || counter_op != "+"
        || concat_tmp.0 != concat_src.0
        || str_copy.0 != len_src.0
        || len_after_concat.0 != cmp_lhs.0
        || cmp_rhs.0 != match_const_dst(threshold_const)?
        || cmp_tmp.0 != if_cond.0
        || !else_body.is_empty()
        || then_body.len() != 8
        || counter_tmp.0 != counter_src.0
    {
        return None;
    }

    let str_local = str_copy.0;
    let chunk = if concat_lhs.0 == str_local {
        concat_rhs.0
    } else if concat_rhs.0 == str_local {
        concat_lhs.0
    } else {
        return None;
    };

    let (
        Inst::StringLen {
            dst: flush_len,
            src: flush_len_src,
        },
        Inst::BinOp {
            dst: sum_len_tmp,
            op: sum_len_op,
            lhs: sum_len_lhs,
            rhs: sum_len_rhs,
        },
        char_idx_const,
        Inst::CallBuiltin {
            dst: Some(char_res),
            builtin: char_builtin,
            recv: char_recv,
            args: char_args,
        },
        Inst::BinOp {
            dst: sum_char_tmp,
            op: sum_char_op,
            lhs: sum_char_lhs,
            rhs: sum_char_rhs,
        },
        Inst::Copy {
            dst: sum_copy,
            src: sum_char_src,
        },
        empty_const,
        Inst::Copy {
            dst: reset_dst,
            src: reset_src,
        },
    ) = (
        &then_body[0],
        &then_body[1],
        &then_body[2],
        &then_body[3],
        &then_body[4],
        &then_body[5],
        &then_body[6],
        &then_body[7],
    )
    else {
        return None;
    };
    if sum_len_op != "+"
        || sum_char_op != "+"
        || char_builtin != "string.charCodeAt"
        || flush_len_src.0 != str_local
        || flush_len.0 != sum_len_rhs.0
        || char_recv.0 != str_local
        || char_args.len() != 1
        || char_args[0].0 != match_const_dst(char_idx_const)?
        || sum_len_tmp.0 != sum_char_lhs.0
        || char_res.0 != sum_char_rhs.0
        || sum_char_tmp.0 != sum_char_src.0
        || sum_copy.0 != sum_len_lhs.0
        || reset_dst.0 != str_local
        || reset_src.0 != match_const_dst(empty_const)?
    {
        return None;
    }

    let threshold = match_const_i64(threshold_const, ctx)?;
    let char_idx = match_const_i64(char_idx_const, ctx)?;
    let counter_inc = match_const_i64(counter_inc_const, ctx)?;
    if threshold <= 0
        || char_idx < 0
        || threshold <= char_idx
        || counter_inc < 0
        || !ctx.unboxed.contains(&sum_copy.0)
    {
        return None;
    }

    let counter = counter_copy.0;
    let counter_ok = if counter_lhs.0 == counter {
        counter_rhs.0 == match_const_dst(counter_inc_const)?
    } else if counter_rhs.0 == counter {
        counter_lhs.0 == match_const_dst(counter_inc_const)?
    } else {
        false
    };
    if !counter_ok || !ctx.int_local.contains(&counter) {
        return None;
    }

    if body.iter().any(|inst| inst_def_local(inst) == Some(chunk)) {
        return None;
    }

    let base = ctx.val(str_local);
    let chunk_val = ctx.val(chunk);
    let len_var = format!("_fclen{}", top);
    let chunk_len_var = format!("_fcchunk{}", top);
    let char_var = format!("_fcch{}", top);
    let _ = writeln!(
        s,
        "  long long {} = (long long)ts_str_len_typed({});",
        len_var, base
    );
    let _ = writeln!(
        s,
        "  long long {} = (long long)ts_str_len_typed({});",
        chunk_len_var, chunk_val
    );
    let _ = writeln!(
        s,
        "  long long {} = 0; if ({} > 0) {} = ts_str_charcodeat_i64_typed({}, {}LL % {});",
        char_var, chunk_len_var, char_var, chunk_val, char_idx, chunk_len_var
    );
    // A guarded integer shadow keeps the long concat loop cheap while the
    // general result remains a double (charCodeAt can produce NaN). Bound every
    // addition below 2^52; fallback retains source evaluation for other inputs.
    let integer_guard = if ctx.int_local.contains(&sum_copy.0) {
        "1".to_string()
    } else if let [Inst::BinOp { dst, op, lhs, rhs }] = cond_body {
        if dst.0 == cond.0
            && op == "<"
            && lhs.0 == counter
            && ctx.int_local.contains(&rhs.0)
            && counter_inc > 0
        {
            format!("(isfinite(d{a}) && trunc(d{a}) == d{a} && fabs(d{a}) + (fmax(0.0, (double)({limit}) - (double)d{counter}) + 1.0) * ((double){chunk} + {threshold}.0 + 65535.0) <= 4503599627370495.0)",
                a=sum_copy.0, limit=ctx.num(rhs.0), chunk=chunk_len_var)
        } else {
            "0".to_string()
        }
    } else {
        "0".to_string()
    };
    let acc_var = if ctx.int_local.contains(&sum_copy.0) {
        format!("d{}", sum_copy.0)
    } else {
        format!("_fcacc{}", top)
    };
    let _ = writeln!(
        s,
        "  if ({} == 0 && {} > 0 && {}) {{",
        len_var, chunk_len_var, integer_guard
    );
    if !ctx.int_local.contains(&sum_copy.0) {
        let _ = writeln!(s, "  long long {} = (long long)d{};", acc_var, sum_copy.0);
    }
    emit_checked_loop(s, cond, cond_body, ctx, |s| {
        let _ = writeln!(s, "  {} += {};", len_var, chunk_len_var);
        let _ = writeln!(s, "  if ({} >= {}LL) {{", len_var, threshold);
        let _ = writeln!(s, "    {} += {} + {};", acc_var, len_var, char_var);
        let _ = writeln!(s, "    {} = 0;", len_var);
        s.push_str("  }\n");
        let _ = writeln!(s, "  d{} += {}LL;", counter, counter_inc);
    });
    if ctx.int32_use.contains(&sum_copy.0) {
        let cast = if int32_codegen_enabled() { "" } else { "(double)" };
        let _ = writeln!(s, "  d{} = {}ts_to_int32((double){});", sum_copy.0, cast, acc_var);
    } else if !ctx.int_local.contains(&sum_copy.0) {
        let _ = writeln!(s, "  d{} = (double){};", sum_copy.0, acc_var);
    }
    let _ = writeln!(
        s,
        "  {} = ts_str_repeat({}, (double)({} / {}));",
        ctx.vname(str_local),
        chunk_val,
        len_var,
        chunk_len_var
    );
    s.push_str("  } else {\n");
    emit_runtime_loop(s, cond, cond_body, body, ctx);
    s.push_str("  }\n");
    Some(())
}

fn try_emit_fused_concat_chain_metric_loop(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
) -> Option<()> {
    if body.len() != 20 {
        return None;
    }
    let (
        sep_const,
        Inst::CallBuiltinStatic {
            dst: Some(concat_res),
            builtin: concat_builtin,
            args: concat_args,
        },
        Inst::Copy {
            dst: concat_value,
            src: concat_src,
        },
        Inst::Copy {
            dst: last,
            src: last_src,
        },
        Inst::StringLen {
            dst: len1,
            src: len1_src,
        },
        Inst::BinOp {
            dst: sum_len_tmp,
            op: sum_len_op,
            lhs: sum_len_lhs,
            rhs: sum_len_rhs,
        },
        zero_const,
        Inst::CallBuiltin {
            dst: Some(first_res),
            builtin: first_builtin,
            recv: first_recv,
            args: first_args,
        },
        Inst::BinOp {
            dst: sum_first_tmp,
            op: sum_first_op,
            lhs: sum_first_lhs,
            rhs: sum_first_rhs,
        },
        Inst::StringLen {
            dst: len2,
            src: len2_src,
        },
        one_const,
        Inst::BinOp {
            dst: last_idx,
            op: last_idx_op,
            lhs: last_idx_lhs,
            rhs: last_idx_rhs,
        },
        Inst::CallBuiltin {
            dst: Some(last_char_res),
            builtin: last_char_builtin,
            recv: last_char_recv,
            args: last_char_args,
        },
        Inst::BinOp {
            dst: sum_last_tmp,
            op: sum_last_op,
            lhs: sum_last_lhs,
            rhs: sum_last_rhs,
        },
        Inst::CallBuiltin {
            dst: Some(index_res),
            builtin: index_builtin,
            recv: index_recv,
            args: index_args,
        },
        Inst::BinOp {
            dst: sum_index_tmp,
            op: sum_index_op,
            lhs: sum_index_lhs,
            rhs: sum_index_rhs,
        },
        Inst::Copy {
            dst: sum_copy,
            src: sum_index_src,
        },
        counter_inc_const,
        Inst::BinOp {
            dst: counter_tmp,
            op: counter_op,
            lhs: counter_lhs,
            rhs: counter_rhs,
        },
        Inst::Copy {
            dst: counter_copy,
            src: counter_src,
        },
    ) = (
        &body[0], &body[1], &body[2], &body[3], &body[4], &body[5], &body[6], &body[7], &body[8],
        &body[9], &body[10], &body[11], &body[12], &body[13], &body[14], &body[15], &body[16],
        &body[17], &body[18], &body[19],
    )
    else {
        return None;
    };
    if concat_builtin != "string.concatMany"
        || concat_args.len() != 5
        || match_const_dst(sep_const)? != concat_args[2].0
        || concat_res.0 != concat_src.0
        || concat_value.0 != last_src.0
        || len1_src.0 != concat_value.0
        || sum_len_op != "+"
        || sum_len_lhs.0 != sum_copy.0
        || sum_len_rhs.0 != len1.0
        || first_builtin != "string.charCodeAt"
        || first_recv.0 != concat_value.0
        || first_args.len() != 1
        || first_args[0].0 != match_const_dst(zero_const)?
        || match_const_i64(zero_const, ctx)? != 0
        || sum_first_op != "+"
        || sum_first_lhs.0 != sum_len_tmp.0
        || sum_first_rhs.0 != first_res.0
        || len2_src.0 != concat_value.0
        || last_idx_op != "-"
        || last_idx_lhs.0 != len2.0
        || last_idx_rhs.0 != match_const_dst(one_const)?
        || match_const_i64(one_const, ctx)? != 1
        || last_char_builtin != "string.charCodeAt"
        || last_char_recv.0 != concat_value.0
        || last_char_args.len() != 1
        || last_char_args[0].0 != last_idx.0
        || sum_last_op != "+"
        || sum_last_lhs.0 != sum_first_tmp.0
        || sum_last_rhs.0 != last_char_res.0
        || index_builtin != "string.indexOf"
        || index_recv.0 != concat_value.0
        || index_args.len() != 1
        || index_args[0].0 != concat_args[3].0
        || sum_index_op != "+"
        || sum_index_lhs.0 != sum_last_tmp.0
        || sum_index_rhs.0 != index_res.0
        || sum_index_tmp.0 != sum_index_src.0
        || counter_op != "+"
        || counter_tmp.0 != counter_src.0
    {
        return None;
    }

    let counter = counter_copy.0;
    let counter_inc = match_const_i64(counter_inc_const, ctx)?;
    let counter_ok = if counter_lhs.0 == counter {
        counter_rhs.0 == match_const_dst(counter_inc_const)?
    } else if counter_rhs.0 == counter {
        counter_lhs.0 == match_const_dst(counter_inc_const)?
    } else {
        false
    };
    if !counter_ok
        || counter_inc != 1
        || concat_args[1].0 != counter
        || !ctx.int_local.contains(&counter)
        || !ctx.unboxed.contains(&sum_copy.0)
    {
        return None;
    }
    let limit = match cond_body {
        [Inst::BinOp { dst, op, lhs, rhs }]
            if dst.0 == cond.0
                && op == "<"
                && lhs.0 == counter
                && ctx.int_local.contains(&rhs.0) =>
        {
            rhs.0
        }
        _ => return None,
    };

    for value in [concat_args[0].0, concat_args[3].0, concat_args[4].0] {
        if body.iter().any(|inst| inst_def_local(inst) == Some(value)) {
            return None;
        }
    }
    let mut skipped_defs = collect_defs(body);
    skipped_defs.remove(&last.0);
    skipped_defs.remove(&sum_copy.0);
    skipped_defs.remove(&counter);
    if locals_used_after(body, body.len(), &skipped_defs) {
        return None;
    }

    let prefix = ctx.val(concat_args[0].0);
    let sep = ctx.val(concat_args[2].0);
    let marker = ctx.val(concat_args[3].0);
    let tail = ctx.val(concat_args[4].0);
    let prefix_len = "_fccm_prefix_len";
    let sep_len = "_fccm_sep_len";
    let marker_len = "_fccm_marker_len";
    let tail_len = "_fccm_tail_len";
    let first_ch = "_fccm_first_ch";
    let last_ch = "_fccm_last_ch";
    let marker0 = "_fccm_marker0";
    let start = "_fccm_start";
    let digits = "_fccm_digits";
    let metric = "_fccm_metric";
    let last_num = "_fccm_last_num";

    emit_inst(s, sep_const, ctx);
    let _ = writeln!(s, "  long long {} = d{};", start, counter);
    let _ = writeln!(s, "  if (ts_is_str({}) && ts_is_str({}) && ts_is_str({}) && ts_is_str({}) && d{} >= 0 && d{} <= 9007199254740991LL) {{",
        prefix, sep, marker, tail, counter, limit);
    let _ = writeln!(
        s,
        "  long long {} = (long long)ts_str_len_typed({});",
        prefix_len, prefix
    );
    let _ = writeln!(
        s,
        "  long long {} = (long long)ts_str_len_typed({});",
        sep_len, sep
    );
    let _ = writeln!(
        s,
        "  long long {} = (long long)ts_str_len_typed({});",
        marker_len, marker
    );
    let _ = writeln!(
        s,
        "  long long {} = (long long)ts_str_len_typed({});",
        tail_len, tail
    );
    let _ = writeln!(
        s,
        "  long long {} = {} > 0 ? ts_str_charcodeat_i64_typed({}, 0) : -1;",
        first_ch, prefix_len, prefix
    );
    let _ = writeln!(
        s,
        "  long long {} = {} > 0 ? ts_str_charcodeat_i64_typed({}, {} - 1) : -1;",
        last_ch, tail_len, tail, tail_len
    );
    let _ = writeln!(
        s,
        "  long long {} = {} > 0 ? ts_str_charcodeat_i64_typed({}, 0) : -1;",
        marker0, marker_len, marker
    );
    let _ = writeln!(
        s,
        "  if ({} > 0 && {} > 0 && {} > 0 && ({} != 1 || {} < '0' || {} > '9') && ts_str_indexof_fast({}, {}, 0, 0) < 0 && ts_str_indexof_fast({}, {}, 0, 0) < 0) {{",
        prefix_len,
        marker_len,
        tail_len,
        marker_len,
        marker0,
        marker0,
        prefix,
        marker,
        sep,
        marker
    );
    emit_checked_loop(s, cond, cond_body, ctx, |s| {
        let _ = writeln!(
            s,
            "  long long {} = ts_i64_decimal_len_nonneg(d{});",
            digits, counter
        );
        let _ = writeln!(
            s,
            "  long long {} = ({} + {} + {} + {} + {}) + {} + {} + ({} + {} + {});",
            metric,
            prefix_len,
            sep_len,
            marker_len,
            tail_len,
            digits,
            first_ch,
            last_ch,
            prefix_len,
            sep_len,
            digits
        );
        // Preserve each source addition when NaN-capable analysis keeps a double.
        if ctx.int_local.contains(&sum_copy.0) {
            let _ = writeln!(s, "  d{} += {};", sum_copy.0, metric);
        } else {
            let _ = writeln!(s, "  d{a} += (double)({p} + {sep} + {m} + {tail} + {digits}); d{a} += (double){first}; d{a} += (double){last}; d{a} += (double)({p} + {sep} + {digits});",
                a=sum_copy.0, p=prefix_len, sep=sep_len, m=marker_len, tail=tail_len,
                digits=digits, first=first_ch, last=last_ch);
        }
        let _ = writeln!(s, "  d{} += 1LL;", counter);
    });
    let _ = writeln!(s, "  if (d{} != {}) {{", counter, start);
    let _ = writeln!(s, "    long long {} = d{} - 1LL;", last_num, counter);
    s.push_str("    { tsv _fccm_args[5];\n");
    let _ = writeln!(s, "      _fccm_args[0] = {};", prefix);
    let _ = writeln!(s, "      _fccm_args[1] = ts_num((double){});", last_num);
    let _ = writeln!(s, "      _fccm_args[2] = {};", sep);
    let _ = writeln!(s, "      _fccm_args[3] = {};", marker);
    let _ = writeln!(s, "      _fccm_args[4] = {};", tail);
    s.push_str("      tsv _fccm_last = ts_str_concat_many(_fccm_args, 5);\n");
    s.push_str(&ctx.set_val(last.0, "_fccm_last"));
    s.push_str("    }\n");
    s.push_str("  }\n");
    s.push_str("  } else {\n");
    emit_runtime_loop(s, cond, cond_body, body, ctx);
    s.push_str("  }\n");
    s.push_str("  } else {\n");
    emit_runtime_loop(s, cond, cond_body, body, ctx);
    s.push_str("  }\n");
    Some(())
}

fn try_emit_fused_split_join_loop(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
    top: u32,
) -> Option<()> {
    if body.len() != 18 {
        return None;
    }
    let (
        split_sep_const,
        Inst::CallBuiltin {
            dst: Some(split_res),
            builtin: split_builtin,
            recv: split_recv,
            args: split_args,
        },
        Inst::Copy {
            dst: parts,
            src: split_src,
        },
        join_sep_const,
        Inst::CallBuiltin {
            dst: Some(join_res),
            builtin: join_builtin,
            recv: join_recv,
            args: join_args,
        },
        Inst::Copy {
            dst: joined,
            src: join_src,
        },
        Inst::ArrayLen {
            dst: parts_len,
            arr: parts_len_arr,
        },
        Inst::BinOp {
            dst: sum_parts_tmp,
            op: sum_parts_op,
            lhs: sum_parts_lhs,
            rhs: sum_parts_rhs,
        },
        Inst::StringLen {
            dst: joined_len,
            src: joined_len_src,
        },
        Inst::BinOp {
            dst: sum_joined_tmp,
            op: sum_joined_op,
            lhs: sum_joined_lhs,
            rhs: sum_joined_rhs,
        },
        index_const,
        Inst::LoadIndex {
            dst: part_value,
            arr: load_arr,
            index: load_index,
            ..
        },
        Inst::StringLen {
            dst: part_len,
            src: part_len_src,
        },
        Inst::BinOp {
            dst: sum_part_tmp,
            op: sum_part_op,
            lhs: sum_part_lhs,
            rhs: sum_part_rhs,
        },
        Inst::Copy {
            dst: sum_copy,
            src: sum_part_src,
        },
    ) = (
        &body[0], &body[1], &body[2], &body[3], &body[4], &body[5], &body[6], &body[7], &body[8],
        &body[9], &body[10], &body[11], &body[12], &body[13], &body[14],
    )
    else {
        return None;
    };

    if split_builtin != "string.split"
        || join_builtin != "array.join"
        || sum_parts_op != "+"
        || sum_joined_op != "+"
        || sum_part_op != "+"
        || split_args.len() != 1
        || split_args[0].0 != match_const_dst(split_sep_const)?
        || split_res.0 != split_src.0
        || join_recv.0 != parts.0
        || join_args.len() != 1
        || join_args[0].0 != match_const_dst(join_sep_const)?
        || join_res.0 != join_src.0
        || parts_len_arr.0 != parts.0
        || parts_len.0 != sum_parts_rhs.0
        || joined_len_src.0 != joined.0
        || joined_len.0 != sum_joined_rhs.0
        || sum_parts_tmp.0 != sum_joined_lhs.0
        || load_arr.0 != parts.0
        || load_index.0 != match_const_dst(index_const)?
        || part_value.0 != part_len_src.0
        || part_len.0 != sum_part_rhs.0
        || sum_joined_tmp.0 != sum_part_lhs.0
        || sum_part_tmp.0 != sum_part_src.0
        || sum_copy.0 != sum_parts_lhs.0
        || !ctx.int_local.contains(&sum_copy.0)
    {
        return None;
    }

    let index = match_const_i64(index_const, ctx)?;
    if index < 0 {
        return None;
    }
    let counter = match_counter_add_tail(body, 15, ctx)?;
    if body
        .iter()
        .any(|inst| inst_def_local(inst) == Some(split_recv.0))
    {
        return None;
    }

    let split_sep = static_string_expr_from_const(split_sep_const, ctx)?;
    let join_sep = static_string_expr_from_const(join_sep_const, ctx)?;
    let base = ctx.val(split_recv.0);
    let parts_var = format!("_fsj_parts{}", top);
    let joined_var = format!("_fsj_joined{}", top);
    let part_var = format!("_fsj_part{}", top);
    let inc_var = format!("_fsj_inc{}", top);
    let _ = writeln!(
        s,
        "  tsv {} = ts_str_split({}, {}, TS_UNDEFINED);",
        parts_var, base, split_sep
    );
    let _ = writeln!(s, "  ts_gc_root(&{});", parts_var);
    let _ = writeln!(
        s,
        "  tsv {} = ts_array_join({}, {});",
        joined_var, parts_var, join_sep
    );
    let _ = writeln!(s, "  ts_gc_root(&{});", joined_var);
    let _ = writeln!(
        s,
        "  tsv {} = ts_array_get({}, (uint32_t){}LL);",
        part_var, parts_var, index
    );
    let _ = writeln!(s, "  long long {} = -1;", inc_var);
    let _ = writeln!(
        s,
        "  if (ts_is_str({}) && ts_is_str({})) {} = (long long)ts_array_len_fast({}) + (long long)ts_str_len_typed({}) + (long long)ts_str_len_typed({});",
        joined_var, part_var, inc_var, parts_var, joined_var, part_var
    );
    s.push_str("  ts_gc_unroot(2);\n");
    let _ = writeln!(s, "  if ({} >= 0) {{", inc_var);
    emit_checked_loop(s, cond, cond_body, ctx, |s| {
        let _ = writeln!(s, "  d{} += {};", sum_copy.0, inc_var);
        let _ = writeln!(s, "  d{} += {}LL;", counter.counter, counter.inc);
    });
    s.push_str("  } else {\n");
    emit_runtime_loop(s, cond, cond_body, body, ctx);
    s.push_str("  }\n");
    Some(())
}

fn match_static_split_join_escape_shape(
    body: &[Inst],
    ctx: &Ctx,
) -> Option<StaticSplitJoinEscapeShape> {
    if body.len() != 21 {
        return None;
    }
    let (
        split_sep_const,
        Inst::CallBuiltin {
            dst: Some(split_res),
            builtin: split_builtin,
            recv: split_recv,
            args: split_args,
        },
        Inst::Copy {
            dst: parts,
            src: split_src,
        },
        join_sep_const,
        Inst::CallBuiltin {
            dst: Some(join_res),
            builtin: join_builtin,
            recv: join_recv,
            args: join_args,
        },
        Inst::Copy {
            dst: joined,
            src: join_src,
        },
        Inst::Copy {
            dst: last,
            src: last_src,
        },
        Inst::StringLen {
            dst: joined_len1,
            src: joined_len1_src,
        },
        Inst::BinOp {
            dst: sum_len_tmp,
            op: sum_len_op,
            lhs: sum_len_lhs,
            rhs: sum_len_rhs,
        },
        zero_const,
        Inst::CallBuiltin {
            dst: Some(first_ch),
            builtin: first_builtin,
            recv: first_recv,
            args: first_args,
        },
        Inst::BinOp {
            dst: sum_first_tmp,
            op: sum_first_op,
            lhs: sum_first_lhs,
            rhs: sum_first_rhs,
        },
        Inst::StringLen {
            dst: joined_len2,
            src: joined_len2_src,
        },
        one_const,
        Inst::BinOp {
            dst: last_idx,
            op: last_idx_op,
            lhs: last_idx_lhs,
            rhs: last_idx_rhs,
        },
        Inst::CallBuiltin {
            dst: Some(last_ch),
            builtin: last_builtin,
            recv: last_recv,
            args: last_args,
        },
        Inst::BinOp {
            dst: sum_last_tmp,
            op: sum_last_op,
            lhs: sum_last_lhs,
            rhs: sum_last_rhs,
        },
        Inst::Copy {
            dst: sum_copy,
            src: sum_last_src,
        },
    ) = (
        &body[0], &body[1], &body[2], &body[3], &body[4], &body[5], &body[6], &body[7], &body[8],
        &body[9], &body[10], &body[11], &body[12], &body[13], &body[14], &body[15], &body[16],
        &body[17],
    )
    else {
        return None;
    };

    if split_builtin != "string.split"
        || join_builtin != "array.join"
        || split_args.len() != 1
        || split_args[0].0 != match_const_dst(split_sep_const)?
        || split_res.0 != split_src.0
        || join_recv.0 != parts.0
        || join_args.len() != 1
        || join_args[0].0 != match_const_dst(join_sep_const)?
        || join_res.0 != join_src.0
        || last_src.0 != joined.0
        || joined_len1_src.0 != joined.0
        || sum_len_op != "+"
        || joined_len1.0 != sum_len_rhs.0
        || match_const_i64(zero_const, ctx)? != 0
        || first_builtin != "string.charCodeAt"
        || first_recv.0 != joined.0
        || first_args.len() != 1
        || first_args[0].0 != match_const_dst(zero_const)?
        || sum_first_op != "+"
        || sum_len_tmp.0 != sum_first_lhs.0
        || first_ch.0 != sum_first_rhs.0
        || joined_len2_src.0 != joined.0
        || match_const_i64(one_const, ctx)? != 1
        || last_idx_op != "-"
        || joined_len2.0 != last_idx_lhs.0
        || last_idx_rhs.0 != match_const_dst(one_const)?
        || last_builtin != "string.charCodeAt"
        || last_recv.0 != joined.0
        || last_args.len() != 1
        || last_args[0].0 != last_idx.0
        || sum_last_op != "+"
        || sum_first_tmp.0 != sum_last_lhs.0
        || last_ch.0 != sum_last_rhs.0
        || sum_last_tmp.0 != sum_last_src.0
        || sum_copy.0 != sum_len_lhs.0
        || !ctx.unboxed.contains(&sum_copy.0)
    {
        return None;
    }
    let counter = match_counter_add_tail(body, 18, ctx)?;
    if body
        .iter()
        .any(|inst| inst_def_local(inst) == Some(split_recv.0))
    {
        return None;
    }

    let split_sep = static_string_expr_from_const(split_sep_const, ctx)?;
    let join_sep = static_string_expr_from_const(join_sep_const, ctx)?;
    Some(StaticSplitJoinEscapeShape {
        recv: split_recv.0,
        separator: split_sep,
        joiner: join_sep,
        last: last.0,
        acc: sum_copy.0,
        counter,
    })
}

fn try_emit_fused_split_join_escape_loop(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
    top: u32,
) -> Option<()> {
    let shape = match_static_split_join_escape_shape(body, ctx)?;
    emit_static_split_join_escape_loop(s, cond, cond_body, body, ctx, top, &shape);
    Some(())
}

fn emit_static_split_join_escape_loop(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
    top: u32,
    shape: &StaticSplitJoinEscapeShape,
) {
    let base = ctx.val(shape.recv);
    let parts_var = format!("_fsje_parts{}", top);
    let joined_var = format!("_fsje_joined{}", top);
    let len_var = format!("_fsje_len{}", top);
    let inc_var = format!("_fsje_inc{}", top);
    let _ = writeln!(
        s,
        "  tsv {} = ts_str_split({}, {}, TS_UNDEFINED);",
        parts_var, base, shape.separator
    );
    let _ = writeln!(s, "  ts_gc_root(&{});", parts_var);
    let _ = writeln!(
        s,
        "  tsv {} = ts_array_join({}, {});",
        joined_var, parts_var, shape.joiner
    );
    let _ = writeln!(s, "  ts_gc_root(&{});", joined_var);
    let first_var = format!("{}_first", inc_var);
    let last_var = format!("{}_last", inc_var);
    let _ = writeln!(
        s,
        "  long long {} = -1, {} = 0, {} = 0, {} = 0;",
        inc_var, len_var, first_var, last_var
    );
    let _ = writeln!(s,
        "  if (ts_is_str({base}) && ({len} = (long long)ts_str_len_typed({base})) > 0) {{ {first} = ts_str_charcodeat_i64_typed({base}, 0); {last} = ts_str_charcodeat_i64_typed({base}, {len} - 1); {inc} = {len} + {first} + {last}; }}",
        base=joined_var, len=len_var, first=first_var, last=last_var, inc=inc_var);
    let _ = writeln!(s, "  if ({} >= 0) {{", inc_var);
    emit_checked_loop(s, cond, cond_body, ctx, |s| {
        s.push_str(&ctx.set_val(shape.last, &joined_var));
        if ctx.int_local.contains(&shape.acc) {
            let _ = writeln!(s, "  d{} += {};", shape.acc, inc_var);
        } else {
            let _ = writeln!(
                s,
                "  d{a} += (double){len}; d{a} += (double){first}; d{a} += (double){last};",
                a = shape.acc,
                len = len_var,
                first = first_var,
                last = last_var
            );
        }
        let _ = writeln!(
            s,
            "  d{} += {}LL;",
            shape.counter.counter, shape.counter.inc
        );
    });
    s.push_str("  ts_gc_unroot(2);\n");
    s.push_str("  } else {\n");
    s.push_str("  ts_gc_unroot(2);\n");
    emit_runtime_loop(s, cond, cond_body, body, ctx);
    s.push_str("  }\n");
}

fn try_emit_fused_replace_metrics_loop(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
    top: u32,
) -> Option<()> {
    if body.len() != 16 {
        return None;
    }
    let (
        pat_const,
        rep_const,
        Inst::CallBuiltin {
            dst: Some(replaced_res),
            builtin: replace_builtin,
            recv: replace_recv,
            args: replace_args,
        },
        Inst::Copy {
            dst: replaced,
            src: replaced_src,
        },
        Inst::GenericLen {
            dst: replaced_len,
            src: replaced_len_src,
        },
        Inst::BinOp {
            dst: sum_len_tmp,
            op: sum_len_op,
            lhs: sum_len_lhs,
            rhs: sum_len_rhs,
        },
        index_needle_const,
        Inst::Call {
            dst: Some(index_res),
            recv: Some(index_recv),
            args: index_args,
            ..
        },
        Inst::BinOp {
            dst: sum_index_tmp,
            op: sum_index_op,
            lhs: sum_index_lhs,
            rhs: sum_index_rhs,
        },
        char_idx_const,
        Inst::Call {
            dst: Some(char_res),
            recv: Some(char_recv),
            args: char_args,
            ..
        },
        Inst::BinOp {
            dst: sum_char_tmp,
            op: sum_char_op,
            lhs: sum_char_lhs,
            rhs: sum_char_rhs,
        },
        Inst::Copy {
            dst: sum_copy,
            src: sum_char_src,
        },
    ) = (
        &body[0], &body[1], &body[2], &body[3], &body[4], &body[5], &body[6], &body[7], &body[8],
        &body[9], &body[10], &body[11], &body[12],
    )
    else {
        return None;
    };

    if replace_builtin != "string.replaceAll"
        || replace_args.len() != 2
        || replace_args[0].0 != match_const_dst(pat_const)?
        || replace_args[1].0 != match_const_dst(rep_const)?
        || replaced_res.0 != replaced_src.0
        || replaced_len_src.0 != replaced.0
        || sum_len_op != "+"
        || replaced_len.0 != sum_len_rhs.0
        || index_recv.0 != replaced.0
        || index_args.len() != 1
        || index_args[0].0 != match_const_dst(index_needle_const)?
        || sum_index_op != "+"
        || sum_len_tmp.0 != sum_index_lhs.0
        || index_res.0 != sum_index_rhs.0
        || char_recv.0 != replaced.0
        || char_args.len() != 1
        || char_args[0].0 != match_const_dst(char_idx_const)?
        || sum_char_op != "+"
        || sum_index_tmp.0 != sum_char_lhs.0
        || char_res.0 != sum_char_rhs.0
        || sum_char_tmp.0 != sum_char_src.0
        || sum_copy.0 != sum_len_lhs.0
        || !ctx.unboxed.contains(&sum_copy.0)
    {
        return None;
    }

    let char_idx = match_const_i64(char_idx_const, ctx)?;
    if char_idx < 0 {
        return None;
    }
    let counter = match_counter_add_tail(body, 13, ctx)?;
    if body
        .iter()
        .any(|inst| inst_def_local(inst) == Some(replace_recv.0))
    {
        return None;
    }

    let pat = static_string_expr_from_const(pat_const, ctx)?;
    let rep = static_string_expr_from_const(rep_const, ctx)?;
    let index_needle = static_string_expr_from_const(index_needle_const, ctx)?;
    let base = ctx.val(replace_recv.0);
    let out_var = format!("_frm_out{}", top);
    let inc_var = format!("_frm_inc{}", top);
    let _ = writeln!(
        s,
        "  tsv {} = ts_str_replace({}, {}, {}, 1);",
        out_var, base, pat, rep
    );
    let _ = writeln!(s, "  ts_gc_root(&{});", out_var);
    let _ = writeln!(s, "  long long {} = -1;", inc_var);
    let _ = writeln!(
        s,
        "  if (ts_is_str({})) {} = (long long)ts_str_len_typed({}) + (long long)ts_str_indexof_fast({}, {}, 0, 1) + (long long)ts_str_charcodeat_i64_typed({}, {}LL);",
        out_var, inc_var, out_var, out_var, index_needle, out_var, char_idx
    );
    s.push_str("  ts_gc_unroot(1);\n");
    let _ = writeln!(s, "  if ({} >= 0) {{", inc_var);
    emit_checked_loop(s, cond, cond_body, ctx, |s| {
        emit_metric_acc_add(s, sum_copy.0, &inc_var, ctx);
        let _ = writeln!(s, "  d{} += {}LL;", counter.counter, counter.inc);
    });
    s.push_str("  } else {\n");
    emit_runtime_loop(s, cond, cond_body, body, ctx);
    s.push_str("  }\n");
    Some(())
}

fn match_static_replace_escape_shape(body: &[Inst], ctx: &Ctx) -> Option<StaticReplaceEscapeShape> {
    if body.len() != 17 {
        return None;
    }
    let (
        pat_const,
        rep_const,
        Inst::CallBuiltin {
            dst: Some(replaced_res),
            builtin: replace_builtin,
            recv: replace_recv,
            args: replace_args,
        },
        Inst::Copy {
            dst: replaced,
            src: replaced_src,
        },
        Inst::Copy {
            dst: last,
            src: last_src,
        },
        Inst::GenericLen {
            dst: replaced_len,
            src: replaced_len_src,
        },
        Inst::BinOp {
            dst: sum_len_tmp,
            op: sum_len_op,
            lhs: sum_len_lhs,
            rhs: sum_len_rhs,
        },
        index_needle_const,
        Inst::Call {
            dst: Some(index_res),
            recv: Some(index_recv),
            args: index_args,
            ..
        },
        Inst::BinOp {
            dst: sum_index_tmp,
            op: sum_index_op,
            lhs: sum_index_lhs,
            rhs: sum_index_rhs,
        },
        char_idx_const,
        Inst::Call {
            dst: Some(char_res),
            recv: Some(char_recv),
            args: char_args,
            ..
        },
        Inst::BinOp {
            dst: sum_char_tmp,
            op: sum_char_op,
            lhs: sum_char_lhs,
            rhs: sum_char_rhs,
        },
        Inst::Copy {
            dst: sum_copy,
            src: sum_char_src,
        },
    ) = (
        &body[0], &body[1], &body[2], &body[3], &body[4], &body[5], &body[6], &body[7], &body[8],
        &body[9], &body[10], &body[11], &body[12], &body[13],
    )
    else {
        return None;
    };

    if replace_builtin != "string.replaceAll"
        || replace_args.len() != 2
        || replace_args[0].0 != match_const_dst(pat_const)?
        || replace_args[1].0 != match_const_dst(rep_const)?
        || replaced_res.0 != replaced_src.0
        || last_src.0 != replaced.0
        || replaced_len_src.0 != replaced.0
        || sum_len_op != "+"
        || replaced_len.0 != sum_len_rhs.0
        || index_recv.0 != replaced.0
        || index_args.len() != 1
        || index_args[0].0 != match_const_dst(index_needle_const)?
        || sum_index_op != "+"
        || sum_len_tmp.0 != sum_index_lhs.0
        || index_res.0 != sum_index_rhs.0
        || char_recv.0 != replaced.0
        || char_args.len() != 1
        || char_args[0].0 != match_const_dst(char_idx_const)?
        || sum_char_op != "+"
        || sum_index_tmp.0 != sum_char_lhs.0
        || char_res.0 != sum_char_rhs.0
        || sum_char_tmp.0 != sum_char_src.0
        || sum_copy.0 != sum_len_lhs.0
        || !ctx.unboxed.contains(&sum_copy.0)
    {
        return None;
    }

    let char_idx = match_const_i64(char_idx_const, ctx)?;
    if char_idx < 0 {
        return None;
    }
    let counter = match_counter_add_tail(body, 14, ctx)?;
    if body
        .iter()
        .any(|inst| inst_def_local(inst) == Some(replace_recv.0))
    {
        return None;
    }

    let pat = static_string_expr_from_const(pat_const, ctx)?;
    let rep = static_string_expr_from_const(rep_const, ctx)?;
    let index_needle = static_string_expr_from_const(index_needle_const, ctx)?;
    Some(StaticReplaceEscapeShape {
        recv: replace_recv.0,
        pattern: pat,
        replacement: rep,
        index_needle,
        char_idx,
        last: last.0,
        acc: sum_copy.0,
        counter,
    })
}

fn try_emit_fused_replace_escape_loop(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
    top: u32,
) -> Option<()> {
    let shape = match_static_replace_escape_shape(body, ctx)?;
    emit_static_replace_escape_loop(s, cond, cond_body, body, ctx, top, &shape);
    Some(())
}

fn emit_static_replace_escape_loop(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
    top: u32,
    shape: &StaticReplaceEscapeShape,
) {
    let base = ctx.val(shape.recv);
    let out_var = format!("_fre_out{}", top);
    let inc_var = format!("_fre_inc{}", top);
    let _ = writeln!(
        s,
        "  tsv {} = ts_str_replace({}, {}, {}, 1);",
        out_var, base, shape.pattern, shape.replacement
    );
    let _ = writeln!(s, "  ts_gc_root(&{});", out_var);
    let _ = writeln!(s, "  long long {} = -1;", inc_var);
    let _ = writeln!(
        s,
        "  if (ts_is_str({})) {} = (long long)ts_str_len_typed({}) + (long long)ts_str_indexof_fast({}, {}, 0, 1) + (long long)ts_str_charcodeat_i64_typed({}, {}LL);",
        out_var, inc_var, out_var, out_var, shape.index_needle, out_var, shape.char_idx
    );
    let _ = writeln!(s, "  if ({} >= 0) {{", inc_var);
    emit_checked_loop(s, cond, cond_body, ctx, |s| {
        s.push_str(&ctx.set_val(shape.last, &out_var));
        emit_metric_acc_add(s, shape.acc, &inc_var, ctx);
        let _ = writeln!(
            s,
            "  d{} += {}LL;",
            shape.counter.counter, shape.counter.inc
        );
    });
    s.push_str("  ts_gc_unroot(1);\n");
    s.push_str("  } else {\n");
    s.push_str("  ts_gc_unroot(1);\n");
    emit_runtime_loop(s, cond, cond_body, body, ctx);
    s.push_str("  }\n");
}

fn try_emit_fused_case_trim_loop(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
    top: u32,
) -> Option<()> {
    if body.len() != 20 {
        return None;
    }
    let (
        Inst::CallBuiltin {
            dst: Some(trim_res),
            builtin: trim_builtin,
            recv: trim_recv,
            args: trim_args,
        },
        Inst::Copy {
            dst: trimmed,
            src: trim_src,
        },
        Inst::CallBuiltin {
            dst: Some(upper_res),
            builtin: upper_builtin,
            recv: upper_recv,
            args: upper_args,
        },
        Inst::Copy {
            dst: uppered,
            src: upper_src,
        },
        Inst::CallBuiltin {
            dst: Some(lower_res),
            builtin: lower_builtin,
            recv: lower_recv,
            args: lower_args,
        },
        Inst::Copy {
            dst: lowered,
            src: lower_src,
        },
        Inst::StringLen {
            dst: lower_len1,
            src: lower_len1_src,
        },
        Inst::BinOp {
            dst: sum_len_tmp,
            op: sum_len_op,
            lhs: sum_len_lhs,
            rhs: sum_len_rhs,
        },
        zero_const,
        Inst::CallBuiltin {
            dst: Some(first_ch),
            builtin: first_builtin,
            recv: first_recv,
            args: first_args,
        },
        Inst::BinOp {
            dst: sum_first_tmp,
            op: sum_first_op,
            lhs: sum_first_lhs,
            rhs: sum_first_rhs,
        },
        Inst::StringLen {
            dst: lower_len2,
            src: lower_len2_src,
        },
        one_const,
        Inst::BinOp {
            dst: last_idx,
            op: last_idx_op,
            lhs: last_idx_lhs,
            rhs: last_idx_rhs,
        },
        Inst::CallBuiltin {
            dst: Some(last_ch),
            builtin: last_builtin,
            recv: last_recv,
            args: last_args,
        },
        Inst::BinOp {
            dst: sum_last_tmp,
            op: sum_last_op,
            lhs: sum_last_lhs,
            rhs: sum_last_rhs,
        },
        Inst::Copy {
            dst: sum_copy,
            src: sum_last_src,
        },
    ) = (
        &body[0], &body[1], &body[2], &body[3], &body[4], &body[5], &body[6], &body[7], &body[8],
        &body[9], &body[10], &body[11], &body[12], &body[13], &body[14], &body[15], &body[16],
    )
    else {
        return None;
    };

    if trim_builtin != "string.trim"
        || upper_builtin != "string.toUpperCase"
        || lower_builtin != "string.toLowerCase"
        || !trim_args.is_empty()
        || !upper_args.is_empty()
        || !lower_args.is_empty()
        || trim_res.0 != trim_src.0
        || upper_recv.0 != trimmed.0
        || upper_res.0 != upper_src.0
        || lower_recv.0 != uppered.0
        || lower_res.0 != lower_src.0
        || lower_len1_src.0 != lowered.0
        || sum_len_op != "+"
        || lower_len1.0 != sum_len_rhs.0
        || match_const_i64(zero_const, ctx)? != 0
        || first_builtin != "string.charCodeAt"
        || first_recv.0 != lowered.0
        || first_args.len() != 1
        || first_args[0].0 != match_const_dst(zero_const)?
        || sum_first_op != "+"
        || sum_len_tmp.0 != sum_first_lhs.0
        || first_ch.0 != sum_first_rhs.0
        || lower_len2_src.0 != lowered.0
        || match_const_i64(one_const, ctx)? != 1
        || last_idx_op != "-"
        || lower_len2.0 != last_idx_lhs.0
        || last_idx_rhs.0 != match_const_dst(one_const)?
        || last_builtin != "string.charCodeAt"
        || last_recv.0 != lowered.0
        || last_args.len() != 1
        || last_args[0].0 != last_idx.0
        || sum_last_op != "+"
        || sum_first_tmp.0 != sum_last_lhs.0
        || last_ch.0 != sum_last_rhs.0
        || sum_last_tmp.0 != sum_last_src.0
        || sum_copy.0 != sum_len_lhs.0
        || !ctx.unboxed.contains(&sum_copy.0)
    {
        return None;
    }

    let counter = match_counter_add_tail(body, 17, ctx)?;
    if body
        .iter()
        .any(|inst| inst_def_local(inst) == Some(trim_recv.0))
    {
        return None;
    }

    let shape = StaticCaseTrimMetricShape {
        recv: trim_recv.0,
        acc: sum_copy.0,
        counter,
    };
    emit_static_case_trim_metric_loop(s, cond, cond_body, body, ctx, top, &shape);
    Some(())
}

fn emit_static_case_trim_metric_loop(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
    top: u32,
    shape: &StaticCaseTrimMetricShape,
) {
    let base = ctx.val(shape.recv);
    let trim_var = format!("_fct_trim{}", top);
    let upper_var = format!("_fct_upper{}", top);
    let lower_var = format!("_fct_lower{}", top);
    let len_var = format!("_fct_len{}", top);
    let inc_var = format!("_fct_inc{}", top);
    let _ = writeln!(s, "  tsv {} = ts_str_trim({});", trim_var, base);
    let _ = writeln!(s, "  ts_gc_root(&{});", trim_var);
    let _ = writeln!(
        s,
        "  tsv {} = ts_unicode_toupper_tsv({});",
        upper_var, trim_var
    );
    let _ = writeln!(s, "  ts_gc_root(&{});", upper_var);
    let _ = writeln!(
        s,
        "  tsv {} = ts_unicode_tolower_tsv({});",
        lower_var, upper_var
    );
    let _ = writeln!(s, "  ts_gc_root(&{});", lower_var);
    let first_var = format!("{}_first", inc_var);
    let last_var = format!("{}_last", inc_var);
    let _ = writeln!(
        s,
        "  long long {} = -1, {} = 0, {} = 0, {} = 0;",
        inc_var, len_var, first_var, last_var
    );
    let _ = writeln!(s,
        "  if (ts_is_str({base}) && ({len} = (long long)ts_str_len_typed({base})) > 0) {{ {first} = ts_str_charcodeat_i64_typed({base}, 0); {last} = ts_str_charcodeat_i64_typed({base}, {len} - 1); {inc} = {len} + {first} + {last}; }}",
        base=lower_var, len=len_var, first=first_var, last=last_var, inc=inc_var);
    s.push_str("  ts_gc_unroot(3);\n");
    let _ = writeln!(s, "  if ({} >= 0) {{", inc_var);
    emit_checked_loop(s, cond, cond_body, ctx, |s| {
        if ctx.int_local.contains(&shape.acc) {
            let _ = writeln!(s, "  d{} += {};", shape.acc, inc_var);
        } else {
            let _ = writeln!(
                s,
                "  d{a} += (double){len}; d{a} += (double){first}; d{a} += (double){last};",
                a = shape.acc,
                len = len_var,
                first = first_var,
                last = last_var
            );
        }
        let _ = writeln!(
            s,
            "  d{} += {}LL;",
            shape.counter.counter, shape.counter.inc
        );
    });
    s.push_str("  } else {\n");
    emit_runtime_loop(s, cond, cond_body, body, ctx);
    s.push_str("  }\n");
}

fn match_static_case_trim_escape_shape(
    body: &[Inst],
    ctx: &Ctx,
) -> Option<StaticCaseTrimEscapeShape> {
    if body.len() != 21 {
        return None;
    }
    let (
        Inst::CallBuiltin {
            dst: Some(trim_res),
            builtin: trim_builtin,
            recv: trim_recv,
            args: trim_args,
        },
        Inst::Copy {
            dst: trimmed,
            src: trim_src,
        },
        Inst::CallBuiltin {
            dst: Some(upper_res),
            builtin: upper_builtin,
            recv: upper_recv,
            args: upper_args,
        },
        Inst::Copy {
            dst: uppered,
            src: upper_src,
        },
        Inst::CallBuiltin {
            dst: Some(lower_res),
            builtin: lower_builtin,
            recv: lower_recv,
            args: lower_args,
        },
        Inst::Copy {
            dst: lowered,
            src: lower_src,
        },
        Inst::Copy {
            dst: last,
            src: last_src,
        },
        Inst::StringLen {
            dst: lower_len1,
            src: lower_len1_src,
        },
        Inst::BinOp {
            dst: sum_len_tmp,
            op: sum_len_op,
            lhs: sum_len_lhs,
            rhs: sum_len_rhs,
        },
        zero_const,
        Inst::CallBuiltin {
            dst: Some(first_ch),
            builtin: first_builtin,
            recv: first_recv,
            args: first_args,
        },
        Inst::BinOp {
            dst: sum_first_tmp,
            op: sum_first_op,
            lhs: sum_first_lhs,
            rhs: sum_first_rhs,
        },
        Inst::StringLen {
            dst: lower_len2,
            src: lower_len2_src,
        },
        one_const,
        Inst::BinOp {
            dst: last_idx,
            op: last_idx_op,
            lhs: last_idx_lhs,
            rhs: last_idx_rhs,
        },
        Inst::CallBuiltin {
            dst: Some(last_ch),
            builtin: last_builtin,
            recv: last_recv,
            args: last_args,
        },
        Inst::BinOp {
            dst: sum_last_tmp,
            op: sum_last_op,
            lhs: sum_last_lhs,
            rhs: sum_last_rhs,
        },
        Inst::Copy {
            dst: sum_copy,
            src: sum_last_src,
        },
    ) = (
        &body[0], &body[1], &body[2], &body[3], &body[4], &body[5], &body[6], &body[7], &body[8],
        &body[9], &body[10], &body[11], &body[12], &body[13], &body[14], &body[15], &body[16],
        &body[17],
    )
    else {
        return None;
    };

    if trim_builtin != "string.trim"
        || upper_builtin != "string.toUpperCase"
        || lower_builtin != "string.toLowerCase"
        || !trim_args.is_empty()
        || !upper_args.is_empty()
        || !lower_args.is_empty()
        || trim_res.0 != trim_src.0
        || upper_recv.0 != trimmed.0
        || upper_res.0 != upper_src.0
        || lower_recv.0 != uppered.0
        || lower_res.0 != lower_src.0
        || last_src.0 != lowered.0
        || lower_len1_src.0 != lowered.0
        || sum_len_op != "+"
        || lower_len1.0 != sum_len_rhs.0
        || match_const_i64(zero_const, ctx)? != 0
        || first_builtin != "string.charCodeAt"
        || first_recv.0 != lowered.0
        || first_args.len() != 1
        || first_args[0].0 != match_const_dst(zero_const)?
        || sum_first_op != "+"
        || sum_len_tmp.0 != sum_first_lhs.0
        || first_ch.0 != sum_first_rhs.0
        || lower_len2_src.0 != lowered.0
        || match_const_i64(one_const, ctx)? != 1
        || last_idx_op != "-"
        || lower_len2.0 != last_idx_lhs.0
        || last_idx_rhs.0 != match_const_dst(one_const)?
        || last_builtin != "string.charCodeAt"
        || last_recv.0 != lowered.0
        || last_args.len() != 1
        || last_args[0].0 != last_idx.0
        || sum_last_op != "+"
        || sum_first_tmp.0 != sum_last_lhs.0
        || last_ch.0 != sum_last_rhs.0
        || sum_last_tmp.0 != sum_last_src.0
        || sum_copy.0 != sum_len_lhs.0
        || !ctx.unboxed.contains(&sum_copy.0)
    {
        return None;
    }
    let counter = match_counter_add_tail(body, 18, ctx)?;
    if body
        .iter()
        .any(|inst| inst_def_local(inst) == Some(trim_recv.0))
    {
        return None;
    }

    Some(StaticCaseTrimEscapeShape {
        recv: trim_recv.0,
        last: last.0,
        acc: sum_copy.0,
        counter,
    })
}

fn try_emit_fused_case_trim_escape_loop(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
    top: u32,
) -> Option<()> {
    let shape = match_static_case_trim_escape_shape(body, ctx)?;
    emit_static_case_trim_escape_loop(s, cond, cond_body, body, ctx, top, &shape);
    Some(())
}

fn emit_static_case_trim_escape_loop(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
    top: u32,
    shape: &StaticCaseTrimEscapeShape,
) {
    let base = ctx.val(shape.recv);
    let trim_var = format!("_fcte_trim{}", top);
    let upper_var = format!("_fcte_upper{}", top);
    let lower_var = format!("_fcte_lower{}", top);
    let len_var = format!("_fcte_len{}", top);
    let inc_var = format!("_fcte_inc{}", top);
    let _ = writeln!(s, "  tsv {} = ts_str_trim({});", trim_var, base);
    let _ = writeln!(s, "  ts_gc_root(&{});", trim_var);
    let _ = writeln!(
        s,
        "  tsv {} = ts_unicode_toupper_tsv({});",
        upper_var, trim_var
    );
    let _ = writeln!(s, "  ts_gc_root(&{});", upper_var);
    let _ = writeln!(
        s,
        "  tsv {} = ts_unicode_tolower_tsv({});",
        lower_var, upper_var
    );
    let _ = writeln!(s, "  ts_gc_root(&{});", lower_var);
    let first_var = format!("{}_first", inc_var);
    let last_var = format!("{}_last", inc_var);
    let _ = writeln!(
        s,
        "  long long {} = -1, {} = 0, {} = 0, {} = 0;",
        inc_var, len_var, first_var, last_var
    );
    let _ = writeln!(s,
        "  if (ts_is_str({base}) && ({len} = (long long)ts_str_len_typed({base})) > 0) {{ {first} = ts_str_charcodeat_i64_typed({base}, 0); {last} = ts_str_charcodeat_i64_typed({base}, {len} - 1); {inc} = {len} + {first} + {last}; }}",
        base=lower_var, len=len_var, first=first_var, last=last_var, inc=inc_var);
    let _ = writeln!(s, "  if ({} >= 0) {{", inc_var);
    emit_checked_loop(s, cond, cond_body, ctx, |s| {
        s.push_str(&ctx.set_val(shape.last, &lower_var));
        if ctx.int_local.contains(&shape.acc) {
            let _ = writeln!(s, "  d{} += {};", shape.acc, inc_var);
        } else {
            let _ = writeln!(
                s,
                "  d{a} += (double){len}; d{a} += (double){first}; d{a} += (double){last};",
                a = shape.acc,
                len = len_var,
                first = first_var,
                last = last_var
            );
        }
        let _ = writeln!(
            s,
            "  d{} += {}LL;",
            shape.counter.counter, shape.counter.inc
        );
    });
    s.push_str("  ts_gc_unroot(3);\n");
    s.push_str("  } else {\n");
    s.push_str("  ts_gc_unroot(3);\n");
    emit_runtime_loop(s, cond, cond_body, body, ctx);
    s.push_str("  }\n");
}

fn try_emit_planned_string_materialization_loop(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
    top: u32,
    plan: &LoopMaterializationPlan,
) -> Option<()> {
    match plan.full_body.as_ref()? {
        MaterializationOp::StaticSplitJoinEscape(op) => {
            let shape = static_split_join_escape_shape_from_plan(op, ctx)?;
            emit_static_split_join_escape_loop(s, cond, cond_body, body, ctx, top, &shape);
            Some(())
        }
        MaterializationOp::StaticReplaceEscape(op) => {
            let shape = static_replace_escape_shape_from_plan(op, ctx)?;
            emit_static_replace_escape_loop(s, cond, cond_body, body, ctx, top, &shape);
            Some(())
        }
        MaterializationOp::StaticCaseTrimEscape(op) => {
            let shape = static_case_trim_escape_shape_from_plan(op, ctx)?;
            emit_static_case_trim_escape_loop(s, cond, cond_body, body, ctx, top, &shape);
            Some(())
        }
        MaterializationOp::DynamicReplaceEscape(op) => {
            let shape = dynamic_replace_escape_shape_from_plan(op);
            let end = ctx.fresh_label();
            emit_dynamic_replace_escape_select_loop(
                s, cond, cond_body, body, ctx, top, end, &shape,
            );
            Some(())
        }
        MaterializationOp::DynamicSplitJoinEscape(op) => {
            let shape = dynamic_split_join_escape_shape_from_plan(op);
            let end = ctx.fresh_label();
            emit_dynamic_split_join_escape_select_loop(
                s, cond, cond_body, body, ctx, top, end, &shape,
            );
            Some(())
        }
    }
}

fn static_split_join_escape_shape_from_plan(
    op: &StaticSplitJoinEscapeMaterialization,
    ctx: &Ctx,
) -> Option<StaticSplitJoinEscapeShape> {
    if !ctx.unboxed.contains(&op.acc) || !ctx.int_local.contains(&op.counter.counter) {
        return None;
    }
    Some(StaticSplitJoinEscapeShape {
        recv: op.recv,
        separator: static_string_literal_expr_units(&op.separator, ctx)?,
        joiner: static_string_literal_expr_units(&op.joiner, ctx)?,
        last: op.last,
        acc: op.acc,
        counter: CounterAddTail {
            counter: op.counter.counter,
            inc: op.counter.inc,
        },
    })
}

fn static_replace_escape_shape_from_plan(
    op: &StaticReplaceEscapeMaterialization,
    ctx: &Ctx,
) -> Option<StaticReplaceEscapeShape> {
    if !ctx.unboxed.contains(&op.acc) || !ctx.int_local.contains(&op.counter.counter) {
        return None;
    }
    Some(StaticReplaceEscapeShape {
        recv: op.recv,
        pattern: static_string_literal_expr_units(&op.pattern, ctx)?,
        replacement: static_string_literal_expr_units(&op.replacement, ctx)?,
        index_needle: static_string_literal_expr_units(&op.index_needle, ctx)?,
        char_idx: op.char_idx,
        last: op.last,
        acc: op.acc,
        counter: CounterAddTail {
            counter: op.counter.counter,
            inc: op.counter.inc,
        },
    })
}

fn static_case_trim_escape_shape_from_plan(
    op: &StaticCaseTrimEscapeMaterialization,
    ctx: &Ctx,
) -> Option<StaticCaseTrimEscapeShape> {
    if !ctx.unboxed.contains(&op.acc) || !ctx.int_local.contains(&op.counter.counter) {
        return None;
    }
    Some(StaticCaseTrimEscapeShape {
        recv: op.recv,
        last: op.last,
        acc: op.acc,
        counter: CounterAddTail {
            counter: op.counter.counter,
            inc: op.counter.inc,
        },
    })
}

fn source_select4_from_plan(op: crate::string_materialization::SourceSelect4Plan) -> SourceSelect4 {
    SourceSelect4 {
        len: op.len,
        dst: op.dst,
        pick: op.pick,
        values: op.values,
    }
}

fn dynamic_replace_escape_shape_from_plan(
    op: &DynamicReplaceEscapeMaterialization,
) -> DynamicReplaceEscapeSelectShape {
    DynamicReplaceEscapeSelectShape {
        select: source_select4_from_plan(op.select),
        skip: op.skip,
        pattern: op.pattern,
        replacement: op.replacement,
        last: op.last,
        acc: op.acc,
        mult: op.mult,
        mask: op.mask,
    }
}

fn dynamic_split_join_escape_shape_from_plan(
    op: &DynamicSplitJoinEscapeMaterialization,
) -> DynamicSplitJoinEscapeSelectShape {
    DynamicSplitJoinEscapeSelectShape {
        select: source_select4_from_plan(op.select),
        skip: op.skip,
        separator: op.separator,
        joiner: op.joiner,
        last: op.last,
        acc: op.acc,
        part_index: op.part_index,
        mult: op.mult,
        mask: op.mask,
    }
}

fn try_emit_planned_string_metric_loop(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
    top: u32,
    plan: &LoopMetricPlan,
) -> Option<()> {
    match plan.full_loop.as_ref()? {
        LoopMetricOp::CaseTrim(op) => {
            let shape = static_case_trim_metric_shape_from_plan(op, ctx)?;
            emit_static_case_trim_metric_loop(s, cond, cond_body, body, ctx, top, &shape);
            Some(())
        }
    }
}

fn static_case_trim_metric_shape_from_plan(
    op: &CaseTrimMetric,
    ctx: &Ctx,
) -> Option<StaticCaseTrimMetricShape> {
    if !ctx.unboxed.contains(&op.acc) || !ctx.int_local.contains(&op.counter.counter) {
        return None;
    }
    Some(StaticCaseTrimMetricShape {
        recv: op.recv,
        acc: op.acc,
        counter: CounterAddTail {
            counter: op.counter.counter,
            inc: op.counter.inc,
        },
    })
}

fn emit_metric_acc_add(s: &mut String, acc: u32, metric: &str, ctx: &Ctx) {
    if ctx.int_local.contains(&acc) {
        let _ = writeln!(s, "  d{} += {};", acc, metric);
    } else if ctx.unboxed.contains(&acc) {
        let _ = writeln!(s, "  d{} += (double){};", acc, metric);
    } else {
        let acc_name = ctx.vname(acc);
        let _ = writeln!(
            s,
            "  {} = ts_add({}, ts_num((double){}));",
            acc_name, acc_name, metric
        );
    }
}

fn emit_metric_needle_expr(needle: &MetricNeedle, ctx: &Ctx) -> Option<String> {
    match needle {
        MetricNeedle::StaticLiteral(value) => static_string_literal_expr_units(value, ctx),
        MetricNeedle::Local(local) => Some(ctx.val(*local)),
    }
}

fn emit_metric_fallback_range(s: &mut String, body: &[Inst], start: usize, len: usize, ctx: &Ctx) {
    for (offset, inst) in body[start..start + len].iter().enumerate() {
        emit_inst_at(s, inst, ctx, PathEdge::LoopBody, start + offset);
    }
}

fn try_emit_planned_string_metric(
    s: &mut String,
    body: &[Inst],
    op: &MetricOp,
    ctx: &Ctx,
    top: u32,
) -> Option<usize> {
    match op {
        MetricOp::SearchPair(search) => {
            let base = ctx.val(search.recv);
            let needle1 = emit_metric_needle_expr(&search.needle1, ctx)?;
            let needle2 = emit_metric_needle_expr(&search.needle2, ctx)?;
            let prefix = if matches!(
                (&search.needle1, &search.needle2),
                (
                    MetricNeedle::StaticLiteral(_),
                    MetricNeedle::StaticLiteral(_)
                )
            ) {
                "_fsdm"
            } else {
                "_fsdmp"
            };
            let metric = format!("{}{}_{}", prefix, top, search.start);
            let _ = writeln!(
                s,
                "  long long {} = (long long)ts_str_indexof_fast({}, {}, {}, 1) + (long long)ts_str_lastindexof_fast({}, {}, (double)ts_str_len_typed({}), 1);",
                metric,
                base,
                needle1,
                ctx.num(search.from),
                base,
                needle2,
                base
            );
            emit_metric_acc_add(s, search.acc, &metric, ctx);
            Some(search.len)
        }
        MetricOp::Replace(replace) => {
            let pat = emit_metric_needle_expr(&replace.pattern, ctx)?;
            let rep = emit_metric_needle_expr(&replace.replacement, ctx)?;
            let needle = emit_metric_needle_expr(&replace.index_needle, ctx)?;
            let prefix = if matches!(
                (
                    &replace.pattern,
                    &replace.replacement,
                    &replace.index_needle
                ),
                (
                    MetricNeedle::StaticLiteral(_),
                    MetricNeedle::StaticLiteral(_),
                    MetricNeedle::StaticLiteral(_)
                )
            ) {
                "_frdm"
            } else {
                "_frdmp"
            };
            let metric = format!("{}{}_{}", prefix, top, replace.start);
            let _ = writeln!(
                s,
                "  long long {} = ts_str_replace_literal_metric3({}, {}, {}, {}, {}LL, 1);",
                metric,
                ctx.val(replace.recv),
                pat,
                rep,
                needle,
                replace.char_idx
            );
            let _ = writeln!(s, "  if ({} >= 0) {{", metric);
            emit_metric_acc_add(s, replace.acc, &metric, ctx);
            s.push_str("  } else {\n");
            emit_metric_fallback_range(s, body, replace.start, replace.len, ctx);
            s.push_str("  }\n");
            Some(replace.len)
        }
        MetricOp::SplitJoin(split_join) => {
            let separator = emit_metric_needle_expr(&split_join.separator, ctx)?;
            let joiner = emit_metric_needle_expr(&split_join.joiner, ctx)?;
            let prefix = if matches!(
                (&split_join.separator, &split_join.joiner),
                (
                    MetricNeedle::StaticLiteral(_),
                    MetricNeedle::StaticLiteral(_)
                )
            ) {
                "_fsjdm"
            } else {
                "_fsjdmp"
            };
            let metric = format!("{}{}_{}", prefix, top, split_join.start);
            let _ = writeln!(
                s,
                "  long long {} = ts_str_split_join_metric3({}, {}, {}, {}LL);",
                metric,
                ctx.val(split_join.recv),
                separator,
                joiner,
                split_join.part_index
            );
            let _ = writeln!(s, "  if ({} >= 0) {{", metric);
            emit_metric_acc_add(s, split_join.acc, &metric, ctx);
            s.push_str("  } else {\n");
            emit_metric_fallback_range(s, body, split_join.start, split_join.len, ctx);
            s.push_str("  }\n");
            Some(split_join.len)
        }
    }
}

#[derive(Clone, Copy)]
struct SourceSelect4 {
    len: usize,
    dst: u32,
    pick: u32,
    values: [u32; 4],
}

struct PairSelect4 {
    len: usize,
    dst1: u32,
    dst2: u32,
    pick: u32,
    values1: [u32; 4],
    values2: [u32; 4],
}

struct DynamicReplaceEscapeSelectShape {
    select: SourceSelect4,
    skip: usize,
    pattern: u32,
    replacement: u32,
    last: u32,
    acc: u32,
    mult: i64,
    mask: i64,
}

struct DynamicSplitJoinEscapeSelectShape {
    select: SourceSelect4,
    skip: usize,
    separator: u32,
    joiner: u32,
    last: u32,
    acc: u32,
    part_index: i64,
    mult: i64,
    mask: i64,
}

struct DynamicSearchSelectShape {
    select: SourceSelect4,
    search: SearchPair,
    skip: usize,
}

struct PolymorphicPatternSearchShape {
    select: SourceSelect4,
    recv: u32,
    acc: u32,
    skip: usize,
}

struct StaticSplitJoinEscapeShape {
    recv: u32,
    separator: String,
    joiner: String,
    last: u32,
    acc: u32,
    counter: CounterAddTail,
}

struct StaticReplaceEscapeShape {
    recv: u32,
    pattern: String,
    replacement: String,
    index_needle: String,
    char_idx: i64,
    last: u32,
    acc: u32,
    counter: CounterAddTail,
}

struct StaticCaseTrimMetricShape {
    recv: u32,
    acc: u32,
    counter: CounterAddTail,
}

struct StaticCaseTrimEscapeShape {
    recv: u32,
    last: u32,
    acc: u32,
    counter: CounterAddTail,
}

struct Select4<const N: usize> {
    len: usize,
    pick: u32,
    dsts: [u32; N],
    values: [[u32; 4]; N],
}

fn parse_select_copies<const N: usize>(
    seq: &[Inst],
    expected_dsts: Option<&[u32; N]>,
) -> Option<([u32; N], [u32; N])> {
    if seq.len() != N {
        return None;
    }
    let mut dsts = [0u32; N];
    let mut values = [0u32; N];
    for (i, inst) in seq.iter().enumerate() {
        let Inst::Copy { dst, src } = inst else {
            return None;
        };
        if let Some(expected) = expected_dsts {
            if dst.0 != expected[i] {
                return None;
            }
        }
        dsts[i] = dst.0;
        values[i] = src.0;
    }
    Some((dsts, values))
}

fn parse_select_branch<'a>(
    const_inst: &Inst,
    cmp_inst: &Inst,
    if_inst: &'a Inst,
    expected_case: i64,
    expected_pick: Option<u32>,
    ctx: &Ctx,
) -> Option<(u32, &'a [Inst], &'a [Inst])> {
    let Inst::BinOp {
        dst: cmp,
        op,
        lhs,
        rhs,
    } = cmp_inst
    else {
        return None;
    };
    let Inst::If {
        cond,
        then_body,
        else_body,
    } = if_inst
    else {
        return None;
    };
    if op != "===" || cmp.0 != cond.0 || match_const_i64(const_inst, ctx)? != expected_case {
        return None;
    }
    let case_const = match_const_dst(const_inst)?;
    let pick = if lhs.0 == case_const {
        rhs.0
    } else if rhs.0 == case_const {
        lhs.0
    } else {
        return None;
    };
    if let Some(expected) = expected_pick {
        if pick != expected {
            return None;
        }
    }
    Some((pick, then_body.as_slice(), else_body.as_slice()))
}

fn parse_select4<const N: usize>(body: &[Inst], start: usize, ctx: &Ctx) -> Option<Select4<N>> {
    if body.len().saturating_sub(start) < N + 3 {
        return None;
    }
    let (dsts, values0) = parse_select_copies::<N>(&body[start..start + N], None)?;
    let (pick, then1, else1) = parse_select_branch(
        &body[start + N],
        &body[start + N + 1],
        &body[start + N + 2],
        1,
        None,
        ctx,
    )?;
    let (_, values1) = parse_select_copies::<N>(then1, Some(&dsts))?;
    if else1.len() != 3 {
        return None;
    }
    let (_, then2, else2) =
        parse_select_branch(&else1[0], &else1[1], &else1[2], 2, Some(pick), ctx)?;
    let (_, values2) = parse_select_copies::<N>(then2, Some(&dsts))?;
    if else2.len() != 3 {
        return None;
    }
    let (_, then3, else3) =
        parse_select_branch(&else2[0], &else2[1], &else2[2], 3, Some(pick), ctx)?;
    let (_, values3) = parse_select_copies::<N>(then3, Some(&dsts))?;
    if !else3.is_empty() {
        return None;
    }

    let mut values = [[0u32; 4]; N];
    for i in 0..N {
        values[i] = [values0[i], values1[i], values2[i], values3[i]];
    }
    Some(Select4 {
        len: N + 3,
        pick,
        dsts,
        values,
    })
}

fn parse_source_select4(body: &[Inst], start: usize, ctx: &Ctx) -> Option<SourceSelect4> {
    let select = parse_select4::<1>(body, start, ctx)?;
    Some(SourceSelect4 {
        len: select.len,
        dst: select.dsts[0],
        pick: select.pick,
        values: select.values[0],
    })
}

fn parse_pair_select4(body: &[Inst], start: usize, ctx: &Ctx) -> Option<PairSelect4> {
    let select = parse_select4::<2>(body, start, ctx)?;
    Some(PairSelect4 {
        len: select.len,
        dst1: select.dsts[0],
        dst2: select.dsts[1],
        pick: select.pick,
        values1: select.values[0],
        values2: select.values[1],
    })
}

struct SearchPair {
    len: usize,
    recv: u32,
    acc: u32,
    from: u32,
    needle1: String,
    needle2: String,
}

fn parse_search_pair(body: &[Inst], start: usize, ctx: &Ctx) -> Option<SearchPair> {
    if body.len().saturating_sub(start) < 11 {
        return None;
    }
    let seq = &body[start..start + 11];
    let (
        Inst::Copy {
            dst: acc_alias1,
            src: acc_src1,
        },
        needle1_const,
        Inst::CallBuiltin {
            dst: Some(index_res),
            builtin: index_builtin,
            recv: index_recv,
            args: index_args,
        },
        Inst::BinOp {
            dst: index_sum_tmp,
            op: index_sum_op,
            lhs: index_sum_lhs,
            rhs: index_sum_rhs,
        },
        Inst::Copy {
            dst: acc_after_index,
            src: index_sum_src,
        },
        Inst::Copy {
            dst: acc_alias2,
            src: acc_src2,
        },
        needle2_const,
        Inst::StringLen {
            dst: hay_len,
            src: len_src,
        },
        Inst::CallBuiltin {
            dst: Some(last_res),
            builtin: last_builtin,
            recv: last_recv,
            args: last_args,
        },
        Inst::BinOp {
            dst: last_sum_tmp,
            op: last_sum_op,
            lhs: last_sum_lhs,
            rhs: last_sum_rhs,
        },
        Inst::Copy {
            dst: acc_after_last,
            src: last_sum_src,
        },
    ) = (
        &seq[0], &seq[1], &seq[2], &seq[3], &seq[4], &seq[5], &seq[6], &seq[7], &seq[8], &seq[9],
        &seq[10],
    )
    else {
        return None;
    };
    if index_builtin != "string.indexOf"
        || last_builtin != "string.lastIndexOf"
        || index_sum_op != "+"
        || last_sum_op != "+"
        || index_recv.0 != last_recv.0
        || len_src.0 != index_recv.0
        || index_args.len() != 2
        || index_args[0].0 != match_const_dst(needle1_const)?
        || last_args.len() != 2
        || last_args[0].0 != match_const_dst(needle2_const)?
        || last_args[1].0 != hay_len.0
        || index_sum_tmp.0 != index_sum_src.0
        || last_sum_tmp.0 != last_sum_src.0
        || acc_after_index.0 != acc_src1.0
        || acc_src2.0 != acc_after_index.0
        || acc_after_last.0 != acc_after_index.0
    {
        return None;
    }
    if !((index_sum_lhs.0 == acc_alias1.0 && index_sum_rhs.0 == index_res.0)
        || (index_sum_rhs.0 == acc_alias1.0 && index_sum_lhs.0 == index_res.0))
        || !((last_sum_lhs.0 == acc_alias2.0 && last_sum_rhs.0 == last_res.0)
            || (last_sum_rhs.0 == acc_alias2.0 && last_sum_lhs.0 == last_res.0))
    {
        return None;
    }
    Some(SearchPair {
        len: 11,
        recv: index_recv.0,
        acc: acc_after_last.0,
        from: index_args[1].0,
        needle1: static_string_expr_from_const(needle1_const, ctx)?,
        needle2: static_string_expr_from_const(needle2_const, ctx)?,
    })
}

fn match_dynamic_search_select_shape(body: &[Inst], ctx: &Ctx) -> Option<DynamicSearchSelectShape> {
    let select = parse_source_select4(body, 0, ctx)?;
    let search = parse_search_pair(body, select.len, ctx)?;
    if search.recv != select.dst {
        return None;
    }
    for value in select.values {
        if body.iter().any(|inst| inst_def_local(inst) == Some(value)) {
            return None;
        }
    }
    let skip = select.len + search.len;
    let mut skipped_defs = collect_defs(&body[..skip]);
    skipped_defs.insert(select.dst);
    if locals_used_after(body, skip, &skipped_defs) {
        return None;
    }

    Some(DynamicSearchSelectShape {
        select,
        search,
        skip,
    })
}

fn try_emit_fused_dynamic_search_select_loop(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
    top: u32,
    end: u32,
) -> Option<()> {
    let shape = match_dynamic_search_select_shape(body, ctx)?;
    let src_arr = format!("_fdss_src{}", top);
    let first_arr = format!("_fdss_first{}", top);
    let last_arr = format!("_fdss_last{}", top);
    let sel_var = format!("_fdss_sel{}", top);
    let idx_var = format!("_fdss_idx{}", top);
    emit_tsv_array4(s, &src_arr, ctx, &shape.select.values);
    let _ = writeln!(s, "  long long {}[4];", first_arr);
    let _ = writeln!(s, "  long long {}[4];", last_arr);
    let _ = writeln!(s, "  for (int _fdss_i = 0; _fdss_i < 4; _fdss_i++) {{");
    let _ = writeln!(
        s,
        "    {}[_fdss_i] = (long long)ts_str_indexof_fast({}[_fdss_i], {}, 0, 1);",
        first_arr, src_arr, shape.search.needle1
    );
    let _ = writeln!(
        s,
        "    {}[_fdss_i] = (long long)ts_str_lastindexof_fast({}[_fdss_i], {}, (double)ts_str_len_fast({}[_fdss_i]), 1);",
        last_arr, src_arr, shape.search.needle2, src_arr
    );
    s.push_str("  }\n");
    ctx.loop_labels
        .borrow_mut()
        .push((top, end, ctx.eh_depth.get()));
    let _ = writeln!(s, "  L{}: ;", top);
    emit_checked_loop(s, cond, cond_body, ctx, |s| {
        emit_select4_clamped(s, &sel_var, &ctx.num(shape.select.pick));
        let _ = writeln!(s, "  long long {} = {}[{}];", idx_var, first_arr, sel_var);
        let _ = writeln!(
            s,
            "  if ({} < 0 || {} > {}) {} = (long long)ts_str_indexof_fast({}[{}], {}, {}, 1);",
            idx_var,
            ctx.num(shape.search.from),
            idx_var,
            idx_var,
            src_arr,
            sel_var,
            shape.search.needle1,
            ctx.num(shape.search.from)
        );
        let metric = format!("({} + {}[{}])", idx_var, last_arr, sel_var);
        emit_metric_acc_add(s, shape.search.acc, &metric, ctx);
        for inst in &body[shape.skip..] {
            emit_inst(s, inst, ctx);
        }
        let _ = writeln!(s, "  goto L{};", top);
    });
    let _ = writeln!(s, "  L{}: ;", end);
    ctx.loop_labels.borrow_mut().pop();
    Some(())
}

fn match_dynamic_replace_escape_select_shape(
    body: &[Inst],
    ctx: &Ctx,
) -> Option<DynamicReplaceEscapeSelectShape> {
    let select = parse_source_select4(body, 0, ctx)?;
    if body.len().saturating_sub(select.len) < 25 {
        return None;
    }
    let seq = &body[select.len..select.len + 16];
    let (
        Inst::CallBuiltin {
            dst: Some(replaced_res),
            builtin: replace_builtin,
            recv: replace_recv,
            args: replace_args,
        },
        Inst::Copy {
            dst: replaced,
            src: replaced_src,
        },
        Inst::Copy {
            dst: last,
            src: last_src,
        },
        Inst::GenericLen {
            dst: replaced_len,
            src: replaced_len_src,
        },
        Inst::BinOp {
            dst: sum_len_tmp,
            op: sum_len_op,
            lhs: sum_len_lhs,
            rhs: sum_len_rhs,
        },
        Inst::Call {
            dst: Some(index_res),
            recv: Some(index_recv),
            args: index_args,
            ..
        },
        Inst::BinOp {
            dst: sum_index_tmp,
            op: sum_index_op,
            lhs: sum_index_lhs,
            rhs: sum_index_rhs,
        },
        Inst::Call {
            dst: Some(last_res),
            recv: Some(last_recv),
            args: last_args,
            ..
        },
        Inst::BinOp {
            dst: sum_last_tmp,
            op: sum_last_op,
            lhs: sum_last_lhs,
            rhs: sum_last_rhs,
        },
        mult_const,
        Inst::BinOp {
            dst: mul_tmp,
            op: mul_op,
            lhs: mul_lhs,
            rhs: mul_rhs,
        },
        mask_const,
        Inst::BinOp {
            dst: char_idx,
            op: mask_op,
            lhs: mask_lhs,
            rhs: mask_rhs,
        },
        Inst::Call {
            dst: Some(char_res),
            recv: Some(char_recv),
            args: char_args,
            ..
        },
        Inst::BinOp {
            dst: sum_char_tmp,
            op: sum_char_op,
            lhs: sum_char_lhs,
            rhs: sum_char_rhs,
        },
        Inst::Copy {
            dst: sum_copy,
            src: sum_char_src,
        },
    ) = (
        &seq[0], &seq[1], &seq[2], &seq[3], &seq[4], &seq[5], &seq[6], &seq[7], &seq[8], &seq[9],
        &seq[10], &seq[11], &seq[12], &seq[13], &seq[14], &seq[15],
    )
    else {
        return None;
    };

    if replace_builtin != "string.replaceAll"
        || replace_recv.0 != select.dst
        || replace_args.len() != 2
        || replaced_res.0 != replaced_src.0
        || last_src.0 != replaced.0
        || replaced_len_src.0 != replaced.0
        || sum_len_op != "+"
        || replaced_len.0 != sum_len_rhs.0
        || sum_copy.0 != sum_len_lhs.0
        || index_recv.0 != replaced.0
        || index_args.len() != 1
        || index_args[0].0 != replace_args[1].0
        || sum_index_op != "+"
        || sum_len_tmp.0 != sum_index_lhs.0
        || index_res.0 != sum_index_rhs.0
        || last_recv.0 != replaced.0
        || last_args.len() != 1
        || last_args[0].0 != replace_args[1].0
        || sum_last_op != "+"
        || sum_index_tmp.0 != sum_last_lhs.0
        || last_res.0 != sum_last_rhs.0
        || mul_op != "*"
        || mask_op != "&"
        || !add_uses(
            *mul_lhs,
            *mul_rhs,
            select.pick,
            match_const_dst(mult_const)?,
        )
        || mask_lhs.0 != mul_tmp.0
        || mask_rhs.0 != match_const_dst(mask_const)?
        || char_recv.0 != replaced.0
        || char_args.len() != 1
        || char_args[0].0 != char_idx.0
        || sum_char_op != "+"
        || sum_last_tmp.0 != sum_char_lhs.0
        || char_res.0 != sum_char_rhs.0
        || sum_char_tmp.0 != sum_char_src.0
    {
        return None;
    }
    let mult = match_const_i64(mult_const, ctx)?;
    let mask = match_const_i64(mask_const, ctx)?;
    if mult < 0 || mask < 0 {
        return None;
    }
    for value in select.values {
        if body.iter().any(|inst| inst_def_local(inst) == Some(value)) {
            return None;
        }
    }
    if body.iter().any(|inst| {
        let d = inst_def_local(inst);
        d == Some(replace_args[0].0) || d == Some(replace_args[1].0)
    }) {
        return None;
    }

    let skip = select.len + 16;
    let mut skipped_defs = collect_defs(&body[..skip]);
    skipped_defs.remove(&last.0);
    skipped_defs.remove(&sum_copy.0);
    if locals_used_after(body, skip, &skipped_defs) {
        return None;
    }

    Some(DynamicReplaceEscapeSelectShape {
        select,
        skip,
        pattern: replace_args[0].0,
        replacement: replace_args[1].0,
        last: last.0,
        acc: sum_copy.0,
        mult,
        mask,
    })
}

fn try_emit_fused_dynamic_replace_escape_select_loop(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
    top: u32,
    end: u32,
) -> Option<()> {
    let shape = match_dynamic_replace_escape_select_shape(body, ctx)?;
    emit_dynamic_replace_escape_select_loop(s, cond, cond_body, body, ctx, top, end, &shape);
    Some(())
}

fn emit_dynamic_replace_escape_select_loop(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
    top: u32,
    end: u32,
    shape: &DynamicReplaceEscapeSelectShape,
) {
    let src_arr = format!("_fdre_src{}", top);
    let out_arr = format!("_fdre_out{}", top);
    let metric_arr = format!("_fdre_metric{}", top);
    let sel_var = format!("_fdre_sel{}", top);
    emit_tsv_array4(s, &src_arr, ctx, &shape.select.values);
    emit_tsv_undefined_array4(s, &out_arr);
    let _ = writeln!(s, "  long long {}[4];", metric_arr);
    s.push_str("  for (int _fdre_i = 0; _fdre_i < 4; _fdre_i++) {\n");
    let _ = writeln!(
        s,
        "    {}[_fdre_i] = ts_str_replace({}[_fdre_i], {}, {}, 1);",
        out_arr,
        src_arr,
        ctx.val(shape.pattern),
        ctx.val(shape.replacement)
    );
    let _ = writeln!(s, "    ts_gc_root(&{}[_fdre_i]);", out_arr);
    let _ = writeln!(
        s,
        "    {}[_fdre_i] = (long long)ts_str_len_fast({}[_fdre_i]) + (long long)ts_str_indexof_fast({}[_fdre_i], {}, 0, 0) + (long long)ts_str_lastindexof_fast({}[_fdre_i], {}, (double)ts_str_len_fast({}[_fdre_i]), 1) + (long long)ts_str_charcodeat_i64_typed({}[_fdre_i], (long long)((_fdre_i * {}) & {}));",
        metric_arr,
        out_arr,
        out_arr,
        ctx.val(shape.replacement),
        out_arr,
        ctx.val(shape.replacement),
        out_arr,
        out_arr,
        shape.mult,
        shape.mask
    );
    s.push_str("  }\n");
    ctx.loop_labels
        .borrow_mut()
        .push((top, end, ctx.eh_depth.get()));
    let _ = writeln!(s, "  L{}: ;", top);
    emit_checked_loop(s, cond, cond_body, ctx, |s| {
        emit_select4_clamped(s, &sel_var, &ctx.num(shape.select.pick));
        s.push_str(&ctx.set_val(shape.last, &format!("{}[{}]", out_arr, sel_var)));
        emit_metric_acc_add(s, shape.acc, &format!("{}[{}]", metric_arr, sel_var), ctx);
        for inst in &body[shape.skip..] {
            emit_inst(s, inst, ctx);
        }
        let _ = writeln!(s, "  goto L{};", top);
    });
    let _ = writeln!(s, "  L{}: ;", end);
    s.push_str("  ts_gc_unroot(4);\n");
    ctx.loop_labels.borrow_mut().pop();
}

fn match_dynamic_split_join_escape_select_shape(
    body: &[Inst],
    ctx: &Ctx,
) -> Option<DynamicSplitJoinEscapeSelectShape> {
    let select = parse_source_select4(body, 0, ctx)?;
    if body.len().saturating_sub(select.len) < 20 {
        return None;
    }
    let seq = &body[select.len..select.len + 20];
    let (
        Inst::CallBuiltin {
            dst: Some(split_res),
            builtin: split_builtin,
            recv: split_recv,
            args: split_args,
        },
        Inst::Copy {
            dst: parts,
            src: split_src,
        },
        Inst::CallBuiltin {
            dst: Some(join_res),
            builtin: join_builtin,
            recv: join_recv,
            args: join_args,
        },
        Inst::Copy {
            dst: joined,
            src: join_src,
        },
        Inst::Copy {
            dst: last,
            src: last_src,
        },
        Inst::ArrayLen {
            dst: parts_len,
            arr: parts_len_src,
        },
        Inst::BinOp {
            dst: sum_parts_tmp,
            op: sum_parts_op,
            lhs: sum_parts_lhs,
            rhs: sum_parts_rhs,
        },
        Inst::StringLen {
            dst: joined_len,
            src: joined_len_src,
        },
        Inst::BinOp {
            dst: sum_joined_tmp,
            op: sum_joined_op,
            lhs: sum_joined_lhs,
            rhs: sum_joined_rhs,
        },
        part_index_const,
        Inst::LoadIndex {
            dst: part_value,
            arr: part_arr,
            index: part_index,
            ..
        },
        Inst::StringLen {
            dst: part_len,
            src: part_len_src,
        },
        Inst::BinOp {
            dst: sum_part_tmp,
            op: sum_part_op,
            lhs: sum_part_lhs,
            rhs: sum_part_rhs,
        },
        mult_const,
        Inst::BinOp {
            dst: mul_tmp,
            op: mul_op,
            lhs: mul_lhs,
            rhs: mul_rhs,
        },
        mask_const,
        Inst::BinOp {
            dst: char_idx,
            op: mask_op,
            lhs: mask_lhs,
            rhs: mask_rhs,
        },
        Inst::CallBuiltin {
            dst: Some(char_res),
            builtin: char_builtin,
            recv: char_recv,
            args: char_args,
        },
        Inst::BinOp {
            dst: sum_char_tmp,
            op: sum_char_op,
            lhs: sum_char_lhs,
            rhs: sum_char_rhs,
        },
        Inst::Copy {
            dst: sum_copy,
            src: sum_char_src,
        },
    ) = (
        &seq[0], &seq[1], &seq[2], &seq[3], &seq[4], &seq[5], &seq[6], &seq[7], &seq[8], &seq[9],
        &seq[10], &seq[11], &seq[12], &seq[13], &seq[14], &seq[15], &seq[16], &seq[17], &seq[18],
        &seq[19],
    )
    else {
        return None;
    };

    if split_builtin != "string.split"
        || split_recv.0 != select.dst
        || split_args.len() != 1
        || split_res.0 != split_src.0
        || join_builtin != "array.join"
        || join_recv.0 != parts.0
        || join_args.len() != 1
        || join_res.0 != join_src.0
        || last_src.0 != joined.0
        || parts_len_src.0 != parts.0
        || sum_parts_op != "+"
        || sum_copy.0 != sum_parts_lhs.0
        || parts_len.0 != sum_parts_rhs.0
        || joined_len_src.0 != joined.0
        || sum_joined_op != "+"
        || sum_parts_tmp.0 != sum_joined_lhs.0
        || joined_len.0 != sum_joined_rhs.0
        || part_arr.0 != parts.0
        || part_index.0 != match_const_dst(part_index_const)?
        || part_len_src.0 != part_value.0
        || sum_part_op != "+"
        || sum_joined_tmp.0 != sum_part_lhs.0
        || part_len.0 != sum_part_rhs.0
        || mul_op != "*"
        || mask_op != "&"
        || !add_uses(
            *mul_lhs,
            *mul_rhs,
            select.pick,
            match_const_dst(mult_const)?,
        )
        || mask_lhs.0 != mul_tmp.0
        || mask_rhs.0 != match_const_dst(mask_const)?
        || char_builtin != "string.charCodeAt"
        || char_recv.0 != joined.0
        || char_args.len() != 1
        || char_args[0].0 != char_idx.0
        || sum_char_op != "+"
        || sum_part_tmp.0 != sum_char_lhs.0
        || char_res.0 != sum_char_rhs.0
        || sum_char_tmp.0 != sum_char_src.0
    {
        return None;
    }
    let part_index = match_const_i64(part_index_const, ctx)?;
    let mult = match_const_i64(mult_const, ctx)?;
    let mask = match_const_i64(mask_const, ctx)?;
    if part_index < 0 || mult < 0 || mask < 0 {
        return None;
    }
    for value in select.values {
        if body.iter().any(|inst| inst_def_local(inst) == Some(value)) {
            return None;
        }
    }
    if body.iter().any(|inst| {
        let d = inst_def_local(inst);
        d == Some(split_args[0].0) || d == Some(join_args[0].0)
    }) {
        return None;
    }

    let skip = select.len + 20;
    let mut skipped_defs = collect_defs(&body[..skip]);
    skipped_defs.remove(&last.0);
    skipped_defs.remove(&sum_copy.0);
    if locals_used_after(body, skip, &skipped_defs) {
        return None;
    }

    Some(DynamicSplitJoinEscapeSelectShape {
        select,
        skip,
        separator: split_args[0].0,
        joiner: join_args[0].0,
        last: last.0,
        acc: sum_copy.0,
        part_index,
        mult,
        mask,
    })
}

fn try_emit_fused_dynamic_split_join_escape_select_loop(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
    top: u32,
    end: u32,
) -> Option<()> {
    let shape = match_dynamic_split_join_escape_select_shape(body, ctx)?;
    emit_dynamic_split_join_escape_select_loop(s, cond, cond_body, body, ctx, top, end, &shape);
    Some(())
}

fn emit_dynamic_split_join_escape_select_loop(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
    top: u32,
    end: u32,
    shape: &DynamicSplitJoinEscapeSelectShape,
) {
    let src_arr = format!("_fdsje_src{}", top);
    let out_arr = format!("_fdsje_out{}", top);
    let metric_arr = format!("_fdsje_metric{}", top);
    let sel_var = format!("_fdsje_sel{}", top);
    emit_tsv_array4(s, &src_arr, ctx, &shape.select.values);
    emit_tsv_undefined_array4(s, &out_arr);
    let _ = writeln!(s, "  long long {}[4];", metric_arr);
    s.push_str("  for (int _fdsje_i = 0; _fdsje_i < 4; _fdsje_i++) {\n");
    let _ = writeln!(
        s,
        "    tsv _fdsje_parts = ts_str_split({}[_fdsje_i], {}, TS_UNDEFINED);",
        src_arr,
        ctx.val(shape.separator)
    );
    s.push_str("    ts_gc_root(&_fdsje_parts);\n");
    let _ = writeln!(
        s,
        "    {}[_fdsje_i] = ts_array_join(_fdsje_parts, {});",
        out_arr,
        ctx.val(shape.joiner)
    );
    let _ = writeln!(s, "    ts_gc_root(&{}[_fdsje_i]);", out_arr);
    let _ = writeln!(
        s,
        "    tsv _fdsje_part = ts_array_get(_fdsje_parts, (uint32_t){}LL);",
        shape.part_index
    );
    let _ = writeln!(
        s,
        "    {}[_fdsje_i] = (long long)ts_array_len_fast(_fdsje_parts) + (long long)ts_str_len_fast({}[_fdsje_i]) + (long long)ts_str_len_fast(_fdsje_part) + (long long)ts_str_charcodeat_i64_typed({}[_fdsje_i], (long long)((_fdsje_i * {}) & {}));",
        metric_arr, out_arr, out_arr, shape.mult, shape.mask
    );
    s.push_str("    ts_gc_unroot(1);\n");
    s.push_str("  }\n");
    ctx.loop_labels
        .borrow_mut()
        .push((top, end, ctx.eh_depth.get()));
    let _ = writeln!(s, "  L{}: ;", top);
    emit_checked_loop(s, cond, cond_body, ctx, |s| {
        emit_select4_clamped(s, &sel_var, &ctx.num(shape.select.pick));
        s.push_str(&ctx.set_val(shape.last, &format!("{}[{}]", out_arr, sel_var)));
        emit_metric_acc_add(s, shape.acc, &format!("{}[{}]", metric_arr, sel_var), ctx);
        for inst in &body[shape.skip..] {
            emit_inst(s, inst, ctx);
        }
        let _ = writeln!(s, "  goto L{};", top);
    });
    let _ = writeln!(s, "  L{}: ;", end);
    s.push_str("  ts_gc_unroot(4);\n");
    ctx.loop_labels.borrow_mut().pop();
}

fn match_polymorphic_pattern_search_shape(
    body: &[Inst],
    ctx: &Ctx,
) -> Option<PolymorphicPatternSearchShape> {
    let select = parse_source_select4(body, 0, ctx)?;
    if body.len().saturating_sub(select.len) < 8 {
        return None;
    }
    let seq = &body[select.len..select.len + 8];
    let (
        Inst::Copy {
            dst: acc_alias1,
            src: acc_src1,
        },
        Inst::CallBuiltin {
            dst: Some(index_res),
            builtin: index_builtin,
            recv: index_recv,
            args: index_args,
        },
        Inst::BinOp {
            dst: index_sum_tmp,
            op: index_sum_op,
            lhs: index_sum_lhs,
            rhs: index_sum_rhs,
        },
        Inst::Copy {
            dst: acc_after_index,
            src: index_sum_src,
        },
        Inst::Copy {
            dst: acc_alias2,
            src: acc_src2,
        },
        Inst::CallBuiltin {
            dst: Some(last_res),
            builtin: last_builtin,
            recv: last_recv,
            args: last_args,
        },
        Inst::BinOp {
            dst: last_sum_tmp,
            op: last_sum_op,
            lhs: last_sum_lhs,
            rhs: last_sum_rhs,
        },
        Inst::Copy {
            dst: acc_after_last,
            src: last_sum_src,
        },
    ) = (
        &seq[0], &seq[1], &seq[2], &seq[3], &seq[4], &seq[5], &seq[6], &seq[7],
    )
    else {
        return None;
    };
    if index_builtin != "string.indexOf"
        || last_builtin != "string.lastIndexOf"
        || index_sum_op != "+"
        || last_sum_op != "+"
        || index_recv.0 != last_recv.0
        || index_args.len() != 1
        || last_args.len() != 1
        || index_args[0].0 != select.dst
        || last_args[0].0 != select.dst
        || index_sum_tmp.0 != index_sum_src.0
        || last_sum_tmp.0 != last_sum_src.0
        || acc_after_index.0 != acc_src1.0
        || acc_after_last.0 != acc_after_index.0
        || acc_src2.0 != acc_after_index.0
    {
        return None;
    }
    if !((index_sum_lhs.0 == acc_alias1.0 && index_sum_rhs.0 == index_res.0)
        || (index_sum_rhs.0 == acc_alias1.0 && index_sum_lhs.0 == index_res.0))
        || !((last_sum_lhs.0 == acc_alias2.0 && last_sum_rhs.0 == last_res.0)
            || (last_sum_rhs.0 == acc_alias2.0 && last_sum_lhs.0 == last_res.0))
    {
        return None;
    }
    for value in select.values {
        if body.iter().any(|inst| inst_def_local(inst) == Some(value)) {
            return None;
        }
    }
    if body
        .iter()
        .any(|inst| inst_def_local(inst) == Some(index_recv.0))
    {
        return None;
    }

    let skip = select.len + 8;
    let skipped_defs = collect_defs(&body[..skip]);
    if locals_used_after(body, skip, &skipped_defs) {
        return None;
    }

    Some(PolymorphicPatternSearchShape {
        select,
        recv: index_recv.0,
        acc: acc_after_last.0,
        skip,
    })
}

fn try_emit_fused_polymorphic_pattern_search_loop(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
    top: u32,
    end: u32,
) -> Option<()> {
    let shape = match_polymorphic_pattern_search_shape(body, ctx)?;
    let pat_arr = format!("_fpps_pat{}", top);
    let metric_arr = format!("_fpps_metric{}", top);
    let sel_var = format!("_fpps_sel{}", top);
    emit_tsv_array4(s, &pat_arr, ctx, &shape.select.values);
    let _ = writeln!(s, "  long long {}[4];", metric_arr);
    s.push_str("  for (int _fpps_i = 0; _fpps_i < 4; _fpps_i++) {\n");
    let _ = writeln!(
        s,
        "    {}[_fpps_i] = (long long)ts_str_indexof_fast({}, {}[_fpps_i], 0, 0) + (long long)ts_str_lastindexof_fast({}, {}[_fpps_i], 0, 0);",
        metric_arr,
        ctx.val(shape.recv),
        pat_arr,
        ctx.val(shape.recv),
        pat_arr
    );
    s.push_str("  }\n");
    ctx.loop_labels
        .borrow_mut()
        .push((top, end, ctx.eh_depth.get()));
    let _ = writeln!(s, "  L{}: ;", top);
    emit_checked_loop(s, cond, cond_body, ctx, |s| {
        emit_select4_clamped(s, &sel_var, &ctx.num(shape.select.pick));
        emit_metric_acc_add(s, shape.acc, &format!("{}[{}]", metric_arr, sel_var), ctx);
        for inst in &body[shape.skip..] {
            emit_inst(s, inst, ctx);
        }
        let _ = writeln!(s, "  goto L{};", top);
    });
    let _ = writeln!(s, "  L{}: ;", end);
    ctx.loop_labels.borrow_mut().pop();
    Some(())
}

fn try_emit_fused_polymorphic_pattern_replace_loop(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
    top: u32,
) -> Option<()> {
    let select = parse_pair_select4(body, 0, ctx)?;
    let metric = match_dynamic_replace_metric_shape(body, select.len, ctx)?;
    if metric.pattern != select.dst1
        || metric.replacement != select.dst2
        || metric.index_needle != select.dst2
    {
        return None;
    }
    for value in select.values1.into_iter().chain(select.values2) {
        if body.iter().any(|inst| inst_def_local(inst) == Some(value)) {
            return None;
        }
    }
    if body
        .iter()
        .any(|inst| inst_def_local(inst) == Some(metric.recv))
    {
        return None;
    }

    let skip = select.len + metric.len;
    let skipped_defs = collect_defs(&body[..skip]);
    if locals_used_after(body, skip, &skipped_defs) {
        return None;
    }

    let pat_arr = format!("_fppr_pat{}", top);
    let rep_arr = format!("_fppr_rep{}", top);
    let metric_arr = format!("_fppr_metric{}", top);
    let ok_var = format!("_fppr_ok{}", top);
    let sel_var = format!("_fppr_sel{}", top);
    emit_tsv_array4(s, &pat_arr, ctx, &select.values1);
    emit_tsv_array4(s, &rep_arr, ctx, &select.values2);
    let _ = writeln!(s, "  long long {}[4];", metric_arr);
    let _ = writeln!(s, "  int {} = 1;", ok_var);
    s.push_str("  for (int _fppr_i = 0; _fppr_i < 4; _fppr_i++) {\n");
    let _ = writeln!(
        s,
        "    {}[_fppr_i] = ts_str_replace_literal_metric3({}, {}[_fppr_i], {}[_fppr_i], {}[_fppr_i], {}LL, 1);",
        metric_arr,
        ctx.val(metric.recv),
        pat_arr,
        rep_arr,
        rep_arr,
        metric.char_idx
    );
    let _ = writeln!(s, "    if ({}[_fppr_i] < 0) {} = 0;", metric_arr, ok_var);
    s.push_str("  }\n");
    let _ = writeln!(s, "  if ({}) {{", ok_var);
    emit_checked_loop(s, cond, cond_body, ctx, |s| {
        emit_select4_clamped(s, &sel_var, &ctx.num(select.pick));
        emit_metric_acc_add(s, metric.acc, &format!("{}[{}]", metric_arr, sel_var), ctx);
        for inst in &body[skip..] {
            emit_inst(s, inst, ctx);
        }
    });
    s.push_str("  } else {\n");
    emit_runtime_loop(s, cond, cond_body, body, ctx);
    s.push_str("  }\n");
    Some(())
}

fn try_emit_fused_polymorphic_pattern_split_join_loop(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
    top: u32,
) -> Option<()> {
    let select = parse_pair_select4(body, 0, ctx)?;
    let metric = match_dynamic_split_join_metric_shape(body, select.len, ctx)?;
    if metric.separator != select.dst1 || metric.joiner != select.dst2 {
        return None;
    }
    for value in select.values1.into_iter().chain(select.values2) {
        if body.iter().any(|inst| inst_def_local(inst) == Some(value)) {
            return None;
        }
    }
    if body
        .iter()
        .any(|inst| inst_def_local(inst) == Some(metric.recv))
    {
        return None;
    }

    let skip = select.len + metric.len;
    let skipped_defs = collect_defs(&body[..skip]);
    if locals_used_after(body, skip, &skipped_defs) {
        return None;
    }

    let sep_arr = format!("_fppsj_sep{}", top);
    let join_arr = format!("_fppsj_join{}", top);
    let metric_arr = format!("_fppsj_metric{}", top);
    let ok_var = format!("_fppsj_ok{}", top);
    let sel_var = format!("_fppsj_sel{}", top);
    emit_tsv_array4(s, &sep_arr, ctx, &select.values1);
    emit_tsv_array4(s, &join_arr, ctx, &select.values2);
    let _ = writeln!(s, "  long long {}[4];", metric_arr);
    let _ = writeln!(s, "  int {} = 1;", ok_var);
    s.push_str("  for (int _fppsj_i = 0; _fppsj_i < 4; _fppsj_i++) {\n");
    let _ = writeln!(
        s,
        "    {}[_fppsj_i] = ts_str_split_join_metric3({}, {}[_fppsj_i], {}[_fppsj_i], {}LL);",
        metric_arr,
        ctx.val(metric.recv),
        sep_arr,
        join_arr,
        metric.part_index
    );
    let _ = writeln!(s, "    if ({}[_fppsj_i] < 0) {} = 0;", metric_arr, ok_var);
    s.push_str("  }\n");
    let _ = writeln!(s, "  if ({}) {{", ok_var);
    emit_checked_loop(s, cond, cond_body, ctx, |s| {
        emit_select4_clamped(s, &sel_var, &ctx.num(select.pick));
        emit_metric_acc_add(s, metric.acc, &format!("{}[{}]", metric_arr, sel_var), ctx);
        for inst in &body[skip..] {
            emit_inst(s, inst, ctx);
        }
    });
    s.push_str("  } else {\n");
    emit_runtime_loop(s, cond, cond_body, body, ctx);
    s.push_str("  }\n");
    Some(())
}

/// The typed-array receivers of a loop's element reads, writes and length
/// reads whose local the loop never assigns (slice P): their typed-array test
/// and length are read once before the loop, and the cell pointer, used every
/// iteration, keeps the view reachable. The element kind is the first use's;
/// a receiver used with two kinds keeps the per-use test.
fn loop_view_receivers(cond_body: &[Inst], body: &[Inst], ctx: &Ctx) -> Vec<(u32, u8)> {
    let mut flat: Vec<&Inst> = Vec::new();
    flatten_inst(cond_body, &mut flat);
    flatten_inst(body, &mut flat);
    let mut defs: BTreeSet<u32> = flat.iter().filter_map(|i| inst_def_local(i)).collect();
    for inst in &flat {
        if let Inst::TryCatch { catch_var: Some(v), .. } = inst {
            defs.insert(v.0);
        }
    }
    let mut out: Vec<(u32, u8)> = Vec::new();
    let mut conflicting: BTreeSet<u32> = BTreeSet::new();
    for inst in &flat {
        let (arr, elem) = match inst {
            Inst::LoadIndex { arr, elem, .. } | Inst::StoreIndex { arr, elem, .. } if *elem != 0 => {
                (arr.0, *elem - 1)
            }
            Inst::LoadField { obj, field, elem, .. } if *elem != 0 && is_length_field(field.0) => {
                (obj.0, *elem - 1)
            }
            _ => continue,
        };
        if defs.contains(&arr) || ctx.json_locals.contains(&arr) {
            continue;
        }
        match out.iter().find(|(a, _)| *a == arr) {
            Some((_, e)) if *e != elem => {
                conflicting.insert(arr);
            }
            Some(_) => {}
            None => out.push((arr, elem)),
        }
    }
    out.retain(|(a, _)| !conflicting.contains(a));
    out
}

/// The string receivers of a loop's `charCodeAt` calls whose local the loop
/// never assigns: their view (data, length, width) is read once before the
/// loop; a string never changes, and the local, used every iteration, keeps
/// the cell reachable. A receiver that is unboxed or a JSON local is left to
/// the per-use path.
fn loop_string_receivers(cond_body: &[Inst], body: &[Inst], ctx: &Ctx) -> Vec<u32> {
    let mut flat: Vec<&Inst> = Vec::new();
    flatten_inst(cond_body, &mut flat);
    flatten_inst(body, &mut flat);
    let mut defs: BTreeSet<u32> = flat.iter().filter_map(|i| inst_def_local(i)).collect();
    for inst in &flat {
        if let Inst::TryCatch { catch_var: Some(v), .. } = inst {
            defs.insert(v.0);
        }
    }
    // The view read at loop entry costs about as much as one read through the
    // per-use path, so a loop pays for it only when its iterations are cheap
    // (no calls: the unit reads are the loop) or when it reads the receiver
    // more than once per iteration (tsc-ts: a per-token loop of one read and a
    // call, entered millions of times, lost 0.1% with the view read unconditional).
    let tight = !flat.iter().any(|inst| {
        matches!(
            inst,
            Inst::Call { .. } | Inst::CallSpread { .. } | Inst::NewDynamic { .. } | Inst::Yield { .. } | Inst::Await { .. }
        )
    });
    let mut reads: BTreeMap<u32, u32> = BTreeMap::new();
    let mut out: Vec<u32> = Vec::new();
    for inst in &flat {
        if let Inst::CallBuiltin { builtin, recv, .. } = inst {
            if builtin != "string.charCodeAt" {
                continue;
            }
            let r = recv.0;
            if defs.contains(&r) || ctx.json_locals.contains(&r) || ctx.unboxed.contains(&r) || ctx.int_local.contains(&r) {
                continue;
            }
            *reads.entry(r).or_insert(0) += 1;
            if !out.contains(&r) {
                out.push(r);
            }
        }
    }
    if !tight {
        out.retain(|r| reads.get(r).copied().unwrap_or(0) >= 2);
    }
    out
}

fn collect_defs(seq: &[Inst]) -> BTreeSet<u32> {
    seq.iter().filter_map(inst_def_local).collect()
}

struct DynamicReplaceMetricShape {
    len: usize,
    recv: u32,
    pattern: u32,
    replacement: u32,
    index_needle: u32,
    char_idx: i64,
    acc: u32,
}

struct DynamicSplitJoinMetricShape {
    len: usize,
    recv: u32,
    separator: u32,
    joiner: u32,
    part_index: i64,
    acc: u32,
}

struct CounterAddTail {
    counter: u32,
    inc: i64,
}

struct DynamicPatternSearchLoopShape {
    recv: u32,
    first_needle: u32,
    last_needle: u32,
    acc: u32,
    from: u32,
    inc: i64,
    wrap: i64,
    counter: CounterAddTail,
}

fn match_counter_add_tail(body: &[Inst], start: usize, ctx: &Ctx) -> Option<CounterAddTail> {
    if body.len().saturating_sub(start) < 3 {
        return None;
    }
    let (
        counter_inc_const,
        Inst::BinOp {
            dst: counter_tmp,
            op: counter_op,
            lhs: counter_lhs,
            rhs: counter_rhs,
        },
        Inst::Copy {
            dst: counter_copy,
            src: counter_src,
        },
    ) = (&body[start], &body[start + 1], &body[start + 2])
    else {
        return None;
    };
    let counter_inc = match_const_i64(counter_inc_const, ctx)?;
    if counter_inc < 0 {
        return None;
    }
    let counter = counter_copy.0;
    let counter_inc_local = match_const_dst(counter_inc_const)?;
    let counter_ok = if counter_lhs.0 == counter {
        counter_rhs.0 == counter_inc_local
    } else if counter_rhs.0 == counter {
        counter_lhs.0 == counter_inc_local
    } else {
        false
    };
    if counter_op != "+"
        || counter_tmp.0 != counter_src.0
        || !counter_ok
        || !ctx.int_local.contains(&counter)
    {
        return None;
    }
    Some(CounterAddTail {
        counter,
        inc: counter_inc,
    })
}

fn match_dynamic_replace_metric_shape(
    body: &[Inst],
    start: usize,
    ctx: &Ctx,
) -> Option<DynamicReplaceMetricShape> {
    if body.len().saturating_sub(start) < 10 {
        return None;
    }
    let seq = &body[start..start + 10];
    let (
        Inst::CallBuiltin {
            dst: Some(replaced_res),
            builtin: replace_builtin,
            recv: replace_recv,
            args: replace_args,
        },
        Inst::Copy {
            dst: replaced,
            src: replaced_src,
        },
        Inst::GenericLen {
            dst: replaced_len,
            src: replaced_len_src,
        },
        Inst::BinOp {
            dst: sum_len_tmp,
            op: sum_len_op,
            lhs: sum_len_lhs,
            rhs: sum_len_rhs,
        },
        Inst::Call {
            dst: Some(index_res),
            recv: Some(index_recv),
            args: index_args,
            ..
        },
        Inst::BinOp {
            dst: sum_index_tmp,
            op: sum_index_op,
            lhs: sum_index_lhs,
            rhs: sum_index_rhs,
        },
        char_idx_const,
        Inst::Call {
            dst: Some(char_res),
            recv: Some(char_recv),
            args: char_args,
            ..
        },
        Inst::BinOp {
            dst: sum_char_tmp,
            op: sum_char_op,
            lhs: sum_char_lhs,
            rhs: sum_char_rhs,
        },
        Inst::Copy {
            dst: sum_copy,
            src: sum_char_src,
        },
    ) = (
        &seq[0], &seq[1], &seq[2], &seq[3], &seq[4], &seq[5], &seq[6], &seq[7], &seq[8], &seq[9],
    )
    else {
        return None;
    };
    if replace_builtin != "string.replaceAll"
        || replace_args.len() != 2
        || replaced_res.0 != replaced_src.0
        || replaced_len_src.0 != replaced.0
        || sum_len_op != "+"
        || replaced_len.0 != sum_len_rhs.0
        || index_recv.0 != replaced.0
        || index_args.len() != 1
        || sum_index_op != "+"
        || sum_len_tmp.0 != sum_index_lhs.0
        || index_res.0 != sum_index_rhs.0
        || char_recv.0 != replaced.0
        || char_args.len() != 1
        || char_args[0].0 != match_const_dst(char_idx_const)?
        || sum_char_op != "+"
        || sum_index_tmp.0 != sum_char_lhs.0
        || char_res.0 != sum_char_rhs.0
        || sum_char_tmp.0 != sum_char_src.0
        || sum_copy.0 != sum_len_lhs.0
    {
        return None;
    }
    let char_idx = match_const_i64(char_idx_const, ctx)?;
    if char_idx < 0 {
        return None;
    }
    let defs = collect_defs(seq);
    if locals_used_after(body, start + 10, &defs) {
        return None;
    }
    Some(DynamicReplaceMetricShape {
        len: 10,
        recv: replace_recv.0,
        pattern: replace_args[0].0,
        replacement: replace_args[1].0,
        index_needle: index_args[0].0,
        char_idx,
        acc: sum_copy.0,
    })
}

fn match_dynamic_split_join_metric_shape(
    body: &[Inst],
    start: usize,
    ctx: &Ctx,
) -> Option<DynamicSplitJoinMetricShape> {
    if body.len().saturating_sub(start) < 13 {
        return None;
    }
    let seq = &body[start..start + 13];
    let (
        Inst::CallBuiltin {
            dst: Some(split_res),
            builtin: split_builtin,
            recv: split_recv,
            args: split_args,
        },
        Inst::Copy {
            dst: parts,
            src: split_src,
        },
        Inst::CallBuiltin {
            dst: Some(join_res),
            builtin: join_builtin,
            recv: join_recv,
            args: join_args,
        },
        Inst::Copy {
            dst: joined,
            src: join_src,
        },
        Inst::ArrayLen {
            dst: parts_len,
            arr: parts_len_arr,
        },
        Inst::BinOp {
            dst: sum_parts_tmp,
            op: sum_parts_op,
            lhs: sum_parts_lhs,
            rhs: sum_parts_rhs,
        },
        Inst::StringLen {
            dst: joined_len,
            src: joined_len_src,
        },
        Inst::BinOp {
            dst: sum_joined_tmp,
            op: sum_joined_op,
            lhs: sum_joined_lhs,
            rhs: sum_joined_rhs,
        },
        index_const,
        Inst::LoadIndex {
            dst: part_value,
            arr: load_arr,
            index: load_index,
            ..
        },
        Inst::StringLen {
            dst: part_len,
            src: part_len_src,
        },
        Inst::BinOp {
            dst: sum_part_tmp,
            op: sum_part_op,
            lhs: sum_part_lhs,
            rhs: sum_part_rhs,
        },
        Inst::Copy {
            dst: sum_copy,
            src: sum_part_src,
        },
    ) = (
        &seq[0], &seq[1], &seq[2], &seq[3], &seq[4], &seq[5], &seq[6], &seq[7], &seq[8], &seq[9],
        &seq[10], &seq[11], &seq[12],
    )
    else {
        return None;
    };
    if split_builtin != "string.split"
        || join_builtin != "array.join"
        || split_args.len() != 1
        || split_res.0 != split_src.0
        || join_recv.0 != parts.0
        || join_args.len() != 1
        || join_res.0 != join_src.0
        || parts_len_arr.0 != parts.0
        || parts_len.0 != sum_parts_rhs.0
        || joined_len_src.0 != joined.0
        || joined_len.0 != sum_joined_rhs.0
        || sum_parts_tmp.0 != sum_joined_lhs.0
        || load_arr.0 != parts.0
        || load_index.0 != match_const_dst(index_const)?
        || part_value.0 != part_len_src.0
        || part_len.0 != sum_part_rhs.0
        || sum_joined_tmp.0 != sum_part_lhs.0
        || sum_part_tmp.0 != sum_part_src.0
        || sum_copy.0 != sum_parts_lhs.0
        || sum_parts_op != "+"
        || sum_joined_op != "+"
        || sum_part_op != "+"
    {
        return None;
    }
    let part_index = match_const_i64(index_const, ctx)?;
    if part_index < 0 {
        return None;
    }
    let defs = collect_defs(seq);
    if locals_used_after(body, start + 13, &defs) {
        return None;
    }
    Some(DynamicSplitJoinMetricShape {
        len: 13,
        recv: split_recv.0,
        separator: split_args[0].0,
        joiner: join_args[0].0,
        part_index,
        acc: sum_copy.0,
    })
}

fn try_emit_string_metric_loop_body(
    s: &mut String,
    body: &[Inst],
    ctx: &Ctx,
    top: u32,
    plan: Option<&LoopMetricPlan>,
) -> Option<()> {
    let mut tmp = String::new();
    let mut used = false;
    let mut i = 0;
    while i < body.len() {
        if let Some(op) = plan.and_then(|p| p.body_ranges.get(&i)) {
            if let Some(n) = try_emit_planned_string_metric(&mut tmp, body, op, ctx, top) {
                used = true;
                i += n;
                continue;
            }
        }
        emit_inst_at(&mut tmp, &body[i], ctx, PathEdge::LoopBody, i);
        i += 1;
    }
    if used {
        s.push_str(&tmp);
        Some(())
    } else {
        None
    }
}

fn add_uses(a: LocalId, b: LocalId, x: u32, y: u32) -> bool {
    (a.0 == x && b.0 == y) || (a.0 == y && b.0 == x)
}

fn gcd_i64(mut a: i64, mut b: i64) -> i64 {
    while b != 0 {
        let r = a % b;
        a = b;
        b = r;
    }
    a.abs()
}

fn try_emit_fused_masked_string_metric_loop(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
    top: u32,
) -> Option<()> {
    if body.len() != 32 || cond_body.len() != 1 {
        return None;
    }

    let Inst::BinOp {
        dst: cond_dst,
        op: cond_op,
        lhs: cond_lhs,
        rhs: cond_rhs,
    } = &cond_body[0]
    else {
        return None;
    };
    if cond_dst.0 != cond.0 || cond_op != "<" {
        return None;
    }

    let (
        char_mask_const,
        Inst::BinOp {
            dst: char_mask_tmp,
            op: char_mask_op,
            lhs: char_mask_lhs,
            rhs: char_mask_rhs,
        },
        Inst::Copy {
            dst: char_idx,
            src: char_idx_src,
        },
        Inst::BinOp {
            dst: add_len1_tmp,
            op: add_len1_op,
            lhs: add_len1_lhs,
            rhs: add_len1_rhs,
        },
        Inst::CallBuiltin {
            dst: Some(char_res),
            builtin: char_builtin,
            recv: char_recv,
            args: char_args,
        },
        Inst::BinOp {
            dst: add_char_tmp,
            op: add_char_op,
            lhs: add_char_lhs,
            rhs: add_char_rhs,
        },
        Inst::Copy {
            dst: acc_after_char,
            src: acc_after_char_src,
        },
        Inst::BinOp {
            dst: add_len2_tmp,
            op: add_len2_op,
            lhs: add_len2_lhs,
            rhs: add_len2_rhs,
        },
        needle1_const,
        index1_mask_const,
        Inst::BinOp {
            dst: index1_from,
            op: index1_mask_op,
            lhs: index1_mask_lhs,
            rhs: index1_mask_rhs,
        },
        Inst::CallBuiltin {
            dst: Some(index1_res),
            builtin: index1_builtin,
            recv: index1_recv,
            args: index1_args,
        },
        Inst::BinOp {
            dst: add_index1_tmp,
            op: add_index1_op,
            lhs: add_index1_lhs,
            rhs: add_index1_rhs,
        },
        Inst::BinOp {
            dst: add_index1_last_tmp,
            op: add_index1_last_op,
            lhs: add_index1_last_lhs,
            rhs: add_index1_last_rhs,
        },
        Inst::Copy {
            dst: acc_after_index1,
            src: acc_after_index1_src,
        },
        Inst::Copy {
            dst: acc_alias2,
            src: acc_alias2_src,
        },
        index2_mask_const,
        Inst::BinOp {
            dst: index2_from,
            op: index2_mask_op,
            lhs: index2_mask_lhs,
            rhs: index2_mask_rhs,
        },
        Inst::CallBuiltin {
            dst: Some(index2_res),
            builtin: index2_builtin,
            recv: index2_recv,
            args: index2_args,
        },
        Inst::BinOp {
            dst: add_index2_tmp,
            op: add_index2_op,
            lhs: add_index2_lhs,
            rhs: add_index2_rhs,
        },
        Inst::BinOp {
            dst: add_index2_last_tmp,
            op: add_index2_last_op,
            lhs: add_index2_last_lhs,
            rhs: add_index2_last_rhs,
        },
        Inst::Copy {
            dst: acc_after_index2,
            src: acc_after_index2_src,
        },
        Inst::BinOp {
            dst: add_tail_tmp,
            op: add_tail_op,
            lhs: add_tail_lhs,
            rhs: add_tail_rhs,
        },
        Inst::Copy {
            dst: acc_after_tail,
            src: acc_after_tail_src,
        },
        idx_inc_const,
        Inst::BinOp {
            dst: idx_add_tmp,
            op: idx_add_op,
            lhs: idx_add_lhs,
            rhs: idx_add_rhs,
        },
        wrap_mask_const,
        Inst::BinOp {
            dst: idx_wrap_tmp,
            op: idx_wrap_op,
            lhs: idx_wrap_lhs,
            rhs: idx_wrap_rhs,
        },
        Inst::Copy {
            dst: idx_copy,
            src: idx_copy_src,
        },
        counter_inc_const,
        Inst::BinOp {
            dst: counter_tmp,
            op: counter_op,
            lhs: counter_lhs,
            rhs: counter_rhs,
        },
        Inst::Copy {
            dst: counter_copy,
            src: counter_src,
        },
    ) = (
        &body[0], &body[1], &body[2], &body[3], &body[4], &body[5], &body[6], &body[7], &body[8],
        &body[9], &body[10], &body[11], &body[12], &body[13], &body[14], &body[15], &body[16],
        &body[17], &body[18], &body[19], &body[20], &body[21], &body[22], &body[23], &body[24],
        &body[25], &body[26], &body[27], &body[28], &body[29], &body[30], &body[31],
    )
    else {
        return None;
    };

    if char_mask_op != "&"
        || index1_mask_op != "&"
        || index2_mask_op != "&"
        || idx_add_op != "+"
        || idx_wrap_op != "&"
        || counter_op != "+"
        || add_len1_op != "+"
        || add_char_op != "+"
        || add_len2_op != "+"
        || add_index1_op != "+"
        || add_index1_last_op != "+"
        || add_index2_op != "+"
        || add_index2_last_op != "+"
        || add_tail_op != "+"
        || char_builtin != "string.charCodeAt"
        || index1_builtin != "string.indexOf"
        || index2_builtin != "string.indexOf"
        || char_idx_src.0 != char_mask_tmp.0
        || char_args.len() != 1
        || char_args[0].0 != char_idx.0
        || index1_args.len() != 2
        || index1_args[0].0 != match_const_dst(needle1_const)?
        || index1_args[1].0 != index1_from.0
        || index2_args.len() != 2
        || index2_args[1].0 != index2_from.0
        || acc_after_char_src.0 != add_char_tmp.0
        || acc_after_index1_src.0 != add_index1_last_tmp.0
        || acc_alias2_src.0 != acc_after_index1.0
        || acc_after_index2_src.0 != add_index2_last_tmp.0
        || acc_after_tail_src.0 != add_tail_tmp.0
        || idx_copy_src.0 != idx_wrap_tmp.0
        || counter_src.0 != counter_tmp.0
    {
        return None;
    }

    let acc = acc_after_tail.0;
    if acc_after_char.0 != acc
        || acc_after_index1.0 != acc
        || acc_after_index2.0 != acc
        || acc_alias2_src.0 != acc
    {
        return None;
    }
    let idx = char_mask_lhs.0;
    let len1 = if add_len1_lhs.0 == acc_after_tail.0 {
        add_len1_rhs.0
    } else if add_len1_rhs.0 == acc_after_tail.0 {
        add_len1_lhs.0
    } else {
        return None;
    };
    let len2 = if add_len2_lhs.0 == acc_after_char.0 {
        add_len2_rhs.0
    } else if add_len2_rhs.0 == acc_after_char.0 {
        add_len2_lhs.0
    } else {
        return None;
    };
    let last1 = if add_index1_last_lhs.0 == add_index1_tmp.0 {
        add_index1_last_rhs.0
    } else if add_index1_last_rhs.0 == add_index1_tmp.0 {
        add_index1_last_lhs.0
    } else {
        return None;
    };
    let last2 = if add_index2_last_lhs.0 == add_index2_tmp.0 {
        add_index2_last_rhs.0
    } else if add_index2_last_rhs.0 == add_index2_tmp.0 {
        add_index2_last_lhs.0
    } else {
        return None;
    };
    let tail_metric = if add_tail_lhs.0 == acc_after_index2.0 {
        add_tail_rhs.0
    } else if add_tail_rhs.0 == acc_after_index2.0 {
        add_tail_lhs.0
    } else {
        return None;
    };

    if char_mask_rhs.0 != match_const_dst(char_mask_const)?
        || index1_mask_lhs.0 != idx
        || index1_mask_rhs.0 != match_const_dst(index1_mask_const)?
        || index2_mask_lhs.0 != idx
        || index2_mask_rhs.0 != match_const_dst(index2_mask_const)?
        || idx_wrap_lhs.0 != idx_add_tmp.0
        || idx_wrap_rhs.0 != match_const_dst(wrap_mask_const)?
        || idx_copy.0 != idx
        || !add_uses(
            *idx_add_lhs,
            *idx_add_rhs,
            idx,
            match_const_dst(idx_inc_const)?,
        )
        || cond_lhs.0 != counter_copy.0
        || !add_uses(
            *counter_lhs,
            *counter_rhs,
            counter_copy.0,
            match_const_dst(counter_inc_const)?,
        )
        || !add_uses(*add_char_lhs, *add_char_rhs, add_len1_tmp.0, char_res.0)
        || !add_uses(
            *add_index1_lhs,
            *add_index1_rhs,
            add_len2_tmp.0,
            index1_res.0,
        )
        || !add_uses(*add_index2_lhs, *add_index2_rhs, acc_alias2.0, index2_res.0)
    {
        return None;
    }

    let char_mask = match_const_i64(char_mask_const, ctx)?;
    let index1_mask = match_const_i64(index1_mask_const, ctx)?;
    let index2_mask = match_const_i64(index2_mask_const, ctx)?;
    let wrap_mask = match_const_i64(wrap_mask_const, ctx)?;
    let idx_inc = match_const_i64(idx_inc_const, ctx)?;
    let counter_inc = match_const_i64(counter_inc_const, ctx)?;
    if wrap_mask <= 0
        || wrap_mask > 4095
        || (wrap_mask & (wrap_mask + 1)) != 0
        || char_mask < 0
        || index1_mask < 0
        || index2_mask < 0
        || char_mask > wrap_mask
        || index1_mask > wrap_mask
        || index2_mask > wrap_mask
        || idx_inc < 0
        || counter_inc <= 0
        || !ctx.unboxed.contains(&acc)
        || !ctx.int_local.contains(&idx)
        || !ctx.int_local.contains(&counter_copy.0)
        || !ctx.int_local.contains(&cond_rhs.0)
    {
        return None;
    }

    if body.iter().any(|inst| {
        let d = inst_def_local(inst);
        d == Some(char_recv.0)
            || d == Some(index1_recv.0)
            || d == Some(index2_recv.0)
            || d == Some(index2_args[0].0)
    }) {
        return None;
    }

    let needle1 = static_string_expr_from_const(needle1_const, ctx)?;
    let table_len = wrap_mask + 1;
    let idx_step = idx_inc & wrap_mask;
    let period = table_len / gcd_i64(table_len, idx_step);
    let table = format!("_fmsm_metric{}", top);
    let key = format!("_fmsm_key{}", top);
    let walk = format!("_fmsm_walk{}", top);
    let iters = format!("_fmsm_iters{}", top);
    let full = format!("_fmsm_full{}", top);
    let rem = format!("_fmsm_rem{}", top);
    let cycle = format!("_fmsm_cycle{}", top);
    let _ = writeln!(
        s,
        "  if (ts_is_str({}) && ts_is_str({}) && ts_is_str({}) && ts_is_str({})) {{",
        ctx.val(char_recv.0),
        ctx.val(index1_recv.0),
        ctx.val(index2_recv.0),
        ctx.val(index2_args[0].0),
    );
    let _ = writeln!(s, "  double {}[{}];", table, table_len);
    let _ = writeln!(
        s,
        "  for (uint32_t _fmsm_i = 0; _fmsm_i < {}u; _fmsm_i++) {{",
        table_len
    );
    let _ = writeln!(
        s,
        "    {}[_fmsm_i] = (double){} + (double)ts_str_charcodeat_i64_typed({}, (long long)((int32_t)_fmsm_i & {})) + (double){} + ts_str_indexof_fast({}, {}, (double)((int32_t)_fmsm_i & {}), 1) + (double){} + ts_str_indexof_fast({}, {}, (double)((int32_t)_fmsm_i & {}), 1) + (double){} + (double){};",
        table,
        ctx.num(len1),
        ctx.val(char_recv.0),
        char_mask,
        ctx.num(len2),
        ctx.val(index1_recv.0),
        needle1,
        index1_mask,
        ctx.num(last1),
        ctx.val(index2_recv.0),
        ctx.val(index2_args[0].0),
        index2_mask,
        ctx.num(last2),
        ctx.num(tail_metric),
    );
    s.push_str("  }\n");
    let _ = writeln!(
        s,
        "  uint32_t {} = (uint32_t)((int32_t)ts_to_int32((double)d{}) & {});",
        key, idx, wrap_mask
    );
    let _ = writeln!(
        s,
        "  long long {} = 0; if (d{} < d{}) {} = 1 + ((d{} - d{} - 1) / {}LL);",
        iters, counter_copy.0, cond_rhs.0, iters, cond_rhs.0, counter_copy.0, counter_inc
    );
    let _ = writeln!(s, "  long long {} = {} / {}LL;", full, iters, period);
    let _ = writeln!(s, "  long long {} = {} % {}LL;", rem, iters, period);
    let _ = writeln!(s, "  double {} = 0;", cycle);
    let _ = writeln!(s, "  uint32_t {} = {};", walk, key);
    let _ = writeln!(
        s,
        "  for (uint32_t _fmsm_p = 0; _fmsm_p < {}u; _fmsm_p++) {{ {} += {}[{}]; {} = ({} + {}u) & {}u; }}",
        period, cycle, table, walk, walk, walk, idx_step, wrap_mask
    );
    emit_metric_acc_add(s, acc, &format!("({} * (double){})", cycle, full), ctx);
    let _ = writeln!(
        s,
        "  for (long long _fmsm_r = 0; _fmsm_r < {}; _fmsm_r++) {{",
        rem
    );
    emit_metric_acc_add(s, acc, &format!("{}[{}]", table, key), ctx);
    let _ = writeln!(
        s,
        "    {} = ({} + {}u) & {}u;",
        key, key, idx_step, wrap_mask
    );
    s.push_str("  }\n");
    let _ = writeln!(s, "  d{} = (long long){};", idx, key);
    let _ = writeln!(s, "  d{} += {} * {}LL;", counter_copy.0, iters, counter_inc);
    let _ = writeln!(s, "  d{} = 0;", cond.0);
    s.push_str("  } else {\n");
    emit_runtime_loop(s, cond, cond_body, body, ctx);
    s.push_str("  }\n");
    Some(())
}

fn match_dynamic_pattern_search_loop_shape(
    body: &[Inst],
    ctx: &Ctx,
) -> Option<DynamicPatternSearchLoopShape> {
    if body.len() != 18 {
        return None;
    }
    let (
        Inst::Copy {
            dst: acc_alias1,
            src: acc_src1,
        },
        Inst::CallBuiltin {
            dst: Some(index_res),
            builtin: index_builtin,
            recv: index_recv,
            args: index_args,
        },
        Inst::BinOp {
            dst: index_sum_tmp,
            op: index_sum_op,
            lhs: index_sum_lhs,
            rhs: index_sum_rhs,
        },
        Inst::Copy {
            dst: acc_after_index,
            src: index_sum_src,
        },
        Inst::Copy {
            dst: acc_alias2,
            src: acc_src2,
        },
        Inst::StringLen {
            dst: hay_len,
            src: len_src,
        },
        Inst::CallBuiltin {
            dst: Some(last_res),
            builtin: last_builtin,
            recv: last_recv,
            args: last_args,
        },
        Inst::BinOp {
            dst: last_sum_tmp,
            op: last_sum_op,
            lhs: last_sum_lhs,
            rhs: last_sum_rhs,
        },
        Inst::Copy {
            dst: acc_after_last,
            src: last_sum_src,
        },
        inc_const,
        Inst::BinOp {
            dst: from_add_tmp,
            op: from_add_op,
            lhs: from_add_lhs,
            rhs: from_add_rhs,
        },
        Inst::Copy {
            dst: from_copy,
            src: from_add_src,
        },
        wrap_const,
        Inst::BinOp {
            dst: wrap_cmp_tmp,
            op: wrap_cmp_op,
            lhs: wrap_cmp_lhs,
            rhs: wrap_cmp_rhs,
        },
        Inst::If {
            cond: wrap_cond,
            then_body,
            else_body,
        },
    ) = (
        &body[0], &body[1], &body[2], &body[3], &body[4], &body[5], &body[6], &body[7], &body[8],
        &body[9], &body[10], &body[11], &body[12], &body[13], &body[14],
    )
    else {
        return None;
    };
    if index_builtin != "string.indexOf"
        || last_builtin != "string.lastIndexOf"
        || index_sum_op != "+"
        || last_sum_op != "+"
        || from_add_op != "+"
        || wrap_cmp_op != ">="
        || index_recv.0 != last_recv.0
        || len_src.0 != index_recv.0
        || index_args.len() != 2
        || last_args.len() != 2
        || last_args[1].0 != hay_len.0
        || index_sum_tmp.0 != index_sum_src.0
        || last_sum_tmp.0 != last_sum_src.0
        || acc_after_index.0 != acc_src1.0
        || acc_after_last.0 != acc_after_index.0
        || acc_src2.0 != acc_after_index.0
        || wrap_cmp_tmp.0 != wrap_cond.0
        || wrap_cmp_lhs.0 != from_copy.0
        || wrap_cmp_rhs.0 != match_const_dst(wrap_const)?
        || from_add_tmp.0 != from_add_src.0
        || !else_body.is_empty()
        || then_body.len() != 3
    {
        return None;
    }
    if !((index_sum_lhs.0 == acc_alias1.0 && index_sum_rhs.0 == index_res.0)
        || (index_sum_rhs.0 == acc_alias1.0 && index_sum_lhs.0 == index_res.0))
        || !((last_sum_lhs.0 == acc_alias2.0 && last_sum_rhs.0 == last_res.0)
            || (last_sum_rhs.0 == acc_alias2.0 && last_sum_lhs.0 == last_res.0))
    {
        return None;
    }
    let from = index_args[1].0;
    let inc = match_const_i64(inc_const, ctx)?;
    let wrap = match_const_i64(wrap_const, ctx)?;
    if inc < 0
        || wrap <= inc
        || !ctx.int_local.contains(&from)
        || !ctx.int_local.contains(&acc_after_last.0)
    {
        return None;
    }
    let counter_tail = match_counter_add_tail(body, 15, ctx)?;
    let from_add_ok = if from_add_lhs.0 == from {
        from_add_rhs.0 == match_const_dst(inc_const)?
    } else if from_add_rhs.0 == from {
        from_add_lhs.0 == match_const_dst(inc_const)?
    } else {
        false
    };
    if !from_add_ok || from_copy.0 != from {
        return None;
    }
    let (
        Inst::Const { dst: wrap2_dst, .. },
        Inst::BinOp {
            dst: sub_tmp,
            op: sub_op,
            lhs: sub_lhs,
            rhs: sub_rhs,
        },
        Inst::Copy {
            dst: sub_dst,
            src: sub_src,
        },
    ) = (&then_body[0], &then_body[1], &then_body[2])
    else {
        return None;
    };
    if match_const_i64(&then_body[0], ctx)? != wrap
        || sub_op != "-"
        || sub_lhs.0 != from
        || sub_rhs.0 != wrap2_dst.0
        || sub_tmp.0 != sub_src.0
        || sub_dst.0 != from
    {
        return None;
    }
    if body.iter().any(|inst| {
        inst_def_local(inst) == Some(index_recv.0)
            || inst_def_local(inst) == Some(index_args[0].0)
            || inst_def_local(inst) == Some(last_args[0].0)
    }) {
        return None;
    }
    Some(DynamicPatternSearchLoopShape {
        recv: index_recv.0,
        first_needle: index_args[0].0,
        last_needle: last_args[0].0,
        acc: acc_after_last.0,
        from,
        inc,
        wrap,
        counter: counter_tail,
    })
}

fn try_emit_fused_dynamic_pattern_search_loop(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
    top: u32,
) -> Option<()> {
    let shape = match_dynamic_pattern_search_loop_shape(body, ctx)?;
    let base = ctx.val(shape.recv);
    let first_var = format!("_fdps_first{}", top);
    let last_var = format!("_fdps_last{}", top);
    let _ = writeln!(
        s,
        "  long long {} = (long long)ts_str_indexof_fast({}, {}, 0, 1);",
        first_var,
        base,
        ctx.val(shape.first_needle)
    );
    let _ = writeln!(
        s,
        "  long long {} = (long long)ts_str_lastindexof_fast({}, {}, (double)ts_str_len_typed({}), 1);",
        last_var,
        base,
        ctx.val(shape.last_needle),
        base
    );
    let _ = writeln!(
        s,
        "  if ({} >= {}LL && d{} >= 0 && d{} < {}LL) {{",
        first_var, shape.wrap, shape.from, shape.from, shape.wrap
    );
    emit_checked_loop(s, cond, cond_body, ctx, |s| {
        let metric = format!("({} + {})", first_var, last_var);
        emit_metric_acc_add(s, shape.acc, &metric, ctx);
        let _ = writeln!(s, "  d{} += {}LL;", shape.from, shape.inc);
        let _ = writeln!(
            s,
            "  if (d{} >= {}LL) d{} -= {}LL;",
            shape.from, shape.wrap, shape.from, shape.wrap
        );
        let _ = writeln!(
            s,
            "  d{} += {}LL;",
            shape.counter.counter, shape.counter.inc
        );
    });
    s.push_str("  } else {\n");
    emit_runtime_loop(s, cond, cond_body, body, ctx);
    s.push_str("  }\n");
    Some(())
}

fn try_emit_fused_dynamic_replace_metrics_loop(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
    top: u32,
) -> Option<()> {
    if body.len() != 13 {
        return None;
    }
    let metric = match_dynamic_replace_metric_shape(body, 0, ctx)?;
    if metric.len != 10 {
        return None;
    }
    let counter = match_counter_add_tail(body, metric.len, ctx)?;
    if body.iter().any(|inst| {
        inst_def_local(inst) == Some(metric.recv)
            || inst_def_local(inst) == Some(metric.pattern)
            || inst_def_local(inst) == Some(metric.replacement)
            || inst_def_local(inst) == Some(metric.index_needle)
    }) {
        return None;
    }
    let inc_var = format!("_fdrm_inc{}", top);
    let _ = writeln!(
        s,
        "  long long {} = ts_str_replace_literal_metric3({}, {}, {}, {}, {}LL, 1);",
        inc_var,
        ctx.val(metric.recv),
        ctx.val(metric.pattern),
        ctx.val(metric.replacement),
        ctx.val(metric.index_needle),
        metric.char_idx
    );
    let _ = writeln!(s, "  if ({} >= 0) {{", inc_var);
    emit_checked_loop(s, cond, cond_body, ctx, |s| {
        emit_metric_acc_add(s, metric.acc, &inc_var, ctx);
        let _ = writeln!(s, "  d{} += {}LL;", counter.counter, counter.inc);
    });
    s.push_str("  } else {\n");
    emit_runtime_loop(s, cond, cond_body, body, ctx);
    s.push_str("  }\n");
    Some(())
}

fn try_emit_fused_dynamic_split_join_loop(
    s: &mut String,
    cond: LocalId,
    cond_body: &[Inst],
    body: &[Inst],
    ctx: &Ctx,
    top: u32,
) -> Option<()> {
    if body.len() != 16 {
        return None;
    }
    let metric = match_dynamic_split_join_metric_shape(body, 0, ctx)?;
    if metric.len != 13 {
        return None;
    }
    let counter = match_counter_add_tail(body, metric.len, ctx)?;
    if body.iter().any(|inst| {
        inst_def_local(inst) == Some(metric.recv)
            || inst_def_local(inst) == Some(metric.separator)
            || inst_def_local(inst) == Some(metric.joiner)
    }) {
        return None;
    }
    let inc_var = format!("_fdsj_inc{}", top);
    let _ = writeln!(
        s,
        "  long long {} = ts_str_split_join_metric3({}, {}, {}, {}LL);",
        inc_var,
        ctx.val(metric.recv),
        ctx.val(metric.separator),
        ctx.val(metric.joiner),
        metric.part_index
    );
    let _ = writeln!(s, "  if ({} >= 0) {{", inc_var);
    emit_checked_loop(s, cond, cond_body, ctx, |s| {
        emit_metric_acc_add(s, metric.acc, &inc_var, ctx);
        let _ = writeln!(s, "  d{} += {}LL;", counter.counter, counter.inc);
    });
    s.push_str("  } else {\n");
    emit_runtime_loop(s, cond, cond_body, body, ctx);
    s.push_str("  }\n");
    Some(())
}

fn try_emit_fused_scalar_slice_loop_body(
    s: &mut String,
    body: &[Inst],
    ctx: &Ctx,
    view_var: Option<&str>,
    unchecked: bool,
) -> Option<()> {
    if body.len() != 30 {
        return None;
    }
    let (
        Inst::CallBuiltin {
            dst: Some(slice1),
            builtin: builtin1,
            recv: base1,
            ..
        },
        Inst::Copy {
            dst: alias1,
            src: slice1_copy,
        },
        Inst::CallBuiltin {
            dst: Some(slice2),
            builtin: builtin2,
            recv: base2,
            ..
        },
        Inst::Copy {
            dst: alias2,
            src: slice2_copy,
        },
        Inst::Copy { src: acc, .. },
        Inst::CallBuiltin {
            dst: Some(_char1),
            builtin: char_builtin1,
            recv: char_recv1,
            args: char_args1,
        },
        Inst::CallBuiltin {
            dst: Some(_char2),
            builtin: char_builtin2,
            recv: char_recv2,
            args: char_args2,
        },
        Inst::StringLen { src: len_recv1, .. },
        Inst::StringLen { src: len_recv2, .. },
        Inst::Copy { dst: acc_dst, .. },
    ) = (
        &body[7], &body[8], &body[13], &body[14], &body[15], &body[17], &body[20], &body[22],
        &body[24], &body[26],
    )
    else {
        return None;
    };
    if builtin1 != "string.slice"
        || builtin2 != "string.substring"
        || char_builtin1 != "string.charCodeAt"
        || char_builtin2 != "string.charCodeAt"
        || slice1.0 != slice1_copy.0
        || slice2.0 != slice2_copy.0
        || char_recv1.0 != alias1.0
        || char_recv2.0 != alias2.0
        || len_recv1.0 != alias1.0
        || len_recv2.0 != alias2.0
        || acc_dst.0 != acc.0
        || base1.0 != base2.0
    {
        return None;
    }
    let Some(spec1) = ctx.scalar_slice(alias1.0) else {
        return None;
    };
    let Some(spec2) = ctx.scalar_slice(alias2.0) else {
        return None;
    };
    let (Some(len1), Some(len2)) = (spec1.exact_len, spec2.exact_len) else {
        return None;
    };
    let Some(idx1) = char_args1
        .first()
        .and_then(|a| ctx.int_const.get(&a.0).copied())
    else {
        return None;
    };
    let Some(idx2) = char_args2
        .first()
        .and_then(|a| ctx.int_const.get(&a.0).copied())
    else {
        return None;
    };
    if idx1 < 0 || idx1 >= len1 || idx2 < 0 || idx2 >= len2 {
        return None;
    }

    let affines = scalar_slice_affines(body);
    let Some(char1) = scalar_slice_char_affine(spec1, idx1, &affines) else {
        return None;
    };
    let Some(char2) = scalar_slice_char_affine(spec2, idx2, &affines) else {
        return None;
    };
    if char1.base != char2.base {
        return None;
    }
    let Some(idx_expr1) = scalar_affine_expr(char1, ctx) else {
        return None;
    };
    let Some(idx_expr2) = scalar_affine_expr(char2, ctx) else {
        return None;
    };
    let len_var = view_var
        .map(|v| format!("{}.len", v))
        .unwrap_or_else(|| "_fsv.len".to_string());
    let guard = combined_scalar_slice_range_guard(&[spec1, spec2], &affines, &len_var, ctx)
        .or_else(|| {
            let guard1 = scalar_slice_fast_guard(spec1, &affines, &len_var, ctx)?;
            let guard2 = scalar_slice_fast_guard(spec2, &affines, &len_var, ctx)?;
            Some(format!("({guard1} && {guard2})"))
        })?;
    let Some(add_len) = len1.checked_add(len2) else {
        return None;
    };

    if unchecked {
        if let Some(view_var) = view_var {
            if try_emit_compact_fused_scalar_slice_loop_body(
                s, body, ctx, view_var, acc.0, &idx_expr1, &idx_expr2, add_len,
            )
            .is_some()
            {
                return Some(());
            }
        }
    }

    for inst in &body[..5] {
        emit_inst(s, inst, ctx);
    }
    let local_view;
    let view_var = if let Some(view_var) = view_var {
        s.push_str("  {\n");
        view_var
    } else {
        local_view = "_fsv".to_string();
        let _ = writeln!(
            s,
            "  {{ ts_strview {} = ts_str_view_typed({});",
            local_view,
            ctx.val(base1.0)
        );
        &local_view
    };
    if unchecked {
        let _ = writeln!(
            s,
            "    d{} = d{} + (long long)ts_str_cu_at_view({}, {}) + (long long)ts_str_cu_at_view({}, {}) + {}LL;",
            acc.0, acc.0, view_var, idx_expr1, view_var, idx_expr2, add_len
        );
    } else {
        let _ = writeln!(s, "    if ({guard}) {{");
        let _ = writeln!(
            s,
            "      d{} = d{} + (long long)ts_str_cu_at_view({}, {}) + (long long)ts_str_cu_at_view({}, {}) + {}LL;",
            acc.0, acc.0, view_var, idx_expr1, view_var, idx_expr2, add_len
        );
        s.push_str("    } else {\n");
        for inst in &body[5..27] {
            emit_inst(s, inst, ctx);
        }
        s.push_str("    }\n");
    }
    s.push_str("  }\n");
    for inst in &body[27..] {
        emit_inst(s, inst, ctx);
    }
    Some(())
}

/// The generic property store: inline cache (lazy or eager frame) or the
/// plain runtime setter when caches are disabled.
fn emit_store_field_generic(s: &mut String, obj: u32, field: u32, src: u32, ctx: &Ctx) {
    if prop_pic_enabled() {
        let pic = ctx.fresh_label();
        let _ = writeln!(s, "  {{ static ts_prop_ic _ts_pic_{} = TS_PROP_IC_INIT;", pic);
        if ctx.lazy_homes {
            let (o, v) = (ctx.val(obj), ctx.val(src));
            let _ = writeln!(
                s,
                "  if (!ts_set_pic_try({o}, {field}, {v}, &_ts_pic_{pic})) {{ {sp}ts_set_linked({o}, {field}, {v}, &_ts_pic_{pic}, &F.h, {n});{rl} }}",
                sp = ctx.spill_now(), rl = ctx.reload_now(), n = ctx.frame_nslots
            );
        } else if ctx.lazy_frame {
            let _ = writeln!(
                s,
                "  ts_set_pic_inline_lazy({}, {}, {}, &_ts_pic_{}, &F.h, {});",
                ctx.val(obj),
                field,
                ctx.val(src),
                pic,
                ctx.frame_nslots
            );
        } else {
            let _ = writeln!(
                s,
                "  ts_set_pic_inline({}, {}, {}, &_ts_pic_{});",
                ctx.val(obj),
                field,
                ctx.val(src),
                pic
            );
        }
        let _ = writeln!(s, "  }}");
    } else {
        let _ = writeln!(s, "  ts_set({}, {}, {});", ctx.val(obj), field, ctx.val(src));
    }
}

fn emit_inst(s: &mut String, inst: &Inst, ctx: &Ctx) {
    ctx.cur_inst.set(inst as *const Inst as usize);
    match inst {
        Inst::AllocObject {
            dst,
            site,
            class_id,
            proto,
            type_id,
            ..
        } => {
            let st = ctx
                .strat
                .get(&site.0)
                .copied()
                .unwrap_or(AllocStrategy::Heap);
            match class_id {
                Some(c) => {
                    let cn = struct_name(c.0);
                    let dst_name = ctx.vname(dst.0);
                    let mut boxed = Vec::new();
                    if undef_fields_enabled() {
                        class_boxed_fields(c.0, ctx.classes, &mut boxed);
                    }
                    let proto_expr = if let Some(p) = proto {
                        let pv = ctx.val(p.0);
                        format!("(ts_is_obj({}) ? {} : CLASS_PROTO[{}])", pv, pv, c.0)
                    } else {
                        format!("CLASS_PROTO[{}]", c.0)
                    };
                    if st == AllocStrategy::Stack {
                        // A sized instance is never shaped: its header bytes
                        // hold its struct extent (ts_hdr_init_sized), not
                        // in-object slots (docs/cell_header_design.md).
                        let shape = "0";
                        // the struct is declared at function scope by
                        // emit_stack_cell_decls (a block-local would dangle
                        // when the value is read after the block)
                        if stack_check_enabled() {
                            // the quarantine copy of the same initialization
                            let o = format!("_sco{}", dst.0);
                            let _ = writeln!(s, "  {{ {0}* {1} = ({0}*)ts_sc_alloc(sizeof({0}), {2}u, __func__);", cn, o, site.0);
                            let _ = writeln!(s, "  {0}->header.h.kind=TS_KIND_OBJECT; {0}->header.h.gen=2; ts_hdr_init_sized(&{0}->header.h, sizeof({1})); {0}->header.proto={2}; {0}->header.shape={3};", o, cn, proto_expr, shape);
                            if class_index_enabled() {
                                let _ = writeln!(s, "  {}->header.cls={}u;", o, class_index_word(c.0));
                            }
                            if !boxed.is_empty() {
                                let inits: Vec<String> =
                                    boxed.iter().map(|f| format!("{}->f{} = TS_UNDEFINED;", o, f)).collect();
                                let _ = writeln!(s, "  {}", inits.join(" "));
                            }
                            let _ = writeln!(s, "  {} = ts_obj({}); }}", dst_name, o);
                            return;
                        }
                        let decl = if stack_closures_enabled() && ctx.stack_cells {
                            format!("  memset(&sobj{0}, 0, sizeof({1}));", dst.0, cn)
                        } else {
                            format!("  {1} sobj{0} = {{0}};", dst.0, cn)
                        };
                        let _ = writeln!(s, "{0} sobj{1}.header.h.kind=TS_KIND_OBJECT; sobj{1}.header.h.mark=0; sobj{1}.header.h.gen=2; ts_hdr_init_sized(&sobj{1}.header.h, sizeof({2})); sobj{1}.header.proto={3}; sobj{1}.header.shape={4};", decl, dst.0, cn, proto_expr, shape);
                        if class_index_enabled() {
                            let _ = writeln!(s, "  sobj{}.header.cls={}u;", dst.0, class_index_word(c.0));
                        }
                        if !boxed.is_empty() {
                            let inits: Vec<String> = boxed
                                .iter()
                                .map(|f| format!("sobj{}.f{} = TS_UNDEFINED;", dst.0, f))
                                .collect();
                            let _ = writeln!(s, "  {}", inits.join(" "));
                        }
                        let _ = writeln!(s, "  {} = ts_obj(&sobj{});", dst_name, dst.0);
                    } else {
                        if let Some(id) = alloc_site_id(site.0, st) {
                            // the site's survival decides young or old at run
                            // time (docs/site_pretenuring_design.md); the
                            // runtime stores the prototype with the barrier an
                            // old cell needs
                            let _ = writeln!(s, "  {} = ts_new_sized_site(sizeof({}), {}u, {});", dst_name, cn, id, proto_expr);
                            let _ = writeln!(s, "  {}* hobj{} = ({}*)ts_ptr({});", cn, dst.0, cn, dst_name);
                        } else {
                            let alloc = if st == AllocStrategy::PretenuredHeap {
                                "ts_new_sized_pretenured"
                            } else {
                                "ts_new_sized"
                            };
                            let _ = writeln!(s, "  {} = {}(sizeof({}));", dst_name, alloc, cn);
                            let _ = writeln!(s, "  {}* hobj{} = ({}*)ts_ptr({});", cn, dst.0, cn, dst_name);
                            let _ = writeln!(s, "  hobj{}->header.proto={};", dst.0, proto_expr);
                        }
                        if class_index_enabled() {
                            let _ = writeln!(s, "  hobj{}->header.cls={}u;", dst.0, class_index_word(c.0));
                        }
                        if !boxed.is_empty() {
                            let inits: Vec<String> = boxed
                                .iter()
                                .map(|f| format!("hobj{}->f{} = TS_UNDEFINED;", dst.0, f))
                                .collect();
                            let _ = writeln!(s, "  {}", inits.join(" "));
                        }
                        // a young heap instance comes from a run the allocator
                        // did not zero (docs/alloc_inline_design.md): its numeric
                        // fields start at zero by these stores
                        let mut numeric = Vec::new();
                        if undef_fields_enabled() {
                            class_numeric_fields(c.0, ctx.classes, &mut numeric);
                        }
                        if !numeric.is_empty() {
                            let inits: Vec<String> =
                                numeric.iter().map(|f| format!("hobj{}->f{} = 0;", dst.0, f)).collect();
                            let _ = writeln!(s, "  {}", inits.join(" "));
                        }
                        if st == AllocStrategy::PretenuredHeap {
                            let _ = writeln!(s, "  ts_write_barrier({}, {});", dst_name, proto_expr);
                        }
                    }
                    if site_stats_enabled() {
                        // diagnostic: class instances report under 4000000003
                        let _ = writeln!(s, "  ts_site_note({}, 4000000003u);", site.0);
                    }
                }
                None => {
                    if let Some(keys) = ctx.layouts.alloc.get(&(inst as *const Inst as usize)) {
                        let id = ctx.fresh_label();
                        s.push_str("  {\n");
                        emit_layout_decl(s, id, keys);
                        if let Some(sid) = alloc_site_id(site.0, st) {
                            let _ = writeln!(
                                s,
                                "  {} = ts_new_object_layout_site(&_ts_lit_{}, {}u); /* site {} {:?} layout */\n  }}",
                                ctx.vname(dst.0), id, sid, site.0, st
                            );
                        } else {
                            let alloc = if st == AllocStrategy::PretenuredHeap {
                                "ts_new_object_layout_pretenured"
                            } else {
                                "ts_new_object_layout"
                            };
                            let _ = writeln!(
                                s,
                                "  {} = {}(&_ts_lit_{}); /* site {} {:?} layout */\n  }}",
                                ctx.vname(dst.0), alloc, id, site.0, st
                            );
                        }
                        if site_stats_enabled() {
                            // diagnostic: object literals report under 4000000002
                            let _ = writeln!(s, "  ts_site_note({}, 4000000002u);", site.0);
                        }
                        return;
                    }
                    let alloc = if st == AllocStrategy::PretenuredHeap {
                        "ts_new_object_pretenured"
                    } else {
                        "ts_new_object"
                    };
                    // An object literal with a statically known field list gets
                    // exactly that many in-object slots; the default capacity
                    // serves the rest.
                    let slots = if inline_slots_enabled() {
                        type_field_count(type_id.0).filter(|n| *n > 0)
                    } else {
                        None
                    };
                    let sid = alloc_site_id(site.0, st);
                    match slots {
                        Some(n) if sid.is_some() => {
                            let _ = writeln!(
                                s,
                                "  {} = ts_new_object_n_site({}, {}u); /* site {} {:?} */",
                                ctx.vname(dst.0), n, sid.unwrap(), site.0, st
                            );
                            if site_stats_enabled() {
                                let _ = writeln!(s, "  ts_site_note({}, 4000000002u);", site.0);
                            }
                        }
                        None if sid.is_some() => {
                            let _ = writeln!(
                                s,
                                "  {} = ts_new_object_site({}u); /* site {} {:?} */",
                                ctx.vname(dst.0), sid.unwrap(), site.0, st
                            );
                            if site_stats_enabled() {
                                let _ = writeln!(s, "  ts_site_note({}, 4000000002u);", site.0);
                            }
                        }
                        Some(n) => {
                            let _ = writeln!(
                                s,
                                "  {} = {}_n({}); /* site {} {:?} */",
                                ctx.vname(dst.0), alloc, n, site.0, st
                            );
                            if site_stats_enabled() {
                                let _ = writeln!(s, "  ts_site_note({}, 4000000002u);", site.0);
                            }
                        }
                        None => {
                            let _ = writeln!(
                                s,
                                "  {} = {}(); /* site {} {:?} */",
                                ctx.vname(dst.0), alloc, site.0, st
                            );
                            if site_stats_enabled() {
                                let _ = writeln!(s, "  ts_site_note({}, 4000000002u);", site.0);
                            }
                        }
                    }
                }
            }
        }
        Inst::AllocArray { dst, site, .. } => {
            let st = ctx
                .strat
                .get(&site.0)
                .copied()
                .unwrap_or(AllocStrategy::Heap);
            if let Some(sid) = alloc_site_id(site.0, st) {
                let _ = writeln!(
                    s,
                    "  {} = ts_new_array_site(0, {}u); /* site {} {:?} */",
                    ctx.vname(dst.0),
                    sid,
                    site.0,
                    st
                );
            } else {
                let alloc = if st == AllocStrategy::PretenuredHeap {
                    "ts_new_array_pretenured"
                } else {
                    "ts_new_array"
                };
                let _ = writeln!(
                    s,
                    "  {} = {}(0); /* site {} {:?} */",
                    ctx.vname(dst.0),
                    alloc,
                    site.0,
                    st
                );
            }
            if site_stats_enabled() {
                // diagnostic: arrays report under the pseudo function id 4000000001
                let _ = writeln!(s, "  ts_site_note({}, 4000000001u);", site.0);
            }
        }
        Inst::AllocClosure {
            dst,
            func,
            captures,
            site,
        } => {
            let st = ctx
                .strat
                .get(&site.0)
                .copied()
                .unwrap_or(AllocStrategy::Heap);
            // The callee prologue decides the convention through its own
            // capture count; the creation site must agree with it exactly.
            let callee_ncap = callee_capture_count(func.0);
            if callee_ncap > 0 && callee_ncap != captures.len() {
                panic!(
                    "closure site for fn {} supplies {} cells but the function declares {}",
                    func.0, captures.len(), callee_ncap
                );
            }
            let env_abi = callee_ncap > 0;
            let make_fn = match (st == AllocStrategy::PretenuredHeap, env_abi) {
                (true, true) => "ts_make_closure_t_pretenured",
                (true, false) => "ts_make_fn_t_pretenured",
                (false, true) => "ts_make_closure_t",
                (false, false) => "ts_make_fn_t",
            };
            let make_proto = if st == AllocStrategy::PretenuredHeap {
                "ts_new_proto_pretenured"
            } else {
                "ts_new_proto"
            };
            let fname = ctx.fn_name_of(func.0);
            let tt = if *ctx.fn_takes_this.get(&func.0).unwrap_or(&false) {
                1
            } else {
                0
            };
            let dst_name = ctx.vname(dst.0);
            let set_meta = if lazy_fn_prototype_enabled() {
                format!(
                    "  ts_set_fn_meta({0}, FN_ARITY[{1}], FN_NAME[{1}]);\n  if (FN_HAS_PROTOTYPE[{1}]) ts_set_fn_prototype_lazy({0});\n",
                    dst_name, func.0)
            } else {
                format!(
                    "  ts_set_fn_meta({0}, FN_ARITY[{1}], FN_NAME[{1}]);\n  if (FN_HAS_PROTOTYPE[{1}]) ts_set_fn_prototype({0}, {2}());\n",
                    dst_name, func.0, make_proto)
            };
            if st == AllocStrategy::Stack && stack_closures_enabled() && ctx.stack_cells && stack_check_enabled() {
                let _ = writeln!(s, "  {{ ts_func* _scf = (ts_func*)ts_sc_alloc(sizeof(ts_func), {}u, __func__);", site.0);
                let env = if captures.is_empty() {
                    "NULL".to_string()
                } else {
                    let _ = writeln!(
                        s,
                        "  tsv* _sce = (tsv*)ts_sc_alloc_raw({} * sizeof(tsv), {}u, __func__);",
                        captures.len(), site.0
                    );
                    for (i, c) in captures.iter().enumerate() {
                        let _ = writeln!(s, "  _sce[{}] = {};", i, ctx.val(c.cell.0));
                    }
                    "_sce".to_string()
                };
                let _ = writeln!(s, "  ts_init_fn_stack(_scf, (ts_code){}, {}, {}, {});", fname, env, captures.len(), tt);
                let _ = writeln!(s, "  {} = ts_func_v(_scf); }} /* site {} Stack (checked) */", dst_name, site.0);
                s.push_str(&set_meta);
                return;
            }
            if st == AllocStrategy::Stack && stack_closures_enabled() && ctx.stack_cells {
                // A closure that never leaves this frame: the ts_func and its
                // environment live in function-scope stack cells declared by
                // emit_stack_cell_decls; the collector marks and scans non-heap
                // cells reached from the frame, so the environment slots are
                // forwarded like any other.
                for (i, c) in captures.iter().enumerate() {
                    let _ = writeln!(s, "  senv{}[{}] = {};", dst.0, i, ctx.val(c.cell.0));
                }
                let _ = writeln!(
                    s,
                    "  ts_init_fn_stack(&sfn{0}, (ts_code){1}, {2}, {3}, {4});",
                    dst.0,
                    fname,
                    if captures.is_empty() { "NULL".to_string() } else { format!("senv{}", dst.0) },
                    captures.len(),
                    tt
                );
                let _ = writeln!(s, "  {} = ts_func_v(&sfn{}); /* site {} Stack */", dst_name, dst.0, site.0);
                if site_stats_enabled() {
                    let _ = writeln!(s, "  ts_site_note({}, {});", site.0, func.0);
                }
                s.push_str(&set_meta);
                return;
            }
            if captures.is_empty() {
                let _ = writeln!(
                    s,
                    "  {} = {}({}, 0, 0, {}); /* site {} {:?} */",
                    dst_name,
                    make_fn,
                    fname,
                    tt,
                    site.0,
                    st
                );
                if site_stats_enabled() {
                    let _ = writeln!(s, "  ts_site_note({}, {});", site.0, func.0);
                }
                s.push_str(&set_meta);
            } else {
                // Build the captured-cell environment (capture order matches the
                // closure's leading parameters). ts_call prepends this env.
                let _ = writeln!(s, "  {{ tsv _env[{}];", captures.len());
                for (i, c) in captures.iter().enumerate() {
                    let _ = writeln!(s, "    _env[{}] = {};", i, ctx.val(c.cell.0));
                }
                let _ = writeln!(
                    s,
                    "    {} = {}({}, _env, {}, {}); /* site {} {:?} */",
                    dst_name,
                    make_fn,
                    fname,
                    captures.len(),
                    tt,
                    site.0,
                    st
                );
                s.push_str("  }\n");
                if site_stats_enabled() {
                    let _ = writeln!(s, "  ts_site_note({}, {});", site.0, func.0);
                }
                s.push_str(&set_meta);
            }
        }
        Inst::AllocClassValue {
            dst,
            class_id,
            ctor,
            captures,
            once,
        } => {
            // Box a class as a callable value carrying class_id + the ctor's
            // captured cells (same env construction as AllocClosure). `new K()`
            // later reads class_id via ts_construct.
            let fname = ctx.fn_name_of(ctor.0);
            let dst_name = ctx.vname(dst.0);
            let set_meta = format!(
                "  ts_set_fn_meta({}, FN_ARITY[{}], CLASS_NAME[{}]);\n",
                dst_name, ctor.0, class_id
            );
            if captures.is_empty() {
                let _ = writeln!(
                    s,
                    "  {} = {}({}u, {}, 0, 0);",
                    dst_name,
                    if *once { "ts_make_class_value_once" } else { "ts_make_class_value" },
                    class_id,
                    fname
                );
                s.push_str(&set_meta);
            } else {
                let _ = writeln!(s, "  {{ tsv _env[{}];", captures.len());
                for (i, c) in captures.iter().enumerate() {
                    let _ = writeln!(s, "    _env[{}] = {};", i, ctx.val(c.cell.0));
                }
                let ctor_ncap = callee_capture_count(ctor.0);
                if ctor_ncap > 0 && ctor_ncap != captures.len() {
                    panic!(
                        "class value site for ctor {} supplies {} cells but the constructor declares {}",
                        ctor.0, captures.len(), ctor_ncap
                    );
                }
                let _ = writeln!(
                    s,
                    "    {} = {}({}u, {}, _env, {});",
                    dst_name,
                    match (ctor_ncap > 0, *once) {
                        (true, false) => "ts_make_class_value_cells",
                        (true, true) => "ts_make_class_value_cells_once",
                        (false, false) => "ts_make_class_value",
                        (false, true) => "ts_make_class_value_once",
                    },
                    class_id,
                    fname,
                    captures.len()
                );
                s.push_str("  }\n");
                s.push_str(&set_meta);
            }
        }
        Inst::NewDynamic {
            dst, callee, args, ..
        } => {
            let _ = writeln!(s, "  {{ tsv _a[{}];", args.len().max(1));
            for (i, a) in args.iter().enumerate() {
                let _ = writeln!(s, "    _a[{}] = {};", i, ctx.val(a.0));
            }
            let _ = writeln!(
                s,
                "  {} = ts_construct({}, _a, {}); }}",
                ctx.vname(dst.0),
                ctx.val(callee.0),
                args.len()
            );
        }
        Inst::LoadClassProto { dst, class_id } => {
            let _ = writeln!(s, "  {} = CLASS_PROTO[{}];", ctx.vname(dst.0), class_id.0);
        }
        Inst::StoreProtoMethod {
            class_id,
            method,
            src,
        } => {
            // reassign a method on the class prototype, in the method-key space the
            // dynamic dispatch reads from; src must be a callable (ts_func) value.
            let _ = writeln!(
                s,
                "  ts_set(CLASS_PROTO[{}], {}, {});",
                class_id.0,
                method_key_str(method.0, ctx.wksym),
                ctx.val(src.0)
            );
        }
        Inst::StoreMethod { obj, method, src } => {
            let _ = writeln!(
                s,
                "  ts_set({}, {}, {});",
                ctx.val(obj.0),
                method_key_str(method.0, ctx.wksym),
                ctx.val(src.0)
            );
        }
        Inst::NewMap { dst } => {
            s.push_str(&ctx.set_val(dst.0, "ts_new_map()"));
        }
        Inst::NewSet { dst } => {
            s.push_str(&ctx.set_val(dst.0, "ts_new_set()"));
        }
        Inst::CallBuiltinStatic { dst, builtin, args } => {
            // Object.assign(target, ...sources): variadic, copies own enumerable
            // props of each source into target (mutates + returns target).
            if builtin == "object.assign" {
                let _ = writeln!(s, "  {{ tsv _oa[{}];", args.len().max(1));
                for (i, a) in args.iter().enumerate() {
                    let _ = writeln!(s, "    _oa[{}] = {};", i, ctx.val(a.0));
                }
                let tmp = format!("_oar{}", dst.map(|d| d.0).unwrap_or(0));
                let _ = writeln!(
                    s,
                    "    tsv {} = ts_object_assign(_oa, {}); ",
                    tmp,
                    args.len()
                );
                if let Some(d) = dst {
                    let _ = writeln!(s, "  {} }}", ctx.set_val(d.0, &tmp).trim_end());
                } else {
                    s.push_str("  }\n");
                }
                return;
            }
            if builtin == "string.concatMany" {
                let tmp = format!("_scm{}", dst.map(|d| d.0).unwrap_or(0));
                let _ = writeln!(s, "  {{ tsv _scm_args[{}];", args.len().max(1));
                for (i, a) in args.iter().enumerate() {
                    let _ = writeln!(s, "    _scm_args[{}] = {};", i, ctx.val(a.0));
                }
                let _ = writeln!(
                    s,
                    "    tsv {} = ts_str_concat_many(_scm_args, {});",
                    tmp,
                    args.len()
                );
                if let Some(d) = dst {
                    let _ = writeln!(s, "  {} }}", ctx.set_val(d.0, &tmp).trim_end());
                } else {
                    s.push_str("  }\n");
                }
                return;
            }
            // new Error(msg) / TypeError(msg) / ...: construct an Error-family
            // instance with the proper prototype (so `instanceof Error` works and
            // `name` is inherited). The kind index follows "error.new:".
            if let Some(kind) = builtin.strip_prefix("error.new:") {
                let idx: u32 = kind.parse().unwrap_or(0);
                let msg = if args.is_empty() {
                    "TS_UNDEFINED".to_string()
                } else {
                    ctx.val(args[0].0)
                };
                let expr = format!("ts_new_error({}, {})", idx, msg);
                if let Some(d) = dst {
                    s.push_str(&ctx.set_val(d.0, &expr));
                } else {
                    let _ = writeln!(s, "  {};", expr);
                }
                return;
            }
            // `new T(...)` and `T.of(...)` for a typed array: variadic; the
            // element type follows the prefix (docs/typed_arrays_design.md).
            if let Some((fname, elem)) = builtin
                .strip_prefix("typedarray.new:")
                .map(|e| ("ts_new_typed_array", e))
                .or_else(|| builtin.strip_prefix("typedarray.of:").map(|e| ("ts_typed_array_of", e)))
            {
                let elem: u32 = elem.parse().unwrap_or(0);
                let tmp = format!("_va{}", dst.map(|d| d.0).unwrap_or(0));
                let _ = writeln!(s, "  {{ tsv _va[{}];", args.len().max(1));
                for (i, a) in args.iter().enumerate() {
                    let _ = writeln!(s, "    _va[{}] = {};", i, ctx.val(a.0));
                }
                let _ = writeln!(s, "    tsv {} = {}({}, _va, {});", tmp, fname, elem, args.len());
                if let Some(d) = dst {
                    let _ = writeln!(s, "  {} }}", ctx.set_val(d.0, &tmp).trim_end());
                } else {
                    s.push_str("  }\n");
                }
                return;
            }
            // String.fromCharCode(...codes) and Array.of(...items): variadic;
            // marshal args into a tsv[] and call the runtime builder.
            if builtin == "string.fromCharCode"
                || builtin == "string.fromCodePoint"
                || builtin == "array.of"
            {
                let fname = match builtin.as_str() {
                    "string.fromCharCode" => "ts_string_from_char_code",
                    "string.fromCodePoint" => "ts_string_from_code_point",
                    _ => "ts_array_of",
                };
                let tmp = format!("_va{}", dst.map(|d| d.0).unwrap_or(0));
                let _ = writeln!(s, "  {{ tsv _va[{}];", args.len().max(1));
                for (i, a) in args.iter().enumerate() {
                    let _ = writeln!(s, "    _va[{}] = {};", i, ctx.val(a.0));
                }
                let _ = writeln!(s, "    tsv {} = {}(_va, {});", tmp, fname, args.len());
                if let Some(d) = dst {
                    let _ = writeln!(s, "  {} }}", ctx.set_val(d.0, &tmp).trim_end());
                } else {
                    s.push_str("  }\n");
                }
                return;
            }
            // Object.defineProperty/defineProperties runtime (dynamic) forms:
            // the descriptor (map) is a runtime value inspected by the runtime.
            if builtin == "object.definePropertyDyn" {
                let a = |i: usize| ctx.val(args.get(i).map(|x| x.0).unwrap_or(0));
                let _ = writeln!(s, "  ts_define_property({}, {}, {});", a(0), a(1), a(2));
                if let Some(d) = dst {
                    s.push_str(&ctx.set_val(d.0, "TS_UNDEFINED"));
                }
                return;
            }
            if builtin == "object.definePropertiesDyn" {
                let a = |i: usize| ctx.val(args.get(i).map(|x| x.0).unwrap_or(0));
                let _ = writeln!(s, "  ts_define_properties({}, {});", a(0), a(1));
                if let Some(d) = dst {
                    s.push_str(&ctx.set_val(d.0, "TS_UNDEFINED"));
                }
                return;
            }
            if builtin == "symbol.set" {
                // obj[sym] = v : symbol-keyed write (no stringify).
                let a = |i: usize| ctx.val(args.get(i).map(|x| x.0).unwrap_or(0));
                let _ = writeln!(s, "  ts_set_symkey({}, {}, {});", a(0), a(1), a(2));
                if let Some(d) = dst {
                    s.push_str(&ctx.set_val(d.0, "TS_UNDEFINED"));
                }
                return;
            }
            if let Some(rest) = builtin.strip_prefix("symbol.wksym:") {
                // Symbol.iterator etc. as a value -> well-known symbol singleton.
                let id: u32 = rest.parse().unwrap_or(0);
                if let Some(d) = dst {
                    s.push_str(&ctx.set_val(d.0, &format!("ts_wksym({}u)", id)));
                }
                return;
            }
            if let Some(rest) = builtin.strip_prefix("object.methodValue:") {
                // o.toString / o.valueOf / o.hasOwnProperty as a VALUE: an own data
                // property (any type) shadows; else the inherited Object.prototype
                // method (registered under a METHOD key). builtin carries the FIELD
                // and METHOD ids; args = [recv].
                let mut it = rest.split(':');
                let field_id: u32 = it.next().unwrap_or("0").parse().unwrap_or(0);
                let method_id: u32 = it.next().unwrap_or("0").parse().unwrap_or(0);
                let a = |i: usize| ctx.val(args.get(i).map(|x| x.0).unwrap_or(0));
                if let Some(d) = dst {
                    s.push_str(&ctx.set_val(
                        d.0,
                        &format!(
                            "ts_get_method_value({}, {}u, TS_KEY_METHOD({}u))",
                            a(0),
                            field_id,
                            method_id
                        ),
                    ));
                }
                return;
            }
            if let Some(rest) = builtin.strip_prefix("object.deleteDynamic:") {
                let pairs: Vec<_> = rest.split(';').filter_map(|pair| pair.split_once(',')).collect();
                let entries = pairs.iter().map(|(field, method)| format!("{}, TS_KEY_METHOD({})", field, method)).collect::<Vec<_>>().join(", ");
                let table = if pairs.is_empty() { "NULL".to_string() } else { format!("(const uint32_t[]){{{}}}", entries) };
                let expr = format!("ts_delete_dynamic_strict({}, {}, {}, {})", ctx.val(args[0].0), ctx.val(args[1].0), table, pairs.len());
                if let Some(dst) = dst { s.push_str(&ctx.set_val(dst.0, &expr)); }
                else { let _ = writeln!(s, "  {};", expr); }
                return;
            }
            if let Some(name) = builtin.strip_prefix("global.assignRef:") {
                let _ = writeln!(s, "  ts_global_assign_ref({:?}, {});", name, ctx.val(args[0].0));
                if let Some(d) = dst {
                    s.push_str(&ctx.set_val(d.0, "TS_UNDEFINED"));
                }
                return;
            }
            if let Some(name) = builtin.strip_prefix("global.varDecl:") {
                let _ = writeln!(s, "  ts_global_var_decl({:?});", name);
                if let Some(d) = dst {
                    s.push_str(&ctx.set_val(d.0, "TS_UNDEFINED"));
                }
                return;
            }
            if builtin == "json.dom.parse" {
                if let Some(d) = dst {
                    let src = args
                        .first()
                        .map(|a| ctx.val(a.0))
                        .unwrap_or_else(|| "TS_UNDEFINED".to_string());
                    if ctx.json_locals.contains(&d.0) {
                        let _ = writeln!(s, "  j{} = ts_json_dom_parse({});", d.0, src);
                        if ctx.json_roots.contains(&d.0) {
                            s.push_str("  ts_json_dom_scope_track(&_json_dom_scope, j");
                            let _ = write!(s, "{}", d.0);
                            s.push_str(");\n");
                        }
                    } else {
                        s.push_str(&ctx.set_val(d.0, &format!("ts_json_parse({})", src)));
                    }
                }
                return;
            }
            if let Some(field) = builtin.strip_prefix("json.dom.get:") {
                let field_id: u32 = field.parse().unwrap_or(0);
                if let Some(d) = dst {
                    let base = args
                        .first()
                        .map(|a| ctx.jval(a.0))
                        .unwrap_or_else(|| "NULL".to_string());
                    let _ = writeln!(s, "  j{} = ts_json_dom_get({}, {}u);", d.0, base, field_id);
                }
                return;
            }
            if builtin == "json.dom.index" {
                if let Some(d) = dst {
                    let base = args
                        .first()
                        .map(|a| ctx.jval(a.0))
                        .unwrap_or_else(|| "NULL".to_string());
                    let idx = args
                        .get(1)
                        .map(|a| ctx.numc(a.0))
                        .unwrap_or_else(|| "0".to_string());
                    let _ = writeln!(s, "  j{} = ts_json_dom_index({}, {});", d.0, base, idx);
                }
                return;
            }
            if builtin == "json.dom.length" {
                if let Some(d) = dst {
                    let base = args
                        .first()
                        .map(|a| ctx.jval(a.0))
                        .unwrap_or_else(|| "NULL".to_string());
                    s.push_str(&ctx.set_num(d.0, &format!("ts_json_dom_length({})", base)));
                }
                return;
            }
            if builtin == "json.dom.number" {
                if let Some(d) = dst {
                    let base = args
                        .first()
                        .map(|a| ctx.jval(a.0))
                        .unwrap_or_else(|| "NULL".to_string());
                    s.push_str(&ctx.set_num(d.0, &format!("ts_json_dom_number({})", base)));
                }
                return;
            }
            if builtin == "json.dom.toValue" {
                if let Some(d) = dst {
                    let base = args
                        .first()
                        .map(|a| ctx.jval(a.0))
                        .unwrap_or_else(|| "NULL".to_string());
                    s.push_str(&ctx.set_val(d.0, &format!("ts_json_dom_to_tsv({})", base)));
                }
                return;
            }
            if builtin == "json.dom.stringify" {
                if let Some(d) = dst {
                    let base = args
                        .first()
                        .map(|a| ctx.jval(a.0))
                        .unwrap_or_else(|| "NULL".to_string());
                    s.push_str(&ctx.set_val(d.0, &format!("ts_json_dom_stringify({})", base)));
                }
                return;
            }
            if builtin == "json.dom.stringify.len" {
                if let Some(d) = dst {
                    let base = args
                        .first()
                        .map(|a| ctx.jval(a.0))
                        .unwrap_or_else(|| "NULL".to_string());
                    s.push_str(&ctx.set_num(d.0, &format!("ts_json_dom_stringify_len({})", base)));
                }
                return;
            }
            if builtin == "json.stringify"
                && args
                    .first()
                    .map_or(false, |a| ctx.json_locals.contains(&a.0))
            {
                if let Some(d) = dst {
                    s.push_str(&ctx.set_val(
                        d.0,
                        &format!("ts_json_dom_stringify({})", ctx.jval(args[0].0)),
                    ));
                }
                return;
            }
            if builtin == "json.stringify.len"
                && args
                    .first()
                    .map_or(false, |a| ctx.json_locals.contains(&a.0))
            {
                if let Some(d) = dst {
                    s.push_str(&ctx.set_num(
                        d.0,
                        &format!("ts_json_dom_stringify_len({})", ctx.jval(args[0].0)),
                    ));
                }
                return;
            }
            // Object.defineProperty data form: define a data property with
            // explicit attributes. builtin is "object.defineData:<e>:<w>:<c>".
            // args = [obj, key, value].
            if builtin.starts_with("object.defineData") {
                let parts: Vec<&str> = builtin.split(':').collect();
                let e = parts.get(1).copied().unwrap_or("1");
                let w = parts.get(2).copied().unwrap_or("1");
                let c = parts.get(3).copied().unwrap_or("1");
                let a = |i: usize| ctx.val(args.get(i).map(|x| x.0).unwrap_or(0));
                match parts.get(4) {
                    // a user descriptor naming some fields: an existing
                    // property keeps the others
                    Some(present) if define_merge_enabled() => {
                        let _ = writeln!(
                            s,
                            "  ts_define_data_desc({}, {}, {}, {}, {}, {}, {});",
                            a(0),
                            a(1),
                            a(2),
                            e,
                            w,
                            c,
                            present
                        );
                    }
                    _ => {
                        let _ = writeln!(
                            s,
                            "  ts_define_data_dyn({}, {}, {}, {}, {}, {});",
                            a(0),
                            a(1),
                            a(2),
                            e,
                            w,
                            c
                        );
                    }
                }
                if let Some(d) = dst {
                    s.push_str(&ctx.set_val(d.0, "TS_UNDEFINED"));
                }
                return;
            }
            // Object.defineProperty accessor form: define get/set on obj.
            // builtin is "object.defineAccessor:<gThis>:<sThis>:<enum>:<conf>".
            if builtin.starts_with("object.defineAccessor") {
                let parts: Vec<&str> = builtin.split(':').collect();
                let g_this = parts.get(1).copied().unwrap_or("0");
                let s_this = parts.get(2).copied().unwrap_or("0");
                let e = parts.get(3).copied().unwrap_or("0");
                let c = parts.get(4).copied().unwrap_or("0");
                let a = |i: usize| ctx.val(args.get(i).map(|x| x.0).unwrap_or(0));
                match parts.get(5) {
                    Some(present) if define_merge_enabled() => {
                        let _ = writeln!(
                            s,
                            "  ts_define_accessor_desc({}, {}, {}, {}, {}, {}, {}, {}, {});",
                            a(0),
                            a(1),
                            a(2),
                            a(3),
                            g_this,
                            s_this,
                            e,
                            c,
                            present
                        );
                    }
                    _ => {
                        let _ = writeln!(
                            s,
                            "  ts_define_accessor_dyn({}, {}, {}, {}, {}, {}, {}, {});",
                            a(0),
                            a(1),
                            a(2),
                            a(3),
                            g_this,
                            s_this,
                            e,
                            c
                        );
                    }
                }
                if let Some(d) = dst {
                    s.push_str(&ctx.set_val(d.0, "TS_UNDEFINED"));
                }
                return;
            }
            // Symbol-keyed accessor define: like object.defineAccessor but the key
            // (arg 1) is a symbol value (well-known or user) installed without
            // stringify. builtin is "symbol.defineAccessor:<gThis>:<sThis>:<enum>:<conf>".
            if builtin.starts_with("symbol.defineAccessor") {
                let parts: Vec<&str> = builtin.split(':').collect();
                let g_this = parts.get(1).copied().unwrap_or("0");
                let s_this = parts.get(2).copied().unwrap_or("0");
                let e = parts.get(3).copied().unwrap_or("0");
                let c = parts.get(4).copied().unwrap_or("0");
                let a = |i: usize| ctx.val(args.get(i).map(|x| x.0).unwrap_or(0));
                let _ = writeln!(
                    s,
                    "  ts_define_accessor_symkey({}, {}, {}, {}, {}, {}, {}, {});",
                    a(0),
                    a(1),
                    a(2),
                    a(3),
                    g_this,
                    s_this,
                    e,
                    c
                );
                if let Some(d) = dst {
                    s.push_str(&ctx.set_val(d.0, "TS_UNDEFINED"));
                }
                return;
            }
            if let Some(offset) = builtin.strip_prefix("arguments.length:") {
                if let Some(d) = dst {
                    let offset: u32 = offset.parse().expect("arguments offset");
                    // The IR offset counts cells and receiver; cells are not in
                    // the argument array under the environment ABI.
                    let offset = (offset as usize).saturating_sub(ctx.cur_capture_count);
                    s.push_str(&ctx.set_num(d.0, &format!("(double)(nargs > {0} ? nargs - {0} : 0)", offset)));
                }
                return;
            }
            // console.dir(v): structural inspection of a single value.
            if builtin == "console.dir" {
                let _ = writeln!(
                    s,
                    "  ts_console_dir({});",
                    ctx.val(args.first().map(|a| a.0).unwrap_or(0))
                );
                if let Some(d) = dst {
                    s.push_str(&ctx.set_val(d.0, "TS_UNDEFINED"));
                }
                return;
            }
            // console.log / console.error: marshal all args into a tsv[] and call
            // the variadic runtime printer (space-separated, trailing newline).
            if builtin == "console.log" || builtin == "console.error" {
                let fname = if builtin == "console.log" {
                    "ts_console_log"
                } else {
                    "ts_console_err"
                };
                let _ = writeln!(s, "  {{ tsv _pa[{}];", args.len().max(1));
                for (i, a) in args.iter().enumerate() {
                    let _ = writeln!(s, "    _pa[{}] = {};", i, ctx.val(a.0));
                }
                let _ = writeln!(s, "    {}(_pa, {}); }}", fname, args.len());
                if let Some(d) = dst {
                    s.push_str(&ctx.set_val(d.0, "TS_UNDEFINED"));
                }
                return;
            }
            let n = |i: usize| -> String {
                args.get(i)
                    .map(|a| ctx.num(a.0))
                    .unwrap_or_else(|| "0".into())
            };
            let nc = |i: usize| -> String {
                args.get(i)
                    .map(|a| ctx.numc(a.0))
                    .unwrap_or_else(|| "0.0/0.0".into())
            };
            // ToInt32 of an operand, a cast for an int or int32-use local
            let bi = |i: usize| -> String {
                args.get(i)
                    .map(|a| ctx.bitwise_operand(a.0))
                    .unwrap_or_else(|| "0".into())
            };
            let v = |i: usize| -> String {
                args.get(i)
                    .map(|a| ctx.val(a.0))
                    .unwrap_or_else(|| "TS_UNDEFINED".into())
            };
            // Math converts its arguments with ToNumber (valueOf, numeric
            // strings), not a reinterpretation of the boxed bits.
            let n = |i: usize| -> String {
                if math_coerce_enabled() && builtin.starts_with("math.") {
                    nc(i)
                } else {
                    n(i)
                }
            };
            // Two arguments that may both run user code are converted in order.
            let n2 = |f: &str| -> String {
                let both_boxed = math_coerce_enabled()
                    && args.len() >= 2
                    && args[..2].iter().all(|a| !ctx.unboxed.contains(&a.0) && !ctx.json_locals.contains(&a.0));
                if both_boxed {
                    format!("({{ double _m0 = {}; double _m1 = {}; {}(_m0, _m1); }})", n(0), n(1), f)
                } else {
                    format!("{}({}, {})", f, n(0), n(1))
                }
            };
            let (expr, numeric): (String, bool) = match builtin.as_str() {
                // Math: single-arg libm functions emitted inline as doubles.
                "math.sqrt" => (format!("sqrt({})", n(0)), true),
                "math.abs" => (format!("fabs({})", n(0)), true),
                "math.floor" => (format!("floor({})", n(0)), true),
                "math.ceil" => (format!("ceil({})", n(0)), true),
                "math.round" => (format!("ts_math_round({})", n(0)), true),
                "math.trunc" => (format!("ts_math_trunc({})", n(0)), true),
                "math.sign" => (format!("ts_math_sign({})", n(0)), true),
                "math.sin" => (format!("sin({})", n(0)), true),
                "math.cos" => (format!("cos({})", n(0)), true),
                "math.tan" => (format!("tan({})", n(0)), true),
                "math.asin" => (format!("asin({})", n(0)), true),
                "math.acos" => (format!("acos({})", n(0)), true),
                "math.atan" => (format!("atan({})", n(0)), true),
                "math.sinh" => (format!("sinh({})", n(0)), true),
                "math.cosh" => (format!("cosh({})", n(0)), true),
                "math.tanh" => (format!("tanh({})", n(0)), true),
                "math.exp" => (format!("exp({})", n(0)), true),
                "math.log" => (format!("log({})", n(0)), true),
                "math.log2" => (format!("ts_math_log2({})", n(0)), true),
                "math.log10" => (format!("ts_math_log10({})", n(0)), true),
                "math.cbrt" => (format!("ts_math_cbrt({})", n(0)), true),
                "math.asinh" => (format!("asinh({})", n(0)), true),
                "math.acosh" => (format!("acosh({})", n(0)), true),
                "math.atanh" => (format!("atanh({})", n(0)), true),
                "math.expm1" => (format!("expm1({})", n(0)), true),
                "math.log1p" => (format!("log1p({})", n(0)), true),
                "math.fround" => (format!("((double)(float)({}))", n(0)), true),
                "math.f16round" => (format!("ts_math_f16round({})", nc(0)), true),
                "math.clz32" => (format!("ts_math_clz32({})", n(0)), true),
                // two-arg
                "math.pow" => (n2("pow"), true),
                "math.atan2" => (n2("atan2"), true),
                "math.hypot" => (n2("ts_math_hypot2"), true),
                // ToInt32 of each operand, the 32-bit product as an int32: in line
                // (the scanner's hashes call it once per character); TSAOT_IMUL_INLINE=0
                // keeps the runtime call (the parity oracle)
                "math.imul" if imul_inline_enabled() => (
                    format!(
                        "((double)(int32_t)((uint32_t){} * (uint32_t){}))",
                        bi(0),
                        bi(1)
                    ),
                    true,
                ),
                "math.imul" => (format!("ts_math_imul({}, {})", nc(0), nc(1)), true),
                "math.maxArr" => (format!("ts_math_max_arr({})", v(0)), true),
                "math.minArr" => (format!("ts_math_min_arr({})", v(0)), true),
                "math.hypotArr" => (format!("ts_math_hypot_arr({})", v(0)), true),
                "math.max" => (n2("ts_math_max2"), true),
                "math.min" => (n2("ts_math_min2"), true),
                "math.random" => ("ts_math_random()".to_string(), true),
                // Number static methods
                "number.isInteger" => (format!("ts_bool(ts_number_is_integer({}))", v(0)), false),
                "number.isFinite" => (format!("ts_bool(ts_number_is_finite({}))", v(0)), false),
                "number.isNaN" => (format!("ts_bool(ts_number_is_nan({}))", v(0)), false),
                "number.isSafeInteger" => (
                    format!("ts_bool(ts_number_is_safe_integer({}))", v(0)),
                    false,
                ),
                "number.parseFloat" => (format!("ts_parse_float({})", v(0)), true),
                "number.parseInt" => (
                    if parseint_coerce_enabled()
                        && args.len() > 1
                        && !ctx.unboxed.contains(&args[1].0)
                        && !ctx.json_locals.contains(&args[1].0)
                    {
                        // a boxed radix: ToString(string), then ToInt32(radix)
                        format!("ts_parse_int_v({}, {})", v(0), v(1))
                    } else {
                        format!(
                            "ts_parse_int({}, {})",
                            v(0),
                            if args.len() > 1 { n(1) } else { "0".into() }
                        )
                    },
                    true,
                ),
                "number.coerce" => (format!("ts_number_coerce({})", v(0)), true),
                "string.coerce" => (format!("ts_to_string_v({})", v(0)), false),
                "boolean.coerce" => (format!("ts_bool(ts_truthy_fast({}))", v(0)), false),
                "regexp.literalTest" => (
                    format!("ts_regexp_litprefix_test_fast({}, {}, 0)", v(0), v(1)),
                    false,
                ),
                "regexp.literalTestSticky" => (
                    format!("ts_regexp_litprefix_test_fast({}, {}, 1)", v(0), v(1)),
                    false,
                ),
                "regexp.literalSearch" => (
                    format!("ts_regexp_litprefix_search_fast({}, {}, 0)", v(0), v(1)),
                    true,
                ),
                "regexp.literalSearchSticky" => (
                    format!("ts_regexp_litprefix_search_fast({}, {}, 1)", v(0), v(1)),
                    true,
                ),
                "regexp.objectTest" => (
                    format!("ts_regexp_adapter_object_test_tsv({}, {})", v(0), v(1)),
                    false,
                ),
                "regexp.initObject" => (format!("ts_regexp_object_init({})", v(0)), false),
                "regexp.construct" => (format!("ts_regexp_adapter_construct_tsv({}, {}, ts_truthy({}))", v(0), v(1), v(2)), false),
                "uint16array.new" => (format!("ts_new_uint16_array({})", v(0)), false),
                "arraybuffer.isView" => (format!("ts_bool(ts_array_buffer_is_view({}))", v(0)), false),
                // docs/text_codecs_design.md
                "textencoder.new" => ("ts_text_encoder_new()".to_string(), false),
                "textdecoder.new" => (format!("ts_text_decoder_new({}, {})", v(0), v(1)), false),
                // Atomics on one thread (docs/typed_arrays_design.md, TA3)
                "atomics.load" => (format!("ts_atomics_load({}, {})", v(0), v(1)), false),
                "atomics.store" => (format!("ts_atomics_store({}, {}, {})", v(0), v(1), v(2)), false),
                "atomics.add" => (format!("ts_atomics_rmw(0, {}, {}, {})", v(0), v(1), v(2)), false),
                "atomics.sub" => (format!("ts_atomics_rmw(1, {}, {}, {})", v(0), v(1), v(2)), false),
                "atomics.and" => (format!("ts_atomics_rmw(2, {}, {}, {})", v(0), v(1), v(2)), false),
                "atomics.or" => (format!("ts_atomics_rmw(3, {}, {}, {})", v(0), v(1), v(2)), false),
                "atomics.xor" => (format!("ts_atomics_rmw(4, {}, {}, {})", v(0), v(1), v(2)), false),
                "atomics.exchange" => (format!("ts_atomics_rmw(5, {}, {}, {})", v(0), v(1), v(2)), false),
                "atomics.compareExchange" => (
                    format!("ts_atomics_compare_exchange({}, {}, {}, {})", v(0), v(1), v(2), v(3)),
                    false,
                ),
                "atomics.isLockFree" => (format!("ts_atomics_is_lock_free({})", v(0)), false),
                "atomics.wait" => (format!("ts_atomics_wait({}, {}, {}, {})", v(0), v(1), v(2), v(3)), false),
                "atomics.notify" => (format!("ts_atomics_notify({}, {}, {})", v(0), v(1), v(2)), false),
                b if b.starts_with("arraybuffer.new:") => (
                    format!("ts_new_array_buffer({}, {})", v(0), &b["arraybuffer.new:".len()..]),
                    false,
                ),
                b if b.starts_with("typedarray.from:") => (
                    format!(
                        "ts_typed_array_from({}, {}, {}, {})",
                        &b["typedarray.from:".len()..],
                        v(0),
                        v(1),
                        v(2)
                    ),
                    false,
                ),
                "regexp.validateObject" => (
                    format!("ts_regexp_adapter_validate_object_tsv({})", v(0)),
                    false,
                ),
                "regexp.objectSearch" => (
                    format!("ts_regexp_adapter_object_search_tsv({}, {})", v(0), v(1)),
                    true,
                ),
                "regexp.objectExec" => (
                    format!("ts_regexp_adapter_object_exec_tsv({}, {})", v(0), v(1)),
                    false,
                ),
                "regexp.objectMatch" => (
                    format!("ts_regexp_adapter_object_match_tsv({}, {})", v(0), v(1)),
                    false,
                ),
                "regexp.objectMatchAll" => (
                    format!("ts_regexp_adapter_object_match_all_tsv({}, {})", v(0), v(1)),
                    false,
                ),
                "regexp.objectReplace" => (
                    format!(
                        "ts_regexp_adapter_object_replace_tsv({}, {}, {}, (int){})",
                        v(0),
                        v(1),
                        v(2),
                        n(3)
                    ),
                    false,
                ),
                "regexp.objectSplit" => (
                    format!(
                        "ts_regexp_adapter_object_split_tsv({}, {}, {})",
                        v(0),
                        v(1),
                        v(2)
                    ),
                    false,
                ),
                "regexp.quickTest" => (
                    format!(
                        "ts_regexp_adapter_test_tsv({}, (uint32_t){}, {})",
                        v(0),
                        n(1),
                        v(2)
                    ),
                    false,
                ),
                "regexp.quickSearch" => (
                    format!(
                        "ts_regexp_adapter_search_tsv({}, {}, (uint32_t){})",
                        v(0),
                        v(1),
                        n(2)
                    ),
                    true,
                ),
                "regexp.quickExec" => (
                    format!(
                        "ts_regexp_adapter_exec_tsv({}, (uint32_t){}, {})",
                        v(0),
                        n(1),
                        v(2)
                    ),
                    false,
                ),
                "regexp.quickMatch" => (
                    format!(
                        "ts_regexp_adapter_match_tsv({}, {}, (uint32_t){})",
                        v(0),
                        v(1),
                        n(2)
                    ),
                    false,
                ),
                "regexp.quickMatchAll" => (
                    format!(
                        "ts_regexp_adapter_match_all_tsv({}, {}, (uint32_t){})",
                        v(0),
                        v(1),
                        n(2)
                    ),
                    false,
                ),
                "regexp.quickReplace" => (
                    format!(
                        "ts_regexp_adapter_replace_tsv({}, {}, (uint32_t){}, {}, (int){})",
                        v(0),
                        v(1),
                        n(2),
                        v(3),
                        n(4)
                    ),
                    false,
                ),
                "regexp.quickSplit" => (
                    format!(
                        "ts_regexp_adapter_split_tsv({}, {}, (uint32_t){}, {})",
                        v(0),
                        v(1),
                        n(2),
                        v(3)
                    ),
                    false,
                ),
                // global parse functions
                "global.parseFloat" => (format!("ts_parse_float({})", v(0)), true),
                "global.parseInt" => (
                    if parseint_coerce_enabled()
                        && args.len() > 1
                        && !ctx.unboxed.contains(&args[1].0)
                        && !ctx.json_locals.contains(&args[1].0)
                    {
                        // a boxed radix: ToString(string), then ToInt32(radix)
                        format!("ts_parse_int_v({}, {})", v(0), v(1))
                    } else {
                        format!(
                            "ts_parse_int({}, {})",
                            v(0),
                            if args.len() > 1 { n(1) } else { "0".into() }
                        )
                    },
                    true,
                ),
                // global isNaN/isFinite ToNumber-coerce their argument (unlike the
                // Number.* versions): isNaN("abc") -> isNaN(NaN) -> true.
                "global.isNaN" => (format!("ts_bool(isnan(ts_number_coerce({})))", v(0)), false),
                "global.isFinite" => (
                    format!("ts_bool(isfinite(ts_number_coerce({})))", v(0)),
                    false,
                ),
                "global.fetch" => (format!("ts_fetch({}, {})", v(0), v(1)), false),
                // Host I/O primitive (self-hosting): __read_stdin() — all of
                // stdin as one string.
                "global.readStdin" => ("ts_read_stdin()".to_string(), false),
                "abortcontroller.new" => ("ts_abort_controller_new()".to_string(), false),
                "abortsignal.timeout" => (format!("ts_abort_signal_timeout({})", v(0)), false),
                // Date static
                "date.now" => ("ts_to_num(ts_date_now_ms())".to_string(), true),
                "date.fromComponents" => (
                    format!(
                        "ts_date_from_components({}, {}, {}, {}, {}, {}, {})",
                        n(0),
                        n(1),
                        n(2),
                        n(3),
                        n(4),
                        n(5),
                        n(6)
                    ),
                    true,
                ),
                "date.component" => (format!("ts_date_component({}, (int){})", n(0), n(1)), true),
                "date.toISOString" => (format!("ts_date_to_iso({})", n(0)), false),
                "date.toLocaleTimeString" => (format!("ts_date_to_locale_time({}, {}, {})", n(0), v(1), v(2)), false),
                // Object static methods (use the field-name table)
                "object.keys" => (format!("ts_object_keys({})", v(0)), false),
                "object.forInKeys" => (format!("ts_object_for_in_keys({})", v(0)), false),
                // Object.prototype.toString.call(x): spec [[Class]] tag of any value.
                "object.protoToStringCall" => {
                    (format!("ts_objproto_tostring_call({})", v(0)), false)
                }
                "object.getOwnPropertyNames" => {
                    (format!("ts_object_get_own_property_names({})", v(0)), false)
                }
                "object.freeze" => (format!("ts_object_freeze({})", v(0)), false),
                "object.isFrozen" => (format!("ts_object_is_frozen({})", v(0)), false),
                "object.create" => (format!("ts_object_create({})", v(0)), false),
                "object.seal" => (format!("ts_object_seal({})", v(0)), false),
                "object.preventExtensions" => {
                    (format!("ts_object_prevent_extensions({})", v(0)), false)
                }
                "object.isSealed" => (format!("ts_object_is_sealed({})", v(0)), false),
                "object.isExtensible" => (format!("ts_object_is_extensible({})", v(0)), false),
                "object.values" => (format!("ts_object_values({})", v(0)), false),
                "object.entries" => (format!("ts_object_entries({})", v(0)), false),
                "object.getOwnPropertySymbols" => (
                    format!("ts_object_get_own_property_symbols({})", v(0)),
                    false,
                ),
                "object.fromEntries" => (format!("ts_object_from_entries({})", v(0)), false),
                "promise.resolve" => (format!("ts_promise_resolved({})", v(0)), false),
                "promise.reject" => (format!("ts_promise_rejected({})", v(0)), false),
                "promise.all" => (format!("ts_promise_all({})", v(0)), false),
                "promise.race" => (format!("ts_promise_race({})", v(0)), false),
                "promise.allSettled" => (format!("ts_promise_allsettled({})", v(0)), false),
                "promise.any" => (format!("ts_promise_any({})", v(0)), false),
                "promise.new" => (format!("ts_promise_new_executor({})", v(0)), false),
                "object.hasOwn" => (
                    format!("ts_bool(ts_has_own_dyn({}, {}))", v(0), v(1)),
                    false,
                ),
                "object.is" => (format!("ts_bool(ts_object_is({}, {}))", v(0), v(1)), false),
                "headers.new" => (
                    format!(
                        "ts_headers_new({})",
                        if args.is_empty() {
                            "TS_UNDEFINED".to_string()
                        } else {
                            v(0)
                        }
                    ),
                    false,
                ),
                "weakmap.new" => ("ts_new_weakmap()".to_string(), false),
                "weakset.new" => ("ts_new_weakset()".to_string(), false),
                "map.seed" => (format!("ts_map_seed({}, {})", v(0), v(1)), false),
                "set.seed" => (format!("ts_set_seed({}, {})", v(0), v(1)), false),
                "weakmap.seed" => (format!("ts_weakmap_seed({}, {})", v(0), v(1)), false),
                "weakset.seed" => (format!("ts_weakset_seed({}, {})", v(0), v(1)), false),
                "object.getOwnPropertyDescriptor" => (
                    format!("ts_get_own_property_descriptor({}, {})", v(0), v(1)),
                    false,
                ),
                "object.getOwnPropertyDescriptors" => {
                    (format!("ts_get_own_property_descriptors({})", v(0)), false)
                }
                // Reflect.* — thin wrappers over the dynamic property / call /
                // construct runtime (Reflect.get(t,k[,recv]) ignores receiver in
                // v1, matching the common non-proxy / non-accessor case).
                "reflect.get" if args.len() == 3 && reflect_receiver_enabled() => (format!("ts_reflect_get_recv({}, {}, {})", v(0), v(1), v(2)), false),
                "reflect.get" => (format!("ts_get_dyn({}, {})", v(0), v(1)), false),
                "reflect.set" if args.len() == 4 && reflect_receiver_enabled() => (format!("ts_reflect_set_recv({}, {}, {}, {})", v(0), v(1), v(2), v(3)), false),
                "reflect.set" => (format!("ts_reflect_set({}, {}, {})", v(0), v(1), v(2)), false),
                "reflect.has" => (format!("ts_reflect_has({}, {})", v(0), v(1)), false),
                "reflect.deleteProperty" => (format!("ts_reflect_delete({}, {})", v(0), v(1)), false),
                "reflect.ownKeys" => (format!("ts_reflect_own_keys({})", v(0)), false),
                "reflect.getPrototypeOf" => (format!("ts_get_proto({})", v(0)), false),
                "reflect.setPrototypeOf" => (format!("ts_reflect_set_proto({}, {})", v(0), v(1)), false),
                "reflect.defineProperty" => (format!("ts_reflect_define_property({}, {}, {})", v(0), v(1), v(2)), false),
                "reflect.getOwnPropertyDescriptor" => (format!("ts_get_own_property_descriptor({}, {})", v(0), v(1)), false),
                "reflect.isExtensible" => (format!("ts_object_is_extensible({})", v(0)), false),
                "reflect.preventExtensions" => (format!("ts_reflect_prevent_extensions({})", v(0)), false),
                "reflect.apply" => (format!("ts_reflect_apply({}, {}, {})", v(0), v(1), v(2)), false),
                "reflect.construct" => (format!("ts_reflect_construct({}, {})", v(0), v(1)), false),
                "map.cursorNext" => (format!("ts_map_cursor_next({}, {}, {})", v(0), n(1), n(2)), true),
                "map.cursorOrder" => (format!("ts_map_cursor_order({}, {})", v(0), n(1)), true),
                "map.cursorKey" => (format!("ts_map_cursor_key({}, {})", v(0), n(1)), false),
                "map.cursorVal" => (format!("ts_map_cursor_val({}, {})", v(0), n(1)), false),
                "map.cursorPair" => (format!("ts_map_cursor_pair({}, {})", v(0), n(1)), false),
                "construct.sameCode" => (format!("ts_bool(ts_construct_same_code({}, {}))", v(0), v(1)), false),
                "construct.begin" => (format!("ts_construct_begin({})", v(0)), false),
                b if b.starts_with("construct.begin:") => (format!("ts_construct_begin_n({}, {}u)", v(0), &b["construct.begin:".len()..]), false),
                "construct.end" => (format!("ts_construct_end({}, {}, {})", v(0), v(1), v(2)), false),
                "proxy.new" => (format!("ts_proxy_new({}, {})", v(0), v(1)), false),
                "proxy.revocable" => (format!("ts_proxy_revocable({}, {})", v(0), v(1)), false),
                "symbol.new" => (format!("ts_symbol_new({})", v(0)), false),
                "symbol.get" => (format!("ts_get_symkey({}, {})", v(0), v(1)), false),
                "symbol.description" => (format!("ts_symbol_description({})", v(0)), false),
                "symbol.for" => (format!("ts_symbol_for({})", v(0)), false),
                "symbol.keyFor" => (format!("ts_symbol_key_for({})", v(0)), false),
                "symbol.toString" => (format!("ts_symbol_tostring({})", v(0)), false),
                "instanceof" => (format!("ts_bool(ts_instanceof({}, {}))", v(0), v(1)), false),
                // A class method read as a value (docs/closed_receivers_design.md,
                // slice 2): it may run with any `this` from here on.
                "class.methodEscape" => ("(ts_note_method_escape(), TS_UNDEFINED)".to_string(), false),
                // A class binding that may not be initialized yet: undefined
                // until its declaration ran (a ReferenceError to read).
                b if b.starts_with("binding.check:") => (
                    format!(
                        "(ts_is_undef({v}) ? (ts_throw_uninitialized({n}), TS_UNDEFINED) : TS_UNDEFINED)",
                        v = v(0),
                        n = c_string_lit(&b["binding.check:".len()..])
                    ),
                    false,
                ),
                // x instanceof C, C a class declaration evaluated once: its one
                // prototype is CLASS_PROTO[C]; an instance of C itself answers in
                // line, any other value walks its chain. (The class value, operand
                // 1, was read for its binding's checks.)
                b if b.starts_with("instanceof.class:") => {
                    let c = &b["instanceof.class:".len()..];
                    let o = v(0);
                    let cid: u32 = c.parse().unwrap_or(u32::MAX);
                    let dfs = class_dfs();
                    if class_index_enabled() && dfs.ranged.contains(&cid) {
                        // a sized instance answers by its class's interval
                        // (docs/class_index_dispatch_design.md); anything else
                        // (no index, a class prototype's mark), or after a class
                        // prototype was relinked, walks its chain
                        let lo = dfs.index[&cid] + 1;
                        let span = dfs.span[&cid];
                        // (the chain walk may run a Proxy's trap: a lazy frame
                        // links around it)
                        let walk = ctx.lazy_linked_int(&format!("ts_instanceof({}, CLASS_PROTO[{}])", o, c));
                        (
                            format!(
                                "ts_bool(ts_is_obj({o}) && ({{ uint32_t _ci = ((ts_object*)ts_ptr({o}))->cls; ((uint32_t)(_ci - 1u) < 0x7FFFFFFFu{relinked}) ? (uint32_t)(_ci - {lo}u) < {span}u : {walk}; }}))",
                                o = o,
                                lo = lo,
                                span = span,
                                relinked = relink_guard(),
                                walk = walk
                            ),
                            false,
                        )
                    } else {
                        let walk = ctx.lazy_linked_int(&format!("ts_instanceof({}, CLASS_PROTO[{}])", o, c));
                        (
                            format!(
                                "ts_bool((ts_is_obj({o}) && ((ts_object*)ts_ptr({o}))->proto == CLASS_PROTO[{c}]) || {walk})",
                                o = o,
                                c = c,
                                walk = walk
                            ),
                            false,
                        )
                    }
                }
                // x instanceof C with a Symbol.hasInstance hook: C[Symbol.hasInstance](x).
                // ts_instanceof_hook already returns a tsv bool (ToBoolean of the result).
                "instanceof.hook" => (format!("ts_instanceof_hook({}, {})", v(0), v(1)), false),
                // x instanceof <runtime constructor value>: Symbol.hasInstance then a
                // prototype-chain walk against the class value's prototype (returns tsv bool).
                "instanceof.dyn" => (format!("ts_instanceof_dyn({}, {})", v(0), v(1)), false),
                "array.isArray" => (format!("ts_bool(ts_is_array_fast({}))", v(0)), false),
                "array.pushHole" => (
                    format!("(ts_array_push_hole({}), TS_UNDEFINED)", v(0)),
                    false,
                ),
                "array.newLength" => (format!("ts_array_new_length({})", n(0)), false),
                "array.from" => (
                    if args.len() >= 2 {
                        format!("ts_array_from_mapped({}, {})", v(0), v(1))
                    } else {
                        format!("ts_array_from({})", v(0))
                    },
                    false,
                ),
                // JSON
                "json.stringify" => (format!("ts_json_stringify({})", v(0)), false),
                "json.stringify.len" => (format!("ts_json_stringify_len({})", v(0)), true),
                "json.num.len" => (format!("ts_json_num_len_fast({})", nc(0)), true),
                "json.string.len" => (format!("ts_json_string_len_fast({})", v(0)), true),
                "json.stringify.indent" => (
                    format!("ts_json_stringify_indent({}, {})", v(0), v(1)),
                    false,
                ),
                "json.stringify.indent.len" => (
                    format!("ts_json_stringify_indent_len({}, {})", v(0), v(1)),
                    true,
                ),
                "json.parse" => (
                    if args.len() >= 2 {
                        format!("ts_json_parse_reviver({}, {})", v(0), v(1))
                    } else {
                        format!("ts_json_parse({})", v(0))
                    },
                    false,
                ),
                other => {
                    let _ = writeln!(s, "  ts_unsupported_builtin(\"{}\");", other);
                    ("TS_UNDEFINED".to_string(), false)
                }
            };
            match dst {
                Some(d) if numeric => s.push_str(&ctx.set_num(d.0, &expr)),
                Some(d) => s.push_str(&ctx.set_val(d.0, &expr)),
                None => {
                    let _ = writeln!(s, "  {};", expr);
                }
            }
        }
        Inst::CallBuiltin {
            dst,
            builtin,
            recv,
            args,
        } => {
            if let Some(d) = dst {
                if let Some(spec) = ctx.scalar_slice(d.0) {
                    if spec.root == d.0 && scalar_slice_kind(builtin).is_some() {
                        emit_scalar_slice_calc(s, d.0, spec, ctx);
                        return;
                    }
                }
            }
            if builtin == "string.charCodeAt" {
                if let Some(spec) = ctx.scalar_slice(recv.0) {
                    if let Some(d) = dst {
                        let expr = scalar_slice_charcodeat_expr(spec, args, ctx);
                        s.push_str(&ctx.set_num(d.0, &expr));
                    }
                    return;
                }
            }
            // Map a stdlib method to its runtime helper. `r` is the receiver value
            // (boxed tsv); numeric/string args are passed in the helper's ABI.
            let r = ctx.val(recv.0);
            let v = |i: usize| -> String {
                args.get(i)
                    .map(|a| ctx.val(a.0))
                    .unwrap_or_else(|| "TS_UNDEFINED".into())
            };
            let n = |i: usize| -> String {
                args.get(i)
                    .map(|a| ctx.num(a.0))
                    .unwrap_or_else(|| "0".into())
            };
            let has = |i: usize| if args.len() > i { "1" } else { "0" };
            // The callback of an iteration method, bound to its thisArg when
            // the call passes one (`arr.forEach(fn, ctx)`).
            let cbv = || -> String {
                if args.len() > 1 { format!("ts_callback_with_this({}, {})", v(0), v(1)) } else { v(0) }
            };
            // (expr, is_numeric_result)
            let optional_end = if let Some(end) = args.get(1) {
                if ctx.unboxed.contains(&end.0) { "1".into() }
                else { format!("!ts_is_undefined_fast({})", ctx.val(end.0)) }
            } else {
                "0".into()
            };
            let (expr, numeric): (String, bool) = match builtin.as_str() {
                "string.toUpperCase" => (format!("ts_unicode_toupper_tsv({})", r), false),
                "string.toLowerCase" => (format!("ts_unicode_tolower_tsv({})", r), false),
                "string.toLocaleUpperCase" => {
                    (format!("ts_unicode_tolocaleupper_tsv({}, {})", r, v(0)), false)
                }
                "string.toLocaleLowerCase" => {
                    (format!("ts_unicode_tolocalelower_tsv({}, {})", r, v(0)), false)
                }
                "string.normalize" => (format!("ts_unicode_normalize_tsv({}, {})", r, v(0)), false),
                "string.slice" => (
                    format!("ts_str_slice({}, {}, {}, {})", r, n(0), n(1), optional_end),
                    false,
                ),
                "string.substring" => (
                    format!("ts_str_substring({}, {}, {}, {})", r, n(0), n(1), optional_end),
                    false,
                ),
                "string.substr" => (format!("ts_str_substr({}, {}, {})", r, v(0), v(1)), false),
                "string.toString" | "string.valueOf" => (format!("ts_str_value({})", r), false),
                "string.indexOf" => (
                    format!("ts_str_indexof_fast({}, {}, {}, {})", r, v(0), n(1), has(1)),
                    true,
                ),
                "string.includes" => (
                    format!(
                        "ts_bool(ts_str_includes({}, {}, {}, {}))",
                        r,
                        v(0),
                        n(1),
                        has(1)
                    ),
                    false,
                ),
                "string.charAt" => (format!("ts_str_charat({}, {})", r, n(0)), false),
                "string.charCodeAt" => {
                    let index = args.first().map(|a| ctx.numc(a.0)).unwrap_or_else(|| "0".into());
                    let hoisted = ctx.sv_hoisted.borrow().get(&recv.0).copied();
                    let expr = if let Some(top) = hoisted {
                        // the scalars read before the loop: a bounds test and a unit
                        // load (an immediate has no data and takes the general path,
                        // as do NaN and an index out of range)
                        format!(
                            "({{ double _ci = {idx}; (_sd{r}_{t} && _ci >= 0 && _ci < (double)_sn{r}_{t}) ? ({{ uint32_t _cu; if (_sw{r}_{t}) {{ uint16_t _u2; memcpy(&_u2, _sd{r}_{t} + ((size_t)(uint32_t)_ci * 2u), 2); _cu = _u2; }} else _cu = (unsigned char)_sd{r}_{t}[(uint32_t)_ci]; (double)_cu; }}) : ts_str_charcodeat_general({v}, _ci); }})",
                            idx = index,
                            r = recv.0,
                            t = top,
                            v = r
                        )
                    } else {
                        format!("ts_str_charcodeat_typed({}, {})", r, index)
                    };
                    (expr, true)
                }
                "string.concat" => (format!("ts_str_concat({}, {})", r, v(0)), false),
                "string.codePointAt" => (format!("ts_str_codepointat({}, {})", r, n(0)), false),
                "string.repeat" => (format!("ts_str_repeat({}, {})", r, n(0)), false),
                "string.trim" => (format!("ts_str_trim({})", r), false),
                "string.split" => (format!("ts_str_split({}, {}, {})", r, v(0), v(1)), false),
                "array.map" => (format!("ts_array_map({}, {})", r, cbv()), false),
                "array.filter" => (format!("ts_array_filter({}, {})", r, cbv()), false),
                "array.forEach" => (format!("ts_array_foreach({}, {})", r, cbv()), false),
                "array.reduce" => (
                    format!("ts_array_reduce({}, {}, {}, {})", r, v(0), v(1), has(1)),
                    false,
                ),
                "array.reduceRight" => (
                    format!(
                        "ts_array_reduce_right({}, {}, {}, {})",
                        r,
                        v(0),
                        v(1),
                        has(1)
                    ),
                    false,
                ),
                "array.splice" => (
                    format!("ts_array_splice({}, {}, {}, 1, {})", r, n(0), n(1), v(2)),
                    false,
                ),
                "array.spliceEnd" => (
                    format!("ts_array_splice({}, {}, 0, 0, {})", r, n(0), v(1)),
                    false,
                ),
                // result discarded (docs/splice_fast_paths_design.md)
                "array.spliceInsert1" => (
                    format!("ts_array_splice_insert1({}, {}, {})", r, n(0), v(1)),
                    false,
                ),
                "array.spliceDrop" => (
                    format!("ts_array_splice_drop({}, {}, {}, 1, {})", r, n(0), n(1), v(2)),
                    false,
                ),
                "array.copyWithin" => (
                    format!(
                        "ts_array_copy_within({}, {}, {}, {}, {})",
                        r,
                        n(0),
                        n(1),
                        n(2),
                        has(2)
                    ),
                    false,
                ),
                "array.indexOf" => (
                    format!("ts_array_indexof({}, {}, {}, {})", r, v(0), n(1), has(1)),
                    true,
                ),
                "array.includes" => (
                    format!(
                        "ts_bool(ts_array_includes({}, {}, {}, {}))",
                        r,
                        v(0),
                        n(1),
                        has(1)
                    ),
                    false,
                ),
                "array.slice" => (
                    format!("ts_array_slice({}, {}, {}, {})", r, n(0), n(1), optional_end),
                    false,
                ),
                "array.concat" => (format!("ts_array_concat({}, {})", r, v(0)), false),
                "array.join" => (format!("ts_array_join({}, {})", r, v(0)), false),
                "array.toString" => (
                    format!("ts_array_join({}, ts_new_string(\",\", 1))", r),
                    false,
                ),
                "promise.then" => (format!("ts_promise_then({}, {}, {})", r, v(0), v(1)), false),
                "promise.catch" => (format!("ts_promise_catch({}, {})", r, v(0)), false),
                "promise.finally" => (format!("ts_promise_finally({}, {})", r, v(0)), false),
                "array.push" => {
                    // push(a, b, c, ...): append each arg, result is the new length
                    // (a raw double, since this arm is marked numeric).
                    let mut blk = String::from("({ ");
                    let push_fn = if push_inline_enabled() { "ts_array_push_inline" } else { "ts_array_push" };
                    for a in args.iter() {
                        let _ = std::fmt::write(
                            &mut blk,
                            format_args!("{}({}, {}); ", push_fn, r, ctx.val(a.0)),
                        );
                    }
                    let _ = std::fmt::write(
                        &mut blk,
                        format_args!("(double)ts_array_len_fast({}); }})", r),
                    );
                    (blk, true)
                }
                "array.pop" => (format!("ts_array_pop({})", r), false),
                "array.find" => (format!("ts_array_find({}, {})", r, cbv()), false),
                "array.findIndex" => (format!("ts_array_findindex({}, {})", r, cbv()), true),
                "array.findLast" => (format!("ts_array_findlast({}, {})", r, cbv()), false),
                "array.findLastIndex" => (format!("ts_array_findlastindex({}, {})", r, cbv()), true),
                "array.flat" => (
                    format!(
                        "ts_array_flat({}, {})",
                        r,
                        if args.is_empty() {
                            "1".to_string()
                        } else {
                            n(0)
                        }
                    ),
                    false,
                ),
                "array.flatMap" => (format!("ts_array_flatmap({}, {})", r, cbv()), false),
                "array.some" => (format!("ts_bool(ts_array_some({}, {}))", r, cbv()), false),
                "array.every" => (format!("ts_bool(ts_array_every({}, {}))", r, cbv()), false),
                "array.lastIndexOf" => (
                    format!(
                        "ts_array_lastindexof({}, {}, {}, {})",
                        r,
                        v(0),
                        n(1),
                        has(1)
                    ),
                    true,
                ),
                "array.at" => (format!("ts_array_at({}, {})", r, n(0)), false),
                "array.reverse" => (format!("ts_array_reverse({})", r), false),
                "array.shift" => (format!("ts_array_shift({})", r), false),
                "array.unshift" => {
                    // unshift(a, b, c, ...): prepend all args (keeping their order),
                    // result is the new length. Prepend in reverse so the final
                    // order is [a, b, c, ...existing].
                    let mut blk = String::from("({ ");
                    for a in args.iter().rev() {
                        let _ = std::fmt::write(
                            &mut blk,
                            format_args!("ts_array_unshift({}, {}); ", r, ctx.val(a.0)),
                        );
                    }
                    let _ = std::fmt::write(
                        &mut blk,
                        format_args!("(double)ts_array_len_fast({}); }})", r),
                    );
                    (blk, true)
                }
                "array.fill" => (
                    format!(
                        "ts_array_fill({}, {}, {}, {}, {}, {})",
                        r,
                        v(0),
                        n(1),
                        n(2),
                        has(1),
                        has(2)
                    ),
                    false,
                ),
                "array.sort" => (
                    format!(
                        "ts_array_sort({}, {})",
                        r,
                        if args.is_empty() {
                            "TS_UNDEFINED".into()
                        } else {
                            v(0)
                        }
                    ),
                    false,
                ),
                // ES2023 change-by-copy: return a NEW array, receiver unchanged.
                "array.toSorted" => (
                    format!(
                        "ts_array_tosorted({}, {})",
                        r,
                        if args.is_empty() {
                            "TS_UNDEFINED".into()
                        } else {
                            v(0)
                        }
                    ),
                    false,
                ),
                "array.toReversed" => (format!("ts_array_toreversed({})", r), false),
                "array.with" => (format!("ts_array_with({}, {}, {})", r, n(0), v(1)), false),
                // Mirror splice/spliceEnd: the End form (1-arg toSpliced) deletes to
                // the end (has_dc=0); the full form passes a real deleteCount.
                "array.toSpliced" => (
                    format!("ts_array_tospliced({}, {}, {}, 1, {})", r, n(0), n(1), v(2)),
                    false,
                ),
                "array.toSplicedEnd" => (
                    format!("ts_array_tospliced({}, {}, 0, 0, {})", r, n(0), v(1)),
                    false,
                ),
                "string.startsWith" => (
                    format!(
                        "ts_bool(ts_str_startswith({}, {}, {}, {}))",
                        r,
                        v(0),
                        n(1),
                        has(1)
                    ),
                    false,
                ),
                "string.endsWith" => (
                    format!(
                        "ts_bool(ts_str_endswith({}, {}, {}, {}))",
                        r,
                        v(0),
                        n(1),
                        has(1)
                    ),
                    false,
                ),
                "string.padStart" => (
                    format!(
                        "ts_str_padstart({}, {}, {})",
                        r,
                        n(0),
                        if args.len() > 1 {
                            v(1)
                        } else {
                            "TS_UNDEFINED".into()
                        }
                    ),
                    false,
                ),
                "string.padEnd" => (
                    format!(
                        "ts_str_padend({}, {}, {})",
                        r,
                        n(0),
                        if args.len() > 1 {
                            v(1)
                        } else {
                            "TS_UNDEFINED".into()
                        }
                    ),
                    false,
                ),
                "string.trimStart" => (format!("ts_str_trimstart({})", r), false),
                "string.trimEnd" => (format!("ts_str_trimend({})", r), false),
                "string.trimLeft" => (format!("ts_str_trimstart({})", r), false),
                "string.trimRight" => (format!("ts_str_trimend({})", r), false),
                "string.at" => (format!("ts_str_at({}, {})", r, n(0)), false),
                "string.isWellFormed" => (format!("ts_bool(ts_str_is_well_formed({}))", r), false),
                "string.toWellFormed" => (format!("ts_str_to_well_formed({})", r), false),
                "string.replace" => (
                    format!("ts_str_replace({}, {}, {}, 0)", r, v(0), v(1)),
                    false,
                ),
                "string.replaceAll" => (
                    format!("ts_str_replace({}, {}, {}, 1)", r, v(0), v(1)),
                    false,
                ),
                "string.lastIndexOf" => (
                    format!(
                        "ts_str_lastindexof_fast({}, {}, {}, {})",
                        r,
                        v(0),
                        n(1),
                        has(1)
                    ),
                    true,
                ),
                // ---- Number ----
                // The argument is converted with ToIntegerOrInfinity and checked
                // (RangeError) as the spec says; an omitted one is the default.
                "number.toFixed" | "number.toString" | "number.toPrecision" if numfmt_coerce_enabled() => {
                    let base = match builtin.as_str() {
                        "number.toFixed" => "ts_number_to_fixed",
                        "number.toString" => "ts_number_to_string_radix",
                        _ => "ts_number_to_precision",
                    };
                    let e = if args.is_empty() {
                        match builtin.as_str() {
                            "number.toFixed" => format!("{}_d({}, 0)", base, r),
                            "number.toString" => format!("{}_d({}, 10)", base, r),
                            _ => format!("{}_v({}, TS_UNDEFINED)", base, r),
                        }
                    } else if ctx.unboxed.contains(&args[0].0) || ctx.json_locals.contains(&args[0].0) {
                        format!("{}_d({}, {})", base, r, n(0))
                    } else {
                        format!("{}_v({}, {})", base, r, v(0))
                    };
                    (e, false)
                }
                "number.toFixed" => (
                    format!(
                        "ts_number_to_fixed({}, {})",
                        r,
                        if args.is_empty() {
                            "0".to_string()
                        } else {
                            n(0)
                        }
                    ),
                    false,
                ),
                "number.toString" => (
                    format!(
                        "ts_number_to_string_radix({}, {})",
                        r,
                        if args.is_empty() {
                            "10".to_string()
                        } else {
                            n(0)
                        }
                    ),
                    false,
                ),
                "number.toPrecision" => (
                    format!(
                        "ts_number_to_precision({}, {})",
                        r,
                        if args.is_empty() {
                            "0".to_string()
                        } else {
                            n(0)
                        }
                    ),
                    false,
                ),
                // the argument as for toPrecision; undefined is as many digits
                // as necessary
                "number.toExponential" => (
                    if args.is_empty() {
                        format!("ts_number_to_exponential_v({}, TS_UNDEFINED)", r)
                    } else if ctx.unboxed.contains(&args[0].0) || ctx.json_locals.contains(&args[0].0) {
                        format!("ts_number_to_exponential_d({}, {})", r, n(0))
                    } else {
                        format!("ts_number_to_exponential_v({}, {})", r, v(0))
                    },
                    false,
                ),
                "number.valueOf" => (ctx.num(recv.0), true),
                "boolean.toString" => (
                    format!(
                        "(ts_truthy_fast({}) ? ts_new_string(\"true\", 4) : ts_new_string(\"false\", 5))",
                        r
                    ),
                    false,
                ),
                "boolean.valueOf" => (format!("ts_bool(ts_truthy_fast({}))", r), false),
                "response.text" => (format!("ts_response_text({})", r), false),
                "response.json" => (format!("ts_response_json({})", r), false),
                "headers.get" => (
                    format!(
                        "ts_headers_get({}, {})",
                        r,
                        if args.is_empty() {
                            "TS_UNDEFINED".to_string()
                        } else {
                            v(0)
                        }
                    ),
                    false,
                ),
                "headers.has" => (
                    format!(
                        "ts_bool(ts_headers_has({}, {}))",
                        r,
                        if args.is_empty() {
                            "TS_UNDEFINED".to_string()
                        } else {
                            v(0)
                        }
                    ),
                    false,
                ),
                "headers.keys" => (format!("ts_headers_keys({})", r), false),
                "headers.values" => (format!("ts_headers_values({})", r), false),
                "headers.entries" => (format!("ts_headers_entries({})", r), false),
                "headers.append" => (
                    format!(
                        "ts_headers_append({}, {}, {})",
                        r,
                        if args.is_empty() {
                            "TS_UNDEFINED".to_string()
                        } else {
                            v(0)
                        },
                        if args.len() > 1 {
                            v(1)
                        } else {
                            "TS_UNDEFINED".to_string()
                        }
                    ),
                    false,
                ),
                "headers.set" => (
                    format!(
                        "ts_headers_set({}, {}, {})",
                        r,
                        if args.is_empty() {
                            "TS_UNDEFINED".to_string()
                        } else {
                            v(0)
                        },
                        if args.len() > 1 {
                            v(1)
                        } else {
                            "TS_UNDEFINED".to_string()
                        }
                    ),
                    false,
                ),
                "headers.delete" => (
                    format!(
                        "ts_headers_delete({}, {})",
                        r,
                        if args.is_empty() {
                            "TS_UNDEFINED".to_string()
                        } else {
                            v(0)
                        }
                    ),
                    false,
                ),
                "generator.next" => (
                    format!(
                        "ts_gen_next({}, {})",
                        r,
                        if args.is_empty() {
                            "TS_UNDEFINED".to_string()
                        } else {
                            v(0)
                        }
                    ),
                    false,
                ),
                // for..of over a value of no known iterable type (exporter
                // lowerDynamicForOf): open, next element or TS_ITER_DONE
                "forof.open" => (format!("ts_forof_open({})", r), false),
                "forof.isDone" => (format!("(({}) == TS_ITER_DONE)", r), true),
                _ if builtin.starts_with("forof.next:") => {
                    let nid: u32 = builtin["forof.next:".len()..].parse().unwrap_or(0);
                    (
                        format!("ts_forof_next({}, {}, {})", r, args.get(0).map(|a| ctx.num(a.0)).unwrap_or_else(|| "0".into()), method_key_str(nid, ctx.wksym)),
                        false,
                    )
                }
                _ if builtin.starts_with("iter.step:") => {
                    // iter.step:<next-method-id> -> step a generic iterator, looking up
                    // `next` by field key then method key (TS_KEY_METHOD of the id),
                    // falling back to generator.next. See ts_iter_step.
                    let nid: u32 = builtin["iter.step:".len()..].parse().unwrap_or(0);
                    let sent = if args.is_empty() {
                        "TS_UNDEFINED".to_string()
                    } else {
                        v(0)
                    };
                    (
                        format!(
                            "ts_iter_step({}, {}, {})",
                            r,
                            sent,
                            method_key_str(nid, ctx.wksym)
                        ),
                        false,
                    )
                }
                "asyncgen.next" => (
                    format!(
                        "ts_asyncgen_next({}, {})",
                        r,
                        if args.is_empty() {
                            "TS_UNDEFINED".to_string()
                        } else {
                            v(0)
                        }
                    ),
                    false,
                ),
                "generator.throw" => (
                    format!(
                        "ts_gen_throw({}, {})",
                        r,
                        if args.is_empty() {
                            "TS_UNDEFINED".to_string()
                        } else {
                            v(0)
                        }
                    ),
                    false,
                ),
                "generator.return" => (
                    format!(
                        "ts_gen_return({}, {})",
                        r,
                        if args.is_empty() {
                            "TS_UNDEFINED".to_string()
                        } else {
                            v(0)
                        }
                    ),
                    false,
                ),
                "asyncgen.throw" => (
                    format!(
                        "ts_asyncgen_throw({}, {})",
                        r,
                        if args.is_empty() {
                            "TS_UNDEFINED".to_string()
                        } else {
                            v(0)
                        }
                    ),
                    false,
                ),
                "asyncgen.return" => (
                    format!(
                        "ts_asyncgen_return({}, {})",
                        r,
                        if args.is_empty() {
                            "TS_UNDEFINED".to_string()
                        } else {
                            v(0)
                        }
                    ),
                    false,
                ),
                // ---- Map ----
                "map.set" => (format!("ts_map_set({}, {}, {})", r, v(0), v(1)), false),
                // a number key from an unboxed local: the indexed map's probe in
                // line (ts_rt.h ts_map_get_num; TSAOT_MAP_NUM_INLINE=0 keeps the call)
                "map.get" if map_num_inline_enabled() && args.first().map_or(false, |a| ctx.unboxed.contains(&a.0)) => (
                    format!("ts_map_get_num({}, {})", r, ctx.numc_double(args[0].0)),
                    false,
                ),
                "map.has" if map_num_inline_enabled() && args.first().map_or(false, |a| ctx.unboxed.contains(&a.0)) => (
                    format!("ts_bool(ts_map_has_num({}, {}))", r, ctx.numc_double(args[0].0)),
                    false,
                ),
                // a key the program types as a string or as a reference: the
                // indexed collection's probe in line (ts_rt.h ts_map_get_str ...;
                // TSAOT_MAP_KEY_INLINE=0 keeps the call)
                "map.get" if map_key_inline_enabled() && args.first().map_or(false, |a| ctx.str_typed.contains(&a.0)) => (
                    format!("ts_map_get_str({}, {})", r, v(0)),
                    false,
                ),
                "map.get" if map_key_inline_enabled() && args.first().map_or(false, |a| ctx.ref_typed.contains(&a.0)) => (
                    format!("ts_map_get_ref({}, {})", r, v(0)),
                    false,
                ),
                "map.has" if map_key_inline_enabled() && args.first().map_or(false, |a| ctx.str_typed.contains(&a.0)) => (
                    format!("ts_bool(ts_map_has_str({}, {}))", r, v(0)),
                    false,
                ),
                "map.has" if map_key_inline_enabled() && args.first().map_or(false, |a| ctx.ref_typed.contains(&a.0)) => (
                    format!("ts_bool(ts_map_has_ref({}, {}))", r, v(0)),
                    false,
                ),
                "map.get" => (format!("ts_map_get({}, {})", r, v(0)), false),
                "map.has" => (format!("ts_bool(ts_map_has({}, {}))", r, v(0)), false),
                "map.delete" => (format!("ts_bool(ts_map_delete({}, {}))", r, v(0)), false),
                "map.clear" => (format!("({{ ts_map_clear({}); TS_UNDEFINED; }})", r), false),
                "map.keys" => (format!("ts_map_keys({})", r), false),
                "map.values" => (format!("ts_map_values({})", r), false),
                "map.entries" => (format!("ts_map_entries({})", r), false),
                "map.size" => (format!("ts_map_size({})", r), true),
                "map.forEach" => (
                    format!("({{ ts_map_foreach({}, {}); TS_UNDEFINED; }})", r, cbv()),
                    false,
                ),
                // ---- WeakMap ----
                "weakmap.set" => (format!("ts_weakmap_set({}, {}, {})", r, v(0), v(1)), false),
                "weakmap.get" => (format!("ts_weakmap_get({}, {})", r, v(0)), false),
                "weakmap.has" => (format!("ts_bool(ts_weakmap_has({}, {}))", r, v(0)), false),
                "weakmap.delete" => (format!("ts_bool(ts_weakmap_delete({}, {}))", r, v(0)), false),
                // ---- Set ----
                "set.add" => (format!("ts_set_add({}, {})", r, v(0)), false),
                "set.has" if map_key_inline_enabled() && args.first().map_or(false, |a| ctx.str_typed.contains(&a.0)) => (
                    format!("ts_bool(ts_set_has_str({}, {}))", r, v(0)),
                    false,
                ),
                "set.has" if map_key_inline_enabled() && args.first().map_or(false, |a| ctx.ref_typed.contains(&a.0)) => (
                    format!("ts_bool(ts_set_has_ref({}, {}))", r, v(0)),
                    false,
                ),
                "set.has" => (format!("ts_bool(ts_set_has({}, {}))", r, v(0)), false),
                "set.delete" => (format!("ts_bool(ts_set_delete({}, {}))", r, v(0)), false),
                "set.clear" => (format!("({{ ts_set_clear({}); TS_UNDEFINED; }})", r), false),
                "set.keys" => (format!("ts_set_keys({})", r), false),
                "set.values" => (format!("ts_set_values({})", r), false),
                "set.entries" => (format!("ts_set_entries({})", r), false),
                "array.entries" if array_iterators_enabled() => (format!("ts_array_iter_new({}, 2)", r), false),
                "array.keys" if array_iterators_enabled() => (format!("ts_array_iter_new({}, 1)", r), false),
                "array.values" if array_iterators_enabled() => (format!("ts_array_iter_new({}, 0)", r), false),
                "array.entries" => (format!("ts_array_entries({})", r), false),
                "array.keys" => (format!("ts_array_keys_arr({})", r), false),
                "array.values" => (format!("ts_array_values_arr({})", r), false),
                "set.size" => (format!("ts_set_size({})", r), true),
                "set.forEach" => (
                    format!("({{ ts_set_foreach({}, {}); TS_UNDEFINED; }})", r, cbv()),
                    false,
                ),
                // ---- WeakSet ----
                "weakset.add" => (format!("ts_weakset_add({}, {})", r, v(0)), false),
                "weakset.has" => (format!("ts_bool(ts_weakset_has({}, {}))", r, v(0)), false),
                "weakset.delete" => (format!("ts_bool(ts_weakset_delete({}, {}))", r, v(0)), false),
                other => {
                    let _ = writeln!(s, "  ts_unsupported_builtin(\"{}\");", other);
                    ("TS_UNDEFINED".to_string(), false)
                }
            };
            match dst {
                Some(d) if numeric => s.push_str(&ctx.set_num(d.0, &expr)),
                Some(d) => s.push_str(&ctx.set_val(d.0, &expr)),
                None => {
                    let _ = writeln!(s, "  {};", expr);
                }
            }
        }
        Inst::GetProto { dst, obj } => {
            s.push_str(&ctx.set_val(dst.0, &format!("ts_get_proto({})", ctx.val(obj.0))));
        }
        Inst::SetProto { dst, obj, proto } => {
            // A SetProto with a result is the program's Object.setPrototypeOf;
            // the class setup's links have none (see ts_set_proto_user).
            let f = if dst.is_some() { user_set_proto_fn() } else { "ts_set_proto" };
            let call = format!("{}({}, {})", f, ctx.val(obj.0), ctx.val(proto.0));
            match dst {
                Some(d) => s.push_str(&ctx.set_val(d.0, &call)),
                None => {
                    let _ = writeln!(s, "  {};", call);
                }
            }
        }
        Inst::Copy { dst, src } => {
            if !ctx.accums.is_empty() && ctx.accums.inits.get(&dst.0) == Some(&src.0) {
                s.push_str(&ctx.set_val(dst.0, &format!("ts_sb_new({})", ctx.val(src.0))));
                return;
            }
            if ctx.scalar_slice(src.0).is_some()
                && ctx
                    .scalar_slice(dst.0)
                    .zip(ctx.scalar_slice(src.0))
                    .map_or(false, |(d, s)| d.root == s.root)
            {
                return;
            }
            if ctx.json_locals.contains(&dst.0) && ctx.json_locals.contains(&src.0) {
                let _ = writeln!(s, "  j{} = j{};", dst.0, src.0);
                return;
            }
            // copy respecting boxed/unboxed representation of each side
            if ctx.int32_use.contains(&dst.0) && ctx.int32_use.contains(&src.0) {
                let _ = writeln!(s, "  d{} = d{};", dst.0, src.0);
            } else if ctx.unboxed.contains(&dst.0) {
                s.push_str(&ctx.set_num(dst.0, &ctx.num(src.0)));
            } else {
                s.push_str(&ctx.set_val(dst.0, &ctx.val(src.0)));
            }
        }
        Inst::LoadField { dst, obj, field, slots, elem, cls } => {
            if ctx.json_locals.contains(&obj.0) {
                if is_length_field(field.0) && !ctx.json_locals.contains(&dst.0) {
                    s.push_str(&ctx.set_val(
                        dst.0,
                        &format!("ts_json_dom_length_value({})", ctx.jval(obj.0)),
                    ));
                    return;
                }
                if ctx.json_locals.contains(&dst.0) {
                    let _ = writeln!(
                        s,
                        "  j{} = ts_json_dom_get({}, {}u);",
                        dst.0,
                        ctx.jval(obj.0),
                        field.0
                    );
                } else {
                    s.push_str(&ctx.set_val(
                        dst.0,
                        &format!(
                            "ts_json_dom_to_tsv(ts_json_dom_get({}, {}u))",
                            ctx.jval(obj.0),
                            field.0
                        ),
                    ));
                }
                return;
            }
            let (class, hinted) = receiver_class(ctx, obj.0, *cls, field.0);
            if let Some(c) = class {
                if let Some(off) = struct_direct_offset(c, field.0, ctx.classes) {
                    let cn = struct_name(c);
                    let obj_name = ctx.vname(obj.0);
                    let st = format!("((({}*)ts_ptr({}))->{})", cn, obj_name, off);
                    // A receiver that is NOT a struct of class `c` (a Proxy, a
                    // plain object relinked behind the class prototype, a borrowed
                    // method's this) routes `this.field` through ts_get. The
                    // g_typed_slow gate keeps the direct struct path for every
                    // program that never creates one.
                    let guard = receiver_guard(&obj_name, &hinted, c);
                    // a hinted receiver may be null or undefined, and so may a
                    // method's `this` once it can be called bare: the read throws
                    // (the frozen emitter's ts_get under TSAOT_TYPED_SLOW=0)
                    let getter = if hinted.is_some() || typed_slow_enabled() { "ts_get_checked" } else { "ts_get" };
                    let slow = ctx.lazy_linked(&format!("{}({}, {})", getter, obj_name, field.0));
                    if int32_field(c, field.0, ctx.classes) {
                        // an integer slot; the slow path's boxed number is integral
                        // too (every store of the field checks), so it truncates
                        let e = format!("(({2}) ? (long long)ts_to_num({0}) : {1})", slow, st, guard);
                        s.push_str(&ctx.set_int_or_num(dst.0, &e));
                    } else if numeric_field(c, field.0, ctx.classes) {
                        let e = format!("(({2}) ? ts_to_num({0}) : {1})", slow, st, guard);
                        s.push_str(&ctx.set_num(dst.0, &e));
                    } else {
                        let e = format!("(({2}) ? {0} : {1})", slow, st, guard);
                        s.push_str(&ctx.set_val(dst.0, &e));
                    }
                    return;
                }
                // a class the program dispatches dynamically: the receiver is a
                // sized instance, never a shaped object, so its site probes the
                // sized entry in line (docs/pic_sized_inline_design.md)
                if sized_pic_inline_enabled() && prop_pic_enabled() && !ctx.lazy_homes {
                    let pic = ctx.fresh_label();
                    let _ = writeln!(s, "  {{ static ts_prop_ic _ts_pic_{} = TS_PROP_IC_INIT;", pic);
                    let e = if ctx.lazy_frame {
                        format!("ts_get_sized_pic_inline_lazy({}, {}, &_ts_pic_{}, &F.h, {})", ctx.val(obj.0), field.0, pic, ctx.frame_nslots)
                    } else {
                        format!("ts_get_sized_pic_inline({}, {}, &_ts_pic_{})", ctx.val(obj.0), field.0, pic)
                    };
                    s.push_str(&ctx.set_val(dst.0, &e));
                    let _ = writeln!(s, "  }}");
                    return;
                }
            }
            // Static-slot hint (docs/static_slots_design.md): the probe checks the
            // predicted in-object slot against the receiver's shape and falls to
            // the out-of-line cached read otherwise.
            if *slots != 0 && prop_pic_enabled() && static_slots_enabled() {
                let pic = ctx.fresh_label();
                let _ = writeln!(s, "  {{ static ts_prop_ic _ts_pic_{} = TS_PROP_IC_INIT;", pic);
                let s1 = (slots & 0xFF) - 1;
                let s2 = (slots >> 8) & 0xFF;
                let s3 = (slots >> 16) & 0xFF;
                let homes_try = |try_call: String| -> String {
                    format!(
                        "({{ tsv _lz; if (!{try_call}) {{ {sp}_lz = ts_get_linked({o}, {k}, &_ts_pic_{pic}, &F.h, {n});{rl} }} _lz; }})",
                        try_call = try_call, sp = ctx.spill_now(), rl = ctx.reload_now(),
                        o = ctx.val(obj.0), k = field.0, pic = pic, n = ctx.frame_nslots
                    )
                };
                let get_expr = match (s2, s3, ctx.lazy_frame) {
                    (0, _, true) if ctx.lazy_homes => homes_try(format!("ts_get_static_try({}, {}, {}u, &_ts_pic_{}, &_lz)", ctx.val(obj.0), field.0, s1, pic)),
                    (_, 0, true) if ctx.lazy_homes => homes_try(format!("ts_get_static2_try({}, {}, {}u, {}u, &_ts_pic_{}, &_lz)", ctx.val(obj.0), field.0, s1, s2 - 1, pic)),
                    (_, _, true) if ctx.lazy_homes => homes_try(format!("ts_get_static3_try({}, {}, {}u, {}u, {}u, &_ts_pic_{}, &_lz)", ctx.val(obj.0), field.0, s1, s2 - 1, s3 - 1, pic)),
                    (0, _, false) => format!("ts_get_static_inline({}, {}, {}u, &_ts_pic_{})", ctx.val(obj.0), field.0, s1, pic),
                    (0, _, true) => format!("ts_get_static_inline_lazy({}, {}, {}u, &_ts_pic_{}, &F.h, {})", ctx.val(obj.0), field.0, s1, pic, ctx.frame_nslots),
                    (_, 0, false) => format!("ts_get_static2_inline({}, {}, {}u, {}u, &_ts_pic_{})", ctx.val(obj.0), field.0, s1, s2 - 1, pic),
                    (_, 0, true) => format!("ts_get_static2_inline_lazy({}, {}, {}u, {}u, &_ts_pic_{}, &F.h, {})", ctx.val(obj.0), field.0, s1, s2 - 1, pic, ctx.frame_nslots),
                    (_, _, false) => format!("ts_get_static3_inline({}, {}, {}u, {}u, {}u, &_ts_pic_{})", ctx.val(obj.0), field.0, s1, s2 - 1, s3 - 1, pic),
                    (_, _, true) => format!("ts_get_static3_inline_lazy({}, {}, {}u, {}u, {}u, &_ts_pic_{}, &F.h, {})", ctx.val(obj.0), field.0, s1, s2 - 1, s3 - 1, pic, ctx.frame_nslots),
                };
                s.push_str(&ctx.set_val(dst.0, &get_expr));
                let _ = writeln!(s, "  }}");
                return;
            }
            // ctx.val boxes an unboxed-numeric receiver (int/double local) — using
            // the raw `v{id}` name here would reference an undeclared identifier.
            // Dynamic/`any` receiver: ts_get_checked throws a catchable TypeError
            // when the receiver is null/undefined (typed struct reads took the
            // direct-offset path above; optional chaining guards the read out).
            if prop_pic_enabled() {
                let pic = ctx.fresh_label();
                let _ = writeln!(
                    s,
                    "  {{ static ts_prop_ic _ts_pic_{} = TS_PROP_IC_INIT;",
                    pic
                );
                let get_expr = if ctx.lazy_homes {
                    format!(
                        "({{ tsv _lz; if (!ts_get_pic_try({o}, {k}, &_ts_pic_{pic}, &_lz)) {{ {sp}_lz = ts_get_linked({o}, {k}, &_ts_pic_{pic}, &F.h, {n});{rl} }} _lz; }})",
                        o = ctx.val(obj.0), k = field.0, pic = pic, n = ctx.frame_nslots,
                        sp = ctx.spill_now(), rl = ctx.reload_now()
                    )
                } else if ctx.lazy_frame {
                    format!(
                        "ts_get_pic_checked_inline_lazy({}, {}, &_ts_pic_{}, &F.h, {})",
                        ctx.val(obj.0),
                        field.0,
                        pic,
                        ctx.frame_nslots
                    )
                } else {
                    format!(
                        "ts_get_pic_checked_inline({}, {}, &_ts_pic_{})",
                        ctx.val(obj.0),
                        field.0,
                        pic
                    )
                };
                // A receiver typed as a view: its length in line (TA2); from the
                // enclosing loop's hoisted test and length when it has them.
                let hoisted_len = if *elem != 0 && is_length_field(field.0) {
                    ctx.ta_hoisted
                        .borrow()
                        .get(&obj.0)
                        .copied()
                        .filter(|(e, _)| *e == *elem - 1)
                        .map(|(_, top)| top)
                } else {
                    None
                };
                let get_expr = if let Some(top) = hoisted_len {
                    format!(
                        "((_tah{a}_{t} && obj_map_plain(&_tah{a}_{t}->o)->len == 0) ? ts_num((double)_tal{a}_{t}) : {g})",
                        a = obj.0,
                        t = top,
                        g = get_expr
                    )
                } else if *elem != 0 && is_length_field(field.0) {
                    format!(
                        "({{ tsv _tl; if (!ts_ta_try_length({}, &_tl)) _tl = {}; _tl; }})",
                        ctx.val(obj.0),
                        get_expr
                    )
                } else {
                    get_expr
                };
                s.push_str(&ctx.set_val(dst.0, &get_expr));
                let _ = writeln!(s, "  }}");
            } else {
                s.push_str(&ctx.set_val(
                    dst.0,
                    &format!("ts_get_checked({}, {})", ctx.val(obj.0), field.0),
                ));
            }
        }
        Inst::LoadMethodValue { dst, recv, method } => {
            // First-class prototype method value: the boxed (unbound) method is
            // registered on the receiver's prototype under TS_KEY_METHOD(method).
            // ts_get walks the proto chain (string/number primitives dispatch to
            // their prototype too). recv is evaluated for its side effects.
            s.push_str(&ctx.set_val(
                dst.0,
                &format!("ts_get({}, TS_KEY_METHOD({}u))", ctx.val(recv.0), method),
            ));
        }
        Inst::LoadBuiltinFn { dst, builtin } => {
            if builtin == "globalThis" {
                s.push_str(&ctx.set_val(dst.0, "ts_global_this()"));
                return;
            }
            if let Some(name) = builtin.strip_prefix("globalobj.") {
                s.push_str(&ctx.set_val(dst.0, &format!("ts_global_get({:?})", name)));
                return;
            }
            // an ambient value: ReferenceError when the global object lacks it
            if let Some(name) = builtin.strip_prefix("globalref.") {
                s.push_str(&ctx.set_val(dst.0, &format!("ts_global_get_ref({:?})", name)));
                return;
            }
            // `protoobj.<kind>`: not a function value but the runtime prototype
            // OBJECT itself (Array/String/Map/Set/Number.prototype), used as the
            // receiver of a following LoadMethodValue so a boxed proto method can be
            // read off it (`Array.prototype.slice` as a value). No adapter exists for
            // these (fnval_adapter_body returns None -> prelude skips them).
            if let Some(kind) = builtin.strip_prefix("protoobj.") {
                // the typed array and buffer prototypes (`x instanceof Uint8Array`)
                let ta = match kind {
                    "arraybuffer" => Some("ts_array_buffer_proto(0)".to_string()),
                    "sharedarraybuffer" => Some("ts_array_buffer_proto(1)".to_string()),
                    "textencoder" => Some("ts_text_encoder_proto()".to_string()),
                    "textdecoder" => Some("ts_text_decoder_proto()".to_string()),
                    _ => kind
                        .strip_prefix("typedarray:")
                        .map(|e| format!("ts_typed_array_proto({})", e.parse::<u32>().unwrap_or(0))),
                };
                if let Some(expr) = ta {
                    s.push_str(&ctx.set_val(dst.0, &expr));
                    return;
                }
                let acc = match kind {
                    "object" => "ts_object_proto",
                    "array" => "ts_array_proto",
                    "string" => "ts_string_proto",
                    "map" => "ts_map_proto",
                    "set" => "ts_set_proto_obj",
                    "weakmap" => "ts_weakmap_proto",
                    "weakset" => "ts_weakset_proto_obj",
                    "headers" => "ts_headers_proto",
                    "number" => "ts_number_proto",
                    "boolean" => "ts_boolean_proto",
                    "function" => "ts_function_proto",
                    _ => unreachable!("unknown protoobj kind"),
                };
                s.push_str(&ctx.set_val(dst.0, &format!("{}()", acc)));
                return;
            }
            // `errorproto.<kind>`: the shared runtime Error-family prototype object,
            // used as the RHS of an `instanceof` proto-chain check against a built-in
            // Error constructor.
            if let Some(kind) = builtin.strip_prefix("errorproto.") {
                let idx: u32 = kind.parse().unwrap_or(0);
                s.push_str(&ctx.set_val(dst.0, &format!("ts_error_proto({})", idx)));
                return;
            }
            // First-class static builtin function value: box a generated adapter
            // (emitted in the prelude) as a ts_func. Namespace statics (Math.sqrt,
            // ...) take no receiver (takes_this=0); the Object.prototype method
            // values (`objproto.*`) read args[0] as `this`, so .call(thisArg)/.apply
            // inject the receiver there (takes_this=1).
            let tt = if builtin.starts_with("objproto.") {
                1
            } else {
                0
            };
            s.push_str(&ctx.set_val(
                dst.0,
                &format!(
                    "ts_make_fn_t({}, 0, 0, {})",
                    fnval_adapter_name(builtin),
                    tt
                ),
            ));
        }
        Inst::StoreField { obj, field, src, slots, cls } => {
            let addr = inst as *const Inst as usize;
            if let Some(keys) = ctx.layouts.ctor_first.get(&addr) {
                let id = ctx.fresh_label();
                emit_layout_decl(s, id, keys);
                let _ = writeln!(s, "  int _ts_adopt = ts_obj_adopt_layout({}, &_ts_lit_{});", ctx.val(obj.0), id);
            }
            if let Some(&(slot, guarded)) = ctx.layouts.store.get(&addr) {
                if guarded {
                    let _ = writeln!(s, "  if (_ts_adopt) {{ ts_lit_store({}, {}u, {}); }} else {{", ctx.val(obj.0), slot, ctx.val(src.0));
                    emit_store_field_generic(s, obj.0, field.0, src.0, ctx);
                    s.push_str("  }\n");
                } else {
                    let _ = writeln!(s, "  ts_lit_store({}, {}u, {});", ctx.val(obj.0), slot, ctx.val(src.0));
                }
                return;
            }
            let (class, hinted) = receiver_class(ctx, obj.0, *cls, field.0);
            if let Some(c) = class {
                if let Some(off) = struct_direct_offset(c, field.0, ctx.classes) {
                    let cn = struct_name(c);
                    let is_num = numeric_field(c, field.0, ctx.classes);
                    // numeric field stores a raw double (an integer slot an integer, a
                    // non-integer value refused loudly); otherwise a boxed tsv
                    let rhs = if int32_field(c, field.0, ctx.classes) {
                        if ctx.int_local.contains(&src.0) {
                            format!("d{}", src.0)
                        } else {
                            format!("ts_int32_field_value({})", ctx.num(src.0))
                        }
                    } else if is_num {
                        ctx.num(src.0)
                    } else {
                        ctx.val(src.0)
                    };
                    // A receiver that is not a struct of class `c` routes
                    // `this.field = v` through ts_set (see the read above).
                    let obj_name = ctx.vname(obj.0);
                    let slow = ctx.lazy_linked_stmt(&format!("ts_set({}, {}, {})", obj_name, field.0, ctx.val(src.0)));
                    let _ = writeln!(s, "  if ({}) {{ {} }} else {{", receiver_guard(&obj_name, &hinted, c), slow);
                    let _ = writeln!(s, "    (({}*)ts_ptr({}))->{} = {};", cn, obj_name, off, rhs);
                    if !is_num {
                        if barrier_fast_enabled() {
                            // The owner is untagged by the store itself; a value the
                            // emitter knows is no heap reference needs no barrier.
                            if !non_heap_value_expr(&rhs) {
                                let _ = writeln!(s, "    ts_write_barrier_hdr((ts_gc_header*)ts_ptr({}), {});", obj_name, rhs);
                            }
                        } else {
                            let _ = writeln!(s, "    ts_write_barrier({}, {});", obj_name, rhs);
                        }
                    }
                    let _ = writeln!(s, "  }}");
                    return;
                }
                // a class the program dispatches dynamically: the sized entry in line
                if sized_pic_inline_enabled() && prop_pic_enabled() && !ctx.lazy_homes {
                    let pic = ctx.fresh_label();
                    let _ = writeln!(s, "  {{ static ts_prop_ic _ts_pic_{} = TS_PROP_IC_INIT;", pic);
                    if ctx.lazy_frame {
                        let _ = writeln!(s, "  ts_set_sized_pic_inline_lazy({}, {}, {}, &_ts_pic_{}, &F.h, {}); }}", ctx.val(obj.0), field.0, ctx.val(src.0), pic, ctx.frame_nslots);
                    } else {
                        let _ = writeln!(s, "  ts_set_sized_pic_inline({}, {}, {}, &_ts_pic_{}); }}", ctx.val(obj.0), field.0, ctx.val(src.0), pic);
                    }
                    return;
                }
            }
            // Static-slot hint (docs/static_slots_design.md): the probe checks the
            // predicted in-object slot (plain writable data, the object not
            // frozen) and falls to the out-of-line cached store otherwise.
            if *slots != 0 && prop_pic_enabled() && static_slots_enabled() {
                let pic = ctx.fresh_label();
                let _ = writeln!(s, "  {{ static ts_prop_ic _ts_pic_{} = TS_PROP_IC_INIT;", pic);
                let s1 = (slots & 0xFF) - 1;
                let s2 = (slots >> 8) & 0xFF;
                let s3 = (slots >> 16) & 0xFF;
                let homes_set = |try_call: String| -> String {
                    format!(
                        "  if (!{try_call}) {{ {sp}ts_set_linked({o}, {k}, {v}, &_ts_pic_{pic}, &F.h, {n});{rl} }}",
                        try_call = try_call, sp = ctx.spill_now(), rl = ctx.reload_now(),
                        o = ctx.val(obj.0), k = field.0, v = ctx.val(src.0), pic = pic, n = ctx.frame_nslots
                    )
                };
                match (s2, s3, ctx.lazy_frame) {
                    (0, _, true) if ctx.lazy_homes => { let _ = writeln!(s, "{}", homes_set(format!("ts_set_static_try({}, {}, {}u, {}, &_ts_pic_{})", ctx.val(obj.0), field.0, s1, ctx.val(src.0), pic))); }
                    (_, 0, true) if ctx.lazy_homes => { let _ = writeln!(s, "{}", homes_set(format!("ts_set_static2_try({}, {}, {}u, {}u, {}, &_ts_pic_{})", ctx.val(obj.0), field.0, s1, s2 - 1, ctx.val(src.0), pic))); }
                    (_, _, true) if ctx.lazy_homes => { let _ = writeln!(s, "{}", homes_set(format!("ts_set_static3_try({}, {}, {}u, {}u, {}u, {}, &_ts_pic_{})", ctx.val(obj.0), field.0, s1, s2 - 1, s3 - 1, ctx.val(src.0), pic))); }
                    (0, _, false) => { let _ = writeln!(s, "  ts_set_static_inline({}, {}, {}u, {}, &_ts_pic_{});", ctx.val(obj.0), field.0, s1, ctx.val(src.0), pic); }
                    (0, _, true) => { let _ = writeln!(s, "  ts_set_static_inline_lazy({}, {}, {}u, {}, &_ts_pic_{}, &F.h, {});", ctx.val(obj.0), field.0, s1, ctx.val(src.0), pic, ctx.frame_nslots); }
                    (_, 0, false) => { let _ = writeln!(s, "  ts_set_static2_inline({}, {}, {}u, {}u, {}, &_ts_pic_{});", ctx.val(obj.0), field.0, s1, s2 - 1, ctx.val(src.0), pic); }
                    (_, 0, true) => { let _ = writeln!(s, "  ts_set_static2_inline_lazy({}, {}, {}u, {}u, {}, &_ts_pic_{}, &F.h, {});", ctx.val(obj.0), field.0, s1, s2 - 1, ctx.val(src.0), pic, ctx.frame_nslots); }
                    (_, _, false) => { let _ = writeln!(s, "  ts_set_static3_inline({}, {}, {}u, {}u, {}u, {}, &_ts_pic_{});", ctx.val(obj.0), field.0, s1, s2 - 1, s3 - 1, ctx.val(src.0), pic); }
                    (_, _, true) => { let _ = writeln!(s, "  ts_set_static3_inline_lazy({}, {}, {}u, {}u, {}u, {}, &_ts_pic_{}, &F.h, {});", ctx.val(obj.0), field.0, s1, s2 - 1, s3 - 1, ctx.val(src.0), pic, ctx.frame_nslots); }
                }
                let _ = writeln!(s, "  }}");
                return;
            }
            // ctx.val (not a hardcoded v-name): the receiver local may be numeric-
            // unboxed (`const n: any = 5; n.c = 3`) — rebox it so ts_set sees the
            // primitive and throws V8's "Cannot create property ..." TypeError.
            emit_store_field_generic(s, obj.0, field.0, src.0, ctx);
        }
        Inst::LoadElem { dst, arr } => {
            s.push_str(&ctx.set_val(dst.0, &format!("ts_get({}, 0)", ctx.val(arr.0))));
        }
        Inst::StoreElem { arr, src } => {
            let _ = writeln!(s, "  ts_set({}, 0, {});", ctx.val(arr.0), ctx.val(src.0));
        }
        Inst::LoadIndex { dst, arr, index, elem } => {
            if *elem != 0 && !ctx.json_locals.contains(&arr.0) {
                emit_view_load(s, ctx, dst.0, arr.0, index.0, *elem - 1);
                return;
            }
            if ctx.json_locals.contains(&arr.0) {
                if ctx.json_locals.contains(&dst.0) {
                    let _ = writeln!(
                        s,
                        "  j{} = ts_json_dom_index({}, {});",
                        dst.0,
                        ctx.jval(arr.0),
                        ctx.numc(index.0)
                    );
                } else {
                    s.push_str(&ctx.set_val(
                        dst.0,
                        &format!(
                            "ts_json_dom_to_tsv(ts_json_dom_index({}, {}))",
                            ctx.jval(arr.0),
                            ctx.numc(index.0)
                        ),
                    ));
                }
                return;
            }
            // the in-range non-hole element of an array is read in line
            // (TSAOT_INLINE_INDEX=0 keeps the out-of-line reader)
            let inline = inline_index_enabled();
            if index_keys_enabled() {
                // An int64 key goes to the int64 helpers as it is (no uint32
                // cast); any other numeric operand is a double, tested for an
                // index (docs/array_index_keys_design.md).
                let int_key = ctx.unboxed.contains(&index.0) && ctx.int_local.contains(&index.0);
                let (sfx, i) = if int_key { ("", format!("d{}", index.0)) } else { ("_f64", ctx.num(index.0)) };
                let a = ctx.val(arr.0);
                let call = if ctx.lazy_homes {
                    format!(
                        "({{ tsv _lz; if (!{t}{sfx}({a}, {i}, &_lz)) {{ {sp}_lz = ts_array_get_linked{sfx}({a}, {i}, &F.h, {n});{rl} }} _lz; }})",
                        t = if inline { "ts_array_get_inline_try" } else { "ts_array_get_try" },
                        sfx = sfx, a = a, i = i, n = ctx.frame_nslots, sp = ctx.spill_now(), rl = ctx.reload_now()
                    )
                } else if ctx.lazy_frame {
                    format!(
                        "{}{}({}, {}, &F.h, {})",
                        if inline { "ts_array_get_inline_lazy" } else { "ts_array_get_lazy" },
                        sfx, a, i, ctx.frame_nslots
                    )
                } else if inline {
                    format!("ts_array_get_inline{}({}, {})", sfx, a, i)
                } else {
                    format!("ts_array_get_key{}({}, {})", if int_key { "_i64" } else { "_f64" }, a, i)
                };
                s.push_str(&ctx.set_val(dst.0, &call));
                return;
            }
            if ctx.lazy_homes {
                let (a, i) = (ctx.val(arr.0), ctx.num(index.0));
                s.push_str(&ctx.set_val(
                    dst.0,
                    &format!(
                        "({{ tsv _lz; if (!{t}({a}, (uint32_t)({i}), &_lz)) {{ {sp}_lz = ts_array_get_linked({a}, (uint32_t)({i}), &F.h, {n});{rl} }} _lz; }})",
                        t = if inline { "ts_array_get_inline_try" } else { "ts_array_get_try" },
                        a = a, i = i, n = ctx.frame_nslots, sp = ctx.spill_now(), rl = ctx.reload_now()
                    ),
                ));
            } else if ctx.lazy_frame {
                s.push_str(&ctx.set_val(
                    dst.0,
                    &format!(
                        "{}({}, (uint32_t)({}), &F.h, {})",
                        if inline { "ts_array_get_inline_lazy" } else { "ts_array_get_lazy" },
                        ctx.val(arr.0),
                        ctx.num(index.0),
                        ctx.frame_nslots
                    ),
                ));
            } else {
                s.push_str(&ctx.set_val(
                    dst.0,
                    &format!(
                        "{}({}, (uint32_t)({}))",
                        if inline { "ts_array_get_inline" } else { "ts_array_get" },
                        ctx.val(arr.0),
                        ctx.num(index.0)
                    ),
                ));
            }
        }
        Inst::StoreIndex { arr, index, src, elem } => {
            if *elem != 0 && (ctx.unboxed.contains(&src.0) || ctx.int_local.contains(&src.0)) {
                emit_view_store(s, ctx, arr.0, index.0, src.0, *elem - 1);
                return;
            }
            // the dense in-capacity element store is in line
            // (TSAOT_INLINE_INDEX=0 keeps the out-of-line store, as for reads)
            if index_keys_enabled() {
                let int_key = ctx.unboxed.contains(&index.0) && ctx.int_local.contains(&index.0);
                let i = if int_key { format!("d{}", index.0) } else { ctx.num(index.0) };
                let f = match (inline_index_enabled(), int_key) {
                    (true, true) => "ts_array_set_inline",
                    (true, false) => "ts_array_set_inline_f64",
                    (false, true) => "ts_array_set_key_i64",
                    (false, false) => "ts_array_set_key_f64",
                };
                let _ = writeln!(s, "  {}({}, {}, {});", f, ctx.val(arr.0), i, ctx.val(src.0));
                return;
            }
            let _ = writeln!(
                s,
                "  {}({}, (uint32_t)({}), {});",
                if inline_index_enabled() { "ts_array_set_inline" } else { "ts_array_set" },
                ctx.val(arr.0),
                ctx.num(index.0),
                ctx.val(src.0)
            );
        }
        Inst::ArrayLen { dst, arr } => {
            if ctx.json_locals.contains(&arr.0) {
                s.push_str(
                    &ctx.set_num(dst.0, &format!("ts_json_dom_length({})", ctx.jval(arr.0))),
                );
                return;
            }
            s.push_str(&ctx.set_num(dst.0, &format!("ts_array_len_fast({})", ctx.val(arr.0))));
        }
        Inst::StringLen { dst, src } => {
            if ctx.accums.locals.contains(&src.0) {
                s.push_str(&ctx.set_num(dst.0, &format!("ts_sb_len({})", ctx.val(src.0))));
                return;
            }
            if ctx.json_locals.contains(&src.0) {
                s.push_str(
                    &ctx.set_num(dst.0, &format!("ts_json_dom_length({})", ctx.jval(src.0))),
                );
                return;
            }
            if let Some(spec) = ctx.scalar_slice(src.0) {
                let expr = spec
                    .exact_len
                    .map(|n| format!("(ss_fast{} ? {} : ss_len{})", spec.root, n, spec.root))
                    .unwrap_or_else(|| format!("ss_len{}", spec.root));
                s.push_str(&ctx.set_num(dst.0, &expr));
                return;
            }
            s.push_str(&ctx.set_num(dst.0, &format!("ts_str_len_typed({})", ctx.val(src.0))));
        }
        Inst::GenericLen { dst, src } => {
            if ctx.json_locals.contains(&src.0) {
                s.push_str(
                    &ctx.set_num(dst.0, &format!("ts_json_dom_length({})", ctx.jval(src.0))),
                );
                return;
            }
            s.push_str(&ctx.set_num(dst.0, &format!("ts_length({})", ctx.val(src.0))));
        }
        Inst::ArrayPushAll { arr, src } => {
            let _ = writeln!(s, "  ts_array_push_all({}, {});", ctx.val(arr.0), ctx.val(src.0));
        }
        Inst::HasField { dst, obj, field } => {
            s.push_str(&ctx.set_val(
                dst.0,
                &format!("ts_bool(ts_has_prop({}, {}))", ctx.val(obj.0), field.0),
            ));
        }
        Inst::LoadFieldDynamic { dst, obj, key } => {
            if ctx.json_locals.contains(&obj.0) {
                if ctx.json_locals.contains(&dst.0) {
                    let _ = writeln!(
                        s,
                        "  j{} = ts_json_dom_get_dyn({}, {});",
                        dst.0,
                        ctx.jval(obj.0),
                        ctx.val(key.0)
                    );
                } else {
                    s.push_str(&ctx.set_val(
                        dst.0,
                        &format!(
                            "ts_json_dom_to_tsv(ts_json_dom_get_dyn({}, {}))",
                            ctx.jval(obj.0),
                            ctx.val(key.0)
                        ),
                    ));
                }
                return;
            }
            if prop_pic_enabled() {
                let pic = ctx.fresh_label();
                let _ = writeln!(
                    s,
                    "  {{ static ts_prop_ic _ts_pic_{} = TS_PROP_IC_INIT;",
                    pic
                );
                s.push_str(&ctx.set_val(
                    dst.0,
                    &format!(
                        "ts_get_dyn_pic_checked_inline({}, {}, &_ts_pic_{})",
                        ctx.val(obj.0),
                        ctx.val(key.0),
                        pic
                    ),
                ));
                let _ = writeln!(s, "  }}");
            } else {
                s.push_str(&ctx.set_val(
                    dst.0,
                    &format!("ts_get_dyn_checked({}, {})", ctx.val(obj.0), ctx.val(key.0)),
                ));
            }
        }
        Inst::StoreFieldDynamic { obj, key, src } => {
            if prop_pic_enabled() {
                let pic = ctx.fresh_label();
                let _ = writeln!(
                    s,
                    "  {{ static ts_prop_ic _ts_pic_{} = TS_PROP_IC_INIT;",
                    pic
                );
                let _ = writeln!(
                    s,
                    "  ts_set_dyn_pic_inline({}, {}, {}, &_ts_pic_{});",
                    ctx.val(obj.0),
                    ctx.val(key.0),
                    ctx.val(src.0),
                    pic
                );
                let _ = writeln!(s, "  }}");
            } else {
                let _ = writeln!(
                    s,
                    "  ts_set_dyn({}, {}, {});",
                    ctx.val(obj.0),
                    ctx.val(key.0),
                    ctx.val(src.0)
                );
            }
        }
        Inst::HasFieldDynamic { dst, obj, key } => {
            s.push_str(&ctx.set_val(
                dst.0,
                &format!(
                    "ts_bool(ts_has_prop_dyn({}, {}))",
                    ctx.val(obj.0),
                    ctx.val(key.0)
                ),
            ));
        }
        Inst::DeleteField { dst, obj, field, method } => {
            match dst {
                // strict-mode `delete obj.x`: deleting a non-configurable property throws.
                Some(d) => s.push_str(&ctx.set_val(
                    d.0,
                    &format!("ts_bool(ts_delete_prop_strict({}, {}))", ctx.val(obj.0), field.0),
                )),
                None => {
                    let _ = writeln!(s, "  ts_delete_prop_strict({}, {});", ctx.val(obj.0), field.0);
                }
            }
            // Clear the METHOD-space twin too (see escape_ir): a prototype-method
            // store wrote both keys, and the dynamic-dispatch fallback reads the
            // METHOD key when the FIELD key misses. The delete RESULT is the
            // FIELD-side one (V8: true for an existing configurable property).
            if let Some(m) = method {
                let _ = writeln!(
                    s,
                    "  ts_delete_prop_strict({}, TS_KEY_METHOD({}u));",
                    ctx.val(obj.0),
                    m
                );
            }
        }
        Inst::ArraySlice { dst, arr, start } => {
            s.push_str(&ctx.set_val(
                dst.0,
                &format!(
                    "ts_array_slice({}, {}, 0, 0)",
                    ctx.val(arr.0),
                    ctx.num(start.0)
                ),
            ));
        }
        Inst::ObjectRest { dst, src, exclude } => {
            if exclude.is_empty() {
                s.push_str(
                    &ctx.set_val(dst.0, &format!("ts_object_rest({}, 0, 0)", ctx.val(src.0))),
                );
            } else {
                let arr: Vec<String> = exclude.iter().map(|f| format!("{}u", f.0)).collect();
                let _ = writeln!(
                    s,
                    "  {{ static const uint32_t _excl[] = {{{}}};",
                    arr.join(", ")
                );
                s.push_str(&format!(
                    "  {}",
                    ctx.set_val(
                        dst.0,
                        &format!(
                            "ts_object_rest({}, _excl, {})",
                            ctx.val(src.0),
                            exclude.len()
                        )
                    )
                ));
                s.push_str("  }\n");
            }
        }
        Inst::ObjectCopyProps { dst, src } => {
            let _ = writeln!(s, "  ts_object_copy_props({}, {});", ctx.val(dst.0), ctx.val(src.0));
        }
        Inst::ConstructResult { dst, inst, ret } => {
            // new step 4: object return overrides the instance; else the instance.
            s.push_str(&ctx.set_val(
                dst.0,
                &format!(
                    "ts_construct_result({}, {})",
                    ctx.val(inst.0),
                    ctx.val(ret.0)
                ),
            ));
        }
        Inst::ArrayPush { arr, src } => {
            let push_fn = if push_inline_enabled() { "ts_array_push_inline" } else { "ts_array_push" };
            let _ = writeln!(s, "  {}({}, {});", push_fn, ctx.val(arr.0), ctx.val(src.0));
        }
        // up==0: plain break/continue (innermost). up>=1: labeled multi-level jump
        // -> goto the target loop's end (break) / top (continue) label. The Loop
        // emitter pushes (top,end) per loop onto loop_labels in nesting order, so
        // the target is loop_labels[len-1-up].
        Inst::Break { up } | Inst::Continue { up } => {
            let ll = ctx.loop_labels.borrow();
            let (top, end, eh_depth) = ll[ll.len() - 1 - *up as usize];
            let pop_str =
                "ts_eh_pop(); ".repeat(ctx.eh_depth.get().saturating_sub(eh_depth) as usize);
            if *up == 0 {
                let keyword = if matches!(inst, Inst::Break { .. }) {
                    "break"
                } else {
                    "continue"
                };
                let _ = writeln!(s, "  {}{};", pop_str, keyword);
            } else {
                let label = if matches!(inst, Inst::Break { .. }) {
                    end
                } else {
                    top
                };
                let _ = writeln!(s, "  {}goto L{};", pop_str, label);
            }
        }
        Inst::CallSpread {
            dst,
            callee,
            recv,
            arg_specs,
        } => {
            // Build a dynamic argument buffer: singles contribute 1, spreads
            // contribute their array length. recv (if any) is arg 0.
            let callee_ncap = match callee {
                CalleeRef::Direct { func } => callee_capture_count(func.0),
                CalleeRef::Set { funcs } => set_callee_capture_count(funcs),
                _ => 0,
            };
            let mut cell_locals: Vec<u32> = Vec::new();
            let mut arg_specs: Vec<&ArgSpec> = arg_specs.iter().collect();
            while cell_locals.len() < callee_ncap {
                match arg_specs.first() {
                    Some(ArgSpec::Single { local }) => {
                        cell_locals.push(local.0);
                        arg_specs.remove(0);
                    }
                    _ => panic!("spread call to a closure lacks its leading captured cells"),
                }
            }
            assert!(cell_locals.is_empty() || recv.is_none(), "closure spread call with receiver");
            s.push_str("  {\n");
            if !cell_locals.is_empty() {
                let _ = writeln!(s, "    tsv _e[{}];", cell_locals.len());
                for (i, a) in cell_locals.iter().enumerate() {
                    let _ = writeln!(s, "    _e[{}] = {};", i, ctx.val(*a));
                }
            }
            let _ = writeln!(s, "    int _n = {};", if recv.is_some() { 1 } else { 0 });
            for spec in &arg_specs {
                match spec {
                    ArgSpec::Single { .. } => {
                        let _ = writeln!(s, "    _n += 1;");
                    }
                    ArgSpec::Spread { local } => {
                        let _ =
                            writeln!(s, "    _n += (int)ts_array_len_fast({});", ctx.val(local.0));
                    }
                }
            }
            if spread_stack_enabled() {
                s.push_str("    tsv _abuf[16];\n");
                s.push_str("    tsv* _a = _n <= 16 ? _abuf : (tsv*)malloc(sizeof(tsv) * (size_t)_n);\n");
            } else {
                s.push_str("    tsv* _a = (tsv*)malloc(sizeof(tsv) * (_n > 0 ? _n : 1));\n");
            }
            s.push_str("    int _k = 0;\n");
            if let Some(r) = recv {
                let _ = writeln!(s, "    _a[_k++] = {};", ctx.val(r.0));
            }
            for spec in &arg_specs {
                match spec {
                    ArgSpec::Single { local } => {
                        let _ = writeln!(s, "    _a[_k++] = {};", ctx.val(local.0));
                    }
                    ArgSpec::Spread { local } => {
                        let v = ctx.val(local.0);
                        let _ = writeln!(s, "    {{ int _m = (int)ts_array_len_fast({}); for (int _j=0;_j<_m;_j++) _a[_k++] = ts_array_get({}, _j); }}", v, v);
                    }
                }
            }
            if !cell_locals.is_empty() {
                s.push_str("    g_ts_cur_env = _e;\n");
            }
            let call = match callee {
                CalleeRef::Direct { func } => format!("{}(_a, _n)", ctx.fn_name_of(func.0)),
                CalleeRef::Set { funcs } => format!(
                    "{}(_a, _n)",
                    ctx.fn_name_of(funcs.first().map(|f| f.0).unwrap_or(0))
                ),
                CalleeRef::Method {
                    method,
                    method_field,
                    ..
                } => {
                    emit_method_value_lookup(
                        s,
                        "_a[0]",
                        method.0,
                        method_field.map(|f| f.0),
                        ctx.wksym,
                    );
                    format!("ts_call_method(_mv, _a, _n)")
                }
                // A Value callee WITH a receiver (recv present) is a member call
                // `o[k](...)`: _a[0] is the base, bind it as `this` via
                // ts_call_method. Without a receiver it's a free call -> ts_call_value.
                CalleeRef::Value { local } if recv.is_some() => {
                    format!("ts_call_method({}, _a, _n)", ctx.val(local.0))
                }
                CalleeRef::Value { local } => {
                    format!("ts_call_value({}, _a, _n)", ctx.val(local.0))
                }
                CalleeRef::Unknown => "ts_dynamic_method_unsupported()".to_string(),
            };
            match dst {
                Some(d) => {
                    let _ = writeln!(s, "    tsv _r = {};", call);
                    s.push_str(if spread_stack_enabled() { "    if (_a != _abuf) free(_a);\n" } else { "    free(_a);\n" });
                    s.push_str(&ctx.set_val(d.0, "_r"));
                }
                None => {
                    let _ = writeln!(s, "    {};", call);
                    s.push_str(if spread_stack_enabled() { "    if (_a != _abuf) free(_a);\n" } else { "    free(_a);\n" });
                }
            }
            s.push_str("  }\n");
        }
        Inst::Call {
            dst,
            callee,
            recv,
            args,
            ..
        } => {
            let mut argv: Vec<u32> = Vec::new();
            if let Some(r) = recv {
                argv.push(r.0);
            }
            argv.extend(args.iter().map(|a| a.0));
            if let CalleeRef::Direct { func } = callee {
                if let Some(info) = ctx.i64_fast.get(&func.0) {
                    if argv.len() == info.params.len()
                        && argv.iter().all(|a| {
                            ctx.int_local.contains(a) && ctx.numeric_value_local.contains(a)
                        })
                    {
                        let call = format!(
                            "{}({})",
                            ctx.i64_name_of(func.0),
                            argv.iter()
                                .map(|a| format!("d{}", a))
                                .collect::<Vec<_>>()
                                .join(", ")
                        );
                        match dst {
                            Some(d) if ctx.int_local.contains(&d.0) => {
                                let _ = writeln!(s, "  d{} = {};", d.0, call);
                            }
                            Some(d) => {
                                s.push_str(&ctx.set_num(d.0, &format!("(double)({})", call)));
                            }
                            None => {
                                let _ = writeln!(s, "  {};", call);
                            }
                        }
                        return;
                    }
                }
                if let Some(info) = ctx.f64_fast.get(&func.0) {
                    let dst_can_take_double =
                        dst.map(|d| !ctx.int_local.contains(&d.0)).unwrap_or(true);
                    if dst_can_take_double
                        && argv.len() == info.params.len()
                        && argv
                            .iter()
                            .all(|a| ctx.unboxed.contains(a) && ctx.numeric_value_local.contains(a))
                    {
                        let call = format!(
                            "{}({})",
                            ctx.f64_name_of(func.0),
                            argv.iter()
                                .map(|a| {
                                    if ctx.int_local.contains(a) {
                                        format!("((double)d{})", a)
                                    } else {
                                        format!("d{}", a)
                                    }
                                })
                                .collect::<Vec<_>>()
                                .join(", ")
                        );
                        match dst {
                            Some(d) => {
                                s.push_str(&ctx.set_num(d.0, &call));
                            }
                            None => {
                                let _ = writeln!(s, "  {};", call);
                            }
                        }
                        return;
                    }
                }
            }
            if let CalleeRef::Direct { func } = callee {
                if let Some(sig) = ctx.direct_sigs.get(&func.0) {
                    // Direct entry: every parameter in the callee's own
                    // representation, cells first; a missing argument gets the
                    // value the generic prologue would have left in place.
                    let parts: Vec<String> = sig
                        .kinds
                        .iter()
                        .enumerate()
                        .map(|(i, kind)| match argv.get(i) {
                            Some(a) => match kind {
                                ParamKind::Boxed => ctx.val(*a),
                                ParamKind::F64 => ctx.num(*a),
                                ParamKind::I64 => {
                                    if ctx.int_local.contains(a) {
                                        format!("d{}", a)
                                    } else {
                                        format!("(long long)({})", ctx.num(*a))
                                    }
                                }
                            },
                            None => match kind {
                                ParamKind::Boxed => "TS_UNDEFINED".to_string(),
                                ParamKind::F64 => "0.0".to_string(),
                                ParamKind::I64 => "0".to_string(),
                            },
                        })
                        .collect();
                    let call = format!("{}_d({})", ctx.fn_name_of(func.0), parts.join(", "));
                    s.push_str(&ctx.set_call_result(dst, &call, sig.ret));
                    return;
                }
            }
            let callee_ncap = match callee {
                CalleeRef::Direct { func } => callee_capture_count(func.0),
                CalleeRef::Set { funcs } => set_callee_capture_count(funcs),
                _ => 0,
            };
            let ncap = callee_ncap.min(argv.len());
            let (cells, argv) = argv.split_at(ncap);
            if ncap > 0 {
                let _ = writeln!(s, "  {{ tsv _e[{}];", ncap);
                for (i, a) in cells.iter().enumerate() {
                    let _ = writeln!(s, "    _e[{}] = {};", i, ctx.val(*a));
                }
                let _ = writeln!(s, "    tsv _a[{}];", argv.len().max(1));
            } else {
                let _ = writeln!(s, "  {{ tsv _a[{}];", argv.len().max(1));
            }
            for (i, a) in argv.iter().enumerate() {
                let _ = writeln!(s, "    _a[{}] = {};", i, ctx.val(*a));
            }
            if ncap > 0 {
                s.push_str("    g_ts_cur_env = _e;\n");
            }
            if let CalleeRef::Method { recv_class, method, recv_stable: true, method_field } = callee {
                if recv.is_some() {
                    let plan = VT_PLANS.with(|p| p.borrow().get(&(recv_class.0, method.0)).cloned());
                    if let Some(plan) = plan {
                        emit_vtable_call(s, ctx, &plan, argv, dst);
                        emit_method_value_lookup(s, "_a[0]", method.0, method_field.map(|f| f.0), ctx.wksym);
                        let call = format!("ts_call_method(_mv, _a, {})", argv.len());
                        match dst {
                            Some(d) => s.push_str(&ctx.set_val(d.0, &call)),
                            None => {
                                let _ = writeln!(s, "    {};", call);
                            }
                        }
                        s.push_str("    }\n    }\n  }\n");
                        return;
                    }
                }
            }
            if let CalleeRef::Method {
                method,
                method_field: Some(mf),
                ..
            } = callee
            {
                if recv.is_some() && emit_known_method_call(s, ctx, method.0, mf.0, argv, dst) {
                    s.push_str("  }\n");
                    return;
                }
            }
            if let CalleeRef::Value { local } = callee {
                if recv.is_none() && value_call_fast_enabled() {
                    // A call through a function value: the common closure (no
                    // `this` slot, environment ABI or no environment) enters its
                    // generic entry directly with the environment register set,
                    // as ts_call does after its checks; everything else — a
                    // non-function (TypeError), a Proxy, a `this`-taking callee
                    // whose first slot must be injected, a legacy merged-argument
                    // closure — takes ts_call_value.
                    let _ = writeln!(s, "    tsv _fv = {};", ctx.val(local.0));
                    s.push_str("    tsv _r;\n");
                    s.push_str("    { ts_func* _f = ts_is_func(_fv) ? (ts_func*)ts_ptr(_fv) : NULL;\n");
                    let _ = writeln!(
                        s,
                        "      if (_f && !_f->takes_this && (_f->env_abi || !_f->envlen)) {{ g_ts_cur_env = _f->env; _r = ((ts_code)_f->code)(_a, {0}); }} else _r = ts_call_value(_fv, _a, {0}); }}",
                        argv.len()
                    );
                    match dst {
                        Some(d) => s.push_str(&ctx.set_val(d.0, "_r")),
                        None => s.push_str("    (void)_r;\n"),
                    }
                    s.push_str("  }\n");
                    return;
                }
            }
            let call = match callee {
                CalleeRef::Direct { func } => {
                    format!("{}(_a, {})", ctx.fn_name_of(func.0), argv.len())
                }
                CalleeRef::Set { funcs } => format!(
                    "{}(_a, {})",
                    ctx.fn_name_of(funcs.first().map(|f| f.0).unwrap_or(0)),
                    argv.len()
                ),
                // Dynamic method dispatch: receiver demoted to dynamic (via any /
                // prototype mutation / unstable class). Resolve the method through
                // the runtime prototype chain: ts_get(recv, methodKey) yields the
                // FN_TABLE index (stored as a number on the class prototype), then
                // call it. This is the faithful JS prototype-lookup path.
                CalleeRef::Method {
                    recv_class,
                    method,
                    method_field,
                    ..
                } => {
                    // recv is _a[0]; fetch the method value honoring own->prototype
                    // order (own field-key first when known, then prototype method-
                    // key), then invoke via ts_call. Handles object-literal methods,
                    // `{g: fn}` properties, own-field shadowing, and prototype methods.
                    // A receiver the program types as a class instance (a real
                    // class, not the dynamic sentinel) resolves through the runtime's
                    // method cache by class word (docs/pic_sized_inline_design.md,
                    // "The method of a dynamic call"); other receivers take the two
                    // cached reads inside it.
                    let sized_cache = method_sized_cache_enabled()
                        && prop_pic_enabled()
                        && recv.is_some()
                        && recv_class.0 != u32::MAX
                        && ctx.classes.contains_key(&recv_class.0);
                    match (sized_cache, method_field) {
                        (true, Some(mf)) => {
                            let _ = writeln!(s, "    ts_check_method_recv(_a[0], {}u);", mf.0);
                            s.push_str("    static ts_prop_ic _ts_method_field_ic = TS_PROP_IC_INIT;\n");
                            s.push_str("    static ts_prop_ic _ts_method_proto_ic = TS_PROP_IC_INIT;\n");
                            if method_site_ic_enabled() {
                                // the site's own cache of the method (ts_rt.h ts_method_site_ic;
                                // TSAOT_METHOD_SITE_IC=0 keeps the runtime's lookup alone)
                                s.push_str("    static ts_method_site_ic _ts_msic = { 0u, 0u, 0u, 0u, 0 };\n");
                                let _ = writeln!(
                                    s,
                                    "    tsv _mv = ts_method_lookup_sized_ic(_a[0], {}u, {}, &_ts_method_field_ic, &_ts_method_proto_ic, &_ts_msic);",
                                    mf.0,
                                    method_key_str(method.0, ctx.wksym)
                                );
                            } else {
                                let _ = writeln!(
                                    s,
                                    "    tsv _mv = ts_method_lookup_sized(_a[0], {}u, {}, &_ts_method_field_ic, &_ts_method_proto_ic);",
                                    mf.0,
                                    method_key_str(method.0, ctx.wksym)
                                );
                            }
                            let _ = writeln!(s, "    if (!ts_is_callable(_mv)) ts_dynamic_method_missing({}u);", mf.0);
                        }
                        _ => emit_method_value_lookup(
                            s,
                            "_a[0]",
                            method.0,
                            method_field.map(|f| f.0),
                            ctx.wksym,
                        ),
                    }
                    format!("ts_call_method(_mv, _a, {})", argv.len())
                }
                // A Value callee WITH a receiver (recv present) is a member call
                // `o[k](...)`: _a[0] is the base object, bind it as `this` via
                // ts_call_method (mirrors the spread path).
                CalleeRef::Value { local } if recv.is_some() => {
                    format!("ts_call_method({}, _a, {})", ctx.val(local.0), argv.len())
                }
                CalleeRef::Value { local } => {
                    // Call through a first-class function value (closure). ts_call
                    // prepends the closure's captured env to these args.
                    format!("ts_call_value({}, _a, {})", ctx.val(local.0), argv.len())
                }
                // No method name available (truly unknown callee): still a gap.
                CalleeRef::Unknown => "ts_dynamic_method_unsupported()".to_string(),
            };
            match dst {
                Some(d) => s.push_str(&ctx.set_val(d.0, &call)),
                None => {
                    let _ = writeln!(s, "    {};", call);
                }
            }
            s.push_str("  }\n");
        }
        Inst::Return { src } => {
            // a string accumulator becomes an ordinary string on its way out
            if let Some(v) = src {
                if ctx.accums.locals.contains(&v.0) {
                    s.push_str(&ctx.set_val(v.0, &format!("ts_sb_finish({})", ctx.val(v.0))));
                }
            }
            // Leaving the function from inside `try` bodies: pop every handler
            // pushed by this function first (the frozen emitter forgot this, so a
            // later throw landed in the dead frame).
            let live = ctx.eh_depth.get();
            if live > 0 && eh_return_pop_enabled() {
                let _ = writeln!(s, "  {}", "ts_eh_pop(); ".repeat(live as usize).trim_end());
            }
            let cleanup = ctx.root_cleanup();
            if !cleanup.is_empty() {
                let _ = writeln!(s, "  {}", cleanup);
            }
            if ctx.i64_mode {
                match src {
                    Some(v) if ctx.int_local.contains(&v.0) => {
                        let _ = writeln!(s, "  return d{};", v.0);
                    }
                    Some(v) if ctx.unboxed.contains(&v.0) => {
                        let _ = writeln!(s, "  return (long long)d{};", v.0);
                    }
                    Some(v) => {
                        let _ = writeln!(s, "  return (long long)ts_to_num({});", ctx.vname(v.0));
                    }
                    None => s.push_str("  return 0;\n"),
                }
            } else if ctx.f64_mode {
                match src {
                    Some(v) if ctx.int_local.contains(&v.0) => {
                        let _ = writeln!(s, "  return (double)d{};", v.0);
                    }
                    Some(v) if ctx.unboxed.contains(&v.0) => {
                        let _ = writeln!(s, "  return d{};", v.0);
                    }
                    Some(v) => {
                        let _ = writeln!(s, "  return ts_to_num({});", ctx.vname(v.0));
                    }
                    None => s.push_str("  return 0.0;\n"),
                }
            } else if ctx.ret_kind != RetKind::Boxed {
                // A direct entry returning raw: the value is read in whatever
                // representation the local has (the classification decided the
                // kind from the same body, but the read is robust either way).
                let expr = match (ctx.ret_kind, src) {
                    (RetKind::Bool, Some(v)) => {
                        if ctx.unboxed.contains(&v.0) {
                            format!("(d{} != 0)", v.0)
                        } else {
                            format!("ts_truthy_fast({})", ctx.vname(v.0))
                        }
                    }
                    (RetKind::I64, Some(v)) => {
                        if ctx.int_local.contains(&v.0) {
                            format!("d{}", v.0)
                        } else {
                            format!("(long long)({})", ctx.num(v.0))
                        }
                    }
                    (RetKind::F64, Some(v)) => ctx.num(v.0),
                    (_, None) => "0".to_string(),
                    (RetKind::Boxed, _) => unreachable!("boxed return kind in the typed arm"),
                };
                if ctx.json_roots.is_empty() {
                    let _ = writeln!(s, "  return {};", expr);
                } else {
                    let cty = match ctx.ret_kind {
                        RetKind::F64 => "double",
                        RetKind::I64 => "long long",
                        _ => "int",
                    };
                    let _ = writeln!(s, "  {} _ret = {};", cty, expr);
                    emit_json_cleanup(s, ctx);
                    s.push_str("  return _ret;\n");
                }
            } else {
                match src {
                    Some(v) => {
                        let rv = ctx.val(v.0);
                        if ctx.json_roots.is_empty() {
                            let _ = writeln!(s, "  return {};", rv);
                        } else {
                            let _ = writeln!(s, "  tsv _ret = {};", rv);
                            emit_json_cleanup(s, ctx);
                            s.push_str("  return _ret;\n");
                        }
                    }
                    None => {
                        emit_json_cleanup(s, ctx);
                        s.push_str("  return TS_UNDEFINED;\n");
                    }
                }
            }
        }
        Inst::Await { dst, .. } => {
            if let Some(d) = dst {
                s.push_str(&ctx.set_val(d.0, "TS_UNDEFINED"));
            }
        }
        Inst::Yield { dst, .. } => {
            // Yield only occurs inside generators (emit_generator_function handles
            // it); defensive no-op elsewhere.
            if let Some(d) = dst {
                s.push_str(&ctx.set_val(d.0, "TS_UNDEFINED"));
            }
        }
        Inst::TryCatch {
            try_body,
            catch_var,
            catch_body,
            finally_body,
        } => {
            // finally + abrupt exit (return/break/continue through finally) needs the
            // completion-record lowering; otherwise the simple structured emit works.
            if !finally_body.is_empty() {
                emit_plain_finally(s, try_body, catch_var, catch_body, finally_body, ctx);
                return;
            }
            // try/catch/finally via setjmp/longjmp. The handler snapshots the GC
            // root depth so an unwind restores it (a longjmp skips the intervening
            // ts_gc_unroot calls).
            let base_eh_depth = ctx.eh_depth.get();
            s.push_str("  {\n");
            s.push_str("    ts_handler* _h = ts_eh_push();\n");
            let _ = writeln!(s, "    if ({}(_h->buf) == 0) {{", exception_setjmp_name());
            ctx.eh_depth.set(base_eh_depth + 1);
            emit_seq(s, try_body, ctx, PathEdge::TryBody);
            s.push_str("      ts_eh_pop();\n");
            ctx.eh_depth.set(base_eh_depth);
            emit_seq(s, finally_body, ctx, PathEdge::FinallyBody);
            s.push_str("    } else {\n");
            s.push_str("      ts_gc_set_root_depth(_h->gc_root_len);\n");
            if frame_roots_enabled() {
                s.push_str("      ts_frame_restore(_h->frame_top);\n");
            }
            s.push_str("      ts_eh_pop();\n");
            if let Some(cv) = catch_var {
                s.push_str(&ctx.set_val(cv.0, "ts_current_exception()"));
            }
            ctx.eh_depth.set(base_eh_depth);
            emit_seq(s, catch_body, ctx, PathEdge::CatchBody);
            emit_seq(s, finally_body, ctx, PathEdge::FinallyBody);
            s.push_str("    }\n");
            s.push_str("  }\n");
            ctx.eh_depth.set(base_eh_depth);
        }
        Inst::Throw { src } => {
            // Raise an exception: unwinds to the nearest enclosing catch via
            // longjmp (or aborts loudly if uncaught). Previously this just
            // `return`ed the value — a silent miscompile turning throw into a
            // normal return.
            let _ = writeln!(s, "  ts_throw({});", ctx.val(src.0));
        }
        Inst::StoreGlobal { gref, src } => {
            let _ = writeln!(s, "  GLOBALS[{}] = {};", gref.0, ctx.val(src.0));
        }
        Inst::LoadGlobal { dst, gref } => {
            s.push_str(&ctx.set_val(dst.0, &format!("GLOBALS[{}]", gref.0)));
        }
        Inst::Const { dst, value } => {
            match value {
                ConstVal::Num { value } => {
                    if ctx.int_local.contains(&dst.0) {
                        s.push_str(&format!("  d{} = {};\n", dst.0, *value as i64));
                    } else {
                        s.push_str(&ctx.set_num(dst.0, &format!("{:?}", value)));
                    }
                }
                ConstVal::Bool { value } => {
                    if ctx.unboxed.contains(&dst.0) {
                        s.push_str(&ctx.set_num(dst.0, if *value { "1" } else { "0" }));
                    } else {
                        s.push_str(&ctx.set_val(
                            dst.0,
                            &format!("ts_bool({})", if *value { 1 } else { 0 }),
                        ));
                    }
                }
                ConstVal::Str { value } => {
                    if ctx.typeof_fusion.skip.contains(&dst.0) {
                        return;
                    }
                    let id = ctx
                        .static_strings
                        .get(str_units(value).as_slice())
                        .copied()
                        .expect("static string literal collected before codegen");
                    s.push_str(&ctx.set_val(dst.0, &format!("ts_str_v(&TS_STRLIT_{})", id)));
                }
                ConstVal::Str16 { units } => {
                    let id = ctx
                        .static_strings
                        .get(units.as_slice())
                        .copied()
                        .expect("static string literal collected before codegen");
                    s.push_str(&ctx.set_val(dst.0, &format!("ts_str_v(&TS_STRLIT_{})", id)));
                }
                ConstVal::Undef => {
                    s.push_str(&ctx.set_val(dst.0, "TS_UNDEFINED"));
                }
                ConstVal::Null => {
                    s.push_str(&ctx.set_val(dst.0, "TS_NULL"));
                }
                ConstVal::NaN => {
                    s.push_str(&ctx.set_num(dst.0, "(0.0/0.0)"));
                }
                ConstVal::PosInf => {
                    s.push_str(&ctx.set_num(dst.0, "(1.0/0.0)"));
                }
                ConstVal::NegInf => {
                    s.push_str(&ctx.set_num(dst.0, "(-1.0/0.0)"));
                }
                // The `-0` / `-0.0` literal: a genuine double -0.0 (NegZero is never
                // an int local — infer_int_locals only marks Num/Bool int-eligible —
                // so the sign bit survives, unlike (long long)(-0.0)==0).
                ConstVal::NegZero => {
                    s.push_str(&ctx.set_num(dst.0, "(-0.0)"));
                }
            }
        }
        Inst::BinOp { dst, op, lhs, rhs } => {
            if let Some(&(l, e)) = ctx.accums.temps.get(&dst.0) {
                // the append writes the accumulator's buffer; the temporary
                // holds the same builder for the copy back (a path that
                // emits this `+` itself leaves an ordinary string, which the
                // ts_sb_* functions accept as well)
                debug_assert!(op == "+" && lhs.0 == l && rhs.0 == e);
                s.push_str(&ctx.set_val(dst.0, &format!("ts_sb_append({}, {})", ctx.val(l), ctx.val(e))));
                return;
            }
            // integer fast path: both operands int-typed and op int-closed
            let both_int = ctx.int_local.contains(&lhs.0) && ctx.int_local.contains(&rhs.0);
            let dst_int = ctx.int_local.contains(&dst.0);
            let is_cmp_fast = matches!(
                op.as_str(),
                "<" | "<=" | ">" | ">=" | "==" | "!=" | "===" | "!=="
            );
            let is_i64_arith_fast = dst_int && matches!(op.as_str(), "+" | "-" | "*");
            if both_int && (is_cmp_fast || is_i64_arith_fast) {
                let (l, r) = (format!("d{}", lhs.0), format!("d{}", rhs.0));
                let cop = match op.as_str() {
                    "===" => "==",
                    "!==" => "!=",
                    o => o,
                };
                let expr = format!("({} {} {})", l, cop, r);
                let is_cmp = is_cmp_fast;
                if ctx.int_local.contains(&dst.0) {
                    s.push_str(&format!("  d{} = {};\n", dst.0, expr));
                } else if is_cmp {
                    s.push_str(&ctx.set_val(dst.0, &format!("ts_bool({})", expr)));
                } else {
                    s.push_str(&ctx.set_num(dst.0, &expr));
                }
                return;
            }
            if both_int && dst_int && matches!(op.as_str(), "&" | "|" | "^" | "<<" | ">>" | ">>>") {
                let tmp = format!("_bw{}", dst.0);
                match op.as_str() {
                    "&" | "|" | "^" => {
                        let cop = op.as_str();
                        let _ = writeln!(
                            s,
                            "  {{ uint32_t {t} = ((uint32_t)d{l} {op} (uint32_t)d{r}); d{d} = {sx}; }}",
                            t = tmp,
                            sx = sext32_expr(&tmp),
                            l = lhs.0,
                            op = cop,
                            r = rhs.0,
                            d = dst.0
                        );
                    }
                    "<<" => {
                        let _ = writeln!(
                            s,
                            "  {{ uint32_t {t} = ((uint32_t)d{l}) << ((uint32_t)d{r} & 31u); d{d} = {sx}; }}",
                            t = tmp,
                            sx = sext32_expr(&tmp),
                            l = lhs.0,
                            r = rhs.0,
                            d = dst.0
                        );
                    }
                    ">>" => {
                        let _ = writeln!(
                            s,
                            "  {{ uint32_t {t}l = (uint32_t)d{l}; uint32_t {t}s = (uint32_t)d{r} & 31u; uint32_t {t} = ({t}l & 0x80000000u) ? ~(~{t}l >> {t}s) : ({t}l >> {t}s); d{d} = {sx}; }}",
                            t = tmp,
                            sx = sext32_expr(&tmp),
                            l = lhs.0,
                            r = rhs.0,
                            d = dst.0
                        );
                    }
                    ">>>" => {
                        let _ = writeln!(
                            s,
                            "  {{ uint32_t {t} = ((uint32_t)d{l}) >> ((uint32_t)d{r} & 31u); d{d} = (long long){t}; }}",
                            t = tmp,
                            l = lhs.0,
                            r = rhs.0,
                            d = dst.0
                        );
                    }
                    _ => unreachable!(),
                }
                return;
            }
            // safe integer modulo: `intLocal % nonzeroIntConst` — divisor proven
            // nonzero so no FPE, and the result is integer. (JS `x % 0` is NaN and
            // dynamic `x % y` fall through to fmod below.)
            if op == "%" && both_int && ctx.nonzero_int_const.contains(&rhs.0) {
                if dst_int {
                    if let Some(residue) = ctx.loop_mod_residue(lhs.0, rhs.0) {
                        let _ = writeln!(s, "  d{} = {};", dst.0, residue.var);
                        return;
                    }
                }
                if dst_int {
                    if let Some(&divisor) = ctx.int_const.get(&rhs.0) {
                        if divisor > 0 && ctx.nonnegative_int.contains(&lhs.0) {
                            let fast_bound = (divisor as i128) * 2;
                            if fast_bound <= i64::MAX as i128 {
                                let tmp = format!("_mr{}", dst.0);
                                let _ = writeln!(
                                    s,
                                    "  {{ long long {t} = d{l}; d{d} = ({t} < {bound}LL ? ({t} >= {div}LL ? {t} - {div}LL : {t}) : ({t} % {div}LL)); }}",
                                    t = tmp,
                                    l = lhs.0,
                                    d = dst.0,
                                    bound = fast_bound,
                                    div = divisor
                                );
                                return;
                            }
                        }
                    }
                }
                if dst_int {
                    let expr = format!("(d{} % d{})", lhs.0, rhs.0);
                    s.push_str(&format!("  d{} = {};\n", dst.0, expr));
                } else {
                    let tmp = format!("_mr{}", dst.0);
                    let _ = writeln!(s,
                        "  {{ long long {t}i = (d{l} % d{r}); double {t} = ({t}i == 0 && d{l} < 0) ? -0.0 : (double){t}i;",
                        t = tmp, l = lhs.0, r = rhs.0);
                    s.push_str(&ctx.set_num(dst.0, &tmp));
                    s.push_str("  }\n");
                }
                return;
            }
            // `nonnegativeInt % nonzeroInt`: range/summary-proven divisor, so C `%`
            // cannot trap. The lhs is nonnegative by the destination's int fact, so
            // JS negative-zero remainder is impossible on this path.
            if op == "%" && both_int && dst_int && ctx.nonzero_int.contains(&rhs.0) {
                let expr = format!("(d{} % d{})", lhs.0, rhs.0);
                s.push_str(&format!("  d{} = {};\n", dst.0, expr));
                return;
            }
            // `x % nonzeroIntConst` where x is a double (not provably int): JS `%`
            // is fmod, but fmod is a non-inlinable libcall and dominates hot loops.
            // Emit an inline integral fast-path: when x is finite and integral
            // (x == (long long)x), use trap-free integer `%` (divisor is a known
            // nonzero int); else fall back to fmod for exact float/NaN/Inf semantics.
            if op == "%" && ctx.nonzero_int_const.contains(&rhs.0) {
                // numc (ToNumber) not num (ts_to_num): a boxed string/object operand
                // must coerce (ToPrimitive/parse), matching the general `%` path below
                // and the other bitwise/arith ops. Unboxed operands render `d{id}` for
                // both, so the hot `x % C` loop path is unchanged.
                let (l, r) = (ctx.numc_double(lhs.0), ctx.numc_double(rhs.0));
                let tmp = format!("_md{}", dst.0);
                s.push_str(&format!(
                    "  double {t} = (double)({l}); double {t}b = (double)({r}); if (isfinite({t}) && {t} == (double)(long long){t}) {{ long long {t}i = ((long long){t} % (long long){t}b); {t} = ({t}i == 0 && (signbit({t}) || {t} < 0.0)) ? -0.0 : (double){t}i; }} else {{ {t} = fmod({t}, {t}b); }}\n",
                    t = tmp, l = l, r = r));
                if ctx.int_local.contains(&dst.0) {
                    s.push_str(&format!("  d{} = (long long){};\n", dst.0, tmp));
                } else {
                    s.push_str(&ctx.set_num(dst.0, &tmp));
                }
                return;
            }
            let (l, r) = (ctx.numc_double(lhs.0), ctx.numc_double(rhs.0));
            let both_unboxed = ctx.unboxed.contains(&lhs.0) && ctx.unboxed.contains(&rhs.0);
            let expr = match op.as_str() {
                "+" => {
                    if ctx.unboxed.contains(&lhs.0) && ctx.unboxed.contains(&rhs.0) {
                        format!("({} + {})", l, r)
                    } else if prim_add_enabled()
                        && ctx.prim_kind.contains(&lhs.0)
                        && ctx.prim_kind.contains(&rhs.0)
                        && !ctx.json_locals.contains(&lhs.0)
                        && !ctx.json_locals.contains(&rhs.0)
                    {
                        format!("({} + {})", l, r)
                    } else if ctx.json_locals.contains(&lhs.0) && ctx.json_locals.contains(&rhs.0) {
                        s.push_str(
                            &ctx.set_val(
                                dst.0,
                                &format!("ts_json_dom_add(j{}, j{})", lhs.0, rhs.0),
                            ),
                        );
                        return;
                    } else if ctx.json_locals.contains(&lhs.0) {
                        s.push_str(&ctx.set_val(
                            dst.0,
                            &format!("ts_json_dom_add_left(j{}, {})", lhs.0, ctx.val(rhs.0)),
                        ));
                        return;
                    } else if ctx.json_locals.contains(&rhs.0) {
                        s.push_str(&ctx.set_val(
                            dst.0,
                            &format!("ts_json_dom_add_right({}, j{})", ctx.val(lhs.0), rhs.0),
                        ));
                        return;
                    } else {
                        s.push_str(&ctx.set_val(
                            dst.0,
                            &format!("ts_add({}, {})", ctx.val(lhs.0), ctx.val(rhs.0)),
                        ));
                        return;
                    }
                }
                "-" => format!("({} - {})", l, r),
                "*" => format!("({} * {})", l, r),
                // JS `/` is always floating-point division (1/0 === Infinity,
                // 0/0 === NaN); cast to double so we never emit a trapping
                // integer divide when operands happen to be int-typed.
                "/" => format!("((double)({}) / (double)({}))", l, r),
                // JS `%` is fmod on doubles (x % 0 === NaN), not C integer %,
                // which would trap. Use fmod for correct, trap-free semantics.
                "%" => format!("fmod((double)({}), (double)({}))", l, r),
                // Relational: numeric fast path when both operands are unboxed
                // numbers; otherwise the runtime handles string-string (lexico-
                // graphic) and mixed string/number/object coercion per spec.
                "<" => {
                    if both_unboxed {
                        format!("({} < {})", l, r)
                    } else {
                        format!("ts_relational({}, {}, 0)", ctx.val(lhs.0), ctx.val(rhs.0))
                    }
                }
                "<=" => {
                    if both_unboxed {
                        format!("({} <= {})", l, r)
                    } else {
                        format!("ts_relational({}, {}, 1)", ctx.val(lhs.0), ctx.val(rhs.0))
                    }
                }
                ">" => {
                    if both_unboxed {
                        format!("({} > {})", l, r)
                    } else {
                        format!("ts_relational({}, {}, 2)", ctx.val(lhs.0), ctx.val(rhs.0))
                    }
                }
                ">=" => {
                    if both_unboxed {
                        format!("({} >= {})", l, r)
                    } else {
                        format!("ts_relational({}, {}, 3)", ctx.val(lhs.0), ctx.val(rhs.0))
                    }
                }
                "===" => {
                    if let Some((x, lit, _)) = ctx.typeof_fusion.fused.get(&(dst.0, lhs.0, rhs.0)) {
                        typeof_test_expr(lit, &ctx.val(*x))
                    } else if both_unboxed {
                        format!("({} == {})", l, r)
                    } else if let Some((x, t)) = ctx.tag_eq_operands(lhs.0, rhs.0) {
                        // undefined/null/booleans have one encoding each; a boxed
                        // number never carries one (ts_num canonicalizes NaN)
                        format!("({} == {})", ctx.val(x), t)
                    } else if let Some((x, lit, len)) = ctx.str_eq_operands(lhs.0, rhs.0) {
                        format!("ts_eq_strlit({}, {}, {}u)", ctx.val(x), lit, len)
                    } else if let Some((x, n)) = ctx.num_eq_operands(lhs.0, rhs.0) {
                        format!("ts_eq_num({}, {})", ctx.val(x), n)
                    } else if ctx.ref_eq_operands(lhs.0, rhs.0) {
                        // two references (or null/undefined): one encoding each
                        format!("({} == {})", ctx.val(lhs.0), ctx.val(rhs.0))
                    } else {
                        format!("ts_strict_eq({}, {})", ctx.val(lhs.0), ctx.val(rhs.0))
                    }
                }
                "==" => {
                    if both_unboxed {
                        format!("({} == {})", l, r)
                    } else if let Some((x, t)) = ctx
                        .tag_eq_operands(lhs.0, rhs.0)
                        .filter(|(_, t)| *t == "TS_UNDEFINED" || *t == "TS_NULL")
                    {
                        let _ = t;
                        format!("ts_is_nullish_fast({})", ctx.val(x))
                    } else {
                        format!("ts_loose_eq({}, {})", ctx.val(lhs.0), ctx.val(rhs.0))
                    }
                }
                "!==" => {
                    if let Some((x, lit, _)) = ctx.typeof_fusion.fused.get(&(dst.0, lhs.0, rhs.0)) {
                        format!("(!{})", typeof_test_expr(lit, &ctx.val(*x)))
                    } else if both_unboxed {
                        format!("({} != {})", l, r)
                    } else if let Some((x, t)) = ctx.tag_eq_operands(lhs.0, rhs.0) {
                        format!("({} != {})", ctx.val(x), t)
                    } else if let Some((x, lit, len)) = ctx.str_eq_operands(lhs.0, rhs.0) {
                        format!("(!ts_eq_strlit({}, {}, {}u))", ctx.val(x), lit, len)
                    } else if let Some((x, n)) = ctx.num_eq_operands(lhs.0, rhs.0) {
                        format!("(!ts_eq_num({}, {}))", ctx.val(x), n)
                    } else if ctx.ref_eq_operands(lhs.0, rhs.0) {
                        format!("({} != {})", ctx.val(lhs.0), ctx.val(rhs.0))
                    } else {
                        format!("(!ts_strict_eq({}, {}))", ctx.val(lhs.0), ctx.val(rhs.0))
                    }
                }
                "!=" => {
                    if both_unboxed {
                        format!("({} != {})", l, r)
                    } else if let Some((x, t)) = ctx
                        .tag_eq_operands(lhs.0, rhs.0)
                        .filter(|(_, t)| *t == "TS_UNDEFINED" || *t == "TS_NULL")
                    {
                        let _ = t;
                        format!("(!ts_is_nullish_fast({}))", ctx.val(x))
                    } else {
                        format!("(!ts_loose_eq({}, {}))", ctx.val(lhs.0), ctx.val(rhs.0))
                    }
                }
                // JS bitwise ops: operands -> ToInt32, result is a 32-bit integer
                // (signed for & | ^ << >>, unsigned for >>>). Cast through int32_t /
                // uint32_t to get the wrap-around and sign semantics V8 produces.
                "&" => format!(
                    "((double)((int32_t){} & (int32_t){}))",
                    ctx.bitwise_operand(lhs.0), ctx.bitwise_operand(rhs.0)
                ),
                "|" => format!(
                    "((double)((int32_t){} | (int32_t){}))",
                    ctx.bitwise_operand(lhs.0), ctx.bitwise_operand(rhs.0)
                ),
                "^" => format!(
                    "((double)((int32_t){} ^ (int32_t){}))",
                    ctx.bitwise_operand(lhs.0), ctx.bitwise_operand(rhs.0)
                ),
                "<<" => format!(
                    "((double)((int32_t)({} << {})))",
                    ctx.bitwise_operand(lhs.0), ctx.shift_count(rhs.0)
                ),
                ">>" => format!(
                    "((double)((int32_t){} >> {}))",
                    ctx.bitwise_operand(lhs.0), ctx.shift_count(rhs.0)
                ),
                ">>>" => format!(
                    "((double)((uint32_t){} >> {}))",
                    ctx.bitwise_operand(lhs.0), ctx.shift_count(rhs.0)
                ),
                "**" => format!("pow({}, {})", l, r),
                _ => "0".to_string(),
            };
            // comparison/equality results are booleans: when stored boxed, box as
            // a JS boolean (ts_bool) so `console.log(a < b)` prints true/false, not
            // 1/0. Unboxed int destinations keep the raw 0/1.
            let is_cmp = matches!(
                op.as_str(),
                "<" | "<=" | ">" | ">=" | "==" | "!=" | "===" | "!=="
            );
            if is_cmp && !ctx.unboxed.contains(&dst.0) {
                s.push_str(&ctx.set_val(dst.0, &format!("ts_bool({})", expr)));
            } else {
                s.push_str(&ctx.set_num(dst.0, &expr));
            }
        }
        Inst::UnOp { dst, op, operand } => {
            match op.as_str() {
                "typeof" => {
                    if !ctx.typeof_fusion.skip.contains(&dst.0) {
                        s.push_str(&ctx.set_val(dst.0, &format!("ts_typeof({})", ctx.val(operand.0))));
                    }
                }
                "nullish" => {
                    s.push_str(&ctx.set_num(
                        dst.0,
                        &format!("ts_is_nullish_fast({})", ctx.val(operand.0)),
                    ));
                }
                "isundef" => {
                    s.push_str(&ctx.set_num(
                        dst.0,
                        &format!("ts_is_undefined_fast({})", ctx.val(operand.0)),
                    ));
                }
                _ => {
                    if op == "!" {
                        // logical not yields a boolean: keep raw 0/1 if unboxed, else ts_bool.
                        let expr = format!("(!{})", ctx.truthy(operand.0));
                        if ctx.unboxed.contains(&dst.0) {
                            s.push_str(&ctx.set_num(dst.0, &expr));
                        } else {
                            s.push_str(&ctx.set_val(dst.0, &format!("ts_bool({})", expr)));
                        }
                    } else {
                        let expr = match op.as_str() {
                            "-" => format!("(-{})", ctx.numc_double(operand.0)),
                            // `~x`: ToInt32(ToNumber(x)) then bitwise complement; result
                            // is int32. Use numc (ToNumber: parses strings, bool->0/1,
                            // null->0) not num (ts_to_num gives NaN for non-numbers ->
                            // ToInt32(NaN)=0). Matches the binary bitwise ops. Unboxed
                            // operands render `d{id}` for both, so hot paths are unchanged.
                            "~" => {
                                if ctx.int32_use.contains(&operand.0) {
                                    format!("((double)(~(int32_t)d{}))", operand.0)
                                } else {
                                    format!("((double)(~ts_to_int32({})))", ctx.numc(operand.0))
                                }
                            }
                            _ => "0".to_string(),
                        };
                        s.push_str(&ctx.set_num(dst.0, &expr));
                    }
                }
            }
        }
        Inst::Print { src } => {
            let _ = writeln!(s, "  ts_print({});", ctx.val(src.0));
        }
        Inst::Loop {
            cond,
            cond_body,
            body,
        } => {
            let (string_metric_loop, string_materialization_loop) = {
                let path = ctx.current_loop_path();
                (
                    ctx.string_metric_plan
                        .and_then(|plan| plan.loops.get(&path)),
                    ctx.string_materialization_plan
                        .and_then(|plan| plan.loops.get(&path)),
                )
            };
            // Emit with explicit top/end labels and register them on the loop stack
            // so a break/continue that crosses a finally (in emit_plain_finally) can
            // target this loop. C `break`/`continue` still work for direct exits.
            let top = ctx.fresh_label();
            let end = ctx.fresh_label();
            let residues = loop_mod_residue_candidates(cond_body, body, ctx, top);
            let mut residue_map: BTreeMap<(u32, u32), LoopModResidue> = BTreeMap::new();
            for r in &residues {
                let _ = writeln!(
                    s,
                    "  long long {v} = d{ind} % {div}LL; if ({v} < 0) {v} += {div}LL;",
                    v = r.var,
                    ind = r.ind,
                    div = r.divisor
                );
                residue_map.insert((r.ind, r.rhs), r.clone());
            }
            if residues.is_empty() {
                if try_emit_fused_dynamic_search_select_loop(
                    s, *cond, cond_body, body, ctx, top, end,
                )
                .is_some()
                {
                    return;
                }
                if let Some(plan) = string_materialization_loop {
                    if try_emit_planned_string_materialization_loop(
                        s, *cond, cond_body, body, ctx, top, plan,
                    )
                    .is_some()
                    {
                        return;
                    }
                }
                if try_emit_fused_dynamic_replace_escape_select_loop(
                    s, *cond, cond_body, body, ctx, top, end,
                )
                .is_some()
                {
                    return;
                }
                if try_emit_fused_dynamic_split_join_escape_select_loop(
                    s, *cond, cond_body, body, ctx, top, end,
                )
                .is_some()
                {
                    return;
                }
                if try_emit_fused_polymorphic_pattern_search_loop(
                    s, *cond, cond_body, body, ctx, top, end,
                )
                .is_some()
                {
                    return;
                }
                if try_emit_fused_polymorphic_pattern_replace_loop(
                    s, *cond, cond_body, body, ctx, top,
                )
                .is_some()
                {
                    return;
                }
                if try_emit_fused_polymorphic_pattern_split_join_loop(
                    s, *cond, cond_body, body, ctx, top,
                )
                .is_some()
                {
                    return;
                }
                if try_emit_fused_masked_string_metric_loop(s, *cond, cond_body, body, ctx, top)
                    .is_some()
                {
                    return;
                }
                if try_emit_fused_dynamic_pattern_search_loop(s, *cond, cond_body, body, ctx, top)
                    .is_some()
                {
                    return;
                }
                if try_emit_fused_dynamic_replace_metrics_loop(s, *cond, cond_body, body, ctx, top)
                    .is_some()
                {
                    return;
                }
                if try_emit_fused_dynamic_split_join_loop(s, *cond, cond_body, body, ctx, top)
                    .is_some()
                {
                    return;
                }
                if let Some(plan) = string_metric_loop {
                    if try_emit_planned_string_metric_loop(
                        s, *cond, cond_body, body, ctx, top, plan,
                    )
                    .is_some()
                    {
                        return;
                    }
                }
                if try_emit_fused_case_trim_escape_loop(s, *cond, cond_body, body, ctx, top)
                    .is_some()
                {
                    return;
                }
                if try_emit_fused_case_trim_loop(s, *cond, cond_body, body, ctx, top).is_some() {
                    return;
                }
                if try_emit_fused_replace_escape_loop(s, *cond, cond_body, body, ctx, top).is_some()
                {
                    return;
                }
                if try_emit_fused_replace_metrics_loop(s, *cond, cond_body, body, ctx, top)
                    .is_some()
                {
                    return;
                }
                if try_emit_fused_split_join_escape_loop(s, *cond, cond_body, body, ctx, top)
                    .is_some()
                {
                    return;
                }
                if try_emit_fused_split_join_loop(s, *cond, cond_body, body, ctx, top).is_some() {
                    return;
                }
                if try_emit_fused_concat_chain_metric_loop(s, *cond, cond_body, body, ctx).is_some()
                {
                    return;
                }
                if try_emit_fused_string_concat_loop(s, *cond, cond_body, body, ctx, top).is_some()
                {
                    return;
                }
                if try_emit_fused_string_search_loop(s, *cond, cond_body, body, ctx, top).is_some()
                {
                    return;
                }
                if let Some(base) = fused_charcode_scan_loop_base(body) {
                    let view_var = format!("_fcv{}", top);
                    let _ = writeln!(
                        s,
                        "  ts_strview {} = ts_str_view_typed({});",
                        view_var,
                        ctx.val(base)
                    );
                    if let Some(precond) =
                        fused_charcode_scan_loop_precondition(body, ctx, &view_var)
                    {
                        let _ = writeln!(s, "  if ({}) {{", precond);
                        s.push_str("  for (;;) {\n");
                        for i in cond_body {
                            emit_inst(s, i, ctx);
                        }
                        let _ = writeln!(s, "    if (!{}) break;", ctx.truthy(cond.0));
                        if try_emit_fused_charcode_scan_loop_body(s, body, ctx, &view_var).is_none()
                        {
                            for i in body {
                                emit_inst(s, i, ctx);
                            }
                        }
                        s.push_str("  }\n");
                        s.push_str("  } else {\n");
                        s.push_str("  for (;;) {\n");
                        for i in cond_body {
                            emit_inst(s, i, ctx);
                        }
                        let _ = writeln!(s, "    if (!{}) break;", ctx.truthy(cond.0));
                        for i in body {
                            emit_inst(s, i, ctx);
                        }
                        s.push_str("  }\n");
                        s.push_str("  }\n");
                        return;
                    }
                }
            }
            let fused_view = fused_scalar_slice_loop_base(body, ctx).map(|base| {
                let var = format!("_fsv{}", top);
                let _ = writeln!(
                    s,
                    "  ts_strview {} = ts_str_view_typed({});",
                    var,
                    ctx.val(base)
                );
                var
            });
            if residues.is_empty() {
                if let Some(view_var) = fused_view.as_deref() {
                    if let Some(precond) = fused_scalar_slice_loop_precondition(body, ctx, view_var)
                    {
                        let _ = writeln!(s, "  if ({}) {{", precond);
                        s.push_str("  for (;;) {\n");
                        for i in cond_body {
                            emit_inst(s, i, ctx);
                        }
                        let _ = writeln!(s, "    if (!{}) break;", ctx.truthy(cond.0));
                        if try_emit_fused_scalar_slice_loop_body(s, body, ctx, Some(view_var), true)
                            .is_none()
                        {
                            for i in body {
                                emit_inst(s, i, ctx);
                            }
                        }
                        s.push_str("  }\n");
                        s.push_str("  } else {\n");
                        s.push_str("  for (;;) {\n");
                        for i in cond_body {
                            emit_inst(s, i, ctx);
                        }
                        let _ = writeln!(s, "    if (!{}) break;", ctx.truthy(cond.0));
                        for i in body {
                            emit_inst(s, i, ctx);
                        }
                        s.push_str("  }\n");
                        s.push_str("  }\n");
                        return;
                    }
                }
            }
            // Typed-array receivers the loop never assigns: the view test and
            // the length once, here; the element reads index the cell's data.
            let hoisted: Vec<(u32, u8)> = if ta_hoist_enabled() {
                loop_view_receivers(cond_body, body, ctx)
            } else {
                Vec::new()
            };
            let sv_hoisted: Vec<u32> = if str_hoist_enabled() {
                loop_string_receivers(cond_body, body, ctx)
            } else {
                Vec::new()
            };
            let mut sv_saved: Vec<(u32, Option<u32>)> = Vec::new();
            for r in &sv_hoisted {
                // three scalars (they stay in registers where a view struct would
                // be spilled): the data pointer, NULL unless a heap string (an
                // immediate has no data); the length; the width. A receiver that
                // is not a string keeps NULL: every read falls to the general path,
                // which converts or throws as the per-use path would.
                let _ = writeln!(
                    s,
                    "  const char* _sd{r}_{t} = NULL; uint32_t _sn{r}_{t} = 0u, _sw{r}_{t} = 0u; if (ts_is_str({v})) {{ ts_strview _hv = ts_str_view_typed({v}); _sd{r}_{t} = _hv.data; _sn{r}_{t} = _hv.len; _sw{r}_{t} = (_hv.flags & TS_STR_FLAG_UTF16) ? 1u : 0u; }} (void)_sd{r}_{t}; (void)_sn{r}_{t}; (void)_sw{r}_{t};",
                    r = r,
                    t = top,
                    v = ctx.val(*r)
                );
                sv_saved.push((*r, ctx.sv_hoisted.borrow_mut().insert(*r, top)));
            }
            let mut hoist_saved: Vec<(u32, Option<(u8, u32)>)> = Vec::new();
            for (arr, elem) in &hoisted {
                let _ = writeln!(
                    s,
                    "  ts_typedarray* _tah{a}_{t} = ts_ta_as({v}, {e}); uint32_t _tal{a}_{t} = _tah{a}_{t} ? _tah{a}_{t}->length : 0u; (void)_tal{a}_{t};",
                    a = arr,
                    t = top,
                    v = ctx.val(*arr),
                    e = elem
                );
                hoist_saved.push((*arr, ctx.ta_hoisted.borrow_mut().insert(*arr, (*elem, top))));
            }
            ctx.loop_labels
                .borrow_mut()
                .push((top, end, ctx.eh_depth.get()));
            ctx.loop_mod_residues.borrow_mut().push(residue_map);
            let _ = writeln!(s, "  L{}: ;", top);
            s.push_str("  for (;;) {\n");
            emit_seq(s, cond_body, ctx, PathEdge::LoopCond);
            let _ = writeln!(s, "    if (!{}) break;", ctx.truthy(cond.0));
            if try_emit_fused_scalar_slice_loop_body(s, body, ctx, fused_view.as_deref(), false)
                .is_none()
                && try_emit_string_metric_loop_body(s, body, ctx, top, string_metric_loop).is_none()
            {
                emit_seq(s, body, ctx, PathEdge::LoopBody);
            }
            // Free per iteration when this loop's JSON DOM use is self-contained,
            // instead of accumulating every iteration's DOM until function exit.
            if !ctx.json_roots.is_empty()
                && loop_body_frees_json_dom(body, &ctx.json_locals, ctx.dom_ref_total)
            {
                s.push_str("  ts_json_dom_scope_free(&_json_dom_scope);\n");
            }
            for r in &residues {
                let _ = writeln!(
                    s,
                    "  {v} += 1; if ({v} == {div}LL) {v} = 0;",
                    v = r.var,
                    div = r.divisor
                );
            }
            let _ = writeln!(s, "  goto L{};", top);
            s.push_str("  }\n");
            let _ = writeln!(s, "  L{}: ;", end);
            ctx.loop_mod_residues.borrow_mut().pop();
            ctx.loop_labels.borrow_mut().pop();
            for (arr, prev) in hoist_saved {
                match prev {
                    Some(p) => {
                        ctx.ta_hoisted.borrow_mut().insert(arr, p);
                    }
                    None => {
                        ctx.ta_hoisted.borrow_mut().remove(&arr);
                    }
                }
            }
            for (r, prev) in sv_saved {
                match prev {
                    Some(p) => {
                        ctx.sv_hoisted.borrow_mut().insert(r, p);
                    }
                    None => {
                        ctx.sv_hoisted.borrow_mut().remove(&r);
                    }
                }
            }
        }
        Inst::If {
            cond,
            then_body,
            else_body,
        } => {
            if let Some(chain) = ctx.switch_plan.heads.get(&(inst as *const Inst as usize)) {
                emit_switch_chain(s, chain, ctx);
                return;
            }
            let _ = writeln!(s, "  if ({}) {{", ctx.truthy(cond.0));
            emit_seq(s, then_body, ctx, PathEdge::IfThen);
            s.push_str("  } else {\n");
            emit_seq(s, else_body, ctx, PathEdge::IfElse);
            s.push_str("  }\n");
        }
    }
}
