#include "json_core.h"

#include <ctype.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct tjson_arena_chunk {
  struct tjson_arena_chunk* next;
  size_t used;
  size_t cap;
  char data[];
} tjson_arena_chunk;

struct tjson_doc {
  char* input;
  uint32_t input_len;
  tjson_arena_chunk* chunks;
  tjson_value* root;
};

typedef struct {
  char* p;
  size_t len;
  size_t cap;
} tjbuf;

typedef struct {
  tjson_doc* doc;
  const char* s;
  size_t i;
  size_t n;
  int ok;
} tjparse;

static void* tj_xmalloc(size_t n){
  void* p = malloc(n ? n : 1);
  if (!p){ fprintf(stderr, "tsaot: json_core: out of memory\n"); abort(); }
  return p;
}

static void* tj_xrealloc(void* old, size_t n){
  void* p = realloc(old, n ? n : 1);
  if (!p){ fprintf(stderr, "tsaot: json_core: out of memory\n"); abort(); }
  return p;
}

/* Arena chunks of the default size are recycled through a small free list rather
   than malloc/free'd on every parse. JSON.parse is overwhelmingly called on small
   documents in tight loops, where a fresh 16 KiB chunk per call dominates the
   cost. The pool is process-global and single-threaded (matching the runtime's
   GC), so no locking is needed. */
#define TJ_CHUNK_CAP 16384u
#define TJ_POOL_MAX 8
static tjson_arena_chunk* g_tj_chunk_pool = NULL;
static int g_tj_chunk_pool_n = 0;

/* Pop the first pooled chunk large enough for `cap`; otherwise malloc one. */
static tjson_arena_chunk* tj_chunk_get(size_t cap){
  tjson_arena_chunk** pp = &g_tj_chunk_pool;
  while (*pp){
    if ((*pp)->cap >= cap){
      tjson_arena_chunk* c = *pp;
      *pp = c->next;
      g_tj_chunk_pool_n--;
      return c;
    }
    pp = &(*pp)->next;
  }
  tjson_arena_chunk* c = (tjson_arena_chunk*)tj_xmalloc(sizeof(tjson_arena_chunk) + cap);
  c->cap = cap;
  return c;
}
static void tj_chunk_put(tjson_arena_chunk* c){
  if (g_tj_chunk_pool_n < TJ_POOL_MAX){
    c->next = g_tj_chunk_pool;
    g_tj_chunk_pool = c;
    g_tj_chunk_pool_n++;
  } else {
    free(c);
  }
}

static void* tj_arena_alloc(tjson_doc* doc, size_t n, size_t align){
  if (align < sizeof(void*)) align = sizeof(void*);
  n = (n + align - 1u) & ~(align - 1u);
  tjson_arena_chunk* c = doc->chunks;
  if (!c || n > c->cap - c->used){
    size_t cap;
    if (!doc->chunks){
      /* First chunk: size it to the input. The arena DOM is roughly proportional
         to the source length, so a per-input estimate avoids burning a full
         16 KiB block on the small documents that dominate JSON.parse loops. */
      cap = (size_t)doc->input_len * 4u + 256u;
      if (cap > TJ_CHUNK_CAP) cap = TJ_CHUNK_CAP;
    } else {
      cap = TJ_CHUNK_CAP;
    }
    while (cap < n) cap *= 2u;
    c = tj_chunk_get(cap);
    c->next = doc->chunks;
    c->used = 0;
    doc->chunks = c;
  }
  void* p = c->data + c->used;
  c->used += n;
  return p;
}

static void* tj_arena_copy(tjson_doc* doc, const void* src, size_t n){
  char* p = (char*)tj_arena_alloc(doc, n ? n : 1, 1);
  if (n) memcpy(p, src, n);
  return p;
}

static tjson_value* tj_new_value(tjparse* p, tjson_kind kind){
  tjson_value* v = (tjson_value*)tj_arena_alloc(p->doc, sizeof(tjson_value), sizeof(void*));
  memset(v, 0, sizeof(*v));
  v->kind = kind;
  v->doc = p->doc;
  return v;
}

