# MC 地图画生成器

一个完全本地运行、无需联网的 Minecraft 地图画（Map Art）生成工具。上传图片即可一键导出 **Schematic (.nbt)**、**Litematic (.litematic)** 和 **map.dat** 三种格式的文件，支持多张地图拼接的大幅地图画。

## 快速开始

直接双击 `index.html` 即可使用，无需安装任何依赖。

> 想要单个文件版本？在仓库 Release 中下载 `地图画生成器_单文件版.html`，或本地运行 `node build/bundle.js` 重新打包。

## 功能特性

- **两种布局模式**
  - **平铺（地面地图画）**：经典地图画，配合地图使用；可勾选「按方块尺寸」改用任意方块尺寸（1 格 = 1 像素，默认 100×100），不受 128 网格限制
  - **立式（墙面像素画）**：生成一堵 1 格厚的竖墙（图片顶部在最上方），直接观看，尺寸按方块自由设定（默认 100×100），自动切换为固体方块预设并禁用不能上墙的方块
- **三种输出格式，任意组合**
  - `Schematic (.nbt)`：Schematica / Litematica / WorldEdit / Baritone 均可加载
  - `Litematic (.litematic)`：Litematica 模组原生格式
  - `map.dat`：直接替换存档 `data/` 目录下的地图数据，支持透明像素
- **拆分 / 合并可选**：NBT 和 Litematic 均可选择「每张地图一个文件」或「整幅画单文件」
- **默认只生成画面部分**：不包含任何支撑方块；支撑模式（无 / 仅必需方块 / 全部优化 / 双层）和对齐行（noobline）可自由开关
- **高还原度渲染**：完整移植自 [mapartcraft](https://github.com/rebane2001/mapartcraft) 的颜色量化与布局算法
  - 61 种地图色系，每种可单独选择方块（羊毛、地毯、混凝土、玻璃等）
  - 15 种抖动算法：无 / Floyd-Steinberg / Bayer 2×2/4×4/8×8 / Ordered 3×3 / MinAvgErr / Burkes / Sierra-Lite / Stucki / Atkinson / **蓝噪声** / **Yliluoma 有序** / **蓝噪声 · Yliluoma** / **Riemersma（希尔伯特曲线）**
  - 误差扩散类算法支持**蛇形扫描**开关（减少方向性伪影）
  - **孤立像素抑制**：可选清理抖动产生的单格杂点（1/2 遍）
  - 色差公式三档：RGB 欧氏距离 / Lab 色彩空间 / **CIEDE2000 感知色差**
  - 5 种 3D 阶梯模式（平面 / 经典 / 山谷 / 全暗 / 全亮）
- **图片预处理**：亮度 / 对比度 / 饱和度 / 背景色填充，拉伸 / 居中 / 手动裁剪
- **透明背景**（默认开启，仅 PNG 生效）：透明区域不放置方块——墙面镂空、地面地图画透出下方地形、map.dat 输出为透明像素
- **分批计算**：地图数量超过 64×64（4096 张）时自动启用，按**地图列（竖排）**分批、逐批输出 ZIP（文件名连续），内存占用极小；有序类算法（无/Bayer/蓝噪声/Yliluoma）分批结果与一次性计算完全一致，误差扩散类在批次交界处会有极轻微的图案差异（算法特性），可在设置里调整每批数量
- **GPU 加速**（可选，默认关闭）：用 WebGL2 并行预计算 256³ 颜色查找表，颜色匹配变为 O(1) 查表，实测大图提速 15~20 倍、CIEDE2000 提速数百倍；结果与 CPU 逐像素完全一致，不支持 WebGL2 时自动回退
- **游戏版本支持 1.12.2 → 1.21.11**（DataVersion 逐一核验自 Mojang 官方客户端）
- **材料统计**：每种方块用量、组数、潜影盒数量一目了然
- 中文界面，明暗主题，支持拖拽 / 粘贴 / 点击上传

## 使用流程

1. 打开 `index.html`（或单文件版）
2. 上传 / 拖拽 / 粘贴图片
3. 选择布局模式：平铺（地面地图画）或立式（墙面像素画）
4. 设置尺寸、输出格式与参数
5. 在右侧「方块选择」中挑选配色（或直接使用预设；立式模式会自动切换到固体方块预设）
6. 点击底部「生成并下载」，得到 ZIP 压缩包
7. 将压缩包内对应文件夹放入游戏：
   - `Schematic-NBT/` 与 `Litematic/` → `.minecraft/schematics/`
   - `MapData/` → 存档的 `data/` 目录（注意地图 ID 冲突）

## 目录结构

```
├── index.html          主页面
├── css/style.css       样式
├── data/
│   ├── colours.js      Minecraft 61 种地图色数据
│   └── bluenoise.js    64×64 蓝噪声抖动掩模（由 build/bluenoise.js 生成）
├── js/
│   ├── app.js          UI 逻辑
│   ├── generator.js    核心引擎（颜色匹配/抖动/阶梯/布局/文件生成）
│   ├── nbt.js          NBT 读写器
│   ├── zip.js          内置 ZIP 打包器
│   ├── constants.js    常量与版本数据
│   └── pako.min.js     gzip 压缩库（MIT）
├── test/test.js        自动化测试（node test/test.js）
└── build/
    ├── bundle.js       打包单文件版脚本（node build/bundle.js）
    └── bluenoise.js    重新生成蓝噪声掩模（node build/bluenoise.js）
```

## 技术说明

- **颜色匹配**：RGB 欧氏距离或 Lab 色彩空间距离，对 61 色系 × 4 色阶（dark/normal/light/unobtainable）求最近色
- **地图数据**：地图颜色编号 = `4 × mapdatId + 色阶索引`，与游戏 `BlockColors` 一致
- **Litematic 格式**：Version 4，`BlockStates` 为低位优先紧凑位打包、**大端** long 数组（NBT 惯例），经第三方实现交叉验证
- **地图对齐**：地图在游戏中固定对齐 128×128 世界网格，建筑原点应选在网格交点处；开启「包含北侧对齐行」可辅助定位
- 版本 1.20.5+ 的 DataVersion 从 Mojang 官方 client jar 中逐一提取核验

## 致谢

- 颜色数据与核心算法参考 [mapartcraft](https://github.com/rebane2001/mapartcraft)（GPL-3.0）
- 格式验证参考 [Litematica](https://github.com/maruohon/litematica) 与 [malilib](https://github.com/maruohon/malilib) 源码
- [pako](https://github.com/nodeca/pako) 提供 gzip 压缩（MIT）
