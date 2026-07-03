//! P3 + closures — interprocedural, summary-based escape analysis.
//!
//! Connection-graph summaries (Choi-style), callee internals collapsed to a
//! single `Internal` node. To handle closures soundly we add phantom
//! parameter-field nodes: a load `p.f` off a parameter object yields a
//! `ParamField(p, f)` node, so a callee that reads a field of a parameter and
//! leaks/returns it is captured by the summary (`field_global` / `field_ret`).
//!
//! Closures: `AllocClosure` wires the closure object to its captured cells
//! (object-escape => cell escapes) AND applies the lifted closure function's
//! summary to the captured cells (body effects on the cells, e.g. leaking a
//! captured variable). The lifted function's leading parameters are exactly the
//! captured cells, in capture order. A `creation`-time application folds
//! `field_ret` into `field_global` (a closure that can expose a captured var
//! via its return may leak it once invoked — sound, mildly conservative).
//!
//! Summaries are built bottom-up over the SCC condensation (P2); recursion
//! nests iterate from the empty summary to a least fixpoint. `Unknown` callees
//! stay conservative; exported functions promote param/return reachability to
//! GlobalEscape.

use std::collections::{BTreeMap, BTreeSet};

use crate::call_graph::build_call_graph;
use crate::escape_ir::*;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum FieldKey {
    Named(FieldId),
    Elem,
    Capture(BindingId),
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Obj {
    Site(SiteId),
    Param(LocalId),
    /// Phantom: the contents of a parameter object's field (caller-provided).
    ParamField(LocalId, FieldKey),
    External,
    /// Collapsed callee internals introduced at a call site.
    Opaque(u32),
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Ref {
    Local(LocalId),
    Ret,
    Global,
    /// Synthetic temporary used when translating a summary at a call site.
    Temp(u32),
}

#[derive(Clone, Copy, Debug)]
enum C {
    Addr(Ref, Obj),
    Copy(Ref, Ref),
    Load(Ref, Ref, FieldKey),
    Store(Ref, FieldKey, Ref),
    StoreObj(Obj, FieldKey, Ref),
    StoreLit(Ref, FieldKey, Obj),
    AddrField(Obj, FieldKey, Obj),
}

#[derive(Default)]
struct Solver {
    pt: BTreeMap<Ref, BTreeSet<Obj>>,
    field: BTreeMap<(Obj, FieldKey), BTreeSet<Obj>>,
}

fn union_into(dst: &mut BTreeSet<Obj>, src: &BTreeSet<Obj>) -> bool {
    let before = dst.len();
    dst.extend(src.iter().copied());
    dst.len() != before
}

impl Solver {
    fn pt_clone(&self, r: Ref) -> BTreeSet<Obj> {
        self.pt.get(&r).cloned().unwrap_or_default()
    }
    fn solve(&mut self, cs: &[C]) {
        let mut changed = true;
        while changed {
            changed = false;
            for &c in cs {
                match c {
                    C::Addr(r, o) => changed |= self.pt.entry(r).or_default().insert(o),
                    C::Copy(d, s) => {
                        let s = self.pt_clone(s);
                        changed |= union_into(self.pt.entry(d).or_default(), &s);
                    }
                    C::Load(d, b, f) => {
                        let bases = self.pt_clone(b);
                        let mut acc = BTreeSet::new();
                        for o in &bases {
                            // Phantom param-field: loading a field of a parameter
                            // object yields its caller-provided contents node.
                            if let Obj::Param(p) = o {
                                acc.insert(Obj::ParamField(*p, f));
                            }
                            if let Some(s) = self.field.get(&(*o, f)) {
                                acc.extend(s.iter().copied());
                            }
                        }
                        changed |= union_into(self.pt.entry(d).or_default(), &acc);
                    }
                    C::Store(b, f, s) => {
                        let bases = self.pt_clone(b);
                        let s = self.pt_clone(s);
                        for o in &bases {
                            changed |= union_into(self.field.entry((*o, f)).or_default(), &s);
                        }
                    }
                    C::StoreObj(o, f, s) => {
                        let s = self.pt_clone(s);
                        changed |= union_into(self.field.entry((o, f)).or_default(), &s);
                    }
                    C::StoreLit(b, f, v) => {
                        let bases = self.pt_clone(b);
                        for o in &bases {
                            changed |= self.field.entry((*o, f)).or_default().insert(v);
                        }
                    }
                    C::AddrField(b, f, v) => {
                        changed |= self.field.entry((b, f)).or_default().insert(v);
                    }
                }
            }
        }
    }
    fn field_closure(&self, seed: BTreeSet<Obj>) -> BTreeSet<Obj> {
        let mut set = seed;
        let mut work: Vec<Obj> = set.iter().copied().collect();
        while let Some(o) = work.pop() {
            for ((fo, _k), tgts) in self.field.iter() {
                if *fo == o {
                    for t in tgts {
                        if set.insert(*t) {
                            work.push(*t);
                        }
                    }
                }
            }
        }
        set
    }
    fn global_set(&self) -> BTreeSet<Obj> {
        let mut seed = self.pt_clone(Ref::Global);
        seed.insert(Obj::External);
        self.field_closure(seed)
    }
}

// ------------------------------- summaries ------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum SObj {
    Param(usize),
    Internal,
    External,
    Global,
}

#[derive(Clone, PartialEq, Eq, Debug)]
struct Summary {
    nparams: usize,
    param_global: Vec<bool>,
    fields: BTreeSet<(SObj, FieldKey, SObj)>,
    ret: BTreeSet<SObj>,
    /// (param i, field f): contents of param i's field f escape to the global sink.
    field_global: BTreeSet<(usize, FieldKey)>,
    /// (param i, field f): contents of param i's field f flow to the return value.
    field_ret: BTreeSet<(usize, FieldKey)>,
}

impl Summary {
    fn empty(nparams: usize) -> Self {
        Summary {
            nparams,
            param_global: vec![false; nparams],
            fields: BTreeSet::new(),
            ret: BTreeSet::new(),
            field_global: BTreeSet::new(),
            field_ret: BTreeSet::new(),
        }
    }
}

// ---------------------------- constraint building -----------------------------

fn is_reflike(f: &Function, id: LocalId) -> bool {
    !matches!(
        f.locals.iter().find(|l| l.id == id).map(|l| l.ref_kind),
        Some(RefKind::Primitive)
    )
}

/// Recursively flatten Loop/If bodies into a flat instruction list so the
/// flow-insensitive constraint builder sees every allocation/call. Pure codegen
/// control-flow wrappers (Loop/If/Print) carry no escape constraints themselves.
fn flatten_bodies(body: &[Inst], out: &mut Vec<Inst>) {
    for inst in body {
        match inst {
            Inst::Loop {
                cond_body, body, ..
            } => {
                flatten_bodies(cond_body, out);
                flatten_bodies(body, out);
            }
            Inst::If {
                then_body,
                else_body,
                ..
            } => {
                flatten_bodies(then_body, out);
                flatten_bodies(else_body, out);
            }
            Inst::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                flatten_bodies(try_body, out);
                flatten_bodies(catch_body, out);
                flatten_bodies(finally_body, out);
                out.push(inst.clone()); // keep the node so catch_var gets marked
            }
            other => out.push(other.clone()),
        }
    }
}

