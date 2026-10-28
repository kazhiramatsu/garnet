/* rx_parse.c: the pattern parser of the regexp engine (docs/regexp_vm_design.md).
   ECMAScript 2025 RegExp syntax with Annex B in non-`u` mode: two passes (a group scan, then
   the grammar), an arena-allocated AST, V8's error reasons. */
#include "rx_internal.h"

typedef struct rx_path { uint32_t disj, alt; } rx_path;
typedef struct rx_gpath { uint32_t group; const rx_path* path; uint32_t len; } rx_gpath;
typedef struct rx_nref { rx_node* node; const uint16_t* name; uint32_t len; uint32_t pos; } rx_nref;

typedef struct rx_pstate {
  rx_arena* a;
  const uint16_t* s; uint32_t n, i;
  uint32_t flags; int u, v;
  uint32_t ngroups_total; int has_names;
  uint32_t gcount;
  uint16_t** names; uint32_t* name_lens;
  rx_path* path; uint32_t depth, path_cap, disj_counter;
  rx_gpath* gpaths; uint32_t ngpaths, gpaths_cap;
  rx_nref* nrefs; uint32_t nnrefs, nrefs_cap;
  uint8_t mflags;
  rx_error* err; jmp_buf jb;
} rx_pstate;

static void fail_at(rx_pstate* p, const char* msg, uint32_t pos){
  p->err->msg = msg; p->err->pos = pos; longjmp(p->jb, 1);
}
static void fail(rx_pstate* p, const char* msg){ fail_at(p, msg, p->i); }

#define END 0xFFFFFFFFu
static inline uint32_t cur(rx_pstate* p){ return p->i < p->n ? p->s[p->i] : END; }
static inline uint32_t peek(rx_pstate* p, uint32_t k){ return p->i + k < p->n ? p->s[p->i + k] : END; }
static inline int is_digit(uint32_t c){ return c >= '0' && c <= '9'; }
static inline int is_hex(uint32_t c){ return is_digit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }
static inline uint32_t hex_val(uint32_t c){ return is_digit(c) ? c - '0' : (c | 0x20u) - 'a' + 10u; }
static inline int is_ascii_letter(uint32_t c){ return (c | 0x20u) >= 'a' && (c | 0x20u) <= 'z'; }
static inline int is_syntax_char(uint32_t c){
  switch (c){ case '^': case '$': case '\\': case '.': case '*': case '+': case '?': case '(': case ')':
    case '[': case ']': case '{': case '}': case '|': case '/': return 1; default: return 0; }
}

/* v mode with `i`: MaybeSimpleCaseFolding of a set or a string */
static int vfold_on(rx_pstate* p){ return p->v && (p->mflags & RX_M_I); }
static rx_cpset vfold_set(rx_pstate* p, const rx_cpset* s){
  uint32_t n; const uint32_t* pairs = rx_fold_pairs(&n);
  return rx_cpset_map(p->a, s, pairs, n);
}
static void vfold_str(rx_cpstr* s){ for (uint32_t i = 0; i < s->n; i++) s->cps[i] = rx_fold_u(s->cps[i]); }

static rx_node* mk(rx_pstate* p, int kind){
  rx_node* n = (rx_node*)rx_arena_alloc(p->a, sizeof(rx_node));
  n->kind = (uint8_t)kind; n->mflags = p->mflags; n->greedy = 1;
  n->group_lo = 1; n->group_hi = 0;
  return n;
}
static rx_node* mk_char(rx_pstate* p, uint32_t cp){ rx_node* n = mk(p, RX_N_CHAR); n->cp = cp; return n; }

/* a growing list of nodes in the arena */
typedef struct { rx_node** v; uint32_t n, cap; } nodelist;
static void nl_push(rx_pstate* p, nodelist* l, rx_node* x){
  if (l->n == l->cap){
    uint32_t cap = l->cap ? l->cap * 2 : 8;
    rx_node** nv = (rx_node**)rx_arena_alloc(p->a, sizeof(rx_node*) * cap);
    if (l->n) memcpy(nv, l->v, sizeof(rx_node*) * l->n);
    l->v = nv; l->cap = cap;
  }
  l->v[l->n++] = x;
}

/* ---- pass 1: the capturing groups and whether any is named ---- */
static void scan_groups(rx_pstate* p){
  uint32_t i = 0; int depth = 0;   /* class nesting (1 level outside v mode) */
  while (i < p->n){
    uint32_t c = p->s[i];
    if (c == '\\'){ i += 2; continue; }
    if (depth > 0){
      if (c == ']') depth--;
      else if (c == '[' && p->v) depth++;
      i++; continue;
    }
    if (c == '['){ depth = 1; i++; continue; }
    if (c == '('){
      if (i + 1 < p->n && p->s[i+1] == '?'){
        if (i + 2 < p->n && p->s[i+2] == '<' && i + 3 < p->n && p->s[i+3] != '=' && p->s[i+3] != '!'){
          p->ngroups_total++; p->has_names = 1;
        }
      } else p->ngroups_total++;
    }
    i++;
  }
}

/* ---- the builtin classes ---- */
static const uint32_t k_space_ranges[] = { 9,13, 0x20,0x20, 0xA0,0xA0, 0x1680,0x1680, 0x2000,0x200A,
  0x2028,0x2029, 0x202F,0x202F, 0x205F,0x205F, 0x3000,0x3000, 0xFEFF,0xFEFF };
