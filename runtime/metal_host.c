/* garnet:metal (lib/garnet/metal.ts, docs/metal_design.md): Metal compute as the global
   `__garnet_metal`. Plain C over the Objective-C runtime: Metal.framework is loaded with
   dlopen on the first use and every method is an objc_msgSend through a function pointer
   cast to the method's C signature (the arm64 ABI passes MTLSize, 24 bytes, indirectly,
   and a cast call site emits exactly that), so the runtime stays one translation unit
   with no framework at link time, a program that never uses the module loads nothing,
   and a build on another platform answers available() false.
   Objects: the device and the queue live for the process; libraries, pipelines and
   buffers are owned (+1 from their `new...` methods) and sit in tables a small integer
   handle indexes; a command buffer and its encoder are autoreleased in a pool pushed at
   begin() and popped at wait() or discard(). A buffer is the store of a SharedArrayBuffer
   (an mmap of whole pages, which newBufferWithBytesNoCopy requires), shared with the GPU
   without a copy; the TypeScript GpuBuffer keeps that SharedArrayBuffer reachable.
   Included at the end of ts_rt.c after node_host.c. */
#ifdef __APPLE__
#include <dlfcn.h>
#ifndef RTLD_DEFAULT
#define RTLD_DEFAULT ((void*)-2)
#endif
#endif

typedef void* mh_id;
typedef void* mh_sel;
typedef struct { unsigned long width, height, depth; } mh_size;   /* MTLSize */
typedef struct { mh_id obj; unsigned long max_threads, simd_width; } mh_pipe;
typedef struct { mh_id obj; uint32_t length; } mh_buf;             /* obj NULL once released */

static struct {
  int state;                         /* 0 untried, 1 available, -1 unavailable */
  void* msg;                         /* objc_msgSend, cast to each method's signature */
  mh_sel (*sel)(const char*);        /* sel_registerName */
  mh_id (*cls)(const char*);         /* objc_getClass */
  void* (*pool_push)(void);          /* objc_autoreleasePoolPush */
  void (*pool_pop)(void*);           /* objc_autoreleasePoolPop */
  mh_id device, queue;
  mh_id* libs; uint32_t nlibs, clibs;
  mh_pipe* pipes; uint32_t npipes, cpipes;
  mh_buf* bufs; uint32_t nbufs, cbufs;
  void* pool; mh_id cmd, enc;        /* the open command buffer and its compute encoder */
  int cmd_state;                     /* 0 none, 1 encoding, 2 committed */
  int32_t cmd_pipe;                  /* the pipeline set on the open encoder, -1 none */
  mh_sel s_set_pipeline, s_set_buffer, s_set_bytes, s_dispatch;   /* the per-dispatch selectors, once */
} mh;

static mh_id mh_send(mh_id o, const char* s){ return ((mh_id (*)(mh_id, mh_sel))mh.msg)(o, mh.sel(s)); }
static mh_id mh_send_id(mh_id o, const char* s, mh_id x){ return ((mh_id (*)(mh_id, mh_sel, mh_id))mh.msg)(o, mh.sel(s), x); }
static unsigned long mh_send_ul(mh_id o, const char* s){ return ((unsigned long (*)(mh_id, mh_sel))mh.msg)(o, mh.sel(s)); }
static const char* mh_cstr(mh_id ns){ return ns ? ((const char* (*)(mh_id, mh_sel))mh.msg)(ns, mh.sel("UTF8String")) : ""; }
static mh_id mh_nsstr(const char* c){ return ((mh_id (*)(mh_id, mh_sel, const char*))mh.msg)(mh.cls("NSString"), mh.sel("stringWithUTF8String:"), c); }
static const char* mh_error_text(mh_id err){ return err ? mh_cstr(mh_send(err, "localizedDescription")) : "unknown error"; }

