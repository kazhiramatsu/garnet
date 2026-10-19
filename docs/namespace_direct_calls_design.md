# Direct calls to namespace member functions

## Data (Session 350, compiler IR of `native_s350w`)

Of the compiler's 48,869 call sites, 4,524 are calls through a function
value (`ts_call_value`) and 7,316 are dynamic method calls
(`ts_call_method` after a property lookup). The function-value calls
resolve, by static inspection of the IR, to a closure loaded from a capture
cell that is only ever stored one function:

| callee cell holds | sites |
|---|---:|
| `token` | 482 |
| `finishNode` | 214 |
| `getNodePos` | 176 |
| `parseExpected` | 144 |
| `nextToken` | 124 |
| `lookAhead`, `withJSDoc`, `parseErrorAtCurrentToken`, `parseOptional` | 51–59 each |

2,652 of the 4,524 sites are of this kind, none of the callees reads
`this`. The dynamic method calls are led by `Debug.assert` (439),
`Debug.checkDefined` (313) and `Debug.fail` (110), then the node factory's
`createIdentifier` (205), `createAssignment` (143) and the other
`create*`/`cloneNode` members.

## Cause

The exporter lowers a function declaration at the top level of a source
file as a known function (`funcSymbols`): calls to it are `Direct`, and a
callee's captured module cells are threaded as leading arguments
(`directCallCellArgs`). A function declaration inside a value namespace
(`namespace Parser { function token() { return currentToken; } ... }`) is
not registered: `lowerModuleDeclaration` boxes it with `lowerClosure`,
binds the symbol to that closure value (a capture cell when a sibling uses
it), and every call from a sibling member becomes a `LoadField` of the cell
followed by a `Value` call: two dispatch helpers (`ts_call_value`,
`ts_call`), the generic forwarder and its argument unpacking per call, for
the parser's most frequently called helpers. `Debug.assert(x)` is a property
access on the namespace object, resolved at run time through the inline
cache and `ts_call_method`.

## Design (exporter; `TSAOT_NAMESPACE_DIRECT=0` keeps the closure calls)

1. Registration: a function declaration with a body whose parent is the
   `ModuleBlock` of a value namespace joins `funcSymbols` (its id is already
   assigned) and a new set `namespaceFuncSymbols`.
2. Free-variable scan: a reference to such a symbol other than as the callee
   of a call captures it (as for `nestedFuncSymbols`), so a member used as a
   value (`lookAhead(nextTokenIsIdentifier)`) still reads the closure bound
   by `lowerModuleDeclaration`; a call does not capture it.
3. Calls `token()` lower as `Direct` through the existing top-level path:
   the callee's free variables are namespace-level bindings, which are
   module-scope symbols, so the transitive-capture prepass (`calledFns`)
   already makes the caller hold the cells and `directCallCellArgs` threads
   them.
4. `Debug.assert(x)`: a call whose callee is a property access on an
   identifier naming a value namespace, where the property resolves to a
   member in `namespaceFuncSymbols` that does not read `this`, lowers as the
   same `Direct` call (the namespace object is not touched; the member
   cannot be reassigned in checked TypeScript).
5. `lowerModuleDeclaration` is unchanged: the closure value still exists for
   the namespace object property and for value uses.

Generic members keep `specializeGenericCall`; members that read `this`,
`arguments`-dependent members and anything the registration does not match
keep the closure path. Fixture: `namespaces/direct_member_calls` (sibling
calls before and after the declaration, recursion between members, members
used as values and as callbacks, `N.f()` from outside, nested namespaces,
merged namespace declarations, a member reading a namespace `let` that a
sibling reassigns, exported and non-exported members, generic members).
