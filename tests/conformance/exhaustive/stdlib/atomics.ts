// Atomics on one thread (docs/typed_arrays_design.md, TA3): every integer
// element type, the operand conversions, the old values returned, the
// validation errors, wait and notify on a shared Int32Array.
function report(label: string, f: () => unknown): void {
  try { console.log(label, f()); }
  catch (e) { console.log(label, "threw", (e as Error).constructor.name, (e as Error).message); }
}
const i32 = new Int32Array(new SharedArrayBuffer(16));
const u8 = new Uint8Array(4);

report("load", () => [Atomics.load(i32, 0), Atomics.load(new Uint32Array([4294967295]), 0), Atomics.load(new Int8Array([-5]), 0)].join());
report("load index", () => [Atomics.load(i32, 1.7), Atomics.load(i32, "2" as unknown as number)].join());
report("store", () => [Atomics.store(i32, 0, 3.7), i32[0], Object.is(Atomics.store(i32, 0, -0), 0)].join());
report("store conversions", () => [Atomics.store(u8, 0, 300), u8[0], Atomics.store(i32, 1, Infinity), i32[1], Atomics.store(i32, 1, NaN), i32[1]].join());
report("add", () => [Atomics.add(i32, 2, 5), Atomics.add(i32, 2, 2147483647), i32[2]].join());
report("sub", () => [Atomics.sub(u8, 1, 1), u8[1]].join());
report("bitwise", () => [Atomics.and(i32, 3, 6), Atomics.or(i32, 3, 12), Atomics.xor(i32, 3, 5), i32[3]].join());
report("exchange", () => [Atomics.exchange(i32, 3, 99), i32[3]].join());
report("compareExchange", () => [Atomics.compareExchange(i32, 3, 99, 7), Atomics.compareExchange(i32, 3, 99, 8), i32[3]].join());
report("compareExchange conversion", () => [Atomics.compareExchange(u8, 2, 256, 5), u8[2]].join());
report("uint32 wrap", () => { const a = new Uint32Array([4294967295]); return [Atomics.add(a, 0, 2), a[0]].join(); });
report("int8 wrap", () => { const a = new Int8Array([-5]); return [Atomics.sub(a, 0, 200), a[0]].join(); });
report("int16", () => { const a = new Int16Array([1]); return [Atomics.or(a, 0, 0x18000), a[0]].join(); });
report("operand valueOf", () => Atomics.add(i32, 0, { valueOf() { return 2; } } as unknown as number) + "," + i32[0]);
report("counter", () => { const c = new Int32Array(new SharedArrayBuffer(4)); let ids = 0; for (let k = 0; k < 5; k++) ids += Atomics.add(c, 0, 10); return [ids, Atomics.load(c, 0)].join(); });
report("isLockFree", () => [1, 2, 3, 4, 8].map((n) => Atomics.isLockFree(n)).join());

// validation
report("array", () => Atomics.load([1] as unknown as Int32Array, 0));
report("float view", () => Atomics.load(new Float64Array(1) as unknown as Int32Array, 0));
report("clamped view", () => Atomics.load(new Uint8ClampedArray(1) as unknown as Uint8Array, 0));
report("past end", () => Atomics.load(i32, 5));
report("negative index", () => Atomics.store(i32, -1, 0));

// wait and notify
report("wait not equal", () => Atomics.wait(i32, 0, 123));
report("wait timed out", () => Atomics.wait(i32, 0, i32[0], 1));
report("wait not shared", () => Atomics.wait(new Int32Array(4), 0, 0));
report("wait uint8", () => Atomics.wait(new Uint8Array(new SharedArrayBuffer(4)) as unknown as Int32Array, 0, 0));
report("notify", () => [Atomics.notify(i32, 0, 1), Atomics.notify(new Int32Array(4), 0)].join());

// the namespace as a value
report("value", () => [typeof Atomics, Object.prototype.toString.call(Atomics), typeof (Atomics as any).load].join());
const ops: any = Atomics;
report("dynamic", () => [ops.add(i32, 2, 1), ops.load(i32, 2), ops.compareExchange(i32, 2, i32[2], 0), i32[2]].join());
