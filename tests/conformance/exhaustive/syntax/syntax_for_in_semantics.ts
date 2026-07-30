function main(): void {
  const grand = Object.create(null) as Record<string, unknown>;
  grand.visible = 1;
  grand.shadowed = "grand";

  const parent = Object.create(grand) as Record<string, unknown>;
  parent.parent = 2;
  Object.defineProperty(parent, "shadowed", {
    value: "hidden",
    enumerable: false,
    configurable: true,
  });

  const child = Object.create(parent) as Record<string, unknown>;
  child.own = 3;
  child["10"] = "ten";
  child["2"] = "two";

  const keys: string[] = [];
  for (const key in child) keys.push(key);
  console.log(keys.join(","));

  const sparse = [1, , 3];
  const arrayKeys: string[] = [];
  for (const key in sparse) arrayKeys.push(key);
  console.log(arrayKeys.join(","));
}

main();
