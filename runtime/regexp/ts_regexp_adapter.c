/* ts_regexp_adapter.c: RegExp objects and the String / RegExp methods over the engine
   (docs/regexp_vm_design.md). A RegExp is a TS_KIND_REGEXP cell (ts_rt.h: the program, the source
   string, the flags; `lastIndex` an own data property in its map). Programs are compiled through
   a content-keyed cache and an identity cache for literal sources; the engine runs over the
   string's own code units (Latin-1 or UTF-16), no copies; the results are built here. The
   semantics follow ES2025's RegExpBuiltinExec and the @@match / @@matchAll / @@replace / @@search /
   @@split algorithms, with V8 as the oracle. */
#include "../ts_rt.h"
#include "ts_regexp_adapter.h"
#include "rx.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

/* ---- keys ---- */
static ts_key k_lastIndex, k_index, k_input, k_groups, k_indices, k_next;
static ts_key k_iter_re, k_iter_input, k_iter_done;
/* the named properties of a result array in their order (`indices` only under `d`), as the
   layouts a fresh result adopts (build_result) */
static ts_key g_result_keys[4];
static ts_lit_layout g_result_layout = { 0, 3, g_result_keys, NULL };
static ts_lit_layout g_result_layout_d = { 0, 4, g_result_keys, NULL };
static int g_keys_ready;
static void keys_init(void){
  if (g_keys_ready) return;
  k_lastIndex = ts_intern_field("lastIndex", 9); k_index = ts_intern_field("index", 5);
  k_input = ts_intern_field("input", 5); k_groups = ts_intern_field("groups", 6);
  k_indices = ts_intern_field("indices", 7); k_next = ts_intern_field("next", 4);
  g_result_keys[0] = k_index; g_result_keys[1] = k_input; g_result_keys[2] = k_groups; g_result_keys[3] = k_indices;
  k_iter_re = ts_intern_field("__tsaot_rx_iter_re", 18); k_iter_input = ts_intern_field("__tsaot_rx_iter_input", 21);
  k_iter_done = ts_intern_field("__tsaot_rx_iter_done", 20);
  g_keys_ready = 1;
}

/* ---- the pattern's code units ---- */
typedef struct units { const uint16_t* u; uint32_t n; uint16_t* owned; uint16_t small[256]; } units;
static void units_of(tsv s, units* out){
  ts_strview sv = ts_str_view_typed(s);
  char buf[TS_SHORTSTR_MAX];
  const char* data = ts_str_view_data(&sv, buf);
  out->owned = NULL; out->n = sv.len;
  if (sv.flags & TS_STR_FLAG_UTF16){
    if (data == buf){ memcpy(out->small, data, sv.len * 2u); out->u = out->small; }
    else out->u = (const uint16_t*)data;
    return;
  }
  uint16_t* w = sv.len <= 256 ? out->small : (out->owned = (uint16_t*)malloc(sizeof(uint16_t) * sv.len));
  if (!w) abort();
  for (uint32_t i = 0; i < sv.len; i++) w[i] = (uint8_t)data[i];
  out->u = w;
}
static void units_free(units* u){ free(u->owned); }

/* ---- the compile cache ---- */
typedef struct cache_entry { uint16_t* src; uint32_t len; uint32_t flags; rx_program* prog; } cache_entry;
#define CACHE_SLOTS 1024u
static cache_entry g_cache[CACHE_SLOTS];
typedef struct id_entry { tsv pattern; uint32_t flags; rx_program* prog; } id_entry;
#define ID_SLOTS 256u
static id_entry g_id_cache[ID_SLOTS];

static uint32_t hash_units(const uint16_t* u, uint32_t n, uint32_t flags){
  uint32_t h = 2166136261u ^ (flags * 16777619u);
  for (uint32_t i = 0; i < n; i++){ h ^= u[i]; h *= 16777619u; }
  return h;
}
static char* utf16_to_utf8(const uint16_t* u, uint32_t n, size_t* out_len){
  char* o = (char*)malloc((size_t)n * 4u + 1u); size_t k = 0;
  if (!o) abort();
  for (uint32_t i = 0; i < n; i++){
    uint32_t cp = u[i];
    if (cp >= 0xD800u && cp <= 0xDBFFu && i + 1 < n && u[i+1] >= 0xDC00u && u[i+1] <= 0xDFFFu){ cp = 0x10000u + ((cp - 0xD800u) << 10) + (u[i+1] - 0xDC00u); i++; }
    if (cp < 0x80u) o[k++] = (char)cp;
    else if (cp < 0x800u){ o[k++] = (char)(0xC0 | (cp >> 6)); o[k++] = (char)(0x80 | (cp & 0x3F)); }
    else if (cp < 0x10000u){ o[k++] = (char)(0xE0 | (cp >> 12)); o[k++] = (char)(0x80 | ((cp >> 6) & 0x3F)); o[k++] = (char)(0x80 | (cp & 0x3F)); }
    else { o[k++] = (char)(0xF0 | (cp >> 18)); o[k++] = (char)(0x80 | ((cp >> 12) & 0x3F)); o[k++] = (char)(0x80 | ((cp >> 6) & 0x3F)); o[k++] = (char)(0x80 | (cp & 0x3F)); }
  }
  o[k] = 0; *out_len = k;
  return o;
}
static void flags_text(uint32_t flags, char out[9]){
  static const char order[] = "dgimsuvy";
  static const uint32_t bits[] = { TSAOT_REGEXP_FLAG_INDICES, TSAOT_REGEXP_FLAG_GLOBAL, TSAOT_REGEXP_FLAG_IGNORECASE,
    TSAOT_REGEXP_FLAG_MULTILINE, TSAOT_REGEXP_FLAG_DOTALL, TSAOT_REGEXP_FLAG_UNICODE, TSAOT_REGEXP_FLAG_UNICODE_SETS, TSAOT_REGEXP_FLAG_STICKY };
  uint32_t k = 0;
  for (uint32_t i = 0; i < 8; i++) if (flags & bits[i]) out[k++] = order[i];
  out[k] = 0;
}
static void throw_syntax(const uint16_t* u, uint32_t n, uint32_t flags, const char* reason){
  static char msg[2048];
  size_t ulen; char* src = utf16_to_utf8(u, n, &ulen);
  char fl[9]; flags_text(flags, fl);
  snprintf(msg, sizeof msg, "Invalid regular expression: /%s/%s: %s", src, fl, reason);
  free(src);
  ts_throw_syntax_error_msg(msg);
}
/* The native tier (docs/regexp_vm_design.md): a literal site passes the matchers the analyzer
   compiled for its pattern; they are bound to the program on its first use. TSAOT_REGEXP_NATIVE=0
   in the environment keeps every program on the interpreter (the A/B). The patterns a program
   builds at run time ("The native tier for run-time patterns"): under TSAOT_REGEXP_RECORD=<file>
   every pattern compiled without matchers from its site is appended to the file (the training
   run's record, merged into default.regexps), and a table of matchers built from such a record
   (the object `tsaot regexps` writes) is looked up by content when a pattern is compiled;
   TSAOT_REGEXP_TRACE=1 reports each table binding on stderr. */
