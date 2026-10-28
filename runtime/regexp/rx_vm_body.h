/* rx_vm_body.h: the interpreter body, included twice by rx_vm.c (RX_WIDE 0: Latin-1 input,
   1: UTF-16 input). In the narrow instantiation a code point is a code unit and the surrogate
   tests fold away. */
#if RX_WIDE
#define RUN_NAME rx_run_16
#define MATCH1 match1_16
#define UNSTEP rx_unstep_16
#define BACKREF_CMP rx_backref_cmp_16
#define CU(i) ((uint32_t)c->in16[i])
#else
#define RUN_NAME rx_run_8
#define MATCH1 match1_8
#define UNSTEP rx_unstep_8
#define BACKREF_CMP rx_backref_cmp_8
#define CU(i) ((uint32_t)c->in8[i])
#endif

/* read the next character in the op's direction into ch (a code point in cp mode), failing
   at the input's edge */
#define NEXT_CHAR(w, ch) do { \
  if ((w) & RX_OP_BW){ \
    if (pos == 0) goto fail; \
    ch = CU(pos - 1); pos--; \
    if (RX_WIDE && ((w) & RX_OP_CP)){ \
      if (rx_is_trail(ch) && pos > 0 && rx_is_lead(CU(pos - 1))){ ch = 0x10000u + ((CU(pos - 1) - 0xD800u) << 10) + (ch - 0xDC00u); pos--; } \
      else if (rx_is_lead(ch) && pos + 1 < len && rx_is_trail(CU(pos + 1))) goto fail;   /* the lead of a pair is not a character end */ \
    } \
  } else { \
    if (pos >= len) goto fail; \
    ch = CU(pos); pos++; \
    if (RX_WIDE && ((w) & RX_OP_CP)){ \
      if (rx_is_lead(ch) && pos < len && rx_is_trail(CU(pos))){ ch = 0x10000u + ((ch - 0xD800u) << 10) + (CU(pos) - 0xDC00u); pos++; } \
      else if (rx_is_trail(ch) && pos >= 2 && rx_is_lead(CU(pos - 2))) goto fail;   /* the trail of a pair is not a character start */ \
    } \
  } } while (0)

#define CANON(w, ch) (((w) & RX_OP_CP) ? rx_fold_u_fast(ch) : rx_canon_nonu_fast(ch))

#define PUSH(a, b, cc, d) do { \
  if (c->bt_sp + RX_BT_WORDS > c->bt_cap && !rx_bt_grow(c)) return RX_EXEC_OVERFLOW; \
  uint32_t* e_ = c->bt + c->bt_sp; e_[0] = (a); e_[1] = (b); e_[2] = (cc); e_[3] = (d); c->bt_sp += RX_BT_WORDS; } while (0)

/* one character of a simple loop: returns 1 and advances pos on a match */
static inline __attribute__((always_inline)) int MATCH1(const rx_ctx* c, uint32_t w, uint32_t a0, uint32_t a1, uint32_t* ppos){
  uint32_t pos = *ppos, len = c->len, ch;
  if ((w) & RX_OP_BW){
    if (pos == 0) return 0;
    ch = CU(pos - 1); pos--;
    if (RX_WIDE && ((w) & RX_OP_CP)){
      if (rx_is_trail(ch) && pos > 0 && rx_is_lead(CU(pos - 1))){ ch = 0x10000u + ((CU(pos - 1) - 0xD800u) << 10) + (ch - 0xDC00u); pos--; }
      else if (rx_is_lead(ch) && pos + 1 < len && rx_is_trail(CU(pos + 1))) return 0;
    }
  } else {
    if (pos >= len) return 0;
    ch = CU(pos); pos++;
    if (RX_WIDE && ((w) & RX_OP_CP)){
      if (rx_is_lead(ch) && pos < len && rx_is_trail(CU(pos))){ ch = 0x10000u + ((ch - 0xD800u) << 10) + (CU(pos) - 0xDC00u); pos++; }
      else if (rx_is_trail(ch) && pos >= 2 && rx_is_lead(CU(pos - 2))) return 0;
    }
  }
  int ok;
  switch (w & RX_OP_MASK){
    case RX_OP_CHAR: ok = ch == a0; break;
    case RX_OP_CHAR_I: ok = CANON(w, ch) == a0; break;
    case RX_OP_CHAR2: ok = ch == a0 || ch == a1; break;
    case RX_OP_ANY: ok = !rx_is_lt(ch); break;
    case RX_OP_ANY_ALL: ok = 1; break;
    case RX_OP_CLASS: ok = set_has(&c->p->sets[a0], ch); break;
    case RX_OP_NCLASS: ok = !set_has(&c->p->sets[a0], ch); break;
    case RX_OP_CLASS_I: ok = set_has(&c->p->sets[a0], CANON(w, ch)); break;
    case RX_OP_NCLASS_I: ok = !set_has(&c->p->sets[a0], CANON(w, ch)); break;
    default: ok = 0; break;
  }
  if (ok) *ppos = pos;
  return ok;
}
/* step back over one character matched by a simple loop (the loop's direction) */
uint32_t UNSTEP(const rx_ctx* c, uint32_t w, uint32_t pos){
  if (w & RX_OP_BW){
    /* the loop moved left; stepping back moves right */
    uint32_t ch = CU(pos);
    if (RX_WIDE && (w & RX_OP_CP) && rx_is_lead(ch) && pos + 1 < c->len && rx_is_trail(CU(pos + 1))) return pos + 2;
    return pos + 1;
  }
  uint32_t ch = CU(pos - 1);
  if (RX_WIDE && (w & RX_OP_CP) && rx_is_trail(ch) && pos >= 2 && rx_is_lead(CU(pos - 2))) return pos - 2;
  return pos - 1;
}
/* compare the captured text [s, e) against the input at pos, forward (ending at pos when
   backward); returns the new position or UINT32_MAX */
