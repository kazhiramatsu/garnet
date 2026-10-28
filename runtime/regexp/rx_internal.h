/* rx_internal.h: the engine's shared internals (the arena, code point sets, the AST, the
   bytecode, the program). Private to runtime/regexp/rx_*.c. */
#ifndef RX_INTERNAL_H
#define RX_INTERNAL_H
#include "rx.h"
#include <string.h>
#include <stdlib.h>
#include <setjmp.h>

#define RX_MAX_CP 0x10FFFFu
static inline int rx_is_lead(uint32_t c){ return c >= 0xD800u && c <= 0xDBFFu; }
static inline int rx_is_trail(uint32_t c){ return c >= 0xDC00u && c <= 0xDFFFu; }
#define RX_INFINITY 0xFFFFFFFFu   /* a quantifier's unbounded maximum */

/* ---- arena: every parse-time allocation, freed at once after the compile ---- */
typedef struct rx_arena_chunk { struct rx_arena_chunk* next; size_t used, cap; char data[]; } rx_arena_chunk;
typedef struct rx_arena { rx_arena_chunk* head; } rx_arena;
void* rx_arena_alloc(rx_arena* a, size_t n);
void rx_arena_free(rx_arena* a);

/* ---- a set of code points: sorted, disjoint, inclusive [lo, hi] pairs ---- */
typedef struct rx_cpset { uint32_t* r; uint32_t n; uint32_t cap; } rx_cpset;   /* n pairs */
void rx_cpset_add(rx_arena* a, rx_cpset* s, uint32_t lo, uint32_t hi);          /* keeps it normalized */
void rx_cpset_add_set(rx_arena* a, rx_cpset* s, const rx_cpset* t);
void rx_cpset_add_ranges(rx_arena* a, rx_cpset* s, const uint32_t* pairs, uint32_t n);
rx_cpset rx_cpset_invert(rx_arena* a, const rx_cpset* s, uint32_t max);         /* complement within [0, max] */
rx_cpset rx_cpset_intersect(rx_arena* a, const rx_cpset* s, const rx_cpset* t);
rx_cpset rx_cpset_subtract(rx_arena* a, const rx_cpset* s, const rx_cpset* t);
int rx_cpset_has(const rx_cpset* s, uint32_t cp);
rx_cpset rx_cpset_map(rx_arena* a, const rx_cpset* s, const uint32_t* pairs, uint32_t n);
int rx_ranges_has(const uint32_t* pairs, uint32_t n, uint32_t cp);

/* ---- strings of a `v`-mode class (\q{...}, the properties of strings) ---- */
typedef struct rx_cpstr { uint32_t* cps; uint32_t n; } rx_cpstr;
typedef struct rx_strlist { rx_cpstr* s; uint32_t n, cap; } rx_strlist;

/* ---- the AST ---- */
enum {
  RX_N_EMPTY, RX_N_CHAR, RX_N_DOT, RX_N_CLASS, RX_N_SEQ, RX_N_ALT, RX_N_GROUP, RX_N_QUANT,
  RX_N_BOL, RX_N_EOL, RX_N_WORDB, RX_N_NWORDB, RX_N_LOOK, RX_N_BACKREF
};
/* the effective flags at a node (the pattern's flags with (?ims-ims:) modifiers applied) */
#define RX_M_I 1u
#define RX_M_M 2u
#define RX_M_S 4u
typedef struct rx_node {
  uint8_t kind;
  uint8_t mflags;            /* RX_M_* in effect */
  uint8_t negate;            /* CLASS: [^...]; LOOK: negative */
  uint8_t behind;            /* LOOK: lookbehind */
  uint8_t greedy;            /* QUANT */
  uint8_t folded;            /* CLASS: the set is already case-folded (v mode); the input is still canonicalized */
  uint32_t cp;               /* CHAR */
  rx_cpset set;              /* CLASS (code points; in non-u mode code units) */
  rx_strlist strs;           /* CLASS in v mode: the strings (length != 1) */
  struct rx_node** kids; uint32_t nkids;   /* SEQ, ALT */
  struct rx_node* body;      /* GROUP, QUANT, LOOK */
  uint32_t group;            /* GROUP: capture index (0 = non-capturing) */
  uint32_t min, max;         /* QUANT (max RX_INFINITY) */
  uint32_t group_lo, group_hi;  /* QUANT: the capture indices inside the body, [lo, hi], lo > hi when none */
  uint32_t* refs; uint32_t nrefs;   /* BACKREF: the group indices (several for a duplicated name) */
} rx_node;

/* ---- the compiled program ---- */
typedef struct rx_set { uint8_t bits[32]; const uint32_t* ranges; uint32_t nranges; uint32_t* base; } rx_set;  /* bits: < 256; ranges: the rest; base: the owned pairs */
typedef struct rx_strset { rx_cpstr* s; uint32_t n; uint32_t set_index; } rx_strset;            /* strings longest first */

