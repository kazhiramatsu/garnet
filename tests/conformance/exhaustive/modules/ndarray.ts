// garnet:ndarray (docs/ndarray_design.md): creation, views, reshaping, the elementwise kernels with
// scalar operands, reductions, dot/outer/transpose, slicing and concatenation, the generators
// (rows, entries, values, from an iterable), the dtypes (integer wraparound, float32 rounding, the
// encoded float16 and bfloat16, promotion, astype), the seeded Random, and the loud errors. Every
// value prints through toString (JSON of the nested arrays), so the output is exact.
import * as nd from "garnet:ndarray";
import { NDArray, Random, DimensionError, dot, add, sub, mul, div, tensor, zeros, ones, arange, generate, from, transpose, outer, sum, mean, max, min, argmax, concat, slice, flatten, equals, promote, float32, int8, uint8, int32, bfloat16, float16, float64 } from "garnet:ndarray";
function show(label: string, v: unknown): void {
  console.log(label + " " + (v instanceof NDArray ? v.toString() + " " + v.dtype.name + " (" + v.shape.join(",") + ")" : String(v)));
}
function attempt(label: string, f: () => unknown): void {
  try { show(label, f()); } catch (e) { console.log(label + " throws " + (e as Error).name + ": " + (e as Error).message); }
}
function main(): void {
  const a = tensor([[1, 2, 3], [4, 5, 6]]);
  const v = tensor([1, 0.5, -2]);
  show("a", a); show("v", v);
  show("a.v", dot(a, v)); show("aT", transpose(a)); show("a.aT", dot(a, transpose(a)));
  show("v.v", dot(v, v)); show("v.aT", dot(v, transpose(a)));
  show("outer", outer(v, tensor([2, 3])));
  show("add", add(a, a)); show("sub s", sub(10, a)); show("mul s", mul(a, 0.5)); show("div s", div(1, v)); show("div", div(a, add(a, 1)));
  show("sum/mean/max/min/argmax", [sum(a), mean(a), max(a), min(v), argmax(v)].join(","));
  show("row", a.row(1)); a.row(1).put(99, 2); show("row write seen", a);
  show("at", a.at(1, 2) + "," + a.at(0, 0));
  show("reshape", a.reshape([3, 2])); show("flatten", flatten(a)); show("slice", slice(a, [0, 2], [1, 3]));
  show("concat0", concat([a, a])); show("concat1", concat([a, transpose(transpose(a))], 1)); show("concat v", concat([v, v]));
  show("arange", arange(5)); show("arange step", arange(1, 2, 0.25)); show("linspace", nd.linspace(0, 1, 5)); show("eye", nd.eye(3));
  show("generate", generate([2, 3], (i) => i * i)); show("fromFunction", nd.fromFunction([2, 2], (i, j) => i * 10 + j));
  show("from gen", from([4], (function* () { let x = 1; for (;;) { yield x; x *= 2; } })()));
  show("from array", from([2, 2], [7, 8, 9, 10]));
  show("exp/tanh/sigmoid", [nd.exp(tensor([0, 1])).toString(), nd.tanh(tensor([0, 1])).toString(), nd.sigmoid(tensor([0, 1])).toString()].join(" "));
  // rows / entries / values generators
  const rows: string[] = []; for (const r of a.rows()) rows.push(r.toString()); show("rows", rows.join("|"));
  const ents: string[] = []; for (const [idx, val] of tensor([[1, 2], [3, 4]]).entries()) ents.push(idx.join(".") + "=" + val); show("entries", ents.join(" "));
  show("values", Array.from(tensor([3, 1, 2]).values()).join(","));
  // dtypes: int8 wraps, uint8 wraps, float32 rounds, bfloat16 and float16 round, promotion
  const i8 = tensor([100, -100, 127], int8);
  show("int8 add", add(i8, i8)); show("int8 mul s", mul(i8, 2)); show("int8 + 0.5", add(i8, 0.5)); show("int8 div", div(i8, tensor([3, 3, 3], int8)));
  show("uint8", tensor([250, 5], uint8)); show("uint8 add", add(tensor([250, 5], uint8), tensor([10, 10], uint8)));
  show("f32", tensor([0.1, 1 / 3, 16777217], float32)); show("f32+f64", add(tensor([0.1], float32), tensor([0.2], float64)));
  show("bf16", tensor([1, 0.1, 1 / 3, 3.14159, 65504, 1e39, -1e-45, 1.0078125, 1.00390625], bfloat16));
  show("f16", tensor([1, 0.1, 1 / 3, 3.14159, 65504, 65520, 1e-8, 5.960464477539063e-8, 2.98e-8, 2.99e-8, -0.000061, 1.0009765625, 1.00048828125, 1.00146484375], float16));
  show("f16 ops", add(tensor([1, 2], float16), tensor([0.0005, 1000], float16)));
  show("promote", [promote(int8, uint8).name, promote(int32, uint8).name, promote(float32, int32).name, promote(bfloat16, float16).name, promote(int32, nd.uint32).name, promote(nd.int16, nd.uint16).name].join(","));
  show("astype", tensor([1.7, -1.7, 300], float64).astype(int8)); show("astype back", tensor([1, 2], int8).astype(float32));
  // random: the same stream in both engines
  const rng = new Random(1234);
  show("u", [rng.next(), rng.next(), rng.uniform(-1, 1)].join(","));
  show("uniform", rng.uniform(-1, 1, [2, 3])); show("normal", rng.normal(0, 1, [4])); show("integers", rng.integers(0, 10, [6]));
  show("stream", from([3], rng.stream(5, 6)));
  const sh = arange(6); rng.shuffle(sh); show("shuffle", sh);
  show("normal scalar", rng.normal());
  // errors are loud
  attempt("mismatch", () => add(a, v));
  attempt("dot", () => dot(a, a));
  attempt("ragged", () => tensor([[1, 2], [3]]));
  attempt("from short", () => from([3], [1, 2]));
  attempt("reshape", () => a.reshape([4, 2]));
  attempt("index", () => a.at(2, 0));
  attempt("dtype", () => zeros([1], "float128" as never));
  attempt("empty max", () => max(zeros([0])));
  show("equals", [equals(a, a.copy()), equals(a, transpose(a)), nd.allclose(tensor([1, 2]), tensor([1.000001, 2]))].join(","));
  show("ones", ones([2], int32)); show("full", nd.full([2], 7, uint8));
  show("clip/max/min", [nd.clip(v, -1, 0.6).toString(), nd.maximum(v, 0).toString(), nd.minimum(v, tensor([0, 1, -3])).toString()].join(" "));
  show("neg/abs/sqrt/log", [nd.neg(v).toString(), nd.abs(v).toString(), nd.sqrt(tensor([4, 9], int32)).toString(), nd.log(tensor([1, Math.E])).toString()].join(" "));
  show("3d", transpose(arange(24).reshape([2, 3, 4])).reshape([4, 6]));
  show("3d at", arange(24).reshape([2, 3, 4]).at(1, 2, 3));
}
main();
