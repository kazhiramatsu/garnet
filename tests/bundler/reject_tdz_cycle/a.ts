// EXPECT-REJECT
import { bConst } from "./b";
export const aConst = 1;
console.log("a sees b:", bConst);
