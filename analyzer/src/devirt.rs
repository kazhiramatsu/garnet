//! Devirtualization pass — runs BEFORE escape analysis.
//!
//! It rewrites every `CalleeRef::Method { recv_class, method, recv_stable }` into
//! the resolution the existing analyzer already understands:
//!     Direct{func}  — one reachable impl (CHA refined by RTA)
//!     Set{funcs}    — several reachable impls (polymorphic; vtable in codegen)
//!     Unknown       — open/unstable receiver (dynamic dispatch in codegen)
//! so the escape analyzer needs no changes. It also returns a per-call-site
//! `Dispatch` (Direct / Virtual{slot} / Dynamic) for codegen.
//!
//! Soundness guards mirror class_extract.ts: a receiver reached via `any`/cast
//! (`recv_stable=false`), an unstable receiver class, or any unstable candidate
//! in the closed-world subtree forces Dynamic / Unknown.

use std::collections::{BTreeMap, BTreeSet};

use crate::escape_ir::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Dispatch {
    Direct(FunctionId),
    Virtual { slot: usize, name: Name },
    Dynamic,
}

#[derive(Debug, Clone)]
pub struct SiteDispatch {
    pub function: FunctionId, // which IR function the call is in
    pub index: usize,         // instruction index within that function's body
    pub dispatch: Dispatch,
}

pub struct ClassTable {
    by_id: BTreeMap<u32, ClassDef>,
}

impl ClassTable {
    pub fn new(classes: &[ClassDef]) -> Self {
        ClassTable {
            by_id: classes.iter().map(|c| (c.id.0, c.clone())).collect(),
        }
    }
    fn get(&self, c: ClassId) -> Option<&ClassDef> {
        self.by_id.get(&c.0)
    }
    fn chain_up(&self, c: ClassId) -> Vec<ClassId> {
        let mut v = Vec::new();
        let mut cur = Some(c);
        while let Some(id) = cur {
            v.push(id);
            cur = self.get(id).and_then(|c| c.parent);
        }
        v
    }
    fn chain_down(&self, c: ClassId) -> Vec<ClassId> {
        let mut v = self.chain_up(c);
        v.reverse();
        v
    }
    fn subclasses(&self, c: ClassId) -> BTreeSet<ClassId> {
        self.by_id
            .keys()
            .map(|k| ClassId(*k))
            .filter(|&k| self.chain_up(k).contains(&c))
            .collect()
    }
    fn resolve(&self, c: ClassId, name: Name) -> Option<FunctionId> {
        for id in self.chain_up(c) {
            if let Some(cls) = self.get(id) {
                if let Some(m) = cls.own_methods.iter().find(|m| m.name == name) {
                    return Some(m.func);
                }
            }
        }
        None
    }
    fn vtable(&self, c: ClassId) -> Vec<(Name, FunctionId)> {
        let mut name_to_slot: BTreeMap<u32, usize> = BTreeMap::new();
        let mut slots: Vec<(Name, FunctionId)> = Vec::new();
        for id in self.chain_down(c) {
            if let Some(cls) = self.get(id) {
                for m in &cls.own_methods {
                    if m.kind != MethodKind::Method
                        && m.kind != MethodKind::Getter
                        && m.kind != MethodKind::Setter
                    {
                        continue;
                    }
                    match name_to_slot.get(&m.name.0) {
                        Some(&slot) => slots[slot] = (m.name, m.func),
                        None => {
                            name_to_slot.insert(m.name.0, slots.len());
                            slots.push((m.name, m.func));
                        }
                    }
                }
            }
        }
        slots
    }
    fn slot_of(&self, c: ClassId, name: Name) -> Option<usize> {
        self.vtable(c).iter().position(|(n, _)| n.0 == name.0)
    }
    /// Public view of the vtable for codegen (slot order = (name, func)).
    pub fn vtable_names(&self, c: ClassId) -> Vec<(Name, FunctionId)> {
        self.vtable(c)
    }

