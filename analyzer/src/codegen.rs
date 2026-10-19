//! P6 codegen integration — turn per-site escape verdicts into allocation
//! strategies that a backend (which holds the real AST/CFG) reads off as
//! annotations. This module does NOT emit code from the analysis IR (that IR
//! is flow-insensitive and lossy); it computes the decision the backend needs.
//!
//!   strategy(site) =
//!     NoEscape     → (determinable ∧ Once) ? Stack(scalar-replaceable)
//!                                           : FrameArena   // freed at return
//!     ArgEscape    → CallerArena            // caller-provided storage, else heap
//!     retained     → PretenuredHeap          // skips nursery evacuation
//!     GlobalEscape → Heap                    // unless retained above
//!
//! NoEscape alone already licenses a frame-local arena (sound: no reference
//! survives the frame). Layout-determinability ∧ multiplicity=Once promote the
//! best tier (a single stack slot, or full scalar replacement). Multiplicity is
//! required because NoEscape means "does not leave the frame", NOT "does not
//! leave the loop iteration": reusing one slot across coexisting loop instances
//! would be unsound, so loop (`Many`) sites stay in the arena.

use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

use crate::escape_ir::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AllocStrategy {
    /// Single stack slot, scalar-replaceable. No allocation at runtime.
    Stack,
    /// Per-call bump region, bulk-freed on return.
    FrameArena,
    /// Storage provided by the caller (or heap if the caller can't prove it).
    CallerArena,
    /// General heap (GC / malloc).
    Heap,
    /// Old-generation heap. Reserved for escape/lifetime-proven retained
    /// allocations: single-shot module roots and structural loop accumulators.
    PretenuredHeap,
}

impl AllocStrategy {
    pub fn as_str(self) -> &'static str {
        match self {
            AllocStrategy::Stack => "stack",
            AllocStrategy::FrameArena => "frameArena",
            AllocStrategy::CallerArena => "callerArena",
            AllocStrategy::Heap => "heap",
            AllocStrategy::PretenuredHeap => "pretenuredHeap",
        }
    }
}

#[derive(Debug, Clone)]
pub struct SiteDecision {
    pub site: SiteId,
    pub state: EscapeState,
    pub strategy: AllocStrategy,
    pub reason: &'static str,
}

/// Decide a strategy for every site in the escape result, using per-site
/// codegen metadata when available. Missing metadata is treated conservatively
/// (Many + not-determinable ⇒ at best a frame arena), which stays sound.
fn pretenure_enabled() -> bool {
    !matches!(
        std::env::var("TSAOT_PRETENURE").as_deref(),
        Ok("0") | Ok("false") | Ok("no") | Ok("off")
    )
}

pub fn decide(program: &Program, result: &EscapeResult) -> Vec<SiteDecision> {
    decide_with_pretenure(program, result, pretenure_enabled())
}

