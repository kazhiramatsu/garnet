/* ts_rt — lightweight JS runtime for the TS->C AOT compiler.
 *
 * Value representation: NaN-boxing (v7-style). A 64-bit IEEE-754 double has
 * 2^51 spare bit patterns inside its NaN space; we encode non-number values
 * there. A value is a number IFF it is NOT a quiet-NaN with our tag bits set.
 *
 *   bits 63..50 : 0xFFF8 | tag(3)   when boxed (the quiet-NaN prefix 0x7FF8/0xFFF8)
 *   bits 49..0  : 48-bit payload (immediate, stable heap handle, or stack pointer)
 *
 * Doubles pass through untouched; only actual NaNs are canonicalized.
 *
 * The AOT compiler emits direct struct/field/vtable code for the typed, stable,
 * non-escaping parts of the program and only falls back to these tagged Values
 * and the generic object model for `any`/dynamic/escaping parts. The runtime is
 * deliberately small because escape + type + devirt analysis remove most of the
 * work before codegen.
 */
#ifndef TS_RT_H
#define TS_RT_H
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <math.h>
#include <time.h>
#include <setjmp.h>
#include "json_core.h"

/* JS exceptions do not manage the host thread's signal mask. Darwin's setjmp
   queries that mask with a syscall even on the non-throwing path. Keep the
   no-mask save/restore pair together; embedders can request the POSIX behavior. */
#if defined(__APPLE__) && !defined(TSAOT_PRESERVE_SIGNAL_MASK)
#define ts_setjmp(buf) _setjmp(buf)
#define ts_longjmp(buf, value) _longjmp(buf, value)
#else
#define ts_setjmp(buf) setjmp(buf)
#define ts_longjmp(buf, value) longjmp(buf, value)
#endif

#if defined(__GNUC__) || defined(__clang__)
#define TS_RT_ALWAYS_INLINE static inline __attribute__((always_inline))
#define TS_RT_LIKELY(x) __builtin_expect(!!(x), 1)
#define TS_RT_UNLIKELY(x) __builtin_expect(!!(x), 0)
#else
#define TS_RT_ALWAYS_INLINE static inline
#define TS_RT_LIKELY(x) (x)
#define TS_RT_UNLIKELY(x) (x)
#endif

#if defined(TSAOT_USE_MIMALLOC)
#include <mimalloc.h>
#define malloc  mi_malloc
#define calloc  mi_calloc
#define realloc mi_realloc
#define free    mi_free
#endif

typedef uint64_t tsv; /* a tagged Value */

/* NaN-boxing layout: a normal double is any pattern that is NOT a boxed form.
 * Boxed values set the top 16 bits to a quiet-NaN selector 0xFFF8..0xFFFD
 * (sign=1, exp all ones, quiet bit) plus a 3-bit tag, leaving a 48-bit payload.
 * Arithmetic NaNs are canonicalized to positive quiet NaN (top16 0x7FF8), which
 * never collides with our selectors (all have the sign bit set, top16>=0xFFF8). */
#define TS_SEL_SHIFT 48
#define TS_PAYLOAD_MASK 0x0000FFFFFFFFFFFFULL
#define TS_TOP16(v) ((uint16_t)((v) >> TS_SEL_SHIFT))
enum {
  TS_SEL_OBJECT = 0xFFF8U,
  TS_SEL_STRING = 0xFFF9U,
  TS_SEL_FUNC   = 0xFFFAU,
  TS_SEL_BOOL   = 0xFFFBU,
  TS_SEL_UNDEF  = 0xFFFCU,
  TS_SEL_NULL   = 0xFFFDU,
  /* Up to five ASCII bytes plus a three-bit length fit in the 48-bit payload.
     This selector is a string primitive, but not a heap reference. */
  TS_SEL_SHORTSTR = 0xFFFEU
};
#define TS_BOX(sel, payload) ((((uint64_t)(sel)) << TS_SEL_SHIFT) | ((uint64_t)(payload) & TS_PAYLOAD_MASK))

/* ---- numbers ---- */
static inline tsv ts_num(double d) {
  tsv v; memcpy(&v, &d, 8);
  if ((v & 0x7FF8000000000000ULL) == 0x7FF8000000000000ULL && (uint16_t)(v >> TS_SEL_SHIFT) >= TS_SEL_OBJECT)
    v = 0x7FF8000000000000ULL; /* canonicalize a NaN that looks boxed */
  return v;
}
static inline int ts_is_num(tsv v) { uint16_t t = TS_TOP16(v); return t < TS_SEL_OBJECT || t > TS_SEL_SHORTSTR; }
static inline double ts_to_num(tsv v) { double d; memcpy(&d, &v, 8); return d; }
/* JS ToInt32 / ToUint32 (ECMA-262): NaN/Inf -> 0; truncate toward zero; reduce
   modulo 2^32; interpret as signed/unsigned 32-bit. Used by bitwise operators. */
/* ToInt32 / ToUint32 of a value outside the exact range: NaN and infinities
   are 0, the rest truncates toward zero modulo 2^32 (out of line so the
   inline fast path stays a compare and a conversion). */
int32_t ts_to_int32_slow(double d);
uint32_t ts_to_uint32_slow(double d);
TS_RT_ALWAYS_INLINE int32_t ts_to_int32(double d) {
  /* Flag words and indices are already int32 values: converting back and
     comparing exactly proves it, and skips the floor/fmod reduction. The range
     test keeps the conversion defined (NaN fails both comparisons). */
  if (d >= -2147483648.0 && d < 2147483648.0){
    int32_t i = (int32_t)d;
    if ((double)i == d) return i;
  }
  return ts_to_int32_slow(d);
}
TS_RT_ALWAYS_INLINE uint32_t ts_to_uint32(double d) {
  if (d >= 0.0 && d < 4294967296.0){
    uint32_t u = (uint32_t)d;
    if ((double)u == d) return u;
  }
  return ts_to_uint32_slow(d);
}

/* ---- immediates ---- */
#define TS_UNDEFINED TS_BOX(TS_SEL_UNDEF, 0)
#define TS_NULL      TS_BOX(TS_SEL_NULL, 0)
static inline tsv ts_bool(int b) { return TS_BOX(TS_SEL_BOOL, b ? 1 : 0); }
static inline int ts_is_bool(tsv v) { return TS_TOP16(v) == TS_SEL_BOOL; }
static inline int ts_is_undef(tsv v) { return TS_TOP16(v) == TS_SEL_UNDEF; }
static inline int ts_is_null(tsv v) { return TS_TOP16(v) == TS_SEL_NULL; }
int ts_truthy(tsv v);

/* ---- heap object model (the dynamic fallback) ----
 * Every heap cell starts with a common GC header carrying a kind tag and the
 * sweep-list link, so the collector can free objects and strings correctly. */
enum { TS_KIND_OBJECT = 1, TS_KIND_STRING = 2, TS_KIND_FUNC = 3, TS_KIND_ARRAY = 4, TS_KIND_MAP = 5, TS_KIND_SET = 6, TS_KIND_PROMISE = 7, TS_KIND_CORO = 8, TS_KIND_ACCESSOR = 9, TS_KIND_SYMBOL = 10, TS_KIND_PROXY = 11 };
typedef struct ts_gc_header {
  uint8_t kind, mark, gen, remembered;
  /* One 32-bit word so positional initializers of static cells (string
     literals) keep their shape: pin_depth = temporarily non-movable while raw
     pointers are active; inline_cap (object model v2, slice A3) = number of
     in-object value slots after the ts_object header of a plain object, 0 for
     every other kind and for sized class instances. */
  union {
    uint32_t pin_word;
    struct { uint16_t pin_depth; uint8_t inline_cap; uint8_t hdr_spare; };
  };
  uint64_t handle; /* odd handle payload for heap refs; 0 for stack/SROA direct refs */
  size_t size;     /* allocated cell bytes; needed to copy variable-sized heap cells */
  struct ts_gc_header* gc_next;
} ts_gc_header;
enum { TS_GEN_YOUNG = 0, TS_GEN_OLD = 1, TS_GEN_NONHEAP = 2 };
extern ts_gc_header** g_ts_handle_table;
void ts_gc_remember(ts_gc_header* h);

/* ---- heap refs ----
 * Heap values use a stable object handle in the NaN-box payload. Stack/SROA
 * objects are non-moving and keep the old direct-pointer payload; aligned C
 * object pointers have low bit 0, while handle payloads are encoded as
 * (slot_id << 1) | 1. This keeps existing ts_ptr call sites working while
 * making heap object identity independent from the object's address. */
tsv ts_heap_ref_value(uint16_t sel, void* p);
/* Handle table entries carry the cell's generation in bit 0 (cells are at least
   16-byte aligned): 1 = old. The minor collector and the write barriers can
   classify a reference from the entry alone, without touching the cell, which
   is usually cold for an old target. */
#define TS_HANDLE_OLD_BIT ((uintptr_t)1u)
static inline ts_gc_header* ts_handle_entry_cell(uintptr_t entry){
  return (ts_gc_header*)(entry & ~TS_HANDLE_OLD_BIT);
}
/* Every managed cell receives its stable handle at allocation, so boxing a
   live cell is a load; non-heap (stack/SROA) cells and NULL go out of line. */
#define TS_PTR_STACK_TAG ((uint64_t)1u << 47)
static inline tsv ts_heap_ref_fast(uint16_t sel, void* p) {
  if (TS_RT_LIKELY(p != NULL)){
    const ts_gc_header* h = (const ts_gc_header*)p;
    /* an old cell never moves: reference it by address */
    if (h->gen == TS_GEN_OLD) return TS_BOX(sel, (uintptr_t)p);
    uint64_t handle = h->handle;
    if (TS_RT_LIKELY(handle != 0)) return TS_BOX(sel, handle);
    /* a static literal or a stack/SROA cell (never a handle): by address with
       the stack tag, in line so every use of a string literal is a few loads */
    if (h->gen == TS_GEN_NONHEAP) return TS_BOX(sel, (uintptr_t)p | TS_PTR_STACK_TAG);
  }
  return ts_heap_ref_value(sel, p);
}
/* Heap reference payload forms (docs/pointer_stable_old_gen_design.md):
   bit 0 set = handle (slot << 1 | 1), the only form for a young cell;
   bit 0 clear, bit 47 clear = the address of an old cell (never moves);
   bit 0 clear, bit 47 set = the address of a stack/SROA/static cell
   (TS_GEN_NONHEAP). Static literals and stack cells are only 8-byte aligned,
   so the tag lives above the user address space, not in the low bits. */
static inline void* ts_ptr(tsv v) {
  uint64_t payload = v & TS_PAYLOAD_MASK;
  return (payload & 1u)
    ? (void*)ts_handle_entry_cell((uintptr_t)g_ts_handle_table[payload >> 1])
    : (void*)(uintptr_t)(payload & ~TS_PTR_STACK_TAG);
}
static inline tsv ts_obj(void* p) { return ts_heap_ref_fast(TS_SEL_OBJECT, p); }
static inline tsv ts_str_v(void* p){ return ts_heap_ref_fast(TS_SEL_STRING, p); }
static inline tsv ts_func_v(void* p){return ts_heap_ref_fast(TS_SEL_FUNC,   p); }
static inline int ts_is_obj(tsv v) { return TS_TOP16(v) == TS_SEL_OBJECT; }
static inline int ts_is_heap_str(tsv v) { return TS_TOP16(v) == TS_SEL_STRING; }
static inline int ts_is_short_str(tsv v) { return TS_TOP16(v) == TS_SEL_SHORTSTR; }
static inline int ts_is_str(tsv v) {
  uint16_t t = TS_TOP16(v);
  return t == TS_SEL_STRING || t == TS_SEL_SHORTSTR;
}
static inline int ts_is_func(tsv v){ return TS_TOP16(v) == TS_SEL_FUNC; }
#define TS_SHORTSTR_MAX 5u
static inline uint32_t ts_short_str_len(tsv v){
  return (uint32_t)((v >> 40) & 7u);
}
static inline uint8_t ts_short_str_byte(tsv v, uint32_t i){
  return (uint8_t)((v >> (i * 8u)) & 0xffu);
}
static inline tsv ts_short_str_ascii(const char* data, uint32_t len){
  uint64_t payload = (uint64_t)len << 40;
  for (uint32_t i=0;i<len;i++) payload |= (uint64_t)(uint8_t)data[i] << (i * 8u);
  return TS_BOX(TS_SEL_SHORTSTR, payload);
}
/* Proxy: gate generated struct-field access. g_has_proxies is 0 until the first
   Proxy is created, so non-proxy code keeps the direct struct path. Exposed here
   (not file-static) so emitted C can inline `this.field` proxy guards. */
extern int g_has_proxies;
static inline int ts_is_proxy(tsv v){ return ts_is_obj(v) && ((ts_gc_header*)ts_ptr(v))->kind == TS_KIND_PROXY; }

/* ---- property key space (property_model_redesign §3.6) ----
   A property key is currently an opaque 32-bit token. The key space is logically
   tagged into orthogonal kinds (V8-style: V8 splits keys into integer-indexed
   elements vs named string/symbol). We reserve tag ranges now so the future
   Symbol/Index implementation only fills in reserved ranges rather than reworking
   ts_prop_* / shape / struct-opt:
     STRING : named string property id (interned at compile time). Methods live in
              the upper part of this space (>= TS_METHOD_KEY_BASE).
     SYMBOL : (reserved) user Symbol id, runtime-numbered.
     INDEX  : (reserved) integer-indexed key (arr[i] / plain-object numeric key).
     WKSYM  : (reserved) well-known symbol (Symbol.iterator=0, asyncIterator=1, ...).
   Physical representation stays uint32_t for now (A-2c-1): only the STRING space
   is in use and existing key values are unchanged, so behavior is invariant. A
   later step widens ts_prop.key when Symbol/Index are actually implemented.
   The single source for the method-key partition is TS_METHOD_KEY_BASE below;
   the analyzer emits TS_KEY_METHOD(id) rather than open-coding the arithmetic. */
