#include "../ts_rt.h"
#include "ts_regexp_adapter.h"
#include <stdbool.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#ifdef TSAOT_HAS_QUICKJS_REGEXP
#include "libregexp.h"
#endif

struct ts_regexp_compiled {
  uint8_t* bytecode;
  int bytecode_len;
  uint32_t capture_count;
  uint32_t flags;
  /* The pattern can only match at position 0 (a leading `^` without the m
     flag and without a top-level alternation): the bytecode is compiled
     without the engine's search prefix, so a failing attempt costs one
     try instead of one per input position, and a start index past 0 is a
     miss without running the engine. */
  uint8_t anchored;
  /* First-character prefilter (below): the bytecode is compiled sticky and
     the engine runs only at input positions holding a code unit that can
     start a match (first_table for units below 256, first_wide for the
     rest; first_pos0: an alternative anchored with `^`). */
  uint8_t prefilter, first_wide, first_pos0;
  uint8_t first_table[256];
};

typedef struct ts_regexp_cache_entry {
  char* pattern;
  uint32_t pattern_len;
  uint32_t flags;
  ts_regexp_compiled* compiled;
  struct ts_regexp_cache_entry* next;
} ts_regexp_cache_entry;

static ts_regexp_cache_entry* g_regexp_cache = NULL;

int ts_regexp_adapter_available(void){
#ifdef TSAOT_HAS_QUICKJS_REGEXP
  return 1;
#else
  return 0;
#endif
}

tsv ts_regexp_adapter_unsupported(const char* feature){
  return ts_unsupported_builtin(feature ? feature : "RegExp");
}

static void ts_regexp_error(char* buf, uint32_t len, const char* msg){
  if (!buf || len == 0) return;
  if (!msg) msg = "";
  size_t n = strlen(msg);
  if (n >= len) n = len - 1;
  memcpy(buf, msg, n);
  buf[n] = 0;
}

/* `^` at the very start, and no `|` outside groups and classes (an escaped
   `|` and a `|` inside `[...]` do not split the pattern). */
static int ts_regexp_pattern_anchored(const char* p, uint32_t n){
  if (n == 0 || p[0] != '^') return 0;
  int depth = 0, in_class = 0;
  for (uint32_t i = 1; i < n; i++){
    char c = p[i];
    if (c == '\\'){ i++; continue; }
    if (in_class){ if (c == ']') in_class = 0; continue; }
    if (c == '['){ in_class = 1; continue; }
    if (c == '(') depth++;
    else if (c == ')'){ if (depth > 0) depth--; }
    else if (c == '|' && depth == 0) return 0;
  }
  return 1;
}


/* ---- first-character prefilter ----
   For a pattern whose every match must start with a code unit from a small
   set (no i/m/u/v/y flags), the bytecode is compiled sticky and the adapter
   tries the engine only at input positions holding such a unit: the
   checker's `/[^İıßa-z0-9\\/:\-_. ]+/g` over a lower-case
   path and `/\/\/|(?:^|\/)\.\.?(?:$|\/)/` over a normal path then cost a
   table scan instead of an engine attempt per position. The set comes from
   a parse of the first term of every alternative (a literal, an escape, a
   class, a group recursively); anything else (`.`, a zero-width assertion,
   a nullable first term, a back reference, a property escape, an unknown
   construct) disables the prefilter and keeps the engine's own search. A
   set containing a lower-case letter is not selective on identifiers and
   paths and is not used either. TSAOT_REGEXP_PREFILTER=0 disables it. */
typedef struct ts_regexp_firstset {
  uint8_t table[256];
  uint8_t wide;
  uint8_t pos0;
} ts_regexp_firstset;
static int g_regexp_prefilter = -1;
static void fs_add(ts_regexp_firstset* fs, uint32_t cu){ if (cu < 256u) fs->table[cu] = 1; else fs->wide = 1; }
static void fs_add_range(ts_regexp_firstset* fs, uint32_t lo, uint32_t hi){
  for (uint32_t c = lo; c <= hi && c < 256u; c++) fs->table[c] = 1;
  if (hi >= 256u) fs->wide = 1;
}
static void fs_add_complement(ts_regexp_firstset* fs, const ts_regexp_firstset* base){
  for (uint32_t c = 0; c < 256u; c++) if (!base->table[c]) fs->table[c] = 1;
  fs->wide = 1;
}
static int fs_class_escape(char e, ts_regexp_firstset* fs){
  switch (e){
    case 'd': fs_add_range(fs, '0', '9'); return 1;
    case 'w': fs_add_range(fs, 'a', 'z'); fs_add_range(fs, 'A', 'Z'); fs_add_range(fs, '0', '9'); fs_add(fs, '_'); return 1;
    case 's': fs_add_range(fs, 9, 13); fs_add(fs, 32); fs_add(fs, 0xA0); fs->wide = 1; return 1;
    case 'D': case 'W': case 'S': {
      ts_regexp_firstset base; memset(&base, 0, sizeof base);
      fs_class_escape((char)(e + ('a' - 'A')), &base);
      fs_add_complement(fs, &base);
      return 1;
    }
    default: return 0;
  }
}
static int fs_decode_utf8(const char* p, uint32_t n, uint32_t* i, uint32_t* cp){
  unsigned char c = (unsigned char)p[*i];
  if (c < 0x80u){ *cp = c; (*i)++; return 1; }
  int extra = c >= 0xF0u ? 3 : c >= 0xE0u ? 2 : c >= 0xC0u ? 1 : -1;
  if (extra < 0 || *i + (uint32_t)extra >= n) return 0;
  uint32_t v = c & (0x3Fu >> extra);
  for (int k = 1; k <= extra; k++){
    unsigned char d = (unsigned char)p[*i + (uint32_t)k];
    if ((d & 0xC0u) != 0x80u) return 0;
    v = (v << 6) | (d & 0x3Fu);
  }
  *i += (uint32_t)extra + 1u;
  *cp = v;
  return 1;
}
static int fs_hex(const char* p, uint32_t n, uint32_t i, uint32_t count, uint32_t* out){
  uint32_t v = 0;
  for (uint32_t k = 0; k < count; k++){
    if (i + k >= n) return 0;
    char h = p[i + k]; uint32_t d;
    if (h >= '0' && h <= '9') d = (uint32_t)(h - '0');
    else if (h >= 'a' && h <= 'f') d = (uint32_t)(h - 'a' + 10);
    else if (h >= 'A' && h <= 'F') d = (uint32_t)(h - 'A' + 10);
    else return 0;
    v = v * 16u + d;
  }
  *out = v;
  return 1;
}
/* An escape at p[*i] == '\\': adds its first set; *single receives the code
   unit of a single-unit escape or UINT32_MAX for a class escape. 0 = bail. */
static int fs_escape(const char* p, uint32_t n, uint32_t* i, ts_regexp_firstset* fs, int in_class, uint32_t* single){
  uint32_t j = *i + 1u;
  if (j >= n) return 0;
  char e = p[j];
  uint32_t cu;
  *single = UINT32_MAX;
  switch (e){
    case 'd': case 'D': case 'w': case 'W': case 's': case 'S':
      fs_class_escape(e, fs); *i = j + 1u; return 1;
    case 'n': cu = 10; j++; break;
    case 'r': cu = 13; j++; break;
    case 't': cu = 9; j++; break;
    case 'v': cu = 11; j++; break;
    case 'f': cu = 12; j++; break;
    case '0': if (j + 1u < n && p[j + 1u] >= '0' && p[j + 1u] <= '9') return 0; cu = 0; j++; break;
    case 'b': if (!in_class) return 0; cu = 8; j++; break;
    case 'B': case 'p': case 'P': case 'k': return 0;
    case 'x': if (!fs_hex(p, n, j + 1u, 2, &cu)) return 0; j += 3u; break;
    case 'u': if (!fs_hex(p, n, j + 1u, 4, &cu)) return 0; j += 5u; break;
    case 'c': if (j + 1u >= n) return 0; { char l = p[j + 1u]; if (!((l >= 'a' && l <= 'z') || (l >= 'A' && l <= 'Z'))) return 0; cu = (uint32_t)l & 31u; } j += 2u; break;
    default:
      if (e >= '1' && e <= '9') return 0;   /* back reference or legacy octal */
      if (!fs_decode_utf8(p, n, &j, &cu)) return 0;   /* identity escape */
      break;
  }
  fs_add(fs, cu);
  *single = cu;
  *i = j;
  return 1;
}
static int fs_class(const char* p, uint32_t n, uint32_t* i, ts_regexp_firstset* fs){
  uint32_t j = *i + 1u;
  int negated = 0;
  if (j < n && p[j] == '^'){ negated = 1; j++; }
  ts_regexp_firstset cs; memset(&cs, 0, sizeof cs);
  while (j < n && p[j] != ']'){
    uint32_t lo;
    if (p[j] == '\\'){
      if (!fs_escape(p, n, &j, &cs, 1, &lo)) return 0;
      if (lo == UINT32_MAX) continue;   /* a class escape: no range */
    } else if (p[j] == '['){
      return 0;   /* nested class (v flag) */
    } else if (!fs_decode_utf8(p, n, &j, &lo)) return 0;
    if (j + 1u < n && p[j] == '-' && p[j + 1u] != ']'){
      uint32_t hi;
      j++;
      if (p[j] == '\\'){
        if (!fs_escape(p, n, &j, &cs, 1, &hi)) return 0;
        if (hi == UINT32_MAX) return 0;
      } else if (p[j] == '['){
        return 0;
      } else if (!fs_decode_utf8(p, n, &j, &hi)) return 0;
      if (lo > hi) return 0;
      fs_add_range(&cs, lo, hi);
    } else {
      fs_add(&cs, lo);
    }
  }
  if (j >= n) return 0;
  *i = j + 1u;
  if (negated) fs_add_complement(fs, &cs);
  else { for (uint32_t c = 0; c < 256u; c++) if (cs.table[c]) fs->table[c] = 1; if (cs.wide) fs->wide = 1; }
  return 1;
}
static int fs_alternation(const char* p, uint32_t n, uint32_t* i, int depth, ts_regexp_firstset* fs);
/* The first term of an alternative at p[*i] and its quantifier. 0 = bail. */
static int fs_term(const char* p, uint32_t n, uint32_t* i, int depth, ts_regexp_firstset* fs){
  uint32_t j = *i;
  if (j >= n) return 0;
  char c = p[j];
  switch (c){
    case '^': fs->pos0 = 1; *i = j + 1u; return 1;   /* anchored alternative: position 0 only */
    case '$': case '.': case '|': case ')': case '*': case '+': case '?': case '{': case '}': case ']':
      return 0;
    case '(':
      j++;
      if (j < n && p[j] == '?'){
        if (j + 1u < n && p[j + 1u] == ':') j += 2u;
        else if (j + 2u < n && p[j + 1u] == '<' && p[j + 2u] != '=' && p[j + 2u] != '!'){
          while (j < n && p[j] != '>') j++;
          if (j >= n) return 0;
          j++;
        } else return 0;   /* lookaround, modifiers */
      }
      if (!fs_alternation(p, n, &j, depth + 1, fs)) return 0;
      if (j >= n || p[j] != ')') return 0;
      j++;
      break;
    case '[':
      if (!fs_class(p, n, &j, fs)) return 0;
      break;
    case '\\': {
      uint32_t single;
      if (!fs_escape(p, n, &j, fs, 0, &single)) return 0;
      break;
    }
    default: {
      uint32_t cp;
      if (!fs_decode_utf8(p, n, &j, &cp)) return 0;
      fs_add(fs, cp);
      break;
    }
  }
  /* the quantifier: the first term must match at least one unit */
  if (j < n){
    if (p[j] == '*' || p[j] == '?') return 0;
    if (p[j] == '+'){ j++; if (j < n && p[j] == '?') j++; }
    else if (p[j] == '{'){
      uint32_t k = j + 1u, min = 0; int digits = 0;
      while (k < n && p[k] >= '0' && p[k] <= '9'){ min = min * 10u + (uint32_t)(p[k] - '0'); k++; digits++; if (min > 1000000u) return 0; }
      if (!digits) return 0;
      if (k < n && p[k] == ','){ k++; while (k < n && p[k] >= '0' && p[k] <= '9') k++; }
      if (k >= n || p[k] != '}') return 0;
      if (min == 0) return 0;
      j = k + 1u;
      if (j < n && p[j] == '?') j++;
    }
  }
  *i = j;
  return 1;
}
static int fs_alternation(const char* p, uint32_t n, uint32_t* i, int depth, ts_regexp_firstset* fs){
  uint32_t j = *i;
  for (;;){
    if (!fs_term(p, n, &j, depth, fs)) return 0;
    int d = 0, in_class = 0;
    for (; j < n; j++){
      char c = p[j];
      if (c == '\\'){ j++; continue; }
      if (in_class){ if (c == ']') in_class = 0; continue; }
      if (c == '['){ in_class = 1; continue; }
      if (c == '(') d++;
      else if (c == ')'){ if (d == 0) break; d--; }
      else if (c == '|' && d == 0) break;
    }
    if (j >= n){ if (depth) return 0; *i = j; return 1; }
    if (p[j] == ')'){ if (!depth) return 0; *i = j; return 1; }
    j++;   /* '|' */
    if (j >= n) return 0;   /* a trailing empty alternative matches the empty string */
  }
}
static int fs_analyze(const char* p, uint32_t n, ts_regexp_firstset* fs){
  memset(fs, 0, sizeof *fs);
  uint32_t i = 0;
  if (n == 0 || !fs_alternation(p, n, &i, 0, fs)) return 0;
  if (i != n) return 0;
  for (uint32_t c = 'a'; c <= 'z'; c++) if (fs->table[c]) return 0;   /* not selective on identifiers and paths */
  return 1;
}
static int fs_enabled(void){
  if (g_regexp_prefilter < 0){
    const char* e = getenv("TSAOT_REGEXP_PREFILTER");
    g_regexp_prefilter = !(e && e[0] && strcmp(e, "0") == 0);
  }
  return g_regexp_prefilter;
}
/* the next input position at or after pos whose unit may start a match, or input_len */
static uint32_t fs_next(const ts_regexp_compiled* re, const uint8_t* input, uint32_t input_len, uint32_t pos, int cbuf_type){
  const uint8_t* t = re->first_table;
  if (cbuf_type == 0){
    for (; pos < input_len; pos++) if (t[input[pos]]) return pos;
  } else {
    const uint16_t* u = (const uint16_t*)input;
    for (; pos < input_len; pos++){ uint16_t cu = u[pos]; if (cu < 256u ? t[cu] : re->first_wide) return pos; }
  }
  return input_len;
}