/* The framework, the device and the queue, once; false where there is no Metal. */
static int mh_init(void){
  if (mh.state) return mh.state > 0;
  mh.state = -1;
#ifdef __APPLE__
  void* metal = dlopen("/System/Library/Frameworks/Metal.framework/Metal", RTLD_LAZY | RTLD_LOCAL);
  if (!metal) return 0;
  mh.msg = dlsym(RTLD_DEFAULT, "objc_msgSend");
  mh.sel = (mh_sel (*)(const char*))dlsym(RTLD_DEFAULT, "sel_registerName");
  mh.cls = (mh_id (*)(const char*))dlsym(RTLD_DEFAULT, "objc_getClass");
  mh.pool_push = (void* (*)(void))dlsym(RTLD_DEFAULT, "objc_autoreleasePoolPush");
  mh.pool_pop = (void (*)(void*))dlsym(RTLD_DEFAULT, "objc_autoreleasePoolPop");
  mh_id (*create)(void) = (mh_id (*)(void))dlsym(metal, "MTLCreateSystemDefaultDevice");
  if (!mh.msg || !mh.sel || !mh.cls || !mh.pool_push || !mh.pool_pop || !create) return 0;
  void* pool = mh.pool_push();
  mh.device = create();
  mh.queue = mh.device ? mh_send(mh.device, "newCommandQueue") : NULL;
  mh.pool_pop(pool);
  if (!mh.queue) return 0;
  mh.s_set_pipeline = mh.sel("setComputePipelineState:");
  mh.s_set_buffer = mh.sel("setBuffer:offset:atIndex:");
  mh.s_set_bytes = mh.sel("setBytes:length:atIndex:");
  mh.s_dispatch = mh.sel("dispatchThreadgroups:threadsPerThreadgroup:");
  mh.cmd_pipe = -1;
  mh.state = 1;
#endif
  return mh.state > 0;
}

/* Errors: the message is built as a string first (it may copy an autoreleased
   NSString's text), the pool is popped by the caller, then the Error is thrown. */
static tsv mh_message(const char* prefix, const char* detail){
  size_t np = strlen(prefix), nd = strlen(detail);
  char* buf = (char*)malloc(np + nd + 1);
  if (!buf) ts_abort_msg("out of memory building a garnet:metal message");
  memcpy(buf, prefix, np); memcpy(buf + np, detail, nd + 1);
  tsv s = ts_new_string(buf, (uint32_t)(np + nd));
  free(buf);
  return s;
}
static void mh_throw_msg(int kind, tsv msg){
  ts_gc_root(&msg);
  tsv e = ts_new_error(kind, msg);
  ts_gc_unroot(1);
  ts_throw(e);
}
static void mh_throw(int kind, const char* prefix, const char* detail){ mh_throw_msg(kind, mh_message(prefix, detail)); }
static void mh_require(void){ if (!mh_init()) mh_throw(0, "garnet:metal: Metal is not available", ""); }
static tsv mh_arg(tsv* a, int n, int i){ return i < n ? a[i] : TS_UNDEFINED; }
/* an integer argument in [0, max]; a TypeError for a non-number, a RangeError past the range */
static double mh_int_arg(tsv* a, int n, int i, double max, const char* what){
  tsv v = mh_arg(a, n, i);
  if (!ts_is_num(v)) mh_throw(1, "garnet:metal: ", what);
  double d = ts_to_num(v);
  if (!(d >= 0.0 && d <= max) || d != floor(d)) mh_throw(2, "garnet:metal: out of range: ", what);
  return d;
}
static uint32_t mh_push_lib(mh_id obj){
  if (mh.nlibs == mh.clibs){ mh.clibs = mh.clibs ? mh.clibs * 2u : 8u; mh.libs = (mh_id*)realloc(mh.libs, sizeof(mh_id) * mh.clibs); }
  mh.libs[mh.nlibs] = obj; return mh.nlibs++;
}
static uint32_t mh_push_pipe(mh_pipe p){
  if (mh.npipes == mh.cpipes){ mh.cpipes = mh.cpipes ? mh.cpipes * 2u : 16u; mh.pipes = (mh_pipe*)realloc(mh.pipes, sizeof(mh_pipe) * mh.cpipes); }
  mh.pipes[mh.npipes] = p; return mh.npipes++;
}
static uint32_t mh_push_buf(mh_buf b){
  if (mh.nbufs == mh.cbufs){ mh.cbufs = mh.cbufs ? mh.cbufs * 2u : 16u; mh.bufs = (mh_buf*)realloc(mh.bufs, sizeof(mh_buf) * mh.cbufs); }
  mh.bufs[mh.nbufs] = b; return mh.nbufs++;
}
static uint32_t mh_handle(tsv v, uint32_t count, const char* what){
  double d = ts_is_num(v) ? ts_to_num(v) : -1.0;
  if (!(d >= 0.0 && d < (double)count) || d != floor(d)) mh_throw(1, "garnet:metal: ", what);
  return (uint32_t)d;
}
static mh_buf* mh_buf_of(tsv v){
  mh_buf* b = &mh.bufs[mh_handle(v, mh.nbufs, "not a GpuBuffer")];
  if (!b->obj) mh_throw(0, "garnet:metal: the buffer was released", "");
  return b;
}
static void mh_need_open(void){ if (mh.cmd_state != 1) mh_throw(0, "garnet:metal: no open command buffer", ""); }

