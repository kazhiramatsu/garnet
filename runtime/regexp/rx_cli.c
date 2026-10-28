/* rx_cli.c: a test driver for the regexp engine (tests/regexp/rx_diff.mjs). Reads lines of
   tab-separated fields: pattern, flags, input, start (the strings as hex UTF-16 code units,
   4 digits per unit; the flags as letters), and prints one line per case: "ERR <reason>" for
   a syntax error, "null" for no match, else a JSON array of [start, end] pairs (null for an
   unset group). `rx_cli -d pattern flags` prints the disassembly.
   The native tier's test: `rx_cli -E` reads the same lines and writes the C of every distinct
   pattern's native matchers (rx_emit.c) with a table of them; built again with that C and
   -DRX_NATIVE_TABLE, the driver binds each case's program to its matchers before the run. */
#include "rx.h"
#include "rx_native.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

char* rx_emit_c(const rx_program* p, uint32_t id);
typedef struct rx_native_entry { const char* pat; const char* flags; rx_native_fn n8, n16; } rx_native_entry;
#ifdef RX_NATIVE_TABLE
extern const rx_native_entry rx_native_table[];
extern const uint32_t rx_native_table_len;
/* the table hashed by (pattern hex, flags) */
static uint32_t g_hash_cap; static int32_t* g_hash;
static uint32_t fnv(const char* a, const char* b){ uint32_t h = 2166136261u; for (; *a; a++) h = (h ^ (uint8_t)*a) * 16777619u; h = (h ^ 0x7Cu) * 16777619u; for (; *b; b++) h = (h ^ (uint8_t)*b) * 16777619u; return h; }
static void table_init(void){
  g_hash_cap = 16; while (g_hash_cap < 2 * rx_native_table_len + 1) g_hash_cap *= 2;
  g_hash = (int32_t*)malloc(sizeof(int32_t) * g_hash_cap); for (uint32_t i = 0; i < g_hash_cap; i++) g_hash[i] = -1;
  for (uint32_t i = 0; i < rx_native_table_len; i++){
    uint32_t h = fnv(rx_native_table[i].pat, rx_native_table[i].flags) & (g_hash_cap - 1);
    while (g_hash[h] >= 0) h = (h + 1) & (g_hash_cap - 1);
    g_hash[h] = (int32_t)i;
  }
}
static const rx_native_entry* table_find(const char* pat, const char* flags){
  uint32_t h = fnv(pat, flags) & (g_hash_cap - 1);
  while (g_hash[h] >= 0){
    const rx_native_entry* e = &rx_native_table[g_hash[h]];
    if (strcmp(e->pat, pat) == 0 && strcmp(e->flags, flags) == 0) return e;
    h = (h + 1) & (g_hash_cap - 1);
  }
  return NULL;
}
#endif

static uint16_t* decode_hex(const char* s, uint32_t* len){
  size_t n = strlen(s) / 4;
  uint16_t* out = (uint16_t*)malloc(sizeof(uint16_t) * (n + 1));
  for (size_t i = 0; i < n; i++){ unsigned v = 0; sscanf(s + 4 * i, "%4x", &v); out[i] = (uint16_t)v; }
  *len = (uint32_t)n;
  return out;
}
static uint32_t parse_flags(const char* f){
  uint32_t m = 0;
  for (; *f; f++) switch (*f){
    case 'g': m |= RX_F_GLOBAL; break; case 'i': m |= RX_F_IGNORECASE; break; case 'm': m |= RX_F_MULTILINE; break;
    case 's': m |= RX_F_DOTALL; break; case 'u': m |= RX_F_UNICODE; break; case 'y': m |= RX_F_STICKY; break;
    case 'd': m |= RX_F_INDICES; break; case 'v': m |= RX_F_UNICODE_SETS; break; default: break;
  }
  return m;
}
/* -E: the native matchers of every distinct (pattern, flags) of the cases on stdin, as C */
static int emit_natives(void){
  char* line = NULL; size_t cap = 0; ssize_t n;
  size_t nent = 0, entcap = 0; char** pats = NULL; char** flagss = NULL;
  printf("#include \"rx_native.h\"\n");
  printf("typedef struct rx_native_entry { const char* pat; const char* flags; rx_native_fn n8, n16; } rx_native_entry;\n");
  while ((n = getline(&line, &cap, stdin)) > 0){
    if (line[n - 1] == '\n') line[n - 1] = 0;
    char* f[4] = {0, 0, 0, 0}; int nf = 0; char* s = line;
    f[nf++] = s;
    for (char* q = s; *q && nf < 4; q++) if (*q == '\t'){ *q = 0; f[nf++] = q + 1; }
    if (nf < 2) continue;
    int dup = 0;
    for (size_t i = 0; i < nent; i++) if (strcmp(pats[i], f[0]) == 0 && strcmp(flagss[i], f[1]) == 0){ dup = 1; break; }
    if (dup) continue;
    uint32_t plen; uint16_t* pat = decode_hex(f[0], &plen);
    rx_error err; rx_program* p = rx_compile(pat, plen, parse_flags(f[1]), &err);
    free(pat);
    if (!p) continue;
    char* c = rx_emit_c(p, (uint32_t)nent);
    fputs(c, stdout); free(c); rx_release(p);
    if (nent == entcap){ entcap = entcap ? entcap * 2 : 256; pats = (char**)realloc(pats, sizeof(char*) * entcap); flagss = (char**)realloc(flagss, sizeof(char*) * entcap); }
    pats[nent] = strdup(f[0]); flagss[nent] = strdup(f[1]); nent++;
  }
  printf("const rx_native_entry rx_native_table[] = {\n");
  for (size_t i = 0; i < nent; i++) printf("  { \"%s\", \"%s\", rx_native_%zu_8, rx_native_%zu_16 },\n", pats[i], flagss[i], i, i);
  printf("  { \"\", \"\", 0, 0 }\n};\nconst uint32_t rx_native_table_len = %zuu;\n", nent);
  free(line);
  return 0;
}

