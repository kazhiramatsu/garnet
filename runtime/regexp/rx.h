/* rx.h: garnet's regular expression engine (docs/regexp_vm_design.md).
   A pattern (UTF-16 code units) compiles to a bytecode program; the program runs over a
   Latin-1 or UTF-16 input buffer with an explicit backtrack stack. No runtime types here: the
   engine is usable from a plain C test driver and from the compiler (the native tier). */
#ifndef RX_H
#define RX_H
#include <stdint.h>
#include <stddef.h>

/* The flag bits are the exporter's mask and TSAOT_REGEXP_FLAG_* of the adapter. */
enum {
  RX_F_GLOBAL = 1u << 0, RX_F_IGNORECASE = 1u << 1, RX_F_MULTILINE = 1u << 2,
  RX_F_DOTALL = 1u << 3, RX_F_UNICODE = 1u << 4, RX_F_STICKY = 1u << 5,
  RX_F_INDICES = 1u << 6, RX_F_UNICODE_SETS = 1u << 7
};
#define RX_F_EITHER_UNICODE (RX_F_UNICODE | RX_F_UNICODE_SETS)

typedef struct rx_program rx_program;

/* A syntax error: V8's reason string ("Unterminated group", "Nothing to repeat", ...) and the
   offset in the pattern where it was found. The caller formats
   "Invalid regular expression: /src/flags: reason". */
typedef struct rx_error { const char* msg; uint32_t pos; } rx_error;

/* Compile a pattern. NULL on a syntax error (err filled). The flags must already be valid
   (no duplicates, not both u and v). */
rx_program* rx_compile(const uint16_t* pattern, uint32_t len, uint32_t flags, rx_error* err);
void rx_retain(rx_program* p);
void rx_release(rx_program* p);

uint32_t rx_flags(const rx_program* p);
/* Capturing groups, not counting group 0. */
uint32_t rx_group_count(const rx_program* p);
/* The name of capturing group i (1-based) as UTF-16, or NULL when it is unnamed. */
const uint16_t* rx_group_name(const rx_program* p, uint32_t i, uint32_t* len);
int rx_has_named_groups(const rx_program* p);
/* The program can only match at position 0 (every alternative begins with a non-multiline ^). */
int rx_anchored_at_start(const rx_program* p);

/* Match from `start` (a code-unit index <= len), scanning forward unless the program is sticky.
   input: uint8_t (wide 0, Latin-1) or uint16_t (wide 1) code units. caps: 2 * (groups + 1)
   int32 slots, -1 for an unset group, filled on a match. Returns 1 match, 0 no match,
   RX_EXEC_OVERFLOW when the backtrack stack hit its limit. */
#define RX_EXEC_OVERFLOW (-1)
int rx_exec(const rx_program* p, const void* input, uint32_t len, int wide, uint32_t start, int32_t* caps);

/* The backtrack stack's limit in bytes (RX_EXEC_OVERFLOW past it): 64 MiB, V8's default. */
#define RX_BACKTRACK_LIMIT_BYTES (64u << 20)

/* Case mapping (rx_unicode.c): the non-`u` Canonicalize of a code unit, and the simple case
   folding of a code point (`u`/`v`). */
uint32_t rx_canon_nonu(uint32_t cu);
uint32_t rx_fold_u(uint32_t cp);

/* A pattern's canonical source for RegExp.prototype.source (EscapeRegExpPattern): `/` escaped,
   line terminators as escapes, an empty pattern as "(?:)". Writes up to cap units, returns the
   needed length. */
uint32_t rx_escape_source(const uint16_t* pattern, uint32_t len, uint16_t* out, uint32_t cap);

/* Debugging aid: a textual disassembly of the program (malloc'd, caller frees). */
char* rx_disassemble(const rx_program* p);

#endif
