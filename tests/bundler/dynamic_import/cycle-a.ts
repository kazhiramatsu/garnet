import { b } from "./cycle-b";
console.log("cycle a");
export function a() { return "a" + b(); }
export const b2 = 2;
