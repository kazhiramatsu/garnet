function main(): void {
  const chunk = "0123456789abcdef".repeat(65536); // 1 MiB
  let out = "";
  let branchScore = 0;

  for (let i = 0; i < 64; i++) {
    out += chunk;
    if ((i & 7) === 7) {
      const prefix = out;
      const tailSlice = prefix.slice(prefix.length - 33, prefix.length - 1);
      const branch = prefix + "!";
      branchScore +=
        tailSlice.length +
        branch.length - prefix.length +
        branch.charCodeAt(branch.length - 1);
      // `branch` advanced the hidden high-water mark. Extending this older
      // prefix must copy to a fresh buffer rather than overwrite branch data.
      out = prefix;
    }
  }

  let checksum = 0;
  for (let i = 0; i < out.length; i += 4096) checksum += out.charCodeAt(i);
  console.log(
    out.length,
    checksum,
    branchScore,
    out.slice(0, 16),
    out.slice(-16)
  );
}

main();
