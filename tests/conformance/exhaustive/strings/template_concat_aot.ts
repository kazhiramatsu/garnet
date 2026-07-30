// AOT template concatenation must preserve substitution/ToString order while
// folding only side-effect-free primitive substitutions.
function main(): void {
  console.log(`${"a"}${1 + 2}${true}${null}${undefined}${-0}`);

  let state = 1;
  let order = "";
  const first = {
    toString(): string {
      order += "A";
      state = 7;
      return "<";
    }
  };
  const second = {
    toString(): string {
      order += "B";
      return ">";
    }
  };
  const rendered = `x${first}:${state}:${(order += "E", second)}y`;
  console.log(rendered, order, state);

  const s = "only";
  console.log(`${s}`);
  console.log(`こんにちは${2 * 3}😀`);

  // Concat results are lazily hashed. Map/Set must still use content identity
  // across independently-built equal strings and cache the demanded hash safely.
  const suffix = 7;
  const k1 = `item-${suffix}`;
  const k2 = `item-${suffix}`;
  const map = new Map<string, number>();
  map.set(k1, 42);
  console.log(k1 === k2, map.get(k2), map.has(k2));
}
main();