static int g_native_off;
static FILE* g_record;
static int g_trace;
static void write_pattern_line(FILE* f, const uint16_t* u, uint32_t n, uint32_t flags){
  char fl[9]; flags_text(flags, fl);
  size_t ulen; char* src = utf16_to_utf8(u, n, &ulen);
  fputs(fl, f); fputc('\t', f);
  for (uint32_t i = 0; i < n; i++) fprintf(f, "%04x", (unsigned)u[i]);
  fputc('\t', f);
  for (size_t i = 0; i < ulen; i++){
    unsigned char c = (unsigned char)src[i];
    if (c == '\\') fputs("\\\\", f); else if (c == '\t') fputs("\\t", f); else if (c == '\n') fputs("\\n", f); else if (c == '\r') fputs("\\r", f); else fputc(c, f);
  }
  fputc('\n', f);
  free(src);
}
static void record_pattern(const uint16_t* u, uint32_t n, uint32_t flags){
  if (!g_record) return;
  write_pattern_line(g_record, u, n, flags);
  fflush(g_record);
}
/* compile (or find) the program of a pattern; throws a SyntaxError. A pattern compiled for the
   first time takes the matchers of the installed table when it holds the pattern. */
static rx_program* compile_units(const uint16_t* u, uint32_t n, uint32_t flags){
  uint32_t h = hash_units(u, n, flags);
  cache_entry* e = &g_cache[h & (CACHE_SLOTS - 1u)];
  if (e->prog && e->flags == flags && e->len == n && memcmp(e->src, u, sizeof(uint16_t) * n) == 0) return e->prog;
  rx_error err;
  rx_program* p = rx_compile(u, n, flags, &err);
  if (!p){ throw_syntax(u, n, flags, err.msg ? err.msg : "Invalid regular expression"); return NULL; }
  if (!g_native_off){
    rx_native_fn n8, n16;
    if (rx_native_table_find(u, n, flags, &n8, &n16)){
      rx_set_native(p, n8, n16);
      if (g_trace){ fputs("[regexp] native table: bound ", stderr); write_pattern_line(stderr, u, n, flags); }
    }
  }
  if (e->prog){ rx_release(e->prog); free(e->src); }
  e->src = (uint16_t*)malloc(sizeof(uint16_t) * (n ? n : 1));
  if (!e->src) abort();
  memcpy(e->src, u, sizeof(uint16_t) * n);
  e->len = n; e->flags = flags; e->prog = p;   /* the cache holds p's first reference */
  return p;
}
static inline rx_program* bind_native(rx_program* p, rx_native_fn n8, rx_native_fn n16){
  if (n8 && !g_native_off) rx_set_native(p, n8, n16);
  return p;
}
/* a pattern string: a static literal source goes through the identity cache; a pattern whose
   site passes no matchers (built at run time) goes to the record on its first compile */
static rx_program* compile_pattern(tsv pattern, uint32_t flags, rx_native_fn n8, rx_native_fn n16){
  if (ts_is_heap_str(pattern) && (ts_str_flags_typed(pattern) & TS_STR_FLAG_STATIC)){
    uint64_t x = (uint64_t)pattern ^ ((uint64_t)pattern >> 17) ^ ((uint64_t)flags * 0x9E3779B1u);
    id_entry* e = &g_id_cache[(uint32_t)(x >> 3) & (ID_SLOTS - 1u)];
    if (e->prog && e->pattern == pattern && e->flags == flags) return bind_native(e->prog, n8, n16);
    units un; units_of(pattern, &un);
    if (!n8) record_pattern(un.u, un.n, flags);
    rx_program* p = compile_units(un.u, un.n, flags);
    units_free(&un);
    if (e->prog) rx_release(e->prog);
    rx_retain(p);
    e->pattern = pattern; e->flags = flags; e->prog = p;
    return bind_native(p, n8, n16);
  }
  units un; units_of(pattern, &un);
  if (!n8) record_pattern(un.u, un.n, flags);
  rx_program* p = compile_units(un.u, un.n, flags);
  units_free(&un);
  return bind_native(p, n8, n16);
}

/* ---- the RegExp object ---- */
static inline ts_regexp* as_re(tsv v){ return (ts_regexp*)ts_ptr(v); }
static tsv regexp_make(rx_program* p, tsv source, uint32_t flags){
  keys_init();
  ts_gc_root(&source);
  rx_retain(p);
  tsv re = ts_regexp_alloc();
  ts_gc_root(&re);
  ts_regexp* r = as_re(re);
  r->prog = p; r->flags = flags; r->source = source; r->ncaps = 2u * (rx_group_count(p) + 1u);
  ts_write_barrier(re, source);
  ts_define_data(re, k_lastIndex, ts_num(0), 0, 1, 0);
  ts_gc_unroot(2);
  return re;
}
tsv ts_regexp_new_literal(tsv source, uint32_t flags, rx_native_fn n8, rx_native_fn n16){
  ts_gc_root(&source);
  rx_program* p = compile_pattern(source, flags, n8, n16);
  ts_gc_unroot(1);
  return regexp_make(p, source, flags);
}
static void release_program(rx_program* p){ if (p) rx_release(p); }

/* lastIndex: ToLength of the property, read and written through the cell's slot (the generic
   paths when an accessor was defined over it or it was made read-only) */
static ts_rt_ic g_ic_last;
static inline double last_index_raw(tsv re){
  tsv* slot = ts_regexp_last_index_slot(re, 0);
  tsv v = slot ? *slot : ts_get_ic(re, k_lastIndex, &g_ic_last);
  return ts_is_num(v) ? ts_to_num(v) : ts_number_coerce(v);
}
static inline uint32_t to_length_u32(double d){
  if (!(d > 0.0) || !isfinite(d)) return 0;
  if (d > 4294967295.0) return 4294967295u;
  return (uint32_t)floor(d);
}
static uint32_t last_index_get(tsv re){ return to_length_u32(last_index_raw(re)); }
static void last_index_set(tsv re, uint32_t v){
  tsv* slot = ts_regexp_last_index_slot(re, 1);
  if (slot) *slot = ts_num((double)v); else ts_set_ic(re, k_lastIndex, ts_num((double)v), &g_ic_last);
}

/* ---- running the engine over a string ---- */
static int exec_string(rx_program* p, tsv s, uint32_t start, int32_t* caps){
  ts_strview sv = ts_str_view_typed(s);
  char buf[TS_SHORTSTR_MAX];
  const char* data = ts_str_view_data(&sv, buf);
  int wide = (sv.flags & TS_STR_FLAG_UTF16) != 0;
  int r = rx_exec(p, data, sv.len, wide, start, caps);
  if (r == RX_EXEC_OVERFLOW){ ts_throw_range_error_msg("Maximum call stack size exceeded"); return 0; }
  return r;
}
#define CAPS_STACK 64u
typedef struct capsbuf { int32_t* v; int32_t small[CAPS_STACK]; } capsbuf;
static inline void caps_init_n(capsbuf* c, uint32_t n){
  c->v = n <= CAPS_STACK ? c->small : (int32_t*)malloc(sizeof(int32_t) * n);
  if (!c->v) abort();
}
static void caps_init(capsbuf* c, rx_program* p){ caps_init_n(c, 2u * (rx_group_count(p) + 1u)); }
static void caps_free(capsbuf* c){ if (c->v != c->small) free(c->v); }

static uint32_t advance_index(tsv s, uint32_t i, int unicode){
  ts_strview sv = ts_str_view_typed(s);
  if (!unicode || i + 1u >= sv.len) return i + 1u;
  uint16_t hi = ts_str_cu_at_view(sv, i);
  if (hi >= 0xD800u && hi <= 0xDBFFu){ uint16_t lo = ts_str_cu_at_view(sv, i + 1u); if (lo >= 0xDC00u && lo <= 0xDFFFu) return i + 2u; }
  return i + 1u;
}

/* RegExpBuiltinExec: lastIndex read for g / y, the match, lastIndex written; caps filled.
   The plain case (the input a string, lastIndex a number in its slot) runs no user code, so it
   neither roots (a handle only moves at a collection, which only an allocation triggers) nor
   reads the string's view twice. */
