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
    mapsX: 1,
    mapsY: 1,
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
    staircase: K.STAIRCASING.CLASSIC.id,
    dither: K.DITHER_METHODS.FloydSteinberg.id,
    betterColour: true,
    transparency: false,
    transparencyTolerance: 128,
    mapdatUnobtainable: false,
    mapdatUseId: true,
    mapdatIdStart: 0,
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

    // default block selection: "Everything" preset
    applyPreset(0);
    renderPalette();
    updatePaletteCount();

    // events
    bindEvents();
    // sync checkbox/radio UI with initial state
    $("showGrid").checked = state.showGrid;
    $("mapdatUseId").checked = state.mapdatUseId;
    $("toolBadge").textContent = "工具 " + K.TOOL_VERSION;
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

    // number inputs
    $("mapsX").addEventListener("change", (e) => {
      state.mapsX = clampInt(e.target.value, 1, 64);
      e.target.value = state.mapsX;
      updateSizeHint();
      schedulePreview();
    });
    $("mapsY").addEventListener("change", (e) => {
      state.mapsY = clampInt(e.target.value, 1, 64);
      e.target.value = state.mapsY;
      updateSizeHint();
      schedulePreview();
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
    bindSlider("transpTolerance", "transpTolVal", (v) => v, (v) => (state.transparencyTolerance = v));

    // checkboxes
    bindCheck("preprocEnabled", (v) => (state.preprocEnabled = v));
    bindCheck("betterColour", (v) => (state.betterColour = v));
    bindCheck("transparency", (v) => {
      state.transparency = v;
      $("transpToleranceField").hidden = !v;
    });
    bindCheck("mapdatUnobtainable", (v) => (state.mapdatUnobtainable = v));
    bindCheck("mapdatUseId", (v) => {
      state.mapdatUseId = v;
      $("mapdatIdStartField").hidden = !v;
    });
    bindCheck("includeNoobline", (v) => (state.includeNoobline = v));
    bindCheck("showGrid", (v) => (state.showGrid = v));

    $("bgColor").addEventListener("input", (e) => {
      state.bgColor = e.target.value;
      schedulePreview();
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
      presetRow.appendChild(btn);
    }
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "btn btn-small btn-danger";
    clearBtn.id = "btnClearBlocks";
    clearBtn.textContent = "全部清除";
    presetRow.appendChild(clearBtn);
    presetRow.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-preset]");
      if (btn) {
        applyPreset(parseInt(btn.dataset.preset, 10));
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
    let name = (state.imageName || "mapart").replace(/\.[^.]+$/, "");
    name = name.replace(/[^\w\u4e00-\u9fa5-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    return name || "mapart";
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
    $("sizeHint").textContent = `共 ${state.mapsX * state.mapsY} 张地图，图片将被缩放为 ${state.mapsX * 128} × ${state.mapsY * 128} 像素`;
  }

  function updateGenName() {
    $("genName").textContent = getBaseName();
  }

  function updateGenUI() {
    const formats = getSelectedFormats();
    const btn = $("btnGenerate");
    btn.disabled = state.generating || formats.length === 0 || getSelectedBlockCount() === 0;
    $("btnGenerateText").textContent = state.generating ? "生成中…" : "生成并下载";
    $("genStatus").textContent = state.generating
      ? "正在生成…"
      : formats.length === 0
        ? "请选择至少一种输出格式"
        : getSelectedBlockCount() === 0
          ? "请先启用至少一个颜色"
          : "就绪";
  }

  function updateMapdatOptsVisibility() {
    const mapdatOn = state.formats.mapdat;
    $("mapdatOpts").style.display = mapdatOn ? "" : "none";
    $("mapdatOpts2").style.display = mapdatOn ? "" : "none";
    $("mapdatIdStartField").style.display = mapdatOn && state.mapdatUseId ? "" : "none";
    $("transpToleranceField").style.display = mapdatOn && state.transparency ? "" : "none";
  }

  /* ---------------- generator / quantization ---------------- */

  function getGenSignature() {
    return JSON.stringify({
      v: state.version,
      s: state.staircase,
      d: state.dither,
      b: state.betterColour,
      t: state.transparency && state.formats.mapdat,
      tt: state.transparencyTolerance,
      u: state.mapdatUnobtainable,
      sb: state.selectedBlocks,
      img: state.image ? state.image.src : null,
      mx: state.mapsX,
      my: state.mapsY,
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

  function newGenerator() {
    return new MapGenerator(C, {
      mcVersion: state.version,
      staircaseId: state.staircase,
      supportModeId: state.supportMode,
      supportBlock: state.supportBlock,
      includeNoobline: state.includeNoobline,
      betterColour: state.betterColour,
      ditherId: state.dither,
      selectedBlocks: state.selectedBlocks,
      transparency: state.transparency && state.formats.mapdat,
      transparencyTolerance: state.transparencyTolerance,
      mapdatUnobtainable: state.mapdatUnobtainable,
    });
  }

  // prepare source pixels (crop + preprocess)
  function prepareSourceImage() {
    const mapsX = state.mapsX;
    const mapsY = state.mapsY;
    const tw = mapsX * 128;
    const th = mapsY * 128;
    const img = state.image;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;

    const canvas = document.createElement("canvas");
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

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
    ctx.imageSmoothingEnabled = !(iw <= tw && ih <= th);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, tw, th);

    const imageData = ctx.getImageData(0, 0, tw, th);
    if (state.preprocEnabled || state.bgMode !== K.BACKGROUND_MODES.OFF.id) {
      applyPreprocess(imageData.data);
    }
    return imageData;
  }

  function applyPreprocess(data) {
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
    const signature = getGenSignature();
    if (state.gen && state.genSignature === signature && state.quantized && state.layouts) {
      return { gen: state.gen, quantized: state.quantized, layouts: state.layouts };
    }
    const gen = newGenerator();
    gen.setup();
    const imageData = prepareSourceImage();
    const quantized = await gen.processImageData(imageData, state.mapsX, state.mapsY, onProgress);
    const layouts = gen.extractColoursLayouts(imageData.data, state.mapsX, state.mapsY);
    state.gen = gen;
    state.genSignature = signature;
    state.quantized = { pixels: imageData.data, maps: quantized.maps };
    state.layouts = layouts;
    return { gen, quantized: state.quantized, layouts };
  }

  /* ---------------- preview ---------------- */

  let previewTimer = null;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshPreview, 250);
  }

  async function refreshPreview() {
    if (!state.image) return;
    const token = ++state.previewToken;
    $("genStatus").textContent = "正在计算…";
    try {
      const { quantized } = await ensureQuantization(() => {});
      if (token !== state.previewToken) return;
      drawPreview();
      updateStats();
      $("previewInfo").textContent = `分辨率 ${state.mapsX * 128}×${state.mapsY * 128} · 地图 ${state.mapsX}×${state.mapsY} · 已启用 ${getSelectedBlockCount()}/61 色`;
      $("previewSize").textContent = `原图 ${state.image.naturalWidth}×${state.image.naturalHeight}`;
      updateGenUI();
    } catch (e) {
      console.error(e);
      if (token === state.previewToken) toast("预览生成失败：" + e.message, true);
    }
  }

  function drawPreview() {
    const canvas = $("preview");
    const wrap = $("canvasWrap");
    if (state.viewMode === "source" && state.image) {
      const img = state.image;
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0);
      $("canvasEmpty").hidden = true;
      return;
    }
    if (!state.quantized) {
      $("canvasEmpty").hidden = false;
      return;
    }
    const tw = state.mapsX * 128;
    const th = state.mapsY * 128;
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext("2d");
    const imgData = new ImageData(new Uint8ClampedArray(state.quantized.pixels), tw, th);
    ctx.putImageData(imgData, 0, 0);

    if (state.showGrid) {
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1;
      for (let x = 1; x < state.mapsX; x++) {
        ctx.beginPath();
        ctx.moveTo(x * 128 + 0.5, 0);
        ctx.lineTo(x * 128 + 0.5, th);
        ctx.stroke();
      }
      for (let y = 1; y < state.mapsY; y++) {
        ctx.beginPath();
        ctx.moveTo(0, y * 128 + 0.5);
        ctx.lineTo(tw, y * 128 + 0.5);
        ctx.stroke();
      }
    }
    $("canvasEmpty").hidden = true;
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
    if (state.supportMode !== K.SUPPORT_MODES.NONE.id || state.includeNoobline) {
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

  function updatePaletteCount() {
    $("paletteCount").textContent = `已启用 ${getSelectedBlockCount()} / ${Object.keys(C).length} 色`;
  }

  function renderPalette() {
    const list = $("blockList");
    list.innerHTML = "";
    const search = state.blockSearch;
    for (const [csId, cs] of Object.entries(C)) {
      const blocks = Object.entries(cs.blocks);
      const tone = cs.tonesRGB.normal || cs.tonesRGB.dark;
      const rgb = `rgb(${tone[0]},${tone[1]},${tone[2]})`;
      const blockNames = blocks.map(([, b]) => b.displayName).join(" ");
      if (search && !cs.colourName.toLowerCase().includes(search) && !blockNames.toLowerCase().includes(search)) continue;

      const item = document.createElement("div");
      item.className = "block-item" + (state.selectedBlocks[csId] !== "-1" ? " enabled" : "");

      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = rgb;

      const nameWrap = document.createElement("div");
      nameWrap.className = "block-item-name";
      nameWrap.innerHTML = `<span title="${esc(cs.colourName)}">${esc(cs.colourName)}</span><span class="label-sm">色号 ${csId}${cs.mapdatId !== undefined ? " · map " + cs.mapdatId : ""}</span>`;

      const sel = document.createElement("select");
      sel.dataset.cs = csId;
      const offOpt = document.createElement("option");
      offOpt.value = "-1";
      offOpt.textContent = "不启用";
      sel.appendChild(offOpt);
      for (const [blockId, block] of blocks) {
        const opt = document.createElement("option");
        opt.value = blockId;
        opt.textContent = block.displayName + (block.supportBlockMandatory ? " (需支撑)" : "");
        sel.appendChild(opt);
      }
      sel.value = state.selectedBlocks[csId] !== undefined ? String(state.selectedBlocks[csId]) : "-1";
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
        if (state.nbtMode === "merged") {
          const bytes = gen.buildSchematicNbtMerged(layouts, "MapArt Generator");
          files.push({ name: `${folder}/${baseName}.nbt`, data: bytes });
        } else {
          for (let my = 0; my < state.mapsY; my++) {
            for (let mx = 0; mx < state.mapsX; mx++) {
              const bytes = gen.buildSchematicNbt(layouts[my][mx].coloursLayout, "MapArt Generator");
              files.push({ name: `${folder}/map_${mx}_${my}.nbt`, data: bytes });
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
        if (state.litematicMode === "split") {
          for (let my = 0; my < state.mapsY; my++) {
            for (let mx = 0; mx < state.mapsX; mx++) {
              const single = [[layouts[my][mx]]];
              const bytes = gen.buildLitematicBytes(single, `${baseName}_map_${mx}_${my}`, "MapArt Generator");
              files.push({ name: `${folder}/${baseName}_map_${mx}_${my}.litematic`, data: bytes });
            }
          }
        } else {
          const bytes = gen.buildLitematicBytes(layouts, baseName, "MapArt Generator");
          files.push({ name: `${folder}/${baseName}.litematic`, data: bytes });
        }
        step += stepSize;
        setProgress(step);
      }

      if (formats.includes("mapdat")) {
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

  function buildReadme(formats, baseName) {
    const lines = [];
    lines.push("MC 地图画生成器 - 输出文件说明");
    lines.push("=".repeat(30));
    lines.push("");
    lines.push("配置：");
    lines.push(`  游戏版本: ${state.version}`);
    lines.push(`  地图网格: ${state.mapsX} × ${state.mapsY} 张 (${state.mapsX * 128} × ${state.mapsY * 128} 像素)`);
    lines.push(`  3D 模式: ${Object.values(K.STAIRCASING).find((m) => m.id === state.staircase).name}`);
    lines.push(`  抖动: ${Object.values(K.DITHER_METHODS).find((m) => m.id === state.dither).name}`);
    lines.push(`  支撑方块模式: ${Object.values(K.SUPPORT_MODES).find((m) => m.id === state.supportMode).name}`);
    lines.push(`  对齐行(noobline): ${state.includeNoobline ? "包含" : "不包含"}`);
    lines.push(`  已启用颜色: ${getSelectedBlockCount()} 种`);
    lines.push("");
    lines.push("各文件夹用法：");
    if (formats.includes("nbt")) {
      if (state.nbtMode === "merged") {
        lines.push(`  [Schematic-NBT/] 整幅地图画一个 .nbt 文件（${baseName}.nbt）`);
        lines.push(`    - 使用 Litematica：放入 .minecraft/schematics/ 文件夹，游戏内加载`);
        lines.push(`    - 使用 Schematica：放入 .minecraft/schematics/ 文件夹后加载`);
        lines.push(`    - 也可以导入 Baritone (build schematic) 或 WorldEdit (/schematic load)`);
      } else {
        lines.push(`  [Schematic-NBT/] 每张地图一个 .nbt 文件 (Schematica 格式)`);
        lines.push(`    - 使用 Litematica：放入 .minecraft/schematics/ 文件夹，游戏内加载`);
        lines.push(`    - 使用 Schematica：放入 .minecraft/schematics/ 文件夹后加载`);
        lines.push(`    - 也可以导入 Baritone (build schematic) 或 WorldEdit (/schematic load)`);
      }
    }
    if (formats.includes("litematic")) {
      if (state.litematicMode === "split") {
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
    lines.push("  - 地图画在游戏中固定对齐 128×128 网格，地图以北为正上方");
    lines.push("  - 无支撑时仅生成画面方块，可直接粘贴在平整地面上");
    lines.push("  - 开启“包含北侧对齐行”可帮助地图精确对齐，生成后需手动拆掉");
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
