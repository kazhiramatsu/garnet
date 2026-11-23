import { make, plain, value, Host } from "./lib";
const h: Host = { name: "n", size: "big" };    // error here
const m = make(h);
const s: number = m.get();                      // error here
const t: string = plain(1);                     // error here
value.n.toFixed().missing;                      // error here
make();                                         // error here
