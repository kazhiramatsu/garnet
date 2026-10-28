/* rx_compile.c: the AST to bytecode compiler of the regexp engine (docs/regexp_vm_design.md):
   the analysis facts the search loop uses (min length, anchoring, the first-character set, a
   literal prefix), case-insensitive canonicalization of characters and classes, the loop
   forms (simple single-character loops, counted loops with registers), lookarounds as
   sub-programs, lookbehind bodies emitted backward. */
#include "rx_internal.h"

typedef struct cstate {
  rx_arena* a;
  uint32_t flags; int u;           /* code point mode */
  int bw;                          /* emitting a lookbehind body */
  uint32_t ngroups, ncap_regs, nregs;
  uint32_t* code; uint32_t len, cap;
  rx_set* sets; uint32_t nsets, sets_cap;
  rx_cpset mapped_keys;            /* every code point / unit with a non-identity Canonicalize */
  int mapped_ready;
} cstate;

/* ---- code buffer ---- */
static void emit(cstate* c, uint32_t w){
  if (c->len == c->cap){
    uint32_t cap = c->cap ? c->cap * 2 : 256;
    uint32_t* n = (uint32_t*)realloc(c->code, sizeof(uint32_t) * cap);
    if (!n) abort();
    c->code = n; c->cap = cap;
  }
  c->code[c->len++] = w;
}
static uint32_t here(cstate* c){ return c->len; }
static uint32_t emit_label(cstate* c){ uint32_t at = c->len; emit(c, 0); return at; }
static void patch(cstate* c, uint32_t at, uint32_t target){ c->code[at] = target; }

static uint32_t text_flags(cstate* c){ return (c->bw ? RX_OP_BW : 0) | (c->u ? RX_OP_CP : 0); }

/* ---- the case canonicalization ---- */
static uint32_t canon(cstate* c, uint32_t cp){ return c->u ? rx_fold_u(cp) : rx_canon_nonu(cp); }
static const uint32_t* canon_list(cstate* c, uint32_t* n){ return c->u ? rx_fold_pairs(n) : rx_canon_pairs(n); }
static void ensure_mapped(cstate* c){
  if (c->mapped_ready) return;
  uint32_t n; const uint32_t* l = canon_list(c, &n);
  for (uint32_t i = 0; i < n; i++) rx_cpset_add(c->a, &c->mapped_keys, l[2*i], l[2*i]);
  c->mapped_ready = 1;
}
/* the set { canon(m) : m in s } */
static rx_cpset canon_set(cstate* c, const rx_cpset* s){
  ensure_mapped(c);
  rx_cpset out = rx_cpset_subtract(c->a, s, &c->mapped_keys);
  uint32_t n; const uint32_t* l = canon_list(c, &n);
  for (uint32_t i = 0; i < n; i++) if (rx_cpset_has(s, l[2*i])) rx_cpset_add(c->a, &out, l[2*i+1], l[2*i+1]);
  return out;
}
/* the characters whose Canonicalize equals canon(cp): cp, canon(cp) and every mapped char
   with that image; at most `cap` of them are written, the count is returned */
static uint32_t equiv_class(cstate* c, uint32_t cp, uint32_t* out, uint32_t cap){
  uint32_t k = canon(c, cp);
  uint32_t n = 0;
  out[n++] = k;
  if (cp != k && n < cap) out[n++] = cp;
  uint32_t ln; const uint32_t* l = canon_list(c, &ln);
  for (uint32_t i = 0; i < ln && n < cap; i++)
    if (l[2*i+1] == k && l[2*i] != cp && l[2*i] != k){ out[n++] = l[2*i]; }
  return n;
}

/* ---- sets ---- */
static uint32_t add_set(cstate* c, const rx_cpset* s){
  if (c->nsets == c->sets_cap){
    uint32_t cap = c->sets_cap ? c->sets_cap * 2 : 8;
    rx_set* n = (rx_set*)realloc(c->sets, sizeof(rx_set) * cap);
    if (!n) abort();
    c->sets = n; c->sets_cap = cap;
  }
  rx_set* t = &c->sets[c->nsets];
  rx_cpset copy = {0, 0, 0};
  if (s->n){
    copy.r = (uint32_t*)malloc(sizeof(uint32_t) * 2 * s->n);
    if (!copy.r) abort();
    memcpy(copy.r, s->r, sizeof(uint32_t) * 2 * s->n);
    copy.n = s->n;
  }
  rx_class_bitmap_ranges(t, &copy);   /* ranges points into copy.r */
  t->base = copy.r;
  c->nsets++;
  return c->nsets - 1;
}

