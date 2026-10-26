# LLM inference in garnet: llama2.c, then llama.cpp's GGUF

Session 353. Kaz asked whether a transformer could be made fast and then
whether a llama.cpp model could run; the scope is inference, the target model
TinyLlama-1.1B-Chat Q8_0. Two milestones, the first done.

## Milestone 1: llama2.c in TypeScript (done)

`benchmarks/llama2/llama2.ts` is a port of Andrej Karpathy's `run.c` (MIT):
the fp32 checkpoints of the tinyllamas (`stories15M`, `stories42M`,
`stories110M`) and their `tokenizer.bin`. The arithmetic is JavaScript's
double over `Float32Array` storage (llama2.c computes in float, so the two do
not agree bit for bit; the oracle is Node running the same program), argmax
sampling unless a temperature is given, the SentencePiece-style BPE of
`run.c` (dummy prefix space, code points, byte fallback, best-score merges).
`benchmarks/llama2/run.sh` fetches the model, builds the program with
`garnet`, transpiles it for node, generates the same story both ways and
compares the outputs byte for byte: identical, 732 bytes for 200 tokens of
`stories15M`; native 132 tokens/s against Node's 95 (the first build), with
the matrix-vector kernel as a plain `s += w[row + j] * x[j]` loop.

What the port taught the compiler (both fixed in the slices that followed):
the prefix loop had to take offset indices and double bounds (the first
build of this port is where `o[ro + j]` mattered), then constant steps: the
four-accumulator form of the dot product (`j += 4`, four partial sums, the
additions in a fixed order so Node computes the same values) made Node 35%
faster and garnet 2.3x slower until `i += c` qualified. A floating-point
reduction is never reassociated by the C compiler (and must not be, for the
bit-exact comparison with V8), so a matrix-vector product's ceiling in pure
TypeScript is the latency-hidden scalar chain, 4-8 GFLOP/s on this machine;
the matrix products of `garnet:ndarray` vectorize (17.8 GFLOP/s) because
their inner loop is not a reduction. `Date.now()` returned fractional
milliseconds (a printed elapsed time showed it); fixed.

## Milestone 2: GGUF and the quantized model (Q8_0 done)

`benchmarks/llama2/llama_gguf.ts` reads the file and runs TinyLlama-1.1B-Chat
Q8_0; garnet and Node give the same answer to the same prompt. Speed so far:
0.6 tokens/s with the double chain, 4.1 after the numeric analysis learned
the int8 ranges and the absorbed negative zero (Node 2.2); the next step is
the int32 emission of the chain so the C compiler vectorizes it.

The format (GGUF v3, little endian): magic `GGUF`, u32 version, u64 tensor
count, u64 key-value count; the key-value pairs (a string key, a u32 type,
the value: u8/i8/u16/i16/u32/i32/f32/bool/string/array/u64/i64/f64, an
array as a type, a u64 count and the elements); the tensor infos (name, u32
dimension count, u64 dims innermost first, u32 ggml type, u64 offset into
the data section); the data section at the first multiple of
`general.alignment` (32) after the header. The u64 fields hold values far
below 2^53 and are read as two u32 words into a double; no bigint.

The quantized types TinyLlama Q8_0 uses: `Q8_0`, blocks of 32 values as an
f16 scale and 32 int8 (34 bytes), value = scale * q; `F32` for the norms.
`Q4_0` (an f16 scale and 32 nibbles, value = scale * (nibble - 8), 18
bytes) and `F16` come next for the other common quantizations; the K-quants
later. The f16 scales decode through a 65,536-entry table built once from
the half decoder of `garnet:ndarray`.

