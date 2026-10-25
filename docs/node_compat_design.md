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

The prelude (`lib/node/prelude.ts`) installs `process`, `Buffer`, the timer
functions, `queueMicrotask`, `structuredClone` and `performance` on
`globalThis`. The exporter imports it as the program's first module when the
program references one of those names as an ambient global or imports a
`node:` module; a program that does neither pays nothing.

### The host (`runtime/node_host.c`)

Included at the end of `ts_rt.c` (one translation unit, so the build scripts
are unchanged) and exposed as `__garnet_node`. It is the generalization of
`benchmarks/tsc_ts_native/host.c`, which stays as the tsc-ts build's host
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