static void tj_ws(tjparse* p){
  while (p->i < p->n){
    char c = p->s[p->i];
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r') p->i++;
    else break;
  }
}

static void tj_buf_init(tjbuf* b){
  b->cap = 256;
  b->len = 0;
  b->p = (char*)tj_xmalloc(b->cap);
}

static void tj_buf_reserve(tjbuf* b, size_t add){
  if (add <= b->cap - b->len) return;
  size_t nc = b->cap;
  while (add > nc - b->len) nc *= 2u;
  b->p = (char*)tj_xrealloc(b->p, nc);
  b->cap = nc;
}

static void tj_buf_putc(tjbuf* b, char c){
  tj_buf_reserve(b, 1);
  b->p[b->len++] = c;
}

static void tj_buf_puts(tjbuf* b, const char* s, size_t n){
  tj_buf_reserve(b, n);
  memcpy(b->p + b->len, s, n);
  b->len += n;
}

static void tj_buf_putz(tjbuf* b, const char* s){
  tj_buf_puts(b, s, strlen(s));
}

static void tj_put_utf8(tjbuf* b, uint32_t cp){
  if (cp > 0x10FFFFu || (cp >= 0xD800u && cp <= 0xDFFFu)) cp = 0xFFFDu;
  if (cp < 0x80u) tj_buf_putc(b, (char)cp);
  else if (cp < 0x800u){
    tj_buf_putc(b, (char)(0xC0u | (cp >> 6)));
    tj_buf_putc(b, (char)(0x80u | (cp & 0x3Fu)));
  } else if (cp < 0x10000u){
    tj_buf_putc(b, (char)(0xE0u | (cp >> 12)));
    tj_buf_putc(b, (char)(0x80u | ((cp >> 6) & 0x3Fu)));
    tj_buf_putc(b, (char)(0x80u | (cp & 0x3Fu)));
  } else {
    tj_buf_putc(b, (char)(0xF0u | (cp >> 18)));
    tj_buf_putc(b, (char)(0x80u | ((cp >> 12) & 0x3Fu)));
    tj_buf_putc(b, (char)(0x80u | ((cp >> 6) & 0x3Fu)));
    tj_buf_putc(b, (char)(0x80u | (cp & 0x3Fu)));
  }
}

static int tj_hex4(const char* s, size_t n, size_t i, uint32_t* out){
  if (i + 4 > n) return 0;
  uint32_t v = 0;
  for (size_t k=0;k<4;k++){
    unsigned char c = (unsigned char)s[i+k];
    uint32_t d;
    if (c >= '0' && c <= '9') d = (uint32_t)(c - '0');
    else if (c >= 'a' && c <= 'f') d = 10u + (uint32_t)(c - 'a');
    else if (c >= 'A' && c <= 'F') d = 10u + (uint32_t)(c - 'A');
    else return 0;
    v = (v << 4) | d;
  }
  *out = v;
  return 1;
}

