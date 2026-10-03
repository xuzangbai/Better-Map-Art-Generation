"use strict";

/* Shared constants for the map art generator.
   Data versions verified from official Mojang client jars (Aug 2026). */

window.MapArtConstants = (() => {
  const TOOL_VERSION = "v1.37";

  /* layout modes: flat floor map art vs. vertical wall pixel art */
  const LAYOUT_MODES = {
    FLAT: { id: "flat", name: "平铺（地面地图画）" },
    WALL: { id: "wall", name: "立式（墙面像素画）" },
  };

  /* display-name patterns for blocks that cannot be placed on a vertical wall face
     (need a block below / are not full solid cubes). Sea Lantern is allowed. */
  const WALL_UNSUPPORTED_PATTERNS = [
    "carpet", "pressure plate", "slab", "candle", "snow layer", "water", "lava",
    "iron bars", "cobweb", "glow lichen", "pointed dripstone", "trapdoor", "brewing stand",
    "torch", "rail", "button", "lever", "door", "sign", "banner", "vine", "kelp", "seagrass",
    "coral fan", "roots", "sprouts", "berries", "propagule", "petals", "dripleaf",
    "spore blossom", "frogspawn", "sculk vein", "sugar cane", "wheat", "carrots", "potatoes",
    "beetroots", "cactus", "bamboo shoot", "end rod", "lightning rod", "chain", "pot",
    "skull", "head", "bed", "cauldron", "anvil", "campfire", "flower", "sapling",
  ];

  function isWallUnsupported(displayName) {
    const lc = String(displayName || "").toLowerCase();
    if (lc.includes("sea lantern")) return false;
    return WALL_UNSUPPORTED_PATTERNS.some((p) => lc.includes(p));
  }

  /* recursive Bayer threshold matrix (1..n*n), n a power of two */
  function bayerMatrix(n) {
    if (n === 1) return [[0]];
    const half = bayerMatrix(n / 2);
    const h = n / 2;
    const out = [];
    for (let y = 0; y < n; y++) out.push(new Array(n));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < h; x++) {
        const v = half[y][x];
        out[y][x] = 4 * v;
        out[y][x + h] = 4 * v + 2;
        out[y + h][x] = 4 * v + 3;
        out[y + h][x + h] = 4 * v + 1;
      }
    }
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[y][x] += 1;
    return out;
  }

  /* decode the generated 64x64 blue noise mask (data/bluenoise.js) */
  let blueNoiseMask = null;
  function getBlueNoiseMask() {
    if (blueNoiseMask) return blueNoiseMask;
    const raw = typeof window !== "undefined" ? window.BLUE_NOISE_64 : null;
    if (!raw) return null;
    const bin = atob(raw.data);
    const size = raw.size;
    const matrix = [];
    for (let y = 0; y < size; y++) {
      const row = new Array(size);
      for (let x = 0; x < size; x++) row[x] = bin.charCodeAt(y * size + x);
      matrix.push(row);
    }
    blueNoiseMask = { size, matrix };
    return blueNoiseMask;
  }
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
      levels: 16,
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
      levels: 4,
      ditherMatrix: [
        [1, 3],
        [4, 2],
      ],
    },
    Ordered33: {
      id: 4,
      name: "Ordered (3x3)",
      levels: 9,
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
    Bayer88: {
      id: 10,
      name: "Bayer (8x8)",
      levels: 64,
      ditherMatrix: bayerMatrix(8),
    },
    BlueNoise: {
      id: 11,
      name: "蓝噪声 (Blue Noise)",
      levels: 256,
      blueNoise: true,
    },
    Yliluoma: {
      id: 12,
      name: "Yliluoma 有序",
      yliluoma: true,
    },
    Riemersma: {
      id: 13,
      name: "Riemersma（希尔伯特曲线）",
      riemersma: true,
    },
    BlueNoiseYliluoma: {
      id: 14,
      name: "蓝噪声 · Yliluoma",
      yliluoma: true,
      blueNoise: true,
    },
  };

  /* error-diffusion dither ids (serpentine scanning applies to these) */
  const ERROR_DIFFUSION_IDS = [
    DITHER_METHODS.FloydSteinberg.id,
    DITHER_METHODS.MinAvgErr.id,
    DITHER_METHODS.Burkes.id,
    DITHER_METHODS.SierraLite.id,
    DITHER_METHODS.Stucki.id,
    DITHER_METHODS.Atkinson.id,
  ];

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
    {
      name: "仅陶瓦",
      blocks: Array.from({ length: 16 }, (_, i) => [35 + i, 0]),
    },
    {
      name: "陶瓦+羊毛",
      blocks: Array.from({ length: 16 }, (_, i) => [35 + i, 0]).concat(Array.from({ length: 16 }, (_, i) => [13 + i, 0])),
    },
    {
      name: "综合材料",
      desc: "陶瓦 + 混凝土 + 羊毛 + 木板 + 原木（混凝土与羊毛同色系时取混凝土）",
      blocks: [
        [1, 4], [2, 1], [8, 1], [9, 12], [11, 1], [12, 0],
        [13, 3], [14, 13], [15, 3], [16, 3], [17, 3], [18, 3], [19, 3], [20, 3], [21, 3], [22, 3],
        [23, 3], [24, 3], [25, 3], [26, 3], [27, 3], [28, 3], [33, 1],
        [35, 0], [36, 0], [37, 0], [38, 0], [39, 0], [40, 0], [41, 0], [42, 0], [43, 0], [44, 0],
        [45, 0], [46, 0], [47, 0], [48, 0], [49, 0], [50, 0], [52, 2], [53, 0], [55, 2], [56, 0],
      ],
    },
    {
      name: "综合·羊毛",
      desc: "陶瓦 + 羊毛 + 木板 + 原木（羊毛优先，同色系不用混凝土）",
      blocks: [
        [1, 4], [2, 1], [8, 1], [9, 12], [11, 1], [12, 0],
        [13, 0], [14, 0], [15, 0], [16, 0], [17, 0], [18, 0], [19, 0], [20, 0], [21, 0], [22, 0],
        [23, 0], [24, 0], [25, 0], [26, 0], [27, 0], [28, 0], [33, 1],
        [35, 0], [36, 0], [37, 0], [38, 0], [39, 0], [40, 0], [41, 0], [42, 0], [43, 0], [44, 0],
        [45, 0], [46, 0], [47, 0], [48, 0], [49, 0], [50, 0], [52, 2], [53, 0], [55, 2], [56, 0],
      ],
    },
    {
      name: "黑曜石",
      id: "obsidian",
      desc: "仅黑色色阶，方块为黑曜石（黑曜石与哭泣黑曜石同色阶，可用「哭泣黑曜石」预设切换）",
      blocks: [[28, 7]],
    },
    {
      name: "哭泣黑曜石",
      id: "cryingObsidian",
      desc: "仅黑色色阶，方块为哭泣黑曜石（与黑曜石同色阶）",
      blocks: [[28, 8]],
    },
  ];

  /* text mode font choices (rendered on a canvas) */
  const TEXT_FONTS = [
    { id: "sans", name: "黑体 / 无衬线", css: '"Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif' },
    { id: "serif", name: "宋体 / 衬线", css: '"SimSun", "Songti SC", "STSong", serif' },
    { id: "kai", name: "楷体", css: '"KaiTi", "Kaiti SC", "STKaiti", serif' },
    { id: "hei", name: "黑体 SimHei", css: '"SimHei", "Heiti SC", "Microsoft YaHei", sans-serif' },
    { id: "mono", name: "等宽", css: '"Cascadia Mono", "Consolas", "Courier New", monospace' },
    { id: "impact", name: "粗标题 Impact", css: '"Impact", "Arial Black", "Microsoft YaHei", sans-serif' },
  ];

  return {
    TOOL_VERSION,
    LAYOUT_MODES,
    isWallUnsupported,
    bayerMatrix,
    getBlueNoiseMask,
    ERROR_DIFFUSION_IDS,
    SUPPORTED_VERSIONS,
    STAIRCASING,
    SUPPORT_MODES,
    DITHER_METHODS,
    CROP_MODES,
    BACKGROUND_MODES,
    OUTPUT_FORMATS,
    BLOCK_PRESETS,
    TEXT_FONTS,
  };
})();
