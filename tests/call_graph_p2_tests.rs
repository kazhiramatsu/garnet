mod escape_ir;
mod escape_analysis;
mod call_graph;
use escape_ir::*;
use call_graph::{build_call_graph, CallGraph};

// Build a function whose body is just calls to the given callees (Direct),
// plus optionally an Unknown call.
fn fn_calling(id: u32, directs: &[u32], unknown: bool) -> Function {
    let mut body: Vec<Inst> = directs.iter().map(|&g| Inst::Call {
        dst: None, callee: CalleeRef::Direct { func: FunctionId(g) }, recv: None, args: vec![], resolved_sig: None,
    }).collect();
    if unknown {
        body.push(Inst::Call { dst: None, callee: CalleeRef::Unknown, recv: None, args: vec![], resolved_sig: None });
    }
    Function { id: FunctionId(id), name: None, params: vec![], ret: TypeId(0), locals: vec![], body, is_exported: false, param_classes: Default::default(), rest_param: None, is_async: false, is_generator: false, capture_count: 0, takes_this: false, arity: 0, has_prototype: false, debug_name: None, src: None }
}
fn prog(fns: Vec<Function>) -> Program {
    Program { version: 1, strict_type_optimizations: Default::default(), closed_receivers: Default::default(), types: vec![], fields: vec![], signatures: vec![], globals: vec![],
        scopes: vec![], bindings: vec![], functions: fns, modules: vec![], function_modules: Default::default(), exports: vec![], site_meta: vec![], classes: vec![], object_proto_methods: vec![], array_proto_methods: vec![], promise_proto_methods: vec![], map_proto_methods: vec![], set_proto_methods: vec![], weak_map_proto_methods: vec![], weak_set_proto_methods: vec![], headers_proto_methods: vec![], function_proto_methods: vec![], string_proto_methods: vec![], regexp_proto_methods: vec![], number_proto_methods: vec![], boolean_proto_methods: vec![], well_known_symbols: vec![] }
}
// position of the SCC that contains function f, in bottom-up order
fn pos_of(cg: &CallGraph, f: u32) -> usize {
    cg.order.iter().position(|scc| scc.contains(&FunctionId(f))).unwrap()
}
fn scc_of(cg: &CallGraph, f: u32) -> Vec<u32> {
    let mut v: Vec<u32> = cg.order.iter().find(|s| s.contains(&FunctionId(f))).unwrap().iter().map(|x| x.0).collect();
    v.sort(); v
}
fn ck(name: &str, cond: bool) { println!("[{}] {}", name, if cond {"PASS"} else {"*** FAIL ***"}); assert!(cond, "{}", name); }

fn main() {
    // T1: linear  0 -> 1 -> 2.  bottom-up order must put 2 before 1 before 0.
    let cg = build_call_graph(&prog(vec![
        fn_calling(0, &[1], false),
        fn_calling(1, &[2], false),
        fn_calling(2, &[], false),
    ]));
    ck("T1 order 2<1", pos_of(&cg,2) < pos_of(&cg,1));
    ck("T1 order 1<0", pos_of(&cg,1) < pos_of(&cg,0));
    ck("T1 singletons", cg.order.len() == 3);
    ck("T1 not cyclic", !cg.is_cyclic(&[FunctionId(0)]));

    // T2: mutual recursion 0<->1, and 0 -> 2.
    let cg = build_call_graph(&prog(vec![
        fn_calling(0, &[1,2], false),
        fn_calling(1, &[0], false),
        fn_calling(2, &[], false),
    ]));
    ck("T2 {0,1} same SCC", scc_of(&cg,0) == vec![0,1] && scc_of(&cg,1) == vec![0,1]);
    ck("T2 SCC{0,1} cyclic", cg.is_cyclic(&[FunctionId(0), FunctionId(1)]));
    ck("T2 2 before {0,1}", pos_of(&cg,2) < pos_of(&cg,0));

    // T3: self recursion 0 -> 0.
    let cg = build_call_graph(&prog(vec![ fn_calling(0, &[0], false) ]));
    ck("T3 self_recursive", cg.self_recursive[0]);
    ck("T3 size-1 cyclic", cg.is_cyclic(&[FunctionId(0)]));

    // T4: unknown call recorded.
    let cg = build_call_graph(&prog(vec![ fn_calling(0, &[], true) ]));
    ck("T4 has_unknown", cg.has_unknown[0]);
    ck("T4 not self_recursive", !cg.self_recursive[0]);

    // T5: diamond 0->1, 0->2, 1->3, 2->3. 3 first, 0 last.
    let cg = build_call_graph(&prog(vec![
        fn_calling(0, &[1,2], false),
        fn_calling(1, &[3], false),
        fn_calling(2, &[3], false),
        fn_calling(3, &[], false),
    ]));
    ck("T5 3 before 1", pos_of(&cg,3) < pos_of(&cg,1));
    ck("T5 3 before 2", pos_of(&cg,3) < pos_of(&cg,2));
    ck("T5 1 before 0", pos_of(&cg,1) < pos_of(&cg,0));
    ck("T5 2 before 0", pos_of(&cg,2) < pos_of(&cg,0));

    println!("\nAll P2 call-graph scenarios passed.");
}
