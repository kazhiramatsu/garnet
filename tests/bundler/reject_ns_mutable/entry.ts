import * as m from "./m";
import * as again from "./m";
function read(): number { return m.c; }
class Reader { read(): number { return m.c; } }
m.inc(); console.log(m.c, read(), new Reader().read(), m === again);
m.inc(); console.log(m.c, read(), new Reader().read());
console.log(Object.keys(m).join(","), Object.getPrototypeOf(m) === null, Object.isExtensible(m));
try { (m as any).c = 10; } catch (error) { console.log(error instanceof TypeError); }
console.log(m.c, m.fixed);
