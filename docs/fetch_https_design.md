# fetch HTTPS transport (libcurl)

## Decision
fetch's HTTPS support uses libcurl as the transport rather than a hand-rolled
TLS stack or a directly-embedded TLS library (BearSSL / Mbed TLS / wolfSSL).

Rationale:
- Writing TLS from scratch is a non-starter: cert-chain verification, constant-
  time comparisons, padding-oracle defenses etc. are exactly where a subtle bug
  becomes a silent security break — the antithesis of "never silently miscompile".
- A directly-embedded TLS lib still pulls in cert stores, an HTTP/1.1 parser,
  redirect handling and transfer decoding. libcurl bundles ALL of that behind a
  tiny API, and delegates TLS to the platform (here OpenSSL). We write only a
  thin binding and never touch the TLS state machine.
- wolfSSL is GPL/commercial dual-licensed (a cost for a closed-source SaaS);
  libcurl is MIT-like and ubiquitous.

## Implementation
The async plumbing already existed and is transport-agnostic: fetch(url) returns
a pending Promise<Response> and posts an I/O task; ts_run_event_loop services the
task, then resolves the promise; await/microtasks resume the coroutine. The
transport "seam" was swapped from a raw-socket HTTP/1.1 GET (http only) to
libcurl, and the event loop now drives queued fetches through a shared curl
multi handle:

- curl_multi_add_handle / curl_multi_perform / curl_multi_poll let multiple
  pending fetch tasks progress in one event-loop pass instead of serial
  curl_easy_perform calls.
- Easy handles still set CURLOPT_FOLLOWLOCATION (redirects), CURLOPT_TIMEOUT_MS,
  CURLOPT_ACCEPT_ENCODING "" (gzip/br decode), CURLOPT_NOSIGNAL.
- TLS verification stays at libcurl defaults (verify peer + host). We never
  disable it.
- http:// and https:// are handled identically (libcurl picks the scheme).
- On a network/TLS/setup error the fetch Promise rejects with a tagged
  `{ name: "TypeError", message: "fetch failed: ..." }` object. HTTP status
  4xx/5xx still resolves to a Response; only transport/setup failure rejects.

Linking: the runtime now needs `-lcurl` in addition to `-lm`. Updated in
run_benchmarks.sh, run_golden_iter.sh, run_runtime_tests.sh, and run_fetch_test.sh.

## Testing
scripts/run_fetch_test.sh: by default compile+link only (CI/sandbox-safe,
network-independent) — proves the libcurl transport builds and links for both a
basic HTTPS fetch program (status, headers object, text body) and a POST/options
fetch program. With TSAOT_NET=1 it
performs a live HTTPS GET against an allowlisted host (api.github.com). With
TSAOT_FETCH_LOCAL=auto it runs the localhost POST echo test when bind is
available and skips it when bind is unavailable; TSAOT_FETCH_LOCAL=1 makes that
test mandatory. Wired into ci_fast in compile/link-only mode. Verified
end-to-end: `await fetch("https://api.github.com/zen")` returns a real status +
body via TLS; http:// still works
(archive.ubuntu.com -> 200); malformed URL / transport error rejects with a
TypeError-tagged object; ASan clean (libcurl resources freed via
curl_easy_cleanup).

## POST / headers / method (DONE)
fetch(url, options) now supports the Web-standard options object:
  { method?: string, body?: string, headers?: { [k: string]: string } }
- method: any verb (POST/PUT/PATCH/DELETE/...) via CURLOPT_CUSTOMREQUEST; default GET.
- body: a string, sent via CURLOPT_COPYPOSTFIELDS (libcurl sets Content-Length).
- headers: each own enumerable prop of options.headers becomes a "Key: Value"
  line (value coerced to string via ts_to_string_v), assembled into a curl_slist.
- timeoutMs: TSAOT extension, milliseconds, passed through to
  CURLOPT_TIMEOUT_MS. Non-positive/non-number values keep the existing 30000ms
  default. This remains as a TSAOT-specific escape hatch alongside
  `AbortSignal.timeout(ms)`.
- signal: a simplified AbortSignal. `fetch()` checks `signal.aborted`
  synchronously; if it is already true, the returned Promise rejects before a
  curl easy handle is queued. The I/O task also keeps the signal rooted and
  rechecks it before queued start and before active curl polling; an aborted
  active handle is removed from curl_multi and rejected. Signals created by
  `AbortSignal.timeout(ms)` also feed the fetch timeout; if that timeout wins,
  the Promise rejects with the signal's `TimeoutError` reason rather than a
  transport TypeError.
The options are read SYNCHRONOUSLY in ts_fetch and snapshotted into plain C
strings owned by the I/O task (the options object is live then; deferring the
read to the worker would risk GC/mutation). The worker frees them after the
request. The POST/options program is compiled and linked in the default fetch
gate; end-to-end localhost echo execution is opt-in with TSAOT_FETCH_LOCAL=auto
or TSAOT_FETCH_LOCAL=1 for environments that permit localhost bind. Verified
end-to-end against a local echo server: method, custom headers (incl.
Authorization, numeric values), and body are transmitted correctly; GET with no
options still works; ASan clean.

## Response headers (DONE)
Response objects now expose `headers` as a plain object:
  response.headers["content-type"]
Header names are lowercased ASCII names. Values are trimmed strings. Repeated
headers with the same name are joined with `", "`. Redirect/interim response
blocks clear the accumulated table when libcurl reports a new HTTP status line,
so the final Response keeps the final response headers.

