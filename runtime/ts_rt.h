/* ts_rt — lightweight JS runtime for the TS->C AOT compiler.
 *
 * Value representation: NaN-boxing (v7-style). A 64-bit IEEE-754 double has
 * 2^51 spare bit patterns inside its NaN space; we encode non-number values
 * there. A value is a number IFF it is NOT a quiet-NaN with our tag bits set.
 *
 *   bits 63..50 : 0xFFF8 | tag(3)   when boxed (the quiet-NaN prefix 0x7FF8/0xFFF8)
 *   bits 49..0  : 48-bit payload (immediate, heap cell address, or tagged stack pointer)
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

/* Threads, slice A1's accessor experiment (docs/threads_design.md): with
   TS_ISO_MODE 1 the per-isolate state the generated code touches is reached
   through a thread-local isolate pointer, with 2 through an isolate block at
   the base of a stack aligned to its size (the stack pointer masked; the
   runtime runs main on such a stack). 0, the default, keeps the globals. */
#ifndef TS_ISO_MODE
#define TS_ISO_MODE 0
#endif
#if TS_ISO_MODE == 0
/* The program's main runs on a thread with a large stack (ts_rt.c defines
   main: TSAOT_MAIN_STACK_MB, default 256, 0 for the process's own thread).
   A deep recursion that fits V8's compact frames overflowed the 8 MB main
   thread with the runtime's larger frames (the dynamic paths' in particular:
   tsc-ts with every class dynamic needed more than 8 MB in its checker). */
#define main ts_user_main
/* declared without a prototype: a plain program's main is `main(void)`, a
   hosted program's takes argc and argv, and either definition is compatible
   with this declaration (the runtime passes both arguments; a `(void)`
   entry ignores them, as isolate mode's entry does) */
int ts_user_main();
#endif
#if TS_ISO_MODE
struct ts_frame_hdr;
typedef struct ts_iso {
  struct ts_frame_hdr* frame_top;
  tsv* cur_env;
  uint32_t** shape_keys;
  uint8_t** shape_flags;
  uint32_t* probe_rkeys;
  uint32_t* probe_wkeys;
  int has_proxies, typed_slow, closed_receivers, class_relinked;
  tsv* globals;
  tsv* class_proto;
  tsv object_proto;
  void* ics;
} ts_iso;
#if TS_ISO_MODE == 1
extern __thread ts_iso* ts_iso_cur;
#define TS_ISO() (ts_iso_cur)
#elif TS_ISO_MODE == 3
/* Thread-specific data read directly (Darwin arm64): the thread's slot
   array from tpidrro_el0 (its low three bits hold the CPU number) and a
   pthread key's slot, as Go's runtime reaches g on darwin/arm64 and as
   Apple's own libraries read their slots. A thread's isolate never changes
   while it runs, so the read is one asm without memory operands and the
   key is const to every translation unit: the compiler computes the
   isolate once per function, as it would the masked stack pointer. The
   key's storage is defined in assembly (ts_rt.c), written once by a
   constructor before main and verified against pthread_getspecific; no C
   code ever writes it. Two rules follow: a thread sets its slot
   (ts_iso_enter) in a function that contains no TS_ISO() use, and runs its
   body in a function that is not inlined into it, since the compiler may
   move this pure read above any call; and nothing reads TS_ISO() before the
   constructor ran (the key would be 0: slot 0 holds pthread_self). */
#if !(defined(__APPLE__) && defined(__aarch64__))
#error "TS_ISO_MODE 3 reads Darwin's arm64 thread-specific data"
#endif
extern const long ts_iso_key;
static inline __attribute__((always_inline)) ts_iso* ts_iso_get(void){
  ts_iso* p;
  __asm__("mrs %0, tpidrro_el0\n\tand %0, %0, #-8\n\tldr %0, [%0, %1, lsl #3]" : "=&r"(p) : "r"(ts_iso_key));
  return p;
}
#define TS_ISO() (ts_iso_get())
/* a thread's isolate, set before its body runs (the rules above) */
void ts_iso_enter(ts_iso* iso);
#else
#define TS_ISO_STACK_BITS 26
static inline __attribute__((always_inline)) ts_iso* ts_iso_get(void){
  uintptr_t sp;
#if defined(__aarch64__)
  __asm__("mov %0, sp" : "=r"(sp));
#else
  sp = (uintptr_t)__builtin_frame_address(0);
#endif
  return (ts_iso*)(sp & ~(((uintptr_t)1 << TS_ISO_STACK_BITS) - 1));
}
#define TS_ISO() (ts_iso_get())
/* the program's main runs on the isolate's stack (ts_rt.c defines main) */
#define main ts_iso_user_main
#endif
#define g_ts_frame_top (TS_ISO()->frame_top)
#define g_ts_cur_env (TS_ISO()->cur_env)
#define g_ts_shape_keys (TS_ISO()->shape_keys)
#define g_ts_shape_flags (TS_ISO()->shape_flags)
#define g_ts_probe_rkeys (TS_ISO()->probe_rkeys)
#define g_ts_probe_wkeys (TS_ISO()->probe_wkeys)
#define g_has_proxies (TS_ISO()->has_proxies)
#define g_typed_slow (TS_ISO()->typed_slow)
#define g_closed_receivers (TS_ISO()->closed_receivers)
#define g_class_relinked (TS_ISO()->class_relinked)
#endif

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
#if defined(__ARM_FEATURE_JCVT)
/* ARMv8.3 FJCVTZS is ECMAScript ToInt32 in one instruction: truncation toward
   zero modulo 2^32, NaN and the infinities 0 (docs/TODO.md, Session 350 x56).
   ToUint32 is the same residue read unsigned. */
TS_RT_ALWAYS_INLINE int32_t ts_to_int32(double d) { return __builtin_arm_jcvt(d); }
TS_RT_ALWAYS_INLINE uint32_t ts_to_uint32(double d) { return (uint32_t)__builtin_arm_jcvt(d); }
#else
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
#endif

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
/* OBJECT and ARRAY are adjacent: both carry shaped named properties, and the
   property caches admit a receiver with one compare (`kind <= TS_KIND_ARRAY`;
   docs/shaped_array_props_design.md). */
/* The kinds below TS_KIND_PROMISE carry the common header and are ordinary
   prototype-chain links; ArrayBuffer and the typed array views
   (docs/typed_arrays_design.md) sit among them. */
enum { TS_KIND_OBJECT = 1, TS_KIND_ARRAY = 2, TS_KIND_STRING = 3, TS_KIND_FUNC = 4, TS_KIND_MAP = 5, TS_KIND_SET = 6,
       TS_KIND_ARRAYBUFFER = 7, TS_KIND_TYPEDARRAY = 8,
       TS_KIND_PROMISE = 9, TS_KIND_CORO = 10, TS_KIND_ACCESSOR = 11, TS_KIND_SYMBOL = 12, TS_KIND_PROXY = 13,
       TS_KIND_LAST = TS_KIND_PROXY };
typedef struct ts_gc_header {
  uint8_t kind, mark, gen;
  uint8_t flags;   /* TS_HDR_REMEMBERED, TS_HDR_SIZED */
  /* One 32-bit word so positional initializers of static cells (string
     literals) keep their shape: spare = the allocation site id
     (docs/site_pretenuring_design.md). A plain object keeps the number of
     its in-object value slots after the ts_object header in inline_cap
     (object model v2, slice A3) and its remembered dirty card range in
     hdr_spare; a sized class instance (TS_HDR_SIZED) keeps its struct
     extent there instead, in words after the ts_object header (inline_cap
     the low byte, hdr_spare the high one; docs/cell_header_design.md).
     No other kind reads them. */
  union {
    uint32_t pin_word;
    struct { uint16_t spare; uint8_t inline_cap; uint8_t hdr_spare; };
  };
} ts_gc_header;
/* The flags byte: in the remembered set (for exactly one cycle; every
   enrollment, reset, promotion and sweep masks this bit alone); a sized
   class instance whose extent the two bytes above hold; an object whose
   property map lives in its sidecar (a class instance, sized or header-only,
   and one `delete` converted; docs/cell_header_design.md, H2). */
#define TS_HDR_REMEMBERED 1u
#define TS_HDR_SIZED 2u
#define TS_HDR_SIDECAR 4u
/* A cell a `publish` reached (garnet:shared, docs/published_graphs_design.md):
   immutable; a Map or Set with the flag rejects set/add/delete/clear. */
#define TS_HDR_PUBLISHED 8u
/* 8 bytes (docs/cell_header_design.md; docs/gc_v2_design.md §4.4): a heap
   reference is the address, so the cell carries no handle and no list link,
   and its size is its size class's (or its large run's), so it carries no
   size. A cell stays 16-byte aligned; its body starts at offset 8. */
_Static_assert(sizeof(ts_gc_header) == 8, "the cell header is 8 bytes");
enum { TS_GEN_YOUNG = 0, TS_GEN_OLD = 1, TS_GEN_NONHEAP = 2 };
void ts_gc_remember(ts_gc_header* h);

/* ---- heap refs (docs/gc_v2_design.md §6.8, slice D2) ----
 * Heap cells never move (they live in the cell blocks of the heap cage), so
 * a reference is the cell's address: boxing tags it, unboxing masks it, and
 * two references to one cell always have the same bits. The generation is
 * the header's gen byte. Stack/SROA cells and static literals
 * (TS_GEN_NONHEAP) carry bit 47 as a tag: they are only 8-byte aligned and
 * the collector and the write barriers tell them from heap cells without a
 * load; the tag lives above the user address space. */
