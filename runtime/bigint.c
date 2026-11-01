/* BigInt (docs/bigint_design.md). Included at the end of ts_rt.c.

   A value is an immutable cell: a sign and 64-bit limbs, least significant first, no leading zero limb, no
   negative zero. An operation reads its operands' limbs (nothing here allocates a cell meanwhile), works in
   malloc'd scratch and makes the result cell last, so a collection cannot move anything under it. */

#define BIG_MAX_LIMBS (1u << 24)   /* 2^30 bits, V8's limit */
#define BIG_KARATSUBA 32u          /* limbs of the shorter operand */
typedef unsigned __int128 big_u128;

static inline ts_bigint* big_ptr(tsv v){ return (ts_bigint*)ts_ptr(v); }

static void big_too_big(void){ ts_throw_range_error_msg("Maximum BigInt size exceeded"); }
static void* big_alloc_scratch(size_t limbs){
  uint64_t* p = (uint64_t*)calloc(limbs ? limbs : 1, sizeof(uint64_t));
  if (!p) abort();
  return p;
}
/* the cell of a magnitude; `d` is the caller's */
static tsv big_make(const uint64_t* d, uint32_t n, int neg){
  while (n && d[n - 1] == 0) n--;
  if (n > BIG_MAX_LIMBS) big_too_big();
  g_has_bigint = 1;
  ts_bigint* b = (ts_bigint*)gc_alloc(sizeof(ts_bigint) + (size_t)n * sizeof(uint64_t), TS_KIND_BIGINT);
  b->len = n; b->neg = n != 0 && neg;
  if (n) memcpy(b->limb, d, (size_t)n * sizeof(uint64_t));
  return ts_obj(b);
}
static tsv big_from_u64(uint64_t u, int neg){ return big_make(&u, 1, neg); }
static tsv big_from_i64(int64_t i){ return i < 0 ? big_from_u64((uint64_t)0 - (uint64_t)i, 1) : big_from_u64((uint64_t)i, 0); }

