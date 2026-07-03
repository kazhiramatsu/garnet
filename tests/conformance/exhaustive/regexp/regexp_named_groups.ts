function main(): void {
  const m: any = /(?<first>a)(?<second>b)?/.exec("xa");
  console.log(m[0], m.index, m.groups.first, m.groups.second, m.groups.missing);

  const d: any = /(?<first>a)(?<second>b)?/d.exec("xa");
  console.log(
    d.indices[0][0],
    d.indices[0][1],
    d.indices.groups.first[0],
    d.indices.groups.first[1],
    d.indices.groups.second,
    d.indices.groups.missing,
  );

  console.log("ab".replace(/(?<first>a)(?<second>b)/, "$<second>-$<first>-$<missing>"));
  console.log("ab".replace(/(a)(b)/, "$<first>"));
  console.log("ab ab".replace(/(?<first>a)(?<second>b)/g, "$<first>$<missing>"));
  console.log(
    "ab".replace(/(?<first>a)(b)/, (m: string, a: string, b: string, off: number, whole: string, groups: any) => {
      return groups.first + b + off + whole.length;
    }),
  );

  const r = /(?<word>a+)/g;
  const obj: any = r.exec("baa");
  console.log(obj[0], obj.groups.word, r.lastIndex);

  const mm: any = "zzab".match(/(?<word>a)(b)/);
  console.log(mm.groups.word, mm.index);
}

main();
