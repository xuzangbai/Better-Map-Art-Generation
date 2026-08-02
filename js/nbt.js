"use strict";

/* NBT (Named Binary Tag) writer.
   Based on mapartcraft's nbt.jsworker (GPL-3.0), https://github.com/rebane2001/mapartcraft
   https://minecraft.wiki/w/NBT_format#TAG_definition */

const TagTypes = {
  end: 0,
  byte: 1,
  short: 2,
  int: 3,
  long: 4,
  float: 5,
  double: 6,
  byteArray: 7,
  string: 8,
  list: 9,
  compound: 10,
  intArray: 11,
  longArray: 12,
};

class NBTWriter {
  constructor() {
    this.buffer = new ArrayBuffer(1024);
    this.dataView = new DataView(this.buffer);
    this.arrayView = new Uint8Array(this.buffer);
    this.offset = 0;
  }

  encodeUTF8(str) {
    const array = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c === 0x0) {
        array.push(0xc0, 0x80);
      } else if (c < 0x80) {
        array.push(c);
      } else if (c < 0x800) {
        array.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c < 0x10000) {
        array.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      } else {
        array.push(0xf0 | ((c >> 18) & 0x07), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return array;
  }

  accommodate(size) {
    const requiredLength = this.offset + size;
    if (this.buffer.byteLength >= requiredLength) return;
    let newLength = this.buffer.byteLength;
    while (newLength < requiredLength) newLength *= 2;
    const newBuffer = new ArrayBuffer(newLength);
    const newArrayView = new Uint8Array(newBuffer);
    newArrayView.set(this.arrayView);
    if (this.offset > this.buffer.byteLength) newArrayView.fill(0, this.buffer.byteLength, this.offset);
    this.buffer = newBuffer;
    this.dataView = new DataView(newBuffer);
    this.arrayView = newArrayView;
  }

  write(dataType, size, value) {
    this.accommodate(size);
    this.dataView["set" + dataType](this.offset, value);
    this.offset += size;
  }

  writeByType(dataType, value) {
    switch (dataType) {
      case TagTypes.end:
        this.writeByType(TagTypes.byte, 0);
        break;
      case TagTypes.byte:
        this.write("Int8", 1, value);
        break;
      case TagTypes.short:
        this.write("Int16", 2, value);
        break;
      case TagTypes.int:
        this.write("Int32", 4, value);
        break;
      case TagTypes.long:
        // JS has no 64-bit ints; pass [high, low] as signed 32-bit ints
        this.write("Int32", 4, value[0]);
        this.write("Int32", 4, value[1]);
        break;
      case TagTypes.float:
        this.write("Float32", 4, value);
        break;
      case TagTypes.double:
        this.write("Float64", 8, value);
        break;
      case TagTypes.byteArray: {
        this.writeByType(TagTypes.int, value.length);
        this.accommodate(value.length);
        this.arrayView.set(value, this.offset);
        this.offset += value.length;
        break;
      }
      case TagTypes.string: {
        const bytes = this.encodeUTF8(value);
        this.writeByType(TagTypes.short, bytes.length);
        this.accommodate(bytes.length);
        this.arrayView.set(bytes, this.offset);
        this.offset += bytes.length;
        break;
      }
      case TagTypes.list: {
        // value: {type: TagTypes.xxx, value: [...]}
        this.writeByType(TagTypes.byte, value.type);
        this.writeByType(TagTypes.int, value.value.length);
        for (let i = 0; i < value.value.length; i++) this.writeByType(value.type, value.value[i]);
        break;
      }
      case TagTypes.compound: {
        // value: {key: {type, value}, ...}
        Object.keys(value).forEach((key) => {
          this.writeByType(TagTypes.byte, value[key].type);
          this.writeByType(TagTypes.string, key);
          this.writeByType(value[key].type, value[key].value);
        });
        this.writeByType(TagTypes.end, 0);
        break;
      }
      case TagTypes.intArray: {
        this.writeByType(TagTypes.int, value.length);
        for (let i = 0; i < value.length; i++) this.writeByType(TagTypes.int, value[i]);
        break;
      }
      case TagTypes.longArray: {
        if (value instanceof Uint8Array) {
          // raw bytes: a packed long array (e.g. litematic BlockStates)
          this.writeByType(TagTypes.int, value.length / 8);
          this.accommodate(value.length);
          this.arrayView.set(value, this.offset);
          this.offset += value.length;
        } else {
          // array of [high, low] signed 32-bit int pairs
          this.writeByType(TagTypes.int, value.length);
          for (let i = 0; i < value.length; i++) this.writeByType(TagTypes.long, value[i]);
        }
        break;
      }
      default:
        throw new Error("Unknown data type " + dataType + " for value " + value);
    }
  }

  writeTopLevelCompound(name, value) {
    this.writeByType(TagTypes.byte, TagTypes.compound);
    this.writeByType(TagTypes.string, name);
    this.writeByType(TagTypes.compound, value);
  }

  getData() {
    this.accommodate(0);
    return this.buffer.slice(0, this.offset);
  }
}

/* Simple NBT reader, used for testing / verification. */
class NBTReader {
  constructor(arrayBuffer) {
    this.view = new DataView(arrayBuffer);
    this.offset = 0;
  }