/// Single source of truth for SROA materialization escape
/// (property_model_redesign §3.4). Returns the operand locals that an instruction
/// forces to materialize (escape to the global sink) because the runtime hands the
/// REAL heap object to a path that reads its structure: string coercion, inspection/
/// printing, dynamic or descriptor-walking property access, prototype manipulation,
/// or a cross-function / coroutine boundary. Such an operand cannot be scalar-
/// replaced away by SROA, or the runtime would read an eliminated object.
///
/// This intentionally does NOT cover structural dataflow (Load/Store/Alloc/Copy
/// aliasing, Call summaries) — those produce points-to constraints, not blanket
/// materialization, and are handled directly in build_constraints. Adding a new
/// op that passes an object to such a runtime path means adding one arm here,
/// rather than scattering `Copy(Global, ..)` pushes across build_constraints.
fn op_forces_materialization(inst: &Inst) -> Vec<LocalId> {
    match inst {
        // console.log / inspection reads the value's fields.
        Inst::Print { src } => vec![*src],
        // `a + b`: ts_add coerces an object operand via ts_to_string_v (toString),
        // reading its structure. (Numeric operands: harmless no-op, not heap-tracked.)
        Inst::BinOp { op, lhs, rhs, .. } if op.as_str() == "+" => vec![*lhs, *rhs],
        // `k in o` / `o[k] in`: ts_has_prop walks props + class descriptor + proto,
        // so obj (and a dynamic key) must materialize.
        Inst::HasField { obj, .. } => vec![*obj],
        Inst::HasFieldDynamic { obj, key, .. } => vec![*obj, *key],
        // dynamic-key access interns the key and walks the real object at runtime.
        Inst::LoadFieldDynamic { obj, .. } => vec![*obj],
        Inst::StoreFieldDynamic { obj, key, .. } => vec![*obj, *key],
        // {...src}: copy_props enumerates src's own props via the canonical path.
        Inst::ObjectCopyProps { src, .. } => vec![*src],
        // new step 4: the result may be either the instance or the ctor's return,
        // both used as a real heap object -> materialize both.
        Inst::ConstructResult { inst, ret, .. } => vec![*inst, *ret],
        // prototype manipulation hands the value to the runtime proto chain.
        Inst::StoreProtoMethod { src, .. } => vec![*src],
        Inst::StoreMethod { obj, src, .. } => vec![*obj, *src],
        Inst::SetProto { proto, .. } => vec![*proto],
        // coroutine / async boundary: the operand crosses out of this frame.
        Inst::Yield { operand, .. } => vec![*operand],
        Inst::Await { operand, .. } => vec![*operand],
        // thrown / globally-stored values escape this analysis entirely.
        Inst::Throw { src } => vec![*src],
        Inst::StoreGlobal { src, .. } => vec![*src],
        _ => Vec::new(),
    }
}