static const uint32_t k_digit_ranges[] = { '0','9' };
static const uint32_t k_word_ranges[] = { '0','9', 'A','Z', '_','_', 'a','z' };
static void builtin_set(rx_pstate* p, rx_cpset* s, uint32_t c){
  switch (c | 0x20u){
    case 'd': rx_cpset_add_ranges(p->a, s, k_digit_ranges, 1); break;
    case 's': rx_cpset_add_ranges(p->a, s, k_space_ranges, sizeof k_space_ranges / sizeof k_space_ranges[0] / 2); break;
    case 'w': rx_cpset_add_ranges(p->a, s, k_word_ranges, 4); break;
  }
}
/* the complement of a builtin class: over code units (non-u) or code points */
static uint32_t set_max(rx_pstate* p){ return p->u ? RX_MAX_CP : 0xFFFFu; }
static void builtin_class(rx_pstate* p, rx_cpset* s, uint32_t c){
  rx_cpset base = {0, 0, 0};
  builtin_set(p, &base, c);
  if (vfold_on(p)) base = vfold_set(p, &base);
  if (c >= 'a') rx_cpset_add_set(p->a, s, &base);
  else { rx_cpset inv = rx_cpset_invert(p->a, &base, set_max(p)); rx_cpset_add_set(p->a, s, &inv); }
}

/* \p{...} / \P{...} after the `p`: the name and optional value, resolved against the tables */
static void parse_property(rx_pstate* p, rx_cpset* s, int negate){
  uint32_t start = p->i;
  if (cur(p) != '{') fail(p, "Invalid property name");
  p->i++;
  char name[64]; uint32_t nl = 0; char value[64]; uint32_t vl = 0; int has_value = 0;
  for (;;){
    uint32_t c = cur(p);
    if (c == END) fail_at(p, "Invalid property name", start);
    p->i++;
    if (c == '}') break;
    if (c == '='){ if (has_value) fail_at(p, "Invalid property name", start); has_value = 1; continue; }
    if (!(is_ascii_letter(c) || is_digit(c) || c == '_')) fail_at(p, "Invalid property name", start);
    if (has_value){ if (vl >= sizeof value - 1) fail_at(p, "Invalid property name", start); value[vl++] = (char)c; }
    else { if (nl >= sizeof name - 1) fail_at(p, "Invalid property name", start); name[nl++] = (char)c; }
  }
  const uint32_t* ranges = NULL; uint32_t n = 0;
  if (!has_value){
    if (nl == 0) fail_at(p, "Invalid property name", start);
    ranges = rx_prop_lookup(name, nl, 0, &n);
  } else {
    if (nl == 0 || vl == 0) fail_at(p, "Invalid property name", start);
    int kind = -1;
    if ((nl == 2 && memcmp(name, "gc", 2) == 0) || (nl == 16 && memcmp(name, "General_Category", 16) == 0)) kind = 1;
    else if ((nl == 2 && memcmp(name, "sc", 2) == 0) || (nl == 6 && memcmp(name, "Script", 6) == 0)) kind = 2;
    else if ((nl == 3 && memcmp(name, "scx", 3) == 0) || (nl == 17 && memcmp(name, "Script_Extensions", 17) == 0)) kind = 3;
    if (kind < 0) fail_at(p, "Invalid property name", start);
    ranges = rx_prop_lookup(value, vl, kind, &n);
  }
  if (!ranges) fail_at(p, "Invalid property name", start);
  rx_cpset base = {0, 0, 0}; rx_cpset_add_ranges(p->a, &base, ranges, n);
  if (vfold_on(p)) base = vfold_set(p, &base);
  if (!negate) rx_cpset_add_set(p->a, s, &base);
  else { rx_cpset inv = rx_cpset_invert(p->a, &base, RX_MAX_CP); rx_cpset_add_set(p->a, s, &inv); }
}

/* \u escapes: at the char after `u`. Returns the code point, or END when malformed (the caller
   decides). In unicode mode (or `braces`): \u{...}, and a lead-surrogate escape followed by a
   trail-surrogate escape is one code point. */
static uint32_t parse_u_escape(rx_pstate* p, int unicode_mode){
  if (cur(p) == '{' && unicode_mode){
    uint32_t save = p->i; p->i++;
    uint32_t v = 0; uint32_t digits = 0;
    while (is_hex(cur(p))){ v = v * 16u + hex_val(cur(p)); if (v > RX_MAX_CP) v = RX_MAX_CP + 1u; p->i++; digits++; }
    if (digits == 0 || cur(p) != '}' || v > RX_MAX_CP){ p->i = save; return END; }
    p->i++;
    return v;
  }
  if (!(is_hex(cur(p)) && is_hex(peek(p, 1)) && is_hex(peek(p, 2)) && is_hex(peek(p, 3)))) return END;
  uint32_t v = (hex_val(cur(p)) << 12) | (hex_val(peek(p, 1)) << 8) | (hex_val(peek(p, 2)) << 4) | hex_val(peek(p, 3));
  p->i += 4;
  if (unicode_mode && rx_is_lead(v) && cur(p) == '\\' && peek(p, 1) == 'u' &&
      is_hex(peek(p, 2)) && is_hex(peek(p, 3)) && is_hex(peek(p, 4)) && is_hex(peek(p, 5))){
    uint32_t t = (hex_val(peek(p, 2)) << 12) | (hex_val(peek(p, 3)) << 8) | (hex_val(peek(p, 4)) << 4) | hex_val(peek(p, 5));
    if (rx_is_trail(t)){ p->i += 6; return 0x10000u + ((v - 0xD800u) << 10) + (t - 0xDC00u); }
  }
  return v;
}

/* a legacy octal escape (Annex B) starting at the current digit */
static uint32_t parse_legacy_octal(rx_pstate* p){
  uint32_t c = cur(p);
  uint32_t v = c - '0'; p->i++;
  if (v <= 3){
    if (cur(p) >= '0' && cur(p) <= '7'){ v = v * 8u + (cur(p) - '0'); p->i++;
      if (cur(p) >= '0' && cur(p) <= '7'){ v = v * 8u + (cur(p) - '0'); p->i++; } }
  } else {
    if (cur(p) >= '0' && cur(p) <= '7'){ v = v * 8u + (cur(p) - '0'); p->i++; }
  }
  return v;
}

