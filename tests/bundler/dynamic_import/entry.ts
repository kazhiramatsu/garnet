// import() of a bundled module: evaluated when it is asked for, once; a failure kept; a top-level await; a cycle.
import { shared, bump } from "./shared";
console.log("main start", shared);
const m = await import("./lazy");
console.log(Object.keys(m), m.default, m.value, m.fn(2), m.K.name, new m.K().v);
console.log(m === await import("./lazy"), Object.prototype.toString.call(m), Object.getPrototypeOf(m), Object.isExtensible(m));
bump(); console.log(m.seen());
m.setValue(9); console.log(m.value);
const s = await import("./shared");
console.log(s.shared, Object.keys(s));
try { await import("./bad"); } catch (e: any) { console.log("caught", e.message); }
try { await import("./bad"); } catch (e: any) { console.log("caught again", e.message); }
const t = await import("./tla");
console.log(t.x, t.y);
const cyc = await import("./cycle-a");
console.log(cyc.a(), cyc.b2);
const later = () => import("./later");
console.log("before later");
(await later()).hello();
console.log("then", typeof (await import("./thenable")));
const c = await import("./closures");
console.log(c.fns.map((f: any) => f()), c.getBlock());
console.log("main end");
