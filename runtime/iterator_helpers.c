/* %IteratorPrototype%, the Iterator global and the iterator helpers (ES2025). Included at the end of ts_rt.c.

   A helper is a plain object of %IteratorHelperPrototype% with its state under hidden keys, so the collector
   sees it like any object: the underlying iterator and its `next`, the function, the count, and, for flatMap,
   the inner iterator. */

static tsv g_iterator_proto = TS_NULL, g_iterator_ctor = TS_UNDEFINED, g_iter_helper_proto = TS_NULL, g_wrap_iter_proto = TS_NULL;

static ts_key ih_key(const char* name){ return ts_intern_field(name, (uint32_t)strlen(name)); }
#define IH_KEY(var, text) static ts_key var; if (!var) var = ih_key(text)

static int ih_object(tsv v){ return ts_object_like(v) && !ts_is_prim_cell(v); }

/* IteratorClose for a normal completion: `return`, whose result must be an object */
static void ih_close(tsv it){
  IH_KEY(k, "return");
  ts_gc_root(&it);
  tsv ret = ts_get(it, k);
  if (!ts_is_undef(ret) && !ts_is_null(ret)){
    if (!ts_is_callable(ret)) ts_throw_type_error_msg("The iterator's return is not a function");
    tsv r = ts_call_method(ret, &it, 1);
    if (!ih_object(r)) ts_throw_type_error_msg("The iterator's return did not give an object");
  }
  ts_gc_unroot(1);
}
/* a method call that gives back what it throws */
static tsv ih_method_catching(tsv fn, tsv recv, int* threw){
  ts_handler* h = ts_eh_push();
  if (ts_setjmp(h->buf) != 0){
    ts_gc_set_root_depth(h->gc_root_len);
    ts_frame_restore(h->frame_top);
    ts_eh_pop();
    *threw = 1;
    return ts_current_exception();
  }
  tsv r = ts_call_method(fn, &recv, 1);
  ts_eh_pop();
  *threw = 0;
  return r;
}
/* for a throw completion: what the close does is dropped */
static void ih_close_quietly(tsv it){
  IH_KEY(k, "return");
  int threw = 0;
  ts_gc_root(&it);
  tsv ret = ts_get_catching(it, k, &threw);
  if (!threw && ts_is_callable(ret)) (void)ih_method_catching(ret, it, &threw);
  ts_gc_unroot(1);
}
/* a call of a user function; if it throws the iterator is closed and the throw goes on */
static tsv ih_call_closing(tsv it, tsv fn, tsv* args, int n){
  int threw = 0;
  ts_gc_root(&it);
  tsv r = ts_call_catching(fn, args, n, &threw);
  if (threw){ ts_gc_root(&r); ih_close_quietly(it); ts_gc_unroot(2); ts_throw(r); }
  ts_gc_unroot(1);
  return r;
}
/* IteratorStep: 1 and the value, or 0 when done */
static int ih_step(tsv it, tsv next, tsv* value){
  IH_KEY(kd, "done"); IH_KEY(kv, "value");
  tsv r = ts_call_method(next, &it, 1);
  if (!ih_object(r)) ts_throw_type_error_msg("The iterator's next did not give an object");
  ts_gc_root(&r);
  int done = ts_truthy(ts_get(r, kd));
  if (!done) *value = ts_get(r, kv);
  ts_gc_unroot(1);
  return !done;
}
/* GetIteratorFlattenable: an object, or (for Iterator.from) a string; its @@iterator, or itself */
static tsv ih_flattenable(tsv v, int strings){
  if (!ih_object(v) && !(strings && ts_is_str(v))) ts_throw_type_error_msg("Iterator.flatMap or Iterator.from needs an object");
  ts_gc_root(&v);
  tsv m = ts_get(v, TS_KEY_WKSYM(TS_WKSYM_ITERATOR));
  tsv it = v;
  if (!ts_is_undef(m) && !ts_is_null(m)) it = ts_call_method(m, &v, 1);
  if (!ih_object(it)) ts_throw_type_error_msg("The value's iterator is not an object");
  ts_gc_unroot(1);
  return it;
}
static tsv ih_this(tsv* a, int n){
  tsv v = n > 0 ? a[0] : TS_UNDEFINED;
  if (!ih_object(v)) ts_throw_type_error_msg("An Iterator.prototype method called on something that is not an object");
  return v;
}
static tsv ih_next_of(tsv it){ IH_KEY(k, "next"); return ts_get(it, k); }

