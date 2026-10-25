use std::collections::BTreeMap;

use crate::escape_ir::*;
use crate::string_plan::{
    match_len_read, set_length_fields,
    add_uses, collect_defs, has_control_flow, inst_def_local, locals_used_after, match_const_dst,
    match_const_i64, match_const_str, LoopPath, PathEdge, PathSegment, StaticString,
};

#[derive(Clone, Debug, Default)]
pub struct StringMaterializationPlan {
    pub functions: BTreeMap<u32, FunctionMaterializationPlan>,
}

#[derive(Clone, Debug, Default)]
pub struct FunctionMaterializationPlan {
    pub loops: BTreeMap<LoopPath, LoopMaterializationPlan>,
}

#[derive(Clone, Debug, Default)]
pub struct LoopMaterializationPlan {
    pub full_body: Option<MaterializationOp>,
}

#[derive(Clone, Debug)]
pub enum MaterializationOp {
    StaticSplitJoinEscape(StaticSplitJoinEscapeMaterialization),
    StaticReplaceEscape(StaticReplaceEscapeMaterialization),
    StaticCaseTrimEscape(StaticCaseTrimEscapeMaterialization),
    DynamicReplaceEscape(DynamicReplaceEscapeMaterialization),
    DynamicSplitJoinEscape(DynamicSplitJoinEscapeMaterialization),
}

#[derive(Clone, Debug)]
pub struct StaticSplitJoinEscapeMaterialization {
    pub recv: u32,
    pub separator: StaticString,
    pub joiner: StaticString,
    pub last: u32,
    pub acc: u32,
    pub counter: CounterAddTailPlan,
}

#[derive(Clone, Debug)]
pub struct StaticReplaceEscapeMaterialization {
    pub recv: u32,
    pub pattern: StaticString,
    pub replacement: StaticString,
    pub index_needle: StaticString,
    pub char_idx: i64,
    pub last: u32,
    pub acc: u32,
    pub counter: CounterAddTailPlan,
}

#[derive(Clone, Debug)]
pub struct StaticCaseTrimEscapeMaterialization {
    pub recv: u32,
    pub last: u32,
    pub acc: u32,
    pub counter: CounterAddTailPlan,
}

#[derive(Clone, Debug)]
pub struct DynamicReplaceEscapeMaterialization {
    pub select: SourceSelect4Plan,
    pub skip: usize,
    pub pattern: u32,
    pub replacement: u32,
    pub last: u32,
    pub acc: u32,
    pub mult: i64,
    pub mask: i64,
}

