"use strict";

/* ===== MC MapArt Generator - UI logic ===== */

(function () {
  const C = window.COLOURS_JSON;
  const K = window.MapArtConstants;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

  const state = {
    image: null, // HTMLImageElement
    imageName: "",
    imageSize: 0,
    layoutMode: "flat", // "flat" | "wall"
    wallW: 100,
    wallH: 100,
    batchSize: 1000, // maps per batch step in batch mode (adjustable)
    flatBlocksBackup: null, // selectedBlocks saved when entering wall mode
    flatDitherBackup: null, // dither method saved when entering wall mode
    flatNbtModeBackup: null, // NBT file mode saved when entering wall mode
    flatLitematicModeBackup: null, // litematic file mode saved when entering wall mode
    solidPreset: null, // computed per-colourSet solid block preset
    mapsX: 1,
    mapsY: 1,
    blockSizeMode: false, // flat mode: size input is in blocks instead of maps
    blockW: 100,
    blockH: 100,
    flatMapGridBackup: null, // mapsX/mapsY saved when enabling block-size mode
    version: K.SUPPORTED_VERSIONS[K.SUPPORTED_VERSIONS.length - 1].MCVersion,
    formats: { nbt: true, litematic: true, mapdat: false },
    zipMode: "combined",
    nbtMode: "split",
    litematicMode: "split",
    cropMode: K.CROP_MODES.CENTER.id,
    cropZoom: 10,
    cropX: 50,
    cropY: 50,
    preprocEnabled: false,
    brightness: 100,
    contrast: 100,
    saturation: 100,
    bgMode: K.BACKGROUND_MODES.OFF.id,
    bgColor: "#151515",
    showGrid: true,
    showGridLabels: true, // draw map_x_y coordinates on the preview grid
    showHoverInfo: true, // show the pixel info tooltip on hover
    staircase: K.STAIRCASING.OFF.id,
    dither: K.DITHER_METHODS.FloydSteinberg.id,
    serpentine: false,
    diffusionStrength: 100, // error-diffusion strength in percent (0..200)
    colourMetric: "lab",
    gpuAccel: false,
    isolatedCleanup: false,
    isolatedPasses: 1,
    mapdatUnobtainable: false,
    transparentBg: true, // keep PNG transparent areas empty (default on, PNG only)
    transparencyThreshold: 128,
    mapdatUseId: true,
    mapdatIdStart: 0,
    exportName: "", // custom export base name ("" = follow the uploaded image name)
    supportMode: K.SUPPORT_MODES.NONE.id,
    supportBlock: "cobblestone",
    includeNoobline: false,
    selectedBlocks: {}, // colourSetId -> blockId ("-1" = off)
    viewMode: "result",

    // caches
    gen: null,
    genSignature: "",
    quantized: null, // {pixels, maps}
    layouts: null, // maps[my][mx].coloursLayout
    previewToken: 0,
    generating: false,
    blockSearch: "",
    batch: null, // active batch calculation state
    tipTimer: null, // preview tooltip auto-hide timer (touch)
    textMode: false, // generate the source from typed text instead of an image
    textInput: "文字",
    textFont: "sans",
    textSize: 64, // text height in pixels (= blocks)
    textW: 128, // auto canvas size for the text (grows with the text)
    textH: 128,
    textKey: "", // key of the currently rendered text image
    textImageBackup: null, // image restored when leaving text mode
    textBlocksBackup: null, // block selection restored when leaving text mode
    textNbtModeBackup: null, // nbt file mode restored when leaving text mode
    textLitematicModeBackup: null, // litematic file mode restored when leaving text mode
  };

  /* ---------------- init ---------------- */

  function init() {
    // populate selects
    const verSel = $("mcVersion");
    for (const v of K.SUPPORTED_VERSIONS) {
      const opt = document.createElement("option");
      opt.value = v.MCVersion;
      opt.textContent = v.MCVersion + " (DataVersion " + v.NBTVersion + ")";
      verSel.appendChild(opt);
    }
    verSel.value = state.version;

    const cropSel = $("cropMode");
    for (const m of Object.values(K.CROP_MODES)) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      cropSel.appendChild(opt);
    }
    cropSel.value = state.cropMode;

    const stairSel = $("staircase");
    for (const m of Object.values(K.STAIRCASING)) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      stairSel.appendChild(opt);
    }
    stairSel.value = state.staircase;

    const dithSel = $("dither");
    for (const m of Object.values(K.DITHER_METHODS)) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      dithSel.appendChild(opt);
    }
    dithSel.value = state.dither;

    const supSel = $("supportMode");
    for (const m of Object.values(K.SUPPORT_MODES)) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      supSel.appendChild(opt);
    }
    supSel.value = state.supportMode;

    const bgSel = $("bgMode");
    for (const m of Object.values(K.BACKGROUND_MODES)) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      bgSel.appendChild(opt);
    }
    bgSel.value = state.bgMode;

    // solid block preset (computed from the colour data; used by wall mode)
    state.solidPreset = computeSolidPreset();

    // default block selection: "Everything" preset
    applyPreset(0);
    renderPalette();
    updatePaletteCount();

    // events
    bindEvents();
    // sync checkbox/radio UI with initial state
    $("showGrid").checked = state.showGrid;
    $("showGridLabels").checked = state.showGridLabels;
    $("showHoverInfo").checked = state.showHoverInfo;
    $("mapdatUseId").checked = state.mapdatUseId;
    $("transparentBg").checked = state.transparentBg;
    $("transparencyThresholdField").hidden = !state.transparentBg;
    $("colourMetric").value = state.colourMetric;
    $("batchSize").value = state.batchSize;
    updateBatchSizeVisibility();
    $("blockSizeToggle").checked = state.blockSizeMode;
    $("blockW").value = state.blockW;
    $("blockH").value = state.blockH;
    syncBlockSizeUI();
    $("isolatedCleanup").checked = state.isolatedCleanup;
    $("isolatedPassesField").hidden = !state.isolatedCleanup;
    // GPU acceleration availability
    if (!window.GLLut || !window.GLLut.isSupported()) {
      state.gpuAccel = false;
      $("gpuAccel").checked = false;
      $("gpuAccel").disabled = true;
      $("gpuAccelHint").textContent = "当前浏览器不支持 WebGL2，已自动使用 CPU 计算";
    } else {
      $("gpuAccel").checked = state.gpuAccel;
    }
    updateSerpentineVisibility();
    $("diffusionStrength").value = state.diffusionStrength;
    updateDiffusionVisibility();
    // text mode
    const fontSel = $("textFont");
    for (const f of K.TEXT_FONTS) {
      const opt = document.createElement("option");
      opt.value = f.id;
      opt.textContent = f.name;
      fontSel.appendChild(opt);
    }
    fontSel.value = state.textFont;
    $("textInput").value = state.textInput;
    $("textSize").value = state.textSize;
    $("textSizeVal").textContent = state.textSize;
    $("textLayout").value = state.layoutMode;
    $("textMode").checked = state.textMode;
    updateTextModeUI();
    $("toolBadge").textContent = "工具 " + K.TOOL_VERSION;
    $("exportName").value = state.exportName;
    updateSizeHint();
    updateGenUI();
    updateMapdatOptsVisibility();

    loadSampleImage();
  }

  function bindEvents() {
    const dz = $("dropzone");
    dz.addEventListener("click", () => $("fileInput").click());
    dz.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") $("fileInput").click();
    });
    dz.addEventListener("dragover", (e) => {
      e.preventDefault();
      dz.classList.add("dragover");
    });
    dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
    dz.addEventListener("drop", (e) => {
      e.preventDefault();
      dz.classList.remove("dragover");
      const files = e.dataTransfer.files;
      if (files.length) readFile(files[0]);
    });
    $("fileInput").addEventListener("change", (e) => {
      if (e.target.files.length) readFile(e.target.files[0]);
      e.target.value = "";
    });
    document.addEventListener("paste", (e) => {
      const files = e.clipboardData && e.clipboardData.files;
      if (files && files.length && files[0].type.startsWith("image/")) readFile(files[0]);
    });
    $("btnRemoveImage").addEventListener("click", (e) => {
      e.stopPropagation();
      clearImage();
    });
    $("btnSample").addEventListener("click", loadSampleImage);

    // text mode
    $("textMode").addEventListener("change", (e) => setTextMode(e.target.checked));
    $("textInput").addEventListener("input", (e) => {
      state.textInput = e.target.value;
      schedulePreview();
    });
    $("textFont").addEventListener("change", (e) => {
      state.textFont = e.target.value;
      schedulePreview();
    });
    bindSlider("textSize", "textSizeVal", (v) => v, (v) => (state.textSize = v));
    $("textLayout").addEventListener("change", (e) => {
      $("layoutMode").value = e.target.value;
      switchLayoutMode(e.target.value);
    });
    $("qqBadge").addEventListener("click", () => {
      const group = "249694605";
      const done = () => toast("已复制 QQ 群号：" + group + "（BUG 反馈群）");
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(group).then(done).catch(() => toast("BUG 反馈 QQ 群：" + group));
      } else {
        toast("BUG 反馈 QQ 群：" + group);
      }
    });

    // number inputs
    $("mapsX").addEventListener("change", (e) => onMapSizeChange("mapsX", e.target));
    $("mapsY").addEventListener("change", (e) => onMapSizeChange("mapsY", e.target));
    $("blockSizeToggle").addEventListener("change", (e) => {
      state.blockSizeMode = e.target.checked;
      if (state.blockSizeMode) {
        state.flatMapGridBackup = { x: state.mapsX, y: state.mapsY };
        syncBlockCells();
      } else if (state.flatMapGridBackup) {
        state.mapsX = state.flatMapGridBackup.x;
        state.mapsY = state.flatMapGridBackup.y;
        state.flatMapGridBackup = null;
        $("mapsX").value = state.mapsX;
        $("mapsY").value = state.mapsY;
      }
      syncBlockSizeUI();
      resetBatch();
      updateSizeHint();
      updateBatchSizeVisibility();
      schedulePreview();
    });
    $("blockW").addEventListener("change", (e) => onBlockSizeChange("blockW", e.target));
    $("blockH").addEventListener("change", (e) => onBlockSizeChange("blockH", e.target));
    $("wallW").addEventListener("change", (e) => {
      state.wallW = clampInt(e.target.value, 1, 512);
      e.target.value = state.wallW;
      updateSizeHint();
      schedulePreview();
    });
    $("wallH").addEventListener("change", (e) => {
      state.wallH = clampInt(e.target.value, 1, 512);
      e.target.value = state.wallH;
      updateSizeHint();
      schedulePreview();
    });
    $("batchSize").addEventListener("change", (e) => {
      state.batchSize = clampInt(e.target.value, 1, 1000000);
      e.target.value = state.batchSize;
      resetBatch();
      updateBatchSizeVisibility();
    });
    $("layoutMode").addEventListener("change", (e) => {
      switchLayoutMode(e.target.value);
    });

    // selects
    $("mcVersion").addEventListener("change", (e) => {
      state.version = e.target.value;
      $("versionBadge").textContent = "版本 " + state.version;
      schedulePreview();
    });
    $("cropMode").addEventListener("change", (e) => {
      state.cropMode = parseInt(e.target.value, 10);
      $("cropManual").hidden = state.cropMode !== K.CROP_MODES.MANUAL.id;
      schedulePreview();
    });
    $("staircase").addEventListener("change", (e) => {
      state.staircase = parseInt(e.target.value, 10);
      schedulePreview();
    });
    $("dither").addEventListener("change", (e) => {
      state.dither = parseInt(e.target.value, 10);
      updateSerpentineVisibility();
      updateDiffusionVisibility();
      schedulePreview();
    });
    $("supportMode").addEventListener("change", (e) => {
      state.supportMode = parseInt(e.target.value, 10);
      schedulePreview();
    });
    $("bgMode").addEventListener("change", (e) => {
      state.bgMode = parseInt(e.target.value, 10);
      $("bgColorField").hidden = state.bgMode !== K.BACKGROUND_MODES.CUSTOM.id;
      schedulePreview();
    });

    // sliders
    bindSlider("cropZoom", "cropZoomVal", (v) => (v / 10).toFixed(1) + "×", (v) => (state.cropZoom = v));
    bindSlider("cropX", "cropXVal", (v) => v + "%", (v) => (state.cropX = v));
    bindSlider("cropY", "cropYVal", (v) => v + "%", (v) => (state.cropY = v));
    bindSlider("brightness", "brightnessVal", (v) => v + "%", (v) => (state.brightness = v));
    bindSlider("contrast", "contrastVal", (v) => v + "%", (v) => (state.contrast = v));
    bindSlider("saturation", "saturationVal", (v) => v + "%", (v) => (state.saturation = v));
    bindSlider("transparencyThreshold", "transparencyThresholdVal", (v) => v, (v) => (state.transparencyThreshold = v));
    bindSlider("diffusionStrength", "diffusionVal", (v) => v + "%", (v) => (state.diffusionStrength = v));

    bindCheck("serpentine", (v) => (state.serpentine = v));

    // checkboxes
    bindCheck("preprocEnabled", (v) => (state.preprocEnabled = v));
    bindCheck("gpuAccel", (v) => (state.gpuAccel = v));
    bindCheck("isolatedCleanup", (v) => {
      state.isolatedCleanup = v;
      $("isolatedPassesField").hidden = !v;
    });
    $("colourMetric").addEventListener("change", (e) => {
      state.colourMetric = e.target.value;
      schedulePreview();
    });
    $("isolatedPasses").addEventListener("change", (e) => {
      state.isolatedPasses = parseInt(e.target.value, 10);
      schedulePreview();
    });
    bindCheck("transparentBg", (v) => {
      state.transparentBg = v;
      $("transparencyThresholdField").hidden = !v;
    });
    bindCheck("mapdatUnobtainable", (v) => (state.mapdatUnobtainable = v));
    bindCheck("mapdatUseId", (v) => {
      state.mapdatUseId = v;
      $("mapdatIdStartField").hidden = !v;
    });
    bindCheck("includeNoobline", (v) => (state.includeNoobline = v));
    bindCheck("showGrid", (v) => (state.showGrid = v));
    $("showGridLabels").addEventListener("change", (e) => {
      state.showGridLabels = e.target.checked;
      drawPreview();
    });
    $("showHoverInfo").addEventListener("change", (e) => {
      state.showHoverInfo = e.target.checked;
      if (!state.showHoverInfo) hidePreviewTip();
    });

    $("bgColor").addEventListener("input", (e) => {
      state.bgColor = e.target.value;
      schedulePreview();
    });
    $("exportName").addEventListener("input", (e) => {
      state.exportName = e.target.value;
      updateGenName();
    });
    $("exportName").addEventListener("change", (e) => {
      const clean = sanitizeFileName(e.target.value);
      state.exportName = clean;
      e.target.value = clean;
      updateGenName();
    });
    $("supportBlock").addEventListener("change", (e) => {
      const v = e.target.value.trim().toLowerCase().replace(/^minecraft:/, "").replace(/[^a-z0-9_]/g, "");
      state.supportBlock = v || "cobblestone";
      e.target.value = state.supportBlock;
      schedulePreview();
    });
    $("mapdatIdStart").addEventListener("change", (e) => {
      state.mapdatIdStart = clampInt(e.target.value, 0, 65535);
      e.target.value = state.mapdatIdStart;
      $("mapdatIdStartVal").textContent = state.mapdatIdStart;
    });

    // format checkboxes
    $("fmtNbt").addEventListener("change", (e) => {
      state.formats.nbt = e.target.checked;
      $("nbtModeField").style.display = e.target.checked ? "" : "none";
      updateGenUI();
    });
    $("fmtLitematic").addEventListener("change", (e) => {
      state.formats.litematic = e.target.checked;
      $("litematicModeField").style.display = e.target.checked ? "" : "none";
      updateGenUI();
    });
    $("nbtMode").addEventListener("change", (e) => {
      state.nbtMode = e.target.value;
    });
    $("fmtMapdat").addEventListener("change", (e) => {
      state.formats.mapdat = e.target.checked;
      updateMapdatOptsVisibility();
      updateGenUI();
      schedulePreview();
    });
    $("litematicMode").addEventListener("change", (e) => {
      state.litematicMode = e.target.value;
    });
    for (const r of document.querySelectorAll('input[name="zipmode"]')) {
      r.addEventListener("change", () => {
        if (r.checked) state.zipMode = r.value;
      });
    }

    // view toggle
    for (const btn of document.querySelectorAll("#viewSeg .seg-btn")) {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#viewSeg .seg-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.viewMode = btn.dataset.view;
        drawPreview();
      });
    }

    // palette
    const presetRow = $("presetRow");
    for (let i = 0; i < K.BLOCK_PRESETS.length; i++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-small" + (i === 0 ? " btn-primary" : "");
      btn.dataset.preset = String(i);
      btn.textContent = K.BLOCK_PRESETS[i].name;
      if (K.BLOCK_PRESETS[i].desc) btn.title = K.BLOCK_PRESETS[i].desc + "（" + K.BLOCK_PRESETS[i].blocks.length + " 色）";
      presetRow.appendChild(btn);
    }
    const solidBtn = document.createElement("button");
    solidBtn.type = "button";
    solidBtn.className = "btn btn-small";
    solidBtn.dataset.preset = "solid";
    solidBtn.textContent = "固体方块";
    presetRow.appendChild(solidBtn);
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "btn btn-small btn-danger";
    clearBtn.id = "btnClearBlocks";
    clearBtn.textContent = "全部清除";
    presetRow.appendChild(clearBtn);
    presetRow.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-preset]");
      if (btn) {
        if (btn.dataset.preset === "solid") {
          applySolidPreset();
        } else {
          applyPreset(parseInt(btn.dataset.preset, 10));
        }
        renderPalette();
        updatePaletteCount();
        schedulePreview();
      }
    });
    $("btnClearBlocks").addEventListener("click", () => {
      for (const key of Object.keys(state.selectedBlocks)) state.selectedBlocks[key] = "-1";
      renderPalette();
      updatePaletteCount();
      schedulePreview();
    });
    $("blockSearch").addEventListener("input", (e) => {
      state.blockSearch = e.target.value.trim().toLowerCase();
      renderPalette();
    });

    $("btnGenerate").addEventListener("click", generate);
    $("btnCancelBatch").addEventListener("click", () => {
      resetBatch();
      toast("已取消分批计算");
    });

    // preview hover tooltip (pixel colour / block info)
    const previewEl = $("preview");
    previewEl.addEventListener("mousemove", showPreviewTip);
    previewEl.addEventListener("mouseleave", hidePreviewTip);
    previewEl.addEventListener("click", (e) => {
      // touch devices: tapping shows the info for a moment
      showPreviewTip(e);
      clearTimeout(state.tipTimer);
      state.tipTimer = setTimeout(hidePreviewTip, 2500);
    });

    // keep the preview fitted when the window size changes
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(drawPreview, 120);
    });
  }

  function bindSlider(inputId, valId, format, setter) {
    const input = $(inputId);
    input.addEventListener("input", () => {
      const v = parseInt(input.value, 10);
      setter(v);
      $(valId).textContent = format(v);
      schedulePreview();
    });
  }

  function bindCheck(id, setter) {
    $(id).addEventListener("change", (e) => {
      setter(e.target.checked);
      schedulePreview();
    });
  }

  function clampInt(v, min, max) {
    v = parseInt(v, 10);
    if (isNaN(v)) v = min;
    return Math.max(min, Math.min(max, v));
  }

  /* map grid size input: no hard limit; sizes above 64x64 automatically use batch calculation */
  const BATCH_THRESHOLD_MAPS = 4096; // 64 x 64
  function onMapSizeChange(dim, inputEl) {
    const val = clampInt(inputEl.value, 1, Number.MAX_SAFE_INTEGER);
    state[dim] = val;
    inputEl.value = val;
    resetBatch();
    updateSizeHint();
    updateBatchSizeVisibility();
    schedulePreview();
  }

  function updateBatchSizeVisibility() {
    $("batchSizeField").hidden = !isBatchMode();
    if (isBatchMode()) {
      const cols = Math.max(1, Math.ceil(state.batchSize / state.mapsY));
      const maps = Math.min(cols * state.mapsY, state.mapsX * state.mapsY);
      $("batchSizeHint").textContent = `每批约 ${cols} 列地图（竖排，约 ${maps.toLocaleString()} 张），地图总数超过 4096 张时自动分批`;
    }
  }

  /* ---------------- block-size mode (flat layout, size given in blocks) ---------------- */

  function isBlockSizeActive() {
    return state.blockSizeMode && state.layoutMode !== "wall";
  }

  function onBlockSizeChange(dim, inputEl) {
    const val = clampInt(inputEl.value, 1, 4096);
    state[dim] = val;
    inputEl.value = val;
    syncBlockCells();
    resetBatch();
    updateSizeHint();
    updateBatchSizeVisibility();
    schedulePreview();
  }

  // the artwork spans ceil(blockW/128) x ceil(blockH/128) map-sized cells
  function syncBlockCells() {
    if (state.layoutMode === "wall") return;
    state.mapsX = Math.max(1, Math.ceil(state.blockW / 128));
    state.mapsY = Math.max(1, Math.ceil(state.blockH / 128));
  }

  function syncBlockSizeUI() {
    const on = isBlockSizeActive();
    $("flatSizeLabel").textContent = on ? "画布尺寸（方块，1 格 = 1 像素）" : "地图尺寸（每张 128×128 像素）";
    $("mapSizeRow").hidden = on;
    $("sizeHint").hidden = on;
    $("blockSizeRow").hidden = !on;
    $("blockSizeHint").hidden = !on;
    const hideMapdat = state.layoutMode === "wall" || state.blockSizeMode || state.textMode;
    $("fmtMapdatLabel").style.display = hideMapdat ? "none" : "";
    if (hideMapdat && state.formats.mapdat) {
      state.formats.mapdat = false;
      $("fmtMapdat").checked = false;
    }
    updateMapdatOptsVisibility();
  }

  /* ---------------- text mode (type text instead of uploading an image) ---------------- */

  function isTextMode() {
    return state.textMode;
  }

  function setTextMode(on) {
    if (on === state.textMode) return;
    state.textMode = on;
    if (on) {
      state.textImageBackup = { img: state.image, name: state.imageName, size: state.imageSize };
      state.textBlocksBackup = Object.assign({}, state.selectedBlocks);
      applyPreset(presetIndexById("obsidian")); // 黑曜石 preset
      renderPalette();
      updatePaletteCount();
      // text mode defaults to whole-image single files (no map grid split)
      state.textNbtModeBackup = state.nbtMode;
      state.textLitematicModeBackup = state.litematicMode;
      state.nbtMode = "merged";
      state.litematicMode = "merged";
      $("nbtMode").value = "merged";
      $("litematicMode").value = "merged";
      state.textKey = "";
    } else {
      if (state.textImageBackup) {
        state.image = state.textImageBackup.img;
        state.imageName = state.textImageBackup.name;
        state.imageSize = state.textImageBackup.size;
        state.textImageBackup = null;
      }
      if (state.textBlocksBackup) {
        state.selectedBlocks = state.textBlocksBackup;
        state.textBlocksBackup = null;
        renderPalette();
        updatePaletteCount();
      }
      if (state.textNbtModeBackup !== null) {
        state.nbtMode = state.textNbtModeBackup;
        state.textNbtModeBackup = null;
        $("nbtMode").value = state.nbtMode;
      }
      if (state.textLitematicModeBackup !== null) {
        state.litematicMode = state.textLitematicModeBackup;
        state.textLitematicModeBackup = null;
        $("litematicMode").value = state.litematicMode;
      }
      state.textKey = "";
      state.quantized = null;
      state.layouts = null;
      state.genSignature = "";
      if (state.image) {
        $("dzInner").hidden = true;
        $("dzThumb").hidden = false;
        $("dzName").textContent = state.imageName;
        $("dzSize").textContent = state.imageSize ? formatBytes(state.imageSize) : "";
        $("dzImg").src = state.image.src;
      } else {
        $("dzInner").hidden = false;
        $("dzThumb").hidden = true;
        $("canvasEmpty").hidden = false;
        $("previewInfo").textContent = "等待图片…";
        $("previewSize").textContent = "";
        renderStats(null);
      }
      updateGenName();
    }
    updateTextModeUI();
    syncBlockSizeUI();
    updateGenUI();
    schedulePreview();
  }

  function updateTextModeUI() {
    const on = state.textMode;
    $("textPanel").hidden = !on;
    $("dropzone").hidden = on;
    $("sampleRow").hidden = on;
    $("textLayout").value = state.layoutMode;
    updateSizeFieldsVisibility();
  }

  // the size inputs are hidden in text mode (the canvas follows the text)
  function updateSizeFieldsVisibility() {
    const isWall = state.layoutMode === "wall";
    $("flatSizeField").hidden = isWall || state.textMode;
    $("wallSizeField").hidden = !isWall || state.textMode;
  }

  // measures the text at the current font/size (the canvas auto-grows to fit it)
  function measureTextSize() {
    const size = Math.max(1, Math.round(state.textSize));
    const font = (K.TEXT_FONTS.find((f) => f.id === state.textFont) || K.TEXT_FONTS[0]).css;
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = `${size}px ${font}`;
    const lines = String(state.textInput || "").split("\n");
    let maxW = 0;
    for (const ln of lines) if (ln) maxW = Math.max(maxW, ctx.measureText(ln).width);
    const lineH = Math.round(size * 1.18);
    const pad = Math.max(1, Math.round(size * 0.06));
    return {
      w: Math.max(1, Math.ceil(maxW) + pad * 2),
      h: Math.max(1, lineH * lines.length + pad * 2),
      size,
      lineH,
    };
  }

  // text mode: the map / block / wall sizes follow the measured text size
  function applyTextSizeToTargets(m) {
    const MAX = 4096;
    if (state.layoutMode === "wall") {
      state.wallW = Math.min(MAX, m.w);
      state.wallH = Math.min(MAX, m.h);
      $("wallW").value = state.wallW;
      $("wallH").value = state.wallH;
    } else if (state.blockSizeMode) {
      state.blockW = Math.min(MAX, m.w);
      state.blockH = Math.min(MAX, m.h);
      $("blockW").value = state.blockW;
      $("blockH").value = state.blockH;
      syncBlockCells();
    } else {
      state.mapsX = Math.max(1, Math.ceil(m.w / 128));
      state.mapsY = Math.max(1, Math.ceil(m.h / 128));
      $("mapsX").value = state.mapsX;
      $("mapsY").value = state.mapsY;
    }
    updateSizeHint();
    updateBatchSizeVisibility();
  }

  // renders the current text into an image and uses it as the source image
  async function syncTextImage() {
    if (!state.textMode) return;
    const key = [state.textInput, state.textFont, state.textSize, state.layoutMode].join("\u0001");
    if (key === state.textKey && state.image) return;
    const m = measureTextSize();
    state.textW = m.w;
    state.textH = m.h;
    applyTextSizeToTargets(m);
    const canvas = document.createElement("canvas");
    canvas.width = m.w;
    canvas.height = m.h;
    const ctx = canvas.getContext("2d");
    const font = (K.TEXT_FONTS.find((f) => f.id === state.textFont) || K.TEXT_FONTS[0]).css;
    ctx.font = `${m.size}px ${font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ffffff";
    const lines = String(state.textInput || "").split("\n");
    const startY = m.h / 2 - (m.lineH * lines.length) / 2 + m.lineH / 2;
    for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], m.w / 2, startY + i * m.lineH);
    const hint = $("textSizeHint");
    if (hint) {
      let text = `文字画布 ${m.w} × ${m.h} 格（自动适配文字大小）`;
      if (state.layoutMode !== "wall" && !state.blockSizeMode) text += `，占用地图 ${state.mapsX} × ${state.mapsY} 张`;
      hint.textContent = text;
    }
    const url = canvas.toDataURL("image/png");
    const firstLine = lines.find((l) => l.trim()) || "文字";
    const name = (sanitizeFileName(firstLine).slice(0, 20) || "文字") + ".png";
    await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        state.image = img;
        state.imageName = name;
        state.imageSize = 0;
        state.textKey = key;
        $("dzImg").src = url;
        $("dzInner").hidden = true;
        $("dzThumb").hidden = false;
        $("dzName").textContent = name;
        $("dzSize").textContent = "";
        updateGenName();
        resolve();
      };
      img.onerror = () => reject(new Error("文字图片生成失败"));
      img.src = url;
    });
  }

  /* ---------------- image loading ---------------- */

  function readFile(file) {
    if (!file.type.startsWith("image/")) {
      toast("请选择图片文件", true);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      loadImageFromDataURL(reader.result, file.name, file.size);
    };
    reader.readAsDataURL(file);
  }

  function loadImageFromDataURL(dataUrl, name, size) {
    const img = new Image();
    img.onload = () => {
      state.image = img;
      state.imageName = name || "mapart";
      state.imageSize = size || 0;
      const thumb = $("dzImg");
      thumb.src = dataUrl;
      $("dzInner").hidden = true;
      $("dzThumb").hidden = false;
      $("dzName").textContent = name || "图片";
      $("dzSize").textContent = size ? formatBytes(size) : "";
      updateGenName();
      schedulePreview();
    };
    img.onerror = () => toast("图片加载失败", true);
    img.src = dataUrl;
  }

  function clearImage() {
    state.image = null;
    state.imageName = "";
    state.quantized = null;
    state.layouts = null;
    state.gen = null;
    state.genSignature = "";
    $("dzInner").hidden = false;
    $("dzThumb").hidden = true;
    $("canvasEmpty").hidden = false;
    $("previewInfo").textContent = "等待图片…";
    $("previewSize").textContent = "";
    updateGenName();
    renderStats(null);
  }

  function loadSampleImage() {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext("2d");
    // sky gradient
    const sky = ctx.createLinearGradient(0, 0, 0, 300);
    sky.addColorStop(0, "#4a9eff");
    sky.addColorStop(0.6, "#8fd0ff");
    sky.addColorStop(1, "#ffe9b8");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, 512, 360);
    // sun
    ctx.fillStyle = "#fff7c4";
    ctx.beginPath();
    ctx.arc(380, 90, 42, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,247,196,0.35)";
    ctx.beginPath();
    ctx.arc(380, 90, 62, 0, Math.PI * 2);
    ctx.fill();
    // clouds
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    cloud(ctx, 90, 70, 2);
    cloud(ctx, 240, 140, 1.4);
    // mountains
    ctx.fillStyle = "#5e7f5e";
    ctx.beginPath();
    ctx.moveTo(0, 360);
    ctx.lineTo(80, 240);
    ctx.lineTo(150, 300);
    ctx.lineTo(230, 200);
    ctx.lineTo(330, 310);
    ctx.lineTo(420, 250);
    ctx.lineTo(512, 330);
    ctx.lineTo(512, 360);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(230, 200);
    ctx.lineTo(262, 232);
    ctx.lineTo(258, 236);
    ctx.lineTo(230, 214);
    ctx.lineTo(240, 226);
    ctx.lineTo(222, 230);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#415f41";
    ctx.fillRect(0, 330, 512, 40);
    // water
    const water = ctx.createLinearGradient(0, 360, 0, 512);
    water.addColorStop(0, "#2f7fd4");
    water.addColorStop(1, "#1c4f8f");
    ctx.fillStyle = water;
    ctx.fillRect(0, 360, 512, 152);
    // boat (pixel art)
    ctx.fillStyle = "#6b4423";
    ctx.fillRect(210, 400, 92, 14);
    ctx.fillRect(216, 396, 80, 10);
    ctx.fillStyle = "#8a5a2e";
    ctx.fillRect(210, 406, 92, 6);
    ctx.fillStyle = "#f5f0e0";
    ctx.fillRect(252, 360, 8, 40);
    ctx.fillStyle = "#e8e2d2";
    ctx.beginPath();
    ctx.moveTo(260, 360);
    ctx.lineTo(300, 372);
    ctx.lineTo(260, 384);
    ctx.fill();
    // grass strip at bottom
    ctx.fillStyle = "#4a9e4a";
    ctx.fillRect(0, 486, 512, 26);
    ctx.fillStyle = "#3a7d3a";
    ctx.fillRect(0, 486, 512, 10);

    loadImageFromDataURL(canvas.toDataURL("image/png"), "示例图片.png", 0);

    function cloud(ctx, x, y, s) {
      ctx.beginPath();
      ctx.arc(x, y, 22 * s, 0, Math.PI * 2);
      ctx.arc(x + 26 * s, y - 8 * s, 20 * s, 0, Math.PI * 2);
      ctx.arc(x + 54 * s, y, 22 * s, 0, Math.PI * 2);
      ctx.arc(x + 27 * s, y + 8 * s, 24 * s, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function formatBytes(n) {
    if (!n) return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }

  /* ---------------- settings helpers ---------------- */

  function getBaseName() {
    const custom = sanitizeFileName(state.exportName);
    if (custom) return custom;
    let name = sanitizeFileName((state.imageName || "mapart").replace(/\.[^.]+$/, ""));
    return name || "mapart";
  }

  /* keeps any language (Japanese, Korean, Cyrillic, emoji, ...) and only strips
     characters that are illegal or problematic in file names */
  function sanitizeFileName(name) {
    let s = String(name || "")
      // forbidden characters + control chars + zero-width / bidi marks
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]+/g, "-")
      .replace(/[\u2028\u2029]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/-+/g, "-")
      // Windows: no leading/trailing dots, spaces or hyphens
      .replace(/^[.\s-]+/, "")
      .replace(/[.\s-]+$/, "");
    // Windows reserved device names
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s)) s = "_" + s;
    return s;
  }

  function getSelectedFormats() {
    const out = [];
    if (state.formats.nbt) out.push("nbt");
    if (state.formats.litematic) out.push("litematic");
    if (state.formats.mapdat) out.push("mapdat");
    return out;
  }

  function getSelectedBlockCount() {
    let n = 0;
    for (const k of Object.keys(state.selectedBlocks)) {
      if (state.selectedBlocks[k] !== "-1" && C[k]) n++;
    }
    return n;
  }

  function updateSizeHint() {
    if (state.layoutMode === "wall") {
      $("wallSizeHint").textContent = `墙面 ${state.wallW} × ${state.wallH} 方块，图片将被缩放为 ${state.wallW} × ${state.wallH}`;
    } else if (state.blockSizeMode) {
      $("blockSizeHint").textContent = `输出 ${state.blockW} × ${state.blockH} 方块的地面像素画（非地图尺寸，按 128 网格分区输出，map.dat 不可用）`;
    } else {
      $("sizeHint").textContent = `共 ${state.mapsX * state.mapsY} 张地图，图片将被缩放为 ${state.mapsX * 128} × ${state.mapsY * 128} 像素`;
    }
  }

  // actual artwork size in pixels/blocks
  function getArtW() {
    if (state.layoutMode === "wall") return state.wallW;
    if (state.blockSizeMode) return state.blockW;
    if (state.textMode) return state.textW;
    return state.mapsX * 128;
  }

  function getArtH() {
    if (state.layoutMode === "wall") return state.wallH;
    if (state.blockSizeMode) return state.blockH;
    if (state.textMode) return state.textH;
    return state.mapsY * 128;
  }

  // artwork size that is not aligned to the 128 grid (block-size / text mode):
  // the processing canvas is padded, the layouts are cropped back to the artwork
  function isPaddedArtMode() {
    return isBlockSizeActive() || (state.textMode && state.layoutMode !== "wall");
  }

  // processing canvas size (block-size mode pads up to the 128 grid; padding stays empty)
  function getTargetW() {
    return state.layoutMode === "wall" ? state.wallW : state.mapsX * 128;
  }

  function getTargetH() {
    return state.layoutMode === "wall" ? state.wallH : state.mapsY * 128;
  }

  /* the transparent background option only applies to PNG images */
  function isPngImage() {
    if (!state.image) return false;
    if (/^data:image\/png/i.test(state.image.src)) return true;
    return /\.png$/i.test(state.imageName || "");
  }

  /* resolve a block's modern NBT name from the colour data (for classification) */
  function resolveBlockNbtName(block) {
    let ref = block.validVersions["1.20"] || block.validVersions["1.13.2"];
    if (ref === undefined) {
      const first = Object.values(block.validVersions)[0];
      ref = typeof first === "string" ? block.validVersions[first.slice(1)] : first;
    }
    let guard = 0;
    while (typeof ref === "string" && ref[0] === "&" && guard++ < 10) ref = block.validVersions[ref.slice(1)];
    return ref ? ref.NBTName : "";
  }

  /* per-colourSet solid block preset: first block that can be placed on a wall face */
  function computeSolidPreset() {
    const preset = [];
    for (const [csId, cs] of Object.entries(C)) {
      let chosen = null;
      for (const [blockId, block] of Object.entries(cs.blocks)) {
        if (!K.isWallUnsupported(block.displayName)) {
          chosen = blockId;
          break;
        }
      }
      if (chosen !== null) preset.push([parseInt(csId, 10), parseInt(chosen, 10)]);
    }
    return preset;
  }

  function isColourSetWallUsable(cs) {
    return Object.values(cs.blocks).some((b) => !K.isWallUnsupported(b.displayName));
  }

  function switchLayoutMode(mode) {
    if (mode === state.layoutMode) return;
    const wasWall = state.layoutMode === "wall";
    state.layoutMode = mode;
    const isWall = mode === "wall";

    if (isWall) {
      // remember flat selection, then switch to the wall default preset
      state.flatBlocksBackup = Object.assign({}, state.selectedBlocks);
      if (state.textMode) applyPreset(presetIndexById("obsidian")); // text mode keeps the obsidian preset
      else applySolidPreset();
      // wall mode defaults to no dithering (block textures are viewed directly)
      state.flatDitherBackup = state.dither;
      state.dither = K.DITHER_METHODS.None.id;
      $("dither").value = state.dither;
      // wall mode defaults to whole-wall single files
      state.flatNbtModeBackup = state.nbtMode;
      state.flatLitematicModeBackup = state.litematicMode;
      state.nbtMode = "merged";
      state.litematicMode = "merged";
      $("nbtMode").value = "merged";
      $("litematicMode").value = "merged";
    } else if (wasWall && state.flatBlocksBackup) {
      state.selectedBlocks = state.flatBlocksBackup;
      state.flatBlocksBackup = null;
      if (state.flatDitherBackup !== null) {
        state.dither = state.flatDitherBackup;
        state.flatDitherBackup = null;
        $("dither").value = state.dither;
      }
      if (state.flatNbtModeBackup !== null) {
        state.nbtMode = state.flatNbtModeBackup;
        state.flatNbtModeBackup = null;
        $("nbtMode").value = state.nbtMode;
      }
      if (state.flatLitematicModeBackup !== null) {
        state.litematicMode = state.flatLitematicModeBackup;
        state.flatLitematicModeBackup = null;
        $("litematicMode").value = state.litematicMode;
      }
    }

    // UI visibility
    updateSizeFieldsVisibility();
    $("staircaseField").style.display = isWall ? "none" : "";
    $("supportPanel").style.display = isWall ? "none" : "";
    updateSizeHint();
    updateSerpentineVisibility();
    updateDiffusionVisibility();
    updateTextModeUI();
    syncBlockSizeUI();
    updateBatchSizeVisibility();
    updateGenUI();
    renderPalette();
    updatePaletteCount();
    schedulePreview();
  }

  function applySolidPreset() {
    for (const key of Object.keys(C)) state.selectedBlocks[key] = "-1";
    for (const [csId, blockId] of state.solidPreset) {
      if (C[csId] && C[csId].blocks[blockId]) state.selectedBlocks[csId] = String(blockId);
    }
  }


  function updateGenName() {
    const derived = sanitizeFileName((state.imageName || "").replace(/\.[^.]+$/, "")) || "mapart";
    $("exportName").placeholder = state.image ? "默认：" + derived : "默认使用上传的图片文件名";
    $("genName").textContent = getBaseName();
  }

  function updateGenUI() {
    const formats = getSelectedFormats();
    const btn = $("btnGenerate");
    const batchActive = !!state.batch;
    btn.disabled = state.generating || formats.length === 0 || getSelectedBlockCount() === 0;
    $("btnGenerateText").textContent = state.generating ? "生成中…" : batchActive ? "计算下一批" : "生成并下载";
    $("btnCancelBatch").hidden = !batchActive;
    $("genStatus").textContent = state.generating
      ? "正在生成…"
      : batchActive
        ? `分批计算：已完成 ${state.batch.mapsDone.toLocaleString()} / ${state.batch.totalMaps.toLocaleString()} 张`
        : formats.length === 0
          ? "请选择至少一种输出格式"
          : getSelectedBlockCount() === 0
            ? "请先启用至少一个颜色"
            : isBatchMode()
              ? `共 ${(state.mapsX * state.mapsY).toLocaleString()} 张，将分批计算`
              : "就绪";
  }

  function updateMapdatOptsVisibility() {
    const mapdatOn = state.formats.mapdat && state.layoutMode !== "wall" && !state.blockSizeMode && !state.textMode;
    $("mapdatOpts2").style.display = mapdatOn ? "" : "none";
    $("mapdatIdStartField").style.display = mapdatOn && state.mapdatUseId ? "" : "none";
  }

  /* serpentine scanning only applies to error-diffusion dither methods */
  function isSerpentineApplicable() {
    return K.ERROR_DIFFUSION_IDS.includes(state.dither);
  }

  function updateSerpentineVisibility() {
    $("serpentineField").hidden = !isSerpentineApplicable();
  }

  /* the diffusion strength applies to error-diffusion methods and Riemersma */
  function isDiffusionApplicable() {
    return K.ERROR_DIFFUSION_IDS.includes(state.dither) || state.dither === K.DITHER_METHODS.Riemersma.id;
  }

  function updateDiffusionVisibility() {
    $("diffusionField").hidden = !isDiffusionApplicable();
  }

  /* sizes above 64x64 maps automatically use batch calculation */
  function isBatchMode() {
    return state.layoutMode !== "wall" && state.mapsX * state.mapsY > BATCH_THRESHOLD_MAPS;
  }

  function resetBatch() {
    if (state.batch) {
      state.batch = null;
      updateGenUI();
    }
  }

  /* ---------------- generator / quantization ---------------- */

  function getGenSignature() {
    return JSON.stringify({
      lm: state.layoutMode,
      ww: state.wallW,
      wh: state.wallH,
      v: state.version,
      s: state.layoutMode === "wall" ? -1 : state.staircase,
      d: state.dither,
      serp: state.serpentine && isSerpentineApplicable(),
      ds: state.diffusionStrength,
      cm: state.colourMetric,
      gpu: state.gpuAccel,
      ic: state.isolatedCleanup && state.isolatedPasses,
      t: state.transparentBg && isPngImage(),
      tt: state.transparencyThreshold,
      u: state.mapdatUnobtainable,
      sb: state.selectedBlocks,
      img: state.image ? state.image.src : null,
      mx: state.mapsX,
      my: state.mapsY,
      bm: state.blockSizeMode,
      bw: state.blockW,
      bh: state.blockH,
      crop: state.cropMode,
      zoom: state.cropZoom,
      cx: state.cropX,
      cy: state.cropY,
      pe: state.preprocEnabled,
      br: state.brightness,
      ct: state.contrast,
      st: state.saturation,
      bg: state.bgMode,
      bgc: state.bgColor,
    });
  }

  function newGenerator(overrides) {
    return new MapGenerator(C, Object.assign({
      mcVersion: state.version,
      staircaseId: state.staircase,
      supportModeId: state.supportMode,
      supportBlock: state.supportBlock,
      includeNoobline: state.includeNoobline,
      colourMetric: state.colourMetric,
      gpuAccel: state.gpuAccel,
      isolatedCleanup: state.isolatedCleanup,
      isolatedPasses: state.isolatedPasses,
      ditherId: state.dither,
      selectedBlocks: state.selectedBlocks,
      transparency: state.transparentBg && isPngImage(),
      transparencyTolerance: state.transparencyThreshold,
      mapdatUnobtainable: state.mapdatUnobtainable,
      wallMode: state.layoutMode === "wall",
      serpentine: state.serpentine && isSerpentineApplicable(),
      diffusionStrength: state.diffusionStrength,
      artW: isPaddedArtMode() ? getArtW() : 0,
      artH: isPaddedArtMode() ? getArtH() : 0,
    }, overrides || {}));
  }

  // computes the source rectangle for the current crop settings
  function getSourceRect(tw, th) {
    const img = state.image;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    let sx, sy, sw, sh;
    if (state.cropMode === K.CROP_MODES.STRETCH.id) {
      sx = 0;
      sy = 0;
      sw = iw;
      sh = ih;
    } else if (state.cropMode === K.CROP_MODES.CENTER.id) {
      const scale = Math.max(tw / iw, th / ih);
      sw = tw / scale;
      sh = th / scale;
      sx = (iw - sw) / 2;
      sy = (ih - sh) / 2;
    } else {
      const scale0 = Math.max(tw / iw, th / ih);
      const zoom = state.cropZoom / 10;
      const sw0 = tw / scale0;
      const sh0 = th / scale0;
      sw = sw0 / zoom;
      sh = sh0 / zoom;
      sx = (iw - sw) * (state.cropX / 100);
      sy = (ih - sh) * (state.cropY / 100);
    }
    return { sx, sy, sw, sh };
  }

  // prepare source pixels (crop + preprocess)
  function prepareSourceImage() {
    const tw = getTargetW();
    const th = getTargetH();
    const artW = getArtW();
    const artH = getArtH();
    const img = state.image;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;

    const canvas = document.createElement("canvas");
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const rect = getSourceRect(artW, artH);
    ctx.imageSmoothingEnabled = !(iw <= artW && ih <= artH);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, artW, artH);

    const imageData = ctx.getImageData(0, 0, tw, th);
    if (state.preprocEnabled || state.bgMode !== K.BACKGROUND_MODES.OFF.id) {
      applyPreprocess(imageData.data, tw, { x0: 0, y0: 0, x1: artW, y1: artH });
    }
    return imageData;
  }

  // region: {x0,y0,x1,y1} pixels to process (outside stays untouched); stride = row width
  function applyPreprocess(data, stride, region) {
    const brightness = state.preprocEnabled ? state.brightness / 100 : 1;
    const contrast = state.preprocEnabled ? state.contrast / 100 : 1;
    const saturation = state.preprocEnabled ? state.saturation / 100 : 1;
    let bgR = 0, bgG = 0, bgB = 0;
    const bg = state.bgMode;
    if (bg === K.BACKGROUND_MODES.WHITE.id) {
      bgR = bgG = bgB = 255;
    } else if (bg === K.BACKGROUND_MODES.BLACK.id) {
      bgR = bgG = bgB = 0;
    } else if (bg === K.BACKGROUND_MODES.CUSTOM.id) {
      bgR = parseInt(state.bgColor.slice(1, 3), 16);
      bgG = parseInt(state.bgColor.slice(3, 5), 16);
      bgB = parseInt(state.bgColor.slice(5, 7), 16);
    }
    const fillTransparent = bg !== K.BACKGROUND_MODES.OFF.id;

    for (let i = 0; i < data.length; i += 4) {
      if (region) {
        const px = (i / 4) % stride;
        const py = Math.floor(i / 4 / stride);
        if (px < region.x0 || px >= region.x1 || py < region.y0 || py >= region.y1) continue;
      }
      let r = data[i], g = data[i + 1], b = data[i + 2];
      const a = data[i + 3];
      if (fillTransparent && a < 255) {
        const t = a / 255;
        r = r * t + bgR * (1 - t);
        g = g * t + bgG * (1 - t);
        b = b * t + bgB * (1 - t);
        data[i + 3] = 255;
      }
      if (state.preprocEnabled) {
        r *= brightness;
        g *= brightness;
        b *= brightness;
        r = (r - 128) * contrast + 128;
        g = (g - 128) * contrast + 128;
        b = (b - 128) * contrast + 128;
        if (saturation !== 1) {
          const gray = 0.299 * r + 0.587 * g + 0.114 * b;
          r = gray + (r - gray) * saturation;
          g = gray + (g - gray) * saturation;
          b = gray + (b - gray) * saturation;
        }
      }
      data[i] = clamp255(r);
      data[i + 1] = clamp255(g);
      data[i + 2] = clamp255(b);
    }
  }

  function clamp255(v) {
    return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }

  // runs quantization + layout extraction if the cache is stale; returns {gen, quantized, layouts}
  async function ensureQuantization(onProgress) {
    await syncTextImage(); // text mode: keep the rendered text image up to date
    const signature = getGenSignature();
    if (state.gen && state.genSignature === signature && state.quantized && state.layouts) {
      return { gen: state.gen, quantized: state.quantized, layouts: state.layouts };
    }
    const gen = newGenerator();
    gen.setup();
    const imageData = prepareSourceImage();
    const W = getTargetW();
    const H = getTargetH();
    const cellsX = Math.ceil(W / 128);
    const cellsY = Math.ceil(H / 128);
    const quantized = await gen.processImageData(imageData, cellsX, cellsY, onProgress);
    let layouts =
      state.layoutMode === "wall"
        ? gen.extractColoursLayoutWall(imageData.data, W, H)
        : gen.extractColoursLayouts(imageData.data, cellsX, cellsY);
    if (isPaddedArtMode()) layouts = gen.cropColoursLayouts(layouts, getArtW(), getArtH());
    state.gen = gen;
    state.genSignature = signature;
    state.quantized = { pixels: imageData.data, maps: quantized.maps };
    state.layouts = layouts;
    return { gen, quantized: state.quantized, layouts };
  }

  /* ---------------- preview ---------------- */

  let previewTimer = null;
  function schedulePreview() {
    resetBatch(); // changing settings invalidates an in-progress batch
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshPreview, 250);
  }

  async function refreshPreview() {
    if (!state.image) return;
    const token = ++state.previewToken;
    // batch mode: the full image cannot be quantized for preview (memory), show the source instead
    if (isBatchMode()) {
      state.viewMode = "source";
      document.querySelectorAll("#viewSeg .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === "source"));
      drawPreview();
      $("previewInfo").textContent = isBlockSizeActive()
        ? `方块尺寸 ${state.blockW}×${state.blockH} · 分批计算模式（预览显示原图）`
        : `共 ${(state.mapsX * state.mapsY).toLocaleString()} 张地图 · 分批计算模式（预览显示原图）`;
      $("previewSize").textContent = `原图 ${state.image.naturalWidth}×${state.image.naturalHeight}`;
      renderStats(null);
      $("statsEmpty").hidden = false;
      $("statsEmpty").textContent = "分批计算模式：材料统计在每批计算时生成";
      updateGenUI();
      return;
    }
    $("genStatus").textContent = "正在计算…";
    try {
      const { quantized } = await ensureQuantization(() => {});
      if (token !== state.previewToken) return;
      drawPreview();
      updateStats();
      if (state.layoutMode === "wall") {
        $("previewInfo").textContent = `墙面 ${state.wallW}×${state.wallH} 方块 · 立式模式${state.textMode ? " · 文字模式" : ""} · 已启用 ${getSelectedBlockCount()}/61 色`;
      } else if (state.blockSizeMode) {
        $("previewInfo").textContent = `方块尺寸 ${state.blockW}×${state.blockH} · 非地图尺寸模式${state.textMode ? " · 文字模式" : ""} · 已启用 ${getSelectedBlockCount()}/61 色`;
      } else {
        $("previewInfo").textContent = `分辨率 ${state.mapsX * 128}×${state.mapsY * 128} · 地图 ${state.mapsX}×${state.mapsY}${state.textMode ? " · 文字模式" : ""} · 已启用 ${getSelectedBlockCount()}/61 色`;
      }
      $("previewSize").textContent = `原图 ${state.image.naturalWidth}×${state.image.naturalHeight}`;
      updateGenUI();
    } catch (e) {
      console.error(e);
      if (token === state.previewToken) toast("预览生成失败：" + e.message, true);
    }
  }

  // scales the canvas to fill the available width, but caps it so the whole preview
  // panel stays visible without scrolling (aspect ratio preserved); returns the applied size
  function fitPreviewCanvas() {
    const canvas = $("preview");
    const wrap = $("canvasWrap");
    if (!canvas.width || !canvas.height) return { w: 0, h: 0 };
    const availW = Math.max(64, wrap.clientWidth);
    const availH = Math.max(200, window.innerHeight - 260);
    const ar = canvas.width / canvas.height;
    let w = availW;
    let h = w / ar;
    if (h > availH) {
      h = availH;
      w = h * ar;
    }
    const size = { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
    canvas.style.width = size.w + "px";
    canvas.style.height = size.h + "px";
    return size;
  }

  function drawPreview() {
    const canvas = $("preview");
    if (state.viewMode === "source" && state.image) {
      const img = state.image;
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0);
      fitPreviewCanvas();
      $("canvasEmpty").hidden = true;
      return;
    }
    if (!state.quantized) {
      $("canvasEmpty").hidden = false;
      return;
    }
    const tw = getTargetW();
    const th = getTargetH();
    const artW = getArtW();
    const artH = getArtH();
    canvas.width = artW;
    canvas.height = artH;
    const ctx = canvas.getContext("2d");
    const imgData = new ImageData(new Uint8ClampedArray(state.quantized.pixels), tw, th);
    ctx.putImageData(imgData, 0, 0, 0, 0, artW, artH);

    // the bitmap gets scaled by CSS, so widen the grid lines when the preview is
    // displayed smaller than the artwork (otherwise downscaling drops them)
    const dispW = fitPreviewCanvas().w || artW;
    if (state.showGrid) {
      const scale = dispW / artW;
      const lw = scale >= 1 ? 1 : Math.max(1, Math.ceil(1 / scale));
      const off = lw % 2 === 1 ? 0.5 : 0;
      ctx.strokeStyle = "rgba(255,255,255,0.4)";
      ctx.lineWidth = lw;
      const cellsX = Math.ceil(artW / 128);
      const cellsY = Math.ceil(artH / 128);
      for (let x = 1; x < cellsX; x++) {
        const px = x * 128 + off;
        ctx.beginPath();
        ctx.moveTo(px, 0);
        ctx.lineTo(px, artH);
        ctx.stroke();
      }
      for (let y = 1; y < cellsY; y++) {
        const py = y * 128 + off;
        ctx.beginPath();
        ctx.moveTo(0, py);
        ctx.lineTo(artW, py);
        ctx.stroke();
      }

      // map cell coordinates (only drawn when the cells are large enough to read)
      const cellPx = 128 * scale;
      if (state.showGridLabels && cellPx >= 30) {
        const longLabel = cellPx >= 66;
        for (let my = 0; my < cellsY; my++) {
          for (let mx = 0; mx < cellsX; mx++) {
            drawGridLabel(ctx, longLabel ? `map_${mx}_${my}` : `${mx},${my}`, mx * 128, my * 128, scale);
          }
        }
      }
    }
    $("canvasEmpty").hidden = true;
    hidePreviewTip();
  }

  // draws a small label at bitmap coordinates, scaled so it stays ~11px on screen
  function drawGridLabel(ctx, text, x, y, scale) {
    const fs = Math.max(8, Math.round(11 / scale));
    ctx.font = `600 ${fs}px "Segoe UI", "Microsoft YaHei", sans-serif`;
    const padX = Math.round(5 / scale);
    const padY = Math.round(3 / scale);
    const bw = ctx.measureText(text).width + padX * 2;
    const bh = fs + padY * 2;
    const bx = x + Math.round(4 / scale);
    const by = y + Math.round(4 / scale);
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, Math.min(bh / 2, 5 / scale));
    else ctx.rect(bx, by, bw, bh);
    ctx.fill();
    ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
    ctx.textBaseline = "top";
    ctx.fillText(text, bx + padX, by + padY);
  }

  /* ---------------- preview hover tooltip ---------------- */

  // returns { rows: [...], rgb: [r,g,b] } for the pixel under the cursor, or null
  function previewTipContent(clientX, clientY) {
    const canvas = $("preview");
    if (!state.showHoverInfo || state.viewMode !== "result" || !state.quantized || !state.gen) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const artW = canvas.width;
    const artH = canvas.height;
    const x = Math.floor(((clientX - rect.left) / rect.width) * artW);
    const y = Math.floor(((clientY - rect.top) / rect.height) * artH);
    if (x < 0 || y < 0 || x >= artW || y >= artH) return null;
    const tw = getTargetW();
    const i = (y * tw + x) * 4;
    const pix = state.quantized.pixels;
    if (i + 3 >= pix.length) return null;
    const r = pix[i];
    const g = pix[i + 1];
    const b = pix[i + 2];
    const rows = [`像素 ${x}, ${y} · 地图 map_${Math.floor(x / 128)}_${Math.floor(y / 128)}`];
    const csAndTone = state.gen.exactRGBToColourSetIdAndTone([r, g, b]);
    if (!csAndTone || csAndTone.colourSetId === "-1") {
      rows.push("空格（透明 / 未放置方块）");
      return { rows, rgb: [r, g, b] };
    }
    const toneNames = { dark: "暗色", normal: "普通", light: "亮色", unobtainable: "不可获得" };
    const cs = C[csAndTone.colourSetId];
    const blockId = state.selectedBlocks[csAndTone.colourSetId];
    const block = cs && cs.blocks ? cs.blocks[blockId] : null;
    rows.push(`色号 ${csAndTone.colourSetId} · ${cs ? cs.colourName : "?"} · ${toneNames[csAndTone.tone] || csAndTone.tone}`);
    rows.push(`方块 ${block ? block.displayName : "未选择"}`);
    rows.push(`颜色 RGB ${r}, ${g}, ${b}`);
    const tone = cs && cs.tonesRGB ? cs.tonesRGB[csAndTone.tone] || cs.tonesRGB.normal : null;
    return { rows, rgb: tone || [r, g, b] };
  }

  function showPreviewTip(e) {
    const tip = $("previewTip");
    const info = previewTipContent(e.clientX, e.clientY);
    if (!info) {
      tip.hidden = true;
      return;
    }
    tip.innerHTML =
      `<div class="tip-row"><span class="swatch" style="background:rgb(${info.rgb[0]},${info.rgb[1]},${info.rgb[2]})"></span><span>${esc(info.rows[0])}</span></div>` +
      info.rows
        .slice(1)
        .map((t) => `<div class="tip-row"><span class="tip-dim">${esc(t)}</span></div>`)
        .join("");
    tip.hidden = false;
    const pad = 14;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let left = e.clientX + pad;
    let top = e.clientY + pad;
    if (left + w > window.innerWidth - 8) left = e.clientX - w - pad;
    if (top + h > window.innerHeight - 8) top = e.clientY - h - pad;
    tip.style.left = Math.max(8, left) + "px";
    tip.style.top = Math.max(8, top) + "px";
  }

  function hidePreviewTip() {
    const tip = $("previewTip");
    if (tip) tip.hidden = true;
  }

  /* ---------------- stats ---------------- */

  function updateStats() {
    if (!state.quantized) {
      renderStats(null);
      return;
    }
    const totals = {};
    let grandTotal = 0;
    for (const row of state.quantized.maps) {
      for (const map of row) {
        for (const [csId, count] of Object.entries(map.materials)) {
          totals[csId] = (totals[csId] || 0) + count;
          grandTotal += count;
        }
      }
    }
    let supportCount = 0;
    if (state.layoutMode !== "wall" && (state.supportMode !== K.SUPPORT_MODES.NONE.id || state.includeNoobline)) {
      try {
        const gen = state.gen || newGenerator();
        const result = gen.buildMergedPhysicalLayout(state.layouts);
        supportCount = result.supportCount;
      } catch (e) {
        console.error(e);
      }
    }
    renderStats({ totals, grandTotal, supportCount });
  }

  function renderStats(data) {
    const body = $("statsBody");
    const summary = $("statsSummary");
    if (!data || data.grandTotal === 0) {
      body.innerHTML = "";
      summary.textContent = "";
      $("statsEmpty").hidden = false;
      return;
    }
    $("statsEmpty").hidden = true;
    const rows = Object.entries(data.totals).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    body.innerHTML = "";
    if (data.supportCount > 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td><div class="stats-block"><span class="swatch" style="background:#7a7a7a"></span><span class="stats-name">支撑方块 (${esc(state.supportBlock)})</span></div></td>
        <td class="stats-num">${data.supportCount.toLocaleString()}</td>
        <td class="stats-num">${Math.floor(data.supportCount / 64).toLocaleString()}</td>
        <td class="stats-num">${(data.supportCount / 1728).toFixed(2)}</td>`;
      body.appendChild(tr);
    }
    for (const [csId, count] of rows) {
      const cs = C[csId];
      if (!cs) continue;
      const blockId = state.selectedBlocks[csId];
      const block = cs.blocks[blockId];
      const tone = cs.tonesRGB.normal || cs.tonesRGB.dark;
      const tr = document.createElement("tr");
      tr.innerHTML = `<td><div class="stats-block"><span class="swatch" style="background:rgb(${tone[0]},${tone[1]},${tone[2]})"></span><span class="stats-name" title="${esc(cs.colourName)}">${esc(cs.colourName)}${block ? " · " + esc(block.displayName) : ""}</span></div></td>
        <td class="stats-num">${count.toLocaleString()}</td>
        <td class="stats-num">${Math.floor(count / 64).toLocaleString()}</td>
        <td class="stats-num">${(count / 1728).toFixed(2)}</td>`;
      body.appendChild(tr);
    }
    const totalBlocks = data.grandTotal + data.supportCount;
    summary.textContent = `方块总数 ${totalBlocks.toLocaleString()}（画 ${data.grandTotal.toLocaleString()}` +
      (data.supportCount > 0 ? ` + 支撑 ${data.supportCount.toLocaleString()}` : "") + `）`;
  }

  /* ---------------- palette ---------------- */

  function applyPreset(presetIndex) {
    const preset = K.BLOCK_PRESETS[presetIndex];
    for (const key of Object.keys(C)) state.selectedBlocks[key] = "-1";
    for (const [csId, blockId] of preset.blocks) {
      if (C[csId] && C[csId].blocks[blockId]) state.selectedBlocks[csId] = String(blockId);
    }
  }

  // finds a preset by its id (used by text mode / wall defaults)
  function presetIndexById(id) {
    return K.BLOCK_PRESETS.findIndex((p) => p.id === id);
  }

  function updatePaletteCount() {
    $("paletteCount").textContent = `已启用 ${getSelectedBlockCount()} / ${Object.keys(C).length} 色`;
  }

  function renderPalette() {
    const list = $("blockList");
    list.innerHTML = "";
    const search = state.blockSearch;
    const isWall = state.layoutMode === "wall";
    for (const [csId, cs] of Object.entries(C)) {
      const blocks = Object.entries(cs.blocks);
      const tone = cs.tonesRGB.normal || cs.tonesRGB.dark;
      const rgb = `rgb(${tone[0]},${tone[1]},${tone[2]})`;
      const blockNames = blocks.map(([, b]) => b.displayName).join(" ");
      if (search && !cs.colourName.toLowerCase().includes(search) && !blockNames.toLowerCase().includes(search)) continue;

      const usableInWall = !isWall || isColourSetWallUsable(cs);
      const item = document.createElement("div");
      item.className = "block-item" + (state.selectedBlocks[csId] !== "-1" ? " enabled" : "") + (usableInWall ? "" : " disabled");

      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = rgb;

      const nameWrap = document.createElement("div");
      nameWrap.className = "block-item-name";
      nameWrap.innerHTML = `<span title="${esc(cs.colourName)}">${esc(cs.colourName)}</span><span class="label-sm">色号 ${csId}${cs.mapdatId !== undefined ? " · map " + cs.mapdatId : ""}${usableInWall ? "" : " · 立式不可用"}</span>`;

      const sel = document.createElement("select");
      sel.dataset.cs = csId;
      const offOpt = document.createElement("option");
      offOpt.value = "-1";
      offOpt.textContent = usableInWall ? "不启用" : "立式不可用";
      sel.appendChild(offOpt);
      for (const [blockId, block] of blocks) {
        const opt = document.createElement("option");
        opt.value = blockId;
        const unsupported = K.isWallUnsupported(block.displayName);
        opt.textContent = block.displayName + (block.supportBlockMandatory ? " (需支撑)" : "") + (isWall && unsupported ? "（不能上墙）" : "");
        if (isWall && unsupported) opt.disabled = true;
        sel.appendChild(opt);
      }
      if (!usableInWall) {
        sel.disabled = true;
        sel.value = "-1";
      } else {
        sel.value = state.selectedBlocks[csId] !== undefined ? String(state.selectedBlocks[csId]) : "-1";
      }
      sel.addEventListener("change", () => {
        state.selectedBlocks[csId] = sel.value;
        item.classList.toggle("enabled", sel.value !== "-1");
        updatePaletteCount();
        updateGenUI();
        schedulePreview();
      });

      item.appendChild(swatch);
      item.appendChild(nameWrap);
      item.appendChild(sel);
      list.appendChild(item);
    }
  }

  /* ---------------- generate & download ---------------- */

  async function generate() {
    if (state.generating) return;
    if (!state.image) return toast("请先上传图片", true);
    const formats = getSelectedFormats();
    if (formats.length === 0) return toast("请至少选择一种输出格式", true);
    if (getSelectedBlockCount() === 0) return toast("请先启用至少一个颜色（方块选择）", true);

    if (isBatchMode()) return generateBatchStep(formats);

    state.generating = true;
    updateGenUI();
    $("genProgressWrap").hidden = false;
    setProgress(0);

    try {
      const { gen, layouts } = await ensureQuantization((p) => {
        setProgress(p * 0.5);
      });
      const baseName = getBaseName();

      // check volume limits
      const volume = 128 * state.mapsX * 128 * state.mapsY * 129;
      if (volume > 800000000) {
        toast("图片过大（地图网格 " + state.mapsX + "×" + state.mapsY + "），生成可能非常慢或失败，建议缩小", true);
      }

      const files = [];
      let step = 0.5;
      const stepSize = 0.5 / formats.length;

      if (formats.includes("nbt")) {
        setStatus("正在生成 Schematic (.nbt)…");
        await yieldToUI();
        const folder = K.OUTPUT_FORMATS.NBT.folder;
        if (state.layoutMode === "wall") {
          if (state.nbtMode === "merged") {
            const bytes = gen.buildWallSchematicNbt(layouts, "MapArt Generator");
            files.push({ name: `${folder}/${baseName}.nbt`, data: bytes });
          } else {
            const W = state.wallW, H = state.wallH;
            const cellsX = Math.ceil(W / 128), cellsY = Math.ceil(H / 128);
            for (let cy = 0; cy < cellsY; cy++) {
              for (let cx = 0; cx < cellsX; cx++) {
                const cw = Math.min(128, W - cx * 128);
                const ch = Math.min(128, H - cy * 128);
                const bytes = gen.buildWallSchematicNbtCell(layouts, cx * 128, cy * 128, cw, ch, "MapArt Generator");
                files.push({ name: `${folder}/${baseName}_part_${cx}_${cy}.nbt`, data: bytes });
              }
            }
          }
        } else if (state.nbtMode === "merged") {
          const bytes = gen.buildSchematicNbtMerged(layouts, "MapArt Generator");
          files.push({ name: `${folder}/${baseName}.nbt`, data: bytes });
        } else {
          const partPrefix = state.blockSizeMode ? "part" : "map";
          for (let my = 0; my < state.mapsY; my++) {
            for (let mx = 0; mx < state.mapsX; mx++) {
              const bytes = gen.buildSchematicNbt(layouts[my][mx].coloursLayout, "MapArt Generator");
              files.push({ name: `${folder}/${baseName}_${partPrefix}_${mx}_${my}.nbt`, data: bytes });
            }
          }
        }
        step += stepSize;
        setProgress(step);
      }

      if (formats.includes("litematic")) {
        setStatus("正在生成 Litematic (.litematic)…");
        await yieldToUI();
        const folder = K.OUTPUT_FORMATS.LITEMATIC.folder;
        if (state.layoutMode === "wall") {
          if (state.litematicMode === "split") {
            const W = state.wallW, H = state.wallH;
            const cellsX = Math.ceil(W / 128), cellsY = Math.ceil(H / 128);
            for (let cy = 0; cy < cellsY; cy++) {
              for (let cx = 0; cx < cellsX; cx++) {
                const cw = Math.min(128, W - cx * 128);
                const ch = Math.min(128, H - cy * 128);
                const bytes = gen.buildWallLitematicCell(layouts, cx * 128, cy * 128, cw, ch, `${baseName}_part_${cx}_${cy}`, "MapArt Generator");
                files.push({ name: `${folder}/${baseName}_part_${cx}_${cy}.litematic`, data: bytes });
              }
            }
          } else {
            const bytes = gen.buildWallLitematic(layouts, baseName, "MapArt Generator");
            files.push({ name: `${folder}/${baseName}.litematic`, data: bytes });
          }
        } else if (state.litematicMode === "split") {
          const partPrefix = state.blockSizeMode ? "part" : "map";
          for (let my = 0; my < state.mapsY; my++) {
            for (let mx = 0; mx < state.mapsX; mx++) {
              const single = [[layouts[my][mx]]];
              const bytes = gen.buildLitematicBytes(single, `${baseName}_${partPrefix}_${mx}_${my}`, "MapArt Generator");
              files.push({ name: `${folder}/${baseName}_${partPrefix}_${mx}_${my}.litematic`, data: bytes });
            }
          }
        } else {
          const bytes = gen.buildLitematicBytes(layouts, baseName, "MapArt Generator");
          files.push({ name: `${folder}/${baseName}.litematic`, data: bytes });
        }
        step += stepSize;
        setProgress(step);
      }

      if (formats.includes("mapdat") && state.layoutMode !== "wall" && !state.blockSizeMode && !state.textMode) {
        setStatus("正在生成 MapData (map.dat)…");
        await yieldToUI();
        const folder = K.OUTPUT_FORMATS.MAPDAT.folder;
        const idStart = state.mapdatIdStart;
        for (let my = 0; my < state.mapsY; my++) {
          for (let mx = 0; mx < state.mapsX; mx++) {
            const bytes = gen.buildMapdatBytes(layouts[my][mx].coloursLayout);
            const id = idStart + my * state.mapsX + mx;
            files.push({ name: `${folder}/map_${id}.dat`, data: bytes });
          }
        }
        step += stepSize;
        setProgress(step);
      }

      // usage instructions
      files.push({ name: "使用说明.txt", data: buildReadme(formats, baseName) });

      setStatus("正在打包 ZIP…");
      await yieldToUI();
      setProgress(0.95);

      if (state.zipMode === "combined") {
        const zip = new ZipWriter();
        for (const f of files) zip.addFile(f.name, f.data);
        downloadBlob(zip.toBlob(), `${baseName}_地图画.zip`);
      } else {
        for (const fmt of formats) {
          const zip = new ZipWriter();
          const prefix = K.OUTPUT_FORMATS[fmt.toUpperCase()].folder + "/";
          for (const f of files) {
            if (f.name.startsWith(prefix) || f.name === "使用说明.txt") zip.addFile(f.name, f.data);
          }
          const fmtName = K.OUTPUT_FORMATS[fmt.toUpperCase()].folder.toLowerCase();
          downloadBlob(zip.toBlob(), `${baseName}_${fmtName}.zip`);
        }
      }

      setProgress(1);
      setStatus("完成！");
      toast("生成完成！文件已下载");
    } catch (e) {
      console.error(e);
      toast("生成失败：" + e.message, true);
      setStatus("失败");
    } finally {
      state.generating = false;
      updateGenUI();
      setTimeout(() => {
        $("genProgressWrap").hidden = true;
      }, 1500);
    }
  }

  /* ---------------- batch calculation (maps > 64x64, vertical map-column strips) ---------------- */

  async function generateBatchStep(formats) {
    const totalMaps = state.mapsX * state.mapsY;

    if (!state.batch) {
      // first step: initialise and inform the user
      const colsPerBatch = Math.max(1, Math.ceil(state.batchSize / state.mapsY));
      alert(
        "图片内容过大（" +
          state.mapsX +
          " × " +
          state.mapsY +
          " = " +
          totalMaps.toLocaleString() +
          " 张地图，超过 64×64），已自动启用分批计算模式。\n\n" +
          "按地图列（竖排）分批，每批约 " +
          colsPerBatch +
          " 列 / " +
          Math.min(colsPerBatch * state.mapsY, totalMaps).toLocaleString() +
          " 张（可在设置里调整），每批完成后会自动下载该批的 ZIP 压缩包。\n" +
          "点击「计算下一批」按钮继续计算下一部分，直到全部完成。"
      );
      const gen = newGenerator(isBatchMode() ? { serpentine: false } : null);
      gen.setup();
      let litematicState = null;
      let mergedSkipped = false;
      if (formats.includes("litematic") && state.litematicMode === "merged") {
        if (state.staircase === K.STAIRCASING.OFF.id) {
          litematicState = gen.initLitematicBatch(state.mapsX, state.mapsY);
        } else {
          mergedSkipped = true;
        }
      }
      state.batch = {
        gen,
        formats,
        mapsDone: 0,
        totalMaps,
        batchNo: 0,
        startCol: 0,
        rowCarry: null,
        colCarry: null, // 2 extra columns x full height x RGBA, carried across batches
        litematicState,
        baseName: getBaseName(),
      };
      if (mergedSkipped) toast("分批模式下合并 litematic 仅支持平面模式，本次已跳过该文件", true);
      if (state.isolatedCleanup) toast("分批模式下已忽略孤立像素抑制");
      if (state.serpentine && isSerpentineApplicable()) toast("分批模式下已忽略蛇形扫描（保证与整体计算一致）");
      if (K.ERROR_DIFFUSION_IDS.includes(state.dither)) {
        toast("提示：误差扩散类算法在分批交界处会有极轻微的图案差异，追求完全一致可换用「蓝噪声」等有序算法", true);
      }
    }

    state.generating = true;
    updateGenUI();
    $("genProgressWrap").hidden = false;

    try {
      const batch = state.batch;
      const mapsY = state.mapsY;
      const colsPerBatch = Math.max(1, Math.ceil(state.batchSize / mapsY));
      const remainingCols = state.mapsX - batch.startCol;
      const colsThisBatch = Math.min(colsPerBatch, remainingCols);
      const outPixels = colsThisBatch * 128;
      const processWidth = outPixels; // process exactly this batch's columns
      const bufferWidth = outPixels + 2; // 2 extra columns only receive the error state for the next batch
      const carryCols = 2;
      const carryStart = outPixels; // the 2 pending-error columns are the next batch's first 2 columns
      const files = [];

      batch.batchNo++;
      setStatus(`正在计算第 ${batch.batchNo} 批（${colsThisBatch} 列地图）…`);

      let rowCarry = null; // row carry is only used within a batch
      const colCarry = batch.colCarry; // carry from the previous batch (first 2 columns' state)
      const newColCarry = new Uint8ClampedArray(carryCols * mapsY * 128 * 4);

      for (let mapRow = 0; mapRow < mapsY; mapRow++) {
        const bandH = 130;
        const band = drawSourceBandRange(batch.startCol * 128, bufferWidth, mapRow * 128, bandH);
        const bandData = band.data;

        // apply the carried errors (row carry for the first two rows, column carry for the rest)
        batch.gen.applyBandCarries(bandData, bufferWidth, mapRow, rowCarry, colCarry, carryCols);

        const res = await batch.gen.processImageBand(band, mapRow, colsThisBatch, rowCarry, (p) => {
          const done = batch.mapsDone + colsThisBatch * (mapRow + p);
          setProgress(Math.min(0.99, done / batch.totalMaps));
        }, { processOffset: 0, processWidth, globalXOffset: batch.startCol * 128 });
        rowCarry = res.carry;

        // store this band's contribution to the column carry (the 2 pending-error columns)
        batch.gen.storeColumnCarry(bandData, bufferWidth, mapRow, newColCarry, carryCols, carryStart);

        const bandLayouts = batch.gen.extractColoursLayoutsBand(bandData, bufferWidth, colsThisBatch, 0);
        // block-size mode: crop each cell to the actual artwork bounds
        const artW = getArtW();
        const artH = getArtH();
        const partPrefix = state.blockSizeMode ? "part" : "map";
        const layouts = [];
        for (let c = 0; c < colsThisBatch; c++) {
          const cw = Math.max(0, Math.min(128, artW - (batch.startCol + c) * 128));
          const ch = Math.max(0, Math.min(128, artH - mapRow * 128));
          layouts.push(cw >= 128 && ch >= 128 ? bandLayouts[c] : batch.gen.cropColoursLayout(bandLayouts[c], cw, ch));
        }

        for (let c = 0; c < colsThisBatch; c++) {
          const mx = batch.startCol + c;
          const my = mapRow;
          const layout = layouts[c];
          if (formats.includes("nbt")) {
            const bytes = batch.gen.buildSchematicNbt(layout, "MapArt Generator");
            files.push({ name: `Schematic-NBT/${batch.baseName}_${partPrefix}_${mx}_${my}.nbt`, data: bytes });
          }
          if (formats.includes("litematic") && !batch.litematicState) {
            const bytes = batch.gen.buildLitematicBytes([[{ coloursLayout: layout }]], `${batch.baseName}_${partPrefix}_${mx}_${my}`, "MapArt Generator");
            files.push({ name: `Litematic/${batch.baseName}_${partPrefix}_${mx}_${my}.litematic`, data: bytes });
          }
          if (formats.includes("mapdat")) {
            const bytes = batch.gen.buildMapdatBytes(layout);
            const id = state.mapdatIdStart + my * state.mapsX + mx;
            files.push({ name: `MapData/map_${id}.dat`, data: bytes });
          }
        }
        if (batch.litematicState) {
          batch.gen.addLitematicBatchRow(batch.litematicState, layouts, mapRow, batch.startCol);
        }
        batch.mapsDone += colsThisBatch;
        setProgress(Math.min(0.99, batch.mapsDone / batch.totalMaps));
      }

      batch.colCarry = batch.gen.isErrorDiffusionDither() ? newColCarry : null;
      batch.startCol += colsThisBatch;

      const isFinal = batch.startCol >= state.mapsX;
      if (isFinal && batch.litematicState) {
        const bytes = batch.gen.finishLitematicBatch(batch.litematicState, batch.baseName, "MapArt Generator");
        files.push({ name: `Litematic/${batch.baseName}.litematic`, data: bytes });
      }

      files.push({ name: "使用说明.txt", data: buildReadme(formats, batch.baseName) });

      setStatus("正在打包 ZIP…");
      await yieldToUI();
      const zip = new ZipWriter();
      for (const f of files) zip.addFile(f.name, f.data);
      if (isFinal) {
        downloadBlob(zip.toBlob(), `${batch.baseName}_地图画_第${batch.batchNo}批_完成.zip`);
        setProgress(1);
        toast(`全部计算完成！共 ${batch.batchNo} 批，${batch.totalMaps.toLocaleString()} 张地图`);
        state.batch = null;
      } else {
        downloadBlob(zip.toBlob(), `${batch.baseName}_地图画_第${batch.batchNo}批.zip`);
        toast(`第 ${batch.batchNo} 批完成（${batch.mapsDone.toLocaleString()} / ${batch.totalMaps.toLocaleString()} 张），点击「计算下一批」继续`);
      }
    } catch (e) {
      console.error(e);
      toast("分批计算失败：" + e.message, true);
      resetBatch();
    } finally {
      state.generating = false;
      updateGenUI();
      setTimeout(() => {
        $("genProgressWrap").hidden = true;
      }, 1500);
    }
  }

  // draws a band of the source image: columns [srcColStart, srcColStart + widthPx) and rows [rowStart, rowStart + heightPx)
  function drawSourceBandRange(srcColStart, widthPx, rowStart, heightPx) {
    const artW = getArtW();
    const artH = getArtH();
    const canvas = document.createElement("canvas");
    canvas.width = widthPx;
    canvas.height = heightPx;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const img = state.image;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;

    // intersection of the band with the artwork (everything outside stays empty)
    const x0 = Math.max(0, -srcColStart);
    const x1 = Math.min(widthPx, artW - srcColStart);
    const y0 = Math.max(0, -rowStart);
    const y1 = Math.min(heightPx, artH - rowStart);

    if (x1 > x0 && y1 > y0) {
      const rect = getSourceRect(artW, artH);
      const sx = rect.sx + ((srcColStart + x0) / artW) * rect.sw;
      const sy = rect.sy + ((rowStart + y0) / artH) * rect.sh;
      const sw = ((x1 - x0) / artW) * rect.sw;
      const sh = ((y1 - y0) / artH) * rect.sh;
      ctx.imageSmoothingEnabled = !(iw <= artW && ih <= artH);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, sx, sy, sw, sh, x0, y0, x1 - x0, y1 - y0);
    }

    const imageData = ctx.getImageData(0, 0, widthPx, heightPx);
    if (state.preprocEnabled || state.bgMode !== K.BACKGROUND_MODES.OFF.id) {
      applyPreprocess(imageData.data, widthPx, { x0, y0, x1, y1 });
    }
    return imageData;
  }

  function buildReadme(formats, baseName) {
    const lines = [];
    const isWall = state.layoutMode === "wall";
    lines.push("MC 地图画生成器 - 输出文件说明");
    lines.push("=".repeat(30));
    lines.push("");
    lines.push("配置：");
    lines.push(`  游戏版本: ${state.version}`);
    if (state.textMode) {
      lines.push(`  输入方式: 文字模式`);
      lines.push(`  文字内容: ${(state.textInput || "").split("\n").join(" / ")}`);
      lines.push(`  字体: ${(K.TEXT_FONTS.find((f) => f.id === state.textFont) || {}).name || state.textFont}，大小 ${state.textSize}`);
    }
    if (isWall) {
      lines.push(`  布局模式: 立式（墙面像素画）`);
      lines.push(`  墙面尺寸: ${state.wallW} × ${state.wallH} 方块（1 格 = 1 像素，厚 1 格）`);
      lines.push(`  说明: 图片顶部在墙的最上方，墙的底边在 y=0，朝南（+Z）方向观看`);
    } else {
      if (state.blockSizeMode) {
        lines.push(`  布局模式: 平铺（地面像素画，非地图尺寸）`);
        lines.push(`  画布尺寸: ${state.blockW} × ${state.blockH} 方块（1 格 = 1 像素）`);
      } else {
        lines.push(`  布局模式: 平铺（地面地图画）`);
        lines.push(`  地图网格: ${state.mapsX} × ${state.mapsY} 张 (${state.mapsX * 128} × ${state.mapsY * 128} 像素)`);
      }
      lines.push(`  3D 模式: ${Object.values(K.STAIRCASING).find((m) => m.id === state.staircase).name}`);
      lines.push(`  支撑方块模式: ${Object.values(K.SUPPORT_MODES).find((m) => m.id === state.supportMode).name}`);
      lines.push(`  对齐行(noobline): ${state.includeNoobline ? "包含" : "不包含"}`);
    }
    lines.push(`  抖动: ${Object.values(K.DITHER_METHODS).find((m) => m.id === state.dither).name}`);
    if (isDiffusionApplicable()) lines.push(`  扩散强度: ${state.diffusionStrength}%`);
    lines.push(`  颜色匹配: ${state.colourMetric === "rgb" ? "RGB 欧氏距离" : state.colourMetric === "lab" ? "Lab 色彩空间" : "CIEDE2000 感知色差"}`);
    lines.push(`  孤立像素抑制: ${state.isolatedCleanup ? "开（" + state.isolatedPasses + " 遍）" : "关"}`);
    lines.push(`  透明背景: ${state.transparentBg ? "开" : "关"}${isPngImage() ? "（PNG 生效）" : "（当前图片不是 PNG）"}`);
    lines.push(`  已启用颜色: ${getSelectedBlockCount()} 种`);
    lines.push("");
    lines.push("各文件夹用法：");
    if (formats.includes("nbt")) {
      if (isWall) {
        if (state.nbtMode === "merged") {
          lines.push(`  [Schematic-NBT/] 整面墙一个 .nbt 文件（${baseName}.nbt）`);
        } else {
          lines.push(`  [Schematic-NBT/] 墙面按 128×128 方块分区，每区一个 .nbt 文件（${baseName}_part_x_y.nbt）`);
        }
        lines.push(`    - 使用 Litematica：放入 .minecraft/schematics/ 文件夹，游戏内加载`);
        lines.push(`    - 使用 Schematica：放入 .minecraft/schematics/ 文件夹后加载`);
        lines.push(`    - 也可以导入 Baritone (build schematic) 或 WorldEdit (/schematic load)`);
      } else if (state.nbtMode === "merged") {
        lines.push(`  [Schematic-NBT/] 整幅地图画一个 .nbt 文件（${baseName}.nbt）`);
        lines.push(`    - 使用 Litematica：放入 .minecraft/schematics/ 文件夹，游戏内加载`);
        lines.push(`    - 使用 Schematica：放入 .minecraft/schematics/ 文件夹后加载`);
        lines.push(`    - 也可以导入 Baritone (build schematic) 或 WorldEdit (/schematic load)`);
      } else if (state.blockSizeMode) {
        lines.push(`  [Schematic-NBT/] 按 128×128 分区，每区一个 .nbt 文件（${baseName}_part_x_y.nbt）`);
        lines.push(`    - 使用 Litematica：放入 .minecraft/schematics/ 文件夹，游戏内加载`);
        lines.push(`    - 使用 Schematica：放入 .minecraft/schematics/ 文件夹后加载`);
        lines.push(`    - 也可以导入 Baritone (build schematic) 或 WorldEdit (/schematic load)`);
      } else {
        lines.push(`  [Schematic-NBT/] 每张地图一个 .nbt 文件 (Schematica 格式)`);
        lines.push(`    - 文件名 ${baseName}_map_x_y.nbt，x 为横向、y 为纵向序号`);
        lines.push(`    - 使用 Litematica：放入 .minecraft/schematics/ 文件夹，游戏内加载`);
        lines.push(`    - 使用 Schematica：放入 .minecraft/schematics/ 文件夹后加载`);
        lines.push(`    - 也可以导入 Baritone (build schematic) 或 WorldEdit (/schematic load)`);
      }
    }
    if (formats.includes("litematic")) {
      if (isWall) {
        if (state.litematicMode === "split") {
          lines.push(`  [Litematic/] 墙面按 128×128 方块分区，每区一个 .litematic 文件`);
          lines.push(`    - 文件名 ${baseName}_part_x_y.litematic，x 为横向、y 为纵向序号`);
          lines.push(`    - 放入 .minecraft/schematics/ 文件夹，游戏内按 M 打开加载`);
        } else {
          lines.push(`  [Litematic/] 整面墙一个 .litematic 文件（Litematica 模组专用格式）`);
          lines.push(`    - 放入 .minecraft/schematics/ 文件夹，游戏内按 M 打开加载`);
        }
      } else if (state.blockSizeMode) {
        lines.push(`  [Litematic/] 按 128×128 分区，每区一个 .litematic 文件`);
        lines.push(`    - 文件名 ${baseName}_part_x_y.litematic，x 为横向、y 为纵向序号`);
        lines.push(`    - 放入 .minecraft/schematics/ 文件夹，游戏内按 M 打开加载`);
      } else if (state.litematicMode === "split") {
        lines.push(`  [Litematic/] 每张地图一个 .litematic 文件（Litematica 模组专用格式）`);
        lines.push(`    - 共 ${state.mapsX * state.mapsY} 个文件，文件名 ${baseName}_map_x_y.litematic，x 为横向、y 为纵向序号`);
        lines.push(`    - 放入 .minecraft/schematics/ 文件夹，游戏内按 M 打开加载`);
        lines.push(`    - 按 5×5 排列逐一放置即可拼成整幅画`);
      } else {
        lines.push(`  [Litematic/] 整幅地图画一个 .litematic 文件（Litematica 模组专用格式）`);
        lines.push(`    - 放入 .minecraft/schematics/ 文件夹，游戏内按 M 打开加载`);
        lines.push(`    - 该文件为整图合并，加载后可一键铺放`);
      }
    }
    if (formats.includes("mapdat")) {
      lines.push(`  [MapData/] 每张地图一个 map_*.dat 文件（直接替换存档数据）`);
      lines.push(`    - 放入存档的 data/ 文件夹（注意地图 ID 不能与已有地图冲突）`);
      lines.push(`    - 文件内的地图 ID 编号：map_${state.mapdatIdStart} 起，共 ${state.mapsX * state.mapsY} 个`);
    }
    lines.push("");
    lines.push("提示：");
    if (isWall) {
      lines.push("  - 立式模式生成的是一堵 1 格厚的竖墙，直接观看，不用于地图");
      lines.push("  - 方块已限制为可贴在墙上的固体方块（沙子等重力方块在墙内有下方支撑不会掉落）");
      lines.push("  - 建议选一块平整地面放置，墙的底边落在 y=0");
    } else if (state.blockSizeMode) {
      lines.push("  - 本作品为非地图尺寸的地面像素画，不受 128×128 网格对齐限制");
      lines.push("  - 图片会缩放为输入的方块尺寸，按 128×128 分区输出文件，边缘不足一格的部分不会生成");
      lines.push("  - 该模式不支持 map.dat 输出；如需地图画请关闭“按方块尺寸”开关");
    } else {
      lines.push("  - 地图画在游戏中固定对齐 128×128 网格，地图以北为正上方");
      lines.push("  - 无支撑时仅生成画面方块，可直接粘贴在平整地面上");
      lines.push("  - 开启“包含北侧对齐行”可帮助地图精确对齐，生成后需手动拆掉");
    }
    lines.push("");
    if (isBatchMode()) {
      lines.push("注意：本次为分批计算模式（地图数超过 64×64），文件按批打包下载，");
      lines.push("      所有批次的文件合起来才是完整作品（文件名均为正常命名）。");
      lines.push("");
    }
    lines.push("问题反馈：QQ 群 249694605");
    return new TextEncoder().encode(lines.join("\r\n"));
  }

  function setProgress(p) {
    $("genProgressBar").style.width = Math.round(p * 100) + "%";
  }

  function setStatus(text) {
    $("genStatus").textContent = text;
  }

  function yieldToUI() {
    return new Promise((resolve) => setTimeout(resolve, 30));
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  let toastTimer = null;
  function toast(msg, isError) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.toggle("error", !!isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 4000);
  }

  /* ---------------- boot ---------------- */

  document.addEventListener("DOMContentLoaded", init);
})();
