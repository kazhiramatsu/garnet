//! sroa — Scalar Replacement of Aggregates + method/ctor inlining.
//!
//! Targets the object-kernel gap: a `new C()` whose instance does not escape and
//! whose only uses are Direct calls to its own class's methods/constructor can be
//! eliminated entirely. We replace the object with one scalar local per field and
//! inline each method/ctor body, rewriting:
//!   - `this.fK` (LoadField/StoreField on the receiver) -> the field scalar,
//!   - the callee's params      -> the call's argument locals,
//!   - the callee's `Return x`  -> assign x to the call's `dst`.
//! After this pass there is no AllocObject, no FN_TABLE call, and no tsv boxing
//! for the object — emit_c then keeps everything in unboxed/int scalars, which is
//! what lets gcc match V8's scalar-replaced inline code.
//!
//! Scope (conservative; falls back to leaving the IR unchanged when unmet):
//!   - receiver allocated by `AllocObject{class_id=Some(c)}` at a NoEscape site,
//!   - every use of the receiver local is either that alloc, a `Copy` we can
//!     follow, or a `Call{recv=receiver, callee=Direct(f)}` where `f` is a method
//!     or ctor of `c`,
//!   - the receiver is never stored to a field/global/array, returned, thrown,
//!     or passed as a (non-recv) argument,
//!   - callees are non-recursive and contain only inlinable instructions.

use std::collections::{BTreeMap, BTreeSet};

use crate::escape_ir::*;

pub fn run_sroa(program: &mut Program, result: &EscapeResult) {
    // field_types: (class id, field id) -> "number" when monomorphization resolved
    // the field to a concrete scalar. Numeric field scalars (and locals that copy
    // from them) are forced to the unboxed Primitive representation.
    let mut numeric_fields: BTreeSet<(u32, u32)> = program
        .classes
        .iter()
        .flat_map(|c| {
            c.field_types
                .iter()
                .filter(|(_, t)| t.as_str() == "number")
                .filter_map(|(k, _)| k.parse::<u32>().ok().map(|fid| (c.id.0, fid)))
        })
        .collect();
    let noescape: BTreeSet<u32> = result
        .sites
        .iter()
        .filter(|s| s.state == EscapeState::NoEscape)
        .map(|s| s.site.0)
        .collect();

    // class id -> (field ids, method/ctor func ids)
    // Field map per class INCLUDING inherited fields (prefix-layout order: parent
    // fields first, then own). This lets an inheriting class be scalar-replaced —
    // its field scalars cover inherited fields too.
    let parent_of: BTreeMap<u32, Option<u32>> = program
        .classes
        .iter()
        .map(|c| (c.id.0, c.parent.map(|p| p.0)))
        .collect();
    let own_fields: BTreeMap<u32, Vec<u32>> = program
        .classes
        .iter()
        .map(|c| (c.id.0, c.own_fields.iter().map(|f| f.0).collect()))
        .collect();
    fn all_fields(
        c: u32,
        parent_of: &BTreeMap<u32, Option<u32>>,
        own: &BTreeMap<u32, Vec<u32>>,
    ) -> Vec<u32> {
        let mut v = Vec::new();
        if let Some(Some(p)) = parent_of.get(&c) {
            v.extend(all_fields(*p, parent_of, own));
        }
        if let Some(f) = own.get(&c) {
            v.extend(f.iter().copied());
        }
        v
    }
    let class_fields: BTreeMap<u32, Vec<u32>> = program
        .classes
        .iter()
        .map(|c| (c.id.0, all_fields(c.id.0, &parent_of, &own_fields)))
        .collect();

    // Extend numeric_fields with inherited numeric fields: a child class sees
    // its parent's numeric fields too (prefix-layout means same field id at same
    // offset). Without this, a SROA target of class IntBox (parent Base$number)
    // looked up `numeric_fields[(IntBox, value)]` and missed — the scalar was
    // born Reference, forcing a box/unbox round-trip in the kernel hot loop
    // (regression caught by inherit_sroa_kernel budget).
    {
        let snapshot: Vec<(u32, u32)> = numeric_fields.iter().copied().collect();
        for &(cls, fid) in &snapshot {
            // any descendant of `cls` also has this numeric field at the same id
            for desc in program.classes.iter() {
                let mut p = parent_of.get(&desc.id.0).and_then(|x| *x);
                while let Some(pc) = p {
                    if pc == cls {
                        numeric_fields.insert((desc.id.0, fid));
                        break;
                    }
                    p = parent_of.get(&pc).and_then(|x| *x);
                }
            }
        }
    }

    // Funcs callable on a class (for the find_sroa_targets soundness check),
    // INCLUDING inherited methods and the parent-chain constructors (super()).
    let own_funcs: BTreeMap<u32, BTreeSet<u32>> = program
        .classes
        .iter()
        .map(|c| (c.id.0, c.own_methods.iter().map(|m| m.func.0).collect()))
        .collect();
    fn all_funcs(
        c: u32,
        parent_of: &BTreeMap<u32, Option<u32>>,
        own: &BTreeMap<u32, BTreeSet<u32>>,
    ) -> BTreeSet<u32> {
        let mut s = BTreeSet::new();
        if let Some(f) = own.get(&c) {
            s.extend(f.iter().copied());
        }
        if let Some(Some(p)) = parent_of.get(&c) {
            s.extend(all_funcs(*p, parent_of, own));
        }
        s
    }
    let class_funcs: BTreeMap<u32, BTreeSet<u32>> = program
        .classes
        .iter()
        .map(|c| (c.id.0, all_funcs(c.id.0, &parent_of, &own_funcs)))
        .collect();

    // A4: inheriting classes are now scalar-replaced too. The inliner recursively
    // inlines nested `super(...)` / `this.m()` Direct calls (receiver `this`) using
    // the same field-scalar map, so a NoEscape instance of a subclass is fully
    // eliminated. (Previously inheriting classes were excluded.) `class_to_funcs`
    // and the field map above both account for inherited members.

    // snapshot callee bodies (immutable) before mutating functions
    let bodies: BTreeMap<u32, Function> = program
        .functions
        .iter()
        .map(|f| (f.id.0, f.clone()))
        .collect();

    // next fresh local id per function (max existing + 1)
    for fi in 0..program.functions.len() {
        let fid = program.functions[fi].id.0;
        let mut next_local = program.functions[fi]
            .locals
            .iter()
            .map(|l| l.id.0)
            .max()
            .unwrap_or(0)
            + 1;
        let mut new_locals: Vec<Local> = Vec::new();

        // work on a clone of the body, rewriting top-level and loop/if bodies
        let body = program.functions[fi].body.clone();
        let number_locs = collect_number_locs(&body);
        let mut sroad: BTreeMap<u32, BTreeMap<u32, u32>> = BTreeMap::new(); // recv -> (field -> scalar local)
        let mut numeric_scalars: BTreeSet<u32> = BTreeSet::new();
        // Top-level body: nothing is "outside" the function (params are never
        // array-SROA roots, so an empty set is correct).
        let top_outside: BTreeSet<u32> = BTreeSet::new();
        let rewritten = rewrite_body(
            &body,
            &number_locs,
            &noescape,
            &class_fields,
            &class_funcs,
            &bodies,
            &mut next_local,
            &mut new_locals,
            &mut sroad,
            &numeric_fields,
            &mut numeric_scalars,
            program.functions[fi].id.0,
            &top_outside,
            &BTreeMap::new(),
        );
        // Commit the rewritten body. Free-function inlining can rewrite the body
        // (replacing a Call with the inlined Copy/BinOp) without introducing any
        // new locals, so we must not gate the commit on new_locals being nonempty.
        program.functions[fi].locals.extend(new_locals);
        program.functions[fi].body = rewritten.clone();
        {
            // Propagate "numeric" from field scalars through copy chains, then force
            // those locals to the unboxed Primitive representation so codegen keeps
            // a monomorphized number field as a raw double (no box/unbox roundtrip).
            let mut numeric = numeric_scalars.clone();
            let primitive_locs: BTreeSet<u32> = program.functions[fi]
                .locals
                .iter()
                .filter(|l| matches!(l.ref_kind, RefKind::Primitive))
                .map(|l| l.id.0)
                .collect();
            let mut changed = true;
            while changed {
                changed = false;
                propagate_numeric(&rewritten, &primitive_locs, &mut numeric, &mut changed);
            }
            for l in &mut program.functions[fi].locals {
                if numeric.contains(&l.id.0) {
                    l.ref_kind = RefKind::Primitive;
                }
            }
        }
        let _ = fid;
    }
}

fn fresh(next: &mut u32, new_locals: &mut Vec<Local>, reference: bool) -> u32 {
    let id = *next;
    *next += 1;
    new_locals.push(Local {
        id: LocalId(id),
        type_id: TypeId(0),
        ref_kind: if reference {
            RefKind::Reference
        } else {
            RefKind::Primitive
        },
        binding: None,
        name: None,
        nullable_numeric: false,
    });
    id
}

#[derive(Debug, Clone, Default)]
struct ArraySroaTarget {
    // Only indices whose value is read need a scalar. Write-only indices are
    // observable only through length, which rewrite_body tracks separately.
    indices: BTreeSet<u32>,
    // Read indices that can be represented as raw numbers. This is deliberately
    // narrower than RefKind::Primitive: booleans are primitive too, but loading a
    // JS boolean through `any` must still produce a boolean value, not number 0/1.
    numeric_indices: BTreeSet<u32>,
}

fn resolve_alias_root(id: u32, alias: &BTreeMap<u32, u32>) -> u32 {
    let mut cur = id;
    let mut seen = 0;
    while let Some(&s) = alias.get(&cur) {
        cur = s;
        seen += 1;
        if seen > 64 {
            break;
        }
    }
    cur
}

fn const_array_index_value(value: &ConstVal) -> Option<u32> {
    match value {
        ConstVal::Num { value }
            if value.is_finite()
                && *value >= 0.0
                && value.fract() == 0.0
                && *value < (u32::MAX as f64) =>
        {
            Some(*value as u32)
        }
        _ => None,
    }
}

fn const_is_number_value(value: &ConstVal) -> bool {
    matches!(
        value,
        ConstVal::Num { .. }
            | ConstVal::NaN
            | ConstVal::PosInf
            | ConstVal::NegInf
            | ConstVal::NegZero
    )
}

fn collect_number_locs(body: &[Inst]) -> BTreeSet<u32> {
    let mut numeric = BTreeSet::new();
    let mut changed = true;
    while changed {
        changed = false;
        collect_number_locs_pass(body, &mut numeric, &mut changed);
    }
    numeric
}

fn collect_number_locs_pass(body: &[Inst], numeric: &mut BTreeSet<u32>, changed: &mut bool) {
    for inst in body {
        let def = match inst {
            Inst::Const { dst, value } => Some((dst.0, const_is_number_value(value))),
            Inst::Copy { dst, src } => Some((dst.0, numeric.contains(&src.0))),
            Inst::UnOp { dst, op, operand } => {
                let is_num = matches!(op.as_str(), "+" | "-" | "~") && numeric.contains(&operand.0);
                Some((dst.0, is_num))
            }
            Inst::BinOp { dst, op, lhs, rhs } => {
                let is_num = matches!(
                    op.as_str(),
                    "+" | "-" | "*" | "/" | "%" | "**" | "&" | "|" | "^" | "<<" | ">>" | ">>>"
                ) && numeric.contains(&lhs.0)
                    && numeric.contains(&rhs.0);
                Some((dst.0, is_num))
            }
            Inst::ArrayLen { dst, .. }
            | Inst::StringLen { dst, .. }
            | Inst::GenericLen { dst, .. } => Some((dst.0, true)),
            Inst::Loop {
                cond_body, body, ..
            } => {
                collect_number_locs_pass(cond_body, numeric, changed);
                collect_number_locs_pass(body, numeric, changed);
                None
            }
            Inst::If {
                then_body,
                else_body,
                ..
            } => {
                collect_number_locs_pass(then_body, numeric, changed);
                collect_number_locs_pass(else_body, numeric, changed);
                None
            }
            Inst::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                collect_number_locs_pass(try_body, numeric, changed);
                collect_number_locs_pass(catch_body, numeric, changed);
                collect_number_locs_pass(finally_body, numeric, changed);
                None
            }
            _ => None,
        };
        if let Some((id, is_num)) = def {
            if is_num && numeric.insert(id) {
                *changed = true;
            }
        }
    }
}

fn array_sroa_root_for_target(
    id: u32,
    targets: &BTreeMap<u32, ArraySroaTarget>,
    alias: &BTreeMap<u32, u32>,
) -> Option<u32> {
    let root = resolve_alias_root(id, alias);
    if targets.contains_key(&root) {
        Some(root)
    } else {
        None
    }
}

