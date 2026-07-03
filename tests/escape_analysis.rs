//! P1 — intraprocedural escape analysis over the Escape IR.
//!
//! Model: a flow-insensitive, field-sensitive points-to (connection) graph,
//! solved as Andersen-style inclusion constraints. Escape state is then read
//! off by reachability:
//!   * objects reachable from the GLOBAL sink (or external results) -> GlobalEscape,
//!   * objects reachable from parameters / return            -> ArgEscape,
//!   * everything else                                       -> NoEscape.
//!
//! P1 scope / conservative choices (refined in later phases):
//!   * Calls are treated as `Unknown`: every reference argument/receiver leaks
//!     to GLOBAL and the result is an external (escaped) object. Interprocedural
//!     summaries (P2/P3) will replace this.
//!   * Closures are NOT special-cased in the solver: `AllocClosure` just adds a
//!     field edge from the closure object to each captured cell (per the capture
//!     lowering spec), so the ordinary object/field machinery handles them.
//!   * `isExported` is not yet used to promote ArgEscape -> GlobalEscape (P3).
//!
//! The analyzer reads only `Function.{params, locals, body}`; it never touches
//! the type/field/scope/binding tables — that separation is by design.

use std::collections::{BTreeMap, BTreeSet};

use crate::escape_ir::*;

/// An object node within a single function's connection graph.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Obj {
    /// An allocation we own (object / array / closure / cell), keyed by its site.
    Site(SiteId),
    /// Opaque object passed in through a reference parameter (caller-owned).
    Param(LocalId),
    /// Result of an unknown call or a load from global — always GlobalEscape.
    External,
}

/// A field selector. Field-sensitive on named fields; arrays are index-insensitive.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum FieldKey {
    Named(FieldId),
    /// Collapsed array element.
    Elem,
    /// A closure object's reference to a captured cell.
    Capture(BindingId),
}

/// A points-to set holder (the "reference" side of the graph).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Ref {
    Local(LocalId),
    Ret,
    Global,
}

/// One inclusion constraint.
#[derive(Clone, Copy, Debug)]
enum C {
    /// obj ∈ PT(ref)
    Addr(Ref, Obj),
    /// PT(src) ⊆ PT(dst)
    Copy(Ref, Ref),
    /// dst = base.f : ∀o∈PT(base). PT(o.f) ⊆ PT(dst)
    Load(Ref, Ref, FieldKey),
    /// base.f = src : ∀o∈PT(base). PT(src) ⊆ PT(o.f)
    Store(Ref, FieldKey, Ref),
    /// obj.f ⊇ PT(src), where the base object is a literal (closure capture).
    StoreObj(Obj, FieldKey, Ref),
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

    fn solve(&mut self, constraints: &[C]) {
        let mut changed = true;
        while changed {
            changed = false;
            for &c in constraints {
                match c {
                    C::Addr(r, o) => {
                        changed |= self.pt.entry(r).or_default().insert(o);
                    }
                    C::Copy(dst, src) => {
                        let s = self.pt_clone(src);
                        changed |= union_into(self.pt.entry(dst).or_default(), &s);
                    }
                    C::Load(dst, base, f) => {
                        let bases = self.pt_clone(base);
                        let mut acc = BTreeSet::new();
                        for o in &bases {
                            if let Some(s) = self.field.get(&(*o, f)) {
                                acc.extend(s.iter().copied());
                            }
                        }
                        changed |= union_into(self.pt.entry(dst).or_default(), &acc);
                    }
                    C::Store(base, f, src) => {
                        let bases = self.pt_clone(base);
                        let s = self.pt_clone(src);
                        for o in &bases {
                            changed |= union_into(self.field.entry((*o, f)).or_default(), &s);
                        }
                    }
                    C::StoreObj(o, f, src) => {
                        let s = self.pt_clone(src);
                        changed |= union_into(self.field.entry((o, f)).or_default(), &s);
                    }
                }
            }
        }
    }

    /// Close a seed object set under field edges: if an escaped object holds a
    /// reference, the referent escapes at least as much.
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
}

/// Analyze a whole program. Site ids are program-global, so results concatenate.
pub fn analyze(program: &Program) -> EscapeResult {
    let mut sites = Vec::new();
    for f in &program.functions {
        sites.extend(analyze_function(f));
    }
    EscapeResult { version: SCHEMA_VERSION, sites, contained_sites: Default::default() }
}

