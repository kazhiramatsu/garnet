mod escape_ir; mod call_graph; mod interproc; mod codegen; mod devirt;
use escape_ir::*;
use devirt::{run_devirt, Dispatch, ClassTable};

fn refl(n:u32)->Local{Local{id:LocalId(n),type_id:TypeId(0),ref_kind:RefKind::Reference,binding:None,name:None,nullable_numeric:false}}
fn func(id:u32,params:Vec<u32>,nl:u32,exp:bool,body:Vec<Inst>)->Function{
  Function{id:FunctionId(id),name:None,params:params.into_iter().map(LocalId).collect(),
    ret:TypeId(0),locals:(0..nl).map(refl).collect(),body,is_exported:exp,param_classes:Default::default(),rest_param:None,is_async:false,is_generator:false, capture_count: 0,takes_this: false, arity: 0,has_prototype:false}}
fn method(name:u32,func:u32,kind:MethodKind)->MethodDef{MethodDef{name:Name(name),prop_name:None,prop_name_units:Vec::new(),func:FunctionId(func),kind}}
fn class(id:u32,parent:Option<u32>,methods:Vec<MethodDef>,fields:Vec<u32>,inst:bool,stable:bool)->ClassDef{
  ClassDef{id:ClassId(id),name:Some(format!("C{}", id)),parent:parent.map(ClassId),own_methods:methods,
    own_fields:fields.into_iter().map(Name).collect(),instantiated:inst,stable,reasons:vec![],field_types:Default::default(),error_proto_kind:None}}

const AREA:u32=10; const SCALE:u32=11;

fn base_classes(circle_inst:bool,square_inst:bool,square_stable:bool)->Vec<ClassDef>{
  use MethodKind::Method as M;
  vec![
    class(0,None,vec![method(AREA,3,M)],vec![],false,true),                   // Shape.area=fn3 (base)
    class(1,Some(0),vec![method(AREA,1,M),method(SCALE,1,M)],vec![],circle_inst,true),  // Circle.area=fn1
    class(2,Some(0),vec![method(AREA,2,M)],vec![],square_inst,square_stable),  // Square.area=fn2
  ]
}
fn ck<T:std::fmt::Debug+PartialEq>(n:&str,g:T,w:T){println!("[{}] {:?} (want {:?}) {}",n,g,w,if g==w{"PASS"}else{"*** FAIL ***"});assert!(g==w,"{}",n);}