#[derive(Clone, Debug)]
pub struct DynamicSplitJoinEscapeMaterialization {
    pub select: SourceSelect4Plan,
    pub skip: usize,
    pub separator: u32,
    pub joiner: u32,
    pub last: u32,
    pub acc: u32,
    pub part_index: i64,
    pub mult: i64,
    pub mask: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SourceSelect4Plan {
    pub len: usize,
    pub dst: u32,
    pub pick: u32,
    pub values: [u32; 4],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CounterAddTailPlan {
    pub counter: u32,
    pub inc: i64,
}

pub fn analyze_program(program: &Program) -> StringMaterializationPlan {
    set_length_fields(program);
    let mut functions = BTreeMap::new();
    for f in &program.functions {
        let fp = analyze_function(f);
        if !fp.loops.is_empty() {
            functions.insert(f.id.0, fp);
        }
    }
    StringMaterializationPlan { functions }
}

fn analyze_function(f: &Function) -> FunctionMaterializationPlan {
    let mut fp = FunctionMaterializationPlan::default();
    let mut path = Vec::new();
    analyze_seq(&f.body, PathEdge::Function, &mut path, &mut fp);
    fp
}

fn analyze_seq(
    seq: &[Inst],
    edge: PathEdge,
    path: &mut Vec<PathSegment>,
    fp: &mut FunctionMaterializationPlan,
) {
    for (index, inst) in seq.iter().enumerate() {
        path.push(PathSegment { edge, index });
        match inst {
            Inst::Loop {
                cond_body, body, ..
            } => {
                let loop_path = LoopPath(path.clone());
                let loop_plan = analyze_loop_body(body);
                if loop_plan.full_body.is_some() {
                    fp.loops.insert(loop_path, loop_plan);
                }
                analyze_seq(cond_body, PathEdge::LoopCond, path, fp);
                analyze_seq(body, PathEdge::LoopBody, path, fp);
            }
            Inst::If {
                then_body,
                else_body,
                ..
            } => {
                analyze_seq(then_body, PathEdge::IfThen, path, fp);
                analyze_seq(else_body, PathEdge::IfElse, path, fp);
            }
            Inst::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } => {
                analyze_seq(try_body, PathEdge::TryBody, path, fp);
                analyze_seq(catch_body, PathEdge::CatchBody, path, fp);
                analyze_seq(finally_body, PathEdge::FinallyBody, path, fp);
            }
            _ => {}
        }
        path.pop();
    }
}

fn analyze_loop_body(body: &[Inst]) -> LoopMaterializationPlan {
    let full_body = match_static_split_join_escape(body)
        .or_else(|| match_static_replace_escape(body))
        .or_else(|| match_static_case_trim_escape(body))
        .or_else(|| match_dynamic_replace_escape(body))
        .or_else(|| match_dynamic_split_join_escape(body));
    LoopMaterializationPlan { full_body }
}

fn match_static_split_join_escape(body: &[Inst]) -> Option<MaterializationOp> {
    if body.len() != 21 || has_control_flow(body) {
        return None;
    }
    let (
        split_sep_const,
        Inst::CallBuiltin {
            dst: Some(split_res),
            builtin: split_builtin,
            recv: split_recv,
            args: split_args,
        },
        Inst::Copy {
            dst: parts,
            src: split_src,
        },
        join_sep_const,
        Inst::CallBuiltin {
            dst: Some(join_res),
            builtin: join_builtin,
            recv: join_recv,
            args: join_args,
        },
        Inst::Copy {
            dst: joined,
            src: join_src,
        },
        Inst::Copy {
            dst: last,
            src: last_src,
        },
        Inst::StringLen {
            dst: joined_len1,
            src: joined_len1_src,
        },
        Inst::BinOp {
            dst: sum_len_tmp,
            op: sum_len_op,
            lhs: sum_len_lhs,
            rhs: sum_len_rhs,
        },
        zero_const,
        Inst::CallBuiltin {
            dst: Some(first_ch),
            builtin: first_builtin,
            recv: first_recv,
            args: first_args,
        },
        Inst::BinOp {
            dst: sum_first_tmp,
            op: sum_first_op,
            lhs: sum_first_lhs,
            rhs: sum_first_rhs,
        },
        Inst::StringLen {
            dst: joined_len2,
            src: joined_len2_src,
        },
        one_const,
        Inst::BinOp {
            dst: last_idx,
            op: last_idx_op,
            lhs: last_idx_lhs,
            rhs: last_idx_rhs,
        },
        Inst::CallBuiltin {
            dst: Some(last_ch),
            builtin: last_builtin,
            recv: last_recv,
            args: last_args,
        },
        Inst::BinOp {
            dst: sum_last_tmp,
            op: sum_last_op,
            lhs: sum_last_lhs,
            rhs: sum_last_rhs,
        },
        Inst::Copy {
            dst: sum_copy,
            src: sum_last_src,
        },
    ) = (
        &body[0], &body[1], &body[2], &body[3], &body[4], &body[5], &body[6], &body[7], &body[8],
        &body[9], &body[10], &body[11], &body[12], &body[13], &body[14], &body[15], &body[16],
        &body[17],
    )
    else {
        return None;
    };

    let (split_sep_dst, split_sep) = match_const_str(split_sep_const)?;
    let (join_sep_dst, join_sep) = match_const_str(join_sep_const)?;
    if split_builtin != "string.split"
        || join_builtin != "array.join"
        || split_args.len() != 1
        || split_args[0].0 != split_sep_dst
        || split_res.0 != split_src.0
        || join_recv.0 != parts.0
        || join_args.len() != 1
        || join_args[0].0 != join_sep_dst
        || join_res.0 != join_src.0
        || last_src.0 != joined.0
        || joined_len1_src.0 != joined.0
        || sum_len_op != "+"
        || joined_len1.0 != sum_len_rhs.0
        || match_const_i64(zero_const)? != 0
        || first_builtin != "string.charCodeAt"
        || first_recv.0 != joined.0
        || first_args.len() != 1
        || first_args[0].0 != match_const_dst(zero_const)?
        || sum_first_op != "+"
        || sum_len_tmp.0 != sum_first_lhs.0
        || first_ch.0 != sum_first_rhs.0
        || joined_len2_src.0 != joined.0
        || match_const_i64(one_const)? != 1
        || last_idx_op != "-"
        || joined_len2.0 != last_idx_lhs.0
        || last_idx_rhs.0 != match_const_dst(one_const)?
        || last_builtin != "string.charCodeAt"
        || last_recv.0 != joined.0
        || last_args.len() != 1
        || last_args[0].0 != last_idx.0
        || sum_last_op != "+"
        || sum_first_tmp.0 != sum_last_lhs.0
        || last_ch.0 != sum_last_rhs.0
        || sum_last_tmp.0 != sum_last_src.0
        || sum_copy.0 != sum_len_lhs.0
    {
        return None;
    }
    if body
        .iter()
        .any(|inst| inst_def_local(inst) == Some(split_recv.0))
    {
        return None;
    }
    Some(MaterializationOp::StaticSplitJoinEscape(
        StaticSplitJoinEscapeMaterialization {
            recv: split_recv.0,
            separator: split_sep,
            joiner: join_sep,
            last: last.0,
            acc: sum_copy.0,
            counter: match_counter_add_tail(body, 18)?,
        },
    ))
}

fn match_static_replace_escape(body: &[Inst]) -> Option<MaterializationOp> {
    if body.len() != 17 || has_control_flow(body) {
        return None;
    }
    let (
        pat_const,
        rep_const,
        Inst::CallBuiltin {
            dst: Some(replaced_res),
            builtin: replace_builtin,
            recv: replace_recv,
            args: replace_args,
        },
        Inst::Copy {
            dst: replaced,
            src: replaced_src,
        },
        Inst::Copy {
            dst: last,
            src: last_src,
        },
        len_inst,
        Inst::BinOp {
            dst: sum_len_tmp,
            op: sum_len_op,
            lhs: sum_len_lhs,
            rhs: sum_len_rhs,
        },
        index_needle_const,
        Inst::Call {
            dst: Some(index_res),
            recv: Some(index_recv),
            args: index_args,
            ..
        },
        Inst::BinOp {
            dst: sum_index_tmp,
            op: sum_index_op,
            lhs: sum_index_lhs,
            rhs: sum_index_rhs,
        },
        char_idx_const,
        Inst::Call {
            dst: Some(char_res),
            recv: Some(char_recv),
            args: char_args,
            ..
        },
        Inst::BinOp {
            dst: sum_char_tmp,
            op: sum_char_op,
            lhs: sum_char_lhs,
            rhs: sum_char_rhs,
        },
        Inst::Copy {
            dst: sum_copy,
            src: sum_char_src,
        },
    ) = (
        &body[0], &body[1], &body[2], &body[3], &body[4], &body[5], &body[6], &body[7], &body[8],
        &body[9], &body[10], &body[11], &body[12], &body[13],
    )
    else {
        return None;
    };
    let (replaced_len, replaced_len_src) = match_len_read(len_inst)?;

    let (pat_dst, pat) = match_const_str(pat_const)?;
    let (rep_dst, rep) = match_const_str(rep_const)?;
    let (index_needle_dst, index_needle) = match_const_str(index_needle_const)?;
    if replace_builtin != "string.replaceAll"
        || replace_args.len() != 2
        || replace_args[0].0 != pat_dst
        || replace_args[1].0 != rep_dst
        || replaced_res.0 != replaced_src.0
        || last_src.0 != replaced.0
        || replaced_len_src.0 != replaced.0
        || sum_len_op != "+"
        || replaced_len.0 != sum_len_rhs.0
        || index_recv.0 != replaced.0
        || index_args.len() != 1
        || index_args[0].0 != index_needle_dst
        || sum_index_op != "+"
        || sum_len_tmp.0 != sum_index_lhs.0
        || index_res.0 != sum_index_rhs.0
        || char_recv.0 != replaced.0
        || char_args.len() != 1
        || char_args[0].0 != match_const_dst(char_idx_const)?
        || sum_char_op != "+"
        || sum_index_tmp.0 != sum_char_lhs.0
        || char_res.0 != sum_char_rhs.0
        || sum_char_tmp.0 != sum_char_src.0
        || sum_copy.0 != sum_len_lhs.0
    {
        return None;
    }
    let char_idx = match_const_i64(char_idx_const)?;
    if char_idx < 0 {
        return None;
    }
    if body
        .iter()
        .any(|inst| inst_def_local(inst) == Some(replace_recv.0))
    {
        return None;
    }
    Some(MaterializationOp::StaticReplaceEscape(
        StaticReplaceEscapeMaterialization {
            recv: replace_recv.0,
            pattern: pat,
            replacement: rep,
            index_needle,
            char_idx,
            last: last.0,
            acc: sum_copy.0,
            counter: match_counter_add_tail(body, 14)?,
        },
    ))
}

fn match_static_case_trim_escape(body: &[Inst]) -> Option<MaterializationOp> {
    if body.len() != 21 || has_control_flow(body) {
        return None;
    }
    let (
        Inst::CallBuiltin {
            dst: Some(trim_res),
            builtin: trim_builtin,
            recv: trim_recv,
            args: trim_args,
        },
        Inst::Copy {
            dst: trimmed,
            src: trim_src,
        },
        Inst::CallBuiltin {
            dst: Some(upper_res),
            builtin: upper_builtin,
            recv: upper_recv,
            args: upper_args,
        },
        Inst::Copy {
            dst: uppered,
            src: upper_src,
        },
        Inst::CallBuiltin {
            dst: Some(lower_res),
            builtin: lower_builtin,
            recv: lower_recv,
            args: lower_args,
        },
        Inst::Copy {
            dst: lowered,
            src: lower_src,
        },
        Inst::Copy {
            dst: last,
            src: last_src,
        },
        Inst::StringLen {
            dst: lower_len1,
            src: lower_len1_src,
        },
        Inst::BinOp {
            dst: sum_len_tmp,
            op: sum_len_op,
            lhs: sum_len_lhs,
            rhs: sum_len_rhs,
        },
        zero_const,
        Inst::CallBuiltin {
            dst: Some(first_ch),
            builtin: first_builtin,
            recv: first_recv,
            args: first_args,
        },
        Inst::BinOp {
            dst: sum_first_tmp,
            op: sum_first_op,
            lhs: sum_first_lhs,
            rhs: sum_first_rhs,
        },
        Inst::StringLen {
            dst: lower_len2,
            src: lower_len2_src,
        },
        one_const,
        Inst::BinOp {
            dst: last_idx,
            op: last_idx_op,
            lhs: last_idx_lhs,
            rhs: last_idx_rhs,
        },
        Inst::CallBuiltin {
            dst: Some(last_ch),
            builtin: last_builtin,
            recv: last_recv,
            args: last_args,
        },
        Inst::BinOp {
            dst: sum_last_tmp,
            op: sum_last_op,
            lhs: sum_last_lhs,
            rhs: sum_last_rhs,
        },
        Inst::Copy {
            dst: sum_copy,
            src: sum_last_src,
        },
    ) = (
        &body[0], &body[1], &body[2], &body[3], &body[4], &body[5], &body[6], &body[7], &body[8],
        &body[9], &body[10], &body[11], &body[12], &body[13], &body[14], &body[15], &body[16],
        &body[17],
    )
    else {
        return None;
    };

    if trim_builtin != "string.trim"
        || upper_builtin != "string.toUpperCase"
        || lower_builtin != "string.toLowerCase"
        || !trim_args.is_empty()
        || !upper_args.is_empty()
        || !lower_args.is_empty()
        || trim_res.0 != trim_src.0
        || upper_recv.0 != trimmed.0
        || upper_res.0 != upper_src.0
        || lower_recv.0 != uppered.0
        || lower_res.0 != lower_src.0
        || last_src.0 != lowered.0
        || lower_len1_src.0 != lowered.0
        || sum_len_op != "+"
        || lower_len1.0 != sum_len_rhs.0
        || match_const_i64(zero_const)? != 0
        || first_builtin != "string.charCodeAt"
        || first_recv.0 != lowered.0
        || first_args.len() != 1
        || first_args[0].0 != match_const_dst(zero_const)?
        || sum_first_op != "+"
        || sum_len_tmp.0 != sum_first_lhs.0
        || first_ch.0 != sum_first_rhs.0
        || lower_len2_src.0 != lowered.0
        || match_const_i64(one_const)? != 1
        || last_idx_op != "-"
        || lower_len2.0 != last_idx_lhs.0
        || last_idx_rhs.0 != match_const_dst(one_const)?
        || last_builtin != "string.charCodeAt"
        || last_recv.0 != lowered.0
        || last_args.len() != 1
        || last_args[0].0 != last_idx.0
        || sum_last_op != "+"
        || sum_first_tmp.0 != sum_last_lhs.0
        || last_ch.0 != sum_last_rhs.0
        || sum_last_tmp.0 != sum_last_src.0
        || sum_copy.0 != sum_len_lhs.0
    {
        return None;
    }
    if body
        .iter()
        .any(|inst| inst_def_local(inst) == Some(trim_recv.0))
    {
        return None;
    }
    Some(MaterializationOp::StaticCaseTrimEscape(
        StaticCaseTrimEscapeMaterialization {
            recv: trim_recv.0,
            last: last.0,
            acc: sum_copy.0,
            counter: match_counter_add_tail(body, 18)?,
        },
    ))
}

fn match_dynamic_replace_escape(body: &[Inst]) -> Option<MaterializationOp> {
    let select = parse_source_select4(body, 0)?;
    if body.len().saturating_sub(select.len) < 25 {
        return None;
    }
    let seq = &body[select.len..select.len + 16];
    let (
        Inst::CallBuiltin {
            dst: Some(replaced_res),
            builtin: replace_builtin,
            recv: replace_recv,
            args: replace_args,
        },
        Inst::Copy {
            dst: replaced,
            src: replaced_src,
        },
        Inst::Copy {
            dst: last,
            src: last_src,
        },
        len_inst,
        Inst::BinOp {
            dst: sum_len_tmp,
            op: sum_len_op,
            lhs: sum_len_lhs,
            rhs: sum_len_rhs,
        },
        Inst::Call {
            dst: Some(index_res),
            recv: Some(index_recv),
            args: index_args,
            ..
        },
        Inst::BinOp {
            dst: sum_index_tmp,
            op: sum_index_op,
            lhs: sum_index_lhs,
            rhs: sum_index_rhs,
        },
        Inst::Call {
            dst: Some(last_res),
            recv: Some(last_recv),
            args: last_args,
            ..
        },
        Inst::BinOp {
            dst: sum_last_tmp,
            op: sum_last_op,
            lhs: sum_last_lhs,
            rhs: sum_last_rhs,
        },
        mult_const,
        Inst::BinOp {
            dst: mul_tmp,
            op: mul_op,
            lhs: mul_lhs,
            rhs: mul_rhs,
        },
        mask_const,
        Inst::BinOp {
            dst: char_idx,
            op: mask_op,
            lhs: mask_lhs,
            rhs: mask_rhs,
        },
        Inst::Call {
            dst: Some(char_res),
            recv: Some(char_recv),
            args: char_args,
            ..
        },
        Inst::BinOp {
            dst: sum_char_tmp,
            op: sum_char_op,
            lhs: sum_char_lhs,
            rhs: sum_char_rhs,
        },
        Inst::Copy {
            dst: sum_copy,
            src: sum_char_src,
        },
    ) = (
        &seq[0], &seq[1], &seq[2], &seq[3], &seq[4], &seq[5], &seq[6], &seq[7], &seq[8], &seq[9],
        &seq[10], &seq[11], &seq[12], &seq[13], &seq[14], &seq[15],
    )
    else {
        return None;
    };
    let (replaced_len, replaced_len_src) = match_len_read(len_inst)?;

    if replace_builtin != "string.replaceAll"
        || replace_recv.0 != select.dst
        || replace_args.len() != 2
        || replaced_res.0 != replaced_src.0
        || last_src.0 != replaced.0
        || replaced_len_src.0 != replaced.0
        || sum_len_op != "+"
        || replaced_len.0 != sum_len_rhs.0
        || sum_copy.0 != sum_len_lhs.0
        || index_recv.0 != replaced.0
        || index_args.len() != 1
        || index_args[0].0 != replace_args[1].0
        || sum_index_op != "+"
        || sum_len_tmp.0 != sum_index_lhs.0
        || index_res.0 != sum_index_rhs.0
        || last_recv.0 != replaced.0
        || last_args.len() != 1
        || last_args[0].0 != replace_args[1].0
        || sum_last_op != "+"
        || sum_index_tmp.0 != sum_last_lhs.0
        || last_res.0 != sum_last_rhs.0
        || mul_op != "*"
        || mask_op != "&"
        || !add_uses(
            *mul_lhs,
            *mul_rhs,
            select.pick,
            match_const_dst(mult_const)?,
        )
        || mask_lhs.0 != mul_tmp.0
        || mask_rhs.0 != match_const_dst(mask_const)?
        || char_recv.0 != replaced.0
        || char_args.len() != 1
        || char_args[0].0 != char_idx.0
        || sum_char_op != "+"
        || sum_last_tmp.0 != sum_char_lhs.0
        || char_res.0 != sum_char_rhs.0
        || sum_char_tmp.0 != sum_char_src.0
    {
        return None;
    }
    let mult = match_const_i64(mult_const)?;
    let mask = match_const_i64(mask_const)?;
    if mult < 0 || mask < 0 {
        return None;
    }
    for value in select.values {
        if body.iter().any(|inst| inst_def_local(inst) == Some(value)) {
            return None;
        }
    }
    if body.iter().any(|inst| {
        let d = inst_def_local(inst);
        d == Some(replace_args[0].0) || d == Some(replace_args[1].0)
    }) {
        return None;
    }

    let skip = select.len + 16;
    let mut skipped_defs = collect_defs(&body[..skip]);
    skipped_defs.remove(&last.0);
    skipped_defs.remove(&sum_copy.0);
    if locals_used_after(body, skip, &skipped_defs) {
        return None;
    }

    Some(MaterializationOp::DynamicReplaceEscape(
        DynamicReplaceEscapeMaterialization {
            select,
            skip,
            pattern: replace_args[0].0,
            replacement: replace_args[1].0,
            last: last.0,
            acc: sum_copy.0,
            mult,
            mask,
        },
    ))
}

fn match_dynamic_split_join_escape(body: &[Inst]) -> Option<MaterializationOp> {
    let select = parse_source_select4(body, 0)?;
    if body.len().saturating_sub(select.len) < 20 {
        return None;
    }
    let seq = &body[select.len..select.len + 20];
    let (
        Inst::CallBuiltin {
            dst: Some(split_res),
            builtin: split_builtin,
            recv: split_recv,
            args: split_args,
        },
        Inst::Copy {
            dst: parts,
            src: split_src,
        },
        Inst::CallBuiltin {
            dst: Some(join_res),
            builtin: join_builtin,
            recv: join_recv,
            args: join_args,
        },
        Inst::Copy {
            dst: joined,
            src: join_src,
        },
        Inst::Copy {
            dst: last,
            src: last_src,
        },
        Inst::ArrayLen {
            dst: parts_len,
            arr: parts_len_src,
        },
        Inst::BinOp {
            dst: sum_parts_tmp,
            op: sum_parts_op,
            lhs: sum_parts_lhs,
            rhs: sum_parts_rhs,
        },
        Inst::StringLen {
            dst: joined_len,
            src: joined_len_src,
        },
        Inst::BinOp {
            dst: sum_joined_tmp,
            op: sum_joined_op,
            lhs: sum_joined_lhs,
            rhs: sum_joined_rhs,
        },
        part_index_const,
        Inst::LoadIndex {
            dst: part_value,
            arr: part_arr,
            index: part_index,
            ..
        },
        Inst::StringLen {
            dst: part_len,
            src: part_len_src,
        },
        Inst::BinOp {
            dst: sum_part_tmp,
            op: sum_part_op,
            lhs: sum_part_lhs,
            rhs: sum_part_rhs,
        },
        mult_const,
        Inst::BinOp {
            dst: mul_tmp,
            op: mul_op,
            lhs: mul_lhs,
            rhs: mul_rhs,
        },
        mask_const,
        Inst::BinOp {
            dst: char_idx,
            op: mask_op,
            lhs: mask_lhs,
            rhs: mask_rhs,
        },
        Inst::CallBuiltin {
            dst: Some(char_res),
            builtin: char_builtin,
            recv: char_recv,
            args: char_args,
        },
        Inst::BinOp {
            dst: sum_char_tmp,
            op: sum_char_op,
            lhs: sum_char_lhs,
            rhs: sum_char_rhs,
        },
        Inst::Copy {
            dst: sum_copy,
            src: sum_char_src,
        },
    ) = (
        &seq[0], &seq[1], &seq[2], &seq[3], &seq[4], &seq[5], &seq[6], &seq[7], &seq[8], &seq[9],
        &seq[10], &seq[11], &seq[12], &seq[13], &seq[14], &seq[15], &seq[16], &seq[17], &seq[18],
        &seq[19],
    )
    else {
        return None;
    };

    if split_builtin != "string.split"
        || split_recv.0 != select.dst
        || split_args.len() != 1
        || split_res.0 != split_src.0
        || join_builtin != "array.join"
        || join_recv.0 != parts.0
        || join_args.len() != 1
        || join_res.0 != join_src.0
        || last_src.0 != joined.0
        || parts_len_src.0 != parts.0
        || sum_parts_op != "+"
        || sum_copy.0 != sum_parts_lhs.0
        || parts_len.0 != sum_parts_rhs.0
        || joined_len_src.0 != joined.0
        || sum_joined_op != "+"
        || sum_parts_tmp.0 != sum_joined_lhs.0
        || joined_len.0 != sum_joined_rhs.0
        || part_arr.0 != parts.0
        || part_index.0 != match_const_dst(part_index_const)?
        || part_len_src.0 != part_value.0
        || sum_part_op != "+"
        || sum_joined_tmp.0 != sum_part_lhs.0
        || part_len.0 != sum_part_rhs.0
        || mul_op != "*"
        || mask_op != "&"
        || !add_uses(
            *mul_lhs,
            *mul_rhs,
            select.pick,
            match_const_dst(mult_const)?,
        )
        || mask_lhs.0 != mul_tmp.0
        || mask_rhs.0 != match_const_dst(mask_const)?
        || char_builtin != "string.charCodeAt"
        || char_recv.0 != joined.0
        || char_args.len() != 1
        || char_args[0].0 != char_idx.0
        || sum_char_op != "+"
        || sum_part_tmp.0 != sum_char_lhs.0
        || char_res.0 != sum_char_rhs.0
        || sum_char_tmp.0 != sum_char_src.0
    {
        return None;
    }
    let part_index = match_const_i64(part_index_const)?;
    let mult = match_const_i64(mult_const)?;
    let mask = match_const_i64(mask_const)?;
    if part_index < 0 || mult < 0 || mask < 0 {
        return None;
    }
    for value in select.values {
        if body.iter().any(|inst| inst_def_local(inst) == Some(value)) {
            return None;
        }
    }
    if body.iter().any(|inst| {
        let d = inst_def_local(inst);
        d == Some(split_args[0].0) || d == Some(join_args[0].0)
    }) {
        return None;
    }

    let skip = select.len + 20;
    let mut skipped_defs = collect_defs(&body[..skip]);
    skipped_defs.remove(&last.0);
    skipped_defs.remove(&sum_copy.0);
    if locals_used_after(body, skip, &skipped_defs) {
        return None;
    }

    Some(MaterializationOp::DynamicSplitJoinEscape(
        DynamicSplitJoinEscapeMaterialization {
            select,
            skip,
            separator: split_args[0].0,
            joiner: join_args[0].0,
            last: last.0,
            acc: sum_copy.0,
            part_index,
            mult,
            mask,
        },
    ))
}

struct Select4<const N: usize> {
    len: usize,
    pick: u32,
    dsts: [u32; N],
    values: [[u32; 4]; N],
}

fn parse_select_copies<const N: usize>(
    seq: &[Inst],
    expected_dsts: Option<&[u32; N]>,
) -> Option<([u32; N], [u32; N])> {
    if seq.len() != N {
        return None;
    }
    let mut dsts = [0u32; N];
    let mut values = [0u32; N];
    for (i, inst) in seq.iter().enumerate() {
        let Inst::Copy { dst, src } = inst else {
            return None;
        };
        if let Some(expected) = expected_dsts {
            if dst.0 != expected[i] {
                return None;
            }
        }
        dsts[i] = dst.0;
        values[i] = src.0;
    }
    Some((dsts, values))
}

fn parse_select_branch<'a>(
    const_inst: &Inst,
    cmp_inst: &Inst,
    if_inst: &'a Inst,
    expected_case: i64,
    expected_pick: Option<u32>,
) -> Option<(u32, &'a [Inst], &'a [Inst])> {
    let Inst::BinOp {
        dst: cmp,
        op,
        lhs,
        rhs,
    } = cmp_inst
    else {
        return None;
    };
    let Inst::If {
        cond,
        then_body,
        else_body,
    } = if_inst
    else {
        return None;
    };
    if op != "===" || cmp.0 != cond.0 || match_const_i64(const_inst)? != expected_case {
        return None;
    }
    let case_const = match_const_dst(const_inst)?;
    let pick = if lhs.0 == case_const {
        rhs.0
    } else if rhs.0 == case_const {
        lhs.0
    } else {
        return None;
    };
    if let Some(expected) = expected_pick {
        if pick != expected {
            return None;
        }
    }
    Some((pick, then_body.as_slice(), else_body.as_slice()))
}

