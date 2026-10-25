#include "ts_rt.h"
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

/* A size the cell header cannot describe aborts (docs/cell_header_design.md):
   the child process allocates it and must die of SIGABRT. */
static int sized_extent_aborts(size_t bytes){
  fflush(stdout); fflush(stderr);
  pid_t pid = fork();
  if (pid < 0) return 0;
  if (pid == 0){
    if (!freopen("/dev/null", "w", stderr)) _exit(3);
    (void)ts_new_sized(bytes);
    _exit(0);
  }
  int status = 0;
  if (waitpid(pid, &status, 0) != pid) return 0;
  return WIFSIGNALED(status) && WTERMSIG(status) == SIGABRT;
}

/* Shared stores and atomics across processes (docs/fork_workers_design.md,
   F1): a child forked after a SharedArrayBuffer's creation writes the pages
   the parent reads; an ArrayBuffer's bytes stay the child's own. */
static int store_crosses_fork(int shared){
  tsv view;
  if (shared){ tsv b = ts_new_shared_array_buffer(16); ts_gc_root(&b); view = ts_new_typed_array(TS_TA_INT32, &b, 1); ts_gc_unroot(1); }
  else { tsv n = ts_num(4); view = ts_new_typed_array(TS_TA_INT32, &n, 1); }
  ts_gc_root(&view);
  fflush(stdout); fflush(stderr);
  pid_t pid = fork();
  if (pid < 0){ ts_gc_unroot(1); return -1; }
  if (pid == 0){ ts_atomics_store(view, ts_num(1), ts_num(42)); _exit(0); }
  int status = 0;
  if (waitpid(pid, &status, 0) != pid){ ts_gc_unroot(1); return -1; }
  int seen = (int)ts_to_num(ts_atomics_load(view, ts_num(1)));
  ts_gc_unroot(1);
  return seen;
}
/* Four children claim the indices of a schedule with compareExchange, as
   tsc-ts's checkers do, and mark each claimed slot: every slot once. */
static int schedule_contention(int children, int n){
  tsv b = ts_new_shared_array_buffer((uint32_t)(4 * (n + 1))); ts_gc_root(&b);
  tsv view = ts_new_typed_array(TS_TA_INT32, &b, 1); ts_gc_root(&view);
  fflush(stdout); fflush(stderr);
  pid_t pids[16];
  for (int c = 0; c < children; c++){
    pids[c] = fork();
    if (pids[c] < 0){ ts_gc_unroot(2); return 0; }
    if (pids[c] == 0){
      for (;;){
        int cur = (int)ts_to_num(ts_atomics_load(view, ts_num(0)));
        if (cur >= n) break;
        if ((int)ts_to_num(ts_atomics_compare_exchange(view, ts_num(0), ts_num(cur), ts_num(cur + 1))) == cur)
          ts_atomics_rmw(0, view, ts_num(1 + cur), ts_num(1));
      }
      _exit(0);
    }
  }
  for (int c = 0; c < children; c++){ int status = 0; waitpid(pids[c], &status, 0); }
  int ok = (int)ts_to_num(ts_atomics_load(view, ts_num(0))) == n;
  for (int i = 1; ok && i <= n; i++) ok = (int)ts_to_num(ts_atomics_load(view, ts_num(i))) == 1;
  ts_gc_unroot(2);
  return ok;
}

/* The worker message codec and a forked worker (docs/fork_workers_design.md, F2). */
static tsv worker_received = TS_UNDEFINED;
static int worker_errors = 0;
static tsv test_worker_entry(tsv* a, int n){
  /* the child: double the number, echo the text, post two frames */
  tsv data = n > 0 ? a[0] : TS_UNDEFINED;
  tsv out = ts_new_object(); ts_gc_root(&out);
  ts_set(out, ts_intern_field("n", 1), ts_num(ts_to_num(ts_get(data, ts_intern_field("n", 1))) * 2));
  ts_set(out, ts_intern_field("s", 1), ts_get(data, ts_intern_field("s", 1)));
  ts_worker_post(out);
  ts_worker_post(ts_num(7));
  ts_gc_unroot(1);
  return TS_UNDEFINED;
}
static tsv test_worker_throws(tsv* a, int n){ (void)a; (void)n; ts_throw_type_error_msg("the child fails"); return TS_UNDEFINED; }
static tsv test_worker_on_message(tsv* a, int n){
  tsv v = n > 0 ? a[0] : TS_UNDEFINED;
  /* the first frame is the object; the second, the number, lands on it */
  if (ts_is_num(v)) ts_set(worker_received, ts_intern_field("second", 6), v); else worker_received = v;
  return TS_UNDEFINED;
}
static tsv test_worker_on_error(tsv* a, int n){ (void)a; (void)n; worker_errors++; return TS_UNDEFINED; }
/* A shared worker (docs/published_graphs_design.md, "Sharing by fork"): it
   allocates into the region, publishes a graph that reaches a pre-fork cell
   and new shapes, and posts it wrapped and bare; the parent reads it in place. */
static tsv shared_prefork = TS_UNDEFINED;      /* created before the fork; the child's graph reaches it */
static tsv shared_got_wrap = TS_UNDEFINED, shared_got_root = TS_UNDEFINED;
static int shared_frames = 0;
static tsv test_shared_entry(tsv* a, int n){
  tsv data = n > 0 ? a[0] : TS_UNDEFINED;
  tsv root = ts_new_object(); ts_gc_root(&root);
  tsv inner = ts_new_object(); ts_gc_root(&inner);
  ts_set(inner, ts_intern_field("deep", 4), ts_num(5));
  tsv arr = ts_new_array(0); ts_gc_root(&arr);
  ts_array_push(arr, ts_num(1)); ts_array_push(arr, ts_num(2)); ts_array_push(arr, inner);
  tsv m = ts_new_map(); ts_gc_root(&m);
  ts_map_set(m, ts_new_string("k", 1), ts_num(9));
  /* a shape the parent never made: the keys in the other order */
  tsv ord = ts_new_object(); ts_gc_root(&ord);
  ts_set(ord, ts_intern_field("b", 1), ts_num(2)); ts_set(ord, ts_intern_field("a", 1), ts_num(1));
  tsv fn = ts_make_fn_t(test_worker_on_error, NULL, 0, 0); ts_gc_root(&fn);
  /* an object whose prototype this worker made: the prototype must outlive the worker's collections */
  tsv protoo = ts_new_object(); ts_gc_root(&protoo);
  ts_set(protoo, ts_intern_field("inh", 3), ts_num(7));
  tsv child = ts_object_create(protoo); ts_gc_root(&child);
  ts_set(child, ts_intern_field("own", 3), ts_num(1));
  ts_set(root, ts_intern_field("child", 5), child);
  ts_set(root, ts_intern_field("arr", 3), arr);
  ts_set(root, ts_intern_field("m", 1), m);
  ts_set(root, ts_intern_field("text", 4), ts_new_string("shared text", 11));
  ts_set(root, ts_intern_field("pre", 3), ts_get(data, ts_intern_field("pre", 3)));
  ts_set(root, ts_intern_field("ord", 3), ord);
  ts_set(root, ts_intern_field("fn", 2), fn);
  ts_publish(root);
  ts_gc_unroot(9);   /* the publish alone keeps the graph (and its prototypes) from here */
  ts_gc_root(&root);
  if (!getenv("TSAOT_TEST_NO_GC")){   /* objects of the prototype's size class reuse a freed cell */
    ts_gc_collect_young();
    for (int i = 0; i < 20000; i++){ tsv junk = ts_new_object(); ts_set(junk, ts_intern_field("inh", 3), ts_num(i)); if (i % 1000 == 0) ts_gc_collect_young(); }
    ts_gc_collect_young();
  }
  tsv wrap = ts_new_object(); ts_gc_root(&wrap);
  ts_set(wrap, ts_intern_field("batch", 5), root);
  ts_worker_post(wrap);
  ts_worker_post(root);
  ts_gc_unroot(2);
  return TS_UNDEFINED;
}
static tsv test_shared_on_message(tsv* a, int n){
  tsv v = n > 0 ? a[0] : TS_UNDEFINED;
  if (shared_frames++ == 0) shared_got_wrap = v; else shared_got_root = v;
  return TS_UNDEFINED;
}
/* a shared worker that allocates past its region (TSAOT_SHARED_REGION_MB=1 set by the test) */
static tsv test_shared_overflow_entry(tsv* a, int n){
  (void)a; (void)n;
  tsv keep = ts_new_array(0); ts_gc_root(&keep);
  for (int i = 0; i < 4096; i++){ tsv s = ts_new_array(0); ts_array_push(keep, s); for (int j = 0; j < 64; j++) ts_array_push(s, ts_num(j)); }
  ts_gc_unroot(1);
  return TS_UNDEFINED;
}
/* a shared worker that interns a property name the parent never saw */
static tsv test_shared_intern_entry(tsv* a, int n){
  (void)a; (void)n;
  tsv o = ts_new_object(); ts_gc_root(&o);
  ts_set(o, ts_intern_field("never_seen_before_xyz", 21), ts_num(1));
  ts_gc_unroot(1);
  return TS_UNDEFINED;
}
/* A shared worker publishes a Map of 3000 string keys of three storages (heap
   strings, immediates, views of one long string), a Set, and an object of 40
   properties; the parent looks every key up with strings of its own. */
static tsv shared_big_got = TS_UNDEFINED;
static tsv shared_key(int i, tsv longtext){
  char buf[32]; int n = snprintf(buf, sizeof buf, "k%d_%s", i, i % 3 == 0 ? "" : i % 3 == 1 ? "name_of_member" : "xy");
  if (i % 3 == 2){ /* a view of the large text: its i-th 7-character token */
    return ts_str_slice(longtext, (double)(i * 7), (double)(i * 7 + 7), 1);
  }
  return ts_new_string(buf, (uint32_t)n);
}
/* strings of the key size classes, as a parser makes: freed cells of the same classes get reused */
static void shared_string_churn(void){
  for (int i = 0; i < 20000; i++){
    char b[32]; int n = snprintf(b, sizeof b, "j%d_%s", i, i % 3 == 0 ? "" : i % 3 == 1 ? "name_of_member" : "xy");
    tsv s = ts_new_string(b, (uint32_t)n); tsv junk = ts_new_array(0); ts_array_push(junk, s);
    if (i % 1000 == 0) ts_gc_collect_young();
  }
}
static tsv test_shared_big_entry(tsv* a, int n){
  tsv data = n > 0 ? a[0] : TS_UNDEFINED;
  /* the text as the worker's own region string (a source file read here): the views' parent */
  tsv pretext = ts_get(data, ts_intern_field("text", 4));
  /* a collection first, then the graph: its strings are young when it is published, as a
     parser's are (a young collection promotes what it reaches, so one before publish would hide
     a walk that leaves the strings behind) */
  int gcs = !getenv("TSAOT_TEST_NO_GC");
  if (gcs){ shared_string_churn(); ts_gc_collect_young(); }
  ts_strview pv = ts_str_view_typed(pretext);
  tsv longtext = ts_new_string(pv.data, pv.len); ts_gc_root(&longtext);
  tsv m = ts_new_map(); ts_gc_root(&m);
  tsv st = ts_new_set(); ts_gc_root(&st);
  for (int i = 0; i < 3000; i++){ tsv k = shared_key(i, longtext); ts_gc_root(&k); ts_map_set(m, k, ts_num((double)i)); if (i % 7) ts_set_add(st, k); ts_gc_unroot(1); }
  for (int i = 0; i < 3000; i += 5){ tsv k = shared_key(i, longtext); ts_gc_root(&k); ts_map_delete(m, k); ts_gc_unroot(1); }   /* tombstones */
  tsv o = ts_new_object(); ts_gc_root(&o);
  for (int i = 0; i < 40; i++){ char nm[16]; snprintf(nm, sizeof nm, "p%d", i); ts_set(o, ts_intern_field(nm, (uint32_t)strlen(nm)), ts_num((double)i * 3)); }
  tsv root = ts_new_object(); ts_gc_root(&root);
  ts_set(root, ts_intern_field("m", 1), m); ts_set(root, ts_intern_field("s", 1), st); ts_set(root, ts_intern_field("o", 1), o);
  /* young collections in between, as a parse worker has (TSAOT_TEST_NO_GC=1: none) */
  ts_publish(root);
  ts_gc_unroot(5);   /* the graph is kept by the publish alone from here */
  if (gcs){ ts_gc_collect_young(); shared_string_churn(); ts_gc_collect_young(); }
  ts_worker_post(root);
  return TS_UNDEFINED;
}
static tsv test_shared_big_on_message(tsv* a, int n){ if (n > 0) shared_big_got = a[0]; return TS_UNDEFINED; }
/* iteration of a published collection (the cursor protocol of for..of, the iterator protocol) */
double ts_map_cursor_next(tsv coll, double last, double prev);
double ts_map_cursor_order(tsv coll, double idx);
tsv ts_map_cursor_val(tsv coll, double idx);
tsv ts_map_keys(tsv mv);
static int shared_iter_count(tsv coll){
  int n = 0; double last = -1, prev = -1;
  for (;;){ double i = ts_map_cursor_next(coll, last, prev); if (i < 0) break; n++; last = ts_map_cursor_order(coll, i); prev = i; }
  return n;
}
/* the Map's live entries in insertion order: values ascending, the deleted (i % 5 == 0) absent */
static int shared_iter_check_map(tsv m){
  double last = -1, prev = -1, expect = -1; int bad = 0;
  for (;;){
    double i = ts_map_cursor_next(m, last, prev); if (i < 0) break;
    double v = ts_to_num(ts_map_cursor_val(m, i));
    if (!(v > expect) || ((int)v % 5) == 0) bad++;
    expect = v; last = ts_map_cursor_order(m, i); prev = i;
  }
  return bad;
}
static int shared_iter_keys_count(tsv m){
  tsv it = ts_map_keys(m); ts_gc_root(&it);
  ts_key nmk = ts_intern_field("next", 4), donek = ts_intern_field("done", 4);
  int n = 0;
  for (;;){ tsv r = ts_iter_step(it, TS_UNDEFINED, nmk); if (ts_truthy(ts_get(r, donek))) break; if (++n > 100000) break; }
  ts_gc_unroot(1);
  return n;
}
static int write_throws(tsv obj, ts_key key, tsv val){
  ts_handler* h = ts_eh_push();
  if (ts_setjmp(h->buf) != 0){
    ts_gc_set_root_depth(h->gc_root_len);
    ts_frame_restore(h->frame_top);
    ts_eh_pop();
    return 1;
  }
  ts_set(obj, key, val);
  ts_eh_pop();
  return 0;
}
static int map_set_throws(tsv m){
  ts_handler* h = ts_eh_push();
  if (ts_setjmp(h->buf) != 0){
    ts_gc_set_root_depth(h->gc_root_len);
    ts_frame_restore(h->frame_top);
    ts_eh_pop();
    return 1;
  }
  ts_map_set(m, ts_num(1), ts_num(1));
  ts_eh_pop();
  return 0;
}
/* Frames from the parent (P4): the worker doubles each number it is sent and
   closes its port on `{ stop: true }`; the loop then ends with its work. */
static tsv test_echo_handler(tsv* a, int n){
  tsv m = n > 0 ? a[0] : TS_UNDEFINED;
  if (ts_is_obj(m) && ts_truthy(ts_get(m, ts_intern_field("stop", 4)))){ ts_worker_parent_close(); return TS_UNDEFINED; }
  ts_worker_post(ts_num(ts_to_num(m) * 2));
  return TS_UNDEFINED;
}
static tsv test_echo_entry(tsv* a, int n){
  (void)a; (void)n;
  tsv h = ts_make_fn_t(test_echo_handler, NULL, 0, 0);
  ts_worker_on_parent_message(h);
  return TS_UNDEFINED;
}
static tsv echo_received = TS_UNDEFINED;
static tsv test_echo_on_message(tsv* a, int n){ if (n > 0) ts_array_push(echo_received, a[0]); return TS_UNDEFINED; }
static int send_throws(int id){
  ts_handler* h = ts_eh_push();
  if (ts_setjmp(h->buf) != 0){
    ts_gc_set_root_depth(h->gc_root_len);
    ts_frame_restore(h->frame_top);
    ts_eh_pop();
    return 1;
  }
  ts_worker_send(id, ts_num(1));
  ts_eh_pop();
  return 0;
}
static int codec_rejects(tsv v){
  ts_handler* h = ts_eh_push();
  if (ts_setjmp(h->buf) != 0){
    ts_gc_set_root_depth(h->gc_root_len);
    ts_frame_restore(h->frame_top);
    ts_eh_pop();
    return 1;
  }
  (void)ts_message_roundtrip(v);
  ts_eh_pop();
  return 0;
}

static tsv check_merged_call(tsv* args, int nargs){
  int captures = (int)ts_to_num(args[0]);
  if (nargs != captures + 2) return ts_num(-1);
  for (int i=1;i<captures;i++) if (ts_to_num(args[i]) != i*3) return ts_num(-2);
  return ts_num(ts_to_num(args[captures]) + ts_to_num(args[captures+1]));
}

static tsv fetch_header_value_to_string(tsv* a, int n){
  (void)a; (void)n;
  for (int i=0;i<96;i++){
    tsv tmp=ts_new_object(); ts_gc_root(&tmp);
    ts_set(tmp, (ts_key)(1000+i), ts_num((double)i));
    ts_gc_unroot(1);
  }
  return ts_new_string("via-accessor", 12);
}

static tsv fetch_header_getter(tsv* a, int n){
  (void)a; (void)n;
  tsv obj=ts_new_object(); ts_gc_root(&obj);
  tsv fn=ts_make_fn(fetch_header_value_to_string, NULL, 0);
  ts_gc_root(&fn);
  ts_set_cstr(obj, "toString", fn);
  ts_gc_unroot(2);
  return obj;
}

static int fetch_error_caught = 0;
static tsv fetch_error_catch(tsv* a, int n){
  tsv err = n > 0 ? a[0] : TS_UNDEFINED;
  ts_gc_root(&err);
  tsv name = ts_get(err, ts_intern_field("name", 4));
  ts_gc_root(&name);
  tsv message = ts_get(err, ts_intern_field("message", 7));
  ts_gc_root(&message);
  tsv expect = ts_new_string("TypeError", 9);
  ts_gc_root(&expect);
  fetch_error_caught = ts_strict_eq(name, expect) && ts_is_str(message);
  ts_gc_unroot(4);
  return TS_UNDEFINED;
}

