// A value out of JSON cast to a type: what the file holds counts, not what the type says. In place the reads agree with
// V8; what flows into a number slot is tests/cast_number_gate.sh.
const t = (name: string, f: () => unknown) => { try { console.log(name, f()); } catch (e: any) { console.log(name, "throws", e.name); } };
interface Inner { n: number }
interface Config { port: number; name: string; tags: string[]; nested: Inner; items: Inner[]; opt?: number; on: boolean }
class Cfg { port = 0; name = ""; }
const raw = '{"port":"8080","name":7,"tags":"x","nested":{"n":"deep"},"items":[{"n":"e"}],"on":"yes"}';
const cfg = () => JSON.parse(raw) as Config;
const empty = () => JSON.parse("{}") as Config;
t("concat", () => { const r: unknown = cfg().port + 1; return r; });
t("multiply", () => cfg().port * 2);
t("typeof", () => typeof cfg().port);
t("compare", () => cfg().port === 8080);
t("loose", () => { const r: unknown = cfg().port == 8080; return r; });
t("inferred local", () => { const p = cfg().port; const r: unknown[] = [p, typeof p]; return r; });
t("destructured", () => { const { port, name } = cfg(); const r: unknown[] = [port, typeof port, name, typeof name]; return r; });
t("nested", () => { const r: unknown = cfg().nested.n; return r; });
t("nested concat", () => { const r: unknown = cfg().nested.n + "!"; return r; });
t("in a list", () => { const r: unknown = cfg().items[0].n; return r; });
t("for of", () => { const out: unknown[] = []; for (const i of cfg().items) out.push(i.n, typeof i.n); return out; });
t("string concat", () => cfg().name + "!");
t("array field length", () => cfg().tags.length);
t("bool", () => cfg().on === true);
t("into a literal", () => { const c = cfg(); const o = { port: c.port }; const r: unknown = (o as any).port; return r; });
t("into an array", () => { const c = cfg(); const a: unknown[] = [c.port]; return a; });
t("to any", () => { const c = cfg(); console.log(c.port); return 1; });
t("template", () => `${cfg().port}`);
t("truthy", () => (cfg().port ? "yes" : "no"));
t("missing ===", () => empty().port === undefined);
t("missing ==", () => empty().port == null);
t("missing ??", () => empty().port ?? 80);
t("missing ||", () => empty().port || 80);
t("missing typeof", () => typeof empty().port);
t("missing +", () => empty().port * 1);
t("missing opt", () => empty().opt ?? 3);
t("missing str", () => { const r: unknown = empty().name; return r; });
t("missing arr", () => { const r: unknown = empty().tags; return r; });
t("if missing", () => { const c = empty(); if (c.port === undefined) return "absent"; return "present"; });
t("annotation", () => { const c: Config = JSON.parse(raw); const r: unknown = c.port + 1; return r; });
t("through a variable", () => { const v = JSON.parse(raw); const c = v as Config; return typeof c.port; });
t("through a function", () => { const read = (s: string): Config => JSON.parse(s); return typeof read(raw).port; });
t("class type", () => { const c = JSON.parse('{"port":"p"}') as Cfg; const r: unknown = c.port; return r; });
t("class instance still", () => { const c = new Cfg(); c.port = 5; return c.port + 1; });
t("right data", () => { const c = JSON.parse('{"port":80,"name":"n","tags":["a"],"nested":{"n":1},"items":[],"on":true}') as Config; const p: number = c.port; return [p + 1, c.name.length, c.tags.length, c.nested.n * 2]; });
t("number array", () => (JSON.parse("[1,2,3]") as number[]).map((x) => x * 2));
(async () => {
  const res = { json: async () => JSON.parse('{"port":"9"}') };
  const c = (await res.json()) as Config;
  const r: unknown = c.port + 1;
  console.log("awaited", r);
})();

// behind a generic the lib declares: the record's values are the same data
const records = JSON.parse('{"a":{"port":"8080"}}') as Record<string, { port: number; host?: string }>;
console.log(records.a.port + 1, records.a.host === undefined, typeof records.a.port);
const promised: Promise<{ port: number }> = Promise.resolve(JSON.parse('{"port":"1"}'));
promised.then((c) => console.log(c.port + 1, typeof c.port));