/* A group name after `(?<` or `\k<`, up to the `>` (consumed). Returns the name as UTF-16. */
static uint16_t* parse_group_name(rx_pstate* p, uint32_t* out_len, const char* errmsg){
  uint32_t start = p->i;
  uint16_t* buf = NULL; uint32_t len = 0, cap = 0;
  int first = 1;
  for (;;){
    uint32_t c = cur(p);
    if (c == END) fail_at(p, errmsg, start);
    uint32_t cp;
    if (c == '>'){ p->i++; break; }
    if (c == '\\'){
      if (peek(p, 1) != 'u') fail_at(p, errmsg, start);
      p->i += 2;
      cp = parse_u_escape(p, 1);
      if (cp == END) fail_at(p, errmsg, start);
    } else if (rx_is_lead(c) && rx_is_trail(peek(p, 1))){
      cp = 0x10000u + ((c - 0xD800u) << 10) + (peek(p, 1) - 0xDC00u); p->i += 2;
    } else { cp = c; p->i++; }
    int ok = first ? (cp == '$' || cp == '_' || rx_is_id_start(cp))
                   : (cp == '$' || cp == '_' || cp == 0x200Cu || cp == 0x200Du || rx_is_id_continue(cp));
    if (!ok) fail_at(p, errmsg, start);
    first = 0;
    if (len + 2 > cap){
      uint32_t ncap = cap ? cap * 2 : 16;
      uint16_t* nb = (uint16_t*)rx_arena_alloc(p->a, sizeof(uint16_t) * ncap);
      if (len) memcpy(nb, buf, sizeof(uint16_t) * len);
      buf = nb; cap = ncap;
    }
    if (cp >= 0x10000u){ buf[len++] = (uint16_t)(0xD800u + ((cp - 0x10000u) >> 10)); buf[len++] = (uint16_t)(0xDC00u + ((cp - 0x10000u) & 0x3FFu)); }
    else buf[len++] = (uint16_t)cp;
  }
  if (len == 0) fail_at(p, errmsg, start);
  *out_len = len;
  return buf;
}

static int names_equal(const uint16_t* a, uint32_t al, const uint16_t* b, uint32_t bl){
  return al == bl && memcmp(a, b, sizeof(uint16_t) * al) == 0;
}

/* duplicate names: two groups may share a name only when a disjunction separates them */
static void register_group_name(rx_pstate* p, uint32_t group, uint16_t* name, uint32_t len, uint32_t pos){
  for (uint32_t g = 1; g < group; g++){
    if (!p->names[g] || !names_equal(p->names[g], p->name_lens[g], name, len)) continue;
    const rx_gpath* gp = NULL;
    for (uint32_t k = 0; k < p->ngpaths; k++) if (p->gpaths[k].group == g){ gp = &p->gpaths[k]; break; }
    int separated = 0;
    uint32_t m = gp->len < p->depth ? gp->len : p->depth;
    for (uint32_t k = 0; k < m; k++){
      if (gp->path[k].disj != p->path[k].disj) break;
      if (gp->path[k].alt != p->path[k].alt){ separated = 1; break; }
    }
    if (!separated) fail_at(p, "Duplicate capture group name", pos);
  }
  p->names[group] = name; p->name_lens[group] = len;
  if (p->ngpaths == p->gpaths_cap){
    uint32_t cap = p->gpaths_cap ? p->gpaths_cap * 2 : 8;
    rx_gpath* ng = (rx_gpath*)rx_arena_alloc(p->a, sizeof(rx_gpath) * cap);
    if (p->ngpaths) memcpy(ng, p->gpaths, sizeof(rx_gpath) * p->ngpaths);
    p->gpaths = ng; p->gpaths_cap = cap;
  }
  rx_path* copy = (rx_path*)rx_arena_alloc(p->a, sizeof(rx_path) * (p->depth ? p->depth : 1));
  memcpy(copy, p->path, sizeof(rx_path) * p->depth);
  p->gpaths[p->ngpaths].group = group; p->gpaths[p->ngpaths].path = copy; p->gpaths[p->ngpaths].len = p->depth;
  p->ngpaths++;
}

static rx_node* parse_disjunction(rx_pstate* p);

/* ---- escapes ---- */

/* An atom escape, at the character after the backslash. Returns a node; a CHAR for identity
   escapes. `leave_backslash` handles Annex B's `\c` with no letter: the node is a literal
   backslash and the `c` stays to be read as a pattern character. */
