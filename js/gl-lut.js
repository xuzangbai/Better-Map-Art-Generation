"use strict";

/* GPU acceleration: builds an exact 256x256x256 colour lookup table (LUT) with WebGL2.
   Each table entry stores the nearest and second-nearest palette entry for that exact RGB,
   using the same distance formulas as the CPU implementation, so results are identical.

   Falls back gracefully (isSupported() === false) when WebGL2 is unavailable. */

window.GLLut = (() => {
  const SIZE = 4096; // 256*256 texels: x = r*16 + g>>4, y = b*16 + (g&15)
  const STRIPS = 16;
  const STRIP_H = SIZE / STRIPS;

  let supported = null;

  function isSupported() {
    if (supported !== null) return supported;
    try {
      if (typeof document === "undefined") {
        supported = false;
        return supported;
      }
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2", { antialias: false, depth: false, stencil: false });
      supported = !!gl;
      if (gl) {
        const lose = gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
      }
    } catch (e) {
      supported = false;
    }
    return supported;
  }

  const VERT_SRC = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  const FRAG_SRC = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uPalette;
uniform sampler2D uPaletteLab1;
uniform sampler2D uPaletteLab2;
uniform int uCount;
uniform int uMetric; // 0 = rgb, 1 = lab (mapartcraft), 2 = ciede2000

out vec4 outColor;

/* mapartcraft-style Lab (same constants as the CPU implementation) */
vec3 rgb2labMapart(vec3 c255) {
  float r1 = c255.r / 255.0;
  float g1 = c255.g / 255.0;
  float b1 = c255.b / 255.0;
  r1 = r1 <= 0.04045 ? r1 / 12.0 : pow((r1 + 0.055) / 1.055, 2.4);
  g1 = g1 <= 0.04045 ? g1 / 12.0 : pow((g1 + 0.055) / 1.055, 2.4);
  b1 = b1 <= 0.04045 ? b1 / 12.0 : pow((b1 + 0.055) / 1.055, 2.4);
  float f = (0.43605202 * r1 + 0.3850816 * g1 + 0.14308742 * b1) / 0.964221;
  float h = 0.22249159 * r1 + 0.71688604 * g1 + 0.060621485 * b1;
  float k = (0.013929122 * r1 + 0.097097 * g1 + 0.7141855 * b1) / 0.825211;
  float l = h > 0.008856452 ? pow(h, 1.0 / 3.0) : (903.2963 * h + 16.0) / 116.0;
  float m = 500.0 * ((f > 0.008856452 ? pow(f, 1.0 / 3.0) : (903.2963 * f + 16.0) / 116.0) - l);
  float n = 200.0 * (l - (k > 0.008856452 ? pow(k, 1.0 / 3.0) : (903.2963 * k + 16.0) / 116.0));
  return vec3(2.55 * (116.0 * l - 16.0) + 0.5, m + 0.5, n + 0.5);
}

/* standard CIELAB (D65), used by CIEDE2000 */
vec3 rgb2labStd(vec3 c255) {
  float r = c255.r / 255.0;
  float g = c255.g / 255.0;
  float b = c255.b / 255.0;
  r = r > 0.04045 ? pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
  g = g > 0.04045 ? pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
  b = b > 0.04045 ? pow((b + 0.055) / 1.055, 2.4) : b / 12.92;
  float x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  float y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  float z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  float fx = x > 0.008856 ? pow(x, 1.0 / 3.0) : 7.787 * x + 16.0 / 116.0;
  float fy = y > 0.008856 ? pow(y, 1.0 / 3.0) : 7.787 * y + 16.0 / 116.0;
  float fz = z > 0.008856 ? pow(z, 1.0 / 3.0) : 7.787 * z + 16.0 / 116.0;
  return vec3(116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz));
}

float deltaE2000(vec3 lab1, vec3 lab2) {
  float L1 = lab1.x, a1 = lab1.y, b1 = lab1.z;
  float L2 = lab2.x, a2 = lab2.y, b2 = lab2.z;
  float C1 = sqrt(a1 * a1 + b1 * b1);
  float C2 = sqrt(a2 * a2 + b2 * b2);
  float Cbar = (C1 + C2) * 0.5;
  float Cbar7 = pow(Cbar, 7.0);
  float G = 0.5 * (1.0 - sqrt(Cbar7 / (Cbar7 + 6103515625.0)));
  float a1p = (1.0 + G) * a1;
  float a2p = (1.0 + G) * a2;
  float C1p = sqrt(a1p * a1p + b1 * b1);
  float C2p = sqrt(a2p * a2p + b2 * b2);
  float h1p = C1p == 0.0 ? 0.0 : degrees(atan(b1, a1p));
  float h2p = C2p == 0.0 ? 0.0 : degrees(atan(b2, a2p));
  float h1pPos = h1p < 0.0 ? h1p + 360.0 : h1p;
  float h2pPos = h2p < 0.0 ? h2p + 360.0 : h2p;
  float dLp = L2 - L1;
  float dCp = C2p - C1p;
  float dhp = 0.0;
  if (C1p * C2p != 0.0) {
    dhp = h2pPos - h1pPos;
    if (dhp > 180.0) dhp -= 360.0;
    else if (dhp < -180.0) dhp += 360.0;
  }
  float dHp = 2.0 * sqrt(C1p * C2p) * sin(radians(dhp * 0.5));
  float Lbarp = (L1 + L2) * 0.5;
  float Cbarp = (C1p + C2p) * 0.5;
  float hbarp;
  if (C1p * C2p == 0.0) {
    hbarp = h1pPos + h2pPos;
  } else {
    float diff = abs(h1pPos - h2pPos);
    float sum = h1pPos + h2pPos;
    if (diff <= 180.0) hbarp = sum * 0.5;
    else if (sum < 360.0) hbarp = (sum + 360.0) * 0.5;
    else hbarp = (sum - 360.0) * 0.5;
  }
  float T = 1.0
    - 0.17 * cos(radians(hbarp - 30.0))
    + 0.24 * cos(radians(2.0 * hbarp))
    + 0.32 * cos(radians(3.0 * hbarp + 6.0))
    - 0.20 * cos(radians(4.0 * hbarp - 63.0));
  float dTheta = 30.0 * exp(-pow((hbarp - 275.0) / 25.0, 2.0));
  float Cbarp7 = pow(Cbarp, 7.0);
  float RC = 2.0 * sqrt(Cbarp7 / (Cbarp7 + 6103515625.0));
  float L50sq = pow(Lbarp - 50.0, 2.0);
  float SL = 1.0 + (0.015 * L50sq) / sqrt(20.0 + L50sq);
  float SC = 1.0 + 0.045 * Cbarp;
  float SH = 1.0 + 0.015 * Cbarp * T;
  float RT = -sin(radians(2.0 * dTheta)) * RC;
  float dL = dLp / SL;
  float dC = dCp / SC;
  float dH = dHp / SH;
  return sqrt(dL * dL + dC * dC + dH * dH + RT * dC * dH);
}

void main() {
  int x = int(gl_FragCoord.x);
  int y = int(gl_FragCoord.y);
  int ri = x >> 4;
  int gi = ((x & 15) << 4) | (y & 15);
  int bi = y >> 4;
  vec3 c255 = vec3(float(ri), float(gi), float(bi));

  /* replicate the CPU two-nearest search exactly (including its order-dependent second-best rule) */
  int i1 = -1;
  int i2 = -1;
  float d1 = 1e30;
  float d2 = 1e30;
  vec3 labC = uMetric == 1 ? rgb2labMapart(c255) : rgb2labStd(c255);

  for (int i = 0; i < 256; i++) {
    if (i >= uCount) break;
    float d;
    if (uMetric == 0) {
      vec3 p = texture(uPalette, vec2((float(i) + 0.5) / 256.0, 0.5)).rgb * 255.0;
      vec3 diff = c255 - p;
      d = dot(diff, diff);
    } else if (uMetric == 1) {
      vec3 pl = texture(uPaletteLab1, vec2((float(i) + 0.5) / 256.0, 0.5)).rgb;
      vec3 diff = labC - pl;
      d = dot(diff, diff);
    } else {
      vec3 pl = texture(uPaletteLab2, vec2((float(i) + 0.5) / 256.0, 0.5)).rgb;
      float de = deltaE2000(labC, pl);
      d = de * de;
    }
    if (d < d1) {
      d1 = d;
      i1 = i;
    }
    if (d < d2 && i1 >= 0) {
      vec3 pc1 = texture(uPalette, vec2((float(i1) + 0.5) / 256.0, 0.5)).rgb;
      vec3 pi = texture(uPalette, vec2((float(i) + 0.5) / 256.0, 0.5)).rgb;
      if (pc1 != pi) {
        d2 = d;
        i2 = i;
      }
    }
  }

  /* CPU correction step: if the best colour fits the pixel better than the second does, use it twice */
  if (i2 < 0) {
    i2 = i1;
  } else {
    vec3 pc1 = texture(uPalette, vec2((float(i1) + 0.5) / 256.0, 0.5)).rgb * 255.0;
    float dCorr;
    if (uMetric == 0) {
      vec3 pc2 = texture(uPalette, vec2((float(i2) + 0.5) / 256.0, 0.5)).rgb * 255.0;
      vec3 diff = pc1 - pc2;
      dCorr = dot(diff, diff);
    } else if (uMetric == 1) {
      vec3 pl1 = rgb2labMapart(pc1);
      vec3 pl2 = texture(uPaletteLab1, vec2((float(i2) + 0.5) / 256.0, 0.5)).rgb;
      vec3 diff = pl1 - pl2;
      dCorr = dot(diff, diff);
    } else {
      vec3 pl1 = rgb2labStd(pc1);
      vec3 pl2 = texture(uPaletteLab2, vec2((float(i2) + 0.5) / 256.0, 0.5)).rgb;
      float de = deltaE2000(pl1, pl2);
      dCorr = de * de;
    }
    if (dCorr <= d2) i2 = i1;
  }

  outColor = vec4(float(i1) / 255.0, float(i2) / 255.0, 0.0, 1.0);
}`;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error("shader compile failed: " + log);
    }
    return sh;
  }

  /* palette: [{rgb: [r,g,b], ...}, ...], metric: "rgb" | "lab" | "ciede2000" */
  async function build(palette, metric, onProgress) {
    if (!isSupported()) throw new Error("WebGL2 unavailable");
    const count = palette.length;
    if (count === 0 || count > 255) throw new Error("palette size out of range for GPU LUT");

    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const gl = canvas.getContext("webgl2", { antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 context creation failed");

    const vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error("program link failed: " + gl.getProgramInfoLog(prog));
    }
    gl.useProgram(prog);

    const mkTex = (internalFormat, format, type, data) => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 256, 1, 0, format, type, data);
      return tex;
    };

    const palBytes = new Uint8Array(256 * 4);
    const palLab1 = new Float32Array(256 * 4);
    const palLab2 = new Float32Array(256 * 4);
    for (let i = 0; i < count; i++) {
      const rgb = palette[i].rgb;
      palBytes[i * 4] = rgb[0];
      palBytes[i * 4 + 1] = rgb[1];
      palBytes[i * 4 + 2] = rgb[2];
      palBytes[i * 4 + 3] = 255;
      const l1 = rgb2labMapartJS(rgb);
      palLab1[i * 4] = l1[0];
      palLab1[i * 4 + 1] = l1[1];
      palLab1[i * 4 + 2] = l1[2];
      palLab1[i * 4 + 3] = 1;
      const l2 = rgb2labStdJS(rgb);
      palLab2[i * 4] = l2[0];
      palLab2[i * 4 + 1] = l2[1];
      palLab2[i * 4 + 2] = l2[2];
      palLab2[i * 4 + 3] = 1;
    }

    gl.uniform1i(gl.getUniformLocation(prog, "uPalette"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "uPaletteLab1"), 1);
    gl.uniform1i(gl.getUniformLocation(prog, "uPaletteLab2"), 2);
    gl.uniform1i(gl.getUniformLocation(prog, "uCount"), count);
    gl.uniform1i(gl.getUniformLocation(prog, "uMetric"), metric === "rgb" ? 0 : metric === "lab" ? 1 : 2);

    /* render target first (and unbind it) so it does not clash with the palette texture units */
    const target = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, SIZE, SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("framebuffer incomplete");
    }
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.activeTexture(gl.TEXTURE0);
    mkTex(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, palBytes);
    gl.activeTexture(gl.TEXTURE1);
    mkTex(gl.RGBA32F, gl.RGBA, gl.FLOAT, palLab1);
    gl.activeTexture(gl.TEXTURE2);
    mkTex(gl.RGBA32F, gl.RGBA, gl.FLOAT, palLab2);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    const nearest = new Uint8Array(256 * 256 * 256);
    const second = new Uint8Array(256 * 256 * 256);
    const strip = new Uint8Array(SIZE * STRIP_H * 4);

    for (let s = 0; s < STRIPS; s++) {
      const y0 = s * STRIP_H;
      gl.viewport(0, y0, SIZE, STRIP_H);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, y0, SIZE, STRIP_H, gl.RGBA, gl.UNSIGNED_BYTE, strip);
      for (let yy = 0; yy < STRIP_H; yy++) {
        const y = y0 + yy;
        const b = y >> 4;
        for (let x = 0; x < SIZE; x++) {
          const r = x >> 4;
          const g = ((x & 15) << 4) | (y & 15);
          const idx = (r << 16) | (g << 8) | b;
          const o = (yy * SIZE + x) * 4;
          nearest[idx] = strip[o];
          second[idx] = strip[o + 1];
        }
      }
      if (onProgress) onProgress((s + 1) / STRIPS);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(target);
    const lose = gl.getExtension("WEBGL_lose_context");
    if (lose) lose.loseContext();

    return { nearest, second, count };
  }

  /* small cache so crop/preprocess changes do not rebuild the table */
  const cache = new Map();
  const CACHE_MAX = 2;

  function getCached(key) {
    return cache.get(key) || null;
  }

  function setCached(key, lut) {
    cache.set(key, lut);
    while (cache.size > CACHE_MAX) {
      const first = cache.keys().next().value;
      cache.delete(first);
    }
  }

  /* JS copies of the Lab conversions, used to upload palette values (identical to generator.js) */
  function rgb2labMapartJS(rgb) {
    let r1 = rgb[0] / 255.0;
    let g1 = rgb[1] / 255.0;
    let b1 = rgb[2] / 255.0;
    r1 = 0.04045 >= r1 ? r1 / 12.0 : Math.pow((r1 + 0.055) / 1.055, 2.4);
    g1 = 0.04045 >= g1 ? g1 / 12.0 : Math.pow((g1 + 0.055) / 1.055, 2.4);
    b1 = 0.04045 >= b1 ? b1 / 12.0 : Math.pow((b1 + 0.055) / 1.055, 2.4);
    const f = (0.43605202 * r1 + 0.3850816 * g1 + 0.14308742 * b1) / 0.964221;
    const h = 0.22249159 * r1 + 0.71688604 * g1 + 0.060621485 * b1;
    const k = (0.013929122 * r1 + 0.097097 * g1 + 0.7141855 * b1) / 0.825211;
    const l = 0.008856452 < h ? Math.pow(h, 1 / 3) : (903.2963 * h + 16.0) / 116.0;
    const m = 500.0 * ((0.008856452 < f ? Math.pow(f, 1 / 3) : (903.2963 * f + 16.0) / 116.0) - l);
    const n = 200.0 * (l - (0.008856452 < k ? Math.pow(k, 1 / 3) : (903.2963 * k + 16.0) / 116.0));
    return [2.55 * (116.0 * l - 16.0) + 0.5, m + 0.5, n + 0.5];
  }

  function rgb2labStdJS(rgb) {
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
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  return { isSupported, build, getCached, setCached };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = {};
}
