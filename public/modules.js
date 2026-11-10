/* Módulos novos: Relatório de Supervisão, Analytics, Matriculados, Eventos,
   Notificações, Inventário de Insumos, Calculadora Per Capita (desabilitada) e Pendências.
   Depende das funções e do `state` definidos em app.js. */

// ---------------------------------------------------------------- utilidades
const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#6250d6", "#008300", "#e34948"];
const OTHER_COLOR = "#a3a7a5";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function isLocalBuild() {
  return Boolean(window.__LOCAL__);
}

function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function fmtDate(date) {
  if (!date) return "—";
  const [y, m, d] = String(date).slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

function fmtNumber(value, digits = 0) {
  return Number(value || 0).toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtMoneyShort(value) {
  const abs = Math.abs(value);
  if (abs >= 1e6) return `R$ ${fmtNumber(value / 1e6, 2)} mi`;
  if (abs >= 1e3) return `R$ ${fmtNumber(value / 1e3, 1)} mil`;
  return money(value);
}

function fmtBytes(bytes) {
  if (!bytes) return "";
  if (bytes > 1048576) return `${fmtNumber(bytes / 1048576, 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function daysBetween(fromISO, toISO) {
  return Math.round((new Date(`${toISO}T00:00:00`) - new Date(`${fromISO}T00:00:00`)) / 86400000);
}

function initials(name) {
  return String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase();
}

function currentMonth() {
  return state.db?.settings?.currentMonth || todayISO().slice(0, 7);
}

function schoolMap() {
  return new Map((state.db?.schools || []).map(school => [school.id, school]));
}

function userMap() {
  return new Map((state.db?.users || []).map(user => [user.id, user]));
}

function nutriList() {
  if (state.user.role !== "admin") return [state.user];
  return (state.db.users || []).filter(user => user.role === "nutritionist" && user.active !== false)
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

function schoolsOfNutri(nutriId) {
  return (state.db.schools || []).filter(school => (school.nutritionistIds || []).includes(nutriId))
    .sort((a, b) => a.shortName.localeCompare(b.shortName, "pt-BR"));
}

function nutriNamesOf(school) {
  const users = userMap();
  return (school.nutritionistIds || []).map(id => users.get(id)?.name || (id === state.user.id ? state.user.name : "")).filter(Boolean).join(", ");
}

function routeLabel(route) {
  return String(route || "SEM ROTA").replace(/^GRE\s+/, "GRE ");
}

function normalizeText(value) {
  return String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function toast(message, kind = "ok") {
  let host = document.querySelector(".toast-host");
  if (!host) {
    host = document.createElement("div");
    host.className = "toast-host";
    document.body.appendChild(host);
  }
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.innerHTML = `${icon(kind === "error" ? "alert" : "check")}<span>${esc(message)}</span>`;
  host.appendChild(el);
  setTimeout(() => el.classList.add("out"), 3200);
  setTimeout(() => el.remove(), 3700);
}

async function mapi(path, body) {
  return api(`/api/m/${path}`, body ? { method: "POST", body } : {});
}

async function mutate(path, body, success) {
  try {
    const result = await mapi(path, body);
    await loadModules();
    if (success) toast(success);
    render();
    return result;
  } catch (error) {
    toast(error.message, "error");
    throw error;
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Fotos são reduzidas no próprio celular antes do envio: no máximo 1600 px no lado maior e
// cerca de 300 KB (JPEG). Assim o envio fica rápido no 4G e o armazenamento rende mais.
// PDF, Word, planilhas e GIF vão como estão. Se algo falhar, envia o original.
const PHOTO_TARGET_BYTES = 300 * 1024;
const PHOTO_MAX_SIDE = 1600;

function canvasToBlob(canvas, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
}

async function decodeImage(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { /* tenta pelo <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function shrinkPhoto(file) {
  if (!/^image\/(jpeg|png|webp|heic|heif|bmp)$/i.test(file.type || "") || file.size <= PHOTO_TARGET_BYTES) return file;
  try {
    const image = await decodeImage(file);
    const width = image.width || image.naturalWidth;
    const height = image.height || image.naturalHeight;
    if (!width || !height) return file;
    let scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(width, height));
    let best = null;
    for (let round = 0; round < 4 && !(best && best.size <= PHOTO_TARGET_BYTES); round += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.82, 0.72, 0.62, 0.52]) {
        const blob = await canvasToBlob(canvas, quality);
        if (blob && (!best || blob.size < best.size)) best = blob;
        if (blob && blob.size <= PHOTO_TARGET_BYTES) break;
      }
      scale *= 0.8;
    }
    image.close?.();
    if (!best || best.size >= file.size) return file;
    const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([best], name, { type: "image/jpeg", lastModified: Date.now() });
  } catch {
    return file;
  }
}

async function uploadFiles(fileList) {
  const uploaded = [];
  for (const original of [...fileList]) {
    const file = await shrinkPhoto(original);
    if (file.size > 25 * 1024 * 1024) { toast(`${file.name}: maior que 25 MB.`, "error"); continue; }
    const data = await readFileAsBase64(file);
    uploaded.push(await mapi("upload", { name: file.name, type: file.type, data }));
  }
  return uploaded;
}

function isImage(file) {
  return /^image\//.test(file?.type || "") || /\.(png|jpe?g|webp|gif)$/i.test(file?.name || "");
}

function fileChip(file, removeAttr = "") {
  if (!file) return "";
  return `<div class="file-chip" title="${esc(file.name)}">
    ${icon(isImage(file) ? "image" : "paperclip")}
    <a href="${esc(file.url)}" target="_blank" rel="noopener">${esc(file.name)}</a>
    <small>${fmtBytes(file.size)}</small>
    ${removeAttr ? `<button type="button" class="chip-x" ${removeAttr} aria-label="Remover">${icon("x")}</button>` : ""}
  </div>`;
}

function photoGrid(photos, removePrefix = "") {
  if (!photos?.length) return "";
  return `<div class="photo-grid">${photos.map((photo, index) => `
    <figure class="photo">
      <a href="${esc(photo.url)}" target="_blank" rel="noopener"><img src="${esc(photo.url)}" alt="${esc(photo.name)}" loading="lazy" /></a>
      ${removePrefix ? `<button type="button" class="photo-x" ${removePrefix}="${index}" aria-label="Remover foto">${icon("x")}</button>` : ""}
    </figure>`).join("")}</div>`;
}

function pageHead({ eyebrow = "", title, subtitle = "", actions = "" }) {
  return `<header class="page-head">
    <div>
      ${eyebrow ? `<span class="eyebrow">${eyebrow}</span>` : ""}
      <h1>${title}</h1>
      ${subtitle ? `<p>${subtitle}</p>` : ""}
    </div>
    ${actions ? `<div class="page-actions">${actions}</div>` : ""}
  </header>`;
}

function statCard({ label, value, hint = "", tone = "", iconName = "" }) {
  return `<div class="stat ${tone}">
    ${iconName ? `<span class="stat-icon">${icon(iconName)}</span>` : ""}
    <div><span class="stat-label">${label}</span><strong class="stat-value">${value}</strong>${hint ? `<small>${hint}</small>` : ""}</div>
  </div>`;
}

function emptyState(title, text = "", iconName = "sparkles") {
  return `<div class="empty-state">${icon(iconName)}<strong>${title}</strong>${text ? `<p>${text}</p>` : ""}</div>`;
}

function unavailable() {
  return `<section class="panel">${emptyState("Módulo indisponível neste modo", "Os novos módulos funcionam com o servidor local (npm run local). No modo HML estático eles não são carregados.", "alert")}</section>`;
}

function routeOptionsHtml(selected) {
  return routes().map(route => `<option value="${esc(route)}" ${selected === route ? "selected" : ""}>${esc(routeLabel(route))}</option>`).join("");
}

// ---------------------------------------------------------------- ícones
const ICONS = {
  clipboard: '<path d="M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1Z"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  layout: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  fileCheck: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="m9 15 2 2 4-4"/>',
  chart: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  party: '<path d="M5.8 11.3 2 22l10.7-3.8"/><path d="M4 3h.01M22 8h.01M15 2h.01M22 20h.01"/><path d="m22 2-2.2.8a2.9 2.9 0 0 0-1.9 3.1v0a2 2 0 0 1-1.6 2.2L15 8.5"/><path d="M11 13c1.9 1.9 2.8 4.1 2 4.9s-3-.1-4.9-2-2.8-4.1-2-4.9 3 .1 4.9 2Z"/>',
  alertCircle: '<circle cx="12" cy="12" r="10"/><path d="M12 7v6"/><path d="M12 17h.01"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  package: '<path d="m7.5 4.3 9 5.2"/><path d="M21 8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7Z"/><path d="M3.3 7 12 12l8.7-5M12 22V12"/>',
  calculator: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8M16 14v4M16 10h.01M12 10h.01M8 10h.01M12 14h.01M8 14h.01M12 18h.01M8 18h.01"/>',
  listTodo: '<rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3 17 2 2 4-4M13 6h8M13 12h8M13 18h8"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronsLeft: '<path d="m11 17-5-5 5-5M18 17l-5-5 5-5"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  arrowRight: '<path d="M5 12h14M13 5l7 7-7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  paperclip: '<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  school: '<path d="m4 10 8-6 8 6"/><path d="M6 9v11h12V9"/><path d="M10 20v-5h4v5"/>',
  sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  utensils: '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2M7 2v20M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
  table: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  car: '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>',
  graduation: '<path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/>',
  cart: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
  fileSheet: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h8M12 11v8"/>',
  apple: '<path d="M12 20.94c1.5 0 2.75 1.06 4 1.06 3 0 6-8 6-12.22A4.91 4.91 0 0 0 17 5c-2.22 0-4 1.44-5 2-1-.56-2.78-2-5-2a4.9 4.9 0 0 0-5 4.78C2 14 5 22 8 22c1.25 0 2.5-1.06 4-1.06Z"/><path d="M10 2c1 .5 2 2 2 5"/>'
};

function icon(name) {
  return `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}

function brandMark() {
  return `<svg viewBox="0 0 48 48" aria-hidden="true">
    <defs><linearGradient id="bm-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2fbf8a"/><stop offset="1" stop-color="#0b5a43"/></linearGradient></defs>
    <rect width="48" height="48" rx="14" fill="url(#bm-g)"/>
    <path d="M11 25h26a13 13 0 0 1-26 0Z" fill="#fff"/>
    <path d="M24 21c0-6 4-9.5 9-10-.4 5.4-3.6 9.4-9 10Z" fill="#f6c453"/>
    <path d="M24 21c-.6-3.6-2.8-6-6.5-6.6.2 3.8 2.6 6.1 6.5 6.6Z" fill="#bff0d6"/>
  </svg>`;
}

function heroIllustration() {
  return `<svg viewBox="0 0 420 300" class="hero-svg" aria-hidden="true">
    <defs>
      <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e6f4ec"/></linearGradient>
      <linearGradient id="tray" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f7fbf8" stop-opacity=".22"/><stop offset="1" stop-color="#f7fbf8" stop-opacity=".06"/></linearGradient>
    </defs>
    <rect x="30" y="60" width="360" height="200" rx="34" fill="url(#tray)" stroke="rgba(255,255,255,.25)"/>
    <g class="float-a">
      <circle cx="140" cy="160" r="72" fill="url(#plate)"/>
      <circle cx="140" cy="160" r="54" fill="none" stroke="#cfe9da" stroke-width="2"/>
      <path d="M100 150c10-18 30-26 46-20 14 5 20 20 30 22-8 22-34 36-56 30-14-4-24-16-20-32Z" fill="#f4d58d"/>
      <circle cx="118" cy="140" r="6" fill="#e9b949"/><circle cx="132" cy="150" r="5" fill="#e9b949"/><circle cx="150" cy="142" r="5" fill="#e9b949"/>
      <path d="M150 170c8-10 26-12 34-4-4 14-24 22-34 4Z" fill="#7a4a2a"/>
      <path d="M104 180c6 10 22 14 32 8" stroke="#4caf7d" stroke-width="7" stroke-linecap="round" fill="none"/>
    </g>
    <g class="float-b">
      <rect x="250" y="96" width="98" height="72" rx="18" fill="#ffffff"/>
      <circle cx="282" cy="132" r="18" fill="#ef6b57"/><path d="M282 112c2-6 7-9 12-9-1 6-5 9-12 9Z" fill="#3fae6e"/>
      <circle cx="320" cy="134" r="14" fill="#f6c453"/>
    </g>
    <g class="float-c">
      <rect x="250" y="184" width="98" height="52" rx="16" fill="#ffffff"/>
      <rect x="266" y="200" width="66" height="8" rx="4" fill="#cfe9da"/>
      <rect x="266" y="214" width="42" height="8" rx="4" fill="#9fd6b8"/>
    </g>
    <g class="float-a" opacity=".9">
      <path d="M64 92c0-14 10-22 24-24-1 13-9 23-24 24Z" fill="#7fd6a6"/>
      <path d="M364 252c0-11 8-18 19-19-1 10-7 18-19 19Z" fill="#f6c453"/>
    </g>
  </svg>`;
}

// ---------------------------------------------------------------- estado dos módulos
function defaultUi() {
  return {
    sup: { search: "", route: "todas", nutri: "todas", month: currentMonth(), open: new Set(), openSchool: "", status: "todas" },
    an: null,
    mat: { search: "", route: "todas", nutri: "todas", seg: "todos", onlyEmpty: false, dirty: {} },
    evt: { search: "", route: "todas", nutri: "todas", status: "todos", showForm: false, editing: null },
    ntf: { showForm: false, open: new Set(), filter: "todas", school: "todas" },
    inv: { month: currentMonth(), search: "", show: "todos", school: "", dirty: {}, showForm: false, editing: null },
    reg: { month: currentMonth(), search: "", status: "todos", open: new Set(), openSchool: "" },
    dl: { month: currentMonth(), open: false, dirty: null },
    exp: { faturamento: currentMonth(), inventario: currentMonth(), busy: "" },
    ped: { step: "list", upload: null, openOrder: "", open: new Set(), openSchool: "" },
    aped: { order: "", dirty: {}, search: "" },
    hist: { order: "todos", school: "todas", nutri: "todas", action: "todas", search: "", open: new Set(), limit: 30 },
    km: { month: currentMonth(), dirty: {}, open: "", search: "" },
    cap: { month: currentMonth(), files: [], notes: "", uploading: 0, status: "todos" },
    pend: {}
  };
}

// ---------- Pedidos antigos: ficam no banco e só são buscados quando alguém clica ----------
function mergeOlderOrders(data) {
  const archive = state.modArchive;
  if (!archive?.loaded || !data) return;
  const ids = new Set((data.orders || []).map(order => order.id));
  data.orders = [...(data.orders || []), ...archive.orders.filter(order => !ids.has(order.id))];
}

function olderOrdersBar() {
  const info = mod().data.ordersArchive;
  if (!info) return "";
  const archive = state.modArchive;
  if (archive?.loaded) {
    return archive.orders.length
      ? `<div class="older-bar is-loaded">${icon("clock")}<span>Mostrando também <b>${fmtNumber(archive.orders.length)} pedido(s) anteriores</b> a ${esc(formatMonthBR(info.before))}, só para consulta.</span></div>`
      : `<div class="older-bar is-loaded">${icon("clock")}<span>Não há pedidos anteriores a ${esc(formatMonthBR(info.before))}.</span></div>`;
  }
  if (!info.count) return "";
  const isAdmin = state.user?.role === "admin";
  return `<div class="older-bar">${icon("clock")}<span>Aparecem os pedidos a partir de <b>${esc(formatMonthBR(info.before))}</b>.${isAdmin ? ` Há <b>${fmtNumber(info.count)}</b> pedido(s) anteriores guardados.` : " Os anteriores ficam guardados no histórico."}</span>
    <button type="button" class="secondary sm" data-older-orders ${state.modArchive?.loading ? "disabled" : ""}>${icon("download")} ${state.modArchive?.loading ? "Carregando..." : "Ver pedidos anteriores"}</button></div>`;
}

async function loadOlderOrders() {
  if (state.modArchive?.loading || state.modArchive?.loaded) return;
  state.modArchive = { loading: true, loaded: false, orders: [] };
  render();
  try {
    const result = await mapi("orders/older", {});
    state.modArchive = { loading: false, loaded: true, before: result.before, orders: (result.orders || []).map(order => ({ ...order, archived: true })) };
    mergeOlderOrders(mod().data);
    toast(result.orders?.length ? `${result.orders.length} pedido(s) anteriores carregados.` : "Não há pedidos anteriores.");
  } catch (error) {
    state.modArchive = null;
    toast(error.message, "error");
  }
  render();
}

document.addEventListener("click", event => {
  if (event.target.closest?.("[data-older-orders]")) loadOlderOrders();
});

async function loadModules() {
  const ui = state.mod?.ui || defaultUi();
  const drafts = state.mod?.drafts || {};
  try {
    const data = await mapi("state");
    mergeOlderOrders(data);
    state.mod = { available: true, data, ui, drafts };
  } catch (error) {
    state.mod = { available: false, data: emptyModules(), ui, drafts, error: error.message };
  }
}

function emptyModules() {
  return { supervisionReports: [], enrollments: {}, events: [], notifications: [], inventoryItems: [], inventoryCounts: {}, inventorySubmissions: {}, inventoryDeadlines: {}, orders: [], km: { vehicles: {}, logs: {} }, trainings: [], trainingSubmissions: {}, people: [] };
}

function mod() {
  if (!state.mod) state.mod = { available: false, data: emptyModules(), ui: defaultUi(), drafts: {} };
  return state.mod;
}

// ---------------------------------------------------------------- menu lateral
function navConfig(isAdmin) {
  const pend = computePendencias();
  const badgeOf = id => pend.groups.find(group => group.id === id)?.items.length || 0;
  if (state.user?.role === "adm") {
    return [
      { id: "conferencia", label: "Conferência", items: [
        { view: "km", label: "Controle de KM", icon: "car", badge: badgeOf("km"), tone: "warn" },
        { view: "capacitacao", label: "Capacitação", icon: "graduation", badge: badgeOf("cap"), tone: "warn" }
      ] },
      { id: "comunicacao", label: "Comunicação", items: [{ view: "pendencias", label: "Pendências", icon: "listTodo", badge: pend.total, tone: "warn" }] }
    ];
  }
  const notifBadge = isAdmin
    ? mod().data.notifications.filter(item => !item.finalFile && Object.keys(item.responses || {}).length).length
    : mod().data.notifications.filter(item => !item.finalFile && !item.responses?.[state.user.id]).length;
  return [
    {
      id: "apuracao", label: "Apuração", items: isAdmin ? [
        { view: "apuracoes", label: "Apurações", icon: "clipboard" },
        { view: "dashboard", label: "Painel", icon: "layout" },
        { view: "config", label: "Configurações", icon: "settings" },
        { view: "exportacoes", label: "Exportações", icon: "download" }
      ] : [
        { view: "lancamentos", label: "Lançamentos", icon: "edit" },
        { view: "meu-mes", label: "Meu mês", icon: "calendar" }
      ]
    },
    {
      id: "gestao", label: "Acompanhamento", items: [
        { view: "supervisao", label: "Relatório de Supervisão", icon: "fileCheck" },
        { view: "matriculados", label: "Matriculados", icon: "users" },
        { view: "eventos", label: "Eventos", icon: "party", badge: pend.groups.find(group => group.id === "evt")?.items.length || 0, tone: "warn" },
        { view: "inventario", label: "Inventário de Insumos", icon: "package" },
        ...(isAdmin ? [{ view: "registro-inventario", label: "Registro de Inventário", icon: "table" }] : [])
      ]
    },
    {
      id: "pedidos", label: "Pedidos", items: [
        isAdmin
          ? { view: "pedidos", label: "Pedidos", icon: "cart", badge: pend.groups.find(group => group.id === "ped")?.items.length || 0 }
          : { view: "ajuste-pedido", label: "Ajuste de Pedido", icon: "cart", badge: pend.groups.find(group => group.id === "ped")?.items.length || 0, tone: "warn" },
        { view: "historico-pedidos", label: "Histórico", icon: "clock" }
      ]
    },
    ...(isAdmin ? [{ id: "conferencia", label: "Conferência", items: [
      { view: "km", label: "Controle de KM", icon: "car", badge: badgeOf("km"), tone: "warn" },
      { view: "capacitacao", label: "Capacitação", icon: "graduation", badge: badgeOf("cap"), tone: "warn" }
    ] }] : []),
    ...(isAdmin ? [{ id: "analytics", label: "Analytics", items: AN_SECTIONS.map(([tab, label, iconName]) => ({ view: `an-${tab}`, label, icon: iconName })) }] : []),
    ...(isAdmin ? [] : [{ id: "rotina", label: "Rotina", items: [
      { view: "km", label: "Controle de KM", icon: "car", badge: badgeOf("km"), tone: "warn" },
      { view: "capacitacao", label: "Capacitação", icon: "graduation", badge: badgeOf("cap"), tone: "warn" }
    ] }]),
    {
      id: "comunicacao", label: "Comunicação", items: [
        { view: "notificacoes", label: "Notificações", icon: "alertCircle", badge: notifBadge },
        { view: "pendencias", label: "Pendências", icon: "listTodo", badge: pend.total, tone: "warn" }
      ]
    },
    {
      id: "ferramentas", label: "Ferramentas", items: [
        { view: "percapita", label: "Calculadora Per Capita", icon: "calculator", disabled: true, tag: "Em breve" }
      ]
    }
  ];
}

function renderSidebarNav(isAdmin) {
  return navConfig(isAdmin).map(group => {
    const closed = localStorage.getItem(`ui-nav-group-${group.id}`) === "0" && !group.items.some(item => item.view === state.view);
    return `<div class="nav-group ${closed ? "is-closed" : ""}">
      <button type="button" class="nav-group-head" data-nav-group="${group.id}"><span>${group.label}</span>${icon("chevronDown")}</button>
      <div class="nav-group-items"><div>
        ${group.items.map(item => `
          <button type="button" class="nav-item ${state.view === item.view ? "active" : ""} ${item.disabled ? "is-disabled" : ""}"
            data-view="${item.view}" data-tip="${esc(item.label)}${item.tag ? ` · ${item.tag}` : ""}" ${item.disabled ? 'aria-disabled="true"' : ""}>
            <span class="nav-icon">${icon(item.icon)}</span>
            <span class="nav-label">${item.label}</span>
            ${item.tag ? `<span class="nav-tag">${item.tag}</span>` : ""}
            ${item.badge ? `<span class="nav-badge ${item.tone || ""}">${item.badge > 99 ? "99+" : item.badge}</span>` : ""}
          </button>`).join("")}
      </div></div>
    </div>`;
  }).join("");
}

function renderModuleView(view) {
  const isAdmin = state.user.role === "admin";
  const views = {
    supervisao: renderSupervisao,
    matriculados: renderMatriculados,
    eventos: renderEventos,
    notificacoes: renderNotificacoes,
    pendencias: renderPendencias,
    inventario: renderInventario,
    "historico-pedidos": renderHistoricoPedidos,
    ...(isAdmin
      ? { ...Object.fromEntries(AN_SECTIONS.map(([tab]) => [`an-${tab}`, () => { mod().ui.an ||= defaultAnalyticsUi(); mod().ui.an.tab = tab; renderAnalytics(); }])), "registro-inventario": renderRegistroInventario, exportacoes: renderExportacoes, pedidos: renderPedidos, km: renderKm, capacitacao: renderCapacitacao }
      : { "ajuste-pedido": renderAjustePedido, km: renderKm, capacitacao: renderCapacitacao })
  };
  if (!views[view]) return false;
  if (!mod().available) {
    shell(pageHead({ title: "Módulo indisponível" }) + unavailable());
    return true;
  }
  const entering = state.lastRenderedView !== view;
  views[view]();
  if (entering && !mod().refreshing) {
    mod().refreshing = true;
    const before = JSON.stringify(mod().data);
    loadModules().then(() => {
      state.mod.refreshing = false;
      if (state.user && state.view === view && JSON.stringify(state.mod.data) !== before) render();
    });
  }
  return true;
}

// ================================================================ RELATÓRIO DE SUPERVISÃO
function reportsFor(schoolId, nutriId, month) {
  return mod().data.supervisionReports
    .filter(report => report.schoolId === schoolId && report.nutritionistId === nutriId && (!month || String(report.date).startsWith(month)))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function supDraftKey(nutriId, schoolId) {
  return `sup:${nutriId}:${schoolId}`;
}

function renderSupervisao() {
  const ui = mod().ui.sup;
  const isAdmin = state.user.role === "admin";
  const month = ui.month || currentMonth();
  const query = normalizeText(ui.search);
  const nutris = nutriList().filter(nutri => ui.nutri === "todas" || nutri.id === ui.nutri);
  if (!isAdmin) ui.open.add(state.user.id);

  let totalSchools = 0;
  let doneSchools = 0;
  let photos = 0;
  const monthReports = mod().data.supervisionReports.filter(report => String(report.date).startsWith(month));
  monthReports.forEach(report => { photos += report.photos?.length || 0; });

  const groups = nutris.map(nutri => {
    const schools = schoolsOfNutri(nutri.id)
      .filter(school => ui.route === "todas" || school.route === ui.route)
      .filter(school => !query || normalizeText(`${school.shortName} ${school.name}`).includes(query));
    const rows = schools.map(school => ({ school, reports: reportsFor(school.id, nutri.id, month) }))
      .filter(row => ui.status === "todas" || (ui.status === "feito" ? row.reports.length : !row.reports.length));
    const done = rows.filter(row => row.reports.length).length;
    totalSchools += rows.length;
    doneSchools += done;
    return { nutri, rows, done };
  }).filter(group => group.rows.length || (!query && ui.route === "todas" && ui.status === "todas"));

  const pct = totalSchools ? Math.round((doneSchools / totalSchools) * 100) : 0;
  shell(`
    ${pageHead({
      eyebrow: "Acompanhamento",
      title: "Relatório de Supervisão",
      subtitle: isAdmin ? "Supervisões registradas por nutricionista e escola." : "Registre a supervisão de cada escola sob sua responsabilidade."
    })}
    <section class="stat-row">
      ${statCard({ label: "Escolas supervisionadas", value: `${doneSchools}<small>/${totalSchools}</small>`, hint: `${pct}% concluído · ${formatMonthBR(month)}`, iconName: "school", tone: "brand" })}
      ${statCard({ label: "Relatórios no mês", value: fmtNumber(monthReports.length), iconName: "fileCheck" })}
      ${statCard({ label: "Fotos anexadas", value: fmtNumber(photos), iconName: "image" })}
      ${statCard({ label: "Sem relatório", value: fmtNumber(totalSchools - doneSchools), iconName: "clock", tone: totalSchools - doneSchools ? "warn" : "" })}
    </section>
    <section class="filter-bar">
      <label class="search-field">${icon("search")}<input id="sup-search" placeholder="Buscar escola..." value="${esc(ui.search)}" /></label>
      <select id="sup-route"><option value="todas">Todas as GREs</option>${routeOptionsHtml(ui.route)}</select>
      ${isAdmin ? `<select id="sup-nutri"><option value="todas">Todas as nutricionistas</option>${nutriList().map(n => `<option value="${n.id}" ${ui.nutri === n.id ? "selected" : ""}>${esc(n.name)}</option>`).join("")}</select>` : ""}
      <select id="sup-status">
        <option value="todas" ${ui.status === "todas" ? "selected" : ""}>Todas as situações</option>
        <option value="feito" ${ui.status === "feito" ? "selected" : ""}>Com relatório</option>
        <option value="pendente" ${ui.status === "pendente" ? "selected" : ""}>Sem relatório</option>
      </select>
      <label class="inline-field">Mês <input id="sup-month" type="month" value="${month}" /></label>
    </section>
    <section class="stack">
      ${groups.map(group => supNutriCard(group, month)).join("") || `<div class="panel">${emptyState("Nenhuma escola encontrada", "Ajuste os filtros para ver as escolas.")}</div>`}
    </section>
  `);

  const rerender = () => renderSupervisao();
  $("#sup-search").addEventListener("input", debounce(event => { ui.search = event.target.value; rerender(); focusEnd("#sup-search"); }, 250));
  $("#sup-route").addEventListener("change", event => { ui.route = event.target.value; rerender(); });
  $("#sup-nutri")?.addEventListener("change", event => { ui.nutri = event.target.value; if (event.target.value !== "todas") ui.open.add(event.target.value); rerender(); });
  $("#sup-status").addEventListener("change", event => { ui.status = event.target.value; rerender(); });
  $("#sup-month").addEventListener("change", event => { ui.month = event.target.value || currentMonth(); rerender(); });

  document.querySelectorAll("[data-sup-nutri]").forEach(button => button.addEventListener("click", () => {
    const id = button.dataset.supNutri;
    if (ui.open.has(id)) ui.open.delete(id); else ui.open.add(id);
    rerender();
  }));
  document.querySelectorAll("[data-sup-school]").forEach(button => button.addEventListener("click", () => {
    ui.openSchool = ui.openSchool === button.dataset.supSchool ? "" : button.dataset.supSchool;
    rerender();
  }));
  bindSupForms();
}

function supNutriCard({ nutri, rows, done }, month) {
  const ui = mod().ui.sup;
  const open = ui.open.has(nutri.id);
  const total = rows.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const routesOf = [...new Set(rows.map(row => routeLabel(row.school.route)))].join(" · ");
  return `<article class="card nutri-card ${open ? "is-open" : ""}">
    <button type="button" class="nutri-head" data-sup-nutri="${nutri.id}">
      <span class="avatar lg">${initials(nutri.name)}</span>
      <span class="nutri-id"><strong>${esc(nutri.name)}</strong><small>${total} escola(s) · ${esc(routesOf || "—")}</small></span>
      <span class="ring" style="--p:${pct}"><span>${pct}%</span></span>
      <span class="nutri-progress"><span class="bar"><i style="width:${pct}%"></i></span><small>${done} de ${total} com relatório</small></span>
      <span class="chev">${icon("chevronDown")}</span>
    </button>
    <div class="collapsible"><div>
      <div class="school-rows">
        ${rows.map(row => supSchoolRow(nutri, row, month)).join("") || `<p class="muted pad">Nenhuma escola com os filtros atuais.</p>`}
      </div>
    </div></div>
  </article>`;
}

function supSchoolRow(nutri, { school, reports }, month) {
  const key = supDraftKey(nutri.id, school.id);
  const open = mod().ui.sup.openSchool === key;
  const last = reports[0];
  const files = reports.reduce((sum, report) => sum + (report.reportFile ? 1 : 0), 0);
  const pics = reports.reduce((sum, report) => sum + (report.photos?.length || 0), 0);
  return `<div class="school-row ${open ? "is-open" : ""}">
    <button type="button" class="school-row-head" data-sup-school="${key}">
      <span class="school-ico">${icon("school")}</span>
      <span class="school-name"><strong>${esc(school.shortName)}</strong><small>${esc(routeLabel(school.route))}</small></span>
      <span class="chip ${reports.length ? "ok" : "warn"}">${reports.length ? `${icon("check")} Supervisionada` : `${icon("clock")} Pendente`}</span>
      <span class="meta">${last ? `Última: <b>${fmtDate(last.date)}</b>` : "Sem relatório no mês"}</span>
      <span class="meta counts">${icon("paperclip")} ${files} &nbsp; ${icon("image")} ${pics}</span>
      <span class="chev">${icon("chevronDown")}</span>
    </button>
    ${open ? `<div class="school-row-body">${supForm(nutri, school)}${supHistory(nutri, school, month)}</div>` : ""}
  </div>`;
}

function supForm(nutri, school) {
  const key = supDraftKey(nutri.id, school.id);
  const draft = mod().drafts[key] ||= { date: todayISO(), reportFile: null, photos: [], notes: "", id: null, uploading: 0 };
  return `<form class="sup-form" data-sup-form="${key}" data-nutri="${nutri.id}" data-school="${school.id}">
    <div class="form-title">${icon(draft.id ? "edit" : "plus")}<strong>${draft.id ? "Editar relatório" : "Novo relatório de supervisão"}</strong>
      ${draft.id ? `<button type="button" class="link-btn" data-sup-cancel="${key}">Cancelar edição</button>` : ""}</div>
    <div class="form-grid">
      <label class="field"><span>Data da supervisão</span><input type="date" data-sup-date value="${esc(draft.date)}" required /></label>
      <div class="field"><span>Relatório de supervisão</span>
        ${draft.reportFile ? fileChip(draft.reportFile, `data-sup-remove-report="${key}"`) : `
        <label class="dropzone">${icon("upload")}<span><b>Anexar relatório</b><small>PDF, Word ou imagem · até 25 MB</small></span>
          <input type="file" data-sup-report accept=".pdf,.doc,.docx,.odt,image/*" hidden /></label>`}
      </div>
      <div class="field wide"><span>Fotos que comprovam a ação</span>
        ${photoGrid(draft.photos, "data-sup-remove-photo")}
        <label class="dropzone small">${icon("image")}<span><b>Adicionar fotos</b><small>Selecione uma ou várias imagens</small></span>
          <input type="file" data-sup-photos accept="image/*" multiple hidden /></label>
      </div>
      <label class="field wide"><span>Observações (opcional)</span><textarea data-sup-notes rows="2" placeholder="Pontos observados, orientações...">${esc(draft.notes)}</textarea></label>
    </div>
    <div class="form-actions">
      ${draft.uploading ? `<span class="uploading"><i class="spinner"></i> Enviando ${draft.uploading} arquivo(s)...</span>` : ""}
      <button type="submit" class="primary" ${draft.uploading ? "disabled" : ""}>${icon("save")} ${draft.id ? "Salvar alterações" : "Registrar supervisão"}</button>
    </div>
  </form>`;
}

function supHistory(nutri, school, month) {
  const all = reportsFor(school.id, nutri.id, null);
  if (!all.length) return `<p class="muted pad">Nenhum relatório registrado para esta escola ainda.</p>`;
  return `<div class="history">
    <h4>Histórico de supervisões</h4>
    ${all.map(report => `<div class="history-item ${String(report.date).startsWith(month) ? "current" : ""}">
      <span class="dot"></span>
      <div class="history-main">
        <strong>${fmtDate(report.date)}</strong>
        <div class="history-files">${fileChip(report.reportFile)}${report.photos?.length ? `<span class="muted">${report.photos.length} foto(s)</span>` : ""}</div>
        ${report.notes ? `<p>${esc(report.notes)}</p>` : ""}
        ${photoGrid(report.photos)}
      </div>
      <div class="history-actions">
        <button type="button" class="icon-btn" data-sup-edit="${report.id}" title="Editar">${icon("edit")}</button>
        <button type="button" class="icon-btn danger" data-sup-delete="${report.id}" title="Excluir">${icon("trash")}</button>
      </div>
    </div>`).join("")}
  </div>`;
}

function bindSupForms() {
  document.querySelectorAll("[data-sup-form]").forEach(form => {
    const key = form.dataset.supForm;
    const draft = mod().drafts[key];
    form.querySelector("[data-sup-date]").addEventListener("input", event => { draft.date = event.target.value; });
    form.querySelector("[data-sup-notes]").addEventListener("input", event => { draft.notes = event.target.value; });
    const handleUpload = async (input, apply) => {
      if (!input.files.length) return;
      draft.uploading += input.files.length;
      const files = [...input.files];
      renderSupervisao();
      try { apply(await uploadFiles(files)); } catch (error) { toast(error.message, "error"); }
      draft.uploading = 0;
      renderSupervisao();
    };
    form.querySelector("[data-sup-report]")?.addEventListener("change", event => handleUpload(event.target, files => { draft.reportFile = files[0] || null; }));
    form.querySelector("[data-sup-photos]").addEventListener("change", event => handleUpload(event.target, files => { draft.photos.push(...files); }));
    form.querySelector("[data-sup-remove-report]")?.addEventListener("click", () => { draft.reportFile = null; renderSupervisao(); });
    form.querySelectorAll("[data-sup-remove-photo]").forEach(button => button.addEventListener("click", () => {
      draft.photos.splice(Number(button.dataset.supRemovePhoto), 1);
      renderSupervisao();
    }));
    form.querySelector("[data-sup-cancel]")?.addEventListener("click", () => { delete mod().drafts[key]; renderSupervisao(); });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (!draft.date) return toast("Informe a data da supervisão.", "error");
      if (!draft.reportFile) return toast("Anexe o relatório de supervisão.", "error");
      try {
        await mutate("supervision/save", {
          id: draft.id, nutritionistId: form.dataset.nutri, schoolId: form.dataset.school,
          date: draft.date, reportFile: draft.reportFile, photos: draft.photos, notes: draft.notes
        }, draft.id ? "Relatório atualizado." : "Supervisão registrada.");
        delete mod().drafts[key];
        renderSupervisao();
      } catch { /* toast já exibido */ }
    });
  });
  document.querySelectorAll("[data-sup-edit]").forEach(button => button.addEventListener("click", () => {
    const report = mod().data.supervisionReports.find(item => item.id === button.dataset.supEdit);
    if (!report) return;
    mod().drafts[supDraftKey(report.nutritionistId, report.schoolId)] = {
      id: report.id, date: report.date, reportFile: report.reportFile, photos: [...(report.photos || [])], notes: report.notes || "", uploading: 0
    };
    renderSupervisao();
    document.querySelector(".sup-form")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }));
  document.querySelectorAll("[data-sup-delete]").forEach(button => button.addEventListener("click", async () => {
    if (!(await askConfirm({ title: "Excluir relatório?", text: "O relatório de supervisão e as fotos serão removidos.", yesLabel: "Excluir", danger: true }))) return;
    try { await mutate("supervision/delete", { id: button.dataset.supDelete }, "Relatório excluído."); } catch { /* */ }
  }));
}

function debounce(fn, wait) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); };
}