static rx_node* parse_atom_escape(rx_pstate* p){
  uint32_t esc_pos = p->i - 1;
  uint32_t c = cur(p);
  if (c == END) fail_at(p, "\\ at end of pattern", esc_pos);
  switch (c){
    case 'd': case 'D': case 's': case 'S': case 'w': case 'W': {
      p->i++;
      rx_node* n = mk(p, RX_N_CLASS);
      if (p->v){ builtin_class(p, &n->set, c); n->folded = (uint8_t)vfold_on(p); }
      else { builtin_set(p, &n->set, c); n->negate = (uint8_t)(c < 'a'); }
      return n;
    }
    case 'p': case 'P': {
      if (!p->u){ p->i++; return mk_char(p, c); }
      p->i++;
      rx_node* n = mk(p, RX_N_CLASS);
      parse_property(p, &n->set, c == 'P');
      n->folded = (uint8_t)vfold_on(p);
      return n;
    }
    case 'k': {
      if (!p->u && !p->has_names){ p->i++; return mk_char(p, 'k'); }
      p->i++;
      if (cur(p) != '<') fail_at(p, "Invalid named reference", esc_pos);
      p->i++;
      uint32_t len; uint16_t* name = parse_group_name(p, &len, "Invalid capture group name");
      rx_node* n = mk(p, RX_N_BACKREF);
      if (p->nnrefs == p->nrefs_cap){
        uint32_t cap = p->nrefs_cap ? p->nrefs_cap * 2 : 8;
        rx_nref* nr = (rx_nref*)rx_arena_alloc(p->a, sizeof(rx_nref) * cap);
        if (p->nnrefs) memcpy(nr, p->nrefs, sizeof(rx_nref) * p->nnrefs);
        p->nrefs = nr; p->nrefs_cap = cap;
      }
      p->nrefs[p->nnrefs].node = n; p->nrefs[p->nnrefs].name = name; p->nrefs[p->nnrefs].len = len; p->nrefs[p->nnrefs].pos = esc_pos;
      p->nnrefs++;
      return n;
    }
    case '0': {
      if (is_digit(peek(p, 1))){
        if (p->u) fail_at(p, "Invalid decimal escape", esc_pos);
        return mk_char(p, parse_legacy_octal(p));
      }
      p->i++;
      return mk_char(p, 0);
    }
    case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': case '9': {
      uint32_t save = p->i;
      uint64_t v = 0;
      while (is_digit(cur(p))){ v = v * 10u + (cur(p) - '0'); if (v > 0xFFFFFFFFull) v = 0xFFFFFFFFull; p->i++; }
      if (v >= 1 && v <= p->ngroups_total){
        rx_node* n = mk(p, RX_N_BACKREF);
        n->refs = (uint32_t*)rx_arena_alloc(p->a, sizeof(uint32_t)); n->refs[0] = (uint32_t)v; n->nrefs = 1;
        return n;
      }
      if (p->u) fail_at(p, "Invalid escape", esc_pos);
      p->i = save;
      if (c >= '8'){ p->i++; return mk_char(p, c); }
      return mk_char(p, parse_legacy_octal(p));
    }
    case 'f': p->i++; return mk_char(p, 0x0C);
    case 'n': p->i++; return mk_char(p, 0x0A);
    case 'r': p->i++; return mk_char(p, 0x0D);
    case 't': p->i++; return mk_char(p, 0x09);
    case 'v': p->i++; return mk_char(p, 0x0B);
    case 'c': {
      uint32_t l = peek(p, 1);
      if (is_ascii_letter(l)){ p->i += 2; return mk_char(p, l % 32u); }
      if (p->u) fail_at(p, "Invalid Unicode escape", esc_pos);
      return mk_char(p, '\\');   /* the `c` is read next as a literal */
    }
    case 'x': {
      if (is_hex(peek(p, 1)) && is_hex(peek(p, 2))){ uint32_t v = (hex_val(peek(p, 1)) << 4) | hex_val(peek(p, 2)); p->i += 3; return mk_char(p, v); }
      if (p->u) fail_at(p, "Invalid escape", esc_pos);
      p->i++; return mk_char(p, 'x');
    }
    case 'u': {
      p->i++;
      uint32_t v = parse_u_escape(p, p->u);
      if (v == END){ if (p->u) fail_at(p, "Invalid Unicode escape", esc_pos); return mk_char(p, 'u'); }
      return mk_char(p, v);
    }
    case '-':
      if (p->u) fail_at(p, "Invalid escape", esc_pos);
      p->i++; return mk_char(p, '-');
    default:
      if (is_syntax_char(c)){ p->i++; return mk_char(p, c); }
      if (p->u) fail_at(p, "Invalid escape", esc_pos);
      p->i++; return mk_char(p, c);
  }
}

/* A class escape (inside [...], not v mode), at the character after the backslash. Returns 1
   with *cp set for a single character, 0 with the set filled for a class escape. */
static int parse_class_escape(rx_pstate* p, rx_cpset* set, uint32_t* cp){
  uint32_t esc_pos = p->i - 1;
  uint32_t c = cur(p);
  if (c == END) fail_at(p, "\\ at end of pattern", esc_pos);
  switch (c){
    case 'd': case 'D': case 's': case 'S': case 'w': case 'W':
      p->i++; builtin_class(p, set, c); return 0;
    case 'p': case 'P':
      if (!p->u){ p->i++; *cp = c; return 1; }
      p->i++; parse_property(p, set, c == 'P'); return 0;
    case 'b': p->i++; *cp = 8; return 1;
    case '-': p->i++; *cp = '-'; return 1;
    case 'c': {
      uint32_t l = peek(p, 1);
      if (is_ascii_letter(l) || (!p->u && (is_digit(l) || l == '_'))){ p->i += 2; *cp = l % 32u; return 1; }
      if (p->u) fail_at(p, "Invalid Unicode escape", esc_pos);
      *cp = '\\'; return 1;          /* the `c` is read next as a literal */
    }
    case 'B':
      if (p->u) fail_at(p, "Invalid escape", esc_pos);
      p->i++; *cp = 'B'; return 1;
    case 'k':
      if (p->u || p->has_names) fail_at(p, "Invalid escape", esc_pos);
      p->i++; *cp = 'k'; return 1;
    case '0':
      if (is_digit(peek(p, 1))){
        if (p->u) fail_at(p, "Invalid decimal escape", esc_pos);
        *cp = parse_legacy_octal(p); return 1;
      }
      p->i++; *cp = 0; return 1;
    case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': case '9':
      if (p->u) fail_at(p, "Invalid decimal escape", esc_pos);
      if (c >= '8'){ p->i++; *cp = c; return 1; }
      *cp = parse_legacy_octal(p); return 1;
    case 'f': p->i++; *cp = 0x0C; return 1;
    case 'n': p->i++; *cp = 0x0A; return 1;
    case 'r': p->i++; *cp = 0x0D; return 1;
    case 't': p->i++; *cp = 0x09; return 1;
    case 'v': p->i++; *cp = 0x0B; return 1;
    case 'x':
      if (is_hex(peek(p, 1)) && is_hex(peek(p, 2))){ *cp = (hex_val(peek(p, 1)) << 4) | hex_val(peek(p, 2)); p->i += 3; return 1; }
      if (p->u) fail_at(p, "Invalid escape", esc_pos);
      p->i++; *cp = 'x'; return 1;
    case 'u': {
      p->i++;
      uint32_t v = parse_u_escape(p, p->u);
      if (v == END){ if (p->u) fail_at(p, "Invalid Unicode escape", esc_pos); *cp = 'u'; return 1; }
      *cp = v; return 1;
    }
    default:
      if (is_syntax_char(c)){ p->i++; *cp = c; return 1; }
      if (p->u) fail_at(p, "Invalid escape", esc_pos);
      p->i++; *cp = c; return 1;
  }
}

