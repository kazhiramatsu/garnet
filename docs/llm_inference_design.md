# LLM inference in garnet: llama2.c, then llama.cpp's GGUF

Session 353. Kaz asked whether a transformer could be made fast and then
whether a llama.cpp model could run; the scope is inference, the target model
TinyLlama-1.1B-Chat Q8_0. Three milestones, all done: the fp32 llama2.c
port, the GGUF model on the CPU (one thread, then a thread pool), and the
same model on the GPU through Metal.

## The modules (2026-10-27)

Kaz asked for the inference code to be a garnet module rather than a
benchmark. It is three:

- **`garnet:llama`** (`lib/garnet/llama.ts`): the GGUF reader (`readGguf`,
  `parseGguf`), the `Model` and its `Weight`s, the `Llama` forward pass, the
  `Tokenizer`, the `Sampler`, and the thread pool (`startPool(n, llama,
  path)`, `stopPool`, `setPool`, `setSharedModel`, `workerLoop`; the
  worker's entry is `llama_worker.ts`, named as `./llama_worker.ts` so the
  exporter and Node's loader resolve the same file). `readGguf(path, true)`
  reads the file into a `SharedArrayBuffer` (64 MB reads into the mapped
  pages): the GPU reads it in place, and a Node worker builds its model over
  the same bytes instead of reading the file again. The run state (the
  activations, the KV cache, the logits) is `SharedArrayBuffer`s throughout,
  so the pooled jobs and the GPU share it without copies; `llama.gpu` is the
  device that runs `forward` when set.
- **`garnet:metal`** (`docs/metal_design.md`): the general-purpose Metal
  compute module, nothing in it about language models.
- **`garnet:llama_metal`** (`lib/garnet/llama_metal.ts`): `new
  LlamaMetal(llama)`, the forward pass on the GPU, assigned as `llama.gpu`.
  It does not import `garnet:llama`'s pool and `garnet:llama` does not
  import it (no module cycle); the program wires the two.

`benchmarks/llama2/llama_gguf.ts` is the program over them (`-j threads`,
`--gpu`, `--check-gpu`, `--fast-math`, `--stats`), and
`benchmarks/llama2/run_gguf.sh` the differential test: the CPU path's text
against Node byte for byte (Node runs the modules through
`scripts/garnet_scheme_loader.mjs`, its workers included), and with `gpu` as
the thread count the GPU's logits against the CPU's over the prompt and its
text against the CPU path's.

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
(the four-row kernel), and the main spins on `C_DONE`. The program was split
in three modules for this: the core (reader, model, kernels, pool; since
the module move `lib/garnet/llama.ts`, "The modules" above), `llama_gguf.ts`
(the program) and the worker entry (`lib/garnet/llama_worker.ts`, `new
Worker(new URL("./llama_worker.ts", import.meta.url))`), because the
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

## Milestone 3: the GPU through Metal (done, 2026-10-27)

llama.cpp's GPU path on macOS is Metal (`ggml-metal`: MSL kernels embedded
in the binary, the weights shared through unified memory, simdgroup matrix
products, and on the M5 the Metal 4 tensor API for the GPU's neural
accelerators); on this machine it generates far beyond the CPU's bandwidth
ceiling. garnet's is `garnet:llama_metal` over `garnet:metal`
(`docs/metal_design.md`): the model's `SharedArrayBuffer` and the run state
are GPU buffers without a copy, and a token is one command buffer of 222
kernels (ten per layer, then the final norm and the vocabulary product),
one commit and one wait, as llama.cpp's graph does. Per layer: RMSNorm; the
q, k and v products (k and v straight into the caches at the position); RoPE
on q and k; the attention over the heads (a threadgroup of 256 threads per
head: the scores, the softmax by two threadgroup reductions, the weighted
values); the output product added to the residual; RMSNorm; the gate and up
products with SiLU as one kernel; the down product added to the residual.
The token's embedding is written by the CPU before the commit and the
sampling reads the logits after the wait; the TypeScript program keeps the
model, the KV cache and the sampling, as planned.

