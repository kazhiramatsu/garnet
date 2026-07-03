mod escape_ir; mod call_graph; mod interproc; mod codegen;
use escape_ir::*;
use codegen::{decide, AllocStrategy};

fn meta(site: u32, m: Multiplicity, det: bool, k: AllocKind) -> SiteMeta {
    SiteMeta { site: SiteId(site), multiplicity: m, layout_determinable: det, kind: k }
}
fn prog(metas: Vec<SiteMeta>) -> Program {
    Program { version:1, strict_type_optimizations: Default::default(), types:vec![], fields:vec![], signatures:vec![], globals:vec![],
        scopes:vec![], bindings:vec![], functions:vec![], exports:vec![], site_meta: metas, classes: vec![], object_proto_methods: vec![], array_proto_methods: vec![], promise_proto_methods: vec![], map_proto_methods: vec![], set_proto_methods: vec![], headers_proto_methods: vec![], function_proto_methods: vec![], string_proto_methods: vec![], regexp_proto_methods: vec![], number_proto_methods: vec![], boolean_proto_methods: vec![], well_known_symbols: vec![] }
}
fn res(pairs: &[(u32, EscapeState)]) -> EscapeResult {
    EscapeResult { version:1, sites: pairs.iter().map(|(s,st)| SiteEscape{site:SiteId(*s), state:*st}).collect() }
}
fn ck(name:&str, got:AllocStrategy, want:AllocStrategy){
    println!("[{}] {:?} (want {:?}) {}", name, got, want, if got==want {"PASS"} else {"*** FAIL ***"});
    assert!(got==want, "{}", name);
}

fn main() {
    use Multiplicity::*; use AllocKind::*; use EscapeState::*; use AllocStrategy::*;
    let p = prog(vec![
        meta(100, Once, true,  Object),   // no-escape + det + once -> Stack
        meta(101, Many, true,  Object),   // no-escape + det + many -> Stack (per-iteration C scope)
        meta(102, Once, false, Object),   // no-escape + !det      -> FrameArena
        meta(103, Once, true,  Object),   // arg-escape             -> CallerArena
        meta(104, Once, true,  Object),   // global-escape          -> Heap
        meta(105, Many, true,  Closure),  // no-escape closure loop, det -> Stack (per-iteration)
        // site 106 deliberately has NO meta -> conservative
    ]);
    let r = res(&[
        (100, NoEscape), (101, NoEscape), (102, NoEscape),
        (103, ArgEscape), (104, GlobalEscape), (105, NoEscape),
        (106, NoEscape),
    ]);
    let d = decide(&p, &r);
    let by = |s:u32| d.iter().find(|x| x.site==SiteId(s)).unwrap().strategy;

    ck("stack", by(100), Stack);
    ck("loop-stack (det, per-iteration C scope)", by(101), Stack);
    ck("nondet-arena", by(102), FrameArena);
    ck("arg-caller", by(103), CallerArena);
    ck("global-heap", by(104), Heap);
    ck("closure-loop-stack (det)", by(105), Stack);
    ck("no-meta-conservative", by(106), FrameArena); // missing meta => not once/det => arena (sound)

    println!("\nAll codegen decision scenarios passed.");
}