typedef uint32_t ts_key;
enum ts_key_tag { TS_K_STRING = 0, TS_K_SYMBOL = 1, TS_K_INDEX = 2, TS_K_WKSYM = 3 };
#define TS_METHOD_KEY_BASE 1000000u
/* a named-method key from a method-name id (single source of the partition). */
#define TS_KEY_METHOD(id) (TS_METHOD_KEY_BASE + (uint32_t)(id))

/* Well-known symbol keys (Symbol.iterator etc.). Stored in a reserved high range
   of the 32-bit key space (above any field id or method-name key) so they never
   collide and have STABLE, program-independent values — unlike the old approach
   that interned the magic string "@@iterator" at a position-dependent id. A class
   method `[Symbol.iterator]()` is registered under TS_WKSYM_ITERATOR, and for-of
   looks it up under the same constant; a future `obj[Symbol.iterator]` will resolve
   to the identical key. The fixed id table (iterator=0, asyncIterator=1, ...) is
   the single source shared by runtime, analyzer and exporter. */
#define TS_WKSYM_KEY_BASE 2000000000u
#define TS_KEY_WKSYM(id) (TS_WKSYM_KEY_BASE + (uint32_t)(id))
/* User Symbol property keys: Symbol(...) values used as `obj[sym]`. Each user
   symbol gets a unique sym_id (0,1,2,...); its property key is
   TS_USERSYM_KEY_BASE + sym_id. Placed above the well-known range and below the
   uint32 ceiling. Distinct from STRING/METHOD/WKSYM so symbol keys never collide
   with (or are stringified into) string property keys. */
#define TS_USERSYM_KEY_BASE 2100000000u
#define TS_KEY_USERSYM(sym_id) (TS_USERSYM_KEY_BASE + (uint32_t)(sym_id))
enum ts_wksym_id {
  TS_WKSYM_ITERATOR       = 0,
  TS_WKSYM_ASYNC_ITERATOR = 1,
  TS_WKSYM_TO_PRIMITIVE   = 2,
  TS_WKSYM_HAS_INSTANCE   = 3,
  TS_WKSYM_TO_STRING_TAG  = 4,
};

typedef struct { ts_key key; tsv val; uint8_t flags; } ts_prop;
/* Property attribute flags (property_descriptors_design.md §3.1, option A).
   Bit polarity is "set = allowed" so the default for ordinary properties
   (literals, `o.x=v`) is all-bits-set = fully enumerable/writable/configurable.
   CRITICAL: any code that creates a ts_prop slot MUST initialize flags to
   TS_PROP_DEFAULT (NOT rely on calloc 0, which would mean all-false). Slot
   creation is centralized in find_slot/find_prop, which sets this. */
enum { TS_PROP_ENUMERABLE = 1, TS_PROP_WRITABLE = 2, TS_PROP_CONFIGURABLE = 4,
       TS_PROP_ACCESSOR = 8,
       TS_PROP_DEFAULT = TS_PROP_ENUMERABLE | TS_PROP_WRITABLE | TS_PROP_CONFIGURABLE };
static inline int prop_is_enumerable(const ts_prop* p){ return (p->flags & TS_PROP_ENUMERABLE) != 0; }
static inline int prop_is_writable(const ts_prop* p){ return (p->flags & TS_PROP_WRITABLE) != 0; }
static inline int prop_is_configurable(const ts_prop* p){ return (p->flags & TS_PROP_CONFIGURABLE) != 0; }
static inline int prop_is_accessor(const ts_prop* p){ return (p->flags & TS_PROP_ACCESSOR) != 0; }
/* Ordinary objects start at the shared empty shape. Shape 0 means dictionary /
   uncacheable layout (currently reached after property deletion). */
enum { TS_SHAPE_NONE = 0, TS_SHAPE_EMPTY = 1, TS_SHAPE_MAX = (1u << 29) - 1u };
/* Shape-owned key and attribute vectors (object_model_v2_design.md, slice
   A2b). A shaped object (shape != 0) stores only values, 8 bytes each; its
   keys and flags are the vectors of its shape, indexed by slot. Dictionary
   objects (shape 0) keep per-entry keys and flags. */
extern ts_key** g_ts_shape_keys;
extern uint8_t** g_ts_shape_flags;
#define TS_PROP_IC_SIZE 4
/* A cache entry's slot word carries the property's attribute flags in its
   top byte, so an inline hit knows whether the slot is plain writable data
   without consulting the shape. */
#define TS_PIC_SLOT_MASK 0x00FFFFFFu
#define TS_PIC_FLAGS_SHIFT 24u
typedef struct {
  ts_key key;
  uint32_t shape;
  uint32_t slot;
} ts_prop_ic_entry;
typedef struct {
  ts_prop_ic_entry entries[TS_PROP_IC_SIZE];
  uint8_t next;
  uint8_t misses;
  uint8_t megamorphic;
} ts_prop_ic;
#define TS_PROP_IC_INIT {0}
#ifdef TSAOT_RT_STATS
extern unsigned long long g_ts_pic_get_calls, g_ts_pic_get_hits;
extern unsigned long long g_ts_slot_inline_hits, g_ts_slot_external_hits;
extern unsigned long long g_ts_pic_set_calls, g_ts_pic_set_hits;
#define TS_RT_STAT_PIC_GET_CALL() (g_ts_pic_get_calls++)
#define TS_RT_STAT_PIC_GET_HIT()  (g_ts_pic_get_hits++)
#define TS_RT_STAT_SLOT(o, slot) ((slot) < (o)->h.inline_cap ? g_ts_slot_inline_hits++ : g_ts_slot_external_hits++)
extern unsigned long long g_ts_pic_entry_hits[4], g_ts_pic_keyval_hits, g_ts_pic_ool_hits;
#define TS_RT_STAT_PIC_ENTRY(i) (g_ts_pic_entry_hits[(i)]++)
#define TS_RT_STAT_PIC_KEYVAL() (g_ts_pic_keyval_hits++)
#define TS_RT_STAT_PIC_OOL() (g_ts_pic_ool_hits++)
#define TS_RT_STAT_PIC_SET_CALL() (g_ts_pic_set_calls++)
#define TS_RT_STAT_PIC_SET_HIT()  (g_ts_pic_set_hits++)
#else
#define TS_RT_STAT_PIC_GET_CALL() ((void)0)
#define TS_RT_STAT_PIC_GET_HIT()  ((void)0)
#define TS_RT_STAT_SLOT(o, slot) ((void)0)
#define TS_RT_STAT_PIC_ENTRY(i) ((void)0)
#define TS_RT_STAT_PIC_KEYVAL() ((void)0)
#define TS_RT_STAT_PIC_OOL() ((void)0)
#define TS_RT_STAT_PIC_SET_CALL() ((void)0)
#define TS_RT_STAT_PIC_SET_HIT()  ((void)0)
#endif
/* accessor property: stored as a prop's value (OBJECT-tagged, kind ACCESSOR).
   getter/setter are function values (TS_UNDEFINED when absent). g_this/s_this
   record whether the getter/setter want `this` as a leading arg: true for
   function-expression accessors (this = the object), false for arrow accessors
   (lexical this; they only see their captured cells). */
typedef struct { ts_gc_header h; tsv getter; tsv setter; uint8_t g_this, s_this; } ts_accessor;
/* A Symbol value (symbol_design.md). OBJECT-tagged heap value with kind
   TS_KIND_SYMBOL (no spare NaN-box selector). sym_id is unique per symbol
   (heap identity); === is pointer equality, so Symbol.for / well-known symbols
   are singletons. wksym = TS_WKSYM_* id if this is a well-known symbol, else
   0xffffffff. registered = created via Symbol.for. description is the desc
   string (or undefined). The property key for obj[sym] is TS_KEY_USERSYM(sym_id)
   for ordinary symbols, or TS_KEY_WKSYM(wksym) for well-known ones. */
typedef struct { ts_gc_header h; uint32_t sym_id; uint32_t wksym; uint8_t registered; tsv description; } ts_symbol;
/* Common object header shared by ALL "object-like" GC values (unified object
   model, see docs/unified_object_model.md). Every object kind (plain object,
   class instance, Array, Map, Set, Function, ...) begins with this prefix so the
   dynamic property path (ts_get/ts_set, proto chain) operates on it uniformly.
   ts_object IS this common header (layout unchanged); specialized kinds embed it
   as their first member and append their own fields. The named-property map
   (props) is lazily allocated: NULL/0 until a named property is actually set, so
   element-only arrays stay light (V8-style fast->dictionary transition). */
typedef struct ts_obj_common {
  ts_gc_header h;
  tsv proto;                   /* prototype chain handle (object/function or null) */
  ts_prop* props; uint32_t cap, len;   /* lazily-allocated named-property map */
  /* Objects with enough named properties get a sparse open-addressing index.
     Small objects keep this NULL and retain the cache-friendly linear scan. */
  uint32_t* prop_index;
  uint32_t prop_index_cap;
  /* Low 29 bits are hidden-class identity. The high 3 bits store integrity
     flags (frozen, non-extensible, sealed), keeping the common header compact. */
  uint32_t shape;
} ts_obj_common;
/* ts_object is exactly the common header (plain object / class-instance prefix). */
typedef struct ts_obj_common ts_object;
static inline uint32_t ts_obj_shape_id(const ts_object* o){ return o->shape & TS_SHAPE_MAX; }
static inline uint32_t ts_obj_integrity(const ts_object* o){ return o->shape >> 29; }
static inline void ts_obj_set_shape(ts_object* o, uint32_t shape){
  o->shape = (o->shape & ~TS_SHAPE_MAX) | (shape & TS_SHAPE_MAX);
}
static inline void ts_obj_add_integrity(ts_object* o, uint32_t flags){
  o->shape |= (flags & 7u) << 29;
}
/* In-object value slots (docs/object_model_v2_design.md, slice A3): a plain
   object allocated with inline capacity keeps its first inline_cap property
   values right after the header; the external vector holds the rest. */
#define TS_INLINE_SLOTS_DEFAULT 4u
#define TS_INLINE_SLOTS_MAX 255u
static inline tsv* ts_obj_inline_vals(ts_object* o){ return (tsv*)((char*)o + sizeof(ts_object)); }
static inline tsv* ts_obj_slot_ptr(ts_object* o, uint32_t slot){
  uint32_t ic = o->h.inline_cap;
  return slot < ic ? &ts_obj_inline_vals(o)[slot] : &((tsv*)o->props)[slot - ic];
}
/* A sized class instance (registered struct storage after the header) versus
   a plain object whose cell is the header plus its inline slots. */
static inline int ts_obj_is_sized(const ts_object* o){
  return o->h.size != sizeof(ts_object) + sizeof(tsv) * (size_t)o->h.inline_cap;
}

enum {
  TS_STR_FLAG_ASCII = 1u << 0,
  TS_STR_FLAG_STATIC = 1u << 1,
  TS_STR_FLAG_VIEW = 1u << 2,
  TS_STR_FLAG_HASHED = 1u << 3,
  TS_STR_FLAG_UTF16 = 1u << 4,
  /* Internal-only storage owner for appendable prefix views. A BUFFER value
     must never be returned as a JavaScript string; public values are VIEW
     cells whose parent points at this contiguous storage. */
  TS_STR_FLAG_BUFFER = 1u << 5
};

typedef struct ts_string {
  ts_gc_header h;
  uint32_t len, hash, flags;
  tsv parent;       /* only meaningful for TS_STR_FLAG_VIEW */
  uint32_t offset;  /* UTF-16 code-unit offset into parent view */
  char data[];
} ts_string;

typedef struct ts_strview {
  const char* data;
  uint32_t len;     /* JS length: UTF-16 code units */
  uint32_t hash;
  uint32_t flags;
  /* For an immediate short string data==NULL. The first four native-order
     bytes live here and an optional fifth byte uses hash's low byte (HASHED is
     clear). This fills the struct's former alignment padding, keeping
     sizeof(ts_strview)==24 on 64-bit hosts and avoiding a hot-call ABI change. */
  uint32_t immediate;
} ts_strview;
#if UINTPTR_MAX == UINT64_MAX
typedef char ts_strview_hot_abi_must_stay_24_bytes[
  sizeof(ts_strview) == 24 ? 1 : -1
];
#endif

