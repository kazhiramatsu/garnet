/* The zlib streams behind CompressionStream and DecompressionStream (lib/node/web/compression.ts,
   docs/web_compression_design.md), as methods of `__garnet_node`. The system's libz is loaded with
   dlopen on the first use, as metal_host.c loads Metal: a program that never compresses loads and
   links nothing, and no build step or harness needs a marker (the fetch runtime's libcurl takes a
   second runtime object and a link flag). The z_stream is declared here (zlib's ABI, unchanged
   since 1.0), so the build needs no zlib header either.
   A stream lives in one ArrayBuffer the library object holds: its z_stream, this file's state and
   every allocation zlib makes for it (zalloc bumps through the buffer, zfree does nothing). The
   bytes of an ArrayBuffer never move, so zlib's internal pointers stay valid, and the collector
   frees the whole stream with the buffer: an abandoned stream leaks nothing, and its memory (270 KB
   to deflate, 40 KB to inflate) paces the collections as any buffer's bytes do.
   The output is cut as Node's zlib streams cut it (lib/zlib.js processCallback): a 16 KiB output
   buffer filled across writes, each call's output one chunk, a full buffer replaced by a new one;
   Node's checks after each call (an unexpected end when finishing, a gzip stream's further
   members, input left after the end) are reproduced, so the chunks and the errors are Node's.
   Included at the end of ts_rt.c after node_host.c. */
#if defined(__GLIBC__) && !(__GLIBC__ > 2 || (__GLIBC__ == 2 && __GLIBC_MINOR__ >= 34))
#define ZH_DLOPEN 0   /* glibc before 2.34 keeps dlopen in libdl, which the link does not name */
#else
#define ZH_DLOPEN 1
#include <dlfcn.h>
#endif

typedef struct {
  const uint8_t* next_in; unsigned avail_in; unsigned long total_in;
  uint8_t* next_out; unsigned avail_out; unsigned long total_out;
  const char* msg; void* state;
  void* (*zalloc)(void*, unsigned, unsigned); void (*zfree)(void*, void*); void* opaque;
  int data_type; unsigned long adler; unsigned long reserved;
} zh_zstream;   /* zlib's z_stream */
enum { ZH_NO_FLUSH = 0, ZH_FINISH = 4, ZH_OK = 0, ZH_STREAM_END = 1, ZH_NEED_DICT = 2,
       ZH_MEM_ERROR = -4, ZH_BUF_ERROR = -5, ZH_DEFLATED = 8 };
/* the modes (lib/node/web/compression.ts): the format's index, plus 3 to decompress */
enum { ZH_DEFLATE, ZH_DEFLATE_RAW, ZH_GZIP, ZH_INFLATE, ZH_INFLATE_RAW, ZH_GUNZIP };
#define ZH_CHUNK 16384u        /* Node's Z_DEFAULT_CHUNK: the size of its output buffers */
#define ZH_MAGIC 0x7a6c6962u   /* "zlib": the buffer holds a stream */

static struct {
  int state;   /* 0 untried, 1 loaded, -1 unavailable */
  const char* version;
  int (*deflate_init2)(zh_zstream*, int, int, int, int, int, const char*, int);
  int (*deflate)(zh_zstream*, int);
  int (*inflate_init2)(zh_zstream*, int, const char*, int);
  int (*inflate)(zh_zstream*, int);
  int (*inflate_reset)(zh_zstream*);
} zh;

/* libz and its entry points, once; false where it cannot be loaded. */
static int zh_load(void){
  if (zh.state) return zh.state > 0;
  zh.state = -1;
#if ZH_DLOPEN
#ifdef __APPLE__
  void* lib = dlopen("/usr/lib/libz.1.dylib", RTLD_LAZY | RTLD_LOCAL);
#else
  void* lib = dlopen("libz.so.1", RTLD_LAZY | RTLD_LOCAL);
#endif
  if (!lib) return 0;
  const char* (*version)(void) = (const char* (*)(void))dlsym(lib, "zlibVersion");
  zh.deflate_init2 = (int (*)(zh_zstream*, int, int, int, int, int, const char*, int))dlsym(lib, "deflateInit2_");
  zh.deflate = (int (*)(zh_zstream*, int))dlsym(lib, "deflate");
  zh.inflate_init2 = (int (*)(zh_zstream*, int, const char*, int))dlsym(lib, "inflateInit2_");
  zh.inflate = (int (*)(zh_zstream*, int))dlsym(lib, "inflate");
  zh.inflate_reset = (int (*)(zh_zstream*))dlsym(lib, "inflateReset");
  if (!version || !zh.deflate_init2 || !zh.deflate || !zh.inflate_init2 || !zh.inflate || !zh.inflate_reset) return 0;
  zh.version = version();
  zh.state = 1;
  return 1;
#else
  return 0;
#endif
}