int main(int argc, char** argv){
  if (argc >= 2 && strcmp(argv[1], "-E") == 0) return emit_natives();
#ifdef RX_NATIVE_TABLE
  table_init();
#endif
  if (argc >= 4 && strcmp(argv[1], "-d") == 0){
    uint32_t plen; uint16_t* pat = decode_hex(argv[2], &plen);
    rx_error err; rx_program* p = rx_compile(pat, plen, parse_flags(argv[3]), &err);
    if (!p){ printf("ERR %s at %u\n", err.msg, err.pos); return 1; }
    char* d = rx_disassemble(p); fputs(d, stdout); free(d); rx_release(p); return 0;
  }
  setvbuf(stdout, NULL, _IOLBF, 0);
  char* line = NULL; size_t cap = 0; ssize_t n;
  while ((n = getline(&line, &cap, stdin)) > 0){
    if (line[n - 1] == '\n') line[n - 1] = 0;
    char* f[4] = {0, 0, 0, 0}; int nf = 0; char* s = line;
    f[nf++] = s;
    for (char* q = s; *q && nf < 4; q++) if (*q == '\t'){ *q = 0; f[nf++] = q + 1; }
    if (nf < 3){ puts("ERR bad line"); continue; }
    uint32_t plen, ilen;
    uint16_t* pat = decode_hex(f[0], &plen);
    uint16_t* in = decode_hex(f[2], &ilen);
    uint32_t start = nf >= 4 ? (uint32_t)strtoul(f[3], NULL, 10) : 0;
    rx_error err;
    rx_program* p = rx_compile(pat, plen, parse_flags(f[1]), &err);
    if (!p){ printf("ERR %s\n", err.msg); free(pat); free(in); continue; }
#ifdef RX_NATIVE_TABLE
    { const rx_native_entry* ne = table_find(f[0], f[1]); if (!ne){ puts("ERR no native matcher"); free(pat); free(in); rx_release(p); continue; } rx_set_native(p, ne->n8, ne->n16); }
#endif
    uint32_t ng = rx_group_count(p);
    int32_t* caps = (int32_t*)malloc(sizeof(int32_t) * 2 * (ng + 1));
    /* narrow input when every unit fits */
    int wide = 0; for (uint32_t i = 0; i < ilen; i++) if (in[i] > 0xFF){ wide = 1; break; }
    uint8_t* in8 = NULL;
    if (!wide){ in8 = (uint8_t*)malloc(ilen + 1); for (uint32_t i = 0; i < ilen; i++) in8[i] = (uint8_t)in[i]; }
    int r = rx_exec(p, wide ? (const void*)in : (const void*)in8, ilen, wide, start, caps);
    if (r == RX_EXEC_OVERFLOW) puts("OVERFLOW");
    else if (r == 0) puts("null");
    else {
      printf("[");
      for (uint32_t g = 0; g <= ng; g++){
        if (g) printf(",");
        if (caps[2*g] < 0 || caps[2*g+1] < 0) printf("null"); else printf("[%d,%d]", caps[2*g], caps[2*g+1]);
      }
      printf("]\n");
    }
    free(caps); free(in8); free(pat); free(in); rx_release(p);
  }
  free(line);
  return 0;
}
