#ifndef TSAOT_UNICODE_ADAPTER_H
#define TSAOT_UNICODE_ADAPTER_H

#include <stdint.h>

#ifndef TS_RT_H
typedef uint64_t tsv;
#endif

/* Optional Unicode adapter. Generated C includes this only when it emits
   #define TSAOT_NEEDS_UNICODE 1, so no-normalize programs do not link QuickJS
   libunicode. */
int ts_unicode_adapter_available(void);
tsv ts_unicode_normalize_tsv(tsv input, tsv form);
tsv ts_unicode_toupper_tsv(tsv input);
tsv ts_unicode_tolower_tsv(tsv input);
tsv ts_unicode_tolocaleupper_tsv(tsv input, tsv locales);
tsv ts_unicode_tolocalelower_tsv(tsv input, tsv locales);
tsv ts_strproto_normalize(tsv* args, int nargs);
tsv ts_unicode_strproto_toUpperCase(tsv* args, int nargs);
tsv ts_unicode_strproto_toLowerCase(tsv* args, int nargs);
tsv ts_unicode_strproto_toLocaleUpperCase(tsv* args, int nargs);
tsv ts_unicode_strproto_toLocaleLowerCase(tsv* args, int nargs);

#endif