static inline const char* ts_str_view_data(const ts_strview* v,
                                           char scratch[TS_SHORTSTR_MAX]){
  if (v->data) return v->data;
  uint32_t first = v->len < 4u ? v->len : 4u;
  memcpy(scratch, &v->immediate, first);
  if (v->len > 4u) scratch[4] = (char)(v->hash & 0xffu);
  return scratch;
}
static inline uint32_t ts_str_unit_size_flags(uint32_t flags){
  return (flags & TS_STR_FLAG_UTF16) ? 2u : 1u;
}
static inline uint32_t ts_str_storage_len_flags(uint32_t flags, uint32_t len){
  return len * ts_str_unit_size_flags(flags);
}
static inline uint16_t ts_str_cu_at_contiguous(ts_strview v, uint32_t i){
  if (v.flags & TS_STR_FLAG_UTF16){
    uint16_t cu;
    memcpy(&cu, v.data + ((size_t)i * 2u), sizeof(cu));
    return cu;
  }
  return (uint16_t)(unsigned char)v.data[i];
}
static inline uint16_t ts_str_cu_at_view(ts_strview v, uint32_t i){
  if (TS_RT_UNLIKELY(!v.data)){
    if (i < 4u) return (uint16_t)((const unsigned char*)&v.immediate)[i];
    return (uint16_t)(v.hash & 0xffu);
  }
  return ts_str_cu_at_contiguous(v, i);
}
static inline void ts_str_cu_set(char* data, uint32_t flags, uint32_t i, uint16_t cu){
  if (flags & TS_STR_FLAG_UTF16){
    memcpy(data + ((size_t)i * 2u), &cu, sizeof(cu));
  } else {
    data[i] = (char)(cu & 0xffu);
  }
}
static inline int ts_str_same_storage_width(ts_strview a, ts_strview b){
  return ((a.flags ^ b.flags) & TS_STR_FLAG_UTF16) == 0;
}
static inline int ts_str_unit_eq_at(ts_strview xs, uint32_t xi, ts_strview ns, uint32_t ni){
  if (xs.data && ns.data && ts_str_same_storage_width(xs, ns)){
    uint32_t w = ts_str_unit_size_flags(xs.flags);
    return memcmp(xs.data + (size_t)xi * w, ns.data + (size_t)ni * w, w) == 0;
  }
  return ts_str_cu_at_view(xs, xi) == ts_str_cu_at_view(ns, ni);
}
static inline int ts_str_region_eq(ts_strview xs, uint32_t xi, ts_strview ns, uint32_t ni, uint32_t len){
  if (len == 0) return 1;
  if (xs.data && ns.data && ts_str_same_storage_width(xs, ns)){
    uint32_t w = ts_str_unit_size_flags(xs.flags);
    return memcmp(xs.data + (size_t)xi * w, ns.data + (size_t)ni * w, (size_t)len * w) == 0;
  }
  for (uint32_t k=0;k<len;k++){
    if (ts_str_cu_at_view(xs, xi + k) != ts_str_cu_at_view(ns, ni + k)) return 0;
  }
  return 1;
}
static inline long long ts_str_find_unit_view(ts_strview xs, uint16_t wanted, uint32_t pos, uint32_t len){
  if (pos > xs.len) return -1;
  if (len > xs.len - pos) len = xs.len - pos;
  if (xs.data && !(xs.flags & TS_STR_FLAG_UTF16) && wanted <= 0xffu){
    const char* hit = memchr(xs.data + pos, (int)wanted, len);
    return hit ? (long long)(hit - xs.data) : -1;
  }
  if (xs.data){
    for (uint32_t i=pos;i<pos+len;i++)
      if (ts_str_cu_at_contiguous(xs, i) == wanted) return (long long)i;
    return -1;
  }
  for (uint32_t i=pos;i<pos+len;i++) if (ts_str_cu_at_view(xs, i) == wanted) return (long long)i;
  return -1;
}
static inline int ts_str_contains_unit(ts_strview xs, uint16_t wanted){
  return ts_str_find_unit_view(xs, wanted, 0, xs.len) >= 0;
}

static inline ts_string* ts_str_ptr_typed(tsv s){
  return (ts_string*)ts_ptr(s);
}
static inline ts_string* ts_str_ptr(tsv s){
  return ts_is_heap_str(s) ? (ts_string*)ts_ptr(s) : NULL;
}
/* Keep the common flat/short-string view construction visible to generated C.
   Parent-view traversal is uncommon and substantially larger, so it lives in
   the precompiled runtime rather than being replicated at every call site. */
ts_strview ts_str_view_typed_slow(tsv s);
static inline ts_strview ts_str_view_typed(tsv s){
  if (TS_RT_UNLIKELY(ts_is_short_str(s))){
    uint32_t len = ts_short_str_len(s);
    ts_strview v = { NULL, len, len > 4u ? ts_short_str_byte(s, 4) : 0,
                     TS_STR_FLAG_ASCII, 0 };
    char* bytes = (char*)&v.immediate;
    for (uint32_t i=0;i<len && i<4u;i++) bytes[i] = (char)ts_short_str_byte(s, i);
    return v;
  }
  ts_string* x = ts_str_ptr_typed(s);
  if (TS_RT_UNLIKELY(x->flags & TS_STR_FLAG_VIEW))
    return ts_str_view_typed_slow(s);
  ts_strview v = { x->data, x->len, x->hash, x->flags, 0 };
  return v;
}
static inline int ts_str_view(tsv s, ts_strview* out){
  if (!ts_is_str(s)) return 0;
  *out = ts_str_view_typed(s);
  return 1;
}
static inline const char* ts_str_data_typed(tsv s){
  return ts_is_heap_str(s) ? ts_str_view_typed(s).data : NULL;
}
static inline uint32_t ts_str_hash_typed(tsv s){
  return ts_is_short_str(s) ? 0 : ts_str_view_typed(s).hash;
}
static inline uint32_t ts_str_flags_typed(tsv s){
  return ts_str_view_typed(s).flags;
}

static inline uint32_t ts_str_len_fast(tsv s){
  if (!ts_is_str(s)) return 0;
  return TS_RT_UNLIKELY(ts_is_short_str(s))
    ? ts_short_str_len(s)
    : ts_str_ptr_typed(s)->len;
}
static inline uint32_t ts_str_len_typed(tsv s){
  return TS_RT_UNLIKELY(ts_is_short_str(s))
    ? ts_short_str_len(s)
    : ts_str_ptr_typed(s)->len;
}
static inline long long ts_i64_decimal_len_nonneg(long long x){
  if (x < 10LL) return 1;
  if (x < 100LL) return 2;
  if (x < 1000LL) return 3;
  if (x < 10000LL) return 4;
  if (x < 100000LL) return 5;
  if (x < 1000000LL) return 6;
  if (x < 10000000LL) return 7;
  if (x < 100000000LL) return 8;
  if (x < 1000000000LL) return 9;
  if (x < 10000000000LL) return 10;
  if (x < 100000000000LL) return 11;
  if (x < 1000000000000LL) return 12;
  if (x < 10000000000000LL) return 13;
  if (x < 100000000000000LL) return 14;
  if (x < 1000000000000000LL) return 15;
  if (x < 10000000000000000LL) return 16;
  if (x < 100000000000000000LL) return 17;
  if (x < 1000000000000000000LL) return 18;
  return 19;
}
static inline double ts_str_charcodeat_fast(tsv s, double idx){
  if (!ts_is_str(s)) return NAN;
  ts_strview x = ts_str_view_typed(s);
  if (isnan(idx)) idx = 0;
  if (!x.len || idx <= -1 || idx >= (double)x.len) return NAN;
  long i = (long)idx;
  return (double)ts_str_cu_at_view(x, (uint32_t)i);
}
static inline double ts_str_charcodeat_general(tsv s, double idx){
  ts_strview x = ts_str_view_typed(s);
  if (isnan(idx)) idx = 0;
  if (!x.len || idx <= -1 || idx >= (double)x.len) return NAN;
  long i = (long)idx;
  return (double)ts_str_cu_at_view(x, (uint32_t)i);
}
/* Scanner loops call this per code unit. The flat one-byte heap string with an
   in-range index is a few instructions, small enough for the O1 cost model;
   NaN, negative, out-of-range, short, view and UTF-16 cases take the general
   path (a NaN index fails both range tests and is handled there). */
static inline double ts_str_charcodeat_typed(tsv s, double idx){
  if (TS_RT_LIKELY(ts_is_heap_str(s))){
    const ts_string* x = ts_str_ptr_typed(s);
    if (TS_RT_LIKELY(!(x->flags & (TS_STR_FLAG_VIEW | TS_STR_FLAG_UTF16))) &&
        idx >= 0 && idx < (double)x->len)
      return (double)(unsigned char)x->data[(uint32_t)idx];
  }
  return ts_str_charcodeat_general(s, idx);
}
static inline long long ts_str_charcodeat_i64_general(tsv s, long long i){
  ts_strview x = ts_str_view_typed(s);
  if (i < 0 || i >= (long long)x.len) return 0;
  return (long long)ts_str_cu_at_view(x, (uint32_t)i);
}
static inline long long ts_str_charcodeat_i64_typed(tsv s, long long i){
  if (TS_RT_LIKELY(ts_is_heap_str(s))){
    const ts_string* x = ts_str_ptr_typed(s);
    if (TS_RT_LIKELY(!(x->flags & (TS_STR_FLAG_VIEW | TS_STR_FLAG_UTF16))) &&
        (unsigned long long)i < (unsigned long long)x->len)
      return (long long)(unsigned char)x->data[(uint32_t)i];
  }
  return ts_str_charcodeat_i64_general(s, i);
}
static inline long long ts_str_slice_charcodeat_i64_typed(tsv s, long long start, long long len, long long i){
  if (i < 0 || i >= len) return 0;
  return ts_str_charcodeat_i64_typed(s, start + i);
}
static inline long long ts_str_slice_charcodeat_fast_i64_typed(tsv s, long long start, long long len, long long i, int fast){
  if (fast && (uint64_t)i < (uint64_t)len){
    ts_strview x = ts_str_view_typed(s);
    return (long long)ts_str_cu_at_view(x, (uint32_t)(start + i));
  }
  return ts_str_slice_charcodeat_i64_typed(s, start, len, i);
}
static inline double ts_str_slice_charcodeat_typed(tsv s, long long start, long long len, double idx){
  if (isnan(idx)) idx = 0;
  if (!len || idx <= -1 || idx >= (double)len) return NAN;
  ts_strview x = ts_str_view_typed(s);
  return (double)ts_str_cu_at_view(x, (uint32_t)(start + (long long)idx));
}
/* General multi-code-unit and mixed-width scanning is an out-of-line worker.
   The allocation-free one-byte/single-unit case stays in the header because it
   collapses to memchr at generated call sites. */
long long ts_str_find_forward_view_slow(ts_strview xs, ts_strview ns, long long start);
static inline long long ts_str_find_forward_view(ts_strview xs, ts_strview ns, long long start){
  if (start < 0) start = 0;
  if (ns.len == 0) return start > (long long)xs.len ? (long long)xs.len : start;
  if (ns.len > xs.len || start > (long long)xs.len - (long long)ns.len) return -1;
  if (ns.len == 1 && xs.data && ns.data &&
      ts_str_same_storage_width(xs, ns) &&
      !(xs.flags & TS_STR_FLAG_UTF16)){
    const char* hit = memchr(xs.data + start, ns.data[0],
                             xs.len - (uint32_t)start);
    return hit ? (long long)(hit - xs.data) : -1;
  }
  return ts_str_find_forward_view_slow(xs, ns, start);
}
long long ts_str_find_backward_view_slow(ts_strview xs, ts_strview ns, long long start);
static inline long long ts_str_find_backward_view(ts_strview xs, ts_strview ns, long long start){
  long long maxstart = (long long)xs.len - (long long)ns.len;
  if (ns.len == 0){
    if (start < 0) return 0;
    return start > (long long)xs.len ? (long long)xs.len : start;
  }
  if (ns.len > xs.len) return -1;
  if (start > maxstart) start = maxstart;
  if (start < 0) return -1;
  return ts_str_find_backward_view_slow(xs, ns, start);
}
typedef struct ts_regexp_litprefix_match {
  uint32_t start;
  uint32_t end;
} ts_regexp_litprefix_match;

/* RegExp literal-prefix fast-path substrate. This does not implement RegExp
   semantics; it is the shared scanner contract for future AOT paths that have
   already proven a pattern has a literal prefix. Positions are UTF-16 code-unit
   indices, matching JS string indexing and QuickJS/libregexp integration. */
static inline int ts_regexp_litprefix_find_view(ts_strview xs, ts_strview prefix,
                                                long long start, int sticky,
                                                ts_regexp_litprefix_match* out){
  if (start < 0) start = 0;
  if (start > (long long)xs.len) start = (long long)xs.len;
  long long hit;
  if (sticky){
    if (prefix.len > xs.len - (uint32_t)start) return 0;
    hit = ts_str_region_eq(xs, (uint32_t)start, prefix, 0, prefix.len) ? start : -1;
  } else {
    hit = ts_str_find_forward_view(xs, prefix, start);
  }
  if (hit < 0) return 0;
  if (out){
    out->start = (uint32_t)hit;
    out->end = (uint32_t)hit + prefix.len;
  }
  return 1;
}
static inline tsv ts_regexp_litprefix_test_fast(tsv s, tsv prefix, int sticky){
  if (!ts_is_str(s) || !ts_is_str(prefix)) return ts_bool(0);
  ts_strview xs = ts_str_view_typed(s), ps = ts_str_view_typed(prefix);
  return ts_bool(ts_regexp_litprefix_find_view(xs, ps, 0, sticky, NULL));
}
static inline double ts_regexp_litprefix_search_fast(tsv s, tsv prefix, int sticky){
  if (!ts_is_str(s) || !ts_is_str(prefix)) return -1;
  ts_strview xs = ts_str_view_typed(s), ps = ts_str_view_typed(prefix);
  ts_regexp_litprefix_match m = {0, 0};
  return ts_regexp_litprefix_find_view(xs, ps, 0, sticky, &m) ? (double)m.start : -1;
}
static inline double ts_str_indexof_fast(tsv s, tsv needle, double from, int has_from){
  if (!ts_is_str(s) || !ts_is_str(needle)) return -1;
  ts_strview xs = ts_str_view_typed(s), ns = ts_str_view_typed(needle);
  long long start = has_from ? (long long)from : 0;
  return (double)ts_str_find_forward_view(xs, ns, start);
}
static inline double ts_str_lastindexof_fast(tsv s, tsv needle, double from, int has_from){
  if (!ts_is_str(s) || !ts_is_str(needle)) return -1;
  ts_strview xs = ts_str_view_typed(s), ns = ts_str_view_typed(needle);
  long long start = has_from ? (long long)from : (long long)xs.len - (long long)ns.len;
  return (double)ts_str_find_backward_view(xs, ns, start);
}
long long ts_str_replace_literal_metric3(tsv s, tsv pat, tsv rep, tsv needle,
                                         long long char_idx, int all);
