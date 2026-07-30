export {};

async function main(): Promise<void> {
  const module = await import("./dynamic_import");
  console.log(module);
}

main();