/* ---- analysis ---- */
static uint32_t cp_units(uint32_t cp){ return cp >= 0x10000u ? 2u : 1u; }
static uint32_t min_len(cstate* c, rx_node* n){
  switch (n->kind){
    case RX_N_CHAR: return cp_units(n->cp);
    case RX_N_DOT: return 1;
    case RX_N_CLASS: {
      uint32_t m = n->set.n ? 1u : 0xFFFFFFFFu;
      for (uint32_t i = 0; i < n->strs.n; i++){
        uint32_t u = 0; for (uint32_t k = 0; k < n->strs.s[i].n; k++) u += cp_units(n->strs.s[i].cps[k]);
        if (u < m) m = u;
      }
      return m == 0xFFFFFFFFu ? 1u : m;
    }
    case RX_N_SEQ: { uint64_t s = 0; for (uint32_t i = 0; i < n->nkids; i++) s += min_len(c, n->kids[i]); return s > 0x7FFFFFFFu ? 0x7FFFFFFFu : (uint32_t)s; }
    case RX_N_ALT: { uint32_t m = 0xFFFFFFFFu; for (uint32_t i = 0; i < n->nkids; i++){ uint32_t k = min_len(c, n->kids[i]); if (k < m) m = k; } return m; }
    case RX_N_GROUP: return min_len(c, n->body);
    case RX_N_QUANT: { uint64_t s = (uint64_t)min_len(c, n->body) * n->min; return s > 0x7FFFFFFFu ? 0x7FFFFFFFu : (uint32_t)s; }
    default: return 0;   /* EMPTY, assertions, LOOK, BACKREF */
  }
}
static int anchored(rx_node* n){
  switch (n->kind){
    case RX_N_BOL: return !(n->mflags & RX_M_M);
    case RX_N_SEQ: return n->nkids > 0 && anchored(n->kids[0]);
    case RX_N_ALT: for (uint32_t i = 0; i < n->nkids; i++) if (!anchored(n->kids[i])) return 0; return 1;
    case RX_N_GROUP: return anchored(n->body);
    case RX_N_QUANT: return n->min >= 1 && anchored(n->body);
    default: return 0;
  }
}
/* the first-character set: bits for units below 256, `wide` for any unit above; returns 0 when
   the set is unknown (a backreference first). *nullable: the node can match empty. */
