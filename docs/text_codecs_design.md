# TextEncoder and TextDecoder

## Why

tsc-ts (`docs/tsc_ts_native_design.md`, slice 2) reads files as bytes and
decodes them (`new TextDecoder()`, `new TextDecoder('utf-16le')`), hashes
and serializes text as UTF-8 (`new TextEncoder().encode(text)`), and decodes
source map buffers. garnet rejected both constructors (loudly). Any program
that handles bytes uses them.

## Semantics (the WHATWG Encoding Standard, as node implements it)

- `new TextEncoder()`: `encoding` "utf-8"; `encode(input = "")`: ToString,
  then the UTF-8 bytes in a new Uint8Array (a lone surrogate encodes as
  U+FFFD); `encodeInto(source, destination)`: as many whole code points as
  fit in the Uint8Array, returning `{ read, written }` (UTF-16 units read,
  bytes written).
- `new TextDecoder(label = "utf-8", { fatal, ignoreBOM })`: the label,
  trimmed and ASCII-case-folded, names UTF-8 (`utf-8`, `utf8`,
  `unicode-1-1-utf-8`, ...), UTF-16LE (`utf-16le`, `utf-16`, `ucs-2`,
  `unicode`, ...) or UTF-16BE (`utf-16be`, `unicodefffe`); any other label
  is a RangeError (`The "<label>" encoding is not supported`, node's
  message; node with ICU knows the legacy single-byte encodings too, which
  garnet does not model). `encoding`, `fatal` and `ignoreBOM` read back.
- `decode(input, options)`: input undefined is no bytes; an ArrayBuffer, a
  SharedArrayBuffer or a typed array view gives its bytes; anything else is
  a TypeError. The decoder is the standard's: UTF-8 with the
  maximal-subpart replacement (each invalid sequence one U+FFFD), UTF-16
  with unpaired surrogates and an odd final byte replaced; the byte order
  mark is removed unless `ignoreBOM`; with `fatal` the first error is a
  TypeError (`The encoded data was not valid for encoding utf-8`). Streaming
  (`{ stream: true }`) is not modeled: a TypeError.
- The constructors are values (`typeof TextDecoder`, `instanceof`) in a
  program that names them; their methods are prototype methods (`encode`,
  `encodeInto`, `decode`) and accessors (`encoding`, `fatal`, `ignoreBOM`).

## Representation

Plain objects with their prototype; the decoder's settings in hidden fields
(the runtime hides `__` names from own-key enumeration). The encoder writes
straight into the result's buffer; the decoder builds the string from UTF-16
units (one byte each when every unit is Latin-1).
