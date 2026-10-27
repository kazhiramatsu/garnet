function build(): { name: string; items: string[]; compute: (n: number) => number } {
  return { name: "cfg", items: ["a", "b"], compute: (n: number) => n * 7 };
}
export default build();
