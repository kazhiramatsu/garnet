export function utf16Units(s: string): number[] {
  const units: number[] = [];
  for (let i = 0; i < s.length; i++) units.push(s.charCodeAt(i));
  return units;
}

export function hasUnpairedSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const cu = s.charCodeAt(i);
    if (cu >= 0xd800 && cu <= 0xdbff) {
      if (i + 1 < s.length) {
        const lo = s.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) { i++; continue; }
      }
      return true;
    }
    if (cu >= 0xdc00 && cu <= 0xdfff) return true;
  }
  return false;
}

/** Normalize the plain IR tree without cloning unchanged arrays/objects. String
 * validation shares the conversion walk, so large programs need one traversal. */
export function toWireProgram(prog: any): any {
  const visit = (value: any, location: string): any => {
    if (typeof value === "string") {
      if (hasUnpairedSurrogate(value))
        throw new Error(`unpaired surrogate escaped Str16 conversion at ${location}`);
      return value;
    }
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      let out = value;
      for (let i = 0; i < value.length; i++) {
        const item = visit(value[i], `${location}[${i}]`);
        if (item !== value[i]) {
          if (out === value) out = value.slice();
          out[i] = item;
        }
      }
      return out;
    }
    if (value.kind === "Str" && typeof value.value === "string" && hasUnpairedSurrogate(value.value))
      return { kind: "Str16", units: utf16Units(value.value) };
    let out = value;
    if (typeof value.propName === "string" && hasUnpairedSurrogate(value.propName)) {
      out = { ...value, propNameUnits: utf16Units(value.propName) };
      delete out.propName;
    }
    for (const key of Object.keys(out)) {
      const item = visit(out[key], `${location}.${key}`);
      if (item !== out[key]) {
        if (out === value) out = { ...value };
        out[key] = item;
      }
    }
    return out;
  };
  let fields = prog.fields;
  for (let i = 0; i < prog.fields.length; i++) {
    const field = prog.fields[i];
    if (typeof field.name === "string" && hasUnpairedSurrogate(field.name)) {
      if (fields === prog.fields) fields = fields.slice();
      fields[i] = { id: field.id, nameUnits: utf16Units(field.name), declaringType: field.declaringType };
    }
  }
  return visit(fields === prog.fields ? prog : { ...prog, fields }, "$");
}
