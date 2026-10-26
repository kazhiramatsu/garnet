# Node.js compatibility: the `node:` modules, the globals and the event loop

Session 353 onward. The roadmap's last item (2026-10-25): a program written
for Node.js, in TypeScript and ES modules, compiles with garnet and behaves as
it does under Node for the API this layer covers, and anything outside it
fails at compile time with a message, never at run time with a wrong value.
The decision of 2026-10-24 stands: the modules are TypeScript in `lib/node`,
compiled with the program by garnet itself, over a small C core; the event
loop is garnet's own (libuv's vocabulary, not its code); sockets, Windows and
`fs.watch` are out until a program needs them.

## What Node gives a program, and where each piece lives

| Node | garnet |
|---|---|
| `import { readFileSync } from "node:fs"` (or `"fs"`) | the exporter maps `node:<name>` and the bare builtin names to `lib/node/<name>.ts`; a project's own `paths` still win; a module that does not exist is TS2307 |
| `process`, `Buffer` as globals | `lib/node/globals.d.ts` declares them when `@types/node` is not in the program; `lib/node/prelude.ts` creates them over the host and is imported first when the program names them or imports a `node:` module |
| `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask`, `performance` | the same prelude; the timers are the runtime's (below) |
| the system: files, the process, clocks, children | `runtime/node_host.c`, the `__garnet_node` host object: thin POSIX primitives, a failing call answers `undefined`/`false`/`-1` and leaves its errno name for `lastError()` |
| the event loop | the runtime's loop (ts_rt.c), which already drains microtasks and services fetch's I/O tasks, extended with timers, `nextTick`, immediates and a pending-callback queue |
| `console` | the runtime's (exists) |

The TypeScript in `lib/node` is ordinary TypeScript: it is type-checked with
the program (so a program using an API the module lacks fails with a TS error
naming it), optimized like the program (closed receivers, typed fields,
hoisted views) and measured like the program. Under the V8 oracle a `node:`
import resolves to Node itself, so every fixture is a differential test of the
real behavior; no polyfill is needed on that side.

### Module resolution

`garnetModulePaths()` (the exporter) adds, next to `garnet:*`:

```
"node:*"  -> lib/node/*.ts            (node:fs/promises -> lib/node/fs/promises.ts)
"fs", "path", "os", ... (the builtin names, listed)  -> lib/node/<name>.ts
```

A bare name is mapped only for the names Node reserves, so a project's own
`utils` module is untouched. Each module exports its named API and a default
object, as Node's ESM builtins do (`import fs from "node:fs"` and
`import { readFileSync } from "node:fs"` both work).

### The globals

Without a tsconfig, garnet type-checks against ES2020 plus the DOM library,
which declares `setTimeout`, `performance`, `console`, `TextEncoder` and the
rest of the browser-shaped globals, but not `process` or `Buffer`.
`lib/node/globals.d.ts` declares those two (and `NodeJS.Timeout` as the timer
handle) with the types of the modules in `lib/node`; the exporter adds it to
the program's root files unless a file from `node_modules/@types/node` is
already in the program (then Node's own declarations type the program, and
ours would conflict). A program with `@types/node` type-checks against Node's
full surface; what it uses must exist in `lib/node` (a missing module export
is a TS error at the import; a missing method on our class is a TS error at
the use), so the reject stays at compile time.

The prelude (generated per program by the exporter into build/prelude/, from the
globals the program and its lib modules name; see "As built, N4") installs `process`, `Buffer`, the timer
functions, `queueMicrotask`, `structuredClone` and `performance` on
`globalThis`. The exporter imports it as the program's first module when the
program references one of those names as an ambient global or imports a
`node:` module; a program that does neither pays nothing.

### The host (`runtime/node_host.c`)

Included at the end of `ts_rt.c` (one translation unit, so the build scripts
are unchanged) and exposed as `__garnet_node`. It is the generalization of
`benchmarks/tsc_ts_native/host.c`, which stayed as the tsc-ts build's host until N5b
until the tsc-ts shims migrate onto `lib/node` (slice N5, the flagship
validation of this layer). The primitives, by family:

- files: `open close read write pread pwrite fstat stat lstat readdir mkdir
  rmdir unlink rename link symlink readlink realpath chmod utimes truncate
  access copyfile fsync readFile writeFile appendFile` (whole-file forms avoid
  a TS loop per block); paths are UTF-8 strings, data is a `Uint8Array` or a
  string (UTF-8);
