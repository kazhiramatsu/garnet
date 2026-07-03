class Point { x = 1; toString(): string { return "Point!"; } }
class Plain { v = 5; }
function main(): void {
  const o: any = { a: 1 };
  console.log(o.toString());
  console.log("" + o);
  console.log(o.valueOf() === o);
  console.log("toString" in o, "valueOf" in o, "nope" in o);
  console.log(o.hasOwnProperty("a"), o.hasOwnProperty("toString"));
  const pl: any = new Plain();
  console.log(pl.toString(), pl.valueOf() === pl);
  const p: any = new Point();
  console.log(p.toString());
  console.log(Object.keys(o).join(","));
  console.log(JSON.stringify(o));
}

main();
