/* rx_native.h: what a natively compiled matcher (the C that rx_emit.c writes for a regexp
   literal at build time, docs/regexp_vm_design.md "The native tier") shares with the
   interpreter: the run context, the backtrack stack and its entries, the character and set
   helpers, the case tables. Included by rx_internal.h (the engine) and, through
   ts_regexp_adapter.h, by the generated program C. */
#ifndef RX_NATIVE_H
#define RX_NATIVE_H
#include "rx.h"
#include <string.h>
#include <stdlib.h>

/* the backtrack stack's entries: four words, the kind first */
enum { RX_BT_RESUME = 1, RX_BT_RESTORE = 2, RX_BT_GREEDY = 3, RX_BT_LAZY = 4 };
#define RX_BT_WORDS 4u

typedef struct rx_ctx {
  const rx_program* p;
  const uint8_t* in8; const uint16_t* in16;
  uint32_t len;
  int32_t* regs;
  uint32_t* bt; uint32_t bt_sp, bt_cap;
} rx_ctx;

/* a natively compiled run, the interpreter run's contract: 1 on ACCEPT with *out_pos the match
   end, 0 when the backtrack stack unwinds to base, RX_EXEC_OVERFLOW past the limit */
typedef int (*rx_native_fn)(rx_ctx* c, uint32_t pos, uint32_t base, uint32_t* out_pos);

/* bind a literal's natively compiled matchers to its program (the search loop then runs them
   instead of the interpreter); the first binding sticks, as the program is shared by every site
   of the pattern, and NULL leaves the interpreter */
void rx_set_native(rx_program* p, rx_native_fn narrow, rx_native_fn wide);

/* the backtrack stack grows up to the limit (0 at the limit) */
int rx_bt_grow(rx_ctx* c);
static inline int rx_bt_push(rx_ctx* c, uint32_t a, uint32_t b, uint32_t cc, uint32_t d){
  if (c->bt_sp + RX_BT_WORDS > c->bt_cap && !rx_bt_grow(c)) return 1;
  uint32_t* e = c->bt + c->bt_sp; e[0] = a; e[1] = b; e[2] = cc; e[3] = d; c->bt_sp += RX_BT_WORDS;
  return 0;
}
/* a positive lookaround that matched keeps only its register restores, in order */
static inline void rx_bt_compact(rx_ctx* c, uint32_t mark){
  uint32_t wr = mark;
  for (uint32_t rd = mark; rd < c->bt_sp; rd += RX_BT_WORDS){
    if (c->bt[rd] == RX_BT_RESTORE){ if (wr != rd) memcpy(c->bt + wr, c->bt + rd, sizeof(uint32_t) * RX_BT_WORDS); wr += RX_BT_WORDS; }
  }
  c->bt_sp = wr;
}
/* a negative lookaround whose body matched: undo its register writes */
static inline void rx_bt_unwind(rx_ctx* c, uint32_t mark){
  while (c->bt_sp > mark){
    uint32_t* e = c->bt + (c->bt_sp - RX_BT_WORDS); c->bt_sp -= RX_BT_WORDS;
    if (e[0] == RX_BT_RESTORE) c->regs[e[1]] = (int32_t)e[2];
  }
}

static inline int rx_is_lt(uint32_t ch){ return ch == 0x0A || ch == 0x0D || ch == 0x2028 || ch == 0x2029; }
static inline int rx_is_lead(uint32_t c){ return c >= 0xD800u && c <= 0xDBFFu; }
static inline int rx_is_trail(uint32_t c){ return c >= 0xDC00u && c <= 0xDFFFu; }
static inline int rx_is_word(uint32_t ch){ return (ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch == '_'; }
static inline int rx_is_word_iu(uint32_t ch){ return rx_is_word(ch) || ch == 0x017Fu || ch == 0x212Au; }
/* membership in a class table: the bitmap below 256, sorted inclusive pairs above */
static inline int rx_ranges_has_n(const uint32_t* pairs, uint32_t n, uint32_t cp){
  uint32_t lo = 0, hi = n;
  while (lo < hi){
    uint32_t mid = (lo + hi) / 2;
    if (cp < pairs[2*mid]) hi = mid; else if (cp > pairs[2*mid+1]) lo = mid + 1; else return 1;
  }
  return 0;
}
static inline int rx_set_has_n(const uint8_t* bits, const uint32_t* ranges, uint32_t n, uint32_t ch){
  if (ch < 256u) return (bits[ch >> 3] >> (ch & 7u)) & 1u;
  return n ? rx_ranges_has_n(ranges, n, ch) : 0;
}
/* the case tables (the flat BMP maps, mapping + 1 with 0 for identity; built by the first
   compile, rx_unicode.c) */
extern const uint16_t* rx_g_canon_bmp;
extern const uint16_t* rx_g_fold_bmp;
static inline uint32_t rx_canon_nonu_fast(uint32_t cu){ uint16_t m = rx_g_canon_bmp[cu]; return m ? (uint32_t)(m - 1u) : cu; }
static inline uint32_t rx_fold_u_fast(uint32_t cp){ if (cp < 0x10000u){ uint16_t m = rx_g_fold_bmp[cp]; return m ? (uint32_t)(m - 1u) : cp; } return rx_fold_u(cp); }
/* a backreference compare per input width (w: the op word, its flags read) and the step back
   over one character of a simple loop, exported by rx_vm.c */
uint32_t rx_backref_cmp_8(const rx_ctx* c, uint32_t w, uint32_t s, uint32_t e, uint32_t pos);
uint32_t rx_backref_cmp_16(const rx_ctx* c, uint32_t w, uint32_t s, uint32_t e, uint32_t pos);
uint32_t rx_unstep_8(const rx_ctx* c, uint32_t w, uint32_t pos);
uint32_t rx_unstep_16(const rx_ctx* c, uint32_t w, uint32_t pos);

#endif
