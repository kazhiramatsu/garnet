// A megamorphic site's absent read is answered in the leaf from the global absent table (Session 356):
// one site over more shapes than the site cache holds, with arrays, primitives and a Proxy among the
// receivers, and the prototypes changed between the reads (the key added to Object.prototype, to one
// object's own prototype, to an intermediate prototype, then removed again).
function isMarked(v: any): boolean { return v ? v.__marker === true : false; }
function main() {
  const objs: any[] = [];
  for (let i = 0; i < 24; i++) {
    const o: any = {};
    for (let j = 0; j <= i; j++) o["k" + j] = j;      // a distinct shape per object
    objs.push(o);
  }
  const proto: any = { base: 1 };
  const child: any = Object.create(proto); child.x = 1;
  const grand: any = Object.create(child); grand.y = 2;
  const px: any = new Proxy({ a: 1 }, { get(t: any, k: any) { return k === "__marker" ? true : t[k]; } });
  const all: any[] = [...objs, [1, 2], "str", 5, true, child, grand, px, { __marker: true }, { __marker: false }];
  const count = () => { let n = 0; for (let r = 0; r < 20; r++) for (const v of all) if (isMarked(v)) n++; return n; };
  const out: number[] = [count()];
  (Object.prototype as any).__marker = true;            // every plain object and array now inherits it
  out.push(count());
  delete (Object.prototype as any).__marker;
  out.push(count());
  proto.__marker = true;                                // child and grand inherit it
  out.push(count());
  child.__marker = false;                               // an intermediate shadows it for grand
  out.push(count());
  delete child.__marker; delete proto.__marker;
  out.push(count());
  (Array.prototype as any).__marker = true;
  out.push(count());
  delete (Array.prototype as any).__marker;
  objs[3].__marker = true;                              // an own addition on one receiver
  out.push(count());
  Object.setPrototypeOf(grand, { __marker: true });
  out.push(count());
  console.log(out.join(","));
}
main();
