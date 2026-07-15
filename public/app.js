const state = {
  db: null,
  user: null,
  view: "lancamentos",
  selectedDate: new Date().toISOString().slice(0, 10),
  selectedMonth: "2026-07",
  routeFilter: "todas",
  nutritionistFilter: "todos",
  message: ""
};

const $ = selector => document.querySelector(selector);
const app = $("#app");

function money(value) {
  return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
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
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Falha na operacao.");
  return data;
}

async function saveDb(message = "Salvo.") {
  await api("/api/save", { method: "POST", body: state.db });
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
      state.user = result.user;
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
    renderLogin();
  });
}

function entryKey(date, schoolId, nutritionistId = state.user.id) {
  return state.db.entries.find(entry => entry.date === date && entry.schoolId === schoolId && entry.nutritionistId === nutritionistId);
}

function upsertEntry(schoolId, patch) {
  let entry = entryKey(state.selectedDate, schoolId);
  if (!entry) {
    entry = {
      id: uid("entry"),
      date: state.selectedDate,
      month: state.selectedDate.slice(0, 7),
      schoolId,
      nutritionistId: state.user.id,
      nutritionistName: state.user.name,
      status: "served",
      reason: "",
      notes: "",
      quantities: {},
      updatedAt: new Date().toISOString()
    };
    state.db.entries.push(entry);
  }
  Object.assign(entry, patch, { updatedAt: new Date().toISOString() });
}

function renderNutritionistForm() {
  const schools = assignedSchools();
  const filled = completeEntriesFor({ date: state.selectedDate, userId: state.user.id }).length;
  const cards = state.db.cards;
  shell(`
    <div class="topbar">
      <div class="page-title">
        <h1>Lançamentos</h1>
        <p>${schools.length} escolas sob sua responsabilidade.</p>
      </div>
      <div class="field" style="min-width: 220px">
        <label>Data</label>
        <input id="date-picker" type="date" value="${state.selectedDate}" />
      </div>
    </div>
    <section class="grid cols-3">
      <div class="metric"><strong>${schools.length}</strong><span>Escolas vinculadas</span></div>
      <div class="metric"><strong>${filled}</strong><span>Registros nesta data</span></div>
      <div class="metric"><strong>${Math.max(schools.length - filled, 0)}</strong><span>Pendentes nesta data</span></div>
    </section>
    <div class="toolbar">
      <button class="secondary" id="save-partial">Encerrar Parcialmente</button>
      <button class="primary" id="send-final">Encerrar e Enviar para Coordenação</button>
      <span class="status-line">${state.message}</span>
    </div>
    <section class="grid">
      ${schools.map(school => schoolCard(school, cards)).join("") || `<div class="empty">Nenhuma escola vinculada ao seu usuário.</div>`}
    </section>
  `);
  $("#date-picker").addEventListener("change", event => {
    state.selectedDate = event.target.value;
    render();
  });
  document.querySelectorAll("[data-card-toggle]").forEach(input => {
    input.addEventListener("change", event => {
      const { school, card } = event.target.dataset;
      const entry = entryKey(state.selectedDate, school);
      const quantities = { ...(entry?.quantities || {}) };
      if (event.target.checked) quantities[card] = quantities[card] ?? "";
      else delete quantities[card];
      upsertEntry(school, { status: "served", quantities });
      pruneEntryIfEmpty(entryKey(state.selectedDate, school));
      render();
    });
  });
  document.querySelectorAll("[data-qty]").forEach(input => {
    input.addEventListener("input", event => {
      const { school, card } = event.target.dataset;
      const entry = entryKey(state.selectedDate, school);
      const quantities = { ...(entry?.quantities || {}) };
      quantities[card] = parseQuantity(event.target.value);
      upsertEntry(school, { status: "served", quantities });
    });
  });
  document.querySelectorAll("[data-reason]").forEach(select => {
    select.addEventListener("change", event => {
      const schoolId = event.target.dataset.reason;
      upsertEntry(schoolId, { status: event.target.value ? "not_served" : "served", reason: event.target.value, quantities: event.target.value ? {} : entryKey(state.selectedDate, schoolId)?.quantities || {} });
      pruneEntryIfEmpty(entryKey(state.selectedDate, schoolId));
      render();
    });
  });
  document.querySelectorAll("[data-notes]").forEach(textarea => {
    textarea.addEventListener("change", event => {
      upsertEntry(event.target.dataset.notes, { notes: event.target.value });
    });
  });
  $("#save-partial").addEventListener("click", () => saveDb("Parcial encerrada e salva."));
  $("#send-final").addEventListener("click", async () => {
    const month = state.selectedDate.slice(0, 7);
    const existing = state.db.closures.find(item => item.month === month && item.nutritionistId === state.user.id);
    if (existing) existing.status = "sent";
    else state.db.closures.push({ id: uid("closure"), month, nutritionistId: state.user.id, nutritionistName: state.user.name, status: "sent", sentAt: new Date().toISOString() });
    await saveDb("Mês enviado para coordenação.");
  });
}

