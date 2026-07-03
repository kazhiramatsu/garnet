/**
 * Typed C emitter — the (in-progress) faithful TypeScript port of
 * analyzer/src/emit_c.rs, targeting BYTE-IDENTICAL output with the Rust
 * `tsaot <ir> emit` (after devirt + escape + sroa). Validation:
 * scripts/emitc_diff.sh compares per fixture; UnportedError marks the
 * not-yet-ported sections (Phase-1 style frequency-ordered porting).
 *
 * Ported so far (program-level scaffold):
 *   header / static string literals / fn decls / FN tables / CLASS_NAME /
 *   per-program proto setups / GLOBALS / register_classes(classless) /
 *   fnval adapters + global object (program-independent snapshots from a Rust
 *   emit, see scripts/gen_emitc_sections.js) / field tables / main().
 * NOT yet ported (loud): class layout structs, i64/f64 fast paths, typed
 * function bodies (the numeric-facts engine + emit_inst).
 */
import { Program, FunctionDef } from "./ir";
import { EscapeResult } from "./interproc";
import { EMITC_GLOBAL_OBJECT } from "./emitc_sections_gen";
import { UnportedError } from "./emit";

// ----------------------------- small helpers --------------------------------

function cname(fn: FunctionDef): string {
  const name = fn.name ?? "";
  if (name.length > 0 && /^[A-Za-z0-9_]+$/.test(name)) return `fn_${fn.id}_${name}`;
  return `fn_${fn.id}`;
}

function cStringLit(s: string): string {
  let esc = "";
  for (const ch of s) {
    if (ch === "\\") esc += "\\\\";
    else if (ch === '"') esc += '\\"';
    else if (ch === "\n") esc += "\\n";
    else if (ch === "\r") esc += "\\r";
    else if (ch === "\t") esc += "\\t";
    else esc += ch;
  }
  return `"${esc}"`;
}

// builtin gates (mirror emit_c.rs)
function builtinNeedsRegexp(b: string): boolean {
  return b === "global.RegExp" || b.startsWith("regexp.");
}
function builtinNeedsFetch(b: string): boolean {
  return b === "global.fetch" || b === "globalobj.fetch";
}

function walkBodies(prog: Program, visit: (inst: any) => void): void {
  const walk = (body: any[]) => {
    for (const i of body) {
      visit(i);
      for (const k of Object.keys(i)) {
        const v = i[k];
        if (Array.isArray(v) && v.length && v[0] && v[0].kind) walk(v);
      }
    }
  };
  for (const fn of prog.functions) walk(fn.body as any[]);
}

function programNeedsRegexp(prog: Program): boolean {
  let found = false;
  walkBodies(prog, (i) => {
    if (typeof i.builtin === "string" && builtinNeedsRegexp(i.builtin)) found = true;
  });
  return found;
}

function programNeedsFetch(prog: Program): boolean {
  let found = false;
  walkBodies(prog, (i) => {
    if (typeof i.builtin === "string" && builtinNeedsFetch(i.builtin)) found = true;
  });
  return found;
}

// Fact-driven unicode gate (mirrors program_needs_unicode): unicode methods
// reached via builtins, proto-method ids, or dynamic keys proven to hold a
// unicode method name.
const UNICODE_METHOD_NAMES = ["normalize", "toUpperCase", "toLowerCase", "toLocaleUpperCase", "toLocaleLowerCase"];

function builtinNeedsUnicode(b: string): boolean {
  return (
    b === "string.normalize" ||
    b === "string.toUpperCase" ||
    b === "string.toLowerCase" ||
    b === "string.toLocaleUpperCase" ||
    b === "string.toLocaleLowerCase"
  );
}

function constValueIsUnicodeMethodKey(value: any): boolean {
  if (value === undefined || value === null) return false;
  if (value.kind === "Str") return UNICODE_METHOD_NAMES.indexOf(value.value) >= 0;
  if (value.kind === "Str16") {
    const units: number[] = value.units ?? [];
    return UNICODE_METHOD_NAMES.some(
      (name) => units.length === name.length && units.every((u, i) => u === name.charCodeAt(i))
    );
  }
  return false;
}

function bodyNeedsUnicodeWithFacts(body: any[], unicodeMethodIds: Set<number>, initialUnicodeKeys: Set<number>): boolean {
  const unicodeKeyLocals = new Set<number>(initialUnicodeKeys);
  const instNeeds = (inst: any): boolean => {
    switch (inst.kind) {
      case "LoadBuiltinFn":
      case "CallBuiltin":
      case "CallBuiltinStatic":
        return builtinNeedsUnicode(inst.builtin);
      case "LoadMethodValue":
        return unicodeMethodIds.has(inst.method);
      case "LoadFieldDynamic":
        return unicodeKeyLocals.has(inst.key);
      case "Call":
      case "CallSpread": {
        const c = inst.callee ?? {};
        return c.kind === "Method" && unicodeMethodIds.has(c.method);
      }
      case "Loop":
        return (
          bodyNeedsUnicodeWithFacts(inst.condBody ?? [], unicodeMethodIds, unicodeKeyLocals) ||
          bodyNeedsUnicodeWithFacts(inst.body ?? [], unicodeMethodIds, unicodeKeyLocals)
        );
      case "If":
        return (
          bodyNeedsUnicodeWithFacts(inst.thenBody ?? [], unicodeMethodIds, unicodeKeyLocals) ||
          bodyNeedsUnicodeWithFacts(inst.elseBody ?? [], unicodeMethodIds, unicodeKeyLocals)
        );
      case "TryCatch":
        return (
          bodyNeedsUnicodeWithFacts(inst.tryBody ?? [], unicodeMethodIds, unicodeKeyLocals) ||
          bodyNeedsUnicodeWithFacts(inst.catchBody ?? [], unicodeMethodIds, unicodeKeyLocals) ||
          bodyNeedsUnicodeWithFacts(inst.finallyBody ?? [], unicodeMethodIds, unicodeKeyLocals)
        );
      default:
        return false;
    }
  };
  for (const inst of body) {
    if (instNeeds(inst)) return true;
    // update_unicode_key_facts
    if (inst.kind === "Const") {
      if (constValueIsUnicodeMethodKey(inst.value)) unicodeKeyLocals.add(inst.dst);
      else unicodeKeyLocals.delete(inst.dst);
    } else if (inst.kind === "Copy") {
      if (unicodeKeyLocals.has(inst.src)) unicodeKeyLocals.add(inst.dst);
      else unicodeKeyLocals.delete(inst.dst);
    }
  }
  return false;
}

function programNeedsUnicode(prog: Program): boolean {
  const p: any = prog;
  const unicodeMethodIds = new Set<number>();
  for (const m of (p.stringProtoMethods ?? []) as any[]) {
    if (UNICODE_METHOD_NAMES.indexOf(m.name) >= 0) unicodeMethodIds.add(m.methodId);
  }
  return (prog.functions as any[]).some((f) => bodyNeedsUnicodeWithFacts(f.body, unicodeMethodIds, new Set<number>()));
}

// --------------------- first-class builtin value adapters --------------------
// Faithful port of fnval_adapter_name / fnval_adapter_body / global_fn_value_builtins.

function fnvalAdapterName(builtin: string): string {
  return `ts_fnval_${builtin.split(".").join("_")}`;
}

function fnvalAdapterBody(builtin: string): string | undefined {
  const num = (i: number) => `(n>${i}?ts_to_num(a[${i}]):(0.0/0.0))`;
  const val = (i: number) => `(n>${i}?a[${i}]:TS_UNDEFINED)`;
  const m1 = (f: string) => `return ts_num(${f}(${num(0)}));`;
  const hvN = (f: string) => `return ts_num(${f}(${val(0)}));`;
  const hv = (expr: string) => `return ${expr};`;
  switch (builtin) {
    // ---- Math: libm 1-arg ----
    case "math.sqrt": return m1("sqrt");
    case "math.abs": return m1("fabs");
    case "math.floor": return m1("floor");
    case "math.ceil": return m1("ceil");
    case "math.sin": return m1("sin");
    case "math.cos": return m1("cos");
    case "math.tan": return m1("tan");
    case "math.asin": return m1("asin");
    case "math.acos": return m1("acos");
    case "math.atan": return m1("atan");
    case "math.sinh": return m1("sinh");
    case "math.cosh": return m1("cosh");
    case "math.tanh": return m1("tanh");
    case "math.exp": return m1("exp");
    case "math.log": return m1("log");
    case "math.asinh": return m1("asinh");
    case "math.acosh": return m1("acosh");
    case "math.atanh": return m1("atanh");
    case "math.expm1": return m1("expm1");
    case "math.log1p": return m1("log1p");
    case "math.fround": return hv(`ts_num((double)(float)(${num(0)}))`);
    case "math.f16round": return hv(`ts_num(ts_math_f16round(ts_number_coerce(${val(0)})))`);
    // ---- Math: runtime helper 1-arg ----
    case "math.round": return m1("ts_math_round");
    case "math.trunc": return m1("ts_math_trunc");
    case "math.sign": return m1("ts_math_sign");
    case "math.log2": return m1("ts_math_log2");
    case "math.log10": return m1("ts_math_log10");
    case "math.cbrt": return m1("ts_math_cbrt");
    case "math.clz32": return m1("ts_math_clz32");
    // ---- Math: 2-arg ----
    case "math.imul": return hv(`ts_num(ts_math_imul(ts_number_coerce(${val(0)}), ts_number_coerce(${val(1)})))`);
    case "math.pow": return hv(`ts_num(pow(${num(0)}, ${num(1)}))`);
    case "math.atan2": return hv(`ts_num(atan2(${num(0)}, ${num(1)}))`);
    // ---- Math: variadic (NaN propagates) ----
    case "math.max": return "double m=-INFINITY; for(int i=0;i<n;i++){ double x=ts_to_num(a[i]); if(x!=x) return ts_num(0.0/0.0); if(x>m||(x==0&&m==0&&!signbit(x))) m=x; } return ts_num(m);";
    case "math.min": return "double m=INFINITY; for(int i=0;i<n;i++){ double x=ts_to_num(a[i]); if(x!=x) return ts_num(0.0/0.0); if(x<m||(x==0&&m==0&&signbit(x))) m=x; } return ts_num(m);";
    case "math.hypot": return "double s=0; for(int i=0;i<n;i++){ double x=ts_to_num(a[i]); s+=x*x; } return ts_num(sqrt(s));";
    case "math.random": return "return ts_num(ts_math_random());";
    // ---- Number / global numeric ----
    case "number.isInteger": return hv(`ts_bool(ts_number_is_integer(${val(0)}))`);
    case "number.isFinite": return hv(`ts_bool(ts_number_is_finite(${val(0)}))`);
    case "number.isNaN": return hv(`ts_bool(ts_number_is_nan(${val(0)}))`);
    case "number.isSafeInteger": return hv(`ts_bool(ts_number_is_safe_integer(${val(0)}))`);
    case "number.parseFloat": case "global.parseFloat": return hvN("ts_parse_float");
    case "number.parseInt": case "global.parseInt": return hv(`ts_num(ts_parse_int(${val(0)}, (n>1?ts_to_num(a[1]):0.0)))`);
    case "global.isNaN": return hv(`ts_bool(isnan(ts_number_coerce(${val(0)})))`);
    case "global.isFinite": return hv(`ts_bool(isfinite(ts_number_coerce(${val(0)})))`);
    // ---- conversion functions (bare identifiers String/Number/Boolean) ----
    case "global.String": return hv(`ts_to_string_v(${val(0)})`);
    case "global.Number": return hv(`ts_num(ts_number_coerce(${val(0)}))`);
    case "global.Boolean": return hv(`ts_bool(ts_truthy_fast(${val(0)}))`);
    case "global.Symbol": return hv(`ts_symbol_new(${val(0)})`);
    case "global.fetch": return hv(`ts_fetch(${val(0)}, ${val(1)})`);
    case "global.Headers": return hv(`ts_headers_new(${val(0)})`);
    case "global.AbortController": return "return ts_abort_controller_new();";
    case "global.AbortSignal": return "return ts_abort_signal_new(0);";
    case "abortsignal.timeout": return hv(`ts_abort_signal_timeout(${val(0)})`);
    case "global.Array": return `if(n==1 && ts_is_num(${val(0)})) return ts_array_new_length(ts_to_num(${val(0)})); return ts_array_of(a, n);`;
    case "global.Object": return "if(n==0 || a[0]==TS_UNDEFINED || a[0]==TS_NULL) return ts_new_object(); return a[0];";
    case "global.Promise": return 'if(n>0) return ts_promise_new_executor(a[0]); ts_unsupported_builtin("Promise constructor requires executor"); return TS_UNDEFINED;';
    case "global.Map": return 'ts_unsupported_builtin("Map constructor called without supported new lowering"); return TS_UNDEFINED;';
    case "global.Set": return 'ts_unsupported_builtin("Set constructor called without supported new lowering"); return TS_UNDEFINED;';
    case "global.Date": return 'ts_unsupported_builtin("Date constructor called as first-class value"); return TS_UNDEFINED;';
    case "global.Function": return 'ts_unsupported_builtin("Function constructor"); return TS_UNDEFINED;';
    case "global.Error": case "global.TypeError": case "global.RangeError": case "global.SyntaxError":
    case "global.ReferenceError": case "global.EvalError": case "global.URIError": case "global.AggregateError":
      return 'tsv o=ts_new_object(); if(n>0) ts_set(o, ts_intern_field("message",7), ts_to_string_v(a[0])); return o;';
    // ---- console ----
    case "console.log": return "ts_console_log(a, n); return TS_UNDEFINED;";
    case "console.error": return "ts_console_err(a, n); return TS_UNDEFINED;";
    case "console.dir": return "ts_console_dir(n>0?a[0]:TS_UNDEFINED); return TS_UNDEFINED;";
    // ---- JSON ----
    case "json.stringify": return hv(`ts_json_stringify(${val(0)})`);
    case "json.stringify.len": return hv(`ts_num(ts_json_stringify_len(${val(0)}))`);
    case "json.stringify.indent.len": return hv(`ts_num(ts_json_stringify_indent_len(${val(0)}, ${val(1)}))`);
    case "json.num.len": return hv(`ts_num(ts_json_num_len(ts_number_coerce(${val(0)})))`);
    case "json.string.len": return hv(`ts_num(ts_json_string_len(${val(0)}))`);
    case "json.parse": return hv(`ts_json_parse(${val(0)})`);
    // ---- Object ----
    case "object.assign": return "return ts_object_assign(a, n);";
    case "object.create": return hv(`ts_object_create(${val(0)})`);
    case "object.getPrototypeOf": return hv(`ts_get_proto(${val(0)})`);
    case "object.setPrototypeOf": return hv(`ts_set_proto(${val(0)}, ${val(1)})`);
    case "object.keys": return hv(`ts_object_keys(${val(0)})`);
    case "object.getOwnPropertyNames": return hv(`ts_object_get_own_property_names(${val(0)})`);
    case "object.getOwnPropertySymbols": return hv(`ts_object_get_own_property_symbols(${val(0)})`);
    case "object.values": return hv(`ts_object_values(${val(0)})`);
    case "object.entries": return hv(`ts_object_entries(${val(0)})`);
    case "object.fromEntries": return hv(`ts_object_from_entries(${val(0)})`);
    case "object.freeze": return hv(`ts_object_freeze(${val(0)})`);
    case "object.seal": return hv(`ts_object_seal(${val(0)})`);
    case "object.preventExtensions": return hv(`ts_object_prevent_extensions(${val(0)})`);
    case "object.isFrozen": return hv(`ts_bool(ts_object_is_frozen(${val(0)}))`);
    case "object.isSealed": return hv(`ts_bool(ts_object_is_sealed(${val(0)}))`);
    case "object.isExtensible": return hv(`ts_bool(ts_object_is_extensible(${val(0)}))`);
    case "object.hasOwn": return hv(`ts_bool(ts_has_own_dyn(${val(0)}, ${val(1)}))`);
    case "object.is": return hv(`ts_bool(ts_object_is(${val(0)}, ${val(1)}))`);
    case "object.getOwnPropertyDescriptor": return hv(`ts_get_own_property_descriptor(${val(0)}, ${val(1)})`);
    case "object.getOwnPropertyDescriptors": return hv(`ts_get_own_property_descriptors(${val(0)})`);
    // ---- Object.prototype method VALUES (takes_this=1: a[0] is the receiver) ----
    case "objproto.toString": return hv(`ts_objproto_tostring_call(${val(0)})`);
    case "objproto.toLocaleString": return "return ts_objproto_toLocaleString(a, n);";
    case "objproto.hasOwnProperty": return "return ts_objproto_hasOwnProperty(a, n);";
    case "objproto.isPrototypeOf": return "return ts_objproto_isPrototypeOf(a, n);";
    case "objproto.propertyIsEnumerable": return "return ts_objproto_propertyIsEnumerable(a, n);";
    case "objproto.valueOf": return "return ts_objproto_valueOf(a, n);";
    // ---- Array statics ----
    case "array.isArray": return hv(`ts_bool(ts_is_array_fast(${val(0)}))`);
    case "array.from": return `return n>1 ? ts_array_from_mapped(${val(0)}, ${val(1)}) : ts_array_from(${val(0)});`;
    case "array.of": return "return ts_array_of(a, n);";
    // ---- String statics ----
    case "string.fromCharCode": return "return ts_string_from_char_code(a, n);";
    case "string.fromCodePoint": return "return ts_string_from_code_point(a, n);";
    // ---- Promise statics ----
    case "promise.resolve": return hv(`ts_promise_resolved(${val(0)})`);
    case "promise.reject": return hv(`ts_promise_rejected(${val(0)})`);
    case "promise.all": return hv(`ts_promise_all(${val(0)})`);
    case "promise.race": return hv(`ts_promise_race(${val(0)})`);
    case "promise.allSettled": return hv(`ts_promise_allsettled(${val(0)})`);
    case "promise.any": return hv(`ts_promise_any(${val(0)})`);
    // ---- RegExp optional QuickJS fallback ----
    case "regexp.quickTest": return hv(`ts_regexp_adapter_test_tsv(${val(0)}, (uint32_t)ts_to_num(${val(1)}), ${val(2)})`);
    case "regexp.quickSearch": return hv(`ts_num(ts_regexp_adapter_search_tsv(${val(0)}, ${val(1)}, (uint32_t)ts_to_num(${val(2)})))`);
    case "regexp.quickExec": return hv(`ts_regexp_adapter_exec_tsv(${val(0)}, (uint32_t)ts_to_num(${val(1)}), ${val(2)})`);
    case "regexp.quickMatch": return hv(`ts_regexp_adapter_match_tsv(${val(0)}, ${val(1)}, (uint32_t)ts_to_num(${val(2)}))`);
    case "regexp.quickMatchAll": return hv(`ts_regexp_adapter_match_all_tsv(${val(0)}, ${val(1)}, (uint32_t)ts_to_num(${val(2)}))`);
    case "regexp.quickReplace": return hv(`ts_regexp_adapter_replace_tsv(${val(0)}, ${val(1)}, (uint32_t)ts_to_num(${val(2)}), ${val(3)}, (int)ts_to_num(${val(4)}))`);
    case "regexp.quickSplit": return hv(`ts_regexp_adapter_split_tsv(${val(0)}, ${val(1)}, (uint32_t)ts_to_num(${val(2)}), ${val(3)})`);
    case "regexp.initObject": return hv(`ts_regexp_object_init(${val(0)})`);
    case "regexp.validateObject": return hv(`ts_regexp_adapter_validate_object_tsv(${val(0)})`);
    // ---- Symbol statics ----
    case "symbol.for": return hv(`ts_symbol_for(${val(0)})`);
    case "symbol.keyFor": return hv(`ts_symbol_key_for(${val(0)})`);
    // ---- Date statics ----
    case "date.now": return "return ts_date_now_ms();";
    default: return undefined;
  }
}

const GLOBAL_FN_VALUE_BUILTINS: string[] = [
  "global.parseInt", "global.parseFloat", "global.isNaN", "global.isFinite",
  "global.String", "global.Number", "global.Boolean", "global.Symbol",
  "global.fetch", "global.Array", "global.Object", "global.Promise",
  "global.Headers", "global.AbortController", "global.AbortSignal",
  "abortsignal.timeout", "global.Map", "global.Set", "global.Date",
  "global.Function", "global.Error", "global.TypeError", "global.RangeError",
  "global.SyntaxError", "global.ReferenceError", "global.EvalError",
  "global.URIError", "global.AggregateError", "console.log", "console.error",
  "console.dir", "json.stringify", "json.parse", "object.assign",
  "object.create", "object.getPrototypeOf", "object.setPrototypeOf",
  "object.keys", "object.getOwnPropertyNames", "object.getOwnPropertySymbols",
  "object.values", "object.entries", "object.fromEntries", "object.freeze",
  "object.seal", "object.preventExtensions", "object.isFrozen",
  "object.isSealed", "object.isExtensible", "object.hasOwn", "object.is",
  "object.getOwnPropertyDescriptor", "object.getOwnPropertyDescriptors",
  "array.isArray", "array.from", "array.of", "string.fromCharCode",
  "string.fromCodePoint", "number.isInteger", "number.isFinite",
  "number.isNaN", "number.isSafeInteger", "number.parseFloat",
  "number.parseInt", "promise.resolve", "promise.reject", "promise.all",
  "promise.race", "promise.allSettled", "promise.any", "symbol.for",
  "symbol.keyFor", "date.now", "math.sqrt", "math.abs", "math.floor",
  "math.ceil", "math.sin", "math.cos", "math.tan", "math.asin", "math.acos",
  "math.atan", "math.sinh", "math.cosh", "math.tanh", "math.exp", "math.log",
  "math.asinh", "math.acosh", "math.atanh", "math.expm1", "math.log1p",
  "math.fround", "math.f16round", "math.round", "math.trunc", "math.sign",
  "math.log2", "math.log10", "math.cbrt", "math.clz32", "math.imul",
  "math.pow", "math.atan2", "math.max", "math.min", "math.hypot",
  "math.random",
];

// ----------------------------- static strings -------------------------------

/** UTF-16 units of a JS string (matches Rust str_units = encode_utf16). */
function strUnits(s: string): number[] {
  const u: number[] = [];
  for (let i = 0; i < s.length; i++) u.push(s.charCodeAt(i));
  return u;
}

/** BTreeSet<Vec<u16>> order = lexicographic; ids assigned in that order. */
function collectStaticStringLiterals(prog: Program): { key: string; units: number[]; id: number }[] {
  const seen = new Map<string, number[]>();
  walkBodies(prog, (i) => {
    if (i.kind === "Const" && i.value) {
      if (i.value.kind === "Str") {
        const units = strUnits(i.value.value);
        seen.set(units.join(","), units);
      } else if (i.value.kind === "Str16") {
        const units = i.value.units as number[];
        seen.set(units.join(","), units);
      }
    }
  });
  const all = [...seen.values()].sort((a, b) => {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
  });
  return all.map((units, id) => ({ key: units.join(","), units, id }));
}

function emitStaticStringLiterals(out: string[], lits: { units: number[]; id: number }[]): void {
  if (lits.length === 0) return;
  out.push("/* static TS string literals: non-heap, immutable flat strings */\n");
  for (const { units, id } of lits) {
    const utf16 = units.some((u) => u > 0xff);
    const bytes: number[] = [];
    if (utf16) {
      for (const u of units) bytes.push(u & 0xff, (u >> 8) & 0xff);
      bytes.push(0, 0);
    } else {
      for (const u of units) bytes.push(u & 0xff);
      bytes.push(0);
    }
    let h = 2166136261;
    for (const u of units) {
      h = Math.imul(h ^ (u & 0xff), 16777619);
      h = Math.imul(h ^ ((u >> 8) & 0xff), 16777619);
    }
    h = h >>> 0;
    const flags = ["TS_STR_FLAG_HASHED"];
    if (units.every((u) => u < 0x80)) flags.push("TS_STR_FLAG_ASCII");
    if (utf16) flags.push("TS_STR_FLAG_UTF16");
    flags.push("TS_STR_FLAG_STATIC");
    out.push(
      `static struct { ts_gc_header h; uint32_t len, hash, flags; tsv parent; uint32_t offset; char data[${bytes.length}]; } ` +
        `TS_STRLIT_${id} = { { TS_KIND_STRING, 0, TS_GEN_NONHEAP, 0, 0, 0, 0, NULL }, ${units.length}u, ${h}u, ${flags.join(" | ")}, TS_UNDEFINED, 0u, {${bytes.join(", ")}} };\n`
    );
  }
  out.push("\n");
}

/** Field-name bytes (surrogate-pair-aware UTF-8; mirrors field_name_units +
 *  field_key_bytes_from_units). */
function fieldNameBytesC(f: { name?: string; nameUnits?: number[] }): number[] {
  const units = f.name !== undefined ? strUnits(f.name) : (f.nameUnits ?? []);
  const bytes: number[] = [];
  for (let i = 0; i < units.length; i++) {
    let cp = units[i];
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < units.length) {
      const lo = units[i + 1];
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return bytes;
}

// ------------------------------ class layout --------------------------------
// Faithful port of emit_class_layout / emit_class_descriptors / func_class /
// struct_direct_offset / numeric_field / field_key helpers.

function cBytesLit(bytes: number[]): string {
  let esc = "";
  for (const b of bytes) {
    if (b === 0x5c) esc += "\\\\";
    else if (b === 0x22) esc += '\\"';
    else if (b === 0x0a) esc += "\\n";
    else if (b === 0x0d) esc += "\\r";
    else if (b === 0x09) esc += "\\t";
    else if (b >= 0x20 && b <= 0x7e) esc += String.fromCharCode(b);
    else esc += "\\" + b.toString(8).padStart(3, "0");
  }
  return `"${esc}"`;
}

function unitsToUtf8Bytes(units: number[]): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < units.length; i++) {
    let cp = units[i];
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < units.length) {
      const lo = units[i + 1];
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return bytes;
}

function fieldKeyUnits(units: number[]): string {
  const bytes = unitsToUtf8Bytes(units);
  return `ts_intern_field(${cBytesLit(bytes)}, ${bytes.length})`;
}

function fieldKeyStr(name: string): string {
  return fieldKeyUnits(strUnits(name));
}

function methodPropNameUnits(m: any): number[] | undefined {
  if (m.propName !== undefined && m.propName !== null) return strUnits(m.propName);
  const u: number[] = m.propNameUnits ?? [];
  return u.length > 0 ? u : undefined;
}

function structName(id: number): string {
  return `Class${id}`;
}

function classesById(prog: Program): Map<number, any> {
  const m = new Map<number, any>();
  for (const c of ((prog as any).classes ?? []) as any[]) m.set(c.id, c);
  return m;
}

function topoClasses(classes: Map<number, any>): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const visit = (id: number): void => {
    if (seen.has(id)) return;
    const cd = classes.get(id);
    if (cd !== undefined && cd.parent !== null && cd.parent !== undefined) visit(cd.parent);
    seen.add(id);
    out.push(id);
  };
  const ids = [...classes.keys()].sort((a, b) => a - b);
  for (const id of ids) visit(id);
  return out;
}

function classFieldIsNumeric(c: any, fid: number): boolean {
  const ft = c.fieldTypes ?? {};
  return ft[String(fid)] === "number";
}

function emitFieldChain(out: string[], cid: number, classes: Map<number, any>, seen: Set<number>): void {
  const c = classes.get(cid);
  if (c === undefined) return;
  if (c.parent !== null && c.parent !== undefined) emitFieldChain(out, c.parent, classes, seen);
  for (const f of (c.ownFields ?? []) as number[]) {
    // A field already declared by an ancestor reuses that slot — no duplicate.
    if (!seen.has(f)) {
      seen.add(f);
      if (classFieldIsNumeric(c, f)) out.push(`  double f${f};\n`);
      else out.push(`  tsv f${f};\n`);
    }
  }
}

function emitClassLayout(out: string[], classes: Map<number, any>): void {
  const order = topoClasses(classes);
  for (const cid of order) out.push(`typedef struct ${structName(cid)} ${structName(cid)};\n`);
  out.push("\n");
  for (const cid of order) {
    out.push(`struct ${structName(cid)} {\n`);
    out.push("  ts_object header;\n");
    const seen = new Set<number>();
    emitFieldChain(out, cid, classes, seen);
    out.push("};\n");
  }
  out.push("\n");
}

/** Is (class c, field) a monomorphized numeric (unboxed double) field? Walks
 *  the inheritance chain to the declaring class. */
function numericFieldOf(c: number, field: number, classes: Map<number, any>): boolean {
  const cd = classes.get(c);
  if (cd === undefined) return false;
  if (((cd.ownFields ?? []) as number[]).indexOf(field) >= 0) return classFieldIsNumeric(cd, field);
  if (cd.parent !== null && cd.parent !== undefined) return numericFieldOf(cd.parent, field, classes);
  return false;
}

function classHasField(c: number, field: number, classes: Map<number, any>): boolean {
  const cd = classes.get(c);
  if (cd === undefined) return false;
  if (((cd.ownFields ?? []) as number[]).indexOf(field) >= 0) return true;
  if (cd.parent !== null && cd.parent !== undefined) return classHasField(cd.parent, field, classes);
  return false;
}

function fieldPath(c: number, field: number, classes: Map<number, any>): string | undefined {
  return classHasField(c, field, classes) ? `f${field}` : undefined;
}

/** Stage-B: struct slot access only when provably sound (class stable + field
 *  resolves along the chain); otherwise ts_get/ts_set fallback. */
function structDirectOffset(c: number, field: number, classes: Map<number, any>): string | undefined {
  const cd = classes.get(c);
  if (cd === undefined || cd.stable !== true) return undefined;
  return fieldPath(c, field, classes);
}

function funcClass(prog: Program): Map<number, number> {
  const m = new Map<number, number>();
  for (const c of ((prog as any).classes ?? []) as any[]) {
    for (const meth of (c.ownMethods ?? []) as any[]) m.set(meth.func, c.id);
  }
  return m;
}

/** Class field-descriptor tables + ts_register_classes (struct rendering for
 *  the runtime inspector + class-value `new K()` metadata). */
function emitClassDescriptors(out: string[], prog: Program): void {
  const classesArr: any[] = ((prog as any).classes ?? []) as any[];
  const classes = classesById(prog);
  const chain = (cid: number, acc: [number, boolean][]): void => {
    const c = classes.get(cid);
    if (c === undefined) return;
    if (c.parent !== null && c.parent !== undefined) chain(c.parent, acc);
    for (const f of (c.ownFields ?? []) as number[]) acc.push([f, classFieldIsNumeric(c, f)]);
  };
  const typed: [number, [number, boolean][]][] = [];
  for (const c of classesArr) {
    if (c.instantiated) {
      const fields: [number, boolean][] = [];
      chain(c.id, fields);
      if (fields.length > 0) typed.push([c.id, fields]);
    }
  }
  for (const [cid, fields] of typed) {
    out.push(`static ts_class_field CLASS_FIELDS_${cid}[] = {\n`);
    for (const [fid, numeric] of fields) {
      out.push(`  { ${fid}u, offsetof(struct ${structName(cid)}, f${fid}), ${numeric ? 1 : 0} },\n`);
    }
    out.push("};\n");
  }
  out.push("static void ts_register_classes(void){\n");
  for (const [cid, fields] of typed) {
    out.push(`  ts_register_class(CLASS_PROTO[${cid}], CLASS_FIELDS_${cid}, ${fields.length});\n`);
  }
  for (const c of classesArr) {
    if (c.instantiated) {
      const t = typed.find(([cid]) => cid === c.id);
      if (t !== undefined) {
        out.push(`  ts_register_class_meta(${c.id}u, sizeof(struct ${structName(c.id)}), CLASS_PROTO[${c.id}], CLASS_FIELDS_${c.id}, ${t[1].length});\n`);
      } else {
        out.push(`  ts_register_class_meta(${c.id}u, sizeof(struct ${structName(c.id)}), CLASS_PROTO[${c.id}], NULL, 0);\n`);
      }
    }
  }
  out.push("}\n\n");
}

/** CLASS_PROTO array + ts_setup_prototypes: real JS prototype chain (parent /
 *  Error-family / Object.prototype) + own-method registration (method keys +
 *  string prop keys + accessors). */
function emitClassProtoSetup(out: string[], prog: Program, wksym: Map<number, number>): void {
  const classesArr: any[] = ((prog as any).classes ?? []) as any[];
  if (classesArr.length === 0) return;
  let maxc = 0;
  for (const c of classesArr) if (c.id > maxc) maxc = c.id;
  out.push(`static tsv CLASS_PROTO[${maxc + 1}];\n`);
  out.push("static void ts_setup_prototypes(void){\n");
  for (const c of classesArr) {
    out.push(`  CLASS_PROTO[${c.id}] = ts_new_proto(); ts_gc_root(&CLASS_PROTO[${c.id}]);\n`);
  }
  for (const c of classesArr) {
    if (c.parent !== null && c.parent !== undefined) {
      out.push(`  ts_set_proto(CLASS_PROTO[${c.id}], CLASS_PROTO[${c.parent}]);\n`);
    } else if (c.errorProtoKind !== null && c.errorProtoKind !== undefined) {
      out.push(`  ts_set_proto(CLASS_PROTO[${c.id}], ts_error_proto(${c.errorProtoKind}));\n`);
    } else {
      out.push(`  ts_set_proto(CLASS_PROTO[${c.id}], OBJECT_PROTO);\n`);
    }
  }
  const fnsById = new Map<number, any>();
  for (const f of prog.functions as any[]) fnsById.set(f.id, f);
  for (const c of classesArr) {
    out.push(`  ts_define_data(CLASS_PROTO[${c.id}], ${fieldKeyStr("constructor")}, TS_UNDEFINED, 0, 1, 1);\n`);
    const accessors: [string, string | undefined, string | undefined][] = [];
    ((c.ownMethods ?? []) as any[]).forEach((m, idx) => {
      const mfn = fnsById.get(m.func);
      const fname = mfn !== undefined ? cname(mfn) : `fn_${m.func}`;
      const tt = mfn === undefined || mfn.takesThis !== false ? 1 : 0;
      const varName = `_c${c.id}_m${idx}`;
      out.push(`  tsv ${varName} = ts_make_fn_t(${fname}, 0, 0, ${tt});\n`);
      out.push(`  ts_define_data(CLASS_PROTO[${c.id}], ${methodKeyStr(m.name, wksym)}, ${varName}, 0, 1, 1);\n`);
      const propUnits = methodPropNameUnits(m);
      if (propUnits !== undefined) {
        const propKey = fieldKeyUnits(propUnits);
        if (m.kind === "getter" || m.kind === "setter") {
          const nameKey = propUnits.join(",");
          let pos = accessors.findIndex(([n]) => n === nameKey);
          if (pos < 0) {
            accessors.push([nameKey, undefined, undefined]);
            pos = accessors.length - 1;
          }
          if (m.kind === "getter") accessors[pos][1] = varName;
          else accessors[pos][2] = varName;
          const getter = accessors[pos][1] ?? "TS_UNDEFINED";
          const setter = accessors[pos][2] ?? "TS_UNDEFINED";
          out.push(`  ts_define_accessor_attr(CLASS_PROTO[${c.id}], ${propKey}, ${getter}, ${setter}, 1, 1, 0, 1);\n`);
        } else {
          out.push(`  ts_define_data(CLASS_PROTO[${c.id}], ${propKey}, ${varName}, 0, 1, 1);\n`);
        }
      }
    });
  }
  out.push("}\n\n");
}

// --------------------------- scalar string slices ----------------------------
// Faithful port of collect_scalar_string_slices + emit_scalar_slice_calc:
// a slice/substring whose every use is scalar (length / charCodeAt) is computed
// as (base, start, len, fast) scalars without materializing the substring.

type ScalarSliceKind = "Slice" | "Substring";

interface ScalarStringSlice {
  root: number;
  base: number;
  scope: number;
  kind: ScalarSliceKind;
  start?: number;
  end?: number;
  exactLen?: number;
}

function scalarSliceKind(builtin: string): ScalarSliceKind | undefined {
  if (builtin === "string.slice") return "Slice";
  if (builtin === "string.substring") return "Substring";
  return undefined;
}

interface ScalarAffine {
  base?: number;
  offset: number;
}

function scalarAffineOf(map: Map<number, ScalarAffine>, id: number): ScalarAffine {
  return map.get(id) ?? { base: id, offset: 0 };
}

function scalarSliceAffines(body: any[]): Map<number, ScalarAffine> {
  const out = new Map<number, ScalarAffine>();
  for (const inst of body) {
    if (inst.kind === "Const") {
      if ((inst.value ?? {}).kind === "Num") {
        const n = safeI64Num(inst.value.value);
        if (n !== undefined) out.set(inst.dst, { base: undefined, offset: n });
      }
    } else if (inst.kind === "Copy") {
      const a = out.get(inst.src);
      if (a !== undefined) {
        if (a.base === inst.dst) out.set(inst.dst, { base: inst.dst, offset: 0 });
        else out.set(inst.dst, a);
      }
    } else if (inst.kind === "BinOp" && (inst.op === "+" || inst.op === "-")) {
      const l = scalarAffineOf(out, inst.lhs);
      const r = scalarAffineOf(out, inst.rhs);
      let next: ScalarAffine | undefined;
      if (inst.op === "+" && r.base === undefined) next = { base: l.base, offset: l.offset + r.offset };
      else if (inst.op === "+" && l.base === undefined) next = { base: r.base, offset: r.offset + l.offset };
      else if (inst.op === "-" && r.base === undefined) next = { base: l.base, offset: l.offset - r.offset };
      if (next !== undefined) out.set(inst.dst, next);
    }
  }
  return out;
}

function scalarSliceExactLen(
  kind: ScalarSliceKind,
  start: number | undefined,
  end: number | undefined,
  affines: Map<number, ScalarAffine>
): number | undefined {
  if (start === undefined || end === undefined) return undefined;
  const a = scalarAffineOf(affines, start);
  const b = scalarAffineOf(affines, end);
  if (a.base !== b.base) return undefined;
  const delta = b.offset - a.offset;
  if (kind === "Slice") return delta >= 0 ? delta : undefined;
  return Math.abs(delta);
}

function scalarSliceEq(a: ScalarStringSlice, b: ScalarStringSlice): boolean {
  return (
    a.root === b.root && a.base === b.base && a.scope === b.scope && a.kind === b.kind &&
    a.start === b.start && a.end === b.end && a.exactLen === b.exactLen
  );
}

function instDefLocal(inst: any): number | undefined {
  switch (inst.kind) {
    case "AllocObject": case "AllocArray": case "AllocClosure": case "Copy":
    case "LoadField": case "LoadMethodValue": case "LoadBuiltinFn": case "AllocClassValue":
    case "NewDynamic": case "LoadElem": case "LoadGlobal": case "Const": case "BinOp":
    case "UnOp": case "LoadIndex": case "ArrayLen": case "StringLen": case "HasField":
    case "HasFieldDynamic": case "GenericLen": case "LoadFieldDynamic": case "ArraySlice":
    case "ObjectRest": case "ObjectCopyProps": case "ConstructResult": case "LoadClassProto":
    case "GetProto": case "NewMap": case "NewSet":
      return inst.dst;
    case "Call": case "Yield": case "Await": case "DeleteField":
    case "CallSpread": case "CallBuiltin": case "CallBuiltinStatic": case "SetProto":
      return inst.dst !== undefined && inst.dst !== null ? inst.dst : undefined;
    default:
      return undefined;
  }
}

function collectScalarSlicesBody(
  body: any[],
  scope: number,
  nextScope: { n: number },
  out: Map<number, ScalarStringSlice>,
  invalid: Set<number>
): void {
  const local = new Map<number, ScalarStringSlice>();
  const affines = scalarSliceAffines(body);
  for (const inst of body) {
    if (inst.kind === "CallBuiltin" && inst.dst !== undefined && inst.dst !== null) {
      const kind = scalarSliceKind(inst.builtin);
      if (kind !== undefined) {
        const args: number[] = inst.args ?? [];
        const start = args.length > 0 ? args[0] : undefined;
        const end = args.length > 1 ? args[1] : undefined;
        const spec: ScalarStringSlice = {
          root: inst.dst,
          base: inst.recv,
          scope,
          kind,
          start,
          end,
          exactLen: scalarSliceExactLen(kind, start, end, affines),
        };
        const prev = local.get(inst.dst);
        if (prev !== undefined) {
          if (!scalarSliceEq(prev, spec)) {
            invalid.add(prev.root);
            invalid.add(spec.root);
          }
        } else {
          local.set(inst.dst, spec);
        }
      }
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const inst of body) {
      if (inst.kind === "Copy") {
        const spec = local.get(inst.src);
        if (spec !== undefined) {
          const prev = local.get(inst.dst);
          if (prev !== undefined) {
            if (!scalarSliceEq(prev, spec)) {
              invalid.add(prev.root);
              invalid.add(spec.root);
            }
          } else {
            local.set(inst.dst, spec);
            changed = true;
          }
        }
      }
    }
  }

  for (const [id, spec] of local) {
    const prev = out.get(id);
    if (prev !== undefined) {
      if (!scalarSliceEq(prev, spec)) {
        invalid.add(prev.root);
        invalid.add(spec.root);
      }
    } else {
      out.set(id, spec);
    }
  }

  for (const inst of body) {
    if (inst.kind === "Loop") {
      const condScope = nextScope.n++;
      collectScalarSlicesBody(inst.condBody ?? [], condScope, nextScope, out, invalid);
      const bodyScope = nextScope.n++;
      collectScalarSlicesBody(inst.body ?? [], bodyScope, nextScope, out, invalid);
    } else if (inst.kind === "If") {
      const thenScope = nextScope.n++;
      collectScalarSlicesBody(inst.thenBody ?? [], thenScope, nextScope, out, invalid);
      const elseScope = nextScope.n++;
      collectScalarSlicesBody(inst.elseBody ?? [], elseScope, nextScope, out, invalid);
    } else if (inst.kind === "TryCatch") {
      const tryScope = nextScope.n++;
      collectScalarSlicesBody(inst.tryBody ?? [], tryScope, nextScope, out, invalid);
      const catchScope = nextScope.n++;
      collectScalarSlicesBody(inst.catchBody ?? [], catchScope, nextScope, out, invalid);
      const finallyScope = nextScope.n++;
      collectScalarSlicesBody(inst.finallyBody ?? [], finallyScope, nextScope, out, invalid);
    }
  }
}

function validateScalarStringSlices(body: any[], candidates: Map<number, ScalarStringSlice>, invalid: Set<number>): void {
  const inv = (id: any): void => {
    if (id !== undefined && id !== null) {
      const spec = candidates.get(id);
      if (spec !== undefined) invalid.add(spec.root);
    }
  };
  const invCallee = (callee: any): void => {
    if ((callee ?? {}).kind === "Value") inv(callee.local);
  };
  const sameRootInScope = (a: number, b: number, scope: number): boolean => {
    const x = candidates.get(a);
    const y = candidates.get(b);
    return x !== undefined && y !== undefined && x.root === y.root && x.scope === scope && y.scope === scope;
  };
  const candidateInScope = (id: number, scope: number): boolean => {
    const spec = candidates.get(id);
    return spec !== undefined && spec.scope === scope;
  };
  const checkDef = (inst: any, scope: number): void => {
    let allowed = false;
    if (
      inst.kind === "CallBuiltin" &&
      inst.dst !== undefined &&
      inst.dst !== null &&
      scalarSliceKind(inst.builtin) !== undefined
    ) {
      const spec = candidates.get(inst.dst);
      allowed = spec !== undefined && spec.root === inst.dst && spec.scope === scope;
    } else if (inst.kind === "Copy") {
      allowed = sameRootInScope(inst.dst, inst.src, scope);
    }
    if (!allowed) {
      const def = instDefLocal(inst);
      if (def !== undefined && def !== null) {
        const spec = candidates.get(def);
        if (spec !== undefined) invalid.add(spec.root);
      }
    }
  };
  const walk = (b: any[], scope: number, nextScope: { n: number }): void => {
    for (const inst of b) {
      checkDef(inst, scope);
      switch (inst.kind) {
        case "AllocObject":
          inv(inst.proto);
          break;
        case "AllocClosure": case "AllocClassValue":
          for (const c of inst.captures ?? []) inv(c.cell);
          break;
        case "Copy":
          if (!sameRootInScope(inst.dst, inst.src, scope)) inv(inst.src);
          break;
        case "LoadField": case "DeleteField": case "GetProto":
          inv(inst.obj);
          break;
        case "LoadMethodValue":
          inv(inst.recv);
          break;
        case "LoadElem":
          inv(inst.arr);
          break;
        case "ObjectRest": case "ObjectCopyProps":
          inv(inst.src);
          break;
        case "Print":
          inv(inst.src);
          break;
        case "StoreField":
          inv(inst.obj);
          inv(inst.src);
          break;
        case "StoreElem":
          inv(inst.arr);
          inv(inst.src);
          break;
        case "NewDynamic":
          inv(inst.callee);
          for (const a of inst.args ?? []) inv(a);
          break;
        case "Call":
          invCallee(inst.callee);
          inv(inst.recv);
          for (const a of inst.args ?? []) inv(a);
          break;
        case "Return":
          inv(inst.src);
          break;
        case "Yield": case "Await":
          inv(inst.operand);
          break;
        case "Throw": case "StoreGlobal":
          inv(inst.src);
          break;
        case "BinOp":
          inv(inst.lhs);
          inv(inst.rhs);
          break;
        case "UnOp":
          inv(inst.operand);
          break;
        case "LoadIndex":
          inv(inst.arr);
          inv(inst.index);
          break;
        case "StoreIndex":
          inv(inst.arr);
          inv(inst.index);
          inv(inst.src);
          break;
        case "ArrayLen":
          inv(inst.arr);
          break;
        case "StringLen":
          if (candidates.has(inst.src) && !candidateInScope(inst.src, scope)) inv(inst.src);
          break;
        case "ArrayPush": case "ArrayPushAll":
          inv(inst.arr);
          inv(inst.src);
          break;
        case "HasField":
          inv(inst.obj);
          break;
        case "HasFieldDynamic": case "LoadFieldDynamic":
          inv(inst.obj);
          inv(inst.key);
          break;
        case "StoreFieldDynamic":
          inv(inst.obj);
          inv(inst.key);
          inv(inst.src);
          break;
        case "GenericLen":
          inv(inst.src);
          break;
        case "ArraySlice":
          inv(inst.arr);
          inv(inst.start);
          break;
        case "ConstructResult":
          inv(inst.inst);
          inv(inst.ret);
          break;
        case "CallSpread":
          invCallee(inst.callee);
          inv(inst.recv);
          for (const sp of inst.argSpecs ?? []) inv(sp.local);
          break;
        case "StoreProtoMethod":
          inv(inst.src);
          break;
        case "StoreMethod":
          inv(inst.obj);
          inv(inst.src);
          break;
        case "CallBuiltin":
          if (inst.builtin === "string.charCodeAt") {
            for (const a of inst.args ?? []) inv(a);
            if (candidates.has(inst.recv) && !candidateInScope(inst.recv, scope)) inv(inst.recv);
          } else {
            inv(inst.recv);
            for (const a of inst.args ?? []) inv(a);
          }
          break;
        case "CallBuiltinStatic":
          for (const a of inst.args ?? []) inv(a);
          break;
        case "SetProto":
          inv(inst.obj);
          inv(inst.proto);
          break;
        case "Loop": {
          inv(inst.cond);
          const condScope = nextScope.n++;
          walk(inst.condBody ?? [], condScope, nextScope);
          const bodyScope = nextScope.n++;
          walk(inst.body ?? [], bodyScope, nextScope);
          break;
        }
        case "If": {
          inv(inst.cond);
          const thenScope = nextScope.n++;
          walk(inst.thenBody ?? [], thenScope, nextScope);
          const elseScope = nextScope.n++;
          walk(inst.elseBody ?? [], elseScope, nextScope);
          break;
        }
        case "TryCatch": {
          const tryScope = nextScope.n++;
          walk(inst.tryBody ?? [], tryScope, nextScope);
          const catchScope = nextScope.n++;
          walk(inst.catchBody ?? [], catchScope, nextScope);
          const finallyScope = nextScope.n++;
          walk(inst.finallyBody ?? [], finallyScope, nextScope);
          break;
        }
        default:
          break;
      }
    }
  };
  walk(body, 0, { n: 1 });
}

function collectScalarStringSlices(body: any[]): Map<number, ScalarStringSlice> {
  const candidates = new Map<number, ScalarStringSlice>();
  const invalid = new Set<number>();
  collectScalarSlicesBody(body, 0, { n: 1 }, candidates, invalid);
  validateScalarStringSlices(body, candidates, invalid);
  for (const spec of candidates.values()) {
    if (
      candidates.has(spec.base) ||
      (spec.start !== undefined && candidates.has(spec.start)) ||
      (spec.end !== undefined && candidates.has(spec.end))
    ) {
      invalid.add(spec.root);
    }
  }
  const ids: number[] = [];
  for (const [id, spec] of candidates) if (invalid.has(spec.root)) ids.push(id);
  for (const id of ids) candidates.delete(id);
  return candidates;
}

/** ts_str_slice/substring whose result is consumed only as scalars: compute
 *  (base, start, len, fast) without materializing the substring. */
function emitScalarSliceCalc(s: string[], dst: number, spec: ScalarStringSlice, cx: EmitCtx): void {
  const base = cxVal(cx, spec.base);
  const lenTmp = `_ssn${dst}`;
  const startTmp = `_ssa${dst}`;
  const endTmp = `_ssb${dst}`;
  const startExpr = spec.start !== undefined ? cxNum(cx, spec.start) : "0";
  const endExpr = spec.end !== undefined ? cxNum(cx, spec.end) : lenTmp;
  s.push(`  { long long ${lenTmp} = (long long)ts_str_len_typed(${base});\n`);
  s.push(`    ss_base${spec.root} = ${base};\n`);
  s.push(`    long long ${startTmp} = (long long)(${startExpr});\n`);
  s.push(`    long long ${endTmp} = (long long)(${endExpr});\n`);
  if (spec.kind === "Slice") {
    s.push(`    if ((uint64_t)${startTmp} <= (uint64_t)${lenTmp} && (uint64_t)${endTmp} <= (uint64_t)${lenTmp} && ${endTmp} >= ${startTmp}) {\n`);
    s.push(`      ss_start${spec.root} = ${startTmp}; ss_len${spec.root} = ${endTmp} - ${startTmp}; ss_fast${spec.root} = 1;\n`);
    s.push("    } else {\n");
    s.push(`      ss_fast${spec.root} = 0;\n`);
    s.push(`      if (${startTmp} < 0) ${startTmp} += ${lenTmp};\n`);
    s.push(`      if (${endTmp} < 0) ${endTmp} += ${lenTmp};\n`);
    s.push(`      if (${startTmp} < 0) ${startTmp} = 0;\n`);
    s.push(`      if (${startTmp} > ${lenTmp}) ${startTmp} = ${lenTmp};\n`);
    s.push(`      if (${endTmp} < 0) ${endTmp} = 0;\n`);
    s.push(`      if (${endTmp} > ${lenTmp}) ${endTmp} = ${lenTmp};\n`);
    s.push(`      if (${endTmp} < ${startTmp}) ${endTmp} = ${startTmp};\n`);
    s.push(`      ss_start${spec.root} = ${startTmp}; ss_len${spec.root} = ${endTmp} - ${startTmp};\n`);
    s.push("    }\n");
  } else {
    const swapTmp = `_sst${dst}`;
    s.push(`    if ((uint64_t)${startTmp} <= (uint64_t)${lenTmp} && (uint64_t)${endTmp} <= (uint64_t)${lenTmp}) {\n`);
    s.push(`      ss_fast${spec.root} = 1;\n`);
    s.push(`      if (${startTmp} <= ${endTmp}) { ss_start${spec.root} = ${startTmp}; ss_len${spec.root} = ${endTmp} - ${startTmp}; } else { ss_start${spec.root} = ${endTmp}; ss_len${spec.root} = ${startTmp} - ${endTmp}; }\n`);
    s.push("    } else {\n");
    s.push(`      ss_fast${spec.root} = 0;\n`);
    s.push(`      if (${startTmp} < 0) ${startTmp} = 0;\n`);
    s.push(`      if (${startTmp} > ${lenTmp}) ${startTmp} = ${lenTmp};\n`);
    s.push(`      if (${endTmp} < 0) ${endTmp} = 0;\n`);
    s.push(`      if (${endTmp} > ${lenTmp}) ${endTmp} = ${lenTmp};\n`);
    s.push(`      if (${startTmp} > ${endTmp}) { long long ${swapTmp} = ${startTmp}; ${startTmp} = ${endTmp}; ${endTmp} = ${swapTmp}; }\n`);
    s.push(`      ss_start${spec.root} = ${startTmp}; ss_len${spec.root} = ${endTmp} - ${startTmp};\n`);
    s.push("    }\n");
  }
  s.push("  }\n");
}

function scalarSliceCharcodeatExpr(spec: ScalarStringSlice, args: number[], cx: EmitCtx, numericFacts: NumericAnalysis): string {
  let idx: string;
  if (args.length > 0) {
    const a = args[0];
    const c = numericFacts.intConst.get(a);
    if (c !== undefined) idx = `${c}`;
    else if (cx.intLocal.has(a)) idx = `d${a}`;
    else idx = `(long long)(${cxNum(cx, a)})`;
  } else {
    idx = "0";
  }
  const len = spec.exactLen !== undefined ? `${spec.exactLen}` : `ss_len${spec.root}`;
  return `ts_str_slice_charcodeat_fast_i64_typed(ss_base${spec.root}, ss_start${spec.root}, ${len}, ${idx}, ss_fast${spec.root})`;
}

// ----------------- fused polymorphic / escape string loops -----------------
// Faithful ports of the select4-based fused loops that the guardrail fixture
// exercises: _fdre / _fpps / _fppr / _fppsj / _fsje.

interface SourceSelect4 {
  len: number;
  dst: number;
  pick: number;
  values: [number, number, number, number];
}

interface PairSelect4 {
  len: number;
  dst1: number;
  dst2: number;
  pick: number;
  values1: [number, number, number, number];
  values2: [number, number, number, number];
}

function parseSelectCopies(seq: any[], n: number, expectedDsts: number[] | undefined): [number[], number[]] | undefined {
  if (seq.length !== n) return undefined;
  const dsts: number[] = [];
  const values: number[] = [];
  for (let i = 0; i < n; i++) {
    const inst = seq[i];
    if (inst.kind !== "Copy") return undefined;
    if (expectedDsts !== undefined && inst.dst !== expectedDsts[i]) return undefined;
    dsts.push(inst.dst);
    values.push(inst.src);
  }
  return [dsts, values];
}

function parseSelectBranch(
  constInst: any,
  cmpInst: any,
  ifInst: any,
  expectedCase: number,
  expectedPick: number | undefined,
  numericFacts: NumericAnalysis
): [number, any[], any[]] | undefined {
  if (cmpInst.kind !== "BinOp" || ifInst.kind !== "If") return undefined;
  if (cmpInst.op !== "===" || cmpInst.dst !== ifInst.cond || matchConstI64(constInst, numericFacts) !== expectedCase) return undefined;
  const caseConst = matchConstDst(constInst);
  if (caseConst === undefined) return undefined;
  let pick: number;
  if (cmpInst.lhs === caseConst) pick = cmpInst.rhs;
  else if (cmpInst.rhs === caseConst) pick = cmpInst.lhs;
  else return undefined;
  if (expectedPick !== undefined && pick !== expectedPick) return undefined;
  return [pick, ifInst.thenBody ?? [], ifInst.elseBody ?? []];
}

function parseSelect4(body: any[], start: number, n: number, numericFacts: NumericAnalysis):
  { len: number; pick: number; dsts: number[]; values: number[][] } | undefined {
  if (body.length - start < n + 3) return undefined;
  const c0 = parseSelectCopies(body.slice(start, start + n), n, undefined);
  if (c0 === undefined) return undefined;
  const [dsts, values0] = c0;
  const b1 = parseSelectBranch(body[start + n], body[start + n + 1], body[start + n + 2], 1, undefined, numericFacts);
  if (b1 === undefined) return undefined;
  const [pick, then1, else1] = b1;
  const c1 = parseSelectCopies(then1, n, dsts);
  if (c1 === undefined) return undefined;
  if (else1.length !== 3) return undefined;
  const b2 = parseSelectBranch(else1[0], else1[1], else1[2], 2, pick, numericFacts);
  if (b2 === undefined) return undefined;
  const then2 = b2[1], else2 = b2[2];
  const c2 = parseSelectCopies(then2, n, dsts);
  if (c2 === undefined) return undefined;
  if (else2.length !== 3) return undefined;
  const b3 = parseSelectBranch(else2[0], else2[1], else2[2], 3, pick, numericFacts);
  if (b3 === undefined) return undefined;
  const then3 = b3[1], else3 = b3[2];
  const c3 = parseSelectCopies(then3, n, dsts);
  if (c3 === undefined) return undefined;
  if (else3.length !== 0) return undefined;
  const values: number[][] = [];
  for (let i = 0; i < n; i++) values.push([c0[1][i], c1[1][i], c2[1][i], c3[1][i]]);
  return { len: n + 3, pick, dsts, values };
}

function parseSourceSelect4(body: any[], start: number, numericFacts: NumericAnalysis): SourceSelect4 | undefined {
  const sel = parseSelect4(body, start, 1, numericFacts);
  if (sel === undefined) return undefined;
  return { len: sel.len, dst: sel.dsts[0], pick: sel.pick, values: sel.values[0] as [number, number, number, number] };
}

function parsePairSelect4(body: any[], start: number, numericFacts: NumericAnalysis): PairSelect4 | undefined {
  const sel = parseSelect4(body, start, 2, numericFacts);
  if (sel === undefined) return undefined;
  return {
    len: sel.len,
    dst1: sel.dsts[0],
    dst2: sel.dsts[1],
    pick: sel.pick,
    values1: sel.values[0] as [number, number, number, number],
    values2: sel.values[1] as [number, number, number, number],
  };
}

function staticStringExprFromConst(inst: any, cx: EmitCtx): string | undefined {
  if (inst.kind !== "Const") return undefined;
  const v = inst.value ?? {};
  let units: number[] | undefined;
  if (v.kind === "Str") units = strUnits(v.value);
  else if (v.kind === "Str16") units = v.units ?? [];
  if (units === undefined) return undefined;
  const id = cx.staticStrings.get(units.join(","));
  if (id === undefined) return undefined;
  return `ts_str_v(&TS_STRLIT_${id})`;
}

function emitTsvArray4(s: string[], name: string, cx: EmitCtx, values: [number, number, number, number]): void {
  s.push(`  tsv ${name}[4] = { ${cxVal(cx, values[0])}, ${cxVal(cx, values[1])}, ${cxVal(cx, values[2])}, ${cxVal(cx, values[3])} };\n`);
}

function emitTsvUndefinedArray4(s: string[], name: string): void {
  s.push(`  tsv ${name}[4] = { TS_UNDEFINED, TS_UNDEFINED, TS_UNDEFINED, TS_UNDEFINED };\n`);
}

function emitSelect4Clamped(s: string[], dst: string, expr: string): void {
  s.push(`  long long ${dst} = (long long)${expr}; if ((uint64_t)${dst} >= 4ULL) ${dst} = 0;\n`);
}

interface CounterAddTail {
  counter: number;
  inc: number;
}

function matchCounterAddTail(body: any[], start: number, cx: EmitCtx, numericFacts: NumericAnalysis): CounterAddTail | undefined {
  if (body.length - start < 3) return undefined;
  const counterIncConst = body[start];
  const counterAdd = body[start + 1];
  const counterCopy = body[start + 2];
  if (counterAdd.kind !== "BinOp" || counterCopy.kind !== "Copy") return undefined;
  const counterInc = matchConstI64(counterIncConst, numericFacts);
  if (counterInc === undefined || counterInc < 0) return undefined;
  const counter = counterCopy.dst;
  const incLocal = matchConstDst(counterIncConst);
  if (incLocal === undefined) return undefined;
  let counterOk = false;
  if (counterAdd.lhs === counter) counterOk = counterAdd.rhs === incLocal;
  else if (counterAdd.rhs === counter) counterOk = counterAdd.lhs === incLocal;
  if (counterAdd.op !== "+" || counterAdd.dst !== counterCopy.src || !counterOk || !cx.intLocal.has(counter)) return undefined;
  return { counter, inc: counterInc };
}

function addUses(a: number, b: number, x: number, y: number): boolean {
  return (a === x && b === y) || (a === y && b === x);
}

interface PolymorphicPatternSearchShape {
  select: SourceSelect4;
  recv: number;
  acc: number;
  skip: number;
}

function matchPolymorphicPatternSearchShape(body: any[], cx: EmitCtx, numericFacts: NumericAnalysis): PolymorphicPatternSearchShape | undefined {
  const select = parseSourceSelect4(body, 0, numericFacts);
  if (select === undefined) return undefined;
  if (body.length - select.len < 8) return undefined;
  const seq = body.slice(select.len, select.len + 8);
  const [accAlias1, indexInst, indexSum, accAfterIndex, accAlias2, lastInst, lastSum, accAfterLast] = seq;
  if (
    accAlias1.kind !== "Copy" ||
    indexInst.kind !== "CallBuiltin" || indexInst.dst === undefined || indexInst.dst === null ||
    indexSum.kind !== "BinOp" ||
    accAfterIndex.kind !== "Copy" ||
    accAlias2.kind !== "Copy" ||
    lastInst.kind !== "CallBuiltin" || lastInst.dst === undefined || lastInst.dst === null ||
    lastSum.kind !== "BinOp" ||
    accAfterLast.kind !== "Copy"
  ) {
    return undefined;
  }
  const indexArgs: number[] = indexInst.args ?? [];
  const lastArgs: number[] = lastInst.args ?? [];
  if (
    indexInst.builtin !== "string.indexOf" ||
    lastInst.builtin !== "string.lastIndexOf" ||
    indexSum.op !== "+" ||
    lastSum.op !== "+" ||
    indexInst.recv !== lastInst.recv ||
    indexArgs.length !== 1 ||
    lastArgs.length !== 1 ||
    indexArgs[0] !== select.dst ||
    lastArgs[0] !== select.dst ||
    indexSum.dst !== accAfterIndex.src ||
    lastSum.dst !== accAfterLast.src ||
    accAfterIndex.dst !== accAlias1.src ||
    accAfterLast.dst !== accAfterIndex.dst ||
    accAlias2.src !== accAfterIndex.dst
  ) {
    return undefined;
  }
  if (
    !addUses(indexSum.lhs, indexSum.rhs, accAlias1.dst, indexInst.dst) ||
    !addUses(lastSum.lhs, lastSum.rhs, accAlias2.dst, lastInst.dst)
  ) {
    return undefined;
  }
  for (const value of select.values) {
    if (body.some((inst) => instDefLocal(inst) === value)) return undefined;
  }
  const searchRecv: number = indexInst.recv;
  if (body.some((inst) => instDefLocal(inst) === searchRecv)) return undefined;
  const skip = select.len + 8;
  const skippedDefs = collectDefs(body.slice(0, skip));
  if (localsUsedAfter(body, skip, skippedDefs)) return undefined;
  return { select, recv: indexInst.recv, acc: accAfterLast.dst, skip };
}

function tryEmitFusedPolymorphicPatternSearchLoop(
  s: string[], cond: number, condBody: any[], body: any[], cx: EmitCtx, numericFacts: NumericAnalysis, top: number, end: number
): boolean {
  const shape = matchPolymorphicPatternSearchShape(body, cx, numericFacts);
  if (shape === undefined) return false;
  const patArr = `_fpps_pat${top}`;
  const metricArr = `_fpps_metric${top}`;
  const selVar = `_fpps_sel${top}`;
  emitTsvArray4(s, patArr, cx, shape.select.values);
  s.push(`  long long ${metricArr}[4];\n`);
  s.push("  for (int _fpps_i = 0; _fpps_i < 4; _fpps_i++) {\n");
  s.push(`    ${metricArr}[_fpps_i] = (long long)ts_str_indexof_fast(${cxVal(cx, shape.recv)}, ${patArr}[_fpps_i], 0, 0) + (long long)ts_str_lastindexof_fast(${cxVal(cx, shape.recv)}, ${patArr}[_fpps_i], 0, 0);\n`);
  s.push("  }\n");
  cx.loopLabels.push([top, end]);
  s.push(`  L${top}: ;\n`);
  emitCheckedLoop(s, cond, condBody, cx, numericFacts, () => {
    emitSelect4Clamped(s, selVar, cxNum(cx, shape.select.pick));
    emitMetricAccAdd(s, shape.acc, `${metricArr}[${selVar}]`, cx);
    for (const inst of body.slice(shape.skip)) emitInstC(s, inst, cx, numericFacts);
    s.push(`  goto L${top};\n`);
  });
  s.push(`  L${end}: ;\n`);
  cx.loopLabels.pop();
  return true;
}

interface DynamicReplaceMetricShape {
  len: number;
  recv: number;
  pattern: number;
  replacement: number;
  indexNeedle: number;
  charIdx: number;
  acc: number;
}

function matchDynamicReplaceMetricShape(body: any[], start: number, numericFacts: NumericAnalysis): DynamicReplaceMetricShape | undefined {
  if (body.length - start < 10) return undefined;
  const seq = body.slice(start, start + 10);
  const [replaceInst, copyReplaced, lenInst, sumLen, indexCall, sumIndex, charIdxConst, charCall, sumChar, sumCopy] = seq;
  if (
    replaceInst.kind !== "CallBuiltin" || replaceInst.dst === undefined || replaceInst.dst === null ||
    copyReplaced.kind !== "Copy" ||
    lenInst.kind !== "GenericLen" ||
    sumLen.kind !== "BinOp" ||
    indexCall.kind !== "Call" || indexCall.dst === undefined || indexCall.dst === null || indexCall.recv === undefined || indexCall.recv === null ||
    sumIndex.kind !== "BinOp" ||
    charCall.kind !== "Call" || charCall.dst === undefined || charCall.dst === null || charCall.recv === undefined || charCall.recv === null ||
    sumChar.kind !== "BinOp" ||
    sumCopy.kind !== "Copy"
  ) {
    return undefined;
  }
  const replaceArgs: number[] = replaceInst.args ?? [];
  const indexArgs: number[] = indexCall.args ?? [];
  const charArgs: number[] = charCall.args ?? [];
  if (
    replaceInst.builtin !== "string.replaceAll" ||
    replaceArgs.length !== 2 ||
    replaceInst.dst !== copyReplaced.src ||
    lenInst.src !== copyReplaced.dst ||
    sumLen.op !== "+" ||
    lenInst.dst !== sumLen.rhs ||
    indexCall.recv !== copyReplaced.dst ||
    indexArgs.length !== 1 ||
    sumIndex.op !== "+" ||
    sumLen.dst !== sumIndex.lhs ||
    indexCall.dst !== sumIndex.rhs ||
    charCall.recv !== copyReplaced.dst ||
    charArgs.length !== 1 ||
    charArgs[0] !== matchConstDst(charIdxConst) ||
    sumChar.op !== "+" ||
    sumIndex.dst !== sumChar.lhs ||
    charCall.dst !== sumChar.rhs ||
    sumChar.dst !== sumCopy.src ||
    sumCopy.dst !== sumLen.lhs
  ) {
    return undefined;
  }
  const charIdx = matchConstI64(charIdxConst, numericFacts);
  if (charIdx === undefined || charIdx < 0) return undefined;
  const defs = collectDefs(seq);
  if (localsUsedAfter(body, start + 10, defs)) return undefined;
  return {
    len: 10,
    recv: replaceInst.recv,
    pattern: replaceArgs[0],
    replacement: replaceArgs[1],
    indexNeedle: indexArgs[0],
    charIdx,
    acc: sumCopy.dst,
  };
}

function tryEmitFusedPolymorphicPatternReplaceLoop(
  s: string[], cond: number, condBody: any[], body: any[], cx: EmitCtx, numericFacts: NumericAnalysis, top: number
): boolean {
  const select = parsePairSelect4(body, 0, numericFacts);
  if (select === undefined) return false;
  const metric = matchDynamicReplaceMetricShape(body, select.len, numericFacts);
  if (metric === undefined) return false;
  if (metric.pattern !== select.dst1 || metric.replacement !== select.dst2 || metric.indexNeedle !== select.dst2) return false;
  for (const value of [...select.values1, ...select.values2]) {
    if (body.some((inst) => instDefLocal(inst) === value)) return false;
  }
  if (body.some((inst) => instDefLocal(inst) === metric.recv)) return false;
  const skip = select.len + metric.len;
  const skippedDefs = collectDefs(body.slice(0, skip));
  if (localsUsedAfter(body, skip, skippedDefs)) return false;

  const patArr = `_fppr_pat${top}`;
  const repArr = `_fppr_rep${top}`;
  const metricArr = `_fppr_metric${top}`;
  const okVar = `_fppr_ok${top}`;
  const selVar = `_fppr_sel${top}`;
  emitTsvArray4(s, patArr, cx, select.values1);
  emitTsvArray4(s, repArr, cx, select.values2);
  s.push(`  long long ${metricArr}[4];\n`);
  s.push(`  int ${okVar} = 1;\n`);
  s.push("  for (int _fppr_i = 0; _fppr_i < 4; _fppr_i++) {\n");
  s.push(`    ${metricArr}[_fppr_i] = ts_str_replace_literal_metric3(${cxVal(cx, metric.recv)}, ${patArr}[_fppr_i], ${repArr}[_fppr_i], ${repArr}[_fppr_i], ${metric.charIdx}LL, 1);\n`);
  s.push(`    if (${metricArr}[_fppr_i] < 0) ${okVar} = 0;\n`);
  s.push("  }\n");
  s.push(`  if (${okVar}) {\n`);
  emitCheckedLoop(s, cond, condBody, cx, numericFacts, () => {
    emitSelect4Clamped(s, selVar, cxNum(cx, select.pick));
    emitMetricAccAdd(s, metric.acc, `${metricArr}[${selVar}]`, cx);
    for (const inst of body.slice(skip)) emitInstC(s, inst, cx, numericFacts);
  });
  s.push("  } else {\n");
  emitRuntimeLoop(s, cond, condBody, body, cx, numericFacts);
  s.push("  }\n");
  return true;
}

interface DynamicSplitJoinMetricShape {
  len: number;
  recv: number;
  separator: number;
  joiner: number;
  partIndex: number;
  acc: number;
}

function matchDynamicSplitJoinMetricShape(body: any[], start: number, numericFacts: NumericAnalysis): DynamicSplitJoinMetricShape | undefined {
  if (body.length - start < 13) return undefined;
  const seq = body.slice(start, start + 13);
  const [splitInst, copyParts, joinInst, copyJoined, partsLen, sumParts, joinedLen, sumJoined, indexConst, loadIdx, partLen, sumPart, sumCopy] = seq;
  if (
    splitInst.kind !== "CallBuiltin" || splitInst.dst === undefined || splitInst.dst === null ||
    copyParts.kind !== "Copy" ||
    joinInst.kind !== "CallBuiltin" || joinInst.dst === undefined || joinInst.dst === null ||
    copyJoined.kind !== "Copy" ||
    partsLen.kind !== "ArrayLen" ||
    sumParts.kind !== "BinOp" ||
    joinedLen.kind !== "StringLen" ||
    sumJoined.kind !== "BinOp" ||
    loadIdx.kind !== "LoadIndex" ||
    partLen.kind !== "StringLen" ||
    sumPart.kind !== "BinOp" ||
    sumCopy.kind !== "Copy"
  ) {
    return undefined;
  }
  const splitArgs: number[] = splitInst.args ?? [];
  const joinArgs: number[] = joinInst.args ?? [];
  if (
    splitInst.builtin !== "string.split" ||
    joinInst.builtin !== "array.join" ||
    splitArgs.length !== 1 ||
    splitInst.dst !== copyParts.src ||
    joinInst.recv !== copyParts.dst ||
    joinArgs.length !== 1 ||
    joinInst.dst !== copyJoined.src ||
    partsLen.arr !== copyParts.dst ||
    partsLen.dst !== sumParts.rhs ||
    joinedLen.src !== copyJoined.dst ||
    joinedLen.dst !== sumJoined.rhs ||
    sumParts.dst !== sumJoined.lhs ||
    loadIdx.arr !== copyParts.dst ||
    loadIdx.index !== matchConstDst(indexConst) ||
    loadIdx.dst !== partLen.src ||
    partLen.dst !== sumPart.rhs ||
    sumJoined.dst !== sumPart.lhs ||
    sumPart.dst !== sumCopy.src ||
    sumCopy.dst !== sumParts.lhs ||
    sumParts.op !== "+" ||
    sumJoined.op !== "+" ||
    sumPart.op !== "+"
  ) {
    return undefined;
  }
  const partIndex = matchConstI64(indexConst, numericFacts);
  if (partIndex === undefined || partIndex < 0) return undefined;
  const defs = collectDefs(seq);
  if (localsUsedAfter(body, start + 13, defs)) return undefined;
  return {
    len: 13,
    recv: splitInst.recv,
    separator: splitArgs[0],
    joiner: joinArgs[0],
    partIndex,
    acc: sumCopy.dst,
  };
}

function tryEmitFusedPolymorphicPatternSplitJoinLoop(
  s: string[], cond: number, condBody: any[], body: any[], cx: EmitCtx, numericFacts: NumericAnalysis, top: number
): boolean {
  const select = parsePairSelect4(body, 0, numericFacts);
  if (select === undefined) return false;
  const metric = matchDynamicSplitJoinMetricShape(body, select.len, numericFacts);
  if (metric === undefined) return false;
  if (metric.separator !== select.dst1 || metric.joiner !== select.dst2) return false;
  for (const value of [...select.values1, ...select.values2]) {
    if (body.some((inst) => instDefLocal(inst) === value)) return false;
  }
  if (body.some((inst) => instDefLocal(inst) === metric.recv)) return false;
  const skip = select.len + metric.len;
  const skippedDefs = collectDefs(body.slice(0, skip));
  if (localsUsedAfter(body, skip, skippedDefs)) return false;

  const sepArr = `_fppsj_sep${top}`;
  const joinArr = `_fppsj_join${top}`;
  const metricArr = `_fppsj_metric${top}`;
  const okVar = `_fppsj_ok${top}`;
  const selVar = `_fppsj_sel${top}`;
  emitTsvArray4(s, sepArr, cx, select.values1);
  emitTsvArray4(s, joinArr, cx, select.values2);
  s.push(`  long long ${metricArr}[4];\n`);
  s.push(`  int ${okVar} = 1;\n`);
  s.push("  for (int _fppsj_i = 0; _fppsj_i < 4; _fppsj_i++) {\n");
  s.push(`    ${metricArr}[_fppsj_i] = ts_str_split_join_metric3(${cxVal(cx, metric.recv)}, ${sepArr}[_fppsj_i], ${joinArr}[_fppsj_i], ${metric.partIndex}LL);\n`);
  s.push(`    if (${metricArr}[_fppsj_i] < 0) ${okVar} = 0;\n`);
  s.push("  }\n");
  s.push(`  if (${okVar}) {\n`);
  emitCheckedLoop(s, cond, condBody, cx, numericFacts, () => {
    emitSelect4Clamped(s, selVar, cxNum(cx, select.pick));
    emitMetricAccAdd(s, metric.acc, `${metricArr}[${selVar}]`, cx);
    for (const inst of body.slice(skip)) emitInstC(s, inst, cx, numericFacts);
  });
  s.push("  } else {\n");
  emitRuntimeLoop(s, cond, condBody, body, cx, numericFacts);
  s.push("  }\n");
  return true;
}

interface DynamicReplaceEscapeSelectShape {
  select: SourceSelect4;
  skip: number;
  pattern: number;
  replacement: number;
  last: number;
  acc: number;
  mult: number;
  mask: number;
}

function matchDynamicReplaceEscapeSelectShape(body: any[], numericFacts: NumericAnalysis): DynamicReplaceEscapeSelectShape | undefined {
  const select = parseSourceSelect4(body, 0, numericFacts);
  if (select === undefined) return undefined;
  if (body.length - select.len < 25) return undefined;
  const seq = body.slice(select.len, select.len + 16);
  const [replaceInst, copyReplaced, copyLast, lenInst, sumLen, indexCall, sumIndex, lastCall, sumLast, multConst, mulInst, maskConst, maskInst, charCall, sumChar, sumCopy] = seq;
  if (
    replaceInst.kind !== "CallBuiltin" || replaceInst.dst === undefined || replaceInst.dst === null ||
    copyReplaced.kind !== "Copy" ||
    copyLast.kind !== "Copy" ||
    lenInst.kind !== "GenericLen" ||
    sumLen.kind !== "BinOp" ||
    indexCall.kind !== "Call" || indexCall.dst === undefined || indexCall.dst === null || indexCall.recv === undefined || indexCall.recv === null ||
    sumIndex.kind !== "BinOp" ||
    lastCall.kind !== "Call" || lastCall.dst === undefined || lastCall.dst === null || lastCall.recv === undefined || lastCall.recv === null ||
    sumLast.kind !== "BinOp" ||
    mulInst.kind !== "BinOp" ||
    maskInst.kind !== "BinOp" ||
    charCall.kind !== "Call" || charCall.dst === undefined || charCall.dst === null || charCall.recv === undefined || charCall.recv === null ||
    sumChar.kind !== "BinOp" ||
    sumCopy.kind !== "Copy"
  ) {
    return undefined;
  }
  const replaceArgs: number[] = replaceInst.args ?? [];
  const indexArgs: number[] = indexCall.args ?? [];
  const lastArgs: number[] = lastCall.args ?? [];
  const charArgs: number[] = charCall.args ?? [];
  const multDst = matchConstDst(multConst);
  const maskDst = matchConstDst(maskConst);
  if (multDst === undefined || maskDst === undefined) return undefined;
  if (
    replaceInst.builtin !== "string.replaceAll" ||
    replaceInst.recv !== select.dst ||
    replaceArgs.length !== 2 ||
    replaceInst.dst !== copyReplaced.src ||
    copyLast.src !== copyReplaced.dst ||
    lenInst.src !== copyReplaced.dst ||
    sumLen.op !== "+" ||
    lenInst.dst !== sumLen.rhs ||
    sumCopy.dst !== sumLen.lhs ||
    indexCall.recv !== copyReplaced.dst ||
    indexArgs.length !== 1 ||
    indexArgs[0] !== replaceArgs[1] ||
    sumIndex.op !== "+" ||
    sumLen.dst !== sumIndex.lhs ||
    indexCall.dst !== sumIndex.rhs ||
    lastCall.recv !== copyReplaced.dst ||
    lastArgs.length !== 1 ||
    lastArgs[0] !== replaceArgs[1] ||
    sumLast.op !== "+" ||
    sumIndex.dst !== sumLast.lhs ||
    lastCall.dst !== sumLast.rhs ||
    mulInst.op !== "*" ||
    maskInst.op !== "&" ||
    !addUses(mulInst.lhs, mulInst.rhs, select.pick, multDst) ||
    maskInst.lhs !== mulInst.dst ||
    maskInst.rhs !== maskDst ||
    charCall.recv !== copyReplaced.dst ||
    charArgs.length !== 1 ||
    charArgs[0] !== maskInst.dst ||
    sumChar.op !== "+" ||
    sumLast.dst !== sumChar.lhs ||
    charCall.dst !== sumChar.rhs ||
    sumChar.dst !== sumCopy.src
  ) {
    return undefined;
  }
  const mult = matchConstI64(multConst, numericFacts);
  const mask = matchConstI64(maskConst, numericFacts);
  if (mult === undefined || mask === undefined || mult < 0 || mask < 0) return undefined;
  for (const value of select.values) {
    if (body.some((inst) => instDefLocal(inst) === value)) return undefined;
  }
  if (body.some((inst) => {
    const d = instDefLocal(inst);
    return d === replaceArgs[0] || d === replaceArgs[1];
  })) {
    return undefined;
  }
  const skip = select.len + 16;
  const skippedDefs = collectDefs(body.slice(0, skip));
  skippedDefs.delete(copyLast.dst);
  skippedDefs.delete(sumCopy.dst);
  if (localsUsedAfter(body, skip, skippedDefs)) return undefined;
  return {
    select,
    skip,
    pattern: replaceArgs[0],
    replacement: replaceArgs[1],
    last: copyLast.dst,
    acc: sumCopy.dst,
    mult,
    mask,
  };
}

function tryEmitFusedDynamicReplaceEscapeSelectLoop(
  s: string[], cond: number, condBody: any[], body: any[], cx: EmitCtx, numericFacts: NumericAnalysis, top: number
): boolean {
  const shape = matchDynamicReplaceEscapeSelectShape(body, numericFacts);
  if (shape === undefined) return false;
  // In Rust this shape always fires via the string-materialization PLAN path
  // (checked before the inline arm, same match conditions), which allocates a
  // FRESH end label; the inline arm's end is dead. Replicate that numbering.
  const end = cx.labelCtr.n++;
  const srcArr = `_fdre_src${top}`;
  const outArr = `_fdre_out${top}`;
  const metricArr = `_fdre_metric${top}`;
  const selVar = `_fdre_sel${top}`;
  emitTsvArray4(s, srcArr, cx, shape.select.values);
  emitTsvUndefinedArray4(s, outArr);
  s.push(`  long long ${metricArr}[4];\n`);
  s.push("  for (int _fdre_i = 0; _fdre_i < 4; _fdre_i++) {\n");
  s.push(`    ${outArr}[_fdre_i] = ts_str_replace(${srcArr}[_fdre_i], ${cxVal(cx, shape.pattern)}, ${cxVal(cx, shape.replacement)}, 1);\n`);
  s.push(`    ts_gc_root(&${outArr}[_fdre_i]);\n`);
  s.push(`    ${metricArr}[_fdre_i] = (long long)ts_str_len_fast(${outArr}[_fdre_i]) + (long long)ts_str_indexof_fast(${outArr}[_fdre_i], ${cxVal(cx, shape.replacement)}, 0, 0) + (long long)ts_str_lastindexof_fast(${outArr}[_fdre_i], ${cxVal(cx, shape.replacement)}, (double)ts_str_len_fast(${outArr}[_fdre_i]), 1) + (long long)ts_str_charcodeat_i64_typed(${outArr}[_fdre_i], (long long)((_fdre_i * ${shape.mult}) & ${shape.mask}));\n`);
  s.push("  }\n");
  cx.loopLabels.push([top, end]);
  s.push(`  L${top}: ;\n`);
  emitCheckedLoop(s, cond, condBody, cx, numericFacts, () => {
    emitSelect4Clamped(s, selVar, cxNum(cx, shape.select.pick));
    s.push(cxSetVal(cx, shape.last, `${outArr}[${selVar}]`));
    emitMetricAccAdd(s, shape.acc, `${metricArr}[${selVar}]`, cx);
    for (const inst of body.slice(shape.skip)) emitInstC(s, inst, cx, numericFacts);
    s.push(`  goto L${top};\n`);
  });
  s.push(`  L${end}: ;\n`);
  s.push("  ts_gc_unroot(4);\n");
  cx.loopLabels.pop();
  return true;
}

interface StaticSplitJoinEscapeShape {
  recv: number;
  separator: string;
  joiner: string;
  last: number;
  acc: number;
  counter: CounterAddTail;
}

function matchStaticSplitJoinEscapeShape(body: any[], cx: EmitCtx, numericFacts: NumericAnalysis): StaticSplitJoinEscapeShape | undefined {
  if (body.length !== 21) return undefined;
  const [splitSepConst, splitInst, copyParts, joinSepConst, joinInst, copyJoined, copyLast, len1Inst, sumLen, zeroConst, firstInst, sumFirst, len2Inst, oneConst, lastIdxInst, lastInst, sumLast, sumCopy] = body;
  if (
    splitInst.kind !== "CallBuiltin" || splitInst.dst === undefined || splitInst.dst === null ||
    copyParts.kind !== "Copy" ||
    joinInst.kind !== "CallBuiltin" || joinInst.dst === undefined || joinInst.dst === null ||
    copyJoined.kind !== "Copy" ||
    copyLast.kind !== "Copy" ||
    len1Inst.kind !== "StringLen" ||
    sumLen.kind !== "BinOp" ||
    firstInst.kind !== "CallBuiltin" || firstInst.dst === undefined || firstInst.dst === null ||
    sumFirst.kind !== "BinOp" ||
    len2Inst.kind !== "StringLen" ||
    lastIdxInst.kind !== "BinOp" ||
    lastInst.kind !== "CallBuiltin" || lastInst.dst === undefined || lastInst.dst === null ||
    sumLast.kind !== "BinOp" ||
    sumCopy.kind !== "Copy"
  ) {
    return undefined;
  }
  const splitArgs: number[] = splitInst.args ?? [];
  const joinArgs: number[] = joinInst.args ?? [];
  const firstArgs: number[] = firstInst.args ?? [];
  const lastArgs: number[] = lastInst.args ?? [];
  if (
    splitInst.builtin !== "string.split" ||
    joinInst.builtin !== "array.join" ||
    splitArgs.length !== 1 ||
    splitArgs[0] !== matchConstDst(splitSepConst) ||
    splitInst.dst !== copyParts.src ||
    joinInst.recv !== copyParts.dst ||
    joinArgs.length !== 1 ||
    joinArgs[0] !== matchConstDst(joinSepConst) ||
    joinInst.dst !== copyJoined.src ||
    copyLast.src !== copyJoined.dst ||
    len1Inst.src !== copyJoined.dst ||
    sumLen.op !== "+" ||
    len1Inst.dst !== sumLen.rhs ||
    matchConstI64(zeroConst, numericFacts) !== 0 ||
    firstInst.builtin !== "string.charCodeAt" ||
    firstInst.recv !== copyJoined.dst ||
    firstArgs.length !== 1 ||
    firstArgs[0] !== matchConstDst(zeroConst) ||
    sumFirst.op !== "+" ||
    sumLen.dst !== sumFirst.lhs ||
    firstInst.dst !== sumFirst.rhs ||
    len2Inst.src !== copyJoined.dst ||
    matchConstI64(oneConst, numericFacts) !== 1 ||
    lastIdxInst.op !== "-" ||
    len2Inst.dst !== lastIdxInst.lhs ||
    lastIdxInst.rhs !== matchConstDst(oneConst) ||
    lastInst.builtin !== "string.charCodeAt" ||
    lastInst.recv !== copyJoined.dst ||
    lastArgs.length !== 1 ||
    lastArgs[0] !== lastIdxInst.dst ||
    sumLast.op !== "+" ||
    sumFirst.dst !== sumLast.lhs ||
    lastInst.dst !== sumLast.rhs ||
    sumLast.dst !== sumCopy.src ||
    sumCopy.dst !== sumLen.lhs ||
    !cx.intLocal.has(sumCopy.dst)
  ) {
    return undefined;
  }
  const counter = matchCounterAddTail(body, 18, cx, numericFacts);
  if (counter === undefined) return undefined;
  const splitRecv: number = splitInst.recv;
  if (body.some((inst) => instDefLocal(inst) === splitRecv)) return undefined;
  const splitSep = staticStringExprFromConst(splitSepConst, cx);
  const joinSep = staticStringExprFromConst(joinSepConst, cx);
  if (splitSep === undefined || joinSep === undefined) return undefined;
  return {
    recv: splitInst.recv,
    separator: splitSep,
    joiner: joinSep,
    last: copyLast.dst,
    acc: sumCopy.dst,
    counter,
  };
}

function tryEmitFusedSplitJoinEscapeLoop(
  s: string[], cond: number, condBody: any[], body: any[], cx: EmitCtx, numericFacts: NumericAnalysis, top: number
): boolean {
  const shape = matchStaticSplitJoinEscapeShape(body, cx, numericFacts);
  if (shape === undefined) return false;
  const base = cxVal(cx, shape.recv);
  const partsVar = `_fsje_parts${top}`;
  const joinedVar = `_fsje_joined${top}`;
  const lenVar = `_fsje_len${top}`;
  const incVar = `_fsje_inc${top}`;
  s.push(`  tsv ${partsVar} = ts_str_split(${base}, ${shape.separator}, TS_UNDEFINED);\n`);
  s.push(`  ts_gc_root(&${partsVar});\n`);
  s.push(`  tsv ${joinedVar} = ts_array_join(${partsVar}, ${shape.joiner});\n`);
  s.push(`  ts_gc_root(&${joinedVar});\n`);
  s.push(`  long long ${incVar} = -1;\n`);
  s.push(`  if (ts_is_str(${joinedVar})) { long long ${lenVar} = (long long)ts_str_len_typed(${joinedVar}); ${incVar} = ${lenVar} + ts_str_charcodeat_i64_typed(${joinedVar}, 0) + ts_str_charcodeat_i64_typed(${joinedVar}, ${lenVar} - 1); }\n`);
  s.push(`  if (${incVar} >= 0) {\n`);
  emitCheckedLoop(s, cond, condBody, cx, numericFacts, () => {
    s.push(cxSetVal(cx, shape.last, joinedVar));
    s.push(`  d${shape.acc} += ${incVar};\n`);
    s.push(`  d${shape.counter.counter} += ${shape.counter.inc}LL;\n`);
  });
  s.push("  ts_gc_unroot(2);\n");
  s.push("  } else {\n");
  s.push("  ts_gc_unroot(2);\n");
  emitRuntimeLoop(s, cond, condBody, body, cx, numericFacts);
  s.push("  }\n");
  return true;
}

// ------------------- fused concat-chain metric loop (_fccm) -------------------
// Faithful port of try_emit_fused_concat_chain_metric_loop: the 20-inst
// "s += (prefix+i+sep+marker+tail).length + first/last charCode + indexOf"
// chain becomes O(1)-per-iteration arithmetic with a runtime-checked fallback.

function matchConstDst(inst: any): number | undefined {
  return inst.kind === "Const" ? inst.dst : undefined;
}

function matchConstI64(inst: any, numericFacts: NumericAnalysis): number | undefined {
  const dst = matchConstDst(inst);
  if (dst === undefined) return undefined;
  return numericFacts.intConst.get(dst);
}

function collectDefs(seq: any[]): Set<number> {
  const out = new Set<number>();
  for (const inst of seq) {
    const d = instDefLocal(inst);
    if (d !== undefined && d !== null) out.add(d);
  }
  return out;
}

function localsUsedAfter(body: any[], from: number, ids: Set<number>): boolean {
  return body.slice(from).some((inst) => instUsesAny(inst, ids));
}

function emitMetricAccAdd(s: string[], acc: number, metric: string, cx: EmitCtx): void {
  if (cx.intLocal.has(acc)) s.push(`  d${acc} += ${metric};\n`);
  else if (cx.unboxed.has(acc)) s.push(`  d${acc} += (double)${metric};\n`);
  else s.push(`  v${acc} = ts_add(v${acc}, ts_num((double)${metric}));\n`);
}

function emitCheckedLoop(s: string[], cond: number, condBody: any[], cx: EmitCtx, numericFacts: NumericAnalysis, emitBody: () => void): void {
  s.push("  for (;;) {\n");
  for (const inst of condBody) emitInstC(s, inst, cx, numericFacts);
  s.push(`    if (!${cxTruthy(cx, cond)}) break;\n`);
  emitBody();
  s.push("  }\n");
}

function emitRuntimeLoop(s: string[], cond: number, condBody: any[], body: any[], cx: EmitCtx, numericFacts: NumericAnalysis): void {
  emitCheckedLoop(s, cond, condBody, cx, numericFacts, () => {
    for (const inst of body) emitInstC(s, inst, cx, numericFacts);
  });
}

function tryEmitFusedConcatChainMetricLoop(
  s: string[],
  cond: number,
  condBody: any[],
  body: any[],
  cx: EmitCtx,
  numericFacts: NumericAnalysis
): boolean {
  if (body.length !== 20) return false;
  const sepConst = body[0];
  const concatInst = body[1];
  const copyConcat = body[2];
  const copyLast = body[3];
  const len1Inst = body[4];
  const sumLen = body[5];
  const zeroConst = body[6];
  const firstInst = body[7];
  const sumFirst = body[8];
  const len2Inst = body[9];
  const oneConst = body[10];
  const lastIdxInst = body[11];
  const lastCharInst = body[12];
  const sumLast = body[13];
  const indexInst = body[14];
  const sumIndex = body[15];
  const sumCopy = body[16];
  const counterIncConst = body[17];
  const counterAdd = body[18];
  const counterCopy = body[19];
  if (
    sepConst.kind !== "Const" ||
    concatInst.kind !== "CallBuiltinStatic" || concatInst.dst === undefined || concatInst.dst === null ||
    copyConcat.kind !== "Copy" ||
    copyLast.kind !== "Copy" ||
    len1Inst.kind !== "StringLen" ||
    sumLen.kind !== "BinOp" ||
    zeroConst.kind !== "Const" ||
    firstInst.kind !== "CallBuiltin" || firstInst.dst === undefined || firstInst.dst === null ||
    sumFirst.kind !== "BinOp" ||
    len2Inst.kind !== "StringLen" ||
    oneConst.kind !== "Const" ||
    lastIdxInst.kind !== "BinOp" ||
    lastCharInst.kind !== "CallBuiltin" || lastCharInst.dst === undefined || lastCharInst.dst === null ||
    sumLast.kind !== "BinOp" ||
    indexInst.kind !== "CallBuiltin" || indexInst.dst === undefined || indexInst.dst === null ||
    sumIndex.kind !== "BinOp" ||
    sumCopy.kind !== "Copy" ||
    counterIncConst.kind !== "Const" ||
    counterAdd.kind !== "BinOp" ||
    counterCopy.kind !== "Copy"
  ) {
    return false;
  }
  const concatArgs: number[] = concatInst.args ?? [];
  const firstArgs: number[] = firstInst.args ?? [];
  const lastCharArgs: number[] = lastCharInst.args ?? [];
  const indexArgs: number[] = indexInst.args ?? [];
  if (
    concatInst.builtin !== "string.concatMany" ||
    concatArgs.length !== 5 ||
    matchConstDst(sepConst) !== concatArgs[2] ||
    concatInst.dst !== copyConcat.src ||
    copyConcat.dst !== copyLast.src ||
    len1Inst.src !== copyConcat.dst ||
    sumLen.op !== "+" ||
    sumLen.lhs !== sumCopy.dst ||
    sumLen.rhs !== len1Inst.dst ||
    firstInst.builtin !== "string.charCodeAt" ||
    firstInst.recv !== copyConcat.dst ||
    firstArgs.length !== 1 ||
    firstArgs[0] !== matchConstDst(zeroConst) ||
    matchConstI64(zeroConst, numericFacts) !== 0 ||
    sumFirst.op !== "+" ||
    sumFirst.lhs !== sumLen.dst ||
    sumFirst.rhs !== firstInst.dst ||
    len2Inst.src !== copyConcat.dst ||
    lastIdxInst.op !== "-" ||
    lastIdxInst.lhs !== len2Inst.dst ||
    lastIdxInst.rhs !== matchConstDst(oneConst) ||
    matchConstI64(oneConst, numericFacts) !== 1 ||
    lastCharInst.builtin !== "string.charCodeAt" ||
    lastCharInst.recv !== copyConcat.dst ||
    lastCharArgs.length !== 1 ||
    lastCharArgs[0] !== lastIdxInst.dst ||
    sumLast.op !== "+" ||
    sumLast.lhs !== sumFirst.dst ||
    sumLast.rhs !== lastCharInst.dst ||
    indexInst.builtin !== "string.indexOf" ||
    indexInst.recv !== copyConcat.dst ||
    indexArgs.length !== 1 ||
    indexArgs[0] !== concatArgs[3] ||
    sumIndex.op !== "+" ||
    sumIndex.lhs !== sumLast.dst ||
    sumIndex.rhs !== indexInst.dst ||
    sumIndex.dst !== sumCopy.src ||
    counterAdd.op !== "+" ||
    counterAdd.dst !== counterCopy.src
  ) {
    return false;
  }
  const counter: number = counterCopy.dst;
  const counterInc = matchConstI64(counterIncConst, numericFacts);
  let counterOk = false;
  if (counterAdd.lhs === counter) counterOk = counterAdd.rhs === matchConstDst(counterIncConst);
  else if (counterAdd.rhs === counter) counterOk = counterAdd.lhs === matchConstDst(counterIncConst);
  if (
    !counterOk ||
    counterInc !== 1 ||
    concatArgs[1] !== counter ||
    !cx.intLocal.has(counter) ||
    !cx.intLocal.has(sumCopy.dst)
  ) {
    return false;
  }
  let limit: number | undefined;
  if (condBody.length === 1) {
    const cb = condBody[0];
    if (cb.kind === "BinOp" && cb.dst === cond && cb.op === "<" && cb.lhs === counter && cx.intLocal.has(cb.rhs)) {
      limit = cb.rhs;
    }
  }
  if (limit === undefined) return false;

  for (const value of [concatArgs[0], concatArgs[3], concatArgs[4]]) {
    if (body.some((inst) => instDefLocal(inst) === value)) return false;
  }
  const skippedDefs = collectDefs(body);
  skippedDefs.delete(copyLast.dst);
  skippedDefs.delete(sumCopy.dst);
  skippedDefs.delete(counter);
  if (localsUsedAfter(body, body.length, skippedDefs)) return false;

  const prefix = cxVal(cx, concatArgs[0]);
  const sep = cxVal(cx, concatArgs[2]);
  const marker = cxVal(cx, concatArgs[3]);
  const tail = cxVal(cx, concatArgs[4]);

  emitInstC(s, sepConst, cx, numericFacts);
  s.push(`  long long _fccm_start = d${counter};\n`);
  s.push(`  if (ts_is_str(${prefix}) && ts_is_str(${sep}) && ts_is_str(${marker}) && ts_is_str(${tail}) && d${counter} >= 0 && d${limit} <= 9007199254740991LL) {\n`);
  s.push(`  long long _fccm_prefix_len = (long long)ts_str_len_typed(${prefix});\n`);
  s.push(`  long long _fccm_sep_len = (long long)ts_str_len_typed(${sep});\n`);
  s.push(`  long long _fccm_marker_len = (long long)ts_str_len_typed(${marker});\n`);
  s.push(`  long long _fccm_tail_len = (long long)ts_str_len_typed(${tail});\n`);
  s.push(`  long long _fccm_first_ch = _fccm_prefix_len > 0 ? ts_str_charcodeat_i64_typed(${prefix}, 0) : -1;\n`);
  s.push(`  long long _fccm_last_ch = _fccm_tail_len > 0 ? ts_str_charcodeat_i64_typed(${tail}, _fccm_tail_len - 1) : -1;\n`);
  s.push(`  long long _fccm_marker0 = _fccm_marker_len > 0 ? ts_str_charcodeat_i64_typed(${marker}, 0) : -1;\n`);
  s.push(`  if (_fccm_prefix_len > 0 && _fccm_marker_len > 0 && _fccm_tail_len > 0 && (_fccm_marker_len != 1 || _fccm_marker0 < '0' || _fccm_marker0 > '9') && ts_str_indexof_fast(${prefix}, ${marker}, 0, 0) < 0 && ts_str_indexof_fast(${sep}, ${marker}, 0, 0) < 0) {\n`);
  emitCheckedLoop(s, cond, condBody, cx, numericFacts, () => {
    s.push(`  long long _fccm_digits = ts_i64_decimal_len_nonneg(d${counter});\n`);
    s.push(`  long long _fccm_metric = (_fccm_prefix_len + _fccm_sep_len + _fccm_marker_len + _fccm_tail_len + _fccm_digits) + _fccm_first_ch + _fccm_last_ch + (_fccm_prefix_len + _fccm_sep_len + _fccm_digits);\n`);
    emitMetricAccAdd(s, sumCopy.dst, "_fccm_metric", cx);
    s.push(`  d${counter} += 1LL;\n`);
  });
  s.push(`  if (d${counter} != _fccm_start) {\n`);
  s.push(`    long long _fccm_last_num = d${counter} - 1LL;\n`);
  s.push("    { tsv _fccm_args[5];\n");
  s.push(`      _fccm_args[0] = ${prefix};\n`);
  s.push("      _fccm_args[1] = ts_num((double)_fccm_last_num);\n");
  s.push(`      _fccm_args[2] = ${sep};\n`);
  s.push(`      _fccm_args[3] = ${marker};\n`);
  s.push(`      _fccm_args[4] = ${tail};\n`);
  s.push("      tsv _fccm_last = ts_str_concat_many(_fccm_args, 5);\n");
  s.push(cxSetVal(cx, copyLast.dst, "_fccm_last"));
  s.push("    }\n");
  s.push("  }\n");
  s.push("  } else {\n");
  emitRuntimeLoop(s, cond, condBody, body, cx, numericFacts);
  s.push("  }\n");
  s.push("  } else {\n");
  emitRuntimeLoop(s, cond, condBody, body, cx, numericFacts);
  s.push("  }\n");
  return true;
}

// ------------------------------ JSON DOM fast path ---------------------------
// Faithful port of collect_json_dom_locals and friends: JSON.parse trees kept
// as raw tjson_value* when every use is read-only / value-faithful.

function jsonDomDefBuiltin(b: string): boolean {
  return b === "json.dom.parse" || b === "json.dom.index" || b.startsWith("json.dom.get:");
}

function jsonDomInstScan(body: any[], out: Set<number>): boolean {
  let changed = false;
  const add = (id: number): void => {
    if (!out.has(id)) {
      out.add(id);
      changed = true;
    }
  };
  for (const inst of body) {
    switch (inst.kind) {
      case "CallBuiltinStatic":
        if (inst.dst !== undefined && inst.dst !== null && jsonDomDefBuiltin(inst.builtin)) add(inst.dst);
        break;
      case "Copy":
        if (out.has(inst.src)) add(inst.dst);
        break;
      case "LoadField":
        if (out.has(inst.obj)) add(inst.dst);
        break;
      case "LoadIndex":
        if (out.has(inst.arr)) add(inst.dst);
        break;
      case "LoadFieldDynamic":
        if (out.has(inst.obj)) add(inst.dst);
        break;
      case "Loop":
        if (jsonDomInstScan(inst.condBody ?? [], out)) changed = true;
        if (jsonDomInstScan(inst.body ?? [], out)) changed = true;
        break;
      case "If":
        if (jsonDomInstScan(inst.thenBody ?? [], out)) changed = true;
        if (jsonDomInstScan(inst.elseBody ?? [], out)) changed = true;
        break;
      case "TryCatch":
        if (jsonDomInstScan(inst.tryBody ?? [], out)) changed = true;
        if (jsonDomInstScan(inst.catchBody ?? [], out)) changed = true;
        if (jsonDomInstScan(inst.finallyBody ?? [], out)) changed = true;
        break;
      default:
        break;
    }
  }
  return changed;
}

function calleeUsesAnyIds(callee: any, ids: Set<number>): boolean {
  return (callee ?? {}).kind === "Value" && ids.has(callee.local);
}

/** Mirrors inst_uses_any: does inst (shallowly, recursing into bodies) use any
 *  of `ids`? */
function instUsesAny(inst: any, ids: Set<number>): boolean {
  const d = (x: any): boolean => x !== undefined && x !== null && ids.has(x);
  switch (inst.kind) {
    case "AllocObject": return d(inst.proto);
    case "AllocClosure": case "AllocClassValue": return ((inst.captures ?? []) as any[]).some((c) => ids.has(c.cell));
    case "Copy": case "StoreElem": case "StoreGlobal": case "Throw": case "Print":
    case "ArrayPush": case "ArrayPushAll": case "ObjectRest": case "StoreProtoMethod": case "StoreMethod":
      return d(inst.src);
    case "Return": return d(inst.src);
    case "Yield": case "Await": return d(inst.operand);
    case "UnOp": return d(inst.operand);
    case "ObjectCopyProps": return d(inst.src);
    case "LoadField": case "DeleteField": case "GetProto": return d(inst.obj);
    case "LoadMethodValue": return d(inst.recv);
    case "NewDynamic": return d(inst.callee) || ((inst.args ?? []) as any[]).some((a) => ids.has(a));
    case "LoadElem": case "ArrayLen": return d(inst.arr);
    case "StringLen": case "GenericLen": return d(inst.src);
    case "StoreField": return d(inst.obj) || d(inst.src);
    case "SetProto": return d(inst.obj) || d(inst.proto);
    case "StoreFieldDynamic": return d(inst.obj) || d(inst.key) || d(inst.src);
    case "StoreIndex": return d(inst.arr) || d(inst.index) || d(inst.src);
    case "Call":
      return d(inst.recv) || calleeUsesAnyIds(inst.callee, ids) || ((inst.args ?? []) as any[]).some((a) => ids.has(a));
    case "CallSpread":
      return d(inst.recv) || calleeUsesAnyIds(inst.callee, ids) || ((inst.argSpecs ?? []) as any[]).some((a) => ids.has(a.local));
    case "TryCatch":
      return (
        ((inst.tryBody ?? []) as any[]).some((i) => instUsesAny(i, ids)) ||
        ((inst.catchBody ?? []) as any[]).some((i) => instUsesAny(i, ids)) ||
        ((inst.finallyBody ?? []) as any[]).some((i) => instUsesAny(i, ids))
      );
    case "BinOp": return d(inst.lhs) || d(inst.rhs);
    case "LoadIndex": return d(inst.arr) || d(inst.index);
    case "HasFieldDynamic": case "LoadFieldDynamic": return d(inst.obj) || d(inst.key);
    case "CallBuiltin": return d(inst.recv) || ((inst.args ?? []) as any[]).some((a) => ids.has(a));
    case "CallBuiltinStatic": return ((inst.args ?? []) as any[]).some((a) => ids.has(a));
    case "If":
      return (
        d(inst.cond) ||
        ((inst.thenBody ?? []) as any[]).some((i) => instUsesAny(i, ids)) ||
        ((inst.elseBody ?? []) as any[]).some((i) => instUsesAny(i, ids))
      );
    case "Loop":
      return (
        d(inst.cond) ||
        ((inst.condBody ?? []) as any[]).some((i) => instUsesAny(i, ids)) ||
        ((inst.body ?? []) as any[]).some((i) => instUsesAny(i, ids))
      );
    case "HasField": return d(inst.obj);
    case "ConstructResult": return d(inst.inst) || d(inst.ret);
    default: return false;
  }
}

/** Mirrors json_dom_escapes_body: any non-whitelisted use vetoes the fast path. */
function jsonDomEscapesBody(body: any[], doms: Set<number>): boolean {
  const d = (x: any): boolean => x !== undefined && x !== null && doms.has(x);
  for (const inst of body) {
    let escapes: boolean;
    switch (inst.kind) {
      case "Loop":
        escapes = jsonDomEscapesBody(inst.condBody ?? [], doms) || jsonDomEscapesBody(inst.body ?? [], doms);
        break;
      case "If":
        escapes = jsonDomEscapesBody(inst.thenBody ?? [], doms) || jsonDomEscapesBody(inst.elseBody ?? [], doms);
        break;
      case "TryCatch":
        escapes =
          jsonDomEscapesBody(inst.tryBody ?? [], doms) ||
          jsonDomEscapesBody(inst.catchBody ?? [], doms) ||
          jsonDomEscapesBody(inst.finallyBody ?? [], doms);
        break;
      // whitelisted read-only / value-faithful uses
      case "LoadField": case "LoadFieldDynamic": case "LoadIndex": case "Copy":
      case "ArrayLen": case "StringLen": case "GenericLen": case "HasField":
      case "HasFieldDynamic": case "UnOp": case "Print": case "Const":
      case "LoadGlobal": case "LoadBuiltinFn": case "LoadClassProto": case "LoadElem":
      case "NewMap": case "NewSet": case "AllocObject": case "AllocArray":
      case "Break": case "Continue": case "GetProto": case "LoadMethodValue":
        escapes = false;
        break;
      case "BinOp":
        escapes = (inst.op === "===" || inst.op === "!==" || inst.op === "==" || inst.op === "!=") && (d(inst.lhs) || d(inst.rhs));
        break;
      case "CallBuiltinStatic": {
        const b: string = inst.builtin;
        if (b.startsWith("json.dom.") || b.startsWith("json.stringify") || b.startsWith("console.")) escapes = false;
        else escapes = ((inst.args ?? []) as any[]).some((a) => d(a));
        break;
      }
      case "Call":
        escapes = d(inst.recv) || ((inst.args ?? []) as any[]).some((a) => d(a));
        break;
      case "CallSpread":
        escapes = d(inst.recv) || ((inst.argSpecs ?? []) as any[]).some((a) => d(a.local));
        break;
      case "CallBuiltin":
        escapes = d(inst.recv) || ((inst.args ?? []) as any[]).some((a) => d(a));
        break;
      case "NewDynamic":
        escapes = d(inst.callee) || ((inst.args ?? []) as any[]).some((a) => d(a));
        break;
      case "StoreField": case "StoreFieldDynamic":
        escapes = d(inst.obj) || d(inst.src);
        break;
      case "StoreIndex": case "StoreElem":
        escapes = d(inst.arr) || d(inst.src);
        break;
      case "StoreGlobal":
        escapes = d(inst.src);
        break;
      case "ArrayPush": case "ArrayPushAll":
        escapes = d(inst.arr) || d(inst.src);
        break;
      case "StoreProtoMethod": case "StoreMethod":
        escapes = d(inst.src);
        break;
      case "AllocClosure": case "AllocClassValue":
        escapes = ((inst.captures ?? []) as any[]).some((c) => d(c.cell));
        break;
      case "Return": case "Throw":
        escapes = d(inst.src);
        break;
      case "Yield": case "Await":
        escapes = d(inst.operand);
        break;
      case "SetProto":
        escapes = d(inst.obj) || d(inst.proto);
        break;
      case "DeleteField":
        escapes = d(inst.obj);
        break;
      case "ArraySlice":
        escapes = d(inst.arr);
        break;
      case "ObjectRest":
        escapes = d(inst.src);
        break;
      case "ObjectCopyProps":
        escapes = d(inst.dst) || d(inst.src);
        break;
      case "ConstructResult":
        escapes = d(inst.inst) || d(inst.ret);
        break;
      default:
        escapes = false;
        break;
    }
    if (escapes) return true;
  }
  return false;
}

function jsonDomDefinedDst(inst: any): number | undefined {
  switch (inst.kind) {
    case "AllocObject": case "AllocArray": case "AllocClosure": case "Copy":
    case "LoadField": case "LoadMethodValue": case "LoadBuiltinFn": case "AllocClassValue":
    case "NewDynamic": case "LoadElem": case "Const": case "BinOp": case "UnOp":
    case "LoadIndex": case "ArrayLen": case "StringLen": case "HasField":
    case "HasFieldDynamic": case "GenericLen": case "LoadFieldDynamic": case "ArraySlice":
    case "ObjectRest": case "ObjectCopyProps": case "ConstructResult": case "LoadClassProto":
    case "GetProto": case "NewMap": case "NewSet":
      return inst.dst;
    case "Call": case "Yield": case "Await": case "DeleteField":
    case "CallSpread": case "CallBuiltin": case "CallBuiltinStatic": case "SetProto":
      return inst.dst !== undefined && inst.dst !== null ? inst.dst : undefined;
    default:
      return undefined;
  }
}

function jsonDomDefMatches(inst: any, candidates: Set<number>): boolean {
  switch (inst.kind) {
    case "CallBuiltinStatic":
      return inst.dst !== undefined && inst.dst !== null && candidates.has(inst.dst) && jsonDomDefBuiltin(inst.builtin);
    case "Copy":
      return candidates.has(inst.dst) && candidates.has(inst.src);
    case "LoadField":
      return candidates.has(inst.dst) && candidates.has(inst.obj);
    case "LoadIndex":
      return candidates.has(inst.dst) && candidates.has(inst.arr);
    case "LoadFieldDynamic":
      return candidates.has(inst.dst) && candidates.has(inst.obj);
    default:
      return false;
  }
}

function jsonDomHasMixedDefs(body: any[], candidates: Set<number>): boolean {
  if (candidates.size === 0) return false;
  for (const inst of body) {
    const dst = jsonDomDefinedDst(inst);
    if (dst !== undefined && dst !== null && candidates.has(dst) && !jsonDomDefMatches(inst, candidates)) return true;
    if (inst.kind === "TryCatch") {
      if (inst.catchVar !== undefined && inst.catchVar !== null && candidates.has(inst.catchVar)) return true;
      if (
        jsonDomHasMixedDefs(inst.tryBody ?? [], candidates) ||
        jsonDomHasMixedDefs(inst.catchBody ?? [], candidates) ||
        jsonDomHasMixedDefs(inst.finallyBody ?? [], candidates)
      ) return true;
    } else if (inst.kind === "Loop") {
      if (jsonDomHasMixedDefs(inst.condBody ?? [], candidates) || jsonDomHasMixedDefs(inst.body ?? [], candidates)) return true;
    } else if (inst.kind === "If") {
      if (jsonDomHasMixedDefs(inst.thenBody ?? [], candidates) || jsonDomHasMixedDefs(inst.elseBody ?? [], candidates)) return true;
    }
  }
  return false;
}

function collectJsonDomLocals(body: any[]): Set<number> {
  const out = new Set<number>();
  while (jsonDomInstScan(body, out)) { /* fixpoint */ }
  if (jsonDomHasMixedDefs(body, out)) return new Set<number>();
  if (jsonDomEscapesBody(body, out)) return new Set<number>();
  return out;
}

function collectJsonDomParseRoots(body: any[]): Set<number> {
  const out = new Set<number>();
  const walk = (b: any[]): void => {
    for (const inst of b) {
      if (inst.kind === "CallBuiltinStatic" && inst.builtin === "json.dom.parse" && inst.dst !== undefined && inst.dst !== null) {
        out.add(inst.dst);
      } else if (inst.kind === "Loop") {
        walk(inst.condBody ?? []);
        walk(inst.body ?? []);
      } else if (inst.kind === "If") {
        walk(inst.thenBody ?? []);
        walk(inst.elseBody ?? []);
      } else if (inst.kind === "TryCatch") {
        walk(inst.tryBody ?? []);
        walk(inst.catchBody ?? []);
        walk(inst.finallyBody ?? []);
      }
    }
  };
  walk(body);
  return out;
}

function domInstRefs(inst: any, locals: Set<number>): boolean {
  const dst = jsonDomDefinedDst(inst);
  if (dst !== undefined && dst !== null && locals.has(dst)) return true;
  if (inst.kind === "If" || inst.kind === "Loop") return locals.has(inst.cond);
  if (inst.kind === "TryCatch") return false;
  return instUsesAny(inst, locals);
}

function domRefCount(body: any[], locals: Set<number>): number {
  let n = 0;
  for (const inst of body) {
    if (domInstRefs(inst, locals)) n += 1;
    if (inst.kind === "If") {
      n += domRefCount(inst.thenBody ?? [], locals);
      n += domRefCount(inst.elseBody ?? [], locals);
    } else if (inst.kind === "Loop") {
      n += domRefCount(inst.condBody ?? [], locals);
      n += domRefCount(inst.body ?? [], locals);
    } else if (inst.kind === "TryCatch") {
      n += domRefCount(inst.tryBody ?? [], locals);
      n += domRefCount(inst.catchBody ?? [], locals);
      n += domRefCount(inst.finallyBody ?? [], locals);
    }
  }
  return n;
}

function domDefsDominateUses(body: any[], locals: Set<number>, defined: Set<number>): boolean {
  for (const inst of body) {
    if (inst.kind === "If") {
      if (locals.has(inst.cond) && !defined.has(inst.cond)) return false;
      const dt = new Set(defined);
      if (!domDefsDominateUses(inst.thenBody ?? [], locals, dt)) return false;
      const de = new Set(defined);
      if (!domDefsDominateUses(inst.elseBody ?? [], locals, de)) return false;
      defined.clear();
      for (const x of dt) if (de.has(x)) defined.add(x);
    } else if (inst.kind === "Loop") {
      if (locals.has(inst.cond) && !defined.has(inst.cond)) return false;
      const dl = new Set(defined);
      if (!domDefsDominateUses(inst.condBody ?? [], locals, dl)) return false;
      if (!domDefsDominateUses(inst.body ?? [], locals, dl)) return false;
    } else if (inst.kind === "TryCatch") {
      const dt = new Set(defined);
      if (!domDefsDominateUses(inst.tryBody ?? [], locals, dt)) return false;
      const dc = new Set(defined);
      if (!domDefsDominateUses(inst.catchBody ?? [], locals, dc)) return false;
      const df = new Set(defined);
      if (!domDefsDominateUses(inst.finallyBody ?? [], locals, df)) return false;
    } else {
      const undef = new Set<number>();
      for (const x of locals) if (!defined.has(x)) undef.add(x);
      if (undef.size > 0 && instUsesAny(inst, undef)) return false;
      const dst = jsonDomDefinedDst(inst);
      if (dst !== undefined && dst !== null && locals.has(dst)) defined.add(dst);
    }
  }
  return true;
}

function loopBodyFreesJsonDom(loopBody: any[], locals: Set<number>, domRefTotal: number): boolean {
  if (locals.size === 0 || domRefTotal === 0) return false;
  if (domRefCount(loopBody, locals) !== domRefTotal) return false;
  return domDefsDominateUses(loopBody, locals, new Set<number>());
}

// ------------------------------ proto setups --------------------------------

function protoSetups(prog: any, needsRegexp: boolean, needsUnicode: boolean): string {
  let s = "";
  const reg = (fnName: string, init: string, arr: { methodId: number; name: string; runtime: string }[], regFn: string) => {
    s += `static void ${fnName}(void){\n`;
    s += `  ${init}\n`;
    for (const m of arr) {
      s += `  ${regFn}(TS_KEY_METHOD(${m.methodId}u), ${cStringLit(m.name)}, ${m.runtime});\n`;
    }
    s += "}\n\n";
  };
  // object (with special keys interleaved)
  s += "static tsv OBJECT_PROTO;\n";
  s += "static void ts_setup_object_proto(void){\n";
  s += "  OBJECT_PROTO = ts_new_proto(); ts_gc_root(&OBJECT_PROTO);\n";
  s += "  ts_install_object_proto(OBJECT_PROTO);\n";
  s += "  ts_function_proto_init();\n";
  for (const m of prog.objectProtoMethods ?? []) {
    s += `  ts_object_proto_register(TS_KEY_METHOD(${m.methodId}u), ${cStringLit(m.name)}, ${m.runtime});\n`;
    if (m.name === "toString") s += `  ts_set_tostring_key(TS_KEY_METHOD(${m.methodId}u));\n`;
    if (m.name === "valueOf") s += `  ts_set_valueof_key(TS_KEY_METHOD(${m.methodId}u));\n`;
    if (m.name === "toJSON") s += `  ts_set_tojson_key(TS_KEY_METHOD(${m.methodId}u));\n`;
  }
  s += "}\n\n";
  reg("ts_setup_array_proto", "ts_array_proto_init();", prog.arrayProtoMethods ?? [], "ts_array_proto_register");
  reg("ts_setup_promise_proto", "ts_promise_proto_init();", prog.promiseProtoMethods ?? [], "ts_promise_proto_register");
  reg("ts_setup_map_proto", "ts_map_proto_init();", prog.mapProtoMethods ?? [], "ts_map_proto_register");
  reg("ts_setup_set_proto", "ts_set_proto_init();", prog.setProtoMethods ?? [], "ts_set_proto_register");
  reg("ts_setup_headers_proto", "ts_headers_proto_init();", prog.headersProtoMethods ?? [], "ts_headers_proto_register");
  reg("ts_setup_function_proto", "ts_function_proto_init();", prog.functionProtoMethods ?? [], "ts_function_proto_register");
  // string (unicode-gated remap; `normalize` skipped without unicode)
  s += "static void ts_setup_string_proto(void){\n";
  s += "  ts_string_proto_init();\n";
  for (const m of prog.stringProtoMethods ?? []) {
    if (m.name !== "normalize" || needsUnicode) {
      let runtime = m.runtime;
      if (needsUnicode && m.name === "toUpperCase") runtime = "ts_unicode_strproto_toUpperCase";
      else if (needsUnicode && m.name === "toLowerCase") runtime = "ts_unicode_strproto_toLowerCase";
      else if (needsUnicode && m.name === "toLocaleUpperCase") runtime = "ts_unicode_strproto_toLocaleUpperCase";
      else if (needsUnicode && m.name === "toLocaleLowerCase") runtime = "ts_unicode_strproto_toLocaleLowerCase";
      s += `  ts_string_proto_register(TS_KEY_METHOD(${m.methodId}u), ${cStringLit(m.name)}, ${runtime});\n`;
    }
  }
  s += "}\n\n";
  if (needsRegexp) {
    s += "static void ts_setup_regexp_proto(void){\n";
    s += "  ts_regexp_proto_init();\n";
    for (const m of prog.regexpProtoMethods ?? []) {
      s += `  ts_regexp_proto_register(TS_KEY_METHOD(${m.methodId}u), ${cStringLit(m.name)}, ${m.runtime});\n`;
    }
    s += "}\n\n";
    s += "static tsv ts_regexpproto_test(tsv* args, int nargs){\n";
    s += '  if(nargs < 1 || !ts_regexp_is_object(args[0])) { ts_throw_type_error_msg("RegExp.prototype.test called on incompatible receiver"); return TS_UNDEFINED; }\n';
    s += "  tsv input = nargs > 1 ? args[1] : TS_UNDEFINED;\n";
    s += "  tsv s = ts_to_string_v(input);\n";
    s += "  return ts_regexp_adapter_object_test_tsv(args[0], s);\n";
    s += "}\n";
    s += "static tsv ts_regexpproto_exec(tsv* args, int nargs){\n";
    s += '  if(nargs < 1 || !ts_regexp_is_object(args[0])) { ts_throw_type_error_msg("RegExp.prototype.exec called on incompatible receiver"); return TS_UNDEFINED; }\n';
    s += "  tsv input = nargs > 1 ? args[1] : TS_UNDEFINED;\n";
    s += "  tsv s = ts_to_string_v(input);\n";
    s += "  return ts_regexp_adapter_object_exec_tsv(args[0], s);\n";
    s += "}\n\n";
  } else {
    s += "static void ts_setup_regexp_proto(void){}\n\n";
  }
  reg("ts_setup_number_proto", "ts_number_proto_init();", prog.numberProtoMethods ?? [], "ts_number_proto_register");
  reg("ts_setup_boolean_proto", "ts_boolean_proto_init();", prog.booleanProtoMethods ?? [], "ts_boolean_proto_register");
  return s;
}

// --------------------------- numeric facts engine ----------------------------
// Faithful port of emit_c.rs's NumFact lattice + infer_numeric_analysis.
// NOTE on arithmetic: Rust uses i64/i128; here doubles. All STORED facts are
// within ±2^53 (exact in a double). Intermediates (sums/products before the
// safe-range check) may round at the single boundary value 2^53+1 — a 1-ulp
// caveat the byte-diff harness would surface if a fixture ever hits it.

const JS_SAFE_INT = 9007199254740992; // 2^53
const NUMFACT_RANGE_MAX_WIDTH = 4096;

interface NumFact {
  i64Safe: boolean;
  nonneg: boolean;
  maybeZero: boolean;
  constI64: number | undefined;
  minI64: number | undefined;
  maxI64: number | undefined;
}

const nfUnknown = (): NumFact => ({ i64Safe: false, nonneg: false, maybeZero: true, constI64: undefined, minI64: undefined, maxI64: undefined });
const nfIntConst = (n: number): NumFact => ({ i64Safe: true, nonneg: n >= 0, maybeZero: n === 0, constI64: n, minI64: n, maxI64: n });
const nfI64Value = (): NumFact => ({ i64Safe: true, nonneg: false, maybeZero: true, constI64: undefined, minI64: undefined, maxI64: undefined });
const nfNonnegI64 = (): NumFact => ({ i64Safe: true, nonneg: true, maybeZero: true, constI64: undefined, minI64: undefined, maxI64: undefined });
function nfRange(min: number, max: number): NumFact {
  if (min === max) return nfIntConst(min);
  return { i64Safe: true, nonneg: min >= 0, maybeZero: min <= 0 && max >= 0, constI64: undefined, minI64: min, maxI64: max };
}
const nfBool = (): NumFact => nfRange(0, 1);

function rangeWidthOk(min: number, max: number): boolean {
  return min <= max && max - min <= NUMFACT_RANGE_MAX_WIDTH;
}
function checkedSafeI64(n: number): number | undefined {
  return n >= -JS_SAFE_INT && n <= JS_SAFE_INT ? n : undefined;
}
function checkedRange(min: number, max: number): NumFact | undefined {
  const mn = checkedSafeI64(min);
  const mx = checkedSafeI64(max);
  if (mn === undefined || mx === undefined) return undefined;
  if (mn <= mx && rangeWidthOk(mn, mx)) return nfRange(mn, mx);
  return undefined;
}
function rangeOf(f: NumFact): [number, number] | undefined {
  return f.minI64 !== undefined && f.maxI64 !== undefined ? [f.minI64, f.maxI64] : undefined;
}
function safeI64Num(v: number): number | undefined {
  if (v === 0 && Object.is(v, -0)) return undefined;
  if (Number.isFinite(v) && Number.isInteger(v) && Math.abs(v) <= JS_SAFE_INT) return v;
  return undefined;
}
function nfJoin(a: NumFact, b: NumFact): NumFact {
  let minI64: number | undefined;
  let maxI64: number | undefined;
  if (a.minI64 !== undefined && a.maxI64 !== undefined && b.minI64 !== undefined && b.maxI64 !== undefined) {
    const min = Math.min(a.minI64, b.minI64);
    const max = Math.max(a.maxI64, b.maxI64);
    if (rangeWidthOk(min, max)) {
      minI64 = min;
      maxI64 = max;
    }
  }
  return {
    i64Safe: a.i64Safe && b.i64Safe,
    nonneg: a.nonneg && b.nonneg,
    maybeZero: a.maybeZero || b.maybeZero,
    constI64: a.constI64 === b.constI64 ? a.constI64 : undefined,
    minI64,
    maxI64,
  };
}
function nfEq(a: NumFact, b: NumFact): boolean {
  return (
    a.i64Safe === b.i64Safe && a.nonneg === b.nonneg && a.maybeZero === b.maybeZero &&
    a.constI64 === b.constI64 && a.minI64 === b.minI64 && a.maxI64 === b.maxI64
  );
}

function flattenInst(body: any[], out: any[]): void {
  for (const i of body) {
    out.push(i);
    if (i.kind === "Loop") {
      flattenInst(i.condBody ?? [], out);
      flattenInst(i.body ?? [], out);
    } else if (i.kind === "If") {
      flattenInst(i.thenBody ?? [], out);
      flattenInst(i.elseBody ?? [], out);
    } else if (i.kind === "TryCatch") {
      flattenInst(i.tryBody ?? [], out);
      flattenInst(i.catchBody ?? [], out);
      flattenInst(i.finallyBody ?? [], out);
    }
  }
}

function collectLoopNonnegSubs(body: any[], out: Set<number>): void {
  const relation = (cond: number, condBody: any[]): [number, number] | undefined => {
    for (const inst of condBody) {
      if (inst.kind === "BinOp" && inst.dst === cond && (inst.op === "<" || inst.op === "<=")) {
        return [inst.lhs, inst.rhs];
      }
    }
    return undefined;
  };
  const markSubs = (b: any[], smaller: number, larger: number) => {
    for (const inst of b) {
      if (inst.kind === "BinOp" && inst.op === "-" && inst.lhs === larger && inst.rhs === smaller) out.add(inst.dst);
      else if (inst.kind === "Loop") { markSubs(inst.condBody ?? [], smaller, larger); markSubs(inst.body ?? [], smaller, larger); }
      else if (inst.kind === "If") { markSubs(inst.thenBody ?? [], smaller, larger); markSubs(inst.elseBody ?? [], smaller, larger); }
      else if (inst.kind === "TryCatch") { markSubs(inst.tryBody ?? [], smaller, larger); markSubs(inst.catchBody ?? [], smaller, larger); markSubs(inst.finallyBody ?? [], smaller, larger); }
    }
  };
  for (const inst of body) {
    if (inst.kind === "Loop") {
      const rel = relation(inst.cond, inst.condBody ?? []);
      if (rel !== undefined) markSubs(inst.body ?? [], rel[0], rel[1]);
      collectLoopNonnegSubs(inst.condBody ?? [], out);
      collectLoopNonnegSubs(inst.body ?? [], out);
    } else if (inst.kind === "If") {
      collectLoopNonnegSubs(inst.thenBody ?? [], out);
      collectLoopNonnegSubs(inst.elseBody ?? [], out);
    } else if (inst.kind === "TryCatch") {
      collectLoopNonnegSubs(inst.tryBody ?? [], out);
      collectLoopNonnegSubs(inst.catchBody ?? [], out);
      collectLoopNonnegSubs(inst.finallyBody ?? [], out);
    }
  }
}

interface NumericAnalysis {
  facts: Map<number, NumFact>;
  intLocal: Set<number>;
  nonzeroIntConst: Set<number>;
  nonzeroInt: Set<number>;
  intConst: Map<number, number>;
  nonnegativeInt: Set<number>;
}

function inferNumericAnalysis(
  body: any[],
  unboxed: Set<number>,
  paramFacts: Map<number, NumFact>,
  returnFacts: Map<number, NumFact>
): NumericAnalysis {
  const flat: any[] = [];
  flattenInst(body, flat);
  const loopNonnegSubs = new Set<number>();
  collectLoopNonnegSubs(body, loopNonnegSubs);

  const facts = new Map<number, NumFact>();
  for (const [k, v] of paramFacts) facts.set(k, v);
  const get = (id: number): NumFact => facts.get(id) ?? nfUnknown();
  const merge = (id: number, nf: NumFact): boolean => {
    const old = facts.get(id);
    const next = old !== undefined ? nfJoin(old, nf) : nf;
    if (old === undefined || !nfEq(old, next)) {
      facts.set(id, next);
      return true;
    }
    return false;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const inst of flat) {
      let def: [number, NumFact] | undefined;
      switch (inst.kind) {
        case "Const": {
          const v = inst.value;
          let f = nfUnknown();
          if (v.kind === "Num") {
            const num = typeof v.value === "string" ? Number(v.value) : v.value;
            const s = safeI64Num(num);
            if (s !== undefined) f = nfIntConst(s);
          } else if (v.kind === "Bool") {
            f = nfIntConst(v.value ? 1 : 0);
          }
          def = [inst.dst, f];
          break;
        }
        case "Copy":
          def = [inst.dst, get(inst.src)];
          break;
        case "UnOp": {
          const a = get(inst.operand);
          let f: NumFact;
          if (inst.op === "!" || inst.op === "nullish" || inst.op === "isundef") f = nfBool();
          else if (inst.op === "~") f = { i64Safe: true, nonneg: false, maybeZero: true, constI64: undefined, minI64: undefined, maxI64: undefined };
          else if (inst.op === "+") f = a;
          else if (inst.op === "-") {
            if (a.constI64 !== undefined) {
              if (a.constI64 === 0) f = nfUnknown();
              else {
                const neg = checkedSafeI64(-a.constI64);
                f = neg !== undefined ? nfIntConst(neg) : nfUnknown();
              }
            } else if (a.i64Safe && !a.maybeZero) {
              const r = rangeOf(a);
              let minI64: number | undefined;
              let maxI64: number | undefined;
              if (r !== undefined) {
                const cr = checkedRange(-r[1], -r[0]);
                if (cr !== undefined) {
                  minI64 = cr.minI64;
                  maxI64 = cr.maxI64;
                }
              }
              f = { i64Safe: true, nonneg: false, maybeZero: false, constI64: undefined, minI64, maxI64 };
            } else f = nfUnknown();
          } else f = nfUnknown();
          def = [inst.dst, f];
          break;
        }
        case "BinOp": {
          const l = get(inst.lhs);
          const r = get(inst.rhs);
          let f: NumFact;
          switch (inst.op) {
            case "<": case "<=": case ">": case ">=": case "==": case "!=": case "===": case "!==":
              f = nfBool();
              break;
            case "&": case "|": case "^": case "<<": case ">>":
              f = { i64Safe: true, nonneg: false, maybeZero: true, constI64: undefined, minI64: undefined, maxI64: undefined };
              break;
            case ">>>":
              f = { i64Safe: true, nonneg: true, maybeZero: true, constI64: undefined, minI64: undefined, maxI64: undefined };
              break;
            case "+": {
              if (l.constI64 !== undefined && r.constI64 !== undefined) {
                const s = checkedSafeI64(l.constI64 + r.constI64);
                f = s !== undefined ? nfIntConst(s) : nfUnknown();
              } else if (l.i64Safe && r.i64Safe) {
                const lr = rangeOf(l);
                const rr = rangeOf(r);
                if (lr !== undefined && rr !== undefined) {
                  f = checkedRange(lr[0] + rr[0], lr[1] + rr[1]) ?? {
                    i64Safe: true, nonneg: l.nonneg && r.nonneg, maybeZero: l.maybeZero && r.maybeZero,
                    constI64: undefined, minI64: undefined, maxI64: undefined,
                  };
                } else {
                  f = { i64Safe: true, nonneg: l.nonneg && r.nonneg, maybeZero: l.maybeZero && r.maybeZero, constI64: undefined, minI64: undefined, maxI64: undefined };
                }
              } else f = nfUnknown();
              break;
            }
            case "-": {
              if (l.constI64 !== undefined && r.constI64 !== undefined) {
                const s = checkedSafeI64(l.constI64 - r.constI64);
                f = s !== undefined ? nfIntConst(s) : nfUnknown();
              } else if (l.i64Safe && r.i64Safe) {
                const lr = rangeOf(l);
                const rr = rangeOf(r);
                const fallback: NumFact = {
                  i64Safe: true, nonneg: loopNonnegSubs.has(inst.dst), maybeZero: true,
                  constI64: undefined, minI64: undefined, maxI64: undefined,
                };
                if (lr !== undefined && rr !== undefined) {
                  f = checkedRange(lr[0] - rr[1], lr[1] - rr[0]) ?? fallback;
                } else f = fallback;
              } else f = nfUnknown();
              break;
            }
            case "*": {
              if (l.constI64 !== undefined && r.constI64 !== undefined) {
                const a = l.constI64, b = r.constI64;
                if ((a === 0 && b < 0) || (b === 0 && a < 0)) f = nfUnknown();
                else {
                  const s = checkedSafeI64(a * b);
                  f = s !== undefined ? nfIntConst(s) : nfUnknown();
                }
              } else if (l.i64Safe && r.i64Safe && (!l.maybeZero || r.nonneg) && (!r.maybeZero || l.nonneg)) {
                const lr = rangeOf(l);
                const rr = rangeOf(r);
                if (lr !== undefined && rr !== undefined) {
                  const vals = [lr[0] * rr[0], lr[0] * rr[1], lr[1] * rr[0], lr[1] * rr[1]];
                  const min = Math.min(...vals);
                  const max = Math.max(...vals);
                  if (checkedSafeI64(min) !== undefined && checkedSafeI64(max) !== undefined) {
                    f = checkedRange(min, max) ?? {
                      i64Safe: true, nonneg: l.nonneg && r.nonneg, maybeZero: l.maybeZero || r.maybeZero,
                      constI64: undefined, minI64: undefined, maxI64: undefined,
                    };
                  } else f = nfUnknown();
                } else f = nfUnknown();
              } else f = nfUnknown();
              break;
            }
            case "%": {
              if (r.constI64 !== undefined) {
                const b = r.constI64;
                if (b !== 0 && l.i64Safe && l.nonneg) {
                  if (l.constI64 !== undefined) {
                    f = nfIntConst(l.constI64 % b);
                  } else {
                    const max = Math.abs(b) - 1;
                    f = rangeWidthOk(0, max) ? nfRange(0, max) : nfNonnegI64();
                  }
                } else f = nfUnknown();
              } else if (l.i64Safe && l.nonneg && r.i64Safe && !r.maybeZero) {
                const rr = rangeOf(r);
                if (rr !== undefined) {
                  const maxAbs = Math.max(Math.abs(rr[0]), Math.abs(rr[1]));
                  f = checkedRange(0, maxAbs - 1) ?? nfNonnegI64();
                } else f = nfNonnegI64();
              } else f = nfUnknown();
              break;
            }
            default:
              f = nfUnknown();
          }
          def = [inst.dst, f];
          break;
        }
        case "ArrayLen": case "StringLen": case "GenericLen":
          def = [inst.dst, nfNonnegI64()];
          break;
        case "LoadField": case "LoadElem": case "LoadGlobal": case "LoadIndex":
        case "HasField": case "HasFieldDynamic": case "LoadFieldDynamic":
        case "ArraySlice": case "ObjectRest": case "ObjectCopyProps":
        case "ConstructResult": case "LoadClassProto": case "GetProto":
        case "NewMap": case "NewSet":
          def = [inst.dst, nfUnknown()];
          break;
        case "DeleteField":
          if (inst.dst !== undefined && inst.dst !== null) def = [inst.dst, nfUnknown()];
          break;
        case "Call": {
          if (inst.dst === undefined || inst.dst === null) break;
          const c = inst.callee;
          if (c?.kind === "Direct") {
            def = [inst.dst, returnFacts.get(c.func) ?? nfUnknown()];
          } else if (c?.kind === "Set") {
            const funcs: number[] = c.funcs ?? [];
            let acc: NumFact | undefined;
            for (const fn of funcs) {
              const rf = returnFacts.get(fn) ?? nfUnknown();
              acc = acc === undefined ? rf : nfJoin(acc, rf);
            }
            def = [inst.dst, acc ?? nfUnknown()];
          } else {
            def = [inst.dst, nfUnknown()];
          }
          break;
        }
        case "CallBuiltin": {
          if (inst.dst === undefined || inst.dst === null) break;
          let f = nfUnknown();
          if (inst.builtin === "string.charCodeAt") f = nfRange(0, 65535);
          else if (inst.builtin === "string.indexOf" || inst.builtin === "string.lastIndexOf") f = nfI64Value();
          def = [inst.dst, f];
          break;
        }
        case "CallBuiltinStatic": {
          if (inst.dst === undefined || inst.dst === null) break;
          let f = nfUnknown();
          if (inst.builtin === "json.num.len" || inst.builtin === "json.string.len") f = nfNonnegI64();
          def = [inst.dst, f];
          break;
        }
        case "CallSpread": case "Yield": case "Await": case "SetProto":
          if (inst.dst !== undefined && inst.dst !== null) def = [inst.dst, nfUnknown()];
          break;
        default:
          break;
      }
      if (def !== undefined && merge(def[0], def[1])) changed = true;
    }
  }

  const intLocal = new Set<number>();
  const nonzeroIntConst = new Set<number>();
  const nonzeroInt = new Set<number>();
  const intConst = new Map<number, number>();
  const nonnegativeInt = new Set<number>();
  for (const [id, f] of facts) {
    if (unboxed.has(id) && f.i64Safe) intLocal.add(id);
    if (f.constI64 !== undefined && f.constI64 !== 0) nonzeroIntConst.add(id);
    if (f.i64Safe && !f.maybeZero) nonzeroInt.add(id);
    if (f.constI64 !== undefined) intConst.set(id, f.constI64);
    if (f.i64Safe && f.nonneg) nonnegativeInt.add(id);
  }
  return { facts, intLocal, nonzeroIntConst, nonzeroInt, intConst, nonnegativeInt };
}

// ----------------------- unboxed / class classification ----------------------

function collectLocalClass(body: any[], out: Map<number, number>): void {
  for (const inst of body) {
    if (inst.kind === "AllocObject" && inst.classId !== undefined && inst.classId !== null) {
      out.set(inst.dst, inst.classId);
    } else if (inst.kind === "Copy") {
      const c = out.get(inst.src);
      if (c !== undefined) out.set(inst.dst, c);
    } else if (inst.kind === "Loop") {
      collectLocalClass(inst.condBody ?? [], out);
      collectLocalClass(inst.body ?? [], out);
    } else if (inst.kind === "If") {
      collectLocalClass(inst.thenBody ?? [], out);
      collectLocalClass(inst.elseBody ?? [], out);
    } else if (inst.kind === "TryCatch") {
      collectLocalClass(inst.tryBody ?? [], out);
      collectLocalClass(inst.catchBody ?? [], out);
      collectLocalClass(inst.finallyBody ?? [], out);
    }
  }
}

function localClassMap(f: any): Map<number, number> {
  const out = new Map<number, number>();
  const pc = f.paramClasses ?? {};
  for (const k of Object.keys(pc)) {
    const p = parseInt(k, 10);
    if (!Number.isNaN(p)) out.set(p, pc[k]);
  }
  collectLocalClass(f.body, out);
  return out;
}

function collectNonNumericConsts(body: any[], out: Set<number>): void {
  for (const inst of body) {
    if (inst.kind === "Const") {
      const k = inst.value?.kind;
      const numeric = k === "Num" || k === "NaN" || k === "PosInf" || k === "NegInf" || k === "NegZero";
      if (!numeric) out.add(inst.dst);
    } else if (inst.kind === "UnOp" && inst.op === "typeof") {
      out.add(inst.dst);
    } else if (inst.kind === "UnOp" && (inst.op === "nullish" || inst.op === "isundef")) {
      out.add(inst.operand);
    } else if (inst.kind === "Copy") {
      if (out.has(inst.src)) out.add(inst.dst);
    } else if (inst.kind === "Loop") {
      collectNonNumericConsts(inst.condBody ?? [], out);
      collectNonNumericConsts(inst.body ?? [], out);
    } else if (inst.kind === "If") {
      collectNonNumericConsts(inst.thenBody ?? [], out);
      collectNonNumericConsts(inst.elseBody ?? [], out);
    } else if (inst.kind === "TryCatch") {
      collectNonNumericConsts(inst.tryBody ?? [], out);
      collectNonNumericConsts(inst.catchBody ?? [], out);
      collectNonNumericConsts(inst.finallyBody ?? [], out);
    }
  }
}

/** Use-position locals of a leaf instruction (no dst; no recursion). */
function usesOf(inst: any): number[] {
  const opt = (x: any) => (x === undefined || x === null ? [] : [x]);
  switch (inst.kind) {
    case "Copy": return [inst.src];
    case "LoadField": return [inst.obj];
    case "StoreField": return [inst.obj, inst.src];
    case "LoadElem": return [inst.arr];
    case "StoreElem": return [inst.arr, inst.src];
    case "Call": {
      const v = [...opt(inst.recv), ...(inst.args ?? [])];
      if (inst.callee?.kind === "Value") v.push(inst.callee.local);
      return v;
    }
    case "CallBuiltin": return [inst.recv, ...(inst.args ?? [])];
    case "CallBuiltinStatic": return [...(inst.args ?? [])];
    case "Return": return opt(inst.src);
    case "Yield": case "Await": return [inst.operand];
    case "Throw": return [inst.src];
    case "StoreGlobal": return [inst.src];
    case "BinOp": return [inst.lhs, inst.rhs];
    case "UnOp": return [inst.operand];
    case "LoadIndex": return [inst.arr, inst.index];
    case "StoreIndex": return [inst.arr, inst.index, inst.src];
    case "ArrayLen": return [inst.arr];
    case "StringLen": return [inst.src];
    case "ArrayPush": case "ArrayPushAll": return [inst.arr, inst.src];
    case "HasField": return [inst.obj];
    case "HasFieldDynamic": return [inst.obj, inst.key];
    case "GenericLen": return [inst.src];
    case "LoadFieldDynamic": return [inst.obj, inst.key];
    case "StoreFieldDynamic": return [inst.obj, inst.key, inst.src];
    case "DeleteField": return [inst.obj];
    case "ArraySlice": return [inst.arr, inst.start];
    case "ObjectRest": return [inst.src];
    case "ObjectCopyProps": return [inst.dst, inst.src];
    case "ConstructResult": return [inst.inst, inst.ret];
    case "CallSpread": {
      const v = [...opt(inst.recv)];
      for (const s of inst.argSpecs ?? []) v.push(s.local);
      if (inst.callee?.kind === "Value") v.push(inst.callee.local);
      return v;
    }
    case "SetProto": return [inst.obj, inst.proto];
    case "GetProto": return [inst.obj];
    case "StoreProtoMethod": return [inst.src];
    case "StoreMethod": return [inst.obj, inst.src];
    case "Print": return [inst.src];
    case "NewDynamic": return [inst.callee, ...(inst.args ?? [])];
    case "AllocClosure": case "AllocClassValue":
      return (inst.captures ?? []).map((c: any) => c.cell);
    case "AllocObject": return opt(inst.proto);
    case "If": case "Loop": return [inst.cond];
    case "TryCatch": return [];
    default: return [];
  }
}

function maybeUndefNumericLocals(f: any): Set<number> {
  const prim = new Set<number>();
  const reference = new Set<number>();
  for (const l of f.locals) {
    if (l.refKind === "primitive") prim.add(l.id);
    else if (l.refKind === "reference") reference.add(l.id);
  }
  const flat: any[] = [];
  flattenInst(f.body, flat);
  const set = new Set<number>();
  for (const l of f.locals) if (l.nullableNumeric) set.add(l.id);
  for (const inst of flat) {
    if ((inst.kind === "LoadIndex" || inst.kind === "LoadFieldDynamic") && prim.has(inst.dst)) set.add(inst.dst);
    else if (inst.kind === "Copy" && prim.has(inst.dst) && reference.has(inst.src)) set.add(inst.dst);
  }
  if (set.size === 0) return set;
  let changed = true;
  while (changed) {
    changed = false;
    for (const inst of flat) {
      if (inst.kind === "Copy" && set.has(inst.src) && prim.has(inst.dst) && !set.has(inst.dst)) {
        set.add(inst.dst);
        changed = true;
      }
    }
  }
  return set;
}

const NB_NUMERIC_BINOPS = new Set(["-", "*", "/", "%", "**", "&", "|", "^", "<<", ">>", ">>>", "<", ">", "<=", ">="]);

function needsBoxNumericLocals(f: any, maybeUndef: Set<number>): Set<number> {
  if (maybeUndef.size === 0) return new Set();
  const prim = new Set<number>();
  for (const l of f.locals) if (l.refKind === "primitive") prim.add(l.id);
  const flat: any[] = [];
  flattenInst(f.body, flat);
  const nb = new Set<number>();
  const obs = (id: number) => {
    if (maybeUndef.has(id)) nb.add(id);
  };
  for (const inst of flat) {
    switch (inst.kind) {
      case "BinOp":
        if (NB_NUMERIC_BINOPS.has(inst.op)) {
          // numeric: undefined -> NaN matches JS
        } else if (inst.op === "+") {
          if (!prim.has(inst.rhs)) obs(inst.lhs);
          if (!prim.has(inst.lhs)) obs(inst.rhs);
        } else {
          obs(inst.lhs);
          obs(inst.rhs);
        }
        break;
      case "UnOp":
        if (!(inst.op === "-" || inst.op === "+" || inst.op === "~" || inst.op === "!")) obs(inst.operand);
        break;
      case "If": case "Loop": case "TryCatch": case "LoadIndex":
        break;
      case "StoreIndex":
        obs(inst.src);
        break;
      case "Copy":
        if (maybeUndef.has(inst.src) && !maybeUndef.has(inst.dst)) obs(inst.src);
        break;
      default: {
        const uses = usesOf(inst);
        for (const id of maybeUndef) {
          if (uses.includes(id)) nb.add(id);
        }
        break;
      }
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const inst of flat) {
      if (inst.kind === "Copy" && nb.has(inst.dst) && maybeUndef.has(inst.src) && !nb.has(inst.src)) {
        nb.add(inst.src);
        changed = true;
      }
    }
  }
  return nb;
}

const CMP_OPS = new Set(["<", "<=", ">", ">=", "==", "!=", "===", "!=="]);

function cmpTruthyOnly(body: any[]): Set<number> {
  const cand = new Set<number>();
  const findCmps = (b: any[]) => {
    for (const i of b) {
      if (i.kind === "BinOp" && CMP_OPS.has(i.op)) cand.add(i.dst);
      else if (i.kind === "Loop") { findCmps(i.condBody ?? []); findCmps(i.body ?? []); }
      else if (i.kind === "If") { findCmps(i.thenBody ?? []); findCmps(i.elseBody ?? []); }
      else if (i.kind === "TryCatch") { findCmps(i.tryBody ?? []); findCmps(i.catchBody ?? []); findCmps(i.finallyBody ?? []); }
    }
  };
  findCmps(body);
  if (cand.size === 0) return cand;

  const total = new Map<number, number>();
  const truthy = new Map<number, number>();
  const bump = (m: Map<number, number>, id: number) => {
    if (cand.has(id)) m.set(id, (m.get(id) ?? 0) + 1);
  };
  const walk = (b: any[]) => {
    for (const i of b) {
      if (i.kind === "UnOp") {
        bump(total, i.operand);
        if (i.op === "!") bump(truthy, i.operand);
      } else if (i.kind === "Loop") {
        bump(total, i.cond);
        bump(truthy, i.cond);
        walk(i.condBody ?? []);
        walk(i.body ?? []);
      } else if (i.kind === "If") {
        bump(total, i.cond);
        bump(truthy, i.cond);
        walk(i.thenBody ?? []);
        walk(i.elseBody ?? []);
      } else if (i.kind === "TryCatch") {
        walk(i.tryBody ?? []);
        walk(i.catchBody ?? []);
        walk(i.finallyBody ?? []);
      } else {
        for (const u of usesOf(i)) bump(total, u);
      }
    }
  };
  walk(body);
  const out = new Set<number>();
  for (const id of cand) {
    const t = total.get(id) ?? 0;
    if (t > 0 && t === (truthy.get(id) ?? 0)) out.add(id);
  }
  return out;
}

function unboxedCandidates(f: any, localClass: Map<number, number>): Set<number> {
  const nonNumeric = new Set<number>();
  collectNonNumericConsts(f.body, nonNumeric);
  const unboxed = new Set<number>();
  for (const l of f.locals) {
    if (l.refKind === "primitive" && !localClass.has(l.id) && !nonNumeric.has(l.id)) unboxed.add(l.id);
  }
  for (const id of cmpTruthyOnly(f.body)) {
    if (!localClass.has(id) && !nonNumeric.has(id)) unboxed.add(id);
  }
  const maybeUndef = maybeUndefNumericLocals(f);
  const needsBox = needsBoxNumericLocals(f, maybeUndef);
  for (const id of needsBox) unboxed.delete(id);
  for (const l of f.locals) {
    if (l.nullableNumeric && maybeUndef.has(l.id) && !needsBox.has(l.id) && !localClass.has(l.id) && !nonNumeric.has(l.id)) {
      unboxed.add(l.id);
    }
  }
  return unboxed;
}

// ------------- program-level numeric inference (param facts, i64/f64 fast) -------------
// Faithful port of emit_c.rs infer_indirect_funcs / infer_program_param_facts /
// infer_i64_fast_funcs / infer_f64_fast_funcs and their helpers.

interface I64FuncInfo {
  params: number[];
  paramFacts: Map<number, NumFact>;
  retFact: NumFact;
}
interface F64FuncInfo {
  params: number[];
}

function inferIndirectFuncs(prog: Program): Set<number> {
  const indirect = new Set<number>();
  for (const f of prog.functions as any[]) {
    if (f.isExported) indirect.add(f.id);
  }
  const globalFuncs = new Map<number, Set<number>>();

  const addAll = (dst: Set<number>, src: Set<number>): boolean => {
    const before = dst.size;
    for (const x of src) dst.add(x);
    return dst.size !== before;
  };
  const entrySet = (m: Map<number, Set<number>>, k: number): Set<number> => {
    let e = m.get(k);
    if (e === undefined) {
      e = new Set<number>();
      m.set(k, e);
    }
    return e;
  };

  const scan = (body: any[], localFuncs: Map<number, Set<number>>): boolean => {
    let changed = false;
    const markEscape = (v: number): void => {
      const fs = localFuncs.get(v);
      if (fs !== undefined && addAll(indirect, fs)) changed = true;
    };
    for (const inst of body) {
      switch (inst.kind) {
        case "AllocClosure":
          entrySet(localFuncs, inst.dst).add(inst.func);
          break;
        case "AllocClassValue":
          entrySet(localFuncs, inst.dst).add(inst.ctor);
          break;
        case "Copy": {
          const srcSet = localFuncs.get(inst.src);
          if (srcSet !== undefined && srcSet.size > 0) addAll(entrySet(localFuncs, inst.dst), srcSet);
          break;
        }
        case "StoreGlobal": {
          const srcSet = localFuncs.get(inst.src);
          if (srcSet !== undefined && srcSet.size > 0 && addAll(entrySet(globalFuncs, inst.gref), srcSet)) {
            changed = true;
          }
          break;
        }
        case "LoadGlobal": {
          const srcSet = globalFuncs.get(inst.gref);
          if (srcSet !== undefined && srcSet.size > 0) addAll(entrySet(localFuncs, inst.dst), srcSet);
          break;
        }
        case "Call": {
          const c = inst.callee ?? {};
          if (c.kind === "Value") markEscape(c.local);
          if (inst.recv !== undefined && inst.recv !== null) markEscape(inst.recv);
          for (const a of inst.args ?? []) markEscape(a);
          break;
        }
        case "CallSpread": {
          const c = inst.callee ?? {};
          if (c.kind === "Value") markEscape(c.local);
          if (inst.recv !== undefined && inst.recv !== null) markEscape(inst.recv);
          for (const sp of inst.argSpecs ?? []) markEscape(sp.local);
          break;
        }
        case "Return":
          if (inst.src !== undefined && inst.src !== null) markEscape(inst.src);
          break;
        case "Throw":
        case "StoreElem":
        case "StoreField":
        case "StoreFieldDynamic":
        case "ArrayPush":
        case "StoreProtoMethod":
        case "StoreMethod":
        case "Print":
          markEscape(inst.src);
          break;
        case "Loop":
          if (scan(inst.condBody ?? [], localFuncs)) changed = true;
          if (scan(inst.body ?? [], localFuncs)) changed = true;
          break;
        case "If":
          if (scan(inst.thenBody ?? [], localFuncs)) changed = true;
          if (scan(inst.elseBody ?? [], localFuncs)) changed = true;
          break;
        case "TryCatch":
          if (scan(inst.tryBody ?? [], localFuncs)) changed = true;
          if (scan(inst.catchBody ?? [], localFuncs)) changed = true;
          if (scan(inst.finallyBody ?? [], localFuncs)) changed = true;
          break;
        default:
          break;
      }
    }
    return changed;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const f of prog.functions as any[]) {
      const localFuncs = new Map<number, Set<number>>();
      if (scan(f.body, localFuncs)) changed = true;
    }
  }
  return indirect;
}

function nfMapEq(a: Map<number, NumFact>, b: Map<number, NumFact>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (w === undefined || !nfEq(v, w)) return false;
  }
  return true;
}
function paramFactsByFuncEq(a: Map<number, Map<number, NumFact>>, b: Map<number, Map<number, NumFact>>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (w === undefined || !nfMapEq(v, w)) return false;
  }
  return true;
}

function inferProgramParamFacts(prog: Program, indirect: Set<number>): Map<number, Map<number, NumFact>> {
  let byFunc = new Map<number, Map<number, NumFact>>();
  for (const f of prog.functions as any[]) {
    const m = new Map<number, NumFact>();
    for (const p of f.params) m.set(p, nfUnknown());
    byFunc.set(f.id, m);
  }
  const fnParams = new Map<number, number[]>();
  for (const f of prog.functions as any[]) fnParams.set(f.id, (f.params as number[]).slice());

  for (let iter = 0; iter < 8; iter++) {
    const seen = new Set<string>(); // `${target}:${idx}`
    const next = new Map<number, Map<number, NumFact>>();
    for (const f of prog.functions as any[]) {
      const paramFacts = byFunc.get(f.id) ?? new Map<number, NumFact>();
      const localClass = localClassMap(f);
      const unboxed = unboxedCandidates(f, localClass);
      const emptyReturnFacts = new Map<number, NumFact>();
      const analysis = inferNumericAnalysis(f.body, unboxed, paramFacts, emptyReturnFacts);
      const flat: any[] = [];
      flattenInst(f.body, flat);
      for (const inst of flat) {
        if (inst.kind === "Call") {
          const argv: number[] = [];
          if (inst.recv !== undefined && inst.recv !== null) argv.push(inst.recv);
          for (const a of inst.args ?? []) argv.push(a);
          const c = inst.callee ?? {};
          let targets: number[] = [];
          if (c.kind === "Direct") targets = [c.func];
          else if (c.kind === "Set") targets = ((c.funcs ?? []) as number[]).slice();
          for (const target of targets) {
            if (!indirect.has(target)) {
              const params = fnParams.get(target);
              if (params !== undefined) {
                params.forEach((p, idx) => {
                  const a = argv[idx];
                  const af = a !== undefined ? analysis.facts.get(a) : undefined;
                  const fact = af !== undefined ? af : nfUnknown();
                  seen.add(`${target}:${idx}`);
                  let dst = next.get(target);
                  if (dst === undefined) {
                    dst = new Map<number, NumFact>();
                    next.set(target, dst);
                  }
                  const old = dst.get(p);
                  dst.set(p, old !== undefined ? nfJoin(old, fact) : fact);
                });
              }
            }
          }
        }
      }
    }
    for (const f of prog.functions as any[]) {
      let entry = next.get(f.id);
      if (entry === undefined) {
        entry = new Map<number, NumFact>();
        next.set(f.id, entry);
      }
      (f.params as number[]).forEach((p, idx) => {
        if (indirect.has(f.id) || !seen.has(`${f.id}:${idx}`)) entry!.set(p, nfUnknown());
      });
    }
    if (paramFactsByFuncEq(next, byFunc)) break;
    byFunc = next;
  }
  return byFunc;
}

function i64ReturnFacts(i64Fast: Map<number, I64FuncInfo>): Map<number, NumFact> {
  const out = new Map<number, NumFact>();
  for (const [id, info] of i64Fast) out.set(id, info.retFact);
  return out;
}

function numericFastTargets(i64Fast: Map<number, I64FuncInfo>, f64Fast: Map<number, F64FuncInfo>): Set<number> {
  const out = new Set<number>();
  for (const k of i64Fast.keys()) out.add(k);
  for (const k of f64Fast.keys()) out.add(k);
  return out;
}

function typeIsNumber(prog: Program, tid: number): boolean {
  const types: any[] = ((prog as any).types ?? []) as any[];
  if (types.length === 0) return true;
  const t = types.find((x) => x.id === tid);
  if (t === undefined) return false;
  const shape = t.shape ?? {};
  return shape.kind === "Primitive" && shape.prim === "Number";
}

function localIsNumber(prog: Program, f: any, id: number): boolean {
  const l = (f.locals as any[]).find((x) => x.id === id);
  if (l === undefined) return false;
  const types: any[] = ((prog as any).types ?? []) as any[];
  if (types.length === 0) return l.refKind === "primitive";
  return typeIsNumber(prog, l.typeId);
}

function i64BodySupported(body: any[]): boolean {
  for (const inst of body) {
    let ok: boolean;
    switch (inst.kind) {
      case "Const":
      case "Copy":
      case "BinOp":
      case "UnOp":
      case "Return":
      case "Break":
      case "Continue":
        ok = true;
        break;
      case "Call":
        ok = (inst.callee ?? {}).kind === "Direct";
        break;
      case "Loop":
        ok = i64BodySupported(inst.condBody ?? []) && i64BodySupported(inst.body ?? []);
        break;
      case "If":
        ok = i64BodySupported(inst.thenBody ?? []) && i64BodySupported(inst.elseBody ?? []);
        break;
      default:
        ok = false;
        break;
    }
    if (!ok) return false;
  }
  return true;
}

function collectReturnFact(body: any[], analysis: NumericAnalysis): NumFact | undefined {
  let out: NumFact | undefined;
  const join = (fact: NumFact): void => {
    out = out !== undefined ? nfJoin(out, fact) : fact;
  };
  const walk = (b: any[]): void => {
    for (const inst of b) {
      switch (inst.kind) {
        case "Return":
          if (inst.src !== undefined && inst.src !== null) join(analysis.facts.get(inst.src) ?? nfUnknown());
          else join(nfUnknown());
          break;
        case "Loop":
          walk(inst.condBody ?? []);
          walk(inst.body ?? []);
          break;
        case "If":
          walk(inst.thenBody ?? []);
          walk(inst.elseBody ?? []);
          break;
        case "TryCatch":
          walk(inst.tryBody ?? []);
          walk(inst.catchBody ?? []);
          walk(inst.finallyBody ?? []);
          break;
        default:
          break;
      }
    }
  };
  walk(body);
  return out;
}

function numericValueLocs(body: any[], params: number[], numericCallTargets: Set<number>): Set<number> {
  const flat: any[] = [];
  flattenInst(body, flat);
  const numeric = new Set<number>(params);
  let changed = true;
  while (changed) {
    changed = false;
    for (const inst of flat) {
      let def: [number, boolean] | undefined;
      switch (inst.kind) {
        case "Const":
          def = [inst.dst, (inst.value ?? {}).kind === "Num"];
          break;
        case "Copy":
          def = [inst.dst, numeric.has(inst.src)];
          break;
        case "UnOp":
          def = [inst.dst, (inst.op === "+" || inst.op === "-" || inst.op === "~") && numeric.has(inst.operand)];
          break;
        case "BinOp": {
          const numOps = ["+", "-", "*", "/", "%", "**", "&", "|", "^", "<<", ">>", ">>>"];
          def = [inst.dst, numOps.indexOf(inst.op) >= 0 && numeric.has(inst.lhs) && numeric.has(inst.rhs)];
          break;
        }
        case "Call": {
          if (inst.dst === undefined || inst.dst === null) break;
          const c = inst.callee ?? {};
          def = [inst.dst, c.kind === "Direct" && numericCallTargets.has(c.func)];
          break;
        }
        case "CallBuiltin":
          if (inst.dst === undefined || inst.dst === null) break;
          def = [
            inst.dst,
            inst.builtin === "string.charCodeAt" || inst.builtin === "string.indexOf" || inst.builtin === "string.lastIndexOf",
          ];
          break;
        case "CallBuiltinStatic":
          if (inst.dst === undefined || inst.dst === null) break;
          def = [inst.dst, inst.builtin === "json.num.len" || inst.builtin === "json.string.len"];
          break;
        case "CallSpread":
        case "Yield":
        case "Await":
        case "SetProto":
        case "DeleteField":
          if (inst.dst === undefined || inst.dst === null) break;
          def = [inst.dst, false];
          break;
        case "LoadField":
        case "LoadElem":
        case "LoadGlobal":
        case "LoadIndex":
        case "HasField":
        case "HasFieldDynamic":
        case "LoadFieldDynamic":
        case "ArraySlice":
        case "ObjectRest":
        case "ObjectCopyProps":
        case "ConstructResult":
        case "LoadClassProto":
        case "GetProto":
        case "NewMap":
        case "NewSet":
          def = [inst.dst, false];
          break;
        case "ArrayLen":
        case "StringLen":
        case "GenericLen":
          def = [inst.dst, true];
          break;
        default:
          break;
      }
      if (def !== undefined && def[1] && !numeric.has(def[0])) {
        numeric.add(def[0]);
        changed = true;
      }
    }
  }
  return numeric;
}

function forceInlineNumericFunc(f: any): boolean {
  if (f.isAsync || f.isGenerator || f.body.length > 8) return false;
  for (const inst of f.body as any[]) {
    switch (inst.kind) {
      case "Const":
      case "Copy":
      case "BinOp":
      case "UnOp":
      case "LoadField":
      case "StoreField":
      case "Return":
        break;
      default:
        return false;
    }
  }
  return true;
}

function returnsNumericValues(body: any[], params: number[], numericCallTargets: Set<number>): boolean {
  const numeric = numericValueLocs(body, params, numericCallTargets);
  const check = (b: any[]): boolean => {
    for (const inst of b) {
      let ok: boolean;
      switch (inst.kind) {
        case "Return":
          ok = inst.src !== undefined && inst.src !== null ? numeric.has(inst.src) : false;
          break;
        case "Loop":
          ok = check(inst.condBody ?? []) && check(inst.body ?? []);
          break;
        case "If":
          ok = check(inst.thenBody ?? []) && check(inst.elseBody ?? []);
          break;
        case "TryCatch":
          ok = check(inst.tryBody ?? []) && check(inst.catchBody ?? []) && check(inst.finallyBody ?? []);
          break;
        default:
          ok = true;
          break;
      }
      if (!ok) return false;
    }
    return true;
  };
  return check(body);
}

function directCallArgsI64Safe(argv: number[], analysis: NumericAnalysis): boolean {
  for (const a of argv) {
    const f = analysis.facts.get(a);
    if (f === undefined || !f.i64Safe) return false;
  }
  return true;
}

function validateI64DirectCalls(body: any[], analysis: NumericAnalysis, candidates: Set<number>): boolean {
  for (const inst of body) {
    let ok = true;
    if (inst.kind === "Call" && (inst.callee ?? {}).kind === "Direct" && candidates.has(inst.callee.func)) {
      const argv: number[] = [];
      if (inst.recv !== undefined && inst.recv !== null) argv.push(inst.recv);
      for (const a of inst.args ?? []) argv.push(a);
      ok = directCallArgsI64Safe(argv, analysis);
    } else if (inst.kind === "Loop") {
      ok = validateI64DirectCalls(inst.condBody ?? [], analysis, candidates) && validateI64DirectCalls(inst.body ?? [], analysis, candidates);
    } else if (inst.kind === "If") {
      ok = validateI64DirectCalls(inst.thenBody ?? [], analysis, candidates) && validateI64DirectCalls(inst.elseBody ?? [], analysis, candidates);
    }
    if (!ok) return false;
  }
  return true;
}

function collectI64SeedParamFacts(
  prog: Program,
  candidates: Set<number>,
  baseParamFacts: Map<number, Map<number, NumFact>>,
  returnFacts: Map<number, NumFact>
): Map<number, Map<number, NumFact>> {
  const fnParams = new Map<number, number[]>();
  for (const f of prog.functions as any[]) fnParams.set(f.id, (f.params as number[]).slice());
  const out = new Map<number, Map<number, NumFact>>();
  for (const caller of prog.functions as any[]) {
    const localClass = localClassMap(caller);
    const unboxed = unboxedCandidates(caller, localClass);
    const paramFacts = baseParamFacts.get(caller.id) ?? new Map<number, NumFact>();
    const analysis = inferNumericAnalysis(caller.body, unboxed, paramFacts, returnFacts);
    const callerNumericParams: number[] = (caller.params as number[]).filter((p) => localIsNumber(prog, caller, p));
    const numericValues = numericValueLocs(caller.body, callerNumericParams, candidates);
    const flat: any[] = [];
    flattenInst(caller.body, flat);
    for (const inst of flat) {
      if (inst.kind === "Call" && (inst.callee ?? {}).kind === "Direct" && candidates.has(inst.callee.func)) {
        const argv: number[] = [];
        if (inst.recv !== undefined && inst.recv !== null) argv.push(inst.recv);
        for (const a of inst.args ?? []) argv.push(a);
        let dst = out.get(inst.callee.func);
        if (dst === undefined) {
          dst = new Map<number, NumFact>();
          out.set(inst.callee.func, dst);
        }
        const params = fnParams.get(inst.callee.func);
        if (params !== undefined) {
          params.forEach((p, idx) => {
            const arg = argv[idx];
            if (arg !== undefined && numericValues.has(arg)) {
              const fact = analysis.facts.get(arg);
              if (fact !== undefined && fact.i64Safe) {
                const old = dst!.get(p);
                dst!.set(p, old !== undefined ? nfJoin(old, fact) : fact);
              }
            }
          });
        }
      }
    }
  }
  return out;
}

/** Shared candidate filter for the i64/f64 fast paths. body_has_json_dom is
 *  omitted: i64BodySupported only admits Const/Copy/BinOp/UnOp/Return/Break/
 *  Continue/direct-Call/Loop/If, none of which can introduce JSON DOM locals. */
function numericFastCandidates(prog: Program, indirect: Set<number>): Set<number> {
  const out = new Set<number>();
  for (const f of prog.functions as any[]) {
    if (
      !indirect.has(f.id) &&
      !f.isAsync &&
      !f.isGenerator &&
      !f.takesThis &&
      (f.restParam === undefined || f.restParam === null) &&
      typeIsNumber(prog, f.ret) &&
      (f.params as number[]).every((p) => localIsNumber(prog, f, p)) &&
      i64BodySupported(f.body)
    ) {
      out.add(f.id);
    }
  }
  return out;
}

function setEq(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function inferI64FastFuncs(
  prog: Program,
  indirect: Set<number>,
  baseParamFacts: Map<number, Map<number, NumFact>>
): Map<number, I64FuncInfo> {
  let candidates = numericFastCandidates(prog, indirect);
  let lastInfos = new Map<number, I64FuncInfo>();
  for (let outer = 0; outer < 8; outer++) {
    let retAssumptions = new Map<number, NumFact>();
    for (const id of candidates) retAssumptions.set(id, nfI64Value());
    let nextInfos = new Map<number, I64FuncInfo>();
    for (let inner = 0; inner < 8; inner++) {
      const seeds = collectI64SeedParamFacts(prog, candidates, baseParamFacts, retAssumptions);
      const refinedReturns = new Map<number, NumFact>(retAssumptions);
      const iterInfos = new Map<number, I64FuncInfo>();
      for (const f of prog.functions as any[]) {
        if (candidates.has(f.id)) {
          const params: number[] = (f.params as number[]).slice();
          const seed = seeds.get(f.id);
          if (seed !== undefined && params.every((p) => (seed.get(p) ?? nfUnknown()).i64Safe)) {
            const localClass = localClassMap(f);
            const unboxed = unboxedCandidates(f, localClass);
            if (params.every((p) => unboxed.has(p))) {
              const analysis = inferNumericAnalysis(f.body, unboxed, seed, retAssumptions);
              if (
                validateI64DirectCalls(f.body, analysis, candidates) &&
                returnsNumericValues(f.body, params, candidates)
              ) {
                const retFact = collectReturnFact(f.body, analysis) ?? nfUnknown();
                if (retFact.i64Safe) {
                  refinedReturns.set(f.id, retFact);
                  iterInfos.set(f.id, { params, paramFacts: seed, retFact });
                }
              }
            }
          }
        }
      }
      nextInfos = iterInfos;
      if (nfMapEq(refinedReturns, retAssumptions)) break;
      retAssumptions = refinedReturns;
    }
    const nextCandidates = new Set<number>(nextInfos.keys());
    if (setEq(nextCandidates, candidates)) return nextInfos;
    candidates = nextCandidates;
    lastInfos = nextInfos;
    if (candidates.size === 0) break;
  }
  return lastInfos;
}

function inferF64FastFuncs(
  prog: Program,
  indirect: Set<number>,
  i64Fast: Map<number, I64FuncInfo>
): Map<number, F64FuncInfo> {
  let candidates = numericFastCandidates(prog, indirect);
  let lastInfos = new Map<number, F64FuncInfo>();
  for (let outer = 0; outer < 8; outer++) {
    const numericTargets = new Set<number>(i64Fast.keys());
    for (const c of candidates) numericTargets.add(c);
    const nextInfos = new Map<number, F64FuncInfo>();
    for (const f of prog.functions as any[]) {
      if (candidates.has(f.id)) {
        const params: number[] = (f.params as number[]).slice();
        const localClass = localClassMap(f);
        const unboxed = unboxedCandidates(f, localClass);
        if (params.every((p) => unboxed.has(p)) && returnsNumericValues(f.body, params, numericTargets)) {
          nextInfos.set(f.id, { params });
        }
      }
    }
    const nextCandidates = new Set<number>(nextInfos.keys());
    if (setEq(nextCandidates, candidates)) return nextInfos;
    candidates = nextCandidates;
    lastInfos = nextInfos;
    if (candidates.size === 0) break;
  }
  return lastInfos;
}

// ------------------------------ emit context --------------------------------

/** Rust f64 Debug ({:?}) formatting: shortest roundtrip, ".0" for integral
 *  values in the non-exponent range, "1e20"-style above it. */
/** Shortest exponential form, equivalent to Number.prototype.toExponential()
 *  with no argument — derived from String(v) (the shortest round-trip digits)
 *  so the self-hosted build needs no toExponential host primitive. */
function toExponentialShortest(v: number): string {
  let s = String(v);
  let sign = "";
  if (s.startsWith("-")) {
    sign = "-";
    s = s.slice(1);
  }
  if (s.includes("e")) return sign + s; // already shortest exponential
  const dot = s.indexOf(".");
  const intPart = dot < 0 ? s : s.slice(0, dot);
  const fracPart = dot < 0 ? "" : s.slice(dot + 1);
  const digits = intPart + fracPart;
  let firstSig = 0;
  while (firstSig < digits.length && digits.charCodeAt(firstSig) === 48) firstSig += 1;
  if (firstSig >= digits.length) return sign + "0e+0"; // v === 0 (callers guard)
  const exp = intPart.length - 1 - firstSig;
  let mant = digits.slice(firstSig);
  let lastSig = mant.length;
  while (lastSig > 1 && mant.charCodeAt(lastSig - 1) === 48) lastSig -= 1;
  mant = mant.slice(0, lastSig);
  const mantStr = mant.length === 1 ? mant : mant.slice(0, 1) + "." + mant.slice(1);
  const expStr = exp >= 0 ? `e+${exp}` : `e-${0 - exp}`;
  return sign + mantStr + expStr;
}

function rustF64Debug(v: number): string {
  // Rust Debug switches to scientific outside ~[1e-4, 1e16); JS String() only
  // outside [1e-6, 1e21). Calibrated against the Rust emitter: 0.0001 ->
  // "0.0001", 1e-5 -> "1e-5", 1e16 -> "1e16", 100 -> "100.0".
  const abs = Math.abs(v);
  if (v !== 0 && abs < 1e-4) {
    return toExponentialShortest(v).replace("e+", "e");
  }
  let s = String(v);
  if (s.includes("e")) {
    return s.replace("e+", "e");
  }
  if (s.includes(".")) return s;
  // integral (JS prints no decimal point below 1e21)
  if (abs >= 1e16) {
    return toExponentialShortest(v).replace("e+", "e");
  }
  return s + ".0";
}

interface EmitCtx {
  unboxed: Set<number>;
  intLocal: Set<number>;
  localClass: Map<number, number>;
  strat: Map<number, string>; // site -> "Stack"|"FrameArena"|"CallerArena"|"Heap"
  fnNames: Map<number, string>;
  fnTakesThis: Map<number, boolean>;
  staticStrings: Map<string, number>; // units.join(",") -> literal id
  wksym: Map<number, number>; // method-name id -> well-known-symbol id
  classes: Map<number, any>; // class id -> ClassDef
  jsonLocals: Set<number>; // locals kept as raw tjson_value* (DOM fast path)
  jsonRoots: Set<number>; // json.dom.parse roots tracked in _json_dom_scope
  domRefTotal: number; // whole-function count of DOM-referencing instructions
  scalarSlices: Map<number, ScalarStringSlice>; // alias local -> slice spec
  i64Fast: Map<number, I64FuncInfo>;
  f64Fast: Map<number, F64FuncInfo>;
  numericValueLocal: Set<number>;
  i64Mode: boolean;
  f64Mode: boolean;
  nroot: number;
  labelCtr: { n: number }; // fresh-label allocator (starts at 900000)
  loopLabels: [number, number][]; // (top, end) per enclosing loop
  finStack: [string, string, number, number][]; // (pend, pendv, fin_label, base_eh_depth)
  ehDepth: number; // live C EH handlers in the current emission path
}

/** True if body contains a Return/Throw, or a Break/Continue that escapes the
 *  region (i.e. not bound by a loop inside it). Mirrors body_exits_abruptly. */
function bodyExitsAbruptly(body: any[]): boolean {
  const walk = (b: any[], inLoop: boolean): boolean => {
    for (const i of b) {
      if (i.kind === "Return" || i.kind === "Throw") return true;
      if (i.kind === "Break" || i.kind === "Continue") {
        if (!inLoop) return true;
      } else if (i.kind === "If") {
        if (walk(i.thenBody ?? [], inLoop) || walk(i.elseBody ?? [], inLoop)) return true;
      } else if (i.kind === "Loop") {
        if (walk(i.condBody ?? [], true) || walk(i.body ?? [], true)) return true;
      } else if (i.kind === "TryCatch") {
        if (walk(i.tryBody ?? [], inLoop) || walk(i.catchBody ?? [], inLoop) || walk(i.finallyBody ?? [], inLoop)) return true;
      }
    }
    return false;
  };
  return walk(body, false);
}

function cxNum(cx: EmitCtx, id: number): string {
  if (cx.jsonLocals.has(id)) return `ts_json_dom_number(j${id})`;
  return cx.unboxed.has(id) ? `d${id}` : `ts_to_num(v${id})`;
}
function cxNumc(cx: EmitCtx, id: number): string {
  if (cx.jsonLocals.has(id)) return `ts_json_dom_number(j${id})`;
  return cx.unboxed.has(id) ? `d${id}` : `ts_number_coerce(v${id})`;
}
function cxNumcDouble(cx: EmitCtx, id: number): string {
  if (cx.jsonLocals.has(id)) return `ts_json_dom_number(j${id})`;
  return cx.unboxed.has(id) ? `((double)d${id})` : `ts_number_coerce(v${id})`;
}
function cxVal(cx: EmitCtx, id: number): string {
  if (cx.jsonLocals.has(id)) return `ts_json_dom_to_tsv(j${id})`;
  if (cx.intLocal.has(id)) return `ts_num((double)d${id})`;
  if (cx.unboxed.has(id)) return `ts_num(d${id})`;
  return `v${id}`;
}
function cxJval(cx: EmitCtx, id: number): string {
  if (cx.jsonLocals.has(id)) return `j${id}`;
  return `ts_json_dom_parse(${cxVal(cx, id)})`;
}
function cxSetNum(cx: EmitCtx, id: number, e: string): string {
  return cx.unboxed.has(id) ? `  d${id} = ${e};\n` : `  v${id} = ts_num(${e});\n`;
}
function cxSetVal(cx: EmitCtx, id: number, e: string): string {
  if (cx.intLocal.has(id)) return `  d${id} = (long long)ts_to_num(${e});\n`;
  if (cx.unboxed.has(id)) return `  d${id} = ts_to_num(${e});\n`;
  return `  v${id} = ${e};\n`;
}

function methodKeyStr(nameId: number, wksym: Map<number, number>): string {
  const w = wksym.get(nameId);
  return w !== undefined ? `TS_KEY_WKSYM(${w}u)` : `TS_KEY_METHOD(${nameId}u)`;
}

/** Mirrors emit_method_value_lookup: own field-key first (when known), then the
 *  prototype method-key; loud TypeErrors for null recv / non-callable. */
function emitMethodValueLookup(s: string[], recvExpr: string, methodId: number, methodField: number | undefined, wksym: Map<number, number>): void {
  const nameField = methodField ?? 0;
  s.push(`    ts_check_method_recv(${recvExpr}, ${nameField}u);\n`);
  if (methodField !== undefined) {
    s.push(`    tsv _mv = ts_get(${recvExpr}, ${methodField}u);\n`);
    s.push(`    if (!ts_is_callable(_mv)) _mv = ts_get(${recvExpr}, ${methodKeyStr(methodId, wksym)});\n`);
  } else {
    s.push(`    tsv _mv = ts_get(${recvExpr}, ${methodKeyStr(methodId, wksym)});\n`);
  }
  s.push(`    if (!ts_is_callable(_mv)) ts_dynamic_method_missing(${nameField}u);\n`);
}
function cxTruthy(cx: EmitCtx, id: number): string {
  if (cx.jsonLocals.has(id)) return `tjson_truthy(j${id})`;
  if (cx.intLocal.has(id)) return `(d${id} != 0)`;
  if (cx.unboxed.has(id)) return `(d${id} != 0 && d${id} == d${id})`;
  return `ts_truthy_fast(v${id})`;
}

const CMP_C_OPS: Record<string, string> = { "===": "==", "!==": "!=" };

// --------------------- coroutine state machines (async/generator) ---------------------
// Faithful port of emit_c's Flat/flatten_cf/emit_sm_resume_body and the three
// emit_*_function wrappers (typed locals live in the frame; #define aliasing
// keeps emit_inst output unchanged).

type SmMode = "Async" | "Generator" | "AsyncGenerator";
function smIsPromiseBacked(mode: SmMode): boolean {
  return mode === "Async" || mode === "AsyncGenerator";
}

type Flat =
  | { t: "Inst"; inst: any }
  | { t: "Label"; id: number }
  | { t: "Goto"; id: number }
  | { t: "GotoIfFalse"; cond: number; id: number }
  | { t: "Suspend"; inst: any }
  | { t: "Ret"; src?: number }
  | { t: "TryEnter"; catchLabel: number }
  | { t: "TryNormalExit"; afterLabel: number }
  | { t: "InCoroThrow"; src: number }
  | { t: "CatchLabel"; catchLabel: number; catchVar?: number }
  | { t: "AfterLabel"; afterLabel: number }
  | { t: "FinallyEnterTry"; finCatchLabel: number }
  | { t: "FinallyGotoNormal"; finLabel: number }
  | { t: "FinallyCatchLabel"; finCatchLabel: number; finLabel: number }
  | { t: "FinallyLabel"; finLabel: number }
  | { t: "FinallyAbrupt"; kind: number; value?: number; target: number; finLabel: number }
  | { t: "FinallyDispatch"; afterLabel: number; outerFin?: number };

interface SmFinFrame {
  finLabel: number;
  loopsAtEntry: number;
}

interface FlattenState {
  loops: [number, number][];
  fins: SmFinFrame[];
  next: { n: number };
}

function smCatchVarOf(inst: any): number | undefined {
  return inst.catchVar === null || inst.catchVar === undefined ? undefined : inst.catchVar;
}

function flattenCf(body: any[], out: Flat[], st: FlattenState): void {
  const fresh = () => st.next.n++;
  for (const inst of body) {
    switch (inst.kind) {
      case "If": {
        const lElse = fresh(), lEnd = fresh();
        out.push({ t: "GotoIfFalse", cond: inst.cond, id: lElse });
        flattenCf(inst.thenBody ?? [], out, st);
        out.push({ t: "Goto", id: lEnd });
        out.push({ t: "Label", id: lElse });
        flattenCf(inst.elseBody ?? [], out, st);
        out.push({ t: "Label", id: lEnd });
        break;
      }
      case "Loop": {
        const lTop = fresh(), lEnd = fresh();
        out.push({ t: "Label", id: lTop });
        flattenCf(inst.condBody ?? [], out, st);
        out.push({ t: "GotoIfFalse", cond: inst.cond, id: lEnd });
        st.loops.push([lTop, lEnd]);
        flattenCf(inst.body ?? [], out, st);
        st.loops.pop();
        out.push({ t: "Goto", id: lTop });
        out.push({ t: "Label", id: lEnd });
        break;
      }
      case "Break": {
        const idx = st.loops.length - 1 - (inst.up || 0);
        if (idx < 0) throw new UnportedError("break target outside loop in coroutine");
        const end = st.loops[idx][1];
        const fin = st.fins.length > 0 ? st.fins[st.fins.length - 1] : undefined;
        if (fin !== undefined && idx < fin.loopsAtEntry) {
          out.push({ t: "FinallyAbrupt", kind: 3, value: undefined, target: end, finLabel: fin.finLabel });
        } else {
          out.push({ t: "Goto", id: end });
        }
        break;
      }
      case "Continue": {
        const idx = st.loops.length - 1 - (inst.up || 0);
        if (idx < 0) throw new UnportedError("continue target outside loop in coroutine");
        const top = st.loops[idx][0];
        const fin = st.fins.length > 0 ? st.fins[st.fins.length - 1] : undefined;
        if (fin !== undefined && idx < fin.loopsAtEntry) {
          out.push({ t: "FinallyAbrupt", kind: 4, value: undefined, target: top, finLabel: fin.finLabel });
        } else {
          out.push({ t: "Goto", id: top });
        }
        break;
      }
      case "Await":
      case "Yield":
        out.push({ t: "Suspend", inst });
        break;
      case "Return": {
        const fin = st.fins.length > 0 ? st.fins[st.fins.length - 1] : undefined;
        if (fin !== undefined) {
          out.push({ t: "FinallyAbrupt", kind: 2, value: inst.src, target: 0, finLabel: fin.finLabel });
        } else {
          out.push({ t: "Ret", src: inst.src });
        }
        break;
      }
      case "Throw":
        out.push({ t: "InCoroThrow", src: inst.src });
        break;
      case "TryCatch": {
        const finallyBody = inst.finallyBody ?? [];
        if (finallyBody.length > 0) {
          flattenTryFinally(inst, out, st);
        } else {
          const catchLabel = fresh(), afterLabel = fresh();
          out.push({ t: "TryEnter", catchLabel });
          flattenCf(inst.tryBody ?? [], out, st);
          out.push({ t: "TryNormalExit", afterLabel });
          out.push({ t: "CatchLabel", catchLabel, catchVar: smCatchVarOf(inst) });
          flattenCf(inst.catchBody ?? [], out, st);
          out.push({ t: "AfterLabel", afterLabel });
        }
        break;
      }
      default:
        out.push({ t: "Inst", inst });
    }
  }
}

function flattenTryFinally(inst: any, out: Flat[], st: FlattenState): void {
  const fresh = () => st.next.n++;
  const finCatchLabel = fresh();
  const finLabel = fresh();
  const afterLabel = fresh();
  const catchBody = inst.catchBody ?? [];
  const hasCatch = catchBody.length > 0 || smCatchVarOf(inst) !== undefined;

  out.push({ t: "FinallyEnterTry", finCatchLabel });
  st.fins.push({ finLabel, loopsAtEntry: st.loops.length });
  if (hasCatch) {
    const catchLabel = fresh(), catchDone = fresh();
    out.push({ t: "TryEnter", catchLabel });
    flattenCf(inst.tryBody ?? [], out, st);
    out.push({ t: "TryNormalExit", afterLabel: catchDone });
    out.push({ t: "CatchLabel", catchLabel, catchVar: smCatchVarOf(inst) });
    flattenCf(catchBody, out, st);
    out.push({ t: "AfterLabel", afterLabel: catchDone });
    out.push({ t: "FinallyGotoNormal", finLabel });
  } else {
    flattenCf(inst.tryBody ?? [], out, st);
    out.push({ t: "FinallyGotoNormal", finLabel });
  }
  out.push({ t: "FinallyCatchLabel", finCatchLabel, finLabel });
  st.fins.pop();
  out.push({ t: "FinallyLabel", finLabel });
  flattenCf(inst.finallyBody ?? [], out, st);
  const outerFin = st.fins.length > 0 ? st.fins[st.fins.length - 1].finLabel : undefined;
  out.push({ t: "FinallyDispatch", afterLabel, outerFin });
  out.push({ t: "AfterLabel", afterLabel });
}

function emitSmCompletion(s: string[], mode: SmMode, val: string): void {
  if (mode === "Async") {
    s.push("  ts_eh_pop();\n");
    s.push(`  ts_promise_resolve_v(_fr->c.ret, ${val});\n`);
    s.push("  return TS_UNDEFINED;\n");
  } else if (mode === "Generator") {
    s.push(`  _fr->c.yielded = ${val};\n`);
    s.push("  _fr->c.done = 1;\n  return TS_UNDEFINED;\n");
  } else {
    s.push("  ts_eh_pop();\n  _fr->c.done = 1;\n");
    s.push(`  ts_promise_resolve_v(_fr->c.ret, ts_iter_result(${val}, 1));\n`);
    s.push("  return TS_UNDEFINED;\n");
  }
}

function emitSmResumeBody(s: string[], f: any, cx: EmitCtx, numericFacts: NumericAnalysis, mode: SmMode): void {
  const flat: Flat[] = [];
  const st: FlattenState = { loops: [], fins: [], next: { n: 0 } };
  flattenCf(f.body as any[], flat, st);

  let nStates = 1;
  for (const fl of flat) if (fl.t === "Suspend") nStates += 1;

  const catchLabels: number[] = [];
  for (const fl of flat) {
    if (fl.t === "CatchLabel") catchLabels.push(fl.catchLabel);
    else if (fl.t === "FinallyCatchLabel") catchLabels.push(fl.finCatchLabel);
  }
  const hasCoroTry = catchLabels.length > 0;
  const finTargets: number[] = [];
  for (const fl of flat) {
    if (fl.t === "FinallyAbrupt" && (fl.kind === 3 || fl.kind === 4)) finTargets.push(fl.target);
  }

  if (smIsPromiseBacked(mode)) {
    s.push("  if (setjmp(_fr->c.reject_buf) != 0) {\n");
    if (mode === "AsyncGenerator") s.push("    _fr->c.done = 1;\n");
    s.push("    ts_promise_reject_v(_fr->c.ret, ts_current_exception());\n");
    s.push("    return TS_UNDEFINED;\n");
    s.push("  }\n");
    s.push("  ts_eh_push_coro(&_fr->c.reject_buf);\n");
  }

  if (hasCoroTry) {
    s.push("  if (_fr->c.eh_top > 0) {\n");
    s.push("    if (setjmp(_fr->c.eh_buf) != 0) {\n");
    s.push("      int _t = --_fr->c.eh_top;\n");
    s.push("      ts_gc_set_root_depth(_fr->c.eh_gc_depth[_t]);\n");
    s.push("      ts_eh_pop();\n");
    s.push("      switch (_fr->c.eh_catch_state[_t]) {\n");
    for (const cl of catchLabels) s.push(`        case ${cl}: goto LC${cl};\n`);
    s.push("        default: ;\n      }\n");
    s.push("    }\n");
    s.push("    for (int _i = 0; _i < _fr->c.eh_top; _i++) ts_eh_push_coro(&_fr->c.eh_buf);\n");
    s.push("  }\n");
  }

  s.push("  switch (_fr->c.state) {\n");
  for (let stt = 0; stt < nStates; stt++) s.push(`  case ${stt}: goto S${stt};\n`);
  s.push("  }\n");

  let curState = 0;
  s.push(`  S${curState}: ;\n`);
  const emitCatchSwitch = (s2: string[], indent: string): void => {
    s2.push(`${indent}switch (_fr->c.eh_catch_state[_t]) {\n`);
    for (const cl of catchLabels) s2.push(`${indent}  case ${cl}: goto LC${cl};\n`);
    s2.push(`${indent}  default: ;\n${indent}}\n`);
  };
  const popIfActive = (): void => {
    if (hasCoroTry) s.push("  for (int _i = 0; _i < _fr->c.eh_top; _i++) ts_eh_pop();\n");
    if (smIsPromiseBacked(mode)) s.push("  ts_eh_pop();\n");
  };
  const throwGuard = (): void => {
    if (hasCoroTry) {
      s.push("  if (_fr->c.rejected) {\n");
      s.push("    _fr->c.rejected = 0;\n");
      s.push("    if (_fr->c.eh_top > 0) {\n");
      s.push("      g_exception_set(_fr->c.result);\n");
      s.push("      int _t = --_fr->c.eh_top;\n");
      s.push("      ts_eh_pop();\n");
      s.push("      ts_gc_set_root_depth(_fr->c.eh_gc_depth[_t]);\n");
      s.push("      switch (_fr->c.eh_catch_state[_t]) {\n");
      for (const cl of catchLabels) s.push(`        case ${cl}: goto LC${cl};\n`);
      s.push("        default: ;\n      }\n");
      s.push("    }\n");
      s.push("    ts_throw(_fr->c.result);\n");
      s.push("  }\n");
    } else {
      s.push("  if (_fr->c.rejected) { _fr->c.rejected = 0; ts_throw(_fr->c.result); }\n");
    }
  };

  for (const fl of flat) {
    switch (fl.t) {
      case "Inst":
        emitInstC(s, fl.inst, cx, numericFacts);
        break;
      case "Label":
        s.push(`  L${fl.id}: ;\n`);
        break;
      case "Goto":
        s.push(`  goto L${fl.id};\n`);
        break;
      case "GotoIfFalse":
        s.push(`  if (!${cxTruthy(cx, fl.cond)}) goto L${fl.id};\n`);
        break;
      case "TryEnter":
        s.push("  {\n    int _t = _fr->c.eh_top++;\n");
        s.push("    _fr->c.eh_gc_depth[_t] = ts_gc_root_depth();\n");
        s.push(`    _fr->c.eh_catch_state[_t] = ${fl.catchLabel};\n`);
        s.push("  }\n");
        s.push("  if (setjmp(_fr->c.eh_buf) != 0) {\n");
        s.push("    int _t = --_fr->c.eh_top;\n");
        s.push("    ts_gc_set_root_depth(_fr->c.eh_gc_depth[_t]);\n");
        s.push("    ts_eh_pop();\n");
        s.push(`    goto LC${fl.catchLabel};\n`);
        s.push("  }\n");
        s.push("  ts_eh_push_coro(&_fr->c.eh_buf);\n");
        break;
      case "TryNormalExit":
        s.push("  ts_eh_pop();\n  _fr->c.eh_top--;\n");
        s.push(`  goto L${fl.afterLabel};\n`);
        break;
      case "InCoroThrow":
        if (hasCoroTry) {
          s.push("  if (_fr->c.eh_top > 0) {\n");
          s.push(`    g_exception_set(${cxVal(cx, fl.src)});\n`);
          s.push("    int _t = --_fr->c.eh_top;\n");
          s.push("    ts_eh_pop();\n");
          s.push("    ts_gc_set_root_depth(_fr->c.eh_gc_depth[_t]);\n");
          s.push("    switch (_fr->c.eh_catch_state[_t]) {\n");
          for (const cl of catchLabels) s.push(`      case ${cl}: goto LC${cl};\n`);
          s.push("      default: ;\n    }\n");
          s.push("  }\n");
        }
        s.push(`  ts_throw(${cxVal(cx, fl.src)});\n`);
        break;
      case "CatchLabel":
        s.push(`  LC${fl.catchLabel}: ;\n`);
        if (fl.catchVar !== undefined) s.push(cxSetVal(cx, fl.catchVar, "ts_current_exception()"));
        break;
      case "AfterLabel":
        s.push(`  L${fl.afterLabel}: ;\n`);
        break;
      case "FinallyEnterTry":
        s.push("  {\n    int _t = _fr->c.eh_top++;\n");
        s.push("    _fr->c.eh_gc_depth[_t] = ts_gc_root_depth();\n");
        s.push(`    _fr->c.eh_catch_state[_t] = ${fl.finCatchLabel};\n`);
        s.push("  }\n");
        s.push("  if (setjmp(_fr->c.eh_buf) != 0) {\n");
        s.push("    int _t = --_fr->c.eh_top;\n");
        s.push("    ts_gc_set_root_depth(_fr->c.eh_gc_depth[_t]);\n");
        s.push("    ts_eh_pop();\n");
        s.push(`    goto LC${fl.finCatchLabel};\n`);
        s.push("  }\n");
        s.push("  ts_eh_push_coro(&_fr->c.eh_buf);\n");
        break;
      case "FinallyGotoNormal":
        s.push("  ts_eh_pop();\n  _fr->c.eh_top--;\n");
        s.push("  { int _f = _fr->c.fin_top++; _fr->c.fin_pending[_f] = 0; }\n");
        s.push(`  goto L${fl.finLabel};\n`);
        break;
      case "FinallyCatchLabel":
        s.push(`  LC${fl.finCatchLabel}: ;\n`);
        s.push("  { int _f = _fr->c.fin_top++; _fr->c.fin_pending[_f] = 1; _fr->c.fin_exc[_f] = ts_current_exception(); }\n");
        s.push(`  goto L${fl.finLabel};\n`);
        break;
      case "FinallyLabel":
        s.push(`  L${fl.finLabel}: ;\n`);
        break;
      case "FinallyAbrupt":
        s.push("  ts_eh_pop();\n  _fr->c.eh_top--;\n");
        s.push(`  { int _f = _fr->c.fin_top++; _fr->c.fin_pending[_f] = ${fl.kind}; _fr->c.fin_tgt[_f] = ${fl.target};\n`);
        if (fl.value !== undefined && fl.value !== null) s.push(`    _fr->c.fin_exc[_f] = ${cxVal(cx, fl.value)};\n`);
        s.push("  }\n");
        s.push(`  goto L${fl.finLabel};\n`);
        break;
      case "FinallyDispatch":
        s.push("  { int _f = --_fr->c.fin_top; int _k = _fr->c.fin_pending[_f];\n");
        if (fl.outerFin !== undefined) {
          s.push("    if (_k != 0) {\n");
          s.push("      int _of = _fr->c.fin_top++;\n");
          s.push("      _fr->c.fin_pending[_of] = _k;\n");
          s.push("      _fr->c.fin_exc[_of] = _fr->c.fin_exc[_f];\n");
          s.push("      _fr->c.fin_tgt[_of] = _fr->c.fin_tgt[_f];\n");
          s.push(`      goto L${fl.outerFin};\n`);
          s.push("    }\n");
          s.push("  }\n");
          s.push(`  goto L${fl.afterLabel};\n`);
        } else {
          s.push("    if (_k == 1) {\n");
          if (hasCoroTry) {
            s.push("      if (_fr->c.eh_top > 0) {\n");
            s.push("        g_exception_set(_fr->c.fin_exc[_f]);\n");
            s.push("        int _t = --_fr->c.eh_top;\n");
            s.push("        ts_eh_pop();\n");
            s.push("        ts_gc_set_root_depth(_fr->c.eh_gc_depth[_t]);\n");
            s.push("        switch (_fr->c.eh_catch_state[_t]) {\n");
            for (const cl of catchLabels) s.push(`          case ${cl}: goto LC${cl};\n`);
            s.push("          default: ;\n        }\n");
            s.push("      }\n");
          }
          s.push("      ts_throw(_fr->c.fin_exc[_f]);\n");
          s.push("    }\n");
          s.push("    if (_k == 2) {\n");
          if (hasCoroTry) s.push("      while (_fr->c.eh_top > 0) { ts_eh_pop(); _fr->c.eh_top--; }\n");
          emitSmCompletion(s, mode, "_fr->c.fin_exc[_f]");
          s.push("    }\n");
          if (finTargets.length > 0) {
            s.push("    if (_k == 3 || _k == 4) {\n");
            s.push("      switch (_fr->c.fin_tgt[_f]) {\n");
            for (const t of finTargets) s.push(`        case ${t}: goto L${t};\n`);
            s.push("        default: ;\n      }\n");
            s.push("    }\n");
          }
          s.push("  }\n");
          s.push(`  goto L${fl.afterLabel};\n`);
        }
        break;
      case "Suspend": {
        curState += 1;
        const inst = fl.inst;
        if ((mode === "Async" || mode === "AsyncGenerator") && inst.kind === "Await") {
          s.push(`  _fr->c.state = ${curState};\n`);
          s.push(`  ts_await_register_v(${cxVal(cx, inst.operand)}, ts_obj(&_fr->c));\n`);
          popIfActive();
          s.push("  return TS_UNDEFINED;\n");
          s.push(`  S${curState}: ;\n`);
          throwGuard();
          if (inst.dst !== undefined && inst.dst !== null) s.push(cxSetVal(cx, inst.dst, "_fr->c.result"));
        } else if (mode === "Generator" && inst.kind === "Yield") {
          s.push(`  _fr->c.yielded = ${cxVal(cx, inst.operand)};\n`);
          s.push(`  _fr->c.state = ${curState};\n`);
          popIfActive();
          s.push("  return TS_UNDEFINED;\n");
          s.push(`  S${curState}: ;\n`);
          throwGuard();
          if (inst.dst !== undefined && inst.dst !== null) s.push(cxSetVal(cx, inst.dst, "_fr->c.result"));
        } else if (mode === "AsyncGenerator" && inst.kind === "Yield") {
          s.push(`  _fr->c.state = ${curState};\n`);
          s.push(`  ts_promise_resolve_v(_fr->c.ret, ts_iter_result(${cxVal(cx, inst.operand)}, 0));\n`);
          popIfActive();
          s.push("  return TS_UNDEFINED;\n");
          s.push(`  S${curState}: ;\n`);
          throwGuard();
          if (inst.dst !== undefined && inst.dst !== null) s.push(cxSetVal(cx, inst.dst, "_fr->c.result"));
        } else {
          s.push(`  S${curState}: ;\n`);
        }
        break;
      }
      case "Ret": {
        const v = fl.src !== undefined && fl.src !== null ? cxVal(cx, fl.src) : "TS_UNDEFINED";
        if (hasCoroTry) s.push("  while (_fr->c.eh_top > 0) { ts_eh_pop(); _fr->c.eh_top--; }\n");
        emitSmCompletion(s, mode, v);
        break;
      }
    }
  }
  emitSmCompletion(s, mode, "TS_UNDEFINED");
  void emitCatchSwitch;
}

/** Frame struct + resume fn + public entry for async/generator/asyncgen. */
function emitCoroutineFunctionC(out: string[], f: any, cx: EmitCtx, numericFacts: NumericAnalysis, mode: SmMode): void {
  const fname = cname(f);
  out.push(`typedef struct ${fname}_frame { ts_coro c;\n`);
  for (const l of f.locals) {
    if (cx.intLocal.has(l.id)) out.push(`  long long d${l.id};\n`);
    else if (cx.unboxed.has(l.id)) out.push(`  double d${l.id};\n`);
    else out.push(`  tsv v${l.id};\n`);
  }
  out.push(`} ${fname}_frame;\n`);

  out.push(`static tsv ${fname}_resume(tsv _cv){\n`);
  out.push(`  ${fname}_frame* _fr = (${fname}_frame*)ts_ptr(_cv);\n`);
  for (const l of f.locals) {
    if (cx.intLocal.has(l.id) || cx.unboxed.has(l.id)) out.push(`#define d${l.id} (_fr->d${l.id})\n`);
    else out.push(`#define v${l.id} (_fr->v${l.id})\n`);
  }
  emitSmResumeBody(out, f, cx, numericFacts, mode);
  for (const l of f.locals) {
    if (cx.intLocal.has(l.id) || cx.unboxed.has(l.id)) out.push(`#undef d${l.id}\n`);
    else out.push(`#undef v${l.id}\n`);
  }
  out.push("}\n");

  out.push(`static tsv ${fname}(tsv* args, int nargs){\n`);
  out.push("  (void)nargs;\n");
  out.push(`  tsv _cv = ts_coro_alloc_v(sizeof(${fname}_frame), ${fname}_resume);\n`);
  out.push("  ts_gc_root(&_cv);\n");
  out.push(`  ${fname}_frame* _fr = (${fname}_frame*)ts_ptr(_cv);\n`);
  (f.params as number[]).forEach((p, i) => {
    if (cx.intLocal.has(p)) out.push(`  if (nargs > ${i}) _fr->d${p} = (long long)ts_to_num(args[${i}]);\n`);
    else if (cx.unboxed.has(p)) out.push(`  if (nargs > ${i}) _fr->d${p} = ts_to_num(args[${i}]);\n`);
    else out.push(`  if (nargs > ${i}) _fr->v${p} = args[${i}];\n`);
  });
  if (mode === "Async") {
    out.push("  tsv _ret = _fr->c.ret;\n");
    out.push("  ts_coro_resume_v(_cv);\n");
    out.push("  ts_gc_unroot(1);\n");
    out.push("  return _ret;\n}\n\n");
  } else if (mode === "Generator") {
    out.push("  tsv _gen = ts_gen_new_v(_cv);\n");
    out.push("  ts_gc_unroot(1);\n");
    out.push("  return _gen;\n}\n\n");
  } else {
    out.push("  tsv _gen = ts_asyncgen_new_v(_cv);\n");
    out.push("  ts_gc_unroot(1);\n");
    out.push("  return _gen;\n}\n\n");
  }
}

interface FinCtx {
  pend: string;
  pendv: string;
  finLabel: number;
}

/** Mirrors emit_guarded: re-route abrupt completions (return/break/continue)
 *  through the enclosing finally's completion record. */
function emitGuarded(s: string[], body: any[], cx: EmitCtx, numericFacts: NumericAnalysis, fc: FinCtx, loopDepth: number): void {
  for (const inst of body) {
    switch (inst.kind) {
      case "Return": {
        const v = inst.src !== undefined && inst.src !== null ? cxVal(cx, inst.src) : "TS_UNDEFINED";
        s.push(`  ${fc.pendv} = ${v}; ${fc.pend} = 1; ts_eh_pop(); goto L${fc.finLabel};\n`);
        break;
      }
      case "Break":
        if (loopDepth === 0) s.push(`  ${fc.pend} = 2; ts_eh_pop(); goto L${fc.finLabel};\n`);
        else s.push("  break;\n");
        break;
      case "Continue":
        if (loopDepth === 0) s.push(`  ${fc.pend} = 3; ts_eh_pop(); goto L${fc.finLabel};\n`);
        else s.push("  continue;\n");
        break;
      case "If":
        s.push(`  if (${cxTruthy(cx, inst.cond)}) {\n`);
        emitGuarded(s, inst.thenBody ?? [], cx, numericFacts, fc, loopDepth);
        s.push("  } else {\n");
        emitGuarded(s, inst.elseBody ?? [], cx, numericFacts, fc, loopDepth);
        s.push("  }\n");
        break;
      case "Loop":
        // a loop local to the guarded region: break/continue inside target it.
        s.push("  for (;;) {\n");
        emitGuarded(s, inst.condBody ?? [], cx, numericFacts, fc, loopDepth + 1);
        s.push(`    if (!${cxTruthy(cx, inst.cond)}) break;\n`);
        emitGuarded(s, inst.body ?? [], cx, numericFacts, fc, loopDepth + 1);
        s.push("  }\n");
        break;
      case "TryCatch": {
        const finallyBody: any[] = inst.finallyBody ?? [];
        if (finallyBody.length > 0 && (bodyExitsAbruptly(inst.tryBody ?? []) || bodyExitsAbruptly(inst.catchBody ?? []))) {
          // nested try/finally: propagates its completion OUT to fc via fin_stack.
          const outer = cx.loopLabels.length > 0 ? cx.loopLabels[cx.loopLabels.length - 1] : undefined;
          emitPlainFinally(s, inst, cx, numericFacts, outer);
        } else {
          emitInstC(s, inst, cx, numericFacts);
        }
        break;
      }
      default:
        emitInstC(s, inst, cx, numericFacts);
        break;
    }
  }
}

/** Mirrors emit_plain_finally: completion record + setjmp handler so
 *  return/break/continue/throw routes through the finally body. */
function emitPlainFinally(s: string[], inst: any, cx: EmitCtx, numericFacts: NumericAnalysis, outerLoop: [number, number] | undefined): void {
  const tryBody: any[] = inst.tryBody ?? [];
  const catchBody: any[] = inst.catchBody ?? [];
  const finallyBody: any[] = inst.finallyBody ?? [];
  const catchVar: number | undefined = inst.catchVar !== undefined && inst.catchVar !== null ? inst.catchVar : undefined;
  const finLabel = cx.labelCtr.n++;
  const afterLabel = cx.labelCtr.n++;
  const pend = `_pend${finLabel}`;
  const pendv = `_pendv${finLabel}`;
  const fc: FinCtx = { pend, pendv, finLabel };
  // completion record locals: kind (0 normal,1 return,2 break,3 continue,4 throw)
  s.push(`  int ${pend} = 0; tsv ${pendv} = TS_UNDEFINED;\n`);
  const hasCatch = catchBody.length > 0 || catchVar !== undefined;
  const baseEhDepth = cx.ehDepth;
  cx.finStack.push([pend, pendv, finLabel, baseEhDepth]);
  s.push("  {\n    ts_handler* _h = ts_eh_push();\n");
  cx.ehDepth = baseEhDepth + 1;
  s.push("    if (setjmp(_h->buf) == 0) {\n");
  emitGuarded(s, tryBody, cx, numericFacts, fc, 0);
  s.push("      ts_eh_pop();\n");
  s.push(`      goto L${finLabel};\n`);
  s.push("    } else {\n");
  s.push("      ts_gc_set_root_depth(_h->gc_root_len);\n      ts_eh_pop();\n");
  if (hasCatch) {
    if (catchVar !== undefined) s.push(`    ${cxSetVal(cx, catchVar, "ts_current_exception()")}`);
    s.push("      {\n        ts_handler* _h2 = ts_eh_push();\n");
    cx.ehDepth = baseEhDepth + 1;
    s.push("        if (setjmp(_h2->buf) == 0) {\n");
    emitGuarded(s, catchBody, cx, numericFacts, fc, 0);
    s.push("          ts_eh_pop();\n");
    s.push(`          goto L${finLabel};\n`);
    s.push("        } else {\n");
    s.push("          ts_gc_set_root_depth(_h2->gc_root_len);\n          ts_eh_pop();\n");
    s.push(`          ${pend} = 4; ${pendv} = ts_current_exception(); goto L${finLabel};\n`);
    s.push("        }\n      }\n");
  } else {
    s.push(`      ${pend} = 4; ${pendv} = ts_current_exception(); goto L${finLabel};\n`);
  }
  s.push("    }\n  }\n");
  cx.ehDepth = baseEhDepth;
  cx.finStack.pop();
  s.push(`  L${finLabel}: ;\n`);
  for (const i of finallyBody) emitInstC(s, i, cx, numericFacts);
  const outerFin = cx.finStack.length > 0 ? cx.finStack[cx.finStack.length - 1] : undefined;
  s.push(`  switch (${pend}) {\n`);
  if (outerFin !== undefined) {
    const [opend, opendv, ofin, odepth] = outerFin;
    const pops = Math.max(0, baseEhDepth - odepth);
    let popStr = "";
    for (let i = 0; i < pops; i++) popStr += "ts_eh_pop(); ";
    s.push(`    case 1: ${popStr}${opend} = 1; ${opendv} = ${pendv}; goto L${ofin};\n`);
    s.push(`    case 2: ${popStr}${opend} = 2; goto L${ofin};\n`);
    s.push(`    case 3: ${popStr}${opend} = 3; goto L${ofin};\n`);
    s.push(`    case 4: ${popStr}${opend} = 4; ${opendv} = ${pendv}; goto L${ofin};\n`);
  } else {
    const unroot = cx.nroot > 0 ? `ts_gc_unroot(${cx.nroot}); ` : "";
    s.push(`    case 1: ${unroot}return ${pendv};\n`);
    if (outerLoop !== undefined) {
      s.push(`    case 2: goto L${outerLoop[1]};\n`);
      s.push(`    case 3: goto L${outerLoop[0]};\n`);
    } else {
      s.push("    case 2: case 3: break;\n");
    }
    s.push(`    case 4: ts_throw(${pendv});\n`);
  }
  s.push("    default: ;\n  }\n");
  s.push(`  L${afterLabel}: ;\n`);
}

function emitInstC(s: string[], inst: any, cx: EmitCtx, numericFacts: NumericAnalysis): void {
  const unported = (what: string) => {
    const err = new UnportedError(`emitc inst: ${what}`);
    (err as any).partial = "";
    throw err;
  };
  switch (inst.kind) {
    case "AllocObject": {
      const st = cx.strat.get(inst.site) ?? "Heap";
      if (inst.classId !== undefined && inst.classId !== null) {
        const c: number = inst.classId;
        const cn = structName(c);
        const d: number = inst.dst;
        let protoExpr: string;
        if (inst.proto !== undefined && inst.proto !== null) {
          const pv = cxVal(cx, inst.proto);
          protoExpr = `(ts_is_obj(${pv}) ? ${pv} : CLASS_PROTO[${c}])`;
        } else {
          protoExpr = `CLASS_PROTO[${c}]`;
        }
        if (st === "Stack") {
          s.push(`  ${cn} sobj${d} = {0}; sobj${d}.header.h.kind=TS_KIND_OBJECT; sobj${d}.header.h.mark=0; sobj${d}.header.h.gen=2; sobj${d}.header.h.remembered=0; sobj${d}.header.h.handle=0; sobj${d}.header.h.size=sizeof(${cn}); sobj${d}.header.proto=${protoExpr}; sobj${d}.header.props=0; sobj${d}.header.cap=0; sobj${d}.header.len=0; sobj${d}.header.shape=0;\n`);
          s.push(`  v${d} = ts_obj(&sobj${d});\n`);
        } else {
          s.push(`  v${d} = ts_new_sized(sizeof(${cn}));\n`);
          s.push(`  ${cn}* hobj${d} = (${cn}*)ts_ptr(v${d});\n`);
          s.push(`  hobj${d}->header.proto=${protoExpr}; hobj${d}->header.props=0; hobj${d}->header.cap=0; hobj${d}->header.len=0;\n`);
        }
        return;
      }
      s.push(`  v${inst.dst} = ts_new_object(); /* site ${inst.site} ${st} */\n`);
      return;
    }
    case "AllocArray":
      s.push(`  v${inst.dst} = ts_new_array(0);\n`);
      return;
    case "AllocClosure": {
      const fname = cx.fnNames.get(inst.func) ?? `fn_${inst.func}`;
      const tt = cx.fnTakesThis.get(inst.func) ? 1 : 0;
      const setMeta =
        `  ts_set_fn_meta(v${inst.dst}, FN_ARITY[${inst.func}], FN_NAME[${inst.func}]);\n` +
        `  if (FN_HAS_PROTOTYPE[${inst.func}]) ts_set_fn_prototype(v${inst.dst}, ts_new_proto());\n`;
      const captures: any[] = inst.captures ?? [];
      if (captures.length === 0) {
        s.push(`  v${inst.dst} = ts_make_fn_t(${fname}, 0, 0, ${tt});\n`);
        s.push(setMeta);
      } else {
        s.push(`  { tsv _env[${captures.length}];\n`);
        captures.forEach((c, i) => s.push(`    _env[${i}] = ${cxVal(cx, c.cell)};\n`));
        s.push(`    v${inst.dst} = ts_make_fn_t(${fname}, _env, ${captures.length}, ${tt});\n`);
        s.push("  }\n");
        s.push(setMeta);
      }
      return;
    }
    case "AllocClassValue": {
      // Box a class as a callable value carrying class_id + the ctor's captured
      // cells; `new K()` later reads class_id via ts_construct.
      const fname = cx.fnNames.get(inst.ctor) ?? `fn_${inst.ctor}`;
      const setMeta = `  ts_set_fn_meta(v${inst.dst}, FN_ARITY[${inst.ctor}], CLASS_NAME[${inst.classId}]);\n`;
      const captures: any[] = inst.captures ?? [];
      if (captures.length === 0) {
        s.push(`  v${inst.dst} = ts_make_class_value(${inst.classId}u, ${fname}, 0, 0);\n`);
        s.push(setMeta);
      } else {
        s.push(`  { tsv _env[${captures.length}];\n`);
        captures.forEach((c, i) => s.push(`    _env[${i}] = ${cxVal(cx, c.cell)};\n`));
        s.push(`    v${inst.dst} = ts_make_class_value(${inst.classId}u, ${fname}, _env, ${captures.length});\n`);
        s.push("  }\n");
        s.push(setMeta);
      }
      return;
    }
    case "NewDynamic": {
      const args: number[] = inst.args ?? [];
      s.push(`  { tsv _a[${Math.max(args.length, 1)}];\n`);
      args.forEach((a, i) => s.push(`    _a[${i}] = ${cxVal(cx, a)};\n`));
      s.push(`  v${inst.dst} = ts_construct(${cxVal(cx, inst.callee)}, _a, ${args.length}); }\n`);
      return;
    }
    case "ConstructResult":
      // new step 4: object return overrides the instance; else the instance.
      s.push(cxSetVal(cx, inst.dst, `ts_construct_result(${cxVal(cx, inst.inst)}, ${cxVal(cx, inst.ret)})`));
      return;
    case "LoadClassProto":
      s.push(`  v${inst.dst} = CLASS_PROTO[${inst.classId}];\n`);
      return;
    case "StoreProtoMethod":
      // reassign a method on the class prototype, in the method-key space the
      // dynamic dispatch reads from; src must be a callable (ts_func) value.
      s.push(`  ts_set(CLASS_PROTO[${inst.classId}], ${methodKeyStr(inst.method, cx.wksym)}, ${cxVal(cx, inst.src)});\n`);
      return;
    case "Copy":
      if (cx.scalarSlices.has(inst.src)) {
        const ds = cx.scalarSlices.get(inst.dst);
        const ss = cx.scalarSlices.get(inst.src);
        if (ds !== undefined && ss !== undefined && ds.root === ss.root) return;
      }
      if (cx.jsonLocals.has(inst.dst) && cx.jsonLocals.has(inst.src)) {
        s.push(`  j${inst.dst} = j${inst.src};\n`);
        return;
      }
      if (cx.unboxed.has(inst.dst)) s.push(cxSetNum(cx, inst.dst, cxNum(cx, inst.src)));
      else s.push(cxSetVal(cx, inst.dst, cxVal(cx, inst.src)));
      return;
    case "StoreField": {
      const c = cx.localClass.get(inst.obj);
      if (c !== undefined) {
        const off = structDirectOffset(c, inst.field, cx.classes);
        if (off !== undefined) {
          const cn = structName(c);
          const isNum = numericFieldOf(c, inst.field, cx.classes);
          const rhs = isNum ? cxNum(cx, inst.src) : cxVal(cx, inst.src);
          // A method dispatched on a Proxy receiver gets this=proxy; route
          // `this.field = v` through ts_set (honoring traps) in that case.
          s.push(`  if (g_has_proxies && ts_is_proxy(v${inst.obj})) { ts_set(v${inst.obj}, ${inst.field}, ${cxVal(cx, inst.src)}); } else {\n`);
          s.push(`    ((${cn}*)ts_ptr(v${inst.obj}))->${off} = ${rhs};\n`);
          if (!isNum) s.push(`    ts_write_barrier(v${inst.obj}, ${rhs});\n`);
          s.push("  }\n");
          return;
        }
      }
      s.push(`  ts_set(v${inst.obj}, ${inst.field}, ${cxVal(cx, inst.src)});\n`);
      return;
    }
    case "LoadIndex":
      if (cx.jsonLocals.has(inst.arr)) {
        if (cx.jsonLocals.has(inst.dst)) {
          s.push(`  j${inst.dst} = ts_json_dom_index(${cxJval(cx, inst.arr)}, ${cxNumc(cx, inst.index)});\n`);
        } else {
          s.push(cxSetVal(cx, inst.dst, `ts_json_dom_to_tsv(ts_json_dom_index(${cxJval(cx, inst.arr)}, ${cxNumc(cx, inst.index)}))`));
        }
        return;
      }
      s.push(cxSetVal(cx, inst.dst, `ts_array_get(v${inst.arr}, (uint32_t)(${cxNum(cx, inst.index)}))`));
      return;
    case "StoreIndex":
      s.push(`  ts_array_set(v${inst.arr}, (uint32_t)(${cxNum(cx, inst.index)}), ${cxVal(cx, inst.src)});\n`);
      return;
    case "ArrayLen":
      if (cx.jsonLocals.has(inst.arr)) {
        s.push(cxSetNum(cx, inst.dst, `ts_json_dom_length(${cxJval(cx, inst.arr)})`));
        return;
      }
      s.push(cxSetNum(cx, inst.dst, `ts_array_len_fast(v${inst.arr})`));
      return;
    case "StoreGlobal":
      s.push(`  GLOBALS[${inst.gref}] = ${cxVal(cx, inst.src)};\n`);
      return;
    case "LoadGlobal":
      s.push(cxSetVal(cx, inst.dst, `GLOBALS[${inst.gref}]`));
      return;
    case "Const": {
      const v = inst.value;
      switch (v.kind) {
        case "Num": {
          const num = typeof v.value === "string" ? Number(v.value) : v.value;
          if (cx.intLocal.has(inst.dst)) s.push(`  d${inst.dst} = ${Math.trunc(num)};\n`);
          else s.push(cxSetNum(cx, inst.dst, rustF64Debug(num)));
          return;
        }
        case "Bool":
          if (cx.unboxed.has(inst.dst)) s.push(cxSetNum(cx, inst.dst, v.value ? "1" : "0"));
          else s.push(`  v${inst.dst} = ts_bool(${v.value ? 1 : 0});\n`);
          return;
        case "Str": {
          const id = cx.staticStrings.get(strUnits(v.value).join(","));
          if (id === undefined) throw new Error("static string literal not collected");
          s.push(cxSetVal(cx, inst.dst, `ts_str_v(&TS_STRLIT_${id})`));
          return;
        }
        case "Str16": {
          const id = cx.staticStrings.get((v.units as number[]).join(","));
          if (id === undefined) throw new Error("static string literal not collected");
          s.push(cxSetVal(cx, inst.dst, `ts_str_v(&TS_STRLIT_${id})`));
          return;
        }
        case "Undef": s.push(`  v${inst.dst} = TS_UNDEFINED;\n`); return;
        case "Null": s.push(`  v${inst.dst} = TS_NULL;\n`); return;
        case "NaN": s.push(cxSetNum(cx, inst.dst, "(0.0/0.0)")); return;
        case "PosInf": s.push(cxSetNum(cx, inst.dst, "(1.0/0.0)")); return;
        case "NegInf": s.push(cxSetNum(cx, inst.dst, "(-1.0/0.0)")); return;
        case "NegZero": s.push(cxSetNum(cx, inst.dst, "(-0.0)")); return;
        default: unported(`Const kind '${v.kind}'`);
      }
      return;
    }
    case "BinOp": {
      const { dst, op, lhs, rhs } = inst;
      const bothInt = cx.intLocal.has(lhs) && cx.intLocal.has(rhs);
      const dstInt = cx.intLocal.has(dst);
      const isCmpFast = CMP_OPS.has(op);
      const isI64ArithFast = dstInt && (op === "+" || op === "-" || op === "*");
      if (bothInt && (isCmpFast || isI64ArithFast)) {
        const cop = CMP_C_OPS[op] ?? op;
        const expr = `(d${lhs} ${cop} d${rhs})`;
        if (dstInt) s.push(`  d${dst} = ${expr};\n`);
        else if (isCmpFast) s.push(`  v${dst} = ts_bool(${expr});\n`);
        else s.push(cxSetNum(cx, dst, expr));
        return;
      }
      if (bothInt && dstInt && ["&", "|", "^", "<<", ">>", ">>>"].includes(op)) {
        const t = `_bw${dst}`;
        const wrap = `d${dst} = (${t} >= 0x80000000u) ? (long long)${t} - 0x100000000LL : (long long)${t};`;
        if (op === "&" || op === "|" || op === "^") {
          s.push(`  { uint32_t ${t} = ((uint32_t)d${lhs} ${op} (uint32_t)d${rhs}); ${wrap} }\n`);
        } else if (op === "<<") {
          s.push(`  { uint32_t ${t} = ((uint32_t)d${lhs}) << ((uint32_t)d${rhs} & 31u); ${wrap} }\n`);
        } else if (op === ">>") {
          s.push(
            `  { uint32_t ${t}l = (uint32_t)d${lhs}; uint32_t ${t}s = (uint32_t)d${rhs} & 31u; uint32_t ${t} = (${t}l & 0x80000000u) ? ~(~${t}l >> ${t}s) : (${t}l >> ${t}s); ${wrap} }\n`
          );
        } else {
          s.push(`  { uint32_t ${t} = ((uint32_t)d${lhs}) >> ((uint32_t)d${rhs} & 31u); d${dst} = (long long)${t}; }\n`);
        }
        return;
      }
      if (op === "%" && bothInt && numericFacts.nonzeroIntConst.has(rhs)) {
        // (loop_mod_residues: the loop emitter is not ported yet — residues empty)
        if (dstInt) {
          const divisor = numericFacts.intConst.get(rhs);
          if (divisor !== undefined && divisor > 0 && numericFacts.nonnegativeInt.has(lhs)) {
            // fast_bound = divisor*2 <= i64::MAX always holds (divisor <= 2^53)
            const fastBound = divisor * 2;
            const t = `_mr${dst}`;
            s.push(
              `  { long long ${t} = d${lhs}; d${dst} = (${t} < ${fastBound}LL ? (${t} >= ${divisor}LL ? ${t} - ${divisor}LL : ${t}) : (${t} % ${divisor}LL)); }\n`
            );
            return;
          }
        }
        if (dstInt) {
          s.push(`  d${dst} = (d${lhs} % d${rhs});\n`);
        } else {
          const t = `_mr${dst}`;
          s.push(`  { long long ${t}i = (d${lhs} % d${rhs}); double ${t} = (${t}i == 0 && d${lhs} < 0) ? -0.0 : (double)${t}i;\n`);
          s.push(cxSetNum(cx, dst, t));
          s.push("  }\n");
        }
        return;
      }
      if (op === "%" && bothInt && dstInt && numericFacts.nonzeroInt.has(rhs)) {
        s.push(`  d${dst} = (d${lhs} % d${rhs});\n`);
        return;
      }
      if (op === "%" && numericFacts.nonzeroIntConst.has(rhs)) {
        const l2 = cxNumcDouble(cx, lhs);
        const r2 = cxNumcDouble(cx, rhs);
        const t = `_md${dst}`;
        s.push(
          `  double ${t} = (double)(${l2}); double ${t}b = (double)(${r2}); if (isfinite(${t}) && ${t} == (double)(long long)${t}) { long long ${t}i = ((long long)${t} % (long long)${t}b); ${t} = (${t}i == 0 && (signbit(${t}) || ${t} < 0.0)) ? -0.0 : (double)${t}i; } else { ${t} = fmod(${t}, ${t}b); }\n`
        );
        if (cx.intLocal.has(dst)) s.push(`  d${dst} = (long long)${t};\n`);
        else s.push(cxSetNum(cx, dst, t));
        return;
      }
      const l = cxNumcDouble(cx, lhs);
      const r = cxNumcDouble(cx, rhs);
      const bothUnboxed = cx.unboxed.has(lhs) && cx.unboxed.has(rhs);
      let expr: string;
      switch (op) {
        case "+":
          if (cx.unboxed.has(lhs) && cx.unboxed.has(rhs)) expr = `(${l} + ${r})`;
          else if (cx.jsonLocals.has(lhs) && cx.jsonLocals.has(rhs)) {
            s.push(cxSetVal(cx, dst, `ts_json_dom_add(j${lhs}, j${rhs})`));
            return;
          } else if (cx.jsonLocals.has(lhs)) {
            s.push(cxSetVal(cx, dst, `ts_json_dom_add_left(j${lhs}, ${cxVal(cx, rhs)})`));
            return;
          } else if (cx.jsonLocals.has(rhs)) {
            s.push(cxSetVal(cx, dst, `ts_json_dom_add_right(${cxVal(cx, lhs)}, j${rhs})`));
            return;
          } else {
            s.push(cxSetVal(cx, dst, `ts_add(${cxVal(cx, lhs)}, ${cxVal(cx, rhs)})`));
            return;
          }
          break;
        case "-": expr = `(${l} - ${r})`; break;
        case "*": expr = `(${l} * ${r})`; break;
        case "/": expr = `((double)(${l}) / (double)(${r}))`; break;
        case "%": expr = `fmod((double)(${l}), (double)(${r}))`; break;
        case "<": expr = bothUnboxed ? `(${l} < ${r})` : `ts_relational(${cxVal(cx, lhs)}, ${cxVal(cx, rhs)}, 0)`; break;
        case "<=": expr = bothUnboxed ? `(${l} <= ${r})` : `ts_relational(${cxVal(cx, lhs)}, ${cxVal(cx, rhs)}, 1)`; break;
        case ">": expr = bothUnboxed ? `(${l} > ${r})` : `ts_relational(${cxVal(cx, lhs)}, ${cxVal(cx, rhs)}, 2)`; break;
        case ">=": expr = bothUnboxed ? `(${l} >= ${r})` : `ts_relational(${cxVal(cx, lhs)}, ${cxVal(cx, rhs)}, 3)`; break;
        case "===": expr = bothUnboxed ? `(${l} == ${r})` : `ts_strict_eq(${cxVal(cx, lhs)}, ${cxVal(cx, rhs)})`; break;
        case "==": expr = bothUnboxed ? `(${l} == ${r})` : `ts_loose_eq(${cxVal(cx, lhs)}, ${cxVal(cx, rhs)})`; break;
        case "!==": expr = bothUnboxed ? `(${l} != ${r})` : `(!ts_strict_eq(${cxVal(cx, lhs)}, ${cxVal(cx, rhs)}))`; break;
        case "!=": expr = bothUnboxed ? `(${l} != ${r})` : `(!ts_loose_eq(${cxVal(cx, lhs)}, ${cxVal(cx, rhs)}))`; break;
        case "&": expr = `((double)((int32_t)ts_to_int32(${l}) & (int32_t)ts_to_int32(${r})))`; break;
        case "|": expr = `((double)((int32_t)ts_to_int32(${l}) | (int32_t)ts_to_int32(${r})))`; break;
        case "^": expr = `((double)((int32_t)ts_to_int32(${l}) ^ (int32_t)ts_to_int32(${r})))`; break;
        case "<<": expr = `((double)((int32_t)(ts_to_int32(${l}) << (ts_to_uint32(${r}) & 31))))`; break;
        case ">>": expr = `((double)((int32_t)ts_to_int32(${l}) >> (ts_to_uint32(${r}) & 31)))`; break;
        case ">>>": expr = `((double)((uint32_t)ts_to_int32(${l}) >> (ts_to_uint32(${r}) & 31)))`; break;
        case "**": expr = `pow(${l}, ${r})`; break;
        default: expr = "0";
      }
      if (CMP_OPS.has(op) && !cx.unboxed.has(dst)) {
        s.push(`  v${dst} = ts_bool(${expr});\n`);
      } else {
        s.push(cxSetNum(cx, dst, expr));
      }
      return;
    }
    case "UnOp": {
      const { dst, op, operand } = inst;
      if (op === "typeof") s.push(cxSetVal(cx, dst, `ts_typeof(${cxVal(cx, operand)})`));
      else if (op === "nullish") s.push(cxSetNum(cx, dst, `ts_is_nullish_fast(${cxVal(cx, operand)})`));
      else if (op === "isundef") s.push(cxSetNum(cx, dst, `ts_is_undefined_fast(${cxVal(cx, operand)})`));
      else if (op === "!") {
        const expr = `(!${cxTruthy(cx, operand)})`;
        if (cx.unboxed.has(dst)) s.push(cxSetNum(cx, dst, expr));
        else s.push(`  v${dst} = ts_bool(${expr});\n`);
      } else if (op === "-") {
        s.push(cxSetNum(cx, dst, `(-${cxNumcDouble(cx, operand)})`));
      } else if (op === "~") {
        s.push(cxSetNum(cx, dst, `((double)(~ts_to_int32(${cxNumc(cx, operand)})))`));
      } else {
        s.push(cxSetNum(cx, dst, "0"));
      }
      return;
    }
    case "Print":
      s.push(`  ts_print(${cxVal(cx, inst.src)});\n`);
      return;
    case "Loop": {
      // (fused string-optimization loops and modulo residues not yet ported —
      // fixtures hitting them byte-diff and become the next porting front.)
      const top = cx.labelCtr.n++;
      const end = cx.labelCtr.n++;
      {
        const cond: number = inst.cond;
        const condBody: any[] = inst.condBody ?? [];
        const lbody: any[] = inst.body ?? [];
        if (tryEmitFusedDynamicReplaceEscapeSelectLoop(s, cond, condBody, lbody, cx, numericFacts, top)) return;
        if (tryEmitFusedPolymorphicPatternSearchLoop(s, cond, condBody, lbody, cx, numericFacts, top, end)) return;
        if (tryEmitFusedPolymorphicPatternReplaceLoop(s, cond, condBody, lbody, cx, numericFacts, top)) return;
        if (tryEmitFusedPolymorphicPatternSplitJoinLoop(s, cond, condBody, lbody, cx, numericFacts, top)) return;
        if (tryEmitFusedSplitJoinEscapeLoop(s, cond, condBody, lbody, cx, numericFacts, top)) return;
        if (tryEmitFusedConcatChainMetricLoop(s, cond, condBody, lbody, cx, numericFacts)) return;
      }
      cx.loopLabels.push([top, end]);
      s.push(`  L${top}: ;\n`);
      s.push("  for (;;) {\n");
      for (const i of inst.condBody ?? []) emitInstC(s, i, cx, numericFacts);
      s.push(`    if (!${cxTruthy(cx, inst.cond)}) break;\n`);
      // Rust's try_emit_string_metric_loop_body scratch-emits the whole body
      // (then discards it when no metric plan applies), advancing the label
      // counter for nested loops. Replicate that side effect for byte parity.
      const scratch: string[] = [];
      for (const i of inst.body ?? []) emitInstC(scratch, i, cx, numericFacts);
      for (const i of inst.body ?? []) emitInstC(s, i, cx, numericFacts);
      // Free per iteration when this loop's JSON DOM use is self-contained.
      if (cx.jsonRoots.size > 0 && loopBodyFreesJsonDom(inst.body ?? [], cx.jsonLocals, cx.domRefTotal)) {
        s.push("  ts_json_dom_scope_free(&_json_dom_scope);\n");
      }
      s.push(`  goto L${top};\n`);
      s.push("  }\n");
      s.push(`  L${end}: ;\n`);
      cx.loopLabels.pop();
      return;
    }
    case "If":
      s.push(`  if (${cxTruthy(cx, inst.cond)}) {\n`);
      for (const i of inst.thenBody ?? []) emitInstC(s, i, cx, numericFacts);
      s.push("  } else {\n");
      for (const i of inst.elseBody ?? []) emitInstC(s, i, cx, numericFacts);
      s.push("  }\n");
      return;
    case "Break":
      if (!inst.up) s.push("  break;\n");
      else {
        const t = cx.loopLabels[cx.loopLabels.length - 1 - inst.up];
        s.push(`  goto L${t[1]};\n`);
      }
      return;
    case "Continue":
      if (!inst.up) s.push("  continue;\n");
      else {
        const t = cx.loopLabels[cx.loopLabels.length - 1 - inst.up];
        s.push(`  goto L${t[0]};\n`);
      }
      return;
    case "TryCatch": {
      const finallyBody: any[] = inst.finallyBody ?? [];
      if (finallyBody.length > 0 && (bodyExitsAbruptly(inst.tryBody ?? []) || bodyExitsAbruptly(inst.catchBody ?? []))) {
        const outer = cx.loopLabels.length > 0 ? cx.loopLabels[cx.loopLabels.length - 1] : undefined;
        emitPlainFinally(s, inst, cx, numericFacts, outer);
        return;
      }
      s.push("  {\n");
      s.push("    ts_handler* _h = ts_eh_push();\n");
      s.push("    if (setjmp(_h->buf) == 0) {\n");
      for (const i of inst.tryBody ?? []) emitInstC(s, i, cx, numericFacts);
      s.push("      ts_eh_pop();\n");
      for (const i of finallyBody) emitInstC(s, i, cx, numericFacts);
      s.push("    } else {\n");
      s.push("      ts_gc_set_root_depth(_h->gc_root_len);\n");
      s.push("      ts_eh_pop();\n");
      if (inst.catchVar !== undefined && inst.catchVar !== null) {
        s.push(cxSetVal(cx, inst.catchVar, "ts_current_exception()"));
      }
      for (const i of inst.catchBody ?? []) emitInstC(s, i, cx, numericFacts);
      for (const i of finallyBody) emitInstC(s, i, cx, numericFacts);
      s.push("    }\n");
      s.push("  }\n");
      return;
    }
    case "Throw":
      s.push(`  ts_throw(${cxVal(cx, inst.src)});\n`);
      return;
    case "NewMap":
      s.push(cxSetVal(cx, inst.dst, "ts_new_map()"));
      return;
    case "NewSet":
      s.push(cxSetVal(cx, inst.dst, "ts_new_set()"));
      return;
    case "GetProto":
      s.push(cxSetVal(cx, inst.dst, `ts_get_proto(${cxVal(cx, inst.obj)})`));
      return;
    case "SetProto": {
      const call = `ts_set_proto(${cxVal(cx, inst.obj)}, ${cxVal(cx, inst.proto)})`;
      if (inst.dst !== undefined && inst.dst !== null) s.push(cxSetVal(cx, inst.dst, call));
      else s.push(`  ${call};\n`);
      return;
    }
    case "StoreMethod":
      s.push(`  ts_set(${cxVal(cx, inst.obj)}, ${methodKeyStr(inst.method, cx.wksym)}, ${cxVal(cx, inst.src)});\n`);
      return;
    case "ArrayPush":
      s.push(`  ts_array_push(v${inst.arr}, ${cxVal(cx, inst.src)});\n`);
      return;
    case "ArrayPushAll":
      s.push(`  ts_array_push_all(v${inst.arr}, ${cxVal(cx, inst.src)});\n`);
      return;
    case "StringLen": {
      if (cx.jsonLocals.has(inst.src)) {
        s.push(cxSetNum(cx, inst.dst, `ts_json_dom_length(${cxJval(cx, inst.src)})`));
        return;
      }
      const spec = cx.scalarSlices.get(inst.src);
      if (spec !== undefined) {
        const expr = spec.exactLen !== undefined ? `(ss_fast${spec.root} ? ${spec.exactLen} : ss_len${spec.root})` : `ss_len${spec.root}`;
        s.push(cxSetNum(cx, inst.dst, expr));
        return;
      }
      s.push(cxSetNum(cx, inst.dst, `ts_str_len_typed(${cxVal(cx, inst.src)})`));
      return;
    }
    case "GenericLen":
      if (cx.jsonLocals.has(inst.src)) {
        s.push(cxSetNum(cx, inst.dst, `ts_json_dom_length(${cxJval(cx, inst.src)})`));
        return;
      }
      s.push(cxSetNum(cx, inst.dst, `ts_length(${cxVal(cx, inst.src)})`));
      return;
    case "LoadElem":
      s.push(cxSetVal(cx, inst.dst, `ts_get(v${inst.arr}, 0)`));
      return;
    case "StoreElem":
      s.push(`  ts_set(v${inst.arr}, 0, ${cxVal(cx, inst.src)});\n`);
      return;
    case "LoadFieldDynamic":
      if (cx.jsonLocals.has(inst.obj)) {
        if (cx.jsonLocals.has(inst.dst)) {
          s.push(`  j${inst.dst} = ts_json_dom_get_dyn(${cxJval(cx, inst.obj)}, ${cxVal(cx, inst.key)});\n`);
        } else {
          s.push(cxSetVal(cx, inst.dst, `ts_json_dom_to_tsv(ts_json_dom_get_dyn(${cxJval(cx, inst.obj)}, ${cxVal(cx, inst.key)}))`));
        }
        return;
      }
      s.push(cxSetVal(cx, inst.dst, `ts_get_dyn_checked(${cxVal(cx, inst.obj)}, ${cxVal(cx, inst.key)})`));
      return;
    case "StoreFieldDynamic":
      s.push(`  ts_set_dyn(${cxVal(cx, inst.obj)}, ${cxVal(cx, inst.key)}, ${cxVal(cx, inst.src)});\n`);
      return;
    case "HasField":
      s.push(cxSetVal(cx, inst.dst, `ts_bool(ts_has_prop(${cxVal(cx, inst.obj)}, ${inst.field}))`));
      return;
    case "HasFieldDynamic":
      s.push(cxSetVal(cx, inst.dst, `ts_bool(ts_has_prop_dyn(${cxVal(cx, inst.obj)}, ${cxVal(cx, inst.key)}))`));
      return;
    case "DeleteField":
      if (inst.dst !== undefined && inst.dst !== null) {
        s.push(cxSetVal(cx, inst.dst, `ts_bool(ts_delete_prop_strict(${cxVal(cx, inst.obj)}, ${inst.field}))`));
      } else {
        s.push(`  ts_delete_prop_strict(${cxVal(cx, inst.obj)}, ${inst.field});\n`);
      }
      return;
    case "ArraySlice":
      s.push(cxSetVal(cx, inst.dst, `ts_array_slice(${cxVal(cx, inst.arr)}, ${cxNum(cx, inst.start)}, 0, 0)`));
      return;
    case "ObjectRest": {
      const exclude: number[] = inst.exclude ?? [];
      if (exclude.length === 0) {
        s.push(cxSetVal(cx, inst.dst, `ts_object_rest(${cxVal(cx, inst.src)}, 0, 0)`));
      } else {
        s.push(`  { static const uint32_t _excl[] = {${exclude.map((f) => `${f}u`).join(", ")}};\n`);
        s.push(`  ${cxSetVal(cx, inst.dst, `ts_object_rest(${cxVal(cx, inst.src)}, _excl, ${exclude.length})`)}`);
        s.push("  }\n");
      }
      return;
    }
    case "ObjectCopyProps":
      s.push(`  ts_object_copy_props(v${inst.dst}, ${cxVal(cx, inst.src)});\n`);
      return;
    case "LoadField": {
      if (cx.jsonLocals.has(inst.obj)) {
        if (cx.jsonLocals.has(inst.dst)) {
          s.push(`  j${inst.dst} = ts_json_dom_get(${cxJval(cx, inst.obj)}, ${inst.field}u);\n`);
        } else {
          s.push(cxSetVal(cx, inst.dst, `ts_json_dom_to_tsv(ts_json_dom_get(${cxJval(cx, inst.obj)}, ${inst.field}u))`));
        }
        return;
      }
      const c = cx.localClass.get(inst.obj);
      if (c !== undefined) {
        const off = structDirectOffset(c, inst.field, cx.classes);
        if (off !== undefined) {
          const cn = structName(c);
          const st2 = `(((${cn}*)ts_ptr(v${inst.obj}))->${off})`;
          if (numericFieldOf(c, inst.field, cx.classes)) {
            const e = `((g_has_proxies && ts_is_proxy(v${inst.obj})) ? ts_to_num(ts_get(v${inst.obj}, ${inst.field})) : ${st2})`;
            s.push(cxSetNum(cx, inst.dst, e));
          } else {
            const e = `((g_has_proxies && ts_is_proxy(v${inst.obj})) ? ts_get(v${inst.obj}, ${inst.field}) : ${st2})`;
            s.push(cxSetVal(cx, inst.dst, e));
          }
          return;
        }
      }
      s.push(cxSetVal(cx, inst.dst, `ts_get_checked(${cxVal(cx, inst.obj)}, ${inst.field})`));
      return;
    }
    case "LoadMethodValue":
      s.push(cxSetVal(cx, inst.dst, `ts_get(${cxVal(cx, inst.recv)}, TS_KEY_METHOD(${inst.method}u))`));
      return;
    case "LoadBuiltinFn": {
      const b: string = inst.builtin;
      if (b === "globalThis") {
        s.push(cxSetVal(cx, inst.dst, "ts_global_this()"));
        return;
      }
      if (b.startsWith("globalobj.")) {
        s.push(cxSetVal(cx, inst.dst, `ts_global_get(${JSON.stringify(b.slice("globalobj.".length))})`));
        return;
      }
      if (b.startsWith("protoobj.")) {
        const acc: Record<string, string> = {
          object: "ts_object_proto", array: "ts_array_proto", string: "ts_string_proto",
          map: "ts_map_proto", set: "ts_set_proto_obj", headers: "ts_headers_proto",
          number: "ts_number_proto", boolean: "ts_boolean_proto", function: "ts_function_proto",
        };
        const fn = acc[b.slice("protoobj.".length)];
        if (fn === undefined) unported(`LoadBuiltinFn '${b}'`);
        s.push(cxSetVal(cx, inst.dst, `${fn}()`));
        return;
      }
      if (b.startsWith("errorproto.")) {
        s.push(cxSetVal(cx, inst.dst, `ts_error_proto(${parseInt(b.slice("errorproto.".length), 10) || 0})`));
        return;
      }
      // First-class static builtin function value: box the generated adapter
      // (emitted in the prelude). objproto.* read args[0] as `this` (takes_this=1).
      const tt = b.startsWith("objproto.") ? 1 : 0;
      s.push(cxSetVal(cx, inst.dst, `ts_make_fn_t(${fnvalAdapterName(b)}, 0, 0, ${tt})`));
      return;
    }
    case "Call": {
      const argv: number[] = [];
      if (inst.recv !== undefined && inst.recv !== null) argv.push(inst.recv);
      for (const a of inst.args ?? []) argv.push(a);
      if ((inst.callee ?? {}).kind === "Direct") {
        const func: number = inst.callee.func;
        const i64Info = cx.i64Fast.get(func);
        if (
          i64Info !== undefined &&
          argv.length === i64Info.params.length &&
          argv.every((a) => cx.intLocal.has(a) && cx.numericValueLocal.has(a))
        ) {
          const call = `${cx.fnNames.get(func) ?? `fn_${func}`}_i64(${argv.map((a) => `d${a}`).join(", ")})`;
          const d = inst.dst;
          if (d !== undefined && d !== null) {
            if (cx.intLocal.has(d)) s.push(`  d${d} = ${call};\n`);
            else if (cx.unboxed.has(d)) s.push(`  d${d} = (double)(${call});\n`);
            else s.push(`  v${d} = ts_num((double)(${call}));\n`);
          } else {
            s.push(`  ${call};\n`);
          }
          return;
        }
        const f64Info = cx.f64Fast.get(func);
        const dstCanTakeDouble = inst.dst === undefined || inst.dst === null || !cx.intLocal.has(inst.dst);
        if (
          f64Info !== undefined &&
          dstCanTakeDouble &&
          argv.length === f64Info.params.length &&
          argv.every((a) => cx.unboxed.has(a) && cx.numericValueLocal.has(a))
        ) {
          const call = `${cx.fnNames.get(func) ?? `fn_${func}`}_f64(${argv
            .map((a) => (cx.intLocal.has(a) ? `((double)d${a})` : `d${a}`))
            .join(", ")})`;
          const d = inst.dst;
          if (d !== undefined && d !== null) {
            if (cx.unboxed.has(d)) s.push(`  d${d} = ${call};\n`);
            else s.push(`  v${d} = ts_num(${call});\n`);
          } else {
            s.push(`  ${call};\n`);
          }
          return;
        }
      }
      s.push(`  { tsv _a[${Math.max(argv.length, 1)}];\n`);
      argv.forEach((a, i) => s.push(`    _a[${i}] = ${cxVal(cx, a)};\n`));
      const c = inst.callee;
      let call: string;
      if (c.kind === "Direct") call = `${cx.fnNames.get(c.func) ?? `fn_${c.func}`}(_a, ${argv.length})`;
      else if (c.kind === "Set") call = `${cx.fnNames.get((c.funcs ?? [0])[0]) ?? "fn_0"}(_a, ${argv.length})`;
      else if (c.kind === "Value") {
        call = inst.recv !== undefined && inst.recv !== null
          ? `ts_call_method(${cxVal(cx, c.local)}, _a, ${argv.length})`
          : `ts_call_value(${cxVal(cx, c.local)}, _a, ${argv.length})`;
      } else if (c.kind === "Method") {
        // Dynamic method dispatch: resolve through the runtime prototype chain
        // (own field-key first, then method-key), then invoke via ts_call_method.
        const mf = c.methodField !== undefined && c.methodField !== null ? c.methodField : undefined;
        emitMethodValueLookup(s, "_a[0]", c.method, mf, cx.wksym);
        call = `ts_call_method(_mv, _a, ${argv.length})`;
      } else {
        call = "ts_dynamic_method_unsupported()";
      }
      if (inst.dst !== undefined && inst.dst !== null) s.push(cxSetVal(cx, inst.dst, call));
      else s.push(`    ${call};\n`);
      s.push("  }\n");
      return;
    }
    case "CallSpread": {
      // Build a dynamic argument buffer: singles contribute 1, spreads
      // contribute their array length. recv (if any) is arg 0.
      const specs: { kind: string; local: number }[] = inst.argSpecs ?? [];
      const hasRecv = inst.recv !== undefined && inst.recv !== null;
      s.push("  {\n");
      s.push(`    int _n = ${hasRecv ? 1 : 0};\n`);
      for (const sp of specs) {
        if (sp.kind === "spread") s.push(`    _n += (int)ts_array_len_fast(${cxVal(cx, sp.local)});\n`);
        else s.push("    _n += 1;\n");
      }
      s.push("    tsv* _a = (tsv*)malloc(sizeof(tsv) * (_n > 0 ? _n : 1));\n");
      s.push("    int _k = 0;\n");
      if (hasRecv) s.push(`    _a[_k++] = ${cxVal(cx, inst.recv)};\n`);
      for (const sp of specs) {
        if (sp.kind === "spread") {
          const v = cxVal(cx, sp.local);
          s.push(`    { int _m = (int)ts_array_len_fast(${v}); for (int _j=0;_j<_m;_j++) _a[_k++] = ts_array_get(${v}, _j); }\n`);
        } else {
          s.push(`    _a[_k++] = ${cxVal(cx, sp.local)};\n`);
        }
      }
      const c = inst.callee ?? {};
      let call: string;
      if (c.kind === "Direct") call = `${cx.fnNames.get(c.func) ?? `fn_${c.func}`}(_a, _n)`;
      else if (c.kind === "Set") call = `${cx.fnNames.get((c.funcs ?? [0])[0]) ?? "fn_0"}(_a, _n)`;
      else if (c.kind === "Method") {
        const mf = c.methodField !== undefined && c.methodField !== null ? c.methodField : undefined;
        emitMethodValueLookup(s, "_a[0]", c.method, mf, cx.wksym);
        call = "ts_call_method(_mv, _a, _n)";
      } else if (c.kind === "Value") {
        call = hasRecv ? `ts_call_method(${cxVal(cx, c.local)}, _a, _n)` : `ts_call_value(${cxVal(cx, c.local)}, _a, _n)`;
      } else {
        call = "ts_dynamic_method_unsupported()";
      }
      if (inst.dst !== undefined && inst.dst !== null) {
        s.push(`    tsv _r = ${call};\n`);
        s.push("    free(_a);\n");
        s.push(cxSetVal(cx, inst.dst, "_r"));
      } else {
        s.push(`    ${call};\n`);
        s.push("    free(_a);\n");
      }
      s.push("  }\n");
      return;
    }
    case "Return": {
      if (cx.nroot > 0) s.push(`  ts_gc_unroot(${cx.nroot});\n`);
      if (cx.i64Mode) {
        const v = inst.src;
        if (v !== undefined && v !== null) {
          if (cx.intLocal.has(v)) s.push(`  return d${v};\n`);
          else if (cx.unboxed.has(v)) s.push(`  return (long long)d${v};\n`);
          else s.push(`  return (long long)ts_to_num(v${v});\n`);
        } else {
          s.push("  return 0;\n");
        }
      } else if (cx.f64Mode) {
        const v = inst.src;
        if (v !== undefined && v !== null) {
          if (cx.intLocal.has(v)) s.push(`  return (double)d${v};\n`);
          else if (cx.unboxed.has(v)) s.push(`  return d${v};\n`);
          else s.push(`  return ts_to_num(v${v});\n`);
        } else {
          s.push("  return 0.0;\n");
        }
      } else if (inst.src !== undefined && inst.src !== null) {
        const rv = cxVal(cx, inst.src);
        if (cx.jsonRoots.size === 0) {
          s.push(`  return ${rv};\n`);
        } else {
          s.push(`  tsv _ret = ${rv};\n`);
          s.push("  ts_json_dom_scope_free(&_json_dom_scope);\n");
          s.push("  return _ret;\n");
        }
      } else {
        if (cx.jsonRoots.size > 0) s.push("  ts_json_dom_scope_free(&_json_dom_scope);\n");
        s.push("  return TS_UNDEFINED;\n");
      }
      return;
    }
    case "CallBuiltinStatic": {
      const { dst, builtin } = inst;
      const args: number[] = inst.args ?? [];
      if (builtin === "string.concatMany") {
        const tmp = `_scm${dst ?? 0}`;
        s.push(`  { tsv _scm_args[${Math.max(args.length, 1)}];\n`);
        args.forEach((a, i) => s.push(`    _scm_args[${i}] = ${cxVal(cx, a)};\n`));
        s.push(`    tsv ${tmp} = ts_str_concat_many(_scm_args, ${args.length});\n`);
        if (dst !== undefined && dst !== null) {
          s.push(`  ${cxSetVal(cx, dst, tmp).trimEnd()} }\n`);
        } else {
          s.push("  }\n");
        }
        return;
      }
      if (builtin.startsWith("error.new:")) {
        const idx = parseInt(builtin.slice("error.new:".length), 10) || 0;
        const msg = args.length === 0 ? "TS_UNDEFINED" : cxVal(cx, args[0]);
        const expr = `ts_new_error(${idx}, ${msg})`;
        if (dst !== undefined && dst !== null) s.push(cxSetVal(cx, dst, expr));
        else s.push(`  ${expr};\n`);
        return;
      }
      if (builtin === "json.dom.parse") {
        if (dst !== undefined && dst !== null) {
          const srcArg = args.length > 0 ? cxVal(cx, args[0]) : "TS_UNDEFINED";
          if (cx.jsonLocals.has(dst)) {
            s.push(`  j${dst} = ts_json_dom_parse(${srcArg});\n`);
            if (cx.jsonRoots.has(dst)) s.push(`  ts_json_dom_scope_track(&_json_dom_scope, j${dst});\n`);
          } else {
            s.push(cxSetVal(cx, dst, `ts_json_parse(${srcArg})`));
          }
        }
        return;
      }
      if (builtin.startsWith("json.dom.get:")) {
        const fieldId = parseInt(builtin.slice("json.dom.get:".length), 10) || 0;
        if (dst !== undefined && dst !== null) {
          const base = args.length > 0 ? cxJval(cx, args[0]) : "NULL";
          s.push(`  j${dst} = ts_json_dom_get(${base}, ${fieldId}u);\n`);
        }
        return;
      }
      if (builtin === "json.dom.index") {
        if (dst !== undefined && dst !== null) {
          const base = args.length > 0 ? cxJval(cx, args[0]) : "NULL";
          const idx = args.length > 1 ? cxNumc(cx, args[1]) : "0";
          s.push(`  j${dst} = ts_json_dom_index(${base}, ${idx});\n`);
        }
        return;
      }
      if (builtin === "json.dom.length") {
        if (dst !== undefined && dst !== null) {
          const base = args.length > 0 ? cxJval(cx, args[0]) : "NULL";
          s.push(cxSetNum(cx, dst, `ts_json_dom_length(${base})`));
        }
        return;
      }
      if (builtin === "json.dom.number") {
        if (dst !== undefined && dst !== null) {
          const base = args.length > 0 ? cxJval(cx, args[0]) : "NULL";
          s.push(cxSetNum(cx, dst, `ts_json_dom_number(${base})`));
        }
        return;
      }
      if (builtin === "json.dom.toValue") {
        if (dst !== undefined && dst !== null) {
          const base = args.length > 0 ? cxJval(cx, args[0]) : "NULL";
          s.push(cxSetVal(cx, dst, `ts_json_dom_to_tsv(${base})`));
        }
        return;
      }
      if (builtin === "json.dom.stringify") {
        if (dst !== undefined && dst !== null) {
          const base = args.length > 0 ? cxJval(cx, args[0]) : "NULL";
          s.push(cxSetVal(cx, dst, `ts_json_dom_stringify(${base})`));
        }
        return;
      }
      if (builtin === "json.dom.stringify.len") {
        if (dst !== undefined && dst !== null) {
          const base = args.length > 0 ? cxJval(cx, args[0]) : "NULL";
          s.push(cxSetNum(cx, dst, `ts_json_dom_stringify_len(${base})`));
        }
        return;
      }
      if (builtin === "json.stringify" && args.length > 0 && cx.jsonLocals.has(args[0])) {
        if (dst !== undefined && dst !== null) {
          s.push(cxSetVal(cx, dst, `ts_json_dom_stringify(${cxJval(cx, args[0])})`));
        }
        return;
      }
      if (builtin === "json.stringify.len" && args.length > 0 && cx.jsonLocals.has(args[0])) {
        if (dst !== undefined && dst !== null) {
          s.push(cxSetNum(cx, dst, `ts_json_dom_stringify_len(${cxJval(cx, args[0])})`));
        }
        return;
      }
      if (builtin === "object.assign") {
        s.push(`  { tsv _oa[${Math.max(args.length, 1)}];\n`);
        args.forEach((a, i) => s.push(`    _oa[${i}] = ${cxVal(cx, a)};\n`));
        const tmp = `_oar${dst ?? 0}`;
        s.push(`    tsv ${tmp} = ts_object_assign(_oa, ${args.length}); \n`);
        if (dst !== undefined && dst !== null) {
          s.push(`  ${cxSetVal(cx, dst, tmp).trimEnd()} }\n`);
        } else {
          s.push("  }\n");
        }
        return;
      }
      if (builtin === "string.fromCharCode" || builtin === "string.fromCodePoint" || builtin === "array.of") {
        const fname =
          builtin === "string.fromCharCode"
            ? "ts_string_from_char_code"
            : builtin === "string.fromCodePoint"
              ? "ts_string_from_code_point"
              : "ts_array_of";
        const tmp = `_va${dst ?? 0}`;
        s.push(`  { tsv _va[${Math.max(args.length, 1)}];\n`);
        args.forEach((a, i) => s.push(`    _va[${i}] = ${cxVal(cx, a)};\n`));
        s.push(`    tsv ${tmp} = ${fname}(_va, ${args.length});\n`);
        if (dst !== undefined && dst !== null) {
          s.push(`  ${cxSetVal(cx, dst, tmp).trimEnd()} }\n`);
        } else {
          s.push("  }\n");
        }
        return;
      }
      if (builtin === "object.definePropertyDyn") {
        const a = (i: number) => cxVal(cx, args[i] ?? 0);
        s.push(`  ts_define_property(${a(0)}, ${a(1)}, ${a(2)});\n`);
        if (dst !== undefined && dst !== null) s.push(cxSetVal(cx, dst, "TS_UNDEFINED"));
        return;
      }
      if (builtin === "object.definePropertiesDyn") {
        const a = (i: number) => cxVal(cx, args[i] ?? 0);
        s.push(`  ts_define_properties(${a(0)}, ${a(1)});\n`);
        if (dst !== undefined && dst !== null) s.push(cxSetVal(cx, dst, "TS_UNDEFINED"));
        return;
      }
      if (builtin === "symbol.set") {
        // obj[sym] = v : symbol-keyed write (no stringify).
        const a = (i: number) => cxVal(cx, args[i] ?? 0);
        s.push(`  ts_set_symkey(${a(0)}, ${a(1)}, ${a(2)});\n`);
        if (dst !== undefined && dst !== null) s.push(cxSetVal(cx, dst, "TS_UNDEFINED"));
        return;
      }
      if (builtin.startsWith("symbol.wksym:")) {
        // Symbol.iterator etc. as a value -> well-known symbol singleton.
        const id = parseInt(builtin.slice("symbol.wksym:".length), 10) || 0;
        if (dst !== undefined && dst !== null) s.push(cxSetVal(cx, dst, `ts_wksym(${id}u)`));
        return;
      }
      if (builtin.startsWith("object.methodValue:")) {
        // o.toString / o.valueOf / o.hasOwnProperty as a VALUE: an own data
        // property (any type) shadows; else the inherited Object.prototype
        // method (registered under a METHOD key).
        const parts = builtin.slice("object.methodValue:".length).split(":");
        const fieldId = parseInt(parts[0] ?? "0", 10) || 0;
        const methodId = parseInt(parts[1] ?? "0", 10) || 0;
        const a = (i: number) => cxVal(cx, args[i] ?? 0);
        if (dst !== undefined && dst !== null) {
          s.push(cxSetVal(cx, dst, `ts_get_method_value(${a(0)}, ${fieldId}u, TS_KEY_METHOD(${methodId}u))`));
        }
        return;
      }
      if (builtin.startsWith("object.defineData")) {
        const parts = builtin.split(":");
        const e = parts[1] ?? "1";
        const w = parts[2] ?? "1";
        const c2 = parts[3] ?? "1";
        const a = (i: number) => cxVal(cx, args[i] ?? 0);
        s.push(`  ts_define_data_dyn(${a(0)}, ${a(1)}, ${a(2)}, ${e}, ${w}, ${c2});\n`);
        if (dst !== undefined && dst !== null) s.push(cxSetVal(cx, dst, "TS_UNDEFINED"));
        return;
      }
      // Object.defineProperty accessor form: define get/set on obj.
      // builtin is "object.defineAccessor:<gThis>:<sThis>:<enum>:<conf>".
      if (builtin.startsWith("object.defineAccessor")) {
        const parts = builtin.split(":");
        const gThis = parts[1] ?? "0";
        const sThis = parts[2] ?? "0";
        const e = parts[3] ?? "0";
        const c2 = parts[4] ?? "0";
        const a = (i: number) => cxVal(cx, args[i] ?? 0);
        s.push(`  ts_define_accessor_dyn(${a(0)}, ${a(1)}, ${a(2)}, ${a(3)}, ${gThis}, ${sThis}, ${e}, ${c2});\n`);
        if (dst !== undefined && dst !== null) s.push(cxSetVal(cx, dst, "TS_UNDEFINED"));
        return;
      }
      // Symbol-keyed accessor define: the key (arg 1) is a symbol value
      // installed without stringify.
      if (builtin.startsWith("symbol.defineAccessor")) {
        const parts = builtin.split(":");
        const gThis = parts[1] ?? "0";
        const sThis = parts[2] ?? "0";
        const e = parts[3] ?? "0";
        const c2 = parts[4] ?? "0";
        const a = (i: number) => cxVal(cx, args[i] ?? 0);
        s.push(`  ts_define_accessor_symkey(${a(0)}, ${a(1)}, ${a(2)}, ${a(3)}, ${gThis}, ${sThis}, ${e}, ${c2});\n`);
        if (dst !== undefined && dst !== null) s.push(cxSetVal(cx, dst, "TS_UNDEFINED"));
        return;
      }
      // console.dir(v): structural inspection of a single value.
      if (builtin === "console.dir") {
        s.push(`  ts_console_dir(${cxVal(cx, args[0] ?? 0)});\n`);
        if (dst !== undefined && dst !== null) s.push(cxSetVal(cx, dst, "TS_UNDEFINED"));
        return;
      }
      if (builtin === "console.log" || builtin === "console.error") {
        const fname = builtin === "console.log" ? "ts_console_log" : "ts_console_err";
        s.push(`  { tsv _pa[${Math.max(args.length, 1)}];\n`);
        args.forEach((a, i) => s.push(`    _pa[${i}] = ${cxVal(cx, a)};\n`));
        s.push(`    ${fname}(_pa, ${args.length}); }\n`);
        if (dst !== undefined && dst !== null) s.push(cxSetVal(cx, dst, "TS_UNDEFINED"));
        return;
      }
      const n = (i: number) => (i < args.length ? cxNum(cx, args[i]) : "0");
      const nc = (i: number) => (i < args.length ? cxNumc(cx, args[i]) : "0.0/0.0");
      const v = (i: number) => (i < args.length ? cxVal(cx, args[i]) : "TS_UNDEFINED");
      let expr: string;
      let numeric: boolean;
      switch (builtin) {
        // Math: single-arg libm functions emitted inline as doubles.
        case "math.sqrt": expr = `sqrt(${n(0)})`; numeric = true; break;
        case "math.abs": expr = `fabs(${n(0)})`; numeric = true; break;
        case "math.floor": expr = `floor(${n(0)})`; numeric = true; break;
        case "math.ceil": expr = `ceil(${n(0)})`; numeric = true; break;
        case "math.round": expr = `ts_math_round(${n(0)})`; numeric = true; break;
        case "math.trunc": expr = `ts_math_trunc(${n(0)})`; numeric = true; break;
        case "math.sign": expr = `ts_math_sign(${n(0)})`; numeric = true; break;
        case "math.sin": expr = `sin(${n(0)})`; numeric = true; break;
        case "math.cos": expr = `cos(${n(0)})`; numeric = true; break;
        case "math.tan": expr = `tan(${n(0)})`; numeric = true; break;
        case "math.asin": expr = `asin(${n(0)})`; numeric = true; break;
        case "math.acos": expr = `acos(${n(0)})`; numeric = true; break;
        case "math.atan": expr = `atan(${n(0)})`; numeric = true; break;
        case "math.sinh": expr = `sinh(${n(0)})`; numeric = true; break;
        case "math.cosh": expr = `cosh(${n(0)})`; numeric = true; break;
        case "math.tanh": expr = `tanh(${n(0)})`; numeric = true; break;
        case "math.exp": expr = `exp(${n(0)})`; numeric = true; break;
        case "math.log": expr = `log(${n(0)})`; numeric = true; break;
        case "math.log2": expr = `ts_math_log2(${n(0)})`; numeric = true; break;
        case "math.log10": expr = `ts_math_log10(${n(0)})`; numeric = true; break;
        case "math.cbrt": expr = `ts_math_cbrt(${n(0)})`; numeric = true; break;
        case "math.asinh": expr = `asinh(${n(0)})`; numeric = true; break;
        case "math.acosh": expr = `acosh(${n(0)})`; numeric = true; break;
        case "math.atanh": expr = `atanh(${n(0)})`; numeric = true; break;
        case "math.expm1": expr = `expm1(${n(0)})`; numeric = true; break;
        case "math.log1p": expr = `log1p(${n(0)})`; numeric = true; break;
        case "math.fround": expr = `((double)(float)(${n(0)}))`; numeric = true; break;
        case "math.f16round": expr = `ts_math_f16round(${nc(0)})`; numeric = true; break;
        case "math.clz32": expr = `ts_math_clz32(${n(0)})`; numeric = true; break;
        // two-arg
        case "math.pow": expr = `pow(${n(0)}, ${n(1)})`; numeric = true; break;
        case "math.atan2": expr = `atan2(${n(0)}, ${n(1)})`; numeric = true; break;
        case "math.hypot": expr = `ts_math_hypot2(${n(0)}, ${n(1)})`; numeric = true; break;
        case "math.imul": expr = `ts_math_imul(${nc(0)}, ${nc(1)})`; numeric = true; break;
        case "math.maxArr": expr = `ts_math_max_arr(${v(0)})`; numeric = true; break;
        case "math.minArr": expr = `ts_math_min_arr(${v(0)})`; numeric = true; break;
        case "math.hypotArr": expr = `ts_math_hypot_arr(${v(0)})`; numeric = true; break;
        case "math.max": expr = `ts_math_max2(${n(0)}, ${n(1)})`; numeric = true; break;
        case "math.min": expr = `ts_math_min2(${n(0)}, ${n(1)})`; numeric = true; break;
        case "math.random": expr = "ts_math_random()"; numeric = true; break;
        // Number static methods
        case "number.isInteger": expr = `ts_bool(ts_number_is_integer(${v(0)}))`; numeric = false; break;
        case "number.isFinite": expr = `ts_bool(ts_number_is_finite(${v(0)}))`; numeric = false; break;
        case "number.isNaN": expr = `ts_bool(ts_number_is_nan(${v(0)}))`; numeric = false; break;
        case "number.isSafeInteger": expr = `ts_bool(ts_number_is_safe_integer(${v(0)}))`; numeric = false; break;
        case "number.parseFloat": expr = `ts_parse_float(${v(0)})`; numeric = true; break;
        case "number.parseInt": expr = `ts_parse_int(${v(0)}, ${args.length > 1 ? n(1) : "0"})`; numeric = true; break;
        case "number.coerce": expr = `ts_number_coerce(${v(0)})`; numeric = true; break;
        case "string.coerce": expr = `ts_to_string_v(${v(0)})`; numeric = false; break;
        case "boolean.coerce": expr = `ts_bool(ts_truthy_fast(${v(0)}))`; numeric = false; break;
        case "regexp.literalTest": expr = `ts_regexp_litprefix_test_fast(${v(0)}, ${v(1)}, 0)`; numeric = false; break;
        case "regexp.literalTestSticky": expr = `ts_regexp_litprefix_test_fast(${v(0)}, ${v(1)}, 1)`; numeric = false; break;
        case "regexp.literalSearch": expr = `ts_regexp_litprefix_search_fast(${v(0)}, ${v(1)}, 0)`; numeric = true; break;
        case "regexp.literalSearchSticky": expr = `ts_regexp_litprefix_search_fast(${v(0)}, ${v(1)}, 1)`; numeric = true; break;
        case "regexp.objectTest": expr = `ts_regexp_adapter_object_test_tsv(${v(0)}, ${v(1)})`; numeric = false; break;
        case "regexp.initObject": expr = `ts_regexp_object_init(${v(0)})`; numeric = false; break;
        case "regexp.validateObject": expr = `ts_regexp_adapter_validate_object_tsv(${v(0)})`; numeric = false; break;
        case "regexp.objectSearch": expr = `ts_regexp_adapter_object_search_tsv(${v(0)}, ${v(1)})`; numeric = true; break;
        case "regexp.objectExec": expr = `ts_regexp_adapter_object_exec_tsv(${v(0)}, ${v(1)})`; numeric = false; break;
        case "regexp.objectMatch": expr = `ts_regexp_adapter_object_match_tsv(${v(0)}, ${v(1)})`; numeric = false; break;
        case "regexp.objectMatchAll": expr = `ts_regexp_adapter_object_match_all_tsv(${v(0)}, ${v(1)})`; numeric = false; break;
        case "regexp.objectReplace": expr = `ts_regexp_adapter_object_replace_tsv(${v(0)}, ${v(1)}, ${v(2)}, (int)${n(3)})`; numeric = false; break;
        case "regexp.objectSplit": expr = `ts_regexp_adapter_object_split_tsv(${v(0)}, ${v(1)}, ${v(2)})`; numeric = false; break;
        case "regexp.quickTest": expr = `ts_regexp_adapter_test_tsv(${v(0)}, (uint32_t)${n(1)}, ${v(2)})`; numeric = false; break;
        case "regexp.quickSearch": expr = `ts_regexp_adapter_search_tsv(${v(0)}, ${v(1)}, (uint32_t)${n(2)})`; numeric = true; break;
        case "regexp.quickExec": expr = `ts_regexp_adapter_exec_tsv(${v(0)}, (uint32_t)${n(1)}, ${v(2)})`; numeric = false; break;
        case "regexp.quickMatch": expr = `ts_regexp_adapter_match_tsv(${v(0)}, ${v(1)}, (uint32_t)${n(2)})`; numeric = false; break;
        case "regexp.quickMatchAll": expr = `ts_regexp_adapter_match_all_tsv(${v(0)}, ${v(1)}, (uint32_t)${n(2)})`; numeric = false; break;
        case "regexp.quickReplace": expr = `ts_regexp_adapter_replace_tsv(${v(0)}, ${v(1)}, (uint32_t)${n(2)}, ${v(3)}, (int)${n(4)})`; numeric = false; break;
        case "regexp.quickSplit": expr = `ts_regexp_adapter_split_tsv(${v(0)}, ${v(1)}, (uint32_t)${n(2)}, ${v(3)})`; numeric = false; break;
        // global parse functions
        case "global.parseFloat": expr = `ts_parse_float(${v(0)})`; numeric = true; break;
        case "global.parseInt": expr = `ts_parse_int(${v(0)}, ${args.length > 1 ? n(1) : "0"})`; numeric = true; break;
        // global isNaN/isFinite ToNumber-coerce their argument (unlike the
        // Number.* versions): isNaN("abc") -> isNaN(NaN) -> true.
        case "global.isNaN": expr = `ts_bool(isnan(ts_number_coerce(${v(0)})))`; numeric = false; break;
        case "global.isFinite": expr = `ts_bool(isfinite(ts_number_coerce(${v(0)})))`; numeric = false; break;
        case "global.fetch": expr = `ts_fetch(${v(0)}, ${v(1)})`; numeric = false; break;
        case "global.readStdin": expr = "ts_read_stdin()"; numeric = false; break;
        case "abortcontroller.new": expr = "ts_abort_controller_new()"; numeric = false; break;
        case "abortsignal.timeout": expr = `ts_abort_signal_timeout(${v(0)})`; numeric = false; break;
        // Date static
        case "date.now": expr = "ts_to_num(ts_date_now_ms())"; numeric = true; break;
        case "date.fromComponents": expr = `ts_date_from_components(${n(0)}, ${n(1)}, ${n(2)}, ${n(3)}, ${n(4)}, ${n(5)}, ${n(6)})`; numeric = true; break;
        case "date.component": expr = `ts_date_component(${n(0)}, (int)${n(1)})`; numeric = true; break;
        case "date.toISOString": expr = `ts_date_to_iso(${n(0)})`; numeric = false; break;
        // Object static methods (use the field-name table)
        case "object.keys": expr = `ts_object_keys(${v(0)})`; numeric = false; break;
        case "object.protoToStringCall": expr = `ts_objproto_tostring_call(${v(0)})`; numeric = false; break;
        case "object.getOwnPropertyNames": expr = `ts_object_get_own_property_names(${v(0)})`; numeric = false; break;
        case "object.freeze": expr = `ts_object_freeze(${v(0)})`; numeric = false; break;
        case "object.isFrozen": expr = `ts_object_is_frozen(${v(0)})`; numeric = false; break;
        case "object.create": expr = `ts_object_create(${v(0)})`; numeric = false; break;
        case "object.seal": expr = `ts_object_seal(${v(0)})`; numeric = false; break;
        case "object.preventExtensions": expr = `ts_object_prevent_extensions(${v(0)})`; numeric = false; break;
        case "object.isSealed": expr = `ts_object_is_sealed(${v(0)})`; numeric = false; break;
        case "object.isExtensible": expr = `ts_object_is_extensible(${v(0)})`; numeric = false; break;
        case "object.values": expr = `ts_object_values(${v(0)})`; numeric = false; break;
        case "object.entries": expr = `ts_object_entries(${v(0)})`; numeric = false; break;
        case "object.getOwnPropertySymbols": expr = `ts_object_get_own_property_symbols(${v(0)})`; numeric = false; break;
        case "object.fromEntries": expr = `ts_object_from_entries(${v(0)})`; numeric = false; break;
        case "promise.resolve": expr = `ts_promise_resolved(${v(0)})`; numeric = false; break;
        case "promise.reject": expr = `ts_promise_rejected(${v(0)})`; numeric = false; break;
        case "promise.all": expr = `ts_promise_all(${v(0)})`; numeric = false; break;
        case "promise.race": expr = `ts_promise_race(${v(0)})`; numeric = false; break;
        case "promise.allSettled": expr = `ts_promise_allsettled(${v(0)})`; numeric = false; break;
        case "promise.any": expr = `ts_promise_any(${v(0)})`; numeric = false; break;
        case "promise.new": expr = `ts_promise_new_executor(${v(0)})`; numeric = false; break;
        case "object.hasOwn": expr = `ts_bool(ts_has_own_dyn(${v(0)}, ${v(1)}))`; numeric = false; break;
        case "object.is": expr = `ts_bool(ts_object_is(${v(0)}, ${v(1)}))`; numeric = false; break;
        case "headers.new": expr = `ts_headers_new(${args.length === 0 ? "TS_UNDEFINED" : v(0)})`; numeric = false; break;
        case "map.seed": expr = `ts_map_seed(${v(0)}, ${v(1)})`; numeric = false; break;
        case "set.seed": expr = `ts_set_seed(${v(0)}, ${v(1)})`; numeric = false; break;
        case "object.getOwnPropertyDescriptor": expr = `ts_get_own_property_descriptor(${v(0)}, ${v(1)})`; numeric = false; break;
        case "object.getOwnPropertyDescriptors": expr = `ts_get_own_property_descriptors(${v(0)})`; numeric = false; break;
        // Reflect.* — thin wrappers over the dynamic property / call /
        // construct runtime (Reflect.get(t,k[,recv]) ignores receiver in
        // v1, matching the common non-proxy / non-accessor case).
        case "reflect.get": expr = `ts_get_dyn(${v(0)}, ${v(1)})`; numeric = false; break;
        case "reflect.set": expr = `ts_reflect_set(${v(0)}, ${v(1)}, ${v(2)})`; numeric = false; break;
        case "reflect.has": expr = `ts_reflect_has(${v(0)}, ${v(1)})`; numeric = false; break;
        case "reflect.deleteProperty": expr = `ts_reflect_delete(${v(0)}, ${v(1)})`; numeric = false; break;
        case "reflect.ownKeys": expr = `ts_reflect_own_keys(${v(0)})`; numeric = false; break;
        case "reflect.getPrototypeOf": expr = `ts_get_proto(${v(0)})`; numeric = false; break;
        case "reflect.setPrototypeOf": expr = `ts_reflect_set_proto(${v(0)}, ${v(1)})`; numeric = false; break;
        case "reflect.defineProperty": expr = `ts_reflect_define_property(${v(0)}, ${v(1)}, ${v(2)})`; numeric = false; break;
        case "reflect.getOwnPropertyDescriptor": expr = `ts_get_own_property_descriptor(${v(0)}, ${v(1)})`; numeric = false; break;
        case "reflect.isExtensible": expr = `ts_object_is_extensible(${v(0)})`; numeric = false; break;
        case "reflect.preventExtensions": expr = `ts_reflect_prevent_extensions(${v(0)})`; numeric = false; break;
        case "reflect.apply": expr = `ts_reflect_apply(${v(0)}, ${v(1)}, ${v(2)})`; numeric = false; break;
        case "reflect.construct": expr = `ts_reflect_construct(${v(0)}, ${v(1)})`; numeric = false; break;
        case "proxy.new": expr = `ts_proxy_new(${v(0)}, ${v(1)})`; numeric = false; break;
        case "proxy.revocable": expr = `ts_proxy_revocable(${v(0)}, ${v(1)})`; numeric = false; break;
        case "symbol.new": expr = `ts_symbol_new(${v(0)})`; numeric = false; break;
        case "symbol.get": expr = `ts_get_symkey(${v(0)}, ${v(1)})`; numeric = false; break;
        case "symbol.description": expr = `ts_symbol_description(${v(0)})`; numeric = false; break;
        case "symbol.for": expr = `ts_symbol_for(${v(0)})`; numeric = false; break;
        case "symbol.keyFor": expr = `ts_symbol_key_for(${v(0)})`; numeric = false; break;
        case "symbol.toString": expr = `ts_symbol_tostring(${v(0)})`; numeric = false; break;
        case "instanceof": expr = `ts_bool(ts_instanceof(${v(0)}, ${v(1)}))`; numeric = false; break;
        // x instanceof C with a Symbol.hasInstance hook: C[Symbol.hasInstance](x).
        // ts_instanceof_hook already returns a tsv bool (ToBoolean of the result).
        case "instanceof.hook": expr = `ts_instanceof_hook(${v(0)}, ${v(1)})`; numeric = false; break;
        // x instanceof <runtime constructor value>: Symbol.hasInstance then a
        // prototype-chain walk against the class value's prototype (returns tsv bool).
        case "instanceof.dyn": expr = `ts_instanceof_dyn(${v(0)}, ${v(1)})`; numeric = false; break;
        case "array.isArray": expr = `ts_bool(ts_is_array_fast(${v(0)}))`; numeric = false; break;
        case "array.newLength": expr = `ts_array_new_length(${n(0)})`; numeric = false; break;
        case "array.from": expr = args.length >= 2 ? `ts_array_from_mapped(${v(0)}, ${v(1)})` : `ts_array_from(${v(0)})`; numeric = false; break;
        // JSON
        case "json.stringify": expr = `ts_json_stringify(${v(0)})`; numeric = false; break;
        case "json.stringify.len": expr = `ts_json_stringify_len(${v(0)})`; numeric = true; break;
        case "json.num.len": expr = `ts_json_num_len_fast(${nc(0)})`; numeric = true; break;
        case "json.string.len": expr = `ts_json_string_len_fast(${v(0)})`; numeric = true; break;
        case "json.stringify.indent": expr = `ts_json_stringify_indent(${v(0)}, ${v(1)})`; numeric = false; break;
        case "json.stringify.indent.len": expr = `ts_json_stringify_indent_len(${v(0)}, ${v(1)})`; numeric = true; break;
        case "json.parse": expr = args.length >= 2 ? `ts_json_parse_reviver(${v(0)}, ${v(1)})` : `ts_json_parse(${v(0)})`; numeric = false; break;
        default:
          unported(`builtin '${builtin}'`);
          return;
      }
      if (dst !== undefined && dst !== null) {
        s.push(numeric ? cxSetNum(cx, dst, expr) : cxSetVal(cx, dst, expr));
      } else {
        s.push(`  ${expr};\n`);
      }
      return;
    }
    case "CallBuiltin": {
      const { dst, builtin, recv } = inst;
      const args: number[] = inst.args ?? [];
      if (dst !== undefined && dst !== null) {
        const spec = cx.scalarSlices.get(dst);
        if (spec !== undefined && spec.root === dst && scalarSliceKind(builtin) !== undefined) {
          emitScalarSliceCalc(s, dst, spec, cx);
          return;
        }
      }
      if (builtin === "string.charCodeAt") {
        const spec = cx.scalarSlices.get(recv);
        if (spec !== undefined) {
          if (dst !== undefined && dst !== null) {
            s.push(cxSetNum(cx, dst, scalarSliceCharcodeatExpr(spec, args, cx, numericFacts)));
          }
          return;
        }
      }
      const r = cxVal(cx, recv);
      const n = (i: number) => (i < args.length ? cxNum(cx, args[i]) : "0");
      const v = (i: number) => (i < args.length ? cxVal(cx, args[i]) : "TS_UNDEFINED");
      const has = (i: number) => (args.length > i ? "1" : "0");
      let expr: string;
      let numeric: boolean;
      switch (builtin) {
        case "number.toString":
          expr = `ts_number_to_string_radix(${r}, ${args.length === 0 ? "10" : n(0)})`;
          numeric = false;
          break;
        case "array.map": expr = `ts_array_map(${r}, ${v(0)})`; numeric = false; break;
        case "array.filter": expr = `ts_array_filter(${r}, ${v(0)})`; numeric = false; break;
        case "array.forEach": expr = `ts_array_foreach(${r}, ${v(0)})`; numeric = false; break;
        case "array.reduce": expr = `ts_array_reduce(${r}, ${v(0)}, ${v(1)}, ${has(1)})`; numeric = false; break;
        case "array.reduceRight": expr = `ts_array_reduce_right(${r}, ${v(0)}, ${v(1)}, ${has(1)})`; numeric = false; break;
        case "array.indexOf": expr = `ts_array_indexof(${r}, ${v(0)}, ${n(1)}, ${has(1)})`; numeric = true; break;
        case "array.includes": expr = `ts_bool(ts_array_includes(${r}, ${v(0)}, ${n(1)}, ${has(1)}))`; numeric = false; break;
        case "array.slice": expr = `ts_array_slice(${r}, ${n(0)}, ${n(1)}, ${has(1)})`; numeric = false; break;
        case "array.concat": expr = `ts_array_concat(${r}, ${v(0)})`; numeric = false; break;
        case "array.join": expr = `ts_array_join(${r}, ${v(0)})`; numeric = false; break;
        case "array.toString": expr = `ts_array_join(${r}, ts_new_string(",", 1))`; numeric = false; break;
        case "array.pop": expr = `ts_array_pop(${r})`; numeric = false; break;
        case "array.find": expr = `ts_array_find(${r}, ${v(0)})`; numeric = false; break;
        case "array.findIndex": expr = `ts_array_findindex(${r}, ${v(0)})`; numeric = true; break;
        case "array.findLast": expr = `ts_array_findlast(${r}, ${v(0)})`; numeric = false; break;
        case "array.findLastIndex": expr = `ts_array_findlastindex(${r}, ${v(0)})`; numeric = true; break;
        case "array.flatMap": expr = `ts_array_flatmap(${r}, ${v(0)})`; numeric = false; break;
        case "array.some": expr = `ts_bool(ts_array_some(${r}, ${v(0)}))`; numeric = false; break;
        case "array.every": expr = `ts_bool(ts_array_every(${r}, ${v(0)}))`; numeric = false; break;
        case "array.lastIndexOf": expr = `ts_array_lastindexof(${r}, ${v(0)}, ${n(1)}, ${has(1)})`; numeric = true; break;
        case "array.at": expr = `ts_array_at(${r}, ${n(0)})`; numeric = false; break;
        case "array.reverse": expr = `ts_array_reverse(${r})`; numeric = false; break;
        case "array.shift": expr = `ts_array_shift(${r})`; numeric = false; break;
        case "array.fill": expr = `ts_array_fill(${r}, ${v(0)}, ${n(1)}, ${n(2)}, ${has(1)}, ${has(2)})`; numeric = false; break;
        case "array.flat": expr = `ts_array_flat(${r}, ${args.length === 0 ? "1" : n(0)})`; numeric = false; break;
        case "array.sort": expr = `ts_array_sort(${r}, ${args.length === 0 ? "TS_UNDEFINED" : v(0)})`; numeric = false; break;
        case "array.toSorted": expr = `ts_array_tosorted(${r}, ${args.length === 0 ? "TS_UNDEFINED" : v(0)})`; numeric = false; break;
        case "array.toReversed": expr = `ts_array_toreversed(${r})`; numeric = false; break;
        case "array.with": expr = `ts_array_with(${r}, ${n(0)}, ${v(1)})`; numeric = false; break;
        case "array.splice": expr = `ts_array_splice(${r}, ${n(0)}, ${n(1)}, 1, ${v(2)})`; numeric = false; break;
        case "array.spliceEnd": expr = `ts_array_splice(${r}, ${n(0)}, 0, 0, ${v(1)})`; numeric = false; break;
        case "array.toSpliced": expr = `ts_array_tospliced(${r}, ${n(0)}, ${n(1)}, 1, ${v(2)})`; numeric = false; break;
        case "array.toSplicedEnd": expr = `ts_array_tospliced(${r}, ${n(0)}, 0, 0, ${v(1)})`; numeric = false; break;
        case "array.copyWithin": expr = `ts_array_copy_within(${r}, ${n(0)}, ${n(1)}, ${n(2)}, ${has(2)})`; numeric = false; break;
        case "string.toUpperCase": expr = `ts_unicode_toupper_tsv(${r})`; numeric = false; break;
        case "string.toLowerCase": expr = `ts_unicode_tolower_tsv(${r})`; numeric = false; break;
        case "string.toLocaleUpperCase": expr = `ts_unicode_tolocaleupper_tsv(${r}, ${v(0)})`; numeric = false; break;
        case "string.toLocaleLowerCase": expr = `ts_unicode_tolocalelower_tsv(${r}, ${v(0)})`; numeric = false; break;
        case "string.normalize": expr = `ts_unicode_normalize_tsv(${r}, ${v(0)})`; numeric = false; break;
        case "string.slice": expr = `ts_str_slice(${r}, ${n(0)}, ${n(1)}, ${has(1)})`; numeric = false; break;
        case "string.substring": expr = `ts_str_substring(${r}, ${n(0)}, ${n(1)}, ${has(1)})`; numeric = false; break;
        case "string.indexOf": expr = `ts_str_indexof_fast(${r}, ${v(0)}, ${n(1)}, ${has(1)})`; numeric = true; break;
        case "string.includes": expr = `ts_bool(ts_str_includes(${r}, ${v(0)}, ${n(1)}, ${has(1)}))`; numeric = false; break;
        case "string.charAt": expr = `ts_str_charat(${r}, ${n(0)})`; numeric = false; break;
        case "string.charCodeAt": {
          const a0 = args.length > 0 ? args[0] : undefined;
          if (a0 !== undefined && cx.intLocal.has(a0)) expr = `ts_str_charcodeat_i64_typed(${r}, d${a0})`;
          else if (a0 !== undefined) expr = `ts_str_charcodeat_typed(${r}, ${n(0)})`;
          else expr = `ts_str_charcodeat_i64_typed(${r}, 0)`;
          numeric = true;
          break;
        }
        case "string.concat": expr = `ts_str_concat(${r}, ${v(0)})`; numeric = false; break;
        case "string.codePointAt": expr = `ts_str_codepointat(${r}, ${n(0)})`; numeric = false; break;
        case "string.repeat": expr = `ts_str_repeat(${r}, ${n(0)})`; numeric = false; break;
        case "string.trim": expr = `ts_str_trim(${r})`; numeric = false; break;
        case "string.split": expr = `ts_str_split(${r}, ${v(0)}, ${v(1)})`; numeric = false; break;
        case "string.startsWith": expr = `ts_bool(ts_str_startswith(${r}, ${v(0)}, ${n(1)}, ${has(1)}))`; numeric = false; break;
        case "string.endsWith": expr = `ts_bool(ts_str_endswith(${r}, ${v(0)}, ${n(1)}, ${has(1)}))`; numeric = false; break;
        case "string.padStart": expr = `ts_str_padstart(${r}, ${n(0)}, ${args.length > 1 ? v(1) : "TS_UNDEFINED"})`; numeric = false; break;
        case "string.padEnd": expr = `ts_str_padend(${r}, ${n(0)}, ${args.length > 1 ? v(1) : "TS_UNDEFINED"})`; numeric = false; break;
        case "string.trimStart": expr = `ts_str_trimstart(${r})`; numeric = false; break;
        case "string.trimEnd": expr = `ts_str_trimend(${r})`; numeric = false; break;
        case "string.trimLeft": expr = `ts_str_trimstart(${r})`; numeric = false; break;
        case "string.trimRight": expr = `ts_str_trimend(${r})`; numeric = false; break;
        case "string.at": expr = `ts_str_at(${r}, ${n(0)})`; numeric = false; break;
        case "string.isWellFormed": expr = `ts_bool(ts_str_is_well_formed(${r}))`; numeric = false; break;
        case "string.toWellFormed": expr = `ts_str_to_well_formed(${r})`; numeric = false; break;
        case "string.replace": expr = `ts_str_replace(${r}, ${v(0)}, ${v(1)}, 0)`; numeric = false; break;
        case "string.replaceAll": expr = `ts_str_replace(${r}, ${v(0)}, ${v(1)}, 1)`; numeric = false; break;
        case "string.lastIndexOf": expr = `ts_str_lastindexof_fast(${r}, ${v(0)}, ${n(1)}, ${has(1)})`; numeric = true; break;
        // ---- Number ----
        case "number.toFixed": expr = `ts_number_to_fixed(${r}, ${args.length === 0 ? "0" : n(0)})`; numeric = false; break;
        case "number.toPrecision": expr = `ts_number_to_precision(${r}, ${args.length === 0 ? "0" : n(0)})`; numeric = false; break;
        case "number.valueOf": expr = cxNum(cx, recv); numeric = true; break;
        case "boolean.toString": expr = `(ts_truthy_fast(${r}) ? ts_new_string("true", 4) : ts_new_string("false", 5))`; numeric = false; break;
        case "boolean.valueOf": expr = `ts_bool(ts_truthy_fast(${r}))`; numeric = false; break;
        case "response.text": expr = `ts_response_text(${r})`; numeric = false; break;
        case "response.json": expr = `ts_response_json(${r})`; numeric = false; break;
        case "headers.get": expr = `ts_headers_get(${r}, ${args.length === 0 ? "TS_UNDEFINED" : v(0)})`; numeric = false; break;
        case "headers.has": expr = `ts_bool(ts_headers_has(${r}, ${args.length === 0 ? "TS_UNDEFINED" : v(0)}))`; numeric = false; break;
        case "headers.keys": expr = `ts_headers_keys(${r})`; numeric = false; break;
        case "headers.values": expr = `ts_headers_values(${r})`; numeric = false; break;
        case "headers.entries": expr = `ts_headers_entries(${r})`; numeric = false; break;
        case "headers.append": expr = `ts_headers_append(${r}, ${args.length === 0 ? "TS_UNDEFINED" : v(0)}, ${args.length > 1 ? v(1) : "TS_UNDEFINED"})`; numeric = false; break;
        case "headers.set": expr = `ts_headers_set(${r}, ${args.length === 0 ? "TS_UNDEFINED" : v(0)}, ${args.length > 1 ? v(1) : "TS_UNDEFINED"})`; numeric = false; break;
        case "headers.delete": expr = `ts_headers_delete(${r}, ${args.length === 0 ? "TS_UNDEFINED" : v(0)})`; numeric = false; break;
        case "generator.next": expr = `ts_gen_next(${r}, ${args.length === 0 ? "TS_UNDEFINED" : v(0)})`; numeric = false; break;
        case "asyncgen.next": expr = `ts_asyncgen_next(${r}, ${args.length === 0 ? "TS_UNDEFINED" : v(0)})`; numeric = false; break;
        case "generator.throw": expr = `ts_gen_throw(${r}, ${args.length === 0 ? "TS_UNDEFINED" : v(0)})`; numeric = false; break;
        case "generator.return": expr = `ts_gen_return(${r}, ${args.length === 0 ? "TS_UNDEFINED" : v(0)})`; numeric = false; break;
        case "asyncgen.throw": expr = `ts_asyncgen_throw(${r}, ${args.length === 0 ? "TS_UNDEFINED" : v(0)})`; numeric = false; break;
        case "promise.then": expr = `ts_promise_then(${r}, ${v(0)}, ${v(1)})`; numeric = false; break;
        case "promise.catch": expr = `ts_promise_catch(${r}, ${v(0)})`; numeric = false; break;
        case "promise.finally": expr = `ts_promise_finally(${r}, ${v(0)})`; numeric = false; break;
        case "map.set": expr = `ts_map_set(${r}, ${v(0)}, ${v(1)})`; numeric = false; break;
        case "map.get": expr = `ts_map_get(${r}, ${v(0)})`; numeric = false; break;
        case "map.has": expr = `ts_bool(ts_map_has(${r}, ${v(0)}))`; numeric = false; break;
        case "map.delete": expr = `ts_bool(ts_map_delete(${r}, ${v(0)}))`; numeric = false; break;
        case "map.clear": expr = `({ ts_map_clear(${r}); TS_UNDEFINED; })`; numeric = false; break;
        case "map.keys": expr = `ts_map_keys(${r})`; numeric = false; break;
        case "map.values": expr = `ts_map_values(${r})`; numeric = false; break;
        case "map.entries": expr = `ts_map_entries(${r})`; numeric = false; break;
        case "map.size": expr = `ts_map_size(${r})`; numeric = true; break;
        case "map.forEach": expr = `({ ts_map_foreach(${r}, ${v(0)}); TS_UNDEFINED; })`; numeric = false; break;
        // ---- Set ----
        case "set.add": expr = `ts_set_add(${r}, ${v(0)})`; numeric = false; break;
        case "set.has": expr = `ts_bool(ts_set_has(${r}, ${v(0)}))`; numeric = false; break;
        case "set.delete": expr = `ts_bool(ts_set_delete(${r}, ${v(0)}))`; numeric = false; break;
        case "set.clear": expr = `({ ts_set_clear(${r}); TS_UNDEFINED; })`; numeric = false; break;
        case "set.keys": expr = `ts_set_keys(${r})`; numeric = false; break;
        case "set.values": expr = `ts_set_values(${r})`; numeric = false; break;
        case "set.entries": expr = `ts_set_entries(${r})`; numeric = false; break;
        case "array.entries": expr = `ts_array_entries(${r})`; numeric = false; break;
        case "array.keys": expr = `ts_array_keys_arr(${r})`; numeric = false; break;
        case "array.values": expr = `ts_array_values_arr(${r})`; numeric = false; break;
        case "set.size": expr = `ts_set_size(${r})`; numeric = true; break;
        case "set.forEach": expr = `({ ts_set_foreach(${r}, ${v(0)}); TS_UNDEFINED; })`; numeric = false; break;
        case "array.push": {
          let blk = "({ ";
          for (const a of args) blk += `ts_array_push(${r}, ${cxVal(cx, a)}); `;
          blk += `(double)ts_array_len_fast(${r}); })`;
          expr = blk;
          numeric = true;
          break;
        }
        case "array.unshift": {
          let blk = "({ ";
          for (const a of [...args].reverse()) blk += `ts_array_unshift(${r}, ${cxVal(cx, a)}); `;
          blk += `(double)ts_array_len_fast(${r}); })`;
          expr = blk;
          numeric = true;
          break;
        }
        default:
          if (builtin.startsWith("iter.step:")) {
            // iter.step:<next-method-id> -> step a generic iterator, looking up
            // `next` by field key then method key, falling back to generator.next.
            const nid = parseInt(builtin.slice("iter.step:".length), 10) || 0;
            const sent = args.length === 0 ? "TS_UNDEFINED" : v(0);
            expr = `ts_iter_step(${r}, ${sent}, ${methodKeyStr(nid, cx.wksym)})`;
            numeric = false;
            break;
          }
          unported(`recv builtin '${builtin}'`);
          return;
      }
      if (dst !== undefined && dst !== null) {
        s.push(numeric ? cxSetNum(cx, dst, expr) : cxSetVal(cx, dst, expr));
      } else {
        s.push(`  ${expr};\n`);
      }
      return;
    }
    default:
      unported(`instruction '${inst.kind}'`);
  }
}

// ---------------------------------- driver ----------------------------------

export function emitProgramC(prog: Program, _result: EscapeResult): string {
  const p: any = prog;
  const needsRegexp = programNeedsRegexp(prog);
  const needsFetch = programNeedsFetch(prog);
  const needsUnicode = programNeedsUnicode(prog);
  const classesMap = classesById(prog);
  const fclass = funcClass(prog);
  const wksym = new Map<number, number>();
  for (const w of (p.wellKnownSymbols ?? []) as any[]) wksym.set(w.nameId, w.wksymId);

  const out: string[] = [];
  out.push("/* generated by emit_c (unboxed numeric + specialized class + dynamic) */\n");
  out.push('#include "ts_rt.h"\n\n');
  if (needsRegexp) {
    out.push("#define TSAOT_NEEDS_REGEXP 1\n");
    out.push('#include "regexp/ts_regexp_adapter.h"\n\n');
  }
  if (needsUnicode) {
    out.push("#define TSAOT_NEEDS_UNICODE 1\n");
    out.push('#include "unicode/ts_unicode_adapter.h"\n\n');
  }
  if (needsFetch) {
    out.push("#define TSAOT_NEEDS_FETCH 1\n\n");
  }
  out.push("#if defined(__GNUC__) || defined(__clang__)\n");
  out.push("#define TS_AOT_INLINE static inline __attribute__((always_inline))\n");
  out.push("#else\n");
  out.push("#define TS_AOT_INLINE static inline\n");
  out.push("#endif\n\n");

  const lits = collectStaticStringLiterals(prog);
  emitStaticStringLiterals(out, lits);
  emitClassLayout(out, classesMap);

  const indirectFuncs = inferIndirectFuncs(prog);
  const paramFactsByFunc = inferProgramParamFacts(prog, indirectFuncs);
  const i64Fast = inferI64FastFuncs(prog, indirectFuncs, paramFactsByFunc);
  const f64Fast = inferF64FastFuncs(prog, indirectFuncs, i64Fast);

  for (const f of prog.functions) out.push(`static tsv ${cname(f)}(tsv* args, int nargs);\n`);
  if (needsRegexp) {
    out.push("static tsv ts_regexpproto_test(tsv* args, int nargs);\n");
    out.push("static tsv ts_regexpproto_exec(tsv* args, int nargs);\n");
  }
  for (const f of prog.functions as any[]) {
    const info = i64Fast.get(f.id);
    if (info !== undefined) {
      const params = info.params.length === 0 ? "void" : info.params.map(() => "long long").join(", ");
      const storage = forceInlineNumericFunc(f) ? "TS_AOT_INLINE" : "static";
      out.push(`${storage} long long ${cname(f)}_i64(${params});\n`);
    }
  }
  for (const f of prog.functions as any[]) {
    const info = f64Fast.get(f.id);
    if (info !== undefined) {
      const params = info.params.length === 0 ? "void" : info.params.map(() => "double").join(", ");
      const storage = forceInlineNumericFunc(f) ? "TS_AOT_INLINE" : "static";
      out.push(`${storage} double ${cname(f)}_f64(${params});\n`);
    }
  }

  out.push("\n");
  out.push("typedef tsv (*ts_fn)(tsv*, int);\n");
  const n = prog.functions.length;
  out.push(`static ts_fn FN_TABLE[${n}] = {${prog.functions.map(cname).join(", ")}${n ? ", " : ""}};\n`);
  out.push(`static const uint32_t FN_ARITY[${n}] = {${prog.functions.map((f) => `${f.arity ?? 0}`).join(", ")}${n ? ", " : ""}};\n`);
  out.push(
    `static const char* FN_NAME[${n}] = {${prog.functions
      .map((f) => cStringLit((f.name ?? "").startsWith("__") ? "" : f.name ?? ""))
      .join(", ")}${n ? ", " : ""}};\n\n`
  );
  out.push(`static const uint8_t FN_HAS_PROTOTYPE[${n}] = {${prog.functions.map((f) => ((f as any).hasPrototype ? "1" : "0")).join(", ")}${n ? ", " : ""}};\n\n`);
  const classes: any[] = p.classes ?? [];
  {
    let maxClassId = 0;
    for (const c of classes) if (c.id > maxClassId) maxClassId = c.id;
    const names: string[] = [];
    for (let i = 0; i <= maxClassId; i++) {
      const c = classes.find((x) => x.id === i);
      names.push(cStringLit(c?.name ?? ""));
    }
    out.push(`static const char* CLASS_NAME[${maxClassId + 1}] = {${names.join(", ")}, };\n\n`);
  }

  out.push(protoSetups(p, needsRegexp, needsUnicode));

  const nglobals = (p.globals ?? []).length;
  if (nglobals > 0) {
    out.push(`static tsv GLOBALS[${nglobals}];\n`);
    out.push("static void ts_setup_globals(void){\n");
    (p.globals ?? []).forEach((g: any) => {
      out.push(`  GLOBALS[${g.id}] = TS_UNDEFINED; ts_gc_root(&GLOBALS[${g.id}]);\n`);
    });
    out.push("}\n\n");
  } else {
    out.push("static void ts_setup_globals(void){}\n\n");
  }

  emitClassProtoSetup(out, prog, wksym);
  emitClassDescriptors(out, prog);

  // First-class static builtin function VALUES: adapters for each distinct
  // builtin referenced via LoadBuiltinFn, plus the unconditional global set
  // (BTreeSet order = lexicographic).
  {
    const builtins = new Set<string>();
    walkBodies(prog, (i) => {
      if (i.kind === "LoadBuiltinFn") builtins.add(i.builtin);
    });
    for (const b of GLOBAL_FN_VALUE_BUILTINS) {
      if (b !== "global.fetch" || needsFetch) builtins.add(b);
    }
    const sorted = [...builtins].sort();
    for (const b of sorted) {
      const body = fnvalAdapterBody(b);
      if (body !== undefined) out.push(`static tsv ${fnvalAdapterName(b)}(tsv* a, int n){ (void)a; (void)n; ${body} }\n`);
    }
  }
  // head of emit_global_setup (the rest is the program-independent snapshot)
  out.push("static tsv ts_make_global_fn(ts_code code, uint32_t arity, const char* name, int takes_this){\n");
  out.push("  tsv f = ts_make_fn_t(code, 0, 0, takes_this);\n");
  out.push("  ts_set_fn_meta(f, arity, name);\n");
  out.push("  return f;\n");
  out.push("}\n\n");
  out.push(EMITC_GLOBAL_OBJECT);
  out.push("\n");

  // alloc strategies (codegen.rs::decide): site -> Stack/FrameArena/CallerArena/Heap
  const strat = new Map<number, string>();
  {
    const meta = new Map<number, any>();
    for (const m of (p.siteMeta ?? []) as any[]) meta.set(m.site, m);
    for (const se of _result.sites) {
      const m = meta.get(se.site);
      const determinable = m?.layoutDeterminable === true;
      const once = m?.multiplicity === "once";
      let st: string;
      if (se.state === "noEscape") st = determinable ? "Stack" : "FrameArena";
      else if (se.state === "argEscape") st = "CallerArena";
      else st = "Heap";
      void once;
      strat.set(se.site, st);
    }
  }
  const fnNames = new Map<number, string>();
  const fnTakesThis = new Map<number, boolean>();
  for (const f of prog.functions as any[]) {
    fnNames.set(f.id, cname(f));
    fnTakesThis.set(f.id, f.takesThis === true);
  }
  const staticStrings = new Map<string, number>();
  for (const l of lits) staticStrings.set(l.key, l.id);

  // ---- typed functions: prologue + body (emit_inst subset) + epilogue.
  // string plans are stubbed empty (byte-diff surfaces fixtures needing them).
  const emptyFacts = new Map<number, NumFact>();
  const i64RetFacts = i64ReturnFacts(i64Fast);
  const fastTargets = numericFastTargets(i64Fast, f64Fast);

  // Numeric fast clones (emit_i64_function / emit_f64_function): same body
  // emitter with i64Mode/f64Mode set and a raw numeric param ABI.
  const emitNumericFunction = (f: any, mode: "i64" | "f64"): void => {
    const localClass = localClassMap(f);
    const fc0 = fclass.get(f.id);
    if (fc0 !== undefined && f.params.length > 0) localClass.set(f.params[0], fc0);
    const unboxed = unboxedCandidates(f, localClass);
    const info: { params: number[] } = mode === "i64" ? i64Fast.get(f.id)! : f64Fast.get(f.id)!;
    const seedFacts = mode === "i64" ? i64Fast.get(f.id)!.paramFacts : emptyFacts;
    const numeric = inferNumericAnalysis(f.body, unboxed, seedFacts, i64RetFacts);
    const intLocal = new Set<number>(numeric.intLocal);
    if (mode === "i64") for (const p of info.params) intLocal.add(p);
    else for (const p of info.params) intLocal.delete(p);
    const numericValueLocal = numericValueLocs(f.body, info.params, fastTargets);
    const jsonLocals = new Set<number>();
    const jsonRoots = new Set<number>();
    const domRefTotal = domRefCount(f.body, jsonLocals);
    const scalarSlices = new Map<number, ScalarStringSlice>();
    const ptype = mode === "i64" ? "long long" : "double";
    const params = info.params.length === 0 ? "void" : info.params.map((_, i) => `${ptype} _p${i}`).join(", ");
    const storage = forceInlineNumericFunc(f) ? "TS_AOT_INLINE" : "static";
    out.push(`${storage} ${ptype} ${cname(f)}_${mode}(${params}){\n`);
    for (const l of f.locals) {
      if (intLocal.has(l.id)) out.push(`  long long d${l.id} = 0;\n`);
      else if (unboxed.has(l.id)) out.push(`  double d${l.id} = 0;\n`);
      else out.push(`  tsv v${l.id} = TS_UNDEFINED;\n`);
    }
    info.params.forEach((p, i) => out.push(`  d${p} = _p${i};\n`));
    const reflike: number[] = [];
    for (const l of f.locals) {
      if (l.refKind !== "primitive" && !unboxed.has(l.id)) reflike.push(l.id);
    }
    for (const id of reflike) out.push(`  ts_gc_root(&v${id});\n`);
    const cx: EmitCtx = {
      unboxed,
      intLocal,
      localClass,
      strat,
      fnNames,
      fnTakesThis,
      staticStrings,
      wksym,
      classes: classesMap,
      jsonLocals,
      jsonRoots,
      domRefTotal,
      scalarSlices,
      i64Fast,
      f64Fast,
      numericValueLocal,
      i64Mode: mode === "i64",
      f64Mode: mode === "f64",
      nroot: reflike.length,
      labelCtr: { n: 900000 },
      loopLabels: [],
      finStack: [],
      ehDepth: 0,
    };
    const numericWithModes: NumericAnalysis = {
      facts: numeric.facts,
      intLocal,
      nonzeroIntConst: numeric.nonzeroIntConst,
      nonzeroInt: numeric.nonzeroInt,
      intConst: numeric.intConst,
      nonnegativeInt: numeric.nonnegativeInt,
    };
    try {
      for (const inst of f.body) emitInstC(out, inst, cx, numericWithModes);
    } catch (e) {
      if (e instanceof UnportedError) (e as any).partial = out.join("");
      throw e;
    }
    if (cx.nroot > 0) out.push(`  ts_gc_unroot(${cx.nroot});\n`);
    out.push(mode === "i64" ? "  return 0;\n}\n\n" : "  return 0.0;\n}\n\n");
  };

  for (const fnAny of prog.functions as any[]) {
    const f = fnAny;
    if (i64Fast.has(f.id)) emitNumericFunction(f, "i64");
    if (f64Fast.has(f.id)) emitNumericFunction(f, "f64");
    const localClass = localClassMap(f);
    const fc = fclass.get(f.id);
    if (fc !== undefined && f.params.length > 0) localClass.set(f.params[0], fc);
    const unboxed = unboxedCandidates(f, localClass);
    const pf = paramFactsByFunc.get(f.id) ?? emptyFacts;
    const numeric = inferNumericAnalysis(f.body, unboxed, pf, i64RetFacts);
    const intLocal = numeric.intLocal;
    const numericValueLocal = numericValueLocs(f.body, (f.params as number[]).slice(), fastTargets);
    let emitRegularFunction = true;
    if (f.isAsync || f.isGenerator) {
      // coroutine state machine: locals live in the frame; no gc roots / json.
      const cx: EmitCtx = {
        unboxed,
        intLocal,
        localClass,
        strat,
        fnNames,
        fnTakesThis,
        staticStrings,
        wksym,
        classes: classesMap,
        jsonLocals: new Set<number>(),
        jsonRoots: new Set<number>(),
        domRefTotal: domRefCount(f.body, new Set<number>()),
        scalarSlices: new Map<number, ScalarStringSlice>(),
        i64Fast,
        f64Fast,
        numericValueLocal,
        i64Mode: false,
        f64Mode: false,
        nroot: 0,
        labelCtr: { n: 900000 },
        loopLabels: [],
        finStack: [],
        ehDepth: 0,
      };
      const mode: SmMode = f.isAsync && f.isGenerator ? "AsyncGenerator" : f.isAsync ? "Async" : "Generator";
      try {
        emitCoroutineFunctionC(out, f, cx, numeric, mode);
      } catch (e) {
        if (e instanceof UnportedError) (e as any).partial = out.join("");
        throw e;
      }
      emitRegularFunction = false;
    }
    if (emitRegularFunction) {
    const scalarSlices = collectScalarStringSlices(f.body);
    const jsonLocals = collectJsonDomLocals(f.body);
    const jsonRoots = jsonLocals.size === 0 ? new Set<number>() : collectJsonDomParseRoots(f.body);
    const domRefTotal = domRefCount(f.body, jsonLocals);

    out.push(`static tsv ${cname(f)}(tsv* args, int nargs){\n`);
    out.push("  (void)nargs;\n");
    for (const l of f.locals) {
      if (intLocal.has(l.id)) out.push(`  long long d${l.id} = 0;\n`);
      else if (jsonLocals.has(l.id)) out.push(`  tjson_value* j${l.id} = NULL;\n`);
      else if (unboxed.has(l.id)) out.push(`  double d${l.id} = 0;\n`);
      else out.push(`  tsv v${l.id} = TS_UNDEFINED;\n`);
    }
    if (jsonRoots.size > 0) out.push("  ts_json_dom_scope _json_dom_scope = {0};\n");
    const scalarSliceRoots = new Set<number>();
    for (const spec of scalarSlices.values()) scalarSliceRoots.add(spec.root);
    const ssRoots = [...scalarSliceRoots].sort((a, b) => a - b);
    for (const id of ssRoots) {
      out.push(`  tsv ss_base${id} = TS_UNDEFINED; long long ss_start${id} = 0, ss_len${id} = 0; int ss_fast${id} = 0;\n`);
    }
    const restParam = f.restParam ?? null;
    f.params.forEach((p: number, i: number) => {
      if (p === restParam) return;
      if (intLocal.has(p)) out.push(`  if (nargs > ${i}) d${p} = (long long)ts_to_num(args[${i}]);\n`);
      else if (unboxed.has(p)) out.push(`  if (nargs > ${i}) d${p} = ts_to_num(args[${i}]);\n`);
      else out.push(`  if (nargs > ${i}) v${p} = args[${i}];\n`);
    });
    const reflike: number[] = [];
    for (const l of f.locals) {
      if (l.refKind !== "primitive" && !unboxed.has(l.id) && !jsonLocals.has(l.id)) reflike.push(l.id);
    }
    for (const id of reflike) out.push(`  ts_gc_root(&v${id});\n`);
    for (const id of ssRoots) out.push(`  ts_gc_root(&ss_base${id});\n`);
    if (restParam !== null && restParam !== undefined) {
      let restIndex = f.params.indexOf(restParam);
      if (restIndex < 0) restIndex = Math.max(f.params.length - 1, 0);
      out.push(`  v${restParam} = ts_new_array(0);\n`);
      out.push(`  for (int _ri = ${restIndex}; _ri < nargs; _ri++) ts_array_push(v${restParam}, args[_ri]);\n`);
    }

    // ---- body ops ----
    const cx: EmitCtx = {
      unboxed,
      intLocal,
      localClass,
      strat,
      fnNames,
      fnTakesThis,
      staticStrings,
      wksym,
      classes: classesMap,
      jsonLocals,
      jsonRoots,
      domRefTotal,
      scalarSlices,
      i64Fast,
      f64Fast,
      numericValueLocal,
      i64Mode: false,
      f64Mode: false,
      nroot: reflike.length + ssRoots.length,
      labelCtr: { n: 900000 },
      loopLabels: [],
      finStack: [],
      ehDepth: 0,
    };
    try {
      for (const inst of f.body) emitInstC(out, inst, cx, numeric);
    } catch (e) {
      if (e instanceof UnportedError) (e as any).partial = out.join("");
      throw e;
    }
    if (cx.jsonRoots.size > 0) out.push("  ts_json_dom_scope_free(&_json_dom_scope);\n");
    if (cx.nroot > 0) out.push(`  ts_gc_unroot(${cx.nroot});\n`);
    out.push("  return TS_UNDEFINED;\n}\n\n");
    }
  }

  // ---- field tables (indexed by max field id; gaps are empty names) ----
  {
    const fields: any[] = p.fields ?? [];
    let maxid: number | undefined;
    for (const f of fields) if (maxid === undefined || f.id > maxid) maxid = f.id;
    if (maxid !== undefined) {
      const nf = maxid + 1;
      const names: number[][] = [];
      for (let i = 0; i < nf; i++) names.push([]);
      for (const f of fields) {
        if (f.id < names.length) names[f.id] = fieldNameBytesC(f);
      }
      names.forEach((nm, i) => {
        out.push(`static const char FIELD_NAME_${i}[] = {${[...nm, 0].join(", ")}};\n`);
      });
      out.push("static const char* const FIELD_NAMES[] = {\n");
      for (let i = 0; i < names.length; i++) out.push(`  FIELD_NAME_${i},\n`);
      out.push("};\n");
      out.push("static const uint32_t FIELD_NAME_LENS[] = {\n");
      for (const nm of names) out.push(`  ${nm.length}u,\n`);
      out.push("};\n");
      out.push(`static const uint32_t FIELD_NAMES_COUNT = ${nf};\n`);
    } else {
      out.push("static const char* const FIELD_NAMES[] = {0};\nstatic const uint32_t FIELD_NAME_LENS[] = {0};\nstatic const uint32_t FIELD_NAMES_COUNT = 0;\n");
    }
  }

  // ---- main() ----
  let entry = (prog.functions as any[]).find((f) => f.name === "__module_init");
  if (entry === undefined) {
    entry = (prog.functions as any[]).find((f) => f.name === "main") ?? (prog.functions as any[])[0];
  }
  out.push("int main(void){\n");
  out.push("  ts_init_fields(FIELD_NAMES, FIELD_NAME_LENS, FIELD_NAMES_COUNT);\n");
  out.push("  ts_setup_object_proto();\n");
  out.push("  ts_setup_function_proto();\n");
  out.push("  ts_setup_array_proto();\n");
  out.push("  ts_setup_promise_proto();\n");
  out.push("  ts_setup_map_proto();\n");
  out.push("  ts_setup_set_proto();\n");
  out.push("  ts_setup_headers_proto();\n");
  out.push("  ts_setup_string_proto();\n");
  if (needsRegexp) out.push("  ts_setup_regexp_proto();\n");
  out.push("  ts_setup_number_proto();\n");
  out.push("  ts_setup_boolean_proto();\n");
  out.push("  ts_setup_global_object();\n");
  out.push("  ts_setup_globals();\n");
  if (classes.length > 0) out.push("  ts_setup_prototypes();\n");
  out.push("  ts_register_classes();\n");
  const fvInit = (prog.functions as any[]).find((f) => f.name === "__function_values_init");
  if (fvInit !== undefined) out.push(`  ${cname(fvInit)}(0, 0);\n`);
  // Static-init fallback: only when there is NO __module_init (which would call
  // each class's __static_init at its source position itself).
  const hasModuleInit = (prog.functions as any[]).some((f) => f.name === "__module_init");
  if (!hasModuleInit) {
    for (const f of prog.functions as any[]) {
      if (typeof f.name === "string" && f.name.startsWith("__static_init_")) {
        out.push(`  ${cname(f)}(0, 0);\n`);
      }
    }
  }
  if (entry !== undefined) out.push(`  ${cname(entry)}(0, 0);\n`);
  out.push("  ts_run_event_loop();\n");
  out.push('  if (getenv("TSAOT_GC_AT_EXIT")) ts_gc_collect();\n');
  out.push("  return 0;\n");
  out.push("}\n");
  return out.join("");
}

/** Partial output for prefix-parity measurement (TSAOT_EMITC_PARTIAL=1):
 *  returns whatever was built before the first UnportedError. */
export function emitProgramCPartial(prog: Program, result: EscapeResult): { c: string; unported?: string } {
  try {
    return { c: emitProgramC(prog, result) };
  } catch (e) {
    if (e instanceof UnportedError) {
      return { c: (e as any).partial ?? "", unported: e.message };
    }
    throw e;
  }
}