static int tj_string(tjparse* p, tjson_string* out){
  if (p->i >= p->n || p->s[p->i] != '"'){ p->ok = 0; return 0; }
  size_t start = ++p->i;
  size_t j = start;
  while (j < p->n){
    unsigned char c = (unsigned char)p->s[j];
    if (c == '"'){
      out->data = p->s + start;
      out->len = (uint32_t)(j - start);
      p->i = j + 1;
      return 1;
    }
    if (c == '\\') break;
    if (c < 0x20u){ p->ok = 0; return 0; }
    j++;
  }

  p->i = start;
  tjbuf b; tj_buf_init(&b);
  while (p->i < p->n){
    unsigned char c = (unsigned char)p->s[p->i++];
    if (c == '"'){
      out->data = (const char*)tj_arena_copy(p->doc, b.p, b.len);
      out->len = (uint32_t)b.len;
      free(b.p);
      return 1;
    }
    if (c < 0x20u){ free(b.p); p->ok = 0; return 0; }
    if (c != '\\'){ tj_buf_putc(&b, (char)c); continue; }
    if (p->i >= p->n){ free(b.p); p->ok = 0; return 0; }
    char e = p->s[p->i++];
    switch (e){
      case '"': tj_buf_putc(&b, '"'); break;
      case '\\': tj_buf_putc(&b, '\\'); break;
      case '/': tj_buf_putc(&b, '/'); break;
      case 'b': tj_buf_putc(&b, '\b'); break;
      case 'f': tj_buf_putc(&b, '\f'); break;
      case 'n': tj_buf_putc(&b, '\n'); break;
      case 'r': tj_buf_putc(&b, '\r'); break;
      case 't': tj_buf_putc(&b, '\t'); break;
      case 'u': {
        uint32_t cp = 0;
        if (!tj_hex4(p->s, p->n, p->i, &cp)){ free(b.p); p->ok = 0; return 0; }
        p->i += 4;
        if (cp >= 0xD800u && cp <= 0xDBFFu && p->i + 6 <= p->n && p->s[p->i] == '\\' && p->s[p->i+1] == 'u'){
          uint32_t lo = 0;
          if (tj_hex4(p->s, p->n, p->i + 2, &lo) && lo >= 0xDC00u && lo <= 0xDFFFu){
            cp = 0x10000u + (((cp - 0xD800u) << 10) | (lo - 0xDC00u));
            p->i += 6;
          }
        }
        tj_put_utf8(&b, cp);
        break;
      }
      default:
        free(b.p); p->ok = 0; return 0;
    }
  }
  free(b.p);
  p->ok = 0;
  return 0;
}

static tjson_value* tj_value(tjparse* p);
static void tjson_free_value_arrays(tjson_value* v);

static void tj_array_push(tjson_value* arr, tjson_value* elem){
  if (arr->as.array.len == arr->as.array.cap){
    uint32_t nc = arr->as.array.cap ? arr->as.array.cap * 2u : 8u;
    arr->as.array.items = (tjson_value**)tj_xrealloc(arr->as.array.items, sizeof(tjson_value*) * (size_t)nc);
    arr->as.array.cap = nc;
  }
  arr->as.array.items[arr->as.array.len++] = elem;
}

static int tj_key_eq(tjson_string a, tjson_string b){
  return a.len == b.len && (a.len == 0 || memcmp(a.data, b.data, a.len) == 0);
}

static void tj_object_set(tjson_value* obj, tjson_string key, tjson_value* val){
  for (uint32_t i=0;i<obj->as.object.len;i++){
    if (tj_key_eq(obj->as.object.members[i].key, key)){
      tjson_free_value_arrays(obj->as.object.members[i].value);
      obj->as.object.members[i].value = val;
      return;
    }
  }
  if (obj->as.object.len == obj->as.object.cap){
    uint32_t nc = obj->as.object.cap ? obj->as.object.cap * 2u : 8u;
    obj->as.object.members = (tjson_member*)tj_xrealloc(obj->as.object.members, sizeof(tjson_member) * (size_t)nc);
    obj->as.object.cap = nc;
  }
  obj->as.object.members[obj->as.object.len++] = (tjson_member){ key, val };
}

static int tj_number_grammar(tjparse* p, size_t* end_out){
  size_t i = p->i;
  if (i < p->n && p->s[i] == '-') i++;
  if (i >= p->n) return 0;
  if (p->s[i] == '0') i++;
  else if (p->s[i] >= '1' && p->s[i] <= '9'){
    while (i < p->n && p->s[i] >= '0' && p->s[i] <= '9') i++;
  } else return 0;
  if (i < p->n && p->s[i] == '.'){
    i++;
    size_t d = i;
    while (i < p->n && p->s[i] >= '0' && p->s[i] <= '9') i++;
    if (i == d) return 0;
  }
  if (i < p->n && (p->s[i] == 'e' || p->s[i] == 'E')){
    i++;
    if (i < p->n && (p->s[i] == '+' || p->s[i] == '-')) i++;
    size_t d = i;
    while (i < p->n && p->s[i] >= '0' && p->s[i] <= '9') i++;
    if (i == d) return 0;
  }
  *end_out = i;
  return 1;
}

