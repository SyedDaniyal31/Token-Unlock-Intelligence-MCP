const fs = require("fs");
const path = require("path");
const src = path.join(__dirname, "..", "sql");
const dest = path.join(__dirname, "..", "dist", "sql");
if (fs.existsSync(src)) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const srcPath = path.join(src, name);
    const destPath = path.join(dest, name);
    if (fs.statSync(srcPath).isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