typedef struct { uint8_t bits[32]; int wide; int valid; } firstset;
static void fs_add(firstset* f, uint32_t u){ if (u < 256u) f->bits[u >> 3] |= (uint8_t)(1u << (u & 7u)); else f->wide = 1; }
static void fs_add_set(cstate* c, firstset* f, const rx_cpset* s, int negate, int icase, int folded){
  if (icase){
    rx_cpset cs = folded ? *s : canon_set(c, s);
    for (uint32_t u = 0; u < 256u; u++){ int in = rx_cpset_has(&cs, canon(c, u)); if (in != negate) fs_add(f, u); }
    f->wide = 1;
    return;
  }
  if (negate){
    for (uint32_t u = 0; u < 256u; u++) if (!rx_cpset_has(s, u)) fs_add(f, u);
    f->wide = 1;
    return;
  }
  for (uint32_t i = 0; i < s->n; i++){
    uint32_t lo = s->r[2*i], hi = s->r[2*i+1];
    for (uint32_t u = lo; u <= hi && u < 256u; u++) fs_add(f, u);
    if (hi >= 256u){
      f->wide = 1;
      if (c->u && hi >= 0x10000u){ /* a supplementary first character starts with a lead surrogate: wide */ }
    }
  }
}
static void first_of(cstate* c, rx_node* n, firstset* f, int* nullable){
  *nullable = 0;
  switch (n->kind){
    case RX_N_EMPTY: *nullable = 1; return;
    case RX_N_CHAR: {
      uint32_t cp = n->cp;
      if (cp >= 0x10000u){ fs_add(f, 0xD800u + ((cp - 0x10000u) >> 10)); return; }
      if (n->mflags & RX_M_I){
        uint32_t eq[16]; uint32_t k = equiv_class(c, cp, eq, 16);
        for (uint32_t i = 0; i < k; i++) fs_add(f, eq[i]);
        if (k == 16) f->wide = 1;
      } else fs_add(f, cp);
      return;
    }
    case RX_N_DOT: for (uint32_t u = 0; u < 256u; u++) if (u != 0x0A && u != 0x0D) fs_add(f, u); if (n->mflags & RX_M_S){ fs_add(f, 0x0A); fs_add(f, 0x0D); } f->wide = 1; return;
    case RX_N_CLASS: {
      fs_add_set(c, f, &n->set, n->negate, (n->mflags & RX_M_I) != 0, n->folded);
      for (uint32_t i = 0; i < n->strs.n; i++){
        if (n->strs.s[i].n == 0){ *nullable = 1; continue; }
        uint32_t cp = n->strs.s[i].cps[0];
        if (n->mflags & RX_M_I){ uint32_t eq[16]; uint32_t k = equiv_class(c, cp, eq, 16); for (uint32_t j = 0; j < k; j++) fs_add(f, eq[j]); if (k == 16) f->wide = 1; }
        else if (cp >= 0x10000u) fs_add(f, 0xD800u + ((cp - 0x10000u) >> 10)); else fs_add(f, cp);
      }
      return;
    }
    case RX_N_SEQ: {
      for (uint32_t i = 0; i < n->nkids; i++){
        int nb; first_of(c, n->kids[i], f, &nb);
        if (!f->valid) return;
        if (!nb) return;
      }
      *nullable = 1; return;
    }
    case RX_N_ALT: {
      int any_null = 0;
      for (uint32_t i = 0; i < n->nkids; i++){ int nb; first_of(c, n->kids[i], f, &nb); if (!f->valid) return; any_null |= nb; }
      *nullable = any_null; return;
    }
    case RX_N_GROUP: first_of(c, n->body, f, nullable); return;
    case RX_N_QUANT: { int nb; first_of(c, n->body, f, &nb); *nullable = nb || n->min == 0; return; }
    case RX_N_BOL: case RX_N_EOL: case RX_N_WORDB: case RX_N_NWORDB: case RX_N_LOOK: *nullable = 1; return;
    case RX_N_BACKREF: f->valid = 0; *nullable = 1; return;
  }
}

/* ---- emission ---- */
static void compile_node(cstate* c, rx_node* n);

static void emit_char(cstate* c, rx_node* n){
  uint32_t cp = n->cp;
  uint32_t tf = text_flags(c);
  if (n->mflags & RX_M_I){
    uint32_t eq[4]; uint32_t k = equiv_class(c, cp, eq, 4);
    if (k == 2){ emit(c, RX_OP_CHAR2 | tf); emit(c, eq[0]); emit(c, eq[1]); return; }
    if (k > 2){ emit(c, RX_OP_CHAR_I | tf); emit(c, canon(c, cp)); return; }
  }
  emit(c, RX_OP_CHAR | tf); emit(c, cp);
}
static void emit_class(cstate* c, rx_node* n){
  uint32_t tf = text_flags(c);
  if (n->mflags & RX_M_I){
    rx_cpset cs = n->folded ? n->set : canon_set(c, &n->set);
    uint32_t id = add_set(c, &cs);
    emit(c, (n->negate ? RX_OP_NCLASS_I : RX_OP_CLASS_I) | tf); emit(c, id);
  } else {
    uint32_t id = add_set(c, &n->set);
    emit(c, (n->negate ? RX_OP_NCLASS : RX_OP_CLASS) | tf); emit(c, id);
  }
}
/* a v-mode class with strings: an alternation of the strings (longest first) then the set */
static void emit_class_strings(cstate* c, rx_node* n){
  /* order: longest first (stable) */
  uint32_t m = n->strs.n;
  uint32_t* order = (uint32_t*)rx_arena_alloc(c->a, sizeof(uint32_t) * m);
  for (uint32_t i = 0; i < m; i++) order[i] = i;
  for (uint32_t i = 1; i < m; i++){ uint32_t k = order[i]; uint32_t j = i; while (j > 0 && n->strs.s[order[j-1]].n < n->strs.s[k].n){ order[j] = order[j-1]; j--; } order[j] = k; }
  uint32_t* ends = (uint32_t*)rx_arena_alloc(c->a, sizeof(uint32_t) * (m + 1)); uint32_t nends = 0;
  int has_set = n->set.n > 0 || n->negate;
  for (uint32_t i = 0; i < m; i++){
    const rx_cpstr* s = &n->strs.s[order[i]];
    int last = (i + 1 == m) && !has_set;
    uint32_t bt = 0;
    if (!last){ emit(c, RX_OP_PUSH_BT); bt = emit_label(c); }
    if (c->bw){ for (uint32_t k = s->n; k > 0; k--){ rx_node ch = *n; ch.kind = RX_N_CHAR; ch.cp = s->cps[k-1]; emit_char(c, &ch); } }
    else { for (uint32_t k = 0; k < s->n; k++){ rx_node ch = *n; ch.kind = RX_N_CHAR; ch.cp = s->cps[k]; emit_char(c, &ch); } }
    if (!last){ emit(c, RX_OP_JMP); ends[nends++] = emit_label(c); patch(c, bt, here(c)); }
  }
  if (has_set) emit_class(c, n);
  for (uint32_t i = 0; i < nends; i++) patch(c, ends[i], here(c));
}

