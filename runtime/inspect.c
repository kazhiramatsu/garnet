/* console.log and util.inspect: Node's lib/internal/util/inspect.js (formatValue, formatRaw, formatProperty,
   groupArrayElements, reduceToSingleString), function for function, so that the text and the line breaks agree.
   Included by ts_rt.c. An entry of the output is a malloc'd UTF-8 string (ins_s); the lengths the layout
   compares are JavaScript's, in UTF-16 units (ins_units), or columns (ins_width) where Node asks for the width. */
enum { INS_OBJECT_TYPE, INS_ARRAY_TYPE, INS_ARRAY_EXTRAS };
enum { INS_S_NONE, INS_S_SPECIAL, INS_S_NUMBER, INS_S_UNDEFINED, INS_S_NULL, INS_S_STRING, INS_S_DATE, INS_S_REGEXP };
typedef struct { char* p; size_t len; } ins_s;
typedef struct { ins_s* v; uint32_t n, cap; } ins_list;
typedef struct ins_seen { tsv v; struct ins_seen* up; } ins_seen;
typedef struct {
  int depth;            /* INT_MAX: no limit (null, Infinity) */
  int break_length;     /* INT_MAX: Infinity */
  int compact;          /* -1: true, 0: false, else the number */
  int max_array, max_string;
  int colors, show_hidden, show_proxy, custom;
  int indentation, current_depth;
  ins_seen* seen;
  tsv circular;         /* the values referred to, in order of discovery: a position + 1 is `*n` */
} ins_ctx;

static ins_s ins_value(ins_ctx* c, tsv v, int rt, int typed_array);

