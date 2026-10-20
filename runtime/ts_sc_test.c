/* Stack check (docs/stack_check_design.md): the quarantine, activations,
   exception unwinding and the collector's report. Built with
   -DTSAOT_STACK_CHECK by scripts/run_runtime_tests.sh. */
#include "ts_rt.h"
#include <stdio.h>
#include <stdlib.h>

typedef struct { ts_object header; tsv f0; tsv f1; } Cell2;

static tsv g_keep = TS_UNDEFINED;   /* a rooted global: what the analysis missed */
static tsv g_outer = TS_UNDEFINED;  /* the catching activation's own cell */

/* What the emitted code does for a Stack class instance in check mode. */
static tsv new_cell(uint32_t site, const char* fn, double v){
  Cell2* o = (Cell2*)ts_sc_alloc(sizeof(Cell2), site, fn);
  o->header.h.kind = TS_KIND_OBJECT; o->header.h.gen = 2; o->header.h.size = sizeof(Cell2);
  o->header.proto = TS_NULL; o->header.shape = TS_SHAPE_EMPTY;
  o->f0 = ts_num(v); o->f1 = TS_UNDEFINED;
  return ts_obj(o);
}
static void frame(int leak){
  TS_SC_ACTIVATION;
  tsv v = new_cell(1, __func__, 1.0);
  if (leak) g_keep = v;
}
static void thrower(void){
  TS_SC_ACTIVATION;
  g_keep = new_cell(2, __func__, 2.0);
  ts_throw(ts_num(7));
}
static int catching(void){
  TS_SC_ACTIVATION;
  g_outer = new_cell(3, __func__, 3.0);
  int caught = 0;
  ts_handler* h = ts_eh_push();
  if (setjmp(h->buf) == 0){
    thrower();
    ts_eh_pop();
  } else {
    ts_eh_pop();
    caught = 1;
  }
  /* the catching activation's cell outlives the unwind */
  ts_gc_collect();
  return caught && ts_to_num(((Cell2*)ts_ptr(g_outer))->f0) == 3.0;
}

int main(void){
  int fail = 0;
  #define CK(name,cond) do{ printf("[%s] %s\n",name,(cond)?"PASS":"*** FAIL ***"); if(!(cond))fail++; }while(0)
  setenv("TSAOT_STACK_CHECK_CONTINUE", "1", 1);
  ts_gc_root(&g_keep);
  ts_gc_root(&g_outer);
  frame(0);
  ts_gc_collect();
  CK("sc: a dead cell nobody holds is not reported", ts_sc_report_count() == 0);
  frame(1);
  CK("sc: a dead cell reads as poison", !(ts_to_num(((Cell2*)ts_ptr(g_keep))->f0) == 1.0));
  ts_gc_collect();
  CK("sc: a dead cell held by a global is reported", ts_sc_report_count() == 1);
  g_keep = TS_UNDEFINED;
  int ok = catching();
  CK("sc: the catching activation's cell stays live", ok && ts_sc_report_count() == 2);
  g_outer = TS_UNDEFINED;
  g_keep = TS_UNDEFINED;
  ts_gc_collect();
  CK("sc: no report once nothing holds the dead cells", ts_sc_report_count() == 2);
  return fail ? 1 : 0;
}
