function main(): void {
  const a: any = [10, 20, 30];
  console.log(Object.keys(a).join(","));        // 0,1,2
  console.log(Object.values(a).join(","));      // 10,20,30
  a.custom = 99;
  console.log(Object.keys(a).join(","));         // 0,1,2,custom
  console.log(JSON.stringify(a));                // [10,20,30]
  const b: any = ["x", "y"];
  const o = { ...b };                            // spread array -> {0,1}
  console.log(JSON.stringify(o));                // {"0":"x","1":"y"}
  const t: any = {}; Object.assign(t, b);
  console.log(t[0], t[1]);                       // x y
  const e = Object.entries(b);
  console.log(JSON.stringify(e));                // [["0","x"],["1","y"]]
}

main();