fn array_sroa_root_for_scalars(
    id: u32,
    scalars: &BTreeMap<u32, BTreeMap<u32, u32>>,
    alias: &BTreeMap<u32, u32>,
) -> Option<u32> {
    let root = resolve_alias_root(id, alias);
    if scalars.contains_key(&root) {
        Some(root)
    } else {
        None
    }
}

fn invalidate_array_tracking_def(
    id: LocalId,
    array_alias: &mut BTreeMap<u32, u32>,
    const_indices: &mut BTreeMap<u32, u32>,
) {
    array_alias.remove(&id.0);
    const_indices.remove(&id.0);
}

fn invalidate_array_tracking_defs(
    inst: &Inst,
    array_alias: &mut BTreeMap<u32, u32>,
    const_indices: &mut BTreeMap<u32, u32>,
) {
    let mut kill = |id: LocalId| invalidate_array_tracking_def(id, array_alias, const_indices);
    match inst {
        Inst::AllocObject { dst, .. }
        | Inst::AllocArray { dst, .. }
        | Inst::AllocClosure { dst, .. }
        | Inst::Copy { dst, .. }
        | Inst::LoadField { dst, .. }
        | Inst::LoadMethodValue { dst, .. }
        | Inst::LoadBuiltinFn { dst, .. }
        | Inst::AllocClassValue { dst, .. }
        | Inst::NewDynamic { dst, .. }
        | Inst::LoadElem { dst, .. }
        | Inst::LoadGlobal { dst, .. }
        | Inst::Const { dst, .. }
        | Inst::BinOp { dst, .. }
        | Inst::UnOp { dst, .. }
        | Inst::LoadIndex { dst, .. }
        | Inst::ArrayLen { dst, .. }
        | Inst::StringLen { dst, .. }
        | Inst::HasField { dst, .. }
        | Inst::HasFieldDynamic { dst, .. }
        | Inst::GenericLen { dst, .. }
        | Inst::LoadFieldDynamic { dst, .. }
        | Inst::ArraySlice { dst, .. }
        | Inst::ObjectRest { dst, .. }
        | Inst::ObjectCopyProps { dst, .. }
        | Inst::ConstructResult { dst, .. }
        | Inst::LoadClassProto { dst, .. }
        | Inst::GetProto { dst, .. }
        | Inst::NewMap { dst }
        | Inst::NewSet { dst } => kill(*dst),
        Inst::Call { dst, .. }
        | Inst::Yield { dst, .. }
        | Inst::Await { dst, .. }
        | Inst::CallSpread { dst, .. }
        | Inst::CallBuiltin { dst, .. }
        | Inst::CallBuiltinStatic { dst, .. }
        | Inst::DeleteField { dst, .. }
        | Inst::SetProto { dst, .. } => {
            if let Some(d) = dst {
                kill(*d);
            }
        }
        Inst::TryCatch { catch_var, .. } => {
            if let Some(c) = catch_var {
                kill(*c);
            }
        }
        Inst::StoreField { .. }
        | Inst::StoreGlobal { .. }
        | Inst::StoreElem { .. }
        | Inst::Return { .. }
        | Inst::Throw { .. }
        | Inst::StoreIndex { .. }
        | Inst::ArrayPush { .. }
        | Inst::ArrayPushAll { .. }
        | Inst::StoreFieldDynamic { .. }
        | Inst::StoreProtoMethod { .. }
        | Inst::StoreMethod { .. }
        | Inst::Print { .. }
        | Inst::If { .. }
        | Inst::Loop { .. }
        | Inst::Break { .. }
        | Inst::Continue { .. } => {}
    }
}

fn disqualify_array_roots_in_inst(
    inst: &Inst,
    targets: &BTreeMap<u32, ArraySroaTarget>,
    alias: &BTreeMap<u32, u32>,
    disq: &mut BTreeSet<u32>,
) {
    fn local(
        id: LocalId,
        targets: &BTreeMap<u32, ArraySroaTarget>,
        alias: &BTreeMap<u32, u32>,
        disq: &mut BTreeSet<u32>,
    ) {
        if let Some(root) = array_sroa_root_for_target(id.0, targets, alias) {
            disq.insert(root);
        }
    }
    fn body(
        insts: &[Inst],
        targets: &BTreeMap<u32, ArraySroaTarget>,
        alias: &BTreeMap<u32, u32>,
        disq: &mut BTreeSet<u32>,
    ) {
        for inst in insts {
            disqualify_array_roots_in_inst(inst, targets, alias, disq);
        }
    }
    macro_rules! l {
        ($id:expr) => {
            local($id, targets, alias, disq)
        };
    }
    match inst {
        Inst::AllocObject { dst, proto, .. } => {
            l!(*dst);
            if let Some(p) = proto {
                l!(*p);
            }
        }
        Inst::AllocArray { dst, .. }
        | Inst::LoadBuiltinFn { dst, .. }
        | Inst::LoadGlobal { dst, .. }
        | Inst::Const { dst, .. }
        | Inst::NewMap { dst }
        | Inst::NewSet { dst }
        | Inst::LoadClassProto { dst, .. } => l!(*dst),
        Inst::AllocClosure { dst, captures, .. } | Inst::AllocClassValue { dst, captures, .. } => {
            l!(*dst);
            for c in captures {
                l!(c.cell);
            }
        }
        Inst::Copy { dst, src } => {
            l!(*dst);
            l!(*src);
        }
        Inst::LoadField { dst, obj, .. }
        | Inst::LoadElem { dst, arr: obj }
        | Inst::ArrayLen { dst, arr: obj }
        | Inst::StringLen { dst, src: obj }
        | Inst::HasField { dst, obj, .. }
        | Inst::GenericLen { dst, src: obj }
        | Inst::GetProto { dst, obj } => {
            l!(*dst);
            l!(*obj);
        }
        Inst::StoreField { obj, src, .. } | Inst::StoreElem { arr: obj, src } => {
            l!(*obj);
            l!(*src);
        }
        Inst::StoreGlobal { src, .. } | Inst::StoreProtoMethod { src, .. } => l!(*src),
        Inst::LoadMethodValue { dst, recv, .. } => {
            l!(*dst);
            l!(*recv);
        }
        Inst::NewDynamic {
            dst, callee, args, ..
        } => {
            l!(*dst);
            l!(*callee);
            for a in args {
                l!(*a);
            }
        }
        Inst::Call {
            dst, recv, args, ..
        } => {
            if let Some(d) = dst {
                l!(*d);
            }
            if let Some(r) = recv {
                l!(*r);
            }
            for a in args {
                l!(*a);
            }
        }
        Inst::Return { src } => {
            if let Some(s) = src {
                l!(*s);
            }
        }
        Inst::Yield { dst, operand } | Inst::Await { dst, operand } => {
            if let Some(d) = dst {
                l!(*d);
            }
            l!(*operand);
        }
        Inst::Throw { src } | Inst::Print { src } => l!(*src),
        Inst::TryCatch {
            try_body,
            catch_var,
            catch_body,
            finally_body,
        } => {
            body(try_body, targets, alias, disq);
            if let Some(c) = catch_var {
                l!(*c);
            }
            body(catch_body, targets, alias, disq);
            body(finally_body, targets, alias, disq);
        }
        Inst::BinOp { dst, lhs, rhs, .. } => {
            l!(*dst);
            l!(*lhs);
            l!(*rhs);
        }
        Inst::UnOp { dst, operand, .. } => {
            l!(*dst);
            l!(*operand);
        }
        Inst::LoadIndex { dst, arr, index } => {
            l!(*dst);
            l!(*arr);
            l!(*index);
        }
        Inst::StoreIndex { arr, index, src } => {
            l!(*arr);
            l!(*index);
            l!(*src);
        }
        Inst::ArrayPush { arr, src } | Inst::ArrayPushAll { arr, src } => {
            l!(*arr);
            l!(*src);
        }
        Inst::HasFieldDynamic { dst, obj, key } | Inst::LoadFieldDynamic { dst, obj, key } => {
            l!(*dst);
            l!(*obj);
            l!(*key);
        }
        Inst::StoreFieldDynamic { obj, key, src } => {
            l!(*obj);
            l!(*key);
            l!(*src);
        }
        Inst::DeleteField { dst, obj, .. } => {
            if let Some(d) = dst {
                l!(*d);
            }
            l!(*obj);
        }
        Inst::ArraySlice { dst, arr, start } => {
            l!(*dst);
            l!(*arr);
            l!(*start);
        }
        Inst::ObjectRest { dst, src, .. } | Inst::ObjectCopyProps { dst, src } => {
            l!(*dst);
            l!(*src);
        }
        Inst::ConstructResult { dst, inst, ret } => {
            l!(*dst);
            l!(*inst);
            l!(*ret);
        }
        Inst::CallSpread {
            dst,
            recv,
            arg_specs,
            ..
        } => {
            if let Some(d) = dst {
                l!(*d);
            }
            if let Some(r) = recv {
                l!(*r);
            }
            for s in arg_specs {
                match s {
                    ArgSpec::Single { local } | ArgSpec::Spread { local } => l!(*local),
                }
            }
        }
        Inst::StoreMethod { obj, src, .. } => {
            l!(*obj);
            l!(*src);
        }
        Inst::SetProto { dst, obj, proto } => {
            if let Some(d) = dst {
                l!(*d);
            }
            l!(*obj);
            l!(*proto);
        }
        Inst::CallBuiltin {
            dst, recv, args, ..
        } => {
            if let Some(d) = dst {
                l!(*d);
            }
            l!(*recv);
            for a in args {
                l!(*a);
            }
        }
        Inst::CallBuiltinStatic { dst, args, .. } => {
            if let Some(d) = dst {
                l!(*d);
            }
            for a in args {
                l!(*a);
            }
        }
        Inst::If {
            cond,
            then_body,
            else_body,
        } => {
            l!(*cond);
            body(then_body, targets, alias, disq);
            body(else_body, targets, alias, disq);
        }
        Inst::Loop {
            cond,
            cond_body,
            body: loop_body,
        } => {
            l!(*cond);
            body(cond_body, targets, alias, disq);
            body(loop_body, targets, alias, disq);
        }
        Inst::Break { .. } | Inst::Continue { .. } => {}
    }
}

/// Collect every local referenced (as any operand, recursively through nested
/// bodies) in `body`. Used to compute the per-body "escapes" set for array SROA.
fn collect_local_refs(body: &[Inst], set: &mut BTreeSet<u32>) {
    let cell = std::cell::RefCell::new(set);
    for inst in body {
        let _ = remap_inst_operands(inst, &|l: LocalId| {
            cell.borrow_mut().insert(l.0);
            l
        });
    }
}