uint32_t BACKREF_CMP(const rx_ctx* c, uint32_t w, uint32_t s, uint32_t e, uint32_t pos){
  uint32_t n = e - s, len = c->len;
  uint32_t q;
  if (w & RX_OP_BW){ if (pos < n) return UINT32_MAX; q = pos - n; }
  else { if (pos + n > len) return UINT32_MAX; q = pos; }
  if (!(w & (RX_OP_I | RX_OP_IU))){
    for (uint32_t i = 0; i < n; i++) if (CU(s + i) != CU(q + i)) return UINT32_MAX;
  } else if (!(w & RX_OP_CP) || !RX_WIDE){
    for (uint32_t i = 0; i < n; i++){
      uint32_t a = CU(s + i), b = CU(q + i);
      if (a != b && ((w & RX_OP_CP) ? rx_fold_u_fast(a) != rx_fold_u_fast(b) : rx_canon_nonu_fast(a) != rx_canon_nonu_fast(b))) return UINT32_MAX;
    }
  } else {
    /* code points: decode pairs on both sides */
    uint32_t i = 0, j = 0;
    while (i < n && j < n){
      uint32_t a = CU(s + i), b = CU(q + j); uint32_t ai = 1, bj = 1;
      if (rx_is_lead(a) && i + 1 < n && rx_is_trail(CU(s + i + 1))){ a = 0x10000u + ((a - 0xD800u) << 10) + (CU(s + i + 1) - 0xDC00u); ai = 2; }
      if (rx_is_lead(b) && j + 1 < n && rx_is_trail(CU(q + j + 1))){ b = 0x10000u + ((b - 0xD800u) << 10) + (CU(q + j + 1) - 0xDC00u); bj = 2; }
      if (a != b && rx_fold_u_fast(a) != rx_fold_u_fast(b)) return UINT32_MAX;
      i += ai; j += bj;
    }
    if (i != n || j != n) return UINT32_MAX;
  }
  return (w & RX_OP_BW) ? q : pos + n;
}
/* The run: executes from pc at pos until ACCEPT / LOOK_END (returns 1, *out_pos the position)
   or until the backtrack stack unwinds to `base` (returns 0); RX_EXEC_OVERFLOW on the limit. */
