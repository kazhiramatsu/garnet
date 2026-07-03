function main(): void {
  const o = { x: 1, y: 2, name: "pt" };
  console.log(o.x, o.y, o.name);
  console.log(Object.keys(o).join(","), Object.values(o).join(","));
  const o2 = { ...o, z: 3 };
  console.log(o2.x, o2.z, Object.keys(o2).length);
}

main();
