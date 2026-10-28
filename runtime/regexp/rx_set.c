/* rx_set.c: the parse arena and code point sets (docs/regexp_vm_design.md). */
#include "rx_internal.h"

/* ---- arena ---- */
void* rx_arena_alloc(rx_arena* a, size_t n){
  n = (n + 15u) & ~(size_t)15u;
  rx_arena_chunk* c = a->head;
  if (!c || c->cap - c->used < n){
    size_t cap = n > 32768 ? n : 32768;
    c = (rx_arena_chunk*)malloc(sizeof(rx_arena_chunk) + cap);
    if (!c) abort();
    c->next = a->head; c->used = 0; c->cap = cap;
    a->head = c;
  }
  void* p = c->data + c->used;
  c->used += n;
  memset(p, 0, n);
  return p;
}
void rx_arena_free(rx_arena* a){
  rx_arena_chunk* c = a->head;
  while (c){ rx_arena_chunk* n = c->next; free(c); c = n; }
  a->head = NULL;
}

/* ---- sets ---- */
static void cpset_reserve(rx_arena* a, rx_cpset* s, uint32_t npairs){
  if (s->cap >= npairs) return;
  uint32_t cap = s->cap ? s->cap : 8;
  while (cap < npairs) cap *= 2;
  uint32_t* r = (uint32_t*)rx_arena_alloc(a, sizeof(uint32_t) * 2 * cap);
  if (s->n) memcpy(r, s->r, sizeof(uint32_t) * 2 * s->n);
  s->r = r; s->cap = cap;
}
/* insert [lo, hi], merging neighbours; the pairs stay sorted and disjoint */
void rx_cpset_add(rx_arena* a, rx_cpset* s, uint32_t lo, uint32_t hi){
  if (lo > hi) return;
  uint64_t L = lo, H = hi;
  uint32_t i = 0;
  while (i < s->n && (uint64_t)s->r[2*i+1] + 1u < L) i++;   /* pairs ending before lo with a gap */
  uint32_t j = i;
  while (j < s->n && (uint64_t)s->r[2*j] <= H + 1u) j++;    /* pairs touching or overlapping [lo, hi] */
  if (j == i){
    cpset_reserve(a, s, s->n + 1);
    memmove(s->r + 2*(i+1), s->r + 2*i, sizeof(uint32_t) * 2 * (s->n - i));
    s->r[2*i] = lo; s->r[2*i+1] = hi; s->n++;
    return;
  }
  uint32_t nlo = lo < s->r[2*i] ? lo : s->r[2*i];
  uint32_t nhi = hi > s->r[2*(j-1)+1] ? hi : s->r[2*(j-1)+1];
  s->r[2*i] = nlo; s->r[2*i+1] = nhi;
  if (j > i + 1){
    memmove(s->r + 2*(i+1), s->r + 2*j, sizeof(uint32_t) * 2 * (s->n - j));
    s->n -= (j - i - 1);
  }
}
void rx_cpset_add_ranges(rx_arena* a, rx_cpset* s, const uint32_t* pairs, uint32_t n){
  for (uint32_t i = 0; i < n; i++) rx_cpset_add(a, s, pairs[2*i], pairs[2*i+1]);
}
void rx_cpset_add_set(rx_arena* a, rx_cpset* s, const rx_cpset* t){
  rx_cpset_add_ranges(a, s, t->r, t->n);
}
rx_cpset rx_cpset_invert(rx_arena* a, const rx_cpset* s, uint32_t max){
  rx_cpset out = {0, 0, 0};
  uint32_t cur = 0;
  for (uint32_t i = 0; i < s->n; i++){
    uint32_t lo = s->r[2*i], hi = s->r[2*i+1];
    if (lo > max) break;
    if (lo > cur) rx_cpset_add(a, &out, cur, lo - 1);
    if (hi >= max){ cur = max + 1; break; }
    cur = hi + 1;
  }
  if (cur <= max) rx_cpset_add(a, &out, cur, max);
  return out;
}
rx_cpset rx_cpset_intersect(rx_arena* a, const rx_cpset* s, const rx_cpset* t){
  rx_cpset out = {0, 0, 0};
  uint32_t i = 0, j = 0;
  while (i < s->n && j < t->n){
    uint32_t lo = s->r[2*i] > t->r[2*j] ? s->r[2*i] : t->r[2*j];
    uint32_t hi = s->r[2*i+1] < t->r[2*j+1] ? s->r[2*i+1] : t->r[2*j+1];
    if (lo <= hi) rx_cpset_add(a, &out, lo, hi);
    if (s->r[2*i+1] < t->r[2*j+1]) i++; else j++;
  }
  return out;
}
rx_cpset rx_cpset_subtract(rx_arena* a, const rx_cpset* s, const rx_cpset* t){
  rx_cpset inv = rx_cpset_invert(a, t, RX_MAX_CP);
  return rx_cpset_intersect(a, s, &inv);
}
int rx_ranges_has(const uint32_t* pairs, uint32_t n, uint32_t cp){
  uint32_t lo = 0, hi = n;
  while (lo < hi){
    uint32_t mid = (lo + hi) / 2;
    if (cp < pairs[2*mid]) hi = mid;
    else if (cp > pairs[2*mid+1]) lo = mid + 1;
    else return 1;
  }
  return 0;
}
int rx_cpset_has(const rx_cpset* s, uint32_t cp){ return rx_ranges_has(s->r, s->n, cp); }

/* { m in s unmapped } ∪ { image(m) : m in s mapped }, for the (cp, image) pairs sorted by cp */
rx_cpset rx_cpset_map(rx_arena* a, const rx_cpset* s, const uint32_t* pairs, uint32_t n){
  rx_cpset keys = {0, 0, 0};
  for (uint32_t i = 0; i < n; i++) rx_cpset_add(a, &keys, pairs[2*i], pairs[2*i]);
  rx_cpset out = rx_cpset_subtract(a, s, &keys);
  for (uint32_t i = 0; i < n; i++) if (rx_cpset_has(s, pairs[2*i])) rx_cpset_add(a, &out, pairs[2*i+1], pairs[2*i+1]);
  return out;
}