fn build_constraints(f: &Function, summaries: &[Option<Summary>]) -> (Vec<C>, Vec<SiteId>) {
    let mut is_ref_map: BTreeMap<LocalId, bool> = BTreeMap::new();
    for l in &f.locals {
        is_ref_map.insert(l.id, !matches!(l.ref_kind, RefKind::Primitive));
    }
    let is_ref = |id: LocalId| is_ref_map.get(&id).copied().unwrap_or(true);

    let mut cs: Vec<C> = Vec::new();
    let mut sites: Vec<SiteId> = Vec::new();
    let mut opaque: u32 = 0;
    let mut temp: u32 = 0;

    for &p in &f.params {
        if is_ref(p) {
            cs.push(C::Addr(Ref::Local(p), Obj::Param(p)));
        }
    }

    let conservative = |actuals: &[LocalId], dst: Option<LocalId>, cs: &mut Vec<C>| {
        for &a in actuals {
            if is_ref(a) {
                cs.push(C::Copy(Ref::Global, Ref::Local(a)));
            }
        }
        if let Some(d) = dst {
            if is_ref(d) {
                cs.push(C::Addr(Ref::Local(d), Obj::External));
            }
        }
    };

    let mut flat: Vec<Inst> = Vec::new();
    flatten_bodies(&f.body, &mut flat);
    for inst in &flat {
        // Single-source SROA materialization escape (§3.4): operands that the
        // runtime reads as real heap objects must escape to the global sink.
        for m in op_forces_materialization(inst) {
            cs.push(C::Copy(Ref::Global, Ref::Local(m)));
        }
        match *inst {
            Inst::AllocObject { dst, site, .. } | Inst::AllocArray { dst, site, .. } => {
                cs.push(C::Addr(Ref::Local(dst), Obj::Site(site)));
                sites.push(site);
            }
            Inst::AllocClosure {
                dst,
                ref captures,
                site,
                func,
            } => {
                cs.push(C::Addr(Ref::Local(dst), Obj::Site(site)));
                sites.push(site);
                // closure object holds a reference to each captured cell
                for cap in captures {
                    cs.push(C::StoreObj(
                        Obj::Site(site),
                        FieldKey::Capture(cap.binding),
                        Ref::Local(cap.cell),
                    ));
                }
                // apply the lifted closure body's effects to the captured cells
                if let Some(sum) = summaries.get(func.0 as usize).and_then(|s| s.as_ref()) {
                    let cell_actuals: Vec<LocalId> = captures.iter().map(|c| c.cell).collect();
                    apply_summary(
                        sum,
                        &cell_actuals,
                        None,
                        &is_ref,
                        &mut cs,
                        &mut opaque,
                        &mut temp,
                        true,
                    );
                }
            }
            Inst::Copy { dst, src } => cs.push(C::Copy(Ref::Local(dst), Ref::Local(src))),
            Inst::LoadField { dst, obj, field } => cs.push(C::Load(
                Ref::Local(dst),
                Ref::Local(obj),
                FieldKey::Named(field),
            )),
            Inst::StoreField { obj, field, src } => cs.push(C::Store(
                Ref::Local(obj),
                FieldKey::Named(field),
                Ref::Local(src),
            )),
            Inst::LoadElem { dst, arr } => {
                cs.push(C::Load(Ref::Local(dst), Ref::Local(arr), FieldKey::Elem))
            }
            Inst::StoreElem { arr, src } => {
                cs.push(C::Store(Ref::Local(arr), FieldKey::Elem, Ref::Local(src)))
            }
            Inst::LoadIndex { dst, arr, .. } => {
                cs.push(C::Load(Ref::Local(dst), Ref::Local(arr), FieldKey::Elem))
            }
            Inst::StoreIndex { arr, src, .. } => {
                cs.push(C::Store(Ref::Local(arr), FieldKey::Elem, Ref::Local(src)))
            }
            Inst::ArrayPush { arr, src } => {
                cs.push(C::Store(Ref::Local(arr), FieldKey::Elem, Ref::Local(src)))
            }
            Inst::ArrayPushAll { arr, src } => {
                cs.push(C::Store(Ref::Local(arr), FieldKey::Elem, Ref::Local(src)))
            }
            // `key in obj` / hasOwnProperty / dynamic access: the runtime inspects
            // obj's structure (props + class descriptor + proto chain). The needed
            // materialization escape is supplied by op_forces_materialization above,
            // so these arms only carry structural (dst/Store) constraints.
            Inst::HasField { .. } => {}
            Inst::HasFieldDynamic { .. } => {}
            Inst::LoadFieldDynamic { dst, .. } => {
                if is_ref(dst) {
                    cs.push(C::Addr(Ref::Local(dst), Obj::External));
                }
            }
            Inst::StoreFieldDynamic { obj, src, .. } => {
                cs.push(C::Store(Ref::Local(obj), FieldKey::Elem, Ref::Local(src)));
            }
            Inst::DeleteField { .. } => {}
            Inst::ArraySlice { dst, arr, .. } => {
                cs.push(C::Copy(Ref::Local(dst), Ref::Local(arr)));
            }
            Inst::ObjectRest { dst, src, .. } => {
                cs.push(C::Copy(Ref::Local(dst), Ref::Local(src)));
            }
            Inst::ObjectCopyProps { .. } => {} // materialization via op_forces_materialization
            Inst::ConstructResult { dst, inst, .. } => {
                // dst is the instance or the ctor's returned object (both forced to
                // materialize above); model dst as aliasing the instance heap ref.
                cs.push(C::Copy(Ref::Local(dst), Ref::Local(inst)));
            }
            Inst::ArrayLen { .. }
            | Inst::StringLen { .. }
            | Inst::Break { .. }
            | Inst::Continue { .. } => {}
            Inst::LoadClassProto { dst, .. } => {
                if is_ref(dst) {
                    cs.push(C::Addr(Ref::Local(dst), Obj::External));
                }
            }
            Inst::StoreProtoMethod { .. } => {} // materialization via op_forces_materialization
            Inst::StoreMethod { obj, src, .. } => {
                cs.push(C::Store(Ref::Local(obj), FieldKey::Elem, Ref::Local(src)));
            }
            Inst::GetProto { dst, .. } => {
                if is_ref(dst) {
                    cs.push(C::Addr(Ref::Local(dst), Obj::External));
                }
            }
            Inst::NewMap { dst } | Inst::NewSet { dst } => {
                if is_ref(dst) {
                    cs.push(C::Addr(Ref::Local(dst), Obj::External));
                }
            }
            Inst::CallBuiltin {
                dst,
                recv,
                ref args,
                ..
            } => {
                cs.push(C::Copy(Ref::Global, Ref::Local(recv)));
                for a in args {
                    cs.push(C::Copy(Ref::Global, Ref::Local(*a)));
                }
                if let Some(d) = dst {
                    if is_ref(d) {
                        cs.push(C::Addr(Ref::Local(d), Obj::External));
                    }
                }
            }
            Inst::CallBuiltinStatic { dst, ref args, .. } => {
                for a in args {
                    cs.push(C::Copy(Ref::Global, Ref::Local(*a)));
                }
                if let Some(d) = dst {
                    if is_ref(d) {
                        cs.push(C::Addr(Ref::Local(d), Obj::External));
                    }
                }
            }
            Inst::SetProto { .. } => {} // proto materialization via op_forces_materialization
            Inst::Call {
                dst,
                ref recv,
                ref args,
                ref callee,
                ..
            } => {
                let mut actuals: Vec<LocalId> = Vec::new();
                if let Some(r) = recv {
                    actuals.push(*r);
                }
                actuals.extend(args.iter().copied());

                let callees: Vec<FunctionId> = match callee {
                    CalleeRef::Direct { func } => vec![*func],
                    CalleeRef::Set { funcs } => funcs.clone(),
                    CalleeRef::Method { .. } | CalleeRef::Unknown | CalleeRef::Value { .. } => {
                        conservative(&actuals, dst, &mut cs);
                        continue;
                    }
                };
                for g in callees {
                    match summaries.get(g.0 as usize).and_then(|s| s.as_ref()) {
                        Some(sum) => apply_summary(
                            sum,
                            &actuals,
                            dst,
                            &is_ref,
                            &mut cs,
                            &mut opaque,
                            &mut temp,
                            false,
                        ),
                        None => conservative(&actuals, dst, &mut cs),
                    }
                }
            }
            Inst::CallSpread {
                dst,
                ref recv,
                ref arg_specs,
                ..
            } => {
                // Conservative: all spec values (singles + spread arrays) escape,
                // and the result is external.
                let mut actuals: Vec<LocalId> = Vec::new();
                if let Some(r) = recv {
                    actuals.push(*r);
                }
                for spec in arg_specs {
                    match spec {
                        ArgSpec::Single { local } | ArgSpec::Spread { local } => {
                            actuals.push(*local)
                        }
                    }
                }
                conservative(&actuals, dst, &mut cs);
            }
            Inst::Return { src } => {
                if let Some(s) = src {
                    cs.push(C::Copy(Ref::Ret, Ref::Local(s)));
                }
            }
            Inst::GenericLen { .. } => {}
            Inst::Yield { dst, .. } => {
                if let Some(d) = dst {
                    if is_ref(d) {
                        cs.push(C::Addr(Ref::Local(d), Obj::External));
                    }
                }
            }
            Inst::Await { dst, .. } => {
                if let Some(d) = dst {
                    if is_ref(d) {
                        cs.push(C::Addr(Ref::Local(d), Obj::External));
                    }
                }
            }
            Inst::Throw { .. } => {} // materialization via op_forces_materialization
            Inst::TryCatch { catch_var, .. } => {
                // the caught value comes from outside this analysis (global sink)
                if let Some(cv) = catch_var {
                    if is_ref(cv) {
                        cs.push(C::Addr(Ref::Local(cv), Obj::External));
                    }
                }
            }
            Inst::StoreGlobal { .. } => {} // materialization via op_forces_materialization
            Inst::LoadGlobal { dst, .. } => {
                if is_ref(dst) {
                    cs.push(C::Addr(Ref::Local(dst), Obj::External));
                }
            }
            // First-class builtin VALUES produce an external function value. For a
            // prototype method value, recv is read for dispatch but the returned
            // (unbound, shared) method does not capture recv — mark recv escaped to
            // stay conservative; the value itself is External.
            Inst::LoadMethodValue { dst, recv, .. } => {
                cs.push(C::Copy(Ref::Global, Ref::Local(recv)));
                if is_ref(dst) {
                    cs.push(C::Addr(Ref::Local(dst), Obj::External));
                }
            }
            Inst::LoadBuiltinFn { dst, .. } => {
                if is_ref(dst) {
                    cs.push(C::Addr(Ref::Local(dst), Obj::External));
                }
            }
            // A class value boxes the captured cells (they escape into it) and is
            // itself an external function value. NewDynamic constructs a heap
            // instance (External); callee/args flow into the constructor.
            Inst::AllocClassValue {
                dst, ref captures, ..
            } => {
                if is_ref(dst) {
                    cs.push(C::Addr(Ref::Local(dst), Obj::External));
                }
                for cap in captures {
                    cs.push(C::Copy(Ref::Global, Ref::Local(cap.cell)));
                }
            }
            Inst::NewDynamic {
                dst,
                callee,
                ref args,
                ..
            } => {
                if is_ref(dst) {
                    cs.push(C::Addr(Ref::Local(dst), Obj::External));
                }
                cs.push(C::Copy(Ref::Global, Ref::Local(callee)));
                for a in args {
                    cs.push(C::Copy(Ref::Global, Ref::Local(*a)));
                }
            }
            // Codegen-only value ops: no aliasing, no escape constraints.
            Inst::Const { .. } | Inst::UnOp { .. } => {}
            // `+` operand string-coercion materialization is handled by
            // op_forces_materialization; nothing structural here.
            Inst::BinOp { .. } => {}
            // console.log/Print materialization handled by op_forces_materialization.
            Inst::Print { .. } => {}
            // Structured control flow: bodies are flattened by `flatten_bodies`
            // before constraint building, so nothing to do here.
            Inst::Loop { .. } | Inst::If { .. } => {}
        }
    }
    (cs, sites)
}