pub fn decide_with_pretenure(
    program: &Program,
    result: &EscapeResult,
    enable_pretenure: bool,
) -> Vec<SiteDecision> {
    let meta: BTreeMap<u32, &SiteMeta> = program.site_meta.iter().map(|m| (m.site.0, m)).collect();
    // Sites whose allocation carries a class id (typed cells). Plain-object
    // cells never honor a stack/arena decision, so only typed cells need the
    // heap rule below; this also keeps the legacy emission byte-identical.
    let mut classed_sites: BTreeSet<u32> = BTreeSet::new();
    fn collect_classed(body: &[Inst], out: &mut BTreeSet<u32>) {
        for inst in body {
            match inst {
                Inst::AllocObject { site, class_id: Some(_), .. } => {
                    out.insert(site.0);
                }
                Inst::Loop { cond_body, body, .. } => {
                    collect_classed(cond_body, out);
                    collect_classed(body, out);
                }
                Inst::If { then_body, else_body, .. } => {
                    collect_classed(then_body, out);
                    collect_classed(else_body, out);
                }
                Inst::TryCatch { try_body, catch_body, finally_body, .. } => {
                    collect_classed(try_body, out);
                    collect_classed(catch_body, out);
                    collect_classed(finally_body, out);
                }
                _ => {}
            }
        }
    }
    for f in &program.functions {
        collect_classed(&f.body, &mut classed_sites);
    }

    result
        .sites
        .iter()
        .map(|se| {
            let m = meta.get(&se.site.0);
            let determinable = m.map(|m| m.layout_determinable).unwrap_or(false);
            let once = matches!(m.map(|m| m.multiplicity), Some(Multiplicity::Once));

            let contained = result.contained_sites.contains(&se.site.0);
            let pretenured =
                enable_pretenure && result.pretenure_sites.contains(&se.site.0);
            let is_cell = matches!(m.map(|m| m.kind), Some(AllocKind::Cell))
                && classed_sites.contains(&se.site.0);
            let (strategy, reason) = if pretenured {
                (
                    AllocStrategy::PretenuredHeap,
                    "escape/lifetime analysis: retained allocation bypasses the nursery",
                )
            } else if is_cell {
                // A captured-variable cell is shared with every closure that
                // captures it, and those closures may outlive this frame through
                // paths the per-frame analysis does not bound (containers loaded
                // from other cells, callbacks). Typed cells are class instances
                // that WOULD honor a stack/arena decision, so keep them on the
                // heap, which is what plain-object cells always did.
                (
                    AllocStrategy::Heap,
                    "captured-variable cell: shared with closures, heap",
                )
            } else {
                match se.state {
                    EscapeState::NoEscape => {
                        if determinable && (once || (loop_stack_sites_enabled() && !contained)) {
                            // NoEscape + determinable -> stack. A loop-body site
                            // (multiplicity Many) reuses one C slot per iteration,
                            // which is sound ONLY if no reference outlives the
                            // iteration; the analysis bounds containers (s316:
                            // arr.push(new C()) collapsed every element onto one
                            // reused stack cell) but not a local declared outside
                            // the loop (`let a; for (...) { const o = new C(); if
                            // (...) a = o; }` read `a` after the loop, Session 350),
                            // so loop-body sites now take the frame arena unless
                            // TSAOT_LOOP_STACK=1 restores the per-iteration slot
                            // (parity oracle only).
                            (
                                AllocStrategy::Stack,
                                if once {
                                    "no-escape + determinable + single-shot: stack slot / scalar-replace"
                                } else {
                                    "no-escape + determinable, loop-body, uncontained: per-iteration stack slot"
                                },
                            )
                        } else if determinable {
                            (
                                AllocStrategy::FrameArena,
                                "no-escape but loop-contained: value may outlive the iteration",
                            )
                        } else if !once {
                            (
                                AllocStrategy::FrameArena,
                                "no-escape but layout not determinable, loop: frame arena",
                            )
                        } else {
                            (
                                AllocStrategy::FrameArena,
                                "no-escape but layout not determinable: frame arena",
                            )
                        }
                    }
                    EscapeState::ArgEscape => (
                        AllocStrategy::CallerArena,
                        "escapes via args/return only: caller-provided storage, else heap",
                    ),
                    EscapeState::GlobalEscape => (
                        AllocStrategy::Heap,
                        "escapes to a global/heap root: heap",
                    ),
                }
            };
            SiteDecision {
                site: se.site,
                state: se.state,
                strategy,
                reason,
            }
        })
        .collect()
}

// ----------------------------- JSON report -----------------------------------

#[derive(Serialize)]
pub struct DecisionDto {
    pub site: u32,
    pub state: String,
    pub strategy: String,
    pub reason: String,
}

#[derive(Serialize, Default)]
pub struct Stats {
    pub stack: usize,
    pub frame_arena: usize,
    pub caller_arena: usize,
    pub heap: usize,
    pub pretenured_heap: usize,
}

#[derive(Serialize)]
pub struct DecisionReport {
    pub version: u32,
    pub sites: Vec<DecisionDto>,
    pub stats: Stats,
}

fn state_str(s: EscapeState) -> &'static str {
    match s {
        EscapeState::NoEscape => "noEscape",
        EscapeState::ArgEscape => "argEscape",
        EscapeState::GlobalEscape => "globalEscape",
    }
}

pub fn report(program: &Program, result: &EscapeResult) -> DecisionReport {
    let decisions = decide(program, result);
    let mut stats = Stats::default();
    let mut sites = Vec::new();
    for d in &decisions {
        match d.strategy {
            AllocStrategy::Stack => stats.stack += 1,
            AllocStrategy::FrameArena => stats.frame_arena += 1,
            AllocStrategy::CallerArena => stats.caller_arena += 1,
            AllocStrategy::Heap => stats.heap += 1,
            AllocStrategy::PretenuredHeap => stats.pretenured_heap += 1,
        }
        sites.push(DecisionDto {
            site: d.site.0,
            state: state_str(d.state).to_string(),
            strategy: d.strategy.as_str().to_string(),
            reason: d.reason.to_string(),
        });
    }
    DecisionReport {
        version: SCHEMA_VERSION,
        sites,
        stats,
    }
}

/// `TSAOT_LOOP_STACK=1`: the legacy per-iteration stack slot for a
/// non-escaping loop-body allocation (unsound when a reference outlives the
/// iteration; kept for the parity oracle).
fn loop_stack_sites_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        matches!(
            std::env::var("TSAOT_LOOP_STACK").as_deref(),
            Ok("1") | Ok("true") | Ok("yes") | Ok("on")
        )
    })
}