fn find_array_sroa_targets(
    body: &[Inst],
    number_locs: &BTreeSet<u32>,
    outside: &BTreeSet<u32>,
) -> BTreeMap<u32, ArraySroaTarget> {
    let mut targets: BTreeMap<u32, ArraySroaTarget> = BTreeMap::new();
    let mut disq: BTreeSet<u32> = BTreeSet::new();
    let mut alias: BTreeMap<u32, u32> = BTreeMap::new();
    let mut const_indices: BTreeMap<u32, u32> = BTreeMap::new();
    let mut current_numeric: BTreeMap<(u32, u32), bool> = BTreeMap::new();
    let mut all_stores_numeric: BTreeMap<(u32, u32), bool> = BTreeMap::new();
    let mut reads_numeric: BTreeMap<(u32, u32), bool> = BTreeMap::new();

    let disq_local = |id: LocalId,
                      targets: &BTreeMap<u32, ArraySroaTarget>,
                      alias: &BTreeMap<u32, u32>,
                      disq: &mut BTreeSet<u32>| {
        if let Some(root) = array_sroa_root_for_target(id.0, targets, alias) {
            disq.insert(root);
        }
    };

    for inst in body {
        match inst {
            Inst::AllocArray { dst, .. } => {
                alias.remove(&dst.0);
                const_indices.remove(&dst.0);
                targets.insert(dst.0, ArraySroaTarget::default());
            }
            Inst::Const { dst, value } => {
                alias.remove(&dst.0);
                const_indices.remove(&dst.0);
                if targets.contains_key(&dst.0) {
                    disq.insert(dst.0);
                }
                if let Some(idx) = const_array_index_value(value) {
                    const_indices.insert(dst.0, idx);
                }
            }
            Inst::Copy { dst, src } => {
                let copied_const = const_indices.get(&src.0).copied();
                alias.remove(&dst.0);
                const_indices.remove(&dst.0);
                if targets.contains_key(&dst.0) {
                    disq.insert(dst.0);
                }
                if let Some(idx) = copied_const {
                    const_indices.insert(dst.0, idx);
                }
                if let Some(root) = array_sroa_root_for_target(src.0, &targets, &alias) {
                    alias.insert(dst.0, root);
                    }
            }
            Inst::StoreIndex { arr, index, src } => {
                if let Some(root) = array_sroa_root_for_target(arr.0, &targets, &alias) {
                    if const_indices.get(&index.0).is_none() {
                        disq.insert(root);
                    } else if let Some(idx) = const_indices.get(&index.0).copied() {
                        let is_num = number_locs.contains(&src.0);
                        current_numeric.insert((root, idx), is_num);
                        all_stores_numeric
                            .entry((root, idx))
                            .and_modify(|v| *v = *v && is_num)
                            .or_insert(is_num);
                    }
                }
                disq_local(*index, &targets, &alias, &mut disq);
                disq_local(*src, &targets, &alias, &mut disq);
            }
            Inst::LoadIndex { dst, arr, index } => {
                alias.remove(&dst.0);
                const_indices.remove(&dst.0);
                if targets.contains_key(&dst.0) {
                    disq.insert(dst.0);
                }
                if let Some(root) = array_sroa_root_for_target(arr.0, &targets, &alias) {
                    if let Some(idx) = const_indices.get(&index.0).copied() {
                        if let Some(t) = targets.get_mut(&root) {
                            t.indices.insert(idx);
                        }
                        let is_num = current_numeric.get(&(root, idx)).copied().unwrap_or(false);
                        reads_numeric
                            .entry((root, idx))
                            .and_modify(|v| *v = *v && is_num)
                            .or_insert(is_num);
                    } else {
                        disq.insert(root);
                    }
                }
                disq_local(*index, &targets, &alias, &mut disq);
            }
            Inst::StoreFieldDynamic { obj, key, src } => {
                if let Some(root) = array_sroa_root_for_target(obj.0, &targets, &alias) {
                    if const_indices.get(&key.0).is_none() {
                        disq.insert(root);
                    } else if let Some(idx) = const_indices.get(&key.0).copied() {
                        let is_num = number_locs.contains(&src.0);
                        current_numeric.insert((root, idx), is_num);
                        all_stores_numeric
                            .entry((root, idx))
                            .and_modify(|v| *v = *v && is_num)
                            .or_insert(is_num);
                    }
                }
                disq_local(*key, &targets, &alias, &mut disq);
                disq_local(*src, &targets, &alias, &mut disq);
            }
            Inst::LoadFieldDynamic { dst, obj, key } => {
                alias.remove(&dst.0);
                const_indices.remove(&dst.0);
                if targets.contains_key(&dst.0) {
                    disq.insert(dst.0);
                }
                if let Some(root) = array_sroa_root_for_target(obj.0, &targets, &alias) {
                    if let Some(idx) = const_indices.get(&key.0).copied() {
                        if let Some(t) = targets.get_mut(&root) {
                            t.indices.insert(idx);
                        }
                        let is_num = current_numeric.get(&(root, idx)).copied().unwrap_or(false);
                        reads_numeric
                            .entry((root, idx))
                            .and_modify(|v| *v = *v && is_num)
                            .or_insert(is_num);
                    } else {
                        disq.insert(root);
                    }
                }
                disq_local(*key, &targets, &alias, &mut disq);
            }
            Inst::ArrayLen { dst, arr } => {
                alias.remove(&dst.0);
                const_indices.remove(&dst.0);
                if targets.contains_key(&dst.0) {
                    disq.insert(dst.0);
                }
                if array_sroa_root_for_target(arr.0, &targets, &alias).is_none() {
                    disq_local(*arr, &targets, &alias, &mut disq);
                } else {
                    }
            }
            Inst::StringLen { dst, src } => {
                alias.remove(&dst.0);
                const_indices.remove(&dst.0);
                if targets.contains_key(&dst.0) {
                    disq.insert(dst.0);
                }
                disq_local(*src, &targets, &alias, &mut disq);
            }
            Inst::ArrayPush { arr, src } | Inst::ArrayPushAll { arr, src } => {
                disq_local(*arr, &targets, &alias, &mut disq);
                disq_local(*src, &targets, &alias, &mut disq);
            }
            Inst::If { .. } | Inst::Loop { .. } | Inst::TryCatch { .. } => {
                for root in targets.keys() {
                    disq.insert(*root);
                }
                disqualify_array_roots_in_inst(inst, &targets, &alias, &mut disq);
                invalidate_array_tracking_defs(inst, &mut alias, &mut const_indices);
            }
            other => {
                disqualify_array_roots_in_inst(other, &targets, &alias, &mut disq);
                invalidate_array_tracking_defs(other, &mut alias, &mut const_indices);
            }
        }
    }

    // Cross-body escape: an array root, or any local Copy-aliased to it, that is
    // referenced OUTSIDE this body escapes it (e.g. a ternary/if result assigned in
    // this branch and used after the enclosing `if`). Per-body scalar replacement
    // would drop the array, so keep it materialized. `outside` is the set of locals
    // referenced anywhere in the function except within this body.
    for (dst, root) in &alias {
        if outside.contains(dst) {
            disq.insert(*root);
        }
    }
    let escaping_roots: Vec<u32> = targets
        .keys()
        .copied()
        .filter(|r| outside.contains(r))
        .collect();
    for r in escaping_roots {
        disq.insert(r);
    }

    let mut filtered = BTreeMap::new();
    for (root, mut target) in targets {
        if disq.contains(&root) {
            continue;
        }
        for idx in &target.indices {
            if reads_numeric.get(&(root, *idx)).copied().unwrap_or(false)
                && all_stores_numeric
                    .get(&(root, *idx))
                    .copied()
                    .unwrap_or(false)
            {
                target.numeric_indices.insert(*idx);
            }
        }
        filtered.insert(root, target);
    }
    filtered
}

/// Find receivers in `body` that qualify for SROA: allocated here at a NoEscape
/// site with a known class, and used only as Direct-call receivers / copies.
fn find_sroa_targets(
    body: &[Inst],
    noescape: &BTreeSet<u32>,
    class_fields: &BTreeMap<u32, Vec<u32>>,
    class_funcs: &BTreeMap<u32, BTreeSet<u32>>,
    bodies: &BTreeMap<u32, Function>,
) -> BTreeMap<u32, u32> {
    let mut alloc_class: BTreeMap<u32, u32> = BTreeMap::new(); // recv local -> class
    let mut disqualified: BTreeSet<u32> = BTreeSet::new();
    let mut copy_alias: BTreeMap<u32, u32> = BTreeMap::new(); // copy dst -> source recv

    fn scan(
        body: &[Inst],
        noescape: &BTreeSet<u32>,
        class_fields: &BTreeMap<u32, Vec<u32>>,
        class_funcs: &BTreeMap<u32, BTreeSet<u32>>,
        bodies: &BTreeMap<u32, Function>,
        alloc_class: &mut BTreeMap<u32, u32>,
        disq: &mut BTreeSet<u32>,
        alias: &mut BTreeMap<u32, u32>,
    ) {
        fn resolve(id: u32, alias: &BTreeMap<u32, u32>) -> u32 {
            let mut cur = id;
            let mut seen = 0;
            while let Some(&s) = alias.get(&cur) {
                cur = s;
                seen += 1;
                if seen > 64 {
                    break;
                }
            }
            cur
        }
        /// Disqualify a reference-value observation: the raw local AND its
        /// copy-chain root. Narrowing/temp copies alias the receiver, so a raw
        /// insert alone lets `Copy t←recv; t !== null` slip past the net and
        /// SROA dematerializes an object that is still observed through `t`
        /// (s316 silent-miscompile #2: undefined reads after null-narrowing).
        fn dq(id: u32, alias: &BTreeMap<u32, u32>, disq: &mut BTreeSet<u32>) {
            disq.insert(id);
            disq.insert(resolve(id, alias));
        }
        for inst in body {
            match inst {
                Inst::AllocObject {
                    dst,
                    site,
                    class_id: Some(c),
                    ..
                } => {
                    // NoEscape + known class + NOT participating in inheritance.
                    if noescape.contains(&site.0) {
                        alloc_class.insert(dst.0, c.0);
                    } else {
                        dq(dst.0, alias, disq);
                    }
                }
                Inst::NewDynamic { dst, .. } => {
                    // A dynamically-constructed instance has no compile-time class
                    // (its runtime class is one of several candidates), so its layout
                    // can't be scalar-replaced. NewDynamic dsts carry no class_id today
                    // so they're already excluded above; disqualify explicitly as a
                    // guard against future changes.
                    dq(dst.0, alias, disq);
                }
                Inst::Copy { dst, src } => {
                    // following a copy of a tracked recv is fine; record the alias
                    alias.insert(dst.0, src.0);
                }
                Inst::Call {
                    recv, callee, args, ..
                } => {
                    // A receiver used in a non-Direct call can't be scalar-replaced.
                    if let Some(r) = recv {
                        match callee {
                            CalleeRef::Direct { func } => {
                                // A method that captures `this` into a closure needs a
                                // real `this` OBJECT (the closure's lexical-this cell
                                // boxes the receiver), so its receiver must NOT be
                                // scalar-replaced — disqualify it.
                                if let Some(callee_fn) = bodies.get(&func.0) {
                                    // captures_this: needs a real `this` object for the
                                    // closure cell. returns_receiver: the callee returns
                                    // `this`, so the call's dst aliases the receiver and
                                    // its fields are read through the object pointer —
                                    // scalar-replacing the receiver would diverge.
                                    // A generator/async method captures `this` into a
                                    // coroutine frame that outlives the call (and the call
                                    // is NOT inlined), so its receiver must stay a real
                                    // object — scalar-replacing it strands the kept call's
                                    // `this`. Same for a method that forwards to one on `this`.
                                    // returns_only_in_tail_position mirrors the rewrite's
                                    // inline_callee precondition: this receiver use is
                                    // ELIMINATED only by inlining the callee, and a return
                                    // nested in control flow (if/loop/try) blocks inlining.
                                    // Allowing such a callee here would drop the alloc but
                                    // keep the call reading the never-assigned receiver
                                    // local (wild pointer loads in the callee).
                                    if captures_this(callee_fn)
                                        || returns_receiver(callee_fn)
                                        || needs_materialized_this(callee_fn, bodies, 0)
                                        || !returns_only_in_tail_position(callee_fn)
                                    {
                                        dq(r.0, alias, disq);
                                    }
                                } else {
                                    // Unknown body: the rewrite cannot inline the call
                                    // either, so the receiver must stay materialized.
                                    dq(r.0, alias, disq);
                                }
                            }
                            _ => {
                                dq(r.0, alias, disq);
                            }
                        }
                    }
                    // An object passed as an argument usually escapes into the
                    // callee. The narrow exception is a Direct free-function call
                    // that SROA will inline and whose matching parameter is used
                    // only for declared field loads/stores. Then the inliner can
                    // rewrite those field accesses to the caller's field scalars,
                    // so the object reference itself never has to exist.
                    for (i, a) in args.iter().enumerate() {
                        let ra = resolve(a.0, alias);
                        let pass_is_sroa_safe = match (recv, callee, alloc_class.get(&ra)) {
                            (None, CalleeRef::Direct { func }, Some(cls)) => {
                                bodies.get(&func.0).map_or(false, |callee_fn| {
                                    class_fields.get(cls).map_or(false, |fields| {
                                        // args.len()==params.len() mirrors the rewrite's
                                        // inline condition: an arity-mismatched call (an
                                        // omitted optional arg) is NOT inlined, so the
                                        // kept call would read the dropped alloc.
                                        is_inlinable_free_fn(callee_fn)
                                            && args.len() == callee_fn.params.len()
                                            && callee_param_field_only_sroa_safe(
                                                callee_fn, i, fields,
                                            )
                                    })
                                })
                            }
                            _ => false,
                        };
                        if !pass_is_sroa_safe {
                            dq(a.0, alias, disq);
                            dq(ra, alias, disq);
                        }
                    }
                }
                Inst::StoreField { src, .. } => {
                    dq(src.0, alias, disq);
                }
                Inst::StoreGlobal { src, .. } => {
                    dq(src.0, alias, disq);
                }
                Inst::StoreElem { src, .. } => {
                    dq(src.0, alias, disq);
                }
                Inst::Return { src: Some(s) } => {
                    dq(s.0, alias, disq);
                }
                Inst::Throw { src } => {
                    dq(src.0, alias, disq);
                }
                // SROA's rewrite_body can only redirect a scalar-replaced object
                // through LoadField/StoreField (as `obj`), Copy, and Direct
                // non-capturing calls (handled above). EVERY OTHER instruction that
                // reads the object's *reference value* (comparison, nullish/typeof,
                // truthiness test, printing, dynamic/indexed access, escaping into a
                // container/builtin, …) would observe a heap object that no longer
                // exists once the fields are scalarized. Disqualify those reads so
                // the object stays materialized. Conservative: over-disqualifying
                // only forgoes an optimization, it never miscompiles.
                Inst::LoadField { obj, field, .. } => {
                    let robj = resolve(obj.0, alias);
                    if let Some(cls) = alloc_class.get(&robj) {
                        let is_declared_field = class_fields
                            .get(cls)
                            .map(|fields| fields.iter().any(|f| *f == field.0))
                            .unwrap_or(false);
                        if !is_declared_field {
                            dq(robj, alias, disq);
                        }
                    }
                }
                Inst::BinOp { lhs, rhs, .. } => {
                    dq(lhs.0, alias, disq);
                    dq(rhs.0, alias, disq);
                }
                Inst::UnOp { operand, .. } => {
                    dq(operand.0, alias, disq);
                }
                Inst::LoadIndex { arr, index, .. } => {
                    dq(arr.0, alias, disq);
                    dq(index.0, alias, disq);
                }
                Inst::StoreIndex { arr, index, src } => {
                    dq(arr.0, alias, disq);
                    dq(index.0, alias, disq);
                    dq(src.0, alias, disq);
                }
                Inst::ArrayLen { arr, .. } => {
                    dq(arr.0, alias, disq);
                }
                Inst::StringLen { src, .. } => {
                    dq(src.0, alias, disq);
                }
                Inst::ArrayPush { arr, src } => {
                    dq(arr.0, alias, disq);
                    dq(src.0, alias, disq);
                }
                Inst::ArrayPushAll { arr, src } => {
                    dq(arr.0, alias, disq);
                    dq(src.0, alias, disq);
                }
                Inst::ArraySlice { arr, start, .. } => {
                    dq(arr.0, alias, disq);
                    dq(start.0, alias, disq);
                }
                Inst::HasField { obj, .. } => {
                    dq(obj.0, alias, disq);
                }
                Inst::HasFieldDynamic { obj, key, .. } => {
                    dq(obj.0, alias, disq);
                    dq(key.0, alias, disq);
                }
                Inst::GenericLen { src, .. } => {
                    dq(src.0, alias, disq);
                }
                Inst::LoadFieldDynamic { obj, key, .. } => {
                    dq(obj.0, alias, disq);
                    dq(key.0, alias, disq);
                }
                Inst::StoreFieldDynamic { obj, key, src } => {
                    dq(obj.0, alias, disq);
                    dq(key.0, alias, disq);
                    dq(src.0, alias, disq);
                }
                Inst::DeleteField { obj, .. } => {
                    dq(obj.0, alias, disq);
                }
                Inst::ObjectRest { src, .. } => {
                    dq(src.0, alias, disq);
                }
                Inst::ObjectCopyProps { src, .. } => {
                    dq(src.0, alias, disq);
                }
                Inst::ConstructResult { inst, ret, .. } => {
                    dq(inst.0, alias, disq);
                    dq(ret.0, alias, disq);
                }
                Inst::GetProto { obj, .. } => {
                    dq(obj.0, alias, disq);
                }
                Inst::SetProto { obj, proto, .. } => {
                    dq(obj.0, alias, disq);
                    dq(proto.0, alias, disq);
                }
                Inst::StoreProtoMethod { src, .. } | Inst::StoreMethod { src, .. } => {
                    dq(src.0, alias, disq);
                }
                Inst::Print { src } => {
                    dq(src.0, alias, disq);
                }
                Inst::CallBuiltin { recv, args, .. } => {
                    dq(recv.0, alias, disq);
                    for a in args {
                        dq(a.0, alias, disq);
                    }
                }
                Inst::CallBuiltinStatic { args, .. } => {
                    for a in args {
                        dq(a.0, alias, disq);
                    }
                }
                Inst::CallSpread {
                    recv, arg_specs, ..
                } => {
                    if let Some(r) = recv {
                        dq(r.0, alias, disq);
                    }
                    for s in arg_specs {
                        match s {
                            ArgSpec::Single { local } | ArgSpec::Spread { local } => {
                                dq(local.0, alias, disq);
                            }
                        }
                    }
                }
                Inst::Loop {
                    cond,
                    cond_body,
                    body,
                } => {
                    dq(cond.0, alias, disq);
                    scan(
                        cond_body,
                        noescape,
                        class_fields,
                        class_funcs,
                        bodies,
                        alloc_class,
                        disq,
                        alias,
                    );
                    scan(
                        body,
                        noescape,
                        class_fields,
                        class_funcs,
                        bodies,
                        alloc_class,
                        disq,
                        alias,
                    );
                }
                Inst::If {
                    cond,
                    then_body,
                    else_body,
                } => {
                    dq(cond.0, alias, disq);
                    scan(
                        then_body,
                        noescape,
                        class_fields,
                        class_funcs,
                        bodies,
                        alloc_class,
                        disq,
                        alias,
                    );
                    scan(
                        else_body,
                        noescape,
                        class_fields,
                        class_funcs,
                        bodies,
                        alloc_class,
                        disq,
                        alias,
                    );
                }
                Inst::TryCatch {
                    try_body,
                    catch_body,
                    finally_body,
                    ..
                } => {
                    // try/catch/finally 内の使用も観測・失格の対象（ここを見ないと
                    // try 内の push/比較が失格網から漏れて dematerialize が誤発火する）
                    for b in [try_body, catch_body, finally_body] {
                        scan(
                            b,
                            noescape,
                            class_fields,
                            class_funcs,
                            bodies,
                            alloc_class,
                            disq,
                            alias,
                        );
                    }
                }
                _ => {}
            }
        }
    }
    // Two passes: copy-aliases recorded at the BOTTOM of a loop body must reach
    // observations at the TOP of the next iteration (`n.next = head; head = n;`
    // — the StoreField's dq(head) precedes the Copy that aliases head→n, so a
    // single linear pass misses the loop-carried disqualification and SROA
    // deletes the `head = n` store: the chain head stays null, s317 silent
    // miscompile #4). Pass 1 completes the alias map (Copy edges are syntactic
    // and order-independent); pass 2 re-evaluates every dq against it. The
    // disqualified set only grows, so the result is monotonically safe, and a
    // third pass could not add aliases pass 2 hasn't already seen.
    for _ in 0..2 {
        scan(
            body,
            noescape,
            class_fields,
            class_funcs,
            bodies,
            &mut alloc_class,
            &mut disqualified,
            &mut copy_alias,
        );
    }

    // a recv survives only if not disqualified, and any copy-alias of it also not disqualified
    alloc_class
        .into_iter()
        .filter(|(r, _)| !disqualified.contains(r))
        .filter(|(r, _)| {
            !copy_alias
                .iter()
                .any(|(d, s)| *s == *r && disqualified.contains(d))
        })
        .collect()
}

