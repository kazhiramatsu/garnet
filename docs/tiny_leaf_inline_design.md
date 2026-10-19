# Tiny leaf direct entries inlined (experiment, off by default)

## Problem

The checker is full of two-line accessors — `getObjectFlags` (`type.flags
& ObjectFlagsType ? type.objectFlags : 0`), `isFreshLiteralType`,
`getCheckFlags`, `getNodeId`, `isThisIdentifier`, `getTypeId` — called
from hundreds of sites. Each is a real C function with a lazy root frame,
and the profile of `native_s350x19` showed about 6% of its samples inside
such functions (`getObjectFlags` alone 56 of 2,959). V8's optimizing tier
inlines them at every call. Clang inlines a `static` function at `-O2`
only within its cost budget, and a function with two inline-cache probes
exceeds it, so these stayed calls.

## Design

With `TSAOT_TINY_INLINE=1`, a direct entry (`fn_X_d`) whose body is at
most twenty instructions of constants, copies, arithmetic, field and index
reads and writes, `if`s and returns — no call, no allocation, no loop, no
`try`, not a coroutine — is emitted with the existing `TS_AOT_INLINE`
storage (`static inline __attribute__((always_inline))`), prototype and
definition alike. Every direct call site absorbs the body; the generic
entry (the forwarder used by function values and dynamic calls) stays a
real function. Inline-cache statics inside the body remain one cache per
site of the callee's source, shared by all inlined copies.

## Result (Session 350)

3,089 of the compiler's functions qualified; the binary grew from 55.9 to
58.1 MB and the compiler ran 1.5% *slower* (6.160 → 6.253 s median wall,
all four run pairs agreeing): the instruction-cache cost of the copies
outweighs the calls saved. The knob stays off. A narrower rule — fewer
instructions, no inline-cache probes in the body, or a hotness cut from a
profile — is the follow-up if the accessors are revisited.
