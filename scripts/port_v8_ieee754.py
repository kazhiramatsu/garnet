#!/usr/bin/env python3
# Regenerates runtime/ts_ieee754.c (Math's transcendental functions, V8's implementations)
# from V8's src/base/ieee754.cc, a C++ file of fdlibm-derived functions:
#   V8=$(node -p 'process.versions.v8.split("-")[0]')
#   curl -sfL https://raw.githubusercontent.com/v8/v8/$V8/src/base/ieee754.cc -o build/ieee754.cc
#   python3 -I scripts/port_v8_ieee754.py build/ieee754.cc runtime/ts_ieee754.c
#   bash tests/math_v8_parity/run.sh        # the port against this node, bit for bit
# Mechanical: the namespaces are dropped, the bit-cast macros and the casts rewritten, the
# public functions renamed ts_m_<name>, the internal kernels made static, the glibc trig
# variants and the legacy pow dropped (Node builds V8 with fdlibm sin/cos and std::pow; see
# the generated file's header). Re-check the header's version note after a regeneration.
import re, sys, pathlib
src = pathlib.Path(sys.argv[1]).read_text().split("\n")
out_path = pathlib.Path(sys.argv[2])
PUBLIC = ["acos","acosh","asin","asinh","atan","atan2","cos","exp","atanh","log","log1p","log2","log10","expm1","cbrt","sin","tan","cosh","sinh","tanh"]
INTERNAL = {"__ieee754_rem_pio2":"tsm_rem_pio2","__kernel_rem_pio2":"tsm_kernel_rem_pio2","__kernel_cos":"tsm_kernel_cos","__kernel_sin":"tsm_kernel_sin","__kernel_tan":"tsm_kernel_tan"}

# 1. the region: after the includes up to the closing namespaces
body = src[24:3034]
lines = []
i = 0
while i < len(body):
    l = body[i]
    # namespaces
    if re.match(r"^namespace\b.*\{\s*$", l) or re.match(r"^\}\s*//\s*namespace", l):
        i += 1; continue
    # MSVC block
    if l.startswith("#if V8_CC_MSVC"):
        while not body[i].startswith("#endif"): i += 1
        i += 1; continue
    # the trig dispatch: keep the fdlibm (#else) definition
    if l.startswith("#if defined(V8_USE_LIBM_TRIG_FUNCTIONS)") and "BUILDING_V8_BASE_SHARED" not in l:
        # lines: #if / double fdlibm_cos(...) { / #else / double cos(...) { / #endif
        assert body[i+2].startswith("#else") and body[i+4].startswith("#endif"), body[i:i+5]
        lines.append(body[i+3]); i += 5; continue
    if l.startswith("#if defined(V8_USE_LIBM_TRIG_FUNCTIONS) && defined(BUILDING_V8_BASE_SHARED)"):
        while not body[i].startswith("#endif"): i += 1
        i += 1; continue
    lines.append(l); i += 1
text = "\n".join(lines)

# 2. drop the legacy pow (namespace legacy { ... }  // namespace legacy); V8 uses std::pow by default
m = re.search(r"\n/\*\n \* ES6 draft 09-27-13, section 20\.2\.2\.26\..*?\n\}\n(?=\n)", text, re.S)
if not m:
    # locate by the function definition instead
    start = text.index("double pow(double x, double y) {")
    # back up to the preceding comment block start
    cstart = text.rfind("\n/*", 0, start)
    end = text.index("\n}\n", start) + 3
    text = text[:cstart] + "\n/* (V8's fdlibm pow, namespace legacy, is omitted: Math.pow uses std::pow,\n   see ts_m_pow below.) */\n" + text[end:]
else:
    text = text[:m.start()] + "\n/* (V8's fdlibm pow, namespace legacy, is omitted: Math.pow uses std::pow, see ts_m_pow below.) */\n" + text[m.end():]

# 3. C++ -> C
text = text.replace("base::bit_cast<uint64_t>", "tsm_bits").replace("base::bit_cast<double>", "tsm_from_bits")
def recast(t, kind="static_cast"):
    # static_cast<T>(expr) / const_cast<T>(expr) -> ((T)(expr)), the matching parenthesis found by scanning
    out = []; i = 0
    while True:
        m = re.compile(kind + r"<([^>]+)>\(").search(t, i)
        if not m: out.append(t[i:]); break
        out.append(t[i:m.start()]); out.append("((" + m.group(1) + ")(")
        depth = 1; j = m.end()
        while depth:
            c = t[j]
            if c == "(": depth += 1
            elif c == ")": depth -= 1
            j += 1
        out.append(t[m.end():j]); out.append(")")   # the inner expression with its ')' and one more
        i = j
    return "".join(out)
