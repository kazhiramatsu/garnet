// Date.UTC with one to seven components: the defaults of the missing ones, a two-digit year (1900-based),
// a month past December and a day past the month's end rolling over, negative components, fractions
// truncated, a NaN component, and the round trip through the UTC getters.
function main(): void {
  const out: string[] = [];
  out.push(String(Date.UTC(2020)), String(Date.UTC(2020, 5)), String(Date.UTC(2020, 5, 15)), String(Date.UTC(2020, 5, 15, 12)),
    String(Date.UTC(2020, 5, 15, 12, 30)), String(Date.UTC(2020, 5, 15, 12, 30, 45)), String(Date.UTC(2020, 5, 15, 12, 30, 45, 678)));
  out.push(String(Date.UTC(99, 0, 1)), String(Date.UTC(0, 0, 1)), String(Date.UTC(100, 0, 1)), String(Date.UTC(-1, 0, 1)));
  out.push(String(Date.UTC(2020, 12, 1)), String(Date.UTC(2020, 13, 40)), String(Date.UTC(2020, -1, 1)), String(Date.UTC(2020, 1, 30)), String(Date.UTC(2021, 1, 29)));
  out.push(String(Date.UTC(2020, 0, 1, 25, 61, 61, 1001)), String(Date.UTC(2020.9, 0.7, 1.2, 0, 0, 0, 0.9)), String(Date.UTC(2020, NaN)), String(Date.UTC(Infinity)));
  const ms = Date.UTC(1999, 11, 31, 23, 59, 59, 999);
  const d = new Date(ms);
  out.push([d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()].join("-"));
  out.push(String(Date.UTC(1970, 0, 1)), String(Date.UTC(1969, 11, 31, 23, 59, 59, 999)), String(Date.UTC(275760, 8, 13)), String(Date.UTC(275760, 8, 14)));
  console.log(out.join("\n"));
}
main();