long long ts_str_split_join_metric3(tsv s, tsv sep, tsv join_sep,
                                    long long part_index);

/* A JS array uses contiguous storage plus an internal hole sentinel.  The
   sentinel keeps sparse-array presence distinct from an explicit `undefined`
   without adding a side allocation/bitmap to the common dense case. */
typedef struct ts_array {
  ts_obj_common o;   /* proto + lazily-allocated named-property map (unified model) */
  tsv* data; uint32_t len, cap;   /* element fast path */
  uint8_t element_kind;          /* 0 ordinary array, 1 fixed Uint16 storage */
  /* Minor-GC dirty cards fit in the existing padding before inline_data.
     A zero end means empty; generic writes/reordering request a full scan. */
  uint8_t gc_dirty_all;
  uint16_t gc_dirty_first, gc_dirty_end;
  /* Sparse element storage (far stores): nonzero means data is NULL, cap is 0
     and inline_data[0] holds the index -> value side table (ts_rt.c). Dense
     arrays keep every slot in [len, cap) a hole, so readers bound by cap. */
  uint8_t sparse, arr_spare;
  tsv inline_data[4];             /* avoids a second malloc for small arrays */
} ts_array;

static inline int ts_is_indexed_array_fast(tsv v){
  return ts_is_obj(v) && ((ts_gc_header*)ts_ptr(v))->kind == TS_KIND_ARRAY;
}
static inline int ts_is_array_fast(tsv v){
  return ts_is_indexed_array_fast(v) && ((ts_array*)ts_ptr(v))->element_kind == 0;
}
static inline uint32_t ts_array_len_fast(tsv arr){
  return ts_is_indexed_array_fast(arr) ? ((ts_array*)ts_ptr(arr))->len : 0;
}
TS_RT_ALWAYS_INLINE int ts_truthy_fast(tsv v){
  if (ts_is_num(v)){ double d=ts_to_num(v); return d!=0 && !(d!=d); }
  uint16_t t = TS_TOP16(v);
  if (t == TS_SEL_OBJECT || t == TS_SEL_FUNC) return 1;
  if (t == TS_SEL_BOOL) return (int)(v&1);
  if (t == TS_SEL_UNDEF || t == TS_SEL_NULL) return 0;
  return ts_truthy(v);   /* strings (and short strings): length test out of line */
}
static inline int ts_is_nullish_fast(tsv v){ return ts_is_null(v) || ts_is_undef(v); }
/* `typeof x === "lit"` as a tag test (the emitter fuses the compare); each
   predicate mirrors ts_typeof's classification order exactly. */
int ts_is_symbol(tsv v);
static inline int ts_typeof_is_number(tsv v){ return ts_is_num(v); }
static inline int ts_typeof_is_string(tsv v){ return !ts_is_num(v) && ts_is_str(v); }
static inline int ts_typeof_is_boolean(tsv v){ return !ts_is_num(v) && !ts_is_str(v) && ts_is_bool(v); }
static inline int ts_typeof_is_undefined(tsv v){ return !ts_is_num(v) && !ts_is_str(v) && !ts_is_bool(v) && ts_is_undef(v); }
static inline int ts_typeof_is_function(tsv v){ return !ts_is_num(v) && !ts_is_str(v) && !ts_is_bool(v) && !ts_is_undef(v) && ts_is_func(v); }
static inline int ts_typeof_is_symbol(tsv v){ return !ts_is_num(v) && !ts_is_str(v) && !ts_is_bool(v) && !ts_is_undef(v) && !ts_is_func(v) && ts_is_symbol(v); }
static inline int ts_typeof_is_object(tsv v){ return !ts_is_num(v) && !ts_is_str(v) && !ts_is_bool(v) && !ts_is_undef(v) && !ts_is_func(v) && !ts_is_symbol(v); }
static inline int ts_is_undefined_fast(tsv v){ return ts_is_undef(v); }

/* JS Map: parallel key/value arrays preserving insertion order, plus a side
   hash index (P2a). The dense arrays stay the GC-scanned ground truth; deleted
   entries become internal HOLE sentinels (tombs counts them, live size =
   len - tombs) and are compacted away past a threshold. The index maps hash
   slots to dense positions and holds no tsv, so the collector ignores it.
   Small maps (few live entries) skip the index and probe linearly. */
typedef struct ts_map {
  ts_obj_common o;   /* proto + lazy named-prop map (unified model) */
  tsv* keys; tsv* vals; uint32_t len, cap;
  uint32_t* hashes;  /* cached SameValueZero hash parallel to keys */
  uint32_t* index;   /* hash slots: 0=empty, 1=tombstone, else dense idx+2 */
  uint32_t index_cap; /* power-of-2 slot count (0 = linear mode) */
  uint32_t tombs;    /* HOLE entries in keys/vals below len */
  uint8_t weak;      /* WeakMap: keys are weak and values are ephemerons */
  /* Reuse alignment padding for the same dirty-card span as arrays. */
  uint8_t gc_dirty_all;
  uint16_t gc_dirty_first, gc_dirty_end;
  uint64_t* iteration_order; /* lazily allocated stable insertion IDs */
  uint64_t next_iteration_order;
} ts_map;

/* JS Set: insertion-ordered element array, SameValueZero membership; same
   dense + side-index scheme as ts_map. */
typedef struct ts_set_t {
  ts_obj_common o;   /* proto + lazy named-prop map (unified model) */
  tsv* elems; uint32_t len, cap;
  uint32_t* hashes;  /* cached SameValueZero hash parallel to elems */
  uint32_t* index;
  uint32_t index_cap;
  uint32_t tombs;
  uint8_t weak;      /* WeakSet: elements are weak keys */
  uint64_t* iteration_order; /* lazily allocated stable insertion IDs */
  uint64_t next_iteration_order;
} ts_set_t;

/* a closure: code pointer + captured environment (array of cells) */
typedef struct ts_func {
  ts_obj_common o;   /* proto + lazy named-prop map (unified model) */
  void* code;            /* function pointer (cast by the emitted call site) */
  tsv* env; uint32_t envlen;
  uint8_t takes_this;    /* 1 if the callee reads args[0] as `this` (methods,
                            functions written with a `this` param, bound fns) */
  uint8_t constructable; /* 1 iff `new fn()` may construct (ES5 [[Construct]]):
                            set by ts_set_fn_prototype, i.e. exactly the functions
                            the exporter marks FN_HAS_PROTOTYPE (declarations and
                            function expressions; not arrows/methods/async/
                            generators/builtins). Stays 1 even if fn.prototype is
                            later reassigned to a non-object (JS keeps the function
                            a constructor; construction falls back to
                            Object.prototype). Known gap: a bound function is
                            constructable in V8 but not marked here. */
  uint8_t ctor_pending;  /* 1 while the fresh prototype's own `constructor`
                            data property has not been materialized yet. The
                            runtime defines it on the first observation of
                            fn.prototype (get, construct, descriptor). Occupies
                            former padding, so the cell layout is unchanged. */
  uint8_t proto_lazy;    /* 1 while the function owns a `.prototype` whose
                            object has not been created yet (prototype_prop is
                            still TS_UNDEFINED). Created, together with its
                            `constructor`, on the same first observation. */
  /* For a CLASS VALUE (a class used as a runtime value, `const K = C`): the
     class id PLUS ONE (0 = ordinary function/closure, not a constructor). `new K()`
     reads this via ts_construct. code holds the constructor cfunc; env holds the
     captured cells (function-local captures threaded as ctor leading params). */
  uint32_t class_id;
  /* JS first-class metadata, set when a function is boxed as a VALUE:
     `fn.length` (arity) and `fn.name`. name is a static C string (0 = ""). */
  uint16_t arity;
  /* 1: the code reads its captured cells from g_ts_cur_env (environment
     ABI, production emitter). 0: the legacy merged convention, where ts_call
     prepends env to the argument array (runtime thunks, frozen emitter). */
  uint8_t env_abi;
  /* Plain-function constructor (`new fn()`): learned in-object slot count for
     its instances (0 = not constructed yet); grows with the largest instance. */
  uint8_t inst_slots;
  const char* name;
  /* JS own "prototype" data property for constructable functions/classes.
     TS_UNDEFINED means this function has no own prototype property (arrows,
     methods, builtins, Function.prototype itself). */
  tsv prototype_prop;
} ts_func;

/* runtime API */
tsv  ts_new_object(void);
tsv  ts_new_object_pretenured(void);
/* plain object with `slots` in-object value slots (object literal sites). */
tsv  ts_new_object_n(uint32_t slots);
tsv  ts_new_object_n_pretenured(uint32_t slots);
tsv  ts_new_proto(void);   /* a plain object used as a class prototype */
tsv  ts_new_proto_pretenured(void);
tsv  ts_object_proto(void);
void ts_install_object_proto(tsv proto);
void ts_global_this_init(void);
tsv  ts_global_this(void);
tsv  ts_global_get(const char* name);
void ts_global_set(const char* name, tsv val);
void ts_global_var_decl(const char* name);
void ts_set_cstr(tsv obj, const char* name, tsv val);
void ts_set_tostring_key(ts_key key);
void ts_set_valueof_key(ts_key key);
void ts_set_tojson_key(ts_key key);
tsv  ts_to_primitive(tsv v, int string_hint);

tsv  ts_objproto_toString(tsv* args, int n);
tsv  ts_objproto_tostring_call(tsv v);
tsv  ts_objproto_valueOf(tsv* args, int n);
tsv  ts_objproto_toLocaleString(tsv* args, int n);
tsv  ts_objproto_hasOwnProperty(tsv* args, int n);
tsv  ts_objproto_isPrototypeOf(tsv* args, int n);
tsv  ts_objproto_propertyIsEnumerable(tsv* args, int n);
tsv  ts_get_proto(tsv obj);            /* Object.getPrototypeOf: returns proto or null */
tsv  ts_set_proto(tsv obj, tsv proto); /* Object.setPrototypeOf: relinks proto, returns obj */
/* Built-in Error family: shared prototype objects + instance constructor so that
   `new Error()` / thrown errors are `instanceof Error` and inherit `name`.
   kind: 0=Error 1=TypeError 2=RangeError 3=SyntaxError 4=ReferenceError
   5=EvalError 6=URIError 7=AggregateError. */
void ts_setup_error_protos(void);
tsv  ts_error_proto(int kind);
tsv  ts_new_error(int kind, tsv msg);
/* first-class callable function values (methods and closures alike) */
typedef tsv (*ts_code)(tsv*, int);
void ts_object_proto_register(ts_key method_key, const char* name, ts_code fn);
/* unified object model: Array.prototype setup (populated by emitted setup which
   knows the per-program method-name ids). */
tsv  ts_array_proto(void);
void ts_array_proto_init(void);
void ts_array_proto_register(ts_key method_key, const char* name, ts_code fn);
/* Promise.prototype setup (then/catch/finally as first-class method values). */
tsv  ts_promise_proto(void);
void ts_promise_proto_init(void);
void ts_promise_proto_register(ts_key method_key, const char* name, ts_code fn);
tsv ts_promiseproto_then(tsv* a, int n);
tsv ts_promiseproto_catch(tsv* a, int n);
tsv ts_promiseproto_finally(tsv* a, int n);
/* Map.prototype / Set.prototype setup (followon to U-5). */
tsv  ts_map_proto(void);
tsv  ts_set_proto_obj(void);
tsv  ts_weakmap_proto(void);
tsv  ts_weakset_proto_obj(void);
tsv  ts_headers_proto(void);
tsv  ts_abort_controller_proto(void);
tsv  ts_abort_signal_proto(void);
void ts_map_proto_init(void);
void ts_set_proto_init(void);
void ts_weakmap_proto_init(void);
void ts_weakset_proto_init(void);
void ts_headers_proto_init(void);
void ts_abort_controller_proto_init(void);
void ts_abort_signal_proto_init(void);
void ts_map_proto_register(ts_key method_key, const char* name, ts_code fn);
void ts_set_proto_register(ts_key method_key, const char* name, ts_code fn);
void ts_weakmap_proto_register(ts_key method_key, const char* name, ts_code fn);
void ts_weakset_proto_register(ts_key method_key, const char* name, ts_code fn);
void ts_headers_proto_register(ts_key method_key, const char* name, ts_code fn);
/* Function.prototype setup (call/apply/bind). */
tsv  ts_function_proto(void);
void ts_function_proto_init(void);
void ts_function_proto_register(ts_key method_key, const char* name, ts_code fn);
tsv  ts_make_fn_t(ts_code code, tsv* env, uint32_t envlen, int takes_this);
tsv  ts_make_fn_t_pretenured(ts_code code, tsv* env, uint32_t envlen, int takes_this);
tsv ts_funcproto_call(tsv* args, int n);
tsv ts_funcproto_apply(tsv* args, int n);
tsv ts_funcproto_bind(tsv* args, int n);
/* String.prototype setup (any-typed string method dispatch). */
tsv  ts_string_proto(void);
void ts_string_proto_init(void);
void ts_string_proto_register(ts_key method_key, const char* name, ts_code fn);
/* RegExp.prototype setup. The prototype itself lives in the core runtime, but
   generated RegExp method wrappers live in emitted C so no-RegExp programs do not
   reference the optional QuickJS adapter. */
