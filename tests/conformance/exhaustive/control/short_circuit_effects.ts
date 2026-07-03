function main(): void {
  let log: string[] = [];
  const t = (s: string, v: any): any => { log.push(s); return v; };
  // && / || must not evaluate RHS when short-circuited.
  const a = t("a", false) && t("b", true); log.push("|");
  const b = t("c", true) || t("d", false); log.push("|");
  const c = t("e", null) ?? t("f", 9);
  console.log(a, b, c, log.join(","));            // false true 9 a,|,c,|,e,f
  // ternary only evaluates the taken branch.
  log = [];
  const d = (1 > 0 ? t("x", 1) : t("y", 2));
  console.log(d, log.join(","));                  // 1 x
  // optional chaining short-circuits the call.
  const o: any = null;
  console.log(o?.foo(), o?.bar ?? "def");         // undefined def
  // comma operator
  let i = 0;
  const e = (i++, i++, i);
  console.log(e, i);                              // 2 2
}
main();
