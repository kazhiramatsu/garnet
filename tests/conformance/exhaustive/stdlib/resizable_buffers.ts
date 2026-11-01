// @ts-nocheck
// @oracle esnext
// Resizable buffers: the views follow, what the buffer no longer covers is out of bounds. transfer detaches.
const log = (...a) => console.log(...a);
const name = (f) => { try { return f(); } catch (e) { return e.name; } };
const rab = new ArrayBuffer(8, { maxByteLength: 16 });
log(rab.resizable, rab.maxByteLength, rab.byteLength, new ArrayBuffer(4).resizable, new ArrayBuffer(4).maxByteLength);
const tracking = new Uint8Array(rab), fixed = new Uint8Array(rab, 0, 8), offset = new Uint16Array(rab, 4), past = new Uint8Array(rab, 8);
tracking[7] = 9; tracking[3] = 5;
log(tracking.length, fixed.length, offset.length, past.length, offset.byteLength, offset.byteOffset);
rab.resize(16);
log(rab.byteLength, tracking.length, fixed.length, offset.length, past.length, tracking[7], tracking[15]);
tracking[15] = 7;
rab.resize(6);
log(rab.byteLength, tracking.length, fixed.length, fixed.byteLength, fixed.byteOffset, fixed[0], offset.length, offset.byteOffset, past.length, past.byteOffset);
log(name(() => fixed.fill(1)), name(() => fixed.join()), name(() => [...tracking].length), name(() => tracking.at(3)));
rab.resize(16);
log(fixed.length, tracking[15], tracking[7], tracking[3], past.length, past.byteOffset);
log(name(() => rab.resize(17)), name(() => new ArrayBuffer(4).resize(2)), name(() => ArrayBuffer.prototype.resize.call({}, 1)));
log(name(() => new ArrayBuffer(8, { maxByteLength: 4 })), new ArrayBuffer(4, {}).resizable, new ArrayBuffer(4, 1).resizable, new ArrayBuffer(4, { maxByteLength: undefined }).resizable);
log(Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable").get.name, ArrayBuffer.prototype.resize.length, ArrayBuffer.prototype.transfer.length);
const s = new ArrayBuffer(4); const v = new Uint8Array(s); v[1] = 3;
const t = s.transfer();
log(s.detached, s.byteLength, v.length, v.byteLength, v.byteOffset, v[1], t.byteLength, new Uint8Array(t)[1], t.resizable);
log(name(() => s.transfer()), name(() => new Uint8Array(s)), name(() => v.fill(0)), name(() => s.slice(0)), name(() => s.resize(1)));
const r2 = new ArrayBuffer(2, { maxByteLength: 8 });
const r3 = r2.transfer(4), f3 = r3.transferToFixedLength();
log(r3.detached, r2.detached, f3.byteLength, f3.resizable, r3.resizable, new ArrayBuffer(4).transfer(2).byteLength, new ArrayBuffer(4).transfer(8).byteLength);
const grow = new SharedArrayBuffer(4, { maxByteLength: 8 });
const gv = new Uint8Array(grow);
log(grow.growable, grow.maxByteLength, gv.length, new SharedArrayBuffer(4).growable);
grow.grow(8); log(grow.byteLength, gv.length, name(() => grow.grow(4)), name(() => grow.grow(9)));
for (const T of [Int16Array, Float64Array]) {
  const b = new ArrayBuffer(16, { maxByteLength: 64 }), x = new T(b);
  x[0] = 1; b.resize(64); x[x.length - 1] = 2; b.resize(T.BYTES_PER_ELEMENT * 3);
  log(x.length, x[0], [...x].length, x.map((e) => e + 1).length);
}
class G extends ArrayBuffer {} const g = new G(2, { maxByteLength: 4 }); g.resize(4); log(g.byteLength, g instanceof G);
