const HML_QUERY = "hml";
const HML_STORAGE_KEY = "apuracao-comandas-hml-db";
const PROD_SESSION_KEY = "apuracao-session-token";
const HML_SESSION_KEY = "apuracao-hml-session-token";
const SAVE_DRAFT_PREFIX = "apuracao-comandas-save-draft";
const OFFICIAL_ROUTES = [
  "GRE CAJAZEIRAS",
  "GRE CENTRO",
  "GRE CIDADE BAIXA",
  "GRE LIBERDADE",
  "GRE SAO CAETANO",
  "GRE SUBURBIO I",
  "GRE SUBURBIO II"
];

function isHmlMode() {
  const params = new URLSearchParams(location.search);
  return params.get(HML_QUERY) === "1" || location.pathname.replace(/\/+$/, "") === "/hml";
}

function authStorageKey() {
  return isHmlMode() ? HML_SESSION_KEY : PROD_SESSION_KEY;
}

const state = {
  db: null,
  user: null,
  view: "lancamentos",
  selectedDate: new Date().toISOString().slice(0, 10),
  selectedMonth: "2026-07",
  routeFilter: "todas",
  nutritionistFilter: "todos",
  expandedSchools: new Set(),
  expandedLaunchDates: new Set(),
  expandedMonthSchools: new Set(),
  expandedMonthDates: new Set(),
  expandedAdminSchools: new Set(),
  expandedAdminDates: new Set(),
  sessionToken: localStorage.getItem(authStorageKey()) || "",
  message: "",
  isSaving: false,
  adminPeriodDirty: false,
  adminRefreshTimer: null
};

let staticDbCache = null;

const $ = selector => document.querySelector(selector);
const app = $("#app");

function isStaticMode() {
  return isHmlMode() || location.hostname.endsWith("github.io") || location.protocol === "file:";
}

function staticStorageKey() {
  return isHmlMode() ? HML_STORAGE_KEY : "apuracao-comandas-db";
}

function staticDataFile() {
  return isHmlMode() ? "hml-data.json" : "demo-data.json";
}

function saveDraftStorageKey() {
  return `${SAVE_DRAFT_PREFIX}:${isStaticMode() ? "static" : "prod"}:${state.user?.id || "anon"}`;
}

function saveLocalDraft(reason = "pending-save") {
  if (!state.user || !state.db) return;
  const draft = {
    reason,
    savedAt: new Date().toISOString(),
    userId: state.user.id,
    selectedMonth: state.selectedMonth,
    entries: (state.db.entries || []).filter(entry => entry.nutritionistId === state.user.id),
    closures: (state.db.closures || []).filter(item => item.nutritionistId === state.user.id)
  };
  localStorage.setItem(saveDraftStorageKey(), JSON.stringify(draft));
}

function getLocalDraft() {
  if (!state.user) return null;
  try {
    return JSON.parse(localStorage.getItem(saveDraftStorageKey()) || "null");
  } catch (_) {
    return null;
  }
}

function clearLocalDraft() {
  if (!state.user) return;
  localStorage.removeItem(saveDraftStorageKey());
}

function restoreLocalDraft() {
  const draft = getLocalDraft();
  if (!draft || draft.userId !== state.user.id) return false;
  const draftEntryIds = new Set((draft.entries || []).map(entry => entry.id).filter(Boolean));
  state.db.entries = [
    ...(state.db.entries || []).filter(entry => entry.nutritionistId !== state.user.id || !draftEntryIds.has(entry.id)),
    ...(draft.entries || [])
  ];
  const draftClosureKeys = new Set((draft.closures || []).map(item => `${item.month}:${item.nutritionistId}`));
  state.db.closures = [
    ...(state.db.closures || []).filter(item => !draftClosureKeys.has(`${item.month}:${item.nutritionistId}`)),
    ...(draft.closures || [])
  ];
  state.selectedMonth = draft.selectedMonth || state.selectedMonth;
  state.message = "Rascunho local restaurado. Confira os dados e clique em Salvar.";
  return true;
}

function hmlBanner() {
  if (!isHmlMode()) return "";
  return `
    <div class="hml-banner" role="status">
      <strong>Ambiente de Homologa√ß√£o</strong>
      <span>Dados fict√≠cios salvos apenas neste navegador. O Supabase de produ√ß√£o n√£o √© acessado.</span>
    </div>
  `;
}

