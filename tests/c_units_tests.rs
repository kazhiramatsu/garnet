mod c_units;
// The emitter's unit mode (analyzer/src/c_units.rs, docs/build_split_design.md):
// a synthetic one-file program split into units. The native builds compile
// the real units (tests/units_build_gate.sh); this checks the split itself.
use c_units::{split, Options};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn ck(n: &str, ok: bool) { println!("[{}] {}", n, if ok { "PASS" } else { "*** FAIL ***" }); assert!(ok, "{}", n); }

fn big(name: &str, lines: usize, body_line: &str) -> String {
    let mut s = format!("static tsv {}(tsv* args, int nargs) {{\n", name);
    for _ in 0..lines { s.push_str(body_line); s.push('\n'); }
    s.push_str("  return args[0];\n}\n");
    s
}

// Modules: 0 = src/a.ts (small: a bin), 1 = src/b.ts (above the chunk size:
// two chunks). fn_5_big is cold; fn_8_free has no module (the data unit).
fn program(fn9_body: &str, fn1_body: &str) -> String {
    let mut c = String::from("#include <stdint.h>\n#include \"ts_rt.h\"\n#define TS_AOT_INLINE static inline\n");
    c.push_str("/* a { brace in a comment */\n");
    c.push_str("static struct { uint32_t len; char s[8]; } str_0 = { 3, \"a{\\\"}\" };\n");
    c.push_str("typedef struct cls_1 { int a; } cls_1;\n");
    for f in ["fn_1_small", "fn_2_caller", "fn_3_counter", "fn_4_helper", "fn_5_big", "fn_6_tabled", "fn_7_other", "fn_8_free", "fn_9_private", "fn_10_self"] {
        c.push_str(&format!("static tsv {}(tsv* args, int nargs);\n", f));
    }
    c.push_str("static const char* g_names[] = { \"x}\", \"{y\", 0 };\nstatic tsv g_slot;\n");
    c.push_str("static void* g_table[] = { (void*)fn_6_tabled };\n");
    c.push_str(&format!("static tsv fn_1_small(tsv* args, int nargs) {{ {} }}\n", fn1_body));
    c.push_str("static tsv fn_2_caller(tsv* args, int nargs) {\n  tsv v = fn_1_small(args, nargs);\n  return fn_4_helper(&v, 1);\n}\n");
    c.push_str(&format!("static tsv fn_3_counter(tsv* args, int nargs) {{ static int n; n++; (void)args; (void)nargs; return g_slot; }}\n"));
    c.push_str("static tsv fn_4_helper(tsv* args, int nargs) {\n  return fn_3_counter(args, nargs);\n}\n");
    c.push_str(&big("fn_5_big", 40, "  fn_4_helper(args, nargs);"));
    c.push_str("static tsv fn_6_tabled(tsv* args, int nargs) { return args[nargs - 1]; }\n");
    c.push_str("static tsv fn_7_other(tsv* args, int nargs) {\n  void* p = (void*)fn_1_small;\n  (void)p;\n  tsv v = fn_1_small(args, nargs);\n  v = fn_10_self(&v, 1);\n  return fn_9_private(&v, fn_3_counter(&v, 1) != 0);\n}\n");
    c.push_str("static tsv fn_8_free(tsv* args, int nargs) { (void)nargs; return args[0]; }\n");
    c.push_str(&format!("static tsv fn_9_private(tsv* args, int nargs) {{ {} }}\n", fn9_body));
    c.push_str("static tsv fn_10_self(tsv* args, int nargs) { void* me = (void*)fn_10_self; (void)me; (void)nargs; return args[0]; }\n");
    // the emitter's spacing: no space before the brace (the native build scripts patch this text)
    c.push_str("int main(void){\n  tsv a[1] = {0};\n  fn_8_free(a, 1);\n  return (int)fn_2_caller(a, 1) + (int)fn_7_other(a, 1);\n}\n");
    c
}

fn opts() -> Options { Options { inline_lines: 5, chunk_lines: 8, bins: 4, cold_lines: 30, split_init: true, init_chunk_lines: 1000 } }

fn modules() -> (Vec<String>, BTreeMap<u32, u32>) {
    let m = vec!["src/a.ts".to_string(), "src/b.ts".to_string()];
    let fm: BTreeMap<u32, u32> = [(1, 0), (2, 0), (3, 1), (4, 1), (5, 1), (6, 1), (7, 1), (9, 1), (10, 0)].into_iter().collect();
    (m, fm)
}

