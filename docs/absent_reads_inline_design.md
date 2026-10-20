# Absent property reads in line (proposal)

## Measurement

Kernel `links_objects` (3.2x Node, the worst pattern after the probe
tables): 32% of its samples are in `ts_get_pic_checked`, nearly all of them
reads of a property the receiver does not have (`l.count === undefined`,
`l.target`; tsc's `SymbolLinks` pattern). The compiler reads absent
properties about 5.4M times per compile (`absent_cache_hits`), so the
compile itself gains little; the kernel gains up to a third.

An absent read today: the inline probes miss, the out-of-line
`ts_get_pic_checked` tests null / undefined, counts, hashes (site, receiver
shape) into the global absent table (`g_prop_absent_cache`), compares the
entry's site, shape, key and epoch, then walks the current prototype chain
(at most three links) comparing each link's shape with the snapshot, and
tests the chain's end.

## Options

A. Per-key "defined on some prototype" bits, so that a receiver shape
   without the key proves absence. Every way an object becomes a prototype
   (some sixty link sites in the runtime and the emitted class setup, lazy
   function prototypes, `Object.create`, `setPrototypeOf`, proxies) would
   have to keep the invariant; one missed site is a silent wrong value.
   Rejected.

B. The same check in line, per site: an absent record in the site's cache
   (receiver shape, epoch, depth, up to three prototype shapes), filled by
   the out-of-line path where it fills the global table today. After the
   present-property probes miss, the inline path compares the receiver's
   shape and the epoch, walks `depth` links comparing shapes, tests the end
   and yields `undefined`. Same validation as the table, minus the call, the
   prologue and the hashing; one record per site (about 32 bytes, 49k
   sites: +1.5 MB of static data, which the measurements must weigh).

C. Prototype validity cells (V8's design): a prototype object owns a cell
   invalidated when its own keys or its chain change; an absent entry keeps
   the receiver shape and the direct prototype's cell, an O(1) test. The
   larger change; for later if B leaves the kernel far behind.

## Plan

B, gated by a knob, with a fixture that mutates prototypes between absent
reads at the same sites (a key added to the prototype, a relinked
prototype, an accessor defined on the chain, a proxy in the chain, a
dictionary prototype), run under GC stress. Measure `links_objects` and the
compiler A/B; keep it only if the compiler does not lose.
