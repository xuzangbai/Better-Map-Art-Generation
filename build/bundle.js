/* Bundle the whole tool into a single self-contained HTML file. */
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const outFile = path.join(root, "地图画生成器_单文件版.html");

let html = fs.readFileSync(path.join(root, "index.html"), "utf8");

// inline CSS
html = html.replace(/<link rel="stylesheet" href="css\/style.css">/g, (m) => {
  const css = fs.readFileSync(path.join(root, "css", "style.css"), "utf8");
  return "<style>\n" + css + "\n</style>";
});

// inline each local script (skip external URLs)
html = html.replace(/<script src="([^"]+)"><\/script>/g, (m, src) => {
  if (/^https?:/.test(src)) return m;
  const js = fs.readFileSync(path.join(root, src), "utf8");
  return "<script>\n" + js + "\n</script>";
});

// verify no external references remain
const leftovers = (html.match(/(?:href|src)="(?!data:|#)[^"]*(?:\.css|\.js)"/g) || []);
fs.writeFileSync(outFile, html);
console.log("bundled:", outFile, fs.statSync(outFile).size, "bytes");
console.log("leftover external refs:", leftovers.length ? leftovers.join(", ") : "none");