/* The head of a stream's buffer; zlib's allocations follow it. */
typedef struct {
  zh_zstream strm;
  uint32_t magic;
  int32_t mode;
  int32_t err;            /* the zlib status of the failure zlibError reports */
  const char* err_msg;    /* zlib's message, else Node's default (static strings) */
  uint32_t out_offset;    /* Node's _outOffset: the bytes used of its current output buffer */
  uint32_t used, cap;     /* the bump allocator over the buffer */
} zh_state;

static void* zh_alloc(void* opaque, unsigned items, unsigned size){
  zh_state* s = (zh_state*)opaque;
  size_t n = ((size_t)items * size + 15u) & ~(size_t)15u;
  if (n > (size_t)(s->cap - s->used)) return NULL;
  void* p = (uint8_t*)s + s->used;
  s->used += (uint32_t)n;
  return p;
}
static void zh_free(void* opaque, void* p){ (void)opaque; (void)p; }   /* the buffer goes whole */

/* zlibOpen(mode): a stream (its ArrayBuffer, opaque to the library), or the reason libz is unavailable. */
static tsv zh_open(tsv* a, int n){
  int mode = (int)nh_num(a, n, 0, -1);
  if (mode < ZH_DEFLATE || mode > ZH_GUNZIP) ts_throw_type_error_msg("zlibOpen: unknown mode");
  if (!zh_load()) return nh_string("the system zlib (libz) could not be loaded");
  /* zlib 1.2/1.3 take 268 KB to deflate (a 64 KB window, hash chains and pending buffer) and
     7 KB to inflate plus a window of up to 32 KB made at the first output; a zlib that takes
     more (zlib-ng allocates differently) gets a buffer twice the size */
  uint32_t cap = mode <= ZH_GZIP ? (272u << 10) : (48u << 10);
  for (int attempt = 0; attempt < 5; attempt++, cap *= 2){
    tsv buf = ta_new_buffer((double)cap, 0);
    zh_state* s = (zh_state*)((ts_arraybuffer*)ts_ptr(buf))->bytes;
    s->magic = ZH_MAGIC; s->mode = mode; s->cap = cap;
    s->used = (uint32_t)((sizeof(zh_state) + 15u) & ~(size_t)15u);
    s->strm.zalloc = zh_alloc; s->strm.zfree = zh_free; s->strm.opaque = s;
    int r;
    if (mode <= ZH_GZIP){
      /* Node's defaults: level 6, a 32 KB window (raw: negative; gzip: plus 16), memLevel 8 */
      int bits = mode == ZH_DEFLATE_RAW ? -15 : mode == ZH_GZIP ? 31 : 15;
      r = zh.deflate_init2(&s->strm, -1, ZH_DEFLATED, bits, 8, 0, zh.version, (int)sizeof(zh_zstream));
    } else {
      /* Node's: the window the zlib header names (gunzip: plus 16), raw: 32 KB */
      int bits = mode == ZH_INFLATE_RAW ? -15 : mode == ZH_GUNZIP ? 16 : 0;
      r = zh.inflate_init2(&s->strm, bits, zh.version, (int)sizeof(zh_zstream));
      if (r == ZH_OK && s->cap - s->used < (32u << 10) + 64u) r = ZH_MEM_ERROR;   /* room for the window */
    }
    if (r == ZH_OK) return buf;
    if (r != ZH_MEM_ERROR) return nh_string("the system zlib refused to start a stream");
  }
  return nh_string("the system zlib asked for more memory than a stream is given");
}

