# CompressionStream and DecompressionStream

Session 359. hono's compress middleware (`new CompressionStream(encoding)` piped over the
response body) was the last library gap of the middleware survey (docs/real_projects.md).
This document is the two classes' scope, how the system's zlib is reached, and how a
stream's memory lives.

## Scope

`lib/node/web/compression.ts`, TypeScript compiled with the program: the prelude installs the
two classes as the globals when the program names one (docs/node_compat_design.md).

- The formats `gzip`, `deflate` and `deflate-raw`, with Node's zlib defaults (level 6, a 32 KB
  window, memLevel 8; to decompress, the window the zlib header names). Node 25 also accepts
  `brotli`; garnet has no brotli codec, so that format is a TypeError at construction (loud,
  CLAUDE.md). Any other value is Node's `ERR_INVALID_ARG_VALUE` TypeError ("... is not a valid
  enum value of type CompressionFormat"); the format is converted with `String()` first, as
  Node's enum converter does.
- The classes are Node's shape: `readable` and `writable` getters on the prototype, nothing
  enumerable on the instance, the `Symbol.toStringTag`.
- Node builds them as a readable and writable pair over a zlib stream
  (`newReadableWritablePairFromDuplex`), not as a TransformStream, and garnet follows the
  pair: the writable side's strategy is Node's (a high-water mark of 65,536 chunks), the
  readable side's a byte-length strategy of 64 KiB; a write waits while the readable side is
  full, until the reader pulls.
- The writable side takes what Node's zlib stream takes: a string (as UTF-8) and any
  ArrayBufferView. An ArrayBuffer or any other value is Node's `ERR_INVALID_ARG_TYPE`, `null`
  its `ERR_STREAM_NULL_VALUES`; the write rejects and the stream errors (Node leaves its
  readable side pending forever there; garnet errors it with the same TypeError).

## The output, cut as Node cuts it

Node's zlib stream writes into a 16 KiB output buffer and pushes what each zlib call produced
as one chunk (lib/zlib.js `processCallback`): the buffer is shared across writes and replaced
when it fills, so a chunk ends at every write and at every 16 KiB boundary of the buffer.
`runtime/zlib_host.c` keeps the same offset per stream and cuts the same chunks, and repeats
Node's checks after each call:

- `Z_OK` or `Z_BUF_ERROR` with output space left while finishing: "unexpected end of file"
  (`Z_BUF_ERROR`, errno -5); `Z_NEED_DICT`: "Missing dictionary"; any other failure: zlib's
  message (`incorrect header check`, `invalid block type`, ...) or "Zlib error".
- gunzip: after a member ends, input that does not start with a zero byte is read as the next
  member (zero bytes are padding).
- input left after the compressed data ended: for `gzip` and `deflate` Node's
  `ERR_TRAILING_JUNK_AFTER_STREAM_END` TypeError (its `rejectGarbageAfterEnd`); for
  `deflate-raw` the readable side ends there and later input is ignored.

A zlib failure is Node's error: a TypeError with no message whose `code` is the zlib code and
whose `cause` is the zlib error (`message`, `errno`, `code`), as Node's webstreams adapter
converts it. With the system's zlib being the one Node links (Homebrew's Node links
`/usr/lib/libz.1.dylib`), the compressed bytes are Node's byte for byte; with a Node that
bundles its own zlib they may differ, so the fixtures and the survey driver compare
decompressed bytes and what every zlib agrees on (the headers, the chunking of inflated
output, the errors).

## When a failure lands

Node's zlib runs on its thread pool: a write resolves before the data is processed, and a
failure reaches the streams on a later turn of the loop. Until then writes resolve and a close
fails with the failure; afterwards the writable side is errored by it, so a write fails with it
and a close refuses with `ERR_INVALID_STATE` (the standard's WritableStreamClose of an errored
stream). garnet processes a write at once and reproduces the observable sequence: the readable
side errors at once, the failure is kept for the close, and an immediate (the check phase of the
next loop turn) errors the writable side. A program that writes and closes without awaiting
across a timer sees what it sees under Node.

The same standard step was missing from `lib/node/web/streams.ts`: a close of an errored
WritableStream rejected with the stored error; it refuses with Node's TypeError now, every
"Invalid state" error carries `code: "ERR_INVALID_STATE"`, and `pipeTo` propagates an errored
destination backward before closing it.

## The system's zlib, loaded on first use

`runtime/zlib_host.c` (included at the end of ts_rt.c after node_host.c, as `metal_host.c` is)
loads `/usr/lib/libz.1.dylib` (Linux: `libz.so.1`) with dlopen the first time a program opens
a stream, and calls `deflateInit2_`, `deflate`, `inflateInit2_`, `inflate`, `inflateReset`
through pointers. The z_stream is declared in the file (zlib's ABI, unchanged since 1.0), so
the build needs no zlib header, and nothing is linked: a program that never compresses loads
nothing. The alternative recorded at the end of Session 358 was the fetch runtime's scheme (a
marker the emitter writes, a second runtime object, a link flag in every harness); a library
class calling a host method is invisible to the emitter, and dlopen needs neither the marker
nor the harnesses. glibc before 2.34 keeps dlopen in libdl, which the link does not name: there
the streams report zlib unavailable (an Error at construction).

## A stream's memory

A stream is one ArrayBuffer the library object holds (opaque to the program): the z_stream,
the host's state (the output offset, the failure) and every allocation zlib makes for it.
zlib's `zalloc` bumps through the buffer and `zfree` does nothing. An ArrayBuffer's bytes never
move, so zlib's internal pointers stay valid across collections, and the collector frees the
whole stream with the buffer: an abandoned stream (a response nobody reads) leaks nothing, no
finalizer is needed, and the stream's memory paces the collections as any buffer's bytes do.
zlib 1.2/1.3 take 268 KB to deflate (a 64 KB window, the hash chains, the pending buffer) and
7 KB to inflate plus a window of up to 32 KB made at the first output; the buffer is 272 KB and
48 KB, and a zlib that needs more at its start (zlib-ng allocates differently) gets a buffer
twice the size (doubling up to four times). The library drops its reference when the stream ends or fails.

## Verified

`tests/conformance/exhaustive/web/compression.ts` and `web/compression_errors.ts` (both
profiles; also under a young collection at every allocation, the protect mode and ASan, in the
GC stress gate); hono's survey driver `compress` (gzip, deflate, the q-values, a wildcard, the
threshold, `no-transform`, a non-text type, ETag, a streamed body, HEAD, the `encoding`
option), its bodies decoded with DecompressionStream.