#ifdef TSAOT_HAS_QUICKJS_REGEXP
static int ts_regexp_to_lre_flags(uint32_t flags){
  int out = 0;
  if (flags & TSAOT_REGEXP_FLAG_GLOBAL) out |= LRE_FLAG_GLOBAL;
  if (flags & TSAOT_REGEXP_FLAG_IGNORECASE) out |= LRE_FLAG_IGNORECASE;
  if (flags & TSAOT_REGEXP_FLAG_MULTILINE) out |= LRE_FLAG_MULTILINE;
  if (flags & TSAOT_REGEXP_FLAG_DOTALL) out |= LRE_FLAG_DOTALL;
  if (flags & TSAOT_REGEXP_FLAG_UNICODE) out |= LRE_FLAG_UNICODE;
  if (flags & TSAOT_REGEXP_FLAG_STICKY) out |= LRE_FLAG_STICKY;
  if (flags & TSAOT_REGEXP_FLAG_INDICES) out |= LRE_FLAG_INDICES;
  if (flags & TSAOT_REGEXP_FLAG_UNICODE_SETS) out |= LRE_FLAG_UNICODE_SETS;
  return out;
}
#endif

ts_regexp_compiled* ts_regexp_compile_utf8(const char* pattern,
                                           uint32_t pattern_len,
                                           uint32_t flags,
                                           char* error_msg,
                                           uint32_t error_msg_len){
#ifdef TSAOT_HAS_QUICKJS_REGEXP
  char err[128];
  int bc_len = 0;
  int lre_flags = ts_regexp_to_lre_flags(flags);
  int anchored = 0, prefilter = 0;
  ts_regexp_firstset fs;
  if (!(flags & (TSAOT_REGEXP_FLAG_MULTILINE | TSAOT_REGEXP_FLAG_STICKY)) &&
      ts_regexp_pattern_anchored(pattern, pattern_len)){
    anchored = 1;
    lre_flags |= LRE_FLAG_STICKY;   /* no search prefix: one attempt at the start index */
  } else if (!(flags & (TSAOT_REGEXP_FLAG_MULTILINE | TSAOT_REGEXP_FLAG_STICKY | TSAOT_REGEXP_FLAG_IGNORECASE |
                        TSAOT_REGEXP_FLAG_UNICODE | TSAOT_REGEXP_FLAG_UNICODE_SETS)) &&
             fs_enabled() && fs_analyze(pattern, pattern_len, &fs)){
    prefilter = 1;
    lre_flags |= LRE_FLAG_STICKY;   /* the adapter searches: one engine attempt per candidate position */
  }
  uint8_t* bc = lre_compile(&bc_len, err, sizeof(err), pattern, pattern_len,
                            lre_flags, NULL);
  if (!bc){
    ts_regexp_error(error_msg, error_msg_len, err);
    return NULL;
  }
  ts_regexp_compiled* re = malloc(sizeof(*re));
  if (!re){
    lre_realloc(NULL, bc, 0);
    ts_regexp_error(error_msg, error_msg_len, "out of memory");
    return NULL;
  }
  re->bytecode = bc;
  re->bytecode_len = bc_len;
  re->capture_count = (uint32_t)lre_get_capture_count(bc);
  re->flags = flags;
  re->anchored = (uint8_t)anchored;
  re->prefilter = (uint8_t)prefilter;
  re->first_wide = prefilter ? fs.wide : 0;
  re->first_pos0 = prefilter ? fs.pos0 : 0;
  if (prefilter) memcpy(re->first_table, fs.table, sizeof re->first_table);
  else memset(re->first_table, 0, sizeof re->first_table);
  if (getenv("TSAOT_REGEXP_PREFILTER_LOG")){   /* verification aid: one line per compiled pattern */
    int units = 0;
    for (int k = 0; k < 256; k++) units += re->first_table[k];
    fprintf(stderr, "[regexp] /%.*s/ flags=%u %s%s units=%d wide=%d pos0=%d\n", (int)pattern_len, pattern, flags,
            anchored ? "anchored" : prefilter ? "prefilter" : "engine-search", "", units, re->first_wide, re->first_pos0);
  }
  ts_regexp_error(error_msg, error_msg_len, "");
  return re;
#else
  (void)pattern;
  (void)pattern_len;
  (void)flags;
  ts_regexp_error(error_msg, error_msg_len, "QuickJS RegExp adapter unavailable");
  return NULL;
#endif
}

void ts_regexp_free(ts_regexp_compiled* re){
  if (!re) return;
#ifdef TSAOT_HAS_QUICKJS_REGEXP
  lre_realloc(NULL, re->bytecode, 0);
#endif
  free(re);
}

uint32_t ts_regexp_capture_count(const ts_regexp_compiled* re){
  return re ? re->capture_count : 0;
}

static const char* ts_regexp_group_names(const ts_regexp_compiled* re){
#ifdef TSAOT_HAS_QUICKJS_REGEXP
  if (!re || !re->bytecode) return NULL;
  return lre_get_groupnames(re->bytecode);
#else
  (void)re;
  return NULL;
#endif
}

static void ts_regexp_clear_spans(ts_regexp_span* captures, uint32_t capture_cap){
  for (uint32_t i = 0; i < capture_cap; i++){
    captures[i].start = 0;
    captures[i].end = 0;
    captures[i].matched = 0;
  }
}

#ifdef TSAOT_HAS_QUICKJS_REGEXP
static int ts_regexp_exec_impl(ts_regexp_compiled* re,
                               const uint8_t* input,
                               uint32_t input_len,
                               uint32_t start_index,
                               int cbuf_type,
                               ts_regexp_span* captures,
                               uint32_t capture_cap){
  if (!re || !re->bytecode || !input) return TSAOT_REGEXP_ERR_EXEC;
  if (start_index > input_len) return TSAOT_REGEXP_NOMATCH;
  if (captures) ts_regexp_clear_spans(captures, capture_cap);
  if (re->anchored && start_index > 0) return TSAOT_REGEXP_NOMATCH;
  uint32_t ncap = re->capture_count;
  uint8_t** raw = calloc((size_t)ncap * 2u, sizeof(uint8_t*));
  if (!raw) return TSAOT_REGEXP_ERR_NOMEM;
  int ret;
  if (re->prefilter){
    /* sticky bytecode: one engine attempt per candidate position */
    uint32_t pos = start_index;
    ret = 0;
    if (re->first_pos0 && pos == 0){
      ret = lre_exec(raw, re->bytecode, input, 0, (int)input_len, cbuf_type, NULL);
      pos = 1;
    }
    while (ret == 0){
      pos = fs_next(re, input, input_len, pos, cbuf_type);
      if (pos >= input_len) break;
      ret = lre_exec(raw, re->bytecode, input, (int)pos, (int)input_len, cbuf_type, NULL);
      pos++;
    }
  } else {
    ret = lre_exec(raw, re->bytecode, input, (int)start_index, (int)input_len,
                   cbuf_type, NULL);
  }
  if (ret != 1){
    free(raw);
    return ret == 0 ? TSAOT_REGEXP_NOMATCH : TSAOT_REGEXP_ERR_EXEC;
  }
  if (captures){
    uint32_t out_n = ncap < capture_cap ? ncap : capture_cap;
    uintptr_t base = (uintptr_t)input;
    uint32_t shift = (uint32_t)cbuf_type;
    for (uint32_t i = 0; i < out_n; i++){
      uint8_t* a = raw[i * 2u];
      uint8_t* b = raw[i * 2u + 1u];
      if (a && b){
        captures[i].start = (uint32_t)(((uintptr_t)a - base) >> shift);
        captures[i].end = (uint32_t)(((uintptr_t)b - base) >> shift);
        captures[i].matched = 1;
      }
    }
  }
  free(raw);
  return TSAOT_REGEXP_OK;
}
#endif

