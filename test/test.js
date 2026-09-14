/* Test harness for the map art generator: validates NBT / litematic / map.dat output. */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
global.window = {};
require(path.join(ROOT, "data", "colours.js"));
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
})().catch((e) => {
  console.error("Test harness error:", e);
  process.exit(1);
});
