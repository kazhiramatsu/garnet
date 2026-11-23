import { q, ini, pat, fine } from "./lib";
const x: string = q(1);
const y: string = ini();
pat({ a: "no", b: 2 });
const z: number = fine(1, 2, 3);
fine(1).then((v) => v.missing);