int ts_regexp_exec_latin1(ts_regexp_compiled* re,
                          const uint8_t* input,
                          uint32_t input_len,
                          uint32_t start_index,
                          ts_regexp_span* captures,
                          uint32_t capture_cap){
#ifdef TSAOT_HAS_QUICKJS_REGEXP
  return ts_regexp_exec_impl(re, input, input_len, start_index, 0, captures, capture_cap);
#else
  (void)re;
  (void)input;
  (void)input_len;
  (void)start_index;
  if (captures) ts_regexp_clear_spans(captures, capture_cap);
  return TSAOT_REGEXP_ERR_UNAVAILABLE;
#endif
}

int ts_regexp_exec_utf16(ts_regexp_compiled* re,
                         const uint16_t* input,
                         uint32_t input_len,
                         uint32_t start_index,
                         ts_regexp_span* captures,
                         uint32_t capture_cap){
#ifdef TSAOT_HAS_QUICKJS_REGEXP
  return ts_regexp_exec_impl(re, (const uint8_t*)input, input_len, start_index, 1, captures, capture_cap);
#else
  (void)re;
  (void)input;
  (void)input_len;
  (void)start_index;
  if (captures) ts_regexp_clear_spans(captures, capture_cap);
  return TSAOT_REGEXP_ERR_UNAVAILABLE;
#endif
}

static void ts_regexp_put_utf8(char* out, size_t* o, uint32_t cp){
  if (cp < 0x80u){
    out[(*o)++] = (char)cp;
  } else if (cp < 0x800u){
    out[(*o)++] = (char)(0xC0u | (cp >> 6));
    out[(*o)++] = (char)(0x80u | (cp & 0x3Fu));
  } else if (cp < 0x10000u){
    out[(*o)++] = (char)(0xE0u | (cp >> 12));
    out[(*o)++] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
    out[(*o)++] = (char)(0x80u | (cp & 0x3Fu));
  } else {
    out[(*o)++] = (char)(0xF0u | (cp >> 18));
    out[(*o)++] = (char)(0x80u | ((cp >> 12) & 0x3Fu));
    out[(*o)++] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
    out[(*o)++] = (char)(0x80u | (cp & 0x3Fu));
  }
}

static char* ts_regexp_view_slice_to_utf8(ts_strview x,
                                          uint32_t start,
                                          uint32_t end,
                                          uint32_t* out_len){
  if (start > x.len) start = x.len;
  if (end > x.len) end = x.len;
  if (end < start) end = start;
  size_t cap = (size_t)(end - start) * 4u + 1u;
  char* out = malloc(cap ? cap : 1u);
  if (!out) return NULL;
  size_t o = 0;
  for (uint32_t i = start; i < end; i++){
    uint32_t cp = ts_str_cu_at_view(x, i);
    if (cp >= 0xD800u && cp <= 0xDBFFu && i + 1u < end){
      uint16_t lo = ts_str_cu_at_view(x, i + 1u);
      if (lo >= 0xDC00u && lo <= 0xDFFFu){
        cp = 0x10000u + (((cp - 0xD800u) << 10) | (lo - 0xDC00u));
        i++;
      }
    }
    ts_regexp_put_utf8(out, &o, cp);
  }
  out[o] = 0;
  if (out_len) *out_len = (uint32_t)o;
  return out;
}

static char* ts_regexp_view_to_quickjs_pattern(ts_strview x, uint32_t flags,
                                               uint32_t* out_len){
  /* Match QuickJS's compile boundary: legacy mode passes CESU-8 so lone UTF-16
     code units remain distinct, while Unicode (`u`/`v`) mode passes scalar UTF-8
     after joining valid surrogate pairs. This is an adapter encoding detail; ES
     observable indices remain UTF-16 code-unit offsets. */
  int unicode_mode =
    (flags & (TSAOT_REGEXP_FLAG_UNICODE | TSAOT_REGEXP_FLAG_UNICODE_SETS)) != 0;
  int cesu8 = !unicode_mode;
  size_t cap = (size_t)x.len * 4u + 1u;
  char* out = malloc(cap ? cap : 1u);
  if (!out) return NULL;
  size_t o = 0;
  for (uint32_t i = 0; i < x.len; i++){
    uint32_t cp = ts_str_cu_at_view(x, i);
    if (!cesu8 && cp >= 0xD800u && cp <= 0xDBFFu && i + 1u < x.len){
      uint16_t lo = ts_str_cu_at_view(x, i + 1u);
      if (lo >= 0xDC00u && lo <= 0xDFFFu){
        cp = 0x10000u + (((cp - 0xD800u) << 10) | (lo - 0xDC00u));
        i++;
      }
    }
    ts_regexp_put_utf8(out, &o, cp);
  }
  out[o] = 0;
  if (out_len) *out_len = (uint32_t)o;
  return out;
}

static uint16_t* ts_regexp_view_to_utf16(ts_strview x){
  uint16_t* out = malloc(sizeof(uint16_t) * (size_t)(x.len ? x.len : 1u));
  if (!out) return NULL;
  for (uint32_t i = 0; i < x.len; i++) out[i] = ts_str_cu_at_view(x, i);
  return out;
}

static ts_regexp_compiled* ts_regexp_compile_pattern_tsv_cached_inner(tsv pattern,
                                                                       uint32_t flags,
                                                                       char* error_msg,
                                                                       uint32_t error_msg_len,
                                                                       int report_error){
  if (!ts_regexp_adapter_available()){
    ts_regexp_error(error_msg, error_msg_len, "RegExp QuickJS adapter unavailable");
    if (report_error) ts_regexp_adapter_unsupported("RegExp QuickJS adapter unavailable");
    return NULL;
  }
  ts_gc_root(&pattern);
  tsv ps = ts_is_str(pattern) ? pattern : ts_to_string_v(pattern);
  ts_gc_root(&ps);
  if (!ts_is_str(ps)){
    ts_regexp_error(error_msg, error_msg_len, "RegExp pattern is not a string");
    ts_gc_unroot(2);
    return NULL;
  }
  ts_strview pv = ts_str_view_typed(ps);
  uint32_t pat_len = 0;
  char* pat = ts_regexp_view_to_quickjs_pattern(pv, flags, &pat_len);
  if (!pat){
    ts_regexp_error(error_msg, error_msg_len, "out of memory");
    ts_gc_unroot(2);
    return NULL;
  }
  for (ts_regexp_cache_entry* e = g_regexp_cache; e; e = e->next){
    if (e->flags == flags &&
        e->pattern_len == pat_len &&
        memcmp(e->pattern, pat, pat_len) == 0){
      free(pat);
      ts_regexp_error(error_msg, error_msg_len, "");
      ts_gc_unroot(2);
      return e->compiled;
    }
  }
  char err[128];
  ts_regexp_compiled* re = ts_regexp_compile_utf8(pat, pat_len, flags, err, sizeof(err));
  if (!re){
    ts_regexp_error(error_msg, error_msg_len, err[0] ? err : "invalid regular expression");
    if (report_error && err[0]) ts_regexp_adapter_unsupported(err);
    free(pat);
    ts_gc_unroot(2);
    return NULL;
  }
  ts_regexp_cache_entry* entry = malloc(sizeof(*entry));
  if (!entry){
    ts_regexp_free(re);
    free(pat);
    ts_regexp_error(error_msg, error_msg_len, "RegExp cache out of memory");
    ts_gc_unroot(2);
    if (report_error) ts_regexp_adapter_unsupported("RegExp cache out of memory");
    return NULL;
  }
  entry->pattern = pat;
  entry->pattern_len = pat_len;
  entry->flags = flags;
  entry->compiled = re;
  entry->next = g_regexp_cache;
  g_regexp_cache = entry;
  ts_regexp_error(error_msg, error_msg_len, "");
  ts_gc_unroot(2);
  return re;
}

/* A regular expression literal's pattern is a static string, never freed: its
   value identity keys a direct-mapped cache in front of the pattern cache,
   which converts the pattern to the engine's form (an allocation and a copy)
   and scans every entry on each exec / test / replace. Dynamic patterns (a
   heap string whose handle can be recycled) keep the content-keyed path. */
#define TS_REGEXP_ID_CACHE 64u
static struct { tsv pattern; uint32_t flags; ts_regexp_compiled* re; } g_regexp_id_cache[TS_REGEXP_ID_CACHE];
static ts_regexp_compiled* ts_regexp_compile_pattern_tsv_cached(tsv pattern, uint32_t flags){
  if (ts_is_heap_str(pattern) && (ts_str_flags_typed(pattern) & TS_STR_FLAG_STATIC)){
    uint64_t x = (uint64_t)pattern ^ ((uint64_t)pattern >> 17) ^ ((uint64_t)flags * 0x9E3779B1u);
    uint32_t slot = (uint32_t)(x >> 3) & (TS_REGEXP_ID_CACHE - 1u);
    if (g_regexp_id_cache[slot].re && g_regexp_id_cache[slot].pattern == pattern && g_regexp_id_cache[slot].flags == flags)
      return g_regexp_id_cache[slot].re;
    ts_regexp_compiled* re = ts_regexp_compile_pattern_tsv_cached_inner(pattern, flags, NULL, 0, 1);
    if (re){
      g_regexp_id_cache[slot].pattern = pattern;
      g_regexp_id_cache[slot].flags = flags;
      g_regexp_id_cache[slot].re = re;
    }
    return re;
  }
  return ts_regexp_compile_pattern_tsv_cached_inner(pattern, flags, NULL, 0, 1);
}

static int ts_regexp_exec_string_tsv(ts_regexp_compiled* re, tsv input,
                                     uint32_t start_index,
                                     ts_regexp_span* captures,
                                     uint32_t capture_cap){
  ts_gc_root(&input);
  tsv s = ts_is_str(input) ? input : ts_to_string_v(input);
  ts_gc_root(&s);
  if (!ts_is_str(s)){
    ts_gc_unroot(2);
    return TSAOT_REGEXP_ERR_EXEC;
  }
  ts_strview sv = ts_str_view_typed(s);
  char short_input[TS_SHORTSTR_MAX];
  int rc;
  if (sv.flags & TS_STR_FLAG_UTF16){
    uint16_t* tmp = ts_regexp_view_to_utf16(sv);
    if (!tmp){
      ts_gc_unroot(2);
      return TSAOT_REGEXP_ERR_NOMEM;
    }
    rc = ts_regexp_exec_utf16(re, tmp, sv.len, start_index, captures, capture_cap);
    free(tmp);
  } else {
    rc = ts_regexp_exec_latin1(
      re, (const uint8_t*)ts_str_view_data(&sv, short_input), sv.len,
      start_index, captures, capture_cap);
  }
  ts_gc_unroot(2);
  return rc;
}

