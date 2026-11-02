//! P2 — call graph construction and SCC condensation.
//!
//! Devirtualization happens in the TS exporter (it has the type checker); here
//! we only *consume* the resolved `CalleeRef` on each `Call`:
//!   * `Direct(f)` / `Set([..])` -> edges caller -> callee(s),
//!   * `Unknown`                 -> records that the caller has an opaque call.
//!
//! We then compute strongly connected components with an iterative Tarjan
//! (no native recursion, so deep/large call graphs are safe). Tarjan emits
//! SCCs in reverse-topological order of the condensation, which for a
//! caller -> callee edge is exactly **callees before callers** — the bottom-up
//! order P3 walks to build summaries. A multi-node SCC (or a self-edge) is a
//! recursion nest that P3 iterates to a fixpoint.

use std::collections::BTreeSet;

use crate::escape_ir::*;

pub struct CallGraph {
    /// Deduped callees per function, indexed by `FunctionId.0`.
    pub callees: Vec<Vec<FunctionId>>,
    /// Whether a function contains at least one `Unknown` call.
    pub has_unknown: Vec<bool>,
    /// Whether a function calls itself directly (size-1 SCC that is still cyclic).
    pub self_recursive: Vec<bool>,
    /// SCCs in bottom-up (callees-first) processing order.
    pub order: Vec<Vec<FunctionId>>,
}

impl CallGraph {
    /// True if this SCC must be iterated to a fixpoint (recursion / mutual recursion).
    pub fn is_cyclic(&self, scc: &[FunctionId]) -> bool {
        scc.len() > 1 || (scc.len() == 1 && self.self_recursive[scc[0].0 as usize])
    }
}

pub fn build_call_graph(program: &Program) -> CallGraph {
    // Function ids may be sparse (the exporter can reserve an id without emitting a
    // body, leaving a gap), so size the per-function vectors by max-id+1 rather than
    // by the function count — indexing by f.id.0 would otherwise go out of bounds.
    let n = program
        .functions
        .iter()
        .map(|f| f.id.0 as usize + 1)
        .max()
        .unwrap_or(0)
        .max(program.functions.len());
    let mut callees: Vec<Vec<FunctionId>> = vec![Vec::new(); n];
    let mut has_unknown = vec![false; n];
    let mut self_recursive = vec![false; n];

    for f in &program.functions {
        let i = f.id.0 as usize;
        let mut set: BTreeSet<u32> = BTreeSet::new();
        let mut stack: Vec<&Inst> = f.body.iter().collect();
        while let Some(inst) = stack.pop() {
            if let Inst::Call { callee, .. } = inst {
                match callee {
                    CalleeRef::Direct { func } => {
                        set.insert(func.0);
                    }
                    CalleeRef::Set { funcs } => {
                        for g in funcs {
                            set.insert(g.0);
                        }
                    }
                    CalleeRef::Method { .. } => has_unknown[i] = true,
                    CalleeRef::Value { .. } => has_unknown[i] = true,
                    CalleeRef::Unknown => has_unknown[i] = true,
                }
            } else if let Inst::CallSpread { callee, .. } = inst {
                match callee {
                    CalleeRef::Direct { func } => {
                        set.insert(func.0);
                    }
                    CalleeRef::Set { funcs } => {
                        for g in funcs {
                            set.insert(g.0);
                        }
                    }
                    _ => has_unknown[i] = true,
                }
            } else if let Inst::AllocClosure { func, .. } = inst {
                set.insert(func.0);
            } else if let Inst::Loop {
                cond_body, body, ..
            } = inst
            {
                for x in cond_body.iter().chain(body.iter()) {
                    stack.push(x);
                }
            } else if let Inst::If {
                then_body,
                else_body,
                ..
            } = inst
            {
                for x in then_body.iter().chain(else_body.iter()) {
                    stack.push(x);
                }
            } else if let Inst::TryCatch {
                try_body,
                catch_body,
                finally_body,
                ..
            } = inst
            {
                for x in try_body
                    .iter()
                    .chain(catch_body.iter())
                    .chain(finally_body.iter())
                {
                    stack.push(x);
                }
            }
        }
        if set.contains(&(i as u32)) {
            self_recursive[i] = true;
        }
        callees[i] = set
            .into_iter()
            .filter(|&g| (g as usize) < n) // guard: Direct/Set must be in-unit
            .map(FunctionId)
            .collect();
    }

    let order = tarjan_scc(&callees);
    CallGraph {
        callees,
        has_unknown,
        self_recursive,
        order,
    }
}

