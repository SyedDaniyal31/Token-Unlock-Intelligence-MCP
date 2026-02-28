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

// Generate MANUAL_REGISTRY_SYMBOLS from CSV so assetResolution supports all manual-registry tokens
const genDest = path.join(__dirname, "..", "src", "intelligence", "manualRegistrySymbols.generated.ts");
if (fs.existsSync(csvSrc)) {
  const raw = fs.readFileSync(csvSrc, "utf-8");
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const symbols = new Set();
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",").map((p) => p.trim().replace(/^"|"$/g, ""));
    const sym = (parts[1] ?? "").trim().toUpperCase().replace(/^\$/, "");
    if (sym) symbols.add(sym);
  }
  const sorted = [...symbols].sort();
  const content = `/** Auto-generated from manual_registry.csv at build time. Do not edit. */\nexport const MANUAL_REGISTRY_SYMBOLS = new Set<string>([\n  ${sorted.map((s) => `"${s}"`).join(", ")},\n]);\n`;
  fs.writeFileSync(genDest, content, "utf-8");
}