static uint32_t ts_rx_k_source = 0xFFFFFFFFu;
static uint32_t ts_rx_k_prefix = 0xFFFFFFFFu;
static uint32_t ts_rx_k_last_index = 0xFFFFFFFFu;
static uint32_t ts_rx_k_flags_mask = 0xFFFFFFFFu;
static uint32_t ts_rx_k_iter_input = 0xFFFFFFFFu;
static uint32_t ts_rx_k_iter_source = 0xFFFFFFFFu;
static uint32_t ts_rx_k_iter_flags = 0xFFFFFFFFu;
static uint32_t ts_rx_k_iter_index = 0xFFFFFFFFu;
static uint32_t ts_rx_k_iter_done = 0xFFFFFFFFu;

static void ts_regexp_adapter_ensure_object_keys(void){
  if (ts_rx_k_source != 0xFFFFFFFFu) return;
  ts_rx_k_source = ts_intern_field("source", 6);
  ts_rx_k_prefix = ts_intern_field("__tsaot_rx_prefix", 17);
  ts_rx_k_last_index = ts_intern_field("lastIndex", 9);
  ts_rx_k_flags_mask = ts_intern_field("__tsaot_rx_flags_mask", 21);
  ts_rx_k_iter_input = ts_intern_field("__tsaot_rx_iter_input", 21);
  ts_rx_k_iter_source = ts_intern_field("__tsaot_rx_iter_source", 22);
  ts_rx_k_iter_flags = ts_intern_field("__tsaot_rx_iter_flags", 21);
  ts_rx_k_iter_index = ts_intern_field("__tsaot_rx_iter_index", 21);
  ts_rx_k_iter_done = ts_intern_field("__tsaot_rx_iter_done", 20);
}

static int ts_regexp_adapter_object_has_prefix(tsv re){
  ts_regexp_adapter_ensure_object_keys();
  static ts_rt_ic ic_prefix;
  return ts_is_str(ts_get_ic(re, ts_rx_k_prefix, &ic_prefix));
}

static int ts_regexp_adapter_object_pattern(tsv re, tsv* out_source, uint32_t* out_flags){
  ts_regexp_adapter_ensure_object_keys();
  static ts_rt_ic ic_source, ic_mask;
  tsv source = ts_get_ic(re, ts_rx_k_source, &ic_source);
  tsv flags = ts_get_ic(re, ts_rx_k_flags_mask, &ic_mask);
  if (!ts_is_str(source) || !ts_is_num(flags)) return 0;
  double d = ts_to_num(flags);
  if (!(d >= 0.0) || d > 4294967295.0) return 0;
  *out_source = source;
  *out_flags = (uint32_t)d;
  return 1;
}

/* EscapeRegExpPattern: preserve existing escapes and character classes while
   escaping delimiters and line terminators for the observable source string. */
static tsv ts_regexp_constructor_source(tsv pattern){
  ts_strview view = ts_str_view_typed(pattern);
  if (view.len == 0) return ts_new_string("(?:)", 4);
  uint32_t* buffer = malloc(sizeof(uint32_t) * ((size_t)view.len * 6u + 1u));
  if (!buffer) abort();
  uint32_t length = 0;
  int in_class = 0;
  for (uint32_t i = 0; i < view.len; i++){
    uint32_t cp = ts_str_cu_at_view(view, i);
    if (cp == '\\' && i + 1 < view.len){
      uint32_t next = ts_str_cu_at_view(view, i + 1);
      if (next != '\n' && next != '\r' && next != 0x2028u && next != 0x2029u){
        buffer[length++] = '\\';
        buffer[length++] = next;
        i++;
        continue;
      }
      cp = next;
      i++;
    }
    if (cp == '\n' || cp == '\r'){
      buffer[length++] = '\\';
      buffer[length++] = cp == '\n' ? 'n' : 'r';
    } else if (cp == 0x2028u || cp == 0x2029u){
      const char* escape = cp == 0x2028u ? "\\u2028" : "\\u2029";
      for (uint32_t j = 0; j < 6; j++) buffer[length++] = (uint32_t)escape[j];
    } else {
      if (cp == '/' && !in_class) buffer[length++] = '\\';
      if (cp == '[') in_class = 1;
      else if (cp == ']') in_class = 0;
      buffer[length++] = cp;
    }
  }
  tsv result = ts_string_from_codepoints(buffer, length);
  free(buffer);
  return result;
}

static tsv ts_regexp_constructor_string(tsv value){
  ts_gc_root(&value);
  value = ts_to_primitive(value, 1);
  if (ts_is_symbol(value)) ts_throw_type_error_msg("Cannot convert a Symbol value to a string");
  tsv result = ts_is_str(value) ? value : ts_to_string_v(value);
  ts_gc_unroot(1);
  return result;
}

tsv ts_regexp_adapter_construct_tsv(tsv pattern, tsv flags, int as_constructor){
  ts_gc_root(&pattern); ts_gc_root(&flags);
  tsv original_source = TS_UNDEFINED;
  uint32_t original_flags = 0;
  int is_regexp = ts_regexp_adapter_object_pattern(pattern, &original_source, &original_flags);
  if (is_regexp && flags == TS_UNDEFINED && !as_constructor){
    ts_gc_unroot(2);
    return pattern;
  }
  pattern = is_regexp ? original_source : pattern == TS_UNDEFINED
    ? ts_new_string("", 0) : ts_regexp_constructor_string(pattern);
  uint32_t mask = is_regexp && flags == TS_UNDEFINED ? original_flags : 0;
  static const char order[] = "dgimsuvy";
  static const uint32_t bits[] = {
    TSAOT_REGEXP_FLAG_INDICES, TSAOT_REGEXP_FLAG_GLOBAL, TSAOT_REGEXP_FLAG_IGNORECASE,
    TSAOT_REGEXP_FLAG_MULTILINE, TSAOT_REGEXP_FLAG_DOTALL, TSAOT_REGEXP_FLAG_UNICODE,
    TSAOT_REGEXP_FLAG_UNICODE_SETS, TSAOT_REGEXP_FLAG_STICKY
  };
  if (flags != TS_UNDEFINED){
    flags = ts_regexp_constructor_string(flags);
    ts_strview view = ts_str_view_typed(flags);
    for (uint32_t i = 0; i < view.len; i++){
      uint32_t unit = ts_str_cu_at_view(view, i);
      uint32_t bit = 0;
      for (uint32_t j = 0; j < 8; j++) if (unit == (uint32_t)order[j]) bit = bits[j];
      if (!bit || (mask & bit)) ts_throw_syntax_error_msg("Invalid flags supplied to RegExp constructor");
      mask |= bit;
    }
    if ((mask & TSAOT_REGEXP_FLAG_UNICODE) && (mask & TSAOT_REGEXP_FLAG_UNICODE_SETS))
      ts_throw_syntax_error_msg("Invalid flags supplied to RegExp constructor");
  }
  char canonical[8]; uint32_t count = 0;
  for (uint32_t i = 0; i < 8; i++) if (mask & bits[i]) canonical[count++] = order[i];
  flags = ts_new_string(canonical, count);
  pattern = ts_regexp_constructor_source(pattern);
  tsv re = ts_new_object(); ts_gc_root(&re);
  ts_regexp_object_init(re);
  ts_regexp_adapter_ensure_object_keys();
  ts_define_data(re, ts_rx_k_source, pattern, 0, 0, 1);
  ts_define_data(re, ts_intern_field("flags", 5), flags, 0, 0, 1);
  ts_define_data(re, ts_rx_k_last_index, ts_num(0), 0, 1, 0);
  ts_define_data(re, ts_rx_k_flags_mask, ts_num(mask), 0, 1, 0);
  ts_regexp_adapter_validate_object_tsv(re);
  ts_gc_unroot(3);
  return re;
}

tsv ts_regexp_adapter_validate_object_tsv(tsv re){
  ts_gc_root(&re);
  tsv source = TS_UNDEFINED;
  uint32_t flags = 0;
  if (!ts_regexp_adapter_object_pattern(re, &source, &flags)){
    ts_gc_unroot(1);
    ts_throw_type_error_msg("RegExp constructor produced an invalid receiver");
    return TS_UNDEFINED;
  }
  ts_gc_root(&source);
  char err[128];
  ts_regexp_compiled* compiled =
    ts_regexp_compile_pattern_tsv_cached_inner(source, flags, err, sizeof(err), 0);
  if (!compiled &&
      (flags & TSAOT_REGEXP_FLAG_UNICODE_SETS) &&
      ts_regexp_adapter_object_has_prefix(re)){
    uint32_t unicode_flags =
      (flags & ~TSAOT_REGEXP_FLAG_UNICODE_SETS) | TSAOT_REGEXP_FLAG_UNICODE;
    compiled = ts_regexp_compile_pattern_tsv_cached_inner(source, unicode_flags,
                                                          err, sizeof(err), 0);
  }
  (void)compiled;
  ts_gc_unroot(2);
  if (!compiled){
    if (!ts_regexp_adapter_available()){
      return ts_regexp_adapter_unsupported("RegExp QuickJS adapter unavailable");
    }
    ts_throw_syntax_error_msg(err[0] ? err : "Invalid regular expression");
    return TS_UNDEFINED;
  }
  return re;
}

static long long ts_regexp_adapter_last_index_value(tsv re){
  ts_regexp_adapter_ensure_object_keys();
  static ts_rt_ic ic_last;
  double d = ts_number_coerce(ts_get_ic(re, ts_rx_k_last_index, &ic_last));
  if (!(d > 0.0) || !isfinite(d)) return 0;
  if (d > 2147483647.0) return 2147483647LL;
  return (long long)floor(d);
}

static void ts_regexp_adapter_set_last_index(tsv re, double value){
  ts_regexp_adapter_ensure_object_keys();
  static ts_rt_ic ic_last_set;
  ts_set_ic(re, ts_rx_k_last_index, ts_num(value), &ic_last_set);
}

static tsv ts_regexp_adapter_slice(tsv s, uint32_t start, uint32_t end);
static tsv ts_regexp_build_span_pair(uint32_t start, uint32_t end);
static tsv ts_regexp_build_groups_result(tsv input,
                                         const ts_regexp_span* captures,
                                         uint32_t capture_count,
                                         const char* group_names);
static tsv ts_regexp_build_indices_groups_result(const ts_regexp_span* captures,
                                                 uint32_t capture_count,
                                                 const char* group_names);

