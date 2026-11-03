import { a, b2 } from "./cycle-a";
console.log("cycle b", typeof a);
export function b() { return "b" + b2; }
