// Light payloads are packed nibble bytes, unlike big-endian block palette longs.
function replaceExactly(source, before, after, count, label) {
  if (source.split(before).length !== count + 1) {
    throw new Error(`Chunk light ${label} integration point changed`);
  }
  return source.split(before).join(after);
}

export function patchChunkLightSource(source) {
  source = replaceExactly(source,
    'bitArray.readBuffer(SmartBuffer.fromBuffer(sectionReader))',
    `for (let word = 0; word < bitArray.data.length; word++) {
              bitArray.data[word] = sectionReader.readUInt32LE(word * 4)
            }`, 1, 'decoder');
  for (const channel of ['skyLight', 'blockLight']) {
    source = replaceExactly(source,
      `const smartBuffer = new SmartBuffer()
          section.writeBuffer(smartBuffer)
          ${channel}.push(Uint8Array.from(smartBuffer.toBuffer()))`,
      `const bytes = Buffer.alloc(section.data.length * 4)
          for (let word = 0; word < section.data.length; word++) {
            bytes.writeUInt32LE(section.data[word], word * 4)
          }
          ${channel}.push(Uint8Array.from(bytes))`, 1, `${channel} encoder`);
  }
  source = replaceExactly(source,
    'emptySkyLightMask: BitArray.fromLongArray(parsed.emptyBlockLightMask, 1)',
    'emptySkyLightMask: BitArray.fromLongArray(parsed.emptySkyLightMask, 1)', 1, 'sky empty mask');
  return replaceExactly(source,
    'emptyBlockLightMask: BitArray.fromLongArray(parsed.emptySkyLightMask, 1)',
    'emptyBlockLightMask: BitArray.fromLongArray(parsed.emptyBlockLightMask, 1)', 1, 'block empty mask');
}

export function patchChunkLightWorker(source) {
  // Both 1.17 and 1.18 loaders are bundled. Do not alter generic BitArray reads.
  source = replaceExactly(source,
    'u.readBuffer(l.fromBuffer(e))',
    'for(let w=0;w<u.data.length;w++)u.data[w]=e.readUInt32LE(w*4)', 2, 'worker decoder');
  source = replaceExactly(source,
    'emptySkyLightMask:i.fromLongArray(t.emptyBlockLightMask,1)',
    'emptySkyLightMask:i.fromLongArray(t.emptySkyLightMask,1)', 1, 'worker sky empty mask');
  return replaceExactly(source,
    'emptyBlockLightMask:i.fromLongArray(t.emptySkyLightMask,1)',
    'emptyBlockLightMask:i.fromLongArray(t.emptyBlockLightMask,1)', 1, 'worker block empty mask');
}