/* ---- the lazy helpers ---- */
enum { IH_MAP, IH_FILTER, IH_TAKE, IH_DROP, IH_FLATMAP };
static tsv ih_new(int kind, tsv it, tsv fn, double count){
  IH_KEY(ki, "__ih_it"); IH_KEY(kn, "__ih_next"); IH_KEY(kf, "__ih_fn"); IH_KEY(kc, "__ih_count"); IH_KEY(kk, "__ih_kind"); IH_KEY(ks, "__ih_state");
  ts_gc_root(&it); ts_gc_root(&fn);
  tsv next = ih_next_of(it); ts_gc_root(&next);
  tsv o = ts_new_object(); ts_gc_root(&o);
  obj_link_fresh_proto(o, g_iter_helper_proto);
  ts_set(o, ki, it); ts_set(o, kn, next); ts_set(o, kf, fn);
  ts_set(o, kc, ts_num(count)); ts_set(o, kk, ts_num((double)kind)); ts_set(o, ks, ts_num(0.0));
  ts_gc_unroot(4);
  return o;
}
enum { IHS_START, IHS_SUSPENDED, IHS_RUNNING, IHS_DONE };
static tsv ih_finish(tsv self){ IH_KEY(ks, "__ih_state"); ts_set(self, ks, ts_num((double)IHS_DONE)); return ts_iter_result_new(TS_UNDEFINED, 1); }
/* one step of the helper; on a throw it stays finished */
static tsv ih_helper_step(tsv self){
  IH_KEY(ki, "__ih_it"); IH_KEY(kn, "__ih_next"); IH_KEY(kf, "__ih_fn"); IH_KEY(kc, "__ih_count"); IH_KEY(kk, "__ih_kind"); IH_KEY(kin, "__ih_inner"); IH_KEY(kinn, "__ih_inner_next");
  ts_gc_root(&self);
  tsv it = ts_get(self, ki), next = ts_get(self, kn), fn = ts_get(self, kf);
  ts_gc_root(&it); ts_gc_root(&next); ts_gc_root(&fn);
  int kind = (int)ts_to_num(ts_get(self, kk));
  double count = ts_to_num(ts_get(self, kc));
  tsv v = TS_UNDEFINED; ts_gc_root(&v);
  tsv out = TS_UNDEFINED; ts_gc_root(&out);
  int have = 0;
  switch (kind){
    case IH_MAP:
      if (ih_step(it, next, &v)){
        tsv av[2] = { v, ts_num(count) };
        out = ih_call_closing(it, fn, av, 2); have = 1;
        ts_set(self, kc, ts_num(count + 1));
      }
      break;
    case IH_FILTER:
      while (ih_step(it, next, &v)){
        tsv av[2] = { v, ts_num(count) };
        tsv keep = ih_call_closing(it, fn, av, 2);
        count += 1;
        if (ts_truthy(keep)){ out = v; have = 1; break; }
      }
      ts_set(self, kc, ts_num(count));
      break;
    case IH_TAKE:
      if (count <= 0){ ih_close(it); break; }
      ts_set(self, kc, ts_num(count - 1));
      if (ih_step(it, next, &v)){ out = v; have = 1; }
      break;
    case IH_DROP:
      while (count > 0){
        if (!ih_step(it, next, &v)) break;
        count -= 1;
      }
      ts_set(self, kc, ts_num(count));
      if (count <= 0 && ih_step(it, next, &v)){ out = v; have = 1; }
      break;
    default: {  /* flatMap: the inner iterator first, the outer when it ends */
      for (;;){
        tsv inner = ts_get(self, kin);
        if (!ts_is_undef(inner)){
          tsv inext = ts_get(self, kinn);
          ts_gc_root(&inner); ts_gc_root(&inext);
          int threw = 0;
          tsv iv = TS_UNDEFINED;
          IH_KEY(kd, "done"); IH_KEY(kv, "value");
          tsv ir = ih_method_catching(inext, inner, &threw);
          if (!threw && !ih_object(ir)){ threw = 1; ir = ts_new_error(TS_ERR_TYPE, ts_new_string("The iterator's next did not give an object", 42)); }
          int done = 0;
          if (!threw){
            ts_gc_root(&ir);
            tsv d = ts_get_catching(ir, kd, &threw);
            if (threw) ir = d;
            else {
              done = ts_truthy(d);
              if (!done){ iv = ts_get_catching(ir, kv, &threw); if (threw) ir = iv; }
            }
            ts_gc_unroot(1);
          }
          ts_gc_unroot(2);
          if (threw){ ts_gc_root(&ir); ih_close_quietly(it); ts_gc_unroot(1); ts_throw(ir); }
          if (!done){ out = iv; have = 1; break; }
          ts_set(self, kin, TS_UNDEFINED);
        }
        if (!ih_step(it, next, &v)) break;
        tsv av[2] = { v, ts_num(count) };
        tsv mapped = ih_call_closing(it, fn, av, 2);
        count += 1;
        ts_set(self, kc, ts_num(count));
        ts_gc_root(&mapped);
        int threw = 0;
        /* a throw while getting the inner iterator closes the outer one */
        ts_handler* h = ts_eh_push();
        tsv in;
        if (ts_setjmp(h->buf) != 0){
          ts_gc_set_root_depth(h->gc_root_len);
          ts_frame_restore(h->frame_top);
          ts_eh_pop();
          threw = 1;
          in = ts_current_exception();
        } else {
          in = ih_flattenable(mapped, 0);
          ts_eh_pop();
        }
        if (threw){ ts_gc_root(&in); ih_close_quietly(it); ts_gc_unroot(1); ts_throw(in); }
        ts_gc_unroot(1);
        ts_gc_root(&in);
        tsv in_next = ih_next_of(in);
        ts_set(self, kin, in); ts_set(self, kinn, in_next);
        ts_gc_unroot(1);
      }
    }
  }
  ts_gc_unroot(6);
  return have ? ts_iter_result_new(out, 0) : ih_finish(self);
}
static tsv ih_helper_this(tsv* a, int n, const char* what){
  IH_KEY(kk, "__ih_kind");
  tsv v = n > 0 ? a[0] : TS_UNDEFINED;
  if (!ih_object(v) || !ts_is_num(ts_get(v, kk))){
    char m[96];
    snprintf(m, sizeof m, "Iterator Helper.prototype.%s called on incompatible receiver", what);
    ts_throw_type_error_msg(m);
  }
  return v;
}
static tsv ih_helper_next(tsv* a, int n){
  IH_KEY(ks, "__ih_state");
  tsv self = ih_helper_this(a, n, "next");
  int state = (int)ts_to_num(ts_get(self, ks));
  if (state == IHS_RUNNING) ts_throw_type_error_msg("Generator is already running");
  if (state == IHS_DONE) return ts_iter_result_new(TS_UNDEFINED, 1);
  ts_gc_root(&self);
  ts_set(self, ks, ts_num((double)IHS_RUNNING));
  int threw = 0;
  ts_handler* h = ts_eh_push();
  tsv r;
  if (ts_setjmp(h->buf) != 0){
    ts_gc_set_root_depth(h->gc_root_len);
    ts_frame_restore(h->frame_top);
    ts_eh_pop();
    threw = 1;
    r = ts_current_exception();
  } else {
    r = ih_helper_step(self);
    ts_eh_pop();
  }
  ts_gc_root(&r);
  int after = (int)ts_to_num(ts_get(self, ks));
  if (threw) ts_set(self, ks, ts_num((double)IHS_DONE));
  else if (after == IHS_RUNNING) ts_set(self, ks, ts_num((double)IHS_SUSPENDED));
  ts_gc_unroot(2);
  if (threw) ts_throw(r);
  return r;
}
static tsv ih_helper_return(tsv* a, int n){
  IH_KEY(ks, "__ih_state"); IH_KEY(ki, "__ih_it"); IH_KEY(kin, "__ih_inner");
  tsv self = ih_helper_this(a, n, "return");
  int state = (int)ts_to_num(ts_get(self, ks));
  if (state == IHS_RUNNING) ts_throw_type_error_msg("Generator is already running");
  if (state == IHS_DONE) return ts_iter_result_new(TS_UNDEFINED, 1);
  ts_gc_root(&self);
  ts_set(self, ks, ts_num((double)IHS_DONE));
  tsv inner = ts_get(self, kin);
  if (!ts_is_undef(inner)){
    int threw = 0;
    ts_gc_root(&inner);
    ts_handler* h = ts_eh_push();
    tsv ex = TS_UNDEFINED;
    if (ts_setjmp(h->buf) != 0){
      ts_gc_set_root_depth(h->gc_root_len);
      ts_frame_restore(h->frame_top);
      ts_eh_pop();
      threw = 1;
      ex = ts_current_exception();
    } else {
      ih_close(inner);
      ts_eh_pop();
    }
    ts_gc_unroot(1);
    if (threw){ ts_gc_root(&ex); ih_close_quietly(ts_get(self, ki)); ts_gc_unroot(2); ts_throw(ex); }
  }
  ih_close(ts_get(self, ki));
  ts_gc_unroot(1);
  return ts_iter_result_new(TS_UNDEFINED, 1);
}
/* The function argument of a helper: not callable closes the iterator (ES2025 as amended) */
static tsv ih_callable_arg(tsv self, tsv* a, int n, const char* what){
  tsv fn = n > 1 ? a[1] : TS_UNDEFINED;
  if (!ts_is_callable(fn)){
    ih_close_quietly(self);
    char m[96];
    snprintf(m, sizeof m, "Iterator.prototype.%s: the argument is not a function", what);
    ts_throw_type_error_msg(m);
  }
  return fn;
}
static tsv ip_map(tsv* a, int n){ tsv s = ih_this(a, n); return ih_new(IH_MAP, s, ih_callable_arg(s, a, n, "map"), 0); }
static tsv ip_filter(tsv* a, int n){ tsv s = ih_this(a, n); return ih_new(IH_FILTER, s, ih_callable_arg(s, a, n, "filter"), 0); }
static tsv ip_flat_map(tsv* a, int n){ tsv s = ih_this(a, n); return ih_new(IH_FLATMAP, s, ih_callable_arg(s, a, n, "flatMap"), 0); }
static double ih_limit(tsv self, tsv* a, int n){
  int threw = 0;
  (void)threw;
  ts_handler* h = ts_eh_push();
  double d;
  if (ts_setjmp(h->buf) != 0){
    ts_gc_set_root_depth(h->gc_root_len);
    ts_frame_restore(h->frame_top);
    ts_eh_pop();
    tsv ex = ts_current_exception(); ts_gc_root(&ex);
    ih_close_quietly(self);
    ts_gc_unroot(1);
    ts_throw(ex);
  }
  d = ts_number_coerce(n > 1 ? a[1] : TS_UNDEFINED);
  ts_eh_pop();
  if (d != d || trunc(d) < 0){ ih_close_quietly(self); ts_throw_range_error_msg("The limit must be a non-negative number"); }
  return trunc(d);
}
static tsv ip_take(tsv* a, int n){ tsv s = ih_this(a, n); return ih_new(IH_TAKE, s, TS_UNDEFINED, ih_limit(s, a, n)); }
static tsv ip_drop(tsv* a, int n){ tsv s = ih_this(a, n); return ih_new(IH_DROP, s, TS_UNDEFINED, ih_limit(s, a, n)); }

