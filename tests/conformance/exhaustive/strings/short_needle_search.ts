// indexOf / lastIndexOf / includes with short (immediate) needles against a long
// one-byte text, a UTF-16 text and a sliced view; the two-unit needle is a
// comment's closing marker, as a scanner searches for it.
function main() {
  let text = "";
  for (let i = 0; i < 40; i++) text += "line " + i + " /* note " + i + " */ x = y; // t\n";
  const out: (number | boolean)[] = [];
  let pos = 0;
  for (let k = 0; k < 10; k++) {
    const open = text.indexOf("/*", pos);
    const close = text.indexOf("*/", open);
    out.push(open, close, text.indexOf("\n", close), text.lastIndexOf("\n", close));
    pos = close + 2;
  }
  out.push(text.indexOf("*/", text.length - 3), text.indexOf("*/", -5), text.indexOf("zz"), text.indexOf(""), text.indexOf("", 1000));
  out.push(text.lastIndexOf("/*"), text.lastIndexOf("//"), text.lastIndexOf("y;", 100), text.lastIndexOf("ab"));
  out.push(text.includes("*/"), text.includes("*/x"), text.startsWith("li"), text.endsWith("t\n"));
  const wide = "α" + text + "ω";
  out.push(wide.indexOf("*/"), wide.indexOf("ω"), wide.lastIndexOf("/*"), wide.indexOf("\n", 5), wide.indexOf("αl"));
  const view = text.slice(7, 200);
  out.push(view.indexOf("*/"), view.lastIndexOf("*/"), view.indexOf("\n"), view.indexOf("x = y"));
  const needle = "*" + "/";
  out.push(text.indexOf(needle), text.indexOf(needle, 14), text.indexOf("*/*"), "a*/b".indexOf("*/"), "*".indexOf("*/"), "".indexOf("*/"));
  console.log(out.join(","));
}
main();
