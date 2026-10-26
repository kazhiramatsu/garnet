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

Where the single-thread time goes (a `sample` of the native run): 97% in
the Q8_0 kernel, the rest in the activation quantization, `exp`, softmax
and rmsnorm. In the kernel the 17-instruction `sdot` loop (16 weights of
four rows per iteration) is the smaller part of each block: the prefix
loop's clamps (five views, four of them at offsets that move 34 bytes per
block) and the scale code around it are the larger. The scale code shrank
first: a block's scale was two bytes of the weight (each load bounds-checked)
and an entry of the 65,536-entry f16 table; the weight now carries `scales`,
each block's scale as a float, one pass at load (4 bytes per 32 weights,
137 MB for TinyLlama), and the kernel reads one float per block per row:
11.7 -> 14.8 tokens/s on one thread. The clamps are next: the inner loop's
bound checks hoisted out of the block loop through the offsets' induction
variables, in the emitter.

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
| 1 | 14.8 | 3.3 |
| 2 | 26.2 | 6.4 |
| 4 | 43.4 | 11.1 |

(With the block scales precomputed as floats; before that 11.0, 20.1 and
33.4 on one, two and four threads.)

Against llama.cpp on the same machine and model (build c6fb3b5, CPU only
with `-ngl 0`, `llama-bench -t 1,2,4 -p 51 -n 32`; Kaz ran it, 2026-10-26):

| threads | garnet tg | llama.cpp tg | garnet pp | llama.cpp pp |
|---|---|---|---|---|
| 1 | 14.8 | 65.3 | 14.5 | 157 |
| 2 | 26.2 | 72.6 | 25.3 | 312 |
| 4 | 43.4 | 72.3 | 43.3 | 524 |

Two readings. llama.cpp's generation is bound by memory bandwidth from one
thread on: 1.1 GB of weights per token at about 75 GB/s is 65-72 tokens/s
whatever the thread count, and that is the ceiling for Q8_0 on this CPU;
garnet is compute-bound (the per-block overhead above), 4.4x behind on one
thread and 1.7x on four. Its prompt processing runs the prompt one token at
a time, so it equals the generation rate; llama.cpp batches the prompt into
one matrix product that Accelerate (the AMX units) computes, 10x faster
still, and a batched prefill in garnet would need the matrix kernel to be
competitive first. The path to the ceiling: the clamps (the range flags
below), then the per-row scale math as vector lanes.

