// tsc path pattern: toFileNameLowerCase tests a negated class over every
// canonical file name, and simpleNormalizePath tests the relative-segment
// alternation over every path it normalizes; both regexps have no literal
// prefix, so without a first-character prefilter the engine runs at every
// input position.
const fileNameLowerCaseRegExp = /[^\u0130\u0131\u00DFa-z0-9\\/:\-_. ]+/g;
const relativePathSegmentRegExp = /\/\/|(?:^|\/)\.\.?(?:$|\/)/;
function toFileNameLowerCase(x: string): string {
  return fileNameLowerCaseRegExp.test(x) ? x.replace(fileNameLowerCaseRegExp, (s) => s.toLowerCase()) : x;
}
function simpleNormalizePath(path: string): string | undefined {
  if (!relativePathSegmentRegExp.test(path)) return path;
  let simplified = path.replace(/\/\.\//g, "/");
  if (simplified.startsWith("./")) simplified = simplified.slice(2);
  if (simplified !== path) { path = simplified; if (!relativePathSegmentRegExp.test(path)) return path; }
  return undefined;
}
function main(): void {
  const dirs = ["/users/kaz/project/src/compiler", "/users/kaz/project/node_modules/@types/node", "/users/kaz/project/src/services/codefixes", "c:/work/Project/Src"];
  const files = ["checker.ts", "program.ts", "index.d.ts", "utilities.ts", "README.md", "tsconfig.json", "ScannerUtil.ts", "emitter.ts"];
  const paths: string[] = [];
  for (const d of dirs) for (const f of files) { paths.push(d + "/" + f); paths.push(d + "/./" + f); paths.push(d + "/../" + f); }
  let lowered = 0, normalized = 0, same = 0;
  for (let round = 0; round < 3000; round++) {
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      const l = toFileNameLowerCase(p);
      if (l !== p) lowered++;
      const n = simpleNormalizePath(p);
      if (n === undefined) normalized++; else if (n === p) same++;
    }
  }
  console.log(lowered, normalized, same, paths.length);
}
main();
