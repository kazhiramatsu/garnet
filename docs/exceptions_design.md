# try / catch / finally — design (setjmp/longjmp unwinding)

## The problem
`throw` must unwind the C call stack to the nearest enclosing `catch`, which may
be several frames up. Codegen lowers IR control flow to native C `if`/`for` and
calls to nested C expressions `FN_TABLE[i](_a, n)`, so there is no IR-level
"stack of frames" to pop. A flag-checked-after-every-call scheme would be both
invasive (every call site and every statement would need a propagate-check) and
slow. The idiomatic, correct C mechanism for non-local exit across frames is
`setjmp`/`longjmp`.

## Mechanism

### Runtime: a handler stack + current exception
```c
typedef struct ts_handler { jmp_buf buf; int gc_root_len; struct ts_handler* prev; } ts_handler;
static ts_handler* g_handlers = NULL;   // top = innermost active try
static tsv g_exception;                 // the in-flight thrown value

ts_handler* ts_eh_push(void);  // allocate+link a handler, snapshot gc root depth, return it
void        ts_eh_pop(void);   // unlink the top handler (normal exit from try)
void        ts_throw(tsv v) __attribute__((noreturn)); // set g_exception, longjmp to top handler
tsv         ts_current_exception(void); // read g_exception (in the catch block)
```
`ts_throw`:
- if `g_handlers == NULL`: no handler — print "Uncaught" + the value and abort
  (faithful-ish to an uncaught exception terminating the program).
- else: `g_exception = v; ts_handler* h = g_handlers; longjmp(h->buf, 1);`
  (the handler is popped by the catch-side code, see below).

**GC interaction (critical).** The global GC root stack (`g_roots`,`g_root_len`)
is appended to as functions root their locals and popped on normal return/throw.
A `longjmp` skips the intermediate `ts_gc_unroot` calls, so the root stack would
be left too deep, keeping dead slots alive (or worse, pointing at reclaimed C
stack frames → use-after-free during a later GC mark). Therefore each handler
snapshots `g_root_len` at `try` entry, and the catch-side restores
`g_root_len = h->gc_root_len` immediately after `setjmp` returns nonzero. This is
why `ts_eh_push` records the depth.

### Codegen for `try { T } catch (e) { C } finally { F }`
```c
{
  ts_handler* _h = ts_eh_push();
  if (setjmp(_h->buf) == 0) {
    <T>                 // try body
    ts_eh_pop();        // normal completion: unlink handler
    <F-normal>          // finally on normal path (if present)
  } else {
    g_root_len = _h->gc_root_len;   // restore GC roots after unwind
    ts_eh_pop();                    // handler already the longjmp target; unlink
    tsv <e> = ts_current_exception();
    <C>                 // catch body (binds e)
    <F-normal>          // finally after catch (if present)
  }
}
```
Notes:
- `setjmp` must be called in the function that owns the `try` (cannot be wrapped
  in a helper), so codegen emits it inline.
- Locals declared in C are at function scope (we declare all locals up front), and JS lets the
  catch, the finally and the code after them read whatever the try body wrote before the throw.
- `setjmp`/`longjmp` + local mutation: C says locals modified between setjmp and longjmp and not
  declared `volatile` have indeterminate value after longjmp. Reference locals of a function with a
  `try` live in memory homes (`docs/frame_elision_design.md`); a coroutine's numerics in its frame.
  An unboxed number or boolean of a plain function is a C local: until Session 362 this note said no
  catch would read one, which is false (`let n = 0; try { n = 1; f(); } catch { return n; }` answered 0
  at -O2, silently). `try_volatile_locals` declares `volatile` each numeric local written in a
  protected body and read outside it, or read in a body that a loop around the `try` enters again
  after a throw (more than one definition). A local read only inside the body it is written in stays in
  a register, so a hot loop in a `try` pays nothing unless its accumulator is read after the `try`.

### finally
`finally` must run on BOTH the normal and the exceptional path, and also when the
try/catch itself throws (rethrow) or returns. v1 scope:
- Support `finally` that runs on normal completion and on caught-exception
  completion (emit `<F>` at the end of both branches).
- A `return` inside try/catch with a `finally`, or a throw escaping the catch,
  would need the finally to run during unwinding too. v1: if a `try`/`catch`
  body contains `return` or `throw` AND there is a `finally`, reject loudly
  (sound) rather than risk skipping finally. (Common try/catch without control
  flow out of the block is fully supported.)

### Nested try and rethrow
- Nested try works: each `try` pushes its own handler; `ts_throw` always targets
  the current top, and the catch pops it. A `throw` inside a catch re-enters
  `ts_throw` which finds the NEXT outer handler (the inner one was already
  popped), giving correct rethrow/propagation.

### IR
- New `Inst::TryCatch { try_body, catch_var: Option<LocalId>, catch_body,
  finally_body: Vec<Inst>, has_finally: bool }`.
- `Throw` codegen changes from "return value" (WRONG: silently turns a throw into
  a normal return) to `ts_throw(value)`.

## Exporter
- Lower `ts.TryStatement`: lower try block, optional catch (bind the catch
  variable — must be a simple identifier; destructured catch param rejected),
  optional finally.
- Guard: if `finally` present and the try or catch block contains `return`/
  `throw`/`break`/`continue` that exits the block, reject loudly (finally-through-
  unwind not modeled in v1).
- `throw` already lowers to `Inst::Throw`; only its codegen changes.

## Safety
- Uncaught throw: prints and aborts (loud), never silently returns.
- The previous behavior (throw == return value) was a SILENT MISCOMPILE; this is
  the primary correctness fix.
- GC root depth restored on every unwind (no leak / no use-after-free).
- finally-via-unwind edge cases rejected loudly rather than miscompiled.
