function main(): void {
  const sparse = [, undefined, , 3];
  console.log(
    sparse.length,
    0 in sparse,
    1 in sparse,
    2 in sparse,
    Object.hasOwn(sparse, "1"),
    Object.keys(sparse).join(","),
    Object.getOwnPropertyNames(sparse).join(","),
  );

  let visits = "";
  const mapped = sparse.map((value, index) => {
    visits += index + ":" + String(value) + ";";
    return index * 10;
  });
  console.log(visits, mapped.length, 0 in mapped, 1 in mapped, 3 in mapped);

  let each = "";
  sparse.forEach((_value, index) => { each += index; });
  const reduced = sparse.reduce<number>((acc, value, index) =>
    acc + index + (value === undefined ? 10 : value), 0);
  console.log(each, reduced, sparse.filter((x) => x === undefined).length);

  const sliced = sparse.slice(0);
  const concatenated = sparse.concat([4]);
  const spread = [...sparse];
  console.log(
    0 in sliced,
    2 in sliced,
    0 in concatenated,
    concatenated.length,
    0 in spread,
    2 in spread,
    spread.join(","),
  );

  const allocated = new Array<number>(3);
  allocated[1] = 7;
  console.log(allocated.length, 0 in allocated, 1 in allocated, JSON.stringify(allocated));

  const onlyHoles = new Array<number | undefined>(2);
  console.log(onlyHoles.indexOf(undefined), onlyHoles.includes(undefined));

  const changed = [, 2, 1];
  const reversed = changed.toReversed();
  const sorted = changed.toSorted();
  const replaced = changed.with(1, 8);
  const spliced = changed.toSpliced(1, 1, 9);
  console.log(
    Object.keys(reversed).join(","), reversed.join(","),
    Object.keys(sorted).join(","), sorted.join(","),
    Object.keys(replaced).join(","), replaced.join(","),
    Object.keys(spliced).join(","), spliced.join(","),
  );

  console.log([1, , [2, , 3]].flat().join(","));
  console.log([1, , 2].flatMap((x) => [x, , x]).join(","));

  console.log(delete sparse["3"], 3 in sparse, sparse.length, sparse.join(","));
}

main();
