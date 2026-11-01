# A cast to `number`

Session 363. Exporter (`exporter.ts`), runtime (`ts_cast_number`).

## The problem

`x as number` costs nothing at run time and promises nothing: TypeScript does not check it, `as unknown as` gets past
any complaint. In typed mode a `number` is unboxed, so a value of another type behind the cast turned into NaN,
silently: `("abc" as unknown as number) + 1` answered NaN where V8 answers `"abc1"`.

A check at the cast is wrong too. The same shape is legal and does what it means in V8, because the value is used
where its type does not matter: hono writes `(str as unknown as string).toString()` over an object, and Date
subtraction is commonly written `(a as unknown as number) - (b as unknown as number)`.

So what breaks is not the cast but the moment a value moves into a slot that holds a number unboxed.

## The rule

A cast to a number type is **unbacked** when the operand's static type does not say a number, or a number or nothing
(`map.get(k) as number` is what a typed number holds anyway).

- **Used in place** (`usedInPlace`): the receiver of a member, an operand, a test, a template part, an argument for a
  parameter of type `any` or `unknown`. The value is `any`: the checker answers `any` for such a node (`distrustedExpr`,
  through the one `getTypeAtLocation` the exporter holds), so receiver tests, operators and local kinds all take the
  dynamic path and the result is V8's. A `+` over one may be a concatenation, so it is `any` too.
- **Anything else** flows on into a variable, a field, a return, a number parameter: `ts_cast_number` tests the value
  there, and a value of another type is a TypeError. `null` and `undefined` pass: `undefined as unknown as number` is a
  placeholder idiom, and a typed number reads them as NaN as it always has.

Untyped mode (`TSAOT_UNTYPED=1`) trusts no annotation and takes no test.

## Data out of JSON

`JSON.parse(s) as Config` is the same lie one level down: the cast is to an object type, the number comes later, from
`c.port`, and nothing says the file holds one. `c.port + 1` over `"8080"` gave 8081, `c.port === undefined` was false for
a missing key.

`computeForeignTypes` finds, over the whole program, each type a value out of JSON is cast or assigned to:
`JSON.parse(...)`, `res.json()`, a variable holding one, through `as`, an annotation, an argument or a return. That type
and what the program declares inside it are **foreign**. A property read off a foreign type (`foreignValue`) follows the
rule above: `any` in place, tested flowing on. The test is stricter, undefined does not pass: nobody wrote a placeholder,
the key is missing. A variable with no declared type that takes such a read stays boxed, so `const p = c.port` keeps
what the file held.

The seeds are the entries of external data and not every cast from `any`: a compiler is full of `x as any as Node`, its
values are its own, and the types behind them are the ones that must stay fast. A type no parsed value reaches pays
nothing; a program with no such cast pays nothing.

`JSON.parse(s) as number[]` tests every element at the cast: an array type is shared by the whole program, so it cannot
be foreign.

## Arrays

`{ length: 2 } as unknown as number[]`, whose operand is known not to be an array, follows the same rule without the
test: `any` in place, a variable with no declared type stays boxed. `.length` and `.push` are V8's. A cast to an array
type from `any` is believed, being how a program types what it built; the typed builtins over a value that turns out
no array keep their defaults, `.length` being the receiver's own (`ts_array_len_foreign`).

## What it costs

A backed cast costs nothing. An unbacked one used in place takes the boxed operators, where it took the unboxed ones
over a value it could not vouch for; one that flows on pays one test.

## Gaps

- The elements of `xs as number[]` are tested only for a value out of JSON: `["x"] as unknown as number[]` reads NaN (V8:
  the string). A number array inside a foreign type is read as `any` by `for..of`, not by a callback's parameter.
- What was cast from an `any` that came from elsewhere (a `fetch` wrapper of the program's own, a global) is trusted.
- A number field read through a class cast that lied, `(new Q() as unknown as P).x` for a field `P` declares and the
  value lacks, reads NaN (V8: undefined).
- Only explicit casts are covered: an `any` assigned to a `number` slot without one is still unboxed unchecked.
- `(5 as unknown as string).toUpperCase()` answers "5" (V8: a TypeError); a boxed string type stays a dynamic fallback,
  which hono needs.

## A parameter of a built-in

An argument with a cast behind it for a `number` parameter of the library (`arr.slice(s as unknown as number)`) is used in
place: nothing typed holds it, and the runtime converts it with ToNumber as the specification does.
