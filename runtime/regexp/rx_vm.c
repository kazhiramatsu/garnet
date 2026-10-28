/* rx_vm.c: the matcher of the regexp engine (docs/regexp_vm_design.md). The search loop with
   the program's prefilters, and the backtracking interpreter instantiated for Latin-1 and
   UTF-16 input (RX_WIDE 0 / 1): an explicit backtrack stack of 4-word entries, registers for
   captures and loop state, computed-goto dispatch, lookarounds as sub-runs over the same stack. */
#include "rx_internal.h"
#include <stdio.h>

enum { BT_RESUME = 1, BT_RESTORE = 2, BT_GREEDY = 3, BT_LAZY = 4 };
#define BT_WORDS 4u
#define BT_LIMIT_WORDS (RX_BACKTRACK_LIMIT_BYTES / 4u)

typedef struct rx_ctx {
  const rx_program* p;
  const uint8_t* in8; const uint16_t* in16;
  uint32_t len;
  int32_t* regs;
  uint32_t* bt; uint32_t bt_sp, bt_cap;
} rx_ctx;

/* the per-thread scratch: the backtrack stack and the register file */
typedef struct rx_scratch { int32_t* regs; uint32_t regs_cap; uint32_t* bt; uint32_t bt_cap; } rx_scratch;
static _Thread_local rx_scratch g_scratch;

static int bt_grow(rx_ctx* c){
  uint32_t cap = c->bt_cap ? c->bt_cap * 2 : 4096;
  if (cap > BT_LIMIT_WORDS){ if (c->bt_cap >= BT_LIMIT_WORDS) return 0; cap = BT_LIMIT_WORDS; }
  uint32_t* n = (uint32_t*)realloc(c->bt, sizeof(uint32_t) * cap);
  if (!n) return 0;
  c->bt = n; c->bt_cap = cap;
  g_scratch.bt = n; g_scratch.bt_cap = cap;
  return 1;
}