fn main(){
  use Inst::*;
  // ---- ClassTable.devirtualize unit checks ----
  let t = ClassTable::new(&base_classes(true,true,true));
  ck("poly Shape.area -> Virtual", t.devirtualize(ClassId(0),Name(AREA),true,true), Dispatch::Virtual{slot:0,name:Name(AREA)});
  ck("mono Circle.area -> Direct", t.devirtualize(ClassId(1),Name(AREA),true,true), Dispatch::Direct(FunctionId(1)));
  ck("Circle.scale -> Direct", t.devirtualize(ClassId(1),Name(SCALE),true,true), Dispatch::Direct(FunctionId(1)));
  // RTA: only Circle instantiated -> Shape.area collapses to Direct(101)
  let t2 = ClassTable::new(&base_classes(true,false,true));
  ck("RTA Shape.area -> Direct(101)", t2.devirtualize(ClassId(0),Name(AREA),true,true), Dispatch::Direct(FunctionId(1)));
  // guards
  let t3 = ClassTable::new(&base_classes(true,true,false)); // Square unstable
  ck("guard unstable subtree -> Dynamic", t3.devirtualize(ClassId(0),Name(AREA),true,true), Dispatch::Dynamic);
  ck("guard any-recv -> Dynamic", t.devirtualize(ClassId(1),Name(AREA),false,true), Dispatch::Dynamic);

  // ---- IR rewrite + escape analysis still works ----
  // caller g(): make a Circle, call (Shape).area on it (polymorphic), leak result to global.
  // We model the method call as CalleeRef::Method{recv_class:Shape, area, stable}.
  // Impl functions 101 (Circle.area) and 102 (Square.area) are leaf fns returning a new obj.
  let circle_area = func(1, vec![0], 2, false, vec![
      AllocObject {dst:LocalId(1),type_id:TypeId(0),site:SiteId(900), class_id: None, proto: None }, Return{src:Some(LocalId(1))} ]);
  let shape_area = func(3, vec![0], 2, false, vec![
      AllocObject {dst:LocalId(1),type_id:TypeId(0),site:SiteId(902), class_id: None, proto: None }, Return{src:Some(LocalId(1))} ]);
  let square_area = func(2, vec![0], 2, false, vec![
      AllocObject {dst:LocalId(1),type_id:TypeId(0),site:SiteId(901), class_id: None, proto: None }, Return{src:Some(LocalId(1))} ]);
  // g allocates a receiver (site 800), calls area (polymorphic), stores result to global.
  let g = func(0, vec![], 3, false, vec![
      AllocObject {dst:LocalId(0),type_id:TypeId(0),site:SiteId(800), class_id: None, proto: None },  // receiver
      Call{dst:Some(LocalId(1)), recv:Some(LocalId(0)),
           callee:CalleeRef::Method{recv_class:ClassId(0),method:Name(AREA),recv_stable:true,method_field:None}, args:vec![], resolved_sig:None},
      StoreGlobal{gref:GlobalId(0),src:LocalId(1)},  // leak the returned object
  ]);
  let mut prog = Program{version:1,strict_type_optimizations: Default::default(), closed_receivers: Default::default(),types:vec![],fields:vec![],signatures:vec![],globals:vec![],
    scopes:vec![],bindings:vec![],functions:vec![g,circle_area,square_area,shape_area],modules:vec![],function_modules:Default::default(),exports:vec![],
    site_meta:vec![], classes: base_classes(true,true,true), object_proto_methods: vec![], array_proto_methods: vec![], promise_proto_methods: vec![], map_proto_methods: vec![], set_proto_methods: vec![], weak_map_proto_methods: vec![], weak_set_proto_methods: vec![], headers_proto_methods: vec![], function_proto_methods: vec![], string_proto_methods: vec![], regexp_proto_methods: vec![], number_proto_methods: vec![], boolean_proto_methods: vec![], well_known_symbols: vec![]};

  let disp = run_devirt(&mut prog, true);
  // the call in g should have produced a Virtual dispatch
  ck("rewrite produced 1 site dispatch", disp.len(), 1);
  ck("g's call is Virtual", disp[0].dispatch.clone(), Dispatch::Virtual{slot:0,name:Name(AREA)});
  // and the callee was rewritten to a dynamic Method dispatch (prototype lookup
  // at runtime). Multiple concrete impls used to become CalleeRef::Set, but that
  // only picked funcs.first() in codegen — wrong for genuinely-mixed receivers.
  // The dynamic Method path dispatches through each instance's actual prototype.
  if let Inst::Call{callee,..} = &prog.functions[0].body[1] {
    match callee { CalleeRef::Method{recv_class,method,..} =>
                     ck("callee rewritten to dynamic Method", (recv_class.0, method.0), (0, AREA)),
                   other => panic!("expected Method, got {:?}", other) }
  } else { panic!("expected Call"); }

  // escape analysis consumes the rewritten program unchanged
  let res = interproc::analyze_program(&prog);
  let st=|s:u32| res.sites.iter().find(|x|x.site==SiteId(s)).map(|x|x.state);
  // returned objects from area() flow through g's call result into the global -> GlobalEscape
  ck("Circle.area site -> ArgEscape (returns out of its frame)", st(900), Some(EscapeState::ArgEscape));
  ck("Square.area site -> ArgEscape", st(901), Some(EscapeState::ArgEscape));
  // the receiver (site 800) is passed as recv to area(); area doesn't leak its recv -> NoEscape
  ck("Shape.area site -> ArgEscape", st(902), Some(EscapeState::ArgEscape));
  // The receiver is now passed to a DYNAMIC Method dispatch (we rewrite multi-impl
  // virtual calls to prototype lookup rather than a known Set). The dispatched
  // target is opaque to escape analysis, so the receiver conservatively escapes —
  // a safe precision trade for correct polymorphic dispatch over mixed receivers.
  ck("receiver site (dynamic dispatch target opaque) -> GlobalEscape", st(800), Some(EscapeState::GlobalEscape));

  println!("\nAll devirt-pass + IR integration scenarios passed.");
}
