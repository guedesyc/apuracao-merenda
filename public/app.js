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
  sessionToken: localStorage.getItem("apuracao-session-token") || "",
  message: ""
};

let staticDbCache = null;

const $ = selector => document.querySelector(selector);
const app = $("#app");

function isStaticMode() {
  return location.hostname.endsWith("github.io") || location.protocol === "file:";
}

function money(value) {
  return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
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
  const stored = localStorage.getItem("apuracao-comandas-db");
  if (stored) {
    staticDbCache = JSON.parse(stored);
    return staticDbCache;
  }
  const response = await fetch("demo-data.json", { cache: "no-store" });
  staticDbCache = await response.json();
  localStorage.setItem("apuracao-comandas-db", JSON.stringify(staticDbCache));
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
    localStorage.setItem("apuracao-comandas-db", JSON.stringify(staticDbCache));
    return { ok: true };
  }

  if (path === "/api/export") {
    throw new Error("A exportacao Excel real precisa da versao com servidor local.");
  }

  throw new Error("Rota nao encontrada.");
}

async function saveDb(message = "Salvo.") {
  await api("/api/save", { method: "POST", body: state.db });
  state.db = await api("/api/data");
  state.message = message;
  render();
}

async function loadData() {
  state.db = await api("/api/data");
  state.selectedMonth = state.db.settings.currentMonth;
}

function renderLogin(error = "") {
  app.innerHTML = `
    <main class="login-screen">
      <form class="login-card" id="login-form">
        <h1>Apuração de Comandas</h1>
        <p>Entre para lançar refeições, acompanhar pendências ou exportar a consolidação mensal.</p>
        <div class="field">
          <label for="username">Usuário</label>
          <input id="username" autocomplete="username" value="admin" />
        </div>
        <div class="field">
          <label for="password">Senha</label>
          <input id="password" type="password" autocomplete="current-password" value="admin" />
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
      if (state.sessionToken) localStorage.setItem("apuracao-session-token", state.sessionToken);
      state.user = result.user;
      state.db = await api("/api/data");
      state.selectedMonth = state.db.settings.currentMonth;
      state.view = state.user.role === "admin" ? "dashboard" : "lancamentos";
      render();
    } catch (err) {
      renderLogin(err.message);
    }
  });
}

function shell(content) {
  const isAdmin = state.user.role === "admin";
  const items = isAdmin
    ? [["dashboard", "Painel"], ["config", "Configurações"], ["exportar", "Exportar"]]
    : [["lancamentos", "Lançamentos"], ["meu-mes", "Meu mês"]];
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <strong>Comandas</strong>
          <span>Controle de refeições</span>
        </div>
        <nav class="nav">
          ${items.map(([id, label]) => `<button data-view="${id}" class="${state.view === id ? "active" : ""}">${label}</button>`).join("")}
        </nav>
        <div class="user-box">
          <strong>${state.user.name}</strong>
          <span>${isAdmin ? "Coordenação" : "Nutricionista"}</span>
          <button id="logout">Sair</button>
        </div>
      </aside>
      <main class="content">${content}</main>
    </div>
  `;
  document.querySelectorAll("[data-view]").forEach(button => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      state.message = "";
      render();
    });
  });
  $("#logout").addEventListener("click", () => {
    state.user = null;
    state.sessionToken = "";
    localStorage.removeItem("apuracao-session-token");
    renderLogin();
  });
}

function entryKey(date, schoolId, nutritionistId = state.user.id) {
  return state.db.entries.find(entry => entry.date === date && entry.schoolId === schoolId && entry.nutritionistId === nutritionistId);
}

function cardPreferenceKey(schoolId, nutritionistId = state.user.id) {
  return `${nutritionistId}:${schoolId}`;
}

function selectedCardPreference(schoolId) {
  return state.db.settings?.cardPreferences?.[cardPreferenceKey(schoolId)] || [];
}

function saveCardPreference(schoolId, quantities) {
  state.db.settings = state.db.settings || {};
  state.db.settings.cardPreferences = state.db.settings.cardPreferences || {};
  state.db.settings.cardPreferences[cardPreferenceKey(schoolId)] = Object.keys(quantities || {});
}

function defaultQuantitiesForSchool(schoolId) {
  return Object.fromEntries(selectedCardPreference(schoolId).map(cardId => [cardId, ""]));
}

function dateStateKey(schoolId, date) {
  return `${schoolId}:${date}`;
}

function quantitiesTotal(quantities = {}) {
  return Object.entries(quantities).reduce((sum, [cardId, qty]) => {
    const card = state.db.cards.find(item => item.id === cardId);
    return sum + quantityNumber(qty) * Number(card?.price || 0);
  }, 0);
}