static int RUN_NAME(rx_ctx* c, uint32_t pc, uint32_t pos, uint32_t base, uint32_t* out_pos){
  const uint32_t* code = c->p->code;
  const uint32_t len = c->len;
  int32_t* regs = c->regs;
  uint32_t w, ch;
#if defined(__GNUC__)
  static const void* const dispatch[RX_OP__COUNT] = {
    &&L_FAIL, &&L_ACCEPT, &&L_LOOK_END, &&L_JMP, &&L_PUSH_BT, &&L_SAVE, &&L_CLEAR, &&L_CNT_INIT, &&L_CNT_INC_JL, &&L_CNT_JGE,
    &&L_EMPTY_START, &&L_EMPTY_CHECK, &&L_EMPTY_CHECK_OPT, &&L_LOOK, &&L_BACKREF, &&L_BACKREF_LIST, &&L_BOL, &&L_EOL, &&L_BOL_M, &&L_EOL_M,
    &&L_WORDB, &&L_NWORDB, &&L_CHAR, &&L_CHAR_I, &&L_CHAR2, &&L_CHARS, &&L_ANY, &&L_ANY_ALL, &&L_CLASS, &&L_NCLASS, &&L_CLASS_I, &&L_NCLASS_I,
    &&L_STRINGS, &&L_LOOP_GREEDY, &&L_LOOP_LAZY, &&L_SAVE_NR };
  #define DISPATCH() do { w = code[pc]; goto *dispatch[w & RX_OP_MASK]; } while (0)
  DISPATCH();
#else
  for (;;){
    w = code[pc];
    switch (w & RX_OP_MASK){
  #define DISPATCH() continue
  #define CASE(x) case RX_OP_##x: L_##x
#endif

#if defined(__GNUC__)
  #define CASE(x) L_##x
#endif

  CASE(FAIL):
  fail:
    for (;;){
      if (c->bt_sp == base) return 0;
      uint32_t* e = c->bt + (c->bt_sp - RX_BT_WORDS);
      c->bt_sp -= RX_BT_WORDS;
      switch (e[0]){
        case RX_BT_RESTORE: regs[e[1]] = (int32_t)e[2]; continue;
        case RX_BT_RESUME: pc = e[1]; pos = e[2]; DISPATCH();
        case RX_BT_GREEDY: {
          if (e[3] == e[2]) continue;              /* back at the minimum: no shorter match */
          uint32_t lpc = e[1]; uint32_t lw = code[lpc + 1];
          uint32_t npos = UNSTEP(c, lw, e[3]);
          e[3] = npos; c->bt_sp += RX_BT_WORDS;
          pc = lpc + 6; pos = npos;
          DISPATCH();
        }
        case RX_BT_LAZY: {
          uint32_t lpc = e[1]; uint32_t lw = code[lpc + 1], la0 = code[lpc + 2], la1 = code[lpc + 3], lmax = code[lpc + 5];
          uint32_t npos = e[2]; uint32_t count = e[3];
          if (count >= lmax) continue;
          if (!MATCH1(c, lw, la0, la1, &npos)) continue;
          e[2] = npos; e[3] = count + 1; c->bt_sp += RX_BT_WORDS;
          pc = lpc + 6; pos = npos;
          DISPATCH();
        }
        default: continue;
      }
    }
  CASE(ACCEPT):
  CASE(LOOK_END):
    *out_pos = pos; return 1;
  CASE(JMP): pc = code[pc + 1]; DISPATCH();
  CASE(PUSH_BT): PUSH(RX_BT_RESUME, code[pc + 1], pos, 0); pc += 2; DISPATCH();
  CASE(SAVE): { uint32_t r = code[pc + 1]; PUSH(RX_BT_RESTORE, r, (uint32_t)regs[r], 0); regs[r] = (int32_t)pos; pc += 2; DISPATCH(); }
  CASE(SAVE_NR): regs[code[pc + 1]] = (int32_t)pos; pc += 2; DISPATCH();
  CASE(CLEAR): {
    uint32_t lo = code[pc + 1], hi = code[pc + 2];
    for (uint32_t g = lo; g <= hi; g++){
      for (uint32_t k = 2 * g; k <= 2 * g + 1; k++){
        if (regs[k] != -1){ PUSH(RX_BT_RESTORE, k, (uint32_t)regs[k], 0); regs[k] = -1; }
      }
    }
    pc += 3; DISPATCH();
  }
  CASE(CNT_INIT): { uint32_t r = code[pc + 1]; PUSH(RX_BT_RESTORE, r, (uint32_t)regs[r], 0); regs[r] = 0; pc += 2; DISPATCH(); }
  CASE(CNT_INC_JL): {
    uint32_t r = code[pc + 1], n = code[pc + 2], target = code[pc + 3];
    PUSH(RX_BT_RESTORE, r, (uint32_t)regs[r], 0);
    regs[r]++;
    if ((uint32_t)regs[r] < n) pc = target; else pc += 4;
    DISPATCH();
  }
  CASE(CNT_JGE): { uint32_t r = code[pc + 1], n = code[pc + 2]; if ((uint32_t)regs[r] >= n) pc = code[pc + 3]; else pc += 4; DISPATCH(); }
  CASE(EMPTY_START): { uint32_t r = code[pc + 1]; PUSH(RX_BT_RESTORE, r, (uint32_t)regs[r], 0); regs[r] = (int32_t)pos; pc += 2; DISPATCH(); }
  CASE(EMPTY_CHECK): if ((uint32_t)regs[code[pc + 1]] == pos) goto fail; pc += 2; DISPATCH();
  CASE(EMPTY_CHECK_OPT): if ((uint32_t)regs[code[pc + 2]] >= code[pc + 3] && (uint32_t)regs[code[pc + 1]] == pos) goto fail; pc += 4; DISPATCH();
  CASE(LOOK): {
    uint32_t kind = code[pc + 1], end = code[pc + 2];
    uint32_t mark = c->bt_sp;
    uint32_t sub_pos;
    int r = RUN_NAME(c, pc + 3, pos, mark, &sub_pos);
    if (r < 0) return r;
    if (!(kind & 1u)){
      if (!r) goto fail;
      /* positive: drop the body's choice points, keep its register restores in order */
      uint32_t wr = mark;
      for (uint32_t rd = mark; rd < c->bt_sp; rd += RX_BT_WORDS){
        if (c->bt[rd] == RX_BT_RESTORE){ if (wr != rd) memcpy(c->bt + wr, c->bt + rd, sizeof(uint32_t) * RX_BT_WORDS); wr += RX_BT_WORDS; }
      }
      c->bt_sp = wr;
    } else {
      if (r){
        /* negative and the body matched: undo its register writes, then fail */
        while (c->bt_sp > mark){
          uint32_t* e = c->bt + (c->bt_sp - RX_BT_WORDS); c->bt_sp -= RX_BT_WORDS;
          if (e[0] == RX_BT_RESTORE) regs[e[1]] = (int32_t)e[2];
        }
        goto fail;
      }
    }
    pc = end; DISPATCH();
  }
  CASE(BACKREF): {
    uint32_t g = code[pc + 1];
    int32_t s = regs[2 * g], e = regs[2 * g + 1];
    if (s >= 0 && e >= 0){
      uint32_t np = BACKREF_CMP(c, w, (uint32_t)s, (uint32_t)e, pos);
      if (np == UINT32_MAX) goto fail;
      pos = np;
    }
    pc += 2; DISPATCH();
  }
  CASE(BACKREF_LIST): {
    uint32_t n = code[pc + 1];
    for (uint32_t i = 0; i < n; i++){
      uint32_t g = code[pc + 2 + i];
      int32_t s = regs[2 * g], e = regs[2 * g + 1];
      if (s >= 0 && e >= 0){
        uint32_t np = BACKREF_CMP(c, w, (uint32_t)s, (uint32_t)e, pos);
        if (np == UINT32_MAX) goto fail;
        pos = np; break;
      }
    }
    pc += 2 + n; DISPATCH();
  }
  CASE(BOL): if (pos != 0) goto fail; pc++; DISPATCH();
  CASE(EOL): if (pos != len) goto fail; pc++; DISPATCH();
  CASE(BOL_M): if (pos != 0 && !rx_is_lt(CU(pos - 1))) goto fail; pc++; DISPATCH();
  CASE(EOL_M): if (pos != len && !rx_is_lt(CU(pos))) goto fail; pc++; DISPATCH();
  CASE(WORDB):
  CASE(NWORDB): {
    int a, b;
    if (w & RX_OP_IU){ a = pos > 0 && rx_is_word_iu(CU(pos - 1)); b = pos < len && rx_is_word_iu(CU(pos)); }
    else { a = pos > 0 && rx_is_word(CU(pos - 1)); b = pos < len && rx_is_word(CU(pos)); }
    int at = a != b;
    if (((w & RX_OP_MASK) == RX_OP_WORDB) ? !at : at) goto fail;
    pc++; DISPATCH();
  }
  CASE(CHAR): NEXT_CHAR(w, ch); if (ch != code[pc + 1]) goto fail; pc += 2; DISPATCH();
  CASE(CHAR_I): NEXT_CHAR(w, ch); if (CANON(w, ch) != code[pc + 1]) goto fail; pc += 2; DISPATCH();
  CASE(CHAR2): NEXT_CHAR(w, ch); if (ch != code[pc + 1] && ch != code[pc + 2]) goto fail; pc += 3; DISPATCH();
  CASE(CHARS): {
    uint32_t n = code[pc + 1];
    if (w & RX_OP_BW){
      if (pos < n) goto fail;
      for (uint32_t i = 0; i < n; i++) if (CU(pos - n + i) != code[pc + 2 + i]) goto fail;
      pos -= n;
    } else {
      if (pos + n > len) goto fail;
      for (uint32_t i = 0; i < n; i++) if (CU(pos + i) != code[pc + 2 + i]) goto fail;
      pos += n;
    }
    pc += 2 + n; DISPATCH();
  }
  CASE(ANY): NEXT_CHAR(w, ch); if (rx_is_lt(ch)) goto fail; pc++; DISPATCH();
  CASE(ANY_ALL): NEXT_CHAR(w, ch); pc++; DISPATCH();
  CASE(CLASS): NEXT_CHAR(w, ch); if (!set_has(&c->p->sets[code[pc + 1]], ch)) goto fail; pc += 2; DISPATCH();
  CASE(NCLASS): NEXT_CHAR(w, ch); if (set_has(&c->p->sets[code[pc + 1]], ch)) goto fail; pc += 2; DISPATCH();
  CASE(CLASS_I): NEXT_CHAR(w, ch); if (!set_has(&c->p->sets[code[pc + 1]], CANON(w, ch))) goto fail; pc += 2; DISPATCH();
  CASE(NCLASS_I): NEXT_CHAR(w, ch); if (set_has(&c->p->sets[code[pc + 1]], CANON(w, ch))) goto fail; pc += 2; DISPATCH();
  CASE(STRINGS): goto fail;   /* expanded by the compiler */
  CASE(LOOP_GREEDY): {
    uint32_t lw = code[pc + 1], a0 = code[pc + 2], a1 = code[pc + 3], min = code[pc + 4], max = code[pc + 5];
    uint32_t count = 0, pmin = pos;
#if !RX_WIDE
    /* the narrow forward loops as tight scans (one unit per character): `[^...]+`, `\s*`, `a+`, `.*` */
    if (!(lw & RX_OP_BW)){
      uint32_t start = pos;
      uint32_t lim = (max == RX_INFINITY || max > len - pos) ? len : pos + max;
      switch (lw & RX_OP_MASK){
        case RX_OP_CHAR: while (pos < lim && CU(pos) == a0) pos++; break;
        case RX_OP_CHAR2: while (pos < lim && (CU(pos) == a0 || CU(pos) == a1)) pos++; break;
        case RX_OP_ANY: while (pos < lim && CU(pos) != 0x0Au && CU(pos) != 0x0Du) pos++; break;
        case RX_OP_ANY_ALL: pos = lim; break;
        case RX_OP_CLASS: { const uint8_t* b = c->p->sets[a0].bits; while (pos < lim && ((b[CU(pos) >> 3] >> (CU(pos) & 7u)) & 1u)) pos++; break; }
        case RX_OP_NCLASS: { const uint8_t* b = c->p->sets[a0].bits; while (pos < lim && !((b[CU(pos) >> 3] >> (CU(pos) & 7u)) & 1u)) pos++; break; }
        default: goto greedy_generic;
      }
      count = pos - start;
      if (count < min) goto fail;
      pmin = start + min;
      if (count > min) PUSH(RX_BT_GREEDY, pc, pmin, pos);
      pc += 6; DISPATCH();
    }
  greedy_generic:
#endif
    while (count < max){
      if (!MATCH1(c, lw, a0, a1, &pos)) break;
      count++;
      if (count == min) pmin = pos;
    }
    if (count < min) goto fail;
    if (count > min) PUSH(RX_BT_GREEDY, pc, pmin, pos);
    pc += 6; DISPATCH();
  }
  CASE(LOOP_LAZY): {
    uint32_t lw = code[pc + 1], a0 = code[pc + 2], a1 = code[pc + 3], min = code[pc + 4], max = code[pc + 5];
    uint32_t count = 0;
    while (count < min){ if (!MATCH1(c, lw, a0, a1, &pos)) goto fail; count++; }
    if (count < max) PUSH(RX_BT_LAZY, pc, pos, count);
    pc += 6; DISPATCH();
  }
#if !defined(__GNUC__)
    default: goto fail;
    }
  }
#endif
}

#undef CASE
#undef DISPATCH
#undef RUN_NAME
#undef CU
#undef NEXT_CHAR
#undef CANON
#undef PUSH
#undef MATCH1
#undef UNSTEP
#undef BACKREF_CMP