fn dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("c_units_tests_{}_{}", std::process::id(), tag));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn read(d: &Path, f: &str) -> String { std::fs::read_to_string(d.join(f)).unwrap_or_else(|e| panic!("{}: {}", f, e)) }

// A module initialization of the emitter's shape (docs/startup_design.md, S1):
// a prologue of plain declarations, the frame, the body, the epilogue. `extra`
// goes into the body (a fallback case); fn_12_use is a small function it calls.
fn init_program(extra: &str) -> String {
    let mut c = String::from("#include \"ts_rt.h\"\ntypedef struct { tsv f0; } Class1;\n");
    c.push_str("static tsv fn_12_use(tsv a);\nstatic tsv fn_11___module_init_d(void);\n");
    c.push_str("static tsv fn_12_use(tsv a) { return a; }\n");
    c.push_str("static tsv fn_11___module_init_d(void){\n");
    for k in 1..=6 { c.push_str(&format!("  tsv v{} = TS_UNDEFINED;\n", k)); }
    c.push_str("  long long d7 = 0;\n  double d8 = 0.0;\n  tsv v9 = TS_UNDEFINED;\n  tsv v10 = TS_UNDEFINED;\n  Class1 sobj1;\n");
    c.push_str("  struct { ts_frame_hdr h; tsv s0; tsv s1; } F;\n  F.s0 = TS_UNDEFINED;\n  F.s1 = TS_UNDEFINED;\n  ts_frame_push(&F.h, 2);\n");
    c.push_str("  v1 = ts_num(1);\n");                                   // v1: used by every chunk (shared)
    c.push_str("  F.s0 = fn_12_use(v1);\n");
    c.push_str("  Class1* hobj0 = (Class1*)ts_ptr(F.s0);\n");             // a mid-body declaration used later (shared)
    c.push_str("  v2 = ts_num(2);\n  v9 = fn_12_use(ts_num(9)); F.s1 = fn_12_use(v9);\n");   // v9: one line, one chunk's own
    c.push_str("  if (ts_truthy(v1)) {\n    v3 = v1;\n  }\n  else {\n    v3 = v2;\n  }\n");   // no cut before the else
    c.push_str("  d7 = 0;\n  L100: ;\n  d7 = d7 + 1;\n  v4 = ts_num((double)d7);\n  v4 = fn_12_use(v4);\n  if (d7 < 3) goto L100;\n");   // the label's span
    c.push_str("  static const ts_key lk_1[1] = {7u}; static int lit_1 = 3;\n");   // a depth-0 static: one chunk with its uses
    c.push_str("  v5 = ts_num((double)lk_1[0]);\n  v5 = fn_12_use(v5);\n  v5 = ts_num((double)lit_1);\n");
    c.push_str("  v6 = fn_12_use(v5);\n  v10 = fn_12_use(v6); ts_gc_root(&v10); ts_gc_unroot(1);\n");   // v10: one line, but its address is taken
    c.push_str("  memset(&sobj1, 0, sizeof(Class1)); F.s1 = ts_obj(&sobj1);\n");   // a stack object: its address in a frame slot
    c.push_str("  double _md1 = (double)d7; double _md1b = (double)d8; if (_md1 == _md1b) {\n    v6 = ts_num(_md1);\n  }\n");   // a modulo's operands, then its test
    c.push_str(extra);
    c.push_str("  hobj0->f0 = v1;\n  d8 = (double)d7;\n  F.s1 = fn_12_use(v6);\n");
    for k in 0..12 { c.push_str(&format!("  F.s1 = fn_12_use(v1); /* filler {} */\n", k)); }
    c.push_str("  ts_frame_pop(&F.h);\n  return TS_UNDEFINED;\n  ts_frame_pop(&F.h);\n  return TS_UNDEFINED;\n}\n");
    c.push_str("int main(void){\n  fn_11___module_init_d();\n  return 0;\n}\n");
    c
}

/// The part functions in the init units, by number: (unit file, definition text).
fn init_parts(d: &Path) -> BTreeMap<usize, (String, String)> {
    let mut out = BTreeMap::new();
    for (f, t) in files(d) {
        if !f.starts_with("init_") { continue; }
        let mut rest = t.as_str();
        while let Some(k) = rest.find("void fn_11___module_init_d__part_") {
            let after = &rest[k + "void fn_11___module_init_d__part_".len()..];
            let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
            let n: usize = digits.parse().unwrap();
            let sig_end = after.find(')').unwrap();
            if after[sig_end + 1..].starts_with('{') {
                let body_start = k + "void fn_11___module_init_d__part_".len() + sig_end + 1;
                let end = rest[body_start..].find("\n}\n").map(|e| body_start + e + 3).unwrap_or(rest.len());
                out.insert(n, (f.clone(), rest[body_start..end].to_string()));
                rest = &rest[end..];
            } else {
                rest = &after[sig_end..];
            }
        }
    }
    out
}