static tjson_value* tj_number(tjparse* p){
  size_t end = p->i;
  if (!tj_number_grammar(p, &end)){ p->ok = 0; return NULL; }
  char saved = ((char*)p->s)[end];
  ((char*)p->s)[end] = 0;
  char* ep = NULL;
  double d = strtod(p->s + p->i, &ep);
  ((char*)p->s)[end] = saved;
  if (ep != p->s + end || !isfinite(d)){ p->ok = 0; return NULL; }
  p->i = end;
  tjson_value* v = tj_new_value(p, TJSON_NUMBER);
  v->as.number = d;
  return v;
}

static tjson_value* tj_value(tjparse* p){
  tj_ws(p);
  if (p->i >= p->n){ p->ok = 0; return NULL; }
  char c = p->s[p->i];
  if (c == '"'){
    tjson_string s;
    if (!tj_string(p, &s)) return NULL;
    tjson_value* v = tj_new_value(p, TJSON_STRING);
    v->as.string = s;
    return v;
  }
  if (c == '{'){
    p->i++;
    tjson_value* obj = tj_new_value(p, TJSON_OBJECT);
    tj_ws(p);
    if (p->i < p->n && p->s[p->i] == '}'){ p->i++; return obj; }
    for (;;){
      tjson_string key;
      tj_ws(p);
      if (!tj_string(p, &key)) return NULL;
      tj_ws(p);
      if (p->i >= p->n || p->s[p->i] != ':'){ p->ok = 0; return NULL; }
      p->i++;
      tjson_value* val = tj_value(p);
      if (!p->ok) return NULL;
      tj_object_set(obj, key, val);
      tj_ws(p);
      if (p->i < p->n && p->s[p->i] == ','){ p->i++; continue; }
      if (p->i < p->n && p->s[p->i] == '}'){ p->i++; return obj; }
      p->ok = 0; return NULL;
    }
  }
  if (c == '['){
    p->i++;
    tjson_value* arr = tj_new_value(p, TJSON_ARRAY);
    tj_ws(p);
    if (p->i < p->n && p->s[p->i] == ']'){ p->i++; return arr; }
    for (;;){
      tjson_value* elem = tj_value(p);
      if (!p->ok) return NULL;
      tj_array_push(arr, elem);
      tj_ws(p);
      if (p->i < p->n && p->s[p->i] == ','){ p->i++; continue; }
      if (p->i < p->n && p->s[p->i] == ']'){ p->i++; return arr; }
      p->ok = 0; return NULL;
    }
  }
  if (c == 't' && p->i + 4 <= p->n && memcmp(p->s + p->i, "true", 4) == 0){
    p->i += 4;
    tjson_value* v = tj_new_value(p, TJSON_BOOL);
    v->as.boolean = 1;
    return v;
  }
  if (c == 'f' && p->i + 5 <= p->n && memcmp(p->s + p->i, "false", 5) == 0){
    p->i += 5;
    tjson_value* v = tj_new_value(p, TJSON_BOOL);
    v->as.boolean = 0;
    return v;
  }
  if (c == 'n' && p->i + 4 <= p->n && memcmp(p->s + p->i, "null", 4) == 0){
    p->i += 4;
    return tj_new_value(p, TJSON_NULL);
  }
  return tj_number(p);
}

static void tjson_free_doc(tjson_doc* doc, tjson_value* root){
  if (!doc) return;
  if (root) tjson_free_value_arrays(root);
  tjson_arena_chunk* c = doc->chunks;
  while (c){
    tjson_arena_chunk* next = c->next;
    tj_chunk_put(c);
    c = next;
  }
  free(doc->input);
  free(doc);
}

tjson_value* tjson_parse_take(char* data, uint32_t len){
  tjson_doc* doc = (tjson_doc*)tj_xmalloc(sizeof(tjson_doc));
  memset(doc, 0, sizeof(*doc));
  doc->input = data;
  doc->input[len] = 0;
  doc->input_len = len;
  tjparse p = { doc, doc->input, 0, len, 1 };
  tjson_value* root = tj_value(&p);
  tj_ws(&p);
  if (!p.ok || p.i != p.n){
    tjson_free_doc(doc, root);
    return NULL;
  }
  doc->root = root;
  return root;
}

