import { css, cx, keyframes, Style } from "./src/helper/css/index.ts";
import { section } from "./garnet-survey-_lib.ts";
const fade = keyframes`from { opacity: 0 } to { opacity: 1 }`;
const box = css`color: red; padding: 4px; animation: ${fade} 1s;`;
const big = css`${box} font-size: 2em;`;
async function main(): Promise<void> {
  section("css");
  const page = <html><head><Style /></head><body><div class={box}>x</div><div class={cx(big, "extra")}>y</div></body></html>;
  console.log(String(await page.toString()));
}
main();