The model (`llama` architecture): `llama.embedding_length` 2048,
`llama.block_count` 22, `llama.feed_forward_length` 5632,
`llama.attention.head_count` 32, `llama.attention.head_count_kv` 4 (grouped
query attention, as llama2.c's `kv_mul`), `llama.attention.layer_norm_rms_epsilon`
1e-5, `llama.rope.freq_base` 10000, `llama.context_length` 2048; tensors
`token_embd.weight`, `blk.N.attn_norm/attn_q/attn_k/attn_v/attn_output`,
`blk.N.ffn_norm/ffn_gate/ffn_up/ffn_down`, `output_norm.weight`,
`output.weight`. The converter permutes the q and k weights so the rotary
embedding is the adjacent-pair rotation of llama2.c. The tokenizer is in
the file: `tokenizer.ggml.tokens`, `scores`, `token_type` (1 normal, 2
unknown, 3 control, 6 byte), the bos and eos ids; the same BPE as milestone 1.
TinyLlama-Chat's prompt format is plain text (`<|user|>`, `<|assistant|>`
tokenized as pieces).

The kernel that decides the speed: a Q8_0 matrix-vector product the way
llama.cpp does it, the activation vector quantized to int8 per block of 32
with a float scale, the block dot product an integer sum of 32 int8
products (exact in int32), then `sum += scaleW * scaleX * isum`. An integer
reduction may be reassociated, so the C compiler can vectorize the inner
loop of an `Int8Array` prefix loop (NEON `smull`/`sadalp` or `sdot`), where
V8 cannot; that is the lever for llama.cpp-class speed without native code.
Memory: the Q8_0 file is 1.17 GB; `readFileSync` into a Buffer whose
ArrayBuffer is viewed in place (no copy), later a host `mmap`.

Sampling greedy for the differential test, temperature and top-p after;
a key/value cache of `context_length` positions per layer in Float32Array.

## Threads: fork workers over a SharedArrayBuffer (done)

`llama_gguf.ts -j N` splits every matrix-vector product of a forward pass
over N threads: the program itself and N-1 `node:worker_threads` workers.
Under garnet a worker is a fork of the loaded program (`docs/
node_compat_design.md`), so the model's 1.17 GB buffer is the parent's
pages, inherited without a copy or a second load; under Node the same
source starts real worker threads, each loading the model itself
(`llamaShared === null` in `workerLoop`), so the differential test covers
the threaded path too. The protocol is a `SharedArrayBuffer` of eight
control words: `C_GEN`, the job generation the workers spin on with
`Atomics.load` (no `Atomics.wait` in the runtime, and a spin is what the
microsecond-scale jobs want), `C_TENSOR`, `C_ROWS`, `C_COLS` and `C_KIND`
the job, `C_DONE` the count of finished workers (`Atomics.add`), `C_STOP`
and `C_WORKERS`. The quantized activation (`xq`, `xs`), the float activation
`xf` and the output vector live in shared buffers as well; the main thread
computes row range 0 itself, each worker its range in blocks of four rows
(the four-row kernel), and the main spins on `C_DONE`. The program is split
in three modules for this: `llama_core.ts` (reader, model, kernels, pool),
`llama_gguf.ts` (the program) and `llama_worker.ts` (the worker entry,
`new Worker(new URL("./llama_worker.mjs", import.meta.url))`), because the
exporter rejects a class method that captures an enclosing function's local
once the program is also a worker module.

Measured on the quiet M5 (TinyLlama-1.1B-Chat Q8_0, 32 generated tokens,
outputs identical to Node in every configuration; `benchmarks/llama2/
run_gguf.sh [threads]`):

| threads | garnet tok/s | Node tok/s |
|---|---|---|
| 1 | 11.0 | 3.3 |
| 2 | 20.1 | 6.2 |
| 4 | 33.4 | 10.2 |

The scaling is bounded by memory bandwidth (the Q8_0 weights are read once
per token: 1.1 GB per token) and by the synchronization of about 150 jobs per
token; the four performance cores are the useful count.

## Beyond

Native kernels (NEON intrinsics, Accelerate) behind a host object as
`garnet:json` has one, if the vectorized TypeScript kernels stop short of
llama.cpp; `garnet:nn` once the model code has a stable shape.