while 'static_cast<' in text:
    text = recast(text)   # nested casts: a pass per nesting level
while 'const_cast<' in text:
    text = recast(text, 'const_cast')
text = re.sub(r"(?<=[0-9A-Fa-fxX])'(?=[0-9A-Fa-f])", "", text)
text = text.replace("std::numeric_limits<double>::infinity()", "TSM_INF")
text = text.replace("std::numeric_limits<double>::quiet_NaN()", "TSM_NAN")
text = text.replace("std::numeric_limits<double>::signaling_NaN()", "TSM_NAN")
text = re.sub(r"base::Divide\(([^,]+), ([^)]+)\)", r"(\1) / (\2)", text)   # IEEE division (V8 has a helper for MSVC)
text = text.replace("NegateWithWraparound<int32_t>(", "tsm_neg_wrap(")
text = text.replace("SubWithWraparound<int32_t>(", "tsm_sub_wrap(")
text = text.replace("AddWithWraparound<int32_t>(", "tsm_add_wrap(")
text = text.replace("MulWithWraparound<int32_t>(", "tsm_mul_wrap(")
for k, v in [("Negate", "neg"), ("Sub", "sub"), ("Add", "add"), ("Mul", "mul")]:
    text = text.replace(k + "WithWraparound(", "tsm_" + v + "_wrap(")   # the template argument deduced
text = text.replace(" V8_WARN_UNUSED_RESULT", "")
text = text.replace("V8_INLINE double", "static inline double")
text = text.replace("while (false)", "while (0)")
for old, new in INTERNAL.items():
    text = re.sub(r"\b" + re.escape(old) + r"\b", new, text)
for n in PUBLIC:
    text = re.sub(r"\b" + n + r"\(", "ts_m_" + n + "(", text)
# the internal prototypes and definitions become static
text = re.sub(r"^int32_t tsm_rem_pio2\(", "static int32_t tsm_rem_pio2(", text, flags=re.M)
text = re.sub(r"^int tsm_kernel_rem_pio2\(", "static int tsm_kernel_rem_pio2(", text, flags=re.M)
text = re.sub(r"^double tsm_kernel_(cos|sin|tan)\(", r"static double tsm_kernel_\1(", text, flags=re.M)
text = re.sub(r"^static inline double tsm_kernel_(cos|sin)\(", r"static inline double tsm_kernel_\1(", text, flags=re.M)
# a prototype of an inline kernel must agree with its definition
text = text.replace("static double tsm_kernel_cos(double x, double y);", "static inline double tsm_kernel_cos(double x, double y);")
text = text.replace("static double tsm_kernel_sin(double x, double y, int iy);", "static inline double tsm_kernel_sin(double x, double y, int iy);")

# 4. leftovers that would not be C
left = [l for l in text.split("\n") if re.search(r"std::|base::|static_cast|const_cast|WithWraparound|V8_|namespace|reinterpret_cast|constexpr|nullptr|\btrue\b|\bfalse\b", l) and not l.strip().startswith(("//", "*", "/*"))]
if left:
    print("UNTRANSLATED:"); print("\n".join(left[:20])); sys.exit(1)