tsv  ts_regexp_proto(void);
void ts_regexp_proto_init(void);
void ts_regexp_proto_register(ts_key method_key, const char* name, ts_code fn);
tsv  ts_regexp_object_init(tsv re);
int  ts_regexp_is_object(tsv re);
tsv ts_strproto_toUpperCase(tsv* a, int n);
tsv ts_strproto_toLowerCase(tsv* a, int n);
tsv ts_strproto_toLocaleUpperCase(tsv* a, int n);
tsv ts_strproto_toLocaleLowerCase(tsv* a, int n);
tsv ts_strproto_slice(tsv* a, int n);
tsv ts_strproto_indexOf(tsv* a, int n);
tsv ts_strproto_lastIndexOf(tsv* a, int n);
tsv ts_strproto_includes(tsv* a, int n);
tsv ts_strproto_startsWith(tsv* a, int n);
tsv ts_strproto_endsWith(tsv* a, int n);
tsv ts_strproto_charAt(tsv* a, int n);
tsv ts_strproto_charCodeAt(tsv* a, int n);
tsv ts_strproto_codePointAt(tsv* a, int n);
tsv ts_strproto_substring(tsv* a, int n);
tsv ts_strproto_substr(tsv* a, int n);
tsv ts_strproto_toString(tsv* a, int n);
tsv ts_strproto_at(tsv* a, int n);
tsv ts_strproto_isWellFormed(tsv* a, int n);
tsv ts_strproto_toWellFormed(tsv* a, int n);
tsv ts_strproto_concat(tsv* a, int n);
tsv ts_strproto_repeat(tsv* a, int n);
tsv ts_strproto_trim(tsv* a, int n);
tsv ts_strproto_trimStart(tsv* a, int n);
tsv ts_strproto_trimEnd(tsv* a, int n);
tsv ts_strproto_trimLeft(tsv* a, int n);
tsv ts_strproto_trimRight(tsv* a, int n);
tsv ts_strproto_split(tsv* a, int n);
tsv ts_strproto_padStart(tsv* a, int n);
tsv ts_strproto_padEnd(tsv* a, int n);
tsv ts_strproto_replace(tsv* a, int n);
tsv ts_strproto_replaceAll(tsv* a, int n);
/* Number.prototype setup (any-typed number method dispatch). */
tsv  ts_number_proto(void);
void ts_number_proto_init(void);
void ts_number_proto_register(ts_key method_key, const char* name, ts_code fn);
tsv ts_numproto_toFixed(tsv* a, int n);
tsv ts_numproto_toString(tsv* a, int n);
tsv ts_numproto_toPrecision(tsv* a, int n);
tsv ts_numproto_valueOf(tsv* a, int n);
/* Boolean.prototype setup (any-typed boolean method dispatch). */
tsv  ts_boolean_proto(void);
void ts_boolean_proto_init(void);
void ts_boolean_proto_register(ts_key method_key, const char* name, ts_code fn);
tsv ts_boolproto_toString(tsv* a, int n);
tsv ts_boolproto_valueOf(tsv* a, int n);
tsv ts_mapproto_set(tsv* a, int n); tsv ts_mapproto_get(tsv* a, int n);
tsv ts_mapproto_has(tsv* a, int n); tsv ts_mapproto_delete(tsv* a, int n);
tsv ts_mapproto_clear(tsv* a, int n); tsv ts_mapproto_keys(tsv* a, int n);
tsv ts_mapproto_values(tsv* a, int n); tsv ts_mapproto_forEach(tsv* a, int n);
tsv ts_mapproto_entries(tsv* a, int n);
tsv ts_setproto_add(tsv* a, int n); tsv ts_setproto_has(tsv* a, int n);
tsv ts_setproto_delete(tsv* a, int n); tsv ts_setproto_clear(tsv* a, int n);
tsv ts_setproto_keys(tsv* a, int n); tsv ts_setproto_values(tsv* a, int n);
tsv ts_setproto_entries(tsv* a, int n); tsv ts_setproto_forEach(tsv* a, int n);
tsv ts_weakmapproto_set(tsv* a, int n); tsv ts_weakmapproto_get(tsv* a, int n);
tsv ts_weakmapproto_has(tsv* a, int n); tsv ts_weakmapproto_delete(tsv* a, int n);
tsv ts_weaksetproto_add(tsv* a, int n); tsv ts_weaksetproto_has(tsv* a, int n);
tsv ts_weaksetproto_delete(tsv* a, int n);
tsv ts_headersproto_get(tsv* a, int n); tsv ts_headersproto_has(tsv* a, int n);
tsv ts_headersproto_keys(tsv* a, int n); tsv ts_headersproto_values(tsv* a, int n);
tsv ts_headersproto_entries(tsv* a, int n); tsv ts_headersproto_append(tsv* a, int n);
tsv ts_headersproto_set(tsv* a, int n); tsv ts_headersproto_delete(tsv* a, int n);
/* Array.prototype method wrappers (ts_code signature, this = args[0]). */
tsv ts_arrproto_join(tsv* args, int n);
tsv ts_arrproto_toString(tsv* args, int n);
tsv ts_arrproto_indexOf(tsv* args, int n);
tsv ts_arrproto_includes(tsv* args, int n);
tsv ts_arrproto_lastIndexOf(tsv* args, int n);
tsv ts_arrproto_slice(tsv* args, int n);
tsv ts_arrproto_concat(tsv* args, int n);
tsv ts_arrproto_join_pop(tsv* args, int n);
tsv ts_arrproto_pop(tsv* args, int n);
tsv ts_arrproto_push(tsv* args, int n);
tsv ts_arrproto_shift(tsv* args, int n);
tsv ts_arrproto_unshift(tsv* args, int n);
tsv ts_arrproto_reverse(tsv* args, int n);
tsv ts_arrproto_at(tsv* args, int n);
tsv ts_arrproto_fill(tsv* args, int n);
tsv ts_arrproto_flat(tsv* args, int n);
tsv ts_arrproto_sort(tsv* args, int n);
tsv ts_arrproto_map(tsv* args, int n);
tsv ts_arrproto_filter(tsv* args, int n);
tsv ts_arrproto_forEach(tsv* args, int n);
tsv ts_arrproto_reduce(tsv* args, int n);
tsv ts_arrproto_splice(tsv* args, int n);
tsv ts_arrproto_reduceRight(tsv* args, int n);
tsv ts_arrproto_copyWithin(tsv* args, int n);
tsv ts_arrproto_find(tsv* args, int n);
tsv ts_arrproto_findIndex(tsv* args, int n);
tsv ts_arrproto_findLast(tsv* args, int n);
tsv ts_arrproto_findLastIndex(tsv* args, int n);
tsv ts_arrproto_some(tsv* args, int n);
tsv ts_arrproto_every(tsv* args, int n);
tsv ts_arrproto_flatMap(tsv* args, int n);

tsv  ts_make_fn(ts_code code, tsv* env, uint32_t envlen); /* boxed callable; env may be NULL */
tsv  ts_call(tsv fn, tsv* args, int nargs);               /* invoke a callable value */
tsv  ts_call_value(tsv fn, tsv* args, int nargs);         /* value/callback call (injects undefined this if takes_this) */
tsv  ts_call_method(tsv fn, tsv* args, int nargs);        /* method dispatch (args[0]=this); drops receiver if callee lacks takes_this */
int  ts_is_callable(tsv v);
tsv  ts_new_sized(size_t size);
tsv  ts_new_sized_pretenured(size_t size);
/* arrays (contiguous storage with an internal sparse-hole sentinel) */
tsv  ts_new_array(uint32_t len);    /* length-len sparse array (all slots holes) */
tsv  ts_new_uint16_array(tsv input);
tsv  ts_new_array_pretenured(uint32_t len);
tsv  ts_array_get(tsv arr, uint32_t i);
/* Object literal / constructor layouts (docs/object_layout_design.md): the
   static property sequence of a site, resolved to its shape at first use. */
typedef struct ts_lit_layout { uint32_t shape; uint32_t n; const ts_key* keys; } ts_lit_layout;
tsv ts_new_object_layout(ts_lit_layout* layout);
tsv ts_new_object_layout_pretenured(ts_lit_layout* layout);
/* Give a fresh empty object the layout in one step; 1 when its slots now
   follow the layout (store by slot), 0 when the object was not empty. */
int ts_obj_adopt_layout(tsv obj, ts_lit_layout* layout);
void ts_array_set(tsv arr, uint32_t i, tsv v);
void ts_array_push(tsv arr, tsv v);
void ts_array_push_hole(tsv arr);
int  ts_array_has_index(tsv arr, uint32_t i);
uint32_t ts_array_len(tsv arr);
double   ts_length(tsv v);

/* stdlib: String methods */
tsv ts_str_toupper(tsv s);
tsv ts_str_tolower(tsv s);
tsv ts_str_slice(tsv s, double start, double end, int has_end);
tsv ts_str_substring(tsv s, double start, double end, int has_end);
tsv ts_str_substr(tsv s, tsv start, tsv length);
tsv ts_str_value(tsv s);
double ts_str_indexof(tsv s, tsv needle, double from, int has_from);
double ts_str_lastindexof(tsv s, tsv needle, double from, int has_from);
tsv ts_number_to_fixed(tsv numv, double digits);
tsv ts_number_to_string_radix(tsv numv, double radix);
tsv ts_number_to_precision(tsv numv, double prec);
int ts_str_includes(tsv s, tsv needle, double pos, int has_pos);
tsv ts_str_charat(tsv s, double idx);
tsv ts_str_codepointat(tsv s, double idx);
double ts_str_charcodeat(tsv s, double idx);
tsv ts_str_concat(tsv a, tsv b);
tsv ts_str_repeat(tsv s, double count);
tsv ts_str_trim(tsv s);
tsv ts_str_split(tsv s, tsv sep, tsv limit);
/* stdlib: Array methods */
tsv ts_array_map(tsv arr, tsv cb);
tsv ts_array_filter(tsv arr, tsv cb);
tsv ts_array_foreach(tsv arr, tsv cb);
tsv ts_array_reduce(tsv arr, tsv cb, tsv init, int has_init);
tsv ts_array_reduce_right(tsv arr, tsv cb, tsv init, int has_init);
tsv ts_array_splice(tsv arr, double start, double dc, int has_dc, tsv items);
tsv  ts_array_splice_drop(tsv arr, double start, double dc, int has_dc, tsv items);   /* result discarded: returns undefined */
tsv  ts_array_splice_insert1(tsv arr, double start, tsv item);                          /* splice(start, 0, item), result discarded */
tsv ts_array_new_length(double n);
tsv ts_array_copy_within(tsv arr, double target, double start, double end, int has_end);
double ts_array_indexof(tsv arr, tsv v, double from, int has_from);
int ts_array_includes(tsv arr, tsv v, double from, int has_from);
tsv ts_array_slice(tsv arr, double start, double end, int has_end);
/* ES2023 change-by-copy: return a NEW array, leaving the receiver unchanged. */
tsv ts_array_tosorted(tsv arr, tsv cb);
tsv ts_array_toreversed(tsv arr);
tsv ts_array_with(tsv arr, double idx, tsv val);
tsv ts_array_tospliced(tsv arr, double start, double dc, int has_dc, tsv items);
tsv ts_array_concat(tsv x, tsv y);
tsv ts_array_join(tsv arr, tsv sep);
tsv ts_array_pop(tsv arr);
tsv ts_unsupported_builtin(const char* name);
tsv ts_regexp_object_test_fast(tsv re, tsv input);
double ts_regexp_object_search_fast(tsv input, tsv re);
tsv ts_regexp_object_exec_fast(tsv re, tsv input);
tsv ts_regexp_object_match_fast(tsv re, tsv input);

/* Math (libm-backed; single-arg ones are emitted inline by codegen) */
double ts_math_round(double x);
double ts_math_sign(double x);
double ts_math_trunc(double x);
double ts_math_max2(double a, double b);
double ts_math_min2(double a, double b);
double ts_math_cbrt(double x);
double ts_math_clz32(double x);
double ts_math_imul(double a, double b);
double ts_math_f16round(double x);
double ts_math_log2(double x);
double ts_math_log10(double x);
double ts_math_hypot2(double a, double b);
double ts_math_max_arr(tsv arr);
double ts_math_min_arr(tsv arr);
double ts_math_hypot_arr(tsv arr);
double ts_math_random(void);
/* Number */
int    ts_number_is_integer(tsv v);
int    ts_number_is_finite(tsv v);
int    ts_number_is_nan(tsv v);
int    ts_number_is_safe_integer(tsv v);
double ts_number_coerce_slow(tsv v);
/* JS ToNumber. The number case is the overwhelmingly common one at emitted
   sites; strings, objects and the remaining primitives convert out of line. */
static inline double ts_number_coerce(tsv v){
  return ts_is_num(v) ? ts_to_num(v) : ts_number_coerce_slow(v);
}
double ts_parse_float(tsv v);
double ts_parse_int(tsv v, double radix);
tsv    ts_number_tofixed(double x, double digits);
/* Date */
tsv    ts_date_now_ms(void);
double ts_date_from_components(double y,double mo,double d,double h,double mi,double s,double mil);
double ts_date_component(double ms, int which);
tsv    ts_date_to_iso(double ms);
tsv    ts_date_to_locale_time(double ms, tsv locales, tsv options);

