function compile(pattern: any, flags?: any): RegExp { return new RegExp(pattern, flags); }
const re = compile("a+", "ig");
console.log(re.source, re.flags, re.test("AA"), re.lastIndex, re.test("BA"), re.lastIndex);
for (const pattern of ["", "/", "\\/", "\\\\/", "[/]", "\n", "\\\n", "\r", "\u2028", "😀", "\ud800"]) {
  const result = compile(pattern);
  console.log(JSON.stringify(result.source), result.test(pattern));
}
const original = compile("b+", "g");
original.lastIndex = 3;
const clone = compile(original);
console.log(clone !== original, clone.source, clone.flags, clone.lastIndex);
function identity(pattern: any): RegExp { return RegExp(pattern); }
console.log(identity(original) === original);
for (const flags of ["gg", "uv", "z"]) {
  try { compile("x", flags); }
  catch (error) { console.log(error instanceof SyntaxError); }
}
try { compile("("); }
catch (error) { console.log(error instanceof SyntaxError); }
const trace: string[] = [];
const pattern = { toString() { trace.push("pattern"); return "c+"; } };
const flags = { toString() { trace.push("flags"); return "i"; } };
console.log(compile(pattern, flags).test("CC"), trace.join(","));
try { compile(Symbol("x")); }
catch (error) { console.log(error instanceof TypeError); }
