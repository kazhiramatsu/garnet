import { isIntKey, scale, setFactor, tagged } from "./index";
const keys = ["0", "1", "10", "-1", "01", "NaN", "x", "4294967295", 5 as unknown as string];
let n = 0;
for (let r = 0; r < 1000; r++) for (const k of keys) if (isIntKey(k)) n++;
const a = scale(3);
setFactor(5);
const b = scale(3);
console.log(n, a, b, tagged("y"), [1, 2, 3].map((v) => scale(v)).join(","), [4, 5].map(scale).join(","));
