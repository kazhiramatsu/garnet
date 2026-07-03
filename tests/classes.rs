//! Class vtable layout + devirtualization for the TS->C AOT backend.
//!
//! TS classes are JS classes (prototype-based, mutable, structurally reachable
//! via `any`). A static vtable is only sound when the relevant slice of the
//! hierarchy is *closed* and *stable*. This module encodes that as a first-class
//! decision: a call resolves to
//!   Direct(f)            — one possible implementation (devirtualized, inlinable)
//!   Virtual{slot}        — several known implementations (O(1) vtable dispatch)
//!   Dynamic              — open/unstable receiver: fall back to runtime lookup
//!
//! Layout is C++-style single-inheritance: a subclass's fields/vtable extend the
//! parent's as a fixed prefix, so a method's slot (and a field's offset) is
//! stable across every subclass and a supertype-typed reference can index it.
//!
//! `stable=false` (prototype mutated / reached via `any` / dynamic shape change)
//! forces Dynamic — this is the guard that keeps us correct under JS semantics.

use std::collections::{BTreeMap, BTreeSet};

pub type ClassId = u32;
pub type Name = u32; // interned member name
pub type FuncId = u32;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MKind { Method, Getter, Setter }

#[derive(Clone, Debug)]
pub struct Method {
    pub name: Name,
    pub func: FuncId,
    pub kind: MKind,
}

#[derive(Clone, Debug)]
pub struct Class {
    pub id: ClassId,
    pub parent: Option<ClassId>,
    /// Instance methods/accessors declared in *this* class (incl. overrides).
    pub own_methods: Vec<Method>,
    /// Data fields declared in *this* class (own), in declaration order.
    pub own_fields: Vec<Name>,
    /// RTA: is `new C(...)` reachable anywhere in the program?
    pub instantiated: bool,
    /// Proven stable: prototype not mutated, no dynamic shape change, not
    /// reached via `any`/cast. Only stable classes may be devirtualized / laid
    /// out with fixed slots; otherwise we must use a dynamic prototype lookup.
    pub stable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Member { Field, Getter, Setter, Method, Absent }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Dispatch {
    /// Exactly one implementation reachable: emit a direct (inlinable) call.
    Direct(FuncId),
    /// Several implementations: emit `obj->vtable[slot](obj, ..)`.
    Virtual { slot: usize, name: Name },
    /// Open/unstable receiver: emit a runtime prototype-chain / IC lookup.
    Dynamic,
}

pub struct Hierarchy {
    classes: BTreeMap<ClassId, Class>,
}

impl Hierarchy {
    pub fn new(classes: Vec<Class>) -> Self {
        Hierarchy { classes: classes.into_iter().map(|c| (c.id, c)).collect() }
    }
    fn get(&self, c: ClassId) -> &Class { &self.classes[&c] }

    /// Chain from `c` up to the root (c first).
    fn chain_up(&self, c: ClassId) -> Vec<ClassId> {
        let mut v = Vec::new();
        let mut cur = Some(c);
        while let Some(id) = cur {
            v.push(id);
            cur = self.get(id).parent;
        }
        v
    }
    /// Chain from the root down to `c` (root first).
    fn chain_down(&self, c: ClassId) -> Vec<ClassId> {
        let mut v = self.chain_up(c);
        v.reverse();
        v
    }

    /// All classes whose ancestry includes `c` (including `c`).
    pub fn subclasses(&self, c: ClassId) -> BTreeSet<ClassId> {
        self.classes
            .keys()
            .copied()
            .filter(|&k| self.chain_up(k).contains(&c))
            .collect()
    }

    /// Most-derived definition of `name` visible from `c` (search c upward).
    pub fn resolve(&self, c: ClassId, name: Name) -> Option<FuncId> {
        for id in self.chain_up(c) {
            if let Some(m) = self.get(id).own_methods.iter().find(|m| m.name == name) {
                return Some(m.func);
            }
        }
        None
    }

