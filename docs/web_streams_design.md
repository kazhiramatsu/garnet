# WHATWG streams (`ReadableStream`, `WritableStream`, `TransformStream`)

Session 358. hono's streaming helpers (`stream`, `streamText`, `streamSSE`: a `TransformStream`
whose writer the handler writes and whose readable the response carries), body-limit (the
request body read through a `ReadableStream` reader, then re-given as a stream), etag (the
response body's digest through a reader) and the JSX streaming renderer (a `ReadableStream`
fed by `Suspense`) were the survey's second gap (docs/real_projects.md). This document is the
streams' scope and how a Request or Response body streams.

## Scope

`lib/node/web/streams.ts` is TypeScript compiled with the program, over promises: the prelude
installs its classes as the globals when the program names one (docs/node_compat_design.md).

- `ReadableStream`: an underlying source's `start` / `pull` / `cancel`, a queue under a
  `highWaterMark` with a `size` function (`CountQueuingStrategy`, `ByteLengthQueuingStrategy`),
  `pull` called while the desired size is positive or a read waits; `getReader()` (a default
  reader: `read`, `releaseLock`, `cancel`, `closed`), `cancel`, `tee`, `pipeTo` (`preventClose`,
  `preventAbort`, `preventCancel`, a `signal`), `pipeThrough`, `values` and async iteration,
  `ReadableStream.from` of a sync or async iterable. Byte streams (`type: "bytes"`, BYOB readers)
  are not provided: a TypeError says so (Node's default streams of `Uint8Array` chunks carry the
  same bytes).
- `WritableStream`: a sink's `start` / `write` / `close` / `abort`, writes run one at a time in
  order, backpressure through the writer's `ready` and `desiredSize`, `close` after the queued
  writes, `abort` rejecting what waits.
- `TransformStream`: `start` / `transform` / `flush` / `cancel`, the readable side's backpressure
  holding the writable side's writes (the readable's high-water mark is 0, the writable's 1, as the
  standard's), `terminate`, errors crossing both sides.
- `TextEncoderStream` and `TextDecoderStream` (UTF-8; a code point split across chunks is held
  back until its bytes arrive).

The error messages are Node's (`Invalid state: ReadableStream is locked`, ...). A reader's
`closed` and a writer's `ready` are handled promises: their rejection is never unhandled.

## Bodies

`lib/node/web/fetch.ts` (docs/web_fetch_api_design.md) keeps a body as text or bytes, and now
also as a stream:

- `new Response(stream)` / `new Request(url, { body: stream, duplex: "half" })` take a
  `ReadableStream` of `Uint8Array` chunks (no content-type; a locked or disturbed stream is a
  TypeError; a Request's stream body without `duplex` is Node's TypeError). `text()`, `json()`,
  `arrayBuffer()`, `bytes()` and `formData()` read it to its end; `fetch` reads a stream request
  body before the transport.
- `body` of a text or bytes body is a stream of its chunks as Node hands them (one for text and
  plain bytes; a Blob body's parts; a multipart body's pieces: a text field with its header, a
  file's header, each of its parts, its line end, the closing delimiter), materialized once and
  returned each time; a reader locks it and a read disturbs it, after which `text()` is "Body is
  unusable". `bodyUsed` reports the body's stream disturbed, or a read through the body methods
  (which also closes a materialized stream, so a later reader reads done); a consumed stream
  body stays locked, as Node's.
- `clone()` tees a stream body (each side reads every chunk); a text or bytes body is copied.
- `new Request(input)` of a Request takes the input's body as its own (the input is used at
  once, as Node's pipe disturbs it; `body: null` in the init keeps it, the Fetch standard's step
  43), and a used input is then a TypeError; an init with a body of its own replaces it, and a
  used input is no error then: hono's body-limit reads the request's stream through a reader and
  rebuilds the request over a stream of the chunks it read. `new Response(res.body)` carries the
  same stream object, so reading the new one disturbs the old one's.

## Blob and File

`lib/node/web/blob.ts`: a `Blob` holds its parts as Node's does (each part's bytes copied when
it is made: strings encoded as UTF-8, ArrayBuffers, views; a nested Blob's parts taken one by
one; an empty part dropped) and its type (lowercased; a type with a character outside printable
ASCII is the empty string); `size`, `type`, `text()`, `arrayBuffer()`, `bytes()`,
`slice(start, end, type)` (negative indices from the end, the part boundaries kept) and
`stream()`, which hands out one chunk per part, as a body of the Blob does. A `File` adds
`name`, `lastModified` (the init's, else now) and `webkitRelativePath`. The errors are Node's
(`blobParts` not iterable, an `endings` outside the enum).

In the bodies: a Blob is a body whose content-type is its type (none when empty); `blob()` of a
body is a Blob of its bytes typed by the content-type header; `FormData` takes a Blob with an
optional filename (`append` / `set`), a File as it is, a Blob that is not a File as a File named
"blob", a filename with a string value a TypeError, and its entries are `string | File`. A
FormData body serializes over bytes: a file part carries `filename` and a `Content-Type` of the
blob's type (`application/octet-stream` when it has none) and its bytes. `formData()` of a
multipart body parses over bytes: a part with a filename is a File of its `Content-Type`
(`text/plain` when the part has none, as the HTML standard's parsing says), other parts are
strings decoded as UTF-8. hono's `parseBody` and `c.req.blob()` go through these.

## Verified

`tests/conformance/exhaustive/web/streams.ts`, `web/body_streams.ts` and `web/blob.ts` (both
profiles; Node's own streams, bodies and blobs are the oracle); hono's survey drivers body_limit,
streaming (`stream`, `streamText`, `streamSSE`), etag and request_body (docs/real_projects.md).
