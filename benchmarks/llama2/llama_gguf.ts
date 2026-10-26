// llama_gguf.ts: the program of docs/llm_inference_design.md, milestone 2: a llama.cpp GGUF model
// (TinyLlama-1.1B-Chat Q8_0) generating text, the model and the kernels in llama_core.ts.
//
// Usage: llama_gguf <model.gguf> [-n steps] [-p "prompt"] [-t temperature] [-s seed] [--raw] [-j threads] [--stats]
//   The prompt is wrapped in TinyLlama-Chat's template unless --raw is given; -j N splits the
//   matrix-vector products over N threads (llama_core.ts); --stats prints the pool's per-job time
//   split (the main thread's preparation, its own share, its wait for the workers, the copy out).
import { readGguf, Model, Llama, Tokenizer, softmax, startPool, stopPool, setPool, setSharedModel, poolStats } from "./llama_core";

class Sampler {
  private state: number;
  constructor(readonly temperature: number, seed: number) { this.state = (seed | 0) || 1; }
  private next(): number { let s = this.state; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; this.state = s; return (s >>> 0) / 4294967296; }
  sample(logits: Float32Array): number {
    const n = logits.length;
    if (this.temperature === 0) { let best = 0; for (let i = 1; i < n; i++) if (logits[i] > logits[best]) best = i; return best; }
    for (let i = 0; i < n; i++) logits[i] = logits[i] / this.temperature;
    softmax(logits, 0, n);
    const coin = this.next();
    let cdf = 0;
    for (let i = 0; i < n; i++) { cdf += logits[i]; if (coin < cdf) return i; }
    return n - 1;
  }
}
function concatBytes(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 1) { process.stderr.write("usage: llama_gguf <model.gguf> [-n steps] [-p prompt] [-t temperature] [-s seed] [--raw]\n"); process.exit(1); }
  let steps = 64, prompt = "Tell me a short story about a robot.", temperature = 0, seed = 42, raw = false, threads = 1, stats = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--raw") raw = true;
    else if (a === "--stats") stats = true;
    else if (i + 1 < args.length) {
      const v = args[++i];
      if (a === "-n") steps = parseInt(v, 10); else if (a === "-p") prompt = v; else if (a === "-t") temperature = parseFloat(v); else if (a === "-s") seed = parseInt(v, 10); else if (a === "-j") threads = parseInt(v, 10);
    }
  }
  const t0 = Date.now();
  const g = readGguf(args[0]);
  const model = new Model(g);
  const llama = new Llama(model, 2048);
  setSharedModel(llama);
  const pool = threads > 1 ? startPool(threads, args[0], Math.max(llama.nEmbd, llama.nFf), Math.max(llama.vocab, llama.nFf, llama.nEmbd)) : null;
  setPool(pool);
  const tok = new Tokenizer(g.kv);
  const sampler = new Sampler(temperature, seed);
  process.stderr.write(`model: ${g.kv.get("general.name")} (${llama.nLayer} layers, ${llama.nEmbd} dim, ${llama.nHead}/${llama.nHeadKv} heads, ${llama.vocab} vocab), loaded in ${Date.now() - t0} ms\n`);
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
  process.stderr.write(`prompt ${promptTokens.length} tokens in ${promptMs} ms (${(promptTokens.length / (promptMs / 1000)).toFixed(1)} tok/s), generated ${generated} tokens in ${genMs} ms (${(generated / (genMs / 1000)).toFixed(1)} tok/s)${threads > 1 ? `, ${threads} threads` : ""}\n`);
  if (pool !== null) stopPool(pool);
  if (stats && pool !== null) {
    const ps = poolStats, us = (ms: number) => (ms / ps.jobs * 1000).toFixed(1);
    process.stderr.write(`pool: ${ps.jobs} jobs; per job prep ${us(ps.prep)} us, own ${us(ps.own)} us, wait ${us(ps.wait)} us, post ${us(ps.post)} us; in jobs ${(ps.prep + ps.own + ps.wait + ps.post).toFixed(0)} ms of ${Date.now() - t0} ms\n`);
  }
}
main();
