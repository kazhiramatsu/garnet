for (const timestamp of [0, 13 * 3600000 + 2 * 60000 + 3000, -1000]) {
  const date = new Date(timestamp);
  console.log(date.toLocaleTimeString());
  console.log(date.toLocaleTimeString("en-US", { timeZone: "UTC" }));
  console.log(date.toLocaleTimeString("en-US", { timeZone: "UTC", hour12: false }));
  console.log(date.toLocaleTimeString("en-GB", { timeZone: "UTC" }));
  console.log(date.toLocaleTimeString("ja-JP", { timeZone: "UTC" }));
  console.log(date.toLocaleTimeString("en-US", { timeZone: "UTC", hourCycle: "h24" }));
  console.log(date.toLocaleTimeString("en-US", { timeZone: "UTC", hourCycle: "h11" }));
}
console.log(new Date(NaN).toLocaleTimeString());
