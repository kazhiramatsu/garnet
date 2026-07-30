# Adaptive GC aging

## Goal

A fixed promotion threshold cannot serve every lifetime distribution:

- immediate promotion (`threshold=1`) pollutes old generation with values that
  survive only one minor collection;
- a one-minor grace (`threshold=2`) helps those values, but medium/long-lived
  cohorts are copied within the nursery and then promoted anyway;
- if survivor residency consumes the next cycle's nursery capacity, the extra
  copy can also cause a minor-collection storm.

Garnet therefore defaults to threshold 2 with bounded runtime feedback.
Escape-guided pretenuring handles statically proven long-lived sites; adaptive
aging handles the remaining unknown short/medium lifetime distribution.

## Capacity model

The nursery tracks two byte counts:

- `fresh_bytes`: bump allocations made since the previous minor;
- `survivor_bytes`: live cells copied into nursery to-space by that minor.

Adaptive mode triggers the next minor from `fresh_bytes`, not their sum.
Survivors therefore do not shorten the next allocation interval. To-space
copying remains capped at 50% of nursery capacity, giving a normal physical
bound of approximately 1.5 nurseries (plus one allocation/chunk of rounding
and separately retained pinned chunks).

`TSAOT_GC_AGING_ADAPTIVE=0` restores the former fixed policy: survivor and
fresh residency share the trigger, and the fixed threshold is applied without
feedback.

## Feedback policy

Young cells already store age in their `remembered` byte, so the policy needs
no larger GC header and no allocation-site ID. Runtime accounting distinguishes:

- `died_bytes`: cells given an aging grace that died while still young;
- `promoted_bytes`: cells given a grace that later promoted;
- `copied_bytes`: bytes copied to nursery to-space;
- `forced_bytes`: bytes promoted earlier than the configured fixed threshold.

Outcomes are accumulated over a window of at least half a nursery (and at
least 64 KiB for small configured nurseries). When 80% or more of the resolved
aged bytes promoted rather than died, the grace was ineffective. The collector
uses first-survival promotion for the next eight minor collections, then
retries aging. The outcome window is reset at each decision boundary.

Eight fallback minors provide hysteresis: a stable medium-lived phase does not
oscillate every collection, while a later short-lived phase is still sampled
again. Outcomes produced while fallback is active do not bias the retry.

## Remembered-set invariants

A fixed aging collection may promote a parent while leaving its child young.
The promotion barrier therefore remembers newly promoted cells whenever any
young survivor remains.

During adaptive fallback all ordinary marked young cells promote together.
If no to-space, unpooled, or pinned young survivor remains, the promotion
barrier walk is skipped. Old-to-young stores made during fallback receive one
minor of remembered-set scan credit instead of the configured threshold,
because their young pointees promote at the next minor.

Pinned young cells are the exception: if any remain, the promotion barrier is
still run so promoted parents can retain references to them.

## Runtime controls

- Default: `TSAOT_GC_AGE_THRESHOLD=2`, adaptive feedback enabled.
- `TSAOT_GC_AGE_THRESHOLD=1`: immediate first-survival promotion.
- `TSAOT_GC_AGING_ADAPTIVE=0`: fixed threshold and legacy shared-capacity
  behavior for diagnosis and A/B measurement.
- `TSAOT_GC_NURSERY_BYTES=N`: nursery and feedback-window scale.

Runtime-stat builds emit an `aging:` line containing copied, died, promoted,
forced, fallback-minor, activation, fresh-residency, and survivor-residency
counters.

## Measured boundary cases

On the development machine, best-of-run GC measurements were:

| Workload | Immediate (`1`) | Fixed (`2`) | Adaptive (`2`) |
|---|---:|---:|---:|
| `gc_survivors` wall | 90 ms | 104 ms | 92 ms |
| `gc_survivors` minor/full | 17 / 13 | 32 / 13 | 17 / 13 |
| `gc_binarytrees` wall | 70 ms | 66 ms | 64 ms |
| `gc_binarytrees` full | 6 | 1 | 2 |

The bounded ring-buffer workload still pays a small sampling cost relative to
immediate promotion, but the fixed-policy throughput cliff and doubled minor
count are removed. The short-lived tree workload retains the aging benefit and
does not enter fallback because most aged bytes die young.

`tests/gc_adaptive_aging_gate.sh` pins output identity, default activation,
fixed-policy comparison, reduced minor count, and the threshold-1 fallback.
The aging promotion-barrier gate remains separate so both policy and
generational correctness are exercised under O2 and ASan.