static void emit_save(cstate* c, uint32_t reg){ emit(c, RX_OP_SAVE); emit(c, reg); }

static int body_can_be_empty(cstate* c, rx_node* n){ return min_len(c, n) == 0; }

/* a one-character body of a quantifier: the matcher opcode and its argument(s) for LOOP_* */
static int simple_matcher(cstate* c, rx_node* n, uint32_t* op, uint32_t* arg0, uint32_t* arg1){
  uint32_t tf = text_flags(c);
  if (n->kind == RX_N_CHAR){
    if (cp_units(n->cp) == 2 && !c->u) return 0;
    if (n->mflags & RX_M_I){
      uint32_t eq[4]; uint32_t k = equiv_class(c, n->cp, eq, 4);
      if (k == 1){ *op = RX_OP_CHAR | tf; *arg0 = n->cp; *arg1 = 0; return 1; }
      if (k == 2){ *op = RX_OP_CHAR2 | tf; *arg0 = eq[0]; *arg1 = eq[1]; return 1; }
      *op = RX_OP_CHAR_I | tf; *arg0 = canon(c, n->cp); *arg1 = 0; return 1;
    }
    *op = RX_OP_CHAR | tf; *arg0 = n->cp; *arg1 = 0; return 1;
  }
  if (n->kind == RX_N_DOT){ *op = ((n->mflags & RX_M_S) ? RX_OP_ANY_ALL : RX_OP_ANY) | tf; *arg0 = 0; *arg1 = 0; return 1; }
  if (n->kind == RX_N_CLASS && n->strs.n == 0){
    if (n->mflags & RX_M_I){ rx_cpset cs = n->folded ? n->set : canon_set(c, &n->set); *arg0 = add_set(c, &cs); *op = (n->negate ? RX_OP_NCLASS_I : RX_OP_CLASS_I) | tf; }
    else { *arg0 = add_set(c, &n->set); *op = (n->negate ? RX_OP_NCLASS : RX_OP_CLASS) | tf; }
    *arg1 = 0; return 1;
  }
  return 0;
}

