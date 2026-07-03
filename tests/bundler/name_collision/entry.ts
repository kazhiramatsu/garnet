import { fromA } from "./a";
import { fromB } from "./b";
function helper() { return "entry-helper"; }
console.log(fromA(), fromB(), helper());