tsv ts_heap_ref_value(uint16_t sel, void* p);
#define TS_PTR_STACK_TAG ((uint64_t)1u << 47)
static inline tsv ts_heap_ref_fast(uint16_t sel, void* p) {
  if (TS_RT_LIKELY(p != NULL)){
    const ts_gc_header* h = (const ts_gc_header*)p;
    if (TS_RT_LIKELY(h->gen != TS_GEN_NONHEAP)) return TS_BOX(sel, (uintptr_t)p);
    return TS_BOX(sel, (uintptr_t)p | TS_PTR_STACK_TAG);
  }
  return ts_heap_ref_value(sel, p);
}
static inline void* ts_ptr(tsv v) {
  return (void*)(uintptr_t)(v & TS_PAYLOAD_MASK & ~TS_PTR_STACK_TAG);
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
#if !TS_ISO_MODE
extern int g_has_proxies;
#endif
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
#if !TS_ISO_MODE
extern ts_key** g_ts_shape_keys;
#endif
#if !TS_ISO_MODE
extern uint8_t** g_ts_shape_flags;
#endif
/* Static-slot probes (docs/static_slots_design.md) index a shape's key vector
   at a compile-time slot below TS_STATIC_SLOT_LIMIT without a length test:
   every vector has at least that many entries, the tail filled with
   TS_KEY_NONE (no key encoding reaches it), and shapes 0 and 1 point at
   all-NONE vectors. */
#define TS_KEY_NONE 0xFFFFFFFFu
#define TS_STATIC_SLOT_LIMIT 16u
/* The probes' tables: per shape, flat ([shape * TS_STATIC_SLOT_LIMIT + slot]),
   the keys of its first slots that a probe may take (for reads every slot
   that is not an accessor, for writes plain writable data), TS_KEY_NONE
   elsewhere: one load validates both the key and its attributes. */
#if !TS_ISO_MODE
extern ts_key* g_ts_probe_rkeys;
#endif
#if !TS_ISO_MODE
extern ts_key* g_ts_probe_wkeys;
#endif
#define TS_PROP_IC_SIZE 4
/* A cache entry's slot word carries the property's attribute flags in its
   top byte, so an inline hit knows whether the slot is plain writable data
   without consulting the shape. */
#define TS_PIC_SLOT_MASK 0x00FFFFFFu
#define TS_PIC_FLAGS_SHIFT 24u
/* A sized class instance's entry (docs/pic_sized_inline_design.md): `shape`
   holds the instance's class word tagged with this bit (a shape id never
   has it: shape ids stay under 2^29, and the top three bits of an object's
   shape word are its integrity flags, which the probe masks off), `slot`
   the struct offset under TS_PIC_SLOT_MASK and the slot's kind above it
   (0 a boxed value, 1 a double, 2 an int32 in a long long). A class word
   names one layout for the program's run (layouts are registered before
   main), and an instance relinked by the program carries TS_CLS_RELINKED,
   which never matches a stored word. */
#define TS_PIC_SIZED_TAG 0x80000000u
#define TS_PIC_SIZED_FLAG 0x80u
#define TS_PIC_ABSENT_DEPTH_MASK 0x7fu
typedef struct {
  ts_key key;
  uint32_t shape;
  uint32_t slot;
} ts_prop_ic_entry;
/* A site's own record carries the epoch of the addition cache (ts_rt.c); a
   read site's absent record carries it with this bit set, so a store's check
   can never accept a read's record or the other way round. The epoch stays
   below the bit (it saturates instead of wrapping). */
#define TS_ABSENT_EPOCH_TAG 0x80000000u
typedef struct {
  ts_prop_ic_entry entries[TS_PROP_IC_SIZE];
  uint8_t next;
  uint8_t misses;
  uint8_t megamorphic;
  /* the low bits: the absent record's chain depth (at most 3); the top bit
     (TS_PIC_SIZED_FLAG): the site holds an entry for a sized class instance
     (prop_ic_fill_sized_site), so the inline probe for such receivers runs
     only then and a site that only ever sees plain objects pays one byte
     test on its misses */
  uint8_t absent_depth;
  /* The site's record: for a store, the addition it last performed
     (docs/site_add_transition_design.md); for a read, the absent property it
     last proved (docs/absent_reads_inline_design.md). rec_epoch is the epoch
     of the addition cache, tagged with TS_ABSENT_EPOCH_TAG for an absent
     record. */
  uint32_t rec_epoch;
  union {
    /* The addition: the receiver's shape word before and after, the slot (its
       length before), the key and the direct prototype. The out-of-line
       store consults it before probing for an existing key, so a
       constructor's field-by-field initialization costs one compare sequence
       and the append. */
    struct { uint32_t add_shape_before, add_shape_after, add_slot; ts_key add_key; tsv add_proto; };
    /* The absent read: receivers with either shape word lack absent_key, and
       so does every link of the prototype chain the out-of-line read walked:
       absent_depth plain shaped objects with these shape words, then the end
       of the chain. A second receiver shape with the same chain (a site that
       sees two layouts of one class) takes absent_shape2, which repeats
       absent_shape until then. */
    struct { uint32_t absent_shape; ts_key absent_key; uint32_t absent_proto_shape[3]; uint32_t absent_shape2; };
  };
} ts_prop_ic;
#define TS_PROP_IC_INIT {0}
#if TS_ISO_MODE
/* a site's inline cache in the isolate's table (the accessor experiment) */
#define TS_ISO_IC(k) (&((ts_prop_ic*)TS_ISO()->ics)[k])
#endif
_Static_assert(sizeof(ts_prop_ic) == 80, "ts_prop_ic keeps its size: one per access site");
#ifdef TSAOT_RT_STATS
extern unsigned long long g_ts_pic_get_calls, g_ts_pic_get_hits;
extern unsigned long long g_ts_slot_inline_hits, g_ts_slot_external_hits;
extern unsigned long long g_ts_pic_set_calls, g_ts_pic_set_hits;
#define TS_RT_STAT_PIC_GET_CALL() (g_ts_pic_get_calls++)
#define TS_RT_STAT_PIC_GET_HIT()  (g_ts_pic_get_hits++)
#define TS_RT_STAT_SLOT(o, slot) ((slot) < (o)->h.inline_cap ? g_ts_slot_inline_hits++ : g_ts_slot_external_hits++)
extern unsigned long long g_ts_pic_entry_hits[4], g_ts_pic_keyval_hits, g_ts_pic_ool_hits;
#define TS_RT_STAT_PIC_ENTRY(i) (g_ts_pic_entry_hits[(i)]++)
/* Statistics build only: per-key histograms of the inline hits (which keys the
   in-line reads and writes answer). */
extern unsigned long long g_ts_key_inline_get[65536], g_ts_key_inline_set[65536];
#define TS_RT_STAT_INLINE_KEY(arr, key) do { if ((uint32_t)(key) < 65536u) arr[(uint32_t)(key)]++; } while (0)
extern unsigned long long g_ts_static_get_hit, g_ts_static_get_miss, g_ts_static_set_hit, g_ts_static_set_miss, g_ts_static_learned;
extern unsigned long long g_ts_key_static_get_miss[65536], g_ts_key_static_set_miss[65536];
#define TS_RT_STAT_STATIC(c) (g_ts_static_##c++)
#define TS_RT_STAT_STATIC_MISS_KEY(arr, key) do { if ((uint32_t)(key) < 65536u) arr[(uint32_t)(key)]++; } while (0)
/* Statistics build: where a static miss actually found the key (slot 0..15,
   16 = elsewhere or absent, 17 = not a plain shaped object). */
extern unsigned long long g_ts_static_miss_slot[65536u * 18u];
void ts_rt_stat_static_miss_slot(tsv obj, ts_key key);
#define TS_RT_STAT_STATIC_MISS_SLOT(obj, key) ts_rt_stat_static_miss_slot(obj, key)
#define TS_RT_STAT_PIC_KEYVAL() (g_ts_pic_keyval_hits++)
#define TS_RT_STAT_PIC_OOL() (g_ts_pic_ool_hits++)
#define TS_RT_STAT_PIC_SET_CALL() (g_ts_pic_set_calls++)
#define TS_RT_STAT_PIC_SET_HIT()  (g_ts_pic_set_hits++)
#else
#define TS_RT_STAT_PIC_GET_CALL() ((void)0)
#define TS_RT_STAT_PIC_GET_HIT()  ((void)0)
#define TS_RT_STAT_SLOT(o, slot) ((void)0)
#define TS_RT_STAT_PIC_ENTRY(i) ((void)0)
#define TS_RT_STAT_INLINE_KEY(arr, key) ((void)0)
#define TS_RT_STAT_STATIC(c) ((void)0)
#define TS_RT_STAT_STATIC_MISS_KEY(arr, key) ((void)0)
#define TS_RT_STAT_STATIC_MISS_SLOT(obj, key) ((void)0)
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
/* A named-property map. A shaped object keeps its values past the in-object
   slots in `props` (as tsv, `cap` of them) and its keys in the shape; a
   dictionary keeps ts_prop entries. The map is lazily allocated: NULL/0
   until a named property is actually set, so element-only arrays stay light
   (V8-style fast->dictionary transition). Objects with enough named
   properties get a sparse open-addressing index; small ones keep it NULL
   and the cache-friendly linear scan. */
typedef struct ts_propmap {
  ts_prop* props; uint32_t cap, len;
  uint32_t* prop_index;          /* capacity in prop_index[0], entries after it */
} ts_propmap;
typedef struct ts_obj_common {
  ts_gc_header h;
  tsv proto;                   /* prototype chain handle (object/function or null) */
  /* A sized class instance's class index plus one: its class's position in
     a depth-first numbering of the class forest, so a class and its
     subclasses are one interval (docs/class_index_dispatch_design.md); 0 for
     every other object and after a user-level prototype change, TS_CLS_PROTO
     on a class's prototype object. */
  uint32_t cls;
  /* Low 29 bits are hidden-class identity. The high 3 bits store integrity
     flags (frozen, non-extensible, sealed), keeping the common header compact. */
  uint32_t shape;
  /* The property map, in place. The runtime reads it through obj_map /
     obj_map_plain (docs/cell_header_design.md, H2; tests/propmap_access_gate.sh);
     the field names stay for generated code. */
  union {
    ts_propmap map;
    struct { ts_prop* props; uint32_t cap, len; uint32_t* prop_index; };
  };
} ts_obj_common;
/* The class index word of a class's prototype object: no instance's, so
   intervals and tables reject it, and relinking such an object
   (setPrototypeOf on a class prototype) is what can change an instance's
   chain (g_class_relinked). */
#define TS_CLS_PROTO 0xFFFFFFFFu
/* Set on a sized instance's class index word by a user-level prototype
   change (docs/closed_receivers_design.md, slice 2): the word stays its
   allocation class, so its layout is still found from it, but it falls out
   of every interval (instanceof, field guards, dispatch tables). */
#define TS_CLS_RELINKED 0x80000000u
/* ts_object is exactly the common header (plain object / class-instance prefix). */
typedef struct ts_obj_common ts_object;
/* A class instance's prefix (docs/cell_header_design.md, H2): the common
   prefix's header, prototype, class word and shape at the same offsets, and
   instead of the 24-byte property map one pointer to an owned sidecar
   holding it, NULL until the instance's first own dynamic property. Every
   generated class struct starts with it; its fields follow. */
typedef struct ts_sized_head {
  ts_gc_header h;
  tsv proto;
  uint32_t cls;
  uint32_t shape;
  ts_propmap* dyn;
} ts_sized_head;
_Static_assert(sizeof(ts_sized_head) == 32, "a class instance's prefix is 32 bytes");
_Static_assert(offsetof(ts_sized_head, proto) == offsetof(ts_obj_common, proto) &&
               offsetof(ts_sized_head, cls) == offsetof(ts_obj_common, cls) &&
               offsetof(ts_sized_head, shape) == offsetof(ts_obj_common, shape),
               "both prefixes share the header, prototype, class word and shape");
/* An object's property map. Any object: obj_map, which for a sidecar object
   without a sidecar yet answers the shared empty map (read-only memory: a
   write through it faults; writers take obj_map_w). A shaped object, or one
   of a kind that never moves its map out (arrays, functions, collections,
   prototypes): obj_map_plain, which the checked builds verify. */
extern const ts_propmap g_ts_empty_propmap;
void ts_abort_msg(const char* m);
static inline ts_propmap* obj_map(const ts_object* o){
  if (TS_RT_UNLIKELY(o->h.flags & TS_HDR_SIDECAR)){
    ts_propmap* d = ((const ts_sized_head*)o)->dyn;
    return d ? d : (ts_propmap*)&g_ts_empty_propmap;
  }
  return (ts_propmap*)&o->map;
}
#if (defined(__has_feature) && __has_feature(address_sanitizer)) || defined(__SANITIZE_ADDRESS__) || defined(TSAOT_RT_STATS)
#define TS_RT_CHECK_PLAIN_MAP 1
#endif
static inline ts_propmap* obj_map_plain(const ts_object* o){
#if defined(TS_RT_CHECK_PLAIN_MAP)
  if (o->h.flags & TS_HDR_SIDECAR) ts_abort_msg("obj_map_plain on an object whose map is in its sidecar");
#endif
  return (ts_propmap*)&o->map;
}
static inline uint32_t ts_obj_shape_id(const ts_object* o){ return o->shape & TS_SHAPE_MAX; }
static inline uint32_t ts_obj_integrity(const ts_object* o){ return o->shape >> 29; }
/* A typed direct store's test of its receiver (docs/published_graphs_design.md,
   "Enforcement"): the frozen bit of the shape word, read from the tagged
   value the store untags anyway. Sealed and non-extensible instances keep
   their declared fields writable, as in JS. */
#define TS_OBJ_FROZEN_BIT 0x20000000u
static inline int ts_store_frozen(tsv v){ return (((const ts_object*)ts_ptr(v))->shape & TS_OBJ_FROZEN_BIT) != 0; }
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
  return slot < ic ? &ts_obj_inline_vals(o)[slot] : &((tsv*)obj_map_plain(o)->props)[slot - ic];
}
/* A sized class instance (registered struct storage after the header) versus
   a plain object whose cell is the header plus its inline slots: the
   TS_HDR_SIZED flag, set only on objects (docs/cell_header_design.md). */
static inline int ts_obj_is_sized(const ts_object* o){
  return (o->h.flags & TS_HDR_SIZED) != 0;
}
/* A sized instance's struct bytes, the ts_object header included: its
   extent words after the header (inline_cap low, hdr_spare high). Exact,
   as the allocation's size was: layouts and the location cache compare it. */
static inline size_t ts_obj_sized_bytes(const ts_object* o){
  return sizeof(ts_sized_head) + sizeof(tsv) * ((size_t)o->h.inline_cap | (size_t)o->h.hdr_spare << 8);
}
/* The extent the two header bytes can describe: 65,535 words after the
   class instance's prefix (module records are the largest classes: 2,428
   fields in the TypeScript compiler). A struct size below the prefix, off
   the word grid or past the extent aborts with a message, never truncates. */
#define TS_SIZED_EXTENT_MAX 65535u
__attribute__((noreturn)) void ts_sized_extent_abort(size_t bytes);
static inline size_t ts_sized_extent_words(size_t bytes){
  if (TS_RT_UNLIKELY(bytes < sizeof(ts_sized_head) || (bytes - sizeof(ts_sized_head)) % sizeof(tsv) != 0 ||
                     (bytes - sizeof(ts_sized_head)) / sizeof(tsv) > TS_SIZED_EXTENT_MAX))
    ts_sized_extent_abort(bytes);
  return (bytes - sizeof(ts_sized_head)) / sizeof(tsv);
}
/* A class instance's header (heap, stack and stack-check instances alike):
   its map is in its sidecar (TS_HDR_SIDECAR; the prefix has no room for one
   in place), and a sized one carries TS_HDR_SIZED and the extent. A
   header-only instance (a class without struct fields) has no extent and
   is not sized, as it was when the allocation size decided. One of the
   writers of inline_cap and hdr_spare the header gate admits
   (tests/header_bytes_gate.sh). */
static inline void ts_hdr_init_sized(ts_gc_header* h, size_t bytes){
  size_t words = ts_sized_extent_words(bytes);
  h->inline_cap = (uint8_t)words;
  h->hdr_spare = (uint8_t)(words >> 8);
  h->flags |= (uint8_t)(words ? TS_HDR_SIDECAR | TS_HDR_SIZED : TS_HDR_SIDECAR);
}
/* A typed class-field access (a struct offset) must take ts_get / ts_set for a
   receiver without the sized-instance layout: a Proxy, a plain object relinked
   behind a class prototype, a borrowed method's `this`. g_typed_slow, raised
   where such a receiver can arise, gates the test so a program that never does
   any of that keeps one predictable branch (docs/foreign_receivers_design.md). */
#if !TS_ISO_MODE
extern int g_typed_slow;
#endif
/* g_typed_slow's bits (docs/closed_receivers_design.md, slice 2): ANY, a
   foreign receiver may reach any typed access (a Proxy, a relink, a
   converted instance), which then tests it; THIS, a class method may run
   with a foreign `this` (one was read as a value or borrowed), which the
   method's entry tests, raising ANY when one arrives. */
#define TS_TYPED_SLOW_ANY 1
#define TS_TYPED_SLOW_THIS 2
void ts_foreign_this_seen(void);
/* Set by a program the exporter proved to have closed receivers
   (docs/closed_receivers_design.md): its typed accesses do not test
   g_typed_slow, so raising it there stops the program instead. */
#if !TS_ISO_MODE
extern int g_closed_receivers;
/* Conservative roots (docs/conservative_roots_design.md): the generated main
   sets it when its functions keep no GC frames; the collectors then scan the
   native stack for references, validated against the allocation bitmap. */
extern int g_conservative_roots;
int ts_gc_debug_alloc_bit(tsv v);      /* the allocation bit of a cell (tests) */
int ts_gc_debug_cell_gen(tsv v);       /* a cell header's generation (tests) */
extern uintptr_t g_gc_debug_watch;    /* tests: the conservative scan reports the word naming this cell */
#endif
static inline int ts_typed_slow(tsv v){
  return !ts_is_obj(v) || !ts_obj_is_sized((const ts_object*)ts_ptr(v));
}
/* A receiver outside the class interval [lo, lo + span) of a typed access
   (the class index words of the access's class and its subclasses): not a
   sized instance of them as allocated and never relinked. Once g_typed_slow
   is up, typed accesses test this instead of the layout alone, so a sized
   instance of another class (a borrowed or grafted method's `this`) takes
   the generic path too. */
static inline int ts_typed_outside(tsv v, uint32_t lo, uint32_t span){
  return !ts_is_obj(v) || (uint32_t)(((const ts_object*)ts_ptr(v))->cls - lo) >= span;
}
/* A class method read as a value (not called): it may run with any `this`
   from here on (docs/closed_receivers_design.md, slice 2). In line: a site
   in a loop costs a load and a branch once the flag is up. */
void ts_note_method_escape_slow(void);
static inline void ts_note_method_escape(void){
  if (TS_RT_UNLIKELY(!(g_typed_slow & TS_TYPED_SLOW_THIS))) ts_note_method_escape_slow();
}

