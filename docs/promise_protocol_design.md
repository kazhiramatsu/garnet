# Promise's protocol

Session 363. Library (`lib/node/web/promise_protocol.ts`), runtime host, exporter.

The runtime's `Promise.all`, `then` and the rest are direct: they build their result with the native constructor and their
reactions with the native `then`, which is what the specification's steps come to for an unmodified `Promise`. They differ
where a program can tell: a subclass (`P.all` makes a `P`, its `then` a `P`), a `then` or a `resolve` replaced, `Promise.all.call(C, ...)`.

As for the RegExp protocol, a program that can tell compiles the specification in TypeScript. The trigger is its text:
`extends Promise`, `Promise.x.call`, an assignment to `then` or `Promise.resolve`, the string `"then"`, `Promise.try`. In such a
program `Promise.x(...)` and `p.then(...)` are dynamic calls, and those read the library's functions from the global object
and the prototype. `host.replaceMethod` takes both keys of the prototype's methods.

`combine` is the combinators' common part: GetPromiseResolve and GetIterator, whose failures reject; a throw from the loop
closes the iterator unless it was the iterator's own, and rejects. A reaction of a promise of another constructor goes
through `reaction`, which settles that constructor's capability. `await` and the async functions stay native.
