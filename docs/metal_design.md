# `garnet:metal`: Metal compute from TypeScript

Session 353 (2026-10-27). Kaz asked for the GPU path of the LLM program
(`docs/llm_inference_design.md`, milestone 3) and for the inference code to be
a garnet module rather than a benchmark. The GPU half is a module of its own,
`garnet:metal`, because nothing in it is specific to language models: it is
the smallest API through which a TypeScript program compiles Metal Shading
Language kernels and runs them over its own memory.

## The shape

- **The host, `runtime/metal_host.c`** (`__garnet_metal`, included at the end
  of `ts_rt.c` after `node_host.c`), is plain C over the Objective-C runtime.
  `Metal.framework` is loaded with `dlopen` on the first use and every method
  is an `objc_msgSend` through a function pointer cast to the method's C
  signature (the arm64 ABI passes `MTLSize`, 24 bytes, indirectly, and a cast
  call site emits exactly that). So the runtime stays one C translation unit,
  no framework is named at link time, the dozen build scripts that compile
  `ts_rt.c` are untouched, a program that does not use the module loads
  nothing, and a build on another platform answers `available()` false.
- **Memory is the program's.** A `GpuBuffer` is a `SharedArrayBuffer`: its
  store is an `mmap` of whole pages (docs/fork_workers_design.md), which is
  what `newBufferWithBytesNoCopy:length:options:deallocator:` requires
  (page-aligned, a multiple of the page size) and what unified memory makes
  free: the GPU reads and writes the bytes the program's typed arrays view,
  nothing is copied in either direction, and the results are in the
  `SharedArrayBuffer` once `wait()` returns. A plain `ArrayBuffer` is refused
  with a `TypeError` (its `calloc` store has no alignment to promise). The
  `GpuBuffer` object keeps the `SharedArrayBuffer` reachable, so the GC cannot
  unmap pages a command buffer may still read.
- **Kernels are source.** `new Library(msl)` compiles Metal Shading Language
  text at run time (`newLibraryWithSource:options:error:`); the compiler's
  log is the thrown `Error`'s message. `fastMath` is off unless asked for
  (`MTLMathModeSafe`), so a kernel's arithmetic is not reassociated or
  contracted behind the program's back. `library.pipeline(name)` is a compute
  pipeline state; `maxThreadsPerThreadgroup` and `threadExecutionWidth` are
  read once.
- **One command buffer, many dispatches.** `new CommandBuffer()` opens a
  command buffer with a serial compute encoder (each dispatch sees the
  previous one's writes); `pipeline`, `buffer(index, gpuBuffer, byteOffset)`,
  `bytes(index, view)` (an argument struct, at most 4 KB, copied at encode
  time) and `dispatch(threadgroups, threadsPerThreadgroup)` (or `dispatch3`)
  mirror the encoder, so a forward pass of two hundred kernels is encoded in
  a loop of host calls with no per-dispatch allocation; `commit()` ends the
  encoding and submits; `wait()` blocks until completion and throws if the
  GPU reported an error; `discard()` drops an open command buffer. One
  command buffer is open at a time; the autorelease pool is pushed at `begin`
  and popped at `wait` or `discard`.
- **Loud failures.** A wrong argument type is a `TypeError` before any Metal
  call; an argument struct over 4 KB, a buffer index past 30, an offset past
  the buffer, zero threadgroups or more threads than the pipeline allows are
  `RangeError`s (Metal would otherwise fault or read garbage silently); a
  compile failure, a missing kernel, a use of the module where Metal is not
  available and a failed command buffer are `Error`s with the system's
  message.

## The oracle

Node has no Metal. `garnet:metal` resolves under Node to
`lib/garnet/metal_node.ts` (scripts/garnet_scheme_loader.mjs): `available()`
is false, `deviceName()` is empty, and a `Library`, a `GpuBuffer` or a
`CommandBuffer` throws the same `Error` after the same argument checks as
the binding. A program therefore branches on `available()` and computes on
the CPU otherwise; the conformance fixture
`modules/metal_compute` runs its kernels on the GPU under garnet and the same
arithmetic in TypeScript under Node, on inputs whose float32 results are
exact, and prints the values, which must agree byte for byte as every
fixture's output must. Kernels whose results depend on the accumulation
order (a dot product of real data) are compared within a tolerance by the
program that uses them, as the LLM program does for its GPU path.

## Gates

Kind A change (runtime, a library, a fixture; the generated C is unchanged):
conformance in the three modes, unit, bundler, bench within budget (the
host's code is cold; the instruction count of the compiler must not move),
GC stress. The fixture is the module's regression test; the LLM program's
`--check-gpu` is the kernels' (docs/llm_inference_design.md).

## As built (2026-10-27)

`runtime/metal_host.c` (350 lines of C), `lib/garnet/metal.ts`,
`lib/garnet/metal_node.ts`, the fixture
`tests/conformance/exhaustive/modules/metal_compute.ts` (two kernels over
SharedArrayBuffers, one bound at a byte offset, an argument struct as an
ArrayBuffer and as a typed array, `dispatch3`, every error path by kind).
Measured on the M5 (macOS 26.5, Metal 4): the first `available()` loads the
framework and creates the device in 23 ms; a library of one kernel compiles
and its pipeline builds in 36 ms; encoding costs 0.2 us per dispatch from
TypeScript (220 dispatches in 0.05 ms); the GPU runs a trivial dispatch in
about 5 us, so 220 of them take 1.1 ms; a command buffer's round trip
(begin, one dispatch, commit, wait) is 0.33 ms; a kernel that streams the
1.17 GB model file reads it at 124 GB/s after the first pass (the first
pass, which maps the pages for the GPU, at 56 GB/s). The first use of the
module is `garnet:llama_metal` (docs/llm_inference_design.md, milestone 3).