static int builtin_exec(tsv re, tsv s, int32_t* caps){
  ts_regexp* r = as_re(re);
  uint32_t flags = r->flags;
  int gy = (flags & (TSAOT_REGEXP_FLAG_GLOBAL | TSAOT_REGEXP_FLAG_STICKY)) != 0;
  tsv* slot = ts_regexp_last_index_slot(re, 1);
  if (slot && ts_is_num(*slot) && ts_is_str(s)){
    ts_strview sv = ts_str_view_typed(s);
    char buf[TS_SHORTSTR_MAX];
    const char* data = ts_str_view_data(&sv, buf);
    uint32_t start = 0;
    if (gy){
      start = to_length_u32(ts_to_num(*slot));
      if (start > sv.len){ *slot = ts_num(0); return 0; }
    }
    int m = rx_exec(r->prog, data, sv.len, (sv.flags & TS_STR_FLAG_UTF16) != 0, start, caps);
    if (m == RX_EXEC_OVERFLOW){ ts_throw_range_error_msg("Maximum call stack size exceeded"); return 0; }
    if (gy) *slot = ts_num(m ? (double)caps[1] : 0.0);
    return m;
  }
  uint32_t start = 0;
  ts_gc_root(&re); ts_gc_root(&s);
  if (gy){
    start = last_index_get(re);
    if (start > ts_str_len_typed(s)){ last_index_set(re, 0); ts_gc_unroot(2); return 0; }
  }
  int m = exec_string(as_re(re)->prog, s, start, caps);
  if (!m){ if (gy) last_index_set(re, 0); ts_gc_unroot(2); return 0; }
  if (gy) last_index_set(re, (uint32_t)caps[1]);
  ts_gc_unroot(2);
  return 1;
}

/* ---- results ---- */
static tsv slice(tsv s, int32_t a, int32_t b){
  if (b <= a) return ts_short_str_ascii("", 0);   /* an empty capture (`$()` marks a route in hono's router) */
  uint32_t n = (uint32_t)(b - a);
  if (n <= TS_SHORTSTR_MAX && ts_is_heap_str(s)){
    /* a short capture of a flat ASCII string (a route parameter): the immediate from the bytes */
    const ts_string* x = ts_str_ptr_typed(s);
    if ((x->flags & (TS_STR_FLAG_ASCII | TS_STR_FLAG_VIEW | TS_STR_FLAG_UTF16)) == TS_STR_FLAG_ASCII) return ts_short_str_ascii(x->data + a, n);
  }
  return ts_str_slice(s, (double)a, (double)b, 1);
}
static tsv substr(tsv s, uint32_t start, uint32_t len){ return ts_str_slice(s, (double)start, (double)(start + len), 1); }
/* the program's named groups as the runtime sees them, made once per program and freed with it:
   the interned key of each distinct name in group order (the `groups` object's layout) and
   each group's slot in it (-1 for an unnamed group; duplicate names share a slot) */
typedef struct prog_meta { ts_key* keys; uint32_t nkeys; int32_t* name_slot; ts_lit_layout layout; } prog_meta;
static void meta_free(void* d){ prog_meta* m = (prog_meta*)d; free(m->keys); free(m->name_slot); free(m); }
static prog_meta* meta_of(rx_program* p){
  prog_meta* m = (prog_meta*)rx_user(p);
  if (m) return m;
  uint32_t ng = rx_group_count(p);
  m = (prog_meta*)calloc(1, sizeof *m);
  m->keys = (ts_key*)malloc(sizeof(ts_key) * (ng ? ng : 1));
  m->name_slot = (int32_t*)malloc(sizeof(int32_t) * (ng + 1));
  if (!m || !m->keys || !m->name_slot) abort();
  m->name_slot[0] = -1;
  for (uint32_t g = 1; g <= ng; g++){
    uint32_t nl; const uint16_t* name = rx_group_name(p, g, &nl);
    if (!name){ m->name_slot[g] = -1; continue; }
    int32_t slot = -1;
    for (uint32_t h = 1; h < g; h++){
      uint32_t hl; const uint16_t* hn = rx_group_name(p, h, &hl);
      if (hn && hl == nl && memcmp(hn, name, sizeof(uint16_t) * nl) == 0){ slot = m->name_slot[h]; break; }
    }
    if (slot < 0){
      size_t ulen; char* u8 = utf16_to_utf8(name, nl, &ulen);
      m->keys[m->nkeys] = ts_intern_field(u8, (uint32_t)ulen);
      free(u8);
      slot = (int32_t)m->nkeys++;
    }
    m->name_slot[g] = slot;
  }
  m->layout.shape = 0; m->layout.n = m->nkeys; m->layout.keys = m->keys; m->layout.kinds = NULL;
  rx_set_user(p, m, meta_free);
  return m;
}
/* the `groups` object (null prototype) from the program's layout: each name's slot takes the
   participating group's value out of `values` (the result array, or the indices array) */
static tsv build_groups(tsv values, const int32_t* caps, rx_program* p){
  prog_meta* m = meta_of(p);
  uint32_t ng = rx_group_count(p);
  ts_gc_root(&values);
  tsv obj = ts_new_object_layout(&m->layout);
  ((ts_object*)ts_ptr(obj))->proto = TS_NULL;
  ts_gc_root(&obj);
  for (uint32_t g = 1; g <= ng; g++){
    if (m->name_slot[g] < 0 || caps[2*g] < 0) continue;
    ts_lit_store(obj, (uint32_t)m->name_slot[g], ts_array_get(values, g));
  }
  ts_gc_unroot(2);
  return obj;
}
/* The result arrays are allocated at their length, the elements stored in line (a fresh array:
   the slot store and the generation test), and the named properties (`index`, `input`, `groups`,
   and `indices` under `d`) are a layout the array adopts at creation (ts_array_adopt_layout), so
   each is one slot store; the shape is the one the keys added in that order from the empty array
   shape would give. The inline caches are the fallback when the array cannot adopt the layout
   (the shape table exhausted): the addition cache answers each store without the probe of the
   receiver and its prototype chain that a generic set does. */
static ts_prop_ic g_ic_index, g_ic_input, g_ic_groups, g_ic_indices, g_ic_ind_groups;
static tsv build_indices(tsv s, const int32_t* caps, rx_program* p){
  uint32_t ng = rx_group_count(p);
  ts_gc_root(&s);
  tsv arr = ts_new_array(ng + 1u);
  ts_gc_root(&arr);
  for (uint32_t g = 0; g <= ng; g++){
    if (caps[2*g] < 0){ ts_array_set(arr, g, TS_UNDEFINED); continue; }
    tsv pair = ts_new_array(2);   /* arr is rooted: the allocation may move it */
    ts_array_set(pair, 0, ts_num(caps[2*g])); ts_array_set(pair, 1, ts_num(caps[2*g+1]));
    ts_array_set(arr, g, pair);
  }
  tsv groups = rx_has_named_groups(p) ? build_groups(arr, caps, p) : TS_UNDEFINED;
  ts_gc_root(&groups);
  ts_set_pic(arr, k_groups, groups, &g_ic_ind_groups);
  ts_gc_unroot(3);
  return arr;
}
static tsv build_result(tsv s, const int32_t* caps, rx_program* p){
  if (!g_keys_ready) keys_init();
  uint32_t ng = rx_group_count(p);
  int with_indices = (rx_flags(p) & TSAOT_REGEXP_FLAG_INDICES) != 0;
  ts_gc_root(&s);
  tsv arr = ts_new_array_compact(ng + 1u);   /* the cell and the elements in one allocation */
  int laid = ts_array_adopt_layout(arr, with_indices ? &g_result_layout_d : &g_result_layout);
  ts_gc_root(&arr);
  ts_array* a = (ts_array*)ts_ptr(arr);   /* dense at its length, never moves; the slot stores need only the generation test */
  for (uint32_t g = 0; g <= ng; g++){
    tsv part = caps[2*g] >= 0 ? slice(s, caps[2*g], caps[2*g+1]) : TS_UNDEFINED;   /* arr is rooted; part is stored at once */
    a->data[g] = part;
    if (a->o.h.gen == TS_GEN_OLD) ts_array_remember(a, g, part);
  }
  if (laid){ ts_lit_store(arr, 0, ts_num(caps[0])); ts_lit_store(arr, 1, s); }
  else { ts_set_pic(arr, k_index, ts_num(caps[0]), &g_ic_index); ts_set_pic(arr, k_input, s, &g_ic_input); }
  tsv groups = rx_has_named_groups(p) ? build_groups(arr, caps, p) : TS_UNDEFINED;
  if (laid) ts_lit_store(arr, 2, groups);
  else { ts_gc_root(&groups); ts_set_pic(arr, k_groups, groups, &g_ic_groups); ts_gc_unroot(1); }
  if (with_indices){
    tsv ind = build_indices(s, caps, p);
    if (laid) ts_lit_store(arr, 3, ind);
    else { ts_gc_root(&ind); ts_set_pic(arr, k_indices, ind, &g_ic_indices); ts_gc_unroot(1); }
  }
  ts_gc_unroot(2);
  return arr;
}