static tsv ts_regexp_build_indices_result(const ts_regexp_span* captures,
                                          uint32_t capture_count,
                                          const char* group_names){
  tsv arr = ts_new_array(0);
  ts_gc_root(&arr);
  for (uint32_t i = 0; i < capture_count; i++){
    tsv item = TS_UNDEFINED;
    if (captures[i].matched){
      item = ts_regexp_build_span_pair(captures[i].start, captures[i].end);
      ts_gc_root(&item);
      ts_array_push(arr, item);
      ts_gc_unroot(1);
    } else {
      ts_array_push(arr, TS_UNDEFINED);
    }
  }
  tsv groups = ts_regexp_build_indices_groups_result(captures, capture_count, group_names);
  ts_gc_root(&groups);
  ts_set(arr, ts_intern_field("groups", 6), groups);
  ts_gc_unroot(1);
  ts_gc_unroot(1);
  return arr;
}

static tsv ts_regexp_build_exec_result(tsv input,
                                       const ts_regexp_span* captures,
                                       uint32_t capture_count,
                                       uint32_t flags,
                                       const char* group_names){
  if (!captures || capture_count == 0 || !captures[0].matched) return TS_NULL;
  ts_gc_root(&input);
  tsv arr = ts_new_array(0);
  ts_gc_root(&arr);
  for (uint32_t i = 0; i < capture_count; i++){
    tsv part = TS_UNDEFINED;
    if (captures[i].matched){
      part = ts_str_slice(input, (double)captures[i].start, (double)captures[i].end, 1);
    }
    ts_gc_root(&part);
    ts_array_push(arr, part);
    ts_gc_unroot(1);
  }
  ts_set(arr, ts_intern_field("index", 5), ts_num((double)captures[0].start));
  ts_set(arr, ts_intern_field("input", 5), input);
  tsv groups = ts_regexp_build_groups_result(input, captures, capture_count, group_names);
  ts_gc_root(&groups);
  ts_set(arr, ts_intern_field("groups", 6), groups);
  ts_gc_unroot(1);
  if (flags & TSAOT_REGEXP_FLAG_INDICES){
    tsv indices = ts_regexp_build_indices_result(captures, capture_count, group_names);
    ts_gc_root(&indices);
    ts_set(arr, ts_intern_field("indices", 7), indices);
    ts_gc_unroot(1);
  }
  ts_gc_unroot(2);
  return arr;
}

static uint32_t ts_regexp_adapter_advance_string_index(tsv input, uint32_t index, int full_unicode){
  ts_strview xs = ts_str_view_typed(input);
  if (!full_unicode || index + 1u >= xs.len) return index + 1u;
  uint16_t hi = ts_str_cu_at_view(xs, index);
  if (hi >= 0xD800u && hi <= 0xDBFFu){
    uint16_t lo = ts_str_cu_at_view(xs, index + 1u);
    if (lo >= 0xDC00u && lo <= 0xDFFFu) return index + 2u;
  }
  return index + 1u;
}

static tsv ts_regexp_adapter_match_global_compiled(ts_regexp_compiled* compiled,
                                                   tsv input,
                                                   uint32_t flags){
  if (!compiled || !ts_is_str(input)) return TS_NULL;
  ts_gc_root(&input);
  tsv arr = ts_new_array(0);
  ts_gc_root(&arr);
  ts_strview sv = ts_str_view_typed(input);
  uint32_t last_index = 0;
  uint32_t count = 0;
  int full_unicode = (flags & (TSAOT_REGEXP_FLAG_UNICODE | TSAOT_REGEXP_FLAG_UNICODE_SETS)) != 0;
  for (;;){
    if (last_index > sv.len) break;
    ts_regexp_span cap = {0, 0, 0};
    int rc = ts_regexp_exec_string_tsv(compiled, input, last_index, &cap, 1);
    if (rc != TSAOT_REGEXP_OK || !cap.matched) break;
    tsv part = ts_str_slice(input, (double)cap.start, (double)cap.end, 1);
    ts_gc_root(&part);
    ts_array_push(arr, part);
    ts_gc_unroot(1);
    count++;
    last_index = cap.end;
    if (cap.end == cap.start){
      last_index = ts_regexp_adapter_advance_string_index(input, last_index, full_unicode);
    }
  }
  tsv result = count ? arr : TS_NULL;
  ts_gc_unroot(2);
  return result;
}

static tsv ts_regexp_adapter_slice(tsv s, uint32_t start, uint32_t end){
  return ts_str_slice(s, (double)start, (double)end, 1);
}

static int ts_regexp_group_name_seen_before(const char* group_names,
                                            uint32_t capture_index,
                                            const char* name,
                                            size_t name_len){
  const char* p = group_names;
  for (uint32_t i = 1; p && i < capture_index; i++){
    size_t len = strlen(p);
    if (len == name_len && memcmp(p, name, name_len) == 0) return 1;
    p += len + 1u;
  }
  return 0;
}

static uint32_t ts_regexp_find_group_capture(const char* group_names,
                                             const ts_regexp_span* captures,
                                             uint32_t capture_count,
                                             const char* name,
                                             uint32_t name_len){
  if (!group_names || !name) return 0;
  const char* p = group_names;
  uint32_t first = 0;
  for (uint32_t i = 1; i < capture_count; i++){
    size_t len = strlen(p);
    if (len == (size_t)name_len && memcmp(p, name, name_len) == 0){
      if (captures && captures[i].matched) return i;
      if (first == 0) first = i;
    }
    p += len + 1u;
  }
  return first;
}

static tsv ts_regexp_build_span_pair(uint32_t start, uint32_t end){
  tsv item = ts_new_array(0);
  ts_gc_root(&item);
  ts_array_push(item, ts_num((double)start));
  ts_array_push(item, ts_num((double)end));
  ts_gc_unroot(1);
  return item;
}

static tsv ts_regexp_build_groups_result(tsv input,
                                         const ts_regexp_span* captures,
                                         uint32_t capture_count,
                                         const char* group_names){
  if (!group_names) return TS_UNDEFINED;
  ts_gc_root(&input);
  tsv groups = ts_new_object();
  ts_gc_root(&groups);
  const char* name = group_names;
  for (uint32_t i = 1; i < capture_count; i++){
    size_t len = strlen(name);
    if (len > 0 && !ts_regexp_group_name_seen_before(group_names, i, name, len)){
      uint32_t chosen = ts_regexp_find_group_capture(group_names, captures, capture_count,
                                                     name, (uint32_t)len);
      tsv value = TS_UNDEFINED;
      if (chosen > 0 && captures[chosen].matched){
        value = ts_regexp_adapter_slice(input, captures[chosen].start, captures[chosen].end);
      }
      ts_gc_root(&value);
      ts_set(groups, ts_intern_field(name, (uint32_t)len), value);
      ts_gc_unroot(1);
    }
    name += len + 1u;
  }
  ts_gc_unroot(2);
  return groups;
}

static tsv ts_regexp_build_indices_groups_result(const ts_regexp_span* captures,
                                                 uint32_t capture_count,
                                                 const char* group_names){
  if (!group_names) return TS_UNDEFINED;
  tsv groups = ts_new_object();
  ts_gc_root(&groups);
  const char* name = group_names;
  for (uint32_t i = 1; i < capture_count; i++){
    size_t len = strlen(name);
    if (len > 0 && !ts_regexp_group_name_seen_before(group_names, i, name, len)){
      uint32_t chosen = ts_regexp_find_group_capture(group_names, captures, capture_count,
                                                     name, (uint32_t)len);
      tsv value = TS_UNDEFINED;
      if (chosen > 0 && captures[chosen].matched){
        value = ts_regexp_build_span_pair(captures[chosen].start, captures[chosen].end);
      }
      ts_gc_root(&value);
      ts_set(groups, ts_intern_field(name, (uint32_t)len), value);
      ts_gc_unroot(1);
    }
    name += len + 1u;
  }
  ts_gc_unroot(1);
  return groups;
}

/* `out` is a string builder (ts_sb_*, docs/string_accumulators_design.md):
   the replace results are built in one buffer, no slice or intermediate
   string per piece. */
static tsv ts_regexp_adapter_append_slice(tsv out, tsv s, uint32_t start, uint32_t end){
  return ts_sb_append_range(out, s, start, end);
}

static tsv ts_regexp_adapter_expand_replacement(tsv input,
                                                tsv replacement,
                                                const ts_regexp_span* captures,
                                                uint32_t capture_count,
                                                const char* group_names){
  if (!captures || capture_count == 0 || !captures[0].matched) return replacement;
  ts_gc_root(&input);
  ts_gc_root(&replacement);
  tsv rep = ts_is_str(replacement) ? replacement : ts_to_string_v(replacement);
  ts_gc_root(&rep);
  tsv out = ts_sb_new(ts_new_string("", 0));
  ts_gc_root(&out);
  ts_strview rv = ts_str_view_typed(rep);
  uint32_t input_len = ts_str_len_typed(input);
  uint32_t group_count = capture_count > 0 ? capture_count - 1u : 0u;
  for (uint32_t k = 0; k < rv.len; k++){
    rv = ts_str_view_typed(rep);   /* an append may have collected: re-read the view */
    uint16_t cu = ts_str_cu_at_view(rv, k);
    if (cu == '$' && k + 1u < rv.len){
      uint16_t nx = ts_str_cu_at_view(rv, k + 1u);
      if (nx == '$'){
        out = ts_sb_append_range(out, rep, k, k + 1u);   /* `$$` -> `$` */
        k++;
        continue;
      }
      if (nx == '&'){
        out = ts_regexp_adapter_append_slice(out, input, captures[0].start, captures[0].end);
        k++;
        continue;
      }
      if (nx == '`'){
        out = ts_regexp_adapter_append_slice(out, input, 0, captures[0].start);
        k++;
        continue;
      }
      if (nx == '\''){
        out = ts_regexp_adapter_append_slice(out, input, captures[0].end, input_len);
        k++;
        continue;
      }
      if (nx == '<' && group_names){
        uint32_t close = k + 2u;
        while (close < rv.len && ts_str_cu_at_view(rv, close) != '>') close++;
        if (close < rv.len){
          uint32_t name_len = 0;
          char* name = ts_regexp_view_slice_to_utf8(rv, k + 2u, close, &name_len);
          if (!name){
            ts_gc_unroot(4);
            return ts_regexp_adapter_unsupported("RegExp replacement out of memory");
          }
          uint32_t chosen = ts_regexp_find_group_capture(group_names, captures,
                                                         capture_count, name, name_len);
          free(name);
          if (chosen > 0 && captures[chosen].matched){
            out = ts_regexp_adapter_append_slice(out, input, captures[chosen].start, captures[chosen].end);
          }
          k = close;
          continue;
        }
      }
      if (nx >= '0' && nx <= '9'){
        uint32_t n1 = (uint32_t)(nx - '0');
        uint32_t chosen = 0;
        uint32_t consume = 0;
        if (n1 > 0){
          if (k + 2u < rv.len){
            uint16_t nx2 = ts_str_cu_at_view(rv, k + 2u);
            if (nx2 >= '0' && nx2 <= '9'){
              uint32_t n2 = n1 * 10u + (uint32_t)(nx2 - '0');
              if (n2 > 0 && n2 <= group_count){
                chosen = n2;
                consume = 2;
              }
            }
          }
          if (chosen == 0 && n1 <= group_count){
            chosen = n1;
            consume = 1;
          }
        }
        if (chosen > 0){
          if (captures[chosen].matched){
            out = ts_regexp_adapter_append_slice(out, input, captures[chosen].start, captures[chosen].end);
          }
          k += consume;
          continue;
        }
      }
    }
    out = ts_regexp_adapter_append_slice(out, rep, k, k + 1u);
  }
  out = ts_sb_finish(out);
  ts_gc_unroot(4);
  return out;
}

