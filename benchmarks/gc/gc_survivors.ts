// GC bench: 生存オブジェクト（昇格 + full GC 圧）。10 万個の live set を
// 回転させながら alloc し続ける — minor 昇格と full mark/sweep の両方を踏む。
function main(): void {
  const keep: { v: number }[] = [];
  let acc = 0;
  for (let i = 0; i < 1500000; i++) {
    const o = { v: i };
    if (keep.length < 100000) keep.push(o);
    else keep[i % 100000] = o;
    acc = (acc + o.v) % 1000000007;
  }
  let s = 0;
  for (let k = 0; k < keep.length; k += 997) s += keep[k].v;
  console.log("gc_survivors " + (acc + s));
}
main();