/* ---- the literal entry points (no RegExp object) ---- */
static tsv to_str(tsv v){ return ts_is_str(v) ? v : ts_to_string_v(v); }
tsv ts_regexp_adapter_test_tsv(tsv pattern, uint32_t flags, tsv input, rx_native_fn n8, rx_native_fn n16){
  if (ts_is_str(input)){
    rx_program* p = compile_pattern(pattern, flags, n8, n16);
    capsbuf cb; caps_init(&cb, p);
    int m = exec_string(p, input, 0, cb.v);
    caps_free(&cb);
    return ts_bool(m);
  }
  ts_gc_root(&input); ts_gc_root(&pattern);
  tsv s = to_str(input); ts_gc_root(&s);
  rx_program* p = compile_pattern(pattern, flags, n8, n16);
  capsbuf cb; caps_init(&cb, p);
  int m = exec_string(p, s, 0, cb.v);
  caps_free(&cb);
  ts_gc_unroot(3);
  return ts_bool(m);
}
double ts_regexp_adapter_search_tsv(tsv input, tsv pattern, uint32_t flags, rx_native_fn n8, rx_native_fn n16){
  ts_gc_root(&input); ts_gc_root(&pattern);
  tsv s = to_str(input); ts_gc_root(&s);
  rx_program* p = compile_pattern(pattern, flags, n8, n16);
  capsbuf cb; caps_init(&cb, p);
  int m = exec_string(p, s, 0, cb.v);
  double r = m ? (double)cb.v[0] : -1.0;
  caps_free(&cb);
  ts_gc_unroot(3);
  return r;
}
tsv ts_regexp_adapter_exec_tsv(tsv pattern, uint32_t flags, tsv input, rx_native_fn n8, rx_native_fn n16){
  ts_gc_root(&input); ts_gc_root(&pattern);
  tsv s = to_str(input); ts_gc_root(&s);
  rx_program* p = compile_pattern(pattern, flags, n8, n16);
  capsbuf cb; caps_init(&cb, p);
  int m = exec_string(p, s, 0, cb.v);
  tsv r = m ? build_result(s, cb.v, p) : TS_NULL;
  caps_free(&cb);
  ts_gc_unroot(3);
  return r;
}
/* a temporary RegExp object for the object algorithms (match / matchAll / replace / split) */
static tsv temp_regexp(tsv pattern, uint32_t flags, rx_native_fn n8, rx_native_fn n16){
  ts_gc_root(&pattern);
  rx_program* p = compile_pattern(pattern, flags, n8, n16);
  ts_gc_unroot(1);
  return regexp_make(p, pattern, flags);
}
tsv ts_regexp_adapter_match_tsv(tsv input, tsv pattern, uint32_t flags, rx_native_fn n8, rx_native_fn n16){
  ts_gc_root(&input); ts_gc_root(&pattern);
  tsv re = temp_regexp(pattern, flags, n8, n16); ts_gc_root(&re);
  tsv r = ts_regexp_adapter_object_match_tsv(input, re);
  ts_gc_unroot(3);
  return r;
}
tsv ts_regexp_adapter_match_all_tsv(tsv input, tsv pattern, uint32_t flags, rx_native_fn n8, rx_native_fn n16){
  ts_gc_root(&input); ts_gc_root(&pattern);
  tsv re = temp_regexp(pattern, flags, n8, n16); ts_gc_root(&re);
  tsv r = ts_regexp_adapter_object_match_all_tsv(input, re);
  ts_gc_unroot(3);
  return r;
}
tsv ts_regexp_adapter_replace_tsv(tsv input, tsv pattern, uint32_t flags, tsv replacement, int replace_all_method, rx_native_fn n8, rx_native_fn n16){
  ts_gc_root(&input); ts_gc_root(&pattern); ts_gc_root(&replacement);
  tsv re = temp_regexp(pattern, flags, n8, n16); ts_gc_root(&re);
  tsv r = ts_regexp_adapter_object_replace_tsv(input, re, replacement, replace_all_method);
  ts_gc_unroot(4);
  return r;
}
tsv ts_regexp_adapter_split_tsv(tsv input, tsv pattern, uint32_t flags, tsv limit, rx_native_fn n8, rx_native_fn n16){
  ts_gc_root(&input); ts_gc_root(&pattern); ts_gc_root(&limit);
  tsv re = temp_regexp(pattern, flags, n8, n16); ts_gc_root(&re);
  tsv r = ts_regexp_adapter_object_split_tsv(input, re, limit);
  ts_gc_unroot(4);
  return r;
}

/* ---- the object entry points ---- */
static void require_regexp_fail(const char* what){
  char msg[160]; snprintf(msg, sizeof msg, "%s called on incompatible receiver", what);
  ts_throw_type_error_msg(msg);
}
static inline void require_regexp(tsv re, const char* what){ if (TS_RT_UNLIKELY(!ts_is_regexp(re))) require_regexp_fail(what); }
tsv ts_regexp_adapter_object_test_tsv(tsv re, tsv input){
  require_regexp(re, "RegExp.prototype.test");
  if (ts_is_str(input)){
    capsbuf cb; caps_init_n(&cb, as_re(re)->ncaps);
    int m = builtin_exec(re, input, cb.v);
    caps_free(&cb);
    return ts_bool(m);
  }
  ts_gc_root(&re); ts_gc_root(&input);
  tsv s = to_str(input); ts_gc_root(&s);
  capsbuf cb; caps_init_n(&cb, as_re(re)->ncaps);
  int m = builtin_exec(re, s, cb.v);
  caps_free(&cb);
  ts_gc_unroot(3);
  return ts_bool(m);
}
/* exec on a string: RegExpBuiltinExec and the result array. No roots of its own: the regexp is read
   before the allocations (builtin_exec roots it itself on the path that runs user code), and
   build_result roots the string while it allocates. */