fn files(d: &Path) -> BTreeMap<String, String> {
    std::fs::read_dir(d).unwrap().map(|e| {
        let e = e.unwrap();
        let n = e.file_name().to_string_lossy().to_string();
        let t = std::fs::read_to_string(e.path()).unwrap();
        (n, t)
    }).collect()
}

fn main() {
    let (m, fm) = modules();
    let base_fn9 = "(void)nargs; return args[0];";
    let base_fn1 = "(void)nargs; char c = '}'; (void)c; return args[0];";
    let d = dir("base");
    let units = split(&program(base_fn9, base_fn1), &m, &fm, &d, &opts()).expect("split");
    let names: Vec<String> = units.iter().map(|u| u.file.clone()).collect();
    let bin = format!("bin_{}.c", { let mut h: u32 = 0x811c9dc5; for b in "src/a.ts".bytes() { h ^= b as u32; h = h.wrapping_mul(0x01000193); } h as usize % 4 });
    let m0 = names.iter().find(|n| n.starts_with("m_b_") && n.ends_with("_0.c")).cloned().unwrap_or_default();
    let m1 = names.iter().find(|n| n.starts_with("m_b_") && n.ends_with("_1.c")).cloned().unwrap_or_default();
    ck("units: data, a's bin, b's two chunks, the cold unit", names.len() == 5 && names.contains(&"data.c".to_string()) && names.contains(&bin) && !m0.is_empty() && !m1.is_empty() && names.contains(&"cold_fn_5_big.c".to_string()));
    ck("only the cold unit is cold", units.iter().all(|u| u.cold == (u.file == "cold_fn_5_big.c")));
    let h = read(&d, "prog.h");
    let data = read(&d, "data.c");
    let ub = read(&d, &bin);
    let u0 = read(&d, &m0);
    let u1 = read(&d, &m1);
    let cold = read(&d, "cold_fn_5_big.c");
    // the header: declarations only, hidden, no copies
    ck("header: hidden after the includes, popped at the end", h.contains("#include \"ts_rt.h\"\n#pragma GCC visibility push(hidden)\n") && h.trim_end().ends_with("#pragma GCC visibility pop"));
    ck("header: the literal's struct is named", h.contains("struct str_0__t { uint32_t len; char s[8]; };\nextern struct str_0__t str_0;"));
    ck("header: data as extern declarations", h.contains("extern const char* g_names[];") && h.contains("extern tsv g_slot;") && h.contains("extern void* g_table[];"));
    ck("header: the extern functions' prototypes", ["fn_1_small", "fn_3_counter", "fn_4_helper", "fn_6_tabled", "fn_7_other"].iter().all(|f| h.contains(&format!("\ntsv {}(tsv* args, int nargs);", f))));
    ck("header: no unit-local function, no copy", !h.contains("fn_2_caller") && !h.contains("fn_8_free") && !h.contains("fn_9_private") && !h.contains("__i"));
    // data.c: main, the data, the module-less function, the copies main needs
    ck("data: the literal and the table defined", data.contains("struct str_0__t str_0 = { 3, \"a{\\\"}\" };") && data.contains("void* g_table[] = { (void*)fn_6_tabled };"));
    ck("data: a static prototype before the data", data.find("static tsv fn_8_free(tsv* args, int nargs);").map_or(false, |p| p < data.find("g_names").unwrap()));
    ck("data: main calls the copy of another unit's function", data.contains("(int)fn_2_caller__i(a, 1)") && data.contains("fn_8_free(a, 1)"));
    ck("data: a definition keeps its text (no space added before the brace)", data.contains("\nint main(void){\n  tsv a[1] = {0};\n"));
    ck("data: the copies main reaches, transitively", ["fn_2_caller__i", "fn_1_small__i", "fn_4_helper__i"].iter().all(|f| data.contains(&format!("static inline tsv {}(tsv* args, int nargs) {{", f))));
    ck("data: no copy of a function with a local static", !data.contains("fn_3_counter__i"));
    // a's bin
    ck("bin: a function only its copies' callers reach stays static", ub.contains("static tsv fn_2_caller(tsv* args, int nargs) {"));
    ck("bin: a call within the unit is direct, another unit's goes to the copy", ub.contains("tsv v = fn_1_small(args, nargs);") && ub.contains("return fn_4_helper__i(&v, 1);"));
    ck("bin: an address use elsewhere keeps the definition extern", ub.contains("\ntsv fn_1_small(tsv* args, int nargs) {"));
    ck("bin: the copy it calls, and no other", ub.contains("static inline tsv fn_4_helper__i(") && !ub.contains("fn_1_small__i") && !ub.contains("fn_2_caller__i"));
    // b's chunks
    ck("chunk 0: the counter keeps its local static, extern", u0.contains("\ntsv fn_3_counter(tsv* args, int nargs) { static int n;"));
    ck("chunk 0: called from the cold unit, extern", u0.contains("\ntsv fn_4_helper(tsv* args, int nargs) {") && u0.contains("\ntsv fn_6_tabled("));
    ck("chunk 1: the address stays the original, the call uses the copy", u1.contains("void* p = (void*)fn_1_small;") && u1.contains("tsv v = fn_1_small__i(args, nargs);") && u1.contains("static inline tsv fn_1_small__i("));
    ck("a copy that takes its original's address keeps the original extern", u1.contains("static inline tsv fn_10_self__i(") && u1.contains("v = fn_10_self__i(&v, 1);") && h.contains("\ntsv fn_10_self(tsv* args, int nargs);") && ub.contains("\ntsv fn_10_self(tsv* args, int nargs) {"));
    ck("chunk 1: a function referenced only in its unit is static", u1.contains("static tsv fn_9_private(tsv* args, int nargs);") && u1.contains("static tsv fn_9_private(tsv* args, int nargs) {"));
    ck("cold: calls the originals, no copies", cold.contains("  fn_4_helper(args, nargs);") && !cold.contains("__i"));
    // stability: an edit recompiles the units that contain the edited text
    let base = files(&d);
    let d2 = dir("edit9");
    split(&program("(void)nargs; return args[1];", base_fn1), &m, &fm, &d2, &opts()).expect("split edit9");
    let e9 = files(&d2);
    let changed: Vec<&String> = base.keys().filter(|f| base[*f] != e9[*f]).collect();
    ck("edit of a unit-local function: only its unit changes", changed == vec![&m1]);
    let d3 = dir("edit1");
    split(&program(base_fn9, "(void)nargs; return args[1];"), &m, &fm, &d3, &opts()).expect("split edit1");
    let e1 = files(&d3);
    let mut changed: Vec<String> = base.keys().filter(|f| base[*f] != e1[*f]).cloned().collect();
    changed.sort();
    let mut want = vec!["data.c".to_string(), bin.clone(), m1.clone()];
    want.sort();
    ck("edit of a copied function: its unit and its copies' units, not the header", changed == want);
    // the cold rule for run-once creators
    let mut c = String::from("#include \"ts_rt.h\"\n");
    c.push_str(&big("fn_1_createScanner", 2000, "  (void)nargs;"));
    c.push_str(&big("fn_2_createscan", 2000, "  (void)nargs;"));
    c.push_str("int main(void) { tsv a[1] = {0}; return (int)fn_1_createScanner(a, 1) + (int)fn_2_createscan(a, 1); }\n");
    let d4 = dir("create");
    let fm4: BTreeMap<u32, u32> = [(1, 0), (2, 0)].into_iter().collect();
    let u4 = split(&c, &m, &fm4, &d4, &Options { inline_lines: 60, chunk_lines: 20000, bins: 16, cold_lines: 10000, split_init: true, init_chunk_lines: 1000 }).expect("split create");
    let cold4: Vec<&str> = u4.iter().filter(|u| u.cold).map(|u| u.file.as_str()).collect();
    ck("cold: a 2000-line creator, not a lowercase name", cold4 == vec!["cold_fn_1_createScanner.c"]);
    // loud failures
    let d5 = dir("bad");
    ck("an unclassified item stops the split", split("#include \"ts_rt.h\"\nfoo bar baz;\nint main(void) { return 0; }\n", &m, &fm, &d5, &opts()).is_err());
    ck("a function-pointer object stops the split", split("#include \"ts_rt.h\"\nstatic tsv (*g_fp)(tsv*, int) = 0;\nint main(void) { return 0; }\n", &m, &fm, &d5, &opts()).is_err());
    // the module initialization split (docs/startup_design.md, S1)
    let iopt = Options { inline_lines: 5, chunk_lines: 30, bins: 4, cold_lines: 20, split_init: true, init_chunk_lines: 4 };
    let fmi: BTreeMap<u32, u32> = [(11, 0), (12, 0)].into_iter().collect();
    let d6 = dir("init");
    let u6 = split(&init_program(""), &m, &fmi, &d6, &iopt).expect("split init");
    let n6: Vec<&str> = u6.iter().map(|u| u.file.as_str()).collect();
    ck("init: no cold unit, init units instead, none cold", !n6.iter().any(|f| f.starts_with("cold_")) && n6.iter().filter(|f| f.starts_with("init_fn_11___module_init_d_")).count() >= 2 && u6.iter().all(|u| !u.cold));
    let parts = init_parts(&d6);
    let caller_unit = "init_fn_11___module_init_d_0.c";
    let cu = read(&d6, caller_unit);
    ck("init: several parts, numbered from 0", parts.len() >= 3 && parts.keys().copied().eq(0..parts.len()));
    let calls: Vec<usize> = (0..parts.len()).filter_map(|k| cu.find(&format!("  fn_11___module_init_d__part_{}(mi__s, mi__f);", k))).collect();
    ck("init: the caller calls every part, in order", calls.len() == parts.len() && calls.windows(2).all(|w| w[0] < w[1]));
    ck("init: the caller keeps the frame and pushes and pops it", cu.contains("  mi__f->s0 = TS_UNDEFINED;") && cu.contains("  ts_frame_push(&mi__f->h, 2);") && cu.contains("  ts_frame_pop(&mi__f->h);\n  return TS_UNDEFINED;\n}"));
    ck("init: the caller initializes the shared prologue variables", cu.contains("  mi__s->v1 = TS_UNDEFINED;") && !cu.contains("mi__s->v9 ="));
    let all_parts: String = parts.values().map(|(_, b)| b.as_str()).collect();
    ck("init: a variable several parts use goes through the struct", all_parts.contains("mi__s->v1 = ts_num(1);") && all_parts.contains("fn_12_use(mi__s->v1)"));
    ck("init: a mid-body declaration they share becomes an assignment", all_parts.contains("  mi__s->hobj0 = (Class1*)ts_ptr(mi__f->s0);") && all_parts.contains("mi__s->hobj0->f0") && !all_parts.contains("Class1* hobj0"));
    let part_of = |needle: &str| parts.iter().filter(|(_, (_, b))| b.contains(needle)).map(|(k, _)| *k).collect::<Vec<usize>>();
    ck("init: a variable one part uses is that part's own", part_of("tsv v9 = TS_UNDEFINED;").len() == 1 && !all_parts.contains("mi__s->v9") && part_of("mi__f->s1 = fn_12_use(v9);") == part_of("tsv v9 = TS_UNDEFINED;"));
    ck("init: an if and its else stay together", part_of("if (ts_truthy(").len() == 1 && part_of("if (ts_truthy(") == part_of("  else {"));
    ck("init: a label and its goto stay together", part_of("L100: ;").len() == 1 && part_of("L100: ;") == part_of("goto L100;"));
    ck("init: a depth-0 static stays with its uses", part_of("static int lit_1 = 3;").len() == 1 && part_of("static int lit_1 = 3;") == part_of("ts_num((double)lit_1)") && part_of("static int lit_1 = 3;") == part_of("ts_num((double)lk_1[0])"));
    ck("init: a variable whose address is taken lives on the caller's stack", all_parts.contains("ts_gc_root(&mi__s->v10)") && !all_parts.contains("tsv v10 = TS_UNDEFINED;"));
    ck("init: a stack object lives on the caller's stack", all_parts.contains("F.s1 = ts_obj(&mi__s->sobj1);") || all_parts.contains("mi__f->s1 = ts_obj(&mi__s->sobj1);"));
    ck("init: its struct type is a field of the shared struct", cu.contains(" Class1 sobj1;") && !all_parts.contains("Class1 sobj1;"));
    ck("init: declarations sharing a line with a block start stay in one part", part_of("double _md1 = (double)").len() == 1 && part_of("double _md1 = (double)") == part_of("v6 = ts_num(_md1);"));
    ck("init: the frame through its pointer in the parts", !all_parts.contains("F.s") && all_parts.contains("mi__f->s1"));
    ck("init: the parts are noinline, hidden, and the struct types are the unit's", parts.values().all(|(f, _)| read(&d6, f).contains("typedef struct { ts_frame_hdr h; tsv s0; tsv s1; } mi__frame_")) && cu.contains("__attribute__((noinline, visibility(\"hidden\"))) void fn_11___module_init_d__part_"));
    let h6 = read(&d6, "prog.h");
    ck("init: the header does not declare the parts", !h6.contains("__part_"));
    let remote: Vec<usize> = parts.iter().filter(|(_, (f, _))| f != caller_unit).map(|(k, _)| *k).collect();
    ck("init: the caller's unit declares the parts other units define", !remote.is_empty() && remote.iter().all(|k| cu.contains(&format!("void fn_11___module_init_d__part_{}(void* mi__sp, void* mi__fp);", k))));
    ck("init: the init units call the originals (no copies)", files(&d6).iter().filter(|(f, _)| f.starts_with("init_")).all(|(_, t)| !t.contains("__i(")));
    // a module initialization without a frame (small programs): the same split, no frame pointer
    let mut fl = String::from("#include \"ts_rt.h\"\nstatic tsv fn_12_use(tsv a);\nstatic tsv fn_11___module_init_d(void);\nstatic tsv fn_12_use(tsv a) { return a; }\n");
    fl.push_str("static tsv fn_11___module_init_d(void){\n  tsv v1 = TS_UNDEFINED;\n  tsv v2 = TS_UNDEFINED;\n  long long d3 = 0;\n");
    fl.push_str("  v1 = fn_12_use(ts_num(1));\n");
    for k in 0..16 { fl.push_str(&format!("  v2 = fn_12_use(v1); /* {} */\n", k)); }
    fl.push_str("  d3 = 2;\n  return TS_UNDEFINED;\n  return TS_UNDEFINED;\n}\nint main(void){\n  fn_11___module_init_d();\n  return 0;\n}\n");
    let d7 = dir("frameless");
    let u7 = split(&fl, &m, &fmi, &d7, &iopt).expect("split frameless");
    let c7 = read(&d7, "init_fn_11___module_init_d_0.c");
    ck("init: a frameless initialization splits, the parts get no frame", u7.iter().any(|u| u.file.starts_with("init_")) && c7.contains("  fn_11___module_init_d__part_1(mi__s, (void*)0);") && !c7.contains("mi__frame_") && !c7.contains("ts_frame_push") && c7.contains("  return TS_UNDEFINED;\n}"));
    let _ = std::fs::remove_dir_all(&d7);
    // what keeps the function whole (its cold unit)
    let whole = |tag: &str, extra: &str, o: &Options| -> bool {
        let d = dir(tag);
        let u = split(&init_program(extra), &m, &fmi, &d, o).expect("split whole");
        let _ = std::fs::remove_dir_all(&d);
        u.iter().any(|x| x.file == "cold_fn_11___module_init_d.c") && !u.iter().any(|x| x.file.starts_with("init_"))
    };
    ck("init: a return in the body keeps it whole", whole("ret", "  if (ts_truthy(v1)) { return v1; }\n", &iopt));
    ck("init: an automatic array at the top level keeps it whole", whole("arr", "  tsv arr0[2] = {v1, v5};\n  v6 = fn_12_use(arr0[0]);\n", &iopt));
    ck("init: an address taken of a variable declared with another keeps it whole", whole("pinaddr", "  tsv pa = v1, pb = v2; ts_gc_root(&pa);\n  ts_gc_unroot(1);\n", &iopt));
    ck("init: a nested declaration of a function-scope name keeps it whole", whole("shadow", "  if (ts_truthy(v1)) {\n    tsv v2 = v1;\n    F.s1 = v2;\n  }\n", &iopt));
    ck("init: a handler's setjmp keeps it whole", whole("jmp", "  if (ts_setjmp(0) == 0) { v1 = v2; }\n", &iopt));
    ck("init: the frame named without a field keeps it whole", whole("frame", "  ts_frame_restore(&F);\n", &iopt));
    ck("init: TSAOT_UNIT_SPLIT_INIT=0 keeps it whole", whole("off", "", &Options { split_init: false, ..iopt }));
    for t in ["base", "edit9", "edit1", "create", "bad", "init"] { let _ = std::fs::remove_dir_all(dir(t)); }
    println!("[c_units] all checks passed");
}
