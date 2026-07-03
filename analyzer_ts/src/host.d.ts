// Ambient host primitives provided by the garnet runtime (ts_rt). Declared in
// a .d.ts so the exporter's symbol-based builtin classification (all
// declarations ambient => builtin) routes calls to the runtime lowering — the
// same mechanism as `fetch`. Under node these do not exist; the node driver
// (main.ts) uses fs instead, and harness shims define them when needed.

/** Read ALL of stdin as a UTF-8 string (returns "" on empty input). */
declare function __read_stdin(): string;