static tsv exec_result(tsv re, tsv s){
  capsbuf cb; caps_init_n(&cb, as_re(re)->ncaps);
  int m = builtin_exec(re, s, cb.v);
  tsv r = m ? build_result(s, cb.v, as_re(re)->prog) : TS_NULL;
  caps_free(&cb);
  return r;
}
tsv ts_regexp_adapter_object_exec_tsv(tsv re, tsv input){
  require_regexp(re, "RegExp.prototype.exec");
  if (ts_is_str(input)) return exec_result(re, input);
  ts_gc_root(&re); ts_gc_root(&input);
  tsv s = to_str(input); ts_gc_root(&s);
  tsv r = exec_result(re, s);
  ts_gc_unroot(3);
  return r;
}
/* @@search: lastIndex saved and restored around a match from 0 */
double ts_regexp_adapter_object_search_tsv(tsv input, tsv re){
  require_regexp(re, "RegExp.prototype[Symbol.search]");
  ts_gc_root(&re); ts_gc_root(&input);
  tsv s = to_str(input); ts_gc_root(&s);
  tsv saved = ts_get_ic(re, k_lastIndex, &g_ic_last); ts_gc_root(&saved);
  last_index_set(re, 0);
  capsbuf cb; caps_init(&cb, as_re(re)->prog);
  int m = builtin_exec(re, s, cb.v);
  double r = m ? (double)cb.v[0] : -1.0;
  caps_free(&cb);
  ts_set_ic(re, k_lastIndex, saved, &g_ic_last);
  ts_gc_unroot(4);
  return r;
}
/* @@match: one exec, or the array of every match for a global regexp */
tsv ts_regexp_adapter_object_match_tsv(tsv input, tsv re){
  require_regexp(re, "RegExp.prototype[Symbol.match]");
  uint32_t flags = as_re(re)->flags;
  if (!(flags & TSAOT_REGEXP_FLAG_GLOBAL) && ts_is_str(input)) return exec_result(re, input);   /* `path.match(re)`: no roots */
  ts_gc_root(&re); ts_gc_root(&input);
  tsv s = to_str(input); ts_gc_root(&s);
  if (!(flags & TSAOT_REGEXP_FLAG_GLOBAL)){
    tsv r = exec_result(re, s);
    ts_gc_unroot(3);
    return r;
  }
  int unicode = (flags & (TSAOT_REGEXP_FLAG_UNICODE | TSAOT_REGEXP_FLAG_UNICODE_SETS)) != 0;
  last_index_set(re, 0);
  tsv arr = ts_new_array(0); ts_gc_root(&arr);
  capsbuf cb; caps_init(&cb, as_re(re)->prog);
  uint32_t n = 0;
  for (;;){
    if (!builtin_exec(re, s, cb.v)) break;
    tsv part = slice(s, cb.v[0], cb.v[1]); ts_gc_root(&part);
    ts_array_push(arr, part); ts_gc_unroot(1); n++;
    if (cb.v[0] == cb.v[1]) last_index_set(re, advance_index(s, last_index_get(re), unicode));
  }
  caps_free(&cb);
  ts_gc_unroot(4);
  return n ? arr : TS_NULL;
}

/* @@matchAll: an iterator over a clone of the regexp (its own lastIndex) */
static tsv match_all_next(tsv* args, int nargs){
  keys_init();
  tsv iter = nargs > 0 ? args[0] : TS_UNDEFINED;
  if (!ts_is_obj(iter) || ts_truthy(ts_get(iter, k_iter_done))) return ts_iter_result(TS_UNDEFINED, 1);
  ts_gc_root(&iter);
  tsv re = ts_get(iter, k_iter_re); ts_gc_root(&re);
  tsv s = ts_get(iter, k_iter_input); ts_gc_root(&s);
  if (!ts_is_regexp(re) || !ts_is_str(s)){ ts_set(iter, k_iter_done, ts_bool(1)); ts_gc_unroot(3); return ts_iter_result(TS_UNDEFINED, 1); }
  uint32_t flags = as_re(re)->flags;
  capsbuf cb; caps_init(&cb, as_re(re)->prog);
  if (!builtin_exec(re, s, cb.v)){
    caps_free(&cb);
    ts_set(iter, k_iter_done, ts_bool(1));
    ts_gc_unroot(3);
    return ts_iter_result(TS_UNDEFINED, 1);
  }
  tsv match = build_result(s, cb.v, as_re(re)->prog); ts_gc_root(&match);
  if (flags & TSAOT_REGEXP_FLAG_GLOBAL){
    if (cb.v[0] == cb.v[1]){
      int unicode = (flags & (TSAOT_REGEXP_FLAG_UNICODE | TSAOT_REGEXP_FLAG_UNICODE_SETS)) != 0;
      last_index_set(re, advance_index(s, last_index_get(re), unicode));
    }
  } else ts_set(iter, k_iter_done, ts_bool(1));
  caps_free(&cb);
  tsv r = ts_iter_result(match, 0);
  ts_gc_unroot(4);
  return r;
}
static tsv match_all_self(tsv* args, int nargs){ return nargs > 0 ? args[0] : TS_UNDEFINED; }
/* %RegExpStringIteratorPrototype%: `next` and [Symbol.iterator] once, on a shared prototype;
   an iterator is one layout allocation holding the clone, the input and the done flag */
static tsv g_iter_proto = 0; static int g_iter_proto_rooted;
static ts_key g_iter_keys[3];
static ts_lit_layout g_iter_layout = { 0, 3, g_iter_keys, NULL };
static void iter_proto_init(void){
  if (g_iter_proto) return;
  keys_init();
  g_iter_keys[0] = k_iter_re; g_iter_keys[1] = k_iter_input; g_iter_keys[2] = k_iter_done;
  tsv proto = ts_new_object(); ts_gc_root(&proto);
  tsv next_fn = ts_make_fn_t(match_all_next, NULL, 0, 1); ts_gc_root(&next_fn);
  ts_set_fn_meta(next_fn, 0, "next");
  tsv self_fn = ts_make_fn_t(match_all_self, NULL, 0, 1); ts_gc_root(&self_fn);
  ts_set_fn_meta(self_fn, 0, "[Symbol.iterator]");
  ts_set(proto, k_next, next_fn);
  ts_set(proto, TS_KEY_WKSYM(TS_WKSYM_ITERATOR), self_fn);
  ts_gc_unroot(3);
  g_iter_proto = proto;
  ts_gc_root_static(&g_iter_proto, &g_iter_proto_rooted);
}
tsv ts_regexp_adapter_object_match_all_tsv(tsv input, tsv re){
  keys_init();
  require_regexp(re, "RegExp.prototype[Symbol.matchAll]");
  if (!(as_re(re)->flags & TSAOT_REGEXP_FLAG_GLOBAL)) ts_throw_type_error_msg("String.prototype.matchAll called with a non-global RegExp argument");
  iter_proto_init();
  ts_gc_root(&re); ts_gc_root(&input);
  tsv s = to_str(input); ts_gc_root(&s);
  ts_regexp* r = as_re(re);
  tsv clone = regexp_make(r->prog, r->source, r->flags); ts_gc_root(&clone);
  last_index_set(clone, last_index_get(re));
  tsv iter = ts_new_object_layout(&g_iter_layout); ts_gc_root(&iter);
  ((ts_object*)ts_ptr(iter))->proto = g_iter_proto;
  ts_lit_store(iter, 0, clone);
  ts_lit_store(iter, 1, s);
  ts_lit_store(iter, 2, ts_bool(0));
  ts_gc_unroot(5);
  return iter;
}

