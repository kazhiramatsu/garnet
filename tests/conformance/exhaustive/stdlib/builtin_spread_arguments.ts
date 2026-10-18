const values = [1, 2];
console.log(values.push(...[3, 4], 5), values.join(","));
values.unshift(...[7, 8]);
console.log(values.splice(1, 2, ...[9, 10, 11]).join(","), values.join(","));
console.log(String.fromCharCode(...[65, 0xd83d, 0xde00]), Math.max(...[3, 7], 5));

const source = [1, 2];
const target: number[] = [];
function change(): number { source[0] = 99; source.push(3); return 4; }
target.push(...source, change(), ...source);
console.log(target.join(","));

function collect(...args: any[]): string { return args.join("|"); }
function* numbers(): Generator<number> { yield 4; yield 5; }
console.log(collect(..."a😀", ...new Set([2, 3]), ...numbers()));
const trace: string[] = [];
const iterable = {
  [Symbol.iterator]() {
    let i = 0;
    return {
      get next() {
        trace.push("get-next");
        return () => ({ done: i >= 2, value: ++i });
      },
    };
  },
};
console.log(collect(...iterable), trace.join(","));
try { collect(...(123 as any)); }
catch (e) { console.log(e instanceof TypeError); }
function changeCallee(): void {
  let f = (...args: number[]) => "old:" + args.join(",");
  console.log(f(...[1], (f = (...args: number[]) => "new:" + args.join(","), 2)));
}
changeCallee();