/// True if `f` returns its receiver (`this`, param 0) — directly or via a copy.
/// Such a method's call result aliases the receiver object, so the receiver must
/// stay materialized (not scalar-replaced) for field reads through the result.
fn returns_receiver(f: &Function) -> bool {
    let this_local = match f.params.first() {
        Some(p) => p.0,
        None => return false,
    };
    let mut aliases: BTreeSet<u32> = BTreeSet::new();
    aliases.insert(this_local);
    fn gather(body: &[Inst], aliases: &mut BTreeSet<u32>) {
        for inst in body {
            match inst {
                Inst::Copy { dst, src } if aliases.contains(&src.0) => {
                    aliases.insert(dst.0);
                }
                Inst::Loop {
                    cond_body, body, ..
                } => {
                    gather(cond_body, aliases);
                    gather(body, aliases);
                }
                Inst::If {
                    then_body,
                    else_body,
                    ..
                } => {
                    gather(then_body, aliases);
                    gather(else_body, aliases);
                }
                Inst::TryCatch {
                    try_body,
                    catch_body,
                    finally_body,
                    ..
                } => {
                    gather(try_body, aliases);
                    gather(catch_body, aliases);
                    gather(finally_body, aliases);
                }
                _ => {}
            }
        }
    }
    gather(&f.body, &mut aliases);
    fn returns(body: &[Inst], aliases: &BTreeSet<u32>) -> bool {
        for inst in body {
            match inst {
                Inst::Return { src: Some(s) } if aliases.contains(&s.0) => return true,
                Inst::Loop {
                    cond_body, body, ..
                } => {
                    if returns(cond_body, aliases) || returns(body, aliases) {
                        return true;
                    }
                }
                Inst::If {
                    then_body,
                    else_body,
                    ..
                } => {
                    if returns(then_body, aliases) || returns(else_body, aliases) {
                        return true;
                    }
                }
                Inst::TryCatch {
                    try_body,
                    catch_body,
                    finally_body,
                    ..
                } => {
                    if returns(try_body, aliases)
                        || returns(catch_body, aliases)
                        || returns(finally_body, aliases)
                    {
                        return true;
                    }
                }
                _ => {}
            }
        }
        false
    }
    returns(&f.body, &aliases)
}

