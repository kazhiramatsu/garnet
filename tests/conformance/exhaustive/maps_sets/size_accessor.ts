function optionalSize(value: Map<string, number> | undefined): number | undefined {
  return value?.size;
}
const map = new Map<string, number>([["x", 1]]);
const set = new Set<number>([1, 2]);
const dynamicMap: any = map;
const dynamicSet: any = set;
console.log(optionalSize(map), optionalSize(undefined), dynamicMap.size, dynamicSet["size"]);
map.set("y", 2);
set.delete(1);
console.log(dynamicMap.size, dynamicSet.size);
const mapDescriptor: any = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(map), "size");
const setDescriptor: any = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(set), "size");
console.log(mapDescriptor.enumerable, mapDescriptor.configurable, mapDescriptor.set);
console.log(mapDescriptor.get.call(map), setDescriptor.get.call(set));
try { mapDescriptor.get.call(set); } catch (e) { console.log(e instanceof TypeError); }
try { setDescriptor.get.call(map); } catch (e) { console.log(e instanceof TypeError); }
try { dynamicMap.size = 9; } catch (e) { console.log(e instanceof TypeError); }
Object.defineProperty(map, "size", { value: 7, configurable: true });
console.log(dynamicMap.size);
const weak: any = new WeakMap<object, number>();
console.log(weak.size);
