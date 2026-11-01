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

## What it costs

A backed cast costs nothing. An unbacked one used in place takes the boxed operators, where it took the unboxed ones
over a value it could not vouch for; one that flows on pays one test.

## Gaps

- The elements of `xs as number[]` are not tested: `["x"] as unknown as number[]` reads NaN (V8: the string).
- A number field read through a class cast that lied, `(new Q() as unknown as P).x` for a field `P` declares and the
  value lacks, reads NaN (V8: undefined).
- Only explicit casts are covered: an `any` assigned to a `number` slot without one is still unboxed unchecked.
- `(5 as unknown as string).toUpperCase()` answers "5" (V8: a TypeError); a boxed string type stays a dynamic fallback,
  which hono needs.
