"use strict";

/* Minimal ZIP writer (deflate via pako). Supports folders by slashed names. */

function deflateRaw(data, level) {
  if (typeof window !== "undefined" && window.pako) return window.pako.deflateRaw(data, { level });
  if (typeof module !== "undefined" && module.require) {
    return new Uint8Array(module.require("zlib").deflateRawSync(Buffer.from(data), { level }));
  }
  throw new Error("pako (deflate) not available");
}

class ZipWriter {
  constructor() {
    this.entries = [];
  }

  addFile(name, data, { folder = "" } = {}) {
    const fullName = folder ? folder + "/" + name : name;
    this.entries.push({ name: fullName, data });
  }

  build() {
    const parts = [];
    const central = [];
    let offset = 0;

    for (const entry of this.entries) {
      const nameBytes = utf8Bytes(entry.name);
      const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
      const compressed = deflateRaw(data, 6);
      const crc = crc32(data);

      const localHeader = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(localHeader.buffer);
      lv.setUint32(0, 0x04034b50, true); // local file header signature
      lv.setUint16(4, 20, true); // version needed
      lv.setUint16(6, 0x0800, true); // flags: bit 3 (data descriptor) NOT set; we know sizes
      lv.setUint16(8, 8, true); // compression method: deflate
      lv.setUint16(10, 0, true); // mod time
      lv.setUint16(12, 0, true); // mod date
      lv.setUint32(14, crc, true);
      lv.setUint32(18, compressed.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true); // extra length
      localHeader.set(nameBytes, 30);
      parts.push(localHeader, compressed);

      // central directory record
      const centralEntry = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(centralEntry.buffer);
      cv.setUint32(0, 0x02014b50, true); // central file header signature
      cv.setUint16(4, 20, true); // version made by
      cv.setUint16(6, 20, true); // version needed
      cv.setUint16(8, 0x0800, true); // flags
      cv.setUint16(10, 8, true); // method
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, compressed.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true); // local header offset
      cv.setUint32(42, offset, true);
      centralEntry.set(nameBytes, 46);
      central.push(centralEntry);

      offset += localHeader.length + compressed.length;
    }

    // end of central directory
    const centralSize = central.reduce((s, e) => s + e.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); // EOCD signature
    ev.setUint16(4, 0, true); // disk number
    ev.setUint16(6, 0, true); // disk with central dir
    ev.setUint16(8, this.entries.length, true);
    ev.setUint16(10, this.entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true); // comment length

    const all = [].concat(parts, central, eocd);
    const total = all.reduce((s, u) => s + u.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const u of all) {
      out.set(u, pos);
      pos += u.length;
    }
    return out;
  }

  toBlob(mime = "application/zip") {
    return new Blob([this.build()], { type: mime });
  }
}

function utf8Bytes(str) {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
  return pako.ungzip(pako.gzip(str)); // fallback (rarely needed)
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { ZipWriter, crc32 };
}
