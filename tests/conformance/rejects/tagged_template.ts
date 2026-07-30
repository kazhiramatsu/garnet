function tag(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.raw.join("|") + ":" + values.join(",");
}

console.log(tag`head\n${1}tail`);
