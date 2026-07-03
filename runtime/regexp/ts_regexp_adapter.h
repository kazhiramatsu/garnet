#ifndef TSAOT_REGEXP_ADAPTER_H
#define TSAOT_REGEXP_ADAPTER_H

#include <stdint.h>

#ifndef TS_RT_H
typedef uint64_t tsv;
#endif

typedef struct ts_regexp_compiled ts_regexp_compiled;

typedef struct ts_regexp_span {
  uint32_t start;
  uint32_t end;
  uint8_t matched;
} ts_regexp_span;

#define TSAOT_REGEXP_FLAG_GLOBAL       (1u << 0)
#define TSAOT_REGEXP_FLAG_IGNORECASE   (1u << 1)
#define TSAOT_REGEXP_FLAG_MULTILINE    (1u << 2)
#define TSAOT_REGEXP_FLAG_DOTALL       (1u << 3)
#define TSAOT_REGEXP_FLAG_UNICODE      (1u << 4)
#define TSAOT_REGEXP_FLAG_STICKY       (1u << 5)
#define TSAOT_REGEXP_FLAG_INDICES      (1u << 6)
#define TSAOT_REGEXP_FLAG_UNICODE_SETS (1u << 7)

#define TSAOT_REGEXP_OK 1
#define TSAOT_REGEXP_NOMATCH 0
#define TSAOT_REGEXP_ERR_UNAVAILABLE (-1)
#define TSAOT_REGEXP_ERR_COMPILE     (-2)
#define TSAOT_REGEXP_ERR_EXEC        (-3)
#define TSAOT_REGEXP_ERR_NOMEM       (-4)

/* Returns 1 when the QuickJS libregexp/libunicode fallback is linked behind this
   adapter. */
int ts_regexp_adapter_available(void);

/* Low-level compile entry. Direct callers must pass the byte representation
   expected by QuickJS libregexp; generated-C helpers below do the JS string to
   QuickJS pattern conversion themselves. */
ts_regexp_compiled* ts_regexp_compile_utf8(const char* pattern,
                                           uint32_t pattern_len,
                                           uint32_t flags,
                                           char* error_msg,
                                           uint32_t error_msg_len);
void ts_regexp_free(ts_regexp_compiled* re);
uint32_t ts_regexp_capture_count(const ts_regexp_compiled* re);

/* Execute against 8-bit input (Latin1/ASCII/UTF-8 byte stream, matching
   QuickJS cbuf_type=0). Captures are reported as byte/code-unit offsets. */
int ts_regexp_exec_latin1(ts_regexp_compiled* re,
                          const uint8_t* input,
                          uint32_t input_len,
                          uint32_t start_index,
                          ts_regexp_span* captures,
                          uint32_t capture_cap);

/* Execute against UTF-16 code-unit input (QuickJS cbuf_type=1; libregexp
   upgrades internally for Unicode-mode surrogate handling). Captures are
   reported as UTF-16 code-unit offsets. */
int ts_regexp_exec_utf16(ts_regexp_compiled* re,
                         const uint16_t* input,
                         uint32_t input_len,
                         uint32_t start_index,
                         ts_regexp_span* captures,
                         uint32_t capture_cap);

/* High-level generated-C entry points. Pattern is the RegExp source string,
   input is ToString-coerced inside the adapter, and flags use TSAOT_REGEXP_FLAG_*.
   These use the adapter-owned source+flags bytecode cache. */
tsv ts_regexp_adapter_test_tsv(tsv pattern, uint32_t flags, tsv input);
double ts_regexp_adapter_search_tsv(tsv input, tsv pattern, uint32_t flags);
tsv ts_regexp_adapter_exec_tsv(tsv pattern, uint32_t flags, tsv input);
tsv ts_regexp_adapter_match_tsv(tsv input, tsv pattern, uint32_t flags);
tsv ts_regexp_adapter_match_all_tsv(tsv input, tsv pattern, uint32_t flags);
tsv ts_regexp_adapter_replace_tsv(tsv input, tsv pattern, uint32_t flags, tsv replacement, int replace_all_method);
tsv ts_regexp_adapter_split_tsv(tsv input, tsv pattern, uint32_t flags, tsv limit);
tsv ts_regexp_adapter_validate_object_tsv(tsv re);
tsv ts_regexp_adapter_object_test_tsv(tsv re, tsv input);
double ts_regexp_adapter_object_search_tsv(tsv input, tsv re);
tsv ts_regexp_adapter_object_exec_tsv(tsv re, tsv input);
tsv ts_regexp_adapter_object_match_tsv(tsv input, tsv re);
tsv ts_regexp_adapter_object_match_all_tsv(tsv input, tsv re);
tsv ts_regexp_adapter_object_replace_tsv(tsv input, tsv re, tsv replacement, int replace_all_method);
tsv ts_regexp_adapter_object_split_tsv(tsv input, tsv re, tsv limit);

/* Shared failure path for RegExp calls that reach the optional adapter before
   the QuickJS backend is vendored. */
tsv ts_regexp_adapter_unsupported(const char* feature);

#endif