// Caixa de confirmação da própria aplicação (substitui o confirm() do navegador). Resolve true/false.
function askConfirm({ title = "Confirmar", text = "", yesLabel = "Confirmar", noLabel = "Cancelar", danger = false, iconName } = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `<div class="modal ask-modal ${danger ? "is-danger" : ""}" role="alertdialog" aria-modal="true" aria-labelledby="ask-title" aria-describedby="ask-text">
      <div class="ask-body">
        <span class="ask-ico">${icon(iconName || (danger ? "trash" : "alert"))}</span>
        <h2 id="ask-title">${esc(title)}</h2>
        ${text ? `<p id="ask-text">${esc(text)}</p>` : ""}
      </div>
      <div class="ask-actions">
        <button type="button" class="secondary" data-ask-no>${esc(noLabel)}</button>
        <button type="button" class="${danger ? "danger-btn" : "primary"}" data-ask-yes>${esc(yesLabel)}</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    document.body.classList.add("modal-open");
    const finish = value => {
      overlay.remove();
      if (!document.querySelector(".modal-overlay")) document.body.classList.remove("modal-open");
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = event => { if (event.key === "Escape") finish(false); };
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", event => { if (event.target === overlay) finish(false); });
    overlay.querySelector("[data-ask-no]").addEventListener("click", () => finish(false));
    const yes = overlay.querySelector("[data-ask-yes]");
    yes.addEventListener("click", () => finish(true));
    yes.focus();
  });
}

// Campo de escola com busca: digita parte do nome (ou da GRE) e escolhe na lista de sugestões.
function schoolCombo({ name = "schoolId", selectedId = "", schools = state.db.schools, required = true, placeholder = "Digite o nome da escola..." } = {}) {
  const selected = schools.find(school => school.id === selectedId);
  return `<div class="combo" data-combo>
    <input type="text" class="combo-input" autocomplete="off" role="combobox" aria-expanded="false" aria-autocomplete="list"
      placeholder="${esc(placeholder)}" value="${esc(selected?.shortName || "")}" ${required ? "required" : ""} />
    <button type="button" class="combo-clear" data-combo-clear title="Limpar" ${selected ? "" : "hidden"}>${icon("x")}</button>
    <input type="hidden" name="${esc(name)}" value="${esc(selected?.id || "")}" />
    <ul class="combo-list" role="listbox" hidden></ul>
  </div>`;
}

function bindSchoolCombo(root, schools = state.db.schools) {
  const box = root?.querySelector("[data-combo]");
  if (!box) return;
  const input = box.querySelector(".combo-input");
  const hidden = box.querySelector("input[type=hidden]");
  const list = box.querySelector(".combo-list");
  const clear = box.querySelector("[data-combo-clear]");
  const sorted = [...schools].sort((a, b) => a.shortName.localeCompare(b.shortName, "pt-BR"));
  let matches = [];
  let active = -1;
  const setValue = school => {
    hidden.value = school?.id || "";
    input.value = school?.shortName || "";
    clear.hidden = !school;
    input.setCustomValidity("");
    hidden.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); active = -1; };
  const paint = () => {
    list.innerHTML = matches.length
      ? matches.map((school, index) => `<li role="option" data-id="${school.id}" class="${index === active ? "active" : ""}"><strong>${esc(school.shortName)}</strong><small>${esc(routeLabel(school.route))}</small></li>`).join("")
      : `<li class="combo-empty">Nenhuma escola encontrada</li>`;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    list.querySelector("li.active")?.scrollIntoView({ block: "nearest" });
  };
  const search = () => {
    const words = normalizeText(input.value).split(/\s+/).filter(Boolean);
    matches = sorted.filter(school => {
      const text = normalizeText(`${school.shortName} ${routeLabel(school.route)}`);
      return words.every(word => text.includes(word));
    }).slice(0, 60);
    active = matches.length ? 0 : -1;
    paint();
  };
  input.addEventListener("focus", () => { input.select(); search(); });
  input.addEventListener("input", () => {
    if (hidden.value) { hidden.value = ""; clear.hidden = true; hidden.dispatchEvent(new Event("change", { bubbles: true })); }
    search();
  });
  input.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (list.hidden) return search();
      if (!matches.length) return;
      active = (active + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
      paint();
    } else if (event.key === "Enter" && !list.hidden) {
      event.preventDefault();
      if (matches[active]) { setValue(matches[active]); close(); }
    } else if (event.key === "Escape") close();
  });
  // pointerdown sem blur (mantém a lista aberta); a escolha acontece no click, para o toque
  // não "vazar" para o campo que está embaixo da lista no celular.
  list.addEventListener("pointerdown", event => { if (event.pointerType === "mouse") event.preventDefault(); });
  list.addEventListener("mousedown", event => event.preventDefault());
  list.addEventListener("click", event => {
    const item = event.target.closest("li[data-id]");
    if (!item) return;
    setValue(sorted.find(school => school.id === item.dataset.id));
    close();
    input.blur();
  });
  input.addEventListener("blur", () => {
    close();
    if (!hidden.value) {
      const exact = sorted.find(school => normalizeText(school.shortName) === normalizeText(input.value));
      if (exact) setValue(exact);
      else if (input.value.trim()) input.setCustomValidity("Escolha uma escola da lista.");
    }
  });
  clear.addEventListener("click", () => { setValue(null); input.focus(); });
}

function focusEnd(selector) {
  const el = document.querySelector(selector);
  if (!el) return;
  el.focus();
  const length = el.value.length;
  el.setSelectionRange?.(length, length);
}

// ================================================================ MATRICULADOS
function enrollmentTotal(record) {
  return Object.values(record?.segments || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

function renderMatriculados() {
  const ui = mod().ui.mat;
  const isAdmin = state.user.role === "admin";
  const cards = state.db.cards;
  const enrollments = mod().data.enrollments;
  const query = normalizeText(ui.search);
  if (ui.seg !== "todos" && !cards.some(card => card.id === ui.seg)) ui.seg = "todos";
  const segCard = cards.find(card => card.id === ui.seg) || null;
  const valueOf = (schoolId, cardId) => {
    const dirty = ui.dirty[schoolId];
    if (dirty && cardId in dirty) return dirty[cardId];
    const value = enrollments[schoolId]?.segments?.[cardId];
    return value === undefined ? "" : value;
  };
  const segValue = (schoolId, cardId) => Number(enrollments[schoolId]?.segments?.[cardId]) || 0;
  // Escopo = GRE + nutricionista + busca. O segmento escolhido filtra as escolas que têm aquele segmento.
  const scope = [...state.db.schools]
    .filter(school => ui.route === "todas" || school.route === ui.route)
    .filter(school => ui.nutri === "todas" || (school.nutritionistIds || []).includes(ui.nutri))
    .filter(school => !query || normalizeText(`${school.shortName} ${school.name}`).includes(query));
  const schools = scope
    .filter(school => {
      if (!segCard) return !ui.onlyEmpty || !enrollmentTotal(enrollments[school.id]);
      return ui.onlyEmpty ? !segValue(school.id, segCard.id) : segValue(school.id, segCard.id) > 0;
    })
    .sort((a, b) => a.shortName.localeCompare(b.shortName, "pt-BR"));
  const segTotals = cards.map(card => ({
    card,
    total: scope.reduce((sum, school) => sum + segValue(school.id, card.id), 0),
    schools: scope.filter(school => segValue(school.id, card.id) > 0).length
  }));
  const scopeTotal = segTotals.reduce((sum, row) => sum + row.total, 0);
  const segRow = segCard ? segTotals.find(row => row.card.id === segCard.id) : null;
  const selectionTotal = segRow ? segRow.total : scopeTotal;
  const filled = scope.filter(school => enrollmentTotal(enrollments[school.id]) > 0).length;
  const schoolsWith = segRow ? segRow.schools : filled;
  const topSeg = [...segTotals].sort((a, b) => b.total - a.total)[0];
  const footTotals = cards.map(card => schools.reduce((sum, school) => sum + segValue(school.id, card.id), 0));
  const dirtyCount = Object.keys(ui.dirty).length;
  const users = userMap();
  const selectionParts = [
    ui.nutri !== "todas" ? users.get(ui.nutri)?.name : "",
    ui.route !== "todas" ? routeLabel(ui.route) : "",
    segCard ? `${segCard.label} · ${segCard.description}` : "",
    query ? `“${ui.search}”` : ""
  ].filter(Boolean);
  const selectionText = selectionParts.length ? selectionParts.join(" · ") : (isAdmin ? "Toda a rede" : "Todas as suas escolas");
  const maxSeg = Math.max(1, ...segTotals.map(row => row.total));

  shell(`
    ${pageHead({
      eyebrow: "Acompanhamento",
      title: "Matriculados",
      subtitle: isAdmin ? "Matriculados por segmento de cardápio. Filtre por nutricionista, GRE ou segmento para ver o total da seleção." : "Matriculados por segmento nas suas escolas (preenchido pela coordenação).",
      actions: isAdmin ? `<button class="primary" id="mat-save" ${dirtyCount ? "" : "disabled"}>${icon("save")} Salvar alterações${dirtyCount ? ` (${dirtyCount})` : ""}</button>` : ""
    })}
    <section class="filter-bar">
      <label class="search-field">${icon("search")}<input id="mat-search" placeholder="Buscar escola..." value="${esc(ui.search)}" /></label>
      <select id="mat-route"><option value="todas">Todas as GREs</option>${routeOptionsHtml(ui.route)}</select>
      ${isAdmin ? `<select id="mat-nutri"><option value="todas">Todas as nutricionistas</option>${nutriList().map(n => `<option value="${n.id}" ${ui.nutri === n.id ? "selected" : ""}>${esc(n.name)}</option>`).join("")}</select>` : ""}
      <select id="mat-seg"><option value="todos">Todos os segmentos</option>${cards.map(card => `<option value="${card.id}" ${ui.seg === card.id ? "selected" : ""}>${esc(card.label)} · ${esc(card.description)}</option>`).join("")}</select>
      <label class="switch"><input type="checkbox" id="mat-empty" ${ui.onlyEmpty ? "checked" : ""} /><span></span>Somente sem preenchimento</label>
      ${selectionParts.length ? `<button type="button" class="link-btn" id="mat-clear">Limpar filtros</button>` : ""}
    </section>
    <section class="mat-summary card">
      <div class="mat-hero">
        <span class="label">Total de alunos da seleção</span>
        <strong>${fmtNumber(selectionTotal)}</strong>
        <small>${esc(selectionText)}</small>
        <div class="mat-hero-meta">
          <span>${icon("school")} <b>${fmtNumber(schoolsWith)}</b> escola(s)${segCard ? " com este segmento" : " com matriculados"}</span>
          <span>${icon("chart")} média de <b>${fmtNumber(schoolsWith ? selectionTotal / schoolsWith : 0)}</b> por escola</span>
          ${!segCard && topSeg?.total ? `<span>${icon("utensils")} maior segmento: <b>${esc(topSeg.card.description)}</b></span>` : ""}
          ${!segCard ? `<span>${icon("check")} <b>${filled}</b>/${scope.length} escolas preenchidas</span>` : ""}
        </div>
      </div>
      <div class="seg-grid" aria-label="Matriculados por segmento">
        ${segTotals.map(row => `<button type="button" class="seg-tile ${ui.seg === row.card.id ? "on" : ""} ${row.total ? "" : "empty"}" data-mat-seg="${row.card.id}" title="Filtrar por ${esc(row.card.label)} · ${esc(row.card.description)}">
          <span class="seg-name"><b>${esc(row.card.description)}</b><small>${esc(row.card.label)}</small></span>
          <span class="seg-val">${fmtNumber(row.total)}</span>
          <span class="seg-bar"><i style="width:${Math.round(row.total / maxSeg * 100)}%"></i></span>
          <small class="seg-meta">${row.schools} escola(s) · ${scopeTotal ? Math.round(row.total / scopeTotal * 100) : 0}%</small>
        </button>`).join("")}
      </div>
    </section>
    <section class="card table-card">
      <div class="table-head-line"><strong>${schools.length} escola(s)</strong>${segCard ? `<span class="muted">com ${esc(segCard.description)}${ui.onlyEmpty ? " sem preenchimento" : ""}</span>` : ""}</div>
      <div class="table-scroll">
        <table class="data-table mat-table">
          <thead><tr>
            <th class="sticky-col">Escola</th>
            ${cards.map(card => `<th class="num ${ui.seg === card.id ? "is-seg" : ""}" title="${esc(card.label)}"><span class="th-label">${esc(card.description)}</span><small>${esc(card.label)}</small></th>`).join("")}
            <th class="num total-col">Total</th>
          </tr></thead>
          <tbody>
            ${schools.map(school => {
              const total = cards.reduce((sum, card) => sum + (Number(valueOf(school.id, card.id)) || 0), 0);
              return `<tr class="${ui.dirty[school.id] ? "is-dirty" : ""}">
                <td class="sticky-col"><strong>${esc(school.shortName)}</strong><small>${esc(routeLabel(school.route))}${isAdmin ? ` · ${esc(nutriNamesOf(school) || "sem nutricionista")}` : ""}</small></td>
                ${cards.map(card => {
                  const value = valueOf(school.id, card.id);
                  return `<td class="num ${ui.seg === card.id ? "is-seg" : ""}">${isAdmin
                    ? `<input class="cell-input ${value !== "" && Number(value) > 0 ? "has-value" : ""}" inputmode="numeric" data-mat="${school.id}" data-card="${card.id}" value="${esc(value)}" placeholder="–" />`
                    : (value !== "" ? `<span class="cell-val">${fmtNumber(value)}</span>` : `<span class="muted">–</span>`)}</td>`;
                }).join("")}
                <td class="num total-col"><strong data-mat-total="${school.id}">${total ? fmtNumber(total) : "–"}</strong></td>
              </tr>`;
            }).join("") || `<tr><td colspan="${cards.length + 2}">${emptyState("Nenhuma escola encontrada")}</td></tr>`}
          </tbody>
          <tfoot><tr>
            <td class="sticky-col"><strong>Total da seleção</strong></td>
            ${footTotals.map((total, index) => `<td class="num ${ui.seg === cards[index].id ? "is-seg" : ""}"><strong>${total ? fmtNumber(total) : "–"}</strong></td>`).join("")}
            <td class="num total-col"><strong>${fmtNumber(footTotals.reduce((sum, value) => sum + value, 0))}</strong></td>
          </tr></tfoot>
        </table>
      </div>
    </section>
  `);

  $("#mat-search").addEventListener("input", debounce(event => { ui.search = event.target.value; renderMatriculados(); focusEnd("#mat-search"); }, 250));
  $("#mat-route").addEventListener("change", event => { ui.route = event.target.value; renderMatriculados(); });
  $("#mat-nutri")?.addEventListener("change", event => { ui.nutri = event.target.value; renderMatriculados(); });
  $("#mat-seg").addEventListener("change", event => { ui.seg = event.target.value; renderMatriculados(); });
  $("#mat-empty").addEventListener("change", event => { ui.onlyEmpty = event.target.checked; renderMatriculados(); });
  $("#mat-clear")?.addEventListener("click", () => { Object.assign(ui, { search: "", route: "todas", nutri: "todas", seg: "todos" }); renderMatriculados(); });
  document.querySelectorAll("[data-mat-seg]").forEach(button => button.addEventListener("click", () => {
    ui.seg = ui.seg === button.dataset.matSeg ? "todos" : button.dataset.matSeg;
    renderMatriculados();
  }));
  document.querySelectorAll("[data-mat]").forEach(input => {
    input.addEventListener("input", () => {
      input.value = input.value.replace(/\D/g, "");
      const schoolId = input.dataset.mat;
      ui.dirty[schoolId] ||= {};
      ui.dirty[schoolId][input.dataset.card] = input.value;
      input.closest("tr").classList.add("is-dirty");
      input.classList.toggle("has-value", Number(input.value) > 0);
      const total = cards.reduce((sum, card) => sum + (Number(valueOf(schoolId, card.id)) || 0), 0);
      document.querySelector(`[data-mat-total="${schoolId}"]`).textContent = total ? fmtNumber(total) : "–";
      const saveBtn = $("#mat-save");
      saveBtn.disabled = false;
      saveBtn.innerHTML = `${icon("save")} Salvar alterações (${Object.keys(ui.dirty).length})`;
    });
    input.addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const inputs = [...document.querySelectorAll("[data-mat]")];
      const index = inputs.indexOf(input);
      inputs[index + (event.shiftKey ? -cards.length : cards.length)]?.focus();
    });
  });
  $("#mat-save")?.addEventListener("click", async () => {
    const rows = Object.keys(ui.dirty).map(schoolId => ({
      schoolId,
      segments: Object.fromEntries(cards.map(card => [card.id, valueOf(schoolId, card.id)]))
    }));
    try {
      await mutate("enrollments/save", { rows }, "Matriculados salvos.");
      ui.dirty = {};
      renderMatriculados();
    } catch { /* */ }
  });
}

// ================================================================ EVENTOS
const APPROVAL_LABELS = { pendente: ["Aguardando", "neutral"], aprovado: ["Aprovado", "ok"], reprovado: ["Não aprovado", "danger"] };
const AUDIENCES = { alunos: "Alunos", adultos: "Adultos", ambos: "Alunos/Adultos" };
const ADULT_MEALS = { almoco: { label: "Almoço", cardId: "card11" }, lanche: { label: "Lanche", cardId: "card10" } };

function eventStatus(evt) {
  if (evt.attendance === "realizado") return { key: "attended", label: "Realizado", tone: "ok" };
  if (evt.attendance === "nao_realizado") return { key: "missed", label: "Não realizado", tone: "danger" };
  if (!evt.eventDate) return { key: "open", label: "Sem data", tone: "neutral" };
  const diff = daysBetween(todayISO(), evt.eventDate);
  if (diff < 0) return { key: "late", label: `Atrasado ${Math.abs(diff)}d`, tone: "danger" };
  if (diff === 0) return { key: "today", label: "Hoje", tone: "warn" };
  if (diff <= 7) return { key: "soon", label: `Em ${diff} dia(s)`, tone: "warn" };
  return { key: "open", label: `Em ${diff} dias`, tone: "neutral" };
}

function eventNutriId(evt) {
  return evt.nutritionistId || schoolMap().get(evt.schoolId)?.nutritionistIds?.[0] || "";
}

// Mesma regra do servidor: alunos -> card 10 (se "Será faturado?" = Sim); adultos -> almoço CARD 11, lanche card 10.
function eventAllocationPreview(schoolId, audience, studentQty, adultQty, adultMeal, studentBilled = true) {
  const cards = new Map(state.db.cards.map(card => [card.id, card]));
  const result = [];
  const students = audience === "adultos" ? 0 : Number(studentQty) || 0;
  const adults = audience === "alunos" ? 0 : Number(adultQty) || 0;
  if (students) {
    result.push(studentBilled
      ? { who: "Alunos", qty: students, card: cards.get("card10") || null, missing: "card 10 não cadastrado" }
      : { who: "Alunos", qty: students, card: null, missing: "não será faturado", off: true });
  }
  if (adults) {
    const meal = ADULT_MEALS[adultMeal];
    result.push({ who: meal ? `Adultos (${meal.label.toLowerCase()})` : "Adultos", qty: adults, card: meal ? cards.get(meal.cardId) : null, missing: "informe a refeição" });
  }
  return result;
}

function billingText(items) {
  return items.map(item => `${fmtNumber(item.qty)} ${item.who.toLowerCase()} → ${item.card ? `${esc(cardName(item.card))} (${money(item.card.price)})` : item.off ? `<em class="muted">${esc(item.missing)}</em>` : `<em class="warn-text">${esc(item.missing)}</em>`}`).join(" · ");
}

function audienceCell(evt) {
  const label = AUDIENCES[evt.audience] || evt.targetAudience;
  if (!label) return "<span class='muted'>—</span>";
  const parts = [];
  if (Number(evt.studentQty)) parts.push(`${fmtNumber(evt.studentQty)} alunos${evt.studentBilled === false ? " (não faturados)" : ""}`);
  if (Number(evt.adultQty)) parts.push(`${fmtNumber(evt.adultQty)} adultos${ADULT_MEALS[evt.adultMeal] ? ` (${ADULT_MEALS[evt.adultMeal].label.toLowerCase()})` : ""}`);
  return `<span class="aud-tag aud-${esc(evt.audience || "alunos")}">${esc(label)}</span>${parts.length ? `<small>${parts.join(" · ")}</small>` : ""}`;
}

function attendanceCell(evt, isAdmin) {
  if (isAdmin) {
    if (evt.attendance === "realizado") return `<span class="chip ok">${icon("check")} Realizado</span>`;
    if (evt.attendance === "nao_realizado") return `<span class="chip danger">${icon("x")} Não realizado</span>`;
    return `<span class="chip neutral">Aguardando nutri</span>`;
  }
  return `<div class="attend-btns">
    <button type="button" class="attend ok ${evt.attendance === "realizado" ? "on" : ""}" data-evt-attend="${evt.id}" data-value="realizado">${icon("check")} Realizado</button>
    <button type="button" class="attend no ${evt.attendance === "nao_realizado" ? "on" : ""}" data-evt-attend="${evt.id}" data-value="nao_realizado">${icon("x")} Não Realizado</button>
  </div>`;
}

function renderEventos() {
  const ui = mod().ui.evt;
  const isAdmin = state.user.role === "admin";
  const schools = schoolMap();
  const users = userMap();
  const query = normalizeText(ui.search);
  const all = mod().data.events.filter(evt => schools.has(evt.schoolId));
  const list = all
    .filter(evt => ui.route === "todas" || schools.get(evt.schoolId)?.route === ui.route)
    .filter(evt => !isAdmin || ui.nutri === "todas" || eventNutriId(evt) === ui.nutri)
    .filter(evt => ui.status === "todos" || (ui.status === "concluidos" ? evt.attendance : !evt.attendance))
    .filter(evt => !query || normalizeText(`${schools.get(evt.schoolId)?.shortName} ${evt.event} ${evt.food} ${AUDIENCES[evt.audience] || evt.targetAudience || ""}`).includes(query))
    .sort((a, b) => (Boolean(a.attendance) - Boolean(b.attendance)) || String(a.eventDate || "9999").localeCompare(String(b.eventDate || "9999")));
  const pending = all.filter(evt => !evt.attendance);
  const late = pending.filter(evt => eventStatus(evt).key === "late").length;
  const soon = pending.filter(evt => ["soon", "today"].includes(eventStatus(evt).key)).length;
  const editing = ui.editing ? all.find(evt => evt.id === ui.editing) : null;
  const cols = 12;

  shell(`
    ${pageHead({
      eyebrow: "Acompanhamento",
      title: "Eventos",
      subtitle: isAdmin ? "Registre os eventos solicitados pelas escolas, defina a nutricionista responsável e acompanhe o atendimento." : "Eventos das suas escolas. Confirme o atendimento de cada um.",
      actions: isAdmin ? `<button class="primary" id="evt-new">${icon("plus")} Novo evento</button>` : ""
    })}
    <section class="stat-row">
      ${statCard({ label: "Eventos registrados", value: fmtNumber(all.length), iconName: "party", tone: "brand" })}
      ${statCard({ label: "Aguardando atendimento", value: fmtNumber(pending.length), iconName: "clock" })}
      ${statCard({ label: "Próximos 7 dias", value: fmtNumber(soon), iconName: "calendar", tone: soon ? "warn" : "" })}
      ${statCard({ label: "Atrasados", value: fmtNumber(late), iconName: "alert", tone: late ? "danger" : "" })}
    </section>
    ${isAdmin && (ui.showForm || editing) ? eventForm(editing) : ""}
    <section class="filter-bar">
      <label class="search-field">${icon("search")}<input id="evt-search" placeholder="Buscar escola, evento, público ou alimentação..." value="${esc(ui.search)}" /></label>
      <select id="evt-route"><option value="todas">Todas as GREs</option>${routeOptionsHtml(ui.route)}</select>
      ${isAdmin ? `<select id="evt-nutri"><option value="todas">Todas as nutricionistas</option>${nutriList().map(n => `<option value="${n.id}" ${ui.nutri === n.id ? "selected" : ""}>${esc(n.name)}</option>`).join("")}</select>` : ""}
      <div class="segmented" role="tablist">
        ${[["todos", "Todos"], ["abertos", "Aguardando"], ["concluidos", "Atendidos"]].map(([key, label]) => `<button type="button" class="${ui.status === key ? "active" : ""}" data-evt-status="${key}">${label}</button>`).join("")}
      </div>
    </section>
    <section class="card table-card">
      <div class="table-scroll">
        <table class="data-table evt-table">
          <thead><tr>
            <th>Solicitação</th><th>Escola</th>${isAdmin ? "<th>Nutricionista</th>" : ""}<th>Evento</th><th>Público alvo</th><th class="num">Qtd.</th><th>Fruta</th>
            <th>Alimentação</th><th>Data do evento</th><th>Aprovado</th><th>Atendimento</th><th>Situação</th>${isAdmin ? "<th></th>" : ""}
          </tr></thead>
          <tbody>
            ${list.map(evt => {
              const school = schools.get(evt.schoolId);
              const status = eventStatus(evt);
              const approval = APPROVAL_LABELS[evt.approval || "pendente"];
              const nutriName = users.get(eventNutriId(evt))?.name || "";
              const billing = (evt.billing || []).map(item => item.cardId ? esc(item.cardLabel) : `<em class="warn-text">${esc(item.cardLabel)}</em>`).join(" + ");
              return `<tr>
                <td data-label="Solicitação">${fmtDate(evt.requestDate)}</td>
                <td data-label="Escola"><strong>${esc(school?.shortName)}</strong><small>${esc(routeLabel(school?.route))}</small></td>
                ${isAdmin ? `<td data-label="Nutricionista">${nutriName ? `<span class="nutri-tag"><span class="avatar xs">${esc(initials(nutriName))}</span>${esc(nutriName)}</span>` : "<span class='muted'>—</span>"}</td>` : ""}
                <td data-label="Evento"><strong>${esc(evt.event)}</strong>${evt.notes ? `<small class="evt-notes" title="${esc(evt.notes)}">${icon("edit")} ${esc(evt.notes)}</small>` : ""}</td>
                <td data-label="Público alvo">${audienceCell(evt)}</td>
                <td data-label="Quantitativo" class="num">${evt.quantity === "" || evt.quantity === undefined || evt.quantity === null ? "<span class='muted'>—</span>" : `<strong>${fmtNumber(evt.quantity)}</strong>`}${isAdmin && billing ? `<small class="bill-cards" title="Card(s) usados na exportação de faturamento">${billing}</small>` : ""}</td>
                <td data-label="Fruta">${evt.hasFruit ? `<span class="chip ok">${icon("apple")} Sim</span>` : `<span class="chip neutral">Não</span>`}</td>
                <td data-label="Alimentação" class="wrap">${esc(evt.food) || "<span class='muted'>—</span>"}</td>
                <td data-label="Data do evento"><span class="date-pill">${icon("calendar")} ${fmtDate(evt.eventDate)}</span>${!isAdmin && !evt.attendance ? `<small><span class="chip ${status.tone}">${status.label}</span></small>` : ""}</td>
                <td data-label="Aprovado">${!isAdmin ? `<span class="chip ${approval[1]}">${approval[0]}</span>`
                  : `<select class="approval-select tone-${approval[1]}" data-evt-approve="${evt.id}">${Object.entries(APPROVAL_LABELS).map(([key, [label]]) => `<option value="${key}" ${(evt.approval || "pendente") === key ? "selected" : ""}>${label}</option>`).join("")}</select>`}</td>
                <td data-label="Atendimento">${attendanceCell(evt, isAdmin)}</td>
                <td data-label="Situação">
                  ${evt.attendance ? "<span class='muted'>—</span>" : `<span class="chip ${status.tone}">${status.label}</span>`}
                </td>
                ${isAdmin ? `
                <td class="row-actions"><button class="icon-btn" data-evt-edit="${evt.id}" title="Editar">${icon("edit")}</button><button class="icon-btn danger" data-evt-delete="${evt.id}" title="Excluir">${icon("trash")}</button></td>` : ""}
              </tr>`;
            }).join("") || `<tr><td colspan="${cols}">${emptyState("Nenhum evento encontrado", isAdmin ? "Clique em “Novo evento” para registrar." : "Quando a coordenação registrar um evento para você, ele aparece aqui.")}</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `);

  $("#evt-search").addEventListener("input", debounce(event => { ui.search = event.target.value; renderEventos(); focusEnd("#evt-search"); }, 250));
  $("#evt-route").addEventListener("change", event => { ui.route = event.target.value; renderEventos(); });
  $("#evt-nutri")?.addEventListener("change", event => { ui.nutri = event.target.value; renderEventos(); });
  document.querySelectorAll("[data-evt-status]").forEach(button => button.addEventListener("click", () => { ui.status = button.dataset.evtStatus; renderEventos(); }));
  $("#evt-new")?.addEventListener("click", () => { ui.showForm = true; ui.editing = null; renderEventos(); $("#evt-form .combo-input")?.focus(); });
  $("#evt-cancel")?.addEventListener("click", () => { ui.showForm = false; ui.editing = null; renderEventos(); });
  const form = $("#evt-form");
  if (form) {
    const field = name => form.querySelector(`[name=${name}]`);
    bindSchoolCombo(form);
    const sync = () => {
      const audience = field("audience").value;
      form.querySelectorAll("[data-aud-students]").forEach(el => { el.hidden = audience === "adultos"; });
      form.querySelectorAll("[data-aud-adults]").forEach(el => { el.hidden = audience === "alunos"; });
      field("adultMeal").required = audience !== "alunos";
      const students = audience === "adultos" ? 0 : Number(field("studentQty").value) || 0;
      const adults = audience === "alunos" ? 0 : Number(field("adultQty").value) || 0;
      form.querySelector("[data-evt-total]").textContent = students + adults ? fmtNumber(students + adults) : "—";
      const preview = eventAllocationPreview(field("schoolId").value, audience, students, adults, field("adultMeal").value, field("studentBilled").value !== "nao");
      form.querySelector("[data-evt-billing]").innerHTML = preview.length
        ? `${icon("table")} <span><b>No faturamento:</b> ${billingText(preview)}</span>`
        : `${icon("table")} <span>Informe as quantidades para ver em qual card o evento entra no faturamento.</span>`;
    };
    form.addEventListener("input", sync);
    form.addEventListener("change", sync);
    field("schoolId").addEventListener("change", () => {
      const nutriId = schools.get(field("schoolId").value)?.nutritionistIds?.[0];
      if (nutriId) field("nutritionistId").value = nutriId;
    });
    sync();
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target).entries());
      try {
        await mutate("events/save", { id: editing?.id, ...data }, editing ? "Evento atualizado." : "Evento registrado.");
        ui.showForm = false;
        ui.editing = null;
        renderEventos();
      } catch { /* */ }
    });
  }
  document.querySelectorAll("[data-evt-approve]").forEach(select => select.addEventListener("change", () => mutate("events/approve", { id: select.dataset.evtApprove, approval: select.value }, select.value === "aprovado" ? "Evento aprovado." : select.value === "reprovado" ? "Evento marcado como não aprovado." : "Aprovação pendente.").catch(() => {})));
  document.querySelectorAll("[data-evt-attend]").forEach(button => button.addEventListener("click", () => {
    const evt = all.find(item => item.id === button.dataset.evtAttend);
    const value = evt?.attendance === button.dataset.value ? null : button.dataset.value;
    mutate("events/attend", { id: button.dataset.evtAttend, attendance: value }, value === "realizado" ? "Atendimento confirmado: realizado." : value ? "Atendimento registrado: não realizado." : "Confirmação de atendimento desfeita.").catch(() => {});
  }));
  document.querySelectorAll("[data-evt-edit]").forEach(button => button.addEventListener("click", () => { ui.editing = button.dataset.evtEdit; ui.showForm = true; renderEventos(); window.scrollTo({ top: 0, behavior: "smooth" }); }));
  document.querySelectorAll("[data-evt-delete]").forEach(button => button.addEventListener("click", () => {
    askConfirm({ title: "Excluir evento?", text: "O evento será removido e não poderá ser recuperado.", yesLabel: "Excluir", danger: true })
      .then(ok => ok && mutate("events/delete", { id: button.dataset.evtDelete }, "Evento excluído.").catch(() => {}));
  }));
}

