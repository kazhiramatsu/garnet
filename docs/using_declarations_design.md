# `using` and `await using`

Session 363. Exporter (`exporter/using_rewrite.ts`), library (`lib/node/web/disposable.ts`).

## The rewrite

A source rewrite before the program is built, in the host that serves the files (`privateNameHost`). The checker and the
exporter never see the declaration:

    { A; using x = e, y = f; B }

becomes, on the same lines,

    { const s: any = __garnet_using_stack(); try { A; const x = use(e, s, 0), y = use(f, s, 0); B }
      catch (c) { s.failure.has = true; s.failure.error = c; } finally { __garnet_dispose(s); } }

- `const` of the initializer's type: `use` is a generic function appended to the file, so nothing about `x` is lost.
- The whole statement list moves into the try, not the part after the declaration: a function declared in it is
  hoisted within the list as before, and `A` sees it.
- The stack records what was registered, so a throw in `A` disposes nothing and a throw in `f` disposes `x`.
- `await using` makes the finally `await __garnet_dispose_async(s)`. A `for (using x of it)` has one stack per iteration, a
  `for (using x = e; ...)` one around the loop, a `switch` one around the statement.
- A module's `using` wraps the statements after the imports, so an `export` declaration after it is a syntax error of
  the rewritten text: loud.
- What the rewrite leaves alone (a binding pattern, no initializer, `for (using x in o)`) meets the exporter's reject.

## The library

The specification's `DisposeResources` in TypeScript: a list of `{ value, method, isAsync }`, disposed in reverse, an error that
meets an error wrapped in a `SuppressedError` around both. `DisposableStack`, `AsyncDisposableStack` and `SuppressedError` are
prelude globals, brought in by a program that names them or `Symbol.dispose`.

`await using x = null` registers an entry with no method, so that the scope exit awaits once.