    /// Core decision used by both IR rewriting and codegen dispatch.
    pub fn devirtualize(
        &self,
        recv_class: ClassId,
        method: Name,
        recv_stable: bool,
        use_rta: bool,
    ) -> Dispatch {
        // Guard 1: receiver not trustworthy as this class, or class unstable.
        let stable_self = self.get(recv_class).map(|c| c.stable).unwrap_or(false);
        if !recv_stable || !stable_self {
            return Dispatch::Dynamic;
        }
        // Closed-world candidate subtree, optionally restricted by RTA.
        let mut candidates: Vec<ClassId> = self
            .subclasses(recv_class)
            .into_iter()
            .filter(|&c| !use_rta || self.get(c).map(|c| c.instantiated).unwrap_or(false))
            .collect();
        if candidates.is_empty() {
            candidates.push(recv_class);
        }
        // Guard 2: any unstable candidate in the subtree -> dynamic.
        if candidates
            .iter()
            .any(|&c| !self.get(c).map(|c| c.stable).unwrap_or(false))
        {
            return Dispatch::Dynamic;
        }
        let impls: BTreeSet<u32> = candidates
            .iter()
            .filter_map(|&c| self.resolve(c, method))
            .map(|f| f.0)
            .collect();
        match impls.len() {
            0 => Dispatch::Dynamic,
            1 => Dispatch::Direct(FunctionId(*impls.iter().next().unwrap())),
            _ => match self.slot_of(recv_class, method) {
                Some(slot) => Dispatch::Virtual { slot, name: method },
                None => Dispatch::Dynamic,
            },
        }
    }

    /// The set of concrete implementations (for building CalleeRef::Set).
    fn impls(&self, recv_class: ClassId, method: Name, use_rta: bool) -> Vec<FunctionId> {
        let mut cands: Vec<ClassId> = self
            .subclasses(recv_class)
            .into_iter()
            .filter(|&c| !use_rta || self.get(c).map(|c| c.instantiated).unwrap_or(false))
            .collect();
        if cands.is_empty() {
            cands.push(recv_class);
        }
        let set: BTreeSet<u32> = cands
            .iter()
            .filter_map(|&c| self.resolve(c, method))
            .map(|f| f.0)
            .collect();
        set.into_iter().map(FunctionId).collect()
    }
}

/// Rewrite all Method callees in place; return the per-site Dispatch for codegen.
pub fn run_devirt(program: &mut Program, use_rta: bool) -> Vec<SiteDispatch> {
    let table = ClassTable::new(&program.classes);
    let mut out = Vec::new();
    for f in &mut program.functions {
        let fid = f.id;
        // Locals that may hold a polymorphic-class instance (a `cond ? A : B` value
        // whose static type collapsed to one member): their static class is
        // untrustworthy, so any method call reaching them must dispatch dynamically.
        let tainted = compute_poly_taint(f);
        rewrite_body(&mut f.body, fid, &table, use_rta, &tainted, &mut out);
    }
    out
}

// --------------------------- polymorphic-class taint -------------------------
//
// A `new K()` where K is `cond ? A : B` and A,B are STRUCTURALLY IDENTICAL collapses
// (in TS) to a single static type, so the result local would be devirtualized as that
// one class — wrong when the runtime object is the other member (their methods may
// differ even though their field LAYOUTS are identical). The exporter marks such sites
// `NewDynamic { poly: true }`. We taint the dst and everything it flows to within the
// function (Copy / ConstructResult), force Dynamic dispatch on any method call whose
// receiver is tainted, and LOUD-FAIL the compile if a tainted value escapes the
// function's tracked dataflow (passed to a call, returned, thrown, stored into a
// container/global/closure, …) — where a downstream Direct devirtualization could
// silently miscompile. Field READS off a tainted object are sound (the colliding
// classes share a layout), so they don't taint or escape. (v1: intra-procedural, no
// container/interproc tracking — escapes loud-fail instead.)

