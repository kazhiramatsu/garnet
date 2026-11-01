// A cast that lies, used where a boxed value keeps its meaning, agrees with V8: hono's
// `(str as unknown as string).toString()` written with number, Date subtraction, a concatenation. An array-like
// behind an array type takes the dynamic path. What flows into a number slot: tests/cast_number_gate.sh.
const t = (name: string, f: () => unknown) => { try { console.log(name, f()); } catch (e: any) { console.log(name, "throws", e.name); } };
class P { x = 1; label = "p"; get() { return this.x + 1; } }
t("number cast of a number", () => { const u: unknown = 5; return (u as number) + 1; });
t("from a union", () => { const u: string | number = [3][0]; return (u as number) * 2; });
t("placeholder", () => { let n = undefined as unknown as number; n = 7; return n + 1; });
t("null placeholder", () => { let n = null as unknown as number; n = 2; return n; });
t("enum", () => { enum E { A, B } const u: unknown = 1; return (u as E) === E.B; });
t("literal", () => { const u: unknown = 2; return (u as 1 | 2) + 1; });
t("array-like length", () => { const a = { length: 2, 0: 7 } as unknown as number[]; return [a[0], a.length]; });
t("array-like push", () => { const a = { length: 0 } as unknown as number[]; return a.push(1); });
t("array-like own push", () => { const a = { length: 0, push(v: number) { return v * 2; } } as unknown as number[]; return a.push(4); });
t("array-like in place", () => ({ length: 3 } as unknown as number[]).length);
t("string as array", () => { const s = "abc" as unknown as string[]; return [s.length, s.slice(1)]; });
t("class from a literal", () => { const p = { x: 5 } as unknown as P; return p.x; });
t("class from a number", () => { const p = 7 as unknown as P; return (p as any).x; });
t("class from null", () => { const p = null as unknown as P; return p.x; });
t("function from a number", () => { const f = 5 as unknown as () => number; return f(); });
t("number cast, concatenation", () => { const r: unknown = ("abc" as unknown as number) + 1; return r; });
t("number cast, chain", () => { const r: unknown = ("abc" as unknown as number) + 1 + 2; return r; });
t("number cast, method", () => ({ toString() { return "own"; } } as unknown as number).toString());
t("number cast, Date subtraction", () => { const a = new Date(5000), b = new Date(2000); return (a as unknown as number) - (b as unknown as number); });
t("number cast, valueOf", () => ({ valueOf() { return 4; } } as unknown as number) * 2);
t("number cast, typeof", () => typeof ("s" as unknown as number));
t("number cast, compare", () => ("5" as unknown as number) === 5);
t("number cast, loose", () => ("5" as unknown as number) == 5);
t("number cast, unary", () => -("3" as unknown as number));
t("number cast, template", () => `${"t" as unknown as number}`);
t("number cast, console", () => { console.log("y" as unknown as number); return 1; });
t("map get", () => { const m = new Map([["a", 1]]); return (m.get("a") as number) + 1; });
t("from any", () => { const a: any = [1, 2]; return (a[1] as number) * 3; });
