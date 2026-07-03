function main(): void {
  const high = String.fromCharCode(0xd800);
  const low = String.fromCharCode(0xdc00);
  const pair = String.fromCharCode(0xd83d, 0xde00);

  console.log(high);
  console.log(low);
  console.log(pair);

  console.log(JSON.stringify(high), JSON.stringify(low), JSON.stringify(pair));
  console.log([high, low, pair]);

  const o: any = {};
  o[high] = 1;
  o[low] = 2;
  o[pair] = 3;

  const keys = Object.keys(o);
  console.log(
    keys.length,
    keys[0].length,
    keys[0].charCodeAt(0),
    keys[1].charCodeAt(0),
    keys[2].length,
    keys[2].codePointAt(0),
  );
  console.log(o[high], o[low], o[pair], o[String.fromCharCode(0xfffd)]);
  console.log(JSON.stringify(keys));
  console.log(JSON.stringify(o));
  console.log(o);

  const names = Object.getOwnPropertyNames(o);
  console.log(names[0].charCodeAt(0), names[1].charCodeAt(0), names[2].codePointAt(0));

  const entry = Object.entries(o)[0];
  console.log(entry[0].charCodeAt(0), entry[1]);

  const nul = String.fromCharCode(0);
  const nulKey = "a" + nul + "b";
  const lenTrap = "length" + nul + "x";
  const indexTrap = "1" + nul;
  o[nulKey] = 4;
  o[lenTrap] = 5;

  const keys2 = Object.keys(o);
  console.log(o[nulKey], o[lenTrap], o["length"], o["length" + String.fromCharCode(0xfffd) + "x"]);
  console.log(keys2[3].length, keys2[3].charCodeAt(1), keys2[4].length, keys2[4].charCodeAt(6));
  console.log(JSON.stringify(keys2));
  console.log(JSON.stringify(o));

  const arr: any = [10, 20];
  arr[indexTrap] = 30;
  console.log(arr[1], arr[indexTrap], arr["1"], arr["1" + String.fromCharCode(0xfffd)]);
  console.log(JSON.stringify(Object.keys(arr)));
  console.log(("length" in arr), (lenTrap in arr), Object.prototype.hasOwnProperty.call(arr, lenTrap));

  const litHigh = "\uD800";
  const litLow = "\uDC00";
  const litNul = "a\u0000b";
  const litObj: any = {};
  litObj["\uD800"] = 6;
  litObj["\uDC00"] = 7;
  litObj["a\u0000b"] = 8;
  console.log(litHigh.length, litHigh.charCodeAt(0), litLow.charCodeAt(0), litNul.length, litNul.charCodeAt(1));
  console.log(litObj[litHigh], litObj[litLow], litObj[litNul], litObj[String.fromCharCode(0xfffd)]);
  const litKeys = Object.keys(litObj);
  console.log(litKeys[0].charCodeAt(0), litKeys[1].charCodeAt(0), litKeys[2].length, litKeys[2].charCodeAt(1));
  console.log(JSON.stringify(litKeys));
  console.log(JSON.stringify(litObj));

  const staticObj: any = { "\uD800": 9, "a\u0000b": 10 };
  const staticKeys = Object.keys(staticObj);
  console.log(staticObj[litHigh], staticObj[litNul], staticObj[String.fromCharCode(0xfffd)]);
  console.log(staticKeys[0].charCodeAt(0), staticKeys[1].length, staticKeys[1].charCodeAt(1));
  console.log(JSON.stringify(staticKeys));
  console.log(JSON.stringify(staticObj));

  class SurrogateMembers {
    _v = 0;
    ["\uD800"](): number { return 11; }
    get ["\uDC00"](): number { return this._v + 1; }
    set ["\uDC00"](v: number) { this._v = v; }
    ["a\u0000b"](): number { return 12; }
  }
  const sm: any = new SurrogateMembers();
  sm[litLow] = 13;
  console.log(sm[litHigh](), sm[litLow], sm[litNul](), sm._v);
  const protoKeys = Object.getOwnPropertyNames(SurrogateMembers.prototype);
  console.log(protoKeys.length, protoKeys[1].charCodeAt(0), protoKeys[2].charCodeAt(0), protoKeys[3].length, protoKeys[3].charCodeAt(1));
  console.log(JSON.stringify(protoKeys));

  class StaticSurrogateMembers {
    static ["\uD800"](): number { return 15; }
    static ["a\u0000b"] = 16;
  }
  console.log((StaticSurrogateMembers as any)[litHigh](), (StaticSurrogateMembers as any)[litNul]);
}

main();