enum {
  TS_STR_FLAG_ASCII = 1u << 0,
  TS_STR_FLAG_STATIC = 1u << 1,
  TS_STR_FLAG_VIEW = 1u << 2,
  TS_STR_FLAG_HASHED = 1u << 3,
  TS_STR_FLAG_UTF16 = 1u << 4,
  /* a flat (non-view) string's `offset` holds its UTF-8 byte length (the
     host's Buffer.byteLength; a source text is measured a few times) */
  TS_STR_FLAG_UTF8LEN = 1u << 6,
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
/* An immediate short string's bytes copied into `buf` (TS_SHORTSTR_MAX bytes)
   and the view re-pointed at them as one-byte storage, so the contiguous
   paths (memchr, memcmp) apply; any other view is returned as is. */
static inline ts_strview ts_strview_materialize(ts_strview v, char* buf){
  if (v.data || !v.len) return v;
  for (uint32_t i = 0; i < v.len; i++) buf[i] = (char)ts_str_cu_at_view(v, i);
  v.data = buf; v.flags = TS_STR_FLAG_ASCII; v.hash = 0;
  return v;
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
/* A needle's units in the haystack's storage width, into `buf` (at least
   2 * TS_STR_NEEDLE_MAX bytes): a one-byte needle widened for a two-byte
   haystack, a two-byte needle narrowed for a one-byte one (impossible when a
   unit is beyond 0xFF: `*found` is 0 and the search is a miss). A needle that
   is too long or has no data pointer is returned as is. */
#define TS_STR_NEEDLE_MAX 32u
static inline ts_strview ts_strview_rewiden(ts_strview ns, ts_strview xs, char* buf, int* found){
  *found = 1;
  if (!ns.data || !xs.data || ts_str_same_storage_width(xs, ns) || ns.len > TS_STR_NEEDLE_MAX) return ns;
  if (xs.flags & TS_STR_FLAG_UTF16){
    for (uint32_t i = 0; i < ns.len; i++){ uint16_t cu = (uint16_t)(unsigned char)ns.data[i]; memcpy(buf + (size_t)i * 2u, &cu, 2); }
    ns.data = buf; ns.flags |= TS_STR_FLAG_UTF16;
    return ns;
  }
  for (uint32_t i = 0; i < ns.len; i++){
    uint16_t cu; memcpy(&cu, ns.data + (size_t)i * 2u, 2);
    if (cu > 0xFFu){ *found = 0; return ns; }
    buf[i] = (char)(unsigned char)cu;
  }
  ns.data = buf; ns.flags &= ~TS_STR_FLAG_UTF16;
  return ns;
}
static inline int ts_str_region_eq(ts_strview xs, uint32_t xi, ts_strview ns, uint32_t ni, uint32_t len){
  if (len == 0) return 1;
  if (xs.data && ns.data){
    if (ts_str_same_storage_width(xs, ns)){
      uint32_t w = ts_str_unit_size_flags(xs.flags);
      return memcmp(xs.data + (size_t)xi * w, ns.data + (size_t)ni * w, (size_t)len * w) == 0;
    }
    /* one side two-byte, the other one-byte (a two-byte source text against
       an interned identifier): the wide unit against the byte, in line */
    const char* wide = (xs.flags & TS_STR_FLAG_UTF16) ? xs.data + (size_t)xi * 2u : ns.data + (size_t)ni * 2u;
    const unsigned char* narrow = (const unsigned char*)((xs.flags & TS_STR_FLAG_UTF16) ? ns.data + ni : xs.data + xi);
    for (uint32_t k = 0; k < len; k++){
      uint16_t cu; memcpy(&cu, wide + (size_t)k * 2u, 2);
      if (cu != narrow[k]) return 0;
    }
    return 1;
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
    if (xs.flags & TS_STR_FLAG_UTF16){
      const char* p = xs.data;
      for (uint32_t i=pos;i<pos+len;i++){
        uint16_t cu; memcpy(&cu, p + (size_t)i * 2u, 2);
        if (cu == wanted) return (long long)i;
      }
      return -1;
    }
    for (uint32_t i=pos;i<pos+len;i++)
      if ((unsigned char)xs.data[i] == wanted) return (long long)i;
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
uint32_t ts_str_switch_hash(tsv v, uint32_t none);
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
/* charCodeAt on a receiver that is not a string: an object's `charCodeAt`
   called, or the TypeError V8 throws (ts_rt.c). */
double ts_str_charcodeat_dynamic(tsv recv, double idx);
/* A Map or Set method on a receiver that is not that collection: the object's
   own method called, or the TypeError V8 throws (ts_rt.c). */
tsv ts_collection_method_dynamic(tsv recv, const char* name, tsv* args, int nargs);
/* The method value of a dynamic call on a sized class instance, through the
   method cache by class word (ts_rt.c); other receivers through the two
   cached reads. */
tsv ts_method_lookup_sized(tsv recv, ts_key fkey, ts_key mkey, ts_prop_ic* field_ic, ts_prop_ic* proto_ic);
/* A dynamic call site's cache of its method (docs/pic_sized_inline_design.md,
   "The dynamic call's method in a per-site cache"): the receiver's class
   word, the prototype holding the method, that holder's shape word and the
   slot. A hit needs the same class word (an unrelinked instance of one
   layout, of a class with no field of the method's name: the fill checks
   that), the same holder shape (a deleted or redefined method changes it; a
   replaced one keeps it, and the slot is re-read), no relinked prototype
   anywhere and no sidecar on the instance (an own property could shadow),
   and a function in the slot (an accessor takes the lookup). */
extern int g_class_relinked;
typedef struct { uint32_t cls; uint32_t holder_shape; uint32_t slot; uint32_t pad; tsv holder; } ts_method_site_ic;
tsv ts_method_lookup_sized_fill(tsv recv, ts_key fkey, ts_key mkey, ts_prop_ic* field_ic, ts_prop_ic* proto_ic, ts_method_site_ic* sic);
TS_RT_ALWAYS_INLINE tsv ts_method_lookup_sized_ic(tsv recv, ts_key fkey, ts_key mkey, ts_prop_ic* field_ic, ts_prop_ic* proto_ic, ts_method_site_ic* sic){
  if (TS_TOP16(recv) == TS_SEL_OBJECT){
    const ts_sized_head* o = (const ts_sized_head*)ts_ptr(recv);
    if (o->cls == sic->cls && sic->cls != 0u && !g_class_relinked && !o->dyn){
      ts_object* hd = (ts_object*)ts_ptr(sic->holder);
      if (hd->shape == sic->holder_shape){
        tsv v = *ts_obj_slot_ptr(hd, sic->slot);
        if (ts_is_func(v)) return v;
      }
    }
  }
  return ts_method_lookup_sized_fill(recv, fkey, mkey, field_ic, proto_ic, sic);
}
static inline double ts_str_charcodeat_general(tsv s, double idx){
  if (TS_RT_UNLIKELY(!ts_is_str(s))) return ts_str_charcodeat_dynamic(s, idx);
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
TS_RT_ALWAYS_INLINE double ts_str_charcodeat_typed(tsv s, double idx){
  if (TS_RT_LIKELY(ts_is_heap_str(s))){
    const ts_string* x = ts_str_ptr_typed(s);
    uint32_t fl = x->flags & (TS_STR_FLAG_VIEW | TS_STR_FLAG_UTF16);
    if (TS_RT_LIKELY(fl == 0) && idx >= 0 && idx < (double)x->len)
      return (double)(unsigned char)x->data[(uint32_t)idx];
    /* a flat two-byte string (a source text with one character beyond
       Latin-1 is one): the unit in line as well */
    if (fl == TS_STR_FLAG_UTF16 && idx >= 0 && idx < (double)x->len){
      uint16_t cu; memcpy(&cu, x->data + (size_t)(uint32_t)idx * 2u, 2); return (double)cu;
    }
  }
  return ts_str_charcodeat_general(s, idx);
}
static inline long long ts_str_charcodeat_i64_general(tsv s, long long i){
  if (TS_RT_UNLIKELY(!ts_is_str(s))) return (long long)ts_to_int32(ts_str_charcodeat_dynamic(s, (double)i));
  ts_strview x = ts_str_view_typed(s);
  if (i < 0 || i >= (long long)x.len) return 0;
  return (long long)ts_str_cu_at_view(x, (uint32_t)i);
}
static inline long long ts_str_charcodeat_i64_typed(tsv s, long long i){
  if (TS_RT_LIKELY(ts_is_heap_str(s))){
    const ts_string* x = ts_str_ptr_typed(s);
    uint32_t fl = x->flags & (TS_STR_FLAG_VIEW | TS_STR_FLAG_UTF16);
    if (TS_RT_LIKELY(fl == 0) && (unsigned long long)i < (unsigned long long)x->len)
      return (long long)(unsigned char)x->data[(uint32_t)i];
    if (fl == TS_STR_FLAG_UTF16 && (unsigned long long)i < (unsigned long long)x->len){
      uint16_t cu; memcpy(&cu, x->data + (size_t)(uint32_t)i * 2u, 2); return (long long)cu;
    }
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
  uint8_t kind_spare;            /* spare (typed arrays are their own kind) */
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
/* Typed arrays (docs/typed_arrays_design.md): a buffer owns bytes outside the
   heap; a view points into them and keeps the buffer alive. */
enum { TS_TA_INT8, TS_TA_UINT8, TS_TA_UINT8C, TS_TA_INT16, TS_TA_UINT16, TS_TA_INT32,
       TS_TA_UINT32, TS_TA_FLOAT32, TS_TA_FLOAT64, TS_TA_COUNT };
typedef struct ts_arraybuffer {
  ts_obj_common o;
  uint8_t* bytes;
  uint32_t byte_length;
  uint8_t shared;
} ts_arraybuffer;
typedef struct ts_typedarray {
  ts_obj_common o;
  uint8_t* data;            /* bytes + byte_offset of the buffer */
  uint32_t length, byte_offset;
  uint8_t elem;             /* TS_TA_* */
  tsv buffer;
} ts_typedarray;
static inline int ts_is_typed_array(tsv v){
  return ts_is_obj(v) && ((ts_gc_header*)ts_ptr(v))->kind == TS_KIND_TYPEDARRAY;
}
/* One test for both kinds (they are adjacent). */
static inline int ts_kind_is_buffer_or_view(uint8_t kind){
  return (uint8_t)(kind - TS_KIND_ARRAYBUFFER) <= (uint8_t)(TS_KIND_TYPEDARRAY - TS_KIND_ARRAYBUFFER);
}
static inline int ts_is_array_buffer(tsv v){
  return ts_is_obj(v) && ((ts_gc_header*)ts_ptr(v))->kind == TS_KIND_ARRAYBUFFER;
}
tsv  ts_new_typed_array(int elem, tsv* args, int n);
tsv  ts_new_shared_array_buffer(uint32_t n);   /* a store in shared memory */
/* Workers by fork (docs/fork_workers_design.md): the entry a child runs with
   its workerData, a worker's handlers, the child's postMessage. */
void ts_worker_set_entry(tsv fn);
int  ts_worker_fork(tsv data);                 /* the worker's id; the child never returns */
void ts_worker_on_message(int id, tsv fn);
void ts_worker_on_error(int id, tsv fn);
int  ts_worker_is_worker(void);
tsv  ts_worker_data(void);
void ts_worker_post(tsv value);
/* Frames from the parent to a worker (docs/published_graphs_design.md): the
   parent posts to a live worker; the worker registers its parentPort's
   message listener and closes the port when it is done (the loop then ends
   with the rest of its work). */
void ts_worker_send(int id, tsv value);
void ts_worker_on_parent_message(tsv fn);
void ts_worker_parent_close(void);
tsv  ts_message_roundtrip(tsv v);              /* the codec on one value (tests) */
tsv  ts_new_array_buffer(tsv length, int shared);
tsv  ts_typed_array_from(int elem, tsv src, tsv mapfn, tsv this_arg);
tsv  ts_typed_array_of(int elem, tsv* items, int n);
int  ts_array_buffer_is_view(tsv v);
tsv  ts_typed_array_proto(int elem);
tsv  ts_array_buffer_proto(int shared);
void ts_typed_array_globals(void);
tsv  ts_atomics_load(tsv ta, tsv index);
tsv  ts_atomics_store(tsv ta, tsv index, tsv value);
tsv  ts_atomics_rmw(int op, tsv ta, tsv index, tsv value);
tsv  ts_atomics_compare_exchange(tsv ta, tsv index, tsv expected, tsv replacement);
tsv  ts_atomics_is_lock_free(tsv n);
tsv  ts_atomics_wait(tsv ta, tsv index, tsv value, tsv timeout);
tsv  ts_atomics_notify(tsv ta, tsv index, tsv count);
tsv  ts_text_encoder_new(void);
tsv  ts_text_decoder_new(tsv label, tsv options);
tsv  ts_text_encoder_proto(void);
tsv  ts_text_decoder_proto(void);
tsv  ts_ta_get(tsv v, uint32_t i);
void ts_ta_set(tsv v, uint32_t i, tsv x);
static inline int ts_is_array_fast(tsv v){
  return ts_is_indexed_array_fast(v);
}
/* `x.length` of a value the compiler only knows to be a string, an array or a
   function (GenericLen): a string or a plain array in line, the rest (a
   function's arity, a proxy's get trap) out of line. */
double ts_length_slow(tsv v);
static inline double ts_length(tsv v){
  if (ts_is_str(v)) return (double)ts_str_len_typed(v);
  if (ts_is_indexed_array_fast(v)) return (double)((ts_array*)ts_ptr(v))->len;
  return ts_length_slow(v);
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
  uint32_t* index;   /* hash slots: 0=empty, 1=tombstone, else dense idx+2
                        under the mask and hash bits above it (TS_MAPSET_SLOT) */
  uint32_t index_cap; /* power-of-2 slot count (0 = linear mode) */
  uint32_t tombs;    /* HOLE entries in keys/vals below len */
  uint32_t* direct;  /* small non-negative integer keys only: direct[key] = dense
                        idx + 1, 0 absent; exclusive with index
                        (docs/map_direct_index_design.md) */
  uint32_t direct_cap; /* power-of-2 bound on the keys it holds (0: none) */
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
  uint32_t* index;   /* slot words as in ts_map */
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
  uint8_t proto_lazy : 1; /* 1 while the function owns a `.prototype` whose
                            object has not been created yet (prototype_prop is
                            still TS_UNDEFINED). Created, together with its
                            `constructor`, on the same first observation. */
  /* 1 once `name` / `length` stopped being the metadata's virtual own
     properties: deleted, or turned into an own entry by a definition
     (docs/function_own_properties_design.md). Same byte as proto_lazy. */
  uint8_t name_gone : 1;
  uint8_t length_gone : 1;
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
tsv ts_global_get_ref(const char* name);
void ts_global_assign_ref(const char* name, tsv val);
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
tsv  ts_set_proto_user(tsv obj, tsv proto); /* Object/Reflect.setPrototypeOf: may raise g_typed_slow */
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
tsv ts_numproto_toExponential(tsv* a, int n);
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
tsv ts_arrproto_values(tsv* args, int n);
tsv ts_arrproto_keys(tsv* args, int n);
tsv ts_arrproto_entries(tsv* args, int n);
tsv ts_array_iter_new(tsv source, int kind);

tsv  ts_make_fn(ts_code code, tsv* env, uint32_t envlen); /* boxed callable; env may be NULL */
tsv  ts_call(tsv fn, tsv* args, int nargs);               /* invoke a callable value */
tsv  ts_call_value(tsv fn, tsv* args, int nargs);         /* value/callback call (injects undefined this if takes_this) */
tsv  ts_call_method(tsv fn, tsv* args, int nargs);        /* method dispatch (args[0]=this); drops receiver if callee lacks takes_this */
/* The dynamic method call with the method value in hand (a function, as the
   caller tested): a class method takes its receiver as the first argument and
   carries no environment, so its generic entry is called directly; a bound or
   environment-carrying function and a proxy take the runtime's call
   (docs/pic_sized_inline_design.md, "The dynamic call itself in line"). */
TS_RT_ALWAYS_INLINE tsv ts_call_method_inline(tsv fn, tsv* args, int nargs){
  if (TS_RT_LIKELY(ts_is_func(fn))){
    const ts_func* f = (const ts_func*)ts_ptr(fn);
    if (TS_RT_LIKELY(f->takes_this && !f->envlen)) return ((ts_code)f->code)(args, nargs);
  }
  return ts_call_method(fn, args, nargs);
}
/* a function value (the method-call fallback tests it on every dynamic call) */
static inline int ts_is_callable(tsv v){ return ts_is_func(v); }
tsv  ts_new_sized(size_t size);
tsv  ts_new_sized_pretenured(size_t size);
/* Allocation-site pretenuring (docs/site_pretenuring_design.md): a generated
   class allocation names its site (the IR site + 1, 1..TS_ALLOC_SITE_MAX)
   and hands over the prototype, which the runtime stores with the barrier
   an old cell needs. */
#define TS_ALLOC_SITE_MAX 65535u
tsv  ts_new_sized_site(size_t size, uint32_t site, tsv proto);
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
/* The site forms of the generated object, literal and array allocations
   (docs/site_pretenuring_design.md, slice 2). */
tsv ts_new_object_site(uint32_t site);
tsv ts_new_object_n_site(uint32_t slots, uint32_t site);
tsv ts_new_object_layout_site(ts_lit_layout* layout, uint32_t site);
tsv ts_new_array_site(uint32_t len, uint32_t site);
/* Give a fresh empty object the layout in one step; 1 when its slots now
   follow the layout (store by slot), 0 when the object was not empty. */
int ts_obj_adopt_layout(tsv obj, ts_lit_layout* layout);
void ts_array_set(tsv arr, uint32_t i, tsv v);
void ts_array_push(tsv arr, tsv v);
void ts_array_push_hole(tsv arr);
int  ts_array_has_index(tsv arr, uint32_t i);
uint32_t ts_array_len(tsv arr);

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
/* Number.prototype.toFixed / toString / toPrecision with the spec's argument
   conversion and RangeErrors: _d takes a number argument, _v any value
   (undefined is the default). */
tsv ts_number_to_fixed_d(tsv numv, double digits);
tsv ts_number_to_fixed_v(tsv numv, tsv digits);
tsv ts_number_to_string_radix_d(tsv numv, double radix);
tsv ts_number_to_string_radix_v(tsv numv, tsv radix);
tsv ts_number_to_precision_d(tsv numv, double prec);
tsv ts_number_to_precision_v(tsv numv, tsv prec);
tsv ts_number_to_exponential_d(tsv numv, double digits);
tsv ts_number_to_exponential_v(tsv numv, tsv digits);
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
double ts_math_max_args(const tsv* a, int n);
double ts_math_min_args(const tsv* a, int n);
double ts_math_hypot_args(const tsv* a, int n);
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
double ts_parse_int_v(tsv v, tsv radix);   /* ToString, then ToInt32(radix) */
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
tsv    ts_reflect_get_recv(tsv t, tsv k, tsv receiver);
tsv    ts_reflect_set_recv(tsv t, tsv k, tsv v, tsv receiver);
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
/* A typed direct store on a frozen class instance: the strict-mode TypeError
   (`Cannot assign to read only property 'x' of object '#<C>'`). */
void ts_throw_frozen_field(tsv obj, ts_key key);
/* The program's class names by class id (NULL for an anonymous class), for
   messages and `console.log` prefixes of instances whose class value the
   program never observed (the prototype's `constructor` is realized lazily). */
void ts_register_class_names(const char* const* tab, uint32_t n);
/* garnet:shared (docs/published_graphs_design.md): a deep freeze of the graph
   reachable from v (its argument returned), and whether a value is a primitive
   or a cell a publish reached. */
tsv ts_publish(tsv v);
int ts_is_published(tsv v);
/* A shared worker (docs/published_graphs_design.md, "Sharing by fork"): forked
   like ts_worker_fork, but allocating into a region the parent mapped shared
   before the fork, so a graph it publishes is passed to the parent by
   reference. */
int ts_worker_fork_shared(tsv data);
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
tsv ts_json_dom_length_value(tjson_value* value);
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
void ts_define_data_desc(tsv obj, tsv keyv, tsv value, int e, int w, int c, unsigned present);
void ts_define_accessor_desc(tsv obj, tsv keyv, tsv getter, tsv setter, int g_this, int s_this, int e, int c, unsigned present);
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
/* Identity of two heap references: a cell has one reference (its address),
   so two references name one cell exactly when their bits are equal. */
static inline int ts_same_cell(tsv a, tsv b){ return a == b; }
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
/* `x === n` with n an unboxed number: only a number can be equal, and two
   numbers are strictly equal exactly when their doubles are (NaN differs from
   everything, -0 equals +0), so the boxed side's tag and payload answer in
   line with no boxing of n. */
TS_RT_ALWAYS_INLINE int ts_eq_num(tsv x, double n){
  return ts_is_num(x) && ts_to_num(x) == n;
}
/* `x === "literal"` (a static string of `len` code units): only a string of
   that length can be equal, so other kinds and lengths answer in line and
   only an equal length compares the content (string switch chains test a
   value against dozens of labels). */
TS_RT_ALWAYS_INLINE int ts_eq_strlit(tsv x, tsv lit, uint32_t len){
  if (x == lit) return 1;
  if (ts_is_heap_str(x)) return ts_str_ptr_typed(x)->len == len && ts_strict_eq_str(x, lit);
  if (ts_is_short_str(x)) return ts_short_str_len(x) == len && ts_strict_eq_str(x, lit);
  return 0;
}
int  ts_relational_slow(tsv a, tsv b, int op);
/* `<` `<=` `>` `>=` on boxed operands (op 0:< 1:<= 2:> 3:>=): two numbers in
   line (NaN compares false), anything else out of line. */
static inline int ts_relational(tsv a, tsv b, int op){
  if (TS_RT_LIKELY(ts_is_num(a) && ts_is_num(b))){
    double na = ts_to_num(a), nb = ts_to_num(b);
    switch (op){ case 0: return na < nb; case 1: return na <= nb; case 2: return na > nb; default: return na >= nb; }
  }
  return ts_relational_slow(a, b, op);
}
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
/* numeric: the slot's kind, 0 a boxed tsv, 1 an unboxed double, 2 an integer
   (`long long` holding an int32: an enum-typed field, docs/int32_fields_design.md) */
typedef struct { uint32_t name_id; size_t offset; int numeric; } ts_class_field;
void ts_throw_int32_field(double d);
/* The value stored into an integer slot: an exact int32, or a TypeError (the
   field's type says an enum member; a program storing 1.5 through a cast is
   refused, never truncated silently). */
static inline long long ts_int32_field_value(double d){
  long long i = (long long)d;
  if (TS_RT_UNLIKELY((double)i != d || i != (long long)(int32_t)i)) ts_throw_int32_field(d);
  return i;
}
void ts_register_class(tsv proto, ts_class_field* fields, int nfields);
/* Class VALUE support (`const K = C; new K()`): register a class's instance size
   and prototype by class id, box a class as a callable value, and construct an
   instance from a class value at runtime. */
void ts_register_class_meta(uint32_t class_id, size_t size, tsv proto, ts_class_field* fields, int nfields);
tsv  ts_make_class_value(uint32_t class_id, ts_code ctor, tsv* env, uint32_t envlen);
/* The class index words by class id (the generated CLASS_INDEX_TAB). */
void ts_register_class_indices(const uint32_t* tab, uint32_t n);
/* Raised when a prototype other than a sized instance's own is relinked by
   the program: a class interval may no longer describe a prototype chain. */
#if !TS_ISO_MODE
extern int g_class_relinked;
#endif
tsv  ts_make_class_value_once(uint32_t class_id, ts_code ctor, tsv* env, uint32_t envlen);
void ts_throw_uninitialized(const char* name);
tsv  ts_construct(tsv ctorv, tsv* args, int n);
/* guarded direct construction (ts_rt.c): the predicted constructor's code,
   the instance before the direct body call, the result after it */
int ts_construct_same_code(tsv ctorv, tsv fval);
tsv ts_construct_begin(tsv ctorv);
tsv  ts_construct_begin_n(tsv ctorv, uint32_t min_slots);
/* Runtime inline caches for the runtime's own reads of hidden fields (the
   iterator objects' source/position, a generator's `__coro`, a RegExp's
   internals): one shape word and slot per site, filled from the own-property
   lookup; any other receiver takes ts_get / ts_set (docs/runtime_field_caches_design.md). */
typedef struct { uint32_t shape; uint32_t slot; } ts_rt_ic;
tsv  ts_get_ic(tsv obj, ts_key key, ts_rt_ic* ic);
void ts_set_ic(tsv obj, ts_key key, tsv v, ts_rt_ic* ic);
/* Cursor-driven for..of over Map/Set (docs/map_cursor_forof_design.md). */
double ts_map_cursor_next(tsv coll, double last, double prev);
double ts_map_cursor_order(tsv coll, double idx);
tsv  ts_map_cursor_key(tsv coll, double idx);
tsv  ts_map_cursor_val(tsv coll, double idx);
tsv  ts_map_cursor_pair(tsv coll, double idx);
tsv ts_construct_end(tsv ctorv, tsv inst, tsv result);
/* Set a boxed function value's first-class metadata (`fn.length` / `fn.name`). */
void ts_set_fn_meta(tsv fn, uint32_t arity, const char* name);
void ts_set_fn_prototype(tsv fn, tsv proto);
/* Environment register of the closure ABI: a caller stores the callee's
   captured-cell buffer here immediately before the call; the callee prologue
   reads its leading cells from it before anything else runs. */
#if !TS_ISO_MODE
extern tsv* g_ts_cur_env;
#endif
/* Closure constructors for code compiled with the environment ABI. */
tsv  ts_make_closure_t(ts_code code, tsv* env, uint32_t envlen, int takes_this);
tsv  ts_make_closure_t_pretenured(ts_code code, tsv* env, uint32_t envlen, int takes_this);
/* A function object on the C stack (an allocation site the escape analysis
   proved never leaves its frame): the fields ts_make_fn_impl/ts_make_closure_t
   set, on a non-heap cell whose environment is the caller's array. */
void ts_init_fn_stack(ts_func* f, ts_code code, tsv* env, uint32_t envlen, int takes_this);
tsv  ts_make_class_value_cells(uint32_t class_id, ts_code ctor, tsv* env, uint32_t envlen);
tsv  ts_make_class_value_cells_once(uint32_t class_id, ts_code ctor, tsv* env, uint32_t envlen);
/* Give fn an own `.prototype` without allocating it: the fresh object (and its
   `constructor`) is created on first observation. Preferred emitted form. */
void ts_set_fn_prototype_lazy(tsv fn);
void ts_gc_collect(void);             /* full mark/sweep over the dynamic heap */
void ts_gc_collect_young(void);       /* minor collection of young objects */
int  ts_gc_debug_cell_live(tsv v);    /* tests: does v still name an allocated cell? */
void ts_gc_debug_log_young(void);    /* tests: log every young cell (for the probe) */
void ts_gc_root(tsv* slot);           /* register a root (stack slot address) */
/* Generated non-coroutine functions batch their boxed locals into one shadow
   frame. The slots immediately follow this header in the generated stack
   struct and are fully initialized before the frame is linked. */
typedef struct ts_frame_hdr {
  struct ts_frame_hdr* prev;
  uint32_t count;
} ts_frame_hdr;
#if !TS_ISO_MODE
extern ts_frame_hdr* g_ts_frame_top;
#endif
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
/* The generational barrier reads header bytes: only an old owner taking a
   young value is remembered. A stack owner is scanned as a root and a stack
   value is never young, so the tag answers both without a load; most stores
   go to young owners, so the owner is tested first. */
static inline void ts_write_barrier(tsv owner, tsv value){
  if (!(ts_is_obj(value)||ts_is_func(value)||ts_is_heap_str(value))) return;
  if (!(ts_is_obj(owner)||ts_is_func(owner)||ts_is_heap_str(owner))) return;
  uint64_t op = owner & TS_PAYLOAD_MASK, vp = value & TS_PAYLOAD_MASK;
  if (((op | vp) & TS_PTR_STACK_TAG) || !op || !vp) return;
  ts_gc_header* oh = (ts_gc_header*)(uintptr_t)op;
  if (oh->gen != TS_GEN_OLD || ((const ts_gc_header*)(uintptr_t)vp)->gen != TS_GEN_YOUNG) return;
  ts_gc_remember(oh);
}
/* The barrier for a store into a cell the store already untagged (a typed
   class field store: `((ClassN*)ts_ptr(obj))->f = v`): the owner's
   generation first, one byte, since most owners are young and a stack cell
   is NONHEAP; only an old owner looks at the value. */
static inline void ts_write_barrier_hdr(ts_gc_header* oh, tsv value){
  if (TS_RT_LIKELY(oh->gen != TS_GEN_OLD)) return;
  if (!(ts_is_obj(value)||ts_is_func(value)||ts_is_heap_str(value))) return;
  uint64_t vp = value & TS_PAYLOAD_MASK;
  if ((vp & TS_PTR_STACK_TAG) || !vp) return;
  if (((const ts_gc_header*)(uintptr_t)vp)->gen != TS_GEN_YOUNG) return;
  ts_gc_remember(oh);
}
/* The barrier for a write whose slot is known (docs/remembered_slots_design.md):
   an old plain object remembers a dirty card range in its header's spare
   byte, so the next minor collection scans only those cards. `p` points at
   the written slot of a SHAPED object (in-object or overflow value). A sized
   instance's header bytes hold its extent, not slots: it is remembered
   whole (docs/cell_header_design.md). */
void ts_gc_remember_slot(ts_gc_header* h, uint32_t slot);
static inline void ts_write_barrier_at(tsv owner, ts_gc_header* oh, tsv* p, tsv value){
  if (oh->kind == TS_KIND_OBJECT && !(oh->flags & (TS_HDR_SIZED | TS_HDR_SIDECAR))){
    ts_object* o = (ts_object*)oh;
    tsv* iv = ts_obj_inline_vals(o);
    uint32_t slot = (p >= iv && p < iv + oh->inline_cap)
      ? (uint32_t)(p - iv)
      : (uint32_t)(p - (tsv*)obj_map_plain(o)->props) + oh->inline_cap;
    ts_gc_remember_slot(oh, slot);
  } else {
    ts_gc_remember(oh);
  }
  (void)owner; (void)value;
}
static inline void ts_write_barrier_ptr(tsv owner, tsv* p, tsv value){
  /* the callers store into a slot of `owner`, an object they probed: its
     generation first (a stack cell is NONHEAP), the value only for an old one */
  ts_gc_header* oh = (ts_gc_header*)ts_ptr(owner);
  if (TS_RT_LIKELY(oh->gen != TS_GEN_OLD)) return;
  if (!(ts_is_obj(value)||ts_is_func(value)||ts_is_heap_str(value))) return;
  uint64_t vp = value & TS_PAYLOAD_MASK;
  if ((vp & TS_PTR_STACK_TAG) || !vp) return;
  if (((const ts_gc_header*)(uintptr_t)vp)->gen != TS_GEN_YOUNG) return;
  ts_write_barrier_at(owner, oh, p, value);
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
  if (o->h.kind > TS_KIND_ARRAY || sid == TS_SHAPE_NONE) return NULL;   /* a plain object or an array */
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
    if (e0->shape != TS_SHAPE_NONE && slot0 < obj_map_plain(o)->len && g_ts_shape_keys[sid][slot0] == key){
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
    if (e->shape != TS_SHAPE_NONE && slot < obj_map_plain(o)->len && g_ts_shape_keys[sid][slot] == key){
      *flags = g_ts_shape_flags[sid][slot];
      TS_RT_STAT_PIC_KEYVAL();
      return ts_obj_slot_ptr(o, slot);
    }
  }
  return NULL;
}
/* The per-site entry of a sized class instance's struct field, when the
   receiver is a sized instance of the class the entry was filled from: the
   entry, or NULL (the out-of-line read or write fills one on its struct
   path; a relinked instance never matches). Probed at the head of the
   out-of-line read and write, not in line: the inline functions stay as they
   are, so a typed program's thousands of plain-object sites pay nothing. */
TS_RT_ALWAYS_INLINE const ts_prop_ic_entry* ts_prop_ic_probe_sized_inline(
    const ts_object* o, ts_key key, const ts_prop_ic* ic){
  if (!(ic->absent_depth & TS_PIC_SIZED_FLAG) || !ts_obj_is_sized(o)) return NULL;
  uint32_t w = o->cls | TS_PIC_SIZED_TAG;
#if defined(__clang__)
#pragma clang loop unroll(disable)
#elif defined(__GNUC__)
#pragma GCC unroll 1
#endif
  for (uint32_t i = 0; i < TS_PROP_IC_SIZE; i++){
    const ts_prop_ic_entry* e = &ic->entries[i];
    if (e->shape == w && e->key == key) return e;
  }
  return NULL;
}
/* The registry's field cache by class word (ts_rt.c class_field_lookup; the
   hash is prop_key_hash's), read in line at a megamorphic class-typed site
   (docs/pic_sized_inline_design.md, "The megamorphic site in line"): a site
   over many classes holds no useful entry of its own, and this table holds
   one slot per class and key for the run. An entry is valid for the layout
   epoch it was filled in. */
typedef struct { uint32_t cls; ts_key key; uint32_t epoch; uint32_t offset; int found, numeric; } ts_class_word_cache_entry;
#define TS_CLASS_WORD_CACHE_SIZE 1024u
extern ts_class_word_cache_entry g_class_word_cache[TS_CLASS_WORD_CACHE_SIZE];
extern uint32_t g_ts_class_layout_epoch;
TS_RT_ALWAYS_INLINE uint32_t ts_prop_key_hash(ts_key key){
  uint32_t x = key;
  x ^= x >> 16;
  x *= 0x7feb352du;
  x ^= x >> 15;
  x *= 0x846ca68bu;
  return x ^ (x >> 16);
}
/* The table's valid entry for a sized receiver's class word and a key, found
   or not (a negative entry says the class has no such field), or NULL when
   the table holds none (or the receiver is not a plain sized instance). */
TS_RT_ALWAYS_INLINE const ts_class_word_cache_entry* ts_class_word_cache_entry_for(const ts_object* o, ts_key key){
  if (!ts_obj_is_sized(o)) return NULL;
  uint32_t w = o->cls;
  if (w == 0u || (w & TS_CLS_RELINKED) || w == TS_CLS_PROTO) return NULL;
  const ts_class_word_cache_entry* e = &g_class_word_cache[((w * 0x9E3779B1u) ^ ts_prop_key_hash(key)) & (TS_CLASS_WORD_CACHE_SIZE - 1u)];
  if (e->cls != w || e->key != key || e->epoch != g_ts_class_layout_epoch) return NULL;
  return e;
}
TS_RT_ALWAYS_INLINE const ts_class_word_cache_entry* ts_class_word_cache_probe(const ts_object* o, ts_key key){
  const ts_class_word_cache_entry* e = ts_class_word_cache_entry_for(o, key);
  return (e && e->found) ? e : NULL;
}
/* A field access whose receiver the program types as a class instance while
   its class dispatches dynamically (docs/pic_sized_inline_design.md, "At a
   class-typed site"): such a receiver is never a shaped object, so the sized
   probe runs in line and the shaped probe not at all; a miss takes the
   cached read or write (which fills the entry on its struct path). A
   megamorphic site reads the registry's cache by class word instead. */
TS_RT_ALWAYS_INLINE int ts_get_sized_pic_try(tsv obj, ts_key key, const ts_prop_ic* ic, tsv* out){
  if (!ic || TS_TOP16(obj) != TS_SEL_OBJECT) return 0;
  const ts_object* o = (const ts_object*)ts_ptr(obj);
  if (ic->megamorphic){
    const ts_class_word_cache_entry* c = ts_class_word_cache_probe(o, key);
    if (!c) return 0;
    const char* at = (const char*)o + c->offset;
    if (c->numeric == 0){ memcpy(out, at, sizeof *out); return 1; }
    if (c->numeric == 2){ long long n; memcpy(&n, at, sizeof n); *out = ts_num((double)n); return 1; }
    double d; memcpy(&d, at, sizeof d); *out = ts_num(d); return 1;
  }
  const ts_prop_ic_entry* e = ts_prop_ic_probe_sized_inline(o, key, ic);
  if (!e) return 0;
  const char* at = (const char*)o + (e->slot & TS_PIC_SLOT_MASK);
  uint32_t kind = e->slot >> TS_PIC_FLAGS_SHIFT;
  TS_RT_STAT_PIC_GET_CALL(); TS_RT_STAT_PIC_GET_HIT();
  if (kind == 0){ memcpy(out, at, sizeof *out); return 1; }
  if (kind == 1){ double d; memcpy(&d, at, sizeof d); *out = ts_num(d); return 1; }
  long long n; memcpy(&n, at, sizeof n); *out = ts_num((double)n); return 1;
}
TS_RT_ALWAYS_INLINE tsv ts_get_sized_pic_inline(tsv obj, ts_key key, ts_prop_ic* ic){
  tsv v;
  if (ts_get_sized_pic_try(obj, key, ic, &v)) return v;
  return ts_get_pic_checked(obj, key, ic);
}
TS_RT_ALWAYS_INLINE tsv ts_get_sized_pic_inline_lazy(tsv obj, ts_key key, ts_prop_ic* ic, ts_frame_hdr* frame, uint32_t nslots){
  tsv v;
  if (ts_get_sized_pic_try(obj, key, ic, &v)) return v;
  ts_frame_push(frame, nslots);
  tsv r = ts_get_pic_checked(obj, key, ic);
  ts_frame_pop(frame);
  return r;
}
TS_RT_ALWAYS_INLINE int ts_set_sized_pic_try(tsv obj, ts_key key, tsv value, ts_prop_ic* ic){
  if (!ic || TS_TOP16(obj) != TS_SEL_OBJECT) return 0;
  ts_object* o = (ts_object*)ts_ptr(obj);
  if (ic->megamorphic){
    const ts_class_word_cache_entry* c = ts_class_word_cache_probe(o, key);
    if (!c || ts_obj_integrity(o) != 0u) return 0;
    char* at = (char*)o + c->offset;
    if (c->numeric == 0){ memcpy(at, &value, sizeof value); ts_write_barrier(obj, value); return 1; }
    if (c->numeric == 1 && ts_is_num(value)){ double d = ts_to_num(value); memcpy(at, &d, sizeof d); return 1; }
    return 0;
  }
  const ts_prop_ic_entry* e = ts_prop_ic_probe_sized_inline(o, key, ic);
  if (!e || ts_obj_integrity(o) != 0u) return 0;
  char* at = (char*)o + (e->slot & TS_PIC_SLOT_MASK);
  uint32_t kind = e->slot >> TS_PIC_FLAGS_SHIFT;
  if (kind == 0){ TS_RT_STAT_PIC_SET_CALL(); TS_RT_STAT_PIC_SET_HIT(); memcpy(at, &value, sizeof value); ts_write_barrier(obj, value); return 1; }
  if (kind == 1 && ts_is_num(value)){ TS_RT_STAT_PIC_SET_CALL(); TS_RT_STAT_PIC_SET_HIT(); double d = ts_to_num(value); memcpy(at, &d, sizeof d); return 1; }
  return 0;
}
TS_RT_ALWAYS_INLINE void ts_set_sized_pic_inline(tsv obj, ts_key key, tsv value, ts_prop_ic* ic){
  if (!ts_set_sized_pic_try(obj, key, value, ic)) ts_set_pic(obj, key, value, ic);
}
TS_RT_ALWAYS_INLINE void ts_set_sized_pic_inline_lazy(tsv obj, ts_key key, tsv value, ts_prop_ic* ic, ts_frame_hdr* frame, uint32_t nslots){
  if (ts_set_sized_pic_try(obj, key, value, ic)) return;
  ts_frame_push(frame, nslots);
  ts_set_pic(obj, key, value, ic);
  ts_frame_pop(frame);
}
TS_RT_ALWAYS_INLINE tsv ts_get_pic_checked_inline(
    tsv obj, ts_key key, ts_prop_ic* ic){
  uint8_t flags = 0;
  tsv* p = ts_prop_ic_probe_fixed_inline(obj, key, ic, &flags);
  if (p && !(flags & TS_PROP_ACCESSOR)){
    TS_RT_STAT_PIC_GET_CALL(); TS_RT_STAT_PIC_GET_HIT(); TS_RT_STAT_INLINE_KEY(g_ts_key_inline_get, key);
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
      TS_RT_STAT_PIC_SET_CALL(); TS_RT_STAT_PIC_SET_HIT(); TS_RT_STAT_INLINE_KEY(g_ts_key_inline_set, key);
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
    obj_map_plain(o)->props[i].val = v;
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
    TS_RT_STAT_PIC_GET_CALL(); TS_RT_STAT_PIC_GET_HIT(); TS_RT_STAT_INLINE_KEY(g_ts_key_inline_get, key);
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
      TS_RT_STAT_PIC_SET_CALL(); TS_RT_STAT_PIC_SET_HIT(); TS_RT_STAT_INLINE_KEY(g_ts_key_inline_set, key);
      *p = value; ts_write_barrier_ptr(obj, p, value); return;
    }
  }
  ts_frame_push(frame, nslots);
  ts_set_pic(obj, key, value, ic);
  ts_frame_pop(frame);
}
/* Static-slot probes (docs/static_slots_design.md): the exporter predicted
   that `key` sits at in-object slot `slot` (below TS_STATIC_SLOT_LIMIT) on
   this receiver's type; the shape's padded key vector confirms it and the
   attribute byte must be plain data (`mask`/`want`: no accessor for a read,
   writable and no accessor for a write). NULL leaves the decision to the
   out-of-line path: any other receiver, a dictionary or sized instance (shape
   0), an accessor or read-only slot. */
TS_RT_ALWAYS_INLINE tsv* ts_static_slot_probe(tsv obj, ts_key key, uint32_t slot, uint8_t mask, uint8_t want, const ts_prop_ic* ic){
  if (TS_TOP16(obj) != TS_SEL_OBJECT) return NULL;
  ts_object* o = (ts_object*)ts_ptr(obj);
  if (o->h.kind > TS_KIND_ARRAY) return NULL;
  uint32_t sid = ts_obj_shape_id(o);
  /* `want` is a constant: plain writable data for a write, no accessor for a read */
  const ts_key* ks = (want ? g_ts_probe_wkeys : g_ts_probe_rkeys) + (size_t)sid * TS_STATIC_SLOT_LIMIT;
  if (ks[slot] != key){
    /* The slot the site learned from its first miss (the out-of-line path
       fills the cache): a receiver family the prediction did not cover. */
    slot = ic->entries[0].slot & TS_PIC_SLOT_MASK;
    if (slot >= TS_STATIC_SLOT_LIMIT || ks[slot] != key) return NULL;
    TS_RT_STAT_STATIC(learned);
  }
  (void)mask;
  /* The key is at `slot` (so slot < len): in-object, or in the external value
     vector when the object outgrew its in-object capacity (the cold branch). */
  return ts_obj_slot_ptr(o, slot);
}
/* Two predicted slots (constructor layouts that disagree after a gap). */
TS_RT_ALWAYS_INLINE tsv* ts_static_slot_probe2(tsv obj, ts_key key, uint32_t s1, uint32_t s2, uint8_t mask, uint8_t want, const ts_prop_ic* ic){
  if (TS_TOP16(obj) != TS_SEL_OBJECT) return NULL;
  ts_object* o = (ts_object*)ts_ptr(obj);
  if (o->h.kind > TS_KIND_ARRAY) return NULL;
  uint32_t sid = ts_obj_shape_id(o);
  /* `want` is a constant: plain writable data for a write, no accessor for a read */
  const ts_key* ks = (want ? g_ts_probe_wkeys : g_ts_probe_rkeys) + (size_t)sid * TS_STATIC_SLOT_LIMIT;
  uint32_t slot = ks[s1] == key ? s1 : ks[s2] == key ? s2 : TS_STATIC_SLOT_LIMIT;
  if (slot == TS_STATIC_SLOT_LIMIT){
    slot = ic->entries[0].slot & TS_PIC_SLOT_MASK;
    if (slot >= TS_STATIC_SLOT_LIMIT || ks[slot] != key) return NULL;
    TS_RT_STAT_STATIC(learned);
  }
  (void)mask;
  /* The key is at `slot` (so slot < len): in-object, or in the external value
     vector when the object outgrew its in-object capacity (the cold branch). */
  return ts_obj_slot_ptr(o, slot);
}
/* Three predicted slots (producers that disagree, e.g. `objectFlags` of the
   compiler's object, union and intrinsic types). */
TS_RT_ALWAYS_INLINE tsv* ts_static_slot_probe3(tsv obj, ts_key key, uint32_t s1, uint32_t s2, uint32_t s3, uint8_t mask, uint8_t want, const ts_prop_ic* ic){
  if (TS_TOP16(obj) != TS_SEL_OBJECT) return NULL;
  ts_object* o = (ts_object*)ts_ptr(obj);
  if (o->h.kind > TS_KIND_ARRAY) return NULL;
  uint32_t sid = ts_obj_shape_id(o);
  /* `want` is a constant: plain writable data for a write, no accessor for a read */
  const ts_key* ks = (want ? g_ts_probe_wkeys : g_ts_probe_rkeys) + (size_t)sid * TS_STATIC_SLOT_LIMIT;
  uint32_t slot = ks[s1] == key ? s1 : ks[s2] == key ? s2 : ks[s3] == key ? s3 : TS_STATIC_SLOT_LIMIT;
  if (slot == TS_STATIC_SLOT_LIMIT){
    slot = ic->entries[0].slot & TS_PIC_SLOT_MASK;
    if (slot >= TS_STATIC_SLOT_LIMIT || ks[slot] != key) return NULL;
    TS_RT_STAT_STATIC(learned);
  }
  (void)mask;
  /* The key is at `slot` (so slot < len): in-object, or in the external value
     vector when the object outgrew its in-object capacity (the cold branch). */
  return ts_obj_slot_ptr(o, slot);
}
TS_RT_ALWAYS_INLINE tsv ts_get_static_inline(tsv obj, ts_key key, uint32_t slot, ts_prop_ic* ic){
  tsv* p = ts_static_slot_probe(obj, key, slot, TS_PROP_ACCESSOR, 0, ic);
  if (p){ TS_RT_STAT_STATIC(get_hit); return *p; }
  TS_RT_STAT_STATIC(get_miss); TS_RT_STAT_STATIC_MISS_KEY(g_ts_key_static_get_miss, key); TS_RT_STAT_STATIC_MISS_SLOT(obj, key);
  return ts_get_pic_checked(obj, key, ic);
}
TS_RT_ALWAYS_INLINE tsv ts_get_static2_inline(tsv obj, ts_key key, uint32_t s1, uint32_t s2, ts_prop_ic* ic){
  tsv* p = ts_static_slot_probe2(obj, key, s1, s2, TS_PROP_ACCESSOR, 0, ic);
  if (p){ TS_RT_STAT_STATIC(get_hit); return *p; }
  TS_RT_STAT_STATIC(get_miss); TS_RT_STAT_STATIC_MISS_KEY(g_ts_key_static_get_miss, key); TS_RT_STAT_STATIC_MISS_SLOT(obj, key);
  return ts_get_pic_checked(obj, key, ic);
}
TS_RT_ALWAYS_INLINE tsv ts_get_static3_inline(tsv obj, ts_key key, uint32_t s1, uint32_t s2, uint32_t s3, ts_prop_ic* ic){
  tsv* p = ts_static_slot_probe3(obj, key, s1, s2, s3, TS_PROP_ACCESSOR, 0, ic);
  if (p){ TS_RT_STAT_STATIC(get_hit); return *p; }
  TS_RT_STAT_STATIC(get_miss); TS_RT_STAT_STATIC_MISS_KEY(g_ts_key_static_get_miss, key); TS_RT_STAT_STATIC_MISS_SLOT(obj, key);
  return ts_get_pic_checked(obj, key, ic);
}
TS_RT_ALWAYS_INLINE void ts_set_static_inline(tsv obj, ts_key key, uint32_t slot, tsv value, ts_prop_ic* ic){
  tsv* p = ts_static_slot_probe(obj, key, slot, TS_PROP_ACCESSOR | TS_PROP_WRITABLE, TS_PROP_WRITABLE, ic);
  if (p && !(ts_obj_integrity((ts_object*)ts_ptr(obj)) & 1u)){
    TS_RT_STAT_STATIC(set_hit);
    *p = value; ts_write_barrier_ptr(obj, p, value); return;
  }
  TS_RT_STAT_STATIC(set_miss); TS_RT_STAT_STATIC_MISS_KEY(g_ts_key_static_set_miss, key);
  ts_set_pic(obj, key, value, ic);
}
TS_RT_ALWAYS_INLINE void ts_set_static2_inline(tsv obj, ts_key key, uint32_t s1, uint32_t s2, tsv value, ts_prop_ic* ic){
  tsv* p = ts_static_slot_probe2(obj, key, s1, s2, TS_PROP_ACCESSOR | TS_PROP_WRITABLE, TS_PROP_WRITABLE, ic);
  if (p && !(ts_obj_integrity((ts_object*)ts_ptr(obj)) & 1u)){
    TS_RT_STAT_STATIC(set_hit);
    *p = value; ts_write_barrier_ptr(obj, p, value); return;
  }
  TS_RT_STAT_STATIC(set_miss); TS_RT_STAT_STATIC_MISS_KEY(g_ts_key_static_set_miss, key);
  ts_set_pic(obj, key, value, ic);
}
TS_RT_ALWAYS_INLINE void ts_set_static3_inline(tsv obj, ts_key key, uint32_t s1, uint32_t s2, uint32_t s3, tsv value, ts_prop_ic* ic){
  tsv* p = ts_static_slot_probe3(obj, key, s1, s2, s3, TS_PROP_ACCESSOR | TS_PROP_WRITABLE, TS_PROP_WRITABLE, ic);
  if (p && !(ts_obj_integrity((ts_object*)ts_ptr(obj)) & 1u)){
    TS_RT_STAT_STATIC(set_hit);
    *p = value; ts_write_barrier_ptr(obj, p, value); return;
  }
  TS_RT_STAT_STATIC(set_miss); TS_RT_STAT_STATIC_MISS_KEY(g_ts_key_static_set_miss, key);
  ts_set_pic(obj, key, value, ic);
}
/* Lazily linked frames: the slow path may allocate or throw. */
TS_RT_ALWAYS_INLINE tsv ts_get_static_inline_lazy(tsv obj, ts_key key, uint32_t slot, ts_prop_ic* ic, ts_frame_hdr* frame, uint32_t nslots){
  tsv* p = ts_static_slot_probe(obj, key, slot, TS_PROP_ACCESSOR, 0, ic);
  if (p){ TS_RT_STAT_STATIC(get_hit); return *p; }
  TS_RT_STAT_STATIC(get_miss); TS_RT_STAT_STATIC_MISS_KEY(g_ts_key_static_get_miss, key); TS_RT_STAT_STATIC_MISS_SLOT(obj, key);
  ts_frame_push(frame, nslots);
  tsv r = ts_get_pic_checked(obj, key, ic);
  ts_frame_pop(frame);
  return r;
}
TS_RT_ALWAYS_INLINE tsv ts_get_static2_inline_lazy(tsv obj, ts_key key, uint32_t s1, uint32_t s2, ts_prop_ic* ic, ts_frame_hdr* frame, uint32_t nslots){
  tsv* p = ts_static_slot_probe2(obj, key, s1, s2, TS_PROP_ACCESSOR, 0, ic);
  if (p){ TS_RT_STAT_STATIC(get_hit); return *p; }
  TS_RT_STAT_STATIC(get_miss); TS_RT_STAT_STATIC_MISS_KEY(g_ts_key_static_get_miss, key); TS_RT_STAT_STATIC_MISS_SLOT(obj, key);
  ts_frame_push(frame, nslots);
  tsv r = ts_get_pic_checked(obj, key, ic);
  ts_frame_pop(frame);
  return r;
}
TS_RT_ALWAYS_INLINE tsv ts_get_static3_inline_lazy(tsv obj, ts_key key, uint32_t s1, uint32_t s2, uint32_t s3, ts_prop_ic* ic, ts_frame_hdr* frame, uint32_t nslots){
  tsv* p = ts_static_slot_probe3(obj, key, s1, s2, s3, TS_PROP_ACCESSOR, 0, ic);
  if (p){ TS_RT_STAT_STATIC(get_hit); return *p; }
  TS_RT_STAT_STATIC(get_miss); TS_RT_STAT_STATIC_MISS_KEY(g_ts_key_static_get_miss, key); TS_RT_STAT_STATIC_MISS_SLOT(obj, key);
  ts_frame_push(frame, nslots);
  tsv r = ts_get_pic_checked(obj, key, ic);
  ts_frame_pop(frame);
  return r;
}
TS_RT_ALWAYS_INLINE void ts_set_static_inline_lazy(tsv obj, ts_key key, uint32_t slot, tsv value, ts_prop_ic* ic, ts_frame_hdr* frame, uint32_t nslots){
  tsv* p = ts_static_slot_probe(obj, key, slot, TS_PROP_ACCESSOR | TS_PROP_WRITABLE, TS_PROP_WRITABLE, ic);
  if (p && !(ts_obj_integrity((ts_object*)ts_ptr(obj)) & 1u)){
    TS_RT_STAT_STATIC(set_hit);
    *p = value; ts_write_barrier_ptr(obj, p, value); return;
  }
  TS_RT_STAT_STATIC(set_miss); TS_RT_STAT_STATIC_MISS_KEY(g_ts_key_static_set_miss, key);
  ts_frame_push(frame, nslots);
  ts_set_pic(obj, key, value, ic);
  ts_frame_pop(frame);
}
TS_RT_ALWAYS_INLINE void ts_set_static2_inline_lazy(tsv obj, ts_key key, uint32_t s1, uint32_t s2, tsv value, ts_prop_ic* ic, ts_frame_hdr* frame, uint32_t nslots){
  tsv* p = ts_static_slot_probe2(obj, key, s1, s2, TS_PROP_ACCESSOR | TS_PROP_WRITABLE, TS_PROP_WRITABLE, ic);
  if (p && !(ts_obj_integrity((ts_object*)ts_ptr(obj)) & 1u)){
    TS_RT_STAT_STATIC(set_hit);
    *p = value; ts_write_barrier_ptr(obj, p, value); return;
  }
  TS_RT_STAT_STATIC(set_miss); TS_RT_STAT_STATIC_MISS_KEY(g_ts_key_static_set_miss, key);
  ts_frame_push(frame, nslots);
  ts_set_pic(obj, key, value, ic);
  ts_frame_pop(frame);
}
TS_RT_ALWAYS_INLINE void ts_set_static3_inline_lazy(tsv obj, ts_key key, uint32_t s1, uint32_t s2, uint32_t s3, tsv value, ts_prop_ic* ic, ts_frame_hdr* frame, uint32_t nslots){
  tsv* p = ts_static_slot_probe3(obj, key, s1, s2, s3, TS_PROP_ACCESSOR | TS_PROP_WRITABLE, TS_PROP_WRITABLE, ic);
  if (p && !(ts_obj_integrity((ts_object*)ts_ptr(obj)) & 1u)){
    TS_RT_STAT_STATIC(set_hit);
    *p = value; ts_write_barrier_ptr(obj, p, value); return;
  }
  TS_RT_STAT_STATIC(set_miss); TS_RT_STAT_STATIC_MISS_KEY(g_ts_key_static_set_miss, key);
  ts_frame_push(frame, nslots);
  ts_set_pic(obj, key, value, ic);
  ts_frame_pop(frame);
}
/* Number keys of element access (docs/array_index_keys_design.md): an array
   index is an integer in [0, 2^32 - 1); the key paths below take the element
   path for an index and the dynamic property path for any other number. */
#define TS_ARRAY_INDEX_LIMIT 4294967295ull
static inline int ts_num_array_index(double d, uint32_t* out){
  if (d >= 0.0 && d < 4294967295.0){ uint32_t i = (uint32_t)d; if ((double)i == d){ *out = i; return 1; } }
  return 0;
}
tsv ts_array_get_key_i64(tsv arr, int64_t i);
tsv ts_array_get_key_f64(tsv arr, double d);
void ts_array_set_key_i64(tsv arr, int64_t i, tsv v);
void ts_array_set_key_f64(tsv arr, double d, tsv v);
/* Elements and length of a view in line (TA2, docs/typed_arrays_design.md),
   for a receiver whose static type is a view of element type `elem` (a
   constant at every site, so the switches fold). A view of that type with
   the index in range reads or writes the element; for anything else the try
   functions return 0 and the caller takes the generic element entry. The
   bytes move through memcpy: views of different element types alias one
   buffer. */
static inline ts_typedarray* ts_ta_as(tsv v, int elem){
  if (!ts_is_obj(v)) return NULL;
  ts_typedarray* t = (ts_typedarray*)ts_ptr(v);
  return t->o.h.kind == TS_KIND_TYPEDARRAY && t->elem == (uint8_t)elem ? t : NULL;
}
static inline uint8_t ts_ta_clamp_u8(double d){
  if (!(d > 0)) return 0;           /* NaN, -0, negatives */
  if (d >= 255) return 255;
  double f = floor(d), r = d - f;
  uint32_t u = (uint32_t)f;
  if (r > 0.5 || (r == 0.5 && (u & 1u))) u++;   /* round half to even */
  return (uint8_t)u;
}
TS_RT_ALWAYS_INLINE double ts_ta_elem_load(const uint8_t* data, uint32_t i, int elem){
  switch (elem){
    case TS_TA_INT8: return (double)((const int8_t*)data)[i];
    case TS_TA_UINT8: case TS_TA_UINT8C: return (double)data[i];
    case TS_TA_INT16: { int16_t x; memcpy(&x, data + (size_t)i * 2u, 2); return (double)x; }
    case TS_TA_UINT16: { uint16_t x; memcpy(&x, data + (size_t)i * 2u, 2); return (double)x; }
    case TS_TA_INT32: { int32_t x; memcpy(&x, data + (size_t)i * 4u, 4); return (double)x; }
    case TS_TA_UINT32: { uint32_t x; memcpy(&x, data + (size_t)i * 4u, 4); return (double)x; }
    case TS_TA_FLOAT32: { float x; memcpy(&x, data + (size_t)i * 4u, 4); return (double)x; }
    default: { double x; memcpy(&x, data + (size_t)i * 8u, 8); return x; }
  }
}
/* The element conversions: ToInt8 .. ToUint32 by ToInt32's bits, Uint8Clamped
   by rounding half to even, Float32 by rounding. */
TS_RT_ALWAYS_INLINE void ts_ta_elem_store(uint8_t* data, uint32_t i, double d, int elem){
  switch (elem){
    case TS_TA_INT8: case TS_TA_UINT8: data[i] = (uint8_t)(uint32_t)ts_to_int32(d); break;
    case TS_TA_UINT8C: data[i] = ts_ta_clamp_u8(d); break;
    case TS_TA_INT16: case TS_TA_UINT16: { uint16_t x = (uint16_t)(uint32_t)ts_to_int32(d); memcpy(data + (size_t)i * 2u, &x, 2); break; }
    case TS_TA_INT32: case TS_TA_UINT32: { int32_t x = ts_to_int32(d); memcpy(data + (size_t)i * 4u, &x, 4); break; }
    case TS_TA_FLOAT32: { float x = (float)d; memcpy(data + (size_t)i * 4u, &x, 4); break; }
    default: memcpy(data + (size_t)i * 8u, &d, 8); break;
  }
}
TS_RT_ALWAYS_INLINE int ts_ta_try_load_i(tsv v, int64_t i, int elem, double* out){
  ts_typedarray* t = ts_ta_as(v, elem);
  if (TS_RT_LIKELY(t && (uint64_t)i < t->length)){ *out = ts_ta_elem_load(t->data, (uint32_t)i, elem); return 1; }
  return 0;
}
TS_RT_ALWAYS_INLINE int ts_ta_try_load_f(tsv v, double d, int elem, double* out){
  uint32_t i;
  return ts_num_array_index(d, &i) && ts_ta_try_load_i(v, (int64_t)i, elem, out);
}
/* An integer element as ToInt32 of its value (Uint32 wraps), for a destination
   that holds ToInt32 anyway: no double in between. Integer kinds only. */
TS_RT_ALWAYS_INLINE int32_t ts_ta_elem_load_i32(const uint8_t* data, uint32_t i, int elem){
  switch (elem){
    case TS_TA_INT8: return (int32_t)((const int8_t*)data)[i];
    case TS_TA_UINT8: case TS_TA_UINT8C: return (int32_t)data[i];
    case TS_TA_INT16: { int16_t x; memcpy(&x, data + (size_t)i * 2u, 2); return (int32_t)x; }
    case TS_TA_UINT16: { uint16_t x; memcpy(&x, data + (size_t)i * 2u, 2); return (int32_t)x; }
    case TS_TA_INT32: { int32_t x; memcpy(&x, data + (size_t)i * 4u, 4); return x; }
    default: { uint32_t x; memcpy(&x, data + (size_t)i * 4u, 4); return (int32_t)x; }
  }
}
TS_RT_ALWAYS_INLINE int ts_ta_try_load_i32(tsv v, int64_t i, int elem, int32_t* out){
  ts_typedarray* t = ts_ta_as(v, elem);
  if (TS_RT_LIKELY(t && (uint64_t)i < t->length)){ *out = ts_ta_elem_load_i32(t->data, (uint32_t)i, elem); return 1; }
  return 0;
}
TS_RT_ALWAYS_INLINE int ts_ta_try_store_i(tsv v, int64_t i, double x, int elem){
  ts_typedarray* t = ts_ta_as(v, elem);
  if (TS_RT_LIKELY(t && (uint64_t)i < t->length)){ ts_ta_elem_store(t->data, (uint32_t)i, x, elem); return 1; }
  return 0;
}
TS_RT_ALWAYS_INLINE int ts_ta_try_store_f(tsv v, double d, double x, int elem){
  uint32_t i;
  return ts_num_array_index(d, &i) && ts_ta_try_store_i(v, (int64_t)i, x, elem);
}
/* `view.length`: any view without own properties (an own `length` would
   shadow the accessor). */
/* ---- Map and Set number keys (docs/map_entries_design.md) ----
   The hash of a number key, consistent with SameValueZero: +0 and -0 one
   value, every NaN one value, then MurmurHash3's fmix64 (a small integer's
   double has a zero low word; one multiply left the slot-choosing low bits
   poor). The map code and the inline lookups below share it. */
#define TS_MAPSET_NEG_ZERO 0x8000000000000000ull
TS_RT_ALWAYS_INLINE uint32_t sv0_hash_num_d(double d){
  uint64_t bits;
  if (d == 0) d = 0;                            /* -0 -> +0 */
  if (d != d) bits = 0x7FF8000000000000ull;     /* canonical NaN */
  else memcpy(&bits, &d, sizeof bits);
  bits ^= bits >> 33; bits *= 0xff51afd7ed558ccdull; bits ^= bits >> 33;
  bits *= 0xc4ceb9fe1a85ec53ull; bits ^= bits >> 33;
  return (uint32_t)bits;
}
TS_RT_ALWAYS_INLINE uint32_t sv0_hash_num(tsv k){ return sv0_hash_num_d(ts_to_num(k)); }
/* Map.get / Map.has with a number key from an unboxed local (the checker's
   id-keyed caches, 10 M of a compile's 16 M lookups): the indexed map's probe
   in line, the key found by its very bits (a stored number key is canonical:
   +0, one NaN), or absent at an empty slot. Anything else, a receiver that is
   not a Map, a map still in linear mode, a slot whose key is an equal number
   with other bits, takes the general entry. The general entry alone was 7% of
   a compile's samples at about 25 cycles a call. */
/* The hash a collection asks for: an immediate's bytes folded in line (the
   same value as the runtime's strhash_view: a one-byte unit's two FNV-1a steps
   are one multiply by the prime's square), a hashed heap string's cached hash,
   and the general entry (which computes and caches) for the rest. */
uint32_t ts_str_hash_cached(tsv s);
TS_RT_ALWAYS_INLINE uint32_t ts_str_hash_fast(tsv s){
  if (ts_is_short_str(s)){
    uint32_t len = ts_short_str_len(s), h = 2166136261u;
    for (uint32_t i = 0; i < len; i++) h = (h ^ ts_short_str_byte(s, i)) * 637696617u;
    return h;
  }
  const ts_string* x = ts_str_ptr_typed(s);
  if (TS_RT_LIKELY(x->flags & TS_STR_FLAG_HASHED)) return x->hash;
  return ts_str_hash_cached(s);
}
/* A reference key's hash: the cell's address (cells never move), the high
   half of the product mixing every address bit into the index bits; the same
   value the runtime's sv0_hash gives a heap reference. */
TS_RT_ALWAYS_INLINE uint32_t ts_ref_hash(tsv k){
  uint64_t x = ((k & TS_PAYLOAD_MASK) >> 4) * 0x9E3779B97F4A7C15ull;
  return (uint32_t)(x >> 32);
}
/* The candidate whose hash bits match but whose bits differ: SameValueZero,
   with flat strings by memcmp (ts_rt.c). */
int ts_mapset_key_eq_slow(tsv key, tsv k);
/* The probe of an indexed collection's slot table for a key hashed to h, the
   shared loop of the typed probes below: *out = the dense index or -1. The
   receiver's index and keys are the caller's (a Map's or a Set's). */
TS_RT_ALWAYS_INLINE void ts_mapset_probe_inline(const uint32_t* index, uint32_t index_cap, const tsv* keys, tsv k, uint32_t h, int identity_only, long* out){
  uint32_t mask = index_cap - 1u, slot = h & mask;
  for (;;){
    uint32_t w = index[slot];
    if (w == 0u){ *out = -1; return; }
    if (w != 1u && ((w ^ h) & ~mask) == 0u){
      uint32_t di = (w & mask) - 2u;
      tsv key = keys[di];
      if (key == k || (!identity_only && ts_mapset_key_eq_slow(key, k))){ *out = (long)di; return; }
    }
    slot = (slot + 1u) & mask;
  }
}
/* Map.get / Map.has with a key the program types as a string: the indexed
   map's probe in line with the string hash; a receiver that is not a Map, a
   map still in linear mode or a WeakMap, or a key that is not a string after
   all, takes the general entry. */
TS_RT_ALWAYS_INLINE int ts_map_probe_str(tsv mv, tsv k, long* out){
  if (TS_RT_UNLIKELY(!ts_is_obj(mv))) return 0;
  ts_map* m = (ts_map*)ts_ptr(mv);
  if (TS_RT_UNLIKELY(m->o.h.kind != TS_KIND_MAP || m->weak || !m->index)) return 0;
  if (TS_RT_UNLIKELY(!ts_is_str(k))) return 0;
  ts_mapset_probe_inline(m->index, m->index_cap, m->keys, k, ts_str_hash_fast(k), 0, out);
  return 1;
}
/* The same with a key the program types as an object, array or function: an
   identity probe (SameValueZero on references is identity). A key that is not
   a heap reference (null, undefined, a primitive behind the type) takes the
   general entry. */
TS_RT_ALWAYS_INLINE int ts_map_probe_ref(tsv mv, tsv k, long* out){
  if (TS_RT_UNLIKELY(!ts_is_obj(mv))) return 0;
  ts_map* m = (ts_map*)ts_ptr(mv);
  if (TS_RT_UNLIKELY(m->o.h.kind != TS_KIND_MAP || m->weak || !m->index)) return 0;
  if (TS_RT_UNLIKELY(!(ts_is_obj(k) || ts_is_func(k)))) return 0;
  ts_mapset_probe_inline(m->index, m->index_cap, m->keys, k, ts_ref_hash(k), 1, out);
  return 1;
}
TS_RT_ALWAYS_INLINE tsv ts_map_get_str(tsv mv, tsv k){
  long i;
  if (TS_RT_LIKELY(ts_map_probe_str(mv, k, &i))) return i >= 0 ? ((ts_map*)ts_ptr(mv))->vals[i] : TS_UNDEFINED;
  return ts_map_get(mv, k);
}
TS_RT_ALWAYS_INLINE int ts_map_has_str(tsv mv, tsv k){
  long i;
  if (TS_RT_LIKELY(ts_map_probe_str(mv, k, &i))) return i >= 0;
  return ts_map_has(mv, k);
}
TS_RT_ALWAYS_INLINE tsv ts_map_get_ref(tsv mv, tsv k){
  long i;
  if (TS_RT_LIKELY(ts_map_probe_ref(mv, k, &i))) return i >= 0 ? ((ts_map*)ts_ptr(mv))->vals[i] : TS_UNDEFINED;
  return ts_map_get(mv, k);
}
TS_RT_ALWAYS_INLINE int ts_map_has_ref(tsv mv, tsv k){
  long i;
  if (TS_RT_LIKELY(ts_map_probe_ref(mv, k, &i))) return i >= 0;
  return ts_map_has(mv, k);
}
/* Set.has with a key the program types as a string or as a reference: the
   indexed set's probe in line, as for Maps. */
TS_RT_ALWAYS_INLINE int ts_set_probe_str(tsv sv, tsv k, long* out){
  if (TS_RT_UNLIKELY(!ts_is_obj(sv))) return 0;
  ts_set_t* s = (ts_set_t*)ts_ptr(sv);
  if (TS_RT_UNLIKELY(s->o.h.kind != TS_KIND_SET || s->weak || !s->index)) return 0;
  if (TS_RT_UNLIKELY(!ts_is_str(k))) return 0;
  ts_mapset_probe_inline(s->index, s->index_cap, s->elems, k, ts_str_hash_fast(k), 0, out);
  return 1;
}
TS_RT_ALWAYS_INLINE int ts_set_probe_ref(tsv sv, tsv k, long* out){
  if (TS_RT_UNLIKELY(!ts_is_obj(sv))) return 0;
  ts_set_t* s = (ts_set_t*)ts_ptr(sv);
  if (TS_RT_UNLIKELY(s->o.h.kind != TS_KIND_SET || s->weak || !s->index)) return 0;
  if (TS_RT_UNLIKELY(!(ts_is_obj(k) || ts_is_func(k)))) return 0;
  ts_mapset_probe_inline(s->index, s->index_cap, s->elems, k, ts_ref_hash(k), 1, out);
  return 1;
}
TS_RT_ALWAYS_INLINE int ts_set_has_str(tsv sv, tsv k){
  long i;
  if (TS_RT_LIKELY(ts_set_probe_str(sv, k, &i))) return i >= 0;
  return ts_set_has(sv, k);
}
TS_RT_ALWAYS_INLINE int ts_set_has_ref(tsv sv, tsv k){
  long i;
  if (TS_RT_LIKELY(ts_set_probe_ref(sv, k, &i))) return i >= 0;
  return ts_set_has(sv, k);
}
TS_RT_ALWAYS_INLINE int ts_map_probe_num(tsv mv, double d, long* out){
  if (TS_RT_UNLIKELY(!ts_is_obj(mv))) return 0;
  ts_map* m = (ts_map*)ts_ptr(mv);
  if (TS_RT_UNLIKELY(m->o.h.kind != TS_KIND_MAP || m->weak)) return 0;
  if (m->direct){
    /* a map of small integer keys (node and symbol ids): the key's own value
       indexes it, and any other number is absent (docs/map_direct_index_design.md) */
    if (d >= 0.0 && d < 4294967296.0){
      uint32_t u = (uint32_t)d;
      if ((double)u == d && u < m->direct_cap){ uint32_t di = m->direct[u]; *out = di ? (long)(di - 1u) : -1; return 1; }
    }
    *out = -1; return 1;
  }
  if (TS_RT_UNLIKELY(!m->index)) return 0;
  tsv k = ts_num(d == 0 ? 0.0 : d);
  uint32_t h = sv0_hash_num_d(d);
  uint32_t mask = m->index_cap - 1u, slot = h & mask;
  for (;;){
    uint32_t w = m->index[slot];
    if (w == 0u){ *out = -1; return 1; }
    if (w != 1u && ((w ^ h) & ~mask) == 0u){
      uint32_t di = (w & mask) - 2u;
      if (m->keys[di] == k){ *out = (long)di; return 1; }
      return 0;
    }
    slot = (slot + 1u) & mask;
  }
}
TS_RT_ALWAYS_INLINE tsv ts_map_get_num(tsv mv, double d){
  long i;
  if (TS_RT_LIKELY(ts_map_probe_num(mv, d, &i))) return i >= 0 ? ((ts_map*)ts_ptr(mv))->vals[i] : TS_UNDEFINED;
  return ts_map_get(mv, ts_num(d));
}
TS_RT_ALWAYS_INLINE int ts_map_has_num(tsv mv, double d){
  long i;
  if (TS_RT_LIKELY(ts_map_probe_num(mv, d, &i))) return i >= 0;
  return ts_map_has(mv, ts_num(d));
}
TS_RT_ALWAYS_INLINE int ts_ta_try_length(tsv v, tsv* out){
  if (!ts_is_obj(v)) return 0;
  ts_typedarray* t = (ts_typedarray*)ts_ptr(v);
  if (t->o.h.kind != TS_KIND_TYPEDARRAY || obj_map_plain(&t->o)->len != 0) return 0;
  *out = ts_num((double)t->length);
  return 1;
}
/* Element read: the array path allocates nothing; a string receiver builds a
   one-character view, so it runs with the frame linked. */
TS_RT_ALWAYS_INLINE tsv ts_array_get_lazy(tsv arr, int64_t i, ts_frame_hdr* frame, uint32_t nslots){
  if (ts_is_indexed_array_fast(arr) && (uint64_t)i < TS_ARRAY_INDEX_LIMIT) return ts_array_get(arr, (uint32_t)i);
  ts_frame_push(frame, nslots);
  tsv r = ts_array_get_key_i64(arr, i);
  ts_frame_pop(frame);
  return r;
}
static inline tsv ts_array_get_lazy_f64(tsv arr, double d, ts_frame_hdr* frame, uint32_t nslots){
  uint32_t i;
  if (ts_num_array_index(d, &i) && ts_is_indexed_array_fast(arr)) return ts_array_get(arr, i);
  ts_frame_push(frame, nslots);
  tsv r = ts_array_get_key_f64(arr, d);
  ts_frame_pop(frame);
  return r;
}
/* Lazy frames with register homes (docs/lazy_frames_design.md, round 2): the
   fast path of each lazily linked slow path as a test that touches no frame,
   and the slow path as the linked call, out of line (ts_rt.c) so the caller
   needs neither the frame-top address nor a callee-saved register on its
   fast path and can stay a leaf there. The emitter keeps a lazy
   function's reference locals in C locals and fills the frame from them only
   before the linked call, reloading them after. */
TS_RT_ALWAYS_INLINE int ts_get_static_try(tsv obj, ts_key key, uint32_t slot, ts_prop_ic* ic, tsv* out){
  tsv* p = ts_static_slot_probe(obj, key, slot, TS_PROP_ACCESSOR, 0, ic);
  if (p){ TS_RT_STAT_STATIC(get_hit); *out = *p; return 1; }
  TS_RT_STAT_STATIC(get_miss); TS_RT_STAT_STATIC_MISS_KEY(g_ts_key_static_get_miss, key); TS_RT_STAT_STATIC_MISS_SLOT(obj, key);
  return 0;
}
TS_RT_ALWAYS_INLINE int ts_get_static2_try(tsv obj, ts_key key, uint32_t s1, uint32_t s2, ts_prop_ic* ic, tsv* out){
  tsv* p = ts_static_slot_probe2(obj, key, s1, s2, TS_PROP_ACCESSOR, 0, ic);
  if (p){ TS_RT_STAT_STATIC(get_hit); *out = *p; return 1; }
  TS_RT_STAT_STATIC(get_miss); TS_RT_STAT_STATIC_MISS_KEY(g_ts_key_static_get_miss, key); TS_RT_STAT_STATIC_MISS_SLOT(obj, key);
  return 0;
}
TS_RT_ALWAYS_INLINE int ts_get_static3_try(tsv obj, ts_key key, uint32_t s1, uint32_t s2, uint32_t s3, ts_prop_ic* ic, tsv* out){
  tsv* p = ts_static_slot_probe3(obj, key, s1, s2, s3, TS_PROP_ACCESSOR, 0, ic);
  if (p){ TS_RT_STAT_STATIC(get_hit); *out = *p; return 1; }
  TS_RT_STAT_STATIC(get_miss); TS_RT_STAT_STATIC_MISS_KEY(g_ts_key_static_get_miss, key); TS_RT_STAT_STATIC_MISS_SLOT(obj, key);
  return 0;
}
TS_RT_ALWAYS_INLINE int ts_get_pic_try(tsv obj, ts_key key, ts_prop_ic* ic, tsv* out){
  uint8_t flags = 0;
  tsv* p = ts_prop_ic_probe_fixed_inline(obj, key, ic, &flags);
  if (p && !(flags & TS_PROP_ACCESSOR)){
    TS_RT_STAT_PIC_GET_CALL(); TS_RT_STAT_PIC_GET_HIT(); TS_RT_STAT_INLINE_KEY(g_ts_key_inline_get, key);
    *out = *p; return 1;
  }
  return 0;
}
tsv ts_get_linked(tsv obj, ts_key key, ts_prop_ic* ic, ts_frame_hdr* frame, uint32_t nslots);
TS_RT_ALWAYS_INLINE int ts_set_static_try(tsv obj, ts_key key, uint32_t slot, tsv value, ts_prop_ic* ic){
  tsv* p = ts_static_slot_probe(obj, key, slot, TS_PROP_ACCESSOR | TS_PROP_WRITABLE, TS_PROP_WRITABLE, ic);
  if (p && !(ts_obj_integrity((ts_object*)ts_ptr(obj)) & 1u)){
    TS_RT_STAT_STATIC(set_hit);
    *p = value; ts_write_barrier_ptr(obj, p, value); return 1;
  }
  TS_RT_STAT_STATIC(set_miss); TS_RT_STAT_STATIC_MISS_KEY(g_ts_key_static_set_miss, key);
  return 0;
}
TS_RT_ALWAYS_INLINE int ts_set_static2_try(tsv obj, ts_key key, uint32_t s1, uint32_t s2, tsv value, ts_prop_ic* ic){
  tsv* p = ts_static_slot_probe2(obj, key, s1, s2, TS_PROP_ACCESSOR | TS_PROP_WRITABLE, TS_PROP_WRITABLE, ic);
  if (p && !(ts_obj_integrity((ts_object*)ts_ptr(obj)) & 1u)){
    TS_RT_STAT_STATIC(set_hit);
    *p = value; ts_write_barrier_ptr(obj, p, value); return 1;
  }
  TS_RT_STAT_STATIC(set_miss); TS_RT_STAT_STATIC_MISS_KEY(g_ts_key_static_set_miss, key);
  return 0;
}
TS_RT_ALWAYS_INLINE int ts_set_static3_try(tsv obj, ts_key key, uint32_t s1, uint32_t s2, uint32_t s3, tsv value, ts_prop_ic* ic){
  tsv* p = ts_static_slot_probe3(obj, key, s1, s2, s3, TS_PROP_ACCESSOR | TS_PROP_WRITABLE, TS_PROP_WRITABLE, ic);
  if (p && !(ts_obj_integrity((ts_object*)ts_ptr(obj)) & 1u)){
    TS_RT_STAT_STATIC(set_hit);
    *p = value; ts_write_barrier_ptr(obj, p, value); return 1;
  }
  TS_RT_STAT_STATIC(set_miss); TS_RT_STAT_STATIC_MISS_KEY(g_ts_key_static_set_miss, key);
  return 0;
}
TS_RT_ALWAYS_INLINE int ts_set_pic_try(tsv obj, ts_key key, tsv value, ts_prop_ic* ic){
  uint8_t flags = 0;
  tsv* p = ts_prop_ic_probe_fixed_inline(obj, key, ic, &flags);
  if (p && !(flags & TS_PROP_ACCESSOR) && (flags & TS_PROP_WRITABLE)){
    ts_object* o = (ts_object*)ts_ptr(obj);
    if (!(ts_obj_integrity(o) & 1u)){
      TS_RT_STAT_PIC_SET_CALL(); TS_RT_STAT_PIC_SET_HIT(); TS_RT_STAT_INLINE_KEY(g_ts_key_inline_set, key);
      *p = value; ts_write_barrier_ptr(obj, p, value); return 1;
    }
  }
  return 0;
}
void ts_set_linked(tsv obj, ts_key key, tsv value, ts_prop_ic* ic, ts_frame_hdr* frame, uint32_t nslots);
/* The hole marker of a sparse array element (never a user-visible value). */
#define TS_ARRAY_HOLE TS_BOX(0xFFFEu, 0x4152484Fu)
static inline int array_is_hole(tsv v){ return v == TS_ARRAY_HOLE; }
/* Element read with the array case in line: a dense slot (below cap: every
   slot in [len, cap) is a hole) that is not a hole is the value, any other
   index of a dense array is undefined (ts_array_get agrees); a sparse array
   (cap 0) reads its side table out of line, as do strings and other
   receivers. */
/* Number keys (docs/array_index_keys_design.md): an array index is an
   integer in [0, 2^32 - 1); any other number is a property key (ToString:
   "-1", "1.5", "4294967295"). An integer key arrives as int64: the
   in-capacity test also rejects negative values and values past the last
   index, and past the capacity a dense array answers undefined only for an
   index. A double key is tested for an index first. The key paths take the
   element path for an index and the dynamic property path otherwise. */
static inline tsv ts_array_get_inline(tsv arr, int64_t i){
  if (ts_is_indexed_array_fast(arr)){
    ts_array* a = (ts_array*)ts_ptr(arr);
    if ((uint64_t)i < a->cap){ tsv v = a->data[i]; return array_is_hole(v) ? TS_UNDEFINED : v; }
    if (!a->sparse && (uint64_t)i < TS_ARRAY_INDEX_LIMIT) return TS_UNDEFINED;
  }
  return ts_array_get_key_i64(arr, i);
}
static inline tsv ts_array_get_inline_f64(tsv arr, double d){
  uint32_t i;
  if (TS_RT_LIKELY(ts_num_array_index(d, &i))) return ts_array_get_inline(arr, (int64_t)i);
  return ts_array_get_key_f64(arr, d);
}
/* Element store with the dense in-capacity case in line: a plain array (no
   integrity bit: not frozen, sealed or non-extensible) with i below cap stores the slot, extends the length past holes as
   ts_array_set does, and remembers the array when it is old (the young-value
   test and the cards are out of line). Growth, sparse arrays, frozen arrays
   and other receivers (typed arrays among them) take ts_array_set. */
void ts_array_remember(ts_array* a, uint32_t index, tsv value);
static inline void ts_array_set_inline(tsv arr, int64_t i, tsv v){
  if (ts_is_indexed_array_fast(arr)){
    ts_array* a = (ts_array*)ts_ptr(arr);
    if (TS_RT_LIKELY((uint64_t)i < a->cap && ts_obj_integrity(&a->o) == 0u)){
      uint32_t u = (uint32_t)i;
      a->data[u] = v;
      if (u >= a->len) a->len = u + 1u;
      if (a->o.h.gen == TS_GEN_OLD) ts_array_remember(a, u, v);
      return;
    }
  }
  ts_array_set_key_i64(arr, i, v);
}
/* arr.push(v) with the dense in-capacity case in line: a plain array (not
   frozen) with room stores the slot at len and remembers the array when it is
   old; growth, frozen arrays and other receivers take ts_array_push, which has
   the complete semantics (a typed array or a non-array receiver is ignored
   there as before). */
static inline void ts_array_push_inline(tsv arr, tsv v){
  if (ts_is_indexed_array_fast(arr)){
    ts_array* a = (ts_array*)ts_ptr(arr);
    uint32_t u = a->len;
    if (TS_RT_LIKELY(u < a->cap && ts_obj_integrity(&a->o) == 0u)){
      a->data[u] = v;
      a->len = u + 1u;
      if (a->o.h.gen == TS_GEN_OLD) ts_array_remember(a, u, v);
      return;
    }
  }
  ts_array_push(arr, v);
}
static inline void ts_array_set_inline_f64(tsv arr, double d, tsv v){
  uint32_t i;
  if (TS_RT_LIKELY(ts_num_array_index(d, &i))){ ts_array_set_inline(arr, (int64_t)i, v); return; }
  ts_array_set_key_f64(arr, d, v);
}
/* for..of over a value its type does not classify (docs/array_iterators_design.md):
   ts_forof_open returns an array (walked by index here, in line) or an
   iterator; ts_forof_next returns the next element or TS_ITER_DONE (a marker
   no user value can be: selector 0xFFFE is internal, like the array hole). */
#define TS_ITER_DONE TS_BOX(0xFFFEu, 0x444F4E45u)
/* String accumulators (docs/string_accumulators_design.md): a private buffer
   string a local appends into; each function also accepts an ordinary string. */
tsv ts_sb_new(tsv init);
tsv ts_sb_append(tsv sb, tsv e);
tsv ts_sb_append_range(tsv sb, tsv s, uint32_t start, uint32_t end);
double ts_sb_len(tsv sb);
tsv ts_sb_finish(tsv sb);
tsv ts_forof_open(tsv v);
tsv ts_forof_next_slow(tsv it, ts_key next_key);
static inline tsv ts_forof_next(tsv it, double idx, ts_key next_key){
  if (ts_is_indexed_array_fast(it)){
    uint32_t i = (uint32_t)idx;
    if (i >= ((ts_array*)ts_ptr(it))->len) return TS_ITER_DONE;
    return ts_array_get_inline(it, i);
  }
  return ts_forof_next_slow(it, next_key);
}
static inline int ts_array_get_inline_try(tsv arr, int64_t i, tsv* out){
  if (ts_is_indexed_array_fast(arr)){
    ts_array* a = (ts_array*)ts_ptr(arr);
    if ((uint64_t)i < a->cap){ tsv v = a->data[i]; *out = array_is_hole(v) ? TS_UNDEFINED : v; return 1; }
    if (!a->sparse && (uint64_t)i < TS_ARRAY_INDEX_LIMIT){ *out = TS_UNDEFINED; return 1; }
  }
  return 0;
}
static inline int ts_array_get_try(tsv arr, int64_t i, tsv* out){
  if (ts_is_indexed_array_fast(arr) && (uint64_t)i < TS_ARRAY_INDEX_LIMIT){ *out = ts_array_get(arr, (uint32_t)i); return 1; }
  return 0;
}
static inline int ts_array_get_inline_try_f64(tsv arr, double d, tsv* out){
  uint32_t i;
  return ts_num_array_index(d, &i) && ts_array_get_inline_try(arr, (int64_t)i, out);
}
static inline int ts_array_get_try_f64(tsv arr, double d, tsv* out){
  uint32_t i;
  return ts_num_array_index(d, &i) && ts_array_get_try(arr, (int64_t)i, out);
}
tsv ts_array_get_linked(tsv arr, int64_t i, ts_frame_hdr* frame, uint32_t nslots);
tsv ts_array_get_linked_f64(tsv arr, double d, ts_frame_hdr* frame, uint32_t nslots);
static inline tsv ts_array_get_inline_lazy(tsv arr, int64_t i, ts_frame_hdr* frame, uint32_t nslots){
  if (ts_is_indexed_array_fast(arr)){
    ts_array* a = (ts_array*)ts_ptr(arr);
    if ((uint64_t)i < a->cap){ tsv v = a->data[i]; return array_is_hole(v) ? TS_UNDEFINED : v; }
    if (!a->sparse && (uint64_t)i < TS_ARRAY_INDEX_LIMIT) return TS_UNDEFINED;
  }
  ts_frame_push(frame, nslots);
  tsv r = ts_array_get_key_i64(arr, i);
  ts_frame_pop(frame);
  return r;
}
static inline tsv ts_array_get_inline_lazy_f64(tsv arr, double d, ts_frame_hdr* frame, uint32_t nslots){
  uint32_t i;
  if (TS_RT_LIKELY(ts_num_array_index(d, &i))) return ts_array_get_inline_lazy(arr, (int64_t)i, frame, nslots);
  ts_frame_push(frame, nslots);
  tsv r = ts_array_get_key_f64(arr, d);
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
#ifdef TSAOT_STACK_CHECK
  uint64_t sc_act; /* the activation that pushed it (docs/stack_check_design.md) */
#endif
} ts_handler;
#ifdef TSAOT_STACK_CHECK
/* Stack check: Stack objects in a quarantine, dead after their activation. */
typedef struct { uint64_t id, prev; } ts_sc_act;
ts_sc_act ts_sc_enter(void);
void ts_sc_leave(ts_sc_act* a);
void* ts_sc_alloc(size_t size, uint32_t site, const char* fn);
void* ts_sc_alloc_raw(size_t size, uint32_t site, const char* fn);
unsigned long long ts_sc_report_count(void);
#define TS_SC_ACTIVATION ts_sc_act _sc_act __attribute__((cleanup(ts_sc_leave))) = ts_sc_enter(); (void)_sc_act
#endif
int         ts_gc_root_depth(void);
void        ts_gc_set_root_depth(int n);
ts_handler* ts_eh_push(void);
void        ts_eh_push_coro(void* extbuf);
void        ts_eh_pop(void);
void        ts_throw(tsv v);
void        ts_throw_range_error_msg(const char* msg);
void        ts_throw_type_error_msg(const char* msg);
tsv         ts_callback_with_this(tsv cb, tsv thisArg); /* arr.forEach(fn, ctx): fn bound to ctx */
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
  int nvals;                 /* tsv locals leading the frame, scanned precisely;
                                -1 = scan the frame conservatively (ts_coro_alloc_v) */
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
/* The frame's first nvals words after the header are its tsv locals, and the
   rest holds no reference (docs/gc_v2_design.md §6.5 step 2b). */
tsv         ts_coro_alloc_vn(size_t size, tsv (*resume)(tsv), uint32_t nvals);
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