function eventForm(evt) {
  const schools = [...state.db.schools].sort((a, b) => a.shortName.localeCompare(b.shortName, "pt-BR"));
  const nutriId = evt ? eventNutriId(evt) : "";
  const approval = evt?.approval || "pendente";
  const audience = evt?.audience || "alunos";
  return `<form class="card form-card pop-in" id="evt-form">
    <div class="form-title">${icon(evt ? "edit" : "plus")}<strong>${evt ? "Editar evento" : "Novo evento"}</strong></div>
    <div class="form-grid cols-4">
      <div class="field wide2"><span>Escola</span>${schoolCombo({ selectedId: evt?.schoolId || "", schools })}</div>
      <label class="field wide2"><span>Nutricionista responsável</span><select name="nutritionistId" required><option value="">Preenchida ao escolher a escola...</option>${nutriList().map(n => `<option value="${n.id}" ${nutriId === n.id ? "selected" : ""}>${esc(n.name)}</option>`).join("")}</select></label>
      <label class="field"><span>Data da solicitação</span><input type="date" name="requestDate" value="${esc(evt?.requestDate || todayISO())}" required /></label>
      <label class="field"><span>Data do evento</span><input type="date" name="eventDate" value="${esc(evt?.eventDate || "")}" required /></label>
      <label class="field wide2"><span>Evento</span><input name="event" value="${esc(evt?.event || "")}" placeholder="Ex.: Festa junina, Dia das crianças..." required /></label>
    </div>
    <fieldset class="aud-box">
      <legend>Público e quantitativo</legend>
      <div class="form-grid cols-4">
        <label class="field"><span>Público alvo</span><select name="audience">${Object.entries(AUDIENCES).map(([key, label]) => `<option value="${key}" ${audience === key ? "selected" : ""}>${label}</option>`).join("")}</select></label>
        <label class="field" data-aud-students><span>Qtd. de alunos</span><input type="number" min="0" step="1" name="studentQty" value="${esc(evt?.studentQty || (audience !== "adultos" && evt?.quantity) || "")}" placeholder="0" /></label>
        <label class="field" data-aud-students><span>Será faturado?</span><select name="studentBilled"><option value="sim" ${evt?.studentBilled === false ? "" : "selected"}>Sim (card 10)</option><option value="nao" ${evt?.studentBilled === false ? "selected" : ""}>Não</option></select></label>
        <label class="field" data-aud-adults><span>Qtd. de adultos</span><input type="number" min="0" step="1" name="adultQty" value="${esc(evt?.adultQty || "")}" placeholder="0" /></label>
        <label class="field" data-aud-adults><span>Refeição dos adultos</span><select name="adultMeal"><option value="">Selecione...</option>${Object.entries(ADULT_MEALS).map(([key, meal]) => `<option value="${key}" ${evt?.adultMeal === key ? "selected" : ""}>${meal.label} (${meal.cardId === "card11" ? "CARD 11" : "card 10"})</option>`).join("")}</select></label>
        <div class="field"><span>Quantitativo total</span><output class="total-out" data-evt-total>—</output></div>
        <label class="field"><span>Possui fruta?</span><select name="hasFruit"><option value="nao" ${evt?.hasFruit ? "" : "selected"}>Não</option><option value="sim" ${evt?.hasFruit ? "selected" : ""}>Sim</option></select></label>
        <label class="field"><span>Aprovado</span><select name="approval">${Object.entries(APPROVAL_LABELS).map(([key, [label]]) => `<option value="${key}" ${approval === key ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      </div>
      <p class="bill-preview" data-evt-billing></p>
    </fieldset>
    <div class="form-grid cols-4">
      <label class="field wide2"><span>Alimentação</span><textarea name="food" rows="2" placeholder="Cardápio / itens solicitados">${esc(evt?.food || "")}</textarea></label>
      <label class="field wide2"><span>Observações</span><textarea name="notes" rows="2" placeholder="Informações adicionais">${esc(evt?.notes || "")}</textarea></label>
    </div>
    <p class="form-hint">${icon("info")} A coordenação cria e <b>aprova</b> o evento. <b>Atendimento</b> (Realizado / Não Realizado) e <b>conclusão</b> ficam com a nutricionista responsável. Entram no faturamento apenas os eventos <b>aprovados e confirmados como realizados</b>.</p>
    <div class="form-actions"><button type="button" class="secondary" id="evt-cancel">Cancelar</button><button type="submit" class="primary">${icon("save")} ${evt ? "Salvar" : "Registrar evento"}</button></div>
  </form>`;
}

// ================================================================ NOTIFICAÇÕES
function notificationStage(item) {
  const total = item.targetIds.length;
  const answered = Object.values(item.responses || {}).filter(Boolean).length;
  if (item.finalFile) return { step: 3, label: "Concluída", tone: "ok", answered, total };
  if (answered >= total) return { step: 2, label: "Aguardando arquivo final", tone: "warn", answered, total };
  if (answered) return { step: 1, label: "Respostas em andamento", tone: "info", answered, total };
  return { step: 1, label: "Aguardando respostas", tone: "neutral", answered, total };
}

function stepper(step) {
  const steps = ["Perguntas enviadas", "Respostas das nutricionistas", "Arquivo final"];
  return `<ol class="stepper">${steps.map((label, index) => `<li class="${index + 1 < step || step === 3 ? "done" : index + 1 === step ? "current" : ""}"><span>${index + 1 < step || step === 3 ? icon("check") : index + 1}</span>${label}</li>`).join("")}</ol>`;
}

function renderNotificacoes() {
  const ui = mod().ui.ntf;
  const isAdmin = state.user.role === "admin";
  const items = mod().data.notifications;
  const schools = schoolMap();
  const schoolOptions = [...new Set(items.flatMap(item => item.schoolIds || []))]
    .filter(id => schools.has(id))
    .sort((a, b) => schools.get(a).shortName.localeCompare(schools.get(b).shortName, "pt-BR"));
  if (ui.school !== "todas" && !schoolOptions.includes(ui.school)) ui.school = "todas";
  const filtered = items.filter(item => {
    if (ui.school !== "todas" && !(item.schoolIds || []).includes(ui.school)) return false;
    if (ui.filter === "todas") return true;
    if (isAdmin) return ui.filter === "abertas" ? !item.finalFile : Boolean(item.finalFile);
    const answered = Boolean(item.responses?.[state.user.id]);
    return ui.filter === "abertas" ? !answered && !item.finalFile : answered || item.finalFile;
  });
  const waitingFinal = items.filter(item => notificationStage(item).step === 2).length;
  const toAnswer = items.filter(item => !item.finalFile && !item.responses?.[state.user.id]).length;

  shell(`
    ${pageHead({
      eyebrow: "Comunicação",
      title: "Notificações",
      subtitle: isAdmin ? "Notifique uma ou mais escolas: a nutricionista responsável por cada escola responde. Acompanhe as respostas e finalize com o arquivo." : "Responda às notificações das suas escolas enviadas pela coordenação.",
      actions: isAdmin ? `<button class="primary" id="ntf-new">${icon("plus")} Nova notificação</button>` : ""
    })}
    <section class="stat-row">
      ${isAdmin ? `
        ${statCard({ label: "Notificações", value: fmtNumber(items.length), iconName: "alertCircle", tone: "brand" })}
        ${statCard({ label: "Aguardando respostas", value: fmtNumber(items.filter(item => !item.finalFile && notificationStage(item).step === 1).length), iconName: "clock" })}
        ${statCard({ label: "Aguardando arquivo final", value: fmtNumber(waitingFinal), iconName: "paperclip", tone: waitingFinal ? "warn" : "" })}
        ${statCard({ label: "Concluídas", value: fmtNumber(items.filter(item => item.finalFile).length), iconName: "check" })}
      ` : `
        ${statCard({ label: "Recebidas", value: fmtNumber(items.length), iconName: "alertCircle", tone: "brand" })}
        ${statCard({ label: "Para responder", value: fmtNumber(toAnswer), iconName: "message", tone: toAnswer ? "warn" : "" })}
        ${statCard({ label: "Concluídas", value: fmtNumber(items.filter(item => item.finalFile).length), iconName: "check" })}
      `}
    </section>
    ${isAdmin && ui.showForm ? notificationForm() : ""}
    <section class="filter-bar">
      <div class="segmented">
        ${[["todas", "Todas"], ["abertas", isAdmin ? "Em andamento" : "Para responder"], ["concluidas", isAdmin ? "Concluídas" : "Respondidas"]].map(([key, label]) => `<button type="button" class="${ui.filter === key ? "active" : ""}" data-ntf-filter="${key}">${label}</button>`).join("")}
      </div>
      ${schoolOptions.length ? `<label class="inline-field grow ntf-school-filter">${icon("school")}<select id="ntf-school"><option value="todas">Todas as escolas</option>${schoolOptions.map(id => `<option value="${id}" ${ui.school === id ? "selected" : ""}>${esc(schools.get(id).shortName)} (${items.filter(item => (item.schoolIds || []).includes(id)).length})</option>`).join("")}</select></label>` : ""}
    </section>
    <section class="stack">
      ${filtered.map(item => isAdmin ? adminNotificationCard(item) : nutriNotificationCard(item)).join("") || `<div class="panel">${emptyState("Nenhuma notificação por aqui", ui.school !== "todas" ? "Nenhuma notificação desta escola com esse filtro." : isAdmin ? "Crie uma nova notificação para uma ou mais escolas." : "Quando a coordenação notificar uma escola sua, ela aparece aqui.", "alertCircle")}</div>`}
    </section>
  `);

  document.querySelectorAll("[data-ntf-filter]").forEach(button => button.addEventListener("click", () => { ui.filter = button.dataset.ntfFilter; renderNotificacoes(); }));
  $("#ntf-school")?.addEventListener("change", event => { ui.school = event.target.value; renderNotificacoes(); });
  document.querySelectorAll("[data-ntf-toggle]").forEach(button => button.addEventListener("click", () => {
    const id = button.dataset.ntfToggle;
    if (ui.open.has(id)) ui.open.delete(id); else ui.open.add(id);
    renderNotificacoes();
  }));
  $("#ntf-new")?.addEventListener("click", () => { ui.showForm = true; renderNotificacoes(); });
  bindNotificationForm();
  bindNotificationActions();
}

function notificationForm() {
  const draft = mod().drafts.ntf ||= { title: "", description: "", dueDate: "", questions: [""], schoolIds: [] };
  draft.schoolIds ||= [];
  const schools = schoolMap();
  const users = userMap();
  return `<form class="card form-card pop-in" id="ntf-form">
    <div class="form-title">${icon("send")}<strong>Nova notificação</strong></div>
    <div class="form-grid cols-4">
      <label class="field wide3"><span>Título</span><input data-ntf="title" value="${esc(draft.title)}" placeholder="Ex.: Levantamento de equipamentos de cozinha" required /></label>
      <label class="field"><span>Prazo para resposta</span><input type="date" data-ntf="dueDate" value="${esc(draft.dueDate)}" /></label>
      <label class="field full"><span>Descrição (opcional)</span><textarea data-ntf="description" rows="2">${esc(draft.description)}</textarea></label>
    </div>
    <div class="questions">
      <span class="label">Perguntas</span>
      ${draft.questions.map((question, index) => `<div class="question-row"><span class="q-num">${index + 1}</span><input data-ntf-q="${index}" value="${esc(question)}" placeholder="Digite a pergunta..." />${draft.questions.length > 1 ? `<button type="button" class="icon-btn danger" data-ntf-q-remove="${index}">${icon("trash")}</button>` : ""}</div>`).join("")}
      <button type="button" class="link-btn" id="ntf-add-q">${icon("plus")} Adicionar pergunta</button>
    </div>
    <div class="targets">
      <span class="label">Escola(s) notificada(s) <small class="muted">· a nutricionista responsável pela escola responde</small></span>
      ${schoolCombo({ name: "ntfSchool", required: false, placeholder: "Digite para adicionar uma escola...", schools: state.db.schools.filter(school => !draft.schoolIds.includes(school.id)) })}
      <ul class="ntf-schools">
        ${draft.schoolIds.map(id => {
          const school = schools.get(id);
          const nutri = users.get(school?.nutritionistIds?.[0])?.name;
          return `<li><span class="school-ico">${icon("school")}</span><span><strong>${esc(school?.shortName || id)}</strong><small>${esc(routeLabel(school?.route))} · ${nutri ? `responde: <b>${esc(nutri)}</b>` : "<em class='warn-text'>sem nutricionista</em>"}</small></span><button type="button" class="icon-btn" data-ntf-school-remove="${id}" title="Remover">${icon("x")}</button></li>`;
        }).join("") || `<li class="empty muted">Nenhuma escola adicionada ainda.</li>`}
      </ul>
    </div>
    <div class="form-actions"><button type="button" class="secondary" id="ntf-cancel">Cancelar</button><button type="submit" class="primary">${icon("send")} Enviar notificação</button></div>
  </form>`;
}

function bindNotificationForm() {
  const form = $("#ntf-form");
  if (!form) return;
  const draft = mod().drafts.ntf;
  form.querySelectorAll("[data-ntf]").forEach(input => input.addEventListener("input", () => { draft[input.dataset.ntf] = input.value; }));
  form.querySelectorAll("[data-ntf-q]").forEach(input => input.addEventListener("input", () => { draft.questions[Number(input.dataset.ntfQ)] = input.value; }));
  form.querySelectorAll("[data-ntf-q-remove]").forEach(button => button.addEventListener("click", () => { draft.questions.splice(Number(button.dataset.ntfQRemove), 1); renderNotificacoes(); }));
  $("#ntf-add-q").addEventListener("click", () => { draft.questions.push(""); renderNotificacoes(); document.querySelector(`[data-ntf-q="${draft.questions.length - 1}"]`)?.focus(); });
  bindSchoolCombo(form.querySelector(".targets"), state.db.schools.filter(school => !draft.schoolIds.includes(school.id)));
  form.querySelector("[name=ntfSchool]").addEventListener("change", event => {
    const id = event.target.value;
    if (!id || draft.schoolIds.includes(id)) return;
    draft.schoolIds.push(id);
    renderNotificacoes();
    document.querySelector("#ntf-form .targets .combo-input")?.focus();
  });
  form.querySelectorAll("[data-ntf-school-remove]").forEach(button => button.addEventListener("click", () => {
    draft.schoolIds = draft.schoolIds.filter(id => id !== button.dataset.ntfSchoolRemove);
    renderNotificacoes();
  }));
  $("#ntf-cancel").addEventListener("click", () => { mod().ui.ntf.showForm = false; renderNotificacoes(); });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    try {
      if (!draft.schoolIds.length) { toast("Adicione ao menos uma escola.", "error"); document.querySelector("#ntf-form .targets .combo-input")?.focus(); return; }
      await mutate("notifications/create", { title: draft.title, description: draft.description, dueDate: draft.dueDate, questions: draft.questions, schoolIds: draft.schoolIds }, "Notificação enviada.");
      delete mod().drafts.ntf;
      mod().ui.ntf.showForm = false;
      renderNotificacoes();
    } catch { /* */ }
  });
}

// Escolas da notificação (a nutricionista vê só as dela).
function ntfSchoolsLine(item, onlyIds = null) {
  const schools = schoolMap();
  const ids = (item.schoolIds || []).filter(id => !onlyIds || onlyIds.includes(id));
  if (!ids.length) return "";
  const names = ids.map(id => schools.get(id)?.shortName || id);
  return `<span class="ntf-schools-line">${icon("school")} ${esc(names.slice(0, 2).join(" · "))}${names.length > 2 ? ` <b>+${names.length - 2}</b>` : ""}</span>`;
}

function dueChip(dueDate) {
  if (!dueDate) return "";
  const diff = daysBetween(todayISO(), dueDate);
  const tone = diff < 0 ? "danger" : diff <= 3 ? "warn" : "neutral";
  return `<span class="chip ${tone}">${icon("clock")} Prazo ${fmtDate(dueDate)}${diff < 0 ? " · vencido" : ""}</span>`;
}

function adminNotificationCard(item) {
  const stage = notificationStage(item);
  const open = mod().ui.ntf.open.has(item.id);
  const users = userMap();
  const pct = Math.round((stage.answered / Math.max(stage.total, 1)) * 100);
  return `<article class="card ntf-card ${open ? "is-open" : ""}">
    <button type="button" class="ntf-head" data-ntf-toggle="${item.id}">
      <span class="ntf-icon tone-${stage.tone}">${icon(item.finalFile ? "check" : "alertCircle")}</span>
      <span class="ntf-title"><strong>${esc(item.title)}</strong>${ntfSchoolsLine(item)}<small>${item.questions.length} pergunta(s) · enviada em ${fmtDate(item.createdAt)} · ${esc(item.createdBy || "")}</small></span>
      ${item.finalFile ? "" : dueChip(item.dueDate)}
      <span class="ntf-progress"><span class="bar"><i style="width:${pct}%"></i></span><small>${stage.answered}/${stage.total} responderam</small></span>
      <span class="chip ${stage.tone}">${stage.label}</span>
      <span class="chev">${icon("chevronDown")}</span>
    </button>
    ${open ? `<div class="ntf-body">
      ${stepper(stage.step)}
      ${item.description ? `<p class="ntf-desc">${esc(item.description)}</p>` : ""}
      <div class="responses">
        ${item.targetIds.map(id => {
          const response = item.responses?.[id];
          const name = users.get(id)?.name || response?.name || id;
          const ofNutri = (item.schoolIds || []).filter(schoolId => schoolMap().get(schoolId)?.nutritionistIds?.[0] === id).map(schoolId => schoolMap().get(schoolId)?.shortName);
          return `<div class="response ${response ? "answered" : ""}">
            <div class="response-head"><span class="avatar sm">${initials(name)}</span><strong>${esc(name)}${ofNutri.length ? `<small class="muted"> · ${esc(ofNutri.join(", "))}</small>` : ""}</strong>
              ${response ? `<span class="chip ok">${icon("check")} Respondeu em ${fmtDate(response.respondedAt)}</span>` : `<span class="chip neutral">${icon("clock")} Aguardando</span>`}</div>
            ${response ? `<dl class="answers">${item.questions.map((question, index) => `<dt>${index + 1}. ${esc(question.text)}</dt><dd>${esc(response.answers?.[question.id] || "—")}</dd>`).join("")}</dl>
              ${response.attachments?.length ? `<div class="history-files">${response.attachments.map(file => fileChip(file)).join("")}</div>` : ""}` : ""}
          </div>`;
        }).join("")}
      </div>
      <div class="final-box ${item.finalFile ? "done" : ""}">
        <div><strong>${icon("paperclip")} Arquivo final</strong><small>${item.finalFile ? `Anexado em ${fmtDate(item.closedAt)}` : stage.step === 2 ? "Todas responderam. Anexe o arquivo final para concluir." : "Pode ser anexado a qualquer momento para concluir a notificação."}</small></div>
        ${item.finalFile ? `${fileChip(item.finalFile, `data-ntf-final-remove="${item.id}"`)}` : `<label class="dropzone inline">${icon("upload")}<span><b>Anexar arquivo final</b></span><input type="file" data-ntf-final="${item.id}" hidden /></label>`}
      </div>
      <div class="form-actions"><button type="button" class="danger ghost" data-ntf-delete="${item.id}">${icon("trash")} Excluir notificação</button></div>
    </div>` : ""}
  </article>`;
}

function nutriNotificationCard(item) {
  const open = mod().ui.ntf.open.has(item.id) || (!item.responses?.[state.user.id] && !item.finalFile);
  const response = item.responses?.[state.user.id];
  const draft = mod().drafts[`ntf-answer:${item.id}`] ||= { answers: {}, attachments: [] };
  const stage = item.finalFile ? { label: "Concluída", tone: "ok" } : response ? { label: "Respondida · aguardando coordenação", tone: "info" } : { label: "Aguardando sua resposta", tone: "warn" };
  return `<article class="card ntf-card ${open ? "is-open" : ""}">
    <button type="button" class="ntf-head" data-ntf-toggle="${item.id}">
      <span class="ntf-icon tone-${stage.tone}">${icon(item.finalFile ? "check" : response ? "send" : "alertCircle")}</span>
      <span class="ntf-title"><strong>${esc(item.title)}</strong>${ntfSchoolsLine(item, mod().data.ownSchoolIds)}<small>${item.questions.length} pergunta(s) · recebida em ${fmtDate(item.createdAt)}</small></span>
      ${!response ? dueChip(item.dueDate) : ""}
      <span class="chip ${stage.tone}">${stage.label}</span>
      <span class="chev">${icon("chevronDown")}</span>
    </button>
    ${open ? `<div class="ntf-body">
      ${stepper(item.finalFile ? 3 : response ? 2 : 1)}
      ${item.description ? `<p class="ntf-desc">${esc(item.description)}</p>` : ""}
      ${response ? `<dl class="answers">${item.questions.map((question, index) => `<dt>${index + 1}. ${esc(question.text)}</dt><dd>${esc(response.answers?.[question.id] || "—")}</dd>`).join("")}</dl>`
        : `<form class="answer-form" data-ntf-answer="${item.id}">
          ${item.questions.map((question, index) => `<label class="field full"><span>${index + 1}. ${esc(question.text)}</span><textarea rows="2" data-answer="${question.id}" required>${esc(draft.answers[question.id] || "")}</textarea></label>`).join("")}
          <div class="field full"><span>Anexos (opcional)</span>
            <div class="history-files">${draft.attachments.map((file, index) => fileChip(file, `data-answer-remove="${index}"`)).join("")}</div>
            <label class="dropzone small">${icon("paperclip")}<span><b>Anexar arquivos</b></span><input type="file" multiple data-answer-files hidden /></label>
          </div>
          <div class="form-actions"><button type="submit" class="primary">${icon("send")} Enviar respostas</button></div>
        </form>`}
      ${item.finalFile ? `<div class="final-box done"><div><strong>${icon("paperclip")} Arquivo final da coordenação</strong><small>Anexado em ${fmtDate(item.closedAt)}</small></div>${fileChip(item.finalFile)}</div>` : ""}
    </div>` : ""}
  </article>`;
}

function bindNotificationActions() {
  document.querySelectorAll("[data-ntf-final]").forEach(input => input.addEventListener("change", async () => {
    if (!input.files.length) return;
    input.closest(".dropzone").classList.add("busy");
    try {
      const [file] = await uploadFiles(input.files);
      await mutate("notifications/final", { id: input.dataset.ntfFinal, finalFile: file }, "Arquivo final anexado. Notificação concluída.");
    } catch (error) { toast(error.message, "error"); }
  }));
  document.querySelectorAll("[data-ntf-final-remove]").forEach(button => button.addEventListener("click", () => {
    askConfirm({ title: "Remover arquivo final?", text: "A notificação volta para em andamento.", yesLabel: "Remover", danger: true }).then(ok => ok && mutate("notifications/final", { id: button.dataset.ntfFinalRemove, finalFile: null }, "Arquivo final removido.").catch(() => {}));
  }));
  document.querySelectorAll("[data-ntf-delete]").forEach(button => button.addEventListener("click", () => {
    askConfirm({ title: "Excluir notificação?", text: "A notificação e todas as respostas serão removidas.", yesLabel: "Excluir", danger: true }).then(ok => ok && mutate("notifications/delete", { id: button.dataset.ntfDelete }, "Notificação excluída.").catch(() => {}));
  }));
  document.querySelectorAll("[data-ntf-answer]").forEach(form => {
    const id = form.dataset.ntfAnswer;
    const draft = mod().drafts[`ntf-answer:${id}`];
    form.querySelectorAll("[data-answer]").forEach(input => input.addEventListener("input", () => { draft.answers[input.dataset.answer] = input.value; }));
    form.querySelector("[data-answer-files]").addEventListener("change", async event => {
      try { draft.attachments.push(...await uploadFiles(event.target.files)); } catch (error) { toast(error.message, "error"); }
      mod().ui.ntf.open.add(id);
      renderNotificacoes();
    });
    form.querySelectorAll("[data-answer-remove]").forEach(button => button.addEventListener("click", () => { draft.attachments.splice(Number(button.dataset.answerRemove), 1); renderNotificacoes(); }));
    form.addEventListener("submit", async event => {
      event.preventDefault();
      try {
        await mutate("notifications/answer", { id, answers: draft.answers, attachments: draft.attachments }, "Respostas enviadas à coordenação.");
        delete mod().drafts[`ntf-answer:${id}`];
      } catch { /* */ }
    });
  });
}

// ================================================================ INVENTÁRIO
const INVENTORY_CATEGORIES = ["Secos", "Congelados", "Produtos de Limpeza / Descartáveis", "Aprender+"];

function inventoryGroups(items) {
  return INVENTORY_CATEGORIES.map(category => ({
    category,
    items: items.filter(item => item.category === category).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
  }));
}

function itemPrice(item) {
  return item && item.price !== null && item.price !== undefined && Number.isFinite(Number(item.price)) ? Number(item.price) : null;
}

// Valor do inventário de uma escola no mês (soma de quantidade × valor unitário dos itens com valor).
function invValue(month, schoolId, itemsById) {
  let total = 0;
  let priced = 0;
  for (const [itemId, row] of Object.entries(invCount(month, schoolId))) {
    const price = itemPrice(itemsById.get(itemId));
    if (price === null) continue;
    total += price * Number(row.quantity || 0);
    priced += 1;
  }
  return { total: Math.round(total * 100) / 100, priced };
}

// ---------- Item do pedido -> insumo do inventário ----------
// Os nomes não são iguais ("ACUCAR CRISTAL 1KG" x "AÇÚCAR CRISTAL"): tira acento, embalagem e palavras
// genéricas e compara palavra a palavra (aceita plural e 1 letra de diferença).
const ITEM_STOPWORDS = new Set(["KG", "G", "GR", "GRS", "ML", "L", "LT", "LITRO", "LITROS", "UND", "UN", "UNID", "UNIDADES", "PCT", "CX", "CT", "DZ", "FR", "DE", "DA", "DO", "DAS", "DOS", "EM", "E", "COM", "SEM", "PARA", "TIPO", "PO", "SABOR"]);

function itemTokens(text) {
  return String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().split(" ")
    .filter(token => token && !ITEM_STOPWORDS.has(token) && !/\d/.test(token))
    .map(token => token.replace(/EIS$/, "EL").replace(/(?<=..)S$/, ""));
}

function oneEditApart(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; let j = 0; let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i += 1; else if (b.length > a.length) j += 1; else { i += 1; j += 1; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function sameToken(a, b) {
  return a === b || (Math.min(a.length, b.length) >= 6 && oneEditApart(a, b));
}

const itemMatchCache = new Map();
function inventoryItemFor(name) {
  const items = mod().data.inventoryItems || [];
  const cacheKey = `${items.length}:${name}`;
  if (itemMatchCache.has(cacheKey)) return itemMatchCache.get(cacheKey);
  const wanted = itemTokens(name);
  let best = null;
  if (wanted.length) {
    for (const item of items) {
      const tokens = itemTokens(item.name);
      if (!tokens.length) continue;
      const matched = tokens.filter(token => wanted.some(other => sameToken(token, other))).length;
      // todas as palavras do insumo no item, ou o item inteiro no insumo com no máximo 1 palavra a mais
      const full = matched === tokens.length || (matched === wanted.length && tokens.length - matched <= 1);
      if (!full) continue;
      const score = matched * 10 - Math.abs(tokens.length - wanted.length);
      if (!best || score > best.score) best = { item, score };
    }
  }
  itemMatchCache.set(cacheKey, best?.item || null);
  return best?.item || null;
}

// Valor unitário do item do pedido (pelo insumo correspondente do Inventário de Insumos).
function orderItemPrice(name) {
  return itemPrice(inventoryItemFor(name));
}

// Inventário mais recente da escola: o último mês com contagem (enviado ou em preenchimento).
function latestInventory(schoolId, upToMonth = "9999-99") {
  const months = Object.keys(mod().data.inventoryCounts || {}).filter(month => month <= upToMonth).sort().reverse();
  for (const month of months) {
    const counts = mod().data.inventoryCounts[month]?.[schoolId];
    if (counts && Object.keys(counts).length) return { month, counts, sent: Boolean(invSubmission(month, schoolId)) };
  }
  return null;
}

function invCount(month, schoolId) {
  return mod().data.inventoryCounts?.[month]?.[schoolId] || {};
}

function invSubmission(month, schoolId) {
  return mod().data.inventorySubmissions?.[month]?.[schoolId] || null;
}

function serverToday() {
  return mod().data.today || todayISO();
}

function invDeadline(month, route) {
  return mod().data.inventoryDeadlines?.[month]?.[route] || "";
}

// Prazo da escola (pela GRE): { date, closed, daysLeft }
function invDeadlineOf(month, school) {
  const date = school ? invDeadline(month, school.route) : "";
  if (!date) return { date: "", closed: false, daysLeft: null };
  const daysLeft = daysBetween(serverToday(), date);
  return { date, closed: daysLeft < 0, daysLeft };
}

function deadlineChip(deadline) {
  if (!deadline.date) return "";
  if (deadline.closed) return `<span class="chip danger">${icon("lock")} Prazo encerrado em ${fmtDate(deadline.date)}</span>`;
  const tone = deadline.daysLeft <= 2 ? "warn" : "neutral";
  return `<span class="chip ${tone}">${icon("clock")} Prazo até ${fmtDate(deadline.date)}${deadline.daysLeft === 0 ? " (hoje)" : ` (${deadline.daysLeft} dia${deadline.daysLeft === 1 ? "" : "s"})`}</span>`;
}

function invStatus(month, schoolId) {
  const sent = invSubmission(month, schoolId);
  if (sent) return { key: "sent", label: "Enviado", tone: "ok", icon: "check", sent };
  const filled = Object.keys(invCount(month, schoolId)).length;
  if (filled) return { key: "draft", label: "Em preenchimento", tone: "warn", icon: "edit", filled };
  return { key: "none", label: "Não iniciado", tone: "neutral", icon: "clock" };
}

function fmtQty(value) {
  return Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 3 });
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} às ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Lista de leitura do inventário de uma escola (itens com quantidade, por categoria)
function inventoryReadList(rows) {
  const groups = inventoryGroups(rows).filter(group => group.items.length);
  if (!groups.length) return emptyState("Nenhum item preenchido");
  return groups.map(group => `<div class="inv-group">
    <header class="inv-group-head"><h3>${esc(group.category)}</h3><small>${group.items.length} item(ns)</small></header>
    ${group.items.map(item => `<div class="inv-line on"><span class="inv-name static">${esc(item.name)}</span><span class="inv-qty-read"><b>${esc(item.value)}</b> ${esc(item.unit)}${item.cost !== undefined && item.cost !== null ? `<small class="inv-cost">${money(item.cost)}</small>` : ""}</span></div>`).join("")}
  </div>`).join("");
}

function renderInventario() {
  return state.user.role === "admin" ? renderInventarioAdmin() : renderInventarioNutri();
}

// ---------- ADMIN: catálogo ativo / inativo ----------
function renderInventarioAdmin() {
  const ui = mod().ui.inv;
  const items = mod().data.inventoryItems;
  const query = normalizeText(ui.search);
  const editing = ui.editing ? items.find(item => item.id === ui.editing) : null;
  const activeCount = items.filter(item => item.active !== false).length;
  const visible = items
    .filter(item => !query || normalizeText(item.name).includes(query))
    .filter(item => ui.show === "todos" || (ui.show === "ativos" ? item.active !== false : item.active === false));

  shell(`
    ${pageHead({
      eyebrow: "Acompanhamento",
      title: "Inventário de Insumos",
      subtitle: "Defina quais insumos ficam ativos. As nutricionistas informam o inventário de cada escola usando apenas os itens ativos.",
      actions: `<button class="secondary" id="inv-goto-reg">${icon("table")} Registro de Inventário</button><button class="secondary" id="inv-new">${icon("plus")} Novo insumo</button>`
    })}
    <section class="stat-row">
      ${statCard({ label: "Insumos cadastrados", value: fmtNumber(items.length), iconName: "package", tone: "brand" })}
      ${statCard({ label: "Ativos", value: fmtNumber(activeCount), iconName: "check" })}
      ${statCard({ label: "Inativos", value: fmtNumber(items.length - activeCount), iconName: "x" })}
      ${statCard({ label: "Insumos com valor", value: `${items.filter(item => itemPrice(item) !== null).length}<small>/${items.length}</small>`, hint: "valor unitário para calcular o gasto", iconName: "layout" })}
    </section>
    ${ui.showForm || editing ? `<form class="card form-card pop-in" id="inv-form">
      <div class="form-title">${icon(editing ? "edit" : "plus")}<strong>${editing ? "Editar insumo" : "Novo insumo"}</strong></div>
      <div class="form-grid cols-4">
        <label class="field wide2"><span>Nome</span><input name="name" value="${esc(editing?.name || "")}" required /></label>
        <label class="field"><span>Categoria</span><select name="category">${INVENTORY_CATEGORIES.map(cat => `<option ${editing?.category === cat ? "selected" : ""}>${esc(cat)}</option>`).join("")}</select></label>
        <label class="field"><span>Unidade</span><input name="unit" value="${esc(editing?.unit || "KG")}" /></label>
        <label class="field"><span>Valor unitário (R$)</span><input name="price" inputmode="decimal" value="${itemPrice(editing) === null ? "" : esc(String(itemPrice(editing)).replace(".", ","))}" placeholder="0,00" /></label>
      </div>
      <div class="form-actions">${editing ? `<button type="button" class="danger ghost" id="inv-delete">${icon("trash")} Excluir</button>` : ""}<button type="button" class="secondary" id="inv-cancel">Cancelar</button><button type="submit" class="primary">${icon("save")} Salvar</button></div>
    </form>` : ""}
    ${deadlinePanel()}
    <section class="filter-bar">
      <label class="search-field">${icon("search")}<input id="inv-search" placeholder="Buscar insumo..." value="${esc(ui.search)}" /></label>
      <div class="segmented">${[["todos", "Todos"], ["ativos", "Ativos"], ["inativos", "Inativos"]].map(([key, label]) => `<button type="button" class="${ui.show === key ? "active" : ""}" data-inv-show="${key}">${label}</button>`).join("")}</div>
    </section>
    <section class="card inv-list">
      ${inventoryGroups(visible).filter(group => group.items.length).map(group => {
        const allOn = group.items.every(item => item.active !== false);
        return `<div class="inv-group">
          <header class="inv-group-head">
            <h3>${esc(group.category)}</h3>
            <small>${group.items.filter(item => item.active !== false).length}/${group.items.length} ativos</small>
            <button type="button" class="link-btn" data-inv-bulk="${esc(group.category)}" data-on="${allOn ? "0" : "1"}">${allOn ? "Inativar todos" : "Ativar todos"}</button>
          </header>
          ${group.items.map(item => {
            const on = item.active !== false;
            return `<div class="inv-line ${on ? "on" : "off"}">
              <button type="button" class="inv-name" data-inv-edit="${item.id}" title="Editar insumo">${esc(item.name)}</button>
              <span class="inv-unit">${esc(item.unit)}</span>
              <label class="price-wrap" title="Valor unitário por ${esc(item.unit)}"><em>R$</em><input class="cell-input" inputmode="decimal" data-inv-price="${item.id}" value="${itemPrice(item) === null ? "" : esc(itemPrice(item).toFixed(2).replace(".", ","))}" placeholder="0,00" /><small>/${esc(item.unit)}</small></label>
              <label class="done-toggle ${on ? "on" : ""}"><input type="checkbox" data-inv-active="${item.id}" ${on ? "checked" : ""} /><span class="knob"></span><span>${on ? "Ativo" : "Inativo"}</span></label>
            </div>`;
          }).join("")}
        </div>`;
      }).join("") || emptyState("Nenhum insumo encontrado")}
    </section>
  `);

  $("#inv-goto-reg").addEventListener("click", () => { state.view = "registro-inventario"; render(); window.scrollTo({ top: 0 }); });
  bindDeadlinePanel();
  $("#inv-search").addEventListener("input", debounce(event => { ui.search = event.target.value; renderInventario(); focusEnd("#inv-search"); }, 250));
  document.querySelectorAll("[data-inv-show]").forEach(button => button.addEventListener("click", () => { ui.show = button.dataset.invShow; renderInventario(); }));
  document.querySelectorAll("[data-inv-price]").forEach(input => {
    input.addEventListener("input", () => { input.value = input.value.replace(/[^\d,]/g, ""); });
    input.addEventListener("change", async () => {
      const id = input.dataset.invPrice;
      try {
        const saved = await mapi("inventory/price", { id, price: input.value });
        for (const list of [items, mod().data.inventoryItems]) {
          const entry = list.find(row => row.id === id);
          if (entry) entry.price = saved.price;
        }
        input.value = saved.price === null ? "" : saved.price.toFixed(2).replace(".", ",");
        input.classList.add("saved");
        setTimeout(() => input.classList.remove("saved"), 900);
      } catch (error) { toast(error.message, "error"); }
    });
    input.addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const all = [...document.querySelectorAll("[data-inv-price]")];
      all[all.indexOf(input) + 1]?.focus();
    });
  });
  document.querySelectorAll("[data-inv-active]").forEach(input => input.addEventListener("change", () => mutate("inventory/active", { id: input.dataset.invActive, active: input.checked }, input.checked ? "Insumo ativado." : "Insumo inativado.").catch(() => {})));
  document.querySelectorAll("[data-inv-bulk]").forEach(button => button.addEventListener("click", () => {
    const ids = visible.filter(item => item.category === button.dataset.invBulk).map(item => item.id);
    const active = button.dataset.on === "1";
    mutate("inventory/active", { ids, active }, `${ids.length} insumo(s) ${active ? "ativados" : "inativados"}.`).catch(() => {});
  }));
  $("#inv-new").addEventListener("click", () => { ui.showForm = true; ui.editing = null; renderInventario(); });
  document.querySelectorAll("[data-inv-edit]").forEach(button => button.addEventListener("click", () => { ui.editing = button.dataset.invEdit; ui.showForm = true; renderInventario(); window.scrollTo({ top: 0, behavior: "smooth" }); }));
  $("#inv-cancel")?.addEventListener("click", () => { ui.showForm = false; ui.editing = null; renderInventario(); });
  $("#inv-delete")?.addEventListener("click", async () => {
    if (!(await askConfirm({ title: "Excluir insumo?", text: "O insumo sai do catálogo de inventário.", yesLabel: "Excluir", danger: true }))) return;
    mutate("inventory/item-delete", { id: editing.id }, "Insumo excluído.").then(() => { ui.showForm = false; ui.editing = null; renderInventario(); }).catch(() => {});
  });
  $("#inv-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.target).entries());
    try {
      await mutate("inventory/item", { id: editing?.id, ...form }, editing ? "Insumo atualizado." : "Insumo adicionado.");
      ui.showForm = false;
      ui.editing = null;
      renderInventario();
    } catch { /* */ }
  });
}

// ---------- ADMIN: prazo de preenchimento por GRE ----------
function inventoryRoutes() {
  const counts = new Map();
  for (const school of state.db.schools) counts.set(school.route, (counts.get(school.route) || 0) + 1);
  return [...counts.entries()].map(([route, schools]) => ({ route, schools })).sort((a, b) => routeLabel(a.route).localeCompare(routeLabel(b.route), "pt-BR"));
}

function deadlinePanel() {
  const ui = mod().ui.dl;
  const month = ui.month || currentMonth();
  const saved = mod().data.inventoryDeadlines?.[month] || {};
  if (!ui.dirty || ui.dirty.month !== month) ui.dirty = { month, values: { ...saved } };
  const values = ui.dirty.values;
  const routes = inventoryRoutes();
  const set = routes.filter(row => saved[row.route]).length;
  const closed = routes.filter(row => saved[row.route] && daysBetween(serverToday(), saved[row.route]) < 0).length;
  const changed = JSON.stringify(values) !== JSON.stringify(saved);
  return `<section class="card deadline-card ${ui.open ? "is-open" : ""}">
    <button type="button" class="deadline-head" id="dl-toggle">
      <span class="school-ico">${icon("calendar")}</span>
      <span class="nutri-id"><strong>Prazo do inventário por GRE</strong><small>${formatMonthBR(month)} · ${set ? `${set} de ${routes.length} GRE(s) com prazo${closed ? ` · ${closed} encerrado(s)` : ""}` : "Nenhum prazo definido — o preenchimento fica aberto"}</small></span>
      <span class="chev">${icon("chevronDown")}</span>
    </button>
    ${ui.open ? `<div class="deadline-body">
      <p class="form-hint">${icon("info")} Até a data escolhida (inclusive) as nutricionistas da GRE podem preencher e enviar. No dia seguinte o inventário <b>fecha automaticamente</b> para quem não enviou.</p>
      <div class="deadline-tools">
        <label class="inline-field">Mês <input id="dl-month" type="month" value="${month}" /></label>
        <label class="inline-field">Mesma data para todas <input id="dl-all" type="date" /></label>
        <button type="button" class="secondary sm" id="dl-apply-all">Aplicar a todas</button>
        <button type="button" class="link-btn" id="dl-clear">Limpar prazos</button>
      </div>
      <div class="deadline-grid">
        ${routes.map(row => {
          const date = values[row.route] || "";
          const st = date ? (daysBetween(serverToday(), date) < 0 ? ["danger", "Encerrado"] : ["ok", "Aberto"]) : ["neutral", "Sem prazo"];
          return `<label class="deadline-row">
            <span><strong>${esc(routeLabel(row.route))}</strong><small>${row.schools} escola(s)</small></span>
            <input type="date" data-dl-route="${esc(row.route)}" value="${esc(date)}" />
            <span class="chip ${st[0]}">${st[1]}</span>
          </label>`;
        }).join("")}
      </div>
      <div class="form-actions">
        ${changed ? `<button type="button" class="secondary" id="dl-reset">Desfazer</button>` : ""}
        <button type="button" class="primary" id="dl-save" ${changed ? "" : "disabled"}>${icon("save")} Salvar prazos</button>
      </div>
    </div>` : ""}
  </section>`;
}

function bindDeadlinePanel() {
  const ui = mod().ui.dl;
  $("#dl-toggle")?.addEventListener("click", () => { ui.open = !ui.open; renderInventario(); });
  if (!ui.open) return;
  const rerender = () => renderInventario();
  $("#dl-month").addEventListener("change", event => { ui.month = event.target.value || currentMonth(); ui.dirty = null; rerender(); });
  document.querySelectorAll("[data-dl-route]").forEach(input => input.addEventListener("change", () => {
    if (input.value) ui.dirty.values[input.dataset.dlRoute] = input.value;
    else delete ui.dirty.values[input.dataset.dlRoute];
    rerender();
  }));
  $("#dl-apply-all").addEventListener("click", () => {
    const date = $("#dl-all").value;
    if (!date) return toast("Escolha a data para aplicar.", "error");
    for (const row of inventoryRoutes()) ui.dirty.values[row.route] = date;
    rerender();
  });
  $("#dl-clear").addEventListener("click", () => { ui.dirty.values = {}; rerender(); });
  $("#dl-reset")?.addEventListener("click", () => { ui.dirty = null; rerender(); });
  $("#dl-save").addEventListener("click", async () => {
    try {
      await mutate("inventory/deadlines", { month: ui.dirty.month, deadlines: ui.dirty.values }, "Prazos salvos.");
      ui.dirty = null;
      renderInventario();
    } catch { /* */ }
  });
}

// ---------- ADMIN: Registro de Inventário (nutricionista → escolas → inventário) ----------
function renderRegistroInventario() {
  const ui = mod().ui.reg;
  const month = ui.month || currentMonth();
  const query = normalizeText(ui.search);
  const itemsById = new Map(mod().data.inventoryItems.map(item => [item.id, item]));
  const allSchools = state.db.schools;
  const statusCount = { sent: 0, draft: 0, none: 0 };
  const valueOfSchool = schoolId => invValue(month, schoolId, itemsById).total;
  const monthValue = allSchools.reduce((sum, school) => sum + valueOfSchool(school.id), 0);
  const pricedItems = mod().data.inventoryItems.filter(item => itemPrice(item) !== null).length;
  for (const school of allSchools) statusCount[invStatus(month, school.id).key] += 1;

  const groups = nutriList().map(nutri => {
    const schools = schoolsOfNutri(nutri.id);
    const rows = schools
      .map(school => ({ school, status: invStatus(month, school.id) }))
      .filter(row => !query || normalizeText(`${row.school.shortName} ${nutri.name}`).includes(query))
      .filter(row => ui.status === "todos" || row.status.key === ui.status);
    return { nutri, schools, rows, sent: schools.filter(school => invSubmission(month, school.id)).length };
  }).filter(group => group.rows.length || (!query && ui.status === "todos"));

  shell(`
    ${pageHead({
      eyebrow: "Acompanhamento",
      title: "Registro de Inventário",
      subtitle: `Inventário de cada escola por nutricionista · ${formatMonthBR(month)}.`
    })}
    <section class="stat-row">
      ${statCard({ label: "Escolas com inventário enviado", value: `${statusCount.sent}<small>/${allSchools.length}</small>`, hint: `${allSchools.length ? Math.round(statusCount.sent / allSchools.length * 100) : 0}% da rede`, iconName: "check", tone: "brand" })}
      ${statCard({ label: "Em preenchimento", value: fmtNumber(statusCount.draft), iconName: "edit", tone: statusCount.draft ? "warn" : "" })}
      ${statCard({ label: "Não iniciados", value: fmtNumber(statusCount.none), iconName: "clock" })}
      ${statCard({ label: "Valor do inventário no mês", value: `<span class="sm-val">${money(monthValue)}</span>`, hint: pricedItems ? `${pricedItems} insumo(s) com valor` : "cadastre os valores em Inventário de Insumos", iconName: "chart" })}
      ${statCard({ label: "Nutricionistas com tudo enviado", value: `${groups.filter(group => group.schools.length && group.sent === group.schools.length).length}<small>/${nutriList().length}</small>`, iconName: "users" })}
    </section>
    <section class="filter-bar">
      <label class="search-field">${icon("search")}<input id="reg-search" placeholder="Buscar escola ou nutricionista..." value="${esc(ui.search)}" /></label>
      <label class="inline-field">Mês <input id="reg-month" type="month" value="${month}" /></label>
      <div class="segmented">${[["todos", "Todas"], ["sent", "Enviados"], ["draft", "Em preenchimento"], ["none", "Não iniciados"]].map(([key, label]) => `<button type="button" class="${ui.status === key ? "active" : ""}" data-reg-status="${key}">${label}</button>`).join("")}</div>
    </section>
    <section class="nutri-list">
      ${groups.map(group => {
        const open = ui.open.has(group.nutri.id) || Boolean(query);
        const total = group.schools.length;
        const pct = total ? Math.round(group.sent / total * 100) : 0;
        return `<article class="card nutri-card ${open ? "is-open" : ""}">
          <button type="button" class="nutri-head" data-reg-nutri="${group.nutri.id}">
            <span class="avatar lg">${initials(group.nutri.name)}</span>
            <span class="nutri-id"><strong>${esc(group.nutri.name)}</strong><small>${total} escola(s) · ${money(group.schools.reduce((sum, school) => sum + valueOfSchool(school.id), 0))}</small></span>
            <span class="ring" style="--p:${pct}"><span>${pct}%</span></span>
            <span class="nutri-progress"><span class="bar"><i style="width:${pct}%"></i></span><small>${group.sent} de ${total} inventário(s) enviado(s)</small></span>
            <span class="chev">${icon("chevronDown")}</span>
          </button>
          <div class="collapsible"><div><div class="school-rows">
            ${group.rows.map(({ school, status }) => {
              const key = `${month}:${school.id}`;
              const openSchool = ui.openSchool === key;
              const counts = invCount(month, school.id);
              const rows = Object.entries(counts).map(([itemId, row]) => {
                const item = itemsById.get(itemId);
                return item ? { ...item, value: fmtQty(row.quantity), cost: itemPrice(item) === null ? null : itemPrice(item) * Number(row.quantity || 0) } : null;
              }).filter(Boolean);
              return `<div class="school-row ${openSchool ? "is-open" : ""}">
                <button type="button" class="school-row-head" data-reg-school="${key}">
                  <span class="school-ico">${icon("school")}</span>
                  <span class="school-name"><strong>${esc(school.shortName)}</strong><small>${esc(routeLabel(school.route))}</small></span>
                  <span class="chip ${status.tone}">${icon(status.icon)} ${status.label}</span>
                  ${!status.sent && invDeadlineOf(month, school).closed ? `<span class="chip danger">${icon("lock")} Prazo encerrado</span>` : ""}
                  <span class="meta">${status.sent ? `Enviado em <b>${fmtDateTime(status.sent.sentAt)}</b>` : status.filled ? `${status.filled} item(ns) preenchido(s)` : "Sem itens preenchidos"}${valueOfSchool(school.id) ? ` · <b>${money(valueOfSchool(school.id))}</b>` : ""}</span>
                  <span class="chev">${icon("chevronDown")}</span>
                </button>
                ${openSchool ? `<div class="reg-body">
                  ${status.sent ? `<div class="lock-banner ok">${icon("lock")}<span>Enviado por <b>${esc(status.sent.sentBy)}</b> em ${fmtDateTime(status.sent.sentAt)}. A nutricionista não pode mais alterar.</span><button type="button" class="link-btn" data-reg-reopen="${school.id}">Reabrir para correção</button></div>`
                    : status.filled ? `<div class="lock-banner warn">${icon("edit")}<span>Rascunho ainda não enviado pela nutricionista.</span></div>` : ""}
                  <div class="inv-list flat">${inventoryReadList(rows)}</div>
                </div>` : ""}
              </div>`;
            }).join("") || `<p class="muted pad">Nenhuma escola com os filtros atuais.</p>`}
          </div></div></div>
        </article>`;
      }).join("") || `<div class="panel">${emptyState("Nenhum resultado para os filtros")}</div>`}
    </section>
  `);

  $("#reg-search").addEventListener("input", debounce(event => { ui.search = event.target.value; renderRegistroInventario(); focusEnd("#reg-search"); }, 250));
  $("#reg-month").addEventListener("change", event => { ui.month = event.target.value || currentMonth(); ui.openSchool = ""; renderRegistroInventario(); });
  document.querySelectorAll("[data-reg-status]").forEach(button => button.addEventListener("click", () => { ui.status = button.dataset.regStatus; renderRegistroInventario(); }));
  document.querySelectorAll("[data-reg-nutri]").forEach(button => button.addEventListener("click", () => {
    const id = button.dataset.regNutri;
    if (ui.open.has(id)) ui.open.delete(id); else ui.open.add(id);
    button.closest(".nutri-card").classList.toggle("is-open");
  }));
  document.querySelectorAll("[data-reg-school]").forEach(button => button.addEventListener("click", () => {
    ui.openSchool = ui.openSchool === button.dataset.regSchool ? "" : button.dataset.regSchool;
    renderRegistroInventario();
  }));
  document.querySelectorAll("[data-reg-reopen]").forEach(button => button.addEventListener("click", async () => {
    if (!(await askConfirm({ title: "Reabrir inventário?", text: "A nutricionista poderá editar e enviar novamente.", yesLabel: "Reabrir" }))) return;
    mutate("inventory/reopen", { month, schoolId: button.dataset.regReopen }, "Inventário reaberto para a nutricionista.").catch(() => {});
  }));
}

// ---------- NUTRICIONISTA: preencher e enviar ----------
function renderInventarioNutri() {
  const ui = mod().ui.inv;
  const month = ui.month || currentMonth();
  const schools = schoolsOfNutri(state.user.id);
  const items = mod().data.inventoryItems.filter(item => item.active !== false);
  const sent = schools.filter(school => invSubmission(month, school.id)).length;
  const draft = schools.filter(school => !invSubmission(month, school.id) && Object.keys(invCount(month, school.id)).length).length;
  if (!schools.some(school => school.id === ui.school)) ui.school = schools[0]?.id || "";
  const school = schools.find(item => item.id === ui.school);
  const saved = school ? invCount(month, school.id) : {};
  const submission = school ? invSubmission(month, school.id) : null;
  const deadline = invDeadlineOf(month, school);
  const locked = Boolean(submission) || deadline.closed;
  const draftOf = () => ui.dirty[`${month}:${ui.school}`] || {};
  const dirty = draftOf();
  const valueOf = item => { const draft = draftOf(); return item.id in draft ? draft[item.id] : (saved[item.id] ? fmtQty(saved[item.id].quantity).replace(/\./g, "") : ""); };
  const filled = items.filter(item => String(valueOf(item)).trim() !== "").length;
  const dirtyCount = Object.keys(dirty).length;
  const query = normalizeText(ui.search);
  const visible = items.filter(item => !query || normalizeText(item.name).includes(query));
  const lastUpdate = Object.values(saved).map(row => row.updatedAt).sort().pop();

  shell(`
    ${pageHead({ eyebrow: "Acompanhamento", title: "Inventário de Insumos", subtitle: "Informe o que cada escola teve de inventário no mês e envie para a coordenação." })}
    <section class="stat-row">
      ${statCard({ label: "Minhas escolas", value: fmtNumber(schools.length), iconName: "school", tone: "brand" })}
      ${statCard({ label: `Enviados · ${formatMonthBR(month)}`, value: `${sent}<small>/${schools.length}</small>`, iconName: "check" })}
      ${statCard({ label: "Em preenchimento", value: fmtNumber(draft), iconName: "edit", tone: draft ? "warn" : "" })}
      ${statCard({ label: "Não iniciados", value: fmtNumber(schools.length - sent - draft), iconName: "alert", tone: schools.length - sent - draft ? "warn" : "" })}
    </section>
    <section class="filter-bar">
      <label class="inline-field grow">Escola
        <select id="inv-school">${schools.map(item => {
          const st = invStatus(month, item.id);
          return `<option value="${item.id}" ${item.id === ui.school ? "selected" : ""}>${st.key === "sent" ? "✓ " : invDeadlineOf(month, item).closed ? "✕ " : st.key === "draft" ? "• " : ""}${esc(item.shortName)} — ${esc(routeLabel(item.route))}</option>`;
        }).join("")}</select>
      </label>
      <label class="inline-field">Mês <input id="inv-month" type="month" value="${month}" /></label>
      <label class="search-field">${icon("search")}<input id="inv-search" placeholder="Buscar insumo..." value="${esc(ui.search)}" /></label>
    </section>
    ${school ? `<section class="card inv-list">
      <header class="inv-school-head">
        <span class="school-ico">${icon("school")}</span>
        <div><strong>${esc(school.shortName)}</strong><small>${esc(routeLabel(school.route))}</small></div>
        <span class="chip ${submission ? "ok" : filled ? "warn" : "neutral"}">${submission ? `${icon("check")} Enviado` : `${filled}/${items.length} itens`} · ${formatMonthBR(month)}</span>
        ${!submission ? deadlineChip(deadline) : ""}
        ${!locked && lastUpdate ? `<small class="muted">Rascunho salvo em ${fmtDateTime(lastUpdate)}</small>` : ""}
        ${locked ? "" : `<div class="inv-actions">
          <button class="secondary" id="inv-save" ${dirtyCount ? "" : "disabled"}>${icon("save")} Salvar rascunho${dirtyCount ? ` (${dirtyCount})` : ""}</button>
          <button class="primary" id="inv-send" ${filled ? "" : "disabled"}>${icon("send")} Enviar Inventário</button>
        </div>`}
      </header>
      ${submission ? `<div class="lock-banner ok">${icon("lock")}<span>Inventário enviado em <b>${fmtDateTime(submission.sentAt)}</b>. Não é possível alterar. Se precisar corrigir, fale com a coordenação.</span></div>` : ""}
      ${!submission && deadline.closed ? `<div class="lock-banner danger">${icon("lock")}<span>O prazo de preenchimento da ${esc(routeLabel(school.route))} encerrou em <b>${fmtDate(deadline.date)}</b>. O inventário desta escola não pode mais ser preenchido${Object.keys(saved).length ? " — o rascunho abaixo não foi enviado" : ""}. Fale com a coordenação se precisar de mais prazo.</span></div>` : ""}
      ${inventoryGroups(visible).filter(group => group.items.length).map(group => `<div class="inv-group">
        <header class="inv-group-head"><h3>${esc(group.category)}</h3><small>${group.items.filter(item => String(valueOf(item)).trim() !== "").length}/${group.items.length} informados</small></header>
        ${group.items.map(item => {
          const value = valueOf(item);
          const has = String(value).trim() !== "";
          return `<div class="inv-line ${has ? "on" : ""}">
            <span class="inv-name static">${esc(item.name)}</span>
            ${locked
              ? `<span class="inv-qty-read">${has ? `<b>${esc(value)}</b> ${esc(item.unit)}` : "<span class='muted'>—</span>"}</span>`
              : `<span class="qty-wrap"><input class="cell-input" inputmode="decimal" data-inv-qty="${item.id}" value="${esc(value)}" placeholder="0" /><em>${esc(item.unit)}</em></span>`}
          </div>`;
        }).join("")}
      </div>`).join("") || emptyState(items.length ? "Nenhum insumo encontrado" : "Nenhum insumo ativo", items.length ? "" : "A coordenação ainda não ativou insumos para o inventário.")}
    </section>` : `<div class="panel">${emptyState("Nenhuma escola vinculada")}</div>`}
  `);

  const key = () => `${ui.month || currentMonth()}:${ui.school}`;
  const confirmLeave = async () => !Object.keys(ui.dirty[key()] || {}).length || askConfirm({ title: "Descartar alterações?", text: "Há quantidades não salvas nesta escola.", yesLabel: "Descartar", danger: true, iconName: "alert" });
  $("#inv-school").addEventListener("change", async event => {
    const next = event.target.value;
    event.target.value = ui.school;
    if (!(await confirmLeave())) return;
    delete ui.dirty[key()];
    ui.school = next;
    renderInventario();
  });
  $("#inv-month").addEventListener("change", async event => {
    const next = event.target.value;
    event.target.value = month;
    if (!(await confirmLeave())) return;
    delete ui.dirty[key()];
    ui.month = next || currentMonth();
    renderInventario();
  });
  $("#inv-search").addEventListener("input", debounce(event => { ui.search = event.target.value; renderInventario(); focusEnd("#inv-search"); }, 250));
  if (!school || locked) return;

  const currentRows = () => Object.entries(ui.dirty[key()] || {}).map(([itemId, quantity]) => ({ itemId, quantity: String(quantity).trim() }));
  document.querySelectorAll("[data-inv-qty]").forEach(input => input.addEventListener("input", () => {
    input.value = input.value.replace(/[^\d,]/g, "");
    const bucket = ui.dirty[key()] ||= {};
    bucket[input.dataset.invQty] = input.value;
    input.closest(".inv-line").classList.toggle("on", input.value.trim() !== "");
    const filledNow = items.filter(item => String(valueOf(item)).trim() !== "").length;
    const save = $("#inv-save");
    save.disabled = false;
    save.innerHTML = `${icon("save")} Salvar rascunho (${Object.keys(bucket).length})`;
    $("#inv-send").disabled = !filledNow;
  }));
  $("#inv-save").addEventListener("click", async () => {
    try {
      await mutate("inventory/count", { month, schoolId: ui.school, rows: currentRows() }, "Rascunho salvo.");
      delete ui.dirty[key()];
      renderInventario();
    } catch { /* */ }
  });
  $("#inv-send").addEventListener("click", () => {
    const rows = items.map(item => ({ ...item, value: String(valueOf(item)).trim() })).filter(item => item.value !== "");
    openInventorySendModal(school, month, rows, async () => {
      await mutate("inventory/submit", { month, schoolId: ui.school, rows: currentRows() }, "Inventário enviado para a coordenação.");
      delete ui.dirty[key()];
      renderInventario();
    });
  });
}

function openInventorySendModal(school, month, rows, onConfirm) {
  openConfirmModal({
    iconName: "package",
    title: "Conferir inventário",
    subtitle: `${school.shortName} · ${formatMonthBR(month)} · ${rows.length} item(ns) preenchido(s)`,
    bodyHtml: `<div class="inv-list flat">${inventoryReadList(rows)}</div>`,
    question: "Deseja Enviar Inventário?",
    hint: "Depois de enviado, o inventário desta escola não poderá mais ser alterado.",
    onConfirm
  });
}

// ================================================================ MODAL DE CONFIRMAÇÃO
function openConfirmModal({ iconName = "send", title, subtitle = "", bodyHtml = "", question, hint = "", yesLabel = "Sim, enviar", noLabel = "Não", onConfirm }) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="cf-modal-title">
    <header class="modal-head">
      <span class="school-ico">${icon(iconName)}</span>
      <div><h2 id="cf-modal-title">${esc(title)}</h2>${subtitle ? `<small>${esc(subtitle)}</small>` : ""}</div>
    </header>
    ${bodyHtml ? `<div class="modal-body">${bodyHtml}</div>` : ""}
    <footer class="modal-foot">
      <p class="modal-question">${icon("alert")} <span><b>${esc(question)}</b>${hint ? `<small>${esc(hint)}</small>` : ""}</span></p>
      <div class="modal-actions">
        <button type="button" class="secondary" data-modal-no>${esc(noLabel)}</button>
        <button type="button" class="primary" data-modal-yes>${icon("send")} ${esc(yesLabel)}</button>
      </div>
    </footer>
  </div>`;
  document.body.appendChild(overlay);
  document.body.classList.add("modal-open");
  const close = () => { overlay.remove(); document.body.classList.remove("modal-open"); document.removeEventListener("keydown", onKey); };
  const onKey = event => { if (event.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", event => { if (event.target === overlay) close(); });
  overlay.querySelector("[data-modal-no]").addEventListener("click", close);
  const yes = overlay.querySelector("[data-modal-yes]");
  yes.focus();
  yes.addEventListener("click", async () => {
    yes.disabled = true;
    yes.classList.add("loading");
    try { await onConfirm(); close(); } catch { yes.disabled = false; yes.classList.remove("loading"); }
  });
}

// ================================================================ EXPORTAÇÕES
const EXPORT_KINDS = [
  { match: /^(faturamento|apuracao-consolidada)-/, label: "Faturamento" },
  { match: /maximos/, label: "Máximo" },
  { match: /sem-atendimento/, label: "Sem Atendimento" },
  { match: /^inventario-geral-/, label: "Inventário Geral" },
  { match: /^eventos-/, label: "Eventos" }
];

function exportKind(filename) {
  return EXPORT_KINDS.find(kind => kind.match.test(String(filename)))?.label || "Outro";
}

function renderExportacoes() {
  const ui = mod().ui.exp;
  const data = mod().data;
  const billable = data.events.filter(evt => String(evt.eventDate || "").startsWith(ui.faturamento) && evt.approval === "aprovado" && evt.attendance === "realizado");
  const billableQty = billable.reduce((sum, evt) => sum + (evt.billing || []).reduce((acc, item) => acc + (item.cardId ? Number(item.qty) || 0 : 0), 0), 0);
  const unbilled = billable.filter(evt => (evt.billing || []).some(item => !item.cardId)).length;
  const invSent = Object.keys(data.inventorySubmissions?.[ui.inventario] || {}).length;
  const eventMonths = new Set(data.events.map(evt => String(evt.eventDate || evt.requestDate || "").slice(0, 7)).filter(Boolean));
  const notServed = (state.db.entries || []).filter(entry => entry.status === "not_served").length;
  const history = (state.db.exports || []).slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 15);
  const busy = key => ui.busy === key;
  const button = (key, label = "Gerar Excel") => `<button type="button" class="primary ${busy(key) ? "loading" : ""}" data-exp="${key}" ${ui.busy ? "disabled" : ""}>${icon("download")} ${busy(key) ? "Gerando..." : label}</button>`;

  shell(`
    ${pageHead({ eyebrow: "Apuração", title: "Exportações", subtitle: "Todas as planilhas do sistema em um só lugar. O arquivo é baixado assim que fica pronto." })}
    <section class="exp-grid">
      <article class="card exp-card featured">
        <header><span class="exp-ico">${icon("fileSheet")}</span><div><h3>Exportar - Faturamento</h3><p>Planilha consolidada no modelo da SMED com as apurações do mês <b>mais os eventos aprovados</b>.</p></div></header>
        <div class="exp-body">
          <label class="inline-field">Mês <input type="month" id="exp-fat-month" value="${ui.faturamento}" /></label>
          <ul class="exp-facts">
            <li>${icon("party")} <b>${billable.length}</b> evento(s) entram neste mês · ${fmtNumber(billableQty)} refeição(ões)</li>
            <li>${icon("info")} Só eventos aprovados e confirmados como realizados · Alunos: card 10, quando “Será faturado?” = Sim · Adultos: almoço no CARD 11, lanche no card 10</li>
            ${unbilled ? `<li class="warn-text">${icon("alert")} ${unbilled} evento(s) sem card definido ficam fora (veja a aba “Eventos no faturamento”)</li>` : ""}
          </ul>
        </div>
        <footer>${button("faturamento")}</footer>
      </article>
      <article class="card exp-card">
        <header><span class="exp-ico">${icon("chart")}</span><div><h3>Exportação - Máximo</h3><p>Maior quantidade diária de cada card, por escola e mês, de todos os meses.</p></div></header>
        <div class="exp-body"><ul class="exp-facts"><li>${icon("calendar")} Todos os meses com apuração · filtre pela coluna Mês no Excel</li></ul></div>
        <footer>${button("maximo")}</footer>
      </article>
      <article class="card exp-card">
        <header><span class="exp-ico">${icon("x")}</span><div><h3>Exportação - Sem Atendimento</h3><p>Todas as escolas e datas registradas como sem atendimento, com o motivo.</p></div></header>
        <div class="exp-body"><ul class="exp-facts"><li>${icon("alert")} <b>${fmtNumber(notServed)}</b> ocorrência(s) registradas</li></ul></div>
        <footer>${button("sem-atendimento")}</footer>
      </article>
      <article class="card exp-card">
        <header><span class="exp-ico">${icon("package")}</span><div><h3>Exportação - Inventário Geral</h3><p>Inventário de todas as escolas, separado por nutricionista e suas rotas (uma aba geral e uma por nutricionista).</p></div></header>
        <div class="exp-body">
          <label class="inline-field">Mês <input type="month" id="exp-inv-month" value="${ui.inventario}" /></label>
          <ul class="exp-facts"><li>${icon("check")} <b>${invSent}</b> de ${state.db.schools.length} escola(s) com inventário enviado</li></ul>
        </div>
        <footer>${button("inventario")}</footer>
      </article>
      <article class="card exp-card">
        <header><span class="exp-ico">${icon("party")}</span><div><h3>Exportação - Eventos</h3><p>Tudo o que foi registrado em Eventos, com uma aba para cada mês.</p></div></header>
        <div class="exp-body"><ul class="exp-facts"><li>${icon("calendar")} <b>${data.events.length}</b> evento(s) em ${eventMonths.size} mês(es)</li></ul></div>
        <footer>${button("eventos")}</footer>
      </article>
    </section>
    <section class="card table-card">
      <div class="table-head-line"><strong>Exportações recentes</strong></div>
      <div class="table-scroll">
        <table class="data-table">
          <thead><tr><th>Tipo</th><th>Mês</th><th>Arquivo</th><th>Gerado em</th></tr></thead>
          <tbody>${history.map(item => `<tr><td><span class="chip neutral">${esc(exportKind(item.filename))}</span></td><td>${item.month === "todos" ? "Todos os meses" : esc(formatMonthBR(item.month))}</td><td class="wrap"><code>${esc(item.filename)}</code></td><td>${fmtDateTime(item.createdAt)}</td></tr>`).join("") || `<tr><td colspan="4">${emptyState("Nenhuma exportação gerada ainda")}</td></tr>`}</tbody>
        </table>
      </div>
    </section>
  `);

  $("#exp-fat-month").addEventListener("change", event => { ui.faturamento = event.target.value || currentMonth(); renderExportacoes(); });
  $("#exp-inv-month").addEventListener("change", event => { ui.inventario = event.target.value || currentMonth(); renderExportacoes(); });
  const runners = {
    faturamento: () => mapi("exports/faturamento", { month: ui.faturamento }),
    maximo: () => api("/api/export-maximo", { method: "POST", body: {} }),
    "sem-atendimento": () => api("/api/export-sem-atendimento", { method: "POST", body: {} }),
    inventario: () => mapi("exports/inventario", { month: ui.inventario }),
    eventos: () => mapi("exports/eventos", {})
  };
  document.querySelectorAll("[data-exp]").forEach(btn => btn.addEventListener("click", async () => {
    const key = btn.dataset.exp;
    ui.busy = key;
    renderExportacoes();
    try {
      const result = await runners[key]();
      if (result.base64) downloadBase64File(result);
      state.db = await api("/api/data");
      toast(`Planilha gerada: ${result.filename}`);
    } catch (error) {
      toast(error.message, "error");
    }
    ui.busy = "";
    if (state.view === "exportacoes") renderExportacoes();
  }));
}

// ================================================================ PEDIDOS
function orderAdjustment(order, nutriId) {
  return order.adjustments?.[nutriId] || null;
}

function orderNutriStatus(adjustment) {
  if (adjustment?.finalizedAt) return { key: "final", label: "Finalizado", tone: "ok", icon: "check" };
  if (adjustment?.sentAt) return { key: "sent", label: "Ajuste enviado", tone: "warn", icon: "send" };
  if (adjustment && Object.keys(adjustment.values || {}).length) return { key: "draft", label: "Em ajuste", tone: "neutral", icon: "edit" };
  return { key: "open", label: "Aguardando ajuste", tone: "neutral", icon: "clock" };
}

function orderFinal(line, adjustment) {
  const value = adjustment?.values?.[line.id];
  return value === undefined || value === null || value === "" ? line.qty : Number(value);
}

function orderNutriGroups(order) {
  const byNutri = new Map();
  for (const line of order.lines) {
    if (!byNutri.has(line.nutritionistId)) byNutri.set(line.nutritionistId, []);
    byNutri.get(line.nutritionistId).push(line);
  }
  const users = userMap();
  return [...byNutri.entries()].map(([nutriId, lines]) => ({
    nutriId, name: users.get(nutriId)?.name || "Sem nutricionista", lines,
    schools: new Set(lines.map(line => line.schoolId)).size,
    adjustment: orderAdjustment(order, nutriId), status: orderNutriStatus(orderAdjustment(order, nutriId))
  })).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

function parseAdj(raw) {
  return typeof raw === "number" ? raw : Number(String(raw).replace(",", "."));
}

function orderLinesTable(lines, adjustment, schools, { editable = false, draft = {}, collapsed = new Set(), scope = "" } = {}) {
  const bySchool = new Map();
  for (const line of lines) {
    if (!bySchool.has(line.schoolId)) bySchool.set(line.schoolId, []);
    bySchool.get(line.schoolId).push(line);
  }
  return [...bySchool.entries()]
    .sort((a, b) => String(schools.get(a[0])?.shortName).localeCompare(String(schools.get(b[0])?.shortName), "pt-BR"))
    .map(([schoolId, schoolLines]) => {
      const school = schools.get(schoolId);
      const adjusted = schoolLines.filter(line => {
        const value = line.id in draft ? draft[line.id] : adjustment?.values?.[line.id];
        return value !== undefined && value !== "" && value !== null;
      }).length;
      const key = `${scope}:${schoolId}`;
      const isCollapsed = collapsed.has(key);
      const inventory = latestInventory(schoolId);
      const stockOf = line => {
        const item = inventoryItemFor(line.item);
        const row = item && inventory ? inventory.counts[item.id] : null;
        return row && row.quantity !== undefined && row.quantity !== null && row.quantity !== "" ? Number(row.quantity) : null;
      };
      const invHead = inventory ? `Inventário <small>${esc(monthShort(inventory.month))}${inventory.sent ? "" : " · rascunho"}</small>` : "Inventário";
      return `<div class="order-school ${isCollapsed ? "is-collapsed" : ""}">
        <button type="button" class="order-school-head" data-order-school="${esc(key)}" aria-expanded="${!isCollapsed}">
          <span class="school-ico">${icon("school")}</span>
          <span class="order-school-name"><strong>${esc(school?.shortName || schoolId)}</strong><small>${esc(routeLabel(school?.route))} · ${schoolLines.length} item(ns)${adjusted ? ` · <b>${adjusted} ajustado(s)</b>` : ""} · ${inventory ? `inventário de ${esc(formatMonthBR(inventory.month))}${inventory.sent ? "" : " (em preenchimento)"}` : "sem inventário"}</small></span>
          <span class="chev">${icon("chevronDown")}</span>
        </button>
        <div class="order-school-body">
        <table class="data-table order-table">
          <thead><tr><th>Item</th><th>Unid.</th><th class="num ot-inv">${invHead}</th><th class="num">Qtd. prevista</th><th class="num">${editable ? "Ajuste" : "Qtd. ajustada"}</th><th class="num">${editable ? "Diferença" : "Qtd. final"}</th></tr></thead>
          <tbody>${schoolLines.sort((a, b) => a.item.localeCompare(b.item, "pt-BR")).map(line => {
            const raw = line.id in draft ? draft[line.id] : adjustment?.values?.[line.id];
            const has = raw !== undefined && raw !== null && raw !== "";
            const value = has ? parseAdj(raw) : null;
            const diff = has && Number.isFinite(value) ? value - line.qty : 0;
            return `<tr class="${has && diff ? "is-adjusted" : ""}">
              <td class="ot-item">${esc(line.item)}${line.unit ? `<small class="ot-unit">${esc(line.unit)}</small>` : ""}</td><td class="ot-unit-col">${esc(line.unit || "—")}</td><td class="num ot-inv" data-label="Inventário">${stockOf(line) === null ? "<span class='muted'>—</span>" : fmtQty(stockOf(line))}</td><td class="num" data-label="Prevista">${fmtQty(line.qty)}</td>
              <td class="num" data-label="${editable ? "Ajuste" : "Ajustada"}">${editable
                ? `<input class="cell-input" inputmode="decimal" data-aped="${line.id}" value="${has ? esc(String(raw).replace(".", ",")) : ""}" placeholder="${esc(fmtQty(line.qty))}" />`
                : has ? `<b>${fmtQty(value)}</b>` : "<span class='muted'>sem ajuste</span>"}</td>
              <td class="num" data-label="${editable ? "Diferença" : "Final"}" ${editable ? `data-aped-diff="${line.id}"` : ""}>${editable
                ? (has && diff ? `<span class="diff ${diff > 0 ? "up" : "down"}">${diff > 0 ? "+" : ""}${fmtQty(diff)}</span>` : "<span class='muted'>—</span>")
                : `<b>${fmtQty(orderFinal(line, adjustment))}</b>${has && diff ? ` <span class="diff ${diff > 0 ? "up" : "down"}">${diff > 0 ? "+" : ""}${fmtQty(diff)}</span>` : ""}`}</td>
            </tr>`;
          }).join("")}</tbody>
        </table>
        </div>
      </div>`;
    }).join("");
}

// Recolhe/expande a escola sem redesenhar a tela (preserva o que já foi digitado).
function bindOrderSchoolToggles(collapsed) {
  document.querySelectorAll("[data-order-school]").forEach(button => button.addEventListener("click", () => {
    const key = button.dataset.orderSchool;
    const box = button.closest(".order-school");
    const nowCollapsed = !box.classList.contains("is-collapsed");
    box.classList.toggle("is-collapsed", nowCollapsed);
    button.setAttribute("aria-expanded", String(!nowCollapsed));
    if (nowCollapsed) collapsed.add(key); else collapsed.delete(key);
    if (nowCollapsed && box.getBoundingClientRect().top < 0) box.scrollIntoView({ block: "start", behavior: "smooth" });
  }));
}

// ---------- ADMIN: Pedidos ----------
function renderPedidos() {
  const ui = mod().ui.ped;
  const orders = mod().data.orders || [];
  const schools = schoolMap();
  const allGroups = orders.map(order => ({ order, groups: orderNutriGroups(order) }));
  const waiting = allGroups.reduce((sum, row) => sum + row.groups.filter(group => group.status.key === "sent").length, 0);
  const finals = allGroups.filter(row => row.groups.length && row.groups.every(group => group.status.key === "final")).length;

  shell(`
    ${pageHead({
      eyebrow: "Pedidos",
      title: "Pedidos",
      subtitle: "Envie a planilha do pedido: o sistema lê o Excel e distribui as quantidades para cada nutricionista ajustar.",
      actions: `<button class="secondary" id="ped-template">${icon("download")} Baixar modelo</button><button class="primary" id="ped-new">${icon("upload")} Novo pedido</button>`
    })}
    ${olderOrdersBar()}
    <section class="stat-row">
      ${statCard({ label: "Pedidos", value: fmtNumber(orders.length), iconName: "cart", tone: "brand" })}
      ${statCard({ label: "Ajustes para finalizar", value: fmtNumber(waiting), iconName: "send", tone: waiting ? "warn" : "" })}
      ${statCard({ label: "Pedidos finalizados", value: `${finals}<small>/${orders.length}</small>`, iconName: "check" })}
      ${statCard({ label: "Itens distribuídos", value: fmtNumber(orders.reduce((sum, order) => sum + order.lines.length, 0)), iconName: "package" })}
    </section>
    ${ui.step === "upload" ? orderUploadCard() : ""}
    <section class="nutri-list">
      ${allGroups.map(({ order, groups }) => {
        const open = ui.openOrder === order.id;
        const done = groups.filter(group => group.status.key === "final").length;
        const sent = groups.filter(group => group.status.key === "sent").length;
        const pct = groups.length ? Math.round(done / groups.length * 100) : 0;
        return `<article class="card nutri-card order-card ${open ? "is-open" : ""}">
          <button type="button" class="nutri-head" data-ped-order="${order.id}">
            <span class="school-ico lg">${icon("cart")}</span>
            <span class="nutri-id"><strong>${esc(order.title)}</strong><small>${esc(formatMonthBR(order.month))}${order.deliveryDate ? ` · entrega ${fmtDate(order.deliveryDate)}` : ""} · ${order.lines.length} item(ns) · ${groups.length} nutricionista(s)</small></span>
            ${sent ? `<span class="chip warn">${icon("send")} ${sent} para finalizar</span>` : ""}
            <span class="ring" style="--p:${pct}"><span>${pct}%</span></span>
            <span class="nutri-progress"><span class="bar"><i style="width:${pct}%"></i></span><small>${done} de ${groups.length} finalizado(s)</small></span>
            <span class="chev">${icon("chevronDown")}</span>
          </button>
          ${open ? `<div class="order-body">
            <div class="order-meta">
              <span>${icon("fileSheet")} ${esc(order.fileName || "planilha")}${order.sheet ? ` · aba “${esc(order.sheet)}”` : ""}</span>
              <span>${icon("clock")} enviado por ${esc(order.createdBy)} em ${fmtDateTime(order.createdAt)}</span>
              <span class="grow"></span>
              ${order.archived ? `<span class="chip neutral">${icon("clock")} Pedido anterior · só consulta</span>` : ""}
              ${sent && !order.archived ? `<button type="button" class="secondary sm" data-ped-finalize-all="${order.id}">${icon("check")} Finalizar todos os enviados (${sent})</button>` : ""}
              <button type="button" class="secondary sm" data-ped-export="${order.id}">${icon("download")} Baixar Excel do pedido</button>
              ${order.archived ? "" : `<button type="button" class="icon-btn danger" data-ped-delete="${order.id}" title="Excluir pedido">${icon("trash")}</button>`}
            </div>
            ${order.unmatched?.length ? `<div class="lock-banner warn">${icon("alert")}<span><b>${order.unmatched.reduce((sum, row) => sum + row.rows, 0)} linha(s)</b> com escola não reconhecida ficaram de fora: ${order.unmatched.slice(0, 5).map(row => esc(row.label)).join(", ")}${order.unmatched.length > 5 ? "…" : ""}</span></div>` : ""}
            <div class="school-rows">
              ${groups.map(group => {
                const key = `${order.id}:${group.nutriId}`;
                const openNutri = ui.openSchool === key;
                const adjusted = Object.keys(group.adjustment?.values || {}).length;
                return `<div class="school-row ${openNutri ? "is-open" : ""}">
                  <div class="school-row-head as-div">
                    <button type="button" class="row-toggle" data-ped-nutri="${key}">
                      <span class="avatar">${esc(initials(group.name))}</span>
                      <span class="school-name"><strong>${esc(group.name)}</strong><small>${group.schools} escola(s) · ${group.lines.length} item(ns)${adjusted ? ` · ${adjusted} ajuste(s)` : ""}</small></span>
                    </button>
                    <span class="chip ${group.status.tone}">${icon(group.status.icon)} ${group.status.label}</span>
                    <span class="meta">${group.adjustment?.finalizedAt ? `Finalizado em <b>${fmtDateTime(group.adjustment.finalizedAt)}</b>` : group.adjustment?.sentAt ? `Enviado em <b>${fmtDateTime(group.adjustment.sentAt)}</b>` : "Ainda não enviado"}</span>
                    ${group.status.key === "sent" && !order.archived ? `<span class="row-btns"><button type="button" class="link-btn" data-ped-return="${key}">Devolver</button><button type="button" class="primary sm" data-ped-finalize="${key}">${icon("check")} Finalizar</button></span>` : ""}
                    <button type="button" class="chev-btn" data-ped-nutri="${key}" aria-label="Abrir">${icon("chevronDown")}</button>
                  </div>
                  ${openNutri ? `<div class="reg-body">${orderLinesTable(group.lines, group.adjustment, schools, { collapsed: ui.collapsed ||= new Set(), scope: key })}</div>` : ""}
                </div>`;
              }).join("") || `<p class="muted pad">Nenhuma linha distribuída.</p>`}
            </div>
          </div>` : ""}
        </article>`;
      }).join("") || (ui.step === "upload" ? "" : `<div class="panel">${emptyState("Nenhum pedido ainda", "Clique em “Novo pedido” e envie a planilha do Excel.", "cart")}</div>`)}
    </section>
  `);

  $("#ped-new").addEventListener("click", () => { ui.step = "upload"; ui.upload = null; renderPedidos(); });
  $("#ped-template").addEventListener("click", async () => {
    try { downloadBase64File(await mapi("orders/template", {})); } catch (error) { toast(error.message, "error"); }
  });
  bindOrderUpload();
  bindOrderSchoolToggles(ui.collapsed ||= new Set());
  document.querySelectorAll("[data-ped-order]").forEach(button => button.addEventListener("click", () => { ui.openOrder = ui.openOrder === button.dataset.pedOrder ? "" : button.dataset.pedOrder; renderPedidos(); }));
  document.querySelectorAll("[data-ped-nutri]").forEach(button => button.addEventListener("click", () => { ui.openSchool = ui.openSchool === button.dataset.pedNutri ? "" : button.dataset.pedNutri; renderPedidos(); }));
  document.querySelectorAll("[data-ped-finalize]").forEach(button => button.addEventListener("click", () => {
    const [id, nutritionistId] = button.dataset.pedFinalize.split(":");
    mutate("orders/finalize", { id, nutritionistId }, "Ajuste finalizado.").catch(() => {});
  }));
  document.querySelectorAll("[data-ped-return]").forEach(button => button.addEventListener("click", async () => {
    if (!(await askConfirm({ title: "Devolver ajuste?", text: "A nutricionista poderá alterar e enviar de novo.", yesLabel: "Devolver" }))) return;
    const [id, nutritionistId] = button.dataset.pedReturn.split(":");
    mutate("orders/finalize", { id, nutritionistId, action: "return" }, "Ajuste devolvido para a nutricionista.").catch(() => {});
  }));
  document.querySelectorAll("[data-ped-finalize-all]").forEach(button => button.addEventListener("click", () => {
    const order = orders.find(item => item.id === button.dataset.pedFinalizeAll);
    const ids = orderNutriGroups(order).filter(group => group.status.key === "sent").map(group => group.nutriId);
    mutate("orders/finalize", { id: order.id, nutritionistIds: ids }, `${ids.length} ajuste(s) finalizado(s).`).catch(() => {});
  }));
  document.querySelectorAll("[data-ped-export]").forEach(button => button.addEventListener("click", async () => {
    try { downloadBase64File(await mapi("orders/export", { id: button.dataset.pedExport })); } catch (error) { toast(error.message, "error"); }
  }));
  document.querySelectorAll("[data-ped-delete]").forEach(button => button.addEventListener("click", async () => {
    if (!(await askConfirm({ title: "Excluir pedido?", text: "Os ajustes das nutricionistas também serão apagados.", yesLabel: "Excluir", danger: true }))) return;
    mutate("orders/delete", { id: button.dataset.pedDelete }, "Pedido excluído.").catch(() => {});
  }));
}

const ORDER_FIELDS = [
  ["code", "Código da escola"],
  ["school", "Nome da escola"],
  ["item", "Item / produto"],
  ["unit", "Unidade"],
  ["qty", "Quantidade"]
];

function orderUploadCard() {
  const up = mod().ui.ped.upload;
  if (!up) {
    return `<section class="card form-card pop-in" id="ped-upload">
      <div class="form-title">${icon("upload")}<strong>Novo pedido</strong><button type="button" class="link-btn" data-ped-cancel>Cancelar</button></div>
      <label class="dropzone big">${icon("fileSheet")}<span><b>Selecione a planilha do pedido (.xlsx)</b><small>Uma linha por escola e item (escola, item, unidade, quantidade) ou uma coluna por escola. Use “Baixar modelo” se precisar de um exemplo.</small></span>
        <input type="file" id="ped-file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden /></label>
      ${mod().ui.ped.reading ? `<p class="uploading"><i class="spinner"></i> Lendo a planilha...</p>` : ""}
    </section>`;
  }
  if (up.preview.layout) {
    const layout = up.preview.layout;
    const unmatched = up.preview.unmatched || [];
    return `<section class="card form-card pop-in" id="ped-upload">
      <div class="form-title">${icon("fileSheet")}<strong>Conferir leitura · ${esc(up.name)}</strong><button type="button" class="link-btn" data-ped-cancel>Cancelar</button></div>
      <div class="form-grid cols-4">
        <label class="field wide2"><span>Nome do pedido</span><input id="ped-title" value="${esc(up.title)}" required /></label>
        <label class="field"><span>Competência</span><input type="month" id="ped-month" value="${esc(up.month)}" /></label>
        <label class="field"><span>Data de entrega (opcional)</span><input type="date" id="ped-delivery" value="${esc(up.deliveryDate || "")}" /></label>
      </div>
      <div class="lock-banner ok">${icon("check")}<span><b>Modelo reconhecido:</b> ${esc(layout.label)} · aba(s) ${layout.sheets.map(esc).join(" e ")}. Escolas em colunas, insumos em linhas.</span></div>
      <section class="stat-row compact">
        ${statCard({ label: "Escolas reconhecidas", value: fmtNumber(layout.schools), iconName: "school", tone: "brand" })}
        ${statCard({ label: "Insumos (linhas)", value: fmtNumber(layout.items), iconName: "package" })}
        ${statCard({ label: "Quantidades lidas", value: fmtNumber(up.preview.lines), iconName: "table" })}
        ${statCard({ label: "Escolas não encontradas", value: fmtNumber(unmatched.length), iconName: "alert", tone: unmatched.length ? "warn" : "" })}
      </section>
      ${unmatched.length ? `<div class="lock-banner warn">${icon("alert")}<span>Ficam de fora (não estão cadastradas no sistema): ${unmatched.map(row => `<b>${esc(row.label)}</b>${row.rows ? ` (${row.rows} item(ns))` : " (sem quantidades)"}`).join("; ")}</span></div>` : ""}
      <div class="table-scroll preview-scroll">
        <table class="data-table preview-table"><thead><tr><th>Escola</th><th>Insumo</th><th>Unid.</th><th class="num">Qtd.</th></tr></thead>
        <tbody>${up.preview.sample.map(row => `<tr><td>${esc(row.school)}</td><td>${esc(row.item)}</td><td>${esc(row.unit)}</td><td class="num">${fmtQty(row.qty)}</td></tr>`).join("")}</tbody></table>
      </div>
      <div class="form-actions"><button type="button" class="secondary" data-ped-cancel>Cancelar</button><button type="button" class="primary" id="ped-create">${icon("send")} Distribuir para as nutricionistas</button></div>
    </section>`;
  }
  const sheet = up.preview.sheets.find(item => item.name === up.sheet) || up.preview.sheets[0];
  const used = new Map(Object.entries(up.mapping).filter(([, index]) => index >= 0).map(([key, index]) => [Number(index), key]));
  const fieldLabel = Object.fromEntries(ORDER_FIELDS);
  const options = selected => `<option value="-1">— não usar —</option>${sheet.headers.map((header, index) => `<option value="${index}" ${Number(selected) === index ? "selected" : ""}>${esc(header)}</option>`).join("")}`;
  return `<section class="card form-card pop-in" id="ped-upload">
    <div class="form-title">${icon("fileSheet")}<strong>Conferir leitura · ${esc(up.name)}</strong><button type="button" class="link-btn" data-ped-cancel>Cancelar</button></div>
    <div class="form-grid cols-4">
      <label class="field wide2"><span>Nome do pedido</span><input id="ped-title" value="${esc(up.title)}" required /></label>
      <label class="field"><span>Competência</span><input type="month" id="ped-month" value="${esc(up.month)}" /></label>
      <label class="field"><span>Data de entrega (opcional)</span><input type="date" id="ped-delivery" value="${esc(up.deliveryDate || "")}" /></label>
      ${up.preview.sheets.length > 1 ? `<label class="field wide2"><span>Aba da planilha</span><select id="ped-sheet">${up.preview.sheets.map(item => `<option value="${esc(item.name)}" ${item.name === sheet.name ? "selected" : ""}>${esc(item.name)} (${item.rowCount} linhas)</option>`).join("")}</select></label>` : ""}
      <label class="field wide2"><span>Formato</span><select id="ped-mode">
        <option value="linhas" ${up.mode === "linhas" ? "selected" : ""}>Uma linha por escola e item</option>
        <option value="colunas" ${up.mode === "colunas" ? "selected" : ""}>Uma coluna por escola${sheet.schoolColumns.length ? ` (${sheet.schoolColumns.length} escolas reconhecidas)` : ""}</option>
      </select></label>
    </div>
    <div class="map-grid">
      ${ORDER_FIELDS.filter(([key]) => up.mode === "linhas" || ["item", "unit"].includes(key)).map(([key, label]) => `<label class="field"><span>${label}${["item", "qty"].includes(key) || (key === "school" && up.mapping.code < 0) ? " *" : ""}</span><select data-ped-map="${key}">${options(up.mapping[key])}</select></label>`).join("")}
    </div>
    <p class="form-hint">${icon("info")} Escolas são reconhecidas pelo código (ex.: 0101) ou pelo nome. Linhas sem quantidade são ignoradas. Cada escola vai para a nutricionista responsável por ela. Cabeçalho encontrado na linha ${sheet.headerRow}; ${sheet.rowCount} linha(s) de dados.</p>
    <div class="table-scroll preview-scroll">
      <table class="data-table preview-table">
        <thead><tr>${sheet.headers.map((header, index) => `<th class="${used.has(index) || (up.mode === "colunas" && sheet.schoolColumns.includes(index)) ? "is-map" : ""}">${esc(header)}${used.has(index) ? `<small>${esc(fieldLabel[used.get(index)])}</small>` : up.mode === "colunas" && sheet.schoolColumns.includes(index) ? "<small>Escola</small>" : ""}</th>`).join("")}</tr></thead>
        <tbody>${sheet.sample.map(row => `<tr>${sheet.headers.map((_, index) => `<td class="${used.has(index) ? "is-map" : ""}">${esc(row[index] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>
    </div>
    <div class="form-actions"><button type="button" class="secondary" data-ped-cancel>Cancelar</button><button type="button" class="primary" id="ped-create">${icon("send")} Ler e distribuir para as nutricionistas</button></div>
  </section>`;
}

// Competência sugerida pelo nome do arquivo ("DEZEMBRO" ou "01.12"); senão, o mês atual.
function guessOrderMonth(name) {
  const text = normalizeText(name).toUpperCase();
  const names = ["JANEIRO", "FEVEREIRO", "MARCO", "ABRIL", "MAIO", "JUNHO", "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO"];
  let index = names.findIndex(month => text.includes(month));
  if (index < 0) {
    const date = text.match(/\b(\d{2})[./](\d{2})\b/);
    if (date && Number(date[2]) >= 1 && Number(date[2]) <= 12) index = Number(date[2]) - 1;
  }
  if (index < 0) return currentMonth();
  const [year, current] = currentMonth().split("-").map(Number);
  const targetYear = index + 1 < current - 6 ? year + 1 : year;
  return `${targetYear}-${String(index + 1).padStart(2, "0")}`;
}

function bindOrderUpload() {
  const ui = mod().ui.ped;
  if (ui.step !== "upload") return;
  document.querySelectorAll("[data-ped-cancel]").forEach(button => button.addEventListener("click", () => { ui.step = "list"; ui.upload = null; renderPedidos(); }));
  $("#ped-file")?.addEventListener("change", async event => {
    const file = event.target.files[0];
    if (!file) return;
    ui.reading = true;
    renderPedidos();
    try {
      const data = await readFileAsBase64(file);
      const preview = await mapi("orders/preview", { data });
      const sheet = preview.sheets[0] || { name: "", mode: "", mapping: {} };
      ui.upload = { name: file.name, data, preview, sheet: sheet.name, mode: sheet.mode, mapping: { ...sheet.mapping }, title: file.name.replace(/\.[^.]+$/, "").replace(/\s+/g, " ").trim(), month: guessOrderMonth(file.name), deliveryDate: "" };
    } catch (error) {
      toast(error.message, "error");
    }
    ui.reading = false;
    renderPedidos();
  });
  const up = ui.upload;
  if (!up) return;
  const keep = () => { up.title = $("#ped-title").value; up.month = $("#ped-month").value; up.deliveryDate = $("#ped-delivery").value; };
  $("#ped-sheet")?.addEventListener("change", event => {
    keep();
    const sheet = up.preview.sheets.find(item => item.name === event.target.value);
    Object.assign(up, { sheet: sheet.name, mode: sheet.mode, mapping: { ...sheet.mapping } });
    renderPedidos();
  });
  $("#ped-mode")?.addEventListener("change", event => { keep(); up.mode = event.target.value; renderPedidos(); });
  document.querySelectorAll("[data-ped-map]").forEach(select => select.addEventListener("change", () => { keep(); up.mapping[select.dataset.pedMap] = Number(select.value); renderPedidos(); }));
  $("#ped-create").addEventListener("click", async () => {
    keep();
    if (!up.title.trim()) return toast("Dê um nome ao pedido.", "error");
    const button = $("#ped-create");
    button.disabled = true;
    button.classList.add("loading");
    try {
      const result = await mapi("orders/create", { data: up.data, fileName: up.name, title: up.title, month: up.month, deliveryDate: up.deliveryDate, sheet: up.sheet, mode: up.mode, mapping: up.mapping });
      await loadModules();
      ui.step = "list";
      ui.upload = null;
      ui.openOrder = result.id;
      toast(`${result.lines} item(ns) distribuídos${result.unmatched ? ` · ${result.unmatched} escola(s) não reconhecida(s)` : ""}${result.withoutNutri ? ` · ${result.withoutNutri} item(ns) sem nutricionista` : ""}.`);
      renderPedidos();
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
      button.classList.remove("loading");
    }
  });
}

// ---------- NUTRICIONISTA: Ajuste de Pedido ----------
function renderAjustePedido() {
  const ui = mod().ui.aped;
  const orders = mod().data.orders || [];
  const schools = schoolMap();
  if (!orders.some(order => order.id === ui.order)) {
    ui.order = (orders.find(order => !order.archived && !orderAdjustment(order, state.user.id)?.sentAt) || orders[0])?.id || "";
  }
  const order = orders.find(item => item.id === ui.order);
  const adjustment = order ? orderAdjustment(order, state.user.id) : null;
  const status = orderNutriStatus(adjustment);
  const locked = Boolean(adjustment?.sentAt) || Boolean(order?.archived);
  const draft = ui.dirty[ui.order] ||= {};
  const query = normalizeText(ui.search);
  const lines = order ? order.lines.filter(line => !query || normalizeText(`${line.item} ${schools.get(line.schoolId)?.shortName}`).includes(query)) : [];
  const pendingCount = orders.filter(item => !item.archived && !orderAdjustment(item, state.user.id)?.sentAt).length;
  const currentValue = line => (line.id in draft ? draft[line.id] : adjustment?.values?.[line.id]);
  const adjustedCount = order ? order.lines.filter(line => { const value = currentValue(line); return value !== undefined && value !== "" && value !== null; }).length : 0;

  shell(`
    ${pageHead({ eyebrow: "Pedidos", title: "Ajuste de Pedido", subtitle: "Confira a quantidade prevista de cada item nas suas escolas. Preencha o ajuste só onde precisar mudar — o que ficar em branco segue como previsto." })}
    <section class="stat-row">
      ${statCard({ label: "Pedidos recebidos", value: fmtNumber(orders.length), iconName: "cart", tone: "brand" })}
      ${statCard({ label: "Aguardando seu envio", value: fmtNumber(pendingCount), iconName: "clock", tone: pendingCount ? "warn" : "" })}
      ${statCard({ label: "Itens neste pedido", value: fmtNumber(order?.lines.length || 0), iconName: "package" })}
      ${statCard({ label: "Itens ajustados", value: fmtNumber(adjustedCount), iconName: "edit" })}
    </section>
    ${olderOrdersBar()}
    ${orders.length ? `<section class="filter-bar">
      <label class="inline-field grow">Pedido
        <select id="aped-order">${orders.map(item => {
          const st = orderNutriStatus(orderAdjustment(item, state.user.id));
          return `<option value="${item.id}" ${item.id === ui.order ? "selected" : ""}>${item.archived ? "🕘 " : st.key === "final" ? "✓ " : st.key === "sent" ? "➜ " : "• "}${esc(item.title)} — ${esc(formatMonthBR(item.month))}${item.archived ? " (anterior)" : ""}</option>`;
        }).join("")}</select>
      </label>
      <label class="search-field">${icon("search")}<input id="aped-search" placeholder="Buscar item ou escola..." value="${esc(ui.search)}" /></label>
    </section>
    <section class="card inv-list">
      <header class="inv-school-head">
        <span class="school-ico">${icon("cart")}</span>
        <div><strong>${esc(order.title)}</strong><small>${esc(formatMonthBR(order.month))}${order.deliveryDate ? ` · entrega ${fmtDate(order.deliveryDate)}` : ""} · ${new Set(order.lines.map(line => line.schoolId)).size} escola(s)</small></div>
        <span class="chip ${status.tone}">${icon(status.icon)} ${status.label}</span>
        ${locked ? "" : `<div class="inv-actions">
          <button class="secondary" id="aped-save" ${Object.keys(draft).length ? "" : "disabled"}>${icon("save")} Salvar rascunho</button>
          <button class="primary" id="aped-send">${icon("send")} Enviar ajuste</button>
        </div>`}
      </header>
      ${order.archived ? `<div class="lock-banner">${icon("clock")}<span>Pedido anterior, aberto só para consulta.</span></div>` : ""}
      ${adjustment?.finalizedAt ? `<div class="lock-banner ok">${icon("check")}<span>Pedido <b>finalizado</b> pela coordenação em ${fmtDateTime(adjustment.finalizedAt)}.</span></div>`
        : locked ? `<div class="lock-banner warn">${icon("lock")}<span>Ajuste enviado em <b>${fmtDateTime(adjustment.sentAt)}</b>. Aguardando a coordenação finalizar — não é possível alterar.</span></div>` : ""}
      ${lines.length ? orderLinesTable(lines, adjustment, schools, { editable: !locked, draft, collapsed: ui.collapsed ||= new Set(), scope: order.id }) : emptyState("Nenhum item encontrado")}
    </section>` : `<div class="panel">${emptyState("Nenhum pedido para ajustar", "Quando a coordenação enviar um pedido com as suas escolas, ele aparece aqui.", "cart")}</div>`}
  `);

  if (!order) return;
  const confirmLeave = async () => !Object.keys(ui.dirty[ui.order] || {}).length || askConfirm({ title: "Descartar ajustes?", text: "Há ajustes não salvos neste pedido.", yesLabel: "Descartar", danger: true, iconName: "alert" });
  $("#aped-order").addEventListener("change", async event => {
    const next = event.target.value;
    event.target.value = ui.order;
    if (!(await confirmLeave())) return;
    delete ui.dirty[ui.order];
    ui.order = next;
    renderAjustePedido();
  });
  $("#aped-search").addEventListener("input", debounce(event => { ui.search = event.target.value; renderAjustePedido(); focusEnd("#aped-search"); }, 250));
  bindOrderSchoolToggles(ui.collapsed ||= new Set());
  if (locked) return;
  const byId = new Map(order.lines.map(line => [line.id, line]));
  document.querySelectorAll("[data-aped]").forEach(input => input.addEventListener("input", () => {
    input.value = input.value.replace(/[^\d,]/g, "");
    draft[input.dataset.aped] = input.value;
    const line = byId.get(input.dataset.aped);
    const value = parseAdj(input.value);
    const diff = input.value !== "" && Number.isFinite(value) ? value - line.qty : 0;
    input.closest("tr").classList.toggle("is-adjusted", Boolean(diff));
    document.querySelector(`[data-aped-diff="${line.id}"]`).innerHTML = diff ? `<span class="diff ${diff > 0 ? "up" : "down"}">${diff > 0 ? "+" : ""}${fmtQty(diff)}</span>` : "<span class='muted'>—</span>";
    $("#aped-save").disabled = false;
  }));
  const values = () => Object.fromEntries(Object.entries(draft).map(([id, value]) => [id, String(value).trim()]));
  $("#aped-save").addEventListener("click", async () => {
    try {
      await mutate("orders/adjust", { id: order.id, values: values() }, "Rascunho do ajuste salvo.");
      delete ui.dirty[order.id];
      renderAjustePedido();
    } catch { /* */ }
  });
  $("#aped-send").addEventListener("click", () => {
    const changed = order.lines.map(line => {
      const raw = currentValue(line);
      if (raw === undefined || raw === null || raw === "") return null;
      return { line, value: parseAdj(raw) };
    }).filter(Boolean);
    const body = changed.length
      ? `<table class="data-table order-table"><thead><tr><th>Escola</th><th>Item</th><th class="num">Prevista</th><th class="num">Ajustada</th></tr></thead><tbody>${changed.map(({ line, value }) => `<tr><td>${esc(schools.get(line.schoolId)?.shortName)}</td><td>${esc(line.item)} <small class="muted">${esc(line.unit)}</small></td><td class="num">${fmtQty(line.qty)}</td><td class="num"><b>${fmtQty(value)}</b></td></tr>`).join("")}</tbody></table>`
      : `<p class="muted pad">${icon("check")} Nenhum item ajustado — todas as quantidades seguem como previstas (${order.lines.length} itens).</p>`;
    openConfirmModal({
      iconName: "cart",
      title: "Conferir ajuste do pedido",
      subtitle: `${order.title} · ${changed.length} item(ns) ajustado(s) de ${order.lines.length}`,
      bodyHtml: body,
      question: "Deseja enviar o ajuste do pedido?",
      hint: "Depois de enviado, vai para a coordenação finalizar e não poderá mais ser alterado.",
      onConfirm: async () => {
        await mutate("orders/adjust", { id: order.id, values: values(), send: true }, "Ajuste enviado para a coordenação.");
        delete ui.dirty[order.id];
        renderAjustePedido();
      }
    });
  });
}

// ================================================================ CONTROLE DE KM
const WEEKDAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

function previousMonth(month) {
  const [year, number] = month.split("-").map(Number);
  const date = new Date(year, number - 2, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function daysOfMonth(month) {
  const [year, number] = month.split("-").map(Number);
  const last = new Date(year, number, 0).getDate();
  return Array.from({ length: last }, (_, index) => {
    const day = String(index + 1).padStart(2, "0");
    const iso = `${month}-${day}`;
    const weekday = new Date(`${iso}T00:00:00`).getDay();
    return { iso, day, weekday, weekend: weekday === 0 || weekday === 6 };
  });
}

function fmtKm(value) {
  return Number(value || 0).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
}

function parseKm(value) {
  if (value === "" || value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  const number = Number(String(value).replace(/\./g, "").replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function kmLog(month, nutriId) {
  return mod().data.km?.logs?.[month]?.[nutriId] || null;
}

function kmTotalsOf(days) {
  let total = 0;
  let filled = 0;
  for (const row of Object.values(days || {})) {
    const start = parseKm(row.start);
    const end = parseKm(row.end);
    if (start === null || end === null) continue;
    total += end - start;
    filled += 1;
  }
  return { total: Math.round(total * 10) / 10, filled };
}

function kmStatus(log) {
  if (log?.review?.status === "conferido") return { key: "ok", label: "Conferido", tone: "ok", icon: "check" };
  if (log?.sentAt) return { key: "sent", label: "Enviado ao ADM", tone: "warn", icon: "send" };
  if (log?.review?.status === "devolvido") return { key: "back", label: "Devolvido", tone: "danger", icon: "alert" };
  if (Object.keys(log?.days || {}).length) return { key: "draft", label: "Em preenchimento", tone: "neutral", icon: "edit" };
  return { key: "none", label: "Não iniciado", tone: "neutral", icon: "clock" };
}

function fuelText(value, digits = 2) {
  return value === "" || value === null || value === undefined ? "" : Number(value).toFixed(digits).replace(".", ",");
}

// Tabela diária do KM. Nutricionista: KM inicial/final + observação. ADM: abastecimento (L) e valor (R$) à esquerda.
function kmDayTable(month, days, { editable = false, draft = {}, fuel = null, fuelEditable = false, fuelDraft = {} } = {}) {
  const today = serverToday();
  const valueOf = (iso, field) => (draft[iso] && field in draft[iso] ? draft[iso][field] : days?.[iso]?.[field] ?? "");
  const showFuel = Boolean(fuel) || fuelEditable;
  const fuelOf = (iso, field) => (fuelDraft[iso] && field in fuelDraft[iso] ? fuelDraft[iso][field] : fuelText(fuel?.[iso]?.[field]));
  let lastEnd = null;
  const rows = daysOfMonth(month).map(day => {
    const start = valueOf(day.iso, "start");
    const end = valueOf(day.iso, "end");
    const s = parseKm(start);
    const e = parseKm(end);
    const diff = s !== null && e !== null ? e - s : null;
    const future = day.iso > today;
    const hint = lastEnd !== null ? fmtKm(lastEnd) : "";
    if (e !== null) lastEnd = e;
    const note = valueOf(day.iso, "note") || "";
    const liters = showFuel ? fuelOf(day.iso, "liters") : "";
    const fuelValue = showFuel ? fuelOf(day.iso, "value") : "";
    if (!editable && !fuelEditable && start === "" && end === "" && !note && liters === "" && fuelValue === "") return "";
    const cell = (field, value, placeholder) => editable
      ? `<input class="cell-input" inputmode="decimal" data-km="${day.iso}" data-field="${field}" value="${esc(value === "" || value === null ? "" : String(value).replace(".", ","))}" placeholder="${esc(placeholder)}" ${future ? "disabled title='Dia ainda não chegou'" : ""} />`
      : (value === "" || value === null ? "<span class='muted'>—</span>" : fmtKm(value));
    const fuelCell = (field, value, label) => fuelEditable
      ? `<input class="cell-input" inputmode="decimal" data-fuel="${day.iso}" data-field="${field}" value="${esc(value)}" placeholder="${field === "value" ? "0,00" : "0"}" aria-label="${label}" />`
      : value === "" ? "<span class='muted'>—</span>" : field === "value" ? money(Number(String(value).replace(",", "."))) : `${esc(value)} L`;
    const noteCell = editable
      ? `<input class="cell-input note-input" data-km="${day.iso}" data-field="note" maxlength="300" value="${esc(note)}" placeholder="Opcional" ${future ? "disabled" : ""} />`
      : note ? `<span class="km-note">${esc(note)}</span>` : "<span class='muted'>—</span>";
    return `<tr class="${day.weekend ? "is-weekend" : ""} ${diff !== null ? "has-km" : ""}">
      <td><strong>${day.day}/${month.slice(5, 7)}</strong></td>
      <td>${WEEKDAYS[day.weekday]}</td>
      ${showFuel ? `<td class="num fuel-col" data-label="Abastecimento (L)">${fuelCell("liters", liters, "Abastecimento em litros")}</td><td class="num fuel-col" data-label="Valor (R$)">${fuelCell("value", fuelValue, "Valor do abastecimento")}</td>` : ""}
      <td class="num">${cell("start", start, hint)}</td>
      <td class="num">${cell("end", end, "")}</td>
      <td class="num km-diff" data-km-diff="${day.iso}">${diff === null ? "<span class='muted'>—</span>" : diff < 0 ? `<span class="diff down">${fmtKm(diff)}</span>` : `<b>${fmtKm(diff)}</b> km`}</td>
      <td class="km-note-col">${noteCell}</td>
    </tr>`;
  }).join("");
  const cols = showFuel ? 8 : 6;
  return `<table class="data-table km-table ${showFuel ? "with-fuel" : ""}">
    <thead><tr><th>Data</th><th>Dia</th>${showFuel ? `<th class="num fuel-col">Abastecimento (L)</th><th class="num fuel-col">Valor do abastecimento</th>` : ""}<th class="num">KM inicial</th><th class="num">KM final</th><th class="num">KM total</th><th>Observação</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="${cols}">${emptyState("Nenhum dia lançado")}</td></tr>`}</tbody>
  </table>`;
}

function renderKm() {
  return state.user.role === "nutritionist" ? renderKmNutri() : renderKmAdm();
}

// ---------- NUTRICIONISTA ----------
function renderKmNutri() {
  const ui = mod().ui.km;
  const month = ui.month || currentMonth();
  const vehicle = mod().data.km?.vehicles?.[state.user.id];
  const log = kmLog(month, state.user.id);
  const status = kmStatus(log);
  const locked = Boolean(log?.sentAt);
  const draft = ui.dirty[month] ||= {};
  const merged = () => {
    const all = JSON.parse(JSON.stringify(log?.days || {}));
    for (const [iso, row] of Object.entries(ui.dirty[month] || {})) all[iso] = { ...(all[iso] || {}), ...row };
    return all;
  };
  const totals = kmTotalsOf(merged());
  const dirtyCount = Object.keys(draft).length;

  shell(`
    ${pageHead({ eyebrow: "Rotina", title: "Controle de KM", subtitle: "Lance todos os dias o KM inicial e o KM final do carro. O total do dia é calculado sozinho e a observação é opcional. No fim do mês, envie para o ADM." })}
    <section class="card km-plate ${vehicle ? "" : "is-empty"}">
      <span class="exp-ico">${icon("car")}</span>
      ${vehicle ? `<div><span class="label">Placa do carro</span><strong class="plate">${esc(vehicle.plate)}</strong><small>Cadastrada em ${fmtDateTime(vehicle.setAt)}. Para trocar, fale com o ADM.</small></div>`
        : `<div class="grow"><span class="label">Placa do carro</span><small>Informe a placa uma única vez. Depois ela fica fixa.</small></div>
           <input id="km-plate" placeholder="ABC1D23" maxlength="8" />
           <button class="primary" id="km-plate-save">${icon("save")} Salvar placa</button>`}
    </section>
    <section class="stat-row">
      ${statCard({ label: `KM total · ${formatMonthBR(month)}`, value: `${fmtKm(totals.total)}<small> km</small>`, iconName: "car", tone: "brand" })}
      ${statCard({ label: "Dias lançados", value: fmtNumber(totals.filled), iconName: "calendar" })}
      ${statCard({ label: "Média por dia", value: totals.filled ? `${fmtKm(totals.total / totals.filled)}<small> km</small>` : "—", iconName: "chart" })}
      ${statCard({ label: "Situação", value: `<span class="sm-val">${status.label}</span>`, iconName: status.icon, tone: status.key === "back" ? "danger" : status.key === "sent" ? "warn" : "" })}
    </section>
    <section class="filter-bar">
      <label class="inline-field">Mês <input id="km-month" type="month" value="${month}" /></label>
      <span class="grow"></span>
      ${locked || !vehicle ? "" : `<button class="secondary" id="km-save" ${dirtyCount ? "" : "disabled"}>${icon("save")} Salvar${dirtyCount ? ` (${dirtyCount})` : ""}</button>
        <button class="primary" id="km-send">${icon("send")} Enviar para ADM</button>`}
    </section>
    <section class="card table-card">
      ${log?.review?.status === "conferido" ? `<div class="lock-banner ok">${icon("check")}<span>KM de ${formatMonthBR(month)} <b>conferido</b> por ${esc(log.review.by)} em ${fmtDateTime(log.review.at)}.</span></div>`
        : locked ? `<div class="lock-banner warn">${icon("lock")}<span>Enviado para o ADM em <b>${fmtDateTime(log.sentAt)}</b>. Não é possível alterar.</span></div>`
        : log?.review?.status === "devolvido" ? `<div class="lock-banner danger">${icon("alert")}<span>O ADM devolveu para correção: <b>${esc(log.review.note)}</b>. Corrija e envie de novo.</span></div>` : ""}
      ${!vehicle ? `<div class="lock-banner warn">${icon("car")}<span>Cadastre a placa do carro acima para começar a lançar o KM.</span></div>` : ""}
      <div class="table-scroll">${kmDayTable(month, log?.days, { editable: Boolean(vehicle) && !locked, draft })}</div>
      <div class="km-foot"><span>Total do mês</span><strong data-km-total>${fmtKm(totals.total)} km</strong></div>
    </section>
  `);

  $("#km-month").addEventListener("change", async event => {
    const next = event.target.value;
    event.target.value = month;
    if (Object.keys(ui.dirty[month] || {}).length && !(await askConfirm({ title: "Descartar lançamentos?", text: "Há lançamentos de KM não salvos neste mês.", yesLabel: "Descartar", danger: true, iconName: "alert" }))) return;
    delete ui.dirty[month];
    ui.month = next || currentMonth();
    renderKm();
  });
  $("#km-plate-save")?.addEventListener("click", async () => {
    const plate = $("#km-plate").value.trim();
    if (!plate) return toast("Informe a placa.", "error");
    if (!(await askConfirm({ title: `Confirmar a placa ${plate.toUpperCase()}?`, text: "Ela só pode ser cadastrada uma vez.", yesLabel: "Confirmar placa", iconName: "car" }))) return;
    mutate("km/plate", { plate }, "Placa cadastrada.").catch(() => {});
  });
  if (locked || !vehicle) return;
  document.querySelectorAll("[data-km]").forEach(input => input.addEventListener("input", () => {
    if (input.dataset.field !== "note") input.value = input.value.replace(/[^\d,]/g, "");
    const iso = input.dataset.km;
    (draft[iso] ||= {})[input.dataset.field] = input.value;
    const row = merged()[iso] || {};
    const s = parseKm(row.start);
    const e = parseKm(row.end);
    const cell = document.querySelector(`[data-km-diff="${iso}"]`);
    cell.innerHTML = s !== null && e !== null ? (e - s < 0 ? `<span class="diff down">${fmtKm(e - s)}</span>` : `<b>${fmtKm(e - s)}</b> km`) : "<span class='muted'>—</span>";
    input.closest("tr").classList.toggle("has-km", s !== null && e !== null);
    document.querySelector("[data-km-total]").textContent = `${fmtKm(kmTotalsOf(merged()).total)} km`;
    const save = $("#km-save");
    save.disabled = false;
    save.innerHTML = `${icon("save")} Salvar (${Object.keys(draft).length})`;
  }));
  const payload = () => Object.fromEntries(Object.entries(draft).map(([iso, row]) => [iso, { start: row.start ?? log?.days?.[iso]?.start ?? "", end: row.end ?? log?.days?.[iso]?.end ?? "", note: row.note ?? log?.days?.[iso]?.note ?? "" }]));
  $("#km-save").addEventListener("click", async () => {
    try {
      await mutate("km/save", { month, days: payload() }, "KM salvo.");
      delete ui.dirty[month];
      renderKm();
    } catch { /* */ }
  });
  $("#km-send").addEventListener("click", () => {
    const all = merged();
    const filled = Object.entries(all).filter(([, row]) => parseKm(row.start) !== null || parseKm(row.end) !== null);
    if (!filled.length) return toast("Lance pelo menos um dia antes de enviar.", "error");
    const { total } = kmTotalsOf(all);
    openConfirmModal({
      iconName: "car",
      title: "Enviar KM para o ADM",
      subtitle: `${formatMonthBR(month)} · placa ${vehicle.plate}`,
      bodyHtml: `<div class="km-summary"><div><span>Dias lançados</span><strong>${filled.length}</strong></div><div><span>KM total do mês</span><strong>${fmtKm(total)} km</strong></div></div>${kmDayTable(month, all)}`,
      question: `Deseja enviar o KM de ${formatMonthBR(month)} para o ADM?`,
      hint: "Depois de enviado, os lançamentos deste mês não poderão mais ser alterados.",
      onConfirm: async () => {
        await mutate("km/send", { month, days: payload() }, "KM enviado para o ADM.");
        delete ui.dirty[month];
        renderKm();
      }
    });
  });
}

// ---------- ADM ----------
function renderKmAdm() {
  const ui = mod().ui.km;
  const month = ui.month || currentMonth();
  const people = mod().data.people || [];
  const vehicles = mod().data.km?.vehicles || {};
  const query = normalizeText(ui.search);
  const rows = people.map(person => {
    const log = kmLog(month, person.id);
    const fuel = Object.values(log?.fuel || {});
    return { person, log, status: kmStatus(log), totals: kmTotalsOf(log?.days), plate: vehicles[person.id]?.plate || "",
      fuelValue: fuel.reduce((sum, row) => sum + (Number(row.value) || 0), 0), fuelLiters: fuel.reduce((sum, row) => sum + (Number(row.liters) || 0), 0) };
  }).filter(row => !query || normalizeText(`${row.person.name} ${row.plate}`).includes(query));
  const sent = rows.filter(row => ["sent", "ok"].includes(row.status.key)).length;
  const checked = rows.filter(row => row.status.key === "ok").length;
  const kmSum = rows.filter(row => ["sent", "ok"].includes(row.status.key)).reduce((sum, row) => sum + row.totals.total, 0);
  const fuelSum = rows.reduce((sum, row) => sum + row.fuelValue, 0);
  ui.fuelDraft ||= {};

  shell(`
    ${pageHead({ eyebrow: "Conferência", title: "Controle de KM", subtitle: "KM lançado pelas nutricionistas. Confira os meses enviados ou devolva para correção.",
      actions: `<button class="secondary" id="km-export">${icon("download")} Baixar Excel do mês</button>` })}
    <section class="stat-row">
      ${statCard({ label: `Enviados · ${formatMonthBR(month)}`, value: `${sent}<small>/${people.length}</small>`, iconName: "send", tone: "brand" })}
      ${statCard({ label: "Aguardando conferência", value: fmtNumber(sent - checked), iconName: "clock", tone: sent - checked ? "warn" : "" })}
      ${statCard({ label: "Conferidos", value: fmtNumber(checked), iconName: "check" })}
      ${statCard({ label: "KM total enviado", value: `${fmtKm(kmSum)}<small> km</small>`, iconName: "car" })}
      ${statCard({ label: "Abastecido no mês", value: `<span class="sm-val">${money(fuelSum)}</span>`, hint: "lançado pelo ADM", iconName: "chart" })}
    </section>
    <section class="filter-bar">
      <label class="search-field">${icon("search")}<input id="km-search" placeholder="Buscar nutricionista ou placa..." value="${esc(ui.search)}" /></label>
      <label class="inline-field">Mês <input id="km-month" type="month" value="${month}" /></label>
    </section>
    <section class="card">
      <div class="school-rows">
        ${rows.map(row => {
          const open = ui.open === row.person.id;
          return `<div class="school-row ${open ? "is-open" : ""}">
            <div class="school-row-head as-div km-row">
              <div class="row-toggle" role="button" tabindex="0" data-km-open="${row.person.id}">
                <span class="avatar">${esc(initials(row.person.name))}</span>
                <span class="school-name"><strong>${esc(row.person.name)}</strong><small>${row.plate ? `Placa <b>${esc(row.plate)}</b>` : "Sem placa"} · <button type="button" class="link-btn inline" data-km-plate="${row.person.id}">${row.plate ? "alterar" : "cadastrar"}</button></small></span>
              </div>
              <span class="meta">${row.totals.filled} dia(s) · <b>${fmtKm(row.totals.total)} km</b>${row.fuelValue ? ` · ⛽ <b>${money(row.fuelValue)}</b>` : ""}</span>
              <span class="chip ${row.status.tone}">${icon(row.status.icon)} ${row.status.label}</span>
              ${row.status.key === "sent" ? `<span class="row-btns"><button type="button" class="link-btn" data-km-review="${row.person.id}" data-action="devolvido">Devolver</button><button type="button" class="primary sm" data-km-review="${row.person.id}" data-action="conferido">${icon("check")} Conferido</button></span>`
                : `<span class="meta">${row.log?.review ? `${row.log.review.status === "conferido" ? "Conferido" : "Devolvido"} por ${esc(row.log.review.by)}` : row.log?.savedAt ? `Salvo em ${fmtDateTime(row.log.savedAt)}` : ""}</span>`}
              <button type="button" class="chev-btn" data-km-open="${row.person.id}" aria-label="Abrir">${icon("chevronDown")}</button>
            </div>
            ${open ? `<div class="reg-body">
              <div class="fuel-bar">${row.log?.sentAt ? `<span class="muted">Enviado em ${fmtDateTime(row.log.sentAt)}</span>` : `<span class="muted">Mês ainda não enviado pela nutricionista</span>`}
                <span class="grow"></span><span class="muted">Preencha o <b>abastecimento</b> e o <b>valor</b> nos dias em que houve.</span>
                <button type="button" class="primary sm" data-fuel-save="${row.person.id}" ${Object.keys(ui.fuelDraft[`${month}:${row.person.id}`] || {}).length ? "" : "disabled"}>${icon("save")} Salvar abastecimentos</button></div>
              <div class="table-scroll">${kmDayTable(month, row.log?.days, { fuel: row.log?.fuel || {}, fuelEditable: true, fuelDraft: ui.fuelDraft[`${month}:${row.person.id}`] || {} })}</div>
              <div class="km-foot"><span>Total do mês</span><strong>${fmtKm(row.totals.total)} km · ${fmtNumber(row.fuelLiters, 2)} L · ${money(row.fuelValue)}</strong></div></div>` : ""}
          </div>`;
        }).join("") || `<p class="muted pad">Nenhuma nutricionista encontrada.</p>`}
      </div>
    </section>
  `);

  $("#km-search").addEventListener("input", debounce(event => { ui.search = event.target.value; renderKm(); focusEnd("#km-search"); }, 250));
  $("#km-month").addEventListener("change", event => { ui.month = event.target.value || currentMonth(); ui.open = ""; renderKm(); });
  document.querySelectorAll("[data-fuel]").forEach(input => input.addEventListener("input", () => {
    input.value = input.value.replace(/[^\d,]/g, "");
    const key = `${month}:${ui.open}`;
    ((ui.fuelDraft[key] ||= {})[input.dataset.fuel] ||= {})[input.dataset.field] = input.value;
    const button = document.querySelector(`[data-fuel-save="${ui.open}"]`);
    if (button) button.disabled = false;
  }));
  document.querySelectorAll("[data-fuel-save]").forEach(button => button.addEventListener("click", async () => {
    const nutriId = button.dataset.fuelSave;
    const key = `${month}:${nutriId}`;
    const current = kmLog(month, nutriId)?.fuel || {};
    const days = Object.fromEntries(Object.entries(ui.fuelDraft[key] || {}).map(([iso, row]) => [iso, {
      liters: row.liters ?? fuelText(current[iso]?.liters), value: row.value ?? fuelText(current[iso]?.value)
    }]));
    try {
      await mutate("km/fuel", { month, nutritionistId: nutriId, days }, "Abastecimentos salvos.");
      delete ui.fuelDraft[key];
      renderKm();
    } catch { /* */ }
  }));
  document.querySelectorAll("[data-km-open]").forEach(button => button.addEventListener("click", event => {
    if (event.target.closest("[data-km-plate]")) return;
    ui.open = ui.open === button.dataset.kmOpen ? "" : button.dataset.kmOpen;
    renderKm();
  }));
  document.querySelectorAll("[data-km-plate]").forEach(button => button.addEventListener("click", event => {
    event.stopPropagation();
    const plate = prompt("Nova placa do carro (ex.: ABC1D23):", vehicles[button.dataset.kmPlate]?.plate || "");
    if (plate) mutate("km/plate", { plate, nutritionistId: button.dataset.kmPlate }, "Placa atualizada.").catch(() => {});
  }));
  document.querySelectorAll("[data-km-review]").forEach(button => button.addEventListener("click", () => {
    const action = button.dataset.action;
    let note = "";
    if (action === "devolvido") {
      note = prompt("Motivo da devolução (a nutricionista verá esta mensagem):") || "";
      if (!note.trim()) return;
    }
    mutate("km/review", { month, nutritionistId: button.dataset.kmReview, action, note }, action === "conferido" ? "KM conferido." : "KM devolvido para a nutricionista.").catch(() => {});
  }));
  $("#km-export").addEventListener("click", async () => {
    try { downloadBase64File(await mapi("km/export", { month })); } catch (error) { toast(error.message, "error"); }
  });
}

// ================================================================ CAPACITAÇÃO
function trainingFor(month) {
  return (mod().data.trainings || []).find(item => item.month === month) || null;
}

function trainingStatus(sub, training) {
  if (sub?.review?.status === "conferido") return { key: "ok", label: "Conferido", tone: "ok", icon: "check" };
  if (sub?.review?.status === "devolvido") return { key: "back", label: "Devolvido", tone: "danger", icon: "alert" };
  if (sub) return { key: "sent", label: "Aguardando conferência", tone: "warn", icon: "send" };
  if (training && daysBetween(serverToday(), training.deadline) < 0) return { key: "late", label: "Não enviado (prazo encerrado)", tone: "danger", icon: "lock" };
  return { key: "none", label: "Não enviado", tone: "neutral", icon: "clock" };
}

function trainingMonthOptions(selected) {
  const months = new Set((mod().data.trainings || []).map(item => item.month));
  months.add(selected);
  return [...months].sort().reverse().map(month => `<option value="${month}" ${month === selected ? "selected" : ""}>${esc(formatMonthBR(month))}${trainingFor(month) ? ` — ${esc(trainingFor(month).theme)}` : " — sem capacitação"}</option>`).join("");
}

function renderCapacitacao() {
  return state.user.role === "nutritionist" ? renderCapacitacaoNutri() : renderCapacitacaoAdm();
}

function trainingHead(training) {
  if (!training) return "";
  const days = daysBetween(serverToday(), training.deadline);
  return `<section class="card training-head">
    <span class="exp-ico">${icon("graduation")}</span>
    <div><span class="label">Tema da capacitação · ${esc(formatMonthBR(training.month))}</span><h2>${esc(training.theme)}</h2></div>
    <span class="chip ${days < 0 ? "danger" : days <= 3 ? "warn" : "neutral"}">${icon(days < 0 ? "lock" : "clock")} ${days < 0 ? `Prazo encerrado em ${fmtDate(training.deadline)}` : `Enviar até ${fmtDate(training.deadline)}${days === 0 ? " (hoje)" : ` (${days} dia${days === 1 ? "" : "s"})`}`}</span>
    ${training.files?.length ? `<div class="training-files"><span class="label">${icon("paperclip")} Material da coordenação</span><div class="history-files">${training.files.map(file => fileChip(file)).join("")}</div></div>` : ""}
  </section>`;
}

// ---------- NUTRICIONISTA ----------
function renderCapacitacaoNutri() {
  const ui = mod().ui.cap;
  const trainings = mod().data.trainings || [];
  if (!trainingFor(ui.month) && trainings.length && !ui.touched) ui.month = trainings[0].month;
  const month = ui.month;
  const training = trainingFor(month);
  const sub = mod().data.trainingSubmissions?.[month]?.[state.user.id] || null;
  const status = trainingStatus(sub, training);
  const canSend = training && (!sub || sub.review?.status === "devolvido") && (sub?.review?.status === "devolvido" || daysBetween(serverToday(), training.deadline) >= 0);

  shell(`
    ${pageHead({ eyebrow: "Rotina", title: "Capacitação", subtitle: "Envie uma vez por mês os documentos da capacitação definida pela coordenação." })}
    <section class="filter-bar">
      <label class="inline-field grow">Mês <select id="cap-month">${trainingMonthOptions(month)}</select></label>
      <span class="chip ${status.tone}">${icon(status.icon)} ${status.label}</span>
    </section>
    ${training ? trainingHead(training) : `<div class="panel">${emptyState("Nenhuma capacitação neste mês", "Quando a coordenação definir o tema e o prazo, ela aparece aqui.", "graduation")}</div>`}
    ${training && sub ? `<section class="card form-card">
      <div class="form-title">${icon("fileCheck")}<strong>Seu envio</strong><small class="muted">em ${fmtDateTime(sub.sentAt)}</small></div>
      ${sub.review?.status === "conferido" ? `<div class="lock-banner ok">${icon("check")}<span>Conferido por <b>${esc(sub.review.by)}</b> em ${fmtDateTime(sub.review.at)}.</span></div>` : ""}
      ${sub.review?.status === "devolvido" ? `<div class="lock-banner danger">${icon("alert")}<span>Devolvido pelo ADM: <b>${esc(sub.review.note)}</b>. Envie os documentos corrigidos abaixo.</span></div>` : ""}
      ${!sub.review ? `<div class="lock-banner warn">${icon("lock")}<span>Enviado. Aguardando a conferência do ADM — não é possível alterar.</span></div>` : ""}
      <div class="history-files">${sub.files.map(file => fileChip(file)).join("")}</div>
      ${sub.notes ? `<p class="muted">${esc(sub.notes)}</p>` : ""}
    </section>` : ""}
    ${training && !sub && !canSend ? `<div class="lock-banner danger">${icon("lock")}<span>O prazo para envio desta capacitação encerrou em <b>${fmtDate(training.deadline)}</b>. Fale com a coordenação.</span></div>` : ""}
    ${canSend ? `<section class="card form-card">
      <div class="form-title">${icon("upload")}<strong>${sub ? "Reenviar documentos" : "Enviar documentos da capacitação"}</strong></div>
      <div class="field wide"><span>Documentos (certificado, lista de presença, fotos...)</span>
        <div class="history-files">${ui.files.map((file, index) => fileChip(file, `data-cap-remove="${index}"`)).join("")}</div>
        <label class="dropzone">${icon("upload")}<span><b>Anexar arquivos</b><small>PDF, Word ou imagem · vários arquivos de uma vez · até 25 MB cada</small></span>
          <input type="file" id="cap-files" multiple accept=".pdf,.doc,.docx,.odt,.xls,.xlsx,image/*" hidden /></label>
      </div>
      <label class="field wide"><span>Observações (opcional)</span><textarea id="cap-notes" rows="2">${esc(ui.notes)}</textarea></label>
      <div class="form-actions">
        ${ui.uploading ? `<span class="uploading"><i class="spinner"></i> Enviando ${ui.uploading} arquivo(s)...</span>` : ""}
        <button class="primary" id="cap-send" ${ui.files.length && !ui.uploading ? "" : "disabled"}>${icon("send")} Enviar capacitação</button>
      </div>
    </section>` : ""}
  `);

  $("#cap-month").addEventListener("change", event => { ui.month = event.target.value; ui.touched = true; ui.files = []; ui.notes = ""; renderCapacitacao(); });
  if (!canSend) return;
  $("#cap-notes").addEventListener("input", event => { ui.notes = event.target.value; });
  $("#cap-files").addEventListener("change", async event => {
    const files = [...event.target.files];
    if (!files.length) return;
    ui.uploading = files.length;
    renderCapacitacao();
    try { ui.files.push(...await uploadFiles(files)); } catch (error) { toast(error.message, "error"); }
    ui.uploading = 0;
    renderCapacitacao();
  });
  document.querySelectorAll("[data-cap-remove]").forEach(button => button.addEventListener("click", () => { ui.files.splice(Number(button.dataset.capRemove), 1); renderCapacitacao(); }));
  $("#cap-send").addEventListener("click", () => openConfirmModal({
    iconName: "graduation",
    title: "Enviar capacitação",
    subtitle: `${training.theme} · ${formatMonthBR(month)}`,
    bodyHtml: `<div class="history-files">${ui.files.map(file => fileChip(file)).join("")}</div>${ui.notes ? `<p class="muted">${esc(ui.notes)}</p>` : ""}`,
    question: "Deseja enviar a capacitação?",
    hint: "A capacitação do mês é enviada uma única vez. Depois do envio, só o ADM pode devolver para correção.",
    onConfirm: async () => {
      await mutate("training/submit", { month, files: ui.files, notes: ui.notes }, "Capacitação enviada.");
      ui.files = [];
      ui.notes = "";
      renderCapacitacao();
    }
  }));
}

// ---------- ADM ----------
function renderCapacitacaoAdm() {
  const ui = mod().ui.cap;
  const trainings = mod().data.trainings || [];
  if (!trainingFor(ui.month) && trainings.length && !ui.touched) ui.month = trainings[0].month;
  const month = ui.month;
  const training = trainingFor(month);
  const people = mod().data.people || [];
  const subs = mod().data.trainingSubmissions?.[month] || {};
  const rows = people.map(person => ({ person, sub: subs[person.id] || null, status: trainingStatus(subs[person.id], training) }));
  const count = key => rows.filter(row => row.status.key === key).length;
  const visible = rows.filter(row => ui.status === "todos" || (ui.status === "none" ? ["none", "late"].includes(row.status.key) : row.status.key === ui.status));

  shell(`
    ${pageHead({ eyebrow: "Conferência", title: "Capacitação", subtitle: "Documentos enviados pelas nutricionistas. Confira cada envio ou devolva para correção." })}
    <section class="filter-bar">
      <label class="inline-field grow">Mês <select id="cap-month">${trainingMonthOptions(month)}</select></label>
      <div class="segmented">${[["todos", "Todas"], ["sent", "Aguardando"], ["ok", "Conferidas"], ["back", "Devolvidas"], ["none", "Não enviadas"]].map(([key, label]) => `<button type="button" class="${ui.status === key ? "active" : ""}" data-cap-status="${key}">${label}</button>`).join("")}</div>
    </section>
    ${training ? trainingHead(training) : `<div class="panel">${emptyState("Nenhuma capacitação neste mês", "O tema e o prazo são definidos pela coordenação em Configurações.", "graduation")}</div>`}
    ${training ? `<section class="stat-row">
      ${statCard({ label: "Enviadas", value: `${rows.length - count("none") - count("late")}<small>/${rows.length}</small>`, iconName: "send", tone: "brand" })}
      ${statCard({ label: "Aguardando conferência", value: fmtNumber(count("sent")), iconName: "clock", tone: count("sent") ? "warn" : "" })}
      ${statCard({ label: "Conferidas", value: fmtNumber(count("ok")), iconName: "check" })}
      ${statCard({ label: "Devolvidas", value: fmtNumber(count("back")), iconName: "alert", tone: count("back") ? "danger" : "" })}
    </section>
    <section class="card">
      <div class="school-rows">
        ${visible.map(({ person, sub, status }) => `<div class="school-row cap-row">
          <div class="school-row-head as-div">
            <span class="row-toggle"><span class="avatar">${esc(initials(person.name))}</span><span class="school-name"><strong>${esc(person.name)}</strong><small>${sub ? `Enviado em ${fmtDateTime(sub.sentAt)}` : "Ainda não enviou"}</small></span></span>
            <span class="chip ${status.tone}">${icon(status.icon)} ${status.label}</span>
            <span class="meta">${sub?.review ? `${esc(sub.review.by)} · ${fmtDateTime(sub.review.at)}` : ""}</span>
            ${status.key === "sent" ? `<span class="row-btns"><button type="button" class="link-btn" data-cap-review="${person.id}" data-action="devolvido">Devolver</button><button type="button" class="primary sm" data-cap-review="${person.id}" data-action="conferido">${icon("check")} Conferido</button></span>` : "<span></span>"}
            <span></span>
          </div>
          ${sub ? `<div class="reg-body"><div class="history-files">${sub.files.map(file => fileChip(file)).join("")}</div>
            ${sub.notes ? `<p class="muted">${esc(sub.notes)}</p>` : ""}
            ${sub.review?.status === "devolvido" ? `<p class="warn-text">${icon("alert")} Motivo da devolução: ${esc(sub.review.note)}</p>` : ""}
            ${sub.history?.length ? `<p class="muted"><small>${sub.history.length} envio(s) anterior(es) devolvido(s).</small></p>` : ""}</div>` : ""}
        </div>`).join("") || `<p class="muted pad">Nenhuma nutricionista com este filtro.</p>`}
      </div>
    </section>` : ""}
  `);

  $("#cap-month").addEventListener("change", event => { ui.month = event.target.value; ui.touched = true; renderCapacitacao(); });
  document.querySelectorAll("[data-cap-status]").forEach(button => button.addEventListener("click", () => { ui.status = button.dataset.capStatus; renderCapacitacao(); }));
  document.querySelectorAll("[data-cap-review]").forEach(button => button.addEventListener("click", () => {
    const action = button.dataset.action;
    let note = "";
    if (action === "devolvido") {
      note = prompt("Motivo da devolução (a nutricionista verá esta mensagem):") || "";
      if (!note.trim()) return;
    }
    mutate("training/review", { month, nutritionistId: button.dataset.capReview, action, note }, action === "conferido" ? "Capacitação conferida." : "Capacitação devolvida para a nutricionista.").catch(() => {});
  }));
}

// ---------- COORDENAÇÃO: tema e prazo (aparece em Configurações) ----------
function cardPricesPanel() {
  return `<section class="panel card-prices">
    <div class="section-head"><h2>Valores dos cards</h2></div>
    <p class="status-line">Valor contratual por refeição de cada card (lote 2, o mesmo da linha 172 da planilha da SMED). É usado no faturamento, no Analytics e para os eventos (alunos no card 10; adultos no CARD 11 ou card 10).</p>
    <div class="price-grid">${state.db.cards.map(card => `<label class="price-card"><span><b>${esc(card.label)}</b><small>${esc(card.description)}</small></span>
      <span class="price-wrap"><em>R$</em><input class="cell-input" inputmode="decimal" data-card-price="${card.id}" value="${Number(card.price || 0).toFixed(2).replace(".", ",")}" /></span></label>`).join("")}</div>
  </section>`;
}

function bindCardPricesPanel() {
  document.querySelectorAll("[data-card-price]").forEach(input => {
    input.addEventListener("input", () => { input.value = input.value.replace(/[^\d,]/g, ""); });
    input.addEventListener("change", () => {
      const value = Number(input.value.replace(",", "."));
      if (!Number.isFinite(value) || value < 0) return toast("Valor inválido.", "error");
      const card = state.db.cards.find(item => item.id === input.dataset.cardPrice);
      card.price = Math.round(value * 100) / 100;
      saveDb(`Valor do ${card.label} atualizado para ${money(card.price)}.`);
    });
  });
}

function trainingConfigPanel() {
  if (state.user?.role !== "admin" || !mod().available) return "";
  const ui = mod().ui.capCfg ||= { month: currentMonth(), editing: "" };
  const trainings = mod().data.trainings || [];
  const editing = trainingFor(ui.editing) || null;
  if (!ui.files || ui.filesFor !== (ui.editing || "")) { ui.files = [...(editing?.files || [])]; ui.filesFor = ui.editing || ""; }
  const draft = ui.draft || {};
  const total = (mod().data.people || []).length;
  return cardPricesPanel() + `<section class="panel training-cfg">
    <div class="section-head"><h2>Capacitação</h2></div>
    <p class="status-line">Defina o tema da capacitação do mês e o prazo para as nutricionistas enviarem os documentos. Cada nutricionista envia uma vez por mês; o ADM faz a conferência.</p>
    <form id="cap-cfg-form" class="training-form">
      <label class="field"><span>Mês</span><input type="month" name="month" value="${esc(editing?.month || draft.month || ui.month)}" ${editing ? "readonly" : ""} required /></label>
      <label class="field grow"><span>Tema da capacitação</span><input name="theme" value="${esc(draft.theme ?? editing?.theme ?? "")}" placeholder="Ex.: Boas práticas na manipulação de alimentos" required /></label>
      <label class="field"><span>Prazo para envio</span><input type="date" name="deadline" value="${esc(draft.deadline ?? editing?.deadline ?? "")}" required /></label>
      <div class="field training-attach"><span>Anexos para as nutricionistas (opcional)</span>
        <div class="history-files">${ui.files.map((file, index) => fileChip(file, `data-capcfg-remove="${index}"`)).join("")}</div>
        ${ui.uploading ? `<span class="uploading"><i class="spinner"></i> Enviando ${ui.uploading} arquivo(s)...</span>` : `<label class="dropzone inline">${icon("upload")}<span><b>Anexar arquivos</b><small>material, apresentação, modelo de lista de presença... até 25 MB cada</small></span><input type="file" id="capcfg-files" multiple hidden /></label>`}
      </div>
      <div class="training-form-actions">${editing ? `<button type="button" class="secondary" id="cap-cfg-cancel">Cancelar</button>` : ""}<button type="submit" class="primary">${editing ? "Salvar alterações" : "Definir capacitação"}</button></div>
    </form>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Mês</th><th>Tema</th><th>Prazo</th><th>Anexos</th><th>Envios</th><th>Ações</th></tr></thead>
        <tbody>${trainings.map(item => {
          const sent = Object.keys(mod().data.trainingSubmissions?.[item.month] || {}).length;
          return `<tr><td>${esc(formatMonthBR(item.month))}</td><td>${esc(item.theme)}</td><td>${fmtDate(item.deadline)}</td><td>${item.files?.length ? `${icon("paperclip")} ${item.files.length}` : "—"}</td><td>${sent}/${total}</td>
            <td><button type="button" class="secondary" data-cap-edit="${item.month}">Editar</button> ${sent ? "" : `<button type="button" class="danger" data-cap-delete="${item.month}">Excluir</button>`}</td></tr>`;
        }).join("") || `<tr><td colspan="6">Nenhuma capacitação definida.</td></tr>`}</tbody>
      </table>
    </div>
  </section>`;
}

function bindTrainingConfigPanel() {
  bindCardPricesPanel();
  const form = document.querySelector("#cap-cfg-form");
  if (!form) return;
  const ui = mod().ui.capCfg;
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    delete data[""];
    try {
      await mutate("training/save", { ...data, files: ui.files }, "Capacitação salva.");
      ui.editing = "";
      ui.draft = null;
      ui.files = null;
      render();
    } catch { /* */ }
  });
  const keepDraft = () => { ui.draft = Object.fromEntries(new FormData(form).entries()); };
  $("#capcfg-files")?.addEventListener("change", async event => {
    const files = [...event.target.files];
    if (!files.length) return;
    keepDraft();
    ui.uploading = files.length;
    render();
    try { ui.files.push(...await uploadFiles(files)); } catch (error) { toast(error.message, "error"); }
    ui.uploading = 0;
    render();
  });
  document.querySelectorAll("[data-capcfg-remove]").forEach(button => button.addEventListener("click", () => { keepDraft(); ui.files.splice(Number(button.dataset.capcfgRemove), 1); render(); }));
  $("#cap-cfg-cancel")?.addEventListener("click", () => { ui.editing = ""; ui.draft = null; ui.files = null; render(); });
  document.querySelectorAll("[data-cap-edit]").forEach(button => button.addEventListener("click", () => { ui.editing = button.dataset.capEdit; ui.draft = null; ui.files = null; render(); }));
  document.querySelectorAll("[data-cap-delete]").forEach(button => button.addEventListener("click", () => {
    askConfirm({ title: "Excluir capacitação?", text: "A capacitação deste mês será removida.", yesLabel: "Excluir", danger: true }).then(ok => ok && mutate("training/delete", { month: button.dataset.capDelete }, "Capacitação excluída.").catch(() => {}));
  }));
}

// ================================================================ PENDÊNCIAS
function computePendencias() {
  const result = { total: 0, groups: [] };
  if (!state.user || !state.db || !mod().available) return result;
  const isAdmin = state.user.role === "admin";
  const month = currentMonth();
  const data = mod().data;
  const schools = schoolMap();
  const push = (group, item) => {
    let target = result.groups.find(entry => entry.id === group.id);
    if (!target) { target = { ...group, items: [] }; result.groups.push(target); }
    target.items.push(item);
    result.total += 1;
  };
  const groups = {
    sup: { id: "sup", title: "Relatório de Supervisão", icon: "fileCheck", view: "supervisao" },
    ntf: { id: "ntf", title: "Notificações", icon: "bell", view: "notificacoes" },
    evt: { id: "evt", title: "Eventos", icon: "party", view: "eventos" },
    mat: { id: "mat", title: "Matriculados", icon: "users", view: "matriculados" },
    inv: { id: "inv", title: "Inventário de Insumos", icon: "package", view: isAdmin ? "registro-inventario" : "inventario" },
    ped: { id: "ped", title: isAdmin ? "Pedidos" : "Ajuste de Pedido", icon: "cart", view: isAdmin ? "pedidos" : "ajuste-pedido" }
  };
  for (const order of data.orders || []) {
    if (isAdmin) {
      for (const [nutriId, adjustment] of Object.entries(order.adjustments || {})) {
        if (adjustment?.sentAt && !adjustment.finalizedAt) push(groups.ped, { title: order.title, text: `${userMap().get(nutriId)?.name || "Nutricionista"} enviou o ajuste — falta finalizar.`, tone: "warn", meta: fmtDate(adjustment.sentAt.slice(0, 10)) });
      }
    } else if (!order.adjustments?.[state.user.id]?.sentAt) {
      push(groups.ped, { title: order.title, text: `Confira as quantidades de ${formatMonthBR(order.month)} e envie o ajuste (${order.lines.length} itens).`, tone: "warn", meta: order.deliveryDate ? `Entrega ${fmtDate(order.deliveryDate)}` : "" });
    }
  }

  const reviewPendencias = () => {
    groups.km = { id: "km", title: "Controle de KM", icon: "car", view: "km" };
    groups.cap = { id: "cap", title: "Capacitação", icon: "graduation", view: "capacitacao" };
    const people = new Map((data.people || []).map(person => [person.id, person.name]));
    for (const [month, byNutri] of Object.entries(data.km?.logs || {})) {
      for (const [nutriId, log] of Object.entries(byNutri)) {
        if (log.sentAt && log.review?.status !== "conferido") push(groups.km, { title: people.get(nutriId) || "Nutricionista", text: `KM de ${formatMonthBR(month)} enviado — falta conferir.`, tone: "warn", meta: fmtDate(log.sentAt.slice(0, 10)) });
      }
    }
    for (const [month, byNutri] of Object.entries(data.trainingSubmissions || {})) {
      for (const [nutriId, sub] of Object.entries(byNutri)) {
        if (!sub.review) push(groups.cap, { title: people.get(nutriId) || "Nutricionista", text: `Capacitação de ${formatMonthBR(month)} enviada — falta conferir.`, tone: "warn", meta: fmtDate(sub.sentAt.slice(0, 10)) });
      }
    }
  };
  if (state.user.role === "adm") {
    reviewPendencias();
    return result;
  }
  if (!isAdmin) {
    groups.km = { id: "km", title: "Controle de KM", icon: "car", view: "km" };
    groups.cap = { id: "cap", title: "Capacitação", icon: "graduation", view: "capacitacao" };
    const prev = previousMonth(month);
    for (const m of [prev, month]) {
      const log = data.km?.logs?.[m]?.[state.user.id];
      if (log?.review?.status === "devolvido" && !log.sentAt) push(groups.km, { title: `KM de ${formatMonthBR(m)} devolvido`, text: log.review.note || "O ADM devolveu para correção.", tone: "danger", meta: "" });
      else if (m === prev && log && !log.sentAt && Object.keys(log.days || {}).length) push(groups.km, { title: `KM de ${formatMonthBR(m)}`, text: "O mês terminou — clique em Enviar para ADM.", tone: "warn", meta: "" });
    }
    if (!data.km?.vehicles?.[state.user.id]) push(groups.km, { title: "Placa do carro", text: "Cadastre a placa para começar a lançar o KM.", tone: "warn", meta: "" });
    for (const training of data.trainings || []) {
      const sub = data.trainingSubmissions?.[training.month]?.[state.user.id];
      if (sub?.review?.status === "devolvido" && sub.sentAt < sub.review.at) push(groups.cap, { title: training.theme, text: `Devolvida: ${sub.review.note}`, tone: "danger", meta: formatMonthBR(training.month) });
      else if (!sub && daysBetween(serverToday(), training.deadline) >= 0) push(groups.cap, { title: training.theme, text: `Envie os documentos da capacitação de ${formatMonthBR(training.month)}.`, tone: daysBetween(serverToday(), training.deadline) <= 3 ? "danger" : "warn", meta: `Prazo ${fmtDate(training.deadline)}` });
    }
    for (const school of schoolsOfNutri(state.user.id)) {
      if (!reportsFor(school.id, state.user.id, month).length) {
        push(groups.sup, { title: school.shortName, text: `Sem relatório de supervisão em ${formatMonthBR(month)}.`, tone: "warn", meta: routeLabel(school.route) });
      }
    }
    for (const evt of data.events) {
      if (evt.attendance || evt.approval === "reprovado") continue;
      const where = schools.get(evt.schoolId)?.shortName || "";
      const past = evt.eventDate && daysBetween(todayISO(), evt.eventDate) <= 0;
      let text = "";
      if ((evt.approval || "pendente") === "pendente") text = "defina se o evento foi aprovado.";
      else if (evt.approval === "aprovado" && !evt.attendance && past) text = "confirme se o evento foi realizado.";
      if (!text) continue;
      push(groups.evt, { title: evt.event, text: `${where} — ${text}`, tone: evt.eventDate && daysBetween(todayISO(), evt.eventDate) < 0 ? "danger" : "warn", meta: fmtDate(evt.eventDate) });
    }
    if (data.inventoryItems.length) {
      for (const school of schoolsOfNutri(state.user.id)) {
        if (data.inventorySubmissions?.[month]?.[school.id]) continue;
        const deadline = invDeadlineOf(month, school);
        if (deadline.closed) continue;
        const draft = Object.keys(data.inventoryCounts[month]?.[school.id] || {}).length;
        push(groups.inv, { title: school.shortName, text: (draft ? `Inventário de ${formatMonthBR(month)} em rascunho — falta enviar.` : `Inventário de ${formatMonthBR(month)} não informado.`) + (deadline.date ? ` Prazo até ${fmtDate(deadline.date)}.` : ""), tone: deadline.date && deadline.daysLeft <= 2 ? "danger" : "warn", meta: routeLabel(school.route) });
      }
    }
    for (const item of data.notifications) {
      if (item.finalFile || item.responses?.[state.user.id]) continue;
      const late = item.dueDate && daysBetween(todayISO(), item.dueDate) < 0;
      push(groups.ntf, { title: item.title, text: `${item.questions.length} pergunta(s) para responder.`, tone: late ? "danger" : "warn", meta: item.dueDate ? `Prazo ${fmtDate(item.dueDate)}` : "" });
    }
    return result;
  }

  for (const item of data.notifications) {
    const stage = notificationStage(item);
    if (stage.step === 2) push(groups.ntf, { title: item.title, text: "Todas responderam — falta anexar o arquivo final.", tone: "warn", meta: `${stage.answered}/${stage.total}` });
    else if (!item.finalFile && item.dueDate && daysBetween(todayISO(), item.dueDate) < 0) push(groups.ntf, { title: item.title, text: `Prazo vencido com ${stage.total - stage.answered} resposta(s) faltando.`, tone: "danger", meta: `Prazo ${fmtDate(item.dueDate)}` });
  }

  reviewPendencias();
  const noEnroll = state.db.schools.filter(school => !enrollmentTotal(data.enrollments[school.id]));
  if (noEnroll.length) push(groups.mat, { title: `${noEnroll.length} escola(s) sem matriculados`, text: noEnroll.slice(0, 4).map(school => school.shortName).join(", ") + (noEnroll.length > 4 ? "…" : ""), tone: "warn", meta: `${state.db.schools.length - noEnroll.length}/${state.db.schools.length} preenchidas` });
  const withInventory = Object.keys(data.inventorySubmissions?.[month] || {}).length;
  if (!data.inventoryItems.some(item => item.active !== false)) push(groups.inv, { title: "Nenhum insumo ativo", text: "Ative os insumos que as nutricionistas devem informar.", tone: "warn" });
  else if (withInventory < state.db.schools.length) push(groups.inv, { title: `${state.db.schools.length - withInventory} escola(s) sem inventário enviado em ${formatMonthBR(month)}`, text: "Acompanhe em Registro de Inventário.", tone: "neutral", meta: `${withInventory}/${state.db.schools.length}` });
  for (const nutri of nutriList()) {
    const schoolsOf = schoolsOfNutri(nutri.id);
    const missing = schoolsOf.filter(school => !reportsFor(school.id, nutri.id, month).length).length;
    if (missing) push(groups.sup, { title: nutri.name, text: `${missing} de ${schoolsOf.length} escola(s) sem relatório em ${formatMonthBR(month)}.`, tone: "neutral", meta: `${schoolsOf.length - missing}/${schoolsOf.length}` });
  }
  return result;
}

function renderPendencias() {
  const pend = computePendencias();
  const isAdmin = state.user.role === "admin";
  shell(`
    ${pageHead({
      eyebrow: "Comunicação",
      title: "Pendências",
      subtitle: "Lembretes do que ainda falta preencher (as apurações ficam nas telas próprias)."
    })}
    <section class="pend-hero card">
      <div class="pend-count"><strong>${pend.total}</strong><span>${pend.total === 1 ? "pendência" : "pendências"}</span></div>
      <div class="pend-chips">${pend.groups.map(group => `<button type="button" class="pend-chip" data-view="${group.view}">${icon(group.icon)}<span>${group.title}</span><b>${group.items.length}</b></button>`).join("") || `<span class="muted">Tudo em dia por aqui.</span>`}</div>
    </section>
    <section class="pend-grid">
      ${pend.groups.map(group => `<article class="card pend-group">
        <header><span class="pend-ico">${icon(group.icon)}</span><h3>${group.title}</h3><span class="nav-badge">${group.items.length}</span>
          <button type="button" class="link-btn" data-view="${group.view}">Abrir ${icon("arrowRight")}</button></header>
        <ul>${group.items.map(item => `<li class="pend-item tone-${item.tone}"><span class="pend-dot"></span><div><strong>${esc(item.title)}</strong><p>${esc(item.text)}</p></div>${item.meta ? `<small>${esc(item.meta)}</small>` : ""}</li>`).join("")}</ul>
      </article>`).join("") || `<div class="card">${emptyState("Nenhuma pendência!", isAdmin ? "Supervisões, matriculados, eventos, notificações e inventário estão em dia." : "Suas supervisões e notificações estão em dia.", "check")}</div>`}
    </section>
  `);
}

// ================================================================ ANALYTICS
const entryValueCache = new WeakMap();

function entryValue(entry, prices) {
  let value = entryValueCache.get(entry);
  if (value) return value;
  value = { revenue: 0, meals: 0, byCard: {} };
  if (entry.status !== "not_served") {
    for (const [cardId, raw] of Object.entries(entry.quantities || {})) {
      const qty = Number(String(raw ?? 0).replace(",", ".")) || 0;
      const revenue = qty * (prices.get(cardId) || 0);
      value.revenue += revenue;
      value.meals += qty;
      value.byCard[cardId] = { qty, revenue };
    }
  }
  entryValueCache.set(entry, value);
  return value;
}

function defaultAnalyticsUi() {
  const dates = (state.db.entries || []).map(entry => entry.date).filter(Boolean).sort();
  const last = dates[dates.length - 1] || todayISO();
  const lastDate = new Date(`${last.slice(0, 7)}-01T00:00:00`);
  const from = new Date(lastDate.getFullYear(), lastDate.getMonth() - 2, 1);
  const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return { dim: "nutri", selected: [], from: iso(from), to: last, gran: "auto", metric: "revenue", cards: [], table: false, preset: "3m" };
}

function dimensionKey(dim, entry, schools) {
  if (dim === "nutri") return entry.nutritionistId;
  if (dim === "route") return schools.get(entry.schoolId)?.route || "SEM ROTA";
  return entry.schoolId;
}

function dimensionLabel(dim, key, schools, users) {
  if (dim === "nutri") return users.get(key)?.name || key;
  if (dim === "route") return routeLabel(key);
  return schools.get(key)?.shortName || key;
}

function bucketOf(date, gran) {
  if (gran === "month") return date.slice(0, 7);
  if (gran === "week") {
    const d = new Date(`${date}T00:00:00`);
    const day = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - day);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return date;
}

function bucketLabel(bucket, gran) {
  if (gran === "month") {
    const [y, m] = bucket.split("-");
    return `${["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"][Number(m) - 1]}/${y.slice(2)}`;
  }
  const [, m, d] = bucket.split("-");
  return `${d}/${m}`;
}

function bucketRange(bucket, gran) {
  const fmt = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  if (gran === "week") {
    const end = new Date(`${bucket}T00:00:00`);
    end.setDate(end.getDate() + 4);
    const iso = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;
    return `Semana de ${fmt(bucket)} a ${fmt(iso)} (soma dos dias letivos)`;
  }
  if (gran === "month") return `${formatMonthBR(bucket)} (soma do mês)`;
  const weekday = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"][new Date(`${bucket}T00:00:00`).getDay()];
  return `${weekday}, ${fmt(bucket)}/${bucket.slice(0, 4)} (dia)`;
}

function enumerateBuckets(from, to, gran) {
  const buckets = [];
  const cursor = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  const seen = new Set();
  while (cursor <= end) {
    const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
    const weekday = cursor.getDay();
    if (weekday !== 0 && weekday !== 6) {
      const bucket = bucketOf(iso, gran);
      if (!seen.has(bucket)) { seen.add(bucket); buckets.push(bucket); }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return buckets;
}

function computeAnalytics(ui) {
  const schools = schoolMap();
  const users = userMap();
  const prices = new Map(state.db.cards.map(card => [card.id, Number(card.price) || 0]));
  const span = daysBetween(ui.from, ui.to) + 1;
  const gran = ui.gran === "auto" ? (span > 120 ? "month" : span > 35 ? "week" : "day") : ui.gran;
  const prevTo = new Date(`${ui.from}T00:00:00`); prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo); prevFrom.setDate(prevFrom.getDate() - span + 1);
  const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const prev = { from: iso(prevFrom), to: iso(prevTo) };

  const cardSet = ui.cards?.length ? new Set(ui.cards) : null;
  const measure = value => {
    if (!cardSet) return ui.metric === "revenue" ? value.revenue : value.meals;
    let sum = 0;
    for (const cardId of cardSet) {
      const card = value.byCard[cardId];
      if (card) sum += ui.metric === "revenue" ? card.revenue : card.qty;
    }
    return sum;
  };

  const totals = new Map();
  const prevTotals = new Map();
  const seriesMap = new Map();
  const cardTotals = new Map();
  const notServed = new Map();
  const days = new Map();
  let grand = 0;
  let prevGrand = 0;

  for (const entry of state.db.entries || []) {
    const date = entry.date;
    if (!date) continue;
    const inCurrent = date >= ui.from && date <= ui.to;
    const inPrev = date >= prev.from && date <= prev.to;
    if (!inCurrent && !inPrev) continue;
    const key = dimensionKey(ui.dim, entry, schools);
    if (entry.status === "not_served") {
      if (inCurrent) notServed.set(key, (notServed.get(key) || 0) + 1);
      continue;
    }
    const value = entryValue(entry, prices);
    const amount = measure(value);
    if (inPrev) { prevTotals.set(key, (prevTotals.get(key) || 0) + amount); prevGrand += amount; continue; }
    totals.set(key, (totals.get(key) || 0) + amount);
    grand += amount;
    if (!days.has(key)) days.set(key, new Set());
    days.get(key).add(date);
    const bucket = bucketOf(date, gran);
    if (!seriesMap.has(key)) seriesMap.set(key, new Map());
    seriesMap.get(key).set(bucket, (seriesMap.get(key).get(bucket) || 0) + amount);
    if (!cardTotals.has(key)) cardTotals.set(key, new Map());
    for (const [cardId, item] of Object.entries(value.byCard)) {
      if (cardSet && !cardSet.has(cardId)) continue;
      const amountCard = ui.metric === "revenue" ? item.revenue : item.qty;
      cardTotals.get(key).set(cardId, (cardTotals.get(key).get(cardId) || 0) + amountCard);
    }
  }

  const allKeys = ui.dim === "nutri"
    ? nutriList().map(user => user.id)
    : ui.dim === "route" ? routes() : state.db.schools.map(school => school.id);
  const ranking = [...new Set([...allKeys, ...totals.keys()])]
    .map(key => ({ key, label: dimensionLabel(ui.dim, key, schools, users), total: totals.get(key) || 0, prev: prevTotals.get(key) || 0 }))
    .sort((a, b) => b.total - a.total);

  let selected = ui.selected.filter(key => ranking.some(row => row.key === key));
  if (!selected.length) selected = ranking.filter(row => row.total > 0).slice(0, 4).map(row => row.key);
  const colorOf = new Map();
  // cor segue a entidade: atribuída na ordem em que foi selecionada, sem repintar as demais
  const previousColors = ui.colorMap || {};
  ui.colorMap = {};
  for (const key of selected) if (previousColors[key]) ui.colorMap[key] = previousColors[key];
  for (const key of selected) {
    if (ui.colorMap[key]) continue;
    const used = new Set(Object.values(ui.colorMap));
    ui.colorMap[key] = seriesColor(used);
  }
  for (const key of selected) colorOf.set(key, ui.colorMap[key]);

  const buckets = enumerateBuckets(ui.from, ui.to, gran);
  const series = selected.map(key => ({
    key,
    name: dimensionLabel(ui.dim, key, schools, users),
    color: colorOf.get(key),
    values: buckets.map(bucket => seriesMap.get(key)?.get(bucket) || 0),
    total: totals.get(key) || 0,
    prev: prevTotals.get(key) || 0,
    days: days.get(key)?.size || 0,
    notServed: notServed.get(key) || 0
  }));

  const composition = new Map();
  for (const key of selected) for (const [cardId, value] of cardTotals.get(key) || []) composition.set(cardId, (composition.get(cardId) || 0) + value);

  return { gran, buckets, series, ranking, selected, grand, prevGrand, prev, composition, colorOf };
}

// 8 cores de referência; acima disso, variações mais escuras e mais claras das mesmas matizes.
function seriesColor(used) {
  for (const shade of [0, -0.28, 0.32, -0.5, 0.55]) {
    for (const base of SERIES_COLORS) {
      const color = shadeHex(base, shade);
      if (!used.has(color)) return color;
    }
  }
  return OTHER_COLOR;
}

function shadeHex(hex, amount) {
  if (!amount) return hex;
  const n = parseInt(hex.slice(1), 16);
  const mix = c => Math.round(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount);
  return "#" + [n >> 16, (n >> 8) & 255, n & 255].map(c => mix(c).toString(16).padStart(2, "0")).join("");
}

function pctDelta(current, previous) {
  if (!previous) return current ? null : 0;
  return ((current - previous) / previous) * 100;
}

function deltaChip(current, previous) {
  const delta = pctDelta(current, previous);
  if (delta === null) return `<span class="delta neutral">novo</span>`;
  const up = delta >= 0;
  return `<span class="delta ${Math.abs(delta) < 0.5 ? "neutral" : up ? "up" : "down"}">${up ? "▲" : "▼"} ${fmtNumber(Math.abs(delta), 1)}%</span>`;
}

function renderAnalytics() {
  const m = mod();
  m.ui.an ||= { ...defaultAnalyticsUi(), tab: "faturamento" };
  const ui = m.ui.an;
  if (ui.tab && ui.tab !== "faturamento") return renderAnalyticsSection(ui.tab);
  const data = computeAnalytics(ui);
  const fmt = ui.metric === "revenue" ? fmtMoneyShort : value => fmtNumber(value);
  const fmtFull = ui.metric === "revenue" ? money : value => fmtNumber(value);
  const selTotal = data.series.reduce((sum, item) => sum + item.total, 0);
  const selPrev = data.series.reduce((sum, item) => sum + item.prev, 0);
  const selDays = Math.max(...data.series.map(item => item.days), 0);
  const dimLabel = { nutri: "Nutricionista", route: "Região (GRE)", school: "Escola" }[ui.dim];
  const metricLabel = ui.metric === "revenue" ? "Faturamento" : "Refeições";
  const cardLabel = !ui.cards?.length ? "todos os cards" : ui.cards.length === 1 ? cardName(state.db.cards.find(card => card.id === ui.cards[0])) : `${ui.cards.length} cards`;
  const best = data.series.slice().sort((a, b) => b.total - a.total)[0];

  shell(`
    ${analyticsHead(`${metricLabel} por ${dimLabel.toLowerCase()} · ${fmtDate(ui.from)} a ${fmtDate(ui.to)} · ${esc(cardLabel)}`)}
    <section class="card an-filters">
      <div class="an-filter-row">
        <div class="field-group"><span class="label">Analisar por</span>
          <div class="segmented">${[["nutri", "Nutricionista"], ["route", "Região"], ["school", "Escola"]].map(([key, label]) => `<button type="button" class="${ui.dim === key ? "active" : ""}" data-an-dim="${key}">${label}</button>`).join("")}</div>
        </div>
        <div class="field-group"><span class="label">Métrica</span>
          <div class="segmented">${[["revenue", "Faturamento"], ["meals", "Refeições"]].map(([key, label]) => `<button type="button" class="${ui.metric === key ? "active" : ""}" data-an-metric="${key}">${label}</button>`).join("")}</div>
        </div>
        <div class="field-group"><span class="label">Período</span>
          <div class="segmented">${[["1m", "Último mês"], ["3m", "3 meses"], ["6m", "6 meses"], ["ytd", "Ano"]].map(([key, label]) => `<button type="button" class="${ui.preset === key ? "active" : ""}" data-an-preset="${key}">${label}</button>`).join("")}</div>
        </div>
        <label class="field-group"><span class="label">De</span><input type="date" id="an-from" value="${ui.from}" /></label>
        <label class="field-group"><span class="label">Até</span><input type="date" id="an-to" value="${ui.to}" /></label>
        <div class="field-group"><span class="label">Cards</span>
          <details class="multi-select" id="an-cards">
            <summary>${esc(!ui.cards?.length ? "Todos os cards" : ui.cards.length === 1 ? cardName(state.db.cards.find(card => card.id === ui.cards[0])) : `${ui.cards.length} cards selecionados`)}${icon("chevronDown")}</summary>
            <div class="multi-menu">
              <div class="multi-actions"><button type="button" class="link-btn" data-an-cards="all">Todos</button><button type="button" class="link-btn" data-an-cards="none">Limpar</button></div>
              ${state.db.cards.map(card => `<label class="multi-opt"><input type="checkbox" value="${card.id}" ${ui.cards?.includes(card.id) ? "checked" : ""} /><i style="background:${cardColor(card.id)}"></i><span><b>${esc(card.label)}</b> · ${esc(card.description)}</span></label>`).join("")}
              <button type="button" class="primary sm" id="an-cards-apply">Aplicar</button>
            </div>
          </details>
        </div>
        <label class="field-group"><span class="label">Agrupar</span><select id="an-gran">${[["auto", "Automático"], ["day", "Dia"], ["week", "Semana"], ["month", "Mês"]].map(([key, label]) => `<option value="${key}" ${ui.gran === key ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      </div>
      <div class="an-compare">
        <span class="label">Comparando (${data.selected.length})</span>
        <div class="compare-chips">
          ${data.series.map(item => `<span class="compare-chip"><i style="background:${item.color}"></i>${esc(item.name)}<button type="button" data-an-remove="${esc(item.key)}" aria-label="Remover">${icon("x")}</button></span>`).join("")}
          <select id="an-add" ${data.ranking.length <= data.selected.length ? "disabled" : ""}><option value="">+ Adicionar ${dimLabel.toLowerCase()}</option>${data.ranking.filter(row => !data.selected.includes(row.key)).map(row => `<option value="${esc(row.key)}">${esc(row.label)}</option>`).join("")}</select>
          ${data.selected.length < data.ranking.length ? `<button type="button" class="link-btn" id="an-all">Comparar todos (${data.ranking.length})</button>` : ""}
          ${ui.selected.length ? `<button type="button" class="link-btn" id="an-reset">Voltar ao top 4</button>` : ""}
        </div>
      </div>
    </section>

    <section class="stat-row an-kpis">
      <div class="stat brand hero-stat"><div><span class="stat-label">${metricLabel} da seleção</span><strong class="stat-value">${fmtFull(selTotal)}</strong><small>${deltaChip(selTotal, selPrev)} vs. período anterior (${fmtDate(data.prev.from)}–${fmtDate(data.prev.to)})</small></div></div>
      <div class="stat"><div><span class="stat-label">Participação no total</span><strong class="stat-value">${data.grand ? fmtNumber(selTotal / data.grand * 100, 1) : 0}%</strong><small>de ${fmtFull(data.grand)} em toda a rede</small></div></div>
      <div class="stat"><div><span class="stat-label">Média por dia letivo</span><strong class="stat-value">${selDays ? fmt(selTotal / selDays) : "—"}</strong><small>${selDays} dia(s) com atendimento</small></div></div>
      <div class="stat"><div><span class="stat-label">Maior resultado</span><strong class="stat-value sm">${best ? esc(best.name) : "—"}</strong><small>${best ? `${fmtFull(best.total)} ${deltaChip(best.total, best.prev)}` : ""}</small></div></div>
    </section>

    <section class="an-grid">
      <article class="card chart-card span-2">
        <header class="chart-head"><div><h3>Evolução de ${metricLabel.toLowerCase()}</h3><p>${{ day: "Cada ponto = 1 dia letivo", week: "Cada ponto = soma da semana (seg–sex)", month: "Cada ponto = soma do mês" }[data.gran]} · comparação entre ${dimLabel.toLowerCase()}s selecionadas</p></div>
          <div class="legend">${data.series.map(item => `<span><i style="background:${item.color}"></i>${esc(item.name)}</span>`).join("")}</div></header>
        <div class="chart-wrap" id="an-line">${data.series.length ? lineChart(data, fmt) : emptyState("Sem dados no período")}</div>
      </article>
      <article class="card chart-card">
        <header class="chart-head"><div><h3>Composição por card</h3><p>${metricLabel} da seleção por segmento</p></div></header>
        ${donutChart(data.composition, fmtFull)}
      </article>
      <article class="card chart-card">
        <header class="chart-head"><div><h3>Ranking · ${dimLabel}</h3><p>Clique para adicionar ou remover da comparação</p></div></header>
        ${rankingBars(data, fmt, ui)}
      </article>
      <article class="card chart-card span-2">
        <header class="chart-head"><div><h3>Comparativo detalhado</h3><p>Período atual vs. período anterior de mesma duração</p></div></header>
        <div class="table-scroll">
          <table class="data-table an-table">
            <thead><tr><th>${dimLabel}</th><th class="num">${metricLabel}</th><th class="num">Anterior</th><th class="num">Variação</th><th class="num">% da rede</th><th class="num">Dias atendidos</th><th class="num">Dias sem atend.</th><th>Tendência</th></tr></thead>
            <tbody>${data.series.map(item => `<tr>
              <td><span class="swatch" style="background:${item.color}"></span><strong>${esc(item.name)}</strong></td>
              <td class="num"><strong>${fmtFull(item.total)}</strong></td>
              <td class="num muted">${fmtFull(item.prev)}</td>
              <td class="num">${deltaChip(item.total, item.prev)}</td>
              <td class="num">${data.grand ? fmtNumber(item.total / data.grand * 100, 1) : 0}%</td>
              <td class="num">${item.days}</td>
              <td class="num">${item.notServed}</td>
              <td>${sparkline(item.values, item.color)}</td>
            </tr>`).join("")}</tbody>
          </table>
        </div>
      </article>
    </section>
  `);
  bindAnalyticsTabs();

  const update = patch => { Object.assign(ui, patch); renderAnalytics(); };
  document.querySelectorAll("[data-an-dim]").forEach(button => button.addEventListener("click", () => update({ dim: button.dataset.anDim, selected: [], colorMap: {} })));
  document.querySelectorAll("[data-an-metric]").forEach(button => button.addEventListener("click", () => update({ metric: button.dataset.anMetric })));
  document.querySelectorAll("[data-an-preset]").forEach(button => button.addEventListener("click", () => {
    const base = defaultAnalyticsUi();
    const end = new Date(`${base.to}T00:00:00`);
    const months = { "1m": 1, "3m": 3, "6m": 6 }[button.dataset.anPreset];
    const start = months ? new Date(end.getFullYear(), end.getMonth() - months + 1, 1) : new Date(end.getFullYear(), 0, 1);
    const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    update({ from: iso(start), to: base.to, preset: button.dataset.anPreset });
  }));
  $("#an-from").addEventListener("change", event => event.target.value && update({ from: event.target.value, preset: "" }));
  $("#an-to").addEventListener("change", event => event.target.value && update({ to: event.target.value, preset: "" }));
  const cardsBox = $("#an-cards");
  if (ui.cardsOpen) cardsBox.open = true;
  cardsBox.querySelectorAll("[data-an-cards]").forEach(button => button.addEventListener("click", () => {
    cardsBox.querySelectorAll("input[type=checkbox]").forEach(input => { input.checked = button.dataset.anCards === "all"; });
  }));
  $("#an-cards-apply").addEventListener("click", () => {
    const picked = [...cardsBox.querySelectorAll("input:checked")].map(input => input.value);
    ui.cardsOpen = false;
    update({ cards: picked.length === state.db.cards.length ? [] : picked });
  });
  document.addEventListener("click", function closeCards(event) {
    if (!document.body.contains(cardsBox)) return document.removeEventListener("click", closeCards);
    if (cardsBox.open && !cardsBox.contains(event.target)) cardsBox.open = false;
  });
  $("#an-gran").addEventListener("change", event => update({ gran: event.target.value }));
  $("#an-add").addEventListener("change", event => event.target.value && update({ selected: [...data.selected, event.target.value] }));
  $("#an-all")?.addEventListener("click", () => update({ selected: data.ranking.map(row => row.key) }));
  $("#an-reset")?.addEventListener("click", () => update({ selected: [], colorMap: {} }));
  document.querySelectorAll("[data-an-remove]").forEach(button => button.addEventListener("click", () => update({ selected: data.selected.filter(key => key !== button.dataset.anRemove) })));
  document.querySelectorAll("[data-an-rank]").forEach(button => button.addEventListener("click", () => {
    const key = button.dataset.anRank;
    if (data.selected.includes(key)) update({ selected: data.selected.filter(item => item !== key) });
    else update({ selected: [...data.selected, key] });
  }));
  bindLineTooltip(data, fmtFull);
  bindHoverTips();
}

function niceTicks(max, count = 4) {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(item => item * magnitude).find(item => item >= raw);
  const ticks = [];
  for (let value = 0; value <= max + step * 0.001; value += step) ticks.push(value);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

function lineChart(data, fmt) {
  const W = 760, H = 280, pad = { l: 64, r: 16, t: 16, b: 30 };
  const n = data.buckets.length;
  const max = Math.max(...data.series.flatMap(item => item.values), 0);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const x = index => pad.l + (n <= 1 ? (W - pad.l - pad.r) / 2 : index * (W - pad.l - pad.r) / (n - 1));
  const y = value => pad.t + (H - pad.t - pad.b) * (1 - value / top);
  const labelEvery = Math.max(1, Math.ceil(n / 9));
  const single = data.series.length === 1;
  return `<svg viewBox="0 0 ${W} ${H}" class="line-chart" preserveAspectRatio="none" role="img" aria-label="Gráfico de linhas">
    <defs>${data.series.map((item, index) => `<linearGradient id="area-${index}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${item.color}" stop-opacity="${single ? 0.22 : 0.08}"/><stop offset="1" stop-color="${item.color}" stop-opacity="0"/></linearGradient>`).join("")}</defs>
    ${ticks.map(tick => `<g class="grid"><line x1="${pad.l}" x2="${W - pad.r}" y1="${y(tick)}" y2="${y(tick)}"/><text x="${pad.l - 10}" y="${y(tick) + 4}" text-anchor="end">${fmt(tick)}</text></g>`).join("")}
    ${data.buckets.map((bucket, index) => index % labelEvery === 0 ? `<text class="x-label" x="${x(index)}" y="${H - 8}" text-anchor="middle">${bucketLabel(bucket, data.gran)}</text>` : "").join("")}
    ${data.series.map((item, index) => {
      const points = item.values.map((value, i) => `${x(i)},${y(value)}`).join(" ");
      const area = `M${x(0)},${y(0)} L${item.values.map((value, i) => `${x(i)},${y(value)}`).join(" L")} L${x(n - 1)},${y(0)} Z`;
      return `<path d="${area}" fill="url(#area-${index})" class="area"/><polyline points="${points}" fill="none" stroke="${item.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" class="series-line" style="--d:${index * 120}ms"/>`;
    }).join("")}
    <line class="crosshair" id="an-cross" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" />
    <g id="an-dots">${data.series.map(item => `<circle r="4.5" fill="${item.color}" stroke="#fff" stroke-width="2" cx="0" cy="0" opacity="0"/>`).join("")}</g>
    <rect class="hit" x="${pad.l}" y="${pad.t}" width="${W - pad.l - pad.r}" height="${H - pad.t - pad.b}" fill="transparent" id="an-hit"/>
  </svg><div class="chart-tip" id="an-tip"></div>`;
}

function bindLineTooltip(data, fmtFull) {
  const svg = document.querySelector(".line-chart");
  const hit = $("#an-hit");
  const tip = $("#an-tip");
  if (!svg || !hit) return;
  const W = 760, H = 280, pad = { l: 64, r: 16, t: 16, b: 30 };
  const n = data.buckets.length;
  const max = Math.max(...data.series.flatMap(item => item.values), 0);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const x = index => pad.l + (n <= 1 ? (W - pad.l - pad.r) / 2 : index * (W - pad.l - pad.r) / (n - 1));
  const y = value => pad.t + (H - pad.t - pad.b) * (1 - value / top);
  const cross = $("#an-cross");
  const dots = [...document.querySelectorAll("#an-dots circle")];
  const move = event => {
    const rect = svg.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width * W;
    const index = Math.max(0, Math.min(n - 1, Math.round((px - pad.l) / ((W - pad.l - pad.r) / Math.max(n - 1, 1)))));
    cross.setAttribute("x1", x(index)); cross.setAttribute("x2", x(index));
    cross.classList.add("on");
    data.series.forEach((item, i) => { dots[i].setAttribute("cx", x(index)); dots[i].setAttribute("cy", y(item.values[index])); dots[i].setAttribute("opacity", "1"); });
    const rows = data.series.map(item => ({ item, value: item.values[index] })).sort((a, b) => b.value - a.value);
    tip.innerHTML = `<strong>${bucketRange(data.buckets[index], data.gran)}</strong>${rows.map(({ item, value }) => `<div><i style="background:${item.color}"></i><span>${esc(item.name)}</span><b>${fmtFull(value)}</b></div>`).join("")}`;
    tip.classList.add("on");
    const left = x(index) / W * rect.width;
    tip.style.left = `${Math.min(Math.max(left, 110), rect.width - 110)}px`;
    tip.style.top = `${Math.max(8, event.clientY - rect.top - tip.offsetHeight - 16)}px`;
  };
  hit.addEventListener("mousemove", move);
  hit.addEventListener("mouseleave", () => {
    tip.classList.remove("on");
    cross.classList.remove("on");
    dots.forEach(dot => dot.setAttribute("opacity", "0"));
  });
}

function donutChart(composition, fmtFull) {
  const cards = new Map(state.db.cards.map(card => [card.id, card]));
  const rows = [...composition.entries()].map(([cardId, value]) => ({ cardId, label: cardName(cards.get(cardId)) || cardId, value })).filter(row => row.value > 0).sort((a, b) => b.value - a.value);
  if (!rows.length) return emptyState("Sem dados para a seleção");
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  const R = 70, r = 46, C = 90;
  let angle = -Math.PI / 2;
  const arcs = rows.map((row, index) => {
    const slice = (row.value / total) * Math.PI * 2;
    const gap = rows.length > 1 ? 0.025 : 0;
    const a0 = angle + gap / 2, a1 = angle + slice - gap / 2;
    angle += slice;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad, radius) => `${C + radius * Math.cos(rad)},${C + radius * Math.sin(rad)}`;
    const color = cardColor(row.cardId);
    const path = rows.length === 1
      ? `M${C - R},${C} a${R},${R} 0 1,0 ${2 * R},0 a${R},${R} 0 1,0 ${-2 * R},0 M${C - r},${C} a${r},${r} 0 1,1 ${2 * r},0 a${r},${r} 0 1,1 ${-2 * r},0`
      : `M${p(a0, R)} A${R},${R} 0 ${large} 1 ${p(a1, R)} L${p(a1, r)} A${r},${r} 0 ${large} 0 ${p(a0, r)} Z`;
    return { ...row, color, path, pct: row.value / total * 100 };
  });
  return `<div class="donut-wrap">
    <svg viewBox="0 0 180 180" class="donut">${arcs.map(arc => `<path d="${arc.path}" fill="${arc.color}" fill-rule="evenodd" data-tip="${esc(arc.label)}: ${esc(fmtFull(arc.value))} (${fmtNumber(arc.pct, 1)}%)"/>`).join("")}
      <text x="90" y="86" text-anchor="middle" class="donut-total">${esc(fmtMoneyShortOr(total, fmtFull))}</text><text x="90" y="104" text-anchor="middle" class="donut-sub">total</text></svg>
    <ul class="donut-legend">${arcs.map(arc => `<li><i style="background:${arc.color}"></i><span>${esc(arc.label)}</span><b>${fmtNumber(arc.pct, 1)}%</b></li>`).join("")}</ul>
  </div>`;
}

function cardName(card) {
  if (!card) return "";
  return card.label === card.description || !card.description ? card.label : `${card.label} · ${card.description}`;
}

// cor fixa por card (segue o card, não a posição no gráfico)
function cardColor(cardId) {
  const index = Math.max(0, state.db.cards.findIndex(card => card.id === cardId));
  const shades = [0, -0.3, 0.35];
  return shadeHex(SERIES_COLORS[index % SERIES_COLORS.length], shades[Math.floor(index / SERIES_COLORS.length) % shades.length]);
}

function fmtMoneyShortOr(value, fmtFull) {
  return fmtFull === money ? fmtMoneyShort(value) : fmtNumber(value);
}

// KM rodado por nutricionista no período do Analytics (todos os dias lançados, enviados ou não).
function kmAnalytics(from, to) {
  const people = mod().data.people || [];
  const vehicles = mod().data.km?.vehicles || {};
  const rows = people.map(person => {
    let total = 0;
    let days = 0;
    let pending = 0;
    let fuelValue = 0;
    let fuelLiters = 0;
    for (const [month, byNutri] of Object.entries(mod().data.km?.logs || {})) {
      const log = byNutri[person.id];
      if (!log) continue;
      for (const [date, row] of Object.entries(log.fuel || {})) {
        if (date < from || date > to) continue;
        fuelValue += Number(row.value) || 0;
        fuelLiters += Number(row.liters) || 0;
      }
      let inPeriod = false;
      for (const [date, row] of Object.entries(log.days || {})) {
        if (date < from || date > to) continue;
        const start = parseKm(row.start);
        const end = parseKm(row.end);
        if (start === null || end === null) continue;
        total += end - start;
        days += 1;
        inPeriod = true;
      }
      if (inPeriod && !log.sentAt) pending += 1;
    }
    return { person, plate: vehicles[person.id]?.plate || "", total: Math.round(total * 10) / 10, days, pending, fuelValue, fuelLiters };
  }).sort((a, b) => b.total - a.total);
  return { rows, grand: rows.reduce((sum, row) => sum + row.total, 0), fuelValue: rows.reduce((sum, row) => sum + row.fuelValue, 0), fuelLiters: rows.reduce((sum, row) => sum + row.fuelLiters, 0) };
}

function rankingBars(data, fmt, ui) {
  const rows = data.ranking.slice(0, ui.dim === "school" ? 12 : 13);
  const max = Math.max(...rows.map(row => row.total), 1);
  return `<div class="rank-list">${rows.map((row, index) => {
    const selected = data.selected.includes(row.key);
    const color = selected ? data.colorOf.get(row.key) : "#c9d3ce";
    return `<button type="button" class="rank-row ${selected ? "on" : ""}" data-an-rank="${esc(row.key)}" data-tip="${esc(row.label)}: ${esc(fmt(row.total))}">
      <span class="rank-pos">${index + 1}</span>
      <span class="rank-label">${esc(row.label)}</span>
      <span class="rank-bar"><i style="width:${(row.total / max * 100).toFixed(1)}%;background:${color}"></i></span>
      <span class="rank-val">${fmt(row.total)}</span>
    </button>`;
  }).join("")}</div>`;
}

function sparkline(values, color) {
  const W = 110, H = 28;
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? W / (values.length - 1) : 0;
  const points = values.map((value, index) => `${(index * step).toFixed(1)},${(H - 3 - (value / max) * (H - 6)).toFixed(1)}`).join(" ");
  return `<svg viewBox="0 0 ${W} ${H}" class="spark" preserveAspectRatio="none"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function bindHoverTips() {
  let tip = document.querySelector(".hover-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "hover-tip";
    document.body.appendChild(tip);
  }
  document.querySelectorAll(".donut [data-tip], .rank-row[data-tip]").forEach(el => {
    el.addEventListener("mousemove", event => {
      tip.textContent = el.dataset.tip;
      tip.style.left = `${event.clientX + 14}px`;
      tip.style.top = `${event.clientY + 14}px`;
      tip.classList.add("on");
    });
    el.addEventListener("mouseleave", () => tip.classList.remove("on"));
  });
}

function allowedViews() {
  return navConfig(state.user?.role === "admin").flatMap(group => group.items).filter(item => !item.disabled).map(item => item.view);
}

function restoredView() {
  const saved = sessionStorage.getItem("ui-view");
  return saved && allowedViews().includes(saved) ? saved : homeView();
}
