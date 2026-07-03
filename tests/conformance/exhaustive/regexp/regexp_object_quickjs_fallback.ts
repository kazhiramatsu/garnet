function main(): void {
  const q = /ab+/;
  console.log(q.test("zzabbb"), q.lastIndex, Object.keys(q).join(","));
  console.log(String(q), Object.prototype.toString.call(q));

  const qi = /abc/i;
  console.log(qi.test("ABC"), qi.lastIndex, String(qi));

  const g = /ab+/g;
  const g1: any = g.exec("zzabbbab");
  console.log(g1[0], g1.index, g.lastIndex);
  const g2: any = g.exec("zzabbbab");
  console.log(g2[0], g2.index, g.lastIndex);
  const g3: any = g.exec("zzabbbab");
  console.log(g3, g.lastIndex);

  const cap = /(a)(b+)?/;
  const cm: any = cap.exec("za");
  console.log(cm[0], cm[1], cm[2], cm.index, cm.input, Object.keys(cm).join(","));

  const emoji = /😀+/g;
  console.log(emoji.test("x😀😀y"), emoji.lastIndex);
  const em: any = emoji.exec("x😀😀y");
  console.log(em[0], em.index, em.input, emoji.lastIndex);

  const s = /ab+/g;
  s.lastIndex = 5;
  console.log("zzabbb".search(s), s.lastIndex);

  const sticky = /ab+/y;
  sticky.lastIndex = 2;
  const sm: any = sticky.exec("zzabbb");
  console.log(sm[0], sm.index, sticky.lastIndex);
  sticky.lastIndex = 1;
  console.log(sticky.test("zzabbb"), sticky.lastIndex);
}
main();