tjson_value* tjson_parse_copy(const char* data, uint32_t len){
  char* copy = (char*)tj_xmalloc((size_t)len + 1u);
  memcpy(copy, data, len);
  copy[len] = 0;
  return tjson_parse_take(copy, len);
}

static void tjson_free_value_arrays(tjson_value* v){
  if (!v) return;
  if (v->kind == TJSON_ARRAY){
    for (uint32_t i=0;i<v->as.array.len;i++) tjson_free_value_arrays(v->as.array.items[i]);
    free(v->as.array.items);
  } else if (v->kind == TJSON_OBJECT){
    for (uint32_t i=0;i<v->as.object.len;i++) tjson_free_value_arrays(v->as.object.members[i].value);
    free(v->as.object.members);
  }
}

void tjson_free(tjson_value* root){
  if (!root) return;
  tjson_free_doc(root->doc, root);
}

tjson_value* tjson_object_get(tjson_value* obj, const char* key, uint32_t key_len){
  return tjson_object_get_hint(obj, key, key_len, NULL);
}

tjson_value* tjson_object_get_hint(tjson_value* obj, const char* key, uint32_t key_len, uint32_t* hint){
  if (!obj || obj->kind != TJSON_OBJECT || !key) return NULL;
  if (hint && *hint > 0){
    uint32_t i = *hint - 1u;
    if (i < obj->as.object.len){
      tjson_string k = obj->as.object.members[i].key;
      if (k.len == key_len && (key_len == 0 || memcmp(k.data, key, key_len) == 0))
        return obj->as.object.members[i].value;
    }
  }
  for (uint32_t i=0;i<obj->as.object.len;i++){
    tjson_string k = obj->as.object.members[i].key;
    if (k.len == key_len && (key_len == 0 || memcmp(k.data, key, key_len) == 0)){
      if (hint) *hint = i + 1u;
      return obj->as.object.members[i].value;
    }
  }
  return NULL;
}

tjson_value* tjson_array_get(tjson_value* arr, uint32_t index){
  if (!arr || arr->kind != TJSON_ARRAY || index >= arr->as.array.len) return NULL;
  return arr->as.array.items[index];
}

static uint32_t tj_utf8_next(const unsigned char* s, uint32_t len, uint32_t* i){
  unsigned char c0 = s[(*i)++];
  if (c0 < 0x80u) return c0;
  uint32_t cp, need;
  if ((c0 & 0xE0u) == 0xC0u){ cp = c0 & 0x1Fu; need = 1; }
  else if ((c0 & 0xF0u) == 0xE0u){ cp = c0 & 0x0Fu; need = 2; }
  else if ((c0 & 0xF8u) == 0xF0u){ cp = c0 & 0x07u; need = 3; }
  else return 0xFFFDu;
  if (*i + need > len) return 0xFFFDu;
  for (uint32_t k=0;k<need;k++){
    unsigned char cx = s[*i + k];
    if ((cx & 0xC0u) != 0x80u) return 0xFFFDu;
    cp = (cp << 6) | (uint32_t)(cx & 0x3Fu);
  }
  *i += need;
  return cp > 0x10FFFFu ? 0xFFFDu : cp;
}

static double tj_string_js_len(tjson_string s){
  double n = 0.0;
  const unsigned char* p = (const unsigned char*)s.data;
  for (uint32_t i=0;i<s.len;){
    uint32_t cp = tj_utf8_next(p, s.len, &i);
    n += cp > 0xFFFFu ? 2.0 : 1.0;
  }
  return n;
}

double tjson_length(tjson_value* value){
  if (!value) return 0.0;
  if (value->kind == TJSON_ARRAY) return (double)value->as.array.len;
  if (value->kind == TJSON_STRING) return tj_string_js_len(value->as.string);
  return 0.0;
}