function money(value) {
  return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatMonthBR(month) {
  const [year, monthNumber] = String(month || "").split("-").map(Number);
  if (!year || !monthNumber) return month || "";
  const label = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, monthNumber - 1, 1)));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function downloadBase64File({ base64, filename, contentType }) {
  const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
  const blob = new Blob([bytes], { type: contentType || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename || "exportacao.xlsx";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function formatDateBR(date) {
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
}

function parseQuantity(value) {
  if (value === "" || value === null || value === undefined) return "";
  const parsed = Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : value;
}

function quantityNumber(value) {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function routes() {
  return [...new Set(state.db.schools.map(s => s.route).filter(Boolean))].sort();
}

function routeOptions() {
  return [...new Set([...OFFICIAL_ROUTES, ...routes()])].sort();
}

function nutritionists() {
  return state.db.users.filter(user => user.role === "nutritionist" && user.active !== false);
}

function entriesFor({ date, month, userId, schoolId } = {}) {
  return state.db.entries.filter(entry => {
    if (date && entry.date !== date) return false;
    if (month && !entry.date.startsWith(month)) return false;
    if (userId && entry.nutritionistId !== userId) return false;
    if (schoolId && entry.schoolId !== schoolId) return false;
    return true;
  });
}

function isCompleteEntry(entry) {
  if (!entry) return false;
  if (entry.status === "not_served") return Boolean(entry.reason);
  const values = Object.values(entry.quantities || {});
  return values.length > 0 && values.every(value => value !== "" && value !== null && value !== undefined && Number.isFinite(Number(String(value).replace(",", "."))));
}

function completeEntriesFor(filters = {}) {
  return entriesFor(filters).filter(isCompleteEntry);
}

function expectedBusinessDays(month = state.selectedMonth) {
  const configured = state.db.settings?.workingDaysByMonth?.[month];
  if (configured) return Number(configured);
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(year, monthNumber, 0).getDate();
  let total = 0;
  for (let day = 1; day <= lastDay; day += 1) {
    const weekday = new Date(year, monthNumber - 1, day).getDay();
    if (weekday !== 0 && weekday !== 6) total += 1;
  }
  return total || 22;
}

function businessDates(month = state.selectedMonth) {
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(year, monthNumber, 0).getDate();
  const dates = [];
  for (let day = 1; day <= lastDay; day += 1) {
    const weekday = new Date(year, monthNumber - 1, day).getDay();
    if (weekday !== 0 && weekday !== 6) {
      dates.push(`${year}-${String(monthNumber).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
    }
  }
  return dates;
}

function setExpectedBusinessDays(month, value) {
  state.db.settings = state.db.settings || {};
  state.db.settings.workingDaysByMonth = state.db.settings.workingDaysByMonth || {};
  const parsed = Number(String(value || "").replace(",", "."));
  state.db.settings.workingDaysByMonth[month] = parsed > 0 ? parsed : 22;
}

function pruneEntryIfEmpty(entry) {
  if (!entry || isCompleteEntry(entry) || (entry.notes || "").trim()) return;
  if (entry.reason || Object.keys(entry.quantities || {}).length > 0) return;
  state.db.entries = state.db.entries.filter(item => item.id !== entry.id);
}

function assignedSchools(userId = state.user?.id) {
  if (state.user?.role === "admin") return state.db.schools;
  return state.db.schools.filter(school => school.active && school.nutritionistIds.includes(userId));
}

async function api(path, options = {}) {
  if (isStaticMode()) {
    return staticApi(path, options);
  }
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.sessionToken) headers.Authorization = `Bearer ${state.sessionToken}`;
  const response = await fetch(path, {
    headers,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Falha na operacao.");
  return data;
}

async function getStaticDb() {
  if (staticDbCache) return staticDbCache;
  if (isHmlMode() && new URLSearchParams(location.search).get("reset") === "1") {
    localStorage.removeItem(staticStorageKey());
  }
  const stored = localStorage.getItem(staticStorageKey());
  if (stored) {
    staticDbCache = JSON.parse(stored);
    return staticDbCache;
  }
  const response = await fetch(staticDataFile(), { cache: "no-store" });
  staticDbCache = await response.json();
  localStorage.setItem(staticStorageKey(), JSON.stringify(staticDbCache));
  return staticDbCache;
}

async function staticApi(path, options = {}) {
  const db = await getStaticDb();
  if (path === "/api/data") return db;

  if (path === "/api/login") {
    const body = options.body || {};
    const user = db.users.find(item => item.username === body.username && item.password === body.password);
    if (!user) throw new Error("Usuario ou senha invalidos.");
    return { user: { id: user.id, name: user.name, username: user.username, role: user.role } };
  }

  if (path === "/api/save") {
    staticDbCache = options.body;
    localStorage.setItem(staticStorageKey(), JSON.stringify(staticDbCache));
    return { ok: true };
  }

  if (path === "/api/export") {
    if (isHmlMode()) {
      const month = options.body?.month || db.settings.currentMonth;
      const rows = db.entries
        .filter(entry => String(entry.date || "").startsWith(month))
        .map(entry => {
          const school = db.schools.find(item => item.id === entry.schoolId);
          const total = quantityNumber(Object.values(entry.quantities || {}).reduce((sum, value) => sum + quantityNumber(value), 0));
          return `${entry.date};${school?.shortName || entry.schoolId};${entry.nutritionistName};${entry.status};${total}`;
        });
      const csv = ["data;escola;nutricionista;status;quantidade_total", ...rows].join("\n");
      return {
        ok: true,
        filename: `hml-exportacao-${month}.csv`,
        contentType: "text/csv; charset=utf-8",
        base64: btoa(csv)
      };
    }
    throw new Error("A exportacao Excel real precisa da versao com servidor local.");
  }

  throw new Error("Rota nao encontrada.");
}

async function saveDb(message = "Salvo.") {
  saveLocalDraft("before-save");
  state.isSaving = true;
  state.message = "Salvando...";
  render();
  try {
    await api("/api/save", { method: "POST", body: state.db });
    const selectedMonth = state.selectedMonth;
    state.db = await api("/api/data");
    state.selectedMonth = selectedMonth;
    clearLocalDraft();
    state.message = message;
  } catch (error) {
    state.message = `Nao foi possivel salvar: ${error.message}. O preenchimento continua nesta tela; tente Salvar novamente antes de sair.`;
  } finally {
    state.isSaving = false;
    render();
  }
}

async function loadData() {
  state.db = await api("/api/data");
  state.selectedMonth = state.db.settings.currentMonth;
}

function renderLogin(error = "") {
  app.innerHTML = `
    ${hmlBanner()}
    <main class="login-screen">
      <form class="login-card" id="login-form">
        <img class="login-logo" src="yg-systems-monogram.png" alt="YG Systems" />
        <h1>Apura√ß√£o de Comandas</h1>
        <p>${isHmlMode() ? "Entre com usu√°rios fict√≠cios para testar fluxos sem acessar o Supabase." : "Entre para lan√ßar refei√ß√µes, acompanhar pend√™ncias ou exportar a consolida√ß√£o mensal."}</p>
        ${isHmlMode() ? `<p class="hml-credentials"><strong>HML:</strong> admin/adminhml ou nutri/nutrihml</p>` : ""}
        <div class="field">
          <label for="username">Usu√°rio</label>
          <input id="username" autocomplete="username" />
        </div>
        <div class="field">
          <label for="password">Senha</label>
          <input id="password" type="password" autocomplete="current-password" />
        </div>
        <button class="primary" type="submit">Entrar</button>
        <p class="error">${error}</p>
      </form>
    </main>
  `;
  $("#login-form").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const result = await api("/api/login", {
        method: "POST",
        body: { username: $("#username").value.trim(), password: $("#password").value }
      });
      state.sessionToken = result.token || "";
      if (state.sessionToken) localStorage.setItem(authStorageKey(), state.sessionToken);
      state.user = result.user;
      state.db = await api("/api/data");
      state.selectedMonth = state.db.settings.currentMonth;
      state.view = state.user.role === "admin" ? "dashboard" : "lancamentos";
      state.message = "";
      render();
    } catch (err) {
      renderLogin(err.message);
    }
  });
}

function shell(content) {
  const isAdmin = state.user.role === "admin";
  const items = isAdmin
    ? [["dashboard", "Painel"], ["config", "Configura√ß√µes"], ["exportar", "Exportar"]]
    : [["lancamentos", "Lan√ßamentos"], ["meu-mes", "Meu m√™s"]];
  app.innerHTML = `
    ${hmlBanner()}
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <img src="yg-systems-monogram.png" alt="YG Systems" />
          <div>
            <strong>Comandas</strong>
            <span>Controle de refei√ß√µes</span>
          </div>
        </div>
        <nav class="nav">
          ${items.map(([id, label]) => `<button data-view="${id}" class="${state.view === id ? "active" : ""}">${label}</button>`).join("")}
        </nav>
        <div class="user-box">
          <strong>${state.user.name}</strong>
          <span>${isAdmin ? "Coordena√ß√£o" : "Nutricionista"}</span>
          <button id="logout">Sair</button>
        </div>
      </aside>
      <main class="content">
        ${content}
        <footer class="app-footer">
          Desenvolvido por <a href="https◊MvÍ⁄$z{-ÆÈ‹j◊ùBÊVÁG&ñW2ÜVÁG'íÁVÁFóFñW2«¬∑“íÊf˜$V6ÇÇÖ∂6&DñB¬VÁFóGï“í”‚∞–¢6ˆÁ7Bf«VR“VÁFóGîÁV÷&W"áVÁFóGíì∞–¢ñbÇf«VRí&WGW&„∞–¢F˜F«2Á6WBÜ6&DñB¬áF˜F«2ÊvWBÜ6&DñBí«¬í≤f«VRì∞–¢“ì∞–¢“ì∞–¢“ì∞–¢&WGW&‚7FFRÊF"Ê6&G0–¢Ê÷Ü6&B”‚á∞–¢∆&V√¢6&BÊ∆&V¬¿–¢VÁFóGì¢F˜F«2ÊvWBÜ6&BÊñBí«¬¿–¢F˜F√¢áF˜F«2ÊvWBÜ6&BÊñBí«¬í¢ÁV÷&W"Ü6&BÁ&ñ6R«¬ê–¢“íê–¢Êfñ«FW"ÜóFV“”‚óFV“ÁVÁFóGí‚ê–¢Á6˜'BÇÜ¬"í”‚Ê∆&V¬Ê∆ˆ6∆T6ˆ◊&RÜ"Ê∆&V¬¬'B‘%""¬≤ÁV÷W&ñ3¢G'VR“íì∞–ß––†–¶gVÊ7Fñˆ‚F÷ñÂ66ÜˆˆƒFWFñ¬á66Üˆˆ¬í∞–¢6ˆÁ7BFFW2“'W6ñÊW74FFW2Çì∞–¢6ˆÁ7Bfñ∆∆VB“FFW2Êfñ«FW"ÜFFR”‚F÷ñ‰FFTVÁG&ñW2á66Üˆˆ¬ÊñB¬FFRíÁ6ˆ÷RÜó46ˆ◊∆WFTVÁG'íííÊ∆VÊwFÉ∞–¢6ˆÁ7BVÊFñÊr“÷FÇÊ÷ÇÜFFW2Ê∆VÊwFÇ“fñ∆∆VB¬ì∞–¢6ˆÁ7BF˜F¬“FFW2Á&VGV6RÇá7V“¬FFRí”‚∞–¢&WGW&‚7V“≤F÷ñ‰FFTVÁG&ñW2á66Üˆˆ¬ÊñB¬FFRíÊfñ«FW"Üó46ˆ◊∆WFTVÁG'ííÁ&VGV6RÇÜFï7V“¬VÁG'íí”‚Fï7V“≤VÁFóFñW5F˜F¬ÜVÁG'íÁVÁFóFñW2í¬ì∞–¢“¬ì∞–¢6ˆÁ7B÷Ñ6&E&V6˜&G2“F÷ñÂ66Üˆˆƒ÷Ñ6&E&V6˜&G2á66Üˆˆ¬¬FFW2ì∞–¢6ˆÁ7B6&EF˜F«2“F÷ñÂ66Üˆˆƒ6&EF˜F«2á66Üˆˆ¬¬FFW2ì∞–¢&WGW&‚ –¢«6V7Fñˆ‚6∆73“&F÷ñ‚◊66Üˆˆ¬÷FWFñ¬#‡–¢∆Fób6∆73“&F÷ñ‚÷FWFñ¬◊7V÷÷'í#‡–¢«7„„«7G&ˆÊs‚G∂fñ∆∆VG”¬˜7G&ˆÊs‚&VVÊ6ÜñF3¬˜7„‡–¢«7„„«7G&ˆÊs‚G∑VÊFñÊw”¬˜7G&ˆÊs‚VÊFVÁFW3¬˜7„‡–¢«7„„«7G&ˆÊs‚G∂÷ˆÊWíáF˜F¬ó”¬˜7G&ˆÊs‚F˜F¬W7Fñ÷FÛ¬˜7„‡–¢G∂÷Ñ6&E&V6˜&G2Ê∆VÊwFÇÚ –¢∆Fób6∆73“&F÷ñ‚÷÷Ç÷6&B◊7V÷÷'í"&ñ÷∆&V√“$÷ñ˜&W2&Vvó7G&˜2˜"6&B#‡–¢G∂÷Ñ6&E&V6˜&G2Ê÷ÜóFV“”‚ –¢«7„‡–¢«7G&ˆÊs‚G∂óFV“Ê∆&V«”¬˜7G&ˆÊs‚“G∂óFV“ÁVÁFóGíÁFÙ∆ˆ6∆U7G&ñÊrÇ'B‘%""ó“¬G∂f˜&÷DFFT%"ÜóFV“ÊFFRó––¢¬˜7„‡–¢íÊ¶ˆñ‚Ç""ó––¢¬ˆFóc‡–¢¢"'––¢¬ˆFóc‡–¢G∂6&EF˜F«2Ê∆VÊwFÇÚ –¢∆Fób6∆73“&F÷ñ‚◊66Üˆˆ¬÷6&B◊F˜F¬◊ÊV¬#‡–¢∆Fób6∆73“'66Üˆˆ¬◊F˜F¬÷óFV“F÷ñ‚◊66Üˆˆ¬◊F˜F¬÷óFV“#‡–¢«7„‚G∑66Üˆˆ¬Á6Ü˜'DÊ÷W”¬˜7„‡–¢∆Fób6∆73“'66Üˆˆ¬÷6&B◊F˜F«2#‡–¢G∂6&EF˜F«2Ê÷ÜóFV“”‚ –¢∆Fób6∆73“'66Üˆˆ¬÷6&B◊F˜F¬÷∆ñÊR#‡–¢«7„‚G∂óFV“Ê∆&V«”¬˜7„‡–¢«7G&ˆÊs‚G∂óFV“ÁVÁFóGíÁFÙ∆ˆ6∆U7G&ñÊrÇ'B‘%""ó”¬˜7G&ˆÊs‡–¢¬ˆFóc‡–¢íÊ¶ˆñ‚Ç""ó––¢¬ˆFóc‡–¢∆Fób6∆73“'66Üˆˆ¬◊F˜F¬÷vVÊW&¬#‡–¢«7„ÂF˜F¬vW&√¬˜7„‡–¢«7G&ˆÊs‚G∂÷ˆÊWíáF˜F¬ó”¬˜7G&ˆÊs‡–¢¬ˆFóc‡–¢¬ˆFóc‡–¢¬ˆFóc‡–¢¢"'––¢∆Fób6∆73“&F÷ñ‚÷FFR÷∆ó7B#‡–¢G∂FFW2Ê÷ÜFFR”‚F÷ñ‰FFT6&Bá66Üˆˆ¬¬FFRííÊ¶ˆñ‚Ç""ó––¢¬ˆFóc‡–¢¬˜6V7Fñˆ„‡–¢∞–ß––†–¶gVÊ7Fñˆ‚F÷ñ‰FFT6&Bá66Üˆˆ¬¬FFRí∞–¢6ˆÁ7BVÁG&ñW2“F÷ñ‰FFTVÁG&ñW2á66Üˆˆ¬ÊñB¬FFRì∞–¢6ˆÁ7B6ˆ◊∆WFTVÁG&ñW2“VÁG&ñW2Êfñ«FW"Üó46ˆ◊∆WFTVÁG'íì∞–¢6ˆÁ7B6ˆ◊∆WFR“6ˆ◊∆WFTVÁG&ñW2Ê∆VÊwFÇ‚∞–¢6ˆÁ7BF˜F¬“6ˆ◊∆WFTVÁG&ñW2Á&VGV6RÇá7V“¬VÁG'íí”‚7V“≤VÁFóFñW5F˜F¬ÜVÁG'íÁVÁFóFñW2í¬ì∞–¢6ˆÁ7B7FGW2“6ˆ◊∆WFRÚÜ6ˆ◊∆WFTVÁG&ñW2Á6ˆ÷RÜVÁG'í”‚VÁG'íÁ7FGW2””“&Ê˜E˜6W'fVB"íÚ%6V“FVÊFñ÷VÁFÚ"¢%&VVÊ6ÜñFÚ"í¢%VÊFVÁFR#∞–¢6ˆÁ7B∂Wí“FFU7FFT∂Wíá66Üˆˆ¬ÊñB¬FFRì∞–¢6ˆÁ7BWáÊFVB“7FFRÊWáÊFVDF÷ñ‰FFW2ÊÜ2Ü∂Wíì∞–¢&WGW&‚ –¢∆'Fñ6∆R6∆73“&F÷ñ‚÷FFR÷6&BG∂WáÊFVBÚ""¢&6ˆ∆∆6VB'“#‡–¢∆'WGFˆ‚6∆73“&÷ˆÁFÇ÷FFR◊&˜r"GóS“&'WGFˆ‚"FF÷F÷ñ‚÷FFR◊Fˆvv∆S“"G∂∂Wó“"&ñ÷WáÊFVC“"G∂WáÊFVG“#‡–¢«7G&ˆÊs‚G∂f˜&÷DFFT%"ÜFFRó”¬˜7G&ˆÊs‡–¢«7‚6∆73“&&FvRG∂6ˆ◊∆WFRÚ&FˆÊR"¢'v&‚'“#‚G∑7FGW7”¬˜7„‡–¢«7„‚G∂6ˆ◊∆WFTVÁG&ñW2Ê÷ÜVÁG'í”‚VÁG'íÊÁWG&óFñˆÊó7DÊ÷RíÊfñ«FW"Ñ&ˆˆ∆V‚íÊ¶ˆñ‚Ç"¬"ó”¬˜7„‡–¢«7„‚G∂6ˆ◊∆WFRÚ÷ˆÊWíáF˜F¬í¢"'”¬˜7„‡–¢«7‚6∆73“&6ÜWg&ˆ‚#‚G∂WáÊFVBÚ"“"¢"≤'”¬˜7„‡–¢¬ˆ'WGFˆ„‡–¢G∂WáÊFVBÚ∆Fób6∆73“&F÷ñ‚÷FFR÷FWFñ¬#‚G∂F÷ñ‰FFTFWFñ¬ÜVÁG&ñW2¬6ˆ◊∆WFTVÁG&ñW2ó”¬ˆFócÊ¢"'––¢¬ˆ'Fñ6∆S‡–¢∞–ß––†–¶gVÊ7Fñˆ‚F÷ñ‰FFTFWFñ¬ÜVÁG&ñW2¬6ˆ◊∆WFTVÁG&ñW2í∞–¢ñbÇVÁG&ñW2Ê∆VÊwFÇí&WGW&‚«7‚6∆73“&◊WFVB#‰ÊVÊáV“&VVÊ6Üñ÷VÁFÚñÊñ6ñFÚÊW76FF„¬˜7„Ê∞–¢ñbÇ6ˆ◊∆WFTVÁG&ñW2Ê∆VÊwFÇí&WGW&‚«7‚6∆73“&◊WFVB#Â&VVÊ6Üñ÷VÁFÚñÊñ6ñFÚ¬÷2ñÊFVÊFVÁFRFRfñÊ∆ó¶f66VFñ√≤fFñ∆FS∂Ú„¬˜7„Ê∞–¢&WGW&‚6ˆ◊∆WFTVÁG&ñW2Ê÷ÜVÁG'í”‚∞–¢6ˆÁ7BF˜F¬“VÁFóFñW5F˜F¬ÜVÁG'íÁVÁFóFñW2ì∞–¢6ˆÁ7B6&G2“fñ∆∆VD6&D∆ñÊW2ÜVÁG'íì∞–¢&WGW&‚ –¢∆Fób6∆73“&F÷ñ‚÷VÁG'í÷FWFñ¬#‡–¢∆Fób6∆73“&F÷ñ‚÷VÁG'í÷ÜVB#‡–¢«7G&ˆÊs‚G∂VÁG'íÊÁWG&óFñˆÊó7DÊ÷R«¬$ÁWG&ñ6ñˆÊó7F'”¬˜7G&ˆÊs‡–¢«7„‚G∂VÁG'íÁ7FGW2””“&Ê˜E˜6W'fVB"Ú%6V“FVÊFñ÷VÁFÚ"¢F˜F√¢G∂÷ˆÊWíáF˜F¬ó÷”¬˜7„‡–¢¬ˆFóc‡–¢G∂VÁG'íÁ7FGW2””“&Ê˜E˜6W'fVB"Ú«7„‰÷˜FófÛ¢G∂VÁG'íÁ&V6ˆÁ”¬˜7„Ê¢6&G2Ê∆VÊwFÇÚ –¢∆Fób6∆73“&6&B÷∆ñÊW2#‡–¢G∂6&G2Ê÷ÜóFV“”‚ –¢∆Fób6∆73“&6&B÷∆ñÊR#‡–¢«7„‚G∂óFV“Ê∆&V«”¬˜7„‡–¢«7G&ˆÊs‚G∂óFV“ÁGó”¬˜7G&ˆÊs‡–¢«7„‚G∂÷ˆÊWíáVÁFóGîÁV÷&W"ÜóFV“ÁGíí¢óFV“Á&ñ6Ró”¬˜7„‡–¢¬ˆFóc‡–¢íÊ¶ˆñ‚Ç""ó––¢¬ˆFóc‡–¢¢«7‚6∆73“&◊WFVB#‰ÊVÊáV“6&B&VVÊ6ÜñFÚ„¬˜7„Ê––¢G∂VÁG'íÊÊ˜FW2Ú«7„‰ˆ'6W'ff66VFñ√≤fFñ∆FS∂Û¢G∂VÁG'íÊÊ˜FW7”¬˜7„Ê¢"'––¢¬ˆFóc‡–¢∞–¢“íÊ¶ˆñ‚Ç""ì∞–ß––¶gVÊ7Fñˆ‚&VÊFW$6ˆÊfñrÇí∞–¢6ÜV∆¬Ü –¢∆Fób6∆73“'F˜&"#‡–¢∆Fób6∆73“'vR◊FóF∆R#„∆É‰6ˆÊfñwW&:|;VW3¬ˆÉ„«‰FVfñÊÁWG&ñ6ñˆÊó7F2¬&˜F2RW66ˆ∆26ˆ"&W7ˆÁ6&ñ∆ñFFR„¬˜„¬ˆFóc‡–¢∆'WGFˆ‚6∆73“'&ñ÷'í"ñC“&FB◊W6W"#‰Ê˜fÁWG&ñ6ñˆÊó7F¬ˆ'WGFˆ„‡–¢¬ˆFóc‡–¢«6V7Fñˆ‚6∆73“'ÊV¬#‡–¢∆É#‰ÁWG&ñ6ñˆÊó7F3¬ˆÉ#‡–¢∆Fób6∆73“'F&∆R◊w&#‡–¢«F&∆S‡–¢«FÜVC„«G#„«FÉ‰Êˆ÷S¬˜FÉ„«FÉÂW7\:&ñÛ¬˜FÉ„«FÉÂ6VÊÜ¬˜FÉ„«FÉ‰W66ˆ∆3¬˜FÉ„«FÉ‰:|;VW3¬˜FÉ„¬˜G#„¬˜FÜVC‡–¢«F&ˆGì‚G∂ÁWG&óFñˆÊó7G2ÇíÊ÷áW6W%&˜ríÊ¶ˆñ‚Ç""ó”¬˜F&ˆGì‡–¢¬˜F&∆S‡–¢¬ˆFóc‡–¢¬˜6V7Fñˆ„‡–¢«6V7Fñˆ‚6∆73“'ÊV¬#‡–¢∆Fób6∆73“'6V7Fñˆ‚÷ÜVB#‡–¢∆É#Âl:÷Ê7V∆Ú˜"W66ˆ∆¬ˆÉ#‡–¢∆'WGFˆ‚6∆73“'6V6ˆÊF'í"ñC“&FB◊66Üˆˆ¬"GóS“&'WGFˆ‚#‰Fñ6ñˆÊ"W66ˆ∆¬ˆ'WGFˆ„‡–¢¬ˆFóc‡–¢∆Fób6∆73“&fñ«FW'2#‡–¢∆Fób6∆73“&fñV∆B"7Gñ∆S“&÷ñ‚◊vñGFÉ£##Ç#„∆∆&V√Â&˜F¬ˆ∆&V√„«6V∆V7BñC“'&˜WFR÷fñ«FW"#„∆˜Fñˆ‚f«VS“'FˆF2#ÂFˆF3¬ˆ˜Fñˆ„‚G∑&˜WFW2ÇíÊ÷á&˜WFR”‚∆˜Fñˆ‚G∑7FFRÁ&˜WFTfñ«FW"””“&˜WFRÚ'6V∆V7FVB"¢"'”‚G∑&˜WFW”¬ˆ˜Fñˆ„ÊíÊ¶ˆñ‚Ç""ó”¬˜6V∆V7C„¬ˆFóc‡–¢¬ˆFóc‡–¢G∂76ñvÊ÷VÁEF&∆RÇó––¢«6∆73“'7FGW2÷∆ñÊR#‚G∑7FFRÊ÷W76vW”¬˜‡–¢¬˜6V7Fñˆ„‡–¢ì∞–¢BÇ"6FB◊W6W""íÊFDWfVÁD∆ó7FVÊW"Ç&6∆ñ6≤"¬Çí”‚∞–¢7FFRÊF"ÁW6W'2ÁW6Çá≤ñC¢VñBÇ'W6W""í¬Ê÷S¢$Ê˜fÁWG&ñ6ñˆÊó7F"¬W6W&Ê÷S¢ÁWG&íG∂ÁWG&óFñˆÊó7G2ÇíÊ∆VÊwFÇ≤÷¬77v˜&C¢""¬&ˆ∆S¢&ÁWG&óFñˆÊó7B"¬7FófS¢G'VR“ì∞–¢6fTF"Ç$ÁWG&ñ6ñˆÊó7F7&ñF‚"ì∞–¢“ì∞–¢BÇ"6FB◊66Üˆˆ¬"íÊFDWfVÁD∆ó7FVÊW"Ç&6∆ñ6≤"¬Çí”‚∞–¢6ˆÁ7BÊWáE&˜r“÷FÇÊ÷ÇÉ¬‚‚Á7FFRÊF"Á66Üˆˆ«2Ê÷á66Üˆˆ¬”‚ÁV÷&W"á66Üˆˆ¬Á&˜rí«¬íí≤∞–¢6ˆÁ7Bfó'7DÁWG&óFñˆÊó7B“ÁWG&óFñˆÊó7G2Çï≥”ÚÊñB«¬"#∞–¢6ˆÁ7B&˜WFR“7FFRÁ&˜WFTfñ«FW"”“'FˆF2"Ú7FFRÁ&˜WFTfñ«FW"¢&˜WFT˜FñˆÁ2Çï≥“«¬$u$R4TÂE$Ú#∞–¢6ˆÁ7B66Üˆˆ¬“∞–¢ñC¢VñBÇ'66Üˆˆ¬"í¿–¢&˜s¢ÊWáE&˜r¿–¢Ê÷S¢Ê˜fW66ˆ∆G∂ÊWáE&˜w÷¿–¢6Ü˜'DÊ÷S¢Ê˜fW66ˆ∆G∂ÊWáE&˜w÷¿–¢&˜WFR¿–¢6ˆ◊Áì¢""¿–¢FG&W73¢""¿–¢7FófS¢G'VR¿–¢ÁWG&óFñˆÊó7DñG3¢fó'7DÁWG&óFñˆÊó7BÚ∂fó'7DÁWG&óFñˆÊó7E“¢µ––¢”∞–¢7FFRÊF"Á66Üˆˆ«2ÁW6Çá66Üˆˆ¬ì∞–¢6fTF"Ç$W66ˆ∆7&ñF‚ßW7FRÊˆ÷R¬&˜FRÁWG&ñ6ñˆÊó7FÊF&V∆‚"ì∞–¢“ì∞–¢Fˆ7V÷VÁBÁVW'ï6V∆V7F˜$∆¬Ç%∂FF◊W6W"÷fñV∆E“"íÊf˜$V6ÇÜñÁWB”‚∞–¢ñÁWBÊFDWfVÁD∆ó7FVÊW"Ç&6ÜÊvR"¬WfVÁB”‚∞–¢6ˆÁ7BW6W"“7FFRÊF"ÁW6W'2ÊfñÊBÜóFV“”‚óFV“ÊñB””“WfVÁBÁF&vWBÊFF6WBÁW6W"ì∞–¢W6W%∂WfVÁBÁF&vWBÊFF6WBÁW6W$fñV∆E““WfVÁBÁF&vWBÁf«VS∞–¢6fTF"Ç$FF˜2FÁWG&ñ6ñˆÊó7FGV∆ó¶F˜2‚"ì∞–¢“ì∞–¢“ì∞–¢Fˆ7V÷VÁBÁVW'ï6V∆V7F˜$∆¬Ç%∂FF÷FV∆WFR◊W6W%“"íÊf˜$V6ÇÜ'WGFˆ‚”‚∞–¢'WGFˆ‚ÊFDWfVÁD∆ó7FVÊW"Ç&6∆ñ6≤"¬Çí”‚∞–¢6ˆÁ7BñB“'WGFˆ‚ÊFF6WBÊFV∆WFUW6W#∞–¢7FFRÊF"ÁW6W'2ÊfñÊBáW6W"”‚W6W"ÊñB””“ñBíÊ7FófR“f«6S∞–¢7FFRÊF"Á66Üˆˆ«2Êf˜$V6Çá66Üˆˆ¬”‚á66Üˆˆ¬ÊÁWG&óFñˆÊó7DñG2“66Üˆˆ¬ÊÁWG&óFñˆÊó7DñG2Êfñ«FW"ÜóFV“”‚óFV“”“ñBííì∞–¢6fTF"Ç$ÁWG&ñ6ñˆÊó7FFW6FófF‚"ì∞–¢“ì∞–¢“ì∞–¢BÇ"7&˜WFR÷fñ«FW""íÊFDWfVÁD∆ó7FVÊW"Ç&6ÜÊvR"¬WfVÁB”‚∞–¢7FFRÁ&˜WFTfñ«FW"“WfVÁBÁF&vWBÁf«VS∞–¢&VÊFW"Çì∞–¢“ì∞–¢Fˆ7V÷VÁBÁVW'ï6V∆V7F˜$∆¬Ç%∂FF◊66Üˆˆ¬÷fñV∆E“"íÊf˜$V6ÇÜñÁWB”‚∞–¢ñÁWBÊFDWfVÁD∆ó7FVÊW"Ç&6ÜÊvR"¬WfVÁB”‚∞–¢6ˆÁ7B66Üˆˆ¬“7FFRÊF"Á66Üˆˆ«2ÊfñÊBÜóFV“”‚óFV“ÊñB””“WfVÁBÁF&vWBÊFF6WBÁ66Üˆˆ¬ì∞–¢6ˆÁ7Bf«VR“WfVÁBÁF&vWBÁf«VRÁG&ñ“Çì∞–¢66Üˆˆ≈∂WfVÁBÁF&vWBÊFF6WBÁ66ÜˆˆƒfñV∆E““f«VS∞–¢ñbÜWfVÁBÁF&vWBÊFF6WBÁ66ÜˆˆƒfñV∆B””“'6Ü˜'DÊ÷R"í66Üˆˆ¬ÊÊ÷R“f«VS∞–¢6fTF"Ç$W66ˆ∆GV∆ó¶F‚"ì∞–¢“ì∞–¢“ì∞–¢Fˆ7V÷VÁBÁVW'ï6V∆V7F˜$∆¬Ç%∂FF◊66Üˆˆ¬◊&˜WFU“"íÊf˜$V6Çá6V∆V7B”‚∞–¢6V∆V7BÊFDWfVÁD∆ó7FVÊW"Ç&6ÜÊvR"¬WfVÁB”‚∞–¢6ˆÁ7B66Üˆˆ¬“7FFRÊF"Á66Üˆˆ«2ÊfñÊBÜóFV“”‚óFV“ÊñB””“WfVÁBÁF&vWBÊFF6WBÁ66Üˆˆ≈&˜WFRì∞–¢66Üˆˆ¬Á&˜WFR“WfVÁBÁF&vWBÁf«VS∞–¢6fTF"Ç%&˜FFW66ˆ∆GV∆ó¶F‚"ì∞–¢“ì∞–¢“ì∞–¢Fˆ7V÷VÁBÁVW'ï6V∆V7F˜$∆¬Ç%∂FF◊66Üˆˆ¬÷ÁWG&óFñˆÊó7E“"íÊf˜$V6Çá6V∆V7B”‚∞–¢6V∆V7BÊFDWfVÁD∆ó7FVÊW"Ç&6ÜÊvR"¬WfVÁB”‚∞–¢6ˆÁ7B66Üˆˆ¬“7FFRÊF"Á66Üˆˆ«2ÊfñÊBÜóFV“”‚óFV“ÊñB””“WfVÁBÁF&vWBÊFF6WBÁ66ÜˆˆƒÁWG&óFñˆÊó7Bì∞–¢66Üˆˆ¬ÊÁWG&óFñˆÊó7DñG2“WfVÁBÁF&vWBÁf«VRÚ∂WfVÁBÁF&vWBÁf«VU“¢µ”∞–¢6fTF"Ç%l:÷Ê7V∆ÚGV∆ó¶FÚ‚"ì∞–¢“ì∞–¢“ì∞–ß––†–¶gVÊ7Fñˆ‚W6W%&˜ráW6W"í∞–¢6ˆÁ7B6˜VÁB“7FFRÊF"Á66Üˆˆ«2Êfñ«FW"á66Üˆˆ¬”‚66Üˆˆ¬ÊÁWG&óFñˆÊó7DñG2ÊñÊ6«VFW2áW6W"ÊñBííÊ∆VÊwFÉ∞–¢&WGW&‚ –¢«G#‡–¢«FC„∆ñÁWBFF◊W6W#“"G∑W6W"ÊñG“"FF◊W6W"÷fñV∆C“&Ê÷R"f«VS“"G∑W6W"ÊÊ÷W“"Û„¬˜FC‡–¢«FC„∆ñÁWBFF◊W6W#“"G∑W6W"ÊñG“"FF◊W6W"÷fñV∆C“'W6W&Ê÷R"f«VS“"G∑W6W"ÁW6W&Ê÷W“"Û„¬˜FC‡–¢«FC„∆ñÁWBFF◊W6W#“"G∑W6W"ÊñG“"FF◊W6W"÷fñV∆C“'77v˜&B"f«VS“"G∑W6W"Á77v˜&G“"Û„¬˜FC‡–¢«FC‚G∂6˜VÁG”¬˜FC‡–¢«FC„∆'WGFˆ‚6∆73“&FÊvW""FF÷FV∆WFR◊W6W#“"G∑W6W"ÊñG“#‰FW6Fóf#¬ˆ'WGFˆ„„¬˜FC‡–¢¬˜G#‡–¢∞–ß––†–¶gVÊ7Fñˆ‚76ñvÊ÷VÁEF&∆RÇí∞–¢∆WB66Üˆˆ«2“7FFRÊF"Á66Üˆˆ«3∞–¢ñbá7FFRÁ&˜WFTfñ«FW"”“'FˆF2"í66Üˆˆ«2“66Üˆˆ«2Êfñ«FW"á66Üˆˆ¬”‚66Üˆˆ¬Á&˜WFR””“7FFRÁ&˜WFTfñ«FW"ì∞–¢6ˆÁ7B&˜WFT6Üˆñ6W2“&˜WFT˜FñˆÁ2Çì∞–¢6ˆÁ7BÁWG&óFñˆÊó7D6Üˆñ6W2“ÁWG&óFñˆÊó7G2Çì∞–¢&WGW&‚ –¢∆Fób6∆73“'F&∆R◊w&#‡–¢«F&∆R6∆73“&6ˆÊfñr◊66Üˆˆ¬◊F&∆R#‡–¢«FÜVC„«G#„«FÉ‰W66ˆ∆¬˜FÉ„«FÉÂ&˜F¬˜FÉ„«FÉ‰ÁWG&ñ6ñˆÊó7F¬˜FÉ„¬˜G#„¬˜FÜVC‡–¢«F&ˆGì‡–¢G∑66Üˆˆ«2Ê÷á66Üˆˆ¬”‚∞–¢6ˆÁ7B6V∆V7FVDÁWG&óFñˆÊó7B“66Üˆˆ¬ÊÁWG&óFñˆÊó7DñG3ÚÂ≥“«¬"#∞–¢&WGW&‚ –¢«G#‡–¢«FC‡–¢∆ñÁW@–¢FF◊66Üˆˆ√“"G∑66Üˆˆ¬ÊñG“ –¢FF◊66Üˆˆ¬÷fñV∆C“'6Ü˜'DÊ÷R –¢f«VS“"G∑66Üˆˆ¬Á6Ü˜'DÊ÷R«¬66Üˆˆ¬ÊÊ÷R«¬"'“ –¢&ñ÷∆&V√“$Êˆ÷RFW66ˆ∆ –¢Û‡–¢¬˜FC‡–¢«FC‡–¢«6V∆V7BFF◊66Üˆˆ¬◊&˜WFS“"G∑66Üˆˆ¬ÊñG“"&ñ÷∆&V√“%&˜FFW66ˆ∆#‡–¢G∑&˜WFT6Üˆñ6W2Ê÷á&˜WFR”‚ –¢∆˜Fñˆ‚f«VS“"G∑&˜WFW“"G∑66Üˆˆ¬Á&˜WFR””“&˜WFRÚ'6V∆V7FVB"¢"'”‚G∑&˜WFW”¬ˆ˜Fñˆ„‡–¢íÊ¶ˆñ‚Ç""ó––¢¬˜6V∆V7C‡–¢¬˜FC‡–¢«FC‡–¢«6V∆V7BFF◊66Üˆˆ¬÷ÁWG&óFñˆÊó7C“"G∑66Üˆˆ¬ÊñG“"&ñ÷∆&V√“$ÁWG&ñ6ñˆÊó7F&W7ˆÁ6fV¬#‡–¢∆˜Fñˆ‚f«VS“"#Â6V“&W7ˆÁ6fV√¬ˆ˜Fñˆ„‡–¢G∂ÁWG&óFñˆÊó7D6Üˆñ6W2Ê÷áW6W"”‚ –¢∆˜Fñˆ‚f«VS“"G∑W6W"ÊñG“"G∑6V∆V7FVDÁWG&óFñˆÊó7B””“W6W"ÊñBÚ'6V∆V7FVB"¢"'”‚G∑W6W"ÊÊ÷W”¬ˆ˜Fñˆ„‡–¢íÊ¶ˆñ‚Ç""ó––¢¬˜6V∆V7C‡–¢¬˜FC‡–¢¬˜G#‡–¢∞–¢“íÊ¶ˆñ‚Ç""ó––¢¬˜F&ˆGì‡–¢¬˜F&∆S‡–¢¬ˆFóc‡–¢∞–ß––†–¶gVÊ7Fñˆ‚&VÊFW$Wá˜'BÇí∞–¢6ÜV∆¬Ü –¢∆Fób6∆73“'F˜&"#‡–¢∆Fób6∆73“'vR◊FóF∆R#„∆É‰Wá˜'F:|:6Û¬ˆÉ„«‰vW&RV÷;¶Êñ6∆Êñ∆Ü6ˆÁ6ˆ∆ñFF&6ˆ˜&FVÊ:|:6Ú„¬˜„¬ˆFóc‡–¢¬ˆFóc‡–¢«6V7Fñˆ‚6∆73“'ÊV¬#‡–¢∆Fób6∆73“'Fˆˆ∆&"#‡–¢∆Fób6∆73“&fñV∆B"7Gñ∆S“&÷ñ‚◊vñGFÉ¢ÉÇ#„∆∆&V√‰‹:ß3¬ˆ∆&V√„∆ñÁWBñC“&÷ˆÁFÇ"GóS“&÷ˆÁFÇ"f«VS“"G∑7FFRÁ6V∆V7FVD÷ˆÁFá“"Û„¬ˆFóc‡–¢∆'WGFˆ‚6∆73“'&ñ÷'í"ñC“&Wá˜'B#‰vW&"WÜ6V¬6ˆÁ6ˆ∆ñFFÛ¬ˆ'WGFˆ„‡–¢¬ˆFóc‡–¢«6∆73“'7FGW2÷∆ñÊR#‚G∑7FFRÊ÷W76vW”¬˜‡–¢¬˜6V7Fñˆ„‡–¢«6V7Fñˆ‚6∆73“'ÊV¬#‡–¢∆É#‰Wá˜'F:|;VW2&V6VÁFW3¬ˆÉ#‡–¢∆Fób6∆73“'F&∆R◊w&#‡–¢«F&∆S‡–¢«FÜVC„«G#„«FÉ‰‹:ß3¬˜FÉ„«FÉ‰'VófÛ¬˜FÉ„«FÉ‰7&ñFÚV”¬˜FÉ„¬˜G#„¬˜FÜVC‡–¢«F&ˆGì‚G≤á7FFRÊF"ÊWá˜'G2«¬µ“íÁ6∆ñ6RÇíÁ&WfW'6RÇíÊ÷ÜóFV“”‚«G#„«FC‚G∂óFV“Ê÷ˆÁFá”¬˜FC„«FC„∆á&Vc“"ˆWá˜'G2ÚG∂óFV“Êfñ∆VÊ÷W“#‚G∂óFV“Êfñ∆VÊ÷W”¬ˆ„¬˜FC„«FC‚G∂óFV“Ê7&VFVDG”¬˜FC„¬˜G#ÊíÊ¶ˆñ‚Ç""í«¬«G#„«FB6ˆ«7„“#2#‰ÊVÊáV÷Wá˜'F:|:6ÚvW&F„¬˜FC„¬˜G#Ê”¬˜F&ˆGì‡–¢¬˜F&∆S‡–¢¬ˆFóc‡–¢¬˜6V7Fñˆ„‡–¢ì∞–¢BÇ"6÷ˆÁFÇ"íÊFDWfVÁD∆ó7FVÊW"Ç&6ÜÊvR"¬WfVÁB”‚∞–¢7FFRÁ6V∆V7FVD÷ˆÁFÇ“WfVÁBÁF&vWBÁf«VS∞–¢7FFRÊ÷W76vR“"#∞–¢&VÊFW$Wá˜'BÇì∞–¢“ì∞–¢BÇ"6Wá˜'B"íÊFDWfVÁD∆ó7FVÊW"Ç&6∆ñ6≤"¬7ñÊ2Çí”‚∞–¢6ˆÁ7B÷ˆÁFÇ“BÇ"6÷ˆÁFÇ"íÁf«VS∞–¢7FFRÁ6V∆V7FVD÷ˆÁFÇ“÷ˆÁFÉ∞–¢7FFRÊ÷W76vR“vW&ÊFÚ∆Êñ∆ÜFRG∂÷ˆÁFá“‚‚Ê∞–¢&VÊFW$Wá˜'BÇì∞–¢G'í∞–¢6ˆÁ7B&W7V«B“vóBíÇ"ˆíˆWá˜'B"¬≤÷WFÜˆC¢%ı5B"¬&ˆGì¢≤÷ˆÁFÇ““ì∞–¢ñbá&W7V«BÊ&6ScBíF˜vÊ∆ˆD&6ScDfñ∆Rá&W7V«Bì∞–¢7FFRÊF"“vóBíÇ"ˆíˆFF"ì∞–¢7FFRÁ6V∆V7FVD÷ˆÁFÇ“÷ˆÁFÉ∞–¢7FFRÊ÷W76vR“∆Êñ∆ÜFRG∂÷ˆÁFá“vW&F¢G∑&W7V«BÊfñ∆VÊ÷W÷∞–¢&VÊFW$Wá˜'BÇì∞–¢“6F6ÇÜW'&˜"í∞–¢7FFRÊ÷W76vR“W'&˜"Ê÷W76vS∞–¢&VÊFW$Wá˜'BÇì∞–¢––¢“ì∞–ß––†–¶gVÊ7Fñˆ‚&VÊFW"Çí∞–¢ñbá7FFRÁfñWr”“&F6Ü&ˆ&B"bb7FFRÊF÷ñÂ&Vg&W6ÖFñ÷W"í∞–¢6∆V$ñÁFW'f¬á7FFRÊF÷ñÂ&Vg&W6ÖFñ÷W"ì∞–¢7FFRÊF÷ñÂ&Vg&W6ÖFñ÷W"“ÁV∆√∞–¢––¢ñbÇ7FFRÁW6W"í&WGW&‚&VÊFW$∆ˆvñ‚Çì∞–¢ñbá7FFRÁfñWr””“&∆Ê6÷VÁF˜2"í&WGW&‚&VÊFW$ÁWG&óFñˆÊó7Df˜&“Çì∞–¢ñbá7FFRÁfñWr””“&÷WR÷÷W2"í&WGW&‚&VÊFW$◊î÷ˆÁFÇÇì∞–¢ñbá7FFRÁfñWr””“&F6Ü&ˆ&B"í&WGW&‚&VÊFW$F6Ü&ˆ&BÇì∞–¢ñbá7FFRÁfñWr””“&6ˆÊfñr"í&WGW&‚&VÊFW$6ˆÊfñrÇì∞–¢ñbá7FFRÁfñWr””“&Wá˜'F""í&WGW&‚&VÊFW$Wá˜'BÇì∞–ß––†–¶gVÊ7Fñˆ‚∆Vv7îñÊóFñƒ∆ˆDFó6&∆VBÇí∞–¢ñbá7FFRÁ6W76ñˆÂFˆ∂V‚bbó57FFñ4÷ˆFRÇíí∞–¢&WGW&‚∆ˆDFFÇê–¢ÁFÜV‚ÇÇí”‚∞–¢7FFRÁW6W"“7FFRÊF"Ê7W'&VÁEW6W"«¬7FFRÊF"ÁW6W'5≥“«¬ÁV∆√∞–¢7FFRÁfñWr“7FFRÁW6W#ÚÁ&ˆ∆R””“&F÷ñ‚"Ú&F6Ü&ˆ&B"¢&∆Ê6÷VÁF˜2#∞–¢&VÊFW"Çì∞–¢“ê–¢Ê6F6ÇÇÇí”‚∞–¢7FFRÁ6W76ñˆÂFˆ∂V‚“"#∞–¢∆ˆ6≈7F˜&vRÁ&V÷˜fTóFV“ÜWFÖ7F˜&vT∂WíÇíì∞–¢&VÊFW$∆ˆvñ‚Çì∞–¢“ì∞–¢––¢ñbÜó57FFñ4÷ˆFRÇíí∞–¢&WGW&‚∆ˆDFFÇíÁFÜV‚ÇÇí”‚&VÊFW$∆ˆvñ‚Çíì∞–¢––¢&VÊFW$∆ˆvñ‚Çì∞–¢&WGW&‚&ˆ÷ó6RÁ&W6ˆ«fRÇì∞–ß––†–¶∆Vv7îñÊóFñƒ∆ˆDFó6&∆VBÇì∞