const t = (name: string, f: () => unknown) => { try { console.log(name, f()); } catch (e: any) { console.log(name, "THROW", e.name, e.message); } };
function runtimePattern(p: string, s: string) { return [s.match(p)?.[0], s.search(p), [...s.matchAll(p as any)].length]; }
t("run time", () => runtimePattern(process.argv.length > 5 ? "z" : "b+", "abbc"));
t("literal recv", () => { const p: string = process.argv.length > 5 ? "z" : "b"; return ["abc".search(p), "abc".match(p)?.index]; });
t("undefined", () => { const a: any = undefined; return ["abc".match(a)?.[0], "abc".search(a)]; });
t("null", () => { const a: any = null; return ["anullb".match(a)?.index, "anullb".search(a)]; });
t("number", () => { const a: any = 1; return ["a1".match(a)?.index, "a1".search(a)]; });
t("to sym", () => "x".concat({ toString() { return Symbol() as any; } } as any));
t("String to sym", () => String({ toString() { return Symbol() as any; } }));
t("tpl to sym", () => `${{ toString() { return Symbol() as any; } }}`);
