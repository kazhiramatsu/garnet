/* rx_emit.c: the native tier of the regexp engine (docs/regexp_vm_design.md "The native tier").
   A compiled program's bytecode written out as C: two functions per program (Latin-1 and
   UTF-16 input) with the interpreter run's contract (rx_native.h), each lookaround body a
   nested static function with the same contract. A text op becomes straight-line C, a class a
   test against a static table emitted with the functions, a simple loop a tight scan, a choice
   point a push of its target pc; the fail block pops the backtrack stack and resumes through a
   switch over the pcs (the trampoline), exactly as the interpreter does. The analyzer calls
   rx_emit_native through FFI for each regexp literal with constant source and flags and pastes
   the text into the program's C; not part of the runtime objects. */
#include "rx_internal.h"
#include <stdio.h>
#include <stdarg.h>

/* ---- a string builder ---- */
typedef struct sb { char* s; size_t n, cap; } sb;
static void put(sb* b, const char* fmt, ...){
  va_list ap, ap2;
  va_start(ap, fmt); va_copy(ap2, ap);
  int k = vsnprintf(NULL, 0, fmt, ap2);
  va_end(ap2);
  if (k < 0){ va_end(ap); return; }
  if (b->n + (size_t)k + 1 > b->cap){
    size_t cap = b->cap ? b->cap : 4096;
    while (b->n + (size_t)k + 1 > cap) cap *= 2;
    char* ns = (char*)realloc(b->s, cap);
    if (!ns) abort();
    b->s = ns; b->cap = cap;
  }
  vsnprintf(b->s + b->n, b->cap - b->n, fmt, ap);
  va_end(ap);
  b->n += (size_t)k;
}

typedef struct emitter {
  const rx_program* p;
  uint32_t id;
  sb* out;
  int wide;
} emitter;

static const char* canon_fn(uint32_t w){ return (w & RX_OP_CP) ? "rx_fold_u_fast" : "rx_canon_nonu_fast"; }

/* read one character in the op's direction into ch, advancing pv; `edge` runs at the input's
   edge (and at a half of a surrogate pair in code point mode) */
static void emit_read(emitter* e, uint32_t w, const char* pv, const char* edge){
  int cp = e->wide && (w & RX_OP_CP);
  if (w & RX_OP_BW){
    put(e->out, "if (%s == 0){ %s; } ch = in[--%s];", pv, edge, pv);
    if (cp) put(e->out, " if (rx_is_trail(ch) && %s > 0 && rx_is_lead(in[%s - 1])){ ch = 0x10000u + ((in[%s - 1] - 0xD800u) << 10) + (ch - 0xDC00u); %s--; } else if (rx_is_lead(ch) && %s + 1 < len && rx_is_trail(in[%s + 1])){ %s; }",
                pv, pv, pv, pv, pv, pv, edge);
  } else {
    put(e->out, "if (%s >= len){ %s; } ch = in[%s++];", pv, edge, pv);
    if (cp) put(e->out, " if (rx_is_lead(ch) && %s < len && rx_is_trail(in[%s])){ ch = 0x10000u + ((ch - 0xD800u) << 10) + (in[%s] - 0xDC00u); %s++; } else if (rx_is_trail(ch) && %s >= 2 && rx_is_lead(in[%s - 2])){ %s; }",
                pv, pv, pv, pv, pv, pv, edge);
  }
}
/* the test of a one-character matcher on ch, as a C expression */
static void test_expr(emitter* e, char* buf, size_t cap, uint32_t w, uint32_t a0, uint32_t a1){
  uint32_t id = e->id;
  switch (w & RX_OP_MASK){
    case RX_OP_CHAR: snprintf(buf, cap, "ch == %uu", a0); break;
    case RX_OP_CHAR_I: snprintf(buf, cap, "%s(ch) == %uu", canon_fn(w), a0); break;
    case RX_OP_CHAR2: snprintf(buf, cap, "(ch == %uu || ch == %uu)", a0, a1); break;
    case RX_OP_ANY: snprintf(buf, cap, "!rx_is_lt(ch)"); break;
    case RX_OP_ANY_ALL: snprintf(buf, cap, "1"); break;
    case RX_OP_CLASS: snprintf(buf, cap, "rx_set_has_n(rx_n%u_s%ub, rx_n%u_s%ur, %uu, ch)", id, a0, id, a0, e->p->sets[a0].nranges); break;
    case RX_OP_NCLASS: snprintf(buf, cap, "!rx_set_has_n(rx_n%u_s%ub, rx_n%u_s%ur, %uu, ch)", id, a0, id, a0, e->p->sets[a0].nranges); break;
    case RX_OP_CLASS_I: snprintf(buf, cap, "rx_set_has_n(rx_n%u_s%ub, rx_n%u_s%ur, %uu, %s(ch))", id, a0, id, a0, e->p->sets[a0].nranges, canon_fn(w)); break;
    case RX_OP_NCLASS_I: snprintf(buf, cap, "!rx_set_has_n(rx_n%u_s%ub, rx_n%u_s%ur, %uu, %s(ch))", id, a0, id, a0, e->p->sets[a0].nranges, canon_fn(w)); break;
    default: snprintf(buf, cap, "0"); break;
  }
}
/* one character of a simple loop at pv (advanced on a match), the result in ok */
static void emit_match_one(emitter* e, uint32_t w, uint32_t a0, uint32_t a1, const char* pv){
  char test[200]; test_expr(e, test, sizeof test, w, a0, a1);
  put(e->out, "ok = 0; do { ");
  emit_read(e, w, pv, "break");
  put(e->out, " ok = %s; } while (0);", test);
}
/* the bound of a tight scan: the input's end, or max characters from pos */
static void lim_expr(char* buf, size_t cap, uint32_t max){
  if (max == RX_INFINITY) snprintf(buf, cap, "len");
  else snprintf(buf, cap, "((%uu > len - pos) ? len : pos + %uu)", max, max);
}

