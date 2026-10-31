// @ts-nocheck
var n = 0;
const o = { x: 1, y: 2, z: null };
const f = () => (n++, o);
const a = [1, 2, 3];
var i = 0;
f().x++; console.log(o.x, n);
--f().x; console.log(o.x, n);
a[i++]++; console.log(a.join(), i);
a[i++] += 5; console.log(a.join(), i);
f()["y"]--; console.log(o.y, n);
f().x ||= 9; console.log(n);
f().z ??= 9; console.log(o.z, n);
f().x &&= 3; console.log(o.x, n);
a[i++] ||= 8; console.log(a.join(), i);
class C { #v = 0; get acc() { n++; return this.#v; } set acc(x) { n += 10; this.#v = x; } }
const c = new C(); const gc = () => (n = 0, c);
gc().acc++; console.log(c.acc, n);
gc().acc += 2; console.log(c.acc, n);
gc().acc ||= 1; console.log(c.acc, n);
gc().acc = 8; console.log(c.acc, n);
// the object of a simple assignment comes before the value
var seq = [];
const g = () => (seq.push("obj"), c);
const h = () => (seq.push("val"), 1);
g().acc = h(); console.log(seq.join());