/* ---- @@replace ---- */
/* GetSubstitution: the replacement template expanded for one match into the builder */
static tsv expand_template(tsv out, tsv s, tsv rep, const int32_t* caps, rx_program* p){
  uint32_t ng = rx_group_count(p);
  ts_gc_root(&s); ts_gc_root(&rep); ts_gc_root(&out);
  ts_strview rv = ts_str_view_typed(rep);
  uint32_t n = rv.len, i = 0, lit_start = 0;
  /* ts_sb_append roots its arguments; the replacement's view is re-read after each (it may move) */
  #define FLUSH(to) do { if ((to) > lit_start){ out = ts_sb_append(out, substr(rep, lit_start, (to) - lit_start)); rv = ts_str_view_typed(rep); } } while (0)
  #define APPEND(v) do { out = ts_sb_append(out, (v)); rv = ts_str_view_typed(rep); } while (0)
  while (i < n){
    uint16_t c = ts_str_cu_at_view(rv, i);
    if (c != '$' || i + 1 >= n){ i++; continue; }
    uint16_t d = ts_str_cu_at_view(rv, i + 1);
    if (d == '$'){ FLUSH(i); APPEND(ts_new_string("$", 1)); i += 2; lit_start = i; continue; }
    if (d == '&'){ FLUSH(i); APPEND(slice(s, caps[0], caps[1])); i += 2; lit_start = i; continue; }
    if (d == '`'){ FLUSH(i); APPEND(substr(s, 0, (uint32_t)caps[0])); i += 2; lit_start = i; continue; }
    if (d == '\''){ FLUSH(i); uint32_t len = ts_str_len_typed(s); APPEND(substr(s, (uint32_t)caps[1], len - (uint32_t)caps[1])); i += 2; lit_start = i; continue; }
    if (d >= '0' && d <= '9'){
      uint32_t d1 = d - '0';
      uint32_t two = 0; int has_two = 0;
      if (i + 2 < n){ uint16_t e = ts_str_cu_at_view(rv, i + 2); if (e >= '0' && e <= '9'){ two = d1 * 10 + (e - '0'); has_two = 1; } }
      uint32_t g = 0, consumed = 0;
      if (has_two && two >= 1 && two <= ng){ g = two; consumed = 3; }
      else if (d1 >= 1 && d1 <= ng){ g = d1; consumed = 2; }
      if (consumed){
        FLUSH(i);
        if (caps[2*g] >= 0) APPEND(slice(s, caps[2*g], caps[2*g+1]));
        i += consumed; lit_start = i; continue;
      }
      i++; continue;
    }
    if (d == '<' && rx_has_named_groups(p)){
      uint32_t close = i + 2;
      while (close < n && ts_str_cu_at_view(rv, close) != '>') close++;
      if (close >= n){ i++; continue; }
      FLUSH(i);
      /* the named group: compare the name's units with the groups' names */
      uint32_t nl = close - (i + 2);
      uint16_t small[64]; uint16_t* name = nl <= 64 ? small : (uint16_t*)malloc(sizeof(uint16_t) * nl);
      for (uint32_t k = 0; k < nl; k++) name[k] = ts_str_cu_at_view(rv, i + 2 + k);
      for (uint32_t g = 1; g <= ng; g++){
        uint32_t gl; const uint16_t* gn = rx_group_name(p, g, &gl);
        if (gn && gl == nl && memcmp(gn, name, sizeof(uint16_t) * nl) == 0 && caps[2*g] >= 0){ APPEND(slice(s, caps[2*g], caps[2*g+1])); break; }
      }
      if (name != small) free(name);
      i = close + 1; lit_start = i; continue;
    }
    i++;
  }
  FLUSH(n);
  #undef FLUSH
  #undef APPEND
  ts_gc_unroot(3);
  return out;
}
static tsv call_replacer(tsv s, tsv fn, const int32_t* caps, rx_program* p){
  uint32_t ng = rx_group_count(p);
  int named = rx_has_named_groups(p);
  uint32_t nargs = ng + 1 + 2 + (named ? 1u : 0u);
  tsv small[16]; tsv* args = nargs <= 16 ? small : (tsv*)malloc(sizeof(tsv) * nargs);
  if (!args) abort();
  ts_gc_root(&s); ts_gc_root(&fn);
  for (uint32_t i = 0; i < nargs; i++) args[i] = TS_UNDEFINED;
  for (uint32_t i = 0; i < nargs; i++) ts_gc_root(&args[i]);
  for (uint32_t g = 0; g <= ng; g++) args[g] = caps[2*g] >= 0 ? slice(s, caps[2*g], caps[2*g+1]) : TS_UNDEFINED;
  args[ng + 1] = ts_num(caps[0]);
  args[ng + 2] = s;
  if (named){
    /* the groups object from the captures already sliced: a temporary array holds them */
    tsv tmp = ts_new_array(0); ts_gc_root(&tmp);
    for (uint32_t g = 0; g <= ng; g++) ts_array_push(tmp, args[g]);
    args[ng + 3] = build_groups(tmp, caps, p);
    ts_gc_unroot(1);
  }
  tsv r = ts_call_value(fn, args, (int)nargs);
  ts_gc_root(&r);
  tsv rs = to_str(r);
  ts_gc_unroot((int)nargs + 3);
  if (args != small) free(args);
  return rs;
}
tsv ts_regexp_adapter_object_replace_tsv(tsv input, tsv re, tsv replacement, int replace_all_method){
  require_regexp(re, "RegExp.prototype[Symbol.replace]");
  uint32_t flags = as_re(re)->flags;
  int global = (flags & TSAOT_REGEXP_FLAG_GLOBAL) != 0;
  if (replace_all_method && !global) ts_throw_type_error_msg("replaceAll must be called with a global RegExp");
  ts_gc_root(&re); ts_gc_root(&input); ts_gc_root(&replacement);
  tsv s = to_str(input); ts_gc_root(&s);
  int fn_rep = ts_is_callable(replacement);
  tsv rep = fn_rep ? replacement : to_str(replacement); ts_gc_root(&rep);
  int unicode = (flags & (TSAOT_REGEXP_FLAG_UNICODE | TSAOT_REGEXP_FLAG_UNICODE_SETS)) != 0;
  rx_program* p = as_re(re)->prog;
  if (global) last_index_set(re, 0);
  capsbuf cb; caps_init(&cb, p);
  tsv out = TS_UNDEFINED; ts_gc_root(&out);
  uint32_t next_source = 0; int any = 0;
  for (;;){
    if (!builtin_exec(re, s, cb.v)) break;
    if (!any){ out = ts_sb_new(ts_new_string("", 0)); any = 1; }
    uint32_t ms = (uint32_t)cb.v[0], me = (uint32_t)cb.v[1];
    if (ms >= next_source){
      if (ms > next_source) out = ts_sb_append(out, substr(s, next_source, ms - next_source));
      if (fn_rep) out = ts_sb_append(out, call_replacer(s, rep, cb.v, p));
      else out = expand_template(out, s, rep, cb.v, p);
      next_source = me;
    }
    if (!global) break;
    if (ms == me) last_index_set(re, advance_index(s, last_index_get(re), unicode));
  }
  caps_free(&cb);
  if (!any){ ts_gc_unroot(6); return s; }
  uint32_t len = ts_str_len_typed(s);
  if (next_source < len) out = ts_sb_append(out, substr(s, next_source, len - next_source));
  tsv result = ts_sb_finish(out);
  ts_gc_unroot(6);
  return result;
}

/* ---- @@split ----
   V8's loop rather than the specification's sticky walk: a search from the last split point
   (the scan is unit-wise, so a zero-width match inside a surrogate pair splits it as V8 does:
   "a\ud83d\ude00b".split(/\B/u)); an empty match at the last split end advances by a character. */