enum Side {
    Ref(LocalId),
    Obj(Obj),
    None,
}

#[allow(clippy::too_many_arguments)]
fn apply_summary(
    sum: &Summary,
    actuals: &[LocalId],
    dst: Option<LocalId>,
    is_ref: &dyn Fn(LocalId) -> bool,
    cs: &mut Vec<C>,
    opaque: &mut u32,
    temp: &mut u32,
    creation: bool,
) {
    let op = Obj::Opaque(*opaque);
    *opaque += 1;

    for i in 0..sum.nparams {
        if sum.param_global[i] && i < actuals.len() && is_ref(actuals[i]) {
            cs.push(C::Copy(Ref::Global, Ref::Local(actuals[i])));
        }
    }
    for &a in actuals.iter().skip(sum.nparams) {
        if is_ref(a) {
            cs.push(C::Copy(Ref::Global, Ref::Local(a)));
        }
    }

    // contents of param i's field f escape to the global sink
    for (i, f) in &sum.field_global {
        if *i < actuals.len() {
            let t = Ref::Temp(*temp);
            *temp += 1;
            cs.push(C::Load(t, Ref::Local(actuals[*i]), *f));
            cs.push(C::Copy(Ref::Global, t));
        }
    }
    // contents of param i's field f flow to the return (or, at creation, may leak)
    for (i, f) in &sum.field_ret {
        if *i < actuals.len() {
            let t = Ref::Temp(*temp);
            *temp += 1;
            cs.push(C::Load(t, Ref::Local(actuals[*i]), *f));
            if creation {
                cs.push(C::Copy(Ref::Global, t));
            } else if let Some(d) = dst {
                if is_ref(d) {
                    cs.push(C::Copy(Ref::Local(d), t));
                }
            }
        }
    }

    let as_base = |s: SObj| -> Side {
        match s {
            SObj::Param(i) if i < actuals.len() => Side::Ref(actuals[i]),
            SObj::Param(_) => Side::None,
            SObj::Internal => Side::Obj(op),
            SObj::External => Side::Obj(Obj::External),
            SObj::Global => Side::None,
        }
    };
    let as_val = |s: SObj| -> Side {
        match s {
            SObj::Param(j) if j < actuals.len() => Side::Ref(actuals[j]),
            SObj::Param(_) => Side::None,
            SObj::Internal => Side::Obj(op),
            SObj::External | SObj::Global => Side::Obj(Obj::External),
        }
    };

    for (s, key, d) in &sum.fields {
        let key = *key;
        match (as_base(*s), as_val(*d)) {
            (Side::Ref(b), Side::Ref(v)) => cs.push(C::Store(Ref::Local(b), key, Ref::Local(v))),
            (Side::Ref(b), Side::Obj(v)) => cs.push(C::StoreLit(Ref::Local(b), key, v)),
            (Side::Obj(b), Side::Ref(v)) => cs.push(C::StoreObj(b, key, Ref::Local(v))),
            (Side::Obj(b), Side::Obj(v)) => cs.push(C::AddrField(b, key, v)),
            _ => {}
        }
    }

    if let Some(d) = dst {
        if is_ref(d) {
            for s in &sum.ret {
                match *s {
                    SObj::Param(i) if i < actuals.len() => {
                        cs.push(C::Copy(Ref::Local(d), Ref::Local(actuals[i])))
                    }
                    SObj::Param(_) => {}
                    SObj::Internal => cs.push(C::Addr(Ref::Local(d), op)),
                    SObj::External | SObj::Global => cs.push(C::Addr(Ref::Local(d), Obj::External)),
                }
            }
        }
    }
}