static void compile_quant(cstate* c, rx_node* n){
  rx_node* body = n->body;
  uint32_t min = n->min, max = n->max;
  if (max == 0){ /* x{0} matches empty; the body's groups stay unset */ return; }
  uint32_t op, a0, a1;
  if (simple_matcher(c, body, &op, &a0, &a1)){
    emit(c, n->greedy ? RX_OP_LOOP_GREEDY : RX_OP_LOOP_LAZY);
    emit(c, op); emit(c, a0); emit(c, a1); emit(c, min); emit(c, max);
    return;
  }
  int has_groups = n->group_lo <= n->group_hi;
  int empty_ok = body_can_be_empty(c, body);
  if (min == 0 && max == 1){
    /* x? : a choice point, the body, an empty check when the body can match empty */
    uint32_t ereg = 0;
    if (empty_ok) ereg = c->nregs++;
    uint32_t exit_lbl;
    if (n->greedy){ emit(c, RX_OP_PUSH_BT); exit_lbl = emit_label(c); }
    else { emit(c, RX_OP_PUSH_BT); uint32_t body_lbl = emit_label(c); emit(c, RX_OP_JMP); exit_lbl = emit_label(c); patch(c, body_lbl, here(c)); }
    if (has_groups){ emit(c, RX_OP_CLEAR); emit(c, n->group_lo); emit(c, n->group_hi); }
    if (empty_ok){ emit(c, RX_OP_EMPTY_START); emit(c, ereg); }
    compile_node(c, body);
    if (empty_ok){ emit(c, RX_OP_EMPTY_CHECK); emit(c, ereg); }
    patch(c, exit_lbl, here(c));
    return;
  }
  if (min <= 1 && max == RX_INFINITY){
    if (min == 1){
      /* x+ : one mandatory copy then x* */
      if (has_groups){ emit(c, RX_OP_CLEAR); emit(c, n->group_lo); emit(c, n->group_hi); }
      compile_node(c, body);
    }
    uint32_t ereg = 0;
    if (empty_ok) ereg = c->nregs++;
    uint32_t loop = here(c);
    uint32_t exit_lbl;
    if (n->greedy){ emit(c, RX_OP_PUSH_BT); exit_lbl = emit_label(c); }
    else { emit(c, RX_OP_PUSH_BT); uint32_t body_lbl = emit_label(c); emit(c, RX_OP_JMP); exit_lbl = emit_label(c); patch(c, body_lbl, here(c)); }
    if (has_groups){ emit(c, RX_OP_CLEAR); emit(c, n->group_lo); emit(c, n->group_hi); }
    if (empty_ok){ emit(c, RX_OP_EMPTY_START); emit(c, ereg); }
    compile_node(c, body);
    if (empty_ok){ emit(c, RX_OP_EMPTY_CHECK); emit(c, ereg); }
    emit(c, RX_OP_JMP); emit(c, loop);
    patch(c, exit_lbl, here(c));
    return;
  }
  /* {min,max}: a counter register */
  uint32_t creg = c->nregs++;
  uint32_t ereg = 0;
  if (empty_ok) ereg = c->nregs++;
  emit(c, RX_OP_CNT_INIT); emit(c, creg);
  uint32_t loop = here(c);
  uint32_t exit_patches[2]; uint32_t nexit = 0;
  /* mandatory iterations go straight to the body */
  emit(c, RX_OP_CNT_JGE); emit(c, creg); emit(c, min); uint32_t opt_lbl = emit_label(c);
  uint32_t body_jmp = 0;
  emit(c, RX_OP_JMP); body_jmp = emit_label(c);
  patch(c, opt_lbl, here(c));
  if (max != RX_INFINITY){ emit(c, RX_OP_CNT_JGE); emit(c, creg); emit(c, max); exit_patches[nexit++] = emit_label(c); }
  if (n->greedy){ emit(c, RX_OP_PUSH_BT); exit_patches[nexit++] = emit_label(c); }
  else { emit(c, RX_OP_PUSH_BT); uint32_t body_lbl = emit_label(c); emit(c, RX_OP_JMP); exit_patches[nexit++] = emit_label(c); patch(c, body_lbl, here(c)); }
  patch(c, body_jmp, here(c));
  if (has_groups){ emit(c, RX_OP_CLEAR); emit(c, n->group_lo); emit(c, n->group_hi); }
  if (empty_ok){ emit(c, RX_OP_EMPTY_START); emit(c, ereg); }
  compile_node(c, body);
  if (empty_ok){ emit(c, RX_OP_EMPTY_CHECK_OPT); emit(c, ereg); emit(c, creg); emit(c, min); }   /* checked for optional iterations only */
  emit(c, RX_OP_CNT_INC_JL); emit(c, creg); emit(c, RX_INFINITY); emit(c, loop);
  for (uint32_t i = 0; i < nexit; i++) patch(c, exit_patches[i], here(c));
}