/// Flatten all instructions (recursing into Loop/If/TryCatch bodies) into a ref list.
fn flatten_insts<'a>(body: &'a [Inst], out: &mut Vec<&'a Inst>) {
    for inst in body {
        out.push(inst);
        match inst {
            Inst::Loop {
                cond_body, body, ..
            } => {
                flatten_insts(cond_body, out);
                flatten_insts(body, out);
            }
            Inst::If {
                then_body,
                else_body,
                ..
            } => {
                flatten_insts(then_body, out);
                flatten_insts(else_body, out);
            }
            Inst::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                flatten_insts(try_body, out);
                flatten_insts(catch_body, out);
                flatten_insts(finally_body, out);
            }
            _ => {}
        }
    }
}

/// Locals at which a tainted value would ESCAPE this function's tracked dataflow (so a
/// downstream Direct devirtualization could miscompile). Exhaustive match: the Rust
/// compiler forces every Inst variant to be classified, so a newly-added variant is a
/// compile error rather than a silent unsound hole. Positions that are SOUND for a
/// polymorphic object (a Method-call receiver — forced Dynamic below; read-only loads,
/// which yield field values not the object and whose layout is shared; primitive ops;
/// console.log; propagation via Copy/ConstructResult) contribute no escape locals.
fn escape_locals(inst: &Inst) -> Vec<u32> {
    match inst {
        // --- propagation (handled in the fixpoint, not escapes) ---
        Inst::Copy { .. } | Inst::ConstructResult { .. } => vec![],
        // --- the seeding construction (dst seeded; callee/args may escape) ---
        Inst::NewDynamic { callee, args, .. } => {
            let mut v = vec![callee.0];
            v.extend(args.iter().map(|a| a.0));
            v
        }
        // --- calls: a Method receiver is forced Dynamic (sound), so recv is NOT an
        //     escape; all arguments DO escape. Non-Method callees (Direct ctor calls,
        //     closure Value calls, Unknown) can devirt/route on recv, so recv escapes. ---
        Inst::Call {
            callee, recv, args, ..
        } => {
            let mut v: Vec<u32> = args.iter().map(|a| a.0).collect();
            match callee {
                CalleeRef::Method { .. } => {}
                CalleeRef::Value { local } => {
                    v.push(local.0);
                    if let Some(r) = recv {
                        v.push(r.0);
                    }
                }
                _ => {
                    if let Some(r) = recv {
                        v.push(r.0);
                    }
                }
            }
            v
        }
        Inst::CallSpread {
            callee,
            recv,
            arg_specs,
            ..
        } => {
            let mut v: Vec<u32> = arg_specs
                .iter()
                .map(|a| match a {
                    ArgSpec::Single { local } => local.0,
                    ArgSpec::Spread { local } => local.0,
                })
                .collect();
            match callee {
                CalleeRef::Method { .. } => {}
                CalleeRef::Value { local } => {
                    v.push(local.0);
                    if let Some(r) = recv {
                        v.push(r.0);
                    }
                }
                _ => {
                    if let Some(r) = recv {
                        v.push(r.0);
                    }
                }
            }
            v
        }
        Inst::CallBuiltin { recv, args, .. } => {
            let mut v = vec![recv.0];
            v.extend(args.iter().map(|a| a.0));
            v
        }
        // `x instanceof C` lowers to a runtime proto-walk identity check that only
        // READS the object (returns a bool) — it never stores or devirtualizes it, so
        // a polymorphic object is sound here. All other static builtins might route the
        // object somewhere user code later devirtualizes (array.push into a typed array,
        // …), so their args escape. (`instanceof.hook` passes the object to a user
        // [Symbol.hasInstance] method, so it is NOT whitelisted.)
        Inst::CallBuiltinStatic { builtin, args, .. } => {
            if builtin == "instanceof" || builtin == "instanceof.dyn" {
                vec![]
            } else {
                args.iter().map(|a| a.0).collect()
            }
        }
        // --- stores into containers / globals / proto: src (the value) escapes ---
        Inst::StoreField { src, .. }
        | Inst::StoreElem { src, .. }
        | Inst::StoreIndex { src, .. }
        | Inst::StoreFieldDynamic { src, .. }
        | Inst::StoreGlobal { src, .. }
        | Inst::ArrayPush { src, .. }
        | Inst::ArrayPushAll { src, .. }
        | Inst::StoreProtoMethod { src, .. }
        | Inst::StoreMethod { src, .. } => vec![src.0],
        // --- captured into a closure / class value: every captured cell escapes ---
        Inst::AllocClosure { captures, .. } | Inst::AllocClassValue { captures, .. } => {
            captures.iter().map(|c| c.cell.0).collect()
        }
        // --- returned / thrown / suspended / proto-mutated: escapes ---
        Inst::Return { src } => src.iter().map(|s| s.0).collect(),
        Inst::Throw { src } => vec![src.0],
        Inst::Yield { operand, .. } | Inst::Await { operand, .. } => vec![operand.0],
        Inst::SetProto { obj, proto, .. } => vec![obj.0, proto.0],
        Inst::LoadMethodValue { recv, .. } => vec![recv.0],
        // --- sound read-only / value-producing / control ops: no escape. The loaded
        //     dst is a field/length/primitive (never the object; colliding classes
        //     share a layout), and console.log / typeof / delete use the runtime
        //     value dynamically. ---
        Inst::AllocObject { .. }
        | Inst::AllocArray { .. }
        | Inst::LoadBuiltinFn { .. }
        | Inst::LoadField { .. }
        | Inst::LoadElem { .. }
        | Inst::LoadIndex { .. }
        | Inst::LoadFieldDynamic { .. }
        | Inst::LoadGlobal { .. }
        | Inst::Const { .. }
        | Inst::BinOp { .. }
        | Inst::UnOp { .. }
        | Inst::ArrayLen { .. }
        | Inst::StringLen { .. }
        | Inst::GenericLen { .. }
        | Inst::HasField { .. }
        | Inst::HasFieldDynamic { .. }
        | Inst::DeleteField { .. }
        | Inst::ArraySlice { .. }
        | Inst::ObjectRest { .. }
        | Inst::ObjectCopyProps { .. }
        | Inst::GetProto { .. }
        | Inst::LoadClassProto { .. }
        | Inst::NewMap { .. }
        | Inst::NewSet { .. }
        | Inst::Print { .. }
        | Inst::Break { .. }
        | Inst::Continue { .. }
        | Inst::Loop { .. }
        | Inst::If { .. }
        | Inst::TryCatch { .. } => vec![],
    }
}

