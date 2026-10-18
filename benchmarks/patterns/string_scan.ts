// Scanner-like: charCodeAt loops, substring, comparisons, concatenation.
function isIdent(c: number): boolean { return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || (c >= 48 && c <= 57); }
function main(): void {
  let src = ""; for (let i = 0; i < 400; i++) src += "let value" + i + " = foo(bar" + (i % 9) + ", 'str') + 42; ";
  let idents = 0, keyLets = 0, numSum = 0; let out = "";
  for (let r = 0; r < 2400; r++) {
    let pos = 0; const n = src.length;
    while (pos < n) { const c = src.charCodeAt(pos);
      if (isIdent(c)) { const start = pos; while (pos < n && isIdent(src.charCodeAt(pos))) pos++;
        const word = src.substring(start, pos); if (word === "let") keyLets++; else if (c >= 48 && c <= 57) numSum += word.length; else idents++;
        if (r === 0 && word.length > 8) out += word.charAt(0); }
      else pos++; } }
  console.log(idents, keyLets, numSum, out.length, src.indexOf("value399"));
}
main();