static ins_s ins_new(const char* p, size_t n){
  ins_s s; s.p = (char*)malloc(n + 1); s.len = n;
  if (n) memcpy(s.p, p, n);
  s.p[n] = 0;
  return s;
}
static ins_s ins_z(const char* z){ return ins_new(z, strlen(z)); }
static ins_s ins_take(jbuf* b){ ins_s s = ins_new(b->p, b->len); jb_free(b); return s; }
static ins_s ins_fmt(const char* f, ...){
  char small[256];
  va_list ap; va_start(ap, f);
  int n = vsnprintf(small, sizeof small, f, ap);
  va_end(ap);
  if (n < (int)sizeof small) return ins_new(small, (size_t)n);
  ins_s s; s.p = (char*)malloc((size_t)n + 1); s.len = (size_t)n;
  va_start(ap, f);
  vsnprintf(s.p, (size_t)n + 1, f, ap);
  va_end(ap);
  return s;
}
static void ins_free(ins_s s){ free(s.p); }
static void ins_push(ins_list* l, ins_s s){
  if (l->n == l->cap){ l->cap = l->cap ? l->cap * 2 : 8; l->v = (ins_s*)realloc(l->v, sizeof(ins_s) * l->cap); }
  l->v[l->n++] = s;
}
static void ins_list_free(ins_list* l){
  for (uint32_t i = 0; i < l->n; i++) ins_free(l->v[i]);
  free(l->v);
  l->v = NULL; l->n = l->cap = 0;
}
static ins_s ins_style(ins_ctx* c, ins_s s, int kind){
  if (!c->colors || kind == INS_S_NONE) return s;
  const char* on = "", *off = "\x1b[39m";
  switch (kind){
    case INS_S_SPECIAL: on = "\x1b[36m"; break;
    case INS_S_NUMBER: on = "\x1b[33m"; break;
    case INS_S_UNDEFINED: on = "\x1b[90m"; break;
    case INS_S_NULL: on = "\x1b[1m"; off = "\x1b[22m"; break;
    case INS_S_STRING: on = "\x1b[32m"; break;
    case INS_S_DATE: on = "\x1b[35m"; break;
    case INS_S_REGEXP: on = "\x1b[31m"; break;
  }
  ins_s r = ins_fmt("%s%s%s", on, s.p, off);
  ins_free(s);
  return r;
}
/* a string's `.length` from its UTF-8 form */
static size_t ins_units(const char* p, size_t n){
  size_t u = 0;
  for (size_t i = 0; i < n; i++){
    unsigned char b = (unsigned char)p[i];
    if ((b & 0xC0) != 0x80) u += b >= 0xF0 ? 2 : 1;
  }
  return u;
}
/* removeColors: the codes this file writes */
static size_t ins_plain_units(const char* p, size_t n){
  size_t u = 0;
  for (size_t i = 0; i < n; i++){
    unsigned char b = (unsigned char)p[i];
    if (b == 0x1b && i + 1 < n && p[i + 1] == '['){
      i += 2;
      while (i < n && p[i] != 'm') i++;
      continue;
    }
    if ((b & 0xC0) != 0x80) u += b >= 0xF0 ? 2 : 1;
  }
  return u;
}
static int ins_full_width(uint32_t code){
  return code >= 0x1100 && (code <= 0x115f || code == 0x2329 || code == 0x232a ||
    (code >= 0x2e80 && code <= 0x3247 && code != 0x303f) || (code >= 0x3250 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0xa4c6) || (code >= 0xa960 && code <= 0xa97c) || (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6b) ||
    (code >= 0xff01 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1b000 && code <= 0x1b001) ||
    (code >= 0x1f200 && code <= 0x1f251) || (code >= 0x1f300 && code <= 0x1f64f) || (code >= 0x20000 && code <= 0x3fffd));
}
static int ins_zero_width(uint32_t code){
  return code <= 0x1F || (code >= 0x7F && code <= 0x9F) || (code >= 0x300 && code <= 0x36F) || (code >= 0x200B && code <= 0x200F) ||
    (code >= 0x20D0 && code <= 0x20FF) || (code >= 0xFE00 && code <= 0xFE0F) || (code >= 0xFE20 && code <= 0xFE2F) ||
    (code >= 0xE0100 && code <= 0xE01EF);
}
/* getStringWidth */
static size_t ins_width(const char* p, size_t n){
  size_t w = 0;
  for (size_t i = 0; i < n; ){
    unsigned char b = (unsigned char)p[i];
    if (b == 0x1b && i + 1 < n && p[i + 1] == '['){
      i += 2;
      while (i < n && p[i] != 'm') i++;
      i++;
      continue;
    }
    uint32_t cp; int k;
    if (b < 0x80){ cp = b; k = 1; }
    else if (b < 0xE0){ cp = b & 0x1F; k = 2; }
    else if (b < 0xF0){ cp = b & 0x0F; k = 3; }
    else { cp = b & 0x07; k = 4; }
    for (int j = 1; j < k && i + (size_t)j < n; j++) cp = (cp << 6) | ((unsigned char)p[i + (size_t)j] & 0x3F);
    i += (size_t)k;
    if (ins_full_width(cp)) w += 2;
    else if (!ins_zero_width(cp)) w++;
  }
  return w;
}
/* strEscape over the units [from, to) */
static void ins_escape(jbuf* b, ts_strview s, uint32_t from, uint32_t to){
  int single = 0, dq = 0, bt = 0, dollar = 0;
  for (uint32_t i = from; i < to; i++){
    uint32_t u = ts_str_cu_at_view(s, i);
    if (u == '\'') single = 1;
    else if (u == '"') dq = 1;
    else if (u == '`') bt = 1;
    else if (u == '$' && i + 1 < to && ts_str_cu_at_view(s, i + 1) == '{') dollar = 1;
  }
  char quote = '\'';
  if (single){
    if (!dq) quote = '"';
    else if (!bt && !dollar) quote = '`';
  }
  jb_putc(b, quote);
  for (uint32_t i = from; i < to; i++){
    uint32_t u = ts_str_cu_at_view(s, i);
    if (u >= 0xD800 && u <= 0xDFFF){
      if (u <= 0xDBFF && i + 1 < to){
        uint32_t lo = ts_str_cu_at_view(s, i + 1);
        if (lo >= 0xDC00 && lo <= 0xDFFF){
          jb_put_utf8_cp(b, 0x10000u + ((u - 0xD800u) << 10) + (lo - 0xDC00u));
          i++;
          continue;
        }
      }
      char e[16]; snprintf(e, sizeof e, "\\u%x", u); jb_putz(b, e);
    } else if (u == '\\') jb_putz(b, "\\\\");
    else if (u == '\'' && quote == '\'') jb_putz(b, "\\'");
    else if (u == 8) jb_putz(b, "\\b");
    else if (u == 9) jb_putz(b, "\\t");
    else if (u == 10) jb_putz(b, "\\n");
    else if (u == 12) jb_putz(b, "\\f");
    else if (u == 13) jb_putz(b, "\\r");
    else if (u < 32 || (u >= 0x7F && u <= 0x9F)){ char e[8]; snprintf(e, sizeof e, "\\x%02X", u); jb_putz(b, e); }
    else jb_put_utf8_cp(b, u);
  }
  jb_putc(b, quote);
}
static ins_s ins_quoted(ts_strview s, uint32_t from, uint32_t to){
  jbuf b; jb_init(&b);
  ins_escape(&b, s, from, to);
  return ins_take(&b);
}
static ins_s ins_number(ins_ctx* c, double d){
  if (d == 0.0 && signbit(d)) return ins_style(c, ins_z("-0"), INS_S_NUMBER);
  char nb[40]; ts_fmt_num(d, nb, sizeof nb);
  return ins_style(c, ins_z(nb), INS_S_NUMBER);
}
static ins_s ins_bigint(ins_ctx* c, tsv v){
  tsv text = ts_bigint_to_string(v, 10);
  uint32_t n = 0; char* u = ts_string_cstr_copy(text, &n);
  ins_s s = ins_fmt("%sn", u);
  free(u);
  return ins_style(c, s, INS_S_NUMBER);
}
static ins_s ins_string_utf8(tsv v){
  uint32_t n = 0; char* u = ts_str_utf8_copy_view(ts_str_view_typed(v), &n);
  ins_s s = ins_new(u, n);
  free(u);
  return s;
}
/* formatPrimitive for a string */
static ins_s ins_string(ins_ctx* c, tsv v){
  ts_strview s = ts_str_view_typed(v);
  uint32_t len = s.len;
  ins_s trailer = ins_z("");
  if (len > (uint32_t)c->max_string){
    uint32_t remaining = len - (uint32_t)c->max_string;
    len = (uint32_t)c->max_string;
    ins_free(trailer);
    trailer = ins_fmt("... %u more character%s", remaining, remaining > 1 ? "s" : "");
  }
  jbuf b; jb_init(&b);
  if (c->compact != -1 && len > 16 && (int64_t)len > (int64_t)c->break_length - c->indentation - 4){
    /* split after each line feed */
    uint32_t start = 0, first = 1;
    for (uint32_t i = 0; i < len; i++){
      if (ts_str_cu_at_view(s, i) != '\n' && i + 1 != len) continue;
      if (!first){
        jb_putz(&b, " +\n");
        for (int k = 0; k < c->indentation + 2; k++) jb_putc(&b, ' ');
      }
      first = 0;
      ins_s line = ins_style(c, ins_quoted(s, start, i + 1), INS_S_STRING);
      jb_puts(&b, line.p, line.len);
      ins_free(line);
      start = i + 1;
    }
  } else {
    ins_s q = ins_style(c, ins_quoted(s, 0, len), INS_S_STRING);
    jb_puts(&b, q.p, q.len);
    ins_free(q);
  }
  jb_puts(&b, trailer.p, trailer.len);
  ins_free(trailer);
  return ins_take(&b);
}
static ins_s ins_symbol(ins_ctx* c, tsv v){ return ins_style(c, ins_string_utf8(ts_symbol_tostring(v)), INS_S_STRING); }
static ins_s ins_remaining(double remaining){
  return ins_fmt("... %.0f more item%s", remaining, remaining > 1 ? "s" : "");
}
static int ins_key_is_identifier(const char* n, size_t len){
  if (!len || !((n[0] >= 'a' && n[0] <= 'z') || (n[0] >= 'A' && n[0] <= 'Z') || n[0] == '_')) return 0;
  for (size_t i = 1; i < len; i++){
    char ch = n[i];
    if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_')) return 0;
  }
  return 1;
}
/* formatProperty; `key` is a string or a symbol, `desc` the property's descriptor (or undefined to read it) */
static ins_s ins_property(ins_ctx* c, tsv v, int rt, tsv key, int type, tsv desc){
  ts_gc_root(&v); ts_gc_root(&key); ts_gc_root(&desc);
  if (ts_is_undef(desc)) desc = ts_get_own_property_descriptor(v, key);
  ins_s str;
  static ts_key k_value, k_get, k_set, k_enum;
  if (!k_value){
    k_value = ts_intern_field("value", 5); k_get = ts_intern_field("get", 3); k_set = ts_intern_field("set", 3);
    k_enum = ts_intern_field("enumerable", 10);
  }
  tsv value = ts_is_undef(desc) ? TS_UNDEFINED : ts_get(desc, k_value);
  if (!ts_is_undef(value)){
    c->indentation += 2;
    str = ins_value(c, value, rt, 0);
    c->indentation -= 2;
  } else if (!ts_is_undef(desc) && !ts_is_undef(ts_get(desc, k_get))){
    str = ins_style(c, ins_z(!ts_is_undef(ts_get(desc, k_set)) ? "[Getter/Setter]" : "[Getter]"), INS_S_SPECIAL);
  } else if (!ts_is_undef(desc) && !ts_is_undef(ts_get(desc, k_set))){
    str = ins_style(c, ins_z("[Setter]"), INS_S_SPECIAL);
  } else {
    str = ins_style(c, ins_z("undefined"), INS_S_UNDEFINED);
  }
  if (type == INS_ARRAY_TYPE){ ts_gc_unroot(3); return str; }
  ins_s name;
  if (ts_is_symbol(key)){
    jbuf b; jb_init(&b);
    ts_strview sv = ts_str_view_typed(ts_symbol_tostring(key));
    /* (its text, escaped as a string is, without quotes) */
    for (uint32_t i = 0; i < sv.len; i++){
      uint32_t u = ts_str_cp_at_view(sv, &i);
      if (u == '\'' || u == '\\') jb_putc(&b, '\\');
      jb_put_utf8_cp(&b, u);
    }
    name = ins_style(c, ins_take(&b), INS_S_STRING);
  } else {
    ins_s text = ins_string_utf8(key);
    if (ins_key_is_identifier(text.p, text.len)){
      name = strcmp(text.p, "__proto__") == 0 ? ins_z("['__proto__']") : ins_new(text.p, text.len);
    } else {
      ts_strview kv = ts_str_view_typed(key);
      name = ins_style(c, ins_quoted(kv, 0, kv.len), INS_S_STRING);
    }
    ins_free(text);
  }
  if (!ts_is_undef(desc) && !ts_truthy(ts_get(desc, k_enum))){
    ins_s bracketed = ins_fmt("[%s]", name.p);
    ins_free(name);
    name = bracketed;
  }
  ts_gc_unroot(3);
  ins_s r = ins_fmt("%s: %s", name.p, str.p);
  ins_free(name); ins_free(str);
  return r;
}
/* getKeys / getOwnNonIndexProperties: enumerable (or, showHidden, all) strings, then symbols */
static tsv ins_keys(ins_ctx* c, tsv v, int skip_indices){
  ts_gc_root(&v);
  tsv out = ts_new_array(0); ts_gc_root(&out);
  tsv names = c->show_hidden ? ts_object_get_own_property_names(v) : ts_object_keys(v);
  ts_gc_root(&names);
  uint32_t n = (uint32_t)ts_array_len(names);
  for (uint32_t i = 0; i < n; i++){
    tsv k = ts_array_get(names, i);
    uint32_t idx;
    if (skip_indices && ts_is_str(k) && prop_key_is_array_index(ts_intern_string_value(k), &idx)) continue;
    ts_array_push(out, k);
  }
  tsv syms = ts_object_get_own_property_symbols(v);
  ts_gc_root(&syms);
  n = (uint32_t)ts_array_len(syms);
  for (uint32_t i = 0; i < n; i++){
    tsv k = ts_array_get(syms, i);
    if (!c->show_hidden){
      tsv d = ts_get_own_property_descriptor(v, k);
      if (ts_is_undef(d) || !ts_truthy(ts_get(d, ts_intern_field("enumerable", 10)))) continue;
    }
    ts_array_push(out, k);
  }
  ts_gc_unroot(4);
  return out;
}
static void ins_keys_remove(tsv keys, const char* name){
  uint32_t n = (uint32_t)ts_array_len(keys);
  tsv want = ts_new_string(name, (uint32_t)strlen(name));
  for (uint32_t i = 0; i < n; i++){
    tsv k = ts_array_get(keys, i);
    if (!ts_is_str(k) || !ts_strict_eq_str(k, want)) continue;
    ts_array* a = (ts_array*)ts_ptr(keys);
    for (uint32_t j = i + 1; j < n; j++) ts_array_set(keys, j - 1, ts_array_get(keys, j));
    a = (ts_array*)ts_ptr(keys);
    a->len = n - 1;
    return;
  }
}
static int ins_keys_has(tsv keys, const char* name){
  uint32_t n = (uint32_t)ts_array_len(keys);
  tsv want = ts_new_string(name, (uint32_t)strlen(name));
  for (uint32_t i = 0; i < n; i++){
    tsv k = ts_array_get(keys, i);
    if (ts_is_str(k) && ts_strict_eq_str(k, want)) return 1;
  }
  return 0;
}
/* getConstructorName: NULL for an object at the end of a null prototype chain */
static char* ins_ctor_name(tsv v){
  if (ts_is_obj(v)){
    const ts_object* o = (const ts_object*)ts_ptr(v);
    if (o->h.kind == TS_KIND_OBJECT && ts_obj_is_sized(o) && !(o->cls & TS_CLS_RELINKED)){
      const char* nm = ts_class_name_of_word(o->cls);
      if (nm && *nm) return strdup(nm);
    }
  }
  ts_gc_root(&v);
  tsv obj = v, first = TS_UNDEFINED;
  ts_gc_root(&obj); ts_gc_root(&first);
  tsv ctor_key = ts_new_string("constructor", 11);
  ts_gc_root(&ctor_key);
  char* found = NULL;
  int ended_null = 0;
  while (ts_proto_ref(obj) && !ts_is_prim_cell(obj)){
    tsv d = ts_get_own_property_descriptor(obj, ctor_key);
    if (ts_is_obj(d) && !ts_is_undef(d)){
      tsv ctor = ts_get(d, ts_intern_field("value", 5));
      if (ts_is_func(ctor)){
        tsv name = ts_get(ctor, ts_intern_field("name", 4));
        tsv proto = ts_get(ctor, ts_intern_field("prototype", 9));
        if (ts_is_str(name) && ts_str_len_typed(name) != 0 && ts_proto_ref(proto) && ts_instanceof(v, proto)){
          uint32_t n = 0;
          found = ts_string_cstr_copy(name, &n);
          break;
        }
      }
    }
    tsv next = ts_get_proto(obj);
    if (ts_is_undef(first)) first = next;
    obj = next;
  }
  if (!found){
    ended_null = !ts_proto_ref(first);
  }
  ts_gc_unroot(4);
  if (found){
    /* a built-in whose constructor value the program never made reads as what it is */
    if (strcmp(found, "Object") == 0){
      const char* builtin = ts_is_map(v) ? "Map" : ts_is_set(v) ? "Set" : ts_is_weakmap(v) ? "WeakMap" : ts_is_weakset(v) ? "WeakSet" :
                            ts_is_promise(v) ? "Promise" : ts_is_regexp(v) ? "RegExp" : NULL;
      if (builtin){ free(found); return strdup(builtin); }
    }
    return found;
  }
  if (ended_null) return NULL;
  return strdup("Object <Complex prototype>");
}
/* getPrefix */
static ins_s ins_prefix(const char* ctor, const char* tag, const char* fallback, const char* size){
  if (ctor == NULL){
    if (*tag && strcmp(fallback, tag) != 0) return ins_fmt("[%s%s: null prototype] [%s] ", fallback, size, tag);
    return ins_fmt("[%s%s: null prototype] ", fallback, size);
  }
  ins_s r = ins_fmt("%s%s ", ctor, size);
  if (*tag){
    const char* at = strstr(ctor, tag);
    int add = 0;
    if (!at) add = 1;
    else {
      const char* end = at + strlen(tag);
      if (*end && (*end < 'A' || *end > 'Z')) add = 1;
    }
    if (add){
      ins_s t = ins_fmt("%s[%s] ", r.p, tag);
      ins_free(r);
      r = t;
    }
  }
  return r;
}
static ins_s ins_ctx_style(tsv v, const char* ctor, const char* tag){
  (void)v;
  const char* fallback = ctor == NULL ? (strcmp(tag, "Object") == 0 ? "Object" : "Object") : "";
  return ins_prefix(ctor, tag, fallback, "");
}
static tsv ins_namespace_object(const char* name){
  return ts_get(ts_global_this(), ts_intern_field(name, (uint32_t)strlen(name)));
}
/* The tag: @@toStringTag where the prototypes own it, else the built-in's own */
static char* ins_tag(tsv v){
  int own_enumerable = 0;
  int threw = 0;
  tsv t = ts_get_catching(v, TS_KEY_WKSYM(TS_WKSYM_TO_STRING_TAG), &threw);
  if (threw) t = TS_UNDEFINED;
  if (ts_is_str(t) && ts_str_len_typed(t) != 0){
    tsv d = ts_get_own_property_descriptor(v, ts_wksym(TS_WKSYM_TO_STRING_TAG));
    if (ts_is_obj(d) && ts_truthy(ts_get(d, ts_intern_field("enumerable", 10)))) own_enumerable = 1;
    if (own_enumerable) return strdup("");
    uint32_t n = 0;
    return ts_string_cstr_copy(t, &n);
  }
  if (g_builtin_tags_defined) return strdup("");
  if (ts_is_map(v)) return strdup("Map");
  if (ts_is_set(v)) return strdup("Set");
  if (ts_is_weakmap(v)) return strdup("WeakMap");
  if (ts_is_weakset(v)) return strdup("WeakSet");
  if (ts_is_promise(v)) return strdup("Promise");
  if (ts_is_typed_array(v)) return strdup(g_ta_name[((ts_typedarray*)ts_ptr(v))->elem]);
  if (ts_is_array_buffer(v)) return strdup(((ts_arraybuffer*)ts_ptr(v))->shared ? "SharedArrayBuffer" : "ArrayBuffer");
  if (ts_is_obj(v) && ((ts_gc_header*)ts_ptr(v))->kind == TS_KIND_OBJECT){
    static const char* const names[] = { "Math", "JSON", "Reflect" };
    for (size_t i = 0; i < sizeof names / sizeof names[0]; i++)
      if (v == ins_namespace_object(names[i])) return strdup(names[i]);
  }
  return strdup("");
}
static int ins_is_date(tsv v){
  return TS_TOP16(v) == TS_SEL_OBJECT && ((ts_gc_header*)ts_ptr(v))->kind == TS_KIND_OBJECT && ts_has_own(v, date_key());
}
/* getFunctionBase and getClassBase */
static ins_s ins_function_base(tsv v, const char* ctor, const char* tag){
  ts_func* f = (ts_func*)ts_ptr(v);
  ts_gc_root(&v);
  tsv namev = ts_get(v, ts_intern_field("name", 4));
  ins_s name = ts_is_str(namev) ? ins_string_utf8(namev) : ins_z("");
  f = (ts_func*)ts_ptr(v);
  jbuf b; jb_init(&b);
  if (ts_is_class_value(v) || f->dyn_class){
    jb_putz(&b, "[class ");
    jb_putz(&b, name.len ? name.p : "(anonymous)");
    if (ctor && strcmp(ctor, "Function") != 0){ jb_putz(&b, " ["); jb_putz(&b, ctor); jb_putc(&b, ']'); }
    if (*tag && (!ctor || strcmp(ctor, tag) != 0)){ jb_putz(&b, " ["); jb_putz(&b, tag); jb_putc(&b, ']'); }
    if (ctor){
      tsv super = ts_get_proto(v);
      tsv sn = ts_proto_ref(super) ? ts_get(super, ts_intern_field("name", 4)) : TS_UNDEFINED;
      if (ts_is_str(sn) && ts_str_len_typed(sn) != 0){
        ins_s t = ins_string_utf8(sn);
        jb_putz(&b, " extends "); jb_putz(&b, t.p);
        ins_free(t);
      }
    } else jb_putz(&b, " extends [null prototype]");
    jb_putc(&b, ']');
  } else {
    int kind = f->o.proto == g_genfn_protos[0] ? 0 : f->o.proto == g_genfn_protos[1] ? 1 : f->o.proto == g_genfn_protos[2] ? 2 : -1;
    const char* type = kind == 0 ? "GeneratorFunction" : kind == 1 ? "AsyncGeneratorFunction" : kind == 2 ? "AsyncFunction" : "Function";
    jb_putc(&b, '['); jb_putz(&b, type);
    if (!ctor) jb_putz(&b, " (null prototype)");
    if (name.len == 0) jb_putz(&b, " (anonymous)");
    else { jb_putz(&b, ": "); jb_putz(&b, name.p); }
    jb_putc(&b, ']');
    if (ctor && strcmp(ctor, type) != 0 && strcmp(ctor, "Function") != 0){ jb_putc(&b, ' '); jb_putz(&b, ctor); }
    if (*tag && (!ctor || strcmp(ctor, tag) != 0)){ jb_putz(&b, " ["); jb_putz(&b, tag); jb_putc(&b, ']'); }
  }
  ins_free(name);
  ts_gc_unroot(1);
  return ins_take(&b);
}
/* formatArray and formatSpecialArray */
static void ins_format_array(ins_ctx* c, tsv v, int rt, ins_list* out){
  uint32_t val_len = (uint32_t)ts_array_len(v);
  uint32_t len = val_len < (uint32_t)c->max_array ? val_len : (uint32_t)c->max_array;
  uint32_t remaining = val_len - len;
  ts_gc_root(&v);
  int dict = ((ts_array*)ts_ptr(v))->sparse == TS_ARRAY_DICT;
  for (uint32_t i = 0; i < len; i++){
    if (!ts_array_has_index(v, i)){
      /* a hole: the keys that exist, the gaps between them */
      tsv keys = ts_object_keys(v);
      ts_gc_root(&keys);
      uint32_t nk = (uint32_t)ts_array_len(keys), at = i;
      double index = i;
      for (; at < nk && out->n < len; at++){
        tsv key = ts_array_get(keys, at);
        uint32_t tmp;
        if (!ts_is_str(key) || !prop_key_is_array_index(ts_intern_string_value(key), &tmp)) break;
        if ((double)tmp != index){
          double empty = (double)tmp - index;
          ins_push(out, ins_style(c, ins_fmt("<%.0f empty item%s>", empty, empty > 1 ? "s" : ""), INS_S_UNDEFINED));
          index = tmp;
          if (out->n == len) break;
        }
        ins_push(out, ins_property(c, v, rt, key, INS_ARRAY_TYPE, TS_UNDEFINED));
        index++;
      }
      double left = (double)val_len - index;
      if (out->n != len){
        if (left > 0) ins_push(out, ins_style(c, ins_fmt("<%.0f empty item%s>", left, left > 1 ? "s" : ""), INS_S_UNDEFINED));
      } else if (left > 0) ins_push(out, ins_remaining(left));
      ts_gc_unroot(2);
      return;
    }
    if (dict){
      char kb[16]; int kl = snprintf(kb, sizeof kb, "%u", i);
      ins_push(out, ins_property(c, v, rt, ts_new_string(kb, (uint32_t)kl), INS_ARRAY_TYPE, TS_UNDEFINED));
    } else {
      tsv e = ts_array_get(v, i);
      c->indentation += 2;
      ins_push(out, ts_is_undef(e) ? ins_style(c, ins_z("undefined"), INS_S_UNDEFINED) : ins_value(c, e, rt, 0));
      c->indentation -= 2;
    }
  }
  ts_gc_unroot(1);
  if (remaining > 0) ins_push(out, ins_remaining(remaining));
}
static void ins_format_typed_array(ins_ctx* c, tsv v, ins_list* out){
  uint32_t length = ((ts_typedarray*)ts_ptr(v))->length;
  uint32_t max = length < (uint32_t)c->max_array ? length : (uint32_t)c->max_array;
  ts_gc_root(&v);
  for (uint32_t i = 0; i < max; i++){
    tsv e = ts_ta_get(v, i);
    ins_push(out, ts_is_bigint(e) ? ins_bigint(c, e) : ins_number(c, ts_to_num(e)));
  }
  ts_gc_unroot(1);
  if (length > max) ins_push(out, ins_remaining(length - max));
}
static void ins_format_set(ins_ctx* c, tsv v, int rt, ins_list* out){
  ts_gc_root(&v);
  ts_set_t* st = (ts_set_t*)ts_ptr(v);
  uint32_t live = st->len - st->tombs, max = live < (uint32_t)c->max_array ? live : (uint32_t)c->max_array, printed = 0;
  c->indentation += 2;
  for (uint32_t i = 0; printed < max; i++){
    st = (ts_set_t*)ts_ptr(v);
    if (i >= st->len) break;
    tsv elem = st->elems[i];
    if (elem == TS_MAPSET_HOLE) continue;
    printed++;
    ins_push(out, ins_value(c, elem, rt, 0));
  }
  c->indentation -= 2;
  ts_gc_unroot(1);
  if (live > max) ins_push(out, ins_remaining(live - max));
}
static void ins_format_map(ins_ctx* c, tsv v, int rt, ins_list* out){
  ts_gc_root(&v);
  ts_map* m = (ts_map*)ts_ptr(v);
  uint32_t live = m->len - m->tombs, max = live < (uint32_t)c->max_array ? live : (uint32_t)c->max_array, printed = 0;
  c->indentation += 2;
  for (uint32_t i = 0; printed < max; i++){
    m = (ts_map*)ts_ptr(v);
    if (i >= m->len) break;
    tsv key = m->keys[i], val = m->vals[i];
    if (key == TS_MAPSET_HOLE) continue;
    printed++;
    ts_gc_root(&val);
    ins_s ks = ins_value(c, key, rt, 0);
    ins_s vs = ins_value(c, val, rt, 0);
    ts_gc_unroot(1);
    ins_push(out, ins_fmt("%s => %s", ks.p, vs.p));
    ins_free(ks); ins_free(vs);
  }
  c->indentation -= 2;
  ts_gc_unroot(1);
  if (live > max) ins_push(out, ins_remaining(live - max));
}
static void ins_format_array_buffer(ins_ctx* c, tsv v, ins_list* out){
  ts_arraybuffer* ab = (ts_arraybuffer*)ts_ptr(v);
  jbuf b; jb_init(&b);
  ins_s label = ins_style(c, ins_z("[Uint8Contents]"), INS_S_SPECIAL);
  jb_puts(&b, label.p, label.len);
  ins_free(label);
  jb_putz(&b, ": <");
  uint32_t max = ab->byte_length < (uint32_t)c->max_array ? ab->byte_length : (uint32_t)c->max_array;
  for (uint32_t i = 0; i < max; i++){ char hx[4]; snprintf(hx, sizeof hx, i ? " %02x" : "%02x", ab->bytes[i]); jb_putz(&b, hx); }
  if (ab->byte_length > max){
    char more[64]; uint32_t left = ab->byte_length - max;
    snprintf(more, sizeof more, " ... %u more byte%s", left, left > 1 ? "s" : "");
    jb_putz(&b, more);
  }
  jb_putc(&b, '>');
  ins_push(out, ins_take(&b));
}
static void ins_format_promise(ins_ctx* c, tsv v, int rt, ins_list* out){
  ts_promise* p = (ts_promise*)ts_ptr(v);
  if (p->state == 0){ ins_push(out, ins_style(c, ins_z("<pending>"), INS_S_SPECIAL)); return; }
  int rejected = p->state == 2;
  c->indentation += 2;
  ins_s str = ins_value(c, p->value, rt, 0);
  c->indentation -= 2;
  if (rejected){
    ins_s label = ins_style(c, ins_z("<rejected>"), INS_S_SPECIAL);
    ins_push(out, ins_fmt("%s %s", label.p, str.p));
    ins_free(label); ins_free(str);
  } else ins_push(out, str);
}
/* isBelowBreakLength */
static int ins_below_break(ins_ctx* c, ins_list* out, size_t start, const char* base){
  size_t total = out->n + start;
  if ((int64_t)(total + out->n) > (int64_t)c->break_length) return 0;
  for (uint32_t i = 0; i < out->n; i++){
    total += c->colors ? ins_plain_units(out->v[i].p, out->v[i].len) : ins_units(out->v[i].p, out->v[i].len);
    if ((int64_t)total > (int64_t)c->break_length) return 0;
  }
  return *base == 0 || !strchr(base, '\n');
}
/* groupArrayElements */
static void ins_group(ins_ctx* c, ins_list* out, tsv value, int more_entry){
  double total = 0, max_length = 0;
  uint32_t output_length = out->n;
  if (more_entry) output_length--;
  const double separator = 2;
  double* data_len = (double*)malloc(sizeof(double) * (output_length + 1));
  for (uint32_t i = 0; i < output_length; i++){
    double len = (double)ins_width(out->v[i].p, out->v[i].len);
    data_len[i] = len;
    total += len + separator;
    if (max_length < len) max_length = len;
  }
  double actual_max = max_length + separator;
  if (actual_max * 3 + c->indentation < c->break_length && (total / actual_max > 5 || max_length <= 6)){
    double average_bias = sqrt(actual_max - total / out->n);
    double biased_max = fmax(actual_max - 3 - average_bias, 1);
    double columns = fmin(floor(sqrt(2.5 * biased_max * output_length) / biased_max + 0.5),
                     fmin(floor(((double)c->break_length - c->indentation) / actual_max),
                     fmin((double)c->compact * 4, 15)));
    if (columns > 1){
      uint32_t cols = (uint32_t)columns;
      double* line_max = (double*)malloc(sizeof(double) * cols);
      for (uint32_t i = 0; i < cols; i++){
        double m = 0;
        for (uint32_t j = i; j < output_length; j += cols) if (data_len[j] > m) m = data_len[j];
        line_max[i] = m + separator;
      }
      int pad_start = 1;
      if (!ts_is_undef(value)){
        for (uint32_t i = 0; i < out->n; i++){
          tsv e = ts_get_dyn(value, ts_num((double)i));
          if (!ts_is_num(e) && !ts_is_bigint(e)){ pad_start = 0; break; }
        }
      }
      ins_list tmp = { NULL, 0, 0 };
      for (uint32_t i = 0; i < output_length; i += cols){
        uint32_t max = i + cols < output_length ? i + cols : output_length;
        jbuf b; jb_init(&b);
        uint32_t j = i;
        for (; j < max - 1; j++){
          ins_s cell = ins_fmt("%s, ", out->v[j].p);
          size_t units = ins_units(cell.p, cell.len);
          size_t own = ins_units(out->v[j].p, out->v[j].len);
          double padding = line_max[j - i] + (double)own - data_len[j];
          size_t fill = padding > (double)units ? (size_t)padding - units : 0;
          if (pad_start) for (size_t k = 0; k < fill; k++) jb_putc(&b, ' ');
          jb_puts(&b, cell.p, cell.len);
          if (!pad_start) for (size_t k = 0; k < fill; k++) jb_putc(&b, ' ');
          ins_free(cell);
        }
        if (pad_start){
          size_t own = ins_units(out->v[j].p, out->v[j].len);
          double padding = line_max[j - i] + (double)own - data_len[j] - separator;
          size_t fill = padding > (double)own ? (size_t)padding - own : 0;
          for (size_t k = 0; k < fill; k++) jb_putc(&b, ' ');
        }
        jb_puts(&b, out->v[j].p, out->v[j].len);
        ins_push(&tmp, ins_take(&b));
      }
      if (more_entry){ ins_push(&tmp, out->v[output_length]); out->v[output_length].p = NULL; out->v[output_length].len = 0; }
      ins_list_free(out);
      *out = tmp;
      free(line_max);
    }
  }
  free(data_len);
}
static void ins_join(jbuf* b, ins_list* out, const char* sep){
  for (uint32_t i = 0; i < out->n; i++){
    if (i) jb_putz(b, sep);
    jb_puts(b, out->v[i].p, out->v[i].len);
  }
}
/* reduceToSingleString */
static ins_s ins_reduce(ins_ctx* c, ins_list* out, const char* base, const char* open, const char* close, int extras, int rt, tsv value){
  int has_base = *base != 0;
  if (c->compact != -1){
    if (c->compact >= 1){
      uint32_t entries = out->n;
      if (extras == INS_ARRAY_EXTRAS && entries > 6){
        ins_group(c, out, value, (uint32_t)c->max_array < entries);
      }
      if (c->current_depth - rt < c->compact && entries == out->n){
        size_t start = out->n + (size_t)c->indentation + ins_units(open, strlen(open)) + ins_units(base, strlen(base)) + 10;
        if (ins_below_break(c, out, start, base)){
          jbuf j; jb_init(&j);
          ins_join(&j, out, ", ");
          ins_s joined = ins_take(&j);
          if (!strchr(joined.p, '\n')){
            ins_s r = ins_fmt("%s%s%s %s %s", base, has_base ? " " : "", open, joined.p, close);
            ins_free(joined);
            return r;
          }
          ins_free(joined);
        }
      }
    }
    jbuf ind; jb_init(&ind);
    jb_putc(&ind, '\n');
    for (int i = 0; i < c->indentation; i++) jb_putc(&ind, ' ');
    ins_s indentation = ins_take(&ind);
    ins_s sep = ins_fmt(",%s  ", indentation.p);
    jbuf b; jb_init(&b);
    if (has_base){ jb_putz(&b, base); jb_putc(&b, ' '); }
    jb_putz(&b, open); jb_puts(&b, indentation.p, indentation.len); jb_putz(&b, "  ");
    ins_join(&b, out, sep.p);
    jb_puts(&b, indentation.p, indentation.len); jb_putz(&b, close);
    ins_free(indentation); ins_free(sep);
    return ins_take(&b);
  }
  /* compact: true */
  jbuf b; jb_init(&b);
  if (ins_below_break(c, out, 0, base)){
    jb_putz(&b, open);
    if (has_base){ jb_putc(&b, ' '); jb_putz(&b, base); }
    jb_putc(&b, ' ');
    ins_join(&b, out, ", ");
    jb_putc(&b, ' '); jb_putz(&b, close);
    return ins_take(&b);
  }
  jbuf ind; jb_init(&ind);
  for (int i = 0; i < c->indentation; i++) jb_putc(&ind, ' ');
  ins_s indentation = ins_take(&ind);
  jb_putz(&b, open);
  if (!has_base && strlen(open) == 1) jb_putc(&b, ' ');
  else {
    if (has_base){ jb_putc(&b, ' '); jb_putz(&b, base); }
    jb_putc(&b, '\n'); jb_puts(&b, indentation.p, indentation.len); jb_putz(&b, "  ");
  }
  ins_s sep = ins_fmt(",\n%s  ", indentation.p);
  ins_join(&b, out, sep.p);
  jb_putc(&b, ' '); jb_putz(&b, close);
  ins_free(indentation); ins_free(sep);
  return ins_take(&b);
}
static int ins_ends_with(const char* s, const char* suffix){
  size_t n = strlen(s), m = strlen(suffix);
  return n >= m && memcmp(s + n - m, suffix, m) == 0;
}
/* formatError, the parts a stack without frames needs */
static ins_s ins_error_base(ins_ctx* c, tsv v, const char* ctor, const char* tag, tsv keys){
  ts_gc_root(&v);
  int threw = 0;
  tsv stackv = ts_get_catching(v, ts_intern_field("stack", 5), &threw);
  if (threw) stackv = TS_UNDEFINED;
  ts_gc_root(&stackv);
  threw = 0;
  tsv msgv = ts_get_catching(v, ts_intern_field("message", 7), &threw);
  if (threw) msgv = TS_UNDEFINED;
  ts_gc_root(&msgv);
  threw = 0;
  tsv namev = ts_get_catching(v, ts_intern_field("name", 4), &threw);
  if (threw) namev = TS_UNDEFINED;
  ts_gc_root(&namev);
  ins_s name = ts_is_str(namev) ? ins_string_utf8(namev) : ins_z("Error");
  ins_s message = ts_is_str(msgv) ? ins_string_utf8(msgv) : ins_z("");
  ins_s stack;
  if (ts_is_str(stackv) && ts_str_len_typed(stackv) != 0) stack = ins_string_utf8(stackv);
  else if (message.len && name.len) stack = ins_fmt("%s: %s", name.p, message.p);
  else stack = ins_z(message.len ? message.p : name.p);
  if (!c->show_hidden && ts_array_len(keys) != 0){
    ins_keys_remove(keys, "stack");
    if (!ts_is_str(msgv) || strstr(stack.p, message.p)) ins_keys_remove(keys, "message");
    if (!ts_is_str(namev) || strstr(stack.p, name.p)) ins_keys_remove(keys, "name");
  }
  if (ts_has_prop(v, ts_intern_field("cause", 5)) && !ins_keys_has(keys, "cause")){
    ts_gc_root(&keys);
    tsv k = ts_new_string("cause", 5);
    ts_array_push(keys, k);
    ts_gc_unroot(1);
  }
  threw = 0;
  tsv errs = ts_get_catching(v, ts_intern_field("errors", 6), &threw);
  if (!threw && ts_array_is_array(errs) && !ins_keys_has(keys, "errors")){
    ts_gc_root(&keys);
    tsv k = ts_new_string("errors", 6);
    ts_array_push(keys, k);
    ts_gc_unroot(1);
  }
  /* improveStack */
  size_t len = name.len;
  if (ctor == NULL || (ins_ends_with(name.p, "Error") && strncmp(stack.p, name.p, len) == 0 &&
                       (stack.len == len || stack.p[len] == ':' || stack.p[len] == '\n'))){
    ins_s prefix = ins_prefix(ctor, tag, "Error", "");
    if (prefix.len) prefix.p[--prefix.len] = 0;     /* its trailing space */
    if (strcmp(name.p, prefix.p) != 0){
      ins_s improved;
      if (strstr(prefix.p, name.p)) improved = len == 0 ? ins_fmt("%s: %s", prefix.p, stack.p) : ins_fmt("%s%s", prefix.p, stack.p + len);
      else improved = ins_fmt("%s [%s]%s", prefix.p, name.p, stack.p + len);
      ins_free(stack);
      stack = improved;
    }
    ins_free(prefix);
  }
  /* a stack without frames goes in brackets */
  const char* from = stack.p;
  if (message.len){
    const char* m = strstr(stack.p, message.p);
    if (m && m != stack.p) from = m + message.len;
  }
  if (!strstr(from, "\n    at")){
    ins_s bracketed = ins_fmt("[%s]", stack.p);
    ins_free(stack);
    stack = bracketed;
  }
  if (c->indentation != 0){
    jbuf b; jb_init(&b);
    for (size_t i = 0; i < stack.len; i++){
      jb_putc(&b, stack.p[i]);
      if (stack.p[i] == '\n') for (int k = 0; k < c->indentation; k++) jb_putc(&b, ' ');
    }
    ins_free(stack);
    stack = ins_take(&b);
  }
  ins_free(name); ins_free(message);
  ts_gc_unroot(4);
  return stack;
}
enum { INS_F_NONE, INS_F_ARRAY, INS_F_SET, INS_F_MAP, INS_F_TYPED, INS_F_BUFFER, INS_F_PROMISE, INS_F_WEAK, INS_F_MAPITER };
/* the entries a Map or Set iterator has left, without moving it: 1 when it is one */
static int ins_iterator_preview(tsv v, ins_ctx* c, int rt, ins_list* out, char* brace, size_t brace_cap){
  if (!ts_is_obj(v) || ((ts_gc_header*)ts_ptr(v))->kind != TS_KIND_OBJECT) return 0;
  if (!g_mi_source || !ts_has_own(v, g_mi_source)) return 0;
  ts_gc_root(&v);
  tsv src = ts_get(v, g_mi_source);
  ts_gc_root(&src);
  int kind = (int)ts_to_num(ts_get(v, g_mi_kind));     /* 0 keys, 1 values, 2 entries, 3 a Set's values, 4 its entries */
  int done = ts_is_undef(src);
  int is_set = kind >= 3;
  int entries = kind == 2 || kind == 4;
  double last = ts_to_num(ts_get(v, g_mi_last));
  snprintf(brace, brace_cap, "[%s %s] {", is_set ? "Set" : "Map", entries ? "Entries" : "Iterator");
  uint32_t printed = 0;
  c->indentation += 2;
  if (!done){
    for (uint32_t i = 0; printed < (uint32_t)c->max_array; i++){
      tsv key, val = TS_UNDEFINED;
      uint64_t* order;
      if (is_set){
        ts_set_t* st = (ts_set_t*)ts_ptr(src);
        if (i >= st->len) break;
        key = st->elems[i];
        order = st->iteration_order;
        val = key;
      } else {
        ts_map* m = (ts_map*)ts_ptr(src);
        if (i >= m->len) break;
        key = m->keys[i];
        order = m->iteration_order;
        val = m->vals[i];
      }
      if (key == TS_MAPSET_HOLE || (double)(order ? order[i] : (uint64_t)i + 1u) <= last) continue;
      printed++;
      ts_gc_root(&val);
      if (entries){
        ins_list pair = { NULL, 0, 0 };
        ins_push(&pair, ins_value(c, key, rt, 0));
        ins_push(&pair, ins_value(c, val, rt, 0));
        ins_push(out, ins_reduce(c, &pair, "", "[", "]", INS_ARRAY_EXTRAS, rt, TS_UNDEFINED));
        ins_list_free(&pair);
      } else ins_push(out, ins_value(c, kind == 1 ? val : key, rt, 0));
      ts_gc_unroot(1);
    }
  }
  c->indentation -= 2;
  ts_gc_unroot(2);
  return 1;
}
/* the tag of the runtime's own iterators and of a generator object */
static const char* ins_internal_iterator(tsv v){
  if (!ts_is_obj(v) || ((ts_gc_header*)ts_ptr(v))->kind != TS_KIND_OBJECT) return NULL;
  static ts_key k_ai, k_coro, k_rx;
  if (!k_ai){
    k_ai = ts_intern_field("__array_iterator_source", 23); k_coro = ts_intern_field("__coro", 6);
    k_rx = ts_intern_field("__tsaot_rx_iter_re", 18);
  }
  if (ts_has_own(v, k_ai)) return "Array Iterator";
  if (ts_has_own(v, k_rx)) return "RegExp String Iterator";
  if (ts_has_own(v, k_coro)){
    tsv cv = ts_get(v, k_coro);
    return ts_is_coro_value(cv) && ((ts_coro*)ts_ptr(cv))->is_asyncgen ? "AsyncGenerator" : "Generator";
  }
  return NULL;
}
static int ins_seen_has(ins_ctx* c, tsv v){
  for (ins_seen* s = c->seen; s; s = s->up) if (s->v == v) return 1;
  return 0;
}
static ins_s ins_raw(ins_ctx* c, tsv v, int rt, int typed_array){
  ts_gc_root(&v);
  tsv keys = TS_UNDEFINED; ts_gc_root(&keys);
  char* ctor = ins_ctor_name(v);
  char* tag = ins_tag(v);
  ins_s base = ins_z(""), open = { NULL, 0 };
  const char* close = "}";
  int formatter = INS_F_NONE, extras = INS_OBJECT_TYPE, extra_bytelength = 0;
  ins_s early = { NULL, 0 };
  char brace[64] = "";
  ins_list out = { NULL, 0, 0 };
  int is_func = ts_is_func(v);
  const char* internal = NULL;
  if (ts_array_is_array(v)){
    ins_s prefix = (ctor && strcmp(ctor, "Array") == 0 && !*tag) ? ins_z("") : ({ char sz[24]; snprintf(sz, sizeof sz, "(%u)", (uint32_t)ts_array_len(v)); ins_prefix(ctor, tag, "Array", sz); });
    keys = ins_keys(c, v, 1);
    open = ins_fmt("%s[", prefix.p);
    close = "]";
    ins_free(prefix);
    if (ts_array_len(v) == 0 && ts_array_len(keys) == 0){ early = ins_fmt("%s]", open.p); goto done; }
    extras = INS_ARRAY_EXTRAS; formatter = INS_F_ARRAY;
  } else if (ts_is_set(v)){
    ts_set_t* st = (ts_set_t*)ts_ptr(v);
    uint32_t size = st->len - st->tombs;
    char sz[24]; snprintf(sz, sizeof sz, "(%u)", size);
    ins_s prefix = ins_prefix(ctor, tag, "Set", sz);
    keys = ins_keys(c, v, 0);
    formatter = INS_F_SET;
    if (size == 0 && ts_array_len(keys) == 0){ early = ins_fmt("%s{}", prefix.p); ins_free(prefix); goto done; }
    open = ins_fmt("%s{", prefix.p); ins_free(prefix);
  } else if (ts_is_map(v)){
    ts_map* m = (ts_map*)ts_ptr(v);
    uint32_t size = m->len - m->tombs;
    char sz[24]; snprintf(sz, sizeof sz, "(%u)", size);
    ins_s prefix = ins_prefix(ctor, tag, "Map", sz);
    keys = ins_keys(c, v, 0);
    formatter = INS_F_MAP;
    if (size == 0 && ts_array_len(keys) == 0){ early = ins_fmt("%s{}", prefix.p); ins_free(prefix); goto done; }
    open = ins_fmt("%s{", prefix.p); ins_free(prefix);
  } else if (ts_is_typed_array(v)){
    ts_typedarray* ta = (ts_typedarray*)ts_ptr(v);
    keys = ins_keys(c, v, 1);
    char sz[24]; snprintf(sz, sizeof sz, "(%u)", ta->length);
    ins_s prefix = ins_prefix(ctor, tag, g_ta_name[ta->elem], sz);
    open = ins_fmt("%s[", prefix.p); close = "]";
    ins_free(prefix);
    if (ta->length == 0 && ts_array_len(keys) == 0 && !c->show_hidden){ early = ins_fmt("%s]", open.p); goto done; }
    formatter = INS_F_TYPED; extras = INS_ARRAY_EXTRAS;
  } else if ((internal = ins_internal_iterator(v))){
    keys = ins_keys(c, v, 0);
    ins_s prefix = ins_prefix("Object", *tag ? tag : internal, "Object", "");
    if (ts_array_len(keys) == 0){ early = ins_fmt("%s{}", prefix.p); ins_free(prefix); goto done; }
    open = ins_fmt("%s{", prefix.p); ins_free(prefix);
  } else {
    keys = ins_keys(c, v, 0);
    open = ins_z("{");
    uint32_t nk = (uint32_t)ts_array_len(keys);
    if (ins_iterator_preview(v, c, rt + 1, &out, brace, sizeof brace)){
      ins_free(open);
      open = ins_z(brace);
    } else if (is_func){
      ins_free(base);
      base = ins_function_base(v, ctor, tag);
      if (nk == 0){ early = ins_style(c, base, INS_S_SPECIAL); base = ins_z(""); goto done; }
    } else if (ts_is_regexp(v)){
      ins_free(base);
      tsv s = ts_regexp_to_string(v);
      base = ts_is_str(s) ? ins_string_utf8(s) : ins_z("");
      ins_s prefix = ins_prefix(ctor, tag, "RegExp", "");
      if (strcmp(prefix.p, "RegExp ") != 0){ ins_s t = ins_fmt("%s%s", prefix.p, base.p); ins_free(base); base = t; }
      ins_free(prefix);
      base = ins_style(c, base, INS_S_REGEXP);
      if (nk == 0 || rt > c->depth){ early = base; base = ins_z(""); goto done; }
    } else if (ins_is_date(v)){
      ins_free(base);
      tsv ms = ts_get(v, date_key());
      double d = ts_is_num(ms) ? ts_to_num(ms) : NAN;
      base = d != d ? ins_z("Invalid Date") : ins_string_utf8(ts_date_to_iso(d));
      ins_s prefix = ins_prefix(ctor, tag, "Date", "");
      if (strcmp(prefix.p, "Date ") != 0){ ins_s t = ins_fmt("%s%s", prefix.p, base.p); ins_free(base); base = t; }
      ins_free(prefix);
      if (nk == 0){ early = ins_style(c, base, INS_S_DATE); base = ins_z(""); goto done; }
    } else if (ts_is_obj(v) && objproto_tostring_is_error(v)){
      ins_free(base);
      base = ins_error_base(c, v, ctor, tag, keys);
      if (ts_array_len(keys) == 0){ early = base; base = ins_z(""); goto done; }
    } else if (ts_is_array_buffer(v)){
      ins_s prefix = ins_prefix(ctor, tag, ((ts_arraybuffer*)ts_ptr(v))->shared ? "SharedArrayBuffer" : "ArrayBuffer", "");
      if (typed_array == 0) formatter = INS_F_BUFFER;
      else if (nk == 0){
        ins_s bl = ins_number(c, ((ts_arraybuffer*)ts_ptr(v))->byte_length);
        early = ins_fmt("%s{ [byteLength]: %s }", prefix.p, bl.p);
        ins_free(bl); ins_free(prefix);
        goto done;
      }
      ins_free(open);
      open = ins_fmt("%s{", prefix.p);
      ins_free(prefix);
      extra_bytelength = 1;
    } else if (ts_is_promise(v)){
      ins_s prefix = ins_prefix(ctor, tag, "Promise", "");
      ins_free(open); open = ins_fmt("%s{", prefix.p); ins_free(prefix);
      formatter = INS_F_PROMISE;
    } else if (ts_is_weakset(v) || ts_is_weakmap(v)){
      ins_s prefix = ins_prefix(ctor, tag, ts_is_weakset(v) ? "WeakSet" : "WeakMap", "");
      ins_free(open); open = ins_fmt("%s{", prefix.p); ins_free(prefix);
      formatter = INS_F_WEAK;
    } else if (TS_RT_UNLIKELY(g_has_wrappers) && wrapper_value(v) != TS_UNDEFINED){
      tsv w = wrapper_value(v);
      const char* type = ts_is_num(w) ? "Number" : ts_is_str(w) ? "String" : ts_is_bool(w) ? "Boolean" : ts_is_bigint(w) ? "BigInt" : "Symbol";
      if (ts_is_str(w)){
        /* the 0-n indexed entries are noise */
        uint32_t skip = ts_str_len_typed(w);
        tsv kept = ts_new_array(0);
        ts_gc_root(&kept);
        uint32_t idx;
        for (uint32_t i = 0; i < nk; i++){
          tsv k = ts_array_get(keys, i);
          if (ts_is_str(k) && prop_key_is_array_index(ts_intern_string_value(k), &idx) && idx < skip) continue;
          ts_array_push(kept, k);
        }
        keys = kept;
        ts_gc_unroot(1);
        nk = (uint32_t)ts_array_len(keys);
      }
      jbuf b; jb_init(&b);
      jb_putc(&b, '['); jb_putz(&b, type);
      if (!ctor) jb_putz(&b, " (null prototype)");
      else if (strcmp(ctor, type) != 0){ jb_putz(&b, " ("); jb_putz(&b, ctor); jb_putc(&b, ')'); }
      jb_putz(&b, ": ");
      int colors = c->colors; c->colors = 0;
      ins_s p = ts_is_str(w) ? ins_string(c, w) : ins_value(c, w, 0, 0);
      c->colors = colors;
      jb_puts(&b, p.p, p.len); ins_free(p);
      jb_putc(&b, ']');
      if (*tag && (!ctor || strcmp(tag, ctor) != 0)){ jb_putz(&b, " ["); jb_putz(&b, tag); jb_putc(&b, ']'); }
      ins_free(base);
      base = ins_take(&b);
      if (nk == 0){ early = base; base = ins_z(""); goto done; }
    } else if (ctor && strcmp(ctor, "Object") == 0){
      if (TS_RT_UNLIKELY(g_has_arguments_objects) && ts_is_obj(v) && find_slot((ts_object*)ts_ptr(v), ts_intern_field("__arguments", 11), 0)){
        ins_free(open); open = ins_z("[Arguments] {");
      } else if (*tag){
        ins_s prefix = ins_prefix(ctor, tag, "Object", "");
        ins_free(open); open = ins_fmt("%s{", prefix.p); ins_free(prefix);
      }
      if (nk == 0){ early = ins_fmt("%s}", open.p); goto done; }
    } else {
      ins_s style = ins_ctx_style(v, ctor, tag);
      if (nk == 0){ early = ins_fmt("%s{}", style.p); ins_free(style); goto done; }
      ins_free(open); open = ins_fmt("%s{", style.p); ins_free(style);
    }
  }
  if (rt > c->depth){
    ins_s style = ins_ctx_style(v, ctor, tag);
    if (style.len) style.p[--style.len] = 0;
    ins_s name = ctor ? ins_fmt("[%s]", style.p) : ins_new(style.p, style.len);
    /* an array names itself [Array] whatever else the prefix said */
    ins_free(style);
    early = ins_style(c, name, INS_S_SPECIAL);
    goto done;
  }
  rt += 1;
  {
    ins_seen frame; frame.v = v; frame.up = c->seen;
    ts_gc_root(&frame.v);
    c->seen = &frame;
    c->current_depth = rt;
    switch (formatter){
      case INS_F_ARRAY: ins_format_array(c, v, rt, &out); break;
      case INS_F_SET: ins_format_set(c, v, rt, &out); break;
      case INS_F_MAP: ins_format_map(c, v, rt, &out); break;
      case INS_F_TYPED: ins_format_typed_array(c, v, &out); break;
      case INS_F_BUFFER: ins_format_array_buffer(c, v, &out); break;
      case INS_F_PROMISE: ins_format_promise(c, v, rt, &out); break;
      case INS_F_WEAK: ins_push(&out, ins_style(c, ins_z("<items unknown>"), INS_S_SPECIAL)); break;
      default: break;
    }
    if (extra_bytelength){
      ins_s bl = ins_number(c, ((ts_arraybuffer*)ts_ptr(v))->byte_length);
      ins_s name = ins_style(c, ins_z("[byteLength]"), INS_S_STRING);
      ins_push(&out, ins_fmt("%s: %s", name.p, bl.p));
      ins_free(bl); ins_free(name);
    }
    uint32_t nk = (uint32_t)ts_array_len(keys);
    for (uint32_t i = 0; i < nk; i++)
      ins_push(&out, ins_property(c, v, rt, ts_array_get(keys, i), extras, TS_UNDEFINED));
    if (!ts_is_undef(c->circular)){
      uint32_t n = (uint32_t)ts_array_len(c->circular);
      for (uint32_t i = 0; i < n; i++){
        if (ts_array_get(c->circular, i) != v) continue;
        ins_s ref = ins_style(c, ins_fmt("<ref *%u>", i + 1), INS_S_SPECIAL);
        ins_s t = base.len ? ins_fmt("%s %s", ref.p, base.p) : ins_new(ref.p, ref.len);
        ins_free(base); ins_free(ref);
        base = t;
        break;
      }
    }
    c->seen = frame.up;
    ts_gc_unroot(1);
  }
  early = ins_reduce(c, &out, base.p, open.p, close, extras, rt, formatter == INS_F_ARRAY || formatter == INS_F_TYPED ? v : TS_UNDEFINED);
done:
  ins_list_free(&out);
  ins_free(base);
  if (open.p) ins_free(open);
  free(ctor); free(tag);
  ts_gc_unroot(2);
  return early;
}
static tsv g_inspect_custom_symbol = TS_UNDEFINED;
static tsv ins_inspect_fn(tsv* a, int n);
static ins_s ins_value(ins_ctx* c, tsv v, int rt, int typed_array){
  if (ts_is_undef(v)) return ins_style(c, ins_z("undefined"), INS_S_UNDEFINED);
  if (ts_is_null(v)) return ins_style(c, ins_z("null"), INS_S_NULL);
  if (ts_is_bool(v)) return ins_style(c, ins_z((v & 1) ? "true" : "false"), INS_S_NUMBER);
  if (ts_is_num(v)) return ins_number(c, ts_to_num(v));
  if (ts_is_str(v)) return ins_string(c, v);
  if (ts_is_bigint(v)) return ins_bigint(c, v);
  if (ts_is_symbol(v)) return ins_symbol(c, v);
  tsv context = v;
  if (g_has_proxies && ts_is_proxy(v)){
    while (ts_is_proxy(v)){
      ts_proxy* px = (ts_proxy*)ts_ptr(v);
      if (px->revoked) return ins_style(c, ins_z("<Revoked Proxy>"), INS_S_SPECIAL);
      if (c->show_proxy){
        if (rt > c->depth) return ins_style(c, ins_z("Proxy [Array]"), INS_S_SPECIAL);
        ts_gc_root(&v);
        ins_list res = { NULL, 0, 0 };
        c->indentation += 2;
        ins_push(&res, ins_value(c, ((ts_proxy*)ts_ptr(v))->target, rt + 1, 0));
        ins_push(&res, ins_value(c, ((ts_proxy*)ts_ptr(v))->handler, rt + 1, 0));
        c->indentation -= 2;
        ins_s r = ins_reduce(c, &res, "", "Proxy [", "]", INS_ARRAY_EXTRAS, rt + 1, TS_UNDEFINED);
        ins_list_free(&res);
        ts_gc_unroot(1);
        return r;
      }
      v = px->target;
    }
  }
  ts_gc_root(&v); ts_gc_root(&context);
  if (c->custom){
    /* the hook is a registered symbol: a program without it never made the key */
    if (ts_is_undef(g_inspect_custom_symbol)){
      static int rooted = 0;
      ts_root_static_once(&g_inspect_custom_symbol, &rooted);
      tsv name = ts_new_string("nodejs.util.inspect.custom", 26);
      g_inspect_custom_symbol = ts_symbol_for(name);
    }
    ts_key key;
    if (ts_key_from_value(g_inspect_custom_symbol, &key)){
      tsv custom = ts_get(v, key);
      if (ts_is_callable(custom)){
        tsv opts = ts_new_object(); ts_gc_root(&opts); ts_gc_root(&custom);
        tsv depth = c->depth == INT_MAX ? TS_NULL : ts_num((double)(c->depth - rt));
        ts_set_cstr(opts, "depth", depth);
        ts_set_cstr(opts, "colors", ts_bool(c->colors));
        ts_set_cstr(opts, "compact", c->compact == -1 ? ts_bool(1) : c->compact == 0 ? ts_bool(0) : ts_num(c->compact));
        ts_set_cstr(opts, "breakLength", c->break_length == INT_MAX ? ts_num(INFINITY) : ts_num(c->break_length));
        ts_set_cstr(opts, "showHidden", ts_bool(c->show_hidden));
        ts_set_cstr(opts, "maxArrayLength", ts_num(c->max_array));
        ts_set_cstr(opts, "maxStringLength", ts_num(c->max_string));
        tsv inspect = ts_make_fn_t(ins_inspect_fn, NULL, 0, 0);
        ts_gc_root(&inspect);
        tsv a[3] = { depth, opts, inspect };
        tsv ret = invoke_with_this(custom, context, a, 3);
        ts_gc_unroot(3);
        if (ret != context){
          ts_gc_root(&ret);
          ins_s r;
          if (!ts_is_str(ret)) r = ins_value(c, ret, rt, 0);
          else {
            ins_s text = ins_string_utf8(ret);
            jbuf b; jb_init(&b);
            for (size_t i = 0; i < text.len; i++){
              jb_putc(&b, text.p[i]);
              if (text.p[i] == '\n') for (int k = 0; k < c->indentation; k++) jb_putc(&b, ' ');
            }
            ins_free(text);
            r = ins_take(&b);
          }
          ts_gc_unroot(3);
          return r;
        }
      }
    }
  }
  if (ins_seen_has(c, v)){
    uint32_t index = 0;
    if (ts_is_undef(c->circular)) c->circular = ts_new_array(0);
    uint32_t n = (uint32_t)ts_array_len(c->circular);
    for (uint32_t i = 0; i < n; i++) if (ts_array_get(c->circular, i) == v){ index = i + 1; break; }
    if (!index){ ts_array_push(c->circular, v); index = n + 1; }
    ts_gc_unroot(2);
    return ins_style(c, ins_fmt("[Circular *%u]", index), INS_S_SPECIAL);
  }
  ins_s r = ins_raw(c, v, rt, typed_array);
  ts_gc_unroot(2);
  return r;
}
static void ins_defaults(ins_ctx* c){
  memset(c, 0, sizeof *c);
  c->depth = 2; c->break_length = 80; c->compact = 3; c->max_array = 100; c->max_string = 10000;
  c->colors = g_inspect_color; c->custom = 1;
  c->circular = TS_UNDEFINED;
}
static ins_s ins_format(ins_ctx* c, tsv v){
  ts_gc_root(&v); ts_gc_root(&c->circular);
  ins_s r = ins_value(c, v, 0, 0);
  ts_gc_unroot(2);
  return r;
}
/* the options of util.inspect */
static void ins_options(ins_ctx* c, tsv o){
  if (!ts_is_obj(o) && !ts_is_func(o)) return;
  ts_gc_root(&o);
  tsv d = ts_get(o, ts_intern_field("depth", 5));
  if (ts_is_null(d)) c->depth = INT_MAX;
  else if (ts_is_num(d)){ double x = ts_to_num(d); c->depth = x >= INT_MAX ? INT_MAX : x <= -2 ? -2 : (int)x; }
  tsv b = ts_get(o, ts_intern_field("breakLength", 11));
  if (ts_is_num(b)){ double x = ts_to_num(b); c->break_length = x >= INT_MAX ? INT_MAX : (int)x; }
  tsv co = ts_get(o, ts_intern_field("compact", 7));
  if (ts_is_bool(co)) c->compact = (co & 1) ? -1 : 0;
  else if (ts_is_num(co)) c->compact = (int)ts_to_num(co);
  tsv ma = ts_get(o, ts_intern_field("maxArrayLength", 14));
  if (ts_is_null(ma)) c->max_array = INT_MAX;
  else if (ts_is_num(ma)){ double x = ts_to_num(ma); c->max_array = x >= INT_MAX ? INT_MAX : x < 0 ? 0 : (int)x; }
  tsv ms = ts_get(o, ts_intern_field("maxStringLength", 15));
  if (ts_is_null(ms)) c->max_string = INT_MAX;
  else if (ts_is_num(ms)){ double x = ts_to_num(ms); c->max_string = x >= INT_MAX ? INT_MAX : x < 0 ? 0 : (int)x; }
  tsv sh = ts_get(o, ts_intern_field("showHidden", 10));
  if (!ts_is_undef(sh)) c->show_hidden = ts_truthy(sh);
  tsv sp = ts_get(o, ts_intern_field("showProxy", 9));
  if (!ts_is_undef(sp)) c->show_proxy = ts_truthy(sp);
  tsv cl = ts_get(o, ts_intern_field("colors", 6));
  if (!ts_is_undef(cl)) c->colors = ts_truthy(cl);
  tsv ci = ts_get(o, ts_intern_field("customInspect", 13));
  if (!ts_is_undef(ci)) c->custom = ts_truthy(ci);
  ts_gc_unroot(1);
}
/* util.inspect(value, options) */
tsv ts_util_inspect(tsv v, tsv options){
  ins_ctx c;
  ts_gc_root(&v);
  ins_defaults(&c);
  c.colors = 0;
  ins_options(&c, options);
  ins_s s = ins_format(&c, v);
  tsv r = ts_new_string(s.p, (uint32_t)s.len);
  ins_free(s);
  ts_gc_unroot(1);
  return r;
}
static tsv ins_inspect_fn(tsv* a, int n){ return ts_util_inspect(n > 0 ? a[0] : TS_UNDEFINED, n > 1 ? a[1] : TS_UNDEFINED); }
/* used by ts_print_to for what is not a printed primitive */
static void ts_inspect_to(FILE* out, tsv v){
  ins_ctx c;
  ins_defaults(&c);
  ins_s s = ins_format(&c, v);
  fwrite(s.p, 1, s.len, out);
  ins_free(s);
}
/* hasBuiltInToString: an object whose toString is its class's own, printed by inspect under %s */
static int ins_has_builtin_to_string(tsv v){
  while (g_has_proxies && ts_is_proxy(v)){
    ts_proxy* px = (ts_proxy*)ts_ptr(v);
    if (px->revoked) return 1;
    v = px->target;
  }
  ts_gc_root(&v);
  ts_key k_ts = ts_intern_field("toString", 8);
  tsv fn = ts_get(v, k_ts);
  int r = 1;
  if (ts_is_callable(fn)){
    /* the object that holds it, then its constructor: a user's class is not built in */
    tsv tp = ts_get(v, TS_KEY_WKSYM(TS_WKSYM_TO_PRIMITIVE));
    if (ts_has_own(v, k_ts) || (ts_is_callable(tp) && ts_has_own(v, TS_KEY_WKSYM(TS_WKSYM_TO_PRIMITIVE)))) r = 0;
    else {
      tsv p = v;
      ts_gc_root(&p);
      for (;;){
        p = ts_get_proto(p);
        if (!ts_proto_ref(p)) break;
        if (ts_has_own(p, k_ts) || ts_has_own(p, TS_KEY_WKSYM(TS_WKSYM_TO_PRIMITIVE))) break;
      }
      if (ts_proto_ref(p)){
        /* builtInObjects: the global constructors */
        static const char* const builtin[] = { "Object", "Function", "Array", "Number", "Boolean", "String", "Symbol", "BigInt", "Date",
          "Promise", "RegExp", "Error", "AggregateError", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError",
          "URIError", "ArrayBuffer", "SharedArrayBuffer", "DataView", "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "Proxy",
          "FinalizationRegistry", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array",
          "Uint32Array", "Float16Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array", "Iterator" };
        tsv d = ts_get_own_property_descriptor(p, ts_new_string("constructor", 11));
        tsv ctor = ts_is_obj(d) ? ts_get(d, ts_intern_field("value", 5)) : TS_UNDEFINED;
        tsv nm = ts_is_func(ctor) ? ts_get(ctor, ts_intern_field("name", 4)) : TS_UNDEFINED;
        r = 0;
        if (ts_is_str(nm)){
          ins_s text = ins_string_utf8(nm);
          for (size_t i = 0; i < sizeof builtin / sizeof builtin[0]; i++) if (strcmp(text.p, builtin[i]) == 0) r = 1;
          ins_free(text);
        }
      }
      ts_gc_unroot(1);
    }
  }
  ts_gc_unroot(1);
  return r;
}
/* console.log with a string first and more arguments: formatWithOptions. The string is walked as UTF-8: only
   its ASCII percent signs matter. */
