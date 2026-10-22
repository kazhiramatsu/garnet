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

fn opts() -> Options { Options { inline_lines: 5, chunk_lines: 8, bins: 4, cold_lines: 30 } }

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
    let u4 = split(&c, &m, &fm4, &d4, &Options { inline_lines: 60, chunk_lines: 20000, bins: 16, cold_lines: 10000 }).expect("split create");
    let cold4: Vec<&str> = u4.iter().filter(|u| u.cold).map(|u| u.file.as_str()).collect();
    ck("cold: a 2000-line creator, not a lowercase name", cold4 == vec!["cold_fn_1_createScanner.c"]);
    // loud failures
    let d5 = dir("bad");
    ck("an unclassified item stops the split", split("#include \"ts_rt.h\"\nfoo bar baz;\nint main(void) { return 0; }\n", &m, &fm, &d5, &opts()).is_err());
    ck("a function-pointer object stops the split", split("#include \"ts_rt.h\"\nstatic tsv (*g_fp)(tsv*, int) = 0;\nint main(void) { return 0; }\n", &m, &fm, &d5, &opts()).is_err());
    for t in ["base", "edit9", "edit1", "create", "bad"] { let _ = std::fs::remove_dir_all(dir(t)); }
    println!("[c_units] all checks passed");
}
