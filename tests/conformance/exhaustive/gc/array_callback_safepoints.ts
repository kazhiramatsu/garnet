// Array callbacks are GC safepoints: map/filter/find/some/every/reduce/sort must
// keep the receiver, callback, accumulator, and result array as handles and
// re-fetch raw array pointers after each callback.
function churn(n: number): number {
  let i = 0;
  let sum = 0;
  while (i < n) {
    const o: any = { value: i };
    sum += o.value;
    i++;
  }
  return sum;
}

const xs = [1, 2, 3, 4, 5];
console.log(xs.map((x) => { churn(70000); return x * 2; }).join(",")); // 2,4,6,8,10
console.log(xs.filter((x) => { churn(70000); return x % 2 === 1; }).join(",")); // 1,3,5

let seen = 0;
xs.forEach((x) => { churn(70000); seen += x; });
console.log(seen); // 15

console.log(xs.find((x) => { churn(70000); return x > 3; })); // 4
console.log(xs.findIndex((x) => { churn(70000); return x === 4; })); // 3
console.log(xs.some((x) => { churn(70000); return x === 5; }), xs.every((x) => { churn(70000); return x > 0; })); // true true
console.log(xs.reduce((a, b) => { churn(70000); return a + b; }, 0)); // 15

const ys = [3, 1, 4, 2];
console.log(ys.sort((a, b) => { churn(70000); return a - b; }).join(",")); // 1,2,3,4

const zs = ["b", "aa", "c", "10", "2"];
churn(70000);
console.log(zs.sort().join(",")); // 10,2,aa,b,c
