function dump(s: string): void {
  console.log(s.length, s.charCodeAt(0), s.length > 1 ? s.charCodeAt(1) : -1, s.length > 2 ? s.charCodeAt(2) : -1);
}

function main(): void {
  dump("i".toLocaleUpperCase());
  dump("i".toLocaleUpperCase("tr"));
  dump("i".toLocaleUpperCase("tr-TR"));
  dump("i".toLocaleUpperCase("az-Latn-AZ"));
  dump("I".toLocaleLowerCase());
  dump("I".toLocaleLowerCase("tr"));
  dump("\u0130".toLocaleLowerCase());
  dump("\u0130".toLocaleLowerCase("tr"));
  dump("I\u0307".toLocaleLowerCase("tr"));
  dump("i".toLocaleUpperCase(["tr", "en"] as any));
  dump("i".toLocaleUpperCase(["en", "tr"] as any));

  const upper = String.prototype.toLocaleUpperCase;
  dump(upper.call("i", "tr"));

  const anyString: any = "I";
  dump(anyString.toLocaleLowerCase("tr"));

  const key: any = "toLocaleUpperCase";
  dump(("i" as any)[key]("tr"));

  try {
    console.log("i".toLocaleUpperCase("bad_locale"));
  } catch (e: any) {
    console.log(e.name);
  }
}

main();
