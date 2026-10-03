/* Test harness for the map art generator: validates NBT / litematic / map.dat output. */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
global.window = {};
require(path.join(ROOT, "data", "colours.js"));
require(path.join(ROOT, "data", "bluenoise.js"));
require(path.join(ROOT, "js", "constants.js"));
require(path.join(ROOT, "js", "nbt.js"));
require(path.join(ROOT, "js", "zip.js"));
require(path.join(ROOT, "js", "generator.js"));

const { NBTReader, TagTypes } = require(path.join(ROOT, "js", "nbt.js"));
const { MapGenerator } = require(path.join(ROOT, "js", "generator.js"));
const C = window.COLOURS_JSON;
const K = window.MapArtConstants;

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log("  PASS: " + msg);
  } else {
    failures++;
    console.error("  FAIL: " + msg);
  }
}

function makeTestImage(mapsX, mapsY, fn) {
  const w = mapsX * 128, h = mapsY * 128;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const c = fn(x, y, w, h);
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

function defaultSelectedBlocks() {
  const sel = {};
  for (const k of Object.keys(C)) sel[k] = "-1";
  for (let i = 0; i < 61; i++) sel[i] = "0";
  return sel;
}

function makeGenerator(overrides) {
  return new MapGenerator(C, Object.assign({
    mcVersion: "1.21.11",
    staircaseId: K.STAIRCASING.CLASSIC.id,
    supportModeId: K.SUPPORT_MODES.NONE.id,
    supportBlock: "cobblestone",
    includeNoobline: false,
    betterColour: true,
    ditherId: K.DITHER_METHODS.FloydSteinberg.id,
    selectedBlocks: defaultSelectedBlocks(),
    transparency: false,
    transparencyTolerance: 128,
    mapdatUnobtainable: false,
  }, overrides));
}

/* ---- unpack the tight long array (independent implementation of TightLongBackedIntArray) ---- */
function readVec3(compound) {
  return [compound.x.value, compound.y.value, compound.z.value];
}

function unpackLongs(longs, bits, count) {
  const view = new DataView(longs.buffer, longs.byteOffset, longs.byteLength);
  const out = new Array(count);
  for (let index = 0; index < count; index++) {
    const startOffset = index * bits;
    let v = 0;
    for (let b = 0; b < bits; b++) {
      const bitPos = startOffset + b;
      const arrIdx = Math.floor(bitPos / 64);
      const bitIdx = bitPos % 64;
      // big-endian longs: hi word at +0, lo word at +4
      const lo = view.getUint32(arrIdx * 8 + 4, false);
      const hi = view.getUint32(arrIdx * 8, false);
      const bit = bitIdx < 32 ? (lo >>> bitIdx) & 1 : (hi >>> (bitIdx - 32)) & 1;
      v |= bit << b;
    }
    out[index] = v;
  }
  return out;
}

/* Independent reader ported from the @kleppe/litematic-reader package (production tool):
   big-endian longs, LSB-first packing. Used as cross-validation. */
function readLongPackedArray(view, bitsPerItem, index) {
  const bitMask = (1 << bitsPerItem) - 1;
  const bitIndex = index * bitsPerItem;
  const currentLongIndex = Math.floor(bitIndex / 64) * 8;
  const indexInLong = bitIndex % 64;
  if (indexInLong < 32) {
    const currentLongLo = view.getUint32(currentLongIndex + 4);
    const currentLongHi = view.getUint32(currentLongIndex);
    return ((currentLongLo >>> indexInLong) | (currentLongHi << (31 - indexInLong) << 1)) & bitMask;
  } else {
    const currentLongHi = view.getUint32(currentLongIndex);
    const nextLongLo = currentLongIndex + 8 < view.byteLength ? view.getUint32(currentLongIndex + 12) : 0;
    return ((currentLongHi >>> (indexInLong - 32)) | (nextLongLo << (63 - indexInLong) << 1)) & bitMask;
  }
}

function expandLongPackedArray(bytes, bitsPerItem, length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = new Array(length);
  for (let i = 0; i < length; i++) result[i] = readLongPackedArray(view, bitsPerItem, i);
  return result;
}

(async () => {
  console.log("=== Test 1: quantization + materials ===");
  const img = makeTestImage(1, 1, (x, y, w, h) => [Math.floor((x / w) * 255), Math.floor((y / h) * 255), 128]);
  const gen = makeGenerator({});
  gen.setup();
  const res = await gen.processImageData({ data: img.data }, 1, 1, () => {});
  const totalMaterials = Object.values(res.maps[0][0].materials).reduce((a, b) => a + b, 0);
  assert(totalMaterials === 16384, "materials total = 16384 (got " + totalMaterials + ")");
  assert(Object.keys(res.maps[0][0].materials).length === 61, "61 colourSets in materials");

  console.log("=== Test 2: coloursLayout extraction ===");
  const layouts = gen.extractColoursLayouts(img.data, 1, 1);
  const layout = layouts[0][0].coloursLayout;
  assert(layout.length === 128 && layout[0].length === 128, "layout is 128x128");
  assert(layout[0][0].colourSetId !== undefined && layout[0][0].tone !== undefined, "layout entries have colourSetId+tone");
  let invalid = 0;
  for (let x = 0; x < 128; x++) for (let z = 0; z < 128; z++) if (layout[x][z].colourSetId === "-1") invalid++;
  assert(invalid === 0, "no transparent pixels in non-transparent image");

  console.log("=== Test 3: schematic NBT (flat, no supports, no noobline) ===");
  let genFlat = makeGenerator({ staircaseId: K.STAIRCASING.OFF.id, ditherId: K.DITHER_METHODS.None.id });
  genFlat.setup();
  const flatImg = makeTestImage(1, 1, () => [109, 153, 48]); // exactly colourSet 0 normal tone
  await genFlat.processImageData({ data: flatImg.data }, 1, 1);
  const flatLayouts = genFlat.extractColoursLayouts(flatImg.data, 1, 1);
  const flatLayout = flatLayouts[0][0].coloursLayout;
  const nbtBytes = genFlat.buildSchematicNbt(flatLayout);
  const reader = new NBTReader(nbtBytes.buffer ? nbtBytes.buffer : nbtBytes);
  const root = reader.readNamedTag();
  assert(root.type === TagTypes.compound, "nbt root is compound");
  const blocks = root.value.blocks.value.value;
  const palette = root.value.palette.value.value;
  const size = root.value.size.value.value;
  assert(size.length === 3, "nbt size tag exists");
  assert(blocks.length === 16384, "flat map has exactly 16384 blocks (got " + blocks.length + ")");
  assert(palette.length === 1, "single-colour flat map palette has 1 entry");
  assert(palette[0].Name.value === "minecraft:grass_block", "palette block = grass_block (got " + palette[0].Name.value + ")");
  const maxY = Math.max(...blocks.map((b) => b.pos.value.value[1]));
  const minZ = Math.min(...blocks.map((b) => b.pos.value.value[2]));
  const maxZ = Math.max(...blocks.map((b) => b.pos.value.value[2]));
  assert(maxY === 0 && minZ === 0 && maxZ === 127, "flat no-noobline: y=0, z=0..127 (got y=" + maxY + " z=" + minZ + ".." + maxZ + ")");
  const expectedSize = [128, maxY + 1, maxZ - minZ + 1];
  assert(JSON.stringify(size) === JSON.stringify(expectedSize), "size matches blocks (got " + JSON.stringify(size) + ")");
  assert(root.value.DataVersion.value === 4671, "DataVersion = 4671 for 1.21.11");

  console.log("=== Test 4: schematic NBT (classic, noobline on, supports none) ===");
  let genClassic = makeGenerator({ staircaseId: K.STAIRCASING.CLASSIC.id, includeNoobline: true, ditherId: K.DITHER_METHODS.None.id });
  genClassic.setup();
  const classicImg = makeTestImage(1, 1, (x, y) => (y < 43 ? [89, 125, 39] : y < 86 ? [109, 153, 48] : [127, 178, 56]));
  await genClassic.processImageData({ data: classicImg.data }, 1, 1);
  const classicLayouts = genClassic.extractColoursLayouts(classicImg.data, 1, 1);
  const nbt2 = genClassic.buildSchematicNbt(classicLayouts[0][0].coloursLayout);
  const r2 = new NBTReader(nbt2.buffer ? nbt2.buffer : nbt2);
  const root2 = r2.readNamedTag();
  const blocks2 = root2.value.blocks.value.value;
  const scaffoldCount = blocks2.filter((b) => root2.value.palette.value.value[b.state.value].Name.value === "minecraft:cobblestone").length;
  assert(scaffoldCount === 128, "noobline row has 128 cobblestone blocks (got " + scaffoldCount + ")");
  const size2 = root2.value.size.value.value;
  assert(size2[1] > 1 && size2[2] === 129, "classic+noobline size y>1, depth=129 (got " + JSON.stringify(size2) + ")");
  const blocksByCol = {};
  for (const b of blocks2) {
    const [x, y, z] = b.pos.value.value;
    if (root2.value.palette.value.value[b.state.value].Name.value === "minecraft:cobblestone") continue;
    if (!blocksByCol[x]) blocksByCol[x] = [];
    blocksByCol[x].push({ y, z });
  }
  let heightOk = true;
  for (const col of Object.values(blocksByCol)) {
    col.sort((a, b) => a.z - b.z);
    let prevY = null;
    let prevTone = null;
    for (let i = 0; i < col.length; i++) {
      const tone = col[i].z - 1 < 43 ? "dark" : col[i].z - 1 < 86 ? "normal" : "light";
      if (prevTone !== null) {
        const delta = tone === "dark" ? -1 : tone === "light" ? 1 : 0;
        if (col[i].y !== prevY + delta) { heightOk = false; break; }
      }
      prevY = col[i].y;
      prevTone = tone;
    }
  }
  assert(heightOk, "classic staircase heights correct (relative deltas)");

  console.log("=== Test 5: litematic output ===");
  const litematic = genClassic.buildLitematicBytes(classicLayouts, "testart");
  const gunzipped = zlib.gunzipSync(Buffer.from(litematic));
  const lr = new NBTReader(gunzipped.buffer.slice(gunzipped.byteOffset, gunzipped.byteOffset + gunzipped.byteLength));
  const lroot = lr.readNamedTag();
  assert(lroot.type === TagTypes.compound, "litematic root is compound");
  assert(lroot.value.Version.value === 4, "litematic Version = 4");
  assert(lroot.value.MinecraftDataVersion.value === 4671, "litematic MinecraftDataVersion = 4671");
  assert(lroot.value.Metadata.value.Name.value === "testart", "metadata name");
  assert(lroot.value.Metadata.value.RegionCount.value === 1, "region count 1");
  const region = lroot.value.Regions.value.mapart.value;
  const regionSize = readVec3(region.Size.value);
  const regionPos = readVec3(region.Position.value);
  assert(JSON.stringify(regionPos) === "[0,0,0]", "region position [0,0,0]");
  const paletteN = region.BlockStatePalette.value.value;
  const paletteNames = paletteN.map((p) => p.Name.value);
  assert(paletteNames[0] === "minecraft:air", "palette[0] is air");
  assert(paletteNames.includes("minecraft:grass_block"), "palette includes grass_block");
  assert(paletteNames.includes("minecraft:cobblestone"), "palette includes support block");
  const bits = Math.max(2, 32 - Math.clz32(paletteNames.length - 1));
  const volume = regionSize[0] * regionSize[1] * regionSize[2];
  const longArr = region.BlockStates.value;
  assert(longArr.length === Math.ceil((volume * bits) / 8), "BlockStates byte length matches (" + longArr.length + " vs " + Math.ceil((volume * bits) / 8) + ")");
  const unpacked = unpackLongs(longArr, bits, volume);
  const stateIndex = paletteNames.indexOf("minecraft:grass_block");
  const scaffoldIndex = paletteNames.indexOf("minecraft:cobblestone");
  let errors = 0;
  const sx = regionSize[0], sz = regionSize[2];
  const expectedMap = new Map();
  for (const b of blocks2) {
    const [x, y, z] = b.pos.value.value;
    const paletteId = b.state.value;
    const name = root2.value.palette.value.value[paletteId].Name.value;
    expectedMap.set(y * sx * sz + z * sx + x, name === "minecraft:cobblestone" ? scaffoldIndex : stateIndex);
  }
  for (let idx = 0; idx < volume; idx++) {
    const expected = expectedMap.has(idx) ? expectedMap.get(idx) : 0;
    if (unpacked[idx] !== expected) {
      if (errors < 5) console.error("    mismatch at index " + idx + ": got " + unpacked[idx] + " expected " + expected);
      errors++;
    }
  }
  assert(errors === 0, "litematic BlockStates match expected blocks (errors=" + errors + ")");

  console.log("=== Test 6: map.dat output ===");
  const mapdatGen = makeGenerator({ staircaseId: K.STAIRCASING.CLASSIC.id, ditherId: K.DITHER_METHODS.None.id, mapdatUnobtainable: true });
  mapdatGen.setup();
  await mapdatGen.processImageData({ data: classicImg.data }, 1, 1);
  const mdLayouts = mapdatGen.extractColoursLayouts(classicImg.data, 1, 1);
  const mdBytes = mapdatGen.buildMapdatBytes(mdLayouts[0][0].coloursLayout);
  const mr = new NBTReader(mdBytes.buffer ? mdBytes.buffer : mdBytes);
  const mroot = mr.readNamedTag();
  const colors = mroot.value.data.value.colors.value;
  assert(colors.length === 16384, "map.dat colors = 16384 bytes (got " + colors.length + ")");
  assert(mroot.value.data.value.dimension.value === "minecraft:overworld", "dimension string for 1.18+");
  const expectedColor = 4 * C["0"].mapdatId + 0; // dark tone of colourSet 0 (first pixel is dark in classicImg)
  const topLeft = colors[0];
  assert(topLeft === expectedColor, "map.dat first color = " + expectedColor + " (got " + topLeft + ")");

  console.log("=== Test 7: multi-map merged litematic ===");
  const multiImg = makeTestImage(2, 2, (x, y, w, h) => [Math.floor((x / w) * 255), 100, Math.floor((y / h) * 255)]);
  let genMulti = makeGenerator({ staircaseId: K.STAIRCASING.OFF.id, ditherId: K.DITHER_METHODS.None.id });
  genMulti.setup();
  await genMulti.processImageData({ data: multiImg.data }, 2, 2);
  const multiLayouts = genMulti.extractColoursLayouts(multiImg.data, 2, 2);
  const merged = genMulti.buildMergedPhysicalLayout(multiLayouts);
  assert(merged.size[0] === 256 && merged.size[1] === 1 && merged.size[2] === 256, "merged size 256x1x256 (got " + JSON.stringify(merged.size) + ")");
  assert(merged.blocks.length === 65536, "merged blocks = 65536 (got " + merged.blocks.length + ")");
  const litematicMulti = genMulti.buildLitematicBytes(multiLayouts, "multi");
  const gun2 = zlib.gunzipSync(Buffer.from(litematicMulti));
  const lr2 = new NBTReader(gun2.buffer.slice(gun2.byteOffset, gun2.byteOffset + gun2.byteLength));
  const lroot2 = lr2.readNamedTag();
  const region2 = lroot2.value.Regions.value.mapart.value;
  assert(JSON.stringify(readVec3(region2.Size.value)) === JSON.stringify(merged.size), "litematic region size matches merged");

  console.log("=== Test 8: zip writer ===");
  const { ZipWriter } = require(path.join(ROOT, "js", "zip.js"));
  const zip = new ZipWriter();
  zip.addFile("Schematic-NBT/map_0_0.nbt", new Uint8Array([1, 2, 3]));
  zip.addFile("使用说明.txt", new TextEncoder().encode("你好 world"));
  const zipBytes = zip.build();
  const zv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const sig1 = zv.getUint32(0, true);
  assert(sig1 === 0x04034b50, "zip local header signature");
  const nameLen1 = zv.getUint16(26, true);
  const name1 = new TextDecoder().decode(zipBytes.subarray(30, 30 + nameLen1));
  assert(name1 === "Schematic-NBT/map_0_0.nbt", "zip entry 1 name");
  const eocdOffset = zipBytes.length - 22;
  assert(zv.getUint32(eocdOffset, true) === 0x06054b50, "zip EOCD signature");
  const count = zv.getUint16(eocdOffset + 10, true);
  assert(count === 2, "zip has 2 entries");
  console.log("  PASS: zip structure");

  console.log("=== Test 9: support block modes (no noobline, flat) ===");
  for (const [modeId, modeName] of [[1, "IMPORTANT"], [2, "ALL_OPTIMIZED"], [3, "ALL_DOUBLE"]]) {
    let g = makeGenerator({ staircaseId: K.STAIRCASING.OFF.id, supportModeId: modeId, ditherId: K.DITHER_METHODS.None.id });
    g.setup();
    const img9 = makeTestImage(1, 1, () => [89, 125, 39]); // colourSet 0 dark; grass_block is not gravity-affected
    await g.processImageData({ data: img9.data }, 1, 1);
    const l9 = g.extractColoursLayouts(img9.data, 1, 1);
    const r9 = g.buildPhysicalLayout(l9[0][0].coloursLayout);
    const sc9 = r9.blocks.filter((b) => b.csId === "NOOBLINE_SCAFFOLD").length;
    const expect9 = modeId === 1 ? 0 : modeId === 2 ? 0 : 16384;
    assert(sc9 === expect9, modeName + ": flat scaffold count = " + expect9 + " (got " + sc9 + ")");
    const nbt9 = g.buildSchematicNbt(l9[0][0].coloursLayout);
    const rr9 = new NBTReader(nbt9.buffer ? nbt9.buffer : nbt9);
    const root9 = rr9.readNamedTag();
    assert(root9.value.size.value.value[1] === 3, modeName + ": flat height 3 (y=2 paint, y=1 support)");
  }

  console.log("=== Test 10: version-specific block names ===");
  const verGen12 = makeGenerator({ mcVersion: "1.12.2" });
  const verGen113 = makeGenerator({ mcVersion: "1.13.2" });
  const verGen121 = makeGenerator({ mcVersion: "1.21.11" });
  const b12 = verGen12.blockNBTNameAndArgs("0", "0");
  const b113 = verGen113.blockNBTNameAndArgs("0", "0");
  const b121 = verGen121.blockNBTNameAndArgs("0", "0");
  assert(b12.name === "minecraft:grass", "1.12.2 uses legacy name (got " + b12.name + ")");
  assert(b113.name === "minecraft:grass_block", "1.13.2 uses new name (got " + b113.name + ")");
  assert(b121.name === "minecraft:grass_block", "1.21.11 falls back to 1.13+ name (got " + b121.name + ")");

  console.log("=== Test 11: litematic with support blocks + noobline (classic) ===");
  let g11 = makeGenerator({ staircaseId: K.STAIRCASING.CLASSIC.id, supportModeId: K.SUPPORT_MODES.ALL_OPTIMIZED.id, includeNoobline: true, ditherId: K.DITHER_METHODS.None.id });
  g11.setup();
  const img11 = makeTestImage(1, 1, (x, y) => (y < 43 ? [89, 125, 39] : y < 86 ? [109, 153, 48] : [127, 178, 56]));
  await g11.processImageData({ data: img11.data }, 1, 1);
  const l11 = g11.extractColoursLayouts(img11.data, 1, 1);
  const lt11 = g11.buildLitematicBytes(l11, "supporttest");
  const gz11 = zlib.gunzipSync(Buffer.from(lt11));
  const lr11 = new NBTReader(gz11.buffer.slice(gz11.byteOffset, gz11.byteOffset + gz11.byteLength));
  const lroot11 = lr11.readNamedTag();
  const reg11 = lroot11.value.Regions.value.mapart.value;
  const pal11 = reg11.BlockStatePalette.value.value.map((p) => p.Name.value);
  const bits11 = Math.max(2, 32 - Math.clz32(pal11.length - 1));
  const vol11 = readVec3(reg11.Size.value)[0] * readVec3(reg11.Size.value)[1] * readVec3(reg11.Size.value)[2];
  const unpacked11 = unpackLongs(reg11.BlockStates.value, bits11, vol11);
  assert(pal11.includes("minecraft:cobblestone"), "support block in litematic palette");
  const phys11 = g11.buildPhysicalLayout(l11[0][0].coloursLayout);
  const sx11 = readVec3(reg11.Size.value)[0], sz11 = readVec3(reg11.Size.value)[2];
  const exp11 = new Map();
  const idOf = (name) => pal11.indexOf(name);
  for (const b of phys11.blocks) {
    const name = b.csId === "NOOBLINE_SCAFFOLD" ? "minecraft:cobblestone" : "minecraft:grass_block";
    exp11.set(b.y * sx11 * sz11 + b.z * sx11 + b.x, idOf(name));
  }
  let errs11 = 0;
  for (let i = 0; i < vol11; i++) if (unpacked11[i] !== (exp11.has(i) ? exp11.get(i) : 0)) errs11++;
  assert(errs11 === 0, "litematic with supports matches expected (errors=" + errs11 + ")");
  assert(phys11.supportCount > 0, "support count > 0 in ALL_OPTIMIZED (got " + phys11.supportCount + ")");

  console.log("=== Test 12: zip contents roundtrip ===");
  const z12 = new ZipWriter();
  z12.addFile("A.txt", new TextEncoder().encode("hello 你好"));
  z12.addFile("Schematic-NBT/map_0_0.nbt", new Uint8Array([1, 2, 3, 4, 5]));
  const zipBytes12 = z12.build();
  const zv12 = new DataView(zipBytes12.buffer, zipBytes12.byteOffset, zipBytes12.byteLength);
  const eocd12 = zipBytes12.length - 22;
  const cdOffset = zv12.getUint32(eocd12 + 16, true);
  const cdCount = zv12.getUint16(eocd12 + 10, true);
  assert(cdCount === 2, "zip has 2 entries");
  const found = {};
  let pos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    assert(zv12.getUint32(pos, true) === 0x02014b50, "central header signature");
    const nameLen = zv12.getUint16(pos + 28, true);
    const extraLen = zv12.getUint16(pos + 30, true);
    const commentLen = zv12.getUint16(pos + 32, true);
    const method = zv12.getUint16(pos + 10, true);
    const compSize = zv12.getUint32(pos + 20, true);
    const size = zv12.getUint32(pos + 24, true);
    const localOff = zv12.getUint32(pos + 42, true);
    const name = new TextDecoder().decode(zipBytes12.subarray(pos + 46, pos + 46 + nameLen));
    const lv = new DataView(zipBytes12.buffer, zipBytes12.byteOffset, zipBytes12.byteLength);
    const lNameLen = lv.getUint16(localOff + 26, true);
    const lExtraLen = lv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = zipBytes12.subarray(dataStart, dataStart + compSize);
    if (method === 8) {
      found[name] = new Uint8Array(zlib.inflateRawSync(Buffer.from(raw)));
    } else {
      found[name] = new Uint8Array(raw);
    }
    assert(found[name].length === size, "entry " + name + " size " + found[name].length + " == " + size);
    pos += 46 + nameLen + extraLen + commentLen;
  }
  const txtA = new TextDecoder().decode(found["A.txt"]);
  assert(txtA === "hello 你好", "A.txt content roundtrip (got " + txtA + ")");
  assert(Array.from(found["Schematic-NBT/map_0_0.nbt"]).join(",") === "1,2,3,4,5", "nbt bytes roundtrip");

  console.log("=== Test 13: big merged classic staircase litematic (4x4 maps) ===");
  let g13 = makeGenerator({ staircaseId: K.STAIRCASING.CLASSIC.id, ditherId: K.DITHER_METHODS.None.id });
  g13.setup();
  const img13 = makeTestImage(4, 4, (x, y) => [Math.floor((x / 512) * 255), Math.floor((y / 512) * 255), 128]);
  await g13.processImageData({ data: img13.data }, 4, 4);
  const l13 = g13.extractColoursLayouts(img13.data, 4, 4);
  const phys13 = g13.buildMergedPhysicalLayout(l13);
  assert(phys13.size[0] === 512 && phys13.size[2] === 512, "4x4 merged size 512x512");
  const lt13 = g13.buildLitematicBytes(l13, "big");
  const gz13 = zlib.gunzipSync(Buffer.from(lt13));
  const lr13 = new NBTReader(gz13.buffer.slice(gz13.byteOffset, gz13.byteOffset + gz13.byteLength));
  const lroot13 = lr13.readNamedTag();
  const reg13 = lroot13.value.Regions.value.mapart.value;
  assert(JSON.stringify(readVec3(reg13.Size.value)) === JSON.stringify(phys13.size), "4x4 litematic size matches");
  const pal13 = reg13.BlockStatePalette.value.value.map((p) => p.Name.value);
  const bits13 = Math.max(2, 32 - Math.clz32(pal13.length - 1));
  assert(
    reg13.BlockStates.value.length === Math.ceil((phys13.size[0] * phys13.size[1] * phys13.size[2] * bits13) / 8),
    "4x4 BlockStates length ok (" + reg13.BlockStates.value.length + " vs " + Math.ceil((phys13.size[0] * phys13.size[1] * phys13.size[2] * bits13) / 8) + ")"
  );
  console.log("=== Test 14: split litematic per map cell ===");
  let g14 = makeGenerator({ staircaseId: K.STAIRCASING.OFF.id, ditherId: K.DITHER_METHODS.None.id });
  g14.setup();
  await g14.processImageData({ data: multiImg.data }, 2, 2);
  const l14 = g14.extractColoursLayouts(multiImg.data, 2, 2);
  for (let my = 0; my < 2; my++) {
    for (let mx = 0; mx < 2; mx++) {
      const single = [[l14[my][mx]]];
      const bytes = g14.buildLitematicBytes(single, `test_map_${mx}_${my}`);
      const gz = zlib.gunzipSync(Buffer.from(bytes));
      const lr14 = new NBTReader(gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength));
      const lroot14 = lr14.readNamedTag();
      const reg14 = lroot14.value.Regions.value.mapart.value;
      const sz = readVec3(reg14.Size.value);
      assert(sz[0] === 128 && sz[1] === 1 && sz[2] === 128, `split litematic ${mx}x${my} size 128x1x128 (got ${JSON.stringify(sz)})`);
      assert(lroot14.value.Metadata.value.Name.value === `test_map_${mx}_${my}`, `split litematic ${mx}x${my} metadata name`);
    }
  }
  console.log("  PASS: split litematic files valid (4 cells)");
  console.log("=== Test 15: multi-colourSet merged litematic (bits=3+ packing) ===");
  const g15 = makeGenerator({ staircaseId: K.STAIRCASING.OFF.id, ditherId: K.DITHER_METHODS.None.id });
  g15.setup();
  const mw = 3 * 128, mh = 2 * 128;
  const data15 = new Uint8ClampedArray(mw * mh * 4);
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      const mx = Math.floor(x / 128);
      const my = Math.floor(y / 128);
      const tone = C[String(mx + my * 3 + 1)].tonesRGB.normal;
      const i = (y * mw + x) * 4;
      data15[i] = tone[0]; data15[i + 1] = tone[1]; data15[i + 2] = tone[2]; data15[i + 3] = 255;
    }
  }
  await g15.processImageData({ data: data15 }, 3, 2);
  const l15 = g15.extractColoursLayouts(data15, 3, 2);
  const lt15 = g15.buildLitematicBytes(l15, "multi");
  const gz15 = zlib.gunzipSync(Buffer.from(lt15));
  const lr15 = new NBTReader(gz15.buffer.slice(gz15.byteOffset, gz15.byteOffset + gz15.byteLength));
  const reg15 = lr15.readNamedTag().value.Regions.value.mapart.value;
  const size15 = readVec3(reg15.Size.value);
  const pal15 = reg15.BlockStatePalette.value.value.map((p) => p.Name.value);
  const bits15 = Math.max(2, 32 - Math.clz32(pal15.length - 1));
  const vol15 = size15[0] * size15[1] * size15[2];
  const unpacked15 = unpackLongs(new Uint8Array(reg15.BlockStates.value), bits15, vol15);
  let errs15 = 0;
  const sx15 = size15[0], sz15 = size15[2];
  for (let idx = 0; idx < vol15; idx++) {
    const x = idx % sx15;
    const z = Math.floor(idx / sx15) % sz15;
    const y = Math.floor(idx / (sx15 * sz15));
    const mx = Math.floor(x / 128);
    const my = Math.floor(z / 128);
    const expectedName = y === 0 ? "minecraft:" + g15.resolveBlockNBTData(C[String(mx + my * 3 + 1)].blocks["0"]).NBTName : "minecraft:air";
    const expected = pal15.indexOf(expectedName);
    if (unpacked15[idx] !== expected) errs15++;
  }
  assert(errs15 === 0, "multi-colourSet merged litematic content correct (bits=" + bits15 + ", errors=" + errs15 + ")");
  assert(
    reg15.BlockStates.value.length === Math.ceil((vol15 * bits15) / 64) * 8,
    "BlockStates aligned to whole longs (" + reg15.BlockStates.value.length + " bytes)"
  );
  console.log("=== Test 16: cross-validation with @kleppe/litematic-reader algorithm (big-endian longs) ===");
  // regenerate the 5x5 flat gradient (61 colours, Floyd-Steinberg) used in test 15's spirit
  const g16 = makeGenerator({ staircaseId: K.STAIRCASING.OFF.id, ditherId: K.DITHER_METHODS.FloydSteinberg.id });
  g16.setup();
  const w16 = 3 * 128, h16 = 3 * 128;
  const data16 = new Uint8ClampedArray(w16 * h16 * 4);
  for (let y = 0; y < h16; y++) {
    for (let x = 0; x < w16; x++) {
      const i = (y * w16 + x) * 4;
      data16[i] = Math.floor((x / w16) * 255);
      data16[i + 1] = Math.floor((y / h16) * 255);
      data16[i + 2] = 128;
      data16[i + 3] = 255;
    }
  }
  await g16.processImageData({ data: data16 }, 3, 3);
  const l16 = g16.extractColoursLayouts(data16, 3, 3);
  const lt16 = g16.buildLitematicBytes(l16, "cross");
  const gz16 = zlib.gunzipSync(Buffer.from(lt16));
  const lr16 = new NBTReader(gz16.buffer.slice(gz16.byteOffset, gz16.byteOffset + gz16.byteLength));
  const reg16 = lr16.readNamedTag().value.Regions.value.mapart.value;
  const pal16 = reg16.BlockStatePalette.value.value.map((p) => p.Name.value);
  const bits16 = Math.max(2, 32 - Math.clz32(pal16.length - 1));
  const size16 = readVec3(reg16.Size.value);
  const vol16 = size16[0] * size16[1] * size16[2];
  const bytes16 = new Uint8Array(reg16.BlockStates.value);
  const mine16 = unpackLongs(bytes16, bits16, vol16);
  const theirs16 = expandLongPackedArray(bytes16, bits16, vol16);
  let agree = 0;
  for (let i = 0; i < vol16; i++) if (mine16[i] === theirs16[i]) agree++;
  assert(agree === vol16, "my unpacker agrees with kleppe reader (" + agree + "/" + vol16 + ")");
  // verify against per-cell NBT content
  const exp16 = new Map();
  const idOf16 = (name) => pal16.indexOf(name);
  for (let my = 0; my < 3; my++) {
    for (let mx = 0; mx < 3; mx++) {
      const nbt16 = g16.buildSchematicNbt(l16[my][mx].coloursLayout);
      const r16 = new NBTReader(nbt16.buffer ? nbt16.buffer : nbt16);
      const root16 = r16.readNamedTag();
      const schPal16 = root16.value.palette.value.value.map((p) => p.Name.value);
      for (const b of root16.value.blocks.value.value) {
        const [x, y, z] = b.pos.value.value;
        exp16.set(y * size16[0] * size16[2] + (my * 128 + z) * size16[0] + (mx * 128 + x), idOf16(schPal16[b.state.value]));
      }
    }
  }
  let errs16 = 0;
  for (let i = 0; i < vol16; i++) if (theirs16[i] !== (exp16.has(i) ? exp16.get(i) : 0)) errs16++;
  assert(errs16 === 0, "kleppe-reader output matches per-cell NBT content (errors=" + errs16 + ")");
  console.log("=== Test 17: merged NBT (whole image, single file) ===");
  const g17 = makeGenerator({ staircaseId: K.STAIRCASING.CLASSIC.id, ditherId: K.DITHER_METHODS.FloydSteinberg.id });
  g17.setup();
  const w17 = 2 * 128, h17 = 2 * 128;
  const data17 = new Uint8ClampedArray(w17 * h17 * 4);
  for (let y = 0; y < h17; y++) {
    for (let x = 0; x < w17; x++) {
      const i = (y * w17 + x) * 4;
      data17[i] = Math.floor((x / w17) * 255);
      data17[i + 1] = Math.floor((y / h17) * 255);
      data17[i + 2] = 128;
      data17[i + 3] = 255;
    }
  }
  await g17.processImageData({ data: data17 }, 2, 2);
  const l17 = g17.extractColoursLayouts(data17, 2, 2);
  const mergedNbt = g17.buildSchematicNbtMerged(l17);
  const r17 = new NBTReader(mergedNbt.buffer ? mergedNbt.buffer : mergedNbt);
  const root17 = r17.readNamedTag();
  const size17 = root17.value.size.value.value;
  assert(size17[0] === 256 && size17[2] === 256, "merged NBT size 256x" + size17[1] + "x256 (got " + JSON.stringify(size17) + ")");
  const blocks17 = root17.value.blocks.value.value;
  const splitBlocks = [];
  for (let my = 0; my < 2; my++) {
    for (let mx = 0; mx < 2; mx++) {
      const nb = g17.buildSchematicNbt(l17[my][mx].coloursLayout);
      const rr = new NBTReader(nb.buffer ? nb.buffer : nb);
      splitBlocks.push(...rr.readNamedTag().value.blocks.value.value);
    }
  }
  assert(blocks17.length === splitBlocks.length, "merged block count matches split total (" + blocks17.length + " vs " + splitBlocks.length + ")");
  // classic mode normalises each column once for the merged art, so y may differ from split cells;
  // verify that for every split block, the merged art has the same block name at the same (x, z)
  const pal17 = root17.value.palette.value.value.map((p) => p.Name.value);
  const mergedXZ = new Map();
  for (const b of blocks17) {
    const [x, y, z] = b.pos.value.value;
    mergedXZ.set(x + "," + z, pal17[b.state.value]);
  }
  let ok17 = true;
  let bad17 = 0;
  for (let my = 0; my < 2 && ok17; my++) {
    for (let mx = 0; mx < 2 && ok17; mx++) {
      const nb = g17.buildSchematicNbt(l17[my][mx].coloursLayout);
      const rr = new NBTReader(nb.buffer ? nb.buffer : nb);
      const root17b = rr.readNamedTag();
      const pal17b = root17b.value.palette.value.value.map((p) => p.Name.value);
      for (const b of root17b.value.blocks.value.value) {
        const [x, y, z] = b.pos.value.value;
        const gx = mx * 128 + x;
        const gz = my * 128 + z;
        const expected = pal17b[b.state.value];
        if (mergedXZ.get(gx + "," + gz) !== expected) { bad17++; if (bad17 > 5) { ok17 = false; break; } }
      }
    }
  }
  assert(bad17 === 0, "merged NBT matches split blocks at every (x,z) position (errors=" + bad17 + ")");
  assert(pal17.length >= 2 && pal17.includes("minecraft:air") === false, "merged NBT palette valid (" + pal17.length + " entries)");
  console.log("=== Test 18: wall mode (vertical pixel art) ===");
  const W18 = 100, H18 = 100;
  const g18 = makeGenerator({ wallMode: true, staircaseId: K.STAIRCASING.CLASSIC.id, ditherId: K.DITHER_METHODS.None.id });
  g18.setup();
  assert(JSON.stringify(g18.getToneKeys()) === JSON.stringify(["normal"]), "wall mode forces normal tone only");
  const data18 = new Uint8ClampedArray(W18 * H18 * 4);
  for (let y = 0; y < H18; y++) {
    for (let x = 0; x < W18; x++) {
      const i = (y * W18 + x) * 4;
      // top half colourSet 0 normal, bottom half colourSet 1 normal
      const tone = y < 50 ? C["0"].tonesRGB.normal : C["1"].tonesRGB.normal;
      data18[i] = tone[0]; data18[i + 1] = tone[1]; data18[i + 2] = tone[2]; data18[i + 3] = 255;
    }
  }
  await g18.processImageData({ data: data18, width: W18 }, 1, 1);
  const wallLayout = g18.extractColoursLayoutWall(data18, W18, H18);
  assert(wallLayout.length === W18 && wallLayout[0].length === H18, "wall layout is W x H");
  const wallPhys = g18.buildWallPhysicalLayout(wallLayout);
  assert(JSON.stringify(wallPhys.size) === "[100,100,1]", "wall physical size 100x100x1 (got " + JSON.stringify(wallPhys.size) + ")");
  assert(wallPhys.blocks.length === W18 * H18, "wall has 10000 blocks (got " + wallPhys.blocks.length + ")");
  // image top row (row 0, colourSet 0) must be at y = H-1
  const topBlock = wallPhys.blocks.find((b) => b.x === 0 && b.z === 0 && b.y === H18 - 1);
  assert(topBlock && topBlock.csId === "0", "image top row at y=H-1 with colourSet 0");
  const bottomBlock = wallPhys.blocks.find((b) => b.x === 0 && b.z === 0 && b.y === 0);
  assert(bottomBlock && bottomBlock.csId === "1", "image bottom row at y=0 with colourSet 1");
  // NBT
  const wallNbt = g18.buildWallSchematicNbt(wallLayout);
  const wr18 = new NBTReader(wallNbt.buffer ? wallNbt.buffer : wallNbt);
  const wroot18 = wr18.readNamedTag();
  assert(JSON.stringify(wroot18.value.size.value.value) === "[100,100,1]", "wall NBT size 100x100x1");
  assert(wroot18.value.blocks.value.value.length === 10000, "wall NBT block count 10000");
  const wpal18 = wroot18.value.palette.value.value.map((p) => p.Name.value);
  const wblockTop = wroot18.value.blocks.value.value.find((b) => JSON.stringify(b.pos.value.value) === JSON.stringify([0, 99, 0]));
  assert(wblockTop && wpal18[wblockTop.state.value] === "minecraft:grass_block", "wall NBT top pixel is grass_block at y=99");
  // litematic
  const wallLt = g18.buildWallLitematic(wallLayout, "walltest");
  const wgz18 = zlib.gunzipSync(Buffer.from(wallLt));
  const wlr18 = new NBTReader(wgz18.buffer.slice(wgz18.byteOffset, wgz18.byteOffset + wgz18.byteLength));
  const wreg18 = wlr18.readNamedTag().value.Regions.value.mapart.value;
  const wsize18 = readVec3(wreg18.Size.value);
  assert(JSON.stringify(wsize18) === "[100,100,1]", "wall litematic size 100x100x1 (got " + JSON.stringify(wsize18) + ")");
  const wpalNames18 = wreg18.BlockStatePalette.value.value.map((p) => p.Name.value);
  const wbits18 = Math.max(2, 32 - Math.clz32(wpalNames18.length - 1));
  const wvol18 = 100 * 100 * 1;
  const wun18 = expandLongPackedArray(new Uint8Array(wreg18.BlockStates.value), wbits18, wvol18);
  // index = y*sx*sz + z*sx + x -> flat: idx = y*100 + x
  const topIdx = (H18 - 1) * 100 + 0;
  const bottomIdx = 0 * 100 + 0;
  assert(wpalNames18[wun18[topIdx]] === "minecraft:grass_block", "wall litematic top pixel grass_block (kleppe reader)");
  assert(wpalNames18[wun18[bottomIdx]] === "minecraft:sand", "wall litematic bottom pixel sand (kleppe reader)");

  console.log("=== Test 19: wall split cells (150x150) ===");
  const W19 = 150, H19 = 150;
  const g19 = makeGenerator({ wallMode: true, ditherId: K.DITHER_METHODS.None.id });
  g19.setup();
  const data19 = new Uint8ClampedArray(W19 * H19 * 4);
  for (let y = 0; y < H19; y++) {
    for (let x = 0; x < W19; x++) {
      const i = (y * W19 + x) * 4;
      const tone = C["0"].tonesRGB.normal;
      data19[i] = tone[0]; data19[i + 1] = tone[1]; data19[i + 2] = tone[2]; data19[i + 3] = 255;
    }
  }
  await g19.processImageData({ data: data19, width: W19 }, 2, 2);
  const wallLayout19 = g19.extractColoursLayoutWall(data19, W19, H19);
  const cells = [[0, 0, 128, 128], [1, 0, 22, 128], [0, 1, 128, 22], [1, 1, 22, 22]];
  let cellsOk = true;
  for (const [cx, cy, cw, ch] of cells) {
    const cellNbt = g19.buildWallSchematicNbtCell(wallLayout19, cx * 128, cy * 128, cw, ch);
    const cr = new NBTReader(cellNbt.buffer ? cellNbt.buffer : cellNbt);
    const croot = cr.readNamedTag();
    const csize = croot.value.size.value.value;
    const cblocks = croot.value.blocks.value.value.length;
    if (JSON.stringify(csize) !== JSON.stringify([cw, ch, 1]) || cblocks !== cw * ch) {
      cellsOk = false;
      console.error("   cell " + cx + "," + cy + " size " + JSON.stringify(csize) + " blocks " + cblocks + " expected " + cw + "x" + ch);
    }
  }
  assert(cellsOk, "150x150 wall splits into 128/22 cells with correct sizes and counts");

  console.log("=== Test 20: solid preset wall safety ===");
  const solidPreset = [];
  for (const [csId, cs] of Object.entries(C)) {
    let chosen = null;
    for (const [blockId, block] of Object.entries(cs.blocks)) {
      if (!K.isWallUnsupported(block.displayName)) { chosen = blockId; break; }
    }
    if (chosen !== null) solidPreset.push([csId, chosen]);
  }
  const unsafe = solidPreset.filter(([csId, blockId]) => K.isWallUnsupported(C[csId].blocks[blockId].displayName));
  assert(unsafe.length === 0, "solid preset contains only wall-safe blocks (" + solidPreset.length + " colourSets)");
  const waterHasSolid = Object.values(C["10"].blocks).some((b) => !K.isWallUnsupported(b.displayName));
  assert(!waterHasSolid, "Water colourSet (10) has no wall-safe block -> disabled in wall mode");
  const cobwebPick = solidPreset.find(([csId]) => csId === "2");
  assert(cobwebPick && C["2"].blocks[cobwebPick[1]].displayName === "Mushroom Stem", "Cobweb colourSet falls back to Mushroom Stem");
  const lichenPick = solidPreset.find(([csId]) => csId === "60");
  assert(lichenPick && C["60"].blocks[lichenPick[1]].displayName === "Verdant Froglight", "Glow Lichen colourSet falls back to Verdant Froglight");

  console.log("=== Test 21: block presets validity ===");
  for (const preset of K.BLOCK_PRESETS) {
    const invalid = preset.blocks.filter(([csId, blockId]) => !C[csId] || !C[csId].blocks[blockId]);
    assert(invalid.length === 0, "preset「" + preset.name + "」has " + preset.blocks.length + " valid blocks");
  }
  const mix = K.BLOCK_PRESETS.find((p) => p.name === "综合材料");
  assert(mix && mix.blocks.length === 43, "综合材料 preset has 43 colourSets (got " + (mix ? mix.blocks.length : 0) + ")");
  const mixMaterials = mix.blocks.map(([csId, blockId]) => {
    const n = C[csId].blocks[blockId].displayName.toLowerCase();
    if (n.includes("terracotta") && !n.includes("glazed")) return "terracotta";
    if (n.includes("concrete") && !n.includes("powder")) return "concrete";
    if (n.endsWith("wool")) return "wool";
    if (n.includes("planks")) return "planks";
    return "wood";
  });
  const kinds = new Set(mixMaterials);
  assert(kinds.has("terracotta") && kinds.has("concrete") && kinds.has("planks") && kinds.has("wood"), "综合材料 mixes terracotta/concrete/planks/wood");
  const woolMix = K.BLOCK_PRESETS.find((p) => p.name === "综合·羊毛");
  assert(woolMix && woolMix.blocks.length === 43, "综合·羊毛 preset has 43 colourSets (got " + (woolMix ? woolMix.blocks.length : 0) + ")");
  const woolShared = woolMix.blocks.filter(([csId]) => parseInt(csId, 10) >= 13 && parseInt(csId, 10) <= 28);
  const allWool = woolShared.every(([csId, blockId]) => C[csId].blocks[blockId].displayName.toLowerCase().endsWith("wool"));
  assert(allWool, "综合·羊毛 uses wool for all 16 shared colourSets");

  console.log("=== Test 22: transparent PNG background -> empty cells ===");
  const g22 = makeGenerator({ transparency: true, transparencyTolerance: 128, ditherId: K.DITHER_METHODS.None.id });
  g22.setup();
  const data22 = new Uint8ClampedArray(128 * 128 * 4);
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 128; x++) {
      const i = (y * 128 + x) * 4;
      if (x < 64) {
        // opaque green area (exact colourSet 0 normal)
        const t = C["0"].tonesRGB.normal;
        data22[i] = t[0]; data22[i + 1] = t[1]; data22[i + 2] = t[2]; data22[i + 3] = 255;
      } else {
        // fully transparent area (RGB 0,0,0 like PNG transparent pixels)
        data22[i] = 0; data22[i + 1] = 0; data22[i + 2] = 0; data22[i + 3] = 0;
      }
    }
  }
  await g22.processImageData({ data: data22 }, 1, 1);
  const l22 = g22.extractColoursLayouts(data22, 1, 1);
  let transparentCells = 0;
  for (let x = 0; x < 128; x++) for (let z = 0; z < 128; z++) if (l22[0][0].coloursLayout[x][z].colourSetId === "-1") transparentCells++;
  assert(transparentCells === 64 * 128, "transparent pixels extracted as empty cells (got " + transparentCells + ")");
  const nbt22 = g22.buildSchematicNbt(l22[0][0].coloursLayout);
  const r22 = new NBTReader(nbt22.buffer ? nbt22.buffer : nbt22);
  const root22 = r22.readNamedTag();
  assert(root22.value.blocks.value.value.length === 64 * 128, "NBT skips transparent pixels, 8192 blocks (got " + root22.value.blocks.value.value.length + ")");
  const lt22 = g22.buildLitematicBytes([[l22[0][0]]], "transparent");
  const gz22 = zlib.gunzipSync(Buffer.from(lt22));
  const lr22 = new NBTReader(gz22.buffer.slice(gz22.byteOffset, gz22.byteOffset + gz22.byteLength));
  const reg22 = lr22.readNamedTag().value.Regions.value.mapart.value;
  const pal22 = reg22.BlockStatePalette.value.value.map((p) => p.Name.value);
  const bits22 = Math.max(2, 32 - Math.clz32(pal22.length - 1));
  const un22 = expandLongPackedArray(new Uint8Array(reg22.BlockStates.value), bits22, 128 * 128);
  let airCells = 0;
  for (let i = 0; i < 128 * 128; i++) if (pal22[un22[i]] === "minecraft:air") airCells++;
  assert(airCells === 64 * 128, "litematic has air in transparent area (got " + airCells + ")");
  // without transparency the transparent area would become a block (black)
  const g22b = makeGenerator({ transparency: false, ditherId: K.DITHER_METHODS.None.id });
  g22b.setup();
  const data22b = new Uint8ClampedArray(data22);
  await g22b.processImageData({ data: data22b }, 1, 1);
  const l22b = g22b.extractColoursLayouts(data22b, 1, 1);
  let empty22b = 0;
  for (let x = 0; x < 128; x++) for (let z = 0; z < 128; z++) if (l22b[0][0].coloursLayout[x][z].colourSetId === "-1") empty22b++;
  assert(empty22b === 0, "with option off, no empty cells (old black behaviour)");

  console.log("=== Test 23: blue noise mask ===");
  const bn = K.getBlueNoiseMask();
  assert(bn && bn.size === 64, "blue noise mask decoded, size 64");
  let minV = 255, maxV = 0;
  for (const row of bn.matrix) for (const v of row) { if (v < minV) minV = v; if (v > maxV) maxV = v; }
  assert(minV === 0 && maxV === 255, "mask value range 0..255 (got " + minV + ".." + maxV + ")");
  let localDev = 0;
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      let s = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s += bn.matrix[(y + dy + 64) % 64][(x + dx + 64) % 64];
      localDev += Math.abs(s / 25 - 127.5);
    }
  }
  const devAvg = localDev / 4096;
  assert(devAvg < 8, "blue noise local deviation low, " + devAvg.toFixed(1) + " < 8 (white noise would be ~12)");

  console.log("=== Test 24: new dither algorithms ===");
  const ditherMethodsToTest = [
    [K.DITHER_METHODS.Bayer88.id, "Bayer 8x8", false],
    [K.DITHER_METHODS.BlueNoise.id, "Blue Noise", false],
    [K.DITHER_METHODS.Yliluoma.id, "Yliluoma", false],
    [K.DITHER_METHODS.Riemersma.id, "Riemersma", false],
    [K.DITHER_METHODS.FloydSteinberg.id, "Floyd-Steinberg + serpentine", true],
  ];
  const W24 = 64, H24 = 64;
  const src24 = new Uint8ClampedArray(W24 * H24 * 4);
  for (let y = 0; y < H24; y++) {
    for (let x = 0; x < W24; x++) {
      const i = (y * W24 + x) * 4;
      src24[i] = Math.floor((x / W24) * 255);
      src24[i + 1] = Math.floor((y / H24) * 255);
      src24[i + 2] = 128;
      src24[i + 3] = 255;
    }
  }
  const ditherOutputs = {};
  for (const [id, name, serp] of ditherMethodsToTest) {
    const g = makeGenerator({ ditherId: id, serpentine: serp, staircaseId: K.STAIRCASING.CLASSIC.id });
    g.setup();
    const data = new Uint8ClampedArray(src24);
    const res = await g.processImageData({ data, width: W24 }, 1, 1);
    let invalid = 0;
    let errSum = 0;
    for (let p = 0; p < W24 * H24; p++) {
      const i = p * 4;
      const cs = g.exactRGBToColourSetIdAndTone([data[i], data[i + 1], data[i + 2]]);
      if (!cs || cs.colourSetId === "-1") invalid++;
      errSum += Math.abs(data[i] - src24[i]) + Math.abs(data[i + 1] - src24[i + 1]) + Math.abs(data[i + 2] - src24[i + 2]);
    }
    const materialsTotal = Object.values(res.maps[0][0].materials).reduce((a, b) => a + b, 0);
    assert(invalid === 0, name + ": all pixels map to palette colours (invalid=" + invalid + ")");
    assert(materialsTotal === W24 * H24, name + ": materials total " + W24 * H24 + " (got " + materialsTotal + ")");
    // dithering quality: the average colour of an 8x8 block should be close to the source block average
    let blockErr = 0;
    let blocks = 0;
    for (let by = 0; by < H24; by += 8) {
      for (let bx = 0; bx < W24; bx += 8) {
        let sr = 0, sg = 0, sb = 0, qr = 0, qg = 0, qb = 0;
        for (let y = by; y < by + 8; y++) {
          for (let x = bx; x < bx + 8; x++) {
            const i = (y * W24 + x) * 4;
            sr += src24[i]; sg += src24[i + 1]; sb += src24[i + 2];
            qr += data[i]; qg += data[i + 1]; qb += data[i + 2];
          }
        }
        blockErr += (Math.abs(qr - sr) + Math.abs(qg - sg) + Math.abs(qb - sb)) / 64;
        blocks++;
      }
    }
    const meanBlockErr = blockErr / (blocks * 3);
    // ordered dithering is limited by palette granularity; error diffusion is much more accurate
    let limit = 17.0;
    if (id === K.DITHER_METHODS.Yliluoma.id) limit = 15;
    if (id === K.DITHER_METHODS.Riemersma.id || serp) limit = 10;
    assert(meanBlockErr < limit, name + ": mean block-average error " + meanBlockErr.toFixed(1) + " < " + limit + " (no-dither baseline ~17.1)");
    ditherOutputs[id + (serp ? "-serp" : "")] = data;
  }

  console.log("=== Test 25: serpentine changes error-diffusion output ===");
  const gPlain = makeGenerator({ ditherId: K.DITHER_METHODS.FloydSteinberg.id, serpentine: false, staircaseId: K.STAIRCASING.CLASSIC.id });
  gPlain.setup();
  const dataPlain = new Uint8ClampedArray(src24);
  await gPlain.processImageData({ data: dataPlain, width: W24 }, 1, 1);
  const dataSerp = ditherOutputs[K.DITHER_METHODS.FloydSteinberg.id + "-serp"];
  let diffPixels = 0;
  for (let p = 0; p < W24 * H24; p++) {
    if (dataPlain[p * 4] !== dataSerp[p * 4] || dataPlain[p * 4 + 1] !== dataSerp[p * 4 + 1] || dataPlain[p * 4 + 2] !== dataSerp[p * 4 + 2]) diffPixels++;
  }
  assert(diffPixels > 100, "serpentine produces a different pattern (" + diffPixels + " pixels differ)");

  console.log("=== Test 26: blue noise + Yliluoma hybrid ===");
  const g26a = makeGenerator({ ditherId: K.DITHER_METHODS.Yliluoma.id, staircaseId: K.STAIRCASING.CLASSIC.id });
  g26a.setup();
  const data26a = new Uint8ClampedArray(src24);
  await g26a.processImageData({ data: data26a, width: W24 }, 1, 1);
  const g26b = makeGenerator({ ditherId: K.DITHER_METHODS.BlueNoiseYliluoma.id, staircaseId: K.STAIRCASING.CLASSIC.id });
  g26b.setup();
  const data26b = new Uint8ClampedArray(src24);
  const res26b = await g26b.processImageData({ data: data26b, width: W24 }, 1, 1);
  let invalid26 = 0;
  let diff26 = 0;
  for (let p = 0; p < W24 * H24; p++) {
    const i = p * 4;
    const cs = g26b.exactRGBToColourSetIdAndTone([data26b[i], data26b[i + 1], data26b[i + 2]]);
    if (!cs || cs.colourSetId === "-1") invalid26++;
    if (data26a[i] !== data26b[i] || data26a[i + 1] !== data26b[i + 1]) diff26++;
  }
  const materials26 = Object.values(res26b.maps[0][0].materials).reduce((a, b) => a + b, 0);
  assert(invalid26 === 0, "hybrid: all pixels valid (invalid=" + invalid26 + ")");
  assert(materials26 === W24 * H24, "hybrid: materials total correct (" + materials26 + ")");
  assert(diff26 > 100, "hybrid differs from Bayer-based Yliluoma (" + diff26 + " pixels)");

  console.log("=== Test 27: CIEDE2000 colour metric ===");
  const g27 = makeGenerator({ ditherId: K.DITHER_METHODS.None.id, colourMetric: "ciede2000", staircaseId: K.STAIRCASING.CLASSIC.id });
  g27.setup();
  const data27 = new Uint8ClampedArray(src24);
  await g27.processImageData({ data: data27, width: W24 }, 1, 1);
  let invalid27 = 0;
  for (let p = 0; p < W24 * H24; p++) {
    const i = p * 4;
    const cs = g27.exactRGBToColourSetIdAndTone([data27[i], data27[i + 1], data27[i + 2]]);
    if (!cs || cs.colourSetId === "-1") invalid27++;
  }
  assert(invalid27 === 0, "ciede2000: all pixels valid (invalid=" + invalid27 + ")");
  const g27b = makeGenerator({ ditherId: K.DITHER_METHODS.None.id, colourMetric: "lab", staircaseId: K.STAIRCASING.CLASSIC.id });
  g27b.setup();
  const data27b = new Uint8ClampedArray(src24);
  await g27b.processImageData({ data: data27b, width: W24 }, 1, 1);
  let diff27 = 0;
  for (let p = 0; p < W24 * H24; p++) if (data27[p * 4] !== data27b[p * 4] || data27[p * 4 + 1] !== data27b[p * 4 + 1]) diff27++;
  assert(diff27 > 0, "ciede2000 differs from lab matching (" + diff27 + " pixels)");

  console.log("=== Test 28: isolated pixel suppression ===");
  const countIsolated = (data, W, H) => {
    let n = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (data[i + 3] === 0) continue;
        let same = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const j = (ny * W + nx) * 4;
          if (data[j] === data[i] && data[j + 1] === data[i + 1] && data[j + 2] === data[i + 2]) same++;
        }
        if (same === 0) n++;
      }
    }
    return n;
  };
  const g28a = makeGenerator({ ditherId: K.DITHER_METHODS.FloydSteinberg.id, staircaseId: K.STAIRCASING.CLASSIC.id });
  g28a.setup();
  const data28a = new Uint8ClampedArray(src24);
  await g28a.processImageData({ data: data28a, width: W24 }, 1, 1);
  const g28b = makeGenerator({ ditherId: K.DITHER_METHODS.FloydSteinberg.id, staircaseId: K.STAIRCASING.CLASSIC.id, isolatedCleanup: true, isolatedPasses: 1 });
  g28b.setup();
  const data28b = new Uint8ClampedArray(src24);
  const res28b = await g28b.processImageData({ data: data28b, width: W24 }, 1, 1);
  const isoBefore = countIsolated(data28a, W24, H24);
  const isoAfter = countIsolated(data28b, W24, H24);
  assert(isoAfter < isoBefore, "isolated pixels reduced: " + isoBefore + " -> " + isoAfter);
  let invalid28 = 0;
  for (let p = 0; p < W24 * H24; p++) {
    const i = p * 4;
    const cs = g28b.exactRGBToColourSetIdAndTone([data28b[i], data28b[i + 1], data28b[i + 2]]);
    if (!cs || cs.colourSetId === "-1") invalid28++;
  }
  const materials28 = Object.values(res28b.maps[0][0].materials).reduce((a, b) => a + b, 0);
  assert(invalid28 === 0, "suppression keeps all pixels valid (invalid=" + invalid28 + ")");
  assert(materials28 === W24 * H24, "suppression recount correct (" + materials28 + " == " + W24 * H24 + ")");

  console.log("=== Test 29: batch (band) processing matches single-shot ===");
  const mapsX29 = 3;
  const mapsY29 = 3;
  const W29 = mapsX29 * 128;
  const H29 = mapsY29 * 128;
  const src29 = new Uint8ClampedArray(W29 * H29 * 4);
  for (let y = 0; y < H29; y++) {
    for (let x = 0; x < W29; x++) {
      const i = (y * W29 + x) * 4;
      src29[i] = Math.floor((x / W29) * 255);
      src29[i + 1] = Math.floor((y / H29) * 255);
      src29[i + 2] = (x * 5 + y * 11) % 256;
      src29[i + 3] = 255;
    }
  }
  for (const [ditherId, ditherName, serp] of [
    [K.DITHER_METHODS.None.id, "None", false],
    [K.DITHER_METHODS.BlueNoise.id, "BlueNoise", false],
    [K.DITHER_METHODS.FloydSteinberg.id, "FloydSteinberg", false],
    [K.DITHER_METHODS.Stucki.id, "Stucki+serpentine", true],
    [K.DITHER_METHODS.BlueNoiseYliluoma.id, "BlueNoise-Yliluoma", false],
  ]) {
    const gSingle = makeGenerator({ ditherId, serpentine: serp, staircaseId: K.STAIRCASING.CLASSIC.id });
    gSingle.setup();
    const dataSingle = new Uint8ClampedArray(src29);
    await gSingle.processImageData({ data: dataSingle, width: W29 }, mapsX29, mapsY29);

    const gBatch = makeGenerator({ ditherId, serpentine: serp, staircaseId: K.STAIRCASING.CLASSIC.id });
    gBatch.setup();
    const dataBatch = new Uint8ClampedArray(src29); // bands write into their own buffers; we collect rows
    const out = new Uint8ClampedArray(W29 * H29 * 4);
    let carry = null;
    for (let mapRow = 0; mapRow < mapsY29; mapRow++) {
      const bandH = 130;
      const band = new Uint8ClampedArray(W29 * bandH * 4);
      const copyRows = Math.min(bandH, H29 - mapRow * 128);
      const srcStart = mapRow * 128 * W29 * 4;
      band.set(src29.subarray(srcStart, srcStart + copyRows * W29 * 4), 0);
      const res = await gBatch.processImageBand({ data: band, width: W29 }, mapRow, mapsX29, carry);
      carry = res.carry;
      out.set(band.subarray(0, 128 * W29 * 4), mapRow * 128 * W29 * 4);
    }
    let diff29 = 0;
    for (let i = 0; i < W29 * H29 * 4; i++) if (dataSingle[i] !== out[i]) diff29++;
    assert(diff29 === 0, "batch == single-shot for " + ditherName + " (diff bytes=" + diff29 + ")");
  }
  // Riemersma must be rejected in batch mode
  const gR = makeGenerator({ ditherId: K.DITHER_METHODS.Riemersma.id });
  gR.setup();
  let riemersmaRejected = false;
  try {
    await gR.processImageBand({ data: new Uint8ClampedArray(W29 * 130 * 4), width: W29 }, 0, mapsX29, null);
  } catch (e) {
    riemersmaRejected = true;
  }
  assert(riemersmaRejected, "Riemersma is rejected in batch mode");

  console.log("=== Test 30: column (vertical strip) batch processing ===");
  for (const [ditherId, ditherName, exactExpected] of [
    [K.DITHER_METHODS.None.id, "None", true],
    [K.DITHER_METHODS.BlueNoise.id, "BlueNoise", true],
    [K.DITHER_METHODS.BlueNoiseYliluoma.id, "BlueNoise-Yliluoma", true],
    [K.DITHER_METHODS.FloydSteinberg.id, "FloydSteinberg", false],
    [K.DITHER_METHODS.Burkes.id, "Burkes", false],
    [K.DITHER_METHODS.Stucki.id, "Stucki", false],
    [K.DITHER_METHODS.MinAvgErr.id, "MinAvgErr", false],
  ]) {
    const gSingle = makeGenerator({ ditherId, staircaseId: K.STAIRCASING.CLASSIC.id });
    gSingle.setup();
    const dataSingle = new Uint8ClampedArray(src29);
    await gSingle.processImageData({ data: dataSingle, width: W29 }, mapsX29, mapsY29);

    const gBatch = makeGenerator({ ditherId, staircaseId: K.STAIRCASING.CLASSIC.id });
    gBatch.setup();
    const out = new Uint8ClampedArray(W29 * H29 * 4);
    const carryCols = 2;
    let colCarry = null;
    for (let col = 0; col < mapsX29; col++) {
      const processWidth = 128;
      const bufferWidth = 128 + 2;
      const carryStart = 128;
      let rowCarry = null;
      const newColCarry = new Uint8ClampedArray(carryCols * mapsY29 * 128 * 4);
      for (let mapRow = 0; mapRow < mapsY29; mapRow++) {
        const bandH = 130;
        const band = new Uint8ClampedArray(bufferWidth * bandH * 4);
        for (let r = 0; r < bandH; r++) {
          const gy = mapRow * 128 + r;
          if (gy >= H29) break;
          for (let x = 0; x < bufferWidth; x++) {
            const gx = col * 128 + x;
            if (gx >= W29) continue;
            const srcI = (gy * W29 + gx) * 4;
            const dstI = (r * bufferWidth + x) * 4;
            band[dstI] = src29[srcI];
            band[dstI + 1] = src29[srcI + 1];
            band[dstI + 2] = src29[srcI + 2];
            band[dstI + 3] = src29[srcI + 3];
          }
        }
        gBatch.applyBandCarries(band, bufferWidth, mapRow, rowCarry, colCarry, carryCols);
        const res = await gBatch.processImageBand({ data: band, width: bufferWidth }, mapRow, 1, rowCarry, null, {
          processOffset: 0,
          processWidth,
          globalXOffset: 0,
        });
        rowCarry = res.carry;
        gBatch.storeColumnCarry(band, bufferWidth, mapRow, newColCarry, carryCols, carryStart);
        for (let r = 0; r < 128; r++) {
          for (let x = 0; x < 128; x++) {
            const dstI = ((mapRow * 128 + r) * W29 + col * 128 + x) * 4;
            const srcI = (r * bufferWidth + x) * 4;
            out[dstI] = band[srcI];
            out[dstI + 1] = band[srcI + 1];
            out[dstI + 2] = band[srcI + 2];
            out[dstI + 3] = band[srcI + 3];
          }
        }
      }
      colCarry = gBatch.isErrorDiffusionDither() ? newColCarry : null;
    }
    if (exactExpected) {
      let diff30 = 0;
      for (let i = 0; i < W29 * H29 * 4; i++) if (dataSingle[i] !== out[i]) diff30++;
      assert(diff30 === 0, "column batch == single-shot for " + ditherName + " (diff bytes=" + diff30 + ")");
    } else {
      // error diffusion cannot be bit-exact across column batches (its error flows right-to-left across rows);
      // verify the output is still fully valid and the difference stays bounded
      let invalid30 = 0;
      let diff30 = 0;
      for (let y = 0; y < H29; y++) {
        for (let x = 0; x < W29; x++) {
          const i = (y * W29 + x) * 4;
          const cs = gBatch.exactRGBToColourSetIdAndTone([out[i], out[i + 1], out[i + 2]]);
          if (!cs || cs.colourSetId === "-1") invalid30++;
          if (dataSingle[i] !== out[i] || dataSingle[i + 1] !== out[i + 1] || dataSingle[i + 2] !== out[i + 2]) diff30++;
        }
      }
      assert(invalid30 === 0, ditherName + ": column batch output all valid palette colours (invalid=" + invalid30 + ")");
      assert(diff30 < W29 * H29 * 0.5, ditherName + ": column batch difference bounded (" + diff30 + " pixels, " + ((diff30 / (W29 * H29)) * 100).toFixed(1) + "%)");
    }
  }
  console.log("=== Test 31: block-size (non-map) mode ===");
  {
    // 100x100 artwork on a 128x128 padded canvas: the padding must stay empty
    const W31 = 128, H31 = 128, artW31 = 100, artH31 = 100;
    const src31 = new Uint8ClampedArray(W31 * H31 * 4);
    for (let y = 0; y < artH31; y++) {
      for (let x = 0; x < artW31; x++) {
        const i = (y * W31 + x) * 4;
        src31[i] = (x * 2) % 256;
        src31[i + 1] = (y * 3) % 256;
        src31[i + 2] = (x * 7 + y * 13) % 256;
        src31[i + 3] = 255;
      }
    }
    const g31 = makeGenerator({ ditherId: K.DITHER_METHODS.None.id, artW: artW31, artH: artH31 });
    g31.setup();
    await g31.processImageData({ data: src31, width: W31 }, 1, 1);

    let padNonZero31 = 0;
    for (let y = 0; y < H31; y++) {
      for (let x = 0; x < W31; x++) {
        if (x < artW31 && y < artH31) continue;
        const i = (y * W31 + x) * 4;
        if (src31[i] || src31[i + 1] || src31[i + 2] || src31[i + 3]) padNonZero31++;
      }
    }
    assert(padNonZero31 === 0, "block-size padding stays empty (" + padNonZero31 + " stray pixels)");

    let layouts31 = g31.cropColoursLayouts(g31.extractColoursLayouts(src31, 1, 1), artW31, artH31);
    assert(layouts31[0][0].coloursLayout.length === 100 && layouts31[0][0].coloursLayout[0].length === 100, "cropped cell is 100x100");

    const merged31 = g31.buildMergedPhysicalLayout(layouts31);
    assert(merged31.size[0] === 100 && merged31.size[2] === 100, "merged physical size is 100 x 100 (got " + JSON.stringify(merged31.size) + ")");
    assert(merged31.blocks.length === 100 * 100, "merged layout has 10000 blocks (got " + merged31.blocks.length + ")");

    const nbt31 = g31.buildSchematicNbt(layouts31[0][0].coloursLayout);
    const root31 = new NBTReader(nbt31.buffer ? nbt31.buffer : nbt31).readNamedTag();
    const size31 = root31.value.size.value.value;
    assert(size31[0] === 100 && size31[2] === 100, "split NBT size is 100 x 100 (got " + JSON.stringify(size31) + ")");
    assert(root31.value.blocks.value.value.length === 100 * 100, "split NBT has 10000 blocks");

    const mergedNbt31 = g31.buildSchematicNbtMerged(layouts31);
    const mroot31 = new NBTReader(mergedNbt31.buffer ? mergedNbt31.buffer : mergedNbt31).readNamedTag();
    const msize31 = mroot31.value.size.value.value;
    assert(msize31[0] === 100 && msize31[2] === 100, "merged NBT size is 100 x 100 (got " + JSON.stringify(msize31) + ")");

    const lit31 = g31.buildLitematicBytes(layouts31, "blocktest");
    const gun31 = zlib.gunzipSync(Buffer.from(lit31));
    const lroot31 = new NBTReader(gun31.buffer.slice(gun31.byteOffset, gun31.byteOffset + gun31.byteLength)).readNamedTag();
    const lsize31 = readVec3(Object.values(lroot31.value.Regions.value)[0].value.Size.value);
    assert(lsize31[0] === 100 && lsize31[2] === 100, "merged litematic region is 100 x 100 (got " + JSON.stringify(lsize31) + ")");

    // batch band path must agree with the single-shot layout and keep the padding empty
    const g31b = makeGenerator({ ditherId: K.DITHER_METHODS.None.id, artW: artW31, artH: artH31 });
    g31b.setup();
    const band31 = new Uint8ClampedArray(130 * 130 * 4);
    for (let y = 0; y < H31; y++) {
      band31.set(src31.subarray(y * W31 * 4, (y + 1) * W31 * 4), y * 130 * 4);
    }
    await g31b.processImageBand({ data: band31, width: 130 }, 0, 1, null, null, { processOffset: 0, processWidth: 128, globalXOffset: 0 });
    const bandLayout31 = g31b.cropColoursLayout(g31b.extractColoursLayoutsBand(band31, 130, 1, 0)[0], artW31, artH31);
    let diff31 = 0;
    for (let x = 0; x < artW31; x++) {
      for (let z = 0; z < artH31; z++) {
        const a = layouts31[0][0].coloursLayout[x][z];
        const b = bandLayout31[x][z];
        if (a.colourSetId !== b.colourSetId || a.tone !== b.tone) diff31++;
      }
    }
    assert(diff31 === 0, "block-size band layout == single-shot layout (diff=" + diff31 + ")");

    // 200x140 artwork on a 256x256 canvas: edge cells are cropped, merged size is exact
    const W32 = 256, H32 = 256, artW32 = 200, artH32 = 140;
    const src32 = new Uint8ClampedArray(W32 * H32 * 4);
    for (let y = 0; y < artH32; y++) {
      for (let x = 0; x < artW32; x++) {
        const i = (y * W32 + x) * 4;
        src32[i] = (x * 5) % 256;
        src32[i + 1] = (y * 11) % 256;
        src32[i + 2] = (x + y) % 256;
        src32[i + 3] = 255;
      }
    }
    const g32 = makeGenerator({ ditherId: K.DITHER_METHODS.None.id, artW: artW32, artH: artH32 });
    g32.setup();
    await g32.processImageData({ data: src32, width: W32 }, 2, 2);
    const layouts32 = g32.cropColoursLayouts(g32.extractColoursLayouts(src32, 2, 2), artW32, artH32);
    const cellDims32 = layouts32.map((row) => row.map((c) => c.coloursLayout.length + "x" + c.coloursLayout[0].length));
    assert(JSON.stringify(cellDims32) === JSON.stringify([["128x128", "72x128"], ["128x12", "72x12"]]), "edge cells cropped to 128x128/72x128/128x12/72x12 (got " + JSON.stringify(cellDims32) + ")");
    const merged32 = g32.buildMergedPhysicalLayout(layouts32);
    assert(merged32.size[0] === 200 && merged32.size[2] === 140, "multi-cell merged size is 200 x 140 (got " + JSON.stringify(merged32.size) + ")");
    assert(merged32.blocks.length === 200 * 140, "multi-cell merged block count 28000 (got " + merged32.blocks.length + ")");
    const mroot32 = new NBTReader((() => { const b = g32.buildSchematicNbtMerged(layouts32); return b.buffer ? b.buffer : b; })()).readNamedTag();
    const msize32 = mroot32.value.size.value.value;
    assert(msize32[0] === 200 && msize32[2] === 140, "multi-cell merged NBT size is 200 x 140 (got " + JSON.stringify(msize32) + ")");
  }

  console.log("=== Test 32: error-diffusion strength ===");
  {
    const img32 = makeTestImage(1, 1, (x, y, w, h) => [Math.floor((x / w) * 255), Math.floor((y / h) * 255), (x + y) % 256]);

    // strength 0 must behave exactly like "no dithering"
    const gNone32 = makeGenerator({ ditherId: K.DITHER_METHODS.None.id });
    gNone32.setup();
    const dNone32 = new Uint8ClampedArray(img32.data);
    await gNone32.processImageData({ data: dNone32, width: 128 }, 1, 1);

    const gZero32 = makeGenerator({ ditherId: K.DITHER_METHODS.FloydSteinberg.id, diffusionStrength: 0 });
    gZero32.setup();
    const dZero32 = new Uint8ClampedArray(img32.data);
    await gZero32.processImageData({ data: dZero32, width: 128 }, 1, 1);
    let diffZero32 = 0;
    for (let i = 0; i < dNone32.length; i++) if (dNone32[i] !== dZero32[i]) diffZero32++;
    assert(diffZero32 === 0, "strength 0 == no dithering (diff bytes=" + diffZero32 + ")");

    const run32 = async (overrides) => {
      const g = makeGenerator(Object.assign({ ditherId: K.DITHER_METHODS.FloydSteinberg.id }, overrides));
      g.setup();
      const d = new Uint8ClampedArray(img32.data);
      await g.processImageData({ data: d, width: 128 }, 1, 1);
      return d;
    };
    const dFull32 = await run32({ diffusionStrength: 100 });
    const dDefault32 = await run32({});
    let diffDefault32 = 0;
    for (let i = 0; i < dFull32.length; i++) if (dFull32[i] !== dDefault32[i]) diffDefault32++;
    assert(diffDefault32 === 0, "default strength is 100% (diff bytes=" + diffDefault32 + ")");

    const dHalf32 = await run32({ diffusionStrength: 50 });
    let diffHalf32 = 0;
    for (let i = 0; i < dFull32.length; i++) if (dFull32[i] !== dHalf32[i]) diffHalf32++;
    assert(diffHalf32 > 0, "strength 50% differs from 100% (diff bytes=" + diffHalf32 + ")");

    const dStrong32 = await run32({ diffusionStrength: 150 });
    let diffStrong32 = 0;
    for (let i = 0; i < dFull32.length; i++) if (dFull32[i] !== dStrong32[i]) diffStrong32++;
    assert(diffStrong32 > 0, "strength 150% differs from 100% (diff bytes=" + diffStrong32 + ")");

    // all strengths still produce valid palette colours
    let invalid32 = 0;
    for (const d of [dHalf32, dStrong32]) {
      for (let y = 0; y < 128; y++) {
        for (let x = 0; x < 128; x++) {
          const i = (y * 128 + x) * 4;
          const cs = gZero32.exactRGBToColourSetIdAndTone([d[i], d[i + 1], d[i + 2]]);
          if (!cs || cs.colourSetId === "-1") invalid32++;
        }
      }
    }
    assert(invalid32 === 0, "custom strengths output valid palette colours (invalid=" + invalid32 + ")");
  }

  console.log("=== Test 33: obsidian preset (text mode default) ===");
  {
    const preset = K.BLOCK_PRESETS.find((p) => p.id === "obsidian");
    assert(
      preset && preset.blocks.length === 1 && preset.blocks[0][0] === 28 && preset.blocks[0][1] === 7,
      "obsidian preset exists (csId 28, block 7)"
    );
    const cryingPreset = K.BLOCK_PRESETS.find((p) => p.id === "cryingObsidian");
    assert(
      cryingPreset && cryingPreset.blocks.length === 1 && cryingPreset.blocks[0][0] === 28 && cryingPreset.blocks[0][1] === 8,
      "crying obsidian preset exists (csId 28, block 8)"
    );
    const sel = {};
    for (const k of Object.keys(C)) sel[k] = "-1";
    sel[28] = "7";
    const g = makeGenerator({ selectedBlocks: sel, ditherId: K.DITHER_METHODS.None.id, staircaseId: K.STAIRCASING.CLASSIC.id });
    g.setup();
    const img = makeTestImage(1, 1, (x) => (x < 64 ? [255, 255, 255] : [0, 0, 0]));
    await g.processImageData({ data: img.data }, 1, 1);
    const layouts = g.extractColoursLayouts(img.data, 1, 1);
    const nbt = g.buildSchematicNbt(layouts[0][0].coloursLayout);
    const root = new NBTReader(nbt.buffer ? nbt.buffer : nbt).readNamedTag();
    const names = root.value.palette.value.value.map((p) => p.Name.value);
    assert(names.length === 1 && names[0] === "minecraft:obsidian", "obsidian-only NBT palette (got " + JSON.stringify(names) + ")");
    let other = 0;
    for (let x = 0; x < 128; x++) {
      for (let z = 0; z < 128; z++) {
        const p = layouts[0][0].coloursLayout[x][z];
        if (p.colourSetId !== "-1" && p.colourSetId !== "28") other++;
      }
    }
    assert(other === 0, "all pixels map to colour set 28 (others=" + other + ")");
    // the crying obsidian block variant produces the same map colour set
    sel[28] = "8";
    const g2 = makeGenerator({ selectedBlocks: sel, ditherId: K.DITHER_METHODS.None.id });
    g2.setup();
    const img2 = makeTestImage(1, 1, () => [255, 255, 255]);
    await g2.processImageData({ data: img2.data }, 1, 1);
    const nbt2 = g2.buildSchematicNbt(g2.extractColoursLayouts(img2.data, 1, 1)[0][0].coloursLayout);
    const root2 = new NBTReader(nbt2.buffer ? nbt2.buffer : nbt2).readNamedTag();
    const names2 = root2.value.palette.value.value.map((p) => p.Name.value);
    assert(names2.length === 1 && names2[0] === "minecraft:crying_obsidian", "crying obsidian variant works (got " + JSON.stringify(names2) + ")");
  }

})().catch((e) => {
  console.error("Test harness error:", e);
  process.exit(1);
});