static void compile_node(cstate* c, rx_node* n){
  switch (n->kind){
    case RX_N_EMPTY: return;
    case RX_N_CHAR: emit_char(c, n); return;
    case RX_N_DOT: emit(c, ((n->mflags & RX_M_S) ? RX_OP_ANY_ALL : RX_OP_ANY) | text_flags(c)); return;
    case RX_N_CLASS: if (n->strs.n) emit_class_strings(c, n); else emit_class(c, n); return;
    case RX_N_SEQ: {
      /* runs of case-sensitive single-unit characters become one CHARS op (no dispatch per
         unit); a lookbehind body is emitted in reverse, a run's units stay in source order (the
         backward CHARS compares the units ending at the position) */
      #define CHARS_OK(k) ((k)->kind == RX_N_CHAR && !((k)->mflags & RX_M_I) && (k)->cp < 0x10000u && \
                           !(c->u && (k)->cp >= 0xD800u && (k)->cp <= 0xDFFFu))
      uint32_t nk = n->nkids;
      if (!c->bw){
        uint32_t i = 0;
        while (i < nk){
          uint32_t j = i;
          while (j < nk && CHARS_OK(n->kids[j])) j++;
          if (j - i >= 2){ emit(c, RX_OP_CHARS); emit(c, j - i); for (uint32_t k = i; k < j; k++) emit(c, n->kids[k]->cp); i = j; }
          else { compile_node(c, n->kids[i]); i++; }
        }
      } else {
        uint32_t i = nk;
        while (i > 0){
          uint32_t j = i;
          while (j > 0 && CHARS_OK(n->kids[j-1])) j--;
          if (i - j >= 2){ emit(c, RX_OP_CHARS | RX_OP_BW); emit(c, i - j); for (uint32_t k = j; k < i; k++) emit(c, n->kids[k]->cp); i = j; }
          else { compile_node(c, n->kids[i-1]); i--; }
        }
      }
      #undef CHARS_OK
      return;
    }
    case RX_N_ALT: {
      uint32_t* ends = (uint32_t*)rx_arena_alloc(c->a, sizeof(uint32_t) * n->nkids); uint32_t nends = 0;
      for (uint32_t i = 0; i < n->nkids; i++){
        int last = i + 1 == n->nkids;
        uint32_t bt = 0;
        if (!last){ emit(c, RX_OP_PUSH_BT); bt = emit_label(c); }
        compile_node(c, n->kids[i]);
        if (!last){ emit(c, RX_OP_JMP); ends[nends++] = emit_label(c); patch(c, bt, here(c)); }
      }
      for (uint32_t i = 0; i < nends; i++) patch(c, ends[i], here(c));
      return;
    }
    case RX_N_GROUP:
      if (n->group){
        emit_save(c, c->bw ? 2 * n->group + 1 : 2 * n->group);
        compile_node(c, n->body);
        emit_save(c, c->bw ? 2 * n->group : 2 * n->group + 1);
      } else compile_node(c, n->body);
      return;
    case RX_N_QUANT: compile_quant(c, n); return;
    case RX_N_BOL: emit(c, (n->mflags & RX_M_M) ? RX_OP_BOL_M : RX_OP_BOL); return;
    case RX_N_EOL: emit(c, (n->mflags & RX_M_M) ? RX_OP_EOL_M : RX_OP_EOL); return;
    case RX_N_WORDB: case RX_N_NWORDB: {
      uint32_t f = (c->u && (n->mflags & RX_M_I)) ? RX_OP_IU : 0;
      emit(c, (n->kind == RX_N_WORDB ? RX_OP_WORDB : RX_OP_NWORDB) | f);
      return;
    }
    case RX_N_LOOK: {
      emit(c, RX_OP_LOOK); emit(c, (n->negate ? 1u : 0u) | (n->behind ? 2u : 0u)); uint32_t end = emit_label(c);
      int saved = c->bw; c->bw = n->behind;
      compile_node(c, n->body);
      emit(c, RX_OP_LOOK_END);
      c->bw = saved;
      patch(c, end, here(c));
      return;
    }
    case RX_N_BACKREF: {
      uint32_t f = (c->bw ? RX_OP_BW : 0) | (c->u ? RX_OP_CP : 0);
      if (n->mflags & RX_M_I) f |= c->u ? RX_OP_IU : RX_OP_I;
      if (n->nrefs == 1){ emit(c, RX_OP_BACKREF | f); emit(c, n->refs[0]); }
      else { emit(c, RX_OP_BACKREF_LIST | f); emit(c, n->nrefs); for (uint32_t i = 0; i < n->nrefs; i++) emit(c, n->refs[i]); }
      return;
    }
  }
}