/* ---- magnitudes ---- */
static int mag_cmp(const uint64_t* a, uint32_t an, const uint64_t* b, uint32_t bn){
  if (an != bn) return an < bn ? -1 : 1;
  for (uint32_t i = an; i-- > 0;) if (a[i] != b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
/* r has room for max(an, bn) + 1 limbs */
static uint32_t mag_add(uint64_t* r, const uint64_t* a, uint32_t an, const uint64_t* b, uint32_t bn){
  if (an < bn){ const uint64_t* t = a; a = b; b = t; uint32_t u = an; an = bn; bn = u; }
  uint64_t carry = 0;
  uint32_t i = 0;
  for (; i < bn; i++){ big_u128 s = (big_u128)a[i] + b[i] + carry; r[i] = (uint64_t)s; carry = (uint64_t)(s >> 64); }
  for (; i < an; i++){ big_u128 s = (big_u128)a[i] + carry; r[i] = (uint64_t)s; carry = (uint64_t)(s >> 64); }
  r[i] = carry;
  return an + 1;
}
/* a >= b; r has room for an limbs */
static uint32_t mag_sub(uint64_t* r, const uint64_t* a, uint32_t an, const uint64_t* b, uint32_t bn){
  uint64_t borrow = 0;
  uint32_t i = 0;
  for (; i < bn; i++){
    uint64_t x = a[i], y = b[i], d = x - y, e = d - borrow;
    borrow = (x < y) | (d < borrow);
    r[i] = e;
  }
  for (; i < an; i++){ uint64_t x = a[i], e = x - borrow; borrow = x < borrow; r[i] = e; }
  return an;
}
static void mag_mul_school(uint64_t* r, const uint64_t* a, uint32_t an, const uint64_t* b, uint32_t bn){
  memset(r, 0, ((size_t)an + bn) * sizeof(uint64_t));
  for (uint32_t i = 0; i < bn; i++){
    uint64_t carry = 0, m = b[i];
    if (!m) continue;
    for (uint32_t j = 0; j < an; j++){
      big_u128 t = (big_u128)a[j] * m + r[i + j] + carry;
      r[i + j] = (uint64_t)t;
      carry = (uint64_t)(t >> 64);
    }
    r[i + an] = carry;
  }
}
/* add `b` into r at limb `at`; r has room for the carry */
static void mag_add_at(uint64_t* r, uint32_t rn, uint32_t at, const uint64_t* b, uint32_t bn){
  uint64_t carry = 0;
  uint32_t i = 0;
  for (; i < bn && at + i < rn; i++){ big_u128 s = (big_u128)r[at + i] + b[i] + carry; r[at + i] = (uint64_t)s; carry = (uint64_t)(s >> 64); }
  for (; carry && at + i < rn; i++){ big_u128 s = (big_u128)r[at + i] + carry; r[at + i] = (uint64_t)s; carry = (uint64_t)(s >> 64); }
}
/* r has room for an + bn limbs, and is not a or b */
static void mag_mul(uint64_t* r, const uint64_t* a, uint32_t an, const uint64_t* b, uint32_t bn){
  if (an < bn){ const uint64_t* t = a; a = b; b = t; uint32_t u = an; an = bn; bn = u; }
  if (bn < BIG_KARATSUBA){ mag_mul_school(r, a, an, b, bn); return; }
  if (an >= 2 * bn){   /* unbalanced: slices of a by b */
    memset(r, 0, ((size_t)an + bn) * sizeof(uint64_t));
    uint64_t* t = (uint64_t*)big_alloc_scratch((size_t)2 * bn);
    for (uint32_t i = 0; i < an; i += bn){
      uint32_t k = an - i < bn ? an - i : bn;
      mag_mul(t, a + i, k, b, bn);
      mag_add_at(r, an + bn, i, t, k + bn);
    }
    free(t);
    return;
  }
  /* Karatsuba: a = a1 B^k + a0, b = b1 B^k + b0 */
  uint32_t k = an / 2 + (an & 1u);
  if (k >= bn) k = bn - 1;
  uint32_t a1n = an - k, b1n = bn - k;
  size_t sn = (size_t)an + 2;
  uint64_t* sa = (uint64_t*)big_alloc_scratch(sn), *sb = (uint64_t*)big_alloc_scratch(sn);
  uint32_t san = mag_add(sa, a, k, a + k, a1n), sbn = mag_add(sb, b, k, b + k, b1n);
  uint64_t* z0 = (uint64_t*)big_alloc_scratch((size_t)2 * k);
  uint64_t* z2 = (uint64_t*)big_alloc_scratch((size_t)a1n + b1n);
  uint64_t* z1 = (uint64_t*)big_alloc_scratch((size_t)san + sbn);
  mag_mul(z0, a, k, b, k);
  mag_mul(z2, a + k, a1n, b + k, b1n);
  mag_mul(z1, sa, san, sb, sbn);
  uint32_t z1n = san + sbn;
  mag_sub(z1, z1, z1n, z0, 2 * k);
  mag_sub(z1, z1, z1n, z2, a1n + b1n);
  memset(r, 0, ((size_t)an + bn) * sizeof(uint64_t));
  memcpy(r, z0, (size_t)2 * k * sizeof(uint64_t));
  mag_add_at(r, an + bn, 2 * k, z2, a1n + b1n);
  while (z1n && z1[z1n - 1] == 0) z1n--;
  mag_add_at(r, an + bn, k, z1, z1n);
  free(sa); free(sb); free(z0); free(z1); free(z2);
}
/* Knuth's Algorithm D. u[0..un) / v[0..vn), vn >= 1, v[vn-1] != 0, un >= vn; q has un - vn + 1 limbs, r has vn */
static void mag_divrem(const uint64_t* u, uint32_t un, const uint64_t* v, uint32_t vn, uint64_t* q, uint64_t* r){
  if (vn == 1){
    uint64_t rem = 0, d = v[0];
    for (uint32_t i = un; i-- > 0;){
      big_u128 cur = ((big_u128)rem << 64) | u[i];
      q[i] = (uint64_t)(cur / d);
      rem = (uint64_t)(cur % d);
    }
    if (r) r[0] = rem;
    return;
  }
  int s = __builtin_clzll(v[vn - 1]);
  uint64_t* nv = (uint64_t*)big_alloc_scratch(vn), *nu = (uint64_t*)big_alloc_scratch((size_t)un + 1);
  for (uint32_t i = vn; i-- > 0;) nv[i] = (v[i] << s) | (s && i ? v[i - 1] >> (64 - s) : 0);
  nu[un] = s ? u[un - 1] >> (64 - s) : 0;
  for (uint32_t i = un; i-- > 0;) nu[i] = (u[i] << s) | (s && i ? u[i - 1] >> (64 - s) : 0);
  for (uint32_t j = un - vn + 1; j-- > 0;){
    big_u128 num = ((big_u128)nu[j + vn] << 64) | nu[j + vn - 1];
    big_u128 qhat = num / nv[vn - 1], rhat = num % nv[vn - 1];
    while ((qhat >> 64) != 0 || (big_u128)(uint64_t)qhat * nv[vn - 2] > ((rhat << 64) | nu[j + vn - 2])){
      qhat--;
      rhat += nv[vn - 1];
      if ((rhat >> 64) != 0) break;
    }
    uint64_t borrow = 0, carry = 0, qh = (uint64_t)qhat;
    for (uint32_t i = 0; i < vn; i++){
      big_u128 p = (big_u128)qh * nv[i] + carry;
      carry = (uint64_t)(p >> 64);
      uint64_t lo = (uint64_t)p, x = nu[i + j], d = x - lo, e = d - borrow;
      borrow = (x < lo) | (d < borrow);
      nu[i + j] = e;
    }
    uint64_t x = nu[j + vn], d = x - carry, e = d - borrow;
    uint64_t under = (x < carry) | (d < borrow);
    nu[j + vn] = e;
    if (under){
      qh--;
      uint64_t c = 0;
      for (uint32_t i = 0; i < vn; i++){ big_u128 t = (big_u128)nu[i + j] + nv[i] + c; nu[i + j] = (uint64_t)t; c = (uint64_t)(t >> 64); }
      nu[j + vn] += c;
    }
    q[j] = qh;
  }
  if (r) for (uint32_t i = 0; i < vn; i++) r[i] = (nu[i] >> s) | (s && i + 1 <= vn ? nu[i + 1] << (64 - s) : 0);
  free(nv); free(nu);
}
static uint64_t big_bit_length(const ts_bigint* b){
  if (!b->len) return 0;
  return (uint64_t)b->len * 64 - (uint64_t)__builtin_clzll(b->limb[b->len - 1]);
}

/* ---- arithmetic ---- */
static tsv big_add_signed(tsv av, tsv bv, int flip_b){
  ts_bigint* a = big_ptr(av), *b = big_ptr(bv);
  int bneg = flip_b ? !b->neg && b->len != 0 : b->neg;
  uint32_t n = (a->len > b->len ? a->len : b->len) + 1;
  uint64_t sb[32];
  uint64_t* r = n <= 32 ? sb : (uint64_t*)big_alloc_scratch(n);
  tsv out;
  if (a->neg == bneg){
    uint32_t rn = mag_add(r, a->limb, a->len, b->limb, b->len);
    out = big_make(r, rn, a->neg);
  } else {
    int c = mag_cmp(a->limb, a->len, b->limb, b->len);
    if (c >= 0){ mag_sub(r, a->limb, a->len, b->limb, b->len); out = big_make(r, a->len, a->neg); }
    else { mag_sub(r, b->limb, b->len, a->limb, a->len); out = big_make(r, b->len, bneg); }
  }
  if (r != sb) free(r);
  return out;
}
static tsv big_mul(tsv av, tsv bv){
  ts_bigint* a = big_ptr(av), *b = big_ptr(bv);
  if (!a->len || !b->len) return big_make(NULL, 0, 0);
  if ((uint64_t)a->len + b->len > (uint64_t)BIG_MAX_LIMBS + 1) big_too_big();
  uint32_t n = a->len + b->len;
  uint64_t sb[32];
  uint64_t* r = n <= 32 ? sb : (uint64_t*)big_alloc_scratch(n);
  mag_mul(r, a->limb, a->len, b->limb, b->len);
  tsv out = big_make(r, n, a->neg != b->neg);
  if (r != sb) free(r);
  return out;
}
/* truncates toward zero; a remainder takes the dividend's sign */
static tsv big_divrem(tsv av, tsv bv, int want_rem){
  ts_bigint* a = big_ptr(av), *b = big_ptr(bv);
  if (!b->len) ts_throw_range_error_msg("Division by zero");
  if (mag_cmp(a->limb, a->len, b->limb, b->len) < 0) return want_rem ? av : big_make(NULL, 0, 0);
  uint64_t* q = (uint64_t*)big_alloc_scratch((size_t)a->len - b->len + 1), *r = (uint64_t*)big_alloc_scratch(b->len);
  mag_divrem(a->limb, a->len, b->limb, b->len, q, r);
  tsv out = want_rem ? big_make(r, b->len, a->neg) : big_make(q, a->len - b->len + 1, a->neg != b->neg);
  free(q); free(r);
  return out;
}
static tsv big_pow(tsv base, tsv exp){
  ts_bigint* e = big_ptr(exp), *b = big_ptr(base);
  if (e->neg) ts_throw_range_error_msg("Exponent must be positive");
  if (!e->len) return big_from_u64(1, 0);
  if (!b->len) return base;
  if (b->len == 1 && b->limb[0] == 1) return b->neg && !(e->limb[0] & 1) ? big_from_u64(1, 0) : base;
  if (e->len > 1 || e->limb[0] > (uint64_t)BIG_MAX_LIMBS * 64) big_too_big();
  uint64_t n = e->limb[0];
  tsv result = big_from_u64(1, 0), sq = base;
  ts_gc_root(&result); ts_gc_root(&sq);
  for (;;){
    if (n & 1) result = big_mul(result, sq);
    n >>= 1;
    if (!n) break;
    sq = big_mul(sq, sq);
  }
  ts_gc_unroot(2);
  return result;
}
/* the magnitude shifted; a shift right of a negative rounds toward -infinity */
static tsv big_shift(tsv av, tsv bv, int right){
  ts_bigint* a = big_ptr(av), *b = big_ptr(bv);
  if (b->neg) right = !right;
  if (!a->len || !b->len) return av;
  if (b->len > 1 || b->limb[0] > (uint64_t)BIG_MAX_LIMBS * 64){
    if (!right) big_too_big();
    return a->neg ? big_from_u64(1, 1) : big_make(NULL, 0, 0);
  }
  uint64_t by = b->limb[0];
  uint32_t limbs = (uint32_t)(by / 64), bits = (uint32_t)(by % 64);
  if (!right){
    if ((uint64_t)a->len + limbs + 1 > (uint64_t)BIG_MAX_LIMBS + 1) big_too_big();
    uint32_t n = a->len + limbs + 1;
    uint64_t* r = (uint64_t*)big_alloc_scratch(n);
    for (uint32_t i = 0; i < a->len; i++){
      r[i + limbs] |= a->limb[i] << bits;
      if (bits) r[i + limbs + 1] |= a->limb[i] >> (64 - bits);
    }
    tsv out = big_make(r, n, a->neg);
    free(r);
    return out;
  }
  if (limbs >= a->len) return a->neg ? big_from_u64(1, 1) : big_make(NULL, 0, 0);
  uint32_t n = a->len - limbs + 1;
  uint64_t* r = (uint64_t*)big_alloc_scratch(n);
  int lost = 0;
  for (uint32_t i = 0; i < limbs; i++) if (a->limb[i]) lost = 1;
  if (bits && (a->limb[limbs] << (64 - bits))) lost = 1;
  for (uint32_t i = limbs; i < a->len; i++){
    r[i - limbs] = a->limb[i] >> bits;
    if (bits && i + 1 < a->len) r[i - limbs] |= a->limb[i + 1] << (64 - bits);
  }
  if (a->neg && lost){   /* magnitude + 1: floor */
    uint64_t one = 1;
    mag_add(r, r, n - 1, &one, 1);
  }
  tsv out = big_make(r, n, a->neg);
  free(r);
  return out;
}
/* two's complement in n limbs */
static void big_twos(const ts_bigint* a, uint64_t* r, uint32_t n){
  uint32_t m = a->len < n ? a->len : n;
  memcpy(r, a->limb, (size_t)m * sizeof(uint64_t));
  memset(r + m, 0, (size_t)(n - m) * sizeof(uint64_t));
  if (a->neg){
    uint64_t carry = 1;
    for (uint32_t i = 0; i < n; i++){ uint64_t x = ~r[i] + carry; carry = carry && x == 0; r[i] = x; }
  }
}
static tsv big_from_twos(uint64_t* r, uint32_t n){
  int neg = (r[n - 1] >> 63) != 0;
  if (neg){
    uint64_t carry = 1;
    for (uint32_t i = 0; i < n; i++){ uint64_t x = ~r[i] + carry; carry = carry && x == 0; r[i] = x; }
  }
  return big_make(r, n, neg);
}
static tsv big_bitop(tsv av, tsv bv, int op){
  ts_bigint* a = big_ptr(av), *b = big_ptr(bv);
  uint32_t n = (a->len > b->len ? a->len : b->len) + 1;
  uint64_t* x = (uint64_t*)big_alloc_scratch((size_t)n * 2), *y = x + n;
  big_twos(a, x, n); big_twos(b, y, n);
  for (uint32_t i = 0; i < n; i++) x[i] = op == 0 ? x[i] & y[i] : op == 1 ? x[i] | y[i] : x[i] ^ y[i];
  tsv out = big_from_twos(x, n);
  free(x);
  return out;
}
tsv ts_bigint_negate(tsv v){
  ts_bigint* a = big_ptr(v);
  return a->len ? big_make(a->limb, a->len, !a->neg) : v;
}
/* ---- comparison ---- */
int ts_bigint_eq(tsv av, tsv bv){
  ts_bigint* a = big_ptr(av), *b = big_ptr(bv);
  return a->neg == b->neg && mag_cmp(a->limb, a->len, b->limb, b->len) == 0;
}
static int big_cmp(tsv av, tsv bv){
  ts_bigint* a = big_ptr(av), *b = big_ptr(bv);
  if (a->neg != b->neg) return a->neg ? -1 : 1;
  int c = mag_cmp(a->limb, a->len, b->limb, b->len);
  return a->neg ? -c : c;
}
/* against a double, exactly: -1, 0, 1; 2 for NaN */
static int big_cmp_double(tsv av, double d){
  ts_bigint* a = big_ptr(av);
  if (d != d) return 2;
  if (isinf(d)) return d > 0 ? -1 : 1;
  int aneg = a->neg, dneg = d < 0;
  if (!a->len) return d > 0 ? -1 : d < 0 ? 1 : 0;
  if (d == 0.0) return aneg ? -1 : 1;
  if (aneg != dneg) return aneg ? -1 : 1;
  double m = fabs(d), whole = floor(m);
  int e; double f = frexp(whole, &e);     /* whole = f * 2^e, 0.5 <= f < 1 */
  uint64_t bits = big_bit_length(a);
  int c;
  if (whole == 0.0) c = 1;
  else if (bits != (uint64_t)e) c = bits > (uint64_t)e ? 1 : -1;
  else {
    /* same width: the double's 53 significant bits against the same bits of a */
    uint64_t sig = (uint64_t)ldexp(f, 53);
    uint64_t top = 0;
    int have = (int)(bits % 64 ? bits % 64 : 64);
    top = a->limb[a->len - 1];
    if (have < 53 && a->len > 1) top = (top << (53 - have)) | (a->limb[a->len - 2] >> (64 - (53 - have)));
    else if (have > 53) top >>= have - 53;
    else if (have < 53) top <<= 53 - have;
    c = top < sig ? -1 : top > sig ? 1 : 0;
    if (c == 0){
      /* anything set below those bits */
      uint64_t below = bits > 53 ? bits - 53 : 0;
      for (uint64_t i = 0; i < below && !c; i++) if ((a->limb[i / 64] >> (i % 64)) & 1u) c = 1;
    }
  }
  if (c == 0 && m != whole) c = -1;       /* the fraction */
  return aneg ? -c : c;
}
/* ---- conversion ---- */
double ts_bigint_to_double(tsv v){
  ts_bigint* a = big_ptr(v);
  if (!a->len) return 0.0;
  uint64_t bits = big_bit_length(a);
  if (bits > 1024) return a->neg ? -INFINITY : INFINITY;
  /* the top 64 bits, then round to 53 by hand: ties to even over everything below */
  uint64_t m = 0;
  int sticky = 0;
  uint32_t top = a->len - 1;
  int have = (int)(bits - (uint64_t)top * 64);
  m = a->limb[top] << (64 - have);
  if (have < 64 && top > 0){ m |= a->limb[top - 1] >> have; if (a->limb[top - 1] << (64 - have)) sticky = 1; }
  for (uint32_t i = 0; i + 1 < top && !sticky; i++) if (a->limb[i]) sticky = 1;
  if (have == 64 && top > 0 && a->limb[top - 1]) sticky = 1;
  uint64_t m53 = m >> 11, rest = m & 0x7FFu;
  if (rest > 0x400u || (rest == 0x400u && (sticky || (m53 & 1u)))) m53++;
  double r = ldexp((double)m53, (int)bits - 53);
  return a->neg ? -r : r;
}
static tsv big_from_double(double d){
  if (d == 0.0) return big_make(NULL, 0, 0);
  int e; double f = frexp(fabs(d), &e);
  uint64_t sig = (uint64_t)ldexp(f, 53);
  int shift = e - 53;
  if (shift <= 0) return big_from_u64(sig >> -shift, d < 0);
  uint32_t limbs = (uint32_t)(shift / 64) + 2;
  uint64_t* r = (uint64_t*)big_alloc_scratch(limbs);
  uint32_t at = (uint32_t)(shift / 64), bits = (uint32_t)(shift % 64);
  r[at] = sig << bits;
  if (bits) r[at + 1] = sig >> (64 - bits);
  tsv out = big_make(r, limbs, d < 0);
  free(r);
  return out;
}
static int big_digit(int c){
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'z') return c - 'a' + 10;
  if (c >= 'A' && c <= 'Z') return c - 'A' + 10;
  return 99;
}
/* digits in `radix`, no sign; 0 when a character is no digit */
static int big_parse_digits(const char* s, size_t len, int radix, uint64_t** out, uint32_t* outn){
  size_t cap = len * (radix <= 8 ? 3 : radix <= 16 ? 4 : 6) / 64 + 2;
  uint64_t* r = (uint64_t*)big_alloc_scratch(cap);
  uint32_t n = 0;
  for (size_t i = 0; i < len; i++){
    int d = big_digit((unsigned char)s[i]);
    if (d >= radix){ free(r); return 0; }
    uint64_t carry = (uint64_t)d;
    for (uint32_t j = 0; j < n; j++){ big_u128 t = (big_u128)r[j] * (unsigned)radix + carry; r[j] = (uint64_t)t; carry = (uint64_t)(t >> 64); }
    if (carry) r[n++] = carry;
  }
  *out = r; *outn = n;
  return 1;
}
/* StringToBigInt: trimmed, empty is 0n, a sign only on decimal; 0 if it is not one */
static int big_from_string(tsv str, tsv* out){
  tsv t = ts_str_trim(str);
  uint32_t len = 0;
  char* u = ts_string_cstr_copy(t, &len);
  const char* s = u;
  int neg = 0, radix = 10, ok = 1;
  if (len >= 2 && s[0] == '0' && strchr("xXoObB", s[1]) && s[1]){
    radix = s[1] == 'x' || s[1] == 'X' ? 16 : s[1] == 'o' || s[1] == 'O' ? 8 : 2;
    s += 2; len -= 2;
    if (!len) ok = 0;
  } else if (len >= 1 && (s[0] == '-' || s[0] == '+')){
    neg = s[0] == '-'; s++; len--;
    if (!len) ok = 0;
  }
  uint64_t* d = NULL; uint32_t n = 0;
  if (ok) ok = big_parse_digits(s, len, radix, &d, &n);
  free(u);
  if (!ok) return 0;
  *out = big_make(d, n, neg);
  free(d);
  return 1;
}
tsv ts_bigint_to_string(tsv v, int radix){
  ts_bigint* a = big_ptr(v);
  if (!a->len) return ts_new_string("0", 1);
  /* as many digits as fit a limb: base^k <= 2^64 */
  uint64_t base = (uint64_t)radix, chunk = base;
  int k = 1;
  while ((big_u128)chunk * base <= (big_u128)UINT64_MAX){ chunk *= base; k++; }
  uint64_t bits = big_bit_length(a);
  size_t cap = (size_t)(bits / (radix >= 32 ? 5 : radix >= 16 ? 4 : radix >= 8 ? 3 : radix >= 4 ? 2 : 1)) + (size_t)k + 3;
  char* buf = (char*)malloc(cap);
  uint64_t* d = (uint64_t*)big_alloc_scratch(a->len);
  memcpy(d, a->limb, (size_t)a->len * sizeof(uint64_t));
  uint32_t n = a->len;
  size_t at = cap;
  while (n){
    uint64_t rem = 0;
    for (uint32_t i = n; i-- > 0;){
      big_u128 cur = ((big_u128)rem << 64) | d[i];
      d[i] = (uint64_t)(cur / chunk);
      rem = (uint64_t)(cur % chunk);
    }
    while (n && d[n - 1] == 0) n--;
    for (int i = 0; i < k && (n || rem); i++){
      int digit = (int)(rem % base);
      rem /= base;
      buf[--at] = (char)(digit < 10 ? '0' + digit : 'a' + digit - 10);
    }
  }
  if (a->neg) buf[--at] = '-';
  tsv out = ts_new_string(buf + at, (uint32_t)(cap - at));
  free(buf); free(d);
  return out;
}
/* A literal's text, decimal: one cell per text, kept for the program's run. */
tsv ts_bigint_literal(const char* text){
  typedef struct lit { struct lit* next; const char* text; tsv v; int rooted; } lit;
  static lit* table[64];
  size_t h = ((size_t)text >> 4) % 64;
  for (lit* e = table[h]; e; e = e->next) if (e->text == text) return e->v;
  uint64_t* d = NULL; uint32_t n = 0;
  if (!big_parse_digits(text, strlen(text), 10, &d, &n)) ts_abort_msg("a malformed BigInt literal");
  lit* e = (lit*)calloc(1, sizeof(lit));
  e->text = text; e->next = table[h]; table[h] = e;
  e->v = TS_UNDEFINED;
  ts_root_static_once(&e->v, &e->rooted);
  e->v = big_make(d, n, 0);
  free(d);
  return e->v;
}
/* ToBigInt of a primitive */
static tsv big_of_primitive(tsv p){
  if (ts_is_bigint(p)) return p;
  if (ts_is_bool(p)) return big_from_u64(p & 1, 0);
  if (ts_is_str(p)){
    tsv out;
    if (!big_from_string(p, &out)){
      uint32_t n = 0; char* u = ts_string_cstr_copy(p, &n);
      char buf[160];
      snprintf(buf, sizeof buf, "Cannot convert %.120s to a BigInt", u);
      free(u);
      ts_throw(ts_new_error(TS_ERR_SYNTAX, ts_new_string(buf, (uint32_t)strlen(buf))));
    }
    return out;
  }
  uint32_t n = 0;
  char* what = ts_string_cstr_copy(ts_is_symbol(p) ? ts_symbol_tostring(p) : ts_to_string_v(p), &n);
  char buf[160];
  snprintf(buf, sizeof buf, "Cannot convert %.120s to a BigInt", what);
  free(what);
  ts_throw_type_error_msg(buf);
  return TS_UNDEFINED;
}
tsv ts_to_bigint(tsv v){ return big_of_primitive(ts_to_primitive(v, 0)); }
/* the function BigInt: a call; `new` finds no constructor */
tsv ts_bigint_call(tsv* a, int n){
  tsv p = ts_to_primitive(n > 0 ? a[0] : TS_UNDEFINED, 0);
  if (ts_is_num(p)){
    double d = ts_to_num(p);
    if (!isfinite(d) || d != floor(d)){
      char buf[96], num[40];
      ts_fmt_num(d, num, sizeof num);
      snprintf(buf, sizeof buf, "The number %s cannot be converted to a BigInt because it is not an integer", num);
      ts_throw_range_error_msg(buf);
    }
    return big_from_double(d);
  }
  return big_of_primitive(p);
}
/* the low `bits` bits of v, as a signed or an unsigned value */
static tsv big_as_n(tsv v, double dbits, int is_signed){
  ts_bigint* a = big_ptr(v);
  if (dbits == 0.0 || !a->len) return big_make(NULL, 0, 0);
  if (dbits > (double)(UINT64_C(1) << 53)) ts_throw_range_error_msg("Invalid value: not (convertible to) a safe integer");
  uint64_t bits = (uint64_t)dbits, width = big_bit_length(a);
  if (!a->neg && (is_signed ? width + 1 <= bits : width <= bits)) return v;
  if (a->neg && is_signed && width + 1 < bits) return v;
  if (bits / 64 + 2 > BIG_MAX_LIMBS) big_too_big();
  uint32_t n = (uint32_t)(bits / 64) + 2;
  uint64_t* r = (uint64_t*)big_alloc_scratch(n);
  big_twos(a, r, n);
  uint32_t top = (uint32_t)(bits / 64), b = (uint32_t)(bits % 64);
  if (b){ r[top] &= (UINT64_C(1) << b) - 1; for (uint32_t i = top + 1; i < n; i++) r[i] = 0; }
  else for (uint32_t i = top; i < n; i++) r[i] = 0;
  tsv out;
  if (is_signed && ((r[(bits - 1) / 64] >> ((bits - 1) % 64)) & 1u)){
    /* value - 2^bits: the top bit extended */
    uint32_t tl = (uint32_t)((bits - 1) / 64);
    int tb = (int)((bits - 1) % 64);
    if (tb < 63) r[tl] |= ~UINT64_C(0) << (tb + 1);
    for (uint32_t i = tl + 1; i < n; i++) r[i] = ~UINT64_C(0);
    out = big_from_twos(r, n);
  } else out = big_make(r, n, 0);
  free(r);
  return out;
}
static double big_to_index(tsv v){
  double d = ts_number_coerce(ts_to_primitive(v, 0));
  d = d != d ? 0.0 : trunc(d);
  if (d < 0 || d > 9007199254740991.0) ts_throw_range_error_msg("Invalid value: not (convertible to) a safe integer");
  return d;
}
tsv ts_bigint_as_int_n(tsv* a, int n){
  double bits = big_to_index(n > 0 ? a[0] : TS_UNDEFINED);
  return big_as_n(ts_to_bigint(n > 1 ? a[1] : TS_UNDEFINED), bits, 1);
}
tsv ts_bigint_as_uint_n(tsv* a, int n){
  double bits = big_to_index(n > 0 ? a[0] : TS_UNDEFINED);
  return big_as_n(ts_to_bigint(n > 1 ? a[1] : TS_UNDEFINED), bits, 0);
}
/* the 64 bits a BigInt64Array or a DataView stores */
uint64_t ts_bigint_to_u64(tsv v){
  ts_bigint* a = big_ptr(v);
  uint64_t u = a->len ? a->limb[0] : 0;
  return a->neg ? (uint64_t)0 - u : u;
}
tsv ts_bigint_from_i64(int64_t i){ return big_from_i64(i); }
tsv ts_bigint_from_u64(uint64_t u){ return big_from_u64(u, 0); }

/* ---- the operators ---- */
/* The operands after ToNumeric; `+` has taken its strings before it gets here. */
enum { BOP_ADD, BOP_SUB, BOP_MUL, BOP_DIV, BOP_MOD, BOP_POW, BOP_AND, BOP_OR, BOP_XOR, BOP_SHL, BOP_SHR, BOP_USHR };
static void big_mixed(void){ ts_throw_type_error_msg("Cannot mix BigInt and other types, use explicit conversions"); }
static tsv big_binary(int op, tsv a, tsv b){
  switch (op){
    case BOP_ADD: return big_add_signed(a, b, 0);
    case BOP_SUB: return big_add_signed(a, b, 1);
    case BOP_MUL: return big_mul(a, b);
    case BOP_DIV: return big_divrem(a, b, 0);
    case BOP_MOD: return big_divrem(a, b, 1);
    case BOP_POW: return big_pow(a, b);
    case BOP_AND: return big_bitop(a, b, 0);
    case BOP_OR:  return big_bitop(a, b, 1);
    case BOP_XOR: return big_bitop(a, b, 2);
    case BOP_SHL: return big_shift(a, b, 0);
    case BOP_SHR: return big_shift(a, b, 1);
    default: ts_throw_type_error_msg("BigInts have no unsigned right shift, use >> instead");
  }
  return TS_UNDEFINED;
}
static tsv num_binary(int op, double x, double y){
  switch (op){
    case BOP_ADD: return ts_num(x + y);
    case BOP_SUB: return ts_num(x - y);
    case BOP_MUL: return ts_num(x * y);
    case BOP_DIV: return ts_num(x / y);
    case BOP_MOD: return ts_num(fmod(x, y));
    case BOP_POW: return ts_num(ts_m_pow(x, y));
    case BOP_AND: return ts_num((double)(ts_to_int32(x) & ts_to_int32(y)));
    case BOP_OR:  return ts_num((double)(ts_to_int32(x) | ts_to_int32(y)));
    case BOP_XOR: return ts_num((double)(ts_to_int32(x) ^ ts_to_int32(y)));
    case BOP_SHL: return ts_num((double)(int32_t)((uint32_t)ts_to_int32(x) << (ts_to_int32(y) & 31)));
    case BOP_SHR: return ts_num((double)(ts_to_int32(x) >> (ts_to_int32(y) & 31)));
    default:      return ts_num((double)((uint32_t)ts_to_int32(x) >> (ts_to_int32(y) & 31)));
  }
}
/* An arithmetic operator over values the compiler cannot call numbers, in a program that can make a BigInt. */
tsv ts_numeric_op(int op, tsv a, tsv b){
  if (ts_is_num(a) && ts_is_num(b)) return num_binary(op, ts_to_num(a), ts_to_num(b));
  ts_gc_root(&a); ts_gc_root(&b);
  tsv pa = ts_to_primitive(a, 0); ts_gc_root(&pa);
  tsv pb = ts_to_primitive(b, 0); ts_gc_root(&pb);
  tsv r;
  if (ts_is_bigint(pa) || ts_is_bigint(pb)){
    if (!ts_is_bigint(pa) || !ts_is_bigint(pb)) big_mixed();
    r = big_binary(op, pa, pb);
  } else {
    double x = ts_number_coerce(pa); double y = ts_number_coerce(pb);
    r = num_binary(op, x, y);
  }
  ts_gc_unroot(4);
  return r;
}
/* -x, ~x, ++x, --x, ToNumeric */
tsv ts_numeric_unary(int op, tsv v){
  tsv p = ts_is_num(v) ? v : ts_to_primitive(v, 0);
  if (ts_is_bigint(p)){
    if (op == 4) return p;
    ts_gc_root(&p);
    tsv r;
    if (op == 0) r = ts_bigint_negate(p);
    else if (op == 1){ tsv one = big_from_u64(1, 0); ts_gc_root(&one); r = big_add_signed(ts_bigint_negate(p), one, 1); ts_gc_unroot(1); }   /* ~x = -x - 1 */
    else { tsv one = big_from_u64(1, 0); r = big_add_signed(p, one, op == 3); }
    ts_gc_unroot(1);
    return r;
  }
  double d = ts_number_coerce(p);
  return ts_num(op == 0 ? -d : op == 1 ? (double)~ts_to_int32(d) : op == 2 ? d + 1 : op == 3 ? d - 1 : d);
}
/* a relational comparison with a BigInt among the primitives: 1, 0, or -1 for undefined */
int ts_bigint_relational(tsv a, tsv b){
  int c;   /* a against b */
  if (ts_is_bigint(a) && ts_is_bigint(b)) c = big_cmp(a, b);
  else if (ts_is_bigint(a)){
    if (ts_is_str(b)){ tsv o; if (!big_from_string(b, &o)) return 2; c = big_cmp(a, o); }
    else c = big_cmp_double(a, ts_number_coerce(b));
  } else {
    if (ts_is_str(a)){ tsv o; if (!big_from_string(a, &o)) return 2; c = big_cmp(o, b); }
    else { c = big_cmp_double(b, ts_number_coerce(a)); if (c != 2) c = -c; }
  }
  return c;
}
/* a == with a BigInt on one side, the other primitive */
int ts_bigint_loose_eq(tsv big, tsv other){
  if (ts_is_bigint(other)) return ts_bigint_eq(big, other);
  if (ts_is_str(other)){ tsv o; return big_from_string(other, &o) && ts_bigint_eq(big, o); }
  if (ts_is_num(other)) return big_cmp_double(big, ts_to_num(other)) == 0;
  if (ts_is_bool(other)) return big_cmp_double(big, (double)(other & 1)) == 0;
  return 0;
}
uint32_t ts_bigint_hash(tsv v){
  ts_bigint* a = big_ptr(v);
  uint64_t h = a->neg ? 0x9E3779B97F4A7C15ull : 0;
  for (uint32_t i = 0; i < a->len; i++) h = (h ^ a->limb[i]) * 0x100000001B3ull;
  return (uint32_t)(h ^ (h >> 32));
}

/* ---- BigInt.prototype ---- */
static tsv g_bigint_proto_v = TS_NULL;
static tsv this_bigint(tsv* a, int n, const char* method){
  tsv v = n > 0 ? a[0] : TS_UNDEFINED;
  if (ts_is_bigint(v)) return v;
  tsv w = wrapper_value(v);
  if (ts_is_bigint(w)) return w;
  char m[96];
  snprintf(m, sizeof m, "BigInt.prototype.%s requires that 'this' be a BigInt", method);
  ts_throw_type_error_msg(m);
  return TS_UNDEFINED;
}
static tsv ts_bigintproto_toString(tsv* a, int n){
  tsv v = this_bigint(a, n, "toString");
  ts_gc_root(&v);
  double r = 10;
  if (n > 1 && !ts_is_undef(a[1])){
    r = ts_number_coerce(a[1]);
    r = r != r ? 0 : trunc(r);
    if (r < 2 || r > 36) ts_throw_range_error_msg("toString() radix argument must be between 2 and 36");
  }
  tsv s = ts_bigint_to_string(v, (int)r);
  ts_gc_unroot(1);
  return s;
}
static tsv ts_bigintproto_valueOf(tsv* a, int n){ return this_bigint(a, n, "valueOf"); }
static tsv ts_bigintproto_toLocaleString(tsv* a, int n){
  tsv s = ts_bigint_to_string(this_bigint(a, n, "toLocaleString"), 10);
  uint32_t len = 0; char* u = ts_string_cstr_copy(s, &len);
  char* out = (char*)malloc((size_t)len + len / 3 + 2);
  uint32_t at = 0, neg = u[0] == '-', digits = len - neg;
  if (neg) out[at++] = '-';
  for (uint32_t i = 0; i < digits; i++){
    out[at++] = u[neg + i];
    if (i + 1 < digits && (digits - i - 1) % 3 == 0) out[at++] = ',';
  }
  tsv r = ts_new_string(out, at);
  free(u); free(out);
  return r;
}
tsv ts_bigint_proto(void){
  if (ts_proto_ref(g_bigint_proto_v)) return g_bigint_proto_v;
  static int rooted = 0;
  g_bigint_proto_v = ts_new_proto_pretenured();
  ts_root_static_once(&g_bigint_proto_v, &rooted);
  ((ts_object*)ts_ptr(g_bigint_proto_v))->proto = g_object_proto_v;
  ts_prim_field_init();
  ts_proto_register_method(g_bigint_proto_v, g_tostring_key, "toString", ts_bigintproto_toString);
  ts_proto_register_method(g_bigint_proto_v, g_valueof_key, "valueOf", ts_bigintproto_valueOf);
  date_define(g_bigint_proto_v, "toLocaleString", ts_bigintproto_toLocaleString, 0);
  tsv tag = ts_new_string("BigInt", 6); ts_gc_root(&tag);
  ts_define_data(g_bigint_proto_v, TS_KEY_WKSYM(TS_WKSYM_TO_STRING_TAG), tag, 0, 0, 1);
  ts_gc_unroot(1);
  return g_bigint_proto_v;
}
void ts_bigint_ctor_link(tsv ctor){
  ts_gc_root(&ctor);
  tsv p = ts_bigint_proto();
  ts_define_data(ctor, ts_intern_field("prototype", 9), p, 0, 0, 0);
  ts_define_data(p, ts_intern_field("constructor", 11), ctor, 0, 1, 1);
  ts_gc_unroot(1);
}
