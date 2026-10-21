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
static size_t g_young_threshold=65536;
/* Full-GC trigger is LIVE CELL BYTES (gc_moving_plan B-3), not cell count: a
   count misjudges pressure for variable-sized cells (one 500MB inline string
   is 1 count). g_old_bytes counts the old cells' bodies (and ArrayBuffer
   bytes): a promotion or a pretenured allocation adds, an old death
   subtracts. g_heap_bytes adds the cycle's young bytes to it and is reset to
   it by every collection, so a dying young cell needs no visit. External
   payload arrays (props/env/data) are not counted. */
static size_t g_heap_bytes = 0;
static size_t g_old_bytes = 0;
static size_t g_full_threshold_bytes = (size_t)16u * 1024u * 1024u;
static int g_full_threshold_forced = 0; /* env override pins the trigger (stress knob) */
static int g_pretenure_ctors = 1;       /* TSAOT_PRETENURE_CTORS=0: guarded constructions allocate young (docs/pretenured_construction_design.md) */
static int g_remembered_slots = 1;      /* TSAOT_REMEMBERED_SLOTS=0: whole-cell rescans */
static int g_empty_class_plain = 1;     /* TSAOT_EMPTY_CLASS_PLAIN=0: field-less class instances stay dictionary cells */
static int g_negative_pic = 1;          /* TSAOT_NEGATIVE_PIC=0: no absent-property cache entries */
static int g_absent_site = 1;           /* TSAOT_ABSENT_SITE=0: read sites keep no absent record (docs/absent_reads_inline_design.md) */
static int g_key_caches = 1;            /* TSAOT_KEY_CACHES=0: every dynamic key goes through ToString (docs/dynamic_keys_design.md) */
static int g_sparse_elements = 1;       /* TSAOT_SPARSE_ELEMENTS=0: far stores always materialize dense storage */
/* TSAOT_GC_ZAP=1 fills dead cell bodies with 0xDD during collection: a
   stale reference then reads loud garbage (kind 0xDD fails gc_kind_valid,
   tsv payloads are poison) instead of the cell's last contents.
   ASan-independent; GC cold paths only, zero mutator cost. */
static int g_gc_zap = 0;
static uint32_t g_gc_protect = 0;   /* TSAOT_GC_PROTECT: MiB of freed cells kept in quarantine; 0 = off */
/* The gen of a cell in protect mode's quarantine (gc_cell_quarantine). */
#define GC_GEN_FREED 3u
static void gc_freed_reached(ts_gc_header* h){
  fprintf(stderr, "tsaot: GC protect mode: a reachable reference names a freed cell (%p): "
                  "a missing root or write barrier\n", (void*)h);
  abort();
}

/* The young cycle: bytes allocated young since the last collection, and
   the budget that triggers a minor collection (TSAOT_GC_NURSERY_BYTES, the
   copying nursery's knob, keeps its name). */
static size_t g_young_fresh_bytes = 0;
static size_t g_young_cap_bytes = (size_t)4u * 1024u * 1024u;
/* Payload bytes (malloc'd element, property and table buffers) grown since
   the last minor collection. They are outside the cells' byte count, so a
   loop that only drops large containers would never trigger a collection
   (docs/gc_v2_design.md, G1 (b)): past this budget the next allocation runs a
   minor collection. Sixteen young budgets by default
   (TSAOT_GC_PAYLOAD_BUDGET_BYTES). */
static size_t g_payload_fresh_bytes = 0;
static size_t g_payload_budget_bytes = 0;
/* Set while a collection runs: a payload allocated then (the weak-table
   pruning compacts a WeakMap after scanning it) is allocated marked. */
static int g_gc_collecting = 0;
static inline void gc_note_payload(size_t bytes){ g_payload_fresh_bytes += bytes; }

/* ---------------- payload heap (docs/gc_v2_design.md §6.1, slice G2) ----------------
   Buffers owned by exactly one cell (closure environments first) live in a
   reserved address range, the cage, cut into 64 KiB blocks. A small payload
   is a cell of one size class per block; a payload above
   GC_PAYLOAD_SMALL_MAX takes a run of whole blocks. One mark bit per 16-byte
   granule. A set mark means "in use across collections": a payload of an
   old owner is allocated marked, and every scan of an owner marks its
   payloads (gc_payload_mark from gc_scan_cell), so after a collection every
   unmarked payload is free — those of dead young owners included, without a
   visit. Allocation bumps a per-class cursor over runs of unmarked cells; a
   cell behind the cursor is never handed out twice in one cycle, and a
   collection restarts the cursors (a block epoch). A full collection clears
   every payload mark before marking. Pointers outside the cage (a stack
   closure's borrowed environment) are not payloads and are ignored. */
#include <sys/mman.h>
#if defined(TS_ASAN_ENABLED)
extern void __asan_poison_memory_region(const void *addr, size_t size);
#define GC_PAYLOAD_POISON(p, n)   __asan_poison_memory_region((p), (n))
#define GC_PAYLOAD_UNPOISON(p, n) __asan_unpoison_memory_region((p), (n))
#else
#define GC_PAYLOAD_POISON(p, n)   ((void)0)
#define GC_PAYLOAD_UNPOISON(p, n) ((void)0)
#endif
#define GC_BLOCK_SHIFT 16u
#define GC_BLOCK_BYTES ((size_t)1u << GC_BLOCK_SHIFT)
#define GC_BLOCK_GRANULES (GC_BLOCK_BYTES >> 4)
#define GC_BLOCK_BITMAP_WORDS (GC_BLOCK_GRANULES / 64u)
#define GC_PAYLOAD_SMALL_MAX ((size_t)32768u)
#define GC_PAYLOAD_NCLASS 64
#define GC_CAGE_COMMIT_BLOCKS 16u   /* the frontier commits 1 MiB at a time */
enum { GC_BLK_FREE = 0, GC_BLK_PAYLOAD = 1, GC_BLK_LARGE = 2, GC_BLK_LARGE_CONT = 3, GC_BLK_CELL = 4, GC_BLK_LARGE_CELL = 5 };
typedef struct gc_block {
  uint8_t state, cls, mark, spare;
  uint32_t epoch;      /* the cursor is valid when it equals g_payload_epoch */
  uint32_t cursor;     /* next candidate cell offset */
  uint32_t live;       /* marked bytes (payload blocks) */
  uint32_t next;       /* class list, free list or large list: block index + 1 */
  uint32_t prev;       /* large list back link */
  uint32_t nblocks;    /* large run length in blocks */
  uint32_t bytes;      /* large run: requested bytes */
} gc_block;
typedef struct { char* ptr; char* end; uint32_t head; uint32_t scan; } gc_pclass;
static char* g_cage_base = NULL;
static size_t g_cage_bytes = 0;
static uint32_t g_cage_blocks = 0, g_cage_frontier = 0, g_cage_committed = 0;
static gc_block* g_blocks = NULL;
static uint64_t* g_cage_bitmaps = NULL;
static uint32_t g_free_blocks = 0;        /* single free blocks (index + 1) */
static uint32_t g_large_head = 0;         /* large runs (index + 1) */
static uint32_t g_payload_epoch = 1;
static gc_pclass g_pclass[GC_PAYLOAD_NCLASS];
/* The cell space (G3): cells in blocks of their size class, beside the payload blocks. */
static gc_pclass g_cclass[GC_PAYLOAD_NCLASS];
static uint32_t g_large_cell_head = 0;   /* large cell runs (index + 1) */
static uint32_t g_pclass_size[GC_PAYLOAD_NCLASS];
/* Per class: the bytes its cells tile from a block's start, and the cell
   starts as bitmap words (bit j of word w set when granule 64w + j starts a
   cell): a block's free run is then found with word operations. */
static uint32_t g_pclass_lim[GC_PAYLOAD_NCLASS];
static uint64_t g_pclass_starts[GC_PAYLOAD_NCLASS][GC_BLOCK_BITMAP_WORDS];
static uint8_t g_pclass_of[(GC_PAYLOAD_SMALL_MAX >> 4) + 1];
static int g_pclass_n = 0;
/* Debug modes (TSAOT_GC_ZAP, ASan): the runs handed out in the current cycle,
   so that after a minor collection only those are checked for cells that
   became free (old payloads keep their marks; explicit frees are zapped at
   once). A full collection checks every block. */
#if defined(TS_ASAN_ENABLED)
#define GC_PAYLOAD_CHECKED 1
#else
#define GC_PAYLOAD_CHECKED g_gc_zap
#endif
/* A run of free cells is zeroed once, when the allocator takes it (one
   memset of the run, which the hardware zeroes by cache line), so a cell's
   allocation stores no zeros. Under ASan the cells of a run stay poisoned
   until they are handed out, so each cell is zeroed then instead. */
#if defined(TS_ASAN_ENABLED)
#define GC_CELL_RUNS_ZEROED 0
#else
#define GC_CELL_RUNS_ZEROED 1
#endif
typedef struct { char* start; char* end; uint32_t size; } gc_prun;
static gc_prun* g_payload_runs = NULL;
static size_t g_payload_runs_len = 0, g_payload_runs_cap = 0;
static void gc_payload_log_run(char* start, char* end, uint32_t size){
  if (g_payload_runs_len == g_payload_runs_cap){
    size_t next = g_payload_runs_cap ? g_payload_runs_cap * 2 : 256;
    gc_prun* grown = (gc_prun*)realloc(g_payload_runs, sizeof(gc_prun) * next);
    if (!grown) ts_abort_msg("out of memory growing the payload run log");
    g_payload_runs = grown; g_payload_runs_cap = next;
  }
  g_payload_runs[g_payload_runs_len++] = (gc_prun){ start, end, size };
}
static void gc_cage_init(void){
  size_t want = (size_t)64u << 30;
  const char* gb = getenv("TSAOT_GC_CAGE_GB");
  if (gb && gb[0]){ unsigned long v = strtoul(gb, NULL, 10); if (v) want = (size_t)v << 30; }
  for (; want >= ((size_t)1u << 28); want >>= 1){
    void* m = mmap(NULL, want + GC_BLOCK_BYTES, PROT_NONE, MAP_PRIVATE | MAP_ANON, -1, 0);
    if (m == MAP_FAILED) continue;
    uintptr_t base = ((uintptr_t)m + GC_BLOCK_BYTES - 1u) & ~(uintptr_t)(GC_BLOCK_BYTES - 1u);
    g_cage_base = (char*)base; g_cage_bytes = want;
    break;
  }
  if (!g_cage_base) ts_abort_msg("cannot reserve the heap cage (TSAOT_GC_CAGE_GB)");
  g_cage_blocks = (uint32_t)(g_cage_bytes >> GC_BLOCK_SHIFT);
  void* bt = mmap(NULL, sizeof(gc_block) * (size_t)g_cage_blocks, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
  void* bm = mmap(NULL, sizeof(uint64_t) * GC_BLOCK_BITMAP_WORDS * (size_t)g_cage_blocks, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
  if (bt == MAP_FAILED || bm == MAP_FAILED) ts_abort_msg("cannot reserve the heap cage tables");
  g_blocks = (gc_block*)bt; g_cage_bitmaps = (uint64_t*)bm;
  /* size classes: 16-byte steps to 256 B, then about 12.5% (multiples of 16) */
  uint32_t sz = 16u;
  while (g_pclass_n < GC_PAYLOAD_NCLASS){
    g_pclass_size[g_pclass_n++] = sz;
    if (sz >= GC_PAYLOAD_SMALL_MAX) break;
    uint32_t next = sz < 256u ? sz + 16u : ((sz + sz / 8u + 15u) & ~15u);
    sz = next > GC_PAYLOAD_SMALL_MAX ? (uint32_t)GC_PAYLOAD_SMALL_MAX : next;
  }
  if (g_pclass_size[g_pclass_n - 1] != GC_PAYLOAD_SMALL_MAX) ts_abort_msg("payload size classes do not reach the small maximum");
  int c = 0;
  for (uint32_t g = 0; g <= (GC_PAYLOAD_SMALL_MAX >> 4); g++){
    while (g_pclass_size[c] < g * 16u) c++;
    g_pclass_of[g] = (uint8_t)c;
  }
  for (int k = 0; k < g_pclass_n; k++){
    uint32_t size = g_pclass_size[k], ncells = (uint32_t)(GC_BLOCK_BYTES / size);
    g_pclass_lim[k] = ncells * size;
    for (uint32_t i = 0; i < ncells; i++){
      uint32_t g = (i * size) >> 4;
      g_pclass_starts[k][g >> 6] |= (uint64_t)1u << (g & 63u);
    }
  }
}
static inline uint64_t* gc_block_bitmap(uint32_t bi){ return g_cage_bitmaps + (size_t)bi * GC_BLOCK_BITMAP_WORDS; }
static inline char* gc_block_base(uint32_t bi){ return g_cage_base + ((size_t)bi << GC_BLOCK_SHIFT); }
/* A run of `n` never-used blocks at the frontier, committed on the way. */
static uint32_t gc_cage_frontier_take(uint32_t n){
  if (!g_cage_base) gc_cage_init();
  if ((uint64_t)g_cage_frontier + n > g_cage_blocks) ts_abort_msg("out of memory: the heap cage is full (TSAOT_GC_CAGE_GB)");
  uint32_t bi = g_cage_frontier;
  g_cage_frontier += n;
  if (g_cage_frontier > g_cage_committed){
    uint32_t to = g_cage_frontier + GC_CAGE_COMMIT_BLOCKS - 1u;
    to -= to % GC_CAGE_COMMIT_BLOCKS;
    if (to > g_cage_blocks) to = g_cage_blocks;
    if (mprotect(gc_block_base(g_cage_committed), (size_t)(to - g_cage_committed) << GC_BLOCK_SHIFT, PROT_READ | PROT_WRITE) != 0)
      ts_abort_msg("out of memory: cannot commit heap cage blocks");
    g_cage_committed = to;
  }
  return bi;
}
static uint32_t gc_block_take(void){
  if (g_free_blocks){
    uint32_t bi = g_free_blocks - 1u;
    g_free_blocks = g_blocks[bi].next;
    return bi;
  }
  return gc_cage_frontier_take(1u);
}
/* The next run of unmarked cells of block `bi` at or after its cursor, or 0.
   Bits are set only at cell starts (a mark or old bit), so the run starts at
   the first cell start whose bit is clear and ends at the next set bit; both
   are found a word at a time (a dense block of survivors was walked a cell
   at a time before: 7% of the TypeScript compiler's run). */
static int gc_payload_block_run(uint32_t bi, unsigned cls, char** ptr, char** end){
  gc_block* b = &g_blocks[bi];
  if (b->epoch != g_payload_epoch){ b->epoch = g_payload_epoch; b->cursor = 0; }
  uint32_t size = g_pclass_size[cls], lim = g_pclass_lim[cls];
  if (b->live + size > lim || b->cursor >= lim){ b->cursor = lim; return 0; }
  const uint64_t* bm = gc_block_bitmap(bi);
  const uint64_t* starts = g_pclass_starts[cls];
  uint32_t g = b->cursor >> 4, w = g >> 6;
  uint64_t free_starts = ~bm[w] & starts[w] & (~(uint64_t)0 << (g & 63u));
  while (!free_starts){
    if (++w == GC_BLOCK_BITMAP_WORDS){ b->cursor = lim; return 0; }
    free_starts = ~bm[w] & starts[w];
  }
  uint32_t first = (w << 6) + (uint32_t)__builtin_ctzll(free_starts);
  uint64_t set = bm[w] & (~(uint64_t)0 << (first & 63u));
  while (!set && ++w < GC_BLOCK_BITMAP_WORDS) set = bm[w];
  uint32_t stop = set ? ((w << 6) + (uint32_t)__builtin_ctzll(set)) << 4 : lim;
  if (stop > lim) stop = lim;
  b->cursor = stop;
  *ptr = gc_block_base(bi) + ((size_t)first << 4); *end = gc_block_base(bi) + stop;
  return 1;
}
static void gc_payload_zap_run(char* p, size_t n){
  if (g_gc_zap) memset(p, 0xDD, n);
  GC_PAYLOAD_POISON(p, n);
}
static char* gc_space_refill(gc_pclass* classes, uint8_t state, unsigned cls, int log_runs){
  gc_pclass* c = &classes[cls];
  uint32_t size = g_pclass_size[cls];
  char* ptr; char* end;
  while (c->scan){
    uint32_t bi = c->scan - 1u;
    if (gc_payload_block_run(bi, cls, &ptr, &end)){
      c->ptr = ptr; c->end = end;
      if (log_runs) gc_payload_log_run(ptr, end, size);
      if (GC_CELL_RUNS_ZEROED && state == GC_BLK_CELL) memset(ptr, 0, (size_t)(end - ptr));
      return ptr;
    }
    c->scan = g_blocks[bi].next;
  }
  uint32_t bi = gc_block_take();
  gc_block* b = &g_blocks[bi];
  memset(b, 0, sizeof(*b));
  b->state = state; b->cls = (uint8_t)cls; b->epoch = g_payload_epoch;
  memset(gc_block_bitmap(bi), 0, sizeof(uint64_t) * GC_BLOCK_BITMAP_WORDS);
  /* new blocks join the head of the class list; the scan continues there */
  b->next = c->head; c->head = bi + 1u; c->scan = bi + 1u;
  uint32_t ncells = (uint32_t)(GC_BLOCK_BYTES / size);
  b->cursor = ncells * size;
  c->ptr = gc_block_base(bi); c->end = c->ptr + (size_t)ncells * size;
  /* a block from the free list may hold a released run's old bytes */
  if (GC_CELL_RUNS_ZEROED && state == GC_BLK_CELL) memset(c->ptr, 0, (size_t)ncells * size);
  GC_PAYLOAD_POISON(c->ptr, (size_t)ncells * size);
  if (log_runs) gc_payload_log_run(c->ptr, c->end, size);
  return c->ptr;
}
static char* gc_payload_refill(unsigned cls){ return gc_space_refill(g_pclass, GC_BLK_PAYLOAD, cls, GC_PAYLOAD_CHECKED); }
static inline void gc_payload_mark_small(uint32_t bi, uintptr_t off_in_block){
  uint32_t g = (uint32_t)(off_in_block >> 4);
  uint64_t* w = &gc_block_bitmap(bi)[g >> 6];
  uint64_t m = (uint64_t)1u << (g & 63u);
  if (!(*w & m)){ *w |= m; g_blocks[bi].live += g_pclass_size[g_blocks[bi].cls]; }
}
static void* gc_payload_alloc_large(size_t bytes, int old){
  uint32_t n = (uint32_t)((bytes + GC_BLOCK_BYTES - 1u) >> GC_BLOCK_SHIFT);
  uint32_t bi = gc_cage_frontier_take(n);   /* runs are not recycled yet: rare (G0) */
  gc_block* b = &g_blocks[bi];
  memset(b, 0, sizeof(*b));
  b->state = GC_BLK_LARGE; b->nblocks = n; b->bytes = (uint32_t)(bytes > UINT32_MAX ? UINT32_MAX : bytes);
  b->mark = (uint8_t)(old ? 1 : 0);
  for (uint32_t i = 1; i < n; i++){ memset(&g_blocks[bi + i], 0, sizeof(gc_block)); g_blocks[bi + i].state = GC_BLK_LARGE_CONT; }
  b->next = g_large_head; b->prev = 0;
  if (g_large_head) g_blocks[g_large_head - 1u].prev = bi + 1u;
  g_large_head = bi + 1u;
  char* p = gc_block_base(bi);
  GC_PAYLOAD_UNPOISON(p, bytes);
  gc_note_payload((size_t)n << GC_BLOCK_SHIFT);
  return p;
}
/* A payload for an owner (old: allocated marked). Never collects. */
static void* gc_payload_alloc(size_t bytes, int old){
  if (bytes > GC_PAYLOAD_SMALL_MAX) return gc_payload_alloc_large(bytes, old);
  if (TS_RT_UNLIKELY(!g_cage_base)) gc_cage_init();
  unsigned cls = g_pclass_of[(bytes + 15u) >> 4];
  gc_pclass* c = &g_pclass[cls];
  size_t size = g_pclass_size[cls];
  char* p = c->ptr;
  if (TS_RT_UNLIKELY(!p || p + size > c->end)) p = gc_payload_refill(cls);
  c->ptr = p + size;
  GC_PAYLOAD_UNPOISON(p, size);
  if (old){
    uintptr_t off = (uintptr_t)(p - g_cage_base);
    gc_payload_mark_small((uint32_t)(off >> GC_BLOCK_SHIFT), off & (GC_BLOCK_BYTES - 1u));
  }
  gc_note_payload(size);
  return p;
}

/* ---- the cell space (docs/gc_v2_design.md §6.2, slice G3) ----
   Cells live in blocks of their size class and never move. A set mark bit
   means "old": a pretenured cell is allocated marked, an eden collection
   sets the bit of every young cell it found reachable (promotion in place),
   and a full collection clears the bits of the old cells it did not
   reach. Between
   collections the young cells of the cycle sit behind the class cursors, so
   they are never handed out twice; after a collection every unmarked cell is
   free. Cells above the small maximum take runs of blocks with a run mark.
   A reference is the cell's address (slice D2). The cells allocated young
   in a cycle are logged, and the log is how a collection finds them,
   promoting the marked and releasing the dead without a sweep (a dying
   cell's side buffers and the heap accounting need the visit). */
static ts_gc_header** g_young_log = NULL;
static size_t g_young_log_len = 0, g_young_log_cap = 0;
/* The kinds whose death releases memory outside the heap: an ArrayBuffer's
   bytes, a promise's waiters, a coroutine's side arrays. Only they (and
   large cells, whose blocks go back) are logged, so the collector visits
   the young cells that die only for those; every other dead young cell is
   free because no bit covers it. The debug modes (zap, protect, ASan, the
   statistics build, the unit tests) log every young cell. */
#define GC_FINALIZABLE_KINDS ((1u << TS_KIND_ARRAYBUFFER) | (1u << TS_KIND_PROMISE) | (1u << TS_KIND_CORO))
#if defined(TS_ASAN_ENABLED) || defined(TSAOT_RT_STATS)
static uint32_t g_young_log_kinds = ~0u;
#else
static uint32_t g_young_log_kinds = GC_FINALIZABLE_KINDS;
#endif
/* The young cells the marker reached, promoted after marking. */
static ts_gc_header** g_survivors = NULL;
static size_t g_survivors_len = 0, g_survivors_cap = 0;
static inline void gc_survivor_push(ts_gc_header* h){
  if (TS_RT_UNLIKELY(g_survivors_len == g_survivors_cap)){
    size_t next = g_survivors_cap ? g_survivors_cap * 2 : 4096;
    ts_gc_header** grown = (ts_gc_header**)realloc(g_survivors, sizeof(ts_gc_header*) * next);
    if (!grown) ts_abort_msg("out of memory growing the survivor list");
    g_survivors = grown; g_survivors_cap = next;
  }
  g_survivors[g_survivors_len++] = h;
}
static inline void gc_young_log_push(ts_gc_header* h){
  if (TS_RT_UNLIKELY(g_young_log_len == g_young_log_cap)){
    size_t next = g_young_log_cap ? g_young_log_cap * 2 : 65536;
    ts_gc_header** grown = (ts_gc_header**)realloc(g_young_log, sizeof(ts_gc_header*) * next);
    if (!grown) ts_abort_msg("out of memory growing the young cell log");
    g_young_log = grown; g_young_log_cap = next;
  }
  g_young_log[g_young_log_len++] = h;
}
static void* gc_cell_alloc_large(size_t bytes, int old){
  uint32_t n = (uint32_t)((bytes + GC_BLOCK_BYTES - 1u) >> GC_BLOCK_SHIFT);
  uint32_t bi = n == 1u ? gc_block_take() : gc_cage_frontier_take(n);
  gc_block* b = &g_blocks[bi];
  memset(b, 0, sizeof(*b));
  b->state = GC_BLK_LARGE_CELL; b->nblocks = n; b->bytes = (uint32_t)(bytes > UINT32_MAX ? UINT32_MAX : bytes);
  b->mark = (uint8_t)(old ? 1 : 0);
  for (uint32_t i = 1; i < n; i++){ memset(&g_blocks[bi + i], 0, sizeof(gc_block)); g_blocks[bi + i].state = GC_BLK_LARGE_CONT; }
  b->next = g_large_cell_head; b->prev = 0;
  if (g_large_cell_head) g_blocks[g_large_cell_head - 1u].prev = bi + 1u;
  g_large_cell_head = bi + 1u;
  char* p = gc_block_base(bi);
  GC_PAYLOAD_UNPOISON(p, bytes);
  memset(p, 0, bytes);
  return p;
}
/* A zeroed cell (the calloc contract of the previous allocator): its run
   was zeroed when the allocator took it (GC_CELL_RUNS_ZEROED). */
static inline void* gc_cell_alloc(size_t bytes, int old){
  if (TS_RT_UNLIKELY(bytes > GC_PAYLOAD_SMALL_MAX)) return gc_cell_alloc_large(bytes, old);
  if (TS_RT_UNLIKELY(!g_cage_base)) gc_cage_init();
  unsigned cls = g_pclass_of[(bytes + 15u) >> 4];
  gc_pclass* c = &g_cclass[cls];
  size_t size = g_pclass_size[cls];
  char* p = c->ptr;
  if (TS_RT_UNLIKELY(!p || p + size > c->end)) p = gc_space_refill(g_cclass, GC_BLK_CELL, cls, 0);
  c->ptr = p + size;
  GC_PAYLOAD_UNPOISON(p, size);
  if (!GC_CELL_RUNS_ZEROED) memset(p, 0, bytes);
  if (old){
    uintptr_t off = (uintptr_t)(p - g_cage_base);
    gc_payload_mark_small((uint32_t)(off >> GC_BLOCK_SHIFT), off & (GC_BLOCK_BYTES - 1u));
  }
  return p;
}
static inline gc_block* gc_cell_block(const ts_gc_header* h){
  return &g_blocks[((uintptr_t)h - (uintptr_t)g_cage_base) >> GC_BLOCK_SHIFT];
}
/* Promotion in place: the cell's mark bit (or run mark) makes it old. */
static void gc_cell_set_old_bit(ts_gc_header* h){
  gc_block* b = gc_cell_block(h);
  if (b->state == GC_BLK_CELL){
    uintptr_t off = (uintptr_t)h - (uintptr_t)g_cage_base;
    gc_payload_mark_small((uint32_t)(off >> GC_BLOCK_SHIFT), off & (GC_BLOCK_BYTES - 1u));
  } else b->mark = 1;
}
static void gc_cell_release_large(ts_gc_header* h){
  gc_block* b = gc_cell_block(h);
  if (b->state != GC_BLK_LARGE_CELL) return;
  uint32_t bi = (uint32_t)(b - g_blocks);
  if (b->prev) g_blocks[b->prev - 1u].next = b->next; else g_large_cell_head = b->next;
  if (b->next) g_blocks[b->next - 1u].prev = b->prev;
  size_t bytes = (size_t)b->nblocks << GC_BLOCK_SHIFT;
  if (b->nblocks > 1u) madvise((void*)h, bytes, MADV_FREE);
  uint32_t n = b->nblocks;
  for (uint32_t i = 0; i < n; i++){
    g_blocks[bi + i].state = GC_BLK_FREE; g_blocks[bi + i].next = g_free_blocks; g_free_blocks = bi + i + 1u;
  }
}
/* Mark an owner's payload (from the collector's scan of the owner). */
static inline void gc_payload_mark(const void* p){
  uintptr_t off = (uintptr_t)p - (uintptr_t)g_cage_base;
  if (!p || off >= g_cage_bytes) return;
  uint32_t bi = (uint32_t)(off >> GC_BLOCK_SHIFT);
  gc_block* b = &g_blocks[bi];
  if (b->state == GC_BLK_PAYLOAD) gc_payload_mark_small(bi, off & (GC_BLOCK_BYTES - 1u));
  else if (b->state == GC_BLK_LARGE) b->mark = 1;
}

static inline int gc_payload_in_cage(const void* p){
  return p && (uintptr_t)p - (uintptr_t)g_cage_base < g_cage_bytes;
}
/* The usable bytes of a payload (its size class, or its run). */
static size_t gc_payload_size(const void* p){
  uintptr_t off = (uintptr_t)p - (uintptr_t)g_cage_base;
  const gc_block* b = &g_blocks[off >> GC_BLOCK_SHIFT];
  return b->state == GC_BLK_PAYLOAD ? g_pclass_size[b->cls] : (size_t)b->nblocks << GC_BLOCK_SHIFT;
}
/* Release a payload its owner no longer references (growth, conversion):
   a small cell loses its mark (reusable after the next collection), a large
   run returns its blocks. */
static void gc_payload_free(void* p){
  uintptr_t off = (uintptr_t)p - (uintptr_t)g_cage_base;
  uint32_t bi = (uint32_t)(off >> GC_BLOCK_SHIFT);
  gc_block* b = &g_blocks[bi];
  if (b->state == GC_BLK_PAYLOAD){
    uint32_t size = g_pclass_size[b->cls];
    uint32_t g = (uint32_t)((off & (GC_BLOCK_BYTES - 1u)) >> 4);
    uint64_t* w = &gc_block_bitmap(bi)[g >> 6];
    uint64_t m = (uint64_t)1u << (g & 63u);
    if (*w & m){ *w &= ~m; b->live -= size; }
    gc_payload_zap_run((char*)p, size);
  } else if (b->state == GC_BLK_LARGE){
    if (b->prev) g_blocks[b->prev - 1u].next = b->next; else g_large_head = b->next;
    if (b->next) g_blocks[b->next - 1u].prev = b->prev;
    size_t bytes = (size_t)b->nblocks << GC_BLOCK_SHIFT;
    gc_payload_zap_run((char*)p, bytes);
    if (b->nblocks > 1u) madvise(p, bytes, MADV_FREE);
    uint32_t n = b->nblocks;
    for (uint32_t i = 0; i < n; i++){
      g_blocks[bi + i].state = GC_BLK_FREE; g_blocks[bi + i].next = g_free_blocks; g_free_blocks = bi + i + 1u;
    }
  }
}
/* Buffers owned by a cell: payloads for heap owners; malloc'd for owners
   outside the heap (stack and arena cells: the collector may not see such a
   cell, so it could not mark its payloads). The release functions tell the
   two apart by the cage check. */
static void* gc_owned_alloc(const ts_gc_header* owner, size_t bytes){
  if (owner->gen == TS_GEN_NONHEAP){ gc_note_payload(bytes); return malloc(bytes); }
  return gc_payload_alloc(bytes, owner->gen == TS_GEN_OLD || g_gc_collecting);
}
static void gc_owned_free(void* p){
  if (!p) return;
  if (gc_payload_in_cage(p)) gc_payload_free(p); else free(p);
}
static void* gc_owned_realloc(const ts_gc_header* owner, void* p, size_t old_bytes, size_t new_bytes){
  if (!p) return gc_owned_alloc(owner, new_bytes);
  if (!gc_payload_in_cage(p)){ gc_note_payload(new_bytes > old_bytes ? new_bytes - old_bytes : 0); return realloc(p, new_bytes); }
  if (new_bytes <= gc_payload_size(p)) return p;
  void* np = gc_owned_alloc(owner, new_bytes);
  memcpy(np, p, old_bytes < new_bytes ? old_bytes : new_bytes);
  gc_payload_free(p);
  return np;
}
/* A dying cell's buffers: payloads go by not being marked; only malloc'd
   ones (an owner outside the heap never dies here) would need a free. */
static inline void gc_owned_release_dead(void* p){
  if (p && !gc_payload_in_cage(p)){
    /* A heap owner's buffers are payloads; a dead cell is visited only in
       the debug modes, which check that production loses nothing here. */
    if (g_young_log_kinds != GC_FINALIZABLE_KINDS)
      ts_abort_msg("a dead heap cell owned a malloc'd buffer (a young death would leak it)");
    free(p);
  }
}
/* A full collection re-marks every payload it reaches. */
static void gc_payload_begin_full(void){
  if (!g_cage_base) return;
  for (int cls = 0; cls < g_pclass_n; cls++)
    for (uint32_t l = g_pclass[cls].head; l; l = g_blocks[l - 1u].next){
      memset(gc_block_bitmap(l - 1u), 0, sizeof(uint64_t) * GC_BLOCK_BITMAP_WORDS);
      g_blocks[l - 1u].live = 0;
    }
  for (uint32_t l = g_large_head; l; l = g_blocks[l - 1u].next) g_blocks[l - 1u].mark = 0;
}
/* After a collection: unmarked payloads are free. Large runs are released;
   small cells become allocatable again when the cursors restart. In the
   debug modes the cells that became free are zapped / poisoned: after a
   minor collection those of the runs handed out in the cycle, after a full
   one every block. */
static inline int gc_payload_cell_marked(char* p){
  uintptr_t off = (uintptr_t)(p - g_cage_base);
  uint32_t bi = (uint32_t)(off >> GC_BLOCK_SHIFT);
  uint32_t g = (uint32_t)((off & (GC_BLOCK_BYTES - 1u)) >> 4);
  return (int)(gc_block_bitmap(bi)[g >> 6] >> (g & 63u) & 1u);
}
static void gc_payload_after_collection(int full){
  if (!g_cage_base) return;
  g_payload_epoch++;
  if (!g_payload_epoch) g_payload_epoch = 1;
  if (GC_PAYLOAD_CHECKED){
    if (full){
      for (int cls = 0; cls < g_pclass_n; cls++){
        uint32_t size = g_pclass_size[cls], ncells = (uint32_t)(GC_BLOCK_BYTES / size);
        for (uint32_t l = g_pclass[cls].head; l; l = g_blocks[l - 1u].next)
          for (uint32_t i = 0; i < ncells; i++){
            char* cell = gc_block_base(l - 1u) + (size_t)i * size;
            if (!gc_payload_cell_marked(cell)) gc_payload_zap_run(cell, size);
          }
      }
    } else {
      for (size_t r = 0; r < g_payload_runs_len; r++)
        for (char* cell = g_payload_runs[r].start; cell < g_payload_runs[r].end; cell += g_payload_runs[r].size)
          if (!gc_payload_cell_marked(cell)) gc_payload_zap_run(cell, g_payload_runs[r].size);
    }
    g_payload_runs_len = 0;
  }
  for (int cls = 0; cls < g_pclass_n; cls++){
    gc_pclass* c = &g_pclass[cls];
    c->ptr = c->end = NULL; c->scan = c->head;
    gc_pclass* cc = &g_cclass[cls];
    cc->ptr = cc->end = NULL; cc->scan = cc->head;
  }
  uint32_t l = g_large_head;
  while (l){
    gc_block* b = &g_blocks[l - 1u];
    uint32_t next = b->next;
    if (!b->mark){
      if (b->prev) g_blocks[b->prev - 1u].next = b->next; else g_large_head = b->next;
      if (b->next) g_blocks[b->next - 1u].prev = b->prev;
      gc_payload_zap_run(gc_block_base(l - 1u), (size_t)b->nblocks << GC_BLOCK_SHIFT);
      /* the run's blocks join the single-block free list */
      for (uint32_t i = 0; i < b->nblocks; i++){
        uint32_t bi = l - 1u + i;
        g_blocks[bi].state = GC_BLK_FREE; g_blocks[bi].next = g_free_blocks; g_free_blocks = bi + 1u;
      }
    }
    l = next;
  }
}
/* Young allocations since the last collection: the minor COUNT trigger. */
static size_t g_young_new_since_minor = 0;
static tsv** g_roots=NULL; static int g_root_len=0, g_root_cap=0;
static tsv** g_static_roots=NULL; static int g_static_root_len=0, g_static_root_cap=0;
ts_frame_hdr* g_ts_frame_top = NULL;
#ifdef TSAOT_RT_STATS
unsigned long long g_ts_frame_push_count = 0;
unsigned long long g_ts_pic_get_calls = 0, g_ts_pic_get_hits = 0;
unsigned long long g_ts_pic_entry_hits[4] = {0,0,0,0}, g_ts_pic_keyval_hits = 0, g_ts_pic_ool_hits = 0;
unsigned long long g_ts_slot_inline_hits = 0, g_ts_slot_external_hits = 0;
unsigned long long g_ts_pic_set_calls = 0, g_ts_pic_set_hits = 0;
#endif
static ts_gc_header** g_remset=NULL; static size_t g_rem_len=0, g_rem_cap=0;

/* ---------------- runtime stats (compile-time opt-in) ----------------
   Build with -DTSAOT_RT_STATS to compile in lightweight counters; a summary is
   printed to stderr at process exit (TSAOT_RT_STATS_FILE=path appends there
   instead). Default builds compile every macro to ((void)0) — zero hot-path
   cost, identical codegen. Perf 判断の事実基盤 (refactor plan P0)。 */
#ifdef TSAOT_RT_STATS
#include <time.h>
/* Per-key histograms of the out-of-line property paths (statistics build
   only): which keys take the out-of-line read, which are read absent, which
   are added. Keys are interned ids below TS_RT_KEY_HIST. */
#define TS_RT_KEY_HIST 65536u
static unsigned long long g_key_ool_get[TS_RT_KEY_HIST], g_key_absent[TS_RT_KEY_HIST], g_key_add[TS_RT_KEY_HIST];
static unsigned long long g_key_prop_find[TS_RT_KEY_HIST];
unsigned long long g_ts_key_inline_get[65536], g_ts_key_inline_set[65536];
unsigned long long g_ts_static_get_hit, g_ts_static_get_miss, g_ts_static_set_hit, g_ts_static_set_miss, g_ts_static_learned;
unsigned long long g_ts_key_static_get_miss[65536], g_ts_key_static_set_miss[65536];
unsigned long long g_ts_static_miss_slot[65536u * 18u];
void ts_rt_stat_static_miss_slot(tsv obj, ts_key key){
  if ((uint32_t)key >= 65536u) return;
  uint32_t idx = 17u;
  if (TS_TOP16(obj) == TS_SEL_OBJECT){
    ts_object* o = (ts_object*)ts_ptr(obj);
    if (o->h.kind == TS_KIND_OBJECT && ts_obj_shape_id(o) != TS_SHAPE_NONE){
      idx = 16u;
      const ts_key* ks = g_ts_shape_keys[ts_obj_shape_id(o)];
      for (uint32_t i = 0; i < o->len; i++) if (ks[i] == key){ idx = i < 16u ? i : 16u; break; }
    }
  }
  g_ts_static_miss_slot[(uint32_t)key * 18u + idx]++;
}
static uint32_t g_next_shape;   /* defined with the shape table below */
/* The first full collections of the run: heap bytes before and after, the
   next threshold and the pause (statistics build). */
static struct { size_t before, after, next; uint64_t pause_ns; } g_rt_full_trace[32];
static uint32_t g_rt_full_trace_len = 0;
#define RT_STAT_KEY(arr, key) do { if ((uint32_t)(key) < TS_RT_KEY_HIST) arr[(uint32_t)(key)]++; } while (0)
static struct {
  unsigned long long minor_gc, full_gc, gc_pause_ns, gc_pause_max_ns;
  unsigned long long mark_stack_peak;
  unsigned long long alloc_count, alloc_bytes, handle_alloc, root_push, pretenured_alloc;
  unsigned long long kind_alloc[TS_KIND_LAST + 1], kind_bytes[TS_KIND_LAST + 1];
  unsigned long long kind_scan[TS_KIND_LAST + 1], mark_edges, mark_old_edges;
  unsigned long long kind_minor_elements[TS_KIND_LAST + 1];
  unsigned long long minor_root_slots, minor_remembered_cells;
  unsigned long long remset_slot_writes, remset_full_marks, remset_precise_scans, remset_precise_slots, remset_full_scans, remset_full_slots;
  unsigned long long small_props_fresh, small_props_reused;
  unsigned long long prop_add_hits, prop_add_fills, prop_add_site_hits;   /* additions: global cache hits, slow fills, per-site entry hits */
  unsigned long long pic_get_absent, pic_get_inherited, pic_absent_hits, absent_site_hits;
  unsigned long long array_sparse_convert, array_sparse_put, array_densify;   /* far stores: dense->sparse switches, side-table stores, sparse->dense */   /* out-of-line reads resolved on the chain / missing / answered by the absent cache */
  unsigned long long young_alloc;
  unsigned long long call_env_malloc, construct_malloc;
  unsigned long long call_env_hist[9], call_env_slots;
  unsigned long long concat_calls, concat_bytes;
  unsigned long long sb_extend, sb_fresh, sb_flat, short_string;
  unsigned long long intern_calls, intern_probes;
  unsigned long long map_find_calls, map_find_probes, map_find_hist[9];
  unsigned long long find_prop_calls, find_prop_probes, find_prop_hist[9];
  unsigned long long class_reg_calls, class_reg_probes, class_reg_hist[9];
  unsigned long long class_field_calls, class_field_hits;
  unsigned long long location_probes, location_hits, location_collisions;
} g_rt_stats;
/* GC v2 slice G0 (docs/gc_v2_design.md): statistics for the redesign. Fates:
   a dying young cell, a young survivor kept young (aging), a promotion, a
   dying old cell, an old cell alive at exit. Payloads: the malloc'd buffers a
   cell owns, counted at each fate with their capacity in bytes. */
enum { G0_DEAD_YOUNG, G0_AGED, G0_PROMOTED, G0_DEAD_OLD, G0_RESIDENT_OLD, G0_FATE_N };
enum { G0_P_VALS, G0_P_DICT, G0_P_INDEX, G0_P_ELEMS, G0_P_SPARSE, G0_P_ENV, G0_P_MAP, G0_P_SET, G0_P_OTHER, G0_P_N };
#define G0_GRANULES 257u   /* 16-byte granules up to 4096 B; the last bucket holds larger cells */
static unsigned long long g0_cells[G0_FATE_N][TS_KIND_LAST + 1], g0_cell_bytes[G0_FATE_N][TS_KIND_LAST + 1];
static unsigned long long g0_owner_cells[G0_FATE_N][TS_KIND_LAST + 1];
static unsigned long long g0_payload_n[G0_FATE_N][G0_P_N], g0_payload_bytes[G0_FATE_N][G0_P_N];
static unsigned long long g0_alloc_gran[TS_KIND_LAST + 1][G0_GRANULES], g0_resident_gran[TS_KIND_LAST + 1][G0_GRANULES];
static unsigned long long g0_minor_ns[6], g0_full_ns[6];
static unsigned long long g0_rem_enroll, g0_proto_materialized, g0_pretenured_bytes;
static void g0_count_fate(ts_gc_header* h, int fate);
static void g0_dump(FILE* out);
/* TSAOT_G0_FATES=0 skips the per-cell fate accounting, so the phase timings
   are not inflated by it (one run for counts, one for timings). */
static int g0_fates_on(void){
  static int on = -1;
  if (on < 0){ const char* e = getenv("TSAOT_G0_FATES"); on = !(e && e[0] == '0'); }
  return on;
}
static inline unsigned g0_gran(size_t sz){ size_t g = (sz + 15u) >> 4; return g < G0_GRANULES - 1u ? (unsigned)g : G0_GRANULES - 1u; }
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
  fprintf(out, "[rt_stats] alloc: count=%llu bytes=%llu young_log_cap=%zu root_push=%llu pretenured=%llu\n",
          g_rt_stats.alloc_count, g_rt_stats.alloc_bytes,
          g_young_log_cap, g_rt_stats.root_push, g_rt_stats.pretenured_alloc);
  fprintf(out, "[rt_stats] small_props: fresh=%llu reused=%llu\n",
          g_rt_stats.small_props_fresh, g_rt_stats.small_props_reused);
  fprintf(out, "[rt_stats] prop_add: site_hits=%llu hits=%llu slow=%llu\n",
          g_rt_stats.prop_add_site_hits, g_rt_stats.prop_add_hits, g_rt_stats.prop_add_fills);
  fprintf(out, "[rt_stats] pic_ool_get: inherited=%llu absent=%llu absent_cache_hits=%llu\n",
          g_rt_stats.pic_get_inherited, g_rt_stats.pic_get_absent, g_rt_stats.pic_absent_hits);
  fprintf(out, "[rt_stats] absent_site: hits=%llu\n", g_rt_stats.absent_site_hits);
  fprintf(out, "[rt_stats] root_frames: frame_push=%llu\n",
          g_ts_frame_push_count);
  fprintf(out, "[rt_stats] array_sparse: convert=%llu put=%llu densify=%llu\n",
          g_rt_stats.array_sparse_convert, g_rt_stats.array_sparse_put, g_rt_stats.array_densify);
  {
    {
      /* slot distribution of the static read misses, top keys */
      for (int rank = 0; rank < 16; rank++){
        uint32_t best = 0; unsigned long long bv = 0;
        for (uint32_t k = 0; k < TS_RT_KEY_HIST; k++) if (g_ts_key_static_get_miss[k] > bv && !(g_ts_static_miss_slot[k * 18u + 0] == (unsigned long long)-1)){ bv = g_ts_key_static_get_miss[k]; best = k; }
        if (!bv) break;
        const char* nm = ts_field_name(best);
        fprintf(out, "[rt_stats] static_miss_slots %s=%llu:", nm ? nm : "?", bv);
        for (uint32_t i = 0; i < 18u; i++) if (g_ts_static_miss_slot[best * 18u + i]) fprintf(out, " %s%u=%llu", i == 16u ? "other" : i == 17u ? "nonobj" : "s", i < 16u ? i : 0u, g_ts_static_miss_slot[best * 18u + i]);
        fprintf(out, "\n");
        g_ts_static_miss_slot[best * 18u + 0] = (unsigned long long)-1;
      }
    }
    const char* names[8] = { "ool_get", "absent", "add", "inline_get", "inline_set", "static_get_miss", "static_set_miss", "prop_find" };
    unsigned long long* hists[8] = { g_key_ool_get, g_key_absent, g_key_add, g_ts_key_inline_get, g_ts_key_inline_set, g_ts_key_static_get_miss, g_ts_key_static_set_miss, g_key_prop_find };
    for (int hh = 0; hh < 8; hh++){
      unsigned long long* h = hists[hh];
      fprintf(out, "[rt_stats] keys_%s:", names[hh]);
      for (int rank = 0; rank < 30; rank++){
        uint32_t best = 0; unsigned long long bv = 0;
        for (uint32_t k = 0; k < TS_RT_KEY_HIST; k++) if (h[k] > bv){ bv = h[k]; best = k; }
        if (!bv) break;
        const char* nm = ts_field_name(best);
        fprintf(out, " %s=%llu", nm ? nm : "?", bv);
        h[best] = 0;
      }
      fprintf(out, "\n");
    }
  }
  for (unsigned k=TS_KIND_OBJECT; k<=TS_KIND_LAST; k++){
    if (g_rt_stats.kind_alloc[k] || g_rt_stats.kind_scan[k])
      fprintf(out, "[rt_stats] kind_%u: alloc=%llu bytes=%llu scanned=%llu minor_elements=%llu\n", k,
              g_rt_stats.kind_alloc[k], g_rt_stats.kind_bytes[k], g_rt_stats.kind_scan[k],
              g_rt_stats.kind_minor_elements[k]);
  }
  fprintf(out, "[rt_stats] mark: edges=%llu old_edges=%llu minor_root_slots=%llu minor_remembered_cells=%llu\n",
          g_rt_stats.mark_edges, g_rt_stats.mark_old_edges,
          g_rt_stats.minor_root_slots, g_rt_stats.minor_remembered_cells);
  fprintf(out, "[rt_stats] remset: slot_writes=%llu full_marks=%llu precise_scans=%llu precise_slots=%llu full_scans=%llu full_slots=%llu\n",
          g_rt_stats.remset_slot_writes, g_rt_stats.remset_full_marks, g_rt_stats.remset_precise_scans,
          g_rt_stats.remset_precise_slots, g_rt_stats.remset_full_scans, g_rt_stats.remset_full_slots);
  fprintf(out, "[rt_stats] young: alloc=%llu fresh_bytes=%zu | live_bytes=%zu full_next=%zu\n",
          g_rt_stats.young_alloc, g_young_fresh_bytes, g_heap_bytes, g_full_threshold_bytes);
  fprintf(out, "[rt_stats] ts_call env_malloc=%llu construct_malloc=%llu | concat: calls=%llu bytes=%llu\n",
          g_rt_stats.call_env_malloc, g_rt_stats.construct_malloc,
          g_rt_stats.concat_calls, g_rt_stats.concat_bytes);
  fprintf(out, "[rt_stats] call_env: slots=%llu hist(1,2,4,...,256+)=[", g_rt_stats.call_env_slots);
  for (int i=0;i<9;i++) fprintf(out, "%s%llu", i?",":"", g_rt_stats.call_env_hist[i]);
  fprintf(out, "]\n");
  fprintf(out, "[rt_stats] string_builder: extend=%llu fresh=%llu flat=%llu short=%llu\n",
          g_rt_stats.sb_extend, g_rt_stats.sb_fresh, g_rt_stats.sb_flat,
          g_rt_stats.short_string);
  rt_stats_hist_line(out, "map_find", g_rt_stats.map_find_calls, g_rt_stats.map_find_probes, g_rt_stats.map_find_hist);
  rt_stats_hist_line(out, "find_prop", g_rt_stats.find_prop_calls, g_rt_stats.find_prop_probes, g_rt_stats.find_prop_hist);
  rt_stats_hist_line(out, "class_reg", g_rt_stats.class_reg_calls, g_rt_stats.class_reg_probes, g_rt_stats.class_reg_hist);
  fprintf(out, "[rt_stats] class_field_cache: calls=%llu hits=%llu\n", g_rt_stats.class_field_calls, g_rt_stats.class_field_hits);
  fprintf(out, "[rt_stats] location_cache: probes=%llu hits=%llu collisions=%llu\n",
          g_rt_stats.location_probes, g_rt_stats.location_hits, g_rt_stats.location_collisions);
  for (uint32_t i = 0; i < g_rt_full_trace_len; i++)
    fprintf(out, "[rt_stats] full_gc #%u: before=%zu after=%zu next=%zu pause_ms=%.2f\n", i + 1u,
            g_rt_full_trace[i].before, g_rt_full_trace[i].after, g_rt_full_trace[i].next,
            (double)g_rt_full_trace[i].pause_ns / 1e6);
  fprintf(out, "[rt_stats] static_slots: get_hit=%llu get_miss=%llu set_hit=%llu set_miss=%llu learned=%llu | shapes=%u\n",
          g_ts_static_get_hit, g_ts_static_get_miss, g_ts_static_set_hit, g_ts_static_set_miss, g_ts_static_learned, g_next_shape);
  fprintf(out, "[rt_stats] prop_pic: get=%llu hit=%llu (%.1f%%) set=%llu hit=%llu (%.1f%%)\n",
          g_ts_pic_get_calls, g_ts_pic_get_hits,
          g_ts_pic_get_calls ? 100.0*(double)g_ts_pic_get_hits/(double)g_ts_pic_get_calls : 0.0,
          g_ts_pic_set_calls, g_ts_pic_set_hits,
          g_ts_pic_set_calls ? 100.0*(double)g_ts_pic_set_hits/(double)g_ts_pic_set_calls : 0.0);
  fprintf(out, "[rt_stats] pic_paths: entry0=%llu entry1=%llu entry2=%llu entry3=%llu keyval=%llu ool_get=%llu\n",
          g_ts_pic_entry_hits[0], g_ts_pic_entry_hits[1], g_ts_pic_entry_hits[2], g_ts_pic_entry_hits[3], g_ts_pic_keyval_hits, g_ts_pic_ool_hits);
  fprintf(out, "[rt_stats] inline_slots: shape-hit reads inline=%llu external=%llu (%.1f%% inline)\n",
          g_ts_slot_inline_hits, g_ts_slot_external_hits,
          (g_ts_slot_inline_hits + g_ts_slot_external_hits)
            ? 100.0*(double)g_ts_slot_inline_hits/(double)(g_ts_slot_inline_hits + g_ts_slot_external_hits) : 0.0);
  fprintf(out, "[rt_stats] intern: calls=%llu avg_probe=%.2f\n",
          g_rt_stats.intern_calls,
          g_rt_stats.intern_calls ? (double)g_rt_stats.intern_probes/(double)g_rt_stats.intern_calls : 0.0);
  g0_dump(out);
  if (out != stderr) fclose(out);
}
#define RT_STAT_INC(f)     (g_rt_stats.f++)
#define RT_STAT_ADD(f,n)   (g_rt_stats.f += (unsigned long long)(n))
#define RT_STAT_HIST(f,n)  (g_rt_stats.f[rt_stats_bucket((unsigned long long)(n))]++)
#define RT_STAT_GC_T0      uint64_t rt_stats_t0_ = rt_stats_now_ns()
#define RT_STAT_GC_T1      do { uint64_t rt_d_ = rt_stats_now_ns() - rt_stats_t0_; \
                             g_rt_stats.gc_pause_ns += rt_d_; \
                             if (rt_d_ > g_rt_stats.gc_pause_max_ns) g_rt_stats.gc_pause_max_ns = rt_d_; } while (0)
#define G0_ALLOC(kind, sz) (g0_alloc_gran[(kind) <= TS_KIND_LAST ? (kind) : 0][g0_gran(sz)]++)
#define G0_FATE(h, fate)   (g0_fates_on() ? g0_count_fate((h), (fate)) : (void)0)
#define G0_INC(x)          ((x)++)
#define G0_ADD(x, n)       ((x) += (unsigned long long)(n))
#define G0_T0              uint64_t g0_t_ = rt_stats_now_ns()
#define G0_PHASE(arr, i)   do { uint64_t g0_n_ = rt_stats_now_ns(); (arr)[i] += g0_n_ - g0_t_; g0_t_ = g0_n_; } while (0)
#else
#define RT_STAT_INC(f)     ((void)0)
#define RT_STAT_ADD(f,n)   ((void)0)
#define RT_STAT_KEY(arr, key) ((void)0)
#define RT_STAT_HIST(f,n)  ((void)0)
#define RT_STAT_GC_T0      ((void)0)
#define RT_STAT_GC_T1      ((void)0)
#define G0_ALLOC(kind, sz) ((void)0)
#define G0_FATE(h, fate)   ((void)0)
#define G0_INC(x)          ((void)0)
#define G0_ADD(x, n)       ((void)0)
#define G0_T0              ((void)0)
#define G0_PHASE(arr, i)   ((void)0)
#endif

/* The collector uses a mark/sweep full GC and a generational minor GC. Minor GC
   relocates movable young survivors through stable handles; full GC remains
   mark/sweep. Keep fixed minimum byte headroom for ephemeral churn, and after
   each full collection retarget the next trigger from the live byte size. */
#define TS_GC_MIN_FULL_BYTES ((size_t)4u * 1024u * 1024u)

static inline int ts_heap_ref(tsv v){ return ts_is_obj(v)||ts_is_func(v)||ts_is_heap_str(v); }
/* Every cell kind, the last one included: an old Proxy referenced only in
   the old-pointer form was skipped by a full collection's marking and freed
   while live. */
static inline int gc_kind_valid(uint8_t k){
  return k >= TS_KIND_OBJECT && k <= TS_KIND_LAST;
}
#ifdef TSAOT_STACK_CHECK
/* Stack check (docs/stack_check_design.md): the emitted code allocates every
   Stack object in this never-reused quarantine, preceded by its record; an
   activation's records die when it returns (ts_sc_leave, a cleanup attribute)
   or is unwound (ts_throw), and a dead object reached outside a minor
   collection is reported. Minor collections also scan unreachable old cells
   of the remembered set, so there a dead object is only skipped. */
#include <sys/mman.h>
typedef struct ts_sc_rec {
  uint64_t magic;
  uint32_t site, dead;
  const char* fn;
  uint64_t act;
  size_t size;
  uint32_t raw, pad;
} ts_sc_rec;
#define TS_SC_MAGIC 0x53544b4351524e54ull
#define TS_SC_REGION ((size_t)16u << 30)
static char* g_sc_base;
static char* g_sc_top;
static char* g_sc_end;
static ts_sc_rec** g_sc_live;
static size_t g_sc_len, g_sc_cap;
static uint64_t g_sc_next_act = 1, g_sc_cur_act = 0;
static int g_sc_minor;
static int g_sc_continue = -1;
/* TSAOT_STACK_CHECK_FULL_EVERY=N: a full collection after every N minor ones,
   so a dangling reference dropped before the next scheduled full collection
   is still seen by one. */
static unsigned g_sc_full_every, g_sc_minors_since_full;
static unsigned long long g_sc_reports;
static uint32_t* g_sc_reported_sites;
static size_t g_sc_reported_len, g_sc_reported_cap;
void ts_gc_collect(void);
static void sc_atexit(void){
  if (!g_sc_base) return;
  ts_gc_collect();
  if (g_sc_reports)
    fprintf(stderr, "[stack-check] %llu report(s) at %zu site(s)\n", g_sc_reports, g_sc_reported_len);
}
static void sc_init(void){
  void* m = mmap(NULL, TS_SC_REGION, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
  if (m == MAP_FAILED){ fprintf(stderr, "[stack-check] cannot reserve the quarantine\n"); abort(); }
  g_sc_base = g_sc_top = (char*)m;
  g_sc_end = g_sc_base + TS_SC_REGION;
  const char* c = getenv("TSAOT_STACK_CHECK_CONTINUE");
  g_sc_continue = (c && *c && *c != '0') ? 1 : 0;
  const char* fe = getenv("TSAOT_STACK_CHECK_FULL_EVERY");
  g_sc_full_every = fe ? (unsigned)strtoul(fe, NULL, 10) : 0u;
  atexit(sc_atexit);
}
static inline int sc_in_quarantine(const void* p){
  return (const char*)p >= g_sc_base && (const char*)p < g_sc_top;
}
static void* sc_alloc(size_t size, uint32_t site, const char* fn, uint32_t raw){
  if (!g_sc_base) sc_init();
  size_t need = sizeof(ts_sc_rec) + ((size + 15u) & ~(size_t)15u);
  if ((size_t)(g_sc_end - g_sc_top) < need){ fprintf(stderr, "[stack-check] quarantine exhausted\n"); abort(); }
  ts_sc_rec* r = (ts_sc_rec*)g_sc_top;
  g_sc_top += need;
  r->magic = TS_SC_MAGIC; r->site = site; r->dead = 0; r->fn = fn;
  r->act = g_sc_cur_act; r->size = size; r->raw = raw; r->pad = 0;
  if (g_sc_len == g_sc_cap){
    g_sc_cap = g_sc_cap ? g_sc_cap * 2 : 4096;
    g_sc_live = (ts_sc_rec**)realloc(g_sc_live, g_sc_cap * sizeof(*g_sc_live));
  }
  g_sc_live[g_sc_len++] = r;
  return (void*)(r + 1);
}
void* ts_sc_alloc(size_t size, uint32_t site, const char* fn){ return sc_alloc(size, site, fn, 0); }
unsigned long long ts_sc_report_count(void){ return g_sc_reports; }
void* ts_sc_alloc_raw(size_t size, uint32_t site, const char* fn){ return sc_alloc(size, site, fn, 1); }
/* Death: the payload a program could still read through a dangling reference
   becomes 0xDB bytes (a double, never a heap reference). The cell header (and a
   class instance's object header, a function's code and env pointer) stays, so
   the collector can still reach and identify it. */
static void sc_kill(ts_sc_rec* r){
  r->dead = 1;
  char* obj = (char*)(r + 1);
  size_t from = 0;
  if (!r->raw){
    uint8_t kind = ((ts_gc_header*)obj)->kind;
    from = kind == TS_KIND_OBJECT ? sizeof(ts_obj_common) : r->size;
  }
  if (from < r->size) memset(obj + from, 0xDB, r->size - from);
}
ts_sc_act ts_sc_enter(void){
  ts_sc_act a;
  a.prev = g_sc_cur_act;
  a.id = g_sc_next_act++;
  g_sc_cur_act = a.id;
  return a;
}
void ts_sc_leave(ts_sc_act* a){
  while (g_sc_len && g_sc_live[g_sc_len - 1]->act == a->id) sc_kill(g_sc_live[--g_sc_len]);
  g_sc_cur_act = a->prev;
}
/* ts_throw: the activations after the handler's are unwound without their
   cleanups; their records are the top of the live stack. */
static void sc_unwind_to(uint64_t act){
  while (g_sc_len && g_sc_live[g_sc_len - 1]->act > act) sc_kill(g_sc_live[--g_sc_len]);
  g_sc_cur_act = act;
}
static void sc_report(ts_sc_rec* r){
  g_sc_reports++;
  for (size_t i = 0; i < g_sc_reported_len; i++) if (g_sc_reported_sites[i] == r->site) return;
  if (g_sc_reported_len == g_sc_reported_cap){
    g_sc_reported_cap = g_sc_reported_cap ? g_sc_reported_cap * 2 : 64;
    g_sc_reported_sites = (uint32_t*)realloc(g_sc_reported_sites, g_sc_reported_cap * sizeof(uint32_t));
  }
  g_sc_reported_sites[g_sc_reported_len++] = r->site;
  fflush(stdout);
  fprintf(stderr, "[stack-check] site %u (%s): a stack object is reachable after its frame returned\n",
          r->site, r->fn ? r->fn : "?");
  fflush(stderr);
  if (!g_sc_continue) abort();
}
/* A stack-tagged pointer into the quarantine: NULL for a dead cell (reported
   unless a minor collection is scanning possibly unreachable old cells). */
static ts_gc_header* sc_quarantine_ptr(ts_gc_header* h){
  ts_sc_rec* r = (ts_sc_rec*)h - 1;
  if (r->magic != TS_SC_MAGIC) return NULL;
  if (r->dead){
    if (!g_sc_minor) sc_report(r);
    return NULL;
  }
  return (h->gen == TS_GEN_NONHEAP && gc_kind_valid(h->kind)) ? h : NULL;
}
#endif
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
  if (payload & TS_PTR_STACK_TAG){
    ts_gc_header* h = (ts_gc_header*)(uintptr_t)(payload & ~TS_PTR_STACK_TAG);
#ifdef TSAOT_STACK_CHECK
    if (sc_in_quarantine(h)) return sc_quarantine_ptr(h);
#endif
    if (!gc_direct_stack_plausible(h) || !gc_direct_header_readable(h)) return NULL;
    return (h->gen == TS_GEN_NONHEAP && gc_kind_valid(h->kind)) ? h : NULL;
  }
  /* a heap cell: in the cage, 16-byte aligned */
  ts_gc_header* h = (ts_gc_header*)(uintptr_t)payload;
  if (!gc_payload_in_cage(h) || (payload & 0xFu) != 0) return NULL;
  return (gc_kind_valid(h->kind) && h->gen <= TS_GEN_OLD) ? h : NULL;
}
static tsv ts_string_slice_copy(tsv src, uint32_t start, uint32_t len);
static tsv ts_string_slice_view(tsv src, uint32_t start, uint32_t len);
static char* ts_string_cstr_copy(tsv src, uint32_t* out_len);
static char* ts_string_key_bytes_copy(tsv src, uint32_t* out_len);
static char* ts_str_key_bytes_copy_view(ts_strview x, uint32_t* out_len);
static int ts_i64_to_str(long long v, char* buf);
static int ts_string_own_prop(tsv obj, ts_key key, tsv* out);
static int field_name_is(uint32_t id, const char* lit);
static int field_bytes_is(const char* n, uint32_t len, const char* lit);
static int prop_key_is_array_index(uint32_t key, uint32_t* idx);
static int g_gc_config_inited = 0;
static void gc_config_init(void){
  if (g_gc_config_inited) return;
  g_gc_config_inited = 1;
  const char* young = getenv("TSAOT_GC_YOUNG_THRESHOLD");
  if (young && young[0]){
    char* end = NULL;
    unsigned long long v = strtoull(young, &end, 10);
    if (end != young) g_young_threshold = (size_t)(v ? v : 1);
  }
  const char* nbytes = getenv("TSAOT_GC_NURSERY_BYTES");
  if (nbytes && nbytes[0]){
    char* end = NULL;
    unsigned long long v = strtoull(nbytes, &end, 10);
    if (end != nbytes && v) g_young_cap_bytes = (size_t)v;
    if (g_young_cap_bytes < ((size_t)256u << 10)) g_young_cap_bytes = (size_t)256u << 10;
  }
  g_payload_budget_bytes = g_young_cap_bytes * 16u;
  const char* pbudget = getenv("TSAOT_GC_PAYLOAD_BUDGET_BYTES");
  if (pbudget && pbudget[0]){
    char* end = NULL;
    unsigned long long v = strtoull(pbudget, &end, 10);
    if (end != pbudget && v) g_payload_budget_bytes = (size_t)v;
  }
  /* Full-GC byte threshold override (B-3). Mainly a stress/tuning knob: a tiny
     value forces frequent full collections the way TSAOT_GC_YOUNG_THRESHOLD=1
     forces minors. The retarget rule still applies after each full GC. */
  const char* pre = getenv("TSAOT_PRETENURE_CTORS");
  if (pre && pre[0] && strcmp(pre, "0") == 0) g_pretenure_ctors = 0;
  const char* fbytes = getenv("TSAOT_GC_FULL_THRESHOLD_BYTES");
  if (fbytes && fbytes[0]){
    char* end = NULL;
    unsigned long long v = strtoull(fbytes, &end, 10);
    if (end != fbytes && v){ g_full_threshold_bytes = (size_t)v; g_full_threshold_forced = 1; }
  }
  const char* rslots = getenv("TSAOT_REMEMBERED_SLOTS");
  if (rslots && rslots[0] && strcmp(rslots, "0") == 0) g_remembered_slots = 0;
  const char* eplain = getenv("TSAOT_EMPTY_CLASS_PLAIN");
  if (eplain && eplain[0] && strcmp(eplain, "0") == 0) g_empty_class_plain = 0;
  const char* kc = getenv("TSAOT_KEY_CACHES");
  if (kc && kc[0] && strcmp(kc, "0") == 0) g_key_caches = 0;
  const char* npic = getenv("TSAOT_NEGATIVE_PIC");
  if (npic && npic[0] && strcmp(npic, "0") == 0) g_negative_pic = 0;
  const char* asite = getenv("TSAOT_ABSENT_SITE");
  if (asite && asite[0] && strcmp(asite, "0") == 0) g_absent_site = 0;
  const char* sparse = getenv("TSAOT_SPARSE_ELEMENTS");
  if (sparse && sparse[0] && strcmp(sparse, "0") == 0) g_sparse_elements = 0;
  const char* protect = getenv("TSAOT_GC_PROTECT");
  if (protect && protect[0] && strcmp(protect, "0") != 0){
    unsigned long v = strtoul(protect, NULL, 10);
    g_gc_protect = (uint32_t)(v > 1 ? v : 64u);
  }
  const char* zap = getenv("TSAOT_GC_ZAP");
  if (zap && zap[0] && strcmp(zap, "0") != 0) g_gc_zap = 1;
  if (g_gc_zap || g_gc_protect) g_young_log_kinds = ~0u;   /* dead cells are zapped or quarantined */
}
tsv ts_heap_ref_value(uint16_t sel, void* p){
  if (!p) return TS_BOX(sel, 0);
  ts_gc_header* h = (ts_gc_header*)p;
  if (h->gen == TS_GEN_NONHEAP) return TS_BOX(sel, (uintptr_t)p | TS_PTR_STACK_TAG);
  return TS_BOX(sel, (uintptr_t)p);
}
/* Every young survivor is promoted at the next collection, so an old cell
   stays in the remembered set for exactly one cycle: the byte is a flag. */
static void gc_remember(ts_gc_header* h){
  if (!h || h->gen != TS_GEN_OLD) return;
  if (h->kind == TS_KIND_OBJECT && h->hdr_spare == 0) h->hdr_spare = 0xFF; /* no range known: every slot */
  if (h->remembered) return;
  if (g_rem_len == g_rem_cap){
    g_rem_cap = g_rem_cap ? g_rem_cap * 2 : 1024;
    g_remset = (ts_gc_header**)realloc(g_remset, sizeof(ts_gc_header*) * g_rem_cap);
  }
  h->remembered = 1;
  g_remset[g_rem_len++] = h;
  G0_INC(g0_rem_enroll);
}
void ts_gc_remember(ts_gc_header* h){
  if (h && h->gen == TS_GEN_OLD && h->kind == TS_KIND_ARRAY)
    ((ts_array*)h)->gc_dirty_all = 1;
  else if (h && h->gen == TS_GEN_OLD && h->kind == TS_KIND_MAP)
    ((ts_map*)h)->gc_dirty_all = 1;
  else if (h && h->gen == TS_GEN_OLD && h->kind == TS_KIND_OBJECT){
    RT_STAT_INC(remset_full_marks);
    h->hdr_spare = 0xFF;
  }
  gc_remember(h);
}
/* A write at a known slot of an old plain object: merge the slot's card
   (eight slots per card, fifteen cards covered) into the header's dirty range
   — high nibble first card, low nibble end card (exclusive), 0xFF every slot. */
void ts_gc_remember_slot(ts_gc_header* h, uint32_t slot){
  if (!h || h->gen != TS_GEN_OLD) return;
  if (h->kind == TS_KIND_OBJECT && g_remembered_slots){
    RT_STAT_INC(remset_slot_writes);
    uint32_t card = slot >> 3;
    uint8_t cur = h->hdr_spare;
    if (card >= 15u || cur == 0xFF){
      h->hdr_spare = 0xFF;
    } else {
      uint32_t first = cur ? (cur >> 4) : card;
      uint32_t end = cur ? (cur & 0xF) : 0;
      if (card < first) first = card;
      if (card + 1u > end) end = card + 1u;
      h->hdr_spare = (uint8_t)((first << 4) | end);
    }
  } else if (h->kind == TS_KIND_OBJECT){
    h->hdr_spare = 0xFF;
  }
  gc_remember(h);
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
  if (n <= 0) return;
  int target = g_root_len - n;
  if (target < 0) target = 0;
  /* The collector scans only [0, g_root_len). A later push overwrites the
     inactive suffix, so clearing every popped pointer is redundant hot-path
     work (and can touch dozens of cache lines on each generated return). */
  g_root_len = target;
}
int  ts_gc_root_depth(void){ return g_root_len; }
void ts_gc_set_root_depth(int n){
  if (n < 0) n = 0;
  if (n >= g_root_len) return;
  g_root_len = n;
}
void ts_frame_restore(ts_frame_hdr* frame){ g_ts_frame_top = frame; }

static inline void gc_before_alloc(void){
  if (TS_RT_UNLIKELY(!g_gc_config_inited)) gc_config_init();
  if (g_young_new_since_minor>=g_young_threshold || g_young_fresh_bytes>=g_young_cap_bytes ||
      g_payload_fresh_bytes>=g_payload_budget_bytes)
    ts_gc_collect_young();
#ifdef TSAOT_STACK_CHECK
  if (g_sc_full_every && g_sc_minors_since_full >= g_sc_full_every){
    g_sc_minors_since_full = 0;
    ts_gc_collect();
  }
#endif
  if (g_heap_bytes>=g_full_threshold_bytes){
    size_t before = g_heap_bytes;
#ifdef TSAOT_RT_STATS
    uint64_t pause_before = g_rt_stats.gc_pause_ns;
#endif
    ts_gc_collect();
    if (!g_full_threshold_forced){
      /* Full-collection pacing (docs/full_gc_pacing_design.md): the next full
         collection when the heap has doubled its live bytes, or quadrupled
         when this one reclaimed less than a quarter of the heap: a heap that
         is mostly live keeps growing, and collecting it again soon only marks
         it again (the compiler ran six full collections per compile, the
         last ones marking 250-480 MB of live data for little garbage). */
      size_t live = g_heap_bytes;
      size_t reclaimed = before > live ? before - live : 0;
      size_t factor = (reclaimed * 4u < before) ? 4u : 2u;
      /* The safety valve of the pretenured constructions: an old generation
         that was mostly garbage means the constructed objects die young. */
      if (reclaimed * 2u > before) g_pretenure_ctors = 0;
      size_t next = live * factor;
      size_t with_headroom = live + TS_GC_MIN_FULL_BYTES;
      if (next < with_headroom) next = with_headroom;
      if (next < TS_GC_MIN_FULL_BYTES) next = TS_GC_MIN_FULL_BYTES;
      g_full_threshold_bytes = next;
#ifdef TSAOT_RT_STATS
      if (g_rt_full_trace_len < 32u){
        g_rt_full_trace[g_rt_full_trace_len].before = before;
        g_rt_full_trace[g_rt_full_trace_len].after = live;
        g_rt_full_trace[g_rt_full_trace_len].next = next;
        g_rt_full_trace[g_rt_full_trace_len].pause_ns = g_rt_stats.gc_pause_ns - pause_before;
        g_rt_full_trace_len++;
      }
#endif
    }
  }
}
static void gc_account_alloc(size_t sz){
  RT_STAT_INC(alloc_count); RT_STAT_ADD(alloc_bytes, sz);
  g_heap_bytes += sz;
}
static void* gc_alloc(size_t sz, uint8_t kind){
  gc_before_alloc();
  gc_account_alloc(sz);
  G0_ALLOC(kind, sz);
  RT_STAT_INC(kind_alloc[kind]); RT_STAT_ADD(kind_bytes[kind], sz);
  ts_gc_header* h = (ts_gc_header*)gc_cell_alloc(sz, 0);
  h->kind=kind; h->gen=TS_GEN_YOUNG; h->size=sz;
  if (TS_RT_UNLIKELY(((g_young_log_kinds >> kind) & 1u) || sz > GC_PAYLOAD_SMALL_MAX)) gc_young_log_push(h);
  g_young_fresh_bytes += sz;
  g_young_new_since_minor++;
  RT_STAT_INC(young_alloc);
  return h;
}
/* Escape-proven long-lived allocation. The cell starts in the old generation
   and therefore skips the young log and promotion. Callers must
   use the normal write barrier while initializing any young references in the
   new cell; the public pretenured constructors below enforce that for their
   direct proto/env stores. */
static void* gc_alloc_pretenured(size_t sz, uint8_t kind){
  gc_before_alloc();
  gc_account_alloc(sz);
  G0_ALLOC(kind, sz); G0_ADD(g0_pretenured_bytes, sz);
  RT_STAT_INC(kind_alloc[kind]); RT_STAT_ADD(kind_bytes[kind], sz);
  ts_gc_header* h = (ts_gc_header*)gc_cell_alloc(sz, 1);
  h->kind=kind; h->gen=TS_GEN_OLD; h->size=sz;
  g_old_bytes += sz;
  RT_STAT_INC(pretenured_alloc);
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
static tsv g_weakmap_proto_v = TS_NULL; /* unified model: WeakMap.prototype */
static tsv g_weakset_proto_v = TS_NULL; /* unified model: WeakSet.prototype */
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
static void ts_root_static_once(tsv* slot, int* rooted){
  if (*rooted) return;
  /* Lazy runtime caches must not enter the caller's LIFO root stack. */
  if (g_static_root_len == g_static_root_cap){
    g_static_root_cap = g_static_root_cap ? g_static_root_cap * 2 : 32;
    g_static_roots = realloc(g_static_roots, sizeof(tsv*) * g_static_root_cap);
  }
  g_static_roots[g_static_root_len++] = slot;
  *rooted = 1;
}
static void ts_proto_register_method(tsv proto, ts_key method_key, const char* name, ts_code fn);
static tsv ts_new_object_impl(int pretenured, uint32_t slots){
  if (slots > TS_INLINE_SLOTS_MAX) slots = TS_INLINE_SLOTS_MAX;
  size_t size = sizeof(ts_object) + sizeof(tsv) * (size_t)slots;
  ts_object* o = pretenured
    ? gc_alloc_pretenured(size, TS_KIND_OBJECT)
    : gc_alloc(size, TS_KIND_OBJECT);
  o->h.inline_cap = (uint8_t)slots;
  o->proto = ts_proto_ref(g_object_proto_v) ? g_object_proto_v : TS_NULL;
  o->shape = TS_SHAPE_EMPTY;
  tsv obj = ts_obj(o);
  if (pretenured) ts_write_barrier(obj, o->proto);
  return obj;
}
tsv ts_new_object(void){ return ts_new_object_impl(0, TS_INLINE_SLOTS_DEFAULT); }
tsv ts_new_object_pretenured(void){ return ts_new_object_impl(1, TS_INLINE_SLOTS_DEFAULT); }
tsv ts_new_object_n(uint32_t slots){ return ts_new_object_impl(0, slots); }
tsv ts_new_object_n_pretenured(uint32_t slots){ return ts_new_object_impl(1, slots); }
static tsv ts_new_proto_impl(int pretenured){
  ts_object* o = pretenured
    ? gc_alloc_pretenured(sizeof(ts_object), TS_KIND_OBJECT)
    : gc_alloc(sizeof(ts_object), TS_KIND_OBJECT);
  o->shape = TS_SHAPE_EMPTY;
  return ts_obj(o);
}
tsv ts_new_proto(void){ return ts_new_proto_impl(0); }
tsv ts_new_proto_pretenured(void){ return ts_new_proto_impl(1); }
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
int g_typed_slow = 0;    /* declared in ts_rt.h; see ts_typed_slow there */
int g_closed_receivers = 0;
/* A foreign receiver can arise from here on. A closed program's typed
   accesses do not test the flag: the exporter's proof missed a route to this
   point, so stop loudly rather than read struct offsets of the wrong cell. */
static void typed_slow_stop(const char* what){
  fprintf(stderr, "garnet: internal error: %s in a program compiled with closed receivers "
                  "(docs/closed_receivers_design.md); recompile with TSAOT_CLOSED_RECEIVERS=0\n", what);
  abort();
}
static void typed_slow_raise(const char* what){
  if (g_closed_receivers) typed_slow_stop(what);
  g_typed_slow |= TS_TYPED_SLOW_ANY;
}
/* A class method may run with a foreign `this` from here on: its entry
   tests the receiver (ts_foreign_this_seen raises ANY when one arrives). */
static void typed_this_raise(const char* what){
  if (g_closed_receivers) typed_slow_stop(what);
  g_typed_slow |= TS_TYPED_SLOW_THIS;
}
void ts_foreign_this_seen(void){ typed_slow_raise("a class method ran with a foreign this"); }
static void typed_slow_check_relink(tsv obj, tsv proto);
static void typed_slow_check_borrow(tsv fn, tsv thisArg);
static void struct_methods_collect(tsv proto);
struct ts_class_reg;
static struct ts_class_reg* class_reg_for_proto(tsv proto);
/* Property-addition cache epoch (see prop_add_* near ts_set_pic). Bumped by
   anything that can change the result of an uncached add: accessor
   definitions, prototype relinks, class registrations and full collections
   (entries only name old prototypes, whose handles a minor cannot recycle). */
static void prop_add_epoch_bump(void);
static tsv ts_key_to_value(ts_key k);
/* User-symbol property keys store a compact sym_id. The side table is defined
   with the Symbol runtime below; property creation and GC scanning use it to
   recover the heap Symbol that the numeric key strongly denotes. */
static tsv sym_value_by_id(uint32_t sym_id);
static tsv ts_proxy_get_v(tsv pv, tsv keyv, tsv receiver);
static int ts_proxy_set_v(tsv pv, tsv keyv, tsv val, tsv receiver);
static int ts_proxy_has_v(tsv pv, tsv keyv);
static int ts_proxy_delete_v(tsv pv, tsv keyv);
static tsv ts_proxy_own_keys_arr(tsv pv);
static tsv ts_proxy_get_proto(tsv pv);
static tsv ts_proxy_set_proto(tsv pv, tsv proto);
/* Exotic links on a prototype chain (docs/proxy_prototype_chain_design.md):
   promise, coroutine and proxy cells do not begin with the common object
   header, so a chain walk tests a link's kind once and hands such a link to
   these instead of reading it as an object. */
#define chain_link_exotic(p) TS_RT_UNLIKELY((p)->h.kind >= TS_KIND_PROMISE)
static int chain_exotic_get(ts_object* p, ts_key key, tsv receiver, tsv* out, ts_object** next);
/* typed arrays (docs/typed_arrays_design.md), defined after the array methods */
static const uint8_t g_ta_size[TS_TA_COUNT] = { 1, 1, 1, 2, 2, 4, 4, 4, 8 };
static const char* const g_ta_name[TS_TA_COUNT] = {
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
  "Int32Array", "Uint32Array", "Float32Array", "Float64Array" };
static tsv ta_get_key(tsv obj, ts_key key);
static tsv ab_get_key(tsv obj, ts_key key);
static void ta_set_key(tsv obj, ts_key key, tsv val);
static int ta_numeric_key(ts_key key, uint32_t* idx);
static tsv ta_join(tsv t, tsv sepv);
static int chain_exotic_has(ts_object* p, ts_key key, int* res, ts_object** next);
static int chain_exotic_set(ts_object* p, ts_key key, tsv receiver, tsv val, ts_object** next);
static tsv chain_exotic_proto(tsv link);
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
    prop_add_epoch_bump();
  }
  return obj;
}
/* The prototype of an object the runtime has just allocated (an iterator, a
   generator object, a typed array, a host object). Nothing can have cached a
   decision about it: it is nobody's prototype yet, and the addition and
   absent-property caches key their receivers by shape and prototype, so,
   unlike a relink, no cache epoch moves. (Linking these through ts_set_proto
   emptied every addition and absent-property cache 197k times per compile of
   the compiler: once per Map iterator and generator object.) */
static void obj_link_fresh_proto(tsv obj, tsv proto){
  ts_object* o = ts_ptr(obj);
  o->proto = ts_proto_ref(proto) ? proto : TS_NULL;
  ts_write_barrier(obj, proto);
}
/* The user-level relink (Object.setPrototypeOf, Reflect.setPrototypeOf): the
   class setup, which links prototypes the same way, keeps ts_set_proto, so
   only a program's own relink of an object behind a class with struct fields
   raises g_typed_slow (docs/foreign_receivers_design.md). */
int g_class_relinked = 0;
static const uint32_t* g_class_index_tab = NULL;
static uint32_t g_class_index_n = 0;
/* class index word (index + 1) -> class id, for a relinked instance's layout */
static uint32_t* g_class_of_word = NULL;
static uint32_t g_class_of_word_n = 0;
void ts_register_class_indices(const uint32_t* tab, uint32_t n){
  g_class_index_tab = tab; g_class_index_n = n;
  uint32_t top = 0;
  for (uint32_t c = 0; c < n; c++) if (tab[c] > top) top = tab[c];
  free(g_class_of_word);
  g_class_of_word = (uint32_t*)calloc((size_t)top + 1u, sizeof(uint32_t));
  g_class_of_word_n = top + 1u;
  for (uint32_t c = 0; c < n; c++) if (tab[c]) g_class_of_word[tab[c]] = c + 1u;
}
tsv ts_set_proto_user(tsv obj, tsv proto){
  /* A sized instance relinked leaves its class's interval; a class's
     prototype relinked changes its instances' chains
     (docs/class_index_dispatch_design.md); other objects concern nobody. */
  if (ts_is_obj(obj)){
    ts_object* o = (ts_object*)ts_ptr(obj);
    if (o->proto == proto) return obj;   /* no change of chain */
    if (o->cls == TS_CLS_PROTO) g_class_relinked = 1;
    else if (o->cls) o->cls |= TS_CLS_RELINKED;
  }
  tsv r = ts_set_proto(obj, proto);
  if (!(g_typed_slow & TS_TYPED_SLOW_ANY) && !(g_has_proxies && ts_is_proxy(obj))) typed_slow_check_relink(obj, proto);
  return r;
}

/* ---- first-class callable values (methods + closures) ---- */
/* A heap closure's captured-environment buffer is a payload (G2a): it is
   released with the closure, without a visit, when a collection does not
   mark it. A stack closure borrows its caller's array (outside the cage). */
static tsv ts_make_fn_impl(ts_code code, tsv* env, uint32_t envlen, int pretenured){
  ts_func* f = pretenured
    ? gc_alloc_pretenured(sizeof(ts_func), TS_KIND_FUNC)
    : gc_alloc(sizeof(ts_func), TS_KIND_FUNC);
  f->o.proto = ts_proto_ref(g_function_proto_v) ? g_function_proto_v : TS_NULL;
  f->code = (void*)code;
  f->prototype_prop = TS_UNDEFINED;
  tsv fv = ts_func_v(f);
  if (pretenured) ts_write_barrier(fv, f->o.proto);
  if (env && envlen){
    f->env = (tsv*)gc_payload_alloc(sizeof(tsv) * (size_t)envlen, pretenured);
    for (uint32_t i=0;i<envlen;i++){
      f->env[i]=env[i];
      if (pretenured) ts_write_barrier(fv, env[i]);
    }
    f->envlen = envlen;
  } else { f->env = NULL; f->envlen = 0; }
  return fv;
}
tsv ts_make_fn(ts_code code, tsv* env, uint32_t envlen){
  return ts_make_fn_impl(code, env, envlen, 0);
}
/* variant recording whether the callee reads args[0] as `this` (for call/apply/bind). */
tsv ts_make_fn_t(ts_code code, tsv* env, uint32_t envlen, int takes_this){
  tsv fv = ts_make_fn_impl(code, env, envlen, 0);
  ((ts_func*)ts_ptr(fv))->takes_this = (uint8_t)(takes_this ? 1 : 0);
  return fv;
}
tsv ts_make_fn_t_pretenured(ts_code code, tsv* env, uint32_t envlen, int takes_this){
  tsv fv = ts_make_fn_impl(code, env, envlen, 1);
  ((ts_func*)ts_ptr(fv))->takes_this = (uint8_t)(takes_this ? 1 : 0);
  return fv;
}
tsv* g_ts_cur_env = NULL;
tsv ts_make_closure_t(ts_code code, tsv* env, uint32_t envlen, int takes_this){
  tsv fv = ts_make_fn_impl(code, env, envlen, 0);
  ts_func* f = (ts_func*)ts_ptr(fv);
  f->takes_this = (uint8_t)(takes_this ? 1 : 0);
  f->env_abi = (uint8_t)(envlen ? 1 : 0);
  return fv;
}
tsv ts_make_closure_t_pretenured(ts_code code, tsv* env, uint32_t envlen, int takes_this){
  tsv fv = ts_make_fn_impl(code, env, envlen, 1);
  ts_func* f = (ts_func*)ts_ptr(fv);
  f->takes_this = (uint8_t)(takes_this ? 1 : 0);
  f->env_abi = (uint8_t)(envlen ? 1 : 0);
  return fv;
}
void ts_init_fn_stack(ts_func* f, ts_code code, tsv* env, uint32_t envlen, int takes_this){
  memset(f, 0, sizeof(*f));
  f->o.h.kind = TS_KIND_FUNC;
  f->o.h.gen = TS_GEN_NONHEAP;
  f->o.h.size = sizeof(ts_func);
  f->o.proto = ts_proto_ref(g_function_proto_v) ? g_function_proto_v : TS_NULL;
  f->code = (void*)code;
  f->prototype_prop = TS_UNDEFINED;
  f->env = envlen ? env : NULL;
  f->envlen = envlen;
  f->env_abi = (uint8_t)(envlen ? 1 : 0);
  f->takes_this = (uint8_t)(takes_this ? 1 : 0);
}
void ts_set_fn_meta(tsv fn, uint32_t arity, const char* name){
  if (!ts_is_func(fn)) return;
  ts_func* f = ts_ptr(fn);
  f->arity = (uint16_t)(arity > 0xFFFFu ? 0xFFFFu : arity);
  f->name = name;
}
static ts_key fn_constructor_key(void){
  static ts_key k = 0xFFFFFFFFu;
  if (k == 0xFFFFFFFFu) k = ts_intern_field("constructor", 11);
  return k;
}
/* Install a FRESH prototype object (reachable only through fn). The own
   `constructor` property is defined lazily: every function declaration and
   expression creates one of these at closure-creation time, and the vast
   majority is never used as a constructor or read through `.prototype`.
   The property is materialized on the first observation of the prototype
   (ts_get, ts_construct, descriptor read), which is the only way program
   code can reach the object. No allocation happens here, so no roots. */
void ts_set_fn_prototype(tsv fn, tsv proto){
  if (!ts_is_func(fn)) return;
  ts_func* f = (ts_func*)ts_ptr(fn);
  f->prototype_prop = proto;
  f->constructable = 1;   /* own .prototype <=> ES5 [[Construct]] */
  f->ctor_pending = (uint8_t)(ts_is_obj(proto) ? 1 : 0);
  f->proto_lazy = 0;
  ts_write_barrier(fn, proto);
}
/* Same ownership semantics as ts_set_fn_prototype(fn, ts_new_proto()), but
   the prototype object is not allocated until something can observe it. */
void ts_set_fn_prototype_lazy(tsv fn){
  if (!ts_is_func(fn)) return;
  ts_func* f = (ts_func*)ts_ptr(fn);
  f->prototype_prop = TS_UNDEFINED;
  f->constructable = 1;
  f->ctor_pending = 0;
  f->proto_lazy = 1;
}
/* An own `.prototype` exists while the slot holds an object or is pending. */
static inline int fn_has_own_prototype(const ts_func* f){
  return !ts_is_undef(f->prototype_prop) || f->proto_lazy;
}
/* Create the pending prototype and/or its `constructor` before fn.prototype
   becomes observable. The lazy object allocation may run a moving
   collection, so callers must continue with the returned cell pointer. */
static ts_func* fn_materialize_prototype(ts_func* f, tsv fnv){
  if (f->proto_lazy){
    f->proto_lazy = 0;
    G0_INC(g0_proto_materialized);
    ts_gc_root(&fnv);
    /* Old from the start: a prototype lives as long as its function, and the
       addition cache records only old prototypes (docs/gc_v2_design.md,
       G1 (a)), so a young one would keep its constructors' stores on the slow
       path until a collection promoted it. */
    tsv proto = ts_new_proto_pretenured();
    f = (ts_func*)ts_ptr(fnv);
    f->prototype_prop = proto;
    ts_write_barrier(fnv, proto);
    ts_define_data(proto, fn_constructor_key(), fnv, 0, 1, 1);
    ts_gc_unroot(1);
    return (ts_func*)ts_ptr(fnv);
  }
  if (!f->ctor_pending) return f;
  f->ctor_pending = 0;
  if (ts_is_obj(f->prototype_prop))
    ts_define_data(f->prototype_prop, fn_constructor_key(), fnv, 0, 1, 1);
  return f;
}
/* Calling a non-function is a catchable TypeError in JS (`x()` / `x.m()` where
   the callee isn't callable). Implemented after the Error infrastructure (it
   needs TS_ERR_TYPE); forward-declared here so the call ABI below can throw.
   ts_throw_cannot_read is defined later (with ts_get_checked) — forward-declared
   so the method-dispatch receiver guard can reuse it. */
void ts_throw_not_a_function(const char* name);
static tsv ts_throw_cannot_read(tsv obj, const char* prop);
/* Closure calls merge captured cells (env) with the actual args into one buffer
   that lives ONLY for the duration of code() — the callee reads its leading
   parameters (cells..., args...) at entry and never retains the pointer. So a
   small on-stack buffer replaces the per-call malloc/free that dominated
   closure-heavy workloads (4M mallocs on gc_closures). We only fall back to
   malloc when the merged arity exceeds the buffer. GC reachability is unchanged:
   neither the old heap buffer nor this stack buffer is scanned by the GC — the
   env values stay reachable through `fn` (f->env) and the args through the
   caller's frame, exactly as before. 16 slots = 128B/frame covers the vast
   majority of closure arities at negligible stack cost. */
#define TS_CALL_MERGE_STACK 16
#ifndef TS_CALL_MEDIUM_STACK
#define TS_CALL_MEDIUM_STACK 64
#endif
#if TS_CALL_MEDIUM_STACK > TS_CALL_MERGE_STACK
/* Keep the common call frame small. Only larger captures enter this separate
   frame; the copied cells retain the same reachability as the small buffer. */
__attribute__((noinline)) static tsv ts_call_medium_env(ts_func* f, ts_code code, tsv* args, int nargs){
  tsv merged[TS_CALL_MEDIUM_STACK];
  memcpy(merged, f->env, sizeof(tsv) * f->envlen);
  if (nargs) memcpy(merged + f->envlen, args, sizeof(tsv) * (size_t)nargs);
  return code(merged, (int)f->envlen + nargs);
}
#endif
tsv ts_call(tsv fn, tsv* args, int nargs){
  if (g_has_proxies && ts_is_proxy(fn)) return ts_proxy_apply(fn, TS_UNDEFINED, args, nargs);
  if (!ts_is_func(fn)) ts_throw_not_a_function(NULL);
  ts_func* f = ts_ptr(fn);
  ts_code code = (ts_code)f->code;
  if (f->envlen){
    /* Environment ABI: the callee reads its cells from the register. */
    if (f->env_abi){ g_ts_cur_env = f->env; return code(args, nargs); }
    /* Legacy closure: prepend captured cells (env) to the args, matching the
       callee's calling convention (captured cells are its leading parameters). */
    int total = (int)f->envlen + nargs;   /* envlen>=1 here, nargs>=0 => total>=1 */
    RT_STAT_HIST(call_env_hist, total);
    RT_STAT_ADD(call_env_slots, total);
#if TS_CALL_MEDIUM_STACK > TS_CALL_MERGE_STACK
    if (total > TS_CALL_MERGE_STACK && total <= TS_CALL_MEDIUM_STACK)
      return ts_call_medium_env(f, code, args, nargs);
#endif
    tsv stackbuf[TS_CALL_MERGE_STACK];
    tsv* merged = (total <= TS_CALL_MERGE_STACK)
                    ? stackbuf
                    : (RT_STAT_INC(call_env_malloc), (tsv*)malloc(sizeof(tsv)*(size_t)total));
    for (uint32_t i=0;i<f->envlen;i++) merged[i]=f->env[i];
    for (int i=0;i<nargs;i++) merged[f->envlen+i]=args[i];
    tsv r = code(merged, total);
    if (merged != stackbuf) free(merged);
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
     ts_call afterwards, giving [cells..., undefinedThis, args...]). Same stack-
     buffer treatment as ts_call: `a` lives only across the ts_call below (which
     copies it into its own buffer), so a small on-stack array avoids the second
     malloc on the takes_this `g(...)` path. */
  int n = nargs + 1;                      /* nargs>=0 => n>=1 */
  tsv stackbuf[TS_CALL_MERGE_STACK];
  tsv* a = (n <= TS_CALL_MERGE_STACK) ? stackbuf : (tsv*)malloc(sizeof(tsv)*(size_t)n);
  a[0] = TS_UNDEFINED;
  for (int i=0;i<nargs;i++) a[1+i]=args[i];
  tsv r = ts_call(fn, a, n);
  if (a != stackbuf) free(a);
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
/* In-object slots of a field-less class instance (docs/empty_class_instances_design.md). */
#define TS_EMPTY_CLASS_SLOTS 8u
static tsv ts_new_sized_impl(size_t size, int pretenured){
  if (size < sizeof(ts_object)) size = sizeof(ts_object);
  /* A class without struct fields (`class SymbolLinks { declare _brand: any }`)
     has nothing for a descriptor to resolve; its instance is an ordinary
     shaped object with in-object slack, so the properties added later take
     the addition cache and the inline caches instead of dictionary entries. */
  if (size == sizeof(ts_object) && g_empty_class_plain)
    return ts_new_object_impl(pretenured, TS_EMPTY_CLASS_SLOTS);
  ts_object* o = pretenured
    ? gc_alloc_pretenured(size, TS_KIND_OBJECT)
    : gc_alloc(size, TS_KIND_OBJECT);
  /* Sized objects use the dictionary shape because a class descriptor can
     resolve fields before the named-property vector. Location caches guard the
     prototype, allocation size and registry epoch, so these objects can still
     use cached struct offsets and verified named-property slots. */
  o->shape = TS_SHAPE_NONE;
  return ts_obj(o);
}
tsv ts_new_sized(size_t size){ return ts_new_sized_impl(size, 0); }
tsv ts_new_sized_pretenured(size_t size){ return ts_new_sized_impl(size, 1); }
/* ---------------- arrays / sparse-hole representation ---------------- */
/* TS_ARRAY_HOLE and array_is_hole live in ts_rt.h (the inline element reader tests them). */
static inline int array_uses_inline(ts_array* a){ return a->data == a->inline_data; }
#define GC_CONTAINER_CARD_SHIFT 6u
/* A heap value still in the young generation: the only stores an old
   container must remember. */
static inline int array_value_is_young(tsv value){
  if (!ts_heap_ref(value)) return 0;
  uint64_t vp = value & TS_PAYLOAD_MASK;
  if (!vp || (vp & TS_PTR_STACK_TAG)) return 0; /* stack cells are never young */
  return ((const ts_gc_header*)(uintptr_t)vp)->gen == TS_GEN_YOUNG;
}
/* Indexed stores remember a bounded span of 64-element cards. Unknown stores
   still use ts_gc_remember, which requests the complete element scan. */
static inline void array_write_barrier(ts_array* a, uint32_t index, tsv value){
  if (a->o.h.gen != TS_GEN_OLD || !array_value_is_young(value)) return;
  uint32_t card = index >> GC_CONTAINER_CARD_SHIFT;
  if (card >= UINT16_MAX) a->gc_dirty_all = 1;
  else {
    if (!a->gc_dirty_end || card < a->gc_dirty_first) a->gc_dirty_first = (uint16_t)card;
    if (card >= a->gc_dirty_end) a->gc_dirty_end = (uint16_t)(card + 1u);
  }
  gc_remember(&a->o.h);
}
/* The out-of-line half of ts_array_set_inline's barrier (an old array). */
void ts_array_remember(ts_array* a, uint32_t index, tsv value){ array_write_barrier(a, index, value); }
static inline void array_invalidate_dirty(ts_array* a){
  if (a->o.h.gen == TS_GEN_OLD && a->o.h.remembered) a->gc_dirty_all = 1;
}

/* ---- sparse element storage (far stores; docs/sparse_elements_design.md) ----
   A store far beyond the dense capacity (the checker's flowTypeCache[nodeId]
   on a fresh array) must not materialize the gap. The array switches to a
   side table of index -> value (open addressing, linear probing): `len`
   stays the JS length, `cap` becomes 0 and `data` NULL so every reader
   bounded by cap sees no dense slot, and the table pointer lives in
   inline_data[0]. Dense arrays keep the invariant "every slot in [len, cap)
   is a hole", which lets the inline element reader (ts_rt.h) bound by cap at
   no extra cost. Generic operations densify first (as_arr / arr_dense). */
#define ARRAY_SPARSE_EMPTY 0xFFFFFFFFu   /* never an element index (2^32-1 is a named key) */
#define ARRAY_SPARSE_MIN_GAP 1024u
typedef struct ts_sparse_elems {
  uint32_t count, mask;   /* occupied keys (tombstones included); table size - 1 */
  uint32_t keys[];        /* table size keys, then table size values */
} ts_sparse_elems;
static inline ts_sparse_elems* array_sparse_table(ts_array* a){ return (ts_sparse_elems*)(uintptr_t)a->inline_data[0]; }
static inline void array_set_sparse_table(ts_array* a, ts_sparse_elems* s){ a->inline_data[0] = (tsv)(uintptr_t)s; }
static inline tsv* sparse_vals(ts_sparse_elems* s){ return (tsv*)(s->keys + (s->mask + 1u)); }
static ts_sparse_elems* sparse_alloc(const ts_gc_header* owner, uint32_t size){   /* size: a power of two >= 8 */
  ts_sparse_elems* s = (ts_sparse_elems*)gc_owned_alloc(owner, sizeof(ts_sparse_elems) + (size_t)size * (sizeof(uint32_t) + sizeof(tsv)));
  s->count = 0; s->mask = size - 1u;
  memset(s->keys, 0xFF, (size_t)size * sizeof(uint32_t));
  return s;
}
static inline uint32_t sparse_hash(uint32_t k){ k *= 0x9E3779B1u; return k ^ (k >> 16); }
/* the slot holding key, or ARRAY_SPARSE_EMPTY */
static inline uint32_t sparse_find(ts_sparse_elems* s, uint32_t key){
  uint32_t h = sparse_hash(key) & s->mask;
  for (;;){
    uint32_t k = s->keys[h];
    if (k == key) return h;
    if (k == ARRAY_SPARSE_EMPTY) return ARRAY_SPARSE_EMPTY;
    h = (h + 1u) & s->mask;
  }
}
static void sparse_insert_new(ts_sparse_elems* s, uint32_t key, tsv v){   /* key absent, room guaranteed */
  uint32_t h = sparse_hash(key) & s->mask;
  while (s->keys[h] != ARRAY_SPARSE_EMPTY) h = (h + 1u) & s->mask;
  s->keys[h] = key; sparse_vals(s)[h] = v; s->count++;
}
static ts_sparse_elems* sparse_put(const ts_gc_header* owner, ts_sparse_elems* s, uint32_t key, tsv v){   /* returns the (possibly grown) table */
  uint32_t h = sparse_find(s, key);
  if (h != ARRAY_SPARSE_EMPTY){ sparse_vals(s)[h] = v; return s; }
  if ((uint64_t)(s->count + 1u) * 2u > (uint64_t)s->mask + 1u){   /* load factor 1/2 */
    ts_sparse_elems* ns = sparse_alloc(owner, (s->mask + 1u) * 2u);
    tsv* vals = sparse_vals(s);
    for (uint32_t i = 0; i <= s->mask; i++) if (s->keys[i] != ARRAY_SPARSE_EMPTY) sparse_insert_new(ns, s->keys[i], vals[i]);
    gc_owned_free(s); s = ns;
  }
  sparse_insert_new(s, key, v);
  return s;
}
static void array_free_data(ts_array* a){
  if (a->sparse){ gc_owned_free(array_sparse_table(a)); a->inline_data[0] = TS_UNDEFINED; a->sparse = 0; return; }
  if (a->data && !array_uses_inline(a)) gc_owned_free(a->data);
}
/* A dying array: its buffers are payloads, released by not being marked. */
static void array_release_dead(ts_array* a){
  if (a->sparse) gc_owned_release_dead(array_sparse_table(a));
  else if (a->data && !array_uses_inline(a)) gc_owned_release_dead(a->data);
}
/* A store at i on a dense array goes sparse when the dense buffer would have
   to more than double by at least ARRAY_SPARSE_MIN_GAP slots (V8's
   dictionary-elements rule in spirit). */
static inline int array_store_is_far(ts_array* a, uint32_t i){
  return g_sparse_elements && i >= a->cap + ARRAY_SPARSE_MIN_GAP && (i >> 1) >= a->cap;
}
static void array_make_sparse(ts_array* a){
  RT_STAT_INC(array_sparse_convert);
  uint32_t n = a->len < a->cap ? a->len : a->cap;
  uint32_t size = 8u;
  while ((uint64_t)size < (uint64_t)n * 2u) size *= 2u;
  ts_sparse_elems* s = sparse_alloc(&a->o.h, size);
  for (uint32_t i = 0; i < n; i++) if (!array_is_hole(a->data[i])) sparse_insert_new(s, i, a->data[i]);
  array_free_data(a);
  a->data = NULL; a->cap = 0; a->sparse = 1;
  array_set_sparse_table(a, s);
  array_invalidate_dirty(a);
}
/* Back to dense storage of max(len, need) slots: a hole wherever the table
   has no entry. Tombstones at or beyond the length are dropped. */
static void array_densify(ts_array* a, uint32_t need){
  RT_STAT_INC(array_densify);
  ts_sparse_elems* s = array_sparse_table(a);
  uint32_t n = a->len > need ? a->len : need;
  uint32_t nc = n < 4u ? 4u : n;
  tsv* nd = nc <= 4u ? a->inline_data : (tsv*)gc_owned_alloc(&a->o.h, sizeof(tsv) * nc);
  for (uint32_t i = 0; i < nc; i++) nd[i] = TS_ARRAY_HOLE;
  tsv* vals = sparse_vals(s);
  for (uint32_t h = 0; h <= s->mask; h++){
    uint32_t k = s->keys[h];
    if (k != ARRAY_SPARSE_EMPTY && k < nc) nd[k] = vals[h];
  }
  gc_owned_free(s);
  a->data = nd; a->cap = nc; a->sparse = 0;
  array_invalidate_dirty(a);
}
static inline ts_array* arr_dense(tsv arr){   /* arr is an array: its dense form */
  ts_array* a = (ts_array*)ts_ptr(arr);
  if (__builtin_expect(a->sparse, 0)) array_densify(a, 0);
  return a;
}
static void array_sparse_store(ts_array* a, uint32_t i, tsv v){
  RT_STAT_INC(array_sparse_put);
  ts_sparse_elems* s = sparse_put(&a->o.h, array_sparse_table(a), i, v);
  array_set_sparse_table(a, s);
  if (i >= a->len) a->len = i + 1u;
  if (a->o.h.gen == TS_GEN_OLD && array_value_is_young(v)){ a->gc_dirty_all = 1; gc_remember(&a->o.h); }
  /* A table holding an eighth of the length is cheaper dense (V8's
     fast-elements heuristic): materialize it. */
  if ((uint64_t)s->count * 8u >= (uint64_t)a->len) array_densify(a, 0);
}
/* delete arr[i] / a reviver's undefined: the slot becomes a hole */
static void array_put_hole(ts_array* a, uint32_t i){
  if (i < a->cap) a->data[i] = TS_ARRAY_HOLE;
  else if (a->sparse){
    ts_sparse_elems* s = array_sparse_table(a);
    uint32_t h = sparse_find(s, i);
    if (h != ARRAY_SPARSE_EMPTY) sparse_vals(s)[h] = TS_ARRAY_HOLE;
  }
}
static void array_init_storage(ts_array* a, uint32_t len){
  a->len = len;
  a->cap = len < 4 ? 4 : len;
  a->data = (a->cap <= 4) ? a->inline_data : (tsv*)gc_owned_alloc(&a->o.h, sizeof(tsv) * a->cap);
  for (uint32_t i=0;i<a->cap;i++) a->data[i] = TS_ARRAY_HOLE;   /* [len, cap) holes too (invariant) */
}
static void array_ensure_cap(ts_array* a, uint32_t need){
  if (need <= a->cap) return;
  if (__builtin_expect(a->sparse, 0)){ array_densify(a, need); return; }
  uint32_t old = a->cap;
  uint32_t nc = old ? old * 2 : 4;
  while (nc < need) nc *= 2;
  if (array_uses_inline(a)){
    tsv* nd = (tsv*)gc_owned_alloc(&a->o.h, sizeof(tsv) * nc);
    for (uint32_t i=0;i<old;i++) nd[i] = a->data[i];
    a->data = nd;
  } else {
    a->data = (tsv*)gc_owned_realloc(&a->o.h, a->data, sizeof(tsv) * old, sizeof(tsv) * nc);
  }
  /* The grown tail is holes: readers bound by cap, so [len, cap) must hold
     holes (a store past len then needs no fill; truncation refills). */
  for (uint32_t i=old;i<nc;i++) a->data[i] = TS_ARRAY_HOLE;
  a->cap=nc;
}
/* `arr.length = n`: truncate (drop the tail) or extend (new slots are holes,
   read as undefined). The caller validates n as a non-negative integer < 2^32. */
static void ts_array_set_length(tsv arr, uint32_t newlen){
  ts_array* a = (ts_array*)ts_ptr(arr);
  uint32_t old = a->len;
  if (__builtin_expect(a->sparse, 0)){
    if (newlen < old){   /* entries at or beyond the new length become tombstones */
      ts_sparse_elems* s = array_sparse_table(a); tsv* vals = sparse_vals(s);
      for (uint32_t h = 0; h <= s->mask; h++) if (s->keys[h] != ARRAY_SPARSE_EMPTY && s->keys[h] >= newlen) vals[h] = TS_ARRAY_HOLE;
    }
    a->len = newlen; return;
  }
  if (newlen <= old){
    for (uint32_t i = newlen; i < old; i++) a->data[i] = TS_ARRAY_HOLE;   /* keep [len, cap) holes */
    a->len = newlen; return;
  }
  if (array_store_is_far(a, newlen - 1u)){ array_make_sparse(a); a->len = newlen; return; }
  array_ensure_cap(a, newlen);   /* [old, cap) already holds holes */
  a->len = newlen;
}
static tsv ts_new_array_impl(uint32_t len, int pretenured){
  ts_array* a = pretenured
    ? gc_alloc_pretenured(sizeof(ts_array), TS_KIND_ARRAY)
    : gc_alloc(sizeof(ts_array), TS_KIND_ARRAY);
  a->o.proto = ts_proto_ref(g_array_proto_v) ? g_array_proto_v : TS_NULL;
  a->o.shape = TS_SHAPE_EMPTY;   /* named properties (NodeArray's pos/end/...) are shaped: the caches apply */
  array_init_storage(a, len);
  tsv arr = ts_obj(a);
  if (pretenured) ts_write_barrier(arr, a->o.proto);
  return arr;
}
tsv ts_new_array(uint32_t len){ return ts_new_array_impl(len, 0); }
tsv ts_new_array_pretenured(uint32_t len){ return ts_new_array_impl(len, 1); }
int ts_is_array(tsv v){ return ts_is_array_fast(v); }
uint32_t ts_array_len(tsv arr){ return ts_is_indexed_array_fast(arr) ? ((ts_array*)ts_ptr(arr))->len : 0; }
tsv ts_array_get(tsv arr, uint32_t i){
  if (!ts_is_indexed_array_fast(arr)){
    /* str[i]: character access (no negative wraparound, unlike .at()). */
    if (ts_is_str(arr)){ return i < ts_str_len_typed(arr) ? ts_string_slice_view(arr, i, 1) : TS_UNDEFINED; }
    if (ts_is_typed_array(arr)) return ts_ta_get(arr, i);
    return TS_UNDEFINED;
  }
  ts_array* a = ts_ptr(arr);
  if (i < a->cap){ tsv v = a->data[i]; return array_is_hole(v) ? TS_UNDEFINED : v; }
  if (a->sparse){
    ts_sparse_elems* s = array_sparse_table(a);
    uint32_t h = sparse_find(s, i);
    if (h != ARRAY_SPARSE_EMPTY){ tsv v = sparse_vals(s)[h]; return array_is_hole(v) ? TS_UNDEFINED : v; }
  }
  return TS_UNDEFINED;
}
int ts_array_has_index(tsv arr, uint32_t i){
  if (!ts_is_indexed_array_fast(arr)) return 0;
  ts_array* a = ts_ptr(arr);
  if (i < a->cap) return !array_is_hole(a->data[i]);
  if (a->sparse){
    ts_sparse_elems* s = array_sparse_table(a);
    uint32_t h = sparse_find(s, i);
    return h != ARRAY_SPARSE_EMPTY && !array_is_hole(sparse_vals(s)[h]);
  }
  return 0;
}
static void ts_array_set_grow(ts_array* a, uint32_t i, tsv v);
void ts_array_set(tsv arr, uint32_t i, tsv v){
  if (!ts_is_indexed_array_fast(arr)){ if (ts_is_typed_array(arr)) ts_ta_set(arr, i, v); return; }
  ts_array* a = ts_ptr(arr);
  if (ts_obj_integrity(&a->o) & 1u){   /* strict: a frozen array's element writes / push throw */
    char buf[96];
    if (i < a->len) snprintf(buf, sizeof(buf), "Cannot assign to read only property '%u' of object '[object Array]'", i);
    else snprintf(buf, sizeof(buf), "Cannot add property %u, object is not extensible", i);
    ts_throw_type_error_msg(buf); return;
  }
  if (__builtin_expect(i < a->cap, 1)){
    /* [len, cap) holds holes, so a store past len needs no fill. */
    a->data[i] = v;
    if (i >= a->len) a->len = i+1;
    array_write_barrier(a, i, v);
    return;
  }
  ts_array_set_grow(a, i, v);
}
/* i >= cap: grow the dense buffer, or store into the side table */
static void ts_array_set_grow(ts_array* a, uint32_t i, tsv v){
  if (i == UINT32_MAX){ ts_throw_range_error_msg("Invalid array index"); return; }   /* 2^32-1 is a named key: outside the element model (loud) */
  if (a->sparse){ array_sparse_store(a, i, v); return; }
  if (array_store_is_far(a, i)){ array_make_sparse(a); array_sparse_store(a, i, v); return; }
  array_ensure_cap(a, i + 1u);
  a->data[i] = v;
  a->len = i + 1u;
  array_write_barrier(a, i, v);
}
void ts_array_push(tsv arr, tsv v){ if (ts_is_indexed_array_fast(arr)) ts_array_set(arr, ((ts_array*)ts_ptr(arr))->len, v); }
void ts_array_push_hole(tsv arr){
  if (!ts_is_indexed_array_fast(arr)) return;
  ts_array* a = ts_ptr(arr);
  if (a->sparse){ if (a->len != UINT32_MAX) a->len++; return; }   /* a hole past the end is only a length */
  array_ensure_cap(a, a->len + 1);
  a->data[a->len++] = TS_ARRAY_HOLE;
}
static inline void ts_array_store_existing(tsv arr, uint32_t i, tsv v){
  ts_array* a = ts_is_indexed_array_fast(arr) ? (ts_array*)ts_ptr(arr) : NULL;
  if (!a || i >= a->len || i >= a->cap) return;   /* never a sparse array's table */
  a->data[i] = v;
  array_write_barrier(a, i, v);
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
static int g_has_class_regs = 0;
/* If key names a struct field of o, return its byte offset (>=0) via *off and
   whether it is an unboxed double via *numeric, and return 1. Else return 0. */
static int class_field_lookup(ts_object* o, ts_key key, size_t* off, int* numeric);
static tsv  struct_field_get(ts_object* o, size_t off, int numeric);
static void struct_field_set(ts_object* o, size_t off, int numeric, tsv v);

/* Find (or create) the ts_prop slot for key. Returns the whole ts_prop* so
   callers can read/set attribute flags. New slots are initialized to
   TS_PROP_DEFAULT (all-true) so ordinary properties created here behave exactly
   as before the flags field existed. */
#define TS_PROP_INDEX_MIN 8u

static uint32_t prop_key_hash(ts_key key){
  uint32_t x = key;
  x ^= x >> 16;
  x *= 0x7feb352du;
  x ^= x >> 15;
  x *= 0x846ca68bu;
  return x ^ (x >> 16);
}

/* Hidden-class transition table. A shape identifies the ordered sequence of own
   property keys, so equal shapes have equal dense prop slots. Deletion switches
   an object to shape 0 instead of trying to model dictionary transitions. */
typedef struct {
  uint32_t parent;
  ts_key key;
  uint8_t flags;
  uint32_t next;
} ts_shape_edge;
static ts_shape_edge* g_shape_edges = NULL;
static uint32_t g_shape_edge_cap = 0, g_shape_edge_len = 0;
static uint32_t g_next_shape = TS_SHAPE_EMPTY + 1u;
/* The generator objects' coroutine field key, interned once. */
static uint32_t g_coro_key_cached = 0;
static uint32_t ts_coro_key(void){ if (!g_coro_key_cached) g_coro_key_cached = ts_intern_field("__coro", 6); return g_coro_key_cached; }
static tsv ts_iter_result_new(tsv value, int done);   /* defined with the map iterator */

/* Shape descriptors (object_model_v2_design.md, slice A2a): the hidden class
   owns its key sequence and the attribute flags of every property, so the
   flags are part of the transition key. Key/flag vectors are materialized
   lazily from the parent chain. Index TS_SHAPE_EMPTY stays zeroed (depth 0). */
typedef struct {
  uint32_t parent;
  ts_key key;
  uint8_t flags;
  uint32_t depth;
  ts_key* keys;      /* depth entries */
  uint8_t* kflags;   /* depth entries */
  /* Open-addressing index over `keys` (slot + 1 per entry) for shapes with at
     least TS_PROP_INDEX_MIN keys, so keyed lookups on large shaped objects
     stay sub-linear like the dictionary index. */
  uint32_t* index;
  uint32_t index_cap;
} ts_shape_desc;
static ts_shape_desc* g_shapes = NULL;
static uint32_t g_shapes_cap = 0;
/* Public key/flag vectors by shape id (ts_rt.h); the header's inline probe and
   the accessors below read them. Index 0 and TS_SHAPE_EMPTY stay NULL. */
ts_key** g_ts_shape_keys = NULL;
uint8_t** g_ts_shape_flags = NULL;
ts_key* g_ts_probe_rkeys = NULL;
ts_key* g_ts_probe_wkeys = NULL;
/* The vectors of shapes 0 (dictionary) and 1 (empty): all NONE, so a static
   slot probe on such a receiver misses without a shape test. */
static ts_key g_shape_keys_none[TS_STATIC_SLOT_LIMIT] = {
  TS_KEY_NONE, TS_KEY_NONE, TS_KEY_NONE, TS_KEY_NONE, TS_KEY_NONE, TS_KEY_NONE, TS_KEY_NONE, TS_KEY_NONE,
  TS_KEY_NONE, TS_KEY_NONE, TS_KEY_NONE, TS_KEY_NONE, TS_KEY_NONE, TS_KEY_NONE, TS_KEY_NONE, TS_KEY_NONE };
static uint8_t g_shape_flags_none[TS_STATIC_SLOT_LIMIT];
static void shape_desc_record(uint32_t id, uint32_t parent, ts_key key, uint8_t flags){
  if (id >= g_shapes_cap){
    uint32_t cap = g_shapes_cap ? g_shapes_cap : 1024u;
    while (id >= cap) cap *= 2u;
    g_shapes = (ts_shape_desc*)realloc(g_shapes, sizeof(ts_shape_desc) * cap);
    memset(g_shapes + g_shapes_cap, 0, sizeof(ts_shape_desc) * (cap - g_shapes_cap));
    g_ts_shape_keys = (ts_key**)realloc(g_ts_shape_keys, sizeof(ts_key*) * cap);
    memset(g_ts_shape_keys + g_shapes_cap, 0, sizeof(ts_key*) * (cap - g_shapes_cap));
    g_ts_shape_flags = (uint8_t**)realloc(g_ts_shape_flags, sizeof(uint8_t*) * cap);
    memset(g_ts_shape_flags + g_shapes_cap, 0, sizeof(uint8_t*) * (cap - g_shapes_cap));
    size_t row = sizeof(ts_key) * TS_STATIC_SLOT_LIMIT;
    g_ts_probe_rkeys = (ts_key*)realloc(g_ts_probe_rkeys, row * cap);
    g_ts_probe_wkeys = (ts_key*)realloc(g_ts_probe_wkeys, row * cap);
    if (!g_shapes || !g_ts_shape_keys || !g_ts_shape_flags || !g_ts_probe_rkeys || !g_ts_probe_wkeys)
      ts_abort_msg("out of memory growing the shape tables");
    /* TS_KEY_NONE everywhere: shapes 0 and 1 and the rows not yet recorded */
    memset((char*)g_ts_probe_rkeys + row * g_shapes_cap, 0xFF, row * (cap - g_shapes_cap));
    memset((char*)g_ts_probe_wkeys + row * g_shapes_cap, 0xFF, row * (cap - g_shapes_cap));
    g_shapes_cap = cap;
    g_ts_shape_keys[TS_SHAPE_NONE] = g_shape_keys_none; g_ts_shape_flags[TS_SHAPE_NONE] = g_shape_flags_none;
    g_ts_shape_keys[TS_SHAPE_EMPTY] = g_shape_keys_none; g_ts_shape_flags[TS_SHAPE_EMPTY] = g_shape_flags_none;
  }
  ts_shape_desc* d = &g_shapes[id];
  d->parent = parent; d->key = key; d->flags = flags;
  uint32_t pdepth = parent < g_shapes_cap ? g_shapes[parent].depth : 0u;
  d->depth = pdepth + 1u;
  /* Eager vectors: the parent's sequence plus this key. Shaped objects index
     them on every keyed lookup, so they must exist before the shape is used.
     At least TS_STATIC_SLOT_LIMIT entries, the tail NONE / zero, so a static
     slot probe (ts_rt.h) indexes them without a length test. */
  uint32_t vcap = d->depth < TS_STATIC_SLOT_LIMIT ? TS_STATIC_SLOT_LIMIT : d->depth;
  d->keys = (ts_key*)malloc(sizeof(ts_key) * vcap);
  d->kflags = (uint8_t*)malloc(vcap);
  if (pdepth){
    memcpy(d->keys, g_shapes[parent].keys, sizeof(ts_key) * pdepth);
    memcpy(d->kflags, g_shapes[parent].kflags, pdepth);
  }
  d->keys[pdepth] = key; d->kflags[pdepth] = flags;
  for (uint32_t i = d->depth; i < vcap; i++){ d->keys[i] = TS_KEY_NONE; d->kflags[i] = 0; }
  g_ts_shape_keys[id] = d->keys;
  g_ts_shape_flags[id] = d->kflags;
  for (uint32_t i = 0; i < TS_STATIC_SLOT_LIMIT; i++){
    ts_key k = d->keys[i];
    uint8_t f = d->kflags[i];
    size_t at = (size_t)id * TS_STATIC_SLOT_LIMIT + i;
    g_ts_probe_rkeys[at] = !(f & TS_PROP_ACCESSOR) ? k : TS_KEY_NONE;
    g_ts_probe_wkeys[at] = (f & (TS_PROP_ACCESSOR | TS_PROP_WRITABLE)) == TS_PROP_WRITABLE ? k : TS_KEY_NONE;
  }
  d->index = NULL; d->index_cap = 0;
  if (d->depth >= TS_PROP_INDEX_MIN){
    uint32_t cap = 16u;
    while (d->depth * 4u >= cap * 3u) cap *= 2u;
    d->index = (uint32_t*)calloc(cap, sizeof(uint32_t));
    d->index_cap = cap;
    for (uint32_t i = 0; i < d->depth; i++){
      uint32_t slot = prop_key_hash(d->keys[i]) & (cap - 1u);
      while (d->index[slot]) slot = (slot + 1u) & (cap - 1u);
      d->index[slot] = i + 1u;
    }
  }
}
/* Slot of `key` in a shape with an index, or -1. */
static inline int32_t shape_index_find(uint32_t sid, ts_key key, uint32_t* probes){
  const ts_shape_desc* d = &g_shapes[sid];
  uint32_t mask = d->index_cap - 1u, p = 0;
  for (uint32_t slot = prop_key_hash(key) & mask; ; slot = (slot + 1u) & mask){
    p++;
    uint32_t entry = d->index[slot];
    if (!entry){ if (probes) *probes = p; return -1; }
    if (d->keys[entry - 1u] == key){ if (probes) *probes = p; return (int32_t)(entry - 1u); }
  }
}
static inline uint32_t shape_depth(uint32_t id){
  return (id <= TS_SHAPE_EMPTY || id >= g_shapes_cap) ? 0u : g_shapes[id].depth;
}
static inline const ts_key* shape_keys(uint32_t id){
  return (id <= TS_SHAPE_EMPTY || id >= g_shapes_cap) ? NULL : g_shapes[id].keys;
}
static inline const uint8_t* shape_kflags(uint32_t id){
  return (id <= TS_SHAPE_EMPTY || id >= g_shapes_cap) ? NULL : g_shapes[id].kflags;
}

static uint32_t shape_edge_hash(uint32_t parent, ts_key key, uint8_t flags){
  return prop_key_hash((key ^ (parent * 0x9e3779b9u)) + (uint32_t)flags * 0x85ebca6bu);
}
static int shape_edges_grow(void){
  uint32_t new_cap = g_shape_edge_cap ? g_shape_edge_cap * 2u : 64u;
  ts_shape_edge* edges = (ts_shape_edge*)calloc(new_cap, sizeof(ts_shape_edge));
  if (!edges) return 0;
  for (uint32_t i = 0; i < g_shape_edge_cap; i++){
    ts_shape_edge edge = g_shape_edges[i];
    if (!edge.next) continue;
    uint32_t slot = shape_edge_hash(edge.parent, edge.key, edge.flags) & (new_cap - 1u);
    while (edges[slot].next) slot = (slot + 1u) & (new_cap - 1u);
    edges[slot] = edge;
  }
  free(g_shape_edges);
  g_shape_edges = edges;
  g_shape_edge_cap = new_cap;
  return 1;
}
static uint32_t shape_transition_f(uint32_t parent, ts_key key, uint8_t flags){
  if (parent == TS_SHAPE_NONE) return TS_SHAPE_NONE;
  if (!g_shape_edge_cap || (g_shape_edge_len + 1u) * 4u >= g_shape_edge_cap * 3u){
    if (!shape_edges_grow()) return TS_SHAPE_NONE;
  }
  uint32_t slot = shape_edge_hash(parent, key, flags) & (g_shape_edge_cap - 1u);
  while (g_shape_edges[slot].next){
    if (g_shape_edges[slot].parent == parent && g_shape_edges[slot].key == key &&
        g_shape_edges[slot].flags == flags)
      return g_shape_edges[slot].next;
    slot = (slot + 1u) & (g_shape_edge_cap - 1u);
  }
  if (g_next_shape > TS_SHAPE_MAX) return TS_SHAPE_NONE;
  uint32_t next = g_next_shape++;
  g_shape_edges[slot].parent = parent;
  g_shape_edges[slot].key = key;
  g_shape_edges[slot].flags = flags;
  g_shape_edges[slot].next = next;
  g_shape_edge_len++;
  shape_desc_record(next, parent, key, flags);
  return next;
}
/* Ordinary stores add properties with the default attributes. */
static uint32_t shape_transition(uint32_t parent, ts_key key){
  return shape_transition_f(parent, key, TS_PROP_DEFAULT);
}
/* Leave the hidden-class regime: convert to a dictionary (shape 0) with
   per-entry keys and flags, as deletion and attribute changes require. */
static void obj_to_dictionary(ts_object* o);
#ifdef TSAOT_RT_STATS
/* Instrumented builds verify that a shaped object's length matches its shape
   (keys and flags are the shape's own vectors, so they cannot drift). */
static void shape_check(const ts_object* o){
  uint32_t id = ts_obj_shape_id(o);
  if (id == TS_SHAPE_NONE) return;
  if (shape_depth(id) != o->len){ fprintf(stderr, "tsaot: shape depth %u != len %u\n", shape_depth(id), o->len); abort(); }
  if (o->len && !shape_keys(id)){ fprintf(stderr, "tsaot: shape %u has no key vector\n", id); abort(); }
}
#define SHAPE_CHECK(o) shape_check(o)
#else
#define SHAPE_CHECK(o) ((void)0)
#endif

/* ---- object model v2 (slice A2b): representation accessors ----
   A shaped object (shape != 0) stores only values, 8 bytes per property; its
   keys and attribute flags are the shape's vectors. A dictionary object
   (shape 0) keeps ts_prop entries with keys and flags, plus an optional
   open-addressing index. Sized class instances are always dictionaries. */
static inline int obj_shaped(const ts_object* o){ return ts_obj_shape_id(o) != TS_SHAPE_NONE; }
/* A shaped object's slot i lives in-object for i < inline_cap, else in the
   external value vector (o->props, o->cap = its capacity). */
static inline ts_key obj_key_at(const ts_object* o, uint32_t i){
  return obj_shaped(o) ? g_ts_shape_keys[ts_obj_shape_id(o)][i] : o->props[i].key;
}
static inline tsv* obj_val_at(ts_object* o, uint32_t i){
  return obj_shaped(o) ? ts_obj_slot_ptr(o, i) : &o->props[i].val;
}
static inline uint8_t obj_flags_at(const ts_object* o, uint32_t i){
  return obj_shaped(o) ? g_ts_shape_flags[ts_obj_shape_id(o)][i] : o->props[i].flags;
}
/* A located own property: the object and its slot index. */
typedef struct { ts_object* o; uint32_t i; } ts_pref;
static const ts_pref PREF_NONE = { NULL, 0u };
static inline int pref_ok(ts_pref r){ return r.o != NULL; }
static inline ts_key pref_key(ts_pref r){ return obj_key_at(r.o, r.i); }
static inline tsv* pref_valp(ts_pref r){ return obj_val_at(r.o, r.i); }
static inline tsv pref_val(ts_pref r){ return *obj_val_at(r.o, r.i); }
static inline uint8_t pref_flags(ts_pref r){ return obj_flags_at(r.o, r.i); }
static inline int pref_is_accessor(ts_pref r){ return (pref_flags(r) & TS_PROP_ACCESSOR) != 0; }
static inline int pref_is_writable(ts_pref r){ return (pref_flags(r) & TS_PROP_WRITABLE) != 0; }
static inline int pref_is_enumerable(ts_pref r){ return (pref_flags(r) & TS_PROP_ENUMERABLE) != 0; }
static inline int pref_is_configurable(ts_pref r){ return (pref_flags(r) & TS_PROP_CONFIGURABLE) != 0; }

/* Dictionary index (shape 0 only). */
/* The index block: its capacity, then the entries. */
static inline uint32_t prop_index_capacity(const ts_object* o){ return o->prop_index ? o->prop_index[0] : 0u; }
static void prop_index_put(ts_object* o, uint32_t prop_i){
  uint32_t* entries = o->prop_index + 1;
  uint32_t mask = o->prop_index[0] - 1u;
  uint32_t slot = prop_key_hash(o->props[prop_i].key) & mask;
  while (entries[slot]) slot = (slot + 1u) & mask;
  entries[slot] = prop_i + 1u;
}
static void prop_index_rebuild(ts_object* o, uint32_t need){
  if (need < TS_PROP_INDEX_MIN){
    gc_owned_free(o->prop_index);
    o->prop_index = NULL;
    return;
  }
  uint32_t old_cap = prop_index_capacity(o);
  uint32_t cap = old_cap ? old_cap : 16u;
  while (need * 4u >= cap * 3u) cap *= 2u;
  if (cap != old_cap){
    gc_owned_free(o->prop_index);
    o->prop_index = (uint32_t*)gc_owned_alloc(&o->h, sizeof(uint32_t) * (cap + 1u));
  }
  memset(o->prop_index, 0, sizeof(uint32_t) * (cap + 1u));
  o->prop_index[0] = cap;
  for (uint32_t i = 0; i < o->len; i++) prop_index_put(o, i);
}
static void prop_index_reserve(ts_object* o, uint32_t need){
  if (need < TS_PROP_INDEX_MIN) return;
  if (!o->prop_index || need * 4u >= prop_index_capacity(o) * 3u)
    prop_index_rebuild(o, need);
}
static int32_t prop_index_lookup(ts_object* o, ts_key key, uint32_t* probes){
  uint32_t p = 0;
  uint32_t mask = o->prop_index[0] - 1u;
  const uint32_t* entries = o->prop_index + 1;
  for (uint32_t slot = prop_key_hash(key) & mask; ; slot = (slot + 1u) & mask){
    p++;
    uint32_t entry = entries[slot];
    if (!entry){
      if (probes) *probes = p;
      return -1;
    }
    if (o->props[entry - 1u].key == key){
      if (probes) *probes = p;
      return (int32_t)(entry - 1u);
    }
  }
}
/* Property value vectors (shaped) and entry vectors (dictionaries) are
   payloads of their object (docs/gc_v2_design.md §6.1, G2c): a dead object's
   vector is released by not being marked. */
static ts_prop* props_alloc_small(const ts_gc_header* owner){
  RT_STAT_INC(small_props_fresh);
  return (ts_prop*)gc_owned_alloc(owner, 4u * sizeof(ts_prop));
}
static tsv* vals_alloc_small(const ts_gc_header* owner){
  RT_STAT_INC(small_props_fresh);
  return (tsv*)gc_owned_alloc(owner, 4u * sizeof(tsv));
}
/* A dying object's vectors (malloc'd only for owners outside the heap). */
static void props_release_dead(ts_object* o){
  gc_owned_release_dead(o->props);
  gc_owned_release_dead(o->prop_index);
}
static void obj_to_dictionary(ts_object* o){
  if (o->h.gen == TS_GEN_OLD) o->h.hdr_spare = 0xFF; /* slots renumber: a remembered range would be stale */
  if (!obj_shaped(o)) return;
  uint32_t sid = ts_obj_shape_id(o);
  uint32_t len = o->len, oldcap = o->cap;
  ts_prop* v = NULL;
  uint32_t cap = 0;
  if (len){
    cap = len <= 4u ? 4u : len;
    if (cap <= 4u) v = props_alloc_small(&o->h);
    else v = (ts_prop*)gc_owned_alloc(&o->h, sizeof(ts_prop) * cap);
    const ts_key* ks = g_ts_shape_keys[sid];
    const uint8_t* fl = g_ts_shape_flags[sid];
    for (uint32_t i = 0; i < len; i++){ v[i].key = ks[i]; v[i].val = *obj_val_at(o, i); v[i].flags = fl[i]; }
  }
  /* the inline area stays allocated (inline_cap keeps the cell size honest)
     but a dictionary never reads it; the external vector is released. */
  if (oldcap) gc_owned_free(o->props);
  o->props = v; o->cap = cap;
  ts_obj_set_shape(o, TS_SHAPE_NONE);
  if (len >= TS_PROP_INDEX_MIN) prop_index_rebuild(o, len);
}
/* Append a new own property whose absence the caller has established.
   next_shape is the hidden class after the addition (shape_transition's
   answer for the current shape and key, or a cached copy of it); it is
   TS_SHAPE_NONE for dictionaries. */
static ts_pref props_append_f(ts_object* o, ts_key key, uint32_t next_shape, uint8_t flags){
  int shaped = obj_shaped(o);
  if (shaped && next_shape == TS_SHAPE_NONE){ obj_to_dictionary(o); shaped = 0; }
  if (shaped){
    /* slots below inline_cap are in the cell; o->cap counts external slots. */
    uint32_t icap = o->h.inline_cap;
    if (o->len >= icap && o->len - icap == o->cap){
      uint32_t cap = o->cap;
      if (!cap) o->props = (ts_prop*)vals_alloc_small(&o->h);
      else o->props = (ts_prop*)gc_owned_realloc(&o->h, o->props, sizeof(tsv) * (size_t)cap, sizeof(tsv) * (size_t)cap * 2u);
      o->cap = cap ? cap * 2u : 4u;
    }
  } else if (o->len==o->cap){
    uint32_t cap = o->cap;
    if (!cap) o->props = props_alloc_small(&o->h);
    else o->props = (ts_prop*)gc_owned_realloc(&o->h, o->props, sizeof(ts_prop) * (size_t)cap, sizeof(ts_prop) * (size_t)cap * 2u);
    o->cap = cap ? cap * 2u : 4u;
  }
  if (!shaped) prop_index_reserve(o, o->len + 1u);
  uint32_t added = o->len++;
  if (shaped) *ts_obj_slot_ptr(o, added) = TS_UNDEFINED;
  else { o->props[added].key=key; o->props[added].val=TS_UNDEFINED; o->props[added].flags=flags; }
  /* A user-Symbol property name is a strong edge even though the entry stores
     only its compact id. Enroll old owners when that Symbol is young; the GC
     scanner reconstructs and marks the same edge from the weak side table. */
  if (key >= TS_USERSYM_KEY_BASE)
    ts_write_barrier(ts_obj(o), sym_value_by_id(key - TS_USERSYM_KEY_BASE));
  if (!shaped && o->prop_index) prop_index_put(o, added);
  if (shaped) ts_obj_set_shape(o, next_shape);
  SHAPE_CHECK(o);
  return (ts_pref){ o, added };
}
static ts_pref props_append(ts_object* o, ts_key key, uint32_t next_shape){
  return props_append_f(o, key, next_shape, TS_PROP_DEFAULT);
}
/* Locate an own property by key. */
static ts_pref prop_find(ts_object* o, ts_key key){
  RT_STAT_INC(find_prop_calls); RT_STAT_KEY(g_key_prop_find, key);
  if (obj_shaped(o)){
    uint32_t len = o->len;
    uint32_t sid = ts_obj_shape_id(o);
    if (len >= TS_PROP_INDEX_MIN && g_shapes[sid].index){
      uint32_t probes = 0;
      int32_t found = shape_index_find(sid, key, &probes);
      RT_STAT_ADD(find_prop_probes, probes); RT_STAT_HIST(find_prop_hist, probes);
      return found < 0 ? PREF_NONE : (ts_pref){ o, (uint32_t)found };
    }
    /* The shape tables exist once any property has been added anywhere; an
       empty shaped object must not index them. */
    const ts_key* ks = len ? g_ts_shape_keys[sid] : NULL;
    for (uint32_t i=0;i<len;i++) if (ks[i]==key){
      RT_STAT_ADD(find_prop_probes, i+1); RT_STAT_HIST(find_prop_hist, i+1);
      return (ts_pref){ o, i };
    }
    RT_STAT_ADD(find_prop_probes, len); RT_STAT_HIST(find_prop_hist, len+1);
    return PREF_NONE;
  }
  if (o->prop_index){
    uint32_t probes = 0;
    int32_t found = prop_index_lookup(o, key, &probes);
    RT_STAT_ADD(find_prop_probes, probes); RT_STAT_HIST(find_prop_hist, probes);
    return found < 0 ? PREF_NONE : (ts_pref){ o, (uint32_t)found };
  }
  for (uint32_t i=0;i<o->len;i++) if (o->props[i].key==key){
    RT_STAT_ADD(find_prop_probes, i+1); RT_STAT_HIST(find_prop_hist, i+1);
    return (ts_pref){ o, i };
  }
  RT_STAT_ADD(find_prop_probes, o->len); RT_STAT_HIST(find_prop_hist, o->len+1);
  return PREF_NONE;
}
/* Find, or create with default attributes (the historical find_prop contract). */
static ts_pref find_prop(ts_object* o, ts_key key, int create){
  ts_pref r = prop_find(o, key);
  if (pref_ok(r) || !create) return r;
  uint32_t sid = ts_obj_shape_id(o);
  return props_append(o, key, sid == TS_SHAPE_NONE ? TS_SHAPE_NONE : shape_transition(sid, key));
}
/* Define or redefine `key` with attribute flags. A new property transitions
   with its flags; changing the flags of an existing property on a shaped
   object demotes it to a dictionary first (attributes are part of the class). */
static ts_pref props_define(ts_object* o, ts_key key, uint8_t flags){
  ts_pref p = prop_find(o, key);
  if (pref_ok(p)){
    if (pref_flags(p) != flags){
      obj_to_dictionary(o);
      o->props[p.i].flags = flags;
    }
    return p;
  }
  uint32_t sid = ts_obj_shape_id(o);
  uint32_t next = sid == TS_SHAPE_NONE ? TS_SHAPE_NONE : shape_transition_f(sid, key, flags);
  return props_append_f(o, key, next, flags);
}
/* Back-compat thin wrapper: returns &val (the historical find_slot contract). */
static tsv* find_slot(ts_object* o, ts_key key, int create){
  ts_pref p = find_prop(o, key, create);
  return pref_ok(p) ? pref_valp(p) : NULL;
}
/* ---- a function's own properties (docs/function_own_properties_design.md) ----
   `name` and `length` are virtual own data properties built from the boxed
   metadata (read-only, not enumerable, configurable) while the function has
   no own entry by that key (in its property map or, a class value, its
   static container) and they were neither deleted nor redefined (the gone
   bits); `prototype` lives in prototype_prop. */
static ts_key g_fn_key_name = 0xFFFFFFFFu, g_fn_key_length = 0xFFFFFFFFu, g_fn_key_prototype = 0xFFFFFFFFu;
static void fn_keys_init(void){
  if (g_fn_key_name != 0xFFFFFFFFu) return;
  g_fn_key_name = ts_intern_field("name", 4);
  g_fn_key_length = ts_intern_field("length", 6);
  g_fn_key_prototype = ts_intern_field("prototype", 9);
}
enum { FN_VIRTUAL_NONE = 0, FN_VIRTUAL_NAME = 1, FN_VIRTUAL_LENGTH = 2 };
static int fn_virtual(ts_func* f, ts_key key){
  fn_keys_init();
  int which = key == g_fn_key_name ? FN_VIRTUAL_NAME : key == g_fn_key_length ? FN_VIRTUAL_LENGTH : FN_VIRTUAL_NONE;
  if (!which || (which == FN_VIRTUAL_NAME ? f->name_gone : f->length_gone)) return FN_VIRTUAL_NONE;
  if (find_slot(&f->o, key, 0)) return FN_VIRTUAL_NONE;
  if (f->class_id){
    ts_object* sc = ts_proto_ptr(f->o.proto);
    if (sc && sc->h.kind == TS_KIND_OBJECT && find_slot(sc, key, 0)) return FN_VIRTUAL_NONE;
  }
  return which;
}
/* The value of a virtual property (allocates the name string). */
static tsv fn_virtual_value(const ts_func* f, int which){
  if (which == FN_VIRTUAL_NAME){
    const char* nm = f->name ? f->name : "";
    return ts_new_string(nm, (uint32_t)strlen(nm));
  }
  return ts_num((double)f->arity);
}
/* A function link of another object's prototype chain: its `prototype` and
   its virtual properties, which find_slot (its property map) does not see.
   May allocate (the prototype object, the name string). */
static int fn_link_get(ts_object* link, ts_key key, tsv* out){
  ts_func* f = (ts_func*)link;
  fn_keys_init();
  if (key == g_fn_key_prototype && fn_has_own_prototype(f)){
    f = fn_materialize_prototype(f, ts_func_v(f));
    *out = f->prototype_prop;
    return 1;
  }
  int which = fn_virtual(f, key);
  if (!which) return 0;
  *out = fn_virtual_value(f, which);
  return 1;
}
static int fn_link_has(ts_object* link, ts_key key){
  ts_func* f = (ts_func*)link;
  fn_keys_init();
  if (key == g_fn_key_prototype && fn_has_own_prototype(f)) return 1;
  return fn_virtual(f, key) != FN_VIRTUAL_NONE;
}
/* Before a definition applies to a virtual `name` or `length`: an own entry
   with its value and current attributes takes its place for good. */
static void fn_realize_virtual(tsv fnv, ts_key key){
  ts_func* f = (ts_func*)ts_ptr(fnv);
  int which = fn_virtual(f, key);
  if (!which) return;
  ts_gc_root(&fnv);
  tsv v = fn_virtual_value(f, which);
  ts_gc_root(&v);
  f = (ts_func*)ts_ptr(fnv);
  if (which == FN_VIRTUAL_NAME) f->name_gone = 1; else f->length_gone = 1;
  uint8_t flags = (ts_obj_integrity(&f->o) & (1u|4u)) ? 0 : TS_PROP_CONFIGURABLE;
  ts_pref p = props_define(&f->o, key, flags);
  *pref_valp(p) = v;
  ts_write_barrier(fnv, v);
  ts_gc_unroot(2);
}
static int lookup_prop_chain(tsv receiver, ts_object* o, ts_key key, tsv* out){
  while (o){
    if (chain_link_exotic(o)){
      ts_object* next;
      if (chain_exotic_get(o, key, receiver, out, &next)) return 1;
      o = next;
      continue;
    }
    if (TS_RT_UNLIKELY(o->h.kind == TS_KIND_FUNC) && fn_link_get(o, key, out)) return 1;
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
    if (chain_link_exotic(o)){
      ts_object* next;
      if (chain_exotic_get(o, key, receiver, out, &next)) return 1;
      o = next;
      continue;
    }
    if (TS_RT_UNLIKELY(o->h.kind == TS_KIND_FUNC) && fn_link_get(o, key, out)) return 1;
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
  return k==TS_KIND_OBJECT || k==TS_KIND_ARRAY || k==TS_KIND_FUNC || k==TS_KIND_MAP || k==TS_KIND_SET ||
         k==TS_KIND_ARRAYBUFFER || k==TS_KIND_TYPEDARRAY;
}
/* A property-bag receiver: anything carrying the common header. Object/array/map/
   set use the OBJECT NaN-box selector; functions use the FUNC selector. Both are
   valid ts_get/ts_set receivers in the unified model. */
static inline int ts_is_propbag(tsv v){ return ts_is_obj(v) || ts_is_func(v); }
/* A receiver the property caches serve for `key`: a plain object, or an array
   for any named key but `length` (an array's length is virtual, not a slot;
   docs/shaped_array_props_design.md). Index keys reach the caches only through
   the dynamic path. */
static int prop_key_is_array_index(uint32_t k, uint32_t* idx);
static inline int prop_cache_receiver(const ts_object* o, ts_key key){
  if (o->h.kind == TS_KIND_OBJECT) return 1;
  if (o->h.kind != TS_KIND_ARRAY) return 0;
  /* An array: any named key but the virtual `length` and the index-like
     names ("1" through a dynamic key is an element). */
  uint32_t idx;
  return !field_name_is(key, "length") && !prop_key_is_array_index(key, &idx);
}
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

/* Object.freeze / Object.isFrozen / Object.create. Integrity remains logically
   separate from hidden-class identity; write caches consult it on every hit.
   The packed physical word may conservatively invalidate a read-cache entry. */
/* Freezing makes every own property read-only: an object that is some
   receiver's prototype then rejects inherited writes, so the addition caches
   (keyed by receiver shape and prototype identity, not the prototype's
   attributes) must start over. */
/* A view with elements cannot be frozen (its elements stay writable): as in
   V8, the attempt leaves it non-extensible and throws. Sealing one throws
   while it is extensible. */
static void ta_integrity_check(tsv v, int freeze){
  if (TS_RT_LIKELY(!ts_is_typed_array(v)) || !((ts_typedarray*)ts_ptr(v))->length) return;
  ts_object* o = (ts_object*)ts_ptr(v);
  if (freeze){
    ts_obj_add_integrity(o, 2u);
    ts_throw_type_error_msg("Cannot freeze array buffer views with elements");
  }
  if (!(ts_obj_integrity(o) & (1u|2u|4u))) ts_throw_type_error_msg("Cannot seal array buffer views with elements");
}
tsv ts_object_freeze(tsv v){ if (ts_is_propbag(v)){ ta_integrity_check(v, 1); ts_obj_add_integrity((ts_object*)ts_ptr(v), 1u); prop_add_epoch_bump(); } return v; }
tsv ts_object_is_frozen(tsv v){
  /* primitives are trivially "frozen" in JS; objects: check the flag. */
  return ts_bool(!ts_is_propbag(v) || (ts_obj_integrity((ts_object*)ts_ptr(v)) & 1u));
}
tsv ts_object_create(tsv proto){
  /* The result is a plain object even when `proto` carries a registered
     class layout: the dynamic paths treat it as such (struct fields exist
     only in sized instances), while a TYPED read of a declared field on it
     (`(Object.create(C.prototype) as C).m()`) still assumes the layout the
     cell lacks — an open hazard noted in docs/TODO.md (Session 350). */
  tsv o = ts_new_proto();                 /* bare object: proto=NULL */
  if (ts_is_propbag(proto)){
    ((ts_object*)ts_ptr(o))->proto = proto;
    if (!(g_typed_slow & TS_TYPED_SLOW_ANY)) typed_slow_check_relink(o, proto);
  }
  return o;                               /* Object.create(null) keeps proto=NULL */
}
/* bit0=frozen, bit1=non-extensible, bit2=sealed. seal/freeze imply
   non-extensible; freeze implies sealed. See ts_set / ts_delete_prop guards. */
tsv ts_object_seal(tsv v){ if (ts_is_propbag(v)){ ta_integrity_check(v, 0); ts_obj_add_integrity((ts_object*)ts_ptr(v), 4u); } return v; }
tsv ts_object_prevent_extensions(tsv v){ if (g_has_proxies && ts_is_proxy(v)){ ts_proxy_prevent_extensions(v); return v; } if (ts_is_propbag(v)) ts_obj_add_integrity((ts_object*)ts_ptr(v), 2u); return v; }
tsv ts_object_is_sealed(tsv v){
  return ts_bool(!ts_is_propbag(v) || (ts_obj_integrity((ts_object*)ts_ptr(v)) & (1u|4u)));
}
tsv ts_object_is_extensible(tsv v){
  if (g_has_proxies && ts_is_proxy(v)) return ts_bool(ts_proxy_is_extensible(v));
  return ts_bool(ts_is_propbag(v) && (ts_obj_integrity((ts_object*)ts_ptr(v)) & (1u|2u|4u)) == 0);
}
/* Frozen check used by the array mutators (pop/shift/sort/...): a frozen array
   must not be mutated. */
static inline int ts_arr_frozen(tsv v){ return (ts_obj_integrity(&((ts_array*)ts_ptr(v))->o) & 1u) != 0; }
tsv ts_get(tsv obj, ts_key key){
  if (g_has_proxies && ts_is_proxy(obj)) return ts_proxy_get_v(obj, ts_key_to_value(key), obj);
  /* JSON and object-literal traffic overwhelmingly lands here. Bypass the
     primitive/function/promise ladder for an ordinary object while preserving
     the proxy gate above and the canonical lookup semantics below. */
  if (TS_TOP16(obj) == TS_SEL_OBJECT){
    ts_object* fast = (ts_object*)ts_ptr(obj);
    if (fast->h.kind == TS_KIND_OBJECT){
      size_t off; int numeric;
      if (g_has_class_regs && class_field_lookup(fast, key, &off, &numeric))
        return struct_field_get(fast, off, numeric);
      tsv found;
      if (lookup_prop_chain(obj, fast, key, &found)) return found;
      return TS_UNDEFINED;
    }
    if (TS_RT_UNLIKELY(ts_kind_is_buffer_or_view(fast->h.kind)))
      return fast->h.kind == TS_KIND_TYPEDARRAY ? ta_get_key(obj, key) : ab_get_key(obj, key);
  }
  /* Primitives are not prop-bags, but a string exposes the usual String exotic
     own properties (`length` and indexed characters) and then resolves methods
     through String.prototype. This lets both `(x as any)[0]` and
     `(x as any).toUpperCase()` work through the dynamic property path. */
  if (ts_is_str(obj)){
    tsv own;
    if (ts_string_own_prop(obj, key, &own)) return own;
    tsv found;
    if (lookup_prop_chain(obj, ts_proto_ptr(g_string_proto_v), key, &found)) return found;
    return TS_UNDEFINED;
  }
  /* Same primitive-dispatch path for numbers: a method call on an any-typed value
     holding a number (`(x as any).toFixed(2)`) resolves via Number.prototype. */
  if (ts_is_num(obj)){
    tsv found;
    if (lookup_prop_chain(obj, ts_proto_ptr(g_number_proto_v), key, &found)) return found;
    return TS_UNDEFINED;
  }
  if (ts_is_bool(obj)){
    tsv found;
    if (lookup_prop_chain(obj, ts_proto_ptr(g_boolean_proto_v), key, &found)) return found;
    return TS_UNDEFINED;
  }
  /* functions: `fn.name` / `fn.length` derive from the boxed metadata (not the
     prop map). Resolve the field keys lazily and cache. Other keys fall through
     to the prototype walk below (Function.prototype.call/apply/bind). */
  if (ts_is_func(obj)){
    fn_keys_init();
    ts_func* f = ts_ptr(obj);
    if (key == g_fn_key_prototype && fn_has_own_prototype(f)){
      f = fn_materialize_prototype(f, obj);
      return f->prototype_prop;
    }
    ts_object* sc = ts_class_static_container(obj);
    if (sc){
      tsv found;
      if (lookup_prop_chain_until(obj, sc, ts_proto_ptr(g_object_proto_v), key, &found)) return found;
    }
    { int which = fn_virtual(f, key); if (which) return fn_virtual_value(f, which); }
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
    tsv found;
    if (lookup_prop_chain(obj, ts_proto_ptr(g_promise_proto_v), key, &found)) return found;
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
  if (ts_is_indexed_array_fast(obj)){
    const char* nm = ts_field_name(key);
    if (nm){
      uint32_t nm_len = ts_field_name_len(key);
      if (field_bytes_is(nm, nm_len, "length")) return ts_num((double)ts_array_len(obj));
      uint32_t idx;
      if (prop_key_is_array_index(key, &idx) && idx < ts_array_len(obj)){
        return ts_array_get(obj, idx);
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
      for (ts_object* p=o; p; ){                   /* own + inherited data props (field key) */
        if (chain_link_exotic(p)){
          tsv out; ts_object* next;
          if (chain_exotic_get(p, field_key, recv, &out, &next)) return out;
          p = next;
          continue;
        }
        tsv* s = find_slot(p, field_key, 0);
        if (s) return *s;                        /* present (any type, incl. undefined) wins */
        p = ts_next_proto(p);
      }
    }
  }
  /* No data property found: resolve the inherited prototype METHOD. ts_get handles
     the method-key proto walk for every receiver kind (object/array/string/number/
     func), so primitives and functions dispatch correctly too. */
  return ts_get(recv, method_key);
}
static void ts_throw_getter_only_write(ts_key key){
  const char* nm = ts_field_name(key);
  char buf[256];
  snprintf(buf, sizeof(buf), "Cannot set property %s of #<Object> which has only a getter",
           nm ? nm : "?");
  ts_throw_type_error_msg(buf);
}
static void invoke_setter(ts_accessor* ac, tsv obj, ts_key key, tsv val){
  if (!ts_is_func(ac->setter)){
    ts_throw_getter_only_write(key);
    return;
  }
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
static ts_pref ts_set_named_prop(tsv obj, ts_object* o, ts_key key, tsv val,
                                  int check_struct_fields){
  const int frozen = (ts_obj_integrity(o) & 1u) != 0;   /* Object.freeze */
  if (check_struct_fields && g_has_class_regs){
    size_t off; int numeric;
    if (class_field_lookup(o, key, &off, &numeric)){
      if (frozen){ ts_throw_readonly_write(key); return PREF_NONE; }
      struct_field_set(o, off, numeric, val);
      return PREF_NONE;
    }
  }
  /* 1) own prop slot? if accessor -> setter; if data -> overwrite (strict: a
     frozen object or a non-writable data property throws). */
  ts_pref ownp=prop_find(o,key);
  if (pref_ok(ownp)){
    if (pref_is_accessor(ownp)){
      /* The setter runs user code: it may collect (a young receiver moves,
         and ownp holds its old address) or change the receiver's layout, so
         nothing about ownp is valid afterwards; the caller's cache fill must
         not use it (found by the protect mode, docs/gc_v2_design.md §6.5). */
      invoke_setter((ts_accessor*)ts_ptr(pref_val(ownp)), obj, key, val);
      return PREF_NONE;
    }
    if (frozen || !pref_is_writable(ownp)){ ts_throw_readonly_write(key); return PREF_NONE; }
    { tsv* vp = pref_valp(ownp); *vp = val;
      if (obj_shaped(o)) ts_write_barrier_ptr(obj, vp, val); else ts_write_barrier(obj, val); }
    return ownp;
  }
  /* 2) inherited property up the proto chain: an accessor invokes its setter
     (this=obj); a read-only data property (its own attribute, or a frozen
     holder) rejects the write (OrdinarySet: strict mode throws); a writable
     one lets the receiver create its own property. */
  for (ts_object* p=ts_next_proto(o); p; ){
    if (TS_RT_UNLIKELY(p->h.kind == TS_KIND_FUNC)){
      /* a function link: its read-only `name` and `length`, and its
         `prototype` (writable for a function, so the receiver gets its own;
         not for a class or a frozen function) */
      ts_func* lf = (ts_func*)p;
      fn_keys_init();
      if (key == g_fn_key_prototype && fn_has_own_prototype(lf)){
        if (lf->class_id || (ts_obj_integrity(p) & 1u)){ ts_throw_readonly_write(key); return PREF_NONE; }
        break;
      }
      if (fn_virtual(lf, key)){ ts_throw_readonly_write(key); return PREF_NONE; }
    }
    if (chain_link_exotic(p)){
      /* a proxy's [[Set]] with this receiver (its set trap decides), or the
         ordinary set going on at its target; the trap or a getter of the
         handler may collect, so the receiver is re-read afterwards */
      ts_object* next;
      ts_gc_root(&obj); ts_gc_root(&val);
      int done = chain_exotic_set(p, key, obj, val, &next);
      ts_gc_unroot(2);
      o = (ts_object*)ts_ptr(obj);
      if (done) return PREF_NONE;
      p = next;
      continue;
    }
    tsv* s=find_slot(p,key,0);
    if (s){
      if (is_accessor(*s)){
        invoke_setter((ts_accessor*)ts_ptr(*s), obj, key, val);
        return PREF_NONE;
      }
      ts_pref ip = prop_find(p, key);
      if ((ts_obj_integrity(p) & 1u) || (pref_ok(ip) && !pref_is_writable(ip))){
        ts_throw_readonly_write(key); return PREF_NONE;
      }
      break;   /* inherited writable data property: create an own data prop */
    }
    p = ts_next_proto(p);
  }
  /* 3) create an own data property — strict: throw on a non-extensible object
     (frozen bit0 / preventExtensions bit1 / sealed bit2). */
  if (ts_obj_integrity(o) & (1u|2u|4u)){ ts_throw_not_extensible(key); return PREF_NONE; }
  ts_pref created = find_prop(o,key,1);
  { tsv* vp = pref_valp(created); *vp = val;
    /* slot-precise for a shaped receiver: an old object remembers one card,
       not a whole-cell scan (the slow addition path ran 1.2M times a compile) */
    if (obj_shaped(o)) ts_write_barrier_ptr(obj, vp, val); else ts_write_barrier(obj, val); }
  return created;
}
void ts_set(tsv obj, ts_key key, tsv val){
  if (g_has_proxies && ts_is_proxy(obj)){ ts_proxy_set_v(obj, ts_key_to_value(key), val, obj); return; }
  /* Keep the dominant ordinary-object case out of the tag ladder and class
     static/function dispatch below. ts_set_named_prop owns the unchanged write
     ordering (struct field, own slot, inherited accessor, create). */
  if (TS_TOP16(obj) == TS_SEL_OBJECT){
    ts_object* fast = (ts_object*)ts_ptr(obj);
    if (fast->h.kind == TS_KIND_OBJECT){
      (void)ts_set_named_prop(obj, fast, key, val, 1);
      return;
    }
    if (TS_RT_UNLIKELY(ts_kind_is_buffer_or_view(fast->h.kind))){
      if (fast->h.kind == TS_KIND_TYPEDARRAY){ ta_set_key(obj, key, val); return; }
      if (key == ts_intern_field("byteLength", 10) && !find_slot(fast, key, 0)){
        ts_throw_type_error_msg(((ts_arraybuffer*)ts_ptr(obj))->shared
          ? "Cannot set property byteLength of #<SharedArrayBuffer> which has only a getter"
          : "Cannot set property byteLength of #<ArrayBuffer> which has only a getter");
        return;
      }
    }
  }
  if (!ts_is_propbag(obj)){ ts_throw_bad_write_receiver(obj, key); return; }
  if (ts_is_func(obj)){
    ts_func* f = (ts_func*)ts_ptr(obj);
    fn_keys_init();
    if (key == g_fn_key_prototype && fn_has_own_prototype(f)){
      /* a class's prototype is not writable, nor a frozen function's */
      if (ts_is_class_value(obj) || (ts_obj_integrity(&f->o) & 1u)){ ts_throw_readonly_write(key); return; }
      f->prototype_prop = val; f->ctor_pending = 0; f->proto_lazy = 0; ts_write_barrier(obj, val);
      return;
    }
    /* `name` and `length` are read-only (docs/function_own_properties_design.md) */
    if (fn_virtual(f, key)){ ts_throw_readonly_write(key); return; }
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
  const int frozen = (ts_obj_integrity(o) & 1u) != 0;   /* Object.freeze */
  if (ts_is_indexed_array_fast(obj)){
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
  (void)ts_set_named_prop(obj, o, key, val, 0);
}

void ts_global_this_init(void){
  if (g_global_this_v != TS_UNDEFINED) return;
  static int rooted = 0;
  g_global_this_v = ts_new_object();
  ts_root_static_once(&g_global_this_v, &rooted);
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
/* An identifier that names a value of the environment (an ambient
   declaration) resolves to the global object's property: reading or (strict)
   assigning one that is not there is a ReferenceError, as for any
   unresolvable reference. */
static void ts_throw_not_defined(const char* name);
tsv ts_global_get_ref(const char* name){
  ts_global_this_init();
  ts_key key = ts_intern_field(name, (uint32_t)strlen(name));
  if (!ts_has_prop(g_global_this_v, key)) ts_throw_not_defined(name);
  return ts_get(g_global_this_v, key);
}
void ts_global_assign_ref(const char* name, tsv val){
  ts_global_this_init();
  ts_key key = ts_intern_field(name, (uint32_t)strlen(name));
  ts_gc_root(&val);
  if (!ts_has_prop(g_global_this_v, key)) ts_throw_not_defined(name);
  ts_set(g_global_this_v, key, val);
  ts_gc_unroot(1);
}
void ts_global_var_decl(const char* name){
  ts_global_this_init();
  if (!name) return;
  uint32_t key = ts_intern_field(name, (uint32_t)strlen(name));
  ts_object* g = (ts_object*)ts_ptr(g_global_this_v);
  if (!find_slot(g, key, 0)) ts_set(g_global_this_v, key, TS_UNDEFINED);
}

/* A string's key without a heap copy of its bytes: an ASCII string's own
   bytes are its key bytes; a short one converts into a stack buffer (the
   encoding of ts_str_key_bytes_copy_view: lone surrogates kept). */
static ts_key ts_intern_view(ts_strview x){
  if (x.data && (x.flags & TS_STR_FLAG_ASCII)) return ts_intern_field(x.data, x.len);
  if (x.len <= 64u){
    char buf[64u * 3u + 1u];
    uint32_t o = 0;
    for (uint32_t i = 0; i < x.len; i++){
      uint32_t cp = ts_str_cu_at_view(x, i);
      if (cp >= 0xD800u && cp <= 0xDBFFu && i + 1 < x.len){
        uint16_t lo = ts_str_cu_at_view(x, i + 1);
        if (lo >= 0xDC00u && lo <= 0xDFFFu){ cp = 0x10000u + (((cp - 0xD800u) << 10) | (lo - 0xDC00u)); i++; }
      }
      if (cp < 0x80u) buf[o++] = (char)cp;
      else if (cp < 0x800u){ buf[o++] = (char)(0xC0u | (cp >> 6)); buf[o++] = (char)(0x80u | (cp & 0x3Fu)); }
      else if (cp < 0x10000u){ buf[o++] = (char)(0xE0u | (cp >> 12)); buf[o++] = (char)(0x80u | ((cp >> 6) & 0x3Fu)); buf[o++] = (char)(0x80u | (cp & 0x3Fu)); }
      else { buf[o++] = (char)(0xF0u | (cp >> 18)); buf[o++] = (char)(0x80u | ((cp >> 12) & 0x3Fu)); buf[o++] = (char)(0x80u | ((cp >> 6) & 0x3Fu)); buf[o++] = (char)(0x80u | (cp & 0x3Fu)); }
    }
    return ts_intern_field(buf, o);
  }
  uint32_t len = 0;
  char* bytes = ts_str_key_bytes_copy_view(x, &len);
  ts_key key = ts_intern_field(bytes, len);
  free(bytes);
  return key;
}
static ts_key ts_intern_string_value(tsv s){
  return ts_intern_view(ts_str_view_typed(s));
}
/* Keys of dynamic accesses (docs/dynamic_keys_design.md): a small
   non-negative integer (`forEachChildTable[node.kind]`) through a table of
   its interned decimal form, other integers formatted on the stack, and a
   string literal (static, never freed: `hasOwnProperty("pos")`) through a
   direct-mapped cache by identity. Entries hold key + 1 (0 is a key). */
#define TS_INT_KEY_CACHE 4096u
#define TS_LIT_KEY_CACHE 1024u
static uint32_t g_int_key_cache[TS_INT_KEY_CACHE];
static struct { tsv s; uint32_t key1; } g_lit_key_cache[TS_LIT_KEY_CACHE];

/* Coerce a JS property key value to the runtime key id (ECMAScript ToPropertyKey):
   symbols stay symbol keys; everything else is ToString + string interning.
   Callers that need other live values preserved across ToString must root those
   values around this helper; the key itself and produced string are protected here. */
static int ts_key_from_value(tsv keyv, ts_key* out){
  if (ts_is_symbol(keyv)){
    *out = ts_symbol_key(keyv);
    return 1;
  }
  if (g_key_caches){
    if (ts_is_num(keyv)){
      double d = ts_to_num(keyv);
      if (d >= 0.0 && d < (double)TS_INT_KEY_CACHE){
        uint32_t i = (uint32_t)d;
        if ((double)i == d){                     /* -0 too: its key is "0" */
          uint32_t k1 = g_int_key_cache[i];
          if (TS_RT_LIKELY(k1)){ *out = k1 - 1u; return 1; }
          char buf[16]; int n = ts_i64_to_str((long long)i, buf);
          ts_key k = ts_intern_field(buf, (uint32_t)n);
          g_int_key_cache[i] = k + 1u;
          *out = k;
          return 1;
        }
      }
      if (d > -9e15 && d < 9e15 && d == (double)(long long)d && !(d == 0.0 && 1.0 / d < 0)){
        char buf[24]; int n = ts_i64_to_str((long long)d, buf);
        *out = ts_intern_field(buf, (uint32_t)n);
        return 1;
      }
    } else if (ts_is_heap_str(keyv) && (ts_str_flags_typed(keyv) & TS_STR_FLAG_STATIC)){
      uint64_t x = (uint64_t)keyv ^ ((uint64_t)keyv >> 17);
      uint32_t slot = (uint32_t)(x >> 3) & (TS_LIT_KEY_CACHE - 1u);
      if (g_lit_key_cache[slot].s == keyv && g_lit_key_cache[slot].key1){ *out = g_lit_key_cache[slot].key1 - 1u; return 1; }
      ts_key k = ts_intern_string_value(keyv);
      g_lit_key_cache[slot].s = keyv; g_lit_key_cache[slot].key1 = k + 1u;
      *out = k;
      return 1;
    }
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
  uint32_t str_len = ts_str_len_typed(obj);
  uint32_t nm_len = ts_field_name_len(key);
  if (field_bytes_is(nm, nm_len, "length")){
    if (out) *out = ts_num((double)str_len);
    return 1;
  }
  long ix = ts_canonical_array_index(nm, nm_len);
  if (ix >= 0 && (uint32_t)ix < str_len){
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
  /* Functions carry the same ts_obj_common prefix as ordinary objects.  They
     are valid ECMAScript property targets too (constructor statics and
     Function.prototype itself rely on this path). */
  if (!ts_is_obj(obj) && !ts_is_func(obj)) return;
  prop_add_epoch_bump();
  ts_gc_root(&obj); ts_gc_root(&getter); ts_gc_root(&setter);
  if (ts_is_func(obj)) fn_realize_virtual(obj, key);
  ts_accessor* ac = gc_alloc(sizeof(ts_accessor), TS_KIND_ACCESSOR);
  ac->getter = getter; ac->setter = setter;
  ac->g_this = (uint8_t)(g_this?1:0); ac->s_this = (uint8_t)(s_this?1:0);
  /* accessor attributes live in the slot flags. writable bit is unused for
     accessors (kept 0). enumerable/configurable per the descriptor. */
  uint8_t flags = (uint8_t)(TS_PROP_ACCESSOR |
                            (e?TS_PROP_ENUMERABLE:0) |
                            (c?TS_PROP_CONFIGURABLE:0));
  ts_pref p = props_define((ts_object*)ts_ptr(obj), key, flags);
  *pref_valp(p) = ts_obj(ac);
  ts_write_barrier(obj, pref_val(p));
  ts_gc_unroot(3);
}
/* back-compat: defineProperty accessor with default attributes (non-enumerable,
   non-configurable). Used where attributes aren't specified. */
void ts_define_accessor(tsv obj, ts_key key, tsv getter, tsv setter, int g_this, int s_this){
  ts_define_accessor_attr(obj, key, getter, setter, g_this, s_this, 0, 0);
}

/* accessor define with a runtime key (string/number coerced + interned). */
void ts_define_accessor_dyn(tsv obj, tsv keyv, tsv getter, tsv setter, int g_this, int s_this, int e, int c){
  if (!ts_is_obj(obj) && !ts_is_func(obj)) return;
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
  if ((!ts_is_obj(obj) && !ts_is_func(obj)) || !ts_is_symbol(sym)) return;
  ts_define_accessor_attr(obj, ts_symbol_key(sym), getter, setter, g_this, s_this, e, c);
}

/* Object.defineProperty data form: define (or redefine) a data property with
   explicit attributes. If e=w=c=1 this is identical to an ordinary property
   (it just sets the slot's value with the default flags). Otherwise the slot's
   flags record the attributes, honored by ts_set (writable), ts_delete_prop
   (configurable), and the enumeration path (enumerable). */
static int ta_define_index(tsv obj, ts_key key, uint32_t idx, unsigned present, tsv value, int e, int w, int c, int throws);
void ts_define_data(tsv obj, ts_key key, tsv value, int e, int w, int c){
  if (!ts_is_obj(obj) && !ts_is_func(obj)) return;
  { uint32_t idx;
    if (TS_RT_UNLIKELY(ts_is_typed_array(obj)) && ta_numeric_key(key, &idx)){
      (void)ta_define_index(obj, key, idx, 15u, value, e, w, c, 1);
      return;
    } }
  ts_gc_root(&obj); ts_gc_root(&value);
  if (ts_is_func(obj)) fn_realize_virtual(obj, key);
  ts_object* o = (ts_object*)ts_ptr(obj);
  uint8_t flags = (uint8_t)((e?TS_PROP_ENUMERABLE:0) | (w?TS_PROP_WRITABLE:0) | (c?TS_PROP_CONFIGURABLE:0));
  /* A read-only data property rejects inherited writes on every object that
     has this one as a prototype: the addition caches must start over (they
     validate the receiver's prototype by identity, not by its attributes). */
  if (!w) prop_add_epoch_bump();
  ts_pref p = props_define(o, key, flags);
  { tsv* vp = pref_valp(p); *vp = value;
    if (obj_shaped(o)) ts_write_barrier_ptr(obj, vp, value); else ts_write_barrier(obj, value); }
  ts_gc_unroot(2);
}

void ts_define_data_dyn(tsv obj, tsv keyv, tsv value, int e, int w, int c){
  if (!ts_is_obj(obj) && !ts_is_func(obj)) return;
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
  ts_pref mp = props_define(o, method_key, (uint8_t)(TS_PROP_WRITABLE | TS_PROP_CONFIGURABLE));
  *pref_valp(mp) = fv;
  ts_write_barrier(proto, fv);
  if (name){
    ts_pref fp = props_define(o, ts_intern_field(name, (uint32_t)strlen(name)),
                              (uint8_t)(TS_PROP_WRITABLE | TS_PROP_CONFIGURABLE));
    *pref_valp(fp) = fv;
    ts_write_barrier(proto, fv);
  }
  ts_gc_unroot(2);
}

/* ---------------- strings ---------------- */
ts_strview ts_str_view_typed_slow(tsv s){
  ts_string* x = ts_str_ptr_typed(s);
  ts_strview p = ts_str_view_typed(x->parent);
  uint32_t storage_flags = p.flags & (TS_STR_FLAG_ASCII | TS_STR_FLAG_UTF16);
  if (!p.data){
    ts_strview v = { NULL, x->len, x->hash,
      (x->flags & ~(TS_STR_FLAG_ASCII | TS_STR_FLAG_UTF16)) | storage_flags, 0 };
    char* bytes = (char*)&v.immediate;
    for (uint32_t i=0;i<x->len;i++){
      uint32_t cu = ts_str_cu_at_view(p, x->offset + i);
      if (i < 4u) bytes[i] = (char)cu;
      else v.hash = cu;
    }
    return v;
  }
  ts_strview v = {
    p.data + ((size_t)x->offset * ts_str_unit_size_flags(p.flags)),
    x->len,
    x->hash,
    (x->flags & ~(TS_STR_FLAG_ASCII | TS_STR_FLAG_UTF16)) | storage_flags,
    0
  };
  return v;
}

long long ts_str_find_forward_view_slow(ts_strview xs, ts_strview ns,
                                        long long start){
  if (start < 0) start = 0;
  if (ns.len == 0) return start > (long long)xs.len ? (long long)xs.len : start;
  if (ns.len > xs.len || start > (long long)xs.len - (long long)ns.len) return -1;
  if (xs.data && ns.data && ts_str_same_storage_width(xs, ns)){
    uint32_t w = ts_str_unit_size_flags(xs.flags);
    const char* xdata = xs.data;
    const char* ndata = ns.data;
    if (w == 1u){
      const char first = ndata[0];
      if (ns.len == 1){
        const char* hit = memchr(xdata + start, first, xs.len - (uint32_t)start);
        return hit ? (long long)(hit - xdata) : -1;
      }
      const char* cur = xdata + start;
      const char* end = xdata + (xs.len - ns.len + 1);
      while (cur < end){
        const char* hit = memchr(cur, first, (size_t)(end - cur));
        if (!hit) return -1;
        if (memcmp(hit + 1, ndata + 1, ns.len - 1) == 0)
          return (long long)(hit - xdata);
        cur = hit + 1;
      }
      return -1;
    }
    uint16_t first = ts_str_cu_at_contiguous(ns, 0);
    if (ns.len == 1){
      for (uint32_t i=(uint32_t)start;i<xs.len;i++)
        if (ts_str_cu_at_contiguous(xs, i) == first) return (long long)i;
      return -1;
    }
    uint16_t last = ts_str_cu_at_contiguous(ns, ns.len - 1);
    for (uint32_t i=(uint32_t)start;i<=xs.len-ns.len;i++){
      if (ts_str_cu_at_contiguous(xs, i) == first &&
          ts_str_cu_at_contiguous(xs, i + ns.len - 1) == last &&
          ts_str_region_eq(xs, i + 1, ns, 1, ns.len - 2))
        return (long long)i;
    }
    return -1;
  }
  uint16_t first = ts_str_cu_at_view(ns, 0);
  if (ns.len == 1)
    return ts_str_find_unit_view(xs, first, (uint32_t)start,
                                 xs.len - (uint32_t)start);
  for (uint32_t i=(uint32_t)start;i<=xs.len-ns.len;i++){
    if (ts_str_cu_at_view(xs, i) == first &&
        ts_str_region_eq(xs, i + 1, ns, 1, ns.len - 1))
      return (long long)i;
  }
  return -1;
}

long long ts_str_find_backward_view_slow(ts_strview xs, ts_strview ns,
                                         long long start){
  long long maxstart = (long long)xs.len - (long long)ns.len;
  if (ns.len == 0){
    if (start < 0) return 0;
    return start > (long long)xs.len ? (long long)xs.len : start;
  }
  if (ns.len > xs.len) return -1;
  if (start > maxstart) start = maxstart;
  if (start < 0) return -1;
  if (xs.data && ns.data && ts_str_same_storage_width(xs, ns)){
    uint16_t first = ts_str_cu_at_contiguous(ns, 0);
    uint16_t last = ts_str_cu_at_contiguous(ns, ns.len - 1);
    for (long long i = start; i >= 0; i--){
      if (ts_str_cu_at_contiguous(xs, (uint32_t)i) == first &&
          (ns.len == 1 ||
           (ts_str_cu_at_contiguous(xs, (uint32_t)i + ns.len - 1) == last &&
            ts_str_region_eq(xs, (uint32_t)i + 1, ns, 1, ns.len - 1))))
        return i;
    }
    return -1;
  }
  uint16_t first = ts_str_cu_at_view(ns, 0);
  uint16_t last = ts_str_cu_at_view(ns, ns.len - 1);
  for (long long i = start; i >= 0; i--){
    if (ts_str_cu_at_view(xs, (uint32_t)i) == first &&
        (ns.len == 1 ||
         (ts_str_cu_at_view(xs, (uint32_t)i + ns.len - 1) == last &&
          ts_str_region_eq(xs, (uint32_t)i + 1, ns, 1, ns.len - 1))))
      return i;
  }
  return -1;
}

long long ts_str_replace_literal_metric3(tsv s, tsv pat, tsv rep, tsv needle,
                                         long long char_idx, int all){
  if (!ts_is_str(s) || !ts_is_str(pat) || !ts_is_str(rep) || !ts_is_str(needle))
    return -1;
  ts_strview xs = ts_str_view_typed(s);
  ts_strview ps = ts_str_view_typed(pat);
  ts_strview rs = ts_str_view_typed(rep);
  ts_strview ns = ts_str_view_typed(needle);
  if (ps.len == 0 || ns.len != 1) return -1;
  if (ts_str_contains_unit(rs, '$')) return -1;
  uint16_t wanted = ts_str_cu_at_view(ns, 0);
  if (all && ps.len == 1 && rs.len == 1){
    /* A one-unit substitution preserves every position and the total length.
       Only occurrences of the replaced unit can change either metric, so do
       at most two source searches instead of visiting every replacement. */
    uint16_t from = ts_str_cu_at_view(ps, 0);
    uint16_t to = ts_str_cu_at_view(rs, 0);
    long long found = -1;
    if (wanted != from || wanted == to)
      found = ts_str_find_unit_view(xs, wanted, 0, xs.len);
    if (wanted == to && wanted != from){
      long long hit = ts_str_find_unit_view(xs, from, 0, xs.len);
      if (hit >= 0 && (found < 0 || hit < found)) found = hit;
    }
    long long ch = 0;
    if ((uint64_t)char_idx < (uint64_t)xs.len){
      ch = ts_str_cu_at_view(xs, (uint32_t)char_idx);
      if (ch == from) ch = to;
    }
    return (long long)xs.len + found + ch;
  }
  long long total = 0;
  long long found = -1;
  long long ch = 0;
  uint32_t pos = 0;
  int replaced = 0;
  for (;;){
    long long hit = all || !replaced ? ts_str_find_forward_view(xs, ps, pos) : -1;
    uint32_t seg_end = hit >= 0 ? (uint32_t)hit : xs.len;
    uint32_t seg_len = seg_end - pos;
    if (found < 0 && seg_len > 0){
      long long fh = ts_str_find_unit_view(xs, wanted, pos, seg_len);
      if (fh >= 0) found = total + (fh - (long long)pos);
    }
    if (char_idx >= total && char_idx < total + (long long)seg_len)
      ch = ts_str_cu_at_view(xs, pos + (uint32_t)(char_idx - total));
    total += seg_len;
    if (hit < 0) break;
    if (found < 0 && rs.len > 0){
      long long rh = ts_str_find_unit_view(rs, wanted, 0, rs.len);
      if (rh >= 0) found = total + rh;
    }
    if (char_idx >= total && char_idx < total + (long long)rs.len)
      ch = ts_str_cu_at_view(rs, (uint32_t)(char_idx - total));
    total += rs.len;
    pos = (uint32_t)hit + ps.len;
    replaced = 1;
  }
  return total + found + ch;
}

long long ts_str_split_join_metric3(tsv s, tsv sep, tsv join_sep,
                                    long long part_index){
  if (!ts_is_str(s) || !ts_is_str(sep) || !ts_is_str(join_sep) ||
      part_index < 0)
    return -1;
  ts_strview xs = ts_str_view_typed(s);
  ts_strview ss = ts_str_view_typed(sep);
  ts_strview js = ts_str_view_typed(join_sep);
  if (ss.len == 0) return -1;
  uint32_t pos = 0;
  uint32_t start = 0;
  uint32_t count = 0;
  uint32_t part_len = 0;
  int saw_part = 0;
  long long removed = 0;
  for (;;){
    long long hit = ts_str_find_forward_view(xs, ss, pos);
    uint32_t end = hit >= 0 ? (uint32_t)hit : xs.len;
    if ((long long)count == part_index){
      part_len = end - start;
      saw_part = 1;
    }
    count++;
    if (hit < 0) break;
    removed += ss.len;
    pos = (uint32_t)hit + ss.len;
    start = pos;
  }
  if (!saw_part) return -1;
  long long joined_len = (long long)xs.len - removed +
                         (long long)(count - 1) * (long long)js.len;
  return (long long)count + joined_len + (long long)part_len;
}

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
static uint32_t strhash_view(ts_strview v){
  uint32_t h=2166136261u;
  /* A flat one-byte string: the generic loop's two FNV-1a steps per code unit
     (low byte, then a zero high byte) fold into one multiply by the square of
     the prime, so the value is the same and the loop is one byte, one xor,
     one multiply (the checker hashes long fresh cache keys constantly). */
  if (v.data && !(v.flags & TS_STR_FLAG_UTF16)){
    const unsigned char* p = (const unsigned char*)v.data;
    for (uint32_t i=0;i<v.len;i++) h = (h ^ p[i]) * 637696617u;   /* 16777619^2 mod 2^32 */
    return h;
  }
  for(uint32_t i=0;i<v.len;i++){
    uint16_t cu=ts_str_cu_at_view(v,i);
    h^=(uint8_t)(cu&0xffu); h*=16777619u;
    h^=(uint8_t)(cu>>8); h*=16777619u;
  }
  return h;
}
static uint32_t ts_str_hash_of(tsv s){
  if (ts_is_short_str(s)) return strhash_view(ts_str_view_typed(s));
  ts_string* x = ts_str_ptr_typed(s);
  if (x->flags & TS_STR_FLAG_HASHED) return x->hash;
  ts_strview v = ts_str_view_typed(s);
  uint32_t h = strhash_view(v);
  /* A flat GC string owns immutable storage, and a view's content never
     changes either (a builder only extends beyond its views), so both cache
     their first demanded hash; the view slow path carries the cell's hash and
     flags into the strview. A view of an immediate parent stays uncached (its
     strview's hash field holds the fifth byte), as do pre-hashed literals. */
  if (!(x->flags & TS_STR_FLAG_STATIC) && v.data != NULL){
    x->hash = h;
    x->flags |= TS_STR_FLAG_HASHED;
  }
  return h;
}
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

/* Appendable flat storage. The buffer itself is internal and a JavaScript
   string always sees a stable-prefix VIEW of it. The allocation size is the
   capacity source of truth so moving GC can copy the cell without an external
   side table or pointer fixup. */
#define TS_SB_MIN 24u
static uint32_t ts_string_storage_capacity(const ts_string* str){
  uint32_t unit = ts_str_unit_size_flags(str->flags);
  if (str->h.size < sizeof(ts_string) + unit) return 0;
  size_t slots = (str->h.size - sizeof(ts_string)) / unit;
  if (slots == 0) return 0;
  slots--; /* preserve one trailing NUL code unit */
  return slots > UINT32_MAX ? UINT32_MAX : (uint32_t)slots;
}
static uint32_t ts_string_builder_capacity(uint32_t used){
  if (used > UINT32_MAX / 2u) return 0;
  uint64_t target = (uint64_t)used * 2u;
  if (target < 32u) target = 32u;
  uint64_t cap = 32u;
  while (cap < target && cap < 0x80000000ull) cap <<= 1;
  if (cap < target) cap = target;
  return cap <= UINT32_MAX ? (uint32_t)cap : 0;
}
static ts_string* ts_string_alloc_buffer(uint32_t capacity, uint32_t flags){
  ts_string* str = ts_string_alloc_storage(capacity, flags);
  str->len = 0;
  str->hash = 0;
  str->flags = (flags & TS_STR_FLAG_UTF16) | TS_STR_FLAG_BUFFER;
  return str;
}
static ts_string* ts_string_alloc_buffer_view(void){
  return gc_alloc(sizeof(ts_string) + 1, TS_KIND_STRING);
}
static void ts_string_init_buffer_view(ts_string* out, tsv parent, uint32_t len){
  out->len = len;
  out->hash = 0;
  out->flags = TS_STR_FLAG_VIEW;
  out->parent = parent;
  out->offset = 0;
  out->data[0] = 0;
}
static void ts_string_write_terminator(ts_string* str, uint32_t pos){
  uint32_t unit = ts_str_unit_size_flags(str->flags);
  memset(str->data + (size_t)pos * unit, 0, unit);
}
static int ts_string_extendable_parent(tsv lhs, uint32_t result_flags,
                                       uint32_t result_len, tsv* parent_out){
  if (!ts_is_heap_str(lhs)) return 0;
  ts_string* view = ts_str_ptr_typed(lhs);
  if (!(view->flags & TS_STR_FLAG_VIEW) || view->offset != 0) return 0;
  tsv parent_v = view->parent;
  if (!ts_is_heap_str(parent_v)) return 0;
  ts_string* parent = ts_str_ptr_typed(parent_v);
  if (!(parent->flags & TS_STR_FLAG_BUFFER)) return 0;
  if (view->len != parent->len) return 0; /* only the live tail may extend */
  if (((parent->flags ^ result_flags) & TS_STR_FLAG_UTF16) != 0) return 0;
  if (result_len > ts_string_storage_capacity(parent)) return 0;
  *parent_out = parent_v;
  return 1;
}
static void ts_str_copy_units(char* dst, uint32_t dst_flags, uint32_t dst_pos,
                              ts_strview src, uint32_t src_pos, uint32_t len){
  if (len == 0) return;
  if (src.data && ((dst_flags ^ src.flags) & TS_STR_FLAG_UTF16) == 0){
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
static tsv ts_ascii_small_string(uint32_t len, unsigned char c){
  char data[1] = { (char)c };
  return ts_short_str_ascii(data, len ? 1u : 0u);
}
static int ts_short_ascii_from_view(ts_strview src, uint32_t start,
                                    uint32_t len, tsv* out){
  if (len > TS_SHORTSTR_MAX) return 0;
  char data[TS_SHORTSTR_MAX];
  for (uint32_t i=0;i<len;i++){
    uint16_t cu = ts_str_cu_at_view(src, start + i);
    if (cu >= 0x80u) return 0;
    data[i] = (char)cu;
  }
  *out = ts_short_str_ascii(data, len);
  return 1;
}
tsv ts_new_string(const char* s, uint32_t len){
  uint32_t units = 0; int latin1 = 1, ascii = 1;
  utf8_measure(s, len, &units, &latin1, &ascii);
  if (ascii && units <= TS_SHORTSTR_MAX) return ts_short_str_ascii(s, units);
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
  if (len <= TS_SHORTSTR_MAX) return ts_short_str_ascii(s, len);
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
  if (ascii && len <= TS_SHORTSTR_MAX){
    char data[TS_SHORTSTR_MAX];
    for (uint32_t i=0;i<len;i++) data[i] = (char)units[i];
    return ts_short_str_ascii(data, len);
  }
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
  tsv short_result;
  if (ts_short_ascii_from_view(x, start, len, &short_result)){
    ts_gc_unroot(1);
    return short_result;
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
char* ts_string_utf8_copy(tsv src, uint32_t* out_len){
  return ts_string_cstr_copy(src, out_len);
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
/* Number::toString(x) for radix 10 (ECMA-262 6.1.6.1.20). s is the shortest
   digit string that reads back as x (k digits; the correctly rounded k-digit
   decimal, the closest one) and n its decimal exponent (x = 0.s * 10^n):
   - k <= n <= 21: the digits and n - k zeros;
   - 0 < n <= 21: the digits with the point after the n-th;
   - -6 < n <= 0: "0.", -n zeros, the digits;
   - otherwise the exponential form d[.ddd]e+/-(n-1).
   The digits come from the smallest %.*e precision that round-trips. */
static void ts_fmt_num(double d, char* buf, size_t n){
  if (d != d) { snprintf(buf,n,"NaN"); return; }
  if (d == 1.0/0.0) { snprintf(buf,n,"Infinity"); return; }
  if (d == -1.0/0.0) { snprintf(buf,n,"-Infinity"); return; }
  /* small integers: exact decimal via fast itoa */
  if (d == (double)(long long)d && d < 9e15 && d > -9e15) { ts_i64_to_str((long long)d, buf); return; }
  char tmp[48];
  int p;
  for (p = 0; p <= 16; p++){ snprintf(tmp, sizeof tmp, "%.*e", p, d); if (strtod(tmp, 0) == d) break; }
  if (p > 16) snprintf(tmp, sizeof tmp, "%.16e", d);
  const char* t = tmp;
  char out[64];
  int o = 0;
  if (*t == '-'){ out[o++] = '-'; t++; }
  char digits[24]; int k = 0;
  while (*t && *t != 'e' && *t != 'E'){ if (*t != '.') digits[k++] = *t; t++; }
  int e10 = (*t == 'e' || *t == 'E') ? atoi(t + 1) : 0;
  while (k > 1 && digits[k - 1] == '0') k--;     /* a shortest form has no trailing zero */
  int ne = e10 + 1;                               /* n: x = 0.digits * 10^n */
  if (k <= ne && ne <= 21){
    for (int i = 0; i < k; i++) out[o++] = digits[i];
    for (int i = k; i < ne; i++) out[o++] = '0';
  } else if (0 < ne && ne <= 21){
    for (int i = 0; i < ne; i++) out[o++] = digits[i];
    out[o++] = '.';
    for (int i = ne; i < k; i++) out[o++] = digits[i];
  } else if (-6 < ne && ne <= 0){
    out[o++] = '0'; out[o++] = '.';
    for (int i = 0; i < -ne; i++) out[o++] = '0';
    for (int i = 0; i < k; i++) out[o++] = digits[i];
  } else {
    out[o++] = digits[0];
    if (k > 1){ out[o++] = '.'; for (int i = 1; i < k; i++) out[o++] = digits[i]; }
    out[o++] = 'e';
    int x = ne - 1;
    out[o++] = x < 0 ? '-' : '+';
    char eb[8]; int el = snprintf(eb, sizeof eb, "%d", x < 0 ? -x : x);
    for (int i = 0; i < el; i++) out[o++] = eb[i];
  }
  out[o] = 0;
  snprintf(buf, n, "%s", out);
}

/* ---------------- Symbol (symbol_design.md) ---------------- */
static uint32_t g_next_sym_id = 0;   /* unique id per user symbol (0,1,2,...) */
/* Weak sym_id -> Symbol identity table. A user-symbol property key stores only
   TS_KEY_USERSYM(sym_id), so property scanning resolves that id through this
   table and marks the Symbol as a strong property-name edge. The table itself
   is deliberately NOT a GC root: an ordinary Symbol that is reachable only as
   a WeakMap/WeakSet key must be collectible. Dead slots are cleared after the
   ephemeron fixed point and before handle reuse. Symbol.for identities remain
   strongly held by g_symreg; well-known symbols use separate permanent roots. */
static tsv* g_sym_value = NULL;
static uint32_t g_sym_value_len = 0, g_sym_value_cap = 0;
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
  static int rooted[5];
  for (int i=0;i<5;i++){
    ts_symbol* s = gc_alloc(sizeof(ts_symbol), TS_KIND_SYMBOL);
    s->sym_id = g_next_sym_id++;     /* unique, though key uses wksym */
    s->wksym = (uint32_t)i;
    s->registered = 0;
    g_wksym_singletons[i] = ts_obj(s);
    ts_root_static_once(&g_wksym_singletons[i], &rooted[i]);
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
    if (g_symreg[i].sym == sym || ts_same_cell(g_symreg[i].sym, sym)) return g_symreg[i].key;
  }
  return TS_UNDEFINED;
}
/* sym.toString() -> "Symbol(desc)" (desc empty if undefined). */
tsv ts_symbol_tostring(tsv sym){
  if (!ts_is_symbol(sym)) return ts_new_string("Symbol()", 8);
  ts_symbol* s = (ts_symbol*)ts_ptr(sym);
  const char* d = ""; uint32_t dl = 0;
  ts_strview ds = {0};
  char ds_short[TS_SHORTSTR_MAX];
  if (ts_is_str(s->description)){
    ds = ts_str_view_typed(s->description);
    d = ts_str_view_data(&ds, ds_short);
    dl = ds.len;
  }
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

/* The seven `typeof` results are static string cells (hashed once at
   startup by ts_typeof_strings_init), never fresh allocations: `typeof x ===
   "string"` is one of the most frequent dispatch forms in compiler code. */
#define TS_TYPEOF_STATIC(name, text, n) \
  static struct { ts_gc_header h; uint32_t len, hash, flags; tsv parent; uint32_t offset; char data[n + 1]; } \
    name = { { TS_KIND_STRING, 0, TS_GEN_NONHEAP, 0, 0, 0 }, n, 0u, \
             TS_STR_FLAG_ASCII | TS_STR_FLAG_STATIC, TS_UNDEFINED, 0u, text };
TS_TYPEOF_STATIC(g_typeof_number, "number", 6)
TS_TYPEOF_STATIC(g_typeof_string, "string", 6)
TS_TYPEOF_STATIC(g_typeof_boolean, "boolean", 7)
TS_TYPEOF_STATIC(g_typeof_undefined, "undefined", 9)
TS_TYPEOF_STATIC(g_typeof_function, "function", 8)
TS_TYPEOF_STATIC(g_typeof_symbol, "symbol", 6)
TS_TYPEOF_STATIC(g_typeof_object, "object", 6)
#undef TS_TYPEOF_STATIC
static void ts_typeof_strings_init(void){
  ts_string* cells[7] = { (ts_string*)&g_typeof_number, (ts_string*)&g_typeof_string,
    (ts_string*)&g_typeof_boolean, (ts_string*)&g_typeof_undefined, (ts_string*)&g_typeof_function,
    (ts_string*)&g_typeof_symbol, (ts_string*)&g_typeof_object };
  for (int i = 0; i < 7; i++){
    cells[i]->hash = ts_str_hash_of(ts_str_v(cells[i]));
    cells[i]->flags |= TS_STR_FLAG_HASHED;
  }
}
tsv ts_typeof(tsv v){
  /* JS typeof. Note: typeof null === "object"; functions -> "function". */
  if (ts_is_num(v))  return ts_str_v(&g_typeof_number);
  if (ts_is_str(v))  return ts_str_v(&g_typeof_string);
  if (ts_is_bool(v)) return ts_str_v(&g_typeof_boolean);
  if (ts_is_undef(v))return ts_str_v(&g_typeof_undefined);
  if (ts_is_func(v)) return ts_str_v(&g_typeof_function);
  if (ts_is_symbol(v)) return ts_str_v(&g_typeof_symbol);
  return ts_str_v(&g_typeof_object); /* objects, arrays, null */
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
  static ts_rt_ic ic_source, ic_flags, ic_prefix, ic_mask;
  return ts_is_str(ts_get_ic(re, g_rx_k_source, &ic_source)) &&
         ts_is_str(ts_get_ic(re, g_rx_k_flags, &ic_flags)) &&
         (ts_is_str(ts_get_ic(re, g_rx_k_prefix, &ic_prefix)) || ts_is_num(ts_get_ic(re, g_rx_k_flags_mask, &ic_mask)));
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
  if (ts_is_indexed_array_fast(v)){
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
/* ---- `string + integer` without the intermediate number string ----
   The checker builds its cache keys this way (`result += startId` in
   getTypeListId, 1.5M concatenations per compile): the digits are formatted
   on the stack and copied into the one allocation the result needs. Only
   results below the builder threshold take this path; longer ones keep the
   general path and its append history. docs/string_concat_fast_paths_design.md */
static int ts_int_digits(double d, char* buf, uint32_t* len){
  if (!(d == (double)(long long)d && d < 9e15 && d > -9e15)) return 0;
  *len = (uint32_t)ts_i64_to_str((long long)d, buf);
  return 1;
}
static int ts_add_str_int_fast(tsv s, const char* digits, uint32_t nl, int digits_first, tsv* out){
  ts_strview x = ts_str_view_typed(s);
  uint64_t n64 = (uint64_t)x.len + nl;
  if (n64 >= TS_SB_MIN) return 0;
  uint32_t n = (uint32_t)n64;
  uint32_t flags = x.flags & TS_STR_FLAG_UTF16;
  int all_ascii = !!(x.flags & TS_STR_FLAG_ASCII);
  RT_STAT_INC(concat_calls); RT_STAT_ADD(concat_bytes, n);
  if (all_ascii && n <= TS_SHORTSTR_MAX){
    char data[TS_SHORTSTR_MAX];
    uint32_t pos = 0;
    if (digits_first){ for (uint32_t i=0;i<nl;i++) data[pos++] = digits[i]; for (uint32_t i=0;i<x.len;i++) data[pos++] = (char)ts_str_cu_at_view(x, i); }
    else { for (uint32_t i=0;i<x.len;i++) data[pos++] = (char)ts_str_cu_at_view(x, i); for (uint32_t i=0;i<nl;i++) data[pos++] = digits[i]; }
    *out = ts_short_str_ascii(data, n);
    RT_STAT_INC(short_string);
    return 1;
  }
  ts_gc_root(&s);
  ts_string* o = ts_string_alloc_storage(n, flags);
  x = ts_str_view_typed(s);                     /* the cell may have moved */
  ts_strview dv = { digits, nl, 0, TS_STR_FLAG_ASCII, 0 };
  if (digits_first){
    ts_str_copy_units(o->data, flags, 0, dv, 0, nl);
    ts_str_copy_units(o->data, flags, nl, x, 0, x.len);
  } else {
    ts_str_copy_units(o->data, flags, 0, x, 0, x.len);
    ts_str_copy_units(o->data, flags, x.len, dv, 0, nl);
  }
  o->flags = flags | (all_ascii ? TS_STR_FLAG_ASCII : 0);
  o->hash = 0;
  *out = ts_str_v(o);
  ts_gc_unroot(1);
  RT_STAT_INC(sb_flat);
  return 1;
}
/* `s + digits` at or above the builder threshold: the digits go straight into
   the builder (extending s's live buffer in place when s is its tail, else a
   fresh builder), with no temporary number string. digits_first (`n + s`)
   always starts a fresh builder. Returns 0 (general path) only when the
   result would not fit a builder. */
static int ts_add_str_digits_builder(tsv s, const char* digits, uint32_t nl, int digits_first, tsv* out){
  ts_strview x = ts_str_view_typed(s);
  uint64_t n64 = (uint64_t)x.len + nl;
  if (n64 > UINT32_MAX) return 0;
  uint32_t n = (uint32_t)n64;
  uint32_t flags = x.flags & TS_STR_FLAG_UTF16;
  int all_ascii = !!(x.flags & TS_STR_FLAG_ASCII);
  ts_strview dv = { digits, nl, 0, TS_STR_FLAG_ASCII, 0 };
  RT_STAT_INC(concat_calls); RT_STAT_ADD(concat_bytes, n);
  ts_gc_root(&s);
  tsv parent_v = TS_UNDEFINED;
  if (!digits_first && ts_string_extendable_parent(s, flags, n, &parent_v)){
    ts_gc_root(&parent_v);
    ts_string* out_cell = ts_string_alloc_buffer_view();
    ts_string* parent = ts_str_ptr_typed(parent_v);
    uint32_t old_len = parent->len;
    ts_str_copy_units(parent->data, parent->flags, old_len, dv, 0, nl);
    parent->len = n;
    parent->hash = 0;
    parent->flags = (parent->flags & ~(TS_STR_FLAG_ASCII | TS_STR_FLAG_HASHED)) |
                    (all_ascii ? TS_STR_FLAG_ASCII : 0);
    ts_string_write_terminator(parent, n);
    ts_string_init_buffer_view(out_cell, parent_v, n);
    *out = ts_str_v(out_cell);
    RT_STAT_INC(sb_extend);
    ts_gc_unroot(2);
    return 1;
  }
  uint32_t capacity = ts_string_builder_capacity(n);
  if (capacity == 0){ ts_gc_unroot(1); return 0; }
  ts_string* buffer = ts_string_alloc_buffer(capacity, flags);
  tsv buffer_v = ts_str_v(buffer);
  ts_gc_root(&buffer_v);
  ts_string* out_cell = ts_string_alloc_buffer_view();
  buffer = ts_str_ptr_typed(buffer_v);
  x = ts_str_view_typed(s);                     /* the cell may have moved */
  if (digits_first){
    ts_str_copy_units(buffer->data, flags, 0, dv, 0, nl);
    ts_str_copy_units(buffer->data, flags, nl, x, 0, x.len);
  } else {
    ts_str_copy_units(buffer->data, flags, 0, x, 0, x.len);
    ts_str_copy_units(buffer->data, flags, x.len, dv, 0, nl);
  }
  buffer->len = n;
  buffer->hash = 0;
  buffer->flags = TS_STR_FLAG_BUFFER | flags | (all_ascii ? TS_STR_FLAG_ASCII : 0);
  ts_string_write_terminator(buffer, n);
  ts_string_init_buffer_view(out_cell, buffer_v, n);
  *out = ts_str_v(out_cell);
  RT_STAT_INC(sb_fresh);
  ts_gc_unroot(2);
  return 1;
}
tsv ts_add(tsv a, tsv b){
  if (ts_is_num(a)&&ts_is_num(b)) return ts_num(ts_to_num(a)+ts_to_num(b));
  if (ts_is_str(a) && ts_is_num(b)){
    char nb[24]; uint32_t nl; tsv r;
    if (ts_int_digits(ts_to_num(b), nb, &nl) &&
        (ts_add_str_int_fast(a, nb, nl, 0, &r) || ts_add_str_digits_builder(a, nb, nl, 0, &r))) return r;
  } else if (ts_is_num(a) && ts_is_str(b)){
    char nb[24]; uint32_t nl; tsv r;
    if (ts_int_digits(ts_to_num(a), nb, &nl) &&
        (ts_add_str_int_fast(b, nb, nl, 1, &r) || ts_add_str_digits_builder(b, nb, nl, 1, &r))) return r;
  }
  /* JS `+`: ToPrimitive(default) each operand first. An object becomes its
     valueOf()/toString()/Symbol.toPrimitive("default") result, so `o + 5` and
     `o + ""` follow spec instead of silently yielding 0. */
  if ((ts_object_like(a)&&!ts_is_symbol(a)) || (ts_object_like(b)&&!ts_is_symbol(b))){
    ts_gc_root(&a); ts_gc_root(&b);
    tsv pa = ts_to_primitive(a, 2);  /* hint: default */
    ts_gc_root(&pa);                 /* the second conversion may collect */
    tsv pb = ts_to_primitive(b, 2);
    ts_gc_unroot(3);
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
    uint64_t n64=(uint64_t)x.len+(uint64_t)y.len;
    if (n64 > UINT32_MAX){
      ts_gc_unroot(4);
      fprintf(stderr, "tsaot: RangeError: concatenated string too large\n");
      abort();
    }
    uint32_t n=(uint32_t)n64;
    uint32_t flags = (x.flags | y.flags) & TS_STR_FLAG_UTF16;
    int all_ascii = !!(x.flags & TS_STR_FLAG_ASCII) && !!(y.flags & TS_STR_FLAG_ASCII);
    RT_STAT_INC(concat_calls); RT_STAT_ADD(concat_bytes, n);
    if (all_ascii && n <= TS_SHORTSTR_MAX){
      char data[TS_SHORTSTR_MAX];
      for (uint32_t i=0;i<x.len;i++) data[i] = (char)ts_str_cu_at_view(x, i);
      for (uint32_t i=0;i<y.len;i++) data[x.len+i] = (char)ts_str_cu_at_view(y, i);
      tsv r = ts_short_str_ascii(data, n);
      RT_STAT_INC(short_string);
      ts_gc_unroot(4);
      return r;
    }

    /* Linear append history: allocate the public prefix view before mutating
       its hidden parent, then re-fetch every movable pointer after allocation. */
    tsv parent_v = TS_UNDEFINED;
    if (n >= TS_SB_MIN && ts_string_extendable_parent(sa, flags, n, &parent_v)){
      ts_gc_root(&parent_v);
      ts_string* out = ts_string_alloc_buffer_view();
      ts_string* parent = ts_str_ptr_typed(parent_v);
      y = ts_str_view_typed(sb);
      uint32_t old_len = parent->len;
      ts_str_copy_units(parent->data, parent->flags, old_len, y, 0, y.len);
      parent->len = n;
      parent->hash = 0;
      parent->flags = (parent->flags & ~(TS_STR_FLAG_ASCII | TS_STR_FLAG_HASHED)) |
                      (all_ascii ? TS_STR_FLAG_ASCII : 0);
      ts_string_write_terminator(parent, n);
      ts_string_init_buffer_view(out, parent_v, n);
      tsv r = ts_str_v(out);
      RT_STAT_INC(sb_extend);
      ts_gc_unroot(5);
      return r;
    }

    /* Start or grow a builder. A copied prefix becomes immutable as soon as a
       later branch advances the old buffer's high-water mark. */
    uint32_t capacity = n >= TS_SB_MIN ? ts_string_builder_capacity(n) : 0;
    if (capacity != 0){
      ts_string* buffer = ts_string_alloc_buffer(capacity, flags);
      tsv buffer_v = ts_str_v(buffer);
      ts_gc_root(&buffer_v);
      ts_string* out = ts_string_alloc_buffer_view();
      buffer = ts_str_ptr_typed(buffer_v);
      x = ts_str_view_typed(sa);
      y = ts_str_view_typed(sb);
      ts_str_copy_units(buffer->data, flags, 0, x, 0, x.len);
      ts_str_copy_units(buffer->data, flags, x.len, y, 0, y.len);
      buffer->len = n;
      buffer->hash = 0;
      buffer->flags = TS_STR_FLAG_BUFFER | flags |
                      (all_ascii ? TS_STR_FLAG_ASCII : 0);
      ts_string_write_terminator(buffer, n);
      ts_string_init_buffer_view(out, buffer_v, n);
      tsv r = ts_str_v(out);
      RT_STAT_INC(sb_fresh);
      ts_gc_unroot(5);
      return r;
    }

    RT_STAT_INC(sb_flat);
    ts_string* out = ts_string_alloc_storage(n, flags);
    x=ts_str_view_typed(sa); y=ts_str_view_typed(sb);
    ts_str_copy_units(out->data, flags, 0, x, 0, x.len);
    ts_str_copy_units(out->data, flags, x.len, y, 0, y.len);
    out->flags = flags | (all_ascii ? TS_STR_FLAG_ASCII : 0);
    out->hash = 0; /* lazy: content consumers hash on first demand */
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

  enum { TS_CONCAT_STACK_PARTS = 16 };
  tsv stack_parts[TS_CONCAT_STACK_PARTS];
  tsv* parts = n <= TS_CONCAT_STACK_PARTS
    ? stack_parts
    : (tsv*)malloc(sizeof(tsv) * (size_t)n);
  int heap_parts = parts != stack_parts;
  int rooted = 0;
  uint64_t total = 0;
  uint32_t out_flags = 0;
  int all_ascii = 1;
  /* integer parts (`${sourceId},${targetId}`) are formatted on the stack and
     never become strings of their own (docs/string_concat_fast_paths_design.md) */
  char digit_buf[TS_CONCAT_STACK_PARTS][24];
  uint32_t digit_len[TS_CONCAT_STACK_PARTS];
  for (int i=0;i<TS_CONCAT_STACK_PARTS;i++) digit_len[i] = 0;
#define PART_VIEW(i) ((!heap_parts && digit_len[i]) \
    ? (ts_strview){ digit_buf[i], digit_len[i], 0, TS_STR_FLAG_ASCII, 0 } \
    : ts_str_view_typed(parts[i]))
  for(int i=0;i<n;i++){
    parts[i] = args[i];
    ts_gc_root(&parts[i]);
    rooted++;
    if (!ts_is_str(parts[i])){
      if (!heap_parts && ts_is_num(parts[i]) && ts_int_digits(ts_to_num(parts[i]), digit_buf[i], &digit_len[i])){
        /* digits stay on the stack; parts[i] keeps the number (never read as a string) */
      } else parts[i] = ts_to_string_v(parts[i]);
    }
    ts_strview v = PART_VIEW(i);
    total += v.len;
    out_flags |= v.flags & TS_STR_FLAG_UTF16;
    all_ascii = all_ascii && !!(v.flags & TS_STR_FLAG_ASCII);
    if(total > UINT32_MAX){
      ts_gc_unroot(rooted);
      if (heap_parts) free(parts);
      fprintf(stderr, "tsaot: RangeError: concatenated string too large\n");
      abort();
    }
  }
  if(total == 0){
    ts_gc_unroot(rooted);
    if (heap_parts) free(parts);
    return ts_new_string("",0);
  }

  RT_STAT_INC(concat_calls); RT_STAT_ADD(concat_bytes, total);

  if (all_ascii && total <= TS_SHORTSTR_MAX){
    char data[TS_SHORTSTR_MAX];
    uint32_t pos = 0;
    for(int i=0;i<n;i++){
      ts_strview v = PART_VIEW(i);
      for (uint32_t j=0;j<v.len;j++) data[pos++] = (char)ts_str_cu_at_view(v, j);
    }
    tsv r = ts_short_str_ascii(data, (uint32_t)total);
    RT_STAT_INC(short_string);
    ts_gc_unroot(rooted);
    if (heap_parts) free(parts);
    return r;
  }

  ts_strview first = PART_VIEW(0);
  if (total == first.len && !(!heap_parts && digit_len[0])){
    tsv r = parts[0];
    ts_gc_unroot(rooted);
    if (heap_parts) free(parts);
    return r;
  }

  tsv parent_v = TS_UNDEFINED;
  if (total >= TS_SB_MIN && !(!heap_parts && digit_len[0]) &&
      ts_string_extendable_parent(parts[0], out_flags, (uint32_t)total, &parent_v)){
    ts_gc_root(&parent_v);
    ts_string* out = ts_string_alloc_buffer_view();
    ts_string* parent = ts_str_ptr_typed(parent_v);
    uint32_t pos = parent->len;
    for(int i=1;i<n;i++){
      ts_strview v = PART_VIEW(i);
      ts_str_copy_units(parent->data, parent->flags, pos, v, 0, v.len);
      pos += v.len;
    }
    parent->len = (uint32_t)total;
    parent->hash = 0;
    parent->flags = (parent->flags & ~(TS_STR_FLAG_ASCII | TS_STR_FLAG_HASHED)) |
                    (all_ascii ? TS_STR_FLAG_ASCII : 0);
    ts_string_write_terminator(parent, (uint32_t)total);
    ts_string_init_buffer_view(out, parent_v, (uint32_t)total);
    tsv r = ts_str_v(out);
    RT_STAT_INC(sb_extend);
    ts_gc_unroot(rooted + 1);
    if (heap_parts) free(parts);
    return r;
  }

  uint32_t capacity = total >= TS_SB_MIN
    ? ts_string_builder_capacity((uint32_t)total)
    : 0;
  if (capacity != 0){
    ts_string* buffer = ts_string_alloc_buffer(capacity, out_flags);
    tsv buffer_v = ts_str_v(buffer);
    ts_gc_root(&buffer_v);
    ts_string* out = ts_string_alloc_buffer_view();
    buffer = ts_str_ptr_typed(buffer_v);
    uint32_t pos = 0;
    for(int i=0;i<n;i++){
      ts_strview v = PART_VIEW(i);
      ts_str_copy_units(buffer->data, out_flags, pos, v, 0, v.len);
      pos += v.len;
    }
    buffer->len = (uint32_t)total;
    buffer->hash = 0;
    buffer->flags = TS_STR_FLAG_BUFFER | out_flags |
                    (all_ascii ? TS_STR_FLAG_ASCII : 0);
    ts_string_write_terminator(buffer, (uint32_t)total);
    ts_string_init_buffer_view(out, buffer_v, (uint32_t)total);
    tsv r = ts_str_v(out);
    RT_STAT_INC(sb_fresh);
    ts_gc_unroot(rooted + 1);
    if (heap_parts) free(parts);
    return r;
  }

  RT_STAT_INC(sb_flat);
  ts_string* out = ts_string_alloc_storage((uint32_t)total, out_flags);
  uint32_t pos = 0;
  for(int i=0;i<n;i++){
    ts_strview v = PART_VIEW(i);
    ts_str_copy_units(out->data, out_flags, pos, v, 0, v.len);
    pos += v.len;
  }
  out->len = (uint32_t)total;
  out->flags = out_flags | (all_ascii ? TS_STR_FLAG_ASCII : 0);
  out->hash = 0; /* lazy: JSX/SSR output normally goes straight to a sink */
  out->parent = TS_UNDEFINED;
  out->offset = 0;
  tsv r = ts_str_v(out);
  ts_gc_unroot(rooted);
  if (heap_parts) free(parts);
  return r;
}
#undef PART_VIEW
/* Out-of-line tail of the header's ts_strict_eq: reached for two distinct
   string values (and kept complete so runtime callers may use it directly). */
int ts_strict_eq_str(tsv a, tsv b){
  /* two immediate short strings are canonical: different bits, different strings */
  if (ts_is_short_str(a) && ts_is_short_str(b)) return 0;
  /* different lengths: different strings, before any view is built
     (a string switch tests its discriminant against every label) */
  uint32_t la = ts_is_short_str(a) ? ts_short_str_len(a) : ts_str_ptr_typed(a)->len;
  uint32_t lb = ts_is_short_str(b) ? ts_short_str_len(b) : ts_str_ptr_typed(b)->len;
  if (la != lb) return 0;
  return ts_strict_eq_slow(a, b);
}
int32_t ts_to_int32_slow(double d){
  if (d != d || d == (1.0/0.0) || d == -(1.0/0.0)) return 0;
  double t = (d < 0) ? -floor(-d) : floor(d);   /* truncate toward zero */
  double m = fmod(t, 4294967296.0);             /* mod 2^32 */
  if (m < 0) m += 4294967296.0;
  uint32_t u = (uint32_t)m;
  return (int32_t)u;
}
uint32_t ts_to_uint32_slow(double d){
  if (d != d || d == (1.0/0.0) || d == -(1.0/0.0)) return 0;
  double t = (d < 0) ? -floor(-d) : floor(d);
  double m = fmod(t, 4294967296.0);
  if (m < 0) m += 4294967296.0;
  return (uint32_t)m;
}
int ts_strict_eq_slow(tsv a, tsv b){
  if (a == b) return !(ts_is_num(a) && ts_to_num(a) != ts_to_num(a));
  if (ts_is_num(a)&&ts_is_num(b)) return ts_to_num(a)==ts_to_num(b);
  if ((ts_is_obj(a) || ts_is_func(a)) && ts_same_cell(a, b)) return 1;
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
/* Code-unit order of two strings: -1, 0 or 1. Two one-byte strings compare
   with memcmp (their bytes are the code units). */
static int str_view_compare(ts_strview x, ts_strview y){
  uint32_t m = x.len < y.len ? x.len : y.len;
  if (x.data && y.data && !((x.flags | y.flags) & TS_STR_FLAG_UTF16)){
    int c = m ? memcmp(x.data, y.data, m) : 0;
    if (c) return c < 0 ? -1 : 1;
  } else {
    for (uint32_t i = 0; i < m; i++){
      uint16_t xc = ts_str_cu_at_view(x, i), yc = ts_str_cu_at_view(y, i);
      if (xc != yc) return xc < yc ? -1 : 1;
    }
  }
  return x.len < y.len ? -1 : (x.len > y.len ? 1 : 0);
}
int ts_relational_slow(tsv a, tsv b, int op){
  if (ts_is_num(a) && ts_is_num(b)){   /* no rooting, no ToPrimitive (NaN compares false) */
    double na = ts_to_num(a), nb = ts_to_num(b);
    switch(op){ case 0: return na<nb; case 1: return na<=nb; case 2: return na>nb; default: return na>=nb; }
  }
  ts_gc_root(&a); ts_gc_root(&b);
  tsv pa = (ts_object_like(a)&&!ts_is_symbol(a)) ? ts_to_primitive(a,0) : a;
  ts_gc_root(&pa);   /* the second conversion may collect */
  tsv pb = (ts_object_like(b)&&!ts_is_symbol(b)) ? ts_to_primitive(b,0) : b;
  ts_gc_root(&pb);
  int r;
  if (ts_is_str(pa) && ts_is_str(pb)){
    int c = str_view_compare(ts_str_view_typed(pa), ts_str_view_typed(pb));
    switch(op){ case 0: r = c<0; break; case 1: r = c<=0; break; case 2: r = c>0; break; default: r = c>=0; }
  } else {
    double na = ts_number_coerce(pa), nb = ts_number_coerce(pb);
    if (na!=na || nb!=nb) r = 0; /* NaN -> all relational false */
    else switch(op){ case 0: r = na<nb; break; case 1: r = na<=nb; break; case 2: r = na>nb; break; default: r = na>=nb; }
  }
  ts_gc_unroot(4);
  return r;
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
  if ((ts_is_obj(a) || ts_is_func(a)) && ts_same_cell(a, b)) return 1;
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
static void gc_mark_class_fields(ts_object* o, int young, int depth, int stable);
static void gc_weak_fixpoint_and_prune(int young);
static void gc_symbol_weak_prune(int young);

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
/* Reachable WeakMap/WeakSet cells encountered during the current mark. Raw
   pointers are safe here: ephemeron processing and dead-key pruning finish
   before the moving/sweep phase starts, then the length is reset. Old weak
   containers scanned through the minor-GC remembered set enter this list too. */
static ts_gc_header** g_weak_work = NULL;
static size_t g_weak_work_len = 0, g_weak_work_cap = 0;
static void gc_weak_begin(void){ g_weak_work_len = 0; }
static void gc_weak_enqueue(ts_gc_header* h){
  if (g_weak_work_len == g_weak_work_cap){
    size_t next = g_weak_work_cap ? g_weak_work_cap * 2 : 64;
    ts_gc_header** grown =
      (ts_gc_header**)realloc(g_weak_work, sizeof(ts_gc_header*) * next);
    if (!grown) ts_abort_msg("out of memory growing GC weak worklist");
    g_weak_work = grown; g_weak_work_cap = next;
  }
  g_weak_work[g_weak_work_len++] = h;
}
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
    h->mark = 1; gc_survivor_push(h);
  } else if (h->gen == TS_GEN_OLD){
    if (young) return; /* minor boundary */
    h->mark = 1;
  } else if (TS_RT_UNLIKELY(h->gen == GC_GEN_FREED)){
    gc_freed_reached(h);
  } else { /* stack/SROA or interned (NONHEAP) */
    h->mark = 1; gc_marked_nonheap_push(h);
  }
  if (depth < TS_GC_MARK_DEPTH_MAX) gc_scan_cell(h, young, depth + 1);
  else gc_markstack_push(h);
}
/* Per-edge fast filter stays inline (tag test + header loads); the mark+scan
   goes through the outlined slow path so the scan loops stay compact. A
   reference outside the cage (NULL among them) is not a heap cell, and one
   inside is marked only when its header reads as a live cell (a valid kind,
   YOUNG or OLD): references are made by boxing a cell's first byte, and a
   cell block keeps its size class, so only a bug could name anything else
   (a freed cell in protect mode is reported as the dangling reference). */
static inline void gc_mark_visit(tsv v, int young, int depth){
  RT_STAT_INC(mark_edges);
  if (!ts_heap_ref(v)) return;
  uint64_t payload = v & TS_PAYLOAD_MASK;
  ts_gc_header* h;
  if (TS_RT_UNLIKELY(payload & TS_PTR_STACK_TAG)){
    h = ts_heap_ptr(v);
    if (!h) return;
  } else {
    if ((uintptr_t)payload - (uintptr_t)g_cage_base >= g_cage_bytes) return;
    h = (ts_gc_header*)(uintptr_t)payload;
    if (TS_RT_UNLIKELY(h->gen > TS_GEN_OLD || !gc_kind_valid(h->kind))){
      if (h->gen == GC_GEN_FREED) gc_freed_reached(h);
      return;
    }
  }
  if (h->mark) return;
  if (young && h->gen == TS_GEN_OLD){
    RT_STAT_INC(mark_old_edges);
    return;
  }
  gc_mark_visit_slow(h, young, depth);
}
/* Always inlined: the scan of cells is the collector's hot loop, and clang's
   own choice flips with unrelated edits (adding the cold root sites of
   docs/gc_v2_design.md §6.5 step 1b made it call this out of line from
   gc_scan_cell: +1.1% instructions on the compiler). Cells never move, so
   a slot is only read (`stable` no longer matters). */
TS_RT_ALWAYS_INLINE void gc_visit_slot(tsv* slot, int young, int depth, int stable){
  (void)stable;
  gc_mark_visit(*slot, young, depth);
}
/* ts_prop keeps a compact user-Symbol id rather than a tagged heap reference.
   Recover and trace that identity here so `obj[sym]` is a genuine strong edge.
   The weak id table is cleared only after ephemerons reach their fixed point. */
static inline void gc_mark_property_key(ts_key key, int young, int depth){
  if (key >= TS_USERSYM_KEY_BASE)
    gc_mark_visit(sym_value_by_id(key - TS_USERSYM_KEY_BASE), young, depth);
}
static inline void gc_mark_common_props(ts_object* o, int young, int depth, int stable){
  if (o->props) gc_payload_mark(o->props);
  if (o->prop_index) gc_payload_mark(o->prop_index);
  uint32_t first = 0, end = o->len;
  /* A remembered old plain object rescanned by a minor collection visits its
     dirty cards only (docs/remembered_slots_design.md); 0 (no range) and
     0xFF (every slot) scan everything. */
  if (young && o->h.gen == TS_GEN_OLD && o->h.kind == TS_KIND_OBJECT){
    uint8_t r = o->h.hdr_spare;
    if (r != 0 && r != 0xFF){
      first = (uint32_t)(r >> 4) << 3;
      end = (uint32_t)(r & 0xF) << 3;
      if (end > o->len) end = o->len;
      if (first > end) first = end;
      RT_STAT_INC(remset_precise_scans); RT_STAT_ADD(remset_precise_slots, end - first);
    } else {
      RT_STAT_INC(remset_full_scans); RT_STAT_ADD(remset_full_slots, o->len);
    }
  }
  if (obj_shaped(o)){
    if (!o->len) return;
    const ts_key* ks = g_ts_shape_keys[ts_obj_shape_id(o)];
    for (uint32_t i=first;i<end;i++){
      gc_mark_property_key(ks[i], young, depth);
      gc_visit_slot(ts_obj_slot_ptr(o, i), young, depth, stable);
    }
    return;
  }
  for (uint32_t i=first;i<end;i++){
    gc_mark_property_key(o->props[i].key, young, depth);
    gc_visit_slot(&o->props[i].val, young, depth, stable);
  }
}
static void gc_mark_drain(int young){
  while (g_markstack_len){
    ts_gc_header* h = g_markstack[--g_markstack_len];
    gc_scan_cell(h, young, 0);
  }
}
static void gc_scan_cell(ts_gc_header* h, int young, int depth){
  if (!h) return;
  RT_STAT_INC(kind_scan[h->kind]);
  /* slots of a cell that cannot move during this collection may be rewritten */
  int stable = h->gen != TS_GEN_YOUNG;
  if (h->kind==TS_KIND_OBJECT){ ts_object* o=(ts_object*)h;
    gc_mark_class_fields(o, young, depth, stable);
    gc_mark_common_props(o, young, depth, stable);
    gc_visit_slot(&o->proto, young, depth, stable);
  } else if (h->kind==TS_KIND_ACCESSOR){ ts_accessor* ac=(ts_accessor*)h;
    gc_visit_slot(&ac->getter, young, depth, stable);
    gc_visit_slot(&ac->setter, young, depth, stable);
  } else if (h->kind==TS_KIND_SYMBOL){ ts_symbol* sy=(ts_symbol*)h;
    gc_visit_slot(&sy->description, young, depth, stable);
  } else if (h->kind==TS_KIND_STRING){ ts_string* s=(ts_string*)h;
    if (s->flags & TS_STR_FLAG_VIEW) gc_visit_slot(&s->parent, young, depth, stable);
  } else if (h->kind==TS_KIND_FUNC){ ts_func* f=(ts_func*)h;
    if (young) RT_STAT_ADD(kind_minor_elements[h->kind], f->envlen);
    gc_payload_mark(f->env);
    for (uint32_t i=0;i<f->envlen;i++) gc_visit_slot(&f->env[i], young, depth, stable);
    gc_mark_common_props(&f->o, young, depth, stable);
    gc_visit_slot(&f->prototype_prop, young, depth, stable);
    gc_visit_slot(&f->o.proto, young, depth, stable);
  } else if (h->kind==TS_KIND_ARRAY){ ts_array* a=(ts_array*)h;
    if (a->sparse) gc_payload_mark(array_sparse_table(a));
    else if (a->data && !array_uses_inline(a)) gc_payload_mark(a->data);
    if (a->sparse){
      /* side table (far stores): every entry; a sparse store dirties the whole cell */
      ts_sparse_elems* s = array_sparse_table(a); tsv* vals = sparse_vals(s);
      for (uint32_t i=0;i<=s->mask;i++) if (s->keys[i] != ARRAY_SPARSE_EMPTY) gc_visit_slot(&vals[i], young, depth, stable);
      if (young) RT_STAT_ADD(kind_minor_elements[h->kind], s->count);
    } else {
    uint32_t first = 0, end = a->len;
    if (young && h->gen == TS_GEN_OLD && !a->gc_dirty_all){
      first = (uint32_t)a->gc_dirty_first << GC_CONTAINER_CARD_SHIFT;
      end = (uint32_t)a->gc_dirty_end << GC_CONTAINER_CARD_SHIFT;
      if (end > a->len) end = a->len;
    }
    if (young && end > first) RT_STAT_ADD(kind_minor_elements[h->kind], end - first);
    for (uint32_t i=first;i<end;i++) gc_visit_slot(&a->data[i], young, depth, stable);
    }
    /* unified model: also mark the common header's named-property map + proto. */
    gc_mark_common_props(&a->o, young, depth, stable);
    gc_visit_slot(&a->o.proto, young, depth, stable);
  } else if (h->kind==TS_KIND_MAP){ ts_map* m=(ts_map*)h;
    gc_payload_mark(m->keys); gc_payload_mark(m->vals); gc_payload_mark(m->hashes);
    gc_payload_mark(m->index); gc_payload_mark(m->iteration_order);
    if (m->weak){
      /* Ephemeron entries are deliberately skipped here. Their values are
         marked after the ordinary transitive closure, iff their keys are live. */
      gc_weak_enqueue(h);
    } else {
      uint32_t first = 0, end = m->len;
      if (young && h->gen == TS_GEN_OLD && !m->gc_dirty_all){
        first = (uint32_t)m->gc_dirty_first << GC_CONTAINER_CARD_SHIFT;
        end = (uint32_t)m->gc_dirty_end << GC_CONTAINER_CARD_SHIFT;
        if (end > m->len) end = m->len;
      }
      if (young && end > first) RT_STAT_ADD(kind_minor_elements[h->kind], 2ull * (end - first));
      for (uint32_t i=first;i<end;i++){
        gc_visit_slot(&m->keys[i], young, depth, stable);
        gc_visit_slot(&m->vals[i], young, depth, stable);
      }
    }
    gc_mark_common_props(&m->o, young, depth, stable);
    gc_visit_slot(&m->o.proto, young, depth, stable);
  } else if (h->kind==TS_KIND_SET){ ts_set_t* st=(ts_set_t*)h;
    gc_payload_mark(st->elems); gc_payload_mark(st->hashes);
    gc_payload_mark(st->index); gc_payload_mark(st->iteration_order);
    if (young && !st->weak) RT_STAT_ADD(kind_minor_elements[h->kind], st->len);
    if (st->weak){ gc_weak_enqueue(h); }
    else for (uint32_t i=0;i<st->len;i++) gc_visit_slot(&st->elems[i], young, depth, stable);
    gc_mark_common_props(&st->o, young, depth, stable);
    gc_visit_slot(&st->o.proto, young, depth, stable);
  } else if (h->kind==TS_KIND_PROXY){ ts_proxy* px=(ts_proxy*)h;
    gc_visit_slot(&px->target, young, depth, stable); gc_visit_slot(&px->handler, young, depth, stable);
  } else if (h->kind==TS_KIND_TYPEDARRAY){ ts_typedarray* ta=(ts_typedarray*)h;
    /* the view's data points into its buffer's bytes, which never move */
    gc_visit_slot(&ta->buffer, young, depth, stable);
    gc_mark_common_props(&ta->o, young, depth, stable);
    gc_visit_slot(&ta->o.proto, young, depth, stable);
  } else if (h->kind==TS_KIND_ARRAYBUFFER){ ts_arraybuffer* ab=(ts_arraybuffer*)h;
    gc_mark_common_props(&ab->o, young, depth, stable);
    gc_visit_slot(&ab->o.proto, young, depth, stable);
  } else if (h->kind==TS_KIND_PROMISE || h->kind==TS_KIND_CORO){
    gc_scan_async_cell(h, young, depth);
  }
}
/* A cell's bytes in the heap count: its body, and an ArrayBuffer's bytes. */
static inline size_t gc_cell_heap_bytes(const ts_gc_header* h){
  return h->size + (h->kind == TS_KIND_ARRAYBUFFER ? ((const ts_arraybuffer*)h)->byte_length : 0u);
}
static inline void gc_old_bytes_sub(size_t n){ g_old_bytes = g_old_bytes > n ? g_old_bytes - n : 0u; }
/* Release a dying cell's external buffers, not its body (the cell space
   reclaims that). */
static void gc_free_cell_payload(ts_gc_header* h){
  G0_FATE(h, h->gen == TS_GEN_OLD ? G0_DEAD_OLD : G0_DEAD_YOUNG);
  if (h->kind==TS_KIND_OBJECT){
    ts_object* o=(ts_object*)h; props_release_dead(o);
  } else if (h->kind==TS_KIND_ARRAY){
    ts_array* a=(ts_array*)h; array_release_dead(a); props_release_dead(&a->o);
  } else if (h->kind==TS_KIND_FUNC){
    ts_func* f=(ts_func*)h; props_release_dead(&f->o);   /* the environment is a payload */
  } else if (h->kind==TS_KIND_MAP){
    ts_map* m=(ts_map*)h; gc_owned_release_dead(m->keys); gc_owned_release_dead(m->vals); gc_owned_release_dead(m->hashes); gc_owned_release_dead(m->index); gc_owned_release_dead(m->iteration_order); props_release_dead(&m->o);
  } else if (h->kind==TS_KIND_SET){
    ts_set_t* s=(ts_set_t*)h; gc_owned_release_dead(s->elems); gc_owned_release_dead(s->hashes); gc_owned_release_dead(s->index); gc_owned_release_dead(s->iteration_order); props_release_dead(&s->o);
  }
  else if (h->kind==TS_KIND_ARRAYBUFFER){
    ts_arraybuffer* ab=(ts_arraybuffer*)h;
    free(ab->bytes); ab->bytes = NULL; props_release_dead(&ab->o);
  }
  else if (h->kind==TS_KIND_TYPEDARRAY){ props_release_dead(&((ts_typedarray*)h)->o); }
  else if (h->kind==TS_KIND_PROMISE){ free(((ts_promise*)h)->waiters); }
  else if (h->kind==TS_KIND_CORO){
    ts_coro* c=(ts_coro*)h;
    if (c->eh_catch_state && c->eh_catch_state!=c->eh_catch_inline) free(c->eh_catch_state);
    if (c->eh_gc_depth && c->eh_gc_depth!=c->eh_gc_inline) free(c->eh_gc_depth);
    if (c->fin_pending && c->fin_pending!=c->fin_pending_inline) free(c->fin_pending);
    if (c->fin_exc && c->fin_exc!=c->fin_exc_inline) free(c->fin_exc);
    if (c->fin_tgt && c->fin_tgt!=c->fin_tgt_inline) free(c->fin_tgt);
    ts_asyncgen_req* r=c->ag_head;
    while (r){ ts_asyncgen_req* next=r->next; free(r); r=next; }
  }
}
/* Protect mode for the cell space (TSAOT_GC_PROTECT=N, docs/gc_v2_design.md
   §6.8): a dying cell is zapped and kept from the allocator (its mark bit
   stays set, its gen says FREED) in a FIFO quarantine of up to N MiB, so an
   access through a dangling reference reads poison instead of a new cell,
   and a collection that reaches a quarantined cell reports the dangling
   reference. The end of each collection frees the oldest cells over the
   budget. The header stays readable under ASan (the collector tests it). */
static ts_gc_header** g_cq = NULL;
static size_t g_cq_head = 0, g_cq_len = 0, g_cq_cap = 0, g_cq_bytes = 0;
static size_t gc_cell_footprint(const gc_block* b){
  return b->state == GC_BLK_LARGE_CELL ? (size_t)b->nblocks << GC_BLOCK_SHIFT : g_pclass_size[b->cls];
}
static void gc_cell_quarantine(ts_gc_header* h, gc_block* b, size_t size){
  if (g_cq_len == g_cq_cap){
    size_t next = g_cq_cap ? g_cq_cap * 2 : 4096;
    ts_gc_header** grown = (ts_gc_header**)malloc(sizeof(ts_gc_header*) * next);
    if (!grown) ts_abort_msg("out of memory growing the cell quarantine");
    for (size_t i = 0; i < g_cq_len; i++) grown[i] = g_cq[(g_cq_head + i) % g_cq_cap];
    free(g_cq); g_cq = grown; g_cq_cap = next; g_cq_head = 0;
  }
  g_cq[(g_cq_head + g_cq_len) % g_cq_cap] = h; g_cq_len++;
  g_cq_bytes += gc_cell_footprint(b);
  if (size) memset(h, 0xDD, size);
  h->mark = 0; h->gen = GC_GEN_FREED;
  if (b->state == GC_BLK_LARGE_CELL) b->mark = 1; else gc_cell_set_old_bit(h);
  if (size > sizeof(ts_gc_header)) GC_PAYLOAD_POISON((char*)h + sizeof(ts_gc_header), size - sizeof(ts_gc_header));
}
static void gc_cell_quarantine_trim(void){
  size_t budget = (size_t)g_gc_protect << 20;
  while (g_cq_len && g_cq_bytes > budget){
    ts_gc_header* h = g_cq[g_cq_head];
    g_cq_head = (g_cq_head + 1u) % g_cq_cap; g_cq_len--;
    gc_block* b = gc_cell_block(h);
    g_cq_bytes -= gc_cell_footprint(b);
    if (b->state == GC_BLK_LARGE_CELL){ gc_cell_release_large(h); continue; }
    uintptr_t off = (uintptr_t)h - (uintptr_t)g_cage_base;
    uint32_t g = (uint32_t)((off & (GC_BLOCK_BYTES - 1u)) >> 4);
    uint64_t* w = &gc_block_bitmap((uint32_t)(off >> GC_BLOCK_SHIFT))[g >> 6];
    uint64_t m = (uint64_t)1u << (g & 63u);
    if (*w & m){ *w &= ~m; b->live -= g_pclass_size[b->cls]; }
    GC_PAYLOAD_POISON(h, g_pclass_size[b->cls]);
  }
}
/* A dead cell of the cell space: its side buffers go; the memory
   is free because no mark bit covers it (a large run is released). */
static void gc_cell_die(ts_gc_header* h){
  size_t size = h->size;
  gc_free_cell_payload(h);
  gc_block* b = gc_cell_block(h);
  if (TS_RT_UNLIKELY(g_gc_protect)){ gc_cell_quarantine(h, b, size); return; }
  if (b->state == GC_BLK_LARGE_CELL){ gc_cell_release_large(h); return; }
  if (g_gc_zap && size) memset(h, 0xDD, size);
  GC_PAYLOAD_POISON(h, g_pclass_size[b->cls]);
}
static void gc_cell_promote(ts_gc_header* h){
  gc_cell_set_old_bit(h);
  h->mark = 0; h->gen = TS_GEN_OLD; h->remembered = 0;
}
/* After marking (both collections): the young cells the marker reached are
   promoted in place (coroutine frames re-enroll in the remembered set). */
static void gc_promote_survivors(void){
  for (size_t i = 0; i < g_survivors_len; i++){
    ts_gc_header* h = g_survivors[i];
    G0_FATE(h, G0_PROMOTED);
    gc_cell_promote(h);
    g_old_bytes += gc_cell_heap_bytes(h);
    if (h->kind == TS_KIND_CORO) ts_gc_remember(h);
  }
  g_survivors_len = 0;
}
/* Then the logged young cells still young die: the finalizable kinds and
   the large cells (every young cell in the debug modes). The other dead
   young cells are free without a visit (no bit covers their memory). */
static void gc_young_log_sweep(void){
  for (size_t i = 0; i < g_young_log_len; i++){
    ts_gc_header* h = g_young_log[i];
    if (h->gen == TS_GEN_YOUNG) gc_cell_die(h);
  }
  g_young_log_len = 0;
}
/* A full collection's sweep of the old cells, after marking and before the
   young log's: an unmarked old cell dies and loses its bit, a marked one
   stays old (coroutine frames re-enroll in the remembered set: they may
   point young across collections). Young cells have no bit. */
static void gc_cells_sweep_old(void){
  if (!g_cage_base) return;
  for (int cls = 0; cls < g_pclass_n; cls++){
    uint32_t size = g_pclass_size[cls];
    for (uint32_t l = g_cclass[cls].head; l; l = g_blocks[l - 1u].next){
      uint32_t bi = l - 1u;
      uint64_t* bm = gc_block_bitmap(bi);
      char* base = gc_block_base(bi);
      for (uint32_t w = 0; w < GC_BLOCK_BITMAP_WORDS; w++){
        uint64_t bits = bm[w];
        while (bits){
          uint32_t g = (w << 6) + (uint32_t)__builtin_ctzll(bits);
          bits &= bits - 1u;
          ts_gc_header* h = (ts_gc_header*)(base + ((size_t)g << 4));
          if (h->mark){
            h->mark = 0; h->remembered = 0;
            if (h->kind == TS_KIND_CORO) ts_gc_remember(h);
            continue;
          }
          if (TS_RT_UNLIKELY(h->gen == GC_GEN_FREED)) continue; /* quarantined */
          bm[w] &= ~((uint64_t)1u << (g & 63u));
          g_blocks[bi].live -= size;
          gc_old_bytes_sub(gc_cell_heap_bytes(h));
          gc_cell_die(h);
        }
      }
    }
  }
  for (uint32_t l = g_large_cell_head; l; ){
    gc_block* b = &g_blocks[l - 1u];
    uint32_t next = b->next;
    if (b->mark){
      ts_gc_header* h = (ts_gc_header*)gc_block_base(l - 1u);
      if (h->mark){
        h->mark = 0; h->remembered = 0;
        if (h->kind == TS_KIND_CORO) ts_gc_remember(h);
      } else if (h->gen != GC_GEN_FREED){
        gc_old_bytes_sub(gc_cell_heap_bytes(h));
        gc_cell_die(h);
      }
    }
    l = next;
  }
}
/* Tests: log every young cell (the probe below needs them). */
void ts_gc_debug_log_young(void){ g_young_log_kinds = ~0u; }
/* Tests: does `v` still name an allocated cell? A stale reference keeps the
   address of a freed cell; the cell space knows it is free (no mark bit,
   and not a young cell of this cycle). Needs ts_gc_debug_log_young. */
int ts_gc_debug_cell_live(tsv v){
  if (!ts_heap_ref(v)) return 0;
  uint64_t payload = v & TS_PAYLOAD_MASK;
  if (payload & TS_PTR_STACK_TAG) return 1;
  char* p = (char*)(uintptr_t)payload;
  if (!gc_payload_in_cage(p)) return 0;
  for (size_t i = 0; i < g_young_log_len; i++) if ((char*)g_young_log[i] == p) return 1;
  gc_block* b = gc_cell_block((ts_gc_header*)p);
  int bit = b->state == GC_BLK_LARGE_CELL ? b->mark != 0
          : (b->state == GC_BLK_CELL && gc_payload_cell_marked(p));
  return bit && ((ts_gc_header*)p)->gen != GC_GEN_FREED;
}
#ifdef TSAOT_RT_STATS
static inline void g0_payload(int fate, int type, unsigned long long bytes, int* any){
  g0_payload_n[fate][type]++; g0_payload_bytes[fate][type] += bytes; *any = 1;
}
static void g0_count_fate(ts_gc_header* h, int fate){
  unsigned kind = h->kind <= TS_KIND_LAST ? h->kind : 0u;
  g0_cells[fate][kind]++; g0_cell_bytes[fate][kind] += h->size;
  if (fate == G0_RESIDENT_OLD) g0_resident_gran[kind][g0_gran(h->size)]++;
  int any = 0;
  ts_obj_common* common = NULL;
  if (kind == TS_KIND_OBJECT) common = (ts_obj_common*)h;
  else if (kind == TS_KIND_ARRAY){
    ts_array* a = (ts_array*)h;
    if (a->sparse){
      ts_sparse_elems* sp = array_sparse_table(a);
      if (sp) g0_payload(fate, G0_P_SPARSE, sizeof(ts_sparse_elems) + (unsigned long long)(sp->mask + 1u) * (sizeof(uint32_t) + sizeof(tsv)), &any);
    } else if (a->data && !array_uses_inline(a)) g0_payload(fate, G0_P_ELEMS, (unsigned long long)a->cap * sizeof(tsv), &any);
    common = &a->o;
  } else if (kind == TS_KIND_FUNC){
    ts_func* f = (ts_func*)h;
    if (f->env && f->envlen) g0_payload(fate, G0_P_ENV, (unsigned long long)f->envlen * sizeof(tsv), &any);
    common = &f->o;
  } else if (kind == TS_KIND_MAP){
    ts_map* m = (ts_map*)h;
    unsigned long long b = 0;
    if (m->keys) b += (unsigned long long)m->cap * sizeof(tsv);
    if (m->vals) b += (unsigned long long)m->cap * sizeof(tsv);
    if (m->hashes) b += (unsigned long long)m->cap * sizeof(uint32_t);
    if (m->index) b += (unsigned long long)m->index_cap * sizeof(uint32_t);
    if (m->iteration_order) b += (unsigned long long)m->cap * sizeof(uint64_t);
    if (b) g0_payload(fate, G0_P_MAP, b, &any);
    common = &m->o;
  } else if (kind == TS_KIND_SET){
    ts_set_t* st = (ts_set_t*)h;
    unsigned long long b = 0;
    if (st->elems) b += (unsigned long long)st->cap * sizeof(tsv);
    if (st->hashes) b += (unsigned long long)st->cap * sizeof(uint32_t);
    if (st->index) b += (unsigned long long)st->index_cap * sizeof(uint32_t);
    if (st->iteration_order) b += (unsigned long long)st->cap * sizeof(uint64_t);
    if (b) g0_payload(fate, G0_P_SET, b, &any);
    common = &st->o;
  } else if (kind == TS_KIND_PROMISE){
    ts_promise* pr = (ts_promise*)h;
    if (pr->waiters) g0_payload(fate, G0_P_OTHER, (unsigned long long)pr->capwait * sizeof(tsv), &any);
  } else if (kind == TS_KIND_CORO){
    g0_payload(fate, G0_P_OTHER, 0, &any);
  }
  if (common){
    if (common->props && common->cap){
      if (obj_shaped(common)) g0_payload(fate, G0_P_VALS, (unsigned long long)common->cap * sizeof(tsv), &any);
      else g0_payload(fate, G0_P_DICT, (unsigned long long)common->cap * sizeof(ts_prop), &any);
    }
    if (common->prop_index) g0_payload(fate, G0_P_INDEX, (unsigned long long)(common->prop_index[0] + 1u) * sizeof(uint32_t), &any);
  }
  if (any) g0_owner_cells[fate][kind]++;
}
static void g0_dump(FILE* out){
  static const char* fates[G0_FATE_N] = { "dead_young", "aged", "promoted", "dead_old", "resident_old" };
  static const char* ptypes[G0_P_N] = { "vals", "dict", "index", "elems", "sparse", "env", "map", "set", "other" };
  static const char* minor_phases[6] = { "mark", "weak", "remset_reset", "unpooled_sweep", "nursery_sweep", "rewrite_rest" };
  static const char* full_phases[6] = { "mark", "weak", "remset_reset", "old_sweep", "young_sweep", "rewrite_rest" };
  if (g0_fates_on() && g_cage_base){
    for (int cls = 0; cls < g_pclass_n; cls++)
      for (uint32_t l = g_cclass[cls].head; l; l = g_blocks[l - 1u].next){
        const uint64_t* bm = gc_block_bitmap(l - 1u);
        for (uint32_t w = 0; w < GC_BLOCK_BITMAP_WORDS; w++)
          for (uint64_t bits = bm[w]; bits; bits &= bits - 1u){
            uint32_t g = (w << 6) + (uint32_t)__builtin_ctzll(bits);
            g0_count_fate((ts_gc_header*)(gc_block_base(l - 1u) + ((size_t)g << 4)), G0_RESIDENT_OLD);
          }
      }
    for (uint32_t l = g_large_cell_head; l; l = g_blocks[l - 1u].next)
      if (g_blocks[l - 1u].mark) g0_count_fate((ts_gc_header*)gc_block_base(l - 1u), G0_RESIDENT_OLD);
  }
  fprintf(out, "[rt_stats] g0_minor_ms:");
  for (int i = 0; i < 6; i++) fprintf(out, " %s=%.2f", minor_phases[i], (double)g0_minor_ns[i] / 1e6);
  fprintf(out, "\n[rt_stats] g0_full_ms:");
  for (int i = 0; i < 6; i++) fprintf(out, " %s=%.2f", full_phases[i], (double)g0_full_ns[i] / 1e6);
  fprintf(out, "\n");
  for (int f = 0; f < G0_FATE_N; f++){
    fprintf(out, "[rt_stats] g0_fate %s:", fates[f]);
    for (unsigned k = 0; k <= TS_KIND_LAST; k++)
      if (g0_cells[f][k]) fprintf(out, " k%u=%llu/%llu/%llu", k, g0_cells[f][k], g0_cell_bytes[f][k], g0_owner_cells[f][k]);
    fprintf(out, "  (cells/bytes/payload_owners)\n[rt_stats] g0_payload %s:", fates[f]);
    for (int t = 0; t < G0_P_N; t++)
      if (g0_payload_n[f][t]) fprintf(out, " %s=%llu/%llu", ptypes[t], g0_payload_n[f][t], g0_payload_bytes[f][t]);
    fprintf(out, "  (buffers/bytes)\n");
  }
  for (unsigned k = 0; k <= TS_KIND_LAST; k++){
    int any = 0;
    for (unsigned g = 0; g < G0_GRANULES; g++) if (g0_alloc_gran[k][g]){
      if (!any){ fprintf(out, "[rt_stats] g0_alloc_sizes k%u:", k); any = 1; }
      fprintf(out, " %u=%llu", g == G0_GRANULES - 1u ? 9999u : g * 16u, g0_alloc_gran[k][g]);
    }
    if (any) fprintf(out, "\n");
    any = 0;
    for (unsigned g = 0; g < G0_GRANULES; g++) if (g0_resident_gran[k][g]){
      if (!any){ fprintf(out, "[rt_stats] g0_resident_sizes k%u:", k); any = 1; }
      fprintf(out, " %u=%llu", g == G0_GRANULES - 1u ? 9999u : g * 16u, g0_resident_gran[k][g]);
    }
    if (any) fprintf(out, "\n");
  }
  fprintf(out, "[rt_stats] g0_misc: young_log_cap=%zu rem_enroll=%llu proto_materialized=%llu pretenured_bytes=%llu\n",
          g_young_log_cap, g0_rem_enroll, g0_proto_materialized, g0_pretenured_bytes);
}
#endif
void ts_gc_collect_young(void){
  g_payload_fresh_bytes = 0;
  if (!g_young_new_since_minor && !g_young_log_len){ g_young_fresh_bytes = 0; return; }
  g_gc_collecting = 1;
  RT_STAT_INC(minor_gc); RT_STAT_GC_T0;
  G0_T0;
#ifdef TSAOT_STACK_CHECK
  g_sc_minor = 1;
#endif
  gc_weak_begin();
  gc_mark_async_roots_young();
  /* Only the Symbol.for registry is strong. Ordinary entries in g_sym_value
     are weak and are reached through real roots/property-key edges instead. */
  for (uint32_t i=0;i<g_symreg_len;i++){
    gc_visit_slot(&g_symreg[i].key, 1, 0, 1);
    gc_visit_slot(&g_symreg[i].sym, 1, 0, 1);
  }
  for (int i=0;i<g_static_root_len;i++) gc_visit_slot(g_static_roots[i], 1, 0, 1);
  RT_STAT_ADD(minor_root_slots, g_static_root_len + g_root_len);
  for (int i=0;i<g_root_len;i++){
#if defined(TS_ASAN_ENABLED)
    __asan_unpoison_memory_region(g_roots[i], sizeof(*g_roots[i]));
#endif
    gc_visit_slot(g_roots[i], 1, 0, 1);
  }
  for (ts_frame_hdr* frame = g_ts_frame_top; frame; frame = frame->prev){
    tsv* slots = ts_frame_slots(frame);
    RT_STAT_ADD(minor_root_slots, frame->count);
    for (uint32_t i = 0; i < frame->count; i++) gc_visit_slot(&slots[i], 1, 0, 1);
  }
  size_t old_rem_len = g_rem_len;
  RT_STAT_ADD(minor_remembered_cells, old_rem_len);
  for (size_t i=0;i<old_rem_len;i++){
    ts_gc_header* h = g_remset[i];
    if (h && h->gen == TS_GEN_OLD) gc_scan_cell(h, 1, 0);
  }
  gc_mark_drain(1);
  G0_PHASE(g0_minor_ns, 0);
  /* Ephemerons run after the ordinary young closure. A newly marked value can
     expose another weak key, so this helper iterates to a fixed point before
     dead young keys are pruned and handle slots can be recycled. */
  gc_weak_fixpoint_and_prune(1);
  gc_symbol_weak_prune(1);
  G0_PHASE(g0_minor_ns, 1);
  /* Every young survivor is promoted below, so no old->young edge outlives
     this collection: the remembered set resets (coroutine frames re-enroll:
     they may point young across collections). */
  g_rem_len = 0;
  for (size_t i=0;i<old_rem_len;i++){
    ts_gc_header* h = g_remset[i];
    if (!h) continue;
    h->remembered = 0;
    if (h->gen != TS_GEN_OLD) continue;
    if (h->kind == TS_KIND_CORO){ ts_gc_remember(h); continue; }
    if (h->kind == TS_KIND_ARRAY){
      ts_array* a = (ts_array*)h;
      a->gc_dirty_all = 0; a->gc_dirty_end = 0;
    } else if (h->kind == TS_KIND_MAP){
      ts_map* m = (ts_map*)h;
      m->gc_dirty_all = 0; m->gc_dirty_end = 0;
    } else if (h->kind == TS_KIND_OBJECT){
      h->hdr_spare = 0;
    }
  }
  G0_PHASE(g0_minor_ns, 2);
  gc_promote_survivors();
  gc_young_log_sweep();
  g_heap_bytes = g_old_bytes;
  G0_PHASE(g0_minor_ns, 4);
  g_young_new_since_minor = 0;
  g_young_fresh_bytes = 0;
  gc_clear_nonheap_marks();
#ifdef TSAOT_STACK_CHECK
  g_sc_minor = 0;
  g_sc_minors_since_full++;
#endif
  if (g_gc_protect) gc_cell_quarantine_trim();
  gc_payload_after_collection(0);
  g_gc_collecting = 0;
  G0_PHASE(g0_minor_ns, 5);
  RT_STAT_GC_T1;
}
void ts_gc_collect(void){
  RT_STAT_INC(full_gc); RT_STAT_GC_T0;
  G0_T0;
  g_payload_fresh_bytes = 0;
  g_gc_collecting = 1;
  gc_payload_begin_full();
  prop_add_epoch_bump();
  gc_weak_begin();
  gc_mark_async_roots();
  /* Symbol.for is the only dynamically growing strong Symbol registry. */
  for (uint32_t i=0;i<g_symreg_len;i++){
    gc_visit_slot(&g_symreg[i].key, 0, 0, 1);
    gc_visit_slot(&g_symreg[i].sym, 0, 0, 1);
  }
  for (int i=0;i<g_static_root_len;i++) gc_visit_slot(g_static_roots[i], 0, 0, 1);
  for (int i=0;i<g_root_len;i++){
#if defined(TS_ASAN_ENABLED)
    __asan_unpoison_memory_region(g_roots[i], sizeof(*g_roots[i]));
#endif
    gc_visit_slot(g_roots[i], 0, 0, 1);
  }
  for (ts_frame_hdr* frame = g_ts_frame_top; frame; frame = frame->prev){
    tsv* slots = ts_frame_slots(frame);
    for (uint32_t i = 0; i < frame->count; i++) gc_visit_slot(&slots[i], 0, 0, 1);
  }
  gc_mark_drain(0);
  G0_PHASE(g0_full_ns, 0);
  gc_weak_fixpoint_and_prune(0);
  gc_symbol_weak_prune(0);
  G0_PHASE(g0_full_ns, 1);
  for (size_t i=0;i<g_rem_len;i++) if (g_remset[i]){
    ts_gc_header* remembered = g_remset[i];
    remembered->remembered = 0;
    if (remembered->kind == TS_KIND_ARRAY){
      ts_array* a = (ts_array*)remembered;
      a->gc_dirty_all = 0; a->gc_dirty_end = 0;
    } else if (remembered->kind == TS_KIND_MAP){
      ts_map* m = (ts_map*)remembered;
      m->gc_dirty_all = 0; m->gc_dirty_end = 0;
    } else if (remembered->kind == TS_KIND_OBJECT){
      remembered->hdr_spare = 0;
    }
  }
  g_rem_len = 0;
  G0_PHASE(g0_full_ns, 2);
  /* The old cells through their mark bits (the unreached die and lose the
     bit), then the young cells of the cycle through the log. */
  gc_cells_sweep_old();
  gc_promote_survivors();
  gc_young_log_sweep();
  g_heap_bytes = g_old_bytes;
  G0_PHASE(g0_full_ns, 3);
  g_young_new_since_minor = 0;
  g_young_fresh_bytes = 0;
  gc_clear_nonheap_marks();
  if (g_gc_protect) gc_cell_quarantine_trim();
  gc_payload_after_collection(1);
  g_gc_collecting = 0;
  G0_PHASE(g0_full_ns, 5);
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
  if (!ts_is_str(s)) return s;
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
static long ts_slice_index(double value, long length){
  if (isnan(value)) return 0;
  if (value < 0) return value <= -(double)length ? 0 : length + (long)value;
  return value >= (double)length ? length : (long)value;
}
tsv ts_str_slice(tsv s, double start, double end, int has_end){
  if(!ts_is_str(s)) return s;
  long n=(long)ts_str_len_typed(s);
  long a=ts_slice_index(start,n); long b=has_end ? ts_slice_index(end,n) : n;
  if(b<a) b=a;
  return ts_string_slice_view(s, (uint32_t)a, (uint32_t)(b-a));
}
/* String.prototype.substring: like slice, but negatives clamp to 0 (not from the
   end) and the two indices are SWAPPED when start > end. */
tsv ts_str_substring(tsv s, double start, double end, int has_end){
  if(!ts_is_str(s)) return s;
  long n=(long)ts_str_len_typed(s);
  long a=ts_slice_index(fmax(0,start),n);
  long b=has_end ? ts_slice_index(fmax(0,end),n) : n;
  if(a>b){ long t=a; a=b; b=t; }
  return ts_string_slice_view(s, (uint32_t)a, (uint32_t)(b-a));
}
tsv ts_str_substr(tsv s, tsv start, tsv length){
  ts_gc_root(&s); ts_gc_root(&start); ts_gc_root(&length);
  if (s == TS_UNDEFINED || s == TS_NULL)
    ts_throw_type_error_msg("String.prototype.substr called on null or undefined");
  s = ts_to_primitive(s, 1);
  if (ts_is_symbol(s)) ts_throw_type_error_msg("Cannot convert a Symbol value to a string");
  if (!ts_is_str(s)) s = ts_to_string_v(s);
  double n = ts_str_len_typed(s);
  double a = ts_number_coerce(start);
  a = isnan(a) ? 0 : trunc(a);
  a = a < 0 ? fmax(n + a, 0) : fmin(a, n);
  double count = length == TS_UNDEFINED ? n : ts_number_coerce(length);
  count = isnan(count) || count <= 0 ? 0 : fmin(trunc(count), n - a);
  tsv result = ts_string_slice_view(s, (uint32_t)a, (uint32_t)count);
  ts_gc_unroot(3);
  return result;
}
tsv ts_str_value(tsv s){
  if (ts_is_str(s)) return s;
  if (s == ts_string_proto()) return ts_new_string("", 0);
  ts_throw_type_error_msg("String.prototype.toString requires a string receiver");
  return TS_UNDEFINED;
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
static tsv number_to_fixed(double x, int d);
static double num_to_integer_or_inf(double d);
static double number_this_value(tsv numv);
/* Number.prototype.toFixed(f) with a number f: ToIntegerOrInfinity,
   RangeError outside 0..100 (checked before x is looked at). */
tsv ts_number_to_fixed_d(tsv numv, double digits){
  double f = num_to_integer_or_inf(digits);
  if (!(f >= 0 && f <= 100)) ts_throw_range_error_msg("toFixed() digits argument must be between 0 and 100");
  return number_to_fixed(number_this_value(numv), (int)f);
}
tsv ts_number_to_fixed_v(tsv numv, tsv digits){
  if (ts_is_undef(digits)) return ts_number_to_fixed_d(numv, 0);
  ts_gc_root(&numv);
  double f = ts_number_coerce(digits);
  ts_gc_unroot(1);
  return ts_number_to_fixed_d(numv, f);
}
/* The previous entry (the frozen analyzer's output): f clamped to 0..100. */
tsv ts_number_to_fixed(tsv numv, double digits){
  int d = (int)digits; if (d<0) d=0; if (d>100) d=100;
  return number_to_fixed(ts_to_num(numv), d);
}
static tsv number_to_fixed(double x, int d){
  if (x != x) return ts_new_string("NaN",3);
  if (x == 1.0/0.0) return ts_new_string("Infinity",8);
  if (x == -1.0/0.0) return ts_new_string("-Infinity",9);
  /* |x| >= 1e21: JS toFixed falls back to Number->String (exponential). */
  if (fabs(x) >= 1e21){ char b[64]; ts_fmt_num(x, b, sizeof b); return ts_new_string(b,(uint32_t)strlen(b)); }
  int neg = x < 0; double ax = fabs(x);   /* fabs so -0 -> +0: `%f` would print -0 as "-0" and leak the sign */
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
  /* `neg` is x<0 (false for -0), so a genuinely-negative value keeps its sign
     even when it rounds to zero — V8: (-0.0001).toFixed(2) === "-0.00", but
     (-0).toFixed(2) === "0.00". `ax=fabs(x)` above kept the sign out of `kept`. */
  if (neg) out[o++] = '-';
  for (int i = 0; i < ilen; i++) out[o++] = kept[i];
  if (d > 0){ out[o++] = '.'; for (int i = ilen; i < klen; i++) out[o++] = kept[i]; }
  out[o] = 0;
  return ts_new_string(out, (uint32_t)o);
}
/* Number::toString(x, radix) for radix 2..36 other than 10: V8's
   DoubleToRadixCString (src/numbers/conversions.cc). The fraction is written
   first (Steele & White: digits until the rest is within half a unit of the
   input's precision, rounding half to even with a carry back through the
   digits into the integer); the integer's digits beyond the double's
   precision are zeros, the others exact fmod remainders. */
static tsv number_to_radix_string(double value, int radix){
  static const char chars[] = "0123456789abcdefghijklmnopqrstuvwxyz";
  enum { kBufferSize = 2200 };
  char buffer[kBufferSize];
  int integer_cursor = kBufferSize / 2;
  int fraction_cursor = integer_cursor;
  int negative = value < 0;
  if (negative) value = -value;
  double integer = floor(value);
  double fraction = value - integer;
  double delta = 0.5 * (nextafter(value, INFINITY) - value);
  double min_delta = nextafter(0.0, 1.0);
  if (delta < min_delta) delta = min_delta;
  if (fraction >= delta){
    buffer[fraction_cursor++] = '.';
    do {
      fraction *= radix;
      delta *= radix;
      int digit = (int)fraction;
      buffer[fraction_cursor++] = chars[digit];
      fraction -= digit;
      if (fraction > 0.5 || (fraction == 0.5 && (digit & 1))){
        if (fraction + delta > 1){
          for (;;){
            fraction_cursor--;
            if (fraction_cursor == kBufferSize / 2){ integer += 1; break; }
            char c = buffer[fraction_cursor];
            int d = c > '9' ? (c - 'a' + 10) : (c - '0');
            if (d + 1 < radix){ buffer[fraction_cursor++] = chars[d + 1]; break; }
          }
          break;
        }
      }
    } while (fraction >= delta);
  }
  /* integer / radix >= 2^53: no unit digit is represented, write a zero */
  while (integer / radix >= 9007199254740992.0){
    integer /= radix;
    buffer[--integer_cursor] = '0';
  }
  do {
    double remainder = fmod(integer, radix);
    buffer[--integer_cursor] = chars[(int)remainder];
    integer = (integer - remainder) / radix;
  } while (integer > 0);
  if (negative) buffer[--integer_cursor] = '-';
  return ts_new_string(buffer + integer_cursor, (uint32_t)(fraction_cursor - integer_cursor));
}
/* ToIntegerOrInfinity of a number. */
static double num_to_integer_or_inf(double d){
  if (d != d || d == 0) return 0;
  if (isinf(d)) return d;
  return trunc(d);
}
/* The receiver's number (thisNumberValue). */
static double number_this_value(tsv numv){
  return ts_is_num(numv) ? ts_to_num(numv) : ts_number_coerce(numv);
}
/* Number.prototype.toString(radix) with a number radix: ToIntegerOrInfinity,
   RangeError outside 2..36. */
tsv ts_number_to_string_radix_d(tsv numv, double radix){
  double r = num_to_integer_or_inf(radix);
  if (!(r >= 2 && r <= 36)) ts_throw_range_error_msg("toString() radix must be between 2 and 36");
  double x = number_this_value(numv);
  if (r == 10 || x != x || isinf(x)) return ts_to_string_v(ts_num(x));
  return number_to_radix_string(x, (int)r);
}
/* ... with any radix: undefined is 10. */
tsv ts_number_to_string_radix_v(tsv numv, tsv radix){
  if (ts_is_undef(radix)) return ts_number_to_string_radix_d(numv, 10);
  ts_gc_root(&numv);
  double r = ts_number_coerce(radix);
  ts_gc_unroot(1);
  return ts_number_to_string_radix_d(numv, r);
}
/* The previous entry (the frozen analyzer's output): an invalid radix
   prints in decimal. */
tsv ts_number_to_string_radix(tsv numv, double radix){
  double x = ts_to_num(numv);
  int base = (radix >= 2 && radix <= 36) ? (int)radix : 10;
  if (base == 10 || x != x || isinf(x)) return ts_to_string_v(numv);
  return number_to_radix_string(x, base);
}
/* Number::toPrecision for a finite x and 1 <= p <= 100 (ECMA-262
   21.1.3.5): n, the p digits closest to x, the larger one on a tie (half up
   on |x|), from the exact decimal expansion; exponential when e < -6 or
   e >= p. */
/* The p (1..101) decimal digits closest to x > 0 and the exponent of the
   first, the larger on a tie (half up), from the exact decimal expansion. */
static void number_exact_digits(double x, int p, char* d, int* e){
  char ex[800];
  snprintf(ex, sizeof ex, "%.770e", x);     /* every digit of the double, exactly */
  char* ep = strchr(ex, 'e');
  *e = atoi(ep + 1);
  char all[780]; int k = 0;
  for (char* c = ex; c < ep; c++) if (*c != '.') all[k++] = *c;
  for (int i = 0; i < p; i++) d[i] = i < k ? all[i] : '0';
  if (p < k && all[p] >= '5'){
    int j = p - 1;
    while (j >= 0 && d[j] == '9'){ d[j] = '0'; j--; }
    if (j >= 0) d[j]++;
    else { d[0] = '1'; for (int i = 1; i < p; i++) d[i] = '0'; (*e)++; }
  }
}
static tsv number_to_precision(double x, int p){
  char out[160]; int o = 0;
  if (x < 0){ out[o++] = '-'; x = -x; }
  char d[110]; int e;
  if (x == 0){
    for (int i = 0; i < p; i++) d[i] = '0';
    e = 0;
  } else number_exact_digits(x, p, d, &e);
  if (e < -6 || e >= p){
    out[o++] = d[0];
    if (p > 1){ out[o++] = '.'; for (int i = 1; i < p; i++) out[o++] = d[i]; }
    o += snprintf(out + o, sizeof out - (size_t)o, "e%c%d", e >= 0 ? '+' : '-', e >= 0 ? e : -e);
  } else if (e == p - 1){
    for (int i = 0; i < p; i++) out[o++] = d[i];
  } else if (e >= 0){
    for (int i = 0; i <= e; i++) out[o++] = d[i];
    out[o++] = '.';
    for (int i = e + 1; i < p; i++) out[o++] = d[i];
  } else {
    out[o++] = '0'; out[o++] = '.';
    for (int i = 0; i < -(e + 1); i++) out[o++] = '0';
    for (int i = 0; i < p; i++) out[o++] = d[i];
  }
  return ts_new_string(out, (uint32_t)o);
}
/* Number::toExponential (ECMA-262 21.1.3.2) for a finite x: f fraction
   digits (the f + 1 digits closest to |x|, the larger on a tie), or, for
   f < 0 (an undefined argument), the shortest digits that round-trip: those
   of ToString, without its leading and trailing zeros. */
static tsv number_to_exponential(double x, int f){
  char out[160]; int o = 0;
  if (x < 0){ out[o++] = '-'; x = -x; }
  char d[120]; int nd, e;
  if (x == 0){
    nd = f < 0 ? 1 : f + 1;
    for (int i = 0; i < nd; i++) d[i] = '0';
    e = 0;
  } else if (f < 0){
    char sbuf[40]; ts_fmt_num(x, sbuf, sizeof sbuf);
    char* ep = strchr(sbuf, 'e');
    char* end = ep ? ep : sbuf + strlen(sbuf);
    int exp10 = ep ? atoi(ep + 1) : 0, intlen = 0, seen_point = 0, z = 0, leading = 1;
    nd = 0;
    for (char* c = sbuf; c < end; c++){
      if (*c == '.'){ seen_point = 1; continue; }
      if (!seen_point) intlen++;
      if (leading && *c == '0'){ z++; continue; }
      leading = 0;
      d[nd++] = *c;
    }
    while (nd > 1 && d[nd - 1] == '0') nd--;
    e = exp10 + intlen - 1 - z;
  } else {
    nd = f + 1;
    number_exact_digits(x, nd, d, &e);
  }
  out[o++] = d[0];
  if (nd > 1){ out[o++] = '.'; for (int i = 1; i < nd; i++) out[o++] = d[i]; }
  o += snprintf(out + o, sizeof out - (size_t)o, "e%c%d", e >= 0 ? '+' : '-', e >= 0 ? e : -e);
  return ts_new_string(out, (uint32_t)o);
}
/* Number.prototype.toExponential(f) with a number f: ToIntegerOrInfinity; a
   non-finite x prints as itself; RangeError outside 0..100. */
tsv ts_number_to_exponential_d(tsv numv, double digits){
  double f = num_to_integer_or_inf(digits);
  double x = number_this_value(numv);
  if (x != x || isinf(x)) return ts_to_string_v(ts_num(x));
  if (!(f >= 0 && f <= 100)) ts_throw_range_error_msg("toExponential() argument must be between 0 and 100");
  return number_to_exponential(x, (int)f);
}
/* ... with any f: undefined is as many digits as necessary. */
tsv ts_number_to_exponential_v(tsv numv, tsv digits){
  if (ts_is_undef(digits)){
    double x = number_this_value(numv);
    if (x != x || isinf(x)) return ts_to_string_v(ts_num(x));
    return number_to_exponential(x, -1);
  }
  ts_gc_root(&numv);
  double f = ts_number_coerce(digits);
  ts_gc_unroot(1);
  return ts_number_to_exponential_d(numv, f);
}
/* Number.prototype.toPrecision(p) with a number p: ToIntegerOrInfinity; a
   non-finite x prints as itself; RangeError outside 1..100. */
tsv ts_number_to_precision_d(tsv numv, double prec){
  double p = num_to_integer_or_inf(prec);
  double x = number_this_value(numv);
  if (x != x || isinf(x)) return ts_to_string_v(ts_num(x));
  if (!(p >= 1 && p <= 100)) ts_throw_range_error_msg("toPrecision() argument must be between 1 and 100");
  return number_to_precision(x, (int)p);
}
/* ... with any p: undefined prints x with ToString. */
tsv ts_number_to_precision_v(tsv numv, tsv prec){
  if (ts_is_undef(prec)) return ts_to_string_v(ts_num(number_this_value(numv)));
  ts_gc_root(&numv);
  double p = ts_number_coerce(prec);
  ts_gc_unroot(1);
  return ts_number_to_precision_d(numv, p);
}
/* The previous entry (the frozen analyzer's output): p < 1 prints x with
   ToString, p > 100 is 100. */
tsv ts_number_to_precision(tsv numv, double prec){
  double x = ts_to_num(numv);
  int p = (int)prec; if (p<1) return ts_to_string_v(numv); if (p>100) p=100;
  if (x != x || isinf(x)) return ts_to_string_v(numv);
  return number_to_precision(x, p);
}
int ts_str_includes(tsv s, tsv needle, double pos, int has_pos){ return ts_str_indexof(s,needle,pos,has_pos) >= 0; }
tsv ts_str_charat(tsv s, double idx){
  if(!ts_is_str(s)) return ts_new_string("",0);
  long i=(long)idx; if(i<0||i>=(long)ts_str_len_typed(s)) return ts_new_string("",0);
  return ts_string_slice_view(s, (uint32_t)i, 1);
}
double ts_str_charcodeat(tsv s, double idx){
  return ts_str_charcodeat_fast(s, idx);
}
/* String.prototype.codePointAt: index is a UTF-16 code-unit index. */
tsv ts_str_codepointat(tsv s, double idx){
  if(!ts_is_str(s)) return TS_UNDEFINED;
  ts_strview xs=ts_str_view_typed(s);
  long i=(long)idx; if(i<0||i>=(long)xs.len) return TS_UNDEFINED;
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
  if (!ts_is_str(s)) return 1;
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
  if (!ts_is_str(s)) return s;
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
  if(!ts_is_str(s)) return s;
  ts_strview xs=ts_str_view_typed(s);
  long c=(long)count; if(c<0)c=0;
  uint64_t total64=(uint64_t)xs.len*(uint64_t)c;
  if(total64 > UINT32_MAX) ts_abort_msg("string too large");
  uint32_t total=(uint32_t)total64;
  if ((xs.flags & TS_STR_FLAG_ASCII) && total <= TS_SHORTSTR_MAX){
    char data[TS_SHORTSTR_MAX];
    uint32_t pos=0;
    for(long k=0;k<c;k++)
      for(uint32_t i=0;i<xs.len;i++) data[pos++]=(char)ts_str_cu_at_view(xs,i);
    RT_STAT_INC(short_string);
    return ts_short_str_ascii(data,total);
  }
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
  if(!ts_is_str(s)) return s;
  ts_strview xs=ts_str_view_typed(s);
  long a=0,b=(long)xs.len;
  while(a<b){ uint16_t c=ts_str_cu_at_view(xs,(uint32_t)a); if(ts_str_is_trim_ws(c)) a++; else break; }
  while(b>a){ uint16_t c=ts_str_cu_at_view(xs,(uint32_t)b-1); if(ts_str_is_trim_ws(c)) b--; else break; }
  return ts_string_slice_view(s, (uint32_t)a, (uint32_t)(b-a));
}
/* split(sep) -> array of strings (sep must be a non-empty string here) */
tsv ts_str_split(tsv s, tsv sep, tsv limit){
  if(!ts_is_str(s)) return ts_new_array(0);
  ts_gc_root(&s); ts_gc_root(&sep);
  int sep_is_str=ts_is_str(sep);
  ts_strview xs=ts_str_view_typed(s), ss={0};
  if(sep_is_str) ss=ts_str_view_typed(sep);
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
  if(!sep_is_str || ss.len==0){ /* split each char */
    uint32_t count=xs.len;
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
/* The old fixed-Uint16 array became a view (docs/typed_arrays_design.md). */
tsv ts_new_uint16_array(tsv input){ return ts_new_typed_array(TS_TA_UINT16, &input, 1); }
static ts_array* as_arr(tsv v){
  if (!ts_is_indexed_array_fast(v)) return NULL;
  ts_array* a = (ts_array*)ts_ptr(v);
  if (__builtin_expect(a->sparse, 0)) array_densify(a, 0);   /* generic operations work on dense storage */
  return a;
}

/* A callback a builtin calls once per element without a `this`: resolved once
   before the loop, each call is the environment register store and the
   indirect call ts_call makes, without ts_call_value's per-element proxy,
   function, takes_this and environment-form tests (Session 350 x58). Anything
   else (a takes_this function, a legacy closure, a proxy, a non-function that
   must throw) keeps ts_call_value. */
typedef struct { ts_code code; tsv* env; int direct; } ts_cb;
static inline void cb_resolve(ts_cb* c, tsv fn){
  c->direct = 0; c->code = NULL; c->env = NULL;
  if ((g_has_proxies && ts_is_proxy(fn)) || !ts_is_func(fn)) return;
  ts_func* f = (ts_func*)ts_ptr(fn);
  if (f->takes_this || (f->envlen && !f->env_abi)) return;
  c->code = (ts_code)f->code;
  c->env = f->envlen ? f->env : NULL;
  c->direct = 1;
}
static inline tsv cb_call(const ts_cb* c, tsv fn, tsv* args, int n){
  if (TS_RT_LIKELY(c->direct)){
    if (c->env) g_ts_cur_env = c->env;
    return c->code(args, n);
  }
  return ts_call_value(fn, args, n);
}
/* callback-based: map/filter/forEach/reduce. cb is a ts_func value invoked with
   (element, index, array), the array the method was called on (reduce adds the
   accumulator in front). */
tsv ts_array_map(tsv arr, tsv cb){
  ts_array* a=as_arr(arr); if(!a) return ts_new_array(0);
  ts_gc_root(&arr); ts_gc_root(&cb);
  ts_cb cbf; cb_resolve(&cbf, cb);
  uint32_t len=a->len;
  tsv out=ts_new_array(len);
  ts_gc_root(&out);
  for(uint32_t i=0;i<len;i++){
    a=as_arr(arr);
    if (!a || i>=a->len || array_is_hole(a->data[i])) continue;
    tsv elem = a->data[i];
    tsv args[3]={ elem, ts_num((double)i), arr };
    ts_array_set(out, i, cb_call(&cbf, cb, args, 3));
  }
  ts_gc_unroot(3);
  return out;
}
tsv ts_array_filter(tsv arr, tsv cb){
  ts_array* a=as_arr(arr); if(!a) return ts_new_array(0);
  ts_gc_root(&arr); ts_gc_root(&cb);
  ts_cb cbf; cb_resolve(&cbf, cb);
  tsv out=ts_new_array(0);
  ts_gc_root(&out);
  a=as_arr(arr);
  uint32_t len=a ? a->len : 0;
  for(uint32_t i=0;i<len;i++){
    a=as_arr(arr);
    if (!a || i>=a->len || array_is_hole(a->data[i])) continue;
    tsv elem = a->data[i];
    tsv args[3]={ elem, ts_num((double)i), arr };
    if(ts_truthy(cb_call(&cbf, cb, args, 3))) ts_array_push(out, elem);
  }
  ts_gc_unroot(3);
  return out;
}
tsv ts_array_foreach(tsv arr, tsv cb){
  ts_array* a=as_arr(arr); if(!a) return TS_UNDEFINED;
  uint32_t len=a->len;
  ts_gc_root(&arr); ts_gc_root(&cb);
  ts_cb cbf; cb_resolve(&cbf, cb);
  for(uint32_t i=0;i<len;i++){
    a=as_arr(arr);
    if (!a || i>=a->len || array_is_hole(a->data[i])) continue;
    tsv elem = a->data[i];
    tsv args[3]={ elem, ts_num((double)i), arr };
    cb_call(&cbf, cb, args, 3);
  }
  ts_gc_unroot(2);
  return TS_UNDEFINED;
}
tsv ts_array_reduce(tsv arr, tsv cb, tsv init, int has_init){
  ts_array* a=as_arr(arr); if(!a) return init;
  tsv acc; uint32_t start;
  if (has_init){ acc=init; start=0; }
  else {
    /* Holes are skipped when selecting the initial accumulator. */
    start=0;
    while (start<a->len && array_is_hole(a->data[start])) start++;
    if (start==a->len) ts_throw_type_error_msg("Reduce of empty array with no initial value");
    acc=a->data[start++];
  }
  ts_gc_root(&arr); ts_gc_root(&acc); ts_gc_root(&cb);
  ts_cb cbf; cb_resolve(&cbf, cb);
  uint32_t len=a->len;
  for(uint32_t i=start;i<len;i++){
    a = as_arr(arr); /* re-fetch: callback may have triggered GC/realloc */
    if (!a || i>=a->len || array_is_hole(a->data[i])) continue;
    tsv elem = a->data[i];
    tsv args[4]={ acc, elem, ts_num((double)i), arr };
    acc=cb_call(&cbf, cb, args, 4);
  }
  ts_gc_unroot(3);
  return acc;
}
tsv ts_array_reduce_right(tsv arr, tsv cb, tsv init, int has_init){
  ts_array* a=as_arr(arr); if(!a) return init;
  tsv acc; long start;
  if (has_init){ acc=init; start=(long)a->len-1; }
  else {
    start=(long)a->len-1;
    while (start>=0 && array_is_hole(a->data[start])) start--;
    if (start<0) ts_throw_type_error_msg("Reduce of empty array with no initial value");
    acc=a->data[start--];
  }
  ts_gc_root(&arr); ts_gc_root(&acc); ts_gc_root(&cb);
  ts_cb cbf; cb_resolve(&cbf, cb);
  for(long i=start;i>=0;i--){
    a = as_arr(arr);                      /* re-fetch: cb may have triggered GC/realloc */
    if (!a || (uint32_t)i>=a->len || array_is_hole(a->data[i])) continue;
    tsv elem = a->data[i];
    tsv args[4]={ acc, elem, ts_num((double)i), arr };
    acc=cb_call(&cbf, cb, args, 4);
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
  if(count>0){
    array_invalidate_dirty(a);
    memmove(&a->data[to], &a->data[fr], (size_t)count*sizeof(tsv));
  }
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
    tsv elem=ts_array_get(arr, i);
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
    tsv elem=ts_array_get(arr, i);
    ts_array_push(out, elem);
  }
  ts_gc_unroot(2);
  return out;
}
double ts_array_indexof(tsv arr, tsv v, double from, int has_from){
  ts_array* a=as_arr(arr); if(!a) return -1;
  long n=(long)a->len, s = has_from ? (long)from : 0;
  if(s<0){ s+=n; if(s<0) s=0; }
  for(long i=s;i<n;i++) if(!array_is_hole(a->data[i]) && ts_strict_eq(a->data[i], v)) return (double)i;
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
    tsv e=array_is_hole(a->data[i]) ? TS_UNDEFINED : a->data[i];
    if(ts_strict_eq(e, v)) return 1;
    if(v_is_nan && ts_is_num(e) && (ts_to_num(e) != ts_to_num(e))) return 1;
  }
  return 0;
}
static tsv arrproto_elements(tsv recv, const char* name);
tsv ts_array_slice(tsv arr, double start, double end, int has_end){
  ts_array* a=as_arr(arr);
  /* a typed array (the rest of `const [x, ...r] = view`) or another array-like */
  if(!a) return ts_is_typed_array(arr) || ts_object_like(arr) || ts_is_str(arr)
    ? ts_array_slice(arrproto_elements(arr, "slice"), start, end, has_end) : ts_new_array(0);
  long n=(long)a->len, s=ts_slice_index(start,(long)a->len), e=has_end ? ts_slice_index(end,(long)a->len) : n;
  if(e<s)e=s;
  ts_gc_root(&arr);
  tsv out=ts_new_array(0);
  ts_gc_root(&out);
  for(long i=s;i<e;i++){
    a=as_arr(arr);
    if (a && i<(long)a->len && !array_is_hole(a->data[i])) ts_array_push(out, a->data[i]);
    else ts_array_push_hole(out);
  }
  ts_gc_unroot(2);
  return out;
}
/* new Array(n): a sparse array of length n (no indexed own properties). */
tsv ts_array_new_length(double n){
  long len=(long)n; if(len<0) len=0;
  return ts_new_array((uint32_t)len);
}
tsv ts_array_concat(tsv x, tsv y){
  /* concat one argument onto a copy of x: an array argument is spread, any other
     value is appended as a single element (JS Array.prototype.concat semantics). */
  ts_gc_root(&x); ts_gc_root(&y);
  tsv out=ts_new_array(0);
  ts_gc_root(&out);
  ts_array* a=as_arr(x);
  if(a) for(uint32_t i=0;i<a->len;i++){
    if (array_is_hole(a->data[i])) ts_array_push_hole(out); else ts_array_push(out,a->data[i]);
    a=as_arr(x);
  }
  if(ts_is_array(y)){
    ts_array* b=as_arr(y);
    for(uint32_t i=0;i<b->len;i++){
      if (array_is_hole(b->data[i])) ts_array_push_hole(out); else ts_array_push(out,b->data[i]);
      b=as_arr(y);
    }
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
/* `arr.splice(start, 0, item)` whose result is discarded (the checker's
   `typeSet.splice(~index, 0, type)`, 352k calls per compile): insert in
   place — grow like push, shift the tail, store — with no items array, no
   removed array and no rebuilt buffer (docs/splice_fast_paths_design.md). */
tsv ts_array_splice_insert1(tsv arr, double start, tsv item){
  ts_array* a=as_arr(arr); if(!a) return TS_UNDEFINED;
  if(ts_arr_frozen(arr)){ ts_array_set(arr, a->len, item); return TS_UNDEFINED; }   /* strict: a frozen array throws (ts_array_set's message) */
  long n=(long)a->len;
  long s=(long)start; if(s<0){ s+=n; if(s<0)s=0; } if(s>n) s=n;
  array_ensure_cap(a, (uint32_t)n+1u);
  memmove(a->data+s+1, a->data+s, (size_t)(n-s)*sizeof(tsv));
  a->data[s]=item;
  a->len=(uint32_t)n+1u;
  array_invalidate_dirty(a);
  ts_write_barrier(arr, item);
  return TS_UNDEFINED;
}
static tsv ts_array_splice_impl(tsv arr, double start, double dc, int has_dc, tsv items, int want_removed);
tsv ts_array_splice(tsv arr, double start, double dc, int has_dc, tsv items){
  return ts_array_splice_impl(arr, start, dc, has_dc, items, 1);
}
/* splice whose result is discarded: no removed array. */
tsv ts_array_splice_drop(tsv arr, double start, double dc, int has_dc, tsv items){
  ts_array_splice_impl(arr, start, dc, has_dc, items, 0);
  return TS_UNDEFINED;
}
static tsv ts_array_splice_impl(tsv arr, double start, double dc, int has_dc, tsv items, int want_removed){
  ts_array* a=as_arr(arr); if(!a) return want_removed ? ts_new_array(0) : TS_UNDEFINED;
  if(ts_arr_frozen(arr)){ ts_array_set(arr, a->len, TS_UNDEFINED); return want_removed ? ts_new_array(0) : TS_UNDEFINED; }   /* strict: a frozen array throws (ts_array_set's message) */
  ts_gc_root(&arr); ts_gc_root(&items);
  tsv removed = want_removed ? ts_new_array(0) : TS_UNDEFINED;
  ts_gc_root(&removed);
  a=as_arr(arr);
  long n=(long)a->len;
  long s=(long)start; if(s<0){ s+=n; if(s<0)s=0; } if(s>n) s=n;
  long del = has_dc ? (long)dc : (n-s); if(del<0) del=0; if(del>n-s) del=n-s;
  if (want_removed) for(long i=0;i<del;i++){
    a=as_arr(arr);
    if (array_is_hole(a->data[s+i])) ts_array_push_hole(removed);
    else ts_array_push(removed, a->data[s+i]);
  }
  ts_array* it=as_arr(items); long ni = it?(long)it->len:0;
  long newlen = n - del + ni;
  /* rebuild data buffer: [0,s) + items + [s+del,n). No GC between malloc and
     assignment, so the raw pointers stay valid. */
  tsv* nd = (tsv*)gc_owned_alloc(&as_arr(arr)->o.h, (size_t)(newlen?newlen:1)*sizeof(tsv));
  long w=0;
  a=as_arr(arr);
  for(long i=0;i<s;i++) nd[w++]=a->data[i];
  it=as_arr(items); for(long i=0;i<ni;i++) nd[w++]=it->data[i];
  a=as_arr(arr); for(long i=s+del;i<n;i++) nd[w++]=a->data[i];
  array_free_data(a);
  if (newlen <= 4) {
    a->data = a->inline_data;
    a->cap = 4;
    for (uint32_t i=0;i<4;i++) a->data[i] = (i < (uint32_t)newlen) ? nd[i] : TS_ARRAY_HOLE;
    gc_owned_free(nd);
  } else {
    a->data=nd;
    a->cap=(uint32_t)newlen;
  }
  a->len=(uint32_t)newlen;
  array_invalidate_dirty(a);
  for (uint32_t i=0;i<a->len;i++) ts_write_barrier(arr, a->data[i]);
  ts_gc_unroot(3);
  return removed;
}
static tsv ts_array_join_slow(tsv arr, tsv sep){
  if(!ts_is_indexed_array_fast(arr)) return ts_new_string("",0);
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
    tsv e=ts_array_get(arr, i);
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
  if(!ts_is_indexed_array_fast(arr)) return ts_new_string("",0);
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
    tsv e=ts_array_get(arr, i);
    if(!ts_array_join_fast_value(e)){
      ts_gc_unroot(2);
      return ts_array_join_slow(arr, sep);
    }
  }

  enum { TS_JOIN_STACK_PARTS = 16 };
  tsv stack_parts[TS_JOIN_STACK_PARTS];
  tsv* parts = len == 0 ? NULL : (len <= TS_JOIN_STACK_PARTS
    ? stack_parts
    : (tsv*)malloc(sizeof(tsv) * len));
  int heap_parts = parts && parts != stack_parts;
  uint32_t rooted = 0;
  uint64_t total = 0;
  uint32_t out_flags = ts_str_view_typed(sep).flags & TS_STR_FLAG_UTF16;
  uint32_t sep_len = ts_str_len_typed(sep);
  int all_ascii = len <= 1 || !!(ts_str_view_typed(sep).flags & TS_STR_FLAG_ASCII);
  if(len > 1) total += (uint64_t)sep_len * (uint64_t)(len - 1);
  for(uint32_t i=0;i<len;i++){
    a=as_arr(arr);
    tsv e=ts_array_get(arr, i);
    if(e==TS_UNDEFINED || e==TS_NULL){
      parts[i]=TS_UNDEFINED;
      continue;
    }
    parts[i]=ts_is_str(e) ? e : ts_to_string_v(e);
    ts_gc_root(&parts[i]);
    rooted++;
    ts_strview pv=ts_str_view_typed(parts[i]);
    out_flags |= pv.flags & TS_STR_FLAG_UTF16;
    all_ascii = all_ascii && !!(pv.flags & TS_STR_FLAG_ASCII);
    total += pv.len;
    if(total > UINT32_MAX){
      ts_gc_unroot((int)rooted + 2);
      if (heap_parts) free(parts);
      fprintf(stderr, "tsaot: RangeError: joined string too large\n");
      abort();
    }
  }
  if(total==0){
    ts_gc_unroot((int)rooted + 2);
    if (heap_parts) free(parts);
    return ts_new_string("",0);
  }

  if(all_ascii && total <= TS_SHORTSTR_MAX){
    char data[TS_SHORTSTR_MAX];
    uint32_t pos=0;
    ts_strview sepv=ts_str_view_typed(sep);
    for(uint32_t i=0;i<len;i++){
      if(i>0)
        for(uint32_t j=0;j<sepv.len;j++) data[pos++]=(char)ts_str_cu_at_view(sepv,j);
      if(parts[i]!=TS_UNDEFINED){
        ts_strview v=ts_str_view_typed(parts[i]);
        for(uint32_t j=0;j<v.len;j++) data[pos++]=(char)ts_str_cu_at_view(v,j);
      }
    }
    tsv r=ts_short_str_ascii(data,(uint32_t)total);
    RT_STAT_INC(short_string);
    ts_gc_unroot((int)rooted + 2);
    if (heap_parts) free(parts);
    return r;
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
  out->flags=out_flags | (all_ascii ? TS_STR_FLAG_ASCII : 0);
  out->hash=0; /* lazy: join/SSR sinks do not normally need a hash */
  out->parent=TS_UNDEFINED;
  out->offset=0;
  tsv r=ts_str_v(out);
  ts_gc_unroot((int)rooted + 2);
  if (heap_parts) free(parts);
  return r;
}
tsv ts_array_pop(tsv arr){
  ts_array* a = ts_is_indexed_array_fast(arr) ? (ts_array*)ts_ptr(arr) : NULL;
  if(!a||a->len==0) return TS_UNDEFINED;
  if (ts_arr_frozen(arr)) return TS_UNDEFINED;   /* frozen: no mutation */
  if (a->sparse){   /* stays sparse: take the last entry, if any */
    uint32_t last = a->len - 1u;
    ts_sparse_elems* s = array_sparse_table(a);
    uint32_t h = sparse_find(s, last);
    tsv v = TS_ARRAY_HOLE;
    if (h != ARRAY_SPARSE_EMPTY){ v = sparse_vals(s)[h]; sparse_vals(s)[h] = TS_ARRAY_HOLE; }
    a->len = last;
    return array_is_hole(v) ? TS_UNDEFINED : v;
  }
  tsv v=a->data[a->len-1];
  a->data[a->len-1]=TS_ARRAY_HOLE;   /* keep [len, cap) holes */
  a->len--;
  return array_is_hole(v) ? TS_UNDEFINED : v;
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

int ts_is_map(tsv v){
  return ts_is_obj(v) && ((ts_gc_header*)ts_ptr(v))->kind == TS_KIND_MAP &&
         !((ts_map*)ts_ptr(v))->weak;
}
int ts_is_set(tsv v){
  return ts_is_obj(v) && ((ts_gc_header*)ts_ptr(v))->kind == TS_KIND_SET &&
         !((ts_set_t*)ts_ptr(v))->weak;
}
int ts_is_weakmap(tsv v){
  return ts_is_obj(v) && ((ts_gc_header*)ts_ptr(v))->kind == TS_KIND_MAP &&
         ((ts_map*)ts_ptr(v))->weak;
}
int ts_is_weakset(tsv v){
  return ts_is_obj(v) && ((ts_gc_header*)ts_ptr(v))->kind == TS_KIND_SET &&
         ((ts_set_t*)ts_ptr(v))->weak;
}

static tsv ts_new_map_impl(int weak){
  ts_map* m = gc_alloc(sizeof(ts_map), TS_KIND_MAP);
  m->o.proto = weak
    ? (ts_proto_ref(g_weakmap_proto_v) ? g_weakmap_proto_v : TS_NULL)
    : (ts_proto_ref(g_map_proto_v) ? g_map_proto_v : TS_NULL);
  m->keys=NULL; m->vals=NULL; m->hashes=NULL; m->len=0; m->cap=0;
  m->index=NULL; m->index_cap=0; m->tombs=0;
  m->weak=(uint8_t)(weak != 0);
  m->iteration_order=NULL; m->next_iteration_order=1;
  return ts_obj(m);
}
static tsv ts_new_set_impl(int weak){
  ts_set_t* s = gc_alloc(sizeof(ts_set_t), TS_KIND_SET);
  s->o.proto = weak
    ? (ts_proto_ref(g_weakset_proto_v) ? g_weakset_proto_v : TS_NULL)
    : (ts_proto_ref(g_set_proto_v) ? g_set_proto_v : TS_NULL);
  s->elems=NULL; s->hashes=NULL; s->len=0; s->cap=0;
  s->index=NULL; s->index_cap=0; s->tombs=0;
  s->weak=(uint8_t)(weak != 0);
  s->iteration_order=NULL; s->next_iteration_order=1;
  return ts_obj(s);
}
tsv ts_new_map(void){ return ts_new_map_impl(0); }
tsv ts_new_set(void){ return ts_new_set_impl(0); }
tsv ts_new_weakmap(void){ return ts_new_map_impl(1); }
tsv ts_new_weakset(void){ return ts_new_set_impl(1); }

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
/* The bits of -0: Map.prototype.set and Set.prototype.add store a -0 key as
   +0 (ECMA-262 24.1.3.9 step 5, 24.2.3.1 step 4), so iteration yields +0. */
#define TS_MAPSET_NEG_ZERO 0x8000000000000000ull

/* Hash consistent with same_value_zero: sv0(a,b) => hash(a)==hash(b).
   numbers by canonical double value (±0 folded, one NaN), strings by content
   (cached storage hash when present), heap cells by identity — the C0
   identity-hash design: raw stable id (handle id today; the NONHEAP fallback
   is the address, stable because NONHEAP never moves) mixed at the use site. */
/* sv0_hash of a number: ±0 folded, one NaN, then the finalizer below. */
TS_RT_ALWAYS_INLINE uint32_t sv0_hash_num(tsv k){
  double d = ts_to_num(k);
  uint64_t bits;
  if (d == 0) d = 0;                            /* -0 → +0 */
  if (d != d) bits = 0x7FF8000000000000ull;     /* canonical NaN */
  else memcpy(&bits, &d, sizeof bits);
  bits ^= bits >> 33; bits *= 0xff51afd7ed558ccdull; bits ^= bits >> 33;
  return (uint32_t)bits;
}
TS_RT_ALWAYS_INLINE uint32_t sv0_hash(tsv k){
  uint64_t bits;
  if (ts_is_num(k)){
    return sv0_hash_num(k);
  } else if (ts_is_str(k)){
    return ts_str_hash_of(k);
  } else if (ts_heap_ref(k)){
    /* identity: the cell's address (cells never move); the high half of
       the product mixes every address bit into the index bits */
    uint64_t x = ((k & TS_PAYLOAD_MASK) >> 4) * 0x9E3779B97F4A7C15ull;
    return (uint32_t)(x >> 32);
  } else {
    bits = k;                                    /* bool/undefined/null singletons */
  }
  bits ^= bits >> 33; bits *= 0xff51afd7ed558ccdull; bits ^= bits >> 33;
  return (uint32_t)bits;
}

/* A slot word of the hash index: 0 (empty), 1 (tombstone), or the dense index
   + 2 in the bits under the table mask and the key's hash bits above it (the
   bits the slot position does not already fix). A probe passes over other
   keys by those bits, without reading the dense arrays: a miss reads
   contiguous slots only (a third of the lookups of a compiler's side tables
   are misses, which walk several slots), and a hit reads the one key. The
   table has at least 2 * (len + 2) slots, so the index + 2 fits the mask. */
#define TS_MAPSET_SLOT(dense_idx, h, mask) (((h) & ~(mask)) | ((dense_idx) + 2u))

/* Probe the slot table for k. Hit: returns the dense index, *slot_out = its
   slot. Miss: returns -1, *slot_out = preferred insertion slot (first
   tombstone on the probe path, else the terminating empty). The maintenance
   rule keeps at least a quarter of the slots empty, so the walk terminates. */
static inline long mapset_probe(const uint32_t* index, uint32_t index_cap, const tsv* keys,
                                tsv k, uint32_t h, uint32_t* slot_out){
  uint32_t mask = index_cap - 1u;
  uint32_t slot = h & mask;
  long ins = -1;
  unsigned long long probes = 0;
  for (;;){
    uint32_t w = index[slot];
    probes++;
    if (w == 0u){
      if (slot_out) *slot_out = (ins >= 0) ? (uint32_t)ins : slot;
      RT_STAT_ADD(map_find_probes, probes); RT_STAT_HIST(map_find_hist, probes);
      return -1;
    }
    if (w == 1u){
      if (ins < 0) ins = (long)slot;
    } else if (((w ^ h) & ~mask) == 0u){
      uint32_t di = (w & mask) - 2u;
      tsv key = keys[di];
      if (key == k || same_value_zero(key, k)){   /* identical bits are SameValueZero */
        if (slot_out) *slot_out = slot;
        RT_STAT_ADD(map_find_probes, probes); RT_STAT_HIST(map_find_hist, probes);
        return (long)di;
      }
    }
    slot = (slot + 1u) & mask;
  }
}
/* Find k by a scan of the dense entries (a collection below the index size).
   Holes are skipped before the SameValueZero test: a hole is a short-string
   pattern of length 0, equal to "" by content. */
static inline long mapset_scan(const tsv* keys, const uint32_t* hashes, uint32_t len,
                               tsv k, uint32_t h){
  for (uint32_t i = 0; i < len; i++){
    tsv key = keys[i];
    if (key == k ||
        (hashes[i] == h && key != TS_MAPSET_HOLE && same_value_zero(key, k))){
      RT_STAT_ADD(map_find_probes, i+1); RT_STAT_HIST(map_find_hist, i+1);
      return (long)i;
    }
  }
  RT_STAT_ADD(map_find_probes, len); RT_STAT_HIST(map_find_hist, len+1);
  return -1;
}
static void mapset_index_insert(uint32_t* index, uint32_t index_cap,
                                uint32_t dense_idx, uint32_t h){
  uint32_t mask = index_cap - 1u;
  uint32_t slot = h & mask;
  while (index[slot] > 1u) slot = (slot + 1u) & mask; /* stop at empty or tomb */
  index[slot] = TS_MAPSET_SLOT(dense_idx, h, mask);
}
/* (Re)build the slot table over the live dense entries. Sized so the table is
   at most half full at build time (load stays < 3/4 until the next rebuild). */
static uint32_t* mapset_index_build(const ts_gc_header* owner, const tsv* keys, const uint32_t* hashes,
                                    uint32_t len, uint32_t* cap_io){
  uint32_t want = (len + 2u) * 2u;
  uint32_t cap = 16u;
  while (cap < want) cap <<= 1;
  uint32_t* index = (uint32_t*)gc_owned_alloc(owner, sizeof(uint32_t) * cap);
  memset(index, 0, sizeof(uint32_t) * cap);
  for (uint32_t i = 0; i < len; i++){
    if (keys[i] == TS_MAPSET_HOLE) continue;
    mapset_index_insert(index, cap, i, hashes[i]);
  }
  *cap_io = cap;
  return index;
}
/* Ensure the index exists (past the linear-scan size) and has slack for one
   more insertion. Never touches the dense arrays — safe against iterators. */
static void mapset_index_maintain(const ts_gc_header* owner, tsv* keys, uint32_t* hashes,
                                  uint32_t len, uint32_t tombs,
                                  uint32_t** index_io, uint32_t* cap_io){
  uint32_t live = len - tombs;
  if (!*index_io){
    if (live < TS_MAPSET_LINEAR_MAX) return;
  } else if ((uint64_t)(len + 2u) * 4u <= (uint64_t)(*cap_io) * 3u){
    return;
  }
  uint32_t* nw = mapset_index_build(owner, keys, hashes, len, cap_io);
  gc_owned_free(*index_io); *index_io = nw;
}

/* find key index in a map, or -1 (holes never match: probe skips them by
   slot state, and the linear fallback compares the sentinel bit-exactly first) */
static long map_find(ts_map* m, tsv k){
  RT_STAT_INC(map_find_calls);
  uint32_t h = sv0_hash(k);
  if (m->index) return mapset_probe(m->index, m->index_cap, m->keys, k, h, NULL);
  return mapset_scan(m->keys, m->hashes, m->len, k, h);
}
static void map_grow(ts_map* m){
  if (m->len < m->cap) return;
  uint32_t nc = m->cap ? m->cap*2 : 8;
  const ts_gc_header* ow = &m->o.h;
  m->keys = (tsv*)gc_owned_realloc(ow, m->keys, sizeof(tsv) * m->cap, sizeof(tsv) * nc);
  m->vals = (tsv*)gc_owned_realloc(ow, m->vals, sizeof(tsv) * m->cap, sizeof(tsv) * nc);
  m->hashes = (uint32_t*)gc_owned_realloc(ow, m->hashes, sizeof(uint32_t) * m->cap, sizeof(uint32_t) * nc);
  if (m->iteration_order) m->iteration_order = (uint64_t*)gc_owned_realloc(ow, m->iteration_order, sizeof(uint64_t) * m->cap, sizeof(uint64_t) * nc);
  m->cap = nc;
}
/* Shift live entries down over the holes (order preserved) and rebuild the
   index. Delete-path only: iteration positions move, which is the same
   observable class as the pre-index implementation's immediate shift. */
static void map_compact(ts_map* m){
  if (m->o.h.gen == TS_GEN_OLD && m->o.h.remembered) m->gc_dirty_all = 1;
  uint32_t w = 0;
  for (uint32_t i = 0; i < m->len; i++){
    if (m->keys[i] == TS_MAPSET_HOLE) continue;
    m->keys[w] = m->keys[i]; m->vals[w] = m->vals[i];
    if (m->iteration_order) m->iteration_order[w] = m->iteration_order[i];
    m->hashes[w] = m->hashes[i]; w++;
  }
  m->len = w; m->tombs = 0;
  if (m->index){
    uint32_t* nw = mapset_index_build(&m->o.h, m->keys, m->hashes, m->len, &m->index_cap);
    gc_owned_free(m->index); m->index = nw;
  }
}
static inline void map_write_barrier(ts_map* m, uint32_t index, tsv value){
  if (m->o.h.gen != TS_GEN_OLD || !ts_heap_ref(value)) return;
  ts_gc_header* child = ts_heap_ptr(value);
  if (!child || child->gen != TS_GEN_YOUNG) return;
  uint32_t card = index >> GC_CONTAINER_CARD_SHIFT;
  if (card >= UINT16_MAX) m->gc_dirty_all = 1;
  else {
    if (!m->gc_dirty_end || card < m->gc_dirty_first) m->gc_dirty_first = (uint16_t)card;
    if (card >= m->gc_dirty_end) m->gc_dirty_end = (uint16_t)(card + 1u);
  }
  gc_remember(&m->o.h);
}
static tsv map_set_unchecked(tsv mv, tsv k, tsv v){
  ts_map* m = ts_ptr(mv);
  uint32_t slot = 0;
  if (k == TS_MAPSET_NEG_ZERO) k = ts_num(0);   /* a -0 key is stored as +0 */
  uint32_t h = sv0_hash(k);
  long i;
  if (m->index){ RT_STAT_INC(map_find_calls); i = mapset_probe(m->index, m->index_cap, m->keys, k, h, &slot); }
  else { RT_STAT_INC(map_find_calls); i = mapset_scan(m->keys, m->hashes, m->len, k, h); }
  if (i >= 0){ m->vals[i] = v; map_write_barrier(m, (uint32_t)i, v); return mv; }   /* update existing, keep order */
  map_grow(m);
  if (m->iteration_order) m->iteration_order[m->len] = m->next_iteration_order++;
  m->keys[m->len]=k; m->vals[m->len]=v; m->hashes[m->len]=h; m->len++;
  if (m->index){
    /* reuse the probe's slot (tomb or empty); maintain slack afterwards */
    m->index[slot] = TS_MAPSET_SLOT(m->len - 1u, h, m->index_cap - 1u);
    mapset_index_maintain(&m->o.h, m->keys, m->hashes, m->len, m->tombs, &m->index, &m->index_cap);
  } else {
    mapset_index_maintain(&m->o.h, m->keys, m->hashes, m->len, m->tombs, &m->index, &m->index_cap);
  }
  map_write_barrier(m, m->len - 1u, k); map_write_barrier(m, m->len - 1u, v);
  return mv;
}
tsv ts_map_set(tsv mv, tsv k, tsv v){
  if (!ts_is_map(mv)) ts_throw_type_error_msg("Method Map.prototype.set called on incompatible receiver");
  return map_set_unchecked(mv, k, v);
}
/* The common lookup, without a call: an indexed map and a number key, found
   by the key's very bits (a stored number key is canonical: +0, one NaN) or
   absent. -2 for anything else (another kind of key, a slot whose key is an
   equal number with other bits): map_find decides. */
TS_RT_ALWAYS_INLINE long map_find_num_fast(const ts_map* m, tsv k){
  if (!m->index || !ts_is_num(k)) return -2;
  uint32_t h = sv0_hash_num(k);
  uint32_t mask = m->index_cap - 1u, slot = h & mask;
  for (;;){
    uint32_t w = m->index[slot];
    if (w == 0u) return -1;
    if (w != 1u && ((w ^ h) & ~mask) == 0u){
      uint32_t di = (w & mask) - 2u;
      return m->keys[di] == k ? (long)di : -2;
    }
    slot = (slot + 1u) & mask;
  }
}
tsv ts_map_get(tsv mv, tsv k){
  if (!ts_is_map(mv)){ ts_throw_type_error_msg("Method Map.prototype.get called on incompatible receiver"); return TS_UNDEFINED; }
  ts_map* m = ts_ptr(mv);
  long i = map_find_num_fast(m, k);
  if (TS_RT_UNLIKELY(i == -2)) i = map_find(m, k);
  return i>=0 ? m->vals[i] : TS_UNDEFINED;
}
int ts_map_has(tsv mv, tsv k){
  if (!ts_is_map(mv)){ ts_throw_type_error_msg("Method Map.prototype.has called on incompatible receiver"); return 0; }
  ts_map* m = ts_ptr(mv);
  long i = map_find_num_fast(m, k);
  if (TS_RT_UNLIKELY(i == -2)) i = map_find(m, k);
  return i >= 0;
}
static int map_delete_unchecked(tsv mv, tsv k){
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
  if (m->o.h.gen == TS_GEN_OLD && m->o.h.remembered) m->gc_dirty_all = 1;
  for (uint32_t j=(uint32_t)i; j+1<m->len; j++){
    m->keys[j]=m->keys[j+1]; m->vals[j]=m->vals[j+1];
    if (m->iteration_order) m->iteration_order[j]=m->iteration_order[j+1];
    m->hashes[j]=m->hashes[j+1];
  }
  m->len--; return 1;
}
int ts_map_delete(tsv mv, tsv k){
  if (!ts_is_map(mv)) ts_throw_type_error_msg("Method Map.prototype.delete called on incompatible receiver");
  return map_delete_unchecked(mv, k);
}
void ts_map_clear(tsv mv){
  if (!ts_is_map(mv)) ts_throw_type_error_msg("Method Map.prototype.clear called on incompatible receiver");
  if (ts_is_map(mv)){
    ts_map* m=ts_ptr(mv); m->len=0; m->tombs=0;
    if (m->index) memset(m->index, 0, sizeof(uint32_t)*m->index_cap);
  }
}
double ts_map_size(tsv mv){
  if (!ts_is_map(mv)){ ts_throw_type_error_msg("Method get Map.prototype.size called on incompatible receiver"); return 0; }
  ts_map* m = ts_ptr(mv);
  return (double)(m->len - m->tombs);
}
static tsv g_map_iterator_proto = TS_NULL;
static tsv g_set_iterator_proto = TS_NULL;
static tsv g_array_iterator_proto = TS_NULL;
static ts_key g_ai_source, g_ai_index, g_ai_next, g_ai_value, g_ai_done, g_ai_kind;
static tsv ts_array_iterator_identity(tsv* args, int n){ return n ? args[0] : TS_UNDEFINED; }
/* Array Iterator objects (docs/array_iterators_design.md): the source array,
   the next index and the kind (values 0, keys 1, entries 2) in hidden fields;
   each step reads the array's current length, so the iteration is live. */
static tsv ts_array_iterator_next(tsv* args, int n){
  tsv iter = n ? args[0] : TS_UNDEFINED; ts_gc_root(&iter);
  static ts_rt_ic ic_index, ic_source, ic_kind;
  tsv index = ts_get_ic(iter, g_ai_index, &ic_index);
  if (!ts_is_num(index)) ts_throw_type_error_msg("Array iterator next called on incompatible receiver");
  tsv source = ts_get_ic(iter, g_ai_source, &ic_source); ts_gc_root(&source);
  tsv kindv = ts_get_ic(iter, g_ai_kind, &ic_kind);
  int kind = ts_is_num(kindv) ? (int)ts_to_num(kindv) : 0;
  double pos = ts_to_num(index);
  int done = ts_is_typed_array(source) ? pos >= ((ts_typedarray*)ts_ptr(source))->length
                                       : (!ts_is_array(source) || pos >= ts_array_len(source));
  tsv value = TS_UNDEFINED; ts_gc_root(&value);
  if (done) ts_set_ic(iter, g_ai_source, TS_UNDEFINED, &ic_source);
  else {
    ts_set_ic(iter, g_ai_index, ts_num(pos + 1), &ic_index);
    if (kind == 1) value = ts_num(pos);
    else {
      value = ts_array_get(source, (uint32_t)pos);
      if (kind == 2){
        tsv pair = ts_new_array(0); ts_gc_root(&pair);
        ts_array_push(pair, ts_num(pos)); ts_array_push(pair, value);
        value = pair;
        ts_gc_unroot(1);
      }
    }
  }
  tsv result = ts_iter_result_new(value, done);
  ts_gc_unroot(3);
  return result;
}
tsv ts_array_iter_new(tsv source, int kind){
  if (!ts_is_array(source) && !ts_is_typed_array(source)) ts_throw_type_error_msg("Array iterator requires an array receiver");
  ts_gc_root(&source);
  if (g_array_iterator_proto == TS_NULL){
    g_ai_source = ts_intern_field("__array_iterator_source", 23);
    g_ai_index = ts_intern_field("__array_iterator_index", 22);
    g_ai_kind = ts_intern_field("__array_iterator_kind", 21);
    g_ai_next = ts_intern_field("next", 4);
    g_ai_value = ts_intern_field("value", 5);
    g_ai_done = ts_intern_field("done", 4);
    static int rooted = 0;
    g_array_iterator_proto = ts_new_proto();
    ts_root_static_once(&g_array_iterator_proto, &rooted);
    tsv next = ts_make_fn_t(ts_array_iterator_next, NULL, 0, 1); ts_gc_root(&next);
    ts_set_fn_meta(next, 0, "next");
    ts_define_data(g_array_iterator_proto, g_ai_next, next, 0, 1, 1);
    tsv identity = ts_make_fn_t(ts_array_iterator_identity, NULL, 0, 1); ts_gc_root(&identity);
    ts_define_data(g_array_iterator_proto, TS_KEY_WKSYM(TS_WKSYM_ITERATOR), identity, 0, 1, 1);
    tsv tag = ts_new_string("Array Iterator", 14); ts_gc_root(&tag);
    ts_define_data(g_array_iterator_proto, TS_KEY_WKSYM(TS_WKSYM_TO_STRING_TAG), tag, 0, 0, 1);
    ts_gc_unroot(3);
  }
  tsv iter = ts_new_object(); ts_gc_root(&iter);
  obj_link_fresh_proto(iter, g_array_iterator_proto);
  ts_define_data(iter, g_ai_source, source, 0, 1, 0);
  ts_define_data(iter, g_ai_index, ts_num(0), 0, 1, 0);
  ts_define_data(iter, g_ai_kind, ts_num((double)kind), 0, 1, 0);
  ts_gc_unroot(2);
  return iter;
}
static tsv ts_array_iterator(tsv* args, int n){ return ts_array_iter_new(n ? args[0] : TS_UNDEFINED, 0); }
/* Array.prototype.values / keys / entries reached dynamically */
tsv ts_arrproto_values(tsv* args, int n){ return ts_array_iter_new(n ? args[0] : TS_UNDEFINED, 0); }
tsv ts_arrproto_keys(tsv* args, int n){ return ts_array_iter_new(n ? args[0] : TS_UNDEFINED, 1); }
tsv ts_arrproto_entries(tsv* args, int n){ return ts_array_iter_new(n ? args[0] : TS_UNDEFINED, 2); }
/* Runtime inline caches (ts_rt.h): a monomorphic shape/slot per call site for
   the runtime's own hidden-field reads and writes. The shape word carries the
   integrity bits, so a frozen receiver misses and takes the generic path. */
tsv ts_get_ic(tsv obj, ts_key key, ts_rt_ic* ic){
  if (TS_TOP16(obj) == TS_SEL_OBJECT){
    ts_object* o = (ts_object*)ts_ptr(obj);
    if (o->h.kind == TS_KIND_OBJECT){
      if (ic->shape != 0 && o->shape == ic->shape) return *ts_obj_slot_ptr(o, ic->slot);
      if (obj_shaped(o)){
        ts_pref p = prop_find(o, key);
        if (pref_ok(p) && !pref_is_accessor(p)){ ic->shape = o->shape; ic->slot = p.i; return *pref_valp(p); }
      }
    }
  }
  return ts_get(obj, key);
}
void ts_set_ic(tsv obj, ts_key key, tsv v, ts_rt_ic* ic){
  if (TS_TOP16(obj) == TS_SEL_OBJECT){
    ts_object* o = (ts_object*)ts_ptr(obj);
    if (o->h.kind == TS_KIND_OBJECT && !(ts_obj_integrity(o) & 1u)){
      if (ic->shape != 0 && o->shape == ic->shape){
        tsv* p = ts_obj_slot_ptr(o, ic->slot); *p = v; ts_write_barrier_ptr(obj, p, v); return;
      }
      if (obj_shaped(o)){
        ts_pref p = prop_find(o, key);
        if (pref_ok(p) && !pref_is_accessor(p) && pref_is_writable(p)){
          ic->shape = o->shape; ic->slot = p.i;
          tsv* vp = pref_valp(p); *vp = v; ts_write_barrier_ptr(obj, vp, v); return;
        }
      }
    }
  }
  ts_set(obj, key, v);
}
/* An iterator result `{ value, done }` from a fixed layout: one allocation,
   no transitions; the same shape every time, so the loops' cached reads hit. */
static ts_key g_iter_result_keys[2];
static ts_lit_layout g_iter_result_layout = { 0, 2, g_iter_result_keys };
static tsv ts_iter_result_new(tsv value, int done){
  if (!g_iter_result_keys[0]){
    g_iter_result_keys[0] = ts_intern_field("value", 5);
    g_iter_result_keys[1] = ts_intern_field("done", 4);
  }
  ts_gc_root(&value);
  tsv r = ts_new_object_layout(&g_iter_result_layout);
  ts_lit_store(r, 0, value);
  ts_lit_store(r, 1, ts_bool(done));
  ts_gc_unroot(1);
  return r;
}
static ts_key g_mi_source, g_mi_last, g_mi_kind, g_mi_next, g_mi_value, g_mi_done;
static tsv ts_map_iterator_identity(tsv* args, int n){ return n ? args[0] : TS_UNDEFINED; }
static tsv ts_map_iterator_next(tsv* args, int n){
  tsv iter = n ? args[0] : TS_UNDEFINED;
  ts_gc_root(&iter);
  static ts_rt_ic ic_kind, ic_source, ic_last;
  tsv kindv = ts_get_ic(iter, g_mi_kind, &ic_kind);
  if (!ts_is_num(kindv)) ts_throw_type_error_msg("Collection iterator next called on incompatible receiver");
  int kind = (int)ts_to_num(kindv);
  tsv source = ts_get_ic(iter, g_mi_source, &ic_source); ts_gc_root(&source);
  tsv value = TS_UNDEFINED; ts_gc_root(&value);
  int done = 1;
  if (ts_is_map(source) || ts_is_set(source)) {
    int is_map = ts_is_map(source);
    uint32_t len = is_map ? ((ts_map*)ts_ptr(source))->len : ((ts_set_t*)ts_ptr(source))->len;
    uint64_t* order = is_map ? ((ts_map*)ts_ptr(source))->iteration_order : ((ts_set_t*)ts_ptr(source))->iteration_order;
    tsv* keys = is_map ? ((ts_map*)ts_ptr(source))->keys : ((ts_set_t*)ts_ptr(source))->elems;
    double last = ts_number_coerce(ts_get_ic(iter, g_mi_last, &ic_last));
    uint32_t low = 0, high = len;
    // Insertion IDs survive deletion, compaction, clear and reinsertion. Binary
    // search avoids retaining dead iterators or disabling map compaction.
    while (low < high) {
      uint32_t mid = low + (high - low) / 2;
      if ((double)order[mid] <= last) low = mid + 1;
      else high = mid;
    }
    while (low < len && keys[low] == TS_MAPSET_HOLE) low++;
    if (low < len) {
      done = 0;
      tsv key = keys[low], item = is_map ? ((ts_map*)ts_ptr(source))->vals[low] : key;
      ts_set_ic(iter, g_mi_last, ts_num((double)order[low]), &ic_last);
      if (kind == 0 || kind == 3) value = key;
      else if (kind == 1) value = item;
      else {
        tsv pair = ts_new_array(0); ts_gc_root(&pair);
        ts_array_push(pair, key); ts_array_push(pair, item);
        value = pair;
        ts_gc_unroot(1);
      }
    }
  }
  if (done) ts_set_ic(iter, g_mi_source, TS_UNDEFINED, &ic_source);
  tsv result = ts_iter_result_new(value, done);
  ts_gc_unroot(3);
  return result;
}
static void ts_map_iterator_proto_init(int is_set){
  tsv* proto = is_set ? &g_set_iterator_proto : &g_map_iterator_proto;
  if (*proto != TS_NULL) return;
  g_mi_source = ts_intern_field("__map_iterator_source", 21);
  g_mi_last = ts_intern_field("__map_iterator_last", 19);
  g_mi_kind = ts_intern_field("__map_iterator_kind", 19);
  g_mi_next = ts_intern_field("next", 4);
  g_mi_value = ts_intern_field("value", 5);
  g_mi_done = ts_intern_field("done", 4);
  static int rooted[2] = {0, 0};
  *proto = ts_new_proto();
  ts_root_static_once(proto, &rooted[is_set != 0]);
  tsv next = ts_make_fn_t(ts_map_iterator_next, NULL, 0, 1); ts_gc_root(&next);
  ts_set_fn_meta(next, 0, "next");
  ts_define_data(*proto, g_mi_next, next, 0, 1, 1);
  tsv identity = ts_make_fn_t(ts_map_iterator_identity, NULL, 0, 1); ts_gc_root(&identity);
  ts_define_data(*proto, TS_KEY_WKSYM(TS_WKSYM_ITERATOR), identity, 0, 1, 1);
  tsv tag = ts_new_string(is_set ? "Set Iterator" : "Map Iterator", 12); ts_gc_root(&tag);
  ts_define_data(*proto, TS_KEY_WKSYM(TS_WKSYM_TO_STRING_TAG), tag, 0, 0, 1);
  ts_gc_unroot(3);
}
tsv ts_map_iterator(tsv source, int kind){
  int is_set = kind >= 3;
  if (is_set ? !ts_is_set(source) : !ts_is_map(source))
    ts_throw_type_error_msg("Collection iterator requires a compatible receiver");
  ts_gc_root(&source);
  ts_map_iterator_proto_init(is_set);
  uint32_t len = is_set ? ((ts_set_t*)ts_ptr(source))->len : ((ts_map*)ts_ptr(source))->len;
  uint32_t cap = is_set ? ((ts_set_t*)ts_ptr(source))->cap : ((ts_map*)ts_ptr(source))->cap;
  uint64_t** order = is_set ? &((ts_set_t*)ts_ptr(source))->iteration_order : &((ts_map*)ts_ptr(source))->iteration_order;
  uint64_t* next = is_set ? &((ts_set_t*)ts_ptr(source))->next_iteration_order : &((ts_map*)ts_ptr(source))->next_iteration_order;
  if (!*order) {
    /* a payload of the collection, like mapset_cursor_view's (not malloc:
       the collector frees a young collection without visiting it) */
    const ts_gc_header* owner = is_set ? &((ts_set_t*)ts_ptr(source))->o.h : &((ts_map*)ts_ptr(source))->o.h;
    *order = (uint64_t*)gc_owned_alloc(owner, sizeof(uint64_t) * (cap ? cap : 1));
    if (!*order) abort();
    for (uint32_t i = 0; i < len; i++) (*order)[i] = i + 1u;
    *next = (uint64_t)len + 1u;
  }
  tsv iter = ts_new_object(); ts_gc_root(&iter);
  obj_link_fresh_proto(iter, is_set ? g_set_iterator_proto : g_map_iterator_proto);
  ts_define_data(iter, g_mi_source, source, 0, 1, 0);
  ts_define_data(iter, g_mi_last, ts_num(0), 0, 1, 0);
  ts_define_data(iter, g_mi_kind, ts_num(kind), 0, 1, 0);
  ts_gc_unroot(2);
  return iter;
}
tsv ts_map_keys(tsv mv){ return ts_map_iterator(mv, 0); }
tsv ts_map_values(tsv mv){ return ts_map_iterator(mv, 1); }
tsv ts_map_entries(tsv mv){ return ts_map_iterator(mv, 2); }
/* Cursor-driven for..of over a Map or Set (docs/map_cursor_forof_design.md):
   the same insertion-order ids as the iterator protocol (entries added during
   the loop are visited, deleted ones skipped, compaction harmless), without
   the iterator object, the result objects or the pair arrays. `last` is the
   order id of the entry visited last (-1 before the first); the next entry is
   the dense index of the first live entry with a greater id, or -1. */
static int mapset_cursor_view(tsv coll, uint32_t* len, tsv** keys, tsv** vals, uint64_t** order){
  if (ts_is_map(coll)){
    ts_map* m = (ts_map*)ts_ptr(coll);
    if (!m->iteration_order){
      uint32_t cap = m->cap ? m->cap : 1u;
      m->iteration_order = (uint64_t*)gc_owned_alloc(&m->o.h, sizeof(uint64_t) * cap);
      if (!m->iteration_order) abort();
      for (uint32_t i = 0; i < m->len; i++) m->iteration_order[i] = i + 1u;
      m->next_iteration_order = (uint64_t)m->len + 1u;
    }
    *len = m->len; *keys = m->keys; *vals = m->vals; *order = m->iteration_order;
    return 1;
  }
  if (ts_is_set(coll)){
    ts_set_t* st = (ts_set_t*)ts_ptr(coll);
    if (!st->iteration_order){
      uint32_t cap = st->cap ? st->cap : 1u;
      st->iteration_order = (uint64_t*)gc_owned_alloc(&st->o.h, sizeof(uint64_t) * cap);
      if (!st->iteration_order) abort();
      for (uint32_t i = 0; i < st->len; i++) st->iteration_order[i] = i + 1u;
      st->next_iteration_order = (uint64_t)st->len + 1u;
    }
    *len = st->len; *keys = st->elems; *vals = st->elems; *order = st->iteration_order;
    return 1;
  }
  ts_throw_type_error_msg("for-of over a Map or Set requires a Map or Set receiver");
  return 0;
}
double ts_map_cursor_next(tsv coll, double last, double prev){
  uint32_t len; tsv* keys; tsv* vals; uint64_t* order;
  if (!mapset_cursor_view(coll, &len, &keys, &vals, &order)) return -1;
  uint32_t low;
  /* The usual step: the entry visited last still sits at `prev` (no compaction
     since), so the next candidate is the following dense slot; otherwise the
     binary search over the order ids. */
  if (prev >= 0 && (uint32_t)prev < len && (double)order[(uint32_t)prev] == last){
    low = (uint32_t)prev + 1u;
  } else {
    uint32_t high = len;
    low = 0;
    while (low < high){
      uint32_t mid = low + (high - low) / 2u;
      if ((double)order[mid] <= last) low = mid + 1u; else high = mid;
    }
  }
  while (low < len && keys[low] == TS_MAPSET_HOLE) low++;
  return low < len ? (double)low : -1.0;
}
double ts_map_cursor_order(tsv coll, double idx){
  uint32_t len; tsv* keys; tsv* vals; uint64_t* order;
  if (!mapset_cursor_view(coll, &len, &keys, &vals, &order)) return -1;
  uint32_t i = (uint32_t)idx;
  return i < len ? (double)order[i] : -1.0;
}
tsv ts_map_cursor_key(tsv coll, double idx){
  uint32_t len; tsv* keys; tsv* vals; uint64_t* order;
  if (!mapset_cursor_view(coll, &len, &keys, &vals, &order)) return TS_UNDEFINED;
  uint32_t i = (uint32_t)idx;
  return (i < len && keys[i] != TS_MAPSET_HOLE) ? keys[i] : TS_UNDEFINED;
}
tsv ts_map_cursor_val(tsv coll, double idx){
  uint32_t len; tsv* keys; tsv* vals; uint64_t* order;
  if (!mapset_cursor_view(coll, &len, &keys, &vals, &order)) return TS_UNDEFINED;
  uint32_t i = (uint32_t)idx;
  return (i < len && keys[i] != TS_MAPSET_HOLE) ? vals[i] : TS_UNDEFINED;
}
tsv ts_map_cursor_pair(tsv coll, double idx){
  ts_gc_root(&coll);
  tsv pair = ts_new_array(0); ts_gc_root(&pair);
  ts_array_push(pair, ts_map_cursor_key(coll, idx));
  ts_array_push(pair, ts_map_cursor_val(coll, idx));
  ts_gc_unroot(2);
  return pair;
}
void ts_map_foreach(tsv mv, tsv cb){
  if (!ts_is_map(mv)){ ts_throw_type_error_msg("Method Map.prototype.forEach called on incompatible receiver"); return; }
  ts_map* m=ts_ptr(mv);
  uint32_t len=m->len;
  ts_gc_root(&mv); ts_gc_root(&cb);
  ts_cb cbf; cb_resolve(&cbf, cb);
  for (uint32_t i=0;i<len;i++){
    m=ts_ptr(mv);
    if (i >= m->len) break; /* shrunk during iteration (linear-mode delete shifts) */
    tsv val=m->vals[i];
    tsv key=m->keys[i];
    if (key == TS_MAPSET_HOLE) continue; /* deleted during/before iteration */
    tsv args[3]={ val, key, mv };
    cb_call(&cbf, cb, args, 3);
  }
  ts_gc_unroot(2);
}

static long set_find(ts_set_t* s, tsv v){
  RT_STAT_INC(map_find_calls);
  uint32_t h = sv0_hash(v);
  if (s->index) return mapset_probe(s->index, s->index_cap, s->elems, v, h, NULL);
  return mapset_scan(s->elems, s->hashes, s->len, v, h);
}
static void set_grow(ts_set_t* s){
  if (s->len < s->cap) return;
  uint32_t nc = s->cap ? s->cap*2 : 8;
  const ts_gc_header* ow = &s->o.h;
  s->elems = (tsv*)gc_owned_realloc(ow, s->elems, sizeof(tsv) * s->cap, sizeof(tsv) * nc);
  s->hashes = (uint32_t*)gc_owned_realloc(ow, s->hashes, sizeof(uint32_t) * s->cap, sizeof(uint32_t) * nc);
  if (s->iteration_order) s->iteration_order = (uint64_t*)gc_owned_realloc(ow, s->iteration_order, sizeof(uint64_t) * s->cap, sizeof(uint64_t) * nc);
  s->cap = nc;
}
static void set_compact(ts_set_t* s){
  uint32_t w = 0;
  for (uint32_t i = 0; i < s->len; i++){
    if (s->elems[i] == TS_MAPSET_HOLE) continue;
    s->elems[w] = s->elems[i];
    if (s->iteration_order) s->iteration_order[w] = s->iteration_order[i];
    s->hashes[w] = s->hashes[i];
    w++;
  }
  s->len = w; s->tombs = 0;
  if (s->index){
    uint32_t* nw = mapset_index_build(&s->o.h, s->elems, s->hashes, s->len, &s->index_cap);
    gc_owned_free(s->index); s->index = nw;
  }
}
static tsv set_add_unchecked(tsv sv, tsv v){
  ts_set_t* s = ts_ptr(sv);
  uint32_t slot = 0;
  if (v == TS_MAPSET_NEG_ZERO) v = ts_num(0);   /* a -0 element is stored as +0 */
  uint32_t h = sv0_hash(v);
  long i;
  if (s->index){ RT_STAT_INC(map_find_calls); i = mapset_probe(s->index, s->index_cap, s->elems, v, h, &slot); }
  else { RT_STAT_INC(map_find_calls); i = mapset_scan(s->elems, s->hashes, s->len, v, h); }
  if (i >= 0) return sv;                   /* dedup */
  set_grow(s);
  if (s->iteration_order) s->iteration_order[s->len] = s->next_iteration_order++;
  s->elems[s->len]=v; s->hashes[s->len]=h; s->len++;
  if (s->index) s->index[slot] = TS_MAPSET_SLOT(s->len - 1u, h, s->index_cap - 1u);
  mapset_index_maintain(&s->o.h, s->elems, s->hashes, s->len, s->tombs, &s->index, &s->index_cap);
  ts_write_barrier(sv, v); return sv;
}
tsv ts_set_add(tsv sv, tsv v){
  if (!ts_is_set(sv)) ts_throw_type_error_msg("Method Set.prototype.add called on incompatible receiver");
  return set_add_unchecked(sv, v);
}
int ts_set_has(tsv sv, tsv v){
  if (!ts_is_set(sv)){ ts_throw_type_error_msg("Method Set.prototype.has called on incompatible receiver"); return 0; }
  return set_find(ts_ptr(sv), v) >= 0;
}
static int set_delete_unchecked(tsv sv, tsv v){
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
  for (uint32_t j=(uint32_t)i; j+1<s->len; j++){
    s->elems[j]=s->elems[j+1];
    if (s->iteration_order) s->iteration_order[j]=s->iteration_order[j+1];
    s->hashes[j]=s->hashes[j+1];
  }
  s->len--; return 1;
}
int ts_set_delete(tsv sv, tsv v){
  if (!ts_is_set(sv)) ts_throw_type_error_msg("Method Set.prototype.delete called on incompatible receiver");
  return set_delete_unchecked(sv, v);
}
void ts_set_clear(tsv sv){
  if (!ts_is_set(sv)) ts_throw_type_error_msg("Method Set.prototype.clear called on incompatible receiver");
  if (ts_is_set(sv)){
    ts_set_t* s=ts_ptr(sv); s->len=0; s->tombs=0;
    if (s->index) memset(s->index, 0, sizeof(uint32_t)*s->index_cap);
  }
}
double ts_set_size(tsv sv){
  if (!ts_is_set(sv)){ ts_throw_type_error_msg("Method get Set.prototype.size called on incompatible receiver"); return 0; }
  ts_set_t* s = ts_ptr(sv);
  return (double)(s->len - s->tombs);
}
tsv ts_set_keys(tsv sv){
  return ts_map_iterator(sv, 3);
}
tsv ts_set_values(tsv sv){
  return ts_map_iterator(sv, 3);
}
tsv ts_set_entries(tsv sv){
  return ts_map_iterator(sv, 4);
}
void ts_set_foreach(tsv sv, tsv cb){
  if (!ts_is_set(sv)){ ts_throw_type_error_msg("Method Set.prototype.forEach called on incompatible receiver"); return; }
  ts_set_t* s=ts_ptr(sv);
  uint32_t len=s->len;
  ts_gc_root(&sv); ts_gc_root(&cb);
  ts_cb cbf; cb_resolve(&cbf, cb);
  for (uint32_t i=0;i<len;i++){
    s=ts_ptr(sv);
    if (i >= s->len) break; /* shrunk during iteration (linear-mode delete shifts) */
    tsv elem=s->elems[i];
    if (elem == TS_MAPSET_HOLE) continue; /* deleted during/before iteration */
    tsv args[3]={ elem, elem, sv };
    cb_call(&cbf, cb, args, 3);
  }
  ts_gc_unroot(2);
}

/* ---------------- WeakMap / WeakSet ----------------
   The storage and hash index are shared with Map/Set, but the `weak` bit keeps
   the public brands distinct and changes GC scanning to ephemeron semantics.
   Objects/functions and non-registered Symbols satisfy CanBeHeldWeakly.
   Symbol.for identities are registry-managed and therefore rejected. */
static int weak_key_valid(tsv key){
  if (ts_is_func(key)) return ts_ptr(key) != NULL;
  if (!ts_is_obj(key)) return 0;
  ts_gc_header* h = (ts_gc_header*)ts_ptr(key);
  if (!h) return 0;
  if (h->kind == TS_KIND_SYMBOL) return !((ts_symbol*)h)->registered;
  return h->kind != TS_KIND_ACCESSOR;
}
static void weak_key_require(tsv key, const char* collection){
  if (weak_key_valid(key)) return;
  char msg[96];
  snprintf(msg, sizeof msg, "Invalid value used as %s key", collection);
  ts_throw_type_error_msg(msg);
}
static void weak_receiver_require(tsv value, int want_map){
  if (want_map ? ts_is_weakmap(value) : ts_is_weakset(value)) return;
  ts_throw_type_error_msg(
    want_map
      ? "Method WeakMap.prototype called on incompatible receiver"
      : "Method WeakSet.prototype called on incompatible receiver");
}

tsv ts_weakmap_set(tsv mv, tsv key, tsv value){
  weak_receiver_require(mv, 1);
  weak_key_require(key, "weak map");
  return map_set_unchecked(mv, key, value);
}
tsv ts_weakmap_get(tsv mv, tsv key){
  weak_receiver_require(mv, 1);
  if (!weak_key_valid(key)) return TS_UNDEFINED;
  ts_map* m = (ts_map*)ts_ptr(mv);
  long i = map_find(m, key);
  return i >= 0 ? m->vals[i] : TS_UNDEFINED;
}
int ts_weakmap_has(tsv mv, tsv key){
  weak_receiver_require(mv, 1);
  return weak_key_valid(key) && map_find((ts_map*)ts_ptr(mv), key) >= 0;
}
int ts_weakmap_delete(tsv mv, tsv key){
  weak_receiver_require(mv, 1);
  return weak_key_valid(key) ? map_delete_unchecked(mv, key) : 0;
}
tsv ts_weakset_add(tsv sv, tsv key){
  weak_receiver_require(sv, 0);
  weak_key_require(key, "weak set");
  return set_add_unchecked(sv, key);
}
int ts_weakset_has(tsv sv, tsv key){
  weak_receiver_require(sv, 0);
  return weak_key_valid(key) && set_find((ts_set_t*)ts_ptr(sv), key) >= 0;
}
int ts_weakset_delete(tsv sv, tsv key){
  weak_receiver_require(sv, 0);
  return weak_key_valid(key) ? set_delete_unchecked(sv, key) : 0;
}

/* A key is live for a full collection only when ordinary marking reached it.
   During a minor collection every OLD cell is outside the collection boundary
   and therefore live; YOUNG/NONHEAP keys still need a mark from a strong root.
   Null handle slots are stale weak entries and are pruned before reuse. */
static int gc_weak_key_live(tsv key, int young){
  if (!weak_key_valid(key)) return 0;
  ts_gc_header* h = ts_heap_ptr(key);
  if (!h) return 0;
  if (young && h->gen == TS_GEN_OLD) return 1;
  return h->mark != 0;
}
static int gc_weak_value_unmarked(tsv value, int young){
  if (!ts_heap_ref(value)) return 0;
  ts_gc_header* h = ts_heap_ptr(value);
  if (!h || h->mark) return 0;
  return !(young && h->gen == TS_GEN_OLD);
}
static void gc_weak_fixpoint_and_prune(int young){
  int changed;
  do {
    changed = 0;
    /* The list may grow while a newly retained value exposes another weak
       container. Reading each pointer before marking makes realloc harmless. */
    for (size_t wi = 0; wi < g_weak_work_len; wi++){
      ts_gc_header* h = g_weak_work[wi];
      if (!h || h->kind != TS_KIND_MAP) continue;
      ts_map* m = (ts_map*)h;
      if (!m->weak) continue;
      for (uint32_t i = 0; i < m->len; i++){
        if (m->keys[i] == TS_MAPSET_HOLE ||
            !gc_weak_key_live(m->keys[i], young)) continue;
        if (gc_weak_value_unmarked(m->vals[i], young)){
          changed = 1;
          gc_mark_visit(m->vals[i], young, 0);
        }
      }
    }
    gc_mark_drain(young);
  } while (changed);

  /* Remove dead entries while key headers and handle slots are still valid.
     Weak collections are non-iterable, so compacting their private dense arrays
     at this GC safepoint has no observable iterator-position effect. */
  for (size_t wi = 0; wi < g_weak_work_len; wi++){
    ts_gc_header* h = g_weak_work[wi];
    if (!h) continue;
    if (h->kind == TS_KIND_MAP){
      ts_map* m = (ts_map*)h;
      if (!m->weak) continue;
      uint32_t dead = 0;
      for (uint32_t i = 0; i < m->len; i++){
        if (m->keys[i] == TS_MAPSET_HOLE) continue;
        if (!gc_weak_key_live(m->keys[i], young)){
          m->keys[i] = TS_MAPSET_HOLE;
          m->vals[i] = TS_UNDEFINED;
          m->tombs++; dead++;
        }
      }
      if (dead) map_compact(m);
    } else if (h->kind == TS_KIND_SET){
      ts_set_t* s = (ts_set_t*)h;
      if (!s->weak) continue;
      uint32_t dead = 0;
      for (uint32_t i = 0; i < s->len; i++){
        if (s->elems[i] == TS_MAPSET_HOLE) continue;
        if (!gc_weak_key_live(s->elems[i], young)){
          s->elems[i] = TS_MAPSET_HOLE;
          s->tombs++; dead++;
        }
      }
      if (dead) set_compact(s);
    }
  }
  g_weak_work_len = 0;
}

/* g_sym_value is an identity lookup service, not an owner. Clear ordinary
   Symbol entries that ordinary marking did not reach. In a minor collection,
   old symbols are outside the collection boundary and remain valid; only dead
   young entries are removed. This runs after the ephemeron fixed point so a
   value discovered through a live weak key has already had a chance to expose
   Symbol property-name edges and, in turn, more ephemerons. */
static void gc_symbol_weak_prune(int young){
  for (uint32_t i=0;i<g_sym_value_len;i++){
    tsv value = g_sym_value[i];
    if (!ts_heap_ref(value)) continue;
    ts_gc_header* h = ts_heap_ptr(value);
    if (!h || h->kind != TS_KIND_SYMBOL){
      g_sym_value[i] = TS_UNDEFINED;
      continue;
    }
    if (young && h->gen == TS_GEN_OLD) continue;
    if (!h->mark) g_sym_value[i] = TS_UNDEFINED;
  }
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
/* Math.max/min: NaN poisons; and the ZERO tie is signed — Math.max(-0,+0)=+0,
   Math.min(-0,+0)=-0 (ECMA-262 21.3.2.24/25). C's a>b/a<b treat -0 and +0 as
   equal, so the tie needs explicit sign handling or the result's sign follows
   argument order. */
double ts_math_max2(double a, double b){
  if (a!=a||b!=b) return NAN;
  if (a==b){ if (a==0.0) return (signbit(a) && signbit(b)) ? -0.0 : 0.0; return a; }
  return a>b?a:b;
}
double ts_math_min2(double a, double b){
  if (a!=a||b!=b) return NAN;
  if (a==b){ if (a==0.0) return (signbit(a) || signbit(b)) ? -0.0 : 0.0; return a; }
  return a<b?a:b;
}
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
/* Math.hypot as V8 computes it (src/builtins/math.tq), so results agree to
   the last bit: an infinite argument wins over NaN, then NaN, then 0; the
   values are normalized by the largest magnitude and summed with Kahan
   compensation. Each step is its own statement, and contraction is off, so
   no fused multiply-add changes the rounding. */
#pragma STDC FP_CONTRACT OFF
static double math_hypot_n(const double* xs, size_t n){
  double max = 0;
  int nan = 0;
  for (size_t i = 0; i < n; i++){
    double v = xs[i];
    if (v != v){ nan = 1; continue; }
    double a = fabs(v);
    if (a > max) max = a;
  }
  if (max == INFINITY) return INFINITY;
  if (nan) return NAN;
  if (max == 0) return 0;
  double sum = 0, compensation = 0;
  for (size_t i = 0; i < n; i++){
    double v = xs[i];
    double q = fabs(v) / max;
    double sq = q * q;
    double summand = sq - compensation;
    double preliminary = sum + summand;
    double diff = preliminary - sum;
    compensation = diff - summand;
    sum = preliminary;
  }
  double root = sqrt(sum);
  return root * max;
}
double ts_math_hypot2(double a, double b){ double xs[2] = { a, b }; return math_hypot_n(xs, 2); }
/* Array-argument forms for Math.max/min/hypot(...spread) and the function
   values. The array is the call's own argument list (a fresh array); each
   element is ToNumber-coerced in order (valueOf may run user code, so the
   array is re-read through its value, not a cell pointer); max/min propagate
   NaN. Identity: -Inf / +Inf / 0. */
double ts_math_max_arr(tsv arr){
  double m=-1.0/0.0;   /* -Infinity: identity for max */
  ts_gc_root(&arr);
  for(uint32_t i=0;i<ts_array_len(arr);i++){ double x=ts_number_coerce(ts_array_get(arr,i)); m=ts_math_max2(m, x); }
  ts_gc_unroot(1);
  return m;
}
double ts_math_min_arr(tsv arr){
  double m=1.0/0.0;    /* +Infinity: identity for min */
  ts_gc_root(&arr);
  for(uint32_t i=0;i<ts_array_len(arr);i++){ double x=ts_number_coerce(ts_array_get(arr,i)); m=ts_math_min2(m, x); }
  ts_gc_unroot(1);
  return m;
}
double ts_math_hypot_arr(tsv arr){
  ts_gc_root(&arr);
  uint32_t n = ts_array_len(arr);
  double stack[16];
  double* xs = n <= 16 ? stack : (double*)malloc(sizeof(double) * n);
  if (!xs) ts_abort_msg("out of memory in Math.hypot");
  uint32_t k = 0;
  for (; k < n && k < ts_array_len(arr); k++) xs[k] = ts_number_coerce(ts_array_get(arr, k));
  double r = math_hypot_n(xs, k);
  if (xs != stack) free(xs);
  ts_gc_unroot(1);
  return r;
}
/* Math.max / min / hypot through a function value: the arguments in order. */
double ts_math_max_args(const tsv* a, int n){
  double m = -1.0/0.0;
  for (int i = 0; i < n; i++){ double x = ts_number_coerce(a[i]); m = ts_math_max2(m, x); }
  return m;
}
double ts_math_min_args(const tsv* a, int n){
  double m = 1.0/0.0;
  for (int i = 0; i < n; i++){ double x = ts_number_coerce(a[i]); m = ts_math_min2(m, x); }
  return m;
}
double ts_math_hypot_args(const tsv* a, int n){
  double stack[16];
  double* xs = n <= 16 ? stack : (double*)malloc(sizeof(double) * (size_t)n);
  if (!xs) ts_abort_msg("out of memory in Math.hypot");
  for (int i = 0; i < n; i++) xs[i] = ts_number_coerce(a[i]);
  double r = math_hypot_n(xs, n > 0 ? (size_t)n : 0);
  if (xs != stack) free(xs);
  return r;
}
#pragma STDC FP_CONTRACT ON
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
static double js_string_to_number_view(ts_strview v);
double ts_number_coerce_slow(tsv v){
  if (ts_is_num(v)) return ts_to_num(v);
  if (ts_is_bool(v)) return (double)(v & 1);
  if (ts_is_null(v)) return 0;
  if (ts_is_undef(v)) return NAN;
  if (ts_is_str(v)) return js_string_to_number_view(ts_str_view_typed(v));
  /* object: ToPrimitive(number) via Symbol.toPrimitive / valueOf / toString,
     then coerce the resulting primitive. (Symbols are not numerically coercible.) */
  if (ts_object_like(v) && !ts_is_symbol(v)){
    tsv p = ts_to_primitive(v, /*string_hint*/0);
    if (!ts_is_obj(p)) return ts_number_coerce(p);
  }
  return NAN;
}
/* parseInt/parseFloat (global). parseInt supports an optional radix. */
/* ---------------- string to number (ECMA-262 StringToNumber, parseFloat,
   parseInt), the algorithms V8 uses so the results agree to the last bit ---- */
/* StrWhiteSpaceChar: WhiteSpace and LineTerminator. */
static int js_strws(uint32_t c){
  return c == 0x09 || c == 0x0B || c == 0x0C || c == 0x20 || c == 0xA0 || c == 0xFEFF ||
         c == 0x0A || c == 0x0D || c == 0x2028 || c == 0x2029 || c == 0x1680 ||
         (c >= 0x2000 && c <= 0x200A) || c == 0x202F || c == 0x205F || c == 0x3000;
}
static inline int js_digit_value(uint32_t c){
  if (c >= '0' && c <= '9') return (int)(c - '0');
  if (c >= 'a' && c <= 'z') return (int)(c - 'a' + 10);
  if (c >= 'A' && c <= 'Z') return (int)(c - 'A' + 10);
  return 99;
}
/* The ASCII characters [a, b) of the view, for strtod. */
static double js_strtod_span(ts_strview v, uint32_t a, uint32_t b){
  char stack[128];
  size_t len = (size_t)(b - a);
  char* buf = len < sizeof stack ? stack : (char*)malloc(len + 1);
  if (!buf) ts_abort_msg("out of memory converting a string to a number");
  for (uint32_t i = a; i < b; i++) buf[i - a] = (char)ts_str_cu_at_view(v, i);
  buf[len] = 0;
  double d = strtod(buf, NULL);
  if (buf != stack) free(buf);
  return d;
}
/* V8 InternalStringToIntDouble<log2r>: the digits of a power-of-two radix,
   rounded once (to nearest, ties to even) when they exceed 53 bits. *pos is
   at the first digit (leading zeros allowed); returns NaN for trailing junk
   when !allow_junk (trailing whitespace is not junk). */
static double js_pow2_digits(ts_strview v, uint32_t* pos, uint32_t end, int log2r,
                             int allow_junk, int negative){
  uint32_t cur = *pos;
  int radix = 1 << log2r;
  while (cur < end && ts_str_cu_at_view(v, cur) == '0'){
    cur++;
    if (cur == end){ *pos = cur; return negative ? -0.0 : 0.0; }
  }
  int64_t number = 0;
  int exponent = 0;
  while (cur < end){
    int digit = js_digit_value(ts_str_cu_at_view(v, cur));
    if (digit >= radix){
      if (!allow_junk){
        while (cur < end && js_strws(ts_str_cu_at_view(v, cur))) cur++;
        if (cur < end) return NAN;
      }
      break;
    }
    number = number * radix + digit;
    int overflow = (int)(number >> 53);
    if (overflow != 0){
      int overflow_bits_count = 1;
      while (overflow > 1){ overflow_bits_count++; overflow >>= 1; }
      int dropped_bits_mask = (1 << overflow_bits_count) - 1;
      int dropped_bits = (int)number & dropped_bits_mask;
      number >>= overflow_bits_count;
      exponent = overflow_bits_count;
      int zero_tail = 1;
      for (;;){
        cur++;
        if (cur == end || js_digit_value(ts_str_cu_at_view(v, cur)) >= radix) break;
        zero_tail = zero_tail && ts_str_cu_at_view(v, cur) == '0';
        exponent += log2r;
      }
      if (!allow_junk){
        while (cur < end && js_strws(ts_str_cu_at_view(v, cur))) cur++;
        if (cur < end) return NAN;
      }
      int middle_value = 1 << (overflow_bits_count - 1);
      if (dropped_bits > middle_value) number++;
      else if (dropped_bits == middle_value){ if ((number & 1) != 0 || !zero_tail) number++; }
      if ((number & ((int64_t)1 << 53)) != 0){ exponent++; number >>= 1; }
      break;
    }
    cur++;
  }
  *pos = cur;
  if (exponent == 0){
    if (negative){ if (number == 0) return -0.0; number = -number; }
    return (double)number;
  }
  return ldexp((double)(negative ? -number : number), exponent);
}
/* parseInt(view, R) with R the ToInt32 of the radix (0 or 2..36). */
static double js_parse_int_view(ts_strview v, int32_t radix){
  uint32_t cur = 0, end = v.len;
  while (cur < end && js_strws(ts_str_cu_at_view(v, cur))) cur++;
  if (cur == end) return NAN;
  int negative = 0;
  uint32_t c = ts_str_cu_at_view(v, cur);
  if (c == '+' || c == '-'){
    negative = c == '-';
    cur++;
    if (cur == end) return NAN;
  }
  int leading_zero = 0;
  if (radix == 0){
    radix = 10;
    if (ts_str_cu_at_view(v, cur) == '0'){
      cur++;
      if (cur == end) return negative ? -0.0 : 0.0;
      c = ts_str_cu_at_view(v, cur);
      if (c == 'x' || c == 'X'){ radix = 16; cur++; if (cur == end) return NAN; }
      else leading_zero = 1;
    }
  } else if (radix == 16){
    if (ts_str_cu_at_view(v, cur) == '0'){
      cur++;
      if (cur == end) return negative ? -0.0 : 0.0;
      c = ts_str_cu_at_view(v, cur);
      if (c == 'x' || c == 'X'){ cur++; if (cur == end) return NAN; }
      else leading_zero = 1;
    }
  }
  if (radix < 2 || radix > 36) return NAN;
  while (ts_str_cu_at_view(v, cur) == '0'){
    leading_zero = 1;
    cur++;
    if (cur == end) return negative ? -0.0 : 0.0;
  }
  if (js_digit_value(ts_str_cu_at_view(v, cur)) >= radix)
    return leading_zero ? (negative ? -0.0 : 0.0) : NAN;
  double result;
  if ((radix & (radix - 1)) == 0){
    int log2r = 0; while ((1 << log2r) < radix) log2r++;
    result = js_pow2_digits(v, &cur, end, log2r, 1, 0);
  } else if (radix == 10){
    /* V8 keeps at most 310 digits (more is out of the double range) and
       reads them with a correctly rounded strtod. */
    char buf[312]; int n = 0;
    while (cur < end){
      uint32_t d = ts_str_cu_at_view(v, cur);
      if (d < '0' || d > '9') break;
      if (n <= 309) buf[n++] = (char)d;
      cur++;
    }
    buf[n] = 0;
    result = strtod(buf, NULL);
  } else {
    /* V8's generic case: parts that keep the multiplier within 32 bits, each
       folded into a double as result * multiplier + part. */
    result = 0;
    int done = 0;
    do {
      uint32_t part = 0, multiplier = 1;
      for (;;){
        int d = js_digit_value(ts_str_cu_at_view(v, cur));
        if (d >= radix){ done = 1; break; }
        const uint32_t kMaximumMultiplier = 0xFFFFFFFFu / 36u;
        uint32_t m = multiplier * (uint32_t)radix;
        if (m > kMaximumMultiplier) break;
        part = part * (uint32_t)radix + (uint32_t)d;
        multiplier = m;
        cur++;
        if (cur == end){ done = 1; break; }
      }
      /* V8 computes result * multiplier + part in C++; its arm64 build fuses
         it into one multiply-add (20,000 radix-3..36 cases agree only with
         the fused form), its x64 build cannot (no FMA in the baseline). */
#if defined(__aarch64__) || defined(__FMA__)
      result = fma(result, (double)multiplier, (double)part);
#else
      { double t = result * (double)multiplier; result = t + (double)part; }
#endif
    } while (!done);
  }
  return negative ? -result : result;
}
/* The longest StrDecimalLiteral at [a, end): its end, or a when there is none.
   Grammar: [+-] (Infinity | digits [. digits] | . digits) [(e|E) [+-] digits]. */
static uint32_t js_decimal_literal_end(ts_strview v, uint32_t a, uint32_t end, int* infinity){
  uint32_t cur = a;
  *infinity = 0;
  if (cur < end){ uint32_t c = ts_str_cu_at_view(v, cur); if (c == '+' || c == '-') cur++; }
  static const char inf[] = "Infinity";
  if (end - cur >= 8){
    int ok = 1;
    for (int i = 0; i < 8; i++) if (ts_str_cu_at_view(v, cur + (uint32_t)i) != (uint32_t)inf[i]){ ok = 0; break; }
    if (ok){ *infinity = 1; return cur + 8; }
  }
  uint32_t digits = 0;
  while (cur < end && ts_str_cu_at_view(v, cur) >= '0' && ts_str_cu_at_view(v, cur) <= '9'){ cur++; digits++; }
  if (cur < end && ts_str_cu_at_view(v, cur) == '.'){
    uint32_t dot = cur;
    cur++;
    uint32_t frac = 0;
    while (cur < end && ts_str_cu_at_view(v, cur) >= '0' && ts_str_cu_at_view(v, cur) <= '9'){ cur++; frac++; }
    if (!digits && !frac) cur = dot;      /* a lone "." is no literal */
    digits += frac;
  }
  if (!digits) return a;
  if (cur < end && (ts_str_cu_at_view(v, cur) == 'e' || ts_str_cu_at_view(v, cur) == 'E')){
    uint32_t e = cur + 1;
    if (e < end && (ts_str_cu_at_view(v, e) == '+' || ts_str_cu_at_view(v, e) == '-')) e++;
    uint32_t ed = e;
    while (ed < end && ts_str_cu_at_view(v, ed) >= '0' && ts_str_cu_at_view(v, ed) <= '9') ed++;
    if (ed > e) cur = ed;                 /* an exponent needs a digit */
  }
  return cur;
}
static double js_parse_float_view(ts_strview v){
  uint32_t cur = 0, end = v.len;
  while (cur < end && js_strws(ts_str_cu_at_view(v, cur))) cur++;
  int infinity = 0;
  uint32_t lit = js_decimal_literal_end(v, cur, end, &infinity);
  if (lit == cur) return NAN;
  if (infinity) return ts_str_cu_at_view(v, cur) == '-' ? -INFINITY : INFINITY;
  return js_strtod_span(v, cur, lit);
}
/* StringToNumber: the whole trimmed string must be one literal. */
static double js_string_to_number_view(ts_strview v){
  uint32_t a = 0, b = v.len;
  while (a < b && js_strws(ts_str_cu_at_view(v, a))) a++;
  while (b > a && js_strws(ts_str_cu_at_view(v, b - 1))) b--;
  if (a == b) return 0;
  if (b - a >= 3 && ts_str_cu_at_view(v, a) == '0'){
    uint32_t p = ts_str_cu_at_view(v, a + 1);
    int log2r = (p == 'x' || p == 'X') ? 4 : (p == 'o' || p == 'O') ? 3 : (p == 'b' || p == 'B') ? 1 : 0;
    if (log2r){
      uint32_t cur = a + 2;
      if (js_digit_value(ts_str_cu_at_view(v, cur)) >= (1 << log2r)) return NAN;
      double r = js_pow2_digits(v, &cur, b, log2r, 0, 0);
      return (r == r && cur == b) ? r : NAN;
    }
  }
  int infinity = 0;
  uint32_t lit = js_decimal_literal_end(v, a, b, &infinity);
  if (lit != b) return NAN;
  if (infinity) return ts_str_cu_at_view(v, a) == '-' ? -INFINITY : INFINITY;
  return js_strtod_span(v, a, b);
}

/* parseFloat(string): ToString, then the longest decimal literal. */
double ts_parse_float(tsv v){
  if (ts_is_num(v)){ double d = ts_to_num(v); return d == 0 ? 0.0 : d; }   /* ToString(-0) is "0" */
  tsv s = ts_is_str(v) ? v : ts_to_string_v(v);
  return js_parse_float_view(ts_str_view_typed(s));
}
/* parseInt(string, radix) with a radix that is already a number. */
double ts_parse_int(tsv v, double radix){
  tsv s = ts_is_str(v) ? v : ts_to_string_v(v);
  int32_t r = ts_to_int32(radix);
  if (r != 0 && (r < 2 || r > 36)) return NAN;
  return js_parse_int_view(ts_str_view_typed(s), r);
}
/* parseInt(string, radix) with any radix: ToString(string), then
   ToInt32(radix), in that order (both may run user code). */
double ts_parse_int_v(tsv v, tsv radix){
  ts_gc_root(&radix);
  tsv s = ts_is_str(v) ? v : ts_to_string_v(v);
  ts_gc_root(&s);
  double rd = ts_is_undef(radix) ? 0.0 : ts_number_coerce(radix);
  ts_gc_unroot(2);
  int32_t r = ts_to_int32(rd);
  if (r != 0 && (r < 2 || r > 36)) return NAN;
  return js_parse_int_view(ts_str_view_typed(s), r);
}

static ts_rt_ic g_ic_rx_last_index;
static long long ts_regexp_last_index_value(tsv re, uint32_t key){
  double d = ts_number_coerce(key == g_rx_k_last_index ? ts_get_ic(re, key, &g_ic_rx_last_index) : ts_get(re, key));
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
    ts_set_ic(re, g_rx_k_last_index, ts_num(matched ? (double)m.end : 0.0), &g_ic_rx_last_index);
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
  ts_set_ic(re, g_rx_k_last_index, ts_num(0.0), &g_ic_rx_last_index);
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
      ts_set_ic(re, g_rx_k_last_index,
             ts_num((double)ts_regexp_advance_string_index_fast(input, m.end, full_unicode)), &g_ic_rx_last_index);
    }
  }
  ts_set_ic(re, g_rx_k_last_index, ts_num(0.0), &g_ic_rx_last_index);
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
static int date_option_equals(tsv value, const char* text){
  if (!ts_is_str(value)) return 0;
  ts_strview view = ts_str_view_typed(value);
  size_t length = strlen(text);
  if (view.len != length) return 0;
  for (uint32_t i = 0; i < view.len; i++) if (ts_str_cu_at_view(view, i) != (uint8_t)text[i]) return 0;
  return 1;
}
/* Compiler-host time formatting. Unsupported locale/option families fail
   loudly rather than silently substituting a different locale or time zone. */
tsv ts_date_to_locale_time(double ms, tsv locales, tsv options){
  if (!isfinite(ms)) return ts_new_string("Invalid Date", 12);
  ts_gc_root(&locales); ts_gc_root(&options);
  if (ts_is_array(locales)) locales = ts_array_get(locales, 0);
  int japanese = date_option_equals(locales, "ja-JP") || date_option_equals(locales, "ja");
  int british = date_option_equals(locales, "en-GB");
  if (locales != TS_UNDEFINED && !japanese && !british &&
      !date_option_equals(locales, "en-US") && !date_option_equals(locales, "en"))
    ts_unsupported_builtin("Date.toLocaleTimeString locale");
  if (options == TS_NULL) ts_throw_type_error_msg("Cannot convert null to object");
  static const char* unsupported[] = {"timeStyle", "dateStyle", "hour", "minute", "second",
    "fractionalSecondDigits", "dayPeriod", "year", "month", "day", "weekday", "era", "timeZoneName",
    "calendar", "numberingSystem"};
  for (uint32_t i = 0; i < sizeof unsupported / sizeof unsupported[0]; i++)
    if (ts_get(options, ts_intern_field(unsupported[i], (uint32_t)strlen(unsupported[i]))) != TS_UNDEFINED)
      ts_unsupported_builtin("Date.toLocaleTimeString format options");
  tsv zone = ts_get(options, ts_intern_field("timeZone", 8)); ts_gc_root(&zone);
  if (zone != TS_UNDEFINED && !date_option_equals(zone, "UTC") &&
      !date_option_equals(zone, "Etc/UTC") && !date_option_equals(zone, "GMT"))
    ts_unsupported_builtin("Date.toLocaleTimeString time zone");
  tsv cycle = ts_get(options, ts_intern_field("hourCycle", 9)); ts_gc_root(&cycle);
  int hour_cycle = japanese || british ? 23 : 12;
  if (cycle != TS_UNDEFINED) {
    if (date_option_equals(cycle, "h11")) hour_cycle = 11;
    else if (date_option_equals(cycle, "h12")) hour_cycle = 12;
    else if (date_option_equals(cycle, "h23")) hour_cycle = 23;
    else if (date_option_equals(cycle, "h24")) hour_cycle = 24;
    else ts_throw_range_error_msg("Invalid hourCycle option");
  }
  tsv hour12 = ts_get(options, ts_intern_field("hour12", 6));
  if (hour12 != TS_UNDEFINED) hour_cycle = ts_truthy(hour12) ? 12 : 23;
  time_t seconds = (time_t)floor(ms / 1000.0);
  struct tm time;
  if (zone == TS_UNDEFINED) localtime_r(&seconds, &time);
  else gmtime_r(&seconds, &time);
  int hour = time.tm_hour;
  int twelve = hour_cycle == 11 || hour_cycle == 12;
  if (twelve) { hour %= 12; if (!hour) hour = 12; }
  char output[64];
  const char* suffix = twelve ? (time.tm_hour < 12 ? " AM" : " PM") : "";
  snprintf(output, sizeof output, !twelve && !japanese ? "%02d:%02d:%02d%s" : "%d:%02d:%02d%s",
    hour, time.tm_min, time.tm_sec, suffix);
  tsv result = ts_new_string(output, (uint32_t)strlen(output));
  ts_gc_unroot(4);
  return result;
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
  ts_cb cbf; cb_resolve(&cbf, cb);
  for(uint32_t i=0;i<len;i++){ a=as_arr(arr); tsv elem=ts_array_get(arr,i); tsv args[3]={elem,ts_num((double)i),arr};
    if(ts_truthy(cb_call(&cbf, cb, args, 3))){ ts_gc_unroot(2); return elem; } }
  ts_gc_unroot(2);
  return TS_UNDEFINED;
}
tsv ts_array_findlast(tsv arr, tsv cb){
  ts_array* a=as_arr(arr); if(!a) return TS_UNDEFINED;
  uint32_t len=a->len;
  ts_gc_root(&arr); ts_gc_root(&cb);
  ts_cb cbf; cb_resolve(&cbf, cb);
  for(uint32_t i=len; i-- > 0;){ a=as_arr(arr); tsv elem=ts_array_get(arr,i); tsv args[3]={elem,ts_num((double)i),arr};
    if(ts_truthy(cb_call(&cbf, cb, args, 3))){ ts_gc_unroot(2); return elem; } }
  ts_gc_unroot(2);
  return TS_UNDEFINED;
}
double ts_array_findlastindex(tsv arr, tsv cb){
  ts_array* a=as_arr(arr); if(!a) return -1;
  uint32_t len=a->len;
  ts_gc_root(&arr); ts_gc_root(&cb);
  ts_cb cbf; cb_resolve(&cbf, cb);
  for(uint32_t i=len; i-- > 0;){ a=as_arr(arr); tsv elem=ts_array_get(arr,i); tsv args[3]={elem,ts_num((double)i),arr};
    if(ts_truthy(cb_call(&cbf, cb, args, 3))){ ts_gc_unroot(2); return (double)i; } }
  ts_gc_unroot(2);
  return -1;
}

/* flat(depth): flatten nested arrays up to `depth` levels (default 1). */
static void flat_into(tsv out, tsv arr, int depth){
  ts_array* a=as_arr(arr); if(!a) return;
  for(uint32_t i=0;i<a->len;i++){
    a=as_arr(arr);
    tsv e=a->data[i];
    if (array_is_hole(e)) continue;
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
  ts_cb cbf; cb_resolve(&cbf, cb);
  tsv out=ts_new_array(0);
  ts_gc_root(&out);
  a=as_arr(arr);
  uint32_t len=a ? a->len : 0;
  for(uint32_t i=0;i<len;i++){
    a=as_arr(arr);
    if (!a || i>=a->len || array_is_hole(a->data[i])) continue;
    tsv elem = a->data[i];
    tsv args[3]={ elem, ts_num((double)i), arr };
    tsv mapped=cb_call(&cbf, cb, args, 3);
    if(ts_is_array(mapped)){
      ts_gc_root(&mapped);
      uint32_t ml=ts_array_len(mapped);
      for(uint32_t j=0;j<ml;j++)
        if (ts_array_has_index(mapped,j)) ts_array_push(out, ts_array_get(mapped,j));
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
  ts_cb cbf; cb_resolve(&cbf, cb);
  for(uint32_t i=0;i<len;i++){ a=as_arr(arr); tsv elem=ts_array_get(arr,i); tsv args[3]={elem,ts_num((double)i),arr};
    if(ts_truthy(cb_call(&cbf, cb, args, 3))){ ts_gc_unroot(2); return (double)i; } }
  ts_gc_unroot(2);
  return -1;
}
int ts_array_some(tsv arr, tsv cb){
  ts_array* a=as_arr(arr); if(!a) return 0;
  uint32_t len=a->len;
  ts_gc_root(&arr); ts_gc_root(&cb);
  ts_cb cbf; cb_resolve(&cbf, cb);
  for(uint32_t i=0;i<len;i++){
    a=as_arr(arr); if(!a || i>=a->len || array_is_hole(a->data[i])) continue;
    tsv elem=a->data[i]; tsv args[3]={elem,ts_num((double)i),arr};
    if(ts_truthy(cb_call(&cbf, cb, args, 3))){ ts_gc_unroot(2); return 1; } }
  ts_gc_unroot(2);
  return 0;
}
int ts_array_every(tsv arr, tsv cb){
  ts_array* a=as_arr(arr); if(!a) return 1;
  uint32_t len=a->len;
  ts_gc_root(&arr); ts_gc_root(&cb);
  ts_cb cbf; cb_resolve(&cbf, cb);
  for(uint32_t i=0;i<len;i++){
    a=as_arr(arr); if(!a || i>=a->len || array_is_hole(a->data[i])) continue;
    tsv elem=a->data[i]; tsv args[3]={elem,ts_num((double)i),arr};
    if(!ts_truthy(cb_call(&cbf, cb, args, 3))){ ts_gc_unroot(2); return 0; } }
  ts_gc_unroot(2);
  return 1;
}
double ts_array_lastindexof(tsv arr, tsv v, double from, int has_from){
  ts_array* a=as_arr(arr); if(!a) return -1;
  long n=(long)a->len, s = has_from ? (long)from : n-1;
  if(s<0) s+=n;             /* negative fromIndex counts from the end */
  if(s>=n) s=n-1;
  for(long i=s;i>=0;i--) if(!array_is_hole(a->data[i]) && ts_strict_eq(a->data[i],v)) return (double)i;
  return -1;
}
tsv ts_array_at(tsv arr, double idx){
  ts_array* a=as_arr(arr); if(!a) return TS_UNDEFINED;
  long i=(long)idx; if(i<0) i+=(long)a->len;
  if(i<0||i>=(long)a->len) return TS_UNDEFINED;
  return array_is_hole(a->data[i]) ? TS_UNDEFINED : a->data[i];
}
tsv ts_array_reverse(tsv arr){
  ts_array* a=as_arr(arr); if(!a) return arr;
  if (ts_arr_frozen(arr)) return arr;   /* frozen: no mutation */
  array_invalidate_dirty(a);
  for(uint32_t i=0,j=a->len?a->len-1:0; i<j; i++,j--){ tsv t=a->data[i]; a->data[i]=a->data[j]; a->data[j]=t; }
  return arr; /* in place, returns same array */
}
tsv ts_array_shift(tsv arr){
  ts_array* a=as_arr(arr); if(!a||a->len==0) return TS_UNDEFINED;
  if (ts_arr_frozen(arr)) return TS_UNDEFINED;   /* frozen: no mutation */
  array_invalidate_dirty(a);
  tsv v=a->data[0];
  for(uint32_t i=0;i+1<a->len;i++) a->data[i]=a->data[i+1];
  a->data[a->len-1]=TS_ARRAY_HOLE;   /* keep [len, cap) holes */
  a->len--; return array_is_hole(v) ? TS_UNDEFINED : v;
}
double ts_array_unshift(tsv arr, tsv v){
  ts_array* a=as_arr(arr); if(!a) return 0;
  if (ts_arr_frozen(arr)) return (double)a->len;   /* frozen: no mutation */
  ts_array_push(arr, TS_UNDEFINED);           /* grow by one */
  array_invalidate_dirty(a);
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
  int ah = array_is_hole(a), bh = array_is_hole(b);
  if (ah || bh) return ah==bh ? 0 : (ah ? 1 : -1);
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
      if (array_is_hole(left) || array_is_hole(key) ||
          left==TS_UNDEFINED || key==TS_UNDEFINED) {
        cmp = default_cmp(left, key);
      } else if(has_cb){
        tsv args[2]={left,key};
        cmp = (int)ts_to_num(ts_call_value(cb,args,2));
        cmp = cmp>0?1:(cmp<0?-1:0);
      } else cmp = default_cmp(left, key);
      a=as_arr(arr);
      if(cmp>0 && a && (uint32_t)(j+1)<a->cap){
        array_invalidate_dirty(a);
        a->data[j+1]=left; array_write_barrier(a, (uint32_t)(j+1), left); j--;
      } else break;
    }
    a=as_arr(arr);
    array_invalidate_dirty(a);
    a->data[j+1]=key;
    array_write_barrier(a, (uint32_t)(j+1), key);
  }
  ts_gc_unroot(2);
  return arr;
}

/* ES2023 change-by-copy methods read every index with Get and create a data
   property in the result, so source holes become explicit undefined values. */
static tsv array_clone(tsv arr){
  ts_array* a=as_arr(arr); if(!a) return ts_new_array(0);
  ts_gc_root(&arr);
  tsv out=ts_new_array(0);
  ts_gc_root(&out);
  a=as_arr(arr);
  for(uint32_t i=0;i<a->len;i++){ ts_array_push(out, ts_array_get(arr,i)); a=as_arr(arr); }
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
static void ts_throw_not_defined(const char* name){
  char buf[200]; snprintf(buf, sizeof buf, "%s is not defined", name);
  ts_throw(ts_new_error(TS_ERR_REFERENCE, ts_new_string(buf, (uint32_t)strlen(buf))));
}
/* A lexical binding read before its declaration ran (the temporal dead
   zone): V8's ReferenceError. */
void ts_throw_uninitialized(const char* name){
  char buf[256];
  snprintf(buf, sizeof buf, "Cannot access '%s' before initialization", name);
  ts_throw(ts_new_error(TS_ERR_REFERENCE, ts_new_string(buf, (uint32_t)strlen(buf))));
}
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
  static int rooted[TS_ERR_KINDS];
  for (int i = 0; i < TS_ERR_KINDS; i++){
    tsv p = ts_new_proto();
    g_error_protos[i] = p;
    ts_root_static_once(&g_error_protos[i], &rooted[i]);
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
  array_write_barrier(o, (uint32_t)i, val);
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
  for(long i=0;i<s;i++){ ts_array_push(out, ts_array_get(arr,(uint32_t)i)); a=as_arr(arr); }
  ts_array* it=as_arr(items);
  if(it) for(uint32_t i=0;i<it->len;i++){ ts_array_push(out, ts_array_get(items,i)); it=as_arr(items); }
  a=as_arr(arr);
  for(long i=s+del;i<n;i++){ ts_array_push(out, ts_array_get(arr,(uint32_t)i)); a=as_arr(arr); }
  ts_gc_unroot(3);
  return out;
}

/* ---------------- String: additional methods ---------------- */
int ts_str_startswith(tsv s, tsv pre, double pos, int has_pos){
  if(!ts_is_str(s)||!ts_is_str(pre)) return 0;
  ts_strview xs=ts_str_view_typed(s), ps=ts_str_view_typed(pre);
  long start = has_pos ? (long)pos : 0; if(start<0) start=0; if(start>(long)xs.len) start=(long)xs.len;
  if((long)ps.len > (long)xs.len - start) return 0;
  return ts_str_region_eq(xs, (uint32_t)start, ps, 0, ps.len);
}
int ts_str_endswith(tsv s, tsv suf, double endpos, int has_endpos){
  if(!ts_is_str(s)||!ts_is_str(suf)) return 0;
  ts_strview xs=ts_str_view_typed(s), ps=ts_str_view_typed(suf);
  long end = has_endpos ? (long)endpos : (long)xs.len;
  if(end<0) end=0; if(end>(long)xs.len) end=(long)xs.len;
  if((long)ps.len > end) return 0;
  return ts_str_region_eq(xs, (uint32_t)(end-(long)ps.len), ps, 0, ps.len);
}
tsv ts_str_padstart(tsv s, double target, tsv pad){
  if(!ts_is_str(s)) return s;
  int pad_is_str=ts_is_str(pad);
  ts_strview xs=ts_str_view_typed(s), ps={0};
  if(pad_is_str) ps=ts_str_view_typed(pad);
  long t=(long)target; if(t<=(long)xs.len) return s;
  uint32_t need=(uint32_t)t - xs.len;
  ts_gc_root(&s); ts_gc_root(&pad);
  xs=ts_str_view_typed(s); pad_is_str=ts_is_str(pad); if(pad_is_str) ps=ts_str_view_typed(pad);
  uint32_t flags = (xs.flags | (pad_is_str ? ps.flags : 0u)) & TS_STR_FLAG_UTF16;
  ts_string* y=ts_string_alloc_storage((uint32_t)t, flags); y->len=(uint32_t)t;
  uint32_t pl=pad_is_str&&ps.len?ps.len:1;
  for(uint32_t i=0;i<need;i++){
    uint16_t cu = pad_is_str&&ps.len ? ts_str_cu_at_view(ps, i%pl) : (uint16_t)' ';
    ts_str_cu_set(y->data, flags, i, cu);
  }
  ts_str_copy_units(y->data, flags, need, xs, 0, xs.len);
  y->flags=strflags_storage(y->data,flags,(uint32_t)t); y->hash=strhash_units(y->data,y->flags,(uint32_t)t);
  y->parent=TS_UNDEFINED; y->offset=0;
  tsv r=ts_str_v(y); ts_gc_unroot(2); return r;
}
tsv ts_str_padend(tsv s, double target, tsv pad){
  if(!ts_is_str(s)) return s;
  int pad_is_str=ts_is_str(pad);
  ts_strview xs=ts_str_view_typed(s), ps={0};
  if(pad_is_str) ps=ts_str_view_typed(pad);
  long t=(long)target; if(t<=(long)xs.len) return s;
  uint32_t need=(uint32_t)t - xs.len;
  ts_gc_root(&s); ts_gc_root(&pad);
  xs=ts_str_view_typed(s); pad_is_str=ts_is_str(pad); if(pad_is_str) ps=ts_str_view_typed(pad);
  uint32_t flags = (xs.flags | (pad_is_str ? ps.flags : 0u)) & TS_STR_FLAG_UTF16;
  ts_string* y=ts_string_alloc_storage((uint32_t)t, flags); y->len=(uint32_t)t;
  uint32_t pl=pad_is_str&&ps.len?ps.len:1;
  ts_str_copy_units(y->data, flags, 0, xs, 0, xs.len);
  for(uint32_t i=0;i<need;i++){
    uint16_t cu = pad_is_str&&ps.len ? ts_str_cu_at_view(ps, i%pl) : (uint16_t)' ';
    ts_str_cu_set(y->data, flags, xs.len+i, cu);
  }
  y->flags=strflags_storage(y->data,flags,(uint32_t)t); y->hash=strhash_units(y->data,y->flags,(uint32_t)t);
  y->parent=TS_UNDEFINED; y->offset=0;
  tsv r=ts_str_v(y); ts_gc_unroot(2); return r;
}
tsv ts_str_trimstart(tsv s){
  if(!ts_is_str(s)) return s; long a=0,b=(long)ts_str_len_typed(s);
  ts_strview xs=ts_str_view_typed(s);
  while(a<b){ uint16_t c=ts_str_cu_at_view(xs,(uint32_t)a); if(ts_str_is_trim_ws(c)) a++; else break; }
  return ts_string_slice_view(s, (uint32_t)a, (uint32_t)(b-a));
}
tsv ts_str_trimend(tsv s){
  if(!ts_is_str(s)) return s; long a=0,b=(long)ts_str_len_typed(s);
  ts_strview xs=ts_str_view_typed(s);
  while(b>a){ uint16_t c=ts_str_cu_at_view(xs,(uint32_t)b-1); if(ts_str_is_trim_ws(c)) b--; else break; }
  return ts_string_slice_view(s, (uint32_t)a, (uint32_t)(b-a));
}
tsv ts_str_at(tsv s, double idx){
  if(!ts_is_str(s)) return TS_UNDEFINED;
  long len=(long)ts_str_len_typed(s);
  long i=(long)idx; if(i<0) i+=len;
  if(i<0||i>=len) return TS_UNDEFINED;
  return ts_string_slice_view(s, (uint32_t)i, 1);
}
/* replace / replaceAll with a STRING pattern (no regex). */
/* Expand a string replacement pattern for a literal-string match of `p` at byte
   index `i` in `x`: $$ -> $, $& -> matched, $` -> prefix, $' -> suffix. ($n group
   refs only apply to regex, which we don't support.) Returns the expanded string. */
static tsv expand_replacement(tsv s, tsv pat, uint32_t i, tsv rep){
  tsv out = ts_new_string("",0); ts_gc_root(&out);
  ts_gc_root(&s); ts_gc_root(&pat); ts_gc_root(&rep);
  for(uint32_t k=0;;k++){
    int rep_is_str = ts_is_str(rep);
    ts_strview rv = rep_is_str ? ts_str_view_typed(rep) : (ts_strview){0};
    if (!rep_is_str || k>=rv.len) break;
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
  if(!ts_is_str(s)||!ts_is_str(pat)||!ts_is_str(rep)) return TS_UNDEFINED;
  ts_strview xs=ts_str_view_typed(s), ps=ts_str_view_typed(pat), rs=ts_str_view_typed(rep);
  if(ps.len==0) return TS_UNDEFINED;
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
  int source_is_str=ts_is_str(s), pattern_is_str=ts_is_str(pat);
  /* rep may be a FUNCTION replacer (called per match) instead of a string. */
  int rep_is_fn = ts_is_callable(rep);
  int replacement_is_str = !rep_is_fn && ts_is_str(rep);
  if(!source_is_str||!pattern_is_str||(!rep_is_fn && !replacement_is_str))
    return source_is_str ? s : ts_new_string("",0);
  ts_strview pattern_view = ts_str_view_typed(pat);
  if(pattern_view.len==0){
    /* empty pattern matches at index 0 (replace) or between every char + ends
       (replaceAll): "abc".replace("","X")="Xabc", replaceAll -> "XaXbXcX". A
       function replacer is invoked with matched="" at each such offset. */
    ts_gc_root(&s); ts_gc_root(&rep);
    tsv out = rep_is_fn ? ts_str_replace_call(rep, ts_new_string("",0), 0, s) : rep;
    ts_gc_root(&out);
    uint32_t len=ts_str_len_typed(s);
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
  int has_dollar=0; if(replacement_is_str){ ts_strview rv=ts_str_view_typed(rep); for(uint32_t k=0;k<rv.len;k++) if(ts_str_cu_at_view(rv,k)=='$'){ has_dollar=1; break; } }
  if(!rep_is_fn && !has_dollar){
    tsv built = ts_str_replace_literal_build(s, pat, rep, all);
    if(built != TS_UNDEFINED) return built;
  }
  tsv out=ts_new_string("",0);
  ts_gc_root(&out); ts_gc_root(&s); ts_gc_root(&pat); ts_gc_root(&rep);
  uint32_t i=0,start=0; int done=0;
  for(;;){
    ts_strview xs=ts_str_view_typed(s), ps=ts_str_view_typed(pat);
    if(i+ps.len > xs.len) break;
    if(!done && ts_str_region_eq(xs, i, ps, 0, ps.len)){
      out=ts_add(out, ts_string_slice_view(s, start, i-start));
      tsv repl;
      if(rep_is_fn){
        /* matched substring == pattern for a literal-string match. */
        repl = ts_str_replace_call(rep, pat, i, s);
      } else {
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
/* ---- field-name hash index (P2a: O(1) intern vs O(#fields) memcmp scan) ----
   Maps a field name's FNV-1a hash to its id+1 (0 = empty slot), open-addressed
   with linear probing, power-of-two sized, kept under 3/4 load. The field table
   is APPEND-ONLY (ids are never reused or deleted), so no tombstones are needed.
   The index holds only integer ids — NO heap pointers — so the moving GC never
   scans or relocates it, and it needs no free (lives to process exit). Built
   lazily: lookups fall back to "not present" (-1) until the first reserve. */
static uint32_t* g_field_index = NULL;     /* slot -> id+1; 0 = empty */
static uint32_t  g_field_index_cap = 0;    /* number of slots (power of two) */
static uint32_t field_name_hash(const char* name, uint32_t len){
  uint32_t h = 2166136261u;                /* FNV-1a over raw bytes (same consts as strhash_units) */
  for (uint32_t i=0;i<len;i++){ h ^= (uint8_t)name[i]; h *= 16777619u; }
  return h;
}
/* Insert id into the index; caller guarantees a free slot exists. */
static void field_index_put(uint32_t id){
  uint32_t mask = g_field_index_cap - 1;
  uint32_t slot = field_name_hash(g_field_names[id], g_field_lens[id]) & mask;
  while (g_field_index[slot]) slot = (slot + 1) & mask;
  g_field_index[slot] = id + 1;
}
/* Ensure the index holds `need` entries under 3/4 load, rebuilding from the live
   field table (ids [0,g_field_count)) when it must grow or is first allocated. */
static void field_index_reserve(uint32_t need){
  if (g_field_index_cap && need * 4 < g_field_index_cap * 3) return;
  uint32_t newcap = g_field_index_cap ? g_field_index_cap : 64;
  while (need * 4 >= newcap * 3) newcap *= 2;
  free(g_field_index);
  g_field_index = (uint32_t*)calloc(newcap, sizeof(uint32_t));
  g_field_index_cap = newcap;
  for (uint32_t i = 0; i < g_field_count; i++) field_index_put(i);
}
/* Look up (name,len) via the index; return id or -1. *probes gets the number of
   slots examined (for RT_STATS honesty — typically 1–2). */
static int field_index_lookup(const char* name, uint32_t len, uint32_t hash, uint32_t* probes){
  uint32_t p = 0;
  if (g_field_index_cap){
    uint32_t mask = g_field_index_cap - 1;
    for (uint32_t slot = hash & mask; ; slot = (slot + 1) & mask){
      p++;
      uint32_t e = g_field_index[slot];
      if (!e) break;                        /* empty slot: not present */
      uint32_t id = e - 1;
      if (g_field_lens[id] == len && memcmp(g_field_names[id], name, len) == 0){
        if (probes) *probes = p; return (int)id;
      }
    }
  } else {
    p = 1;
  }
  if (probes) *probes = p;
  return -1;
}
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
  ts_typeof_strings_init();
  g_field_cap = count < 16 ? 16 : count*2;
  g_field_names = malloc(sizeof(char*)*g_field_cap);
  g_field_lens = malloc(sizeof(uint32_t)*g_field_cap);
  for (uint32_t i=0;i<count;i++){
    g_field_names[i] = names[i];
    g_field_lens[i] = lens ? lens[i] : (uint32_t)strlen(names[i]);
  }
  g_field_count = count;
  /* build the hash index over the compile-time field table (fresh: this runs once
     at startup; reset defensively in case of re-init). */
  free(g_field_index); g_field_index = NULL; g_field_index_cap = 0;
  field_index_reserve(count + 1);
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
/* intern a (possibly new) field name -> id, agreeing with compile-time ids. The
   id assignment (id = g_field_count++) is UNCHANGED — the hash index is only a
   lookup accelerator, so compile-time/runtime id agreement is preserved. */
uint32_t ts_intern_field(const char* name, uint32_t len){
  RT_STAT_INC(intern_calls);
  uint32_t h = field_name_hash(name, len);
  uint32_t probes = 0;
  int found = field_index_lookup(name, len, h, &probes);
  RT_STAT_ADD(intern_probes, probes);
  if (found >= 0) return (uint32_t)found;
  /* new field: grow the parallel name/len arrays if needed */
  if (g_field_count==g_field_cap){
    g_field_cap=g_field_cap?g_field_cap*2:16;
    g_field_names=realloc(g_field_names,sizeof(char*)*g_field_cap);
    g_field_lens=realloc(g_field_lens,sizeof(uint32_t)*g_field_cap);
  }
  /* reserve index capacity for one more BEFORE appending, so the rebuild inside
     reserve() (which re-inserts ids [0,g_field_count)) never sees the not-yet-
     stored id. */
  field_index_reserve(g_field_count + 1);
  uint32_t id = g_field_count;
  char* copy=malloc(len+1); memcpy(copy,name,len); copy[len]=0;
  g_field_names[id]=copy;
  g_field_lens[id]=len;
  g_field_count = id + 1;
  field_index_put(id);
  return id;
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
static int prop_enum_data_at(const ts_object* o, uint32_t i){
  /* A property is enumerated iff its key is enumerable-eligible AND its
     enumerable attribute bit is set. This now INCLUDES accessor properties whose
     enumerable bit is set (Object.keys lists the key; Object.values/entries/JSON/
     assign/spread invoke the getter for the value — done in the consuming
     callbacks, NOT here, since Object.keys must not trigger getters). */
  return field_enumerable(obj_key_at(o, i)) && (obj_flags_at(o, i) & TS_PROP_ENUMERABLE) != 0;
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
static ts_pref propbag_prop(tsv owner, uint32_t i){
  if (!ts_is_propbag(owner)) return PREF_NONE;
  ts_object* o = (ts_object*)ts_ptr(owner);
  if (!kind_has_common_header(o->h.kind) || i >= o->len) return PREF_NONE;
  return (ts_pref){ o, i };
}
static void push_prop_names_js_order(tsv arr, tsv owner, uint32_t skip1, uint32_t skip2, uint32_t skip3){
  ts_gc_root(&arr); ts_gc_root(&owner);
  uint32_t len = propbag_len(owner);
  uint32_t total_idx = 0;
  for (uint32_t i=0;i<len;i++){
    ts_pref p = propbag_prop(owner, i); if (!pref_ok(p)) continue;
    uint32_t k = pref_key(p), idx;
    if (k == skip1 || k == skip2 || k == skip3 || !own_name_visible(k)) continue;
    if (prop_key_is_array_index(k, &idx)) total_idx++;
  }
  uint32_t prev_idx = 0, emitted = 0; int have_prev = 0;
  while (emitted < total_idx){
    uint32_t best = 0, best_key = 0; int found = 0;
    len = propbag_len(owner);
    for (uint32_t i=0;i<len;i++){
      ts_pref p = propbag_prop(owner, i); if (!pref_ok(p)) continue;
      uint32_t k = pref_key(p), idx;
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
    ts_pref p = propbag_prop(owner, i); if (!pref_ok(p)) continue;
    uint32_t k = pref_key(p), idx;
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
    ts_pref p = propbag_prop(owner, i); if (!pref_ok(p)) continue;
    tsv sym = symbol_value_from_prop_key(pref_key(p));
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
    uint32_t len = ts_str_len_typed(obj);
    for (uint32_t i=0;i<len;i++) push_index_name(arr, i);
    push_cstr_name(arr, "length");
    ts_gc_unroot(2);
    return arr;
  }
  if (ts_is_typed_array(obj)){
    for (uint32_t i = 0; i < ((ts_typedarray*)ts_ptr(obj))->length; i++) push_index_name(arr, i);
    push_prop_names_js_order(arr, obj, 0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu);
    ts_gc_unroot(2);
    return arr;
  }
  if (ts_is_indexed_array_fast(obj)){
    ts_array* a = arr_dense(obj);
    uint32_t len = a->len;
    for (uint32_t i=0;i<len;i++){
      if (ts_array_has_index(obj, i)) push_index_name(arr, i);
      a = ts_ptr(obj); len = a->len;
    }
    push_cstr_name(arr, "length");
    push_prop_names_js_order(arr, obj, 0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu);
    ts_gc_unroot(2);
    return arr;
  }
  if (ts_is_func(obj)){
    /* V8's order: length, name, prototype, then the rest (statics of a class
       value, the function's own map) */
    fn_keys_init();
    ts_func* f = (ts_func*)ts_ptr(obj);
    int has_proto = fn_has_own_prototype(f);
    ts_object* sc = ts_class_static_container(obj);
    int has_len = fn_virtual(f, g_fn_key_length) || find_slot(&f->o, g_fn_key_length, 0) ||
                  (sc && find_slot(sc, g_fn_key_length, 0));
    int has_name = fn_virtual(f, g_fn_key_name) || find_slot(&f->o, g_fn_key_name, 0) ||
                   (sc && find_slot(sc, g_fn_key_name, 0));
    if (has_len) push_cstr_name(arr, "length");
    if (has_name) push_cstr_name(arr, "name");
    if (has_proto) push_cstr_name(arr, "prototype");
    sc = ts_class_static_container(obj);
    if (sc){
      tsv scv = ts_obj(sc);
      push_prop_names_js_order(arr, scv, g_fn_key_length, g_fn_key_name, g_fn_key_prototype);
      ts_gc_unroot(2);
      return arr;
    }
    push_prop_names_js_order(arr, obj, g_fn_key_length, g_fn_key_name, g_fn_key_prototype);
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
  if (!ts_is_obj(target) || ts_is_indexed_array_fast(target) || ts_is_map(target) || ts_is_set(target)) return target;
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
  if (!ts_is_indexed_array_fast(entries)){ arr = ts_new_array(0); }
  ts_gc_root(&arr);
  if (arr != entries) ts_array_push_all(arr, entries);
  uint32_t len = ts_array_len(arr);
  for (uint32_t i=0;i<len;i++){
    tsv pair = ts_array_get(arr, i);
    if (!ts_is_indexed_array_fast(pair)) continue;
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
/* The objects and arrays open on the way from the value being stringified
   down to the current one, each frame's rooted slot (the collector keeps it
   current): the cycle test. Frames live on the C stack, so a throw that
   leaves a stringify call leaves nothing behind. */
typedef struct json_path { tsv* slot; struct json_path* up; } json_path;
typedef struct { char* p; size_t len, cap; int heap; int nonascii; json_path* path; char small[256]; } jbuf;
static void jb_init(jbuf* b){ b->p=b->small; b->len=0; b->cap=sizeof(b->small); b->heap=0; b->nonascii=0; b->path=NULL; }
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
  char short_data[TS_SHORTSTR_MAX];
  const char* data = ts_str_view_data(&s, short_data);
  /* Fast path: 1-byte storage with no chars needing escaping -> bulk copy. */
  if (!(s.flags & TS_STR_FLAG_UTF16) && json_bytes_clean_ascii(data, s.len)){
    if (b->len + s.len + 2 > b->cap) jb_grow(b, b->len + s.len + 2);
    b->p[b->len++]='"';
    memcpy(b->p + b->len, data, s.len); b->len += s.len;
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
double ts_json_string_len_fast(tsv v){
  return json_quoted_view_len(ts_str_view_typed(v));
}
double ts_json_string_len(tsv v){
  if (!ts_is_str(v)) return ts_json_stringify_len(v);
  return ts_json_string_len_fast(v);
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
    if (prop_enum_data_at(o, i) && prop_key_is_array_index(obj_key_at(o, i), &idx)) return 0;
  }
  for (uint32_t i=0;;i++){
    o=ts_ptr(obj);
    if (i>=o->len) break;
    if (!prop_enum_data_at(o, i)) continue;
    uint32_t k=obj_key_at(o, i);
    tsv val=(*obj_val_at(o, i));
    json_emit_obj_prop(b, obj, k, val, depth, indent, first);
  }
  return 1;
}

/* Open an object or array: a value already open on the path is a cycle
   (V8: TypeError "Converting circular structure to JSON"); past a depth the
   C stack cannot take, V8's RangeError for a stack overflow. */
#define TS_JSON_MAX_DEPTH 4096
static void json_enter(jbuf* b, json_path* node, tsv* slot, int depth){
  if (depth > TS_JSON_MAX_DEPTH) ts_throw_range_error_msg("Maximum call stack size exceeded");
  void* p = ts_ptr(*slot);
  for (json_path* q = b->path; q; q = q->up)
    if (ts_ptr(*q->slot) == p) ts_throw_type_error_msg("Converting circular structure to JSON");
  node->slot = slot; node->up = b->path; b->path = node;
}
static inline void json_leave(jbuf* b, json_path* node){ b->path = node->up; }
static int json_stringify_val(jbuf* b, tsv v, int depth, const char* indent){
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
    json_path node; json_enter(b, &node, &v, depth);
    ts_array* a=ts_ptr(v); uint32_t len=a->len; jb_putc(b,'[');
    for (uint32_t i=0;i<len;i++){ a=ts_ptr(v); if(i) jb_putc(b,',');
      jb_indent(b, indent, depth+1);
      tsv elem = ts_array_get(v, i);
      if (ts_is_obj(elem)){ char ib[24]; int il=snprintf(ib,sizeof ib,"%u",i); elem=json_apply_tojson(elem, ib, (uint32_t)il); }
      if (!json_stringify_val(b, elem, depth+1, indent)) jb_putz(b,"null"); /* holes/undef -> null */ }
    if (len) jb_indent(b, indent, depth);
    json_leave(b, &node);
    jb_putc(b,']'); ts_gc_unroot(1); return 1;
  }
  /* a Map's entries are not properties: it stringifies as the object it is
     (its own enumerable properties, V8's {} for a bare Map) */
  if (g_has_proxies && ts_is_proxy(v)){                     /* proxy: enumerate via traps */
    jb_putc(b,'{');
    ts_gc_root(&v);
    json_path node; json_enter(b, &node, &v, depth);
    json_obj_ctx jc; jc.b=b; jc.depth=depth; jc.first=1; jc.recv=v; jc.indent=indent;
    ts_proxy_enum(v, cb_json_obj_prop, &jc);
    json_leave(b, &node);
    ts_gc_unroot(1);
    if (!jc.first) jb_indent(b, indent, depth);
    jb_putc(b,'}'); return 1;
  }
  if (ts_is_obj(v)){                                        /* plain object / class instance */
    jb_putc(b,'{');
    ts_gc_root(&v);
    json_path node; json_enter(b, &node, &v, depth);
    int first=1;
    if (ts_is_typed_array(v)) {
      for (uint32_t i = 0; i < ((ts_typedarray*)ts_ptr(v))->length; i++) {
        char name[16]; int size = snprintf(name, sizeof name, "%u", i);
        ts_key key = ts_intern_field(name, (uint32_t)size);
        json_emit_obj_prop(b, v, key, ts_ta_get(v, i), depth, indent, &first);
      }
    }
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
    json_leave(b, &node);
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
/* Registry of typed-class descriptors, keyed by stable prototype handle.
   Prototype handles do not change when the moving nursery repoints a cell, so
   the integer-only index needs no GC tracing. A future direct-pointer value
   representation must rebuild this assumption. */
struct ts_class_reg {
  tsv proto;
  ts_class_field* fields;
  int nfields;
  size_t min_size;
};
typedef struct ts_class_reg ts_class_reg;
static ts_class_reg* g_class_regs = NULL;
static int g_class_reg_len = 0, g_class_reg_cap = 0;
static uint32_t* g_class_reg_index = NULL;  /* slot -> registry index + 1 */
static uint32_t g_class_reg_index_cap = 0;
/* Cache the complete prototype/key resolution, including negative results.
   Entries hold stable handles and offsets, never movable cell pointers. The
   registry epoch invalidates both kinds when a class is registered. */
typedef struct {
  tsv proto;
  ts_key key;
  uint32_t epoch;
  size_t offset, min_size;
  int numeric, found;
} ts_class_field_cache_entry;
#define TS_CLASS_FIELD_CACHE_SIZE 1024u
static ts_class_field_cache_entry g_class_field_cache[TS_CLASS_FIELD_CACHE_SIZE];
uint32_t g_ts_class_layout_epoch = 1;
static void prop_ic_location_reset(void);
static uint32_t class_proto_hash(tsv proto){
  /* identity hash: the cell's address (cells never move) */
  uint64_t x = ((proto & TS_PAYLOAD_MASK) >> 4) * 0x9E3779B97F4A7C15ull;
  return (uint32_t)(x >> 32);
}
static void class_reg_index_put(uint32_t reg_i){
  uint32_t mask = g_class_reg_index_cap - 1u;
  uint32_t slot = class_proto_hash(g_class_regs[reg_i].proto) & mask;
  while (g_class_reg_index[slot]) slot = (slot + 1u) & mask;
  g_class_reg_index[slot] = reg_i + 1u;
}
static void class_reg_index_reserve(uint32_t need){
  if (g_class_reg_index_cap && need * 4u < g_class_reg_index_cap * 3u) return;
  uint32_t cap = g_class_reg_index_cap ? g_class_reg_index_cap : 16u;
  while (need * 4u >= cap * 3u) cap *= 2u;
  free(g_class_reg_index);
  g_class_reg_index = (uint32_t*)calloc(cap, sizeof(uint32_t));
  g_class_reg_index_cap = cap;
  for (int i = 0; i < g_class_reg_len; i++) class_reg_index_put((uint32_t)i);
}
void ts_register_class(tsv proto, ts_class_field* fields, int nfields){
  prop_add_epoch_bump();
  if (++g_ts_class_layout_epoch == 0){
    memset(g_class_field_cache, 0, sizeof(g_class_field_cache));
    prop_ic_location_reset();
    g_ts_class_layout_epoch = 1;
  }
  if (g_class_reg_len == g_class_reg_cap){
    g_class_reg_cap = g_class_reg_cap ? g_class_reg_cap*2 : 8;
    g_class_regs = realloc(g_class_regs, sizeof(ts_class_reg)*g_class_reg_cap);
  }
  class_reg_index_reserve((uint32_t)g_class_reg_len + 1u);
  ts_class_reg* reg = &g_class_regs[g_class_reg_len];
  reg->proto = proto;
  reg->fields = fields;
  reg->nfields = nfields;
  reg->min_size = sizeof(ts_object);
  for (int i = 0; i < nfields; i++){
    size_t width = fields[i].numeric ? sizeof(double) : sizeof(tsv);
    size_t end = fields[i].offset + width;
    if (end > reg->min_size) reg->min_size = end;
  }
  class_reg_index_put((uint32_t)g_class_reg_len);
  g_class_reg_len++;
  g_has_class_regs = 1;
  struct_methods_collect(proto);
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
  p->cls = tmpl->cls;   /* a class prototype's mark */
  if (tmpl->len){
    p->cap = tmpl->len;
    p->len = tmpl->len;
    if (obj_shaped(tmpl)){
      p->props = (ts_prop*)gc_owned_alloc(&p->h, sizeof(tsv) * p->cap);
      for (uint32_t i = 0; i < tmpl->len; i++) ((tsv*)p->props)[i] = *obj_val_at(tmpl, i);
    } else {
      p->props = (ts_prop*)gc_owned_alloc(&p->h, sizeof(ts_prop) * p->cap);
      memcpy(p->props, tmpl->props, sizeof(ts_prop) * tmpl->len);
      prop_index_rebuild(p, p->len);
    }
  }
  if (g_class_fields[class_id]) {
    ts_register_class(proto, g_class_fields[class_id], g_class_nfields[class_id]);
  }
  ts_gc_unroot(1);
  return proto;
}
/* Box a class as a callable value. class_id is stored PLUS ONE (0 = non-class).
   code = constructor cfunc; env = captured cells (threaded as ctor leading params). */
tsv ts_make_class_value_cells(uint32_t class_id, ts_code ctor, tsv* env, uint32_t envlen){
  tsv fv = ts_make_class_value(class_id, ctor, env, envlen);
  if (envlen) ((ts_func*)ts_ptr(fv))->env_abi = 1;
  return fv;
}
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
/* A class declaration evaluated once (a module's, not one inside a function
   or a loop): its class value takes the registered prototype itself, no
   copy, so the instances' prototype is CLASS_PROTO[class_id] and a static
   `new`, `instanceof` and the receiver class guards compare with it
   (docs/receiver_class_hints_design.md). */
tsv ts_make_class_value_once(uint32_t class_id, ts_code ctor, tsv* env, uint32_t envlen){
  tsv fv = ts_make_fn_t(ctor, env, envlen, 1);
  ((ts_func*)ts_ptr(fv))->class_id = class_id + 1;
  if (class_id < g_class_meta_cap && ts_is_obj(g_class_proto_tab[class_id])){
    ts_gc_root(&fv);
    tsv proto = g_class_proto_tab[class_id];
    ((ts_func*)ts_ptr(fv))->prototype_prop = proto;
    ts_write_barrier(fv, proto);
    ts_define_data(proto, ts_intern_field("constructor", 11), fv, 0, 1, 1);
    ts_gc_unroot(1);
  }
  return fv;
}
tsv ts_make_class_value_cells_once(uint32_t class_id, ts_code ctor, tsv* env, uint32_t envlen){
  tsv fv = ts_make_class_value_once(class_id, ctor, env, envlen);
  if (envlen) ((ts_func*)ts_ptr(fv))->env_abi = 1;
  return fv;
}
/* `new K(args...)`: allocate a typed instance for K's class, wire its prototype,
   then run the constructor (env auto-prepended by ts_call -> [cells..., this, args]).
   Per ECMA-262, if the ctor returns an object, that object is the result. */
#define TS_CONSTRUCT_ARGS_STACK 16
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
    fn_materialize_prototype((ts_func*)ts_ptr(ctorv), ctorv);
    tsv proto = ((ts_func*)ts_ptr(ctorv))->prototype_prop;
    /* In-object slack tracking: the first instance gets a generous inline
       area; afterwards the learned count (largest instance so far plus a
       little slack) sizes the allocation. */
    uint8_t est = ((ts_func*)ts_ptr(ctorv))->inst_slots;
    tsv inst = ts_new_object_n(est ? est : 12u);
    ts_gc_root(&inst);
    ((ts_object*)ts_ptr(inst))->proto = ts_is_obj(proto) ? proto : ts_object_proto();
    int pm = n + 1;
    tsv pstack[TS_CONSTRUCT_ARGS_STACK];
    tsv* pcallargs = pm <= TS_CONSTRUCT_ARGS_STACK
                       ? pstack
                       : (RT_STAT_INC(construct_malloc),
                          (tsv*)malloc(sizeof(tsv) * (size_t)pm));
    pcallargs[0] = inst;
    for (int i = 0; i < n; i++) pcallargs[1 + i] = args[i];
    tsv pr = ts_call(ctorv, pcallargs, pm);
    if (pcallargs != pstack) free(pcallargs);
    {
      uint32_t used = ((ts_object*)ts_ptr(inst))->len + 4u;
      if (used > TS_INLINE_SLOTS_MAX) used = TS_INLINE_SLOTS_MAX;
      ts_func* cf = (ts_func*)ts_ptr(ctorv);
      if (used > cf->inst_slots) cf->inst_slots = (uint8_t)used;
    }
    ts_gc_unroot(2);
    return ts_is_obj(pr) ? pr : inst;
  }
  uint32_t cid = raw - 1;
  if (cid >= g_class_meta_cap || g_class_size[cid] == 0){ fprintf(stderr, "tsaot: TypeError: unregistered class in new\n"); abort(); }
  ts_gc_root(&ctorv);
  /* A field-less class allocates the plain shaped instance (see
     ts_new_sized_impl) sized by the slack learned from earlier instances of
     this constructor, exactly as a plain function constructor does. */
  int plain_inst = g_empty_class_plain && g_class_nfields[cid] == 0;
  tsv inst;
  if (plain_inst){
    uint8_t est = ((ts_func*)ts_ptr(ctorv))->inst_slots;
    inst = ts_new_object_n(est > TS_EMPTY_CLASS_SLOTS ? est : TS_EMPTY_CLASS_SLOTS);
  } else {
    inst = ts_new_sized(g_class_size[cid]);
  }
  tsv proto = ((ts_func*)ts_ptr(ctorv))->prototype_prop;
  ((ts_object*)ts_ptr(inst))->proto = ts_is_obj(proto) ? proto : g_class_proto_tab[cid];
  if (cid < g_class_index_n) ((ts_object*)ts_ptr(inst))->cls = g_class_index_tab[cid];
  /* Boxed fields start as undefined (the zeroed instance memory would read as
     the number 0); generated allocation sites do the same inline. */
  if (g_class_fields[cid]){
    ts_class_field* cf = g_class_fields[cid];
    char* base = (char*)ts_ptr(inst);
    for (int i = 0; i < g_class_nfields[cid]; i++)
      if (!cf[i].numeric) *(tsv*)(base + cf[i].offset) = TS_UNDEFINED;
  }
  ts_gc_root(&inst);
  int m = n + 1;
  tsv stackargs[TS_CONSTRUCT_ARGS_STACK];
  tsv* callargs = m <= TS_CONSTRUCT_ARGS_STACK
                    ? stackargs
                    : (RT_STAT_INC(construct_malloc),
                       (tsv*)malloc(sizeof(tsv) * (size_t)m));
  callargs[0] = inst;
  for (int i = 0; i < n; i++) callargs[1 + i] = args[i];
  tsv r = ts_call(ctorv, callargs, m);
  if (callargs != stackargs) free(callargs);
  if (plain_inst){
    uint32_t used = ((ts_object*)ts_ptr(inst))->len + 4u;
    if (used > TS_INLINE_SLOTS_MAX) used = TS_INLINE_SLOTS_MAX;
    ts_func* cf = (ts_func*)ts_ptr(ctorv);
    if (used > cf->inst_slots) cf->inst_slots = (uint8_t)used;
  }
  ts_gc_unroot(2);
  return ts_is_obj(r) ? r : inst;
}
/* ---- foreign receivers of typed class-field accesses
   (docs/foreign_receivers_design.md) ---- */
/* A prototype chain that carries a registered class with struct fields. */
static int proto_chain_has_struct_class(tsv proto){
  for (int depth = 0; depth < 64 && ts_proto_ref(proto); depth++){
    ts_class_reg* reg = class_reg_for_proto(proto);
    if (reg && reg->min_size > sizeof(ts_object)) return 1;
    if (chain_link_exotic((ts_object*)ts_ptr(proto))) return 0;
    proto = ((ts_object*)ts_ptr(proto))->proto;
  }
  return 0;
}
/* The code of the methods on registered class prototypes whose chain has
   struct fields: borrowing one with a `this` without the layout raises the
   flag. An open-addressing set of code pointers, filled at registration. */
static void** g_struct_methods;
static tsv* g_struct_method_home;   /* the prototype each was first found on (a CLASS_PROTO entry) */
static uint32_t g_struct_methods_cap, g_struct_methods_len;
static uint32_t struct_method_hash(void* code){
  uint64_t x = (uint64_t)(uintptr_t)code;
  return (uint32_t)((x >> 4) ^ (x >> 20)) * 2654435761u;
}
/* The prototype a struct method was registered from, TS_UNDEFINED for any
   other code. */
static tsv struct_method_home(void* code){
  if (!g_struct_methods_len || !code) return TS_UNDEFINED;
  uint32_t mask = g_struct_methods_cap - 1u;
  for (uint32_t i = struct_method_hash(code) & mask; g_struct_methods[i]; i = (i + 1u) & mask)
    if (g_struct_methods[i] == code) return g_struct_method_home[i];
  return TS_UNDEFINED;
}
static int struct_method_has(void* code){ return !ts_is_undef(struct_method_home(code)); }
static void struct_method_add(void* code, tsv home){
  if (!code || struct_method_has(code)) return;
  if ((g_struct_methods_len + 1u) * 4u >= g_struct_methods_cap * 3u){
    uint32_t cap = g_struct_methods_cap ? g_struct_methods_cap * 2u : 64u;
    void** old = g_struct_methods; tsv* old_home = g_struct_method_home; uint32_t oldcap = g_struct_methods_cap;
    g_struct_methods = (void**)calloc(cap, sizeof(void*));
    g_struct_method_home = (tsv*)calloc(cap, sizeof(tsv));
    g_struct_methods_cap = cap;
    for (uint32_t i = 0; i < oldcap; i++) if (old[i]){
      uint32_t j = struct_method_hash(old[i]) & (cap - 1u);
      while (g_struct_methods[j]) j = (j + 1u) & (cap - 1u);
      g_struct_methods[j] = old[i];
      g_struct_method_home[j] = old_home[i];
    }
    free(old); free(old_home);
  }
  uint32_t mask = g_struct_methods_cap - 1u, i = struct_method_hash(code) & mask;
  while (g_struct_methods[i]) i = (i + 1u) & mask;
  g_struct_methods[i] = code;
  g_struct_method_home[i] = home;
  g_struct_methods_len++;
}
static uint32_t propbag_len(tsv owner);
static ts_pref propbag_prop(tsv owner, uint32_t i);
static void struct_methods_collect(tsv proto){
  if (!proto_chain_has_struct_class(proto)) return;
  uint32_t n = propbag_len(proto);
  for (uint32_t i = 0; i < n; i++){
    ts_pref pr = propbag_prop(proto, i);
    if (!pref_ok(pr) || pref_is_accessor(pr)) continue;
    tsv v = pref_val(pr);
    if (ts_is_func(v)) struct_method_add(((ts_func*)ts_ptr(v))->code, proto);
  }
}
/* An object put behind a class with struct fields: one without the layout,
   or a sized instance of its own class (its cls word is marked relinked,
   so the class's methods find it outside their interval). */
static void typed_slow_check_relink(tsv obj, tsv proto){
  if (!g_has_class_regs || !ts_is_obj(obj)) return;
  if (proto_chain_has_struct_class(proto)) typed_slow_raise("an object relinked behind a class with struct fields");
}
static int proto_chain_includes(tsv proto, tsv home){
  for (int depth = 0; depth < 256 && ts_proto_ref(proto); depth++){
    if (proto == home || ts_same_cell(proto, home)) return 1;
    proto = ((ts_object*)ts_ptr(proto))->proto;
  }
  return 0;
}
/* A struct method called with a `this` that is not a sized, unrelinked
   instance of its class (one whose chain holds the method's prototype). */
static void typed_slow_check_borrow(tsv fn, tsv thisArg){
  if (!g_struct_methods_len || !ts_is_func(fn)) return;
  tsv home = struct_method_home(((ts_func*)ts_ptr(fn))->code);
  if (ts_is_undef(home)) return;
  if (ts_is_obj(thisArg)){
    ts_object* t = (ts_object*)ts_ptr(thisArg);
    if (ts_obj_is_sized(t) && !(t->cls & TS_CLS_RELINKED) && proto_chain_includes(t->proto, home)) return;
  }
  typed_this_raise("a class method called with a foreign this");
}
void ts_note_method_escape_slow(void){
  typed_this_raise("a class method read as a value");
}
static ts_class_reg* class_reg_for_proto(tsv proto){
  if (!ts_proto_ref(proto) || !g_class_reg_index_cap) return NULL;
  RT_STAT_INC(class_reg_calls);
  uint32_t probes = 0;
  uint32_t mask = g_class_reg_index_cap - 1u;
  for (uint32_t slot = class_proto_hash(proto) & mask;
       ; slot = (slot + 1u) & mask){
    probes++;
    uint32_t entry = g_class_reg_index[slot];
    if (!entry){
      RT_STAT_ADD(class_reg_probes, probes); RT_STAT_HIST(class_reg_hist, probes);
      return NULL;
    }
    ts_class_reg* reg = &g_class_regs[entry - 1u];
    if (reg->proto == proto || ts_same_cell(reg->proto, proto)){
      RT_STAT_ADD(class_reg_probes, probes); RT_STAT_HIST(class_reg_hist, probes);
      return reg;
    }
  }
}
/* The registered layout whose struct fields THIS object carries. Struct
   fields exist only in sized instances (the layout follows the header); an
   unsized object behind a class prototype — `Object.setPrototypeOf({...},
   C.prototype)`, a subclass prototype, an instance of a field-less class —
   stores its values in inline slots, which the size test alone mistook for
   fields (own enumeration listed every key twice, Session 350). */
/* The prototype whose registered layout a sized instance carries: its own,
   or for an instance relinked by the program, its allocation class's. */
static tsv layout_proto_of(const ts_object* o){
  uint32_t w = o->cls;
  if (TS_RT_LIKELY(!(w & TS_CLS_RELINKED)) || w == TS_CLS_PROTO) return o->proto;
  w &= ~TS_CLS_RELINKED;
  uint32_t c = w < g_class_of_word_n ? g_class_of_word[w] : 0u;
  return (c && c - 1u < g_class_meta_cap) ? g_class_proto_tab[c - 1u] : o->proto;
}
static ts_class_reg* class_reg_for(ts_object* o){
  if (!o || !ts_obj_is_sized(o)) return NULL;
  ts_class_reg* reg = class_reg_for_proto(layout_proto_of(o));
  return reg && o->h.size >= reg->min_size ? reg : NULL;
}
/* canonical-path bridge (A-2b): is `key` a struct field of o? give offset+numeric. */
static int class_field_lookup(ts_object* o, ts_key key, size_t* off, int* numeric){
  if (!o || !ts_obj_is_sized(o) || !g_class_reg_index_cap) return 0;
  tsv lp = layout_proto_of(o);
  if (!ts_proto_ref(lp)) return 0;
  RT_STAT_INC(class_field_calls);
  uint32_t slot = (class_proto_hash(lp) ^ prop_key_hash(key)) & (TS_CLASS_FIELD_CACHE_SIZE - 1u);
  ts_class_field_cache_entry* cache = &g_class_field_cache[slot];
  if (cache->epoch == g_ts_class_layout_epoch && cache->proto == lp && cache->key == key){
    RT_STAT_INC(class_field_hits);
    if (!cache->found || o->h.size < cache->min_size) return 0;
    *off = cache->offset; *numeric = cache->numeric; return 1;
  }
  ts_class_reg* reg = class_reg_for_proto(lp);
  cache->proto = lp; cache->key = key; cache->epoch = g_ts_class_layout_epoch;
  cache->found = 0;
  if (!reg) return 0;
  cache->min_size = reg->min_size;
  for (int i=0;i<reg->nfields;i++) if (reg->fields[i].name_id == key){
    cache->found = 1;
    cache->offset = reg->fields[i].offset; cache->numeric = reg->fields[i].numeric;
    *off = cache->offset; *numeric = cache->numeric; return o->h.size >= cache->min_size;
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
static void gc_mark_class_fields(ts_object* o, int young, int depth, int stable){
  /* Struct fields exist only in sized instances (a registered layout after
     the header); a plain object, even one whose prototype has a registered
     layout, has none. Skipping the registry probe for the unsized majority
     removed 11.6M hash lookups from a compile's collections (Session 350). */
  if (!ts_obj_is_sized(o)) return;
  ts_class_reg* reg = class_reg_for(o);
  if (!reg) return;
  char* base = (char*)o;
  for (int i=0;i<reg->nfields;i++){
    if (reg->fields[i].numeric) continue;
    gc_visit_slot((tsv*)(base + reg->fields[i].offset), young, depth, stable);
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
  /* a plain function's own enumerable properties are its map's (its name,
     length and prototype are not enumerable) */
  if (!(ts_is_obj(obj) || ts_is_func(obj)) || ts_is_map(obj) || ts_is_set(obj)) return;
  /* a view: its elements, then its own named properties */
  if (ts_is_typed_array(obj)){
    ts_gc_root(&obj);
    for (uint32_t i = 0; i < ((ts_typedarray*)ts_ptr(obj))->length; i++){
      char b[16]; int bn = snprintf(b, sizeof b, "%u", i);
      uint32_t k = ts_intern_field(b, (uint32_t)bn);
      cb(k, ts_ta_get(obj, i), ud);
    }
    for (uint32_t i = 0;; i++){
      ts_obj_common* oc = &((ts_typedarray*)ts_ptr(obj))->o;
      if (i >= oc->len) break;
      if (!prop_enum_data_at(oc, i)) continue;
      cb(obj_key_at(oc, i), *obj_val_at(oc, i), ud);
    }
    ts_gc_unroot(1);
    return;
  }
  /* Arrays (unified model): own enumerable keys are the integer indices
     "0".."len-1" (in order, value = element) followed by any named properties
     in the common-header prop map (insertion order). Matches JS enumeration. */
  if (ts_is_indexed_array_fast(obj)){
    for (uint32_t i=0;;i++){
      ts_array* a = arr_dense(obj);   /* the callback may have changed the storage */
      if (i>=a->len) break;
      if (array_is_hole(a->data[i])) continue;
      char b[16]; int bn = snprintf(b, sizeof b, "%u", i);
      uint32_t k = ts_intern_field(b, (uint32_t)bn);
      tsv v = a->data[i];
      cb(k, v, ud);
    }
    /* named props live in the common header's prop map (a->o.props). */
    for (uint32_t i=0;;i++){
      ts_obj_common* oc = &((ts_array*)ts_ptr(obj))->o;
      if (i>=oc->len) break;
      if (!prop_enum_data_at(oc, i)) continue;
      uint32_t k = obj_key_at(oc, i);
      tsv v = (*obj_val_at(oc, i));
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
    if (prop_enum_data_at(o, i) && prop_key_is_array_index(obj_key_at(o, i), &idx)){ has_index = 1; break; }
  }
  if (has_index){
    /* selection over integer indices in ascending order (n is small in practice;
       plain objects with many integer keys should use an array anyway). */
    uint32_t prev_idx; int have_prev = 0; uint32_t emitted = 0, total_idx = 0;
    o = ts_ptr(obj);
    for (uint32_t i=0;i<o->len;i++){ uint32_t idx; if (prop_enum_data_at(o, i) && prop_key_is_array_index(obj_key_at(o, i),&idx)) total_idx++; }
    while (emitted < total_idx){
      uint32_t best=0, best_key=0; tsv best_val=TS_UNDEFINED; int found=0;
      o = ts_ptr(obj);
      for (uint32_t i=0;i<o->len;i++){
        uint32_t idx;
        if (!prop_enum_data_at(o, i) || !prop_key_is_array_index(obj_key_at(o, i),&idx)) continue;
        if (have_prev && idx <= prev_idx) continue;      /* already emitted */
        if (!found || idx < best){ best=idx; best_key=obj_key_at(o, i); best_val=(*obj_val_at(o, i)); found=1; }
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
      if (!prop_enum_data_at(o, i)) continue;
      if (prop_key_is_array_index(obj_key_at(o, i),&idx)) continue;
      uint32_t k = obj_key_at(o, i);
      tsv v = (*obj_val_at(o, i));
      cb(k, v, ud);
    }
    return;
  }
  for (uint32_t i=0;;i++){
    o = ts_ptr(obj);
    if (i>=o->len) break;
    if (!prop_enum_data_at(o, i)) continue;
    uint32_t k = obj_key_at(o, i);
    tsv v = (*obj_val_at(o, i));
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
    if (p == target_proto || ts_same_cell(p, target_proto)) return 1;
    ts_object* link = (ts_object*)ts_ptr(p);
    if (chain_link_exotic(link)){
      /* the link's [[GetPrototypeOf]] (a proxy's trap may collect: the walk
         holds values only) */
      ts_gc_root(&target_proto);
      p = chain_exotic_proto(p);
      ts_gc_unroot(1);
      continue;
    }
    p = link->proto;
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
    if (!ts_proto_ref(obj)) return ts_bool(0);
    /* Builtin constructor values store prototype as an ordinary own property;
       function declarations use prototype_prop. Get handles both layouts. */
    ts_gc_root(&obj); ts_gc_root(&ctorv);
    tsv proto = ts_get(ctorv, ts_intern_field("prototype", 9));
    int matches = ts_proto_ref(proto) ? ts_instanceof(obj, proto) : 0;
    ts_gc_unroot(2);
    if (ts_proto_ref(proto)) return ts_bool(matches);
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
   through the weak sym_id→Symbol table; WKSYM keys via the well-known singleton. */
static void inspect_symbol_key(jbuf* b, ts_key k){
  jb_putz(b, "Symbol(");
  tsv desc = (k >= TS_USERSYM_KEY_BASE)
    ? ts_symbol_description(sym_value_by_id(k - TS_USERSYM_KEY_BASE))
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
    if (obj_key_at(o, i) >= TS_WKSYM_KEY_BASE && (obj_flags_at(o, i) & TS_PROP_ENUMERABLE)) c++;
  return c;
}
/* Emit own enumerable symbol-keyed props (`Symbol(desc): value`), in insertion
   order, after the string/index props. `first` is shared with the string pass so
   the separating comma is correct. */
static void inspect_own_sym_props(jbuf* b, tsv v, int depth, int* first){
  ts_object* o = ts_ptr(v);
  for (uint32_t i=0;i<o->len;i++){
    ts_key k = obj_key_at(o, i);
    if (k < TS_WKSYM_KEY_BASE || !(obj_flags_at(o, i) & TS_PROP_ENUMERABLE)) continue;
    tsv val = (*obj_val_at(o, i));
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
  if (ts_is_typed_array(v)){
    /* V8's form: Int32Array(3) [ 1, 2, 3 ] */
    ts_typedarray* ta = (ts_typedarray*)ts_ptr(v);
    char hdr[48]; snprintf(hdr, sizeof hdr, "%s(%u) ", g_ta_name[ta->elem], ta->length); jb_putz(b, hdr);
    if (ta->length == 0){ jb_putz(b, "[]"); return; }
    jb_putz(b, "[ ");
    for (uint32_t i = 0; i < ta->length; i++){
      if (i) jb_putz(b, ", ");
      if (i >= 100){ char more[48]; snprintf(more, sizeof more, "... %u more item%s", ta->length - i, ta->length - i == 1 ? "" : "s"); jb_putz(b, more); break; }
      inspect_val(b, ts_ta_get(v, i), depth + 1, 0);
      ta = (ts_typedarray*)ts_ptr(v);
    }
    jb_putz(b, " ]");
    return;
  }
  if (ts_is_array_buffer(v)){
    ts_arraybuffer* ab = (ts_arraybuffer*)ts_ptr(v);
    jb_putz(b, ab->shared ? "SharedArrayBuffer { [Uint8Contents]: <" : "ArrayBuffer { [Uint8Contents]: <");
    for (uint32_t i = 0; i < ab->byte_length && i < 50; i++){ char hx[4]; snprintf(hx, sizeof hx, i ? " %02x" : "%02x", ab->bytes[i]); jb_putz(b, hx); }
    if (ab->byte_length > 50){ char more[48]; snprintf(more, sizeof more, " ... %u more byte%s", ab->byte_length - 50, ab->byte_length - 50 == 1 ? "" : "s"); jb_putz(b, more); }
    char tail[48]; snprintf(tail, sizeof tail, ">, [byteLength]: %u }", ab->byte_length); jb_putz(b, tail);
    return;
  }
  if (ts_is_indexed_array_fast(v)){
    ts_gc_root(&v);
    ts_array* a=ts_ptr(v);
    if (a->len==0){ jb_putz(b,"[]"); ts_gc_unroot(1); return; }
    uint32_t len=a->len;
    jb_putz(b,"[ ");
    for (uint32_t i=0;i<len;i++){ a=ts_ptr(v); if(i) jb_putz(b,", "); inspect_val(b, ts_array_get(v,i), depth+1, 0); }
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
  ts_pref p=props_define(o, key, TS_PROP_DEFAULT);
  { tsv* vp = pref_valp(p); *vp = val;
    if (obj_shaped(o)) ts_write_barrier_ptr(obj, vp, val); else ts_write_barrier(obj, val); }
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
  char short_text[TS_SHORTSTR_MAX];
  jparse p;
  if ((view.flags & TS_STR_FLAG_ASCII) && !(view.flags & TS_STR_FLAG_UTF16)){
    p = (jparse){ ts_str_view_data(&view, short_text), 0, view.len, 1 };
  } else {
    uint32_t text_len = 0;
    char* copy=ts_string_cstr_copy(text, &text_len);
    p = (jparse){ copy, 0, text_len, 1 };
  }
  tsv r=jp_value(&p);
  jp_ws(&p);
  if (!((view.flags & TS_STR_FLAG_ASCII) && !(view.flags & TS_STR_FLAG_UTF16))) free((void*)p.s);
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
/* `x.length` of a DOM value (docs: objects/length_property_reads): an
   array's or a string's length, an object's `length` member, undefined on a
   number or a boolean; a missing member (NULL) or null throws, as reading a
   property of undefined or null does. */
tsv ts_json_dom_length_value(tjson_value* value){
  if (!value) return ts_throw_cannot_read(TS_UNDEFINED, "length");
  switch (value->kind){
    case TJSON_ARRAY:
    case TJSON_STRING: return ts_num(tjson_length(value));
    case TJSON_OBJECT: return ts_json_dom_to_tsv(tjson_object_get(value, "length", 6));
    case TJSON_NULL: return ts_throw_cannot_read(TS_NULL, "length");
    default: return TS_UNDEFINED;
  }
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
  if (ts_is_indexed_array_fast(val)){
    uint32_t n=(uint32_t)ts_array_len(val);
    for (uint32_t i=0;i<n;i++){
      char kb[16]; int kl=snprintf(kb,sizeof kb,"%u",i);
      tsv ek=ts_new_string(kb,(uint32_t)kl);
      ts_gc_root(&ek);
      tsv ne=json_internalize(ts_array_get(val,i), ek, reviver);
      ts_gc_root(&ne);
      if (ts_is_undef(ne)) array_put_hole((ts_array*)ts_ptr(val), i);
      else ts_array_set(val, i, ne);
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
      ts_array_push(dst, ts_array_get(src, i));
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
      uint32_t len = ts_str_len_typed(src);
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
    static ts_key kdone, kvalue, knext;
    if (!knext){ kdone = ts_intern_field("done", 4); kvalue = ts_intern_field("value", 5); knext = ts_intern_field("next", 4); }
    tsv iter = src;
    tsv itf = ts_get(src, TS_KEY_WKSYM(TS_WKSYM_ITERATOR));
    if (itf != TS_UNDEFINED && itf != TS_NULL && !ts_is_callable(itf))
      ts_throw_type_error_msg("Symbol.iterator is not callable");
    if (ts_is_callable(itf)){
      ts_gc_root(&itf);
      tsv a0 = src;
      iter = ts_call_method(itf, &a0, 1);
      ts_gc_unroot(1);
    }
    ts_gc_root(&iter);
    if (!ts_object_like(iter)) ts_throw_type_error_msg("Iterator is not an object");
    /* GetIterator caches next once; its getter is observable user code. */
    tsv nf = ts_get(iter, knext);
    ts_gc_root(&nf);
    for(;;){
      tsv r;
      if (ts_is_callable(nf)){
        tsv a0 = iter;
        r = ts_call_method(nf, &a0, 1);
      }
      else { r = ts_gen_next(iter, TS_UNDEFINED); }
      ts_gc_root(&r);
      if (!ts_object_like(r)) ts_throw_type_error_msg("Iterator result is not an object");
      if (ts_truthy(ts_get(r, kdone))){ ts_gc_unroot(1); break; }
      tsv value = ts_get(r, kvalue);
      ts_array_push(dst, value);
      ts_gc_unroot(1);
    }
    ts_gc_unroot(2);
    ts_gc_unroot(2);
    return;
  }
  ts_gc_unroot(2);
  ts_throw_type_error_msg("Value is not iterable");
}

/* ---- string accumulators (docs/string_accumulators_design.md) ----
   A builder is a heap string with TS_STR_FLAG_BUFFER that only its local
   reaches (the generic `+` never exposes its own buffers: its values are
   views). Appends write units at the end, a bigger buffer only when the
   capacity or the encoding runs out. */
static int sb_is_builder(tsv v){
  if (!ts_is_heap_str(v)) return 0;
  uint32_t fl = ts_str_ptr_typed(v)->flags;
  return (fl & TS_STR_FLAG_BUFFER) && !(fl & TS_STR_FLAG_VIEW);
}
/* A builder holding `x`'s units and room for `extra` more (at least). */
static tsv sb_from_view_value(tsv src, uint32_t extra, uint32_t want_utf16){
  ts_gc_root(&src);
  ts_strview x = ts_str_view_typed(src);
  uint32_t flags = (x.flags | want_utf16) & TS_STR_FLAG_UTF16;
  uint64_t need = (uint64_t)x.len + extra;
  if (need > UINT32_MAX / 2u){ ts_gc_unroot(1); fprintf(stderr, "tsaot: RangeError: concatenated string too large\n"); abort(); }
  uint32_t cap = ts_string_builder_capacity(need < 16u ? 16u : (uint32_t)need);
  ts_string* b = ts_string_alloc_buffer(cap, flags);
  x = ts_str_view_typed(src);
  ts_str_copy_units(b->data, flags, 0, x, 0, x.len);
  b->len = x.len;
  b->hash = 0;
  b->flags = TS_STR_FLAG_BUFFER | flags | ((x.len == 0 || (x.flags & TS_STR_FLAG_ASCII)) ? TS_STR_FLAG_ASCII : 0);
  ts_string_write_terminator(b, x.len);
  ts_gc_unroot(1);
  return ts_str_v(b);
}
tsv ts_sb_new(tsv init){
  if (!ts_is_str(init)) init = ts_to_string_v(init);
  return sb_from_view_value(init, 0, 0);
}
tsv ts_sb_append(tsv sb, tsv e){
  char nb[24]; uint32_t nl = 0;
  int digits = ts_is_num(e) && ts_int_digits(ts_to_num(e), nb, &nl);
  ts_gc_root(&sb); ts_gc_root(&e);
  if (!digits && !ts_is_str(e)){
    /* `L + e` with L a string: ToPrimitive(default), then ToString */
    if (ts_object_like(e) && !ts_is_symbol(e)) e = ts_to_primitive(e, 2);
    e = ts_to_string_v(e);
  }
  uint32_t add_len, add_utf16 = 0, add_ascii = 1;
  if (digits) add_len = nl;
  else {
    ts_strview y = ts_str_view_typed(e);
    add_len = y.len;
    add_utf16 = y.flags & TS_STR_FLAG_UTF16;
    add_ascii = (y.len == 0 || (y.flags & TS_STR_FLAG_ASCII)) ? 1 : 0;
  }
  if (!sb_is_builder(sb)) sb = sb_from_view_value(ts_is_str(sb) ? sb : ts_to_string_v(sb), add_len, add_utf16);
  ts_string* b = ts_str_ptr_typed(sb);
  uint64_t n64 = (uint64_t)b->len + add_len;
  if (n64 > UINT32_MAX / 2u){ ts_gc_unroot(2); fprintf(stderr, "tsaot: RangeError: concatenated string too large\n"); abort(); }
  uint32_t n = (uint32_t)n64;
  if (n > ts_string_storage_capacity(b) || (add_utf16 && !(b->flags & TS_STR_FLAG_UTF16))){
    sb = sb_from_view_value(sb, add_len, add_utf16);   /* copies; the old buffer becomes garbage */
    b = ts_str_ptr_typed(sb);
  }
  uint32_t at = b->len;
  if (digits){
    for (uint32_t i = 0; i < nl; i++) ts_str_cu_set(b->data, b->flags, at + i, (uint16_t)(unsigned char)nb[i]);
  } else {
    ts_strview y = ts_str_view_typed(e);
    ts_str_copy_units(b->data, b->flags, at, y, 0, y.len);
  }
  b->len = n;
  b->hash = 0;
  if (!add_ascii) b->flags &= ~TS_STR_FLAG_ASCII;
  ts_string_write_terminator(b, n);
  ts_gc_unroot(2);
  return sb;
}
/* Append units [start, end) of string `s` (no slice string). */
tsv ts_sb_append_range(tsv sb, tsv s, uint32_t start, uint32_t end){
  if (!ts_is_str(s) || end <= start) return sb_is_builder(sb) ? sb : sb_from_view_value(ts_is_str(sb) ? sb : ts_to_string_v(sb), 0, 0);
  ts_gc_root(&sb); ts_gc_root(&s);
  ts_strview y = ts_str_view_typed(s);
  if (end > y.len) end = y.len;
  if (start > end) start = end;
  uint32_t add_len = end - start;
  uint32_t add_utf16 = y.flags & TS_STR_FLAG_UTF16;
  uint32_t add_ascii = (y.flags & TS_STR_FLAG_ASCII) ? 1 : 0;
  if (!add_ascii && !add_utf16){
    /* an 8-bit string that is not all ASCII: the range may still be ASCII,
       but the flag is only a hint for fast paths; leave it off */
  }
  if (!sb_is_builder(sb)) sb = sb_from_view_value(ts_is_str(sb) ? sb : ts_to_string_v(sb), add_len, add_utf16);
  ts_string* b = ts_str_ptr_typed(sb);
  uint64_t n64 = (uint64_t)b->len + add_len;
  if (n64 > UINT32_MAX / 2u){ ts_gc_unroot(2); fprintf(stderr, "tsaot: RangeError: concatenated string too large\n"); abort(); }
  uint32_t n = (uint32_t)n64;
  if (n > ts_string_storage_capacity(b) || (add_utf16 && !(b->flags & TS_STR_FLAG_UTF16))){
    sb = sb_from_view_value(sb, add_len, add_utf16);
    b = ts_str_ptr_typed(sb);
  }
  y = ts_str_view_typed(s);
  ts_str_copy_units(b->data, b->flags, b->len, y, start, add_len);
  b->len = n;
  b->hash = 0;
  if (!add_ascii && add_len) b->flags &= ~TS_STR_FLAG_ASCII;
  ts_string_write_terminator(b, n);
  ts_gc_unroot(2);
  return sb;
}
double ts_sb_len(tsv sb){
  if (sb_is_builder(sb)) return (double)ts_str_ptr_typed(sb)->len;
  return (double)ts_str_len_typed(sb);
}
tsv ts_sb_finish(tsv sb){
  if (!sb_is_builder(sb)) return sb;
  ts_string* b = ts_str_ptr_typed(sb);
  if ((b->flags & TS_STR_FLAG_ASCII) && !(b->flags & TS_STR_FLAG_UTF16) && b->len <= TS_SHORTSTR_MAX)
    return ts_short_str_ascii(b->data, b->len);
  b->flags &= ~TS_STR_FLAG_BUFFER;
  b->hash = 0;
  return sb;
}
/* for..of over a value its type does not classify (docs/array_iterators_design.md).
   An array is walked by index (returned as is); a string by code points (a
   snapshot: strings are immutable); anything else through GetIterator: its
   [Symbol.iterator]() (Map / Set iterators are live, a generator is its own),
   or the value itself when it is already an iterator. */
tsv ts_forof_open(tsv v){
  if (ts_is_indexed_array_fast(v)) return v;
  ts_gc_root(&v);
  tsv r = TS_UNDEFINED; ts_gc_root(&r);
  if (ts_is_str(v)){
    r = ts_new_array(0);
    ts_array_push_all(r, v);
  } else if (ts_object_like(v)){
    tsv itf = ts_get(v, TS_KEY_WKSYM(TS_WKSYM_ITERATOR));
    if (ts_is_callable(itf)){
      ts_gc_root(&itf);
      tsv a0 = v;
      r = ts_call_method(itf, &a0, 1);
      ts_gc_unroot(1);
      if (!ts_object_like(r)) ts_throw_type_error_msg("Result of the Symbol.iterator method is not an object");
    } else if (itf != TS_UNDEFINED && itf != TS_NULL){
      ts_throw_type_error_msg("Symbol.iterator is not callable");
    } else {
      r = v;      /* an iterator (a generator object, an object with next) */
    }
  } else {
    char buf[96];
    snprintf(buf, sizeof(buf), "%s is not iterable",
             ts_is_undef(v) ? "undefined" : ts_is_null(v) ? "null" : ts_is_num(v) ? "number" : ts_is_bool(v) ? "boolean" : "value");
    ts_throw_type_error_msg(buf);
  }
  ts_gc_unroot(2);
  return r;
}
tsv ts_forof_next_slow(tsv it, ts_key next_key){
  static ts_key kdone, kvalue;
  if (!kdone){ kdone = ts_intern_field("done", 4); kvalue = ts_intern_field("value", 5); }
  tsv res = ts_iter_step(it, TS_UNDEFINED, next_key);
  if (!ts_object_like(res)) ts_throw_type_error_msg("Iterator result is not an object");
  ts_gc_root(&res);
  tsv out = ts_truthy(ts_get(res, kdone)) ? TS_ITER_DONE : ts_get(res, kvalue);
  ts_gc_unroot(1);
  return out;
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
    tsv coro = ts_get(src, ts_coro_key());
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
  if (iterable == TS_UNDEFINED || iterable == TS_NULL) return setv;
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
  if (iterable == TS_UNDEFINED || iterable == TS_NULL) return mapv;
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
tsv ts_weakset_seed(tsv setv, tsv iterable){
  if (iterable == TS_UNDEFINED || iterable == TS_NULL) return setv;
  if (!ts_is_weakset(setv)) return setv;
  ts_gc_root(&setv); ts_gc_root(&iterable);
  tsv tmp = ts_new_array(0); ts_gc_root(&tmp);
  ts_array_push_all(tmp, iterable);
  ts_array* a = as_arr(tmp);
  for (uint32_t i = 0; i < a->len; i++){
    ts_weakset_add(setv, a->data[i]);
    a = as_arr(tmp);
  }
  ts_gc_unroot(3);
  return setv;
}
tsv ts_weakmap_seed(tsv mapv, tsv iterable){
  if (iterable == TS_UNDEFINED || iterable == TS_NULL) return mapv;
  if (!ts_is_weakmap(mapv)) return mapv;
  ts_gc_root(&mapv); ts_gc_root(&iterable);
  tsv tmp = ts_new_array(0); ts_gc_root(&tmp);
  ts_array_push_all(tmp, iterable);
  ts_array* a = as_arr(tmp);
  for (uint32_t i = 0; i < a->len; i++){
    tsv pair = a->data[i];
    ts_array* p = as_arr(pair);
    tsv key = (p && p->len > 0) ? p->data[0] : TS_UNDEFINED;
    tsv value = (p && p->len > 1) ? p->data[1] : TS_UNDEFINED;
    ts_weakmap_set(mapv, key, value);
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
    if (is_function_proto_name(key)) return 1;   /* call/apply/bind (METHOD-keyed) */
    for (ts_object* p = ts_ptr(obj); p; ){
      if (chain_link_exotic(p)){
        int res; ts_object* next;
        if (chain_exotic_has(p, key, &res, &next)) return res;
        p = next;
        continue;
      }
      if (p->h.kind == TS_KIND_FUNC && fn_link_has(p, key)) return 1;
      if (find_slot(p, key, 0)) return 1;
      if (p == ts_proto_ptr(g_object_proto_v) && is_object_proto_name(key)) return 1;
      p = ts_next_proto(p);
    }
    return 0;
  }
  if (!ts_is_obj(obj)) return 0;
  if (ts_is_typed_array(obj)){
    /* a view: its elements, and the prototype's accessors */
    uint32_t idx;
    if (ta_numeric_key(key, &idx)) return idx < ((ts_typedarray*)ts_ptr(obj))->length;
    if (field_name_is(key, "length") || field_name_is(key, "byteLength") ||
        field_name_is(key, "byteOffset") || field_name_is(key, "buffer")) return 1;
  }
  if (ts_is_array_buffer(obj) && field_name_is(key, "byteLength")) return 1;
  /* arrays: a canonical index within bounds, or "length", is a present property
     (array elements live in element storage, not the prop map). */
  if (ts_is_indexed_array_fast(obj)){
    const char* nm = ts_field_name(key);
    if (nm){
      uint32_t nm_len = ts_field_name_len(key);
      if (field_bytes_is(nm, nm_len, "length")) return 1;
      long ix = ts_canonical_array_index(nm, nm_len);
      if (ix >= 0 && ts_array_has_index(obj, (uint32_t)ix)) return 1;
    }
  }
  ts_object* o=ts_ptr(obj);
  /* typed class instance: struct fields aren't in the prop map; consult the
     class descriptor (covers the full inherited field chain). */
  if (class_has_field(o, key)) return 1;
  while (o){
    if (chain_link_exotic(o)){
      int res; ts_object* next;
      if (chain_exotic_has(o, key, &res, &next)) return res;
      o = next;
      continue;
    }
    if (TS_RT_UNLIKELY(o->h.kind == TS_KIND_FUNC) && fn_link_has(o, key)) return 1;
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
static int fn_delete(tsv obj, ts_key key, int strict);
int ts_delete_prop_strict(tsv obj, ts_key key){
  if (ts_is_obj(obj)){ ts_gc_header* _dh = (ts_gc_header*)ts_ptr(obj); if (_dh->gen == TS_GEN_OLD) _dh->hdr_spare = 0xFF; }
  if (g_has_proxies && ts_is_proxy(obj)) return ts_proxy_delete_v(obj, ts_key_to_value(key));
  if (ts_is_func(obj)) return fn_delete(obj, key, 1);
  if (!ts_is_obj(obj)) return 1;
  if (ts_is_typed_array(obj)){
    uint32_t idx;
    if (ta_numeric_key(key, &idx) && idx < ((ts_typedarray*)ts_ptr(obj))->length){
      char buf[96];
      snprintf(buf, sizeof buf, "Cannot delete property '%u' of [object %s]", idx, g_ta_name[((ts_typedarray*)ts_ptr(obj))->elem]);
      ts_throw_type_error_msg(buf);
      return 0;
    }
  }
  ts_object* o=ts_ptr(obj);
  if (ts_is_indexed_array_fast(obj)){
    const char* nm=ts_field_name(key);
    long ix=nm ? ts_canonical_array_index(nm, ts_field_name_len(key)) : -1;
    if (ix >= 0 && ts_array_has_index(obj, (uint32_t)ix)){
      if (ts_obj_integrity(o) & (1u|4u)){
        char buf[128];
        snprintf(buf,sizeof buf,"Cannot delete property '%ld' of [object Array]",ix);
        ts_throw_type_error_msg(buf);
        return 0;
      }
      array_put_hole((ts_array*)ts_ptr(obj), (uint32_t)ix);
      return 1;
    }
  }
  int nonconf = 0;
  if (ts_obj_integrity(o) & (1u|4u)) {        /* frozen / sealed => all own props non-configurable */
    /* (a class instance's struct fields are own properties too) */
    if (pref_ok(prop_find(o, key)) || (g_has_class_regs && class_has_field(o, key))) nonconf = 1;
  } else {
    ts_pref p = prop_find(o, key);
    if (pref_ok(p) && !pref_is_configurable(p)) nonconf = 1;
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
tsv ts_delete_dynamic_strict(tsv obj, tsv keyv, const uint32_t* method_pairs, uint32_t count){
  ts_gc_root(&obj); ts_gc_root(&keyv);
  if (obj == TS_UNDEFINED || obj == TS_NULL)
    ts_throw_type_error_msg("Cannot convert undefined or null to object");
  ts_key key;
  int ok = ts_key_from_value(keyv, &key);
  if (ok && ts_is_str(obj)){
    const char* name = ts_field_name(key);
    long index = name ? ts_canonical_array_index(name, ts_field_name_len(key)) : -1;
    if ((index >= 0 && (uint64_t)index < ts_str_len_typed(obj)) || field_name_is(key, "length"))
      ts_throw_type_error_msg("Cannot delete non-configurable string property");
  }
  int result = ok ? ts_delete_prop_strict(obj, key) : 1;
  if (!result) ts_throw_type_error_msg("Cannot delete non-configurable property");
  if (ok && !(g_has_proxies && ts_is_proxy(obj))) {
    for (uint32_t i = 0; i < count; i++) if (method_pairs[i * 2] == key)
      ts_delete_prop_strict(obj, method_pairs[i * 2 + 1]);
  }
  ts_gc_unroot(2);
  return ts_bool(result);
}
/* Delete own property `key` of a property-map holder (an object, a
   function's map, a class's static container): 1 deleted or absent, 0
   refused (non-configurable, sealed or frozen). */
/* A sized class instance becomes a plain object behind the same prototype
   (a delete of one of its struct fields; docs/closed_receivers_design.md,
   slice 2): its fields in declaration order, then its own properties in
   order, become the entries of a property dictionary; the struct area turns
   into the in-object slots of a plain cell of the same size (a dictionary
   never reads them); its class index word leaves every interval, and the
   typed accesses' flag goes up. 0 when the cell cannot be described as a
   plain object (more struct area than in-object slots can cover). */
static int obj_abandon_layout(tsv obj){
  ts_object* o = (ts_object*)ts_ptr(obj);
  ts_class_reg* reg = class_reg_for(o);
  size_t area = o->h.size - sizeof(ts_object);
  if (!reg || area % sizeof(tsv) != 0 || area / sizeof(tsv) > TS_INLINE_SLOTS_MAX) return 0;
  uint32_t nf = (uint32_t)reg->nfields, ne = o->len, n = nf + ne;
  ts_gc_root(&obj);
  ts_prop* d = n ? (ts_prop*)gc_owned_alloc(&o->h, sizeof(ts_prop) * (n < 4u ? 4u : n)) : NULL;
  o = (ts_object*)ts_ptr(obj);
  reg = class_reg_for(o);
  for (uint32_t i = 0; i < nf; i++){
    d[i].key = reg->fields[i].name_id;
    d[i].val = struct_field_get(o, reg->fields[i].offset, reg->fields[i].numeric);
    d[i].flags = TS_PROP_WRITABLE | TS_PROP_ENUMERABLE | TS_PROP_CONFIGURABLE;
  }
  for (uint32_t j = 0; j < ne; j++){
    d[nf + j].key = obj_key_at(o, j);
    d[nf + j].val = *obj_val_at(o, j);
    d[nf + j].flags = obj_flags_at(o, j);
  }
  if (o->props && o->cap) gc_owned_free(o->props);
  if (o->prop_index) gc_owned_free(o->prop_index);
  tsv* slots = (tsv*)((char*)o + sizeof(ts_object));
  for (size_t i = 0; i < area / sizeof(tsv); i++) slots[i] = TS_UNDEFINED;
  o->h.inline_cap = (uint8_t)(area / sizeof(tsv));
  o->props = d; o->len = n; o->cap = n ? (n < 4u ? 4u : n) : 0u; o->prop_index = NULL;
  ts_obj_set_shape(o, TS_SHAPE_NONE);
  o->cls = 0;
  if (o->h.gen == TS_GEN_OLD) o->h.hdr_spare = 0xFF;   /* slots renumbered */
  if (n >= TS_PROP_INDEX_MIN) prop_index_rebuild(o, n);
  prop_add_epoch_bump();
  ts_gc_unroot(1);
  typed_slow_raise("a class field deleted");
  return 1;
}
static int props_delete_own(ts_object* o, ts_key key){
  if (o->h.gen == TS_GEN_OLD) o->h.hdr_spare = 0xFF;
  if (ts_obj_integrity(o) & (1u|4u)) return 0;   /* frozen / sealed: delete ignored (false) */
  ts_pref found = prop_find(o, key);
  if (!pref_ok(found)) return 1;
  /* non-configurable: delete is ignored (returns false in sloppy mode). */
  if (!pref_is_configurable(found)) return 0;
  uint32_t i = found.i;
  /* Deletion leaves the hidden-class regime. Shift the remaining dictionary
     entries to preserve insertion order; indexed entries store dense
     positions, so every successful deletion rebuilds the sparse index. */
  obj_to_dictionary(o);
  for (uint32_t j=i;j+1<o->len;j++) o->props[j]=o->props[j+1];
  o->len--;
  if (o->prop_index) prop_index_rebuild(o, o->len);
  return 1;
}
static void fn_delete_refused(ts_key key){
  const char* nm = ts_field_name(key);
  char buf[256];
  snprintf(buf, sizeof(buf), "Cannot delete property '%s' of function", nm ? nm : "?");
  ts_throw_type_error_msg(buf);
}
/* `delete fn.key` (docs/function_own_properties_design.md): the prototype is
   not configurable, a virtual `name` or `length` is deleted by its bit, an
   own entry lives in the function's map or a class value's static
   container. 1 deleted or absent; 0 refused (strict: TypeError). */
static int fn_delete(tsv obj, ts_key key, int strict){
  ts_func* f = (ts_func*)ts_ptr(obj);
  fn_keys_init();
  int sealed = (ts_obj_integrity(&f->o) & (1u|4u)) != 0;
  if (key == g_fn_key_prototype && fn_has_own_prototype(f)){ if (strict) fn_delete_refused(key); return 0; }
  int which = fn_virtual(f, key);
  if (which){
    if (sealed){ if (strict) fn_delete_refused(key); return 0; }
    if (which == FN_VIRTUAL_NAME) f->name_gone = 1; else f->length_gone = 1;
    prop_add_epoch_bump();
    return 1;
  }
  ts_object* holder = find_slot(&f->o, key, 0) ? &f->o : NULL;
  if (!holder && f->class_id){
    ts_object* sc = ts_proto_ptr(f->o.proto);
    if (sc && sc->h.kind == TS_KIND_OBJECT && find_slot(sc, key, 0)) holder = sc;
  }
  if (!holder) return 1;
  int r = props_delete_own(holder, key);
  if (!r && strict) fn_delete_refused(key);
  return r;
}
int ts_delete_prop(tsv obj, ts_key key){
  if (ts_is_obj(obj)){ ts_gc_header* _dh = (ts_gc_header*)ts_ptr(obj); if (_dh->gen == TS_GEN_OLD) _dh->hdr_spare = 0xFF; }
  if (g_has_proxies && ts_is_proxy(obj)) return ts_proxy_delete_v(obj, ts_key_to_value(key));
  if (ts_is_func(obj)) return fn_delete(obj, key, 0);
  if (!ts_is_obj(obj)) return 1;
  if (ts_is_typed_array(obj)){
    uint32_t idx;   /* an element is not configurable */
    if (ta_numeric_key(key, &idx)) return idx >= ((ts_typedarray*)ts_ptr(obj))->length;
  }
  ts_object* o=ts_ptr(obj);
  if (ts_is_indexed_array_fast(obj)){
    const char* nm=ts_field_name(key);
    long ix=nm ? ts_canonical_array_index(nm, ts_field_name_len(key)) : -1;
    if (ix >= 0){
      if (!ts_array_has_index(obj, (uint32_t)ix)) return 1;
      if (ts_obj_integrity(o) & (1u|4u)) return 0;
      array_put_hole((ts_array*)ts_ptr(obj), (uint32_t)ix);
      return 1;
    }
  }
  if (g_has_class_regs){
    size_t off; int numeric;
    if (class_field_lookup(o, key, &off, &numeric)){
      if (ts_obj_integrity(o) & (1u|4u)) return 0;     /* sealed or frozen: not configurable */
      if (!obj_abandon_layout(obj))
        ts_throw_type_error_msg("Cannot delete a field of this class instance (garnet: its layout is too large to become a plain object)");
      o = ts_ptr(obj);
    }
  }
  return props_delete_own(o, key);
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
static tsv descriptor_from_prop(ts_pref p){
  int e=pref_is_enumerable(p), c=pref_is_configurable(p), w=pref_is_writable(p);
  if (pref_is_accessor(p)){
    ts_accessor* ac=(ts_accessor*)ts_ptr(pref_val(p));
    return build_accessor_descriptor(ac->getter, ac->setter, e, c);
  }
  return build_data_descriptor(pref_val(p), w, e, c);
}
static tsv descriptor_from_prop_map(ts_object* o, ts_key key){
  ts_pref p = prop_find(o, key);
  return pref_ok(p) ? descriptor_from_prop(p) : TS_UNDEFINED;
}
/* descriptor for an already-interned own key (used by the public entry + the
   getOwnPropertyDescriptors walker). */
static tsv ts_own_descriptor_by_key(tsv obj, ts_key key){
  const char* nm = ts_field_name(key);
  uint32_t nm_len = ts_field_name_len(key);
  if (ts_is_str(obj)){
    uint32_t len = ts_str_len_typed(obj);
    if (nm && field_bytes_is(nm, nm_len, "length")) return build_data_descriptor(ts_num((double)len), 0, 0, 0);
    if (nm){
      long ix = ts_canonical_array_index(nm, nm_len);
      if (ix >= 0 && (uint32_t)ix < len){
        return build_data_descriptor(ts_string_slice_view(obj, (uint32_t)ix, 1), 0, 1, 0);
      }
    }
    return TS_UNDEFINED;
  }
  if (ts_is_indexed_array_fast(obj) && nm){
    ts_array* a = ts_ptr(obj);
    if (field_bytes_is(nm, nm_len, "length")) return build_data_descriptor(ts_num((double)a->len), 1, 0, 0);
    long ix = ts_canonical_array_index(nm, nm_len);
    if (ix >= 0 && ts_array_has_index(obj, (uint32_t)ix))
      return build_data_descriptor(ts_array_get(obj, (uint32_t)ix), 1, 1, 1);
  }
  if (ts_is_typed_array(obj)){
    uint32_t idx;
    if (ta_numeric_key(key, &idx))
      return idx < ((ts_typedarray*)ts_ptr(obj))->length ? build_data_descriptor(ts_ta_get(obj, idx), 1, 1, 1) : TS_UNDEFINED;
  }
  if (ts_is_func(obj)){
    ts_object* sc = ts_class_static_container(obj);
    if (sc){
      tsv d = descriptor_from_prop_map(sc, key);
      if (!ts_is_undef(d)) return d;
    }
    ts_func* f = ts_ptr(obj);
    int which = fn_virtual(f, key);
    if (which){
      int conf = !(ts_obj_integrity(&f->o) & (1u|4u));
      return build_data_descriptor(fn_virtual_value(f, which), 0, 0, conf);
    }
    if (nm && field_bytes_is(nm, nm_len, "prototype") && fn_has_own_prototype(f)){
      f = fn_materialize_prototype(f, obj);
      return build_data_descriptor(f->prototype_prop, ts_is_class_value(obj) ? 0 : 1, 0, 0);
    }
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
    uint32_t len = ts_str_len_typed(obj);
    for (uint32_t i=0;i<len;i++){
      char b[16]; int bn = snprintf(b, sizeof b, "%u", i);
      uint32_t k = ts_intern_field(b, (uint32_t)bn);
      tsv d = ts_own_descriptor_by_key(obj, k);
      if (!ts_is_undef(d)) ts_set(res, k, d);
      len = ts_str_len_typed(obj);
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
          ts_pref p = propbag_prop(scv, i); if (!pref_ok(p)) continue;
          uint32_t k = pref_key(p);
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
      uint32_t k = obj_key_at(o, i);
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
/* Object.defineProperty / Reflect.defineProperty on an ordinary object
   (ValidateAndApplyPropertyDescriptor). A new property takes the descriptor's
   fields, absent ones false or undefined; an existing one keeps the fields the
   descriptor does not name, and a non-configurable one accepts only what the
   spec allows (a TypeError otherwise). A class field of a sized instance stays
   a writable, enumerable, configurable data property: a value updates it, and
   any other attribute throws (loudly: the struct has no per-field
   attributes). */
enum { DEF_VALUE = 1, DEF_WRITABLE = 2, DEF_ENUMERABLE = 4, DEF_CONFIGURABLE = 8, DEF_GET = 16, DEF_SET = 32 };
/* `fmt` takes the property name once (V8's texts). */
static void define_property_error(const char* fmt, ts_key key){
  const char* nm = ts_field_name(key);
  char buf[256];
  snprintf(buf, sizeof(buf), fmt, nm ? nm : "?");
  ts_throw_type_error(buf);
}
static tsv define_descriptor_object(unsigned present, tsv value, tsv getter, tsv setter, int e, int w, int c){
  ts_gc_root(&value); ts_gc_root(&getter); ts_gc_root(&setter);
  tsv d = ts_new_object();
  ts_gc_root(&d);
  if (present & DEF_VALUE) ts_set(d, ts_intern_field("value", 5), value);
  if (present & DEF_WRITABLE) ts_set(d, ts_intern_field("writable", 8), ts_bool(w));
  if (present & DEF_GET) ts_set(d, ts_intern_field("get", 3), getter);
  if (present & DEF_SET) ts_set(d, ts_intern_field("set", 3), setter);
  if (present & DEF_ENUMERABLE) ts_set(d, ts_intern_field("enumerable", 10), ts_bool(e));
  if (present & DEF_CONFIGURABLE) ts_set(d, ts_intern_field("configurable", 12), ts_bool(c));
  ts_gc_unroot(4);
  return d;
}
/* A view's numeric key (integer-indexed [[DefineOwnProperty]]): an element
   takes a value; an attribute it cannot have (an accessor, or one explicitly
   non-writable, non-enumerable or non-configurable) or a key that names no
   element is refused. */
static int ta_define_index(tsv obj, ts_key key, uint32_t idx, unsigned present, tsv value, int e, int w, int c, int throws){
  if (idx >= ((ts_typedarray*)ts_ptr(obj))->length){
    if (throws) ts_throw_type_error_msg("Invalid typed array index");
    return 0;
  }
  if ((present & (DEF_GET | DEF_SET)) || ((present & DEF_WRITABLE) && !w) ||
      ((present & DEF_ENUMERABLE) && !e) || ((present & DEF_CONFIGURABLE) && !c)){
    if (throws){
      char buf[96]; const char* nm = ts_field_name(key);
      snprintf(buf, sizeof buf, "Cannot redefine property: %s", nm ? nm : "?");
      ts_throw_type_error_msg(buf);
    }
    return 0;
  }
  if (present & DEF_VALUE) ts_ta_set(obj, idx, value);
  return 1;
}
/* 1 when applied; a refusal throws the TypeError when `throws` (Object.defineProperty)
   and returns 0 otherwise (Reflect.defineProperty). */
static int define_own_property(tsv obj, ts_key key, unsigned present, tsv value, tsv getter, tsv setter, int e, int w, int c, int throws){
  { uint32_t idx;
    if (TS_RT_UNLIKELY(ts_is_typed_array(obj)) && ta_numeric_key(key, &idx))
      return ta_define_index(obj, key, idx, present, value, e, w, c, throws); }
  ts_gc_root(&obj); ts_gc_root(&value); ts_gc_root(&getter); ts_gc_root(&setter);
  if (ts_is_func(obj)) fn_realize_virtual(obj, key);   /* the definition applies to an own entry */
  int is_acc = (present & (DEF_GET | DEF_SET)) != 0, is_data = (present & (DEF_VALUE | DEF_WRITABLE)) != 0;
  ts_object* o = (ts_object*)ts_ptr(obj);
  uint32_t integ = ts_obj_integrity(o);
  int exists = 0, cur_acc = 0, cur_e = 0, cur_w = 0, cur_c = 0, field = 0;
  tsv cur_value = TS_UNDEFINED, cur_get = TS_UNDEFINED, cur_set = TS_UNDEFINED;
  ts_gc_root(&cur_value); ts_gc_root(&cur_get); ts_gc_root(&cur_set);
  if (g_has_class_regs && o->h.kind == TS_KIND_OBJECT && class_has_field(o, key)){
    exists = field = 1;
    cur_value = ts_get(obj, key);
    cur_e = 1; cur_w = !(integ & 1u); cur_c = !(integ & (1u|4u));
  } else if (kind_has_common_header(o->h.kind)){
    ts_pref cur = prop_find(o, key);
    if (pref_ok(cur)){
      exists = 1;
      cur_acc = pref_is_accessor(cur);
      cur_e = pref_is_enumerable(cur);
      cur_c = pref_is_configurable(cur) && !(integ & (1u|4u));
      if (cur_acc){
        ts_accessor* ac = (ts_accessor*)ts_ptr(pref_val(cur));
        cur_get = ac->getter; cur_set = ac->setter;
      } else {
        cur_value = pref_val(cur);
        cur_w = pref_is_writable(cur) && !(integ & 1u);
      }
    }
  }
  int ne, nw, nc;
  tsv ng = TS_UNDEFINED, ns = TS_UNDEFINED, nv = TS_UNDEFINED;
  if (!exists){
    if (integ & (1u|2u|4u)){ ts_gc_unroot(7); if (throws) define_property_error("Cannot define property %s, object is not extensible", key); return 0; }
    ne = e; nw = w; nc = c; ng = getter; ns = setter; nv = value;
  } else {
    /* a non-configurable property accepts no change of kind or attributes,
       and a non-writable data property no other value */
    if (!cur_c){
      int bad = ((present & DEF_CONFIGURABLE) && c) || ((present & DEF_ENUMERABLE) && e != cur_e) ||
                ((is_acc || is_data) && is_acc != cur_acc);
      if (!bad && cur_acc)
        bad = ((present & DEF_GET) && !ts_object_is(getter, cur_get)) ||
              ((present & DEF_SET) && !ts_object_is(setter, cur_set));
      if (!bad && !cur_acc && !cur_w)
        bad = ((present & DEF_WRITABLE) && w) || ((present & DEF_VALUE) && !ts_object_is(value, cur_value));
      if (bad){ ts_gc_unroot(7); if (throws) define_property_error("Cannot redefine property: %s", key); return 0; }
    }
    ne = (present & DEF_ENUMERABLE) ? e : cur_e;
    nc = (present & DEF_CONFIGURABLE) ? c : cur_c;
    /* a data property turned accessor keeps neither value nor writable, and
       the other way round neither get nor set */
    if (is_acc || (!is_data && cur_acc)){
      ng = (present & DEF_GET) ? getter : (cur_acc ? cur_get : TS_UNDEFINED);
      ns = (present & DEF_SET) ? setter : (cur_acc ? cur_set : TS_UNDEFINED);
      nw = 0;
    } else {
      nv = (present & DEF_VALUE) ? value : (cur_acc ? TS_UNDEFINED : cur_value);
      nw = (present & DEF_WRITABLE) ? w : (cur_acc ? 0 : cur_w);
    }
  }
  int acc_result = exists ? (is_acc || (!is_data && cur_acc)) : is_acc;
  if (field){
    if (acc_result){ ts_gc_unroot(7); define_property_error("Cannot redefine property: %s (a class field stays a data property)", key); return 0; }
    if (!(ne && nw && nc) && !(ne == cur_e && nw == cur_w && nc == cur_c)){
      ts_gc_unroot(7); define_property_error("Cannot redefine property: %s (a class field keeps its default attributes)", key); return 0;
    }
    /* unchanged attributes (also on a frozen or sealed instance): the value */
    if ((present & DEF_VALUE) && !ts_object_is(nv, cur_value)) ts_set(obj, key, nv);
  } else if (acc_result){
    int g_this = ts_is_func(ng) ? ((ts_func*)ts_ptr(ng))->takes_this : 0;
    int s_this = ts_is_func(ns) ? ((ts_func*)ts_ptr(ns))->takes_this : 0;
    ts_define_accessor_attr(obj, key, ng, ns, g_this, s_this, ne, nc);
  } else {
    ts_define_data(obj, key, nv, ne, nw, nc);
  }
  ts_gc_unroot(7);
  return 1;
}
/* The emitted form of a literal descriptor: `present` names its fields
   (1 value, 2 writable, 4 enumerable, 8 configurable). */
void ts_define_data_desc(tsv obj, tsv keyv, tsv value, int e, int w, int c, unsigned present){
  if (g_has_proxies && ts_is_proxy(obj)){
    ts_gc_root(&obj); ts_gc_root(&keyv);
    tsv d = define_descriptor_object(present & 15u, value, TS_UNDEFINED, TS_UNDEFINED, e, w, c);
    ts_proxy_define_property(obj, keyv, d);
    ts_gc_unroot(2);
    return;
  }
  if (!ts_is_propbag(obj)){ ts_throw_type_error("Object.defineProperty called on non-object"); return; }
  ts_gc_root(&obj); ts_gc_root(&value);
  ts_key key;
  int ok = ts_key_from_value(keyv, &key);
  ts_gc_unroot(2);
  if (ok) define_own_property(obj, key, present & 15u, value, TS_UNDEFINED, TS_UNDEFINED, e, w, c, 1);
}
/* `present`: 1 get, 2 set, 4 enumerable, 8 configurable. */
void ts_define_accessor_desc(tsv obj, tsv keyv, tsv getter, tsv setter, int g_this, int s_this, int e, int c, unsigned present){
  (void)g_this; (void)s_this;
  unsigned bits = ((present & 1u) ? DEF_GET : 0u) | ((present & 2u) ? DEF_SET : 0u) | (present & 12u);
  if (g_has_proxies && ts_is_proxy(obj)){
    ts_gc_root(&obj); ts_gc_root(&keyv);
    tsv d = define_descriptor_object(bits, TS_UNDEFINED, getter, setter, e, 0, c);
    ts_proxy_define_property(obj, keyv, d);
    ts_gc_unroot(2);
    return;
  }
  if (!ts_is_propbag(obj)){ ts_throw_type_error("Object.defineProperty called on non-object"); return; }
  ts_gc_root(&obj); ts_gc_root(&getter); ts_gc_root(&setter);
  ts_key key;
  int ok = ts_key_from_value(keyv, &key);
  ts_gc_unroot(3);
  if (ok) define_own_property(obj, key, bits, TS_UNDEFINED, getter, setter, e, 0, c, 1);
}
static int define_property_from(tsv obj, tsv keyv, tsv desc, int throws){
  if (g_has_proxies && ts_is_proxy(obj)){ ts_proxy_define_property(obj, keyv, desc); return 1; }
  if (!ts_is_propbag(obj)){
    ts_throw_type_error(throws ? "Object.defineProperty called on non-object" : "Reflect.defineProperty called on non-object");
    return 0;
  }
  if (!ts_is_obj(desc) && !ts_is_func(desc)){
    ts_throw(ts_new_string("TypeError: Property description must be an object", 48));
    return 0;
  }
  tsv getter = TS_UNDEFINED, setter = TS_UNDEFINED, value = TS_UNDEFINED;
  ts_gc_root(&obj); ts_gc_root(&desc); ts_gc_root(&keyv);
  ts_gc_root(&getter); ts_gc_root(&setter); ts_gc_root(&value);
  ts_key k_value = ts_intern_field("value", 5);
  ts_key k_get   = ts_intern_field("get", 3);
  ts_key k_set   = ts_intern_field("set", 3);
  ts_key k_enum  = ts_intern_field("enumerable", 10);
  ts_key k_writ  = ts_intern_field("writable", 8);
  ts_key k_conf  = ts_intern_field("configurable", 12);
  /* ToPropertyDescriptor, in the spec's order */
  unsigned present = 0;
  int e = 0, c = 0, w = 0;
  if (ts_has_prop(desc, k_enum)){ present |= DEF_ENUMERABLE; e = ts_truthy(ts_get(desc, k_enum)); }
  if (ts_has_prop(desc, k_conf)){ present |= DEF_CONFIGURABLE; c = ts_truthy(ts_get(desc, k_conf)); }
  if (ts_has_prop(desc, k_value)){ present |= DEF_VALUE; value = ts_get(desc, k_value); }
  if (ts_has_prop(desc, k_writ)){ present |= DEF_WRITABLE; w = ts_truthy(ts_get(desc, k_writ)); }
  if (ts_has_prop(desc, k_get)){
    present |= DEF_GET; getter = ts_get(desc, k_get);
    if (!ts_is_func(getter) && !ts_is_undef(getter)){ ts_gc_unroot(6); ts_throw_type_error("Getter must be a function"); return 0; }
  }
  if (ts_has_prop(desc, k_set)){
    present |= DEF_SET; setter = ts_get(desc, k_set);
    if (!ts_is_func(setter) && !ts_is_undef(setter)){ ts_gc_unroot(6); ts_throw_type_error("Setter must be a function"); return 0; }
  }
  if ((present & (DEF_VALUE | DEF_WRITABLE)) && (present & (DEF_GET | DEF_SET))){
    ts_gc_unroot(6);
    ts_throw(ts_new_string("TypeError: Invalid property descriptor (value with get/set)", 59));
    return 0;
  }
  ts_key key;
  int ok = ts_key_from_value(keyv, &key) ? define_own_property(obj, key, present, value, getter, setter, e, w, c, throws) : 1;
  ts_gc_unroot(6);
  return ok;
}
void ts_define_property(tsv obj, tsv keyv, tsv desc){ (void)define_property_from(obj, keyv, desc, 1); }

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
  if (ts_is_indexed_array_fast(obj) && ts_is_num(keyv)){
    uint32_t index;
    if (ts_num_array_index(ts_to_num(keyv), &index)) return ts_array_has_index(obj, index);
    /* any other number is a property key (ToString), below */
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
    if (fn_link_has((ts_object*)ts_ptr(obj), key)) return 1;   /* prototype, name, length */
    ts_object* sc = ts_class_static_container(obj);
    if (sc && find_slot(sc, key, 0) != NULL) return 1;
    return find_slot((ts_object*)ts_ptr(obj), key, 0) != NULL;
  }
  if (!ts_is_obj(obj)) return 0;
  if (ts_is_typed_array(obj)){
    uint32_t idx;
    if (ta_numeric_key(key, &idx)) return idx < ((ts_typedarray*)ts_ptr(obj))->length;
  }
  ts_object* o=ts_ptr(obj);
  /* array: own = a canonical index in [0,len) or "length" (elements live in
     element storage, not the prop map). Explicitly-set props fall through below. */
  if (ts_is_indexed_array_fast(obj) && nm){
    uint32_t nm_len = ts_field_name_len(key);
    if (field_bytes_is(nm, nm_len, "length")) return 1;
    long ix = ts_canonical_array_index(nm, nm_len);
    if (ix >= 0 && ts_array_has_index(obj, (uint32_t)ix)) return 1;
  }
  if (class_has_field(o, key)) return 1;     /* own typed struct field */
  return find_slot(o, key, 0) != NULL;       /* own prop slot (no proto walk) */
}
int ts_has_own_dyn(tsv obj, tsv keyv){
  /* ToObject(this): `o.hasOwnProperty(k)`, `Object.hasOwn(o, k)` and
     `hasOwnProperty.call(o, k)` all throw on null/undefined (V8: "Cannot
     convert undefined or null to object"); a silent false would be a
     miscompile. */
  if (ts_is_null(obj) || ts_is_undef(obj)) { ts_throw_type_error_msg("Cannot convert undefined or null to object"); return 0; }
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
  if (ts_is_indexed_array_fast(self)) return ts_array_join(self, ts_new_string(",",1));
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
  if (ts_is_typed_array(v)){
    static const char* const tags[TS_TA_COUNT] = { "[object Int8Array]", "[object Uint8Array]", "[object Uint8ClampedArray]",
      "[object Int16Array]", "[object Uint16Array]", "[object Int32Array]", "[object Uint32Array]",
      "[object Float32Array]", "[object Float64Array]" };
    const char* tg = tags[((ts_typedarray*)ts_ptr(v))->elem];
    return ts_new_string(tg, (uint32_t)strlen(tg));
  }
  if (ts_is_array_buffer(v)){
    return ((ts_arraybuffer*)ts_ptr(v))->shared ? ts_new_string("[object SharedArrayBuffer]", 26) : ts_new_string("[object ArrayBuffer]", 20);
  }
  const char* tag = ts_is_array(v) ? "[object Array]"
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
  ts_gc_root(&self);
  while (ts_proto_ref(cur)){
    if (cur == self || ts_same_cell(cur, self)){ ts_gc_unroot(1); return ts_bool(1); }
    ts_object* link = (ts_object*)ts_ptr(cur);
    if (chain_link_exotic(link)){ cur = chain_exotic_proto(cur); continue; }
    if (!kind_has_common_header(link->h.kind)) break;
    cur = link->proto;
  }
  ts_gc_unroot(1);
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
   as the receiver and applies JS default-argument semantics.
   Another receiver (`Array.prototype.map.call(typedArray, f)`, an array-like
   object, a string): the reading methods run on an array of its elements (its
   length and indexed properties, absent ones as holes); the mutating ones
   throw rather than change that copy, except where a typed array has the same
   operation. */
/* V8's TypeError for a null or undefined receiver: the methods it implements
   in Torque name themselves, the others fail ToObject. */
static void arrproto_null_receiver(const char* name){
  static const char* const named[] = { "map", "indexOf", "reduce", "filter", "forEach", "find", "some",
    "every", "concat", "reduceRight", "findIndex", "findLast", "findLastIndex" };
  for (size_t i = 0; i < sizeof named / sizeof named[0]; i++){
    if (strcmp(name, named[i]) == 0){
      char buf[96]; snprintf(buf, sizeof buf, "Array.prototype.%s called on null or undefined", name);
      ts_throw_type_error_msg(buf);
    }
  }
  ts_throw_type_error_msg("Cannot convert undefined or null to object");
}
static tsv arrproto_elements(tsv recv, const char* name){
  if (ts_is_null(recv) || ts_is_undef(recv)) arrproto_null_receiver(name);
  ts_gc_root(&recv);
  tsv out = ts_new_array(0); ts_gc_root(&out);
  if (ts_is_typed_array(recv)){
    for (uint32_t i = 0; i < ((ts_typedarray*)ts_ptr(recv))->length; i++) ts_array_push(out, ts_ta_get(recv, i));
  } else if (ts_is_str(recv) || ts_object_like(recv)){
    double d = ts_number_coerce(ts_get(recv, ts_intern_field("length", 6)));
    uint32_t len = !(d > 0) ? 0 : d > 4294967295.0 ? 4294967295u : (uint32_t)d;
    int str = ts_is_str(recv);
    for (uint32_t i = 0; i < len; i++){
      tsv k = ts_num((double)i);
      if (str || ts_has_prop_dyn(recv, k)) ts_array_push(out, ts_get_dyn(recv, k));
      else ts_array_push_hole(out);
    }
  }
  ts_gc_unroot(2);
  return out;
}
#define ARR_THIS(a, name) (TS_RT_LIKELY(ts_is_indexed_array_fast((a)[0])) ? (a)[0] : arrproto_elements((a)[0], name))
static void arrproto_mutating(tsv recv, const char* name){
  if (ts_is_indexed_array_fast(recv)) return;
  if (ts_is_null(recv) || ts_is_undef(recv)) arrproto_null_receiver(name);
  char buf[128];
  snprintf(buf, sizeof buf, "Array.prototype.%s on a receiver that is not an array is not supported", name);
  ts_throw_type_error_msg(buf);
}
tsv ts_objproto_toString(tsv* a, int n);
static tsv ta_m_reverse(tsv* a, int n);
static tsv ta_m_fill(tsv* a, int n);
static tsv ta_m_copy_within(tsv* a, int n);
tsv ts_arrproto_join(tsv* a, int n){ return ts_array_join(ARR_THIS(a, "join"), (n>1 && a[1]!=TS_UNDEFINED)?a[1]:ts_new_string(",",1)); }
tsv ts_arrproto_toString(tsv* a, int n){
  /* another receiver: its join, or Object.prototype.toString without one */
  if (!ts_is_indexed_array_fast(a[0]) && !ts_is_typed_array(a[0])) return ts_objproto_toString(a, n);
  return ts_array_join(ARR_THIS(a, "toString"), ts_new_string(",",1));
}
tsv ts_arrproto_indexOf(tsv* a, int n){ return ts_num(ts_array_indexof(ARR_THIS(a, "indexOf"), n>1?a[1]:TS_UNDEFINED, n>2?ts_to_num(a[2]):0, n>2)); }
tsv ts_arrproto_includes(tsv* a, int n){ return ts_bool(ts_array_includes(ARR_THIS(a, "includes"), n>1?a[1]:TS_UNDEFINED, n>2?ts_to_num(a[2]):0, n>2)); }
tsv ts_arrproto_lastIndexOf(tsv* a, int n){ return ts_num(ts_array_lastindexof(ARR_THIS(a, "lastIndexOf"), n>1?a[1]:TS_UNDEFINED, n>2?ts_to_num(a[2]):0, n>2)); }
tsv ts_arrproto_slice(tsv* a, int n){ return ts_array_slice(ARR_THIS(a, "slice"), n>1?ts_number_coerce(a[1]):0, n>2?ts_number_coerce(a[2]):0, n>2 && !ts_is_undef(a[2])); }
tsv ts_arrproto_concat(tsv* a, int n){
  /* variadic: fold each arg through the 2-arg concat; no args -> shallow copy. */
  if(n<=1) return ts_array_slice(ARR_THIS(a, "concat"), 0, 0, 0);
  tsv out=a[0]; ts_gc_root(&out);
  for(int k=1;k<n;k++) out=ts_array_concat(out, a[k]);
  ts_gc_unroot(1);
  return out;
}
tsv ts_arrproto_join_pop(tsv* a, int n){ (void)n; arrproto_mutating(a[0], "pop"); return ts_array_pop(a[0]); }
tsv ts_arrproto_pop(tsv* a, int n){ (void)n; arrproto_mutating(a[0], "pop"); return ts_array_pop(a[0]); }
tsv ts_arrproto_push(tsv* a, int n){ arrproto_mutating(a[0], "push"); for(int i=1;i<n;i++) ts_array_push(a[0], a[i]); return ts_num(ts_array_len(a[0])); }
tsv ts_arrproto_shift(tsv* a, int n){ (void)n; arrproto_mutating(a[0], "shift"); return ts_array_shift(a[0]); }
tsv ts_arrproto_unshift(tsv* a, int n){ arrproto_mutating(a[0], "unshift"); for(int i=n-1;i>=1;i--) ts_array_unshift(a[0], a[i]); return ts_num(ts_array_len(a[0])); }
tsv ts_arrproto_reverse(tsv* a, int n){
  if (ts_is_typed_array(a[0])) return ta_m_reverse(a, n);
  arrproto_mutating(a[0], "reverse"); return ts_array_reverse(a[0]);
}
tsv ts_arrproto_at(tsv* a, int n){ return ts_array_at(ARR_THIS(a, "at"), n>1?ts_to_num(a[1]):0); }
tsv ts_arrproto_fill(tsv* a, int n){
  if (ts_is_typed_array(a[0])) return ta_m_fill(a, n);
  arrproto_mutating(a[0], "fill");
  return ts_array_fill(a[0], n>1?a[1]:TS_UNDEFINED, n>2?ts_to_num(a[2]):0, n>3?ts_to_num(a[3]):0, n>2, n>3);
}
tsv ts_arrproto_flat(tsv* a, int n){ return ts_array_flat(ARR_THIS(a, "flat"), n>1?ts_to_num(a[1]):1); }
tsv ts_arrproto_sort(tsv* a, int n){ arrproto_mutating(a[0], "sort"); return ts_array_sort(a[0], n>1?a[1]:TS_UNDEFINED); }
/* callback-taking methods: the callback is args[1] (a ts_func/closure). */
/* The callback of an iteration method bound to the call's thisArg
   (`arr.forEach(fn, ctx)`), as fn.bind(ctx) would; an absent or undefined
   thisArg keeps the callback (a plain call's this is undefined anyway). */
tsv ts_callback_with_this(tsv cb, tsv thisArg){
  if (ts_is_undef(thisArg)) return cb;
  tsv a[2] = { cb, thisArg };
  return ts_funcproto_bind(a, 2);
}
#define TS_ITER_CB(a, n) ((n) > 1 ? ((n) > 2 ? ts_callback_with_this((a)[1], (a)[2]) : (a)[1]) : TS_UNDEFINED)
tsv ts_arrproto_map(tsv* a, int n){ return ts_array_map(ARR_THIS(a, "map"), TS_ITER_CB(a, n)); }
tsv ts_arrproto_filter(tsv* a, int n){ return ts_array_filter(ARR_THIS(a, "filter"), TS_ITER_CB(a, n)); }
tsv ts_arrproto_forEach(tsv* a, int n){ return ts_array_foreach(ARR_THIS(a, "forEach"), TS_ITER_CB(a, n)); }
tsv ts_arrproto_reduce(tsv* a, int n){ return ts_array_reduce(ARR_THIS(a, "reduce"), n>1?a[1]:TS_UNDEFINED, n>2?a[2]:TS_UNDEFINED, n>2); }
tsv ts_arrproto_splice(tsv* a, int n){
  arrproto_mutating(a[0], "splice");
  tsv items=ts_new_array(0); ts_gc_root(&items);
  for(int k=3;k<n;k++) ts_array_push(items, a[k]);
  /* n counts the receiver: n==1 -> splice() deletes nothing; n==2 -> splice(start)
     deletes to end (has_dc=0); n>=3 -> deleteCount given. */
  int has_dc = (n>=3) || (n<=1);
  tsv r = ts_array_splice(a[0], n>1?ts_to_num(a[1]):0, n>2?ts_to_num(a[2]):0, has_dc, items);
  ts_gc_unroot(1);
  return r;
}
tsv ts_arrproto_reduceRight(tsv* a, int n){ return ts_array_reduce_right(ARR_THIS(a, "reduceRight"), n>1?a[1]:TS_UNDEFINED, n>2?a[2]:TS_UNDEFINED, n>2); }
tsv ts_arrproto_copyWithin(tsv* a, int n){
  if (ts_is_typed_array(a[0])) return ta_m_copy_within(a, n);
  arrproto_mutating(a[0], "copyWithin");
  return ts_array_copy_within(a[0], n>1?ts_to_num(a[1]):0, n>2?ts_to_num(a[2]):0, n>3?ts_to_num(a[3]):0, n>3);
}
tsv ts_arrproto_find(tsv* a, int n){ return ts_array_find(ARR_THIS(a, "find"), TS_ITER_CB(a, n)); }
tsv ts_arrproto_findIndex(tsv* a, int n){ return ts_num(ts_array_findindex(ARR_THIS(a, "findIndex"), TS_ITER_CB(a, n))); }
tsv ts_arrproto_findLast(tsv* a, int n){ return ts_array_findlast(ARR_THIS(a, "findLast"), TS_ITER_CB(a, n)); }
tsv ts_arrproto_findLastIndex(tsv* a, int n){ return ts_num(ts_array_findlastindex(ARR_THIS(a, "findLastIndex"), TS_ITER_CB(a, n))); }
tsv ts_arrproto_some(tsv* a, int n){ return ts_bool(ts_array_some(ARR_THIS(a, "some"), TS_ITER_CB(a, n))); }
tsv ts_arrproto_every(tsv* a, int n){ return ts_bool(ts_array_every(ARR_THIS(a, "every"), TS_ITER_CB(a, n))); }
tsv ts_arrproto_flatMap(tsv* a, int n){ return ts_array_flatmap(ARR_THIS(a, "flatMap"), TS_ITER_CB(a, n)); }

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
  tsv iterator = ts_make_fn_t(ts_array_iterator, NULL, 0, 1); ts_gc_root(&iterator);
  ts_set_fn_meta(iterator, 0, "values");
  ts_define_data(g_array_proto_v, TS_KEY_WKSYM(TS_WKSYM_ITERATOR), iterator, 0, 1, 1);
  ts_gc_unroot(1);
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

/* ---------------- typed arrays (docs/typed_arrays_design.md) ----------------
   An ArrayBuffer owns zeroed bytes outside the heap (freed with its cell); a
   view (ts_typedarray) points into them and keeps its buffer alive. Element
   access, the properties and the methods follow ECMAScript for one thread. */
static tsv g_ta_proto[TS_TA_COUNT];
static tsv g_typed_array_proto = TS_NULL;    /* %TypedArray%.prototype */
static tsv g_arraybuffer_proto = TS_NULL, g_sab_proto = TS_NULL;
static ts_key g_ta_k_length, g_ta_k_byte_length, g_ta_k_byte_offset, g_ta_k_buffer, g_ta_k_bpe;
static void ta_protos_init(void);
static void ta_ctors_init(void);
static void ta_value_text(tsv v, int typed, char* out, size_t cap);
static tsv g_ta_ctor[TS_TA_COUNT], g_ab_ctor = TS_UNDEFINED, g_sab_ctor = TS_UNDEFINED;
static inline ts_typedarray* ta_ptr(tsv v){ return (ts_typedarray*)ts_ptr(v); }
static tsv ta_require(tsv v, const char* method){
  (void)method;
  if (!ts_is_typed_array(v)) ts_throw_type_error_msg("this is not a typed array.");
  return v;
}
/* Element load and store (the header's in-line forms with the view's element
   type); the store takes the number already converted by ToNumber. */
static inline double ta_load(const ts_typedarray* t, uint32_t i){ return ts_ta_elem_load(t->data, i, t->elem); }
static inline void ta_store(ts_typedarray* t, uint32_t i, double d){ ts_ta_elem_store(t->data, i, d, t->elem); }
tsv ts_ta_get(tsv v, uint32_t i){
  ts_typedarray* t = ta_ptr(v);
  return i < t->length ? ts_num(ta_load(t, i)) : TS_UNDEFINED;
}
void ts_ta_set(tsv v, uint32_t i, tsv x){
  double d;
  if (ts_is_num(x)) d = ts_to_num(x);
  else { ts_gc_root(&v); d = ts_number_coerce(x); ts_gc_unroot(1); }
  ts_typedarray* t = ta_ptr(v);
  if (i < t->length) ta_store(t, i, d);
}
/* The new cells. */
/* V8's RangeErrors name the offending number. */
static void ta_range_error_num(const char* fmt, double d){
  char num[40], buf[128];
  ts_fmt_num(d, num, sizeof num);
  snprintf(buf, sizeof buf, fmt, num);
  ts_throw_range_error_msg(buf);
}
static tsv ta_new_buffer(double length, int shared){
  if (!(length >= 0) || length != floor(length) || length > 4294967295.0)
    ts_throw_range_error_msg("Array buffer allocation failed");
  ta_protos_init();
  uint32_t n = (uint32_t)length;
  uint8_t* bytes = (uint8_t*)calloc(n ? n : 1, 1);
  if (!bytes) ts_throw_range_error_msg("Array buffer allocation failed");
  /* The bytes pace the collections like the cells: short-lived buffers are
     reclaimed by the young collections their bytes trigger, long-lived ones
     count toward the next full collection. */
  gc_note_payload(n);
  ts_arraybuffer* b = (ts_arraybuffer*)gc_alloc(sizeof(ts_arraybuffer), TS_KIND_ARRAYBUFFER);
  g_heap_bytes += n;   /* after the allocation: a collection resets the count */
  b->bytes = bytes; b->byte_length = n; b->shared = (uint8_t)(shared ? 1 : 0);
  b->o.shape = TS_SHAPE_EMPTY;
  tsv bv = ts_obj(b);
  obj_link_fresh_proto(bv, shared ? g_sab_proto : g_arraybuffer_proto);
  return bv;
}
static tsv ta_new_view(int elem, tsv buffer, uint32_t byte_offset, uint32_t length){
  ts_gc_root(&buffer);
  ta_protos_init();
  ts_typedarray* t = (ts_typedarray*)gc_alloc(sizeof(ts_typedarray), TS_KIND_TYPEDARRAY);
  ts_arraybuffer* b = (ts_arraybuffer*)ts_ptr(buffer);
  t->buffer = buffer; t->elem = (uint8_t)elem;
  t->byte_offset = byte_offset; t->length = length;
  t->data = b->bytes + byte_offset;
  t->o.shape = TS_SHAPE_EMPTY;
  tsv tv = ts_obj(t);
  ts_write_barrier(tv, buffer);
  obj_link_fresh_proto(tv, g_ta_proto[elem]);
  ts_gc_unroot(1);
  return tv;
}
/* ToIndex for a length: a typed array's (the RangeError names the number) or
   a buffer's. A length past what the buffer can hold fails its allocation. */
static double ta_to_index(tsv v, int buffer){
  double x = ts_is_num(v) ? ts_to_num(v) : ts_number_coerce(v);
  double d = x != x ? 0 : x < 0 ? ceil(x) : floor(x);
  if (d < 0 || d > 9007199254740991.0){
    if (buffer) ts_throw_range_error_msg("Invalid array buffer length");
    ta_range_error_num("Invalid typed array length: %s", x);
  }
  return d == 0 ? 0 : d;
}
static uint32_t ta_length_arg(tsv v){
  double d = ta_to_index(v, 0);
  if (d > 4294967295.0) ts_throw_range_error_msg("Array buffer allocation failed");
  return (uint32_t)d;
}
static tsv ta_new_length(int elem, uint32_t length){
  if ((double)length * g_ta_size[elem] > 4294967295.0) ts_throw_range_error_msg("Array buffer allocation failed");
  tsv buffer = ta_new_buffer((double)length * g_ta_size[elem], 0);
  return ta_new_view(elem, buffer, 0, length);
}
static uint32_t ta_source_length(tsv src);
static tsv ta_source_get(tsv src, uint32_t i);
/* `new T(x)` and `new T(buffer, byteOffset, length)`. */
tsv ts_new_typed_array(int elem, tsv* args, int n){
  if (n <= 0 || ts_is_undef(args[0])) return ta_new_length(elem, 0);
  tsv a0 = args[0];
  if (ts_is_array_buffer(a0)){
    /* InitializeTypedArrayFromArrayBuffer, with V8's messages */
    ts_gc_root(&a0);
    uint32_t size = g_ta_size[elem];
    char msg[128];
    double off = 0;
    if (n > 1 && !ts_is_undef(args[1])){
      double x = ts_is_num(args[1]) ? ts_to_num(args[1]) : ts_number_coerce(args[1]);
      off = x != x ? 0 : x < 0 ? ceil(x) : floor(x);
      if (off < 0 || off > 9007199254740991.0) ta_range_error_num("Start offset %s is outside the bounds of the buffer", x);
    }
    if (fmod(off, size) != 0){
      snprintf(msg, sizeof msg, "start offset of %s should be a multiple of %u", g_ta_name[elem], size);
      ts_throw_range_error_msg(msg);
    }
    double new_length = -1;
    if (n > 2 && !ts_is_undef(args[2])) new_length = ta_to_index(args[2], 0);
    uint32_t blen = ((ts_arraybuffer*)ts_ptr(a0))->byte_length;
    uint32_t length;
    if (new_length < 0){
      if (blen % size != 0){
        snprintf(msg, sizeof msg, "byte length of %s should be a multiple of %u", g_ta_name[elem], size);
        ts_throw_range_error_msg(msg);
      }
      if (off > blen) ta_range_error_num("Start offset %s is outside the bounds of the buffer", off);
      length = (uint32_t)((blen - off) / size);
    } else {
      if (off + new_length * size > blen) ta_range_error_num("Invalid typed array length: %s", new_length);
      length = (uint32_t)new_length;
    }
    tsv r = ta_new_view(elem, a0, (uint32_t)off, length);
    ts_gc_unroot(1);
    return r;
  }
  if (ts_is_num(a0)) return ta_new_length(elem, ta_length_arg(a0));
  if (ts_object_like(a0)){
    /* a typed array, an array or an array-like (an iterable goes through Array.from) */
    ts_gc_root(&a0);
    tsv src = a0; ts_gc_root(&src);
    if (!ts_is_typed_array(src) && !ts_is_indexed_array_fast(src)){
      tsv itf = ts_get(src, TS_KEY_WKSYM(TS_WKSYM_ITERATOR));
      if (ts_is_callable(itf)) src = ts_array_from(src);
    }
    uint32_t len = ta_source_length(src);
    tsv r = ta_new_length(elem, len); ts_gc_root(&r);
    for (uint32_t i = 0; i < len; i++) ts_ta_set(r, i, ta_source_get(src, i));
    ts_gc_unroot(3);
    return r;
  }
  return ta_new_length(elem, ta_length_arg(a0));
}
tsv ts_new_array_buffer(tsv length, int shared){
  return ta_new_buffer(ts_is_undef(length) ? 0 : ta_to_index(length, 1), shared);
}
static uint32_t ta_source_length(tsv src){
  if (ts_is_typed_array(src)) return ta_ptr(src)->length;
  if (ts_is_indexed_array_fast(src)) return ts_array_len(src);
  tsv l = ts_get(src, g_ta_k_length);
  double d = ts_number_coerce(l);
  if (!(d > 0)) return 0;
  return d > 4294967295.0 ? 4294967295u : (uint32_t)floor(d);
}
static tsv ta_source_get(tsv src, uint32_t i){
  if (ts_is_typed_array(src)) return ts_ta_get(src, i);
  if (ts_is_indexed_array_fast(src)) return ts_array_get(src, i);
  return ts_get_dyn(src, ts_num((double)i));
}
/* T.from(source, mapFn, thisArg), T.of(...items) */
tsv ts_typed_array_from(int elem, tsv src, tsv mapfn, tsv this_arg){
  ts_gc_root(&src); ts_gc_root(&mapfn); ts_gc_root(&this_arg);
  if (!ts_is_typed_array(src) && !ts_is_indexed_array_fast(src)){
    tsv itf = ts_object_like(src) || ts_is_str(src) ? ts_get(src, TS_KEY_WKSYM(TS_WKSYM_ITERATOR)) : TS_UNDEFINED;
    if (ts_is_callable(itf) || ts_is_str(src)) src = ts_array_from(src);
  }
  uint32_t len = ta_source_length(src);
  tsv r = ta_new_length(elem, len); ts_gc_root(&r);
  int mapped = !ts_is_undef(mapfn);
  tsv cb = mapped ? (ts_is_undef(this_arg) ? mapfn : ts_callback_with_this(mapfn, this_arg)) : TS_UNDEFINED;
  ts_gc_root(&cb);
  ts_cb cbf; if (mapped) cb_resolve(&cbf, cb);
  for (uint32_t i = 0; i < len; i++){
    tsv x = ta_source_get(src, i);
    if (mapped){ tsv args[2] = { x, ts_num((double)i) }; x = cb_call(&cbf, cb, args, 2); }
    ts_ta_set(r, i, x);
  }
  ts_gc_unroot(5);
  return r;
}
tsv ts_typed_array_of(int elem, tsv* items, int n){
  tsv r = ta_new_length(elem, (uint32_t)(n > 0 ? n : 0)); ts_gc_root(&r);
  for (int i = 0; i < n; i++) ts_ta_set(r, (uint32_t)i, items[i]);
  ts_gc_unroot(1);
  return r;
}
int ts_array_buffer_is_view(tsv v){ return ts_is_typed_array(v); }
/* Relative index arguments (ToIntegerOrInfinity, negative from the end, clamped). */
static uint32_t ta_rel(tsv* a, int n, int i, uint32_t len, uint32_t dflt){
  if (i >= n || ts_is_undef(a[i])) return dflt;
  double d = ts_is_num(a[i]) ? ts_to_num(a[i]) : ts_number_coerce(a[i]);
  if (d != d) d = 0;
  d = d < 0 ? ceil(d) : floor(d);
  if (d < 0){ d += len; return d < 0 ? 0 : (uint32_t)d; }
  return d > len ? len : (uint32_t)d;
}
/* ---- the methods (args[0] is the receiver) ---- */
static tsv ta_m_subarray(tsv* a, int n){
  tsv t = ta_require(n ? a[0] : TS_UNDEFINED, "subarray"); ts_gc_root(&t);
  uint32_t len = ta_ptr(t)->length;
  uint32_t b = ta_rel(a, n, 1, len, 0), e = ta_rel(a, n, 2, len, len);
  ts_typedarray* x = ta_ptr(t);
  uint32_t count = e > b ? e - b : 0;
  tsv r = ta_new_view(x->elem, x->buffer, x->byte_offset + b * g_ta_size[x->elem], count);
  ts_gc_unroot(1);
  return r;
}
static tsv ta_m_slice(tsv* a, int n){
  tsv t = ta_require(n ? a[0] : TS_UNDEFINED, "slice"); ts_gc_root(&t);
  uint32_t len = ta_ptr(t)->length;
  uint32_t b = ta_rel(a, n, 1, len, 0), e = ta_rel(a, n, 2, len, len);
  uint32_t count = e > b ? e - b : 0;
  tsv r = ta_new_length(ta_ptr(t)->elem, count);
  ts_typedarray* x = ta_ptr(t);
  uint32_t sz = g_ta_size[x->elem];
  if (count) memcpy(ta_ptr(r)->data, x->data + (size_t)b * sz, (size_t)count * sz);
  ts_gc_unroot(1);
  return r;
}
static tsv ta_m_set(tsv* a, int n){
  tsv t = ta_require(n ? a[0] : TS_UNDEFINED, "set"); ts_gc_root(&t);
  tsv src = n > 1 ? a[1] : TS_UNDEFINED; ts_gc_root(&src);
  double off = n > 2 && !ts_is_undef(a[2]) ? ts_number_coerce(a[2]) : 0;
  if (off != off) off = 0;
  off = off < 0 ? ceil(off) : floor(off);
  if (off < 0) ts_throw_range_error_msg("offset is out of bounds");
  uint32_t slen = ts_object_like(src) ? ta_source_length(src) : 0;
  ts_typedarray* x = ta_ptr(t);
  if (off + slen > x->length) ts_throw_range_error_msg("offset is out of bounds");
  uint32_t o = (uint32_t)off;
  if (ts_is_typed_array(src) && ta_ptr(src)->elem == x->elem){
    uint32_t sz = g_ta_size[x->elem];
    memmove(x->data + (size_t)o * sz, ta_ptr(src)->data, (size_t)slen * sz);
  } else if (ts_is_typed_array(src)){
    /* convert through doubles; a copy first when the views share a buffer */
    double* tmp = (double*)malloc(sizeof(double) * (slen ? slen : 1));
    for (uint32_t i = 0; i < slen; i++) tmp[i] = ta_load(ta_ptr(src), i);
    for (uint32_t i = 0; i < slen; i++) ta_store(ta_ptr(t), o + i, tmp[i]);
    free(tmp);
  } else {
    for (uint32_t i = 0; i < slen; i++) ts_ta_set(t, o + i, ta_source_get(src, i));
  }
  ts_gc_unroot(2);
  return TS_UNDEFINED;
}
static tsv ta_m_fill(tsv* a, int n){
  tsv t = ta_require(n ? a[0] : TS_UNDEFINED, "fill"); ts_gc_root(&t);
  double d = n > 1 ? (ts_is_num(a[1]) ? ts_to_num(a[1]) : ts_number_coerce(a[1])) : NAN;
  uint32_t len = ta_ptr(t)->length;
  uint32_t b = ta_rel(a, n, 2, len, 0), e = ta_rel(a, n, 3, len, len);
  ts_typedarray* x = ta_ptr(t);
  for (uint32_t i = b; i < e && i < x->length; i++) ta_store(x, i, d);
  ts_gc_unroot(1);
  return t;
}
static tsv ta_m_copy_within(tsv* a, int n){
  tsv t = ta_require(n ? a[0] : TS_UNDEFINED, "copyWithin"); ts_gc_root(&t);
  uint32_t len = ta_ptr(t)->length;
  uint32_t to = ta_rel(a, n, 1, len, 0), from = ta_rel(a, n, 2, len, 0), fin = ta_rel(a, n, 3, len, len);
  ts_typedarray* x = ta_ptr(t);
  uint32_t count = fin > from ? fin - from : 0;
  if (count > len - to) count = len - to;
  uint32_t sz = g_ta_size[x->elem];
  if (count) memmove(x->data + (size_t)to * sz, x->data + (size_t)from * sz, (size_t)count * sz);
  ts_gc_unroot(1);
  return t;
}
static int ta_same_value_zero(double x, double y){ return x == y || (x != x && y != y); }
static double ta_search_arg(tsv* a, int n, int* is_num){
  *is_num = n > 1 && ts_is_num(a[1]);
  return *is_num ? ts_to_num(a[1]) : 0;
}
static tsv ta_m_index_of(tsv* a, int n){
  tsv t = ta_require(n ? a[0] : TS_UNDEFINED, "indexOf"); ts_gc_root(&t);
  int is_num; double v = ta_search_arg(a, n, &is_num);
  uint32_t len = ta_ptr(t)->length, from = ta_rel(a, n, 2, len, 0);
  double r = -1;
  if (is_num) for (uint32_t i = from; i < ta_ptr(t)->length; i++) if (ta_load(ta_ptr(t), i) == v){ r = i; break; }
  ts_gc_unroot(1);
  return ts_num(r);
}
static tsv ta_m_last_index_of(tsv* a, int n){
  tsv t = ta_require(n ? a[0] : TS_UNDEFINED, "lastIndexOf"); ts_gc_root(&t);
  int is_num; double v = ta_search_arg(a, n, &is_num);
  uint32_t len = ta_ptr(t)->length;
  double r = -1;
  if (is_num && len){
    double start = len - 1;
    if (n > 2 && !ts_is_undef(a[2])){
      double d = ts_number_coerce(a[2]);
      if (d != d) d = 0;
      d = d < 0 ? ceil(d) : floor(d);
      start = d < 0 ? len + d : (d > len - 1 ? len - 1 : d);
    }
    for (double i = start; i >= 0; i--) if (ta_load(ta_ptr(t), (uint32_t)i) == v){ r = i; break; }
  }
  ts_gc_unroot(1);
  return ts_num(r);
}
static tsv ta_m_includes(tsv* a, int n){
  tsv t = ta_require(n ? a[0] : TS_UNDEFINED, "includes"); ts_gc_root(&t);
  int is_num; double v = ta_search_arg(a, n, &is_num);
  uint32_t len = ta_ptr(t)->length, from = ta_rel(a, n, 2, len, 0);
  int r = 0;
  if (is_num) for (uint32_t i = from; i < ta_ptr(t)->length; i++) if (ta_same_value_zero(ta_load(ta_ptr(t), i), v)){ r = 1; break; }
  ts_gc_unroot(1);
  return ts_bool(r);
}
static tsv ta_join(tsv t, tsv sepv){
  ts_gc_root(&t);
  jbuf b; jb_init(&b);
  char* sep = NULL; uint32_t seplen = 1;
  if (!ts_is_undef(sepv)){
    tsv s = ts_to_string_v(sepv);
    sep = ts_str_utf8_copy_view(ts_str_view_typed(s), &seplen);
  }
  uint32_t len = ta_ptr(t)->length;
  for (uint32_t i = 0; i < len && i < ta_ptr(t)->length; i++){
    if (i){ if (sep) jb_puts(&b, sep, seplen); else jb_putc(&b, ','); }
    double d = ta_load(ta_ptr(t), i);
    char nb[40]; ts_fmt_num(d, nb, sizeof nb); jb_putz(&b, nb);
  }
  free(sep);
  tsv r = ts_new_string(b.p ? b.p : "", (uint32_t)b.len);
  jb_free(&b);
  ts_gc_unroot(1);
  return r;
}
static tsv ta_m_join(tsv* a, int n){ return ta_join(ta_require(n ? a[0] : TS_UNDEFINED, "join"), n > 1 ? a[1] : TS_UNDEFINED); }
static tsv ta_m_to_string(tsv* a, int n){ return ta_join(ta_require(n ? a[0] : TS_UNDEFINED, "toString"), TS_UNDEFINED); }
static tsv ta_m_at(tsv* a, int n){
  tsv t = ta_require(n ? a[0] : TS_UNDEFINED, "at");
  double d = n > 1 ? ts_number_coerce(a[1]) : 0;
  if (d != d) d = 0;
  d = d < 0 ? ceil(d) : floor(d);
  uint32_t len = ta_ptr(t)->length;
  if (d < 0) d += len;
  return d < 0 || d >= len ? TS_UNDEFINED : ts_num(ta_load(ta_ptr(t), (uint32_t)d));
}
static tsv ta_m_reverse(tsv* a, int n){
  tsv t = ta_require(n ? a[0] : TS_UNDEFINED, "reverse");
  ts_typedarray* x = ta_ptr(t);
  for (uint32_t i = 0, j = x->length ? x->length - 1 : 0; i < j; i++, j--){
    double p = ta_load(x, i), q = ta_load(x, j);
    ta_store(x, i, q); ta_store(x, j, p);
  }
  return t;
}
static int ta_default_cmp(double x, double y){
  if (x != x) return y != y ? 0 : 1;
  if (y != y) return -1;
  if (x < y) return -1;
  if (x > y) return 1;
  if (x == 0 && y == 0){ int sx = signbit(x) != 0, sy = signbit(y) != 0; return sx == sy ? 0 : (sx ? -1 : 1); }
  return 0;
}
static tsv ta_m_sort(tsv* a, int n){
  tsv t = ta_require(n ? a[0] : TS_UNDEFINED, "sort"); ts_gc_root(&t);
  tsv cmp = n > 1 ? a[1] : TS_UNDEFINED; ts_gc_root(&cmp);
  if (!ts_is_undef(cmp) && !ts_is_callable(cmp)){
    char txt[96], buf[160];
    ta_value_text(cmp, 0, txt, sizeof txt);
    snprintf(buf, sizeof buf, "The comparison function must be either a function or undefined: %s", txt);
    ts_throw_type_error_msg(buf);
  }
  uint32_t len = ta_ptr(t)->length;
  double* v = (double*)malloc(sizeof(double) * (len ? len : 1));
  double* w = (double*)malloc(sizeof(double) * (len ? len : 1));
  for (uint32_t i = 0; i < len; i++) v[i] = ta_load(ta_ptr(t), i);
  /* stable merge sort, bottom-up */
  for (uint32_t width = 1; width < len; width *= 2){
    for (uint32_t lo = 0; lo < len; lo += 2 * width){
      uint32_t mid = lo + width < len ? lo + width : len, hi = lo + 2 * width < len ? lo + 2 * width : len;
      uint32_t i = lo, j = mid, k = lo;
      while (i < mid && j < hi){
        int c;
        if (ts_is_undef(cmp)) c = ta_default_cmp(v[j], v[i]) < 0 ? 1 : 0;
        else {
          tsv args[2] = { ts_num(v[j]), ts_num(v[i]) };
          double r = ts_number_coerce(ts_call(cmp, args, 2));
          c = r < 0;
        }
        if (c) w[k++] = v[j++]; else w[k++] = v[i++];
      }
      while (i < mid) w[k++] = v[i++];
      while (j < hi) w[k++] = v[j++];
    }
    double* s = v; v = w; w = s;
  }
  ts_typedarray* x = ta_ptr(t);
  for (uint32_t i = 0; i < len && i < x->length; i++) ta_store(x, i, v[i]);
  free(v); free(w);
  ts_gc_unroot(2);
  return t;
}
/* V8's text for a value in a TypeError: `typed` names the type first
   ("number 3", "string \"ab\"", "object null", "object"); otherwise the
   value as a string ("3", "ab", "#<Object>", "[object Array]"). */
static void ta_value_text(tsv v, int typed, char* out, size_t cap){
  if (ts_is_undef(v)){ snprintf(out, cap, "undefined"); return; }
  if (ts_is_null(v)){ snprintf(out, cap, typed ? "object null" : "null"); return; }
  if (ts_is_num(v)){
    char num[40]; ts_fmt_num(ts_to_num(v), num, sizeof num);
    snprintf(out, cap, typed ? "number %s" : "%s", num); return;
  }
  if (ts_is_bool(v)){ snprintf(out, cap, typed ? "boolean %s" : "%s", ts_truthy(v) ? "true" : "false"); return; }
  if (ts_is_str(v)){
    ts_strview sv = ts_str_view_typed(v);
    char tmp[64];
    uint32_t len = sv.len < 60u ? sv.len : 60u, o = 0;
    for (uint32_t i = 0; i < len; i++){ uint32_t cu = ts_str_cu_at_view(sv, i); tmp[o++] = cu < 0x80u ? (char)cu : '?'; }
    tmp[o] = 0;
    snprintf(out, cap, typed ? "string \"%s\"" : "%s", tmp); return;
  }
  if (ts_is_symbol(v)){ snprintf(out, cap, typed ? "symbol" : "Symbol()"); return; }
  snprintf(out, cap, "%s", typed ? "object" : ts_is_indexed_array_fast(v) ? "[object Array]" : "#<Object>");
}
static void ta_require_callable(tsv cb, int typed){
  if (ts_is_callable(cb)) return;
  char txt[96], buf[128];
  ta_value_text(cb, typed, txt, sizeof txt);
  snprintf(buf, sizeof buf, "%s is not a function", txt);
  ts_throw_type_error_msg(buf);
}
/* Callback methods: (value, index, array), thisArg through ts_callback_with_this.
   map names a bad callback by its value, the others by its type and value. */
#define TA_CB_BEGIN(name) \
  tsv t = ta_require(n ? a[0] : TS_UNDEFINED, name); ts_gc_root(&t); \
  tsv cb = TS_ITER_CB(a, n); ts_gc_root(&cb); \
  ta_require_callable(cb, strcmp(name, "map") != 0); \
  ts_cb cbf; cb_resolve(&cbf, cb);
static tsv ta_cb_call(ts_cb* cbf, tsv cb, tsv t, uint32_t i){
  tsv args[3] = { ts_num(ta_load(ta_ptr(t), i)), ts_num((double)i), t };
  return cb_call(cbf, cb, args, 3);
}
static tsv ta_m_for_each(tsv* a, int n){
  TA_CB_BEGIN("forEach")
  for (uint32_t i = 0; i < ta_ptr(t)->length; i++) ta_cb_call(&cbf, cb, t, i);
  ts_gc_unroot(2); return TS_UNDEFINED;
}
static tsv ta_m_map(tsv* a, int n){
  TA_CB_BEGIN("map")
  tsv r = ta_new_length(ta_ptr(t)->elem, ta_ptr(t)->length); ts_gc_root(&r);
  for (uint32_t i = 0; i < ta_ptr(t)->length; i++) ts_ta_set(r, i, ta_cb_call(&cbf, cb, t, i));
  ts_gc_unroot(3); return r;
}
static tsv ta_m_filter(tsv* a, int n){
  TA_CB_BEGIN("filter")
  uint32_t len = ta_ptr(t)->length;
  double* kept = (double*)malloc(sizeof(double) * (len ? len : 1)); uint32_t k = 0;
  for (uint32_t i = 0; i < len && i < ta_ptr(t)->length; i++){
    double v = ta_load(ta_ptr(t), i);
    if (ts_truthy(ta_cb_call(&cbf, cb, t, i))) kept[k++] = v;
  }
  tsv r = ta_new_length(ta_ptr(t)->elem, k);
  for (uint32_t i = 0; i < k; i++) ta_store(ta_ptr(r), i, kept[i]);
  free(kept);
  ts_gc_unroot(2); return r;
}
static tsv ta_m_every(tsv* a, int n){
  TA_CB_BEGIN("every")
  int r = 1;
  for (uint32_t i = 0; i < ta_ptr(t)->length; i++) if (!ts_truthy(ta_cb_call(&cbf, cb, t, i))){ r = 0; break; }
  ts_gc_unroot(2); return ts_bool(r);
}
static tsv ta_m_some(tsv* a, int n){
  TA_CB_BEGIN("some")
  int r = 0;
  for (uint32_t i = 0; i < ta_ptr(t)->length; i++) if (ts_truthy(ta_cb_call(&cbf, cb, t, i))){ r = 1; break; }
  ts_gc_unroot(2); return ts_bool(r);
}
static tsv ta_m_find(tsv* a, int n){
  TA_CB_BEGIN("find")
  tsv r = TS_UNDEFINED;
  for (uint32_t i = 0; i < ta_ptr(t)->length; i++){
    double v = ta_load(ta_ptr(t), i);
    if (ts_truthy(ta_cb_call(&cbf, cb, t, i))){ r = ts_num(v); break; }
  }
  ts_gc_unroot(2); return r;
}
static tsv ta_m_find_index(tsv* a, int n){
  TA_CB_BEGIN("findIndex")
  double r = -1;
  for (uint32_t i = 0; i < ta_ptr(t)->length; i++) if (ts_truthy(ta_cb_call(&cbf, cb, t, i))){ r = i; break; }
  ts_gc_unroot(2); return ts_num(r);
}
static tsv ta_m_reduce(tsv* a, int n){
  tsv t = ta_require(n ? a[0] : TS_UNDEFINED, "reduce"); ts_gc_root(&t);
  tsv cb = n > 1 ? a[1] : TS_UNDEFINED; ts_gc_root(&cb);
  ta_require_callable(cb, 1);
  uint32_t i = 0;
  tsv acc = TS_UNDEFINED; ts_gc_root(&acc);
  if (n > 2) acc = a[2];
  else {
    if (ta_ptr(t)->length == 0) ts_throw_type_error_msg("Reduce of empty array with no initial value");
    acc = ts_num(ta_load(ta_ptr(t), 0)); i = 1;
  }
  ts_cb cbf; cb_resolve(&cbf, cb);
  for (; i < ta_ptr(t)->length; i++){
    tsv args[4] = { acc, ts_num(ta_load(ta_ptr(t), i)), ts_num((double)i), t };
    acc = cb_call(&cbf, cb, args, 4);
  }
  ts_gc_unroot(3); return acc;
}
static tsv ta_m_values(tsv* a, int n){ return ts_array_iter_new(ta_require(n ? a[0] : TS_UNDEFINED, "values"), 0); }
static tsv ta_m_keys(tsv* a, int n){ return ts_array_iter_new(ta_require(n ? a[0] : TS_UNDEFINED, "keys"), 1); }
static tsv ta_m_entries(tsv* a, int n){ return ts_array_iter_new(ta_require(n ? a[0] : TS_UNDEFINED, "entries"), 2); }
static tsv ab_m_slice(tsv* a, int n){
  tsv b = n ? a[0] : TS_UNDEFINED;
  if (!ts_is_array_buffer(b)) ts_throw_type_error_msg("ArrayBuffer.prototype.slice called on incompatible receiver");
  ts_gc_root(&b);
  uint32_t len = ((ts_arraybuffer*)ts_ptr(b))->byte_length;
  uint32_t s = ta_rel(a, n, 1, len, 0), e = ta_rel(a, n, 2, len, len);
  uint32_t count = e > s ? e - s : 0;
  tsv r = ta_new_buffer(count, ((ts_arraybuffer*)ts_ptr(b))->shared); 
  if (count) memcpy(((ts_arraybuffer*)ts_ptr(r))->bytes, ((ts_arraybuffer*)ts_ptr(b))->bytes + s, count);
  ts_gc_unroot(1);
  return r;
}
static void ta_proto_method(tsv proto, const char* name, ts_code fn, uint32_t arity){
  tsv fv = ts_make_fn_t(fn, NULL, 0, 1); ts_gc_root(&fv);
  ts_set_fn_meta(fv, arity, name);
  ts_define_data(proto, ts_intern_field(name, (uint32_t)strlen(name)), fv, 0, 1, 1);
  ts_gc_unroot(1);
}
static void ta_protos_init(void){
  if (g_typed_array_proto != TS_NULL) return;
  static int rooted_ta = 0, rooted_ab = 0, rooted_sab = 0, rooted_each[TS_TA_COUNT];
  g_ta_k_length = ts_intern_field("length", 6);
  g_ta_k_byte_length = ts_intern_field("byteLength", 10);
  g_ta_k_byte_offset = ts_intern_field("byteOffset", 10);
  g_ta_k_buffer = ts_intern_field("buffer", 6);
  g_ta_k_bpe = ts_intern_field("BYTES_PER_ELEMENT", 17);
  g_typed_array_proto = ts_new_proto();
  ts_root_static_once(&g_typed_array_proto, &rooted_ta);
  if (ts_proto_ref(g_object_proto_v)) ts_set_proto(g_typed_array_proto, g_object_proto_v);
  tsv p = g_typed_array_proto;
  ta_proto_method(p, "subarray", ta_m_subarray, 2);
  ta_proto_method(p, "slice", ta_m_slice, 2);
  ta_proto_method(p, "set", ta_m_set, 1);
  ta_proto_method(p, "fill", ta_m_fill, 1);
  ta_proto_method(p, "copyWithin", ta_m_copy_within, 2);
  ta_proto_method(p, "indexOf", ta_m_index_of, 1);
  ta_proto_method(p, "lastIndexOf", ta_m_last_index_of, 1);
  ta_proto_method(p, "includes", ta_m_includes, 1);
  ta_proto_method(p, "join", ta_m_join, 1);
  ta_proto_method(p, "toString", ta_m_to_string, 0);
  ta_proto_method(p, "toLocaleString", ta_m_to_string, 0);
  ta_proto_method(p, "at", ta_m_at, 1);
  ta_proto_method(p, "reverse", ta_m_reverse, 0);
  ta_proto_method(p, "sort", ta_m_sort, 1);
  ta_proto_method(p, "forEach", ta_m_for_each, 1);
  ta_proto_method(p, "map", ta_m_map, 1);
  ta_proto_method(p, "filter", ta_m_filter, 1);
  ta_proto_method(p, "every", ta_m_every, 1);
  ta_proto_method(p, "some", ta_m_some, 1);
  ta_proto_method(p, "find", ta_m_find, 1);
  ta_proto_method(p, "findIndex", ta_m_find_index, 1);
  ta_proto_method(p, "reduce", ta_m_reduce, 1);
  ta_proto_method(p, "keys", ta_m_keys, 0);
  ta_proto_method(p, "entries", ta_m_entries, 0);
  ta_proto_method(p, "values", ta_m_values, 0);
  {
    tsv it = ts_make_fn_t(ta_m_values, NULL, 0, 1); ts_gc_root(&it);
    ts_set_fn_meta(it, 0, "values");
    ts_define_data(p, TS_KEY_WKSYM(TS_WKSYM_ITERATOR), it, 0, 1, 1);
    ts_gc_unroot(1);
  }
  for (int e = 0; e < TS_TA_COUNT; e++){
    g_ta_proto[e] = ts_new_proto();
    ts_root_static_once(&g_ta_proto[e], &rooted_each[e]);
    ts_set_proto(g_ta_proto[e], g_typed_array_proto);
    ts_define_data(g_ta_proto[e], g_ta_k_bpe, ts_num((double)g_ta_size[e]), 0, 0, 0);
  }
  g_arraybuffer_proto = ts_new_proto();
  ts_root_static_once(&g_arraybuffer_proto, &rooted_ab);
  g_sab_proto = ts_new_proto();
  ts_root_static_once(&g_sab_proto, &rooted_sab);
  if (ts_proto_ref(g_object_proto_v)){ ts_set_proto(g_arraybuffer_proto, g_object_proto_v); ts_set_proto(g_sab_proto, g_object_proto_v); }
  ta_proto_method(g_arraybuffer_proto, "slice", ab_m_slice, 2);
  ta_proto_method(g_sab_proto, "slice", ab_m_slice, 2);
  ta_ctors_init();
}
/* The prototypes, for `x instanceof Uint8Array` (protoobj.typedarray:N). */
tsv ts_typed_array_proto(int elem){
  ta_protos_init();
  return elem >= 0 && elem < TS_TA_COUNT ? g_ta_proto[elem] : TS_UNDEFINED;
}
tsv ts_array_buffer_proto(int shared){
  ta_protos_init();
  return shared ? g_sab_proto : g_arraybuffer_proto;
}
/* The constructor values (Int8Array .. Float64Array, ArrayBuffer and
   SharedArrayBuffer), made with the prototypes (each prototype's
   `constructor`): their prototypes, BYTES_PER_ELEMENT and the static methods.
   `new T(...)` is lowered statically; calling a constructor value throws, as
   constructing through one does (like the other builtin constructors held as
   values). The program's global object holds them when it reads one. */
static void ta_requires_new(const char* name){
  char buf[96];
  snprintf(buf, sizeof buf, "Constructor %s requires 'new'", name);
  ts_throw_type_error_msg(buf);
}
#define TA_CTOR_ADAPTERS(E) \
  static tsv ta_ctor_call_##E(tsv* a, int n){ (void)a; (void)n; ta_requires_new(g_ta_name[E]); return TS_UNDEFINED; } \
  static tsv ta_static_from_##E(tsv* a, int n){ \
    return ts_typed_array_from(E, n > 0 ? a[0] : TS_UNDEFINED, n > 1 ? a[1] : TS_UNDEFINED, n > 2 ? a[2] : TS_UNDEFINED); } \
  static tsv ta_static_of_##E(tsv* a, int n){ return ts_typed_array_of(E, a, n); }
TA_CTOR_ADAPTERS(0) TA_CTOR_ADAPTERS(1) TA_CTOR_ADAPTERS(2) TA_CTOR_ADAPTERS(3) TA_CTOR_ADAPTERS(4)
TA_CTOR_ADAPTERS(5) TA_CTOR_ADAPTERS(6) TA_CTOR_ADAPTERS(7) TA_CTOR_ADAPTERS(8)
#undef TA_CTOR_ADAPTERS
static const ts_code g_ta_ctor_call[TS_TA_COUNT] = { ta_ctor_call_0, ta_ctor_call_1, ta_ctor_call_2,
  ta_ctor_call_3, ta_ctor_call_4, ta_ctor_call_5, ta_ctor_call_6, ta_ctor_call_7, ta_ctor_call_8 };
static const ts_code g_ta_static_from[TS_TA_COUNT] = { ta_static_from_0, ta_static_from_1, ta_static_from_2,
  ta_static_from_3, ta_static_from_4, ta_static_from_5, ta_static_from_6, ta_static_from_7, ta_static_from_8 };
static const ts_code g_ta_static_of[TS_TA_COUNT] = { ta_static_of_0, ta_static_of_1, ta_static_of_2,
  ta_static_of_3, ta_static_of_4, ta_static_of_5, ta_static_of_6, ta_static_of_7, ta_static_of_8 };
static tsv ab_ctor_call_0(tsv* a, int n){ (void)a; (void)n; ta_requires_new("ArrayBuffer"); return TS_UNDEFINED; }
static tsv ab_ctor_call_1(tsv* a, int n){ (void)a; (void)n; ta_requires_new("SharedArrayBuffer"); return TS_UNDEFINED; }
static tsv ab_static_is_view(tsv* a, int n){ return ts_bool(n > 0 && ts_array_buffer_is_view(a[0])); }
static void ta_static_fn(tsv obj, const char* name, ts_code fn, uint32_t arity){
  tsv fv = ts_make_fn_t(fn, NULL, 0, 0); ts_gc_root(&fv);
  ts_set_fn_meta(fv, arity, name);
  ts_define_data(obj, ts_intern_field(name, (uint32_t)strlen(name)), fv, 0, 1, 1);
  ts_gc_unroot(1);
}
static tsv ta_ctor_value(const char* name, ts_code call, uint32_t arity, tsv proto){
  ts_gc_root(&proto);
  tsv f = ts_make_fn_t(call, NULL, 0, 0); ts_gc_root(&f);
  ts_set_fn_meta(f, arity, name);
  ts_define_data(f, ts_intern_field("prototype", 9), proto, 0, 0, 0);
  ts_define_data(proto, ts_intern_field("constructor", 11), f, 0, 1, 1);
  ts_gc_unroot(2);
  return f;
}
static void ta_ctors_init(void){
  static int rooted_each[TS_TA_COUNT], rooted_ab = 0, rooted_sab = 0;
  for (int e = 0; e < TS_TA_COUNT; e++){
    g_ta_ctor[e] = ta_ctor_value(g_ta_name[e], g_ta_ctor_call[e], 3, g_ta_proto[e]);
    ts_root_static_once(&g_ta_ctor[e], &rooted_each[e]);
    ts_define_data(g_ta_ctor[e], g_ta_k_bpe, ts_num((double)g_ta_size[e]), 0, 0, 0);
    ta_static_fn(g_ta_ctor[e], "from", g_ta_static_from[e], 1);
    ta_static_fn(g_ta_ctor[e], "of", g_ta_static_of[e], 0);
  }
  g_ab_ctor = ta_ctor_value("ArrayBuffer", ab_ctor_call_0, 1, g_arraybuffer_proto);
  ts_root_static_once(&g_ab_ctor, &rooted_ab);
  ta_static_fn(g_ab_ctor, "isView", ab_static_is_view, 1);
  g_sab_ctor = ta_ctor_value("SharedArrayBuffer", ab_ctor_call_1, 1, g_sab_proto);
  ts_root_static_once(&g_sab_ctor, &rooted_sab);
}
/* Atomics (docs/typed_arrays_design.md, TA3). garnet runs one thread, so
   each operation is the plain read-modify-write of the element (no other
   agent can observe a torn or reordered access). ValidateIntegerTypedArray
   (an integer element type; wait and notify Int32 on a shared buffer),
   ValidateAtomicAccess (ToIndex, a RangeError past the end), the operand's
   ToIntegerOrInfinity, then the operation on the element's bits; the old
   value is returned. */
static tsv atomics_tag_text(tsv v, char* out, size_t cap){
  tsv tag = ts_objproto_tostring_call(v);
  uint32_t n; char* c = ts_string_cstr_copy(tag, &n);
  snprintf(out, cap, "%s", c ? c : "[object Object]");
  free(c);
  return tag;
}
static void atomics_view_error(tsv v, const char* what){
  char tag[96], buf[160];
  (void)atomics_tag_text(v, tag, sizeof tag);
  snprintf(buf, sizeof buf, "%s is not %s typed array.", tag, what);
  ts_throw_type_error_msg(buf);
}
static int atomics_integer_elem(int elem){ return elem != TS_TA_UINT8C && elem != TS_TA_FLOAT32 && elem != TS_TA_FLOAT64; }
/* The element index of an access (the view is rooted by the caller). */
static uint32_t atomics_index(tsv ta, tsv index){
  double x = ts_is_num(index) ? ts_to_num(index) : ts_number_coerce(index);
  double d = x != x ? 0 : x < 0 ? ceil(x) : floor(x);
  if (d < 0 || d >= (double)ta_ptr(ta)->length) ts_throw_range_error_msg("Invalid atomic access index");
  return (uint32_t)d;
}
static double atomics_operand(tsv v){
  double x = ts_is_num(v) ? ts_to_num(v) : ts_number_coerce(v);
  if (x != x) return 0;
  if (isinf(x)) return x;
  x = x < 0 ? ceil(x) : floor(x);
  return x == 0 ? 0 : x;     /* ToIntegerOrInfinity: -0 is +0 */
}
static tsv atomics_require(tsv ta){
  if (!ts_is_typed_array(ta) || !atomics_integer_elem(ta_ptr(ta)->elem)) atomics_view_error(ta, "an integer");
  return ta;
}
tsv ts_atomics_load(tsv ta, tsv index){
  ts_gc_root(&ta);
  atomics_require(ta);
  uint32_t i = atomics_index(ta, index);
  ts_gc_unroot(1);
  return ts_num(ta_load(ta_ptr(ta), i));
}
tsv ts_atomics_store(tsv ta, tsv index, tsv value){
  ts_gc_root(&ta);
  atomics_require(ta);
  uint32_t i = atomics_index(ta, index);
  double v = atomics_operand(value);
  ts_gc_unroot(1);
  ta_store(ta_ptr(ta), i, v);
  return ts_num(v);
}
/* op: 0 add, 1 sub, 2 and, 3 or, 4 xor, 5 exchange */
tsv ts_atomics_rmw(int op, tsv ta, tsv index, tsv value){
  ts_gc_root(&ta);
  atomics_require(ta);
  uint32_t i = atomics_index(ta, index);
  double v = atomics_operand(value);
  ts_gc_unroot(1);
  ts_typedarray* t = ta_ptr(ta);
  double old = ta_load(t, i);
  uint32_t a = ts_to_uint32(old), b = ts_to_uint32(v), r;
  switch (op){
    case 0: r = a + b; break;
    case 1: r = a - b; break;
    case 2: r = a & b; break;
    case 3: r = a | b; break;
    case 4: r = a ^ b; break;
    default: r = b; break;
  }
  ta_store(t, i, (double)r);   /* the element conversion keeps the low bits */
  return ts_num(old);
}
tsv ts_atomics_compare_exchange(tsv ta, tsv index, tsv expected, tsv replacement){
  ts_gc_root(&ta); ts_gc_root(&replacement);
  atomics_require(ta);
  uint32_t i = atomics_index(ta, index);
  double e = atomics_operand(expected);
  double r = atomics_operand(replacement);
  ts_gc_unroot(2);
  ts_typedarray* t = ta_ptr(ta);
  double old = ta_load(t, i);
  /* compare the element's bytes with the expected value converted to the
     element type */
  uint8_t probe[8];
  ts_ta_elem_store(probe, 0, e, t->elem);
  if (memcmp(probe, t->data + (size_t)i * g_ta_size[t->elem], g_ta_size[t->elem]) == 0) ta_store(t, i, r);
  return ts_num(old);
}
tsv ts_atomics_is_lock_free(tsv n){
  double d = atomics_operand(n);
  return ts_bool(d == 1 || d == 2 || d == 4 || d == 8);
}
static tsv atomics_waitable(tsv ta){
  if (!ts_is_typed_array(ta) || ta_ptr(ta)->elem != TS_TA_INT32) atomics_view_error(ta, "an int32 or BigInt64");
  return ta;
}
/* Atomics.wait: nothing else can notify the one thread. A value that differs
   answers "not-equal"; a finite timeout elapses and answers "timed-out"; an
   unbounded wait could never end and throws instead of hanging. */
tsv ts_atomics_wait(tsv ta, tsv index, tsv value, tsv timeout){
  ts_gc_root(&ta); ts_gc_root(&timeout);
  atomics_waitable(ta);
  if (!((ts_arraybuffer*)ts_ptr(ta_ptr(ta)->buffer))->shared) atomics_view_error(ta, "a shared");
  uint32_t i = atomics_index(ta, index);
  double v = atomics_operand(value);
  double ms = ts_is_undef(timeout) ? INFINITY : (ts_is_num(timeout) ? ts_to_num(timeout) : ts_number_coerce(timeout));
  ts_gc_unroot(2);
  ts_typedarray* t = ta_ptr(ta);
  int32_t cur; memcpy(&cur, t->data + (size_t)i * 4u, 4);
  if (cur != ts_to_int32(v)) return ts_new_string("not-equal", 9);
  if (ms != ms) ms = INFINITY;
  if (ms == INFINITY) ts_throw_type_error_msg("Atomics.wait would never end: no other thread can notify it");
  if (ms > 0){
    struct timespec req; req.tv_sec = (time_t)(ms / 1000.0); req.tv_nsec = (long)(fmod(ms, 1000.0) * 1e6);
    nanosleep(&req, NULL);
  }
  return ts_new_string("timed-out", 9);
}
tsv ts_atomics_notify(tsv ta, tsv index, tsv count){
  (void)count;
  ts_gc_root(&ta);
  atomics_waitable(ta);
  (void)atomics_index(ta, index);
  ts_gc_unroot(1);
  return ts_num(0);           /* no thread waits */
}
/* ---------------- TextEncoder / TextDecoder (docs/text_codecs_design.md) ----
   Plain objects with their prototypes; a decoder keeps its encoding (0 UTF-8,
   1 UTF-16LE, 2 UTF-16BE), fatal and ignoreBOM in hidden fields. */
static tsv g_te_proto = TS_NULL, g_td_proto = TS_NULL;
static tsv g_te_ctor = TS_UNDEFINED, g_td_ctor = TS_UNDEFINED;
static ts_key g_tc_k_brand, g_tc_k_enc, g_tc_k_fatal, g_tc_k_bom;
static void text_codecs_init(void);
/* The UTF-8 form of a string's units, a lone surrogate as U+FFFD: writes
   whole code points while they fit in `cap` bytes (out NULL measures); *read
   is the units consumed. */
static uint32_t utf8_encode_view(ts_strview v, uint8_t* out, uint32_t cap, uint32_t* read){
  uint32_t o = 0, i = 0;
  while (i < v.len){
    uint32_t cp = ts_str_cu_at_view(v, i), units = 1;
    if (cp >= 0xD800u && cp <= 0xDBFFu && i + 1 < v.len){
      uint32_t lo = ts_str_cu_at_view(v, i + 1);
      if (lo >= 0xDC00u && lo <= 0xDFFFu){ cp = 0x10000u + ((cp - 0xD800u) << 10) + (lo - 0xDC00u); units = 2; }
    }
    if (cp >= 0xD800u && cp <= 0xDFFFu) cp = 0xFFFDu;
    uint32_t n = cp < 0x80u ? 1 : cp < 0x800u ? 2 : cp < 0x10000u ? 3 : 4;
    if (o + n > cap) break;
    if (out){
      if (n == 1) out[o] = (uint8_t)cp;
      else if (n == 2){ out[o] = (uint8_t)(0xC0u | (cp >> 6)); out[o + 1] = (uint8_t)(0x80u | (cp & 0x3Fu)); }
      else if (n == 3){ out[o] = (uint8_t)(0xE0u | (cp >> 12)); out[o + 1] = (uint8_t)(0x80u | ((cp >> 6) & 0x3Fu)); out[o + 2] = (uint8_t)(0x80u | (cp & 0x3Fu)); }
      else { out[o] = (uint8_t)(0xF0u | (cp >> 18)); out[o + 1] = (uint8_t)(0x80u | ((cp >> 12) & 0x3Fu)); out[o + 2] = (uint8_t)(0x80u | ((cp >> 6) & 0x3Fu)); out[o + 3] = (uint8_t)(0x80u | (cp & 0x3Fu)); }
    }
    o += n; i += units;
  }
  if (read) *read = i;
  return o;
}
/* A string from UTF-16 units: one byte each when all are Latin-1. */
static tsv string_from_units(const uint16_t* u, uint32_t n){
  int latin1 = 1, ascii = 1;
  for (uint32_t i = 0; i < n; i++){ if (u[i] > 0x7Fu) ascii = 0; if (u[i] > 0xFFu){ latin1 = 0; break; } }
  if (ascii && n <= TS_SHORTSTR_MAX){
    char tmp[TS_SHORTSTR_MAX];
    for (uint32_t i = 0; i < n; i++) tmp[i] = (char)u[i];
    return ts_short_str_ascii(tmp, n);
  }
  uint32_t flags = latin1 ? 0u : TS_STR_FLAG_UTF16;
  ts_string* str = ts_string_alloc_storage(n, flags);
  for (uint32_t i = 0; i < n; i++){
    if (latin1) str->data[i] = (char)(uint8_t)u[i];
    else ts_str_cu_set(str->data, flags, i, u[i]);
  }
  str->flags = strflags_storage(str->data, flags, n);
  str->hash = strhash_units(str->data, str->flags, n);
  return ts_str_v(str);
}
/* node's description of a bad argument (ERR_INVALID_ARG_TYPE's "Received ..."). */
static void tc_received(tsv v, char* out, size_t cap){
  if (ts_is_undef(v)){ snprintf(out, cap, "Received undefined"); return; }
  if (ts_is_null(v)){ snprintf(out, cap, "Received null"); return; }
  if (ts_is_num(v)){ char num[40]; ts_fmt_num(ts_to_num(v), num, sizeof num); snprintf(out, cap, "Received type number (%s)", num); return; }
  if (ts_is_bool(v)){ snprintf(out, cap, "Received type boolean (%s)", ts_truthy(v) ? "true" : "false"); return; }
  if (ts_is_str(v)){
    uint32_t n; char* c = ts_string_cstr_copy(v, &n);
    if (c && n > 28){ c[25] = 0; snprintf(out, cap, "Received type string ('%s...')", c); }
    else snprintf(out, cap, "Received type string ('%s')", c ? c : "");
    free(c); return;
  }
  if (ts_is_symbol(v)){ snprintf(out, cap, "Received type symbol"); return; }
  if (ts_is_func(v)){ snprintf(out, cap, "Received function"); return; }
  char tag[96]; tsv t = ts_objproto_tostring_call(v);
  uint32_t n; char* c = ts_string_cstr_copy(t, &n);
  snprintf(tag, sizeof tag, "%s", c ? c : "[object Object]"); free(c);
  size_t tl = strlen(tag);
  if (tl > 9 && tag[tl - 1] == ']'){ tag[tl - 1] = 0; snprintf(out, cap, "Received an instance of %s", tag + 8); }
  else snprintf(out, cap, "Received an instance of Object");
}
static void tc_bad_this(const char* type){
  char buf[96]; snprintf(buf, sizeof buf, "Value of \"this\" must be of type %s", type);
  ts_throw_type_error_msg(buf);
}
static int tc_has_brand(tsv v, ts_key key){
  return ts_is_obj(v) && ((ts_gc_header*)ts_ptr(v))->kind == TS_KIND_OBJECT && find_slot((ts_object*)ts_ptr(v), key, 0) != NULL;
}
static tsv tc_hidden(tsv obj, ts_key key){
  tsv* slot = find_slot((ts_object*)ts_ptr(obj), key, 0);
  return slot ? *slot : TS_UNDEFINED;
}
tsv ts_text_encoder_new(void){
  text_codecs_init();
  tsv o = ts_new_object(); ts_gc_root(&o);
  ts_set_proto(o, g_te_proto);
  ts_define_data(o, g_tc_k_brand, ts_bool(1), 0, 0, 0);
  ts_gc_unroot(1);
  return o;
}
/* encode(input = ""): the UTF-8 bytes in a new Uint8Array. */
static tsv te_m_encode(tsv* a, int n){
  if (!tc_has_brand(n ? a[0] : TS_UNDEFINED, g_tc_k_brand)) tc_bad_this("TextEncoder");
  tsv str = n > 1 && !ts_is_undef(a[1]) ? ts_to_string_v(a[1]) : ts_new_string("", 0);
  ts_gc_root(&str);
  uint32_t len = utf8_encode_view(ts_str_view_typed(str), NULL, UINT32_MAX, NULL);
  tsv out = ta_new_length(TS_TA_UINT8, len); ts_gc_root(&out);
  (void)utf8_encode_view(ts_str_view_typed(str), ta_ptr(out)->data, len, NULL);
  ts_gc_unroot(2);
  return out;
}
/* encodeInto(source, destination): whole code points while they fit;
   { read, written }. */
static tsv te_m_encode_into(tsv* a, int n){
  if (!tc_has_brand(n ? a[0] : TS_UNDEFINED, g_tc_k_brand)) tc_bad_this("TextEncoder");
  tsv dst = n > 2 ? a[2] : TS_UNDEFINED; ts_gc_root(&dst);
  if (!ts_is_typed_array(dst) || ta_ptr(dst)->elem != TS_TA_UINT8){
    char rec[160], buf[256]; tc_received(dst, rec, sizeof rec);
    snprintf(buf, sizeof buf, "The \"dest\" argument must be an instance of Uint8Array. %s", rec);
    ts_throw_type_error_msg(buf);
  }
  tsv str = ts_to_string_v(n > 1 ? a[1] : TS_UNDEFINED); ts_gc_root(&str);
  uint32_t read = 0;
  uint32_t written = utf8_encode_view(ts_str_view_typed(str), ta_ptr(dst)->data, ta_ptr(dst)->length, &read);
  tsv r = ts_new_object(); ts_gc_root(&r);
  ts_set(r, ts_intern_field("read", 4), ts_num((double)read));
  ts_set(r, ts_intern_field("written", 7), ts_num((double)written));
  ts_gc_unroot(3);
  return r;
}
static tsv te_g_encoding(tsv* a, int n){
  if (!tc_has_brand(n ? a[0] : TS_UNDEFINED, g_tc_k_brand)) tc_bad_this("TextEncoder");
  return ts_new_string("utf-8", 5);
}
/* new TextDecoder(label, options): the label trimmed and ASCII-case-folded. */
tsv ts_text_decoder_new(tsv label, tsv options){
  text_codecs_init();
  ts_gc_root(&label); ts_gc_root(&options);
  int enc = 0;
  if (!ts_is_undef(label)){
    tsv ls = ts_to_string_v(label); ts_gc_root(&ls);
    ts_strview v = ts_str_view_typed(ls);
    uint32_t b = 0, e = v.len;
    #define TC_ASCII_WS(cu) ((cu) == 0x09u || (cu) == 0x0Au || (cu) == 0x0Cu || (cu) == 0x0Du || (cu) == 0x20u)
    while (b < e && TC_ASCII_WS(ts_str_cu_at_view(v, b))) b++;
    while (e > b && TC_ASCII_WS(ts_str_cu_at_view(v, e - 1))) e--;
    #undef TC_ASCII_WS
    char name[40]; uint32_t k = 0; int ok = e - b < sizeof name;
    for (uint32_t i = b; ok && i < e; i++){
      uint32_t cu = ts_str_cu_at_view(v, i);
      if (cu >= 0x80u){ ok = 0; break; }
      name[k++] = (char)(cu >= 'A' && cu <= 'Z' ? cu + 32 : cu);
    }
    name[k] = 0;
    static const char* const utf8[] = { "unicode-1-1-utf-8", "unicode11utf8", "unicode20utf8", "utf-8", "utf8", "x-unicode20utf8" };
    static const char* const utf16le[] = { "csunicode", "iso-10646-ucs-2", "ucs-2", "unicode", "unicodefeff", "utf-16", "utf-16le" };
    static const char* const utf16be[] = { "unicodefffe", "utf-16be" };
    enc = -1;
    if (ok){
      for (size_t i = 0; i < sizeof utf8 / sizeof *utf8; i++) if (!strcmp(name, utf8[i])) enc = 0;
      for (size_t i = 0; i < sizeof utf16le / sizeof *utf16le; i++) if (!strcmp(name, utf16le[i])) enc = 1;
      for (size_t i = 0; i < sizeof utf16be / sizeof *utf16be; i++) if (!strcmp(name, utf16be[i])) enc = 2;
    }
    if (enc < 0){
      uint32_t sl; char* sc = ts_string_cstr_copy(ls, &sl);
      char buf[200]; snprintf(buf, sizeof buf, "The \"%s\" encoding is not supported", sc ? sc : "?");
      free(sc);
      ts_throw_range_error_msg(buf);
    }
    ts_gc_unroot(1);
  }
  int fatal = 0, bom = 0;
  if (!ts_is_undef(options) && !ts_is_null(options)){
    if (!ts_object_like(options)){
      char rec[160], buf[256]; tc_received(options, rec, sizeof rec);
      snprintf(buf, sizeof buf, "The \"options\" argument must be of type object. %s", rec);
      ts_throw_type_error_msg(buf);
    }
    fatal = ts_truthy(ts_get(options, ts_intern_field("fatal", 5)));
    bom = ts_truthy(ts_get(options, ts_intern_field("ignoreBOM", 9)));
  }
  tsv o = ts_new_object(); ts_gc_root(&o);
  ts_set_proto(o, g_td_proto);
  ts_define_data(o, g_tc_k_enc, ts_num((double)enc), 0, 0, 0);
  ts_define_data(o, g_tc_k_fatal, ts_bool(fatal), 0, 0, 0);
  ts_define_data(o, g_tc_k_bom, ts_bool(bom), 0, 0, 0);
  ts_gc_unroot(3);
  return o;
}
static void td_invalid(int enc){
  ts_throw_type_error_msg(enc == 0 ? "The encoded data was not valid for encoding utf-8"
                                   : enc == 1 ? "The encoded data was not valid for encoding utf-16le"
                                              : "The encoded data was not valid for encoding utf-16be");
}
/* The standard's UTF-8 decoder: each maximal invalid subpart one U+FFFD. */
static uint32_t td_decode_utf8(const uint8_t* b, uint32_t n, uint16_t* u, int fatal){
  uint32_t o = 0, cp = 0, needed = 0, seen = 0, lower = 0x80u, upper = 0xBFu;
  for (uint32_t i = 0; i < n; i++){
    uint32_t x = b[i];
    if (needed == 0){
      if (x <= 0x7Fu){ u[o++] = (uint16_t)x; continue; }
      if (x >= 0xC2u && x <= 0xDFu){ needed = 1; cp = x & 0x1Fu; }
      else if (x >= 0xE0u && x <= 0xEFu){ if (x == 0xE0u) lower = 0xA0u; if (x == 0xEDu) upper = 0x9Fu; needed = 2; cp = x & 0xFu; }
      else if (x >= 0xF0u && x <= 0xF4u){ if (x == 0xF0u) lower = 0x90u; if (x == 0xF4u) upper = 0x8Fu; needed = 3; cp = x & 0x7u; }
      else { if (fatal) td_invalid(0); u[o++] = 0xFFFDu; }
      continue;
    }
    if (x < lower || x > upper){
      cp = needed = seen = 0; lower = 0x80u; upper = 0xBFu;
      if (fatal) td_invalid(0);
      u[o++] = 0xFFFDu;
      i--;                    /* the byte starts again */
      continue;
    }
    lower = 0x80u; upper = 0xBFu;
    cp = (cp << 6) | (x & 0x3Fu);
    if (++seen != needed) continue;
    if (cp > 0xFFFFu){ cp -= 0x10000u; u[o++] = (uint16_t)(0xD800u + (cp >> 10)); u[o++] = (uint16_t)(0xDC00u + (cp & 0x3FFu)); }
    else u[o++] = (uint16_t)cp;
    cp = needed = seen = 0;
  }
  if (needed){ if (fatal) td_invalid(0); u[o++] = 0xFFFDu; }
  return o;
}
/* The standard's UTF-16 decoder: an unpaired surrogate or an odd last byte
   is U+FFFD. */
static uint32_t td_decode_utf16(const uint8_t* b, uint32_t n, uint16_t* u, int be, int fatal){
  uint32_t o = 0; int lead = -1;
  uint32_t i = 0;
  for (; i + 1 < n; i += 2){
    uint32_t cu = be ? ((uint32_t)b[i] << 8) | b[i + 1] : b[i] | ((uint32_t)b[i + 1] << 8);
    if (lead >= 0){
      if (cu >= 0xDC00u && cu <= 0xDFFFu){ u[o++] = (uint16_t)lead; u[o++] = (uint16_t)cu; lead = -1; continue; }
      lead = -1;
      if (fatal) td_invalid(be ? 2 : 1);
      u[o++] = 0xFFFDu;
    }
    if (cu >= 0xD800u && cu <= 0xDBFFu){ lead = (int)cu; continue; }
    if (cu >= 0xDC00u && cu <= 0xDFFFu){ if (fatal) td_invalid(be ? 2 : 1); u[o++] = 0xFFFDu; continue; }
    u[o++] = (uint16_t)cu;
  }
  if (lead >= 0 || i < n){ if (fatal) td_invalid(be ? 2 : 1); u[o++] = 0xFFFDu; }
  return o;
}
/* decode(input, options) */
static tsv td_m_decode(tsv* a, int n){
  tsv self = n ? a[0] : TS_UNDEFINED;
  if (!tc_has_brand(self, g_tc_k_enc)) tc_bad_this("TextDecoder");
  tsv input = n > 1 ? a[1] : TS_UNDEFINED, options = n > 2 ? a[2] : TS_UNDEFINED;
  ts_gc_root(&self); ts_gc_root(&input);
  if (!ts_is_undef(options) && !ts_is_null(options) && ts_object_like(options) &&
      ts_truthy(ts_get(options, ts_intern_field("stream", 6))))
    ts_throw_type_error_msg("TextDecoder streaming (decode with { stream: true }) is not supported");
  int enc = (int)ts_to_num(tc_hidden(self, g_tc_k_enc));
  int fatal = ts_truthy(tc_hidden(self, g_tc_k_fatal));
  int keep_bom = ts_truthy(tc_hidden(self, g_tc_k_bom));
  const uint8_t* bytes = NULL; uint32_t len = 0;
  if (ts_is_undef(input)){ bytes = NULL; len = 0; }
  else if (ts_is_array_buffer(input)){ ts_arraybuffer* ab = (ts_arraybuffer*)ts_ptr(input); bytes = ab->bytes; len = ab->byte_length; }
  else if (ts_is_typed_array(input)){ ts_typedarray* t = ta_ptr(input); bytes = t->data; len = t->length * g_ta_size[t->elem]; }
  else ts_throw_type_error_msg("The \"list\" argument must be an instance of SharedArrayBuffer, ArrayBuffer or ArrayBufferView.");
  /* the byte order mark */
  if (!keep_bom && bytes){
    if (enc == 0 && len >= 3 && bytes[0] == 0xEFu && bytes[1] == 0xBBu && bytes[2] == 0xBFu){ bytes += 3; len -= 3; }
    else if (enc == 1 && len >= 2 && bytes[0] == 0xFFu && bytes[1] == 0xFEu){ bytes += 2; len -= 2; }
    else if (enc == 2 && len >= 2 && bytes[0] == 0xFEu && bytes[1] == 0xFFu){ bytes += 2; len -= 2; }
  }
  /* the bytes are outside the heap and their buffer is rooted: they stay put */
  uint16_t stackbuf[256];
  uint16_t* u = len + 1 <= 256 ? stackbuf : (uint16_t*)malloc(sizeof(uint16_t) * ((size_t)len + 1));
  uint32_t units = enc == 0 ? td_decode_utf8(bytes, len, u, fatal) : td_decode_utf16(bytes, len, u, enc == 2, fatal);
  tsv r = string_from_units(u, units);
  if (u != stackbuf) free(u);
  ts_gc_unroot(2);
  return r;
}
static tsv td_g_encoding(tsv* a, int n){
  tsv self = n ? a[0] : TS_UNDEFINED;
  if (!tc_has_brand(self, g_tc_k_enc)) tc_bad_this("TextDecoder");
  int enc = (int)ts_to_num(tc_hidden(self, g_tc_k_enc));
  return enc == 0 ? ts_new_string("utf-8", 5) : enc == 1 ? ts_new_string("utf-16le", 8) : ts_new_string("utf-16be", 8);
}
static tsv td_g_fatal(tsv* a, int n){
  tsv self = n ? a[0] : TS_UNDEFINED;
  if (!tc_has_brand(self, g_tc_k_enc)) tc_bad_this("TextDecoder");
  return ts_bool(ts_truthy(tc_hidden(self, g_tc_k_fatal)));
}
static tsv td_g_ignore_bom(tsv* a, int n){
  tsv self = n ? a[0] : TS_UNDEFINED;
  if (!tc_has_brand(self, g_tc_k_enc)) tc_bad_this("TextDecoder");
  return ts_bool(ts_truthy(tc_hidden(self, g_tc_k_bom)));
}
static void tc_getter(tsv proto, const char* name, ts_code fn){
  tsv g = ts_make_fn_t(fn, NULL, 0, 1); ts_gc_root(&g);
  char nm[40]; snprintf(nm, sizeof nm, "get %s", name);
  ts_set_fn_meta(g, 0, nm);
  ts_define_accessor_attr(proto, ts_intern_field(name, (uint32_t)strlen(name)), g, TS_UNDEFINED, 1, 0, 1, 1);
  ts_gc_unroot(1);
}
static tsv tc_ctor_call_encoder(tsv* a, int n){ (void)a; (void)n; ta_requires_new("TextEncoder"); return TS_UNDEFINED; }
static tsv tc_ctor_call_decoder(tsv* a, int n){ (void)a; (void)n; ta_requires_new("TextDecoder"); return TS_UNDEFINED; }
static void text_codecs_init(void){
  if (g_te_proto != TS_NULL) return;
  static int rooted_te = 0, rooted_td = 0, rooted_tec = 0, rooted_tdc = 0;
  g_tc_k_brand = ts_intern_field("__text_encoder", 14);
  g_tc_k_enc = ts_intern_field("__text_decoder_encoding", 23);
  g_tc_k_fatal = ts_intern_field("__text_decoder_fatal", 20);
  g_tc_k_bom = ts_intern_field("__text_decoder_ignore_bom", 25);
  g_te_proto = ts_new_proto(); ts_root_static_once(&g_te_proto, &rooted_te);
  g_td_proto = ts_new_proto(); ts_root_static_once(&g_td_proto, &rooted_td);
  if (ts_proto_ref(g_object_proto_v)){ ts_set_proto(g_te_proto, g_object_proto_v); ts_set_proto(g_td_proto, g_object_proto_v); }
  ta_proto_method(g_te_proto, "encode", te_m_encode, 0);
  ta_proto_method(g_te_proto, "encodeInto", te_m_encode_into, 2);
  tc_getter(g_te_proto, "encoding", te_g_encoding);
  ta_proto_method(g_td_proto, "decode", td_m_decode, 0);
  tc_getter(g_td_proto, "encoding", td_g_encoding);
  tc_getter(g_td_proto, "fatal", td_g_fatal);
  tc_getter(g_td_proto, "ignoreBOM", td_g_ignore_bom);
  { tsv tag = ts_new_string("TextEncoder", 11); ts_gc_root(&tag);
    ts_define_data(g_te_proto, TS_KEY_WKSYM(TS_WKSYM_TO_STRING_TAG), tag, 0, 0, 1); ts_gc_unroot(1); }
  { tsv tag = ts_new_string("TextDecoder", 11); ts_gc_root(&tag);
    ts_define_data(g_td_proto, TS_KEY_WKSYM(TS_WKSYM_TO_STRING_TAG), tag, 0, 0, 1); ts_gc_unroot(1); }
  g_te_ctor = ta_ctor_value("TextEncoder", tc_ctor_call_encoder, 0, g_te_proto);
  ts_root_static_once(&g_te_ctor, &rooted_tec);
  g_td_ctor = ta_ctor_value("TextDecoder", tc_ctor_call_decoder, 0, g_td_proto);
  ts_root_static_once(&g_td_ctor, &rooted_tdc);
}
tsv ts_text_encoder_proto(void){ text_codecs_init(); return g_te_proto; }
tsv ts_text_decoder_proto(void){ text_codecs_init(); return g_td_proto; }
/* The Atomics namespace as a value (its functions, named as calls, lower to
   the builtins above). */
#define ATOMICS_ARG(i) (n > (i) ? a[i] : TS_UNDEFINED)
static tsv atomics_m_load(tsv* a, int n){ return ts_atomics_load(ATOMICS_ARG(0), ATOMICS_ARG(1)); }
static tsv atomics_m_store(tsv* a, int n){ return ts_atomics_store(ATOMICS_ARG(0), ATOMICS_ARG(1), ATOMICS_ARG(2)); }
static tsv atomics_m_add(tsv* a, int n){ return ts_atomics_rmw(0, ATOMICS_ARG(0), ATOMICS_ARG(1), ATOMICS_ARG(2)); }
static tsv atomics_m_sub(tsv* a, int n){ return ts_atomics_rmw(1, ATOMICS_ARG(0), ATOMICS_ARG(1), ATOMICS_ARG(2)); }
static tsv atomics_m_and(tsv* a, int n){ return ts_atomics_rmw(2, ATOMICS_ARG(0), ATOMICS_ARG(1), ATOMICS_ARG(2)); }
static tsv atomics_m_or(tsv* a, int n){ return ts_atomics_rmw(3, ATOMICS_ARG(0), ATOMICS_ARG(1), ATOMICS_ARG(2)); }
static tsv atomics_m_xor(tsv* a, int n){ return ts_atomics_rmw(4, ATOMICS_ARG(0), ATOMICS_ARG(1), ATOMICS_ARG(2)); }
static tsv atomics_m_exchange(tsv* a, int n){ return ts_atomics_rmw(5, ATOMICS_ARG(0), ATOMICS_ARG(1), ATOMICS_ARG(2)); }
static tsv atomics_m_compare_exchange(tsv* a, int n){ return ts_atomics_compare_exchange(ATOMICS_ARG(0), ATOMICS_ARG(1), ATOMICS_ARG(2), ATOMICS_ARG(3)); }
static tsv atomics_m_is_lock_free(tsv* a, int n){ return ts_atomics_is_lock_free(ATOMICS_ARG(0)); }
static tsv atomics_m_wait(tsv* a, int n){ return ts_atomics_wait(ATOMICS_ARG(0), ATOMICS_ARG(1), ATOMICS_ARG(2), ATOMICS_ARG(3)); }
static tsv atomics_m_notify(tsv* a, int n){ return ts_atomics_notify(ATOMICS_ARG(0), ATOMICS_ARG(1), ATOMICS_ARG(2)); }
#undef ATOMICS_ARG
void ts_typed_array_globals(void){
  ta_protos_init();
  for (int e = 0; e < TS_TA_COUNT; e++) ts_global_set(g_ta_name[e], g_ta_ctor[e]);
  ts_global_set("ArrayBuffer", g_ab_ctor);
  ts_global_set("SharedArrayBuffer", g_sab_ctor);
  tsv at = ts_new_object(); ts_gc_root(&at);
  ta_static_fn(at, "load", atomics_m_load, 2);
  ta_static_fn(at, "store", atomics_m_store, 3);
  ta_static_fn(at, "add", atomics_m_add, 3);
  ta_static_fn(at, "sub", atomics_m_sub, 3);
  ta_static_fn(at, "and", atomics_m_and, 3);
  ta_static_fn(at, "or", atomics_m_or, 3);
  ta_static_fn(at, "xor", atomics_m_xor, 3);
  ta_static_fn(at, "exchange", atomics_m_exchange, 3);
  ta_static_fn(at, "compareExchange", atomics_m_compare_exchange, 4);
  ta_static_fn(at, "isLockFree", atomics_m_is_lock_free, 1);
  ta_static_fn(at, "wait", atomics_m_wait, 4);
  ta_static_fn(at, "notify", atomics_m_notify, 3);
  tsv tag = ts_new_string("Atomics", 7); ts_gc_root(&tag);
  ts_define_data(at, TS_KEY_WKSYM(TS_WKSYM_TO_STRING_TAG), tag, 0, 0, 1);
  ts_global_set("Atomics", at);
  ts_gc_unroot(2);
  text_codecs_init();
  ts_global_set("TextEncoder", g_te_ctor);
  ts_global_set("TextDecoder", g_td_ctor);
}
/* Canonical numeric string keys of a view (integer-indexed exotic): an index,
   or another numeric string such as "-0" or "1.5" that names no element. */
static int ta_numeric_key(ts_key key, uint32_t* idx){
  if (prop_key_is_array_index(key, idx)) return 1;
  const char* nm = ts_field_name(key);
  if (!nm || key >= TS_METHOD_KEY_BASE) return 0;
  /* a canonical numeric string begins with a digit, `-`, `I` (Infinity) or
     `N` (NaN): any other name (`length`, `subarray`) is not one */
  if (!((nm[0] >= '0' && nm[0] <= '9') || nm[0] == '-' || nm[0] == 'I' || nm[0] == 'N')) return 0;
  uint32_t len = ts_field_name_len(key);
  if (len == 2 && nm[0] == '-' && nm[1] == '0'){ *idx = UINT32_MAX; return 1; }
  if (len == 0 || len > 30) return 0;
  for (uint32_t i = 0; i < len; i++) if ((unsigned char)nm[i] >= 0x80u) return 0;
  ts_strview sv; memset(&sv, 0, sizeof sv);
  sv.data = nm; sv.len = len; sv.flags = TS_STR_FLAG_ASCII;
  double d = js_string_to_number_view(sv);       /* no allocation */
  char back[40]; ts_fmt_num(d, back, sizeof back);
  if (strlen(back) != len || memcmp(back, nm, len) != 0) return 0;
  *idx = UINT32_MAX;     /* numeric but not an index: no element */
  return 1;
}
/* An own slot's value for a read (an accessor runs its getter on the receiver). */
static tsv ta_slot_value(tsv recv, tsv slot){
  if (!is_accessor(slot)) return slot;
  ts_accessor* ac = (ts_accessor*)ts_ptr(slot);
  if (!ts_is_func(ac->getter)) return TS_UNDEFINED;
  if (ac->g_this){ tsv a0 = recv; return ts_call(ac->getter, &a0, 1); }
  return ts_call(ac->getter, NULL, 0);
}
/* ts_get of a view: elements, the prototype's accessors, then properties. */
static tsv ta_get_key(tsv obj, ts_key key){
  uint32_t idx;
  int numeric = ta_numeric_key(key, &idx);
  ts_typedarray* t = ta_ptr(obj);
  if (numeric) return idx < t->length ? ts_num(ta_load(t, idx)) : TS_UNDEFINED;
  tsv* own = find_slot(&t->o, key, 0);
  if (own) return ta_slot_value(obj, *own);
  if (key == g_ta_k_length) return ts_num((double)t->length);
  if (key == g_ta_k_byte_length) return ts_num((double)t->length * g_ta_size[t->elem]);
  if (key == g_ta_k_byte_offset) return ts_num((double)t->byte_offset);
  if (key == g_ta_k_buffer) return t->buffer;
  if (key == TS_KEY_WKSYM(TS_WKSYM_TO_STRING_TAG)) return ts_new_string(g_ta_name[t->elem], (uint32_t)strlen(g_ta_name[t->elem]));
  tsv found;
  if (lookup_prop_chain(obj, ts_next_proto(&t->o), key, &found)) return found;
  return TS_UNDEFINED;
}
static tsv ab_get_key(tsv obj, ts_key key){
  ts_arraybuffer* b = (ts_arraybuffer*)ts_ptr(obj);
  tsv* own = find_slot(&b->o, key, 0);
  if (own) return ta_slot_value(obj, *own);
  if (key == g_ta_k_byte_length) return ts_num((double)b->byte_length);
  if (key == TS_KEY_WKSYM(TS_WKSYM_TO_STRING_TAG)) return b->shared ? ts_new_string("SharedArrayBuffer", 17) : ts_new_string("ArrayBuffer", 11);
  tsv found;
  if (lookup_prop_chain(obj, ts_next_proto(&b->o), key, &found)) return found;
  return TS_UNDEFINED;
}
/* ts_set of a view: elements (a non-index numeric key converts and drops the
   value), the read-only accessors (strict TypeError), then properties. */
static void ta_set_key(tsv obj, ts_key key, tsv val){
  uint32_t idx;
  if (ta_numeric_key(key, &idx)){
    if (idx != UINT32_MAX){ ts_ta_set(obj, idx, val); return; }
    (void)ts_number_coerce(val);
    return;
  }
  if (key == g_ta_k_length || key == g_ta_k_byte_length || key == g_ta_k_byte_offset || key == g_ta_k_buffer){
    if (!find_slot(&ta_ptr(obj)->o, key, 0)){
      const char* nm = ts_field_name(key);
      char buf[160];
      snprintf(buf, sizeof buf, "Cannot set property %s of [object Object] which has only a getter", nm ? nm : "?");
      ts_throw_type_error_msg(buf);
    }
  }
  (void)ts_set_named_prop(obj, &ta_ptr(obj)->o, key, val, 0);
}

/* ---- Map.prototype / Set.prototype methods (this = args[0]) ----
   Same mechanism as Array.prototype: thin ts_code wrappers so a dynamic
   m.get()/s.has() (e.g. on an any-typed Map/Set) resolves through the prototype
   chain to the static builtins. The size accessor also supports generic reads
   and optional chains, which use the ordinary property lookup path. */
static tsv ts_mapproto_size(tsv* a, int n){
  if (!n || !ts_is_map(a[0])) ts_throw_type_error_msg("Map size getter called on incompatible receiver");
  return ts_num(ts_map_size(a[0]));
}
static tsv ts_setproto_size(tsv* a, int n){
  if (!n || !ts_is_set(a[0])) ts_throw_type_error_msg("Set size getter called on incompatible receiver");
  return ts_num(ts_set_size(a[0]));
}
static void ts_collection_size_accessor(tsv proto, ts_code code){
  ts_gc_root(&proto);
  tsv getter = ts_make_fn_t(code, NULL, 0, 1); ts_gc_root(&getter);
  ts_set_fn_meta(getter, 0, "get size");
  ts_define_accessor_attr(proto, ts_intern_field("size", 4), getter, TS_UNDEFINED, 1, 0, 0, 1);
  ts_gc_unroot(2);
}
tsv ts_mapproto_set(tsv* a, int n){ return ts_map_set(a[0], n>1?a[1]:TS_UNDEFINED, n>2?a[2]:TS_UNDEFINED); }
tsv ts_mapproto_get(tsv* a, int n){ return ts_map_get(a[0], n>1?a[1]:TS_UNDEFINED); }
tsv ts_mapproto_has(tsv* a, int n){ return ts_bool(ts_map_has(a[0], n>1?a[1]:TS_UNDEFINED)); }
tsv ts_mapproto_delete(tsv* a, int n){ return ts_bool(ts_map_delete(a[0], n>1?a[1]:TS_UNDEFINED)); }
tsv ts_mapproto_clear(tsv* a, int n){ (void)n; ts_map_clear(a[0]); return TS_UNDEFINED; }
tsv ts_mapproto_keys(tsv* a, int n){ (void)n; return ts_map_keys(a[0]); }
tsv ts_mapproto_values(tsv* a, int n){ (void)n; return ts_map_values(a[0]); }
tsv ts_mapproto_entries(tsv* a, int n){ (void)n; return ts_map_entries(a[0]); }
tsv ts_mapproto_forEach(tsv* a, int n){ ts_map_foreach(a[0], TS_ITER_CB(a, n)); return TS_UNDEFINED; }
tsv ts_setproto_add(tsv* a, int n){ return ts_set_add(a[0], n>1?a[1]:TS_UNDEFINED); }
tsv ts_setproto_has(tsv* a, int n){ return ts_bool(ts_set_has(a[0], n>1?a[1]:TS_UNDEFINED)); }
tsv ts_setproto_delete(tsv* a, int n){ return ts_bool(ts_set_delete(a[0], n>1?a[1]:TS_UNDEFINED)); }
tsv ts_setproto_clear(tsv* a, int n){ (void)n; ts_set_clear(a[0]); return TS_UNDEFINED; }
tsv ts_setproto_keys(tsv* a, int n){ (void)n; return ts_set_keys(a[0]); }
tsv ts_setproto_values(tsv* a, int n){ (void)n; return ts_set_values(a[0]); }
tsv ts_setproto_entries(tsv* a, int n){ (void)n; return ts_set_entries(a[0]); }
tsv ts_setproto_forEach(tsv* a, int n){ ts_set_foreach(a[0], TS_ITER_CB(a, n)); return TS_UNDEFINED; }
tsv ts_weakmapproto_set(tsv* a, int n){ return ts_weakmap_set(a[0], n>1?a[1]:TS_UNDEFINED, n>2?a[2]:TS_UNDEFINED); }
tsv ts_weakmapproto_get(tsv* a, int n){ return ts_weakmap_get(a[0], n>1?a[1]:TS_UNDEFINED); }
tsv ts_weakmapproto_has(tsv* a, int n){ return ts_bool(ts_weakmap_has(a[0], n>1?a[1]:TS_UNDEFINED)); }
tsv ts_weakmapproto_delete(tsv* a, int n){ return ts_bool(ts_weakmap_delete(a[0], n>1?a[1]:TS_UNDEFINED)); }
tsv ts_weaksetproto_add(tsv* a, int n){ return ts_weakset_add(a[0], n>1?a[1]:TS_UNDEFINED); }
tsv ts_weaksetproto_has(tsv* a, int n){ return ts_bool(ts_weakset_has(a[0], n>1?a[1]:TS_UNDEFINED)); }
tsv ts_weaksetproto_delete(tsv* a, int n){ return ts_bool(ts_weakset_delete(a[0], n>1?a[1]:TS_UNDEFINED)); }
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
tsv ts_weakmap_proto(void){ return ts_proto_ref(g_weakmap_proto_v) ? g_weakmap_proto_v : TS_NULL; }
tsv ts_weakset_proto_obj(void){ return ts_proto_ref(g_weakset_proto_v) ? g_weakset_proto_v : TS_NULL; }
tsv ts_headers_proto(void){ return ts_proto_ref(g_headers_proto_v) ? g_headers_proto_v : TS_NULL; }
tsv ts_abort_controller_proto(void){ if (!ts_proto_ref(g_abort_controller_proto_v)) ts_abort_controller_proto_init(); return ts_proto_ref(g_abort_controller_proto_v) ? g_abort_controller_proto_v : TS_NULL; }
tsv ts_abort_signal_proto(void){ if (!ts_proto_ref(g_abort_signal_proto_v)) ts_abort_signal_proto_init(); return ts_proto_ref(g_abort_signal_proto_v) ? g_abort_signal_proto_v : TS_NULL; }
void ts_map_proto_init(void){
  if (ts_proto_ref(g_map_proto_v)) return;
  static int rooted = 0;
  g_map_proto_v = ts_new_proto();
  ts_root_static_once(&g_map_proto_v, &rooted);
  ((ts_object*)ts_ptr(g_map_proto_v))->proto = g_object_proto_v;
  ts_collection_size_accessor(g_map_proto_v, ts_mapproto_size);
}
void ts_set_proto_init(void){
  if (ts_proto_ref(g_set_proto_v)) return;
  static int rooted = 0;
  g_set_proto_v = ts_new_proto();
  ts_root_static_once(&g_set_proto_v, &rooted);
  ((ts_object*)ts_ptr(g_set_proto_v))->proto = g_object_proto_v;
  ts_collection_size_accessor(g_set_proto_v, ts_setproto_size);
}
void ts_weakmap_proto_init(void){
  if (ts_proto_ref(g_weakmap_proto_v)) return;
  static int rooted = 0;
  g_weakmap_proto_v = ts_new_proto();
  ts_root_static_once(&g_weakmap_proto_v, &rooted);
  ((ts_object*)ts_ptr(g_weakmap_proto_v))->proto = g_object_proto_v;
}
void ts_weakset_proto_init(void){
  if (ts_proto_ref(g_weakset_proto_v)) return;
  static int rooted = 0;
  g_weakset_proto_v = ts_new_proto();
  ts_root_static_once(&g_weakset_proto_v, &rooted);
  ((ts_object*)ts_ptr(g_weakset_proto_v))->proto = g_object_proto_v;
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
  if (strcmp(name, "entries") == 0) {
    tsv entries = ts_get(g_map_proto_v, method_key);
    ts_define_data(g_map_proto_v, TS_KEY_WKSYM(TS_WKSYM_ITERATOR), entries, 0, 1, 1);
  }
}
void ts_set_proto_register(ts_key method_key, const char* name, ts_code fn){
  if (!ts_proto_ref(g_set_proto_v)) ts_set_proto_init();
  ts_proto_register_method(g_set_proto_v, method_key, name, fn);
  if (strcmp(name, "values") == 0) {
    tsv values = ts_get(g_set_proto_v, method_key);
    ts_define_data(g_set_proto_v, TS_KEY_WKSYM(TS_WKSYM_ITERATOR), values, 0, 1, 1);
  }
}
void ts_weakmap_proto_register(ts_key method_key, const char* name, ts_code fn){
  if (!ts_proto_ref(g_weakmap_proto_v)) ts_weakmap_proto_init();
  ts_proto_register_method(g_weakmap_proto_v, method_key, name, fn);
}
void ts_weakset_proto_register(ts_key method_key, const char* name, ts_code fn){
  if (!ts_proto_ref(g_weakset_proto_v)) ts_weakset_proto_init();
  ts_proto_register_method(g_weakset_proto_v, method_key, name, fn);
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
  if (!g_typed_slow) typed_slow_check_borrow(fn, thisArg);
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
  if (ts_is_indexed_array_fast(arr)){
    ts_gc_root(&fn); ts_gc_root(&thisArg); ts_gc_root(&arr);
    ts_array* a = ts_ptr(arr);
    int argc = (int)a->len;
    tsv* argv = malloc(sizeof(tsv)*(argc>0?argc:1));
    for (int i=0;i<argc;i++){
      a = ts_ptr(arr);
      argv[i] = ts_array_get(arr, (uint32_t)i);
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
  if (!g_typed_slow) typed_slow_check_borrow(fn, thisArg);
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
  static int rooted = 0;
  ts_root_static_once(&g_function_proto_v, &rooted);
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
tsv ts_strproto_slice(tsv* a, int n){ return ts_str_slice(a[0], n>1?ts_number_coerce(a[1]):0, n>2?ts_number_coerce(a[2]):0, n>2 && !ts_is_undef(a[2])); }
tsv ts_strproto_indexOf(tsv* a, int n){ return ts_num(ts_str_indexof(a[0], n>1?a[1]:TS_UNDEFINED, n>2?ts_to_num(a[2]):0, n>2)); }
tsv ts_strproto_lastIndexOf(tsv* a, int n){ return ts_num(ts_str_lastindexof(a[0], n>1?a[1]:TS_UNDEFINED, n>2?ts_to_num(a[2]):0, n>2)); }
tsv ts_strproto_includes(tsv* a, int n){ return ts_bool(ts_str_includes(a[0], n>1?a[1]:TS_UNDEFINED, n>2?ts_to_num(a[2]):0, n>2)); }
tsv ts_strproto_substring(tsv* a, int n){ return ts_str_substring(a[0], n>1?ts_number_coerce(a[1]):0, n>2?ts_number_coerce(a[2]):0, n>2 && !ts_is_undef(a[2])); }
tsv ts_strproto_substr(tsv* a, int n){ return ts_str_substr(n>0?a[0]:TS_UNDEFINED, n>1?a[1]:TS_UNDEFINED, n>2?a[2]:TS_UNDEFINED); }
tsv ts_strproto_toString(tsv* a, int n){ return ts_str_value(n>0?a[0]:TS_UNDEFINED); }
tsv ts_strproto_startsWith(tsv* a, int n){ return ts_bool(ts_str_startswith(a[0], n>1?a[1]:TS_UNDEFINED, n>2?ts_to_num(a[2]):0, n>2)); }
tsv ts_strproto_endsWith(tsv* a, int n){ return ts_bool(ts_str_endswith(a[0], n>1?a[1]:TS_UNDEFINED, n>2?ts_to_num(a[2]):0, n>2)); }
tsv ts_strproto_charAt(tsv* a, int n){ return ts_str_charat(a[0], n>1?ts_to_num(a[1]):0); }
tsv ts_strproto_charCodeAt(tsv* a, int n){ return ts_num(ts_str_charcodeat(a[0], n>1?ts_number_coerce(a[1]):0)); }
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
tsv ts_numproto_toFixed(tsv* a, int n){ return ts_number_to_fixed_v(a[0], n>1?a[1]:TS_UNDEFINED); }
tsv ts_numproto_toString(tsv* a, int n){ return ts_number_to_string_radix_v(a[0], n>1?a[1]:TS_UNDEFINED); }
tsv ts_numproto_toPrecision(tsv* a, int n){ return ts_number_to_precision_v(a[0], n>1?a[1]:TS_UNDEFINED); }
tsv ts_numproto_toExponential(tsv* a, int n){ return ts_number_to_exponential_v(a[0], n>1?a[1]:TS_UNDEFINED); }
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
  if (!ts_is_obj(src) || ts_is_map(src) || ts_is_set(src) || ts_is_indexed_array_fast(src)) { ts_gc_unroot(2); return dst; }
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

/* Extra location guards stay outside the compact shape cache. A bounded table
   keyed by the emitted site's stable address covers sized and dictionary
   receivers without enlarging every ordinary-object cache or its inline probe.
   Direct-map collisions only discard hints; every location hit is revalidated. */
enum { TS_PROP_IC_OWN = 1, TS_PROP_IC_STRUCT = 2 };
typedef struct {
  tsv proto;
  size_t receiver_size;
  ts_key key;
  uint32_t slot;
  uint8_t kind, numeric;
} ts_prop_location;
typedef struct {
  const ts_prop_ic* site;
  uint32_t epoch;
  uint8_t next;
  ts_prop_location entries[TS_PROP_IC_SIZE];
} ts_prop_location_cache;
#define TS_PROP_LOCATION_CACHE_SIZE 4096u
static ts_prop_location_cache g_prop_locations[TS_PROP_LOCATION_CACHE_SIZE];
static void prop_ic_location_reset(void){ memset(g_prop_locations, 0, sizeof(g_prop_locations)); }
static ts_prop_location_cache* prop_ic_locations(ts_prop_ic* ic){
  if (!ic || ic->megamorphic) return NULL;
  RT_STAT_INC(location_probes);
  uintptr_t hash = (uintptr_t)ic >> 2;
  hash ^= hash >> 16;
  uint32_t slot = (uint32_t)(hash * 2654435761u) & (TS_PROP_LOCATION_CACHE_SIZE - 1u);
  ts_prop_location_cache* cache = &g_prop_locations[slot];
  if (cache->site != ic || cache->epoch != g_ts_class_layout_epoch){
    if (cache->site && cache->site != ic) RT_STAT_INC(location_collisions);
    memset(cache, 0, sizeof(*cache));
    cache->site = ic; cache->epoch = g_ts_class_layout_epoch;
  }
  return cache;
}
static void prop_ic_note_miss(ts_prop_ic* ic){
  if (!ic || ic->megamorphic) return;
  uint8_t misses = (uint8_t)((ic->misses & 15u) + 1u);
  if (misses == 16u) ic->megamorphic = 1;
  else ic->misses = (uint8_t)((ic->misses & 240u) | misses);
}
static void prop_ic_fill_shape(ts_prop_ic* ic, ts_object* o, ts_key key, uint32_t slot){
  if (!ic || ic->megamorphic || ts_obj_is_sized(o)) return;
  /* The entry's slot word carries the attribute flags of that slot. Dictionary
     receivers never hit inline (shape 0); their entries only seed the
     out-of-line slot/key validation, which reads flags from the entry vector. */
  slot &= TS_PIC_SLOT_MASK;
  if (obj_shaped(o)) slot |= (uint32_t)obj_flags_at(o, slot) << TS_PIC_FLAGS_SHIFT;
  for (uint32_t i=0;i<TS_PROP_IC_SIZE;i++){
    ts_prop_ic_entry* e = &ic->entries[i];
    if (e->key == key && e->shape == o->shape && e->slot == slot) return;
  }
  uint32_t target = (uint32_t)(ic->next % TS_PROP_IC_SIZE);
  if (ic->next >= TS_PROP_IC_SIZE && ic->entries[target].key != key){
    prop_ic_note_miss(ic);
    if (ic->megamorphic) return;
  }
  if (++ic->next == 0) ic->next = TS_PROP_IC_SIZE;
  ic->entries[target] = (ts_prop_ic_entry){key, o->shape, slot};
}
/* Unsized objects cannot contain registered struct storage. Their own slots
   need only a live key/bounds check, even after deletion or prototype changes.
   This avoids the auxiliary table and keeps small property vectors contiguous. */
static ts_pref prop_ic_probe_own(ts_prop_ic* ic, ts_object* o, ts_key key){
  if (!ic || ic->megamorphic || ts_obj_is_sized(o)) return PREF_NONE;
  for (uint32_t i=0;i<TS_PROP_IC_SIZE;i++){
    ts_prop_ic_entry* e = &ic->entries[i];
    uint32_t slot = e->slot & TS_PIC_SLOT_MASK;
    if (e->key == key && slot < o->len && obj_key_at(o, slot) == key){
      /* Keep distinct shapes even when they share a slot. Overwriting the
         matching hint would make a four-shape site miss forever. After warmup,
         sample replacement to retain locality on sites with many shapes. The
         high nibble is the sample clock; the low nibble counts key diversity. */
      if (e->shape != o->shape && ts_obj_shape_id(o) != TS_SHAPE_NONE){
        if (ic->next < TS_PROP_IC_SIZE) prop_ic_fill_shape(ic, o, key, slot);
        else {
          ic->misses = (uint8_t)(ic->misses + 16u);
          if (!(ic->misses & 240u)) prop_ic_fill_shape(ic, o, key, slot);
        }
      }
      return (ts_pref){ o, slot };
    }
  }
  return PREF_NONE;
}
static ts_prop_location* prop_ic_probe(ts_prop_ic* ic, tsv obj, ts_key key){
  ts_object* o = (ts_object*)ts_ptr(obj);
  if (!ts_obj_is_sized(o)) return NULL;
  ts_prop_location_cache* cache = prop_ic_locations(ic);
  if (!cache) return NULL;
  for (uint32_t i=0;i<TS_PROP_IC_SIZE;i++){
    ts_prop_location* e=&cache->entries[i];
    if (e->proto != o->proto || e->receiver_size != o->h.size || e->key != key) continue;
    if (e->kind == TS_PROP_IC_STRUCT){ RT_STAT_INC(location_hits); return e; }
    if (e->kind == TS_PROP_IC_OWN && e->slot < o->len && obj_key_at(o, e->slot) == key){
      prop_ic_fill_shape(ic, o, key, e->slot);
      RT_STAT_INC(location_hits);
      return e;
    }
  }
  return NULL;
}
static void prop_ic_fill_entry(ts_prop_ic* ic, ts_object* o, ts_key key,
                               uint32_t slot, uint8_t kind, uint8_t numeric){
  ts_prop_location_cache* cache = prop_ic_locations(ic);
  if (!cache) return;
  uint32_t target = TS_PROP_IC_SIZE;
  for (uint32_t i=0;i<TS_PROP_IC_SIZE;i++){
    ts_prop_location* e = &cache->entries[i];
    if (e->proto == o->proto && e->receiver_size == o->h.size &&
        e->key == key && e->kind == kind && e->slot == slot){ target = i; break; }
    if (target == TS_PROP_IC_SIZE && e->kind == 0) target = i;
  }
  if (target == TS_PROP_IC_SIZE){
    target = (uint32_t)(cache->next++ % TS_PROP_IC_SIZE);
    if (ts_obj_shape_id(o) == TS_SHAPE_NONE && cache->entries[target].key != key){
      prop_ic_note_miss(ic);
      if (ic->megamorphic) return;
    }
  }
  ts_prop_location* e = &cache->entries[target];
  e->proto = o->proto; e->receiver_size = o->h.size; e->key = key;
  e->slot = slot; e->kind = kind; e->numeric = numeric;
}
static void prop_ic_fill(ts_prop_ic* ic, ts_object* o, ts_key key, ts_pref p){
  if (!pref_ok(p)) return;
  uint32_t slot = p.i;
  if (slot >= o->len) return;
  if (!ts_obj_is_sized(o)) prop_ic_fill_shape(ic, o, key, slot);
  else prop_ic_fill_entry(ic, o, key, slot, TS_PROP_IC_OWN, 0);
}
static void prop_ic_fill_struct(ts_prop_ic* ic, ts_object* o, ts_key key, size_t offset, int numeric){
  if (offset <= UINT32_MAX && offset + sizeof(tsv) <= o->h.size)
    prop_ic_fill_entry(ic, o, key, (uint32_t)offset, TS_PROP_IC_STRUCT, (uint8_t)numeric);
}
static tsv ts_prop_ic_struct_read(ts_object* o, const ts_prop_location* e){
  if (e->numeric){ double value; memcpy(&value, (char*)o + e->slot, sizeof value); return ts_num(value); }
  tsv value; memcpy(&value, (char*)o + e->slot, sizeof value); return value;
}
static tsv prop_ic_read(tsv receiver, ts_pref p){
  tsv value = pref_val(p);
  if (!pref_is_accessor(p)) return value;
  ts_accessor* ac = (ts_accessor*)ts_ptr(value);
  if (!ts_is_func(ac->getter)) return TS_UNDEFINED;
  if (ac->g_this){ tsv a0 = receiver; return ts_call(ac->getter, &a0, 1); }
  return ts_call(ac->getter, NULL, 0);
}
/* absent-property cache (defined with the addition cache below) */
typedef struct ts_prop_absent_entry ts_prop_absent_entry;
static inline const ts_prop_absent_entry* prop_absent_lookup(const ts_prop_ic* ic, ts_object* o, ts_key key);
static void prop_absent_fill(ts_prop_ic* ic, ts_object* o, ts_key key);
static void prop_absent_site_fill(ts_prop_ic* ic, const ts_object* o, ts_key key, const ts_prop_absent_entry* e);
static tsv ts_get_pic_checked_slow(tsv obj, ts_key key, ts_prop_ic* ic);
static uint32_t g_prop_absent_epoch;   /* g_prop_add_epoch | TS_ABSENT_EPOCH_TAG */
/* An absent read answered from its site's record (docs/absent_reads_inline_design.md).
   The record, filled where the slow read answers from or fills the global
   absent table, is checked as the table's entries are: the key and the epoch
   unchanged (first: most records are empty or stale), a plain object with a
   recorded shape word (which fixes its own keys, so not this one), each
   current prototype link a plain object with the recorded shape word, and
   the chain ending after the last one. Dictionary and sized receivers have
   shape 0 and are never recorded. */
static inline int prop_absent_site_hit(tsv obj, ts_key key, const ts_prop_ic* ic){
  if (!ic || ic->rec_epoch != g_prop_absent_epoch || ic->absent_key != key) return 0;
  if (TS_TOP16(obj) != TS_SEL_OBJECT) return 0;
  const ts_object* o = (const ts_object*)ts_ptr(obj);
  if ((o->shape != ic->absent_shape && o->shape != ic->absent_shape2) || o->h.kind != TS_KIND_OBJECT) return 0;
  for (uint32_t i = 0; i < ic->absent_depth; i++){
    tsv link = o->proto;
    if (TS_TOP16(link) != TS_SEL_OBJECT) return 0;
    o = (const ts_object*)ts_ptr(link);
    if (o->h.kind != TS_KIND_OBJECT || o->shape != ic->absent_proto_shape[i]) return 0;
  }
  return !ts_proto_ref(o->proto);
}
/* The out-of-line read: the site's absent record first, as a leaf (no frame,
   no saved registers), then the full lookup. */
tsv ts_get_pic_checked(tsv obj, ts_key key, ts_prop_ic* ic){
  if (prop_absent_site_hit(obj, key, ic)){ RT_STAT_INC(absent_site_hits); return TS_UNDEFINED; }
  return ts_get_pic_checked_slow(obj, key, ic);
}
__attribute__((noinline)) static tsv ts_get_pic_checked_slow(tsv obj, ts_key key, ts_prop_ic* ic){
  TS_RT_STAT_PIC_OOL();
  RT_STAT_KEY(g_key_ool_get, key);
  if (ts_is_null(obj) || ts_is_undef(obj))
    return ts_throw_cannot_read(obj, ts_field_name(key));
  TS_RT_STAT_PIC_GET_CALL();
  if (ic && g_negative_pic && TS_TOP16(obj) == TS_SEL_OBJECT){
    ts_object* o = (ts_object*)ts_ptr(obj);
    const ts_prop_absent_entry* e;
    if (prop_cache_receiver(o, key) && (e = prop_absent_lookup(ic, o, key))){
      RT_STAT_INC(pic_absent_hits);
      RT_STAT_KEY(g_key_absent, key);
      prop_absent_site_fill(ic, o, key, e);
      return TS_UNDEFINED;
    }
  }
  if (ic && ic->megamorphic) return ts_get(obj, key);
  if (TS_TOP16(obj) == TS_SEL_OBJECT){
    ts_object* o = (ts_object*)ts_ptr(obj);
    if (prop_cache_receiver(o, key)){
      ts_pref own = prop_ic_probe_own(ic, o, key);
      if (pref_ok(own)){ TS_RT_STAT_PIC_GET_HIT(); return prop_ic_read(obj, own); }
      ts_prop_location* e = prop_ic_probe(ic, obj, key);
      if (e){
        TS_RT_STAT_PIC_GET_HIT();
        if (e->kind == TS_PROP_IC_STRUCT) return ts_prop_ic_struct_read(o, e);
        return prop_ic_read(obj, (ts_pref){ o, e->slot });
      }
      size_t off; int numeric;
      if (g_has_class_regs && class_field_lookup(o, key, &off, &numeric)){
        prop_ic_fill_struct(ic, o, key, off, numeric);
        return struct_field_get(o, off, numeric);
      }
      ts_pref p = prop_find(o, key);
      if (pref_ok(p)){
        prop_ic_fill(ic, o, key, p);
        return prop_ic_read(obj, p);
      }
      tsv inherited;
      if (lookup_prop_chain(obj, ts_next_proto(o), key, &inherited)){ RT_STAT_INC(pic_get_inherited); return inherited; }
      RT_STAT_INC(pic_get_absent);
      RT_STAT_KEY(g_key_absent, key);
      prop_absent_fill(ic, o, key);
      return TS_UNDEFINED;
    }
  }
  return ts_get(obj, key);
}
/* ---- property-addition cache ----
   Most fixed-key stores that miss the per-site shape cache are additions:
   constructors and literals initialize fresh objects field by field, so the
   receiver never has the key yet (the inline shape hit rate for stores stays
   near zero by construction). The uncached addition walks the struct-field
   registry, the own slots and the prototype chain before appending.
   This bounded table remembers, per (site, hidden class), the verified
   outcome of such an addition. A hit requires the same site, the same
   receiver shape (which fixes the own key sequence, the slot and integrity
   bits), the same direct prototype and an unchanged epoch. The epoch moves
   whenever an accessor is defined, a prototype is relinked, a class layout is
   registered or a full collection runs; only old prototypes are recorded, and
   a minor collection cannot free an old cell's handle. A hit therefore implies
   exactly the slow path's decision: no struct field, no own slot, no inherited
   setter, extensible receiver. Symbol keys and sized receivers stay on the
   slow path. */
typedef struct {
  const ts_prop_ic* site;
  tsv proto;
  uint32_t shape_before, shape_after;
  ts_key key;
  uint32_t slot;
  uint32_t epoch;
} ts_prop_add_entry;
#define TS_PROP_ADD_CACHE_SIZE 4096u
static ts_prop_add_entry g_prop_add_cache[TS_PROP_ADD_CACHE_SIZE];
/* The epoch saturates instead of wrapping: the sites' own records (additions
   and absent reads, ts_rt.h) cannot all be cleared, so once the epoch reaches
   TS_PROP_EPOCH_EXHAUSTED nothing is filled any more and no record or entry
   matches again. It stays below TS_ABSENT_EPOCH_TAG, the bit that tells a
   read site's absent record from a store site's addition. */
#define TS_PROP_EPOCH_EXHAUSTED (TS_ABSENT_EPOCH_TAG - 1u)
static uint32_t g_prop_add_epoch = 1;
static uint32_t g_prop_absent_epoch = 1u | TS_ABSENT_EPOCH_TAG;
static void prop_add_epoch_bump(void){
  if (g_prop_add_epoch < TS_PROP_EPOCH_EXHAUSTED) g_prop_add_epoch++;
  g_prop_absent_epoch = g_prop_add_epoch | TS_ABSENT_EPOCH_TAG;
}
static inline int prop_epoch_live(void){ return g_prop_add_epoch != TS_PROP_EPOCH_EXHAUSTED; }
static inline uint32_t prop_add_slot(const ts_prop_ic* ic, uint32_t shape){
  uintptr_t h = (uintptr_t)ic >> 2;
  h ^= h >> 16;
  uint32_t x = (uint32_t)h * 2654435761u;
  x ^= shape * 0x9E3779B1u;
  x ^= x >> 15;
  return x & (TS_PROP_ADD_CACHE_SIZE - 1u);
}
static inline ts_prop_add_entry* prop_add_lookup(const ts_prop_ic* ic, ts_object* o, ts_key key){
  if (!ic || ts_obj_is_sized(o)) return NULL;
  ts_prop_add_entry* e = &g_prop_add_cache[prop_add_slot(ic, o->shape)];
  if (e->site == ic && e->shape_before == o->shape && e->key == key &&
      e->proto == o->proto && e->epoch == g_prop_add_epoch && e->slot == o->len)
    return e;
  return NULL;
}
static inline void prop_add_site_fill(ts_prop_ic* ic, uint32_t shape_before, uint32_t shape_after,
                                      uint32_t slot, ts_key key, tsv proto){
  if (!prop_epoch_live()) return;
  ic->add_shape_before = shape_before; ic->add_shape_after = shape_after;
  ic->add_slot = slot; ic->add_key = key; ic->add_proto = proto;
  ic->rec_epoch = g_prop_add_epoch;
}
static void prop_add_fill(ts_prop_ic* ic, ts_object* o, ts_key key, ts_pref p,
                          uint32_t len_before, uint32_t shape_before){
  if (!ic || !pref_ok(p) || ts_obj_is_sized(o) || !prop_epoch_live()) return;
  if (key >= TS_USERSYM_KEY_BASE) return;
  /* Only a plain append from a cacheable, extensible shape to another one. */
  if ((shape_before & TS_SHAPE_MAX) == TS_SHAPE_NONE || (shape_before >> 29) != 0) return;
  if (ts_obj_shape_id(o) == TS_SHAPE_NONE || ts_obj_integrity(o) != 0) return;
  if (o->len != len_before + 1u || p.i != len_before) return;
  for (ts_object* q = ts_next_proto(o); q; q = ts_next_proto(q)) if (chain_link_exotic(q)) return;
  /* Only old prototypes are remembered: their handles stay bound to the same
     cell until a full collection, which bumps the epoch. A young prototype's
     handle could be recycled by a minor collection. */
  if (ts_proto_ref(o->proto) && ((ts_gc_header*)ts_ptr(o->proto))->gen != TS_GEN_OLD) return;
  ts_prop_add_entry* e = &g_prop_add_cache[prop_add_slot(ic, shape_before)];
  e->site = ic; e->proto = o->proto;
  e->shape_before = shape_before; e->shape_after = o->shape;
  e->key = key; e->slot = len_before; e->epoch = g_prop_add_epoch;
  prop_add_site_fill(ic, shape_before, o->shape, len_before, key, o->proto);
}
/* ---- absent-property cache (docs/negative_cache_design.md) ----
   A read that finds the key nowhere — not an own slot, not a struct field,
   not on the prototype chain — is the checker's lazy-caching idiom
   (`if (!links.resolvedType) ...`): 3.6M of the 5.7M out-of-line reads of a
   compile in Session 350, each walking the own probe, the location table,
   the class registry, the key scan and the chain. This bounded table
   remembers, per (site, receiver shape), that the key is absent, together
   with a by-value snapshot of the prototype chain: the shape of each
   prototype (at most three, all plain shaped objects) and the chain's end.
   A hit requires the same site, receiver shape and key, an unchanged epoch,
   and every link of the snapshot to match on the CURRENT chain: a shape
   fixes the own keys and attributes of a plain object (an added key, an
   accessor, a deletion or a frozen attribute changes it), so whichever
   object now sits at a link, matching shapes mean the key is not there;
   the end test keeps a grown chain out; and the epoch (a relinked
   prototype, a defined accessor, a registered class layout, a full
   collection) covers the rest. No identity is recorded, so moved or
   recycled cells cannot mislead. Dictionary receivers and sized instances
   have shape 0 and are never recorded; neither are symbol keys, nor chains
   through functions (lazy own properties) or proxies. */
struct ts_prop_absent_entry {
  const ts_prop_ic* site;
  uint32_t shape;
  ts_key key;
  uint32_t epoch;
  uint8_t depth;
  uint32_t proto_shape[3];
};
#define TS_PROP_ABSENT_CACHE_SIZE 8192u
static ts_prop_absent_entry g_prop_absent_cache[TS_PROP_ABSENT_CACHE_SIZE];
static inline uint32_t prop_absent_slot(const ts_prop_ic* ic, uint32_t shape){
  uintptr_t h = (uintptr_t)ic >> 2;
  h ^= h >> 16;
  uint32_t x = (uint32_t)h * 2654435761u;
  x ^= shape * 0x9E3779B1u;
  x ^= x >> 15;
  return x & (TS_PROP_ABSENT_CACHE_SIZE - 1u);
}
static inline const ts_prop_absent_entry* prop_absent_lookup(const ts_prop_ic* ic, ts_object* o, ts_key key){
  ts_prop_absent_entry* e = &g_prop_absent_cache[prop_absent_slot(ic, o->shape)];
  if (e->site != ic || e->shape != o->shape || e->key != key || e->epoch != g_prop_add_epoch) return NULL;
  ts_object* p = o;
  for (uint8_t i = 0; i < e->depth; i++){
    p = ts_next_proto(p);
    if (!p || p->h.kind != TS_KIND_OBJECT || p->shape != e->proto_shape[i]) return NULL;
  }
  return ts_next_proto(p) == NULL ? e : NULL;
}
/* The read site's own copy of a verified entry (docs/absent_reads_inline_design.md),
   which prop_absent_site_hit checks before anything else: the same shape
   words and chain, tagged with the current epoch. Plain objects only (the
   table also serves named reads on arrays). A record stays for its epoch:
   a second receiver shape with the same key and chain joins it once, and
   any other absent read of the site is left to the table (a site with many
   absent shapes would otherwise rewrite its record on every table hit). */
static void prop_absent_site_fill(ts_prop_ic* ic, const ts_object* o, ts_key key, const ts_prop_absent_entry* e){
  if (!g_absent_site || o->h.kind != TS_KIND_OBJECT || !prop_epoch_live()) return;
  if (ic->rec_epoch == g_prop_absent_epoch){
    if (ic->absent_shape2 != ic->absent_shape || ic->absent_key != key || ic->absent_depth != e->depth) return;
    for (uint8_t i = 0; i < e->depth; i++) if (ic->absent_proto_shape[i] != e->proto_shape[i]) return;
    ic->absent_shape2 = e->shape;
    return;
  }
  ic->absent_shape = e->shape; ic->absent_shape2 = e->shape;
  ic->absent_key = key; ic->absent_depth = e->depth;
  for (uint8_t i = 0; i < e->depth; i++) ic->absent_proto_shape[i] = e->proto_shape[i];
  ic->rec_epoch = g_prop_absent_epoch;
}
static void prop_absent_fill(ts_prop_ic* ic, ts_object* o, ts_key key){
  if (!ic || !g_negative_pic || key >= TS_USERSYM_KEY_BASE || !prop_epoch_live()) return;
  if (ts_obj_shape_id(o) == TS_SHAPE_NONE || ts_obj_is_sized(o)) return;
  uint32_t chain_shape[3]; uint8_t depth = 0;
  for (ts_object* p = ts_next_proto(o); p; p = ts_next_proto(p)){
    if (depth == 3) return;
    if (p->h.kind != TS_KIND_OBJECT || ts_obj_shape_id(p) == TS_SHAPE_NONE) return;
    chain_shape[depth] = p->shape; depth++;
  }
  ts_prop_absent_entry* e = &g_prop_absent_cache[prop_absent_slot(ic, o->shape)];
  e->site = ic; e->shape = o->shape; e->key = key; e->epoch = g_prop_add_epoch; e->depth = depth;
  for (uint8_t i = 0; i < depth; i++) e->proto_shape[i] = chain_shape[i];
  prop_absent_site_fill(ic, o, key, e);
}
/* Object literal / constructor layouts: resolve the site's shape once by
   walking the transitions, then allocate directly in that shape. */
static uint32_t lit_layout_shape(ts_lit_layout* L){
  if (L->shape) return L->shape;
  uint32_t sh = TS_SHAPE_EMPTY;
  for (uint32_t i = 0; i < L->n && sh != TS_SHAPE_NONE; i++) sh = shape_transition(sh, L->keys[i]);
  L->shape = sh != TS_SHAPE_NONE ? sh : UINT32_MAX;
  return L->shape;
}
static tsv new_object_layout_impl(ts_lit_layout* L, int pretenured){
  uint32_t sh = lit_layout_shape(L);
  uint32_t n = L->n;
  if (sh != UINT32_MAX && n <= TS_INLINE_SLOTS_MAX){
    tsv obj = ts_new_object_impl(pretenured, n);
    ts_object* o = (ts_object*)ts_ptr(obj);
    tsv* slots = ts_obj_inline_vals(o);
    for (uint32_t i = 0; i < n; i++) slots[i] = TS_UNDEFINED;
    o->len = n;
    ts_obj_set_shape(o, sh);
    return obj;
  }
  /* shape table exhausted or an oversized literal: add the keys one by one */
  tsv obj = ts_new_object_impl(pretenured, TS_INLINE_SLOTS_DEFAULT);
  ts_gc_root(&obj);
  for (uint32_t i = 0; i < n; i++) ts_set_named_prop(obj, (ts_object*)ts_ptr(obj), L->keys[i], TS_UNDEFINED, 0);
  ts_gc_unroot(1);
  return obj;
}
tsv ts_new_object_layout(ts_lit_layout* L){ return new_object_layout_impl(L, 0); }
tsv ts_new_object_layout_pretenured(ts_lit_layout* L){ return new_object_layout_impl(L, 1); }
int ts_obj_adopt_layout(tsv obj, ts_lit_layout* L){
  if (TS_TOP16(obj) != TS_SEL_OBJECT) return 0;
  ts_object* o = (ts_object*)ts_ptr(obj);
  if (o->h.kind != TS_KIND_OBJECT || ts_obj_is_sized(o) || o->len != 0 || o->shape != TS_SHAPE_EMPTY) return 0;
  uint32_t sh = lit_layout_shape(L);
  uint32_t n = L->n;
  if (sh == UINT32_MAX || n > o->h.inline_cap) return 0;
  tsv* slots = ts_obj_inline_vals(o);
  for (uint32_t i = 0; i < n; i++) slots[i] = TS_UNDEFINED;
  o->len = n;
  ts_obj_set_shape(o, sh);
  return 1;
}
/* The linked slow paths of a lazy frame with register homes (ts_rt.h): the
   caller filled the frame; link it, run the generic operation, unlink. */
tsv ts_get_linked(tsv obj, ts_key key, ts_prop_ic* ic, ts_frame_hdr* frame, uint32_t nslots){
  ts_frame_push(frame, nslots);
  tsv r = ts_get_pic_checked(obj, key, ic);
  ts_frame_pop(frame);
  return r;
}
void ts_set_linked(tsv obj, ts_key key, tsv value, ts_prop_ic* ic, ts_frame_hdr* frame, uint32_t nslots){
  ts_frame_push(frame, nslots);
  ts_set_pic(obj, key, value, ic);
  ts_frame_pop(frame);
}
tsv ts_array_get_linked(tsv arr, int64_t i, ts_frame_hdr* frame, uint32_t nslots){
  ts_frame_push(frame, nslots);
  tsv r = ts_array_get_key_i64(arr, i);
  ts_frame_pop(frame);
  return r;
}
tsv ts_array_get_linked_f64(tsv arr, double d, ts_frame_hdr* frame, uint32_t nslots){
  ts_frame_push(frame, nslots);
  tsv r = ts_array_get_key_f64(arr, d);
  ts_frame_pop(frame);
  return r;
}
/* Element access with a number key (docs/array_index_keys_design.md): the
   element path for an index, the dynamic property path for any other
   number. A receiver with no elements of its own (a value its static type
   does not describe: an object cast to an array or a view) is read and
   written by the key as a property; null and undefined throw, and a write
   to another primitive throws as strict code does. */
static inline int elem_read_receiver(tsv v){ return ts_is_indexed_array_fast(v) || ts_is_str(v) || ts_is_typed_array(v); }
static inline int elem_write_receiver(tsv v){ return ts_is_indexed_array_fast(v) || ts_is_typed_array(v); }
static void elem_set_other(tsv obj, tsv keyv, tsv v){
  if (ts_is_propbag(obj)){ ts_set_dyn(obj, keyv, v); return; }
  if (ts_is_str(obj)){
    double d = ts_to_num(keyv);
    if (d >= 0 && d < (double)ts_str_len_typed(obj)){
      char num[40], buf[160]; ts_fmt_num(d, num, sizeof num);
      uint32_t sl; char* sc = ts_string_cstr_copy(obj, &sl);
      snprintf(buf, sizeof buf, "Cannot assign to read only property '%s' of string '%s'", num, sc ? sc : "?");
      free(sc);
      ts_throw_type_error_msg(buf);
    }
  }
  ts_key key;
  if (ts_key_from_value(keyv, &key)) ts_throw_bad_write_receiver(obj, key);
}
tsv ts_array_get_key_i64(tsv arr, int64_t i){
  if ((uint64_t)i < TS_ARRAY_INDEX_LIMIT && elem_read_receiver(arr)) return ts_array_get(arr, (uint32_t)i);
  return ts_get_dyn_checked(arr, ts_num((double)i));
}
tsv ts_array_get_key_f64(tsv arr, double d){
  uint32_t i;
  if (ts_num_array_index(d, &i) && elem_read_receiver(arr)) return ts_array_get(arr, i);
  return ts_get_dyn_checked(arr, ts_num(d));
}
void ts_array_set_key_i64(tsv arr, int64_t i, tsv v){
  if ((uint64_t)i < TS_ARRAY_INDEX_LIMIT && elem_write_receiver(arr)){ ts_array_set(arr, (uint32_t)i, v); return; }
  elem_set_other(arr, ts_num((double)i), v);
}
void ts_array_set_key_f64(tsv arr, double d, tsv v){
  uint32_t i;
  if (ts_num_array_index(d, &i) && elem_write_receiver(arr)){ ts_array_set(arr, i, v); return; }
  elem_set_other(arr, ts_num(d), v);
}
void ts_set_pic(tsv obj, ts_key key, tsv val, ts_prop_ic* ic){
  TS_RT_STAT_PIC_SET_CALL();
  if (ic && ic->megamorphic){ ts_set(obj, key, val); return; }
  if (TS_TOP16(obj) == TS_SEL_OBJECT){
    ts_object* o = (ts_object*)ts_ptr(obj);
    if (prop_cache_receiver(o, key)){
      /* The addition this site cached, before any probe for an existing key
         (a constructor initializing a fresh object): the same conditions as
         the global addition cache, read from the site itself. */
      if (ic && ic->rec_epoch == g_prop_add_epoch && o->shape == ic->add_shape_before &&
          o->len == ic->add_slot && ic->add_key == key && o->proto == ic->add_proto &&
          !ts_obj_is_sized(o)){
        RT_STAT_INC(prop_add_site_hits);
        RT_STAT_KEY(g_key_add, key);
        ts_pref p = props_append(o, key, ic->add_shape_after);
        tsv* vp = pref_valp(p);
        *vp = val;
        ts_write_barrier_ptr(obj, vp, val);   /* shaped: slot-precise */
        return;
      }
      ts_pref own = prop_ic_probe_own(ic, o, key);
      if (pref_ok(own)){
        TS_RT_STAT_PIC_SET_HIT();
        if (pref_is_accessor(own)){ invoke_setter((ts_accessor*)ts_ptr(pref_val(own)), obj, key, val); return; }
        if ((ts_obj_integrity(o) & 1u) || !pref_is_writable(own)){ ts_throw_readonly_write(key); return; }
        { tsv* vp = pref_valp(own); *vp = val;
          if (obj_shaped(o)) ts_write_barrier_ptr(obj, vp, val); else ts_write_barrier(obj, val); }
        return;
      }
      ts_prop_location* e = prop_ic_probe(ic, obj, key);
      if (e){
        TS_RT_STAT_PIC_SET_HIT();
        if (e->kind == TS_PROP_IC_STRUCT){
          if (ts_obj_integrity(o) & 1u){ ts_throw_readonly_write(key); return; }
          struct_field_set(o, e->slot, e->numeric, val); return;
        }
        ts_pref p = { o, e->slot };
        if (pref_is_accessor(p)){
          invoke_setter((ts_accessor*)ts_ptr(pref_val(p)), obj, key, val);
          return;
        }
        if ((ts_obj_integrity(o) & 1u) || !pref_is_writable(p)){
          ts_throw_readonly_write(key);
          return;
        }
        { tsv* vp = pref_valp(p); *vp = val;
          if (obj_shaped(o)) ts_write_barrier_ptr(obj, vp, val); else ts_write_barrier(obj, val); }
        return;
      }
      ts_prop_add_entry* add = prop_add_lookup(ic, o, key);
      if (add){
        RT_STAT_INC(prop_add_hits);
        RT_STAT_KEY(g_key_add, key);
        prop_add_site_fill(ic, add->shape_before, add->shape_after, add->slot, key, add->proto);
        ts_pref p = props_append(o, key, add->shape_after);
        tsv* vp = pref_valp(p);
        *vp = val;
        ts_write_barrier_ptr(obj, vp, val);
        return;
      }
      size_t off; int numeric;
      if (g_has_class_regs && class_field_lookup(o, key, &off, &numeric)){
        if (ts_obj_integrity(o) & 1u){ ts_throw_readonly_write(key); return; }
        struct_field_set(o, off, numeric, val);
        prop_ic_fill_struct(ic, o, key, off, numeric); return;
      }
      uint32_t len_before = o->len, shape_before = o->shape;
      ts_pref p = ts_set_named_prop(obj, o, key, val, 0);
      prop_ic_fill(ic, o, key, p);
      if (pref_ok(p)){ RT_STAT_INC(prop_add_fills); RT_STAT_KEY(g_key_add, key); prop_add_fill(ic, o, key, p, len_before, shape_before); }
      return;
    }
  }
  ts_set(obj, key, val);
}
tsv ts_get_dyn_checked(tsv obj, tsv keyv){
  if (ts_is_null(obj) || ts_is_undef(obj)){
    char tmp[128]; const char* prop = NULL;
    if (ts_is_str(keyv)){ ts_strview kv = ts_str_view_typed(keyv); uint32_t n = kv.len < sizeof(tmp)-1 ? kv.len : (uint32_t)sizeof(tmp)-1; for(uint32_t i=0;i<n;i++) tmp[i]=(char)ts_str_cu_at_view(kv,i); tmp[n]=0; prop=tmp; }
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
  /* An index on an array uses the element path; any other number is a
     property key (ToString) below, except on fixed-kind storage, where a
     numeric non-index key reads undefined (integer-indexed exotic). */
  if (ts_is_indexed_array_fast(obj) && ts_is_num(keyv)) {
    uint32_t index;
    if (ts_num_array_index(ts_to_num(keyv), &index)) return ts_array_get(obj, index);
  }
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
tsv ts_get_dyn_pic_checked(tsv obj, tsv keyv, ts_prop_ic* ic){
  if (ts_is_null(obj) || ts_is_undef(obj)) return ts_get_dyn_checked(obj, keyv);
  if (g_has_proxies && ts_is_proxy(obj)) return ts_get_dyn(obj, keyv);
  if (ts_is_indexed_array_fast(obj) && ts_is_num(keyv)) return ts_get_dyn(obj, keyv);
  if (ts_is_str(keyv) || ts_is_str(obj) || ts_is_obj(obj)){
    ts_gc_root(&obj);
    ts_key key;
    int ok = ts_key_from_value(keyv, &key);
    tsv result = ok ? ts_get_pic_checked(obj, key, ic) : TS_UNDEFINED;
    ts_gc_unroot(1);
    return result;
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
  if (ts_is_indexed_array_fast(obj) && ts_is_num(keyv)) {
    uint32_t index;
    if (ts_num_array_index(ts_to_num(keyv), &index)){ ts_array_set(obj, index, v); return; }
    /* any other number is a property key (ToString), below */
  }
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
void ts_set_dyn_pic(tsv obj, tsv keyv, tsv v, ts_prop_ic* ic){
  if (g_has_proxies && ts_is_proxy(obj)){ ts_set_dyn(obj, keyv, v); return; }
  if (ts_is_indexed_array_fast(obj) && ts_is_num(keyv)){ ts_set_dyn(obj, keyv, v); return; }
  if (ts_is_str(keyv) || ts_is_obj(obj)){
    ts_gc_root(&obj); ts_gc_root(&v);
    ts_key key;
    int ok = ts_key_from_value(keyv, &key);
    if (ok) ts_set_pic(obj, key, v, ic);
    ts_gc_unroot(2);
  }
}

/* ---------------- Reflect (static reflection namespace) ----------------------
   Thin wrappers over the existing dynamic property / call / construct runtime.
   Reflect mirrors the proxy traps and returns booleans (success) where Object.*
   returns the object or throws. */
tsv ts_reflect_has(tsv t, tsv k){ return ts_bool(ts_has_prop_dyn(t, k)); }
tsv ts_reflect_set(tsv t, tsv k, tsv v){ ts_set_dyn(t, k, v); return ts_bool(1); }
/* Reflect.get(t, k, receiver): t.[[Get]](k, receiver) — a getter found on t's
   chain runs with the receiver as `this`. A plain-object target walks its
   chain with the receiver (exotic links included); other targets, and a
   receiver that is the target itself, keep the ordinary read. */
tsv ts_reflect_get_recv(tsv t, tsv k, tsv r){
  if (r == t || !ts_is_obj(t) || ts_same_cell(r, t)) return ts_get_dyn(t, k);
  if (g_has_proxies && ts_is_proxy(t)) return ts_proxy_get_v(t, k, r);
  if (((ts_gc_header*)ts_ptr(t))->kind != TS_KIND_OBJECT) return ts_get_dyn(t, k);
  ts_gc_root(&t); ts_gc_root(&r);
  ts_key key;
  tsv out = TS_UNDEFINED;
  if (ts_key_from_value(k, &key)){
    ts_object* o = (ts_object*)ts_ptr(t);
    size_t off; int numeric;
    if (g_has_class_regs && class_field_lookup(o, key, &off, &numeric)) out = struct_field_get(o, off, numeric);
    else if (!lookup_prop_chain(r, o, key, &out)) out = TS_UNDEFINED;
  }
  ts_gc_unroot(2);
  return out;
}
/* Reflect.set(t, k, v, receiver): OrdinarySet(t, k, v, receiver) for a
   plain-object target. Along t's chain: a setter runs with the receiver as
   `this`, a read-only data property fails, a proxy link applies its [[Set]]
   with the receiver; a writable data property or none at all leaves the
   write to the receiver, which takes it as its own writable data property
   (an own accessor or read-only property, or a non-extensible receiver,
   fails). Returns the success flag, as Reflect does (no throw). */
static int proxy_receiver_set(tsv r, ts_key key, tsv v);
static int ordinary_set_recv(tsv t, ts_key key, tsv v, tsv r){
  ts_gc_root(&t); ts_gc_root(&v); ts_gc_root(&r);
  int ok = 1;
  ts_object* p = (ts_object*)ts_ptr(t);
  if (!class_has_field(p, key)){
    while (p){
      if (chain_link_exotic(p)){
        if (p->h.kind == TS_KIND_PROXY){
          tsv pv = ts_obj(p);
          ts_gc_root(&pv);
          tsv keyv = ts_key_to_value(key);
          ok = ts_proxy_set_v(pv, keyv, v, r);
          ts_gc_unroot(1);
          goto done;
        }
        p = p->h.kind == TS_KIND_PROMISE ? ts_proto_ptr(g_promise_proto_v) : NULL;
        continue;
      }
      tsv* s = find_slot(p, key, 0);
      if (s){
        if (is_accessor(*s)){
          ts_accessor* ac = (ts_accessor*)ts_ptr(*s);
          if (!ts_is_func(ac->setter)){ ok = 0; goto done; }
          if (ac->s_this){ tsv a[2] = { r, v }; ts_call(ac->setter, a, 2); }
          else { tsv a0 = v; ts_call(ac->setter, &a0, 1); }
          goto done;
        }
        ts_pref ip = prop_find(p, key);
        if ((ts_obj_integrity(p) & 1u) || (pref_ok(ip) && !pref_is_writable(ip))){ ok = 0; goto done; }
        break;
      }
      p = ts_next_proto(p);
    }
  }
  /* the receiver's part */
  if (!ts_is_propbag(r)){ ok = 0; goto done; }
  if (g_has_proxies && ts_is_proxy(r)){ ok = proxy_receiver_set(r, key, v); goto done; }
  {
    ts_object* ro = (ts_object*)ts_ptr(r);
    if (kind_has_common_header(ro->h.kind) && (class_has_field(ro, key) || find_slot(ro, key, 0))){
      if (!class_has_field(ro, key)){
        ts_pref own = prop_find(ro, key);
        if (pref_ok(own) && (pref_is_accessor(own) || !pref_is_writable(own) || (ts_obj_integrity(ro) & 1u))){ ok = 0; goto done; }
      }
      ts_set(r, key, v);          /* an own writable data property: no chain walk */
    } else if (!kind_has_common_header(ro->h.kind) || (ts_obj_integrity(ro) & (1u|2u|4u))){
      ok = 0;
    } else {
      ts_define_data(r, key, v, 1, 1, 1);
    }
  }
done:
  ts_gc_unroot(3);
  return ok;
}
tsv ts_reflect_set_recv(tsv t, tsv k, tsv v, tsv r){
  if (r == t || !ts_is_obj(t) || ts_same_cell(r, t)) return ts_reflect_set(t, k, v);
  if (g_has_proxies && ts_is_proxy(t)) return ts_bool(ts_proxy_set_v(t, k, v, r));
  if (((ts_gc_header*)ts_ptr(t))->kind != TS_KIND_OBJECT) return ts_reflect_set(t, k, v);
  ts_gc_root(&t); ts_gc_root(&v); ts_gc_root(&r);
  ts_key key;
  int ok = ts_key_from_value(k, &key) ? ordinary_set_recv(t, key, v, r) : 0;
  ts_gc_unroot(3);
  return ts_bool(ok);
}
tsv ts_reflect_delete(tsv t, tsv k){
  ts_gc_root(&t);
  ts_key key; int ok = ts_key_from_value(k, &key);
  int r = ok ? ts_delete_prop(t, key) : 1;
  ts_gc_unroot(1);
  return ts_bool(r);
}
tsv ts_reflect_set_proto(tsv t, tsv p){ ts_set_proto_user(t, p); return ts_bool(1); }
/* false (not a TypeError) when the property cannot be defined as described */
tsv ts_reflect_define_property(tsv t, tsv k, tsv d){ return ts_bool(define_property_from(t, k, d, 0)); }
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
/* ---- guarded direct construction (docs/guarded_construction_design.md) ----
   A `new` through a function value whose target the exporter can predict
   (a constructor function with a `this` parameter of the site's type) tests
   the value's code pointer and, on a hit, runs the plain-function
   construction split in two around a direct call of the constructor body:
   begin allocates the instance on fn.prototype with the learned slack, end
   learns the slack and applies the object-return rule. The generic
   ts_construct stays for every other value. */
int ts_construct_same_code(tsv ctorv, tsv fval){
  if (!ts_is_func(ctorv) || !ts_is_func(fval)) return 0;
  ts_func* c = (ts_func*)ts_ptr(ctorv);
  return c->code == ((ts_func*)ts_ptr(fval))->code && c->class_id == 0 && c->constructable;
}
tsv ts_construct_begin(tsv ctorv){ return ts_construct_begin_n(ctorv, 0u); }
/* `min_slots`: the exporter's in-object capacity for the instances of this
   site's constructor, the longest producer layout rooted at its prefix
   (docs/static_slots_design.md, producers), so the keys the program adds after
   construction stay in-object; the learned slack (`ts_construct_end`) only
   covers the constructor's own stores plus four. */
tsv ts_construct_begin_n(tsv ctorv, uint32_t min_slots){
  ts_gc_root(&ctorv);
  fn_materialize_prototype((ts_func*)ts_ptr(ctorv), ctorv);
  tsv proto = ((ts_func*)ts_ptr(ctorv))->prototype_prop;
  uint32_t est = ((ts_func*)ts_ptr(ctorv))->inst_slots;
  if (!est) est = 12u;
  if (est < min_slots) est = min_slots;
  if (est > TS_INLINE_SLOTS_MAX) est = TS_INLINE_SLOTS_MAX;
  /* Instances of guarded constructions go straight to the old generation
     (docs/pretenured_construction_design.md): the objects ES5-style
     constructor functions build are a program's long-lived data (the
     compiler's nodes, symbols and types live to the end), and copying them
     through the nursery is wasted. A full collection that finds the old
     generation mostly dead turns this off for the rest of the run. */
  tsv inst = g_pretenure_ctors ? ts_new_object_n_pretenured(est) : ts_new_object_n(est);
  ts_object* io = (ts_object*)ts_ptr(inst);
  io->proto = ts_is_obj(proto) ? proto : ts_object_proto();
  if (g_pretenure_ctors) ts_write_barrier(inst, io->proto);
  ts_gc_unroot(1);
  return inst;
}
tsv ts_construct_end(tsv ctorv, tsv inst, tsv result){
  uint32_t used = ((ts_object*)ts_ptr(inst))->len + 4u;
  if (used > TS_INLINE_SLOTS_MAX) used = TS_INLINE_SLOTS_MAX;
  ts_func* cf = (ts_func*)ts_ptr(ctorv);
  if (used > cf->inst_slots) cf->inst_slots = (uint8_t)used;
  return ts_is_obj(result) ? result : inst;
}
tsv ts_reflect_construct(tsv fn, tsv argsArray){
  if (!ts_is_indexed_array_fast(argsArray)) return ts_construct(fn, NULL, 0);
  ts_gc_root(&fn); ts_gc_root(&argsArray);
  ts_array* a = ts_ptr(argsArray);
  int argc = (int)a->len;
  tsv* argv = malloc(sizeof(tsv)*(argc>0?argc:1));
  for (int i=0;i<argc;i++) argv[i] = ts_array_get(argsArray, (uint32_t)i);
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
  /* At least an object header's size, zero-filled: inline probes read a
     receiver's shape word before they test its kind, and a proxy cell must
     answer with shape 0 (no cached layout) instead of bytes past its end. */
  size_t sz = sizeof(ts_proxy) < sizeof(ts_object) ? sizeof(ts_object) : sizeof(ts_proxy);
  ts_proxy* px = (ts_proxy*)gc_alloc(sz, TS_KIND_PROXY);
  px->target = target; px->handler = handler; px->revoked = 0;
  tsv pv = ts_obj(px);
  ts_write_barrier(pv, target); ts_write_barrier(pv, handler);
  typed_slow_raise("a Proxy");
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
/* OrdinarySetWithOwnDescriptor steps 2.c-2.e when the receiver is a proxy:
   its [[GetOwnProperty]] and [[DefineOwnProperty]] (the getOwnPropertyDescriptor
   and defineProperty traps), not its [[Set]]. A set trap that forwards with
   Reflect.set(target, key, value, receiver) used to call itself until the
   stack overflowed. */
static int proxy_receiver_set(tsv r, ts_key key, tsv v){
  ts_gc_root(&r); ts_gc_root(&v);
  tsv keyv = ts_key_to_value(key);
  ts_gc_root(&keyv);
  tsv existing = ts_proxy_get_own_desc(r, keyv);
  ts_gc_root(&existing);
  tsv desc = TS_UNDEFINED;
  ts_gc_root(&desc);
  int ok = 1;
  if (!ts_is_undef(existing)){
    if (pd_has(existing, "get") || pd_has(existing, "set") || !pd_bool(existing, "writable")) ok = 0;
    else {
      desc = ts_new_object();
      ts_set(desc, ts_intern_field("value", 5), v);
    }
  } else {
    desc = build_data_descriptor(v, 1, 1, 1);
  }
  if (ok) ts_proxy_define_property(r, keyv, desc);
  ts_gc_unroot(5);
  return ok;
}

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
  if (ts_is_undef(trap)){
    /* the target's [[Get]] with the receiver (a getter there sees it) */
    tsv r = (receiver == pv) ? ts_get_dyn(target, keyv) : ts_reflect_get_recv(target, keyv, receiver);
    ts_gc_unroot(5); return r;
  }
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
  if (ts_is_undef(trap)){
    /* the target's [[Set]] with the receiver: a write through the proxy
       itself lands on the target, a foreign receiver takes its own property */
    int ok = 1;
    if (receiver == pv) ts_set_dyn(target, keyv, value);
    else ok = ts_truthy(ts_reflect_set_recv(target, keyv, value, receiver));
    ts_gc_unroot(6); return ok;
  }
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
/* ---- exotic links on a prototype chain (docs/proxy_prototype_chain_design.md) ---- */
/* [[Get]] reaching the exotic link `p` of `receiver`'s chain: 1 when the link
   answered (*out: the get trap with the original receiver); 0 to go on at
   *next: a proxy without a get trap continues on its target (a getter there
   sees the receiver), a promise on Promise.prototype, anything else ends. */
static int chain_exotic_get(ts_object* p, ts_key key, tsv receiver, tsv* out, ts_object** next){
  if (p->h.kind == TS_KIND_PROMISE){ *next = ts_proto_ptr(g_promise_proto_v); return 0; }
  if (p->h.kind != TS_KIND_PROXY){ *next = NULL; return 0; }
  tsv pv = ts_obj(p);
  tsv handler = ((ts_proxy*)p)->handler;
  ts_gc_root(&pv); ts_gc_root(&receiver); ts_gc_root(&handler);
  tsv trap = ts_proxy_trap(pv, handler, "get");     /* throws on a revoked proxy */
  if (ts_is_undef(trap)){
    *next = ts_proto_ptr(((ts_proxy*)ts_ptr(pv))->target);
    ts_gc_unroot(3);
    return 0;
  }
  ts_gc_root(&trap);
  tsv keyv = ts_key_to_value(key); ts_gc_root(&keyv);
  tsv target = ((ts_proxy*)ts_ptr(pv))->target; ts_gc_root(&target);
  tsv argv[3] = { target, keyv, receiver };
  tsv result = invoke_with_this(trap, handler, argv, 3);
  ts_gc_root(&result);
  proxy_inv_get(target, keyv, result);
  *out = result;
  ts_gc_unroot(7);
  return 1;
}
/* [[HasProperty]] at an exotic link: 1 when decided (*res: the has trap, or
   the target's own chain), 0 to go on at *next. */
static int chain_exotic_has(ts_object* p, ts_key key, int* res, ts_object** next){
  if (p->h.kind == TS_KIND_PROMISE){ *next = ts_proto_ptr(g_promise_proto_v); return 0; }
  if (p->h.kind != TS_KIND_PROXY){ *next = NULL; return 0; }
  tsv pv = ts_obj(p);
  ts_gc_root(&pv);
  tsv keyv = ts_key_to_value(key);
  *res = ts_proxy_has_v(pv, keyv);
  ts_gc_unroot(1);
  return 1;
}
/* [[Set]] at an exotic link of `receiver`'s chain: 1 when the link decided
   (the set trap ran with the receiver; a falsish answer is the strict-mode
   TypeError), 0 to go on at *next: a proxy without a set trap continues the
   ordinary set on its target (which ends in a setter called on the receiver,
   a read-only rejection, or an own property of the receiver). */
static int chain_exotic_set(ts_object* p, ts_key key, tsv receiver, tsv val, ts_object** next){
  if (p->h.kind == TS_KIND_PROMISE){ *next = ts_proto_ptr(g_promise_proto_v); return 0; }
  if (p->h.kind != TS_KIND_PROXY){ *next = NULL; return 0; }
  tsv pv = ts_obj(p);
  tsv handler = ((ts_proxy*)p)->handler;
  ts_gc_root(&pv); ts_gc_root(&receiver); ts_gc_root(&val); ts_gc_root(&handler);
  tsv trap = ts_proxy_trap(pv, handler, "set");     /* throws on a revoked proxy */
  if (ts_is_undef(trap)){
    *next = ts_proto_ptr(((ts_proxy*)ts_ptr(pv))->target);
    ts_gc_unroot(4);
    return 0;
  }
  ts_gc_root(&trap);
  tsv keyv = ts_key_to_value(key); ts_gc_root(&keyv);
  tsv target = ((ts_proxy*)ts_ptr(pv))->target; ts_gc_root(&target);
  tsv argv[4] = { target, keyv, val, receiver };
  int ok = ts_truthy(invoke_with_this(trap, handler, argv, 4));
  if (!ok){
    const char* nm = ts_field_name(key);
    char buf[256];
    snprintf(buf, sizeof(buf), "'set' on proxy: trap returned falsish for property '%s'", nm ? nm : "?");
    ts_throw_type_error_msg(buf);
  }
  proxy_inv_set(target, keyv, val);
  ts_gc_unroot(7);
  return 1;
}
/* The link after the exotic one `link` for a walk by [[GetPrototypeOf]]
   (instanceof, isPrototypeOf): a proxy's getPrototypeOf trap or its target's
   prototype, Promise.prototype after a promise, null after anything else. */
static tsv chain_exotic_proto(tsv link){
  uint8_t kind = ((ts_gc_header*)ts_ptr(link))->kind;
  if (kind == TS_KIND_PROXY) return ts_proxy_get_proto(link);
  if (kind == TS_KIND_PROMISE) return ts_proto_ref(g_promise_proto_v) ? g_promise_proto_v : TS_NULL;
  return TS_NULL;
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
  if (!ts_is_indexed_array_fast(r))
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
  uint32_t n = ts_is_indexed_array_fast(keys) ? ts_array_len(keys) : 0;
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

/* Snapshot the keys visited by `for...in`. Unlike Object.keys this walks the
   prototype chain. A name is marked visited before its enumerable flag is
   checked, so a non-enumerable own property correctly shadows an enumerable
   property of the same name on a prototype. Symbols never participate. */
tsv ts_object_for_in_keys(tsv obj){
  ts_gc_root(&obj);
  tsv out=ts_new_array(0); ts_gc_root(&out);
  tsv seen=ts_new_array(0); ts_gc_root(&seen);
  tsv cur=obj; ts_gc_root(&cur);
  while ((ts_is_obj(cur) || ts_is_func(cur) || ts_is_str(cur)) && !ts_is_null(cur)){
    tsv keys=(g_has_proxies && ts_is_proxy(cur))
      ? ts_proxy_own_keys_arr(cur)
      : ts_object_get_own_property_names(cur);
    ts_gc_root(&keys);
    uint32_t n=ts_array_len(keys);
    for (uint32_t i=0;i<n;i++){
      tsv key=ts_array_get(keys,i);
      if (!ts_is_str(key)) continue;
      ts_gc_root(&key);
      int duplicate=0;
      uint32_t ns=ts_array_len(seen);
      for (uint32_t j=0;j<ns;j++){
        if (ts_strict_eq(ts_array_get(seen,j),key)){ duplicate=1; break; }
      }
      if (!duplicate){
        ts_array_push(seen,key);
        tsv desc=ts_get_own_property_descriptor(cur,key);
        ts_gc_root(&desc);
        if (ts_is_obj(desc) && pd_bool(desc,"enumerable")) ts_array_push(out,key);
        ts_gc_unroot(1);
      }
      ts_gc_unroot(1);
    }
    ts_gc_unroot(1);
    cur=ts_get_proto(cur);
  }
  ts_gc_unroot(4);
  return out;
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

/* ---------------- per-site allocation statistics (diagnostic) ----------------
   Emitted only by TSAOT_SITE_STATS=1 builds: every closure creation site
   reports its site id and callee function id; the top sites are printed at
   exit (TSAOT_RT_STATS_FILE appends there, else stderr). */
static uint64_t* g_site_count = NULL;
static uint32_t* g_site_func = NULL;
static uint32_t g_site_cap = 0;
static const char** g_site_fn_names = NULL;
static uint32_t g_site_fn_count = 0;
void ts_site_note(uint32_t site, uint32_t func){
  if (site >= g_site_cap){
    uint32_t next = g_site_cap ? g_site_cap : 1024u;
    while (site >= next) next *= 2u;
    g_site_count = (uint64_t*)realloc(g_site_count, sizeof(uint64_t) * next);
    g_site_func = (uint32_t*)realloc(g_site_func, sizeof(uint32_t) * next);
    memset(g_site_count + g_site_cap, 0, sizeof(uint64_t) * (next - g_site_cap));
    memset(g_site_func + g_site_cap, 0, sizeof(uint32_t) * (next - g_site_cap));
    g_site_cap = next;
  }
  g_site_count[site]++;
  g_site_func[site] = func;
}
static void ts_site_stats_dump(void){
  const char* path = getenv("TSAOT_RT_STATS_FILE");
  FILE* out = path ? fopen(path, "a") : stderr;
  if (!out) out = stderr;
  uint64_t total = 0;
  for (uint32_t i = 0; i < g_site_cap; i++) total += g_site_count[i];
  fprintf(out, "[site_stats] closure allocations: total=%llu sites=%u\n", (unsigned long long)total, g_site_cap);
  for (int rank = 0; rank < 400; rank++){
    uint32_t best = 0; uint64_t bestc = 0;
    for (uint32_t i = 0; i < g_site_cap; i++) if (g_site_count[i] > bestc){ bestc = g_site_count[i]; best = i; }
    if (!bestc) break;
    uint32_t f = g_site_func[best];
    const char* nm = (g_site_fn_names && f < g_site_fn_count) ? g_site_fn_names[f] : "?";
    fprintf(out, "[site_stats] %12llu  site=%u  fn_%u_%s\n", (unsigned long long)bestc, best, f, nm ? nm : "?");
    g_site_count[best] = 0;
  }
  if (out != stderr) fclose(out);
}
void ts_site_stats_init(const char** fn_names, uint32_t nfn){
  g_site_fn_names = fn_names; g_site_fn_count = nfn;
  atexit(ts_site_stats_dump);
}

/* ---------------- exceptions (try/catch via setjmp/longjmp) ---------------- */
static ts_handler* g_handlers = NULL;
static tsv g_exception;

ts_handler* ts_eh_push(void){
  ts_handler* h = (ts_handler*)malloc(sizeof(ts_handler));
  h->gc_root_len = ts_gc_root_depth();
  h->frame_top = g_ts_frame_top;
#ifdef TSAOT_STACK_CHECK
  h->sc_act = g_sc_cur_act;
#endif
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
  h->frame_top = g_ts_frame_top;
#ifdef TSAOT_STACK_CHECK
  h->sc_act = g_sc_cur_act;
#endif
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
  ts_gc_set_root_depth(h->gc_root_len);
  ts_frame_restore(h->frame_top);
#ifdef TSAOT_STACK_CHECK
  sc_unwind_to(h->sc_act);
#endif
  if (h->extbuf) ts_longjmp(*(jmp_buf*)h->extbuf, 1);
  ts_longjmp(h->buf, 1);
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

/* Run a value/method call or property read behind a temporary exception handler.
   Promise resolution must translate abrupt completion from a then getter/call
   into rejection of the target promise, never let it escape synchronously. */
static tsv ts_call_catching(tsv fn, tsv* args, int n, int* threw){
  ts_handler* h = ts_eh_push();
  if (ts_setjmp(h->buf) != 0){
    ts_gc_set_root_depth(h->gc_root_len);
    ts_frame_restore(h->frame_top);
    ts_eh_pop();
    *threw = 1;
    return ts_current_exception();
  }
  tsv r = ts_call_value(fn, args, n);
  ts_eh_pop();
  *threw = 0;
  return r;
}
static tsv ts_call_method_catching(tsv fn, tsv* args, int n, int* threw){
  ts_handler* h = ts_eh_push();
  if (ts_setjmp(h->buf) != 0){
    ts_gc_set_root_depth(h->gc_root_len);
    ts_frame_restore(h->frame_top);
    ts_eh_pop();
    *threw = 1;
    return ts_current_exception();
  }
  tsv r = ts_call_method(fn, args, n);
  ts_eh_pop();
  *threw = 0;
  return r;
}
static tsv ts_get_catching(tsv obj, ts_key key, int* threw){
  ts_handler* h = ts_eh_push();
  if (ts_setjmp(h->buf) != 0){
    ts_gc_set_root_depth(h->gc_root_len);
    ts_frame_restore(h->frame_top);
    ts_eh_pop();
    *threw = 1;
    return ts_current_exception();
  }
  tsv r = ts_get(obj, key);
  ts_eh_pop();
  *threw = 0;
  return r;
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
typedef struct { ts_coro c; tsv out_v; tsv inner_v; int registered; } ts_adopt;
static tsv adopt_resume(tsv cv){
  ts_adopt* w=(ts_adopt*)ts_ptr(cv);
  if (!w->registered){
    w->registered=1;
    tsv inner=w->inner_v;
    ts_gc_root(&inner);
    ts_await_register_v(inner,cv);
    ts_gc_unroot(1);
    return TS_UNDEFINED;
  }
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

/* A pair of resolving functions shares this hidden ordinary object. Its `done`
   bit is separate from promise.state: resolving with a pending promise locks the
   pair immediately even though the target promise remains pending while adopting. */
static ts_key F_resolver_done=0;
static void ensure_resolver_fields(void){
  if (!F_resolver_done) F_resolver_done=ts_intern_field("__promise_resolver_done",23);
}
static int promise_resolver_claim(tsv cell){
  ensure_resolver_fields();
  if (ts_truthy(ts_get(cell, F_resolver_done))) return 0;
  ts_set(cell, F_resolver_done, ts_bool(1));
  return 1;
}
static tsv ts_resolve_thunk(tsv* a, int n);
static tsv ts_reject_thunk(tsv* a, int n);
static void promise_make_resolvers(tsv pv, tsv* resolve_out, tsv* reject_out, tsv* cell_out){
  ts_gc_root(&pv);
  ensure_resolver_fields();
  tsv cell=ts_new_object(); ts_gc_root(&cell);
  ts_set(cell, F_resolver_done, ts_bool(0));
  tsv env[2]={pv,cell};
  tsv resolve=ts_make_fn(ts_resolve_thunk, env, 2); ts_gc_root(&resolve);
  tsv reject=ts_make_fn(ts_reject_thunk, env, 2);
  *resolve_out=resolve; *reject_out=reject; *cell_out=cell;
  ts_gc_unroot(3);
}

/* PromiseResolveThenableJob. Getter lookup happens in ts_promise_resolve_v;
   invocation is deliberately deferred to this microtask. */
typedef struct { ts_coro c; tsv out_v; tsv thenable; tsv then_fn; } ts_thenable_job;
static tsv thenable_job_resume(tsv cv){
  ts_thenable_job* w=(ts_thenable_job*)ts_ptr(cv);
  tsv outv=w->out_v, thenable=w->thenable, then_fn=w->then_fn;
  ts_gc_root(&outv); ts_gc_root(&thenable); ts_gc_root(&then_fn);
  if (!promise_pending_v(outv)){ ts_gc_unroot(3); return TS_UNDEFINED; }
  tsv resolve, reject, cell;
  promise_make_resolvers(outv, &resolve, &reject, &cell);
  ts_gc_root(&resolve); ts_gc_root(&reject); ts_gc_root(&cell);
  tsv args[3]={thenable,resolve,reject};
  int threw=0;
  tsv exc=ts_call_method_catching(then_fn,args,3,&threw);
  if (threw && promise_resolver_claim(cell)) ts_promise_reject_v(outv,exc);
  ts_gc_unroot(6);
  return TS_UNDEFINED;
}

static tsv promise_resolution_type_error(const char* msg){
  tsv text=ts_new_string(msg,(uint32_t)strlen(msg));
  ts_gc_root(&text);
  tsv err=ts_new_error(TS_ERR_TYPE,text);
  ts_gc_unroot(1);
  return err;
}

void ts_promise_resolve_v(tsv pv, tsv v){
  if (!ts_promise_ptr(pv) || !promise_pending_v(pv)) return;
  if (ts_strict_eq(pv,v)){
    tsv err=promise_resolution_type_error("Chaining cycle detected for promise");
    ts_gc_root(&err);
    ts_promise_settle_v(pv,err,1);
    ts_gc_unroot(1);
    return;
  }
  if (ts_is_promise(v)){
    /* Promise Resolve Functions enqueue a job even for a native inner promise.
       The first adapter turn registers on `v`; its second turn forwards the
       eventual state. This preserves ordering when the inner settles between
       resolve(inner) and the first microtask checkpoint. */
    ts_gc_root(&pv); ts_gc_root(&v);
    tsv wv = ts_coro_alloc_v(sizeof(ts_adopt), adopt_resume);
    ts_gc_root(&wv);
    ts_adopt* w=(ts_adopt*)ts_ptr(wv);
    w->out_v=pv; w->inner_v=v; w->registered=0;
    ts_write_barrier(wv, w->out_v);
    ts_write_barrier(wv, w->inner_v);
    microq_push_v(wv);
    ts_gc_unroot(3);
    return;
  }
  /* Thenable assimilation: read `then` exactly once. A throwing getter rejects;
     a callable is invoked later as a PromiseResolveThenableJob with a fresh
     already-resolved pair. */
  if (ts_object_like(v) || ts_is_func(v)){
    ts_gc_root(&pv); ts_gc_root(&v);
    int threw=0;
    tsv then_fn=ts_get_catching(v,ts_intern_field("then",4),&threw);
    ts_gc_root(&then_fn);
    if (threw){
      ts_promise_settle_v(pv,then_fn,1);
      ts_gc_unroot(3);
      return;
    }
    if (ts_is_callable(then_fn)){
      tsv wv=ts_coro_alloc_v(sizeof(ts_thenable_job),thenable_job_resume);
      ts_gc_root(&wv);
      ts_thenable_job* w=(ts_thenable_job*)ts_ptr(wv);
      w->out_v=pv; w->thenable=v; w->then_fn=then_fn;
      ts_write_barrier(wv,pv); ts_write_barrier(wv,v); ts_write_barrier(wv,then_fn);
      microq_push_v(wv);
      ts_gc_unroot(4);
      return;
    }
    ts_gc_unroot(3);
  }
  ts_promise_settle_v(pv, v, 0);
}
void ts_promise_reject_v(tsv pv, tsv v){ ts_promise_settle_v(pv, v, 1); }

tsv ts_promise_resolved(tsv v){
  if (ts_is_promise(v)) return v;
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

/* Materialize a synchronous iterable for Promise combinators. Invalid inputs and
   abrupt iterator operations reject the returned promise instead of escaping
   synchronously or being mistaken for an empty iterable. */
static int promise_materialize_inputs(tsv input, tsv* array_out, tsv* error_out){
  if (ts_is_indexed_array_fast(input)){ *array_out=input; return 1; }
  ts_gc_root(&input);
  tsv tmp=ts_new_array(0); ts_gc_root(&tmp);
  int valid=ts_is_set(input) || ts_is_map(input) || ts_is_str(input);
  tsv iter=input; ts_gc_root(&iter);
  if (!valid && ts_object_like(input)){
    int threw=0;
    tsv itf=ts_get_catching(input,TS_KEY_WKSYM(TS_WKSYM_ITERATOR),&threw);
    if (threw){ *error_out=itf; ts_gc_unroot(3); return 0; }
    ts_gc_root(&itf);
    tsv coro=ts_get_catching(input,ts_coro_key(),&threw);
    if (threw){ *error_out=coro; ts_gc_unroot(4); return 0; }
    if (ts_is_coro_value(coro)){
      valid=1; /* Garnet generator objects implement @@iterator intrinsically. */
    } else if (ts_is_callable(itf)){
      tsv args[1]={input};
      iter=ts_call_method_catching(itf,args,1,&threw);
      if (threw){ *error_out=iter; ts_gc_unroot(4); return 0; }
      valid=ts_object_like(iter);
    }
    ts_gc_unroot(1);
  }
  if (!valid){
    *error_out=promise_resolution_type_error("object is not iterable");
    ts_gc_unroot(3);
    return 0;
  }
  ts_handler* h=ts_eh_push();
  if (ts_setjmp(h->buf) != 0){
    ts_gc_set_root_depth(h->gc_root_len);
    ts_frame_restore(h->frame_top);
    ts_eh_pop();
    *error_out=ts_current_exception();
    ts_gc_unroot(3);
    return 0;
  }
  ts_array_push_all(tmp,iter);
  ts_eh_pop();
  *array_out=tmp;
  ts_gc_unroot(3);
  return 1;
}

tsv ts_promise_all(tsv arr){
  tsv arrv = arr;
  ts_gc_root(&arrv);
  tsv outv = ts_promise_new_v();
  ts_gc_root(&outv);   /* the alloc loop below can trigger GC */
  tsv err=TS_UNDEFINED; ts_gc_root(&err);
  if (!promise_materialize_inputs(arrv,&arrv,&err)){
    ts_promise_settle_v(outv,err,1); ts_gc_unroot(3); return outv;
  }
  uint32_t n = ts_array_len(arrv);
  tsv results = ts_new_array(n);          /* kept alive via outv + the extended PROMISE mark */
  ts_gc_root(&results);
  promise_comb_init_v(outv, n, results);
  if (n==0){ ts_promise_resolve_v(outv, results); ts_gc_unroot(4); return outv; }
  for (uint32_t i=0;i<n;i++){
    tsv input = ts_array_get(arrv, i);
    tsv wv = ts_coro_alloc_v(sizeof(ts_comb), comb_all_resume);
    ts_gc_root(&wv);
    ts_comb* w = (ts_comb*)ts_ptr(wv);
    w->out_v = outv; ts_write_barrier(wv, outv); w->idx = (double)i;
    ts_await_register_v(input, wv);
    ts_gc_unroot(1);
  }
  ts_gc_unroot(4);
  return outv;
}
tsv ts_promise_race(tsv arr){
  tsv arrv = arr;
  ts_gc_root(&arrv);
  tsv outv = ts_promise_new_v();
  ts_gc_root(&outv);
  tsv err=TS_UNDEFINED; ts_gc_root(&err);
  if (!promise_materialize_inputs(arrv,&arrv,&err)){
    ts_promise_settle_v(outv,err,1); ts_gc_unroot(3); return outv;
  }
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
  ts_gc_unroot(3);
  return outv;
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
/* AggregateError instance for Promise.any all-reject. */
static tsv ts_aggregate_error(tsv errors){
  ts_gc_root(&errors);
  tsv msg=ts_new_string("All promises were rejected",26); ts_gc_root(&msg);
  tsv o = ts_new_error(TS_ERR_AGGREGATE,msg); ts_gc_root(&o);
  ts_define_data(o,ts_intern_field("errors",6),errors,0,1,1);
  ts_gc_unroot(1);
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
typedef struct { ts_coro c; tsv out_v; tsv original; int original_rejected; } ts_finally_after;
static tsv finally_after_resume(tsv cv){
  ts_finally_after* w=(ts_finally_after*)ts_ptr(cv);
  tsv outv=w->out_v, original=w->original, cleanup=w->c.result;
  int cleanup_rejected=w->c.rejected, original_rejected=w->original_rejected;
  ts_gc_root(&outv); ts_gc_root(&original); ts_gc_root(&cleanup);
  if (cleanup_rejected) ts_promise_reject_v(outv,cleanup);
  else if (original_rejected) ts_promise_reject_v(outv,original);
  else ts_promise_resolve_v(outv,original);
  ts_gc_unroot(3);
  return TS_UNDEFINED;
}
/* .finally adapter: onFinally is called with no args. Its result is PromiseResolve'd
   and awaited before the original completion is propagated; a cleanup rejection
   replaces the original completion. */
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
    ts_gc_root(&r);
    tsv av=ts_coro_alloc_v(sizeof(ts_finally_after),finally_after_resume);
    ts_gc_root(&av);
    ts_finally_after* a=(ts_finally_after*)ts_ptr(av);
    a->out_v=outv; a->original=result; a->original_rejected=rejected;
    ts_write_barrier(av,outv); ts_write_barrier(av,result);
    ts_await_register_v(r,av);
    ts_gc_unroot(2);
    ts_gc_unroot(3);
    return TS_UNDEFINED;
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
/* new Promise(executor): resolve/reject capture [promise, resolver-cell].
   The shared cell implements the spec's AlreadyResolved record, which cannot be
   inferred from promise.state while a pending promise/thenable is being adopted. */
static tsv ts_resolve_thunk(tsv* a, int n){
  if (n<2 || !promise_resolver_claim(a[1])) return TS_UNDEFINED;
  ts_promise_resolve_v(a[0], n>2 ? a[2] : TS_UNDEFINED);
  return TS_UNDEFINED;
}
static tsv ts_reject_thunk(tsv* a, int n){
  if (n<2 || !promise_resolver_claim(a[1])) return TS_UNDEFINED;
  ts_promise_reject_v(a[0], n>2 ? a[2] : TS_UNDEFINED);
  return TS_UNDEFINED;
}
tsv ts_promise_new_executor(tsv executor){
  ts_gc_root(&executor);
  tsv pv = ts_promise_new_v();
  ts_gc_root(&pv);
  tsv resolve, reject, cell;
  promise_make_resolvers(pv,&resolve,&reject,&cell);
  ts_gc_root(&resolve); ts_gc_root(&reject); ts_gc_root(&cell);
  tsv args[2]; args[0] = resolve; args[1] = reject;
  int threw; tsv r = ts_call_catching(executor, args, 2, &threw);
  if (threw && promise_resolver_claim(cell)) ts_promise_reject_v(pv, r);
  ts_gc_unroot(5);
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
  static int rooted = 0;
  ts_root_static_once(&g_promise_proto_v, &rooted);
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
  tsv outv = ts_promise_new_v();
  ts_gc_root(&outv);
  tsv err=TS_UNDEFINED; ts_gc_root(&err);
  if (!promise_materialize_inputs(arrv,&arrv,&err)){
    ts_promise_settle_v(outv,err,1); ts_gc_unroot(3); return outv;
  }
  uint32_t n = ts_array_len(arrv);
  tsv results = ts_new_array(n);
  ts_gc_root(&results);
  promise_comb_init_v(outv, n, results);
  if (n==0){ ts_promise_resolve_v(outv, results); ts_gc_unroot(4); return outv; }
  for (uint32_t i=0;i<n;i++){
    tsv input = ts_array_get(arrv, i);
    tsv wv = ts_coro_alloc_v(sizeof(ts_comb), comb_allsettled_resume);
    ts_gc_root(&wv);
    ts_comb* w = (ts_comb*)ts_ptr(wv);
    w->out_v = outv; ts_write_barrier(wv, outv); w->idx = (double)i;
    ts_await_register_v(input, wv);
    ts_gc_unroot(1);
  }
  ts_gc_unroot(4);
  return outv;
}
tsv ts_promise_any(tsv arr){
  tsv arrv = arr;
  ts_gc_root(&arrv);
  tsv outv = ts_promise_new_v();
  ts_gc_root(&outv);
  tsv mat_err=TS_UNDEFINED; ts_gc_root(&mat_err);
  if (!promise_materialize_inputs(arrv,&arrv,&mat_err)){
    ts_promise_settle_v(outv,mat_err,1); ts_gc_unroot(3); return outv;
  }
  uint32_t n = ts_array_len(arrv);
  tsv results = ts_new_array(n);   /* reasons */
  ts_gc_root(&results);
  promise_comb_init_v(outv, n, results);
  if (n==0){
    tsv err = ts_aggregate_error(results);
    ts_gc_root(&err);
    ts_promise_settle_v(outv, err, 1);
    ts_gc_unroot(5);
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
  ts_gc_unroot(4);
  return outv;
}

/* register coroutine cv to resume when promise pv settles; if already settled,
   enqueue immediately. The public runtime path uses the handle form so callers
   don't keep raw coroutine pointers live across scheduler boundaries. */
void ts_await_register_v(tsv pv, tsv cv){
  if (!ts_is_coro_value(cv)) return;
  ts_gc_root(&pv); ts_gc_root(&cv);
  if (!ts_is_promise(pv)){
    /* Await uses PromiseResolve, so arbitrary thenables must be assimilated rather
       than delivered as plain objects. Primitives/non-thenable objects become an
       already-fulfilled promise and still resume through the microtask queue. */
    pv=ts_promise_resolved(pv);
  }
  tsv value = TS_UNDEFINED;
  int state = promise_state_value_v(pv, &value);
  if (state==1){ coro_deliver_v(cv, value, 0); microq_push_v(cv); }
  else if (state==2){ coro_deliver_v(cv, value, 1); microq_push_v(cv); }
  else promise_add_waiter_v(pv, cv);
  ts_gc_unroot(2);
}

static void coro_init(ts_coro* c, size_t size, tsv (*resume)(tsv)){
  c->state=0; c->resume=resume; c->result=TS_UNDEFINED; c->rejected=0;
  c->nvals=-1; c->frame_size=size; c->ret=TS_UNDEFINED;
  c->gen_status=TS_GEN_SUSPENDED_START;
  c->eh_capacity=TS_CORO_EH_INLINE;
  c->eh_catch_state=c->eh_catch_inline;
  c->eh_gc_depth=c->eh_gc_inline;
  c->fin_capacity=TS_CORO_EH_INLINE;
  c->fin_pending=c->fin_pending_inline;
  c->fin_exc=c->fin_exc_inline;
  c->fin_tgt=c->fin_tgt_inline;
}
int ts_coro_eh_push_slot(ts_coro* c){
  if (c->eh_top >= c->eh_capacity){
    int cap=c->eh_capacity ? c->eh_capacity*2 : TS_CORO_EH_INLINE;
    int* states=(int*)malloc(sizeof(int)*(size_t)cap);
    int* depths=(int*)malloc(sizeof(int)*(size_t)cap);
    if (!states || !depths){
      free(states); free(depths);
      ts_abort_msg("out of memory growing coroutine exception stack");
    }
    memcpy(states,c->eh_catch_state,sizeof(int)*(size_t)c->eh_top);
    memcpy(depths,c->eh_gc_depth,sizeof(int)*(size_t)c->eh_top);
    if (c->eh_catch_state!=c->eh_catch_inline) free(c->eh_catch_state);
    if (c->eh_gc_depth!=c->eh_gc_inline) free(c->eh_gc_depth);
    c->eh_catch_state=states;
    c->eh_gc_depth=depths;
    c->eh_capacity=cap;
  }
  return c->eh_top++;
}
int ts_coro_fin_push_slot(ts_coro* c){
  if (c->fin_top >= c->fin_capacity){
    int cap=c->fin_capacity ? c->fin_capacity*2 : TS_CORO_EH_INLINE;
    int* pending=(int*)malloc(sizeof(int)*(size_t)cap);
    tsv* exc=(tsv*)malloc(sizeof(tsv)*(size_t)cap);
    int* targets=(int*)malloc(sizeof(int)*(size_t)cap);
    if (!pending || !exc || !targets){
      free(pending); free(exc); free(targets);
      ts_abort_msg("out of memory growing coroutine finally stack");
    }
    memcpy(pending,c->fin_pending,sizeof(int)*(size_t)c->fin_top);
    memcpy(exc,c->fin_exc,sizeof(tsv)*(size_t)c->fin_top);
    memcpy(targets,c->fin_tgt,sizeof(int)*(size_t)c->fin_top);
    if (c->fin_pending!=c->fin_pending_inline) free(c->fin_pending);
    if (c->fin_exc!=c->fin_exc_inline) free(c->fin_exc);
    if (c->fin_tgt!=c->fin_tgt_inline) free(c->fin_tgt);
    c->fin_pending=pending;
    c->fin_exc=exc;
    c->fin_tgt=targets;
    c->fin_capacity=cap;
  }
  return c->fin_top++;
}
/* allocate a coroutine frame of `size` bytes (>= sizeof(ts_coro)); the embedded
   ts_coro is at offset 0. Extra frame fields are zeroed (calloc). */
static tsv coro_alloc(size_t size, tsv (*resume)(tsv), int nvals){
  if (size < sizeof(ts_coro)) size = sizeof(ts_coro);
  ts_coro* c=(ts_coro*)gc_alloc(size, TS_KIND_CORO);
  coro_init(c, size, resume);
  if (nvals >= 0){
    if ((size_t)nvals > (size - sizeof(ts_coro)) / sizeof(tsv))
      ts_abort_msg("coroutine frame map is larger than the frame");
    c->nvals = nvals;
  }
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
tsv ts_coro_alloc_v(size_t size, tsv (*resume)(tsv)){ return coro_alloc(size, resume, -1); }
tsv ts_coro_alloc_vn(size_t size, tsv (*resume)(tsv), uint32_t nvals){
  return coro_alloc(size, resume, nvals > (uint32_t)INT32_MAX ? INT32_MAX : (int)nvals);
}
tsv ts_coro_new_v(tsv (*resume)(tsv)){
  return ts_coro_alloc_v(sizeof(ts_coro), resume);
}
static void asyncgen_start_next_v(tsv cv);
static int asyncgen_after_resume_v(tsv cv){
  ts_coro* c=(ts_coro*)ts_ptr(cv);
  if (!c || !c->is_asyncgen || !c->ag_running || !c->ag_head) return 0;
  if (promise_state_value_v(c->ag_head->promise,NULL)==0){
    c->gen_status=TS_GEN_EXECUTING; /* parked at await; current request still owns the frame */
    return 0;
  }
  ts_asyncgen_req* done=c->ag_head;
  c->ag_head=done->next;
  if (!c->ag_head) c->ag_tail=NULL;
  free(done);
  c->ag_running=0;
  c->gen_status=c->done ? TS_GEN_COMPLETED : TS_GEN_SUSPENDED_YIELD;
  return c->ag_head!=NULL;
}
void ts_coro_resume_v(tsv cv){
  if (!ts_is_coro_value(cv)) return;
  ts_gc_root(&cv);
  ts_handler* h = ts_eh_push();
  if (ts_setjmp(h->buf) != 0){
    tsv exc = ts_current_exception();
    ts_gc_set_root_depth(h->gc_root_len);
    ts_frame_restore(h->frame_top);
    ts_eh_pop_until(h);
    cv = exc;  /* keep the exception rooted while rethrowing past this cleanup frame */
    ts_throw(exc);
  }
  ts_coro* c=(ts_coro*)ts_ptr(cv);
  if (c->resume) c->resume(cv);
  int kick_next=asyncgen_after_resume_v(cv);
  ts_eh_pop_until(h);
  ts_gc_unroot(1);
  if (kick_next) asyncgen_start_next_v(cv);
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
  int stable = h->gen != TS_GEN_YOUNG;
  if (h->kind==TS_KIND_PROMISE){
    ts_promise* p=(ts_promise*)h;
    gc_visit_slot(&p->value, young, depth, stable);
    gc_visit_slot(&p->comb_results, young, depth, stable);
    for (int i=0;i<p->nwait;i++) gc_visit_slot(&p->waiters[i], young, depth, stable);
  } else if (h->kind==TS_KIND_CORO){
    ts_coro* c=(ts_coro*)h;
    gc_visit_slot(&c->result, young, depth, stable);
    gc_visit_slot(&c->yielded, young, depth, stable);
    for (int i=0;i<c->fin_top;i++) gc_visit_slot(&c->fin_exc[i], young, depth, stable);
    gc_visit_slot(&c->ret, young, depth, stable);
    for (ts_asyncgen_req* r=c->ag_head;r;r=r->next){
      gc_visit_slot(&r->promise, young, depth, stable);
      gc_visit_slot(&r->value, young, depth, stable);
    }
    if (c->nvals >= 0){
      /* The frame map (docs/gc_v2_design.md §6.5 step 2b): the tsv locals
         lead the frame, visited as slots; integer and double locals follow
         and are not looked at. */
      tsv* vals = (tsv*)((char*)c + sizeof(ts_coro));
      for (int i = 0; i < c->nvals; i++) gc_visit_slot(&vals[i], young, depth, stable);
    } else {
      /* A frame without the map: scan it conservatively; any 8-byte word that
         looks like a heap reference is treated as a root. An integer local
         with such bits is read as a reference too, the reason for the map. */
      size_t off = sizeof(ts_coro);
      char* base = (char*)c;
      for (; off + sizeof(tsv) <= c->frame_size; off += sizeof(tsv)){
        tsv v; memcpy(&v, base+off, sizeof(tsv));
        gc_mark_visit(v, young, depth);
      }
    }
  }
}

static void gc_mark_async_roots(void){
  for (int i=0;i<g_mq_len;i++) gc_visit_slot(&g_microq[i], 0, 0, 1);
  for (ts_io* t=g_io_head;t;t=t->next){ gc_visit_slot(&t->p, 0, 0, 1); gc_visit_slot(&t->signal, 0, 0, 1); }
  for (ts_io* t=g_io_active;t;t=t->next){ gc_visit_slot(&t->p, 0, 0, 1); gc_visit_slot(&t->signal, 0, 0, 1); }
  gc_mark_abort_timer_roots();
}
static void gc_mark_async_roots_young(void){
  for (int i=0;i<g_mq_len;i++) gc_visit_slot(&g_microq[i], 1, 0, 1);
  for (ts_io* t=g_io_head;t;t=t->next){ gc_visit_slot(&t->p, 1, 0, 1); gc_visit_slot(&t->signal, 1, 0, 1); }
  for (ts_io* t=g_io_active;t;t=t->next){ gc_visit_slot(&t->p, 1, 0, 1); gc_visit_slot(&t->signal, 1, 0, 1); }
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
  for (ts_abort_timer* t=g_abort_timers;t;t=t->next) gc_visit_slot(&t->signal, 0, 0, 1);
}

static void gc_mark_abort_timer_roots_young(void){
  for (ts_abort_timer* t=g_abort_timers;t;t=t->next) gc_visit_slot(&t->signal, 1, 0, 1);
}

tsv ts_abort_signal_new(int aborted){
  ensure_abort_fields();
  ts_abort_signal_proto_init();
  tsv signal = ts_new_object();
  ts_gc_root(&signal);
  obj_link_fresh_proto(signal, ts_abort_signal_proto());
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
  obj_link_fresh_proto(controller, ts_abort_controller_proto());
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
    if (ts_is_obj(h) && !ts_is_indexed_array_fast(h)){
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
  if (ts_is_indexed_array_fast(init) || ts_is_map(init) || ts_is_set(init) || ts_is_str(init)) return 1;
  if (!ts_object_like(init)) return 0;
  tsv itf = ts_get(init, TS_KEY_WKSYM(TS_WKSYM_ITERATOR));
  if (ts_is_callable(itf)) return 1;
  tsv nextfn = ts_get(init, ts_intern_field("next", 4));
  if (ts_is_callable(nextfn)) return 1;
  tsv coro = ts_get(init, ts_coro_key());
  return ts_is_obj(coro);
}

static void ts_headers_seed_from_pair_array(tsv headers, tsv pairs){
  ts_gc_root(&headers);
  ts_gc_root(&pairs);
  uint32_t len = ts_array_len(pairs);
  for (uint32_t i=0;i<len;i++){
    tsv pair = ts_array_get(pairs, i);
    if (!ts_is_indexed_array_fast(pair)) continue;
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
  obj_link_fresh_proto(headers, ts_headers_proto());
  ts_define_data(headers, TS_HEADERS_BRAND_KEY, ts_bool(1), 0, 0, 0);
  if (ts_is_undef(init) || ts_is_null(init)){
    ts_gc_unroot(2);
    return headers;
  }

  if (ts_headers_init_is_sequence(init)){
    tsv pairs = init;
    if (!ts_is_indexed_array_fast(pairs)) pairs = ts_new_array(0);
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
double ts_length_slow(tsv v){
  if (ts_is_str(v)) return (double)ts_str_len_typed(v);
  if (ts_is_indexed_array_fast(v)) return (double)((ts_array*)ts_ptr(v))->len;
  if (ts_is_typed_array(v)) return (double)((ts_typedarray*)ts_ptr(v))->length;
  if (ts_is_func(v)) return (double)((ts_func*)ts_ptr(v))->arity; /* fn.length */
  if (g_has_proxies && ts_is_proxy(v)) return ts_to_num(ts_get(v, ts_intern_field("length", 6))); /* honor get trap */
  return 0;
}

/* ---------------- generators (function* / yield) ---------------- */
static uint32_t F_coro=0, F_value=0, F_done=0, F_gen_return_tag=0, F_gen_return_value=0;
static ts_rt_ic g_ic_coro;
static tsv g_gen_return_tag=TS_UNDEFINED;
static void ensure_gen_fields(void){
  if (!F_coro){
    F_coro=ts_intern_field("__coro",6);
    F_value=ts_intern_field("value",5);
    F_done=ts_intern_field("done",4);
    F_gen_return_tag=ts_intern_field("__generator_return_tag",22);
    F_gen_return_value=ts_intern_field("__generator_return_value",24);
  }
  if (ts_is_undef(g_gen_return_tag)){
    g_gen_return_tag=ts_new_object();
    static int rooted = 0;
    ts_root_static_once(&g_gen_return_tag, &rooted);
  }
}
static tsv ts_gen_return_completion(tsv value){
  ensure_gen_fields();
  ts_gc_root(&value);
  tsv completion=ts_new_object(); ts_gc_root(&completion);
  ts_set(completion,F_gen_return_tag,g_gen_return_tag);
  ts_set(completion,F_gen_return_value,value);
  ts_gc_unroot(2);
  return completion;
}
int ts_is_gen_return_completion(tsv v){
  /* This predicate runs at generated catch labels. It must be allocation-free:
     the current exception still lives in the runtime exception slot until the
     catch variable assignment, so a lazy field/tag allocation here could run a
     GC before generated code has copied the exception into its rooted frame.
     Return injection initializes the hidden tag before such a completion can
     exist. */
  if (!F_gen_return_tag || ts_is_undef(g_gen_return_tag) || !ts_is_obj(v)) return 0;
  ts_gc_header* h=(ts_gc_header*)ts_ptr(v);
  if (!h || h->kind!=TS_KIND_OBJECT) return 0;
  ts_pref p=prop_find((ts_object*)h,F_gen_return_tag);
  return pref_ok(p) && !pref_is_accessor(p) && ts_strict_eq(pref_val(p),g_gen_return_tag);
}
tsv ts_gen_return_completion_value(tsv v){
  if (!ts_is_gen_return_completion(v)) return TS_UNDEFINED;
  ts_pref p=prop_find((ts_object*)ts_ptr(v),F_gen_return_value);
  return pref_ok(p) && !pref_is_accessor(p) ? pref_val(p) : TS_UNDEFINED;
}
static tsv coro_resume_catching_v(tsv cv, int* threw){
  ts_handler* h=ts_eh_push();
  if (ts_setjmp(h->buf)!=0){
    tsv exc=ts_current_exception();
    ts_gc_set_root_depth(h->gc_root_len);
    ts_frame_restore(h->frame_top);
    ts_eh_pop();
    *threw=1;
    return exc;
  }
  ts_coro_resume_v(cv);
  ts_eh_pop();
  *threw=0;
  return TS_UNDEFINED;
}
static void gen_throw_busy(void){
  ts_throw_type_error_msg("Generator is already running");
}

/* wrap an already-allocated coroutine frame in a generator object */
static tsv g_generator_protos[2] = {TS_NULL, TS_NULL};
static tsv ts_genproto_identity(tsv* a, int n){ return n ? a[0] : TS_UNDEFINED; }
static tsv ts_genproto_next(tsv* a, int n){ return ts_gen_next(n?a[0]:TS_UNDEFINED, n>1?a[1]:TS_UNDEFINED); }
static tsv ts_genproto_return(tsv* a, int n){ return ts_gen_return(n?a[0]:TS_UNDEFINED, n>1?a[1]:TS_UNDEFINED); }
static tsv ts_genproto_throw(tsv* a, int n){ return ts_gen_throw(n?a[0]:TS_UNDEFINED, n>1?a[1]:TS_UNDEFINED); }
static tsv ts_asyncgenproto_next(tsv* a, int n){ return ts_asyncgen_next(n?a[0]:TS_UNDEFINED, n>1?a[1]:TS_UNDEFINED); }
static tsv ts_asyncgenproto_return(tsv* a, int n){ return ts_asyncgen_return(n?a[0]:TS_UNDEFINED, n>1?a[1]:TS_UNDEFINED); }
static tsv ts_asyncgenproto_throw(tsv* a, int n){ return ts_asyncgen_throw(n?a[0]:TS_UNDEFINED, n>1?a[1]:TS_UNDEFINED); }
static void ts_generator_proto_init(int async){
  if (g_generator_protos[async] != TS_NULL) return;
  static int rooted[2];
  g_generator_protos[async] = ts_new_proto();
  ts_root_static_once(&g_generator_protos[async], &rooted[async]);
  const char* names[] = {"next", "return", "throw"};
  ts_code methods[] = {
    async ? ts_asyncgenproto_next : ts_genproto_next,
    async ? ts_asyncgenproto_return : ts_genproto_return,
    async ? ts_asyncgenproto_throw : ts_genproto_throw,
  };
  for (int i=0;i<3;i++){
    tsv method = ts_make_fn_t(methods[i], NULL, 0, 1); ts_gc_root(&method);
    ts_set_fn_meta(method, 1, names[i]);
    ts_define_data(g_generator_protos[async], ts_intern_field(names[i], (uint32_t)strlen(names[i])), method, 0, 1, 1);
    ts_gc_unroot(1);
  }
  tsv identity = ts_make_fn_t(ts_genproto_identity, NULL, 0, 1); ts_gc_root(&identity);
  ts_define_data(g_generator_protos[async], TS_KEY_WKSYM(async ? TS_WKSYM_ASYNC_ITERATOR : TS_WKSYM_ITERATOR), identity, 0, 1, 1);
  /* %GeneratorPrototype%[@@toStringTag] (Object.prototype.toString) */
  tsv tag = async ? ts_new_string("AsyncGenerator", 14) : ts_new_string("Generator", 9); ts_gc_root(&tag);
  ts_define_data(g_generator_protos[async], TS_KEY_WKSYM(TS_WKSYM_TO_STRING_TAG), tag, 0, 0, 1);
  ts_gc_unroot(2);
}
tsv ts_gen_new_v(tsv cv){
  ts_gc_root(&cv);
  ensure_gen_fields();
  ts_generator_proto_init(0);
  tsv g = ts_new_object();
  ts_gc_root(&g);
  obj_link_fresh_proto(g, g_generator_protos[0]);
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
  /* The `next` lookups through a four-entry cache (own slot, prototype slot
     or absent, by receiver shape): the Map/Set and array iterators and the
     generator objects are a handful of shapes. */
  /* `next` lives on the iterator's prototype (the Map/Set and array iterator
     protos, a class prototype); the cached read locates it through the own
     shape (no own `next`), the prototype handle and the prototype's shape, and
     reads the slot each time (a reassigned method keeps its slot; an added or
     deleted property changes a shape). Four entries: the iterator kinds of a
     compile are a handful. */
  static ts_key k_next;
  static struct { uint32_t shape, proto_shape, slot; tsv proto; } nc[4];
  static uint32_t nc_next;
  if (!k_next) k_next = ts_intern_field("next", 4);
  ts_gc_root(&iter); ts_gc_root(&sent);
  tsv nf = TS_UNDEFINED;
  int cached = 0;
  if (TS_TOP16(iter) == TS_SEL_OBJECT){
    ts_object* o = (ts_object*)ts_ptr(iter);
    if (o->h.kind == TS_KIND_OBJECT && ts_is_obj(o->proto)){
      for (uint32_t i = 0; i < 4u; i++){
        if (nc[i].shape == o->shape && nc[i].proto == o->proto){
          ts_object* p = (ts_object*)ts_ptr(o->proto);
          if (p->shape == nc[i].proto_shape){ nf = *ts_obj_slot_ptr(p, nc[i].slot); cached = 1; }
          break;
        }
      }
    }
  }
  if (!cached){
    nf = ts_get(iter, k_next);
    if (!ts_is_callable(nf)) nf = ts_get(iter, nmk);
    else if (TS_TOP16(iter) == TS_SEL_OBJECT){
      /* fill: an own-shaped iterator without an own `next`, the direct prototype
         holding `next` as a plain data slot */
      ts_object* o = (ts_object*)ts_ptr(iter);
      if (o->h.kind == TS_KIND_OBJECT && obj_shaped(o) && !pref_ok(prop_find(o, k_next)) && ts_is_obj(o->proto)){
        ts_object* p = (ts_object*)ts_ptr(o->proto);
        if (p->h.kind == TS_KIND_OBJECT && obj_shaped(p)){
          ts_pref pr = prop_find(p, k_next);
          if (pref_ok(pr) && !pref_is_accessor(pr)){
            uint32_t i = nc_next++ & 3u;
            nc[i].shape = o->shape; nc[i].proto = o->proto; nc[i].proto_shape = p->shape; nc[i].slot = pr.i;
          }
        }
      }
    }
  }
  ts_gc_root(&nf);
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
  tsv cv = ts_get_ic(genobj, F_coro, &g_ic_coro);
  ts_gc_root(&cv);
  if (!ts_is_coro_value(cv)){
    ts_gc_unroot(4);
    ts_throw_type_error_msg("Generator.prototype.next called on incompatible receiver");
  }
  ts_coro* c = (ts_coro*)ts_ptr(cv);
  if (c->gen_status==TS_GEN_EXECUTING) gen_throw_busy();
  if (c->done || c->gen_status==TS_GEN_COMPLETED){
    c->done=1; c->gen_status=TS_GEN_COMPLETED;
    ts_set(result, F_value, TS_UNDEFINED);
    ts_set(result, F_done, ts_bool(1));
    ts_gc_unroot(4);
    return result;
  }
  if (c->gen_status==TS_GEN_SUSPENDED_START){
    c->result=TS_UNDEFINED;    /* the first next(value) argument is ignored */
  } else {
    c->result = sent;          /* value handed to the resuming yield */
    ts_write_barrier(cv, sent);
  }
  c->rejected=0;
  c->yielded = TS_UNDEFINED;
  c->gen_status=TS_GEN_EXECUTING;
  int threw=0;
  tsv exc=coro_resume_catching_v(cv,&threw);
  c = (ts_coro*)ts_ptr(cv);
  if (threw){
    c->done=1; c->gen_status=TS_GEN_COMPLETED;
    ts_gc_unroot(4);
    ts_throw(exc);
  }
  if (c->done){
    c->gen_status=TS_GEN_COMPLETED;
    /* on completion, c->yielded holds the return value (set by Return) */
    ts_set(result, F_value, c->yielded);
    ts_set(result, F_done, ts_bool(1));
  } else {
    c->gen_status=TS_GEN_SUSPENDED_YIELD;
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
  tsv cv = ts_get_ic(genobj, F_coro, &g_ic_coro);
  ts_gc_root(&cv);
  if (!ts_is_coro_value(cv)){ ts_gc_unroot(4); ts_throw_type_error_msg("Generator.prototype.throw called on incompatible receiver"); }
  ts_coro* c = (ts_coro*)ts_ptr(cv);
  if (c->gen_status==TS_GEN_EXECUTING) gen_throw_busy();
  if (c->gen_status==TS_GEN_SUSPENDED_START){
    c->done=1; c->gen_status=TS_GEN_COMPLETED;
    ts_gc_unroot(4);
    ts_throw(exc);
  }
  if (c->done || c->gen_status==TS_GEN_COMPLETED){
    c->done=1; c->gen_status=TS_GEN_COMPLETED;
    ts_gc_unroot(4);
    ts_throw(exc);
  }
  c->rejected = 1;                     /* "raise c->result at the resume point" */
  c->result = exc;
  ts_write_barrier(cv, exc);
  c->yielded = TS_UNDEFINED;
  c->gen_status=TS_GEN_EXECUTING;
  int threw=0;
  tsv escaped=coro_resume_catching_v(cv,&threw);
  c = (ts_coro*)ts_ptr(cv);
  if (threw){
    c->done=1; c->gen_status=TS_GEN_COMPLETED;
    ts_gc_unroot(4);
    ts_throw(escaped);
  }
  if (c->done){
    c->gen_status=TS_GEN_COMPLETED;
    ts_set(result, F_value, c->yielded);
    ts_set(result, F_done, ts_bool(1));
  } else {
    c->gen_status=TS_GEN_SUSPENDED_YIELD;
    ts_set(result, F_value, c->yielded);
    ts_set(result, F_done, ts_bool(0));
  }
  ts_gc_unroot(4);
  return result;
}

/* .return(v) injects an internal return completion at the suspended yield. User
   catch clauses skip it, finally landing pads translate it to completion-kind 2,
   so cleanup may yield/throw/override before the generator completes. */
tsv ts_gen_return(tsv genobj, tsv val){
  ensure_gen_fields();
  ts_gc_root(&genobj); ts_gc_root(&val);
  tsv result = ts_new_object();
  ts_gc_root(&result);
  if (!ts_is_obj(genobj)){
    ts_set(result, F_value, val); ts_set(result, F_done, ts_bool(1)); ts_gc_unroot(3); return result;
  }
  tsv cv = ts_get_ic(genobj, F_coro, &g_ic_coro);
  ts_gc_root(&cv);
  if (!ts_is_coro_value(cv)){ ts_gc_unroot(4); ts_throw_type_error_msg("Generator.prototype.return called on incompatible receiver"); }
  ts_coro* c = (ts_coro*)ts_ptr(cv);
  if (c->gen_status==TS_GEN_EXECUTING) gen_throw_busy();
  if (c->done || c->gen_status==TS_GEN_COMPLETED || c->gen_status==TS_GEN_SUSPENDED_START){
    c->done=1; c->gen_status=TS_GEN_COMPLETED;
    ts_set(result,F_value,val); ts_set(result,F_done,ts_bool(1));
    ts_gc_unroot(4);
    return result;
  }
  tsv completion=ts_gen_return_completion(val); ts_gc_root(&completion);
  c=(ts_coro*)ts_ptr(cv);
  c->rejected=1; c->result=completion; c->yielded=TS_UNDEFINED;
  ts_write_barrier(cv,completion);
  c->gen_status=TS_GEN_EXECUTING;
  int threw=0;
  tsv escaped=coro_resume_catching_v(cv,&threw);
  c=(ts_coro*)ts_ptr(cv);
  if (threw){
    if (ts_is_gen_return_completion(escaped)){
      c->done=1; c->gen_status=TS_GEN_COMPLETED;
      ts_set(result,F_value,ts_gen_return_completion_value(escaped));
      ts_set(result,F_done,ts_bool(1));
      ts_gc_unroot(5);
      return result;
    }
    c->done=1; c->gen_status=TS_GEN_COMPLETED;
    ts_gc_unroot(5);
    ts_throw(escaped);
  }
  if (c->done){
    c->gen_status=TS_GEN_COMPLETED;
    ts_set(result,F_value,c->yielded);
    ts_set(result,F_done,ts_bool(1));
  } else {
    c->gen_status=TS_GEN_SUSPENDED_YIELD;
    ts_set(result,F_value,c->yielded);
    ts_set(result,F_done,ts_bool(0));
  }
  ts_gc_unroot(1);
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
  ts_gc_root(&cv);
  ensure_gen_fields();
  ts_generator_proto_init(1);
  if (ts_is_coro_value(cv)) ((ts_coro*)ts_ptr(cv))->is_asyncgen=1;
  tsv g = ts_new_object();
  ts_gc_root(&g);
  obj_link_fresh_proto(g, g_generator_protos[1]);
  ts_set(g, F_coro, cv);
  ts_gc_unroot(2);
  return g;
}
static void asyncgen_pop_head(ts_coro* c){
  ts_asyncgen_req* r=c->ag_head;
  if (!r) return;
  c->ag_head=r->next;
  if (!c->ag_head) c->ag_tail=NULL;
  free(r);
}
static void asyncgen_settle_completed(ts_asyncgen_req* r){
  if (r->kind==1) ts_promise_reject_v(r->promise,r->value);
  else {
    tsv value=r->kind==2 ? r->value : TS_UNDEFINED;
    ts_gc_root(&value);
    tsv ir=ts_iter_result(value,1); ts_gc_root(&ir);
    ts_promise_resolve_v(r->promise,ir);
    ts_gc_unroot(2);
  }
}
typedef struct { ts_coro c; tsv gen_v; int resume_generator; } ts_asyncgen_return_wait;
static tsv asyncgen_return_wait_resume(tsv av){
  ts_asyncgen_return_wait* w=(ts_asyncgen_return_wait*)ts_ptr(av);
  tsv gen=w->gen_v, value=w->c.result;
  int rejected=w->c.rejected;
  ts_gc_root(&gen); ts_gc_root(&value);
  ts_coro* c=ts_is_coro_value(gen) ? (ts_coro*)ts_ptr(gen) : NULL;
  ts_asyncgen_req* r=c ? c->ag_head : NULL;
  if (r && w->resume_generator){
    r->value=value;
    r->value_awaited=1;
    if (rejected) r->kind=1;
    c->ag_running=0;
    c->gen_status=TS_GEN_SUSPENDED_YIELD;
    ts_write_barrier(gen,value);
    ts_gc_unroot(2);
    asyncgen_start_next_v(gen);
    return TS_UNDEFINED;
  }
  if (r){
    if (rejected) ts_promise_reject_v(r->promise,value);
    else {
      tsv ir=ts_iter_result(value,1); ts_gc_root(&ir);
      ts_promise_resolve_v(r->promise,ir);
      ts_gc_unroot(1);
    }
  }
  int kick=asyncgen_after_resume_v(gen);
  ts_gc_unroot(2);
  if (kick) asyncgen_start_next_v(gen);
  return TS_UNDEFINED;
}
static void asyncgen_start_next_v(tsv cv){
  if (!ts_is_coro_value(cv)) return;
  ts_gc_root(&cv);
  for (;;){
    ts_coro* c=(ts_coro*)ts_ptr(cv);
    if (!c || !c->is_asyncgen || c->ag_running || !c->ag_head){ ts_gc_unroot(1); return; }
    ts_asyncgen_req* r=c->ag_head;
    if (c->done || c->gen_status==TS_GEN_COMPLETED ||
        (c->gen_status==TS_GEN_SUSPENDED_START && r->kind!=0)){
      if (c->gen_status==TS_GEN_SUSPENDED_START && r->kind!=0){
        c->done=1; c->gen_status=TS_GEN_COMPLETED;
      }
      /* AsyncGenerator.prototype.return awaits its argument even when the
         generator has not started or has already completed. Keep this request
         at the queue head until that await settles so later requests cannot
         overtake it. */
      if (r->kind==2){
        c->ag_running=1;
        tsv av=ts_coro_alloc_v(sizeof(ts_asyncgen_return_wait),asyncgen_return_wait_resume);
        ts_gc_root(&av);
        ts_asyncgen_return_wait* w=(ts_asyncgen_return_wait*)ts_ptr(av);
        w->gen_v=cv; w->resume_generator=0; ts_write_barrier(av,cv);
        tsv value=r->value; ts_gc_root(&value);
        ts_await_register_v(value,av);
        ts_gc_unroot(2);
        ts_gc_unroot(1);
        return;
      }
      asyncgen_settle_completed(r);
      c=(ts_coro*)ts_ptr(cv);
      asyncgen_pop_head(c);
      continue;
    }
    if (r->kind==2 && !r->value_awaited){
      /* A return request first awaits its argument. Fulfillment resumes the
         generator with a return completion; rejection resumes it as a throw,
         allowing user catch/finally code to observe the rejection. */
      c->ag_running=1;
      c->gen_status=TS_GEN_EXECUTING;
      tsv av=ts_coro_alloc_v(sizeof(ts_asyncgen_return_wait),asyncgen_return_wait_resume);
      ts_gc_root(&av);
      ts_asyncgen_return_wait* w=(ts_asyncgen_return_wait*)ts_ptr(av);
      w->gen_v=cv; w->resume_generator=1; ts_write_barrier(av,cv);
      tsv value=r->value; ts_gc_root(&value);
      ts_await_register_v(value,av);
      ts_gc_unroot(2);
      ts_gc_unroot(1);
      return;
    }
    tsv delivered=(c->gen_status==TS_GEN_SUSPENDED_START) ? TS_UNDEFINED : r->value;
    ts_gc_root(&delivered);
    if (r->kind==2) delivered=ts_gen_return_completion(r->value);
    c=(ts_coro*)ts_ptr(cv);
    c->ret=r->promise;
    c->result=delivered;
    c->rejected=r->kind!=0;
    c->ag_running=1;
    c->gen_status=TS_GEN_EXECUTING;
    ts_write_barrier(cv,c->ret); ts_write_barrier(cv,delivered);
    ts_gc_unroot(1);
    ts_coro_resume_v(cv);
    ts_gc_unroot(1);
    return;
  }
}
static tsv asyncgen_enqueue(tsv genobj, tsv value, int kind){
  ensure_gen_fields();
  ts_gc_root(&genobj); ts_gc_root(&value);
  if (!ts_is_obj(genobj)){
    tsv err=promise_resolution_type_error("AsyncGenerator method called on incompatible receiver");
    ts_gc_root(&err);
    tsv p=ts_promise_rejected(err);
    ts_gc_unroot(3);
    return p;
  }
  tsv cv=ts_get_ic(genobj, F_coro, &g_ic_coro); ts_gc_root(&cv);
  if (!ts_is_coro_value(cv) || !((ts_coro*)ts_ptr(cv))->is_asyncgen){
    tsv err=promise_resolution_type_error("AsyncGenerator method called on incompatible receiver");
    ts_gc_root(&err);
    tsv p=ts_promise_rejected(err);
    ts_gc_unroot(4);
    return p;
  }
  tsv pv=ts_promise_new_v(); ts_gc_root(&pv);
  ts_asyncgen_req* r=(ts_asyncgen_req*)calloc(1,sizeof(ts_asyncgen_req));
  if (!r) ts_abort_msg("out of memory growing async generator request queue");
  r->promise=pv; r->value=value; r->kind=kind;
  ts_coro* c=(ts_coro*)ts_ptr(cv);
  if (c->ag_tail) c->ag_tail->next=r; else c->ag_head=r;
  c->ag_tail=r;
  ts_write_barrier(cv,pv); ts_write_barrier(cv,value);
  int kick=!c->ag_running;
  if (kick) asyncgen_start_next_v(cv);
  ts_gc_unroot(4);
  return pv;
}

tsv ts_asyncgen_next(tsv genobj, tsv sent){
  return asyncgen_enqueue(genobj,sent,0);
}

tsv ts_asyncgen_throw(tsv genobj, tsv exc){
  return asyncgen_enqueue(genobj,exc,1);
}

tsv ts_asyncgen_return(tsv genobj, tsv val){
  return asyncgen_enqueue(genobj,val,2);
}


void ts_abort_msg(const char* m){ fflush(stdout); fprintf(stderr, "tsaot: %s\n", m); fflush(stderr); abort(); }
int ts_handlers_count(void){ int n=0; for(ts_handler* h=g_handlers;h;h=h->prev)n++; return n; }