function filledCardLines(entry) {
  return Object.entries(entry?.quantities || {})
    .map(([cardId, qty]) => {
      const card = state.db.cards.find(item => item.id === cardId);
      return { label: card?.label || cardId, qty, price: Number(card?.price || 0) };
    })
    .filter(item => item.qty !== "" && item.qty !== null && item.qty !== undefined);
}

function monthCompletionStatus(userId = state.user.id, month = state.selectedMonth) {
  const schools = assignedSchools(userId);
  const dates = businessDates(month);
  const expected = schools.length * dates.length;
  let complete = 0;
  schools.forEach(school => {
    dates.forEach(date => {
      if (isCompleteEntry(entryKey(date, school.id, userId))) complete += 1;
    });
  });
  return { schools, dates, expected, complete, pending: Math.max(expected - complete, 0) };
}

function upsertClosure(month, status, extra = {}) {
  const existing = state.db.closures.find(item => item.month === month && item.nutritionistId === state.user.id);
  const patch = {
    month,
    nutritionistId: state.user.id,
    nutritionistName: state.user.name,
    status,
    updatedAt: new Date().toISOString(),
    ...extra
  };
  if (status === "partial") patch.partialAt = new Date().toISOString();
  if (status === "sent") patch.sentAt = new Date().toISOString();
  if (existing) Object.assign(existing, patch);
  else state.db.closures.push({ id: uid("closure"), ...patch });
}

function schoolMonthTotal(schoolId, userId = state.user.id, month = state.selectedMonth) {
  return completeEntriesFor({ month, userId, schoolId }).reduce((sum, entry) => sum + quantitiesTotal(entry.quantities), 0);
}

function upsertEntry(schoolId, patch, date = state.selectedDate) {
  let entry = entryKey(date, schoolId);
  if (!entry) {
    entry = {
      id: uid("entry"),
      date,
      month: date.slice(0, 7),
      schoolId,
      nutritionistId: state.user.id,
      nutritionistName: state.user.name,
      status: "served",
      reason: "",
      notes: "",
      quantities: defaultQuantitiesForSchool(schoolId),
      updatedAt: new Date().toISOString()
    };
    state.db.entries.push(entry);
  }
  Object.assign(entry, patch, { updatedAt: new Date().toISOString() });
}

