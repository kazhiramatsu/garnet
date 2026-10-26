/* tests/math_v8_parity: Math's transcendental functions of runtime/ts_ieee754.c against
   Node's, over 100,000 pseudo-random inputs in six ranges per function and the edge cases;
   harness.mjs computes the same hashes with V8. run.sh compares the outputs. The inputs and
   the hash fold use only exact operations, so a differing line is a differing result. */
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <stdlib.h>
#include "ts_ieee754.c"   /* -I runtime */
static uint32_t st;
static uint32_t u32(void){ st += 0x6D2B79F5u; uint32_t t = st; t = (t ^ (t >> 15)) * (t | 1u); t ^= t + (t ^ (t >> 7)) * (t | 61u); return t ^ (t >> 14); }
static double unit(void){ return u32() / 4294967296.0; }
static const double scales[8] = {1e-6, 1e-3, 1.0, 10.0, 100.0, 1000.0, 1e6, 1e15};
static double two_pow[1100];
static double gen(int g){
  switch (g){
    case 0: { uint32_t s = u32() % 8; return (unit() * 2 - 1) * scales[s]; }          /* wide */
    case 1: return unit() * 2 - 1;                                                      /* unit */
    case 2: { uint32_t s = u32() % 8; return unit() * scales[s]; }                      /* pos */
    case 3: { uint32_t s = u32() % 8; return 1 + unit() * scales[s]; }                  /* ge1 */
    case 4: { uint32_t e = u32() % 1100; double m = unit() * 2 - 1; return m * two_pow[e]; } /* huge/tiny exponents */
    default: return unit() * 2.2250738585072014e-308;                                   /* subnormal */
  }
}
static uint32_t h;
static void feed(double y){
  uint64_t b; memcpy(&b, &y, 8);
  if (y != y) b = 0x7FF8000000000000ULL;
  h = h * 31u + (uint32_t)(b >> 32); h = h * 31u + (uint32_t)b;
}
typedef double (*f1)(double); typedef double (*f2)(double, double);
static void run1(const char* name, f1 f, int g, int idx){
  st = 1234u + 7919u * (uint32_t)idx; h = 0;
  for (int i = 0; i < 100000; i++) feed(f(gen(g)));
  printf("%s/%d %d\n", name, g, (int32_t)h);
}
static double pw(double x){ (void)x; return 0; }
static void run2(const char* name, f2 f, int ga, int gb, int idx, int powy){
  st = 1234u + 7919u * (uint32_t)idx; h = 0;
  for (int i = 0; i < 100000; i++){
    double x = gen(ga), y;
    if (powy){ uint32_t k = u32() % 3; if (k == 0) y = (double)(int)(u32() % 41) - 20; else if (k == 1) y = (u32() & 1) ? 0.5 : -0.5; else y = (unit() * 2 - 1) * 10; }
    else y = gen(gb);
    feed(f(x, y));
  }
  printf("%s/%d%d %d\n", name, ga, gb, (int32_t)h);
}
static void edge1(const char* name, f1 f, const double* E, int n){
  for (int i = 0; i < n; i++){ double y = f(E[i]); uint64_t b; memcpy(&b, &y, 8); if (y != y) b = 0x7FF8000000000000ULL; printf("%s[%d] %016llx\n", name, i, (unsigned long long)b); }
}
static void edge2(const char* name, f2 f, const double* E, int n){
  for (int i = 0; i < n; i++) for (int j = 0; j < n; j++){ double y = f(E[i], E[j]); uint64_t b; memcpy(&b, &y, 8); if (y != y) b = 0x7FF8000000000000ULL; printf("%s[%d,%d] %016llx\n", name, i, j, (unsigned long long)b); }
}
static void dump1(const char* name, f1 f, int g, int idx){
  st = 1234u + 7919u * (uint32_t)idx;
  for (int i = 0; i < 100000; i++){ double x = gen(g), y = f(x); uint64_t bx, by; memcpy(&bx, &x, 8); memcpy(&by, &y, 8); if (y != y) by = 0x7FF8000000000000ULL; printf("%d %016llx %016llx\n", i, (unsigned long long)bx, (unsigned long long)by); }
}
int main(int argc, char** argv){
  (void)pw;
  if (argc == 4){ /* dump <name> <gen>: every input and output of one run */
    double p0 = 1.0; for (int i = 0; i < 50; i++) p0 /= 2; for (int e = 0; e < 1100; e++){ two_pow[e] = p0; p0 *= 2; }
    const char* nm = argv[2]; int g = atoi(argv[3]);
    struct { const char* n; f1 f; } FF[] = {{"exp", ts_m_exp}, {"expm1", ts_m_expm1}, {"log", ts_m_log}, {"log1p", ts_m_log1p}, {"log2", ts_m_log2}, {"log10", ts_m_log10}, {"sin", ts_m_sin}, {"cos", ts_m_cos}, {"tan", ts_m_tan}, {"asin", ts_m_asin}, {"acos", ts_m_acos}, {"atan", ts_m_atan}, {"sinh", ts_m_sinh}, {"cosh", ts_m_cosh}, {"tanh", ts_m_tanh}, {"asinh", ts_m_asinh}, {"acosh", ts_m_acosh}, {"atanh", ts_m_atanh}, {"cbrt", ts_m_cbrt}};
    for (unsigned k = 0; k < sizeof(FF) / sizeof(FF[0]); k++) if (strcmp(FF[k].n, nm) == 0){ dump1(nm, FF[k].f, g, (int)k * 6 + g); return 0; }
    return 1;
  }
  double p = 1.0; for (int i = 0; i < 50; i++) p /= 2; for (int e = 0; e < 1100; e++){ two_pow[e] = p; p *= 2; }
  const double E[] = {0.0, -0.0, 1.0, -1.0, INFINITY, -INFINITY, NAN, 2.2250738585072014e-308, 5e-324, 1.7976931348623157e308, 0.9999999999999999, 1.0000000000000002, 709.782712893384, -745.1332191019411, 0.5, 2.0, 10.0, 1e-300, 3.141592653589793, 1.5707963267948966, 1e22, 1152921504606846976.0, -1152921504606846976.0, 1e308, -0.5, 3.0, 0.1, -2.5};
  const int nE = (int)(sizeof(E) / sizeof(E[0]));
  struct { const char* n; f1 f; } F[] = {{"exp", ts_m_exp}, {"expm1", ts_m_expm1}, {"log", ts_m_log}, {"log1p", ts_m_log1p}, {"log2", ts_m_log2}, {"log10", ts_m_log10}, {"sin", ts_m_sin}, {"cos", ts_m_cos}, {"tan", ts_m_tan}, {"asin", ts_m_asin}, {"acos", ts_m_acos}, {"atan", ts_m_atan}, {"sinh", ts_m_sinh}, {"cosh", ts_m_cosh}, {"tanh", ts_m_tanh}, {"asinh", ts_m_asinh}, {"acosh", ts_m_acosh}, {"atanh", ts_m_atanh}, {"cbrt", ts_m_cbrt}};
  int idx = 0;
  for (unsigned k = 0; k < sizeof(F) / sizeof(F[0]); k++) for (int g = 0; g < 6; g++) run1(F[k].n, F[k].f, g, idx++);
  run2("atan2", ts_m_atan2, 0, 0, idx++, 0); run2("atan2", ts_m_atan2, 4, 0, idx++, 0); run2("atan2", ts_m_atan2, 5, 5, idx++, 0);
  run2("pow", ts_m_pow, 0, 9, idx++, 1); run2("pow", ts_m_pow, 4, 9, idx++, 1); run2("pow", ts_m_pow, 2, 9, idx++, 1);
  for (unsigned k = 0; k < sizeof(F) / sizeof(F[0]); k++) edge1(F[k].n, F[k].f, E, nE);
  edge2("atan2", ts_m_atan2, E, nE); edge2("pow", ts_m_pow, E, nE);
  return 0;
}
