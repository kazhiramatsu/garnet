# Resizable and detached buffers

Session 363. Runtime (`ts_rt.c`).

A typed array read is `i < t->length` and `t->data[i]`, and it stays that. So a view never asks its buffer anything:

- A resizable buffer reserves `maxByteLength` bytes when it is made, so `bytes` never moves and neither does a view's
  `data`.
- `length` in the view is the live length for every reader. `resize()`, `grow()` and a detach rewrite it in each view of
  the buffer (`ab_refresh_views`): a length-tracking view follows the buffer, a view the buffer no longer covers is
  **out of bounds** with length 0. An element read past 0 is the bound test it always was. The built-in methods test
  the flag and throw (`ta_require`).
- The buffer holds its views under a hidden key. Only a resizable buffer does, and any buffer in a program that names
  `transfer` or `transferToFixedLength` (a scan of the field names, `ts_track_buffer_views`): the pooled buffers of a
  program that detaches nothing, whose views come and go by the thousand, are not kept alive by a list.

A shrink zeroes what it drops: bytes that grow back read zero. `SharedArrayBuffer` grows only upward.

## Gaps

- A view on a resizable buffer lives as long as the buffer (the list is strong).
- `subarray` of a length-tracking view gives a fixed view.
- The library's `DataView` reads through a typed array and fixes its length when it is made.