function renderNutritionistForm() {
  const schools = assignedSchools();
  const monthDates = businessDates();
  const completion = monthCompletionStatus();
  const filled = completion.complete;
  const expected = completion.expected;
  const cards = state.db.cards;
  shell(`
    <div class="topbar">
      <div class="page-title">
        <h1>Lan&ccedil;amentos</h1>
        <p>${schools.length} escolas sob sua responsabilidade.</p>
      </div>
      <div class="field" style="min-width: 220px">
        <label>M&ecirc;s</label>
        <input id="month" type="month" value="${state.selectedMonth}" />
      </div>
    </div>
    <section class="grid cols-3">
      <div class="metric"><strong>${schools.length}</strong><span>Escolas vinculadas</span></div>
      <div class="metric"><strong>${filled}</strong><span>Registros no m&ecirc;s</span></div>
      <div class="metric"><strong>${Math.max(expected - filled, 0)}</strong><span>Pendentes no m&ecirc;s</span></div>
    </section>
    <div class="toolbar">
      <button class="secondary" id="save-partial">Encerrar Parcialmente</button>
      <button class="secondary" id="send-test">Envio Teste</button>
      <button class="primary" id="send-final" ${completion.pending ? "disabled" : ""}>Encerrar e Enviar para Coordena&ccedil;&atilde;o</button>
      <span class="status-line">${state.message}</span>
    </div>
    <section class="school-list">
      ${schools.map(school => schoolCard(school, cards, monthDates)).join("") || `<div class="empty">Nenhuma escola vinculada ao seu usu&aacute;rio.</div>`}
    </section>
  `);
  $("#month").addEventListener("change", event => {
    state.selectedMonth = event.target.value;
    state.selectedDate = `${event.target.value}-01`;
    render();
  });
  document.querySelectorAll("[data-school-toggle]").forEach(button => {
    button.addEventListener("click", event => {
      const schoolId = event.currentTarget.dataset.schoolToggle;
      if (state.expandedSchools.has(schoolId)) state.expandedSchools.delete(schoolId);
      else state.expandedSchools.add(schoolId);
      render();
    });
  });
  document.querySelectorAll("[data-date-toggle]").forEach(button => {
    button.addEventListener("click", event => {
      const key = event.currentTarget.dataset.dateToggle;
      if (state.expandedLaunchDates.has(key)) state.expandedLaunchDates.delete(key);
      else state.expandedLaunchDates.add(key);
      render();
    });
  });
  document.querySelectorAll("[data-card-toggle]").forEach(input => {
    input.addEventListener("change", event => {
      const { school, card, date } = event.target.dataset;
      const entry = entryKey(date, school);
      const quantities = { ...(entry?.quantities || defaultQuantitiesForSchool(school)) };
      if (event.target.checked) quantities[card] = quantities[card] ?? "";
      else delete quantities[card];
      upsertEntry(school, { status: "served", quantities }, date);
      saveCardPreference(school, quantities);
      pruneEntryIfEmpty(entryKey(date, school));
      render();
    });
  });
  document.querySelectorAll("[data-qty]").forEach(input => {
    input.addEventListener("input", event => {
      const { school, card, date } = event.target.dataset;
      const entry = entryKey(date, school);
      const quantities = { ...(entry?.quantities || defaultQuantitiesForSchool(school)) };
      quantities[card] = parseQuantity(event.target.value);
      upsertEntry(school, { status: "served", quantities }, date);
    });
  });
  document.querySelectorAll("[data-reason]").forEach(select => {
    select.addEventListener("change", event => {
      const { school, date } = event.target.dataset;
      upsertEntry(school, { status: event.target.value ? "not_served" : "served", reason: event.target.value, quantities: event.target.value ? {} : entryKey(date, school)?.quantities || defaultQuantitiesForSchool(school) }, date);
      pruneEntryIfEmpty(entryKey(date, school));
      render();
    });
  });
  document.querySelectorAll("[data-notes]").forEach(textarea => {
    textarea.addEventListener("change", event => {
      const { school, date } = event.target.dataset;
      upsertEntry(school, { notes: event.target.value }, date);
    });
  });
  $("#save-partial").addEventListener("click", async () => {
    upsertClosure(state.selectedMonth, "partial", { expected: completion.expected, complete: completion.complete, pending: completion.pending });
    await saveDb("Parcial registrada e salva.");
  });
  $("#send-test").addEventListener("click", async () => {
    upsertClosure(state.selectedMonth, "sent", { test: true, expected: completion.expected, complete: completion.complete, pending: completion.pending });
    await saveDb("Envio teste registrado para coordena&ccedil;&atilde;o.");
  });
  $("#send-final").addEventListener("click", async () => {
    const latest = monthCompletionStatus();
    if (latest.pending > 0) {
      state.message = `Ainda existem ${latest.pending} pend&ecirc;ncias. Preencha todas as datas de todas as escolas antes de enviar.`;
      renderNutritionistForm();
      return;
    }
    upsertClosure(state.selectedMonth, "sent", { test: false, expected: latest.expected, complete: latest.complete, pending: 0 });
    await saveDb("M&ecirc;s enviado para coordena&ccedil;&atilde;o.");
  });
}

function schoolCard(school, cards, dates) {
  const collapsed = !state.expandedSchools.has(school.id);
  const schoolEntries = completeEntriesFor({ month: state.selectedMonth, userId: state.user.id, schoolId: school.id });
  const pending = Math.max(dates.length - schoolEntries.length, 0);
  return `
    <article class="school-card ${collapsed ? "collapsed" : ""}">
      <button class="school-toggle" type="button" data-school-toggle="${school.id}" aria-expanded="${!collapsed}">
        <div>
          <h3>${school.shortName}</h3>
          <p class="muted">${school.route}${school.address ? ` &bull; ${school.address}` : ""}</p>
        </div>
        <div class="school-status">
          <span class="badge done">${schoolEntries.length} registradas</span>
          <span class="badge ${pending ? "warn" : "done"}">${pending} pendentes</span>
          <span class="chevron">${collapsed ? "+" : "-"}</span>
        </div>
      </button>
      ${collapsed ? "" : `<div class="date-list">${dates.map(date => dateCard(school, cards, date)).join("")}</div>`}
    </article>
  `;
}