/* the literal prefix: leading case-sensitive characters of the top-level sequence */
static void literal_prefix(cstate* c, rx_node* root, uint16_t** out, uint32_t* out_len, int* whole){
  rx_node** kids; uint32_t nk;
  rx_node* single = root;
  if (root->kind == RX_N_SEQ){ kids = root->kids; nk = root->nkids; }
  else { kids = &single; nk = 1; }
  uint32_t cap = 0, len = 0; uint16_t* buf = NULL;
  uint32_t i = 0;
  for (; i < nk; i++){
    rx_node* k = kids[i];
    if (k->kind != RX_N_CHAR || (k->mflags & RX_M_I)) break;
    if (c->u && k->cp >= 0xD800u && k->cp <= 0xDFFFu) break;   /* a lone surrogate never matches a pair's unit */
    if (len + 2 > cap){ cap = cap ? cap * 2 : 16; buf = (uint16_t*)realloc(buf, sizeof(uint16_t) * cap); if (!buf) abort(); }
    if (k->cp >= 0x10000u){ buf[len++] = (uint16_t)(0xD800u + ((k->cp - 0x10000u) >> 10)); buf[len++] = (uint16_t)(0xDC00u + ((k->cp - 0x10000u) & 0x3FFu)); }
    else buf[len++] = (uint16_t)k->cp;
  }
  *out = buf; *out_len = len; *whole = (len > 0 && i == nk);
}

rx_program* rx_compile_ast(rx_arena* arena, rx_node* root, uint32_t flags, uint32_t ngroups,
                           uint16_t** names, uint32_t* name_lens){
  cstate st; memset(&st, 0, sizeof st);
  cstate* c = &st;
  c->a = arena; c->flags = flags; c->u = (flags & RX_F_EITHER_UNICODE) != 0;
  c->ngroups = ngroups; c->ncap_regs = 2 * (ngroups + 1); c->nregs = c->ncap_regs;
  emit(c, RX_OP_SAVE_NR); emit(c, 0);   /* before any choice point: nothing to restore */
  compile_node(c, root);
  emit(c, RX_OP_SAVE_NR); emit(c, 1);   /* after the last: never backtracked past */
  emit(c, RX_OP_ACCEPT);

  rx_program* p = (rx_program*)calloc(1, sizeof(rx_program));
  if (!p) abort();
  p->refs = 1; p->flags = flags; p->ngroups = ngroups; p->ncap_regs = c->ncap_regs; p->nregs = c->nregs;
  p->code = c->code; p->code_len = c->len;
  p->sets = c->sets; p->nsets = c->nsets;
  p->names = (uint16_t**)calloc(ngroups + 1, sizeof(uint16_t*));
  p->name_lens = (uint32_t*)calloc(ngroups + 1, sizeof(uint32_t));
  if (!p->names || !p->name_lens) abort();
  for (uint32_t g = 1; g <= ngroups; g++){
    if (!names[g]) continue;
    p->names[g] = (uint16_t*)malloc(sizeof(uint16_t) * (name_lens[g] ? name_lens[g] : 1));
    if (!p->names[g]) abort();
    memcpy(p->names[g], names[g], sizeof(uint16_t) * name_lens[g]);
    p->name_lens[g] = name_lens[g]; p->nnamed++;
  }
  p->min_len = min_len(c, root);
  p->anchored_start = (uint8_t)anchored(root);
  firstset f; memset(&f, 0, sizeof f); f.valid = 1;
  int nullable;
  first_of(c, root, &f, &nullable);
  if (f.valid && !nullable){
    uint32_t pop = 0; for (uint32_t i = 0; i < 32; i++) pop += (uint32_t)__builtin_popcount(f.bits[i]);
    int has_lower = 0; for (uint32_t u = 'a'; u <= 'z'; u++) if ((f.bits[u >> 3] >> (u & 7u)) & 1u){ has_lower = 1; break; }
    /* a selective set, or one without the lower-case letters (tsc's `[^...a-z0-9...]+` over paths:
       on identifiers and paths a set with them makes nearly every position a candidate, and the
       scan costs more than it saves; without them the scan skips most of the input) */
    if (pop <= 48 || !has_lower){
      p->first_valid = 1; p->first_wide = (uint8_t)f.wide; memcpy(p->first_bits, f.bits, 32);
      for (uint32_t u = 0; u < 256u; u++) p->first_tab[u] = (uint8_t)((f.bits[u >> 3] >> (u & 7u)) & 1u);
    }
  }
  int whole; literal_prefix(c, root, &p->prefix, &p->prefix_len, &whole);
  p->prefix_whole = (uint8_t)(whole && ngroups == 0);
  return p;
}

