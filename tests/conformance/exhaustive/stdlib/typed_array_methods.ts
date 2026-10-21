// Typed array methods (docs/typed_arrays_design.md), on receivers typed as
// views and on `any` receivers (the prototype methods).
function report(label: string, f: () => unknown): void {
  try { console.log(label, f()); }
  catch (e) { console.log(label, "threw", (e as Error).constructor.name, (e as Error).message); }
}
const a = new Int32Array([4, 5, 6]);
const d: any = new Int32Array([4, 5, 6]);

report("subarray", () => { const s = a.subarray(1, 3); s[0] = 42; return [a[1], s.length, s.join()].join(" "); });
report("subarray neg", () => new Uint8Array([1, 2, 3, 4]).subarray(-3, -1).join());
report("slice copies", () => { const s = a.slice(1); s[0] = 99; return [a[1], s.join()].join(" "); });
report("slice conv", () => new Float64Array([1.5, 2.5]).slice(-1).join());
report("fill", () => new Uint8Array(5).fill(3, 1, -1).join());
report("fill conv", () => new Int8Array(2).fill(300 as number).join());
report("set array", () => { const t = new Uint8Array(4); t.set([7, 8], 1); return t.join(); });
report("set view", () => { const t = new Uint8Array(4); t.set(new Uint8Array([9, 8]), 2); return t.join(); });
report("set overlap", () => { const b = new Uint8Array([1, 2, 3, 4, 5]); b.set(b.subarray(0, 3), 2); return b.join(); });
report("set cross type overlap", () => { const b = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]); b.set(new Uint16Array(b.buffer, 0, 2), 1); return b.join(); });
report("set overflow", () => new Uint8Array(2).set([1, 2, 3]));
report("copyWithin", () => new Int8Array([1, 2, 3, 4, 5]).copyWithin(0, 3).join());
report("copyWithin overlap", () => new Uint8Array([1, 2, 3, 4, 5]).copyWithin(1, 0, 3).join());
report("indexOf", () => [a.indexOf(5), a.indexOf(7), a.indexOf(4, 1), a.lastIndexOf(6), new Uint8Array([1, 2, 1, 2]).lastIndexOf(1, -2)].join());
report("includes", () => [a.includes(6), a.includes(6, 3), new Float32Array([NaN]).includes(NaN), new Float32Array([NaN]).indexOf(NaN)].join());
report("join", () => [a.join(), a.join(" - "), new Uint8Array([1, 2]).join(undefined), new Uint8Array(0).join()].join("|"));
report("toString", () => [a.toString(), a.toLocaleString(), d.toString()].join("|"));
report("at", () => [(a as any).at(-1), (a as any).at(5), (a as any).at(1.7)].join());
report("reverse", () => new Int8Array([1, 2, 3]).reverse().join());
report("sort", () => [new Float64Array([3, 1, NaN, -0, 0, 2]).sort().join(), new Uint8Array([10, 9, 1, 100]).sort().join()].join("|"));
report("sort cmp", () => new Int32Array([3, 1, 2]).sort((x, y) => y - x).join());
report("sort stable", () => new Int32Array([21, 12, 22, 11]).sort((x, y) => (x % 10) - (y % 10)).join());
report("forEach", () => { let s = ""; a.forEach((x, i, arr) => { s += i + ":" + x + (arr === a ? ";" : "?"); }); return s; });
report("map", () => { const m = new Int8Array([100, 50]).map((x) => x * 2); return [m.join(), Object.prototype.toString.call(m)].join(" "); });
report("filter", () => { const f = new Int16Array([1, -2, 3]).filter((x) => x > 0); return [f.join(), Object.prototype.toString.call(f)].join(" "); });
report("every some", () => [a.every((x) => x > 0), a.some((x) => x > 5), a.every((x) => x > 4)].join());
report("find", () => [a.find((x) => x > 4), a.findIndex((x) => x > 5), a.find((x) => x > 9), a.findIndex((x) => x > 9)].join());
report("reduce", () => [a.reduce((p, x) => p + x, 0), new Uint8Array([1, 2, 3]).reduce((p, x) => p * 10 + x)].join());
report("reduce empty", () => new Uint8Array(0).reduce((p, x) => p + x));
report("map this", () => new Uint8Array([1, 2]).map(function (this: { k: number }, x) { return x + this.k; }, { k: 5 }).join());
report("bad callback", () => (a as any).map(3));
report("keys values entries", () => [[...a.keys()].join(), [...a.values()].join(), [...a.entries()].join("/")].join("|"));
report("iteration", () => { let s = 0; for (const x of a) s += x; return s; });
report("spread", () => [Math.max(...a), [...new Uint8Array([3, 4])].join()].join());
report("Array.from", () => [Array.from(a).join(), Array.from(a, (x) => x + 1).join()].join("|"));
report("live iterator", () => { const t = new Uint8Array([1, 2, 3]); const it = t.values(); t[2] = 9; return [...it].join(); });
report("not a view", () => Int32Array.prototype.fill.call([1] as any, 0));

// any receivers
report("any index", () => [d[1], d["2"], d[-1], d[1.5], d.length, d.byteLength].join());
report("any map", () => d.map((x: number) => x * 3).join("-"));
report("any method value", () => typeof d.subarray);
report("any slice fill", () => d.slice(1).fill(1).join());
report("any write", () => { d[0] = "12"; d[7] = 1; return [d[0], d[7], d.length].join(); });
