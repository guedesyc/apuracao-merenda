// Catálogo do Inventário de Insumos (versão local).
// Fonte: data/inventario-2026.json, extraído da "Planilha de inventario 2026.xlsx" (aba "Planilha de Inventário (2)").
const path = require("path");
const fs = require("fs");

const INVENTORY_CATEGORIES = ["Secos", "Congelados", "Produtos de Limpeza / Descartáveis", "Aprender+"];
const SOURCE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "inventario-2026.json"), "utf8"));
const INVENTORY_ITEMS = SOURCE.items.map(item => [item.name, item.category, item.unit]);

module.exports = { INVENTORY_CATEGORIES, INVENTORY_ITEMS };