/// Compute the set of poly-tainted locals for a function (see module note above).
/// LOUD-FAILS (exits) if a tainted value escapes — never silently miscompiles.
fn compute_poly_taint(f: &Function) -> BTreeSet<u32> {
    let mut insts: Vec<&Inst> = Vec::new();
    flatten_insts(&f.body, &mut insts);
    let mut tainted: BTreeSet<u32> = BTreeSet::new();
    // seed
    for inst in &insts {
        if let Inst::NewDynamic {
            dst, poly: true, ..
        } = inst
        {
            tainted.insert(dst.0);
        }
    }
    if tainted.is_empty() {
        return tainted;
    }
    // fixpoint propagation over scalar aliasing (flow-insensitive over-approximation)
    loop {
        let mut changed = false;
        for inst in &insts {
            match inst {
                // a Copy aliases both ways: dst==src at runtime, and devirt may resolve
                // recv_class off either name, so taint must cover both.
                Inst::Copy { dst, src } => {
                    if tainted.contains(&src.0) && tainted.insert(dst.0) {
                        changed = true;
                    }
                    if tainted.contains(&dst.0) && tainted.insert(src.0) {
                        changed = true;
                    }
                }
                // dst = (ret is object ? ret : inst): dst aliases whichever, so taint
                // dst if either source is tainted.
                Inst::ConstructResult { dst, inst: i, ret } => {
                    if (tainted.contains(&i.0) || tainted.contains(&ret.0)) && tainted.insert(dst.0)
                    {
                        changed = true;
                    }
                }
                _ => {}
            }
        }
        if !changed {
            break;
        }
    }
    // escape check (after convergence): any tainted value reaching an escape position
    // could be Direct-devirtualized downstream -> loud-fail instead of miscompiling.
    for inst in &insts {
        for l in escape_locals(inst) {
            if tainted.contains(&l) {
                eprintln!(
                    "tsaot: unsupported: a polymorphic class value (new of `cond ? A : B` where A and B are structurally identical) escapes its constructing function (passed to a call, returned, thrown, stored, or captured). Only intra-function use (assign + method/field access) is supported; give the classes distinct shapes, or keep the instance local."
                );
                std::process::exit(1);
            }
        }
    }
    tainted
}