Row distribution, second version. The first pool split the rows statically,
`rows / n` per thread in blocks of four, which falls apart past the four
performance cores: an efficiency core at a third of the speed holds every
job (37 tokens/s on six threads, 40 on eight, 22 on ten). The rows now come
from a shared cursor in the control words with guided grabs: a thread takes
the remaining rows divided by about twice the thread count, never below 16,
through `Atomics.compareExchange`, so the first grabs are large and the
contended grabs few (a fixed block of 16 rows cost 20% on two threads, about
265 ns per grab: the atomic's cache line moving between cores and the
kernel's entry) and the last ones small enough that a slow core does not
hold the others. Measured, 32 generated tokens, outputs identical:

| threads | static | guided |
|---|---|---|
| 1 | 22.4 | 22.4 |
| 2 | 40.2 | 39.8 |
| 4 | 54.1 | 54.1 |
| 6 | 37.2 | 50.6 |
| 8 | 40.0 | 57.1 |
| 10 | 22.0 | 40.4 |

Eight threads (the four performance and four efficiency cores) are the
useful count; ten leave no core to the system and to the main thread's
serial work.

Where the time goes with the threads (`--stats`: the main thread's time per
pooled product, 152 products per token, the kernel of the loop-versioning
slice at 24.6 tokens/s on one thread):

| threads | own share | wait | prep + copy out | in products | tokens/s |
|---|---|---|---|---|---|
| 2 | 133.5 us | 0.6 us | 3.5 us | 90% | 42.9 |
| 4 | 101.9 us | 0.9 us | 3.5 us | 87% | 53.5 |
| 8 | 77.6 us | 13.4 us | 5.2 us | 79% | 58.5 |

A product moves 7.2 MB of weights: 70 GB/s during the products on four
threads, 79 GB/s on eight, which is what llama.cpp sustains over the whole
token (72 tokens/s = 79 GB/s). So the products are at the memory ceiling on
eight threads; the gap is outside them: the main thread's serial work
between products (the attention over the cache, the norms, rope, the
residual adds, the sampling) takes 21% of the time on eight threads where it
took 3% on one, and the wait for the slowest worker's last grab 13 us per
product. The next levers, in order: the attention split over the heads as
a second kind of pooled job; the q/k/v products fused into one job (the
w1/w3 pair is, below). A QoS class for the main thread (the hypothesis that
it was scheduled onto an efficiency core beside seven spinning workers) was
measured through a `setThreadQos` host call, `pthread_set_qos_class_self_np`,
and changed nothing (interactive, initiated and none within the noise on
four and eight threads), so it is not in. Reading fewer bytes per
token (Q4_0, half the weights) raises the ceiling itself. A one-row kernel
(one weight stream per thread) measured worse at every thread count (15.8 /
47.2 / 52.5 on 1 / 4 / 8), so the four-row kernel stays.

Two of the serial parts are gone since. RoPE's angles come from tables
computed once (doubles, the forward pass's own expressions, so the outputs
stay identical): 2048 trigonometric calls per layer and token were about a
millisecond beside the threads. And the feed-forward gate and up products
with the SiLU between them are one pooled job, `out[r] = silu(w1[r] . x) *
(w3[r] . x)` per row block from the two products in per-thread scratch: 22
fewer barriers per token and no serial pass over the 5632-wide hidden
vector. The block scales table is interleaved by four rows (the four-row
kernel reads a block's four scales adjacently; neutral alone, the layout a
vector form of the scale arithmetic wants). 1 / 2 / 4 / 8 threads: 24.7 /
42.1 / 55.0 / 61.8 tokens/s (before 24.6 / 42.8 / 52.9 / 57.2). Smaller
minimum grabs (8, 4) and a steeper guided divisor (4n) measured worse on
eight threads; 16 rows and 2n stay.

The attention and the q/k/v products followed. The run state the attention
reads and writes (q, the key and value caches, att, xb) lives in shared
memory (`LlamaState`, SharedArrayBuffers the model allocates; a Node worker
builds its model over the main thread's buffers, garnet's fork inherits
them), so the attention of a layer is a pooled job over its heads (one head
per grab at the smallest), and the q, k and v products of a layer are one
job over their rows laid end to end (the kernels take an output offset),
the main thread copying k and v into the caches at the position. 110 jobs
per token instead of 152. Native, 32 generated tokens, outputs identical to
Node in every configuration:

| threads | 1 | 2 | 4 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|
| tokens/s | 24.0 | 43.7 | 59.7 | 63.7 | 63.9 | 71.9 | 68.8 | 48.0 |

Eight threads reach llama.cpp's 72 on four. What is left on eight threads
is the wait for the slowest worker's last grab, 13-20 us per job (about 2 ms
of a 14 ms token; the smallest grab is now one kernel pass of four rows,
measured against 8 and 16 within the noise, 72-75 tokens/s, with the
smallest wait), and the per-job preparation (6 us: the activation quantized
and copied); the products themselves run at the memory ceiling. The prompt
(56 tokens/s, one token at a time) stays an order of magnitude behind
llama.cpp's batched prefill.

## Milestone 3: the GPU through Metal (planned, Kaz 2026-10-26)

llama.cpp's GPU path on macOS is Metal (`ggml-metal`: MSL kernels embedded
in the binary, the weights shared through unified memory, simdgroup matrix
products, and on the M5 the Metal 4 tensor API for the GPU's neural
accelerators); on this machine it generates far beyond the CPU's bandwidth
ceiling. The plan: a `garnet:metal` module over a host object
`__garnet_metal` in the runtime (Objective-C, Metal.framework), with the
device and a command queue, buffers over the model's pages without a copy
(`newBufferWithBytesNoCopy` on page-aligned memory: the loader aligns the
tensor data or maps the file), a library of MSL kernels compiled at startup
(the Q8_0 and Q4_0 matrix-vector products with the block scales, a matrix
product for the prefill, rmsnorm, softmax and rope so a layer runs without
a round trip), and an encoder API so the TypeScript side batches a whole
forward pass into one command buffer (one commit and one wait per token, as
llama.cpp's graph does). The TypeScript program keeps the model, the KV
cache and the sampling; only the kernels move. The oracle changes with it:
the GPU's float accumulation is not in Node's order, so the differential
test of the GPU path compares the greedy tokens and the logits within a
tolerance, not bytes, while the CPU path keeps the byte-identical test. The
target is llama.cpp's Metal numbers on the same model (`llama-bench`
without `-ngl 0`), after the CPU path reaches its bandwidth ceiling with
the threads.

## Beyond

Native kernels (NEON intrinsics, Accelerate) behind a host object as
`garnet:json` has one, if the vectorized TypeScript kernels stop short of
llama.cpp on the CPU; `garnet:nn` once the model code has a stable shape.
