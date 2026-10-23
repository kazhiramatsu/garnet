mod escape_ir;
mod escape_analysis;
use escape_ir::*;
use escape_analysis::analyze;

// ---- tiny builders (analyzer only reads functions, so program tables stay empty) ----
fn refl(n: u32) -> Local { Local { id: LocalId(n), type_id: TypeId(0), ref_kind: RefKind::Reference, binding: None, name: None, nullable_numeric: false, ty_kind: None } }
fn func(id: u32, params: Vec<u32>, nlocals: u32, body: Vec<Inst>) -> Function {
    Function {
        id: FunctionId(id), name: None,
        params: params.into_iter().map(LocalId).collect(),
        ret: TypeId(0),
        locals: (0..nlocals).map(refl).collect(),
        body, is_exported: false, param_classes: Default::default(), rest_param: None, is_async: false, is_generator: false, capture_count: 0, takes_this: false, arity: 0, has_prototype: false,
    }
}
fn prog(fns: Vec<Function>) -> Program {
    Program { version: 1, strict_type_optimizations: Default::default(), closed_receivers: Default::default(), types: vec![], fields: vec![], signatures: vec![], globals: vec![],
        scopes: vec![], bindings: vec![], functions: fns, modules: vec![], function_modules: Default::default(), exports: vec![], site_meta: vec![], classes: vec![], object_proto_methods: vec![], array_proto_methods: vec![], promise_proto_methods: vec![], map_proto_methods: vec![], set_proto_methods: vec![], weak_map_proto_methods: vec![], weak_set_proto_methods: vec![], headers_proto_methods: vec![], function_proto_methods: vec![], string_proto_methods: vec![], regexp_proto_methods: vec![], number_proto_methods: vec![], boolean_proto_methods: vec![], well_known_symbols: vec![] }
}
fn state_of(r: &EscapeResult, site: u32) -> EscapeState {
    r.sites.iter().find(|s| s.site == SiteId(site)).expect("site").state
}
fn check(name: &str, got: EscapeState, want: EscapeState) {
    let ok = got == want;
    println!("[{}] site -> {:?} (want {:?}) {}", name, got, want, if ok {"PASS"} else {"*** FAIL ***"});
    assert!(ok, "{} failed", name);
}

