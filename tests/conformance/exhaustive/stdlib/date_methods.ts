function main(): void {
  // Component constructor (local time) + local getters. The harness compares
  // against node on the same machine, so the local timezone matches.
  const d = new Date(2020, 0, 15, 10, 30, 45);
  console.log(d.getFullYear(), d.getMonth(), d.getDate());   // 2020 0 15
  console.log(d.getHours(), d.getMinutes(), d.getSeconds()); // 10 30 45
  console.log(d.getDay());                                    // 3 (Wednesday)

  // Field normalization (month overflow rolls into the year), like JS.
  const ov = new Date(2020, 13, 1);
  console.log(ov.getFullYear(), ov.getMonth());              // 2021 1

  // Defaults: day defaults to 1, time fields to 0.
  const def = new Date(2021, 2);
  console.log(def.getDate(), def.getHours());                 // 1 0

  // Milliseconds field.
  const mil = new Date(2020, 5, 1, 0, 0, 0, 250);
  console.log(mil.getMilliseconds());                         // 250

  // new Date(epochMs) + getTime round-trip.
  const ms = new Date(2022, 6, 4, 12, 0, 0);
  const rt = new Date(ms.getTime());
  console.log(rt.getFullYear(), rt.getHours());               // 2022 12

  // UTC getters and toISOString are timezone-independent.
  const u = new Date(1579072245123);
  console.log(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate()); // 2020 0 15
  console.log(u.getUTCHours(), u.getUTCMinutes(), u.getUTCSeconds(), u.getUTCMilliseconds()); // 7 10 45 123
  console.log(u.toISOString());                               // 2020-01-15T07:10:45.123Z

  // getTimezoneOffset returns a number (value depends on the host TZ).
  console.log(typeof new Date(2020, 0, 1).getTimezoneOffset()); // number
}
main();
