const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_FILE = path.join(ROOT, "data", "db.json");
const EXPORT_DIR = path.join(ROOT, "data", "exports");
const PORT = Number(process.env.PORT || 3000);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": type });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 5_000_000) {
        reject(new Error("Payload muito grande."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function loadDb() {
  if (!fs.existsSync(DATA_FILE)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function saveDb(db) {
  db.updatedAt = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), "utf8");
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return send(res, 403, "Acesso negado.", "text/plain; charset=utf-8");
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return send(res, 404, "Arquivo nao encontrado.", "text/plain; charset=utf-8");
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

function runPython(args) {
  return new Promise((resolve, reject) => {
    const bundledPython = path.join(
      process.env.USERPROFILE || "",
      ".cache",
      "codex-runtimes",
      "codex-primary-runtime",
      "dependencies",
      "python",
      "python.exe"
    );
    const py = process.env.PYTHON || (fs.existsSync(bundledPython) ? bundledPython : "python");
    const child = spawn(py, args, { cwd: ROOT, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    child.on("close", code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || stdout || `Python saiu com codigo ${code}`));
    });
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/data") {
    const db = loadDb();
    if (!db) return send(res, 404, { error: "Base nao inicializada. Rode python scripts/import_seed.py." });
    return send(res, 200, db);
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readJsonBody(req);
    const db = loadDb();
    const user = db?.users.find(item => item.username === body.username && item.password === body.password);
    if (!user) return send(res, 401, { error: "Usuario ou senha invalidos." });
    return send(res, 200, { user: { id: user.id, name: user.name, username: user.username, role: user.role } });
  }

  if (req.method === "POST" && url.pathname === "/api/save") {
    const db = await readJsonBody(req);
    if (!Array.isArray(db.schools) || !Array.isArray(db.entries) || !Array.isArray(db.users)) {
      return send(res, 400, { error: "Formato de dados invalido." });
    }
    saveDb(db);
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/export") {
    const body = await readJsonBody(req);
    if (!body.month || !/^\d{4}-\d{2}$/.test(body.month)) {
      return send(res, 400, { error: "Informe a competencia no formato AAAA-MM." });
    }
    try {
      const stdout = await runPython(["scripts/export_consolidated.py", body.month]);
      const result = JSON.parse(stdout);
      return send(res, 200, result);
    } catch (error) {
      return send(res, 500, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname.startsWith("/exports/")) {
    const file = path.basename(url.pathname);
    const filePath = path.join(EXPORT_DIR, file);
    if (!fs.existsSync(filePath)) return send(res, 404, "Exportacao nao encontrada.", "text/plain; charset=utf-8");
    res.writeHead(200, {
      "Content-Type": MIME[".xlsx"],
      "Content-Disposition": `attachment; filename="${file}"`
    });
    return fs.createReadStream(filePath).pipe(res);
  }

  return send(res, 404, { error: "Rota nao encontrada." });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/") || req.url.startsWith("/exports/")) {
      return await handleApi(req, res);
    }
    return serveStatic(req, res);
  } catch (error) {
    return send(res, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Sistema de apuracao rodando em http://localhost:${PORT}`);
});
