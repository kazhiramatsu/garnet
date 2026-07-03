mod escape_ir;
mod escape_analysis;
mod call_graph;
mod interproc;
use escape_ir::*;
use interproc::analyze_program;

fn refl(n: u32) -> Local { Local { id: LocalId(n), type_id: TypeId(0), ref_kind: RefKind::Reference, binding: None, name: None, nullable_numeric: false } }
fn func(id: u32, params: Vec<u32>, nlocals: u32, exported: bool, body: Vec<Inst>) -> Function {
    Function { id: FunctionId(id), name: None, params: params.into_iter().map(LocalId).collect(),
        ret: TypeId(0), locals: (0..nlocals).map(refl).collect(), body, is_exported: exported, param_classes: Default::default(), rest_param: None, is_async: false, is_generator: false, takes_this: false, arity: 0, has_prototype: false }
}
fn prog(fns: Vec<Function>) -> Program {
    Program { version: 1, strict_type_optimizations: Default::default(), types: vec![], fields: vec![], signatures: vec![], globals: vec![],
        scopes: vec![], bindings: vec![], functions: fns, exports: vec![], site_meta: vec![], classes: vec![], object_proto_methods: vec![], array_proto_methods: vec![], promise_proto_methods: vec![], map_proto_methods: vec![], set_proto_methods: vec![], headers_proto_methods: vec![], function_proto_methods: vec![], string_proto_methods: vec![], regexp_proto_methods: vec![], number_proto_methods: vec![], boolean_proto_methods: vec![], well_known_symbols: vec![] }
}
fn st(r: &EscapeResult, site: u32) -> EscapeState {
    r.sites.iter().find(|s| s.site == SiteId(site)).expect("site").state
}
fn ck(name: &str, got: EscapeState, want: EscapeState) {
    println!("[{}] {:?} (want {:?}) {}", name, got, want, if got==want {"PASS"} else {"*** FAIL ***"});
    assert!(got==want, "{}", name);
}
fn dcall(dst: Option<u32>, f: u32, args: Vec<u32>) -> Inst {
    Inst::Call { dst: dst.map(LocalId), callee: CalleeRef::Direct{func: FunctionId(f)}, recv: None,
        args: args.into_iter().map(LocalId).collect(), resolved_sig: None }
}