static tsv ts_regexp_adapter_call_replacer(tsv input,
                                           tsv replacement,
                                           const ts_regexp_span* captures,
                                           uint32_t capture_count,
                                           const char* group_names){
  if (!captures || capture_count == 0 || !captures[0].matched) return ts_new_string("", 0);
  ts_gc_root(&input);
  ts_gc_root(&replacement);
  int has_groups = group_names != NULL;
  int nargs = (int)capture_count + 2 + has_groups;
  tsv* args = malloc(sizeof(tsv) * (size_t)nargs);
  if (!args){
    ts_gc_unroot(2);
    return ts_regexp_adapter_unsupported("RegExp function replacer out of memory");
  }
  for (uint32_t i = 0; i < capture_count; i++){
    args[i] = TS_UNDEFINED;
    if (captures[i].matched){
      args[i] = ts_regexp_adapter_slice(input, captures[i].start, captures[i].end);
    }
    ts_gc_root(&args[i]);
  }
  args[capture_count] = ts_num((double)captures[0].start);
  args[capture_count + 1u] = input;
  if (has_groups){
    args[capture_count + 2u] = ts_regexp_build_groups_result(input, captures, capture_count, group_names);
    ts_gc_root(&args[capture_count + 2u]);
  }
  tsv rv = ts_call_value(replacement, args, nargs);
  ts_gc_root(&rv);
  tsv out = ts_to_string_v(rv);
  ts_gc_root(&out);
  ts_gc_unroot((int)capture_count + has_groups + 4);
  free(args);
  return out;
}

static tsv ts_regexp_adapter_replace_compiled(ts_regexp_compiled* compiled,
                                              tsv input,
                                              uint32_t flags,
                                              tsv replacement,
                                              int replace_all_method,
                                              uint32_t start_index,
                                              tsv object_re){
  if (!compiled) return TS_NULL;
  int replacement_is_fn = ts_is_callable(replacement);
  int global = (flags & TSAOT_REGEXP_FLAG_GLOBAL) != 0;
  if (replace_all_method && !global){
    return ts_regexp_adapter_unsupported("String.prototype.replaceAll(RegExp non-global)");
  }
  int all_matches = global;
  ts_gc_root(&input);
  ts_gc_root(&replacement);
  if (object_re != TS_UNDEFINED) ts_gc_root(&object_re);
  tsv s = ts_is_str(input) ? input : ts_to_string_v(input);
  ts_gc_root(&s);
  tsv rep = replacement_is_fn ? replacement : (ts_is_str(replacement) ? replacement : ts_to_string_v(replacement));
  ts_gc_root(&rep);
  if (!ts_is_str(s) || (!replacement_is_fn && !ts_is_str(rep))){
    ts_gc_unroot(object_re != TS_UNDEFINED ? 5 : 4);
    return TS_NULL;
  }
  uint32_t ncap = ts_regexp_capture_count(compiled);
  if (ncap == 0) ncap = 1;
  ts_regexp_span* captures = malloc(sizeof(ts_regexp_span) * (size_t)ncap);
  if (!captures){
    ts_gc_unroot(object_re != TS_UNDEFINED ? 5 : 4);
    return ts_regexp_adapter_unsupported("RegExp replace out of memory");
  }
  tsv out = ts_sb_new(ts_new_string("", 0));
  ts_gc_root(&out);
  uint32_t next_source = 0;
  uint32_t search_index = start_index;
  uint32_t input_len = ts_str_len_typed(s);
  int full_unicode = (flags & (TSAOT_REGEXP_FLAG_UNICODE | TSAOT_REGEXP_FLAG_UNICODE_SETS)) != 0;
  const char* group_names = ts_regexp_group_names(compiled);
  int matched_any = 0;
  for (;;){
    if (search_index > input_len) break;
    int rc = ts_regexp_exec_string_tsv(compiled, s, search_index, captures, ncap);
    if (rc != TSAOT_REGEXP_OK || !captures[0].matched) break;
    if (captures[0].start < next_source) break;
    matched_any = 1;
    out = ts_regexp_adapter_append_slice(out, s, next_source, captures[0].start);
    tsv repl = replacement_is_fn
      ? ts_regexp_adapter_call_replacer(s, rep, captures, ncap, group_names)
      : ts_regexp_adapter_expand_replacement(s, rep, captures, ncap, group_names);
    ts_gc_root(&repl);
    out = ts_sb_append(out, repl);
    ts_gc_unroot(1);
    next_source = captures[0].end;
    if (object_re != TS_UNDEFINED && (flags & (TSAOT_REGEXP_FLAG_GLOBAL | TSAOT_REGEXP_FLAG_STICKY))){
      ts_regexp_adapter_set_last_index(object_re, (double)captures[0].end);
    }
    if (!all_matches) break;
    search_index = captures[0].end;
    if (captures[0].end == captures[0].start){
      search_index = ts_regexp_adapter_advance_string_index(s, search_index, full_unicode);
      if (object_re != TS_UNDEFINED) ts_regexp_adapter_set_last_index(object_re, (double)search_index);
    }
  }
  if (!matched_any){
    if (object_re != TS_UNDEFINED && (flags & (TSAOT_REGEXP_FLAG_GLOBAL | TSAOT_REGEXP_FLAG_STICKY))){
      ts_regexp_adapter_set_last_index(object_re, 0.0);
    }
    free(captures);
    ts_gc_unroot(object_re != TS_UNDEFINED ? 6 : 5);
    return s;
  }
  out = ts_regexp_adapter_append_slice(out, s, next_source, input_len);
  if (object_re != TS_UNDEFINED && global){
    ts_regexp_adapter_set_last_index(object_re, 0.0);
  }
  free(captures);
  tsv result = ts_sb_finish(out);
  ts_gc_unroot(object_re != TS_UNDEFINED ? 6 : 5);
  return result;
}

static uint32_t ts_regexp_adapter_split_limit(tsv limit){
  if (limit == TS_UNDEFINED) return UINT32_MAX;
  return (uint32_t)(int64_t)ts_to_num(limit);
}

static int ts_regexp_adapter_split_push(tsv arr, uint32_t limit, tsv value){
  if (ts_array_len(arr) >= limit) return 0;
  ts_array_push(arr, value);
  return ts_array_len(arr) < limit;
}

static int ts_regexp_adapter_split_push_slice(tsv arr, uint32_t limit, tsv input, uint32_t start, uint32_t end){
  if (ts_array_len(arr) >= limit) return 0;
  tsv part = ts_regexp_adapter_slice(input, start, end);
  ts_gc_root(&part);
  ts_array_push(arr, part);
  ts_gc_unroot(1);
  return ts_array_len(arr) < limit;
}

static tsv ts_regexp_adapter_split_compiled(ts_regexp_compiled* compiled,
                                            tsv input,
                                            uint32_t flags,
                                            tsv limit_value){
  if (!compiled) return ts_new_array(0);
  uint32_t limit = ts_regexp_adapter_split_limit(limit_value);
  tsv arr = ts_new_array(0);
  ts_gc_root(&arr);
  if (limit == 0){
    ts_gc_unroot(1);
    return arr;
  }
  ts_gc_root(&input);
  tsv s = ts_is_str(input) ? input : ts_to_string_v(input);
  ts_gc_root(&s);
  if (!ts_is_str(s)){
    ts_gc_unroot(3);
    return arr;
  }
  uint32_t input_len = ts_str_len_typed(s);
  uint32_t ncap = ts_regexp_capture_count(compiled);
  if (ncap == 0) ncap = 1;
  ts_regexp_span* captures = malloc(sizeof(ts_regexp_span) * (size_t)ncap);
  if (!captures){
    ts_gc_unroot(3);
    return ts_regexp_adapter_unsupported("RegExp split out of memory");
  }
  int full_unicode = (flags & (TSAOT_REGEXP_FLAG_UNICODE | TSAOT_REGEXP_FLAG_UNICODE_SETS)) != 0;
  if (input_len == 0){
    int rc0 = ts_regexp_exec_string_tsv(compiled, s, 0, captures, ncap);
    if (rc0 == TSAOT_REGEXP_OK && captures[0].matched && captures[0].start == 0 && captures[0].end == 0){
      free(captures);
      ts_gc_unroot(3);
      return arr;
    }
    ts_regexp_adapter_split_push(arr, limit, s);
    free(captures);
    ts_gc_unroot(3);
    return arr;
  }
  uint32_t p = 0;
  uint32_t q = 0;
  while (q < input_len){
    int rc = ts_regexp_exec_string_tsv(compiled, s, q, captures, ncap);
    if (rc != TSAOT_REGEXP_OK || !captures[0].matched) break;
    uint32_t start = captures[0].start;
    uint32_t end = captures[0].end;
    if (start > input_len || end > input_len || end < start) break;
    if (end == p){
      q = ts_regexp_adapter_advance_string_index(s, q, full_unicode);
      continue;
    }
    if (!ts_regexp_adapter_split_push_slice(arr, limit, s, p, start)) goto done;
    for (uint32_t i = 1; i < ncap; i++){
      if (captures[i].matched){
        tsv cap = ts_regexp_adapter_slice(s, captures[i].start, captures[i].end);
        ts_gc_root(&cap);
        if (!ts_regexp_adapter_split_push(arr, limit, cap)){
          ts_gc_unroot(1);
          goto done;
        }
        ts_gc_unroot(1);
      } else {
        if (!ts_regexp_adapter_split_push(arr, limit, TS_UNDEFINED)) goto done;
      }
    }
    p = end;
    q = p;
  }
  ts_regexp_adapter_split_push_slice(arr, limit, s, p, input_len);
done:
  free(captures);
  ts_gc_unroot(3);
  return arr;
}

tsv ts_regexp_adapter_test_tsv(tsv pattern, uint32_t flags, tsv input){
  if (!ts_regexp_adapter_available()) return ts_regexp_adapter_unsupported("RegExp QuickJS adapter unavailable");
  ts_regexp_compiled* re = ts_regexp_compile_pattern_tsv_cached(pattern, flags);
  if (!re) return ts_bool(0);
  int rc = ts_regexp_exec_string_tsv(re, input, 0, NULL, 0);
  return ts_bool(rc == TSAOT_REGEXP_OK);
}