fn rewrite_body(
    body: &[Inst],
    number_locs: &BTreeSet<u32>,
    noescape: &BTreeSet<u32>,
    class_fields: &BTreeMap<u32, Vec<u32>>,
    class_funcs: &BTreeMap<u32, BTreeSet<u32>>,
    bodies: &BTreeMap<u32, Function>,
    next: &mut u32,
    new_locals: &mut Vec<Local>,
    sroad: &mut BTreeMap<u32, BTreeMap<u32, u32>>,
    numeric_fields: &BTreeSet<(u32, u32)>,
    numeric_scalars: &mut BTreeSet<u32>,
    cur_fn: u32,
    // Locals referenced outside THIS body (in the enclosing scope / sibling
    // branches). An array root or its alias appearing here escapes the body and
    // must stay materialized — this is the cross-`if`-branch escape analysis the
    // per-body array SROA otherwise lacks.
    outside: &BTreeSet<u32>,
    // Copy-aliases of SROA'd receivers recorded by ENCLOSING bodies. The outer
    // rewrite drops `Copy xn←x` (alias, no emit) for a scalar-replaced x, so a
    // nested body reading through xn must inherit the alias map — otherwise the
    // load stays unrewritten against a never-assigned local (= undefined reads
    // inside if/ternary/loop bodies; s316 silent-miscompile #2b).
    parent_alias: &BTreeMap<u32, u32>,
) -> Vec<Inst> {
    let targets = find_sroa_targets(body, noescape, class_fields, class_funcs, bodies);
    // allocate field scalars for each target receiver
    for (&recv, &cls) in &targets {
        let mut fmap = BTreeMap::new();
        if let Some(fields) = class_fields.get(&cls) {
            for &f in fields {
                // A field scalar is unboxed Primitive (double) ONLY when the field
                // is known-numeric (uniform "number" type from monomorphization).
                // Other fields (arrays, objects, strings, functions...) must be
                // Reference (tsv) so codegen does not insert a ts_to_num round
                // trip that would corrupt the value. Without this, e.g.
                // `class Stack { items: number[] = []; ... }` got its `items`
                // scalarized as a double, turning the array allocation into
                // garbage on every read/write.
                let is_numeric = numeric_fields.contains(&(cls, f));
                let sc = fresh(next, new_locals, !is_numeric);
                if is_numeric {
                    numeric_scalars.insert(sc);
                }
                fmap.insert(f, sc);
            }
        }
        sroad.insert(recv, fmap);
    }

    let array_targets = find_array_sroa_targets(body, number_locs, outside);
    let mut array_scalars: BTreeMap<u32, BTreeMap<u32, u32>> = BTreeMap::new();
    let mut array_lengths: BTreeMap<u32, u32> = BTreeMap::new();
    for (&arr, target) in &array_targets {
        let mut imap = BTreeMap::new();
        for &idx in &target.indices {
            let is_numeric = target.numeric_indices.contains(&idx);
            let sc = fresh(next, new_locals, !is_numeric);
            if is_numeric {
                numeric_scalars.insert(sc);
            }
            imap.insert(idx, sc);
        }
        array_scalars.insert(arr, imap);
        array_lengths.insert(arr, 0);
    }

    let mut out: Vec<Inst> = Vec::new();
    // map copy aliases so a `const v = newobj` recv resolves to the original
    // (seeded with the enclosing bodies' aliases — see parent_alias)
    let mut alias: BTreeMap<u32, u32> = parent_alias.clone();
    let mut array_alias: BTreeMap<u32, u32> = BTreeMap::new();
    let mut const_indices: BTreeMap<u32, u32> = BTreeMap::new();
    // locals that hold a freshly-allocated object of a known class in THIS body.
    // Field access on such a receiver is emitted with the typed `->fN` layout by
    // codegen (its class is in local_class), so inlining a method that does
    // LoadField/StoreField on it stays consistent (typed write + typed read).
    // A receiver NOT known-fresh here may be read dynamically (ts_get) at its use
    // site, which would mismatch a typed inlined write — so we must NOT inline then.
    let mut alloc_class: BTreeMap<u32, u32> = BTreeMap::new();
    let resolve = |id: u32, alias: &BTreeMap<u32, u32>| -> u32 {
        let mut cur = id;
        let mut seen = 0;
        while let Some(&s) = alias.get(&cur) {
            cur = s;
            seen += 1;
            if seen > 64 {
                break;
            }
        }
        cur
    };

    for (inst_idx, inst) in body.iter().enumerate() {
        // record fresh allocations (class known) before handling the inst.
        if let Inst::AllocObject {
            dst,
            class_id: Some(c),
            ..
        } = inst
        {
            alloc_class.insert(dst.0, c.0);
        }
        match inst {
            Inst::AllocArray { dst, .. } if array_scalars.contains_key(&dst.0) => {
                invalidate_array_tracking_def(*dst, &mut array_alias, &mut const_indices);
                array_lengths.insert(dst.0, 0);
            }

            // drop the allocation of an SROA'd object entirely. Static `new C()`
            // now carries C.prototype explicitly so materialized instances get the
            // per-evaluation prototype object. When the instance itself is scalar-
            // replaced, that prototype read is allocation-only overhead; it is
            // emitted immediately before AllocObject, so trim that short producer
            // chain here instead of leaving ts_get(C, "prototype") in hot loops.
            Inst::AllocObject { dst, proto, .. } if sroad.contains_key(&dst.0) => {
                if let Some(p) = proto {
                    trim_trailing_alloc_proto_load(&mut out, p.0);
                }
            }

            Inst::Const { dst, value } => {
                invalidate_array_tracking_def(*dst, &mut array_alias, &mut const_indices);
                if let Some(idx) = const_array_index_value(value) {
                    const_indices.insert(dst.0, idx);
                }
                out.push(inst.clone());
            }

            Inst::Copy { dst, src } => {
                let copied_const = const_indices.get(&src.0).copied();
                invalidate_array_tracking_def(*dst, &mut array_alias, &mut const_indices);
                if let Some(idx) = copied_const {
                    const_indices.insert(dst.0, idx);
                }
                let rsrc = resolve(src.0, &alias);
                if sroad.contains_key(&rsrc) {
                    alias.insert(dst.0, rsrc); /* alias, no emit */
                } else if let Some(aroot) =
                    array_sroa_root_for_scalars(src.0, &array_scalars, &array_alias)
                {
                    array_alias.insert(dst.0, aroot);
                } else {
                    out.push(inst.clone());
                }
            }

            Inst::StoreIndex { arr, index, src } => {
                if let Some(root) = array_sroa_root_for_scalars(arr.0, &array_scalars, &array_alias)
                {
                    if let Some(idx) = const_indices.get(&index.0).copied() {
                        if let Some(sc) =
                            array_scalars.get(&root).and_then(|m| m.get(&idx)).copied()
                        {
                            out.push(Inst::Copy {
                                dst: LocalId(sc),
                                src: *src,
                            });
                        }
                        let len = array_lengths.entry(root).or_insert(0);
                        *len = (*len).max(idx + 1);
                        continue;
                    }
                }
                out.push(inst.clone());
            }

            Inst::LoadIndex { dst, arr, index } => {
                invalidate_array_tracking_def(*dst, &mut array_alias, &mut const_indices);
                if let Some(root) = array_sroa_root_for_scalars(arr.0, &array_scalars, &array_alias)
                {
                    if let Some(idx) = const_indices.get(&index.0).copied() {
                        let sc = array_scalars
                            .get(&root)
                            .and_then(|m| m.get(&idx))
                            .copied()
                            .expect("array sroa scalar for LoadIndex");
                        out.push(Inst::Copy {
                            dst: *dst,
                            src: LocalId(sc),
                        });
                        continue;
                    }
                }
                out.push(inst.clone());
            }

            Inst::StoreFieldDynamic { obj, key, src } => {
                if let Some(root) = array_sroa_root_for_scalars(obj.0, &array_scalars, &array_alias)
                {
                    if let Some(idx) = const_indices.get(&key.0).copied() {
                        if let Some(sc) =
                            array_scalars.get(&root).and_then(|m| m.get(&idx)).copied()
                        {
                            out.push(Inst::Copy {
                                dst: LocalId(sc),
                                src: *src,
                            });
                        }
                        let len = array_lengths.entry(root).or_insert(0);
                        *len = (*len).max(idx + 1);
                        continue;
                    }
                }
                out.push(inst.clone());
            }

            Inst::LoadFieldDynamic { dst, obj, key } => {
                invalidate_array_tracking_def(*dst, &mut array_alias, &mut const_indices);
                if let Some(root) = array_sroa_root_for_scalars(obj.0, &array_scalars, &array_alias)
                {
                    if let Some(idx) = const_indices.get(&key.0).copied() {
                        let sc = array_scalars
                            .get(&root)
                            .and_then(|m| m.get(&idx))
                            .copied()
                            .expect("array sroa scalar for LoadFieldDynamic");
                        out.push(Inst::Copy {
                            dst: *dst,
                            src: LocalId(sc),
                        });
                        continue;
                    }
                }
                out.push(inst.clone());
            }

            Inst::ArrayLen { dst, arr } => {
                invalidate_array_tracking_def(*dst, &mut array_alias, &mut const_indices);
                if let Some(root) = array_sroa_root_for_scalars(arr.0, &array_scalars, &array_alias)
                {
                    let len = *array_lengths.get(&root).unwrap_or(&0);
                    const_indices.insert(dst.0, len);
                    out.push(Inst::Const {
                        dst: *dst,
                        value: ConstVal::Num { value: len as f64 },
                    });
                    continue;
                }
                out.push(inst.clone());
            }

            Inst::Call {
                dst,
                callee: CalleeRef::Direct { func },
                recv: Some(r),
                args,
                ..
            } => {
                let rr = resolve(r.0, &alias);
                if let Some(fmap) = sroad.get(&rr).cloned() {
                    // inline `func` into out, substituting this-fields and params.
                    // SOUNDNESS: the inliner turns a TAIL Return into a Copy into
                    // dst and otherwise drops it. A Return nested inside control
                    // flow (e.g. `if (c) { return x; } return y;`) cannot be
                    // expressed that way — inlining it verbatim would emit a
                    // `return` that exits the CALLER early. Only inline when every
                    // return is in tail position (the body's last instruction).
                    if let Some(callee) = bodies.get(&func.0) {
                        // SOUNDNESS: a method that captures `this` into a closure
                        // (e.g. `get(){ const f = ()=>this.v; return f(); }`, where an
                        // arrow's lexical-this cell stores the receiver) needs a real
                        // `this` OBJECT to box into the cell. Scalar-replacing the
                        // receiver eliminates that object, so the captured cell would
                        // hold garbage. Skip the SROA inline for such methods — the
                        // call is kept and `this` stays a live object.
                        // Generators/async are state machines (emit_generator_function /
                        // emit_async_function); splicing their body into the caller destroys
                        // the coroutine, so never inline them — keep the Direct call so the
                        // generator/async entry point runs and returns its state object.
                        if returns_only_in_tail_position(callee)
                            && !captures_this(callee)
                            && !callee.is_generator
                            && !callee.is_async
                        {
                            if let Some(d) = dst {
                                invalidate_array_tracking_def(
                                    *d,
                                    &mut array_alias,
                                    &mut const_indices,
                                );
                            }
                            inline_callee(
                                callee, &fmap, args, *dst, next, new_locals, &mut out, bodies, 0,
                            );
                            continue;
                        }
                    }
                    // The disqualification net guarantees every Direct call on a
                    // scalar-replaced receiver is inlinable (it rejects non-tail
                    // returns, captures_this, generators/async and unknown bodies).
                    // Reaching here means scan and rewrite drifted apart; emitting
                    // the kept call would read the dropped allocation (dangling
                    // receiver) — fail loudly instead of miscompiling.
                    unreachable!(
                        "sroa: non-inlinable call on scalar-replaced receiver (callee fn{})",
                        func.0
                    );
                }
                // Not a SROA target (e.g. the receiver escapes): still inline a
                // trivial method/constructor so the boxed arg-array round-trip is
                // avoided. SOUNDNESS: a method that reads/writes `this` fields via
                // LoadField/StoreField must only be inlined when the receiver's
                // class is statically known here (a fresh alloc), so codegen emits
                // the SAME typed `->fN` layout the field would use at any other
                // access. Otherwise the receiver might be accessed dynamically
                // (ts_get) elsewhere, mismatching a typed inlined write.
                if let Some(callee) = bodies.get(&func.0) {
                    if callee.id.0 != cur_fn && is_inlinable_free_fn(callee) {
                        let recv_fresh = alloc_class.contains_key(&resolve(r.0, &alias));
                        let touches_this = callee_touches_param0_fields(callee);
                        if recv_fresh || !touches_this {
                            let mut eff: Vec<LocalId> = Vec::with_capacity(args.len() + 1);
                            eff.push(*r);
                            eff.extend(args.iter().copied());
                            if eff.len() == callee.params.len() {
                                if let Some(d) = dst {
                                    invalidate_array_tracking_def(
                                        *d,
                                        &mut array_alias,
                                        &mut const_indices,
                                    );
                                }
                                inline_free_fn(
                                    callee, &eff, *dst, next, new_locals, &mut out, None,
                                );
                                continue;
                            }
                        }
                    }
                }
                invalidate_array_tracking_defs(inst, &mut array_alias, &mut const_indices);
                out.push(inst.clone());
            }

            // A1: small free-function inlining (no receiver). Direct call to a tiny
            // straight-line free function -> inline params->args, Return->Copy.
            Inst::Call {
                dst,
                callee: CalleeRef::Direct { func },
                recv: None,
                args,
                ..
            } => {
                if let Some(callee) = bodies.get(&func.0) {
                    if callee.id.0 != cur_fn
                        && is_inlinable_free_fn(callee)
                        && args.len() == callee.params.len()
                    {
                        let scalar_param_fields =
                            sroa_param_field_maps(callee, args, sroad, &alias);
                        if let Some(d) = dst {
                            invalidate_array_tracking_def(*d, &mut array_alias, &mut const_indices);
                        }
                        inline_free_fn(
                            callee,
                            args,
                            *dst,
                            next,
                            new_locals,
                            &mut out,
                            if scalar_param_fields.is_empty() {
                                None
                            } else {
                                Some(&scalar_param_fields)
                            },
                        );
                        continue;
                    }
                }
                invalidate_array_tracking_defs(inst, &mut array_alias, &mut const_indices);
                // The disqualification net only lets an object arg through when
                // this exact call is inlinable (straight-line callee + matching
                // arity), so a kept call must never carry a scalar-replaced arg.
                for a in args {
                    if sroad.contains_key(&resolve(a.0, &alias)) {
                        unreachable!(
                            "sroa: kept call passes scalar-replaced arg (callee fn{})",
                            func.0
                        );
                    }
                }
                out.push(inst.clone());
            }

            // Caller-scope field access on an SROA'd receiver (or a copy-alias of
            // one): redirect to the field scalar instead of leaving a LoadField/
            // StoreField that reads the (now-eliminated) heap object. Without this,
            // `const c = new C(); c.x` would emit ts_get(deadObject) -> undefined.
            Inst::LoadField { dst, obj, field } => {
                let robj = resolve(obj.0, &alias);
                if let Some(fmap) = sroad.get(&robj) {
                    if let Some(&sc) = fmap.get(&field.0) {
                        invalidate_array_tracking_def(*dst, &mut array_alias, &mut const_indices);
                        out.push(Inst::Copy {
                            dst: *dst,
                            src: LocalId(sc),
                        });
                        continue;
                    }
                }
                invalidate_array_tracking_defs(inst, &mut array_alias, &mut const_indices);
                out.push(inst.clone());
            }
            Inst::StoreField { obj, field, src } => {
                let robj = resolve(obj.0, &alias);
                if let Some(fmap) = sroad.get(&robj) {
                    if let Some(&sc) = fmap.get(&field.0) {
                        out.push(Inst::Copy {
                            dst: LocalId(sc),
                            src: *src,
                        });
                        continue;
                    }
                }
                invalidate_array_tracking_defs(inst, &mut array_alias, &mut const_indices);
                out.push(inst.clone());
            }

            Inst::Loop {
                cond,
                cond_body,
                body: loop_body,
            } => {
                // Locals referenced in the enclosing scope (outside this Loop):
                // `outside` plus everything in the current body except this Loop.
                let mut surround = outside.clone();
                collect_local_refs(&body[..inst_idx], &mut surround);
                collect_local_refs(&body[inst_idx + 1..], &mut surround);
                surround.insert(cond.0);
                // cond_body and loop body cross-reference each other across
                // iterations, so each escapes into the other.
                let mut cond_outside = surround.clone();
                collect_local_refs(loop_body, &mut cond_outside);
                let mut body_outside = surround;
                collect_local_refs(cond_body, &mut body_outside);
                let cb = rewrite_body(
                    cond_body,
                    number_locs,
                    noescape,
                    class_fields,
                    class_funcs,
                    bodies,
                    next,
                    new_locals,
                    sroad,
                    numeric_fields,
                    numeric_scalars,
                    cur_fn,
                    &cond_outside,
                    &alias,
                );
                let bb = rewrite_body(
                    loop_body,
                    number_locs,
                    noescape,
                    class_fields,
                    class_funcs,
                    bodies,
                    next,
                    new_locals,
                    sroad,
                    numeric_fields,
                    numeric_scalars,
                    cur_fn,
                    &body_outside,
                    &alias,
                );
                array_alias.clear();
                const_indices.clear();
                out.push(Inst::Loop {
                    cond: *cond,
                    cond_body: cb,
                    body: bb,
                });
            }
            Inst::If {
                cond,
                then_body,
                else_body,
            } => {
                // Locals referenced outside this If: `outside` plus the rest of the
                // current body plus the cond. Each branch additionally sees the
                // other branch's refs (a local written in both branches and read
                // after the `if` — the ternary result — thus escapes each branch).
                let mut surround = outside.clone();
                collect_local_refs(&body[..inst_idx], &mut surround);
                collect_local_refs(&body[inst_idx + 1..], &mut surround);
                surround.insert(cond.0);
                let mut then_outside = surround.clone();
                collect_local_refs(else_body, &mut then_outside);
                let mut else_outside = surround;
                collect_local_refs(then_body, &mut else_outside);
                let tb = rewrite_body(
                    then_body,
                    number_locs,
                    noescape,
                    class_fields,
                    class_funcs,
                    bodies,
                    next,
                    new_locals,
                    sroad,
                    numeric_fields,
                    numeric_scalars,
                    cur_fn,
                    &then_outside,
                    &alias,
                );
                let eb = rewrite_body(
                    else_body,
                    number_locs,
                    noescape,
                    class_fields,
                    class_funcs,
                    bodies,
                    next,
                    new_locals,
                    sroad,
                    numeric_fields,
                    numeric_scalars,
                    cur_fn,
                    &else_outside,
                    &alias,
                );
                array_alias.clear();
                const_indices.clear();
                out.push(Inst::If {
                    cond: *cond,
                    then_body: tb,
                    else_body: eb,
                });
            }
            Inst::TryCatch {
                try_body,
                catch_var,
                catch_body,
                finally_body,
            } => {
                // try/catch/finally も If と同様に再帰して書き換える（降りないと
                // 外側で dematerialize 済みレシーバの読みが未書き換えで残り、
                // undefined 化する — s316 silent-miscompile #2c）。
                let mut surround = outside.clone();
                collect_local_refs(&body[..inst_idx], &mut surround);
                collect_local_refs(&body[inst_idx + 1..], &mut surround);
                if let Some(cv) = catch_var {
                    surround.insert(cv.0);
                }
                let mut try_outside = surround.clone();
                collect_local_refs(catch_body, &mut try_outside);
                collect_local_refs(finally_body, &mut try_outside);
                let mut catch_outside = surround.clone();
                collect_local_refs(try_body, &mut catch_outside);
                collect_local_refs(finally_body, &mut catch_outside);
                let mut fin_outside = surround;
                collect_local_refs(try_body, &mut fin_outside);
                collect_local_refs(catch_body, &mut fin_outside);
                let tb = rewrite_body(
                    try_body,
                    number_locs,
                    noescape,
                    class_fields,
                    class_funcs,
                    bodies,
                    next,
                    new_locals,
                    sroad,
                    numeric_fields,
                    numeric_scalars,
                    cur_fn,
                    &try_outside,
                    &alias,
                );
                let cb = rewrite_body(
                    catch_body,
                    number_locs,
                    noescape,
                    class_fields,
                    class_funcs,
                    bodies,
                    next,
                    new_locals,
                    sroad,
                    numeric_fields,
                    numeric_scalars,
                    cur_fn,
                    &catch_outside,
                    &alias,
                );
                let fb = rewrite_body(
                    finally_body,
                    number_locs,
                    noescape,
                    class_fields,
                    class_funcs,
                    bodies,
                    next,
                    new_locals,
                    sroad,
                    numeric_fields,
                    numeric_scalars,
                    cur_fn,
                    &fin_outside,
                    &alias,
                );
                array_alias.clear();
                const_indices.clear();
                out.push(Inst::TryCatch {
                    try_body: tb,
                    catch_var: *catch_var,
                    catch_body: cb,
                    finally_body: fb,
                });
            }
            other => {
                invalidate_array_tracking_defs(other, &mut array_alias, &mut const_indices);
                out.push(other.clone());
            }
        }
    }
    out
}

