"use strict";

/* Shared constants for the map art generator.
   Data versions verified from official Mojang client jars (Aug 2026). */

window.MapArtConstants = (() => {
  const TOOL_VERSION = "v1.3";
  const SUPPORTED_VERSIONS = [
    { MCVersion: "1.12.2", NBTVersion: 1343 },
    { MCVersion: "1.13.2", NBTVersion: 1631 },
    { MCVersion: "1.14.4", NBTVersion: 1976 },
    { MCVersion: "1.15.2", NBTVersion: 2230 },
    { MCVersion: "1.16.5", NBTVersion: 2586 },
    { MCVersion: "1.17.1", NBTVersion: 2730 },
    { MCVersion: "1.18.2", NBTVersion: 2975 },
    { MCVersion: "1.19", NBTVersion: 3105 },
    { MCVersion: "1.19.4", NBTVersion: 3337 },
    { MCVersion: "1.20", NBTVersion: 3463 },
    { MCVersion: "1.20.4", NBTVersion: 3700 },
    { MCVersion: "1.20.5", NBTVersion: 3837 },
    { MCVersion: "1.20.6", NBTVersion: 3839 },
    { MCVersion: "1.21", NBTVersion: 3953 },
    { MCVersion: "1.21.1", NBTVersion: 3955 },
    { MCVersion: "1.21.2", NBTVersion: 4080 },
    { MCVersion: "1.21.3", NBTVersion: 4082 },
    { MCVersion: "1.21.4", NBTVersion: 4189 },
    { MCVersion: "1.21.5", NBTVersion: 4325 },
    { MCVersion: "1.21.6", NBTVersion: 4435 },
    { MCVersion: "1.21.7", NBTVersion: 4438 },
    { MCVersion: "1.21.8", NBTVersion: 4440 },
    { MCVersion: "1.21.9", NBTVersion: 4554 },
    { MCVersion: "1.21.10", NBTVersion: 4556 },
    { MCVersion: "1.21.11", NBTVersion: 4671 },
  ];

  /* 3D / tone modes */
  const STAIRCASING = {
    OFF: { id: 0, name: "平面 (仅一格高)", toneKeys: ["normal"] },
    CLASSIC: { id: 1, name: "经典阶梯", toneKeys: ["dark", "normal", "light"] },
    VALLEY: { id: 2, name: "山谷阶梯", toneKeys: ["dark", "normal", "light"] },
    FULL_DARK: { id: 3, name: "全暗阶梯", toneKeys: ["dark"] },
    FULL_LIGHT: { id: 4, name: "全亮阶梯", toneKeys: ["light"] },
  };

  /* support block placement modes (mapartcraft "where support blocks" option) */
  const SUPPORT_MODES = {
    NONE: { id: 0, name: "无支撑（只生成画的部分）" },
    IMPORTANT: { id: 1, name: "仅重力/必需方块" },
    ALL_OPTIMIZED: { id: 2, name: "全部方块（优化）" },
    ALL_DOUBLE_OPTIMIZED: { id: 3, name: "全部方块（双层）" },
  };

  const DITHER_METHODS = {
    None: { id: 0, name: "无" },
    FloydSteinberg: {
      id: 1,
      name: "Floyd-Steinberg",
      ditherMatrix: [
        [0, 0, 0, 7.0, 0],
        [0, 3.0, 5.0, 1.0, 0],
        [0, 0, 0, 0, 0],
      ],
      ditherDivisor: 16.0,
    },
    Bayer44: {
      id: 2,
      name: "Bayer (4x4)",
      ditherMatrix: [
        [1, 9, 3, 11],
        [13, 5, 15, 7],
        [4, 12, 2, 10],
        [16, 8, 14, 6],
      ],
    },
    Bayer22: {
      id: 3,
      name: "Bayer (2x2)",
      ditherMatrix: [
        [1, 3],
        [4, 2],
      ],
    },
    Ordered33: {
      id: 4,
      name: "Ordered (3x3)",
      ditherMatrix: [
        [1, 7, 4],
        [5, 8, 3],
        [6, 2, 9],
      ],
    },
    MinAvgErr: {
      id: 5,
      name: "MinAvgErr",
      ditherMatrix: [
        [0, 0, 0, 7.0, 5.0],
        [3.0, 5.0, 7.0, 5.0, 3.0],
        [1.0, 3.0, 5.0, 3.0, 1.0],
      ],
      ditherDivisor: 48.0,
    },
    Burkes: {
      id: 6,
      name: "Burkes",
      ditherMatrix: [
        [0.0, 0.0, 0.0, 8.0, 4.0],
        [2.0, 4.0, 8.0, 4.0, 2.0],
        [0.0, 0.0, 0.0, 0.0, 0.0],
      ],
      ditherDivisor: 32.0,
    },
    SierraLite: {
      id: 7,
      name: "Sierra-Lite",
      ditherMatrix: [
        [0, 0, 0, 2.0, 0],
        [0, 1.0, 1.0, 0, 0],
        [0, 0, 0, 0, 0],
      ],
      ditherDivisor: 4.0,
    },
    Stucki: {
      id: 8,
      name: "Stucki",
      ditherMatrix: [
        [0, 0, 0, 8.0, 4.0],
        [2.0, 4.0, 8.0, 4.0, 2.0],
        [1.0, 2.0, 4.0, 2.0, 1.0],
      ],
      ditherDivisor: 42.0,
    },
    Atkinson: {
      id: 9,
      name: "Atkinson",
      ditherMatrix: [
        [0, 0, 0, 1.0, 1.0],
        [0, 1.0, 1.0, 1.0, 0],
        [0, 0, 1.0, 0, 0],
      ],
      ditherDivisor: 8.0,
    },
  };

  const CROP_MODES = {
    STRETCH: { id: 0, name: "拉伸适应" },
    CENTER: { id: 1, name: "居中裁剪" },
    MANUAL: { id: 2, name: "手动裁剪" },
  };

  const BACKGROUND_MODES = {
    OFF: { id: 0, name: "关闭" },
    WHITE: { id: 1, name: "白色" },
    BLACK: { id: 2, name: "黑色" },
    CUSTOM: { id: 3, name: "自定义颜色" },
  };

  const OUTPUT_FORMATS = {
    NBT: { id: "nbt", name: "Schematic (.nbt)", folder: "Schematic-NBT", desc: "Schematica/Litematica 可用，按地图拆分多文件" },
    LITEMATIC: { id: "litematic", name: "Litematic (.litematic)", folder: "Litematic", desc: "Litematica 模组直接使用，整图单文件" },
    MAPDAT: { id: "mapdat", name: "MapData (map.dat)", folder: "MapData", desc: "直接替换存档里的 map_*.dat" },
  };

  const BLOCK_PRESETS = [
    {
      name: "全部方块",
      blocks: Array.from({ length: 61 }, (_, i) => [i, 0]),
    },
    {
      name: "地毯",
      blocks: Array.from({ length: 16 }, (_, i) => [13 + i, 1]),
    },
    {
      name: "灰阶",
      blocks: [
        [2, 0], [5, 0], [7, 0], [9, 0], [12, 0], [13, 0], [20, 0], [21, 0], [28, 0], [58, 0],
      ],
    },
    {
      name: "灰阶地毯",
      blocks: [
        [13, 1], [20, 1], [21, 1], [28, 1],
      ],
    },
  ];

  return {
    TOOL_VERSION,
    SUPPORTED_VERSIONS,
    STAIRCASING,
    SUPPORT_MODES,
    DITHER_METHODS,
    CROP_MODES,
    BACKGROUND_MODES,
    OUTPUT_FORMATS,
    BLOCK_PRESETS,
  };
})();
