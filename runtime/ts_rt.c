#include <limits.h>
#include <unistd.h>   /* isatty: gate console.log colorization on a TTY (Node parity) */
#include "ts_rt.h"
#include "json_core.c"

#if defined(TSAOT_ENABLE_FETCH)
#include <curl/curl.h>
#endif

#if defined(__has_feature)
#if __has_feature(address_sanitizer)
extern void __asan_unpoison_memory_region(const void *addr, size_t size);
extern int __asan_address_is_poisoned(const void *addr);
#define TS_ASAN_ENABLED 1
#endif
#endif
#if !defined(TS_ASAN_ENABLED) && defined(__SANITIZE_ADDRESS__)
extern void __asan_unpoison_memory_region(const void *addr, size_t size);
extern int __asan_address_is_poisoned(const void *addr);
#define TS_ASAN_ENABLED 1
#endif

/* ---------------- GC heap ---------------- */
static ts_gc_header* g_young_heap = NULL;
static ts_gc_header* g_old_heap = NULL;
static size_t g_alloc=0, g_young_alloc=0, g_old_alloc=0;
static size_t g_young_threshold=65536;
/* Full-GC trigger is LIVE CELL BYTES (gc_moving_plan B-3), not cell count: a
   count misjudges pressure for variable-sized cells (one 500MB inline string
   is 1 count). g_heap_bytes tracks cell bodies exactly — alloc adds sz, every
   free subtracts h->size, an evacuation is byte-neutral. External payload
   arrays (props/env/data) are not counted (cell-body granularity). */
static size_t g_heap_bytes = 0;
static size_t g_full_threshold_bytes = (size_t)16u * 1024u * 1024u;
static int g_full_threshold_forced = 0; /* env override pins the trigger (stress knob) */
/* TSAOT_GC_ZAP=1 fills dead and moved-from cell bodies with 0xDD during
   collection (Phase C0 groundwork): a stale raw pointer held across a
   safepoint then reads loud garbage (kind 0xDD fails gc_kind_valid, tsv
   payloads are poison) instead of silently working because the old body
   still holds a bit-copy. ASan-independent — the CLT 17.0.0 ASan runtime
   deadlocks at startup on this host, so this is the always-available
   use-after-move detector. GC cold paths only; zero mutator cost. */
static int g_gc_zap = 0;

/* ---- bump nursery (gc_moving_plan Phase B) ----
   Young movable cells live in 256KB-aligned arena chunks: allocation is a bump
   (pointer add + memset), death is free-of-payload only, and the whole arena
   resets after each minor GC ("arena cells leave by copy or die" — they are
   never promoted in place because the cell memory belongs to the chunk).
   Large cells (>= 4KB inline strings etc.), Promise/Coro/Proxy and everything
   under TSAOT_GC_NURSERY=0 stay on the classic calloc young list (unpooled).
   The chunk alignment gives O(1) cell→chunk lookup by mask, which the pinned
   path below and Phase C's pointer rewrites rely on.
   Pinned defense: a pinned arena cell (e.g. ts_json_parse pins the source
   string's storage across an allocating parse) can neither move nor be
   promoted in place. Its chunk is RETAINED (kept out of the reset pool) and
   the cell is tracked on g_pinned_young; the next collection that sees it
   unpinned evacuates it and, once a retained chunk holds no pinned survivors,
   the chunk returns to the free pool. */
#define GC_NURSERY_CHUNK_BYTES ((size_t)(256u * 1024u))
#define GC_NURSERY_MAX_CELL    ((size_t)4096u)
typedef struct gc_chunk {
  struct gc_chunk* next;
  size_t used;          /* bump offset from data start */
  uint32_t pinned_live; /* pinned survivors still resident (retained chunks) */
} gc_chunk;
#define GC_NURSERY_DATA_OFF  ((sizeof(gc_chunk) + 15u) & ~(size_t)15u)
#define GC_NURSERY_DATA_BYTES (GC_NURSERY_CHUNK_BYTES - GC_NURSERY_DATA_OFF)
static gc_chunk* g_nursery_active = NULL;   /* chunks bumped this cycle; head is current */
static gc_chunk* g_nursery_free = NULL;     /* empty chunks kept for reuse */
static gc_chunk* g_nursery_retained = NULL; /* chunks held in place by pinned survivors */
static ts_gc_header* g_pinned_young = NULL; /* pinned arena survivors (gc_next reused) */
static size_t g_nursery_used_bytes = 0;     /* bump total this cycle (minor-GC trigger) */
static size_t g_nursery_cap_bytes = (size_t)4u * 1024u * 1024u; /* TSAOT_GC_NURSERY_BYTES */
static int g_nursery_enabled = 1;           /* TSAOT_GC_NURSERY=0 kill switch */
static tsv** g_roots=NULL; static int g_root_len=0, g_root_cap=0;
static ts_gc_header** g_remset=NULL; static size_t g_rem_len=0, g_rem_cap=0;
ts_gc_header** g_ts_handle_table = NULL;
static uint32_t g_handle_len = 0, g_handle_cap = 0;
static uint32_t* g_handle_free = NULL;
static uint32_t g_handle_free_len = 0, g_handle_free_cap = 0;

/* ---------------- runtime stats (compile-time opt-in) ----------------
   Build with -DTSAOT_RT_STATS to compile in lightweight counters; a summary is
   printed to stderr at process exit (TSAOT_RT_STATS_FILE=path appends there
   instead). Default builds compile every macro to ((void)0) — zero hot-path
   cost, identical codegen. Perf 判断の事実基盤 (refactor plan P0)。 */
#ifdef TSAOT_RT_STATS
#include <time.h>
static struct {
  unsigned long long minor_gc, full_gc, gc_pause_ns, gc_pause_max_ns;
  unsigned long long mark_stack_peak;
  unsigned long long alloc_count, alloc_bytes, handle_alloc, root_push;
  unsigned long long nursery_alloc, nursery_chunks, retained_chunks;
  unsigned long long call_env_malloc;
  unsigned long long concat_calls, concat_bytes;
  unsigned long long intern_calls, intern_probes;
  unsigned long long map_find_calls, map_find_probes, map_find_hist[9];
  unsigned long long find_prop_calls, find_prop_probes, find_prop_hist[9];
} g_rt_stats;
static uint64_t rt_stats_now_ns(void){
  struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint64_t)t.tv_sec*1000000000ull + (uint64_t)t.tv_nsec;
}
/* probe-count histogram bucket: 1,2,4,8,…,128,256+ (9 buckets) */
static inline unsigned rt_stats_bucket(unsigned long long n){
  unsigned b = 0; while (n > 1 && b < 8){ n >>= 1; b++; } return b;
}
static void rt_stats_hist_line(FILE* out, const char* name,
                               unsigned long long calls, unsigned long long probes,
                               const unsigned long long h[9]){
  fprintf(out, "[rt_stats] %s: calls=%llu avg_probe=%.2f hist(1,2,4,…,256+)=[", name,
          calls, calls ? (double)probes/(double)calls : 0.0);
  for (int i=0;i<9;i++) fprintf(out, "%s%llu", i?",":"", h[i]);
  fprintf(out, "]\n");
}
__attribute__((destructor)) static void ts_rt_stats_dump(void){
  FILE* out = stderr;
  const char* path = getenv("TSAOT_RT_STATS_FILE");
  if (path && path[0]){ FILE* f = fopen(path, "a"); if (f) out = f; }
  {
    unsigned long long ngc = g_rt_stats.minor_gc + g_rt_stats.full_gc;
    fprintf(out, "[rt_stats] gc: minor=%llu full=%llu pause_ms=%.2f max_pause_ms=%.3f avg_pause_ms=%.3f mark_peak=%llu\n",
            g_rt_stats.minor_gc, g_rt_stats.full_gc, (double)g_rt_stats.gc_pause_ns/1e6,
            (double)g_rt_stats.gc_pause_max_ns/1e6,
            ngc ? (double)g_rt_stats.gc_pause_ns/1e6/(double)ngc : 0.0,
            g_rt_stats.mark_stack_peak);
  }
  fprintf(out, "[rt_stats] alloc: count=%llu bytes=%llu handle_alloc=%llu handle_cap=%u root_push=%llu\n",
          g_rt_stats.alloc_count, g_rt_stats.alloc_bytes, g_rt_stats.handle_alloc,
          g_handle_cap, g_rt_stats.root_push);
  fprintf(out, "[rt_stats] nursery: alloc=%llu chunks=%llu retained=%llu | live_bytes=%zu full_next=%zu\n",
          g_rt_stats.nursery_alloc, g_rt_stats.nursery_chunks, g_rt_stats.retained_chunks,
          g_heap_bytes, g_full_threshold_bytes);
  fprintf(out, "[rt_stats] ts_call env_malloc=%llu | concat: calls=%llu bytes=%llu\n",
          g_rt_stats.call_env_malloc, g_rt_stats.concat_calls, g_rt_stats.concat_bytes);
  rt_stats_hist_line(out, "map_find", g_rt_stats.map_find_calls, g_rt_stats.map_find_probes, g_rt_stats.map_find_hist);
  rt_stats_hist_line(out, "find_prop", g_rt_stats.find_prop_calls, g_rt_stats.find_prop_probes, g_rt_stats.find_prop_hist);
  fprintf(out, "[rt_stats] intern: calls=%llu avg_probe=%.2f\n",
          g_rt_stats.intern_calls,
          g_rt_stats.intern_calls ? (double)g_rt_stats.intern_probes/(double)g_rt_stats.intern_calls : 0.0);
  if (out != stderr) fclose(out);
}
#define RT_STAT_INC(f)     (g_rt_stats.f++)
#define RT_STAT_ADD(f,n)   (g_rt_stats.f += (unsigned long long)(n))
#define RT_STAT_HIST(f,n)  (g_rt_stats.f[rt_stats_bucket((unsigned long long)(n))]++)
#define RT_STAT_GC_T0      uint64_t rt_stats_t0_ = rt_stats_now_ns()
#define RT_STAT_GC_T1      do { uint64_t rt_d_ = rt_stats_now_ns() - rt_stats_t0_; \
                             g_rt_stats.gc_pause_ns += rt_d_; \
                             if (rt_d_ > g_rt_stats.gc_pause_max_ns) g_rt_stats.gc_pause_max_ns = rt_d_; } while (0)
#else
#define RT_STAT_INC(f)     ((void)0)
#define RT_STAT_ADD(f,n)   ((void)0)
#define RT_STAT_HIST(f,n)  ((void)0)
#define RT_STAT_GC_T0      ((void)0)
#define RT_STAT_GC_T1      ((void)0)
#endif

/* The collector uses a mark/sweep full GC and a generational minor GC. Minor GC
   relocates movable young survivors through stable handles; full GC remains
   mark/sweep. Keep fixed minimum byte headroom for ephemeral churn, and after
   each full collection retarget the next trigger from the live byte size. */
#define TS_GC_MIN_FULL_BYTES ((size_t)4u * 1024u * 1024u)

static inline int ts_heap_ref(tsv v){ return ts_is_obj(v)||ts_is_func(v)||ts_is_str(v); }
static inline int gc_kind_valid(uint8_t k){
  return k >= TS_KIND_OBJECT && k <= TS_KIND_SYMBOL;
}
static inline int gc_direct_stack_plausible(ts_gc_header* h){
  uintptr_t p = (uintptr_t)h;
  uintptr_t here = (uintptr_t)&p;
  uintptr_t diff = p > here ? p - here : here - p;
  return diff < (128u * 1024u * 1024u);
}
static inline int gc_direct_header_readable(ts_gc_header* h){
#if defined(TS_ASAN_ENABLED)
  const char* p = (const char*)h;
  for (size_t i=0;i<sizeof(ts_gc_header);i++){
    if (__asan_address_is_poisoned(p + i)) return 0;
  }
#else
  (void)h;
#endif
  return 1;
}
static inline ts_gc_header* ts_heap_ptr(tsv v){
  uint64_t payload = v & TS_PAYLOAD_MASK;
  if (payload & 1u){
    uint32_t id = (uint32_t)(payload >> 1);
    return (id < g_handle_cap) ? g_ts_handle_table[id] : NULL;
  }
  if ((payload & (sizeof(void*) - 1u)) != 0) return NULL;
  ts_gc_header* h = (ts_gc_header*)(uintptr_t)payload;
  if (!gc_direct_stack_plausible(h) || !gc_direct_header_readable(h)) return NULL;
  return (h->gen == TS_GEN_NONHEAP && gc_kind_valid(h->kind)) ? h : NULL;
}
static inline int gc_is_young(ts_gc_header* h){ return h && h->gen == TS_GEN_YOUNG; }
static inline void gc_pin_value(tsv v){
  if (!ts_heap_ref(v)) return;
  ts_gc_header* h = ts_heap_ptr(v);
  if (h && (h->gen == TS_GEN_YOUNG || h->gen == TS_GEN_OLD)) h->pin_depth++;
}
static inline void gc_unpin_value(tsv v){
  if (!ts_heap_ref(v)) return;
  ts_gc_header* h = ts_heap_ptr(v);
  if (h && (h->gen == TS_GEN_YOUNG || h->gen == TS_GEN_OLD) && h->pin_depth) h->pin_depth--;
}
static void gc_pin_string_storage(tsv v){
  while (ts_is_str(v)){
    gc_pin_value(v);
    ts_string* s = ts_str_ptr_typed(v);
    if (!(s->flags & TS_STR_FLAG_VIEW)) return;
    v = s->parent;
  }
}
static void gc_unpin_string_storage(tsv v){
  while (ts_is_str(v)){
    gc_unpin_value(v);
    ts_string* s = ts_str_ptr_typed(v);
    if (!(s->flags & TS_STR_FLAG_VIEW)) return;
    v = s->parent;
  }
}
static tsv ts_string_slice_copy(tsv src, uint32_t start, uint32_t len);
static tsv ts_string_slice_view(tsv src, uint32_t start, uint32_t len);
static char* ts_string_cstr_copy(tsv src, uint32_t* out_len);
static char* ts_string_key_bytes_copy(tsv src, uint32_t* out_len);
static int ts_string_own_prop(tsv obj, ts_key key, tsv* out);
static int field_name_is(uint32_t id, const char* lit);
static int field_bytes_is(const char* n, uint32_t len, const char* lit);
static int prop_key_is_array_index(uint32_t key, uint32_t* idx);
static int gc_moving_minor_enabled(void);
static void gc_config_init(void){
  static int inited = 0;
  if (inited) return;
  inited = 1;
  const char* young = getenv("TSAOT_GC_YOUNG_THRESHOLD");
  if (young && young[0]){
    char* end = NULL;
    unsigned long long v = strtoull(young, &end, 10);
    if (end != young) g_young_threshold = (size_t)(v ? v : 1);
  }
  /* Bump-nursery config. TSAOT_GC_NURSERY=0 falls back to the classic
     all-unpooled allocator (one milestone-period kill switch). The nursery
     requires the moving minor: with TSAOT_DISABLE_MOVING_MINOR set, arena
     survivors could neither move nor be promoted in place, so the nursery
     turns itself off. */
  const char* nursery = getenv("TSAOT_GC_NURSERY");
  if (nursery && nursery[0] && strcmp(nursery, "0") == 0) g_nursery_enabled = 0;
  if (!gc_moving_minor_enabled()) g_nursery_enabled = 0;
  const char* nbytes = getenv("TSAOT_GC_NURSERY_BYTES");
  if (nbytes && nbytes[0]){
    char* end = NULL;
    unsigned long long v = strtoull(nbytes, &end, 10);
    if (end != nbytes && v) g_nursery_cap_bytes = (size_t)v;
    if (g_nursery_cap_bytes < GC_NURSERY_CHUNK_BYTES) g_nursery_cap_bytes = GC_NURSERY_CHUNK_BYTES;
  }
  /* Full-GC byte threshold override (B-3). Mainly a stress/tuning knob: a tiny
     value forces frequent full collections the way TSAOT_GC_YOUNG_THRESHOLD=1
     forces minors. The retarget rule still applies after each full GC. */
  const char* fbytes = getenv("TSAOT_GC_FULL_THRESHOLD_BYTES");
  if (fbytes && fbytes[0]){
    char* end = NULL;
    unsigned long long v = strtoull(fbytes, &end, 10);
    if (end != fbytes && v){ g_full_threshold_bytes = (size_t)v; g_full_threshold_forced = 1; }
  }
  const char* zap = getenv("TSAOT_GC_ZAP");
  if (zap && zap[0] && strcmp(zap, "0") != 0) g_gc_zap = 1;
}
static uint64_t gc_handle_alloc(ts_gc_header* h){
  uint32_t id;
  RT_STAT_INC(handle_alloc);
  if (g_handle_free_len){
    id = g_handle_free[--g_handle_free_len];
  } else {
    id = ++g_handle_len;
    if (id >= g_handle_cap){
      uint32_t next = g_handle_cap ? g_handle_cap * 2 : 65536;
      while (id >= next) next *= 2;
      g_ts_handle_table = (ts_gc_header**)realloc(g_ts_handle_table, sizeof(ts_gc_header*) * next);
      memset(g_ts_handle_table + g_handle_cap, 0, sizeof(ts_gc_header*) * (next - g_handle_cap));
      g_handle_cap = next;
    }
  }
  g_ts_handle_table[id] = h;
  return (((uint64_t)id) << 1) | 1u;
}
static void gc_handle_free(ts_gc_header* h){
  uint64_t payload = h ? h->handle : 0;
  if (!(payload & 1u)) return;
  uint32_t id = (uint32_t)(payload >> 1);
  if (id < g_handle_cap && g_ts_handle_table[id] == h){
    g_ts_handle_table[id] = NULL;
    if (g_handle_free_len == g_handle_free_cap){
      g_handle_free_cap = g_handle_free_cap ? g_handle_free_cap * 2 : 1024;
      g_handle_free = (uint32_t*)realloc(g_handle_free, sizeof(uint32_t) * g_handle_free_cap);
    }
    g_handle_free[g_handle_free_len++] = id;
  }
  h->handle = 0;
}
tsv ts_heap_ref_value(uint16_t sel, void* p){
  if (!p) return TS_BOX(sel, 0);
  ts_gc_header* h = (ts_gc_header*)p;
  if (h->gen == TS_GEN_NONHEAP) return TS_BOX(sel, (uintptr_t)p);
  if (!h->handle) h->handle = gc_handle_alloc(h);
  return TS_BOX(sel, h->handle);
}
void ts_gc_remember(ts_gc_header* h){
  if (!h || h->gen != TS_GEN_OLD || h->remembered) return;
  if (g_rem_len == g_rem_cap){
    g_rem_cap = g_rem_cap ? g_rem_cap * 2 : 1024;
    g_remset = (ts_gc_header**)realloc(g_remset, sizeof(ts_gc_header*) * g_rem_cap);
  }
  h->remembered = 1;
  g_remset[g_rem_len++] = h;
}

void ts_gc_root(tsv* slot){
  RT_STAT_INC(root_push);
  if (g_root_len==g_root_cap){ g_root_cap=g_root_cap?g_root_cap*2:64; g_roots=realloc(g_roots,sizeof(tsv*)*g_root_cap);}
#if defined(TS_ASAN_ENABLED)
  __asan_unpoison_memory_region(slot, sizeof(*slot));
#endif
  g_roots[g_root_len++]=slot;
}
void ts_gc_unroot(int n){
  int target = g_root_len - n;
  if (target < 0) target = 0;
  while (g_root_len > target) g_roots[--g_root_len] = NULL;
}
int  ts_gc_root_depth(void){ return g_root_len; }
void ts_gc_set_root_depth(int n){
  if (n < 0) n = 0;
  if (n >= g_root_len) return;
  while (g_root_len > n) g_roots[--g_root_len] = NULL;
}

/* Nursery-eligible kinds: the unconditionally movable base kinds. Promise/Coro
   (conditionally movable, resume pins raw frames) and Proxy (non-moving) stay
   unpooled; large cells stay unpooled so a dying 500MB inline string is freed
   at the next minor instead of squatting in a chunk. */
static inline int gc_is_bump_kind(uint8_t kind){
  return kind==TS_KIND_OBJECT || kind==TS_KIND_STRING || kind==TS_KIND_FUNC ||
         kind==TS_KIND_ARRAY || kind==TS_KIND_MAP || kind==TS_KIND_SET ||
         kind==TS_KIND_ACCESSOR || kind==TS_KIND_SYMBOL;
}
static void* gc_nursery_bump(size_t sz){
  size_t need = (sz + 15u) & ~(size_t)15u;
  gc_chunk* c = g_nursery_active;
  if (!c || c->used + need > GC_NURSERY_DATA_BYTES){
    if (g_nursery_free){
      c = g_nursery_free; g_nursery_free = c->next;
    } else {
      void* mem = NULL;
      if (posix_memalign(&mem, GC_NURSERY_CHUNK_BYTES, GC_NURSERY_CHUNK_BYTES) != 0)
        return NULL; /* fall back to the unpooled path */
      c = (gc_chunk*)mem;
      RT_STAT_INC(nursery_chunks);
    }
    c->used = 0; c->pinned_live = 0;
    c->next = g_nursery_active; g_nursery_active = c;
  }
  void* p = (char*)c + GC_NURSERY_DATA_OFF + c->used;
  c->used += need;
  g_nursery_used_bytes += need;
  memset(p, 0, sz); /* keep the calloc zero-init contract of the classic path */
  return p;
}
static void* gc_alloc(size_t sz, uint8_t kind){
  gc_config_init();
  if (g_young_alloc>=g_young_threshold || g_nursery_used_bytes>=g_nursery_cap_bytes)
    ts_gc_collect_young();
  if (g_heap_bytes>=g_full_threshold_bytes){
    ts_gc_collect();
    if (!g_full_threshold_forced){
      size_t next = g_heap_bytes * 2;
      size_t with_headroom = g_heap_bytes + TS_GC_MIN_FULL_BYTES;
      if (next < with_headroom) next = with_headroom;
      if (next < TS_GC_MIN_FULL_BYTES) next = TS_GC_MIN_FULL_BYTES;
      g_full_threshold_bytes = next;
    }
  }
  RT_STAT_INC(alloc_count); RT_STAT_ADD(alloc_bytes, sz);
  g_heap_bytes += sz;
  if (g_nursery_enabled && sz <= GC_NURSERY_MAX_CELL && gc_is_bump_kind(kind)){
    ts_gc_header* h = (ts_gc_header*)gc_nursery_bump(sz);
    if (h){
      /* mark/remembered/pin_depth/gc_next are zeroed by the bump's memset;
         arena cells are NOT linked on g_young_heap (the sweep walks chunks). */
      h->kind=kind; h->gen=TS_GEN_YOUNG; h->size=sz;
      h->handle = gc_handle_alloc(h);
      g_alloc++; g_young_alloc++;
      RT_STAT_INC(nursery_alloc);
      return h;
    }
  }
  ts_gc_header* h=calloc(1,sz);
  h->kind=kind; h->gen=TS_GEN_YOUNG; h->size=sz; h->gc_next=g_young_heap; g_young_heap=h;
  h->handle = gc_handle_alloc(h);
  g_alloc++; g_young_alloc++;
  return h;
}

/* ---------------- objects ---------------- */
/* The shared Object.prototype: carries the modeled Object.prototype methods under
   method-name keys. Set up at program start (ts_setup_object_proto, emitted by
   the codegen which knows the method-name ids). NULL before setup, so early
   internal allocations simply have no proto until it's installed (harmless). */
static tsv g_object_proto_v = TS_NULL;
static tsv g_array_proto_v = TS_NULL;   /* unified model: Array.prototype */
static tsv g_map_proto_v = TS_NULL;     /* unified model: Map.prototype */
static tsv g_set_proto_v = TS_NULL;     /* unified model: Set.prototype */
static tsv g_headers_proto_v = TS_NULL; /* simplified Headers.prototype */
static tsv g_abort_controller_proto_v = TS_NULL; /* simplified AbortController.prototype */
static tsv g_abort_signal_proto_v = TS_NULL;     /* simplified AbortSignal.prototype */
/* Function.prototype is itself a callable no-op FUNCTION in JS (typeof "function",
   length 0, name ""), so it is a real ts_func (not a plain object). Every function's
   proto points at it. A GC-root holder keeps it alive even with zero live functions. */
static tsv g_function_proto_v = TS_UNDEFINED; /* Function.prototype callable singleton */
static tsv g_string_proto_v = TS_NULL;  /* String.prototype (for any-typed string method dispatch) */
static tsv g_regexp_proto_v = TS_NULL;  /* RegExp.prototype (method values for AOT RegExp objects) */
static tsv g_number_proto_v = TS_NULL;  /* Number.prototype (for any-typed number method dispatch) */
static tsv g_boolean_proto_v = TS_NULL; /* Boolean.prototype (for any-typed boolean method dispatch) */
static tsv g_promise_proto_v = TS_NULL; /* Promise.prototype first-class method values */
static tsv g_global_this_v = TS_UNDEFINED; /* rooted global object singleton */
static int ts_is_promise(tsv v); /* defined below; used by ts_get's promise method-value dispatch */
static inline int ts_proto_ref(tsv v){ return ts_is_obj(v) || ts_is_func(v); }
static inline ts_object* ts_proto_ptr(tsv v){ return ts_proto_ref(v) ? (ts_object*)ts_ptr(v) : NULL; }
static inline ts_object* ts_next_proto(ts_object* o){ return o ? ts_proto_ptr(o->proto) : NULL; }
static void ts_root_static_once(tsv* slot, int* rooted){ if (!*rooted){ ts_gc_root(slot); *rooted = 1; } }
static void ts_proto_register_method(tsv proto, ts_key method_key, const char* name, ts_code fn);
tsv ts_new_object(void){
  ts_object* o = gc_alloc(sizeof(ts_object), TS_KIND_OBJECT);
  o->proto = ts_proto_ref(g_object_proto_v) ? g_object_proto_v : TS_NULL;
  return ts_obj(o);
}
tsv ts_new_proto(void){ return ts_obj(gc_alloc(sizeof(ts_object),TS_KIND_OBJECT)); }
/* the runtime-side getter/installer used by emitted setup + ts_new_object. */
tsv ts_object_proto(void){ return ts_proto_ref(g_object_proto_v) ? g_object_proto_v : TS_NULL; }
void ts_install_object_proto(tsv proto){
  static int rooted = 0;
  if (ts_is_obj(proto)){ g_object_proto_v = proto; ts_root_static_once(&g_object_proto_v, &rooted); }
}
void ts_object_proto_register(ts_key method_key, const char* name, ts_code fn){
  if (!ts_proto_ref(g_object_proto_v)) return;
  ts_proto_register_method(g_object_proto_v, method_key, name, fn);
}

/* Proxy support. The hot property/call paths gate the proxy check behind
   g_has_proxies (0 until the first Proxy is created) so non-proxy programs pay
   only a single well-predicted branch. Handlers are defined late (they need the
   full property/call/construct runtime); forward-declared here so the hooks in
   ts_get/ts_set/... can call them. Core handlers take the key as a tsv value
   (string/symbol) so the same code serves both the named (key) and computed
   (keyv) entry points; ts_key_to_value reconstructs the value from a ts_key. */
int g_has_proxies = 0;   /* declared in ts_rt.h; see ts_is_proxy there */
static tsv ts_key_to_value(ts_key k);
static tsv ts_proxy_get_v(tsv pv, tsv keyv, tsv receiver);
static int ts_proxy_set_v(tsv pv, tsv keyv, tsv val, tsv receiver);
static int ts_proxy_has_v(tsv pv, tsv keyv);
static int ts_proxy_delete_v(tsv pv, tsv keyv);
static tsv ts_proxy_own_keys_arr(tsv pv);
static tsv ts_proxy_get_proto(tsv pv);
static tsv ts_proxy_set_proto(tsv pv, tsv proto);
static int ts_proxy_is_extensible(tsv pv);
static void ts_proxy_prevent_extensions(tsv pv);
static tsv ts_proxy_get_own_desc(tsv pv, tsv keyv);
static void ts_proxy_define_property(tsv pv, tsv keyv, tsv desc);
static tsv ts_proxy_apply(tsv pv, tsv thisArg, tsv* args, int nargs);
static tsv ts_proxy_construct(tsv pv, tsv* args, int nargs);
typedef void (*ts_prop_enum_cb_fwd)(uint32_t, tsv, void*);
static void ts_proxy_enum(tsv pv, ts_prop_enum_cb_fwd cb, void* ud);

/* Object.getPrototypeOf: return the object's prototype (or null). */
tsv ts_get_proto(tsv obj){
  if (g_has_proxies && ts_is_proxy(obj)) return ts_proxy_get_proto(obj);
  if (!ts_is_obj(obj)) return TS_NULL;
  ts_object* o = ts_ptr(obj);
  return ts_proto_ref(o->proto) ? o->proto : TS_NULL;
}
/* Object.setPrototypeOf: relink the object's prototype to `proto` (object or
   null), then return the object. Subsequent dynamic method/field lookups walk
   the new chain via ts_get, matching JS semantics. */
tsv ts_set_proto(tsv obj, tsv proto){
  if (g_has_proxies && ts_is_proxy(obj)) return ts_proxy_set_proto(obj, proto);
  /* Accept any prop-bag value (plain object OR function): both embed ts_obj_common
     first, so the proto pointer is at the same offset. This lets a class VALUE (a
     boxed ts_func) delegate to its static container, so `K.staticX`/`K.m()` and
     using a class as a bind/call/apply thisArg resolve statics via the proto chain. */
  if (ts_is_obj(obj) || ts_is_func(obj)){
    ts_object* o = ts_ptr(obj);
    o->proto = ts_proto_ref(proto) ? proto : TS_NULL;
    ts_write_barrier(obj, proto);
  }
  return obj;
}

/* ---- first-class callable values (methods + closures) ---- */
tsv ts_make_fn(ts_code code, tsv* env, uint32_t envlen){
  ts_func* f = gc_alloc(sizeof(ts_func), TS_KIND_FUNC);
  f->o.proto = ts_proto_ref(g_function_proto_v) ? g_function_proto_v : TS_NULL;
  f->code = (void*)code;
  f->prototype_prop = TS_UNDEFINED;
  if (env && envlen){
    f->env = malloc(sizeof(tsv)*envlen);
    for (uint32_t i=0;i<envlen;i++) f->env[i]=env[i];
    f->envlen = envlen;
  } else { f->env = NULL; f->envlen = 0; }
  return ts_func_v(f);
}
/* variant recording whether the callee reads args[0] as `this` (for call/apply/bind). */
tsv ts_make_fn_t(ts_code code, tsv* env, uint32_t envlen, int takes_this){
  tsv fv = ts_make_fn(code, env, envlen);
  ((ts_func*)ts_ptr(fv))->takes_this = (uint8_t)(takes_this ? 1 : 0);
  return fv;
}
void ts_set_fn_meta(tsv fn, uint32_t arity, const char* name){
  if (!ts_is_func(fn)) return;
  ts_func* f = ts_ptr(fn);
  f->arity = arity;
  f->name = name;
}
void ts_set_fn_prototype(tsv fn, tsv proto){
  if (!ts_is_func(fn)) return;
  ts_gc_root(&fn); ts_gc_root(&proto);
  ((ts_func*)ts_ptr(fn))->prototype_prop = proto;
  ((ts_func*)ts_ptr(fn))->constructable = 1;   /* own .prototype <=> ES5 [[Construct]] */
  ts_write_barrier(fn, proto);
  if (ts_is_obj(proto)) {
    ts_define_data(proto, ts_intern_field("constructor", 11), fn, 0, 1, 1);
  }
  ts_gc_unroot(2);
}
int ts_is_callable(tsv v){ return ts_is_func(v); }
/* Calling a non-function is a catchable TypeError in JS (`x()` / `x.m()` where
   the callee isn't callable). Implemented after the Error infrastructure (it
   needs TS_ERR_TYPE); forward-declared here so the call ABI below can throw.
   ts_throw_cannot_read is defined later (with ts_get_checked) — forward-declared
   so the method-dispatch receiver guard can reuse it. */
void ts_throw_not_a_function(const char* name);
static tsv ts_throw_cannot_read(tsv obj, const char* prop);
tsv ts_call(tsv fn, tsv* args, int nargs){
  if (g_has_proxies && ts_is_proxy(fn)) return ts_proxy_apply(fn, TS_UNDEFINED, args, nargs);
  if (!ts_is_func(fn)) ts_throw_not_a_function(NULL);
  ts_func* f = ts_ptr(fn);
  ts_code code = (ts_code)f->code;
  if (f->envlen){
    /* Closure: prepend captured cells (env) to the args, matching the callee's
       calling convention (captured cells are its leading parameters). */
    int total = (int)f->envlen + nargs;
    tsv* merged = malloc(sizeof(tsv)*(total>0?total:1));
    RT_STAT_INC(call_env_malloc);
    for (uint32_t i=0;i<f->envlen;i++) merged[i]=f->env[i];
    for (int i=0;i<nargs;i++) merged[f->envlen+i]=args[i];
    tsv r = code(merged, total);
    free(merged);
    return r;
  }
  return code(args, nargs);
}
/* Call a first-class function VALUE (the `g(...)` / callback path, where the
   caller supplied no `this`). If the callee was declared to read args[0] as
   `this` (takes_this) but none was provided, inject `undefined` so the real
   arguments land in the right positions (JS: a plain call has this=undefined).
   ts_call (used by method dispatch and call/apply/bind) already has this at
   args[0], so it stays as-is. The injected this goes AFTER captured cells, which
   is the closure parameter layout [cells..., this, realparams...]. */
tsv ts_call_value(tsv fn, tsv* args, int nargs){
  if (g_has_proxies && ts_is_proxy(fn)) return ts_proxy_apply(fn, TS_UNDEFINED, args, nargs);
  if (!ts_is_func(fn))ts_throw_not_a_function(NULL);
  ts_func* f = ts_ptr(fn);
  if (!f->takes_this) return ts_call(fn, args, nargs);
  /* inject undefined this at the front of the live args (cells are prepended by
     ts_call afterwards, giving [cells..., undefinedThis, args...]). */
  int n = nargs + 1;
  tsv* a = malloc(sizeof(tsv)*(n>0?n:1));
  a[0] = TS_UNDEFINED;
  for (int i=0;i<nargs;i++) a[1+i]=args[i];
  tsv r = ts_call(fn, a, n);
  free(a);
  return r;
}
/* Call a value as a METHOD: args[0] is the receiver (`this`) and args[1..] are
   the real arguments — the calling convention the dynamic method-dispatch path
   emits. If the resolved callee does NOT read a `this` slot (an arrow function or
   a plain function value stored as a property, takes_this==0), drop the receiver
   so the real arguments land in the callee's parameter positions. In JS,
   `obj.fn(x)` where `fn` is an arrow ignores the receiver and passes `x` as the
   first parameter; without this, `x` would be shifted into the second slot.
   Real methods (takes_this==1) keep the receiver at args[0] unchanged. */
tsv ts_call_method(tsv fn, tsv* args, int nargs){
  if (g_has_proxies && ts_is_proxy(fn)){
    tsv thisArg = (nargs>0)?args[0]:TS_UNDEFINED;
    return ts_proxy_apply(fn, thisArg, (nargs>1)?(args+1):NULL, (nargs>1)?(nargs-1):0);
  }
  if (!ts_is_func(fn))ts_throw_not_a_function(NULL);
  ts_func* f = ts_ptr(fn);
  if (f->takes_this) return ts_call(fn, args, nargs);
  /* arrow / plain function value: the leading receiver is not a parameter. */
  if (nargs > 0) return ts_call(fn, args + 1, nargs - 1);
  return ts_call(fn, args, 0);
}
tsv ts_new_sized(size_t size){
  if (size < sizeof(ts_object)) size = sizeof(ts_object);
  return ts_obj(gc_alloc(size, TS_KIND_OBJECT));
}
/* ---------------- dense arrays ---------------- */
static inline int array_uses_inline(ts_array* a){ return a->data == a->inline_data; }
static void array_free_data(ts_array* a){ if (a->data && !array_uses_inline(a)) free(a->data); }
static void array_init_storage(ts_array* a, uint32_t len){
  a->len = len;
  a->cap = len < 4 ? 4 : len;
  a->data = (a->cap <= 4) ? a->inline_data : (tsv*)malloc(sizeof(tsv) * a->cap);
  for (uint32_t i=0;i<a->cap;i++) a->data[i] = TS_UNDEFINED;
}
static void array_ensure_cap(ts_array* a, uint32_t need){
  if (need <= a->cap) return;
  uint32_t old = a->cap;
  uint32_t nc = old ? old * 2 : 4;
  while (nc < need) nc *= 2;
  if (array_uses_inline(a)){
    tsv* nd = (tsv*)malloc(sizeof(tsv) * nc);
    for (uint32_t i=0;i<old;i++) nd[i] = a->data[i];
    a->data = nd;
  } else {
    a->data = (tsv*)realloc(a->data, nc * sizeof(tsv));
  }
  for (uint32_t k=old;k<nc;k++) a->data[k]=TS_UNDEFINED;
  a->cap=nc;
}
/* `arr.length = n`: truncate (drop the tail) or extend (new slots are holes,
   read as undefined). The caller validates n as a non-negative integer < 2^32. */
static void ts_array_set_length(tsv arr, uint32_t newlen){
  ts_array* a = (ts_array*)ts_ptr(arr);
  uint32_t old = a->len;
  if (newlen <= old){ a->len = newlen; return; }
  array_ensure_cap(a, newlen);
  /* clear the extended slots to undefined (holes). array_ensure_cap only zero-fills
     when it actually grows capacity; reused capacity from a prior truncate would
     otherwise leak stale elements. */
  for (uint32_t i = old; i < newlen; i++) a->data[i] = TS_UNDEFINED;
  a->len = newlen;
}
tsv ts_new_array(uint32_t len){
  ts_array* a = gc_alloc(sizeof(ts_array), TS_KIND_ARRAY);
  a->o.proto = ts_proto_ref(g_array_proto_v) ? g_array_proto_v : TS_NULL;
  array_init_storage(a, len);
  return ts_obj(a);
}
int ts_is_array(tsv v){ return ts_is_obj(v) && ((ts_gc_header*)ts_ptr(v))->kind == TS_KIND_ARRAY; }
uint32_t ts_array_len(tsv arr){ return ts_is_array(arr) ? ((ts_array*)ts_ptr(arr))->len : 0; }
tsv ts_array_get(tsv arr, uint32_t i){
  if (!ts_is_array(arr)){
    /* str[i]: character access (no negative wraparound, unlike .at()). */
    if (ts_is_str(arr)){ return i < ts_str_len_typed(arr) ? ts_string_slice_view(arr, i, 1) : TS_UNDEFINED; }
    return TS_UNDEFINED;
  }
  ts_array* a = ts_ptr(arr); return i < a->len ? a->data[i] : TS_UNDEFINED;
}
void ts_array_set(tsv arr, uint32_t i, tsv v){
  if (!ts_is_array(arr)) return;
  ts_array* a = ts_ptr(arr);
  if (a->o.shape & 1u){   /* strict: a frozen array's element writes / push throw */
    char buf[96];
    if (i < a->len) snprintf(buf, sizeof(buf), "Cannot assign to read only property '%u' of object '[object Array]'", i);
    else snprintf(buf, sizeof(buf), "Cannot add property %u, object is not extensible", i);
    ts_throw_type_error_msg(buf); return;
  }
  array_ensure_cap(a, i + 1);
  if (i >= a->len) a->len = i+1;
  a->data[i] = v;
  ts_write_barrier(arr, v);
}
void ts_array_push(tsv arr, tsv v){ if (ts_is_array(arr)) ts_array_set(arr, ((ts_array*)ts_ptr(arr))->len, v); }
static inline void ts_array_store_existing(tsv arr, uint32_t i, tsv v){
  ts_array* a = ts_is_array(arr) ? (ts_array*)ts_ptr(arr) : NULL;
  if (!a || i >= a->len) return;
  a->data[i] = v;
  ts_write_barrier(arr, v);
}

/* an accessor property value: OBJECT-tagged pointer whose GC kind is ACCESSOR. */
static inline int is_accessor(tsv v){
  return ts_is_obj(v) && ((ts_gc_header*)ts_ptr(v))->kind == TS_KIND_ACCESSOR;
}

/* ---- typed struct field access (property_model_redesign §3.1, A-2b) ----
   A "typed class instance" stores some named string fields as unboxed/boxed C
   struct slots (->fN), described by a class descriptor registered lower in the
   file. The canonical property path must see these too, so a key naming a struct
   field reads/writes the slot at its offset rather than the prop map. This is the
   single place that bridges the optimized (struct) and dynamic (prop map) stores.
   Forward decls; the registry + helpers are defined after the Object statics. */
typedef struct ts_class_reg ts_class_reg;
static ts_class_reg* class_reg_for(ts_object* o);
/* If key names a struct field of o, return its byte offset (>=0) via *off and
   whether it is an unboxed double via *numeric, and return 1. Else return 0. */
static int class_field_lookup(ts_object* o, ts_key key, size_t* off, int* numeric);
static tsv  struct_field_get(ts_object* o, size_t off, int numeric);
static void struct_field_set(ts_object* o, size_t off, int numeric, tsv v);

/* Find (or create) the ts_prop slot for key. Returns the whole ts_prop* so
   callers can read/set attribute flags. New slots are initialized to
   TS_PROP_DEFAULT (all-true) so ordinary properties created here behave exactly
   as before the flags field existed. */
static ts_prop* find_prop(ts_object* o, ts_key key, int create){
  RT_STAT_INC(find_prop_calls);
  for (uint32_t i=0;i<o->len;i++) if (o->props[i].key==key){
    RT_STAT_ADD(find_prop_probes, i+1); RT_STAT_HIST(find_prop_hist, i+1);
    return &o->props[i];
  }
  RT_STAT_ADD(find_prop_probes, o->len); RT_STAT_HIST(find_prop_hist, o->len+1);
  if (!create) return NULL;
  if (o->len==o->cap){ o->cap=o->cap?o->cap*2:4; o->props=realloc(o->props,sizeof(ts_prop)*o->cap); }
  o->props[o->len].key=key; o->props[o->len].val=TS_UNDEFINED;
  o->props[o->len].flags=TS_PROP_DEFAULT;   /* must NOT be 0 (=all-false) */
  return &o->props[o->len++];
}
/* Back-compat thin wrapper: returns &val (the historical find_slot contract). */
static tsv* find_slot(ts_object* o, ts_key key, int create){
  ts_prop* p = find_prop(o, key, create);
  return p ? &p->val : NULL;
}
static int lookup_prop_chain(tsv receiver, ts_object* o, ts_key key, tsv* out){
  while (o){
    tsv* s = find_slot(o, key, 0);
    if (s){
      if (is_accessor(*s)){
        ts_accessor* ac=(ts_accessor*)ts_ptr(*s);
        if (ts_is_func(ac->getter)){
          if (ac->g_this){ tsv a0=receiver; *out = ts_call(ac->getter, &a0, 1); }
          else *out = ts_call(ac->getter, NULL, 0);
        } else {
          *out = TS_UNDEFINED;
        }
      } else {
        *out = *s;
      }
      return 1;
    }
    o = ts_next_proto(o);
  }
  return 0;
}
static int lookup_prop_chain_until(tsv receiver, ts_object* o, ts_object* stop, ts_key key, tsv* out){
  while (o && o != stop){
    tsv* s = find_slot(o, key, 0);
    if (s){
      if (is_accessor(*s)){
        ts_accessor* ac=(ts_accessor*)ts_ptr(*s);
        if (ts_is_func(ac->getter)){
          if (ac->g_this){ tsv a0=receiver; *out = ts_call(ac->getter, &a0, 1); }
          else *out = ts_call(ac->getter, NULL, 0);
        } else {
          *out = TS_UNDEFINED;
        }
      } else {
        *out = *s;
      }
      return 1;
    }
    o = ts_next_proto(o);
  }
  return 0;
}
/* Kinds whose struct begins with ts_obj_common (so (ts_object*)p aliases the
   common header: proto + named-property map). Unified object model: OBJECT,
   ARRAY, FUNC, MAP, SET. PROMISE/CORO/ACCESSOR do not (internal objects, never
   property-bag receivers) and are guarded out of the prop-map path. */
static inline int kind_has_common_header(uint8_t k){
  return k==TS_KIND_OBJECT || k==TS_KIND_ARRAY || k==TS_KIND_FUNC || k==TS_KIND_MAP || k==TS_KIND_SET;
}
/* A property-bag receiver: anything carrying the common header. Object/array/map/
   set use the OBJECT NaN-box selector; functions use the FUNC selector. Both are
   valid ts_get/ts_set receivers in the unified model. */
static inline int ts_is_propbag(tsv v){ return ts_is_obj(v) || ts_is_func(v); }
/* A class used as a runtime value is a ts_func carrying a (class_id+1) tag. It is
   object-like for ToPrimitive / iteration (its static [Symbol.toPrimitive]/
   [Symbol.iterator]/valueOf/toString live on the proto-linked static container),
   so coercion/iteration gates that accept objects must accept it too — but NOT
   ordinary functions (class_id==0), whose coercion is unchanged. */
static inline int ts_is_heap_func(tsv v){
  return ts_is_func(v) && ((ts_gc_header*)ts_ptr(v))->kind == TS_KIND_FUNC;
}
static inline int ts_is_class_value(tsv v){ return ts_is_heap_func(v) && ((ts_func*)ts_ptr(v))->class_id != 0; }
static inline ts_object* ts_class_static_container(tsv v){
  if (!ts_is_class_value(v)) return NULL;
  ts_func* f = (ts_func*)ts_ptr(v);
  ts_object* p = ts_proto_ptr(f->o.proto);
  if (!p || p->h.kind != TS_KIND_OBJECT) return NULL;
  return p;
}
/* "Object-like" for ToPrimitive / iteration: an ordinary object OR a class value
   (but NOT an ordinary function, class_id==0). Single source of truth for the
   coercion/iteration gates below — keeping the "is a class value object-like?"
   decision in one place so a future coercion path can't silently forget it.
   Outside these gates, ts_is_class_value is used only by instanceof. */
static inline int ts_object_like(tsv v){ return ts_is_obj(v) || ts_is_class_value(v); }

/* Object.freeze / Object.isFrozen / Object.create. We reuse the otherwise-unused
   `shape` word (reserved for a future PIC layer, always 0 today) as a frozen flag:
   bit 0 set => frozen. ts_set and the array mutators consult it to ignore writes,
   matching sloppy-mode semantics (a write silently no-ops rather than throwing). */
tsv ts_object_freeze(tsv v){ if (ts_is_propbag(v)) ((ts_object*)ts_ptr(v))->shape |= 1u; return v; }
tsv ts_object_is_frozen(tsv v){
  /* primitives are trivially "frozen" in JS; objects: check the flag. */
  return ts_bool(!ts_is_propbag(v) || (((ts_object*)ts_ptr(v))->shape & 1u));
}
tsv ts_object_create(tsv proto){
  tsv o = ts_new_proto();                 /* bare object: proto=NULL, shape=0 */
  if (ts_is_propbag(proto)) ((ts_object*)ts_ptr(o))->proto = proto;
  return o;                               /* Object.create(null) keeps proto=NULL */
}
/* Integrity levels reuse the `shape` flag word: bit0=frozen, bit1=non-extensible
   (Object.preventExtensions), bit2=sealed (Object.seal). seal/freeze imply
   non-extensible; freeze implies sealed. See ts_set / ts_delete_prop guards. */
tsv ts_object_seal(tsv v){ if (ts_is_propbag(v)) ((ts_object*)ts_ptr(v))->shape |= 4u; return v; }
tsv ts_object_prevent_extensions(tsv v){ if (g_has_proxies && ts_is_proxy(v)){ ts_proxy_prevent_extensions(v); return v; } if (ts_is_propbag(v)) ((ts_object*)ts_ptr(v))->shape |= 2u; return v; }
tsv ts_object_is_sealed(tsv v){
  return ts_bool(!ts_is_propbag(v) || (((ts_object*)ts_ptr(v))->shape & (1u|4u)));
}
tsv ts_object_is_extensible(tsv v){
  if (g_has_proxies && ts_is_proxy(v)) return ts_bool(ts_proxy_is_extensible(v));
  return ts_bool(ts_is_propbag(v) && (((ts_object*)ts_ptr(v))->shape & (1u|2u|4u)) == 0);
}
/* Frozen check used by the array mutators (pop/shift/sort/...): a frozen array
   must not be mutated. */
static inline int ts_arr_frozen(tsv v){ return (((ts_array*)ts_ptr(v))->o.shape & 1u) != 0; }
tsv ts_get(tsv obj, ts_key key){
  if (g_has_proxies && ts_is_proxy(obj)) return ts_proxy_get_v(obj, ts_key_to_value(key), obj);
  /* Primitives are not prop-bags, but a string exposes the usual String exotic
     own properties (`length` and indexed characters) and then resolves methods
     through String.prototype. This lets both `(x as any)[0]` and
     `(x as any).toUpperCase()` work through the dynamic property path. */
  if (ts_is_str(obj)){
    tsv own;
    if (ts_string_own_prop(obj, key, &own)) return own;
    ts_object* p = ts_proto_ptr(g_string_proto_v);
    while (p){ tsv* s = find_slot(p, key, 0); if (s) return *s; p = ts_next_proto(p); }
    return TS_UNDEFINED;
  }
  /* Same primitive-dispatch path for numbers: a method call on an any-typed value
     holding a number (`(x as any).toFixed(2)`) resolves via Number.prototype. */
  if (ts_is_num(obj)){
    ts_object* p = ts_proto_ptr(g_number_proto_v);
    while (p){ tsv* s = find_slot(p, key, 0); if (s) return *s; p = ts_next_proto(p); }
    return TS_UNDEFINED;
  }
  if (ts_is_bool(obj)){
    ts_object* p = ts_proto_ptr(g_boolean_proto_v);
    while (p){ tsv* s = find_slot(p, key, 0); if (s) return *s; p = ts_next_proto(p); }
    return TS_UNDEFINED;
  }
  /* functions: `fn.name` / `fn.length` derive from the boxed metadata (not the
     prop map). Resolve the field keys lazily and cache. Other keys fall through
     to the prototype walk below (Function.prototype.call/apply/bind). */
  if (ts_is_func(obj)){
    static uint32_t k_name = 0xFFFFFFFFu, k_length = 0xFFFFFFFFu, k_prototype = 0xFFFFFFFFu;
    if (k_name == 0xFFFFFFFFu){ k_name = ts_intern_field("name", 4); k_length = ts_intern_field("length", 6); k_prototype = ts_intern_field("prototype", 9); }
    ts_func* f = ts_ptr(obj);
    if (key == k_prototype && !ts_is_undef(f->prototype_prop)) return f->prototype_prop;
    ts_object* sc = ts_class_static_container(obj);
    if (sc){
      tsv found;
      if (lookup_prop_chain_until(obj, sc, ts_proto_ptr(g_object_proto_v), key, &found)) return found;
    }
    if (key == k_name){ const char* nm = f->name ? f->name : ""; return ts_new_string(nm, (uint32_t)strlen(nm)); }
    if (key == k_length) return ts_num((double)f->arity);
    if (ts_is_class_value(obj) && ts_proto_ref(g_function_proto_v)){
      tsv found;
      if (lookup_prop_chain(obj, ts_proto_ptr(g_function_proto_v), key, &found)) return found;
    }
  }
  /* Promises resolve their (method) properties via the shared Promise.prototype —
     this is what makes `p.then`/`.catch`/`.finally` a first-class function VALUE
     (the call form `p.then(cb)` uses a direct builtin instead). A promise carries
     no common header / proto field, so it is dispatched here by kind, like a
     primitive string/number. No own data properties exist on a promise. */
  if (ts_is_promise(obj)){
    for (ts_object* p = ts_proto_ptr(g_promise_proto_v); p; p = ts_next_proto(p)){ tsv* s = find_slot(p, key, 0); if (s) return *s; }
    return TS_UNDEFINED;
  }
  if (!ts_is_propbag(obj)) return TS_UNDEFINED;
  ts_object* o=ts_ptr(obj);
  /* Unified object model (docs/unified_object_model.md): TS_KIND_OBJECT and
     TS_KIND_ARRAY both begin with ts_obj_common at offset 0, so (ts_object*)p
     aliases the common header (proto + named-property map) for either. Other
     kinds (func/map/set/promise/coro) do NOT yet carry the common header (U-5),
     so reading them as a prop map would overflow -> guard them out (dynamic get
     yields undefined; caller's ts_is_callable turns a missing method into a loud,
     safe error). */
  if (!kind_has_common_header(o->h.kind)) return TS_UNDEFINED;
  if (ts_is_array(obj)){
    const char* nm = ts_field_name(key);
    if (nm){
      uint32_t nm_len = ts_field_name_len(key);
      if (field_bytes_is(nm, nm_len, "length")) return ts_num((double)ts_array_len(obj));
      uint32_t idx;
      if (prop_key_is_array_index(key, &idx) && idx < ts_array_len(obj)){
        ts_array* a = ts_ptr(obj);
        return a->data[idx];
      }
    }
  }
  /* own typed struct field (class descriptor) — only meaningful for class
     instances (TS_KIND_OBJECT); arrays have no class descriptor. */
  if (o->h.kind == TS_KIND_OBJECT){ size_t off; int numeric;
    if (class_field_lookup(o, key, &off, &numeric)) return struct_field_get(o, off, numeric); }
  tsv found;
  if (lookup_prop_chain(obj, o, key, &found)) return found;
  return TS_UNDEFINED;
}
/* Read a property that may be an own (or inherited DATA) property under its FIELD
   key, OR an inherited prototype METHOD (Object.prototype's toString/valueOf/
   hasOwnProperty live on OBJECT_PROTO under a METHOD key). JS semantics: an own
   property of ANY type — even undefined — shadows the inherited method; only when
   there is no data property at all do we fall back to the prototype method. This
   bridges the two key namespaces a bare value-read (`const f = o.toString`) can't
   otherwise cross. Used by the exporter's instance Object.prototype-method values. */
tsv ts_get_method_value(tsv recv, uint32_t field_key, uint32_t method_key){
  if (ts_is_propbag(recv)){
    ts_object* o = ts_ptr(recv);
    if (kind_has_common_header(o->h.kind)){
      for (ts_object* p=o; p; p=ts_next_proto(p)){      /* own + inherited data props (field key) */
        tsv* s = find_slot(p, field_key, 0);
        if (s) return *s;                        /* present (any type, incl. undefined) wins */
      }
    }
  }
  /* No data property found: resolve the inherited prototype METHOD. ts_get handles
     the method-key proto walk for every receiver kind (object/array/string/number/
     func), so primitives and functions dispatch correctly too. */
  return ts_get(recv, method_key);
}
static void invoke_setter(ts_accessor* ac, tsv obj, tsv val){
  if (!ts_is_func(ac->setter)) return;   /* getter-only: write ignored */
  if (ac->s_this){ tsv a[2]={obj,val}; ts_call(ac->setter,a,2); }
  else { tsv a0=val; ts_call(ac->setter,&a0,1); }
}
/* Strict-mode write errors (TS/ESM are always strict): a write to a frozen object
   or a non-writable property throws "Cannot assign to read only property ...", and
   a new property on a non-extensible object throws "Cannot add property ...". The
   messages match V8 so a try/catch sees identical e.message. */
static void ts_throw_readonly_write(ts_key key){
  const char* nm = ts_field_name(key);
  char buf[256];
  snprintf(buf, sizeof(buf), "Cannot assign to read only property '%s' of object '#<Object>'", nm ? nm : "?");
  ts_throw_type_error_msg(buf);
}
static void ts_throw_not_extensible(ts_key key){
  const char* nm = ts_field_name(key);
  char buf[256];
  snprintf(buf, sizeof(buf), "Cannot add property %s, object is not extensible", nm ? nm : "?");
  ts_throw_type_error_msg(buf);
}
/* Strict-mode receiver guard (TS/ESM is always strict): a property write on
   undefined/null throws "Cannot set properties of ...", and on a primitive
   number/string/boolean throws "Cannot create property ...", matching V8 (a
   catchable TypeError; silently ignoring these was a silent-miscompile class).
   Internal heap kinds without the common header (promise/coro) keep the
   historical no-op — their props are unmodeled (U-5), and V8 treats them as
   ordinary objects, so throwing would be the wrong direction for those. */
static void ts_throw_bad_write_receiver(tsv obj, ts_key key){
  const char* nm = ts_field_name(key);
  char buf[256];
  if (ts_is_undef(obj) || ts_is_null(obj)){
    snprintf(buf, sizeof buf, "Cannot set properties of %s (setting '%s')",
             ts_is_null(obj) ? "null" : "undefined", nm ? nm : "?");
    ts_throw_type_error_msg(buf);
  }
  if (ts_is_num(obj)){
    uint32_t sl; char* sc = ts_string_cstr_copy(ts_number_to_string_radix(obj, 10), &sl);
    snprintf(buf, sizeof buf, "Cannot create property '%s' on number '%s'", nm ? nm : "?", sc ? sc : "?");
    free(sc);
    ts_throw_type_error_msg(buf);
  }
  if (ts_is_str(obj)){
    uint32_t sl; char* sc = ts_string_cstr_copy(obj, &sl);
    snprintf(buf, sizeof buf, "Cannot create property '%s' on string '%s'", nm ? nm : "?", sc ? sc : "?");
    free(sc);
    ts_throw_type_error_msg(buf);
  }
  if (ts_is_bool(obj)){
    snprintf(buf, sizeof buf, "Cannot create property '%s' on boolean '%s'",
             nm ? nm : "?", ts_truthy(obj) ? "true" : "false");
    ts_throw_type_error_msg(buf);
  }
  /* other non-propbag kinds (symbol, promise, coro, ...): historical no-op */
}
void ts_set(tsv obj, ts_key key, tsv val){
  if (g_has_proxies && ts_is_proxy(obj)){ ts_proxy_set_v(obj, ts_key_to_value(key), val, obj); return; }
  if (!ts_is_propbag(obj)){ ts_throw_bad_write_receiver(obj, key); return; }
  if (ts_is_func(obj)){
    ts_func* f = (ts_func*)ts_ptr(obj);
    if (field_name_is(key, "prototype") && !ts_is_undef(f->prototype_prop)){
      if (!ts_is_class_value(obj)) { f->prototype_prop = val; ts_write_barrier(obj, val); }  /* class prototype is non-writable */
      return;
    }
  }
  ts_object* sc = ts_class_static_container(obj);
  if (sc){ ts_set(ts_obj(sc), key, val); return; }
  ts_object* o=ts_ptr(obj);
  /* unified model: OBJECT and ARRAY both begin with ts_obj_common, so the named-
     property map below works for either. Other kinds lack the common header (U-5)
     -> writes are safe no-ops. Arrays gain named props lazily (props=NULL until
     the first ts_set), matching V8's fast->dictionary transition; their indexed
     elements still use the ts_array_set fast path. */
  if (!kind_has_common_header(o->h.kind)) return;
  const int frozen = (o->shape & 1u) != 0;   /* Object.freeze */
  /* 0) own typed struct field (class descriptor): only class instances have one. */
  if (o->h.kind == TS_KIND_OBJECT){ size_t off; int numeric;
    if (class_field_lookup(o, key, &off, &numeric)){
      if (frozen){ ts_throw_readonly_write(key); return; }   /* strict: frozen instance */
      struct_field_set(o, off, numeric, val); return; } }
  if (ts_is_array(obj)){
    uint32_t idx;
    if (prop_key_is_array_index(key, &idx)){
      if (frozen){   /* strict: element write to a frozen array throws */
        char buf[96];
        snprintf(buf, sizeof(buf), "Cannot assign to read only property '%u' of object '[object Array]'", idx);
        ts_throw_type_error_msg(buf); return;
      }
      ts_array_set(obj, idx, val);
      return;
    }
    // `arr.length = v`: set the real array length (truncate/extend). JS requires v
    // to be a non-negative integer < 2^32, else RangeError.
    if (field_name_is(key, "length")){
      double d = ts_to_num(val);
      uint32_t u = (uint32_t)d;
      if (!(d >= 0.0) || (double)u != d){ ts_throw_range_error_msg("Invalid array length"); return; }
      ts_array_set_length(obj, u);
      return;
    }
  }
  /* 1) own prop slot? if accessor -> setter; if data -> overwrite (strict: a
     frozen object or a non-writable data property throws). */
  ts_prop* ownp=find_prop(o,key,0);
  if (ownp){
    if (is_accessor(ownp->val)){ invoke_setter((ts_accessor*)ts_ptr(ownp->val), obj, val); return; }
    if (frozen || !prop_is_writable(ownp)){ ts_throw_readonly_write(key); return; }
    ownp->val=val; ts_write_barrier(obj, val); return;
  }
  /* 2) inherited accessor up the proto chain -> invoke its setter (this=obj). */
  for (ts_object* p=ts_next_proto(o); p; p=ts_next_proto(p)){
    tsv* s=find_slot(p,key,0);
    if (s){
      if (is_accessor(*s)){ invoke_setter((ts_accessor*)ts_ptr(*s), obj, val); return; }
      break;   /* inherited data property: fall through to create an own data prop */
    }
  }
  /* 3) create an own data property — strict: throw on a non-extensible object
     (frozen bit0 / preventExtensions bit1 / sealed bit2). */
  if (o->shape & (1u|2u|4u)){ ts_throw_not_extensible(key); return; }
  *find_slot(o,key,1)=val;
  ts_write_barrier(obj, val);
}

void ts_global_this_init(void){
  if (g_global_this_v != TS_UNDEFINED) return;
  g_global_this_v = ts_new_object();
  ts_gc_root(&g_global_this_v);
}
tsv ts_global_this(void){
  ts_global_this_init();
  return g_global_this_v;
}
void ts_set_cstr(tsv obj, const char* name, tsv val){
  if (!name) return;
  tsv obj_root = obj;
  tsv val_root = val;
  ts_gc_root(&obj_root); ts_gc_root(&val_root);
  ts_set(obj_root, ts_intern_field(name, (uint32_t)strlen(name)), val_root);
  ts_gc_unroot(2);
}
tsv ts_global_get(const char* name){
  ts_global_this_init();
  if (!name) return TS_UNDEFINED;
  return ts_get(g_global_this_v, ts_intern_field(name, (uint32_t)strlen(name)));
}
void ts_global_set(const char* name, tsv val){
  ts_global_this_init();
  ts_set_cstr(g_global_this_v, name, val);
}
void ts_global_var_decl(const char* name){
  ts_global_this_init();
  if (!name) return;
  uint32_t key = ts_intern_field(name, (uint32_t)strlen(name));
  ts_object* g = (ts_object*)ts_ptr(g_global_this_v);
  if (!find_slot(g, key, 0)) ts_set(g_global_this_v, key, TS_UNDEFINED);
}

static ts_key ts_intern_string_value(tsv s){
  uint32_t len = 0;
  char* bytes = ts_string_key_bytes_copy(s, &len);
  ts_key key = ts_intern_field(bytes, len);
  free(bytes);
  return key;
}

/* Coerce a JS property key value to the runtime key id (ECMAScript ToPropertyKey):
   symbols stay symbol keys; everything else is ToString + string interning.
   Callers that need other live values preserved across ToString must root those
   values around this helper; the key itself and produced string are protected here. */
static int ts_key_from_value(tsv keyv, ts_key* out){
  if (ts_is_symbol(keyv)){
    *out = ts_symbol_key(keyv);
    return 1;
  }
  tsv ks = keyv;
  if (!ts_is_str(ks)){
    ts_gc_root(&keyv);
    ks = ts_to_string_v(keyv);
    ts_gc_unroot(1);
    if (!ts_is_str(ks)) return 0;
  }
  ts_gc_root(&ks);
  *out = ts_intern_string_value(ks);
  ts_gc_unroot(1);
  return 1;
}

/* A canonical array/string index: the property name is exactly
   String(ToUint32(name)) and the value is < 2^32-1. Rejects "00", "01", "-0",
   "1e0", " 1", and overflowing forms. */
static long ts_canonical_array_index(const char* s, uint32_t len){
  if (len == 0 || len > 10) return -1;
  if (s[0] == '0' && len > 1) return -1;
  uint64_t n = 0;
  for (uint32_t i = 0; i < len; i++){
    if (s[i] < '0' || s[i] > '9') return -1;
    n = n * 10 + (uint32_t)(s[i] - '0');
  }
  if (n >= 0xFFFFFFFFu) return -1;
  return (long)n;
}

static int ts_string_own_prop(tsv obj, ts_key key, tsv* out){
  if (!ts_is_str(obj)) return 0;
  const char* nm = ts_field_name(key);
  if (!nm) return 0;
  ts_string* s = ts_ptr(obj);
  uint32_t nm_len = ts_field_name_len(key);
  if (field_bytes_is(nm, nm_len, "length")){
    if (out) *out = ts_num((double)s->len);
    return 1;
  }
  long ix = ts_canonical_array_index(nm, nm_len);
  if (ix >= 0 && (uint32_t)ix < s->len){
    if (out) *out = ts_string_slice_view(obj, (uint32_t)ix, 1);
    return 1;
  }
  return 0;
}

/* Object.defineProperty accessor form: define an accessor property on obj.
   g_this/s_this say whether the getter/setter want `this` as a leading arg.
   e/c are the enumerable/configurable attributes (writable is not meaningful for
   accessors). defineProperty defaults both to false when omitted. */
void ts_define_accessor_attr(tsv obj, ts_key key, tsv getter, tsv setter, int g_this, int s_this, int e, int c){
  if (!ts_is_obj(obj)) return;
  ts_gc_root(&obj); ts_gc_root(&getter); ts_gc_root(&setter);
  ts_accessor* ac = gc_alloc(sizeof(ts_accessor), TS_KIND_ACCESSOR);
  ac->getter = getter; ac->setter = setter;
  ac->g_this = (uint8_t)(g_this?1:0); ac->s_this = (uint8_t)(s_this?1:0);
  ts_prop* p = find_prop((ts_object*)ts_ptr(obj), key, 1);
  p->val = ts_obj(ac);
  ts_write_barrier(obj, p->val);
  /* accessor attributes live in the slot flags. writable bit is unused for
     accessors (kept 0). enumerable/configurable per the descriptor. */
  p->flags = (uint8_t)((e?TS_PROP_ENUMERABLE:0) | (c?TS_PROP_CONFIGURABLE:0));
  ts_gc_unroot(3);
}
/* back-compat: defineProperty accessor with default attributes (non-enumerable,
   non-configurable). Used where attributes aren't specified. */
void ts_define_accessor(tsv obj, ts_key key, tsv getter, tsv setter, int g_this, int s_this){
  ts_define_accessor_attr(obj, key, getter, setter, g_this, s_this, 0, 0);
}

/* accessor define with a runtime key (string/number coerced + interned). */
void ts_define_accessor_dyn(tsv obj, tsv keyv, tsv getter, tsv setter, int g_this, int s_this, int e, int c){
  if (!ts_is_obj(obj)) return;
  ts_gc_root(&obj); ts_gc_root(&getter); ts_gc_root(&setter);
  ts_key key;
  int ok = ts_key_from_value(keyv, &key);
  ts_gc_unroot(3);
  if (!ok) return;
  ts_define_accessor_attr(obj, key, getter, setter, g_this, s_this, e, c);
}

/* accessor define with a SYMBOL key (well-known or user) — no stringify. The
   symbol-keyed slot is read/written/invoked by ts_get/ts_set just like any other
   key, so this is the only runtime piece needed for symbol-keyed accessors. */
void ts_define_accessor_symkey(tsv obj, tsv sym, tsv getter, tsv setter, int g_this, int s_this, int e, int c){
  if (!ts_is_obj(obj) || !ts_is_symbol(sym)) return;
  ts_define_accessor_attr(obj, ts_symbol_key(sym), getter, setter, g_this, s_this, e, c);
}

/* Object.defineProperty data form: define (or redefine) a data property with
   explicit attributes. If e=w=c=1 this is identical to an ordinary property
   (it just sets the slot's value with the default flags). Otherwise the slot's
   flags record the attributes, honored by ts_set (writable), ts_delete_prop
   (configurable), and the enumeration path (enumerable). */
void ts_define_data(tsv obj, ts_key key, tsv value, int e, int w, int c){
  if (!ts_is_obj(obj)) return;
  ts_gc_root(&obj); ts_gc_root(&value);
  ts_object* o = (ts_object*)ts_ptr(obj);
  ts_prop* p = find_prop(o, key, 1);
  p->val = value;
  ts_write_barrier(obj, value);
  p->flags = (uint8_t)((e?TS_PROP_ENUMERABLE:0) | (w?TS_PROP_WRITABLE:0) | (c?TS_PROP_CONFIGURABLE:0));
  ts_gc_unroot(2);
}

void ts_define_data_dyn(tsv obj, tsv keyv, tsv value, int e, int w, int c){
  if (!ts_is_obj(obj)) return;
  ts_gc_root(&obj); ts_gc_root(&value);
  ts_key key;
  int ok = ts_key_from_value(keyv, &key);
  ts_gc_unroot(2);
  if (!ok) return;
  ts_define_data(obj, key, value, e, w, c);
}

static void ts_proto_register_method(tsv proto, ts_key method_key, const char* name, ts_code fn){
  if (!ts_proto_ref(proto)) return;
  tsv fv = ts_make_fn_t(fn, 0, 0, 1);
  ts_gc_root(&proto); ts_gc_root(&fv);
  ts_object* o = (ts_object*)ts_ptr(proto);
  ts_prop* mp = find_prop(o, method_key, 1);
  mp->val = fv;
  mp->flags = (uint8_t)(TS_PROP_WRITABLE | TS_PROP_CONFIGURABLE);
  ts_write_barrier(proto, fv);
  if (name){
    ts_prop* fp = find_prop(o, ts_intern_field(name, (uint32_t)strlen(name)), 1);
    fp->val = fv;
    fp->flags = (uint8_t)(TS_PROP_WRITABLE | TS_PROP_CONFIGURABLE);
    ts_write_barrier(proto, fv);
  }
  ts_gc_unroot(2);
}

/* ---------------- strings ---------------- */
static uint32_t strhash_units(const char* data, uint32_t flags, uint32_t n){
  uint32_t h=2166136261u;
  ts_strview v = { data, n, 0, flags };
  for(uint32_t i=0;i<n;i++){
    uint16_t cu = ts_str_cu_at_view(v, i);
    h ^= (uint8_t)(cu & 0xffu); h *= 16777619u;
    h ^= (uint8_t)(cu >> 8); h *= 16777619u;
  }
  return h;
}
static uint32_t strhash_view(ts_strview v){ return strhash_units(v.data, v.flags, v.len); }
static uint32_t strflags_storage(const char* data, uint32_t flags, uint32_t n){
  uint32_t f = TS_STR_FLAG_HASHED | (flags & TS_STR_FLAG_UTF16);
  ts_strview v = { data, n, 0, f };
  int ascii = 1;
  for(uint32_t i=0;i<n;i++) if(ts_str_cu_at_view(v, i) >= 0x80u){ ascii = 0; break; }
  if (ascii) f |= TS_STR_FLAG_ASCII;
  return f;
}
static ts_string* ts_string_alloc_storage(uint32_t len, uint32_t flags){
  flags &= TS_STR_FLAG_UTF16;
  uint32_t unit = ts_str_unit_size_flags(flags);
  size_t bytes = (size_t)len * unit;
  ts_string* str=gc_alloc(sizeof(ts_string)+bytes+unit,TS_KIND_STRING);
  str->len=len; str->hash=0; str->flags=flags;
  str->parent=TS_UNDEFINED; str->offset=0;
  memset(str->data + bytes, 0, unit);
  return str;
}
static void ts_str_copy_units(char* dst, uint32_t dst_flags, uint32_t dst_pos,
                              ts_strview src, uint32_t src_pos, uint32_t len){
  if (len == 0) return;
  if (((dst_flags ^ src.flags) & TS_STR_FLAG_UTF16) == 0){
    uint32_t w = ts_str_unit_size_flags(dst_flags);
    memcpy(dst + (size_t)dst_pos * w, src.data + (size_t)src_pos * w, (size_t)len * w);
    return;
  }
  for(uint32_t i=0;i<len;i++) ts_str_cu_set(dst, dst_flags, dst_pos+i, ts_str_cu_at_view(src, src_pos+i));
}
static uint32_t utf8_next_cp(const unsigned char* s, uint32_t len, uint32_t* i){
  unsigned char c0 = s[(*i)++];
  if (c0 < 0x80u) return c0;
  uint32_t cp; uint32_t need;
  if ((c0 & 0xE0u) == 0xC0u){ cp = c0 & 0x1Fu; need = 1; if (cp == 0) return c0; }
  else if ((c0 & 0xF0u) == 0xE0u){ cp = c0 & 0x0Fu; need = 2; }
  else if ((c0 & 0xF8u) == 0xF0u){ cp = c0 & 0x07u; need = 3; }
  else return c0;
  if (*i + need > len) return c0;
  for(uint32_t k=0;k<need;k++){
    unsigned char cx = s[*i + k];
    if ((cx & 0xC0u) != 0x80u) return c0;
    cp = (cp << 6) | (uint32_t)(cx & 0x3Fu);
  }
  *i += need;
  if (cp > 0x10FFFFu || (cp >= 0xD800u && cp <= 0xDFFFu)) return 0xFFFDu;
  return cp;
}
static uint32_t utf8_next_cp_allow_surrogate(const unsigned char* s, uint32_t len, uint32_t* i){
  unsigned char c0 = s[(*i)++];
  if (c0 < 0x80u) return c0;
  uint32_t cp; uint32_t need;
  if ((c0 & 0xE0u) == 0xC0u){ cp = c0 & 0x1Fu; need = 1; if (cp == 0) return c0; }
  else if ((c0 & 0xF0u) == 0xE0u){ cp = c0 & 0x0Fu; need = 2; }
  else if ((c0 & 0xF8u) == 0xF0u){ cp = c0 & 0x07u; need = 3; }
  else return c0;
  if (*i + need > len) return c0;
  for(uint32_t k=0;k<need;k++){
    unsigned char cx = s[*i + k];
    if ((cx & 0xC0u) != 0x80u) return c0;
    cp = (cp << 6) | (uint32_t)(cx & 0x3Fu);
  }
  *i += need;
  return (cp > 0x10FFFFu) ? 0xFFFDu : cp;
}
static void utf8_measure(const char* s, uint32_t len, uint32_t* out_units, int* out_latin1, int* out_ascii){
  uint32_t units = 0; int latin1 = 1, ascii = 1;
  const unsigned char* p = (const unsigned char*)s;
  for(uint32_t i=0;i<len;){
    uint32_t cp = utf8_next_cp(p, len, &i);
    if (cp > 0x7Fu) ascii = 0;
    if (cp > 0xFFu) latin1 = 0;
    units += (cp > 0xFFFFu) ? 2u : 1u;
  }
  *out_units = units; *out_latin1 = latin1; *out_ascii = ascii;
}
typedef struct {
  ts_gc_header h;
  uint32_t len, hash, flags;
  tsv parent;
  uint32_t offset;
  char data[2];
} ts_static_small_string;
static ts_static_small_string g_ascii_small_strings[129];
static int g_ascii_small_strings_inited = 0;
static void ts_ascii_small_strings_init(void){
  if (g_ascii_small_strings_inited) return;
  g_ascii_small_strings_inited = 1;
  for (uint32_t i=0;i<128;i++){
    ts_static_small_string* s = &g_ascii_small_strings[i];
    s->h.kind=TS_KIND_STRING; s->h.mark=0; s->h.gen=TS_GEN_NONHEAP; s->h.remembered=0;
    s->h.pin_depth=0; s->h.handle=0; s->h.size=0; s->h.gc_next=NULL;
    char ch = (char)i;
    s->len=1; s->hash=strhash_units(&ch, 0, 1);
    s->flags=TS_STR_FLAG_ASCII | TS_STR_FLAG_STATIC | TS_STR_FLAG_HASHED;
    s->parent=TS_UNDEFINED; s->offset=0; s->data[0]=(char)i; s->data[1]=0;
  }
  ts_static_small_string* e = &g_ascii_small_strings[128];
  e->h.kind=TS_KIND_STRING; e->h.mark=0; e->h.gen=TS_GEN_NONHEAP; e->h.remembered=0;
  e->h.pin_depth=0; e->h.handle=0; e->h.size=0; e->h.gc_next=NULL;
  e->len=0; e->hash=strhash_units("", 0, 0);
  e->flags=TS_STR_FLAG_ASCII | TS_STR_FLAG_STATIC | TS_STR_FLAG_HASHED;
  e->parent=TS_UNDEFINED; e->offset=0; e->data[0]=0; e->data[1]=0;
}
static tsv ts_ascii_small_string(uint32_t len, unsigned char c){
  ts_ascii_small_strings_init();
  return ts_str_v(&g_ascii_small_strings[len ? (uint32_t)c : 128u]);
}
tsv ts_new_string(const char* s, uint32_t len){
  uint32_t units = 0; int latin1 = 1, ascii = 1;
  utf8_measure(s, len, &units, &latin1, &ascii);
  if (units == 0) return ts_ascii_small_string(0, 0);
  if (units == 1 && ascii && len == 1) return ts_ascii_small_string(1, (unsigned char)s[0]);
  uint32_t flags = latin1 ? 0u : TS_STR_FLAG_UTF16;
  ts_string* str=ts_string_alloc_storage(units, flags);
  const unsigned char* p = (const unsigned char*)s;
  uint32_t oi = 0;
  for(uint32_t i=0;i<len;){
    uint32_t cp = utf8_next_cp(p, len, &i);
    if (!(flags & TS_STR_FLAG_UTF16)){
      str->data[oi++] = (char)(cp & 0xffu);
    } else if (cp <= 0xFFFFu){
      ts_str_cu_set(str->data, flags, oi++, (uint16_t)cp);
    } else {
      cp -= 0x10000u;
      ts_str_cu_set(str->data, flags, oi++, (uint16_t)(0xD800u + (cp >> 10)));
      ts_str_cu_set(str->data, flags, oi++, (uint16_t)(0xDC00u + (cp & 0x3FFu)));
    }
  }
  str->flags = strflags_storage(str->data, flags, units);
  str->hash = strhash_units(str->data, str->flags, units);
  return ts_str_v(str);
}
/* Build a string from bytes the caller already knows are pure ASCII (every byte
   < 0x80). Skips the utf8 measure + decode + ascii-rescan passes of ts_new_string
   and leaves the hash lazy (HASHED unset; computed-on-demand semantics are a
   no-op here since string equality falls back to a byte compare). Used for
   freshly-built ASCII payloads such as JSON.stringify output. */
static tsv ts_new_string_ascii(const char* s, uint32_t len){
  if (len == 0) return ts_ascii_small_string(0, 0);
  if (len == 1) return ts_ascii_small_string(1, (unsigned char)s[0]);
  ts_string* str = ts_string_alloc_storage(len, 0);
  memcpy(str->data, s, len);
  str->flags = TS_STR_FLAG_ASCII; /* 1-byte units, not hashed (lazy) */
  str->hash = 0;
  return ts_str_v(str);
}
static tsv ts_new_string_from_code_units(const uint16_t* units, uint32_t len){
  if (len == 0) return ts_ascii_small_string(0, 0);
  int latin1 = 1, ascii = 1;
  for(uint32_t i=0;i<len;i++){
    if (units[i] > 0xffu) latin1 = 0;
    if (units[i] >= 0x80u) ascii = 0;
  }
  if (len == 1 && ascii) return ts_ascii_small_string(1, (unsigned char)units[0]);
  uint32_t flags = latin1 ? 0u : TS_STR_FLAG_UTF16;
  ts_string* str = ts_string_alloc_storage(len, flags);
  for(uint32_t i=0;i<len;i++) ts_str_cu_set(str->data, flags, i, units[i]);
  str->flags = strflags_storage(str->data, flags, len);
  str->hash = strhash_units(str->data, str->flags, len);
  return ts_str_v(str);
}
uint32_t* ts_string_codepoints_copy(tsv v, uint32_t* out_len){
  tsv s = ts_to_string_v(v);
  ts_strview xs = ts_str_view_typed(s);
  uint32_t* cps = malloc(sizeof(uint32_t) * (size_t)(xs.len ? xs.len : 1));
  if (!cps) {
    if (out_len) *out_len = 0;
    return NULL;
  }
  uint32_t n = 0;
  for (uint32_t i = 0; i < xs.len; i++) {
    uint32_t cp = ts_str_cu_at_view(xs, i);
    if (cp >= 0xD800u && cp <= 0xDBFFu && i + 1 < xs.len) {
      uint32_t lo = ts_str_cu_at_view(xs, i + 1);
      if (lo >= 0xDC00u && lo <= 0xDFFFu) {
        cp = 0x10000u + (((cp - 0xD800u) << 10) | (lo - 0xDC00u));
        i++;
      }
    }
    cps[n++] = cp;
  }
  if (out_len) *out_len = n;
  return cps;
}
tsv ts_string_from_codepoints(const uint32_t* cps, uint32_t len){
  if (!cps || len == 0) return ts_ascii_small_string(0, 0);
  uint32_t units_len = 0;
  for (uint32_t i = 0; i < len; i++) {
    uint32_t cp = cps[i];
    units_len += (cp > 0xFFFFu && cp <= 0x10FFFFu) ? 2u : 1u;
  }
  uint16_t* units = malloc(sizeof(uint16_t) * (size_t)(units_len ? units_len : 1));
  if (!units) return ts_ascii_small_string(0, 0);
  uint32_t o = 0;
  for (uint32_t i = 0; i < len; i++) {
    uint32_t cp = cps[i];
    if (cp > 0x10FFFFu) cp = 0xFFFDu;
    if (cp > 0xFFFFu) {
      cp -= 0x10000u;
      units[o++] = (uint16_t)(0xD800u + (cp >> 10));
      units[o++] = (uint16_t)(0xDC00u + (cp & 0x3FFu));
    } else {
      units[o++] = (uint16_t)cp;
    }
  }
  tsv out = ts_new_string_from_code_units(units, o);
  free(units);
  return out;
}
static tsv ts_new_string_from_key_bytes(const char* s, uint32_t len){
  if (len == 0) return ts_ascii_small_string(0, 0);
  uint16_t* units = (uint16_t*)malloc(sizeof(uint16_t) * (size_t)len);
  uint32_t out_len = 0;
  const unsigned char* p = (const unsigned char*)s;
  for(uint32_t i=0;i<len;){
    uint32_t cp = utf8_next_cp_allow_surrogate(p, len, &i);
    if (cp <= 0xFFFFu){
      units[out_len++] = (uint16_t)cp;
    } else {
      cp -= 0x10000u;
      units[out_len++] = (uint16_t)(0xD800u + (cp >> 10));
      units[out_len++] = (uint16_t)(0xDC00u + (cp & 0x3FFu));
    }
  }
  tsv out = ts_new_string_from_code_units(units, out_len);
  free(units);
  return out;
}
/* Copy a slice from an existing heap string. The source is rooted across the
   destination allocation, then re-fetched before copying so a future moving
   collector cannot leave us reading through a stale data pointer. */
static tsv ts_string_slice_copy(tsv src, uint32_t start, uint32_t len){
  if (!ts_is_str(src)) return TS_UNDEFINED;
  ts_gc_root(&src);
  ts_strview x = ts_str_view_typed(src);
  if (start > x.len) start = x.len;
  if (len > x.len - start) len = x.len - start;
  uint32_t flags = x.flags & TS_STR_FLAG_UTF16;
  ts_string* out = ts_string_alloc_storage(len, flags);
  x = ts_str_view_typed(src);
  out->len = len;
  ts_str_copy_units(out->data, flags, 0, x, start, len);
  out->flags = strflags_storage(out->data, flags, len);
  out->hash = strhash_units(out->data, out->flags, len);
  out->parent = TS_UNDEFINED;
  out->offset = 0;
  ts_gc_unroot(1);
  return ts_str_v(out);
}
/* A substring view avoids copying the source bytes. For tiny slices of very large
   strings, copy instead so a short-lived token does not retain a huge parent. */
static tsv ts_string_slice_view(tsv src, uint32_t start, uint32_t len){
  if (!ts_is_str(src)) return TS_UNDEFINED;
  ts_gc_root(&src);
  ts_strview x = ts_str_view_typed(src);
  if (start > x.len) start = x.len;
  if (len > x.len - start) len = x.len - start;
  if (len == 0){ ts_gc_unroot(1); return ts_ascii_small_string(0, 0); }
  uint16_t first_cu = ts_str_cu_at_view(x, start);
  if (len == 1 && first_cu < 0x80u){
    unsigned char c = (unsigned char)first_cu;
    ts_gc_unroot(1);
    return ts_ascii_small_string(1, c);
  }
  if (start == 0 && len == x.len){ ts_gc_unroot(1); return src; }
  if (x.len > 65536u && len * 8u < x.len){
    ts_gc_unroot(1);
    return ts_string_slice_copy(src, start, len);
  }
  ts_string* out = gc_alloc(sizeof(ts_string)+1, TS_KIND_STRING);
  x = ts_str_view_typed(src);
  out->len = len;
  out->hash = 0;
  out->flags = TS_STR_FLAG_VIEW | (x.flags & TS_STR_FLAG_ASCII);
  out->parent = src;
  out->offset = start;
  out->data[0] = 0;
  tsv r = ts_str_v(out);
  ts_gc_unroot(1);
  return r;
}
static inline int ts_is_surrogate_code_unit(uint32_t cp){
  return cp >= 0xD800u && cp <= 0xDFFFu;
}
static size_t ts_str_utf8_len_view_impl(ts_strview x, int replace_lone_surrogates){
  size_t n = 0;
  for(uint32_t i=0;i<x.len;i++){
    uint32_t cp = ts_str_cu_at_view(x, i);
    if (cp >= 0xD800u && cp <= 0xDBFFu && i+1<x.len){
      uint16_t lo = ts_str_cu_at_view(x, i+1);
      if (lo >= 0xDC00u && lo <= 0xDFFFu){
        cp = 0x10000u + (((cp - 0xD800u) << 10) | (lo - 0xDC00u));
        i++;
      }
    }
    if (replace_lone_surrogates && ts_is_surrogate_code_unit(cp)) cp = 0xFFFDu;
    if (cp < 0x80u) n += 1;
    else if (cp < 0x800u) n += 2;
    else if (cp < 0x10000u) n += 3;
    else n += 4;
  }
  return n;
}
static size_t ts_str_utf8_len_view(ts_strview x){
  return ts_str_utf8_len_view_impl(x, 1);
}
static size_t ts_str_key_bytes_len_view(ts_strview x){
  return ts_str_utf8_len_view_impl(x, 0);
}
static char* ts_str_utf8_copy_view_impl(ts_strview x, uint32_t* out_len, int replace_lone_surrogates){
  size_t n = replace_lone_surrogates ? ts_str_utf8_len_view(x) : ts_str_key_bytes_len_view(x);
  char* out = (char*)malloc(n + 1);
  size_t o = 0;
  for(uint32_t i=0;i<x.len;i++){
    uint32_t cp = ts_str_cu_at_view(x, i);
    if (cp >= 0xD800u && cp <= 0xDBFFu && i+1<x.len){
      uint16_t lo = ts_str_cu_at_view(x, i+1);
      if (lo >= 0xDC00u && lo <= 0xDFFFu){
        cp = 0x10000u + (((cp - 0xD800u) << 10) | (lo - 0xDC00u));
        i++;
      }
    }
    if (replace_lone_surrogates && ts_is_surrogate_code_unit(cp)) cp = 0xFFFDu;
    if (cp < 0x80u) out[o++] = (char)cp;
    else if (cp < 0x800u){ out[o++] = (char)(0xC0u | (cp >> 6)); out[o++] = (char)(0x80u | (cp & 0x3Fu)); }
    else if (cp < 0x10000u){ out[o++] = (char)(0xE0u | (cp >> 12)); out[o++] = (char)(0x80u | ((cp >> 6) & 0x3Fu)); out[o++] = (char)(0x80u | (cp & 0x3Fu)); }
    else { out[o++] = (char)(0xF0u | (cp >> 18)); out[o++] = (char)(0x80u | ((cp >> 12) & 0x3Fu)); out[o++] = (char)(0x80u | ((cp >> 6) & 0x3Fu)); out[o++] = (char)(0x80u | (cp & 0x3Fu)); }
  }
  out[o] = 0;
  if (out_len) *out_len = (uint32_t)o;
  return out;
}
static char* ts_str_utf8_copy_view(ts_strview x, uint32_t* out_len){
  return ts_str_utf8_copy_view_impl(x, out_len, 1);
}
static char* ts_str_key_bytes_copy_view(ts_strview x, uint32_t* out_len){
  return ts_str_utf8_copy_view_impl(x, out_len, 0);
}
static char* ts_string_cstr_copy(tsv src, uint32_t* out_len){
  ts_strview x = ts_str_view_typed(src);
  return ts_str_utf8_copy_view(x, out_len);
}
static char* ts_string_key_bytes_copy(tsv src, uint32_t* out_len){
  ts_strview x = ts_str_view_typed(src);
  return ts_str_key_bytes_copy_view(x, out_len);
}
/* Fast signed-integer formatter (avoids snprintf's vfprintf machinery, which is
   the dominant cost when stringifying integer-heavy data). Writes a NUL-terminated
   decimal string and returns its length. buf must hold at least 21 bytes. */
static int ts_i64_to_str(long long v, char* buf){
  char tmp[20];
  int n = 0;
  int neg = v < 0;
  unsigned long long u = neg ? (unsigned long long)(-(v + 1)) + 1ull : (unsigned long long)v;
  do { tmp[n++] = (char)('0' + (u % 10u)); u /= 10u; } while (u);
  int len = 0;
  if (neg) buf[len++] = '-';
  while (n) buf[len++] = tmp[--n];
  buf[len] = 0;
  return len;
}
/* Format a double like JS Number.toString: shortest decimal that round-trips. */
static void ts_fmt_num(double d, char* buf, size_t n){
  if (d != d) { snprintf(buf,n,"NaN"); return; }
  if (d == 1.0/0.0) { snprintf(buf,n,"Infinity"); return; }
  if (d == -1.0/0.0) { snprintf(buf,n,"-Infinity"); return; }
  /* small integers: exact decimal via fast itoa */
  if (d == (double)(long long)d && d < 9e15 && d > -9e15) { ts_i64_to_str((long long)d, buf); return; }
  /* JS Number->String: integers with magnitude in [2^53, 1e21) print in full
     decimal (no exponent), but using the SHORTEST decimal that round-trips — NOT
     the exact value of the double. `%.0f` would print the exact (longer) integer
     (e.g. 1.2345678901234568e20 -> "...667584" instead of JS's "...680000").
     Find the shortest significant digits via `%e`, then expand them positionally
     with trailing zeros. (Magnitudes below 2^53 took the exact itoa path above;
     1e21 and beyond fall through to the exponential `%g` path below.) */
  if (d == floor(d) && fabs(d) < 1e21) {
    char tmp[48];
    int p;
    for (p = 0; p <= 16; p++) { snprintf(tmp, sizeof tmp, "%.*e", p, d); if (strtod(tmp, 0) == d) break; }
    if (p > 16) snprintf(tmp, sizeof tmp, "%.16e", d);
    const char* s = tmp;
    char* out = buf;
    if (*s == '-') { *out++ = '-'; s++; }
    char digits[40]; int nd = 0;
    while (*s && *s != 'e' && *s != 'E') { if (*s != '.') digits[nd++] = *s; s++; }
    int expo = (*s == 'e' || *s == 'E') ? atoi(s + 1) : 0;
    int total = expo + 1;            /* integer digit count */
    int i;
    for (i = 0; i < nd && i < total; i++) *out++ = digits[i];
    for (; i < total; i++) *out++ = '0';
    *out = 0;
    return;
  }
  for (int p=1; p<=17; p++){ snprintf(buf,n,"%.*g",p,d); if (strtod(buf,0)==d) break; }
  if (strtod(buf,0)!=d) snprintf(buf,n,"%.17g",d);
  /* JS uses plain decimal notation for fractions down to 1e-6 (e.g. 0.000001),
     but C's %g switches to exponential at 1e-5. Reformat such small fractions as
     fixed decimal so they match V8 (1e-7 and below stay exponential). */
  {
    double ad = fabs(d);
    if (strchr(buf,'e') && ad >= 1e-6 && ad < 1){
      for (int q=1; q<=20; q++){ snprintf(buf,n,"%.*f",q,d); if (strtod(buf,0)==d) break; }
      return;
    }
  }
  /* JS exponent style: C prints "e-07"/"e+05" (zero-padded 2 digits); JS uses
     "e-7"/"e+5" (no leading zero) but keeps 3-digit exponents ("e+100"). Strip a
     single leading zero in a 2-digit exponent. */
  char* e = strchr(buf, 'e');
  if (e && (e[1]=='+'||e[1]=='-') && e[2]=='0' && e[3]>='0' && e[3]<='9' && e[4]==0){
    e[2]=e[3]; e[3]=0;
  }
}

/* ---------------- Symbol (symbol_design.md) ---------------- */
static uint32_t g_next_sym_id = 0;   /* unique id per user symbol (0,1,2,...) */
/* sym_id -> description, for console.log/dir's `Symbol(desc)` rendering of a
   symbol-keyed property. The property key `obj[sym]` stores is TS_KEY_USERSYM(sym_id)
   and the symbol value itself isn't retained on the object, so the inspector needs
   this side table to recover the description. User & registered symbols register
   here; WKSYM keys carry a wksym id and resolve via ts_wksym() instead. Append-only,
   indexed by sym_id (gaps from wksym sym_ids stay undefined, never queried via a
   USERSYM key). GC marks the contents (realloc-safe: we mark values, not slots). */
static tsv* g_sym_desc = NULL;
static uint32_t g_sym_desc_len = 0, g_sym_desc_cap = 0;
static tsv* g_sym_value = NULL;
static uint32_t g_sym_value_len = 0, g_sym_value_cap = 0;
static void sym_desc_register(uint32_t sym_id, tsv desc){
  while (sym_id >= g_sym_desc_cap){ g_sym_desc_cap = g_sym_desc_cap?g_sym_desc_cap*2:16;
    g_sym_desc = realloc(g_sym_desc, sizeof(tsv)*g_sym_desc_cap); }
  while (g_sym_desc_len <= sym_id) g_sym_desc[g_sym_desc_len++] = TS_UNDEFINED;
  g_sym_desc[sym_id] = desc;
}
static tsv sym_desc_by_id(uint32_t sym_id){ return (sym_id < g_sym_desc_len) ? g_sym_desc[sym_id] : TS_UNDEFINED; }
static void sym_value_register(uint32_t sym_id, tsv sym){
  while (sym_id >= g_sym_value_cap){ g_sym_value_cap = g_sym_value_cap?g_sym_value_cap*2:16;
    g_sym_value = realloc(g_sym_value, sizeof(tsv)*g_sym_value_cap); }
  while (g_sym_value_len <= sym_id) g_sym_value[g_sym_value_len++] = TS_UNDEFINED;
  g_sym_value[sym_id] = sym;
}
static tsv sym_value_by_id(uint32_t sym_id){ return (sym_id < g_sym_value_len) ? g_sym_value[sym_id] : TS_UNDEFINED; }
int ts_is_symbol(tsv v){
  return ts_is_obj(v) && ((ts_gc_header*)ts_ptr(v))->kind == TS_KIND_SYMBOL;
}
/* Allocate a fresh symbol with the given description (string or undefined).
   wksym = 0xffffffff (not well-known). */
tsv ts_symbol_new(tsv description){
  ts_gc_root(&description);
  ts_symbol* s = gc_alloc(sizeof(ts_symbol), TS_KIND_SYMBOL);
  s->sym_id = g_next_sym_id++;
  s->wksym = 0xffffffffu;
  s->registered = 0;
  s->description = description;
  tsv symv = ts_obj(s);
  sym_desc_register(s->sym_id, description);
  sym_value_register(s->sym_id, symv);
  ts_gc_unroot(1);
  return symv;
}
tsv ts_symbol_description(tsv sym){
  if (!ts_is_symbol(sym)) return TS_UNDEFINED;
  return ((ts_symbol*)ts_ptr(sym))->description;
}
/* The property key for obj[sym]: well-known symbols map to their WKSYM key (so
   `obj[Symbol.iterator]` and a class `[Symbol.iterator]()` method share a key),
   ordinary symbols to the USERSYM range keyed by sym_id. */
ts_key ts_symbol_key(tsv sym){
  ts_symbol* s = (ts_symbol*)ts_ptr(sym);
  if (s->wksym != 0xffffffffu) return TS_KEY_WKSYM(s->wksym);
  return TS_KEY_USERSYM(s->sym_id);
}
void ts_set_symkey(tsv obj, tsv sym, tsv val){
  if (!ts_is_propbag(obj) || !ts_is_symbol(sym)) return;
  ts_set(obj, ts_symbol_key(sym), val);
}
tsv ts_get_symkey(tsv obj, tsv sym){
  if (!ts_is_propbag(obj) || !ts_is_symbol(sym)) return TS_UNDEFINED;
  return ts_get(obj, ts_symbol_key(sym));
}

/* Well-known symbol singletons (Symbol.iterator etc.). Each is a permanent
   ts_symbol whose wksym field carries its TS_WKSYM_* id, so ts_symbol_key maps it
   to TS_KEY_WKSYM(id) — the same key a class `[Symbol.iterator]()` method is
   registered under, so obj[Symbol.iterator] (value form) and the class/object-
   literal method form share a key. Allocated once, kept as permanent GC roots. */
static tsv g_wksym_singletons[5];
static int g_wksym_inited = 0;
static void ts_wksym_init(void){
  if (g_wksym_inited) return;
  g_wksym_inited = 1;
  static const char* descs[5] = {
    "Symbol.iterator","Symbol.asyncIterator","Symbol.toPrimitive",
    "Symbol.hasInstance","Symbol.toStringTag" };
  for (int i=0;i<5;i++){
    ts_symbol* s = gc_alloc(sizeof(ts_symbol), TS_KIND_SYMBOL);
    s->sym_id = g_next_sym_id++;     /* unique, though key uses wksym */
    s->wksym = (uint32_t)i;
    s->registered = 0;
    g_wksym_singletons[i] = ts_obj(s);
    ts_gc_root(&g_wksym_singletons[i]);   /* permanent root */
    tsv desc = ts_new_string(descs[i], (uint32_t)strlen(descs[i]));
    s = (ts_symbol*)ts_ptr(g_wksym_singletons[i]);
    s->description = desc;
    ts_write_barrier(g_wksym_singletons[i], desc);
  }
}
tsv ts_wksym(uint32_t id){
  if (id >= 5) return TS_UNDEFINED;
  ts_wksym_init();
  return g_wksym_singletons[id];
}

/* Global Symbol registry for Symbol.for(key) / Symbol.keyFor(sym). A small
   open-coded table mapping a string key -> singleton ts_symbol (registered=1).
   Symbol.for returns the same symbol for equal keys (=== holds via pointer
   identity). Symbol.keyFor returns the key for a registered symbol, else
   undefined. Table grows as needed; lookups are linear (registries are tiny). */
typedef struct { tsv key; tsv sym; } ts_symreg_entry;
static ts_symreg_entry* g_symreg = NULL;
static uint32_t g_symreg_len = 0, g_symreg_cap = 0;
tsv ts_symbol_for(tsv key){
  ts_gc_root(&key);
  tsv ks = ts_is_str(key) ? key : ts_to_string_v(key);
  if (!ts_is_str(ks)){ ts_gc_unroot(1); return TS_UNDEFINED; }
  ts_gc_root(&ks);
  ts_strview k = ts_str_view_typed(ks);
  for (uint32_t i=0;i<g_symreg_len;i++){
    ts_strview e = ts_str_view_typed(g_symreg[i].key);
    if (e.len==k.len &&
        (!((e.flags & TS_STR_FLAG_HASHED) && (k.flags & TS_STR_FLAG_HASHED)) || e.hash==k.hash) &&
        ts_str_region_eq(e, 0, k, 0, k.len)){
      ts_gc_unroot(2);
      return g_symreg[i].sym;
    }
  }
  /* not found: create a fresh registered symbol with description = key. */
  ts_symbol* s = gc_alloc(sizeof(ts_symbol), TS_KIND_SYMBOL);
  s->sym_id = g_next_sym_id++;
  s->wksym = 0xffffffffu;
  s->registered = 1;
  s->description = ks;
  tsv symv = ts_obj(s);
  sym_desc_register(s->sym_id, ks);
  sym_value_register(s->sym_id, symv);
  if (g_symreg_len == g_symreg_cap){
    g_symreg_cap = g_symreg_cap ? g_symreg_cap*2 : 8;
    g_symreg = realloc(g_symreg, sizeof(ts_symreg_entry)*g_symreg_cap);
  }
  g_symreg[g_symreg_len].key = ks;
  g_symreg[g_symreg_len].sym = symv;
  g_symreg_len++;
  ts_gc_unroot(2);
  return symv;
}
tsv ts_symbol_key_for(tsv sym){
  if (!ts_is_symbol(sym)) return TS_UNDEFINED;
  for (uint32_t i=0;i<g_symreg_len;i++){
    if (g_symreg[i].sym == sym) return g_symreg[i].key;
  }
  return TS_UNDEFINED;
}
/* sym.toString() -> "Symbol(desc)" (desc empty if undefined). */
tsv ts_symbol_tostring(tsv sym){
  if (!ts_is_symbol(sym)) return ts_new_string("Symbol()", 8);
  ts_symbol* s = (ts_symbol*)ts_ptr(sym);
  const char* d = ""; uint32_t dl = 0;
  if (ts_is_str(s->description)){ ts_strview ds = ts_str_view_typed(s->description); d = ds.data; dl = ds.len; }
  uint32_t n = 8 + dl;   /* "Symbol(" + desc + ")" */
  char* buf = malloc(n+1);
  memcpy(buf, "Symbol(", 7);
  if (dl) memcpy(buf+7, d, dl);
  buf[7+dl] = ')';
  buf[8+dl] = 0;
  tsv r = ts_new_string(buf, 8+dl);
  free(buf);
  return r;
}

tsv ts_typeof(tsv v){
  /* JS typeof. Note: typeof null === "object"; functions -> "function". */
  if (ts_is_num(v))  return ts_new_string("number", 6);
  if (ts_is_str(v))  return ts_new_string("string", 6);
  if (ts_is_bool(v)) return ts_new_string("boolean", 7);
  if (ts_is_undef(v))return ts_new_string("undefined", 9);
  if (ts_is_func(v)) return ts_new_string("function", 8);
  if (ts_is_symbol(v)) return ts_new_string("symbol", 6);
  return ts_new_string("object", 6); /* objects, arrays, null */
}
/* The method key (METHOD_KEY_BASE + name-id) for "toString", learned from the
   emitted ts_setup_object_proto(). 0 = unset (pre-setup / no proto): fall back to
   the built-in behavior. Lets ts_to_string_v invoke a user/overridden toString. */
static uint32_t g_tostring_key = 0;
void ts_set_tostring_key(ts_key key){ g_tostring_key = key; }
static uint32_t g_valueof_key = 0;
void ts_set_valueof_key(ts_key key){ g_valueof_key = key; }
static uint32_t g_tojson_key = 0;
void ts_set_tojson_key(ts_key key){ g_tojson_key = key; }
static uint32_t g_tojson_field = 0;
/* object-literal の valueOf/toString は FIELD キー（ts_intern_field）の
   データプロパティとして格納される。クラス vtable / ビルトイン prototype が使う
   METHOD キー（g_valueof_key/g_tostring_key）とは別空間。初回 ToPrimitive 時に解決。 */
static uint32_t g_valueof_field = 0, g_tostring_field = 0;
static int g_prim_field_ready = 0;
static void ts_prim_field_init(void){
  if (g_prim_field_ready) return;
  g_valueof_field  = ts_intern_field("valueOf", 7);
  g_tostring_field = ts_intern_field("toString", 8);
  g_tojson_field   = ts_intern_field("toJSON", 6);
  g_prim_field_ready = 1;
}
static uint32_t g_rx_k_source = 0xFFFFFFFFu, g_rx_k_flags = 0xFFFFFFFFu;
static uint32_t g_rx_k_prefix = 0xFFFFFFFFu, g_rx_k_global = 0xFFFFFFFFu;
static uint32_t g_rx_k_sticky = 0xFFFFFFFFu, g_rx_k_anchor = 0xFFFFFFFFu;
static uint32_t g_rx_k_last_index = 0xFFFFFFFFu, g_rx_k_flags_mask = 0xFFFFFFFFu;
static void ts_regexp_ensure_keys(void){
  if (g_rx_k_prefix != 0xFFFFFFFFu) return;
  g_rx_k_source = ts_intern_field("source", 6);
  g_rx_k_flags = ts_intern_field("flags", 5);
  g_rx_k_prefix = ts_intern_field("__tsaot_rx_prefix", 17);
  g_rx_k_global = ts_intern_field("__tsaot_rx_global", 17);
  g_rx_k_sticky = ts_intern_field("__tsaot_rx_sticky", 17);
  g_rx_k_anchor = ts_intern_field("__tsaot_rx_anchor", 17);
  g_rx_k_last_index = ts_intern_field("lastIndex", 9);
  g_rx_k_flags_mask = ts_intern_field("__tsaot_rx_flags_mask", 21);
}
static int ts_regexp_is_fast_obj(tsv re){
  if (!ts_is_propbag(re)) return 0;
  ts_regexp_ensure_keys();
  return ts_is_str(ts_get(re, g_rx_k_source)) &&
         ts_is_str(ts_get(re, g_rx_k_flags)) &&
         (ts_is_str(ts_get(re, g_rx_k_prefix)) || ts_is_num(ts_get(re, g_rx_k_flags_mask)));
}
int ts_regexp_is_object(tsv re){
  return ts_regexp_is_fast_obj(re);
}
void ts_regexp_proto_init(void){
  if (ts_proto_ref(g_regexp_proto_v)) return;
  static int rooted = 0;
  g_regexp_proto_v = ts_new_proto();
  ts_root_static_once(&g_regexp_proto_v, &rooted);
  ((ts_object*)ts_ptr(g_regexp_proto_v))->proto = g_object_proto_v;
}
tsv ts_regexp_proto(void){
  return ts_proto_ref(g_regexp_proto_v) ? g_regexp_proto_v : TS_NULL;
}
void ts_regexp_proto_register(ts_key method_key, const char* name, ts_code fn){
  if (!ts_proto_ref(g_regexp_proto_v)) ts_regexp_proto_init();
  ts_proto_register_method(g_regexp_proto_v, method_key, name, fn);
}
tsv ts_regexp_object_init(tsv re){
  if (ts_is_propbag(re)){
    if (!ts_proto_ref(g_regexp_proto_v)) ts_regexp_proto_init();
    ((ts_object*)ts_ptr(re))->proto = g_regexp_proto_v;
    ts_write_barrier(re, g_regexp_proto_v);
  }
  return re;
}
static tsv ts_regexp_to_string_fast(tsv re){
  if (!ts_is_propbag(re)) return TS_UNDEFINED;
  ts_gc_root(&re);
  ts_regexp_ensure_keys();
  tsv source = ts_get(re, g_rx_k_source);
  ts_gc_root(&source);
  tsv flags = ts_get(re, g_rx_k_flags);
  ts_gc_root(&flags);
  if (!ts_is_str(source) || !ts_is_str(flags)){
    ts_gc_unroot(3);
    return TS_UNDEFINED;
  }
  tsv slash = ts_new_string("/", 1);
  ts_gc_root(&slash);
  tsv parts[4] = { slash, source, slash, flags };
  tsv out = ts_str_concat_many(parts, 4);
  ts_gc_unroot(4);
  return out;
}
/* ToPrimitive 用に callable な valueOf/toString を取得。own のデータプロパティ
   （FIELD キー）が prototype/ビルトインのメソッド（METHOD キー）をシャドウする。 */
static tsv ts_prim_method(tsv v, uint32_t field_key, uint32_t method_key){
  tsv m = ts_get(v, field_key);
  if (ts_is_callable(m)) return m;
  if (method_key){ m = ts_get(v, method_key); if (ts_is_callable(m)) return m; }
  return TS_UNDEFINED;
}
/* ToPrimitive(input, hint) — ECMA-262 7.1.1. hint: 0=number, 1=string, 2=default.
   Order: obj[Symbol.toPrimitive](hintStr) if present; else for number/default
   valueOf()->toString(), for string toString()->valueOf(). Returns a primitive
   (non-object) tsv, or the input unchanged if it is already primitive. */
tsv ts_to_primitive(tsv v, int hint){
  if (!ts_object_like(v) || ts_is_symbol(v)) return v;  /* already primitive (or symbol); a class value coerces like an object */
  ts_gc_root(&v);
  /* 1. Symbol.toPrimitive */
  tsv sp = ts_get(v, TS_KEY_WKSYM(TS_WKSYM_TO_PRIMITIVE));
  if (ts_is_callable(sp)){
    ts_gc_root(&sp);
    const char* h = hint==1 ? "string" : (hint==0 ? "number" : "default");
    tsv hs = ts_new_string(h, (uint32_t)strlen(h));
    ts_gc_root(&hs);
    tsv args[2]; args[0]=v; args[1]=hs;
    tsv r = ts_call(sp, args, 2);
    ts_gc_unroot(3);
    return (ts_is_obj(r) && !ts_is_symbol(r)) ? ts_num(NAN) : r; /* spec: must be primitive */
  }
  /* 2. ordered valueOf / toString. string hint -> toString first; number/default
     -> valueOf first. own object-literal method (FIELD key) shadows the
     prototype/builtin method (METHOD key). */
  ts_prim_field_init();
  uint32_t mfirst  = (hint==1) ? g_tostring_key   : g_valueof_key;
  uint32_t msecond = (hint==1) ? g_valueof_key    : g_tostring_key;
  uint32_t ffirst  = (hint==1) ? g_tostring_field : g_valueof_field;
  uint32_t fsecond = (hint==1) ? g_valueof_field  : g_tostring_field;
  for (int i=0;i<2;i++){
    tsv m = ts_prim_method(v, i==0?ffirst:fsecond, i==0?mfirst:msecond);
    if (ts_is_callable(m)){
      ts_gc_root(&m);
      tsv r = ts_call(m, &v, 1);   /* this = v */
      ts_gc_unroot(1);
      if (!ts_is_obj(r) || ts_is_symbol(r)){ ts_gc_unroot(1); return r; }
    }
  }
  ts_gc_unroot(1);
  return v;  /* no usable conversion; callers handle (NaN / [object Object]) */
}

tsv ts_to_string_v(tsv v){
  if (ts_is_str(v)) return v;
  char buf[32];
  if (ts_is_num(v)){ double d=ts_to_num(v); ts_fmt_num(d,buf,sizeof buf); return ts_new_string(buf,(uint32_t)strlen(buf)); }
  if (ts_is_bool(v)) return ts_new_string((v&1)?"true":"false",(v&1)?4:5);
  if (ts_is_undef(v)) return ts_new_string("undefined",9);
  if (ts_is_null(v)) return ts_new_string("null",4);
  if (ts_is_array(v)){
    ts_gc_root(&v);
    tsv sep = ts_new_string(",",1);
    ts_gc_root(&sep);
    tsv r = ts_array_join(v, sep);  /* [1,2] -> "1,2" */
    ts_gc_unroot(2);
    return r;
  }
  /* plain object / class instance: ToPrimitive(string) — Symbol.toPrimitive
     ("string") if present, else toString()/valueOf() (own override shadows the
     Object.prototype default). ts_to_primitive resolves both FIELD-key
     object-literal methods and METHOD-key prototype/builtin methods. */
  if (ts_object_like(v) && !ts_is_symbol(v)){
    ts_gc_root(&v);
    tsv p = ts_to_primitive(v, /*string_hint*/1);
    ts_gc_root(&p);
    if (!ts_is_obj(p)){
      tsv r = ts_to_string_v(p);   /* primitive を再帰整形 */
      ts_gc_unroot(2);
      return r;
    }
    ts_gc_unroot(2);
  }
  return ts_new_string("[object Object]",15);
}

/* ---------------- operators ---------------- */
tsv ts_add(tsv a, tsv b){
  if (ts_is_num(a)&&ts_is_num(b)) return ts_num(ts_to_num(a)+ts_to_num(b));
  /* JS `+`: ToPrimitive(default) each operand first. An object becomes its
     valueOf()/toString()/Symbol.toPrimitive("default") result, so `o + 5` and
     `o + ""` follow spec instead of silently yielding 0. */
  if ((ts_object_like(a)&&!ts_is_symbol(a)) || (ts_object_like(b)&&!ts_is_symbol(b))){
    ts_gc_root(&a); ts_gc_root(&b);
    tsv pa = ts_to_primitive(a, 2);  /* hint: default */
    tsv pb = ts_to_primitive(b, 2);
    ts_gc_unroot(2);
    /* avoid infinite recursion if ToPrimitive returned an object (shouldn't) */
    if (!ts_is_obj(pa) || !ts_is_obj(pb) || pa!=a || pb!=b) return ts_add(pa, pb);
  }
  if (ts_is_str(a)||ts_is_str(b)){
    ts_gc_root(&a); ts_gc_root(&b);
    tsv sa=ts_to_string_v(a);
    ts_gc_root(&sa);
    tsv sb=ts_to_string_v(b);
    ts_gc_root(&sb);
    ts_strview x=ts_str_view_typed(sa), y=ts_str_view_typed(sb);
    uint32_t n=x.len+y.len;
    uint32_t flags = (x.flags | y.flags) & TS_STR_FLAG_UTF16;
    RT_STAT_INC(concat_calls); RT_STAT_ADD(concat_bytes, n);
    ts_string* out = ts_string_alloc_storage(n, flags);
    x=ts_str_view_typed(sa); y=ts_str_view_typed(sb);
    ts_str_copy_units(out->data, flags, 0, x, 0, x.len);
    ts_str_copy_units(out->data, flags, x.len, y, 0, y.len);
    out->flags = strflags_storage(out->data, flags, n);
    out->hash = strhash_units(out->data, out->flags, n);
    tsv r=ts_str_v(out); ts_gc_unroot(4); return r;
  }
  if (ts_is_num(a)&&ts_is_num(b)) return ts_num(ts_to_num(a)+ts_to_num(b));
  /* mixed primitives (bool/null/undef): numeric add via coercion */
  if (!ts_is_obj(a) && !ts_is_obj(b)) return ts_num(ts_number_coerce(a)+ts_number_coerce(b));
  return ts_num(0);
}
tsv ts_str_concat_many(tsv* args, int n){
  if (n <= 0) return ts_new_string("",0);
  int first_string_pair = n == 1 || ts_is_str(args[0]) || ts_is_str(args[1]);
  for(int i=0;i<n;i++){
    if (ts_object_like(args[i]) && !ts_is_symbol(args[i])) first_string_pair = 0;
  }
  if (!first_string_pair){
    tsv r = args[0];
    for(int i=1;i<n;i++) r = ts_add(r, args[i]);
    return r;
  }

  tsv* parts = (tsv*)malloc(sizeof(tsv) * (size_t)n);
  int rooted = 0;
  uint64_t total = 0;
  uint32_t out_flags = 0;
  for(int i=0;i<n;i++){
    parts[i] = args[i];
    ts_gc_root(&parts[i]);
    rooted++;
    if (!ts_is_str(parts[i])) parts[i] = ts_to_string_v(parts[i]);
    ts_strview v = ts_str_view_typed(parts[i]);
    total += v.len;
    out_flags |= v.flags & TS_STR_FLAG_UTF16;
    if(total > UINT32_MAX){
      ts_gc_unroot(rooted);
      free(parts);
      fprintf(stderr, "tsaot: RangeError: concatenated string too large\n");
      abort();
    }
  }
  if(total == 0){
    ts_gc_unroot(rooted);
    free(parts);
    return ts_new_string("",0);
  }

  RT_STAT_INC(concat_calls); RT_STAT_ADD(concat_bytes, total);
  ts_string* out = ts_string_alloc_storage((uint32_t)total, out_flags);
  uint32_t pos = 0;
  for(int i=0;i<n;i++){
    ts_strview v = ts_str_view_typed(parts[i]);
    ts_str_copy_units(out->data, out_flags, pos, v, 0, v.len);
    pos += v.len;
  }
  out->len = (uint32_t)total;
  out->flags = strflags_storage(out->data, out_flags, out->len);
  out->hash = strhash_units(out->data, out->flags, out->len);
  out->parent = TS_UNDEFINED;
  out->offset = 0;
  tsv r = ts_str_v(out);
  ts_gc_unroot(rooted);
  free(parts);
  return r;
}
int ts_strict_eq(tsv a, tsv b){
  if (ts_is_num(a)&&ts_is_num(b)) return ts_to_num(a)==ts_to_num(b);
  if (ts_is_str(a)&&ts_is_str(b)){
    ts_strview x=ts_str_view_typed(a), y=ts_str_view_typed(b);
    if (x.len!=y.len) return 0;
    if ((x.flags & TS_STR_FLAG_HASHED) && (y.flags & TS_STR_FLAG_HASHED) && x.hash!=y.hash) return 0;
    return ts_str_region_eq(x, 0, y, 0, x.len);
  }
  return a==b;
}
/* JS relational comparison (< <= > >=). op: 0='<',1='<=',2='>',3='>='. Per spec
   (Abstract Relational Comparison): if both operands ToPrimitive to strings,
   compare lexicographically; otherwise compare ToNumber values (NaN -> false). */
int ts_relational(tsv a, tsv b, int op){
  ts_gc_root(&a); ts_gc_root(&b);
  tsv pa = (ts_object_like(a)&&!ts_is_symbol(a)) ? ts_to_primitive(a,0) : a;
  tsv pb = (ts_object_like(b)&&!ts_is_symbol(b)) ? ts_to_primitive(b,0) : b;
  ts_gc_unroot(2);
  if (ts_is_str(pa) && ts_is_str(pb)){
    ts_strview x=ts_str_view_typed(pa), y=ts_str_view_typed(pb);
    uint32_t m = x.len<y.len ? x.len : y.len;
    int c = 0;
    for(uint32_t i=0;i<m;i++){
      uint16_t xc=ts_str_cu_at_view(x,i), yc=ts_str_cu_at_view(y,i);
      if (xc != yc){ c = xc < yc ? -1 : 1; break; }
    }
    if (c==0) c = (x.len<y.len)?-1:(x.len>y.len?1:0);
    switch(op){ case 0: return c<0; case 1: return c<=0; case 2: return c>0; default: return c>=0; }
  }
  double na = ts_number_coerce(pa), nb = ts_number_coerce(pb);
  if (na!=na || nb!=nb) return 0; /* NaN -> all relational false */
  switch(op){ case 0: return na<nb; case 1: return na<=nb; case 2: return na>nb; default: return na>=nb; }
}
/* JS loose equality (== / !=) for the cases strict-eq misses: null == undefined,
   number == string (coerce string), bool == x (coerce bool to number), etc.
   Returns 1/0 for `==`. */
int ts_loose_eq(tsv a, tsv b){
  if (ts_strict_eq(a,b)) return 1;
  int an = ts_is_null(a)||ts_is_undef(a), bn = ts_is_null(b)||ts_is_undef(b);
  if (an && bn) return 1;            /* null == undefined */
  if (an || bn) return 0;            /* null/undefined != anything else */
  /* bool -> number, then re-compare */
  if (ts_is_bool(a)) return ts_loose_eq(ts_num((double)(a&1)), b);
  if (ts_is_bool(b)) return ts_loose_eq(a, ts_num((double)(b&1)));
  /* number <-> string: coerce string to number */
  if (ts_is_num(a) && ts_is_str(b)) return ts_to_num(a)==ts_number_coerce(b);
  if (ts_is_str(a) && ts_is_num(b)) return ts_number_coerce(a)==ts_to_num(b);
  /* object <-> primitive: ToPrimitive(object) then re-compare */
  if ((ts_object_like(a)&&!ts_is_symbol(a)) && (ts_is_num(b)||ts_is_str(b))){ ts_gc_root(&b); tsv p=ts_to_primitive(a,0); ts_gc_unroot(1); return ts_loose_eq(p,b); }
  if ((ts_object_like(b)&&!ts_is_symbol(b)) && (ts_is_num(a)||ts_is_str(a))){ ts_gc_root(&a); tsv p=ts_to_primitive(b,0); ts_gc_unroot(1); return ts_loose_eq(a,p); }
  return 0;
}
/* Object.is(a,b): SameValue. Like ===, except NaN equals NaN and +0 != -0. */
int ts_object_is(tsv a, tsv b){
  if (ts_is_num(a) && ts_is_num(b)){
    double x=ts_to_num(a), y=ts_to_num(b);
    if (x!=x && y!=y) return 1;
    if (x==0.0 && y==0.0) return signbit(x)==signbit(y);
    return x==y;
  }
  return ts_strict_eq(a,b);
}
int ts_truthy(tsv v){
  if (ts_is_num(v)){ double d=ts_to_num(v); return d!=0 && !(d!=d); }
  if (ts_is_bool(v)) return (int)(v&1);
  if (ts_is_undef(v)||ts_is_null(v)) return 0;
  if (ts_is_str(v)) return ts_str_len_typed(v)!=0;
  return 1;
}
/* forward decl: structural inspection (defined after the jbuf/json helpers). */
static void ts_inspect_to(FILE* out, tsv v);

/* ---- console.log colorization (Node util.inspect palette) ----
   Node styles console.log values with ANSI codes ONLY when the destination stream
   is a TTY (and NO_COLOR is unset). Only leaf values are styled — structural
   punctuation, property keys, and the constructor-name tag are left uncolored.
   `g_inspect_color` is set per-call by the console entry points below. */
static int g_inspect_color = 0;
#define TSC_NUM     "\x1b[33m"   /* number / boolean: yellow */
#define TSC_STR     "\x1b[32m"   /* string / symbol: green */
#define TSC_UNDEF   "\x1b[90m"   /* undefined: grey */
#define TSC_FN      "\x1b[36m"   /* function / class: cyan (special) */
#define TSC_BOLD    "\x1b[1m"    /* null: bold */
#define TSC_FGOFF   "\x1b[39m"   /* reset foreground color */
#define TSC_BOLDOFF "\x1b[22m"   /* reset bold */
static int ts_stream_wants_color(FILE* out){
  int fd = fileno(out);
  if (fd < 0 || !isatty(fd)) return 0;
  if (getenv("NO_COLOR")) return 0;   /* https://no-color.org */
  return 1;
}

/* print one value (no trailing newline) to the given stream, in console.log
   formatting (numbers via ts_fmt_num, strings raw, booleans true/false, etc).
   Objects/arrays/maps/sets are shown structurally (Node-ish), like console.log. */
static void ts_print_to(FILE* out, tsv v){
  /* console.log shows negative zero as "-0" (Node util.inspect); String(-0) stays
     "0" via ts_fmt_num, so the -0 case is handled here, not in ts_fmt_num. */
  /* Top-level scalars are colorized like Node's console.log EXCEPT strings: a
     string argument is printed raw and uncolored (Node's format() string path). */
  if (ts_is_num(v)){
    if (g_inspect_color) fputs(TSC_NUM, out);
    double d=ts_to_num(v);
    if (d==0.0 && signbit(d)) fputs("-0", out);
    else { char b[40]; ts_fmt_num(d,b,sizeof b); fputs(b, out); }
    if (g_inspect_color) fputs(TSC_FGOFF, out);
  }
  else if (ts_is_str(v)){
    ts_strview sv=ts_str_view_typed(v);
    uint32_t n=0; char* u=ts_str_utf8_copy_view(sv, &n);
    fwrite(u, 1, n, out);
    free(u);
  }
  else if (ts_is_bool(v)){ if(g_inspect_color)fputs(TSC_NUM,out); fputs((v&1)?"true":"false",out); if(g_inspect_color)fputs(TSC_FGOFF,out); }
  else if (ts_is_undef(v)){ if(g_inspect_color)fputs(TSC_UNDEF,out); fputs("undefined",out); if(g_inspect_color)fputs(TSC_FGOFF,out); }
  else if (ts_is_null(v)){ if(g_inspect_color)fputs(TSC_BOLD,out); fputs("null",out); if(g_inspect_color)fputs(TSC_BOLDOFF,out); }
  else ts_inspect_to(out, v);   /* arrays/objects/maps/sets/functions */
}

void ts_print(tsv v){ g_inspect_color = ts_stream_wants_color(stdout); ts_print_to(stdout, v); fputc('\n', stdout); }

/* console.log / .info / .debug -> stdout; .warn / .error -> stderr. Multiple
   arguments are printed space-separated with a single trailing newline, matching
   the JS console family. */
static void ts_console_to(FILE* out, tsv* args, int n){
  g_inspect_color = ts_stream_wants_color(out);
  for (int i=0;i<n;i++){ if (i) fputc(' ', out); ts_print_to(out, args[i]); }
  fputc('\n', out);
}
void ts_console_log(tsv* args, int n){ ts_console_to(stdout, args, n); }
void ts_console_err(tsv* args, int n){ ts_console_to(stderr, args, n); }

/* Host I/O primitive (self-hosting): read ALL of stdin (until EOF) as one
   UTF-8 string. The native analyzer reads its program JSON this way. */
tsv ts_read_stdin(void){
  size_t cap = 1u << 16, len = 0;
  char* buf = (char*)malloc(cap);
  if (!buf) return ts_new_string("", 0);
  for (;;){
    size_t n = fread(buf + len, 1, cap - len, stdin);
    len += n;
    if (n == 0) break;
    if (len == cap){
      cap *= 2;
      char* nb = (char*)realloc(buf, cap);
      if (!nb){ free(buf); return ts_new_string("", 0); }
      buf = nb;
    }
  }
  tsv s = ts_new_string(buf, (uint32_t)len);
  free(buf);
  return s;
}

/* ---------------- mark/sweep ---------------- */
static void gc_scan_cell(ts_gc_header* h, int young, int depth);
static void gc_scan_async_cell(ts_gc_header* h, int young, int depth);
static void gc_mark_async_roots(void);
static void gc_mark_async_roots_young(void);
static void gc_free_cell(ts_gc_header* h);
static void gc_mark_class_fields(ts_object* o, int young, int depth);

/* ---- worklist marking (gc_moving_plan Phase A) ----
   The marker is an explicit stack, not recursion: deep pointer chains (a 10^5
   node linked list is legal JS) overflow the C stack in a recursive scanner.
   Cells are marked when PUSHED, so each cell enters the stack at most once per
   collection; the drain loop pops and scans fields. NONHEAP cells (stack/SROA
   objects, interned strings) are not on any sweep list, so the cells whose mark
   bit we set are recorded and cleared at the end of the collection. */
static ts_gc_header** g_markstack = NULL;
static size_t g_markstack_len = 0, g_markstack_cap = 0;
static ts_gc_header** g_marked_nonheap = NULL;
static size_t g_marked_nonheap_len = 0, g_marked_nonheap_cap = 0;
static void gc_markstack_push(ts_gc_header* h){
  if (g_markstack_len == g_markstack_cap){
    size_t next = g_markstack_cap ? g_markstack_cap * 2 : 8192;
    ts_gc_header** grown = (ts_gc_header**)realloc(g_markstack, sizeof(ts_gc_header*) * next);
    if (!grown) ts_abort_msg("out of memory growing GC mark stack");
    g_markstack = grown; g_markstack_cap = next;
  }
  g_markstack[g_markstack_len++] = h;
#ifdef TSAOT_RT_STATS
  if (g_markstack_len > g_rt_stats.mark_stack_peak) g_rt_stats.mark_stack_peak = g_markstack_len;
#endif
}
static void gc_marked_nonheap_push(ts_gc_header* h){
  if (g_marked_nonheap_len == g_marked_nonheap_cap){
    size_t next = g_marked_nonheap_cap ? g_marked_nonheap_cap * 2 : 256;
    ts_gc_header** grown = (ts_gc_header**)realloc(g_marked_nonheap, sizeof(ts_gc_header*) * next);
    if (!grown) ts_abort_msg("out of memory growing GC visited list");
    g_marked_nonheap = grown; g_marked_nonheap_cap = next;
  }
  g_marked_nonheap[g_marked_nonheap_len++] = h;
}
static void gc_clear_nonheap_marks(void){
  for (size_t i=0;i<g_marked_nonheap_len;i++) g_marked_nonheap[i]->mark = 0;
  g_marked_nonheap_len = 0;
}
/* Mark one value and visit its refs. young=1 keeps the minor-GC boundary: OLD
   cells are not entered (the remembered set covers old→young edges). NONHEAP
   cells can hold heap refs, so they are scanned in both modes and dedup through
   the same mark bit (recorded for the end-of-collection clear).
   Traversal is hybrid: recurse while depth < TS_GC_MARK_DEPTH_MAX (the freshly
   marked header is still cache-hot), spill deeper cells to the explicit mark
   stack. Bounds C-stack use to ~depth×frame while keeping the recursive
   scanner's locality (pure worklist cost gc_survivors ~8% in the A/B). */
#define TS_GC_MARK_DEPTH_MAX 256
static void gc_mark_visit_slow(ts_gc_header* h, int young, int depth){
  if (h->gen == TS_GEN_YOUNG){
    h->mark = 1;
  } else if (h->gen == TS_GEN_OLD){
    if (young) return; /* minor boundary */
    h->mark = 1;
  } else { /* stack/SROA or interned (NONHEAP) */
    h->mark = 1; gc_marked_nonheap_push(h);
  }
  if (depth < TS_GC_MARK_DEPTH_MAX) gc_scan_cell(h, young, depth + 1);
  else gc_markstack_push(h);
}
/* Per-edge fast filter stays inline (bit test + header loads); the mark+scan
   goes through the outlined slow path so the scan loops stay compact. */
static inline void gc_mark_visit(tsv v, int young, int depth){
  if (!ts_heap_ref(v)) return;
  ts_gc_header* h = ts_heap_ptr(v);
  if (!h || h->mark) return;
  gc_mark_visit_slow(h, young, depth);
}
static inline void gc_mark_value(tsv v){ gc_mark_visit(v, 0, 0); }
static inline void gc_mark_value_young(tsv v){ gc_mark_visit(v, 1, 0); }
static void gc_mark_drain(int young){
  while (g_markstack_len){
    ts_gc_header* h = g_markstack[--g_markstack_len];
    gc_scan_cell(h, young, 0);
  }
}
static void gc_scan_cell(ts_gc_header* h, int young, int depth){
  if (!h) return;
  if (h->kind==TS_KIND_OBJECT){ ts_object* o=(ts_object*)h;
    gc_mark_class_fields(o, young, depth);
    for (uint32_t i=0;i<o->len;i++) gc_mark_visit(o->props[i].val, young, depth);
    gc_mark_visit(o->proto, young, depth);
  } else if (h->kind==TS_KIND_ACCESSOR){ ts_accessor* ac=(ts_accessor*)h;
    gc_mark_visit(ac->getter, young, depth);
    gc_mark_visit(ac->setter, young, depth);
  } else if (h->kind==TS_KIND_SYMBOL){ ts_symbol* sy=(ts_symbol*)h;
    gc_mark_visit(sy->description, young, depth);
  } else if (h->kind==TS_KIND_STRING){ ts_string* s=(ts_string*)h;
    if (s->flags & TS_STR_FLAG_VIEW) gc_mark_visit(s->parent, young, depth);
  } else if (h->kind==TS_KIND_FUNC){ ts_func* f=(ts_func*)h;
    for (uint32_t i=0;i<f->envlen;i++) gc_mark_visit(f->env[i], young, depth);
    for (uint32_t i=0;i<f->o.len;i++) gc_mark_visit(f->o.props[i].val, young, depth);
    gc_mark_visit(f->prototype_prop, young, depth);
    gc_mark_visit(f->o.proto, young, depth);
  } else if (h->kind==TS_KIND_ARRAY){ ts_array* a=(ts_array*)h;
    for (uint32_t i=0;i<a->len;i++) gc_mark_visit(a->data[i], young, depth);
    /* unified model: also mark the common header's named-property map + proto. */
    for (uint32_t i=0;i<a->o.len;i++) gc_mark_visit(a->o.props[i].val, young, depth);
    gc_mark_visit(a->o.proto, young, depth);
  } else if (h->kind==TS_KIND_MAP){ ts_map* m=(ts_map*)h;
    for (uint32_t i=0;i<m->len;i++){
      gc_mark_visit(m->keys[i], young, depth);
      gc_mark_visit(m->vals[i], young, depth);
    }
    for (uint32_t i=0;i<m->o.len;i++) gc_mark_visit(m->o.props[i].val, young, depth);
    gc_mark_visit(m->o.proto, young, depth);
  } else if (h->kind==TS_KIND_SET){ ts_set_t* st=(ts_set_t*)h;
    for (uint32_t i=0;i<st->len;i++) gc_mark_visit(st->elems[i], young, depth);
    for (uint32_t i=0;i<st->o.len;i++) gc_mark_visit(st->o.props[i].val, young, depth);
    gc_mark_visit(st->o.proto, young, depth);
  } else if (h->kind==TS_KIND_PROXY){ ts_proxy* px=(ts_proxy*)h;
    gc_mark_visit(px->target, young, depth); gc_mark_visit(px->handler, young, depth);
  } else if (h->kind==TS_KIND_PROMISE || h->kind==TS_KIND_CORO){
    gc_scan_async_cell(h, young, depth);
  }
}
/* Free a cell's handle + external payload buffers but not the cell body —
   the body of an arena (nursery) cell belongs to its chunk and is reclaimed
   by the post-sweep bump reset. Every dying cell passes through here (unpooled
   and old cells via gc_free_cell), so this is the single live-bytes
   decrement point balancing gc_alloc's increment. */
static void gc_free_cell_payload(ts_gc_header* h){
  g_heap_bytes -= (g_heap_bytes >= h->size) ? h->size : g_heap_bytes;
  gc_handle_free(h);
  if (h->kind==TS_KIND_OBJECT) free(((ts_object*)h)->props);
  else if (h->kind==TS_KIND_ARRAY){ array_free_data((ts_array*)h); free(((ts_array*)h)->o.props); }
  else if (h->kind==TS_KIND_FUNC){ free(((ts_func*)h)->env); free(((ts_func*)h)->o.props); }
  else if (h->kind==TS_KIND_MAP){ ts_map* m=(ts_map*)h; free(m->keys); free(m->vals); free(m->index); free(m->o.props); }
  else if (h->kind==TS_KIND_SET){ ts_set_t* s=(ts_set_t*)h; free(s->elems); free(s->index); free(s->o.props); }
  else if (h->kind==TS_KIND_PROMISE){ free(((ts_promise*)h)->waiters); }
}
static void gc_free_cell(ts_gc_header* h){
  gc_free_cell_payload(h);
  if (g_gc_zap && h->size) memset(h, 0xDD, h->size);
  free(h);
}
static int gc_moving_minor_enabled(void){
  static int enabled = -1;
  if (enabled < 0){
    const char* off = getenv("TSAOT_DISABLE_MOVING_MINOR");
    enabled = !(off && off[0] && strcmp(off, "0") != 0);
  }
  return enabled;
}
static int gc_move_coro_enabled(void){
  static int enabled = -1;
  if (enabled < 0){
    const char* flag = getenv("TSAOT_GC_MOVE_CORO");
    enabled = !(flag && flag[0] && strcmp(flag, "0") == 0);
  }
  return enabled;
}
static int gc_move_promise_enabled(void){
  static int enabled = -1;
  if (enabled < 0){
    const char* flag = getenv("TSAOT_GC_MOVE_PROMISE");
    enabled = !(flag && flag[0] && strcmp(flag, "0") == 0);
  }
  return enabled;
}
static int gc_is_movable_kind(uint8_t kind){
  /* Moving minor boundary:
     - movable: ordinary JS heap values whose public identity is the stable tsv
       handle (object/string/function/array/map/set/accessor/symbol). Heap fields
       store handles, and runtime code must re-fetch raw pointers after safepoints.
     - Promise/Coro are movable by default when unpinned. Their stored edges are
       handles and are scanned normally; active raw ts_promise/ts_coro pointers are
       protected by pinning or by immediate handle re-fetch after safepoints.
     - fallback: TSAOT_GC_MOVE_CORO=0 or TSAOT_GC_MOVE_PROMISE=0 keeps that kind
       non-moving for targeted debugging.
     - pinned cells: even if a kind is movable, a temporarily pinned cell is
       promoted in place for this collection because a raw pointer is active. */
  return kind==TS_KIND_OBJECT || kind==TS_KIND_STRING || kind==TS_KIND_FUNC ||
         kind==TS_KIND_ARRAY || kind==TS_KIND_MAP || kind==TS_KIND_SET ||
         kind==TS_KIND_ACCESSOR || kind==TS_KIND_SYMBOL;
}
static int gc_is_movable_cell(ts_gc_header* h){
  if (!h || h->pin_depth != 0) return 0;
  if (gc_is_movable_kind(h->kind)) return 1;
  if (h->kind == TS_KIND_PROMISE) return gc_move_promise_enabled();
  return h->kind == TS_KIND_CORO && gc_move_coro_enabled();
}
static void gc_handle_move(ts_gc_header* old, ts_gc_header* nw){
  uint64_t payload = old->handle;
  nw->handle = payload;
  if (payload & 1u){
    uint32_t id = (uint32_t)(payload >> 1);
    if (id < g_handle_cap) g_ts_handle_table[id] = nw;
  } else {
    nw->handle = gc_handle_alloc(nw);
  }
  old->handle = 0;
}
static void gc_fix_moved_cell(ts_gc_header* old, ts_gc_header* nw){
  if (old->kind == TS_KIND_ARRAY){
    ts_array* oa = (ts_array*)old;
    ts_array* na = (ts_array*)nw;
    if (oa->data == oa->inline_data) na->data = na->inline_data;
  }
}
static ts_gc_header* gc_move_young_to_old_ex(ts_gc_header* h, int free_old){
  size_t sz = h->size;
  if (sz == 0){
    if (h->kind == TS_KIND_STRING){
      ts_string* s = (ts_string*)h;
      sz = sizeof(ts_string) + ((s->flags & TS_STR_FLAG_VIEW) ? 1 : s->len + 1);
    }
    else if (h->kind == TS_KIND_OBJECT) sz = sizeof(ts_object);
    else if (h->kind == TS_KIND_FUNC) sz = sizeof(ts_func);
    else if (h->kind == TS_KIND_ARRAY) sz = sizeof(ts_array);
    else if (h->kind == TS_KIND_MAP) sz = sizeof(ts_map);
    else if (h->kind == TS_KIND_SET) sz = sizeof(ts_set_t);
    else if (h->kind == TS_KIND_ACCESSOR) sz = sizeof(ts_accessor);
    else if (h->kind == TS_KIND_SYMBOL) sz = sizeof(ts_symbol);
  }
  ts_gc_header* nw = (ts_gc_header*)malloc(sz);
  memcpy(nw, h, sz);
  nw->mark = 0;
  nw->gen = TS_GEN_OLD;
  nw->remembered = 0;
  nw->pin_depth = 0;
  nw->size = sz;
  nw->gc_next = NULL;
  gc_fix_moved_cell(h, nw);
  gc_handle_move(h, nw);
  /* external buffers were transferred by the shallow copy. An arena cell's
     body is chunk memory (free_old=0): it dies with the bump reset. */
  if (g_gc_zap) memset(h, 0xDD, sz); /* poison the moved-from body (C0 detector) */
  if (free_old) free(h);
  return nw;
}
static ts_gc_header* gc_move_young_to_old(ts_gc_header* h){
  return gc_move_young_to_old_ex(h, 1);
}
/* Sweep one side of the nursery after marking: evacuate marked cells to the
   old gen, payload-free the dead, divert pinned survivors to g_pinned_young
   and their chunk to the retained list. Shared by minor and full collections
   (arena cells are always YOUNG, and both collections mark them the same
   way), so the "leave by copy or die" rule has a single implementation. */
static void gc_sweep_nursery(ts_gc_header** survivors){
  gc_chunk* next = NULL;
  for (gc_chunk* c = g_nursery_active; c; c = next){
    next = c->next;
    char* data = (char*)c + GC_NURSERY_DATA_OFF;
    size_t off = 0;
    uint32_t pinned_here = 0;
    while (off < c->used){
      ts_gc_header* h = (ts_gc_header*)(data + off);
      size_t step = (h->size + 15u) & ~(size_t)15u;
      if (h->mark){
        if (h->pin_depth){
          /* raw pointer active: cannot move, cannot promote in place. Track
             on the pinned list; the chunk is retained below. */
          h->mark = 0;
          h->gc_next = g_pinned_young; g_pinned_young = h;
          pinned_here++;
        } else {
          ts_gc_header* nw = gc_move_young_to_old_ex(h, 0);
          nw->gc_next = *survivors; *survivors = nw;
          g_young_alloc--; g_old_alloc++;
        }
      } else {
        gc_free_cell_payload(h);
        if (g_gc_zap) memset(h, 0xDD, h->size);
        g_young_alloc--; g_alloc--;
      }
      off += step;
    }
    if (pinned_here){
      c->pinned_live = pinned_here;
      c->next = g_nursery_retained; g_nursery_retained = c;
      RT_STAT_INC(retained_chunks);
    } else {
      c->used = 0;
      c->next = g_nursery_free; g_nursery_free = c;
    }
  }
  g_nursery_active = NULL;
  g_nursery_used_bytes = 0;
}
/* Re-examine pinned survivors from earlier collections (they live in retained
   chunks and stayed YOUNG): evacuate the ones whose pin was released, free the
   dead, keep the still-pinned. Retained chunks with no pinned survivors left
   return to the free pool. */
static void gc_sweep_pinned_young(ts_gc_header** survivors){
  ts_gc_header* h = g_pinned_young;
  g_pinned_young = NULL;
  while (h){
    ts_gc_header* next = h->gc_next;
    gc_chunk* c = (gc_chunk*)((uintptr_t)h & ~(uintptr_t)(GC_NURSERY_CHUNK_BYTES - 1u));
    if (h->mark){
      if (h->pin_depth){
        h->mark = 0;
        h->gc_next = g_pinned_young; g_pinned_young = h;
      } else {
        ts_gc_header* nw = gc_move_young_to_old_ex(h, 0);
        nw->gc_next = *survivors; *survivors = nw;
        g_young_alloc--; g_old_alloc++;
        c->pinned_live--;
      }
    } else {
      gc_free_cell_payload(h);
      if (g_gc_zap) memset(h, 0xDD, h->size);
      g_young_alloc--; g_alloc--;
      c->pinned_live--;
    }
    h = next;
  }
  gc_chunk** pp = &g_nursery_retained;
  while (*pp){
    gc_chunk* c = *pp;
    if (c->pinned_live == 0){
      *pp = c->next;
      c->used = 0;
      c->next = g_nursery_free; g_nursery_free = c;
    } else {
      pp = &c->next;
    }
  }
}
void ts_gc_collect_young(void){
  if (!g_young_heap && !g_nursery_active && !g_pinned_young) return;
  RT_STAT_INC(minor_gc); RT_STAT_GC_T0;
  gc_mark_async_roots_young();
  for (uint32_t i=0;i<g_sym_desc_len;i++) gc_mark_value_young(g_sym_desc[i]);
  for (uint32_t i=0;i<g_sym_value_len;i++) gc_mark_value_young(g_sym_value[i]);
  for (uint32_t i=0;i<g_symreg_len;i++){
    gc_mark_value_young(g_symreg[i].key);
    gc_mark_value_young(g_symreg[i].sym);
  }
  for (int i=0;i<g_root_len;i++){
#if defined(TS_ASAN_ENABLED)
    __asan_unpoison_memory_region(g_roots[i], sizeof(*g_roots[i]));
#endif
    gc_mark_value_young(*g_roots[i]);
  }
  size_t old_rem_len = g_rem_len;
  for (size_t i=0;i<old_rem_len;i++){
    ts_gc_header* h = g_remset[i];
    if (h && h->gen == TS_GEN_OLD) gc_scan_cell(h, 1, 0);
  }
  gc_mark_drain(1);
  for (size_t i=0;i<old_rem_len;i++) if (g_remset[i]) g_remset[i]->remembered = 0;
  g_rem_len = 0;
  for (size_t i=0;i<old_rem_len;i++){
    ts_gc_header* h = g_remset[i];
    if (h && h->gen == TS_GEN_OLD && h->kind == TS_KIND_CORO) ts_gc_remember(h);
  }
  ts_gc_header* survivors = NULL;
  ts_gc_header* h = g_young_heap;
  int moving = gc_moving_minor_enabled();
  while (h){
    ts_gc_header* next = h->gc_next;
    if (h->mark){
      if (moving && gc_is_movable_cell(h)){
        h = gc_move_young_to_old(h);
      } else {
        h->mark=0; h->gen=TS_GEN_OLD; h->remembered=0;
      }
      h->gc_next=survivors; survivors=h;
      g_young_alloc--; g_old_alloc++;
      if (h->kind == TS_KIND_CORO) ts_gc_remember(h);
    } else {
      g_young_alloc--; g_alloc--; gc_free_cell(h);
    }
    h = next;
  }
  /* pinned-from-earlier first: the arena sweep below may divert freshly pinned
     cells onto g_pinned_young with their mark already cleared, and this pass
     must not mistake those for dead. */
  gc_sweep_pinned_young(&survivors);
  gc_sweep_nursery(&survivors);
  if (survivors){
    h = survivors;
    while (h->gc_next) h = h->gc_next;
    h->gc_next = g_old_heap;
    g_old_heap = survivors;
  }
  g_young_heap = NULL;
  gc_clear_nonheap_marks();
  RT_STAT_GC_T1;
}
void ts_gc_collect(void){
  RT_STAT_INC(full_gc); RT_STAT_GC_T0;
  gc_mark_async_roots();
  /* keep symbol descriptions alive for the inspector's `Symbol(desc)` rendering
     (marked by value, so a realloc of g_sym_desc is harmless). */
  for (uint32_t i=0;i<g_sym_desc_len;i++) gc_mark_value(g_sym_desc[i]);
  for (uint32_t i=0;i<g_sym_value_len;i++) gc_mark_value(g_sym_value[i]);
  for (uint32_t i=0;i<g_symreg_len;i++){
    gc_mark_value(g_symreg[i].key);
    gc_mark_value(g_symreg[i].sym);
  }
  for (int i=0;i<g_root_len;i++){
#if defined(TS_ASAN_ENABLED)
    __asan_unpoison_memory_region(g_roots[i], sizeof(*g_roots[i]));
#endif
    gc_mark_value(*g_roots[i]);
  }
  gc_mark_drain(0);
  for (size_t i=0;i<g_rem_len;i++) if (g_remset[i]) g_remset[i]->remembered = 0;
  g_rem_len = 0;
  ts_gc_header** pp=&g_old_heap;
  while (*pp){ ts_gc_header* h=*pp;
    if (h->mark){ h->mark=0; h->gen=TS_GEN_OLD; if (h->kind==TS_KIND_CORO) ts_gc_remember(h); pp=&h->gc_next; }
    else { *pp=h->gc_next; g_alloc--; g_old_alloc--; gc_free_cell(h); }
  }
  ts_gc_header* promoted = NULL;
  ts_gc_header* y = g_young_heap;
  while (y){ ts_gc_header* next=y->gc_next;
    if (y->mark){ y->mark=0; y->gen=TS_GEN_OLD; y->gc_next=promoted; promoted=y; g_young_alloc--; g_old_alloc++; if (y->kind==TS_KIND_CORO) ts_gc_remember(y); }
    else { g_young_alloc--; g_alloc--; gc_free_cell(y); }
    y=next;
  }
  /* Arena cells cannot gen-flip in place (chunk-owned memory vs the old
     sweep's free(h)), so a full GC also has them leave by copy or die. The
     evacuated copies join `promoted` AFTER the old sweep above, so this
     collection never re-sweeps them. Pinned pass first (see minor GC). */
  gc_sweep_pinned_young(&promoted);
  gc_sweep_nursery(&promoted);
  if (promoted){
    ts_gc_header* tail=promoted; while (tail->gc_next) tail=tail->gc_next;
    tail->gc_next=g_old_heap; g_old_heap=promoted;
  }
  g_young_heap=NULL;
  gc_clear_nonheap_marks();
  RT_STAT_GC_T1;
}

tsv ts_dynamic_method_unsupported(void){
  fprintf(stderr, "tsaot: dynamic method dispatch is not yet implemented "
                  "(method called on an any-typed / prototype-mutated / unstable receiver). "
                  "See docs/prototype_semantics.md.\n");
  abort();
}

void ts_dynamic_method_missing(uint32_t name_field){
  /* The receiver was already null-checked by ts_check_method_recv, so this is a
     "<name> is not a function" TypeError (catchable). `name_field` is a FIELD-key
     id for the method name when known (0 otherwise); the method-id namespace has
     no runtime name table, hence the field key carries the name. */
  ts_throw_not_a_function(name_field ? ts_field_name(name_field) : NULL);
}
/* Reading `recv.method` off null/undefined is a property-read TypeError ("Cannot
   read properties of null (reading 'name')"), thrown before any call. Emitted at
   the head of the dynamic method-dispatch sequence. */
void ts_check_method_recv(tsv recv, uint32_t name_field){
  if (ts_is_null(recv) || ts_is_undef(recv))
    ts_throw_cannot_read(recv, name_field ? ts_field_name(name_field) : NULL);
}

/* ---------------- standard library: String methods ---------------- */
static ts_string* as_str(tsv v){ return ts_str_ptr(v); }

static uint32_t ts_str_next_code_point(ts_strview x, uint32_t* index){
  uint32_t i = *index;
  if (i >= x.len) return 0;
  uint32_t cp = ts_str_cu_at_view(x, i++);
  if (cp >= 0xD800u && cp <= 0xDBFFu && i < x.len){
    uint16_t lo = ts_str_cu_at_view(x, i);
    if (lo >= 0xDC00u && lo <= 0xDFFFu){
      cp = 0x10000u + (((cp - 0xD800u) << 10) | ((uint32_t)lo - 0xDC00u));
      i++;
    }
  }
  *index = i;
  return cp;
}

typedef struct {
  uint16_t* data;
  uint32_t len;
  uint32_t cap;
} ts_cu_builder;

static void ts_cu_builder_init(ts_cu_builder* b, uint32_t cap){
  b->len = 0;
  b->cap = cap ? cap : 8u;
  b->data = (uint16_t*)malloc(sizeof(uint16_t) * (size_t)b->cap);
  if (!b->data) ts_abort_msg("out of memory creating string");
}
static void ts_cu_builder_reserve(ts_cu_builder* b, uint32_t add){
  if (add <= b->cap - b->len) return;
  uint32_t nc = b->cap;
  while (add > nc - b->len){
    if (nc > UINT32_MAX / 2u) ts_abort_msg("string too large");
    nc *= 2u;
  }
  uint16_t* p = (uint16_t*)realloc(b->data, sizeof(uint16_t) * (size_t)nc);
  if (!p) ts_abort_msg("out of memory growing string");
  b->data = p;
  b->cap = nc;
}
static void ts_cu_builder_put_cu(ts_cu_builder* b, uint16_t cu){
  ts_cu_builder_reserve(b, 1);
  b->data[b->len++] = cu;
}
static void ts_cu_builder_put_cp(ts_cu_builder* b, uint32_t cp){
  if (cp <= 0xFFFFu){
    ts_cu_builder_put_cu(b, (uint16_t)cp);
  } else {
    cp -= 0x10000u;
    ts_cu_builder_reserve(b, 2);
    b->data[b->len++] = (uint16_t)(0xD800u + (cp >> 10));
    b->data[b->len++] = (uint16_t)(0xDC00u + (cp & 0x3FFu));
  }
}

static int ts_str_is_trim_ws(uint32_t cp){
  if (cp >= 0x0009u && cp <= 0x000Du) return 1;
  switch (cp){
    case 0x0020u:
    case 0x00A0u:
    case 0x1680u:
    case 0x2028u:
    case 0x2029u:
    case 0x202Fu:
    case 0x205Fu:
    case 0x3000u:
    case 0xFEFFu:
      return 1;
    default:
      return cp >= 0x2000u && cp <= 0x200Au;
  }
}

static int ts_case_is_cased_simple(uint32_t cp){
  if ((cp >= 'A' && cp <= 'Z') || (cp >= 'a' && cp <= 'z')) return 1;
  if ((cp >= 0x00C0u && cp <= 0x00FFu && cp != 0x00D7u && cp != 0x00F7u) ||
      cp == 0x0178u || cp == 0x0130u || cp == 0x0131u || cp == 0x1E9Eu) return 1;
  if ((cp >= 0x0391u && cp <= 0x03A9u) || (cp >= 0x03B1u && cp <= 0x03C9u)) return 1;
  if ((cp >= 0x0410u && cp <= 0x044Fu) || cp == 0x0401u || cp == 0x0451u) return 1;
  return 0;
}

static int ts_case_is_case_ignorable_simple(uint32_t cp){
  if (cp >= 0x0300u && cp <= 0x036Fu) return 1;
  return cp == 0x0027u || cp == 0x00ADu || cp == 0x2019u;
}

static int ts_case_has_cased_before(ts_strview x, uint32_t before_index){
  uint32_t i = 0;
  int seen = 0;
  while (i < before_index){
    uint32_t start = i;
    uint32_t cp = ts_str_next_code_point(x, &i);
    if (start >= before_index) break;
    if (ts_case_is_cased_simple(cp)) seen = 1;
    else if (!ts_case_is_case_ignorable_simple(cp)) seen = 0;
  }
  return seen;
}

static int ts_case_has_cased_after(ts_strview x, uint32_t after_index){
  uint32_t i = after_index;
  while (i < x.len){
    uint32_t cp = ts_str_next_code_point(x, &i);
    if (ts_case_is_cased_simple(cp)) return 1;
    if (!ts_case_is_case_ignorable_simple(cp)) return 0;
  }
  return 0;
}

static uint32_t ts_case_latin1_upper(uint32_t cp){
  if ((cp >= 0x00E0u && cp <= 0x00F6u) || (cp >= 0x00F8u && cp <= 0x00FEu)) return cp - 0x20u;
  if (cp == 0x00FFu) return 0x0178u;
  return cp;
}

static uint32_t ts_case_latin1_lower(uint32_t cp){
  if ((cp >= 0x00C0u && cp <= 0x00D6u) || (cp >= 0x00D8u && cp <= 0x00DEu)) return cp + 0x20u;
  if (cp == 0x0178u) return 0x00FFu;
  return cp;
}

static void ts_case_append_upper(ts_cu_builder* out, uint32_t cp){
  if (cp >= 'a' && cp <= 'z') cp -= 0x20u;
  else if (cp == 0x00DFu){ ts_cu_builder_put_cu(out, 'S'); ts_cu_builder_put_cu(out, 'S'); return; }
  else if (cp == 0xFB03u){ ts_cu_builder_put_cu(out, 'F'); ts_cu_builder_put_cu(out, 'F'); ts_cu_builder_put_cu(out, 'I'); return; }
  else if (cp == 0x0131u) cp = 'I';
  else if (cp == 0x00B5u) cp = 0x039Cu;
  else if (cp == 0x03C2u) cp = 0x03A3u;
  else if (cp >= 0x03B1u && cp <= 0x03C1u) cp -= 0x20u;
  else if (cp >= 0x03C3u && cp <= 0x03CBu) cp -= 0x20u;
  else if (cp >= 0x0430u && cp <= 0x044Fu) cp -= 0x20u;
  else if (cp == 0x0451u) cp = 0x0401u;
  else cp = ts_case_latin1_upper(cp);
  ts_cu_builder_put_cp(out, cp);
}

static void ts_case_append_lower(ts_cu_builder* out, uint32_t cp, ts_strview x,
                                 uint32_t start_index, uint32_t end_index){
  if (cp >= 'A' && cp <= 'Z') cp += 0x20u;
  else if (cp == 0x0130u){ ts_cu_builder_put_cu(out, 'i'); ts_cu_builder_put_cu(out, 0x0307u); return; }
  else if (cp == 0x1E9Eu) cp = 0x00DFu;
  else if (cp == 0x212Au) cp = 'k';
  else if (cp == 0x03A3u) cp = (ts_case_has_cased_before(x, start_index) && !ts_case_has_cased_after(x, end_index)) ? 0x03C2u : 0x03C3u;
  else if (cp >= 0x0391u && cp <= 0x03A1u) cp += 0x20u;
  else if (cp >= 0x03A4u && cp <= 0x03ABu) cp += 0x20u;
  else if (cp >= 0x0410u && cp <= 0x042Fu) cp += 0x20u;
  else if (cp == 0x0401u) cp = 0x0451u;
  else cp = ts_case_latin1_lower(cp);
  ts_cu_builder_put_cp(out, cp);
}

static tsv ts_str_case_convert(tsv s, int upper){
  ts_string* x = as_str(s);
  if (!x) return s;
  ts_gc_root(&s);
  ts_strview sv = ts_str_view_typed(s);
  ts_cu_builder out;
  ts_cu_builder_init(&out, sv.len + 4u);
  uint32_t i = 0;
  while (i < sv.len){
    uint32_t start = i;
    uint32_t cp = ts_str_next_code_point(sv, &i);
    if (upper) ts_case_append_upper(&out, cp);
    else ts_case_append_lower(&out, cp, sv, start, i);
  }
  tsv r = ts_new_string_from_code_units(out.data, out.len);
  free(out.data);
  ts_gc_unroot(1);
  return r;
}

tsv ts_str_toupper(tsv s){
  return ts_str_case_convert(s, 1);
}
tsv ts_str_tolower(tsv s){
  return ts_str_case_convert(s, 0);
}
/* slice(start[,end]) with JS negative-index + clamping semantics */
tsv ts_str_slice(tsv s, double start, double end, int has_end){
  ts_string* x=as_str(s); if(!x) return s;
  long n=(long)x->len;
  long a=(long)start; long b= has_end ? (long)end : n;
  if(a<0) a+=n; if(b<0) b+=n;
  if(a<0)a=0; if(a>n)a=n; if(b<0)b=0; if(b>n)b=n;
  if(b<a) b=a;
  return ts_string_slice_view(s, (uint32_t)a, (uint32_t)(b-a));
}
/* String.prototype.substring: like slice, but negatives clamp to 0 (not from the
   end) and the two indices are SWAPPED when start > end. */
tsv ts_str_substring(tsv s, double start, double end, int has_end){
  ts_string* x=as_str(s); if(!x) return s;
  long n=(long)x->len;
  long a=(long)start; if(a<0)a=0; if(a>n)a=n;
  long b= has_end ? (long)end : n; if(b<0)b=0; if(b>n)b=n;
  if(a>b){ long t=a; a=b; b=t; }
  return ts_string_slice_view(s, (uint32_t)a, (uint32_t)(b-a));
}
double ts_str_indexof(tsv s, tsv needle, double from, int has_from){
  return ts_str_indexof_fast(s, needle, from, has_from);
}
/* String.prototype.lastIndexOf: highest index <= fromIndex where needle occurs. */
double ts_str_lastindexof(tsv s, tsv needle, double from, int has_from){
  return ts_str_lastindexof_fast(s, needle, from, has_from);
}
/* Number.prototype.toFixed(digits): fixed-point string. JS rounds half away from
   zero (printf %.*f uses round-half-to-even), so round explicitly to match V8. */
tsv ts_number_to_fixed(tsv numv, double digits){
  double x = ts_to_num(numv);
  int d = (int)digits; if (d<0) d=0; if (d>100) d=100;
  if (x != x) return ts_new_string("NaN",3);
  if (x == 1.0/0.0) return ts_new_string("Infinity",8);
  if (x == -1.0/0.0) return ts_new_string("-Infinity",9);
  /* |x| >= 1e21: JS toFixed falls back to Number->String (exponential). */
  if (fabs(x) >= 1e21){ char b[64]; ts_fmt_num(x, b, sizeof b); return ts_new_string(b,(uint32_t)strlen(b)); }
  int neg = x < 0; double ax = neg ? -x : x;
  /* Round half away from zero based on the EXACT decimal value: scaling by 10^d
     in floating point is lossy (e.g. 1.45*10 drifts to a tie), so instead print
     the exact expansion with guard digits and round the d-th digit by hand. */
  char dig[1200];
  snprintf(dig, sizeof dig, "%.*f", d + 30, ax);   /* "III.FFFF..." (exact past d) */
  char* dot = strchr(dig, '.');
  int intlen = dot ? (int)(dot - dig) : (int)strlen(dig);
  /* kept = integer digits + first d fractional digits; round digit = frac[d]. */
  char kept[400]; int klen = 0;
  for (int i = 0; i < intlen; i++) kept[klen++] = dig[i];
  const char* frac = dot ? dot + 1 : "";
  for (int i = 0; i < d; i++) kept[klen++] = frac[i] ? frac[i] : '0';
  char roundc = (d < (int)strlen(frac)) ? frac[d] : '0';
  if (roundc >= '5'){               /* round half away (positive magnitude): +1 */
    int j = klen - 1;
    while (j >= 0){ if (kept[j] == '9'){ kept[j] = '0'; j--; } else { kept[j]++; break; } }
    if (j < 0){ memmove(kept + 1, kept, (size_t)klen); kept[0] = '1'; klen++; }
  }
  /* assemble: last d digits are fractional. */
  char out[440]; int o = 0;
  int ilen = klen - d;             /* integer-part length within kept */
  if (neg){ int allzero = 1; for (int i = 0; i < klen; i++) if (kept[i] != '0'){ allzero = 0; break; } if (!allzero) out[o++] = '-'; }
  for (int i = 0; i < ilen; i++) out[o++] = kept[i];
  if (d > 0){ out[o++] = '.'; for (int i = ilen; i < klen; i++) out[o++] = kept[i]; }
  out[o] = 0;
  return ts_new_string(out, (uint32_t)o);
}
/* Number.prototype.toString(radix): radix 2..36 (default 10). Integer part only
   for non-decimal radixes (matching the common integer use; JS supports fractions
   but those are rarely used and lossy). */
tsv ts_number_to_string_radix(tsv numv, double radix){
  double x = ts_to_num(numv);
  int base = (int)radix;
  if (base==10 || base<2 || base>36){ return ts_to_string_v(numv); }
  if (x != x) return ts_new_string("NaN",3);
  if (x == 1.0/0.0) return ts_new_string("Infinity",8);
  if (x == -1.0/0.0) return ts_new_string("-Infinity",9);
  char buf[1200]; int neg = x<0; double ax = neg?-x:x;
  double ipart = floor(ax);
  double frac = ax - ipart;
  const char* digs = "0123456789abcdefghijklmnopqrstuvwxyz";
  /* integer part (use double division to support magnitudes beyond long long) */
  char tmp[1100]; int ti=0;
  if (ipart==0) tmp[ti++]='0';
  while (ipart>=1){ double q=floor(ipart/base); int d=(int)(ipart - q*base); tmp[ti++]=digs[d]; ipart=q; if(ti>=1000) break; }
  int bi=0; if(neg) buf[bi++]='-';
  while (ti>0) buf[bi++]=tmp[--ti];
  /* fractional part: Steele & White — emit digits until the remaining fraction is
     within half a ULP of the original value, rounding the last digit (with carry).
     This matches V8's shortest round-tripping output, including non-terminating
     fractions in odd bases (e.g. (0.1).toString(3)). */
  double delta = 0.5 * (nextafter(ax, 1.0/0.0) - ax);
  if (delta <= 0) delta = 4.9e-324;
  if (frac >= delta){
    int point = bi;            /* index of the '.' */
    buf[bi++]='.';
    for(;;){
      frac *= base; delta *= base;
      int d = (int)frac;
      buf[bi++]=digs[d];
      frac -= d;
      if (frac > 0.5 || (frac == 0.5 && (d & 1))){
        if (frac + delta > 1.0){
          /* round up: walk back incrementing, skipping the '.', carrying as needed. */
          int j = bi-1;
          for(;;){
            if (j == point) j--;                 /* skip the decimal point */
            if (j < (neg?1:0)){                  /* carried past the MSB: insert '1' */
              int ins = neg?1:0;
              memmove(buf+ins+1, buf+ins, (size_t)(bi-ins));
              buf[ins]='1'; bi++;
              break;
            }
            char c = buf[j];
            int dv = (c>='a') ? (c-'a'+10) : (c-'0');
            if (dv+1 < base){ buf[j]=digs[dv+1]; break; }
            buf[j]='0'; j--;
          }
          break;
        }
      }
      if (frac < delta) break;
    }
    /* strip a trailing '.' if rounding consumed all fractional digits */
    if (buf[bi-1]=='.') bi--;
  }
  buf[bi]=0;
  return ts_new_string(buf,(uint32_t)bi);
}
/* Number.prototype.toPrecision(p): p significant digits. */
tsv ts_number_to_precision(tsv numv, double prec){
  double x = ts_to_num(numv);
  int p = (int)prec; if (p<1) return ts_to_string_v(numv); if (p>100) p=100;
  char buf[400];
  if (x != x) return ts_new_string("NaN",3);
  if (x == 1.0/0.0) return ts_new_string("Infinity",8);
  if (x == -1.0/0.0) return ts_new_string("-Infinity",9);
  if (x == 0){
    if (p==1) return ts_new_string("0",1);
    snprintf(buf, sizeof buf, "%.*f", p-1, 0.0);   /* "0.00..." */
    return ts_new_string(buf,(uint32_t)strlen(buf));
  }
  /* Format the mantissa to p significant digits via %e first — printf rounds
     consistently and carries (9.99->1.0e+1) correctly, so its exponent is the
     true decimal exponent `e` of the rounded value. JS toPrecision then uses
     exponential when e < -6 or e >= p, else fixed notation. */
  snprintf(buf, sizeof buf, "%.*e", p-1, x);
  char* ep = strchr(buf, 'e');
  int e = ep ? atoi(ep+1) : 0;
  if (e < -6 || e >= p){
    /* keep the %e form; JS exponent style strips a leading zero in a 2-digit exp. */
    if (ep && (ep[1]=='+'||ep[1]=='-') && ep[2]=='0' && ep[3]>='0' && ep[3]<='9' && ep[4]==0){
      ep[2]=ep[3]; ep[3]=0;
    }
  } else {
    int frac = p-1-e; if (frac<0) frac=0;
    snprintf(buf, sizeof buf, "%.*f", frac, x);
  }
  return ts_new_string(buf,(uint32_t)strlen(buf));
}
int ts_str_includes(tsv s, tsv needle, double pos, int has_pos){ return ts_str_indexof(s,needle,pos,has_pos) >= 0; }
tsv ts_str_charat(tsv s, double idx){
  ts_string* x=as_str(s); if(!x) return ts_new_string("",0);
  long i=(long)idx; if(i<0||i>=(long)x->len) return ts_new_string("",0);
  return ts_string_slice_view(s, (uint32_t)i, 1);
}
double ts_str_charcodeat(tsv s, double idx){
  ts_string* x=as_str(s); if(!x) return 0;
  ts_strview xs=ts_str_view_typed(s);
  long i=(long)idx; if(i<0||i>=(long)x->len) return 0; /* NaN in JS; 0 approx */
  return (double)ts_str_cu_at_view(xs, (uint32_t)i);
}
/* String.prototype.codePointAt: index is a UTF-16 code-unit index. */
tsv ts_str_codepointat(tsv s, double idx){
  ts_string* x=as_str(s); if(!x) return TS_UNDEFINED;
  ts_strview xs=ts_str_view_typed(s);
  long i=(long)idx; if(i<0||i>=(long)x->len) return TS_UNDEFINED;
  uint16_t hi = ts_str_cu_at_view(xs, (uint32_t)i);
  if (hi >= 0xD800u && hi <= 0xDBFFu && i + 1 < (long)xs.len){
    uint16_t lo = ts_str_cu_at_view(xs, (uint32_t)i + 1);
    if (lo >= 0xDC00u && lo <= 0xDFFFu){
      uint32_t cp = 0x10000u + (((uint32_t)hi - 0xD800u) << 10) + ((uint32_t)lo - 0xDC00u);
      return ts_num((double)cp);
    }
  }
  return ts_num((double)hi);
}

int ts_str_is_well_formed(tsv s){
  ts_string* x = as_str(s);
  if (!x) return 1;
  ts_strview xs = ts_str_view_typed(s);
  for (uint32_t i = 0; i < xs.len; i++){
    uint16_t cu = ts_str_cu_at_view(xs, i);
    if (cu >= 0xD800u && cu <= 0xDBFFu){
      if (i + 1u >= xs.len) return 0;
      uint16_t lo = ts_str_cu_at_view(xs, i + 1u);
      if (lo < 0xDC00u || lo > 0xDFFFu) return 0;
      i++;
    } else if (cu >= 0xDC00u && cu <= 0xDFFFu){
      return 0;
    }
  }
  return 1;
}

tsv ts_str_to_well_formed(tsv s){
  ts_string* x = as_str(s);
  if (!x) return s;
  ts_gc_root(&s);
  ts_strview xs = ts_str_view_typed(s);
  ts_cu_builder out;
  ts_cu_builder_init(&out, xs.len ? xs.len : 1u);
  for (uint32_t i = 0; i < xs.len; i++){
    uint16_t cu = ts_str_cu_at_view(xs, i);
    if (cu >= 0xD800u && cu <= 0xDBFFu){
      if (i + 1u < xs.len){
        uint16_t lo = ts_str_cu_at_view(xs, i + 1u);
        if (lo >= 0xDC00u && lo <= 0xDFFFu){
          ts_cu_builder_put_cu(&out, cu);
          ts_cu_builder_put_cu(&out, lo);
          i++;
          continue;
        }
      }
      ts_cu_builder_put_cu(&out, 0xFFFDu);
    } else if (cu >= 0xDC00u && cu <= 0xDFFFu){
      ts_cu_builder_put_cu(&out, 0xFFFDu);
    } else {
      ts_cu_builder_put_cu(&out, cu);
    }
  }
  tsv r = ts_new_string_from_code_units(out.data, out.len);
  free(out.data);
  ts_gc_unroot(1);
  return r;
}

tsv ts_str_concat(tsv a, tsv b){ return ts_add(a,b); }
tsv ts_str_repeat(tsv s, double count){
  ts_string* x=as_str(s); if(!x) return s;
  ts_strview xs=ts_str_view_typed(s);
  long c=(long)count; if(c<0)c=0;
  uint32_t total=xs.len*(uint32_t)c;
  ts_gc_root(&s);
  uint32_t flags = xs.flags & TS_STR_FLAG_UTF16;
  ts_string* y=ts_string_alloc_storage(total, flags);
  xs=ts_str_view_typed(s);
  y->len=total; for(long k=0;k<c;k++) ts_str_copy_units(y->data, flags, (uint32_t)k*xs.len, xs, 0, xs.len);
  y->flags=strflags_storage(y->data, flags, total); y->hash=strhash_units(y->data,y->flags,total);
  y->parent=TS_UNDEFINED; y->offset=0;
  tsv r = ts_str_v(y);
  ts_gc_unroot(1);
  return r;
}
tsv ts_str_trim(tsv s){
  ts_string* x=as_str(s); if(!x) return s;
  ts_strview xs=ts_str_view_typed(s);
  long a=0,b=(long)x->len;
  while(a<b){ uint16_t c=ts_str_cu_at_view(xs,(uint32_t)a); if(ts_str_is_trim_ws(c)) a++; else break; }
  while(b>a){ uint16_t c=ts_str_cu_at_view(xs,(uint32_t)b-1); if(ts_str_is_trim_ws(c)) b--; else break; }
  return ts_string_slice_view(s, (uint32_t)a, (uint32_t)(b-a));
}
/* split(sep) -> array of strings (sep must be a non-empty string here) */
tsv ts_str_split(tsv s, tsv sep, tsv limit){
  if(!ts_is_str(s)) return ts_new_array(0);
  ts_gc_root(&s); ts_gc_root(&sep);
  ts_string* x=as_str(s), *sp=as_str(sep);
  ts_strview xs=ts_str_view_typed(s), ss={0};
  if(sp) ss=ts_str_view_typed(sep);
  /* optional limit: truncate the result to ToUint32(limit) substrings. */
  int has_lim = (limit != TS_UNDEFINED);
  /* ToUint32 per spec (so split(sep,-1) -> 4294967295 = effectively no limit);
     a direct (uint32_t)(negative double) cast is undefined behavior. */
  uint32_t lim = has_lim ? (uint32_t)(int64_t)ts_to_num(limit) : 0;
  if(has_lim && lim==0){
    tsv arr=ts_new_array(0); ts_gc_root(&arr);
    ts_gc_unroot(3);
    return arr;
  }       /* limit 0 -> [] */
  /* No/undefined separator -> a single-element array with the WHOLE string
     (distinct from split(""), which splits each char). */
  if(sep == TS_UNDEFINED){
    tsv arr=ts_new_array(1); ts_gc_root(&arr);
    ts_array_store_existing(arr, 0, s);
    ts_gc_unroot(3);
    return arr;
  }
  if(!sp || sp->len==0){ /* split each char */
    uint32_t count=x->len;
    if(has_lim && lim<count) count=lim;
    tsv arr=ts_new_array(count); ts_gc_root(&arr);
    for(uint32_t i=0;i<count;i++){
      tsv part=ts_string_slice_view(s, i, 1);
      ts_array_store_existing(arr, i, part);
    }
    ts_gc_unroot(3);
    return arr;
  }
  uint32_t count=0;
  for(uint32_t i=0;;){
    long long hit=ts_str_find_forward_view(xs, ss, i);
    if(hit<0) break;
    count++;
    if(has_lim && count>=lim) break;
    i=(uint32_t)hit+ss.len;
  }
  if(!has_lim || count<lim) count++;
  tsv arr=ts_new_array(count); ts_gc_root(&arr);
  uint32_t start=0, outi=0;
  xs=ts_str_view_typed(s); ss=ts_str_view_typed(sep);
  for(uint32_t i=0;outi<count;){
    long long hit=ts_str_find_forward_view(xs, ss, i);
    if(hit<0) break;
    i=(uint32_t)hit;
    tsv part=ts_string_slice_view(s, start, i-start);
    ts_array_store_existing(arr, outi++, part);
    if(outi>=count) break;
    xs=ts_str_view_typed(s); ss=ts_str_view_typed(sep);
    i+=ss.len; start=i;
  }
  if(outi<count){
    xs=ts_str_view_typed(s);
    tsv part=ts_string_slice_view(s, start, xs.len-start);
    ts_array_store_existing(arr, outi, part);
  }
  ts_gc_unroot(3);
  return arr;
}

/* ---------------- standard library: Array methods ---------------- */
static ts_array* as_arr(tsv v){ return ts_is_array(v) ? (ts_array*)ts_ptr(v) : NULL; }

/* callback-based: map/filter/forEach/reduce. cb is a ts_func value; we invoke it
   with (element, index) — matching the common JS callback signature. */
tsv ts_array_map(tsv arr, tsv cb){
  ts_array* a=as_arr(arr); if(!a) return ts_new_array(0);
  ts_gc_root(&arr); ts_gc_root(&cb);
  tsv out=ts_new_array(0);
  ts_gc_root(&out);
  a=as_arr(arr);
  uint32_t len=a ? a->len : 0;
  for(uint32_t i=0;i<len;i++){
    a=as_arr(arr);
    tsv elem = (a && i<a->len) ? a->data[i] : TS_UNDEFINED;
    tsv args[2]={ elem, ts_num((double)i) };
    ts_array_push(out, ts_call_value(cb, args, 2));
  }
  ts_gc_unroot(3);
  return out;
}
tsv ts_array_filter(tsv arr, tsv cb){
  ts_array* a=as_arr(arr); if(!a) return ts_new_array(0);
  ts_gc_root(&arr); ts_gc_root(&cb);
  tsv out=ts_new_array(0);
  ts_gc_root(&out);
  a=as_arr(arr);
  uint32_t len=a ? a->len : 0;
  for(uint32_t i=0;i<len;i++){
    a=as_arr(arr);
    tsv elem = (a && i<a->len) ? a->data[i] : TS_UNDEFINED;
    tsv args[2]={ elem, ts_num((double)i) };
    if(ts_truthy(ts_call_value(cb,args,2))) ts_array_push(out, elem);
  }
  ts_gc_unroot(3);
  return out;
}
tsv ts_array_foreach(tsv arr, tsv cb){
  ts_array* a=as_arr(arr); if(!a) return TS_UNDEFINED;
  uint32_t len=a->len;
  ts_gc_root(&arr); ts_gc_root(&cb);
  for(uint32_t i=0;i<len;i++){
    a=as_arr(arr);
    tsv elem = (a && i<a->len) ? a->data[i] : TS_UNDEFINED;
    tsv args[2]={ elem, ts_num((double)i) };
    ts_call_value(cb,args,2);
  }
  ts_gc_unroot(2);
  return TS_UNDEFINED;
}
tsv ts_array_reduce(tsv arr, tsv cb, tsv init, int has_init){
  ts_array* a=as_arr(arr); if(!a) return init;
  tsv acc; uint32_t start;
  if (has_init){ acc=init; start=0; }
  else {
    /* No initial value: accumulator = first element, iterate from index 1.
       (JS throws TypeError on an empty array here; we return undefined.) */
    if (a->len==0) return TS_UNDEFINED;
    acc=a->data[0]; start=1;
  }
  ts_gc_root(&arr); ts_gc_root(&acc); ts_gc_root(&cb);
  uint32_t len=a->len;
  for(uint32_t i=start;i<len;i++){
    a = as_arr(arr); /* re-fetch: callback may have triggered GC/realloc */
    tsv elem = (a && i<a->len) ? a->data[i] : TS_UNDEFINED;
    tsv args[3]={ acc, elem, ts_num((double)i) };
    acc=ts_call_value(cb,args,3);
  }
  ts_gc_unroot(3);
  return acc;
}
tsv ts_array_reduce_right(tsv arr, tsv cb, tsv init, int has_init){
  ts_array* a=as_arr(arr); if(!a) return init;
  tsv acc; long start;
  if (has_init){ acc=init; start=(long)a->len-1; }
  else {
    if (a->len==0) return TS_UNDEFINED;   /* JS throws TypeError; we return undefined */
    acc=a->data[a->len-1]; start=(long)a->len-2;
  }
  ts_gc_root(&arr); ts_gc_root(&acc); ts_gc_root(&cb);
  for(long i=start;i>=0;i--){
    a = as_arr(arr);                      /* re-fetch: cb may have triggered GC/realloc */
    tsv elem = (a && (uint32_t)i<a->len) ? a->data[i] : TS_UNDEFINED;
    tsv args[3]={ acc, elem, ts_num((double)i) };
    acc=ts_call_value(cb,args,3);
  }
  ts_gc_unroot(3);
  return acc;
}
/* Array.prototype.copyWithin(target, start, end): copy the slice [start,end) onto
   position target, in place. Indices clamp to [0,len] (negatives count from end).
   Length is unchanged; overlapping ranges are handled like memmove. */
tsv ts_array_copy_within(tsv arr, double target, double start, double end, int has_end){
  ts_array* a=as_arr(arr); if(!a) return arr;
  if (ts_arr_frozen(arr)) return arr;
  long n=(long)a->len;
  long to = (long)target; if(to<0) to+=n; if(to<0) to=0; if(to>n) to=n;
  long fr = (long)start;  if(fr<0) fr+=n; if(fr<0) fr=0; if(fr>n) fr=n;
  long en = has_end ? (long)end : n; if(en<0) en+=n; if(en<0) en=0; if(en>n) en=n;
  long count = en-fr; if(count > n-to) count = n-to;
  if(count>0) memmove(&a->data[to], &a->data[fr], (size_t)count*sizeof(tsv));
  return arr;
}
/* Array.prototype.entries(): [[0,v0],[1,v1],...]. keys(): [0,1,...].
   values(): a shallow copy. We return plain arrays; for-of/spread iterate them. */
tsv ts_array_entries(tsv arr){
  ts_array* a=as_arr(arr); if(!a) return ts_new_array(0);
  ts_gc_root(&arr);
  tsv out=ts_new_array(0);
  ts_gc_root(&out);
  a=as_arr(arr);
  uint32_t len=a ? a->len : 0;
  for(uint32_t i=0;i<len;i++){
    a=as_arr(arr);
    tsv elem=(a && i<a->len) ? a->data[i] : TS_UNDEFINED;
    tsv pair=ts_new_array(0);
    ts_gc_root(&pair);
    ts_array_push(pair, ts_num((double)i)); ts_array_push(pair, elem);
    ts_array_push(out, pair);
    ts_gc_unroot(1);
  }
  ts_gc_unroot(2);
  return out;
}
tsv ts_array_keys_arr(tsv arr){
  ts_array* a=as_arr(arr); if(!a) return ts_new_array(0);
  ts_gc_root(&arr);
  tsv out=ts_new_array(0);
  ts_gc_root(&out);
  a=as_arr(arr);
  uint32_t len=a ? a->len : 0;
  for(uint32_t i=0;i<len;i++) ts_array_push(out, ts_num((double)i));
  ts_gc_unroot(2);
  return out;
}
tsv ts_array_values_arr(tsv arr){
  ts_array* a=as_arr(arr); if(!a) return ts_new_array(0);
  ts_gc_root(&arr);
  tsv out=ts_new_array(0);
  ts_gc_root(&out);
  a=as_arr(arr);
  uint32_t len=a ? a->len : 0;
  for(uint32_t i=0;i<len;i++){
    a=as_arr(arr);
    tsv elem=(a && i<a->len) ? a->data[i] : TS_UNDEFINED;
    ts_array_push(out, elem);
  }
  ts_gc_unroot(2);
  return out;
}
double ts_array_indexof(tsv arr, tsv v, double from, int has_from){
  ts_array* a=as_arr(arr); if(!a) return -1;
  long n=(long)a->len, s = has_from ? (long)from : 0;
  if(s<0){ s+=n; if(s<0) s=0; }
  for(long i=s;i<n;i++) if(ts_strict_eq(a->data[i], v)) return (double)i;
  return -1;
}
int ts_array_includes(tsv arr, tsv v, double from, int has_from){
  /* Array.includes uses SameValueZero, which (unlike indexOf's strict ===)
     treats NaN as equal to NaN. (+0/-0 already compare equal under ===.) */
  ts_array* a=as_arr(arr); if(!a) return 0;
  long n=(long)a->len, s = has_from ? (long)from : 0;
  if(s<0){ s+=n; if(s<0) s=0; }
  int v_is_nan = ts_is_num(v) && (ts_to_num(v) != ts_to_num(v));
  for(long i=s;i<n;i++){
    tsv e=a->data[i];
    if(ts_strict_eq(e, v)) return 1;
    if(v_is_nan && ts_is_num(e) && (ts_to_num(e) != ts_to_num(e))) return 1;
  }
  return 0;
}
tsv ts_array_slice(tsv arr, double start, double end, int has_end){
  ts_array* a=as_arr(arr); if(!a) return ts_new_array(0);
  long n=(long)a->len, s=(long)start, e= has_end ? (long)end : n;
  if(s<0)s+=n; if(e<0)e+=n; if(s<0)s=0; if(s>n)s=n; if(e<0)e=0; if(e>n)e=n; if(e<s)e=s;
  ts_gc_root(&arr);
  tsv out=ts_new_array(0);
  ts_gc_root(&out);
  for(long i=s;i<e;i++){
    a=as_arr(arr);
    ts_array_push(out, (a && i<(long)a->len) ? a->data[i] : TS_UNDEFINED);
  }
  ts_gc_unroot(2);
  return out;
}
/* new Array(n): an array of length n with all elements undefined. (ts_new_array's
   spare capacity is calloc'd zero-bits = the number 0, so we must fill each slot
   with TS_UNDEFINED explicitly rather than just bumping the length.) */
tsv ts_array_new_length(double n){
  long len=(long)n; if(len<0) len=0;
  tsv arr=ts_new_array(0);
  for(long i=0;i<len;i++) ts_array_push(arr, TS_UNDEFINED);
  return arr;
}
tsv ts_array_concat(tsv x, tsv y){
  /* concat one argument onto a copy of x: an array argument is spread, any other
     value is appended as a single element (JS Array.prototype.concat semantics). */
  ts_gc_root(&x); ts_gc_root(&y);
  tsv out=ts_new_array(0);
  ts_gc_root(&out);
  ts_array* a=as_arr(x);
  if(a) for(uint32_t i=0;i<a->len;i++){ ts_array_push(out,a->data[i]); a=as_arr(x); }
  if(ts_is_array(y)){
    ts_array* b=as_arr(y);
    for(uint32_t i=0;i<b->len;i++){ ts_array_push(out,b->data[i]); b=as_arr(y); }
  } else {
    ts_array_push(out, y);
  }
  ts_gc_unroot(3);
  return out;
}
/* Array.prototype.splice(start, deleteCount?, ...items): remove `deleteCount`
   elements at `start` and insert `items` in their place, IN PLACE (array identity
   preserved). Returns a new array of the removed elements. `items` is passed as an
   array (possibly empty). */
tsv ts_array_splice(tsv arr, double start, double dc, int has_dc, tsv items){
  ts_array* a=as_arr(arr); if(!a) return ts_new_array(0);
  if(ts_arr_frozen(arr)) return ts_new_array(0);   /* frozen: JS throws; we no-op (throw欠落) */
  ts_gc_root(&arr); ts_gc_root(&items);
  tsv removed=ts_new_array(0);
  ts_gc_root(&removed);
  a=as_arr(arr);
  long n=(long)a->len;
  long s=(long)start; if(s<0){ s+=n; if(s<0)s=0; } if(s>n) s=n;
  long del = has_dc ? (long)dc : (n-s); if(del<0) del=0; if(del>n-s) del=n-s;
  for(long i=0;i<del;i++){ a=as_arr(arr); ts_array_push(removed, a->data[s+i]); }
  ts_array* it=as_arr(items); long ni = it?(long)it->len:0;
  long newlen = n - del + ni;
  /* rebuild data buffer: [0,s) + items + [s+del,n). No GC between malloc and
     assignment, so the raw pointers stay valid. */
  tsv* nd = (tsv*)malloc((size_t)(newlen?newlen:1)*sizeof(tsv));
  long w=0;
  a=as_arr(arr);
  for(long i=0;i<s;i++) nd[w++]=a->data[i];
  it=as_arr(items); for(long i=0;i<ni;i++) nd[w++]=it->data[i];
  a=as_arr(arr); for(long i=s+del;i<n;i++) nd[w++]=a->data[i];
  array_free_data(a);
  if (newlen <= 4) {
    a->data = a->inline_data;
    a->cap = 4;
    for (uint32_t i=0;i<4;i++) a->data[i] = (i < (uint32_t)newlen) ? nd[i] : TS_UNDEFINED;
    free(nd);
  } else {
    a->data=nd;
    a->cap=(uint32_t)newlen;
  }
  a->len=(uint32_t)newlen;
  for (uint32_t i=0;i<a->len;i++) ts_write_barrier(arr, a->data[i]);
  ts_gc_unroot(3);
  return removed;
}
static tsv ts_array_join_slow(tsv arr, tsv sep){
  if(!ts_is_array(arr)) return ts_new_string("",0);
  ts_gc_root(&arr);
  if(sep==TS_UNDEFINED) sep=ts_new_string(",",1);   /* join() / join(undefined) -> "," */
  ts_gc_root(&sep);
  tsv acc=ts_new_string("",0);
  ts_gc_root(&acc);
  for(uint32_t i=0;;i++){
    ts_array* a=as_arr(arr);
    if(!a || i>=a->len) break;
    if(i>0) acc=ts_add(acc, sep);
    /* undefined and null render as the empty string in join (not "undefined"). */
    a=as_arr(arr);
    tsv e=(a && i<a->len) ? a->data[i] : TS_UNDEFINED;
    if(e!=TS_UNDEFINED && e!=TS_NULL){
      tsv sv=ts_to_string_v(e);
      ts_gc_root(&sv);
      acc=ts_add(acc, sv);
      ts_gc_unroot(1);
    }
  }
  ts_gc_unroot(3);
  return acc;
}
static int ts_array_join_fast_value(tsv v){
  return v==TS_UNDEFINED || v==TS_NULL || ts_is_str(v) || ts_is_num(v) || ts_is_bool(v);
}
tsv ts_array_join(tsv arr, tsv sep){
  if(!ts_is_array(arr)) return ts_new_string("",0);
  ts_gc_root(&arr);
  if(sep==TS_UNDEFINED) sep=ts_new_string(",",1);   /* join() / join(undefined) -> "," */
  ts_gc_root(&sep);
  if(!ts_is_str(sep)){
    ts_gc_unroot(2);
    return ts_array_join_slow(arr, sep);
  }
  ts_array* a=as_arr(arr);
  uint32_t len=a ? a->len : 0;
  for(uint32_t i=0;i<len;i++){
    a=as_arr(arr);
    tsv e=(a && i<a->len) ? a->data[i] : TS_UNDEFINED;
    if(!ts_array_join_fast_value(e)){
      ts_gc_unroot(2);
      return ts_array_join_slow(arr, sep);
    }
  }

  tsv* parts = len ? (tsv*)malloc(sizeof(tsv) * len) : NULL;
  uint32_t rooted = 0;
  uint64_t total = 0;
  uint32_t out_flags = ts_str_view_typed(sep).flags & TS_STR_FLAG_UTF16;
  uint32_t sep_len = ts_str_len_typed(sep);
  if(len > 1) total += (uint64_t)sep_len * (uint64_t)(len - 1);
  for(uint32_t i=0;i<len;i++){
    a=as_arr(arr);
    tsv e=(a && i<a->len) ? a->data[i] : TS_UNDEFINED;
    if(e==TS_UNDEFINED || e==TS_NULL){
      parts[i]=TS_UNDEFINED;
      continue;
    }
    parts[i]=ts_is_str(e) ? e : ts_to_string_v(e);
    ts_gc_root(&parts[i]);
    rooted++;
    ts_strview pv=ts_str_view_typed(parts[i]);
    out_flags |= pv.flags & TS_STR_FLAG_UTF16;
    total += pv.len;
    if(total > UINT32_MAX){
      ts_gc_unroot((int)rooted + 2);
      free(parts);
      fprintf(stderr, "tsaot: RangeError: joined string too large\n");
      abort();
    }
  }
  if(total==0){
    ts_gc_unroot((int)rooted + 2);
    free(parts);
    return ts_new_string("",0);
  }

  ts_string* out=ts_string_alloc_storage((uint32_t)total, out_flags);
  uint32_t pos=0;
  ts_strview sepv=ts_str_view_typed(sep);
  for(uint32_t i=0;i<len;i++){
    if(i>0){
      ts_str_copy_units(out->data, out_flags, pos, sepv, 0, sepv.len);
      pos += sepv.len;
    }
    if(parts[i]!=TS_UNDEFINED){
      ts_strview v=ts_str_view_typed(parts[i]);
      ts_str_copy_units(out->data, out_flags, pos, v, 0, v.len);
      pos += v.len;
    }
  }
  out->len=(uint32_t)total;
  out->flags=strflags_storage(out->data, out_flags, out->len);
  out->hash=strhash_units(out->data, out->flags, out->len);
  out->parent=TS_UNDEFINED;
  out->offset=0;
  tsv r=ts_str_v(out);
  ts_gc_unroot((int)rooted + 2);
  free(parts);
  return r;
}
tsv ts_array_pop(tsv arr){
  ts_array* a=as_arr(arr); if(!a||a->len==0) return TS_UNDEFINED;
  if (ts_arr_frozen(arr)) return TS_UNDEFINED;   /* frozen: no mutation */
  tsv v=a->data[a->len-1]; a->len--; return v;
}

tsv ts_unsupported_builtin(const char* name){
  fprintf(stderr, "tsaot: unsupported stdlib method: %s\n", name);
  abort();
}

/* ---------------- Map / Set ---------------- */
/* SameValueZero: like ===, but NaN equals NaN. Used for Map/Set key identity. */
static int same_value_zero(tsv a, tsv b){
  if (ts_is_num(a) && ts_is_num(b)){
    double x=ts_to_num(a), y=ts_to_num(b);
    if (x!=x && y!=y) return 1;     /* NaN === NaN under SameValueZero */
    return x==y;                     /* note: +0 and -0 compare equal */
  }
  return ts_strict_eq(a,b);
}

int ts_is_map(tsv v){ return ts_is_obj(v) && ((ts_gc_header*)ts_ptr(v))->kind == TS_KIND_MAP; }
int ts_is_set(tsv v){ return ts_is_obj(v) && ((ts_gc_header*)ts_ptr(v))->kind == TS_KIND_SET; }

tsv ts_new_map(void){
  ts_map* m = gc_alloc(sizeof(ts_map), TS_KIND_MAP);
  m->o.proto = ts_proto_ref(g_map_proto_v) ? g_map_proto_v : TS_NULL;
  m->keys=NULL; m->vals=NULL; m->len=0; m->cap=0;
  m->index=NULL; m->index_cap=0; m->tombs=0;
  return ts_obj(m);
}
tsv ts_new_set(void){
  ts_set_t* s = gc_alloc(sizeof(ts_set_t), TS_KIND_SET);
  s->o.proto = ts_proto_ref(g_set_proto_v) ? g_set_proto_v : TS_NULL;
  s->elems=NULL; s->len=0; s->cap=0;
  s->index=NULL; s->index_cap=0; s->tombs=0;
  return ts_obj(s);
}

/* ---- Map/Set hash index (P2a) ----
   The dense arrays keep insertion order and stay what the GC scans. Deleting
   turns the dense entry into an internal HOLE sentinel (never user-visible;
   iteration skips it) and the hash slot into a tombstone, so positions are
   stable during iteration — deletion mid-forEach now behaves like V8's skip
   instead of shifting. Compaction (which does shift) runs only from the
   delete path once tombs dominate. The 0xFFFE selector cannot collide with
   user values: runtime numeric NaNs are canonicalized to 0x7FF8… and boxed
   selectors stop at 0xFFFD. */
#define TS_MAPSET_HOLE TS_BOX(0xFFFEu, 0x484F4C45u)
#define TS_MAPSET_LINEAR_MAX 8u

/* Hash consistent with same_value_zero: sv0(a,b) => hash(a)==hash(b).
   numbers by canonical double value (±0 folded, one NaN), strings by content
   (cached storage hash when present), heap cells by identity — the C0
   identity-hash design: raw stable id (handle id today; the NONHEAP fallback
   is the address, stable because NONHEAP never moves) mixed at the use site. */
static uint32_t sv0_hash(tsv k){
  uint64_t bits;
  if (ts_is_num(k)){
    double d = ts_to_num(k);
    if (d == 0) d = 0;                          /* -0 → +0 */
    if (d != d) bits = 0x7FF8000000000000ull;   /* canonical NaN */
    else memcpy(&bits, &d, sizeof bits);
  } else if (ts_is_str(k)){
    ts_string* s = ts_str_ptr_typed(k);
    if ((s->flags & TS_STR_FLAG_HASHED) && !(s->flags & TS_STR_FLAG_VIEW)) return s->hash;
    return strhash_view(ts_str_view_typed(k));
  } else if (ts_heap_ref(k)){
    ts_gc_header* h = ts_heap_ptr(k);
    uint64_t hd = h ? h->handle : 0;
    uint32_t id = (hd & 1u) ? (uint32_t)(hd >> 1) : (uint32_t)((uintptr_t)h >> 4);
    return id * 2654435769u;                    /* fibonacci mix over the raw id */
  } else {
    bits = k;                                    /* bool/undefined/null singletons */
  }
  bits ^= bits >> 33; bits *= 0xff51afd7ed558ccdull; bits ^= bits >> 33;
  return (uint32_t)bits;
}

/* Probe the slot table for k. Hit: returns the dense index, *slot_out = its
   slot. Miss: returns -1, *slot_out = preferred insertion slot (first
   tombstone on the probe path, else the terminating empty). The maintenance
   rule keeps at least a quarter of the slots empty, so the walk terminates. */
static long mapset_probe(const uint32_t* index, uint32_t index_cap,
                         const tsv* keys, tsv k, uint32_t h, uint32_t* slot_out){
  uint32_t mask = index_cap - 1u;
  uint32_t slot = h & mask;
  long ins = -1;
  unsigned long long probes = 0;
  for (;;){
    uint32_t e = index[slot];
    probes++;
    if (e == 0u){
      if (slot_out) *slot_out = (ins >= 0) ? (uint32_t)ins : slot;
      RT_STAT_ADD(map_find_probes, probes); RT_STAT_HIST(map_find_hist, probes);
      return -1;
    }
    if (e == 1u){
      if (ins < 0) ins = (long)slot;
    } else {
      uint32_t di = e - 2u;
      if (same_value_zero(keys[di], k)){
        if (slot_out) *slot_out = slot;
        RT_STAT_ADD(map_find_probes, probes); RT_STAT_HIST(map_find_hist, probes);
        return (long)di;
      }
    }
    slot = (slot + 1u) & mask;
  }
}
static void mapset_index_insert(uint32_t* index, uint32_t index_cap,
                                uint32_t dense_idx, uint32_t h){
  uint32_t mask = index_cap - 1u;
  uint32_t slot = h & mask;
  while (index[slot] > 1u) slot = (slot + 1u) & mask; /* stop at empty or tomb */
  index[slot] = dense_idx + 2u;
}
/* (Re)build the slot table over the live dense entries. Sized so the table is
   at most half full at build time (load stays < 3/4 until the next rebuild). */
static uint32_t* mapset_index_build(const tsv* keys, uint32_t len, uint32_t* cap_io){
  uint32_t want = (len + 2u) * 2u;
  uint32_t cap = 16u;
  while (cap < want) cap <<= 1;
  uint32_t* index = (uint32_t*)calloc(cap, sizeof(uint32_t));
  if (!index){ *cap_io = 0; return NULL; }
  for (uint32_t i = 0; i < len; i++){
    if (keys[i] == TS_MAPSET_HOLE) continue;
    mapset_index_insert(index, cap, i, sv0_hash(keys[i]));
  }
  *cap_io = cap;
  return index;
}
/* Ensure the index exists (past the linear-scan size) and has slack for one
   more insertion. Never touches the dense arrays — safe against iterators. */
static void mapset_index_maintain(tsv* keys, uint32_t len, uint32_t tombs,
                                  uint32_t** index_io, uint32_t* cap_io){
  uint32_t live = len - tombs;
  if (!*index_io){
    if (live < TS_MAPSET_LINEAR_MAX) return;
  } else if ((uint64_t)(len + 2u) * 4u <= (uint64_t)(*cap_io) * 3u){
    return;
  }
  uint32_t* nw = mapset_index_build(keys, len, cap_io);
  if (nw){ free(*index_io); *index_io = nw; }
}

/* find key index in a map, or -1 (holes never match: probe skips them by
   slot state, and the linear fallback compares the sentinel bit-exactly first) */
static long map_find(ts_map* m, tsv k){
  RT_STAT_INC(map_find_calls);
  if (m->index) return mapset_probe(m->index, m->index_cap, m->keys, k, sv0_hash(k), NULL);
  for (uint32_t i=0;i<m->len;i++){
    if (m->keys[i] == TS_MAPSET_HOLE) continue;
    if (same_value_zero(m->keys[i], k)){
      RT_STAT_ADD(map_find_probes, i+1); RT_STAT_HIST(map_find_hist, i+1);
      return (long)i;
    }
  }
  RT_STAT_ADD(map_find_probes, m->len); RT_STAT_HIST(map_find_hist, m->len+1);
  return -1;
}
static void map_grow(ts_map* m){
  if (m->len < m->cap) return;
  uint32_t nc = m->cap ? m->cap*2 : 8;
  m->keys = realloc(m->keys, sizeof(tsv)*nc);
  m->vals = realloc(m->vals, sizeof(tsv)*nc);
  m->cap = nc;
}
/* Shift live entries down over the holes (order preserved) and rebuild the
   index. Delete-path only: iteration positions move, which is the same
   observable class as the pre-index implementation's immediate shift. */
static void map_compact(ts_map* m){
  uint32_t w = 0;
  for (uint32_t i = 0; i < m->len; i++){
    if (m->keys[i] == TS_MAPSET_HOLE) continue;
    m->keys[w] = m->keys[i]; m->vals[w] = m->vals[i]; w++;
  }
  m->len = w; m->tombs = 0;
  if (m->index){
    uint32_t* nw = mapset_index_build(m->keys, m->len, &m->index_cap);
    if (nw){ free(m->index); m->index = nw; }
  }
}
tsv ts_map_set(tsv mv, tsv k, tsv v){
  if (!ts_is_map(mv)) return mv;
  ts_map* m = ts_ptr(mv);
  uint32_t slot = 0;
  long i;
  if (m->index){ RT_STAT_INC(map_find_calls); i = mapset_probe(m->index, m->index_cap, m->keys, k, sv0_hash(k), &slot); }
  else i = map_find(m, k);
  if (i >= 0){ m->vals[i] = v; ts_write_barrier(mv, v); return mv; }   /* update existing, keep order */
  map_grow(m);
  m->keys[m->len]=k; m->vals[m->len]=v; m->len++;
  if (m->index){
    /* reuse the probe's slot (tomb or empty); maintain slack afterwards */
    m->index[slot] = (m->len - 1u) + 2u;
    mapset_index_maintain(m->keys, m->len, m->tombs, &m->index, &m->index_cap);
  } else {
    mapset_index_maintain(m->keys, m->len, m->tombs, &m->index, &m->index_cap);
  }
  ts_write_barrier(mv, k); ts_write_barrier(mv, v);
  return mv;
}
tsv ts_map_get(tsv mv, tsv k){
  if (!ts_is_map(mv)) return TS_UNDEFINED;
  ts_map* m = ts_ptr(mv); long i = map_find(m,k);
  return i>=0 ? m->vals[i] : TS_UNDEFINED;
}
int ts_map_has(tsv mv, tsv k){
  if (!ts_is_map(mv)) return 0;
  return map_find(ts_ptr(mv), k) >= 0;
}
int ts_map_delete(tsv mv, tsv k){
  if (!ts_is_map(mv)) return 0;
  ts_map* m = ts_ptr(mv);
  uint32_t slot = 0;
  long i;
  if (m->index){
    RT_STAT_INC(map_find_calls);
    i = mapset_probe(m->index, m->index_cap, m->keys, k, sv0_hash(k), &slot);
    if (i < 0) return 0;
    m->index[slot] = 1u; /* tombstone */
    m->keys[i] = TS_MAPSET_HOLE; m->vals[i] = TS_UNDEFINED;
    m->tombs++;
    if (m->tombs > 64u && m->tombs * 2u >= m->len) map_compact(m);
    return 1;
  }
  i = map_find(m, k);
  if (i < 0) return 0;
  for (uint32_t j=(uint32_t)i; j+1<m->len; j++){ m->keys[j]=m->keys[j+1]; m->vals[j]=m->vals[j+1]; }
  m->len--; return 1;
}
void ts_map_clear(tsv mv){
  if (ts_is_map(mv)){
    ts_map* m=ts_ptr(mv); m->len=0; m->tombs=0;
    if (m->index) memset(m->index, 0, sizeof(uint32_t)*m->index_cap);
  }
}
double ts_map_size(tsv mv){
  if (!ts_is_map(mv)) return 0;
  ts_map* m = ts_ptr(mv);
  return (double)(m->len - m->tombs);
}
tsv ts_map_keys(tsv mv){
  ts_gc_root(&mv);
  tsv arr=ts_new_array(0);
  if (ts_is_map(mv)){
    ts_gc_root(&arr);
    ts_map* m=ts_ptr(mv);
    for (uint32_t i=0;i<m->len;i++){
      if (m->keys[i] == TS_MAPSET_HOLE) continue;
      ts_array_push(arr, m->keys[i]); m=ts_ptr(mv);
    }
    ts_gc_unroot(1);
  }
  ts_gc_unroot(1);
  return arr;
}
/* Map.prototype.entries(): array of [key,value] pairs in insertion order. */
tsv ts_map_entries(tsv mv){
  ts_gc_root(&mv);
  tsv arr=ts_new_array(0);
  if (ts_is_map(mv)){
    ts_gc_root(&arr);
    ts_map* m=ts_ptr(mv);
    uint32_t len=m->len;
    for (uint32_t i=0;i<len;i++){
      m=ts_ptr(mv);
      tsv key=(i<m->len)?m->keys[i]:TS_UNDEFINED;
      tsv val=(i<m->len)?m->vals[i]:TS_UNDEFINED;
      if (key == TS_MAPSET_HOLE) continue;
      tsv pair=ts_new_array(0);
      ts_gc_root(&pair);
      ts_array_push(pair, key); ts_array_push(pair, val);
      ts_array_push(arr, pair);
      ts_gc_unroot(1);
    }
    ts_gc_unroot(1);
  }
  ts_gc_unroot(1);
  return arr;
}
tsv ts_map_values(tsv mv){
  ts_gc_root(&mv);
  tsv arr=ts_new_array(0);
  if (ts_is_map(mv)){
    ts_gc_root(&arr);
    ts_map* m=ts_ptr(mv);
    for (uint32_t i=0;i<m->len;i++){
      if (m->keys[i] == TS_MAPSET_HOLE) continue;
      ts_array_push(arr, m->vals[i]); m=ts_ptr(mv);
    }
    ts_gc_unroot(1);
  }
  ts_gc_unroot(1);
  return arr;
}
void ts_map_foreach(tsv mv, tsv cb){
  if (!ts_is_map(mv)) return;
  ts_map* m=ts_ptr(mv);
  uint32_t len=m->len;
  ts_gc_root(&mv); ts_gc_root(&cb);
  for (uint32_t i=0;i<len;i++){
    m=ts_ptr(mv);
    if (i >= m->len) break; /* shrunk during iteration (linear-mode delete shifts) */
    tsv val=m->vals[i];
    tsv key=m->keys[i];
    if (key == TS_MAPSET_HOLE) continue; /* deleted during/before iteration */
    tsv args[2]={ val, key };
    ts_call_value(cb,args,2);
  }
  ts_gc_unroot(2);
}

static long set_find(ts_set_t* s, tsv v){
  RT_STAT_INC(map_find_calls);
  if (s->index) return mapset_probe(s->index, s->index_cap, s->elems, v, sv0_hash(v), NULL);
  for (uint32_t i=0;i<s->len;i++){
    if (s->elems[i] == TS_MAPSET_HOLE) continue;
    if (same_value_zero(s->elems[i], v)){
      RT_STAT_ADD(map_find_probes, i+1); RT_STAT_HIST(map_find_hist, i+1);
      return (long)i;
    }
  }
  RT_STAT_ADD(map_find_probes, s->len); RT_STAT_HIST(map_find_hist, s->len+1);
  return -1;
}
static void set_grow(ts_set_t* s){
  if (s->len < s->cap) return;
  uint32_t nc = s->cap ? s->cap*2 : 8;
  s->elems = realloc(s->elems, sizeof(tsv)*nc); s->cap = nc;
}
static void set_compact(ts_set_t* s){
  uint32_t w = 0;
  for (uint32_t i = 0; i < s->len; i++){
    if (s->elems[i] == TS_MAPSET_HOLE) continue;
    s->elems[w++] = s->elems[i];
  }
  s->len = w; s->tombs = 0;
  if (s->index){
    uint32_t* nw = mapset_index_build(s->elems, s->len, &s->index_cap);
    if (nw){ free(s->index); s->index = nw; }
  }
}
tsv ts_set_add(tsv sv, tsv v){
  if (!ts_is_set(sv)) return sv;
  ts_set_t* s = ts_ptr(sv);
  uint32_t slot = 0;
  long i;
  if (s->index){ RT_STAT_INC(map_find_calls); i = mapset_probe(s->index, s->index_cap, s->elems, v, sv0_hash(v), &slot); }
  else i = set_find(s, v);
  if (i >= 0) return sv;                   /* dedup */
  set_grow(s); s->elems[s->len++]=v;
  if (s->index) s->index[slot] = (s->len - 1u) + 2u;
  mapset_index_maintain(s->elems, s->len, s->tombs, &s->index, &s->index_cap);
  ts_write_barrier(sv, v); return sv;
}
int ts_set_has(tsv sv, tsv v){ return ts_is_set(sv) && set_find(ts_ptr(sv), v) >= 0; }
int ts_set_delete(tsv sv, tsv v){
  if (!ts_is_set(sv)) return 0;
  ts_set_t* s = ts_ptr(sv);
  uint32_t slot = 0;
  long i;
  if (s->index){
    RT_STAT_INC(map_find_calls);
    i = mapset_probe(s->index, s->index_cap, s->elems, v, sv0_hash(v), &slot);
    if (i < 0) return 0;
    s->index[slot] = 1u; /* tombstone */
    s->elems[i] = TS_MAPSET_HOLE;
    s->tombs++;
    if (s->tombs > 64u && s->tombs * 2u >= s->len) set_compact(s);
    return 1;
  }
  i = set_find(s, v);
  if (i < 0) return 0;
  for (uint32_t j=(uint32_t)i; j+1<s->len; j++) s->elems[j]=s->elems[j+1];
  s->len--; return 1;
}
void ts_set_clear(tsv sv){
  if (ts_is_set(sv)){
    ts_set_t* s=ts_ptr(sv); s->len=0; s->tombs=0;
    if (s->index) memset(s->index, 0, sizeof(uint32_t)*s->index_cap);
  }
}
double ts_set_size(tsv sv){
  if (!ts_is_set(sv)) return 0;
  ts_set_t* s = ts_ptr(sv);
  return (double)(s->len - s->tombs);
}
tsv ts_set_keys(tsv sv){
  return ts_set_values(sv);
}
tsv ts_set_values(tsv sv){
  ts_gc_root(&sv);
  tsv arr=ts_new_array(0);
  if (ts_is_set(sv)){
    ts_gc_root(&arr);
    ts_set_t* s=ts_ptr(sv);
    for (uint32_t i=0;i<s->len;i++){
      if (s->elems[i] == TS_MAPSET_HOLE) continue;
      ts_array_push(arr, s->elems[i]); s=ts_ptr(sv);
    }
    ts_gc_unroot(1);
  }
  ts_gc_unroot(1);
  return arr;
}
tsv ts_set_entries(tsv sv){
  ts_gc_root(&sv);
  tsv arr=ts_new_array(0);
  if (ts_is_set(sv)){
    ts_gc_root(&arr);
    ts_set_t* s=ts_ptr(sv);
    uint32_t len=s->len;
    for (uint32_t i=0;i<len;i++){
      s=ts_ptr(sv);
      tsv elem=(i<s->len)?s->elems[i]:TS_UNDEFINED;
      if (elem == TS_MAPSET_HOLE) continue;
      tsv pair=ts_new_array(0);
      ts_gc_root(&pair);
      ts_array_push(pair, elem); ts_array_push(pair, elem);
      ts_array_push(arr, pair);
      ts_gc_unroot(1);
    }
    ts_gc_unroot(1);
  }
  ts_gc_unroot(1);
  return arr;
}
void ts_set_foreach(tsv sv, tsv cb){
  if (!ts_is_set(sv)) return;
  ts_set_t* s=ts_ptr(sv);
  uint32_t len=s->len;
  ts_gc_root(&sv); ts_gc_root(&cb);
  for (uint32_t i=0;i<len;i++){
    s=ts_ptr(sv);
    if (i >= s->len) break; /* shrunk during iteration (linear-mode delete shifts) */
    tsv elem=s->elems[i];
    if (elem == TS_MAPSET_HOLE) continue; /* deleted during/before iteration */
    tsv args[2]={ elem, elem };
    ts_call_value(cb,args,2);
  }
  ts_gc_unroot(2);
}

/* ---------------- Math (libm-backed) ---------------- */
/* JS Math.round: round half up (toward +Inf), unlike C round() which rounds
   half away from zero. Math.round(-0.5) === -0 (=> 0), Math.round(2.5) === 3. */
double ts_math_round(double x){
  double r = floor(x + 0.5);
  /* JS Math.round preserves the sign of zero: x in [-0.5, -0] rounds to -0, but
     floor(x+0.5) yields +0. Restore the negative sign for those inputs. */
  if (r == 0.0 && (x < 0.0 || signbit(x))) return -0.0;
  return r;
}
double ts_math_sign(double x){ if (x>0) return 1; if (x<0) return -1; return x; /* +-0 or NaN */ }
double ts_math_trunc(double x){ return trunc(x); }
double ts_math_max2(double a, double b){ if (a!=a||b!=b) return NAN; return a>b?a:b; }
double ts_math_min2(double a, double b){ if (a!=a||b!=b) return NAN; return a<b?a:b; }
double ts_math_cbrt(double x){
  /* glibc's cbrt is not correctly rounded (cbrt(27) -> 3.0000000000000004),
     while V8 returns the correctly-rounded result. One Newton step toward
     y^3 == x sharpens the libm seed to the V8-matching value. */
  if (x == 0.0 || !isfinite(x)) return cbrt(x);
  double y = cbrt(x);
  y = y - (y*y*y - x) / (3.0 * y * y);
  return y;
}
/* Math.clz32: count leading zeros of ToUint32(x). */
double ts_math_clz32(double x){
  uint32_t u;
  if (x != x || x == 0.0) u = 0;            /* NaN/0 -> ToUint32 = 0 -> 32 */
  else { double m = fmod(x, 4294967296.0); if (m < 0) m += 4294967296.0; u = (uint32_t)m; }
  if (u == 0) return 32;
  int n = 0; while (!(u & 0x80000000u)){ u <<= 1; n++; }
  return (double)n;
}
double ts_math_imul(double a, double b){
  uint32_t ua = ts_to_uint32(a);
  uint32_t ub = ts_to_uint32(b);
  return (double)(int32_t)(ua * ub);
}
static uint64_t ts_rshift_round_even_u64(uint64_t x, int shift){
  if (shift <= 0) return shift == 0 ? x : (x << -shift);
  if (shift >= 64) return 0;
  uint64_t q = x >> shift;
  uint64_t rem = x & ((1ULL << shift) - 1ULL);
  uint64_t half = 1ULL << (shift - 1);
  if (rem > half || (rem == half && (q & 1ULL))) q++;
  return q;
}
static uint16_t ts_double_to_f16_bits(double x){
  uint64_t bits;
  memcpy(&bits, &x, sizeof(bits));
  uint16_t sign = (uint16_t)((bits >> 48) & 0x8000u);
  int exp = (int)((bits >> 52) & 0x7ffu);
  uint64_t frac = bits & ((1ULL << 52) - 1ULL);
  if (exp == 0x7ff) return frac == 0 ? (uint16_t)(sign | 0x7c00u) : 0x7e00u;
  if (exp == 0 && frac == 0) return sign;

  int e;
  uint64_t mant;
  if (exp == 0) {
    e = -1022;
    mant = frac;
  } else {
    e = exp - 1023;
    mant = (1ULL << 52) | frac;
  }

  int half_exp = e + 15;
  if (half_exp >= 31) return (uint16_t)(sign | 0x7c00u);
  if (half_exp <= 0) {
    uint64_t k = ts_rshift_round_even_u64(mant, 28 - e);
    if (k == 0) return sign;
    if (k >= 1024) return (uint16_t)(sign | 0x0400u);
    return (uint16_t)(sign | (uint16_t)k);
  }

  uint64_t half_mant = frac >> 42;
  uint64_t rem = frac & ((1ULL << 42) - 1ULL);
  uint64_t halfway = 1ULL << 41;
  if (rem > halfway || (rem == halfway && (half_mant & 1ULL))) half_mant++;
  if (half_mant == 0x400u) {
    half_mant = 0;
    half_exp++;
    if (half_exp >= 31) return (uint16_t)(sign | 0x7c00u);
  }
  return (uint16_t)(sign | ((uint16_t)half_exp << 10) | (uint16_t)half_mant);
}
static double ts_f16_bits_to_double(uint16_t h){
  int sign = h & 0x8000u;
  int exp = (h >> 10) & 0x1fu;
  int mant = h & 0x03ffu;
  double v;
  if (exp == 0) {
    if (mant == 0) return sign ? -0.0 : 0.0;
    v = ldexp((double)mant, -24);
  } else if (exp == 31) {
    if (mant == 0) return sign ? -INFINITY : INFINITY;
    return NAN;
  } else {
    v = ldexp(1.0 + ((double)mant / 1024.0), exp - 15);
  }
  return sign ? -v : v;
}
double ts_math_f16round(double x){
  return ts_f16_bits_to_double(ts_double_to_f16_bits(x));
}
double ts_math_log2(double x){ return log2(x); }
double ts_math_log10(double x){ return log10(x); }
double ts_math_hypot2(double a, double b){ return hypot(a,b); }
/* Array-argument forms for Math.max/min/hypot(...spread). Each element is
   ToNumber-coerced; max/min propagate NaN. Identity: -Inf / +Inf / 0. */
double ts_math_max_arr(tsv arr){
  ts_array* a=as_arr(arr); double m=-1.0/0.0;
  if(a) for(uint32_t i=0;i<a->len;i++){ double x=ts_number_coerce(a->data[i]); if(x!=x) return NAN; if(x>m) m=x; }
  return m;
}
double ts_math_min_arr(tsv arr){
  ts_array* a=as_arr(arr); double m=1.0/0.0;
  if(a) for(uint32_t i=0;i<a->len;i++){ double x=ts_number_coerce(a->data[i]); if(x!=x) return NAN; if(x<m) m=x; }
  return m;
}
double ts_math_hypot_arr(tsv arr){
  ts_array* a=as_arr(arr); double s=0;
  if(a) for(uint32_t i=0;i<a->len;i++){ double x=ts_number_coerce(a->data[i]); s+=x*x; }
  return sqrt(s);
}
double ts_math_random(void){ return (double)rand() / ((double)RAND_MAX + 1.0); }

/* ---------------- Number ---------------- */
int ts_number_is_integer(tsv v){
  if (!ts_is_num(v)) return 0;
  double d=ts_to_num(v); return isfinite(d) && floor(d)==d;
}
int ts_number_is_finite(tsv v){ return ts_is_num(v) && isfinite(ts_to_num(v)); }
int ts_number_is_nan(tsv v){ if(!ts_is_num(v)) return 0; double d=ts_to_num(v); return d!=d; }
int ts_number_is_safe_integer(tsv v){
  if (!ts_is_num(v)) return 0;
  double d=ts_to_num(v);
  return isfinite(d) && floor(d)==d && d>=-9007199254740991.0 && d<=9007199254740991.0;
}
/* Number(x) coercion to a double value. Strings parse like JS Number(). */
double ts_number_coerce(tsv v){
  if (ts_is_num(v)) return ts_to_num(v);
  if (ts_is_bool(v)) return (double)(v & 1);
  if (ts_is_null(v)) return 0;
  if (ts_is_undef(v)) return NAN;
  if (ts_is_str(v)){
    uint32_t slen=0;
    char* copy=ts_string_cstr_copy(v, &slen);
    if (slen==0){ free(copy); return 0; } /* Number("") === 0 */
    /* JS-specific binary/octal prefixes (strtod handles 0x but not 0b/0o). */
    const char* q=copy;
    while (*q==' '||*q=='\t'||*q=='\n'||*q=='\r'||*q=='\v'||*q=='\f') q++;
    if (q[0]=='0' && (q[1]=='b'||q[1]=='B'||q[1]=='o'||q[1]=='O')){
      int base = (q[1]=='b'||q[1]=='B') ? 2 : 8;
      char* end=NULL; long long val=strtoll(q+2, &end, base);
      if (end==q+2){ free(copy); return NAN; }   /* no digits after prefix */
      while (*end==' '||*end=='\t'||*end=='\n'||*end=='\r'||*end=='\v'||*end=='\f') end++;
      if (*end!=0){ free(copy); return NAN; }
      free(copy);
      return (double)val;
    }
    char* end=NULL; double d=strtod(copy, &end);
    while (end && *end==' ') end++;
    if (end && *end!=0){ free(copy); return NAN; }
    free(copy);
    return d;
  }
  /* object: ToPrimitive(number) via Symbol.toPrimitive / valueOf / toString,
     then coerce the resulting primitive. (Symbols are not numerically coercible.) */
  if (ts_object_like(v) && !ts_is_symbol(v)){
    tsv p = ts_to_primitive(v, /*string_hint*/0);
    if (!ts_is_obj(p)) return ts_number_coerce(p);
  }
  return NAN;
}
/* parseInt/parseFloat (global). parseInt supports an optional radix. */
double ts_parse_float(tsv v){
  if (ts_is_num(v)) return ts_to_num(v);
  if (!ts_is_str(v)) return NAN;
  char* copy=ts_string_cstr_copy(v, NULL); char* end=NULL; double d=strtod(copy,&end);
  int empty = (end==copy);
  free(copy);
  return empty ? NAN : d;
}
double ts_parse_int(tsv v, double radix){
  if (!ts_is_str(v)){ double d = ts_is_num(v)?ts_to_num(v):NAN; return (d!=d)?NAN:trunc(d); }
  char* copy=ts_string_cstr_copy(v, NULL);
  const char* p = copy;
  while (*p==' '||*p=='\t'||*p=='\n'||*p=='\r') p++;  /* skip leading whitespace */
  int sign = 1;
  if (*p=='+' ) p++; else if (*p=='-'){ sign=-1; p++; }
  int base=(int)radix;
  /* JS: radix 0/undefined -> auto-detect "0x"/"0X" as hex (base 16), else 10.
     (Unlike C strtol base 0, a leading "0" alone is decimal, not octal.) */
  if (base==0){
    if (p[0]=='0' && (p[1]=='x'||p[1]=='X')){ base=16; p+=2; }
    else base=10;
  } else if (base==16 && p[0]=='0' && (p[1]=='x'||p[1]=='X')){ p+=2; }
  /* JS requires a valid digit immediately after the optional sign — strtol would
     otherwise skip whitespace / consume another sign (parseInt("- 5") -> NaN). */
  if (*p==' '||*p=='\t'||*p=='\n'||*p=='\r'||*p=='\v'||*p=='\f'||*p=='+'||*p=='-'){ free(copy); return NAN; }
  char* end=NULL; long val=strtol(p,&end,base);
  /* parseInt("-0") === -0 (and "-0.9", etc.): a negative sign with a zero
     magnitude yields negative zero, not +0. */
  double out = (end==p) ? NAN : (sign < 0 && val == 0) ? -0.0 : (double)(sign*val);
  free(copy);
  return out;
}

static long long ts_regexp_last_index_value(tsv re, uint32_t key){
  double d = ts_number_coerce(ts_get(re, key));
  if (!(d > 0.0) || !isfinite(d)) return 0;
  if (d > 2147483647.0) return 2147483647LL;
  return (long long)floor(d);
}

static int ts_regexp_litprefix_exec_obj(tsv re, tsv input, int use_last_index,
                                        int update_last_index,
                                        ts_regexp_litprefix_match* out){
  if (!ts_is_propbag(re) || !ts_is_str(input)) return 0;
  ts_regexp_ensure_keys();
  int global = ts_truthy(ts_get(re, g_rx_k_global));
  int sticky = ts_truthy(ts_get(re, g_rx_k_sticky));
  int anchor = ts_truthy(ts_get(re, g_rx_k_anchor));
  long long start = (use_last_index && (global || sticky)) ? ts_regexp_last_index_value(re, g_rx_k_last_index) : 0;
  tsv prefix = ts_get(re, g_rx_k_prefix);
  if (!ts_is_str(prefix)) return 0;
  ts_strview xs = ts_str_view_typed(input);
  ts_strview ps = ts_str_view_typed(prefix);
  int matched = 0;
  ts_regexp_litprefix_match m = {0, 0};
  if ((global || sticky) && start > (long long)xs.len){
    matched = 0;
  } else if (anchor && start != 0){
    matched = 0;
  } else {
    matched = ts_regexp_litprefix_find_view(xs, ps, start, sticky || anchor, &m);
  }
  if (update_last_index && (global || sticky)){
    ts_set(re, g_rx_k_last_index, ts_num(matched ? (double)m.end : 0.0));
  }
  if (matched && out) *out = m;
  return matched;
}

static tsv ts_regexp_exec_indices_single(ts_regexp_litprefix_match m){
  tsv indices = ts_new_array(0);
  ts_gc_root(&indices);
  tsv pair = ts_new_array(0);
  ts_gc_root(&pair);
  ts_array_push(pair, ts_num((double)m.start));
  ts_array_push(pair, ts_num((double)m.end));
  ts_array_push(indices, pair);
  ts_set(indices, ts_intern_field("groups", 6), TS_UNDEFINED);
  ts_gc_unroot(2);
  return indices;
}

static tsv ts_regexp_exec_result_single(tsv input, ts_regexp_litprefix_match m, int has_indices){
  ts_gc_root(&input);
  tsv arr = ts_new_array(0);
  ts_gc_root(&arr);
  tsv match = ts_string_slice_view(input, m.start, m.end - m.start);
  ts_gc_root(&match);
  ts_array_push(arr, match);
  ts_set(arr, ts_intern_field("index", 5), ts_num((double)m.start));
  ts_set(arr, ts_intern_field("input", 5), input);
  ts_set(arr, ts_intern_field("groups", 6), TS_UNDEFINED);
  if (has_indices){
    tsv indices = ts_regexp_exec_indices_single(m);
    ts_gc_root(&indices);
    ts_set(arr, ts_intern_field("indices", 7), indices);
    ts_gc_unroot(1);
  }
  ts_gc_unroot(3);
  return arr;
}

static uint32_t ts_regexp_advance_string_index_fast(tsv input, uint32_t index, int full_unicode){
  ts_strview xs = ts_str_view_typed(input);
  if (!full_unicode || index + 1u >= xs.len) return index + 1u;
  uint16_t hi = ts_str_cu_at_view(xs, index);
  if (hi >= 0xD800u && hi <= 0xDBFFu){
    uint16_t lo = ts_str_cu_at_view(xs, index + 1u);
    if (lo >= 0xDC00u && lo <= 0xDFFFu) return index + 2u;
  }
  return index + 1u;
}

tsv ts_regexp_object_test_fast(tsv re, tsv input){
  ts_gc_root(&re);
  ts_gc_root(&input);
  int matched = ts_regexp_litprefix_exec_obj(re, input, 1, 1, NULL);
  ts_gc_unroot(2);
  return ts_bool(matched);
}

double ts_regexp_object_search_fast(tsv input, tsv re){
  ts_gc_root(&input);
  ts_gc_root(&re);
  ts_regexp_litprefix_match m = {0, 0};
  int matched = ts_regexp_litprefix_exec_obj(re, input, 0, 0, &m);
  ts_gc_unroot(2);
  return matched ? (double)m.start : -1.0;
}

tsv ts_regexp_object_exec_fast(tsv re, tsv input){
  ts_gc_root(&re);
  ts_gc_root(&input);
  ts_regexp_litprefix_match m = {0, 0};
  int matched = ts_regexp_litprefix_exec_obj(re, input, 1, 1, &m);
  ts_regexp_ensure_keys();
  tsv flagsv = ts_get(re, g_rx_k_flags_mask);
  uint32_t flags = ts_is_num(flagsv) ? (uint32_t)ts_to_num(flagsv) : 0u;
  tsv result = matched ? ts_regexp_exec_result_single(input, m, (flags & (1u << 6)) != 0) : TS_NULL;
  ts_gc_unroot(2);
  return result;
}

tsv ts_regexp_object_match_fast(tsv re, tsv input){
  ts_gc_root(&re);
  ts_gc_root(&input);
  if (!ts_is_str(input)){
    ts_gc_unroot(2);
    return TS_NULL;
  }
  ts_regexp_ensure_keys();
  int global = ts_truthy(ts_get(re, g_rx_k_global));
  if (!global){
    tsv result = ts_regexp_object_exec_fast(re, input);
    ts_gc_unroot(2);
    return result;
  }

  tsv flagsv = ts_get(re, g_rx_k_flags_mask);
  uint32_t flags = ts_is_num(flagsv) ? (uint32_t)ts_to_num(flagsv) : 0u;
  int full_unicode = (flags & ((1u << 4) | (1u << 7))) != 0;
  ts_set(re, g_rx_k_last_index, ts_num(0.0));
  tsv arr = ts_new_array(0);
  ts_gc_root(&arr);
  uint32_t count = 0;
  for (;;){
    ts_regexp_litprefix_match m = {0, 0};
    if (!ts_regexp_litprefix_exec_obj(re, input, 1, 1, &m)) break;
    tsv part = ts_string_slice_view(input, m.start, m.end - m.start);
    ts_gc_root(&part);
    ts_array_push(arr, part);
    ts_gc_unroot(1);
    count++;
    if (m.end == m.start){
      ts_set(re, g_rx_k_last_index,
             ts_num((double)ts_regexp_advance_string_index_fast(input, m.end, full_unicode)));
    }
  }
  ts_set(re, g_rx_k_last_index, ts_num(0.0));
  tsv result = count ? arr : TS_NULL;
  ts_gc_unroot(3);
  return result;
}

/* number.toFixed(digits) -> string */
tsv ts_number_tofixed(double x, double digits){
  int d=(int)digits; if (d<0) d=0; if (d>100) d=100;
  char buf[360]; snprintf(buf,sizeof(buf),"%.*f", d, x);
  return ts_new_string(buf,(uint32_t)strlen(buf));
}

/* ---------------- Date ---------------- */
/* A Date is a heap object (TS_KIND_OBJECT) carrying its epoch-ms as a single
   numeric property at key 0. Minimal: now/getTime/valueOf. */
tsv ts_date_now_ms(void){
  struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts);
  return ts_num((double)ts.tv_sec*1000.0 + (double)ts.tv_nsec/1.0e6);
}
/* new Date(year, month, day, hours, minutes, seconds, ms) in LOCAL time -> epoch
   ms. mktime interprets the broken-down fields as local time and normalizes
   overflow (matching JS component-Date semantics). Years 0..99 map to 1900..1999
   like JS. */
double ts_date_from_components(double y,double mo,double d,double h,double mi,double s,double mil){
  struct tm tm; memset(&tm,0,sizeof tm);
  int yr = (int)y;
  tm.tm_year = (yr>=0 && yr<=99) ? yr : yr-1900;
  tm.tm_mon  = (int)mo;
  tm.tm_mday = (int)d;
  tm.tm_hour = (int)h;
  tm.tm_min  = (int)mi;
  tm.tm_sec  = (int)s;
  tm.tm_isdst = -1;                        /* let libc resolve DST */
  time_t t = mktime(&tm);
  return (double)t*1000.0 + mil;
}
/* Extract a Date component from epoch-ms. `which` low nibble selects the field;
   bit 4 (|16) selects the UTC variant. 8 = getTimezoneOffset (minutes). */
double ts_date_component(double ms, int which){
  if (ms != ms) return ms;                 /* Invalid Date -> NaN */
  int utc = which & 16; int w = which & 15;
  time_t secs = (time_t)floor(ms/1000.0);
  struct tm tm;
  if (utc) gmtime_r(&secs,&tm); else localtime_r(&secs,&tm);
  switch (w){
    case 0: return (double)(tm.tm_year+1900);
    case 1: return (double)tm.tm_mon;
    case 2: return (double)tm.tm_mday;
    case 3: return (double)tm.tm_wday;
    case 4: return (double)tm.tm_hour;
    case 5: return (double)tm.tm_min;
    case 6: return (double)tm.tm_sec;
    case 7: { long long m=(long long)floor(ms); long long r=m%1000; if(r<0)r+=1000; return (double)r; }
    case 8: { /* getTimezoneOffset: minutes UTC is ahead of local = -(localoffset) */
      struct tm lt; localtime_r(&secs,&lt); lt.tm_isdst=-1;
      time_t as_utc = timegm(&lt);          /* treat local fields as if UTC */
      return -(double)(as_utc - secs)/60.0;
    }
  }
  return 0;
}
/* toISOString: always UTC, "YYYY-MM-DDTHH:mm:ss.sssZ". */
tsv ts_date_to_iso(double ms){
  if (ms != ms){ fprintf(stderr,"tsaot: RangeError: Invalid time value\n"); abort(); }
  time_t secs=(time_t)floor(ms/1000.0); struct tm tm; gmtime_r(&secs,&tm);
  long long m=(long long)floor(ms); long long msec=m%1000; if(msec<0)msec+=1000;
  char buf[40];
  snprintf(buf,sizeof buf,"%04d-%02d-%02dT%02d:%02d:%02d.%03lldZ",
    tm.tm_year+1900, tm.tm_mon+1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec, msec);
  return ts_new_string(buf,(uint32_t)strlen(buf));
}

/* ---------------- Array: additional methods ---------------- */
/* callback predicates: find/findIndex/some/every. cb(element, index). */
/* String.fromCodePoint(...cps): build JS UTF-16 code units, including surrogate
   pairs for astral code points. */
tsv ts_string_from_code_point(tsv* args, int n){
  uint16_t* units = (uint16_t*)malloc(sizeof(uint16_t) * (size_t)(n>0?n*2:1));
  uint32_t len = 0;
  for (int i=0;i<n;i++){
    double d = ts_to_num(args[i]);
    uint32_t cp = (d!=d) ? 0 : (uint32_t)(long long)d;
    if (cp <= 0xFFFFu){
      units[len++] = (uint16_t)cp;
    } else {
      cp -= 0x10000u;
      units[len++] = (uint16_t)(0xD800u + (cp >> 10));
      units[len++] = (uint16_t)(0xDC00u + (cp & 0x3FFu));
    }
  }
  tsv s = ts_new_string_from_code_units(units, len);
  free(units);
  return s;
}
tsv ts_string_from_char_code(tsv* args, int n){
  uint16_t* units = (uint16_t*)malloc(sizeof(uint16_t) * (size_t)(n>0?n:1));
  uint32_t len = 0;
  for (int i=0;i<n;i++){
    double d = ts_to_num(args[i]);
    unsigned code = (d!=d) ? 0 : (unsigned)(long long)d;
    units[len++] = (uint16_t)(code & 0xFFFFu);
  }
  tsv s = ts_new_string_from_code_units(units, len);
  free(units);
  return s;
}

/* Array.of(...items): build an array from the argument list. */
tsv ts_array_of(tsv* args, int n){
  tsv arr = ts_new_array(0); ts_gc_root(&arr);
  for (int i=0;i<n;i++) ts_array_push(arr, args[i]);
  ts_gc_unroot(1);
  return arr;
}

/* findLast / findLastIndex: scan from the end, return the matching element /
   its index (or undefined / -1). */
tsv ts_array_find(tsv arr, tsv cb){
  ts_array* a=as_arr(arr); if(!a) return TS_UNDEFINED;
  uint32_t len=a->len;
  ts_gc_root(&arr); ts_gc_root(&cb);
  for(uint32_t i=0;i<len;i++){ a=as_arr(arr); tsv elem=(a && i<a->len)?a->data[i]:TS_UNDEFINED; tsv args[2]={elem,ts_num((double)i)};
    if(ts_truthy(ts_call_value(cb,args,2))){ ts_gc_unroot(2); return elem; } }
  ts_gc_unroot(2);
  return TS_UNDEFINED;
}
tsv ts_array_findlast(tsv arr, tsv cb){
  ts_array* a=as_arr(arr); if(!a) return TS_UNDEFINED;
  uint32_t len=a->len;
  ts_gc_root(&arr); ts_gc_root(&cb);
  for(uint32_t i=len; i-- > 0;){ a=as_arr(arr); tsv elem=(a && i<a->len)?a->data[i]:TS_UNDEFINED; tsv args[2]={elem,ts_num((double)i)};
    if(ts_truthy(ts_call_value(cb,args,2))){ ts_gc_unroot(2); return elem; } }
  ts_gc_unroot(2);
  return TS_UNDEFINED;
}
double ts_array_findlastindex(tsv arr, tsv cb){
  ts_array* a=as_arr(arr); if(!a) return -1;
  uint32_t len=a->len;
  ts_gc_root(&arr); ts_gc_root(&cb);
  for(uint32_t i=len; i-- > 0;){ a=as_arr(arr); tsv elem=(a && i<a->len)?a->data[i]:TS_UNDEFINED; tsv args[2]={elem,ts_num((double)i)};
    if(ts_truthy(ts_call_value(cb,args,2))){ ts_gc_unroot(2); return (double)i; } }
  ts_gc_unroot(2);
  return -1;
}

/* flat(depth): flatten nested arrays up to `depth` levels (default 1). */
static void flat_into(tsv out, tsv arr, int depth){
  ts_array* a=as_arr(arr); if(!a) return;
  for(uint32_t i=0;i<a->len;i++){
    a=as_arr(arr);
    tsv e=a->data[i];
    if(depth>0 && ts_is_array(e)) flat_into(out, e, depth-1);
    else ts_array_push(out, e);
  }
}
tsv ts_array_flat(tsv arr, double depth){
  ts_gc_root(&arr);
  tsv out=ts_new_array(0);
  ts_gc_root(&out);
  int d = (depth!=depth) ? 0 : (depth<0?0:(depth>1e9?1000000000:(int)depth));
  flat_into(out, arr, d);
  ts_gc_unroot(2);
  return out;
}

/* flatMap(cb): map each element then flatten the result one level. */
tsv ts_array_flatmap(tsv arr, tsv cb){
  ts_array* a=as_arr(arr); if(!a) return ts_new_array(0);
  ts_gc_root(&arr); ts_gc_root(&cb);
  tsv out=ts_new_array(0);
  ts_gc_root(&out);
  a=as_arr(arr);
  uint32_t len=a ? a->len : 0;
  for(uint32_t i=0;i<len;i++){
    a=as_arr(arr);
    tsv elem = (a && i<a->len) ? a->data[i] : TS_UNDEFINED;
    tsv args[2]={ elem, ts_num((double)i) };
    tsv mapped=ts_call_value(cb, args, 2);
    if(ts_is_array(mapped)){
      ts_gc_root(&mapped);
      uint32_t ml=ts_array_len(mapped);
      for(uint32_t j=0;j<ml;j++) ts_array_push(out, ts_array_get(mapped, j));
      ts_gc_unroot(1);
    } else ts_array_push(out, mapped);
  }
  ts_gc_unroot(3);
  return out;
}
double ts_array_findindex(tsv arr, tsv cb){
  ts_array* a=as_arr(arr); if(!a) return -1;
  uint32_t len=a->len;
  ts_gc_root(&arr); ts_gc_root(&cb);
  for(uint32_t i=0;i<len;i++){ a=as_arr(arr); tsv elem=(a && i<a->len)?a->data[i]:TS_UNDEFINED; tsv args[2]={elem,ts_num((double)i)};
    if(ts_truthy(ts_call_value(cb,args,2))){ ts_gc_unroot(2); return (double)i; } }
  ts_gc_unroot(2);
  return -1;
}
int ts_array_some(tsv arr, tsv cb){
  ts_array* a=as_arr(arr); if(!a) return 0;
  uint32_t len=a->len;
  ts_gc_root(&arr); ts_gc_root(&cb);
  for(uint32_t i=0;i<len;i++){ a=as_arr(arr); tsv elem=(a && i<a->len)?a->data[i]:TS_UNDEFINED; tsv args[2]={elem,ts_num((double)i)};
    if(ts_truthy(ts_call_value(cb,args,2))){ ts_gc_unroot(2); return 1; } }
  ts_gc_unroot(2);
  return 0;
}
int ts_array_every(tsv arr, tsv cb){
  ts_array* a=as_arr(arr); if(!a) return 1;
  uint32_t len=a->len;
  ts_gc_root(&arr); ts_gc_root(&cb);
  for(uint32_t i=0;i<len;i++){ a=as_arr(arr); tsv elem=(a && i<a->len)?a->data[i]:TS_UNDEFINED; tsv args[2]={elem,ts_num((double)i)};
    if(!ts_truthy(ts_call_value(cb,args,2))){ ts_gc_unroot(2); return 0; } }
  ts_gc_unroot(2);
  return 1;
}
double ts_array_lastindexof(tsv arr, tsv v, double from, int has_from){
  ts_array* a=as_arr(arr); if(!a) return -1;
  long n=(long)a->len, s = has_from ? (long)from : n-1;
  if(s<0) s+=n;             /* negative fromIndex counts from the end */
  if(s>=n) s=n-1;
  for(long i=s;i>=0;i--) if(ts_strict_eq(a->data[i],v)) return (double)i;
  return -1;
}
tsv ts_array_at(tsv arr, double idx){
  ts_array* a=as_arr(arr); if(!a) return TS_UNDEFINED;
  long i=(long)idx; if(i<0) i+=(long)a->len;
  if(i<0||i>=(long)a->len) return TS_UNDEFINED;
  return a->data[i];
}
tsv ts_array_reverse(tsv arr){
  ts_array* a=as_arr(arr); if(!a) return arr;
  if (ts_arr_frozen(arr)) return arr;   /* frozen: no mutation */
  for(uint32_t i=0,j=a->len?a->len-1:0; i<j; i++,j--){ tsv t=a->data[i]; a->data[i]=a->data[j]; a->data[j]=t; }
  return arr; /* in place, returns same array */
}
tsv ts_array_shift(tsv arr){
  ts_array* a=as_arr(arr); if(!a||a->len==0) return TS_UNDEFINED;
  if (ts_arr_frozen(arr)) return TS_UNDEFINED;   /* frozen: no mutation */
  tsv v=a->data[0];
  for(uint32_t i=0;i+1<a->len;i++) a->data[i]=a->data[i+1];
  a->len--; return v;
}
double ts_array_unshift(tsv arr, tsv v){
  ts_array* a=as_arr(arr); if(!a) return 0;
  if (ts_arr_frozen(arr)) return (double)a->len;   /* frozen: no mutation */
  ts_array_push(arr, TS_UNDEFINED);           /* grow by one */
  for(long i=(long)a->len-1;i>0;i--) a->data[i]=a->data[i-1];
  a->data[0]=v; ts_write_barrier(arr, v); return (double)a->len;
}
tsv ts_array_fill(tsv arr, tsv v, double start, double end, int has_start, int has_end){
  ts_array* a=as_arr(arr); if(!a) return arr;
  if (ts_arr_frozen(arr)) return arr;   /* frozen: no mutation */
  int64_t len=(int64_t)a->len;
  /* JS fill(value, start=0, end=len): negative indices count from the end and
     are clamped to [0, len]. */
  int64_t s = has_start ? (int64_t)start : 0;
  int64_t e = has_end ? (int64_t)end : len;
  if (s < 0) s += len; if (s < 0) s = 0; if (s > len) s = len;
  if (e < 0) e += len; if (e < 0) e = 0; if (e > len) e = len;
  for(int64_t i=s;i<e;i++) a->data[i]=v;
  ts_write_barrier(arr, v);
  return arr;
}
/* comparison for default sort: numbers ascending; otherwise by string order */
static int default_cmp(tsv a, tsv b){
  /* Default sort comparator (no callback): per spec, undefined sorts to the end,
     and all other elements are compared by their STRING form lexicographically
     (so [3,1,2,10,20].sort() -> 1,10,2,20,3, not numeric order). */
  int au = (a==TS_UNDEFINED), bu = (b==TS_UNDEFINED);
  if(au||bu) return au==bu ? 0 : (au?1:-1);
  tsv sa=ts_to_string_v(a);
  ts_gc_root(&sa);
  tsv sb=ts_to_string_v(b);
  ts_gc_root(&sb);
  ts_strview x=ts_str_view_typed(sa), y=ts_str_view_typed(sb);
  uint32_t n = x.len<y.len?x.len:y.len;
  int c=0;
  for(uint32_t i=0;i<n;i++){
    uint16_t xc=ts_str_cu_at_view(x,i), yc=ts_str_cu_at_view(y,i);
    if(xc!=yc){ c = xc<yc ? -1 : 1; break; }
  }
  int r = c ? (c<0?-1:1) : (x.len<y.len?-1:(x.len>y.len?1:0));
  ts_gc_unroot(2);
  return r;
}
/* insertion sort (stable, simple). With cb!=undefined, use the comparator. */
tsv ts_array_sort(tsv arr, tsv cb){
  ts_array* a=as_arr(arr); if(!a) return arr;
  if (ts_arr_frozen(arr)) return arr;   /* frozen: no mutation */
  int has_cb = ts_is_func(cb);
  ts_gc_root(&arr); ts_gc_root(&cb);
  uint32_t len=a->len;
  for(uint32_t i=1;i<len;i++){
    a=as_arr(arr);
    tsv key=(a && i<a->len) ? a->data[i] : TS_UNDEFINED; long j=(long)i-1;
    while(j>=0){
      a=as_arr(arr);
      int cmp;
      tsv left=(a && (uint32_t)j<a->len) ? a->data[j] : TS_UNDEFINED;
      if(has_cb){ tsv args[2]={left,key}; cmp = (int)ts_to_num(ts_call_value(cb,args,2)); cmp = cmp>0?1:(cmp<0?-1:0); }
      else cmp = default_cmp(left, key);
      a=as_arr(arr);
      if(cmp>0 && a && (uint32_t)(j+1)<a->cap){ a->data[j+1]=left; j--; } else break;
    }
    a=as_arr(arr);
    a->data[j+1]=key;
  }
  ts_gc_unroot(2);
  return arr;
}

/* Shallow-copy an array's elements into a fresh array (same length, element
   identities preserved). Used by the ES2023 change-by-copy methods, which return
   a NEW array and must not mutate the receiver. */
static tsv array_clone(tsv arr){
  ts_array* a=as_arr(arr); if(!a) return ts_new_array(0);
  ts_gc_root(&arr);
  tsv out=ts_new_array(0);
  ts_gc_root(&out);
  a=as_arr(arr);
  for(uint32_t i=0;i<a->len;i++){ ts_array_push(out, a->data[i]); a=as_arr(arr); }
  ts_gc_unroot(2);
  return out;
}
/* ---- built-in Error family prototypes ----------------------------------------
   The Error constructors are exposed as plain functions, but `new Error()` /
   thrown errors need a real prototype chain so `e instanceof Error` works and
   `e.name` is inherited. We keep one prototype object per error kind:
   subtype.prototype -> Error.prototype -> Object.prototype. `name` lives on the
   prototype (JS-accurate: inherited, non-own) and `message` defaults to "". */
/* Error.prototype.toString(): JS produces `name`, `message`, or `name + ": " +
   message` (empty parts dropped). Inherited by all Error subtypes/subclasses, and
   reached by String(e) / `${e}` / e.toString() via ToPrimitive's toString lookup. */
static tsv ts_error_proto_tostring(tsv* args, int n){
  tsv self = (n > 0) ? args[0] : TS_UNDEFINED;
  ts_gc_root(&self);
  tsv namev = ts_get(self, ts_intern_field("name", 4));
  tsv name = ts_is_undef(namev) ? ts_new_string("Error", 5) : ts_to_string_v(namev);
  ts_gc_root(&name);
  tsv msgv = ts_get(self, ts_intern_field("message", 7));
  tsv msg = ts_is_undef(msgv) ? ts_new_string("", 0) : ts_to_string_v(msgv);
  ts_gc_root(&msg);
  tsv result;
  uint32_t nlen = ts_str_view_typed(name).len, mlen = ts_str_view_typed(msg).len;
  if (nlen == 0) result = msg;
  else if (mlen == 0) result = name;
  else {
    tsv sep = ts_new_string(": ", 2);
    ts_gc_root(&sep);
    tsv a = ts_add(name, sep);
    ts_gc_root(&a);
    result = ts_add(a, msg);
    ts_gc_unroot(2);
  }
  ts_gc_unroot(3);
  return result;
}
enum { TS_ERR_ERROR=0, TS_ERR_TYPE, TS_ERR_RANGE, TS_ERR_SYNTAX, TS_ERR_REFERENCE,
       TS_ERR_EVAL, TS_ERR_URI, TS_ERR_AGGREGATE, TS_ERR_KINDS };
static const char* const TS_ERROR_NAMES[TS_ERR_KINDS] = {
  "Error", "TypeError", "RangeError", "SyntaxError",
  "ReferenceError", "EvalError", "URIError", "AggregateError"
};
static tsv g_error_protos[TS_ERR_KINDS];
static int g_error_protos_init = 0;
void ts_setup_error_protos(void){
  if (g_error_protos_init) return;
  g_error_protos_init = 1;
  tsv objproto = ts_object_proto();
  for (int i = 0; i < TS_ERR_KINDS; i++){
    tsv p = ts_new_proto();
    g_error_protos[i] = p;
    ts_gc_root(&g_error_protos[i]);
  }
  /* link parents after all are allocated: Error.prototype -> Object.prototype,
     every subtype -> Error.prototype. */
  for (int i = 0; i < TS_ERR_KINDS; i++){
    ts_object* o = (ts_object*)ts_ptr(g_error_protos[i]);
    o->proto = (i == TS_ERR_ERROR) ? objproto : g_error_protos[TS_ERR_ERROR];
    const char* nm = TS_ERROR_NAMES[i];
    ts_set(g_error_protos[i], ts_intern_field("name", 4), ts_new_string(nm, (uint32_t)strlen(nm)));
    ts_set(g_error_protos[i], ts_intern_field("message", 7), ts_new_string("", 0));
  }
  // Error.prototype.toString (inherited by subtypes). Registered under the same
  // method key ToPrimitive consults; the global-object setup that triggers this
  // init runs after the object-proto setup, so g_tostring_key is already set.
  if (g_tostring_key)
    ts_proto_register_method(g_error_protos[TS_ERR_ERROR], g_tostring_key, "toString", ts_error_proto_tostring);
}
tsv ts_error_proto(int kind){
  ts_setup_error_protos();
  if (kind < 0 || kind >= TS_ERR_KINDS) kind = TS_ERR_ERROR;
  return g_error_protos[kind];
}
/* Construct an Error-family instance with the proper prototype. `msg` undefined
   leaves message inherited (""); otherwise an own `message` is set (ToString). */
tsv ts_new_error(int kind, tsv msg){
  if (kind < 0 || kind >= TS_ERR_KINDS) kind = TS_ERR_ERROR;
  ts_setup_error_protos();
  ts_gc_root(&msg);
  tsv e = ts_new_object();
  ((ts_object*)ts_ptr(e))->proto = g_error_protos[kind];
  ts_write_barrier(e, g_error_protos[kind]);
  if (!ts_is_undef(msg)){
    ts_gc_root(&e);
    /* `message` is an own data property but NON-enumerable (JS semantics): it must
       not show up in Object.keys / JSON.stringify of the error. */
    ts_define_data(e, ts_intern_field("message", 7), ts_to_string_v(msg), 0, 1, 1);
    ts_gc_unroot(1);
  }
  ts_gc_unroot(1);
  return e;
}
/* Throw a RangeError-tagged object (catchable): { message, name:"RangeError" },
   matching the surface that `new RangeError(msg)` produces (see exporter's Error
   lowering) so a catch clause can read e.name / e.message. */
static void ts_throw_range_error(const char* msg){
  ts_throw(ts_new_error(TS_ERR_RANGE, ts_new_string(msg,(uint32_t)strlen(msg))));
}
static void ts_throw_type_error(const char* msg){
  ts_throw(ts_new_error(TS_ERR_TYPE, ts_new_string(msg,(uint32_t)strlen(msg))));
}
static void ts_throw_syntax_error(const char* msg){
  ts_throw(ts_new_error(TS_ERR_SYNTAX, ts_new_string(msg,(uint32_t)strlen(msg))));
}
void ts_throw_type_error_msg(const char* msg){ ts_throw_type_error(msg ? msg : "TypeError"); }
void ts_throw_syntax_error_msg(const char* msg){ ts_throw_syntax_error(msg ? msg : "SyntaxError"); }
void ts_throw_range_error_msg(const char* msg){ ts_throw_range_error(msg ? msg : "RangeError"); }
void ts_throw_not_a_function(const char* name){
  char buf[160];
  if (name) snprintf(buf, sizeof buf, "%s is not a function", name);
  else      snprintf(buf, sizeof buf, "value is not a function");
  ts_throw_type_error(buf);
}
/* Array.prototype.toSorted(comparator?): a NEW sorted array; receiver unchanged.
   Clones first, then sorts the clone in place via ts_array_sort (same comparator
   semantics as sort, so behaviour matches exactly). */
tsv ts_array_tosorted(tsv arr, tsv cb){
  /* root `cb` across array_clone (which allocates -> may GC) so a comparator
     closure isn't collected before the sort uses it. */
  ts_gc_root(&cb);
  tsv out=array_clone(arr);
  ts_gc_root(&out);
  ts_array_sort(out, cb);            /* may invoke the comparator (GC) */
  ts_gc_unroot(2);
  return out;
}
/* Array.prototype.toReversed(): a NEW reversed array; receiver unchanged. */
tsv ts_array_toreversed(tsv arr){
  tsv out=array_clone(arr);
  ts_array_reverse(out);
  return out;
}
/* Array.prototype.with(index, value): a NEW array with element `index` replaced by
   `value`. Negative index counts from the end. Out-of-range -> RangeError (JS). */
tsv ts_array_with(tsv arr, double idx, tsv val){
  ts_array* a=as_arr(arr); if(!a) return ts_new_array(0);
  long n=(long)a->len;
  long i=(long)idx; if(i<0) i+=n;
  if(i<0 || i>=n){ char buf[64]; snprintf(buf,sizeof buf,"Invalid index : %ld",(long)idx); ts_throw_range_error(buf); }
  /* root `val` across array_clone (which allocates -> may GC) so a heap value
     passed in isn't collected before we store it. */
  ts_gc_root(&val);
  tsv out=array_clone(arr);
  ts_gc_unroot(1);
  ts_array* o=as_arr(out);
  o->data[i]=val;
  return out;
}
/* Array.prototype.toSpliced(start, deleteCount?, ...items): a NEW array with the
   splice applied; receiver unchanged. Same start/deleteCount clamping as splice;
   `items` is passed as an array (possibly empty). */
tsv ts_array_tospliced(tsv arr, double start, double dc, int has_dc, tsv items){
  ts_array* a=as_arr(arr); if(!a) return ts_new_array(0);
  ts_gc_root(&arr); ts_gc_root(&items);
  tsv out=ts_new_array(0);
  ts_gc_root(&out);
  a=as_arr(arr);
  long n=(long)a->len;
  long s=(long)start; if(s<0){ s+=n; if(s<0)s=0; } if(s>n) s=n;
  long del = has_dc ? (long)dc : (n-s); if(del<0) del=0; if(del>n-s) del=n-s;
  a=as_arr(arr);
  for(long i=0;i<s;i++){ ts_array_push(out, a->data[i]); a=as_arr(arr); }
  ts_array* it=as_arr(items);
  if(it) for(uint32_t i=0;i<it->len;i++){ ts_array_push(out, it->data[i]); it=as_arr(items); }
  a=as_arr(arr);
  for(long i=s+del;i<n;i++){ ts_array_push(out, a->data[i]); a=as_arr(arr); }
  ts_gc_unroot(3);
  return out;
}

/* ---------------- String: additional methods ---------------- */
int ts_str_startswith(tsv s, tsv pre, double pos, int has_pos){
  ts_string *x=as_str(s),*p=as_str(pre); if(!x||!p) return 0;
  ts_strview xs=ts_str_view_typed(s), ps=ts_str_view_typed(pre);
  long start = has_pos ? (long)pos : 0; if(start<0) start=0; if(start>(long)x->len) start=(long)x->len;
  if((long)ps.len > (long)xs.len - start) return 0;
  return ts_str_region_eq(xs, (uint32_t)start, ps, 0, ps.len);
}
int ts_str_endswith(tsv s, tsv suf, double endpos, int has_endpos){
  ts_string *x=as_str(s),*p=as_str(suf); if(!x||!p) return 0;
  ts_strview xs=ts_str_view_typed(s), ps=ts_str_view_typed(suf);
  long end = has_endpos ? (long)endpos : (long)x->len;
  if(end<0) end=0; if(end>(long)x->len) end=(long)x->len;
  if((long)ps.len > end) return 0;
  return ts_str_region_eq(xs, (uint32_t)(end-(long)ps.len), ps, 0, ps.len);
}
tsv ts_str_padstart(tsv s, double target, tsv pad){
  ts_string *x=as_str(s); if(!x) return s;
  ts_string *p=as_str(pad);
  ts_strview xs=ts_str_view_typed(s), ps={0};
  if(p) ps=ts_str_view_typed(pad);
  long t=(long)target; if(t<=(long)xs.len) return s;
  uint32_t need=(uint32_t)t - x->len;
  ts_gc_root(&s); ts_gc_root(&pad);
  xs=ts_str_view_typed(s); p=as_str(pad); if(p) ps=ts_str_view_typed(pad);
  uint32_t flags = (xs.flags | (p ? ps.flags : 0u)) & TS_STR_FLAG_UTF16;
  ts_string* y=ts_string_alloc_storage((uint32_t)t, flags); y->len=(uint32_t)t;
  uint32_t pl=p&&ps.len?ps.len:1;
  for(uint32_t i=0;i<need;i++){
    uint16_t cu = p&&ps.len ? ts_str_cu_at_view(ps, i%pl) : (uint16_t)' ';
    ts_str_cu_set(y->data, flags, i, cu);
  }
  ts_str_copy_units(y->data, flags, need, xs, 0, xs.len);
  y->flags=strflags_storage(y->data,flags,(uint32_t)t); y->hash=strhash_units(y->data,y->flags,(uint32_t)t);
  y->parent=TS_UNDEFINED; y->offset=0;
  tsv r=ts_str_v(y); ts_gc_unroot(2); return r;
}
tsv ts_str_padend(tsv s, double target, tsv pad){
  ts_string *x=as_str(s); if(!x) return s;
  ts_string *p=as_str(pad);
  ts_strview xs=ts_str_view_typed(s), ps={0};
  if(p) ps=ts_str_view_typed(pad);
  long t=(long)target; if(t<=(long)xs.len) return s;
  uint32_t need=(uint32_t)t - x->len;
  ts_gc_root(&s); ts_gc_root(&pad);
  xs=ts_str_view_typed(s); p=as_str(pad); if(p) ps=ts_str_view_typed(pad);
  uint32_t flags = (xs.flags | (p ? ps.flags : 0u)) & TS_STR_FLAG_UTF16;
  ts_string* y=ts_string_alloc_storage((uint32_t)t, flags); y->len=(uint32_t)t;
  uint32_t pl=p&&ps.len?ps.len:1;
  ts_str_copy_units(y->data, flags, 0, xs, 0, xs.len);
  for(uint32_t i=0;i<need;i++){
    uint16_t cu = p&&ps.len ? ts_str_cu_at_view(ps, i%pl) : (uint16_t)' ';
    ts_str_cu_set(y->data, flags, xs.len+i, cu);
  }
  y->flags=strflags_storage(y->data,flags,(uint32_t)t); y->hash=strhash_units(y->data,y->flags,(uint32_t)t);
  y->parent=TS_UNDEFINED; y->offset=0;
  tsv r=ts_str_v(y); ts_gc_unroot(2); return r;
}
tsv ts_str_trimstart(tsv s){
  ts_string* x=as_str(s); if(!x) return s; long a=0,b=(long)x->len;
  ts_strview xs=ts_str_view_typed(s);
  while(a<b){ uint16_t c=ts_str_cu_at_view(xs,(uint32_t)a); if(ts_str_is_trim_ws(c)) a++; else break; }
  return ts_string_slice_view(s, (uint32_t)a, (uint32_t)(b-a));
}
tsv ts_str_trimend(tsv s){
  ts_string* x=as_str(s); if(!x) return s; long a=0,b=(long)x->len;
  ts_strview xs=ts_str_view_typed(s);
  while(b>a){ uint16_t c=ts_str_cu_at_view(xs,(uint32_t)b-1); if(ts_str_is_trim_ws(c)) b--; else break; }
  return ts_string_slice_view(s, (uint32_t)a, (uint32_t)(b-a));
}
tsv ts_str_at(tsv s, double idx){
  ts_string* x=as_str(s); if(!x) return TS_UNDEFINED;
  long i=(long)idx; if(i<0) i+=(long)x->len;
  if(i<0||i>=(long)x->len) return TS_UNDEFINED;
  return ts_string_slice_view(s, (uint32_t)i, 1);
}
/* replace / replaceAll with a STRING pattern (no regex). */
/* Expand a string replacement pattern for a literal-string match of `p` at byte
   index `i` in `x`: $$ -> $, $& -> matched, $` -> prefix, $' -> suffix. ($n group
   refs only apply to regex, which we don't support.) Returns the expanded string. */
static tsv expand_replacement(tsv s, tsv pat, uint32_t i, tsv rep){
  tsv out = ts_new_string("",0); ts_gc_root(&out);
  ts_gc_root(&s); ts_gc_root(&pat); ts_gc_root(&rep);
  ts_string* r = as_str(rep);
  for(uint32_t k=0;;k++){
    r = as_str(rep);
    ts_strview rv = r ? ts_str_view_typed(rep) : (ts_strview){0};
    if (!r || k>=rv.len) break;
    if(ts_str_cu_at_view(rv,k)=='$' && k+1<rv.len){
      uint16_t nx=ts_str_cu_at_view(rv,k+1);
      if(nx=='$'){ out=ts_add(out, ts_new_string("$",1)); k++; continue; }
      if(nx=='&'){ out=ts_add(out, pat); k++; continue; }
      if(nx=='`'){ out=ts_add(out, ts_string_slice_view(s, 0, i)); k++; continue; }
      if(nx=='\''){ uint32_t slen=ts_str_len_typed(s), plen=ts_str_len_typed(pat); out=ts_add(out, ts_string_slice_view(s, i+plen, slen-(i+plen))); k++; continue; }
    }
    out=ts_add(out, ts_string_slice_view(rep, k, 1));
  }
  ts_gc_unroot(4);
  return out;
}
/* Function replacer: call rep(matched, offset, wholeString) and ToString the
   result (the replacement substring). Callback convention matches array.map etc.
   (ts_call, params start at args[0]). */
static tsv ts_str_replace_call(tsv rep, tsv matched, uint32_t off, tsv s){
  ts_gc_root(&rep); ts_gc_root(&matched); ts_gc_root(&s);
  tsv args[3] = { matched, ts_num((double)off), s };
  tsv rv = ts_call_value(rep, args, 3);
  ts_gc_root(&rv);
  tsv out = ts_to_string_v(rv);
  ts_gc_unroot(4);
  return out;
}

static tsv ts_str_replace_literal_build(tsv s, tsv pat, tsv rep, int all){
  ts_string *x=as_str(s), *p=as_str(pat), *r=as_str(rep);
  if(!x||!p||!r||p->len==0) return TS_UNDEFINED;
  ts_strview xs=ts_str_view_typed(s), ps=ts_str_view_typed(pat), rs=ts_str_view_typed(rep);
  uint32_t count=0;
  for(uint32_t i=0;;){
    long long hit = ts_str_find_forward_view(xs, ps, i);
    if(hit < 0) break;
    count++;
    i = (uint32_t)hit + ps.len;
    if(!all) break;
  }
  if(count==0) return s;
  int64_t total64 = (int64_t)xs.len + (int64_t)count * ((int64_t)rs.len - (int64_t)ps.len);
  if(total64 < 0 || total64 > UINT32_MAX) return TS_UNDEFINED;
  uint32_t total = (uint32_t)total64;
  ts_gc_root(&s); ts_gc_root(&pat); ts_gc_root(&rep);
  uint32_t flags = (xs.flags | rs.flags) & TS_STR_FLAG_UTF16;
  ts_string* out = ts_string_alloc_storage(total, flags);
  xs=ts_str_view_typed(s); ps=ts_str_view_typed(pat); rs=ts_str_view_typed(rep);
  uint32_t oi=0, start=0;
  for(uint32_t i=0;;){
    long long hit = ts_str_find_forward_view(xs, ps, i);
    if(hit < 0) break;
    i = (uint32_t)hit;
    uint32_t seg = i - start;
    ts_str_copy_units(out->data, flags, oi, xs, start, seg); oi += seg;
    ts_str_copy_units(out->data, flags, oi, rs, 0, rs.len); oi += rs.len;
    i += ps.len; start = i;
    if(!all) break;
  }
  ts_str_copy_units(out->data, flags, oi, xs, start, xs.len-start); oi += xs.len-start;
  out->len = oi;
  out->flags=strflags_storage(out->data, flags, oi);
  out->hash=strhash_units(out->data, out->flags, oi);
  out->parent=TS_UNDEFINED; out->offset=0;
  tsv rv = ts_str_v(out);
  ts_gc_unroot(3);
  return rv;
}

tsv ts_str_replace(tsv s, tsv pat, tsv rep, int all){
  ts_string *x=as_str(s),*p=as_str(pat);
  /* rep may be a FUNCTION replacer (called per match) instead of a string. */
  int rep_is_fn = ts_is_callable(rep);
  ts_string *r = rep_is_fn ? NULL : as_str(rep);
  if(!x||!p||(!rep_is_fn && !r)) return x ? s : ts_new_string("",0);
  if(p->len==0){
    /* empty pattern matches at index 0 (replace) or between every char + ends
       (replaceAll): "abc".replace("","X")="Xabc", replaceAll -> "XaXbXcX". A
       function replacer is invoked with matched="" at each such offset. */
    ts_gc_root(&s); ts_gc_root(&rep);
    tsv out = rep_is_fn ? ts_str_replace_call(rep, ts_new_string("",0), 0, s) : rep;
    ts_gc_root(&out);
    x=as_str(s);
    uint32_t len=x ? x->len : 0;
    for(uint32_t k=0;k<len;k++){
      out=ts_add(out, ts_string_slice_view(s, k, 1));
      if(all && k+1<len){
        tsv rp = rep_is_fn ? ts_str_replace_call(rep, ts_new_string("",0), k+1, s) : rep;
        out=ts_add(out, rp);
      }
    }
    if(all && len>0){
      tsv rp = rep_is_fn ? ts_str_replace_call(rep, ts_new_string("",0), len, s) : rep;
      out=ts_add(out, rp);
    }
    ts_gc_unroot(3);
    return out;
  }
  /* whether the replacement uses $ patterns (else append it verbatim — fast path).
     Function replacers have no string r, so skip. */
  int has_dollar=0; if(r){ ts_strview rv=ts_str_view_typed(rep); for(uint32_t k=0;k<rv.len;k++) if(ts_str_cu_at_view(rv,k)=='$'){ has_dollar=1; break; } }
  if(!rep_is_fn && !has_dollar){
    tsv built = ts_str_replace_literal_build(s, pat, rep, all);
    if(built != TS_UNDEFINED) return built;
  }
  tsv out=ts_new_string("",0);
  ts_gc_root(&out); ts_gc_root(&s); ts_gc_root(&pat); ts_gc_root(&rep);
  uint32_t i=0,start=0; int done=0;
  for(;;){
    x=as_str(s); p=as_str(pat);            /* re-fetch: ts_add may have allocated/GC'd */
    ts_strview xs=ts_str_view_typed(s), ps=ts_str_view_typed(pat);
    if(i+ps.len > xs.len) break;
    if(!done && ts_str_region_eq(xs, i, ps, 0, ps.len)){
      out=ts_add(out, ts_string_slice_view(s, start, i-start));
      x=as_str(s); p=as_str(pat);
      tsv repl;
      if(rep_is_fn){
        /* matched substring == pattern for a literal-string match. */
        repl = ts_str_replace_call(rep, pat, i, s);
      } else {
        r=as_str(rep);
        repl = has_dollar ? expand_replacement(s, pat, i, rep) : rep;
      }
      out=ts_add(out, repl);
      ps=ts_str_view_typed(pat); i+=ps.len; start=i;
      if(!all) done=1;
    } else i++;
  }
  uint32_t slen=ts_str_len_typed(s);
  out=ts_add(out, ts_string_slice_view(s, start, slen-start));
  ts_gc_unroot(4);
  return out;
}

/* ---------------- field-id <-> name table ---------------- */
/* Seeded at startup from the compiler's interned field list (id -> name). The
   runtime may append fresh ids for names first seen at runtime (JSON.parse), so
   compile-time-known names keep their original id (dot access stays consistent)
   while novel keys still round-trip. */
static const char** g_field_names = NULL;
static uint32_t* g_field_lens = NULL;
static uint32_t g_field_count = 0;
static uint32_t g_field_cap = 0;
/* TS_METHOD_KEY_BASE and the ts_key tag space are defined once in ts_rt.h. */

/* ---- key-kind predicates (property_model_redesign §3.6) ----
   These predicates are the SINGLE place that interprets the key partition, so the
   future tagged-key migration (filling in the reserved Index/Symbol/WKSYM ranges,
   widening to 64-bit) only touches here — call sites ask "is this a method key /
   an enumerable data key", never compare against the base directly. */
static inline int ts_key_is_method(ts_key k){ return k >= TS_METHOD_KEY_BASE; }
/* an own enumerable string-data property: a real named field, not a method key,
   not an internal "__" name. (accessor-ness is checked separately, see
   prop_enum_data.) */
static inline int ts_key_is_enumerable_field(ts_key k){
  if (ts_key_is_method(k)) return 0;
  const char* n = ts_field_name(k);
  if (!n) return 0;
  uint32_t len = ts_field_name_len(k);
  if (len >= 2 && n[0]=='_' && n[1]=='_') return 0;
  return 1;
}

void ts_init_fields(const char* const* names, const uint32_t* lens, uint32_t count){
  g_field_cap = count < 16 ? 16 : count*2;
  g_field_names = malloc(sizeof(char*)*g_field_cap);
  g_field_lens = malloc(sizeof(uint32_t)*g_field_cap);
  for (uint32_t i=0;i<count;i++){
    g_field_names[i] = names[i];
    g_field_lens[i] = lens ? lens[i] : (uint32_t)strlen(names[i]);
  }
  g_field_count = count;
}
const char* ts_field_name(uint32_t id){
  if (id >= g_field_count) return NULL;
  return g_field_names[id];
}
uint32_t ts_field_name_len(uint32_t id){
  if (id >= g_field_count || !g_field_names[id]) return 0;
  return g_field_lens[id];
}
static int field_name_is(uint32_t id, const char* lit){
  const char* n = ts_field_name(id);
  if (!n) return 0;
  uint32_t len = ts_field_name_len(id);
  uint32_t lit_len = (uint32_t)strlen(lit);
  return len == lit_len && memcmp(n, lit, len) == 0;
}
static int field_bytes_is(const char* n, uint32_t len, const char* lit){
  uint32_t lit_len = (uint32_t)strlen(lit);
  return n && len == lit_len && memcmp(n, lit, len) == 0;
}
/* intern a (possibly new) field name -> id, agreeing with compile-time ids. */
uint32_t ts_intern_field(const char* name, uint32_t len){
  RT_STAT_INC(intern_calls);
  for (uint32_t i=0;i<g_field_count;i++){
    const char* n=g_field_names[i];
    if (n && g_field_lens[i]==len && memcmp(n,name,len)==0){ RT_STAT_ADD(intern_probes, i+1); return i; }
  }
  RT_STAT_ADD(intern_probes, g_field_count);
  if (g_field_count==g_field_cap){
    g_field_cap=g_field_cap?g_field_cap*2:16;
    g_field_names=realloc(g_field_names,sizeof(char*)*g_field_cap);
    g_field_lens=realloc(g_field_lens,sizeof(uint32_t)*g_field_cap);
  }
  char* copy=malloc(len+1); memcpy(copy,name,len); copy[len]=0;
  g_field_names[g_field_count]=copy;
  g_field_lens[g_field_count]=len;
  return g_field_count++;
}
static tsv ts_new_string_from_field_name_len(const char* name, uint32_t len){
  if (!name) return TS_UNDEFINED;
  return ts_new_string_from_key_bytes(name, len);
}
static tsv ts_new_string_from_field_key(uint32_t key){
  const char* name = ts_field_name(key);
  if (!name) return TS_UNDEFINED;
  return ts_new_string_from_field_name_len(name, ts_field_name_len(key));
}
/* an own enumerable string property: real field id, named, not internal (__). */
static int field_enumerable(uint32_t id){
  return ts_key_is_enumerable_field(id);
}
/* enumerable DATA property: enumerable key AND not an accessor slot. Accessor
   properties (defined via Object.defineProperty get/set) default to
   non-enumerable and hold a ts_accessor object, so they are excluded from
   Object.keys/values/entries, assign, JSON and console.dir data enumeration. */
static int prop_enum_data(ts_prop* p){
  /* A property is enumerated iff its key is enumerable-eligible AND its
     enumerable attribute bit is set. This now INCLUDES accessor properties whose
     enumerable bit is set (Object.keys lists the key; Object.values/entries/JSON/
     assign/spread invoke the getter for the value — done in the consuming
     callbacks, NOT here, since Object.keys must not trigger getters). */
  return field_enumerable(p->key) && prop_is_enumerable(p);
}
/* Resolve a property's value for value-consuming enumerators (values/entries/
   JSON/assign/spread): if it's an accessor, invoke the getter with this=receiver;
   otherwise return the stored value. Key-only enumerators (Object.keys) must NOT
   call this (no getter side effects). */
static tsv enum_resolve_value(tsv receiver, tsv stored){
  if (!is_accessor(stored)) return stored;
  ts_accessor* ac = (ts_accessor*)ts_ptr(stored);
  if (!ts_is_func(ac->getter)) return TS_UNDEFINED;
  if (ac->g_this){ tsv a0=receiver; return ts_call(ac->getter, &a0, 1); }
  return ts_call(ac->getter, NULL, 0);
}

/* forward decls: the class registry lives lower in the file, but Object.keys/
   values/entries (below) need to enumerate a typed class instance's struct
   fields (which are NOT in the prop map). */
typedef struct ts_class_reg ts_class_reg;
static ts_class_reg* class_reg_for(ts_object* o);
static int class_reg_nfields(ts_class_reg* r);
static uint32_t class_reg_field_key(ts_class_reg* r, int i);
/* read field i's value from instance o as a boxed tsv (numeric -> ts_num). */
static tsv class_reg_field_value(ts_class_reg* r, ts_object* o, int i);
/* canonical own-enumeration (defined after the descriptor helpers, used here). */
typedef void (*ts_prop_enum_cb)(uint32_t key, tsv val, void* ud);
static void ts_prop_own_enum(tsv obj, ts_prop_enum_cb cb, void* ud);
static int prop_key_is_array_index(uint32_t key, uint32_t* idx);

/* ---------------- Object static methods ---------------- */
/* callback contexts for the canonical enumerator. arr is GC-rooted by the caller. */
typedef struct { tsv arr; tsv recv; } enum_arr_ctx;
static void ts_array_push_rooted(tsv arr, tsv v){
  ts_gc_root(&arr); ts_gc_root(&v);
  ts_array_push(arr, v);
  ts_gc_unroot(2);
}
static void cb_push_key(uint32_t key, tsv val, void* ud){
  (void)val; enum_arr_ctx* c=(enum_arr_ctx*)ud;
  if (ts_field_name(key)) ts_array_push_rooted(c->arr, ts_new_string_from_field_key(key));
}
static void cb_push_val(uint32_t key, tsv val, void* ud){
  (void)key; enum_arr_ctx* c=(enum_arr_ctx*)ud;
  tsv resolved = enum_resolve_value(c->recv, val);   /* accessor -> getter */
  ts_array_push_rooted(c->arr, resolved);
}
static void cb_push_entry(uint32_t key, tsv val, void* ud){
  enum_arr_ctx* c=(enum_arr_ctx*)ud;
  const char* n=ts_field_name(key);
  if (!n) return;
  ts_gc_root(&val);
  tsv pair=ts_new_array(0); ts_gc_root(&pair);
  ts_array_push_rooted(pair, ts_new_string_from_field_key(key));
  tsv resolved = enum_resolve_value(c->recv, val);     /* accessor -> getter */
  ts_array_push_rooted(pair, resolved);
  ts_array_push_rooted(c->arr, pair);
  ts_gc_unroot(2);
}
tsv ts_object_keys(tsv obj){
  ts_gc_root(&obj);
  enum_arr_ctx c; c.arr=ts_new_array(0); c.recv=obj; ts_gc_root(&c.arr);
  ts_prop_own_enum(obj, cb_push_key, &c);
  ts_gc_unroot(2);
  return c.arr;
}
static void push_own_name(tsv arr, uint32_t key){
  if (key >= TS_METHOD_KEY_BASE) return; /* method/symbol keys are not string names */
  const char* n = ts_field_name(key);
  uint32_t len = ts_field_name_len(key);
  if (!n || (len >= 2 && n[0] == '_' && n[1] == '_')) return; /* hide runtime-internal slots */
  ts_array_push_rooted(arr, ts_new_string_from_field_key(key));
}
static int own_name_visible(uint32_t key){
  if (key >= TS_METHOD_KEY_BASE) return 0;
  const char* n = ts_field_name(key);
  uint32_t len = ts_field_name_len(key);
  return n && !(len >= 2 && n[0] == '_' && n[1] == '_');
}
static uint32_t propbag_len(tsv owner){
  if (!ts_is_propbag(owner)) return 0;
  ts_object* o = (ts_object*)ts_ptr(owner);
  return kind_has_common_header(o->h.kind) ? o->len : 0;
}
static ts_prop* propbag_prop(tsv owner, uint32_t i){
  if (!ts_is_propbag(owner)) return NULL;
  ts_object* o = (ts_object*)ts_ptr(owner);
  if (!kind_has_common_header(o->h.kind) || i >= o->len) return NULL;
  return &o->props[i];
}
static void push_prop_names_js_order(tsv arr, tsv owner, uint32_t skip1, uint32_t skip2, uint32_t skip3){
  ts_gc_root(&arr); ts_gc_root(&owner);
  uint32_t len = propbag_len(owner);
  uint32_t total_idx = 0;
  for (uint32_t i=0;i<len;i++){
    ts_prop* p = propbag_prop(owner, i); if (!p) continue;
    uint32_t k = p->key, idx;
    if (k == skip1 || k == skip2 || k == skip3 || !own_name_visible(k)) continue;
    if (prop_key_is_array_index(k, &idx)) total_idx++;
  }
  uint32_t prev_idx = 0, emitted = 0; int have_prev = 0;
  while (emitted < total_idx){
    uint32_t best = 0, best_key = 0; int found = 0;
    len = propbag_len(owner);
    for (uint32_t i=0;i<len;i++){
      ts_prop* p = propbag_prop(owner, i); if (!p) continue;
      uint32_t k = p->key, idx;
      if (k == skip1 || k == skip2 || k == skip3 || !own_name_visible(k)) continue;
      if (!prop_key_is_array_index(k, &idx)) continue;
      if (have_prev && idx <= prev_idx) continue;
      if (!found || idx < best){ best = idx; best_key = k; found = 1; }
    }
    if (!found) break;
    push_own_name(arr, best_key);
    prev_idx = best; have_prev = 1; emitted++;
  }
  len = propbag_len(owner);
  for (uint32_t i=0;i<len;i++){
    ts_prop* p = propbag_prop(owner, i); if (!p) continue;
    uint32_t k = p->key, idx;
    if (k == skip1 || k == skip2 || k == skip3 || !own_name_visible(k)) continue;
    if (prop_key_is_array_index(k, &idx)) continue;
    push_own_name(arr, k);
  }
  ts_gc_unroot(2);
}
static tsv symbol_value_from_prop_key(ts_key key){
  if (key >= TS_USERSYM_KEY_BASE) return sym_value_by_id(key - TS_USERSYM_KEY_BASE);
  if (key >= TS_WKSYM_KEY_BASE) return ts_wksym(key - TS_WKSYM_KEY_BASE);
  return TS_UNDEFINED;
}
static void push_prop_symbols_js_order(tsv arr, tsv owner){
  ts_gc_root(&arr); ts_gc_root(&owner);
  uint32_t len = propbag_len(owner);
  for (uint32_t i=0;i<len;i++){
    ts_prop* p = propbag_prop(owner, i); if (!p) continue;
    tsv sym = symbol_value_from_prop_key(p->key);
    if (!ts_is_undef(sym)) ts_array_push_rooted(arr, sym);
    len = propbag_len(owner);
  }
  ts_gc_unroot(2);
}
static void push_index_name(tsv arr, uint32_t i){
  char b[16]; int bn = snprintf(b, sizeof b, "%u", i);
  ts_array_push_rooted(arr, ts_new_string(b, (uint32_t)bn));
}
static void push_cstr_name(tsv arr, const char* n){
  ts_array_push_rooted(arr, ts_new_string(n, (uint32_t)strlen(n)));
}
tsv ts_object_get_own_property_names(tsv obj){
  ts_gc_root(&obj);
  tsv arr = ts_new_array(0);
  ts_gc_root(&arr);
  if (ts_is_str(obj)){
    ts_string* s = ts_ptr(obj);
    uint32_t len = s->len;
    for (uint32_t i=0;i<len;i++){ push_index_name(arr, i); s = ts_ptr(obj); len = s->len; }
    push_cstr_name(arr, "length");
    ts_gc_unroot(2);
    return arr;
  }
  if (ts_is_array(obj)){
    ts_array* a = ts_ptr(obj);
    uint32_t len = a->len;
    for (uint32_t i=0;i<len;i++){ push_index_name(arr, i); a = ts_ptr(obj); len = a->len; }
    push_cstr_name(arr, "length");
    push_prop_names_js_order(arr, obj, 0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu);
    ts_gc_unroot(2);
    return arr;
  }
  if (ts_is_func(obj)){
    int has_proto = !ts_is_undef(((ts_func*)ts_ptr(obj))->prototype_prop);
    push_cstr_name(arr, "length");
    push_cstr_name(arr, "name");
    if (has_proto) push_cstr_name(arr, "prototype");
    ts_object* sc = ts_class_static_container(obj);
    if (sc){
      uint32_t k_len = ts_intern_field("length", 6);
      uint32_t k_name = ts_intern_field("name", 4);
    uint32_t k_proto = ts_intern_field("prototype", 9);
      tsv scv = ts_obj(sc);
      push_prop_names_js_order(arr, scv, k_len, k_name, k_proto);
      ts_gc_unroot(2);
      return arr;
    }
    push_prop_names_js_order(arr, obj, 0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu);
    ts_gc_unroot(2);
    return arr;
  }
  if (!ts_is_obj(obj) || ts_is_map(obj) || ts_is_set(obj)){
    ts_gc_unroot(2);
    return arr;
  }
  ts_object* o = ts_ptr(obj);
  ts_class_reg* reg = class_reg_for(o);
  int nf = class_reg_nfields(reg);
  for (int i=0;i<nf;i++) push_own_name(arr, class_reg_field_key(reg, i));
  o = ts_ptr(obj);
  push_prop_names_js_order(arr, obj, 0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu);
  ts_gc_unroot(2);
  return arr;
}
tsv ts_object_get_own_property_symbols(tsv obj){
  ts_gc_root(&obj);
  tsv arr = ts_new_array(0);
  ts_gc_root(&arr);
  if (ts_is_str(obj)){
    ts_gc_unroot(2);
    return arr;
  }
  if (!ts_is_propbag(obj)){
    ts_gc_unroot(2);
    return arr;
  }
  if (ts_is_func(obj)){
    push_prop_symbols_js_order(arr, obj);
    ts_object* sc = ts_class_static_container(obj);
    if (sc){
      tsv scv = ts_obj(sc);
      push_prop_symbols_js_order(arr, scv);
    }
    ts_gc_unroot(2);
    return arr;
  }
  push_prop_symbols_js_order(arr, obj);
  ts_gc_unroot(2);
  return arr;
}
tsv ts_object_values(tsv obj){
  ts_gc_root(&obj);
  enum_arr_ctx c; c.arr=ts_new_array(0); c.recv=obj; ts_gc_root(&c.arr);
  ts_prop_own_enum(obj, cb_push_val, &c);
  ts_gc_unroot(2);
  return c.arr;
}
/* Object.entries(o): array of [key, value] pairs (own enumerable string-keyed
   props + typed class instance struct fields), in JS order. */
tsv ts_object_entries(tsv obj){
  ts_gc_root(&obj);
  enum_arr_ctx c; c.arr=ts_new_array(0); c.recv=obj; ts_gc_root(&c.arr);
  ts_prop_own_enum(obj, cb_push_entry, &c);
  ts_gc_unroot(2);
  return c.arr;
}
/* Object.assign(target, ...sources): copy each source's own enumerable string
   props into target, then return target. Sources are read from the prop map
   (plain objects); a NULL/non-object source is skipped, matching JS coercion of
   null/undefined sources to no-ops. */
/* Object.assign(target, ...srcs): copy each src's own enumerable data props
   (struct fields + prop map) onto target. */
typedef struct { tsv target; tsv recv; } enum_copy_ctx;
static void cb_copy_to_target(uint32_t key, tsv val, void* ud){
  enum_copy_ctx* c=(enum_copy_ctx*)ud;
  tsv resolved = enum_resolve_value(c->recv, val);   /* accessor -> getter */
  ts_gc_root(&resolved);
  ts_set(c->target, key, resolved);
  ts_gc_unroot(1);
}
/* new operator step 4 (unified_object_model §10, ECMA-262 11.2.2/13.2.2): if the
   constructor returned an OBJECT, `new C()` evaluates to that object; otherwise
   (primitive / undefined / null return) to the freshly-allocated instance.
   "Object" = anything that is not a primitive value (number/string/boolean/
   undefined/null). Only emitted for classes flagged constructor-returns-value. */
tsv ts_construct_result(tsv inst, tsv ret){
  if (ts_is_num(ret) || ts_is_str(ret) || ts_is_bool(ret) || ts_is_undef(ret) || ts_is_null(ret))
    return inst;
  return ret;   /* object-like (plain object / array / func / map / set) */
}

tsv ts_object_assign(tsv* args, int n){
  if (n <= 0) return ts_new_object();
  tsv target = args[0];
  if (!ts_is_obj(target) || ts_is_array(target) || ts_is_map(target) || ts_is_set(target)) return target;
  ts_gc_root(&target);
  enum_copy_ctx c; c.target=target;
  for (int si=1; si<n; si++){
    tsv src = args[si];
    if (ts_is_map(src) || ts_is_set(src) || (!ts_is_obj(src) && !ts_is_class_value(src) && !ts_is_str(src))) continue;  /* arrays/strings OK (index keys) */
    ts_gc_root(&src);
    c.recv = src;   /* accessor getters run with this=src */
    ts_prop_own_enum(src, cb_copy_to_target, &c);
    ts_gc_unroot(1);
  }
  ts_gc_unroot(1);
  return target;
}

/* Object.fromEntries(entries): build an object from an array of [key, value]
   pairs (each pair is a 2-element array). Non-string keys are coerced. */
tsv ts_object_from_entries(tsv entries){
  ts_gc_root(&entries);
  tsv obj = ts_new_object();
  ts_gc_root(&obj);
  /* accept any iterable of [key,value] pairs: arrays pass through; Map/Set/
     generator/etc. are materialized to an array of pairs first (push_all turns
     a Map into [k,v] pairs). */
  tsv arr = entries;
  if (!ts_is_array(entries)){ arr = ts_new_array(0); }
  ts_gc_root(&arr);
  if (arr != entries) ts_array_push_all(arr, entries);
  uint32_t len = ts_array_len(arr);
  for (uint32_t i=0;i<len;i++){
    tsv pair = ts_array_get(arr, i);
    if (!ts_is_array(pair)) continue;
    ts_gc_root(&pair);
    tsv k = ts_array_get(pair, 0);
    tsv v = ts_array_get(pair, 1);
    ts_gc_root(&k); ts_gc_root(&v);
    tsv ks = ts_to_string_v(k);
  ts_gc_root(&ks);
  if (ts_is_str(ks)){
      uint32_t kid = ts_intern_string_value(ks);
      ts_set(obj, kid, v);
    }
    ts_gc_unroot(4);
  }
  ts_gc_unroot(3);
  return obj;
}

/* ---------------- JSON ---------------- */
/* growable byte buffer for stringify */
typedef struct { char* p; size_t len, cap; int heap; int nonascii; char small[256]; } jbuf;
static void jb_init(jbuf* b){ b->p=b->small; b->len=0; b->cap=sizeof(b->small); b->heap=0; b->nonascii=0; }
static void jb_grow(jbuf* b, size_t need){
  size_t nc=b->cap;
  while(need>nc) nc*=2;
  if(b->heap) b->p=realloc(b->p,nc);
  else { char* np=malloc(nc); memcpy(np,b->p,b->len); b->p=np; b->heap=1; }
  b->cap=nc;
}
static void jb_free(jbuf* b){ if(b->heap) free(b->p); }
static void jb_putc(jbuf* b, char c){ if(b->len+1>b->cap) jb_grow(b,b->len+1); b->p[b->len++]=c; }
static void jb_puts(jbuf* b, const char* s, size_t n){ if(b->len+n>b->cap) jb_grow(b,b->len+n); memcpy(b->p+b->len,s,n); b->len+=n; }
static void jb_putz(jbuf* b, const char* s){ jb_puts(b,s,strlen(s)); }
static void jb_put_u_escape(jbuf* b, uint32_t cp){
  char tmp[8];
  snprintf(tmp, sizeof(tmp), "\\u%04x", (unsigned)(cp & 0xFFFFu));
  jb_putz(b, tmp);
}
static void jb_put_utf8_cp(jbuf* b, uint32_t cp){
  if (cp > 0x10FFFFu || ts_is_surrogate_code_unit(cp)) cp = 0xFFFDu;
  if (cp >= 0x80u) b->nonascii = 1;
  char tmp[4]; size_t n=0;
  if (cp < 0x80u) tmp[n++]=(char)cp;
  else if (cp < 0x800u){ tmp[n++]=(char)(0xC0u | (cp >> 6)); tmp[n++]=(char)(0x80u | (cp & 0x3Fu)); }
  else if (cp < 0x10000u){ tmp[n++]=(char)(0xE0u | (cp >> 12)); tmp[n++]=(char)(0x80u | ((cp >> 6) & 0x3Fu)); tmp[n++]=(char)(0x80u | (cp & 0x3Fu)); }
  else { tmp[n++]=(char)(0xF0u | (cp >> 18)); tmp[n++]=(char)(0x80u | ((cp >> 12) & 0x3Fu)); tmp[n++]=(char)(0x80u | ((cp >> 6) & 0x3Fu)); tmp[n++]=(char)(0x80u | (cp & 0x3Fu)); }
  jb_puts(b, tmp, n);
}
static uint32_t ts_str_cp_at_view(ts_strview s, uint32_t* i){
  uint32_t cp = ts_str_cu_at_view(s, *i);
  if (cp >= 0xD800u && cp <= 0xDBFFu && *i + 1 < s.len){
    uint16_t lo = ts_str_cu_at_view(s, *i + 1);
    if (lo >= 0xDC00u && lo <= 0xDFFFu){
      cp = 0x10000u + (((cp - 0xD800u) << 10) | ((uint32_t)lo - 0xDC00u));
      (*i)++;
    }
  }
  return cp;
}

static void json_put_quoted_cp(jbuf* b, uint32_t c){
  switch(c){
    case '"': jb_putz(b,"\\\""); break;
    case '\\': jb_putz(b,"\\\\"); break;
    case '\n': jb_putz(b,"\\n"); break;
    case '\r': jb_putz(b,"\\r"); break;
    case '\t': jb_putz(b,"\\t"); break;
    case '\b': jb_putz(b,"\\b"); break;
    case '\f': jb_putz(b,"\\f"); break;
    default:
      if (c < 0x20u || ts_is_surrogate_code_unit(c)) jb_put_u_escape(b, c);
      else jb_put_utf8_cp(b,c);
  }
}
/* True when every byte can be emitted verbatim inside JSON quotes: printable
   ASCII that is neither '"' nor '\\'. Lets the common case (identifiers, plain
   text) bypass the per-codepoint decode + escape switch and bulk-copy instead. */
static inline int json_bytes_clean_ascii(const char* d, uint32_t len){
  for (uint32_t i=0;i<len;i++){
    unsigned char c=(unsigned char)d[i];
    if (c < 0x20u || c=='"' || c=='\\' || c>=0x80u) return 0;
  }
  return 1;
}
static void json_quote(jbuf* b, ts_strview s){
  /* Fast path: 1-byte storage with no chars needing escaping -> bulk copy. */
  if (!(s.flags & TS_STR_FLAG_UTF16) && json_bytes_clean_ascii(s.data, s.len)){
    if (b->len + s.len + 2 > b->cap) jb_grow(b, b->len + s.len + 2);
    b->p[b->len++]='"';
    memcpy(b->p + b->len, s.data, s.len); b->len += s.len;
    b->p[b->len++]='"';
    return;
  }
  jb_putc(b,'"');
  for (uint32_t i=0;i<s.len;i++){
    uint32_t c=ts_str_cp_at_view(s, &i);
    json_put_quoted_cp(b, c);
  }
  jb_putc(b,'"');
}
static void json_quote_key_bytes(jbuf* b, const char* name, uint32_t len){
  /* Fast path: plain ASCII key -> bulk copy (object keys are usually identifiers). */
  if (json_bytes_clean_ascii(name, len)){
    if (b->len + len + 2 > b->cap) jb_grow(b, b->len + len + 2);
    b->p[b->len++]='"';
    memcpy(b->p + b->len, name, len); b->len += len;
    b->p[b->len++]='"';
    return;
  }
  jb_putc(b,'"');
  const unsigned char* p = (const unsigned char*)name;
  for(uint32_t i=0;i<len;){
    uint32_t c = utf8_next_cp_allow_surrogate(p, len, &i);
    json_put_quoted_cp(b, c);
  }
  jb_putc(b,'"');
}

static void json_num(jbuf* b, double d){
  if (d!=d || d==1.0/0.0 || d==-1.0/0.0){ jb_putz(b,"null"); return; } /* NaN/Inf -> null */
  /* Fast path: integers (the common case) go straight into the buffer via itoa,
     skipping the temp-buffer + strlen round trip. */
  if (d == (double)(long long)d && d < 9e15 && d > -9e15){
    if (b->len + 21 > b->cap) jb_grow(b, b->len + 21);
    b->len += (size_t)ts_i64_to_str((long long)d, b->p + b->len);
    return;
  }
  char nb[40];
  ts_fmt_num(d, nb, sizeof nb);
  jb_putz(b, nb);
}
double ts_json_num_len(double d){
  if (d!=d || d==1.0/0.0 || d==-1.0/0.0) return 4.0; /* null */
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
  char nb[40];
  ts_fmt_num(d, nb, sizeof nb);
  return (double)strlen(nb);
}
static double json_quoted_view_len(ts_strview s){
  double n = 2.0; /* quotes */
  for (uint32_t i=0;i<s.len;i++){
    uint32_t c=ts_str_cp_at_view(s, &i);
    switch(c){
      case '"': case '\\': case '\n': case '\r': case '\t': case '\b': case '\f':
        n += 2.0; break;
      default:
        n += (c < 0x20u || ts_is_surrogate_code_unit(c)) ? 6.0 : (c > 0xFFFFu ? 2.0 : 1.0);
    }
  }
  return n;
}
double ts_json_string_len(tsv v){
  if (!ts_is_str(v)) return ts_json_stringify_len(v);
  return json_quoted_view_len(ts_str_view_typed(v));
}

/* Pretty-printing: `indent` is the per-level indent unit (e.g. "  "); NULL or ""
   means compact. jb_indent emits a newline + depth copies of the unit and is a
   no-op in compact mode — so compact output stays byte-identical. */
static void jb_indent(jbuf* b, const char* indent, int depth){
  if (!indent || !*indent) return;
  jb_putc(b,'\n');
  for (int i=0;i<depth;i++) jb_putz(b, indent);
}
static int json_stringify_val(jbuf* b, tsv v, int depth, const char* indent);
/* SerializeJSONProperty step 2: if `v` is an object with a callable `toJSON`,
   replace it with `v.toJSON(key)`. Applied once at each property/element/top
   site (not inside json_stringify_val) so the omit decision for objects/maps
   sees the post-toJSON value and toJSON receives the property key. */
static tsv json_apply_tojson(tsv v, const char* key, uint32_t keylen){
  if (!ts_is_obj(v)) return v;
  ts_prim_field_init();
  tsv tj = ts_prim_method(v, g_tojson_field, g_tojson_key);
  if (!ts_is_callable(tj)) return v;
  ts_gc_root(&v); ts_gc_root(&tj);
  tsv ks = ts_new_string(key ? key : "", key ? keylen : 0);
  ts_gc_root(&ks);
  tsv args[2] = { v, ks };
  tsv r = ts_call(tj, args, 2);   /* this = v, arg0 = key */
  ts_gc_unroot(3);
  return r;
}
/* object-property callback for JSON.stringify (routes struct fields + prop map). */
typedef struct { jbuf* b; int depth; int first; tsv recv; const char* indent; } json_obj_ctx;
static int json_emit_obj_prop(jbuf* b, tsv recv, uint32_t key, tsv val, int depth, const char* indent, int* first){
  val = enum_resolve_value(recv, val);                     /* accessor -> getter */
  const char* n=ts_field_name(key);
  if (!n) return 0;
  val = json_apply_tojson(val, n, ts_field_name_len(key)); /* toJSON before omit */
  if (ts_is_undef(val)||ts_is_func(val)) return 0;          /* omit in objects */
  ts_gc_root(&val);
  if (!*first) jb_putc(b,','); *first=0;
  jb_indent(b, indent, depth+1);
  json_quote_key_bytes(b, n, ts_field_name_len(key)); jb_putc(b,':');
  if (indent && *indent) jb_putc(b,' ');
  json_stringify_val(b, val, depth+1, indent);
  ts_gc_unroot(1);
  return 1;
}
static void cb_json_obj_prop(uint32_t key, tsv val, void* ud){
  json_obj_ctx* c=(json_obj_ctx*)ud;
  json_emit_obj_prop(c->b, c->recv, key, val, c->depth, c->indent, &c->first);
}
static int json_emit_prop_map_direct(jbuf* b, tsv obj, int depth, const char* indent, int* first){
  ts_object* o=ts_ptr(obj);
  for (uint32_t i=0;i<o->len;i++){
    uint32_t idx;
    if (prop_enum_data(&o->props[i]) && prop_key_is_array_index(o->props[i].key, &idx)) return 0;
  }
  for (uint32_t i=0;;i++){
    o=ts_ptr(obj);
    if (i>=o->len) break;
    if (!prop_enum_data(&o->props[i])) continue;
    uint32_t k=o->props[i].key;
    tsv val=o->props[i].val;
    json_emit_obj_prop(b, obj, k, val, depth, indent, first);
  }
  return 1;
}

static int json_stringify_val(jbuf* b, tsv v, int depth, const char* indent){
  if (depth > 256){ fprintf(stderr,"tsaot: JSON.stringify: structure too deep (cycle?)\n"); abort(); }
  /* top-level toJSON (key ""): children get toJSON applied by their property /
     element / map emitters, so depth>0 never re-applies it to the same value. */
  if (depth == 0 && ts_is_obj(v)) v = json_apply_tojson(v, "", 0);
  if (ts_is_undef(v) || ts_is_func(v)) return 0;          /* caller decides null vs omit */
  if (ts_is_null(v)){ jb_putz(b,"null"); return 1; }
  if (ts_is_bool(v)){ jb_putz(b,(v&1)?"true":"false"); return 1; }
  if (ts_is_num(v)){ json_num(b, ts_to_num(v)); return 1; }
  if (ts_is_str(v)){ json_quote(b, ts_str_view_typed(v)); return 1; }
  if (ts_is_array(v)){
    ts_gc_root(&v);
    ts_array* a=ts_ptr(v); uint32_t len=a->len; jb_putc(b,'[');
    for (uint32_t i=0;i<len;i++){ a=ts_ptr(v); if(i) jb_putc(b,',');
      jb_indent(b, indent, depth+1);
      tsv elem = (i<a->len) ? a->data[i] : TS_UNDEFINED;
      if (ts_is_obj(elem)){ char ib[24]; int il=snprintf(ib,sizeof ib,"%u",i); elem=json_apply_tojson(elem, ib, (uint32_t)il); }
      if (!json_stringify_val(b, elem, depth+1, indent)) jb_putz(b,"null"); /* holes/undef -> null */ }
    if (len) jb_indent(b, indent, depth);
    jb_putc(b,']'); ts_gc_unroot(1); return 1;
  }
  if (ts_is_map(v)){
    ts_gc_root(&v);
    ts_map* m=ts_ptr(v); uint32_t len=m->len; jb_putc(b,'{'); int first=1;
    for (uint32_t i=0;i<len;i++){
      m=ts_ptr(v);
      if (i>=m->len || !ts_is_str(m->keys[i])) continue;  /* only string keys */
      tsv key=m->keys[i];
      tsv val=m->vals[i];
      ts_gc_root(&key);
      { ts_strview kv = ts_str_view_typed(key); val = json_apply_tojson(val, kv.data, kv.len); }
      if (ts_is_undef(val)||ts_is_func(val)){ ts_gc_unroot(1); continue; }
      ts_gc_root(&val);
      if (!first) jb_putc(b,','); first=0;
      jb_indent(b, indent, depth+1);
      json_quote(b, ts_str_view_typed(key)); jb_putc(b,':');
      if (indent && *indent) jb_putc(b,' ');
      json_stringify_val(b, val, depth+1, indent);
      ts_gc_unroot(2);
    }
    if (!first) jb_indent(b, indent, depth);
    jb_putc(b,'}'); ts_gc_unroot(1); return 1;
  }
  if (g_has_proxies && ts_is_proxy(v)){                     /* proxy: enumerate via traps */
    jb_putc(b,'{');
    ts_gc_root(&v);
    json_obj_ctx jc; jc.b=b; jc.depth=depth; jc.first=1; jc.recv=v; jc.indent=indent;
    ts_proxy_enum(v, cb_json_obj_prop, &jc);
    ts_gc_unroot(1);
    if (!jc.first) jb_indent(b, indent, depth);
    jb_putc(b,'}'); return 1;
  }
  if (ts_is_obj(v)){                                        /* plain object / class instance */
    jb_putc(b,'{');
    ts_gc_root(&v);
    int first=1;
    ts_object* o=ts_ptr(v);
    ts_class_reg* reg=class_reg_for(o);
    int used_direct=1;
    int nf=class_reg_nfields(reg);
    for (int i=0;i<nf;i++){
      reg=class_reg_for((ts_object*)ts_ptr(v));
      uint32_t k=class_reg_field_key(reg, i);
      tsv val=class_reg_field_value(reg, (ts_object*)ts_ptr(v), i);
      json_emit_obj_prop(b, v, k, val, depth, indent, &first);
    }
    if (!json_emit_prop_map_direct(b, v, depth, indent, &first)) {
      /* Rare integer-index props need the canonical ordering logic. */
      first=1;
      b->len--; /* discard the opening brace and re-emit through the canonical path */
      jb_putc(b,'{');
      json_obj_ctx jc; jc.b=b; jc.depth=depth; jc.first=1; jc.recv=v; jc.indent=indent;
      ts_prop_own_enum(v, cb_json_obj_prop, &jc);
      first=jc.first;
      used_direct=0;
    }
    ts_gc_unroot(1);
    (void)used_direct;
    if (!first) jb_indent(b, indent, depth);
    jb_putc(b,'}'); return 1;
  }
  jb_putz(b,"null"); return 1;
}

tsv ts_json_stringify(tsv v){
  jbuf b; jb_init(&b);
  ts_gc_root(&v);
  if (!json_stringify_val(&b, v, 0, NULL)){ ts_gc_unroot(1); jb_free(&b); return TS_UNDEFINED; } /* top-level undef/fn -> undefined */
  ts_gc_unroot(1);
  tsv r = b.nonascii ? ts_new_string(b.p, (uint32_t)b.len) : ts_new_string_ascii(b.p, (uint32_t)b.len);
  jb_free(&b); return r;
}
double ts_json_stringify_len(tsv v){
  jbuf b; jb_init(&b);
  ts_gc_root(&v);
  if (!json_stringify_val(&b, v, 0, NULL)){ ts_gc_unroot(1); jb_free(&b); return NAN; }
  double n = (double)b.len;
  ts_gc_unroot(1);
  jb_free(&b);
  return n;
}
/* JSON.stringify(value, null, space): pretty-print. `space` is a number (that
   many spaces, clamped to 10) or a string (used directly, first 10 chars). A
   non-positive / non-string space falls back to compact. */
tsv ts_json_stringify_indent(tsv v, tsv space){
  char unit[64]; int ui = 0;
  if (ts_is_num(space)){
    int sp = (int)ts_to_num(space);
    if (sp > 10) sp = 10;
    for (int i=0;i<sp;i++) unit[ui++] = ' ';
  } else if (ts_is_str(space)){
    ts_strview s = ts_str_view_typed(space);
    uint32_t n = s.len > 10 ? 10 : s.len;
    for (uint32_t i=0;i<n;i++){
      uint32_t before = i;
      uint32_t cp = ts_str_cp_at_view(s, &i);
      if (i >= n && i != before) break;
      char tmp[4]; jbuf jb = { tmp, 0, sizeof(tmp) };
      jb_put_utf8_cp(&jb, cp);
      for(size_t k=0;k<jb.len && ui < (int)sizeof(unit)-1;k++) unit[ui++] = tmp[k];
    }
  }
  unit[ui] = 0;
  jbuf b; jb_init(&b);
  ts_gc_root(&v);
  if (!json_stringify_val(&b, v, 0, ui ? unit : NULL)){ ts_gc_unroot(1); jb_free(&b); return TS_UNDEFINED; }
  ts_gc_unroot(1);
  tsv r = b.nonascii ? ts_new_string(b.p, (uint32_t)b.len) : ts_new_string_ascii(b.p, (uint32_t)b.len);
  jb_free(&b); return r;
}
double ts_json_stringify_indent_len(tsv v, tsv space){
  char unit[64]; int ui = 0;
  if (ts_is_num(space)){
    int sp = (int)ts_to_num(space);
    if (sp > 10) sp = 10;
    for (int i=0;i<sp;i++) unit[ui++] = ' ';
  } else if (ts_is_str(space)){
    ts_strview s = ts_str_view_typed(space);
    uint32_t n = s.len > 10 ? 10 : s.len;
    for (uint32_t i=0;i<n;i++){
      uint32_t before = i;
      uint32_t cp = ts_str_cp_at_view(s, &i);
      if (i >= n && i != before) break;
      char tmp[4]; jbuf jb = { tmp, 0, sizeof(tmp) };
      jb_put_utf8_cp(&jb, cp);
      for(size_t k=0;k<jb.len && ui < (int)sizeof(unit)-1;k++) unit[ui++] = tmp[k];
    }
  }
  unit[ui] = 0;
  jbuf b; jb_init(&b);
  ts_gc_root(&v);
  if (!json_stringify_val(&b, v, 0, ui ? unit : NULL)){ ts_gc_unroot(1); jb_free(&b); return NAN; }
  double n = (double)b.len;
  ts_gc_unroot(1);
  jb_free(&b);
  return n;
}

/* ---- structural inspection (console.dir / console.log of objects) ---- */
/* registry of typed-class descriptors, keyed by stable prototype handle. */
struct ts_class_reg { tsv proto; ts_class_field* fields; int nfields; };
typedef struct ts_class_reg ts_class_reg;
static ts_class_reg* g_class_regs = NULL;
static int g_class_reg_len = 0, g_class_reg_cap = 0;
void ts_register_class(tsv proto, ts_class_field* fields, int nfields){
  if (g_class_reg_len == g_class_reg_cap){
    g_class_reg_cap = g_class_reg_cap ? g_class_reg_cap*2 : 8;
    g_class_regs = realloc(g_class_regs, sizeof(ts_class_reg)*g_class_reg_cap);
  }
  g_class_regs[g_class_reg_len].proto = proto;
  g_class_regs[g_class_reg_len].fields = fields;
  g_class_regs[g_class_reg_len].nfields = nfields;
  g_class_reg_len++;
}

/* Class VALUE support: per-class-id instance size + prototype, so a runtime
   `new K()` (K a class value) can allocate the right-sized typed instance and
   wire its prototype, then call the constructor cfunc the value carries. */
static size_t*          g_class_size = NULL;
static tsv*             g_class_proto_tab = NULL;
static ts_class_field** g_class_fields = NULL;
static int*             g_class_nfields = NULL;
static uint32_t         g_class_meta_cap = 0;
void ts_register_class_meta(uint32_t class_id, size_t size, tsv proto, ts_class_field* fields, int nfields){
  if (class_id >= g_class_meta_cap){
    uint32_t nc = (class_id + 1 > g_class_meta_cap * 2) ? class_id + 1 : g_class_meta_cap * 2;
    if (nc < 8) nc = 8;
    g_class_size = realloc(g_class_size, sizeof(size_t) * nc);
    g_class_proto_tab = realloc(g_class_proto_tab, sizeof(tsv) * nc);
    g_class_fields = realloc(g_class_fields, sizeof(ts_class_field*) * nc);
    g_class_nfields = realloc(g_class_nfields, sizeof(int) * nc);
    for (uint32_t i = g_class_meta_cap; i < nc; i++){
      g_class_size[i] = 0;
      g_class_proto_tab[i] = TS_UNDEFINED;
      g_class_fields[i] = NULL;
      g_class_nfields[i] = 0;
    }
    g_class_meta_cap = nc;
  }
  g_class_size[class_id] = size;
  g_class_proto_tab[class_id] = proto;
  g_class_fields[class_id] = fields;
  g_class_nfields[class_id] = nfields;
}
static tsv ts_clone_class_proto(uint32_t class_id){
  if (class_id >= g_class_meta_cap || !ts_is_obj(g_class_proto_tab[class_id])) return TS_UNDEFINED;
  tsv tmplv = g_class_proto_tab[class_id];
  ts_gc_root(&tmplv);
  ts_object* tmpl = (ts_object*)ts_ptr(tmplv);
  tsv proto = ts_new_proto();
  ts_object* p = (ts_object*)ts_ptr(proto);
  tmpl = (ts_object*)ts_ptr(tmplv);
  p->proto = tmpl->proto;
  p->shape = tmpl->shape;
  if (tmpl->len){
    p->cap = tmpl->len;
    p->len = tmpl->len;
    p->props = malloc(sizeof(ts_prop) * p->cap);
    memcpy(p->props, tmpl->props, sizeof(ts_prop) * tmpl->len);
  }
  if (g_class_fields[class_id]) {
    ts_register_class(proto, g_class_fields[class_id], g_class_nfields[class_id]);
  }
  ts_gc_unroot(1);
  return proto;
}
/* Box a class as a callable value. class_id is stored PLUS ONE (0 = non-class).
   code = constructor cfunc; env = captured cells (threaded as ctor leading params). */
tsv ts_make_class_value(uint32_t class_id, ts_code ctor, tsv* env, uint32_t envlen){
  tsv fv = ts_make_fn_t(ctor, env, envlen, 1);
  ((ts_func*)ts_ptr(fv))->class_id = class_id + 1;
  if (class_id < g_class_meta_cap && ts_is_obj(g_class_proto_tab[class_id])){
    ts_gc_root(&fv);
    tsv proto = ts_clone_class_proto(class_id);
    ts_gc_root(&proto);
    ((ts_func*)ts_ptr(fv))->prototype_prop = proto;
    ts_write_barrier(fv, proto);
    if (ts_is_obj(proto)) {
      ts_define_data(proto, ts_intern_field("constructor", 11), fv, 0, 1, 1);
    }
    ts_gc_unroot(2);
  }
  return fv;
}
/* `new K(args...)`: allocate a typed instance for K's class, wire its prototype,
   then run the constructor (env auto-prepended by ts_call -> [cells..., this, args]).
   Per ECMA-262, if the ctor returns an object, that object is the result. */
tsv ts_construct(tsv ctorv, tsv* args, int n){
  if (g_has_proxies && ts_is_proxy(ctorv)) return ts_proxy_construct(ctorv, args, n);
  if (!ts_is_func(ctorv)) ts_throw_type_error("value is not a constructor");
  uint32_t raw = ((ts_func*)ts_ptr(ctorv))->class_id;
  if (raw == 0){
    /* A plain function used as a constructor (`new fn()`): allocate an ordinary
       object whose prototype is fn.prototype (or Object.prototype), call fn with
       this=object, and yield the object (or the function's object return).
       Only functions with an own .prototype are constructors (declarations and
       function expressions — the constructable flag mirrors FN_HAS_PROTOTYPE);
       arrows/methods/async/generators/builtins throw V8's catchable TypeError. */
    if (!((ts_func*)ts_ptr(ctorv))->constructable){
      const char* nm = ((ts_func*)ts_ptr(ctorv))->name;
      char buf[192];
      snprintf(buf, sizeof(buf), "%s is not a constructor", (nm && nm[0]) ? nm : "value");
      ts_throw_type_error_msg(buf);
    }
    ts_gc_root(&ctorv);
    tsv proto = ((ts_func*)ts_ptr(ctorv))->prototype_prop;
    tsv inst = ts_new_object();
    ts_gc_root(&inst);
    ((ts_object*)ts_ptr(inst))->proto = ts_is_obj(proto) ? proto : ts_object_proto();
    int pm = n + 1;
    tsv* pcallargs = malloc(sizeof(tsv) * (pm > 0 ? pm : 1));
    pcallargs[0] = inst;
    for (int i = 0; i < n; i++) pcallargs[1 + i] = args[i];
    tsv pr = ts_call(ctorv, pcallargs, pm);
    free(pcallargs);
    ts_gc_unroot(2);
    return ts_is_obj(pr) ? pr : inst;
  }
  uint32_t cid = raw - 1;
  if (cid >= g_class_meta_cap || g_class_size[cid] == 0){ fprintf(stderr, "tsaot: TypeError: unregistered class in new\n"); abort(); }
  ts_gc_root(&ctorv);
  tsv inst = ts_new_sized(g_class_size[cid]);
  tsv proto = ((ts_func*)ts_ptr(ctorv))->prototype_prop;
  ((ts_object*)ts_ptr(inst))->proto = ts_is_obj(proto) ? proto : g_class_proto_tab[cid];
  ts_gc_root(&inst);
  int m = n + 1;
  tsv* callargs = malloc(sizeof(tsv) * (m > 0 ? m : 1));
  callargs[0] = inst;
  for (int i = 0; i < n; i++) callargs[1 + i] = args[i];
  tsv r = ts_call(ctorv, callargs, m);
  free(callargs);
  ts_gc_unroot(2);
  return ts_is_obj(r) ? r : inst;
}
static ts_class_reg* class_reg_for(ts_object* o){
  if (!o || !ts_proto_ref(o->proto)) return NULL;
  for (int i=0;i<g_class_reg_len;i++) if (g_class_regs[i].proto == o->proto) {
    ts_class_reg* r = &g_class_regs[i];
    size_t need = sizeof(ts_object);
    for (int j=0;j<r->nfields;j++){
      size_t width = r->fields[j].numeric ? sizeof(double) : sizeof(tsv);
      size_t end = r->fields[j].offset + width;
      if (end > need) need = end;
    }
    return o->h.size >= need ? r : NULL;
  }
  return NULL;
}
/* canonical-path bridge (A-2b): is `key` a struct field of o? give offset+numeric. */
static int class_field_lookup(ts_object* o, ts_key key, size_t* off, int* numeric){
  ts_class_reg* reg = class_reg_for(o);
  if (!reg) return 0;
  for (int i=0;i<reg->nfields;i++) if (reg->fields[i].name_id == key){
    *off = reg->fields[i].offset; *numeric = reg->fields[i].numeric; return 1;
  }
  return 0;
}
static tsv struct_field_get(ts_object* o, size_t off, int numeric){
  char* base=(char*)o;
  if (numeric){ double d; memcpy(&d, base+off, sizeof(double)); return ts_num(d); }
  tsv v; memcpy(&v, base+off, sizeof(tsv)); return v;
}
static void struct_field_set(ts_object* o, size_t off, int numeric, tsv v){
  char* base=(char*)o;
  if (numeric){ double d=ts_to_num(v); memcpy(base+off, &d, sizeof(double)); }
  else { memcpy(base+off, &v, sizeof(tsv)); ts_write_barrier(ts_obj(o), v); }
}
/* does object o (a typed class instance) have a struct field named `key`? The
   descriptor lists the full inherited field chain, so this covers fields declared
   in any ancestor class. Returns 0 for non-class or plain objects. */
static int class_has_field(ts_object* o, ts_key key){
  size_t off; int numeric;
  return class_field_lookup(o, key, &off, &numeric);
}
/* accessors for Object.keys/values/entries enumeration of class instances. */
static int class_reg_nfields(ts_class_reg* r){ return r ? r->nfields : 0; }
static uint32_t class_reg_field_key(ts_class_reg* r, int i){ return r->fields[i].name_id; }
static tsv class_reg_field_value(ts_class_reg* r, ts_object* o, int i){
  char* base=(char*)o;
  if (r->fields[i].numeric){
    double d; memcpy(&d, base+r->fields[i].offset, sizeof(double));
    return ts_num(d);
  }
  tsv fv; memcpy(&fv, base+r->fields[i].offset, sizeof(tsv));
  return fv;
}
static void gc_mark_class_fields(ts_object* o, int young, int depth){
  ts_class_reg* reg = class_reg_for(o);
  if (!reg) return;
  char* base = (char*)o;
  for (int i=0;i<reg->nfields;i++){
    if (reg->fields[i].numeric) continue;
    tsv fv;
    memcpy(&fv, base + reg->fields[i].offset, sizeof(tsv));
    gc_mark_visit(fv, young, depth);
  }
}

/* ---- canonical own-enumeration (property_model_redesign §3.2, A-2b-2) ----
   Visit obj's own enumerable DATA properties in JS order: typed struct fields
   (declaration order) first, then prop-map data props (insertion order). Accessor
   props and method keys are skipped (they are not enumerable data). The callback
   receives (key_id, value, ud). The CALLER must GC-root obj (the cb may allocate
   and move the heap); we re-fetch ts_ptr(obj) after each cb. Keys/values/entries,
   JSON.stringify, console.dir, Object.assign and object-spread all route here so
   the struct/prop-map split is handled in exactly one place. */
/* Is this property key a canonical integer index ("0","1",...,< 2^32-1, no leading
   zero)? JS enumerates such keys first, in ascending numeric order, before string
   keys (which keep insertion order). Returns the parsed index via *idx. */
static int prop_key_is_array_index(uint32_t key, uint32_t* idx){
  const char* n = ts_field_name(key);
  uint32_t len = ts_field_name_len(key);
  if (!n || len == 0) return 0;
  if (n[0]=='0' && len != 1) return 0;            /* no leading zeros ("01" is a string key) */
  uint64_t v = 0;
  for (uint32_t i=0;i<len;i++){
    if (n[i] < '0' || n[i] > '9') return 0;
    v = v*10 + (uint32_t)(n[i] - '0');
    if (v >= 0xFFFFFFFFull) return 0;            /* 2^32-1 is the max array index */
  }
  *idx = (uint32_t)v; return 1;
}
static void ts_proxy_enum(tsv pv, ts_prop_enum_cb cb, void* ud);
static void ts_prop_own_enum(tsv obj, ts_prop_enum_cb cb, void* ud){
  if (g_has_proxies && ts_is_proxy(obj)){ ts_proxy_enum(obj, cb, ud); return; }
  if (ts_is_str(obj)){
    ts_gc_root(&obj);
    for (uint32_t i=0;;i++){
      uint32_t len = ts_str_len_typed(obj);
      if (i>=len) break;
      char b[16]; int bn = snprintf(b, sizeof b, "%u", i);
      uint32_t k = ts_intern_field(b, (uint32_t)bn);
      tsv v = ts_string_slice_view(obj, i, 1);
      cb(k, v, ud);
    }
    ts_gc_unroot(1);
    return;
  }
  ts_object* sc = ts_class_static_container(obj);
  if (sc) obj = ts_obj(sc);
  if (!ts_is_obj(obj) || ts_is_map(obj) || ts_is_set(obj)) return;
  /* Arrays (unified model): own enumerable keys are the integer indices
     "0".."len-1" (in order, value = element) followed by any named properties
     in the common-header prop map (insertion order). Matches JS enumeration. */
  if (ts_is_array(obj)){
    for (uint32_t i=0;;i++){
      ts_array* a = ts_ptr(obj);
      if (i>=a->len) break;
      char b[16]; int bn = snprintf(b, sizeof b, "%u", i);
      uint32_t k = ts_intern_field(b, (uint32_t)bn);
      tsv v = a->data[i];
      cb(k, v, ud);
    }
    /* named props live in the common header's prop map (a->o.props). */
    for (uint32_t i=0;;i++){
      ts_obj_common* oc = &((ts_array*)ts_ptr(obj))->o;
      if (i>=oc->len) break;
      if (!prop_enum_data(&oc->props[i])) continue;
      uint32_t k = oc->props[i].key;
      tsv v = oc->props[i].val;
      cb(k, v, ud);
    }
    return;
  }
  ts_object* o=ts_ptr(obj);
  ts_class_reg* reg = class_reg_for(o);
  int nf = class_reg_nfields(reg);
  for (int i=0;i<nf;i++){
    uint32_t k = class_reg_field_key(reg, i);
    tsv v = class_reg_field_value(reg, ts_ptr(obj), i);
    cb(k, v, ud);
    /* reg/o may be stale after cb if a GC moved things; re-resolve for next read. */
    o = ts_ptr(obj); reg = class_reg_for(o);
  }
  /* JS property order for the prop map: integer-index keys first in ascending
     numeric order, then the remaining (string) keys in insertion order. We do a
     cheap pass to see if any integer-index key exists; if not (the common case),
     fall straight through to plain insertion order. */
  o = ts_ptr(obj);
  int has_index = 0;
  for (uint32_t i=0;i<o->len;i++){
    uint32_t idx;
    if (prop_enum_data(&o->props[i]) && prop_key_is_array_index(o->props[i].key, &idx)){ has_index = 1; break; }
  }
  if (has_index){
    /* selection over integer indices in ascending order (n is small in practice;
       plain objects with many integer keys should use an array anyway). */
    uint32_t prev_idx; int have_prev = 0; uint32_t emitted = 0, total_idx = 0;
    o = ts_ptr(obj);
    for (uint32_t i=0;i<o->len;i++){ uint32_t idx; if (prop_enum_data(&o->props[i]) && prop_key_is_array_index(o->props[i].key,&idx)) total_idx++; }
    while (emitted < total_idx){
      uint32_t best=0, best_key=0; tsv best_val=TS_UNDEFINED; int found=0;
      o = ts_ptr(obj);
      for (uint32_t i=0;i<o->len;i++){
        uint32_t idx;
        if (!prop_enum_data(&o->props[i]) || !prop_key_is_array_index(o->props[i].key,&idx)) continue;
        if (have_prev && idx <= prev_idx) continue;      /* already emitted */
        if (!found || idx < best){ best=idx; best_key=o->props[i].key; best_val=o->props[i].val; found=1; }
      }
      if (!found) break;
      cb(best_key, best_val, ud);
      prev_idx = best; have_prev = 1; emitted++;
      o = ts_ptr(obj);
    }
    /* then the non-integer (string) keys in insertion order */
    o = ts_ptr(obj);
    for (uint32_t i=0;;i++){
      o = ts_ptr(obj);
      if (i>=o->len) break;
      uint32_t idx;
      if (!prop_enum_data(&o->props[i])) continue;
      if (prop_key_is_array_index(o->props[i].key,&idx)) continue;
      uint32_t k = o->props[i].key;
      tsv v = o->props[i].val;
      cb(k, v, ud);
    }
    return;
  }
  for (uint32_t i=0;;i++){
    o = ts_ptr(obj);
    if (i>=o->len) break;
    if (!prop_enum_data(&o->props[i])) continue;
    uint32_t k = o->props[i].key;
    tsv v = o->props[i].val;
    cb(k, v, ud);
  }
}

/* obj instanceof C: true iff CLASS_PROTO[C] (target_proto) is in obj's prototype
   chain. Subclass protos chain to their parent, so this handles inheritance.
   Mirrors JS semantics (walk [[Prototype]] looking for C.prototype). */
int ts_instanceof(tsv obj, tsv target_proto){
  if (!ts_is_obj(obj) || !ts_is_obj(target_proto)) return 0;
  ts_object* o = (ts_object*)ts_ptr(obj);
  /* start from obj's own prototype (an instance is not its own prototype). */
  for (tsv p = o->proto; ts_proto_ref(p); ){
    if (p == target_proto) return 1;
    p = ((ts_object*)ts_ptr(p))->proto;
  }
  return 0;
}
/* `x instanceof C` with a Symbol.hasInstance hook: call C[Symbol.hasInstance](x)
   (this = the class object / static container) and ToBoolean its result. The
   exporter emits this only when C statically defines or inherits a static
   [Symbol.hasInstance], so the hook is guaranteed installed (callable). */
tsv ts_instanceof_hook(tsv klass, tsv obj){
  tsv h = ts_get(klass, TS_KEY_WKSYM(TS_WKSYM_HAS_INSTANCE));
  tsv a[2] = { klass, obj };
  return ts_bool(ts_truthy(ts_call_method(h, a, 2)));
}
/* `x instanceof C` where C is a runtime constructor VALUE (a class held in a
   variable/parameter/conditional, e.g. `const K = cond ? A : B; x instanceof K`).
   Mirrors JS: (1) if C[Symbol.hasInstance] is callable, return
   ToBoolean(C[Symbol.hasInstance](x)); (2) otherwise C is a class value (a ts_func
   carrying class_id) — walk x's prototype chain against that constructor value's
   current prototype property. A non-class / non-callable C yields false;
   the exporter only emits this when the RHS static type has construct signatures,
   so C is a class value in practice. The class value's proto is its static
   container, so ts_get resolves an (inherited) static [Symbol.hasInstance] hook. */
tsv ts_instanceof_dyn(tsv obj, tsv ctorv){
  if (ts_is_func(ctorv) || ts_is_obj(ctorv)){
    tsv h = ts_get(ctorv, TS_KEY_WKSYM(TS_WKSYM_HAS_INSTANCE));
    if (ts_is_func(h)){ tsv a[2] = { ctorv, obj }; return ts_bool(ts_truthy(ts_call_method(h, a, 2))); }
  }
  if (ts_is_func(ctorv)){
    uint32_t raw = ((ts_func*)ts_ptr(ctorv))->class_id;
    if (raw != 0){
      tsv proto = ((ts_func*)ts_ptr(ctorv))->prototype_prop;
      if (ts_is_obj(proto)) return ts_bool(ts_instanceof(obj, proto));
      return ts_bool(0);   /* defensive: a class value always carries an object proto */
    }
    /* Plain-function RHS (ES5 constructor): walk obj's chain against
       fn.prototype. A function whose prototype is not an object (arrows,
       methods, or a reassigned non-object .prototype) throws, matching V8.
       (V8 interpolates the actual prototype value into the message; we always
       print 'undefined' — refine if a fixture ever compares that message.) */
    tsv proto = ((ts_func*)ts_ptr(ctorv))->prototype_prop;
    if (ts_is_obj(proto)) return ts_bool(ts_instanceof(obj, proto));
    ts_throw_type_error_msg("Function has non-object prototype 'undefined' in instanceof check");
  }
  /* Non-callable RHS (a plain object without Symbol.hasInstance, a primitive):
     JS throws — reachable now that the exporter routes any-typed RHS here. */
  ts_throw_type_error_msg("Right-hand side of 'instanceof' is not callable");
  return ts_bool(0);   /* unreachable */
}
static int ident_like_bytes(const char* n, uint32_t len){
  if (!n || len == 0) return 0;
  if (!((n[0]>='a'&&n[0]<='z')||(n[0]>='A'&&n[0]<='Z')||n[0]=='_'||n[0]=='$')) return 0;
  for (uint32_t i=1;i<len;i++){
    char c=n[i];
    if (!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='_'||c=='$')) return 0;
  }
  return 1;
}
static void inspect_put_qchar(jbuf* b, uint32_t c){
  if (c=='\'' || c=='\\') jb_putc(b,'\\');
  if (ts_is_surrogate_code_unit(c)) jb_put_u_escape(b, c);
  else jb_put_utf8_cp(b,c);
}
static void inspect_qstr(jbuf* b, ts_strview s){
  jb_putc(b,'\'');
  for (uint32_t i=0;i<s.len;i++){
    uint32_t c=ts_str_cp_at_view(s, &i);
    inspect_put_qchar(b, c);
  }
  jb_putc(b,'\'');
}
static void inspect_qkey_bytes(jbuf* b, const char* name, uint32_t len){
  jb_putc(b,'\'');
  const unsigned char fallback = '?';
  if (!name) len = 1u;
  const unsigned char* p = name ? (const unsigned char*)name : &fallback;
  for(uint32_t i=0;i<len;){
    uint32_t c = utf8_next_cp_allow_surrogate(p, len, &i);
    inspect_put_qchar(b, c);
  }
  jb_putc(b,'\'');
}
/* top != 0 means a bare string prints raw (console.log("x") -> x); nested
   strings are single-quoted (console.log(["x"]) -> [ 'x' ]). Depth-guarded. */
static void inspect_val(jbuf* b, tsv v, int depth, int top);
/* Render a symbol property key as Node's util.inspect does: `Symbol(desc)`
   (no surrounding brackets, never quoted). USERSYM keys resolve their description
   via the sym_id side table; WKSYM keys via the well-known singleton. */
static void inspect_symbol_key(jbuf* b, ts_key k){
  jb_putz(b, "Symbol(");
  tsv desc = (k >= TS_USERSYM_KEY_BASE) ? sym_desc_by_id(k - TS_USERSYM_KEY_BASE)
                                        : ts_symbol_description(ts_wksym(k - TS_WKSYM_KEY_BASE));
  /* escape ' and \ like inspect_qstr (Node renders the description quoted-but-
     unbracketed: Symbol(a\'b)), without the surrounding quotes. */
  if (ts_is_str(desc)){ ts_strview d=ts_str_view_typed(desc);
    for (uint32_t i=0;i<d.len;i++){ uint32_t c=ts_str_cp_at_view(d,&i); if(c=='\''||c=='\\') jb_putc(b,'\\'); jb_put_utf8_cp(b,c); } }
  jb_putz(b, ")");
}
/* Count own ENUMERABLE symbol-keyed props (>= WKSYM base). The inspector lists
   these after string keys; Object.keys/JSON never see them (ts_prop_own_enum,
   which those use, is left untouched). */
static int count_own_enum_sym_props(tsv v){
  ts_object* o = ts_ptr(v); int c=0;
  for (uint32_t i=0;i<o->len;i++)
    if (o->props[i].key >= TS_WKSYM_KEY_BASE && prop_is_enumerable(&o->props[i])) c++;
  return c;
}
/* Emit own enumerable symbol-keyed props (`Symbol(desc): value`), in insertion
   order, after the string/index props. `first` is shared with the string pass so
   the separating comma is correct. */
static void inspect_own_sym_props(jbuf* b, tsv v, int depth, int* first){
  ts_object* o = ts_ptr(v);
  for (uint32_t i=0;i<o->len;i++){
    ts_key k = o->props[i].key;
    if (k < TS_WKSYM_KEY_BASE || !prop_is_enumerable(&o->props[i])) continue;
    tsv val = o->props[i].val;
    if (!*first) jb_putz(b, ", "); *first = 0;
    inspect_symbol_key(b, k); jb_putz(b, ": ");
    if (is_accessor(val)){
      ts_accessor* ac=(ts_accessor*)ts_ptr(val);
      int hg=ts_is_func(ac->getter), hs=ts_is_func(ac->setter);
      jb_putz(b, hg&&hs ? "[Getter/Setter]" : hg ? "[Getter]" : hs ? "[Setter]" : "undefined");
    } else {
      inspect_val(b, val, depth+1, 0);
    }
    o = ts_ptr(v); /* re-fetch (matches the existing prop-loop style) */
  }
}
/* object-property callbacks for console inspect (routes struct fields + prop map). */
typedef struct { jbuf* b; int depth; int first; int count; } inspect_obj_ctx;
static void cb_inspect_count(uint32_t key, tsv val, void* ud){
  (void)key; (void)val; ((inspect_obj_ctx*)ud)->count++;
}
static void cb_inspect_obj_prop(uint32_t key, tsv val, void* ud){
  inspect_obj_ctx* c=(inspect_obj_ctx*)ud;
  const char* n=ts_field_name(key);
  uint32_t n_len = ts_field_name_len(key);
  if (!c->first) jb_putz(c->b,", "); c->first=0;
  if (n && ident_like_bytes(n, n_len)) jb_puts(c->b,n,n_len);
  else inspect_qkey_bytes(c->b, n, n_len);
  jb_putz(c->b,": ");
  /* accessor: Node prints [Getter]/[Setter]/[Getter/Setter] WITHOUT invoking
     (avoids side effects in console.log). */
  if (is_accessor(val)){
    ts_accessor* ac=(ts_accessor*)ts_ptr(val);
    int hg=ts_is_func(ac->getter), hs=ts_is_func(ac->setter);
    jb_putz(c->b, hg&&hs ? "[Getter/Setter]" : hg ? "[Getter]" : hs ? "[Setter]" : "undefined");
    return;
  }
  inspect_val(c->b, val, c->depth+1, 0);
}

/* Emit an ANSI color code into the buffer only when colorization is active. */
static void jbc(jbuf* b, const char* code){ if (g_inspect_color) jb_putz(b, code); }

/* Node prefixes an object's inspection with its constructor name (`Name { ... }`),
   omitting it for plain objects (constructor "Object") and emitting
   `[Object: null prototype] ` when the prototype is null. The tag is uncolored.
   Resolves the name via `v.constructor.name` (walks the prototype chain), matching
   how user-class instances expose their constructor. */
static void inspect_ctor_prefix(jbuf* b, tsv v){
  tsv proto = ts_get_proto(v);
  if (ts_is_null(proto) || ts_is_undef(proto)){ jb_putz(b, "[Object: null prototype] "); return; }
  static uint32_t k_ctor = 0xFFFFFFFFu;
  if (k_ctor == 0xFFFFFFFFu) k_ctor = ts_intern_field("constructor", 11);
  tsv ctor = ts_get(v, k_ctor);
  if (!ts_is_func(ctor)) return;
  const char* nm = ((ts_func*)ts_ptr(ctor))->name;
  if (!nm || !*nm || strcmp(nm, "Object") == 0) return;  /* plain object: no prefix */
  jb_puts(b, nm, strlen(nm));
  jb_putc(b, ' ');
}

static void inspect_val(jbuf* b, tsv v, int depth, int top){
  if (depth > 256){ jb_putz(b,"[deep]"); return; }
  if (ts_is_undef(v)){ jbc(b,TSC_UNDEF); jb_putz(b,"undefined"); jbc(b,TSC_FGOFF); return; }
  if (ts_is_null(v)){ jbc(b,TSC_BOLD); jb_putz(b,"null"); jbc(b,TSC_BOLDOFF); return; }
  if (ts_is_bool(v)){ jbc(b,TSC_NUM); jb_putz(b,(v&1)?"true":"false"); jbc(b,TSC_FGOFF); return; }
  if (ts_is_num(v)){ jbc(b,TSC_NUM); double d=ts_to_num(v); if (d==0.0 && signbit(d)) jb_putz(b,"-0"); else { char nb[40]; ts_fmt_num(d,nb,sizeof nb); jb_putz(b,nb); } jbc(b,TSC_FGOFF); return; }
  if (ts_is_str(v)){
    ts_strview s=ts_str_view_typed(v);
    if (top){ uint32_t n=0; char* u=ts_str_utf8_copy_view(s, &n); jb_puts(b, u, n); free(u); }
    else { jbc(b,TSC_STR); inspect_qstr(b, s); jbc(b,TSC_FGOFF); }
    return;
  }
  if (ts_is_func(v)){
    const char* nm = ((ts_func*)ts_ptr(v))->name;
    jbc(b, TSC_FN);
    if (ts_is_class_value(v)){
      if (nm && *nm){ jb_putz(b,"[class "); jb_puts(b,nm,strlen(nm)); jb_putc(b,']'); }
      else jb_putz(b,"[class (anonymous)]");
    } else {
      if (nm && *nm){ jb_putz(b,"[Function: "); jb_puts(b,nm,strlen(nm)); jb_putc(b,']'); }
      else jb_putz(b,"[Function (anonymous)]");
    }
    jbc(b, TSC_FGOFF);
    return;
  }
  if (ts_is_array(v)){
    ts_gc_root(&v);
    ts_array* a=ts_ptr(v);
    if (a->len==0){ jb_putz(b,"[]"); ts_gc_unroot(1); return; }
    uint32_t len=a->len;
    jb_putz(b,"[ ");
    for (uint32_t i=0;i<len;i++){ a=ts_ptr(v); if(i) jb_putz(b,", "); inspect_val(b, (i<a->len)?a->data[i]:TS_UNDEFINED, depth+1, 0); }
    jb_putz(b," ]");
    ts_gc_unroot(1);
    return;
  }
  if (ts_is_map(v)){
    ts_gc_root(&v);
    ts_map* m=ts_ptr(v);
    uint32_t live = m->len - m->tombs;
    char hdr[32]; snprintf(hdr,sizeof hdr,"Map(%u)", live); jb_putz(b,hdr);
    if (live==0){ jb_putz(b," {}"); ts_gc_unroot(1); return; }
    uint32_t len=m->len;
    uint32_t printed=0;
    jb_putz(b," { ");
    for (uint32_t i=0;i<len;i++){ m=ts_ptr(v);
      tsv key=(i<m->len)?m->keys[i]:TS_UNDEFINED;
      tsv val=(i<m->len)?m->vals[i]:TS_UNDEFINED;
      if (key == TS_MAPSET_HOLE) continue;
      if (printed++) jb_putz(b,", ");
      ts_gc_root(&key); ts_gc_root(&val);
      inspect_val(b, key, depth+1, 0); jb_putz(b," => "); inspect_val(b, val, depth+1, 0);
      ts_gc_unroot(2); }
    jb_putz(b," }");
    ts_gc_unroot(1);
    return;
  }
  if (ts_is_set(v)){
    ts_gc_root(&v);
    ts_set_t* st=ts_ptr(v);
    uint32_t live = st->len - st->tombs;
    char hdr[32]; snprintf(hdr,sizeof hdr,"Set(%u)", live); jb_putz(b,hdr);
    if (live==0){ jb_putz(b," {}"); ts_gc_unroot(1); return; }
    uint32_t len=st->len;
    uint32_t printed=0;
    jb_putz(b," { ");
    for (uint32_t i=0;i<len;i++){ st=ts_ptr(v);
      tsv elem=(i<st->len)?st->elems[i]:TS_UNDEFINED;
      if (elem == TS_MAPSET_HOLE) continue;
      if (printed++) jb_putz(b,", ");
      ts_gc_root(&elem);
      inspect_val(b, elem, depth+1, 0);
      ts_gc_unroot(1); }
    jb_putz(b," }");
    ts_gc_unroot(1);
    return;
  }
  if (ts_is_obj(v)){
    if (ts_regexp_is_fast_obj(v)){
      tsv s = ts_regexp_to_string_fast(v);
      if (ts_is_str(s)){
        ts_gc_root(&s);
        ts_strview sv = ts_str_view_typed(s);
        uint32_t n = 0;
        char* u = ts_str_utf8_copy_view(sv, &n);
        jb_puts(b, u, n);
        free(u);
        ts_gc_unroot(1);
        return;
      }
    }
    /* count own enumerable data props first (to print {} vs { ... }). */
    inspect_obj_ctx ic; ic.b=b; ic.depth=depth; ic.first=1; ic.count=0;
    ts_gc_root(&v);
    ts_prop_own_enum(v, cb_inspect_count, &ic);
    int symc = count_own_enum_sym_props(v);
    inspect_ctor_prefix(b, v);   /* Node: `ClassName { ... }` / `Empty {}` (omitted for plain objects) */
    if (ic.count==0 && symc==0){ ts_gc_unroot(1); jb_putz(b,"{}"); return; }
    jb_putz(b,"{ ");
    ic.first=1;
    ts_prop_own_enum(v, cb_inspect_obj_prop, &ic);   /* string/index props */
    inspect_own_sym_props(b, v, depth, &ic.first);    /* then symbol props */
    jb_putz(b," }");
    ts_gc_unroot(1);
    return;
  }
  jb_putz(b,"[object]");
}
/* used by ts_print_to for arrays/objects/maps/sets/functions (top-level). */
static void ts_inspect_to(FILE* out, tsv v){
  jbuf b; jb_init(&b);
  inspect_val(&b, v, 0, 1);
  fwrite(b.p, 1, b.len, out);
  jb_free(&b);
}
/* console.dir(v): always inspect (nested-string quoting), trailing newline. */
void ts_console_dir(tsv v){
  g_inspect_color = ts_stream_wants_color(stdout);
  jbuf b; jb_init(&b);
  inspect_val(&b, v, 0, 0);
  fwrite(b.p, 1, b.len, stdout); fputc('\n', stdout);
  jb_free(&b);
}

/* ---- JSON.parse: recursive descent ---- */
typedef struct { const char* s; size_t i, n; int ok; } jparse;
static void jp_ws(jparse* p){ while(p->i<p->n){ char c=p->s[p->i]; if(c==' '||c=='\t'||c=='\n'||c=='\r') p->i++; else break; } }
static tsv jp_value(jparse* p);

static tsv jp_string(jparse* p){
  /* assumes p->s[p->i]=='"' */
  if (p->i >= p->n || p->s[p->i] != '"'){ p->ok=0; return TS_UNDEFINED; }
  size_t start = p->i + 1;
  size_t j = start;
  while (j < p->n){
    unsigned char c = (unsigned char)p->s[j];
    if (c == '"'){
      p->i = j + 1;
      return ts_new_string(p->s + start, (uint32_t)(j - start));
    }
    if (c == '\\') break;
    if (c < 0x20u){ p->ok=0; return TS_UNDEFINED; }
    j++;
  }
  p->i++; jbuf b; jb_init(&b);
  while (p->i<p->n){
    unsigned char c=(unsigned char)p->s[p->i++];
    if (c=='"'){ tsv r=ts_new_string(b.p,(uint32_t)b.len); jb_free(&b); return r; }
    if (c=='\\' && p->i<p->n){
      char e=p->s[p->i++];
      switch(e){
        case '"': jb_putc(&b,'"'); break;
        case '\\': jb_putc(&b,'\\'); break;
        case '/': jb_putc(&b,'/'); break;
        case 'n': jb_putc(&b,'\n'); break;
        case 'r': jb_putc(&b,'\r'); break;
        case 't': jb_putc(&b,'\t'); break;
        case 'b': jb_putc(&b,'\b'); break;
        case 'f': jb_putc(&b,'\f'); break;
        case 'u': {
          if (p->i+4<=p->n){
            char h[5]={p->s[p->i],p->s[p->i+1],p->s[p->i+2],p->s[p->i+3],0};
            p->i+=4; unsigned cp=(unsigned)strtol(h,NULL,16);
            /* encode UTF-8 (BMP only) */
            if (cp<0x80) jb_putc(&b,(char)cp);
            else if (cp<0x800){ jb_putc(&b,(char)(0xC0|(cp>>6))); jb_putc(&b,(char)(0x80|(cp&0x3F))); }
            else { jb_putc(&b,(char)(0xE0|(cp>>12))); jb_putc(&b,(char)(0x80|((cp>>6)&0x3F))); jb_putc(&b,(char)(0x80|(cp&0x3F))); }
          }
        } break;
        default: jb_putc(&b,e);
      }
    } else {
      if (c < 0x20u){ jb_free(&b); p->ok=0; return TS_UNDEFINED; }
      jb_putc(&b,(char)c);
    }
  }
  jb_free(&b); p->ok=0; return TS_UNDEFINED; /* unterminated */
}
static uint32_t jp_key_intern(jparse* p){
  /* Fast path for the overwhelmingly common object key: an unescaped UTF-8 JSON
     string. Avoid allocating a temporary ts_string just to intern the field id. */
  if (p->i >= p->n || p->s[p->i] != '"'){ p->ok = 0; return 0; }
  size_t start = p->i + 1;
  size_t j = start;
  while (j < p->n) {
    char c = p->s[j];
    if (c == '"') {
      p->i = j + 1;
      return ts_intern_field(p->s + start, (uint32_t)(j - start));
    }
    if (c == '\\') break;
    if ((unsigned char)c < 0x20u){ p->ok = 0; return 0; }
    j++;
  }
  tsv key = jp_string(p);
  if (!p->ok) return 0;
  ts_gc_root(&key);
  uint32_t kid = ts_intern_string_value(key);
  ts_gc_unroot(1);
  return kid;
}
static tsv jp_number(jparse* p){
  size_t start = p->i;
  int neg = 0;
  if (p->i < p->n && p->s[p->i] == '-') { neg = 1; p->i++; }
  if (p->i >= p->n || p->s[p->i] < '0' || p->s[p->i] > '9') {
    p->ok = 0;
    return TS_UNDEFINED;
  }
  uint64_t v = 0;
  int nd = 0;
  while (p->i < p->n && p->s[p->i] >= '0' && p->s[p->i] <= '9') {
    if (nd < 16) v = v * 10u + (uint64_t)(p->s[p->i] - '0');
    nd++;
    p->i++;
  }
  if (p->i < p->n && (p->s[p->i] == '.' || p->s[p->i] == 'e' || p->s[p->i] == 'E' || nd >= 16)) {
    p->i = start;
    char* end = NULL;
    double d = strtod(p->s + p->i, &end);
    if (end == p->s + p->i) { p->ok = 0; return TS_UNDEFINED; }
    p->i += (size_t)(end - (p->s + p->i));
    return ts_num(d);
  }
  if (neg && v == 0) return ts_num(-0.0);
  double d = (double)v;
  return ts_num(neg ? -d : d);
}
static void jp_obj_set_data(tsv obj, uint32_t key, tsv val){
  ts_object* o=(ts_object*)ts_ptr(obj);
  for (uint32_t i=0;i<o->len;i++){
    if (o->props[i].key==key){
      o->props[i].val=val;
      o->props[i].flags=TS_PROP_DEFAULT;
      ts_write_barrier(obj, val);
      return;
    }
  }
  if (o->len==o->cap){
    o->cap=o->cap?o->cap*2:8;
    o->props=realloc(o->props,sizeof(ts_prop)*o->cap);
  }
  ts_prop* p=&o->props[o->len++];
  p->key=key;
  p->val=val;
  p->flags=TS_PROP_DEFAULT;
  ts_write_barrier(obj, val);
}
static void jp_array_push_fast(tsv arr, tsv val){
  ts_array* a=(ts_array*)ts_ptr(arr);
  array_ensure_cap(a, a->len + 1);
  a->data[a->len++] = val;
  ts_write_barrier(arr, val);
}
static tsv jp_value(jparse* p){
  jp_ws(p);
  if (p->i>=p->n){ p->ok=0; return TS_UNDEFINED; }
  char c=p->s[p->i];
  if (c=='"') return jp_string(p);
  if (c=='{'){
    p->i++; tsv obj=ts_new_object();
    ts_gc_root(&obj);
    jp_ws(p);
    if (p->i<p->n && p->s[p->i]=='}'){ p->i++; ts_gc_unroot(1); return obj; }
    while (p->i<p->n){
      jp_ws(p);
      if (p->s[p->i]!='"'){ p->ok=0; ts_gc_unroot(1); return obj; }
      uint32_t key=jp_key_intern(p); if(!p->ok){ ts_gc_unroot(1); return obj; }
      jp_ws(p); if (p->i>=p->n||p->s[p->i]!=':'){ p->ok=0; ts_gc_unroot(1); return obj; } p->i++;
      tsv val=jp_value(p); if(!p->ok){ ts_gc_unroot(1); return obj; }
      ts_gc_root(&val);
      jp_obj_set_data(obj, key, val);
      ts_gc_unroot(1);
      jp_ws(p);
      if (p->i<p->n && p->s[p->i]==','){ p->i++; continue; }
      if (p->i<p->n && p->s[p->i]=='}'){ p->i++; break; }
      p->ok=0; ts_gc_unroot(1); return obj;
    }
    ts_gc_unroot(1);
    return obj;
  }
  if (c=='['){
    p->i++; tsv arr=ts_new_array(0);
    ts_gc_root(&arr);
    jp_ws(p);
    if (p->i<p->n && p->s[p->i]==']'){ p->i++; ts_gc_unroot(1); return arr; }
    while (p->i<p->n){
      tsv val=jp_value(p); if(!p->ok){ ts_gc_unroot(1); return arr; }
      ts_gc_root(&val);
      jp_array_push_fast(arr, val);
      ts_gc_unroot(1);
      jp_ws(p);
      if (p->i<p->n && p->s[p->i]==','){ p->i++; continue; }
      if (p->i<p->n && p->s[p->i]==']'){ p->i++; break; }
      p->ok=0; ts_gc_unroot(1); return arr;
    }
    ts_gc_unroot(1);
    return arr;
  }
  if (c=='t'){ if(p->i+4<=p->n && memcmp(p->s+p->i,"true",4)==0){ p->i+=4; return ts_bool(1);} p->ok=0; return TS_UNDEFINED; }
  if (c=='f'){ if(p->i+5<=p->n && memcmp(p->s+p->i,"false",5)==0){ p->i+=5; return ts_bool(0);} p->ok=0; return TS_UNDEFINED; }
  if (c=='n'){ if(p->i+4<=p->n && memcmp(p->s+p->i,"null",4)==0){ p->i+=4; return TS_NULL;} p->ok=0; return TS_UNDEFINED; }
  return jp_number(p);
}
tsv ts_json_parse(tsv text){
  if (!ts_is_str(text)) text = ts_to_string_v(text); /* JS: JSON.parse coerces ToString first (JSON.parse(5)->5) */
  ts_gc_root(&text);
  ts_strview view = ts_str_view_typed(text);
  jparse p;
  if ((view.flags & TS_STR_FLAG_ASCII) && !(view.flags & TS_STR_FLAG_UTF16)){
    gc_pin_string_storage(text);
    view = ts_str_view_typed(text);
    p = (jparse){ view.data, 0, view.len, 1 };
  } else {
    uint32_t text_len = 0;
    char* copy=ts_string_cstr_copy(text, &text_len);
    p = (jparse){ copy, 0, text_len, 1 };
  }
  tsv r=jp_value(&p);
  jp_ws(&p);
  if ((view.flags & TS_STR_FLAG_ASCII) && !(view.flags & TS_STR_FLAG_UTF16)){
    gc_unpin_string_storage(text);
  } else {
    free((void*)p.s);
  }
  ts_gc_unroot(1);
  if (!p.ok || p.i!=p.n){ ts_throw(ts_new_error(TS_ERR_SYNTAX, ts_new_string("Unexpected token in JSON", 24))); }
  return r;
}

tjson_value* ts_json_dom_parse(tsv text){
  if (!ts_is_str(text)) text = ts_to_string_v(text); /* JS: JSON.parse coerces ToString first (JSON.parse(5)->5) */
  ts_gc_root(&text);
  uint32_t len = 0;
  char* copy = ts_string_cstr_copy(text, &len);
  tjson_value* root = tjson_parse_take(copy, len);
  ts_gc_unroot(1);
  if (!root){ ts_throw(ts_new_error(TS_ERR_SYNTAX, ts_new_string("Unexpected token in JSON", 24))); }
  return root;
}

void ts_json_dom_scope_track(ts_json_dom_scope* scope, tjson_value* root){
  if (!scope || !root) return;
  if (scope->len == scope->cap){
    uint32_t nc = scope->cap ? scope->cap * 2u : 8u;
    tjson_value** roots = (tjson_value**)realloc(scope->roots, sizeof(tjson_value*) * (size_t)nc);
    if (!roots){ fprintf(stderr,"tsaot: JSON DOM scope: out of memory\n"); abort(); }
    scope->roots = roots;
    scope->cap = nc;
  }
  scope->roots[scope->len++] = root;
}

void ts_json_dom_scope_free(ts_json_dom_scope* scope){
  if (!scope) return;
  for (uint32_t i=0;i<scope->len;i++) tjson_free(scope->roots[i]);
  free(scope->roots);
  scope->roots = NULL;
  scope->len = 0;
  scope->cap = 0;
}

static uint32_t* ts_json_dom_field_hints = NULL;
static uint32_t ts_json_dom_field_hints_cap = 0;

static uint32_t* ts_json_dom_field_hint_slot(uint32_t key){
  if (key >= ts_json_dom_field_hints_cap){
    uint32_t nc = ts_json_dom_field_hints_cap ? ts_json_dom_field_hints_cap : 256u;
    while (key >= nc) nc *= 2u;
    uint32_t* next = (uint32_t*)realloc(ts_json_dom_field_hints, sizeof(uint32_t) * (size_t)nc);
    if (!next){ fprintf(stderr,"tsaot: JSON DOM field cache: out of memory\n"); abort(); }
    memset(next + ts_json_dom_field_hints_cap, 0, sizeof(uint32_t) * (size_t)(nc - ts_json_dom_field_hints_cap));
    ts_json_dom_field_hints = next;
    ts_json_dom_field_hints_cap = nc;
  }
  return &ts_json_dom_field_hints[key];
}

tjson_value* ts_json_dom_get(tjson_value* obj, uint32_t key){
  const char* name = ts_field_name(key);
  if (!name) return NULL;
  return tjson_object_get_hint(obj, name, ts_field_name_len(key), ts_json_dom_field_hint_slot(key));
}

tjson_value* ts_json_dom_get_dyn(tjson_value* obj, tsv key){
  if (!obj) return NULL;
  if (ts_is_num(key)) return ts_json_dom_index(obj, ts_to_num(key));
  if (ts_is_str(key)){
    uint32_t len = 0;
    char* s = ts_string_key_bytes_copy(key, &len);
    tjson_value* out = tjson_object_get(obj, s, len);
    free(s);
    return out;
  }
  return NULL;
}

tjson_value* ts_json_dom_index(tjson_value* arr, double index){
  if (!(index >= 0.0) || index != floor(index) || index > 4294967295.0) return NULL;
  return tjson_array_get(arr, (uint32_t)index);
}

double ts_json_dom_length(tjson_value* value){
  return tjson_length(value);
}

static tsv ts_json_dom_materialize(tjson_value* value){
  if (!value) return TS_UNDEFINED;
  switch (value->kind){
    case TJSON_NULL:
      return TS_NULL;
    case TJSON_BOOL:
      return ts_bool(value->as.boolean);
    case TJSON_NUMBER:
      return ts_num(value->as.number);
    case TJSON_STRING:
      return ts_new_string(value->as.string.data, value->as.string.len);
    case TJSON_ARRAY: {
      tsv arr = ts_new_array(0);
      ts_gc_root(&arr);
      for (uint32_t i=0;i<value->as.array.len;i++){
        tsv elem = ts_json_dom_materialize(value->as.array.items[i]);
        ts_gc_root(&elem);
        ts_array_push(arr, elem);
        ts_gc_unroot(1);
      }
      ts_gc_unroot(1);
      return arr;
    }
    case TJSON_OBJECT: {
      tsv obj = ts_new_object();
      ts_gc_root(&obj);
      for (uint32_t i=0;i<value->as.object.len;i++){
        tjson_member* m = &value->as.object.members[i];
        uint32_t key = ts_intern_field(m->key.data, m->key.len);
        tsv val = ts_json_dom_materialize(m->value);
        ts_gc_root(&val);
        ts_set(obj, key, val);
        ts_gc_unroot(1);
      }
      ts_gc_unroot(1);
      return obj;
    }
  }
  return TS_UNDEFINED;
}

double ts_json_dom_number(tjson_value* value){
  if (!value) return NAN;
  switch (value->kind){
    case TJSON_NUMBER:
      return value->as.number;
    case TJSON_BOOL:
      return value->as.boolean ? 1.0 : 0.0;
    case TJSON_NULL:
      return 0.0;
    case TJSON_STRING: {
      tsv s = ts_new_string(value->as.string.data, value->as.string.len);
      ts_gc_root(&s);
      double d = ts_number_coerce(s);
      ts_gc_unroot(1);
      return d;
    }
    case TJSON_ARRAY:
    case TJSON_OBJECT: {
      tsv v = ts_json_dom_materialize(value);
      ts_gc_root(&v);
      double d = ts_number_coerce(v);
      ts_gc_unroot(1);
      return d;
    }
  }
  return NAN;
}

static int ts_json_dom_primitive_tsv(tjson_value* value, tsv* out){
  if (!value){ *out = TS_UNDEFINED; return 1; }
  switch (value->kind){
    case TJSON_NULL:
      *out = TS_NULL;
      return 1;
    case TJSON_BOOL:
      *out = ts_bool(value->as.boolean);
      return 1;
    case TJSON_NUMBER:
      *out = ts_num(value->as.number);
      return 1;
    case TJSON_STRING:
      *out = ts_new_string(value->as.string.data, value->as.string.len);
      return 1;
    case TJSON_ARRAY:
    case TJSON_OBJECT:
      return 0;
  }
  *out = TS_UNDEFINED;
  return 1;
}

tsv ts_json_dom_add(tjson_value* lhs, tjson_value* rhs){
  tsv lv;
  if (!ts_json_dom_primitive_tsv(lhs, &lv)) lv = ts_json_dom_materialize(lhs);
  ts_gc_root(&lv);
  tsv rv;
  if (!ts_json_dom_primitive_tsv(rhs, &rv)) rv = ts_json_dom_materialize(rhs);
  ts_gc_root(&rv);
  tsv out = ts_add(lv, rv);
  ts_gc_unroot(2);
  return out;
}

tsv ts_json_dom_add_left(tjson_value* lhs, tsv rhs){
  ts_gc_root(&rhs);
  tsv lv;
  if (!ts_json_dom_primitive_tsv(lhs, &lv)) lv = ts_json_dom_materialize(lhs);
  ts_gc_root(&lv);
  tsv out = ts_add(lv, rhs);
  ts_gc_unroot(2);
  return out;
}

tsv ts_json_dom_add_right(tsv lhs, tjson_value* rhs){
  ts_gc_root(&lhs);
  tsv rv;
  if (!ts_json_dom_primitive_tsv(rhs, &rv)) rv = ts_json_dom_materialize(rhs);
  ts_gc_root(&rv);
  tsv out = ts_add(lhs, rv);
  ts_gc_unroot(2);
  return out;
}

tsv ts_json_dom_to_tsv(tjson_value* value){
  return ts_json_dom_materialize(value);
}

tsv ts_json_dom_stringify(tjson_value* value){
  if (!value) return TS_UNDEFINED;
  uint32_t len = 0;
  char* s = tjson_stringify_alloc(value, &len);
  tsv out = ts_new_string(s, len);
  free(s);
  return out;
}

double ts_json_dom_stringify_len(tjson_value* value){
  if (!value) return NAN;
  return tjson_stringify_len(value);
}

/* JSON.parse reviver (InternalizeJSONProperty): bottom-up, call reviver(key, value)
   on every element/property; a returned `undefined` deletes the property (for an
   array element it becomes a hole == undefined in our dense model). The reviver is
   invoked as a plain callback (this=undefined); revivers using `this` as the holder
   are not modeled. Keys are passed as strings (array indices stringified). */
static tsv json_internalize(tsv val, tsv key, tsv reviver){
  ts_gc_root(&val); ts_gc_root(&key); ts_gc_root(&reviver);
  if (ts_is_array(val)){
    uint32_t n=(uint32_t)ts_array_len(val);
    for (uint32_t i=0;i<n;i++){
      char kb[16]; int kl=snprintf(kb,sizeof kb,"%u",i);
      tsv ek=ts_new_string(kb,(uint32_t)kl);
      ts_gc_root(&ek);
      tsv ne=json_internalize(ts_array_get(val,i), ek, reviver);
      ts_gc_root(&ne);
      ts_array_set(val, i, ne);                 /* undefined elem -> hole (==undefined) */
      ts_gc_unroot(2);
    }
  } else if (ts_is_obj(val)){
    tsv keys=ts_object_keys(val);               /* snapshot: safe to mutate while iterating */
    ts_gc_root(&keys);
    uint32_t n=(uint32_t)ts_array_len(keys);
    for (uint32_t i=0;i<n;i++){
      tsv ks=ts_array_get(keys,i);
      ts_gc_root(&ks);
      uint32_t kid=ts_intern_string_value(ks);
      tsv nv=json_internalize(ts_get(val,kid), ks, reviver);
      ts_gc_root(&nv);
      if (ts_is_undef(nv)) ts_delete_prop(val, kid);
      else ts_set(val, kid, nv);
      ts_gc_unroot(2);
    }
    ts_gc_unroot(1);
  }
  tsv a[2]={key, val};
  tsv r=ts_call_value(reviver, a, 2);
  ts_gc_unroot(3);
  return r;
}
tsv ts_json_parse_reviver(tsv text, tsv reviver){
  ts_gc_root(&text); ts_gc_root(&reviver);
  tsv parsed=ts_json_parse(text);
  if (!ts_is_func(reviver)){ ts_gc_unroot(2); return parsed; }       /* non-function reviver: ignored (JS) */
  ts_gc_root(&parsed);
  tsv r=json_internalize(parsed, ts_new_string("",0), reviver);
  ts_gc_unroot(3);
  return r;
}

/* push all elements of src array onto dst array (for array-literal spread) */
void ts_array_push_all(tsv dst, tsv src){
  ts_gc_root(&dst); ts_gc_root(&src);
  ts_array* s=as_arr(src);
  if (s){
    uint32_t len = s->len;
    for(uint32_t i=0;i<len;i++){
      s=as_arr(src);
      ts_array_push(dst, (s && i<s->len) ? s->data[i] : TS_UNDEFINED);
    }
    ts_gc_unroot(2);
    return;
  }
  /* spread of a non-array iterable: Set (elements), Map ([k,v] pairs), or a
     generator (driven via .next() until done). Strings spread to chars. */
  if (ts_is_set(src)){
    ts_set_t* st=ts_ptr(src);
    uint32_t len = st->len;
    for(uint32_t i=0;i<len;i++){
      st=ts_ptr(src);
      tsv elem = (i<st->len) ? st->elems[i] : TS_UNDEFINED;
      if (elem == TS_MAPSET_HOLE) continue;
      ts_array_push(dst, elem);
    }
    ts_gc_unroot(2);
    return;
  }
  if (ts_is_map(src)){
    ts_map* m=ts_ptr(src);
    uint32_t len = m->len;
    for(uint32_t i=0;i<len;i++){
      m=ts_ptr(src);
      tsv k = (i<m->len) ? m->keys[i] : TS_UNDEFINED;
      tsv v = (i<m->len) ? m->vals[i] : TS_UNDEFINED;
      if (k == TS_MAPSET_HOLE) continue;
      tsv pair=ts_new_array(0);
      ts_gc_root(&pair);
      ts_array_push(pair, k); ts_array_push(pair, v);
      ts_array_push(dst, pair);
      ts_gc_unroot(1);
    }
    ts_gc_unroot(2);
    return;
  }
  if (ts_is_str(src)){
    uint32_t i = 0;
    for(;;){
      ts_string* str=ts_ptr(src);
      uint32_t len = str ? str->len : 0;
      if (i >= len) break;
      ts_strview xs = ts_str_view_typed(src);
      uint32_t clen = 1;
      uint16_t hi = ts_str_cu_at_view(xs, i);
      if (hi >= 0xD800u && hi <= 0xDBFFu && i + 1 < len){
        uint16_t lo = ts_str_cu_at_view(xs, i + 1);
        if (lo >= 0xDC00u && lo <= 0xDFFFu) clen = 2;
      }
      tsv ch = ts_string_slice_view(src, i, clen);
      ts_gc_root(&ch);
      ts_array_push(dst, ch);
      ts_gc_unroot(1);
      i += clen;
    }
    ts_gc_unroot(2);
    return;
  }
  if (ts_object_like(src)){
    /* An ITERABLE (object with [Symbol.iterator]) or an ITERATOR/generator. First
       acquire the iterator: call src[Symbol.iterator]() if present (a user iterable
       returns a SEPARATE iterator object); a generator is its own iterator (no such
       property) so iter stays = src. Then drive .next(): a plain iterator object
       has a callable `next` property; our generator coroutine has no common-header
       property map, so ts_get returns undefined and we fall back to ts_gen_next. */
    ts_key kdone = ts_intern_field("done", 4);
    ts_key kvalue = ts_intern_field("value", 5);
    ts_key knext = ts_intern_field("next", 4);
    tsv iter = src;
    tsv itf = ts_get(src, TS_KEY_WKSYM(TS_WKSYM_ITERATOR));
    if (ts_is_callable(itf)){
      ts_gc_root(&itf);
      tsv a0 = src;
      iter = ts_call_method(itf, &a0, 1);
      ts_gc_unroot(1);
    }
    ts_gc_root(&iter);
    for(;;){
      tsv nf = ts_get(iter, knext);
      tsv r;
      if (ts_is_callable(nf)){
        ts_gc_root(&nf);
        tsv a0 = iter;
        r = ts_call_method(nf, &a0, 1);
        ts_gc_unroot(1);
      }
      else { r = ts_gen_next(iter, TS_UNDEFINED); }
      ts_gc_root(&r);
      if (ts_truthy(ts_get(r, kdone))){ ts_gc_unroot(1); break; }
      tsv value = ts_get(r, kvalue);
      ts_array_push(dst, value);
      ts_gc_unroot(1);
    }
    ts_gc_unroot(1);
    ts_gc_unroot(2);
    return;
  }
  ts_gc_unroot(2);
}

/* Array.from(src): build a dense array from an iterable (array/Set/Map/string/
   generator) OR an array-like object ({ length, 0:…, 1:… }). Iterables reuse
   ts_array_push_all; an object exposing a callable `.next` is treated as an
   iterator, otherwise it is read positionally up to its numeric `length`. */
tsv ts_array_from(tsv src){
  ts_gc_root(&src);
  tsv dst = ts_new_array(0);
  ts_gc_root(&dst);
  if (as_arr(src) || ts_is_set(src) || ts_is_map(src) || ts_is_str(src)){
    ts_array_push_all(dst, src);
  } else if (ts_object_like(src)){
    /* Iterator if it is one of our generators (carries a `__coro` frame) or any
       object exposing a callable `.next`; otherwise read positionally (array-like). */
    tsv coro = ts_get(src, ts_intern_field("__coro", 6));
    tsv nextfn = ts_get(src, ts_intern_field("next", 4));
    tsv itf = ts_get(src, TS_KEY_WKSYM(TS_WKSYM_ITERATOR));
    if (ts_is_obj(coro) || ts_is_func(nextfn) || ts_is_callable(itf)){
      ts_array_push_all(dst, src);               /* iterable / iterator protocol */
    } else {
      tsv lv = ts_get(src, ts_intern_field("length", 6));
      uint32_t len = ts_is_num(lv) ? (uint32_t)ts_to_num(lv) : 0;
      /* array-like (non-iterable object): read numeric properties "0".."len-1" by
         their string key (ts_array_get is for real arrays only). */
      for (uint32_t i=0;i<len;i++){
        char nb[16]; int nl = snprintf(nb, sizeof nb, "%u", i);
        ts_array_push(dst, ts_get(src, ts_intern_field(nb, (uint32_t)nl)));
      }
    }
  }
  ts_gc_unroot(2);
  return dst;
}
/* Array.from(src, mapFn): like ts_array_from, then mapFn(element, index) over it. */
tsv ts_array_from_mapped(tsv src, tsv fn){
  ts_gc_root(&src); ts_gc_root(&fn);
  tsv base = ts_array_from(src);
  ts_gc_root(&base);
  tsv dst = ts_new_array(0);
  ts_gc_root(&dst);
  ts_array* b = as_arr(base);
  uint32_t len = b ? b->len : 0;
  for (uint32_t i=0;i<len;i++){
    b = as_arr(base);                            /* refetch (push may realloc) */
    tsv a[2] = { b->data[i], ts_num((double)i) };
    ts_array_push(dst, ts_call_value(fn, a, 2));
  }
  ts_gc_unroot(4);
  return dst;
}

/* new Set(iterable): add each element. new Map(iterable): each element is a
   [key,value] pair. The iterable is first materialized into an array (reusing
   ts_array_push_all, which spreads arrays/generators/sets/maps/strings). */
tsv ts_set_seed(tsv setv, tsv iterable){
  if (!ts_is_set(setv)) return setv;
  ts_gc_root(&setv); ts_gc_root(&iterable);
  tsv tmp = ts_new_array(0); ts_gc_root(&tmp);
  ts_array_push_all(tmp, iterable);
  ts_array* a = as_arr(tmp);
  for(uint32_t i=0;i<a->len;i++){ ts_set_add(setv, a->data[i]); a = as_arr(tmp); }
  ts_gc_unroot(3);
  return setv;
}
tsv ts_map_seed(tsv mapv, tsv iterable){
  if (!ts_is_map(mapv)) return mapv;
  ts_gc_root(&mapv); ts_gc_root(&iterable);
  tsv tmp = ts_new_array(0); ts_gc_root(&tmp);
  ts_array_push_all(tmp, iterable);
  ts_array* a = as_arr(tmp);
  for(uint32_t i=0;i<a->len;i++){
    tsv pair = a->data[i];
    ts_array* p = as_arr(pair);
    tsv k = (p && p->len>0) ? p->data[0] : TS_UNDEFINED;
    tsv v = (p && p->len>1) ? p->data[1] : TS_UNDEFINED;
    ts_map_set(mapv, k, v);
    a = as_arr(tmp);
  }
  ts_gc_unroot(3);
  return mapv;
}

/* `key in obj`: own-or-inherited property presence by field id. */
/* Does `key` name one of the modeled Object.prototype methods? Used so that
   `"toString" in o` (and valueOf/hasOwnProperty/etc.) reports true: these methods
   live under METHOD_KEY_BASE+<name-id> keys, a different namespace from the
   field id `in` uses, so we match by field NAME instead. */
static int is_object_proto_name(uint32_t key){
  return field_name_is(key,"toString")
      || field_name_is(key,"toLocaleString")
      || field_name_is(key,"valueOf")
      || field_name_is(key,"hasOwnProperty")
      || field_name_is(key,"isPrototypeOf")
      || field_name_is(key,"propertyIsEnumerable");
}
/* Function.prototype's own method names (call/apply/bind), stored under METHOD
   keys, so the `in` operator's FIELD-key proto walk can't find them directly.
   Reported as present when the walk reaches g_function_proto. */
static int is_function_proto_name(uint32_t key){
  return field_name_is(key,"call") || field_name_is(key,"apply") || field_name_is(key,"bind");
}
int ts_has_prop(tsv obj, ts_key key){
  if (g_has_proxies && ts_is_proxy(obj)) return ts_proxy_has_v(obj, ts_key_to_value(key));
  /* function: own length/name, else walk the proto chain (Function.prototype's
     call/apply/bind, then Object.prototype's well-known methods). */
  if (ts_is_func(obj)){
    if (field_name_is(key, "length") || field_name_is(key, "name")) return 1;
    if (is_function_proto_name(key)) return 1;   /* call/apply/bind (METHOD-keyed) */
    for (ts_object* p = ts_ptr(obj); p; p = ts_next_proto(p)){
      if (find_slot(p, key, 0)) return 1;
      if (p == ts_proto_ptr(g_object_proto_v) && is_object_proto_name(key)) return 1;
    }
    return 0;
  }
  if (!ts_is_obj(obj)) return 0;
  /* arrays: a canonical index within bounds, or "length", is a present property
     (array elements live in element storage, not the prop map). */
  if (ts_is_array(obj)){
    const char* nm = ts_field_name(key);
    if (nm){
      uint32_t nm_len = ts_field_name_len(key);
      if (field_bytes_is(nm, nm_len, "length")) return 1;
      long ix = ts_canonical_array_index(nm, nm_len);
      if (ix >= 0 && (uint32_t)ix < ts_array_len(obj)) return 1;
    }
  }
  ts_object* o=ts_ptr(obj);
  /* typed class instance: struct fields aren't in the prop map; consult the
     class descriptor (covers the full inherited field chain). */
  if (class_has_field(o, key)) return 1;
  while (o){
    if (find_slot(o,key,0)) return 1;
    /* reaching Object.prototype: the well-known methods (stored under method
       keys) count as inherited properties for the `in` operator. */
    if (o == ts_proto_ptr(g_object_proto_v) && is_object_proto_name(key)) return 1;
    o=ts_next_proto(o);
  }
  return 0;
}

int ts_is_nullish(tsv v){ return ts_is_null(v) || ts_is_undef(v); }

/* object spread / Object.assign: copy own enumerable props from src to dst.
   Later writes win (matches {...a, ...b} and explicit keys after a spread). */
void ts_object_copy_props(tsv dst, tsv src){
  if (!ts_is_obj(dst)) return;
  /* arrays ARE valid spread sources ({...arr} -> {0:.., 1:..}); the enumerator
     yields their index keys. Only map/set/non-object sources are skipped. */
  if (ts_is_map(src) || ts_is_set(src) || (!ts_is_obj(src) && !ts_is_class_value(src) && !ts_is_str(src))) return;
  ts_gc_root(&dst); ts_gc_root(&src);
  enum_copy_ctx c; c.target=dst; c.recv=src;
  ts_prop_own_enum(src, cb_copy_to_target, &c);
  ts_gc_unroot(2);
}

int ts_is_undefined(tsv v){ return ts_is_undef(v); }

/* `delete obj.key`: remove a property. Returns 1 (JS delete returns true for
   configurable/absent props on plain objects). */
/* Strict-mode `delete` (the user `delete obj.x` expression): deleting a
   non-configurable own property throws a catchable TypeError (V8 message), unlike
   the internal ts_delete_prop which returns false. Non-own / configurable / absent
   keys delete normally. */
int ts_delete_prop_strict(tsv obj, ts_key key){
  if (g_has_proxies && ts_is_proxy(obj)) return ts_proxy_delete_v(obj, ts_key_to_value(key));
  if (!ts_is_obj(obj)) return 1;
  ts_object* o=ts_ptr(obj);
  int nonconf = 0;
  if (o->shape & (1u|4u)) {        /* frozen / sealed => all own props non-configurable */
    if (find_prop(o, key, 0)) nonconf = 1;
  } else {
    for (uint32_t i=0;i<o->len;i++){ if (o->props[i].key==key){ if (!prop_is_configurable(&o->props[i])) nonconf = 1; break; } }
  }
  if (nonconf){
    const char* nm = ts_field_name(key);
    char buf[256];
    snprintf(buf, sizeof(buf), "Cannot delete property '%s' of #<Object>", nm ? nm : "?");
    ts_throw_type_error_msg(buf);
    return 0;
  }
  return ts_delete_prop(obj, key);
}
int ts_delete_prop(tsv obj, ts_key key){
  if (g_has_proxies && ts_is_proxy(obj)) return ts_proxy_delete_v(obj, ts_key_to_value(key));
  if (!ts_is_obj(obj)) return 1;
  ts_object* o=ts_ptr(obj);
  if (o->shape & (1u|4u)) return 0;   /* frozen / sealed: delete ignored (false) */
  for (uint32_t i=0;i<o->len;i++){
    if (o->props[i].key==key){
      /* non-configurable: delete is ignored (returns false in sloppy mode). */
      if (!prop_is_configurable(&o->props[i])) return 0;
      /* shift remaining down to preserve insertion order */
      for (uint32_t j=i;j+1<o->len;j++) o->props[j]=o->props[j+1];
      o->len--; return 1;
    }
  }
  return 1;
}

/* Object.getOwnPropertyDescriptor(obj, key): build a descriptor object for an
   OWN property, or undefined if not own.
   - data: { value, writable, enumerable, configurable }
   - accessor: { get, set, enumerable, configurable }
   - struct field (class instance): data descriptor, all attributes true. */
static tsv build_data_descriptor(tsv value, int w, int e, int c){
  ts_gc_root(&value);
  tsv d = ts_new_object();
  ts_gc_root(&d);
  ts_set(d, ts_intern_field("value", 5), value);
  ts_set(d, ts_intern_field("writable", 8), ts_bool(w));
  ts_set(d, ts_intern_field("enumerable", 10), ts_bool(e));
  ts_set(d, ts_intern_field("configurable", 12), ts_bool(c));
  ts_gc_unroot(2);
  return d;
}
static tsv build_accessor_descriptor(tsv getter, tsv setter, int e, int c){
  ts_gc_root(&getter); ts_gc_root(&setter);
  tsv d = ts_new_object();
  ts_gc_root(&d);
  ts_set(d, ts_intern_field("get", 3), getter);
  ts_set(d, ts_intern_field("set", 3), setter);
  ts_set(d, ts_intern_field("enumerable", 10), ts_bool(e));
  ts_set(d, ts_intern_field("configurable", 12), ts_bool(c));
  ts_gc_unroot(3);
  return d;
}
static tsv descriptor_from_prop(ts_prop* p){
  int e=prop_is_enumerable(p), c=prop_is_configurable(p), w=prop_is_writable(p);
  if (is_accessor(p->val)){
    ts_accessor* ac=(ts_accessor*)ts_ptr(p->val);
    return build_accessor_descriptor(ac->getter, ac->setter, e, c);
  }
  return build_data_descriptor(p->val, w, e, c);
}
static tsv descriptor_from_prop_map(ts_object* o, ts_key key){
  for (uint32_t i=0;i<o->len;i++){
    if (o->props[i].key==key) return descriptor_from_prop(&o->props[i]);
  }
  return TS_UNDEFINED;
}
/* descriptor for an already-interned own key (used by the public entry + the
   getOwnPropertyDescriptors walker). */
static tsv ts_own_descriptor_by_key(tsv obj, ts_key key){
  const char* nm = ts_field_name(key);
  uint32_t nm_len = ts_field_name_len(key);
  if (ts_is_str(obj)){
    ts_string* s = ts_ptr(obj);
    if (nm && field_bytes_is(nm, nm_len, "length")) return build_data_descriptor(ts_num((double)s->len), 0, 0, 0);
    if (nm){
      long ix = ts_canonical_array_index(nm, nm_len);
      if (ix >= 0 && (uint32_t)ix < s->len){
        return build_data_descriptor(ts_string_slice_view(obj, (uint32_t)ix, 1), 0, 1, 0);
      }
    }
    return TS_UNDEFINED;
  }
  if (ts_is_array(obj) && nm){
    ts_array* a = ts_ptr(obj);
    if (field_bytes_is(nm, nm_len, "length")) return build_data_descriptor(ts_num((double)a->len), 1, 0, 0);
    long ix = ts_canonical_array_index(nm, nm_len);
    if (ix >= 0 && (uint32_t)ix < a->len) return build_data_descriptor(a->data[ix], 1, 1, 1);
  }
  if (ts_is_func(obj)){
    ts_object* sc = ts_class_static_container(obj);
    if (sc){
      tsv d = descriptor_from_prop_map(sc, key);
      if (!ts_is_undef(d)) return d;
    }
    ts_func* f = ts_ptr(obj);
    if (nm && field_bytes_is(nm, nm_len, "name")){
      const char* name = f->name ? f->name : "";
      return build_data_descriptor(ts_new_string(name, (uint32_t)strlen(name)), 0, 0, 1);
    }
    if (nm && field_bytes_is(nm, nm_len, "length")) return build_data_descriptor(ts_num((double)f->arity), 0, 0, 1);
    if (nm && field_bytes_is(nm, nm_len, "prototype") && !ts_is_undef(f->prototype_prop))
      return build_data_descriptor(f->prototype_prop, ts_is_class_value(obj) ? 0 : 1, 0, 0);
  }
  ts_object* o = ts_ptr(obj);
  if (o->h.kind == TS_KIND_OBJECT){ size_t off; int numeric;
    if (class_field_lookup(o, key, &off, &numeric))
      return build_data_descriptor(struct_field_get(o, off, numeric), 1, 1, 1); }
  return descriptor_from_prop_map(o, key);
}
tsv ts_get_own_property_descriptor(tsv obj, tsv keyv){
  if (g_has_proxies && ts_is_proxy(obj)) return ts_proxy_get_own_desc(obj, keyv);
  if (!ts_is_propbag(obj) && !ts_is_str(obj)) return TS_UNDEFINED;
  if (ts_is_propbag(obj)){
    ts_object* o = ts_ptr(obj);
    if (!kind_has_common_header(o->h.kind)) return TS_UNDEFINED;
  }
  ts_gc_root(&obj);
  ts_key key;
  int ok = ts_key_from_value(keyv, &key);
  if (!ok){ ts_gc_unroot(1); return TS_UNDEFINED; }
  tsv d = ts_own_descriptor_by_key(obj, key);
  ts_gc_unroot(1);
  return d;
}
/* Object.getOwnPropertyDescriptors(obj): object mapping each own key to its
   descriptor (includes non-enumerable own props and accessors). */
tsv ts_get_own_property_descriptors(tsv obj){
  if (!ts_is_propbag(obj) && !ts_is_str(obj)) return ts_new_object();
  ts_gc_root(&obj);
  tsv res = ts_new_object();
  ts_gc_root(&res);
  if (ts_is_str(obj)){
    ts_string* s = ts_ptr(obj);
    uint32_t len = s->len;
    for (uint32_t i=0;i<len;i++){
      char b[16]; int bn = snprintf(b, sizeof b, "%u", i);
      uint32_t k = ts_intern_field(b, (uint32_t)bn);
      tsv d = ts_own_descriptor_by_key(obj, k);
      if (!ts_is_undef(d)) ts_set(res, k, d);
      s = ts_ptr(obj); len = s->len;
    }
    uint32_t lk = ts_intern_field("length", 6);
    tsv d = ts_own_descriptor_by_key(obj, lk);
    if (!ts_is_undef(d)) ts_set(res, lk, d);
    ts_gc_unroot(2);
    return res;
  }
  ts_object* o = ts_ptr(obj);
  if (kind_has_common_header(o->h.kind)){
    if (ts_is_func(obj)){
      uint32_t lk = ts_intern_field("length", 6);
      uint32_t nk = ts_intern_field("name", 4);
      tsv d = ts_own_descriptor_by_key(obj, lk);
      if (!ts_is_undef(d)) ts_set(res, lk, d);
      d = ts_own_descriptor_by_key(obj, nk);
      if (!ts_is_undef(d)) ts_set(res, nk, d);
      uint32_t pk = ts_intern_field("prototype", 9);
      d = ts_own_descriptor_by_key(obj, pk);
      if (!ts_is_undef(d)) ts_set(res, pk, d);
      ts_object* sc = ts_class_static_container(obj);
      if (sc){
        tsv scv = ts_obj(sc);
        ts_gc_root(&scv);
        uint32_t slen = propbag_len(scv);
        for (uint32_t i=0;i<slen;i++){
          ts_prop* p = propbag_prop(scv, i); if (!p) continue;
          uint32_t k = p->key;
          d = ts_own_descriptor_by_key(obj, k);
          if (!ts_is_undef(d)) ts_set(res, k, d);
          slen = propbag_len(scv);
        }
        ts_gc_unroot(1);
        ts_gc_unroot(2);
        return res;
      }
    }
    o = ts_ptr(obj);
    if (o->h.kind == TS_KIND_OBJECT){
      ts_class_reg* reg = class_reg_for(o);
      int nf = class_reg_nfields(reg);
      for (int i=0;i<nf;i++){
        uint32_t k = class_reg_field_key(reg,i);
        tsv d = ts_own_descriptor_by_key(obj, k);
        if (!ts_is_undef(d)) ts_set(res, k, d);
        o = ts_ptr(obj);   /* re-resolve after possible GC */
      }
    }
    o = ts_ptr(obj);
    for (uint32_t i=0;i<o->len;i++){
      uint32_t k = o->props[i].key;
      tsv d = ts_own_descriptor_by_key(obj, k);
      if (!ts_is_undef(d)) ts_set(res, k, d);
      o = ts_ptr(obj);
    }
  }
  ts_gc_unroot(2);
  return res;
}

/* Object.defineProperty(obj, key, descriptor) — general (runtime) form for
   descriptors that can't be inspected statically. Reads the descriptor's own
   properties at runtime and dispatches to the data / accessor define paths.
   - value + get/set together -> TypeError (thrown, catchable)
   - data: value (default undefined); writable/enumerable/configurable default
     false when the key is ABSENT (Object.defineProperty semantics)
   - accessor: get/set (absent -> undefined); e/c default false; getter/setter
     `this`: a function whose body reads `this` (takes_this) is called with
     this=receiver, an arrow uses lexical this. */
void ts_define_property(tsv obj, tsv keyv, tsv desc){
  if (g_has_proxies && ts_is_proxy(obj)){ ts_proxy_define_property(obj, keyv, desc); return; }
  if (!ts_is_obj(obj)) return;
  if (!ts_is_obj(desc)){
    ts_throw(ts_new_string("TypeError: Property description must be an object", 48));
    return;
  }
  ts_gc_root(&obj); ts_gc_root(&desc); ts_gc_root(&keyv);
  ts_key k_value = ts_intern_field("value", 5);
  ts_key k_get   = ts_intern_field("get", 3);
  ts_key k_set   = ts_intern_field("set", 3);
  ts_key k_enum  = ts_intern_field("enumerable", 10);
  ts_key k_writ  = ts_intern_field("writable", 8);
  ts_key k_conf  = ts_intern_field("configurable", 12);
  int has_value = ts_has_own(desc, k_value);
  int has_get   = ts_has_own(desc, k_get);
  int has_set   = ts_has_own(desc, k_set);
  if (has_value && (has_get || has_set)){
    ts_gc_unroot(3);
    ts_throw(ts_new_string("TypeError: Invalid property descriptor (value with get/set)", 59));
    return;
  }
  int e = ts_has_own(desc, k_enum) ? ts_truthy(ts_get(desc, k_enum)) : 0;
  int c = ts_has_own(desc, k_conf) ? ts_truthy(ts_get(desc, k_conf)) : 0;
  if (has_get || has_set){
    tsv getter = has_get ? ts_get(desc, k_get) : TS_UNDEFINED;
    ts_gc_root(&getter);
    tsv setter = has_set ? ts_get(desc, k_set) : TS_UNDEFINED;
    ts_gc_root(&setter);
    int g_this = ts_is_func(getter) ? ((ts_func*)ts_ptr(getter))->takes_this : 0;
    int s_this = ts_is_func(setter) ? ((ts_func*)ts_ptr(setter))->takes_this : 0;
    ts_key key;
    int ok = ts_key_from_value(keyv, &key);
    ts_gc_unroot(2);
    if (!ok){ ts_gc_unroot(3); return; }
    ts_define_accessor_attr(obj, key, getter, setter, g_this, s_this, e, c);
    ts_gc_unroot(3);
    return;
  }
  int w = ts_has_own(desc, k_writ) ? ts_truthy(ts_get(desc, k_writ)) : 0;
  tsv value = has_value ? ts_get(desc, k_value) : TS_UNDEFINED;
  ts_define_data_dyn(obj, keyv, value, e, w, c);
  ts_gc_unroot(3);
}

/* Object.defineProperties(obj, descs): for each own enumerable key of descs,
   defineProperty(obj, key, descs[key]). */
typedef struct { tsv target; tsv descs; } defprops_ctx;
static void cb_define_one(uint32_t key, tsv val, void* ud){
  (void)val;
  defprops_ctx* c=(defprops_ctx*)ud;
  const char* n = ts_field_name(key);
  if (!n) return;
  tsv keystr = ts_new_string_from_field_key(key);
  ts_gc_root(&keystr);
  tsv d = ts_get(c->descs, key);
  ts_define_property(c->target, keystr, d);
  ts_gc_unroot(1);
}
void ts_define_properties(tsv obj, tsv descs){
  if (!ts_is_obj(obj) || !ts_is_obj(descs)) return;
  ts_gc_root(&obj); ts_gc_root(&descs);
  defprops_ctx c; c.target=obj; c.descs=descs;
  ts_prop_own_enum(descs, cb_define_one, &c);
  ts_gc_unroot(2);
}

/* `keyStr in obj` with a runtime string key (interns to a field id first). */
int ts_has_prop_dyn(tsv obj, tsv keyv){
  if (g_has_proxies && ts_is_proxy(obj)) return ts_proxy_has_v(obj, keyv);
  /* numeric key on an array: direct bounds check (`0 in arr`). */
  if (ts_is_array(obj) && ts_is_num(keyv)){
    double d = ts_to_num(keyv);
    return d >= 0 && d == (double)(uint32_t)d && (uint32_t)d < ts_array_len(obj);
  }
  ts_gc_root(&obj);
  ts_key key;
  int ok = ts_key_from_value(keyv, &key);
  int r = ok ? ts_has_prop(obj, key) : 0;
  ts_gc_unroot(1);
  return r;
}

/* own-property check (no prototype walk): used by obj.hasOwnProperty(k) and
   Object.hasOwn(o, k). A typed class instance's struct fields count as own
   (they are set on `this` in the constructor). Accessor own props count too. */
int ts_has_own(tsv obj, ts_key key){
  const char* nm = ts_field_name(key);
  /* string: own = a canonical index in [0,len) or "length". (Strings have no own
     data property map; their characters/length are the only own properties.) */
  if (ts_is_str(obj)){
    return ts_string_own_prop(obj, key, NULL);
  }
  /* function: own = "length" or "name" (both always present on our functions;
     "prototype" is not modeled = a separate gap). call/apply/bind are inherited
     from Function.prototype, so they are NOT own. A function may also carry
     explicitly-assigned own props in its prop map. */
  if (ts_is_func(obj)){
    if (field_name_is(key, "length") || field_name_is(key, "name")) return 1;
    if (field_name_is(key, "prototype") && !ts_is_undef(((ts_func*)ts_ptr(obj))->prototype_prop)) return 1;
    ts_object* sc = ts_class_static_container(obj);
    if (sc && find_slot(sc, key, 0) != NULL) return 1;
    return find_slot((ts_object*)ts_ptr(obj), key, 0) != NULL;
  }
  if (!ts_is_obj(obj)) return 0;
  ts_object* o=ts_ptr(obj);
  /* array: own = a canonical index in [0,len) or "length" (elements live in
     element storage, not the prop map). Explicitly-set props fall through below. */
  if (ts_is_array(obj) && nm){
    uint32_t nm_len = ts_field_name_len(key);
    if (field_bytes_is(nm, nm_len, "length")) return 1;
    long ix = ts_canonical_array_index(nm, nm_len);
    if (ix >= 0 && (uint32_t)ix < ts_array_len(obj)) return 1;
  }
  if (class_has_field(o, key)) return 1;     /* own typed struct field */
  return find_slot(o, key, 0) != NULL;       /* own prop slot (no proto walk) */
}
int ts_has_own_dyn(tsv obj, tsv keyv){
  ts_gc_root(&obj);
  ts_key key;
  int ok = ts_key_from_value(keyv, &key);
  int r = ok ? ts_has_own(obj, key) : 0;
  ts_gc_unroot(1);
  return r;
}

/* ---- Object.prototype methods (this = args[0]) ---- */
/* o.toString(): plain objects -> "[object Object]"; arrays -> elements joined by
   "," (Array.prototype.toString). Mirrors the common JS cases. */
tsv ts_objproto_toString(tsv* args, int n){
  tsv self = (n>0) ? args[0] : TS_UNDEFINED;
  if (ts_is_array(self)) return ts_array_join(self, ts_new_string(",",1));
  if (ts_regexp_is_fast_obj(self)){
    tsv r = ts_regexp_to_string_fast(self);
    if (ts_is_str(r)) return r;
  }
  /* Symbol.toStringTag: a string-valued [Symbol.toStringTag] replaces the default
     "Object" tag (ES2015), so Object.prototype.toString -> "[object <tag>]". This
     also reaches String(o) / `${o}` / o.toString() via ts_to_primitive's toString.
     self/tag stay rooted and tag bytes are copied into a local buffer before
     the single result allocation, so moving minor cannot stale the raw data. */
  if (ts_is_obj(self)){
    ts_gc_root(&self);
    tsv tag = ts_get(self, TS_KEY_WKSYM(TS_WKSYM_TO_STRING_TAG));
    if (ts_is_str(tag)){
      ts_gc_root(&tag);
      uint32_t tag_len = 0;
      char* tag_utf8 = ts_string_cstr_copy(tag, &tag_len);
      uint32_t len = 8u + tag_len + 1u;          /* "[object " (8) + tag + "]" (1) */
      char* buf = malloc(len);
      memcpy(buf, "[object ", 8);
      memcpy(buf + 8, tag_utf8, tag_len);
      buf[8u + tag_len] = ']';
      tsv r = ts_new_string(buf, len);
      free(tag_utf8);
      free(buf);
      ts_gc_unroot(1);
      ts_gc_unroot(1);
      return r;
    }
    ts_gc_unroot(1);
  }
  return ts_new_string("[object Object]", 15);
}
/* Object.prototype.toString.call(x): the SPEC Object.prototype.toString applied to
   an arbitrary `this` — produces the internal [[Class]]-style tag, NOT x's own
   toString (so an array yields "[object Array]", not its join). A string-valued
   [Symbol.toStringTag] overrides the builtin tag. */
tsv ts_objproto_tostring_call(tsv v){
  if (ts_is_undef(v)) return ts_new_string("[object Undefined]", 18);
  if (ts_is_null(v))  return ts_new_string("[object Null]", 13);
  /* arrays/plain objects can carry [Symbol.toStringTag]; funcs/primitives don't.
     Keep v/tag rooted and copy tag bytes before the result allocation. */
  if (ts_is_obj(v) && !ts_is_symbol(v)){
    ts_gc_root(&v);
    tsv tag = ts_get(v, TS_KEY_WKSYM(TS_WKSYM_TO_STRING_TAG));
    if (ts_is_str(tag)){
      ts_gc_root(&tag);
      uint32_t tag_len = 0;
      char* tag_utf8 = ts_string_cstr_copy(tag, &tag_len);
      uint32_t len = 8u + tag_len + 1u;
      char* buf = malloc(len);
      memcpy(buf, "[object ", 8);
      memcpy(buf + 8, tag_utf8, tag_len);
      buf[8u + tag_len] = ']';
      tsv r = ts_new_string(buf, len);
      free(tag_utf8);
      free(buf);
      ts_gc_unroot(1);
      ts_gc_unroot(1);
      return r;
    }
    ts_gc_unroot(1);
  }
  if (ts_regexp_is_fast_obj(v)) return ts_new_string("[object RegExp]", 15);
  const char* tag = ts_is_array(v)  ? "[object Array]"
                  : ts_is_func(v)   ? "[object Function]"
                  : ts_is_symbol(v) ? "[object Symbol]"
                  : ts_is_num(v)    ? "[object Number]"
                  : ts_is_str(v)    ? "[object String]"
                  : ts_is_bool(v)   ? "[object Boolean]"
                  : "[object Object]";
  return ts_new_string(tag, (uint32_t)strlen(tag));
}
/* o.valueOf(): returns the object itself (default Object.prototype.valueOf). */
tsv ts_objproto_valueOf(tsv* args, int n){ return (n>0) ? args[0] : TS_UNDEFINED; }
/* o.toLocaleString(): Object.prototype delegates to this.toString(). The lookup is
   ordinary property lookup, so an own toString shadows and Array/String/Number
   prototype toString methods are respected when this method is borrowed. */
tsv ts_objproto_toLocaleString(tsv* args, int n){
  tsv self = (n>0) ? args[0] : TS_UNDEFINED;
  ts_key key = ts_intern_field("toString", 8);
  tsv fn = ts_get(self, key);
  if (!ts_is_callable(fn)) ts_dynamic_method_missing(key);
  tsv call_args[1] = { self };
  return ts_call_method(fn, call_args, 1);
}
/* o.hasOwnProperty(k): own-property check (proto-based path; the exporter also
   intercepts hasOwnProperty directly, but this makes the prototype faithful). */
tsv ts_objproto_hasOwnProperty(tsv* args, int n){
  tsv self = (n>0) ? args[0] : TS_UNDEFINED;
  tsv key  = (n>1) ? args[1] : TS_UNDEFINED;
  return ts_bool(ts_has_own_dyn(self, key));
}
/* o.isPrototypeOf(v): true iff o appears in v's prototype chain. */
tsv ts_objproto_isPrototypeOf(tsv* args, int n){
  tsv self = (n>0) ? args[0] : TS_UNDEFINED;
  tsv value = (n>1) ? args[1] : TS_UNDEFINED;
  if (!ts_is_propbag(self) || !ts_is_propbag(value)) return ts_bool(0);
  if (!kind_has_common_header(((ts_gc_header*)ts_ptr(self))->kind) ||
      !kind_has_common_header(((ts_gc_header*)ts_ptr(value))->kind)) return ts_bool(0);
  tsv cur = ((ts_object*)ts_ptr(value))->proto;
  while (ts_proto_ref(cur)){
    if (cur == self) return ts_bool(1);
    if (!kind_has_common_header(((ts_gc_header*)ts_ptr(cur))->kind)) break;
    cur = ((ts_object*)ts_ptr(cur))->proto;
  }
  return ts_bool(0);
}
/* o.propertyIsEnumerable(k): own property exists and its enumerable flag is true.
   Reuse the descriptor path so arrays, strings, functions, accessors and typed
   class fields stay aligned with Object.getOwnPropertyDescriptor. */
tsv ts_objproto_propertyIsEnumerable(tsv* args, int n){
  tsv self = (n>0) ? args[0] : TS_UNDEFINED;
  tsv key = (n>1) ? args[1] : TS_UNDEFINED;
  tsv desc = ts_get_own_property_descriptor(self, key);
  if (ts_is_undef(desc)) return ts_bool(0);
  return ts_bool(ts_truthy(ts_get(desc, ts_intern_field("enumerable", 10))));
}

/* ---- Array.prototype methods (this = args[0]) ----
   Thin ts_code wrappers so a dynamic `arr.method()` (e.g. on an `any`-typed
   array, where static dispatch is unavailable) resolves through the prototype
   chain to the same builtins used by the static fast path. Each unpacks args[0]
   as the receiver and applies JS default-argument semantics. */
tsv ts_arrproto_join(tsv* a, int n){ return ts_array_join(a[0], (n>1 && a[1]!=TS_UNDEFINED)?a[1]:ts_new_string(",",1)); }
tsv ts_arrproto_toString(tsv* a, int n){ (void)n; return ts_array_join(a[0], ts_new_string(",",1)); }
tsv ts_arrproto_indexOf(tsv* a, int n){ return ts_num(ts_array_indexof(a[0], n>1?a[1]:TS_UNDEFINED, n>2?ts_to_num(a[2]):0, n>2)); }
tsv ts_arrproto_includes(tsv* a, int n){ return ts_bool(ts_array_includes(a[0], n>1?a[1]:TS_UNDEFINED, n>2?ts_to_num(a[2]):0, n>2)); }
tsv ts_arrproto_lastIndexOf(tsv* a, int n){ return ts_num(ts_array_lastindexof(a[0], n>1?a[1]:TS_UNDEFINED, n>2?ts_to_num(a[2]):0, n>2)); }
tsv ts_arrproto_slice(tsv* a, int n){ return ts_array_slice(a[0], n>1?ts_to_num(a[1]):0, n>2?ts_to_num(a[2]):0, n>2); }
tsv ts_arrproto_concat(tsv* a, int n){
  /* variadic: fold each arg through the 2-arg concat; no args -> shallow copy. */
  if(n<=1) return ts_array_slice(a[0], 0, 0, 0);
  tsv out=a[0]; ts_gc_root(&out);
  for(int k=1;k<n;k++) out=ts_array_concat(out, a[k]);
  ts_gc_unroot(1);
  return out;
}
tsv ts_arrproto_join_pop(tsv* a, int n){ (void)n; return ts_array_pop(a[0]); }
tsv ts_arrproto_pop(tsv* a, int n){ (void)n; return ts_array_pop(a[0]); }
tsv ts_arrproto_push(tsv* a, int n){ for(int i=1;i<n;i++) ts_array_push(a[0], a[i]); return ts_num(ts_array_len(a[0])); }
tsv ts_arrproto_shift(tsv* a, int n){ (void)n; return ts_array_shift(a[0]); }
tsv ts_arrproto_unshift(tsv* a, int n){ for(int i=n-1;i>=1;i--) ts_array_unshift(a[0], a[i]); return ts_num(ts_array_len(a[0])); }
tsv ts_arrproto_reverse(tsv* a, int n){ (void)n; return ts_array_reverse(a[0]); }
tsv ts_arrproto_at(tsv* a, int n){ return ts_array_at(a[0], n>1?ts_to_num(a[1]):0); }
tsv ts_arrproto_fill(tsv* a, int n){ return ts_array_fill(a[0], n>1?a[1]:TS_UNDEFINED, n>2?ts_to_num(a[2]):0, n>3?ts_to_num(a[3]):0, n>2, n>3); }
tsv ts_arrproto_flat(tsv* a, int n){ return ts_array_flat(a[0], n>1?ts_to_num(a[1]):1); }
tsv ts_arrproto_sort(tsv* a, int n){ return ts_array_sort(a[0], n>1?a[1]:TS_UNDEFINED); }
/* callback-taking methods: the callback is args[1] (a ts_func/closure). */
tsv ts_arrproto_map(tsv* a, int n){ return ts_array_map(a[0], n>1?a[1]:TS_UNDEFINED); }
tsv ts_arrproto_filter(tsv* a, int n){ return ts_array_filter(a[0], n>1?a[1]:TS_UNDEFINED); }
tsv ts_arrproto_forEach(tsv* a, int n){ return ts_array_foreach(a[0], n>1?a[1]:TS_UNDEFINED); }
tsv ts_arrproto_reduce(tsv* a, int n){ return ts_array_reduce(a[0], n>1?a[1]:TS_UNDEFINED, n>2?a[2]:TS_UNDEFINED, n>2); }
tsv ts_arrproto_splice(tsv* a, int n){
  tsv items=ts_new_array(0); ts_gc_root(&items);
  for(int k=3;k<n;k++) ts_array_push(items, a[k]);
  /* n counts the receiver: n==1 -> splice() deletes nothing; n==2 -> splice(start)
     deletes to end (has_dc=0); n>=3 -> deleteCount given. */
  int has_dc = (n>=3) || (n<=1);
  tsv r = ts_array_splice(a[0], n>1?ts_to_num(a[1]):0, n>2?ts_to_num(a[2]):0, has_dc, items);
  ts_gc_unroot(1);
  return r;
}
tsv ts_arrproto_reduceRight(tsv* a, int n){ return ts_array_reduce_right(a[0], n>1?a[1]:TS_UNDEFINED, n>2?a[2]:TS_UNDEFINED, n>2); }
tsv ts_arrproto_copyWithin(tsv* a, int n){ return ts_array_copy_within(a[0], n>1?ts_to_num(a[1]):0, n>2?ts_to_num(a[2]):0, n>3?ts_to_num(a[3]):0, n>3); }
tsv ts_arrproto_find(tsv* a, int n){ return ts_array_find(a[0], n>1?a[1]:TS_UNDEFINED); }
tsv ts_arrproto_findIndex(tsv* a, int n){ return ts_num(ts_array_findindex(a[0], n>1?a[1]:TS_UNDEFINED)); }
tsv ts_arrproto_findLast(tsv* a, int n){ return ts_array_findlast(a[0], n>1?a[1]:TS_UNDEFINED); }
tsv ts_arrproto_findLastIndex(tsv* a, int n){ return ts_num(ts_array_findlastindex(a[0], n>1?a[1]:TS_UNDEFINED)); }
tsv ts_arrproto_some(tsv* a, int n){ return ts_bool(ts_array_some(a[0], n>1?a[1]:TS_UNDEFINED)); }
tsv ts_arrproto_every(tsv* a, int n){ return ts_bool(ts_array_every(a[0], n>1?a[1]:TS_UNDEFINED)); }
tsv ts_arrproto_flatMap(tsv* a, int n){ return ts_array_flatmap(a[0], n>1?a[1]:TS_UNDEFINED); }

/* The runtime-owned Array.prototype. Created and populated by the emitted setup
   (ts_setup_array_proto, which knows the per-program method-name ids) via
   ts_array_proto_register; ts_new_array chains every array to it. */

tsv ts_array_proto(void){ return ts_proto_ref(g_array_proto_v) ? g_array_proto_v : TS_NULL; }
/* Allocate (once) the array prototype; its own proto is Object.prototype so that
   Object.prototype methods (hasOwnProperty, ...) are also reachable on arrays. */
void ts_array_proto_init(void){
  if (ts_proto_ref(g_array_proto_v)) return;
  static int rooted = 0;
  /* Array.prototype is itself an Array exotic object (length 0) in JS, so
     `Array.isArray(Array.prototype)` is true. Allocate it as a TS_KIND_ARRAY (not
     a plain object): ts_array embeds ts_obj_common first, so the (ts_object*) view
     used everywhere for proto/property access still aliases the common header. */
  g_array_proto_v = ts_new_array(0);
  ts_root_static_once(&g_array_proto_v, &rooted);
  ((ts_object*)ts_ptr(g_array_proto_v))->proto = g_object_proto_v;
}
/* Register one Array.prototype method under its method-key (id from the exporter). */
/* Builtin prototype methods (Array/Map/Set/Function .prototype) all read args[0]
   as their receiver (`this`), so they are registered with takes_this=1. The
   dynamic method-dispatch path (ts_call_method) drops the leading receiver for
   callees that lack this flag — without it, `arr.map(...)` / `f.call(...)` on an
   any-typed value would lose their receiver. */
void ts_array_proto_register(ts_key method_key, const char* name, ts_code fn){
  if (!ts_proto_ref(g_array_proto_v)) ts_array_proto_init();
  ts_proto_register_method(g_array_proto_v, method_key, name, fn);
}

/* ---- Map.prototype / Set.prototype methods (this = args[0]) ----
   Same mechanism as Array.prototype: thin ts_code wrappers so a dynamic
   m.get()/s.has() (e.g. on an any-typed Map/Set) resolves through the prototype
   chain to the static builtins. `size` is a property, not a method, so it is not
   registered here (accessed via the CallBuiltin map.size/set.size fast path). */
tsv ts_mapproto_set(tsv* a, int n){ return ts_map_set(a[0], n>1?a[1]:TS_UNDEFINED, n>2?a[2]:TS_UNDEFINED); }
tsv ts_mapproto_get(tsv* a, int n){ return ts_map_get(a[0], n>1?a[1]:TS_UNDEFINED); }
tsv ts_mapproto_has(tsv* a, int n){ return ts_bool(ts_map_has(a[0], n>1?a[1]:TS_UNDEFINED)); }
tsv ts_mapproto_delete(tsv* a, int n){ return ts_bool(ts_map_delete(a[0], n>1?a[1]:TS_UNDEFINED)); }
tsv ts_mapproto_clear(tsv* a, int n){ (void)n; ts_map_clear(a[0]); return TS_UNDEFINED; }
tsv ts_mapproto_keys(tsv* a, int n){ (void)n; return ts_map_keys(a[0]); }
tsv ts_mapproto_values(tsv* a, int n){ (void)n; return ts_map_values(a[0]); }
tsv ts_mapproto_forEach(tsv* a, int n){ ts_map_foreach(a[0], n>1?a[1]:TS_UNDEFINED); return TS_UNDEFINED; }
tsv ts_setproto_add(tsv* a, int n){ return ts_set_add(a[0], n>1?a[1]:TS_UNDEFINED); }
tsv ts_setproto_has(tsv* a, int n){ return ts_bool(ts_set_has(a[0], n>1?a[1]:TS_UNDEFINED)); }
tsv ts_setproto_delete(tsv* a, int n){ return ts_bool(ts_set_delete(a[0], n>1?a[1]:TS_UNDEFINED)); }
tsv ts_setproto_clear(tsv* a, int n){ (void)n; ts_set_clear(a[0]); return TS_UNDEFINED; }
tsv ts_setproto_keys(tsv* a, int n){ (void)n; return ts_set_keys(a[0]); }
tsv ts_setproto_values(tsv* a, int n){ (void)n; return ts_set_values(a[0]); }
tsv ts_setproto_entries(tsv* a, int n){ (void)n; return ts_set_entries(a[0]); }
tsv ts_setproto_forEach(tsv* a, int n){ ts_set_foreach(a[0], n>1?a[1]:TS_UNDEFINED); return TS_UNDEFINED; }
tsv ts_headersproto_get(tsv* a, int n){ return ts_headers_get(n>0?a[0]:TS_UNDEFINED, n>1?a[1]:TS_UNDEFINED); }
tsv ts_headersproto_has(tsv* a, int n){ return ts_bool(ts_headers_has(n>0?a[0]:TS_UNDEFINED, n>1?a[1]:TS_UNDEFINED)); }
tsv ts_headersproto_keys(tsv* a, int n){ (void)n; return ts_headers_keys(n>0?a[0]:TS_UNDEFINED); }
tsv ts_headersproto_values(tsv* a, int n){ (void)n; return ts_headers_values(n>0?a[0]:TS_UNDEFINED); }
tsv ts_headersproto_entries(tsv* a, int n){ (void)n; return ts_headers_entries(n>0?a[0]:TS_UNDEFINED); }
tsv ts_headersproto_append(tsv* a, int n){ return ts_headers_append(n>0?a[0]:TS_UNDEFINED, n>1?a[1]:TS_UNDEFINED, n>2?a[2]:TS_UNDEFINED); }
tsv ts_headersproto_set(tsv* a, int n){ return ts_headers_set(n>0?a[0]:TS_UNDEFINED, n>1?a[1]:TS_UNDEFINED, n>2?a[2]:TS_UNDEFINED); }
tsv ts_headersproto_delete(tsv* a, int n){ return ts_headers_delete(n>0?a[0]:TS_UNDEFINED, n>1?a[1]:TS_UNDEFINED); }

tsv ts_map_proto(void){ return ts_proto_ref(g_map_proto_v) ? g_map_proto_v : TS_NULL; }
tsv ts_set_proto_obj(void){ return ts_proto_ref(g_set_proto_v) ? g_set_proto_v : TS_NULL; }
tsv ts_headers_proto(void){ return ts_proto_ref(g_headers_proto_v) ? g_headers_proto_v : TS_NULL; }
tsv ts_abort_controller_proto(void){ if (!ts_proto_ref(g_abort_controller_proto_v)) ts_abort_controller_proto_init(); return ts_proto_ref(g_abort_controller_proto_v) ? g_abort_controller_proto_v : TS_NULL; }
tsv ts_abort_signal_proto(void){ if (!ts_proto_ref(g_abort_signal_proto_v)) ts_abort_signal_proto_init(); return ts_proto_ref(g_abort_signal_proto_v) ? g_abort_signal_proto_v : TS_NULL; }
void ts_map_proto_init(void){
  if (ts_proto_ref(g_map_proto_v)) return;
  static int rooted = 0;
  g_map_proto_v = ts_new_proto();
  ts_root_static_once(&g_map_proto_v, &rooted);
  ((ts_object*)ts_ptr(g_map_proto_v))->proto = g_object_proto_v;
}
void ts_set_proto_init(void){
  if (ts_proto_ref(g_set_proto_v)) return;
  static int rooted = 0;
  g_set_proto_v = ts_new_proto();
  ts_root_static_once(&g_set_proto_v, &rooted);
  ((ts_object*)ts_ptr(g_set_proto_v))->proto = g_object_proto_v;
}
void ts_headers_proto_init(void){
  if (ts_proto_ref(g_headers_proto_v)) return;
  static int rooted = 0;
  g_headers_proto_v = ts_new_proto();
  ts_root_static_once(&g_headers_proto_v, &rooted);
  ((ts_object*)ts_ptr(g_headers_proto_v))->proto = g_object_proto_v;
}
void ts_abort_signal_proto_init(void){
  if (ts_proto_ref(g_abort_signal_proto_v)) return;
  static int rooted = 0;
  g_abort_signal_proto_v = ts_new_proto();
  ts_root_static_once(&g_abort_signal_proto_v, &rooted);
  ((ts_object*)ts_ptr(g_abort_signal_proto_v))->proto = g_object_proto_v;
}
void ts_abort_controller_proto_init(void){
  if (ts_proto_ref(g_abort_controller_proto_v)) return;
  static int rooted = 0;
  g_abort_controller_proto_v = ts_new_proto();
  ts_root_static_once(&g_abort_controller_proto_v, &rooted);
  ((ts_object*)ts_ptr(g_abort_controller_proto_v))->proto = g_object_proto_v;
  tsv fn = ts_make_fn_t(ts_abortcontrollerproto_abort, 0, 0, 1);
  ts_gc_root(&fn);
  ts_set(g_abort_controller_proto_v, ts_intern_field("abort", 5), fn);
  ts_gc_unroot(1);
}
void ts_map_proto_register(ts_key method_key, const char* name, ts_code fn){
  if (!ts_proto_ref(g_map_proto_v)) ts_map_proto_init();
  ts_proto_register_method(g_map_proto_v, method_key, name, fn);
}
void ts_set_proto_register(ts_key method_key, const char* name, ts_code fn){
  if (!ts_proto_ref(g_set_proto_v)) ts_set_proto_init();
  ts_proto_register_method(g_set_proto_v, method_key, name, fn);
}
void ts_headers_proto_register(ts_key method_key, const char* name, ts_code fn){
  if (!ts_proto_ref(g_headers_proto_v)) ts_headers_proto_init();
  ts_proto_register_method(g_headers_proto_v, method_key, name, fn);
}

/* ---- Function.prototype methods (this = args[0] = the function) ----
   call/apply/bind per ECMA-262. tsaot's calling convention is positional and a
   callee reads args[0] as `this` only if it was lowered with a `this` param
   (ts_func.takes_this). So thisArg is injected at args[0] ONLY for such callees;
   free functions ignore thisArg (matching JS, where a non-this function simply
   doesn't observe it). */
static tsv invoke_with_this(tsv fn, tsv thisArg, tsv* callArgs, int nCall){
  if (g_has_proxies && ts_is_proxy(fn)) return ts_proxy_apply(fn, thisArg, callArgs, nCall);
  if (!ts_is_func(fn))ts_throw_not_a_function(NULL);
  ts_gc_root(&fn); ts_gc_root(&thisArg);
  ts_func* f = ts_ptr(fn);
  int n = nCall + (f->takes_this ? 1 : 0);
  tsv* a = malloc(sizeof(tsv)*(n>0?n:1));
  if (f->takes_this){
    a[0] = thisArg;
    for (int i=0;i<nCall;i++) a[1+i]=callArgs[i];
  } else {
    for (int i=0;i<nCall;i++) a[i]=callArgs[i];
  }
  for (int i=0;i<n;i++) ts_gc_root(&a[i]);
  tsv r = ts_call(fn, a, n);   /* free fn: thisArg ignored, per JS */
  ts_gc_unroot(n + 2);
  free(a);
  return r;
}
/* fn.call(thisArg, a, b, ...) */
tsv ts_funcproto_call(tsv* args, int n){
  tsv fn = (n>0)?args[0]:TS_UNDEFINED;
  tsv thisArg = (n>1)?args[1]:TS_UNDEFINED;
  return invoke_with_this(fn, thisArg, (n>2)?(args+2):NULL, (n>2)?(n-2):0);
}
/* fn.apply(thisArg, argsArray) */
tsv ts_funcproto_apply(tsv* args, int n){
  tsv fn = (n>0)?args[0]:TS_UNDEFINED;
  tsv thisArg = (n>1)?args[1]:TS_UNDEFINED;
  tsv arr = (n>2)?args[2]:TS_UNDEFINED;
  if (ts_is_array(arr)){
    ts_gc_root(&fn); ts_gc_root(&thisArg); ts_gc_root(&arr);
    ts_array* a = ts_ptr(arr);
    int argc = (int)a->len;
    tsv* argv = malloc(sizeof(tsv)*(argc>0?argc:1));
    for (int i=0;i<argc;i++){
      a = ts_ptr(arr);
      argv[i] = ((uint32_t)i < a->len) ? a->data[i] : TS_UNDEFINED;
    }
    tsv r = invoke_with_this(fn, thisArg, argv, argc);
    free(argv);
    ts_gc_unroot(3);
    return r;
  }
  return invoke_with_this(fn, thisArg, NULL, 0);   /* null/undefined argsArray -> no args */
}
/* The thunk backing a bound function. Its env is [target, thisArg, partial...].
   ts_call prepends env to the live call args, so this thunk receives
   args = [target, thisArg, partial..., liveArgs...]. It reconstructs the call:
   target.call(thisArg, partial..., liveArgs...). */
tsv ts_bound_thunk(tsv* args, int n){
  /* env layout guaranteed by bind: at least target + thisArg. */
  tsv target = (n>0)?args[0]:TS_UNDEFINED;
  tsv thisArg = (n>1)?args[1]:TS_UNDEFINED;
  int nrest = (n>2)?(n-2):0;          /* partial... + liveArgs... already merged */
  return invoke_with_this(target, thisArg, (nrest>0)?(args+2):NULL, nrest);
}
/* fn.bind(thisArg, partial...) -> a new function with this and leading args fixed. */
tsv ts_funcproto_bind(tsv* args, int n){
  tsv fn = (n>0)?args[0]:TS_UNDEFINED;
  tsv thisArg = (n>1)?args[1]:TS_UNDEFINED;
  int npart = (n>2)?(n-2):0;
  uint32_t envlen = 2 + (uint32_t)npart;   /* [target, thisArg, partial...] */
  tsv* env = malloc(sizeof(tsv)*envlen);
  env[0]=fn; env[1]=thisArg;
  for (int i=0;i<npart;i++) env[2+i]=args[2+i];
  tsv bound = ts_make_fn(ts_bound_thunk, env, envlen);
  free(env);                                /* ts_make_fn copies env */
  /* the bound function itself does NOT take a separate `this` (its this is fixed),
     so a further .call on it won't re-inject — takes_this stays 0. */
  return bound;
}

/* Function.prototype itself, when CALLED, is a no-op that returns undefined. */
static tsv ts_noop_fn(tsv* args, int n){ (void)args; (void)n; return TS_UNDEFINED; }
/* Boxed with the FUNC selector (NOT ts_obj) so `typeof Function.prototype` is
   "function" and ts_get routes it through the function name/length path. */
tsv ts_function_proto(void){ return ts_is_func(g_function_proto_v) ? g_function_proto_v : TS_NULL; }
void ts_function_proto_init(void){
  if (ts_is_func(g_function_proto_v)) return;
  /* Allocate Function.prototype as a real callable no-op function (arity 0, name
     ""). ts_make_fn sets f->o.proto = g_function_proto (still NULL here); we fix it
     up to Object.prototype right after — JS: Function.prototype.__proto__ === Object
     .prototype. Object.prototype is set up first (ts_setup_object_proto runs before
     ts_setup_function_proto), so g_object_proto is already available. The holder is
     a permanent GC root so the singleton survives even with zero live functions. */
  g_function_proto_v = ts_make_fn_t(ts_noop_fn, NULL, 0, 0);
  ts_gc_root(&g_function_proto_v);
  ((ts_func*)ts_ptr(g_function_proto_v))->o.proto = g_object_proto_v;
}
void ts_function_proto_register(ts_key method_key, const char* name, ts_code fn){
  if (!ts_is_func(g_function_proto_v)) ts_function_proto_init();
  ts_proto_register_method(g_function_proto_v, method_key, name, fn);
}

/* ---- String.prototype methods (this = args[0]) ----
   Thin ts_code wrappers over the static string builtins so a method call on an
   any-typed string (resolved via ts_get -> g_string_proto) reaches the same
   implementation as the statically-typed `s.method()` fast path. Numeric results
   are boxed (ts_num) and boolean results wrapped (ts_bool) to match the value
   calling convention. */
tsv ts_strproto_toUpperCase(tsv* a, int n){ (void)n; return ts_str_toupper(a[0]); }
tsv ts_strproto_toLowerCase(tsv* a, int n){ (void)n; return ts_str_tolower(a[0]); }
tsv ts_strproto_toLocaleUpperCase(tsv* a, int n){ (void)n; return ts_str_toupper(a[0]); }
tsv ts_strproto_toLocaleLowerCase(tsv* a, int n){ (void)n; return ts_str_tolower(a[0]); }
tsv ts_strproto_slice(tsv* a, int n){ return ts_str_slice(a[0], n>1?ts_to_num(a[1]):0, n>2?ts_to_num(a[2]):0, n>2); }
tsv ts_strproto_indexOf(tsv* a, int n){ return ts_num(ts_str_indexof(a[0], n>1?a[1]:TS_UNDEFINED, n>2?ts_to_num(a[2]):0, n>2)); }
tsv ts_strproto_lastIndexOf(tsv* a, int n){ return ts_num(ts_str_lastindexof(a[0], n>1?a[1]:TS_UNDEFINED, n>2?ts_to_num(a[2]):0, n>2)); }
tsv ts_strproto_includes(tsv* a, int n){ return ts_bool(ts_str_includes(a[0], n>1?a[1]:TS_UNDEFINED, n>2?ts_to_num(a[2]):0, n>2)); }
tsv ts_strproto_substring(tsv* a, int n){ return ts_str_substring(a[0], n>1?ts_to_num(a[1]):0, n>2?ts_to_num(a[2]):0, n>2); }
tsv ts_strproto_startsWith(tsv* a, int n){ return ts_bool(ts_str_startswith(a[0], n>1?a[1]:TS_UNDEFINED, n>2?ts_to_num(a[2]):0, n>2)); }
tsv ts_strproto_endsWith(tsv* a, int n){ return ts_bool(ts_str_endswith(a[0], n>1?a[1]:TS_UNDEFINED, n>2?ts_to_num(a[2]):0, n>2)); }
tsv ts_strproto_charAt(tsv* a, int n){ return ts_str_charat(a[0], n>1?ts_to_num(a[1]):0); }
tsv ts_strproto_charCodeAt(tsv* a, int n){ return ts_num(ts_str_charcodeat(a[0], n>1?ts_to_num(a[1]):0)); }
tsv ts_strproto_codePointAt(tsv* a, int n){ return ts_str_codepointat(a[0], n>1?ts_to_num(a[1]):0); }
tsv ts_strproto_at(tsv* a, int n){ return ts_str_at(a[0], n>1?ts_to_num(a[1]):0); }
tsv ts_strproto_isWellFormed(tsv* a, int n){ (void)n; return ts_bool(ts_str_is_well_formed(a[0])); }
tsv ts_strproto_toWellFormed(tsv* a, int n){ (void)n; return ts_str_to_well_formed(a[0]); }
tsv ts_strproto_concat(tsv* a, int n){ tsv r=a[0]; for (int i=1;i<n;i++) r=ts_str_concat(r, a[i]); return r; }
tsv ts_strproto_repeat(tsv* a, int n){ return ts_str_repeat(a[0], n>1?ts_to_num(a[1]):0); }
tsv ts_strproto_trim(tsv* a, int n){ (void)n; return ts_str_trim(a[0]); }
tsv ts_strproto_trimStart(tsv* a, int n){ (void)n; return ts_str_trimstart(a[0]); }
tsv ts_strproto_trimEnd(tsv* a, int n){ (void)n; return ts_str_trimend(a[0]); }
tsv ts_strproto_trimLeft(tsv* a, int n){ (void)n; return ts_str_trimstart(a[0]); }
tsv ts_strproto_trimRight(tsv* a, int n){ (void)n; return ts_str_trimend(a[0]); }
tsv ts_strproto_split(tsv* a, int n){ return ts_str_split(a[0], n>1?a[1]:TS_UNDEFINED, n>2?a[2]:TS_UNDEFINED); }
tsv ts_strproto_padStart(tsv* a, int n){ return ts_str_padstart(a[0], n>1?ts_to_num(a[1]):0, n>2?a[2]:TS_UNDEFINED); }
tsv ts_strproto_padEnd(tsv* a, int n){ return ts_str_padend(a[0], n>1?ts_to_num(a[1]):0, n>2?a[2]:TS_UNDEFINED); }
tsv ts_strproto_replace(tsv* a, int n){ return ts_str_replace(a[0], n>1?a[1]:TS_UNDEFINED, n>2?a[2]:TS_UNDEFINED, 0); }
tsv ts_strproto_replaceAll(tsv* a, int n){ return ts_str_replace(a[0], n>1?a[1]:TS_UNDEFINED, n>2?a[2]:TS_UNDEFINED, 1); }

tsv ts_string_proto(void){ return ts_proto_ref(g_string_proto_v) ? g_string_proto_v : TS_NULL; }
void ts_string_proto_init(void){
  if (ts_proto_ref(g_string_proto_v)) return;
  static int rooted = 0;
  g_string_proto_v = ts_new_proto();
  ts_root_static_once(&g_string_proto_v, &rooted);
  ((ts_object*)ts_ptr(g_string_proto_v))->proto = g_object_proto_v;  /* chain to Object.prototype */
}
void ts_string_proto_register(ts_key method_key, const char* name, ts_code fn){
  if (!ts_proto_ref(g_string_proto_v)) ts_string_proto_init();
  ts_proto_register_method(g_string_proto_v, method_key, name, fn);
}

/* ---- Number.prototype methods (this = args[0]) ----
   Thin ts_code wrappers over the static number builtins so a method call on an
   any-typed number (resolved via ts_get -> g_number_proto) reaches the same
   implementation as the statically-typed `n.method()` fast path. */
tsv ts_numproto_toFixed(tsv* a, int n){ return ts_number_to_fixed(a[0], n>1?ts_to_num(a[1]):0); }
tsv ts_numproto_toString(tsv* a, int n){ return ts_number_to_string_radix(a[0], n>1?ts_to_num(a[1]):10); }
tsv ts_numproto_toPrecision(tsv* a, int n){ return ts_number_to_precision(a[0], n>1?ts_to_num(a[1]):0); }
tsv ts_numproto_valueOf(tsv* a, int n){ (void)n; return a[0]; }

tsv ts_number_proto(void){ return ts_proto_ref(g_number_proto_v) ? g_number_proto_v : TS_NULL; }
void ts_number_proto_init(void){
  if (ts_proto_ref(g_number_proto_v)) return;
  static int rooted = 0;
  g_number_proto_v = ts_new_proto();
  ts_root_static_once(&g_number_proto_v, &rooted);
  ((ts_object*)ts_ptr(g_number_proto_v))->proto = g_object_proto_v;  /* chain to Object.prototype */
}
void ts_number_proto_register(ts_key method_key, const char* name, ts_code fn){
  if (!ts_proto_ref(g_number_proto_v)) ts_number_proto_init();
  ts_proto_register_method(g_number_proto_v, method_key, name, fn);
}

/* ---- Boolean.prototype methods (this = args[0]) ---- */
tsv ts_boolproto_toString(tsv* a, int n){
  (void)n;
  return ts_truthy(a[0]) ? ts_new_string("true", 4) : ts_new_string("false", 5);
}
tsv ts_boolproto_valueOf(tsv* a, int n){ (void)n; return ts_bool(ts_truthy(a[0])); }

tsv ts_boolean_proto(void){ return ts_proto_ref(g_boolean_proto_v) ? g_boolean_proto_v : TS_NULL; }
void ts_boolean_proto_init(void){
  if (ts_proto_ref(g_boolean_proto_v)) return;
  static int rooted = 0;
  g_boolean_proto_v = ts_new_proto();
  ts_root_static_once(&g_boolean_proto_v, &rooted);
  ((ts_object*)ts_ptr(g_boolean_proto_v))->proto = g_object_proto_v;  /* chain to Object.prototype */
}
void ts_boolean_proto_register(ts_key method_key, const char* name, ts_code fn){
  if (!ts_proto_ref(g_boolean_proto_v)) ts_boolean_proto_init();
  ts_proto_register_method(g_boolean_proto_v, method_key, name, fn);
}

/* object rest ({...rest} after destructuring): copy own enumerable data props
   except those in the exclusion list. */
typedef struct { tsv dst; const uint32_t* excl; int nexcl; tsv recv; } enum_rest_ctx;
static void cb_rest_copy(uint32_t key, tsv val, void* ud){
  enum_rest_ctx* c=(enum_rest_ctx*)ud;
  for (int j=0;j<c->nexcl;j++) if (c->excl[j]==key) return;
  tsv resolved = enum_resolve_value(c->recv, val);   /* accessor -> getter */
  ts_gc_root(&resolved);
  ts_set(c->dst, key, resolved);
  ts_gc_unroot(1);
}
tsv ts_object_rest(tsv src, const uint32_t* excl, int nexcl){
  ts_gc_root(&src);
  tsv dst=ts_new_object(); ts_gc_root(&dst);
  if (!ts_is_obj(src) || ts_is_map(src) || ts_is_set(src) || ts_is_array(src)) { ts_gc_unroot(2); return dst; }
  enum_rest_ctx c; c.dst=dst; c.excl=excl; c.nexcl=nexcl; c.recv=src;
  ts_prop_own_enum(src, cb_rest_copy, &c);
  ts_gc_unroot(2);
  return dst;
}

/* obj[key]: dynamic property load using ToPropertyKey (string/number/symbol). */
/* Reading a property off null/undefined is a TypeError in JS (catchable). Only
   the dynamic/`any` property-read path routes here; typed struct field reads use
   the direct-offset fast path and optional chaining (`x?.y`) guards the read out
   entirely, so neither reaches these. */
static tsv ts_throw_cannot_read(tsv obj, const char* prop){
  const char* what = ts_is_null(obj) ? "null" : "undefined";
  char buf[256];
  if (prop) snprintf(buf, sizeof buf, "Cannot read properties of %s (reading '%s')", what, prop);
  else      snprintf(buf, sizeof buf, "Cannot read properties of %s", what);
  ts_throw(ts_new_error(TS_ERR_TYPE, ts_new_string(buf, (uint32_t)strlen(buf))));
  return TS_UNDEFINED;
}
tsv ts_get_checked(tsv obj, ts_key key){
  if (ts_is_null(obj) || ts_is_undef(obj)) return ts_throw_cannot_read(obj, ts_field_name(key));
  return ts_get(obj, key);
}
tsv ts_get_dyn_checked(tsv obj, tsv keyv){
  if (ts_is_null(obj) || ts_is_undef(obj)){
    char tmp[128]; const char* prop = NULL;
    if (ts_is_str(keyv)){ ts_strview kv = ts_str_view_typed(keyv); uint32_t n = kv.len < sizeof(tmp)-1 ? kv.len : (uint32_t)sizeof(tmp)-1; memcpy(tmp, kv.data, n); tmp[n]=0; prop=tmp; }
    else if (ts_is_num(keyv)){ ts_fmt_num(ts_to_num(keyv), tmp, sizeof tmp); prop=tmp; }
    return ts_throw_cannot_read(obj, prop);
  }
  return ts_get_dyn(obj, keyv);
}
tsv ts_get_dyn(tsv obj, tsv keyv){
  if (g_has_proxies && ts_is_proxy(obj)) return ts_proxy_get_v(obj, keyv, obj);
  if (ts_is_str(keyv)){
    ts_gc_root(&obj);
    ts_key key;
    int ok = ts_key_from_value(keyv, &key);
    tsv r = ok ? ts_get(obj, key) : TS_UNDEFINED;
    ts_gc_unroot(1);
    return r;
  }
  /* numeric key on an array uses the element fast path */
  if (ts_is_array(obj) && ts_is_num(keyv)) return ts_array_get(obj, (uint32_t)ts_to_num(keyv));
  /* numeric/dynamic key on a string still goes through ToPropertyKey, so
     (s as any)[0] and (s as any)["0"] both read the String exotic index. */
  if (ts_is_str(obj)){
    ts_gc_root(&obj);
    ts_key key;
    int ok = ts_key_from_value(keyv, &key);
    tsv r = ok ? ts_get(obj, key) : TS_UNDEFINED;
    ts_gc_unroot(1);
    return r;
  }
  /* non-string key on an object: ToPropertyKey. Number keys become string/index
     keys; symbol keys stay symbols. */
  if (ts_is_obj(obj)){
    ts_gc_root(&obj);
    ts_key key;
    int ok = ts_key_from_value(keyv, &key);
    tsv r = ok ? ts_get(obj, key) : TS_UNDEFINED;
    ts_gc_unroot(1);
    return r;
  }
  return TS_UNDEFINED;
}

/* obj[key] = v: dynamic property store using ToPropertyKey. */
void ts_set_dyn(tsv obj, tsv keyv, tsv v){
  if (g_has_proxies && ts_is_proxy(obj)){ ts_proxy_set_v(obj, keyv, v, obj); return; }
  if (ts_is_str(keyv)){
    ts_gc_root(&obj); ts_gc_root(&v);
    ts_key key;
    int ok = ts_key_from_value(keyv, &key);
    if (ok) ts_set(obj, key, v);
    ts_gc_unroot(2);
    return;
  }
  if (ts_is_array(obj) && ts_is_num(keyv)){ ts_array_set(obj, (uint32_t)ts_to_num(keyv), v); return; }
  /* non-string key on an object: ToPropertyKey. Number keys become string/index
     keys; symbol keys stay symbols. */
  if (ts_is_obj(obj)){
    ts_gc_root(&obj); ts_gc_root(&v);
    ts_key key;
    int ok = ts_key_from_value(keyv, &key);
    if (ok) ts_set(obj, key, v);
    ts_gc_unroot(2);
  }
}

/* ---------------- Reflect (static reflection namespace) ----------------------
   Thin wrappers over the existing dynamic property / call / construct runtime.
   Reflect mirrors the proxy traps and returns booleans (success) where Object.*
   returns the object or throws. */
tsv ts_reflect_has(tsv t, tsv k){ return ts_bool(ts_has_prop_dyn(t, k)); }
tsv ts_reflect_set(tsv t, tsv k, tsv v){ ts_set_dyn(t, k, v); return ts_bool(1); }
tsv ts_reflect_delete(tsv t, tsv k){
  ts_gc_root(&t);
  ts_key key; int ok = ts_key_from_value(k, &key);
  int r = ok ? ts_delete_prop(t, key) : 1;
  ts_gc_unroot(1);
  return ts_bool(r);
}
tsv ts_reflect_set_proto(tsv t, tsv p){ ts_set_proto(t, p); return ts_bool(1); }
tsv ts_reflect_define_property(tsv t, tsv k, tsv d){ ts_define_property(t, k, d); return ts_bool(1); }
tsv ts_reflect_prevent_extensions(tsv t){ ts_object_prevent_extensions(t); return ts_bool(1); }
/* Reflect.ownKeys: all own string keys (incl. non-enumerable, in spec order)
   followed by all own symbol keys. */
tsv ts_reflect_own_keys(tsv t){
  ts_gc_root(&t);
  tsv names = ts_object_get_own_property_names(t);
  ts_gc_root(&names);
  tsv syms = ts_object_get_own_property_symbols(t);
  ts_gc_root(&syms);
  tsv all = ts_array_concat(names, syms);
  ts_gc_unroot(3);
  return all;
}
/* Reflect.apply(fn, thisArg, argsArray) — identical to fn.apply's marshalling. */
tsv ts_reflect_apply(tsv fn, tsv thisArg, tsv argsArray){
  tsv a[3] = { fn, thisArg, argsArray };
  return ts_funcproto_apply(a, 3);
}
/* Reflect.construct(fn, argsArray) — spread argsArray and run the constructor. */
tsv ts_reflect_construct(tsv fn, tsv argsArray){
  if (!ts_is_array(argsArray)) return ts_construct(fn, NULL, 0);
  ts_gc_root(&fn); ts_gc_root(&argsArray);
  ts_array* a = ts_ptr(argsArray);
  int argc = (int)a->len;
  tsv* argv = malloc(sizeof(tsv)*(argc>0?argc:1));
  for (int i=0;i<argc;i++){ a = ts_ptr(argsArray); argv[i] = ((uint32_t)i < a->len) ? a->data[i] : TS_UNDEFINED; }
  tsv r = ts_construct(fn, argv, argc);
  free(argv);
  ts_gc_unroot(2);
  return r;
}

/* ---------------- Proxy (exotic object with handler traps) ------------------ */
tsv ts_proxy_new(tsv target, tsv handler){
  if (!ts_is_propbag(target) || !ts_is_propbag(handler))
    ts_throw_type_error("Cannot create proxy with a non-object as target or handler");
  ts_gc_root(&target); ts_gc_root(&handler);
  ts_proxy* px = (ts_proxy*)gc_alloc(sizeof(ts_proxy), TS_KIND_PROXY);
  px->target = target; px->handler = handler; px->revoked = 0;
  tsv pv = ts_obj(px);
  ts_write_barrier(pv, target); ts_write_barrier(pv, handler);
  g_has_proxies = 1;
  ts_gc_unroot(2);
  return pv;
}
/* Reconstruct the property-key VALUE (string or symbol) from an interned ts_key,
   for passing to a trap as its key argument. */
static tsv ts_key_to_value(ts_key k){
  if (k >= TS_USERSYM_KEY_BASE){ tsv s = sym_value_by_id(k - TS_USERSYM_KEY_BASE); return ts_is_undef(s) ? ts_new_string("",0) : s; }
  if (k >= TS_WKSYM_KEY_BASE) return ts_wksym(k - TS_WKSYM_KEY_BASE);
  const char* n = ts_field_name(k);
  return n ? ts_new_string(n, ts_field_name_len(k)) : ts_new_string("",0);
}
/* Look up a trap on the handler. Throws if the proxy is revoked or the trap is
   present-but-not-callable; returns TS_UNDEFINED when the trap is absent (the
   caller then performs the default operation on the target). */
static tsv ts_proxy_trap(tsv pv, tsv handler, const char* name){
  ts_proxy* px = ts_ptr(pv);
  if (px->revoked) ts_throw_type_error("Cannot perform operation on a proxy that has been revoked");
  tsv trap = ts_get(handler, ts_intern_field(name, (uint32_t)strlen(name)));
  if (ts_is_undef(trap) || ts_is_null(trap)) return TS_UNDEFINED;
  if (!ts_is_callable(trap)) ts_throw_type_error("proxy handler trap is not a function");
  return trap;
}
/* descriptor field helpers (descriptor is a fresh data/accessor object) */
static int pd_has(tsv d, const char* nm){ return ts_is_obj(d) && ts_has_prop(d, ts_intern_field(nm,(uint32_t)strlen(nm))); }
static tsv pd_get(tsv d, const char* nm){ return ts_get(d, ts_intern_field(nm,(uint32_t)strlen(nm))); }
static int pd_bool(tsv d, const char* nm){ return ts_truthy(pd_get(d, nm)); }

/* === GET === */
static void proxy_inv_get(tsv target, tsv keyv, tsv result){
  tsv desc = ts_get_own_property_descriptor(target, keyv);
  if (ts_is_undef(desc)) return;
  ts_gc_root(&desc);
  if (!pd_bool(desc, "configurable")){
    if (pd_has(desc, "value") && !pd_bool(desc, "writable")){
      if (!ts_object_is(result, pd_get(desc, "value")))
        ts_throw_type_error("'get' on proxy: trap returned a different value for a non-configurable, non-writable property");
    } else if (pd_has(desc, "get") && ts_is_undef(pd_get(desc, "get"))){
      if (!ts_is_undef(result))
        ts_throw_type_error("'get' on proxy: trap returned non-undefined for a non-configurable accessor with undefined getter");
    }
  }
  ts_gc_unroot(1);
}
static tsv ts_proxy_get_v(tsv pv, tsv keyv, tsv receiver){
  ts_gc_root(&pv); ts_gc_root(&keyv); ts_gc_root(&receiver);
  ts_proxy* px = ts_ptr(pv);
  tsv target = px->target, handler = px->handler;
  ts_gc_root(&target); ts_gc_root(&handler);
  tsv trap = ts_proxy_trap(pv, handler, "get");
  if (ts_is_undef(trap)){ tsv r = ts_get_dyn(target, keyv); ts_gc_unroot(5); return r; }
  ts_gc_root(&trap);
  tsv argv[3] = { target, keyv, receiver };
  tsv result = invoke_with_this(trap, handler, argv, 3);
  ts_gc_root(&result);
  proxy_inv_get(target, keyv, result);
  ts_gc_unroot(7);
  return result;
}
/* === SET === */
static void proxy_inv_set(tsv target, tsv keyv, tsv value){
  tsv desc = ts_get_own_property_descriptor(target, keyv);
  if (ts_is_undef(desc)) return;
  ts_gc_root(&desc);
  if (!pd_bool(desc, "configurable")){
    if (pd_has(desc, "value") && !pd_bool(desc, "writable")){
      if (!ts_object_is(value, pd_get(desc, "value")))
        ts_throw_type_error("'set' on proxy: trap set a different value for a non-configurable, non-writable property");
    } else if (pd_has(desc, "set") && ts_is_undef(pd_get(desc, "set"))){
      ts_throw_type_error("'set' on proxy: trap set value for a non-configurable accessor with undefined setter");
    }
  }
  ts_gc_unroot(1);
}
static int ts_proxy_set_v(tsv pv, tsv keyv, tsv value, tsv receiver){
  ts_gc_root(&pv); ts_gc_root(&keyv); ts_gc_root(&value); ts_gc_root(&receiver);
  ts_proxy* px = ts_ptr(pv);
  tsv target = px->target, handler = px->handler;
  ts_gc_root(&target); ts_gc_root(&handler);
  tsv trap = ts_proxy_trap(pv, handler, "set");
  if (ts_is_undef(trap)){ ts_set_dyn(target, keyv, value); ts_gc_unroot(6); return 1; }
  ts_gc_root(&trap);
  tsv argv[4] = { target, keyv, value, receiver };
  tsv res = invoke_with_this(trap, handler, argv, 4);
  int ok = ts_truthy(res);
  if (ok) proxy_inv_set(target, keyv, value);
  ts_gc_unroot(7);
  return ok;
}
/* === HAS === */
static void proxy_inv_has(tsv target, tsv keyv, int trapResult){
  if (trapResult) return;
  tsv desc = ts_get_own_property_descriptor(target, keyv);
  if (ts_is_undef(desc)) return;
  ts_gc_root(&desc);
  if (!pd_bool(desc, "configurable"))
    ts_throw_type_error("'has' on proxy: trap returned false for a non-configurable property");
  if (!ts_truthy(ts_object_is_extensible(target)))
    ts_throw_type_error("'has' on proxy: trap returned false for a property of a non-extensible target");
  ts_gc_unroot(1);
}
static int ts_proxy_has_v(tsv pv, tsv keyv){
  ts_gc_root(&pv); ts_gc_root(&keyv);
  ts_proxy* px = ts_ptr(pv);
  tsv target = px->target, handler = px->handler;
  ts_gc_root(&target); ts_gc_root(&handler);
  tsv trap = ts_proxy_trap(pv, handler, "has");
  if (ts_is_undef(trap)){ int r = ts_has_prop_dyn(target, keyv); ts_gc_unroot(4); return r; }
  ts_gc_root(&trap);
  tsv argv[2] = { target, keyv };
  int r = ts_truthy(invoke_with_this(trap, handler, argv, 2));
  proxy_inv_has(target, keyv, r);
  ts_gc_unroot(5);
  return r;
}
/* === DELETE === */
static int ts_proxy_delete_v(tsv pv, tsv keyv){
  ts_gc_root(&pv); ts_gc_root(&keyv);
  ts_proxy* px = ts_ptr(pv);
  tsv target = px->target, handler = px->handler;
  ts_gc_root(&target); ts_gc_root(&handler);
  tsv trap = ts_proxy_trap(pv, handler, "deleteProperty");
  if (ts_is_undef(trap)){
    ts_key k; int ok = ts_key_from_value(keyv, &k);
    int r = ok ? ts_delete_prop(target, k) : 1;
    ts_gc_unroot(4); return r;
  }
  ts_gc_root(&trap);
  tsv argv[2] = { target, keyv };
  int r = ts_truthy(invoke_with_this(trap, handler, argv, 2));
  if (r){
    tsv desc = ts_get_own_property_descriptor(target, keyv);
    if (!ts_is_undef(desc)){
      ts_gc_root(&desc);
      if (!pd_bool(desc, "configurable"))
        ts_throw_type_error("'deleteProperty' on proxy: trap deleted a non-configurable property");
      if (!ts_truthy(ts_object_is_extensible(target)))
        ts_throw_type_error("'deleteProperty' on proxy: trap deleted a property of a non-extensible target");
      ts_gc_unroot(1);
    }
  }
  ts_gc_unroot(5);
  return r;
}
/* === getPrototypeOf / setPrototypeOf === */
static tsv ts_proxy_get_proto(tsv pv){
  ts_gc_root(&pv);
  ts_proxy* px = ts_ptr(pv);
  tsv target = px->target, handler = px->handler;
  ts_gc_root(&target); ts_gc_root(&handler);
  tsv trap = ts_proxy_trap(pv, handler, "getPrototypeOf");
  if (ts_is_undef(trap)){ tsv r = ts_get_proto(target); ts_gc_unroot(3); return r; }
  ts_gc_root(&trap);
  tsv argv[1] = { target };
  tsv r = invoke_with_this(trap, handler, argv, 1);
  if (!ts_is_obj(r) && !ts_is_null(r))
    ts_throw_type_error("'getPrototypeOf' on proxy: trap returned neither object nor null");
  if (!ts_truthy(ts_object_is_extensible(target))){
    ts_gc_root(&r);
    if (!ts_object_is(r, ts_get_proto(target)))
      ts_throw_type_error("'getPrototypeOf' on proxy: trap returned a different prototype for a non-extensible target");
    ts_gc_unroot(1);
  }
  ts_gc_unroot(4);
  return r;
}
static tsv ts_proxy_set_proto(tsv pv, tsv proto){
  ts_gc_root(&pv); ts_gc_root(&proto);
  ts_proxy* px = ts_ptr(pv);
  tsv target = px->target, handler = px->handler;
  ts_gc_root(&target); ts_gc_root(&handler);
  tsv trap = ts_proxy_trap(pv, handler, "setPrototypeOf");
  if (ts_is_undef(trap)){ ts_set_proto(target, proto); ts_gc_unroot(4); return pv; }
  ts_gc_root(&trap);
  tsv argv[2] = { target, proto };
  int ok = ts_truthy(invoke_with_this(trap, handler, argv, 2));
  if (ok && !ts_truthy(ts_object_is_extensible(target))){
    if (!ts_object_is(proto, ts_get_proto(target)))
      ts_throw_type_error("'setPrototypeOf' on proxy: trap changed the prototype of a non-extensible target");
  }
  ts_gc_unroot(5);
  return pv;
}
/* === isExtensible / preventExtensions === */
static int ts_proxy_is_extensible(tsv pv){
  ts_gc_root(&pv);
  ts_proxy* px = ts_ptr(pv);
  tsv target = px->target, handler = px->handler;
  ts_gc_root(&target); ts_gc_root(&handler);
  tsv trap = ts_proxy_trap(pv, handler, "isExtensible");
  if (ts_is_undef(trap)){ int r = ts_truthy(ts_object_is_extensible(target)); ts_gc_unroot(3); return r; }
  ts_gc_root(&trap);
  tsv argv[1] = { target };
  int r = ts_truthy(invoke_with_this(trap, handler, argv, 1));
  int t = ts_truthy(ts_object_is_extensible(target));
  if (r != t)
    ts_throw_type_error("'isExtensible' on proxy: trap result does not match target extensibility");
  ts_gc_unroot(4);
  return r;
}
static void ts_proxy_prevent_extensions(tsv pv){
  ts_gc_root(&pv);
  ts_proxy* px = ts_ptr(pv);
  tsv target = px->target, handler = px->handler;
  ts_gc_root(&target); ts_gc_root(&handler);
  tsv trap = ts_proxy_trap(pv, handler, "preventExtensions");
  if (ts_is_undef(trap)){ ts_object_prevent_extensions(target); ts_gc_unroot(3); return; }
  ts_gc_root(&trap);
  tsv argv[1] = { target };
  int r = ts_truthy(invoke_with_this(trap, handler, argv, 1));
  if (r && ts_truthy(ts_object_is_extensible(target)))
    ts_throw_type_error("'preventExtensions' on proxy: trap returned true but target is still extensible");
  ts_gc_unroot(4);
}
/* === getOwnPropertyDescriptor === */
static tsv ts_proxy_get_own_desc(tsv pv, tsv keyv){
  ts_gc_root(&pv); ts_gc_root(&keyv);
  ts_proxy* px = ts_ptr(pv);
  tsv target = px->target, handler = px->handler;
  ts_gc_root(&target); ts_gc_root(&handler);
  tsv trap = ts_proxy_trap(pv, handler, "getOwnPropertyDescriptor");
  if (ts_is_undef(trap)){ tsv r = ts_get_own_property_descriptor(target, keyv); ts_gc_unroot(4); return r; }
  ts_gc_root(&trap);
  tsv argv[2] = { target, keyv };
  tsv r = invoke_with_this(trap, handler, argv, 2);
  if (!ts_is_obj(r) && !ts_is_undef(r))
    ts_throw_type_error("'getOwnPropertyDescriptor' on proxy: trap returned neither object nor undefined");
  ts_gc_unroot(5);
  return r;
}
/* === defineProperty === */
static void ts_proxy_define_property(tsv pv, tsv keyv, tsv desc){
  ts_gc_root(&pv); ts_gc_root(&keyv); ts_gc_root(&desc);
  ts_proxy* px = ts_ptr(pv);
  tsv target = px->target, handler = px->handler;
  ts_gc_root(&target); ts_gc_root(&handler);
  tsv trap = ts_proxy_trap(pv, handler, "defineProperty");
  if (ts_is_undef(trap)){ ts_define_property(target, keyv, desc); ts_gc_unroot(5); return; }
  ts_gc_root(&trap);
  tsv argv[3] = { target, keyv, desc };
  (void)invoke_with_this(trap, handler, argv, 3);
  ts_gc_unroot(6);
}
/* === apply / construct === */
static tsv ts_proxy_apply(tsv pv, tsv thisArg, tsv* args, int nargs){
  ts_gc_root(&pv); ts_gc_root(&thisArg);
  ts_proxy* px = ts_ptr(pv);
  tsv target = px->target, handler = px->handler;
  ts_gc_root(&target); ts_gc_root(&handler);
  tsv trap = ts_proxy_trap(pv, handler, "apply");
  if (ts_is_undef(trap)){ tsv r = invoke_with_this(target, thisArg, args, nargs); ts_gc_unroot(4); return r; }
  ts_gc_root(&trap);
  tsv arglist = ts_new_array((uint32_t)(nargs>0?nargs:0));
  ts_gc_root(&arglist);
  for (int i=0;i<nargs;i++) ts_array_set(arglist, (uint32_t)i, args[i]);
  tsv argv[3] = { target, thisArg, arglist };
  tsv r = invoke_with_this(trap, handler, argv, 3);
  ts_gc_unroot(6);
  return r;
}
static tsv ts_proxy_construct(tsv pv, tsv* args, int nargs){
  ts_gc_root(&pv);
  ts_proxy* px = ts_ptr(pv);
  tsv target = px->target, handler = px->handler;
  ts_gc_root(&target); ts_gc_root(&handler);
  tsv trap = ts_proxy_trap(pv, handler, "construct");
  if (ts_is_undef(trap)){ tsv r = ts_construct(target, args, nargs); ts_gc_unroot(3); return r; }
  ts_gc_root(&trap);
  tsv arglist = ts_new_array((uint32_t)(nargs>0?nargs:0));
  ts_gc_root(&arglist);
  for (int i=0;i<nargs;i++) ts_array_set(arglist, (uint32_t)i, args[i]);
  tsv argv[3] = { target, arglist, pv /* newTarget = the proxy */ };
  tsv r = invoke_with_this(trap, handler, argv, 3);
  if (!ts_is_obj(r))
    ts_throw_type_error("'construct' on proxy: trap returned a non-object");
  ts_gc_unroot(5);
  return r;
}
/* === ownKeys (array) and enumeration === */
static tsv ts_proxy_own_keys_arr(tsv pv){
  ts_gc_root(&pv);
  ts_proxy* px = ts_ptr(pv);
  tsv target = px->target, handler = px->handler;
  ts_gc_root(&target); ts_gc_root(&handler);
  tsv trap = ts_proxy_trap(pv, handler, "ownKeys");
  if (ts_is_undef(trap)){ tsv r = ts_reflect_own_keys(target); ts_gc_unroot(3); return r; }
  ts_gc_root(&trap);
  tsv argv[1] = { target };
  tsv r = invoke_with_this(trap, handler, argv, 1);
  if (!ts_is_array(r))
    ts_throw_type_error("'ownKeys' on proxy: trap did not return an array");
  ts_gc_unroot(4);
  return r;
}
/* Enumerate own ENUMERABLE STRING keys (Object.keys / JSON / for-in semantics):
   take the ownKeys-trap result, and for each string key whose own descriptor is
   enumerable, invoke the callback with its ts_key and current value. */
static void ts_proxy_enum(tsv pv, ts_prop_enum_cb cb, void* ud){
  ts_gc_root(&pv);
  tsv keys = ts_proxy_own_keys_arr(pv);
  ts_gc_root(&keys);
  uint32_t n = ts_is_array(keys) ? ts_array_len(keys) : 0;
  for (uint32_t i=0;i<n;i++){
    tsv kv = ts_array_get(keys, i);
    if (!ts_is_str(kv)) continue;                 /* Object.keys: string keys only */
    ts_gc_root(&kv);
    tsv desc = ts_proxy_get_own_desc(pv, kv);     /* honors getOwnPropertyDescriptor trap */
    if (ts_is_obj(desc) && pd_bool(desc, "enumerable")){
      ts_key k; if (ts_key_from_value(kv, &k)){
        tsv val = ts_proxy_get_v(pv, kv, pv);     /* current value via get trap */
        cb(k, val, ud);
      }
    }
    ts_gc_unroot(1);
  }
  ts_gc_unroot(2);
}
/* Proxy.revocable(target, handler) -> { proxy, revoke } */
tsv ts_proxy_revocable(tsv target, tsv handler){
  tsv pv = ts_proxy_new(target, handler);
  ts_gc_root(&pv);
  /* revoke closure captures the proxy; calling it flips revoked. Implemented as a
     bound thunk over ts_proxy_do_revoke. */
  extern tsv ts_make_fn_t(ts_code, tsv*, uint32_t, int);
  tsv result = ts_new_object();
  ts_gc_root(&result);
  ts_set(result, ts_intern_field("proxy", 5), pv);
  tsv env[1] = { pv };
  extern tsv ts_proxy_revoke_thunk(tsv* args, int n);
  tsv revoke = ts_make_fn_t(ts_proxy_revoke_thunk, env, 1, 0);
  ts_set(result, ts_intern_field("revoke", 6), revoke);
  ts_gc_unroot(2);
  return result;
}
tsv ts_proxy_revoke_thunk(tsv* args, int n){
  /* env = [proxy]; ts_call prepends env so args[0] is the proxy. */
  if (n>0 && ts_is_proxy(args[0])) ((ts_proxy*)ts_ptr(args[0]))->revoked = 1;
  return TS_UNDEFINED;
}

/* ---------------- exceptions (try/catch via setjmp/longjmp) ---------------- */
static ts_handler* g_handlers = NULL;
static tsv g_exception;

ts_handler* ts_eh_push(void){
  ts_handler* h = (ts_handler*)malloc(sizeof(ts_handler));
  h->gc_root_len = ts_gc_root_depth();
  h->prev = g_handlers;
  h->extbuf = NULL;
  g_handlers = h;
  return h;
}
/* push a handler whose longjmp target is a caller-owned jmp_buf (the coroutine
   frame's eh_buf). Used for try/catch that spans a suspension: the resume fn
   re-arms setjmp on the frame buf each entry and (re)pushes this handler. */
void ts_eh_push_coro(void* extbuf){
  ts_handler* h = (ts_handler*)malloc(sizeof(ts_handler));
  h->gc_root_len = ts_gc_root_depth();
  h->prev = g_handlers;
  h->extbuf = extbuf;
  g_handlers = h;
}
void ts_eh_pop(void){
  if (g_handlers){ ts_handler* h=g_handlers; g_handlers=h->prev; free(h); }
}
static void ts_eh_pop_until(ts_handler* target){
  while (g_handlers && g_handlers != target) ts_eh_pop();
  if (g_handlers == target) ts_eh_pop();
}
void ts_throw(tsv v){
  if (!g_handlers){
    fflush(stdout);
    tsv s = ts_to_string_v(v);
    uint32_t n=0; char* u=ts_string_cstr_copy(s, &n);
    fprintf(stderr, "tsaot: Uncaught exception: %.*s\n", (int)n, u);
    free(u);
    fflush(stderr);
    abort();
  }
  g_exception = v;
  ts_handler* h = g_handlers;        /* longjmp target; catch-side pops it */
  if (h->extbuf) longjmp(*(jmp_buf*)h->extbuf, 1);
  longjmp(h->buf, 1);
}
tsv ts_current_exception(void){ return g_exception; }
void g_exception_set(tsv v){ g_exception = v; }

/* ---------------- Promise + microtask queue + event loop ---------------- */
static int ts_is_promise(tsv v){ return ts_is_obj(v) && ((ts_gc_header*)ts_ptr(v))->kind==TS_KIND_PROMISE; }
static int ts_is_coro_value(tsv v){ return ts_is_obj(v) && ((ts_gc_header*)ts_ptr(v))->kind==TS_KIND_CORO; }

static void promise_init(ts_promise* p){
  p->state=0; p->value=TS_UNDEFINED; p->waiters=NULL; p->nwait=0; p->capwait=0;
  p->comb_remaining=0; p->comb_results=TS_UNDEFINED;
}
tsv ts_promise_new_v(void){
  ts_promise* p=(ts_promise*)gc_alloc(sizeof(ts_promise), TS_KIND_PROMISE);
  promise_init(p);
  return ts_obj(p);
}
static inline ts_promise* ts_promise_ptr(tsv pv){ return ts_is_promise(pv) ? (ts_promise*)ts_ptr(pv) : NULL; }
static inline int promise_pending_v(tsv pv){
  ts_promise* p = ts_promise_ptr(pv);
  return p && p->state == 0;
}
static inline void promise_comb_init_v(tsv pv, uint32_t remaining, tsv results){
  ts_promise* p = ts_promise_ptr(pv);
  if (!p) return;
  p->comb_remaining = (int)remaining;
  p->comb_results = results;
  ts_write_barrier(pv, results);
}
static inline int promise_comb_decr_v(tsv pv, tsv* results){
  ts_promise* p = ts_promise_ptr(pv);
  if (!p || p->state != 0) return 0;
  if (results) *results = p->comb_results;
  return --p->comb_remaining == 0;
}
static inline int promise_state_value_v(tsv pv, tsv* value){
  ts_promise* p = ts_promise_ptr(pv);
  if (!p) return -1;
  if (value) *value = p->value;
  return p->state;
}
static inline void coro_deliver_v(tsv cv, tsv value, int rejected){
  if (!ts_is_coro_value(cv)) return;
  ts_coro* c=(ts_coro*)ts_ptr(cv);
  c->result=value; c->rejected=rejected;
  ts_write_barrier(cv, value);
}
static int promise_begin_settle_v(tsv pv, tsv v, int rejected, int* nwait){
  ts_promise* p = ts_promise_ptr(pv);
  if (!p || p->state!=0) return 0;
  p->state = rejected?2:1;
  p->value = v;
  ts_write_barrier(pv, v);
  if (nwait) *nwait = p->nwait;
  return 1;
}
static tsv promise_take_waiter_v(tsv pv, int idx){
  ts_promise* p = ts_promise_ptr(pv);
  if (!p || idx < 0 || idx >= p->nwait) return TS_UNDEFINED;
  tsv cv = p->waiters[idx];
  p->waiters[idx] = TS_UNDEFINED;
  return cv;
}
static void promise_finish_waiter_drain_v(tsv pv){
  ts_promise* p = ts_promise_ptr(pv);
  if (!p) return;
  tsv* waiters = p->waiters;
  p->waiters = NULL;
  p->nwait = 0;
  p->capwait = 0;
  free(waiters);
}

/* microtask queue: each entry is a coroutine frame to resume */
static tsv* g_microq=NULL; static int g_mq_len=0, g_mq_cap=0;
static void microq_push_v(tsv cv){
  if (!ts_is_coro_value(cv)) return;
  if (g_mq_len==g_mq_cap){ g_mq_cap=g_mq_cap?g_mq_cap*2:32; g_microq=realloc(g_microq,sizeof(tsv)*g_mq_cap); }
  g_microq[g_mq_len++]=cv;
}

static void promise_add_waiter_v(tsv pv, tsv cv){
  ts_gc_root(&pv); ts_gc_root(&cv);
  ts_promise* p = ts_promise_ptr(pv);
  if (!p || p->state != 0 || !ts_is_coro_value(cv)){ ts_gc_unroot(2); return; }
  if (p->nwait==p->capwait){
    int newcap = p->capwait ? p->capwait*2 : 4;
    tsv* waiters = realloc(p->waiters, sizeof(tsv)*newcap);
    if (!waiters) ts_abort_msg("out of memory growing promise waiters");
    p = ts_promise_ptr(pv);
    if (!p || p->state != 0){ free(waiters); ts_gc_unroot(2); return; }
    p->waiters = waiters;
    p->capwait = newcap;
  }
  p->waiters[p->nwait++]=cv;
  ts_write_barrier(pv, cv);
  ts_gc_unroot(2);
}

void ts_promise_settle_v(tsv pv, tsv v, int rejected){
  ts_gc_root(&pv); ts_gc_root(&v);
  int nwait = 0;
  if (!promise_begin_settle_v(pv, v, rejected, &nwait)){ ts_gc_unroot(2); return; }
  for (int i=0;i<nwait;i++){
    tsv cv=promise_take_waiter_v(pv, i);
    if (!ts_is_coro_value(cv)) continue;
    ts_gc_root(&cv);
    coro_deliver_v(cv, v, rejected);
    microq_push_v(cv);
    ts_gc_unroot(1);
  }
  promise_finish_waiter_drain_v(pv);
  ts_gc_unroot(2);
}
/* Promise adoption adapter: when a promise is resolved WITH another promise, an
   adapter coro is registered on the inner promise; it fires as a microtask when
   inner settles and forwards the state to the outer promise `out_v`. This gives
   Promises/A+ semantics: a settled inner adopts one tick later (not synchronously),
   and a PENDING inner is chained (was previously left unadopted). */
typedef struct { ts_coro c; tsv out_v; } ts_adopt;
static tsv adopt_resume(tsv cv){
  ts_adopt* w=(ts_adopt*)ts_ptr(cv);
  ts_coro* c=&w->c;
  tsv outv = w->out_v;
  tsv result = c->result;
  int rejected = c->rejected;
  /* inner's final state is in c->result/c->rejected (set by ts_await_register_v).
     Recurse via resolve/reject (mirrors then_resume pass-through): a fulfilled
     value that is itself a promise adopts recursively; a reject reason is not. */
  ts_gc_root(&outv); ts_gc_root(&result);
  if (rejected) ts_promise_reject_v(outv, result);
  else          ts_promise_resolve_v(outv, result);
  ts_gc_unroot(2);
  return TS_UNDEFINED;
}
void ts_promise_resolve_v(tsv pv, tsv v){
  if (!ts_promise_ptr(pv)) return;
  if (ts_is_promise(v)){
    /* Promises/A+ §2.3.2: adopt the inner promise's state asynchronously. The
       adapter is pushed as a microtask when inner is already settled (the extra
       tick), or added as a waiter when inner is pending (chaining). */
    ts_gc_root(&pv); ts_gc_root(&v);
    tsv wv = ts_coro_alloc_v(sizeof(ts_adopt), adopt_resume);
    ts_gc_root(&wv);
    ts_adopt* w=(ts_adopt*)ts_ptr(wv);
    w->out_v=pv;
    ts_write_barrier(wv, w->out_v);
    ts_await_register_v(v, wv);
    ts_gc_unroot(3);
    return;
  }
  ts_promise_settle_v(pv, v, 0);
}
void ts_promise_reject_v(tsv pv, tsv v){ ts_promise_settle_v(pv, v, 1); }

tsv ts_promise_resolved(tsv v){
  ts_gc_root(&v);
  tsv pv=ts_promise_new_v();
  ts_gc_root(&pv);
  ts_promise_resolve_v(pv, v);
  ts_gc_unroot(2);
  return pv;
}
tsv ts_promise_rejected(tsv v){
  ts_gc_root(&v);
  tsv pv=ts_promise_new_v();
  ts_gc_root(&pv);
  ts_promise_reject_v(pv, v);
  ts_gc_unroot(2);
  return pv;
}

/* Promise.all / Promise.race combinators. Each input gets a lightweight adapter
   coroutine (waiters must be coroutines); when an input settles, the adapter's
   resume runs the combinator logic on the shared output promise. The adapter
   holds the output promise (out_v) and its index in its GC-scanned frame (out_v
   is marked as a promise; idx is a plain double, never mis-marked). */
typedef struct { ts_coro c; tsv out_v; double idx; } ts_comb;
static tsv comb_all_resume(tsv cv){
  ts_comb* w=(ts_comb*)ts_ptr(cv);
  ts_coro* c=&w->c;
  tsv outv = w->out_v;
  uint32_t idx = (uint32_t)w->idx;
  tsv result = c->result;
  int rejected = c->rejected;
  ts_gc_root(&outv); ts_gc_root(&result);
  if (!promise_pending_v(outv)){ ts_gc_unroot(2); return TS_UNDEFINED; }  /* already settled (earlier reject) */
  if (rejected){ ts_promise_settle_v(outv, result, 1); ts_gc_unroot(2); return TS_UNDEFINED; }  /* first reject */
  tsv results = ts_promise_ptr(outv)->comb_results;
  ts_array_set(results, idx, result);
  if (promise_comb_decr_v(outv, &results)) ts_promise_settle_v(outv, results, 0);
  ts_gc_unroot(2);
  return TS_UNDEFINED;
}
static tsv comb_race_resume(tsv cv){
  ts_comb* w=(ts_comb*)ts_ptr(cv);
  ts_coro* c=&w->c;
  tsv outv = w->out_v;
  tsv result = c->result;
  int rejected = c->rejected;
  ts_gc_root(&outv); ts_gc_root(&result);
  if (promise_pending_v(outv)) ts_promise_settle_v(outv, result, rejected);  /* first to settle wins */
  ts_gc_unroot(2);
  return TS_UNDEFINED;
}
tsv ts_promise_all(tsv arr){
  tsv arrv = arr;
  ts_gc_root(&arrv);
  if (!ts_is_array(arrv)){ tsv tmp=ts_new_array(0); ts_gc_root(&tmp); ts_array_push_all(tmp, arrv); arrv=tmp; ts_gc_unroot(1); }
  tsv outv = ts_promise_new_v();
  ts_gc_root(&outv);   /* the alloc loop below can trigger GC */
  uint32_t n = ts_array_len(arrv);
  tsv results = ts_new_array(n);          /* kept alive via outv + the extended PROMISE mark */
  ts_gc_root(&results);
  promise_comb_init_v(outv, n, results);
  if (n==0){ ts_promise_resolve_v(outv, results); ts_gc_unroot(3); return outv; }
  for (uint32_t i=0;i<n;i++){
    tsv input = ts_array_get(arrv, i);
    tsv wv = ts_coro_alloc_v(sizeof(ts_comb), comb_all_resume);
    ts_gc_root(&wv);
    ts_comb* w = (ts_comb*)ts_ptr(wv);
    w->out_v = outv; ts_write_barrier(wv, outv); w->idx = (double)i;
    ts_await_register_v(input, wv);
    ts_gc_unroot(1);
  }
  ts_gc_unroot(3);
  return outv;
}
tsv ts_promise_race(tsv arr){
  tsv arrv = arr;
  ts_gc_root(&arrv);
  if (!ts_is_array(arrv)){ tsv tmp=ts_new_array(0); ts_gc_root(&tmp); ts_array_push_all(tmp, arrv); arrv=tmp; ts_gc_unroot(1); }
  tsv outv = ts_promise_new_v();
  ts_gc_root(&outv);
  uint32_t n = ts_array_len(arrv);
  for (uint32_t i=0;i<n;i++){           /* empty array -> stays pending forever (spec) */
    tsv input = ts_array_get(arrv, i);
    tsv wv = ts_coro_alloc_v(sizeof(ts_comb), comb_race_resume);
    ts_gc_root(&wv);
    ts_comb* w = (ts_comb*)ts_ptr(wv);
    w->out_v = outv; ts_write_barrier(wv, outv); w->idx = (double)i;
    ts_await_register_v(input, wv);
    ts_gc_unroot(1);
  }
  ts_gc_unroot(2);
  return outv;
}

/* Call a user function, catching a throw: returns the result (threw=0) or the
   thrown value (threw=1). Mirrors the structured try/catch (setjmp on the handler
   buf; on the throw path restore the GC root depth and pop the handler). */
static tsv ts_call_catching(tsv fn, tsv* args, int n, int* threw){
  ts_handler* h = ts_eh_push();
  if (setjmp(h->buf) != 0){
    ts_gc_set_root_depth(h->gc_root_len);
    ts_eh_pop();
    *threw = 1;
    return ts_current_exception();
  }
  tsv r = ts_call_value(fn, args, n);
  ts_eh_pop();
  *threw = 0;
  return r;
}

/* { status: "fulfilled", value } / { status: "rejected", reason } for allSettled. */
static tsv ts_allsettled_result(tsv value, int rejected){
  ts_gc_root(&value);
  tsv o = ts_new_object(); ts_gc_root(&o);
  ts_set(o, ts_intern_field("status",6), ts_new_string(rejected?"rejected":"fulfilled", rejected?8:9));
  ts_set(o, ts_intern_field(rejected?"reason":"value", rejected?6:5), value);
  ts_gc_unroot(2);
  return o;
}
/* { name:"AggregateError", message:..., errors } for Promise.any all-reject. */
static tsv ts_aggregate_error(tsv errors){
  ts_gc_root(&errors);
  tsv o = ts_new_object(); ts_gc_root(&o);
  ts_set(o, ts_intern_field("name",4),    ts_new_string("AggregateError",14));
  ts_set(o, ts_intern_field("message",7), ts_new_string("All promises were rejected",26));
  ts_set(o, ts_intern_field("errors",6),  errors);
  ts_gc_unroot(2);
  return o;
}

/* .then/.catch adapter: out + two callbacks (onFulfilled/onRejected). */
typedef struct { ts_coro c; tsv out_v; tsv cb0; tsv cb1; } ts_then;
static tsv then_resume(tsv cv){
  ts_then* w=(ts_then*)ts_ptr(cv);
  ts_coro* c=&w->c;
  tsv outv = w->out_v;
  tsv result = c->result;
  int rejected = c->rejected;
  tsv cb = rejected ? w->cb1 : w->cb0;
  ts_gc_root(&outv); ts_gc_root(&result); ts_gc_root(&cb);
  if (!ts_is_callable(cb)){            /* no handler -> pass the value/reason through */
    if (rejected) ts_promise_reject_v(outv, result); else ts_promise_resolve_v(outv, result);
    ts_gc_unroot(3);
    return TS_UNDEFINED;
  }
  int threw; tsv r = ts_call_catching(cb, &result, 1, &threw);
  if (threw) ts_promise_reject_v(outv, r); else ts_promise_resolve_v(outv, r);
  ts_gc_unroot(3);
  return TS_UNDEFINED;
}
/* .finally adapter: onFinally is called with no args; the original value/reason
   passes through unless onFinally throws (then that rejection wins). */
static tsv finally_resume(tsv cv){
  ts_then* w=(ts_then*)ts_ptr(cv);
  ts_coro* c=&w->c;
  tsv outv = w->out_v;
  tsv result = c->result;
  int rejected = c->rejected;
  tsv cb = w->cb0;
  ts_gc_root(&outv); ts_gc_root(&result); ts_gc_root(&cb);
  if (ts_is_callable(cb)){
    int threw; tsv r = ts_call_catching(cb, NULL, 0, &threw);
    if (threw){ ts_promise_reject_v(outv, r); ts_gc_unroot(3); return TS_UNDEFINED; }
  }
  if (rejected) ts_promise_reject_v(outv, result); else ts_promise_resolve_v(outv, result);
  ts_gc_unroot(3);
  return TS_UNDEFINED;
}
tsv ts_promise_then(tsv pv, tsv on_f, tsv on_r){
  ts_gc_root(&pv); ts_gc_root(&on_f); ts_gc_root(&on_r);
  tsv outv=ts_promise_new_v();
  ts_gc_root(&outv);
  tsv wv=ts_coro_alloc_v(sizeof(ts_then), then_resume);
  ts_gc_root(&wv);
  ts_then* w=(ts_then*)ts_ptr(wv);
  w->out_v=outv; w->cb0=on_f; w->cb1=on_r;
  ts_write_barrier(wv, outv); ts_write_barrier(wv, on_f); ts_write_barrier(wv, on_r);
  ts_await_register_v(pv, wv);
  ts_gc_unroot(5);
  return outv;
}
/* new Promise(executor): resolve/reject are ordinary closures whose code is a C
   thunk and whose env[0] is the bound promise (ts_make_fn leaves takes_this=0, so
   a plain `resolve(v)` call lands the value at arg index 1 after the env-prepended
   promise). GC marks the env, keeping the promise alive. */
static tsv ts_resolve_thunk(tsv* a, int n){ /* a[0]=promise (env[0]); a[1]=value */
  ts_promise_resolve_v(a[0], n>1 ? a[1] : TS_UNDEFINED);
  return TS_UNDEFINED;
}
static tsv ts_reject_thunk(tsv* a, int n){
  ts_promise_reject_v(a[0], n>1 ? a[1] : TS_UNDEFINED);
  return TS_UNDEFINED;
}
tsv ts_promise_new_executor(tsv executor){
  ts_gc_root(&executor);
  tsv pv = ts_promise_new_v();
  ts_gc_root(&pv);
  tsv env1[1]; env1[0] = pv;
  tsv resolve = ts_make_fn(ts_resolve_thunk, env1, 1); ts_gc_root(&resolve);
  tsv reject  = ts_make_fn(ts_reject_thunk,  env1, 1); ts_gc_root(&reject);
  tsv args[2]; args[0] = resolve; args[1] = reject;
  int threw; tsv r = ts_call_catching(executor, args, 2, &threw);
  if (threw) ts_promise_reject_v(pv, r); /* a throwing executor rejects (no-op if already settled) */
  ts_gc_unroot(4);
  return pv;
}
tsv ts_promise_catch(tsv pv, tsv on_r){ return ts_promise_then(pv, TS_UNDEFINED, on_r); }
tsv ts_promise_finally(tsv pv, tsv on_fin){
  ts_gc_root(&pv); ts_gc_root(&on_fin);
  tsv outv=ts_promise_new_v();
  ts_gc_root(&outv);
  tsv wv=ts_coro_alloc_v(sizeof(ts_then), finally_resume);
  ts_gc_root(&wv);
  ts_then* w=(ts_then*)ts_ptr(wv);
  w->out_v=outv; w->cb0=on_fin; w->cb1=TS_UNDEFINED;
  ts_write_barrier(wv, outv); ts_write_barrier(wv, on_fin);
  ts_await_register_v(pv, wv);
  ts_gc_unroot(4);
  return outv;
}

/* Promise.prototype.{then,catch,finally} as boxed methods (takes_this=1, so
   args[0] is the receiver promise). These back the first-class method VALUE
   (`const f = p.then` / `typeof p.then`); the common `p.then(cb)` call site uses
   the direct CallBuiltin "promise.then" fast path instead. A detached call with no
   (or a non-Promise) receiver is a TypeError in JS; we no-op safely rather than
   crash (matches the permissive treatment of other detached method values). */
tsv ts_promiseproto_then(tsv* a, int n){
  if (n<1 || !ts_is_promise(a[0])) return TS_UNDEFINED;
  return ts_promise_then(a[0], n>1?a[1]:TS_UNDEFINED, n>2?a[2]:TS_UNDEFINED);
}
tsv ts_promiseproto_catch(tsv* a, int n){
  if (n<1 || !ts_is_promise(a[0])) return TS_UNDEFINED;
  return ts_promise_catch(a[0], n>1?a[1]:TS_UNDEFINED);
}
tsv ts_promiseproto_finally(tsv* a, int n){
  if (n<1 || !ts_is_promise(a[0])) return TS_UNDEFINED;
  return ts_promise_finally(a[0], n>1?a[1]:TS_UNDEFINED);
}
/* Shared Promise prototype (globals declared with the other g_*_proto near the
   top). Unlike array/object protos, NOTHING references this (a ts_promise carries
   no proto field — ts_get delegates here by kind), so it must be GC-rooted
   explicitly. proto stays NULL: only then/catch/finally are exposed, so
   `promise.<anything-else>` stays undefined as before. */
void ts_promise_proto_init(void){
  if (ts_proto_ref(g_promise_proto_v)) return;
  g_promise_proto_v = ts_new_proto();
  ts_gc_root(&g_promise_proto_v);
}
tsv ts_promise_proto(void){ return ts_proto_ref(g_promise_proto_v) ? g_promise_proto_v : TS_NULL; }
void ts_promise_proto_register(ts_key method_key, const char* name, ts_code fn){
  if (!ts_proto_ref(g_promise_proto_v)) ts_promise_proto_init();
  ts_proto_register_method(g_promise_proto_v, method_key, name, fn);
}

static tsv comb_allsettled_resume(tsv cv){
  ts_comb* w=(ts_comb*)ts_ptr(cv);
  ts_coro* c=&w->c;
  tsv outv = w->out_v;
  uint32_t idx = (uint32_t)w->idx;
  tsv result = c->result;
  int rejected = c->rejected;
  ts_gc_root(&outv); ts_gc_root(&result);
  if (!promise_pending_v(outv)){ ts_gc_unroot(2); return TS_UNDEFINED; }
  tsv settled = ts_allsettled_result(result, rejected);
  ts_gc_root(&settled);
  tsv results = ts_promise_ptr(outv)->comb_results;
  ts_array_set(results, idx, settled);
  if (promise_comb_decr_v(outv, &results)) ts_promise_settle_v(outv, results, 0);
  ts_gc_unroot(3);
  return TS_UNDEFINED;
}
static tsv comb_any_resume(tsv cv){
  ts_comb* w=(ts_comb*)ts_ptr(cv);
  ts_coro* c=&w->c;
  tsv outv = w->out_v;
  uint32_t idx = (uint32_t)w->idx;
  tsv result = c->result;
  int rejected = c->rejected;
  ts_gc_root(&outv); ts_gc_root(&result);
  if (!promise_pending_v(outv)){ ts_gc_unroot(2); return TS_UNDEFINED; }  /* a fulfill already won */
  if (!rejected){ ts_promise_settle_v(outv, result, 0); ts_gc_unroot(2); return TS_UNDEFINED; }
  tsv results = ts_promise_ptr(outv)->comb_results;
  ts_array_set(results, idx, result);   /* store the reason */
  if (promise_comb_decr_v(outv, &results)){
    ts_gc_root(&results);
    tsv err = ts_aggregate_error(results);
    ts_gc_root(&err);
    ts_promise_settle_v(outv, err, 1);
    ts_gc_unroot(2);
  }
  ts_gc_unroot(2);
  return TS_UNDEFINED;
}
tsv ts_promise_allsettled(tsv arr){
  tsv arrv = arr;
  ts_gc_root(&arrv);
  if (!ts_is_array(arrv)){ tsv tmp=ts_new_array(0); ts_gc_root(&tmp); ts_array_push_all(tmp, arrv); arrv=tmp; ts_gc_unroot(1); }
  tsv outv = ts_promise_new_v();
  ts_gc_root(&outv);
  uint32_t n = ts_array_len(arrv);
  tsv results = ts_new_array(n);
  ts_gc_root(&results);
  promise_comb_init_v(outv, n, results);
  if (n==0){ ts_promise_resolve_v(outv, results); ts_gc_unroot(3); return outv; }
  for (uint32_t i=0;i<n;i++){
    tsv input = ts_array_get(arrv, i);
    tsv wv = ts_coro_alloc_v(sizeof(ts_comb), comb_allsettled_resume);
    ts_gc_root(&wv);
    ts_comb* w = (ts_comb*)ts_ptr(wv);
    w->out_v = outv; ts_write_barrier(wv, outv); w->idx = (double)i;
    ts_await_register_v(input, wv);
    ts_gc_unroot(1);
  }
  ts_gc_unroot(3);
  return outv;
}
tsv ts_promise_any(tsv arr){
  tsv arrv = arr;
  ts_gc_root(&arrv);
  if (!ts_is_array(arrv)){ tsv tmp=ts_new_array(0); ts_gc_root(&tmp); ts_array_push_all(tmp, arrv); arrv=tmp; ts_gc_unroot(1); }
  tsv outv = ts_promise_new_v();
  ts_gc_root(&outv);
  uint32_t n = ts_array_len(arrv);
  tsv results = ts_new_array(n);   /* reasons */
  ts_gc_root(&results);
  promise_comb_init_v(outv, n, results);
  if (n==0){
    tsv err = ts_aggregate_error(results);
    ts_gc_root(&err);
    ts_promise_settle_v(outv, err, 1);
    ts_gc_unroot(4);
    return outv;
  }
  for (uint32_t i=0;i<n;i++){
    tsv input = ts_array_get(arrv, i);
    tsv wv = ts_coro_alloc_v(sizeof(ts_comb), comb_any_resume);
    ts_gc_root(&wv);
    ts_comb* w = (ts_comb*)ts_ptr(wv);
    w->out_v = outv; ts_write_barrier(wv, outv); w->idx = (double)i;
    ts_await_register_v(input, wv);
    ts_gc_unroot(1);
  }
  ts_gc_unroot(3);
  return outv;
}

/* register coroutine cv to resume when promise pv settles; if already settled,
   enqueue immediately. The public runtime path uses the handle form so callers
   don't keep raw coroutine pointers live across scheduler boundaries. */
void ts_await_register_v(tsv pv, tsv cv){
  if (!ts_is_coro_value(cv)) return;
  ts_gc_root(&cv);
  if (!ts_is_promise(pv)){
    /* awaiting a non-promise: resolves immediately with the value */
    coro_deliver_v(cv, pv, 0); microq_push_v(cv); ts_gc_unroot(1); return;
  }
  ts_gc_root(&pv);
  tsv value = TS_UNDEFINED;
  int state = promise_state_value_v(pv, &value);
  if (state==1){ coro_deliver_v(cv, value, 0); microq_push_v(cv); }
  else if (state==2){ coro_deliver_v(cv, value, 1); microq_push_v(cv); }
  else promise_add_waiter_v(pv, cv);
  ts_gc_unroot(2);
}

static void coro_init(ts_coro* c, size_t size, tsv (*resume)(tsv)){
  c->state=0; c->resume=resume; c->result=TS_UNDEFINED; c->rejected=0;
  c->nslots=0; c->frame_size=size; c->ret=TS_UNDEFINED;
}
/* allocate a coroutine frame of `size` bytes (>= sizeof(ts_coro)); the embedded
   ts_coro is at offset 0. Extra frame fields are zeroed (calloc). */
tsv ts_coro_alloc_v(size_t size, tsv (*resume)(tsv)){
  if (size < sizeof(ts_coro)) size = sizeof(ts_coro);
  ts_coro* c=(ts_coro*)gc_alloc(size, TS_KIND_CORO);
  coro_init(c, size, resume);
  /* set frame_size (so a GC scan of the still-zeroed frame is bounded/harmless)
     and root cv BEFORE allocating c->ret — that alloc may trigger GC, which would
     otherwise collect or move this not-yet-referenced coro. */
  tsv cv=ts_obj(c); ts_gc_root(&cv);
  tsv ret = ts_promise_new_v();
  c=(ts_coro*)ts_ptr(cv);
  c->ret=ret;
  ts_write_barrier(cv, ret);
  ts_gc_unroot(1);
  return cv;
}
tsv ts_coro_new_v(tsv (*resume)(tsv)){
  return ts_coro_alloc_v(sizeof(ts_coro), resume);
}
void ts_coro_resume_v(tsv cv){
  if (!ts_is_coro_value(cv)) return;
  ts_gc_root(&cv);
  gc_pin_value(cv);
  ts_handler* h = ts_eh_push();
  if (setjmp(h->buf) != 0){
    tsv pinned_cv = cv;
    tsv exc = ts_current_exception();
    ts_gc_set_root_depth(h->gc_root_len);
    gc_unpin_value(pinned_cv);
    ts_eh_pop_until(h);
    cv = exc;  /* keep the exception rooted while rethrowing past this cleanup frame */
    ts_throw(exc);
  }
  ts_coro* c=(ts_coro*)ts_ptr(cv);
  if (c->resume) c->resume(cv);
  ts_eh_pop_until(h);
  gc_unpin_value(cv);
  ts_gc_unroot(1);
}

/* I/O task queue (for fetch): serviced when microtasks drain */
typedef struct ts_io {
  int  (*start)(struct ts_io*);
  void (*finish)(struct ts_io*);
  void (*destroy)(struct ts_io*);
  tsv p;
  tsv signal;
  char* arg;
  struct ts_io* next;
} ts_io;
static ts_io* g_io_head=NULL; static ts_io* g_io_tail=NULL; static ts_io* g_io_active=NULL;
void ts_io_post(ts_io* t){ t->next=NULL; if(g_io_tail) g_io_tail->next=t; else g_io_head=t; g_io_tail=t; }

static void ts_io_free_task(ts_io* t){
  if (!t) return;
  if (t->destroy) t->destroy(t);
  free(t);
}
static void ts_io_finish_and_free(ts_io* t){
  if (!t) return;
  if (t->finish) t->finish(t);
  ts_io_free_task(t);
}
static void ts_io_activate(ts_io* t){
  t->next = g_io_active;
  g_io_active = t;
}
static void ts_io_remove_active(ts_io* t){
  ts_io** pp=&g_io_active;
  while (*pp){
    if (*pp == t){ *pp = t->next; t->next = NULL; return; }
    pp=&(*pp)->next;
  }
}
static void ts_io_start_queued(void){
  while (g_io_head){
    ts_io* t=g_io_head;
    g_io_head=t->next;
    if (!g_io_head) g_io_tail=NULL;
    t->next=NULL;
    if (t->start && t->start(t)) ts_io_activate(t);
    else ts_io_finish_and_free(t);
  }
}
static int ts_io_poll_active(void);
static void ts_abort_timers_fire_due(void);
static int ts_abort_timer_poll_timeout_ms(int default_ms);
static void gc_mark_abort_timer_roots(void);
static void gc_mark_abort_timer_roots_young(void);

static void drain_microtasks(void){
  int i=0;
  while (i<g_mq_len){
    tsv cv=g_microq[i++];
    ts_coro_resume_v(cv);  /* may push more microtasks */
  }
  g_mq_len=0;
}

void ts_run_event_loop(void){
  for (;;){
    drain_microtasks();
    ts_abort_timers_fire_due();
    ts_io_start_queued();
    if (!g_io_head && !g_io_active && g_mq_len) continue;
    if (!g_io_head && !g_io_active) break;       /* nothing pending */
    if (g_io_active) (void)ts_io_poll_active();  /* completes ready I/O tasks */
    /* loop: drain microtasks triggered by completed I/O */
  }
}

/* mark hook for Promise / coroutine frames (defined after their structs) */
static void gc_scan_async_cell(ts_gc_header* h, int young, int depth){
  if (h->kind==TS_KIND_PROMISE){
    ts_promise* p=(ts_promise*)h;
    gc_mark_visit(p->value, young, depth);
    gc_mark_visit(p->comb_results, young, depth);
    for (int i=0;i<p->nwait;i++) gc_mark_visit(p->waiters[i], young, depth);
  } else if (h->kind==TS_KIND_CORO){
    ts_coro* c=(ts_coro*)h;
    gc_mark_visit(c->result, young, depth);
    gc_mark_visit(c->yielded, young, depth);
    for (int i=0;i<c->fin_top;i++) gc_mark_visit(c->fin_exc[i], young, depth);
    gc_mark_visit(c->ret, young, depth);
    /* Conservatively scan the whole frame: any 8-byte slot that looks like a
       boxed heap handle is treated as a root. Stable handles keep this safe even
       when a minor GC relocates the object body. */
    size_t off = sizeof(ts_coro);
    char* base = (char*)c;
    for (; off + sizeof(tsv) <= c->frame_size; off += sizeof(tsv)){
      tsv v; memcpy(&v, base+off, sizeof(tsv));
      gc_mark_visit(v, young, depth);
    }
  }
}

static void gc_mark_async_roots(void){
  for (int i=0;i<g_mq_len;i++) gc_mark_value(g_microq[i]);
  for (ts_io* t=g_io_head;t;t=t->next){ gc_mark_value(t->p); gc_mark_value(t->signal); }
  for (ts_io* t=g_io_active;t;t=t->next){ gc_mark_value(t->p); gc_mark_value(t->signal); }
  gc_mark_abort_timer_roots();
}
static void gc_mark_async_roots_young(void){
  for (int i=0;i<g_mq_len;i++) gc_mark_value_young(g_microq[i]);
  for (ts_io* t=g_io_head;t;t=t->next){ gc_mark_value_young(t->p); gc_mark_value_young(t->signal); }
  for (ts_io* t=g_io_active;t;t=t->next){ gc_mark_value_young(t->p); gc_mark_value_young(t->signal); }
  gc_mark_abort_timer_roots_young();
}

/* ---------------- fetch / Headers shared helpers ---------------- */
static char ascii_lower_char(char c){ return (c >= 'A' && c <= 'Z') ? (char)(c + ('a' - 'A')) : c; }
static char* trim_copy_ascii(const char* p, size_t n){
  while (n && (*p==' ' || *p=='\t')){ p++; n--; }
  while (n && (p[n-1]==' ' || p[n-1]=='\t' || p[n-1]=='\r' || p[n-1]=='\n')) n--;
  char* out=(char*)malloc(n+1);
  if (!out) ts_abort_msg("out of memory copying fetch header");
  memcpy(out, p, n); out[n]=0;
  return out;
}

/* ---------------- fetch transport (libcurl: http + https/TLS) ---------------- */
#if defined(TSAOT_ENABLE_FETCH)
/* Transport seam: fetch I/O tasks use libcurl multi handles. libcurl owns TLS,
   certificate verification, redirects and transfer decoding, so http:// and
   https:// are handled identically here. The runtime remains single-threaded:
   ts_run_event_loop starts all queued fetches, polls the curl multi handle, and
   resolves each Promise as its transfer completes. */

struct ts_curl_buf { char* p; size_t n; };
static size_t ts_curl_write(void* data, size_t sz, size_t nm, void* userp){
  size_t add = sz * nm;
  struct ts_curl_buf* b = (struct ts_curl_buf*)userp;
  char* np = (char*)realloc(b->p, b->n + add + 1);
  if (!np) return 0;                 /* signal write error to libcurl */
  b->p = np; memcpy(b->p + b->n, data, add); b->n += add; b->p[b->n] = 0;
  return add;
}

typedef struct ts_header_pair {
  char* name;
  char* value;
} ts_header_pair;
typedef struct ts_fetch_io ts_fetch_io;

static int is_http_status_line(const char* p, size_t n){
  return n >= 5 && p[0]=='H' && p[1]=='T' && p[2]=='T' && p[3]=='P' && p[4]=='/';
}
static void fetch_clear_response_headers(ts_fetch_io* fio);
static void fetch_add_response_header(ts_fetch_io* fio, const char* name, size_t nlen,
                                      const char* value, size_t vlen);
static size_t ts_curl_header(void* data, size_t sz, size_t nm, void* userp){
  size_t n = sz * nm;
  ts_fetch_io* fio = (ts_fetch_io*)userp;
  const char* p = (const char*)data;
  if (!fio || !p) return n;
  if (is_http_status_line(p, n)){ fetch_clear_response_headers(fio); return n; }
  const char* colon = (const char*)memchr(p, ':', n);
  if (!colon) return n;
  size_t nlen = (size_t)(colon - p);
  while (nlen && (p[nlen-1]==' ' || p[nlen-1]=='\t')) nlen--;
  const char* v = colon + 1;
  size_t vlen = n - (size_t)(v - p);
  while (vlen && (*v==' ' || *v=='\t')){ v++; vlen--; }
  while (vlen && (v[vlen-1]=='\r' || v[vlen-1]=='\n' || v[vlen-1]==' ' || v[vlen-1]=='\t')) vlen--;
  if (nlen) fetch_add_response_header(fio, p, nlen, v, vlen);
  return n;
}

/* one-time global init; curl_global_init is not thread-safe but the runtime is
   single-threaded, and the event loop services I/O tasks from one thread. */
static int g_curl_inited = 0;
static CURLM* g_curl_multi = NULL;
static void ensure_curl(void){
  if (!g_curl_inited){ curl_global_init(CURL_GLOBAL_DEFAULT); g_curl_inited = 1; }
}
static CURLM* ensure_curl_multi(void){
  ensure_curl();
  if (!g_curl_multi) g_curl_multi = curl_multi_init();
  return g_curl_multi;
}

/* a fetch I/O task: stored request + target promise. The method, body and
   header lines are snapshotted as plain C strings at ts_fetch() time (the
   options object is live then; deferring the read to the worker would risk
   GC/mutation), so the worker only touches its own owned buffers. */
struct ts_fetch_io {
  ts_io base;
  char* method;        /* owned; NULL => GET */
  char* body;          /* owned; NULL => no body */
  size_t body_len;
  long timeout_ms;     /* 0 => default */
  char** headers;      /* owned array of owned "Key: Value" strings */
  int nheaders;
  CURL* easy;
  struct curl_slist* curl_headers;
  struct ts_curl_buf resp;
  CURLcode result;
  char errbuf[CURL_ERROR_SIZE];
  int in_multi;
  ts_header_pair* resp_headers;
  int nresp_headers;
  int capresp_headers;
  int aborted;
  int timeout_from_signal;
};

static void fetch_clear_response_headers(ts_fetch_io* fio){
  if (!fio) return;
  for (int i=0;i<fio->nresp_headers;i++){
    free(fio->resp_headers[i].name);
    free(fio->resp_headers[i].value);
  }
  fio->nresp_headers = 0;
}

static void fetch_add_response_header(ts_fetch_io* fio, const char* name, size_t nlen,
                                      const char* value, size_t vlen){
  if (!fio || !name) return;
  char* lname=(char*)malloc(nlen+1);
  if (!lname) ts_abort_msg("out of memory storing fetch header name");
  for (size_t i=0;i<nlen;i++) lname[i]=ascii_lower_char(name[i]);
  lname[nlen]=0;
  char* vcopy=trim_copy_ascii(value ? value : "", vlen);
  for (int i=0;i<fio->nresp_headers;i++){
    if (strcmp(fio->resp_headers[i].name, lname)==0){
      char* old=fio->resp_headers[i].value;
      size_t olen=strlen(old), alen=2, nval=strlen(vcopy);
      char* joined=(char*)malloc(olen + alen + nval + 1);
      if (!joined) ts_abort_msg("out of memory joining fetch headers");
      memcpy(joined, old, olen);
      memcpy(joined+olen, ", ", alen);
      memcpy(joined+olen+alen, vcopy, nval+1);
      free(old); free(vcopy); free(lname);
      fio->resp_headers[i].value=joined;
      return;
    }
  }
  if (fio->nresp_headers==fio->capresp_headers){
    int nc=fio->capresp_headers?fio->capresp_headers*2:8;
    ts_header_pair* np=(ts_header_pair*)realloc(fio->resp_headers, sizeof(ts_header_pair)*nc);
    if (!np) ts_abort_msg("out of memory growing fetch headers");
    fio->resp_headers=np; fio->capresp_headers=nc;
  }
  fio->resp_headers[fio->nresp_headers].name=lname;
  fio->resp_headers[fio->nresp_headers].value=vcopy;
  fio->nresp_headers++;
}
#endif

/* Simplified AbortController / AbortSignal. This models the observable pieces
   fetch currently uses: controller.signal, signal.aborted, signal.reason,
   abort(reason?), and AbortSignal.timeout(ms) as a fetch-integrated timeout
   signal. */
static uint32_t F_abort_signal=0, F_abort_aborted=0, F_abort_reason=0, F_abort_timeout_ms=0;
typedef struct ts_abort_timer {
  tsv signal;
  double deadline_ms;
  struct ts_abort_timer* next;
} ts_abort_timer;
static ts_abort_timer* g_abort_timers = NULL;

static double ts_now_ms_raw(void){
  struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts);
  return (double)ts.tv_sec*1000.0 + (double)ts.tv_nsec/1.0e6;
}

static void ensure_abort_fields(void){
  if (!F_abort_signal){
    F_abort_signal=ts_intern_field("signal",6);
    F_abort_aborted=ts_intern_field("aborted",7);
    F_abort_reason=ts_intern_field("reason",6);
    F_abort_timeout_ms=ts_intern_field("__timeoutMs",11);
  }
}

static tsv abort_reason_object(const char* name, const char* message){
  tsv e = ts_new_object();
  ts_gc_root(&e);
  ts_set(e, ts_intern_field("message", 7), ts_new_string(message, (uint32_t)strlen(message)));
  ts_set(e, ts_intern_field("name", 4), ts_new_string(name, (uint32_t)strlen(name)));
  ts_gc_unroot(1);
  return e;
}

static tsv abort_default_reason(void){
  return abort_reason_object("AbortError", "fetch aborted");
}

static tsv abort_timeout_reason(void){
  return abort_reason_object("TimeoutError", "signal timed out");
}

static void ts_abort_signal_abort_with_reason(tsv signal, tsv reason){
  if (!ts_is_obj(signal)) return;
  ensure_abort_fields();
  ts_gc_root(&signal);
  tsv aborted = ts_get(signal, F_abort_aborted);
  if (ts_truthy(aborted)){ ts_gc_unroot(1); return; }
  if (reason == TS_UNDEFINED) reason = abort_default_reason();
  ts_gc_root(&reason);
  ts_set(signal, F_abort_aborted, ts_bool(1));
  ts_set(signal, F_abort_reason, reason);
  ts_gc_unroot(2);
}

static void ts_abort_signal_abort_timeout(tsv signal){
  tsv reason = abort_timeout_reason();
  ts_gc_root(&reason);
  ts_abort_signal_abort_with_reason(signal, reason);
  ts_gc_unroot(1);
}

static void ts_abort_timer_register(tsv signal, long timeout_ms){
  if (!ts_is_obj(signal)) return;
  ts_abort_timer* t=(ts_abort_timer*)calloc(1, sizeof(ts_abort_timer));
  if (!t) ts_abort_msg("out of memory creating AbortSignal timeout");
  t->signal = signal;
  t->deadline_ms = ts_now_ms_raw() + (double)timeout_ms;
  t->next = g_abort_timers;
  g_abort_timers = t;
}

static long ts_abort_signal_timeout_ms(tsv signal){
  if (!ts_is_obj(signal)) return -1;
  ensure_abort_fields();
  ts_gc_root(&signal);
  tsv v = ts_get(signal, F_abort_timeout_ms);
  if (!ts_is_num(v)){ ts_gc_unroot(1); return -1; }
  double d = ts_to_num(v);
  ts_gc_unroot(1);
  if (!isfinite(d) || d < 0.0 || d > (double)LONG_MAX) return -1;
  return (long)d;
}

static void ts_abort_timers_fire_due(void){
  if (!g_abort_timers) return;
  double now = ts_now_ms_raw();
  ts_abort_timer** pp = &g_abort_timers;
  while (*pp){
    ts_abort_timer* t = *pp;
    if (ts_abort_signal_is_aborted(t->signal) || now >= t->deadline_ms){
      if (!ts_abort_signal_is_aborted(t->signal)) ts_abort_signal_abort_timeout(t->signal);
      *pp = t->next;
      free(t);
    } else {
      pp = &t->next;
    }
  }
}

static int ts_abort_timer_poll_timeout_ms(int default_ms){
  if (!g_abort_timers) return default_ms;
  double now = ts_now_ms_raw();
  double best = (double)default_ms;
  int found = 0;
  for (ts_abort_timer* t=g_abort_timers;t;t=t->next){
    if (ts_abort_signal_is_aborted(t->signal)) continue;
    double remain = t->deadline_ms - now;
    if (remain < 0.0) remain = 0.0;
    if (!found || remain < best){ best = remain; found = 1; }
  }
  if (!found) return default_ms;
  if (best <= 0.0) return 0;
  if (best > (double)default_ms) return default_ms;
  return (int)ceil(best);
}

static void gc_mark_abort_timer_roots(void){
  for (ts_abort_timer* t=g_abort_timers;t;t=t->next) gc_mark_value(t->signal);
}

static void gc_mark_abort_timer_roots_young(void){
  for (ts_abort_timer* t=g_abort_timers;t;t=t->next) gc_mark_value_young(t->signal);
}

tsv ts_abort_signal_new(int aborted){
  ensure_abort_fields();
  ts_abort_signal_proto_init();
  tsv signal = ts_new_object();
  ts_gc_root(&signal);
  ts_set_proto(signal, ts_abort_signal_proto());
  ts_set(signal, F_abort_aborted, ts_bool(0));
  ts_set(signal, F_abort_reason, TS_UNDEFINED);
  if (aborted) ts_abort_signal_abort_with_reason(signal, TS_UNDEFINED);
  ts_gc_unroot(1);
  return signal;
}

tsv ts_abort_signal_timeout(tsv msv){
  ensure_abort_fields();
  double d = ts_number_coerce(msv);
  if (!isfinite(d) || d < 0.0) d = 0.0;
  d = floor(d);
  if (d > (double)LONG_MAX) d = (double)LONG_MAX;
  long timeout_ms = (long)d;
  tsv signal = ts_abort_signal_new(0);
  ts_gc_root(&signal);
  ts_define_data(signal, F_abort_timeout_ms, ts_num((double)timeout_ms), 0, 0, 0);
  ts_abort_timer_register(signal, timeout_ms);
  ts_gc_unroot(1);
  return signal;
}

tsv ts_abort_controller_new(void){
  ensure_abort_fields();
  ts_abort_controller_proto_init();
  tsv controller = ts_new_object();
  ts_gc_root(&controller);
  tsv signal = ts_abort_signal_new(0);
  ts_gc_root(&signal);
  ts_set_proto(controller, ts_abort_controller_proto());
  ts_set(controller, F_abort_signal, signal);
  ts_gc_unroot(2);
  return controller;
}

int ts_abort_signal_is_aborted(tsv signal){
  if (!ts_is_obj(signal)) return 0;
  ensure_abort_fields();
  ts_gc_root(&signal);
  tsv v = ts_get(signal, F_abort_aborted);
  int aborted = ts_truthy(v);
  ts_gc_unroot(1);
  return aborted;
}

tsv ts_abort_signal_reason(tsv signal){
  if (!ts_is_obj(signal)) return TS_UNDEFINED;
  ensure_abort_fields();
  ts_gc_root(&signal);
  tsv reason = ts_get(signal, F_abort_reason);
  int aborted = ts_abort_signal_is_aborted(signal);
  ts_gc_unroot(1);
  if (reason == TS_UNDEFINED && aborted) return abort_default_reason();
  return reason;
}

tsv ts_abort_controller_abort_reason(tsv controller, tsv reason){
  if (!ts_is_obj(controller)) return TS_UNDEFINED;
  ensure_abort_fields();
  ts_gc_root(&controller);
  tsv signal = ts_get(controller, F_abort_signal);
  if (ts_is_obj(signal)) ts_abort_signal_abort_with_reason(signal, reason);
  ts_gc_unroot(1);
  return TS_UNDEFINED;
}

tsv ts_abort_controller_abort(tsv controller){
  return ts_abort_controller_abort_reason(controller, TS_UNDEFINED);
}

tsv ts_abortcontrollerproto_abort(tsv* a, int n){
  return ts_abort_controller_abort_reason(n>0?a[0]:TS_UNDEFINED, n>1?a[1]:TS_UNDEFINED);
}

/* Response object field ids are interned lazily via the runtime field table. */
static uint32_t F_status=0, F_ok=0, F_body=0, F_headers=0;
static void ensure_resp_fields(void){
  if (!F_status){
    F_status=ts_intern_field("status",6);
    F_ok=ts_intern_field("ok",2);
    F_body=ts_intern_field("__body",6);
    F_headers=ts_intern_field("headers",7);
  }
}

#if defined(TSAOT_ENABLE_FETCH)
static tsv fetch_error_object(ts_fetch_io* fio){
  const char* reason = NULL;
  if (fio && fio->errbuf[0]) reason = fio->errbuf;
  else if (fio) reason = curl_easy_strerror(fio->result);
  if (!reason || !*reason) reason = "unknown fetch error";
  char msg[512];
  snprintf(msg, sizeof msg, "fetch failed: %s", reason);
  tsv e = ts_new_object();
  ts_gc_root(&e);
  ts_set(e, ts_intern_field("message", 7), ts_new_string(msg, (uint32_t)strlen(msg)));
  ts_set(e, ts_intern_field("name", 4), ts_new_string("TypeError", 9));
  ts_gc_unroot(1);
  return e;
}

static tsv fetch_abort_reason(tsv signal){
  tsv reason = ts_abort_signal_reason(signal);
  return reason == TS_UNDEFINED ? abort_default_reason() : reason;
}

static void fetch_io_finish(ts_io* io){
  ts_fetch_io* fio=(ts_fetch_io*)io;
  tsv pv = io->p;
  ts_gc_root(&pv);
  if (fio->aborted){
    tsv err = fetch_abort_reason(io->signal);
    ts_gc_root(&err);
    ts_promise_reject_v(pv, err);
    ts_gc_unroot(2);
    return;
  }
  if (fio->timeout_from_signal && fio->result == CURLE_OPERATION_TIMEDOUT){
    ts_abort_signal_abort_timeout(io->signal);
    tsv err = fetch_abort_reason(io->signal);
    ts_gc_root(&err);
    ts_promise_reject_v(pv, err);
    ts_gc_unroot(2);
    return;
  }
  if (!fio->easy || fio->result != CURLE_OK){
    tsv err = fetch_error_object(fio);
    ts_gc_root(&err);
    ts_promise_reject_v(pv, err);
    ts_gc_unroot(2);
    return;
  }
  long code = 0;
  curl_easy_getinfo(fio->easy, CURLINFO_RESPONSE_CODE, &code);
  int status = (int)code;
  const char* body = fio->resp.p ? fio->resp.p : "";
  size_t blen = fio->resp.n;
  ensure_resp_fields();
  tsv resp = ts_new_object();
  ts_gc_root(&resp);
  tsv headers = ts_headers_new(TS_UNDEFINED);
  ts_gc_root(&headers);
  for (int i=0;i<fio->nresp_headers;i++){
    tsv hv = ts_new_string(fio->resp_headers[i].value, (uint32_t)strlen(fio->resp_headers[i].value));
    ts_gc_root(&hv);
    ts_set_cstr(headers, fio->resp_headers[i].name, hv);
    ts_gc_unroot(1);
  }
  ts_headers_make_immutable(headers);
  ts_set(resp, F_status, ts_num((double)status));
  ts_set(resp, F_ok, ts_bool(status>=200 && status<300));
  ts_set(resp, F_headers, headers);
  ts_set(resp, F_body, ts_new_string(body, (uint32_t)blen));
  ts_promise_resolve_v(pv, resp);
  ts_gc_unroot(3);
}

static void fetch_io_destroy(ts_io* io){
  ts_fetch_io* fio=(ts_fetch_io*)io;
  if (fio->easy && fio->in_multi && g_curl_multi){
    curl_multi_remove_handle(g_curl_multi, fio->easy);
    fio->in_multi = 0;
  }
  if (fio->easy) curl_easy_cleanup(fio->easy);
  if (fio->curl_headers) curl_slist_free_all(fio->curl_headers);
  if (fio->resp.p) free(fio->resp.p);
  fetch_clear_response_headers(fio);
  free(fio->resp_headers);
  free(fio->method); free(fio->body);
  for (int i=0;i<fio->nheaders;i++) free(fio->headers[i]);
  free(fio->headers);
  free(io->arg);
}

static int fetch_io_start(ts_io* io){
  ts_fetch_io* fio=(ts_fetch_io*)io;
  if (ts_abort_signal_is_aborted(io->signal)){
    fio->aborted = 1;
    return 0;
  }
  fio->result = CURLE_FAILED_INIT;
  CURLM* m = ensure_curl_multi();
  if (!m){
    snprintf(fio->errbuf, sizeof fio->errbuf, "curl multi init failed");
    return 0;
  }
  CURL* c = curl_easy_init();
  if (!c){
    snprintf(fio->errbuf, sizeof fio->errbuf, "curl easy init failed");
    return 0;
  }
  fio->easy = c;
  fio->errbuf[0] = 0;
  curl_easy_setopt(c, CURLOPT_ERRORBUFFER, fio->errbuf);
  curl_easy_setopt(c, CURLOPT_URL, io->arg);
  curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, ts_curl_write);
  curl_easy_setopt(c, CURLOPT_WRITEDATA, &fio->resp);
  curl_easy_setopt(c, CURLOPT_HEADERFUNCTION, ts_curl_header);
  curl_easy_setopt(c, CURLOPT_HEADERDATA, fio);
  curl_easy_setopt(c, CURLOPT_FOLLOWLOCATION, 1L);
  curl_easy_setopt(c, CURLOPT_MAXREDIRS, 10L);
  long timeout_ms = fio->timeout_ms > 0 ? fio->timeout_ms : 30000L;
  curl_easy_setopt(c, CURLOPT_TIMEOUT_MS, timeout_ms);
  curl_easy_setopt(c, CURLOPT_USERAGENT, "tsaot-fetch/0");
  curl_easy_setopt(c, CURLOPT_ACCEPT_ENCODING, "");
  curl_easy_setopt(c, CURLOPT_NOSIGNAL, 1L);
  curl_easy_setopt(c, CURLOPT_PRIVATE, fio);
  /* TLS verification stays at libcurl defaults (verify peer + host). */

  const char* method = (fio->method && *fio->method) ? fio->method : "GET";
  if (strcmp(method, "GET") != 0) curl_easy_setopt(c, CURLOPT_CUSTOMREQUEST, method);
  if (fio->body){
    curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE, (long)fio->body_len);
    curl_easy_setopt(c, CURLOPT_COPYPOSTFIELDS, fio->body);
  }

  for (int i=0;i<fio->nheaders;i++){
    if (fio->headers[i]) fio->curl_headers = curl_slist_append(fio->curl_headers, fio->headers[i]);
  }
  if (fio->curl_headers) curl_easy_setopt(c, CURLOPT_HTTPHEADER, fio->curl_headers);

  CURLMcode add = curl_multi_add_handle(m, c);
  if (add != CURLM_OK){
    snprintf(fio->errbuf, sizeof fio->errbuf, "curl multi add failed: %s", curl_multi_strerror(add));
    return 0;
  }
  fio->in_multi = 1;
  return 1;
}

static int fetch_drain_completed(void){
  if (!g_curl_multi) return 0;
  int completed = 0;
  int msgs = 0;
  CURLMsg* msg = NULL;
  while ((msg = curl_multi_info_read(g_curl_multi, &msgs))){
    if (msg->msg != CURLMSG_DONE) continue;
    ts_fetch_io* fio = NULL;
    curl_easy_getinfo(msg->easy_handle, CURLINFO_PRIVATE, &fio);
    if (!fio) continue;
    curl_multi_remove_handle(g_curl_multi, msg->easy_handle);
    fio->in_multi = 0;
    ts_io_remove_active(&fio->base);
    fio->result = msg->data.result;
    ts_io_finish_and_free(&fio->base);
    completed++;
  }
  return completed;
}

static int fetch_cancel_aborted_active(void){
  int completed = 0;
  ts_io* t = g_io_active;
  while (t){
    ts_io* next = t->next;
    if (ts_abort_signal_is_aborted(t->signal)){
      ts_fetch_io* fio = (ts_fetch_io*)t;
      if (fio->easy && fio->in_multi && g_curl_multi){
        curl_multi_remove_handle(g_curl_multi, fio->easy);
        fio->in_multi = 0;
      }
      ts_io_remove_active(t);
      fio->aborted = 1;
      ts_io_finish_and_free(t);
      completed++;
    }
    t = next;
  }
  return completed;
}

static int fetch_fail_all_active(const char* reason){
  int completed = 0;
  while (g_io_active){
    ts_io* t = g_io_active;
    g_io_active = t->next;
    t->next = NULL;
    ts_fetch_io* fio = (ts_fetch_io*)t;
    fio->result = CURLE_FAILED_INIT;
    if (reason && *reason) snprintf(fio->errbuf, sizeof fio->errbuf, "%s", reason);
    ts_io_finish_and_free(t);
    completed++;
  }
  return completed;
}

static int ts_io_poll_active(void){
  if (!g_io_active) return 0;
  ts_abort_timers_fire_due();
  int aborted = fetch_cancel_aborted_active();
  if (aborted || !g_io_active) return aborted;
  CURLM* m = ensure_curl_multi();
  if (!m) return fetch_fail_all_active("curl multi init failed");
  int running = 0;
  CURLMcode mc = curl_multi_perform(m, &running);
  if (mc != CURLM_OK) return fetch_fail_all_active(curl_multi_strerror(mc));
  int completed = fetch_drain_completed();
  if (completed || !g_io_active) return completed;
  ts_abort_timers_fire_due();
  aborted = fetch_cancel_aborted_active();
  if (aborted || !g_io_active) return aborted;
  int nfds = 0;
  mc = curl_multi_poll(m, NULL, 0, ts_abort_timer_poll_timeout_ms(1000), &nfds);
  if (mc != CURLM_OK) return fetch_fail_all_active(curl_multi_strerror(mc));
  ts_abort_timers_fire_due();
  aborted = fetch_cancel_aborted_active();
  if (aborted || !g_io_active) return aborted;
  mc = curl_multi_perform(m, &running);
  if (mc != CURLM_OK) return fetch_fail_all_active(curl_multi_strerror(mc));
  completed = fetch_drain_completed();
  if (completed || !g_io_active) return completed;
  return fetch_cancel_aborted_active();
}

/* Read a string property `name` from an options object as a freshly-malloc'd C
   string, or NULL if absent/non-string. */
static char* fetch_opt_str(tsv opts, const char* name){
  if (!ts_is_obj(opts)) return NULL;
  ts_gc_root(&opts);
  uint32_t fid = ts_intern_field(name, (uint32_t)strlen(name));
  tsv v = ts_get(opts, fid);
  if (!ts_is_str(v)){ ts_gc_unroot(1); return NULL; }
  ts_gc_root(&v);
  char* out = ts_string_cstr_copy(v, NULL);
  ts_gc_unroot(2);
  return out;
}

/* Read TSAOT's temporary fetch timeout extension, in milliseconds.
   Non-number, non-finite and non-positive values keep the default. */
static long fetch_opt_timeout_ms(tsv opts){
  if (!ts_is_obj(opts)) return 0;
  ts_gc_root(&opts);
  uint32_t fid = ts_intern_field("timeoutMs", 9);
  tsv v = ts_get(opts, fid);
  if (!ts_is_num(v)){ ts_gc_unroot(1); return 0; }
  double d = ts_to_num(v);
  if (!isfinite(d) || d <= 0.0){ ts_gc_unroot(1); return 0; }
  d = floor(d);
  if (d < 1.0){ ts_gc_unroot(1); return 0; }
  if (d > (double)LONG_MAX) d = (double)LONG_MAX;
  ts_gc_unroot(1);
  return (long)d;
}

static tsv fetch_opt_signal(tsv opts){
  if (!ts_is_obj(opts)) return TS_UNDEFINED;
  ts_gc_root(&opts);
  uint32_t fid = ts_intern_field("signal", 6);
  tsv signal = ts_get(opts, fid);
  ts_gc_unroot(1);
  return ts_is_obj(signal) ? signal : TS_UNDEFINED;
}

/* fetch(url, options?) -> pending Promise<Response>; posts an I/O task.
   options: { method?: string, body?: string, headers?: { [k]: string },
              timeoutMs?: number, signal?: AbortSignal }. */
tsv ts_fetch(tsv urlv, tsv opts){
  ts_gc_root(&urlv); ts_gc_root(&opts);
  tsv pv = ts_promise_new_v();
  ts_gc_root(&pv);
  tsv signal = fetch_opt_signal(opts);
  ts_gc_root(&signal);
  if (ts_abort_signal_is_aborted(signal)){
    tsv err = fetch_abort_reason(signal);
    ts_gc_root(&err);
    ts_promise_reject_v(pv, err);
    ts_gc_unroot(5);
    return pv;
  }
  ts_fetch_io* io = (ts_fetch_io*)calloc(1, sizeof(ts_fetch_io));
  io->base.start = fetch_io_start;
  io->base.finish = fetch_io_finish;
  io->base.destroy = fetch_io_destroy;
  io->base.p = pv;
  io->base.signal = signal;
  io->base.arg = ts_is_str(urlv) ? ts_string_cstr_copy(urlv, NULL) : strdup("");

  /* snapshot method + body */
  io->method = fetch_opt_str(opts, "method");
  io->body = fetch_opt_str(opts, "body");
  io->body_len = io->body ? strlen(io->body) : 0;
  io->timeout_ms = fetch_opt_timeout_ms(opts);
  long signal_timeout_ms = ts_abort_signal_timeout_ms(signal);
  if (signal_timeout_ms >= 0 && (io->timeout_ms <= 0 || signal_timeout_ms <= io->timeout_ms)){
    io->timeout_ms = signal_timeout_ms;
    io->timeout_from_signal = 1;
  }

  /* snapshot headers: each own enumerable prop of options.headers becomes a
     "Key: Value" line (values coerced to string). */
  io->headers = NULL; io->nheaders = 0;
  if (ts_is_obj(opts)){
    uint32_t hid = ts_intern_field("headers", 7);
    tsv h = ts_get(opts, hid);
    if (ts_is_obj(h) && !ts_is_array(h)){
      ts_gc_root(&h);
      tsv keys = ts_object_keys(h); ts_gc_root(&keys);
      uint32_t n = (uint32_t)ts_length(keys);
      io->headers = (char**)malloc(sizeof(char*) * (n ? n : 1));
      for (uint32_t i=0;i<n;i++){
        tsv kv = ts_array_get(keys, i);
        if (!ts_is_str(kv)) continue;
        ts_gc_root(&kv);
        ts_key fid;
        if (!ts_key_from_value(kv, &fid)){ ts_gc_unroot(1); continue; }
        tsv vv = ts_get(h, fid);
        ts_gc_root(&vv);
        /* coerce value to string (ts_to_string_v handles numbers/bools/etc) */
        tsv vs = ts_to_string_v(vv); ts_gc_root(&vs);
        uint32_t klen32=0, vlen32=0;
        char* kstr = ts_string_cstr_copy(kv, &klen32);
        char* vstr = ts_is_str(vs) ? ts_string_cstr_copy(vs, &vlen32) : strdup("");
        size_t klen = klen32, vlen = ts_is_str(vs) ? vlen32 : strlen(vstr);
        char* line = (char*)malloc(klen + 2 + vlen + 1);
        memcpy(line, kstr, klen);
        line[klen] = ':'; line[klen+1] = ' ';
        memcpy(line + klen + 2, vstr, vlen);
        line[klen + 2 + vlen] = 0;
        free(kstr); free(vstr);
        io->headers[io->nheaders++] = line;
        ts_gc_unroot(3);
      }
      ts_gc_unroot(2);
    }
  }

  ts_io_post(&io->base);
  ts_gc_unroot(4);
  return pv;
}
#else
static int ts_io_poll_active(void){ return 0; }
tsv ts_fetch(tsv urlv, tsv opts){
  (void)urlv; (void)opts;
  return ts_unsupported_builtin("fetch");
}
#endif

/* response.text() / .json(): the body is already fetched; return a resolved
   promise. json() parses; text() returns the string. */
tsv ts_response_text(tsv resp){
  ensure_resp_fields();
  tsv body = ts_get(resp, F_body);
  ts_gc_root(&body);
  tsv p = ts_promise_resolved(body);
  ts_gc_unroot(1);
  return p;
}
tsv ts_response_json(tsv resp){
  ensure_resp_fields();
  tsv body = ts_get(resp, F_body);
  ts_gc_root(&body);
  tsv parsed = ts_json_parse(body);
  ts_gc_root(&parsed);
  tsv p = ts_promise_resolved(parsed);
  ts_gc_unroot(2);
  return p;
}

static uint32_t ts_headers_name_key(tsv namev){
  ts_gc_root(&namev);
  tsv sv = ts_to_string_v(namev);
  ts_gc_root(&sv);
  uint32_t slen = 0;
  char* src = ts_string_cstr_copy(sv, &slen);
  char* lower = (char*)malloc((size_t)slen + 1);
  if (!lower) ts_abort_msg("out of memory normalizing header name");
  for (uint32_t i=0;i<slen;i++) lower[i] = ascii_lower_char(src[i]);
  lower[slen] = 0;
  uint32_t key = ts_intern_field(lower, slen);
  free(src);
  free(lower);
  ts_gc_unroot(2);
  return key;
}

static tsv ts_headers_value_string(tsv valuev){
  ts_gc_root(&valuev);
  tsv sv = ts_to_string_v(valuev);
  ts_gc_root(&sv);
  uint32_t slen = 0;
  char* utf8 = ts_string_cstr_copy(sv, &slen);
  char* trimmed = trim_copy_ascii(utf8, slen);
  tsv out = ts_new_string(trimmed, (uint32_t)strlen(trimmed));
  free(utf8);
  free(trimmed);
  ts_gc_unroot(2);
  return out;
}

/* Internal, unnameable brand slot. It is deliberately outside the string field
   namespace so user code cannot forge it by assigning a "__..." property. */
#define TS_HEADERS_BRAND_KEY (TS_WKSYM_KEY_BASE - 1u)
#define TS_HEADERS_IMMUTABLE_KEY (TS_WKSYM_KEY_BASE - 2u)

static int ts_headers_is_headers(tsv headers){
  return ts_is_obj(headers) && ts_has_own(headers, TS_HEADERS_BRAND_KEY);
}

static void ts_headers_require(tsv headers){
  if (!ts_headers_is_headers(headers)) ts_throw_type_error("Illegal invocation");
}

static int ts_headers_init_is_sequence(tsv init){
  if (ts_is_array(init) || ts_is_map(init) || ts_is_set(init) || ts_is_str(init)) return 1;
  if (!ts_object_like(init)) return 0;
  tsv itf = ts_get(init, TS_KEY_WKSYM(TS_WKSYM_ITERATOR));
  if (ts_is_callable(itf)) return 1;
  tsv nextfn = ts_get(init, ts_intern_field("next", 4));
  if (ts_is_callable(nextfn)) return 1;
  tsv coro = ts_get(init, ts_intern_field("__coro", 6));
  return ts_is_obj(coro);
}

static void ts_headers_seed_from_pair_array(tsv headers, tsv pairs){
  ts_gc_root(&headers);
  ts_gc_root(&pairs);
  uint32_t len = ts_array_len(pairs);
  for (uint32_t i=0;i<len;i++){
    tsv pair = ts_array_get(pairs, i);
    if (!ts_is_array(pair)) continue;
    ts_gc_root(&pair);
    tsv name = ts_array_get(pair, 0);
    tsv value = ts_array_get(pair, 1);
    ts_gc_root(&name);
    ts_gc_root(&value);
    ts_headers_append(headers, name, value);
    ts_gc_unroot(3);
  }
  ts_gc_unroot(2);
}

typedef struct { tsv* headers; tsv* recv; } headers_init_enum_ctx;
static void cb_headers_init_prop(uint32_t key, tsv val, void* ud){
  headers_init_enum_ctx* c = (headers_init_enum_ctx*)ud;
  const char* n = ts_field_name(key);
  if (!n) return;
  ts_gc_root(&val);
  tsv name = ts_new_string_from_field_key(key);
  ts_gc_root(&name);
  tsv resolved = enum_resolve_value(*c->recv, val);
  ts_gc_root(&resolved);
  ts_headers_append(*c->headers, name, resolved);
  ts_gc_unroot(3);
}

tsv ts_headers_new(tsv init){
  ts_gc_root(&init);
  ts_headers_proto_init();
  tsv headers = ts_new_object();
  ts_gc_root(&headers);
  ts_set_proto(headers, ts_headers_proto());
  ts_define_data(headers, TS_HEADERS_BRAND_KEY, ts_bool(1), 0, 0, 0);
  if (ts_is_undef(init) || ts_is_null(init)){
    ts_gc_unroot(2);
    return headers;
  }

  if (ts_headers_init_is_sequence(init)){
    tsv pairs = init;
    if (!ts_is_array(pairs)) pairs = ts_new_array(0);
    ts_gc_root(&pairs);
    if (pairs != init) ts_array_push_all(pairs, init);
    ts_headers_seed_from_pair_array(headers, pairs);
    ts_gc_unroot(1);
  } else if (ts_is_obj(init) && !ts_is_map(init) && !ts_is_set(init)){
    headers_init_enum_ctx c;
    c.headers = &headers;
    c.recv = &init;
    ts_prop_own_enum(init, cb_headers_init_prop, &c);
  }

  ts_gc_unroot(2);
  return headers;
}

void ts_headers_make_immutable(tsv headers){
  ts_headers_require(headers);
  ts_define_data(headers, TS_HEADERS_IMMUTABLE_KEY, ts_bool(1), 0, 0, 0);
  ts_object_freeze(headers);
}

static int ts_headers_is_immutable(tsv headers){
  ts_headers_require(headers);
  return ts_has_own(headers, TS_HEADERS_IMMUTABLE_KEY);
}

static void ts_headers_require_mutable(tsv headers){
  if (ts_headers_is_immutable(headers)) ts_throw_type_error("Headers are immutable");
}

tsv ts_headers_get(tsv headers, tsv namev){
  ts_headers_require(headers);
  ts_gc_root(&headers);
  ts_gc_root(&namev);
  uint32_t key = ts_headers_name_key(namev);
  tsv v = ts_get(headers, key);
  if (ts_is_undef(v)) v = TS_NULL;
  ts_gc_unroot(2);
  return v;
}

int ts_headers_has(tsv headers, tsv namev){
  ts_headers_require(headers);
  ts_gc_root(&headers);
  ts_gc_root(&namev);
  uint32_t key = ts_headers_name_key(namev);
  tsv v = ts_get(headers, key);
  ts_gc_unroot(2);
  return !ts_is_undef(v);
}

tsv ts_headers_keys(tsv headers){
  ts_headers_require(headers);
  return ts_object_keys(headers);
}
tsv ts_headers_values(tsv headers){
  ts_headers_require(headers);
  return ts_object_values(headers);
}
tsv ts_headers_entries(tsv headers){
  ts_headers_require(headers);
  return ts_object_entries(headers);
}

tsv ts_headers_set(tsv headers, tsv namev, tsv valuev){
  ts_headers_require_mutable(headers);
  ts_gc_root(&headers);
  ts_gc_root(&namev);
  ts_gc_root(&valuev);
  uint32_t key = ts_headers_name_key(namev);
  tsv sv = ts_headers_value_string(valuev);
  ts_gc_root(&sv);
  ts_set(headers, key, sv);
  ts_gc_unroot(4);
  return TS_UNDEFINED;
}

tsv ts_headers_append(tsv headers, tsv namev, tsv valuev){
  ts_headers_require_mutable(headers);
  ts_gc_root(&headers);
  ts_gc_root(&namev);
  ts_gc_root(&valuev);
  uint32_t key = ts_headers_name_key(namev);
  tsv sv = ts_headers_value_string(valuev);
  ts_gc_root(&sv);
  tsv old = ts_get(headers, key);
  if (ts_is_undef(old)){
    ts_set(headers, key, sv);
    ts_gc_unroot(4);
    return TS_UNDEFINED;
  }
  tsv old_s = ts_headers_value_string(old);
  ts_gc_root(&old_s);
  tsv comma = ts_new_string(", ", 2);
  ts_gc_root(&comma);
  tsv joined = ts_add(ts_add(old_s, comma), sv);
  ts_gc_root(&joined);
  ts_set(headers, key, joined);
  ts_gc_unroot(7);
  return TS_UNDEFINED;
}

tsv ts_headers_delete(tsv headers, tsv namev){
  ts_headers_require_mutable(headers);
  ts_gc_root(&headers);
  ts_gc_root(&namev);
  uint32_t key = ts_headers_name_key(namev);
  ts_delete_prop(headers, key);
  ts_gc_unroot(2);
  return TS_UNDEFINED;
}

/* generic `.length`: string length for strings, element count for arrays. */
double ts_length(tsv v){
  if (ts_is_str(v)) return (double)ts_str_len_typed(v);
  if (ts_is_array(v)) return (double)((ts_array*)ts_ptr(v))->len;
  if (ts_is_func(v)) return (double)((ts_func*)ts_ptr(v))->arity; /* fn.length */
  if (g_has_proxies && ts_is_proxy(v)) return ts_to_num(ts_get(v, ts_intern_field("length", 6))); /* honor get trap */
  return 0;
}

/* ---------------- generators (function* / yield) ---------------- */
static uint32_t F_coro=0, F_value=0, F_done=0;
static void ensure_gen_fields(void){
  if (!F_coro){ F_coro=ts_intern_field("__coro",6); F_value=ts_intern_field("value",5); F_done=ts_intern_field("done",4); }
}

/* wrap an already-allocated coroutine frame in a generator object */
tsv ts_gen_new_v(tsv cv){
  ensure_gen_fields();
  ts_gc_root(&cv);
  tsv g = ts_new_object();
  ts_gc_root(&g);
  ts_set(g, F_coro, cv);   /* coro is OBJECT-tagged (kind CORO) */
  ts_gc_unroot(2);
  return g;
}

/* Step a generic iterator, mirroring the dynamic `.next()` dispatch: look up `next`
   as an OWN/field-key property (object-literal `{next}`) THEN as a prototype
   method-key (a class iterator's `next()` method) — `nmk` is the interned method key
   for "next", supplied by the caller. Call it with this=iter, arg0=sent. If neither
   exists, the iterator is one of our generator coroutine objects (returned by a
   generator `[Symbol.iterator]()`), so drive it with the generator.next builtin.
   This makes `for...of`/`yield*` over a generator iterator work like spread, without
   regressing class iterators whose `next` lives under a method key. */
tsv ts_iter_step(tsv iter, tsv sent, ts_key nmk){
  ts_gc_root(&iter); ts_gc_root(&sent);
  tsv nf = ts_get(iter, ts_intern_field("next", 4));
  ts_gc_root(&nf);
  if (!ts_is_callable(nf)){
    ts_gc_unroot(1);
    nf = ts_get(iter, nmk);
    ts_gc_root(&nf);
  }
  tsv r;
  if (ts_is_callable(nf)){
    tsv a[2] = { iter, sent };
    r = ts_call_method(nf, a, 2);
  } else {
    r = ts_gen_next(iter, sent);
  }
  ts_gc_unroot(3);
  return r;
}

/* gen.next(sent) -> { value, done } */
tsv ts_gen_next(tsv genobj, tsv sent){
  ensure_gen_fields();
  ts_gc_root(&genobj); ts_gc_root(&sent);
  tsv result = ts_new_object();
  ts_gc_root(&result);
  if (!ts_is_obj(genobj)){ ts_set(result, F_value, TS_UNDEFINED); ts_set(result, F_done, ts_bool(1)); ts_gc_unroot(3); return result; }
  tsv cv = ts_get(genobj, F_coro);
  ts_gc_root(&cv);
  ts_coro* c = (ts_coro*)ts_ptr(cv);
  if (c->done){
    ts_set(result, F_value, TS_UNDEFINED);
    ts_set(result, F_done, ts_bool(1));
    ts_gc_unroot(4);
    return result;
  }
    c->result = sent;          /* value handed to the resuming yield */
    ts_write_barrier(ts_obj(c), sent);
  c->yielded = TS_UNDEFINED;
  ts_coro_resume_v(cv);      /* runs until the next yield or completion */
  c = (ts_coro*)ts_ptr(cv);
  if (c->done){
    /* on completion, c->yielded holds the return value (set by Return) */
    ts_set(result, F_value, c->yielded);
    ts_set(result, F_done, ts_bool(1));
  } else {
    ts_set(result, F_value, c->yielded);
    ts_set(result, F_done, ts_bool(0));
  }
  ts_gc_unroot(4);
  return result;
}

/* .throw(e) on a (sync) generator: raise e at the paused yield point. If the body
   catches it and yields/returns, return the resulting {value,done}; if uncaught,
   the resume's ts_throw longjmps out to the CALLER's handler (we run in its frame).
   If already done, throw e to the caller. */
tsv ts_gen_throw(tsv genobj, tsv exc){
  ensure_gen_fields();
  ts_gc_root(&genobj); ts_gc_root(&exc);
  tsv result = ts_new_object();
  ts_gc_root(&result);
  if (!ts_is_obj(genobj)) ts_throw(exc);
  tsv cv = ts_get(genobj, F_coro);
  ts_gc_root(&cv);
  ts_coro* c = (ts_coro*)ts_ptr(cv);
  if (c->done) ts_throw(exc);          /* throwing into a finished generator rethrows */
  c->rejected = 1;                     /* "raise c->result at the resume point" */
  c->result = exc;
  ts_write_barrier(ts_obj(c), exc);
  c->yielded = TS_UNDEFINED;
  ts_coro_resume_v(cv);                /* may catch & yield, or longjmp out if uncaught */
  c = (ts_coro*)ts_ptr(cv);
  if (c->done){
    ts_set(result, F_value, c->yielded);
    ts_set(result, F_done, ts_bool(1));
  } else {
    ts_set(result, F_value, c->yielded);
    ts_set(result, F_done, ts_bool(0));
  }
  ts_gc_unroot(4);
  return result;
}

/* .return(v) on a (sync) generator: forced return at the paused yield point.
   Per spec this injects a `return v` completion, which terminates the generator
   and returns { value: v, done: true }. If the body is suspended inside a
   try/finally, the finally block(s) must run (and could override the result) —
   that injection is not modeled here, so we loud-reject rather than silently
   skip the finally. The common cases (not started, suspended at a top-level
   yield, or already done) terminate cleanly. */
tsv ts_gen_return(tsv genobj, tsv val){
  ensure_gen_fields();
  ts_gc_root(&genobj); ts_gc_root(&val);
  tsv result = ts_new_object();
  ts_gc_root(&result);
  if (!ts_is_obj(genobj)){
    ts_set(result, F_value, val); ts_set(result, F_done, ts_bool(1)); ts_gc_unroot(3); return result;
  }
  tsv cv = ts_get(genobj, F_coro);
  ts_gc_root(&cv);
  ts_coro* c = (ts_coro*)ts_ptr(cv);
  if (!c->done){
    /* suspended inside an active try/catch/finally: a forced return must run
       any enclosing finally (which may have side effects or override the
       return value). That injection is unimplemented — fail loud, not silent. */
    if (c->eh_top > 0 || c->fin_top > 0){
      fprintf(stderr, "tsaot: generator.return() while suspended inside try/finally "
              "is unsupported (would skip the finally block)\n");
      abort();
    }
    c->done = 1;   /* terminate: no further body runs */
  }
  ts_set(result, F_value, val);
  ts_set(result, F_done, ts_bool(1));
  ts_gc_unroot(4);
  return result;
}

/* ---- async generators (async function*) ---- */
/* build a {value, done} iterator-result object */
tsv ts_iter_result(tsv value, int done){
  ensure_gen_fields();
  ts_gc_root(&value);
  tsv r = ts_new_object();
  ts_gc_root(&r);
  ts_set(r, F_value, value);
  ts_set(r, F_done, ts_bool(done));
  ts_gc_unroot(2);
  return r;
}
/* async-generator object: same shape as a sync generator (holds __coro). */
tsv ts_asyncgen_new_v(tsv cv){
  ensure_gen_fields();
  ts_gc_root(&cv);
  tsv g = ts_new_object();
  ts_gc_root(&g);
  ts_set(g, F_coro, cv);
  ts_gc_unroot(2);
  return g;
}
/* .next() on an async generator: returns a Promise<{value,done}>. Creates a fresh
   next-promise, stores it as c->ret (the resume resolves it on yield/return), and
   resumes the body. If the body awaits, it parks on the scheduler and the resume
   re-enters later, eventually resolving c->ret. */
tsv ts_asyncgen_next(tsv genobj, tsv sent){
  ensure_gen_fields();
  ts_gc_root(&genobj); ts_gc_root(&sent);
  if (!ts_is_obj(genobj)){
    tsv r = ts_iter_result(TS_UNDEFINED, 1);
    ts_gc_root(&r);
    tsv p = ts_promise_resolved(r);
    ts_gc_unroot(3);
    return p;
  }
  tsv cv = ts_get(genobj, F_coro);
  ts_gc_root(&cv);
  ts_coro* c = (ts_coro*)ts_ptr(cv);
  if (c->done){
    tsv r = ts_iter_result(TS_UNDEFINED, 1);
    ts_gc_root(&r);
    tsv p = ts_promise_resolved(r);
    ts_gc_unroot(4);
    return p;
  }
  tsv pv = ts_promise_new_v();
  ts_gc_root(&pv);
  c = (ts_coro*)ts_ptr(cv);
  c->ret = pv;               /* the resume will resolve this with {value,done} */
  c->result = sent;          /* value delivered to the resuming yield */
  ts_write_barrier(cv, pv); ts_write_barrier(cv, sent);
  c->rejected = 0;
  ts_coro_resume_v(cv);      /* runs until next yield / await-park / completion */
  ts_gc_unroot(4);
  return pv;
}

/* .throw(e) on an async generator: raise e at the paused yield point, returning a
   Promise<{value,done}>. If the body catches and yields/returns, the next-promise
   resolves accordingly; if uncaught, the asyncgen reject-buf path rejects it. */
tsv ts_asyncgen_throw(tsv genobj, tsv exc){
  ensure_gen_fields();
  ts_gc_root(&genobj); ts_gc_root(&exc);
  if (!ts_is_obj(genobj)){
    tsv p = ts_promise_rejected(exc);
    ts_gc_unroot(2);
    return p;
  }
  tsv cv = ts_get(genobj, F_coro);
  ts_gc_root(&cv);
  ts_coro* c = (ts_coro*)ts_ptr(cv);
  if (c->done){
    tsv p = ts_promise_rejected(exc);
    ts_gc_unroot(3);
    return p;
  }
  tsv pv = ts_promise_new_v();
  ts_gc_root(&pv);
  c = (ts_coro*)ts_ptr(cv);
  c->ret = pv;
  ts_write_barrier(cv, pv);
  c->rejected = 1;           /* "raise c->result at the resume point" */
  c->result = exc;
  ts_write_barrier(cv, exc);
  ts_coro_resume_v(cv);      /* body catches & yields/returns, or reject-buf rejects p */
  ts_gc_unroot(4);
  return pv;
}


void ts_abort_msg(const char* m){ fflush(stdout); fprintf(stderr, "tsaot: %s\n", m); fflush(stderr); abort(); }
int ts_handlers_count(void){ int n=0; for(ts_handler* h=g_handlers;h;h=h->prev)n++; return n; }