  readByte() { return this.view.getInt8(this.offset++); }
  readUnsignedByte() { return this.view.getUint8(this.offset++); }
  readShort() { const v = this.view.getInt16(this.offset); this.offset += 2; return v; }
  readInt() { const v = this.view.getInt32(this.offset); this.offset += 4; return v; }
  readLong() { const h = this.view.getInt32(this.offset); const l = this.view.getInt32(this.offset + 4); this.offset += 8; return [h, l]; }
  readFloat() { const v = this.view.getFloat32(this.offset); this.offset += 4; return v; }
  readDouble() { const v = this.view.getFloat64(this.offset); this.offset += 8; return v; }

  readString() {
    const len = this.readShort();
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, len);
    this.offset += len;
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }

  readByteArray() {
    const len = this.readInt();
    const arr = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, len);
    this.offset += len;
    return arr;
  }

  readIntArray() {
    const len = this.readInt();
    const arr = new Int32Array(this.view.buffer, this.view.byteOffset + this.offset, len);
    this.offset += len * 4;
    return arr;
  }

  readLongArray() {
    const len = this.readInt();
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, len * 8);
    this.offset += len * 8;
    return bytes;
  }

  readTag(type) {
    switch (type) {
      case TagTypes.end: return null;
      case TagTypes.byte: return this.readByte();
      case TagTypes.short: return this.readShort();
      case TagTypes.int: return this.readInt();
      case TagTypes.long: return this.readLong();
      case TagTypes.float: return this.readFloat();
      case TagTypes.double: return this.readDouble();
      case TagTypes.byteArray: return this.readByteArray();
      case TagTypes.string: return this.readString();
      case TagTypes.list: {
        const elemType = this.readUnsignedByte();
        const len = this.readInt();
        const arr = [];
        for (let i = 0; i < len; i++) arr.push(this.readTag(elemType));
        return { elemType, value: arr };
      }
      case TagTypes.compound: {
        const obj = {};
        let t;
        while ((t = this.readUnsignedByte()) !== 0) {
          const name = this.readString();
          obj[name] = { type: t, value: this.readTag(t) };
        }
        return obj;
      }
      case TagTypes.intArray: return this.readIntArray();
      case TagTypes.longArray: return this.readLongArray();
      default: throw new Error("Unknown tag type " + type);
    }
  }

  readNamedTag() {
    const type = this.readUnsignedByte();
    const name = this.readString();
    const value = this.readTag(type);
    return { type, name, value };
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { NBTWriter, NBTReader, TagTypes };
}