uint32_t rx_flags(const rx_program* p){ return p->flags; }
uint32_t rx_group_count(const rx_program* p){ return p->ngroups; }
const uint16_t* rx_group_name(const rx_program* p, uint32_t i, uint32_t* len){
  if (i == 0 || i > p->ngroups || !p->names[i]) return NULL;
  *len = p->name_lens[i]; return p->names[i];
}
int rx_has_named_groups(const rx_program* p){ return p->nnamed > 0; }
int rx_anchored_at_start(const rx_program* p){ return p->anchored_start; }
void rx_retain(rx_program* p){ p->refs++; }
void* rx_user(const rx_program* p){ return p->user; }
void rx_set_user(rx_program* p, void* data, void (*free_fn)(void*)){ p->user = data; p->user_free = free_fn; }
void rx_release(rx_program* p){
  if (!p || --p->refs) return;
  if (p->user && p->user_free) p->user_free(p->user);
  free(p->code);
  for (uint32_t i = 0; i < p->nsets; i++) free(p->sets[i].base);
  free(p->sets);
  for (uint32_t g = 0; g <= p->ngroups; g++) free(p->names[g]);
  free(p->names); free(p->name_lens); free(p->prefix);
  free(p);
}

rx_program* rx_compile(const uint16_t* pattern, uint32_t len, uint32_t flags, rx_error* err){
  rx_arena arena = {0};
  uint32_t ngroups; uint16_t** names; uint32_t* name_lens;
  rx_node* root = rx_parse(&arena, pattern, len, flags, &ngroups, &names, &name_lens, err);
  if (!root){ rx_arena_free(&arena); return NULL; }
  rx_program* p = rx_compile_ast(&arena, root, flags, ngroups, names, name_lens);
  rx_arena_free(&arena);
  rx_unicode_init();
  return p;
}

/* EscapeRegExpPattern for RegExp.prototype.source */
uint32_t rx_escape_source(const uint16_t* s, uint32_t len, uint16_t* out, uint32_t cap){
  uint32_t n = 0;
  #define PUT(u) do { if (n < cap) out[n] = (uint16_t)(u); n++; } while (0)
  if (len == 0){ PUT('('); PUT('?'); PUT(':'); PUT(')'); return n; }
  int in_class = 0;
  for (uint32_t i = 0; i < len; i++){
    uint16_t u = s[i];
    if (u == '\\' && i + 1 < len){
      uint16_t e = s[i+1];
      /* an escaped line terminator is written as its escape (V8: `\` + LF reads back as "\n") */
      if (e == 0x0A || e == 0x0D || e == 0x2028 || e == 0x2029){ i++; u = e; }
      else { PUT(u); PUT(e); i++; continue; }
    }
    if (u == '[') in_class = 1; else if (u == ']') in_class = 0;
    if (u == '/' && !in_class){ PUT('\\'); PUT('/'); continue; }
    if (u == 0x0A){ PUT('\\'); PUT('n'); continue; }
    if (u == 0x0D){ PUT('\\'); PUT('r'); continue; }
    if (u == 0x2028 || u == 0x2029){ PUT('\\'); PUT('u'); PUT('2'); PUT('0'); PUT('2'); PUT(u == 0x2028 ? '8' : '9'); continue; }
    PUT(u);
  }
  #undef PUT
  return n;
}