fn trim_trailing_alloc_proto_load(out: &mut Vec<Inst>, proto_local: u32) {
    let class_value_local = match out.last() {
        Some(Inst::LoadField { dst, obj, .. }) if dst.0 == proto_local => obj.0,
        _ => return,
    };
    out.pop();
    match out.last() {
        Some(Inst::LoadField { dst, .. })
        | Some(Inst::LoadGlobal { dst, .. })
        | Some(Inst::Copy { dst, .. })
            if dst.0 == class_value_local =>
        {
            out.pop();
        }
        _ => {}
    }
}

/// Inline a callee body: param i -> args[i], `this.fK` -> fmap[K], Return x -> dst=x.
/// Callee locals that are neither params nor `this` get fresh ids to avoid clashes.
/// A free function is inlinable if its body is small and straight-line: only
/// value-producing instructions (Const/BinOp/UnOp/Copy/LoadField/StoreField) and
/// at most a trailing Return. NO control flow (If/Loop/Break/Continue), no nested
/// Call/alloc/Throw/Print — those would need operand remapping we don't do here
/// and could change effects/ordering. This keeps inlining sound and cheap.
/// True if the callee reads or writes fields of its first parameter (`this`) via
/// LoadField/StoreField. Such a method may only be inlined onto a receiver whose
/// class is statically known at the call site (so field access stays typed and
/// consistent); a method that never touches `this` fields (e.g. identity returns)
/// is safe to inline onto any receiver.
/// True if `f` needs a materialized `this`: it is a generator/async method (its
/// receiver is captured into a coroutine frame that outlives the call), or it
/// (transitively) makes a Direct call on its own receiver (param 0) to such a
/// method. A receiver flowing into such a method — directly, or via inlining —
/// must NOT be scalar-replaced (the kept state-machine call needs a real object).
/// Depth-guarded; conservative (returns true) on overflow.
fn needs_materialized_this(f: &Function, bodies: &BTreeMap<u32, Function>, depth: u32) -> bool {
    if f.is_generator || f.is_async {
        return true;
    }
    if depth > 16 {
        return true;
    }
    let p0 = match f.params.first() {
        Some(p) => p.0,
        None => return false,
    };
    fn scan(body: &[Inst], p0: u32, bodies: &BTreeMap<u32, Function>, depth: u32) -> bool {
        body.iter().any(|inst| match inst {
            Inst::LoadFieldDynamic { obj, .. }
            | Inst::StoreFieldDynamic { obj, .. }
            | Inst::HasFieldDynamic { obj, .. }
                if obj.0 == p0 =>
            {
                true
            }
            Inst::DeleteField { obj, .. } if obj.0 == p0 => true,
            Inst::Call {
                recv: Some(r),
                callee: CalleeRef::Direct { func },
                ..
            } if r.0 == p0 => bodies
                .get(&func.0)
                .map_or(false, |cf| needs_materialized_this(cf, bodies, depth + 1)),
            Inst::Loop {
                cond_body, body, ..
            } => scan(cond_body, p0, bodies, depth) || scan(body, p0, bodies, depth),
            Inst::If {
                then_body,
                else_body,
                ..
            } => scan(then_body, p0, bodies, depth) || scan(else_body, p0, bodies, depth),
            Inst::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                scan(try_body, p0, bodies, depth)
                    || scan(catch_body, p0, bodies, depth)
                    || scan(finally_body, p0, bodies, depth)
            }
            _ => false,
        })
    }
    scan(&f.body, p0, bodies, depth)
}

fn callee_touches_param0_fields(f: &Function) -> bool {
    let p0 = match f.params.first() {
        Some(p) => p.0,
        None => return false,
    };
    f.body.iter().any(|inst| match inst {
        Inst::LoadField { obj, .. } => obj.0 == p0,
        Inst::StoreField { obj, .. } => obj.0 == p0,
        _ => false,
    })
}

fn callee_param_field_only_sroa_safe(
    f: &Function,
    param_index: usize,
    class_fields: &[u32],
) -> bool {
    let p = match f.params.get(param_index) {
        Some(p) => p.0,
        None => return false,
    };
    let field_ok = |field: FieldId| class_fields.iter().any(|f| *f == field.0);
    for inst in &f.body {
        match inst {
            Inst::LoadField { dst, obj, field } => {
                if dst.0 == p {
                    return false;
                }
                if obj.0 == p && !field_ok(*field) {
                    return false;
                }
            }
            Inst::StoreField { obj, field, src } => {
                if src.0 == p {
                    return false;
                }
                if obj.0 == p && !field_ok(*field) {
                    return false;
                }
            }
            Inst::Const { dst, .. } => {
                if dst.0 == p {
                    return false;
                }
            }
            Inst::BinOp { dst, lhs, rhs, .. } => {
                if dst.0 == p || lhs.0 == p || rhs.0 == p {
                    return false;
                }
            }
            Inst::UnOp { dst, operand, .. } => {
                if dst.0 == p || operand.0 == p {
                    return false;
                }
            }
            Inst::Copy { dst, src } => {
                if dst.0 == p || src.0 == p {
                    return false;
                }
            }
            Inst::Return { src: Some(src) } => {
                if src.0 == p {
                    return false;
                }
            }
            Inst::Return { src: None } => {}
            _ => return false,
        }
    }
    true
}

fn sroa_param_field_maps(
    callee: &Function,
    args: &[LocalId],
    sroad: &BTreeMap<u32, BTreeMap<u32, u32>>,
    alias: &BTreeMap<u32, u32>,
) -> BTreeMap<u32, BTreeMap<u32, u32>> {
    fn resolve(id: u32, alias: &BTreeMap<u32, u32>) -> u32 {
        let mut cur = id;
        let mut seen = 0;
        while let Some(&s) = alias.get(&cur) {
            cur = s;
            seen += 1;
            if seen > 64 {
                break;
            }
        }
        cur
    }
    let mut maps = BTreeMap::new();
    for (i, p) in callee.params.iter().enumerate() {
        if let Some(arg) = args.get(i) {
            let root = resolve(arg.0, alias);
            if let Some(fmap) = sroad.get(&root) {
                maps.insert(p.0, fmap.clone());
            }
        }
    }
    maps
}

/// True if `f`'s body contains no `Return` nested inside control flow — i.e.
/// the only `Return` (if any) is the body's final top-level instruction. The
/// SROA method inliner converts a tail Return into a `Copy` into the call's dst
/// and drops it; a Return inside an `If`/`Loop`/`TryCatch` would be inlined
/// verbatim and wrongly exit the CALLER. Reject such bodies for inlining.
fn returns_only_in_tail_position(f: &Function) -> bool {
    fn nested_has_return(insts: &[Inst]) -> bool {
        for inst in insts {
            match inst {
                Inst::Return { .. } => return true,
                Inst::If {
                    then_body,
                    else_body,
                    ..
                } => {
                    if nested_has_return(then_body) || nested_has_return(else_body) {
                        return true;
                    }
                }
                Inst::Loop {
                    cond_body, body, ..
                } => {
                    if nested_has_return(cond_body) || nested_has_return(body) {
                        return true;
                    }
                }
                Inst::TryCatch {
                    try_body,
                    catch_body,
                    finally_body,
                    ..
                } => {
                    if nested_has_return(try_body)
                        || nested_has_return(catch_body)
                        || nested_has_return(finally_body)
                    {
                        return true;
                    }
                }
                _ => {}
            }
        }
        false
    }
    let n = f.body.len();
    for (i, inst) in f.body.iter().enumerate() {
        match inst {
            // A top-level Return is only OK as the final instruction.
            Inst::Return { .. } => {
                if i != n - 1 {
                    return false;
                }
            }
            // Returns nested inside control flow are never OK.
            Inst::If {
                then_body,
                else_body,
                ..
            } => {
                if nested_has_return(then_body) || nested_has_return(else_body) {
                    return false;
                }
            }
            Inst::Loop {
                cond_body, body, ..
            } => {
                if nested_has_return(cond_body) || nested_has_return(body) {
                    return false;
                }
            }
            Inst::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                if nested_has_return(try_body)
                    || nested_has_return(catch_body)
                    || nested_has_return(finally_body)
                {
                    return false;
                }
            }
            _ => {}
        }
    }
    true
}