/* ---- the eager ones ---- */
static tsv ip_to_array(tsv* a, int n){
  tsv it = ih_this(a, n); ts_gc_root(&it);
  tsv next = ih_next_of(it); ts_gc_root(&next);
  tsv out = ts_new_array(0); ts_gc_root(&out);
  tsv v = TS_UNDEFINED; ts_gc_root(&v);
  while (ih_step(it, next, &v)) ts_array_push(out, v);
  ts_gc_unroot(4);
  return out;
}
static tsv ip_reduce(tsv* a, int n){
  tsv it = ih_this(a, n); ts_gc_root(&it);
  tsv fn = ih_callable_arg(it, a, n, "reduce"); ts_gc_root(&fn);
  tsv next = ih_next_of(it); ts_gc_root(&next);
  tsv acc = TS_UNDEFINED, v = TS_UNDEFINED; ts_gc_root(&acc); ts_gc_root(&v);
  double i = 0;
  if (n > 2) acc = a[2];
  else {
    if (!ih_step(it, next, &acc)) ts_throw_type_error_msg("Reduce of a done iterator with no initial value");
    i = 1;
  }
  while (ih_step(it, next, &v)){
    tsv av[3] = { acc, v, ts_num(i) };
    acc = ih_call_closing(it, fn, av, 3);
    i += 1;
  }
  ts_gc_unroot(5);
  return acc;
}
enum { IE_EACH, IE_SOME, IE_EVERY, IE_FIND };
static tsv ih_eager(tsv* a, int n, int kind, const char* what){
  tsv it = ih_this(a, n); ts_gc_root(&it);
  tsv fn = ih_callable_arg(it, a, n, what); ts_gc_root(&fn);
  tsv next = ih_next_of(it); ts_gc_root(&next);
  tsv v = TS_UNDEFINED; ts_gc_root(&v);
  tsv out = kind == IE_EVERY ? ts_bool(1) : kind == IE_SOME ? ts_bool(0) : TS_UNDEFINED;
  double i = 0;
  while (ih_step(it, next, &v)){
    tsv av[2] = { v, ts_num(i) };
    tsv r = ih_call_closing(it, fn, av, 2);
    i += 1;
    if (kind == IE_EACH) continue;
    int yes = ts_truthy(r);
    if (kind == IE_SOME && yes){ out = ts_bool(1); ih_close(it); break; }
    if (kind == IE_EVERY && !yes){ out = ts_bool(0); ih_close(it); break; }
    if (kind == IE_FIND && yes){ out = v; ih_close(it); break; }
  }
  ts_gc_unroot(4);
  return out;
}
static tsv ip_for_each(tsv* a, int n){ return ih_eager(a, n, IE_EACH, "forEach"); }
static tsv ip_some(tsv* a, int n){ return ih_eager(a, n, IE_SOME, "some"); }
static tsv ip_every(tsv* a, int n){ return ih_eager(a, n, IE_EVERY, "every"); }
static tsv ip_find(tsv* a, int n){ return ih_eager(a, n, IE_FIND, "find"); }
static tsv ip_iterator(tsv* a, int n){ return n > 0 ? a[0] : TS_UNDEFINED; }

