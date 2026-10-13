// Bounded protobuf reader for native attachment metadata; no schema guessing of scalar values.
export function protobufBytes(input: Uint8Array, field: number): Buffer | undefined {
  const bytes = Buffer.from(input);
  if (bytes.length > 2 * 1024 * 1024) throw Error("Attachment metadata exceeds limit");
  let pos = 0;
  function number() {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (pos >= bytes.length) throw Error("Incomplete protobuf");
      const b = bytes[pos++];
      value |= BigInt(b & 127) << shift;
      if (!(b & 128)) return value;
    }
    throw Error("Invalid protobuf integer");
  }
  while (pos < bytes.length) {
    const tag = number(),
      wire = Number(tag & 7n),
      id = Number(tag >> 3n);
    if (!id) throw Error("Invalid protobuf field");
    if (wire === 0) number();
    else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else if (wire === 2) {
      const size = number();
      if (size > BigInt(bytes.length - pos)) throw Error("Incomplete protobuf field");
      const end = pos + Number(size);
      if (id === field) return bytes.subarray(pos, end);
      pos = end;
    } else throw Error("Unsupported protobuf wire type");
    if (pos > bytes.length) throw Error("Incomplete protobuf field");
  }
}

export function protobufPath(input: Uint8Array, path: number[]): Buffer | undefined {
  let bytes: Uint8Array | undefined = input;
  for (const field of path) {
    if (!bytes) return;
    bytes = protobufBytes(bytes, field);
  }
  return bytes && Buffer.from(bytes);
}
