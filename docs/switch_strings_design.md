# A switch on string literals, dispatched by hash (slice V, session 352)

Emitter and runtime. Knob `TSAOT_STR_SWITCH=0` keeps the comparison chain
(the parity oracle sets it).

## Finding

The exporter lowers a `switch` into a one-pass loop that tests the
discriminant against each case label in source order; for number labels the
emitter's switch plan (`switch_plan_for`) recognizes the chain and emits a C
`switch`, a jump table. For string labels nothing did, so a `switch` on a
string ran `ts_eq_strlit` once per label: the checker's
`getCannotFindNameDiagnosticForName`, a hundred string cases evaluated for
every entity name resolved (tsc passes the diagnostic to `resolveName`
eagerly), was 1.1% of the check phase in the tsc-ts profile, almost all of it
the comparisons; V8 compares internalized string pointers at a cycle each.

## Change

The switch plan has a second pass over string-literal chains: the
discriminant a boxed local, each label a literal of the static string table,
keyed by the literal's hash (`c_strhash_units`, the same FNV-1a the runtime's
`strhash_view` computes, so a heap string's cached hash and an immediate
string's computed hash agree with the label's). The emitted C:

```c
{ uint32_t _sh = ts_str_switch_hash(v, NONE); switch (_sh) {
  case 0x1234abcdu: { if (!(ts_eq_strlit(v, LIT_A, 8u) || ts_eq_strlit(v, LIT_B, 3u))) goto L_sw; ...; break; }
  ...
  default: L_sw: ; { ...; break; } } }
```

`ts_str_switch_hash` returns the string's hash (cached in a heap string after
its first use, computed for an immediate) or `NONE`, a value no case has, for
a discriminant that is not a string. A case verifies its literals by content
before running, so a different string with a label's hash and a non-string
discriminant reach the default, as the comparison chain did. Two different
labels with one hash across cases cannot share a C label: such a chain keeps
the comparisons. Within a case, labels of one hash are emitted once.

Fixture `control/switch_strings` (grouped labels, a default, immediate and
heap discriminants, strings built at run time, a two-byte label, non-string
discriminants, nested switches).
