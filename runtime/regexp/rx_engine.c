/* rx_engine.c: the regexp engine as one translation unit (docs/regexp_vm_design.md), what
   scripts/lib/regexp_link_flags.sh compiles into rx_engine.o next to the adapter. */
#include "rx_set.c"
#include "rx_unicode.c"
#include "rx_parse.c"
#include "rx_compile.c"
#include "rx_vm.c"