/* ---- Iterator.from, the wrapper ---- */
static tsv wrap_next(tsv* a, int n){
  IH_KEY(ki, "__ih_it"); IH_KEY(kn, "__ih_next");
  tsv self = n > 0 ? a[0] : TS_UNDEFINED;
  if (!ih_object(self) || ts_is_undef(ts_get(self, ki))) ts_throw_type_error_msg("Wrap for valid iterator: incompatible receiver");
  tsv it = ts_get(self, ki);
  return ts_call_method(ts_get(self, kn), &it, 1);
}
static tsv wrap_return(tsv* a, int n){
  IH_KEY(ki, "__ih_it"); IH_KEY(kr, "return");
  tsv self = n > 0 ? a[0] : TS_UNDEFINED;
  if (!ih_object(self) || ts_is_undef(ts_get(self, ki))) ts_throw_type_error_msg("Wrap for valid iterator: incompatible receiver");
  tsv it = ts_get(self, ki);
  ts_gc_root(&it);
  tsv ret = ts_get(it, kr);
  tsv r;
  if (ts_is_undef(ret) || ts_is_null(ret)) r = ts_iter_result_new(TS_UNDEFINED, 1);
  else r = ts_call_method(ret, &it, 1);
  ts_gc_unroot(1);
  return r;
}
static tsv it_from(tsv* a, int n){
  IH_KEY(ki, "__ih_it"); IH_KEY(kn, "__ih_next");
  tsv it = ih_flattenable(n > 0 ? a[0] : TS_UNDEFINED, 1);
  ts_gc_root(&it);
  /* an object that already inherits from %IteratorPrototype% is returned as it is */
  for (tsv p = ts_get_proto(it); ts_proto_ref(p); p = ts_get_proto(p)) if (p == g_iterator_proto){ ts_gc_unroot(1); return it; }
  tsv next = ih_next_of(it); ts_gc_root(&next);
  tsv w = ts_new_object(); ts_gc_root(&w);
  obj_link_fresh_proto(w, g_wrap_iter_proto);
  ts_set(w, ki, it); ts_set(w, kn, next);
  ts_gc_unroot(3);
  return w;
}
/* the Iterator constructor: abstract; a subclass's super() makes an ordinary object */
static tsv it_ctor(tsv* a, int n){
  (void)a; (void)n;
  if (!ts_native_new_take()) ts_throw_type_error_msg("Constructor Iterator requires 'new'");
  if (ts_is_undef(g_native_new_target) || g_native_new_target == g_iterator_ctor) ts_throw_type_error_msg("Abstract class Iterator not directly constructable");
  return ts_new_object();
}
/* the accessors of `constructor` and @@toStringTag: a read gives the value; a write defines on the receiver
   but never on the prototype itself (SetterThatIgnoresPrototypeProperties) */
