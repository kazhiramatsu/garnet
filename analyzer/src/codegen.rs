//! P6 codegen integration — turn per-site escape verdicts into allocation
//! strategies that a backend (which holds the real AST/CFG) reads off as
//! annotations. This module does NOT emit code from the analysis IR (that IR
//! is flow-insensitive and lossy); it computes the decision the backend needs.
//!
//!   strategy(site) =
//!     NoEscape     → (determinable ∧ Once) ? Stack(scalar-replaceable)
//!                                           : FrameArena   // freed at return
//!     ArgEscape    → CallerArena            // caller-provided storage, else heap
//!     GlobalEscape → Heap
//!
//! NoEscape alone already licenses a frame-local arena (sound: no reference
//! survives the frame). Layout-determinability ∧ multiplicity=Once promote the
//! best tier (a single stack slot, or full scalar replacement). Multiplicity is
//! required because NoEscape means "does not leave the frame", NOT "does not
//! leave the loop iteration": reusing one slot across coexisting loop instances
//! would be unsound, so loop (`Many`) sites stay in the arena.

use serde::Serialize;
use std::collections::BTreeMap;

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
}

impl AllocStrategy {
    pub fn as_str(self) -> &'static str {
        match self {
            AllocStrategy::Stack => "stack",
            AllocStrategy::FrameArena => "frameArena",
            AllocStrategy::CallerArena => "callerArena",
            AllocStrategy::Heap => "heap",
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
pub fn decide(program: &Program, result: &EscapeResult) -> Vec<SiteDecision> {
    let meta: BTreeMap<u32, &SiteMeta> = program.site_meta.iter().map(|m| (m.site.0, m)).collect();

    result
        .sites
        .iter()
        .map(|se| {
            let m = meta.get(&se.site.0);
            let determinable = m.map(|m| m.layout_determinable).unwrap_or(false);
            let once = matches!(m.map(|m| m.multiplicity), Some(Multiplicity::Once));

            let contained = result.contained_sites.contains(&se.site.0);
            let (strategy, reason) = match se.state {
                EscapeState::NoEscape => {
                    if determinable && (once || !contained) {
                        // NoEscape + determinable -> stack. For loop-body sites
                        // (multiplicity Many) the C local is emitted inside the
                        // loop scope — sound ONLY if no reference outlives the
                        // iteration. A NoEscape value stored into a container
                        // (contained) can be retained across iterations while
                        // the C slot is reused, so those must not go to stack
                        // (s316 silent-miscompile: arr.push(new C()) collapsed
                        // every element onto one reused stack cell).
                        (AllocStrategy::Stack, if once {
                            "no-escape + determinable + single-shot: stack slot / scalar-replace"
                        } else {
                            "no-escape + determinable, loop-body, uncontained: per-iteration stack slot"
                        })
                    } else if determinable {
                        (AllocStrategy::FrameArena, "no-escape but loop-contained: value may outlive the iteration")
                    } else if !once {
                        (AllocStrategy::FrameArena, "no-escape but layout not determinable, loop: frame arena")
                    } else {
                        (AllocStrategy::FrameArena, "no-escape but layout not determinable: frame arena")
                    }
                }
                EscapeState::ArgEscape => {
                    (AllocStrategy::CallerArena, "escapes via args/return only: caller-provided storage, else heap")
                }
                EscapeState::GlobalEscape => {
                    (AllocStrategy::Heap, "escapes to a global/heap root: heap")
                }
            };
            SiteDecision { site: se.site, state: se.state, strategy, reason }
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