/* Array: additional methods */
tsv    ts_array_find(tsv arr, tsv cb);
double ts_array_findindex(tsv arr, tsv cb);
tsv    ts_array_findlast(tsv arr, tsv cb);
double ts_array_findlastindex(tsv arr, tsv cb);
tsv    ts_array_flat(tsv arr, double depth);
tsv    ts_array_flatmap(tsv arr, tsv cb);
tsv    ts_string_from_char_code(tsv* args, int n);
tsv    ts_string_from_code_point(tsv* args, int n);
tsv    ts_array_of(tsv* args, int n);
int    ts_array_some(tsv arr, tsv cb);
int    ts_array_every(tsv arr, tsv cb);
double ts_array_lastindexof(tsv arr, tsv v, double from, int has_from);
tsv    ts_array_at(tsv arr, double idx);
tsv    ts_array_reverse(tsv arr);
tsv    ts_array_shift(tsv arr);
double ts_array_unshift(tsv arr, tsv v);
tsv    ts_array_fill(tsv arr, tsv v, double start, double end, int has_start, int has_end);
tsv    ts_array_sort(tsv arr, tsv cb);
/* String: additional methods */
int    ts_str_startswith(tsv s, tsv pre, double pos, int has_pos);
int    ts_str_endswith(tsv s, tsv suf, double endpos, int has_endpos);
tsv    ts_str_padstart(tsv s, double target, tsv pad);
tsv    ts_str_padend(tsv s, double target, tsv pad);
tsv    ts_str_trimstart(tsv s);
tsv    ts_str_trimend(tsv s);
tsv    ts_str_at(tsv s, double idx);
int    ts_str_is_well_formed(tsv s);
tsv    ts_str_to_well_formed(tsv s);
tsv    ts_str_replace(tsv s, tsv pat, tsv rep, int all);
void   ts_array_push_all(tsv dst, tsv src);
tsv    ts_array_from(tsv src);
tsv    ts_array_from_mapped(tsv src, tsv fn);
int    ts_has_prop(tsv obj, ts_key key);
int    ts_is_nullish(tsv v);
int    ts_is_undefined(tsv v);
void   ts_object_copy_props(tsv dst, tsv src);
int    ts_delete_prop(tsv obj, ts_key key);
int    ts_delete_prop_strict(tsv obj, ts_key key);
tsv    ts_delete_dynamic_strict(tsv obj, tsv key, const uint32_t* method_pairs, uint32_t count);
int    ts_has_prop_dyn(tsv obj, tsv keyv);
int    ts_has_own(tsv obj, ts_key key);
int    ts_has_own_dyn(tsv obj, tsv keyv);
tsv    ts_object_rest(tsv src, const uint32_t* excl, int nexcl);
tsv    ts_get_dyn(tsv obj, tsv keyv);
tsv    ts_get_checked(tsv obj, ts_key key);
tsv    ts_get_dyn_checked(tsv obj, tsv keyv);
tsv    ts_get_pic_checked(tsv obj, ts_key key, ts_prop_ic* ic);
tsv    ts_get_dyn_pic_checked(tsv obj, tsv keyv, ts_prop_ic* ic);
void   ts_set_dyn(tsv obj, tsv keyv, tsv v);
void   ts_set_pic(tsv obj, ts_key key, tsv v, ts_prop_ic* ic);
void   ts_set_dyn_pic(tsv obj, tsv keyv, tsv v, ts_prop_ic* ic);
/* Reflect.* wrappers (return booleans where the spec does). */
tsv    ts_reflect_has(tsv t, tsv k);
tsv    ts_reflect_set(tsv t, tsv k, tsv v);
tsv    ts_reflect_delete(tsv t, tsv k);
tsv    ts_reflect_set_proto(tsv t, tsv p);
tsv    ts_reflect_define_property(tsv t, tsv k, tsv d);
tsv    ts_reflect_prevent_extensions(tsv t);
tsv    ts_reflect_own_keys(tsv t);
tsv    ts_reflect_apply(tsv fn, tsv thisArg, tsv argsArray);
tsv    ts_reflect_construct(tsv fn, tsv argsArray);

/* field-id <-> name table (seeded at startup by emitted FIELD_NAMES) */
void        ts_init_fields(const char* const* names, const uint32_t* lens, uint32_t count);
const char* ts_field_name(uint32_t id);
uint32_t    ts_field_name_len(uint32_t id);
uint32_t    ts_intern_field(const char* name, uint32_t len);
/* Object static methods */
tsv ts_object_keys(tsv obj);
tsv ts_object_for_in_keys(tsv obj);
tsv ts_object_get_own_property_names(tsv obj);
tsv ts_object_get_own_property_symbols(tsv obj);
tsv ts_object_freeze(tsv v);
tsv ts_object_is_frozen(tsv v);
tsv ts_object_create(tsv proto);
tsv ts_object_seal(tsv v);
tsv ts_object_prevent_extensions(tsv v);
tsv ts_object_is_sealed(tsv v);
tsv ts_object_is_extensible(tsv v);
tsv ts_object_values(tsv obj);
tsv ts_object_entries(tsv obj);
tsv ts_object_assign(tsv* args, int n);
tsv ts_construct_result(tsv inst, tsv ret);  /* new operator step 4 */
tsv ts_object_from_entries(tsv entries);
/* JSON */
tsv ts_json_stringify(tsv v);
tsv ts_json_stringify_indent(tsv v, tsv space);
double ts_json_stringify_len(tsv v);
double ts_json_stringify_indent_len(tsv v, tsv space);
double ts_json_num_len(double d);
double ts_json_string_len(tsv v);
static inline double ts_json_num_len_fast(double d) {
  if (d!=d || d==1.0/0.0 || d==-1.0/0.0) return 4.0;
  if (d == (double)(long long)d && d < 9e15 && d > -9e15) {
    long long x = (long long)d;
    if (x >= 0 && x < 1000000LL) {
      if (x < 10) return 1.0;
      if (x < 100) return 2.0;
      if (x < 1000) return 3.0;
      if (x < 10000) return 4.0;
      if (x < 100000) return 5.0;
      return 6.0;
    }
    int n = x < 0 ? 1 : 0;
    unsigned long long u = x < 0 ? (unsigned long long)(-x) : (unsigned long long)x;
    do { n++; u /= 10u; } while (u != 0);
    return (double)n;
  }
  return ts_json_num_len(d);
}
double ts_json_string_len_fast(tsv v);
tsv ts_json_parse(tsv text);
tsv ts_json_parse_reviver(tsv text, tsv reviver);
typedef struct {
  tjson_value** roots;
  uint32_t len;
  uint32_t cap;
} ts_json_dom_scope;
void ts_json_dom_scope_track(ts_json_dom_scope* scope, tjson_value* root);
void ts_json_dom_scope_free(ts_json_dom_scope* scope);
tjson_value* ts_json_dom_parse(tsv text);
tjson_value* ts_json_dom_get(tjson_value* obj, uint32_t key);
tjson_value* ts_json_dom_get_dyn(tjson_value* obj, tsv key);
tjson_value* ts_json_dom_index(tjson_value* arr, double index);
double ts_json_dom_length(tjson_value* value);
double ts_json_dom_number(tjson_value* value);
tsv ts_json_dom_add(tjson_value* lhs, tjson_value* rhs);
tsv ts_json_dom_add_left(tjson_value* lhs, tsv rhs);
tsv ts_json_dom_add_right(tsv lhs, tjson_value* rhs);
tsv ts_json_dom_to_tsv(tjson_value* value);
tsv ts_json_dom_stringify(tjson_value* value);
double ts_json_dom_stringify_len(tjson_value* value);

/* ---- Map ---- */
tsv      ts_new_map(void);
int      ts_is_map(tsv v);
tsv      ts_map_set(tsv m, tsv k, tsv v); /* returns the map (chainable) */
tsv      ts_map_get(tsv m, tsv k);        /* value or undefined */
int      ts_map_has(tsv m, tsv k);
int      ts_map_delete(tsv m, tsv k);     /* 1 if existed */
void     ts_map_clear(tsv m);
double   ts_map_size(tsv m);
tsv      ts_array_entries(tsv arr);
tsv      ts_array_keys_arr(tsv arr);
tsv      ts_array_values_arr(tsv arr);
tsv      ts_map_keys(tsv m);              /* iterable iterator of keys */
tsv      ts_map_entries(tsv m);           /* iterable iterator of pairs */
tsv      ts_map_iterator(tsv m, int kind); /* 0 keys, 1 values, 2 entries */
tsv      ts_map_values(tsv m);            /* iterable iterator of values */
void     ts_map_foreach(tsv m, tsv cb);   /* cb(value, key) */
/* ---- Set ---- */
tsv      ts_new_set(void);
int      ts_is_set(tsv v);
tsv      ts_set_add(tsv s, tsv v);        /* returns the set (chainable) */
tsv      ts_set_seed(tsv s, tsv iterable);/* new Set(iterable) */
tsv      ts_map_seed(tsv m, tsv iterable);/* new Map(iterable) */
int      ts_set_has(tsv s, tsv v);
int      ts_set_delete(tsv s, tsv v);
void     ts_set_clear(tsv s);
double   ts_set_size(tsv s);
tsv      ts_set_keys(tsv s);              /* iterable iterator of elements */
tsv      ts_set_values(tsv s);            /* iterable iterator of elements */
tsv      ts_set_entries(tsv s);           /* iterable iterator of pairs */
void     ts_set_foreach(tsv s, tsv cb);   /* cb(value, value) */
/* ---- WeakMap / WeakSet ----
   WeakMap values use ephemeron semantics: a reachable key retains its value,
   while the value never retains its own key. Weak containers are intentionally
   non-iterable and expose no size/clear operation. Objects, functions, and
   non-registered Symbols are valid keys; Symbol.for identities are rejected. */
tsv      ts_new_weakmap(void);
int      ts_is_weakmap(tsv v);
tsv      ts_weakmap_set(tsv m, tsv k, tsv v);
tsv      ts_weakmap_get(tsv m, tsv k);
int      ts_weakmap_has(tsv m, tsv k);
int      ts_weakmap_delete(tsv m, tsv k);
tsv      ts_weakmap_seed(tsv m, tsv iterable);
tsv      ts_new_weakset(void);
int      ts_is_weakset(tsv v);
tsv      ts_weakset_add(tsv s, tsv v);
int      ts_weakset_has(tsv s, tsv v);
int      ts_weakset_delete(tsv s, tsv v);
tsv      ts_weakset_seed(tsv s, tsv iterable);
int  ts_is_array(tsv v);            /* OBJECT-tagged value whose kind is ARRAY */
tsv  ts_get(tsv obj, ts_key key);
/* own/inherited data property (field key) shadows; else the inherited prototype
   METHOD (method key). For instance Object.prototype-method values (o.toString). */
tsv  ts_get_method_value(tsv recv, uint32_t field_key, uint32_t method_key);
void ts_set(tsv obj, ts_key key, tsv val);
/* Symbol support (symbol_design.md). */
tsv  ts_symbol_new(tsv description);          /* Symbol(desc): fresh unique symbol */
int  ts_is_symbol(tsv v);
tsv  ts_symbol_description(tsv sym);          /* sym.description (string or undefined) */
ts_key ts_symbol_key(tsv sym);                /* property-key for obj[sym] */
void ts_set_symkey(tsv obj, tsv sym, tsv val);/* obj[sym] = val (no stringify) */
tsv  ts_get_symkey(tsv obj, tsv sym);         /* obj[sym] */
tsv  ts_wksym(uint32_t id);                   /* well-known symbol singleton (Symbol.iterator=0..) */
tsv  ts_symbol_for(tsv key);                  /* Symbol.for(key): registry singleton */
tsv  ts_symbol_key_for(tsv sym);              /* Symbol.keyFor(sym): registered key or undefined */
tsv  ts_symbol_tostring(tsv sym);             /* sym.toString() -> "Symbol(desc)" */
void ts_define_accessor(tsv obj, ts_key key, tsv getter, tsv setter, int g_this, int s_this);
void ts_define_accessor_attr(tsv obj, ts_key key, tsv getter, tsv setter, int g_this, int s_this, int e, int c);
void ts_define_accessor_dyn(tsv obj, tsv keyv, tsv getter, tsv setter, int g_this, int s_this, int e, int c);
void ts_define_accessor_symkey(tsv obj, tsv sym, tsv getter, tsv setter, int g_this, int s_this, int e, int c);
/* Object.defineProperty data form with explicit attributes (e/w/c = enumerable/
   writable/configurable). e=w=c=1 behaves like an ordinary property. */
void ts_define_data(tsv obj, ts_key key, tsv value, int e, int w, int c);
void ts_define_data_dyn(tsv obj, tsv keyv, tsv value, int e, int w, int c);
/* Object.getOwnPropertyDescriptor(obj,key) -> descriptor object or undefined. */
tsv ts_get_own_property_descriptor(tsv obj, tsv keyv);
/* Object.getOwnPropertyDescriptors(obj) -> {key: descriptor, ...}. */
tsv ts_get_own_property_descriptors(tsv obj);
/* Object.defineProperty(obj, key, descriptor) — runtime descriptor inspection
   (used for non-literal descriptors). value+get/set together throws TypeError. */
void ts_define_property(tsv obj, tsv keyv, tsv desc);
/* Object.defineProperties(obj, descs) — runtime form (non-literal descriptor map). */
void ts_define_properties(tsv obj, tsv descs);
tsv  ts_new_string(const char* s, uint32_t len);
/* Host boundary: malloc-owned UTF-8 bytes, replacing lone surrogates. */
char* ts_string_utf8_copy(tsv s, uint32_t* out_len);
uint32_t* ts_string_codepoints_copy(tsv v, uint32_t* out_len);
tsv  ts_string_from_codepoints(const uint32_t* cps, uint32_t len);
tsv  ts_add(tsv a, tsv b);            /* JS '+' (number add or string concat) */
tsv  ts_str_concat_many(tsv* args, int n);
/* JS `===`. Identical bits are equal unless NaN; distinct bits can only be
   equal for two numbers (+0/-0) or two strings, which compare out of line. */