static inline int is_lt(uint32_t ch){ return ch == 0x0A || ch == 0x0D || ch == 0x2028 || ch == 0x2029; }
static inline int is_word(uint32_t ch){ return (ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch == '_'; }
static inline int is_word_iu(uint32_t ch){ return is_word(ch) || ch == 0x017Fu || ch == 0x212Au; }
static inline int set_has(const rx_set* s, uint32_t ch){
  if (ch < 256u) return (s->bits[ch >> 3] >> (ch & 7u)) & 1u;
  return s->nranges ? rx_ranges_has(s->ranges, s->nranges, ch) : 0;
}

#define RX_WIDE 0
#include "rx_vm_body.h"
#undef RX_WIDE
#define RX_WIDE 1
#include "rx_vm_body.h"
#undef RX_WIDE

/* ---- the search loop ---- */
static void reset_caps(rx_ctx* c){ for (uint32_t i = 0; i < c->p->ncap_regs; i++) c->regs[i] = -1; }

static int try_at(rx_ctx* c, int wide, uint32_t pos, int32_t* caps){
  reset_caps(c);
  c->bt_sp = 0;
  uint32_t end;
  int r = wide ? rx_run_16(c, 0, pos, 0, &end) : rx_run_8(c, 0, pos, 0, &end);
  if (r == 1) memcpy(caps, c->regs, sizeof(int32_t) * c->p->ncap_regs);
  return r;
}

/* the literal prefix: the first position >= from where it occurs, or UINT32_MAX */
static uint32_t find_prefix(const rx_ctx* c, int wide, uint32_t from){
  const uint16_t* pre = c->p->prefix; uint32_t plen = c->p->prefix_len;
  if (plen > c->len) return UINT32_MAX;
  uint32_t last = c->len - plen;
  if (!wide){
    uint16_t first = pre[0];
    if (first > 0xFFu) return UINT32_MAX;
    for (uint32_t i = 1; i < plen; i++) if (pre[i] > 0xFFu) return UINT32_MAX;
    uint32_t pos = from;
    while (pos <= last){
      const uint8_t* hit = (const uint8_t*)memchr(c->in8 + pos, (int)first, last - pos + 1u);
      if (!hit) return UINT32_MAX;
      pos = (uint32_t)(hit - c->in8);
      uint32_t k = 1;
      while (k < plen && c->in8[pos + k] == (uint8_t)pre[k]) k++;
      if (k == plen) return pos;
      pos++;
    }
    return UINT32_MAX;
  }
  for (uint32_t pos = from; pos <= last; pos++){
    if (c->in16[pos] != pre[0]) continue;
    uint32_t k = 1;
    while (k < plen && c->in16[pos + k] == pre[k]) k++;
    if (k == plen) return pos;
  }
  return UINT32_MAX;
}

int rx_exec(const rx_program* p, const void* input, uint32_t len, int wide, uint32_t start, int32_t* caps){
  rx_ctx c;   /* the case tables were built by the compile */
  c.p = p; c.in8 = (const uint8_t*)input; c.in16 = (const uint16_t*)input; c.len = len;
  rx_scratch* S = &g_scratch;   /* one thread-local fetch */
  if (S->regs_cap < p->nregs){
    uint32_t cap = p->nregs < 64 ? 64 : p->nregs;
    int32_t* r = (int32_t*)realloc(S->regs, sizeof(int32_t) * cap);
    if (!r) return RX_EXEC_OVERFLOW;
    S->regs = r; S->regs_cap = cap;
  }
  c.regs = S->regs; c.bt = S->bt; c.bt_cap = S->bt_cap; c.bt_sp = 0;
  if (start > len) return 0;
  int cp_mode = (p->flags & RX_F_EITHER_UNICODE) != 0;
  int sticky = (p->flags & RX_F_STICKY) != 0;
  /* a start inside a surrogate pair moves to the pair (the code point containing lastIndex) */
  if (cp_mode && wide && start > 0 && start < len && rx_is_trail(c.in16[start]) && rx_is_lead(c.in16[start - 1])) start--;
  if (p->anchored_start){
    if (start != 0) return 0;
    return try_at(&c, wide, 0, caps);
  }
  if (sticky) return try_at(&c, wide, start, caps);
  if (p->min_len > len) return 0;
  uint32_t last = len - p->min_len;
  uint32_t pos = start;
  if (p->prefix_whole){
    uint32_t hit = find_prefix(&c, wide, pos);
    if (hit == UINT32_MAX) return 0;
    for (uint32_t i = 0; i < p->ncap_regs; i++) caps[i] = -1;
    caps[0] = (int32_t)hit; caps[1] = (int32_t)(hit + p->prefix_len);
    return 1;
  }
  while (pos <= last){
    if (p->prefix_len){
      uint32_t hit = find_prefix(&c, wide, pos);
      if (hit == UINT32_MAX) return 0;
      pos = hit;
    } else if (p->first_valid){
      if (!wide){
        const uint8_t* tab = p->first_tab;
        while (pos <= last && !tab[c.in8[pos]]) pos++;
      } else {
        while (pos <= last){
          uint32_t u = c.in16[pos];
          if (u < 256u ? ((p->first_bits[u >> 3] >> (u & 7u)) & 1u) : p->first_wide) break;
          pos++;
        }
      }
      if (pos > last) return 0;
    }
    int r = try_at(&c, wide, pos, caps);
    if (r) return r;
    pos++;   /* every code unit, as V8 does in unicode mode too (a zero-width match inside a pair) */
  }
  return 0;
}

/* ---- disassembly ---- */
static const char* op_name(uint32_t op){
  static const char* names[RX_OP__COUNT] = {
    "FAIL", "ACCEPT", "LOOK_END", "JMP", "PUSH_BT", "SAVE", "CLEAR", "CNT_INIT", "CNT_INC_JL", "CNT_JGE",
    "EMPTY_START", "EMPTY_CHECK", "EMPTY_CHECK_OPT", "LOOK", "BACKREF", "BACKREF_LIST", "BOL", "EOL", "BOL_M", "EOL_M",
    "WORDB", "NWORDB", "CHAR", "CHAR_I", "CHAR2", "CHARS", "ANY", "ANY_ALL", "CLASS", "NCLASS", "CLASS_I", "NCLASS_I",
    "STRINGS", "LOOP_GREEDY", "LOOP_LAZY", "SAVE_NR" };
  return op < RX_OP__COUNT ? names[op] : "?";
}
static uint32_t op_len(const uint32_t* code, uint32_t pc){
  uint32_t op = code[pc] & RX_OP_MASK;
  switch (op){
    case RX_OP_JMP: case RX_OP_PUSH_BT: case RX_OP_SAVE: case RX_OP_SAVE_NR: case RX_OP_CNT_INIT: case RX_OP_EMPTY_START: case RX_OP_EMPTY_CHECK:
    case RX_OP_BACKREF: case RX_OP_CHAR: case RX_OP_CHAR_I: case RX_OP_CLASS: case RX_OP_NCLASS: case RX_OP_CLASS_I: case RX_OP_NCLASS_I: case RX_OP_STRINGS:
      return 2;
    case RX_OP_CLEAR: case RX_OP_CHAR2: case RX_OP_LOOK: return 3;
    case RX_OP_CNT_INC_JL: case RX_OP_CNT_JGE: case RX_OP_EMPTY_CHECK_OPT: return 4;
    case RX_OP_BACKREF_LIST: return 2 + code[pc + 1];
    case RX_OP_CHARS: return 2 + code[pc + 1];
    case RX_OP_LOOP_GREEDY: case RX_OP_LOOP_LAZY: return 6;
    default: return 1;
  }
}
char* rx_disassemble(const rx_program* p){
  size_t cap = 4096, n = 0; char* out = (char*)malloc(cap);
  if (!out) return NULL;
  #define APP(...) do { char tmp[256]; int kk_ = snprintf(tmp, sizeof tmp, __VA_ARGS__); if (n + (size_t)kk_ + 1 > cap){ cap = (cap + (size_t)kk_) * 2; out = (char*)realloc(out, cap); if (!out) return NULL; } memcpy(out + n, tmp, (size_t)kk_); n += (size_t)kk_; } while (0)
  APP("groups=%u regs=%u min_len=%u anchored=%d first=%d prefix_len=%u whole=%d\n", p->ngroups, p->nregs, p->min_len, p->anchored_start, p->first_valid, p->prefix_len, p->prefix_whole);
  for (uint32_t pc = 0; pc < p->code_len;){
    uint32_t w = p->code[pc]; uint32_t l = op_len(p->code, pc);
    APP("%4u: %s%s%s%s%s", pc, op_name(w & RX_OP_MASK), (w & RX_OP_BW) ? " bw" : "", (w & RX_OP_CP) ? " cp" : "", (w & RX_OP_IU) ? " iu" : "", (w & RX_OP_I) ? " i" : "");
    for (uint32_t k = 1; k < l; k++) APP(" %u", p->code[pc + k]);
    APP("\n");
    pc += l;
  }
  out[n] = 0;
  #undef APP
  return out;
}
