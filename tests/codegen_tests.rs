mod escape_ir; mod call_graph; mod interproc; mod codegen;
use escape_ir::*;
use codegen::{decide, decide_with_pretenure, AllocStrategy};

fn meta(site: u32, m: Multiplicity, det: bool, k: AllocKind) -> SiteMeta {
    SiteMeta { site: SiteId(site), multiplicity: m, layout_determinable: det, kind: k }
}
fn prog(metas: Vec<SiteMeta>) -> Program {
    Program { version:1, strict_type_optimizations: Default::default(), closed_receivers: Default::default(), types:vec![], fields:vec![], signatures:vec![], globals:vec![],
        scopes:vec![], bindings:vec![], functions:vec![], modules: vec![], function_modules: Default::default(), exports:vec![], site_meta: metas, classes: vec![], object_proto_methods: vec![], array_proto_methods: vec![], promise_proto_methods: vec![], map_proto_methods: vec![], set_proto_methods: vec![], weak_map_proto_methods: vec![], weak_set_proto_methods: vec![], headers_proto_methods: vec![], function_proto_methods: vec![], string_proto_methods: vec![], regexp_proto_methods: vec![], number_proto_methods: vec![], boolean_proto_methods: vec![], well_known_symbols: vec![] }
}
fn res(pairs: &[(u32, EscapeState)]) -> EscapeResult {
    EscapeResult { version:1, sites: pairs.iter().map(|(s,st)| SiteEscape{site:SiteId(*s), state:*st}).collect(), contained_sites: Default::default(), pretenure_sites: Default::default() }
}
fn ck(name:&str, got:AllocStrategy, want:AllocStrategy){
    println!("[{}] {:?} (want {:?}) {}", name, got, want, if got==want {"PASS"} else {"*** FAIL ***"});
    assert!(got==want, "{}", name);
}
fn alloc_fn(id:u32, name:&str, sites:&[u32]) -> Function {
    Function {
        id: FunctionId(id), name: Some(name.to_string()), params: vec![], ret: TypeId(0),
        locals: sites.iter().enumerate().map(|(i, _)| Local {
            id: LocalId(i as u32), type_id: TypeId(0), ref_kind: RefKind::Reference,
            binding: None, name: None, nullable_numeric: false, ty_kind: None,
        }).collect(),
        body: sites.iter().enumerate().map(|(i, site)| Inst::AllocObject {
            dst: LocalId(i as u32), type_id: TypeId(0), site: SiteId(*site),
            class_id: None, proto: None,
        }).collect(),
        is_exported: false, param_classes: Default::default(), rest_param: None,
        is_async: false, is_generator: false, capture_count: 0, takes_this: false, arity: 0,
        has_prototype: false, debug_name: None, src: None,
    }
}

fn main() {
    use Multiplicity::*; use AllocKind::*; use EscapeState::*; use AllocStrategy::*;
    let p = prog(vec![
        meta(100, Once, true,  Object),   // no-escape + det + once -> Stack
        meta(101, Many, true,  Object),   // no-escape + det + many -> FrameArena (a per-iteration
                                          // C slot is unsound when a reference outlives the
                                          // iteration; TSAOT_LOOP_STACK=1 restores Stack)
        meta(102, Once, false, Object),   // no-escape + !det      -> FrameArena
        meta(103, Once, true,  Object),   // arg-escape             -> CallerArena
        meta(104, Once, true,  Object),   // global-escape          -> Heap
        meta(105, Many, true,  Closure),  // no-escape closure loop, det -> FrameArena (same rule)
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
    ck("loop-body no-escape (det): frame arena, not a per-iteration slot", by(101), FrameArena);
    ck("nondet-arena", by(102), FrameArena);
    ck("arg-caller", by(103), CallerArena);
    ck("global-heap", by(104), Heap);
    ck("closure-loop no-escape (det): frame arena", by(105), FrameArena);
    ck("no-meta-conservative", by(106), FrameArena); // missing meta => not once/det => arena (sound)

    // Pretenuring is deliberately narrower than GlobalEscape: only a
    // single-shot site owned by the exactly-once module initializer qualifies.
    // Loop/many sites and ordinary functions stay in the nursery-backed heap.
    let mut p = prog(vec![
        meta(107, Once, true, Object),
        meta(108, Many, true, Object),
        meta(109, Once, true, Object),
    ]);
    p.functions = vec![
        alloc_fn(0, "__module_init", &[107, 108]),
        alloc_fn(1, "called_many_times", &[109]),
    ];
    let r = res(&[
        (107, GlobalEscape),
        (108, GlobalEscape),
        (109, GlobalEscape),
    ]);
    let mut r = r;
    r.pretenure_sites.insert(107);
    let d = decide_with_pretenure(&p, &r, true);
    let by = |s:u32| d.iter().find(|x| x.site==SiteId(s)).unwrap().strategy;
    ck("module-once-pretenured", by(107), PretenuredHeap);
    ck("module-loop-stays-young", by(108), Heap);
    ck("ordinary-function-stays-young", by(109), Heap);
    let disabled = decide_with_pretenure(&p, &r, false);
    let disabled_by = |s:u32| disabled.iter().find(|x| x.site==SiteId(s)).unwrap().strategy;
    ck("pretenure-kill-switch", disabled_by(107), Heap);

    println!("\nAll codegen decision scenarios passed.");
}