static tsv ip_get_tag(tsv* a, int n){ (void)a; (void)n; return ts_new_string("Iterator", 8); }
static tsv ip_get_ctor(tsv* a, int n){ (void)a; (void)n; return g_iterator_ctor; }
static tsv ih_setter(tsv* a, int n, ts_key key){
  tsv self = n > 0 ? a[0] : TS_UNDEFINED;
  if (!ih_object(self)) ts_throw_type_error_msg("Iterator.prototype accessor set on something that is not an object");
  if (self == g_iterator_proto) ts_throw_type_error_msg("Cannot assign to this property on Iterator.prototype");
  ts_define_data(self, key, n > 1 ? a[1] : TS_UNDEFINED, 1, 1, 1);
  return TS_UNDEFINED;
}
static tsv ip_set_tag(tsv* a, int n){ return ih_setter(a, n, TS_KEY_WKSYM(TS_WKSYM_TO_STRING_TAG)); }
static tsv ip_set_ctor(tsv* a, int n){ return ih_setter(a, n, ih_key("constructor")); }
static void ih_accessor(tsv p, ts_key key, const char* get_name, ts_code get, const char* set_name, ts_code set){
  tsv g = ts_make_fn_t(get, NULL, 0, 1); ts_gc_root(&g);
  ts_set_fn_meta(g, 0, get_name);
  tsv s = ts_make_fn_t(set, NULL, 0, 1); ts_gc_root(&s);
  ts_set_fn_meta(s, 1, set_name);
  ts_define_accessor_attr(p, key, g, s, 1, 1, 0, 1);
  ts_gc_unroot(2);
}
tsv ts_iterator_proto(void){
  if (ts_proto_ref(g_iterator_proto)) return g_iterator_proto;
  static int rooted = 0, rooted_ctor = 0, rooted_helper = 0, rooted_wrap = 0;
  g_iterator_proto = ts_new_proto_pretenured();
  ts_root_static_once(&g_iterator_proto, &rooted);
  tsv p = g_iterator_proto;
  ((ts_object*)ts_ptr(p))->proto = g_object_proto_v;
  date_define(p, "map", ip_map, 1); date_define(p, "filter", ip_filter, 1); date_define(p, "take", ip_take, 1);
  date_define(p, "drop", ip_drop, 1); date_define(p, "flatMap", ip_flat_map, 1); date_define(p, "reduce", ip_reduce, 1);
  date_define(p, "toArray", ip_to_array, 0); date_define(p, "forEach", ip_for_each, 1); date_define(p, "some", ip_some, 1);
  date_define(p, "every", ip_every, 1); date_define(p, "find", ip_find, 1);
  tsv self_it = ts_make_fn_t(ip_iterator, NULL, 0, 1); ts_gc_root(&self_it);
  ts_set_fn_meta(self_it, 0, "[Symbol.iterator]");
  ts_define_data(p, TS_KEY_WKSYM(TS_WKSYM_ITERATOR), self_it, 0, 1, 1);
  ts_gc_unroot(1);
  g_iterator_ctor = ts_make_fn_t(it_ctor, NULL, 0, 0);
  ts_root_static_once(&g_iterator_ctor, &rooted_ctor);
  ts_set_fn_meta(g_iterator_ctor, 0, "Iterator");
  ts_fn_mark_native_ctor(g_iterator_ctor);
  ts_define_data(g_iterator_ctor, ih_key("prototype"), p, 0, 0, 0);
  tsv from = ts_make_fn_t(it_from, NULL, 0, 0); ts_gc_root(&from);
  ts_set_fn_meta(from, 1, "from");
  ts_define_data(g_iterator_ctor, ih_key("from"), from, 0, 1, 1);
  ts_gc_unroot(1);
  ih_accessor(p, ih_key("constructor"), "get constructor", ip_get_ctor, "set constructor", ip_set_ctor);
  ih_accessor(p, TS_KEY_WKSYM(TS_WKSYM_TO_STRING_TAG), "get [Symbol.toStringTag]", ip_get_tag, "set [Symbol.toStringTag]", ip_set_tag);
  g_iter_helper_proto = ts_new_proto_pretenured();
  ts_root_static_once(&g_iter_helper_proto, &rooted_helper);
  ((ts_object*)ts_ptr(g_iter_helper_proto))->proto = p;
  date_define(g_iter_helper_proto, "next", ih_helper_next, 0);
  date_define(g_iter_helper_proto, "return", ih_helper_return, 0);
  tsv tag = ts_new_string("Iterator Helper", 15); ts_gc_root(&tag);
  ts_define_data(g_iter_helper_proto, TS_KEY_WKSYM(TS_WKSYM_TO_STRING_TAG), tag, 0, 0, 1);
  ts_gc_unroot(1);
  g_wrap_iter_proto = ts_new_proto_pretenured();
  ts_root_static_once(&g_wrap_iter_proto, &rooted_wrap);
  ((ts_object*)ts_ptr(g_wrap_iter_proto))->proto = p;
  date_define(g_wrap_iter_proto, "next", wrap_next, 0);
  date_define(g_wrap_iter_proto, "return", wrap_return, 0);
  /* the built-in iterators inherit from it */
  ts_generator_proto_init(0);
  ((ts_object*)ts_ptr(g_generator_protos[0]))->proto = p;
  return p;
}
void ts_iterator_global(void){
  ts_iterator_proto();
  ts_global_set("Iterator", g_iterator_ctor);
}