The products read the quantized rows as llama.cpp's Metal kernels do: a
SIMD group per two rows (four SIMD groups per threadgroup), each lane a
quarter of every eighth block (8 int8 weights and the block's f16 scale),
the int8 or nibble weights times the float activation (no int8 quantization
of the activation on the GPU, which is the main difference from the CPU
path's arithmetic), the block scale per block, `simd_sum` at the end; the
kernels take the weight's byte offset in the model buffer and an output
offset as arguments, so one buffer binding serves every product. Fast math
is off: the kernels' arithmetic is the text's. Measured on the M5 (32
generated tokens, `--stats`):

| path | tokens/s | per token |
|---|---|---|
| CPU, 1 thread | 24.7 | |
| CPU, 8 threads | 72.6 | |
| GPU | 101-106 | encode 0.05 ms, wait 9.9-10.0 ms |
| llama.cpp CPU, 4 threads (Kaz, 2026-10-26) | 72.3 | |
| llama.cpp Metal, `llama-bench -t 6,8,10 -p 51 -n 32` (Kaz, 2026-10-27) | 103.6 / 103.3 / 99.0 | |

The GPU's 10 ms per token is the weights' 1.1 GB at 117 GB/s: a probe that
dispatches only a token's 133 products runs them in 9.4 ms (117 GB/s), and a
plain streaming read of the model file by the GPU reaches 124 GB/s, so the
product kernels are at 94% of the device's read bandwidth and the other 89
kernels and the round trip cost 0.6 ms. The threadgroup geometry (2 or 4 rows
per SIMD group, 2, 4 or 8 SIMD groups per threadgroup) measured within the
noise. Generation is at llama.cpp's Metal rate on this model (its `tg32` 103.6
tokens/s on the same machine, Kaz's run of `build/llama.cpp/build/bin/
llama-bench`, build c6fb3b5): both read the 1.1 GB of weights per token at
the device's bandwidth. The prompt was the gap: one token at a time (102
tokens/s) against llama.cpp's batched `pp51` of 2092; the batched prefill
below closes it.

The oracle: the GPU's float32 arithmetic is not the CPU's (float32 in the
GPU's order against int8 activations and double block sums), so the
differential test of the GPU path is `--check-gpu`: the prompt on the CPU,
then on the GPU, the argmax compared per position and the last logits
within a tolerance. TinyLlama's 51-token prompt: the argmax agrees at 51 of
51 positions, the last logits differ by at most 0.25 over a logit range of
16.6, the next token is the same, and the 32 generated tokens are the same
text as the CPU path's. The CPU path keeps its byte-identical test against
Node.

## Batched prefill (done, 2026-10-27)

Kaz: "プロンプトをまずは高速化してください". The prompt's tokens now run as one
batch on the GPU, `Llama.forwardBatch(tokens, pos0)` (the `Forward` device
interface has it; the CPU path runs the tokens one at a time inside it, the
same arithmetic as before, so the Node differential test is unchanged). In
`garnet:llama_metal` the tokens' activations are rows of batch buffers
(`x`, `xb`, `q` of n x d, the gate and up products of n x ff, a row's
attention scores per head of n x heads x ctx, grown as needed, at most
`BATCH_MAX` 128 tokens per command buffer; a longer prompt goes in chunks),
the norms, RoPE and the attention are the single-token kernels with a row
index (the attention's grid is heads x rows, each row attending to the
positions up to its own), the k and v rows land in the caches at their
positions, SiLU is an elementwise kernel between the gate and up products
and the down product, and the last token's logits come from the
single-token norm and vocabulary kernels over its row. Every product is a
matrix product over the weights dequantized to halves in threadgroup memory,
so the 1.1 GB of weights is read once per tile of tokens instead of once per
token. Two kernel families, both the shape of llama.cpp's `mul_mm`:

- **simdgroup matrices** (`matmul_q8/q4/f16/f32`, any Apple GPU): a
  threadgroup of four SIMD groups computes a tile of 64 weight rows by 32
  tokens, each step of 32 columns staged as 8x8 half blocks ([k][row] for
  the weights, [token][k] for the activations, which are converted to half),
  each SIMD group multiplying its 32 rows by 16 tokens with
  `simdgroup_multiply_accumulate` into eight float 8x8 accumulators, the
  result tile staged through the same 8 KB of threadgroup memory and
  written with the row and token bounds (a row or token past the tile's
  valid ones reads the last valid one and is never stored).
- **the Metal 4 tensor API** (`matmul_*_t32`, `matmul_*_t64`; a second
  library compiled at language version "4.0", so `garnet:metal`'s
  `Library` takes `languageVersion`; where it does not compile, an older
  device or OS, the simdgroup kernels stay; `--no-tensor` forces them): the
  M5's neural accelerators through `mpp::tensor_ops::matmul2d` over a tile
  of 64 rows by 32 tokens (a batch of at most 32) or 64, the step's weights
  as halves [row][k] in 4 KB of threadgroup memory, the float activation
  tile read by the operation itself from device memory, the accumulator a
  cooperative tensor zeroed per element (or loaded from the output for the
  residual adds, the `multiply_accumulate` mode) and stored with the tile's
  bounds. `relaxed_precision` on: measured 2.2x faster than the exact
  setting on the M5 (48 -> 21.6 ms for the products of 51 tokens), the
  logits unchanged within the check (llama.cpp's choice too). Measured
  against tiles of 16 and 128 tokens over 8 to 200 tokens: 32 and 64 are
  the useful ones (a 128-token tile is 1.5x slower at 51 and 64 tokens).

The command buffers are concurrent (`new CommandBuffer({ concurrent: true })`
and `barrier()`, new in `garnet:metal`): q, k and v, then the gate and up
pair, overlap, a barrier precedes each dependent group; 48.5 -> 44.6 ms for
the simdgroup batch of 51 tokens (the k and v products have four
threadgroups each and were latency-bound alone), nothing measurable on the
single-token path. The GPU's first access to a page maps it (the model at
half the streaming rate), so the constructor touches the model and the
caches with a kernel (one word per page) instead of the first token paying
it.

Where the time went before the tensor kernels (a probe of the products
alone, serial, 51 tokens: 47.4 of the batch's 48.3 ms): the attention
products 11.7 ms, the feed-forward 33.4, the vocabulary 2.7; compute-bound
at about 3 TFLOP/s in the large products (a 32-token tile costs 19 ms of
compute, so 51 tokens cost two tiles), latency-bound in the small ones (the
k and v products run four threadgroups, the down product 32).

Measured on the quiet M5, TinyLlama-1.1B-Chat Q8_0, the 51-token prompt,
after the check's warm-up (the GPU's clocks: the same batch runs 30 ms from
cold, 20 after a second of GPU work; llama-bench warms up too):

| prompt path | ms | tokens/s |
|---|---|---|
| one token at a time (before) | 505 | 101 |
| simdgroup kernels, serial command buffer | 48.5 | 1051 |
| simdgroup kernels, concurrent | 44.6 | 1143 |
| tensor API, exact precision | 45.2 | 1129 |
| tensor API, relaxed precision, 32/64-token tiles | 20.2 | 2525 |
| llama.cpp Metal, `GGML_METAL_TENSOR_DISABLE=1` (simdgroup) | | 1275 |
| llama.cpp Metal, tensor API (default on the M5) | | 2098 |

The products alone for 51 tokens take 21.5 ms of the 20-ish ms batch on the
tensor path (the probe's serial encoder against the batch's concurrent one),
so the rest of the batch costs nothing measurable; the floor is the weights
read once (9.4 ms: an 8-token batch runs its products in 16.4 ms, 489
tokens/s, 4.8x the one-at-a-time path). Generation is unchanged (100-101
tokens/s). The check (`--check-gpu`, `run_gguf.sh gpu`) now runs the prompt
on the CPU, on the GPU one token at a time and as a batch (`forwardBatchAll`:
every token's logits through the batched vocabulary product), each pass
against the CPU's argmax per position and last logits: 51/51 and 0.25 for
both, the generated text identical to the CPU path's. The kernels' exact
test is the conformance fixture `modules/llama_metal_matmul` (the four
simdgroup kernels, both tensor tiles and the accumulating form over
synthetic weights in the GGUF block layouts whose values keep the half and
float arithmetic exact, the small-valued ones for the tensor kernels'
relaxed precision; the GPU under garnet, TypeScript under Node, identical
output), and `modules/metal_compute` has the concurrent command buffer.

Over prompt lengths the picture is not a win (Kaz doubted a win over
llama.cpp's tuned kernels, rightly; the same machine and model, llama-bench
`-p 8,...,512` against a repeated text cut to n tokens, one warm-up batch
then the best of three):

| tokens | garnet tok/s | llama.cpp Metal tok/s |
|---|---|---|
| 8 | 594 | 724 |
| 16 | 1138 | 1207 |
| 32 | 2146 | 1392 |
| 51 | 2634 | 2111 |
| 64 | 3166 | 2612 |
| 128 | 3519 | 4466 |
| 256 | 3142 | 4786 |
| 512 | 2572 | 4802 |

The hot path is GPU kernel against GPU kernel (the TypeScript-compiled host
code only encodes commands); garnet's kernel is a transcription of
llama.cpp's with a different tile parameter. It wins only between 32 and 64
tokens, where llama.cpp's 128-token tile computes a half-empty tile and
garnet's 64-token tile is full: a configuration fit, not a better kernel.
Below that llama.cpp's small-batch kernels (`mul_mv_ext`) are leaner, and
from 128 tokens its kernel reaches about 10.5 TFLOP/s against garnet's 7.7
at 128 and 5.5 at 512.

Where the 199 ms of a 512-token prompt went, each kernel timed alone (one
warm-up, the best of four): the products 128 ms (four 128-token chunks of 32
ms; 118 as one chunk), the attention 79 ms (6.1 ms for the first chunk,
33.6 for the last), the norms, RoPE and SiLU 7 ms. The attention kernel
was the per-row one: a threadgroup per (head, query row) re-reading the
whole key and value prefix, about 47 GB over the 22 layers at 512 tokens
(five times the weights), with 64 of its 256 threads walking the positions
serially in the value sum; at 51 tokens its 4.3 ms (a fifth of the batch)
was the launch of 36k small threadgroups.

**Flash attention for the batch** (`attention_batch_64`, `_128`, the shape
of llama.cpp's `kernel_flash_attn_ext`): a threadgroup of four SIMD groups
per (kv head, tile of 32 / kvMul rows) holds the 32 queries of those rows'
heads that share the kv head (scaled, as simdgroup matrices, 8 per SIMD
group) and walks the cache in blocks of 32 positions (16 for a head size
of 128) staged once in threadgroup memory for all 32 queries: S = Q K^T by
simdgroup matrix products (the K block loaded transposed), the online
softmax per query row (the running max and sum reduced over the row's four
lanes with `simd_shuffle_xor`, the causal mask as -inf, the factors
exp(m_old - m_new) written to a diagonal matrix), the output accumulators
rescaled by that diagonal matrix (`simdgroup_multiply`) and accumulated
with P V, the rows normalized by 1/l at the end and written through
threadgroup memory. Float throughout (21 KB of threadgroup memory for a
head size of 64). The per-row kernel stays for the single-token path and
for shapes the flash kernel does not take (a head size other than 64 or
128, a query-head count per kv head that does not divide 32). Measured,
the same machine and run (the check: 51/51, 0.245, text identical):

| tokens | before (per-row) tok/s | flash attention tok/s | llama.cpp Metal |
|---|---|---|---|
| 51 | 2634 | 2706 | 2111 |
| 128 | 3519 | 3970 | 4466 |
| 256 | 3142 | 3891 | 4786 |
| 512 | 2572 | 3759 | 4802 |

The product kernel against llama.cpp's, isolated. llama.cpp's
`test-backend-ops perf -o MUL_MAT` (built from Kaz's checkout) times one
Q8_0 x F32 product of 4096 x 14336 by 512 tokens at 6.35 ms, 9.47 TFLOP/s
(its small-batch kernel at 8 tokens: 1.46 TFLOP/s, 91 GB/s of weights).
garnet's tensor kernel on the same bytes: the 64-token tile 8.98 ms, 6.69
TFLOP/s; the 128-token tile 6.63 ms, 9.07 TFLOP/s (sustained over 60 runs:
the clocks are not the difference); K steps of 64, 32-row tiles and
llama.cpp's packed int8 loads measured no better; with the weight loads
replaced by constants the 128-token tile runs 11.1 TFLOP/s, so the
dequantize costs 18%, as in llama.cpp. On TinyLlama's own products the
128-token tile had looked only marginally better (113 against 118 ms for
512 tokens) because its matrices are small (2048 rows: 32 row tiles) and
short (64 steps): the tile's gain shows on large products. The batch now
picks the smallest tile that holds it (32, 64 or 128 tokens), and with the
flash attention kernel a chunk is 512 tokens (`BATCH_MAX`; 128 with the
per-row kernel, whose scores scratch grows with the chunk).

The other kernels at 512 tokens in one chunk: the flash attention 9.7 ms
(10.9 as four chunks of 128: 1.1, 2.2, 3.3, 4.4), the norms, RoPE and
SiLU 10.3 ms (bandwidth: the activations of 512 tokens are 4 to 11 MB per
pass, about 60 MB per layer). Measured over prompt lengths after the
128-token tile and the 512-token chunks (the check 51/51, 0.245, text
identical):

| tokens | garnet tok/s | llama.cpp Metal | ratio |
|---|---|---|---|
| 51 | 2778 | 2111 | 1.32 |
| 64 | 3423 | 2612 | 1.31 |
| 128 | 4019 | 4466 | 0.90 |
| 256 | 4270 | 4786 | 0.89 |
| 512 | 4178 | 4802 | 0.87 |

What remains at 512 tokens (122 ms against 107): the products are at
llama.cpp's rate (about 106 ms); the rest is the small kernels (10 ms) and
the attention (9.7 ms; llama.cpp's tensor-API flash attention is faster
still). Measured and dropped: the gate and up products as one tensor
kernel with two cooperative accumulators and SiLU in the epilogue (the up
product never written, no SiLU pass): slower at every length (512 tokens
122 -> 128 ms, 51 tokens 18.4 -> 20.5), because the fused kernel has only
the 32 and 64-token tiles (two accumulators of a 128-token tile would
double the registers again), the two products no longer overlap as
independent dispatches, and the two dequantizes sit between the same
barriers. Open: the dispatch count for 8 to 16-token prompts (264 dispatches with
barriers per batch; llama.cpp's small-batch kernels lead there, 724 against
571 tok/s at 8).

**The attention on the tensor API** (`attention_tensor_64`, `_128`, in the
tensor library; Kaz chose it as the next step). The shape of llama.cpp's
`kernel_flash_attn_ext_tensor`: a threadgroup of eight SIMD groups per (kv
head, 32 / kvMul rows) holds the 32 queries as halves in threadgroup memory
(scaled) and walks the cache in blocks of 64 positions that the operations
read themselves from the float caches (the context length is a multiple of
64, so a block never leaves the layer's cache; the positions past the batch
are masked): S = Q K^T by `matmul2d` into a threadgroup float tensor; the
online softmax per row with a SIMD group per four rows and two columns per
lane (`simd_max`, `simd_sum`), the causal mask as -inf, the running max
moved only when it grows by more than 8 (so exp(s - M) stays within half
and O is rescaled rarely, a threadgroup flag saying when), P as halves; O
+= P V into a cooperative tensor, rescaled through its elements
(`get_multidimensional_index(i)[1]` is the query row); the rows normalized
by 1/S and written to xb through threadgroup memory. The barrier after P V
is dropped (the next Q K^T writes the scores, not the probabilities, and
every SIMD group enters it after its own P V). It is the batch's attention
where the tensor library compiled; the simdgroup flash kernel stays as the
fallback. The check: 51/51, 0.243 (0.245 with the simdgroup kernel).

Measured alone (22 layers, one chunk, the best of four after a warm-up):

| tokens | simdgroup flash ms | tensor flash ms |
|---|---|---|
| 51 | 1.1 | 0.55 |
| 128 | 1.1 | 1.25 |
| 512 | 9.7 | 9.7 |
| 1024 | 35.8 | 33.2 |
| 2048 | 138 | 124 |

So the tensor operations do not change the picture at 512 tokens: the
attention is latency-bound, not compute-bound (a layer's 64 threadgroups
each walk their blocks serially through three phases and barriers; the
matrix products of a block are microseconds). Measured and dropped: 16
queries per threadgroup (twice the threadgroups: no faster, 3% slower at
2048), and the barrier count was the only knob that moved it (1-2%). The
batch at 512 tokens stays at 122 ms (4197 tok/s); at 51 tokens 18.4
(2773). What would move the attention is overlapping a block's cache reads
with the previous block's arithmetic (a double-buffered half copy of K and
V in threadgroup memory) or splitting the positions over threadgroups with
a combining pass; at 512 tokens that is at most 5% of the batch.

## Beyond

Native kernels (NEON intrinsics, Accelerate) behind a host object as
`garnet:json` has one, if the vectorized TypeScript kernels stop short of
llama.cpp on the CPU; `garnet:nn` once the model code has a stable shape.