header = '''/* ts_ieee754.c: the transcendental functions of Math, computed as V8 computes them.
 *
 * A C translation of V8's src/base/ieee754.cc (tag 14.1.146.11, the V8 of Node.js 25.2.1),
 * itself adapted from fdlibm (http://www.netlib.org/fdlibm): exp, expm1, log, log1p, log2,
 * log10, sin, cos, tan, asin, acos, atan, atan2, sinh, cosh, tanh, asinh, acosh, atanh and
 * cbrt. Node builds V8 without the glibc trig functions, so Math.sin and Math.cos are the
 * fdlibm versions below; Math.pow is std::pow with the special cases of V8's math::pow
 * (src/numbers/ieee754.cc, the default of the flag use_std_math_pow), which ts_m_pow
 * reproduces over the platform's pow. The generated code calls ts_m_<name> where it
 * called libm (analyzer/src/emit_c.rs; TSAOT_IEEE754_MATH=0 restores the libm names);
 * the file is included into ts_rt.c.
 *
 * Floating-point contraction: this file carries no FP_CONTRACT pragma on purpose. Node's
 * build passes -ffp-contract=off to V8 only on s390x and ppc64 (tools/v8_gypfiles/
 * toolchain.gypi); elsewhere V8 is compiled with the compiler's default, which for clang
 * fuses a*b+c within one expression into a fused multiply-add where the CPU has one
 * (arm64), and the last bit of a few results depends on that. Compiling the same source
 * with the same default reproduces Node's results on the same platform: on macOS arm64,
 * 100,000 inputs in six ranges per function and the edge cases agree bit for bit with
 * Node 25.2.1 (scratch harness of the session that added the file), and a build with
 * -ffp-contract=off differs from Node in 19 of 100,000 exp results. Programs are
 * therefore compiled with the toolchain's default contraction, as V8 is.
 *
 * The translation: the namespaces are dropped, base::bit_cast and the casts are C casts,
 * the internal kernels are static with tsm_ names, the public functions are ts_m_<name>,
 * V8's fdlibm pow (namespace legacy, unused by default) is omitted, and a domain error
 * returns the canonical quiet NaN (V8 returns a signaling NaN pattern; the runtime's NaN
 * boxing canonicalizes either).
 *
 * ====================================================
 * Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
 *
 * Developed at SunSoft, a Sun Microsystems, Inc. business.
 * Permission to use, copy, modify, and distribute this
 * software is freely granted, provided that this notice
 * is preserved.
 * ====================================================
 *
 * The original source code covered by the above license above has been
 * modified significantly by Google Inc.
 * Copyright 2016 the V8 project authors. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *     * Redistributions of source code must retain the above copyright
 *       notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above
 *       copyright notice, this list of conditions and the following
 *       disclaimer in the documentation and/or other materials provided
 *       with the distribution.
 *     * Neither the name of Google Inc. nor the names of its
 *       contributors may be used to endorse or promote products derived
 *       from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
#include <stdint.h>
#include <string.h>
#include <math.h>

static inline uint64_t tsm_bits(double d) { uint64_t b; memcpy(&b, &d, 8); return b; }
static inline double tsm_from_bits(uint64_t b) { double d; memcpy(&d, &b, 8); return d; }
/* V8's overflowing-math helpers: two's-complement wraparound on int32 (defined behavior in C only
   through the unsigned type) */
static inline int32_t tsm_neg_wrap(int32_t a) { return (int32_t)(0u - (uint32_t)a); }
static inline int32_t tsm_sub_wrap(int32_t a, int32_t b) { return (int32_t)((uint32_t)a - (uint32_t)b); }
#define TSM_INF ((double)INFINITY)
#define TSM_NAN (tsm_from_bits(0x7FF8000000000000ULL))

/* the public functions (some call each other before their definitions) */
double ts_m_acos(double x); double ts_m_acosh(double x); double ts_m_asin(double x);
double ts_m_asinh(double x); double ts_m_atan(double x); double ts_m_atan2(double y, double x);
double ts_m_atanh(double x); double ts_m_cbrt(double x); double ts_m_cos(double x);
double ts_m_cosh(double x); double ts_m_exp(double x); double ts_m_expm1(double x);
double ts_m_log(double x); double ts_m_log1p(double x); double ts_m_log2(double x);
double ts_m_log10(double x); double ts_m_pow(double x, double y); double ts_m_sin(double x);
double ts_m_sinh(double x); double ts_m_tan(double x); double ts_m_tanh(double x);

'''
footer = '''
/* Math.pow and the ** operator as V8 computes them (src/numbers/ieee754.cc, math::pow
   with use_std_math_pow, the default): the JS special cases, then x*x for y == 2, the
   square root for y == 0.5, else the platform's pow (V8's std::pow is the same libm). */
double ts_m_pow(double x, double y) {
  if (y != y) return TSM_NAN;
  if ((y == TSM_INF || y == -TSM_INF) && (x == 1 || x == -1)) return TSM_NAN;
  if (x != x) x = TSM_NAN;
  if (y == 2) return x * x;
  if (y == 0.5) {
    if (x == TSM_INF || x == -TSM_INF) return TSM_INF;
    return sqrt(x + 0);
  }
  return pow(x, y);
}

#undef TSM_INF
#undef TSM_NAN
'''
out_path.write_text(header + text.strip("\n") + "\n" + footer)
print("wrote", out_path, len((header + text + footer).split("\n")), "lines")