static void emit_fn(emitter* e, const char* name, uint32_t start, uint32_t end);

/* the lookaround bodies of a range as nested functions, each before its user */
static void emit_looks(emitter* e, const char* name, uint32_t start, uint32_t end){
  const uint32_t* code = e->p->code;
  for (uint32_t pc = start; pc < end;){
    if ((code[pc] & RX_OP_MASK) == RX_OP_LOOK){
      uint32_t body_end = code[pc + 2];
      char sub[200]; snprintf(sub, sizeof sub, "%s_lk%u", name, pc);
      emit_fn(e, sub, pc + 3, body_end);
      pc = body_end;
      continue;
    }
    pc += rx_op_len(code, pc);
  }
}

static void emit_fn(emitter* e, const char* name, uint32_t start, uint32_t end){
  const rx_program* p = e->p; const uint32_t* code = p->code;
  const char* W = e->wide ? "16" : "8";
  emit_looks(e, name, start, end);
  /* the labels: jump targets, the resume pcs of the choice points, the exits of the loops */
  uint8_t* target = (uint8_t*)calloc(p->code_len + 1, 1);
  uint32_t* resumes = (uint32_t*)calloc(p->code_len + 1, sizeof(uint32_t)); uint32_t nres = 0;
  uint32_t* greedy = (uint32_t*)calloc(p->code_len + 1, sizeof(uint32_t)); uint32_t ngreedy = 0;
  uint32_t* lazy = (uint32_t*)calloc(p->code_len + 1, sizeof(uint32_t)); uint32_t nlazy = 0;
  if (!target || !resumes || !greedy || !lazy) abort();
  for (uint32_t pc = start; pc < end;){
    uint32_t op = code[pc] & RX_OP_MASK;
    switch (op){
      case RX_OP_JMP: target[code[pc + 1]] = 1; break;
      case RX_OP_PUSH_BT: target[code[pc + 1]] = 1; resumes[nres++] = code[pc + 1]; break;
      case RX_OP_ALT_FIRST: target[code[pc + 2]] = 1; resumes[nres++] = code[pc + 2]; break;
      case RX_OP_CNT_INC_JL: case RX_OP_CNT_JGE: target[code[pc + 3]] = 1; break;
      case RX_OP_LOOP_GREEDY: greedy[ngreedy++] = pc; target[pc + 6] = 1; break;
      case RX_OP_LOOP_LAZY: lazy[nlazy++] = pc; target[pc + 6] = 1; break;
      case RX_OP_LOOK: pc = code[pc + 2]; continue;   /* the body is a nested function; its end is reached by falling through */
      default: break;
    }
    pc += rx_op_len(code, pc);
  }
  put(e->out, "static int %s(rx_ctx* c, uint32_t pos, uint32_t base, uint32_t* out_pos){\n", name);
  put(e->out, "  const %s* in = c->in%s; const uint32_t len = c->len; int32_t* regs = c->regs; uint32_t ch = 0; int ok = 0;\n"
              "  (void)in; (void)len; (void)regs; (void)ch; (void)ok;\n", e->wide ? "uint16_t" : "uint8_t", W);
  for (uint32_t pc = start; pc < end;){
    uint32_t w = code[pc], op = w & RX_OP_MASK;
    if (target[pc]) put(e->out, "  L%u: ;\n", pc);
    put(e->out, "  ");
    switch (op){
      case RX_OP_FAIL: put(e->out, "goto fail;"); break;
      case RX_OP_ACCEPT: case RX_OP_LOOK_END: put(e->out, "*out_pos = pos; return 1;"); break;
      case RX_OP_JMP: put(e->out, "goto L%u;", code[pc + 1]); break;
      case RX_OP_PUSH_BT: put(e->out, "if (rx_bt_push(c, RX_BT_RESUME, %uu, pos, 0)) return RX_EXEC_OVERFLOW;", code[pc + 1]); break;
      case RX_OP_ALT_FIRST: {
        /* the alternative's first-character guard (rx_vm_body.h ALT_FIRST): the narrow matcher's units are
           always below 256 */
        uint32_t a0 = code[pc + 1], tgt = code[pc + 2], fl = code[pc + 3];
        char push[96]; snprintf(push, sizeof push, "if (rx_bt_push(c, RX_BT_RESUME, %uu, pos, 0)) return RX_EXEC_OVERFLOW;", tgt);
        put(e->out, "if (pos >= len) goto L%u; ch = in[pos]; ", tgt);
        if (e->wide){
          char skip[32]; snprintf(skip, sizeof skip, "goto L%u;", tgt);
          put(e->out, "if (ch < 256u){ if (!((rx_n%u_s%ub[ch >> 3] >> (ch & 7u)) & 1u)) goto L%u; %s } else { %s }",
              e->id, a0, tgt, (fl & RX_ALT_DISJOINT) ? "" : push, (fl & RX_ALT_WIDE) ? push : skip);
        } else {
          put(e->out, "if (!((rx_n%u_s%ub[ch >> 3] >> (ch & 7u)) & 1u)) goto L%u; %s", e->id, a0, tgt, (fl & RX_ALT_DISJOINT) ? "" : push);
        }
        break;
      }
      case RX_OP_SAVE: {
        uint32_t r = code[pc + 1];
        put(e->out, "if (rx_bt_push(c, RX_BT_RESTORE, %uu, (uint32_t)regs[%u], 0)) return RX_EXEC_OVERFLOW; regs[%u] = (int32_t)pos;", r, r, r);
        break;
      }
      case RX_OP_SAVE_NR: put(e->out, "regs[%u] = (int32_t)pos;", code[pc + 1]); break;
      case RX_OP_CLEAR:
        put(e->out, "for (uint32_t k = %uu; k <= %uu; k++){ if (regs[k] != -1){ if (rx_bt_push(c, RX_BT_RESTORE, k, (uint32_t)regs[k], 0)) return RX_EXEC_OVERFLOW; regs[k] = -1; } }",
            2 * code[pc + 1], 2 * code[pc + 2] + 1);
        break;
      case RX_OP_CNT_INIT: {
        uint32_t r = code[pc + 1];
        put(e->out, "if (rx_bt_push(c, RX_BT_RESTORE, %uu, (uint32_t)regs[%u], 0)) return RX_EXEC_OVERFLOW; regs[%u] = 0;", r, r, r);
        break;
      }
      case RX_OP_CNT_INC_JL: {
        uint32_t r = code[pc + 1];
        put(e->out, "if (rx_bt_push(c, RX_BT_RESTORE, %uu, (uint32_t)regs[%u], 0)) return RX_EXEC_OVERFLOW; regs[%u]++; if ((uint32_t)regs[%u] < %uu) goto L%u;",
            r, r, r, r, code[pc + 2], code[pc + 3]);
        break;
      }
      case RX_OP_CNT_JGE: put(e->out, "if ((uint32_t)regs[%u] >= %uu) goto L%u;", code[pc + 1], code[pc + 2], code[pc + 3]); break;
      case RX_OP_EMPTY_START: {
        uint32_t r = code[pc + 1];
        put(e->out, "if (rx_bt_push(c, RX_BT_RESTORE, %uu, (uint32_t)regs[%u], 0)) return RX_EXEC_OVERFLOW; regs[%u] = (int32_t)pos;", r, r, r);
        break;
      }
      case RX_OP_EMPTY_CHECK: put(e->out, "if ((uint32_t)regs[%u] == pos) goto fail;", code[pc + 1]); break;
      case RX_OP_EMPTY_CHECK_OPT:
        put(e->out, "if ((uint32_t)regs[%u] >= %uu && (uint32_t)regs[%u] == pos) goto fail;", code[pc + 2], code[pc + 3], code[pc + 1]);
        break;
      case RX_OP_LOOK: {
        uint32_t kind = code[pc + 1], body_end = code[pc + 2];
        put(e->out, "{ uint32_t mark = c->bt_sp, sub = 0; int r = %s_lk%u(c, pos, mark, &sub); if (r < 0) return r; ", name, pc);
        if (!(kind & 1u)) put(e->out, "if (!r) goto fail; rx_bt_compact(c, mark); }");
        else put(e->out, "if (r){ rx_bt_unwind(c, mark); goto fail; } }");
        put(e->out, "\n");
        pc = body_end;
        continue;
      }
      case RX_OP_BACKREF: {
        uint32_t g = code[pc + 1];
        put(e->out, "if (regs[%u] >= 0 && regs[%u] >= 0){ uint32_t np = rx_backref_cmp_%s(c, 0x%xu, (uint32_t)regs[%u], (uint32_t)regs[%u], pos); if (np == UINT32_MAX) goto fail; pos = np; }",
            2 * g, 2 * g + 1, W, w, 2 * g, 2 * g + 1);
        break;
      }
      case RX_OP_BACKREF_LIST: {
        uint32_t n = code[pc + 1];
        for (uint32_t i = 0; i < n; i++){
          uint32_t g = code[pc + 2 + i];
          put(e->out, "%s (regs[%u] >= 0 && regs[%u] >= 0){ uint32_t np = rx_backref_cmp_%s(c, 0x%xu, (uint32_t)regs[%u], (uint32_t)regs[%u], pos); if (np == UINT32_MAX) goto fail; pos = np; }",
              i ? " else if" : "if", 2 * g, 2 * g + 1, W, w, 2 * g, 2 * g + 1);
        }
        if (n == 0) put(e->out, ";");
        break;
      }
      case RX_OP_BOL: put(e->out, "if (pos != 0) goto fail;"); break;
      case RX_OP_EOL: put(e->out, "if (pos != len) goto fail;"); break;
      case RX_OP_BOL_M: put(e->out, "if (pos != 0 && !rx_is_lt(in[pos - 1])) goto fail;"); break;
      case RX_OP_EOL_M: put(e->out, "if (pos != len && !rx_is_lt(in[pos])) goto fail;"); break;
      case RX_OP_WORDB: case RX_OP_NWORDB: {
        const char* f = (w & RX_OP_IU) ? "rx_is_word_iu" : "rx_is_word";
        put(e->out, "{ int a_ = pos > 0 && %s(in[pos - 1]); int b_ = pos < len && %s(in[pos]); if (%s(a_ != b_)) goto fail; }",
            f, f, op == RX_OP_WORDB ? "!" : "");
        break;
      }
      case RX_OP_CHAR: case RX_OP_CHAR_I: case RX_OP_CHAR2: case RX_OP_ANY: case RX_OP_ANY_ALL:
      case RX_OP_CLASS: case RX_OP_NCLASS: case RX_OP_CLASS_I: case RX_OP_NCLASS_I: {
        uint32_t a0 = (op == RX_OP_ANY || op == RX_OP_ANY_ALL) ? 0 : code[pc + 1];
        uint32_t a1 = op == RX_OP_CHAR2 ? code[pc + 2] : 0;
        char test[200]; test_expr(e, test, sizeof test, w, a0, a1);
        put(e->out, "{ ");
        emit_read(e, w, "pos", "goto fail");
        put(e->out, " if (!(%s)) goto fail; }", test);
        break;
      }
      case RX_OP_CHARS: {
        uint32_t n = code[pc + 1];
        int impossible = 0;
        if (!e->wide) for (uint32_t i = 0; i < n; i++) if (code[pc + 2 + i] > 0xFFu) impossible = 1;
        if (impossible){ put(e->out, "goto fail;"); break; }
        if (w & RX_OP_BW){
          put(e->out, "if (pos < %uu", n);
          for (uint32_t i = 0; i < n; i++) put(e->out, " || in[pos - %uu] != %uu", n - i, code[pc + 2 + i]);
          put(e->out, ") goto fail; pos -= %uu;", n);
        } else {
          put(e->out, "if (pos + %uu > len", n);
          for (uint32_t i = 0; i < n; i++) put(e->out, " || in[pos + %uu] != %uu", i, code[pc + 2 + i]);
          put(e->out, ") goto fail; pos += %uu;", n);
        }
        break;
      }
      case RX_OP_LOOP_GREEDY: {
        uint32_t lw = code[pc + 1], a0 = code[pc + 2], a1 = code[pc + 3], min = code[pc + 4], max = code[pc + 5];
        uint32_t lop = lw & RX_OP_MASK;
        int tight = !e->wide && !(lw & RX_OP_BW) &&
          (lop == RX_OP_CHAR || lop == RX_OP_CHAR2 || lop == RX_OP_ANY || lop == RX_OP_ANY_ALL || lop == RX_OP_CLASS || lop == RX_OP_NCLASS);
        put(e->out, "{ uint32_t count = 0, pmin = pos;\n    ");
        if (tight){
          char lim[96]; lim_expr(lim, sizeof lim, max);
          put(e->out, "uint32_t start_ = pos, lim = %s; ", lim);
          switch (lop){
            case RX_OP_CHAR: put(e->out, "while (pos < lim && in[pos] == %uu) pos++;", a0); break;
            case RX_OP_CHAR2: put(e->out, "while (pos < lim && (in[pos] == %uu || in[pos] == %uu)) pos++;", a0, a1); break;
            case RX_OP_ANY: put(e->out, "while (pos < lim && in[pos] != 0x0Au && in[pos] != 0x0Du) pos++;"); break;
            case RX_OP_ANY_ALL: put(e->out, "pos = lim;"); break;
            case RX_OP_CLASS: put(e->out, "while (pos < lim && ((rx_n%u_s%ub[in[pos] >> 3] >> (in[pos] & 7u)) & 1u)) pos++;", e->id, a0); break;
            case RX_OP_NCLASS: put(e->out, "while (pos < lim && !((rx_n%u_s%ub[in[pos] >> 3] >> (in[pos] & 7u)) & 1u)) pos++;", e->id, a0); break;
            default: break;
          }
          put(e->out, " count = pos - start_; pmin = start_ + %uu;\n    ", min);
        } else {
          if (max == RX_INFINITY) put(e->out, "for (;;){ uint32_t q = pos; ");
          else put(e->out, "while (count < %uu){ uint32_t q = pos; ", max);
          emit_match_one(e, lw, a0, a1, "q");
          put(e->out, " if (!ok) break; pos = q; count++; if (count == %uu) pmin = pos; }\n    ", min);
        }
        put(e->out, "if (count < %uu) goto fail;", min);
        put(e->out, " if (count > %uu){ if (rx_bt_push(c, RX_BT_GREEDY, %uu, pmin, pos)) return RX_EXEC_OVERFLOW; } }", min, pc);
        break;
      }
      case RX_OP_LOOP_LAZY: {
        uint32_t lw = code[pc + 1], a0 = code[pc + 2], a1 = code[pc + 3], min = code[pc + 4], max = code[pc + 5];
        put(e->out, "{ uint32_t count = 0;");
        if (min){
          put(e->out, " while (count < %uu){ uint32_t q = pos; ", min);
          emit_match_one(e, lw, a0, a1, "q");
          put(e->out, " if (!ok) goto fail; pos = q; count++; }");
        }
        if (max == RX_INFINITY) put(e->out, " if (rx_bt_push(c, RX_BT_LAZY, %uu, pos, count)) return RX_EXEC_OVERFLOW; }", pc);
        else put(e->out, " if (count < %uu){ if (rx_bt_push(c, RX_BT_LAZY, %uu, pos, count)) return RX_EXEC_OVERFLOW; } }", max, pc);
        break;
      }
      case RX_OP_STRINGS: put(e->out, "goto fail;"); break;   /* expanded by the compiler */
      default: put(e->out, "goto fail; /* op %u */", op); break;
    }
    put(e->out, "\n");
    pc += rx_op_len(code, pc);
  }
  /* the fail block: unwind the backtrack stack, resume through the trampoline */
  put(e->out, "  fail: __attribute__((unused));\n  for (;;){\n    if (c->bt_sp == base) return 0;\n"
              "    uint32_t* e = c->bt + (c->bt_sp - RX_BT_WORDS); c->bt_sp -= RX_BT_WORDS;\n    switch (e[0]){\n");
  put(e->out, "      case RX_BT_RESTORE: regs[e[1]] = (int32_t)e[2]; continue;\n");
  put(e->out, "      case RX_BT_RESUME: pos = e[2]; switch (e[1]){\n");
  for (uint32_t i = 0; i < nres; i++){
    int dup = 0; for (uint32_t j = 0; j < i; j++) if (resumes[j] == resumes[i]) dup = 1;
    if (!dup) put(e->out, "        case %uu: goto L%u;\n", resumes[i], resumes[i]);
  }
  put(e->out, "        default: continue; }\n");
  put(e->out, "      case RX_BT_GREEDY: switch (e[1]){\n");
  for (uint32_t i = 0; i < ngreedy; i++){
    uint32_t lpc = greedy[i], lw = code[lpc + 1];
    put(e->out, "        case %uu: { if (e[3] == e[2]) continue; uint32_t npos = rx_unstep_%s(c, 0x%xu, e[3]); e[3] = npos; c->bt_sp += RX_BT_WORDS; pos = npos; goto L%u; }\n",
        lpc, W, lw, lpc + 6);
  }
  put(e->out, "        default: continue; }\n");
  put(e->out, "      case RX_BT_LAZY: switch (e[1]){\n");
  for (uint32_t i = 0; i < nlazy; i++){
    uint32_t lpc = lazy[i], lw = code[lpc + 1], a0 = code[lpc + 2], a1 = code[lpc + 3], max = code[lpc + 5];
    put(e->out, "        case %uu: { uint32_t count = e[3]; ", lpc);
    if (max != RX_INFINITY) put(e->out, "if (count >= %uu) continue; ", max);
    put(e->out, "uint32_t q = e[2]; ");
    emit_match_one(e, lw, a0, a1, "q");
    put(e->out, " if (!ok) continue; e[2] = q; e[3] = count + 1; c->bt_sp += RX_BT_WORDS; pos = q; goto L%u; }\n", lpc + 6);
  }
  put(e->out, "        default: continue; }\n");
  put(e->out, "      default: continue;\n    }\n  }\n}\n");
  free(target); free(resumes); free(greedy); free(lazy);
}