int  ts_strict_eq_slow(tsv a, tsv b);
/* Identity of two heap references whose bits differ: equal exactly when one
   is a handle and the other a pointer to the same cell (handle slots and
   addresses are each unique among live cells). Callers check the selectors. */
static inline int ts_same_cell(tsv a, tsv b){
  return TS_TOP16(a) == TS_TOP16(b) && (((a ^ b) & 1u) != 0) && ts_ptr(a) == ts_ptr(b);
}
int ts_strict_eq_str(tsv a, tsv b);   /* two strings: the lengths first, then the content */
/* Bounded fast path (always inline: a generated function compares hundreds
   of times, and the compiler's inliner gave up on the larger body): same
   bits, two numbers, then object identity (the checker's common case: types,
   symbols, nodes), then two strings out of line. */
TS_RT_ALWAYS_INLINE int ts_strict_eq(tsv a, tsv b){
  if (a == b) return !(ts_is_num(a) && ts_to_num(a) != ts_to_num(a));
  if (ts_is_num(a) || ts_is_num(b)) return ts_is_num(a) && ts_is_num(b) && ts_to_num(a) == ts_to_num(b);
  if (ts_is_obj(a) || ts_is_func(a)) return ts_same_cell(a, b);
  if (ts_is_str(a) && ts_is_str(b)) return ts_strict_eq_str(a, b);
  return 0;
}
int  ts_relational(tsv a, tsv b, int op);  /* 0:< 1:<= 2:> 3:>= */
int  ts_loose_eq(tsv a, tsv b);            /* == (returns 1/0) */
int  ts_object_is(tsv a, tsv b);          /* Object.is SameValue */
tsv  ts_to_string_v(tsv v);
tsv  ts_typeof(tsv v);
tsv  ts_dynamic_method_unsupported(void); /* traps: truly-unknown callee */
void ts_dynamic_method_missing(uint32_t name_field); /* throws TypeError: <name> is not a function */
void ts_check_method_recv(tsv recv, uint32_t name_field); /* throws if recv is null/undefined */
void ts_throw_not_a_function(const char* name); /* throws TypeError: <name>/value is not a function */
/* diagnostic per-site allocation counters (TSAOT_SITE_STATS=1 builds only) */
void ts_site_note(uint32_t site, uint32_t func);
void ts_site_stats_init(const char** fn_names, uint32_t nfn);
void ts_print(tsv v);                 /* console.log of one value */
void ts_console_log(tsv* args, int n); /* console.log/.info/.debug (stdout) */
void ts_console_err(tsv* args, int n); /* console.warn/.error (stderr) */
void ts_console_dir(tsv v);            /* console.dir: structural inspection */
tsv ts_read_stdin(void);               /* host I/O: ALL of stdin as a string (self-hosting) */
int ts_instanceof(tsv obj, tsv target_proto);
tsv ts_instanceof_hook(tsv klass, tsv obj);
tsv ts_instanceof_dyn(tsv obj, tsv ctorv);  /* x instanceof <runtime constructor value> */

/* class field descriptor: lets the inspector render typed class instances. */
typedef struct { uint32_t name_id; size_t offset; int numeric; } ts_class_field;
void ts_register_class(tsv proto, ts_class_field* fields, int nfields);
/* Class VALUE support (`const K = C; new K()`): register a class's instance size
   and prototype by class id, box a class as a callable value, and construct an
   instance from a class value at runtime. */
void ts_register_class_meta(uint32_t class_id, size_t size, tsv proto, ts_class_field* fields, int nfields);
tsv  ts_make_class_value(uint32_t class_id, ts_code ctor, tsv* env, uint32_t envlen);
tsv  ts_construct(tsv ctorv, tsv* args, int n);
/* Set a boxed function value's first-class metadata (`fn.length` / `fn.name`). */
void ts_set_fn_meta(tsv fn, uint32_t arity, const char* name);
void ts_set_fn_prototype(tsv fn, tsv proto);
/* Environment register of the closure ABI: a caller stores the callee's
   captured-cell buffer here immediately before the call; the callee prologue
   reads its leading cells from it before anything else runs. */
extern tsv* g_ts_cur_env;
/* Closure constructors for code compiled with the environment ABI. */
tsv  ts_make_closure_t(ts_code code, tsv* env, uint32_t envlen, int takes_this);
tsv  ts_make_closure_t_pretenured(ts_code code, tsv* env, uint32_t envlen, int takes_this);
/* A function object on the C stack (an allocation site the escape analysis
   proved never leaves its frame): the fields ts_make_fn_impl/ts_make_closure_t
   set, on a non-heap cell whose environment is the caller's array. */
void ts_init_fn_stack(ts_func* f, ts_code code, tsv* env, uint32_t envlen, int takes_this);
tsv  ts_make_class_value_cells(uint32_t class_id, ts_code ctor, tsv* env, uint32_t envlen);
/* Give fn an own `.prototype` without allocating it: the fresh object (and its
   `constructor`) is created on first observation. Preferred emitted form. */
void ts_set_fn_prototype_lazy(tsv fn);
void ts_gc_collect(void);             /* full mark/sweep over the dynamic heap */
void ts_gc_collect_young(void);       /* minor collection of young objects */
void ts_gc_root(tsv* slot);           /* register a root (stack slot address) */
/* Generated non-coroutine functions batch their boxed locals into one shadow
   frame. The slots immediately follow this header in the generated stack
   struct and are fully initialized before the frame is linked. */
typedef struct ts_frame_hdr {
  struct ts_frame_hdr* prev;
  uint32_t count;
} ts_frame_hdr;
extern ts_frame_hdr* g_ts_frame_top;
#ifdef TSAOT_RT_STATS
extern unsigned long long g_ts_frame_push_count;
#define TS_RT_STAT_FRAME_PUSH() (g_ts_frame_push_count++)
#else
#define TS_RT_STAT_FRAME_PUSH() ((void)0)
#endif
static inline void ts_frame_push(ts_frame_hdr* frame, uint32_t count){
  frame->prev = g_ts_frame_top;
  frame->count = count;
  g_ts_frame_top = frame;
  TS_RT_STAT_FRAME_PUSH();
}
static inline void ts_frame_pop(ts_frame_hdr* frame){
  g_ts_frame_top = frame->prev;
}
static inline tsv* ts_frame_slots(ts_frame_hdr* frame){
  return (tsv*)(frame + 1);
}
void ts_frame_restore(ts_frame_hdr* frame);
static inline void ts_write_barrier(tsv owner, tsv value){
  if (!(ts_is_obj(value)||ts_is_func(value)||ts_is_heap_str(value))) return;
  if (!(ts_is_obj(owner)||ts_is_func(owner)||ts_is_heap_str(owner))) return;
  uint64_t op = owner & TS_PAYLOAD_MASK, vp = value & TS_PAYLOAD_MASK;
  /* A pointer-form value is old or on the stack: never a young pointee. */
  if (!(vp & 1u)) return;
  uintptr_t ve = (uintptr_t)g_ts_handle_table[vp >> 1];
  if (ve & TS_HANDLE_OLD_BIT) return;
  if (op & 1u){
    uintptr_t oe = (uintptr_t)g_ts_handle_table[op >> 1];
    if (oe & TS_HANDLE_OLD_BIT) ts_gc_remember(ts_handle_entry_cell(oe));
    return;
  }
  if (op & TS_PTR_STACK_TAG) return; /* a stack owner is scanned as a root */
  ts_gc_remember((ts_gc_header*)(uintptr_t)op); /* old-pointer owner */
}
/* The barrier for a write whose slot is known (docs/remembered_slots_design.md):
   an old plain object remembers a dirty card range in its header's spare
   byte, so the next minor collection scans only those cards. `p` points at
   the written slot of a SHAPED object (in-object or overflow value). */
void ts_gc_remember_slot(ts_gc_header* h, uint32_t slot);
static inline void ts_write_barrier_at(tsv owner, ts_gc_header* oh, tsv* p, tsv value){
  if (oh->kind == TS_KIND_OBJECT){
    ts_object* o = (ts_object*)oh;
    tsv* iv = ts_obj_inline_vals(o);
    uint32_t slot = (p >= iv && p < iv + oh->inline_cap)
      ? (uint32_t)(p - iv)
      : (uint32_t)(p - (tsv*)o->props) + oh->inline_cap;
    ts_gc_remember_slot(oh, slot);
  } else {
    ts_gc_remember(oh);
  }
  (void)owner; (void)value;
}
static inline void ts_write_barrier_ptr(tsv owner, tsv* p, tsv value){
  if (!(ts_is_obj(value)||ts_is_func(value)||ts_is_heap_str(value))) return;
  if (!(ts_is_obj(owner)||ts_is_func(owner)||ts_is_heap_str(owner))) return;
  uint64_t op = owner & TS_PAYLOAD_MASK, vp = value & TS_PAYLOAD_MASK;
  if (!(vp & 1u)) return;
  uintptr_t ve = (uintptr_t)g_ts_handle_table[vp >> 1];
  if (ve & TS_HANDLE_OLD_BIT) return;
  if (op & 1u){
    uintptr_t oe = (uintptr_t)g_ts_handle_table[op >> 1];
    if (oe & TS_HANDLE_OLD_BIT) ts_write_barrier_at(owner, ts_handle_entry_cell(oe), p, value);
    return;
  }
  if (op & TS_PTR_STACK_TAG) return;
  ts_write_barrier_at(owner, (ts_gc_header*)(uintptr_t)op, p, value);
}
/* Ordinary shape hits keep their compact cache and original guard sequence.
   Sized receivers use a separate bounded location table in ts_rt.c.
   Unsized dictionary receivers validate a cached own slot out of line.
   Their shape is always zero, so struct precedence and registry changes cannot
   invalidate an ordinary shape hit. */
/* Inline probe for a shaped receiver: returns the value slot and the
   property's attribute flags (from the entry on a shape hit, from the shape
   tables on the slot/key fallback). Dictionary receivers never hit inline. */
TS_RT_ALWAYS_INLINE tsv* ts_prop_ic_probe_fixed_inline(
    tsv obj, ts_key key, ts_prop_ic* ic, uint8_t* flags){
  if (!ic || ic->megamorphic || TS_TOP16(obj) != TS_SEL_OBJECT) return NULL;
  ts_object* o = (ts_object*)ts_ptr(obj);
  uint32_t sid = ts_obj_shape_id(o);
  if (o->h.kind != TS_KIND_OBJECT || sid == TS_SHAPE_NONE) return NULL;
  /* Entry 0 first: its shape (the monomorphic case), then its slot validated
     against this shape's key vector. The compiler's reads are mostly
     shape-polymorphic with the key at one slot (61% of hits measured in
     Session 350), so that validation is the second test, not the last. */
  {
    ts_prop_ic_entry* e0 = &ic->entries[0];
    if (e0->shape == o->shape){
      *flags = (uint8_t)(e0->slot >> TS_PIC_FLAGS_SHIFT);
      TS_RT_STAT_SLOT(o, e0->slot & TS_PIC_SLOT_MASK);
      TS_RT_STAT_PIC_ENTRY(0);
      return ts_obj_slot_ptr(o, e0->slot & TS_PIC_SLOT_MASK);
    }
    uint32_t slot0 = e0->slot & TS_PIC_SLOT_MASK;
    if (e0->shape != TS_SHAPE_NONE && slot0 < o->len && g_ts_shape_keys[sid][slot0] == key){
      *flags = g_ts_shape_flags[sid][slot0];
      TS_RT_STAT_PIC_KEYVAL();
      return ts_obj_slot_ptr(o, slot0);
    }
  }
#if defined(__clang__)
#pragma clang loop unroll(disable)
#elif defined(__GNUC__)
#pragma GCC unroll 1
#endif
  for (uint32_t i = 1; i < TS_PROP_IC_SIZE; i++){
    ts_prop_ic_entry* e = &ic->entries[i];
    if (e->shape == o->shape){
      *flags = (uint8_t)(e->slot >> TS_PIC_FLAGS_SHIFT);
      TS_RT_STAT_SLOT(o, e->slot & TS_PIC_SLOT_MASK);
      TS_RT_STAT_PIC_ENTRY(i);
      return ts_obj_slot_ptr(o, e->slot & TS_PIC_SLOT_MASK);
    }
  }
  /* Shape-polymorphic sites (one key read across many constructor-initialized
     layouts, e.g. `node.kind`) usually keep the key at one slot. Validate the
     remembered slot against the shape's key vector instead of leaving the
     inline path; this is the same check the out-of-line own probe performs. */
#if defined(__clang__)
#pragma clang loop unroll(disable)
#elif defined(__GNUC__)
#pragma GCC unroll 1
#endif
  for (uint32_t i = 1; i < TS_PROP_IC_SIZE; i++){
    ts_prop_ic_entry* e = &ic->entries[i];
    uint32_t slot = e->slot & TS_PIC_SLOT_MASK;
    if (e->shape != TS_SHAPE_NONE && slot < o->len && g_ts_shape_keys[sid][slot] == key){
      *flags = g_ts_shape_flags[sid][slot];
      TS_RT_STAT_PIC_KEYVAL();
      return ts_obj_slot_ptr(o, slot);
    }
  }
  return NULL;
}
TS_RT_ALWAYS_INLINE tsv ts_get_pic_checked_inline(
    tsv obj, ts_key key, ts_prop_ic* ic){
  uint8_t flags = 0;
  tsv* p = ts_prop_ic_probe_fixed_inline(obj, key, ic, &flags);
  if (p && !(flags & TS_PROP_ACCESSOR)){
    TS_RT_STAT_PIC_GET_CALL(); TS_RT_STAT_PIC_GET_HIT();
    return *p;
  }
  return ts_get_pic_checked(obj, key, ic);
}
TS_RT_ALWAYS_INLINE void ts_set_pic_inline(
    tsv obj, ts_key key, tsv value, ts_prop_ic* ic){
  uint8_t flags = 0;
  tsv* p = ts_prop_ic_probe_fixed_inline(obj, key, ic, &flags);
  if (p && !(flags & TS_PROP_ACCESSOR) && (flags & TS_PROP_WRITABLE)){
    ts_object* o = (ts_object*)ts_ptr(obj);
    if (!(ts_obj_integrity(o) & 1u)){
      TS_RT_STAT_PIC_SET_CALL(); TS_RT_STAT_PIC_SET_HIT();
      *p = value; ts_write_barrier_ptr(obj, p, value); return;
    }
  }
  ts_set_pic(obj, key, value, ic);
}
/* Store property `i` of a layout object (shaped: value slot; dictionary
   fallback: entry in insertion order). */
