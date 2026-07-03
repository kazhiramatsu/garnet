use std::collections::BTreeMap;

use crate::escape_ir::*;
use crate::string_plan::{
    add_uses, collect_defs, has_control_flow, inst_def_local, locals_used_after, match_const_dst,
    match_const_i64, match_const_str, LoopPath, PathEdge, PathSegment, StaticString,
};

#[derive(Clone, Debug, Default)]
pub struct StringMetricPlan {
    pub functions: BTreeMap<u32, FunctionMetricPlan>,
}

#[derive(Clone, Debug, Default)]
pub struct FunctionMetricPlan {
    pub loops: BTreeMap<LoopPath, LoopMetricPlan>,
}

#[derive(Clone, Debug, Default)]
pub struct LoopMetricPlan {
    pub full_loop: Option<LoopMetricOp>,
    pub body_ranges: BTreeMap<usize, MetricOp>,
}

#[derive(Clone, Debug)]
pub enum LoopMetricOp {
    CaseTrim(CaseTrimMetric),
}

#[derive(Clone, Debug)]
pub enum MetricOp {
    SearchPair(SearchPairMetric),
    Replace(ReplaceMetric),
    SplitJoin(SplitJoinMetric),
}

impl MetricOp {
    pub fn len(&self) -> usize {
        match self {
            MetricOp::SearchPair(m) => m.len,
            MetricOp::Replace(m) => m.len,
            MetricOp::SplitJoin(m) => m.len,
        }
    }
}

#[derive(Clone, Debug)]
pub struct SearchPairMetric {
    pub start: usize,
    pub len: usize,
    pub recv: u32,
    pub acc: u32,
    pub from: u32,
    pub needle1: MetricNeedle,
    pub needle2: MetricNeedle,
}

#[derive(Clone, Debug)]
pub enum MetricNeedle {
    StaticLiteral(StaticString),
    Local(u32),
}

#[derive(Clone, Debug)]
pub struct ReplaceMetric {
    pub start: usize,
    pub len: usize,
    pub recv: u32,
    pub acc: u32,
    pub pattern: MetricNeedle,
    pub replacement: MetricNeedle,
    pub index_needle: MetricNeedle,
    pub char_idx: i64,
}

#[derive(Clone, Debug)]
pub struct SplitJoinMetric {
    pub start: usize,
    pub len: usize,
    pub recv: u32,
    pub acc: u32,
    pub separator: MetricNeedle,
    pub joiner: MetricNeedle,
    pub part_index: i64,
}

