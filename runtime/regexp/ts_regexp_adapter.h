/* ts_regexp_adapter.h: the RegExp objects and the String / RegExp methods of the runtime over the
   engine in rx.h (docs/regexp_vm_design.md). Linked only into programs whose generated C declares
   TSAOT_NEEDS_REGEXP; this header deliberately does not include ts_rt.h (the generated C includes
   it first). The flag bits are the exporter's mask (RX_F_* in rx.h). */
#ifndef TSAOT_REGEXP_ADAPTER_H
#define TSAOT_REGEXP_ADAPTER_H

#include <stdint.h>

#ifndef TS_RT_H
typedef uint64_t tsv;
#endif

#define TSAOT_REGEXP_FLAG_GLOBAL       (1u << 0)
#define TSAOT_REGEXP_FLAG_IGNORECASE   (1u << 1)
#define TSAOT_REGEXP_FLAG_MULTILINE    (1u << 2)
#define TSAOT_REGEXP_FLAG_DOTALL       (1u << 3)
#define TSAOT_REGEXP_FLAG_UNICODE      (1u << 4)
#define TSAOT_REGEXP_FLAG_STICKY       (1u << 5)
#define TSAOT_REGEXP_FLAG_INDICES      (1u << 6)
#define TSAOT_REGEXP_FLAG_UNICODE_SETS (1u << 7)

/* Called from the generated program setup: RegExp.prototype's accessors, the runtime hooks (the
   dynamic string methods, toString, the collector's program release). */
void ts_regexp_adapter_init(void);

/* A RegExp object from a literal's source and flag mask (the program compiled through the
   cache; a SyntaxError for an invalid pattern) and from the constructor's arguments. */
tsv ts_regexp_new_literal(tsv source, uint32_t flags);
tsv ts_regexp_adapter_construct_tsv(tsv pattern, tsv flags, int as_constructor);
/* RegExp.escape */
tsv ts_regexp_escape_tsv(tsv s);

/* Literal call sites: the pattern source and flags, no RegExp object. */
tsv ts_regexp_adapter_test_tsv(tsv pattern, uint32_t flags, tsv input);
double ts_regexp_adapter_search_tsv(tsv input, tsv pattern, uint32_t flags);
tsv ts_regexp_adapter_exec_tsv(tsv pattern, uint32_t flags, tsv input);
tsv ts_regexp_adapter_match_tsv(tsv input, tsv pattern, uint32_t flags);
tsv ts_regexp_adapter_match_all_tsv(tsv input, tsv pattern, uint32_t flags);
tsv ts_regexp_adapter_replace_tsv(tsv input, tsv pattern, uint32_t flags, tsv replacement, int replace_all_method);
tsv ts_regexp_adapter_split_tsv(tsv input, tsv pattern, uint32_t flags, tsv limit);

/* RegExp objects (RegExp.prototype.test / exec and the String methods with a RegExp argument). */
tsv ts_regexp_adapter_object_test_tsv(tsv re, tsv input);
double ts_regexp_adapter_object_search_tsv(tsv input, tsv re);
tsv ts_regexp_adapter_object_exec_tsv(tsv re, tsv input);
tsv ts_regexp_adapter_object_match_tsv(tsv input, tsv re);
tsv ts_regexp_adapter_object_match_all_tsv(tsv input, tsv re);
tsv ts_regexp_adapter_object_replace_tsv(tsv input, tsv re, tsv replacement, int replace_all_method);
tsv ts_regexp_adapter_object_split_tsv(tsv input, tsv re, tsv limit);
/* "/source/flags" */
tsv ts_regexp_adapter_to_string_tsv(tsv re);

#endif