static tsv mh_available_fn(tsv* a, int n){ (void)a; (void)n; return ts_bool(mh_init()); }
static tsv mh_device_name_fn(tsv* a, int n){
  (void)a; (void)n;
  if (!mh_init()) return ts_new_string("", 0);
  void* pool = mh.pool_push();
  const char* s = mh_cstr(mh_send(mh.device, "name"));
  tsv r = ts_new_string(s, (uint32_t)strlen(s));
  mh.pool_pop(pool);
  return r;
}
/* compile(source, fastMath): a library from Metal Shading Language source; the compiler's
   log is the Error. Fast math is off unless asked for (MTLMathModeSafe on macOS 15 and
   later, the older fastMathEnabled flag before), so the kernels' arithmetic is the text's. */
static tsv mh_compile_fn(tsv* a, int n){
  tsv src = mh_arg(a, n, 0);
  if (!ts_is_str(src)) ts_throw_type_error_msg("garnet:metal: the kernel source must be a string");
  int fast = ts_truthy(mh_arg(a, n, 1));
  mh_require();
  uint32_t len; char* text = ts_string_utf8_copy(src, &len);
  void* pool = mh.pool_push();
  mh_id opts = mh_send(mh_send(mh.cls("MTLCompileOptions"), "alloc"), "init");
  if (((signed char (*)(mh_id, mh_sel, mh_sel))mh.msg)(opts, mh.sel("respondsToSelector:"), mh.sel("setMathMode:")))
    ((void (*)(mh_id, mh_sel, long))mh.msg)(opts, mh.sel("setMathMode:"), fast ? 2L : 0L);   /* MTLMathModeFast / Safe */
  else
    ((void (*)(mh_id, mh_sel, signed char))mh.msg)(opts, mh.sel("setFastMathEnabled:"), (signed char)(fast ? 1 : 0));
  mh_id err = NULL;
  mh_id lib = ((mh_id (*)(mh_id, mh_sel, mh_id, mh_id, mh_id*))mh.msg)(mh.device, mh.sel("newLibraryWithSource:options:error:"), mh_nsstr(text), opts, &err);
  free(text);
  mh_send(opts, "release");
  if (!lib){
    tsv msg = mh_message("garnet:metal: compile failed: ", mh_error_text(err));
    mh.pool_pop(pool);
    mh_throw_msg(0, msg);
  }
  mh.pool_pop(pool);
  return ts_num((double)mh_push_lib(lib));
}
/* pipeline(library, name): the compute pipeline state of a kernel function. */
static tsv mh_pipeline_fn(tsv* a, int n){
  mh_id lib = mh.libs ? mh.libs[mh_handle(mh_arg(a, n, 0), mh.nlibs, "not a Library")] : NULL;
  if (!lib) mh_throw(1, "garnet:metal: not a Library", "");
  tsv name = mh_arg(a, n, 1);
  if (!ts_is_str(name)) ts_throw_type_error_msg("garnet:metal: the kernel name must be a string");
  uint32_t len; char* cname = ts_string_utf8_copy(name, &len);
  void* pool = mh.pool_push();
  mh_id fn = mh_send_id(lib, "newFunctionWithName:", mh_nsstr(cname));
  if (!fn){
    tsv msg = mh_message("garnet:metal: no kernel named ", cname);
    free(cname);
    mh.pool_pop(pool);
    mh_throw_msg(0, msg);
  }
  free(cname);
  mh_id err = NULL;
  mh_id pso = ((mh_id (*)(mh_id, mh_sel, mh_id, mh_id*))mh.msg)(mh.device, mh.sel("newComputePipelineStateWithFunction:error:"), fn, &err);
  mh_send(fn, "release");
  if (!pso){
    tsv msg = mh_message("garnet:metal: the pipeline failed: ", mh_error_text(err));
    mh.pool_pop(pool);
    mh_throw_msg(0, msg);
  }
  mh_pipe p;
  p.obj = pso;
  p.max_threads = mh_send_ul(pso, "maxTotalThreadsPerThreadgroup");
  p.simd_width = mh_send_ul(pso, "threadExecutionWidth");
  mh.pool_pop(pool);
  return ts_num((double)mh_push_pipe(p));
}
static tsv mh_pipeline_max_threads_fn(tsv* a, int n){ return ts_num((double)mh.pipes[mh_handle(mh_arg(a, n, 0), mh.npipes, "not a Pipeline")].max_threads); }
static tsv mh_pipeline_simd_width_fn(tsv* a, int n){ return ts_num((double)mh.pipes[mh_handle(mh_arg(a, n, 0), mh.npipes, "not a Pipeline")].simd_width); }
/* buffer(sharedArrayBuffer): a Metal buffer over the SharedArrayBuffer's pages, no copy. */
static tsv mh_buffer_fn(tsv* a, int n){
  tsv v = mh_arg(a, n, 0);
  if (!ts_is_array_buffer(v) || !((ts_arraybuffer*)ts_ptr(v))->shared) ts_throw_type_error_msg("garnet:metal: a GpuBuffer takes a SharedArrayBuffer");
  mh_require();
  ts_arraybuffer* ab = (ts_arraybuffer*)ts_ptr(v);
  void* pool = mh.pool_push();
  mh_id buf = ((mh_id (*)(mh_id, mh_sel, void*, unsigned long, unsigned long, void*))mh.msg)(
    mh.device, mh.sel("newBufferWithBytesNoCopy:length:options:deallocator:"),
    ab->bytes, (unsigned long)sab_mapped_bytes(ab->byte_length), 0ul /* shared storage, default cache */, NULL);
  mh.pool_pop(pool);
  if (!buf) mh_throw(0, "garnet:metal: the device refused the buffer", "");
  mh_buf b;
  b.obj = buf; b.length = ab->byte_length;
  return ts_num((double)mh_push_buf(b));
}
static tsv mh_release_buffer_fn(tsv* a, int n){
  mh_buf* b = mh_buf_of(mh_arg(a, n, 0));
  mh_send(b->obj, "release");
  b->obj = NULL;
  return TS_UNDEFINED;
}
/* begin(): a command buffer with a serial compute encoder; one at a time. */
static tsv mh_begin_fn(tsv* a, int n){
  (void)a; (void)n;
  mh_require();
  if (mh.cmd_state == 1) mh_throw(0, "garnet:metal: a command buffer is already open (commit or discard it first)", "");
  if (mh.cmd_state == 2) mh_throw(0, "garnet:metal: the previous command buffer was committed and not waited for", "");
  mh.pool = mh.pool_push();
  mh.cmd = mh_send(mh.queue, "commandBuffer");
  mh.enc = mh.cmd ? mh_send(mh.cmd, "computeCommandEncoder") : NULL;
  if (!mh.enc){
    mh.pool_pop(mh.pool); mh.pool = NULL; mh.cmd = NULL;
    mh_throw(0, "garnet:metal: the device gave no command buffer", "");
  }
  mh.cmd_state = 1; mh.cmd_pipe = -1;
  return TS_UNDEFINED;
}
static tsv mh_set_pipeline_fn(tsv* a, int n){
  mh_need_open();
  uint32_t p = mh_handle(mh_arg(a, n, 0), mh.npipes, "not a Pipeline");
  ((void (*)(mh_id, mh_sel, mh_id))mh.msg)(mh.enc, mh.s_set_pipeline, mh.pipes[p].obj);
  mh.cmd_pipe = (int32_t)p;
  return TS_UNDEFINED;
}
/* setBuffer(index, buffer, byteOffset): the offset must be within the buffer (Metal would
   read past it silently); the alignment the kernel's pointer type needs is the program's. */
