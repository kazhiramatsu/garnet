// @ts-nocheck
// Every trap gets a property key: the defineProperty trap of Object.defineProperty and Reflect.defineProperty got a number
// key as the number, and a handler typed by ProxyHandler stopped at the check of a value typed as a string.
const log = [];
const h = { defineProperty(t, k, d) { log.push(typeof k + ":" + String(k)); return Reflect.defineProperty(t, k, d); }, getOwnPropertyDescriptor(t, k) { log.push("gopd " + typeof k); return Reflect.getOwnPropertyDescriptor(t, k); } };
const t = (n, f) => { log.length = 0; try { console.log(n, f(), log.join(",")); } catch (e) { console.log(n, e.name, e.message, log.join(",")); } };
t("number key", () => Object.defineProperty(new Proxy({ c: 1 }, h), 0, { value: 1, configurable: true }));
t("string key", () => Object.defineProperty(new Proxy({ c: 1 }, h), "0", { value: 1, configurable: true }));
t("name key", () => Object.defineProperty(new Proxy({ c: 1 }, h), "x", { value: 1, configurable: true }));
t("reflect number", () => Reflect.defineProperty(new Proxy({}, h), 7, { value: 1, configurable: true }));
t("set number", () => { const p = new Proxy({}, { set(t, k, v) { log.push(typeof k); t[k] = v; return true; } }); p[3] = 1; return Object.keys(p); });
t("get number", () => { const p = new Proxy({ 3: "x" }, { get(t, k) { log.push(typeof k); return t[k]; } }); return p[3]; });
t("has number", () => { const p = new Proxy({ 3: "x" }, { has(t, k) { log.push(typeof k); return k in t; } }); return 3 in p; });
t("delete number", () => { const p = new Proxy({ 3: "x" }, { deleteProperty(t, k) { log.push(typeof k); return delete t[k]; } }); return delete p[3]; });
