#include "../ts_rt.h"
#include "ts_unicode_adapter.h"

#include <stdlib.h>
#include <string.h>

#ifdef TSAOT_HAS_QUICKJS_UNICODE
#include "libunicode.h"
#endif

int ts_unicode_adapter_available(void){
#ifdef TSAOT_HAS_QUICKJS_UNICODE
  return 1;
#else
  return 0;
#endif
}

#ifdef TSAOT_HAS_QUICKJS_UNICODE
static int ts_unicode_string_equals_ascii(tsv s, const char* lit){
  ts_strview view = ts_str_view_typed(s);
  size_t len = strlen(lit);
  if (view.len != len) return 0;
  for (uint32_t i = 0; i < view.len; i++){
    if (ts_str_cu_at_view(view, i) != (uint16_t)(unsigned char)lit[i]) return 0;
  }
  return 1;
}

static int ts_unicode_normalization_form(tsv form, UnicodeNormalizationEnum* out){
  if (form == TS_UNDEFINED){
    *out = UNICODE_NFC;
    return 1;
  }
  tsv s = ts_to_string_v(form);
  if (ts_unicode_string_equals_ascii(s, "NFC")){
    *out = UNICODE_NFC;
    return 1;
  }
  if (ts_unicode_string_equals_ascii(s, "NFD")){
    *out = UNICODE_NFD;
    return 1;
  }
  if (ts_unicode_string_equals_ascii(s, "NFKC")){
    *out = UNICODE_NFKC;
    return 1;
  }
  if (ts_unicode_string_equals_ascii(s, "NFKD")){
    *out = UNICODE_NFKD;
    return 1;
  }
  return 0;
}

static int ts_unicode_is_ascii_alpha(uint16_t cu){
  return (cu >= 'A' && cu <= 'Z') || (cu >= 'a' && cu <= 'z');
}

static int ts_unicode_is_ascii_alnum(uint16_t cu){
  return ts_unicode_is_ascii_alpha(cu) || (cu >= '0' && cu <= '9');
}

static uint16_t ts_unicode_ascii_lower(uint16_t cu){
  return (cu >= 'A' && cu <= 'Z') ? (uint16_t)(cu + ('a' - 'A')) : cu;
}

static int ts_unicode_validate_locale_and_kind(tsv locale, int* locale_kind){
  *locale_kind = 0;
  if (!ts_is_str(locale)) return 1;
  ts_strview view = ts_str_view_typed(locale);
  if (view.len == 0){
    ts_throw_range_error_msg("Invalid language tag");
    return 0;
  }
  uint32_t start = 0;
  uint32_t part = 0;
  uint16_t lang0 = 0, lang1 = 0;
  while (start < view.len){
    uint32_t end = start;
    while (end < view.len && ts_str_cu_at_view(view, end) != '-') end++;
    uint32_t n = end - start;
    if (n == 0 || n > 8){
      ts_throw_range_error_msg("Invalid language tag");
      return 0;
    }
    if (part == 0){
      if (n < 2 || n > 3){
        ts_throw_range_error_msg("Invalid language tag");
        return 0;
      }
      for (uint32_t i = 0; i < n; i++){
        if (!ts_unicode_is_ascii_alpha(ts_str_cu_at_view(view, start + i))){
          ts_throw_range_error_msg("Invalid language tag");
          return 0;
        }
      }
      lang0 = ts_unicode_ascii_lower(ts_str_cu_at_view(view, start));
      lang1 = n > 1 ? ts_unicode_ascii_lower(ts_str_cu_at_view(view, start + 1)) : 0;
      if ((lang0 == 't' && lang1 == 'r') || (lang0 == 'a' && lang1 == 'z')){
        *locale_kind = 1;
      }
    } else {
      for (uint32_t i = 0; i < n; i++){
        if (!ts_unicode_is_ascii_alnum(ts_str_cu_at_view(view, start + i))){
          ts_throw_range_error_msg("Invalid language tag");
          return 0;
        }
      }
    }
    if (end == view.len) break;
    start = end + 1;
    part++;
  }
  return 1;
}

