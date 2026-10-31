//! Closure-focused unit tests for the analyzer (hand-built IR).
//! Build as the crate `main.rs` alongside escape_ir/call_graph/interproc.
mod escape_ir;
mod call_graph;
mod interproc;
use escape_ir::*;
use interproc::analyze_program;

fn refl(n: u32) -> Local { Local { id: LocalId(n), type_id: TypeId(0), ref_kind: RefKind::Reference, binding: None, name: None, nullable_numeric: false, ty_kind: None } }
fn func(id: u32, params: Vec<u32>, nlocals: u32, exported: bool, body: Vec<Inst>) -> Function {
    Function { id: FunctionId(id), name: None, params: params.into_iter().map(LocalId).collect(),
        ret: TypeId(0), locals: (0..nlocals).map(refl).collect(), body, is_exported: exported, param_classes: Default::default(), rest_param: None, is_async: false, is_generator: false, capture_count: 0, takes_this: false, arity: 0, has_prototype: false, debug_name: None, src: None }
}
fn prog(fns: Vec<Function>) -> Program {
    Program { version: 1, strict_type_optimizations: Default::default(), closed_receivers: Default::default(), types: vec![], fields: vec![], signatures: vec![], globals: vec![],
        scopes: vec![], bindings: vec![], functions: fns, modules: vec![], function_modules: Default::default(), exports: vec![], site_meta: vec![], classes: vec![], object_proto_methods: vec![], array_proto_methods: vec![], promise_proto_methods: vec![], map_proto_methods: vec![], set_proto_methods: vec![], weak_map_proto_methods: vec![], weak_set_proto_methods: vec![], headers_proto_methods: vec![], function_proto_methods: vec![], string_proto_methods: vec![], regexp_proto_methods: vec![], number_proto_methods: vec![], boolean_proto_methods: vec![], well_known_symbols: vec![] }
}
fn st(r: &EscapeResult, site: u32) -> EscapeState {
    r.sites.iter().find(|s| s.site == SiteId(site)).map(|s| s.state).unwrap_or_else(|| panic!("site {} not found", site))
}
fn ck(name: &str, got: EscapeState, want: EscapeState) {
    println!("[{}] {:?} (want {:?}) {}", name, got, want, if got==want {"PASS"} else {"*** FAIL ***"});
    assert!(got==want, "{}", name);
}
const VALUE: u32 = 0;
fn cap(b: u32, cell: u32) -> Capture { Capture { binding: BindingId(b), cell: LocalId(cell) } }

fn main() {
    use Inst::*; use EscapeState::*;
    let arrow_trivial = || func(0, vec![0], 2, false, vec![ Return{src:None} ]);

    // C1: closure returned -> captured cell + contents ArgEscape.
    let f = func(1, vec![], 3, false, vec![
        AllocObject {dst:LocalId(0), type_id:TypeId(0), site:SiteId(100), class_id: None, proto: None },
        AllocObject {dst:LocalId(1), type_id:TypeId(0), site:SiteId(101), class_id: None, proto: None },
        StoreField{obj:LocalId(0), field:FieldId(VALUE), src:LocalId(1), slots: 0, cls: 0, sized: false, cands: vec![]},
        AllocClosure{dst:LocalId(2), func:FunctionId(0), captures:vec![cap(0,0)], site:SiteId(102)},
        Return{src:Some(LocalId(2))},
    ]);
    let r = analyze_program(&prog(vec![arrow_trivial(), f]));
    ck("C1 closure", st(&r,102), ArgEscape);
    ck("C1 cell", st(&r,100), ArgEscape);
    ck("C1 cell-contents", st(&r,101), ArgEscape);

    // C2: closure dropped -> NoEscape.
    let f = func(1, vec![], 3, false, vec![
        AllocObject {dst:LocalId(0), type_id:TypeId(0), site:SiteId(100), class_id: None, proto: None },
        AllocObject {dst:LocalId(1), type_id:TypeId(0), site:SiteId(101), class_id: None, proto: None },
        StoreField{obj:LocalId(0), field:FieldId(VALUE), src:LocalId(1), slots: 0, cls: 0, sized: false, cands: vec![]},
        AllocClosure{dst:LocalId(2), func:FunctionId(0), captures:vec![cap(0,0)], site:SiteId(102)},
        Return{src:None},
    ]);
    let r = analyze_program(&prog(vec![arrow_trivial(), f]));
    ck("C2 closure", st(&r,102), NoEscape);
    ck("C2 cell", st(&r,100), NoEscape);
    ck("C2 cell-contents", st(&r,101), NoEscape);

    // C3: closure body leaks captured value to global; box stays local.
    let arrow_leak = func(0, vec![0], 2, false, vec![
        LoadField{dst:LocalId(1), obj:LocalId(0), field:FieldId(VALUE), slots: 0, elem: 0, cls: 0, sized: false, cands: vec![]},
        StoreGlobal{gref:GlobalId(0), src:LocalId(1)},
    ]);
    let f = func(1, vec![], 3, false, vec![
        AllocObject {dst:LocalId(0), type_id:TypeId(0), site:SiteId(100), class_id: None, proto: None },
        AllocObject {dst:LocalId(1), type_id:TypeId(0), site:SiteId(101), class_id: None, proto: None },
        StoreField{obj:LocalId(0), field:FieldId(VALUE), src:LocalId(1), slots: 0, cls: 0, sized: false, cands: vec![]},
        AllocClosure{dst:LocalId(2), func:FunctionId(0), captures:vec![cap(0,0)], site:SiteId(102)},
        Return{src:None},
    ]);
    let r = analyze_program(&prog(vec![arrow_leak, f]));
    ck("C3 leaked-value", st(&r,101), GlobalEscape);
    ck("C3 box-stays-local", st(&r,100), NoEscape);
    ck("C3 closure-dropped", st(&r,102), NoEscape);

    // C4: loop-let style -- closures into a returned array.
    let f = func(1, vec![], 3, false, vec![
        AllocArray{dst:LocalId(0), elem_type:TypeId(0), site:SiteId(100)},
        AllocObject {dst:LocalId(1), type_id:TypeId(0), site:SiteId(101), class_id: None, proto: None },
        AllocClosure{dst:LocalId(2), func:FunctionId(0), captures:vec![cap(0,1)], site:SiteId(102)},
        StoreElem{arr:LocalId(0), src:LocalId(2)},
        Return{src:Some(LocalId(0))},
    ]);
    let r = analyze_program(&prog(vec![arrow_trivial(), f]));
    ck("C4 array", st(&r,100), ArgEscape);
    ck("C4 closure", st(&r,102), ArgEscape);
    ck("C4 cell_i", st(&r,101), ArgEscape);

    // C5: closure stored to global -> captured cell GlobalEscape.
    let f = func(1, vec![], 3, false, vec![
        AllocObject {dst:LocalId(0), type_id:TypeId(0), site:SiteId(100), class_id: None, proto: None },
        AllocClosure{dst:LocalId(2), func:FunctionId(0), captures:vec![cap(0,0)], site:SiteId(102)},
        StoreGlobal{gref:GlobalId(0), src:LocalId(2)},
    ]);
    let r = analyze_program(&prog(vec![arrow_trivial(), f]));
    ck("C5 closure", st(&r,102), GlobalEscape);
    ck("C5 cell", st(&r,100), GlobalEscape);

    println!("\nAll closure analyzer scenarios passed.");
}
