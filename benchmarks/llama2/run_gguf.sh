#!/usr/bin/env bash
# A llama.cpp GGUF model under garnet (benchmarks/llama2/llama_gguf.ts, docs/llm_inference_design.md):
# fetches TinyLlama-1.1B-Chat Q8_0 into build/llama2 when missing (1.17 GB), builds the program with
# garnet, transpiles it for node, generates the same answer both ways, compares the outputs byte for
# byte and prints the tokens per second of each.
#   bash benchmarks/llama2/run_gguf.sh [threads] [steps] [prompt]
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
threads="${1:-1}"; steps="${2:-32}"; prompt="${3:-Write three sentences about the sea.}"
work="$ROOT/build/llama2"; model="$work/tinyllama-1.1b-chat-v1.0.Q8_0.gguf"
mkdir -p "$work/src"
[ -s "$model" ] || curl -sfL -o "$model" "https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/main/tinyllama-1.1b-chat-v1.0.Q8_0.gguf" || { echo "download failed"; exit 1; }
cd "$ROOT" || exit 1
"$ROOT/garnet" -o "$work/llama_gguf.c" benchmarks/llama2/llama_gguf.ts > "$work/build_gguf.log" 2>&1 || { echo "garnet build failed:"; tail -5 "$work/build_gguf.log"; exit 1; }
cp benchmarks/llama2/llama_core.ts benchmarks/llama2/llama_gguf.ts benchmarks/llama2/llama_worker.ts "$work/src/"
ROOT="$ROOT" node build/mfnode.js "$work/src" > /dev/null 2>&1
"$work/llama_gguf" "$model" -n "$steps" -p "$prompt" -j "$threads" > "$work/out_native.txt" 2> "$work/err_native.txt"
node "$work/src/llama_gguf.mjs" "$model" -n "$steps" -p "$prompt" -j "$threads" > "$work/out_node.txt" 2> "$work/err_node.txt"
echo "native: $(tail -1 "$work/err_native.txt")"
echo "node:   $(tail -1 "$work/err_node.txt")"
if cmp -s "$work/out_native.txt" "$work/out_node.txt"; then echo "[llama_gguf] outputs identical ($(wc -c < "$work/out_native.txt" | tr -d ' ') bytes): $(head -c 100 "$work/out_native.txt")"; else echo "[llama_gguf] OUTPUTS DIFFER"; diff "$work/out_native.txt" "$work/out_node.txt" | head -5; exit 1; fi
