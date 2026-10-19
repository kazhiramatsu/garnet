# Guarded direct calls for methods that are one known closure

## Data (Session 350, compiler IR of `native_s350x3`)

After the namespace slice the compiler still makes 6,180 dynamic method
calls (`ts_call_method` after an inline-cache lookup of the member). For
3,879 of them the member's key is stored, anywhere in the program, exactly
one closure function: the node factory's members (`createIdentifier` 205
sites, `createExpressionStatement` 112, `createStringLiteral` 103,
`createNodeArray` 91, `cloneNode` 90, `createCallExpression` 88,
`createBlock` 87, `createVariableDeclaration` 72, ...), the emitter's
writer and host members. `createNodeFactory` declares the members as nested
functions and returns them in one object literal; the parser and the
checker each hold an instance (different environments, the same code).
91 of the 3,879 callees read `this`.

## Design (emitter; `TSAOT_KNOWN_METHOD=0` keeps the dynamic call)

**Program pass.** For every field key, the set of values stored under it
by `StoreField` (object literal layouts included): a single-definition
`AllocClosure` local contributes its function, anything else poisons the
key. Keys with exactly one function `K` are the candidates. The analysis is
a guess, not a proof — a dynamic store, `Object.assign` or a `Proxy` can
install something else under the key — so the call site keeps a guard.

**Call site.** A dynamic method call (`CalleeRef::Method` with the dynamic
receiver class, `method_field` a candidate key with function `K` that has
a direct entry) emits, after the own-property lookup it already performs:

```c
if (ts_is_func(_mv) && ((ts_func*)ts_ptr(_mv))->code == (void*)fn_K) {
  ts_func* _kf = (ts_func*)ts_ptr(_mv);
  r = fn_K_d(_kf->env[0], ..., _kf->env[ncap-1], [recv,] args...);
} else {
  /* prototype lookup, callable check, ts_call_method as before */
}
```

The closure's `code` is the generic entry `fn_K`, so the compare is exact:
a bound function, a builtin, a different closure of the same name or an
accessor result all fail it and take the dynamic path. The environment
array holds the captured cells in capture order, which is the direct
entry's leading parameter list (the generic forwarder reads the same
cells from `g_ts_cur_env`). `recv` is passed as the `this` parameter only
when `K` reads `this`; otherwise it is dropped, as `ts_call_method` does
for a callee without a `this` slot. Missing arguments are padded and extra
ones dropped by the direct-entry convention. Proxies: `ts_is_func` is false
for a proxy value, so the guard fails and `ts_call_method` handles it.

**Expected effect.** On the hit path the call skips the prototype lookup
branch, the callable check, `ts_call_method` (proxy test, callable test,
`this` adjustment), `ts_call` (environment dispatch) and the generic
forwarder with its argument unpacking, and clang may inline small members.
The miss path costs one load and one compare more than today.

Fixture `object_methods/known_method_guard`: an object literal of nested
functions called through two instances with different environments, a
member reading `this`, the same key installed on another object as a
different closure, a bound function and a builtin under a candidate key,
`Object.assign` replacing a member after the first call, a `Proxy` whose
get trap returns a different function, accessor properties, a missing
member (TypeError text), call/apply on the member, and arity mismatches.
