// A site over many shapes (Session 356, docs/hidden_class_design.md S1): a site that has recorded an
// absent read answers its other receivers from the global absent table in the leaf, and the present
// reads, the generic read, Reflect.get and `in` resolve through the shape caches. Everything that can
// change an answer after a cache filled must be seen: a value replaced on the holder prototype, the
// holder gaining and losing the key, a receiver gaining an own key that shadows the prototype's and
// deleting it again, a relink to another prototype, a dictionary-mode receiver, an accessor defined
// on the prototype, a frozen receiver, a getter read through Reflect.get with a foreign receiver.
const proto: any = { shared: "p", method() { return "m:" + this.tag; } };
function mk(i: number): any {           // a distinct shape per object, all behind `proto`
  const o: any = Object.create(proto);
  for (let j = 0; j <= i; j++) o["k" + j] = j;
  o.tag = "t" + i;
  return o;
}
function readShared(o: any) { return o.shared; }      // one site over every shape: megamorphic
function readTag(o: any) { return o.tag; }
function has(o: any, k: string) { return k in o; }
function main() {
  const objs: any[] = [];
  for (let i = 0; i < 24; i++) objs.push(mk(i));
  const sum = () => objs.map((o) => readShared(o) + readTag(o) + (has(o, "shared") ? 1 : 0) + (has(o, "zz") ? 1 : 0) + o.method()).join(",");
  const out: string[] = [sum()];
  proto.shared = "p2";                                   // replaced in place on the holder
  out.push(sum());
  objs[3].shared = "own3";                              // an own key shadows the prototype's
  out.push(sum());
  delete objs[3].shared;
  out.push(sum());
  delete proto.shared;                                   // the holder loses the key
  out.push(sum());
  proto.shared = "p3";                                   // and regains it
  out.push(sum());
  Object.setPrototypeOf(objs[5], { shared: "other", tag: "ot", method() { return "om"; } });   // a relink
  out.push(sum());
  const dict = objs[7];
  for (let j = 0; j <= 7; j++) delete dict["k" + j];     // a dictionary-mode receiver
  dict.shared = "dict";
  out.push(sum());
  Object.defineProperty(proto, "shared", { get() { return "acc:" + this.tag; }, configurable: true });   // an accessor on the holder
  out.push(sum());
  Object.freeze(objs[9]);
  out.push(sum());
  const foreign = { tag: "foreign" };
  out.push(String(Reflect.get(objs[1], "shared", foreign)), String(Reflect.get(objs[1], "tag", foreign)), String(Reflect.get(objs[1], "zz", foreign)));
  delete (proto as any).shared;
  (Object.prototype as any).shared = "root";             // the key on the root prototype
  out.push(sum());
  delete (Object.prototype as any).shared;
  out.push(sum());
  console.log(out.join("\n"));
}
main();