static tsv mh_set_buffer_fn(tsv* a, int n){
  mh_need_open();
  double idx = mh_int_arg(a, n, 0, 30.0, "a buffer index is an integer from 0 to 30");
  mh_buf* b = mh_buf_of(mh_arg(a, n, 1));
  double off = mh_int_arg(a, n, 2, (double)b->length, "a buffer offset is an integer within the buffer");
  ((void (*)(mh_id, mh_sel, mh_id, unsigned long, unsigned long))mh.msg)(mh.enc, mh.s_set_buffer, b->obj, (unsigned long)off, (unsigned long)idx);
  return TS_UNDEFINED;
}
/* setBytes(index, view): an argument struct, copied into the command buffer (4 KB at most). */
static tsv mh_set_bytes_fn(tsv* a, int n){
  mh_need_open();
  double idx = mh_int_arg(a, n, 0, 30.0, "a buffer index is an integer from 0 to 30");
  tsv v = mh_arg(a, n, 1);
  const void* data; uint32_t len;
  if (ts_is_typed_array(v)){
    ts_typedarray* t = (ts_typedarray*)ts_ptr(v);
    data = t->data; len = t->length * nh_elem_size(t->elem);
  } else if (ts_is_array_buffer(v)){
    ts_arraybuffer* ab = (ts_arraybuffer*)ts_ptr(v);
    data = ab->bytes; len = ab->byte_length;
  } else {
    ts_throw_type_error_msg("garnet:metal: bytes takes a typed array or an ArrayBuffer");
    return TS_UNDEFINED;
  }
  if (len > 4096u) mh_throw(2, "garnet:metal: out of range: ", "bytes takes at most 4096 bytes");
  ((void (*)(mh_id, mh_sel, const void*, unsigned long, unsigned long))mh.msg)(mh.enc, mh.s_set_bytes, data, (unsigned long)len, (unsigned long)idx);
  return TS_UNDEFINED;
}
/* dispatch(gx, gy, gz, tx, ty, tz): threadgroups and threads per threadgroup, at least one
   each, within the pipeline's maximum (Metal would fail the command buffer later). */
