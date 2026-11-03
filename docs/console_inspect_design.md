# console.log and util.inspect

Session 363. `runtime/inspect.c`.

## Why

The formatter printed every object on one line, without a depth limit, and a cycle ran to a `[deep]` at 256 levels. A Date printed
`Date {}`, a Promise `Promise {}`, an Error `Error {}`, a Map iterator `Iterator {}`, and a Proxy ran its traps. Any program that logs an object
differed from Node, and a conformance fixture had to avoid printing one.

## The port

`inspect.c` is Node 25's `lib/internal/util/inspect.js`, function for function: `formatValue`, `formatRaw`, `formatProperty`, `formatArray`,
`formatSet`, `formatMap`, `formatPromise`, `getPrefix`, `getFunctionBase`, `getClassBase`, `improveStack`, `groupArrayElements`,
`isBelowBreakLength`, `reduceToSingleString`, `strEscape`. The source is in the node binary (`process.binding('natives')` under
`--expose-internals`); a change there is a diff to read here.

- An output entry is a malloc'd UTF-8 string (`ins_s`). What the layout compares are JavaScript's lengths: UTF-16 units (`ins_units`), columns
  (`ins_width`, the table of Node's build without ICU), without the colour codes where Node removes them.
- `ctx.seen` is a linked list of frames on the C stack, each value rooted; the circular list is a rooted array, so a reference's number
  is a position in it.
- Keys go through `Object.keys` and `getOwnPropertySymbols`, a value through its descriptor: an accessor is not called, as in Node.
- `Symbol.for('nodejs.util.inspect.custom')` is honored, with the depth, the options and an `inspect` function.
- `util.inspect(value, options)` takes `depth`, `breakLength`, `compact`, `maxArrayLength`, `maxStringLength`, `showHidden`, `showProxy`,
  `colors`, `customInspect`. `console.log` is the defaults; `%o` is `showHidden`, `showProxy`, depth 4.

## What is not Node's

- `err.stack` is the header and one `at <anonymous>` line (no frames in a compiled program): the text around them is Node's.
- `getters`, `sorted` and `numericSeparator` are not read.
- `ins_width` does not know emoji sequences as ICU does: a grouped array of emoji may pad differently.
- A class named by a `class` that a library keeps as a value prints through the same path, but `DataView`, `URL` and the other library classes
  print as classes, where Node has a custom form for some of them.
