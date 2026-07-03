function main(): void {
  const apostropheN = "\u0149".toUpperCase();
  console.log(apostropheN.length, apostropheN.charCodeAt(0), apostropheN.charCodeAt(1));

  const greekThree = "\u0390".toUpperCase();
  console.log(greekThree.length, greekThree.charCodeAt(0), greekThree.charCodeAt(1), greekThree.charCodeAt(2));

  const armenianLigature = "\u0587".toUpperCase();
  console.log(armenianLigature.length, armenianLigature.charCodeAt(0), armenianLigature.charCodeAt(1));

  const greekProsgegrammeni = "\u1f80".toUpperCase();
  console.log(greekProsgegrammeni.length, greekProsgegrammeni.charCodeAt(0), greekProsgegrammeni.charCodeAt(1));

  const deseretUpper = "\u{10428}".toUpperCase();
  const deseretLower = "\u{10400}".toLowerCase();
  console.log(deseretUpper.length, deseretUpper.codePointAt(0));
  console.log(deseretLower.length, deseretLower.codePointAt(0));

  console.log("ΟΣ ΣΣ Σ".toLowerCase());

  const upper = String.prototype.toUpperCase;
  const viaMethodValue = upper.call("\u0390");
  console.log(viaMethodValue.length, viaMethodValue.charCodeAt(0), viaMethodValue.charCodeAt(1), viaMethodValue.charCodeAt(2));

  const anyString: any = "\u0587";
  const anyUpper = anyString.toUpperCase();
  console.log(anyUpper.length, anyUpper.charCodeAt(0), anyUpper.charCodeAt(1));

  const key: any = "toLowerCase";
  const anySigma: any = "ΟΣ";
  console.log(anySigma[key]());
}

main();
