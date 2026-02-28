const fs = require("fs");
const path = require("path");

// Copy sql/ to dist/sql
const sqlSrc = path.join(__dirname, "..", "sql");
const sqlDest = path.join(__dirname, "..", "dist", "sql");
if (fs.existsSync(sqlSrc)) {
  fs.mkdirSync(sqlDest, { recursive: true });
  for (const name of fs.readdirSync(sqlSrc)) {
    const srcPath = path.join(sqlSrc, name);
    const destPath = path.join(sqlDest, name);
    if (fs.statSync(srcPath).isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Copy manual_registry.csv to dist/scripts/ for Railway deploy
const csvSrc = path.join(__dirname, "..", "src", "scripts", "manual_registry.csv");
const scriptsDest = path.join(__dirname, "..", "dist", "scripts");
if (fs.existsSync(csvSrc)) {
  fs.mkdirSync(scriptsDest, { recursive: true });
  fs.copyFileSync(csvSrc, path.join(scriptsDest, "manual_registry.csv"));
}