/* a pattern character: a code point in unicode mode, a code unit otherwise */
static uint32_t read_char(rx_pstate* p){
  uint32_t c = cur(p); p->i++;
  if (p->u && rx_is_lead(c) && rx_is_trail(cur(p))){ uint32_t t = cur(p); p->i++; return 0x10000u + ((c - 0xD800u) << 10) + (t - 0xDC00u); }
  return c;
}

/* ---- classes (u and non-u) ---- */
/* one class atom: a character (returns 1, *cp) or a class escape set (returns 0) */
static int parse_class_atom(rx_pstate* p, rx_cpset* set, uint32_t* cp){
  uint32_t c = cur(p);
  if (c == '\\'){ p->i++; return parse_class_escape(p, set, cp); }
  *cp = read_char(p);
  return 1;
}
static rx_node* parse_class(rx_pstate* p){
  uint32_t start = p->i; p->i++;   /* [ */
  rx_node* n = mk(p, RX_N_CLASS);
  if (cur(p) == '^'){ n->negate = 1; p->i++; }
  for (;;){
    uint32_t c = cur(p);
    if (c == END) fail_at(p, "Unterminated character class", start);
    if (c == ']'){ p->i++; break; }
    uint32_t a; rx_cpset aset = {0, 0, 0};
    int a_is_char = parse_class_atom(p, &aset, &a);
    if (cur(p) == '-' && peek(p, 1) != ']' && peek(p, 1) != END){
      p->i++;
      uint32_t b; rx_cpset bset = {0, 0, 0};
      int b_is_char = parse_class_atom(p, &bset, &b);
      if (!a_is_char || !b_is_char){
        if (p->u) fail_at(p, "Invalid character class", start);
        /* Annex B: the dash is a literal */
        if (a_is_char) rx_cpset_add(p->a, &n->set, a, a); else rx_cpset_add_set(p->a, &n->set, &aset);
        rx_cpset_add(p->a, &n->set, '-', '-');
        if (b_is_char) rx_cpset_add(p->a, &n->set, b, b); else rx_cpset_add_set(p->a, &n->set, &bset);
        continue;
      }
      if (a > b) fail_at(p, "Range out of order in character class", start);
      rx_cpset_add(p->a, &n->set, a, b);
      continue;
    }
    if (a_is_char) rx_cpset_add(p->a, &n->set, a, a); else rx_cpset_add_set(p->a, &n->set, &aset);
  }
  return n;
}

/* ---- classes (v mode): ClassSetExpression over sets of code points and strings ---- */
typedef struct { rx_cpset set; rx_strlist strs; int may_strings; } vclass;
static void strlist_push(rx_pstate* p, rx_strlist* l, rx_cpstr s){
  for (uint32_t i = 0; i < l->n; i++)
    if (l->s[i].n == s.n && (s.n == 0 || memcmp(l->s[i].cps, s.cps, sizeof(uint32_t) * s.n) == 0)) return;
  if (l->n == l->cap){
    uint32_t cap = l->cap ? l->cap * 2 : 4;
    rx_cpstr* ns = (rx_cpstr*)rx_arena_alloc(p->a, sizeof(rx_cpstr) * cap);
    if (l->n) memcpy(ns, l->s, sizeof(rx_cpstr) * l->n);
    l->s = ns; l->cap = cap;
  }
  l->s[l->n++] = s;
}
static int strlist_has(const rx_strlist* l, rx_cpstr s){
  for (uint32_t i = 0; i < l->n; i++)
    if (l->s[i].n == s.n && (s.n == 0 || memcmp(l->s[i].cps, s.cps, sizeof(uint32_t) * s.n) == 0)) return 1;
  return 0;
}
static void vclass_union(rx_pstate* p, vclass* a, const vclass* b){
  rx_cpset_add_set(p->a, &a->set, &b->set);
  for (uint32_t i = 0; i < b->strs.n; i++) strlist_push(p, &a->strs, b->strs.s[i]);
  a->may_strings |= b->may_strings;
}
static void vclass_intersect(rx_pstate* p, vclass* a, const vclass* b){
  a->set = rx_cpset_intersect(p->a, &a->set, &b->set);
  rx_strlist out = {0, 0, 0};
  for (uint32_t i = 0; i < a->strs.n; i++) if (strlist_has(&b->strs, a->strs.s[i])) strlist_push(p, &out, a->strs.s[i]);
  a->strs = out;
  a->may_strings = a->may_strings && b->may_strings;
}
static void vclass_subtract(rx_pstate* p, vclass* a, const vclass* b){
  a->set = rx_cpset_subtract(p->a, &a->set, &b->set);
  rx_strlist out = {0, 0, 0};
  for (uint32_t i = 0; i < a->strs.n; i++) if (!strlist_has(&b->strs, a->strs.s[i])) strlist_push(p, &out, a->strs.s[i]);
  a->strs = out;
}
static int is_class_set_syntax(uint32_t c){
  switch (c){ case '(': case ')': case '[': case ']': case '{': case '}': case '/': case '-': case '\\': case '|': return 1; default: return 0; }
}
static int is_class_set_reserved_punct(uint32_t c){
  switch (c){ case '&': case '-': case '!': case '#': case '%': case ',': case ':': case ';': case '<': case '=': case '>': case '@': case '`': case '~': return 1; default: return 0; }
}
static int is_double_punct_char(uint32_t c){
  switch (c){ case '&': case '!': case '#': case '$': case '%': case '*': case '+': case ',': case '.': case ':': case ';':
    case '<': case '=': case '>': case '?': case '@': case '^': case '`': case '~': return 1; default: return 0; }
}
/* a ClassSetCharacter: returns the code point, or END when the current input is not one */
static uint32_t parse_class_set_char(rx_pstate* p, uint32_t class_start){
  uint32_t c = cur(p);
  if (c == END) fail_at(p, "Unterminated character class", class_start);
  if (c == '\\'){
    uint32_t e = peek(p, 1);
    if (e == END) fail_at(p, "\\ at end of pattern", p->i);
    if (is_class_set_reserved_punct(e)){ p->i += 2; return e; }
    if (e == 'b'){ p->i += 2; return 8; }
    p->i++;
    rx_cpset dummy = {0, 0, 0}; uint32_t cp;
    int single = parse_class_escape(p, &dummy, &cp);
    if (!single) fail_at(p, "Invalid character class", class_start);
    return cp;
  }
  if (is_class_set_syntax(c)) fail_at(p, "Invalid character in character class", p->i);
  if (is_double_punct_char(c) && peek(p, 1) == c) fail_at(p, "Invalid set operation in character class", p->i);
  return read_char(p);
}
static vclass parse_class_v_body(rx_pstate* p, uint32_t class_start);
/* one operand: a nested class, \q{...}, a class escape, or a character (optionally a range when
   `allow_range`); *is_char tells a single character operand */
