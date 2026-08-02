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

    this.colourSetsToUse = [];
    this.exactColourCache = new Map();
    this.colourCache = new Map();
    this.labCache = new Map();
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
    if (this.betterColour) {
      pixel1 = this.rgb2lab(pixel1);
      pixel2 = this.rgb2lab(pixel2);
    }
    const r = pixel1[0] - pixel2[0];
    const g = pixel1[1] - pixel2[1];
    const b = pixel1[2] - pixel2[2];
    return r * r + g * g + b * b;
  }

  colourSetIdAndToneToRGB(colourSetId, tone) {
    return this.coloursJSON[colourSetId].tonesRGB[tone];
  }

  findClosestColourSetIdAndToneTo(pixelRGB) {
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
  }

  getToneKeys() {
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
    const multimapWidth = mapsX * 128;
    const totalRows = mapsY * 128;
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

    const ditherMatrix = this.dither ? this.dither.ditherMatrix : null;
    const divisor = this.dither ? this.dither.ditherDivisor : null;
    const ditherId = this.ditherId;
    const D = window.MapArtConstants.DITHER_METHODS;
    const errorDiffusionIds = [D.FloydSteinberg.id, D.MinAvgErr.id, D.Burkes.id, D.SierraLite.id, D.Stucki.id, D.Atkinson.id];
    const yieldEvery = Math.max(1, Math.floor(totalRows / 250)); // ~250 UI yields total

    for (let rowY = 0; rowY < totalRows; rowY++) {
      const rowStart = rowY * multimapWidth * 4;
      const rowEnd = rowStart + multimapWidth * 4;

      for (let i = rowStart; i < rowEnd; i += 4) {
        const multimap_x = (i / 4) % multimapWidth;
        const whichMap_x = Math.floor(multimap_x / 128);
        const whichMap_y = Math.floor(rowY / 128);

        let closestColourSetIdAndTone;
        if (this.transparency && data[i + 3] < this.transparencyTolerance) {
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
          data[i + 3] = 0;
        } else {
          data[i + 3] = 255;
          const oldPixel = [data[i], data[i + 1], data[i + 2]];
          if (ditherMatrix === null) {
            closestColourSetIdAndTone = this.findClosestColourSetIdAndToneTo(oldPixel);
            const c = this.colourSetIdAndToneToRGB(closestColourSetIdAndTone.colourSetId, closestColourSetIdAndTone.tone);
            data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
          } else if (ditherId === D.Bayer44.id || ditherId === D.Bayer22.id || ditherId === D.Ordered33.id) {
            const newPixels = this.findClosest2ColourSetIdAndToneTo(oldPixel);
            if ((newPixels[0] * (ditherMatrix[0].length * ditherMatrix.length + 1)) / newPixels[1] > ditherMatrix[multimap_x % ditherMatrix[0].length][rowY % ditherMatrix.length]) {
              closestColourSetIdAndTone = newPixels[3];
            } else {
              closestColourSetIdAndTone = newPixels[2];
            }
            const c = this.colourSetIdAndToneToRGB(closestColourSetIdAndTone.colourSetId, closestColourSetIdAndTone.tone);
            data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
          } else if (errorDiffusionIds.includes(ditherId)) {
            closestColourSetIdAndTone = this.findClosestColourSetIdAndToneTo(oldPixel);
            const c = this.colourSetIdAndToneToRGB(closestColourSetIdAndTone.colourSetId, closestColourSetIdAndTone.tone);
            data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
            const quant_error = [oldPixel[0] - c[0], oldPixel[1] - c[1], oldPixel[2] - c[2]];
            try {
              if (multimap_x + 1 < multimapWidth) {
                const weight = ditherMatrix[0][3] / divisor;
                data[i + 4] += quant_error[0] * weight; data[i + 5] += quant_error[1] * weight; data[i + 6] += quant_error[2] * weight;
                if (multimap_x + 2 < multimapWidth) {
                  const weight = ditherMatrix[0][4] / divisor;
                  data[i + 8] += quant_error[0] * weight; data[i + 9] += quant_error[1] * weight; data[i + 10] += quant_error[2] * weight;
                }
              }
              if (multimap_x > 0) {
                const weight = ditherMatrix[1][1] / divisor;
                data[i + multimapWidth * 4 - 4] += quant_error[0] * weight;
                data[i + multimapWidth * 4 - 3] += quant_error[1] * weight;
                data[i + multimapWidth * 4 - 2] += quant_error[2] * weight;
                if (multimap_x > 1) {
                  const weight = ditherMatrix[1][0] / divisor;
                  data[i + multimapWidth * 4 - 8] += quant_error[0] * weight;
                  data[i + multimapWidth * 4 - 7] += quant_error[1] * weight;
                  data[i + multimapWidth * 4 - 6] += quant_error[2] * weight;
                }
              }
              let weight = ditherMatrix[1][2] / divisor;
              data[i + multimapWidth * 4] += quant_error[0] * weight;
              data[i + multimapWidth * 4 + 1] += quant_error[1] * weight;
              data[i + multimapWidth * 4 + 2] += quant_error[2] * weight;
              if (multimap_x + 1 < multimapWidth) {
                const weight = ditherMatrix[1][3] / divisor;
                data[i + multimapWidth * 4 + 4] += quant_error[0] * weight;
                data[i + multimapWidth * 4 + 5] += quant_error[1] * weight;
                data[i + multimapWidth * 4 + 6] += quant_error[2] * weight;
                if (multimap_x + 2 < multimapWidth) {
                  const weight = ditherMatrix[1][4] / divisor;
                  data[i + multimapWidth * 4 + 8] += quant_error[0] * weight;
                  data[i + multimapWidth * 4 + 9] += quant_error[1] * weight;
                  data[i + multimapWidth * 4 + 10] += quant_error[2] * weight;
                }
              }
              if (multimap_x > 0) {
                const weight = ditherMatrix[2][1] / divisor;
                data[i + multimapWidth * 8 - 4] += quant_error[0] * weight;
                data[i + multimapWidth * 8 - 3] += quant_error[1] * weight;
                data[i + multimapWidth * 8 - 2] += quant_error[2] * weight;
                if (multimap_x > 1) {
                  const weight = ditherMatrix[2][0] / divisor;
                  data[i + multimapWidth * 8 - 8] += quant_error[0] * weight;
                  data[i + multimapWidth * 8 - 7] += quant_error[1] * weight;
                  data[i + multimapWidth * 8 - 6] += quant_error[2] * weight;
                }
              }
              weight = ditherMatrix[2][2] / divisor;
              data[i + multimapWidth * 8] += quant_error[0] * weight;
              data[i + multimapWidth * 8 + 1] += quant_error[1] * weight;
              data[i + multimapWidth * 8 + 2] += quant_error[2] * weight;
              if (multimap_x + 1 < multimapWidth) {
                const weight = ditherMatrix[2][3] / divisor;
                data[i + multimapWidth * 8 + 4] += quant_error[0] * weight;
                data[i + multimapWidth * 8 + 5] += quant_error[1] * weight;
                data[i + multimapWidth * 8 + 6] += quant_error[2] * weight;
                if (multimap_x + 2 < multimapWidth) {
                  const weight = ditherMatrix[2][4] / divisor;
                  data[i + multimapWidth * 8 + 8] += quant_error[0] * weight;
                  data[i + multimapWidth * 8 + 9] += quant_error[1] * weight;
                  data[i + multimapWidth * 8 + 10] += quant_error[2] * weight;
                }
              }
            } catch (e) {
              console.error(e);
            }
          }
          maps[whichMap_y][whichMap_x].materials[closestColourSetIdAndTone.colourSetId] += 1;
        }
      }

      if (onProgress && (rowY + 1) % yieldEvery === 0) {
        onProgress((rowY + 1) / totalRows);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    if (onProgress) onProgress(1);
    return { maps };
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
  // maps: mapsY x mapsX, each .coloursLayout is [x 0..127][z 0..127]
  buildMergedPhysicalLayout(maps) {
    const mapsX = maps[0].length;
    const mapsY = maps.length;
    const blocks = [];
    let supportCount = 0;
    let maxHeight = 0;
    for (let x = 0; x < 128 * mapsX; x++) {
      const mx = Math.floor(x / 128);
      const xInCell = x % 128;
      const column = [];
      for (let my = 0; my < mapsY; my++) {
        const cell = maps[my][mx].coloursLayout[xInCell];
        for (let z = 0; z < 128; z++) column.push(cell[z]);
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
    const depth = 128 * mapsY + (this.includeNoobline ? 1 : 0);
    const size = [128 * mapsX, maxHeight + 1, depth];
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
    const layoutResult = this.buildMergedPhysicalLayout(maps);
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
    const setEntry = (index, value) => {
      const startOffset = index * bits;
      const startArr = Math.floor(startOffset / 64);
      const bitOffset = startOffset % 64;
      value &= (1 << bits) - 1;
      const loWord = startArr * 8 + 4; // big-endian: lo word is the LAST 4 bytes of the long
      const hiWord = startArr * 8; // big-endian: hi word is the FIRST 4 bytes of the long
      if (bitOffset + bits <= 64) {
        if (bitOffset + bits <= 32) {
          // all bits in the low word
          let w = longsView.getUint32(loWord, false);
          w = (w & ~(((1 << bits) - 1) << bitOffset)) >>> 0;
          w = (w | (value << bitOffset)) >>> 0;
          longsView.setUint32(loWord, w, false);
        } else if (bitOffset >= 32) {
          // all bits in the high word
          const wb = bitOffset - 32;
          let w = longsView.getUint32(hiWord, false);
          w = (w & ~(((1 << bits) - 1) << wb)) >>> 0;
          w = (w | (value << wb)) >>> 0;
          longsView.setUint32(hiWord, w, false);
        } else {
          // spans low and high word of the same long
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
        // crosses into the next long: bits end in the hi word of current long, rest in lo word of next long
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
    };

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
