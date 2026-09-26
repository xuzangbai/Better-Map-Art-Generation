"use strict";

/* Core map art generation engine.
   Ported from mapartcraft (GPL-3.0) workers mapCanvas.jsworker / nbt.jsworker:
   https://github.com/rebane2001/mapartcraft
   Extended with:
   - optional noobline (aligning) row, off by default ("only the painting part")
   - litematic (Litematica mod) output, format verified against maruohon/litematica source
   - modern Minecraft versions (1.20.5+), DataVersions verified from Mojang client jars */

const NBTWriterCtor =
  typeof module !== "undefined" && module.require ? module.require("./nbt.js").NBTWriter : NBTWriter;

function gzipBytes(data) {
  if (typeof window !== "undefined" && window.pako) return window.pako.gzip(data);
  if (typeof module !== "undefined" && module.require) {
    return new Uint8Array(module.require("zlib").gzipSync(Buffer.from(data)));
  }
  throw new Error("pako (gzip) not available");
}

function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/* writes a packed palette index into a big-endian NBT long array (tight LSB-first packing,
   matching litematica's TightLongBackedIntArray) */
function writePackedEntry(longsView, bits, index, value) {
  const startOffset = index * bits;
  const startArr = Math.floor(startOffset / 64);
  const bitOffset = startOffset % 64;
  value &= (1 << bits) - 1;
  const loWord = startArr * 8 + 4; // big-endian: lo word is the LAST 4 bytes of the long
  const hiWord = startArr * 8; // big-endian: hi word is the FIRST 4 bytes of the long
  if (bitOffset + bits <= 64) {
    if (bitOffset + bits <= 32) {
      let w = longsView.getUint32(loWord, false);
      w = (w & ~(((1 << bits) - 1) << bitOffset)) >>> 0;
      w = (w | (value << bitOffset)) >>> 0;
      longsView.setUint32(loWord, w, false);
    } else if (bitOffset >= 32) {
      const wb = bitOffset - 32;
      let w = longsView.getUint32(hiWord, false);
      w = (w & ~(((1 << bits) - 1) << wb)) >>> 0;
      w = (w | (value << wb)) >>> 0;
      longsView.setUint32(hiWord, w, false);
    } else {
      const firstBits = 32 - bitOffset;
      const rest = bits - firstBits;
      let lo = longsView.getUint32(loWord, false);
      let hi = longsView.getUint32(hiWord, false);
      lo = (lo & ~(((1 << firstBits) - 1) << bitOffset)) >>> 0;
      lo = (lo | ((value & ((1 << firstBits) - 1)) << bitOffset)) >>> 0;
      hi = (hi & ~((1 << rest) - 1)) >>> 0;
      hi = (hi | (value >>> firstBits)) >>> 0;
      longsView.setUint32(loWord, lo, false);
      longsView.setUint32(hiWord, hi, false);
    }
  } else {
    const firstBits = 64 - bitOffset;
    const rest = bits - firstBits;
    const wb = bitOffset - 32;
    let hi = longsView.getUint32(hiWord, false);
    hi = (hi & ~(((1 << firstBits) - 1) << wb)) >>> 0;
    hi = (hi | ((value & ((1 << firstBits) - 1)) << wb)) >>> 0;
    longsView.setUint32(hiWord, hi, false);
    let nlo = longsView.getUint32((startArr + 1) * 8 + 4, false);
    nlo = (nlo & ~((1 << rest) - 1)) >>> 0;
    nlo = (nlo | (value >>> firstBits)) >>> 0;
    longsView.setUint32((startArr + 1) * 8 + 4, nlo, false);
  }
}

/* CIEDE2000 colour difference (Sharma et al. implementation notes).
   lab1/lab2: standard CIELAB [L, a, b]. Returns delta-E (roughly 0..100). */
function deltaE2000(lab1, lab2) {
  const L1 = lab1[0];
  const a1 = lab1[1];
  const b1 = lab1[2];
  const L2 = lab2[0];
  const a2 = lab2[1];
  const b2 = lab2[2];
  const C1 = Math.sqrt(a1 * a1 + b1 * b1);
  const C2 = Math.sqrt(a2 * a2 + b2 * b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 6103515625)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.sqrt(a1p * a1p + b1 * b1);
  const C2p = Math.sqrt(a2p * a2p + b2 * b2);
  const h1p = C1p === 0 ? 0 : (Math.atan2(b1, a1p) * 180) / Math.PI;
  const h2p = C2p === 0 ? 0 : (Math.atan2(b2, a2p) * 180) / Math.PI;
  const h1pPos = h1p < 0 ? h1p + 360 : h1p;
  const h2pPos = h2p < 0 ? h2p + 360 : h2p;
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2pPos - h1pPos;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * (Math.PI / 180));
  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp;
  if (C1p * C2p === 0) {
    hbarp = h1pPos + h2pPos;
  } else {
    const diff = Math.abs(h1pPos - h2pPos);
    const sum = h1pPos + h2pPos;
    if (diff <= 180) hbarp = sum / 2;
    else if (sum < 360) hbarp = (sum + 360) / 2;
    else hbarp = (sum - 360) / 2;
  }
  const T =
    1 -
    0.17 * Math.cos(((hbarp - 30) * Math.PI) / 180) +
    0.24 * Math.cos(((2 * hbarp) * Math.PI) / 180) +
    0.32 * Math.cos(((3 * hbarp + 6) * Math.PI) / 180) -
    0.2 * Math.cos(((4 * hbarp - 63) * Math.PI) / 180);
  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + 6103515625));
  const L50sq = Math.pow(Lbarp - 50, 2);
  const SL = 1 + (0.015 * L50sq) / Math.sqrt(20 + L50sq);
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(((2 * dTheta) * Math.PI) / 180) * RC;
  const dL = dLp / SL;
  const dC = dCp / SC;
  const dH = dHp / SH;
  return Math.sqrt(dL * dL + dC * dC + dH * dH + RT * dC * dH);
}

/* d -> (x, y) on a Hilbert curve of order n (n a power of two) */
function hilbertD2XY(n, d) {
  let rx;
  let ry;
  let t = d;
  let x = 0;
  let y = 0;
  for (let s = 1; s < n; s *= 2) {
    rx = 1 & (t >> 1);
    ry = 1 & (t ^ rx);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const tmp = x;
      x = y;
      y = tmp;
    }
    x += s * rx;
    y += s * ry;
    t >>= 2;
  }
  return [x, y];
}

class MapGenerator {
  constructor(coloursJSON, opts) {
    this.coloursJSON = coloursJSON;
    this.mcVersion = opts.mcVersion; // e.g. "1.21.11"
    this.staircaseId = opts.staircaseId; // 0..4, see STAIRCASING
    this.supportModeId = opts.supportModeId; // 0..3, see SUPPORT_MODES
    this.supportBlock = opts.supportBlock || "cobblestone";
    this.includeNoobline = !!opts.includeNoobline;
    this.betterColour = !!opts.betterColour;
    this.ditherId = opts.ditherId;
    this.selectedBlocks = opts.selectedBlocks; // {colourSetId: blockId}
    this.transparency = !!opts.transparency;
    this.transparencyTolerance = opts.transparencyTolerance || 128;
    this.mapdatUnobtainable = !!opts.mapdatUnobtainable;
    this.wallMode = !!opts.wallMode; // vertical wall pixel art (image rows -> Y, 1 block thick)
    this.serpentine = !!opts.serpentine; // alternate scan direction for error diffusion
    // error-diffusion strength in percent (0..200; 100 = standard, 0 = no error propagation)
    this.diffusionStrength = opts.diffusionStrength === undefined ? 100 : opts.diffusionStrength;
    this.diffusionScale = this.diffusionStrength / 100;
    // block-size mode: the artwork only covers the top-left artW x artH region of the
    // (128-aligned) canvas; everything outside stays empty (0 = no limit)
    this.artW = opts.artW || 0;
    this.artH = opts.artH || 0;
    // colour difference metric: "rgb" | "lab" | "ciede2000" (betterColour kept for compatibility)
    this.colourMetric = opts.colourMetric || (opts.betterColour === false ? "rgb" : "lab");
    this.isolatedCleanup = !!opts.isolatedCleanup;
    this.isolatedPasses = opts.isolatedPasses || 1;
    this.gpuAccel = !!opts.gpuAccel; // WebGL2 colour lookup table for nearest-colour search
    this.lut = null;
    this.lutPalette = null;

    this.colourSetsToUse = [];
    this.exactColourCache = new Map();
    this.colourCache = new Map();
    this.labCache = new Map();
    this.labStdCache = new Map();
    this.dither = null;
  }

  /* ----- colour matching (port of mapartcraft) ----- */

  rgb2lab(rgb) {
    const val = (rgb[0] << 16) + (rgb[1] << 8) + rgb[2];
    if (this.labCache.has(val)) return this.labCache.get(val);
    let r1 = rgb[0] / 255.0;
    let g1 = rgb[1] / 255.0;
    let b1 = rgb[2] / 255.0;
    r1 = 0.04045 >= r1 ? (r1 /= 12.0) : Math.pow((r1 + 0.055) / 1.055, 2.4);
    g1 = 0.04045 >= g1 ? (g1 /= 12.0) : Math.pow((g1 + 0.055) / 1.055, 2.4);
    b1 = 0.04045 >= b1 ? (b1 /= 12.0) : Math.pow((b1 + 0.055) / 1.055, 2.4);
    const f = (0.43605202 * r1 + 0.3850816 * g1 + 0.14308742 * b1) / 0.964221;
    const h = 0.22249159 * r1 + 0.71688604 * g1 + 0.060621485 * b1;
    const k = (0.013929122 * r1 + 0.097097 * g1 + 0.7141855 * b1) / 0.825211;
    const l = 0.008856452 < h ? Math.pow(h, 1 / 3) : (903.2963 * h + 16.0) / 116.0;
    const m = 500.0 * ((0.008856452 < f ? Math.pow(f, 1 / 3) : (903.2963 * f + 16.0) / 116.0) - l);
    const n = 200.0 * (l - (0.008856452 < k ? Math.pow(k, 1 / 3) : (903.2963 * k + 16.0) / 116.0));
    const out = [2.55 * (116.0 * l - 16.0) + 0.5, m + 0.5, n + 0.5];
    this.labCache.set(val, out);
    return out;
  }