static vclass parse_class_set_operand(rx_pstate* p, uint32_t class_start, int allow_range, int* was_range){
  vclass out; memset(&out, 0, sizeof out); *was_range = 0;
  uint32_t c = cur(p);
  if (c == '['){
    uint32_t nstart = p->i; p->i++;
    int neg = 0; if (cur(p) == '^'){ neg = 1; p->i++; }
    vclass inner = parse_class_v_body(p, nstart);
    if (neg){
      if (inner.may_strings) fail_at(p, "Negated character class may contain strings", nstart);
      inner.set = rx_cpset_invert(p->a, &inner.set, RX_MAX_CP);
      inner.strs.n = 0;
    }
    return inner;
  }
  if (c == '\\'){
    uint32_t e = peek(p, 1);
    if (e == 'q'){
      if (peek(p, 2) != '{') fail_at(p, "Invalid escape", p->i);
      p->i += 3;
      /* alternatives of ClassSetCharacters separated by |, up to } */
      uint32_t* buf = (uint32_t*)rx_arena_alloc(p->a, sizeof(uint32_t) * 64); uint32_t cap = 64, len = 0;
      out.may_strings = 0;
      for (;;){
        uint32_t d = cur(p);
        if (d == END) fail_at(p, "Unterminated character class", class_start);
        if (d == '|' || d == '}'){
          p->i++;
          if (len == 1) rx_cpset_add(p->a, &out.set, vfold_on(p) ? rx_fold_u(buf[0]) : buf[0], vfold_on(p) ? rx_fold_u(buf[0]) : buf[0]);
          else {
            rx_cpstr s; s.n = len; s.cps = (uint32_t*)rx_arena_alloc(p->a, sizeof(uint32_t) * (len ? len : 1));
            memcpy(s.cps, buf, sizeof(uint32_t) * len);
            if (vfold_on(p)) vfold_str(&s);
            strlist_push(p, &out.strs, s); out.may_strings = 1;
          }
          len = 0;
          if (d == '}') break;
          continue;
        }
        uint32_t cp = parse_class_set_char(p, class_start);
        if (len == cap){ uint32_t* nb = (uint32_t*)rx_arena_alloc(p->a, sizeof(uint32_t) * cap * 2); memcpy(nb, buf, sizeof(uint32_t) * len); buf = nb; cap *= 2; }
        buf[len++] = cp;
      }
      return out;
    }
    if (e == 'd' || e == 'D' || e == 's' || e == 'S' || e == 'w' || e == 'W' || e == 'p' || e == 'P'){
      p->i++;
      uint32_t cp;
      parse_class_escape(p, &out.set, &cp);   /* builtin_class / parse_property fold in v mode */
      return out;
    }
  }
  uint32_t a = parse_class_set_char(p, class_start);
  if (allow_range && cur(p) == '-' && peek(p, 1) != '-'){
    p->i++;
    uint32_t b = parse_class_set_char(p, class_start);
    if (a > b) fail_at(p, "Range out of order in character class", class_start);
    rx_cpset_add(p->a, &out.set, a, b);
    if (vfold_on(p)) out.set = vfold_set(p, &out.set);
    *was_range = 1;
    return out;
  }
  rx_cpset_add(p->a, &out.set, vfold_on(p) ? rx_fold_u(a) : a, vfold_on(p) ? rx_fold_u(a) : a);
  return out;
}
static vclass parse_class_v_body(rx_pstate* p, uint32_t class_start){
  vclass acc; memset(&acc, 0, sizeof acc);
  if (cur(p) == ']'){ p->i++; return acc; }
  int first_range = 0;
  acc = parse_class_set_operand(p, class_start, 1, &first_range);
  uint32_t c = cur(p);
  if (first_range && ((c == '&' && peek(p, 1) == '&') || (c == '-' && peek(p, 1) == '-'))) fail_at(p, "Invalid set operation in character class", p->i);
  if (c == '&' && peek(p, 1) == '&'){
    for (;;){
      if (cur(p) == ']'){ p->i++; return acc; }
      if (!(cur(p) == '&' && peek(p, 1) == '&')) fail_at(p, "Invalid set operation in character class", p->i);
      p->i += 2;
      if (cur(p) == '&') fail_at(p, "Invalid character in character class", p->i);
      int wr; vclass rhs = parse_class_set_operand(p, class_start, 0, &wr);
      vclass_intersect(p, &acc, &rhs);
    }
  }
  if (c == '-' && peek(p, 1) == '-'){
    for (;;){
      if (cur(p) == ']'){ p->i++; return acc; }
      if (!(cur(p) == '-' && peek(p, 1) == '-')) fail_at(p, "Invalid set operation in character class", p->i);
      p->i += 2;
      int wr; vclass rhs = parse_class_set_operand(p, class_start, 0, &wr);
      vclass_subtract(p, &acc, &rhs);
    }
  }
  for (;;){
    c = cur(p);
    if (c == END) fail_at(p, "Unterminated character class", class_start);
    if (c == ']'){ p->i++; return acc; }
    if ((c == '&' && peek(p, 1) == '&') || (c == '-' && peek(p, 1) == '-')) fail_at(p, "Invalid set operation in character class", p->i);
    if (c == '-') fail_at(p, "Invalid character class", class_start);
    int wr; vclass rhs = parse_class_set_operand(p, class_start, 1, &wr);
    vclass_union(p, &acc, &rhs);
  }
}
static rx_node* parse_class_v(rx_pstate* p){
  uint32_t start = p->i; p->i++;
  rx_node* n = mk(p, RX_N_CLASS);
  if (cur(p) == '^'){ n->negate = 1; p->i++; }
  vclass v = parse_class_v_body(p, start);
  if (n->negate && v.may_strings) fail_at(p, "Negated character class may contain strings", start);
  n->set = v.set; n->strs = v.strs;
  n->folded = (uint8_t)vfold_on(p);
  if (n->negate){ n->set = rx_cpset_invert(p->a, &n->set, RX_MAX_CP); n->negate = 0; n->strs.n = 0; }
  return n;
}