Typed `Headers.get(name)` and `Headers.has(name)` calls are lowered to runtime
helpers over that same plain object. Names are normalized with ASCII lowercase;
`get()` returns the header string or `null`, and `has()` returns a boolean. This
keeps the most common Web fetch call shape working without introducing a full
Web `Headers` class yet.

Typed `Headers.keys()`, `Headers.values()` and `Headers.entries()` calls return
arrays in the runtime's existing collection style. A typed `for...of` over a
Headers object is lowered by materializing `headers.entries()` first, so it
iterates `[name, value]` pairs.

Typed `Headers.append(name, value)`, `Headers.set(name, value)` and
`Headers.delete(name)` calls mutate the same plain object. Names are normalized
with ASCII lowercase. Values are stringified and ASCII-trimmed. `set()` replaces
the stored value; `append()` joins an existing value with `", "`; `delete()`
removes the normalized key. This is still a simplified mutable surface for
standalone `Headers`; response headers are frozen as described below.

Typed `new Headers(init)` calls construct the same simplified plain headers
object. `undefined`/`null` produce an empty object. Record-like objects copy
own enumerable properties through the same name/value normalization as
`append()`. Array/iterable initializers are materialized as `[name, value]`
pairs and appended in order, so duplicate names are joined. Since the result is
the same plain object representation used by `Response.headers`,
`fetch(url, { headers: new Headers(...) })` is snapshotted by the existing
options path.

`Headers.prototype` is also modeled as a runtime prototype object. Headers
objects returned by `new Headers(init)` and `Response.headers` still store their
entries as own enumerable plain-object properties, but their prototype carries
boxed `get` / `has` / `keys` / `values` / `entries` / `append` / `set` /
`delete` methods. This makes first-class method values work through the existing
Function.prototype `call` / `apply` / `bind` path, including
`const get = h.get; get.call(h, "x")` and `Headers.prototype.append.call(h, ...)`.
Those prototype helpers now brand-check their receiver. Calling a Headers method
with a non-Headers receiver, including `Headers.prototype.get.call({}, "x")` or
an unbound `const get = h.get; get("x")`, throws a catchable tagged
`{ name: "TypeError", message: "Illegal invocation" }` object.

`Response.headers` is immutable: `Object.isFrozen(r.headers)` is true, direct
sloppy-mode property writes are ignored by the runtime freeze guard, and
`set()` / `append()` / `delete()` on response headers throw a catchable tagged
`{ name: "TypeError", message: "Headers are immutable" }` object. A standalone
`new Headers(init)` remains mutable.

## Error propagation (DONE)
libcurl completion with `CURLE_OK` resolves to a Response object regardless of
HTTP status. Any libcurl setup/transport/TLS failure rejects the fetch Promise.
The rejection reason follows the runtime's existing Error representation:
`{ name: "TypeError", message: "fetch failed: <curl reason>" }`. This lets
`try { await fetch(...) } catch (e) { e.name; e.message; }` work without adding
a distinct Error class runtime object.

## AbortSignal cancellation (DONE)
`AbortController` / `AbortSignal` are modeled as simplified runtime globals.
`new AbortController()` creates a controller with a `signal` object whose
`aborted` property starts as false and whose `reason` starts as `undefined`.
`controller.abort(reason?)` flips `aborted` to true once and stores `reason`;
when omitted, the runtime stores `{ name: "AbortError", message: "fetch aborted" }`.
Repeated abort calls are idempotent and do not replace the original reason.
`fetch(url, { signal })` checks `signal.aborted` at call time; if it is already
true, the fetch Promise rejects with `signal.reason` without starting libcurl
I/O.

If the signal is aborted after `fetch()` has queued the I/O task but before
start, `fetch_io_start` rejects with `signal.reason` without initializing a
curl easy handle. If the signal is aborted while the task is active, the event
loop snapshots active signals before curl polling, removes the easy handle from
curl_multi, and rejects with `signal.reason`. Completed transfers that have already
been drained settle normally; otherwise abort can win while the Promise is still
pending.

`AbortSignal.timeout(ms)` creates a signal with `aborted === false`, stores a
non-enumerable timeout marker, and registers a small runtime timer. Due timers
are fired at event-loop boundaries and before curl polling; while fetch I/O is
active, curl's poll timeout is capped to the next AbortSignal deadline. A
timeout signal that expires before queued start follows the same signal-reason
rejection path as a manually aborted signal. A timeout signal that reaches libcurl's
`CURLOPT_TIMEOUT_MS` path is converted to the timeout signal's
`{ name: "TimeoutError", message: "signal timed out" }` reason and flips
`signal.aborted` to true.

This simplified model does not implement `abort` events or real DOMException
objects. Abort/timeout default reasons are plain tagged objects with `name` and
`message`. `timeoutMs` remains available as a TSAOT extension; if both
`timeoutMs` and `AbortSignal.timeout(ms)` are supplied, the smaller timeout
drives the curl timeout, and only signal-derived timeout wins are reported as a
signal reason rather than a transport TypeError.

## Limitations / future
- One curl_easy handle per request is still used, but handles are driven through
  one curl_multi handle. Connection reuse is left to libcurl's multi cache.
- The runtime is still single-threaded. curl_multi_poll waits inside
  ts_run_event_loop when only I/O is pending; this gives concurrent fetch
  progress without introducing worker threads.
- curl_global_init is called once, lazily; the runtime is single-threaded.
- Response headers are plain objects for now, with typed constructor,
  first-class method values, `get()` / `has()`, read-iteration and mutation
  helper calls. Headers method illegal-invocation TypeError and response-header
  mutation guard TypeError are modeled. Streaming body support remains future
  API work.
