// @ts-nocheck
// A JSON number, by the grammar: strtod's other forms are errors, and a value that does not fit the integer path is read
// whole wherever it ends. Before: `01` and `1.` were accepted, a bare number of sixteen digits or more lost the rest
// (`"12345678901234567890"` was 1234567890123456, silent), a literal's `1e400` crashed the analyzer and its `-0` was 0.
const t = (s) => { try { const v = JSON.parse(s); console.log(JSON.stringify(s), "->", v, Object.is(v, -0)); } catch (e) { console.log(JSON.stringify(s), e.name); } };
for (const s of ["01", "00", "-01", "1.", "-1.", "1.e5", ".5", "-.5", "1e", "1e+", "1E-", "0x10", "+1", "Infinity", "-Infinity", "NaN", "inf", "nan", "1e400", "-1e400", "1e-400", "-0", "0", "-0.0", "0e0", "1E2", "1.5e3",
  "1234567890123456", "12345678901234567", "12345678901234567890", "-12345678901234567890", "1.7976931348623157e308", "5e-324", "2.2250738585072011e-308", "9007199254740993", "0.1", "[01]", "[1.]", '{"a":01}', '{"a":1.}', "[1e]", "[-]", "-", "[.5]", "1 2", "1,", "[1,]"]) t(s);
const j = (s) => { try { return JSON.parse(s, (k, v) => v); } catch (e) { return e.name; } };
console.log(j("01"), j("1."), j("[01]"), j("1e400"), j("[1.]"), j("12345678901234567890"));

// a slice of a longer string: the digits go on past the slice's end
const s1 = "1.2345", s2 = "123456789012345678901234567890", s3 = "2e10", s4 = "[1.5,2.5e3,99999999999999999999]";
console.log(JSON.parse(s1.slice(0, 3)), JSON.parse(s2.slice(0, 18)), JSON.parse(s2.slice(0, 20)), JSON.parse(s3.slice(0, 1)), JSON.parse(s4.slice(0, s4.length)), JSON.parse(s4.slice(1, 4)), JSON.parse(s4.slice(5, 10)), JSON.parse(s4.slice(11, 31)));
const long = "1." + "3".repeat(100) + "e-5";
console.log(JSON.parse(long), JSON.parse("[" + long + "]"));

// a literal, parsed by the compiler: `1e400` has no JSON form in its output
console.log(JSON.parse("1e400"), JSON.parse("-1e400"), JSON.parse("-0"), JSON.parse("[-0]"), JSON.parse('{"e":-0}'));
const dom = JSON.parse('{"a":1e400,"b":-1e400,"c":1e-400,"d":12345678901234567890,"e":-0}');
console.log(dom.a, dom.b, dom.c, dom.d, dom.e, Object.is(dom.e, -0));
const dom2 = JSON.parse("[1e400]"); console.log(dom2[0]);
const dom3: any = JSON.parse('{"x":{"y":[1.5e308,1e309]}}'); console.log(dom3.x.y[1]);
function typed() { const c = JSON.parse('{"port":1e999}') as { port: number }; return c.port; }
console.log(typed());
