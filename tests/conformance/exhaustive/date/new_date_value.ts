// new Date(value) beyond a number: a Date (its time), a string in the ISO format (date-only forms are UTC,
// date-time forms without an offset local time, offsets and Z, fractions, expanded years, invalid fields),
// the toUTCString shape of a Date, other strings (Invalid Date), and other values through
// ToNumber; Date.parse of the same. The local-time results are the same number in both engines on one machine.
function main(): void {
  const out: string[] = [];
  const iso = ["2020-01-02T03:04:05.678Z", "2020-01-02T03:04:05Z", "2020-01-02T03:04Z", "2020-01-02", "2020-01", "2020",
    "2020-01-02T03:04:05.678+09:00", "2020-01-02T03:04:05-05:30", "2020-06-15T12:30:00", "2020-06-15T12:30", "2020-06-15T12:30:00.5",
    "2020-06-15 12:30:00", "+012345-06-07T00:00:00Z", "-000001-01-01T00:00:00Z", "2020-13-01", "2020-02-30", "2020-01-02T25:00:00Z",
    "2020-01-02T24:00:00Z", "garbage", "", "2020-01-02T03:04:05.678 x"];
  for (const s of iso) out.push(s + " -> " + new Date(s).getTime());
  const d1 = new Date(1600000000123);
  out.push("copy " + new Date(d1).getTime());
  const anyTrue: any = true, anyNull: any = null, anyUndef: any = undefined;   // dynamic values: ToNumber at runtime
  out.push("bool " + new Date(anyTrue).getTime() + " null " + new Date(anyNull).getTime() + " undef " + new Date(anyUndef).getTime());
  out.push("iso round trip " + new Date(d1.toISOString()).getTime());
  out.push("toUTCString round trip " + new Date(new Date(123456789000).toUTCString()).getTime());
  out.push("parse " + Date.parse("2020-01-02T03:04:05Z") + " " + Date.parse("nope"));
  const value: unknown = "2021-03-04T05:06:07Z";
  out.push("unknown " + new Date(value as string).getTime());
  console.log(out.join("\n"));
}
main();
