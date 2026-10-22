/* How per-isolate state could be reached (docs/threads_design.md, "Isolate
   state"): one frame push and pop through a plain global (today), through a
   thread-local pointer to an isolate struct, and through an isolate block at
   the base of a stack region aligned to its size (the stack pointer masked).
     cc -O2 -o /tmp/isolate_access benchmarks/threads/isolate_access.c && /tmp/isolate_access */
#include <stdint.h>
#include <stdio.h>
#include <time.h>
#include <pthread.h>
#include <sys/mman.h>

typedef struct frame { struct frame* prev; uint32_t count; } frame;
typedef struct { frame* top; long pad[7]; } iso_t;
#define REGION ((uintptr_t)64 << 20)   /* a thread's stack region, aligned to its size */

frame* g_top;               /* external, so the loops are not folded away */
__thread iso_t* t_iso;

static inline iso_t* iso_from_sp(void){
  uintptr_t sp;
#if defined(__aarch64__)
  __asm__("mov %0, sp" : "=r"(sp));
#elif defined(__x86_64__)
  __asm__("mov %%rsp, %0" : "=r"(sp));
#else
  sp = (uintptr_t)__builtin_frame_address(0);
#endif
  return (iso_t*)(sp & ~(REGION - 1));
}
static double now(void){ struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec * 1e-9; }
__attribute__((noinline)) void push_pop_global(frame* f){ f->prev = g_top; g_top = f; g_top = f->prev; }
__attribute__((noinline)) void push_pop_tls(frame* f){ iso_t* i = t_iso; f->prev = i->top; i->top = f; i->top = f->prev; }
__attribute__((noinline)) void push_pop_sp(frame* f){ iso_t* i = iso_from_sp(); f->prev = i->top; i->top = f; i->top = f->prev; }

static void* body(void* arg){
  frame f; t_iso = (iso_t*)arg; const long n = 300000000;
  if (iso_from_sp() != (iso_t*)arg){ printf("the stack is not where the isolate block expects it\n"); return NULL; }
  for (int round = 0; round < 2; round++){
    double t0 = now(); for (long i = 0; i < n; i++) push_pop_global(&f);
    double t1 = now(); for (long i = 0; i < n; i++) push_pop_tls(&f);
    double t2 = now(); for (long i = 0; i < n; i++) push_pop_sp(&f);
    double t3 = now();
    printf("ns per push/pop: global %.2f  thread-local isolate pointer %.2f  stack-aligned isolate block %.2f\n",
           (t1 - t0) / n * 1e9, (t2 - t1) / n * 1e9, (t3 - t2) / n * 1e9);
  }
  return NULL;
}
int main(void){
  char* raw = mmap(NULL, 2 * REGION, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
  if (raw == MAP_FAILED) return 1;
  char* base = (char*)(((uintptr_t)raw + REGION - 1) & ~(REGION - 1));
  pthread_attr_t a; pthread_attr_init(&a);
  pthread_attr_setstack(&a, base + 16384, REGION - 16384);   /* the block below the stack */
  pthread_t t;
  if (pthread_create(&t, &a, body, base) != 0) return 1;
  pthread_join(t, NULL);
  return 0;
}