static inline void ts_lit_store(tsv obj, uint32_t i, tsv v){
  ts_object* o = (ts_object*)ts_ptr(obj);
  if (ts_obj_shape_id(o) != TS_SHAPE_NONE){
    tsv* p = ts_obj_slot_ptr(o, i);
    *p = v;
    ts_write_barrier_ptr(obj, p, v);
  } else {
    o->props[i].val = v;
    ts_write_barrier(obj, v);
  }
}
/* Lazily linked root frames (docs/lazy_frames_design.md): a generated
   function whose body cannot reach a collection except through these slow
   paths keeps its root frame unlinked and links it only around them. The
   frame's slots are fully initialized before any of these can run. */
TS_RT_ALWAYS_INLINE tsv ts_get_pic_checked_inline_lazy(
    tsv obj, ts_key key, ts_prop_ic* ic, ts_frame_hdr* frame, uint32_t nslots){
  uint8_t flags = 0;
  tsv* p = ts_prop_ic_probe_fixed_inline(obj, key, ic, &flags);
  if (p && !(flags & TS_PROP_ACCESSOR)){
    TS_RT_STAT_PIC_GET_CALL(); TS_RT_STAT_PIC_GET_HIT();
    return *p;
  }
  ts_frame_push(frame, nslots);
  tsv r = ts_get_pic_checked(obj, key, ic);
  ts_frame_pop(frame);
  return r;
}
TS_RT_ALWAYS_INLINE void ts_set_pic_inline_lazy(
    tsv obj, ts_key key, tsv value, ts_prop_ic* ic, ts_frame_hdr* frame, uint32_t nslots){
  uint8_t flags = 0;
  tsv* p = ts_prop_ic_probe_fixed_inline(obj, key, ic, &flags);
  if (p && !(flags & TS_PROP_ACCESSOR) && (flags & TS_PROP_WRITABLE)){
    ts_object* o = (ts_object*)ts_ptr(obj);
    if (!(ts_obj_integrity(o) & 1u)){
      TS_RT_STAT_PIC_SET_CALL(); TS_RT_STAT_PIC_SET_HIT();
      *p = value; ts_write_barrier_ptr(obj, p, value); return;
    }
  }
  ts_frame_push(frame, nslots);
  ts_set_pic(obj, key, value, ic);
  ts_frame_pop(frame);
}
/* Element read: the array path allocates nothing; a string receiver builds a
   one-character view, so it runs with the frame linked. */
TS_RT_ALWAYS_INLINE tsv ts_array_get_lazy(tsv arr, uint32_t i, ts_frame_hdr* frame, uint32_t nslots){
  if (ts_is_indexed_array_fast(arr)) return ts_array_get(arr, i);
  ts_frame_push(frame, nslots);
  tsv r = ts_array_get(arr, i);
  ts_frame_pop(frame);
  return r;
}
/* The hole marker of a sparse array element (never a user-visible value). */
#define TS_ARRAY_HOLE TS_BOX(0xFFFEu, 0x4152484Fu)
static inline int array_is_hole(tsv v){ return v == TS_ARRAY_HOLE; }
/* Element read with the array case in line: a dense slot (below cap: every
   slot in [len, cap) is a hole) that is not a hole is the value, any other
   index of a dense array is undefined (ts_array_get agrees); a sparse array
   (cap 0) reads its side table out of line, as do strings and other
   receivers. */
static inline tsv ts_array_get_inline(tsv arr, uint32_t i){
  if (ts_is_indexed_array_fast(arr)){
    ts_array* a = (ts_array*)ts_ptr(arr);
    if (i < a->cap){ tsv v = a->data[i]; return array_is_hole(v) ? TS_UNDEFINED : v; }
    if (!a->sparse) return TS_UNDEFINED;
  }
  return ts_array_get(arr, i);
}
static inline tsv ts_array_get_inline_lazy(tsv arr, uint32_t i, ts_frame_hdr* frame, uint32_t nslots){
  if (ts_is_indexed_array_fast(arr)){
    ts_array* a = (ts_array*)ts_ptr(arr);
    if (i < a->cap){ tsv v = a->data[i]; return array_is_hole(v) ? TS_UNDEFINED : v; }
    if (!a->sparse) return TS_UNDEFINED;
  }
  ts_frame_push(frame, nslots);
  tsv r = ts_array_get(arr, i);
  ts_frame_pop(frame);
  return r;
}
TS_RT_ALWAYS_INLINE tsv ts_get_dyn_pic_checked_inline(
    tsv obj, tsv key, ts_prop_ic* ic){
  if (ic && ic->megamorphic){
    TS_RT_STAT_PIC_GET_CALL();
    return ts_get_dyn_checked(obj, key);
  }
  return ts_get_dyn_pic_checked(obj, key, ic);
}
TS_RT_ALWAYS_INLINE void ts_set_dyn_pic_inline(
    tsv obj, tsv key, tsv value, ts_prop_ic* ic){
  if (ic && ic->megamorphic){
    TS_RT_STAT_PIC_SET_CALL();
    ts_set_dyn(obj, key, value);
    return;
  }
  ts_set_dyn_pic(obj, key, value, ic);
}
void ts_gc_unroot(int n);

#endif

/* exceptions (try/catch via setjmp/longjmp) */
typedef struct ts_handler {
  jmp_buf buf;
  int gc_root_len;
  ts_frame_hdr* frame_top;
  struct ts_handler* prev;
  void* extbuf;
} ts_handler;
int         ts_gc_root_depth(void);
void        ts_gc_set_root_depth(int n);
ts_handler* ts_eh_push(void);
void        ts_eh_push_coro(void* extbuf);
void        ts_eh_pop(void);
void        ts_throw(tsv v);
void        ts_throw_range_error_msg(const char* msg);
void        ts_throw_type_error_msg(const char* msg);
void        ts_throw_syntax_error_msg(const char* msg);
tsv         ts_current_exception(void);
void        g_exception_set(tsv v);
int         ts_handlers_count(void);

/* Proxy: wraps a target + handler. Like ts_promise it does NOT embed
   ts_obj_common — every property/call/construct operation is intercepted early
   in ts_get/ts_set/... and dispatched to the handler's traps. */
typedef struct ts_proxy {
  ts_gc_header h;
  tsv target;
  tsv handler;
  uint8_t revoked;
} ts_proxy;
tsv ts_proxy_new(tsv target, tsv handler);
tsv ts_proxy_revocable(tsv target, tsv handler);
tsv ts_proxy_revoke_thunk(tsv* args, int n);
/* Promise + coroutine frame (async/await) */
typedef struct ts_promise {
  ts_gc_header h;
  int state;                 /* 0 pending, 1 fulfilled, 2 rejected */
  tsv value;
  tsv* waiters;
  int nwait, capwait;
  int comb_remaining;        /* Promise.all: inputs not yet fulfilled (0 otherwise) */
  tsv comb_results;          /* Promise.all: the results array (TS_UNDEFINED otherwise) */
} ts_promise;
typedef struct ts_asyncgen_req {
  tsv promise;
  tsv value;
  int kind;                  /* 0 next, 1 throw, 2 return */
  int value_awaited;         /* async-generator return argument was unwrapped */
  struct ts_asyncgen_req* next;
} ts_asyncgen_req;
enum {
  TS_GEN_SUSPENDED_START = 0,
  TS_GEN_SUSPENDED_YIELD = 1,
  TS_GEN_EXECUTING = 2,
  TS_GEN_COMPLETED = 3
};
#define TS_CORO_EH_INLINE 8
typedef struct ts_coro {
  ts_gc_header h;
  int state;
  tsv (*resume)(tsv);
  tsv result;                /* awaited value (async) / value sent into .next() (gen) */
  int rejected;
  tsv ret;
  size_t frame_size;         /* total bytes of the enclosing frame (for GC scan) */
  tsv slots[16];
  int nslots;
  tsv yielded;               /* generator: value produced by the current yield */
  int done;                  /* generator: 1 when the body has completed */
  int gen_status;            /* generator protocol lifecycle (TS_GEN_*) */
  int is_asyncgen;
  int ag_running;
  ts_asyncgen_req* ag_head;
  ts_asyncgen_req* ag_tail;
  jmp_buf eh_buf;            /* shared landing pad; re-armed each resume */
  int eh_top;                /* number of active coroutine try handlers */
  int eh_capacity;
  int* eh_catch_state;        /* catch-label id per handler (innermost = top-1) */
  int* eh_gc_depth;           /* GC root depth snapshot per handler */
  int eh_catch_inline[TS_CORO_EH_INLINE];
  int eh_gc_inline[TS_CORO_EH_INLINE];
  int fin_capacity;
  int* fin_pending;           /* completion kind 0 normal/1 throw/2 return/3 break/4 continue */
  tsv* fin_exc;               /* saved exception (throw) or return value */
  int* fin_tgt;               /* target loop label id for break/continue */
  int fin_pending_inline[TS_CORO_EH_INLINE];
  tsv fin_exc_inline[TS_CORO_EH_INLINE];
  int fin_tgt_inline[TS_CORO_EH_INLINE];
  int fin_top;               /* active finally-pending slots */
  jmp_buf reject_buf;        /* async catch-all: uncaught throw rejects ret */
} ts_coro;
int         ts_coro_eh_push_slot(ts_coro* c);
int         ts_coro_fin_push_slot(ts_coro* c);
/* Promise/Coro handle APIs are the primary runtime boundary. */
tsv         ts_promise_new_v(void);
void        ts_promise_settle_v(tsv pv, tsv v, int rejected);
void        ts_promise_resolve_v(tsv pv, tsv v);
void        ts_promise_reject_v(tsv pv, tsv v);
tsv         ts_promise_resolved(tsv v);
tsv         ts_promise_rejected(tsv v);
tsv         ts_promise_all(tsv arr);
tsv         ts_promise_race(tsv arr);
tsv         ts_promise_allsettled(tsv arr);
tsv         ts_promise_any(tsv arr);
tsv         ts_promise_then(tsv pv, tsv on_f, tsv on_r);
tsv         ts_promise_catch(tsv pv, tsv on_r);
tsv         ts_promise_finally(tsv pv, tsv on_fin);
tsv         ts_promise_new_executor(tsv executor);
void        ts_await_register_v(tsv pv, tsv cv);
tsv         ts_coro_new_v(tsv (*resume)(tsv));
tsv         ts_coro_alloc_v(size_t size, tsv (*resume)(tsv));
void        ts_coro_resume_v(tsv cv);
void        ts_run_event_loop(void);

/* fetch (async HTTP) */
tsv ts_fetch(tsv urlv, tsv opts);
tsv ts_response_text(tsv resp);
tsv ts_response_json(tsv resp);
tsv ts_headers_new(tsv init);
void ts_headers_make_immutable(tsv headers);
tsv ts_headers_get(tsv headers, tsv namev);
int ts_headers_has(tsv headers, tsv namev);
tsv ts_headers_keys(tsv headers);
tsv ts_headers_values(tsv headers);
tsv ts_headers_entries(tsv headers);
tsv ts_headers_append(tsv headers, tsv namev, tsv valuev);
tsv ts_headers_set(tsv headers, tsv namev, tsv valuev);
tsv ts_headers_delete(tsv headers, tsv namev);
tsv ts_abort_controller_new(void);
tsv ts_abort_signal_new(int aborted);
tsv ts_abort_signal_timeout(tsv msv);
int ts_abort_signal_is_aborted(tsv signal);
tsv ts_abort_signal_reason(tsv signal);
tsv ts_abort_controller_abort(tsv controller);
tsv ts_abort_controller_abort_reason(tsv controller, tsv reason);
tsv ts_abortcontrollerproto_abort(tsv* a, int n);

/* generators */
tsv ts_gen_new_v(tsv cv);
tsv ts_gen_next(tsv genobj, tsv sent);
tsv ts_asyncgen_next(tsv genobj, tsv sent);
tsv ts_iter_step(tsv iter, tsv sent, ts_key nmk); /* generic iterator step: field/method `next` or generator fallback */
tsv ts_asyncgen_throw(tsv genobj, tsv exc);
tsv ts_asyncgen_return(tsv genobj, tsv val);
tsv ts_gen_throw(tsv genobj, tsv exc);
tsv ts_gen_return(tsv genobj, tsv val);
tsv ts_asyncgen_new_v(tsv cv);
tsv ts_iter_result(tsv value, int done);
int ts_is_gen_return_completion(tsv v);
tsv ts_gen_return_completion_value(tsv v);
void ts_abort_msg(const char* m);