  squaredEuclideanMetricColours(pixel1, pixel2) {
    if (this.colourMetric === "ciede2000") {
      const dE = deltaE2000(this.rgb2labStd(pixel1), this.rgb2labStd(pixel2));
      return dE * dE;
    }
    if (this.colourMetric === "lab") {
      pixel1 = this.rgb2lab(pixel1);
      pixel2 = this.rgb2lab(pixel2);
    }
    const r = pixel1[0] - pixel2[0];
    const g = pixel1[1] - pixel2[1];
    const b = pixel1[2] - pixel2[2];
    return r * r + g * g + b * b;
  }

  /* standard CIELAB (D65), used by CIEDE2000 */
  rgb2labStd(rgb) {
    const key = (rgb[0] << 16) + (rgb[1] << 8) + rgb[2];
    if (this.labStdCache.has(key)) return this.labStdCache.get(key);
    let r = rgb[0] / 255.0;
    let g = rgb[1] / 255.0;
    let b = rgb[2] / 255.0;
    r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
    g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
    b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;
    const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
    const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
    const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
    const fx = x > 0.008856 ? Math.cbrt(x) : 7.787 * x + 16 / 116;
    const fy = y > 0.008856 ? Math.cbrt(y) : 7.787 * y + 16 / 116;
    const fz = z > 0.008856 ? Math.cbrt(z) : 7.787 * z + 16 / 116;
    const out = [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
    this.labStdCache.set(key, out);
    return out;
  }

  colourSetIdAndToneToRGB(colourSetId, tone) {
    return this.coloursJSON[colourSetId].tonesRGB[tone];
  }

  findClosestColourSetIdAndToneTo(pixelRGB) {
    if (this.lut) {
      return this.lutPalette[this.lut.nearest[(pixelRGB[0] << 16) | (pixelRGB[1] << 8) | pixelRGB[2]]];
    }
    const RGBBinary = (pixelRGB[0] << 16) + (pixelRGB[1] << 8) + pixelRGB[2];
    if (this.colourCache.has(RGBBinary)) return this.colourCache.get(RGBBinary);
    let shortestDistance = 9999999;
    let closestPixel = null;
    this.colourSetsToUse.forEach((colourSet) => {
      Object.keys(colourSet.tonesRGB).forEach((toneKey) => {
        const toneRGB = colourSet.tonesRGB[toneKey];
        const squareDistance = this.squaredEuclideanMetricColours(toneRGB, pixelRGB);
        if (squareDistance < shortestDistance) {
          shortestDistance = squareDistance;
          closestPixel = { colourSetId: colourSet.colourSetId, tone: toneKey };
        }
      });
    });
    this.colourCache.set(RGBBinary, closestPixel);
    return closestPixel;
  }

  findClosest2ColourSetIdAndToneTo(pixelRGB) {
    if (this.lut) {
      const idx = (pixelRGB[0] << 16) | (pixelRGB[1] << 8) | pixelRGB[2];
      let closestPixel1 = this.lutPalette[this.lut.nearest[idx]];
      let closestPixel2 = this.lutPalette[this.lut.second[idx]];
      let shortestDistance1 = this.squaredEuclideanMetricColours(closestPixel1.rgb, pixelRGB);
      let shortestDistance2 = this.squaredEuclideanMetricColours(closestPixel2.rgb, pixelRGB);
      if (
        this.squaredEuclideanMetricColours(closestPixel1.rgb, closestPixel2.rgb) <= shortestDistance2
      ) {
        closestPixel2 = closestPixel1;
      }
      return [shortestDistance1, shortestDistance2, closestPixel1, closestPixel2];
    }
    const RGBBinary = (pixelRGB[0] << 16) + (pixelRGB[1] << 8) + pixelRGB[2];
    if (this.colourCache.has(RGBBinary)) return this.colourCache.get(RGBBinary);
    let shortestDistance1 = 9999999;
    let shortestDistance2 = 9999999;
    let closestPixel1 = { colourSetId: null, tone: null };
    let closestPixel2 = { colourSetId: null, tone: null };
    this.colourSetsToUse.forEach((colourSet) => {
      Object.keys(colourSet.tonesRGB).forEach((toneKey) => {
        const toneRGB = colourSet.tonesRGB[toneKey];
        const squareDistance = this.squaredEuclideanMetricColours(toneRGB, pixelRGB);
        if (squareDistance < shortestDistance1) {
          shortestDistance1 = squareDistance;
          closestPixel1 = { colourSetId: colourSet.colourSetId, tone: toneKey };
        }
        if (squareDistance < shortestDistance2 && this.colourSetIdAndToneToRGB(closestPixel1.colourSetId, closestPixel1.tone) !== toneRGB) {
          shortestDistance2 = squareDistance;
          closestPixel2 = { colourSetId: colourSet.colourSetId, tone: toneKey };
        }
      });
    });
    if (
      shortestDistance2 !== 9999999 &&
      this.squaredEuclideanMetricColours(
        this.colourSetIdAndToneToRGB(closestPixel1.colourSetId, closestPixel1.tone),
        this.colourSetIdAndToneToRGB(closestPixel2.colourSetId, closestPixel2.tone)
      ) <= shortestDistance2
    ) {
      closestPixel2 = closestPixel1;
    }
    const newPixels = [shortestDistance1, shortestDistance2, closestPixel1, closestPixel2];
    this.colourCache.set(RGBBinary, newPixels);
    return newPixels;
  }

  setup() {
    this.colourSetsToUse = [];
    this.colourCache.clear();
    this.labCache.clear();
    this.labStdCache.clear();
    this.exactColourCache.clear();

    const toneKeys = this.getToneKeys();
    const selected = this.selectedBlocks;
    for (const key of Object.keys(selected)) {
      if (selected[key] !== "-1" && selected[key] !== undefined && selected[key] !== null) {
        if (!this.coloursJSON[key]) continue;
        const tonesRGB = {};
        for (const toneKey of toneKeys) tonesRGB[toneKey] = this.coloursJSON[key].tonesRGB[toneKey];
        this.colourSetsToUse.push({ colourSetId: key, tonesRGB });
      }
    }

    // exact RGB -> colourSetId/tone cache (includes the transparent special case for map.dat)
    for (const [colourSetId, colourSet] of Object.entries(this.coloursJSON)) {
      for (const [toneKey, toneRGB] of Object.entries(colourSet.tonesRGB)) {
        this.exactColourCache.set((toneRGB[0] << 16) + (toneRGB[1] << 8) + toneRGB[2], { colourSetId, tone: toneKey });
      }
    }
    this.exactColourCache.set(0, { colourSetId: "-1", tone: "normal" });

    const chosenDitherMethod = window.MapArtConstants.DITHER_METHODS[Object.keys(window.MapArtConstants.DITHER_METHODS).find((k) => window.MapArtConstants.DITHER_METHODS[k].id === this.ditherId)];
    if (chosenDitherMethod && chosenDitherMethod.ditherMatrix) this.dither = chosenDitherMethod;

    // blue noise mask (lazily decoded from data/bluenoise.js)
    this.blueNoise = window.MapArtConstants.getBlueNoiseMask();

    // flattened palette for Yliluoma's ordered dithering
    this.yliluomaPalette = [];
    for (const cs of this.colourSetsToUse) {
      for (const tone of Object.keys(cs.tonesRGB)) {
        this.yliluomaPalette.push({ colourSetId: cs.colourSetId, tone, rgb: cs.tonesRGB[tone] });
      }
    }
    this.yliluomaCache = new Map();
    // flat palette list is also used by the GPU lookup table
    this.lutPalette = this.yliluomaPalette;
    this.lut = null;
  }

  /* build (or reuse) the GPU colour lookup table; falls back to CPU search when unavailable */
  async ensureLut(onProgress) {
    this.lut = null;
    if (!this.gpuAccel) return;
    if (typeof window === "undefined" || !window.GLLut || !window.GLLut.isSupported()) return;
    const palette = this.lutPalette;
    if (!palette || palette.length === 0 || palette.length > 255) return;
    const key = this.colourMetric + "|" + palette.map((p) => p.rgb.join(",")).join(";");
    const cached = window.GLLut.getCached(key);
    if (cached) {
      this.lut = cached;
      if (onProgress) onProgress(1);
      return;
    }
    try {
      const lut = await window.GLLut.build(palette, this.colourMetric, onProgress);
      window.GLLut.setCached(key, lut);
      this.lut = lut;
    } catch (e) {
      console.warn("GPU LUT unavailable, falling back to CPU:", e);
      this.lut = null;
    }
  }

  getToneKeys() {
    if (this.wallMode) return ["normal"]; // a 1-block-thick wall uses only the normal shade
    const s = window.MapArtConstants.STAIRCASING;
    switch (this.staircaseId) {
      case s.OFF.id: return ["normal"];
      case s.CLASSIC.id: case s.VALLEY.id: {
        const keys = ["dark", "normal", "light"];
        if (this.mapdatUnobtainable) keys.push("unobtainable");
        return keys;
      }
      case s.FULL_DARK.id: return ["dark"];
      case s.FULL_LIGHT.id: return ["light"];
      default: return ["normal"];
    }
  }

  isSupportBlockMandatory(colourSetIdAndTone) {
    const blockId = this.selectedBlocks[colourSetIdAndTone.colourSetId];
    if (blockId === undefined || blockId === null || blockId === "-1") return false;
    const block = this.coloursJSON[colourSetIdAndTone.colourSetId].blocks[blockId];
    return block ? !!block.supportBlockMandatory : false;
  }

  exactRGBToColourSetIdAndTone(pixelRGB) {
    return this.exactColourCache.get((pixelRGB[0] << 16) + (pixelRGB[1] << 8) + pixelRGB[2]);
  }

  /* ----- step 1: quantize pixels (dithering) ----- */

  // processes `imageData` (RGBA, width = mapsX*128, height = mapsY*128) in place, chunked so the UI stays responsive.
  // returns { maps: mapsY x mapsX of {materials:{colourSetId:count}} }
  async processImageData(imageData, mapsX, mapsY, onProgress) {
    const data = imageData.data;
    const multimapWidth = imageData.width || mapsX * 128;
    const totalRows = Math.floor(data.length / 4 / multimapWidth);
    const maps = [];
    for (let my = 0; my < mapsY; my++) {
      const row = [];
      for (let mx = 0; mx < mapsX; mx++) {
        const materials = {};
        for (const cs of this.colourSetsToUse) materials[cs.colourSetId] = 0;
        row.push({ materials });
      }
      maps.push(row);
    }

    if (this.colourSetsToUse.length === 0) return { maps };

    // GPU colour lookup table (exact nearest-colour results, huge speedup)
    await this.ensureLut(onProgress ? (p) => onProgress(p * 0.3) : null);
    const progressScale = this.lut ? 0.3 : 0;
    const report = onProgress ? (p) => onProgress(progressScale + (1 - progressScale) * p) : null;

    const ditherId = this.ditherId;
    const D = window.MapArtConstants.DITHER_METHODS;
    const errorDiffusionIds = window.MapArtConstants.ERROR_DIFFUSION_IDS;

    // Riemersma walks the image along a Hilbert curve, so it needs its own pass
    if (ditherId === D.Riemersma.id) {
      return this.processRiemersma(data, maps, multimapWidth, totalRows, onProgress);
    }

    const ditherMatrix = this.dither ? this.dither.ditherMatrix : null;
    const divisor = this.dither ? this.dither.ditherDivisor : null;
    const serpentine = this.serpentine && errorDiffusionIds.includes(ditherId);
    const yieldEvery = Math.max(1, Math.floor(totalRows / 250)); // ~250 UI yields total

    const dctx = { ditherId, D, errorDiffusionIds, serpentine, ditherMatrix, divisor, width: multimapWidth };
    for (let rowY = 0; rowY < totalRows; rowY++) {
      const rowStart = rowY * multimapWidth * 4;
      const rowEnd = rowStart + multimapWidth * 4;

      const dir = serpentine && rowY % 2 === 1 ? -1 : 1;
      for (let i = dir === 1 ? rowStart : rowEnd - 4; dir === 1 ? i < rowEnd : i >= rowStart; i += 4 * dir) {
        const multimap_x = (i / 4) % multimapWidth;
        const whichMap_x = Math.floor(multimap_x / 128);
        const whichMap_y = Math.floor(rowY / 128);
        const closestColourSetIdAndTone = this.ditherPixel(data, i, multimap_x, rowY, dctx);
        if (closestColourSetIdAndTone) {
          maps[whichMap_y][whichMap_x].materials[closestColourSetIdAndTone.colourSetId] += 1;
        }
      }

      if (onProgress && (rowY + 1) % yieldEvery === 0) {
        report((rowY + 1) / totalRows);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    if (this.isolatedCleanup) {
      this.suppressIsolatedPixels(data, multimapWidth, totalRows);
      this.recountMaterials(data, maps, multimapWidth, totalRows);
    }
    if (onProgress) onProgress(1);
    return { maps };
  }

  /* quantize a single pixel (shared by full-image and band/batch processing).
     Writes the quantized colour (and any diffusion error) into `data`;
     returns {colourSetId, tone} or null when the pixel is transparent. */
  ditherPixel(data, i, x, yGlobal, ctx) {
    const { ditherId, D, errorDiffusionIds, serpentine, ditherMatrix, divisor, width } = ctx;
    const xGlobal = x + (ctx.xGlobalOffset || 0);
    if (this.artW > 0 && (xGlobal >= this.artW || yGlobal >= this.artH)) {
      // outside the artwork (block-size mode padding): keep it empty
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 0;
      return null;
    }
    if (this.transparency && data[i + 3] < this.transparencyTolerance) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 0;
      return null;
    }
    data[i + 3] = 255;
    const oldPixel = [data[i], data[i + 1], data[i + 2]];
    let closestColourSetIdAndTone;
    if (ditherId === D.None.id) {
      closestColourSetIdAndTone = this.findClosestColourSetIdAndToneTo(oldPixel);
      const c = this.colourSetIdAndToneToRGB(closestColourSetIdAndTone.colourSetId, closestColourSetIdAndTone.tone);
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
    } else if (this.isOrderedDitherId(ditherId)) {
      const newPixels = this.findClosest2ColourSetIdAndToneTo(oldPixel);
      const levelsPlus1 = this.ditherLevelsFor(ditherId) + 1;
      const threshold = this.ditherThresholdAt(ditherId, xGlobal, yGlobal);
      if ((newPixels[0] * levelsPlus1) / newPixels[1] > threshold) {
        closestColourSetIdAndTone = newPixels[3];
      } else {
        closestColourSetIdAndTone = newPixels[2];
      }
      const c = this.colourSetIdAndToneToRGB(closestColourSetIdAndTone.colourSetId, closestColourSetIdAndTone.tone);
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
    } else if (ditherId === D.Yliluoma.id || ditherId === D.BlueNoiseYliluoma.id) {
      closestColourSetIdAndTone = this.yliluomaChoose(oldPixel, xGlobal, yGlobal, ditherId === D.BlueNoiseYliluoma.id);
      const c = this.colourSetIdAndToneToRGB(closestColourSetIdAndTone.colourSetId, closestColourSetIdAndTone.tone);
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
    } else if (errorDiffusionIds.includes(ditherId)) {
      closestColourSetIdAndTone = this.findClosestColourSetIdAndToneTo(oldPixel);
      const c = this.colourSetIdAndToneToRGB(closestColourSetIdAndTone.colourSetId, closestColourSetIdAndTone.tone);
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
      const es = this.diffusionScale;
      const quant_error = [(oldPixel[0] - c[0]) * es, (oldPixel[1] - c[1]) * es, (oldPixel[2] - c[2]) * es];
      const m = ditherMatrix;
      const dv = divisor;
      const dir = serpentine && yGlobal % 2 === 1 ? -1 : 1;
      const inX = (sdx) => {
        const nx = x + sdx * dir;
        return nx >= 0 && nx < width;
      };
      const addError = (sdx, dy, weight) => {
        const off = i + sdx * dir * 4 + dy * width * 4;
        data[off] += quant_error[0] * weight;
        data[off + 1] += quant_error[1] * weight;
        data[off + 2] += quant_error[2] * weight;
      };
      try {
        if (inX(1)) {
          addError(1, 0, m[0][3] / dv);
          if (inX(2)) addError(2, 0, m[0][4] / dv);
        }
        if (inX(-1)) {
          addError(-1, 1, m[1][1] / dv);
          if (inX(-2)) addError(-2, 1, m[1][0] / dv);
        }
        addError(0, 1, m[1][2] / dv);
        if (inX(1)) {
          addError(1, 1, m[1][3] / dv);
          if (inX(2)) addError(2, 1, m[1][4] / dv);
        }
        if (inX(-1)) {
          addError(-1, 2, m[2][1] / dv);
          if (inX(-2)) addError(-2, 2, m[2][0] / dv);
        }
        addError(0, 2, m[2][2] / dv);
        if (inX(1)) {
          addError(1, 2, m[2][3] / dv);
          if (inX(2)) addError(2, 2, m[2][4] / dv);
        }
      } catch (e) {
        console.error(e);
      }
    } else {
      // unknown method: nearest colour
      closestColourSetIdAndTone = this.findClosestColourSetIdAndToneTo(oldPixel);
      const c = this.colourSetIdAndToneToRGB(closestColourSetIdAndTone.colourSetId, closestColourSetIdAndTone.tone);
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
    }
    return closestColourSetIdAndTone;
  }

  /* ----- batch (band) processing for very large images ----- */

  // processes one map row (128 pixel rows) from a band buffer that has 2 extra carry rows at the bottom.
  // imageData: RGBA band buffer
  // opts: { processOffset, processWidth, globalXOffset, snapshot: { start, cols, target } }
  // carry: { rows: [Uint8ClampedArray, Uint8ClampedArray] } from the previous band (error diffusion only)
  // returns { maps: [mapsX entries], carry } for the next band
  async processImageBand(imageData, mapRowIndex, mapsX, carry, onProgress, opts) {
    const data = imageData.data;
    const width = imageData.width || mapsX * 128;
    const processOffset = (opts && opts.processOffset) || 0;
    const processWidth = (opts && opts.processWidth) || width - processOffset;
    const globalXOffset = (opts && opts.globalXOffset) || 0;
    const snapshot = (opts && opts.snapshot) || null;
    const D = window.MapArtConstants.DITHER_METHODS;
    if (this.ditherId === D.Riemersma.id) {
      throw new Error("分批计算模式不支持 Riemersma 算法，请改用其他抖动算法");
    }

    const mapsRow = [];
    for (let mx = 0; mx < mapsX; mx++) {
      const materials = {};
      for (const cs of this.colourSetsToUse) materials[cs.colourSetId] = 0;
      mapsRow.push({ materials });
    }

    // apply the error-diffusion carry-over from the previous band
    if (carry && carry.rows && this.isErrorDiffusionDither()) {
      for (let r = 0; r < carry.rows.length && r < 2; r++) {
        const rowData = carry.rows[r];
        if (!rowData) continue;
        data.set(rowData, r * width * 4);
      }
    }

    const errorDiffusionIds = window.MapArtConstants.ERROR_DIFFUSION_IDS;
    const ditherMatrix = this.dither ? this.dither.ditherMatrix : null;
    const divisor = this.dither ? this.dither.ditherDivisor : null;
    const serpentine = this.serpentine && errorDiffusionIds.includes(this.ditherId);
    const dctx = {
      ditherId: this.ditherId,
      D,
      errorDiffusionIds,
      serpentine,
      ditherMatrix,
      divisor,
      width,
      xGlobalOffset: globalXOffset,
    };
    const globalStartRow = mapRowIndex * 128;

    for (let row = 0; row < 128; row++) {
      const rowStart = row * width * 4;
      const rowEnd = rowStart + (processOffset + processWidth) * 4;
      const dir = serpentine && (globalStartRow + row) % 2 === 1 ? -1 : 1;
      for (let i = dir === 1 ? rowStart + processOffset * 4 : rowEnd - 4; dir === 1 ? i < rowEnd : i >= rowStart + processOffset * 4; i += 4 * dir) {
        const x = (i / 4) % width;
        const mx = Math.floor((x - processOffset) / 128);
        if (snapshot && x >= snapshot.start && x < snapshot.start + snapshot.cols) {
          // capture the pre-quantization input of the overlap columns (re-processed by the next batch)
          const targetOffset = (row * snapshot.cols + (x - snapshot.start)) * 4;
          snapshot.target[targetOffset] = data[i];
          snapshot.target[targetOffset + 1] = data[i + 1];
          snapshot.target[targetOffset + 2] = data[i + 2];
          snapshot.target[targetOffset + 3] = data[i + 3];
        }
        const closest = this.ditherPixel(data, i, x, globalStartRow + row, dctx);
        if (closest && mx >= 0 && mx < mapsRow.length) mapsRow[mx].materials[closest.colourSetId] += 1;
      }
      if (onProgress && (row + 1) % 16 === 0) {
        onProgress((row + 1) / 128);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    // carry the last two rows (they contain the diffusion error for the next band)
    let nextCarry = null;
    if (this.isErrorDiffusionDither() && data.length >= (128 + 2) * width * 4) {
      nextCarry = {
        rows: [
          new Uint8ClampedArray(data.subarray(128 * width * 4, 129 * width * 4)),
          new Uint8ClampedArray(data.subarray(129 * width * 4, 130 * width * 4)),
        ],
      };
    }
    if (onProgress) onProgress(1);
    return { maps: mapsRow, carry: nextCarry };
  }

  isErrorDiffusionDither() {
    return window.MapArtConstants.ERROR_DIFFUSION_IDS.includes(this.ditherId);
  }

  /* applies carried diffusion errors to a band buffer (batch column processing).
     colCarry holds `carryCols` columns (2 already-processed + 2 pending-error columns). */
  applyBandCarries(bandData, bufferWidth, mapRow, rowCarry, colCarry, carryCols) {
    if (!this.isErrorDiffusionDither()) return;
    const cols = carryCols || 2;
    if (rowCarry) {
      for (let r = 0; r < 2; r++) {
        if (rowCarry[r]) bandData.set(rowCarry[r], r * bufferWidth * 4);
      }
    } else if (colCarry) {
      for (let r = 0; r < 2; r++) {
        const src = (mapRow * 128 + r) * cols * 4;
        bandData.set(colCarry.subarray(src, src + cols * 4), r * bufferWidth * 4);
      }
    }
    if (colCarry) {
      for (let r = 2; r < 128; r++) {
        const src = (mapRow * 128 + r) * cols * 4;
        bandData.set(colCarry.subarray(src, src + cols * 4), r * bufferWidth * 4);
      }
    }
  }

  /* copies the carry columns (the last `overlap` output columns + 2 pending-error columns)
     of a processed band into the full-height column carry */
  storeColumnCarry(bandData, bufferWidth, mapRow, colCarry, carryCols, carryStart) {
    if (!this.isErrorDiffusionDither()) return;
    const cols = carryCols || 2;
    const startX = carryStart || 0;
    for (let r = 0; r < 128; r++) {
      const src = (r * bufferWidth + startX) * 4;
      colCarry.set(bandData.subarray(src, src + cols * 4), (mapRow * 128 + r) * cols * 4);
    }
  }

  // extracts the colour layouts of one map row from a band buffer (height = 128)
  // xOffset: pixel offset of the first map column in the band buffer
  extractColoursLayoutsBand(bandPixels, width, mapsX, xOffset) {
    const off0 = xOffset || 0;
    const layouts = [];
    for (let mx = 0; mx < mapsX; mx++) {
      const coloursLayout = [];
      for (let columnNumber = 0; columnNumber < 128; columnNumber++) {
        const column = [];
        for (let rowNumber = 0; rowNumber < 128; rowNumber++) {
          const offset = 4 * (rowNumber * width + off0 + mx * 128 + columnNumber);
          const csAndTone = this.exactRGBToColourSetIdAndTone([bandPixels[offset], bandPixels[offset + 1], bandPixels[offset + 2]]);
          column.push(csAndTone || { colourSetId: "-1", tone: "normal" });
        }
        coloursLayout.push(column);
      }
      layouts.push(coloursLayout);
    }
    return layouts;
  }

  /* ----- incremental merged litematic (batch mode, flat layout only) ----- */

  initLitematicBatch(mapsX, mapsY) {
    const K = window.MapArtConstants;
    if (this.staircaseId !== K.STAIRCASING.OFF.id) {
      throw new Error("分批计算模式下，合并 litematic 仅支持平面模式（阶梯模式文件体积过大）");
    }
    const colourSetIdsUsed = [];
    for (const cs of this.colourSetsToUse) colourSetIdsUsed.push(cs.colourSetId);
    colourSetIdsUsed.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    const palette = [{ name: "minecraft:air", args: {} }];
    const idToPaletteIndex = {};
    for (const csId of colourSetIdsUsed) {
      const { name, args } = this.blockNBTNameAndArgs(csId, this.selectedBlocks[csId]);
      palette.push({ name, args });
      idToPaletteIndex[csId] = palette.length - 1;
    }
    const hasScaffold = this.supportModeId !== K.SUPPORT_MODES.NONE.id || this.includeNoobline;
    if (hasScaffold) {
      palette.push({ name: "minecraft:" + this.supportBlock.toLowerCase(), args: {} });
      idToPaletteIndex.NOOBLINE_SCAFFOLD = palette.length - 1;
    }
    const zBase = this.includeNoobline ? 1 : 0;
    const maxY = this.supportModeId === K.SUPPORT_MODES.NONE.id ? 0 : 2;
    const sx = 128 * mapsX;
    const sy = maxY + 1;
    const sz = 128 * mapsY + zBase;
    const bits = Math.max(2, 32 - Math.clz32(palette.length - 1));
    const longs = new Uint8Array(Math.ceil((sx * sy * sz * bits) / 64) * 8);
    return { palette, idToPaletteIndex, bits, longs, sx, sy, sz, zBase, version: this.mcVersion };
  }

  // layouts: array of layouts for this map row (each [x][z] of {colourSetId, tone})
  // mapColStart: global map column index of layouts[0] (for partial-width batches)
  addLitematicBatchRow(state, layouts, mapRowIndex, mapColStart) {
    const K = window.MapArtConstants;
    const view = new DataView(state.longs.buffer);
    const zOffset = mapRowIndex * 128;
    const colStart = mapColStart || 0;
    for (let mx = 0; mx < layouts.length; mx++) {
      const layout = layouts[mx];
      for (let columnNumber = 0; columnNumber < layout.length; columnNumber++) {
        const globalX = (colStart + mx) * 128 + columnNumber;
        const physicalColumn = this.buildPhysicalColumn(globalX, layout[columnNumber]);
        for (const b of physicalColumn) {
          if (b.csId === "NOOBLINE_SCAFFOLD" && b.z === 0 && mapRowIndex > 0) continue; // noobline only exists once
          const globalZ = b.z + zOffset;
          const index = b.y * state.sx * state.sz + globalZ * state.sx + b.x;
          writePackedEntry(view, state.bits, index, state.idToPaletteIndex[b.csId]);
        }
      }
    }
  }

  finishLitematicBatch(state, baseName, author) {
    const K = window.MapArtConstants;
    const now = Date.now();
    const version = K.SUPPORTED_VERSIONS.find((v) => v.MCVersion === state.version);
    const vec3i = (v) => ({
      type: 10,
      value: {
        x: { type: 3, value: v[0] },
        y: { type: 3, value: v[1] },
        z: { type: 3, value: v[2] },
      },
    });
    const paletteTag = state.palette.map((p) => {
      const item = { Name: { type: 8, value: p.name } };
      if (p.args && Object.keys(p.args).length) {
        const props = {};
        Object.keys(p.args).forEach((k) => (props[k] = { type: 8, value: p.args[k] }));
        item.Properties = { type: 10, value: props };
      }
      return item;
    });
    const size = [state.sx, state.sy, state.sz];
    const region = {
      DataVersion: { type: 3, value: version.NBTVersion },
      BlockStatePalette: { type: 9, value: { type: 10, value: paletteTag } },
      BlockStates: { type: 12, value: state.longs },
      Position: vec3i([0, 0, 0]),
      Size: vec3i(size),
    };
    const root = {
      name: "Schematic",
      value: {
        Version: { type: 3, value: 4 },
        MinecraftDataVersion: { type: 3, value: version.NBTVersion },
        Metadata: {
          type: 10,
          value: {
            Name: { type: 8, value: baseName || "MapArt" },
            Author: { type: 8, value: author || "MapArt Generator" },
            Description: { type: 8, value: "Generated by MC Map Art Generator (batch)" },
            SchematicVersion: { type: 3, value: 4 },
            TimeCreated: { type: 4, value: longFromMs(now) },
            TimeModified: { type: 4, value: longFromMs(now) },
            EnclosingSize: vec3i(size),
            McDataVersion: { type: 3, value: version.NBTVersion },
            McVersion: { type: 8, value: state.version },
            RegionCount: { type: 3, value: 1 },
            EntityCount: { type: 3, value: 0 },
            TotalVolume: { type: 4, value: longFromMs(state.sx * state.sy * state.sz) },
            TotalBlocks: { type: 4, value: longFromMs(0) },
            BlockEntityCount: { type: 4, value: longFromMs(0) },
            BlockTickCount: { type: 4, value: longFromMs(0) },
          },
        },
        Regions: { type: 10, value: { mapart: { type: 10, value: region } } },
      },
    };
    const writer = new NBTWriterCtor();
    writer.writeTopLevelCompound(root.name, root.value);
    return gzipBytes(new Uint8Array(writer.getData()));
  }

  /* ----- new dithering algorithms ----- */

  isOrderedDitherId(ditherId) {
    const D = window.MapArtConstants.DITHER_METHODS;
    return [D.Bayer44.id, D.Bayer22.id, D.Ordered33.id, D.Bayer88.id, D.BlueNoise.id].includes(ditherId);
  }

  ditherLevelsFor(ditherId) {
    const D = window.MapArtConstants.DITHER_METHODS;
    if (ditherId === D.BlueNoise.id) return 256;
    const m = Object.values(D).find((x) => x.id === ditherId);
    return m && m.levels ? m.levels : 16;
  }

  ditherThresholdAt(ditherId, x, y) {
    const D = window.MapArtConstants.DITHER_METHODS;
    if (ditherId === D.BlueNoise.id && this.blueNoise) {
      const s = this.blueNoise.size;
      return this.blueNoise.matrix[y % s][x % s];
    }
    const m = this.dither ? this.dither.ditherMatrix : null;
    if (m) return m[y % m.length][x % m[0].length];
    const b = D.Bayer88.ditherMatrix;
    return b[y % 8][x % 8];
  }

  /* Yliluoma's ordered dithering: pick the optimal palette pair + mixing ratio for this colour.
     useBlueNoise: use the 64x64 blue noise mask instead of the Bayer 8x8 matrix. */
  yliluomaChoose(pixelRGB, x, y, useBlueNoise) {
    const palette = this.yliluomaPalette;
    if (palette.length === 0) return { colourSetId: "-1", tone: "normal" };
    const key = (pixelRGB[0] << 16) + (pixelRGB[1] << 8) + pixelRGB[2];
    let plan = this.yliluomaCache.get(key);
    if (!plan) {
      plan = this.deviseYliluomaPlan(pixelRGB, palette);
      if (this.yliluomaCache.size > 1000000) this.yliluomaCache.clear();
      this.yliluomaCache.set(key, plan);
    }
    let t;
    if (useBlueNoise && this.blueNoise) {
      const s = this.blueNoise.size;
      t = this.blueNoise.matrix[y % s][x % s] / 256;
    } else {
      const m = window.MapArtConstants.DITHER_METHODS.Bayer88.ditherMatrix;
      t = m[y % 8][x % 8] / 64;
    }
    return t < plan.ratio ? plan.c2 : plan.c1;
  }

  deviseYliluomaPlan(pixelRGB, palette) {
    const n = palette.length;
    const K = Math.min(12, n);
    // keep the K nearest palette entries in an insertion-sorted list (no per-step sort allocations)
    const candIdx = new Int32Array(K);
    const candDist = new Float64Array(K);
    let count = 0;
    for (let i = 0; i < n; i++) {
      const d = this.squaredEuclideanMetricColours(palette[i].rgb, pixelRGB);
      if (count < K) {
        let p = count++;
        while (p > 0 && candDist[p - 1] > d) {
          candDist[p] = candDist[p - 1];
          candIdx[p] = candIdx[p - 1];
          p--;
        }
        candDist[p] = d;
        candIdx[p] = i;
      } else if (d < candDist[K - 1]) {
        let p = K - 1;
        while (p > 0 && candDist[p - 1] > d) {
          candDist[p] = candDist[p - 1];
          candIdx[p] = candIdx[p - 1];
          p--;
        }
        candDist[p] = d;
        candIdx[p] = i;
      }
    }
    let bestPlan = { c1: palette[candIdx[0]], c2: palette[candIdx[0]], ratio: 1 };
    let bestPenalty = Infinity;
    const weights = [299, 587, 114];
    for (let a = 0; a < count; a++) {
      for (let b = a; b < count; b++) {
        const c1 = palette[candIdx[a]].rgb;
        const c2 = palette[candIdx[b]].rgb;
        let ratio = 0.5;
        if (c1[0] !== c2[0] || c1[1] !== c2[1] || c1[2] !== c2[2]) {
          let num = 0;
          let den = 0;
          for (let ch = 0; ch < 3; ch++) {
            if (c2[ch] !== c1[ch]) {
              num += weights[ch] * ((pixelRGB[ch] - c1[ch]) / (c2[ch] - c1[ch]));
              den += weights[ch];
            }
          }
          ratio = den > 0 ? Math.max(0, Math.min(1, num / den)) : 0.5;
        }
        const mixed = [
          c1[0] + ratio * (c2[0] - c1[0]),
          c1[1] + ratio * (c2[1] - c1[1]),
          c1[2] + ratio * (c2[2] - c1[2]),
        ];
        const penalty =
          this.yliluomaColorCompare(pixelRGB, mixed) +
          this.yliluomaColorCompare(c1, c2) * 0.1 * (Math.abs(ratio - 0.5) + 0.5);
        if (penalty < bestPenalty) {
          bestPenalty = penalty;
          bestPlan = { c1: palette[candIdx[a]], c2: palette[candIdx[b]], ratio };
        }
      }
    }
    return bestPlan;
  }

  /* luminance-weighted colour difference from the Yliluoma paper */
  yliluomaColorCompare(c1, c2) {
    const luma1 = (c1[0] * 299 + c1[1] * 587 + c1[2] * 114) / (255.0 * 1000);
    const luma2 = (c2[0] * 299 + c2[1] * 587 + c2[2] * 114) / (255.0 * 1000);
    const lumadiff = luma1 - luma2;
    const dr = (c1[0] - c2[0]) / 255.0;
    const dg = (c1[1] - c2[1]) / 255.0;
    const db = (c1[2] - c2[2]) / 255.0;
    return (dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114) * 0.75 + lumadiff * lumadiff;
  }

  /* Riemersma dithering: error diffusion along a Hilbert curve with a 16-entry error queue */
  async processRiemersma(data, maps, W, H, onProgress) {
    await this.ensureLut(onProgress ? (p) => onProgress(p * 0.3) : null);
    const progressScale = this.lut ? 0.3 : 0;
    const report = onProgress ? (p) => onProgress(progressScale + (1 - progressScale) * p) : null;
    const size = 1 << Math.ceil(Math.log2(Math.max(W, H)));
    const weights = [];
    for (let i = 0; i < 16; i++) weights.push(Math.pow(0.5, i + 1));
    const errors = []; // newest first
    const maxErrors = 16;
    const total = size * size;
    const yieldEvery = Math.max(4096, Math.floor((W * H) / 250));
    let steps = 0;

    for (let d = 0; d < total; d++) {
      const pos = hilbertD2XY(size, d);
      const x = pos[0];
      const y = pos[1];
      if (x >= W || y >= H) continue;
      const i = (y * W + x) * 4;
      const whichMap_x = Math.floor(x / 128);
      const whichMap_y = Math.floor(y / 128);

      if (this.artW > 0 && (x >= this.artW || y >= this.artH)) {
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
        data[i + 3] = 0;
        errors.unshift([0, 0, 0]);
        if (errors.length > maxErrors) errors.pop();
      } else if (this.transparency && data[i + 3] < this.transparencyTolerance) {
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
        data[i + 3] = 0;
        errors.unshift([0, 0, 0]);
        if (errors.length > maxErrors) errors.pop();
      } else {
        data[i + 3] = 255;
        let r = data[i];
        let g = data[i + 1];
        let b = data[i + 2];
        for (let e = 0; e < errors.length; e++) {
          const w = weights[e];
          r += errors[e][0] * w;
          g += errors[e][1] * w;
          b += errors[e][2] * w;
        }
        const target = [clampByte(r), clampByte(g), clampByte(b)];
        const closest = this.findClosestColourSetIdAndToneTo(target);
        const c = this.colourSetIdAndToneToRGB(closest.colourSetId, closest.tone);
        data[i] = c[0];
        data[i + 1] = c[1];
        data[i + 2] = c[2];
        const es = this.diffusionScale;
        errors.unshift([(target[0] - c[0]) * es, (target[1] - c[1]) * es, (target[2] - c[2]) * es]);
        if (errors.length > maxErrors) errors.pop();
        maps[whichMap_y][whichMap_x].materials[closest.colourSetId] += 1;
      }

      steps++;
      if (onProgress && steps % yieldEvery === 0) {
        report(steps / (W * H));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    if (this.isolatedCleanup) {
      this.suppressIsolatedPixels(data, W, H);
      this.recountMaterials(data, maps, W, H);
    }
    if (onProgress) onProgress(1);
    return { maps };
  }

  /* ----- isolated pixel suppression (post-process) ----- */

  /* replaces pixels that have no same-colour 4-neighbour with the most similar neighbour colour */
  suppressIsolatedPixels(data, W, H) {
    for (let pass = 0; pass < this.isolatedPasses; pass++) {
      const copy = new Uint8ClampedArray(data);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          if (copy[i + 3] === 0) continue;
          const r = copy[i];
          const g = copy[i + 1];
          const b = copy[i + 2];
          let same = 0;
          let best = null;
          let bestD = Infinity;
          for (let k = 0; k < 4; k++) {
            const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
            const ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const j = (ny * W + nx) * 4;
            if (copy[j + 3] === 0) continue;
            if (copy[j] === r && copy[j + 1] === g && copy[j + 2] === b) same++;
            const d = this.squaredEuclideanMetricColours([r, g, b], [copy[j], copy[j + 1], copy[j + 2]]);
            if (d < bestD) {
              bestD = d;
              best = [copy[j], copy[j + 1], copy[j + 2]];
            }
          }
          if (same === 0 && best) {
            data[i] = best[0];
            data[i + 1] = best[1];
            data[i + 2] = best[2];
          }
        }
      }
    }
  }

  /* rebuild per-map material counts after post-processing */
  recountMaterials(data, maps, W, H) {
    for (const row of maps) {
      for (const map of row) {
        for (const k of Object.keys(map.materials)) map.materials[k] = 0;
      }
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (data[i + 3] === 0) continue;
        const cs = this.exactRGBToColourSetIdAndTone([data[i], data[i + 1], data[i + 2]]);
        if (!cs || cs.colourSetId === "-1") continue;
        const whichMap_x = Math.floor(x / 128);
        const whichMap_y = Math.floor(y / 128);
        maps[whichMap_y][whichMap_x].materials[cs.colourSetId] = (maps[whichMap_y][whichMap_x].materials[cs.colourSetId] || 0) + 1;
      }
    }
  }

  /* ----- step 2: extract coloursLayout per map ----- */

  // pixelsData: RGBA of full image; returns maps[my][mx].coloursLayout
  // coloursLayout is [x=column 0..127][z=row 0..127] of {colourSetId, tone}
  extractColoursLayouts(pixelsData, mapsX, mapsY) {
    const maps = [];
    for (let my = 0; my < mapsY; my++) {
      const row = [];
      for (let mx = 0; mx < mapsX; mx++) row.push({});
      maps.push(row);
    }
    for (let whichMap_z = 0; whichMap_z < mapsY; whichMap_z++) {
      for (let whichMap_x = 0; whichMap_x < mapsX; whichMap_x++) {
        const coloursLayout = [];
        for (let columnNumber = 0; columnNumber < 128; columnNumber++) {
          const column = [];
          for (let rowNumber = 0; rowNumber < 128; rowNumber++) {
            const offset = 4 * (128 * mapsX * (128 * whichMap_z + rowNumber) + 128 * whichMap_x + columnNumber);
            const csAndTone = this.exactRGBToColourSetIdAndTone([pixelsData[offset], pixelsData[offset + 1], pixelsData[offset + 2]]);
            column.push(csAndTone || { colourSetId: "-1", tone: "normal" });
          }
          coloursLayout.push(column);
        }
        maps[whichMap_z][whichMap_x].coloursLayout = coloursLayout;
      }
    }
    return maps;
  }

  // crops one cell layout [x][z] to cw x ch (block-size mode, non 128-aligned art)
  cropColoursLayout(layout, cw, ch) {
    const out = [];
    for (let x = 0; x < cw; x++) out.push(layout[x].slice(0, ch));
    return out;
  }

  // crops all extracted cell layouts to the actual artwork size (block-size mode)
  cropColoursLayouts(maps, artW, artH) {
    const out = [];
    for (let my = 0; my < maps.length; my++) {
      const row = [];
      for (let mx = 0; mx < maps[my].length; mx++) {
        const cw = Math.max(0, Math.min(128, artW - mx * 128));
        const ch = Math.max(0, Math.min(128, artH - my * 128));
        row.push(Object.assign({}, maps[my][mx], { coloursLayout: this.cropColoursLayout(maps[my][mx].coloursLayout, cw, ch) }));
      }
      out.push(row);
    }
    return out;
  }

  /* ----- step 3: physical layout (blocks) ----- */

  // Builds one x-column of blocks. column: [z rows] of {colourSetId, tone}
  buildPhysicalColumn(columnNumber, column) {
    const physicalColumn = [];
    const zBase = this.includeNoobline ? 1 : 0;
    let currentHeight;
    switch (this.staircaseId) {
      case window.MapArtConstants.STAIRCASING.OFF.id:
        // flat painting: start at y=0 when no supports are needed (1 block tall);
        // keep y=2 when supports are enabled (room for support blocks below, matching mapartcraft)
        currentHeight = this.supportModeId === window.MapArtConstants.SUPPORT_MODES.NONE.id ? 0 : 2;
        break;
      case window.MapArtConstants.STAIRCASING.CLASSIC.id:
      case window.MapArtConstants.STAIRCASING.VALLEY.id:
        currentHeight = 0;
        break;
      case window.MapArtConstants.STAIRCASING.FULL_DARK.id:
        currentHeight = column.length;
        break;
      case window.MapArtConstants.STAIRCASING.FULL_LIGHT.id:
        currentHeight = 0;
        break;
      default:
        throw new Error("Unknown staircase mode");
    }

    if (this.includeNoobline) {
      physicalColumn.push({ x: columnNumber, y: currentHeight, z: 0, csId: "NOOBLINE_SCAFFOLD" });
    }

    for (let rowNumber = 0; rowNumber < column.length; rowNumber++) {
      const coloursLayoutBlock = column[rowNumber];
      const previousHeight = currentHeight;
      switch (coloursLayoutBlock.tone) {
        case "dark": currentHeight -= 1; break;
        case "normal": break;
        case "light": currentHeight += 1; break;
        default: throw new Error("Unknown tone type");
      }
      if (coloursLayoutBlock.colourSetId !== "-1") {
        physicalColumn.push({ x: columnNumber, y: currentHeight, z: zBase + rowNumber, csId: coloursLayoutBlock.colourSetId });
      }

      if (this.supportModeId === window.MapArtConstants.SUPPORT_MODES.NONE.id) continue;

      if (this.supportModeId === window.MapArtConstants.SUPPORT_MODES.IMPORTANT.id) {
        if (this.isSupportBlockMandatory(coloursLayoutBlock)) {
          physicalColumn.push({ x: columnNumber, y: currentHeight - 1, z: zBase + rowNumber, csId: "NOOBLINE_SCAFFOLD" });
        }
        continue;
      }

      const r = rowNumber;
      const supportedZ = zBase + r - 1; // the block "one cycle behind" being supported

      if (this.supportModeId === window.MapArtConstants.SUPPORT_MODES.ALL_DOUBLE_OPTIMIZED.id) {
        if (r === 0) {
          // supports for the noobline (or first block when no noobline)
          if (this.includeNoobline) {
            physicalColumn.push({ x: columnNumber, y: previousHeight - 1, z: 0, csId: "NOOBLINE_SCAFFOLD" });
            if (coloursLayoutBlock.tone === "dark") {
              physicalColumn.push({ x: columnNumber, y: previousHeight - 2, z: 0, csId: "NOOBLINE_SCAFFOLD" });
            }
          }
        }
        if (supportedZ >= 0) {
          const supported = column[r - 1];
          physicalColumn.push({ x: columnNumber, y: previousHeight - 1, z: supportedZ, csId: "NOOBLINE_SCAFFOLD" });
          if (supported.tone === "light" || coloursLayoutBlock.tone === "dark") {
            physicalColumn.push({ x: columnNumber, y: previousHeight - 2, z: supportedZ, csId: "NOOBLINE_SCAFFOLD" });
          }
        }
        if (r === column.length - 1) {
          // last block extra support
          physicalColumn.push({ x: columnNumber, y: currentHeight - 1, z: zBase + r, csId: "NOOBLINE_SCAFFOLD" });
          if (coloursLayoutBlock.tone === "light") {
            physicalColumn.push({ x: columnNumber, y: currentHeight - 2, z: zBase + r, csId: "NOOBLINE_SCAFFOLD" });
          }
        }
        continue;
      }

      // ALL_OPTIMIZED
      if (r === 0) {
        if (this.includeNoobline) {
          // supports for the noobline
          if (coloursLayoutBlock.tone === "dark" || (coloursLayoutBlock.tone === "normal" && this.isSupportBlockMandatory(coloursLayoutBlock))) {
            physicalColumn.push({ x: columnNumber, y: previousHeight - 1, z: 0, csId: "NOOBLINE_SCAFFOLD" });
          }
          if (coloursLayoutBlock.tone === "dark" && this.isSupportBlockMandatory(coloursLayoutBlock)) {
            physicalColumn.push({ x: columnNumber, y: previousHeight - 2, z: 0, csId: "NOOBLINE_SCAFFOLD" });
          }
        }
        continue;
      }
      if (r === 1) {
        // supports for the first paint block
        const coloursLayoutBlock_0 = column[0];
        if (
          coloursLayoutBlock_0.tone === "light" ||
          coloursLayoutBlock.tone === "dark" ||
          this.isSupportBlockMandatory(coloursLayoutBlock_0) ||
          (coloursLayoutBlock.tone === "normal" && this.isSupportBlockMandatory(coloursLayoutBlock))
        ) {
          physicalColumn.push({ x: columnNumber, y: previousHeight - 1, z: zBase, csId: "NOOBLINE_SCAFFOLD" });
        }
        if (coloursLayoutBlock.tone === "dark" && this.isSupportBlockMandatory(coloursLayoutBlock)) {
          physicalColumn.push({ x: columnNumber, y: previousHeight - 2, z: zBase, csId: "NOOBLINE_SCAFFOLD" });
        }
        continue;
      }
      if (r === column.length - 1) {
        // supports for the last block
        const coloursLayoutBlock_north = column[r - 1];
        if (
          coloursLayoutBlock.tone === "light" ||
          this.isSupportBlockMandatory(coloursLayoutBlock) ||
          (coloursLayoutBlock.tone === "normal" && this.isSupportBlockMandatory(coloursLayoutBlock_north))
        ) {
          physicalColumn.push({ x: columnNumber, y: currentHeight - 1, z: zBase + r, csId: "NOOBLINE_SCAFFOLD" });
        }
        if (coloursLayoutBlock.tone === "light" && this.isSupportBlockMandatory(coloursLayoutBlock_north)) {
          physicalColumn.push({ x: columnNumber, y: currentHeight - 2, z: zBase + r, csId: "NOOBLINE_SCAFFOLD" });
        }
        // fall through to default case to handle the second-to-last block
      }
      // default: supports for the block at z = zBase + r - 1
      {
        const coloursLayoutBlock_north = column[r - 2];
        const coloursLayoutBlock_inQuestion = column[r - 1];
        if (
          coloursLayoutBlock_inQuestion.tone === "light" ||
          coloursLayoutBlock.tone === "dark" ||
          this.isSupportBlockMandatory(coloursLayoutBlock_inQuestion) ||
          (coloursLayoutBlock.tone === "normal" && this.isSupportBlockMandatory(coloursLayoutBlock)) ||
          (coloursLayoutBlock_inQuestion.tone === "normal" && this.isSupportBlockMandatory(coloursLayoutBlock_north))
        ) {
          physicalColumn.push({ x: columnNumber, y: previousHeight - 1, z: supportedZ, csId: "NOOBLINE_SCAFFOLD" });
        }
        if (
          (coloursLayoutBlock.tone === "dark" && this.isSupportBlockMandatory(coloursLayoutBlock)) ||
          (coloursLayoutBlock_inQuestion.tone === "light" && this.isSupportBlockMandatory(coloursLayoutBlock_north))
        ) {
          physicalColumn.push({ x: columnNumber, y: previousHeight - 2, z: supportedZ, csId: "NOOBLINE_SCAFFOLD" });
        }
      }
    }

    // sort by z then y (needed for valley plateaus + preview)
    physicalColumn.sort((elt1, elt2) => {
      if (elt1.z < elt2.z) return -1;
      if (elt1.z > elt2.z) return 1;
      if (elt1.y > elt2.y) return -1;
      return 1;
    });

    switch (this.staircaseId) {
      case window.MapArtConstants.STAIRCASING.VALLEY.id: {
        let plateaus = [{ startIndex: 0, endIndex: 0 }];
        let ascending = false;
        let currentPlateauStartIndex = null;
        let visibleBlocksHeight = physicalColumn.length > 0 ? physicalColumn[0].y : 0;
        for (let i = 0; i < physicalColumn.length; i++) {
          const physicalBlock = physicalColumn[i];
          if (physicalBlock.csId === "NOOBLINE_SCAFFOLD") continue;
          if (ascending && physicalBlock.y < visibleBlocksHeight) {
            ascending = false;
            plateaus.push({ startIndex: currentPlateauStartIndex, endIndex: i });
          } else if (physicalBlock.y > visibleBlocksHeight) {
            ascending = true;
            currentPlateauStartIndex = i;
          }
          visibleBlocksHeight = physicalBlock.y;
        }
        plateaus.push({ startIndex: physicalColumn.length, endIndex: physicalColumn.length });
        let nonPlateauPulldownHeights = [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
        while (plateaus.length !== 1) {
          let pullDownHeight = Number.MAX_SAFE_INTEGER;
          for (let i = plateaus[0].endIndex; i < plateaus[1].startIndex; i++) {
            pullDownHeight = Math.min(physicalColumn[i].y, pullDownHeight);
          }
          for (let i = plateaus[0].endIndex; i < plateaus[1].startIndex; i++) {
            physicalColumn[i].y -= pullDownHeight;
          }
          nonPlateauPulldownHeights[1] = pullDownHeight;
          const plateauPulldownHeight = Math.min(...nonPlateauPulldownHeights);
          for (let i = plateaus[0].startIndex; i < plateaus[0].endIndex; i++) {
            physicalColumn[i].y -= plateauPulldownHeight;
          }
          plateaus.shift();
          nonPlateauPulldownHeights[0] = nonPlateauPulldownHeights[1];
        }
        break;
      }
      case window.MapArtConstants.STAIRCASING.CLASSIC.id: {
        if (physicalColumn.length > 0) {
          const columnMinimumY = physicalColumn.reduce((a, b) => (a.y < b.y ? a : b)).y;
          physicalColumn.forEach((block) => {
            block.y -= columnMinimumY;
          });
        }
        break;
      }
    }

    return physicalColumn;
  }

  // coloursLayout: [x columns][z rows] of {colourSetId, tone}
  // returns { blocks: [{x,y,z,csId}], size: [sx, sy, sz], supportCount }
  buildPhysicalLayout(coloursLayout) {
    const blocks = [];
    let supportCount = 0;
    let maxHeight = 0;
    for (let columnNumber = 0; columnNumber < coloursLayout.length; columnNumber++) {
      const physicalColumn = this.buildPhysicalColumn(columnNumber, coloursLayout[columnNumber]);
      for (const block of physicalColumn) {
        if (block.csId === "NOOBLINE_SCAFFOLD") supportCount++;
        blocks.push(block);
      }
      if (physicalColumn.length > 0) {
        const columnMax = physicalColumn.reduce((a, b) => (a.y > b.y ? a : b)).y;
        if (columnMax > maxHeight) maxHeight = columnMax;
      }
    }
    const depth = coloursLayout[0].length + (this.includeNoobline ? 1 : 0);
    const size = [coloursLayout.length, maxHeight + 1, depth];
    return { blocks, size, supportCount };
  }

  // Builds the physical layout of the merged image (all maps) without materializing
  // the whole merged coloursLayout (memory-friendly for big art).
  // maps: mapsY x mapsX, each .coloursLayout is [x][z]; cell sizes may be smaller than
  // 128 at the right/bottom edge (block-size mode).
  buildMergedPhysicalLayout(maps) {
    const mapsX = maps[0].length;
    const mapsY = maps.length;
    // per-column cell widths and x offsets
    const colW = [];
    const colOff = [];
    let totalW = 0;
    for (let mx = 0; mx < mapsX; mx++) {
      colW.push(maps[0][mx].coloursLayout.length);
      colOff.push(totalW);
      totalW += colW[mx];
    }
    // per-row cell heights and z offsets
    const rowH = [];
    const rowOff = [];
    let totalH = 0;
    for (let my = 0; my < mapsY; my++) {
      rowH.push(maps[my][0].coloursLayout[0].length);
      rowOff.push(totalH);
      totalH += rowH[my];
    }
    const blocks = [];
    let supportCount = 0;
    let maxHeight = 0;
    let mx = 0;
    for (let x = 0; x < totalW; x++) {
      while (mx < mapsX - 1 && x >= colOff[mx] + colW[mx]) mx++;
      const xInCell = x - colOff[mx];
      const column = [];
      for (let my = 0; my < mapsY; my++) {
        const cell = maps[my][mx].coloursLayout[xInCell];
        for (let z = 0; z < rowH[my]; z++) column.push(cell[z]);
      }
      const physicalColumn = this.buildPhysicalColumn(x, column);
      for (const block of physicalColumn) {
        if (block.csId === "NOOBLINE_SCAFFOLD") supportCount++;
        blocks.push(block);
      }
      if (physicalColumn.length > 0) {
        const columnMax = physicalColumn.reduce((a, b) => (a.y > b.y ? a : b)).y;
        if (columnMax > maxHeight) maxHeight = columnMax;
      }
    }
    const depth = totalH + (this.includeNoobline ? 1 : 0);
    const size = [totalW, maxHeight + 1, depth];
    return { blocks, size, supportCount };
  }

  /* ----- block name resolution ----- */

  compareVersions(a, b) {
    const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
    const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
      const va = pa[i] || 0;
      const vb = pb[i] || 0;
      if (va !== vb) return va - vb;
    }
    return 0;
  }

  resolveBlockNBTData(block) {
    let ref = block.validVersions[this.mcVersion];
    if (ref === undefined) {
      let chosen = null;
      for (const v of Object.keys(block.validVersions)) {
        if (this.compareVersions(v, this.mcVersion) <= 0) {
          if (chosen === null || this.compareVersions(v, chosen) > 0) chosen = v;
        }
      }
      if (chosen === null) chosen = Object.keys(block.validVersions)[0];
      ref = block.validVersions[chosen];
    }
    let guard = 0;
    while (typeof ref === "string" && ref[0] === "&" && guard++ < 10) {
      ref = block.validVersions[ref.slice(1)];
    }
    return ref;
  }

  blockNBTNameAndArgs(colourSetId, blockId) {
    const block = this.coloursJSON[colourSetId].blocks[blockId];
    const data = this.resolveBlockNBTData(block);
    return { name: "minecraft:" + data.NBTName, args: data.NBTArgs || {} };
  }

  /* ----- wall mode (vertical pixel art) ----- */

  // layout: [x][row] of {colourSetId, tone}; row 0 = image top (highest y)
  buildWallPhysicalLayout(layout) {
    const W = layout.length;
    const H = layout[0].length;
    const blocks = [];
    for (let x = 0; x < W; x++) {
      for (let row = 0; row < H; row++) {
        const p = layout[x][row];
        if (!p || p.colourSetId === "-1") continue;
        blocks.push({ x, y: H - 1 - row, z: 0, csId: p.colourSetId });
      }
    }
    return { blocks, size: [W, H, 1], supportCount: 0 };
  }

  // slice a wall layout into a cell (for split output), re-indexed to local coords
  sliceWallLayout(layout, cx, cy, cw, ch) {
    const out = [];
    for (let x = 0; x < cw; x++) {
      out.push(layout[cx + x].slice(cy, cy + ch));
    }
    return out;
  }

  // pixelsData: RGBA of W x H image; returns layout [x][row]
  extractColoursLayoutWall(pixelsData, W, H) {
    const layout = [];
    for (let x = 0; x < W; x++) {
      const col = [];
      for (let row = 0; row < H; row++) {
        const offset = 4 * (row * W + x);
        const csAndTone = this.exactRGBToColourSetIdAndTone([pixelsData[offset], pixelsData[offset + 1], pixelsData[offset + 2]]);
        col.push(csAndTone || { colourSetId: "-1", tone: "normal" });
      }
      layout.push(col);
    }
    return layout;
  }

  buildWallSchematicNbt(layout, author) {
    return this.assembleSchematicNbt(this.buildWallPhysicalLayout(layout), author);
  }

  buildWallSchematicNbtCell(layout, cx, cy, cw, ch, author) {
    return this.assembleSchematicNbt(this.buildWallPhysicalLayout(this.sliceWallLayout(layout, cx, cy, cw, ch)), author);
  }

  buildWallLitematic(layout, baseName, author) {
    return this.assembleLitematic(this.buildWallPhysicalLayout(layout), baseName, author);
  }

  buildWallLitematicCell(layout, cx, cy, cw, ch, baseName, author) {
    return this.assembleLitematic(this.buildWallPhysicalLayout(this.sliceWallLayout(layout, cx, cy, cw, ch)), baseName, author);
  }

  /* ----- step 4: Schematica-format .nbt output (one per map) ----- */

  buildSchematicNbt(coloursLayout, author) {
    const layoutResult = this.buildPhysicalLayout(coloursLayout);
    return this.assembleSchematicNbt(layoutResult, author);
  }

  // merged whole-image .nbt (single file), memory-friendly like the merged litematic
  buildSchematicNbtMerged(maps, author) {
    const layoutResult = this.buildMergedPhysicalLayout(maps);
    return this.assembleSchematicNbt(layoutResult, author);
  }

  assembleSchematicNbt(layoutResult, author) {
    const blocks = layoutResult.blocks;
    const size = layoutResult.size;

    // palette: colourSetIds used (ascending), then NOOBLINE_SCAFFOLD
    const colourSetIdsUsed = [];
    for (const b of blocks) if (b.csId !== "NOOBLINE_SCAFFOLD" && !colourSetIdsUsed.includes(b.csId)) colourSetIdsUsed.push(b.csId);
    colourSetIdsUsed.sort((x, y) => parseInt(x, 10) - parseInt(y, 10));
    const paletteColourSetIdToId = {};
    colourSetIdsUsed.forEach((csId, idx) => (paletteColourSetIdToId[csId] = idx));
    paletteColourSetIdToId.NOOBLINE_SCAFFOLD = colourSetIdsUsed.length;
    const hasScaffold = blocks.some((b) => b.csId === "NOOBLINE_SCAFFOLD");

    const version = window.MapArtConstants.SUPPORTED_VERSIONS.find((v) => v.MCVersion === this.mcVersion);

    const paletteList = [];
    for (const csId of colourSetIdsUsed) {
      const blockId = this.selectedBlocks[csId];
      const { name, args } = this.blockNBTNameAndArgs(csId, blockId);
      const item = { Name: { type: 8, value: name } };
      if (Object.keys(args).length !== 0) {
        const props = {};
        Object.keys(args).forEach((k) => (props[k] = { type: 8, value: args[k] }));
        item.Properties = { type: 10, value: props };
      }
      paletteList.push(item);
    }
    if (hasScaffold) {
      paletteList.push({ Name: { type: 8, value: "minecraft:" + this.supportBlock.toLowerCase() } });
    }

    const blockList = [];
    for (const b of blocks) {
      blockList.push({
        pos: { type: 9, value: { type: 3, value: [b.x, b.y, b.z] } },
        state: { type: 3, value: paletteColourSetIdToId[b.csId] },
      });
    }

    const NBT_json = {
      name: "",
      value: {
        blocks: { type: 9, value: { type: 10, value: blockList } },
        entities: { type: 9, value: { type: 10, value: [] } },
        palette: { type: 9, value: { type: 10, value: paletteList } },
        size: { type: 9, value: { type: 3, value: size } },
        author: { type: 8, value: author || "MapArt Generator" },
        DataVersion: { type: 3, value: version.NBTVersion },
      },
    };
    const writer = new NBTWriterCtor();
    writer.writeTopLevelCompound(NBT_json.name, NBT_json.value);
    return writer.getData();
  }

  /* ----- step 5: litematic output (merged whole image, gzipped) ----- */

  // maps: mapsY x mapsX, each .coloursLayout is [x 0..127][z 0..127]
  buildLitematicBytes(maps, baseName, author) {
    return this.assembleLitematic(this.buildMergedPhysicalLayout(maps), baseName, author);
  }

  assembleLitematic(layoutResult, baseName, author) {
    const blocks = layoutResult.blocks;
    const size = layoutResult.size; // [sx, sy, sz]
    const sx = size[0], sy = size[1], sz = size[2];
    const volume = sx * sy * sz;

    // palette: air first, then used colourSetIds ascending, then scaffold
    const colourSetIdsUsed = [];
    for (const b of blocks) if (b.csId !== "NOOBLINE_SCAFFOLD" && !colourSetIdsUsed.includes(b.csId)) colourSetIdsUsed.push(b.csId);
    colourSetIdsUsed.sort((x, y) => parseInt(x, 10) - parseInt(y, 10));
    const palette = [{ name: "minecraft:air", args: {} }];
    const idToPaletteIndex = {};
    for (const csId of colourSetIdsUsed) {
      const { name, args } = this.blockNBTNameAndArgs(csId, this.selectedBlocks[csId]);
      palette.push({ name, args });
      idToPaletteIndex[csId] = palette.length - 1;
    }
    if (blocks.some((b) => b.csId === "NOOBLINE_SCAFFOLD")) {
      palette.push({ name: "minecraft:" + this.supportBlock.toLowerCase(), args: {} });
      idToPaletteIndex.NOOBLINE_SCAFFOLD = palette.length - 1;
    }
    const paletteSize = palette.length;

    const bits = Math.max(2, 32 - Math.clz32(paletteSize - 1));
    const longs = new Uint8Array(Math.ceil((volume * bits) / 64) * 8);
    const longsView = new DataView(longs.buffer);

    // index = y*sx*sz + z*sx + x, tight LSB-first packing (matches TightLongBackedIntArray)
    // IMPORTANT: the long array is stored BIG-ENDIAN like all NBT longs (hi word first, lo word last).
    // max entry width is 32 bits, so an entry spans at most two 64-bit words
    const setEntry = (index, value) => writePackedEntry(longsView, bits, index, value);

    // place blocks
    for (const b of blocks) {
      const index = b.y * sx * sz + b.z * sx + b.x;
      setEntry(index, idToPaletteIndex[b.csId]);
    }

    // palette NBT list
    const paletteTag = palette.map((p) => {
      const item = { Name: { type: 8, value: p.name } };
      if (p.args && Object.keys(p.args).length) {
        const props = {};
        Object.keys(p.args).forEach((k) => (props[k] = { type: 8, value: p.args[k] }));
        item.Properties = { type: 10, value: props };
      }
      return item;
    });

    const now = Date.now();
    // malilib DataTypeUtils: vec3i values are stored as COMPOUND tags with x/y/z int keys
    const vec3i = (v) => ({
      type: 10,
      value: {
        x: { type: 3, value: v[0] },
        y: { type: 3, value: v[1] },
        z: { type: 3, value: v[2] },
      },
    });
    const region = {
      DataVersion: { type: 3, value: window.MapArtConstants.SUPPORTED_VERSIONS.find((v) => v.MCVersion === this.mcVersion).NBTVersion },
      BlockStatePalette: { type: 9, value: { type: 10, value: paletteTag } },
      BlockStates: { type: 12, value: longs },
      Position: vec3i([0, 0, 0]),
      Size: vec3i(size),
    };

    const totalBlocks = blocks.length;
    const totalVolume = volume;

    const root = {
      name: "Schematic",
      value: {
        Version: { type: 3, value: 4 },
        MinecraftDataVersion: { type: 3, value: window.MapArtConstants.SUPPORTED_VERSIONS.find((v) => v.MCVersion === this.mcVersion).NBTVersion },
        Metadata: {
          type: 10,
          value: {
            Name: { type: 8, value: baseName || "MapArt" },
            Author: { type: 8, value: author || "MapArt Generator" },
            Description: { type: 8, value: "Generated by MC Map Art Generator" },
            SchematicVersion: { type: 3, value: 4 },
            TimeCreated: { type: 4, value: longFromMs(now) },
            TimeModified: { type: 4, value: longFromMs(now) },
            EnclosingSize: vec3i(size),
            McDataVersion: { type: 3, value: window.MapArtConstants.SUPPORTED_VERSIONS.find((v) => v.MCVersion === this.mcVersion).NBTVersion },
            McVersion: { type: 8, value: this.mcVersion },
            RegionCount: { type: 3, value: 1 },
            EntityCount: { type: 3, value: 0 },
            TotalVolume: { type: 4, value: longFromMs(totalVolume) },
            TotalBlocks: { type: 4, value: longFromMs(totalBlocks) },
            BlockEntityCount: { type: 4, value: 0 },
            BlockTickCount: { type: 4, value: 0 },
          },
        },
        Regions: {
          type: 10,
          value: {
            mapart: { type: 10, value: region },
          },
        },
      },
    };

    const writer = new NBTWriterCtor();
    writer.writeTopLevelCompound(root.name, root.value);
    const nbtBytes = writer.getData();
    return gzipBytes(new Uint8Array(nbtBytes));
  }

  /* ----- step 6: map.dat output (one per map) ----- */

  buildMapdatBytes(coloursLayout) {
    const dataVersion = window.MapArtConstants.SUPPORTED_VERSIONS.find((v) => v.MCVersion === this.mcVersion).NBTVersion;
    const colors = new Uint8Array(16384);
    for (let x = 0; x < 128; x++) {
      for (let z = 0; z < 128; z++) {
        const pixel = coloursLayout[x][z];
        const arrayOffset = z * 128 + x;
        let mapdatId;
        if (pixel.colourSetId === "-1") {
          mapdatId = 1;
        } else {
          switch (pixel.tone) {
            case "dark": mapdatId = 4 * this.coloursJSON[pixel.colourSetId].mapdatId; break;
            case "normal": mapdatId = 4 * this.coloursJSON[pixel.colourSetId].mapdatId + 1; break;
            case "light": mapdatId = 4 * this.coloursJSON[pixel.colourSetId].mapdatId + 2; break;
            case "unobtainable": mapdatId = 4 * this.coloursJSON[pixel.colourSetId].mapdatId + 3; break;
            default: throw new Error("Unknown colour tone");
          }
        }
        colors[arrayOffset] = mapdatId;
      }
    }
    const NBT_json = {
      name: "",
      value: {
        data: {
          type: 10,
          value: {
            scale: { type: 1, value: 0 },
            dimension: {
              type: dataVersion >= 2566 ? 8 : 1,
              value: dataVersion >= 2566 ? "minecraft:overworld" : dataVersion > 1343 ? 0 : -128,
            },
            unlimitedTracking: { type: 1, value: 0 },
            trackingPosition: { type: 1, value: 0 },
            locked: { type: 1, value: 1 },
            height: { type: 2, value: 128 },
            width: { type: 2, value: 128 },
            xCenter: { type: 3, value: 0 },
            zCenter: { type: 3, value: 0 },
            colors: { type: 7, value: colors },
          },
        },
        DataVersion: { type: 3, value: dataVersion },
      },
    };
    const writer = new NBTWriterCtor();
    writer.writeTopLevelCompound(NBT_json.name, NBT_json.value);
    return writer.getData();
  }

  /* ----- merge maps into a single coloursLayout (for litematic) ----- */

  // deprecated: use buildMergedPhysicalLayout instead (memory-friendly)
  mergeMaps(maps) {
    const mapsX = maps[0].length;
    const mapsY = maps.length;
    const merged = [];
    for (let x = 0; x < 128 * mapsX; x++) {
      const col = [];
      for (let z = 0; z < 128 * mapsY; z++) col.push(null);
      merged.push(col);
    }
    for (let my = 0; my < mapsY; my++) {
      for (let mx = 0; mx < mapsX; mx++) {
        const layout = maps[my][mx].coloursLayout;
        for (let x = 0; x < 128; x++) {
          for (let z = 0; z < 128; z++) {
            merged[mx * 128 + x][my * 128 + z] = layout[x][z];
          }
        }
      }
    }
    return merged;
  }
}

/* Convert ms timestamp to [high, low] signed 32-bit ints (NBT long) */
function longFromMs(ms) {
  const high = Math.floor(ms / 4294967296);
  const low = ms >>> 0;
  return [high > 0x7fffffff ? high - 0x100000000 : high, low > 0x7fffffff ? low - 0x100000000 : low];
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { MapGenerator, longFromMs };
}