    /// What kind of member `name` is, as seen from class `c`.
    pub fn member_kind(&self, c: ClassId, name: Name) -> Member {
        for id in self.chain_up(c) {
            let cls = self.get(id);
            if let Some(m) = cls.own_methods.iter().find(|m| m.name == name) {
                return match m.kind { MKind::Method => Member::Method, MKind::Getter => Member::Getter, MKind::Setter => Member::Setter };
            }
            if cls.own_fields.contains(&name) {
                return Member::Field;
            }
        }
        Member::Absent
    }

    /// Fixed field offset (single-inheritance prefix layout). +1 reserves slot 0
    /// for the vtable pointer in the object header.
    pub fn field_offset(&self, c: ClassId, name: Name) -> Option<usize> {
        let mut off = 0usize;
        for id in self.chain_down(c) {
            for f in &self.get(id).own_fields {
                if *f == name { return Some(off); }
                off += 1;
            }
        }
        None
    }

    /// Vtable for class `c`: slot index per method name, stable across the
    /// hierarchy (override reuses the parent's slot; new method gets a new one).
    pub fn vtable(&self, c: ClassId) -> Vec<(Name, FuncId)> {
        let mut name_to_slot: BTreeMap<Name, usize> = BTreeMap::new();
        let mut slots: Vec<(Name, FuncId)> = Vec::new();
        for id in self.chain_down(c) {
            for m in &self.get(id).own_methods {
                match name_to_slot.get(&m.name) {
                    Some(&slot) => slots[slot] = (m.name, m.func), // override
                    None => {
                        name_to_slot.insert(m.name, slots.len());
                        slots.push((m.name, m.func));
                    }
                }
            }
        }
        slots
    }

    /// Slot index of `name` as introduced anywhere in `c`'s ancestry.
    pub fn slot_of(&self, c: ClassId, name: Name) -> Option<usize> {
        self.vtable(c).iter().position(|(n, _)| *n == name)
    }

    /// `super.name()` from within a method defined in `defining_class`:
    /// the target is statically the parent's resolution — always Direct.
    pub fn super_dispatch(&self, defining_class: ClassId, name: Name) -> Dispatch {
        match self.get(defining_class).parent.and_then(|p| self.resolve(p, name)) {
            Some(f) => Dispatch::Direct(f),
            None => Dispatch::Dynamic,
        }
    }

    /// Devirtualize a call `recv: static_class . name`.
    /// `recv_stable` is false when the receiver flows through `any`/a cast at the
    /// site (even if the class itself is stable). `use_rta` restricts candidates
    /// to classes actually instantiated in the program (Rapid Type Analysis).
    pub fn devirtualize(&self, static_class: ClassId, name: Name, recv_stable: bool, use_rta: bool) -> Dispatch {
        // Guard 1: the receiver value isn't trustworthy as this class.
        if !recv_stable || !self.get(static_class).stable {
            return Dispatch::Dynamic;
        }
        // Candidate concrete classes (closed-world subtree of static_class).
        let mut candidates: Vec<ClassId> = self
            .subclasses(static_class)
            .into_iter()
            .filter(|&c| !use_rta || self.get(c).instantiated)
            .collect();
        if candidates.is_empty() {
            // No instantiated subtype reaches this site; fall back to the static
            // resolution if any, else dynamic.
            candidates.push(static_class);
        }
        // Guard 2: if any reachable candidate is unstable, the vtable/layout of
        // the subtree can't be trusted -> dynamic.
        if candidates.iter().any(|&c| !self.get(c).stable) {
            return Dispatch::Dynamic;
        }
        // Collect the distinct implementations.
        let impls: BTreeSet<FuncId> = candidates.iter().filter_map(|&c| self.resolve(c, name)).collect();
        match impls.len() {
            0 => Dispatch::Dynamic, // abstract / not found -> runtime lookup
            1 => Dispatch::Direct(*impls.iter().next().unwrap()),
            _ => match self.slot_of(static_class, name) {
                Some(slot) => Dispatch::Virtual { slot, name },
                None => Dispatch::Dynamic,
            },
        }
    }
}
