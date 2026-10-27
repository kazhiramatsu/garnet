export const isArray: typeof Array.isArray = Array.isArray;
export const extend: typeof Object.assign = Object.assign;
const hasOwnProperty = Object.prototype.hasOwnProperty;
export const hasOwn = (val: object, key: string | symbol): key is keyof typeof val => hasOwnProperty.call(val, key);
export const objectToString: typeof Object.prototype.toString = Object.prototype.toString;
export const toTypeString = (value: unknown): string => objectToString.call(value);
export const isMap = (val: unknown): val is Map<any, any> => toTypeString(val) === "[object Map]";