/* The C of a program's native matchers: the class tables, the lookaround functions and
   rx_native_<id>_8 / rx_native_<id>_16 (malloc'd; the caller frees). */
char* rx_emit_c(const rx_program* p, uint32_t id){
  sb out = {0, 0, 0};
  put(&out, "/* /regexp literal %u/: the native matchers (rx_emit.c) */\n", id);
  for (uint32_t k = 0; k < p->nsets; k++){
    const rx_set* s = &p->sets[k];
    put(&out, "static const uint8_t rx_n%u_s%ub[32] = {", id, k);
    for (uint32_t i = 0; i < 32; i++) put(&out, "%s%u", i ? "," : "", s->bits[i]);
    put(&out, "};\nstatic const uint32_t rx_n%u_s%ur[%u] __attribute__((unused)) = {", id, k, s->nranges ? 2 * s->nranges : 1);   /* a guard's set (ALT_FIRST) reads only the bits */
    if (s->nranges) for (uint32_t i = 0; i < 2 * s->nranges; i++) put(&out, "%s%uu", i ? "," : "", s->ranges[i]);
    else put(&out, "0u");
    put(&out, "};\n");
  }
  emitter e; e.p = p; e.id = id; e.out = &out;
  char name[64];
  e.wide = 0; snprintf(name, sizeof name, "rx_native_%u_8", id); emit_fn(&e, name, 0, p->code_len);
  e.wide = 1; snprintf(name, sizeof name, "rx_native_%u_16", id); emit_fn(&e, name, 0, p->code_len);
  put(&out, "\n");
  return out.s;
}

/* The compiler's entry (FFI from the analyzer): compile the pattern and write its matchers.
   0 with *out the text (rx_free_text frees it); -1 on a syntax error (*out NULL: the literal
   stays on the interpreter, and the runtime throws the SyntaxError when it is evaluated). */
int rx_emit_native(const uint16_t* src, uint32_t len, uint32_t flags, uint32_t id, char** out){
  rx_error err;
  rx_program* p = rx_compile(src, len, flags, &err);
  if (!p){ *out = NULL; return -1; }
  *out = rx_emit_c(p, id);
  rx_release(p);
  return 0;
}
void rx_free_text(char* s){ free(s); }
