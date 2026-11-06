const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
process.chdir(ROOT);
const PUBLIC_DIR = path.join(ROOT, "public");
const PORT = Number(process.env.PORT || 3000);
if (process.argv.includes("--local")) process.env.LOCAL_MODE = "1";
const LOCAL = process.env.LOCAL_MODE === "1" || !process.env.SUPABASE_URL;
if (LOCAL) {
  const dataDir = process.env.LOCAL_DATA_DIR || path.join(ROOT, "local-data");
  if (!fs.existsSync(path.join(dataDir, "db.json"))) {
    console.log("Base local nao encontrada. Gerando local-data/ ...");
    require("child_process").execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed_local.js")], { stdio: "inherit" });
  }
}
const { handler } = require("./netlify/functions/api");
// API dos módulos novos: no modo local usa local-data/; em produção, Supabase (tabelas + Storage).
const modulesApi = require("./local/modules-api");
const MAX_BODY = LOCAL ? 60_000_000 : 5_000_000;
// Envio de anexos (até 25 MB em base64 ≈ 34 MB) e planilhas de pedido.
const MAX_MODULES_BODY = 40_000_000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

function send(res, status, body, type = "application/json; charset=utf-8", headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": type, ...headers });
  res.end(payload);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error("Payload muito grande."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  let baseDir = PUBLIC_DIR;
  if (LOCAL && pathname.startsWith("/uploads/")) {
    baseDir = modulesApi.UPLOADS_DIR;
    pathname = pathname.slice("/uploads".length);
  }
  const filePath = path.normalize(path.join(baseDir, pathname));
  if (!filePath.startsWith(baseDir)) {
    return send(res, 403, "Acesso negado.", "text/plain; charset=utf-8");
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return send(res, 404, "Arquivo nao encontrado.", "text/plain; charset=utf-8");
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

async function serveApi(req, res) {
  const body = await readBody(req);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const result = await handler({
    path: url.pathname,
    rawUrl: `https://${req.headers.host}${req.url}`,
    httpMethod: req.method,
    headers: req.headers,
    queryStringParameters: Object.fromEntries(url.searchParams.entries()),
    body,
    isBase64Encoded: false
  });

  const headers = result.headers || {};
  const contentType = headers["Content-Type"] || headers["content-type"] || "application/json; charset=utf-8";
  const payload = result.isBase64Encoded ? Buffer.from(result.body || "", "base64") : result.body || "";
  return send(res, result.statusCode || 200, payload, contentType, headers);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.split("?")[0] === "/local-env.js") {
      return send(res, 200, LOCAL ? "window.__LOCAL__ = true;" : "", "application/javascript; charset=utf-8");
    }
    if (req.url.startsWith("/api/m/")) {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const result = await modulesApi.handleModules({ method: req.method, pathname: url.pathname, headers: req.headers, body: await readBody(req, MAX_MODULES_BODY) });
      return send(res, result.status, result.body);
    }
    if (req.url.startsWith("/api/")) {
      return await serveApi(req, res);
    }
    return serveStatic(req, res);
  } catch (error) {
    return send(res, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Sistema de apuracao rodando em http://localhost:${PORT}${LOCAL ? "  [MODO LOCAL - sem Supabase/Hostinger]" : ""}`);
});