/* ---- quantifiers ---- */
/* a braced quantifier at `{`: returns 1 and fills min/max when well formed (p->i after it) */
static int parse_braced(rx_pstate* p, uint32_t* min, uint32_t* max){
  uint32_t save = p->i;
  if (cur(p) != '{'){ return 0; }
  p->i++;
  if (!is_digit(cur(p))){ p->i = save; return 0; }
  uint64_t a = 0;
  while (is_digit(cur(p))){ a = a * 10u + (cur(p) - '0'); if (a > 0xFFFFFFFEull) a = 0xFFFFFFFEull; p->i++; }
  uint64_t b = a;
  if (cur(p) == ','){
    p->i++;
    if (is_digit(cur(p))){
      b = 0;
      while (is_digit(cur(p))){ b = b * 10u + (cur(p) - '0'); if (b > 0xFFFFFFFEull) b = 0xFFFFFFFEull; p->i++; }
    } else b = RX_INFINITY;
  }
  if (cur(p) != '}'){ p->i = save; return 0; }
  p->i++;
  *min = (uint32_t)a; *max = (uint32_t)b;
  return 1;
}
static rx_node* parse_quantifier(rx_pstate* p, rx_node* atom, uint32_t group_lo, uint32_t group_hi){
  uint32_t c = cur(p);
  uint32_t min, max; uint32_t qpos = p->i;
  if (c == '*'){ min = 0; max = RX_INFINITY; p->i++; }
  else if (c == '+'){ min = 1; max = RX_INFINITY; p->i++; }
  else if (c == '?'){ min = 0; max = 1; p->i++; }
  else if (c == '{'){
    if (!parse_braced(p, &min, &max)){
      if (p->u) fail(p, "Incomplete quantifier");
      return atom;   /* Annex B: the brace is a pattern character, read by the next term */
    }
  } else return atom;
  int greedy = 1;
  if (cur(p) == '?'){ greedy = 0; p->i++; }
  if (atom->kind == RX_N_LOOK){
    if (atom->behind || p->u) fail_at(p, "Invalid quantifier", qpos);
  } else if (atom->kind == RX_N_BOL || atom->kind == RX_N_EOL || atom->kind == RX_N_WORDB || atom->kind == RX_N_NWORDB){
    fail_at(p, "Nothing to repeat", qpos);
  }
  if (min > max && max != RX_INFINITY) fail_at(p, "numbers out of order in {} quantifier", qpos);
  rx_node* q = mk(p, RX_N_QUANT);
  q->body = atom; q->min = min; q->max = max; q->greedy = (uint8_t)greedy;
  q->group_lo = group_lo; q->group_hi = group_hi;
  return q;
}

/* ---- groups and terms ---- */
static rx_node* parse_group(rx_pstate* p){
  uint32_t start = p->i; p->i++;   /* ( */
  rx_node* n = mk(p, RX_N_GROUP);
  uint8_t saved_m = p->mflags;
  if (cur(p) == '?'){
    p->i++;
    uint32_t c = cur(p);
    if (c == ':'){ p->i++; }
    else if (c == '<'){
      p->i++;
      uint32_t len; uint32_t npos = p->i;
      uint16_t* name = parse_group_name(p, &len, "Invalid capture group name");
      n->group = ++p->gcount;
      register_group_name(p, n->group, name, len, npos);
    } else if (c == 'i' || c == 'm' || c == 's' || c == '-'){
      uint32_t add = 0, remove = 0;
      for (;;){
        uint32_t d = cur(p); uint32_t bit = d == 'i' ? RX_M_I : d == 'm' ? RX_M_M : d == 's' ? RX_M_S : 0;
        if (!bit) break;
        if (add & bit) fail(p, "Repeated flag in flag group");
        add |= bit; p->i++;
      }
      if (cur(p) == '-'){
        p->i++;
        for (;;){
          uint32_t d = cur(p); uint32_t bit = d == 'i' ? RX_M_I : d == 'm' ? RX_M_M : d == 's' ? RX_M_S : 0;
          if (!bit) break;
          if ((add | remove) & bit) fail(p, "Repeated flag in flag group");
          remove |= bit; p->i++;
        }
        if (add == 0 && remove == 0) fail_at(p, "Invalid flag group", start);
      }
      if (cur(p) != ':') fail_at(p, "Invalid group", start);
      p->i++;
      p->mflags = (uint8_t)((p->mflags | add) & ~remove);
    } else fail_at(p, "Invalid group", start);
  } else {
    n->group = ++p->gcount;
  }
  n->body = parse_disjunction(p);
  if (cur(p) != ')') fail_at(p, "Unterminated group", start);
  p->i++;
  p->mflags = saved_m;
  return n;
}

