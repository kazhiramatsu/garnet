import * as api from "./api";
const { f1, f2 } = api;
console.log(f1() + f2(), Object.keys(api).sort().join(","));
