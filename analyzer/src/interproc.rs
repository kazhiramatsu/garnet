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
    /// A store under a computed key (`o[k] = v`); every load consults it.
    Dynamic,
    Capture(BindingId),
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Obj {
    Site(SiteId),
    Param(LocalId),
    /// Phantom: the contents of a parameter object's field (caller-provided).
    ParamField(LocalId, FieldKey),
    /// Phantom: anything reachable from a parameter object two or more loads
    /// deep under its field f (`p.f.g`, `p[0].list` under Elem); one node per
    /// (parameter, first field), the rest of the path is lost. Its escape is
    /// reported as the escape of the field's contents (`field_global`).
    ParamDeep(LocalId, FieldKey),
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

/// TSAOT_ESCAPE_PHANTOMS=0 restores the one-level phantoms that were not
/// reachable from their parameter (the parity oracle; unsound for a value
/// stored through a parameter's field, Session 350).
pub fn phantoms_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("TSAOT_ESCAPE_PHANTOMS").as_deref(),
            Ok("0") | Ok("false") | Ok("no") | Ok("off")
        )
    })
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
    /// The contents of a parameter's field (one or more loads deep): a store
    /// into them is a global escape of the value. Keeping the store path in the
    /// summary (`ParamField` bases) made the recursion nests' hub summaries
    /// accumulate twelve thousand entries and a solve take minutes; the
    /// precision only told ArgEscape from GlobalEscape, which the emitter does
    /// not distinguish (no caller arena).
    fn captured_contents(&self, o: Obj) -> bool {
        phantoms_enabled() && matches!(o, Obj::ParamField(_, _) | Obj::ParamDeep(_, _))
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
                        let phantoms = phantoms_enabled();
                        let mut acc = BTreeSet::new();
                        for o in &bases {
                            match *o {
                                // Phantom param-field: loading a field of a parameter
                                // object yields its caller-provided contents node.
                                Obj::Param(p) => {
                                    acc.insert(Obj::ParamField(p, f));
                                }
                                // Two or more loads deep: one node per (parameter, first field).
                                Obj::ParamField(p, f0) | Obj::ParamDeep(p, f0) if phantoms => {
                                    acc.insert(Obj::ParamDeep(p, f0));
                                }
                                // The contents of an external object are external.
                                Obj::External if phantoms => {
                                    acc.insert(Obj::External);
                                }
                                _ => {}
                            }
                            if let Some(s) = self.field.get(&(*o, f)) {
                                acc.extend(s.iter().copied());
                            }
                            // A dynamic store (`o[k] = v`) is recorded under Dynamic;
                            // any load may read it back.
                            if phantoms && f != FieldKey::Dynamic {
                                if let Some(s) = self.field.get(&(*o, FieldKey::Dynamic)) {
                                    acc.extend(s.iter().copied());
                                }
                            }
                        }
                        changed |= union_into(self.pt.entry(d).or_default(), &acc);
                    }
                    C::Store(b, f, s) => {
                        let bases = self.pt_clone(b);
                        let s = self.pt_clone(s);
                        for o in &bases {
                            if self.captured_contents(*o) {
                                changed |= union_into(self.pt.entry(Ref::Global).or_default(), &s);
                                continue;
                            }
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
                            if self.captured_contents(*o) {
                                changed |= self.pt.entry(Ref::Global).or_default().insert(v);
                                continue;
                            }
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
            // Fields are ordered by owner, then FieldKey. Visit only this
            // owner's adjacency list instead of scanning the whole graph for
            // every reachable object. Named is the first FieldKey variant and
            // Capture is the last, including their full ID ranges.
            let first = (o, FieldKey::Named(FieldId(0)));
            let last = (o, FieldKey::Capture(BindingId(u32::MAX)));
            for (_, tgts) in self.field.range(first..=last) {
                for t in tgts {
                    if set.insert(*t) {
                        work.push(*t);
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

#[cfg(test)]
mod reachability_tests {
    use super::*;

    #[test]
    fn field_ranges_preserve_reachability() {
        let objects = [
            Obj::Site(SiteId(0)),
            Obj::Site(SiteId(u32::MAX)),
            Obj::Param(LocalId(0)),
            Obj::ParamField(LocalId(0), FieldKey::Elem),
            Obj::External,
            Obj::Opaque(u32::MAX),
        ];
        let fields = [
            FieldKey::Named(FieldId(0)),
            FieldKey::Named(FieldId(u32::MAX)),
            FieldKey::Elem,
            FieldKey::Capture(BindingId(0)),
            FieldKey::Capture(BindingId(u32::MAX)),
        ];
        // Compare against independent full-graph propagation over graphs with
        // cycles, disconnected components and all key/owner boundary variants.
        for graph in 0..64 {
            let mut solver = Solver::default();
            for (i, &owner) in objects.iter().enumerate() {
                for (j, &field) in fields.iter().enumerate() {
                    if graph & (1 << i) != 0 {
                        solver
                            .field
                            .entry((owner, field))
                            .or_default()
                            .insert(objects[(i + j + graph) % objects.len()]);
                    }
                }
            }
            for &root in &objects {
                let seed = BTreeSet::from([root]);
                let mut expected = seed.clone();
                loop {
                    let previous = expected.clone();
                    for ((owner, _), targets) in &solver.field {
                        if previous.contains(owner) {
                            expected.extend(targets);
                        }
                    }
                    if expected == previous {
                        break;
                    }
                }
                assert_eq!(
                    solver.field_closure(seed),
                    expected,
                    "graph {graph}, root {root:?}"
                );
            }
        }
    }
}

// ------------------------------- summaries ------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum SObj {
    Param(usize),
    Internal,
    External,
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
    /// Some object of the callee's own (a site or a callee's callee's internals)
    /// is reachable from the global sink: the caller's opaque node is global.
    internal_global: bool,
    /// The summary keeps only the edges that touch a parameter or the return;
    /// the caller reads the internals of the opaque node as external.
    compact: bool,
}

impl Summary {
    /// The conservative summary: every reference argument escapes, the
    /// return is external. Above every precise summary in the lattice.
    fn top(nparams: usize) -> Self {
        let mut s = Summary::empty(nparams);
        s.param_global = vec![true; nparams];
        s.ret.insert(SObj::External);
        s
    }
    fn empty(nparams: usize) -> Self {
        Summary {
            nparams,
            param_global: vec![false; nparams],
            fields: BTreeSet::new(),
            ret: BTreeSet::new(),
            field_global: BTreeSet::new(),
            field_ret: BTreeSet::new(),
            internal_global: false,
            compact: false,
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

/// Program-wide facts the constraint builder consults.
struct Facts {
    /// Scope-record classes with more than TSAOT_RECORD_EXTERNAL_FIELDS fields
    /// (the checker's 2,251 bindings): such a record and everything stored in
    /// it is treated as external. Per-binding escape facts about a record of
    /// that size cost thousands of constraints per call site and were the
    /// reason the recursion nests' summaries did not converge.
    big_classes: BTreeSet<u32>,
}

fn record_external_fields() -> usize {
    std::env::var("TSAOT_RECORD_EXTERNAL_FIELDS").ok().and_then(|v| v.parse().ok()).unwrap_or(64)
}

/// The argument position of a callback that the builtin calls but does not
/// retain (the iteration methods of arrays, maps and sets, the comparator of
/// `sort`, the function form of `replace`, the map function of `Array.from`).
/// The callback's effects on its captured cells were applied when it was
/// created, and anything it returns from a captured variable was folded to
/// the global sink there, so the closure object itself need not escape. A
/// builtin that keeps its argument (`then`, `bind`, the containers' `set` /
/// `add` / `push`) is not listed and keeps the conservative rule.
fn callback_argument(builtin: &str) -> Option<usize> {
    if !phantoms_enabled() {
        return None;
    }
    match builtin {
        "array.forEach" | "array.some" | "array.every" | "array.filter" | "array.map"
        | "array.find" | "array.findIndex" | "array.findLast" | "array.findLastIndex"
        | "array.flatMap" | "array.reduce" | "array.reduceRight" | "array.sort"
        | "map.forEach" | "set.forEach" => Some(0),
        "string.replace" | "string.replaceAll" | "array.from" => Some(1),
        _ => None,
    }
}

fn build_constraints(f: &Function, summaries: &[Option<Summary>], facts: &Facts) -> (Vec<C>, Vec<SiteId>) {
    let mut is_ref_map: BTreeMap<LocalId, bool> = BTreeMap::new();
    for l in &f.locals {
        is_ref_map.insert(l.id, !matches!(l.ref_kind, RefKind::Primitive));
    }
    let is_ref = |id: LocalId| is_ref_map.get(&id).copied().unwrap_or(true);

    let mut cs: Vec<C> = Vec::new();
    let mut sites: Vec<SiteId> = Vec::new();
    let mut opaque: u32 = 0;
    let mut temp: u32 = 0;

    for (i, &p) in f.params.iter().enumerate() {
        if is_ref(p) {
            let big = phantoms_enabled()
                && (i as u32) < f.capture_count
                && f.param_classes.get(&p.0.to_string()).is_some_and(|c| facts.big_classes.contains(c));
            if big {
                cs.push(C::Addr(Ref::Local(p), Obj::External));
            } else {
                cs.push(C::Addr(Ref::Local(p), Obj::Param(p)));
            }
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
            Inst::AllocObject { dst, site, class_id, .. } => {
                cs.push(C::Addr(Ref::Local(dst), Obj::Site(site)));
                sites.push(site);
                // a big scope record is external: it and its contents escape
                if phantoms_enabled() && class_id.is_some_and(|c| facts.big_classes.contains(&c.0)) {
                    cs.push(C::Addr(Ref::Local(dst), Obj::External));
                    cs.push(C::Copy(Ref::Global, Ref::Local(dst)));
                }
            }
            Inst::AllocArray { dst, site, .. } => {
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
            // A load into a primitive-kind local (a `number` field, typed mode)
            // carries no reference: no phantom, no escape through it.
            Inst::LoadField { dst, obj, field, .. } => {
                if is_ref(dst) || !phantoms_enabled() {
                    cs.push(C::Load(Ref::Local(dst), Ref::Local(obj), FieldKey::Named(field)))
                }
            }
            Inst::StoreField { obj, field, src, .. } => cs.push(C::Store(
                Ref::Local(obj),
                FieldKey::Named(field),
                Ref::Local(src),
            )),
            Inst::LoadElem { dst, arr } => {
                if is_ref(dst) || !phantoms_enabled() {
                    cs.push(C::Load(Ref::Local(dst), Ref::Local(arr), FieldKey::Elem))
                }
            }
            Inst::StoreElem { arr, src } => {
                cs.push(C::Store(Ref::Local(arr), FieldKey::Elem, Ref::Local(src)))
            }
            Inst::LoadIndex { dst, arr, .. } => {
                if is_ref(dst) || !phantoms_enabled() {
                    cs.push(C::Load(Ref::Local(dst), Ref::Local(arr), FieldKey::Elem))
                }
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
                let key = if phantoms_enabled() { FieldKey::Dynamic } else { FieldKey::Elem };
                cs.push(C::Store(Ref::Local(obj), key, Ref::Local(src)));
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
                ref builtin,
            } => {
                cs.push(C::Copy(Ref::Global, Ref::Local(recv)));
                let callback = callback_argument(builtin);
                for (i, a) in args.iter().enumerate() {
                    if Some(i) == callback {
                        continue;
                    }
                    cs.push(C::Copy(Ref::Global, Ref::Local(*a)));
                }
                if let Some(d) = dst {
                    if is_ref(d) {
                        cs.push(C::Addr(Ref::Local(d), Obj::External));
                    }
                }
            }
            Inst::CallBuiltinStatic { dst, ref args, ref builtin } => {
                let callback = callback_argument(builtin);
                for (i, a) in args.iter().enumerate() {
                    if Some(i) == callback {
                        continue;
                    }
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
    if sum.compact {
        // the callee's internals are opaque: every load from them is external
        cs.push(C::AddrField(op, FieldKey::Dynamic, Obj::External));
    }
    if sum.internal_global {
        cs.push(C::AddrField(Obj::External, FieldKey::Dynamic, op));
    }

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
    // At a closure's creation the body's return is unknown to any caller: a
    // captured value (a by-value capture is a leading parameter) that the
    // body may return leaks once the closure is invoked, exactly as a cell's
    // contents do through field_ret below.
    if creation && phantoms_enabled() {
        for s in &sum.ret {
            if let SObj::Param(i) = *s {
                if i < actuals.len() && is_ref(actuals[i]) {
                    cs.push(C::Copy(Ref::Global, Ref::Local(actuals[i])));
                }
            }
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
        }
    };
    let as_val = |s: SObj| -> Side {
        match s {
            SObj::Param(j) if j < actuals.len() => Side::Ref(actuals[j]),
            SObj::Param(_) => Side::None,
            SObj::Internal => Side::Obj(op),
            SObj::External => Side::Obj(Obj::External),
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
                    SObj::External => cs.push(C::Addr(Ref::Local(d), Obj::External)),
                }
            }
        }
    }
}

// ----------------------------- extraction -------------------------------------

/// TSAOT_ESCAPE_MAX_CONSTRAINTS: a function whose constraint set exceeds this
/// is not solved; every site of it escapes and its summary is conservative
/// (the compiler's `__module_init` builds 400k constraints with the phantom
/// links and took seven seconds per solve).
fn constraint_budget() -> usize {
    static N: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *N.get_or_init(|| {
        std::env::var("TSAOT_ESCAPE_MAX_CONSTRAINTS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(200_000)
    })
}

/// Every site and reference parameter escapes, the return is external.
fn conservative_constraints(f: &Function, sites: &[SiteId]) -> Vec<C> {
    let mut cs = Vec::new();
    for inst in {
        let mut flat = Vec::new();
        flatten_bodies(&f.body, &mut flat);
        flat
    } {
        match inst {
            Inst::AllocObject { dst, site, .. }
            | Inst::AllocArray { dst, site, .. }
            | Inst::AllocClosure { dst, site, .. } => {
                debug_assert!(sites.contains(&site));
                cs.push(C::Addr(Ref::Local(dst), Obj::Site(site)));
                cs.push(C::Copy(Ref::Global, Ref::Local(dst)));
            }
            _ => {}
        }
    }
    for &p in &f.params {
        if is_reflike(f, p) {
            cs.push(C::Addr(Ref::Local(p), Obj::Param(p)));
            cs.push(C::Copy(Ref::Global, Ref::Local(p)));
        }
    }
    cs.push(C::Addr(Ref::Ret, Obj::External));
    cs
}

fn solve(f: &Function, summaries: &[Option<Summary>], facts: &Facts) -> (Solver, Vec<SiteId>) {
    let started = std::time::Instant::now();
    let (mut cs, sites) = build_constraints(f, summaries, facts);
    if phantoms_enabled() && cs.len() > constraint_budget() {
        if interproc_trace() {
            eprintln!(
                "[interproc] fn {} {:?}: {} constraints over the budget, conservative",
                f.id.0, f.name, cs.len()
            );
        }
        cs = conservative_constraints(f, &sites);
    }
    let mut s = Solver::default();
    s.solve(&cs);
    if interproc_trace() && (started.elapsed().as_millis() >= 200 || cs.len() >= 50000) {
        let pt: usize = s.pt.values().map(|v| v.len()).sum();
        let fl: usize = s.field.values().map(|v| v.len()).sum();
        eprintln!(
            "[interproc] slow solve {:.2}s fn {} {:?}: {} constraints, pt {} entries/{} objs, field {} keys/{} objs",
            started.elapsed().as_secs_f64(), f.id.0, f.name, cs.len(), s.pt.len(), pt, s.field.len(), fl
        );
    }
    (s, sites)
}

fn extract_summary(f: &Function, solver: &Solver, compact: bool) -> Summary {
    let param_index: BTreeMap<LocalId, usize> =
        f.params.iter().enumerate().map(|(i, p)| (*p, i)).collect();
    let phantoms = phantoms_enabled();
    // A phantom (the contents of a parameter) stored as a VALUE or returned is
    // collapsed to External: one node, no path. Keeping phantom values
    // distinct made the points-to sets of the configuration and
    // module-resolution functions explode (millions of entries). A phantom is
    // never the BASE of a recorded store (the solver sends such stores to the
    // global sink).
    let map = |o: Obj| -> SObj {
        match o {
            Obj::Site(_) | Obj::Opaque(_) => SObj::Internal,
            Obj::ParamField(_, _) | Obj::ParamDeep(_, _) if phantoms => SObj::External,
            Obj::ParamField(_, _) | Obj::ParamDeep(_, _) => SObj::Internal,
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
        // the deep contents under a field escaping means the field's contents do
        if let Obj::ParamField(p, fk) | Obj::ParamDeep(p, fk) = o {
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

    let internal_global = phantoms
        && global
            .iter()
            .any(|o| matches!(o, Obj::Site(_) | Obj::Opaque(_)));
    let mut fields = BTreeSet::new();
    for ((o, key), tgts) in solver.field.iter() {
        let so = map(*o);
        if matches!(so, SObj::Param(i) if i == usize::MAX) {
            continue;
        }
        for t in tgts {
            let sv = map(*t);
            if compact {
                // keep only the edges that touch a parameter: the caller
                // reads the callee's internals as external (apply_summary)
                if !matches!(so, SObj::Param(_)) && !matches!(sv, SObj::Param(_)) {
                    continue;
                }
            }
            fields.insert((so, *key, sv));
        }
    }
    let ret: BTreeSet<SObj> = solver
        .pt_clone(Ref::Ret)
        .into_iter()
        .filter(|o| !(phantoms && matches!(o, Obj::ParamField(_, _))))
        .map(map)
        .collect();

    if std::env::var("TSAOT_INTERPROC_SHOW").ok().and_then(|v| v.parse::<u32>().ok()) == Some(f.id.0) {
        eprintln!(
            "[interproc] summary fn {} {:?}: params {} global {:?}, ret {:?}, field_global {:?}, field_ret {:?}, fields {:?}",
            f.id.0, f.name, f.params.len(), param_global, ret, field_global, field_ret, fields
        );
    }
    if interproc_trace() && fields.len() >= 300 {
        let mut by_base: BTreeMap<&'static str, usize> = BTreeMap::new();
        for (b, _, _) in &fields {
            let k = match b {
                SObj::Param(_) => "param",
                SObj::Internal => "internal",
                SObj::External => "external",
            };
            *by_base.entry(k).or_default() += 1;
        }
        eprintln!(
            "[interproc] big summary fn {} {:?}: fields {} {:?}, ret {}, field_global {}, field_ret {}",
            f.id.0, f.name, fields.len(), by_base, ret.len(), field_global.len(), field_ret.len()
        );
    }
    Summary {
        nparams: f.params.len(),
        param_global,
        fields,
        ret,
        field_global,
        field_ret,
        internal_global,
        compact,
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

fn record_defined_local(inst: &Inst, defined: &mut BTreeSet<LocalId>) {
    match inst {
        Inst::AllocObject { dst, .. }
        | Inst::AllocArray { dst, .. }
        | Inst::AllocClosure { dst, .. }
        | Inst::Copy { dst, .. }
        | Inst::Const { dst, .. } => {
            defined.insert(*dst);
        }
        _ => {}
    }
}

fn loop_links_new_to_carrier(body: &[Inst], fresh: LocalId, carrier: LocalId) -> bool {
    body.iter().any(|inst| match inst {
        Inst::Call { recv, args, .. } => {
            recv == &Some(fresh) && args.contains(&carrier)
        }
        Inst::StoreField { obj, src, .. } | Inst::StoreFieldDynamic { obj, src, .. } => {
            *obj == fresh && *src == carrier
        }
        Inst::If {
            then_body,
            else_body,
            ..
        } => {
            loop_links_new_to_carrier(then_body, fresh, carrier)
                || loop_links_new_to_carrier(else_body, fresh, carrier)
        }
        Inst::TryCatch {
            try_body,
            catch_body,
            finally_body,
            ..
        } => {
            loop_links_new_to_carrier(try_body, fresh, carrier)
                || loop_links_new_to_carrier(catch_body, fresh, carrier)
                || loop_links_new_to_carrier(finally_body, fresh, carrier)
        }
        _ => false,
    })
}

fn inspect_accumulating_loop(
    body: &[Inst],
    defined_before: &BTreeSet<LocalId>,
    contained: &BTreeSet<u32>,
    out: &mut BTreeSet<u32>,
) {
    let mut allocs = BTreeMap::<LocalId, SiteId>::new();
    for inst in body {
        match inst {
            Inst::AllocObject { dst, site, .. }
            | Inst::AllocArray { dst, site, .. }
            | Inst::AllocClosure { dst, site, .. } => {
                allocs.insert(*dst, *site);
            }
            _ => {}
        }
    }

    for inst in body {
        match inst {
            // `outer.push(newValue)` retains every iteration's value in a
            // container whose lifetime began before the loop.
            Inst::ArrayPush { arr, src } if defined_before.contains(arr) => {
                if let Some(site) = allocs.get(src) {
                    if contained.contains(&site.0) {
                        out.insert(site.0);
                    }
                }
            }
            // `next = new Node(..., previous); previous = next` forms a
            // loop-carried retained chain. Require the constructor/store to
            // link the old carrier into the fresh cell; a plain overwrite does
            // not qualify and should stay nursery-allocated.
            Inst::Copy { dst, src } if defined_before.contains(dst) => {
                if let Some(site) = allocs.get(src) {
                    if contained.contains(&site.0)
                        && loop_links_new_to_carrier(body, *src, *dst)
                    {
                        out.insert(site.0);
                    }
                }
            }
            _ => {}
        }
    }
}

fn collect_accumulating_sites(
    body: &[Inst],
    defined: &mut BTreeSet<LocalId>,
    contained: &BTreeSet<u32>,
    out: &mut BTreeSet<u32>,
) {
    for inst in body {
        match inst {
            Inst::Loop {
                cond_body,
                body: loop_body,
                ..
            } => {
                inspect_accumulating_loop(loop_body, defined, contained, out);
                let mut nested_defined = defined.clone();
                collect_accumulating_sites(cond_body, &mut nested_defined, contained, out);
                collect_accumulating_sites(loop_body, &mut nested_defined, contained, out);
            }
            Inst::If {
                then_body,
                else_body,
                ..
            } => {
                let mut then_defined = defined.clone();
                let mut else_defined = defined.clone();
                collect_accumulating_sites(then_body, &mut then_defined, contained, out);
                collect_accumulating_sites(else_body, &mut else_defined, contained, out);
                defined.extend(then_defined.intersection(&else_defined).copied());
            }
            Inst::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                let mut nested_defined = defined.clone();
                collect_accumulating_sites(try_body, &mut nested_defined, contained, out);
                collect_accumulating_sites(catch_body, &mut nested_defined, contained, out);
                collect_accumulating_sites(finally_body, &mut nested_defined, contained, out);
            }
            _ => record_defined_local(inst, defined),
        }
    }
}

fn pretenure_candidates(
    program: &Program,
    escapes: &[SiteEscape],
    contained: &BTreeSet<u32>,
) -> BTreeSet<u32> {
    let meta: BTreeMap<u32, &SiteMeta> =
        program.site_meta.iter().map(|m| (m.site.0, m)).collect();
    let states: BTreeMap<u32, EscapeState> =
        escapes.iter().map(|s| (s.site.0, s.state)).collect();
    let mut out = BTreeSet::new();

    // Module initialization executes exactly once. A single-shot allocation
    // proven to GlobalEscape is expected to remain reachable for module/process
    // lifetime, so nursery copying has no upside.
    for function in &program.functions {
        if function.name.as_deref() != Some("__module_init") {
            continue;
        }
        let mut sites = Vec::new();
        flatten_bodies(&function.body, &mut sites);
        for inst in sites {
            let site = match inst {
                Inst::AllocObject { site, .. }
                | Inst::AllocArray { site, .. }
                | Inst::AllocClosure { site, .. } => site,
                _ => continue,
            };
            let once = matches!(
                meta.get(&site.0).map(|m| m.multiplicity),
                Some(Multiplicity::Once)
            );
            if once && states.get(&site.0) == Some(&EscapeState::GlobalEscape) {
                out.insert(site.0);
            }
        }
    }

    // Within ordinary functions, identify only structural accumulation:
    // retained chains and append-only outer containers. Ring-buffer indexed
    // stores and plain loop-carried overwrites intentionally do not qualify.
    for function in &program.functions {
        let mut defined: BTreeSet<LocalId> = function.params.iter().copied().collect();
        collect_accumulating_sites(&function.body, &mut defined, contained, &mut out);
    }
    out
}

// ------------------------------- driver ---------------------------------------

/// Solves per member of a recursion nest before the nest gives up on summaries
/// (the compiler's nests converge in two to four solves per member).
const SCC_SOLVE_BUDGET: usize = 8;
/// A recursion nest with more members than this gets no summaries at all. The
/// checker's nested functions form one nest of about two thousand members
/// whose solves cost tens of milliseconds each; iterating it is minutes of
/// analysis for summaries the budget would discard anyway.
const SCC_SUMMARY_MAX_MEMBERS: usize = 128;

/// Members of a nest beyond SCC_SUMMARY_MAX_MEMBERS are summarized with
/// compact summaries and widening (`docs/nest_summaries_design.md`); such a
/// nest is capped here instead. TSAOT_NEST_MAX overrides (0 skips every nest
/// above the small cap, the previous behavior).
const SCC_LARGE_NEST_MAX_MEMBERS: usize = 4096;
/// Solves of a large-nest member after which a still-changing summary is
/// widened to the conservative one (the member is not solved again).
const SCC_LARGE_NEST_WIDEN_AT: usize = 6;

/// TSAOT_NEST_BUDGET / TSAOT_NEST_MAX / TSAOT_NEST_WIDEN override the nest limits.
fn scc_solve_budget() -> usize {
    std::env::var("TSAOT_NEST_BUDGET").ok().and_then(|v| v.parse().ok()).unwrap_or(SCC_SOLVE_BUDGET)
}
fn scc_summary_max_members() -> usize {
    let default = if phantoms_enabled() { SCC_LARGE_NEST_MAX_MEMBERS } else { SCC_SUMMARY_MAX_MEMBERS };
    std::env::var("TSAOT_NEST_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}
fn scc_widen_at(members: usize) -> usize {
    if members <= SCC_SUMMARY_MAX_MEMBERS {
        return 0;
    }
    std::env::var("TSAOT_NEST_WIDEN").ok().and_then(|v| v.parse().ok()).unwrap_or(SCC_LARGE_NEST_WIDEN_AT)
}

/// Compact summaries for the members of a recursion nest (TSAOT_NEST_COMPACT=0
/// keeps the full summaries; the old mode never compacts).
fn compact_nests() -> bool {
    phantoms_enabled() && !matches!(std::env::var("TSAOT_NEST_COMPACT").as_deref(), Ok("0"))
}

fn interproc_trace() -> bool {
    std::env::var("TSAOT_INTERPROC_TRACE").map(|v| v == "1").unwrap_or(false)
}

pub fn analyze_program(program: &Program) -> EscapeResult {
    let cg = build_call_graph(program);
    let limit = record_external_fields();
    let facts = Facts {
        big_classes: program
            .classes
            .iter()
            .filter(|c| c.name.as_deref().is_some_and(|n| n.starts_with("__ctx_")) && c.own_fields.len() > limit)
            .map(|c| c.id.0)
            .collect(),
    };
    if interproc_trace() {
        eprintln!("[interproc] big scope records (> {} fields): {}", limit, facts.big_classes.len());
    }
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
            let (solver, _) = solve(f, &summaries, &facts);
            summaries[scc[0].0 as usize] = Some(extract_summary(f, &solver, false));
        } else if scc.len() > scc_summary_max_members() {
            // Already None; the constraint builder treats a callee without a
            // summary as unknown (every reference argument escapes), the
            // precision these calls had while they went through closure values.
            if interproc_trace() {
                eprintln!("[interproc] nest of {} functions: skipped, no summaries", scc.len());
                let ids: Vec<String> = scc.iter().map(|m| m.0.to_string()).collect();
                eprintln!("[interproc] nest members: {}", ids.join(" "));
            }
        } else {
            for m in scc {
                let Some(&f) = by_id.get(&m.0) else { continue };
                summaries[m.0 as usize] = Some(Summary::empty(f.params.len()));
            }
            // Worklist over the recursion nest: a member is re-solved only when
            // the summary of one of its callees inside the nest changed. The
            // checker's nested functions (direct calls since Session 350) form
            // one nest of about two thousand members; re-solving every member
            // per sweep did not converge in twenty minutes. The work is bounded:
            // past SCC_SOLVE_BUDGET solves per member the whole nest falls back
            // to no summary, which the constraint builder treats as an unknown
            // callee (every reference argument escapes) — the precision the
            // call graph without these edges had.
            let members: BTreeSet<u32> = scc.iter().map(|m| m.0).collect();
            let mut nest_callers: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
            for m in scc {
                for g in &cg.callees[m.0 as usize] {
                    if members.contains(&g.0) {
                        nest_callers.entry(g.0).or_default().push(m.0);
                    }
                }
            }
            // Callees before callers: a postorder over the nest's own call
            // edges gives each member a rank, and the worklist pops the
            // lowest rank first, so a change in a callee is consumed by its
            // callers after every other pending callee has been solved.
            let rank: BTreeMap<u32, usize> = {
                let mut order: Vec<u32> = Vec::new();
                let mut seen: BTreeSet<u32> = BTreeSet::new();
                for &root in &members {
                    if seen.contains(&root) { continue; }
                    let mut stack: Vec<(u32, usize)> = vec![(root, 0)];
                    seen.insert(root);
                    while let Some(&mut (v, ref mut i)) = stack.last_mut() {
                        let succ = &cg.callees[v as usize];
                        if *i < succ.len() {
                            let w = succ[*i].0;
                            *i += 1;
                            if members.contains(&w) && seen.insert(w) {
                                stack.push((w, 0));
                            }
                        } else {
                            order.push(v);
                            stack.pop();
                        }
                    }
                }
                if phantoms_enabled() {
                    order.iter().enumerate().map(|(r, id)| (*id, r)).collect()
                } else {
                    // the old mode keeps the seeding order of the nest
                    scc.iter().enumerate().map(|(r, m)| (m.0, r)).collect()
                }
            };
            let ordered = phantoms_enabled();
            let mut seq: usize = members.len();
            let mut queue: BTreeSet<(usize, u32)> = members.iter().map(|m| (rank[m], *m)).collect();
            let mut queued: BTreeSet<u32> = members.clone();
            let budget = scc.len() * scc_solve_budget();
            let nest_started = std::time::Instant::now();
            let widen_at = scc_widen_at(scc.len());
            let mut solves_per: BTreeMap<u32, usize> = BTreeMap::new();
            let mut frozen: BTreeSet<u32> = BTreeSet::new();
            let mut solves = 0usize;
            let mut converged = true;
            while let Some((_, id)) = queue.pop_first() {
                queued.remove(&id);
                if frozen.contains(&id) {
                    continue;
                }
                let Some(&f) = by_id.get(&id) else { continue };
                if solves >= budget {
                    converged = false;
                    break;
                }
                solves += 1;
                *solves_per.entry(id).or_default() += 1;
                if interproc_trace() && scc.len() > 100 && solves % 200 == 0 {
                    eprintln!(
                        "[interproc]   nest of {}: {} solves, {} queued, {:.1}s",
                        scc.len(), solves, queue.len(), nest_started.elapsed().as_secs_f64()
                    );
                }
                let (solver, _) = solve(f, &summaries, &facts);
                let mut s = extract_summary(f, &solver, compact_nests());
                if summaries[id as usize].as_ref() != Some(&s) {
                    // Widening: a member still changing after `widen_at` solves
                    // takes the conservative summary and is not solved again.
                    if widen_at > 0 && solves_per[&id] >= widen_at {
                        s = Summary::top(f.params.len());
                        frozen.insert(id);
                    }
                    summaries[id as usize] = Some(s);
                    if let Some(callers) = nest_callers.get(&id) {
                        for &c in callers {
                            if queued.insert(c) {
                                let key = if ordered { rank[&c] } else { seq };
                                seq += 1;
                                queue.insert((key, c));
                            }
                        }
                    }
                }
            }
            if !converged {
                for m in scc {
                    summaries[m.0 as usize] = None;
                }
            }
            if interproc_trace() {
                let mut hist: BTreeMap<usize, usize> = BTreeMap::new();
                for v in solves_per.values() { *hist.entry(*v).or_default() += 1; }
                eprintln!(
                    "[interproc] nest of {} functions: {} solves, {} widened, {:.1}s, solves/member {:?}, {}",
                    scc.len(),
                    solves,
                    frozen.len(),
                    nest_started.elapsed().as_secs_f64(),
                    hist,
                    if converged { "converged" } else { "budget exhausted, no summaries" }
                );
            }
        }
    }

    let mut out = Vec::new();
    let mut contained = std::collections::BTreeSet::new();
    for f in &program.functions {
        let (solver, sites) = solve(f, &summaries, &facts);
        // containment: field マップの値集合に現れる site は「何かのコンテナに
        // 格納されて」いる。関数レベルでは NoEscape でも反復を跨いで生存し得る
        // ため、codegen の per-iteration stack slot 判断から除外する材料になる。
        for set in solver.field.values() {
            for o in set {
                if let Obj::Site(sid) = o {
                    contained.insert(sid.0);
                }
            }
        }
        out.extend(extract_escape(f, &solver, &sites));
    }
    let pretenure_sites = pretenure_candidates(program, &out, &contained);
    EscapeResult {
        version: SCHEMA_VERSION,
        sites: out,
        contained_sites: contained,
        pretenure_sites,
    }
}
