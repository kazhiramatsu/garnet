# finally-through-unwind — design (completion-record dispatch)

## Model: ECMAScript Completion Records
Every statement completes with a record { type, value, target }:
  type ∈ { normal, return, break, continue, throw }
finally semantics (spec): run the try/catch completion C; execute finally F; if F
completes abruptly, that wins; else continue C.

We already implemented the (normal|throw) subset for coroutine finally
(fin_pending/fin_exc). This generalizes pending to all 5 types and reuses the
existing emit logic for each dispatch target.

## Where the info comes from (analysis)
The FLATTENER is the right place: it processes try/finally structurally AND
maintains the loop stack `loops: Vec<(top_label, end_label)>`. So when a
break/continue appears inside a finally-protected region, the flattener already
knows the exact target labels. No separate dataflow pass is needed for targets —
the structural walk carries the context.

What we DO add as analysis:
- `body_exits_abruptly(body)`: does a try/catch body contain return/break/
  continue that escapes the block? (drives whether to use the heavy lowering)
- The flattener tracks, per active finally, the set of loop labels that are
  "inside" vs "outside" the finally, so a break targeting an outer loop is routed
  through the finally, while a break to a loop inside the try is a plain goto.

## Flat lowering (unified, coroutine and non-coroutine)
A try/catch/finally where the protected region may complete abruptly:
```
FinallyEnterTry(Lfc)              # handler captures throw
<try, but return/break/continue -> FinallyGoto(kind,val,target)>
FinallyGotoNormal(Lf)             # normal fall-through
[catch] CatchLabel ; <catch ...> ; FinallyGotoNormal(Lf)
FinallyCatchLabel(Lfc,Lf)         # throw landed -> pending=throw
Lf: <finally body>                # may itself contain abrupt completions
FinallyDispatch(after)            # act on pending:
    normal   -> goto after
    throw    -> re-throw (existing)
    return   -> existing Ret emit (C return / promise_resolve / gen done)
    break    -> goto pending_target_end
    continue -> goto pending_target_top
```
The pending record is stored per-finally in the frame (coroutine) or in C locals
(non-coroutine). For non-coroutine functions we introduce a parallel structured
emitter that uses C locals `_pend_kind`, `_pend_val`, `_pend_tgt`.

### Nested finally
Each finally pops its own pending. If a finally body itself completes normally but
the saved pending is e.g. return, the FinallyDispatch must propagate that to the
NEXT outer finally (if the return is still escaping it) or execute it. We model
this by: when dispatching a non-normal pending and there is an enclosing finally,
re-issue it as a FinallyGoto to the outer finally; else execute it directly.

## Staged plan
1. Non-coroutine functions: implement the structured completion-record finally
   (no suspensions). Verify return/break/continue/throw through finally, nested.
2. Coroutine functions: extend the existing fin_pending (currently normal|throw)
   to the full 5-type record; reuse the same dispatch.

## break/continue target across finally
Break/Continue in the IR carry no target (innermost loop). To route across a
finally to an OUTER loop, the flattener resolves the target from its loop stack
at the point of the break: if the target loop's (top,end) labels were pushed
BEFORE the current finally's protected region began, the break must go through the
finally (pending=break, target=that end label). If the loop is inside the try,
it's a plain goto (no finally crossing). The flattener records the loop-stack
depth at each FinallyEnterTry to make this distinction.