double ts_regexp_adapter_search_tsv(tsv input, tsv pattern, uint32_t flags){
  if (!ts_regexp_adapter_available()){
    ts_regexp_adapter_unsupported("RegExp QuickJS adapter unavailable");
    return -1.0;
  }
  ts_regexp_compiled* re = ts_regexp_compile_pattern_tsv_cached(pattern, flags);
  if (!re) return -1.0;
  ts_regexp_span cap = {0, 0, 0};
  int rc = ts_regexp_exec_string_tsv(re, input, 0, &cap, 1);
  return (rc == TSAOT_REGEXP_OK && cap.matched) ? (double)cap.start : -1.0;
}

tsv ts_regexp_adapter_exec_tsv(tsv pattern, uint32_t flags, tsv input){
  if (!ts_regexp_adapter_available()) return ts_regexp_adapter_unsupported("RegExp QuickJS adapter unavailable");
  ts_gc_root(&pattern);
  ts_gc_root(&input);
  tsv s = ts_is_str(input) ? input : ts_to_string_v(input);
  ts_gc_root(&s);
  ts_regexp_compiled* re = ts_regexp_compile_pattern_tsv_cached(pattern, flags);
  if (!re){
    ts_gc_unroot(3);
    return TS_NULL;
  }
  uint32_t ncap = ts_regexp_capture_count(re);
  if (ncap == 0) ncap = 1;
  ts_regexp_span* captures = malloc(sizeof(ts_regexp_span) * (size_t)ncap);
  if (!captures){
    ts_gc_unroot(3);
    return ts_regexp_adapter_unsupported("RegExp exec out of memory");
  }
  int rc = ts_regexp_exec_string_tsv(re, s, 0, captures, ncap);
  const char* group_names = ts_regexp_group_names(re);
  tsv result = (rc == TSAOT_REGEXP_OK)
    ? ts_regexp_build_exec_result(s, captures, ncap, flags, group_names)
    : TS_NULL;
  free(captures);
  ts_gc_unroot(3);
  return result;
}

tsv ts_regexp_adapter_replace_tsv(tsv input, tsv pattern, uint32_t flags, tsv replacement, int replace_all_method){
  if (!ts_regexp_adapter_available()) return ts_regexp_adapter_unsupported("RegExp QuickJS adapter unavailable");
  ts_gc_root(&input);
  ts_gc_root(&pattern);
  ts_gc_root(&replacement);
  ts_regexp_compiled* re = ts_regexp_compile_pattern_tsv_cached(pattern, flags);
  if (!re){
    ts_gc_unroot(3);
    return TS_NULL;
  }
  tsv result = ts_regexp_adapter_replace_compiled(re, input, flags, replacement, replace_all_method, 0, TS_UNDEFINED);
  ts_gc_unroot(3);
  return result;
}

tsv ts_regexp_adapter_split_tsv(tsv input, tsv pattern, uint32_t flags, tsv limit){
  if (!ts_regexp_adapter_available()) return ts_regexp_adapter_unsupported("RegExp QuickJS adapter unavailable");
  uint32_t split_flags = flags & ~(TSAOT_REGEXP_FLAG_GLOBAL | TSAOT_REGEXP_FLAG_STICKY);
  ts_gc_root(&input);
  ts_gc_root(&pattern);
  ts_gc_root(&limit);
  ts_regexp_compiled* re = ts_regexp_compile_pattern_tsv_cached(pattern, split_flags);
  if (!re){
    ts_gc_unroot(3);
    return ts_new_array(0);
  }
  tsv result = ts_regexp_adapter_split_compiled(re, input, flags, limit);
  ts_gc_unroot(3);
  return result;
}

tsv ts_regexp_adapter_match_tsv(tsv input, tsv pattern, uint32_t flags){
  if (!ts_regexp_adapter_available()) return ts_regexp_adapter_unsupported("RegExp QuickJS adapter unavailable");
  if ((flags & TSAOT_REGEXP_FLAG_GLOBAL) == 0){
    return ts_regexp_adapter_exec_tsv(pattern, flags, input);
  }
  ts_gc_root(&input);
  ts_gc_root(&pattern);
  tsv s = ts_is_str(input) ? input : ts_to_string_v(input);
  ts_gc_root(&s);
  ts_regexp_compiled* re = ts_regexp_compile_pattern_tsv_cached(pattern, flags);
  if (!re){
    ts_gc_unroot(3);
    return TS_NULL;
  }
  tsv result = ts_regexp_adapter_match_global_compiled(re, s, flags);
  ts_gc_unroot(3);
  return result;
}

static int ts_regexp_adapter_object_exec_quick(tsv re, tsv input,
                                               int use_last_index,
                                               int update_last_index,
                                               ts_regexp_span** out_captures,
                                               uint32_t* out_capture_count,
                                               tsv* out_string,
                                               const char** out_group_names){
  *out_captures = NULL;
  *out_capture_count = 0;
  *out_string = TS_UNDEFINED;
  if (out_group_names) *out_group_names = NULL;
  if (!ts_regexp_adapter_available()) return TSAOT_REGEXP_ERR_UNAVAILABLE;
  tsv source = TS_UNDEFINED;
  uint32_t flags = 0;
  if (!ts_regexp_adapter_object_pattern(re, &source, &flags)) return TSAOT_REGEXP_ERR_COMPILE;
  ts_gc_root(&source);
  tsv s = ts_is_str(input) ? input : ts_to_string_v(input);
  ts_gc_root(&s);
  if (!ts_is_str(s)){
    ts_gc_unroot(2);
    return TSAOT_REGEXP_ERR_EXEC;
  }
  ts_strview sv = ts_str_view_typed(s);
  int global_or_sticky = (flags & (TSAOT_REGEXP_FLAG_GLOBAL | TSAOT_REGEXP_FLAG_STICKY)) != 0;
  long long start_ll = (use_last_index && global_or_sticky) ? ts_regexp_adapter_last_index_value(re) : 0;
  if (start_ll > (long long)sv.len){
    if (update_last_index && global_or_sticky) ts_regexp_adapter_set_last_index(re, 0.0);
    *out_string = s;
    ts_gc_unroot(2);
    return TSAOT_REGEXP_NOMATCH;
  }
  ts_regexp_compiled* compiled = ts_regexp_compile_pattern_tsv_cached(source, flags);
  if (!compiled){
    ts_gc_unroot(2);
    return TSAOT_REGEXP_ERR_COMPILE;
  }
  uint32_t ncap = ts_regexp_capture_count(compiled);
  if (ncap == 0) ncap = 1;
  ts_regexp_span* captures = malloc(sizeof(ts_regexp_span) * (size_t)ncap);
  if (!captures){
    ts_gc_unroot(2);
    return TSAOT_REGEXP_ERR_NOMEM;
  }
  int rc = ts_regexp_exec_string_tsv(compiled, s, (uint32_t)start_ll, captures, ncap);
  if (out_group_names) *out_group_names = ts_regexp_group_names(compiled);
  if (update_last_index && global_or_sticky){
    ts_regexp_adapter_set_last_index(re, (rc == TSAOT_REGEXP_OK && captures[0].matched) ? (double)captures[0].end : 0.0);
  }
  if (rc == TSAOT_REGEXP_OK){
    *out_captures = captures;
    *out_capture_count = ncap;
  } else {
    free(captures);
  }
  *out_string = s;
  ts_gc_unroot(2);
  return rc;
}

tsv ts_regexp_adapter_object_test_tsv(tsv re, tsv input){
  ts_gc_root(&re);
  ts_gc_root(&input);
  if (ts_regexp_adapter_object_has_prefix(re)){
    tsv result = ts_regexp_object_test_fast(re, input);
    ts_gc_unroot(2);
    return result;
  }
  ts_regexp_span* captures = NULL;
  uint32_t ncap = 0;
  tsv s = TS_UNDEFINED;
  int rc = ts_regexp_adapter_object_exec_quick(re, input, 1, 1, &captures, &ncap, &s, NULL);
  free(captures);
  if (rc == TSAOT_REGEXP_ERR_UNAVAILABLE) {
    tsv result = ts_regexp_adapter_unsupported("RegExp object QuickJS adapter unavailable");
    ts_gc_unroot(2);
    return result;
  }
  ts_gc_unroot(2);
  return ts_bool(rc == TSAOT_REGEXP_OK);
}

double ts_regexp_adapter_object_search_tsv(tsv input, tsv re){
  ts_gc_root(&input);
  ts_gc_root(&re);
  if (ts_regexp_adapter_object_has_prefix(re)){
    double result = ts_regexp_object_search_fast(input, re);
    ts_gc_unroot(2);
    return result;
  }
  ts_regexp_span* captures = NULL;
  uint32_t ncap = 0;
  tsv s = TS_UNDEFINED;
  int rc = ts_regexp_adapter_object_exec_quick(re, input, 0, 0, &captures, &ncap, &s, NULL);
  double result = (rc == TSAOT_REGEXP_OK && captures && captures[0].matched) ? (double)captures[0].start : -1.0;
  free(captures);
  if (rc == TSAOT_REGEXP_ERR_UNAVAILABLE){
    ts_regexp_adapter_unsupported("RegExp object QuickJS adapter unavailable");
  }
  ts_gc_unroot(2);
  return result;
}

tsv ts_regexp_adapter_object_exec_tsv(tsv re, tsv input){
  ts_gc_root(&re);
  ts_gc_root(&input);
  if (ts_regexp_adapter_object_has_prefix(re)){
    tsv result = ts_regexp_object_exec_fast(re, input);
    ts_gc_unroot(2);
    return result;
  }
  ts_regexp_span* captures = NULL;
  uint32_t ncap = 0;
  tsv s = TS_UNDEFINED;
  const char* group_names = NULL;
  int rc = ts_regexp_adapter_object_exec_quick(re, input, 1, 1, &captures, &ncap, &s, &group_names);
  tsv source = TS_UNDEFINED;
  uint32_t flags = 0;
  ts_regexp_adapter_object_pattern(re, &source, &flags);
  tsv result = (rc == TSAOT_REGEXP_OK) ? ts_regexp_build_exec_result(s, captures, ncap, flags, group_names) : TS_NULL;
  free(captures);
  if (rc == TSAOT_REGEXP_ERR_UNAVAILABLE){
    result = ts_regexp_adapter_unsupported("RegExp object QuickJS adapter unavailable");
  }
  ts_gc_unroot(2);
  return result;
}