static zh_state* zh_state_of(tsv h){
  if (ts_is_array_buffer(h)){
    ts_arraybuffer* b = (ts_arraybuffer*)ts_ptr(h);
    zh_state* s = (zh_state*)b->bytes;
    if (s && b->byte_length >= sizeof(zh_state) && s->magic == ZH_MAGIC && s->cap == b->byte_length) return s;
  }
  ts_throw_type_error_msg("not a zlib stream");
  return NULL;
}
static int zh_run(zh_state* s, int flush){
  if (s->mode <= ZH_GZIP) return zh.deflate(&s->strm, flush);
  int r = zh.inflate(&s->strm, flush);
  /* a gzip stream's further members, as Node's gunzip reads them; zero bytes after one are padding */
  while (s->mode == ZH_GUNZIP && r == ZH_STREAM_END && s->strm.avail_in > 0 && s->strm.next_in[0] != 0){
    zh.inflate_reset(&s->strm);
    r = zh.inflate(&s->strm, flush);
  }
  return r;
}
static uint8_t zh_out[ZH_CHUNK];
/* zlibWrite(handle, input, finish, out): the stream over the input (finishing it when `finish`),
   each piece of output pushed onto `out`. 0: the input was taken; 1: the compressed data ended
   with input left over (Node's caller decides: an error, or the end of a raw stream); -1: zlib
   failed (zlibError), the output of the failing call dropped as Node drops it. */
static tsv zh_write(tsv* a, int n){
  tsv hv = nh_arg(a, n, 0), inv = nh_arg(a, n, 1), outv = nh_arg(a, n, 3);
  int flush = ts_truthy(nh_arg(a, n, 2)) ? ZH_FINISH : ZH_NO_FLUSH;
  zh_state* s = zh_state_of(hv);
  if (!ts_is_typed_array(inv) || !ts_is_array(outv)) ts_throw_type_error_msg("zlibWrite: a Uint8Array input and an output array");
  ts_gc_root(&hv); ts_gc_root(&inv); ts_gc_root(&outv);
  ts_typedarray* in = (ts_typedarray*)ts_ptr(inv);
  s->strm.next_in = in->data;   /* a buffer's bytes never move */
  s->strm.avail_in = in->length * nh_elem_size(in->elem);
  int status = 0;
  for (;;){
    uint32_t before = ZH_CHUNK - s->out_offset;
    s->strm.next_out = zh_out; s->strm.avail_out = before;
    int r = zh_run(s, flush);
    /* Node's GetErrorInfo */
    const char* fail = NULL;
    if (r == ZH_OK || r == ZH_BUF_ERROR){ if (s->strm.avail_out != 0 && flush == ZH_FINISH) fail = "unexpected end of file"; }
    else if (r == ZH_NEED_DICT) fail = "Missing dictionary";
    else if (r != ZH_STREAM_END) fail = "Zlib error";
    if (fail){ s->err = r; s->err_msg = s->strm.msg ? s->strm.msg : fail; status = -1; break; }
    uint32_t have = before - s->strm.avail_out;
    if (have){
      tsv chunk = nh_bytes_value(zh_out, have); ts_gc_root(&chunk);
      ts_array_push(outv, chunk);
      ts_gc_unroot(1);
      s->out_offset += have;
    }
    if (s->strm.avail_out == 0 || s->out_offset >= ZH_CHUNK) s->out_offset = 0;
    if (s->strm.avail_out == 0) continue;   /* the buffer filled: the rest goes into a new one */
    if (s->strm.avail_in > 0) status = 1;
    break;
  }
  s->strm.next_in = NULL; s->strm.avail_in = 0;
  ts_gc_unroot(3);
  return ts_num((double)status);
}
static const char* zh_code_name(int err){
  switch (err){
    case 0: return "Z_OK"; case 1: return "Z_STREAM_END"; case 2: return "Z_NEED_DICT";
    case -1: return "Z_ERRNO"; case -2: return "Z_STREAM_ERROR"; case -3: return "Z_DATA_ERROR";
    case -4: return "Z_MEM_ERROR"; case -5: return "Z_BUF_ERROR"; case -6: return "Z_VERSION_ERROR";
    default: return "Z_UNKNOWN_ERROR";
  }
}
/* zlibError(handle): [message, code, errno] of the failure, as Node's zlib error carries them */
static tsv zh_error(tsv* a, int n){
  zh_state* s = zh_state_of(nh_arg(a, n, 0));
  const char* msg = s->err_msg ? s->err_msg : "";
  int err = s->err;
  tsv out = ts_new_array(0); ts_gc_root(&out);
  tsv m = nh_string(msg); ts_gc_root(&m); ts_array_push(out, m); ts_gc_unroot(1);
  tsv c = nh_string(zh_code_name(err)); ts_gc_root(&c); ts_array_push(out, c); ts_gc_unroot(1);
  ts_array_push(out, ts_num((double)err));
  ts_gc_unroot(1);
  return out;
}
static void zh_install(tsv host){
  nh_method(host, "zlibOpen", zh_open, 1);
  nh_method(host, "zlibWrite", zh_write, 4);
  nh_method(host, "zlibError", zh_error, 1);
}
