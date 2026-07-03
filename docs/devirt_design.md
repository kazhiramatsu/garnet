# Devirtualization pass — IR integration

Runs **before** escape analysis and rewrites method calls so the analyzer needs
no changes.

## IR additions (additive, back-compatible)
- `CalleeRef::Method { recvClass, method, recvStable }` — a method call as emitted
  by the exporter, not yet resolved.
- `Program.classes: Vec<ClassDef>` (`#[serde(default)]`) — the hierarchy from
  class_extract.ts: `{ id, parent, ownMethods[{name,func,kind}], ownFields,
  instantiated, stable }`.
- `ClassId`, `Name` id-newtypes; `MethodKind` = method | getter | setter.

## What the pass does (`devirt.rs::run_devirt`)
For each `CalleeRef::Method` it computes a `Dispatch` over the closed-world,
RTA-restricted subtree and **rewrites the callee in place**:
| Dispatch | callee rewrite | codegen emits |
|---|---|---|
| Direct(f)        | `Direct{func:f}`        | direct, inlinable call |
| Virtual{slot}    | `Set{funcs}` (or Direct if 1) | `obj->vt[slot](obj,..)` |
| Dynamic          | `Unknown`               | runtime prototype/IC lookup |

It returns `Vec<SiteDispatch>` (function id + instruction index + Dispatch) for
codegen. After the pass, no `Method` remains; the escape analyzer consumes the
familiar `Direct/Set/Unknown` exactly as before (a conservative `Method` arm was
added to call_graph/interproc only as a safety net).

## Soundness guards (mirror class_extract.ts)
`recvStable=false` (receiver via `any`/cast), unstable receiver class, or any
unstable candidate in the subtree ⇒ Dynamic ⇒ `Unknown`. RTA restricts candidates
to instantiated classes, collapsing polymorphic-looking calls to Direct when only
one subtype is ever constructed.

## Pipeline order
```
exporter (Method calls + classes table)
  -> devirt::run_devirt  (Method -> Direct/Set/Unknown ; emit SiteDispatch)
  -> call_graph::build_call_graph
  -> interproc::analyze_program  (unchanged)
  -> codegen::report + SiteDispatch  (stack/arena/heap + direct/vtable/dynamic)
```

## Status
13 integration scenarios pass (`devirt_tests.rs`): devirt decisions (poly/mono/
RTA/guards), in-place rewrite to `Set`, per-site `Virtual` dispatch, and escape
analysis running unchanged on the rewritten program with correct per-frame
verdicts. Remaining: exporter emission of `CalleeRef::Method` + the `classes`
table from class_extract.ts, then codegen consuming SiteDispatch.
