//! String accumulators (docs/string_accumulators_design.md): a local that is
//! initialized with a string constant and otherwise only appended to
//! (`T = L + E; L = T` through a single-use temporary), read for its length
//! and returned. The emitter builds it in a private buffer: no intermediate
//! string per append.

use std::collections::{BTreeMap, BTreeSet};

use crate::escape_ir::*;
use crate::string_plan::{inst_def_local, match_const_str};

#[derive(Default, Clone, Debug)]
pub struct StringAccums {
    /// the accumulator locals
    pub locals: BTreeSet<u32>,
    /// append temporaries: T -> (L, E)
    pub temps: BTreeMap<u32, (u32, u32)>,
    /// the constant local of each accumulator's initial copy: L -> C
    pub inits: BTreeMap<u32, u32>,
}

impl StringAccums {
    pub fn is_empty(&self) -> bool {
        self.locals.is_empty()
    }
}

fn flatten<'a>(body: &'a [Inst], out: &mut Vec<&'a Inst>) {
    for inst in body {
        out.push(inst);
        match inst {
            Inst::If { then_body, else_body, .. } => {
                flatten(then_body, out);
                flatten(else_body, out);
            }
            Inst::Loop { cond_body, body, .. } => {
                flatten(cond_body, out);
                flatten(body, out);
            }
            Inst::TryCatch { try_body, catch_body, finally_body, .. } => {
                flatten(try_body, out);
                flatten(catch_body, out);
                flatten(finally_body, out);
            }
            _ => {}
        }
    }
}

/// How many times `inst` itself (not its nested bodies) mentions local `x`,
/// as a definition or an operand: the derived Debug text names every local
/// field, which keeps this complete for every instruction kind.
fn mentions(inst: &Inst, x: u32) -> usize {
    let own = match inst {
        Inst::If { cond, .. } | Inst::Loop { cond, .. } => return (cond.0 == x) as usize,
        Inst::TryCatch { catch_var, .. } => return catch_var.map_or(0, |c| (c.0 == x) as usize),
        other => format!("{:?}", other),
    };
    let needle = format!("LocalId({})", x);
    own.matches(&needle).count()
}

pub fn string_accumulators(f: &Function) -> StringAccums {
    let mut out = StringAccums::default();
    if f.is_generator || f.is_async {
        return out;
    }
    let mut flat: Vec<&Inst> = Vec::new();
    flatten(&f.body, &mut flat);
    let const_str: BTreeSet<u32> = flat.iter().filter_map(|i| match_const_str(i).map(|(d, _)| d)).collect();
    if const_str.is_empty() {
        return out;
    }
    // cheap pre-filter: L copied from a string constant and the left operand of a `+`
    let mut cands: BTreeSet<u32> = BTreeSet::new();
    for i in &flat {
        if let Inst::Copy { dst, src } = i {
            if const_str.contains(&src.0) {
                cands.insert(dst.0);
            }
        }
    }
    let plus_lhs: BTreeSet<u32> = flat
        .iter()
        .filter_map(|i| match i {
            Inst::BinOp { op, lhs, .. } if op == "+" => Some(lhs.0),
            _ => None,
        })
        .collect();
    cands.retain(|l| plus_lhs.contains(l));
    let params: BTreeSet<u32> = f.params.iter().map(|p| p.0).collect();
    cands.retain(|l| !params.contains(l));
    if let Some(r) = f.rest_param {
        cands.remove(&r);
    }
    if cands.is_empty() {
        return out;
    }
    // definitions of every local, for the temporaries' single-def test
    let mut def_count: BTreeMap<u32, usize> = BTreeMap::new();
    for i in &flat {
        if let Some(d) = inst_def_local(i) {
            *def_count.entry(d).or_default() += 1;
        }
        if let Inst::TryCatch { catch_var: Some(c), .. } = i {
            *def_count.entry(c.0).or_default() += 1;
        }
    }
    'cand: for &l in &cands {
        let mut init: Option<u32> = None;
        let mut temps: Vec<(u32, u32)> = Vec::new();
        // every definition of L: one constant copy, otherwise append copies
        for i in &flat {
            if inst_def_local(i) != Some(l) {
                if let Inst::TryCatch { catch_var: Some(c), .. } = i {
                    if c.0 == l {
                        continue 'cand;
                    }
                }
                continue;
            }
            match i {
                Inst::Copy { src, .. } if const_str.contains(&src.0) && init.is_none() => init = Some(src.0),
                Inst::Copy { src, .. } => {
                    // the temporary: one definition, a `+` with L on the left
                    let t = src.0;
                    if def_count.get(&t) != Some(&1) {
                        continue 'cand;
                    }
                    let def = flat.iter().find(|j| inst_def_local(j) == Some(t));
                    match def {
                        Some(Inst::BinOp { op, lhs, rhs, .. }) if op == "+" && lhs.0 == l && rhs.0 != l => {
                            temps.push((t, rhs.0));
                        }
                        _ => continue 'cand,
                    }
                }
                _ => continue 'cand,
            }
        }
        if init.is_none() || temps.is_empty() {
            continue;
        }
        // the initial copy runs once, before everything else that names L: a
        // top-level instruction that precedes every other mention
        let init_pos = flat.iter().position(|i| matches!(i, Inst::Copy { dst, src } if dst.0 == l && Some(src.0) == init));
        let Some(init_pos) = init_pos else { continue };
        let top_level = f.body.iter().any(|i| std::ptr::eq(i, flat[init_pos]));
        if !top_level || flat[..init_pos].iter().any(|i| mentions(i, l) > 0) {
            continue;
        }
        let temp_set: BTreeSet<u32> = temps.iter().map(|(t, _)| *t).collect();
        // every use of L: an append's left operand, a length read, a return;
        // every use of a temporary: the copy back into L
        for i in &flat {
            let ml = mentions(i, l);
            if ml > 0 {
                let ok = match i {
                    Inst::Copy { dst, src } if dst.0 == l => const_str.contains(&src.0) || temp_set.contains(&src.0),
                    Inst::BinOp { dst, op, lhs, rhs } => {
                        op == "+" && lhs.0 == l && rhs.0 != l && temp_set.contains(&dst.0)
                    }
                    Inst::StringLen { src, dst } => src.0 == l && dst.0 != l,
                    Inst::Return { src: Some(src) } => src.0 == l,
                    _ => false,
                };
                if !ok || ml != 1 {
                    continue 'cand;
                }
            }
            for &t in &temp_set {
                let mt = mentions(i, t);
                if mt == 0 {
                    continue;
                }
                let ok = match i {
                    Inst::Copy { dst, src } => dst.0 == l && src.0 == t,
                    Inst::BinOp { dst, .. } => dst.0 == t,
                    _ => false,
                };
                if !ok || mt != 1 {
                    continue 'cand;
                }
            }
        }
        out.locals.insert(l);
        out.inits.insert(l, init.unwrap());
        for (t, e) in temps {
            out.temps.insert(t, (l, e));
        }
    }
    out
}