fn analyze_function(f: &Function) -> Vec<SiteEscape> {
    // ref_kind lookup (LocalId -> is-reference).
    let mut is_ref: BTreeMap<LocalId, bool> = BTreeMap::new();
    for l in &f.locals {
        is_ref.insert(l.id, matches!(l.ref_kind, RefKind::Reference));
    }
    let is_ref = |id: LocalId| is_ref.get(&id).copied().unwrap_or(false);

    let mut cs: Vec<C> = Vec::new();
    let mut order: Vec<SiteId> = Vec::new(); // sites in encounter order

    // Reference parameters get an opaque caller-owned placeholder object.
    for &p in &f.params {
        if is_ref(p) {
            cs.push(C::Addr(Ref::Local(p), Obj::Param(p)));
        }
    }

    for inst in &f.body {
        match *inst {
            Inst::AllocObject { dst, site, .. } | Inst::AllocArray { dst, site, .. } => {
                cs.push(C::Addr(Ref::Local(dst), Obj::Site(site)));
                order.push(site);
            }
            Inst::AllocClosure { dst, ref captures, site, .. } => {
                cs.push(C::Addr(Ref::Local(dst), Obj::Site(site)));
                order.push(site);
                // The closure object references each captured cell.
                for cap in captures {
                    cs.push(C::StoreObj(
                        Obj::Site(site),
                        FieldKey::Capture(cap.binding),
                        Ref::Local(cap.cell),
                    ));
                }
            }
            Inst::Copy { dst, src } => {
                cs.push(C::Copy(Ref::Local(dst), Ref::Local(src)));
            }
            Inst::LoadField { dst, obj, field } => {
                cs.push(C::Load(Ref::Local(dst), Ref::Local(obj), FieldKey::Named(field)));
            }
            Inst::StoreField { obj, field, src } => {
                cs.push(C::Store(Ref::Local(obj), FieldKey::Named(field), Ref::Local(src)));
            }
            Inst::LoadElem { dst, arr } => {
                cs.push(C::Load(Ref::Local(dst), Ref::Local(arr), FieldKey::Elem));
            }
            Inst::StoreElem { arr, src } => {
                cs.push(C::Store(Ref::Local(arr), FieldKey::Elem, Ref::Local(src)));
            }
            Inst::Call { dst, ref recv, ref args, .. } => {
                // Conservative P1: every reference arg/recv leaks to GLOBAL.
                if let Some(r) = recv {
                    if is_ref(*r) {
                        cs.push(C::Copy(Ref::Global, Ref::Local(*r)));
                    }
                }
                for &a in args {
                    if is_ref(a) {
                        cs.push(C::Copy(Ref::Global, Ref::Local(a)));
                    }
                }
                if let Some(d) = dst {
                    if is_ref(d) {
                        cs.push(C::Addr(Ref::Local(d), Obj::External));
                    }
                }
            }
            Inst::Return { src } => {
                if let Some(s) = src {
                    cs.push(C::Copy(Ref::Ret, Ref::Local(s)));
                }
            }
            Inst::Throw { src } => {
                cs.push(C::Copy(Ref::Global, Ref::Local(src)));
            }
            Inst::StoreGlobal { src, .. } => {
                cs.push(C::Copy(Ref::Global, Ref::Local(src)));
            }
            Inst::LoadGlobal { dst, .. } => {
                if is_ref(dst) {
                    cs.push(C::Addr(Ref::Local(dst), Obj::External));
                }
            }
            // Codegen-only instructions (constants, arithmetic, print, structured
            // control flow) introduce no points-to/escape constraints in P1.
            _ => {}
        }
    }

    let mut solver = Solver::default();
    solver.solve(&cs);

    // GlobalEscape seed: the global sink + external results.
    let mut g_seed = solver.pt_clone(Ref::Global);
    g_seed.insert(Obj::External);
    let global = solver.field_closure(g_seed);

    // ArgEscape seed: return targets + reference-parameter objects.
    let mut a_seed = solver.pt_clone(Ref::Ret);
    for &p in &f.params {
        if is_ref(p) {
            a_seed.extend(solver.pt_clone(Ref::Local(p)));
        }
    }
    let arg = solver.field_closure(a_seed);

    order
        .into_iter()
        .map(|site| {
            let o = Obj::Site(site);
            let state = if global.contains(&o) {
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