static int fetch_abort_caught = 0;
static tsv fetch_abort_catch(tsv* a, int n){
  tsv err = n > 0 ? a[0] : TS_UNDEFINED;
  ts_gc_root(&err);
  tsv name = ts_get(err, ts_intern_field("name", 4));
  ts_gc_root(&name);
  tsv message = ts_get(err, ts_intern_field("message", 7));
  ts_gc_root(&message);
  tsv expect_name = ts_new_string("AbortError", 10);
  ts_gc_root(&expect_name);
  tsv expect_message = ts_new_string("fetch aborted", 13);
  ts_gc_root(&expect_message);
  fetch_abort_caught = ts_strict_eq(name, expect_name) && ts_strict_eq(message, expect_message);
  ts_gc_unroot(5);
  return TS_UNDEFINED;
}

static int fetch_timeout_caught = 0;
static tsv fetch_timeout_catch(tsv* a, int n){
  tsv err = n > 0 ? a[0] : TS_UNDEFINED;
  ts_gc_root(&err);
  tsv name = ts_get(err, ts_intern_field("name", 4));
  ts_gc_root(&name);
  tsv message = ts_get(err, ts_intern_field("message", 7));
  ts_gc_root(&message);
  tsv expect_name = ts_new_string("TimeoutError", 12);
  ts_gc_root(&expect_name);
  tsv expect_message = ts_new_string("signal timed out", 16);
  ts_gc_root(&expect_message);
  fetch_timeout_caught = ts_strict_eq(name, expect_name) && ts_strict_eq(message, expect_message);
  ts_gc_unroot(5);
  return TS_UNDEFINED;
}

static int headers_get_illegal_invocation_caught(void){
  int caught = 0;
  tsv bad=ts_new_object(); ts_gc_root(&bad);
  tsv name=ts_new_string("x", 1); ts_gc_root(&name);
  ts_handler* h = ts_eh_push();
  if (setjmp(h->buf) != 0){
    ts_gc_set_root_depth(h->gc_root_len);
    ts_eh_pop();
    tsv err = ts_current_exception(); ts_gc_root(&err);
    tsv ename = ts_get(err, ts_intern_field("name", 4)); ts_gc_root(&ename);
    tsv expect = ts_new_string("TypeError", 9); ts_gc_root(&expect);
    caught = ts_strict_eq(ename, expect);
    ts_gc_unroot(3);
  } else {
    (void)ts_headers_get(bad, name);
    ts_eh_pop();
  }
  ts_gc_unroot(2);
  return caught;
}

static int headers_immutable_mutation_caught(int op){
  int caught = 0;
  tsv h=ts_headers_new(TS_UNDEFINED); ts_gc_root(&h);
  tsv name=ts_new_string("X-Imm", 5); ts_gc_root(&name);
  tsv value=ts_new_string("locked", 6); ts_gc_root(&value);
  ts_headers_set(h, name, value);
  ts_headers_make_immutable(h);
  ts_handler* eh = ts_eh_push();
  if (setjmp(eh->buf) != 0){
    ts_gc_set_root_depth(eh->gc_root_len);
    ts_eh_pop();
    tsv err = ts_current_exception(); ts_gc_root(&err);
    tsv ename = ts_get(err, ts_intern_field("name", 4)); ts_gc_root(&ename);
    tsv expect = ts_new_string("TypeError", 9); ts_gc_root(&expect);
    caught = ts_strict_eq(ename, expect);
    ts_gc_unroot(3);
  } else {
    if (op == 0) ts_headers_append(h, name, ts_new_string("later", 5));
    else if (op == 1) ts_headers_set(h, name, ts_new_string("changed", 7));
    else ts_headers_delete(h, name);
    ts_eh_pop();
  }
  int unchanged = ts_strict_eq(ts_headers_get(h, name), value);
  int frozen = ts_truthy(ts_object_is_frozen(h));
  ts_gc_unroot(3);
  return caught && unchanged && frozen;
}

typedef struct {
  ts_sized_head o;
  tsv x;
} pic_test_class;

typedef struct {
  ts_frame_hdr h;
  tsv slots[3];
} frame_root_test;

typedef struct {
  ts_sized_head o;
  tsv boxed;
  double numeric;
} registry_test_class;

static void throw_from_nested_frame(tsv payload){
  frame_root_test frame;
  frame.slots[0] = payload;
  frame.slots[1] = TS_UNDEFINED;
  frame.slots[2] = TS_UNDEFINED;
  ts_frame_push(&frame.h, 3);
  frame.slots[1] = ts_new_object();
  ts_set(frame.slots[1], 710001u, ts_num(17));
  frame.slots[2] = ts_new_string("nested-frame", 12);
  ts_throw(payload);
}

static uint32_t test_prop_hash(ts_key key){
  uint32_t x=key;
  x ^= x >> 16;
  x *= 0x7feb352du;
  x ^= x >> 15;
  x *= 0x846ca68bu;
  return x ^ (x >> 16);
}

static int replace_unit_metrics_match(tsv source){
  /* Compare the fused metrics with an independently materialized replacement.
     Include NUL, Latin-1, BMP, and each half of a surrogate pair. */
  const uint16_t units[] = {'-', '+', 'a', 0, 0xe9, 0x6f22, 0xd83d, 0xde00};
  const size_t count = sizeof(units) / sizeof(units[0]);
  tsv chars[sizeof(units) / sizeof(units[0])];
  ts_gc_root(&source);
  for (size_t i=0;i<count;i++){
    tsv arg = ts_num(units[i]);
    chars[i] = ts_string_from_char_code(&arg, 1);
    ts_gc_root(&chars[i]);
  }
  tsv result = TS_UNDEFINED;
  ts_gc_root(&result);
  int ok = 1;
  for (size_t p=0;p<count && ok;p++){
    for (size_t r=0;r<count && ok;r++){
      for (int all=0;all<=1 && ok;all++){
        result = ts_str_replace(source, chars[p], chars[r], all);
        for (size_t n=0;n<count && ok;n++){
          for (long long idx=-1;idx<=(long long)ts_str_len_typed(result);idx++){
            long long expected = (long long)ts_str_len_typed(result) +
              (long long)ts_str_indexof(result, chars[n], 0, 1) +
              ts_str_charcodeat_i64_typed(result, idx);
            if (ts_str_replace_literal_metric3(source, chars[p], chars[r],
                                               chars[n], idx, all) != expected){
              ok = 0;
              break;
            }
          }
        }
      }
    }
  }
  ts_gc_unroot((int)count + 2);
  return ok;
}

static void allocation_churn(void){
  /* Exercise the ordinary nursery trigger, without an explicit collection or
     a test-specific threshold. */
  for (int i=0;i<200000;i++) (void)ts_new_object();
}
static tsv read_gc_capture(tsv* args, int nargs){
  return nargs ? ts_get(args[0], 493001u) : TS_UNDEFINED;
}
static int allocation_gc_regression(void){
  int depth = ts_gc_root_depth(), ok = 1;
  tsv fn=TS_UNDEFINED, pre=TS_UNDEFINED, large=TS_UNDEFINED, arr=TS_UNDEFINED;
  ts_gc_root(&fn); ts_gc_root(&pre); ts_gc_root(&large); ts_gc_root(&arr);
  tsv child=ts_new_object(); ts_gc_root(&child);
  ts_set(child,493001u,ts_num(137));
  tsv env[600];
  for (int i=0;i<600;i++) env[i] = child;
  fn=ts_make_fn(read_gc_capture,env,1);
  pre=ts_make_fn_t_pretenured(read_gc_capture,env,1,0);
  large=ts_make_fn(read_gc_capture,env,600);
  ts_gc_unroot(1);
  allocation_churn();
  ok &= ts_to_num(ts_call(fn,NULL,0)) == 137;
  ok &= ts_to_num(ts_call(pre,NULL,0)) == 137;
  ok &= ts_to_num(ts_call(large,NULL,0)) == 137;
  for (int op=0;op<7;op++){
    arr=ts_new_array(256);
    allocation_churn(); /* the array is old before its indexed write */
    child=ts_new_object(); ts_gc_root(&child);
    ts_set(child,493001u,ts_num(200+op));
    uint32_t index = op==1 ? 64u : op==2 ? 63u : 255u;
    ts_array_set(arr,index,child);
    ts_gc_unroot(1);
    uint32_t result = 0;
    if (op==0) ts_array_reverse(arr);
    else if (op==1){ ts_array_shift(arr); result=63; }
    else if (op==2){ ts_array_unshift(arr,TS_UNDEFINED); result=64; }
    else if (op==3){
      ts_array_copy_within(arr,0,255,256,1);
      ts_array_set(arr,255,TS_UNDEFINED);
    } else if (op==4) ts_array_sort(arr,TS_UNDEFINED);
    else if (op==5){
      tsv items=ts_new_array(0); ts_gc_root(&items);
      ts_array_splice(arr,0,255,1,items); ts_gc_unroot(1);
    } else {
      ts_set(arr,493002u,ts_array_get(arr,255));
      ts_array_set(arr,255,TS_UNDEFINED);
    }
    allocation_churn();
    tsv value=op==6 ? ts_get(arr,493002u) : ts_array_get(arr,result);
    ok &= ts_is_obj(value) && ts_to_num(ts_get(value,493001u)) == 200+op;
  }
  /* The last representable card is a conservative full-scan fallback. */
  uint32_t index = (uint32_t)UINT16_MAX * 64u;
  arr=ts_new_array(index+1u);
  allocation_churn();
  child=ts_new_object(); ts_gc_root(&child);
  ts_set(child,493001u,ts_num(999)); ts_array_set(arr,index,child);
  ts_gc_unroot(1);
  allocation_churn();
  ok &= ts_to_num(ts_get(ts_array_get(arr,index),493001u)) == 999;
  tsv map=ts_new_map(); ts_gc_root(&map);
  for (int i=0;i<512;i++) ts_map_set(map,ts_num(i),TS_UNDEFINED);
  allocation_churn();
  child=ts_new_object(); ts_gc_root(&child);
  ts_set(child,493001u,ts_num(1001));
  ts_map_set(map,ts_num(511),child); ts_gc_unroot(1);
  tsv key=ts_new_object(); ts_gc_root(&key);
  ts_map_set(map,key,ts_num(1002)); ts_gc_unroot(1);
  for (int i=0;i<300;i++) ts_map_delete(map,ts_num(i));
  allocation_churn();
  ok &= ts_to_num(ts_get(ts_map_get(map,ts_num(511)),493001u)) == 1001;
  ok &= ts_to_num(ts_map_get(map,key)) == 1002;
  ts_map_clear(map);
  child=ts_new_object(); ts_gc_root(&child);
  ts_set(child,493001u,ts_num(1003));
  ts_map_set(map,ts_num(0),child); ts_gc_unroot(1);
  allocation_churn();
  ok &= ts_to_num(ts_get(ts_map_get(map,ts_num(0)),493001u)) == 1003;
  ts_gc_set_root_depth(depth);
  return ok;
}

/* Conservative roots (docs/conservative_roots_design.md): references held only
   in C locals and registers survive collections that find them by scanning the
   stack; cells nothing names lose their allocation bits. A stale word in a
   live frame (main's, here) names whatever cell its address holds now, so the
   death check is over many cells: nearly all of them must go. */
#define CR_DEAD 256
static uintptr_t g_cr_dead_addr[CR_DEAD];
__attribute__((noinline)) static void cr_make_dead(void){
  ts_key kv = ts_intern_field("v", 1);
  for (int i = 0; i < CR_DEAD; i++){
    tsv dead = ts_new_object();
    ts_set(dead, kv, ts_num(i));
    g_cr_dead_addr[i] = (uintptr_t)(dead & TS_PAYLOAD_MASK);
  }
}
__attribute__((noinline)) static void cr_scrub_stack(void){
  volatile uint64_t buf[2048];
  for (size_t i = 0; i < sizeof buf / sizeof buf[0]; i++) buf[i] = 0;
}
__attribute__((noinline)) static int cr_sum(tsv arr){
  int sum = 0;
  for (uint32_t i = 0; i < ts_array_len_fast(arr); i++) sum += (int)ts_to_num(ts_array_get(arr, i));
  return sum;
}
static int g_cr_results[4];
__attribute__((noinline)) static void test_conservative_roots(void){
  g_conservative_roots = 1;
  ts_key kv = ts_intern_field("v", 1);
  tsv keep = ts_new_array(0);          /* never rooted: a register or a stack word */
  tsv other = ts_new_object();
  for (int i = 0; i < 3000; i++){
    tsv tmp = ts_new_object();         /* garbage, with collections on the way */
    ts_set(tmp, kv, ts_num(i));
    ts_array_push(keep, ts_num(i));
    if ((i & 255) == 0) ts_gc_collect_young();
  }
  ts_set(other, kv, keep);
  ts_gc_collect_young();
  ts_gc_collect();
  g_cr_results[0] = ts_gc_debug_alloc_bit(keep) && ts_gc_debug_alloc_bit(other);
  g_cr_results[1] = cr_sum(keep) == 3000 * 2999 / 2 && ts_get(other, kv) == keep;
  cr_make_dead();
  cr_scrub_stack();
  ts_gc_collect_young();
  ts_gc_collect();
  int cleared = 0;
  for (int i = 0; i < CR_DEAD; i++) cleared += !ts_gc_debug_alloc_bit(TS_BOX(TS_SEL_OBJECT, g_cr_dead_addr[i]));
  g_cr_results[2] = cleared >= CR_DEAD - 16;
  if (!g_cr_results[2]) printf("  [diag] %d of %d dead cells lost their bit\n", cleared, CR_DEAD);
  g_cr_results[3] = cr_sum(keep) == 3000 * 2999 / 2 && ts_gc_debug_alloc_bit(keep);
  g_conservative_roots = 0;
}
/* Shape chains (slice N): a dictionary-like object built one key at a time
   shares its chain's key vectors and index with the shapes of its prefixes;
   a branch copies; no shape sees a key added beyond its depth. */
