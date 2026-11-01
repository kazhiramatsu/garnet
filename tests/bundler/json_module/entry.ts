// A JSON module: the default export, the namespace, `with { type: "json" }`.
import data from "./d.json" with { type: "json" };
import * as ns from "./d.json" with { type: "json" };
console.log(data, ns.default === data, data.b[1] + 1);
const late = await import("./late");
console.log(late.value);