/// Does this function capture `this` (param 0) into a closure? Detected as: the
/// body stores param-0 into some object via StoreField, and also creates a
/// closure (AllocClosure). This is the lexical-this-cell pattern an arrow that
/// reads `this` produces. Conservative over-approximation: any StoreField whose
/// source is `this` combined with any AllocClosure. Walks nested control flow.
fn captures_this(f: &Function) -> bool {
    let this_local = match f.params.first() {
        Some(p) => p.0,
        None => return false,
    };
    fn scan(body: &[Inst], this_local: u32, stores_this: &mut bool, has_closure: &mut bool) {
        for inst in body {
            match inst {
                Inst::StoreField { src, .. } if src.0 == this_local => *stores_this = true,
                Inst::AllocClosure { .. } => *has_closure = true,
                Inst::Loop {
                    cond_body, body, ..
                } => {
                    scan(cond_body, this_local, stores_this, has_closure);
                    scan(body, this_local, stores_this, has_closure);
                }
                Inst::If {
                    then_body,
                    else_body,
                    ..
                } => {
                    scan(then_body, this_local, stores_this, has_closure);
                    scan(else_body, this_local, stores_this, has_closure);
                }
                Inst::TryCatch {
                    try_body,
                    catch_body,
                    finally_body,
                    ..
                } => {
                    scan(try_body, this_local, stores_this, has_closure);
                    scan(catch_body, this_local, stores_this, has_closure);
                    scan(finally_body, this_local, stores_this, has_closure);
                }
                _ => {}
            }
        }
    }
    let (mut stores_this, mut has_closure) = (false, false);
    scan(&f.body, this_local, &mut stores_this, &mut has_closure);
    stores_this && has_closure
}

fn is_inlinable_free_fn(f: &Function) -> bool {
    // Generators/async are state machines (emit_generator_function / emit_async_function);
    // their bodies must never be spliced into a caller. (An empty generator whose body is a
    // lone Return would otherwise pass the checks below.)
    if f.is_generator || f.is_async {
        return false;
    }
    const MAX_BODY: usize = 8;
    if f.body.len() > MAX_BODY {
        return false;
    }
    let is_param = |id: u32| f.params.iter().any(|p| p.0 == id);
    // A write to a parameter would clobber the caller's argument local after we
    // substitute param->arg, so reject any callee that assigns to a param.
    let writes_param = |d: &LocalId| is_param(d.0);
    let mut returns = 0;
    for (i, inst) in f.body.iter().enumerate() {
        match inst {
            Inst::Const { dst, .. }
            | Inst::BinOp { dst, .. }
            | Inst::UnOp { dst, .. }
            | Inst::Copy { dst, .. }
            | Inst::LoadField { dst, .. } => {
                if writes_param(dst) {
                    return false;
                }
            }
            Inst::StoreField { .. } => {}
            Inst::Return { .. } => {
                returns += 1;
                if i != f.body.len() - 1 {
                    return false;
                }
            }
            _ => return false, // any control flow / call / alloc / effect -> not inlinable
        }
    }
    returns <= 1
}

/// Inline a small straight-line free function: params -> args, locals fresh, and
/// a trailing Return -> Copy into dst. No `this`/field handling (free function).
fn inline_free_fn(
    callee: &Function,
    args: &[LocalId],
    dst: Option<LocalId>,
    next: &mut u32,
    new_locals: &mut Vec<Local>,
    out: &mut Vec<Inst>,
    scalar_param_fields: Option<&BTreeMap<u32, BTreeMap<u32, u32>>>,
) {
    let mut subst: BTreeMap<u32, u32> = BTreeMap::new();
    for (i, p) in callee.params.iter().enumerate() {
        if let Some(a) = args.get(i) {
            subst.insert(p.0, a.0);
        }
    }
    for l in &callee.locals {
        if callee.params.iter().any(|p| p.0 == l.id.0) {
            continue;
        }
        let nl = fresh(next, new_locals, !matches!(l.ref_kind, RefKind::Primitive));
        subst.insert(l.id.0, nl);
    }
    let m = |id: LocalId| -> LocalId { LocalId(*subst.get(&id.0).unwrap_or(&id.0)) };
    for inst in &callee.body {
        match inst {
            Inst::Const { dst: d, value } => out.push(Inst::Const {
                dst: m(*d),
                value: value.clone(),
            }),
            Inst::BinOp {
                dst: d,
                op,
                lhs,
                rhs,
            } => out.push(Inst::BinOp {
                dst: m(*d),
                op: op.clone(),
                lhs: m(*lhs),
                rhs: m(*rhs),
            }),
            Inst::UnOp {
                dst: d,
                op,
                operand,
            } => out.push(Inst::UnOp {
                dst: m(*d),
                op: op.clone(),
                operand: m(*operand),
            }),
            Inst::Copy { dst: d, src } => out.push(Inst::Copy {
                dst: m(*d),
                src: m(*src),
            }),
            Inst::LoadField { dst: d, obj, field } => {
                if let Some(fields_by_param) = scalar_param_fields {
                    if let Some(fmap) = fields_by_param.get(&obj.0) {
                        if let Some(&fs) = fmap.get(&field.0) {
                            out.push(Inst::Copy {
                                dst: m(*d),
                                src: LocalId(fs),
                            });
                            continue;
                        }
                    }
                }
                out.push(Inst::LoadField {
                    dst: m(*d),
                    obj: m(*obj),
                    field: *field,
                });
            }
            Inst::StoreField { obj, field, src } => {
                if let Some(fields_by_param) = scalar_param_fields {
                    if let Some(fmap) = fields_by_param.get(&obj.0) {
                        if let Some(&fs) = fmap.get(&field.0) {
                            out.push(Inst::Copy {
                                dst: LocalId(fs),
                                src: m(*src),
                            });
                            continue;
                        }
                    }
                }
                out.push(Inst::StoreField {
                    obj: m(*obj),
                    field: *field,
                    src: m(*src),
                });
            }
            Inst::Return { src } => {
                if let (Some(d), Some(s)) = (dst, src) {
                    out.push(Inst::Copy { dst: d, src: m(*s) });
                }
            }
            _ => {} // unreachable: is_inlinable_free_fn rejects other kinds
        }
    }
}

fn inline_callee(
    callee: &Function,
    fmap: &BTreeMap<u32, u32>,
    args: &[LocalId],
    dst: Option<LocalId>,
    next: &mut u32,
    new_locals: &mut Vec<Local>,
    out: &mut Vec<Inst>,
    bodies: &BTreeMap<u32, Function>,
    depth: u32,
) {
    // param 0 is `this`; params 1.. map to args
    let mut subst: BTreeMap<u32, u32> = BTreeMap::new();
    for (i, p) in callee.params.iter().enumerate() {
        if i == 0 {
            continue;
        } // this -> handled via field map
        if let Some(a) = args.get(i - 1) {
            subst.insert(p.0, a.0);
        }
    }
    // fresh-rename all non-param callee locals
    for l in &callee.locals {
        if callee.params.iter().any(|p| p.0 == l.id.0) {
            continue;
        }
        let nl = fresh(next, new_locals, !matches!(l.ref_kind, RefKind::Primitive));
        subst.insert(l.id.0, nl);
    }
    let this_local = callee.params.first().map(|p| p.0);
    let m = |id: LocalId| -> LocalId { LocalId(*subst.get(&id.0).unwrap_or(&id.0)) };

    for inst in &callee.body {
        match inst {
            // this.fK load -> copy from field scalar
            Inst::LoadField { dst: d, obj, field } if Some(obj.0) == this_local => {
                if let Some(&fs) = fmap.get(&field.0) {
                    out.push(Inst::Copy {
                        dst: m(*d),
                        src: LocalId(fs),
                    });
                } else {
                    out.push(Inst::LoadField {
                        dst: m(*d),
                        obj: m(*obj),
                        field: *field,
                    });
                }
            }
            // this.fK store -> write field scalar
            Inst::StoreField { obj, field, src } if Some(obj.0) == this_local => {
                if let Some(&fs) = fmap.get(&field.0) {
                    out.push(Inst::Copy {
                        dst: LocalId(fs),
                        src: m(*src),
                    });
                } else {
                    out.push(Inst::StoreField {
                        obj: m(*obj),
                        field: *field,
                        src: m(*src),
                    });
                }
            }
            // super(...) / this.method(...) : a Direct call whose receiver is our
            // own `this`. Recursively inline it with the SAME field-scalar map
            // (prefix layout means parent and child share field offsets), so the
            // subclass instance is fully eliminated. Depth-guarded.
            Inst::Call {
                dst: cd,
                callee: CalleeRef::Direct { func },
                recv: Some(r),
                args: cargs,
                ..
            } if Some(r.0) == this_local && depth < 16 => {
                // Skip generator/async inner methods (state machines): inlining their body
                // would destroy the coroutine. The .filter drops them to the remapped-Call
                // fallback below, keeping a Direct call to the state-machine entry point.
                if let Some(inner) = bodies
                    .get(&func.0)
                    .filter(|c| !c.is_generator && !c.is_async)
                {
                    let mapped_args: Vec<LocalId> = cargs.iter().map(|a| m(*a)).collect();
                    inline_callee(
                        inner,
                        fmap,
                        &mapped_args,
                        cd.map(|d| m(d)),
                        next,
                        new_locals,
                        out,
                        bodies,
                        depth + 1,
                    );
                } else {
                    // body unavailable: fall back to remapped call (best effort)
                    let margs: Vec<LocalId> = cargs.iter().map(|a| m(*a)).collect();
                    out.push(Inst::Call {
                        dst: cd.map(|d| m(d)),
                        callee: CalleeRef::Direct { func: *func },
                        recv: Some(m(*r)),
                        args: margs,
                        resolved_sig: None,
                    });
                }
            }
            Inst::Return { src } => {
                if let (Some(d), Some(s)) = (dst, src) {
                    out.push(Inst::Copy { dst: d, src: m(*s) });
                }
                // a return inside an inlined body just stops contributing values;
                // for our straight-line callees this is the last instruction.
            }
            // generic instructions: remap operands through subst
            Inst::Const { dst: d, value } => out.push(Inst::Const {
                dst: m(*d),
                value: value.clone(),
            }),
            Inst::BinOp {
                dst: d,
                op,
                lhs,
                rhs,
            } => out.push(Inst::BinOp {
                dst: m(*d),
                op: op.clone(),
                lhs: m(*lhs),
                rhs: m(*rhs),
            }),
            Inst::UnOp {
                dst: d,
                op,
                operand,
            } => out.push(Inst::UnOp {
                dst: m(*d),
                op: op.clone(),
                operand: m(*operand),
            }),
            Inst::Copy { dst: d, src } => out.push(Inst::Copy {
                dst: m(*d),
                src: m(*src),
            }),
            Inst::LoadField { dst: d, obj, field } => out.push(Inst::LoadField {
                dst: m(*d),
                obj: m(*obj),
                field: *field,
            }),
            Inst::StoreField { obj, field, src } => out.push(Inst::StoreField {
                obj: m(*obj),
                field: *field,
                src: m(*src),
            }),
            // Every remaining instruction kind that names a LocalId must be
            // remapped through `m`. The previous catch-all `other.clone()`
            // emitted callee-local IDs into the caller's frame, silently
            // aliasing or reading uninitialized locals (e.g. inlining
            // `dist(){ return Math.sqrt(this.x*this.x+this.y*this.y); }` copied
            // `CallBuiltinStatic math.sqrt args=[7]` verbatim, but the sum lived
            // in the renamed local). Exhaustive remap closes that hole. Nested
            // bodies (If/Loop/TryCatch) are walked recursively through `m`.
            other => out.push(remap_inst_operands(other, &m)),
        }
    }
}