function schoolCard(school, cards) {
  const entry = entryKey(state.selectedDate, school.id);
  const quantities = entry?.quantities || {};
  const isNotServed = entry?.status === "not_served";
  const complete = isCompleteEntry(entry);
  const total = Object.entries(quantities).reduce((sum, [cardId, qty]) => {
    const card = cards.find(item => item.id === cardId);
    return sum + quantityNumber(qty) * Number(card?.price || 0);
  }, 0);
  return `
    <article class="school-card">
      <div class="school-head">
        <div>
          <h3>${school.shortName}</h3>
          <p class="muted">${school.route}${school.address ? ` • ${school.address}` : ""}</p>
        </div>
        <span class="badge ${complete ? "done" : "warn"}">${complete ? "registrada" : "pendente"}</span>
      </div>
      <div class="field">
        <label>Motivo sem atendimento</label>
        <select data-reason="${school.id}">
          <option value="">Teve atendimento</option>
          ${state.db.settings.reasons.map(reason => `<option ${entry?.reason === reason ? "selected" : ""}>${reason}</option>`).join("")}
        </select>
      </div>
      ${isNotServed ? "" : `
        <div class="card-selector">
          ${cards.map(card => `
            <label class="check-pill">
              <input type="checkbox" data-card-toggle data-school="${school.id}" data-card="${card.id}" ${quantities[card.id] !== undefined ? "checked" : ""} />
              ${card.label}
            </label>
          `).join("")}
        </div>
        <div class="qty-grid">
          ${cards.filter(card => quantities[card.id] !== undefined).map(card => `
            <div class="field">
              <label>${card.label} • ${money(card.price)}</label>
              <input type="text" inputmode="numeric" placeholder="Quantidade" data-qty data-school="${school.id}" data-card="${card.id}" value="${quantities[card.id]}" />
            </div>
          `).join("")}
        </div>
      `}
      <div class="field">
        <label>Observação</label>
        <textarea data-notes="${school.id}">${entry?.notes || ""}</textarea>
      </div>
      <strong>Total do dia: ${money(total)}</strong>
    </article>
  `;
}

function renderMyMonth() {
  const schools = assignedSchools();
  const monthEntries = completeEntriesFor({ month: state.selectedMonth, userId: state.user.id });
  shell(`
    <div class="topbar">
      <div class="page-title"><h1>Meu mês</h1><p>Acompanhamento do preenchimento da competência.</p></div>
      <div class="field" style="min-width: 180px"><label>Mês</label><input id="month" type="month" value="${state.selectedMonth}" /></div>
    </div>
    <section class="grid cols-3">
      <div class="metric"><strong>${monthEntries.length}</strong><span>Registros no mês</span></div>
      <div class="metric"><strong>${new Set(monthEntries.map(e => e.schoolId)).size}</strong><span>Escolas com algum lançamento</span></div>
      <div class="metric"><strong>${schools.length}</strong><span>Escolas vinculadas</span></div>
    </section>
    ${summaryTable(monthEntries)}
  `);
  $("#month").addEventListener("change", event => {
    state.selectedMonth = event.target.value;
    render();
  });
}

function summaryTable(entries) {
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Data</th><th>Escola</th><th>Status</th><th>Motivo</th><th>Total estimado</th></tr></thead>
        <tbody>
          ${entries.map(entry => {
            const school = state.db.schools.find(item => item.id === entry.schoolId);
            const total = Object.entries(entry.quantities || {}).reduce((sum, [cardId, qty]) => {
              const card = state.db.cards.find(item => item.id === cardId);
              return sum + quantityNumber(qty) * Number(card?.price || 0);
            }, 0);
            return `<tr><td>${entry.date}</td><td>${school?.shortName || ""}</td><td>${entry.status === "not_served" ? "Sem atendimento" : "Preenchido"}</td><td>${entry.reason || ""}</td><td>${money(total)}</td></tr>`;
          }).join("") || `<tr><td colspan="5">Nenhum registro encontrado.</td></tr>`}
        </tbody>
      </table>
    </div>
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
}

function adminSchoolTable() {
  let schools = state.db.schools;
  const expectedDays = expectedBusinessDays();
  if (state.routeFilter !== "todas") schools = schools.filter(school => school.route === state.routeFilter);
  if (state.nutritionistFilter !== "todos") schools = schools.filter(school => school.nutritionistIds.includes(state.nutritionistFilter));
  return `
    <div class="table-wrap">
      <table class="responsive-table">
        <thead><tr><th>Escola</th><th>Rota</th><th>Responsáveis</th><th>Preenchimento</th><th>Status</th></tr></thead>
        <tbody>
          ${schools.map(school => {
            const entries = completeEntriesFor({ month: state.selectedMonth, schoolId: school.id });
            const filledDays = new Set(entries.map(entry => entry.date)).size;
            const percent = Math.min(100, (filledDays / expectedDays) * 100);
            const displayPercent = percent.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
            const status = percent === 0 ? "pendente" : percent >= 100 ? "completo" : "em andamento";
            const badgeClass = percent === 0 ? "warn" : percent >= 100 ? "done" : "progress";
            const names = school.nutritionistIds.map(id => state.db.users.find(user => user.id === id)?.name).filter(Boolean).join(", ");
            return `<tr>
              <td data-label="Escola">${school.shortName}</td>
              <td data-label="Rota">${school.route}</td>
              <td data-label="Responsáveis">${names || "Sem responsável"}</td>
              <td data-label="Preenchimento">
                <div class="progress-cell">
                  <strong>${displayPercent}%</strong>
                  <span>${filledDays} de ${expectedDays} dias</span>
                  <div class="progress-bar"><i style="width:${percent}%"></i></div>
                </div>
              </td>
              <td data-label="Status"><span class="badge ${badgeClass}">${status}</span></td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
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
  });
  $("#export").addEventListener("click", async () => {
    state.message = "Gerando planilha...";
    renderExport();
    try {
      const result = await api("/api/export", { method: "POST", body: { month: state.selectedMonth } });
      state.db = await api("/api/data");
      state.message = `Planilha gerada: ${result.filename}`;
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

loadData()
  .then(() => renderLogin())
  .catch(error => {
    app.innerHTML = `<main class="login-screen"><div class="login-card"><h1>Base não inicializada</h1><p>${error.message}</p><p>Rode <code>python scripts/import_seed.py</code> e reinicie o sistema.</p></div></main>`;
  });