function dateCard(school, cards, date) {
  const entry = entryKey(date, school.id);
  const quantities = entry?.quantities || defaultQuantitiesForSchool(school.id);
  const isNotServed = entry?.status === "not_served";
  const complete = isCompleteEntry(entry);
  const total = quantitiesTotal(quantities);
  const key = dateStateKey(school.id, date);
  const expanded = state.expandedLaunchDates.has(key);
  return `
    <article class="date-card ${expanded ? "" : "collapsed"}">
      <button class="date-toggle" type="button" data-date-toggle="${key}" aria-expanded="${expanded}">
        <strong>${formatDateBR(date)}</strong>
        <div class="date-summary">
          <span class="badge ${complete ? "done" : "warn"}">${complete ? "registrada" : "pendente"}</span>
          <span class="muted">${complete ? money(total) : ""}</span>
          <span class="chevron">${expanded ? "-" : "+"}</span>
        </div>
      </button>
      ${expanded ? `
        <div class="field">
          <label>Motivo sem atendimento</label>
          <select data-reason data-school="${school.id}" data-date="${date}">
            <option value="">Teve atendimento</option>
            ${state.db.settings.reasons.map(reason => `<option ${entry?.reason === reason ? "selected" : ""}>${reason}</option>`).join("")}
          </select>
        </div>
        ${isNotServed ? "" : `
          <div class="card-selector">
            ${cards.map(card => `
              <label class="check-pill">
                <input type="checkbox" data-card-toggle data-school="${school.id}" data-date="${date}" data-card="${card.id}" ${quantities[card.id] !== undefined ? "checked" : ""} />
                ${card.label}
              </label>
            `).join("")}
          </div>
          <div class="qty-grid">
            ${cards.filter(card => quantities[card.id] !== undefined).map(card => `
              <div class="field">
                <label>${card.label} &bull; ${money(card.price)}</label>
                <input type="text" inputmode="numeric" placeholder="Quantidade" data-qty data-school="${school.id}" data-date="${date}" data-card="${card.id}" value="${quantities[card.id]}" />
              </div>
            `).join("")}
          </div>
        `}
        <div class="field">
          <label>Observa&ccedil;&atilde;o</label>
          <textarea data-notes data-school="${school.id}" data-date="${date}">${entry?.notes || ""}</textarea>
        </div>
        <strong>Total do dia: ${money(total)}</strong>
      ` : ""}
    </article>
  `;
}
function renderMyMonth() {
  const schools = assignedSchools();
  const monthDates = businessDates();
  const monthEntries = completeEntriesFor({ month: state.selectedMonth, userId: state.user.id });
  shell(`
    <div class="topbar">
      <div class="page-title"><h1>Meu m&ecirc;s</h1><p>Acompanhamento do preenchimento da compet&ecirc;ncia.</p></div>
      <div class="field" style="min-width: 180px"><label>M&ecirc;s</label><input id="month" type="month" value="${state.selectedMonth}" /></div>
    </div>
    <section class="grid cols-3">
      <div class="metric"><strong>${monthEntries.length}</strong><span>Registros no m&ecirc;s</span></div>
      <div class="metric"><strong>${new Set(monthEntries.map(e => e.schoolId)).size}</strong><span>Escolas com algum lan&ccedil;amento</span></div>
      <div class="metric"><strong>${schools.length}</strong><span>Escolas vinculadas</span></div>
    </section>
    ${schoolTotalSummary(schools)}
    ${myMonthBySchool(schools, monthDates)}
  `);
  $("#month").addEventListener("change", event => {
    state.selectedMonth = event.target.value;
    render();
  });
  document.querySelectorAll("[data-month-school-toggle]").forEach(button => {
    button.addEventListener("click", event => {
      const schoolId = event.currentTarget.dataset.monthSchoolToggle;
      if (state.expandedMonthSchools.has(schoolId)) state.expandedMonthSchools.delete(schoolId);
      else state.expandedMonthSchools.add(schoolId);
      render();
    });
  });
  document.querySelectorAll("[data-month-date-toggle]").forEach(button => {
    button.addEventListener("click", event => {
      const key = event.currentTarget.dataset.monthDateToggle;
      if (state.expandedMonthDates.has(key)) state.expandedMonthDates.delete(key);
      else state.expandedMonthDates.add(key);
      render();
    });
  });
}

