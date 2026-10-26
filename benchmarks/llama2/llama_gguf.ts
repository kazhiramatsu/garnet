// llama_gguf.ts: the program of docs/llm_inference_design.md: a llama.cpp GGUF model
// (TinyLlama-1.1B-Chat Q8_0) generating text over garnet:llama (lib/garnet/llama.ts: the reader,
// the model, the kernels, the thread pool, the tokenizer and the sampler) and, with --gpu, over
// garnet:llama_metal (the same model on the Metal device).
//
// Usage: llama_gguf <model.gguf> [-n steps] [-p "prompt"] [-t temperature] [-s seed] [--raw]
//                   [-j threads] [--gpu] [--check-gpu] [--fast-math] [--stats]
//   The prompt is wrapped in TinyLlama-Chat's template unless --raw is given; -j N splits the
//   work over N threads (llama.ts); --gpu runs the forward passes on the GPU (--fast-math lets
//   the kernels reassociate); --check-gpu first runs the prompt on the CPU and on the GPU and
//   prints how the two agree (the argmax per position, the last logits' largest difference;
//   PASS when the argmax differs at no more than one position and the logits within 3%);
//   --stats prints the pool's per-job time split, or the GPU's encode and wait times.
import { readGguf, Model, Llama, Tokenizer, Sampler, startPool, stopPool, setPool, setSharedModel, poolStats } from "garnet:llama";
import { LlamaMetal } from "garnet:llama_metal";

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
/** The prompt on the CPU, then on the GPU: the argmax agreement per position and the last logits' difference. */
function checkGpu(llama: Llama, gpu: LlamaMetal, promptTokens: number[]): void {
  const n = promptTokens.length;
  const cpuTop: number[] = [];
  const cpuLogits = new Float32Array(llama.vocab);
  llama.gpu = null;
  for (let pos = 0; pos < n; pos++) {
    const lg = llama.forward(promptTokens[pos], pos);
    cpuTop.push(argmax(lg));
    if (pos === n - 1) for (let i = 0; i < lg.length; i++) cpuLogits[i] = lg[i];
  }
  llama.gpu = gpu;
  let agree = 0, maxAbs = 0, maxLogit = 0, gpuTopLast = -1;
  for (let pos = 0; pos < n; pos++) {
    const lg = llama.forward(promptTokens[pos], pos);
    const top = argmax(lg);
    if (top === cpuTop[pos]) agree++;
    if (pos === n - 1) {
      gpuTopLast = top;
      for (let i = 0; i < lg.length; i++) { const diff = Math.abs(lg[i] - cpuLogits[i]); if (diff > maxAbs) maxAbs = diff; const m = Math.abs(cpuLogits[i]); if (m > maxLogit) maxLogit = m; }
    }
  }
  // the verdict: the argmax may differ where two logits are within the GPU's rounding (at most one
  // position of the prompt), and the last logits must agree within 3% of their range
  const ok = agree >= n - 1 && maxAbs <= 0.03 * maxLogit;
  process.stderr.write(`gpu check: argmax agrees at ${agree}/${n} prompt positions; last logits: max |gpu - cpu| ${maxAbs.toFixed(4)} over |logit| up to ${maxLogit.toFixed(2)}, next token cpu ${cpuTop[n - 1]} gpu ${gpuTopLast}: ${ok ? "PASS" : "FAIL"}\n`);
}
function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 1) { process.stderr.write("usage: llama_gguf <model.gguf> [-n steps] [-p prompt] [-t temperature] [-s seed] [--raw] [-j threads] [--gpu] [--check-gpu] [--fast-math] [--stats]\n"); process.exit(1); }
  let steps = 64, prompt = "Tell me a short story about a robot.", temperature = 0, seed = 42, raw = false, threads = 1, stats = false, gpu = false, check = false, fastMath = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--raw") raw = true;
    else if (a === "--stats") stats = true;
    else if (a === "--gpu") gpu = true;
    else if (a === "--check-gpu") { gpu = true; check = true; }
    else if (a === "--fast-math") fastMath = true;
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
  const metal = gpu ? new LlamaMetal(llama, { fastMath }) : null;
  const tok = new Tokenizer(g.kv);
  const sampler = new Sampler(temperature, seed);
  process.stderr.write(`model: ${g.kv.get("general.name")} (${llama.nLayer} layers, ${llama.nEmbd} dim, ${llama.nHead}/${llama.nHeadKv} heads, ${llama.vocab} vocab), loaded in ${Date.now() - t0} ms${metal !== null ? `, GPU ${metal.device}` : ""}\n`);
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
  if (metal !== null) {
    if (check) checkGpu(llama, metal, promptTokens);
    llama.gpu = metal;
    metal.encodeMs = 0; metal.waitMs = 0; metal.forwards = 0;
  }
  const pieces: Uint8Array[] = [];
  let token = promptTokens[0], pos = 0, generated = 0;
  const start = Date.now();
  let promptMs = 0;
  while (pos < llama.ctx && generated < steps) {
    const logits = llama.forward(token, pos);
    let next: number;
    if (pos < promptTokens.length - 1) next = promptTokens[pos + 1];
    else {
      if (generated === 0) promptMs = Date.now() - start;
      next = sampler.sample(logits);
      generated++;
      if (next === tok.eos) break;
      pieces.push(tok.pieceBytes(next));
    }
    pos++;
    token = next;
  }
  const text = new TextDecoder().decode(concatBytes(pieces));
  process.stdout.write(text + "\n");
  const genMs = Date.now() - start - promptMs;
  const where = metal !== null ? ", GPU" : threads > 1 ? `, ${threads} threads` : "";
  process.stderr.write(`prompt ${promptTokens.length} tokens in ${promptMs} ms (${(promptTokens.length / (promptMs / 1000)).toFixed(1)} tok/s), generated ${generated} tokens in ${genMs} ms (${(generated / (genMs / 1000)).toFixed(1)} tok/s)${where}\n`);
  if (pool !== null) stopPool(pool);
  if (stats && pool !== null) {
    const ps = poolStats, us = (ms: number) => (ms / ps.jobs * 1000).toFixed(1);
    process.stderr.write(`pool: ${ps.jobs} jobs; per job prep ${us(ps.prep)} us, own ${us(ps.own)} us, wait ${us(ps.wait)} us, post ${us(ps.post)} us; in jobs ${(ps.prep + ps.own + ps.wait + ps.post).toFixed(0)} ms of ${Date.now() - t0} ms\n`);
  }
  if (stats && metal !== null) {
    process.stderr.write(`gpu: ${metal.forwards} forwards; per forward encode ${(metal.encodeMs / metal.forwards).toFixed(3)} ms, wait ${(metal.waitMs / metal.forwards).toFixed(3)} ms\n`);
  }
  if (metal !== null) metal.release();
}
main();
