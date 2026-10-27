// llama_gguf.ts: the program of docs/llm_inference_design.md: a llama.cpp GGUF model
// (TinyLlama-1.1B-Chat Q8_0) generating text over garnet:llama (lib/garnet/llama.ts: the reader,
// the model, the kernels, the thread pool, the tokenizer and the sampler) and, with --gpu, over
// garnet:llama_metal (the same model on the Metal device).
//
// Usage: llama_gguf <model.gguf> [-n steps] [-p "prompt"] [-t temperature] [-s seed] [--raw]
//                   [-j threads] [--gpu] [--check-gpu] [--fast-math] [--no-tensor] [--serial-prompt] [--stats]
//   The prompt is wrapped in TinyLlama-Chat's template unless --raw is given; -j N splits the
//   work over N threads (llama.ts); --gpu runs the forward passes on the GPU (--fast-math lets
//   the kernels reassociate), the prompt as one batch unless --serial-prompt asks for one token
//   at a time, its products on the Metal 4 tensor API where the device has it unless --no-tensor; --check-gpu first runs the prompt on the CPU and on the GPU, one token at a time
//   and as a batch, and prints how each agrees with the CPU (the argmax per position, the last
//   logits' largest difference; PASS when the argmax differs at no more than one position and
//   the logits within 3%); --stats prints the pool's per-job time split, or the GPU's encode and
//   wait times.
import { readGguf, Model, Llama, Tokenizer, Sampler, startPool, stopPool, setPool, setSharedModel, poolStats } from "garnet:llama";
import { LlamaMetal } from "garnet:llama_metal";
import { performance } from "node:perf_hooks";

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function argmax(v: Float32Array): number {
  let best = 0;
  for (let i = 1; i < v.length; i++) if (v[i] > v[best]) best = i;
  return best;
}
/** The verdict of a GPU pass over the prompt against the CPU's: the argmax agreement per position and the last logits' difference. */
function verdict(what: string, n: number, agree: number, maxAbs: number, maxLogit: number, cpuTop: number, gpuTop: number): boolean {
  // the argmax may differ where two logits are within the GPU's rounding (at most one position of
  // the prompt), and the last logits must agree within 3% of their range
  const ok = agree >= n - 1 && maxAbs <= 0.03 * maxLogit;
  process.stderr.write(`gpu check (${what}): argmax agrees at ${agree}/${n} prompt positions; last logits: max |gpu - cpu| ${maxAbs.toFixed(4)} over |logit| up to ${maxLogit.toFixed(2)}, next token cpu ${cpuTop} gpu ${gpuTop}: ${ok ? "PASS" : "FAIL"}\n`);
  return ok;
}
/** The prompt on the CPU, then on the GPU one token at a time and as a batch; false when a pass fails the check. */
function checkGpu(llama: Llama, gpu: LlamaMetal, promptTokens: number[]): boolean {
  const n = promptTokens.length, vocab = llama.vocab;
  const cpuTop: number[] = [];
  const cpuLogits = new Float32Array(vocab);
  llama.gpu = null;
  for (let pos = 0; pos < n; pos++) {
    const lg = llama.forward(promptTokens[pos], pos);
    cpuTop.push(argmax(lg));
    if (pos === n - 1) for (let i = 0; i < vocab; i++) cpuLogits[i] = lg[i];
  }
  let maxLogit = 0;
  for (let i = 0; i < vocab; i++) { const m = Math.abs(cpuLogits[i]); if (m > maxLogit) maxLogit = m; }
  const diff = (lg: Float32Array, off: number): number => { let maxAbs = 0; for (let i = 0; i < vocab; i++) { const d = Math.abs(lg[off + i] - cpuLogits[i]); if (d > maxAbs) maxAbs = d; } return maxAbs; };
  llama.gpu = gpu;
  let agree = 0, maxAbs = 0, gpuTopLast = -1;
  for (let pos = 0; pos < n; pos++) {
    const lg = llama.forward(promptTokens[pos], pos);
    const top = argmax(lg);
    if (top === cpuTop[pos]) agree++;
    if (pos === n - 1) { gpuTopLast = top; maxAbs = diff(lg, 0); }
  }
  let ok = verdict("per token", n, agree, maxAbs, maxLogit, cpuTop[n - 1], gpuTopLast);
  if (gpu.batched) {
    const all = gpu.forwardBatchAll(promptTokens, 0);
    agree = 0;
    for (let pos = 0; pos < n; pos++) if (argmax(all.subarray(pos * vocab, (pos + 1) * vocab)) === cpuTop[pos]) agree++;
    ok = verdict("batch", n, agree, diff(all, (n - 1) * vocab), maxLogit, cpuTop[n - 1], argmax(all.subarray((n - 1) * vocab, n * vocab))) && ok;
  }
  return ok;
}
function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 1) { process.stderr.write("usage: llama_gguf <model.gguf> [-n steps] [-p prompt] [-t temperature] [-s seed] [--raw] [-j threads] [--gpu] [--check-gpu] [--fast-math] [--no-tensor] [--serial-prompt] [--stats]\n"); process.exit(1); }
  let steps = 64, prompt = "Tell me a short story about a robot.", temperature = 0, seed = 42, raw = false, threads = 1, stats = false, gpu = false, check = false, fastMath = false, serialPrompt = false, noTensor = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--raw") raw = true;
    else if (a === "--stats") stats = true;
    else if (a === "--gpu") gpu = true;
    else if (a === "--check-gpu") { gpu = true; check = true; }
    else if (a === "--fast-math") fastMath = true;
    else if (a === "--serial-prompt") serialPrompt = true;
    else if (a === "--no-tensor") noTensor = true;
    else if (i + 1 < args.length) {
      const v = args[++i];
      if (a === "-n") steps = parseInt(v, 10); else if (a === "-p") prompt = v; else if (a === "-t") temperature = parseFloat(v); else if (a === "-s") seed = parseInt(v, 10); else if (a === "-j") threads = parseInt(v, 10);
    }
  }
  const t0 = Date.now();
  const g = readGguf(args[0], gpu);   // the GPU reads the model's shared pages in place
  const model = new Model(g);
  const llama = new Llama(model, 2048);
  setSharedModel(llama);
  const pool = threads > 1 && !gpu ? startPool(threads, llama, args[0]) : null;
  setPool(pool);
  const metal = gpu ? new LlamaMetal(llama, { fastMath, tensor: !noTensor }) : null;
  const tok = new Tokenizer(g.kv);
  const sampler = new Sampler(temperature, seed);
  process.stderr.write(`model: ${g.kv.get("general.name")} (${llama.nLayer} layers, ${llama.nEmbd} dim, ${llama.nHead}/${llama.nHeadKv} heads, ${llama.vocab} vocab), loaded in ${Date.now() - t0} ms${metal !== null ? `, GPU ${metal.device}${metal.tensor ? " (tensor API)" : ""}` : ""}\n`);
  // TinyLlama-Chat's template (Zephyr): the literal "</s>" is the eos token
  let promptTokens: number[];
  if (raw) promptTokens = tok.encode(prompt, true);
  else {
    promptTokens = tok.encode("<|system|>\nYou are a friendly chatbot who always responds in the style of a pirate.", true);
    promptTokens.push(tok.eos);
    for (const t of tok.encode("\n<|user|>\n" + prompt, false)) promptTokens.push(t);
    promptTokens.push(tok.eos);
    for (const t of tok.encode("\n<|assistant|>\n", false)) promptTokens.push(t);
  }
  let checked = true;
  if (metal !== null) {
    if (check) checked = checkGpu(llama, metal, promptTokens);
    llama.gpu = metal;
    metal.encodeMs = 0; metal.waitMs = 0; metal.forwards = 0;
    metal.batchEncodeMs = 0; metal.batchWaitMs = 0; metal.batches = 0; metal.batchTokens = 0;
  }
  const pieces: Uint8Array[] = [];
  const start = performance.now();
  // the prompt: one batch (the GPU reads the weights once per 32 tokens; the CPU runs the tokens one at
  // a time inside forwardBatch), or one forward per token when asked
  let pos = promptTokens.length - 1, generated = 0;
  let logits: Float32Array;
  if (serialPrompt) { for (let p = 0; p < pos; p++) llama.forward(promptTokens[p], p); logits = llama.forward(promptTokens[pos], pos); }
  else logits = llama.forwardBatch(promptTokens, 0);
  const promptMs = performance.now() - start;
  for (;;) {
    const next = sampler.sample(logits);
    generated++;
    if (next === tok.eos) break;
    pieces.push(tok.pieceBytes(next));
    pos++;
    if (pos >= llama.ctx || generated >= steps) break;
    logits = llama.forward(next, pos);
  }
  const text = new TextDecoder().decode(concatBytes(pieces));
  process.stdout.write(text + "\n");
  const genMs = performance.now() - start - promptMs;
  const where = metal !== null ? `, GPU${serialPrompt ? ", prompt one token at a time" : ""}` : threads > 1 ? `, ${threads} threads` : "";
  process.stderr.write(`prompt ${promptTokens.length} tokens in ${promptMs.toFixed(1)} ms (${(promptTokens.length / (promptMs / 1000)).toFixed(1)} tok/s), generated ${generated} tokens in ${genMs.toFixed(1)} ms (${(generated / (genMs / 1000)).toFixed(1)} tok/s)${where}\n`);
  if (pool !== null) stopPool(pool);
  if (stats && pool !== null) {
    const ps = poolStats, us = (ms: number) => (ms / ps.jobs * 1000).toFixed(1);
    process.stderr.write(`pool: ${ps.jobs} jobs; per job prep ${us(ps.prep)} us, own ${us(ps.own)} us, wait ${us(ps.wait)} us, post ${us(ps.post)} us; in jobs ${(ps.prep + ps.own + ps.wait + ps.post).toFixed(0)} ms of ${Date.now() - t0} ms\n`);
  }
  if (stats && metal !== null) {
    process.stderr.write(`gpu: ${metal.forwards} forwards; per forward encode ${(metal.encodeMs / metal.forwards).toFixed(3)} ms, wait ${(metal.waitMs / metal.forwards).toFixed(3)} ms\n`);
    if (metal.batches > 0) process.stderr.write(`gpu: ${metal.batches} batches of ${metal.batchTokens} tokens; encode ${metal.batchEncodeMs.toFixed(2)} ms, wait ${metal.batchWaitMs.toFixed(2)} ms\n`);
  }
  if (metal !== null) metal.release();
  if (!checked) process.exit(1);
}
main();