static int g_sc_results[6];
static void test_shape_chains(void){
  const ts_key base = 440000u, other = 450000u;
  tsv o = ts_new_object(); ts_gc_root(&o);
  tsv b = ts_new_object(); ts_gc_root(&b);
  tsv p = ts_new_object(); ts_gc_root(&p);
  for (uint32_t i = 0; i < 600; i++){
    ts_set(o, base + i, ts_num((double)i));
    if (i < 300) ts_set(b, base + i, ts_num(1000.0 + i));
    if (i < 100) ts_set(p, base + i, ts_num(2000.0 + i));
  }
  ts_set(b, other, ts_num(-1));
  int ok = 1;
  for (uint32_t i = 0; i < 600; i++) ok &= ts_to_num(ts_get(o, base + i)) == (double)i;
    g_sc_results[0] = (ok);
  ok = 1;
  for (uint32_t i = 0; i < 300; i++) ok &= ts_to_num(ts_get(b, base + i)) == 1000.0 + i;
    g_sc_results[1] = (ok && ts_to_num(ts_get(b, other)) == -1);
    g_sc_results[2] = (ts_is_undef(ts_get(b, base + 300)) && ts_is_undef(ts_get(b, base + 599)));
    g_sc_results[3] = (ts_is_undef(ts_get(o, other)));
    g_sc_results[4] = (ts_is_undef(ts_get(p, base + 100)) && ts_is_undef(ts_get(p, base + 599)) &&
     ts_to_num(ts_get(p, base + 99)) == 2099.0);
  ts_set(p, base + 100, ts_num(7));
    g_sc_results[5] = (ts_to_num(ts_get(p, base + 100)) == 7 && ts_is_undef(ts_get(p, base + 101)) &&
     ((ts_object*)ts_ptr(p))->shape != ((ts_object*)ts_ptr(o))->shape);
  ts_gc_unroot(3);
}
int main(){
  ts_gc_debug_log_young();
  int fail=0;
  #define CK(name,cond) do{ printf("[%s] %s\n",name,(cond)?"PASS":"*** FAIL ***"); if(!(cond))fail++; }while(0)
  /* numbers round-trip and stay numbers */
  CK("num 3.5", ts_is_num(ts_num(3.5)) && ts_to_num(ts_num(3.5))==3.5);
  CK("num int", ts_is_num(ts_num(42)) && ts_to_num(ts_num(42))==42);
  CK("num neg", ts_to_num(ts_num(-7.25))==-7.25);
  CK("num zero", ts_to_num(ts_num(0))==0);
  CK("num big", ts_to_num(ts_num(1e308))==1e308);
  /* immediates distinct from numbers */
  CK("undef!=num", !ts_is_num(TS_UNDEFINED) && ts_is_undef(TS_UNDEFINED));
  CK("null", ts_is_null(TS_NULL) && !ts_is_num(TS_NULL));
  CK("bool true", ts_is_bool(ts_bool(1)) && ts_truthy(ts_bool(1)));
  CK("bool false falsy", !ts_truthy(ts_bool(0)));
  /* truthiness */
  CK("0 falsy", !ts_truthy(ts_num(0)));
  CK("1 truthy", ts_truthy(ts_num(1)));
  CK("undef falsy", !ts_truthy(TS_UNDEFINED));
  /* Static prototype roots must be installed below all temporary test roots,
     matching generated-program startup order. */
  ts_setup_error_protos();
  int allocation_gc_ok = allocation_gc_regression();
  CK("closure storage and array/map dirty cards under automatic GC", allocation_gc_ok);
  tsv iterator_map = ts_new_map(); ts_gc_root(&iterator_map);
  int iterator_root_depth = ts_gc_root_depth();
  tsv empty_iterator = ts_map_values(iterator_map); ts_gc_root(&empty_iterator);
  CK("lazy iterator cache preserves temporary roots", ts_gc_root_depth() == iterator_root_depth + 1);
  ts_gc_unroot(2);
  const int capture_counts[] = {1, 14, 15, 16, 17, 62, 63, 64, 65, 128};
  int merged_calls_ok = 1;
  for (unsigned test=0;test<sizeof(capture_counts)/sizeof(capture_counts[0]);test++){
    int count=capture_counts[test]; tsv env[128];
    env[0]=ts_num(count);
    for (int i=1;i<count;i++) env[i]=ts_num(i*3);
    tsv fn=ts_make_fn(check_merged_call,env,(uint32_t)count); ts_gc_root(&fn);
    tsv args[2]={ts_num(1001),ts_num(2002)};
    if (ts_to_num(ts_call(fn,args,2)) != 3003) merged_calls_ok=0;
    ts_gc_unroot(1);
  }
  CK("closure merge small medium and heap boundaries", merged_calls_ok);
  /* objects */
  tsv o=ts_new_object(); ts_gc_root(&o);
  ts_set(o, 100, ts_num(7));
  ts_set(o, 200, ts_num(9));
  CK("obj get 100", ts_to_num(ts_get(o,100))==7);
  CK("obj get 200", ts_to_num(ts_get(o,200))==9);
  CK("obj missing", ts_is_undef(ts_get(o,999)));
  ts_set(o,100,ts_num(70));
  CK("obj overwrite", ts_to_num(ts_get(o,100))==70);
  /* A fixed-key PIC may see a plain object and an AOT class instance at the
     same site. Class instances resolve registered struct fields before their
     named-property vector, so they must not alias a plain object's shape. */
  const ts_key pic_class_key = 424242u;
  tsv pic_proto=ts_new_proto(); ts_gc_root(&pic_proto);
  ts_class_field pic_field={
    pic_class_key, offsetof(pic_test_class, x), 0
  };
  ts_register_class(pic_proto, &pic_field, 1);
  tsv pic_plain=ts_new_object(); ts_gc_root(&pic_plain);
  ts_set(pic_plain, pic_class_key, ts_num(1));
  tsv pic_class=ts_new_sized(sizeof(pic_test_class)); ts_gc_root(&pic_class);
  pic_test_class* pic_obj=(pic_test_class*)ts_ptr(pic_class);
  pic_obj->o.proto=pic_proto;
  pic_obj->x=ts_num(2);
  /* Install the same key in the side property vector to make an accidental
     shape collision observable: canonical class lookup must still return x. */
  ts_define_data(pic_class, pic_class_key, ts_num(99), 1, 1, 1);
  ts_prop_ic pic_ic=TS_PROP_IC_INIT;
  CK("pic plain warmup", ts_to_num(ts_get_pic_checked_inline(pic_plain, pic_class_key, &pic_ic))==1);
  CK("pic class layout domain", ts_to_num(ts_get_pic_checked_inline(pic_class, pic_class_key, &pic_ic))==2);
  CK("pic class canonical parity", ts_get_pic_checked_inline(pic_class, pic_class_key, &pic_ic)==ts_get(pic_class, pic_class_key));
  pic_obj=(pic_test_class*)ts_ptr(pic_class);
  pic_obj->x=ts_num(12);
  CK("pic class location reads live value",
     ts_to_num(ts_get_pic_checked_inline(pic_class,pic_class_key,&pic_ic))==12);
  pic_obj->x=ts_num(2);
  tsv pic_short=ts_new_object(); ts_gc_root(&pic_short);
  ts_set_proto(pic_short,pic_proto);
  ts_set(pic_short,pic_class_key,ts_num(17));
  CK("pic same prototype shorter storage", ts_to_num(ts_get_pic_checked_inline(pic_short,pic_class_key,&pic_ic))==17 &&
     ts_to_num(ts_get_pic_checked_inline(pic_class,pic_class_key,&pic_ic))==2);
  ts_set_proto(pic_class,TS_NULL);
  CK("pic prototype change rechecks storage", ts_to_num(ts_get_pic_checked_inline(pic_class,pic_class_key,&pic_ic))==99);
  ts_set_proto(pic_class,pic_proto);
  ts_prop_ic pic_write_ic=TS_PROP_IC_INIT;
  ts_set_pic_inline(pic_class,pic_class_key,ts_num(3),&pic_write_ic);
  ts_set_pic_inline(pic_class,pic_class_key,ts_num(4),&pic_write_ic);
  CK("pic cached struct writes", ts_to_num(ts_get(pic_class,pic_class_key))==4);
  ts_gc_unroot(1);
  ts_gc_unroot(3);
  tsv late_proto=ts_new_proto(); ts_gc_root(&late_proto);
  tsv late_class=ts_new_sized(sizeof(pic_test_class)); ts_gc_root(&late_class);
  ((pic_test_class*)ts_ptr(late_class))->o.proto=late_proto;
  ((pic_test_class*)ts_ptr(late_class))->x=ts_num(8);
  ts_define_data(late_class,pic_class_key,ts_num(99),1,1,1);
  ts_prop_ic late_ic=TS_PROP_IC_INIT;
  CK("pic before class registration", ts_to_num(ts_get_pic_checked_inline(late_class,pic_class_key,&late_ic))==99);
  ts_register_class(late_proto,&pic_field,1);
  CK("pic registration invalidates own location", ts_to_num(ts_get_pic_checked_inline(late_class,pic_class_key,&late_ic))==8);
  ts_gc_unroot(2);
  /* Equal property-key sequences share a hidden shape; insertion order changes
     it. A cached slot from one receiver must read the other receiver's storage. */
  const ts_key shape_a_key = 430001u, shape_x_key = 430002u;
  tsv shape_a=ts_new_object(); ts_gc_root(&shape_a);
  tsv shape_b=ts_new_object(); ts_gc_root(&shape_b);
  tsv shape_rev=ts_new_object(); ts_gc_root(&shape_rev);
  ts_set(shape_a, shape_a_key, ts_num(1)); ts_set(shape_a, shape_x_key, ts_num(10));
  ts_set(shape_b, shape_a_key, ts_num(2)); ts_set(shape_b, shape_x_key, ts_num(20));
  ts_set(shape_rev, shape_x_key, ts_num(30)); ts_set(shape_rev, shape_a_key, ts_num(3));
  CK("shape sequence shared",
     ((ts_object*)ts_ptr(shape_a))->shape == ((ts_object*)ts_ptr(shape_b))->shape);
  CK("shape insertion order distinct",
     ((ts_object*)ts_ptr(shape_a))->shape != ((ts_object*)ts_ptr(shape_rev))->shape);
  ts_prop_ic shared_shape_ic=TS_PROP_IC_INIT;
  CK("pic shared shape first",
     ts_to_num(ts_get_pic_checked_inline(shape_a, shape_x_key, &shared_shape_ic))==10);
  CK("pic shared shape second",
     ts_to_num(ts_get_pic_checked_inline(shape_b, shape_x_key, &shared_shape_ic))==20);
  ts_gc_unroot(3);

  /* Interface receivers can have many layouts at the same fixed-key site.
     Shape variation must not permanently disable its cache. */
  ts_prop_ic mega_ic=TS_PROP_IC_INIT;
  int mega_ok=1;
  for (int i=0;i<20;i++){
    tsv v=ts_new_object(); ts_gc_root(&v);
    ts_set(v, (ts_key)(440000u+i), ts_num(i));
    ts_set(v, shape_x_key, ts_num(100+i));
    if (ts_to_num(ts_get_pic_checked_inline(v, shape_x_key, &mega_ic)) != 100+i)
      mega_ok=0;
    ts_gc_unroot(1);
  }
  CK("pic megamorphic values", mega_ok);
  CK("pic fixed-key shape variation stays active", !mega_ic.megamorphic);
  tsv varied=ts_new_object(); ts_gc_root(&varied);
  ts_set(varied,450000u,ts_num(1)); ts_set(varied,shape_x_key,ts_num(2));
  CK("pic slot works across unrelated shapes", ts_to_num(ts_get_pic_checked_inline(varied,shape_x_key,&mega_ic))==2);
  for (int i=0;i<32;i++) (void)ts_get_pic_checked_inline(varied,shape_x_key,&mega_ic);
  { uint8_t pf=0; CK("pic repeated new shape is promoted inline", ts_prop_ic_probe_fixed_inline(varied,shape_x_key,&mega_ic,&pf)!=NULL); }
  ts_gc_unroot(1);
  tsv same_slot_shapes[4];
  ts_prop_ic same_slot_ic=TS_PROP_IC_INIT;
  for (int i=0;i<4;i++){
    same_slot_shapes[i]=ts_new_object(); ts_gc_root(&same_slot_shapes[i]);
    ts_set(same_slot_shapes[i],(ts_key)(451000u+i),ts_num(0));
    ts_set(same_slot_shapes[i],shape_x_key,ts_num(10+i));
  }
  int same_slot_ok=1;
  for (int i=0;i<32;i++)
    if (ts_to_num(ts_get_pic_checked_inline(same_slot_shapes[i&3],shape_x_key,&same_slot_ic))!=10+(i&3)) same_slot_ok=0;
  for (int i=0;i<4;i++)
    { uint8_t pf=0; if (!ts_prop_ic_probe_fixed_inline(same_slot_shapes[i],shape_x_key,&same_slot_ic,&pf)) same_slot_ok=0; }
  CK("pic retains four shapes sharing one slot", same_slot_ok);
  ts_gc_unroot(4);
  ts_prop_ic missing_ic=TS_PROP_IC_INIT;
  tsv initially_missing=ts_new_object(); ts_gc_root(&initially_missing);
  for (int i=0;i<32;i++) (void)ts_get_pic_checked_inline(initially_missing, shape_x_key, &missing_ic);
  ts_set(initially_missing, shape_x_key, ts_num(41));
  CK("pic missing warmup stays cacheable", !missing_ic.megamorphic &&
     ts_to_num(ts_get_pic_checked_inline(initially_missing, shape_x_key, &missing_ic))==41);
  ts_set(initially_missing, shape_x_key, ts_num(42));
  CK("pic missing warmup sees later writes",
     ts_to_num(ts_get_pic_checked_inline(initially_missing, shape_x_key, &missing_ic))==42);
  ts_gc_unroot(1);

  /* Delete compacts the dense property vector and switches to dictionary shape,
     preventing a cached slot index from reading the adjacent property. */
  tsv compact=ts_new_object(); ts_gc_root(&compact);
  const ts_key compact_before=450001u, compact_key=450002u, compact_after=450003u;
  ts_set(compact, compact_before, ts_num(1));
  ts_set(compact, compact_key, ts_num(2));
  ts_set(compact, compact_after, ts_num(3));
  ts_prop_ic compact_ic=TS_PROP_IC_INIT;
  CK("pic compact warm", ts_to_num(ts_get_pic_checked_inline(compact, compact_key, &compact_ic))==2);
  CK("pic compact delete", ts_delete_prop(compact, compact_before));
  CK("pic compact dictionary shape",
     ts_obj_shape_id((ts_object*)ts_ptr(compact))==TS_SHAPE_NONE);
  CK("pic compact slot safe", ts_to_num(ts_get_pic_checked_inline(compact, compact_key, &compact_ic))==2);
  ts_gc_unroot(1);

  /* The adaptive property index appears at eight entries, survives growth and
     dense compaction, disappears below eight, and can be rebuilt afterwards. */
  tsv indexed=ts_new_object(); ts_gc_root(&indexed);
  const ts_key index_base=460000u;
  for (uint32_t i=0;i<24;i++) ts_set(indexed, index_base+i, ts_num((double)i));
  ts_object* indexed_obj=(ts_object*)ts_ptr(indexed);
  /* Shaped objects index their keys per shape; dictionaries keep the
     per-object index. Either way all 24 keys must resolve (checked below). */
  CK("prop index threshold", indexed_obj->len==24 &&
     (ts_obj_shape_id(indexed_obj)!=TS_SHAPE_NONE || indexed_obj->prop_index!=NULL));
  CK("prop index grew", ts_obj_shape_id(indexed_obj)!=TS_SHAPE_NONE || (indexed_obj->prop_index && indexed_obj->prop_index[0]>=32));
  int indexed_ok=1;
  for (uint32_t i=0;i<24;i++)
    if (ts_to_num(ts_get(indexed, index_base+i)) != (double)i) indexed_ok=0;
  CK("prop index all hits", indexed_ok);
  CK("prop index delete first", ts_delete_prop(indexed, index_base));
  CK("prop index delete middle", ts_delete_prop(indexed, index_base+11u));
  CK("prop index delete last", ts_delete_prop(indexed, index_base+23u));
  CK("prop index compact values",
     ts_to_num(ts_get(indexed,index_base+1u))==1 &&
     ts_to_num(ts_get(indexed,index_base+12u))==12 &&
     ts_to_num(ts_get(indexed,index_base+22u))==22);
  for (uint32_t i=1;i<=15;i++)
    if (i!=11u) (void)ts_delete_prop(indexed,index_base+i);
  indexed_obj=(ts_object*)ts_ptr(indexed);
  CK("prop index shrinks to linear",
     indexed_obj->len==7 && indexed_obj->prop_index==NULL);
  ts_set(indexed, index_base+100u, ts_num(100));
  indexed_obj=(ts_object*)ts_ptr(indexed);
  CK("prop index rebuild after shrink",
     indexed_obj->len==8 && indexed_obj->prop_index!=NULL &&
     ts_obj_shape_id(indexed_obj)==TS_SHAPE_NONE &&
     ts_to_num(ts_get(indexed,index_base+100u))==100);
  ts_gc_unroot(1);

  /* Force eight keys into one initial-index bucket. This deterministically
     covers the open-addressing probe chain, a missing key at its end, and a
     rebuild after deleting from the middle of the chain. */
  ts_key collision_keys[9];
  uint32_t collision_count=0;
  const uint32_t collision_bucket=test_prop_hash(465000u)&15u;
  for (ts_key key=465000u; collision_count<9; key++){
    if ((test_prop_hash(key)&15u)==collision_bucket)
      collision_keys[collision_count++]=key;
  }
  tsv collisions=ts_new_object(); ts_gc_root(&collisions);
  for (uint32_t i=0;i<8;i++) ts_set(collisions,collision_keys[i],ts_num(200+i));
  ts_object* collision_obj=(ts_object*)ts_ptr(collisions);
  CK("prop index collision setup",
     collision_obj->len==8 &&
     (ts_obj_shape_id(collision_obj)!=TS_SHAPE_NONE || (collision_obj->prop_index && collision_obj->prop_index[0]==16)));
  int collision_ok=1;
  for (uint32_t i=0;i<8;i++)
    if (ts_to_num(ts_get(collisions,collision_keys[i])) != 200+i) collision_ok=0;
  CK("prop index collision hits", collision_ok);
  CK("prop index collision miss", ts_is_undef(ts_get(collisions,collision_keys[8])));
  CK("prop index collision delete", ts_delete_prop(collisions,collision_keys[3]));
  CK("prop index collision rebuild",
     ts_is_undef(ts_get(collisions,collision_keys[3])) &&
     ts_to_num(ts_get(collisions,collision_keys[4]))==204 &&
     ((ts_object*)ts_ptr(collisions))->prop_index==NULL);
  ts_gc_unroot(1);

  /* Register enough distinct class prototypes to grow and probe the class
     registry index. Also verify its min-size guard on a plain impostor. */
  enum { REGISTRY_TEST_COUNT = 24 };
  tsv registry_protos[REGISTRY_TEST_COUNT];
  ts_class_field registry_fields[REGISTRY_TEST_COUNT];
  const ts_key registry_key=470001u;
  int registry_ok=1;
  ts_prop_ic registry_ic=TS_PROP_IC_INIT;
  for (int i=0;i<REGISTRY_TEST_COUNT;i++){
    registry_protos[i]=ts_new_proto(); ts_gc_root(&registry_protos[i]);
    registry_fields[i].name_id=registry_key;
    registry_fields[i].numeric=(i&1);
    registry_fields[i].offset=(i&1)
      ? offsetof(registry_test_class,numeric)
      : offsetof(registry_test_class,boxed);
    ts_register_class(registry_protos[i],&registry_fields[i],1);
    tsv inst=ts_new_sized(sizeof(registry_test_class)); ts_gc_root(&inst);
    registry_test_class* data=(registry_test_class*)ts_ptr(inst);
    data->o.proto=registry_protos[i];
    if (i&1) data->numeric=(double)i+0.5;
    else data->boxed=ts_num((double)i+0.5);
    if (ts_to_num(ts_get_pic_checked_inline(inst,registry_key,&registry_ic)) != (double)i+0.5)
      registry_ok=0;
    ts_set_pic_inline(inst,registry_key,ts_num((double)i+100.5),&registry_ic);
    if (ts_to_num(ts_get(inst,registry_key)) != (double)i+100.5) registry_ok=0;
    ts_gc_unroot(1);
  }
  CK("class registry growth", registry_ok);
  tsv impostor=ts_new_object(); ts_gc_root(&impostor);
  ((ts_object*)ts_ptr(impostor))->proto=registry_protos[REGISTRY_TEST_COUNT-1];
  ts_set(impostor,registry_key,ts_num(777));
  CK("class registry min-size guard", ts_to_num(ts_get(impostor,registry_key))==777);
  ts_gc_unroot(1);
  ts_gc_unroot(REGISTRY_TEST_COUNT);

  /* Frame slots are direct GC roots in both young and full collections. */
  frame_root_test root_frame;
  root_frame.slots[0]=TS_UNDEFINED;
  root_frame.slots[1]=TS_UNDEFINED;
  root_frame.slots[2]=TS_UNDEFINED;
  ts_frame_hdr* frame_before=g_ts_frame_top;
  ts_frame_push(&root_frame.h,3);
  root_frame.slots[0]=ts_new_object();
  ts_set(root_frame.slots[0],480001u,ts_num(81));
  root_frame.slots[1]=ts_new_string("frame-root",10);
  root_frame.slots[2]=ts_new_object();
  ts_set(root_frame.slots[2],480002u,root_frame.slots[1]);
  for (int i=0;i<2000;i++){ tsv tmp=ts_new_object(); ts_set(tmp,(ts_key)i,ts_num(i)); }
  ts_gc_collect_young();
  CK("frame roots survive young",
     ts_to_num(ts_get(root_frame.slots[0],480001u))==81 &&
     ts_strict_eq(ts_get(root_frame.slots[2],480002u),root_frame.slots[1]));
  ts_gc_collect();
  CK("frame roots survive full",
     ts_to_num(ts_get(root_frame.slots[0],480001u))==81 &&
     ts_strict_eq(ts_get(root_frame.slots[2],480002u),root_frame.slots[1]));
  ts_frame_pop(&root_frame.h);
  CK("frame pop restores top", g_ts_frame_top==frame_before);

  /* Escape-guided pretenuring starts cells in old gen. Initial and subsequent
     young references must still participate in the remembered set. */
  tsv pre_owner=ts_new_object_pretenured(); ts_gc_root(&pre_owner);
  CK("pretenured object starts old",
     ((ts_gc_header*)ts_ptr(pre_owner))->gen==TS_GEN_OLD);
  tsv pre_child=ts_new_object();
  ts_set(pre_child,481001u,ts_num(82));
  ts_set(pre_owner,481002u,pre_child);
  CK("pretenured object barrier armed",
     (((ts_gc_header*)ts_ptr(pre_owner))->flags & TS_HDR_REMEMBERED)!=0);
  ts_gc_collect_young();
  CK("pretenured object keeps young child",
     ts_to_num(ts_get(ts_get(pre_owner,481002u),481001u))==82);
  ts_gc_collect();
  CK("pretenured object survives full",
     ts_to_num(ts_get(ts_get(pre_owner,481002u),481001u))==82);
  ts_gc_unroot(1);

  tsv pre_capture=ts_new_object(); ts_gc_root(&pre_capture);
  ts_set(pre_capture,482001u,ts_num(83));
  tsv pre_env[1]={pre_capture};
  tsv pre_fn=ts_make_fn_t_pretenured(fetch_error_catch,pre_env,1,0);
  ts_gc_root(&pre_fn);
  ts_gc_unroot(1);
  CK("pretenured closure starts old",
     ((ts_gc_header*)ts_ptr(pre_fn))->gen==TS_GEN_OLD);
  ts_gc_collect_young();
  tsv pre_capture_after=((ts_func*)ts_ptr(pre_fn))->env[0];
  CK("pretenured closure keeps young capture",
     ts_to_num(ts_get(pre_capture_after,482001u))==83);
  ts_gc_unroot(1);

  /* Map/Set use an insertion-order dense array plus an open-addressing side
     index once the collection is non-trivial. Lookups must remain correct
     through growth, tombstones, and reinsertion. */
  tsv hash_map=ts_new_map(); ts_gc_root(&hash_map);
  tsv hash_set=ts_new_set(); ts_gc_root(&hash_set);
  for (int i=0;i<2048;i++){
    ts_map_set(hash_map,ts_num((double)i),ts_num((double)(i*3)));
    ts_set_add(hash_set,ts_num((double)i));
  }
  /* small integer keys take the direct table (docs/map_direct_index_design.md) in place of the hash index */
  CK("map side index (the direct table for these keys)",
     ((ts_map*)ts_ptr(hash_map))->direct!=NULL &&
     ((ts_map*)ts_ptr(hash_map))->direct_cap>=2048 &&
     ((ts_map*)ts_ptr(hash_map))->index==NULL &&
     ts_to_num(ts_map_get(hash_map,ts_num(1777)))==5331);
  CK("set open-addressing index",
     ((ts_set_t*)ts_ptr(hash_set))->index!=NULL &&
     ts_set_has(hash_set,ts_num(1777)));
  for (int i=0;i<2048;i+=2){
    ts_map_delete(hash_map,ts_num((double)i));
    ts_set_delete(hash_set,ts_num((double)i));
  }
  for (int i=0;i<2048;i+=2){
    ts_map_set(hash_map,ts_num((double)i),ts_num((double)(i*5)));
    ts_set_add(hash_set,ts_num((double)i));
  }
  CK("map indexed churn",
     ts_map_size(hash_map)==2048 &&
     ts_to_num(ts_map_get(hash_map,ts_num(1776)))==8880 &&
     ts_to_num(ts_map_get(hash_map,ts_num(1777)))==5331);
  CK("set indexed churn", ts_set_size(hash_set)==2048 &&
     ts_set_has(hash_set,ts_num(0)) && ts_set_has(hash_set,ts_num(2047)));
  ts_gc_unroot(2);

  /* WeakMap is an ephemeron, not a strong map: a rooted key retains its value,
     dropping the key removes both, and value->key cycles do not self-retain. */
  tsv weak_map=ts_new_weakmap(); ts_gc_root(&weak_map);
  tsv weak_key=ts_new_object(); ts_gc_root(&weak_key);
  tsv weak_key_h=weak_key; /* stale-reference probe for the freed check */
  tsv weak_value=ts_new_object();
  tsv weak_value_h=weak_value; /* stale-reference probe for the freed check */
  ts_set(weak_value,483001u,ts_num(84));
  ts_weakmap_set(weak_map,weak_key,weak_value);
  CK("weakmap basic API",
     ts_is_weakmap(weak_map) && !ts_is_map(weak_map) &&
     ts_weakmap_has(weak_map,weak_key) &&
     ts_weakmap_get(weak_map,weak_key)==weak_value);
  ts_gc_collect();
  CK("weakmap live key retains value",
     ts_ptr(weak_value)!=NULL &&
     ts_to_num(ts_get(ts_weakmap_get(weak_map,weak_key),483001u))==84);
  tsv weak_replacement=ts_new_object();
  tsv weak_replacement_h=weak_replacement;
  ts_set(weak_replacement,483001u,ts_num(840));
  ts_weakmap_set(weak_map,weak_key,weak_replacement);
  ts_gc_collect();
  CK("weakmap replacement releases old value",
     !ts_gc_debug_cell_live(weak_value_h) && ts_ptr(weak_replacement)!=NULL &&
     ts_to_num(ts_get(ts_weakmap_get(weak_map,weak_key),483001u))==840);
  ts_gc_unroot(1); /* weak_key */
  ts_gc_collect();
  CK("weakmap dead key pruned",
     !ts_gc_debug_cell_live(weak_key_h) && !ts_gc_debug_cell_live(weak_replacement_h) &&
     ((ts_map*)ts_ptr(weak_map))->len==0);

  /* Explicit deletion removes the ephemeron immediately. It releases the
     value but of course does not affect a separately rooted key. */
  tsv delete_map=ts_new_weakmap(); ts_gc_root(&delete_map);
  tsv delete_key=ts_new_object(); ts_gc_root(&delete_key);
  tsv delete_value=ts_new_object();
  tsv delete_value_h=delete_value; /* stale-reference probe for the freed check */
  ts_weakmap_set(delete_map,delete_key,delete_value);
  int delete_first=ts_weakmap_delete(delete_map,delete_key);
  int delete_second=ts_weakmap_delete(delete_map,delete_key);
  CK("weakmap delete result",
     delete_first && !delete_second &&
     !ts_weakmap_has(delete_map,delete_key) &&
     ts_is_undef(ts_weakmap_get(delete_map,delete_key)));
  ts_gc_collect();
  CK("weakmap delete releases value",
     ts_ptr(delete_key)!=NULL && !ts_gc_debug_cell_live(delete_value_h) &&
     ((ts_map*)ts_ptr(delete_map))->len==0);
  ts_gc_unroot(2);

  tsv cycle_map=ts_new_weakmap(); ts_gc_root(&cycle_map);
  tsv cycle_key=ts_new_object();
  tsv cycle_key_h=cycle_key; /* stale-reference probe for the freed check */
  tsv cycle_value=ts_new_object();
  tsv cycle_value_h=cycle_value; /* stale-reference probe for the freed check */
  ts_set(cycle_value,483002u,cycle_key); /* value -> key must not close the cycle */
  ts_weakmap_set(cycle_map,cycle_key,cycle_value);
  ts_gc_collect();
  CK("weakmap value-key cycle collected",
     !ts_gc_debug_cell_live(cycle_key_h) && !ts_gc_debug_cell_live(cycle_value_h) &&
     ((ts_map*)ts_ptr(cycle_map))->len==0);
  ts_gc_unroot(1);

  /* Fixpoint ordering: map B is visited before map A. A's live-key value marks
     B's key, so B's value is retained only on a second ephemeron pass. */
  tsv fix_b=ts_new_weakmap(); ts_gc_root(&fix_b);
  tsv fix_a=ts_new_weakmap(); ts_gc_root(&fix_a);
  tsv fix_key_a=ts_new_object(); ts_gc_root(&fix_key_a);
  /* rooted while built (a collection may run at every allocation), then
     held by the ephemerons alone */
  tsv fix_key_b=ts_new_object(); ts_gc_root(&fix_key_b);
  tsv fix_value_a=ts_new_object(); ts_gc_root(&fix_value_a);
  tsv fix_value_b=ts_new_object(); ts_gc_root(&fix_value_b);
  ts_set(fix_value_a,483003u,fix_key_b);
  ts_set(fix_value_b,483004u,ts_num(85));
  ts_weakmap_set(fix_a,fix_key_a,fix_value_a);
  ts_weakmap_set(fix_b,fix_key_b,fix_value_b);
  ts_gc_unroot(3);
  ts_gc_collect();
  CK("weakmap ephemeron fixpoint",
     ts_ptr(fix_key_b)!=NULL && ts_ptr(fix_value_b)!=NULL &&
     ts_to_num(ts_get(ts_weakmap_get(fix_b,fix_key_b),483004u))==85);
  ts_gc_unroot(3);
  ts_gc_collect();

  /* Pruning must work with a populated hash index, not only the small linear
     representation. Keep every even key rooted and let every odd key/value
     die in one collection. */
  tsv mixed_map=ts_new_weakmap(); ts_gc_root(&mixed_map);
  tsv mixed_keys[24], mixed_values[24];
  tsv mixed_keys_h[24], mixed_values_h[24]; /* handle-form probes for the freed checks */
  for (int i=0;i<24;i++){
    /* probes taken at allocation: a later allocation may promote the cell
       (in place, without aging) and rewrite the rooted slot to the pointer
       form, which reads the address whether the cell lives or not */
    mixed_keys[i]=ts_new_object();
    mixed_keys_h[i]=mixed_keys[i];
    ts_gc_root(&mixed_keys[i]);
    mixed_values[i]=ts_new_object();
    mixed_values_h[i]=mixed_values[i];
    ts_set(mixed_values[i],483010u,ts_num((double)i));
    ts_weakmap_set(mixed_map,mixed_keys[i],mixed_values[i]);
  }
  CK("weakmap hash index populated",
     ((ts_map*)ts_ptr(mixed_map))->index!=NULL &&
     ((ts_map*)ts_ptr(mixed_map))->len==24);
  ts_gc_unroot(24);
  for (int i=0;i<24;i+=2) ts_gc_root(&mixed_keys[i]);
  ts_gc_collect();
  int mixed_ok=((ts_map*)ts_ptr(mixed_map))->len==12;
  for (int i=0;i<24;i++){
    if ((i&1)==0){
      mixed_ok = mixed_ok && ts_ptr(mixed_keys[i])!=NULL &&
        ts_ptr(mixed_values[i])!=NULL &&
        ts_weakmap_has(mixed_map,mixed_keys[i]) &&
        ts_to_num(ts_get(ts_weakmap_get(mixed_map,mixed_keys[i]),483010u))==i;
    } else {
      mixed_ok = mixed_ok && !ts_gc_debug_cell_live(mixed_keys_h[i]) &&
        !ts_gc_debug_cell_live(mixed_values_h[i]);
    }
  }
  CK("weakmap indexed mixed-live pruning", mixed_ok);
  ts_gc_unroot(12);
  ts_gc_collect();
  CK("weakmap indexed remainder pruned",
     ((ts_map*)ts_ptr(mixed_map))->len==0);
  ts_gc_unroot(1);

  /* An old WeakMap enters minor collections through the remembered set. Its
     young value is retained only while the corresponding young key is live. */
  tsv minor_weak_map=ts_new_weakmap(); ts_gc_root(&minor_weak_map);
  ts_gc_collect(); /* promote the rooted container */
  CK("weakmap container promoted",
     ((ts_gc_header*)ts_ptr(minor_weak_map))->gen==TS_GEN_OLD);
  tsv minor_weak_key=ts_new_object(); ts_gc_root(&minor_weak_key);
  tsv minor_weak_key_h=minor_weak_key; /* stale-reference probe for the freed check */
  tsv minor_weak_value=ts_new_object();
  tsv minor_weak_value_h=minor_weak_value; /* stale-reference probe for the freed check */
  ts_set(minor_weak_value,483005u,ts_num(86));
  ts_weakmap_set(minor_weak_map,minor_weak_key,minor_weak_value);
  ts_gc_collect_young();
  CK("weakmap minor live key retains value",
     ts_ptr(minor_weak_value)!=NULL &&
     ts_to_num(ts_get(ts_weakmap_get(minor_weak_map,minor_weak_key),483005u))==86);
  int weak_key_remained_young =
    ((ts_gc_header*)ts_ptr(minor_weak_key))->gen==TS_GEN_YOUNG;
  ts_gc_unroot(1);
  /* With allocation-per-GC stress the key may already have aged into OLD
     before this point. A minor deliberately cannot collect an old key, so use
     a full collection in that configuration; the default path remains a
     genuine young-key minor-GC test. */
  if (weak_key_remained_young) ts_gc_collect_young();
  else ts_gc_collect();
  CK("weakmap dead key pruned in its generation",
     !ts_gc_debug_cell_live(minor_weak_key_h) && !ts_gc_debug_cell_live(minor_weak_value_h) &&
     ((ts_map*)ts_ptr(minor_weak_map))->len==0);
  ts_gc_unroot(1);

  /* The opposite generational split is also important: an old key is live for
     a minor collection, so a newly inserted young ephemeron value must live. */
  tsv old_key_map=ts_new_weakmap(); ts_gc_root(&old_key_map);
  tsv old_weak_key=ts_new_object(); ts_gc_root(&old_weak_key);
  tsv old_weak_key_h=old_weak_key;
  ts_gc_collect();
  CK("weakmap key and container promoted",
     ((ts_gc_header*)ts_ptr(old_key_map))->gen==TS_GEN_OLD &&
     ((ts_gc_header*)ts_ptr(old_weak_key))->gen==TS_GEN_OLD);
  tsv young_ephemeron_value=ts_new_object();
  tsv young_ephemeron_value_h=young_ephemeron_value;
  ts_set(young_ephemeron_value,483011u,ts_num(87));
  ts_weakmap_set(old_key_map,old_weak_key,young_ephemeron_value);
  ts_gc_collect_young();
  CK("weakmap old key retains young value",
     ts_ptr(young_ephemeron_value)!=NULL &&
     ts_to_num(ts_get(ts_weakmap_get(old_key_map,old_weak_key),483011u))==87);
  ts_gc_unroot(1);
  ts_gc_collect();
  CK("weakmap old key later collected",
     !ts_gc_debug_cell_live(old_weak_key_h) && !ts_gc_debug_cell_live(young_ephemeron_value_h) &&
     ((ts_map*)ts_ptr(old_key_map))->len==0);
  ts_gc_unroot(1);

  tsv weak_set=ts_new_weakset(); ts_gc_root(&weak_set);
  tsv weak_set_key=ts_new_object(); ts_gc_root(&weak_set_key);
  tsv weak_set_key_h=weak_set_key;
  CK("weakset basic API",
     ts_weakset_add(weak_set,weak_set_key)==weak_set &&
     ts_is_weakset(weak_set) && !ts_is_set(weak_set) &&
     ts_weakset_has(weak_set,weak_set_key));
  tsv duplicate_set_result=ts_weakset_add(weak_set,weak_set_key);
  uint32_t duplicate_set_len=((ts_set_t*)ts_ptr(weak_set))->len;
  int set_delete_first=ts_weakset_delete(weak_set,weak_set_key);
  int set_delete_second=ts_weakset_delete(weak_set,weak_set_key);
  CK("weakset duplicate and delete API",
     duplicate_set_result==weak_set && duplicate_set_len==1 &&
     set_delete_first && !set_delete_second &&
     !ts_weakset_has(weak_set,weak_set_key));
  ts_weakset_add(weak_set,weak_set_key);
  ts_gc_collect();
  CK("weakset live key retained",
     ts_ptr(weak_set_key)!=NULL && ts_weakset_has(weak_set,weak_set_key));
  ts_gc_unroot(1);
  ts_gc_collect();
  CK("weakset dead key pruned",
     !ts_gc_debug_cell_live(weak_set_key_h) &&
     ((ts_set_t*)ts_ptr(weak_set))->len==0);
  ts_gc_unroot(2); /* weak_set + weak_map */

  tsv minor_weak_set=ts_new_weakset(); ts_gc_root(&minor_weak_set);
  ts_gc_collect();
  tsv minor_set_key=ts_new_object(); ts_gc_root(&minor_set_key);
  tsv minor_set_key_h=minor_set_key; /* stale-reference probe for the freed check */
  ts_weakset_add(minor_weak_set,minor_set_key);
  ts_gc_collect_young();
  CK("weakset minor live key retained",
     ts_ptr(minor_set_key)!=NULL && ts_weakset_has(minor_weak_set,minor_set_key));
  int weakset_key_remained_young =
    ((ts_gc_header*)ts_ptr(minor_set_key))->gen==TS_GEN_YOUNG;
  ts_gc_unroot(1);
  if (weakset_key_remained_young) ts_gc_collect_young();
  else ts_gc_collect();
  CK("weakset dead key pruned in its generation",
     !ts_gc_debug_cell_live(minor_set_key_h) &&
     ((ts_set_t*)ts_ptr(minor_weak_set))->len==0);
  ts_gc_unroot(1);

  /* If the container itself is unreachable, neither its weak key nor its
     ephemeron value gains reachability as a side effect of weak processing. */
  tsv orphan_map=ts_new_weakmap(); ts_gc_root(&orphan_map);
  tsv orphan_map_h=orphan_map; /* stale-reference probe for the freed check */
  tsv orphan_key=ts_new_object(); ts_gc_root(&orphan_key);
  tsv orphan_key_h=orphan_key; /* stale-reference probe for the freed check */
  tsv orphan_value=ts_new_object(); ts_gc_root(&orphan_value);
  tsv orphan_value_h=orphan_value; /* stale-reference probe for the freed check */
  ts_weakmap_set(orphan_map,orphan_key,orphan_value);
  ts_gc_unroot(3);
  ts_gc_collect();
  CK("unreachable weakmap and entry collected",
     !ts_gc_debug_cell_live(orphan_map_h) && !ts_gc_debug_cell_live(orphan_key_h) &&
     !ts_gc_debug_cell_live(orphan_value_h));

  int weak_primitive_caught=0;
  tsv primitive_map=ts_new_weakmap(); ts_gc_root(&primitive_map);
  ts_handler* primitive_handler=ts_eh_push();
  if (setjmp(primitive_handler->buf)==0){
    ts_weakmap_set(primitive_map,ts_num(1),ts_num(2));
    ts_eh_pop();
  } else {
    ts_gc_set_root_depth(primitive_handler->gc_root_len);
    ts_eh_pop();
    tsv err=ts_current_exception(); ts_gc_root(&err);
    tsv name=ts_get(err,ts_intern_field("name",4)); ts_gc_root(&name);
    weak_primitive_caught=ts_strict_eq(name,ts_new_string("TypeError",9));
    ts_gc_unroot(2);
  }
  CK("weakmap primitive key throws", weak_primitive_caught);
  CK("weakmap primitive query is absent",
     !ts_weakmap_has(primitive_map,ts_num(1)) &&
     ts_is_undef(ts_weakmap_get(primitive_map,ts_num(1))) &&
     !ts_weakmap_delete(primitive_map,ts_num(1)));
  ts_gc_unroot(1);

  int weakset_primitive_caught=0;
  tsv primitive_set=ts_new_weakset(); ts_gc_root(&primitive_set);
  ts_handler* primitive_set_handler=ts_eh_push();
  if (setjmp(primitive_set_handler->buf)==0){
    ts_weakset_add(primitive_set,TS_NULL);
    ts_eh_pop();
  } else {
    ts_gc_set_root_depth(primitive_set_handler->gc_root_len);
    ts_eh_pop();
    tsv err=ts_current_exception(); ts_gc_root(&err);
    tsv name=ts_get(err,ts_intern_field("name",4)); ts_gc_root(&name);
    weakset_primitive_caught=ts_strict_eq(name,ts_new_string("TypeError",9));
    ts_gc_unroot(2);
  }
  CK("weakset primitive key throws", weakset_primitive_caught);
  CK("weakset primitive query is absent",
     !ts_weakset_has(primitive_set,TS_NULL) &&
     !ts_weakset_delete(primitive_set,TS_NULL));
  ts_gc_unroot(1);

  /* Functions have collectible identity too; exercise the special function
     tag path in weak_key_valid rather than only ordinary OBJECT-tagged keys. */
  tsv function_weak_map=ts_new_weakmap(); ts_gc_root(&function_weak_map);
  tsv function_weak_key=ts_make_fn(fetch_header_value_to_string,NULL,0);
  tsv function_weak_key_h=function_weak_key;
  ts_gc_root(&function_weak_key);
  tsv function_weak_value=ts_new_object();
  tsv function_weak_value_h=function_weak_value;
  ts_set(function_weak_value,483012u,ts_num(88));
  ts_weakmap_set(function_weak_map,function_weak_key,function_weak_value);
  ts_gc_collect();
  CK("weakmap function key retains value",
     ts_ptr(function_weak_key)!=NULL && ts_ptr(function_weak_value)!=NULL &&
     ts_to_num(ts_get(ts_weakmap_get(function_weak_map,function_weak_key),483012u))==88);
  ts_gc_unroot(1);
  ts_gc_collect();
  CK("weakmap dead function key pruned",
     !ts_gc_debug_cell_live(function_weak_key_h) && !ts_gc_debug_cell_live(function_weak_value_h) &&
     ((ts_map*)ts_ptr(function_weak_map))->len==0);
  ts_gc_unroot(1);

  int weak_brand_caught=0;
  tsv ordinary_map=ts_new_map(); ts_gc_root(&ordinary_map);
  ts_handler* weak_brand_handler=ts_eh_push();
  if (setjmp(weak_brand_handler->buf)==0){
    (void)ts_weakmap_get(ordinary_map,TS_NULL);
    ts_eh_pop();
  } else {
    ts_gc_set_root_depth(weak_brand_handler->gc_root_len);
    ts_eh_pop();
    tsv err=ts_current_exception(); ts_gc_root(&err);
    tsv name=ts_get(err,ts_intern_field("name",4)); ts_gc_root(&name);
    weak_brand_caught=ts_strict_eq(name,ts_new_string("TypeError",9));
    ts_gc_unroot(2);
  }
  CK("weakmap incompatible receiver throws", weak_brand_caught);
  ts_gc_unroot(1);

  /* CanBeHeldWeakly(Symbol): ordinary Symbols are weak identities, registered
     Symbol.for values are rejected, and well-known Symbols are accepted (their
     permanent runtime roots make the corresponding value effectively live). */
  tsv symbol_weak_map=ts_new_weakmap(); ts_gc_root(&symbol_weak_map);
  tsv symbol_weak_set=ts_new_weakset(); ts_gc_root(&symbol_weak_set);
  tsv weak_symbol=ts_symbol_new(ts_new_string("weak-key",8)); ts_gc_root(&weak_symbol);
  tsv weak_symbol_h=weak_symbol;
  tsv weak_symbol_value=ts_new_object();
  tsv weak_symbol_value_h=weak_symbol_value;
  ts_set(weak_symbol_value,483101u,ts_num(101));
  ts_weakmap_set(symbol_weak_map,weak_symbol,weak_symbol_value);
  ts_weakset_add(symbol_weak_set,weak_symbol);
  ts_gc_collect();
  CK("ordinary symbol accepted as weak key",
     ts_weakmap_has(symbol_weak_map,weak_symbol) &&
     ts_weakset_has(symbol_weak_set,weak_symbol) &&
     ts_to_num(ts_get(ts_weakmap_get(symbol_weak_map,weak_symbol),483101u))==101);
  ts_gc_unroot(1);
  ts_gc_collect();
  CK("ordinary weak symbol collected",
     !ts_gc_debug_cell_live(weak_symbol_h) && !ts_gc_debug_cell_live(weak_symbol_value_h) &&
     ((ts_map*)ts_ptr(symbol_weak_map))->len==0 &&
     ((ts_set_t*)ts_ptr(symbol_weak_set))->len==0);
  ts_gc_unroot(2);

  /* A weak-map value that points back to its Symbol key is still an
     ephemeron-only cycle and must not keep either side alive. */
  tsv symbol_cycle_map=ts_new_weakmap(); ts_gc_root(&symbol_cycle_map);
  tsv symbol_cycle_key=ts_symbol_new(ts_new_string("symbol-cycle",12));
  tsv symbol_cycle_key_h=symbol_cycle_key; /* stale-reference probe for the freed check */
  ts_gc_root(&symbol_cycle_key);
  tsv symbol_cycle_value=ts_new_object(); ts_gc_root(&symbol_cycle_value);
  tsv symbol_cycle_value_h=symbol_cycle_value; /* stale-reference probe for the freed check */
  ts_set(symbol_cycle_value,483106u,symbol_cycle_key);
  ts_weakmap_set(symbol_cycle_map,symbol_cycle_key,symbol_cycle_value);
  ts_gc_unroot(2);
  ts_gc_collect();
  CK("symbol weak value-key cycle collected",
     !ts_gc_debug_cell_live(symbol_cycle_key_h) && !ts_gc_debug_cell_live(symbol_cycle_value_h) &&
     ((ts_map*)ts_ptr(symbol_cycle_map))->len==0);
  ts_gc_unroot(1);

  /* A Symbol used as an own property name is strongly reachable from the
     property owner even though ts_prop stores only its compact sym_id. */
  tsv symbol_owner=ts_new_object(); ts_gc_root(&symbol_owner);
  tsv property_symbol_map=ts_new_weakmap(); ts_gc_root(&property_symbol_map);
  tsv property_symbol=ts_symbol_new(ts_new_string("property-key",12));
  tsv property_symbol_h=property_symbol; /* stale-reference probe for the freed check */
  ts_gc_root(&property_symbol);
  tsv property_symbol_value=ts_new_object();
  tsv property_symbol_value_h=property_symbol_value; /* stale-reference probe for the freed check */
  ts_set(property_symbol_value,483102u,ts_num(102));
  ts_set_symkey(symbol_owner,property_symbol,ts_num(1));
  ts_weakmap_set(property_symbol_map,property_symbol,property_symbol_value);
  ts_key property_symbol_key=ts_symbol_key(property_symbol);
  ts_gc_unroot(1);
  ts_gc_collect();
  tsv own_symbols=ts_object_get_own_property_symbols(symbol_owner);
  ts_gc_root(&own_symbols);
  CK("symbol property key is strong edge",
     ts_ptr(property_symbol)!=NULL && ts_ptr(property_symbol_value)!=NULL &&
     ts_array_len(own_symbols)==1 &&
     ts_strict_eq(ts_array_get(own_symbols,0), property_symbol) &&
     ts_to_num(ts_get(ts_weakmap_get(property_symbol_map,property_symbol),483102u))==102);
  ts_gc_unroot(1);
  ts_delete_prop(symbol_owner,property_symbol_key);
  ts_gc_collect();
  CK("deleted symbol property releases weak key",
     !ts_gc_debug_cell_live(property_symbol_h) && !ts_gc_debug_cell_live(property_symbol_value_h) &&
     ((ts_map*)ts_ptr(property_symbol_map))->len==0);
  ts_gc_unroot(2);

  /* The same property-name edge must cross the old->young boundary through the
     remembered set. */
  tsv old_symbol_owner=ts_new_object(); ts_gc_root(&old_symbol_owner);
  tsv old_symbol_map=ts_new_weakmap(); ts_gc_root(&old_symbol_map);
  ts_gc_collect();
  tsv young_symbol=ts_symbol_new(ts_new_string("young-key",9)); ts_gc_root(&young_symbol);
  tsv young_symbol_h=young_symbol; /* stale-reference probe for the freed check */
  tsv young_symbol_value=ts_new_object();
  tsv young_symbol_value_h=young_symbol_value; /* stale-reference probe for the freed check */
  ts_set(young_symbol_value,483103u,ts_num(103));
  ts_set_symkey(old_symbol_owner,young_symbol,ts_num(1));
  ts_weakmap_set(old_symbol_map,young_symbol,young_symbol_value);
  ts_key young_symbol_key=ts_symbol_key(young_symbol);
  ts_gc_unroot(1);
  ts_gc_collect_young();
  CK("symbol property key remembered in minor gc",
     ts_ptr(young_symbol)!=NULL && ts_ptr(young_symbol_value)!=NULL &&
     ts_to_num(ts_get(ts_weakmap_get(old_symbol_map,young_symbol),483103u))==103);
  ts_delete_prop(old_symbol_owner,young_symbol_key);
  ts_gc_collect();
  CK("minor-retained symbol released after delete",
     !ts_gc_debug_cell_live(young_symbol_h) && !ts_gc_debug_cell_live(young_symbol_value_h) &&
     ((ts_map*)ts_ptr(old_symbol_map))->len==0);
  ts_gc_unroot(2);

  /* Fixed-point ordering through a Symbol property-name edge: B is visited
     first; A's live value then marks B's Symbol key. */
  tsv symbol_fix_b=ts_new_weakmap(); ts_gc_root(&symbol_fix_b);
  tsv symbol_fix_a=ts_new_weakmap(); ts_gc_root(&symbol_fix_a);
  tsv symbol_fix_key_a=ts_new_object(); ts_gc_root(&symbol_fix_key_a);
  tsv symbol_fix_key_b=ts_symbol_new(ts_new_string("fix-key",7)); ts_gc_root(&symbol_fix_key_b);
  tsv symbol_fix_value_a=ts_new_object(); ts_gc_root(&symbol_fix_value_a);
  tsv symbol_fix_value_b=ts_new_object(); ts_gc_root(&symbol_fix_value_b);
  ts_set_symkey(symbol_fix_value_a,symbol_fix_key_b,ts_num(1));
  ts_set(symbol_fix_value_b,483104u,ts_num(104));
  ts_weakmap_set(symbol_fix_a,symbol_fix_key_a,symbol_fix_value_a);
  ts_weakmap_set(symbol_fix_b,symbol_fix_key_b,symbol_fix_value_b);
  ts_gc_unroot(3); /* value B, value A, Symbol key B */
  ts_gc_collect();
  CK("symbol-key ephemeron fixpoint",
     ts_ptr(symbol_fix_key_b)!=NULL && ts_ptr(symbol_fix_value_b)!=NULL &&
     ts_to_num(ts_get(ts_weakmap_get(symbol_fix_b,symbol_fix_key_b),483104u))==104);
  ts_gc_unroot(3);
  ts_gc_collect();

  /* The collector visits the Symbol.for registry as slots
     (docs/gc_v2_design.md §6.5 step 1b): once its young key and symbol are
     promoted, the registry holds both in the pointer form. */
  tsv registry_probe=ts_symbol_for(ts_new_string("registry-slot-probe",19));
  ts_gc_root(&registry_probe);
  ts_gc_collect();
  tsv registry_again=ts_symbol_for(ts_new_string("registry-slot-probe",19));
  tsv registry_probe_key=ts_symbol_key_for(registry_again);
  CK("symbol registry slots take the pointer form",
     ts_strict_eq(registry_again,registry_probe) &&
     ((ts_gc_header*)ts_ptr(registry_again))->gen==TS_GEN_OLD &&
     ((registry_again & TS_PAYLOAD_MASK) & 1u)==0 &&
     ts_is_str(registry_probe_key) && ((registry_probe_key & TS_PAYLOAD_MASK) & 1u)==0);
  ts_gc_unroot(1);

  int registered_symbol_caught=0, registered_symbol_set_caught=0;
  tsv registered_symbol_map=ts_new_weakmap(); ts_gc_root(&registered_symbol_map);
  tsv registered_symbol_set=ts_new_weakset(); ts_gc_root(&registered_symbol_set);
  tsv registered_symbol=ts_symbol_for(ts_new_string("registered-weak-key",19));
  ts_gc_root(&registered_symbol);
  ts_handler* registered_symbol_handler=ts_eh_push();
  if (setjmp(registered_symbol_handler->buf)==0){
    ts_weakmap_set(registered_symbol_map,registered_symbol,ts_num(1));
    ts_eh_pop();
  } else {
    ts_gc_set_root_depth(registered_symbol_handler->gc_root_len);
    ts_eh_pop();
    tsv err=ts_current_exception(); ts_gc_root(&err);
    tsv name=ts_get(err,ts_intern_field("name",4)); ts_gc_root(&name);
    registered_symbol_caught=ts_strict_eq(name,ts_new_string("TypeError",9));
    ts_gc_unroot(2);
  }
  ts_handler* registered_symbol_set_handler=ts_eh_push();
  if (setjmp(registered_symbol_set_handler->buf)==0){
    ts_weakset_add(registered_symbol_set,registered_symbol);
    ts_eh_pop();
  } else {
    ts_gc_set_root_depth(registered_symbol_set_handler->gc_root_len);
    ts_eh_pop();
    tsv err=ts_current_exception(); ts_gc_root(&err);
    tsv name=ts_get(err,ts_intern_field("name",4)); ts_gc_root(&name);
    registered_symbol_set_caught=ts_strict_eq(name,ts_new_string("TypeError",9));
    ts_gc_unroot(2);
  }
  CK("registered symbol weak key throws",
     registered_symbol_caught && registered_symbol_set_caught &&
     !ts_weakmap_has(registered_symbol_map,registered_symbol) &&
     ts_is_undef(ts_weakmap_get(registered_symbol_map,registered_symbol)) &&
     !ts_weakmap_delete(registered_symbol_map,registered_symbol) &&
     !ts_weakset_has(registered_symbol_set,registered_symbol) &&
     !ts_weakset_delete(registered_symbol_set,registered_symbol));
  ts_gc_unroot(3);

  tsv well_known_symbol_map=ts_new_weakmap(); ts_gc_root(&well_known_symbol_map);
  tsv well_known_symbol_set=ts_new_weakset(); ts_gc_root(&well_known_symbol_set);
  tsv well_known_symbol=ts_wksym(TS_WKSYM_ITERATOR);
  tsv well_known_symbol_value=ts_new_object();
  ts_set(well_known_symbol_value,483105u,ts_num(105));
  ts_weakmap_set(well_known_symbol_map,well_known_symbol,well_known_symbol_value);
  ts_weakset_add(well_known_symbol_set,well_known_symbol);
  ts_gc_collect();
  CK("well-known symbol accepted as weak key",
     ts_ptr(well_known_symbol_value)!=NULL &&
     ts_to_num(ts_get(ts_weakmap_get(well_known_symbol_map,well_known_symbol),483105u))==105 &&
     ts_weakset_has(well_known_symbol_set,well_known_symbol));
  ts_gc_unroot(2);

  /* longjmp must unlink every frame pushed after the handler snapshot. */
  tsv frame_exception=ts_new_object(); ts_gc_root(&frame_exception);
  ts_set(frame_exception,490001u,ts_num(91));
  ts_frame_hdr* exception_top=g_ts_frame_top;
  ts_handler* frame_handler=ts_eh_push();
  if (setjmp(frame_handler->buf)==0){
    throw_from_nested_frame(frame_exception);
    CK("frame exception reached", 0);
  } else {
    ts_gc_set_root_depth(frame_handler->gc_root_len);
    CK("frame exception restores top", g_ts_frame_top==exception_top);
    CK("frame exception payload",
       ts_strict_eq(ts_current_exception(),frame_exception) &&
       ts_to_num(ts_get(ts_current_exception(),490001u))==91);
    ts_eh_pop();
  }
  ts_gc_unroot(1);
  /* nested object reachable through GC */
  tsv inner=ts_new_object(); ts_set(inner,1,ts_num(123)); ts_set(o,300,inner);
  /* strings + add */
  tsv s=ts_new_string("hi",2); ts_gc_root(&s);
  CK("short string immediate", ts_is_short_str(s) && ts_str_len_typed(s)==2 &&
     ts_str_charcodeat_i64_typed(s,0)=='h' && ts_str_charcodeat_i64_typed(s,1)=='i');
  tsv long6=ts_new_string("abcdef",6); ts_gc_root(&long6);
  CK("six-char string heap", ts_is_heap_str(long6) && ts_str_len_typed(long6)==6);
  uint32_t utf8_len = 0;
  char* utf8_copy = ts_string_utf8_copy(s, &utf8_len);
  CK("utf8 copy short string", utf8_len == 2 && !memcmp(utf8_copy, "hi\0", 3));
  free(utf8_copy);
  const uint32_t utf8_units[] = {0, 0xe9, 0x6f22, 0xd83d, 0xde00, 0xd800, 'x', 0xdc00};
  tsv utf8_source = ts_string_from_codepoints(utf8_units, 8); ts_gc_root(&utf8_source);
  const char utf8_expected[] = "\0\xc3\xa9\xe6\xbc\xa2\xf0\x9f\x98\x80\xef\xbf\xbdx\xef\xbf\xbd";
  utf8_copy = ts_string_utf8_copy(utf8_source, &utf8_len);
  CK("utf8 copy NUL unicode and lone surrogates", utf8_len == sizeof(utf8_expected)-1 &&
     !memcmp(utf8_copy, utf8_expected, sizeof(utf8_expected)));
  free(utf8_copy);
  ts_gc_unroot(1);
  CK("str truthy", ts_truthy(s));
  tsv cat=ts_add(s, ts_num(5)); /* "hi"+5 = "hi5" */
  CK("str concat num", ts_is_short_str(cat) &&
     ts_strict_eq(cat,ts_new_string("hi5",3)));
  tsv rxsrc=ts_new_string("abcabc",6); ts_gc_root(&rxsrc);
  tsv rxpre=ts_new_string("bc",2); ts_gc_root(&rxpre);
  ts_regexp_litprefix_match rxm={0,0};
  CK("regexp litprefix ascii", ts_regexp_litprefix_find_view(ts_str_view_typed(rxsrc), ts_str_view_typed(rxpre), 0, 0, &rxm) && rxm.start==1 && rxm.end==3);
  CK("regexp litprefix start", ts_regexp_litprefix_find_view(ts_str_view_typed(rxsrc), ts_str_view_typed(rxpre), 2, 0, &rxm) && rxm.start==4 && rxm.end==6);
  CK("regexp litprefix sticky ok", ts_regexp_litprefix_find_view(ts_str_view_typed(rxsrc), ts_str_view_typed(rxpre), 1, 1, &rxm) && rxm.start==1 && rxm.end==3);
  CK("regexp litprefix sticky miss", !ts_regexp_litprefix_find_view(ts_str_view_typed(rxsrc), ts_str_view_typed(rxpre), 2, 1, &rxm));
  tsv rxempty=ts_new_string("",0); ts_gc_root(&rxempty);
  CK("regexp litprefix empty", ts_regexp_litprefix_find_view(ts_str_view_typed(rxsrc), ts_str_view_typed(rxempty), 99, 0, &rxm) && rxm.start==6 && rxm.end==6);
  tsv rxbmp=ts_new_string("a\343\201\202b",5); ts_gc_root(&rxbmp);
  tsv rxbmppre=ts_new_string("\343\201\202b",4); ts_gc_root(&rxbmppre);
  CK("regexp litprefix utf16", ts_regexp_litprefix_find_view(ts_str_view_typed(rxbmp), ts_str_view_typed(rxbmppre), 0, 0, &rxm) && rxm.start==1 && rxm.end==3);
  ts_gc_unroot(6);
  int replace_short_ok = replace_unit_metrics_match(ts_new_string("a-+a", 4));
  CK("replace unit metrics short", replace_short_ok);
  int replace_empty_ok = replace_unit_metrics_match(ts_new_string("", 0));
  CK("replace unit metrics empty", replace_empty_ok);
  const char replace_mixed[] = "\xc3\xa9-\xe6\xbc\xa2\xf0\x9f\x98\x80-\0+\xc3\xa9";
  int replace_mixed_ok = replace_unit_metrics_match(
    ts_new_string(replace_mixed, sizeof(replace_mixed) - 1));
  CK("replace unit metrics mixed UTF16", replace_mixed_ok);
  /* numeric add */
  CK("num add", ts_to_num(ts_add(ts_num(2),ts_num(3)))==5);
  /* strict eq */
  CK("eq num", ts_strict_eq(ts_num(5),ts_num(5)));
  CK("neq num", !ts_strict_eq(ts_num(5),ts_num(6)));
  tsv eqs1=ts_new_string("ab",2); ts_gc_root(&eqs1);
  tsv eqs2=ts_new_string("ab",2); ts_gc_root(&eqs2);
  CK("eq str", ts_strict_eq(eqs1, eqs2));
  ts_gc_unroot(2);
  /* force GC: allocate a lot, ensure rooted o/inner survive */
  for (int i=0;i<5000;i++){ tsv tmp=ts_new_object(); ts_set(tmp,i,ts_num(i)); (void)tmp; }
  ts_gc_collect();
  CK("obj survives GC", ts_to_num(ts_get(o,100))==70);
  CK("nested survives GC", ts_to_num(ts_get(ts_get(o,300),1))==123);
  /* Headers.get/has use case-insensitive lookup over the simplified Headers
     object; absent values follow the Web API surface (get -> null, has -> false). */
  tsv hobj=ts_headers_new(TS_UNDEFINED); ts_gc_root(&hobj);
  ts_set_cstr(hobj, "content-type", ts_new_string("text/plain", 10));
  tsv hname=ts_new_string("Content-Type", 12); ts_gc_root(&hname);
  tsv hv=ts_headers_get(hobj, hname); ts_gc_root(&hv);
  tsv hexpect=ts_new_string("text/plain", 10); ts_gc_root(&hexpect);
  tsv hname2=ts_new_string("CONTENT-TYPE", 12); ts_gc_root(&hname2);
  tsv hmissing=ts_new_string("x-missing", 9); ts_gc_root(&hmissing);
  CK("headers get case-insensitive", ts_strict_eq(hv, hexpect));
  CK("headers has case-insensitive", ts_headers_has(hobj, hname2));
  CK("headers get missing null", ts_is_null(ts_headers_get(hobj, hmissing)));
  CK("headers has missing false", !ts_headers_has(hobj, hmissing));
  tsv hkeys=ts_headers_keys(hobj); ts_gc_root(&hkeys);
  tsv hvals=ts_headers_values(hobj); ts_gc_root(&hvals);
  tsv hents=ts_headers_entries(hobj); ts_gc_root(&hents);
  tsv hkeyexpect=ts_new_string("content-type", 12); ts_gc_root(&hkeyexpect);
  CK("headers keys array", ts_array_len(hkeys)==1 && ts_strict_eq(ts_array_get(hkeys, 0), hkeyexpect));
  CK("headers values array", ts_array_len(hvals)==1 && ts_strict_eq(ts_array_get(hvals, 0), hexpect));
  tsv hpair=ts_array_get(hents, 0);
  CK("headers entries array", ts_array_len(hents)==1 && ts_array_len(hpair)==2 &&
     ts_strict_eq(ts_array_get(hpair, 0), hkeyexpect) && ts_strict_eq(ts_array_get(hpair, 1), hexpect));
  tsv hmutn=ts_new_string("X-Mut", 5); ts_gc_root(&hmutn);
  tsv hmutv1=ts_new_string(" one ", 5); ts_gc_root(&hmutv1);
  tsv hmutv2=ts_new_string("two", 3); ts_gc_root(&hmutv2);
  tsv hmutexpect=ts_new_string("one, two", 8); ts_gc_root(&hmutexpect);
  ts_headers_set(hobj, hmutn, hmutv1);
  CK("headers set trims value", ts_strict_eq(ts_headers_get(hobj, hmutn), ts_new_string("one", 3)));
  ts_headers_append(hobj, hmutn, hmutv2);
  CK("headers append joins", ts_strict_eq(ts_headers_get(hobj, hmutn), hmutexpect));
  ts_headers_delete(hobj, hmutn);
  CK("headers delete removes", !ts_headers_has(hobj, hmutn));
  tsv hctorinit=ts_new_object(); ts_gc_root(&hctorinit);
  ts_set_cstr(hctorinit, "X-Init", ts_new_string(" first ", 7));
  tsv hctor=ts_headers_new(hctorinit); ts_gc_root(&hctor);
  tsv hctorname=ts_new_string("x-init", 6); ts_gc_root(&hctorname);
  tsv hctorexpect=ts_new_string("first", 5); ts_gc_root(&hctorexpect);
  CK("headers ctor object init", ts_strict_eq(ts_headers_get(hctor, hctorname), hctorexpect));
  tsv hpairs=ts_new_array(0); ts_gc_root(&hpairs);
  tsv hp1=ts_new_array(0); ts_gc_root(&hp1);
  tsv hp2=ts_new_array(0); ts_gc_root(&hp2);
  ts_array_push(hp1, ts_new_string("X-Pair", 6));
  ts_array_push(hp1, ts_new_string("one", 3));
  ts_array_push(hp2, ts_new_string("x-pair", 6));
  ts_array_push(hp2, ts_new_string(" two ", 5));
  ts_array_push(hpairs, hp1);
  ts_array_push(hpairs, hp2);
  tsv hctor2=ts_headers_new(hpairs); ts_gc_root(&hctor2);
  tsv hpairname=ts_new_string("X-Pair", 6); ts_gc_root(&hpairname);
  tsv hpairexpect=ts_new_string("one, two", 8); ts_gc_root(&hpairexpect);
  CK("headers ctor pair init appends", ts_strict_eq(ts_headers_get(hctor2, hpairname), hpairexpect));
  ts_key hgetmethod = TS_KEY_METHOD(4242u);
  ts_headers_proto_register(hgetmethod, "get", ts_headersproto_get);
  tsv hmethod=ts_get(hctor, hgetmethod); ts_gc_root(&hmethod);
  tsv hcallargs[3]={hmethod, hctor, hctorname};
  tsv hcallgot=ts_funcproto_call(hcallargs, 3); ts_gc_root(&hcallgot);
  CK("headers proto method call", ts_strict_eq(hcallgot, hctorexpect));
  tsv hbindargs[2]={hmethod, hctor};
  tsv hbound=ts_funcproto_bind(hbindargs, 2); ts_gc_root(&hbound);
  tsv hboundargs[1]={hctorname};
  tsv hboundgot=ts_call_value(hbound, hboundargs, 1); ts_gc_root(&hboundgot);
  CK("headers proto method bind", ts_strict_eq(hboundgot, hctorexpect));
  CK("headers illegal invocation throws", headers_get_illegal_invocation_caught());
  ts_gc_unroot(14);
  tsv himmut=ts_headers_new(TS_UNDEFINED); ts_gc_root(&himmut);
  tsv himmutname=ts_new_string("X-Imm", 5); ts_gc_root(&himmutname);
  tsv himmutexpect=ts_new_string("locked", 6); ts_gc_root(&himmutexpect);
  ts_headers_set(himmut, himmutname, himmutexpect);
  ts_headers_make_immutable(himmut);
  CK("headers immutable append throws", headers_immutable_mutation_caught(0));
  CK("headers immutable set throws", headers_immutable_mutation_caught(1));
  CK("headers immutable delete throws", headers_immutable_mutation_caught(2));
  CK("headers immutable frozen", ts_truthy(ts_object_is_frozen(himmut)));
  ts_gc_unroot(3);
  ts_gc_unroot(14);
  fetch_error_caught = 0;
  tsv badurl=ts_new_string("http://", 7); ts_gc_root(&badurl);
  tsv badopts=ts_new_object(); ts_gc_root(&badopts);
  ts_set_cstr(badopts, "timeoutMs", ts_num(1.0));
  tsv badp=ts_fetch(badurl, badopts); ts_gc_root(&badp);
  tsv badhandler=ts_make_fn(fetch_error_catch, NULL, 0); ts_gc_root(&badhandler);
  tsv badcatch=ts_promise_catch(badp, badhandler); ts_gc_root(&badcatch);
  ts_run_event_loop();
  CK("fetch malformed rejects with timeout option", fetch_error_caught);
  ts_gc_unroot(5);
  tsv ac=ts_abort_controller_new(); ts_gc_root(&ac);
  tsv asig=ts_get(ac, ts_intern_field("signal", 6)); ts_gc_root(&asig);
  CK("abort signal initially false", !ts_abort_signal_is_aborted(asig));
  tsv abortm=ts_get(ac, ts_intern_field("abort", 5)); ts_gc_root(&abortm);
  tsv abortargs[1]={ac};
  ts_call_method(abortm, abortargs, 1);
  CK("abort signal flips true", ts_abort_signal_is_aborted(asig));
  tsv abort_reason=ts_abort_signal_reason(asig); ts_gc_root(&abort_reason);
  tsv abort_reason_name=ts_get(abort_reason, ts_intern_field("name", 4)); ts_gc_root(&abort_reason_name);
  tsv abort_reason_expect=ts_new_string("AbortError", 10); ts_gc_root(&abort_reason_expect);
  CK("abort signal reason default", ts_strict_eq(abort_reason_name, abort_reason_expect));
  ts_gc_unroot(3);
  tsv rac=ts_abort_controller_new(); ts_gc_root(&rac);
  tsv rsig=ts_get(rac, ts_intern_field("signal", 6)); ts_gc_root(&rsig);
  tsv rcustom=ts_new_string("custom reason", 13); ts_gc_root(&rcustom);
  tsv rm=ts_get(rac, ts_intern_field("abort", 5)); ts_gc_root(&rm);
  tsv rargs[2]={rac, rcustom};
  ts_call_method(rm, rargs, 2);
  CK("abort custom reason", ts_strict_eq(ts_abort_signal_reason(rsig), rcustom));
  ts_abort_controller_abort(rac);
  CK("abort reason idempotent", ts_strict_eq(ts_abort_signal_reason(rsig), rcustom));
  ts_gc_unroot(4);
  fetch_abort_caught = 0;
  tsv abortopts=ts_new_object(); ts_gc_root(&abortopts);
  ts_set_cstr(abortopts, "signal", asig);
  tsv aborturl=ts_new_string("https://example.invalid/", 24); ts_gc_root(&aborturl);
  tsv abortp=ts_fetch(aborturl, abortopts); ts_gc_root(&abortp);
  tsv aborthandler=ts_make_fn(fetch_abort_catch, NULL, 0); ts_gc_root(&aborthandler);
  tsv abortcatch=ts_promise_catch(abortp, aborthandler); ts_gc_root(&abortcatch);
  ts_run_event_loop();
  CK("fetch aborted signal rejects", fetch_abort_caught);
  ts_gc_unroot(8);
  tsv qac=ts_abort_controller_new(); ts_gc_root(&qac);
  tsv qsig=ts_get(qac, ts_intern_field("signal", 6)); ts_gc_root(&qsig);
  fetch_abort_caught = 0;
  tsv qopts=ts_new_object(); ts_gc_root(&qopts);
  ts_set_cstr(qopts, "signal", qsig);
  tsv qurl=ts_new_string("https://example.invalid/", 24); ts_gc_root(&qurl);
  tsv qp=ts_fetch(qurl, qopts); ts_gc_root(&qp);
  tsv qhandler=ts_make_fn(fetch_abort_catch, NULL, 0); ts_gc_root(&qhandler);
  tsv qcatch=ts_promise_catch(qp, qhandler); ts_gc_root(&qcatch);
  ts_abort_controller_abort(qac);
  ts_run_event_loop();
  CK("fetch queued abort rejects", fetch_abort_caught);
  ts_gc_unroot(7);
  tsv timeout_sig=ts_abort_signal_timeout(ts_num(0.0)); ts_gc_root(&timeout_sig);
  CK("AbortSignal.timeout starts false", !ts_abort_signal_is_aborted(timeout_sig));
  fetch_timeout_caught = 0;
  tsv timeout_opts=ts_new_object(); ts_gc_root(&timeout_opts);
  ts_set_cstr(timeout_opts, "signal", timeout_sig);
  tsv timeout_url=ts_new_string("https://example.invalid/", 24); ts_gc_root(&timeout_url);
  tsv timeout_p=ts_fetch(timeout_url, timeout_opts); ts_gc_root(&timeout_p);
  tsv timeout_handler=ts_make_fn(fetch_timeout_catch, NULL, 0); ts_gc_root(&timeout_handler);
  tsv timeout_catch=ts_promise_catch(timeout_p, timeout_handler); ts_gc_root(&timeout_catch);
  ts_run_event_loop();
  CK("AbortSignal.timeout flips true", ts_abort_signal_is_aborted(timeout_sig));
  CK("fetch timeout signal rejects", fetch_timeout_caught);
  tsv timeout_reason=ts_abort_signal_reason(timeout_sig); ts_gc_root(&timeout_reason);
  tsv timeout_reason_name=ts_get(timeout_reason, ts_intern_field("name", 4)); ts_gc_root(&timeout_reason_name);
  tsv timeout_reason_expect=ts_new_string("TimeoutError", 12); ts_gc_root(&timeout_reason_expect);
  CK("AbortSignal.timeout reason", ts_strict_eq(timeout_reason_name, timeout_reason_expect));
  ts_gc_unroot(3);
  ts_gc_unroot(6);
  /* fetch option snapshot: exercise method/body/headers extraction without
     running the event loop, so the test is network-independent. */
  tsv opts=ts_new_object(); ts_gc_root(&opts);
  tsv headers=ts_new_object(); ts_gc_root(&headers);
  ts_set_cstr(opts, "method", ts_new_string("POST", 4));
  ts_set_cstr(opts, "body", ts_new_string("{\"hello\":\"world\"}", 17));
  ts_set_cstr(opts, "timeoutMs", ts_num(250.0));
  ts_set_cstr(headers, "Content-Type", ts_new_string("application/json", 16));
  ts_set_cstr(headers, "X-Tsaot-Test", ts_new_string("marker123", 9));
  tsv getter=ts_make_fn(fetch_header_getter, NULL, 0);
  ts_define_accessor_attr(headers, ts_intern_field("X-Tsaot-Accessor", 16), getter, TS_UNDEFINED, 0, 0, 1, 1);
  ts_set_cstr(opts, "headers", headers);
  tsv url=ts_new_string("http://127.0.0.1:1/noop", 23); ts_gc_root(&url);
  tsv fp=ts_fetch(url, opts); ts_gc_root(&fp);
  CK("fetch snapshot promise", ts_is_obj(fp));
  ts_gc_collect_young();
  CK("fetch promise survives minor", ts_is_obj(fp));
  ts_gc_unroot(4);
  ts_gc_unroot(2);
  /* Allocation-site pretenuring (docs/site_pretenuring_design.md): a site
     whose cells survive their collection allocates old, an old cell keeps a
     young prototype and a young property alive through the barrier, and a
     tenured site whose old cells die in a full collection returns to young. */
  {
    const uint32_t site = 7u;
    const size_t size = sizeof(ts_sized_head) + 2u * sizeof(tsv);
    tsv keep = ts_new_array(0); ts_gc_root(&keep);
    tsv proto = ts_new_object(); ts_gc_root(&proto);
    int young_first = 0;
    for (int i = 0; i < 200; i++){
      tsv x = ts_new_sized_site(size, site, proto);
      if (i == 0)   /* before anything else allocates (the stress gate collects at every allocation) */
        young_first = ((ts_gc_header*)ts_ptr(x))->gen == TS_GEN_YOUNG
          && ((ts_gc_header*)ts_ptr(x))->spare == site
          && ts_strict_eq(((ts_object*)ts_ptr(x))->proto, proto);
      ts_gc_root(&x);
      ts_array_push(keep, x);
      ts_gc_unroot(1);
    }
    tsv first = ts_array_get(keep, 0);
    ts_gc_collect_young();
    /* two old cells: one holds a young prototype (the allocation's own
       barrier), the other a young property (the store's barrier) */
    tsv young_proto = ts_new_object(); ts_gc_root(&young_proto);
    tsv tenured = ts_new_sized_site(size, site, young_proto); ts_gc_root(&tenured);
    tsv holder = ts_new_sized_site(size, site, proto); ts_gc_root(&holder);
    ts_gc_unroot(3); ts_gc_root(&tenured); ts_gc_root(&holder);   /* the young prototype only through the old cell */
    tsv young_val = ts_new_string("kept by an old cell", 19);
    ts_gc_root(&young_val);
    ts_set(holder, (ts_key)(4242), young_val);
    ts_gc_unroot(1);
    tsv young_proto_h = ((ts_object*)ts_ptr(tenured))->proto;
    int old_alloc = ((ts_gc_header*)ts_ptr(tenured))->gen == TS_GEN_OLD
      && ((ts_gc_header*)ts_ptr(holder))->gen == TS_GEN_OLD;
    ts_gc_collect_young();
    tsv expect = ts_new_string("kept by an old cell", 19); ts_gc_root(&expect);
    int barrier_ok = ts_gc_debug_cell_live(young_proto_h)
      && ts_strict_eq(((ts_object*)ts_ptr(tenured))->proto, young_proto_h)
      && ts_strict_eq(ts_get(holder, (ts_key)(4242)), expect);
    ts_gc_unroot(1);
    for (int i = 0; i < 300; i++) (void)ts_new_sized_site(size, site, proto);   /* old garbage */
    ts_gc_collect();
    tsv after = ts_new_sized_site(size, site, proto);
    int reverted = ((ts_gc_header*)ts_ptr(after))->gen == TS_GEN_YOUNG;
    tsv other = ts_new_sized_site(size, site + 1u, proto);   /* an untouched site starts young */
    int other_young = ((ts_gc_header*)ts_ptr(other))->gen == TS_GEN_YOUNG;
    int kept_ok = ts_array_len(keep) == 200u && ts_gc_debug_cell_live(first);
    CK("site pretenuring: young first, tenured after a surviving window", young_first && old_alloc);
    CK("site pretenuring: an old cell keeps its young prototype and property", barrier_ok);
    CK("site pretenuring: a tenured site with dying old cells returns to young", reverted && other_young && kept_ok);
    ts_gc_unroot(4);
  }
  /* The class registry does not keep prototypes alive: a prototype that
     takes a dead registered prototype's cell answers with its own layout. */
  {
    typedef struct { ts_sized_head o; tsv a, b; } two_fields;
    typedef struct { ts_sized_head o; tsv x; } one_field;
    static ts_class_field f_two[2], f_one[1];
    f_two[0].name_id = 495001u; f_two[0].offset = offsetof(two_fields, a); f_two[0].numeric = 0;
    f_two[1].name_id = 495002u; f_two[1].offset = offsetof(two_fields, b); f_two[1].numeric = 0;
    f_one[0].name_id = 495011u; f_one[0].offset = offsetof(one_field, x); f_one[0].numeric = 0;
    tsv dead = ts_new_proto();
    uintptr_t dead_cell = (uintptr_t)ts_ptr(dead);
    ts_register_class(dead, f_two, 2);
    dead = TS_UNDEFINED;
    ts_gc_collect();
    tsv keep = ts_new_array(0); ts_gc_root(&keep);
    tsv reused = TS_UNDEFINED; ts_gc_root(&reused);
    for (int i = 0; i < 200000 && ts_is_undef(reused); i++){
      tsv p = ts_new_proto();
      if ((uintptr_t)ts_ptr(p) == dead_cell) reused = p;
      else { ts_gc_root(&p); ts_array_push(keep, p); ts_gc_unroot(1); }
    }
    int found = !ts_is_undef(reused), own_layout = 0;
    if (found){
      ts_register_class(reused, f_one, 1);
      tsv inst = ts_new_sized(sizeof(one_field)); ts_gc_root(&inst);
      ((ts_object*)ts_ptr(inst))->proto = reused;
      tsv val = ts_new_string("own layout", 10); ts_gc_root(&val);
      ts_set(inst, f_one[0].name_id, val);
      own_layout = ((one_field*)ts_ptr(inst))->x == val && obj_map((ts_object*)ts_ptr(inst))->len == 0u;
      ts_gc_unroot(2);
    }
    /* protect mode quarantines dead cells: no cell is reused, nothing to check */
    if (!found) printf("  (class registry: the dead prototype's cell was not reused)\n");
    CK("class registry: a prototype in a dead registered prototype's cell has its own layout", !found || own_layout);
    ts_gc_unroot(2);
  }
  /* The cell header's flags byte and a sized instance's extent
     (docs/cell_header_design.md): set at allocation, exact for layouts, kept
     across promotion, full collections, barriers and absent deletes; dictionary
     entries of an old sized instance are rescanned whole. */
  {
    const size_t w3 = sizeof(ts_sized_head) + 3u * sizeof(tsv);
    const size_t w300 = sizeof(ts_sized_head) + 300u * sizeof(tsv);
    tsv small = ts_new_sized(w3); ts_gc_root(&small);
    ts_object* so = (ts_object*)ts_ptr(small);
    int small_ok = ts_obj_is_sized(so) && so->h.inline_cap == 3u && so->h.hdr_spare == 0u
      && ts_obj_sized_bytes(so) == w3 && so->shape == TS_SHAPE_NONE;
    tsv header_only = ts_new_sized(sizeof(ts_sized_head)); ts_gc_root(&header_only);
    int header_only_ok = !ts_obj_is_sized((ts_object*)ts_ptr(header_only));
    /* the helper itself, as stack instances use it: no extent, no flag */
    struct { ts_sized_head o; tsv f[2]; } stack_cells[2];
    memset(stack_cells, 0, sizeof stack_cells);
    ts_hdr_init_sized(&stack_cells[0].o.h, sizeof(ts_sized_head));
    ts_hdr_init_sized(&stack_cells[1].o.h, sizeof(ts_sized_head) + 2u * sizeof(tsv));
    header_only_ok = header_only_ok && !ts_obj_is_sized((ts_object*)&stack_cells[0].o)
      && ts_obj_is_sized((ts_object*)&stack_cells[1].o) && stack_cells[1].o.h.inline_cap == 2u
      && (stack_cells[0].o.h.flags & TS_HDR_SIDECAR) && (stack_cells[1].o.h.flags & TS_HDR_SIDECAR);
    /* a 300-word layout: the extent's high byte is where a plain object keeps its cards */
    tsv big_proto = ts_new_proto(); ts_gc_root(&big_proto);
    static ts_class_field big_field;
    big_field.name_id = 491001u; big_field.offset = w300 - sizeof(tsv); big_field.numeric = 0;
    ts_register_class(big_proto, &big_field, 1);
    tsv big = ts_new_sized(w300); ts_gc_root(&big);
    ts_object* bo = (ts_object*)ts_ptr(big);
    bo->proto = big_proto;
    int big_ok = ts_obj_is_sized(bo) && bo->h.inline_cap == (300u & 255u) && bo->h.hdr_spare == 1u
      && ts_obj_sized_bytes(bo) == w300;
    for (uint32_t i = 0; i < 12u; i++) ts_set(big, (ts_key)(492000u + i), ts_num((double)i));
    ts_gc_collect_young();
    bo = (ts_object*)ts_ptr(big);
    int promoted = bo->h.gen == TS_GEN_OLD && ts_obj_is_sized(bo) && ts_obj_sized_bytes(bo) == w300;
    /* young values into the struct field and into dictionary entries past the
       first card, an absent delete, a slot barrier: the extent stays */
    tsv yv = ts_new_string("young field value", 17); ts_gc_root(&yv);
    ts_set(big, big_field.name_id, yv);
    ts_gc_unroot(1);
    for (uint32_t i = 8u; i < 12u; i++){
      tsv entry = ts_new_string("young entry", 11); ts_gc_root(&entry);
      ts_set(big, (ts_key)(492000u + i), entry);
      ts_gc_unroot(1);
    }
    tsv young_field = *(tsv*)((char*)ts_ptr(big) + big_field.offset);
    tsv young_entry = ts_get(big, (ts_key)492011u);
    int absent = ts_delete_prop(big, (ts_key)493000u);
    ts_gc_remember_slot(&((ts_object*)ts_ptr(big))->h, 2u);
    bo = (ts_object*)ts_ptr(big);
    int kept_before = bo->h.inline_cap == (300u & 255u) && bo->h.hdr_spare == 1u
      && (bo->h.flags & TS_HDR_REMEMBERED) != 0;
    ts_gc_collect_young();
    bo = (ts_object*)ts_ptr(big);
    int minor_ok = ts_obj_sized_bytes(bo) == w300 && (bo->h.flags & TS_HDR_REMEMBERED) == 0
      && ts_gc_debug_cell_live(young_field) && ts_gc_debug_cell_live(young_entry)
      && ts_strict_eq(ts_get(big, big_field.name_id), young_field);
    ts_gc_collect();
    bo = (ts_object*)ts_ptr(big);
    int full_ok = ts_obj_sized_bytes(bo) == w300 && ts_obj_is_sized(bo)
      && ts_strict_eq(ts_get(big, (ts_key)492011u), young_entry)
      && ts_to_num(ts_get(big, (ts_key)492003u)) == 3.0;
    CK("cell header: a sized instance's flag and extent", small_ok && big_ok && header_only_ok);
    CK("cell header: the extent survives promotion, barriers and an absent delete", promoted && absent && kept_before);
    CK("cell header: an old sized instance's young field and entries survive", minor_ok && full_ok);
    /* layouts one word apart that can share a size class: an instance relinked
       behind the larger layout's prototype has none of its extra field */
    int layouts_ok = 1;
    for (uint32_t w = 2u; w <= 4u; w++){
      tsv lo_proto = ts_new_proto(); ts_gc_root(&lo_proto);
      tsv hi_proto = ts_new_proto(); ts_gc_root(&hi_proto);
      ts_class_field* hi_fields = (ts_class_field*)calloc(w + 1u, sizeof(ts_class_field));
      for (uint32_t f = 0; f <= w; f++){
        hi_fields[f].name_id = 494000u + 10u * w + f;
        hi_fields[f].offset = sizeof(ts_sized_head) + f * sizeof(tsv);
      }
      ts_register_class(lo_proto, hi_fields, (int)w);        /* the first w fields */
      ts_register_class(hi_proto, hi_fields, (int)w + 1);    /* and one more */
      tsv lo = ts_new_sized(sizeof(ts_sized_head) + w * sizeof(tsv)); ts_gc_root(&lo);
      ((ts_object*)ts_ptr(lo))->proto = hi_proto;
      ts_key extra = hi_fields[w].name_id;
      tsv before = ts_get(lo, extra);
      ts_set(lo, extra, ts_num(7.5));
      tsv after = ts_get(lo, extra);
      int own = obj_map((ts_object*)ts_ptr(lo))->len == 1u;   /* a dictionary entry, not a field */
      if (!ts_is_undef(before) || ts_to_num(after) != 7.5 || !own) layouts_ok = 0;
      ts_gc_unroot(3);
    }
    CK("cell header: a layout is exact, not a size class", layouts_ok);
    CK("cell header: sizes the header cannot describe abort",
       sized_extent_aborts(sizeof(ts_sized_head) + 65536u * sizeof(tsv)) &&
       sized_extent_aborts(sizeof(ts_sized_head) + 4u) &&
       sized_extent_aborts(sizeof(ts_gc_header)) &&
       !sized_extent_aborts(sizeof(ts_sized_head) + 65535u * sizeof(tsv)));
    ts_gc_unroot(4);
  }
  CK("shared store: a forked child's store is seen", store_crosses_fork(1) == 42);
  CK("shared store: an ArrayBuffer's bytes stay the child's own", store_crosses_fork(0) == 0);
  CK("atomics: four processes claim every schedule index once", schedule_contention(4, 20000));
  {
    /* the element conversions of the atomic forms, one thread */
    tsv n8 = ts_num(4); tsv v8 = ts_new_typed_array(TS_TA_INT8, &n8, 1); ts_gc_root(&v8);
    tsv n16 = ts_num(4); tsv v16 = ts_new_typed_array(TS_TA_UINT16, &n16, 1); ts_gc_root(&v16);
    int ok = ts_to_num(ts_atomics_store(v8, ts_num(0), ts_num(200))) == 200 && ts_to_num(ts_atomics_load(v8, ts_num(0))) == -56;
    ok = ok && ts_to_num(ts_atomics_rmw(0, v8, ts_num(0), ts_num(100))) == -56 && ts_to_num(ts_atomics_load(v8, ts_num(0))) == 44;
    ok = ok && ts_to_num(ts_atomics_compare_exchange(v16, ts_num(1), ts_num(0), ts_num(70000))) == 0 && ts_to_num(ts_atomics_load(v16, ts_num(1))) == 70000 - 65536;
    ok = ok && ts_to_num(ts_atomics_compare_exchange(v16, ts_num(1), ts_num(1), ts_num(5))) == 70000 - 65536 && ts_to_num(ts_atomics_load(v16, ts_num(1))) == 70000 - 65536;
    ok = ok && ts_to_num(ts_atomics_rmw(5, v16, ts_num(1), ts_num(-1))) == 70000 - 65536 && ts_to_num(ts_atomics_load(v16, ts_num(1))) == 65535;
    ts_gc_unroot(2);
    CK("atomics: element conversions (Int8 wraps, Uint16 wraps, a failed exchange leaves the value)", ok);
  }
  {
    /* the codec: a plain graph with a cycle, an alias, a hole, a wide string, a typed array */
    tsv o = ts_new_object(); ts_gc_root(&o);
    tsv inner = ts_new_array(0); ts_gc_root(&inner);
    ts_array_push(inner, ts_num(1)); ts_array_push_hole(inner); ts_array_push(inner, ts_new_string("x", 1));
    tsv n3 = ts_num(3); tsv ta = ts_new_typed_array(TS_TA_INT32, &n3, 1); ts_gc_root(&ta);
    ts_ta_set(ta, 0, ts_num(-5)); ts_ta_set(ta, 2, ts_num(70000));
    ts_set(o, ts_intern_field("a", 1), ts_num(1.5));
    ts_set(o, ts_intern_field("b", 1), ts_new_string("h\xc3\xa9llo \xe6\x97\xa5\xe6\x9c\xac", 13));
    ts_set(o, ts_intern_field("c", 1), inner);
    ts_set(o, ts_intern_field("c2", 2), inner);
    ts_set(o, ts_intern_field("d", 1), ta);
    ts_set(o, ts_intern_field("self", 4), o);
    ts_set(o, ts_intern_field("t", 1), ts_bool(1));
    ts_set(o, ts_intern_field("u", 1), TS_UNDEFINED);
    ts_set(o, ts_intern_field("z", 1), TS_NULL);
    tsv r = ts_message_roundtrip(o); ts_gc_root(&r);
    tsv rc = ts_get(r, ts_intern_field("c", 1));
    tsv rd = ts_get(r, ts_intern_field("d", 1));
    tsv rb = ts_get(r, ts_intern_field("b", 1));
    CK("worker codec: a copy, with the number", r != o && ts_is_obj(r) && ts_to_num(ts_get(r, ts_intern_field("a", 1))) == 1.5);
    CK("worker codec: a wide string's code units", ts_is_str(rb) && ts_str_len_typed(rb) == 8 && ts_str_charcodeat(rb, 1) == 0xe9 && ts_str_charcodeat(rb, 6) == 0x65e5);
    CK("worker codec: an array with a hole", ts_is_indexed_array_fast(rc) && ts_array_len(rc) == 3 && ts_to_num(ts_array_get(rc, 0)) == 1 && ts_is_undef(ts_array_get(rc, 1)));
    CK("worker codec: an alias is one array, a cycle closes on the copy", ts_get(r, ts_intern_field("c2", 2)) == rc && ts_get(r, ts_intern_field("self", 4)) == r);
    CK("worker codec: an Int32Array's elements", ts_is_typed_array(rd) && ts_to_num(ts_ta_get(rd, 0)) == -5 && ts_to_num(ts_ta_get(rd, 2)) == 70000);
    CK("worker codec: true, undefined and null", ts_truthy(ts_get(r, ts_intern_field("t", 1))) && ts_is_undef(ts_get(r, ts_intern_field("u", 1))) && ts_is_null(ts_get(r, ts_intern_field("z", 1))));
    tsv fnv = ts_make_fn_t(test_worker_entry, NULL, 0, 0); ts_gc_root(&fnv);
    tsv mapv = ts_new_map(); ts_gc_root(&mapv);
    tsv withfn = ts_new_object(); ts_gc_root(&withfn); ts_set(withfn, ts_intern_field("f", 1), fnv);
    CK("worker codec: a function, a Map and an object holding a function are rejected loudly",
       codec_rejects(fnv) && codec_rejects(mapv) && codec_rejects(withfn) && !codec_rejects(ts_num(1)));
    ts_gc_unroot(7);
  }
  {
    /* a forked worker: the entry sees its data, posts two frames, the loop delivers them */
    tsv entry = ts_make_fn_t(test_worker_entry, NULL, 0, 0); ts_gc_root(&entry);
    ts_worker_set_entry(entry);
    tsv data = ts_new_object(); ts_gc_root(&data);
    ts_set(data, ts_intern_field("n", 1), ts_num(21));
    ts_set(data, ts_intern_field("s", 1), ts_new_string("from the parent", 15));
    ts_gc_root(&worker_received);
    int id = ts_worker_fork(data);
    tsv onm = ts_make_fn_t(test_worker_on_message, NULL, 0, 0); ts_gc_root(&onm);
    tsv one = ts_make_fn_t(test_worker_on_error, NULL, 0, 0); ts_gc_root(&one);
    ts_worker_on_message(id, onm); ts_worker_on_error(id, one);
    ts_run_event_loop();
    tsv got_s = ts_is_obj(worker_received) ? ts_get(worker_received, ts_intern_field("s", 1)) : TS_UNDEFINED;
    int ok = ts_is_obj(worker_received) && ts_to_num(ts_get(worker_received, ts_intern_field("n", 1))) == 42
      && ts_is_str(got_s) && ts_str_len_typed(got_s) == 15 && ts_to_num(ts_get(worker_received, ts_intern_field("second", 6))) == 7 && worker_errors == 0;
    CK("worker by fork: the child's two frames arrive in order, no error", ok);
    /* a child whose entry throws: exit status 1, the error handler, no message */
    worker_received = TS_UNDEFINED;
    tsv bad = ts_make_fn_t(test_worker_throws, NULL, 0, 0); ts_gc_root(&bad);
    ts_worker_set_entry(bad);
    fflush(stdout); fflush(stderr);
    int saved = dup(2); int devnull = open("/dev/null", 1); dup2(devnull, 2);   /* the child's report goes to stderr */
    int id2 = ts_worker_fork(data);
    ts_worker_on_message(id2, onm); ts_worker_on_error(id2, one);
    ts_run_event_loop();
    dup2(saved, 2); close(saved); close(devnull);
    CK("worker by fork: an uncaught exception in the child reaches the error handler", worker_errors == 1 && ts_is_undef(worker_received));
    ts_gc_unroot(6);
  }
  {
    /* a shared worker: the published graph arrives by reference, readable and immutable in the parent */
    ts_gc_root(&shared_prefork); ts_gc_root(&shared_got_wrap); ts_gc_root(&shared_got_root);
    shared_prefork = ts_new_object();
    ts_set(shared_prefork, ts_intern_field("tag", 3), ts_new_string("pre-fork", 8));
    /* the names the child uses exist here; the parent's own {a, b} order */
    tsv ab = ts_new_object(); ts_gc_root(&ab);
    ts_set(ab, ts_intern_field("a", 1), ts_num(0)); ts_set(ab, ts_intern_field("b", 1), ts_num(0));
    ts_intern_field("deep", 4); ts_intern_field("arr", 3); ts_intern_field("m", 1); ts_intern_field("text", 4);
    ts_intern_field("pre", 3); ts_intern_field("ord", 3); ts_intern_field("fn", 2); ts_intern_field("batch", 5); ts_intern_field("k", 1);
    ts_intern_field("inh", 3); ts_intern_field("own", 3); ts_intern_field("child", 5);
    tsv entry = ts_make_fn_t(test_shared_entry, NULL, 0, 0); ts_gc_root(&entry);
    ts_worker_set_entry(entry);
    tsv data = ts_new_object(); ts_gc_root(&data);
    ts_set(data, ts_intern_field("pre", 3), shared_prefork);
    tsv onm = ts_make_fn_t(test_shared_on_message, NULL, 0, 0); ts_gc_root(&onm);
    tsv one = ts_make_fn_t(test_worker_on_error, NULL, 0, 0); ts_gc_root(&one);
    worker_errors = 0; shared_frames = 0;
    int id = ts_worker_fork_shared(data);
    ts_worker_on_message(id, onm); ts_worker_on_error(id, one);
    ts_run_event_loop();
    int two = shared_frames == 2 && worker_errors == 0 && ts_is_obj(shared_got_wrap) && ts_is_obj(shared_got_root);
    CK("shared worker: two frames, no error", two);
    tsv batch = two ? ts_get(shared_got_wrap, ts_intern_field("batch", 5)) : TS_UNDEFINED;
    CK("shared worker: the wrapped graph and the bare one are the same cell", two && batch == shared_got_root);
    if (two){
      tsv arr = ts_get(batch, ts_intern_field("arr", 3));
      tsv inner = ts_array_get(arr, 2);
      tsv m = ts_get(batch, ts_intern_field("m", 1));
      tsv text = ts_get(batch, ts_intern_field("text", 4));
      tsv ord = ts_get(batch, ts_intern_field("ord", 3));
      tsv fn = ts_get(batch, ts_intern_field("fn", 2));
      CK("shared worker: the array, its nested object and the string read in place",
         ts_array_len(arr) == 3 && ts_to_num(ts_get(inner, ts_intern_field("deep", 4))) == 5 && ts_is_str(text) && ts_str_len_typed(text) == 11);
      CK("shared worker: the Map reads in place", ts_is_map(m) && ts_to_num(ts_map_get(m, ts_new_string("k", 1))) == 9);
      CK("shared worker: a shape the parent never made reads its keys",
         ts_to_num(ts_get(ord, ts_intern_field("a", 1))) == 1 && ts_to_num(ts_get(ord, ts_intern_field("b", 1))) == 2);
      CK("shared worker: a function cell arrives by reference", ts_is_func(fn));
      tsv child = ts_get(batch, ts_intern_field("child", 5));
      CK("shared worker: a prototype the worker made is kept through its collections; the object reads its inherited property",
         ts_is_published(child) && ts_to_num(ts_get(child, ts_intern_field("own", 3))) == 1 && ts_to_num(ts_get(child, ts_intern_field("inh", 3))) == 7);
      CK("shared worker: the pre-fork cell the graph reached is the parent's own, frozen here",
         ts_get(batch, ts_intern_field("pre", 3)) == shared_prefork && ts_truthy(ts_object_is_frozen(shared_prefork)) && ts_is_published(shared_prefork));
      CK("shared worker: the graph is published and immutable in the parent",
         ts_is_published(batch) && ts_is_published(inner) && write_throws(batch, ts_intern_field("text", 4), ts_num(1)) && write_throws(inner, ts_intern_field("deep", 4), ts_num(1)) && map_set_throws(m));
      /* the parent's collections afterwards leave the region readable */
      for (int i = 0; i < 2000; i++){ tsv junk = ts_new_array(0); ts_array_push(junk, ts_num(i)); }
      ts_gc_collect_young(); ts_gc_collect(); ts_gc_collect_young();
      CK("shared worker: the graph survives the parent's young and full collections",
         ts_to_num(ts_get(ts_array_get(ts_get(batch, ts_intern_field("arr", 3)), 2), ts_intern_field("deep", 4))) == 5 &&
         ts_to_num(ts_get(ts_get(batch, ts_intern_field("ord", 3)), ts_intern_field("a", 1))) == 1 &&
         ts_str_len_typed(ts_get(shared_prefork, ts_intern_field("tag", 3))) == 8);
    }
    /* a worker past its region, and one interning a new name: loud deaths, the error handler */
    fflush(stdout); fflush(stderr);
    int saved = dup(2); int devnull = open("/dev/null", 1); dup2(devnull, 2);
    setenv("TSAOT_SHARED_REGION_MB", "1", 1);
    tsv over = ts_make_fn_t(test_shared_overflow_entry, NULL, 0, 0); ts_gc_root(&over);
    ts_worker_set_entry(over); worker_errors = 0;
    int id2 = ts_worker_fork_shared(data);
    ts_worker_on_message(id2, onm); ts_worker_on_error(id2, one);
    ts_run_event_loop();
    unsetenv("TSAOT_SHARED_REGION_MB");
    int overflow_loud = worker_errors == 1;
    tsv intern = ts_make_fn_t(test_shared_intern_entry, NULL, 0, 0); ts_gc_root(&intern);
    ts_worker_set_entry(intern); worker_errors = 0;
    int id3 = ts_worker_fork_shared(data);
    ts_worker_on_message(id3, onm); ts_worker_on_error(id3, one);
    ts_run_event_loop();
    dup2(saved, 2); close(saved); close(devnull);
    CK("shared worker: a region exhausted is a loud death", overflow_loud);
    CK("shared worker: a new property name interned is a loud death", worker_errors == 1);
    ts_gc_unroot(10);
  }
  {
    /* a shared worker's big Map, Set and wide object, with young collections before and after publish */
    ts_gc_root(&shared_big_got);
    /* a large text (a source file's size class): 3000 distinct 7-character tokens */
    char* big = (char*)malloc(3000 * 7 + 1);
    for (int i = 0; i < 3000; i++) snprintf(big + i * 7, 8, "k%06d", i);
    tsv longtext = ts_new_string(big, 3000 * 7); ts_gc_root(&longtext); free(big);
    for (int i = 0; i < 40; i++){ char nm[16]; snprintf(nm, sizeof nm, "p%d", i); ts_intern_field(nm, (uint32_t)strlen(nm)); }
    ts_intern_field("text", 4); ts_intern_field("o", 1);
    tsv entry = ts_make_fn_t(test_shared_big_entry, NULL, 0, 0); ts_gc_root(&entry);
    ts_worker_set_entry(entry);
    tsv data = ts_new_object(); ts_gc_root(&data);
    ts_set(data, ts_intern_field("text", 4), longtext);
    tsv onm = ts_make_fn_t(test_shared_big_on_message, NULL, 0, 0); ts_gc_root(&onm);
    tsv one = ts_make_fn_t(test_worker_on_error, NULL, 0, 0); ts_gc_root(&one);
    worker_errors = 0;
    int id = ts_worker_fork_shared(data);
    ts_worker_on_message(id, onm); ts_worker_on_error(id, one);
    ts_run_event_loop();
    int ok = worker_errors == 0 && ts_is_obj(shared_big_got);
    int map_miss = 0, map_wrong = 0, set_miss = 0, obj_wrong = 0, tomb_present = 0;
    if (ok){
      tsv m = ts_get(shared_big_got, ts_intern_field("m", 1)), st = ts_get(shared_big_got, ts_intern_field("s", 1)), o = ts_get(shared_big_got, ts_intern_field("o", 1));
      for (int i = 0; i < 3000; i++){
        tsv k;
        if (i % 3 == 2){ char tok[8]; snprintf(tok, sizeof tok, "k%06d", i); k = ts_new_string(tok, 7); } else k = shared_key(i, longtext);
        ts_gc_root(&k);
        tsv v = ts_map_get(m, k);
        if (i % 5 == 0){ if (!ts_is_undef(v)) tomb_present++; }
        else if (ts_is_undef(v)) map_miss++;
        else if (ts_to_num(v) != (double)i) map_wrong++;
        if (i % 7 && !ts_set_has(st, k)) set_miss++;
        ts_gc_unroot(1);
      }
      { tsv ks = ts_object_keys(o); if (ts_array_len(ks) != 40) obj_wrong += 1000; }   /* the key count in the parent's view */
      for (int i = 0; i < 40; i++){ char nm[16]; snprintf(nm, sizeof nm, "p%d", i); tsv v = ts_get(o, ts_intern_field(nm, (uint32_t)strlen(nm))); if (ts_to_num(v) != (double)i * 3) obj_wrong++; }
    }
    if (map_miss || map_wrong || set_miss || obj_wrong || tomb_present)
      printf("    (map misses %d, wrong %d, set misses %d, object wrong %d, deleted present %d)\n", map_miss, map_wrong, set_miss, obj_wrong, tomb_present);
    CK("shared worker: a 3000-key Map, a Set and a 40-property object read correctly after the worker's collections",
       ok && !map_miss && !map_wrong && !set_miss && !obj_wrong && !tomb_present);
    /* iterating the published collections: the identity order, nothing stored into the shared cells;
       another process (a plain child, as a checker is) iterating first changes nothing here */
    int iter_bad = 0;
    if (ok){
      tsv m = ts_get(shared_big_got, ts_intern_field("m", 1)), st = ts_get(shared_big_got, ts_intern_field("s", 1));
      fflush(stdout);
      pid_t child = fork();
      if (child == 0){ shared_iter_count(m); shared_iter_count(st); shared_iter_keys_count(m); _exit(0); }
      int status = 0; if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status) != 0) iter_bad |= 32;
      for (int round = 0; round < 2; round++){
        if (shared_iter_count(m) != 2400) iter_bad |= 1;
        if (shared_iter_count(st) != 2571) iter_bad |= 2;
        if (shared_iter_check_map(m) != 0) iter_bad |= 4;
        if (shared_iter_keys_count(m) != 2400) iter_bad |= 8;
      }
      if (((ts_map*)ts_ptr(m))->iteration_order || ((ts_set_t*)ts_ptr(st))->iteration_order) iter_bad |= 16;
    }
    if (iter_bad) printf("    (iteration flags %d)\n", iter_bad);
    CK("shared worker: the published Map and Set iterate in the identity order with nothing stored in the shared cells, after another process iterated them", ok && !iter_bad);
    ts_gc_unroot(6);
  }
  {
    /* frames from the parent: three numbers and a stop; the doubled replies arrive in order */
    echo_received = ts_new_array(0); ts_gc_root(&echo_received);
    tsv entry = ts_make_fn_t(test_echo_entry, NULL, 0, 0); ts_gc_root(&entry);
    ts_worker_set_entry(entry);
    tsv onm = ts_make_fn_t(test_echo_on_message, NULL, 0, 0); ts_gc_root(&onm);
    tsv one = ts_make_fn_t(test_worker_on_error, NULL, 0, 0); ts_gc_root(&one);
    worker_errors = 0;
    int id = ts_worker_fork(TS_UNDEFINED);
    ts_worker_on_message(id, onm); ts_worker_on_error(id, one);
    ts_worker_send(id, ts_num(1)); ts_worker_send(id, ts_num(2)); ts_worker_send(id, ts_num(3));
    tsv stop = ts_new_object(); ts_gc_root(&stop); ts_set(stop, ts_intern_field("stop", 4), ts_bool(1));
    ts_worker_send(id, stop);
    ts_run_event_loop();
    CK("frames to a worker: the replies arrive in order and the worker ends on stop",
       worker_errors == 0 && ts_array_len(echo_received) == 3 && ts_to_num(ts_array_get(echo_received, 0)) == 2 &&
       ts_to_num(ts_array_get(echo_received, 1)) == 4 && ts_to_num(ts_array_get(echo_received, 2)) == 6);
    CK("frames to a worker: posting to an exited worker throws", send_throws(id));
    ts_gc_unroot(5);
  }
  test_conservative_roots();
  test_shape_chains();
  CK("shape chain: every key of a 600-key object reads back", g_sc_results[0]);
  CK("shape chain: a branch reads its own keys", g_sc_results[1]);
  CK("shape chain: a branch lacks the chain's later keys", g_sc_results[2]);
  CK("shape chain: the chain lacks the branch's key", g_sc_results[3]);
  CK("shape chain: a prefix object lacks the keys added beyond its depth", g_sc_results[4]);
  CK("shape chain: a prefix object continuing the chain joins it", g_sc_results[5]);
  CK("conservative roots: the unrooted locals keep their allocation bits", g_cr_results[0]);
  CK("conservative roots: the unrooted array and object survive two collections", g_cr_results[1]);
  CK("conservative roots: the cells nothing names lose their allocation bits", g_cr_results[2]);
  CK("conservative roots: the survivors are intact after the second round", g_cr_results[3]);
  {
    /* a Map keyed by small integers: the direct index, its growth, deletes past
       the compaction threshold, a key that makes it give way, the semantics
       that must not change */
    tsv m = ts_new_map(); ts_gc_root(&m);
    for (int i = 0; i < 5000; i++) ts_map_set(m, ts_num((double)(i * 2)), ts_num((double)i));
    int hits = 0, wrong = 0;
    for (int i = 0; i < 10000; i++){ tsv v = ts_map_get(m, ts_num((double)i)); if (!ts_is_undef(v)){ hits++; if (ts_to_num(v) != (double)(i / 2) || (i & 1)) wrong++; } }
    ts_map* mp = (ts_map*)ts_ptr(m);
    CK("map direct: 5000 even keys found and the odd ones absent, through the direct table", hits == 5000 && !wrong && mp->direct != NULL && mp->index == NULL);
    CK("map direct: -0 finds +0; a fraction, NaN and a negative are absent",
       ts_to_num(ts_map_get(m, ts_num(-0.0))) == 0 && ts_is_undef(ts_map_get(m, ts_num(1.5))) && ts_is_undef(ts_map_get(m, ts_num(0.0 / 0.0))) && !ts_map_has(m, ts_num(-2)));
    for (int i = 0; i < 5000; i++) if (i % 3) ts_map_delete(m, ts_num((double)(i * 2)));
    int live = 0; for (int i = 0; i < 10000; i++) if (ts_map_has(m, ts_num((double)i))) live++;
    CK("map direct: deletes past the compaction threshold keep the rest", live == 1667 && (int)ts_map_size(m) == 1667 && ts_to_num(ts_map_get(m, ts_num(6))) == 3 && ts_is_undef(ts_map_get(m, ts_num(8))));
    ts_map_set(m, ts_new_string("name", 4), ts_num(-1));   /* a string key: the hash index takes over */
    mp = (ts_map*)ts_ptr(m);
    CK("map direct: a string key moves the map to the hash index with every entry",
       mp->direct == NULL && mp->index != NULL && ts_to_num(ts_map_get(m, ts_new_string("name", 4))) == -1 && ts_to_num(ts_map_get(m, ts_num(6))) == 3 && (int)ts_map_size(m) == 1668);
    tsv sp = ts_new_map(); ts_gc_root(&sp);
    for (int i = 0; i < 64; i++) ts_map_set(sp, ts_num((double)i * 100003.0), ts_num((double)i));
    CK("map direct: sparse keys stay hashed", ((ts_map*)ts_ptr(sp))->direct == NULL && ts_to_num(ts_map_get(sp, ts_num(63 * 100003.0))) == 63);
    tsv g = ts_new_map(); ts_gc_root(&g);
    for (int i = 0; i < 1000; i++) ts_map_set(g, ts_num((double)i), ts_bool(1));
    ts_map_set(g, ts_num(3000), ts_bool(1));   /* within the density rule: the table grows */
    int grew = ((ts_map*)ts_ptr(g))->direct != NULL && ((ts_map*)ts_ptr(g))->direct_cap >= 3001u;
    ts_map_set(g, ts_num(50000), ts_bool(1));  /* past it: hashed */
    CK("map direct: a far key within the density rule grows the table, one past it gives it up",
       grew && ((ts_map*)ts_ptr(g))->direct == NULL && ts_truthy(ts_map_get(g, ts_num(3000))) && ts_truthy(ts_map_get(g, ts_num(50000))) && ts_truthy(ts_map_get(g, ts_num(999))) && ts_is_undef(ts_map_get(g, ts_num(2999))));
    ts_map_clear(m); ts_map_set(m, ts_num(7), ts_num(1));
    CK("map direct: clear then reuse", (int)ts_map_size(m) == 1 && ts_to_num(ts_map_get(m, ts_num(7))) == 1 && ts_is_undef(ts_map_get(m, ts_num(6))));
    ts_gc_unroot(3);
  }
  printf("\n%s\n", fail==0?"ALL RUNTIME TESTS PASS":"FAILURES");
  return fail?1:0;
}