double tjson_number_value(tjson_value* value){
  if (!value) return NAN;
  if (value->kind == TJSON_NUMBER) return value->as.number;
  if (value->kind == TJSON_BOOL) return value->as.boolean ? 1.0 : 0.0;
  if (value->kind == TJSON_NULL) return 0.0;
  return NAN;
}

int tjson_truthy(tjson_value* value){
  if (!value) return 0;
  switch (value->kind){
    case TJSON_NULL: return 0;
    case TJSON_BOOL: return value->as.boolean != 0;
    case TJSON_NUMBER: return value->as.number != 0.0 && value->as.number == value->as.number;
    case TJSON_STRING: return value->as.string.len != 0;
    case TJSON_ARRAY:
    case TJSON_OBJECT: return 1;
  }
  return 0;
}

static void tj_quote(tjbuf* b, tjson_string s){
  tj_buf_putc(b, '"');
  for (uint32_t i=0;i<s.len;i++){
    unsigned char c = (unsigned char)s.data[i];
    switch (c){
      case '"': tj_buf_putz(b, "\\\""); break;
      case '\\': tj_buf_putz(b, "\\\\"); break;
      case '\b': tj_buf_putz(b, "\\b"); break;
      case '\f': tj_buf_putz(b, "\\f"); break;
      case '\n': tj_buf_putz(b, "\\n"); break;
      case '\r': tj_buf_putz(b, "\\r"); break;
      case '\t': tj_buf_putz(b, "\\t"); break;
      default:
        if (c < 0x20u){
          char tmp[7];
          snprintf(tmp, sizeof(tmp), "\\u%04x", (unsigned)c);
          tj_buf_putz(b, tmp);
        } else {
          tj_buf_putc(b, (char)c);
        }
    }
  }
  tj_buf_putc(b, '"');
}

static void tj_stringify(tjbuf* b, tjson_value* v){
  if (!v){ tj_buf_putz(b, "null"); return; }
  switch (v->kind){
    case TJSON_NULL:
      tj_buf_putz(b, "null"); break;
    case TJSON_BOOL:
      tj_buf_putz(b, v->as.boolean ? "true" : "false"); break;
    case TJSON_NUMBER: {
      char tmp[40];
      double d = v->as.number;
      if (d != d || d == 1.0/0.0 || d == -1.0/0.0) tj_buf_putz(b, "null");
      else if (d == (double)(long long)d && d < 9e15 && d > -9e15){
        snprintf(tmp, sizeof(tmp), "%lld", (long long)d);
        tj_buf_putz(b, tmp);
      } else {
        snprintf(tmp, sizeof(tmp), "%.17g", d);
        tj_buf_putz(b, tmp);
      }
      break;
    }
    case TJSON_STRING:
      tj_quote(b, v->as.string); break;
    case TJSON_ARRAY:
      tj_buf_putc(b, '[');
      for (uint32_t i=0;i<v->as.array.len;i++){
        if (i) tj_buf_putc(b, ',');
        tj_stringify(b, v->as.array.items[i]);
      }
      tj_buf_putc(b, ']');
      break;
    case TJSON_OBJECT:
      tj_buf_putc(b, '{');
      for (uint32_t i=0;i<v->as.object.len;i++){
        if (i) tj_buf_putc(b, ',');
        tj_quote(b, v->as.object.members[i].key);
        tj_buf_putc(b, ':');
        tj_stringify(b, v->as.object.members[i].value);
      }
      tj_buf_putc(b, '}');
      break;
  }
}

char* tjson_stringify_alloc(tjson_value* value, uint32_t* out_len){
  tjbuf b; tj_buf_init(&b);
  tj_stringify(&b, value);
  tj_buf_reserve(&b, 1);
  b.p[b.len] = 0;
  if (out_len) *out_len = (uint32_t)b.len;
  return b.p;
}

double tjson_stringify_len(tjson_value* value){
  uint32_t len = 0;
  char* s = tjson_stringify_alloc(value, &len);
  free(s);
  return (double)len;
}
