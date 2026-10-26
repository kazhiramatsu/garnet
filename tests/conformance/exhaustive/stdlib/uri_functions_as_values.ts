// encodeURIComponent, decodeURIComponent, encodeURI and decodeURI as values:
// passed to map, held in a const, read through typeof, compared by identity.
// (Calls are lowered directly; the values are the global object's functions,
// set up for a program that names one as a value.)
function main(): void {
  const enc = encodeURIComponent;
  const dec = decodeURIComponent;
  console.log(["a b", "\u00fc/\u65e5", "~!*()'"].map(enc).join(","));
  console.log(["a%20b", "%C3%BC%2F%E6%97%A5"].map(dec).join(","));
  console.log(["https://x.y/a b?q=\u00e9"].map(encodeURI)[0], ["https://x.y/a%20b?q=%C3%A9"].map(decodeURI)[0]);
  console.log(typeof encodeURIComponent, typeof decodeURI, enc === encodeURIComponent, enc.name, dec.length);
  const table: { [k: string]: (s: string) => string } = { enc, dec, encodeURI, decodeURI };
  console.log(Object.keys(table).map((k) => k + ":" + table[k]("%41 B")).join(" "));
  try { dec("%E0%A4%A"); } catch (e) { console.log((e as Error).name, (e as Error).message); }
}
main();
