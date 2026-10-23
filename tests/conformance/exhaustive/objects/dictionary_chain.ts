// Dictionary-like objects built one key at a time (an enum's maps, a table of
// hundreds of entries): a long chain of keys, a branch off the chain, prefixes
// that stop early, deletion, and enumeration order throughout.
function main() {
  const big: Record<string, number> = {};
  const branch: Record<string, number> = {};
  const prefix: Record<string, number> = {};
  for (let i = 0; i < 700; i++) {
    big["k" + i] = i;
    if (i < 350) branch["k" + i] = 1000 + i;
    if (i < 120) prefix["k" + i] = 2000 + i;
  }
  branch["other"] = -1;
  let sum = 0;
  for (let i = 0; i < 700; i++) sum += big["k" + i];
  const out: unknown[] = [sum, Object.keys(big).length, big["k699"], big["other"], big["k700"]];
  out.push(branch["k349"], branch["k350"], branch["other"], Object.keys(branch).length, Object.keys(branch)[350]);
  out.push(prefix["k119"], prefix["k120"], prefix["k699"], "k120" in prefix, "k119" in prefix, Object.keys(prefix).length);
  prefix["k120"] = 7;
  out.push(prefix["k120"], prefix["k121"], Object.keys(prefix).length, Object.keys(prefix)[120]);
  delete big["k5"];
  out.push(big["k5"], "k5" in big, Object.keys(big).length, Object.keys(big)[5], big["k6"]);
  big["k5"] = 5;
  out.push(Object.keys(big)[699], big["k5"]);
  // an enum's two maps, as the compiled form builds them
  const E: Record<string | number, string | number> = {};
  for (let i = 0; i < 400; i++) { E[E["M" + i] = i] = "M" + i; }
  out.push(E["M0"], E[0], E["M399"], E[399], E[400], Object.keys(E).length, Object.keys(E).slice(0, 4).join("|"), Object.keys(E).slice(400, 403).join("|"));
  const copy = { ...prefix };
  out.push(Object.keys(copy).length, copy["k120"], JSON.stringify(prefix).length);
  console.log(JSON.stringify(out));
}
main();