/* opcodes (a uint32 word each; arguments follow as words) */
enum {
  RX_OP_FAIL = 0, RX_OP_ACCEPT, RX_OP_LOOK_END,
  RX_OP_JMP,          /* target */
  RX_OP_PUSH_BT,      /* target: a choice point (resume at target with the current position) */
  RX_OP_SAVE,         /* reg: reg = pos */
  RX_OP_CLEAR,        /* lo hi: regs[2*lo .. 2*hi+1] = -1 */
  RX_OP_CNT_INIT,     /* reg: counter = 0 */
  RX_OP_CNT_INC_JL,   /* reg n target: ++counter; if counter < n goto target */
  RX_OP_CNT_JGE,      /* reg n target: if counter >= n goto target */
  RX_OP_EMPTY_START,  /* reg: reg = pos */
  RX_OP_EMPTY_CHECK,  /* reg: if pos == reg fail */
  RX_OP_EMPTY_CHECK_OPT, /* reg creg min: if counter >= min and pos == reg fail (an optional iteration matched empty) */
  RX_OP_LOOK,         /* kind(bit0 negate, bit1 behind) end: run the body (next word .. end) as a sub-match */
  RX_OP_BACKREF,      /* group */
  RX_OP_BACKREF_LIST, /* n group...: the first set one */
  RX_OP_BOL, RX_OP_EOL, RX_OP_BOL_M, RX_OP_EOL_M, RX_OP_WORDB, RX_OP_NWORDB,
  /* text ops: an immediate; the _I forms compare Canonicalize(input); the _CP forms read a code point */
  RX_OP_CHAR, RX_OP_CHAR_I, RX_OP_CHAR2, RX_OP_CHARS, RX_OP_ANY, RX_OP_ANY_ALL,
  RX_OP_CLASS, RX_OP_NCLASS, RX_OP_CLASS_I, RX_OP_NCLASS_I, RX_OP_STRINGS,
  /* loops over a one-character matcher: matcher arg min max */
  RX_OP_LOOP_GREEDY, RX_OP_LOOP_LAZY,
  RX_OP__COUNT
};
/* flag bits on the opcode word */
#define RX_OP_BW   0x100u    /* backward (inside a lookbehind) */
#define RX_OP_CP   0x200u    /* code point mode (u / v): a surrogate pair is one character */
#define RX_OP_IU   0x400u    /* WORDB/NWORDB, BACKREF: the ignoreCase+unicode word set / fold compare */
#define RX_OP_I    0x800u    /* BACKREF: case-insensitive (non-u canonicalize) */
#define RX_OP_MASK 0xFFu
/* the one-character matchers of LOOP_*: the text opcode (CHAR, CHAR_I, CHAR2 (arg = set of two
   packed? no: CHAR2 uses two words), ANY, ANY_ALL, CLASS, NCLASS, CLASS_I, NCLASS_I) */

struct rx_program {
  uint32_t refs;
  uint32_t flags;
  uint32_t ngroups;           /* capturing groups, group 0 excluded */
  uint32_t ncap_regs;         /* 2 * (ngroups + 1) */
  uint32_t nregs;             /* capture registers + counters + saved positions */
  uint32_t* code; uint32_t code_len;
  rx_set* sets; uint32_t nsets;
  rx_strset* strsets; uint32_t nstrsets;
  uint16_t** names; uint32_t* name_lens;   /* [ngroups + 1], NULL when unnamed */
  uint32_t nnamed;
  /* analysis */
  uint32_t min_len;
  uint8_t anchored_start;
  uint8_t first_valid;        /* first_bits / first_wide describe the first character of a match */
  uint8_t first_wide;         /* a first character >= 256 is possible */
  uint8_t first_bits[32];
  uint16_t* prefix; uint32_t prefix_len;   /* a literal prefix (code units), case-sensitive patterns */
  uint8_t prefix_whole;       /* the pattern is exactly the prefix (no captures, no assertions) */
  void* owned;                /* one malloc holding code, sets, ranges, names, prefix */
};

/* parser (rx_parse.c): returns the AST or longjmps on error with err filled */
rx_node* rx_parse(rx_arena* arena, const uint16_t* src, uint32_t len, uint32_t flags,
                  uint32_t* ngroups, uint16_t*** names, uint32_t** name_lens, rx_error* err);
/* compiler (rx_compile.c) */
rx_program* rx_compile_ast(rx_arena* arena, rx_node* root, uint32_t flags, uint32_t ngroups,
                           uint16_t** names, uint32_t* name_lens);

/* unicode (rx_unicode.c): the flat BMP tables (mapping + 1, 0 = identity), built by rx_unicode_init */
extern const uint16_t* rx_g_canon_bmp;
extern const uint16_t* rx_g_fold_bmp;
void rx_unicode_init(void);
static inline uint32_t rx_canon_nonu_fast(uint32_t cu){ uint16_t m = rx_g_canon_bmp[cu]; return m ? (uint32_t)(m - 1u) : cu; }
static inline uint32_t rx_fold_u_fast(uint32_t cp){ if (cp < 0x10000u){ uint16_t m = rx_g_fold_bmp[cp]; return m ? (uint32_t)(m - 1u) : cp; } return rx_fold_u(cp); }
const uint32_t* rx_prop_lookup(const char* name, uint32_t name_len, int kind, uint32_t* nranges);
int rx_is_id_start(uint32_t cp);
int rx_is_id_continue(uint32_t cp);
/* the (cp, mapped) lists for canonicalizing a set at compile time */
const uint32_t* rx_canon_pairs(uint32_t* n);
const uint32_t* rx_fold_pairs(uint32_t* n);
void rx_class_bitmap_ranges(rx_set* out, const rx_cpset* s);

#endif
