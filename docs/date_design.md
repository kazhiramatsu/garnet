# Date

Session 363. Runtime (`ts_rt.c`), exporter (`exporter.ts`).

A Date is a plain object with its time value under the reserved key `__date_ms`, linked to a real `Date.prototype`
(`ts_date_proto`). The typed forms keep their static lowering: `d.getTime()` reads the key, the getters go to
`ts_date_component`. Everything else, on a typed receiver too, is a call of the prototype's method: `d.setDate(5)` was a
compile-time reject, and `Date.prototype`, `String(d)`, `d - e` and `d < e` had nothing to find.

The arithmetic is the specification's in doubles (`date_make_day`, `date_make_time`, `date_make_date`,
`date_time_clip`): a day or a month past its range rolls over, a value out of range is NaN, where `mktime` gave up.
Local time is the host's zone: `date_offset` at the instant.

`toString` ends in V8's long zone name, which comes from ICU: `date_zone_name` maps the host's abbreviation for the
common zones and keeps the abbreviation otherwise.

## Gaps

- A typed `d.getTime()` on a receiver that is no Date (`Date.prototype.getTime()`) reads NaN where V8 throws: the static
  read has no test. Through `.call` or `any` it is the method, which throws.
- `toLocaleDateString` and `toLocaleString` are en-US without options; locales or options are a TypeError.
