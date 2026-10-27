import { A } from "./a";
import { births } from "./b";
const a = new A();
const b = a.make();
const b2 = a.make();
console.log(b.owner === a, b.peer instanceof A, b.peer !== a, b.peer.tag, b.serial, b2.serial, births);