tsv ts_regexp_adapter_object_split_tsv(tsv input, tsv re, tsv limit){
  require_regexp(re, "RegExp.prototype[Symbol.split]");
  ts_gc_root(&re); ts_gc_root(&input); ts_gc_root(&limit);
  tsv s = to_str(input); ts_gc_root(&s);
  uint32_t lim = limit == TS_UNDEFINED ? 0xFFFFFFFFu : (uint32_t)(int64_t)ts_number_coerce(limit);
  tsv arr = ts_new_array(0); ts_gc_root(&arr);
  if (lim == 0){ ts_gc_unroot(5); return arr; }
  ts_regexp* r = as_re(re);
  uint32_t flags = r->flags & ~(uint32_t)(TSAOT_REGEXP_FLAG_STICKY | TSAOT_REGEXP_FLAG_GLOBAL);
  int unicode = (flags & (TSAOT_REGEXP_FLAG_UNICODE | TSAOT_REGEXP_FLAG_UNICODE_SETS)) != 0;
  /* the regexp's own program searches (the global flag does not reach the engine); a sticky one
     needs the search form compiled */
  rx_program* p = (r->flags & TSAOT_REGEXP_FLAG_STICKY) ? compile_pattern(r->source, flags, NULL, NULL) : r->prog;
  rx_retain(p);
  uint32_t ng = rx_group_count(p);
  capsbuf cb; caps_init(&cb, p);
  uint32_t size = ts_str_len_typed(s);
  uint32_t count = 0;
  if (size == 0){
    int m = exec_string(p, s, 0, cb.v);
    if (!m) ts_array_push(arr, s);
    caps_free(&cb); rx_release(p);
    ts_gc_unroot(5);
    return arr;
  }
  /* a sticky regexp: the specification's walk (a sticky match at every position q, q advancing
     by a character); V8's sticky split never sees the middle of a pair */
  int sticky = (r->flags & TSAOT_REGEXP_FLAG_STICKY) != 0;
  rx_program* ps = sticky ? compile_pattern(r->source, flags | TSAOT_REGEXP_FLAG_STICKY, NULL, NULL) : NULL;
  if (ps) rx_retain(ps);
  uint32_t last_end = 0, from = 0;
  while (from < size){
    int m;
    uint32_t ms, me;
    if (sticky){
      m = exec_string(ps, s, from, cb.v);
      if (!m){ from = advance_index(s, from, unicode); continue; }
      ms = (uint32_t)cb.v[0]; me = (uint32_t)cb.v[1];
      if (me > size) me = size;
      if (me == last_end){ from = advance_index(s, from, unicode); continue; }
    } else {
      m = exec_string(p, s, from, cb.v);
      if (!m) break;
      ms = (uint32_t)cb.v[0]; me = (uint32_t)cb.v[1];
      if (ms >= size) break;
      if (me == last_end){ from = advance_index(s, ms > from ? ms : from, unicode); continue; }
    }
    tsv piece = substr(s, last_end, ms - last_end); ts_gc_root(&piece);
    ts_array_push(arr, piece); ts_gc_unroot(1);
    if (++count == lim){ caps_free(&cb); rx_release(p); if (ps) rx_release(ps); ts_gc_unroot(5); return arr; }
    last_end = me;
    for (uint32_t g = 1; g <= ng; g++){
      tsv cap = cb.v[2*g] >= 0 ? slice(s, cb.v[2*g], cb.v[2*g+1]) : TS_UNDEFINED; ts_gc_root(&cap);
      ts_array_push(arr, cap); ts_gc_unroot(1);
      if (++count == lim){ caps_free(&cb); rx_release(p); if (ps) rx_release(ps); ts_gc_unroot(5); return arr; }
    }
    from = me;
  }
  tsv tail = substr(s, last_end, size - last_end); ts_gc_root(&tail);
  ts_array_push(arr, tail); ts_gc_unroot(1);
  caps_free(&cb); rx_release(p); if (ps) rx_release(ps);
  ts_gc_unroot(5);
  return arr;
}

/* ---- the constructor ---- */
static uint32_t parse_flags_or_throw(tsv flags_str){
  ts_strview v = ts_str_view_typed(flags_str);
  uint32_t mask = 0;
  for (uint32_t i = 0; i < v.len; i++){
    uint32_t c = ts_str_cu_at_view(v, i), bit = 0;
    switch (c){
      case 'd': bit = TSAOT_REGEXP_FLAG_INDICES; break; case 'g': bit = TSAOT_REGEXP_FLAG_GLOBAL; break;
      case 'i': bit = TSAOT_REGEXP_FLAG_IGNORECASE; break; case 'm': bit = TSAOT_REGEXP_FLAG_MULTILINE; break;
      case 's': bit = TSAOT_REGEXP_FLAG_DOTALL; break; case 'u': bit = TSAOT_REGEXP_FLAG_UNICODE; break;
      case 'v': bit = TSAOT_REGEXP_FLAG_UNICODE_SETS; break; case 'y': bit = TSAOT_REGEXP_FLAG_STICKY; break;
      default: bit = 0; break;
    }
    if (!bit || (mask & bit)) goto bad;
    mask |= bit;
  }
  if ((mask & TSAOT_REGEXP_FLAG_UNICODE) && (mask & TSAOT_REGEXP_FLAG_UNICODE_SETS)) goto bad;
  return mask;
bad: {
    char msg[200]; uint32_t n = 0; char* f = ts_string_utf8_copy(flags_str, &n);
    snprintf(msg, sizeof msg, "Invalid flags supplied to RegExp constructor '%.*s'", (int)(n > 120 ? 120 : n), f);
    free(f);
    ts_throw_syntax_error_msg(msg);
    return 0;
  }
}
tsv ts_regexp_adapter_construct_tsv(tsv pattern, tsv flags, int as_constructor){
  keys_init();
  if (ts_is_symbol(pattern) || ts_is_symbol(flags)) ts_throw_type_error_msg("Cannot convert a Symbol value to a string");
  ts_gc_root(&pattern); ts_gc_root(&flags);
  if (ts_is_regexp(pattern)){
    if (flags == TS_UNDEFINED && !as_constructor){ ts_gc_unroot(2); return pattern; }
    ts_regexp* r = as_re(pattern);
    tsv source = r->source; uint32_t mask = r->flags;
    ts_gc_root(&source);
    if (flags != TS_UNDEFINED){ tsv fs = to_str(flags); ts_gc_root(&fs); mask = parse_flags_or_throw(fs); ts_gc_unroot(1); }
    tsv re = ts_regexp_new_literal(source, mask, NULL, NULL);
    ts_gc_unroot(3);
    return re;
  }
  tsv source = pattern == TS_UNDEFINED ? ts_new_string("", 0) : to_str(pattern);
  ts_gc_root(&source);
  uint32_t mask = 0;
  if (flags != TS_UNDEFINED){ tsv fs = to_str(flags); ts_gc_root(&fs); mask = parse_flags_or_throw(fs); ts_gc_unroot(1); }
  tsv re = ts_regexp_new_literal(source, mask, NULL, NULL);
  ts_gc_unroot(3);
  return re;
}
static tsv construct_from_string(tsv pattern, tsv flags){ return ts_regexp_adapter_construct_tsv(pattern, flags, 1); }