fn parse_select4<const N: usize>(body: &[Inst], start: usize) -> Option<Select4<N>> {
    if body.len().saturating_sub(start) < N + 3 {
        return None;
    }
    let (dsts, values0) = parse_select_copies::<N>(&body[start..start + N], None)?;
    let (pick, then1, else1) = parse_select_branch(
        &body[start + N],
        &body[start + N + 1],
        &body[start + N + 2],
        1,
        None,
    )?;
    let (_, values1) = parse_select_copies::<N>(then1, Some(&dsts))?;
    if else1.len() != 3 {
        return None;
    }
    let (_, then2, else2) = parse_select_branch(&else1[0], &else1[1], &else1[2], 2, Some(pick))?;
    let (_, values2) = parse_select_copies::<N>(then2, Some(&dsts))?;
    if else2.len() != 3 {
        return None;
    }
    let (_, then3, else3) = parse_select_branch(&else2[0], &else2[1], &else2[2], 3, Some(pick))?;
    let (_, values3) = parse_select_copies::<N>(then3, Some(&dsts))?;
    if !else3.is_empty() {
        return None;
    }

    let mut values = [[0u32; 4]; N];
    for i in 0..N {
        values[i] = [values0[i], values1[i], values2[i], values3[i]];
    }
    Some(Select4 {
        len: N + 3,
        pick,
        dsts,
        values,
    })
}