static void console_format_arg(FILE* out, char c, tsv t){
  ins_ctx ic;
  switch (c){
    case 's':
      if (ts_is_num(t)){ ins_defaults(&ic); ic.colors = 0; ins_s s = ins_number(&ic, ts_to_num(t)); fwrite(s.p, 1, s.len, out); ins_free(s); return; }
      if (ts_is_bigint(t)){ ins_defaults(&ic); ic.colors = 0; ins_s s = ins_bigint(&ic, t); fwrite(s.p, 1, s.len, out); ins_free(s); return; }
      if (!ts_is_obj(t) || ts_is_symbol(t) || !ins_has_builtin_to_string(t)){
        tsv text = ts_is_symbol(t) ? ts_symbol_tostring(t) : ts_to_string_template(t);
        ins_s s = ins_string_utf8(text); fwrite(s.p, 1, s.len, out); ins_free(s);
        return;
      }
      ins_defaults(&ic); ic.colors = 0; ic.depth = 0;
      { ins_s s = ins_format(&ic, t); fwrite(s.p, 1, s.len, out); ins_free(s); }
      return;
    case 'd':
      ins_defaults(&ic); ic.colors = 0;
      { ins_s s = ts_is_bigint(t) ? ins_bigint(&ic, t) : ins_number(&ic, ts_is_symbol(t) ? NAN : ts_number_coerce(t)); fwrite(s.p, 1, s.len, out); ins_free(s); }
      return;
    case 'i':
      ins_defaults(&ic); ic.colors = 0;
      { ins_s s = ts_is_bigint(t) ? ins_bigint(&ic, t) : ins_number(&ic, ts_is_symbol(t) ? NAN : ts_parse_int_v(t, TS_UNDEFINED)); fwrite(s.p, 1, s.len, out); ins_free(s); }
      return;
    case 'f':
      ins_defaults(&ic); ic.colors = 0;
      { ins_s s = ins_number(&ic, ts_is_symbol(t) ? NAN : ts_parse_float(t)); fwrite(s.p, 1, s.len, out); ins_free(s); }
      return;
    case 'j': { tsv j = ts_json_stringify(t); ts_print_to(out, j); return; }
    case 'o':
      ins_defaults(&ic); ic.show_hidden = 1; ic.show_proxy = 1; ic.depth = 4;
      { ins_s s = ins_format(&ic, t); fwrite(s.p, 1, s.len, out); ins_free(s); }
      return;
    default:
      ins_defaults(&ic);
      { ins_s s = ins_format(&ic, t); fwrite(s.p, 1, s.len, out); ins_free(s); }
      return;
  }
}
static void console_format_to(FILE* out, tsv* args, int n){
  uint32_t flen = 0;
  char* first = ts_str_utf8_copy_view(ts_str_view_typed(args[0]), &flen);
  int a = 0;
  size_t last = 0;
  for (size_t i = 0; i + 1 < flen; i++){
    if (first[i] != '%') continue;
    char c = first[++i];
    if (a + 1 != n){
      if (c == '%'){ fwrite(first + last, 1, i - last, out); last = i + 1; continue; }
      if (!strchr("sjdOoifc", c)) continue;
      if (last != i - 1) fwrite(first + last, 1, i - 1 - last, out);
      a++;
      if (c != 'c') console_format_arg(out, c, args[a]);
      last = i + 1;
    } else if (c == '%'){
      fwrite(first + last, 1, i - last, out);
      last = i + 1;
    }
  }
  int join = 0;
  if (last != 0){
    a++;
    join = 1;
    if (last < flen) fwrite(first + last, 1, flen - last, out);
  }
  free(first);
  for (; a < n; a++){
    if (join) fputc(' ', out);
    ts_print_to(out, args[a]);
    join = 1;
  }
}
/* console.dir(v): inspect without the custom hook, nested-string quoting and all */
void ts_console_dir(tsv v){
  g_inspect_color = ts_stream_wants_color(stdout);
  ins_ctx c;
  ins_defaults(&c);
  c.custom = 0;
  ins_s s = ins_format(&c, v);
  fwrite(s.p, 1, s.len, stdout); fputc('\n', stdout);
  ins_free(s);
}
