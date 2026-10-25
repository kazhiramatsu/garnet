use std::collections::BTreeSet;

use crate::escape_ir::*;

pub(crate) type StaticString = Vec<u16>;

pub(crate) fn str_units(value: &str) -> StaticString {
    value.encode_utf16().collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum PathEdge {
    Function,
    LoopCond,
    LoopBody,
    IfThen,
    IfElse,
    TryBody,
    CatchBody,
    FinallyBody,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct PathSegment {
    pub edge: PathEdge,
    pub index: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct LoopPath(pub Vec<PathSegment>);

pub(crate) fn add_uses(a: LocalId, b: LocalId, x: u32, y: u32) -> bool {
    (a.0 == x && b.0 == y) || (a.0 == y && b.0 == x)
}

pub(crate) fn match_const_dst(inst: &Inst) -> Option<u32> {
    match inst {
        Inst::Const { dst, .. } => Some(dst.0),
        _ => None,
    }
}

pub(crate) fn match_const_str(inst: &Inst) -> Option<(u32, StaticString)> {
    match inst {
        Inst::Const {
            dst,
            value: ConstVal::Str { value },
        } => Some((dst.0, str_units(value))),
        Inst::Const {
            dst,
            value: ConstVal::Str16 { units },
        } => Some((dst.0, units.clone())),
        _ => None,
    }
}

pub(crate) fn match_const_i64(inst: &Inst) -> Option<i64> {
    match inst {
        Inst::Const {
            value: ConstVal::Num { value },
            ..
        } if value.is_finite()
            && value.fract() == 0.0
            && *value >= i64::MIN as f64
            && *value <= i64::MAX as f64 =>
        {
            Some(*value as i64)
        }
        _ => None,
    }
}

pub(crate) fn has_control_flow(seq: &[Inst]) -> bool {
    seq.iter().any(|inst| {
        matches!(
            inst,
            Inst::Return { .. }
                | Inst::Yield { .. }
                | Inst::Await { .. }
                | Inst::Throw { .. }
                | Inst::TryCatch { .. }
                | Inst::Break { .. }
                | Inst::Continue { .. }
                | Inst::Loop { .. }
                | Inst::If { .. }
        )
    })
}

pub(crate) fn collect_defs(seq: &[Inst]) -> BTreeSet<u32> {
    seq.iter().filter_map(inst_def_local).collect()
}

pub(crate) fn inst_def_local(inst: &Inst) -> Option<u32> {
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
        | Inst::NewSet { dst } => Some(dst.0),
        Inst::Call { dst: Some(dst), .. }
        | Inst::Yield { dst: Some(dst), .. }
        | Inst::Await { dst: Some(dst), .. }
        | Inst::DeleteField { dst: Some(dst), .. }
        | Inst::CallSpread { dst: Some(dst), .. }
        | Inst::CallBuiltin { dst: Some(dst), .. }
        | Inst::CallBuiltinStatic { dst: Some(dst), .. }
        | Inst::SetProto { dst: Some(dst), .. } => Some(dst.0),
        _ => None,
    }
}

fn arg_spec_uses_any(spec: &ArgSpec, ids: &BTreeSet<u32>) -> bool {
    match spec {
        ArgSpec::Single { local } | ArgSpec::Spread { local } => ids.contains(&local.0),
    }
}

fn callee_uses_any(callee: &CalleeRef, ids: &BTreeSet<u32>) -> bool {
    match callee {
        CalleeRef::Value { local } => ids.contains(&local.0),
        _ => false,
    }
}

fn inst_uses_any(inst: &Inst, ids: &BTreeSet<u32>) -> bool {
    match inst {
        Inst::AllocObject { proto, .. } => proto.map(|p| ids.contains(&p.0)).unwrap_or(false),
        Inst::AllocClosure { captures, .. } => captures.iter().any(|c| ids.contains(&c.cell.0)),
        Inst::Copy { src, .. }
        | Inst::StoreElem { src, .. }
        | Inst::Return { src: Some(src) }
        | Inst::Yield { operand: src, .. }
        | Inst::Await { operand: src, .. }
        | Inst::Throw { src }
        | Inst::StoreGlobal { src, .. }
        | Inst::UnOp { operand: src, .. }
        | Inst::ArrayPush { src, .. }
        | Inst::ArrayPushAll { src, .. }
        | Inst::ObjectRest { src, .. }
        | Inst::ObjectCopyProps { src, .. }
        | Inst::Print { src }
        | Inst::StoreProtoMethod { src, .. }
        | Inst::StoreMethod { src, .. } => ids.contains(&src.0),
        Inst::LoadField { obj, .. }
        | Inst::LoadMethodValue { recv: obj, .. }
        | Inst::NewDynamic { callee: obj, .. }
        | Inst::LoadElem { arr: obj, .. }
        | Inst::ArrayLen { arr: obj, .. }
        | Inst::StringLen { src: obj, .. }
        | Inst::GenericLen { src: obj, .. }
        | Inst::DeleteField { obj, .. }
        | Inst::GetProto { obj, .. } => ids.contains(&obj.0),
        Inst::StoreField { obj, src, .. }
        | Inst::SetProto {
            obj, proto: src, ..
        } => ids.contains(&obj.0) || ids.contains(&src.0),
        Inst::StoreFieldDynamic { obj, key, src } => {
            ids.contains(&obj.0) || ids.contains(&key.0) || ids.contains(&src.0)
        }
        Inst::StoreIndex { arr, index, src, .. } => {
            ids.contains(&arr.0) || ids.contains(&index.0) || ids.contains(&src.0)
        }
        Inst::AllocClassValue { captures, .. } => captures.iter().any(|c| ids.contains(&c.cell.0)),
        Inst::Call {
            callee, recv, args, ..
        } => {
            recv.map(|r| ids.contains(&r.0)).unwrap_or(false)
                || callee_uses_any(callee, ids)
                || args.iter().any(|a| ids.contains(&a.0))
        }
        Inst::CallSpread {
            callee,
            recv,
            arg_specs,
            ..
        } => {
            recv.map(|r| ids.contains(&r.0)).unwrap_or(false)
                || callee_uses_any(callee, ids)
                || arg_specs.iter().any(|a| arg_spec_uses_any(a, ids))
        }
        Inst::TryCatch {
            try_body,
            catch_body,
            finally_body,
            ..
        } => {
            try_body.iter().any(|i| inst_uses_any(i, ids))
                || catch_body.iter().any(|i| inst_uses_any(i, ids))
                || finally_body.iter().any(|i| inst_uses_any(i, ids))
        }
        Inst::BinOp { lhs, rhs, .. }
        | Inst::LoadIndex {
            arr: lhs,
            index: rhs,
            ..
        }
        | Inst::HasFieldDynamic {
            obj: lhs, key: rhs, ..
        }
        | Inst::LoadFieldDynamic {
            obj: lhs, key: rhs, ..
        } => ids.contains(&lhs.0) || ids.contains(&rhs.0),
        Inst::CallBuiltin { recv, args, .. } => {
            ids.contains(&recv.0) || args.iter().any(|a| ids.contains(&a.0))
        }
        Inst::CallBuiltinStatic { args, .. } => args.iter().any(|a| ids.contains(&a.0)),
        Inst::If {
            cond,
            then_body,
            else_body,
        } => {
            ids.contains(&cond.0)
                || then_body.iter().any(|i| inst_uses_any(i, ids))
                || else_body.iter().any(|i| inst_uses_any(i, ids))
        }
        Inst::Loop {
            cond,
            cond_body,
            body,
        } => {
            ids.contains(&cond.0)
                || cond_body.iter().any(|i| inst_uses_any(i, ids))
                || body.iter().any(|i| inst_uses_any(i, ids))
        }
        Inst::HasField { obj, .. } => ids.contains(&obj.0),
        Inst::ConstructResult { inst, ret, .. } => ids.contains(&inst.0) || ids.contains(&ret.0),
        _ => false,
    }
}

pub(crate) fn locals_used_after(body: &[Inst], from: usize, ids: &BTreeSet<u32>) -> bool {
    body.iter().skip(from).any(|inst| inst_uses_any(inst, ids))
}

thread_local! {
    static LENGTH_FIELDS: std::cell::RefCell<std::collections::BTreeSet<u32>> =
        std::cell::RefCell::new(std::collections::BTreeSet::new());
}
/// Record the field ids named `length` (the exporter reads `.length` as a
/// property when the receiver's type is not known).
pub fn set_length_fields(program: &Program) {
    let length = str_units("length");
    LENGTH_FIELDS.with(|m| {
        let mut m = m.borrow_mut();
        m.clear();
        for f in &program.fields {
            let units = match &f.name { Some(name) => str_units(name), None => f.name_units.clone() };
            if units == length {
                m.insert(f.id.0);
            }
        }
    });
}
pub fn is_length_field(field: u32) -> bool {
    LENGTH_FIELDS.with(|m| m.borrow().contains(&field))
}
/// A read of a string's length in a string loop shape: `GenericLen`, or the
/// `length` property read of an untyped program; the shapes apply it to a
/// string builtin's result.
pub fn match_len_read(inst: &Inst) -> Option<(LocalId, LocalId)> {
    match inst {
        Inst::GenericLen { dst, src } => Some((*dst, *src)),
        Inst::LoadField { dst, obj, field, .. } if is_length_field(field.0) => Some((*dst, *obj)),
        _ => None,
    }
}