static rx_node* parse_term(rx_pstate* p){
  uint32_t c = cur(p);
  if (c == END || c == '|' || c == ')') return NULL;
  uint32_t glo = p->gcount + 1;
  rx_node* atom;
  switch (c){
    case '^': p->i++; return mk(p, RX_N_BOL);
    case '$': p->i++; return mk(p, RX_N_EOL);
    case '\\': {
      uint32_t e = peek(p, 1);
      if (e == 'b'){ p->i += 2; return mk(p, RX_N_WORDB); }
      if (e == 'B'){ p->i += 2; return mk(p, RX_N_NWORDB); }
      p->i++;
      atom = parse_atom_escape(p);
      break;
    }
    case '(': {
      if (peek(p, 1) == '?' && (peek(p, 2) == '=' || peek(p, 2) == '!' ||
          (peek(p, 2) == '<' && (peek(p, 3) == '=' || peek(p, 3) == '!')))){
        uint32_t start = p->i;
        int behind = peek(p, 2) == '<';
        int neg = (behind ? peek(p, 3) : peek(p, 2)) == '!';
        p->i += behind ? 4 : 3;
        rx_node* n = mk(p, RX_N_LOOK);
        n->behind = (uint8_t)behind; n->negate = (uint8_t)neg;
        n->body = parse_disjunction(p);
        if (cur(p) != ')') fail_at(p, "Unterminated group", start);
        p->i++;
        atom = n;
      } else atom = parse_group(p);
      break;
    }
    case '.': p->i++; atom = mk(p, RX_N_DOT); break;
    case '[': atom = p->v ? parse_class_v(p) : parse_class(p); break;
    case '*': case '+': case '?': fail(p, "Nothing to repeat");
    case '{': {
      uint32_t min, max; uint32_t save = p->i;
      if (parse_braced(p, &min, &max)){ p->i = save; fail(p, "Nothing to repeat"); }
      if (p->u) fail(p, "Lone quantifier brackets");
      p->i++; atom = mk_char(p, '{'); break;
    }
    case '}': case ']':
      if (p->u) fail(p, "Lone quantifier brackets");
      p->i++; atom = mk_char(p, c); break;
    default:
      atom = mk_char(p, read_char(p));
      break;
  }
  return parse_quantifier(p, atom, glo, p->gcount);
}

static rx_node* parse_alternative(rx_pstate* p){
  nodelist terms = {0, 0, 0};
  rx_node* t;
  while ((t = parse_term(p)) != NULL) nl_push(p, &terms, t);
  if (terms.n == 0) return mk(p, RX_N_EMPTY);
  if (terms.n == 1) return terms.v[0];
  rx_node* seq = mk(p, RX_N_SEQ);
  seq->kids = terms.v; seq->nkids = terms.n;
  return seq;
}
static rx_node* parse_disjunction(rx_pstate* p){
  if (p->depth == p->path_cap){
    uint32_t cap = p->path_cap ? p->path_cap * 2 : 16;
    rx_path* np = (rx_path*)rx_arena_alloc(p->a, sizeof(rx_path) * cap);
    if (p->depth) memcpy(np, p->path, sizeof(rx_path) * p->depth);
    p->path = np; p->path_cap = cap;
  }
  p->path[p->depth].disj = ++p->disj_counter; p->path[p->depth].alt = 0; p->depth++;
  nodelist alts = {0, 0, 0};
  nl_push(p, &alts, parse_alternative(p));
  while (cur(p) == '|'){
    p->i++;
    p->path[p->depth - 1].alt++;
    nl_push(p, &alts, parse_alternative(p));
  }
  p->depth--;
  if (alts.n == 1) return alts.v[0];
  rx_node* alt = mk(p, RX_N_ALT);
  alt->kids = alts.v; alt->nkids = alts.n;
  return alt;
}

rx_node* rx_parse(rx_arena* arena, const uint16_t* src, uint32_t len, uint32_t flags,
                  uint32_t* ngroups, uint16_t*** names, uint32_t** name_lens, rx_error* err){
  rx_pstate st; memset(&st, 0, sizeof st);
  rx_pstate* p = &st;
  p->a = arena; p->s = src; p->n = len; p->flags = flags;
  p->u = (flags & RX_F_EITHER_UNICODE) != 0; p->v = (flags & RX_F_UNICODE_SETS) != 0;
  p->mflags = (uint8_t)(((flags & RX_F_IGNORECASE) ? RX_M_I : 0) | ((flags & RX_F_MULTILINE) ? RX_M_M : 0) | ((flags & RX_F_DOTALL) ? RX_M_S : 0));
  p->err = err;
  err->msg = NULL; err->pos = 0;
  if (setjmp(p->jb)) return NULL;
  scan_groups(p);
  p->names = (uint16_t**)rx_arena_alloc(arena, sizeof(uint16_t*) * (p->ngroups_total + 1));
  p->name_lens = (uint32_t*)rx_arena_alloc(arena, sizeof(uint32_t) * (p->ngroups_total + 1));
  rx_node* root = parse_disjunction(p);
  if (p->i < p->n){
    if (cur(p) == ')') fail(p, "Unmatched ')'");
    fail(p, "Unexpected character");
  }
  /* resolve named backreferences */
  for (uint32_t k = 0; k < p->nnrefs; k++){
    rx_nref* r = &p->nrefs[k];
    uint32_t count = 0;
    for (uint32_t g = 1; g <= p->ngroups_total; g++)
      if (p->names[g] && names_equal(p->names[g], p->name_lens[g], r->name, r->len)) count++;
    if (count == 0) fail_at(p, "Invalid named capture referenced", r->pos);
    r->node->refs = (uint32_t*)rx_arena_alloc(arena, sizeof(uint32_t) * count);
    r->node->nrefs = 0;
    for (uint32_t g = 1; g <= p->ngroups_total; g++)
      if (p->names[g] && names_equal(p->names[g], p->name_lens[g], r->name, r->len)) r->node->refs[r->node->nrefs++] = g;
  }
  *ngroups = p->gcount; *names = p->names; *name_lens = p->name_lens;
  return root;
}