fn main() {
    use Inst::*; use EscapeState::*;

    // id(x){return x}  (fn 0).  Caller (fn1): o=alloc; y=id(o); drop -> NoEscape.
    let id = func(0, vec![0], 1, false, vec![Return{src:Some(LocalId(0))}]);
    let g  = func(1, vec![], 2, false, vec![
        AllocObject {dst:LocalId(0), type_id:TypeId(0), site:SiteId(100), class_id: None, proto: None },
        dcall(Some(1), 0, vec![0]),
        Return{src:None},
    ]);
    let r = analyze_program(&prog(vec![id.clone(), g]));
    ck("id+drop", st(&r,100), NoEscape);

    // id, but result stored to global -> GlobalEscape.
    let g = func(1, vec![], 2, false, vec![
        AllocObject {dst:LocalId(0), type_id:TypeId(0), site:SiteId(100), class_id: None, proto: None },
        dcall(Some(1), 0, vec![0]),
        StoreGlobal{gref:GlobalId(0), src:LocalId(1)},
    ]);
    let r = analyze_program(&prog(vec![id.clone(), g]));
    ck("id+global", st(&r,100), GlobalEscape);

    // leak(x){ global = x }  (fn0). Caller: o=alloc; leak(o) -> GlobalEscape.
    let leak = func(0, vec![0], 1, false, vec![StoreGlobal{gref:GlobalId(0), src:LocalId(0)}]);
    let g = func(1, vec![], 1, false, vec![
        AllocObject {dst:LocalId(0), type_id:TypeId(0), site:SiteId(100), class_id: None, proto: None },
        dcall(None, 0, vec![0]),
    ]);
    let r = analyze_program(&prog(vec![leak, g]));
    ck("leak-arg", st(&r,100), GlobalEscape);

    // store(a,b){ a.f = b } (fn0). Caller: a=alloc100; b=alloc101; store(a,b); return a.
    let store = func(0, vec![0,1], 2, false, vec![StoreField{obj:LocalId(0), field:FieldId(0), src:LocalId(1)}]);
    let g = func(1, vec![], 2, false, vec![
        AllocObject {dst:LocalId(0), type_id:TypeId(0), site:SiteId(100), class_id: None, proto: None }, // a
        AllocObject {dst:LocalId(1), type_id:TypeId(0), site:SiteId(101), class_id: None, proto: None }, // b
        dcall(None, 0, vec![0,1]),
        Return{src:Some(LocalId(0))},
    ]);
    let r = analyze_program(&prog(vec![store.clone(), g]));
    ck("store return-a: a", st(&r,100), ArgEscape);
    ck("store return-a: b via a.f", st(&r,101), ArgEscape);

    // same store, but DROP a -> both NoEscape.
    let g = func(1, vec![], 2, false, vec![
        AllocObject {dst:LocalId(0), type_id:TypeId(0), site:SiteId(100), class_id: None, proto: None },
        AllocObject {dst:LocalId(1), type_id:TypeId(0), site:SiteId(101), class_id: None, proto: None },
        dcall(None, 0, vec![0,1]),
        Return{src:None},
    ]);
    let r = analyze_program(&prog(vec![store, g]));
    ck("store drop: a", st(&r,100), NoEscape);
    ck("store drop: b", st(&r,101), NoEscape);

    // recursion: rec(x){ rec(x); return x } (fn0, self-recursive). Caller drop -> NoEscape.
    let rec = func(0, vec![0], 2, false, vec![
        dcall(Some(1), 0, vec![0]),
        Return{src:Some(LocalId(0))},
    ]);
    let g = func(1, vec![], 2, false, vec![
        AllocObject {dst:LocalId(0), type_id:TypeId(0), site:SiteId(100), class_id: None, proto: None },
        dcall(Some(1), 0, vec![0]),
        Return{src:None},
    ]);
    let r = analyze_program(&prog(vec![rec.clone(), g]));
    ck("recursion+drop", st(&r,100), NoEscape);

    // recursion, result leaked -> GlobalEscape.
    let g = func(1, vec![], 2, false, vec![
        AllocObject {dst:LocalId(0), type_id:TypeId(0), site:SiteId(100), class_id: None, proto: None },
        dcall(Some(1), 0, vec![0]),
        StoreGlobal{gref:GlobalId(0), src:LocalId(1)},
    ]);
    let r = analyze_program(&prog(vec![rec, g]));
    ck("recursion+leak", st(&r,100), GlobalEscape);

    // unknown call still conservative.
    let g = func(0, vec![], 1, false, vec![
        AllocObject {dst:LocalId(0), type_id:TypeId(0), site:SiteId(100), class_id: None, proto: None },
        Call{dst:None, callee:CalleeRef::Unknown, recv:None, args:vec![LocalId(0)], resolved_sig:None},
    ]);
    let r = analyze_program(&prog(vec![g]));
    ck("unknown-arg", st(&r,100), GlobalEscape);

    // exported function returning a fresh alloc -> GlobalEscape (external caller).
    let ex = func(0, vec![], 1, true, vec![
        AllocObject {dst:LocalId(0), type_id:TypeId(0), site:SiteId(100), class_id: None, proto: None },
        Return{src:Some(LocalId(0))},
    ]);
    let r = analyze_program(&prog(vec![ex]));
    ck("exported-return", st(&r,100), GlobalEscape);

    // non-exported function returning a fresh alloc, no caller -> ArgEscape (returned).
    let f = func(0, vec![], 1, false, vec![
        AllocObject {dst:LocalId(0), type_id:TypeId(0), site:SiteId(100), class_id: None, proto: None },
        Return{src:Some(LocalId(0))},
    ]);
    let r = analyze_program(&prog(vec![f]));
    ck("nonexported-return", st(&r,100), ArgEscape);

    println!("\nAll P3 interprocedural scenarios passed.");
}