static tsv mh_dispatch_fn(tsv* a, int n){
  mh_need_open();
  if (mh.cmd_pipe < 0) mh_throw(0, "garnet:metal: dispatch before a pipeline was set", "");
  double lim = (double)mh.pipes[mh.cmd_pipe].max_threads;
  mh_size g, t;
  g.width = (unsigned long)mh_int_arg(a, n, 0, 4294967295.0, "a threadgroup count is an integer");
  g.height = (unsigned long)mh_int_arg(a, n, 1, 4294967295.0, "a threadgroup count is an integer");
  g.depth = (unsigned long)mh_int_arg(a, n, 2, 4294967295.0, "a threadgroup count is an integer");
  t.width = (unsigned long)mh_int_arg(a, n, 3, lim, "a threads-per-threadgroup count is an integer within the pipeline's maximum");
  t.height = (unsigned long)mh_int_arg(a, n, 4, lim, "a threads-per-threadgroup count is an integer within the pipeline's maximum");
  t.depth = (unsigned long)mh_int_arg(a, n, 5, lim, "a threads-per-threadgroup count is an integer within the pipeline's maximum");
  if (!g.width || !g.height || !g.depth) mh_throw(2, "garnet:metal: out of range: ", "a dispatch needs at least one threadgroup");
  if (!t.width || !t.height || !t.depth || (double)t.width * (double)t.height * (double)t.depth > lim)
    mh_throw(2, "garnet:metal: out of range: ", "the threads per threadgroup exceed the pipeline's maximum");
  ((void (*)(mh_id, mh_sel, mh_size, mh_size))mh.msg)(mh.enc, mh.s_dispatch, g, t);
  return TS_UNDEFINED;
}
static tsv mh_commit_fn(tsv* a, int n){
  (void)a; (void)n;
  mh_need_open();
  mh_send(mh.enc, "endEncoding");
  mh_send(mh.cmd, "commit");
  mh.cmd_state = 2;
  return TS_UNDEFINED;
}
/* wait(): until the committed command buffer completes; its error, if any, is thrown. */
static tsv mh_wait_fn(tsv* a, int n){
  (void)a; (void)n;
  if (mh.cmd_state != 2) mh_throw(0, "garnet:metal: no committed command buffer to wait for", "");
  mh_send(mh.cmd, "waitUntilCompleted");
  unsigned long status = mh_send_ul(mh.cmd, "status");   /* MTLCommandBufferStatusCompleted 4, Error 5 */
  tsv msg = TS_UNDEFINED;
  if (status != 4ul) msg = mh_message("garnet:metal: the command buffer failed: ", mh_error_text(mh_send(mh.cmd, "error")));
  mh.pool_pop(mh.pool);
  mh.pool = NULL; mh.cmd = NULL; mh.enc = NULL; mh.cmd_state = 0; mh.cmd_pipe = -1;
  if (status != 4ul) mh_throw_msg(0, msg);
  return TS_UNDEFINED;
}
/* discard(): drops an open command buffer (an encoder must end before it goes); a
   committed one is left to the queue. */