static int ts_unicode_locale_kind(tsv locales, int* locale_kind){
  *locale_kind = 0;
  if (locales == TS_UNDEFINED) return 1;
  tsv locale = locales;
  if (ts_is_array(locales)){
    if (ts_array_len(locales) == 0) return 1;
    locale = ts_array_get(locales, 0);
  }
  if (locale == TS_NULL || locale == TS_UNDEFINED){
    ts_throw_type_error_msg("Language ID should be string or object");
    return 0;
  }
  if (!ts_is_str(locale)) return 1;
  return ts_unicode_validate_locale_and_kind(locale, locale_kind);
}

static int ts_unicode_has_cased_before(const uint32_t* cps, uint32_t before){
  int seen = 0;
  for (uint32_t i = 0; i < before; i++){
    uint32_t cp = cps[i];
    if (lre_is_cased(cp)) seen = 1;
    else if (!lre_is_case_ignorable(cp)) seen = 0;
  }
  return seen;
}

static int ts_unicode_has_cased_after(const uint32_t* cps, uint32_t len, uint32_t after){
  for (uint32_t i = after; i < len; i++){
    uint32_t cp = cps[i];
    if (lre_is_cased(cp)) return 1;
    if (!lre_is_case_ignorable(cp)) return 0;
  }
  return 0;
}

static int ts_unicode_case_conv_cp(uint32_t* out, uint32_t cp, int upper){
  return lre_case_conv(out, cp, upper ? 0 : 1);
}
#endif

static tsv ts_unicode_case_tsv_inner(tsv input, int upper, int locale_kind){
#ifndef TSAOT_HAS_QUICKJS_UNICODE
  (void)locale_kind;
  return upper ? ts_str_toupper(input) : ts_str_tolower(input);
#else
  tsv s = ts_to_string_v(input);
  ts_gc_root(&s);
  uint32_t src_len = 0;
  uint32_t* src = ts_string_codepoints_copy(s, &src_len);
  if (!src && src_len != 0){
    ts_gc_unroot(1);
    return ts_unsupported_builtin(upper ? "String.prototype.toUpperCase OOM" : "String.prototype.toLowerCase OOM");
  }
  if (src_len == 0){
    free(src);
    ts_gc_unroot(1);
    return ts_string_from_codepoints(NULL, 0);
  }
  if (src_len > (UINT32_MAX / LRE_CC_RES_LEN_MAX)){
    free(src);
    ts_gc_unroot(1);
    return ts_unsupported_builtin(upper ? "String.prototype.toUpperCase OOM" : "String.prototype.toLowerCase OOM");
  }
  uint32_t cap = src_len * LRE_CC_RES_LEN_MAX;
  uint32_t* dst = malloc(sizeof(uint32_t) * (size_t)cap);
  if (!dst){
    free(src);
    ts_gc_unroot(1);
    return ts_unsupported_builtin(upper ? "String.prototype.toUpperCase OOM" : "String.prototype.toLowerCase OOM");
  }
  uint32_t out_len = 0;
  for (uint32_t i = 0; i < src_len; i++){
    uint32_t buf[LRE_CC_RES_LEN_MAX];
    int n;
    if (locale_kind == 1 && upper && src[i] == 0x0069u){
      buf[0] = 0x0130u;
      n = 1;
    } else if (locale_kind == 1 && !upper && src[i] == 0x0130u){
      buf[0] = 0x0069u;
      n = 1;
    } else if (locale_kind == 1 && !upper && src[i] == 0x0049u){
      buf[0] = (i + 1 < src_len && src[i + 1] == 0x0307u) ? 0x0069u : 0x0131u;
      if (i + 1 < src_len && src[i + 1] == 0x0307u) i++;
      n = 1;
    } else if (!upper && src[i] == 0x03A3u){
      buf[0] = (ts_unicode_has_cased_before(src, i) &&
                !ts_unicode_has_cased_after(src, src_len, i + 1)) ? 0x03C2u : 0x03C3u;
      n = 1;
    } else {
      n = ts_unicode_case_conv_cp(buf, src[i], upper);
      if (n <= 0){
        buf[0] = src[i];
        n = 1;
      }
      if (n > LRE_CC_RES_LEN_MAX) n = LRE_CC_RES_LEN_MAX;
    }
    for (int j = 0; j < n; j++) dst[out_len++] = buf[j];
  }
  tsv out = ts_string_from_codepoints(dst, out_len);
  free(dst);
  free(src);
  ts_gc_unroot(1);
  return out;
#endif
}