tsv ts_regexp_adapter_object_match_tsv(tsv input, tsv re){
  ts_gc_root(&input);
  ts_gc_root(&re);
  if (ts_regexp_adapter_object_has_prefix(re)){
    tsv result = ts_regexp_object_match_fast(re, ts_is_str(input) ? input : ts_to_string_v(input));
    ts_gc_unroot(2);
    return result;
  }
  tsv source = TS_UNDEFINED;
  uint32_t flags = 0;
  if (!ts_regexp_adapter_object_pattern(re, &source, &flags)){
    ts_gc_unroot(2);
    return TS_NULL;
  }
  if ((flags & TSAOT_REGEXP_FLAG_GLOBAL) == 0){
    tsv result = ts_regexp_adapter_object_exec_tsv(re, input);
    ts_gc_unroot(2);
    return result;
  }
  if (!ts_regexp_adapter_available()){
    tsv result = ts_regexp_adapter_unsupported("RegExp object QuickJS adapter unavailable");
    ts_gc_unroot(2);
    return result;
  }
  ts_regexp_adapter_set_last_index(re, 0.0);
  ts_gc_root(&source);
  tsv s = ts_is_str(input) ? input : ts_to_string_v(input);
  ts_gc_root(&s);
  ts_regexp_compiled* compiled = ts_regexp_compile_pattern_tsv_cached(source, flags);
  if (!compiled){
    ts_regexp_adapter_set_last_index(re, 0.0);
    ts_gc_unroot(4);
    return TS_NULL;
  }
  tsv result = ts_regexp_adapter_match_global_compiled(compiled, s, flags);
  ts_regexp_adapter_set_last_index(re, 0.0);
  ts_gc_unroot(4);
  return result;
}

tsv ts_regexp_adapter_object_replace_tsv(tsv input, tsv re, tsv replacement, int replace_all_method){
  ts_gc_root(&input);
  ts_gc_root(&re);
  ts_gc_root(&replacement);
  tsv source = TS_UNDEFINED;
  uint32_t flags = 0;
  if (!ts_regexp_adapter_object_pattern(re, &source, &flags)){
    ts_gc_unroot(3);
    return TS_NULL;
  }
  if (!ts_regexp_adapter_available()){
    tsv result = ts_regexp_adapter_unsupported("RegExp object QuickJS adapter unavailable");
    ts_gc_unroot(3);
    return result;
  }
  ts_gc_root(&source);
  if (flags & TSAOT_REGEXP_FLAG_GLOBAL) ts_regexp_adapter_set_last_index(re, 0.0);
  uint32_t start_index = 0;
  if ((flags & TSAOT_REGEXP_FLAG_STICKY) && !(flags & TSAOT_REGEXP_FLAG_GLOBAL)){
    start_index = (uint32_t)ts_regexp_adapter_last_index_value(re);
  }
  ts_regexp_compiled* compiled = ts_regexp_compile_pattern_tsv_cached(source, flags);
  if (!compiled){
    if (flags & (TSAOT_REGEXP_FLAG_GLOBAL | TSAOT_REGEXP_FLAG_STICKY)) ts_regexp_adapter_set_last_index(re, 0.0);
    ts_gc_unroot(4);
    return TS_NULL;
  }
  tsv result = ts_regexp_adapter_replace_compiled(compiled, input, flags, replacement, replace_all_method, start_index, re);
  if (flags & TSAOT_REGEXP_FLAG_GLOBAL) ts_regexp_adapter_set_last_index(re, 0.0);
  ts_gc_unroot(4);
  return result;
}

tsv ts_regexp_adapter_object_split_tsv(tsv input, tsv re, tsv limit){
  ts_gc_root(&input);
  ts_gc_root(&re);
  ts_gc_root(&limit);
  tsv source = TS_UNDEFINED;
  uint32_t flags = 0;
  if (!ts_regexp_adapter_object_pattern(re, &source, &flags)){
    ts_gc_unroot(3);
    return ts_new_array(0);
  }
  if (!ts_regexp_adapter_available()){
    tsv result = ts_regexp_adapter_unsupported("RegExp object QuickJS adapter unavailable");
    ts_gc_unroot(3);
    return result;
  }
  uint32_t split_flags = flags & ~(TSAOT_REGEXP_FLAG_GLOBAL | TSAOT_REGEXP_FLAG_STICKY);
  ts_gc_root(&source);
  ts_regexp_compiled* compiled = ts_regexp_compile_pattern_tsv_cached(source, split_flags);
  if (!compiled){
    ts_gc_unroot(4);
    return ts_new_array(0);
  }
  tsv result = ts_regexp_adapter_split_compiled(compiled, input, flags, limit);
  ts_gc_unroot(4);
  return result;
}

static tsv ts_regexp_adapter_match_all_done_result(void){
  return ts_iter_result(TS_UNDEFINED, 1);
}

static tsv ts_regexp_adapter_match_all_iterator_self(tsv* args, int nargs){
  (void)nargs;
  return args ? args[0] : TS_UNDEFINED;
}

static tsv ts_regexp_adapter_match_all_next(tsv* args, int nargs){
  ts_regexp_adapter_ensure_object_keys();
  tsv iter = (args && nargs > 0) ? args[0] : TS_UNDEFINED;
  ts_gc_root(&iter);
  if (!ts_is_obj(iter) || ts_truthy(ts_get(iter, ts_rx_k_iter_done))){
    ts_gc_unroot(1);
    return ts_regexp_adapter_match_all_done_result();
  }
  tsv input = ts_get(iter, ts_rx_k_iter_input);
  tsv source = ts_get(iter, ts_rx_k_iter_source);
  tsv flags_v = ts_get(iter, ts_rx_k_iter_flags);
  tsv index_v = ts_get(iter, ts_rx_k_iter_index);
  if (!ts_is_str(input) || !ts_is_str(source) || !ts_is_num(flags_v)){
    ts_set(iter, ts_rx_k_iter_done, ts_bool(1));
    ts_gc_unroot(1);
    return ts_regexp_adapter_match_all_done_result();
  }
  uint32_t flags = (uint32_t)ts_to_num(flags_v);
  double index_d = ts_is_num(index_v) ? ts_to_num(index_v) : 0.0;
  uint32_t index = (index_d > 0.0 && isfinite(index_d)) ? (uint32_t)floor(index_d) : 0;
  ts_gc_root(&input);
  ts_gc_root(&source);
  ts_strview sv = ts_str_view_typed(input);
  if (index > sv.len){
    ts_set(iter, ts_rx_k_iter_done, ts_bool(1));
    ts_gc_unroot(3);
    return ts_regexp_adapter_match_all_done_result();
  }
  ts_regexp_compiled* compiled = ts_regexp_compile_pattern_tsv_cached(source, flags);
  if (!compiled){
    ts_set(iter, ts_rx_k_iter_done, ts_bool(1));
    ts_gc_unroot(3);
    return ts_regexp_adapter_match_all_done_result();
  }
  uint32_t ncap = ts_regexp_capture_count(compiled);
  if (ncap == 0) ncap = 1;
  ts_regexp_span* captures = malloc(sizeof(ts_regexp_span) * (size_t)ncap);
  if (!captures){
    ts_gc_unroot(3);
    return ts_regexp_adapter_unsupported("RegExp matchAll out of memory");
  }
  int rc = ts_regexp_exec_string_tsv(compiled, input, index, captures, ncap);
  if (rc != TSAOT_REGEXP_OK || !captures[0].matched){
    free(captures);
    ts_set(iter, ts_rx_k_iter_done, ts_bool(1));
    ts_gc_unroot(3);
    return ts_regexp_adapter_match_all_done_result();
  }
  const char* group_names = ts_regexp_group_names(compiled);
  tsv match = ts_regexp_build_exec_result(input, captures, ncap, flags, group_names);
  ts_gc_root(&match);
  uint32_t next_index = captures[0].end;
  if (captures[0].end == captures[0].start){
    int full_unicode = (flags & (TSAOT_REGEXP_FLAG_UNICODE | TSAOT_REGEXP_FLAG_UNICODE_SETS)) != 0;
    next_index = ts_regexp_adapter_advance_string_index(input, next_index, full_unicode);
  }
  ts_set(iter, ts_rx_k_iter_index, ts_num((double)next_index));
  free(captures);
  tsv result = ts_iter_result(match, 0);
  ts_gc_unroot(4);
  return result;
}

static tsv ts_regexp_adapter_match_all_iterator(tsv input,
                                                tsv source,
                                                uint32_t flags,
                                                uint32_t start_index){
  ts_regexp_adapter_ensure_object_keys();
  if ((flags & TSAOT_REGEXP_FLAG_GLOBAL) == 0){
    return ts_regexp_adapter_unsupported("String.prototype.matchAll(RegExp non-global)");
  }
  if (!ts_regexp_adapter_available()){
    return ts_regexp_adapter_unsupported("RegExp QuickJS adapter unavailable");
  }
  ts_gc_root(&input);
  ts_gc_root(&source);
  tsv s = ts_is_str(input) ? input : ts_to_string_v(input);
  ts_gc_root(&s);
  tsv src = ts_is_str(source) ? source : ts_to_string_v(source);
  ts_gc_root(&src);
  if (!ts_is_str(s) || !ts_is_str(src)){
    ts_gc_unroot(4);
    return TS_NULL;
  }
  tsv iter = ts_new_object();
  ts_gc_root(&iter);
  tsv next_fn = ts_make_fn_t(ts_regexp_adapter_match_all_next, NULL, 0, 1);
  ts_gc_root(&next_fn);
  ts_set_fn_meta(next_fn, 0, "next");
  tsv self_fn = ts_make_fn_t(ts_regexp_adapter_match_all_iterator_self, NULL, 0, 1);
  ts_gc_root(&self_fn);
  ts_set_fn_meta(self_fn, 0, "[Symbol.iterator]");
  ts_set(iter, ts_rx_k_iter_input, s);
  ts_set(iter, ts_rx_k_iter_source, src);
  ts_set(iter, ts_rx_k_iter_flags, ts_num((double)flags));
  ts_set(iter, ts_rx_k_iter_index, ts_num((double)start_index));
  ts_set(iter, ts_rx_k_iter_done, ts_bool(0));
  ts_set(iter, ts_intern_field("next", 4), next_fn);
  ts_set(iter, TS_KEY_WKSYM(TS_WKSYM_ITERATOR), self_fn);
  ts_gc_unroot(7);
  return iter;
}

tsv ts_regexp_adapter_match_all_tsv(tsv input, tsv pattern, uint32_t flags){
  return ts_regexp_adapter_match_all_iterator(input, pattern, flags, 0);
}

tsv ts_regexp_adapter_object_match_all_tsv(tsv input, tsv re){
  ts_gc_root(&input);
  ts_gc_root(&re);
  tsv source = TS_UNDEFINED;
  uint32_t flags = 0;
  if (!ts_regexp_adapter_object_pattern(re, &source, &flags)){
    ts_gc_unroot(2);
    return TS_NULL;
  }
  uint32_t start_index = (uint32_t)ts_regexp_adapter_last_index_value(re);
  tsv result = ts_regexp_adapter_match_all_iterator(input, source, flags, start_index);
  ts_gc_unroot(2);
  return result;
}

bool lre_check_stack_overflow(void *opaque, size_t alloca_size){
  (void)opaque;
  (void)alloca_size;
  return false;
}

int lre_check_timeout(void *opaque){
  (void)opaque;
  return 0;
}

void *lre_realloc(void *opaque, void *ptr, size_t size){
  (void)opaque;
  if (size == 0){
    free(ptr);
    return NULL;
  }
  return realloc(ptr, size);
}