/// Clone an Inst while remapping every `LocalId` operand through `m`. Used by
/// `inline_callee` for variants that don't need special handling (everything
/// other than `this`-LoadField/StoreField, `this`-Direct calls, and Return).
/// Nested bodies (If/Loop/TryCatch) are walked recursively. This MUST be
/// exhaustive over `Inst`: an unhandled variant emitted with original local
/// IDs would silently read from the caller's wrong locals (the bug this
/// helper fixes — see `classes__basic` conformance test).
fn remap_inst_operands(inst: &Inst, m: &dyn Fn(LocalId) -> LocalId) -> Inst {
    let mremap = |i: &Inst| remap_inst_operands(i, m);
    let mvec = |body: &[Inst]| body.iter().map(&mremap).collect::<Vec<_>>();
    let mopt = |o: &Option<LocalId>| o.map(|l| m(l));
    // A call through a first-class value (`f()` where `f` is a local, e.g. a
    // callback parameter) holds its callee in a LocalId — that local MUST be
    // remapped too, or inlining a method that invokes a callback parameter would
    // keep the callee's local id and call an uninitialized/aliased slot.
    let mcallee = |c: &CalleeRef| -> CalleeRef {
        match c {
            CalleeRef::Value { local } => CalleeRef::Value { local: m(*local) },
            other => other.clone(),
        }
    };
    match inst {
        // already handled by inline_callee's own arms, but kept exhaustive in case
        // a future caller routes them through here:
        Inst::Const { dst, value } => Inst::Const {
            dst: m(*dst),
            value: value.clone(),
        },
        Inst::BinOp { dst, op, lhs, rhs } => Inst::BinOp {
            dst: m(*dst),
            op: op.clone(),
            lhs: m(*lhs),
            rhs: m(*rhs),
        },
        Inst::UnOp { dst, op, operand } => Inst::UnOp {
            dst: m(*dst),
            op: op.clone(),
            operand: m(*operand),
        },
        Inst::Copy { dst, src } => Inst::Copy {
            dst: m(*dst),
            src: m(*src),
        },
        Inst::LoadField { dst, obj, field } => Inst::LoadField {
            dst: m(*dst),
            obj: m(*obj),
            field: *field,
        },
        Inst::StoreField { obj, field, src } => Inst::StoreField {
            obj: m(*obj),
            field: *field,
            src: m(*src),
        },
        Inst::LoadMethodValue { dst, recv, method } => Inst::LoadMethodValue {
            dst: m(*dst),
            recv: m(*recv),
            method: *method,
        },
        Inst::LoadBuiltinFn { dst, builtin } => Inst::LoadBuiltinFn {
            dst: m(*dst),
            builtin: builtin.clone(),
        },
        Inst::AllocClassValue {
            dst,
            class_id,
            ctor,
            captures,
        } => Inst::AllocClassValue {
            dst: m(*dst),
            class_id: *class_id,
            ctor: *ctor,
            captures: captures
                .iter()
                .map(|c| Capture {
                    binding: c.binding,
                    cell: m(c.cell),
                })
                .collect(),
        },
        Inst::NewDynamic {
            dst,
            callee,
            args,
            poly,
        } => Inst::NewDynamic {
            dst: m(*dst),
            callee: m(*callee),
            args: args.iter().map(|a| m(*a)).collect(),
            poly: *poly,
        },
        // allocations
        Inst::AllocObject {
            dst,
            type_id,
            site,
            class_id,
            proto,
        } => Inst::AllocObject {
            dst: m(*dst),
            type_id: *type_id,
            site: *site,
            class_id: *class_id,
            proto: proto.map(|p| m(p)),
        },
        Inst::AllocArray {
            dst,
            elem_type,
            site,
        } => Inst::AllocArray {
            dst: m(*dst),
            elem_type: *elem_type,
            site: *site,
        },
        Inst::AllocClosure {
            dst,
            func,
            captures,
            site,
        } => Inst::AllocClosure {
            dst: m(*dst),
            func: *func,
            site: *site,
            captures: captures
                .iter()
                .map(|c| Capture {
                    binding: c.binding,
                    cell: m(c.cell),
                })
                .collect(),
        },
        // load/store
        Inst::LoadElem { dst, arr } => Inst::LoadElem {
            dst: m(*dst),
            arr: m(*arr),
        },
        Inst::StoreElem { arr, src } => Inst::StoreElem {
            arr: m(*arr),
            src: m(*src),
        },
        Inst::LoadIndex { dst, arr, index } => Inst::LoadIndex {
            dst: m(*dst),
            arr: m(*arr),
            index: m(*index),
        },
        Inst::StoreIndex { arr, index, src } => Inst::StoreIndex {
            arr: m(*arr),
            index: m(*index),
            src: m(*src),
        },
        Inst::LoadGlobal { dst, gref } => Inst::LoadGlobal {
            dst: m(*dst),
            gref: *gref,
        },
        Inst::StoreGlobal { gref, src } => Inst::StoreGlobal {
            gref: *gref,
            src: m(*src),
        },
        Inst::LoadFieldDynamic { dst, obj, key } => Inst::LoadFieldDynamic {
            dst: m(*dst),
            obj: m(*obj),
            key: m(*key),
        },
        Inst::StoreFieldDynamic { obj, key, src } => Inst::StoreFieldDynamic {
            obj: m(*obj),
            key: m(*key),
            src: m(*src),
        },
        Inst::HasField { dst, obj, field } => Inst::HasField {
            dst: m(*dst),
            obj: m(*obj),
            field: *field,
        },
        Inst::HasFieldDynamic { dst, obj, key } => Inst::HasFieldDynamic {
            dst: m(*dst),
            obj: m(*obj),
            key: m(*key),
        },
        Inst::DeleteField { dst, obj, field, method } => Inst::DeleteField {
            dst: mopt(dst),
            obj: m(*obj),
            field: *field,
            method: *method,
        },
        // calls
        Inst::Call {
            dst,
            callee,
            recv,
            args,
            resolved_sig,
        } => Inst::Call {
            dst: mopt(dst),
            callee: mcallee(callee),
            recv: mopt(recv),
            args: args.iter().map(|a| m(*a)).collect(),
            resolved_sig: *resolved_sig,
        },
        Inst::CallSpread {
            dst,
            callee,
            recv,
            arg_specs,
        } => Inst::CallSpread {
            dst: mopt(dst),
            callee: mcallee(callee),
            recv: mopt(recv),
            arg_specs: arg_specs
                .iter()
                .map(|s| match s {
                    ArgSpec::Single { local } => ArgSpec::Single { local: m(*local) },
                    ArgSpec::Spread { local } => ArgSpec::Spread { local: m(*local) },
                })
                .collect(),
        },
        Inst::CallBuiltin {
            dst,
            builtin,
            recv,
            args,
        } => Inst::CallBuiltin {
            dst: mopt(dst),
            builtin: builtin.clone(),
            recv: m(*recv),
            args: args.iter().map(|a| m(*a)).collect(),
        },
        Inst::CallBuiltinStatic { dst, builtin, args } => Inst::CallBuiltinStatic {
            dst: mopt(dst),
            builtin: builtin.clone(),
            args: args.iter().map(|a| m(*a)).collect(),
        },
        // arrays / collections
        Inst::ArrayLen { dst, arr } => Inst::ArrayLen {
            dst: m(*dst),
            arr: m(*arr),
        },
        Inst::StringLen { dst, src } => Inst::StringLen {
            dst: m(*dst),
            src: m(*src),
        },
        Inst::ArrayPush { arr, src } => Inst::ArrayPush {
            arr: m(*arr),
            src: m(*src),
        },
        Inst::ArrayPushAll { arr, src } => Inst::ArrayPushAll {
            arr: m(*arr),
            src: m(*src),
        },
        Inst::ArraySlice { dst, arr, start } => Inst::ArraySlice {
            dst: m(*dst),
            arr: m(*arr),
            start: m(*start),
        },
        Inst::ObjectRest { dst, src, exclude } => Inst::ObjectRest {
            dst: m(*dst),
            src: m(*src),
            exclude: exclude.clone(),
        },
        Inst::ObjectCopyProps { dst, src } => Inst::ObjectCopyProps {
            dst: m(*dst),
            src: m(*src),
        },
        Inst::NewMap { dst } => Inst::NewMap { dst: m(*dst) },
        Inst::NewSet { dst } => Inst::NewSet { dst: m(*dst) },
        Inst::GenericLen { dst, src } => Inst::GenericLen {
            dst: m(*dst),
            src: m(*src),
        },
        // proto / class
        Inst::LoadClassProto { dst, class_id } => Inst::LoadClassProto {
            dst: m(*dst),
            class_id: *class_id,
        },
        Inst::StoreProtoMethod {
            class_id,
            method,
            src,
        } => Inst::StoreProtoMethod {
            class_id: *class_id,
            method: *method,
            src: m(*src),
        },
        Inst::StoreMethod { obj, method, src } => Inst::StoreMethod {
            obj: m(*obj),
            method: *method,
            src: m(*src),
        },
        Inst::GetProto { dst, obj } => Inst::GetProto {
            dst: m(*dst),
            obj: m(*obj),
        },
        Inst::SetProto { dst, obj, proto } => Inst::SetProto {
            dst: mopt(dst),
            obj: m(*obj),
            proto: m(*proto),
        },
        Inst::ConstructResult { dst, inst, ret } => Inst::ConstructResult {
            dst: m(*dst),
            inst: m(*inst),
            ret: m(*ret),
        },
        // control flow (nested bodies need recursive remap)
        Inst::Print { src } => Inst::Print { src: m(*src) },
        Inst::Return { src } => Inst::Return { src: mopt(src) },
        Inst::Throw { src } => Inst::Throw { src: m(*src) },
        Inst::Yield { dst, operand } => Inst::Yield {
            dst: mopt(dst),
            operand: m(*operand),
        },
        Inst::Await { dst, operand } => Inst::Await {
            dst: mopt(dst),
            operand: m(*operand),
        },
        Inst::If {
            cond,
            then_body,
            else_body,
        } => Inst::If {
            cond: m(*cond),
            then_body: mvec(then_body),
            else_body: mvec(else_body),
        },
        Inst::Loop {
            cond,
            cond_body,
            body,
        } => Inst::Loop {
            cond: m(*cond),
            cond_body: mvec(cond_body),
            body: mvec(body),
        },
        Inst::TryCatch {
            try_body,
            catch_var,
            catch_body,
            finally_body,
        } => Inst::TryCatch {
            try_body: mvec(try_body),
            catch_var: mopt(catch_var),
            catch_body: mvec(catch_body),
            finally_body: mvec(finally_body),
        },
        Inst::Break { up } => Inst::Break { up: *up },
        Inst::Continue { up } => Inst::Continue { up: *up },
    }
}

/// Propagate "this local holds a number" through Copy/arithmetic edges. Used to
/// unbox monomorphized number field scalars and array element scalars, plus the
/// short arithmetic chains that consume them.
fn propagate_numeric(
    body: &[Inst],
    primitive_locs: &BTreeSet<u32>,
    numeric: &mut BTreeSet<u32>,
    changed: &mut bool,
) {
    let is_num =
        |id: u32, numeric: &BTreeSet<u32>| numeric.contains(&id) || primitive_locs.contains(&id);
    for inst in body {
        match inst {
            Inst::Const { dst, value } if const_is_number_value(value) => {
                if numeric.insert(dst.0) {
                    *changed = true;
                }
            }
            Inst::Copy { dst, src } => {
                if numeric.contains(&src.0) && !numeric.contains(&dst.0) {
                    numeric.insert(dst.0);
                    *changed = true;
                }
            }
            Inst::UnOp { dst, op, operand }
                if matches!(op.as_str(), "+" | "-" | "~") && is_num(operand.0, numeric) =>
            {
                if numeric.insert(dst.0) {
                    *changed = true;
                }
            }
            Inst::BinOp { dst, op, lhs, rhs }
                if matches!(
                    op.as_str(),
                    "+" | "-" | "*" | "/" | "%" | "**" | "&" | "|" | "^" | "<<" | ">>" | ">>>"
                ) && is_num(lhs.0, numeric)
                    && is_num(rhs.0, numeric) =>
            {
                if numeric.insert(dst.0) {
                    *changed = true;
                }
            }
            Inst::Loop {
                cond_body, body, ..
            } => {
                propagate_numeric(cond_body, primitive_locs, numeric, changed);
                propagate_numeric(body, primitive_locs, numeric, changed);
            }
            Inst::If {
                then_body,
                else_body,
                ..
            } => {
                propagate_numeric(then_body, primitive_locs, numeric, changed);
                propagate_numeric(else_body, primitive_locs, numeric, changed);
            }
            Inst::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                propagate_numeric(try_body, primitive_locs, numeric, changed);
                propagate_numeric(catch_body, primitive_locs, numeric, changed);
                propagate_numeric(finally_body, primitive_locs, numeric, changed);
            }
            _ => {}
        }
    }
}
