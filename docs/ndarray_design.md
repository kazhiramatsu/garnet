# `garnet:ndarray`: n-dimensional arrays over typed storage

Session 353. A numeric module in the style of numpy, shipped with garnet as
`lib/garnet/ndarray.ts` and importable as `garnet:ndarray`. It descends from
DeepLearningJS by Yusuke Sugomori (MIT; its `math` package: shape, dot,
transpose, the elementwise operators with a scalar operand, the activations),
rewritten for typed storage, dtypes and TypeScript, and it is a test program
for the compiler: realistic numeric code whose output under garnet must equal
Node's to the last bit.

## The decisions

- **Representation: a contiguous row-major buffer plus a shape**, not nested
  arrays. One allocation per array, every elementwise kernel one flat loop
  whatever the rank, `dot` and `outer` index arithmetic over the buffer. For
  garnet this is the typed-array loop the C compiler vectorizes, and the
  integer fields (`size`, the strides) are the integer-slot material of the
  record work. Nested arrays stay at the boundary: `tensor([[1, 2], [3, 4]])`
  in, `toArray()` out; a ragged nesting is a `DimensionError`.
- **Rank in the type.** `NDArray<R>` carries the rank as a phantom parameter
  (`Vector = NDArray<1>`, `Matrix = NDArray<2>`, `Tensor3 = NDArray<3>`,
  `NDArray<number>` is "rank unknown"); the constructors infer it from a tuple
  shape (`zeros([3, 4])` is a `Matrix`, `tensor([1, 2])` a `Vector`), `row(i)`
  lowers it, `reshape` re-infers it, the elementwise functions keep it, `dot`
  is overloaded on it. A mistaken `dot(v, m)` is a compile-time error; the
  cost at run time is nothing.
- **dtype as a descriptor, float64 as the fast path.** `DType` names the
  storage (`alloc`), and for the encoded 16-bit floats (`float16`, `bfloat16`,
  bits in a `Uint16Array`) the `encode`/`decode` pair; the integer dtypes and
  `float32` are their typed arrays. Arithmetic is done in double and stored
  through the dtype: an integer dtype wraps (`int8` 100 + 100 is -56, as
  numpy's), a narrower float rounds (double rounding is innocuous for `+ - * /`
  and sqrt from these operands, so the result equals the native operation).
  Promotion follows numpy without 64-bit integers (int32 with uint32 promotes
  to float64); a JS number is weak: it keeps the array's dtype unless it is a
  fraction on an integer array; `div` of integer arrays is float64 (true
  division). The kernels test for float64 operands once per call and run the
  `Float64Array` loop; every other dtype goes through `item`/`setItem`, slower
  today in both engines (the per-element decode is a call). Making those
  polymorphic kernels as fast as the float64 ones is a compiler task: the
  whole-program analysis sees which storage kinds reach a kernel and can emit a
  C copy per kind with one dispatch at the call. That is ahead-of-time
  specialization, not run-time code generation, and this module is its
  motivating workload.
- **One initializer, typed producers; ES generators only where lazy makes
  sense.** DeepLearningJS fed one recursive initializer with a "generator"
  closure. Here `generate(shape, flat => v)` is the hot bulk initializer (one
  allocation, one loop), `fromFunction(shape, (i, j, k) => v)` the multi-index
  form, `from(shape, iterable)` accepts arrays, typed arrays and ES
  generators, and `tensor(nested)` the literal form. `rows()`, `entries()`,
  `values()` and `Random.stream()` are `function*`: lazy sequences, never a
  per-element protocol inside a kernel.
- **`Random` is numpy's Generator over xoshiro128\*\***, seeded through
  splitmix32, 53-bit doubles from two draws, Box–Muller normals, integers,
  shuffle, and an endless `stream(low, high)`. Only int32 arithmetic
  (`Math.imul`, shifts), so garnet and Node draw the same numbers; with the
  V8-exact Math of the runtime (Session 353, `runtime/ts_ieee754.c`) a
  training run prints the same predictions under both.
- **Errors are loud.** Shape mismatch, an incompatible `dot`, a ragged
  literal, a short iterable, an impossible reshape and an out-of-range index
  throw; nothing broadcasts silently (only a scalar operand broadcasts).
- **Views are few and explicit.** `row(i)` and `reshape` share the buffer
  (`row(i).assign(v)` writes a row in place, the models' idiom); `transpose`,
  `slice`, `concat`, `flatten`, `copy` and `astype` copy. Strided views would
  bring aliasing rules the module does not need yet.

## What the original got wrong, fixed in the rewrite

`equals` returned after comparing the first nested row; `sub(scalar, tensor)`
had the sign reversed and `div(scalar, tensor)` threw; `normal` ignored its
location and scale and had variance 1/2; `softmax.grad` was referenced but
undefined; the LSTM's cell at `t = 0` stayed zero (now `i * a`); `dimension`
read only the first element of each level, so ragged arrays passed.

## The test programs

- `tests/conformance/exhaustive/modules/ndarray.ts`: the API, the dtypes, the
  generators, the errors.
- `tests/conformance/exhaustive/modules/ndarray_models.ts`: an LSTM and an RNN
  (DeepLearningJS's models over the module) trained for a few epochs; the
  predictions must equal Node's bit for bit.
- `benchmarks/patterns/lstm_sinwave.ts`: the LSTM at a kernel's size in the
  pattern survey (`scripts/pattern_bench.sh`), the allocation-heavy small-array
  workload numpy-style code produces.

## Next

Axis arguments for the reductions, general broadcasting, strided views and
the dtype-specialized kernels (the compiler side); `garnet:nn` if the
activations and the models earn a home of their own.