#[derive(Clone, Debug)]
pub struct CaseTrimMetric {
    pub recv: u32,
    pub acc: u32,
    pub counter: CounterAddTailMetric,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CounterAddTailMetric {
    pub counter: u32,
    pub inc: i64,
}

pub fn analyze_program(program: &Program) -> StringMetricPlan {
    let mut functions = BTreeMap::new();
    for f in &program.functions {
        let fp = analyze_function(f);
        if !fp.loops.is_empty() {
            functions.insert(f.id.0, fp);
        }
    }
    StringMetricPlan { functions }
}

fn analyze_function(f: &Function) -> FunctionMetricPlan {
    let mut fp = FunctionMetricPlan::default();
    let mut path = Vec::new();
    analyze_seq(&f.body, PathEdge::Function, &mut path, &mut fp);
    fp
}

fn analyze_seq(
    seq: &[Inst],
    edge: PathEdge,
    path: &mut Vec<PathSegment>,
    fp: &mut FunctionMetricPlan,
) {
    for (index, inst) in seq.iter().enumerate() {
        path.push(PathSegment { edge, index });
        match inst {
            Inst::Loop {
                cond_body, body, ..
            } => {
                let loop_path = LoopPath(path.clone());
                let loop_plan = analyze_loop_body(body);
                if loop_plan.full_loop.is_some() || !loop_plan.body_ranges.is_empty() {
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

fn analyze_loop_body(body: &[Inst]) -> LoopMetricPlan {
    let mut plan = LoopMetricPlan::default();
    plan.full_loop = match_case_trim_metric_loop(body);
    let mut i = 0;
    while i < body.len() {
        if let Some(op) = match_search_pair_metric(body, i) {
            i += op.len();
            plan.body_ranges.insert(op_start(&op), op);
            continue;
        }
        if let Some(op) = match_dynamic_search_pair_metric(body, i) {
            i += op.len();
            plan.body_ranges.insert(op_start(&op), op);
            continue;
        }
        if let Some(op) = match_replace_metric(body, i) {
            i += op.len();
            plan.body_ranges.insert(op_start(&op), op);
            continue;
        }
        if let Some(op) = match_dynamic_replace_metric(body, i) {
            i += op.len();
            plan.body_ranges.insert(op_start(&op), op);
            continue;
        }
        if let Some(op) = match_split_join_metric(body, i) {
            i += op.len();
            plan.body_ranges.insert(op_start(&op), op);
            continue;
        }
        if let Some(op) = match_dynamic_split_join_metric(body, i) {
            i += op.len();
            plan.body_ranges.insert(op_start(&op), op);
            continue;
        }
        i += 1;
    }
    plan
}

fn op_start(op: &MetricOp) -> usize {
    match op {
        MetricOp::SearchPair(m) => m.start,
        MetricOp::Replace(m) => m.start,
        MetricOp::SplitJoin(m) => m.start,
    }
}

fn match_case_trim_metric_loop(body: &[Inst]) -> Option<LoopMetricOp> {
    if body.len() != 20 || has_control_flow(body) {
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

    Some(LoopMetricOp::CaseTrim(CaseTrimMetric {
        recv: trim_recv.0,
        acc: sum_copy.0,
        counter: match_counter_add_tail(body, 17)?,
    }))
}

fn match_search_pair_metric(body: &[Inst], start: usize) -> Option<MetricOp> {
    if body.len().saturating_sub(start) < 11 {
        return None;
    }
    let seq = &body[start..start + 11];
    if has_control_flow(seq) {
        return None;
    }
    let (
        Inst::Copy {
            dst: acc_alias1,
            src: acc_src1,
        },
        needle1_const,
        Inst::CallBuiltin {
            dst: Some(index_res),
            builtin: index_builtin,
            recv: index_recv,
            args: index_args,
        },
        Inst::BinOp {
            dst: index_sum_tmp,
            op: index_sum_op,
            lhs: index_sum_lhs,
            rhs: index_sum_rhs,
        },
        Inst::Copy {
            dst: acc_after_index,
            src: index_sum_src,
        },
        Inst::Copy {
            dst: acc_alias2,
            src: acc_src2,
        },
        needle2_const,
        Inst::StringLen {
            dst: hay_len,
            src: len_src,
        },
        Inst::CallBuiltin {
            dst: Some(last_res),
            builtin: last_builtin,
            recv: last_recv,
            args: last_args,
        },
        Inst::BinOp {
            dst: last_sum_tmp,
            op: last_sum_op,
            lhs: last_sum_lhs,
            rhs: last_sum_rhs,
        },
        Inst::Copy {
            dst: acc_after_last,
            src: last_sum_src,
        },
    ) = (
        &seq[0], &seq[1], &seq[2], &seq[3], &seq[4], &seq[5], &seq[6], &seq[7], &seq[8], &seq[9],
        &seq[10],
    )
    else {
        return None;
    };
    let (needle1_dst, needle1) = match_const_str(needle1_const)?;
    let (needle2_dst, needle2) = match_const_str(needle2_const)?;
    if index_builtin != "string.indexOf"
        || last_builtin != "string.lastIndexOf"
        || index_sum_op != "+"
        || last_sum_op != "+"
        || index_recv.0 != last_recv.0
        || len_src.0 != index_recv.0
        || index_args.len() != 2
        || index_args[0].0 != needle1_dst
        || last_args.len() != 2
        || last_args[0].0 != needle2_dst
        || last_args[1].0 != hay_len.0
        || index_sum_tmp.0 != index_sum_src.0
        || last_sum_tmp.0 != last_sum_src.0
        || acc_after_index.0 != acc_src1.0
        || acc_src2.0 != acc_after_index.0
        || acc_after_last.0 != acc_after_index.0
    {
        return None;
    }
    if !add_uses(*index_sum_lhs, *index_sum_rhs, acc_alias1.0, index_res.0)
        || !add_uses(*last_sum_lhs, *last_sum_rhs, acc_alias2.0, last_res.0)
    {
        return None;
    }
    let defs = collect_defs(seq);
    if locals_used_after(body, start + 11, &defs) {
        return None;
    }
    Some(MetricOp::SearchPair(SearchPairMetric {
        start,
        len: 11,
        recv: index_recv.0,
        acc: acc_after_last.0,
        from: index_args[1].0,
        needle1: MetricNeedle::StaticLiteral(needle1),
        needle2: MetricNeedle::StaticLiteral(needle2),
    }))
}

fn match_dynamic_search_pair_metric(body: &[Inst], start: usize) -> Option<MetricOp> {
    if body.len().saturating_sub(start) < 9 {
        return None;
    }
    let seq = &body[start..start + 9];
    if has_control_flow(seq) {
        return None;
    }
    let (
        Inst::Copy {
            dst: acc_alias1,
            src: acc_src1,
        },
        Inst::CallBuiltin {
            dst: Some(index_res),
            builtin: index_builtin,
            recv: index_recv,
            args: index_args,
        },
        Inst::BinOp {
            dst: index_sum_tmp,
            op: index_sum_op,
            lhs: index_sum_lhs,
            rhs: index_sum_rhs,
        },
        Inst::Copy {
            dst: acc_after_index,
            src: index_sum_src,
        },
        Inst::Copy {
            dst: acc_alias2,
            src: acc_src2,
        },
        Inst::StringLen {
            dst: hay_len,
            src: len_src,
        },
        Inst::CallBuiltin {
            dst: Some(last_res),
            builtin: last_builtin,
            recv: last_recv,
            args: last_args,
        },
        Inst::BinOp {
            dst: last_sum_tmp,
            op: last_sum_op,
            lhs: last_sum_lhs,
            rhs: last_sum_rhs,
        },
        Inst::Copy {
            dst: acc_after_last,
            src: last_sum_src,
        },
    ) = (
        &seq[0], &seq[1], &seq[2], &seq[3], &seq[4], &seq[5], &seq[6], &seq[7], &seq[8],
    )
    else {
        return None;
    };
    if index_builtin != "string.indexOf"
        || last_builtin != "string.lastIndexOf"
        || index_sum_op != "+"
        || last_sum_op != "+"
        || index_recv.0 != last_recv.0
        || len_src.0 != index_recv.0
        || index_args.len() != 2
        || last_args.len() != 2
        || last_args[1].0 != hay_len.0
        || index_sum_tmp.0 != index_sum_src.0
        || last_sum_tmp.0 != last_sum_src.0
        || acc_after_index.0 != acc_src1.0
        || acc_src2.0 != acc_after_index.0
        || acc_after_last.0 != acc_after_index.0
    {
        return None;
    }
    if !add_uses(*index_sum_lhs, *index_sum_rhs, acc_alias1.0, index_res.0)
        || !add_uses(*last_sum_lhs, *last_sum_rhs, acc_alias2.0, last_res.0)
    {
        return None;
    }
    let defs = collect_defs(seq);
    if locals_used_after(body, start + 9, &defs) {
        return None;
    }
    Some(MetricOp::SearchPair(SearchPairMetric {
        start,
        len: 9,
        recv: index_recv.0,
        acc: acc_after_last.0,
        from: index_args[1].0,
        needle1: MetricNeedle::Local(index_args[0].0),
        needle2: MetricNeedle::Local(last_args[0].0),
    }))
}

fn match_replace_metric(body: &[Inst], start: usize) -> Option<MetricOp> {
    if body.len().saturating_sub(start) < 13 {
        return None;
    }
    let seq = &body[start..start + 13];
    if has_control_flow(seq) {
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
        Inst::GenericLen {
            dst: replaced_len,
            src: replaced_len_src,
        },
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
        &seq[0], &seq[1], &seq[2], &seq[3], &seq[4], &seq[5], &seq[6], &seq[7], &seq[8], &seq[9],
        &seq[10], &seq[11], &seq[12],
    )
    else {
        return None;
    };
    let (pat_dst, pat) = match_const_str(pat_const)?;
    let (rep_dst, rep) = match_const_str(rep_const)?;
    let (index_needle_dst, index_needle) = match_const_str(index_needle_const)?;
    if replace_builtin != "string.replaceAll"
        || replace_args.len() != 2
        || replace_args[0].0 != pat_dst
        || replace_args[1].0 != rep_dst
        || replaced_res.0 != replaced_src.0
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
    let defs = collect_defs(seq);
    if locals_used_after(body, start + 13, &defs) {
        return None;
    }
    Some(MetricOp::Replace(ReplaceMetric {
        start,
        len: 13,
        recv: replace_recv.0,
        acc: sum_copy.0,
        pattern: MetricNeedle::StaticLiteral(pat),
        replacement: MetricNeedle::StaticLiteral(rep),
        index_needle: MetricNeedle::StaticLiteral(index_needle),
        char_idx,
    }))
}

fn match_dynamic_replace_metric(body: &[Inst], start: usize) -> Option<MetricOp> {
    if body.len().saturating_sub(start) < 10 {
        return None;
    }
    let seq = &body[start..start + 10];
    if has_control_flow(seq) {
        return None;
    }
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
        Inst::GenericLen {
            dst: replaced_len,
            src: replaced_len_src,
        },
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
        &seq[0], &seq[1], &seq[2], &seq[3], &seq[4], &seq[5], &seq[6], &seq[7], &seq[8], &seq[9],
    )
    else {
        return None;
    };
    if replace_builtin != "string.replaceAll"
        || replace_args.len() != 2
        || replaced_res.0 != replaced_src.0
        || replaced_len_src.0 != replaced.0
        || sum_len_op != "+"
        || replaced_len.0 != sum_len_rhs.0
        || index_recv.0 != replaced.0
        || index_args.len() != 1
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
    let defs = collect_defs(seq);
    if locals_used_after(body, start + 10, &defs) {
        return None;
    }
    Some(MetricOp::Replace(ReplaceMetric {
        start,
        len: 10,
        recv: replace_recv.0,
        acc: sum_copy.0,
        pattern: MetricNeedle::Local(replace_args[0].0),
        replacement: MetricNeedle::Local(replace_args[1].0),
        index_needle: MetricNeedle::Local(index_args[0].0),
        char_idx,
    }))
}

fn match_split_join_metric(body: &[Inst], start: usize) -> Option<MetricOp> {
    if body.len().saturating_sub(start) < 15 {
        return None;
    }
    let seq = &body[start..start + 15];
    if has_control_flow(seq) {
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
        Inst::ArrayLen {
            dst: parts_len,
            arr: parts_len_arr,
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
        index_const,
        Inst::LoadIndex {
            dst: part_value,
            arr: load_arr,
            index: load_index,
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
        Inst::Copy {
            dst: sum_copy,
            src: sum_part_src,
        },
    ) = (
        &seq[0], &seq[1], &seq[2], &seq[3], &seq[4], &seq[5], &seq[6], &seq[7], &seq[8], &seq[9],
        &seq[10], &seq[11], &seq[12], &seq[13], &seq[14],
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
        || parts_len_arr.0 != parts.0
        || parts_len.0 != sum_parts_rhs.0
        || joined_len_src.0 != joined.0
        || joined_len.0 != sum_joined_rhs.0
        || sum_parts_tmp.0 != sum_joined_lhs.0
        || load_arr.0 != parts.0
        || load_index.0 != match_const_dst(index_const)?
        || part_value.0 != part_len_src.0
        || part_len.0 != sum_part_rhs.0
        || sum_joined_tmp.0 != sum_part_lhs.0
        || sum_part_tmp.0 != sum_part_src.0
        || sum_copy.0 != sum_parts_lhs.0
        || sum_parts_op != "+"
        || sum_joined_op != "+"
        || sum_part_op != "+"
    {
        return None;
    }
    let part_index = match_const_i64(index_const)?;
    if part_index < 0 {
        return None;
    }
    let defs = collect_defs(seq);
    if locals_used_after(body, start + 15, &defs) {
        return None;
    }
    Some(MetricOp::SplitJoin(SplitJoinMetric {
        start,
        len: 15,
        recv: split_recv.0,
        acc: sum_copy.0,
        separator: MetricNeedle::StaticLiteral(split_sep),
        joiner: MetricNeedle::StaticLiteral(join_sep),
        part_index,
    }))
}

fn match_dynamic_split_join_metric(body: &[Inst], start: usize) -> Option<MetricOp> {
    if body.len().saturating_sub(start) < 13 {
        return None;
    }
    let seq = &body[start..start + 13];
    if has_control_flow(seq) {
        return None;
    }
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
        Inst::ArrayLen {
            dst: parts_len,
            arr: parts_len_arr,
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
        index_const,
        Inst::LoadIndex {
            dst: part_value,
            arr: load_arr,
            index: load_index,
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
        Inst::Copy {
            dst: sum_copy,
            src: sum_part_src,
        },
    ) = (
        &seq[0], &seq[1], &seq[2], &seq[3], &seq[4], &seq[5], &seq[6], &seq[7], &seq[8], &seq[9],
        &seq[10], &seq[11], &seq[12],
    )
    else {
        return None;
    };
    if split_builtin != "string.split"
        || join_builtin != "array.join"
        || split_args.len() != 1
        || split_res.0 != split_src.0
        || join_recv.0 != parts.0
        || join_args.len() != 1
        || join_res.0 != join_src.0
        || parts_len_arr.0 != parts.0
        || parts_len.0 != sum_parts_rhs.0
        || joined_len_src.0 != joined.0
        || joined_len.0 != sum_joined_rhs.0
        || sum_parts_tmp.0 != sum_joined_lhs.0
        || load_arr.0 != parts.0
        || load_index.0 != match_const_dst(index_const)?
        || part_value.0 != part_len_src.0
        || part_len.0 != sum_part_rhs.0
        || sum_joined_tmp.0 != sum_part_lhs.0
        || sum_part_tmp.0 != sum_part_src.0
        || sum_copy.0 != sum_parts_lhs.0
        || sum_parts_op != "+"
        || sum_joined_op != "+"
        || sum_part_op != "+"
    {
        return None;
    }
    let part_index = match_const_i64(index_const)?;
    if part_index < 0 {
        return None;
    }
    let defs = collect_defs(seq);
    if locals_used_after(body, start + 13, &defs) {
        return None;
    }
    Some(MetricOp::SplitJoin(SplitJoinMetric {
        start,
        len: 13,
        recv: split_recv.0,
        acc: sum_copy.0,
        separator: MetricNeedle::Local(split_args[0].0),
        joiner: MetricNeedle::Local(join_args[0].0),
        part_index,
    }))
}

fn match_counter_add_tail(body: &[Inst], start: usize) -> Option<CounterAddTailMetric> {
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
    Some(CounterAddTailMetric {
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

    fn as_search(op: &MetricOp) -> &SearchPairMetric {
        match op {
            MetricOp::SearchPair(search) => search,
            _ => panic!("expected search metric"),
        }
    }

    fn as_replace(op: &MetricOp) -> &ReplaceMetric {
        match op {
            MetricOp::Replace(replace) => replace,
            _ => panic!("expected replace metric"),
        }
    }

    fn as_split_join(op: &MetricOp) -> &SplitJoinMetric {
        match op {
            MetricOp::SplitJoin(split_join) => split_join,
            _ => panic!("expected split/join metric"),
        }
    }

    fn as_case_trim_loop(op: &LoopMetricOp) -> &CaseTrimMetric {
        match op {
            LoopMetricOp::CaseTrim(case_trim) => case_trim,
        }
    }

    fn method_call(dst: u32, recv: u32, args: Vec<LocalId>) -> Inst {
        Inst::Call {
            dst: Some(l(dst)),
            callee: CalleeRef::Unknown,
            recv: Some(l(recv)),
            args,
            resolved_sig: None,
        }
    }

    fn static_search_pair_body() -> Vec<Inst> {
        vec![
            Inst::Copy {
                dst: l(2),
                src: l(1),
            },
            cstr(8, "needle"),
            Inst::CallBuiltin {
                dst: Some(l(4)),
                builtin: "string.indexOf".to_string(),
                recv: l(9),
                args: vec![l(8), l(11)],
            },
            Inst::BinOp {
                dst: l(3),
                op: "+".to_string(),
                lhs: l(2),
                rhs: l(4),
            },
            Inst::Copy {
                dst: l(1),
                src: l(3),
            },
            Inst::Copy {
                dst: l(5),
                src: l(1),
            },
            cstr(12, "XYZ"),
            Inst::StringLen {
                dst: l(13),
                src: l(9),
            },
            Inst::CallBuiltin {
                dst: Some(l(7)),
                builtin: "string.lastIndexOf".to_string(),
                recv: l(9),
                args: vec![l(12), l(13)],
            },
            Inst::BinOp {
                dst: l(6),
                op: "+".to_string(),
                lhs: l(5),
                rhs: l(7),
            },
            Inst::Copy {
                dst: l(1),
                src: l(6),
            },
        ]
    }

    fn static_replace_body() -> Vec<Inst> {
        vec![
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
            method_call(34, 31, vec![l(22)]),
            Inst::BinOp {
                dst: l(35),
                op: "+".to_string(),
                lhs: l(33),
                rhs: l(34),
            },
            cnum(23, 0.0),
            method_call(36, 31, vec![l(23)]),
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
        ]
    }

    fn dynamic_replace_body() -> Vec<Inst> {
        vec![
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
            method_call(34, 31, vec![l(22)]),
            Inst::BinOp {
                dst: l(35),
                op: "+".to_string(),
                lhs: l(33),
                rhs: l(34),
            },
            cnum(23, 0.0),
            method_call(36, 31, vec![l(23)]),
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
        ]
    }

    fn static_split_join_body() -> Vec<Inst> {
        vec![
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
            Inst::Copy {
                dst: l(1),
                src: l(40),
            },
        ]
    }

    fn dynamic_split_join_body() -> Vec<Inst> {
        vec![
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
            Inst::Copy {
                dst: l(1),
                src: l(40),
            },
        ]
    }

    fn case_trim_loop_body() -> Vec<Inst> {
        vec![
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
            cnum(22, 1.0),
            Inst::BinOp {
                dst: l(44),
                op: "+".to_string(),
                lhs: l(50),
                rhs: l(22),
            },
            Inst::Copy {
                dst: l(50),
                src: l(44),
            },
        ]
    }

    fn dynamic_search_pair_body() -> Vec<Inst> {
        vec![
            Inst::Copy {
                dst: l(2),
                src: l(1),
            },
            Inst::CallBuiltin {
                dst: Some(l(4)),
                builtin: "string.indexOf".to_string(),
                recv: l(9),
                args: vec![l(8), l(11)],
            },
            Inst::BinOp {
                dst: l(3),
                op: "+".to_string(),
                lhs: l(2),
                rhs: l(4),
            },
            Inst::Copy {
                dst: l(1),
                src: l(3),
            },
            Inst::Copy {
                dst: l(5),
                src: l(1),
            },
            Inst::StringLen {
                dst: l(13),
                src: l(9),
            },
            Inst::CallBuiltin {
                dst: Some(l(7)),
                builtin: "string.lastIndexOf".to_string(),
                recv: l(9),
                args: vec![l(12), l(13)],
            },
            Inst::BinOp {
                dst: l(6),
                op: "+".to_string(),
                lhs: l(5),
                rhs: l(7),
            },
            Inst::Copy {
                dst: l(1),
                src: l(6),
            },
        ]
    }

    #[test]
    fn plans_static_search_pair_metric() {
        let plan = analyze_loop_body(&static_search_pair_body());
        let op = plan.body_ranges.get(&0).expect("planned range at 0");
        let search = as_search(op);
        assert_eq!(search.len, 11);
        assert_eq!(search.recv, 9);
        assert_eq!(search.acc, 1);
        assert_eq!(search.from, 11);
        assert!(matches!(
            &search.needle1,
            MetricNeedle::StaticLiteral(s) if s == &str_units("needle")
        ));
        assert!(matches!(
            &search.needle2,
            MetricNeedle::StaticLiteral(s) if s == &str_units("XYZ")
        ));
    }

    #[test]
    fn plans_str16_static_search_pair_metric() {
        let mut body = static_search_pair_body();
        body[1] = cstr16(8, &[0xd800]);
        body[6] = cstr16(12, &[0xdc00]);
        let plan = analyze_loop_body(&body);
        let op = plan.body_ranges.get(&0).expect("planned Str16 range at 0");
        let search = as_search(op);
        assert!(matches!(
            &search.needle1,
            MetricNeedle::StaticLiteral(s) if s == &vec![0xd800]
        ));
        assert!(matches!(
            &search.needle2,
            MetricNeedle::StaticLiteral(s) if s == &vec![0xdc00]
        ));
    }

    #[test]
    fn plans_dynamic_search_pair_metric() {
        let plan = analyze_loop_body(&dynamic_search_pair_body());
        let op = plan.body_ranges.get(&0).expect("planned range at 0");
        let search = as_search(op);
        assert_eq!(search.len, 9);
        assert_eq!(search.recv, 9);
        assert_eq!(search.acc, 1);
        assert_eq!(search.from, 11);
        assert!(matches!(search.needle1, MetricNeedle::Local(8)));
        assert!(matches!(search.needle2, MetricNeedle::Local(12)));
    }

    #[test]
    fn plans_case_trim_full_loop_metric() {
        let plan = analyze_loop_body(&case_trim_loop_body());
        let op = plan.full_loop.as_ref().expect("planned full-loop metric");
        let case_trim = as_case_trim_loop(op);
        assert_eq!(case_trim.recv, 9);
        assert_eq!(case_trim.acc, 1);
        assert_eq!(case_trim.counter.counter, 50);
        assert_eq!(case_trim.counter.inc, 1);
    }

    #[test]
    fn plans_static_replace_metric() {
        let plan = analyze_loop_body(&static_replace_body());
        let op = plan.body_ranges.get(&0).expect("planned range at 0");
        let replace = as_replace(op);
        assert_eq!(replace.len, 13);
        assert_eq!(replace.recv, 9);
        assert_eq!(replace.acc, 1);
        assert_eq!(replace.char_idx, 0);
        assert!(matches!(
            &replace.pattern,
            MetricNeedle::StaticLiteral(s) if s == &str_units("-")
        ));
        assert!(matches!(
            &replace.replacement,
            MetricNeedle::StaticLiteral(s) if s == &str_units("+")
        ));
        assert!(matches!(
            &replace.index_needle,
            MetricNeedle::StaticLiteral(s) if s == &str_units("+")
        ));
    }

    #[test]
    fn plans_dynamic_replace_metric() {
        let plan = analyze_loop_body(&dynamic_replace_body());
        let op = plan.body_ranges.get(&0).expect("planned range at 0");
        let replace = as_replace(op);
        assert_eq!(replace.len, 10);
        assert_eq!(replace.recv, 9);
        assert_eq!(replace.acc, 1);
        assert_eq!(replace.char_idx, 0);
        assert!(matches!(replace.pattern, MetricNeedle::Local(20)));
        assert!(matches!(replace.replacement, MetricNeedle::Local(21)));
        assert!(matches!(replace.index_needle, MetricNeedle::Local(22)));
    }

    #[test]
    fn plans_static_split_join_metric() {
        let plan = analyze_loop_body(&static_split_join_body());
        let op = plan.body_ranges.get(&0).expect("planned range at 0");
        let split_join = as_split_join(op);
        assert_eq!(split_join.len, 15);
        assert_eq!(split_join.recv, 9);
        assert_eq!(split_join.acc, 1);
        assert_eq!(split_join.part_index, 1);
        assert!(matches!(
            &split_join.separator,
            MetricNeedle::StaticLiteral(s) if s == &str_units(",")
        ));
        assert!(matches!(
            &split_join.joiner,
            MetricNeedle::StaticLiteral(s) if s == &str_units("|")
        ));
    }

    #[test]
    fn plans_dynamic_split_join_metric() {
        let plan = analyze_loop_body(&dynamic_split_join_body());
        let op = plan.body_ranges.get(&0).expect("planned range at 0");
        let split_join = as_split_join(op);
        assert_eq!(split_join.len, 13);
        assert_eq!(split_join.recv, 9);
        assert_eq!(split_join.acc, 1);
        assert_eq!(split_join.part_index, 1);
        assert!(matches!(split_join.separator, MetricNeedle::Local(20)));
        assert!(matches!(split_join.joiner, MetricNeedle::Local(21)));
    }

    #[test]
    fn rejects_when_skipped_def_is_used_after_range() {
        let mut body = static_search_pair_body();
        body.push(Inst::Print { src: l(4) });
        let plan = analyze_loop_body(&body);
        assert!(plan.body_ranges.is_empty());
    }

    #[test]
    fn rejects_replace_when_materialized_result_is_used_after_range() {
        let mut body = static_replace_body();
        body.push(Inst::Print { src: l(31) });
        let plan = analyze_loop_body(&body);
        assert!(plan.body_ranges.is_empty());
    }

    #[test]
    fn rejects_split_join_when_materialized_parts_are_used_after_range() {
        let mut body = static_split_join_body();
        body.push(Inst::Print { src: l(31) });
        let plan = analyze_loop_body(&body);
        assert!(plan.body_ranges.is_empty());
    }
}
