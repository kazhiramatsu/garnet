#include "ts_rt.h"

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
  ts_object o;
  tsv x;
} pic_test_class;

typedef struct {
  ts_frame_hdr h;
  tsv slots[3];
} frame_root_test;

typedef struct {
  ts_object o;
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

int main(){
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
  ts_gc_unroot(3);
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

  /* A fixed-key site becomes megamorphic after sixteen distinct misses and
     remains correct for all later shapes. */
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
  CK("pic megamorphic threshold", mega_ic.megamorphic && mega_ic.misses==16);

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
  CK("prop index threshold", indexed_obj->len==24 && indexed_obj->prop_index!=NULL);
  CK("prop index grew", indexed_obj->prop_index_cap>=32);
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
     indexed_obj->len==7 && indexed_obj->prop_index==NULL && indexed_obj->prop_index_cap==0);
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
     collision_obj->len==8 && collision_obj->prop_index_cap==16);
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
     ((ts_gc_header*)ts_ptr(pre_owner))->remembered!=0);
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
       ts_current_exception()==frame_exception &&
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
  printf("\n%s\n", fail==0?"ALL RUNTIME TESTS PASS":"FAILURES");
  return fail?1:0;
}