// ----------------------------- extraction -------------------------------------

fn solve(f: &Function, summaries: &[Option<Summary>]) -> (Solver, Vec<SiteId>) {
    let (cs, sites) = build_constraints(f, summaries);
    let mut s = Solver::default();
    s.solve(&cs);
    (s, sites)
}

fn extract_summary(f: &Function, solver: &Solver) -> Summary {
    let param_index: BTreeMap<LocalId, usize> =
        f.params.iter().enumerate().map(|(i, p)| (*p, i)).collect();
    let map = |o: Obj| -> SObj {
        match o {
            Obj::Site(_) | Obj::Opaque(_) | Obj::ParamField(_, _) => SObj::Internal,
            Obj::External => SObj::External,
            Obj::Param(p) => SObj::Param(*param_index.get(&p).unwrap_or(&usize::MAX)),
        }
    };

    let global = solver.global_set();
    let ret_set = solver.field_closure(solver.pt_clone(Ref::Ret));

    let mut param_global = vec![false; f.params.len()];
    for (i, &p) in f.params.iter().enumerate() {
        if is_reflike(f, p) && global.contains(&Obj::Param(p)) {
            param_global[i] = true;
        }
    }
    if f.is_generator || f.is_async {
        for (i, &p) in f.params.iter().enumerate() {
            if is_reflike(f, p) {
                param_global[i] = true;
            }
        }
    }

    let mut field_global = BTreeSet::new();
    let mut field_ret = BTreeSet::new();
    for o in global.iter() {
        if let Obj::ParamField(p, fk) = o {
            if let Some(i) = param_index.get(p) {
                field_global.insert((*i, *fk));
            }
        }
    }
    for o in ret_set.iter() {
        if let Obj::ParamField(p, fk) = o {
            if let Some(i) = param_index.get(p) {
                field_ret.insert((*i, *fk));
            }
        }
    }

    let mut fields = BTreeSet::new();
    for ((o, key), tgts) in solver.field.iter() {
        let so = map(*o);
        if matches!(so, SObj::Param(i) if i == usize::MAX) {
            continue;
        }
        for t in tgts {
            fields.insert((so, *key, map(*t)));
        }
    }
    let ret = solver.pt_clone(Ref::Ret).into_iter().map(map).collect();

    Summary {
        nparams: f.params.len(),
        param_global,
        fields,
        ret,
        field_global,
        field_ret,
    }
}