/// Iterative Tarjan. Returns SCCs in reverse-topological (bottom-up) order.
fn tarjan_scc(adj: &[Vec<FunctionId>]) -> Vec<Vec<FunctionId>> {
    let n = adj.len();
    let mut index: Vec<Option<usize>> = vec![None; n];
    let mut lowlink: Vec<usize> = vec![0; n];
    let mut on_stack: Vec<bool> = vec![false; n];
    let mut next_child: Vec<usize> = vec![0; n];
    let mut tstack: Vec<usize> = Vec::new(); // Tarjan stack
    let mut sccs: Vec<Vec<FunctionId>> = Vec::new();
    let mut counter = 0usize;

    for s in 0..n {
        if index[s].is_some() {
            continue;
        }
        let mut dfs: Vec<usize> = vec![s];
        while let Some(&v) = dfs.last() {
            if index[v].is_none() {
                index[v] = Some(counter);
                lowlink[v] = counter;
                counter += 1;
                tstack.push(v);
                on_stack[v] = true;
            }

            let mut recursed = false;
            while next_child[v] < adj[v].len() {
                let w = adj[v][next_child[v]].0 as usize;
                next_child[v] += 1;
                if index[w].is_none() {
                    dfs.push(w);
                    recursed = true;
                    break;
                } else if on_stack[w] {
                    lowlink[v] = lowlink[v].min(index[w].unwrap());
                }
            }
            if recursed {
                continue;
            }

            // v fully explored: if it is an SCC root, pop the component.
            if lowlink[v] == index[v].unwrap() {
                let mut comp = Vec::new();
                loop {
                    let x = tstack.pop().unwrap();
                    on_stack[x] = false;
                    comp.push(FunctionId(x as u32));
                    if x == v {
                        break;
                    }
                }
                sccs.push(comp);
            }
            dfs.pop();
            if let Some(&p) = dfs.last() {
                lowlink[p] = lowlink[p].min(lowlink[v]);
            }
        }
    }
    sccs
}

/// Functions that cannot return without calling back into their own recursion. V8 overflows its stack on one and
/// throws a RangeError a program can catch; the C compiler would turn it into a loop, which has no stack to overflow
/// and spins (docs/exceptions_design.md). Only these lose their tail calls: a recursion with a way out wants the loop
/// (`fib`'s second call), and one whose exit is never taken still spins.
pub fn recursion_without_exit(program: &Program) -> std::collections::HashSet<u32> {
    fn leaves(body: &[Inst]) -> bool {
        body.iter().any(|i| match i {
            Inst::Return { .. } | Inst::Throw { .. } => true,
            Inst::If { then_body, else_body, .. } => leaves(then_body) || leaves(else_body),
            Inst::Loop { cond_body, body, .. } => leaves(cond_body) || leaves(body),
            Inst::TryCatch { try_body, catch_body, finally_body, .. } => {
                leaves(try_body) || leaves(catch_body) || leaves(finally_body)
            }
            _ => false,
        })
    }
    /// What every path through `body` calls directly before it leaves the function, `after` being what the code
    /// that follows calls. A loop and a `try` promise nothing, and end the walk when they can leave.
    fn must_call(body: &[Inst], after: BTreeSet<u32>) -> BTreeSet<u32> {
        let mut cur = after;
        for inst in body.iter().rev() {
            match inst {
                Inst::Return { .. } | Inst::Throw { .. } | Inst::Break { .. } | Inst::Continue { .. } => cur.clear(),
                Inst::Call { callee: CalleeRef::Direct { func }, .. } => {
                    cur.insert(func.0);
                }
                Inst::If { then_body, else_body, .. } => {
                    let a = must_call(then_body, cur.clone());
                    let b = must_call(else_body, cur);
                    cur = a.intersection(&b).copied().collect();
                }
                Inst::Loop { .. } | Inst::TryCatch { .. } => {
                    if leaves(std::slice::from_ref(inst)) {
                        cur.clear();
                    }
                }
                _ => {}
            }
        }
        cur
    }
    let mut out = std::collections::HashSet::new();
    let by_id: std::collections::HashMap<u32, &Function> = program.functions.iter().map(|f| (f.id.0, f)).collect();
    let graph = build_call_graph(program);
    for scc in graph.order.iter().filter(|scc| graph.is_cyclic(scc)) {
        let mut live: BTreeSet<u32> = scc
            .iter()
            .map(|f| f.0)
            .filter(|id| by_id.get(id).is_some_and(|f| !f.is_async && !f.is_generator))
            .collect();
        let edges: Vec<(u32, BTreeSet<u32>)> =
            live.iter().map(|&id| (id, must_call(&by_id[&id].body, BTreeSet::new()))).collect();
        // what remains has an edge into what remains: no walk along these edges ever ends
        loop {
            let before = live.len();
            let kept: BTreeSet<u32> = edges
                .iter()
                .filter(|(id, to)| live.contains(id) && to.iter().any(|t| live.contains(t)))
                .map(|(id, _)| *id)
                .collect();
            live = kept;
            if live.len() == before {
                break;
            }
        }
        out.extend(live);
    }
    out
}