fn parse_source_select4(body: &[Inst], start: usize) -> Option<SourceSelect4Plan> {
    let select = parse_select4::<1>(body, start)?;
    Some(SourceSelect4Plan {
        len: select.len,
        dst: select.dsts[0],
        pick: select.pick,
        values: select.values[0],
    })
}

fn match_counter_add_tail(body: &[Inst], start: usize) -> Option<CounterAddTailPlan> {
    if body.len().saturating_sub(start) < 3 {
        return None;
    }
    let (
        counter_inc_const,
        Inst::BinOp {
            dst: counter_tmp,
            op: counter_op,
            lhs: counter_lhs,
            rhs: counter_rhs,
        },
        Inst::Copy {
            dst: counter_copy,
            src: counter_src,
        },
    ) = (&body[start], &body[start + 1], &body[start + 2])
    else {
        return None;
    };
    let counter_inc = match_const_i64(counter_inc_const)?;
    if counter_inc < 0 {
        return None;
    }
    let counter = counter_copy.0;
    let counter_inc_local = match_const_dst(counter_inc_const)?;
    let counter_ok = if counter_lhs.0 == counter {
        counter_rhs.0 == counter_inc_local
    } else if counter_rhs.0 == counter {
        counter_lhs.0 == counter_inc_local
    } else {
        false
    };
    if counter_op != "+" || counter_tmp.0 != counter_src.0 || !counter_ok {
        return None;
    }
    Some(CounterAddTailPlan {
        counter,
        inc: counter_inc,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::string_plan::str_units;

    fn l(id: u32) -> LocalId {
        LocalId(id)
    }

    fn cstr(id: u32, value: &str) -> Inst {
        Inst::Const {
            dst: l(id),
            value: ConstVal::Str {
                value: value.to_string(),
            },
        }
    }

    fn cstr16(id: u32, units: &[u16]) -> Inst {
        Inst::Const {
            dst: l(id),
            value: ConstVal::Str16 {
                units: units.to_vec(),
            },
        }
    }

    fn cnum(id: u32, value: f64) -> Inst {
        Inst::Const {
            dst: l(id),
            value: ConstVal::Num { value },
        }
    }

    fn unknown_method_call(dst: u32, recv: u32, args: Vec<LocalId>) -> Inst {
        Inst::Call {
            dst: Some(l(dst)),
            callee: CalleeRef::Unknown,
            recv: Some(l(recv)),
            args,
            resolved_sig: None,
        }
    }

    fn tail() -> Vec<Inst> {
        vec![
            cnum(24, 1.0),
            Inst::BinOp {
                dst: l(42),
                op: "+".to_string(),
                lhs: l(50),
                rhs: l(24),
            },
            Inst::Copy {
                dst: l(50),
                src: l(42),
            },
        ]
    }

    fn select4_prefix() -> Vec<Inst> {
        vec![
            Inst::Copy {
                dst: l(11),
                src: l(101),
            },
            cnum(201, 1.0),
            Inst::BinOp {
                dst: l(202),
                op: "===".to_string(),
                lhs: l(7),
                rhs: l(201),
            },
            Inst::If {
                cond: l(202),
                then_body: vec![Inst::Copy {
                    dst: l(11),
                    src: l(102),
                }],
                else_body: vec![
                    cnum(203, 2.0),
                    Inst::BinOp {
                        dst: l(204),
                        op: "===".to_string(),
                        lhs: l(7),
                        rhs: l(203),
                    },
                    Inst::If {
                        cond: l(204),
                        then_body: vec![Inst::Copy {
                            dst: l(11),
                            src: l(103),
                        }],
                        else_body: vec![
                            cnum(205, 3.0),
                            Inst::BinOp {
                                dst: l(206),
                                op: "===".to_string(),
                                lhs: l(7),
                                rhs: l(205),
                            },
                            Inst::If {
                                cond: l(206),
                                then_body: vec![Inst::Copy {
                                    dst: l(11),
                                    src: l(104),
                                }],
                                else_body: vec![],
                            },
                        ],
                    },
                ],
            },
        ]
    }

    fn split_join_escape_body() -> Vec<Inst> {
        let mut body = vec![
            cstr(20, ","),
            Inst::CallBuiltin {
                dst: Some(l(30)),
                builtin: "string.split".to_string(),
                recv: l(9),
                args: vec![l(20)],
            },
            Inst::Copy {
                dst: l(31),
                src: l(30),
            },
            cstr(21, "|"),
            Inst::CallBuiltin {
                dst: Some(l(32)),
                builtin: "array.join".to_string(),
                recv: l(31),
                args: vec![l(21)],
            },
            Inst::Copy {
                dst: l(33),
                src: l(32),
            },
            Inst::Copy {
                dst: l(100),
                src: l(33),
            },
            Inst::StringLen {
                dst: l(34),
                src: l(33),
            },
            Inst::BinOp {
                dst: l(35),
                op: "+".to_string(),
                lhs: l(1),
                rhs: l(34),
            },
            cnum(22, 0.0),
            Inst::CallBuiltin {
                dst: Some(l(36)),
                builtin: "string.charCodeAt".to_string(),
                recv: l(33),
                args: vec![l(22)],
            },
            Inst::BinOp {
                dst: l(37),
                op: "+".to_string(),
                lhs: l(35),
                rhs: l(36),
            },
            Inst::StringLen {
                dst: l(38),
                src: l(33),
            },
            cnum(23, 1.0),
            Inst::BinOp {
                dst: l(39),
                op: "-".to_string(),
                lhs: l(38),
                rhs: l(23),
            },
            Inst::CallBuiltin {
                dst: Some(l(40)),
                builtin: "string.charCodeAt".to_string(),
                recv: l(33),
                args: vec![l(39)],
            },
            Inst::BinOp {
                dst: l(41),
                op: "+".to_string(),
                lhs: l(37),
                rhs: l(40),
            },
            Inst::Copy {
                dst: l(1),
                src: l(41),
            },
        ];
        body.extend(tail());
        body
    }

    fn replace_escape_body() -> Vec<Inst> {
        let mut body = vec![
            cstr(20, "-"),
            cstr(21, "+"),
            Inst::CallBuiltin {
                dst: Some(l(30)),
                builtin: "string.replaceAll".to_string(),
                recv: l(9),
                args: vec![l(20), l(21)],
            },
            Inst::Copy {
                dst: l(31),
                src: l(30),
            },
            Inst::Copy {
                dst: l(100),
                src: l(31),
            },
            Inst::GenericLen {
                dst: l(32),
                src: l(31),
            },
            Inst::BinOp {
                dst: l(33),
                op: "+".to_string(),
                lhs: l(1),
                rhs: l(32),
            },
            cstr(22, "+"),
            unknown_method_call(34, 31, vec![l(22)]),
            Inst::BinOp {
                dst: l(35),
                op: "+".to_string(),
                lhs: l(33),
                rhs: l(34),
            },
            cnum(23, 0.0),
            unknown_method_call(36, 31, vec![l(23)]),
            Inst::BinOp {
                dst: l(37),
                op: "+".to_string(),
                lhs: l(35),
                rhs: l(36),
            },
            Inst::Copy {
                dst: l(1),
                src: l(37),
            },
        ];
        body.extend(tail());
        body
    }

    fn case_trim_escape_body() -> Vec<Inst> {
        let mut body = vec![
            Inst::CallBuiltin {
                dst: Some(l(30)),
                builtin: "string.trim".to_string(),
                recv: l(9),
                args: vec![],
            },
            Inst::Copy {
                dst: l(31),
                src: l(30),
            },
            Inst::CallBuiltin {
                dst: Some(l(32)),
                builtin: "string.toUpperCase".to_string(),
                recv: l(31),
                args: vec![],
            },
            Inst::Copy {
                dst: l(33),
                src: l(32),
            },
            Inst::CallBuiltin {
                dst: Some(l(34)),
                builtin: "string.toLowerCase".to_string(),
                recv: l(33),
                args: vec![],
            },
            Inst::Copy {
                dst: l(35),
                src: l(34),
            },
            Inst::Copy {
                dst: l(100),
                src: l(35),
            },
            Inst::StringLen {
                dst: l(36),
                src: l(35),
            },
            Inst::BinOp {
                dst: l(37),
                op: "+".to_string(),
                lhs: l(1),
                rhs: l(36),
            },
            cnum(20, 0.0),
            Inst::CallBuiltin {
                dst: Some(l(38)),
                builtin: "string.charCodeAt".to_string(),
                recv: l(35),
                args: vec![l(20)],
            },
            Inst::BinOp {
                dst: l(39),
                op: "+".to_string(),
                lhs: l(37),
                rhs: l(38),
            },
            Inst::StringLen {
                dst: l(40),
                src: l(35),
            },
            cnum(21, 1.0),
            Inst::BinOp {
                dst: l(41),
                op: "-".to_string(),
                lhs: l(40),
                rhs: l(21),
            },
            Inst::CallBuiltin {
                dst: Some(l(42)),
                builtin: "string.charCodeAt".to_string(),
                recv: l(35),
                args: vec![l(41)],
            },
            Inst::BinOp {
                dst: l(43),
                op: "+".to_string(),
                lhs: l(39),
                rhs: l(42),
            },
            Inst::Copy {
                dst: l(1),
                src: l(43),
            },
        ];
        body.extend(tail());
        body
    }

    fn dynamic_replace_escape_body() -> Vec<Inst> {
        let mut body = select4_prefix();
        body.extend(vec![
            Inst::CallBuiltin {
                dst: Some(l(30)),
                builtin: "string.replaceAll".to_string(),
                recv: l(11),
                args: vec![l(20), l(21)],
            },
            Inst::Copy {
                dst: l(31),
                src: l(30),
            },
            Inst::Copy {
                dst: l(100),
                src: l(31),
            },
            Inst::GenericLen {
                dst: l(32),
                src: l(31),
            },
            Inst::BinOp {
                dst: l(33),
                op: "+".to_string(),
                lhs: l(1),
                rhs: l(32),
            },
            unknown_method_call(34, 31, vec![l(21)]),
            Inst::BinOp {
                dst: l(35),
                op: "+".to_string(),
                lhs: l(33),
                rhs: l(34),
            },
            unknown_method_call(36, 31, vec![l(21)]),
            Inst::BinOp {
                dst: l(37),
                op: "+".to_string(),
                lhs: l(35),
                rhs: l(36),
            },
            cnum(22, 3.0),
            Inst::BinOp {
                dst: l(38),
                op: "*".to_string(),
                lhs: l(7),
                rhs: l(22),
            },
            cnum(23, 7.0),
            Inst::BinOp {
                dst: l(39),
                op: "&".to_string(),
                lhs: l(38),
                rhs: l(23),
            },
            unknown_method_call(40, 31, vec![l(39)]),
            Inst::BinOp {
                dst: l(41),
                op: "+".to_string(),
                lhs: l(37),
                rhs: l(40),
            },
            Inst::Copy {
                dst: l(1),
                src: l(41),
            },
        ]);
        for id in 300..309 {
            body.push(cnum(id, id as f64));
        }
        body
    }

    fn dynamic_split_join_escape_body() -> Vec<Inst> {
        let mut body = select4_prefix();
        body.extend(vec![
            Inst::CallBuiltin {
                dst: Some(l(30)),
                builtin: "string.split".to_string(),
                recv: l(11),
                args: vec![l(20)],
            },
            Inst::Copy {
                dst: l(31),
                src: l(30),
            },
            Inst::CallBuiltin {
                dst: Some(l(32)),
                builtin: "array.join".to_string(),
                recv: l(31),
                args: vec![l(21)],
            },
            Inst::Copy {
                dst: l(33),
                src: l(32),
            },
            Inst::Copy {
                dst: l(100),
                src: l(33),
            },
            Inst::ArrayLen {
                dst: l(34),
                arr: l(31),
            },
            Inst::BinOp {
                dst: l(35),
                op: "+".to_string(),
                lhs: l(1),
                rhs: l(34),
            },
            Inst::StringLen {
                dst: l(36),
                src: l(33),
            },
            Inst::BinOp {
                dst: l(37),
                op: "+".to_string(),
                lhs: l(35),
                rhs: l(36),
            },
            cnum(22, 1.0),
            Inst::LoadIndex {
                dst: l(38),
                arr: l(31),
                index: l(22),
                elem: 0,
            },
            Inst::StringLen {
                dst: l(39),
                src: l(38),
            },
            Inst::BinOp {
                dst: l(40),
                op: "+".to_string(),
                lhs: l(37),
                rhs: l(39),
            },
            cnum(23, 3.0),
            Inst::BinOp {
                dst: l(41),
                op: "*".to_string(),
                lhs: l(7),
                rhs: l(23),
            },
            cnum(24, 7.0),
            Inst::BinOp {
                dst: l(42),
                op: "&".to_string(),
                lhs: l(41),
                rhs: l(24),
            },
            Inst::CallBuiltin {
                dst: Some(l(43)),
                builtin: "string.charCodeAt".to_string(),
                recv: l(33),
                args: vec![l(42)],
            },
            Inst::BinOp {
                dst: l(44),
                op: "+".to_string(),
                lhs: l(40),
                rhs: l(43),
            },
            Inst::Copy {
                dst: l(1),
                src: l(44),
            },
        ]);
        body
    }

    #[test]
    fn plans_split_join_escape_materialization() {
        let plan = analyze_loop_body(&split_join_escape_body());
        let op = plan.full_body.expect("planned split/join escape");
        let MaterializationOp::StaticSplitJoinEscape(split_join) = op else {
            panic!("expected split/join materialization");
        };
        assert_eq!(split_join.recv, 9);
        assert_eq!(split_join.separator, str_units(","));
        assert_eq!(split_join.joiner, str_units("|"));
        assert_eq!(split_join.last, 100);
        assert_eq!(split_join.acc, 1);
        assert_eq!(split_join.counter.counter, 50);
    }

    #[test]
    fn plans_replace_escape_materialization() {
        let plan = analyze_loop_body(&replace_escape_body());
        let op = plan.full_body.expect("planned replace escape");
        let MaterializationOp::StaticReplaceEscape(replace) = op else {
            panic!("expected replace materialization");
        };
        assert_eq!(replace.recv, 9);
        assert_eq!(replace.pattern, str_units("-"));
        assert_eq!(replace.replacement, str_units("+"));
        assert_eq!(replace.index_needle, str_units("+"));
        assert_eq!(replace.char_idx, 0);
        assert_eq!(replace.last, 100);
        assert_eq!(replace.acc, 1);
    }

    #[test]
    fn plans_case_trim_escape_materialization() {
        let plan = analyze_loop_body(&case_trim_escape_body());
        let op = plan.full_body.expect("planned case/trim escape");
        let MaterializationOp::StaticCaseTrimEscape(case_trim) = op else {
            panic!("expected case/trim materialization");
        };
        assert_eq!(case_trim.recv, 9);
        assert_eq!(case_trim.last, 100);
        assert_eq!(case_trim.acc, 1);
        assert_eq!(case_trim.counter.inc, 1);
    }

    #[test]
    fn plans_dynamic_replace_escape_materialization() {
        let plan = analyze_loop_body(&dynamic_replace_escape_body());
        let op = plan.full_body.expect("planned dynamic replace escape");
        let MaterializationOp::DynamicReplaceEscape(replace) = op else {
            panic!("expected dynamic replace materialization");
        };
        assert_eq!(replace.select.dst, 11);
        assert_eq!(replace.select.pick, 7);
        assert_eq!(replace.select.values, [101, 102, 103, 104]);
        assert_eq!(replace.skip, 20);
        assert_eq!(replace.pattern, 20);
        assert_eq!(replace.replacement, 21);
        assert_eq!(replace.last, 100);
        assert_eq!(replace.acc, 1);
        assert_eq!(replace.mult, 3);
        assert_eq!(replace.mask, 7);
    }

    #[test]
    fn plans_dynamic_split_join_escape_materialization() {
        let plan = analyze_loop_body(&dynamic_split_join_escape_body());
        let op = plan.full_body.expect("planned dynamic split/join escape");
        let MaterializationOp::DynamicSplitJoinEscape(split_join) = op else {
            panic!("expected dynamic split/join materialization");
        };
        assert_eq!(split_join.select.dst, 11);
        assert_eq!(split_join.select.values, [101, 102, 103, 104]);
        assert_eq!(split_join.separator, 20);
        assert_eq!(split_join.joiner, 21);
        assert_eq!(split_join.part_index, 1);
        assert_eq!(split_join.last, 100);
        assert_eq!(split_join.acc, 1);
    }

    #[test]
    fn plans_str16_static_replace_escape_materialization() {
        let mut body = replace_escape_body();
        body[0] = cstr16(20, &[0xd800]);
        body[1] = cstr16(21, &[0xdc00]);
        body[7] = cstr16(22, &[0xdc00]);
        let plan = analyze_loop_body(&body);
        let op = plan.full_body.expect("planned Str16 replace escape");
        let MaterializationOp::StaticReplaceEscape(replace) = op else {
            panic!("expected replace materialization");
        };
        assert_eq!(replace.pattern, vec![0xd800]);
        assert_eq!(replace.replacement, vec![0xdc00]);
        assert_eq!(replace.index_needle, vec![0xdc00]);
    }

    #[test]
    fn rejects_dynamic_materialized_temp_used_after() {
        let mut body = dynamic_replace_escape_body();
        body.push(Inst::Print { src: l(31) });
        let plan = analyze_loop_body(&body);
        assert!(plan.full_body.is_none());
    }

    #[test]
    fn rejects_receiver_redefinition() {
        let mut body = split_join_escape_body();
        body[1] = Inst::CallBuiltin {
            dst: Some(l(9)),
            builtin: "string.split".to_string(),
            recv: l(9),
            args: vec![l(20)],
        };
        body[2] = Inst::Copy {
            dst: l(31),
            src: l(9),
        };
        let plan = analyze_loop_body(&body);
        assert!(plan.full_body.is_none());
    }
}