tsv ts_unicode_case_tsv(tsv input, int upper){
  return ts_unicode_case_tsv_inner(input, upper, 0);
}

tsv ts_unicode_toupper_tsv(tsv input){
  return ts_unicode_case_tsv(input, 1);
}

tsv ts_unicode_tolower_tsv(tsv input){
  return ts_unicode_case_tsv(input, 0);
}

tsv ts_unicode_tolocaleupper_tsv(tsv input, tsv locales){
  int locale_kind = 0;
#ifdef TSAOT_HAS_QUICKJS_UNICODE
  if (!ts_unicode_locale_kind(locales, &locale_kind)) return TS_UNDEFINED;
#else
  (void)locales;
#endif
  return ts_unicode_case_tsv_inner(input, 1, locale_kind);
}

tsv ts_unicode_tolocalelower_tsv(tsv input, tsv locales){
  int locale_kind = 0;
#ifdef TSAOT_HAS_QUICKJS_UNICODE
  if (!ts_unicode_locale_kind(locales, &locale_kind)) return TS_UNDEFINED;
#else
  (void)locales;
#endif
  return ts_unicode_case_tsv_inner(input, 0, locale_kind);
}

tsv ts_unicode_normalize_tsv(tsv input, tsv form){
#ifndef TSAOT_HAS_QUICKJS_UNICODE
  (void)input;
  (void)form;
  return ts_unsupported_builtin("String.prototype.normalize");
#else
  tsv s = ts_to_string_v(input);
  ts_gc_root(&s);
  UnicodeNormalizationEnum ntype;
  if (!ts_unicode_normalization_form(form, &ntype)){
    ts_gc_unroot(1);
    ts_throw_range_error_msg("The normalization form should be one of NFC, NFD, NFKC, NFKD");
    return TS_UNDEFINED;
  }
  uint32_t src_len = 0;
  uint32_t* src = ts_string_codepoints_copy(s, &src_len);
  if (!src && src_len != 0){
    ts_gc_unroot(1);
    return ts_unsupported_builtin("String.prototype.normalize OOM");
  }
  if (src_len == 0){
    free(src);
    ts_gc_unroot(1);
    return ts_string_from_codepoints(NULL, 0);
  }
  uint32_t* dst = NULL;
  int dst_len = unicode_normalize(&dst, src, (int)src_len, ntype, NULL, NULL);
  free(src);
  if (dst_len < 0 || !dst){
    ts_gc_unroot(1);
    return ts_unsupported_builtin("String.prototype.normalize OOM");
  }
  tsv out = ts_string_from_codepoints(dst, (uint32_t)dst_len);
  free(dst);
  ts_gc_unroot(1);
  return out;
#endif
}

tsv ts_strproto_normalize(tsv* args, int nargs){
  tsv input = nargs > 0 ? args[0] : TS_UNDEFINED;
  tsv form = nargs > 1 ? args[1] : TS_UNDEFINED;
  return ts_unicode_normalize_tsv(input, form);
}

tsv ts_unicode_strproto_toUpperCase(tsv* args, int nargs){
  (void)nargs;
  return ts_unicode_toupper_tsv(args[0]);
}

tsv ts_unicode_strproto_toLowerCase(tsv* args, int nargs){
  (void)nargs;
  return ts_unicode_tolower_tsv(args[0]);
}

tsv ts_unicode_strproto_toLocaleUpperCase(tsv* args, int nargs){
  tsv locales = nargs > 1 ? args[1] : TS_UNDEFINED;
  return ts_unicode_tolocaleupper_tsv(args[0], locales);
}

tsv ts_unicode_strproto_toLocaleLowerCase(tsv* args, int nargs){
  tsv locales = nargs > 1 ? args[1] : TS_UNDEFINED;
  return ts_unicode_tolocalelower_tsv(args[0], locales);
}