fn rewrite_body(
    body: &mut [Inst],
    fid: FunctionId,
    table: &ClassTable,
    use_rta: bool,
    tainted: &BTreeSet<u32>,
    out: &mut Vec<SiteDispatch>,
) {
    for (idx, inst) in body.iter_mut().enumerate() {
        match inst {
            Inst::Call { callee, recv, .. } => {
                if let CalleeRef::Method {
                    recv_class,
                    method,
                    recv_stable,
                    method_field,
                } = callee.clone()
                {
                    // A tainted (polymorphic-class) receiver's static class is
                    // untrustworthy -> force Dynamic (the actual class's prototype
                    // resolves the method at runtime), ignoring recv_class.
                    let recv_tainted = recv.map_or(false, |r| tainted.contains(&r.0));
                    let disp = if recv_tainted {
                        Dispatch::Dynamic
                    } else {
                        table.devirtualize(recv_class, method, recv_stable, use_rta)
                    };
                    *callee = match &disp {
                        Dispatch::Direct(func) => CalleeRef::Direct { func: *func },
                        Dispatch::Virtual { .. } => {
                            let funcs = table.impls(recv_class, method, use_rta);
                            if funcs.len() == 1 {
                                CalleeRef::Direct { func: funcs[0] }
                            } else if funcs.is_empty() {
                                CalleeRef::Unknown
                            }
                            // Multiple concrete implementations (genuine polymorphism,
                            // e.g. `const s: Shape = ...; s.area()` where several
                            // subclasses override `area`). Keep a dynamic Method
                            // callee so codegen dispatches through the receiver's
                            // actual prototype at runtime (each instance's prototype
                            // holds its own override). A CalleeRef::Set would only
                            // pick funcs.first() — wrong for mixed-type collections.
                            else {
                                CalleeRef::Method {
                                    recv_class,
                                    method,
                                    recv_stable,
                                    method_field,
                                }
                            }
                        }
                        // Keep the method name so codegen can do a faithful
                        // prototype-chain lookup on the dynamic path. Only a truly
                        // unresolvable callee becomes Unknown.
                        Dispatch::Dynamic => CalleeRef::Method {
                            recv_class,
                            method,
                            recv_stable,
                            method_field,
                        },
                    };
                    out.push(SiteDispatch {
                        function: fid,
                        index: idx,
                        dispatch: disp,
                    });
                }
            }
            Inst::Loop {
                cond_body, body, ..
            } => {
                rewrite_body(cond_body, fid, table, use_rta, tainted, out);
                rewrite_body(body, fid, table, use_rta, tainted, out);
            }
            Inst::If {
                then_body,
                else_body,
                ..
            } => {
                rewrite_body(then_body, fid, table, use_rta, tainted, out);
                rewrite_body(else_body, fid, table, use_rta, tainted, out);
            }
            Inst::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                rewrite_body(try_body, fid, table, use_rta, tainted, out);
                rewrite_body(catch_body, fid, table, use_rta, tainted, out);
                rewrite_body(finally_body, fid, table, use_rta, tainted, out);
            }
            _ => {}
        }
    }
}