/* ---- source / flags / toString ---- */
static tsv source_text(tsv re){
  ts_regexp* r = as_re(re);
  ts_gc_root(&re);
  units un; units_of(r->source, &un);
  uint32_t need = rx_escape_source(un.u, un.n, NULL, 0);
  uint16_t* buf = (uint16_t*)malloc(sizeof(uint16_t) * (need ? need : 1));
  if (!buf) abort();
  rx_escape_source(un.u, un.n, buf, need);
  units_free(&un);
  tsv s = ts_string_from_code_units(buf, need);
  free(buf);
  ts_gc_unroot(1);
  return s;
}
static tsv flags_string(tsv re){ char fl[9]; flags_text(as_re(re)->flags, fl); return ts_new_string(fl, (uint32_t)strlen(fl)); }
tsv ts_regexp_adapter_to_string_tsv(tsv re){
  ts_gc_root(&re);
  tsv out = ts_sb_new(ts_new_string("/", 1)); ts_gc_root(&out);
  tsv src = source_text(re); ts_gc_root(&src);
  out = ts_sb_append(out, src);
  out = ts_sb_append(out, ts_new_string("/", 1));
  tsv fl = flags_string(re); ts_gc_root(&fl);
  out = ts_sb_append(out, fl);
  tsv r = ts_sb_finish(out);
  ts_gc_unroot(4);
  return r;
}
/* RegExp.prototype accessors: `this` is args[0] */
static tsv this_regexp(tsv* args, int nargs, const char* name){
  tsv t = nargs > 0 ? args[0] : TS_UNDEFINED;
  if (ts_is_regexp(t)) return t;
  if (t == ts_regexp_proto()) return TS_UNDEFINED;   /* the prototype itself: "(?:)" / "" / undefined */
  char msg[160]; snprintf(msg, sizeof msg, "RegExp.prototype.%s getter called on non-RegExp object", name);
  ts_throw_type_error_msg(msg);
  return TS_UNDEFINED;
}
static tsv get_source(tsv* a, int n){ tsv t = this_regexp(a, n, "source"); return t == TS_UNDEFINED ? ts_new_string("(?:)", 4) : source_text(t); }
static tsv get_flags(tsv* a, int n){ tsv t = this_regexp(a, n, "flags"); return t == TS_UNDEFINED ? ts_new_string("", 0) : flags_string(t); }
#define FLAG_GETTER(fname, bit, pname) static tsv fname(tsv* a, int n){ tsv t = this_regexp(a, n, pname); return t == TS_UNDEFINED ? TS_UNDEFINED : ts_bool((as_re(t)->flags & (bit)) != 0); }
FLAG_GETTER(get_global, TSAOT_REGEXP_FLAG_GLOBAL, "global")
FLAG_GETTER(get_ignoreCase, TSAOT_REGEXP_FLAG_IGNORECASE, "ignoreCase")
FLAG_GETTER(get_multiline, TSAOT_REGEXP_FLAG_MULTILINE, "multiline")
FLAG_GETTER(get_dotAll, TSAOT_REGEXP_FLAG_DOTALL, "dotAll")
FLAG_GETTER(get_unicode, TSAOT_REGEXP_FLAG_UNICODE, "unicode")
FLAG_GETTER(get_unicodeSets, TSAOT_REGEXP_FLAG_UNICODE_SETS, "unicodeSets")
FLAG_GETTER(get_sticky, TSAOT_REGEXP_FLAG_STICKY, "sticky")
FLAG_GETTER(get_hasIndices, TSAOT_REGEXP_FLAG_INDICES, "hasIndices")
static void define_getter(tsv proto, const char* name, ts_code fn){
  ts_gc_root(&proto);
  tsv f = ts_make_fn_t(fn, NULL, 0, 1); ts_gc_root(&f);
  char label[48]; snprintf(label, sizeof label, "get %s", name);
  ts_set_fn_meta(f, 0, label);
  ts_define_accessor_attr(proto, ts_intern_field(name, (uint32_t)strlen(name)), f, TS_UNDEFINED, 1, 0, 0, 1);
  ts_gc_unroot(2);
}

/* ---- RegExp.escape ---- */
tsv ts_regexp_escape_tsv(tsv v){
  if (!ts_is_str(v)) ts_throw_type_error_msg("RegExp.escape requires a string argument");
  ts_gc_root(&v);
  ts_strview sv = ts_str_view_typed(v);
  uint32_t n = sv.len;
  uint16_t* out = (uint16_t*)malloc(sizeof(uint16_t) * ((size_t)n * 6u + 1u)); uint32_t k = 0;
  if (!out) abort();
  static const char hexd[] = "0123456789abcdef";
  for (uint32_t i = 0; i < n; i++){
    uint32_t c = ts_str_cu_at_view(sv, i);
    int first = i == 0;
    int alnum = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
    int syntax = c == '^' || c == '$' || c == '\\' || c == '.' || c == '*' || c == '+' || c == '?' || c == '(' || c == ')' || c == '[' || c == ']' || c == '{' || c == '}' || c == '|' || c == '/';
    int punct = c == ',' || c == '-' || c == '=' || c == '<' || c == '>' || c == '#' || c == '&' || c == '!' || c == '%' || c == ':' || c == ';' || c == '@' || c == '~' || c == '\'' || c == '`' || c == '"';
    int ws = c == 9 || c == 0x0B || c == 0x0C || c == 0x20 || c == 0xA0 || c == 0xFEFF || c == 0x1680 || (c >= 0x2000 && c <= 0x200A) || c == 0x202F || c == 0x205F || c == 0x3000 || c == 0x0A || c == 0x0D || c == 0x2028 || c == 0x2029;
    int lone = (c >= 0xD800u && c <= 0xDFFFu) &&
      !((c <= 0xDBFFu && i + 1 < n && ts_str_cu_at_view(sv, i + 1) >= 0xDC00u && ts_str_cu_at_view(sv, i + 1) <= 0xDFFFu) ||
        (c >= 0xDC00u && i > 0 && ts_str_cu_at_view(sv, i - 1) >= 0xD800u && ts_str_cu_at_view(sv, i - 1) <= 0xDBFFu));
    if ((first && alnum) || (punct && c < 0x80) || (ws && c < 0x100) ){
      out[k++] = '\\'; out[k++] = 'x'; out[k++] = (uint16_t)hexd[(c >> 4) & 15]; out[k++] = (uint16_t)hexd[c & 15];
    } else if (syntax){
      out[k++] = '\\'; out[k++] = (uint16_t)c;
    } else if (ws || lone){
      out[k++] = '\\'; out[k++] = 'u';
      out[k++] = (uint16_t)hexd[(c >> 12) & 15]; out[k++] = (uint16_t)hexd[(c >> 8) & 15]; out[k++] = (uint16_t)hexd[(c >> 4) & 15]; out[k++] = (uint16_t)hexd[c & 15];
    } else out[k++] = (uint16_t)c;
  }
  tsv r = ts_string_from_code_units(out, k);
  free(out);
  ts_gc_unroot(1);
  return r;
}

/* ---- init: the prototype's accessors and the runtime hooks ---- */
static const ts_regexp_hooks g_hooks = {
  ts_regexp_adapter_to_string_tsv,
  ts_regexp_adapter_object_replace_tsv,
  ts_regexp_adapter_object_split_tsv,
  ts_regexp_adapter_object_match_tsv,
  ts_regexp_adapter_object_match_all_tsv,
  ts_regexp_adapter_object_search_tsv,
  construct_from_string,
  release_program,
};
void ts_regexp_adapter_init(void){
  static int done = 0;
  if (done) return;
  done = 1;
  const char* nat = getenv("TSAOT_REGEXP_NATIVE");
  g_native_off = nat && (strcmp(nat, "0") == 0 || strcmp(nat, "false") == 0 || strcmp(nat, "no") == 0 || strcmp(nat, "off") == 0);
  const char* rec = getenv("TSAOT_REGEXP_RECORD");
  if (rec && *rec) g_record = fopen(rec, "a");
  g_trace = getenv("TSAOT_REGEXP_TRACE") != NULL;
  keys_init();
  ts_regexp_proto_init();
  tsv proto = ts_regexp_proto();
  define_getter(proto, "source", get_source);
  define_getter(proto, "flags", get_flags);
  define_getter(proto, "global", get_global);
  define_getter(proto, "ignoreCase", get_ignoreCase);
  define_getter(proto, "multiline", get_multiline);
  define_getter(proto, "dotAll", get_dotAll);
  define_getter(proto, "unicode", get_unicode);
  define_getter(proto, "unicodeSets", get_unicodeSets);
  define_getter(proto, "sticky", get_sticky);
  define_getter(proto, "hasIndices", get_hasIndices);
  ts_regexp_hooks_install(&g_hooks);
}
