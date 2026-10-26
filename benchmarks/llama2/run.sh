#!/usr/bin/env bash
# Llama 2 inference (benchmarks/llama2/llama2.ts, a port of llama2.c) on a tinyllamas checkpoint:
# fetches the model and the tokenizer into build/llama2 when missing, builds the program with
# garnet and transpiles it for node, generates the same story both ways, compares the outputs
# byte for byte and prints the tokens per second of each.
#   bash benchmarks/llama2/run.sh [stories15M|stories42M|stories110M] [steps] [prompt]
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
model="${1:-stories15M}"; steps="${2:-200}"; prompt="${3:-Once upon a time}"
work="$ROOT/build/llama2"
mkdir -p "$work"
[ -s "$work/$model.bin" ] || curl -sfL -o "$work/$model.bin" "https://huggingface.co/karpathy/tinyllamas/resolve/main/$model.bin" || { echo "download of $model.bin failed"; exit 1; }
[ -s "$work/tokenizer.bin" ] || curl -sfL -o "$work/tokenizer.bin" "https://github.com/karpathy/llama2.c/raw/master/tokenizer.bin" || { echo "download of tokenizer.bin failed"; exit 1; }
cd "$ROOT" || exit 1
"$ROOT/garnet" -o "$work/llama2.c" benchmarks/llama2/llama2.ts > "$work/build.log" 2>&1 || { echo "garnet build failed:"; tail -5 "$work/build.log"; exit 1; }
node exporter/node_modules/typescript/bin/tsc --target es2022 --module esnext --outDir "$work" benchmarks/llama2/llama2.ts > /dev/null 2>&1
mv -f "$work/llama2.js" "$work/llama2.mjs"
"$work/llama2" "$work/$model.bin" -n "$steps" -i "$prompt" > "$work/out_native.txt" 2> "$work/err_native.txt"
node "$work/llama2.mjs" "$work/$model.bin" -n "$steps" -i "$prompt" > "$work/out_node.txt" 2> "$work/err_node.txt"
echo "native: $(tail -1 "$work/err_native.txt")"
echo "node:   $(tail -1 "$work/err_node.txt")"
if cmp -s "$work/out_native.txt" "$work/out_node.txt"; then echo "[llama2] outputs identical ($(wc -c < "$work/out_native.txt" | tr -d ' ') bytes)"; else echo "[llama2] OUTPUTS DIFFER"; diff "$work/out_native.txt" "$work/out_node.txt" | head -5; exit 1; fi
