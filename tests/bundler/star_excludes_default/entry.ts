import def, { named } from "./a";
import * as hub from "./hub";
console.log(def(), named, hub.named, (hub as any).default);
