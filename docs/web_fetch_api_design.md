# The Web standard objects: Headers, Request, Response, FormData, fetch, DataView, String objects

Session 358. Kaz's direction: hono should run on garnet as it is, and the policy is to implement the
Web standards rather than port hono (「Web標準を全て実装する方針」). A trial compile of a minimal hono
application against hono's own sources left 20 unsupported constructs, all of them missing Web
objects: `new Request`, `new Response`, `Headers.forEach` / `getSetCookie`, `DataView`, and
`new String` (hono's `HtmlEscapedString`). hono's core (hono-base, context, request, compose, the
routers) otherwise compiles typed.

## Where they live

TypeScript compiled with the program, as the Node modules are (docs/node_compat_design.md):

| global | file | notes |
|---|---|---|
| `Headers`, `Request`, `Response`, `FormData`, `fetch` | `lib/node/web/fetch.ts` | the Fetch standard's objects over the runtime's transport |
| `DataView` | `lib/node/web/dataview.ts` | over a `Uint8Array` view; the floats through a shared buffer |
| `new String(v)` | `lib/node/web/string_object.ts` | `StringObject`, chained to `String.prototype` |

The Node prelude installs them on the global object when the program names them
(`NODE_PRELUDE_PARTS`), and `new Headers(...)` / `new Request(...)` / `new Response(...)` /
`new FormData(...)` / `new DataView(...)` construct through the global's value as `new URL(...)`
does (`NODE_PRELUDE_CTORS`). The identifier the program writes is lib.dom's ambient declaration:
a method call on a value typed `Headers` or `Response` takes the dynamic path to the class's method
(the site caches and the known-callee guards of Session 358 serve it). Under the V8 oracle the
globals are Node's own, so every conformance fixture is a differential test of these classes.

`new String(v)`: the exporter lowers the expression to a construction of the prelude's
`__garnet_StringObject` (the program names it when it contains `new String(`). The object's
prototype chain reaches `String.prototype`, so `instanceof String` holds, `typeof` is "object",
template literals and `+` take `toString` / `valueOf`, and properties can be added (hono marks the
escaped string with `isEscaped` and `callbacks`). Index access and the String methods through the
wrapper are not modelled (the common ones delegate).

## What was retired in the exporter

The simplified `Headers` of the fetch slice (docs/fetch_https_design.md: a plain object with
lowercase keys behind a runtime prototype, typed method calls lowered to `headers.*` builtins,
`new Headers` to `headers.new`, `Response.text()` / `json()` to `response.*`) is replaced by the
classes: the `headers` receiver kind, the `Headers` namespace and prototype-method tables, the
`for..of` over headers and the `new Headers` lowering are gone from the exporter. The runtime keeps
`ts_fetch` and the raw record it resolves (`status`, `ok`, `headers` as a plain object, `__body`);
the library's `fetch` wraps it: `lib/node/web/fetch.ts` declares `__garnet_fetch` globally, and the
exporter lowers a call of that name from a lib module to the `global.fetch` builtin (which also
raises the `TSAOT_NEEDS_FETCH` marker that links the libcurl runtime). A program's own `fetch(...)`
call goes to the prelude's function through the global object.

## Semantics (Node 25, undici)

- **Headers**: names are HTTP tokens (else TypeError), stored lowercase; values are stripped of
  leading and trailing HTTP whitespace and may not contain NUL, CR or LF (else TypeError);
  `append` joins with `", "` on `get`, `set-cookie` keeps its entries (`getSetCookie`); iteration
  (`entries`, `keys`, `values`, `forEach`, `[Symbol.iterator]`) is sorted by name with the values
  combined, `set-cookie` one entry per value; the init is a `Headers`, a sequence of pairs (a pair
  of another length is a TypeError) or a record; the guard `immutable` (a fetch response's
  headers, `Response.error()`) makes `append` / `set` / `delete` throw a TypeError; the object is
  not frozen (Node's is not).
- **Body** (Request and Response): a string (`content-type: text/plain;charset=UTF-8` when none
  is given), `URLSearchParams` (`application/x-www-form-urlencoded;charset=UTF-8`), `ArrayBuffer`
  or a view (bytes, no type), `FormData` (`multipart/form-data; boundary=...`), another object's
  `body` (the data moves), anything else through `String`; `null` / `undefined` is no body.
  `text`, `json`, `arrayBuffer`, `bytes`, `formData` (urlencoded and multipart text fields)
  consume it: `bodyUsed`, and a second read rejects with a TypeError ("Body is unusable: Body has
  already been read"); `clone` copies an unread body. `body` is `null` or an opaque stream
  placeholder that another Request or Response takes (`getReader` throws: streams are a later
  slice).
- **Request**: `input` a string or URL (parsed with the WHATWG URL class; a failure is a TypeError
  "Failed to parse URL from ..."), or a Request (copied; a used body is a TypeError); the method
  is a token, the standard six upper-cased; a GET or HEAD with a body is a TypeError; `headers`
  from the init or the input; `signal` (the runtime's AbortSignal; a fresh one when absent);
  `cache` `default`, `credentials` `same-origin`, `mode` `cors`, `redirect` `follow`, `referrer`
  `about:client`, `referrerPolicy` "", `integrity` "", `keepalive` false, `duplex` `half`,
  `destination` ""; `clone`.
- **Response**: `status` 200, an integer in 200..599 (else RangeError); `statusText` "" (a
  reason phrase, else TypeError); a body with a null-body status (204, 205, 304) is a TypeError;
  `ok`, `type` `default`, `url` "", `redirected` false; `Response.json(data, init)` (the
  `application/json` type unless given), `Response.redirect(url, status)` (301, 302, 303, 307 or
  308, else RangeError; `location` is the parsed URL), `Response.error()` (type `error`, status
  0, immutable headers); the init may be another Response (hono passes one).
- **fetch**: `fetch(input, init)` builds a Request, sends its method, headers and body (a string;
  a bytes body is decoded as UTF-8 for the transport) through `__garnet_fetch`, and returns a
  Response with the transport's status, its headers immutable, and the body as text. The
  `timeoutMs` extension of the fetch slice stays.
- **FormData**: text fields only (append, set, get, getAll, has, delete, iteration); no File.
- **DataView**: the constructor's RangeErrors ("Start offset N is outside the bounds of the
  buffer", "Invalid DataView length N"), `buffer` / `byteLength` / `byteOffset`, the Int8 to
  Float64 getters and setters with the endianness flag (the floats through a `Float64Array` and
  a `Float32Array` sharing a scratch buffer with a `Uint8Array`), an access past the end a
  RangeError ("Offset is outside the bounds of the DataView"); the BigInt accessors throw (no
  bigint). `ArrayBuffer.isView` does not know it (the runtime's views are the typed arrays).

## Verification

`tests/conformance/exhaustive/web/`: `headers`, `request`, `response`, `formdata`, `dataview`,
`string_object` (the V8 oracle is Node's own objects); the fetch gate `scripts/run_fetch_test.sh`
(compile and link, the live cases under `TSAOT_NET`) rewritten for the classes;
`benchmarks/real/hono_app/driver.ts`, a hono application driven through `app.fetch(new Request)`
over a request mix under both engines (`build/real/hono_app` is a link to the hono clone).

## Built (Session 358) and the deviations

- The six fixtures agree with Node in both profiles; the hono application driver
  (`benchmarks/real/hono_app`) runs its 17 request kinds with output identical to Node's.
- `Request.signal` is the init's signal itself; Node's is a fresh signal that follows it (an
  `AbortController` / `AbortSignal` in TypeScript is the later slice). A Request made from a
  Request shares the body as Node's pipe does: the source is locked and reports `bodyUsed` at once;
  a Response made from another's `body` locks the source until the new one is read.
- A class's private field (`#x`) was enumerable: `JSON.stringify`, `Object.keys`, `for..in`, the
  spread and the own-property names and descriptors listed it (a silent miscompile for every class
  with one: hono's have dozens). The runtime hides a field whose name begins with `#` from all of
  them (`class_field_is_private`); `hasOwnProperty("#x")` and `"#x" in o` still see it.
- `Object.keys` / `values` / `entries` of null or undefined, and a symbol-keyed read of null
  (`x[Symbol.iterator]`), returned an empty result where V8 throws a TypeError: they throw now.
- A method of a prelude class read as a value (`Headers.prototype.get.call({}, ...)`, hono does not)
  opened the program's receivers only for the program's own classes; the escape analysis now maps
  lib.dom's interface method to the library's class, so the borrowed call with a foreign `this` is
  a catchable TypeError, not the closed-receivers abort.
- `ArrayBuffer.isView(new DataView(b))` is false (the runtime's views are the typed arrays); a
  bytes body sent through `fetch` is decoded as UTF-8 for the transport, which takes a string.
- The fetch gate (`scripts/run_fetch_test.sh`) runs its programs as module programs now (they
  name the Web globals, which bring the prelude): they call `main()` themselves, a transport
  failure is a resolve failure (a bad URL is a parse error, as in Node), and a response's headers
  are not a frozen object.
- hono's dispatch is 2.3x slower than Node's on the driver's mix (338 ms against 148 for 20,000
  requests): the next slice's subject.

## Not in this slice

Streams (`ReadableStream`, `WritableStream`, `TransformStream`, a streaming body), `Blob` and
`File`, `AbortController` / `AbortSignal` as TypeScript classes with events (the runtime's
simplified ones stay), the JSX automatic runtime hono's JSX needs (the next slice), an HTTP server.
