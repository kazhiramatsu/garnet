#!/usr/bin/env bash
# A llama.cpp GGUF model under garnet (benchmarks/llama2/llama_gguf.ts over garnet:llama,
# docs/llm_inference_design.md): fetches TinyLlama-1.1B-Chat Q8_0 into build/llama2 when missing
# (1.17 GB), builds the program with garnet, transpiles it for node (the garnet modules through
# scripts/garnet_scheme_loader.mjs), generates the same answer both ways, compares the outputs
# byte for byte and prints the tokens per second of each.
#   bash benchmarks/llama2/run_gguf.sh [threads] [steps] [prompt]
# With `gpu` as the thread count the native program runs on the Metal device (garnet:llama_metal)
# after checking its forward pass against the CPU's over the prompt (--check-gpu: the argmax per
# position and the last logits within a tolerance, one token at a time and as a batch; a FAIL exits
# 1), and its text is compared with
# the CPU path's native text: the GPU's float32 arithmetic may pick another token where two logits
# are within its rounding, so a text difference is reported, not failed.
#   bash benchmarks/llama2/run_gguf.sh gpu [steps] [prompt]
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
threads="${1:-1}"; steps="${2:-32}"; prompt="${3:-Write three sentences about the sea.}"
work="$ROOT/build/llama2"; model="$work/tinyllama-1.1b-chat-v1.0.Q8_0.gguf"
mkdir -p "$work/src"
[ -s "$model" ] || curl -sfL -o "$model" "https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/main/tinyllama-1.1b-chat-v1.0.Q8_0.gguf" || { echo "download failed"; exit 1; }
cd "$ROOT" || exit 1
"$ROOT/garnet" -o "$work/llama_gguf.c" benchmarks/llama2/llama_gguf.ts > "$work/build_gguf.log" 2>&1 || { echo "garnet build failed:"; tail -5 "$work/build_gguf.log"; exit 1; }
if [ "$threads" = "gpu" ]; then
  "$work/llama_gguf" "$model" -n "$steps" -p "$prompt" --check-gpu --stats > "$work/out_gpu.txt" 2> "$work/err_gpu.txt"
  "$work/llama_gguf" "$model" -n "$steps" -p "$prompt" -j 1 > "$work/out_native.txt" 2> "$work/err_native.txt"
  grep '^gpu check' "$work/err_gpu.txt" | sed 's/^/gpu:    /'
  echo "gpu:    $(grep '^prompt' "$work/err_gpu.txt")"
  grep '^gpu:' "$work/err_gpu.txt" | sed 's/^/gpu:    /'
  echo "cpu:    $(grep '^prompt' "$work/err_native.txt")"
  if cmp -s "$work/out_gpu.txt" "$work/out_native.txt"; then echo "[llama_gguf] GPU text identical to the CPU's ($(wc -c < "$work/out_gpu.txt" | tr -d ' ') bytes): $(head -c 100 "$work/out_gpu.txt")"
  else echo "[llama_gguf] GPU text differs from the CPU's (float32 rounding): gpu: $(head -c 100 "$work/out_gpu.txt")"; echo "                                                    cpu: $(head -c 100 "$work/out_native.txt")"; fi
  # every check line (the per-token pass and the batch) must PASS
  checks=$(grep -c '^gpu check' "$work/err_gpu.txt"); passes=$(grep -c '^gpu check.*PASS$' "$work/err_gpu.txt")
  [ "$checks" -ge 1 ] && [ "$checks" -eq "$passes" ] && exit 0
  echo "[llama_gguf] GPU CHECK FAILED ($passes of $checks passes)"; tail -3 "$work/err_gpu.txt"; exit 1
fi
cp benchmarks/llama2/llama_gguf.ts "$work/src/"
ROOT="$ROOT" node build/mfnode.js "$work/src" > /dev/null 2>&1
"$work/llama_gguf" "$model" -n "$steps" -p "$prompt" -j "$threads" > "$work/out_native.txt" 2> "$work/err_native.txt"
node --import "$ROOT/scripts/garnet_scheme_loader.mjs" "$work/src/llama_gguf.mjs" "$model" -n "$steps" -p "$prompt" -j "$threads" > "$work/out_node.txt" 2> "$work/err_node.txt"
echo "native: $(tail -1 "$work/err_native.txt")"
echo "node:   $(tail -1 "$work/err_node.txt")"
if cmp -s "$work/out_native.txt" "$work/out_node.txt"; then echo "[llama_gguf] outputs identical ($(wc -c < "$work/out_native.txt" | tr -d ' ') bytes): $(head -c 100 "$work/out_native.txt")"; else echo "[llama_gguf] OUTPUTS DIFFER"; diff "$work/out_native.txt" "$work/out_node.txt" | head -5; exit 1; fi