- the process: `argv env cwd chdir exit pid ppid kill umask hrtime now uptime
  rss cpuUsage execPath platform arch version isatty ttySize`;
- the system: `hostname homedir tmpdir cpus totalmem freemem loadavg
  osRelease osType userInfo endianness`;
- children (N4): `spawnSync(file, args, cwd, env, stdinBytes, timeoutMs)` and
  the asynchronous `spawn` with pipes polled by the loop;
- bytes: `utf8Length`, encode/decode of `latin1`, `utf16le`, `base64`,
  `hex` (Buffer's encodings, in C for speed), `randomBytes`;
- timers (the loop's): `timerAdd(cb, args, delayMs, repeatMs) -> id`,
  `timerClear(id)`, `timerRef(id, on)`, `nextTick(cb, args)`,
  `immediate(cb, args)`, `pending(cb, args)`.

Errors keep Node's shape: `lib/node/errors.ts` builds
`Error { code: "ENOENT", errno, syscall, path, message: "ENOENT: no such file
or directory, open 'x'" }` from the errno name the host reports and Node's
message table.

### The event loop

Node's loop phases, with the queues the runtime has:

```
loop:
  drain nextTick queue, then microtasks, until both are empty
  timers: run every timer whose deadline passed, oldest deadline first,
          (each callback followed by the nextTick/microtask drain)
  pending callbacks: completed asynchronous operations (fs.readFile's
          callback, fetch's I/O tasks)
  poll:   start queued I/O, poll active I/O and worker pipes, waiting up to
          the next timer's deadline when nothing else is runnable
  check:  immediates
  exit when nothing keeps the loop alive: no referenced timer, no active I/O,
          no pending callback, no immediate, no watched pipe
process.on("beforeExit") when the loop would exit; "exit" when it does
```

`setTimeout` returns a `Timeout` object (`ref unref hasRef refresh
[Symbol.toPrimitive]`), as Node does; `clearTimeout` takes it or its number.
`process.nextTick` callbacks run before promise reactions, as in Node. An
exception thrown by a callback is uncaught: the error prints and the program
exits with status 1 (the behavior of an exception out of `main`). The
runtime's existing `AbortSignal.timeout` timers become entries of the same
timer list.

### Buffer

`Buffer` is a subclass of `Uint8Array` in Node, and programs rely on that
(`buf instanceof Uint8Array`, passing a Buffer to a typed-array API). Garnet
today compiles `class B extends Uint8Array` to a plain class instance, a
silent miscompile (a probe printed `0 NaN false` for the sum, the length and
`instanceof`). Slice N1 makes that a loud reject; slice N2 implements
typed-array subclasses: the exporter marks a class whose base resolves to a
typed-array constructor, `new` allocates the view (`ts_new_typed_array`) and
sets its `proto` (every object cell has one) to the class's prototype, the
constructor body runs with the view as `this`, property lookup on a view
consults its own `proto` before the element type's prototype, and element
access is unchanged (it tests the cell kind). `Buffer` then is
`lib/node/buffer.ts`: `from/alloc/allocUnsafe/concat/byteLength/isBuffer/
compare`, `toString(encoding, start, end)`, `write`, `slice`/`subarray`
(views sharing memory), `equals/compare/indexOf/includes/copy/fill`, the
integer and float readers and writers (LE/BE), `toJSON`, with `utf8`,
`utf16le`, `latin1`/`binary`, `ascii`, `base64`, `base64url` and `hex`.

### `process.argv`

A compiled program has no script file. As `bun build --compile` does,
`process.argv` is `[execPath, execPath, ...args]`, so `process.argv.slice(2)`
is the program's arguments, as in Node.

## Slices

- **N1** (this session): this design; module resolution; `globals.d.ts` and
  the prelude with their injection rules; `runtime/node_host.c` (files,
  process, system, clocks); `path` (posix, complete), `os`, `process` (the
  global and the module), `events` (`EventEmitter`, `once`, `on`), `util`
  (`format`, `inspect`, `promisify`, `callbackify`, `inherits`, `types`,
  `isDeepStrictEqual`, `TextEncoder`/`TextDecoder` re-exports), `assert`
  (strict and legacy, `AssertionError`), `perf_hooks` (`performance`); the
  typed-array-subclass reject; fixtures under `tests/conformance/exhaustive/node/`.
- **N2**: typed-array subclasses in the runtime; `buffer`; `fs` synchronous
  API complete (`readFileSync` with encodings, `writeFileSync`,
  `appendFileSync`, `existsSync`, `statSync`/`lstatSync`/`fstatSync`,
  `readdirSync` with `withFileTypes` and `recursive`, `mkdirSync` recursive,
  `rmSync` recursive, `unlinkSync`, `rmdirSync`, `renameSync`, `copyFileSync`,
  `realpathSync`, `accessSync`, `openSync/readSync/writeSync/closeSync`,
  `chmodSync`, `utimesSync`, `truncateSync`, `symlinkSync/readlinkSync`,
  `mkdtempSync`), `fs/promises` and the callback forms over the pending
  queue, `string_decoder`.
- **N3**: the loop: timers and their globals, `nextTick`, immediates,
  `timers/promises`, `process.on("exit"/"beforeExit")`, unhandled rejections
  reported as Node reports them, `process.exitCode`.
- **N4**: `child_process` (`spawnSync`, `execSync`, `execFileSync`; `spawn`
  and `exec` over the loop), `crypto` (`randomBytes`, `randomUUID`,
  `randomInt`, `createHash` for md5/sha1/sha256/sha512, `timingSafeEqual`),
  `url` (WHATWG `URL`, `URLSearchParams`, `fileURLToPath`, `pathToFileURL`),
  `readline` (line iteration of a stream), `stream` basics (`Readable`,
  `Writable`, `pipe`, `process.stdin/stdout/stderr` as streams, `fs.createReadStream`/`createWriteStream`).
- **N5**: tsc-ts compiled against `lib/node` instead of its own shims (output
  identical, instructions within noise), `worker_threads` generalized from the
  fork workers.
- Later, when a program needs them: `net`/`http`/`https` (sockets, TLS),
  `fs.watch`, `dns`, `zlib`, Windows.

## Gates

Every module has a fixture under `tests/conformance/exhaustive/node/` whose
output is identical under Node and garnet (plain and strict): the fixtures
work in a directory under `os.tmpdir()` named by the process id and remove
it; nothing they print depends on timing, absolute paths or the environment
beyond what both runs share. The usual gate set applies (conformance, parity
and selfconf with allowlist lines for the host global, unit, bundler, GC
stress, bench); the tsc-ts benchmark is unaffected until N5.

## As built, N1 (Session 353)

- `lib/node/`: `host.ts` (the `__garnet_node` binding), `errors.ts` (Node's
  error objects: plain `Error`/`TypeError`/`RangeError` instances with `code`,
  system errors with `errno`, `syscall`, `path`, `dest` and libuv's messages),
  `internal/inspect.ts` (util's string quoting over the runtime's console
  formatter), `internal/comparisons.ts` (deep equality), `path.ts` and
  `path/posix.ts`, `os.ts`, `process.ts`, `events.ts`, `util.ts`,
  `assert.ts` and `assert/strict.ts`, `perf_hooks.ts`, `globals.d.ts`,
  `prelude.ts`.
- `runtime/node_host.c`, `#include`d at the end of `ts_rt.c`: 60 primitives
  as listed in the design plus `inspect(value)` (console.log's formatter into
  a memory stream), `atExit(hook)` (the runtime calls it when the event loop
  ends; a nonzero number is the exit status), `lastErrno()`. Argv comes from
  `_NSGetArgv` on macOS and `/proc/self/cmdline` on Linux because the generated
  `main` takes no parameters (the tsc-ts build patches its main instead).
- The exporter: `NODE_BUILTIN_MODULES` and `garnetModulePaths()`;
  `programWithNodeSupport()` recreates the program with the prelude and, unless
  `@types/node` is in it, `globals.d.ts`, when a module program imports a Node
  builtin or names a prelude global as an ambient name (identifiers in
  property positions excluded); `computeModuleOrder` visits the prelude first.
  Script-mode programs get no prelude (the Node globals need a module).
- The rejects and fixes the fixtures forced (details in the TODO entry):
  boolean returns of boxed entries, `instanceof Promise` and `instanceof
  Date`, a built-in base class other than the Error family.
- Deviations, documented in the README: `util.inspect` ignores its options
  (depth, colors) and `util.format`'s `%o` shows no hidden properties;
  `process.nextTick` runs as a microtask until N3; the legacy `util.is*`
  predicates (removed in Node 23) are not provided; `DataView` does not exist,
  so `util.types.isTypedArray` is `ArrayBuffer.isView`.

## As built, N2 (Session 353)

- `Buffer` is not a class in garnet (typed-array subclasses are still a
  compile-time reject): `lib/node/buffer.ts` makes a `Uint8Array` view whose
  prototype is `Buffer.prototype`, an object chained to the typed array's,
  carrying the methods; `Buffer` itself is a constructor object with
  `Symbol.hasInstance`, which the exporter now accepts as an `instanceof`
  right-hand side (the runtime calls the hook). `subarray` and `slice` re-adopt
  the prototype, so views are Buffers. The encodings are TypeScript; utf8 goes
  through TextEncoder/TextDecoder. `fromView` adopts the host's bytes without
  a copy (fs reads).
- `lib/node/fs.ts`: the synchronous API over the host; `promises` and the
  callback forms run the synchronous call from a microtask (so they complete
  after the current turn, as Node's do, though not interleaved with timers
  until N3). Errors carry Node's `syscall` names (`open`, `read` without a
  path for EISDIR, `scandir`, `copyfile` with `dest`, `lstat` for
  `realpathSync` and `rmSync`), and `rmSync` of a directory without
  `recursive` throws Node's `SystemError` (ERR_FS_EISDIR). `node:fs/promises`
  re-exports the promise API; `node:string_decoder` keeps partial sequences.
- Three more pre-existing miscompiles the fixtures found, fixed: the SROA
  method inliner dropped a `return` nested in a block of a method reached
  through a `this` call of an inlined method (every call answered the last
  `return`): the eligibility test is now transitive over `this` calls; an
  `async` function or method called without an optional argument read it as
  `0` (the coroutine frame is zeroed; a missing argument is `undefined` now);
  and a promise rejection nothing handled was silent (the program exited 0):
  the runtime remembers a promise rejected with no reaction, forgets it when
  one is attached, and after each turn's microtasks reports what remains and
  exits with status 1.

## As built, N3 (Session 353)

- The loop (ts_rt.c `ts_run_event_loop`, the queues in node_host.c): the
  module body's promise reactions first (as Node's ESM evaluation does), then
  per turn: nextTick callbacks and microtasks until both queues are empty, the
  timers whose time came (each followed by the drain), the abort timers, the
  I/O tasks, the workers' pipes, the immediates queued before the turn; it
  waits for the earliest timer when nothing is runnable (a fetch wait is
  capped at it too) and ends when no referenced timer or immediate, tick, I/O
  or watched pipe remains. The exit hook runs in two phases: 'beforeExit' (a
  listener may schedule more; the loop goes on) and 'exit'.
- Timer records are malloc'd and sorted by due time then id; their callbacks
  and arguments are GC roots; a record is unlinked (a repeating one
  re-inserted) before its callback runs and never touched afterwards, so a
  callback may clear or refresh timers freely. `unref` drops a timer from the
  liveness count without clearing it.
- `lib/node/timers.ts`: `Timeout` and `Immediate` objects as Node returns
  them (`ref`, `unref`, `hasRef`, `refresh`, `close`, a number as the
  primitive); Node's delay coercion (not in [1, 2^31-1] -> 1);
  `clearTimeout` takes the object or its number. `timers/promises`:
  `setTimeout`, `setImmediate`, `setInterval` as an async generator,
  `scheduler`. `process.nextTick` goes to the loop's tick queue.
- `globals.d.ts` declares the timer functions with Node's types; a later
  declaration's overload is tried before the browser library's, so
  `setTimeout(...).unref()` type-checks without @types/node.
- Known: a `setImmediate` from the main module races 0/1 ms timers in Node
  too (the fixture queues it from a timer); `refresh()` inside a one-shot
  timer's own callback does not re-arm it (the record is gone).

## As built, N4 (Session 353)

- Streams (`lib/node/stream.ts`): Node's lib/internal/streams ported: the
  ReadableState/WritableState machines (buffer, length, flowing/paused,
  needReadable/emittedReadable, sync/async push, the drain/finish/prefinish
  ticks, corking, autoDestroy, errorOrDestroy), `construct` (writes buffer and
  reads wait until the callback), the shared destroy ('error' then 'close' on
  the next tick), pipe with backpressure, `finished`, `pipeline` (streams,
  iterables and generator stages, destroyed together on failure),
  `Readable.from` (an async generator pulls the iterable), async iteration,
  `toArray`. The writable half is a set of functions over the state so that
  Duplex (which extends Readable) shares it; `_read`/`_write`/`_final`/
  `_destroy` come from the options or a subclass method, not from a property
  assigned afterwards. Duck typing in the helpers reads properties through an
  untyped cast: a typed cast would devirtualize a getter the object lacks and
  throw instead of yielding undefined.
- The standard streams (`lib/node/tty.ts`): `process.stdout`/`stderr` are
  Writables whose `_write` is the synchronous host write (strings pass
  through, `decodeStrings` false); `isTTY` is true on a terminal and absent
  otherwise; `process.stdin` is created on first use and read by the loop
  (`watchFd`) while flowing, a pause stops the watch so the process can exit.
  The host flushes both C stdio buffers before any raw write to fd 1 or 2 so
  console output and stream writes interleave in order.
- fs streams: `createReadStream`/`createWriteStream` open through
  `construct` on a later turn (`host.immediate`: 'open', 'ready', then the
  buffered writes), read and write synchronously from `_read`/`_write`, and
  complete the close on a later turn too (Node's asynchronous close). Options
  are validated before the base constructor runs, which schedules the open.
- readline: whole-line splitting (LF, CRLF with crlfDelay, lone CR) over any
  readable's 'data', question/prompt over the output, write() as input,
  async iteration (a queue of lines, closed when the iterator ends), the
  cursor functions as escape sequences. No terminal (raw) mode.
- child_process: the host forks and execs (`nh_fork_exec`: pipes, inherit or
  /dev/null per stream, cwd, env, an exec failure reported through a
  close-on-exec pipe). `spawnSync` feeds stdin and collects the pipes with
  poll, a timeout kills with the signal; the asynchronous `spawn` registers
  the child with the loop (SIGCHLD wakes the poll through a self-pipe,
  `waitpid` from the loop) and watches the pipe descriptors (`watchFd`:
  chunks pushed into Readables, EOF ends them); 'close' follows 'exit' once
  every pipe ended (an unread pipe is drained after exit, as Node's
  flushStdio does). `exec`/`execFile` collect the output with maxBuffer and
  offer the promise form through `util.promisify.custom`. No `fork`.
- crypto: md5/sha1/sha256/sha512 in C (`host.hash`), HMAC and PBKDF2 over
  them in TypeScript, random bytes from the host, UUID v4, `timingSafeEqual`.
- url: the URL Standard's parser for ASCII hosts (schemes, authority, IPv4
  and IPv6, dot segments, the percent-encode sets, opaque paths, relative
  references, the setters' rules), URLSearchParams with the live link to its
  URL, file URL conversions, the legacy API. `new URL(...)` on the global
  identifier constructs the prelude's class through `ts_construct`
  (resolveNewTarget's prelude-constructor case); `import { URL } from
  "node:url"` is the statically typed form. A non-ASCII host is invalid (no
  IDNA).
- Language fixes the work needed (in `exporter.ts`, the runtime and the
  emitter): IteratorClose for custom iterators (`iter.close:` calls `return`
  when the iterator's type may have one; the runtime's own iterators, an
  array's/Map's/Set's keys/values/entries and the lib's *Iterator types, have
  none and keep the plain loop; yield* closes the inner iterator when the
  delegation ends early), for-await over an object literal with
  `[Symbol.asyncIterator]`, array patterns bound from a Map, Set, generator,
  class iterable or iterator by the protocol (`const [a, b] = new Set(...)`
  read undefined before), a runtime GetIterator (`iter.acquire:`) for a
  source typed `Iterable<T>` (any runtime representation) and for nested
  patterns, and the URI functions as runtime builtins.
- The prelude is generated per program (`writeNodePrelude` in the exporter):
  the lib modules behind the globals the program, or the lib modules it
  imports, name as free identifiers (`process` → process.ts, the timers →
  timers.ts, `Buffer`/`atob`/`btoa` → buffer.ts, `performance` → perf_hooks.ts,
  `URL`/`URLSearchParams` → url.ts; `global` and `queueMicrotask` always). A
  static prelude importing everything made a program that names `setTimeout`
  compile the streams behind process.stdout and the URL parser: 607 IR
  functions and 2 MB of C instead of a few dozen functions. The modules the
  prelude pulls in are rescanned for further globals until the set is stable.
- On-demand modules (the same generator): a library module that only some
  programs can observe is compiled when the program's own files name its
  trigger as a property or identifier, and registers itself when it loads.
  `lib/node/tty.ts` (the standard streams: triggers `stdout`, `stderr`,
  `stdin`) registers the stream classes with process.ts, whose
  `process.stdout`/`stderr` getters otherwise return a minimal writer
  (synchronous write, the terminal size, no events) and whose `stdin` getter
  throws a message naming the fix; `lib/node/fs/streams.ts` (triggers
  `createReadStream`, `createWriteStream`) registers the fs stream classes,
  and `fs.createReadStream` throws the same kind of message without it.
  process.ts and fs.ts import those modules as types only: the exporter
  compiles only the modules runtime imports reach from the entry and the
  prelude (a type-only import is erased), while the evaluation order still
  follows every edge, so the order of a program that has type-only imports
  in a cycle (tsc-ts) does not move. A lib module's own use of a trigger
  (util.debuglog writes to process.stderr) does not bring the module in: the
  minimal writer serves it. Costs after this: a program naming `setTimeout`
  41 IR functions (165 KB of C, a 1.1 s build), `process` and `Buffer` 187
  (669 KB, 2.6 s; it was 447 and 5.7 s), `fs.readFileSync` 276 (919 KB,
  3.0 s). Dead-function elimination in the analyzer would take the rest.

## As built, N5a (Session 353): tsc-ts on lib/node

- `benchmarks/tsc_ts_native` maps only `node:worker_threads` and the scriptc
  modules to shims now; `node:fs`, `node:path`, `node:os`, `node:perf_hooks`
  and `node:child_process` are lib/node, and the prelude is the generated
  one (`process`, `Buffer`, the timers, `URL` from the names tsc-ts uses).
  Output identical to the shim build (78 files); instructions 1.021 against
  it on one CPU (`TSAOT_CPUS=1`, the measured configuration: the host's
  `cpus()` honors it, so `os.availableParallelism()` is 1 and tsc-ts starts
  its four checkers and parse threads as before).
- What it took: Node's overloads on `fs.readFileSync`/`statSync`/`lstatSync`
  /`readdirSync` and `child_process.spawnSync`/`execSync`/`execFileSync`
  (the encoding picks the result type), `process.memoryUsage.rss()`,
  `threadCpuUsage`, `constrainedMemory`, `fs.watch`/`watchFile` (an error:
  no file system events), the closed-receivers slice 3 (the library opened
  the program at 32 sites: 1.66x instructions), the host's `utf8Length`
  measured without a copy and cached in the string cell as the shims' host
  did (Buffer.byteLength is on the compiler's hot path: 1.36x → 1.27x),
  `Buffer.prototype.write` and the UTF-16LE/Latin-1 encoders in the host
  (`writeString`; the TypeScript byte loops were 4.7% of the parse workers:
  1.27x → 1.03x → 1.02x with the storage read directly), `readFileSync` to a
  string without a Buffer on the way, `Stats` dates as getters, the
  options of `readFileSync(path, "utf8")` without an allocation, and the
  decoders keeping a leading BOM (Node keeps it; a TextDecoder without
  `ignoreBOM` dropped it).
- Known: the remaining 2.1% sits in the parse workers (+10% of their
  samples: more `publish_visit`, conservative stack-scan and remembered-set
  work, no library function above a few samples); the candidates are the
  14-number array `host.stat` returns per call and the directory listing's
  arrays (a per-symbol profile of the shim build against the library build,
  N5c: the growth is spread over the string runtime, no symbol above 0.05%
  of the samples; not pursued). `util.inherits` with a garnet class's
  prototype is a TypeError. `Stats.atime`/`mtime`/`ctime`/`birthtime` are
  getters making a Date per read (Node caches the Date: `s.mtime === s.mtime`
  there, not here; a cache would add four slots to every stat).

## As built, N5b (Session 353): worker_threads over the fork workers

Node runs a worker's file in a fresh isolate; garnet's workers are forked
processes of the initialized program (docs/fork_workers_design.md): fast to
start, sharing everything copy-on-write, exchanging messages over pipes.
`node:worker_threads` (`lib/node/worker_threads.ts`) maps onto them:

- `new Worker(spec, options)`: `spec` names a module of the program statically:
  `import.meta.url`, `new URL(import.meta.url)`, `new URL("./w.js",
  import.meta.url)` (`.js`/`.mjs` resolve to the `.ts`), or `fileURLToPath` of
  one of those. A path string is relative to the working directory in Node,
  which the compiler does not know: a compile-time error names the forms.
  The exporter (`programWithWorkerEntries`) rewrites the named module's
  source for the compiler (the checker sees the rewritten text at the same
  path): its imports and type declarations stay at the top level, its other
  statements become the body of an exported function `__garnet_worker_<n>`,
  called once at the module's place when the module is part of the program's
  graph (a module only a worker runs is not called), and each `new Worker`
  site passes that function in the file's place (a site in another module
  imports it). Node's `isMainThread` pattern therefore runs the file's top
  level again in the child, as Node does, with the module-level state of the
  parent at the fork rather than fresh (a program cannot easily tell the two
  apart; `process.pid` is the process's in both, as a Node worker's is). A
  module run as a worker cannot export values of its own or await at its top
  level (compile-time errors); its functions are closures of the entry.
- The child: `ts_worker_start(entry, data, shared)` forks; the child calls the
  library's start hook (`host.setWorkerStart`), which makes `isMainThread`,
  `threadId`, `workerData` and `parentPort` the worker's (live `let`
  bindings: the module's values are the parent's at the fork) and then runs
  the entry; the event loop follows. The child drops the parent's pending
  timers, immediates, ticks, watched fds and child processes
  (`nh_fork_child_reset`), and runs no process exit hooks at its end (the
  `process` listeners are the parent's copies).
- Messages: structured copies over the pipe (objects, arrays, strings,
  numbers, booleans, null/undefined, typed arrays, Date, Map, Set);
  `transferList` is accepted and ignored. An uncaught exception in the
  worker is a frame to the parent (`[1, name, message, stack]`, the error
  rebuilt with its standard kind, so `instanceof RangeError` holds) and the
  parent's 'error', then 'exit' with 1; nothing is printed by the child, as
  Node prints nothing when the parent listens. `process.exit(code)` in the
  worker ends the worker only; the parent sees 'exit' with the code.
- Events and methods: 'online' (a tick after construction), 'message',
  'error', 'exit'; `postMessage`, `terminate()` (SIGTERM; 'exit' with 1, no
  'error'; the promise resolves after the event), `ref`/`unref` (an
  unreferenced worker does not keep the parent's loop alive), `threadId`.
  `parentPort`: `on/once('message')` starts delivery and keeps the worker
  alive until `close()`; `postMessage`; `ref`/`unref` are no-ops.
- Shared workers: a parse thread of tsc-ts publishes bound files to the main
  thread by reference (`garnet:shared`), which needs the child forked into a
  region mapped shared before the fork. Node has no such notion, so it is
  garnet's option on the constructor: `new Worker(file, { workerData,
  shared: true })`; Node ignores the key, so the driver stays runnable under
  Node. Checkers stay plain forks.
- Not available (a TypeError that says so): `MessageChannel`, `MessagePort`
  of one's own, `BroadcastChannel`, `receiveMessageOnPort`,
  `moveMessagePortToContext`, `postMessageToThread`, `eval: true`, piped
  stdio (`stdout`/`stderr`/`stdin: true`), an `env` or `argv` of the worker's
  own. `getEnvironmentData`/`setEnvironmentData` are a Map the fork copies.
- tsc-ts: the benchmark driver (`benchmarks/tsc_ts_native/garnet/main.ts`) is
  a Node program now (`if (!isMainThread) runThread(workerData, drivers)`,
  `new Worker(new URL(import.meta.url), { workerData, shared: kind ===
  'parse' })`); the worker shim, the driver's own host (`host.c`, `host.ts`)
  and the build's host injection are gone. Output identical to N5a,
  instructions 1.0002 against it (one CPU; 1.0006 on an earlier build of the same sources). Fixtures `node/worker_threads`
  (the self pattern: data, replies, an uncaught RangeError as 'error' then
  'exit' 1, terminate), bundler `worker_module` (a worker in a module of its
  own with a helper only it imports).
- Lesson: a defect in the worker's bindings (`isMainThread` inherited as true)
  made every child run the main program and fork again: 4,000 processes in
  ten minutes. A test that forks runs under a process cap and a time limit
  (`ulimit -u`, `perl -e 'alarm N'`; docs/agent_workflow.md).