fn extract_escape(f: &Function, solver: &Solver, sites: &[SiteId]) -> Vec<SiteEscape> {
    let global = solver.global_set();

    let mut a_seed = solver.pt_clone(Ref::Ret);
    for &p in &f.params {
        if is_reflike(f, p) {
            a_seed.extend(solver.pt_clone(Ref::Local(p)));
        }
    }
    let arg = solver.field_closure(a_seed);

    sites
        .iter()
        .map(|&site| {
            let o = Obj::Site(site);
            let state = if global.contains(&o) || (f.is_exported && arg.contains(&o)) {
                EscapeState::GlobalEscape
            } else if arg.contains(&o) {
                EscapeState::ArgEscape
            } else {
                EscapeState::NoEscape
            };
            SiteEscape { site, state }
        })
        .collect()
}

// ------------------------------- driver ---------------------------------------

pub fn analyze_program(program: &Program) -> EscapeResult {
    let cg = build_call_graph(program);
    let by_id: BTreeMap<u32, &Function> = program.functions.iter().map(|f| (f.id.0, f)).collect();
    // summaries is indexed by function id; ids may be sparse (a reserved id with no
    // emitted body leaves a gap), so size by max-id+1. SCC nodes for gap ids carry
    // no function and are skipped.
    let n = program
        .functions
        .iter()
        .map(|f| f.id.0 as usize + 1)
        .max()
        .unwrap_or(0)
        .max(program.functions.len());
    let mut summaries: Vec<Option<Summary>> = vec![None; n];

    for scc in &cg.order {
        if !cg.is_cyclic(scc) {
            let Some(&f) = by_id.get(&scc[0].0) else { continue };
            let (solver, _) = solve(f, &summaries);
            summaries[scc[0].0 as usize] = Some(extract_summary(f, &solver));
        } else {
            for m in scc {
                let Some(&f) = by_id.get(&m.0) else { continue };
                summaries[m.0 as usize] = Some(Summary::empty(f.params.len()));
            }
            loop {
                let mut changed = false;
                for m in scc {
                    let Some(&f) = by_id.get(&m.0) else { continue };
                    let (solver, _) = solve(f, &summaries);
                    let s = extract_summary(f, &solver);
                    if summaries[m.0 as usize].as_ref() != Some(&s) {
                        summaries[m.0 as usize] = Some(s);
                        changed = true;
                    }
                }
                if !changed {
                    break;
                }
            }
        }
    }

    let mut out = Vec::new();
    for f in &program.functions {
        let (solver, sites) = solve(f, &summaries);
        out.extend(extract_escape(f, &solver, &sites));
    }
    EscapeResult {
        version: SCHEMA_VERSION,
        sites: out,
    }
}
