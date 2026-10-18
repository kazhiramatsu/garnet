interface Counter { value: number; step(delta: number): number }
class Box implements Counter {
  value = 1;
  step(delta: number): number { this.value += delta; return this.value; }
}
function run(counter: Counter): number { return counter.step(2) + counter.value; }
const box = new Box();
const plain: Counter = { value: 3, step(delta) { this.value += delta; return this.value; } };
for (let i = 0; i < 8; i++) console.log(run(i & 1 ? box : plain));
const dynamic: any = box;
dynamic.step = function (delta: number): number { return 100 + delta; };
console.log(run(box));
delete dynamic.step;
console.log(run(box));
let reads = 0;
const accessor: Counter = { value: 5, step(delta) { return delta; } };
Object.defineProperty(accessor, "step", {
  configurable: true,
  get() { reads++; return (delta: number) => delta + reads; },
});
for (let i = 0; i < 4; i++) console.log(run(accessor));
console.log(reads);
