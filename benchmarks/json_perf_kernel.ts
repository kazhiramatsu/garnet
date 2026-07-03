class JsonRec {
  id: number;
  x: number;
  y: number;
  tag: string;
  constructor(id: number, x: number, y: number, tag: string) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.tag = tag;
  }
}

function kernel(N: number): number {
  let acc = 0;
  let i = 0;
  while (i < N) {
    const r = new JsonRec(i % 1000, (i * 3) % 997, (i * 7) % 991, (i & 1) ? "odd" : "even");
    const flatLen = JSON.stringify(r).length;
    const nestedLen = JSON.stringify({ id: r.id, nums: [r.x, r.y, i & 7], meta: { tag: r.tag, ok: true } }).length;
    const prettyLen = JSON.stringify({ a: r.x, b: [r.y, r.id] }, null, 2).length;
    const parsedA: number = JSON.parse("11");
    const parsedB: number = JSON.parse("5");
    const parsedD: number = JSON.parse("7");
    const parsedMore: number =
      JSON.parse("13") + JSON.parse("17") + JSON.parse("19") + JSON.parse("23") +
      JSON.parse("29") + JSON.parse("31") + JSON.parse("37") + JSON.parse("41") +
      JSON.parse("43") + JSON.parse("47") + JSON.parse("53") + JSON.parse("59") +
      JSON.parse("61") + JSON.parse("67") + JSON.parse("71") + JSON.parse("73") +
      JSON.parse("79") + JSON.parse("83") + JSON.parse("89") + JSON.parse("97") +
      JSON.parse("101") + JSON.parse("103") + JSON.parse("107") + JSON.parse("109") +
      JSON.parse("113") + JSON.parse("127") + JSON.parse("131") + JSON.parse("137");
    acc = (acc + flatLen + nestedLen + prettyLen + parsedA + parsedB + parsedD + parsedMore + r.y) % 1000000007;
    i = i + 1;
  }
  return acc;
}

function main(): void {
  console.log(kernel(20000));
}

main();