function schoolTotalSummary(schools) {
  if (!schools.length) return "";
  return `
    <section class="panel">
      <h2>Total por escola</h2>
      <div class="school-total-grid">
        ${schools.map(school => `
          <div class="school-total-item">
            <span>${school.shortName}</span>
            <strong>${money(schoolMonthTotal(school.id))}</strong>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function myMonthBySchool(schools, dates) {
  if (!schools.length) return `<div class="empty">Nenhuma escola vinculada ao seu usu&aacute;rio.</div>`;
  return `
    <section class="month-school-list">
      ${schools.map(school => {
        const completeCount = dates.filter(date => isCompleteEntry(entryKey(date, school.id))).length;
        const collapsed = !state.expandedMonthSchools.has(school.id);
        const total = schoolMonthTotal(school.id);
        return `
          <article class="month-school ${collapsed ? "collapsed" : ""}">
            <button class="school-toggle" type="button" data-month-school-toggle="${school.id}" aria-expanded="${!collapsed}">
              <div>
                <h3>${school.shortName}</h3>
                <p class="muted">${school.route}${school.address ? ` &bull; ${school.address}` : ""}</p>
              </div>
              <div class="school-status">
                <span class="badge ${completeCount === dates.length ? "done" : "warn"}">${completeCount}/${dates.length} registradas</span>
                <span class="badge progress">${money(total)}</span>
                <span class="chevron">${collapsed ? "+" : "-"}</span>
              </div>
            </button>
            ${collapsed ? "" : `<div class="month-date-list">
              ${dates.map(date => monthDateRow(school, date)).join("")}
            </div>`}
          </article>
        `;
      }).join("")}
    </section>
  `;
}

function monthDateRow(school, date) {
  const entry = entryKey(date, school.id);
  const complete = isCompleteEntry(entry);
  const total = quantitiesTotal(entry?.quantities || {});
  const status = entry?.status === "not_served" ? "Sem atendimento" : complete ? "Preenchido" : "Pendente";
  const key = dateStateKey(school.id, date);
  const expanded = state.expandedMonthDates.has(key);
  const cards = filledCardLines(entry);
  return `
    <article class="month-date-card ${expanded ? "" : "collapsed"}">
      <button class="month-date-row" type="button" data-month-date-toggle="${key}" aria-expanded="${expanded}">
        <strong>${formatDateBR(date)}</strong>
        <span class="badge ${complete ? "done" : "warn"}">${status}</span>
        <span>${entry?.reason || ""}</span>
        <span>${complete ? money(total) : ""}</span>
        <span class="chevron">${expanded ? "-" : "+"}</span>
      </button>
      ${expanded ? `
        <div class="month-date-detail">
          <strong>Total da refei&ccedil;&atilde;o: ${money(total)}</strong>
          ${entry?.status === "not_served" ? `<span>Motivo: ${entry.reason}</span>` : cards.length ? `
            <div class="card-lines">
              ${cards.map(item => `
                <div class="card-line">
                  <span>${item.label}</span>
                  <strong>${item.qty}</strong>
                  <span>${money(quantityNumber(item.qty) * item.price)}</span>
                </div>
              `).join("")}
            </div>
          ` : `<span class="muted">Nenhum card preenchido nessa data.</span>`}
          ${entry?.notes ? `<span>Observa&ccedil;&atilde;o: ${entry.notes}</span>` : ""}
        </div>
      ` : ""}
    </article>
  `;
}
function renderDashboard() {
  const monthEntries = completeEntriesFor({ month: state.selectedMonth });
  const sent = state.db.closures.filter(item => item.month === state.selectedMonth && item.status === "sent");
  const expectedDays = expectedBusinessDays();
  shell(`
    <div class="topbar">
      <div class="page-title"><h1>Painel da Coordenação</h1><p>Acompanhe preenchimentos, responsáveis e pendências.</p></div>
      <div class="toolbar">
        <div class="field" style="min-width: 180px"><label>Mês</label><input id="month" type="month" value="${state.selectedMonth}" /></div>
        <div class="field" style="width: 150px"><label>Dias úteis</label><input id="working-days" type="text" inputmode="numeric" value="${expectedDays}" /></div>
      </div>
    </div>
    <section class="grid cols-4">
      <div class="metric"><strong>${state.db.schools.length}</strong><span>Escolas cadastradas</span></div>
      <div class="metric"><strong>${monthEntries.length}</strong><span>Dias preenchidos</span></div>
      <div class="metric"><strong>${new Set(monthEntries.map(e => e.schoolId)).size}</strong><span>Escolas preenchidas</span></div>
      <div class="metric"><strong>${sent.length}</strong><span>Envios finais</span></div>
    </section>
    <div class="filters">
      <div class="field" style="min-width: 220px"><label>Rota</label><select id="route-filter"><option value="todas">Todas</option>${routes().map(route => `<option ${state.routeFilter === route ? "selected" : ""}>${route}</option>`).join("")}</select></div>
      <div class="field" style="min-width: 220px"><label>Nutricionista</label><select id="nutri-filter"><option value="todos">Todas</option>${nutritionists().map(user => `<option value="${user.id}" ${state.nutritionistFilter === user.id ? "selected" : ""}>${user.name}</option>`).join("")}</select></div>
    </div>
    ${adminSchoolTable()}
  `);
  $("#month").addEventListener("change", event => {
    state.selectedMonth = event.target.value;
    render();
  });
  $("#working-days").addEventListener("change", async event => {
    setExpectedBusinessDays(state.selectedMonth, event.target.value);
    await saveDb("Dias úteis atualizados.");
  });
  $("#route-filter").addEventListener("change", event => {
    state.routeFilter = event.target.value;
    render();
  });
  $("#nutri-filter").addEventListener("change", event => {
    state.nutritionistFilter = event.target.value;
    render();
  });
  document.querySelectorAll("[data-admin-school-toggle]").forEach(button => {
    button.addEventListener("click", event => {
      const schoolId = event.currentTarget.dataset.adminSchoolToggle;
      if (state.expandedAdminSchools.has(schoolId)) state.expandedAdminSchools.delete(schoolId);
      else state.expandedAdminSchools.add(schoolId);
      render();
    });
  });
  document.querySelectorAll("[data-admin-date-toggle]").forEach(button => {
    button.addEventListener("click", event => {
      const key = event.currentTarget.dataset.adminDateToggle;
      if (state.expandedAdminDates.has(key)) state.expandedAdminDates.delete(key);
      else state.expandedAdminDates.add(key);
      render();
    });
  });
}

function adminSchoolTable() {
  let schools = state.db.schools;
  const expectedDays = expectedBusinessDays();
  if (state.routeFilter !== "todas") schools = schools.filter(school => school.route === state.routeFilter);
  if (state.nutritionistFilter !== "todos") schools = schools.filter(school => school.nutritionistIds.includes(state.nutritionistFilter));
  return `
    <div class="table-wrap">
      <table class="responsive-table admin-progress-table">
        <thead><tr><th>Escola</th><th>Rota</th><th>Respons&aacute;veis</th><th>Preenchimento</th><th>Status</th></tr></thead>
        <tbody>
          ${schools.map(school => {
            const entries = completeEntriesFor({ month: state.selectedMonth, schoolId: school.id, userId: state.nutritionistFilter === "todos" ? undefined : state.nutritionistFilter });
            const filledDays = new Set(entries.map(entry => entry.date)).size;
            const percent = Math.min(100, (filledDays / expectedDays) * 100);
            const displayPercent = percent.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
            const status = percent === 0 ? "pendente" : percent >= 100 ? "completo" : "em andamento";
            const badgeClass = percent === 0 ? "warn" : percent >= 100 ? "done" : "progress";
            const names = school.nutritionistIds.map(id => state.db.users.find(user => user.id === id)?.name).filter(Boolean).join(", ");
            const expanded = state.expandedAdminSchools.has(school.id);
            return `<tr class="admin-school-row ${expanded ? "expanded" : ""}">
              <td data-label="Escola">
                <button class="admin-school-button" type="button" data-admin-school-toggle="${school.id}" aria-expanded="${expanded}">
                  <span>${school.shortName}</span>
                  <span class="chevron">${expanded ? "-" : "+"}</span>
                </button>
              </td>
              <td data-label="Rota">${school.route}</td>
              <td data-label="Respons&aacute;veis">${names || "Sem respons&aacute;vel"}</td>
              <td data-label="Preenchimento">
                <div class="progress-cell">
                  <strong>${displayPercent}%</strong>
                  <span>${filledDays} de ${expectedDays} dias</span>
                  <div class="progress-bar"><i style="width:${percent}%"></i></div>
                </div>
              </td>
              <td data-label="Status"><span class="badge ${badgeClass}">${status}</span></td>
            </tr>
            ${expanded ? `<tr class="admin-detail-row"><td colspan="5">${adminSchoolDetail(school)}</td></tr>` : ""}`;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function adminDateEntries(schoolId, date) {
  return entriesFor({ schoolId, date, userId: state.nutritionistFilter === "todos" ? undefined : state.nutritionistFilter });
}

function adminSchoolDetail(school) {
  const dates = businessDates();
  const filled = dates.filter(date => adminDateEntries(school.id, date).some(isCompleteEntry)).length;
  const pending = Math.max(dates.length - filled, 0);
  const total = dates.reduce((sum, date) => {
    return sum + adminDateEntries(school.id, date).filter(isCompleteEntry).reduce((daySum, entry) => daySum + quantitiesTotal(entry.quantities), 0);
  }, 0);
  return `
    <section class="admin-school-detail">
      <div class="admin-detail-summary">
        <span><strong>${filled}</strong> preenchidas</span>
        <span><strong>${pending}</strong> pendentes</span>
        <span><strong>${money(total)}</strong> total estimado</span>
      </div>
      <div class="admin-date-list">
        ${dates.map(date => adminDateCard(school, date)).join("")}
      </div>
    </section>
  `;
}

function adminDateCard(school, date) {
  const entries = adminDateEntries(school.id, date);
  const completeEntries = entries.filter(isCompleteEntry);
  const complete = completeEntries.length > 0;
  const total = completeEntries.reduce((sum, entry) => sum + quantitiesTotal(entry.quantities), 0);
  const status = complete ? (completeEntries.some(entry => entry.status === "not_served") ? "Sem atendimento" : "Preenchido") : "Pendente";
  const key = dateStateKey(school.id, date);
  const expanded = state.expandedAdminDates.has(key);
  return `
    <article class="admin-date-card ${expanded ? "" : "collapsed"}">
      <button class="month-date-row" type="button" data-admin-date-toggle="${key}" aria-expanded="${expanded}">
        <strong>${formatDateBR(date)}</strong>
        <span class="badge ${complete ? "done" : "warn"}">${status}</span>
        <span>${completeEntries.map(entry => entry.nutritionistName).filter(Boolean).join(", ")}</span>
        <span>${complete ? money(total) : ""}</span>
        <span class="chevron">${expanded ? "-" : "+"}</span>
      </button>
      ${expanded ? `<div class="admin-date-detail">${adminDateDetail(entries, completeEntries)}</div>` : ""}
    </article>
  `;
}

function adminDateDetail(entries, completeEntries) {
  if (!entries.length) return `<span class="muted">Nenhum preenchimento iniciado nessa data.</span>`;
  if (!completeEntries.length) return `<span class="muted">Preenchimento iniciado, mas ainda pendente de finaliza&ccedil;&atilde;o.</span>`;
  return completeEntries.map(entry => {
    const total = quantitiesTotal(entry.quantities);
    const cards = filledCardLines(entry);
    return `
      <div class="admin-entry-detail">
        <div class="admin-entry-head">
          <strong>${entry.nutritionistName || "Nutricionista"}</strong>
          <span>${entry.status === "not_served" ? "Sem atendimento" : `Total: ${money(total)}`}</span>
        </div>
        ${entry.status === "not_served" ? `<span>Motivo: ${entry.reason}</span>` : cards.length ? `
          <div class="card-lines">
            ${cards.map(item => `
              <div class="card-line">
                <span>${item.label}</span>
                <strong>${item.qty}</strong>
                <span>${money(quantityNumber(item.qty) * item.price)}</span>
              </div>
            `).join("")}
          </div>
        ` : `<span class="muted">Nenhum card preenchido.</span>`}
        ${entry.notes ? `<span>Observa&ccedil;&atilde;o: ${entry.notes}</span>` : ""}
      </div>
    `;
  }).join("");
}
function renderConfig() {
  shell(`
    <div class="topbar">
      <div class="page-title"><h1>Configurações</h1><p>Defina nutricionistas, rotas e escolas sob responsabilidade.</p></div>
      <button class="primary" id="add-user">Nova nutricionista</button>
    </div>
    <section class="panel">
      <h2>Nutricionistas</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Nome</th><th>Usuário</th><th>Senha</th><th>Escolas</th><th>Ações</th></tr></thead>
          <tbody>${nutritionists().map(userRow).join("")}</tbody>
        </table>
      </div>
    </section>
    <section class="panel">
      <h2>Vínculo por escola</h2>
      <div class="filters">
        <div class="field" style="min-width:220px"><label>Rota</label><select id="route-filter"><option value="todas">Todas</option>${routes().map(route => `<option ${state.routeFilter === route ? "selected" : ""}>${route}</option>`).join("")}</select></div>
      </div>
      ${assignmentTable()}
      <p class="status-line">${state.message}</p>
    </section>
  `);
  $("#add-user").addEventListener("click", () => {
    state.db.users.push({ id: uid("user"), name: "Nova Nutricionista", username: `nutri${nutritionists().length + 1}`, password: "123", role: "nutritionist", active: true });
    saveDb("Nutricionista criada.");
  });
  document.querySelectorAll("[data-user-field]").forEach(input => {
    input.addEventListener("change", event => {
      const user = state.db.users.find(item => item.id === event.target.dataset.user);
      user[event.target.dataset.userField] = event.target.value;
      saveDb("Dados da nutricionista atualizados.");
    });
  });
  document.querySelectorAll("[data-delete-user]").forEach(button => {
    button.addEventListener("click", () => {
      const id = button.dataset.deleteUser;
      state.db.users.find(user => user.id === id).active = false;
      state.db.schools.forEach(school => (school.nutritionistIds = school.nutritionistIds.filter(item => item !== id)));
      saveDb("Nutricionista desativada.");
    });
  });
  $("#route-filter").addEventListener("change", event => {
    state.routeFilter = event.target.value;
    render();
  });
  document.querySelectorAll("[data-assign]").forEach(input => {
    input.addEventListener("change", event => {
      const school = state.db.schools.find(item => item.id === event.target.dataset.school);
      const userId = event.target.dataset.assign;
      if (event.target.checked && !school.nutritionistIds.includes(userId)) school.nutritionistIds.push(userId);
      if (!event.target.checked) school.nutritionistIds = school.nutritionistIds.filter(id => id !== userId);
      saveDb("Vínculo atualizado.");
    });
  });
}

function userRow(user) {
  const count = state.db.schools.filter(school => school.nutritionistIds.includes(user.id)).length;
  return `
    <tr>
      <td><input data-user="${user.id}" data-user-field="name" value="${user.name}" /></td>
      <td><input data-user="${user.id}" data-user-field="username" value="${user.username}" /></td>
      <td><input data-user="${user.id}" data-user-field="password" value="${user.password}" /></td>
      <td>${count}</td>
      <td><button class="danger" data-delete-user="${user.id}">Desativar</button></td>
    </tr>
  `;
}

function assignmentTable() {
  let schools = state.db.schools;
  if (state.routeFilter !== "todas") schools = schools.filter(school => school.route === state.routeFilter);
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Escola</th><th>Rota</th><th>Responsáveis</th></tr></thead>
        <tbody>
          ${schools.map(school => `
            <tr>
              <td>${school.shortName}</td>
              <td>${school.route}</td>
              <td>
                <div class="assign-grid">
                  ${nutritionists().map(user => `
                    <label class="check-pill">
                      <input type="checkbox" data-assign="${user.id}" data-school="${school.id}" ${school.nutritionistIds.includes(user.id) ? "checked" : ""} />
                      ${user.name}
                    </label>
                  `).join("")}
                </div>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderExport() {
  shell(`
    <div class="topbar">
      <div class="page-title"><h1>Exportação</h1><p>Gere uma única planilha consolidada para a coordenação.</p></div>
    </div>
    <section class="panel">
      <div class="toolbar">
        <div class="field" style="min-width: 180px"><label>Mês</label><input id="month" type="month" value="${state.selectedMonth}" /></div>
        <button class="primary" id="export">Gerar Excel consolidado</button>
      </div>
      <p class="status-line">${state.message}</p>
    </section>
    <section class="panel">
      <h2>Exportações recentes</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Mês</th><th>Arquivo</th><th>Criado em</th></tr></thead>
          <tbody>${(state.db.exports || []).slice().reverse().map(item => `<tr><td>${item.month}</td><td><a href="/exports/${item.filename}">${item.filename}</a></td><td>${item.createdAt}</td></tr>`).join("") || `<tr><td colspan="3">Nenhuma exportação gerada.</td></tr>`}</tbody>
        </table>
      </div>
    </section>
  `);
  $("#month").addEventListener("change", event => {
    state.selectedMonth = event.target.value;
    state.message = "";
    renderExport();
  });
  $("#export").addEventListener("click", async () => {
    const month = $("#month").value;
    state.selectedMonth = month;
    state.message = `Gerando planilha de ${month}...`;
    renderExport();
    try {
      const result = await api("/api/export", { method: "POST", body: { month } });
      if (result.base64) downloadBase64File(result);
      state.db = await api("/api/data");
      state.selectedMonth = month;
      state.message = `Planilha de ${month} gerada: ${result.filename}`;
      renderExport();
    } catch (error) {
      state.message = error.message;
      renderExport();
    }
  });
}

function render() {
  if (!state.user) return renderLogin();
  if (state.view === "lancamentos") return renderNutritionistForm();
  if (state.view === "meu-mes") return renderMyMonth();
  if (state.view === "dashboard") return renderDashboard();
  if (state.view === "config") return renderConfig();
  if (state.view === "exportar") return renderExport();
}

function legacyInitialLoadDisabled() {
  if (state.sessionToken && !isStaticMode()) {
    return loadData()
      .then(() => {
        state.user = state.db.currentUser || state.db.users[0] || null;
        state.view = state.user?.role === "admin" ? "dashboard" : "lancamentos";
        render();
      })
      .catch(() => {
        state.sessionToken = "";
        localStorage.removeItem("apuracao-session-token");
        renderLogin();
      });
  }
  if (isStaticMode()) {
    return loadData().then(() => renderLogin());
  }
  renderLogin();
  return Promise.resolve();
}

legacyInitialLoadDisabled();