fn main() {
    use Inst::*;
    use EscapeState::*;

    // S1: closure capturing a cell, all returned via array -> ArgEscape for array, closure, cell.
    // l0=fns(array,site0), l1=cell(site1), l2=clo(site2 captures b0 via l1)
    let f = func(0, vec![], 3, vec![
        AllocArray { dst: LocalId(0), elem_type: TypeId(0), site: SiteId(0) },
        AllocObject { dst: LocalId(1), type_id: TypeId(0), site: SiteId(1), class_id: None, proto: None },
        AllocClosure { dst: LocalId(2), func: FunctionId(9),
            captures: vec![Capture { binding: BindingId(0), cell: LocalId(1) }], site: SiteId(2) },
        StoreElem { arr: LocalId(0), src: LocalId(2) },
        Return { src: Some(LocalId(0)) },
    ]);
    let r = analyze(&prog(vec![f]));
    check("S1 array", state_of(&r,0), ArgEscape);
    check("S1 closure", state_of(&r,2), ArgEscape);
    check("S1 captured-cell", state_of(&r,1), ArgEscape);

    // S2: same but NOT returned -> all NoEscape.
    let f = func(0, vec![], 3, vec![
        AllocArray { dst: LocalId(0), elem_type: TypeId(0), site: SiteId(0) },
        AllocObject { dst: LocalId(1), type_id: TypeId(0), site: SiteId(1), class_id: None, proto: None },
        AllocClosure { dst: LocalId(2), func: FunctionId(9),
            captures: vec![Capture { binding: BindingId(0), cell: LocalId(1) }], site: SiteId(2) },
        StoreElem { arr: LocalId(0), src: LocalId(2) },
        Return { src: None },
    ]);
    let r = analyze(&prog(vec![f]));
    check("S2 array", state_of(&r,0), NoEscape);
    check("S2 closure", state_of(&r,2), NoEscape);
    check("S2 captured-cell", state_of(&r,1), NoEscape);

    // S3: stored to global -> GlobalEscape.
    let f = func(0, vec![], 1, vec![
        AllocObject { dst: LocalId(0), type_id: TypeId(0), site: SiteId(0), class_id: None, proto: None },
        StoreGlobal { gref: GlobalId(0), src: LocalId(0) },
    ]);
    let r = analyze(&prog(vec![f]));
    check("S3 global", state_of(&r,0), GlobalEscape);

    // S4: passed as arg to unknown call -> GlobalEscape (conservative P1).
    let f = func(0, vec![], 1, vec![
        AllocObject { dst: LocalId(0), type_id: TypeId(0), site: SiteId(0), class_id: None, proto: None },
        Call { dst: None, callee: CalleeRef::Unknown, recv: None, args: vec![LocalId(0)], resolved_sig: None },
    ]);
    let r = analyze(&prog(vec![f]));
    check("S4 unknown-call-arg", state_of(&r,0), GlobalEscape);

    // S5: outer.f = inner; return outer -> both ArgEscape (containment).
    let f = func(0, vec![], 2, vec![
        AllocObject { dst: LocalId(0), type_id: TypeId(0), site: SiteId(0), class_id: None, proto: None }, // outer
        AllocObject { dst: LocalId(1), type_id: TypeId(0), site: SiteId(1), class_id: None, proto: None }, // inner
        StoreField { obj: LocalId(0), field: FieldId(0), src: LocalId(1), slots: 0, cls: 0 },
        Return { src: Some(LocalId(0)) },
    ]);
    let r = analyze(&prog(vec![f]));
    check("S5 outer", state_of(&r,0), ArgEscape);
    check("S5 inner (via field)", state_of(&r,1), ArgEscape);

    // S6: outer.f = inner; return INNER only -> inner ArgEscape, outer NoEscape.
    let f = func(0, vec![], 2, vec![
        AllocObject { dst: LocalId(0), type_id: TypeId(0), site: SiteId(0), class_id: None, proto: None }, // outer
        AllocObject { dst: LocalId(1), type_id: TypeId(0), site: SiteId(1), class_id: None, proto: None }, // inner
        StoreField { obj: LocalId(0), field: FieldId(0), src: LocalId(1), slots: 0, cls: 0 },
        Return { src: Some(LocalId(1)) },
    ]);
    let r = analyze(&prog(vec![f]));
    check("S6 outer (container stays)", state_of(&r,0), NoEscape);
    check("S6 inner (returned)", state_of(&r,1), ArgEscape);

    // S7: store our alloc into a reference PARAMETER's field -> ArgEscape.
    // param l0 (ref), l1 = alloc(site0); l0.f = l1
    let f = func(0, vec![0], 2, vec![
        AllocObject { dst: LocalId(1), type_id: TypeId(0), site: SiteId(0), class_id: None, proto: None },
        StoreField { obj: LocalId(0), field: FieldId(0), src: LocalId(1), slots: 0, cls: 0 },
    ]);
    let r = analyze(&prog(vec![f]));
    check("S7 stored-into-param", state_of(&r,0), ArgEscape);

    // S8: load from a captured cell then escape it (closure escapes, cell escapes,
    // and a value placed into the cell also escapes). cell.value = x; clo captures cell; return clo.
    // l0 = x (site0), l1 = cell (site1), l2 = clo (site2)
    let f = func(0, vec![], 3, vec![
        AllocObject { dst: LocalId(0), type_id: TypeId(0), site: SiteId(0), class_id: None, proto: None }, // x
        AllocObject { dst: LocalId(1), type_id: TypeId(0), site: SiteId(1), class_id: None, proto: None }, // cell
        StoreField { obj: LocalId(1), field: FieldId(0), src: LocalId(0), slots: 0, cls: 0 },   // cell.value = x
        AllocClosure { dst: LocalId(2), func: FunctionId(9),
            captures: vec![Capture { binding: BindingId(0), cell: LocalId(1) }], site: SiteId(2) },
        Return { src: Some(LocalId(2)) },
    ]);
    let r = analyze(&prog(vec![f]));
    check("S8 closure", state_of(&r,2), ArgEscape);
    check("S8 cell", state_of(&r,1), ArgEscape);
    check("S8 value-in-cell", state_of(&r,0), ArgEscape);

    println!("\nAll P1 scenarios passed.");
}