static tsv mh_discard_fn(tsv* a, int n){
  (void)a; (void)n;
  if (mh.cmd_state == 1) mh_send(mh.enc, "endEncoding");
  if (mh.pool){ mh.pool_pop(mh.pool); mh.pool = NULL; }
  mh.cmd = NULL; mh.enc = NULL; mh.cmd_state = 0; mh.cmd_pipe = -1;
  return TS_UNDEFINED;
}
static void ts_garnet_metal_global_init(tsv global){
  ts_gc_root(&global);
  tsv host = ts_new_object(); ts_gc_root(&host);
  nh_method(host, "available", mh_available_fn, 0);
  nh_method(host, "deviceName", mh_device_name_fn, 0);
  nh_method(host, "compile", mh_compile_fn, 2);
  nh_method(host, "pipeline", mh_pipeline_fn, 2);
  nh_method(host, "pipelineMaxThreads", mh_pipeline_max_threads_fn, 1);
  nh_method(host, "pipelineSimdWidth", mh_pipeline_simd_width_fn, 1);
  nh_method(host, "buffer", mh_buffer_fn, 1);
  nh_method(host, "releaseBuffer", mh_release_buffer_fn, 1);
  nh_method(host, "begin", mh_begin_fn, 0);
  nh_method(host, "setPipeline", mh_set_pipeline_fn, 1);
  nh_method(host, "setBuffer", mh_set_buffer_fn, 3);
  nh_method(host, "setBytes", mh_set_bytes_fn, 2);
  nh_method(host, "dispatch", mh_dispatch_fn, 6);
  nh_method(host, "commit", mh_commit_fn, 0);
  nh_method(host, "wait", mh_wait_fn, 0);
  nh_method(host, "discard", mh_discard_fn, 0);
  ts_set_cstr(global, "__garnet_metal", host);
  ts_gc_unroot(2);
}
