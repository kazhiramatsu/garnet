// Runtime string methods that allocate from an existing heap string must not keep
// raw data pointers across GC safepoints. This stresses slice/copy, split,
// replace expansion, padding, string enumeration, and array-like string reads.
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

const source = "  alpha,beta,gamma  ";
churn(70000);
console.log(source.trim().slice(0, 5)); // alpha
churn(70000);
console.log(source.substring(9, 14).toUpperCase()); // ETA,G
churn(70000);
console.log("ab".repeat(3), "7".padStart(3, "0"), "7".padEnd(3, ".")); // ababab 007 7..
churn(70000);
console.log("a,b,c".split(",").join("|")); // a|b|c
churn(70000);
console.log("abcde".replace("cd", "<$`|$&|$'>")); // ab<ab|cd|e>e
churn(70000);
console.log("abc".replaceAll("", "X")); // XaXbXcX
churn(70000);
console.log(Array.from("xyz").join("-")); // x-y-z
churn(70000);
console.log(Object.keys("pq").join(","), Object.getOwnPropertyDescriptor("pq", "1")!.value); // 0,1 q
churn(70000);
console.log("hello".charAt(1), "world".charAt(2), "world".at(-1)); // e r d
