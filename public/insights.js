// Histórico de Pedidos e abas do Analytics (KM, Pedidos, Inventário, Cruzamento e Notificações).
// Usa as funções globais de app.js e modules.js (esc, mod, shell, statCard, icon...).

// ================================================================ utilidades de período (mês a mês)
function shiftMonth(month, delta) {
  const [y, m] = month.split("-").map(Number);
  const date = new Date(y, m - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthsBetween(from, to) {
  const list = [];
  if (!from || !to || from > to) return list;
  for (let month = from; month <= to && list.length < 60; month = shiftMonth(month, 1)) list.push(month);
  return list;
}

function monthEndISO(month) {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
}

function monthShort(month) {
  return bucketLabel(month, "month");
}

function pctText(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${fmtNumber(value * 100, digits)}%`;
}

// Variação: negativo (pediu menos) em verde, positivo em vermelho.
function deltaPill(value, { invert = false, digits = 1 } = {}) {
  if (value === null || value === undefined || !Number.isFinite(value) || Math.abs(value) < 0.0005) return "<span class='muted'>0%</span>";
  const good = invert ? value > 0 : value < 0;
  return `<span class="diff ${good ? "up" : "down"}">${pctText(value, digits)}</span>`;
}

function median(values) {
  const list = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

function fmtKg(value) {
  return `${fmtNumber(value, Math.abs(value) < 100 ? 1 : 0)} kg`;
}

// ================================================================ gráficos simples (HTML/CSS, legíveis no celular)
function columnChart({ labels, series, fmt = value => fmtNumber(value), empty = "Sem dados no período" }) {
  const max = Math.max(0, ...series.flatMap(item => item.values));
  if (!max) return emptyState(empty, "", "chart");
  const single = series.length === 1;
  return `<div class="col-chart">
    ${single ? "" : `<div class="legend">${series.map(item => `<span><i style="background:${item.color}"></i>${esc(item.name)}</span>`).join("")}</div>`}
    <div class="col-plot" style="--cols:${labels.length}">
      ${labels.map((label, index) => `<div class="col-group">
        <div class="col-bars">${series.map(item => {
          const value = item.values[index] || 0;
          return `<span class="col-bar" style="--v:${(value / max * 100).toFixed(1)}%;--c:${item.color}" title="${esc(item.name)} · ${esc(label)}: ${esc(fmt(value, index))}">${single && value ? `<em>${esc(fmt(value, index))}</em>` : ""}</span>`;
        }).join("")}</div>
        <span class="col-label">${esc(label)}</span>
      </div>`).join("")}
    </div>
  </div>`;
}

function hbarList(rows, { fmt = value => fmtNumber(value), color = "#2a78d6", limit = 12 } = {}) {
  const list = rows.slice(0, limit);
  const max = Math.max(1, ...list.map(row => row.value));
  if (!list.length) return emptyState("Sem dados no período", "", "chart");
  return `<ol class="hbar-list">${list.map((row, index) => `<li>
    <span class="hbar-pos">${index + 1}</span>
    <span class="hbar-text"><strong>${esc(row.label)}</strong>${row.sub ? `<small>${row.sub}</small>` : ""}</span>
    <span class="hbar-val">${esc(fmt(row.value))}</span>
    <span class="hbar-track"><i style="width:${(row.value / max * 100).toFixed(1)}%;background:${row.color || (index === 0 ? "#eb6834" : color)}"></i></span>
  </li>`).join("")}</ol>`;
}

// ================================================================ ANALYTICS: seções
const AN_SECTIONS = [
  ["faturamento", "Faturamento", "chart"],
  ["km", "Controle de KM", "car"],
  ["pedidos", "Pedidos", "cart"],
  ["inventario", "Inventário", "package"],
  ["cruzamento", "Inventário × Pedidos × Matriculados", "table"],
  ["notificacoes", "Notificações", "alertCircle"],
  ["gas", "Registro de Gás", "flame"]
];

// As seções do Analytics ficam no menu lateral (grupo "Analytics"); não há abas dentro da página.
function bindAnalyticsTabs() {}

// Último mês com dados: pedidos costumam ser do mês seguinte, então o período vai até ele.
function latestDataMonth() {
  const months = [currentMonth(), ...(mod().data.orders || []).map(order => order.month), ...Object.keys(mod().data.inventoryCounts || {})].filter(Boolean);
  return months.sort().pop();
}

// Período em meses compartilhado pelas abas (exceto Faturamento, que tem filtro próprio por dia).
function anPeriod() {
  const ui = mod().ui.an;
  if (!ui.mTo) { ui.mTo = latestDataMonth(); ui.mFrom = shiftMonth(ui.mTo, -5); ui.mPreset = "6m"; }
  return ui;
}

function periodBarHtml(extra = "") {
  const ui = anPeriod();
  return `<section class="card an-filters an-period">
    <div class="an-filter-row">
      <div class="field-group"><span class="label">Período</span>
        <div class="segmented">${[["3m", "3 meses"], ["6m", "6 meses"], ["12m", "12 meses"], ["ano", "Ano"]].map(([key, label]) => `<button type="button" class="${ui.mPreset === key ? "active" : ""}" data-an-mpreset="${key}">${label}</button>`).join("")}</div>
      </div>
      <label class="field-group"><span class="label">De</span><input type="month" id="an-mfrom" value="${ui.mFrom}" /></label>
      <label class="field-group"><span class="label">Até</span><input type="month" id="an-mto" value="${ui.mTo}" /></label>
      ${extra}
    </div>
  </section>`;
}

function bindPeriodBar() {
  const ui = anPeriod();
  document.querySelectorAll("[data-an-mpreset]").forEach(button => button.addEventListener("click", () => {
    const to = latestDataMonth();
    const key = button.dataset.anMpreset;
    ui.mTo = to;
    ui.mFrom = key === "ano" ? `${to.slice(0, 4)}-01` : shiftMonth(to, -({ "3m": 3, "6m": 6, "12m": 12 }[key] - 1));
    ui.mPreset = key;
    renderAnalytics();
  }));
  $("#an-mfrom")?.addEventListener("change", event => { if (event.target.value) { ui.mFrom = event.target.value; ui.mPreset = ""; if (ui.mFrom > ui.mTo) ui.mTo = ui.mFrom; renderAnalytics(); } });
  $("#an-mto")?.addEventListener("change", event => { if (event.target.value) { ui.mTo = event.target.value; ui.mPreset = ""; if (ui.mTo < ui.mFrom) ui.mFrom = ui.mTo; renderAnalytics(); } });
}

function analyticsHead(subtitle) {
  const section = AN_SECTIONS.find(([key]) => key === (mod().ui.an.tab || "faturamento"));
  return pageHead({ eyebrow: "Analytics", title: section ? section[1] : "Analytics", subtitle });
}

function renderAnalyticsSection(tab) {
  const renderers = { km: renderAnKm, pedidos: renderAnPedidos, inventario: renderAnInventario, cruzamento: renderAnCruzamento, notificacoes: renderAnNotificacoes, gas: renderAnGas };
  (renderers[tab] || renderAnKm)();
  bindAnalyticsTabs();
  bindPeriodBar();
}

function segmentedHtml(attr, current, options) {
  return `<div class="segmented scroll-x">${options.map(([key, label]) => `<button type="button" class="${current === key ? "active" : ""}" data-${attr}="${key}">${label}</button>`).join("")}</div>`;
}

function bindSegmented(attr, apply) {
  const dataKey = attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  document.querySelectorAll(`[data-${attr}]`).forEach(button => button.addEventListener("click", () => { apply(button.dataset[dataKey]); renderAnalytics(); }));
}

// ================================================================ ANALYTICS · CONTROLE DE KM
function kmMonthlyTotals(months) {
  const totals = months.map(() => 0);
  for (const [month, byNutri] of Object.entries(mod().data.km?.logs || {})) {
    const index = months.indexOf(month);
    if (index < 0) continue;
    for (const log of Object.values(byNutri)) {
      for (const row of Object.values(log.days || {})) {
        const start = parseKm(row.start);
        const end = parseKm(row.end);
        if (start !== null && end !== null) totals[index] += end - start;
      }
    }
  }
  return totals;
}

function kmMonthlyFuel(months) {
  return months.map(month => {
    let sum = 0;
    for (const log of Object.values(mod().data.km?.logs?.[month] || {})) for (const row of Object.values(log.fuel || {})) sum += Number(row.value) || 0;
    return Math.round(sum * 100) / 100;
  });
}

// KM rodado e abastecimento real (lançado pelo ADM no Controle de KM).
function renderAnKm() {
  const ui = anPeriod();
  const months = monthsBetween(ui.mFrom, ui.mTo);
  const { rows, grand, fuelValue, fuelLiters } = kmAnalytics(`${ui.mFrom}-01`, monthEndISO(ui.mTo));
  const active = rows.filter(row => row.total > 0 || row.fuelValue > 0);
  const withKm = active.filter(row => row.total > 0);
  const avg = withKm.length ? grand / withKm.length : 0;
  const monthly = kmMonthlyTotals(months);
  const monthlyFuel = kmMonthlyFuel(months);
  const max = Math.max(1, ...active.map(row => row.total));
  const perKm = km => (km ? fuelValue / km : null);

  shell(`
    ${analyticsHead(`KM rodado e abastecimentos · ${formatMonthBR(ui.mFrom)} a ${formatMonthBR(ui.mTo)}`)}
    ${periodBarHtml()}
    <section class="stat-row">
      ${statCard({ label: "KM rodado no período", value: `${fmtKm(grand)} km`, iconName: "car", tone: "brand" })}
      ${statCard({ label: "Abastecido no período", value: money(fuelValue), hint: `${fmtNumber(fuelLiters, 1)} L lançados pelo ADM`, iconName: "chart", tone: fuelValue ? "warn" : "" })}
      ${statCard({ label: "Custo por KM", value: perKm(grand) !== null && fuelValue ? money(perKm(grand)) : "—", hint: "abastecido ÷ KM rodado", iconName: "info" })}
      ${statCard({ label: "KM médio por nutricionista", value: `${fmtKm(avg)} km`, hint: `${withKm.length} com lançamento`, iconName: "users" })}
    </section>
    <section class="an-grid">
      <article class="card chart-card span-2">
        <header class="chart-head"><div><h3>KM rodado por mês</h3><p>Soma de todas as nutricionistas · valor abastecido no rótulo</p></div></header>
        ${columnChart({ labels: months.map(monthShort), series: [{ name: "KM", color: "#2a78d6", values: monthly }], fmt: (value, index) => `${fmtNumber(value, 0)} km${monthlyFuel[index] ? ` · ${fmtMoneyShort(monthlyFuel[index])}` : ""}` })}
      </article>
      <article class="card chart-card span-2">
        <header class="chart-head"><div><h3>KM e abastecimento por nutricionista</h3><p>Do mais rodado para o menos rodado</p></div></header>
        ${active.length ? `<div class="table-scroll"><table class="data-table an-table km-an-table">
          <thead><tr><th>#</th><th>Nutricionista</th><th>Placa</th><th class="bar-col">KM</th><th class="num">KM total</th><th class="num">Dias</th><th class="num">Média/dia</th><th class="num">Abastecido (L)</th><th class="num">Abastecido (R$)</th><th class="num">R$/km</th><th class="num">vs. média</th></tr></thead>
          <tbody>${active.map((row, index) => {
            const delta = avg ? (row.total - avg) / avg : 0;
            return `<tr>
              <td class="muted">${index + 1}</td>
              <td><strong>${esc(row.person.name)}</strong>${row.pending ? ` <small class="muted">· mês não enviado</small>` : ""}</td>
              <td>${row.plate ? `<span class="plate sm">${esc(row.plate)}</span>` : "<span class='muted'>—</span>"}</td>
              <td class="bar-col"><span class="rank-bar"><i style="width:${(row.total / max * 100).toFixed(1)}%;background:${index === 0 ? "#eb6834" : "#2a78d6"}"></i></span></td>
              <td class="num"><strong>${fmtKm(row.total)} km</strong></td>
              <td class="num">${row.days}</td>
              <td class="num">${fmtKm(row.days ? row.total / row.days : 0)} km</td>
              <td class="num">${row.fuelLiters ? `${fmtNumber(row.fuelLiters, 1)} L` : "<span class='muted'>—</span>"}</td>
              <td class="num"><strong>${row.fuelValue ? money(row.fuelValue) : "<span class='muted'>—</span>"}</strong></td>
              <td class="num">${row.fuelValue && row.total ? money(row.fuelValue / row.total) : "<span class='muted'>—</span>"}</td>
              <td class="num">${deltaPill(delta, { digits: 0 })}</td>
            </tr>`;
          }).join("")}</tbody>
          <tfoot><tr><td></td><td><strong>Total</strong></td><td></td><td></td><td class="num"><strong>${fmtKm(grand)} km</strong></td><td></td><td></td><td class="num">${fmtNumber(fuelLiters, 1)} L</td><td class="num"><strong>${money(fuelValue)}</strong></td><td class="num">${perKm(grand) !== null && fuelValue ? money(perKm(grand)) : "—"}</td><td></td></tr></tfoot>
        </table></div>` : emptyState("Nenhum KM lançado no período", "Os lançamentos do Controle de KM aparecem aqui.", "car")}
        <p class="form-hint">${icon("info")} O abastecimento (litros e valor) é lançado pelo ADM no Controle de KM, ao abrir cada nutricionista.</p>
      </article>
    </section>
  `);
}

// ================================================================ ANALYTICS · PEDIDOS
const ORDER_KINDS = [["todos", "Todos"], ["secos", "Secos"], ["congelados", "Congelados"], ["horti", "Horti"], ["outros", "Outros"]];

function orderKind(order) {
  const title = normalizeText(order.title);
  if (/horti/.test(title)) return "horti";
  if (/congel/.test(title)) return "congelados";
  if (/seco/.test(title)) return "secos";
  return "outros";
}

// Uma linha por item de pedido, com a quantidade final (ajuste enviado pela nutri ou, sem ajuste, o previsto).
function orderFacts({ from, to, kind = "todos", month = "" }) {
  const schools = schoolMap();
  const facts = [];
  for (const order of mod().data.orders || []) {
    if (month ? order.month !== month : order.month < from || order.month > to) continue;
    if (kind !== "todos" && orderKind(order) !== kind) continue;
    for (const line of order.lines) {
      const adjustment = order.adjustments?.[line.nutritionistId];
      const sent = Boolean(adjustment?.sentAt);
      const raw = sent ? adjustment.values?.[line.id] : undefined;
      const has = raw !== undefined && raw !== null && raw !== "";
      const final = has ? Number(raw) : Number(line.qty) || 0;
      const price = orderItemPrice(line.item);
      facts.push({
        price, valuePrev: price === null ? null : (Number(line.qty) || 0) * price, valueFinal: price === null ? null : final * price,
        order, month: order.month, nutriId: line.nutritionistId, schoolId: line.schoolId, route: schools.get(line.schoolId)?.route || "SEM ROTA",
        item: line.item, unit: String(line.unit || "").toUpperCase(), qty: Number(line.qty) || 0, final, adjusted: has && final !== Number(line.qty), sent
      });
    }
  }
  return facts;
}

function dimLabelOf(dim, key) {
  if (dim === "month") return formatMonthBR(key);
  if (dim === "nutri") return userMap().get(key)?.name || "Sem nutricionista";
  if (dim === "school") return schoolMap().get(key)?.shortName || key;
  if (dim === "route") return routeLabel(key);
  if (dim === "category") return key;
  return key;
}

function groupOrderFacts(facts, dim) {
  const keyOf = { month: f => f.month, nutri: f => f.nutriId, school: f => f.schoolId, route: f => f.route, item: f => f.item }[dim];
  const groups = new Map();
  for (const fact of facts) {
    const key = keyOf(fact);
    const group = groups.get(key) || { key, label: dimLabelOf(dim, key), lines: 0, adjusted: 0, up: 0, down: 0, kgPrev: 0, kgFinal: 0, relSum: 0, relN: 0, valuePrev: 0, valueFinal: 0, noPrice: 0 };
    group.lines += 1;
    if (fact.price === null) group.noPrice += 1; else { group.valuePrev += fact.valuePrev; group.valueFinal += fact.valueFinal; }
    if (fact.adjusted) { group.adjusted += 1; if (fact.final > fact.qty) group.up += 1; else group.down += 1; }
    if (fact.unit === "KG") { group.kgPrev += fact.qty; group.kgFinal += fact.final; }
    if (fact.qty > 0) { group.relSum += (fact.final - fact.qty) / fact.qty; group.relN += 1; }
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({ ...group, kgDelta: group.kgFinal - group.kgPrev, kgPct: group.kgPrev ? (group.kgFinal - group.kgPrev) / group.kgPrev : null, relAvg: group.relN ? group.relSum / group.relN : null,
    valueDelta: group.valueFinal - group.valuePrev, valuePct: group.valuePrev ? (group.valueFinal - group.valuePrev) / group.valuePrev : null }));
}

// Cabeçalho clicável: 1º clique ordena do maior para o menor, 2º clique inverte.
function sortTh(attr, sort, key, label, { num = true, title = "" } = {}) {
  const active = sort.key === key;
  const arrow = active ? (sort.dir === "asc" ? "▲" : "▼") : "↕";
  return `<th class="${num ? "num " : ""}sortable ${active ? "is-sorted" : ""}" ${title ? `title="${esc(title)}"` : ""}><button type="button" data-${attr}="${key}">${label} <span class="sort-arrow">${arrow}</span></button></th>`;
}

function sortRows(rows, sort, fallback) {
  if (!sort.key) return rows.sort(fallback);
  const factor = sort.dir === "asc" ? 1 : -1;
  return rows.sort((a, b) => {
    const x = a[sort.key];
    const y = b[sort.key];
    if (typeof x === "string" || typeof y === "string") return factor * String(x ?? "").localeCompare(String(y ?? ""), "pt-BR");
    const nx = x === null || x === undefined || Number.isNaN(x) ? -Infinity : x;
    const ny = y === null || y === undefined || Number.isNaN(y) ? -Infinity : y;
    return factor * (nx - ny) || fallback(a, b);
  });
}

function bindSortHeaders(attr, sort, rerender) {
  document.querySelectorAll(`[data-${attr}]`).forEach(button => button.addEventListener("click", () => {
    const key = button.getAttribute(`data-${attr}`);
    if (sort.key === key) sort.dir = sort.dir === "desc" ? "asc" : "desc";
    else { sort.key = key; sort.dir = key === "label" ? "asc" : "desc"; }
    rerender();
  }));
}

function renderAnPedidos() {
  const ui = anPeriod();
  ui.pedDim ||= "nutri";
  ui.pedKind ||= "todos";
  ui.pedSort ||= { key: "", dir: "desc" };
  const facts = orderFacts({ from: ui.mFrom, to: ui.mTo, kind: ui.pedKind });
  const orders = [...new Set(facts.map(fact => fact.order))];
  const pairs = new Map();
  for (const fact of facts) pairs.set(`${fact.order.id}:${fact.nutriId}`, fact.sent);
  const sentPairs = [...pairs.values()].filter(Boolean).length;
  const total = groupOrderFacts(facts, "month").reduce((acc, group) => {
    for (const key of ["lines", "adjusted", "up", "down", "kgPrev", "kgFinal", "valuePrev", "valueFinal", "noPrice"]) acc[key] += group[key];
    return acc;
  }, { lines: 0, adjusted: 0, up: 0, down: 0, kgPrev: 0, kgFinal: 0, valuePrev: 0, valueFinal: 0, noPrice: 0 });
  const valuePct = total.valuePrev ? (total.valueFinal - total.valuePrev) / total.valuePrev : null;
  const months = monthsBetween(ui.mFrom, ui.mTo);
  const byMonth = new Map(groupOrderFacts(facts, "month").map(group => [group.key, group]));
  const rows = sortRows(groupOrderFacts(facts, ui.pedDim), ui.pedSort, (a, b) => a.valueDelta - b.valueDelta || a.kgDelta - b.kgDelta || b.adjusted - a.adjusted);
  const th = (key, label, opts) => sortTh("ped-sort", ui.pedSort, key, label, opts);
  const dimName = { month: "Mês", nutri: "Nutricionista", school: "Escola", route: "GRE", item: "Item" }[ui.pedDim];
  const kgPct = total.kgPrev ? (total.kgFinal - total.kgPrev) / total.kgPrev : null;

  shell(`
    ${analyticsHead(`Ajustes das nutricionistas: previsto × final · ${formatMonthBR(ui.mFrom)} a ${formatMonthBR(ui.mTo)}`)}
    ${olderOrdersBar()}
    ${periodBarHtml(`<div class="field-group"><span class="label">Tipo de pedido</span>${segmentedHtml("ped-kind", ui.pedKind, ORDER_KINDS)}</div>`)}
    <section class="stat-row">
      ${statCard({ label: "Pedidos no período", value: fmtNumber(orders.length), hint: `${fmtNumber(total.lines)} itens distribuídos`, iconName: "cart", tone: "brand" })}
      ${statCard({ label: "Ajustes enviados", value: `${sentPairs}<small>/${pairs.size}</small>`, hint: "nutricionista × pedido", iconName: "send" })}
      ${statCard({ label: "Itens ajustados", value: `${total.lines ? fmtNumber(total.adjusted / total.lines * 100, 1) : 0}%`, hint: `${total.down} reduzidos · ${total.up} aumentados`, iconName: "edit" })}
      ${statCard({ label: "Variação em KG", value: pctText(kgPct), hint: `${fmtKg(total.kgPrev)} previstos → ${fmtKg(total.kgFinal)}`, iconName: "chart", tone: kgPct < 0 ? "brand" : kgPct > 0 ? "danger" : "" })}
      ${statCard({ label: "Pedido em R$ (final)", value: `<span class="sm-val">${money(total.valueFinal)}</span>`, hint: `previsto ${money(total.valuePrev)} · ${pctText(valuePct)}`, iconName: "cart" })}
    </section>
    <section class="an-grid">
      <article class="card chart-card span-2">
        <header class="chart-head"><div><h3>Previsto × final por mês (R$)</h3><p>Quanto o pedido mudou em reais depois dos ajustes enviados. Barra final menor = economia.</p></div></header>
        ${columnChart({ labels: months.map(monthShort), series: [
          { name: "Previsto", color: "#a3b8ae", values: months.map(month => byMonth.get(month)?.valuePrev || 0) },
          { name: "Final (com ajustes)", color: "#1f9d6f", values: months.map(month => byMonth.get(month)?.valueFinal || 0) }
        ], fmt: fmtMoneyShort, empty: "Nenhum pedido com valor no período" })}
      </article>
      <article class="card chart-card span-2">
        <header class="chart-head wrap"><div><h3>Comparar por ${dimName.toLowerCase()}</h3><p>Clique no título de uma coluna para ordenar do maior para o menor (clique de novo para inverter). Padrão: quem mais reduziu em R$.</p></div>
          ${segmentedHtml("ped-dim", ui.pedDim, [["month", "Mês"], ["nutri", "Nutricionista"], ["school", "Escola"], ["route", "GRE"], ["item", "Item"]])}</header>
        ${rows.length ? `<div class="table-scroll"><table class="data-table an-table">
          <thead><tr>${th("label", dimName, { num: false })}${th("lines", "Itens")}${th("adjusted", "Ajustados")}${th("down", "↓ Reduz.")}${th("up", "↑ Aum.")}${th("valuePrev", "R$ previsto")}${th("valueFinal", "R$ final")}${th("valueDelta", "Δ R$")}${th("kgPrev", "KG previsto")}${th("kgFinal", "KG final")}${th("kgDelta", "Δ KG")}${th("kgPct", "Δ % KG")}${th("relAvg", "Var. média/item")}</tr></thead>
          <tbody>${rows.map(row => `<tr>
            <td><strong>${esc(row.label)}</strong></td>
            <td class="num">${fmtNumber(row.lines)}</td>
            <td class="num">${fmtNumber(row.adjusted)} <small class="muted">${row.lines ? fmtNumber(row.adjusted / row.lines * 100, 0) : 0}%</small></td>
            <td class="num">${row.down || "<span class='muted'>0</span>"}</td>
            <td class="num">${row.up || "<span class='muted'>0</span>"}</td>
            <td class="num">${row.valuePrev ? money(row.valuePrev) : "<span class='muted'>—</span>"}</td>
            <td class="num"><strong>${row.valueFinal ? money(row.valueFinal) : "<span class='muted'>—</span>"}</strong></td>
            <td class="num">${row.valueDelta ? `<span class="diff ${row.valueDelta > 0 ? "up" : "down"}">${row.valueDelta > 0 ? "+" : ""}${money(row.valueDelta)}</span>` : "<span class='muted'>—</span>"}</td>
            <td class="num">${fmtNumber(row.kgPrev, 1)}</td>
            <td class="num">${fmtNumber(row.kgFinal, 1)}</td>
            <td class="num"><strong>${row.kgDelta > 0 ? "+" : ""}${fmtNumber(row.kgDelta, 1)}</strong></td>
            <td class="num">${deltaPill(row.kgPct)}</td>
            <td class="num">${deltaPill(row.relAvg)}</td>
          </tr>`).join("")}</tbody>
        </table></div>` : emptyState("Nenhum pedido no período", "Ajuste o período ou o tipo de pedido.", "cart")}
        <p class="form-hint">${icon("info")} Entram como ajuste só os pedidos que a nutricionista <b>enviou</b>; rascunhos contam como previsto. As colunas em KG somam só itens em quilo (CX, UND, L etc. ficam de fora da soma, mas entram na variação média por item). Os valores em R$ usam o <b>valor unitário do Inventário de Insumos</b> do item correspondente${total.noPrice ? ` — ${fmtNumber(total.noPrice)} linha(s) de pedido sem valor (item sem correspondente ou sem valor cadastrado, ex.: horti) ficam fora do R$` : ""}.</p>
      </article>
    </section>
  `);
  bindSegmented("ped-kind", value => { ui.pedKind = value; });
  bindSegmented("ped-dim", value => { ui.pedDim = value; });
  bindSortHeaders("ped-sort", ui.pedSort, renderAnalytics);
}

// ================================================================ ANALYTICS · INVENTÁRIO
function inventoryFacts({ from, to, month = "", onlySent = true }) {
  const schools = schoolMap();
  const items = new Map((mod().data.inventoryItems || []).map(item => [item.id, item]));
  const subs = mod().data.inventorySubmissions || {};
  const facts = [];
  for (const [m, bySchool] of Object.entries(mod().data.inventoryCounts || {})) {
    if (month ? m !== month : m < from || m > to) continue;
    for (const [schoolId, counts] of Object.entries(bySchool || {})) {
      const sent = Boolean(subs[m]?.[schoolId]);
      if (onlySent && !sent) continue;
      const school = schools.get(schoolId);
      for (const [itemId, row] of Object.entries(counts || {})) {
        const item = items.get(itemId);
        const quantity = Number(row?.quantity);
        if (!item || !Number.isFinite(quantity)) continue;
        const price = Number(item.price);
        facts.push({
          month: m, schoolId, nutriId: school?.nutritionistIds?.[0] || "", route: school?.route || "SEM ROTA", category: item.category, item: item.name,
          unit: String(item.unit || "").toUpperCase(), qty: quantity, value: Number.isFinite(price) && price > 0 ? quantity * price : null, sent
        });
      }
    }
  }
  return facts;
}

function groupInventoryFacts(facts, dim) {
  const keyOf = { month: f => f.month, nutri: f => f.nutriId, school: f => f.schoolId, route: f => f.route, category: f => f.category, item: f => f.item }[dim];
  const groups = new Map();
  for (const fact of facts) {
    const key = keyOf(fact);
    const group = groups.get(key) || { key, label: dimLabelOf(dim, key), rows: 0, schools: new Set(), kg: 0, value: 0, noPrice: 0 };
    group.rows += 1;
    group.schools.add(`${fact.month}:${fact.schoolId}`);
    if (fact.unit === "KG") group.kg += fact.qty;
    if (fact.value === null) group.noPrice += 1; else group.value += fact.value;
    groups.set(key, group);
  }
  return [...groups.values()];
}

function renderAnInventario() {
  const ui = anPeriod();
  ui.invDim ||= "school";
  if (ui.invOnlySent === undefined) ui.invOnlySent = true;
  const facts = inventoryFacts({ from: ui.mFrom, to: ui.mTo, onlySent: ui.invOnlySent });
  const months = monthsBetween(ui.mFrom, ui.mTo);
  const byMonth = new Map(groupInventoryFacts(facts, "month").map(group => [group.key, group]));
  const rows = groupInventoryFacts(facts, ui.invDim).sort((a, b) => b.value - a.value || b.kg - a.kg);
  const totalValue = facts.reduce((sum, fact) => sum + (fact.value || 0), 0);
  const totalKg = facts.filter(fact => fact.unit === "KG").reduce((sum, fact) => sum + fact.qty, 0);
  const noPrice = facts.filter(fact => fact.value === null).length;
  const lastMonth = ui.mTo;
  const sentLast = Object.keys(mod().data.inventorySubmissions?.[lastMonth] || {}).length;
  const useValue = totalValue > 0;
  const dimName = { month: "Mês", nutri: "Nutricionista", school: "Escola", route: "GRE", category: "Categoria", item: "Item" }[ui.invDim];
  const prevOf = month => byMonth.get(shiftMonth(month, -1));

  shell(`
    ${analyticsHead(`Estoque contado nas escolas · ${formatMonthBR(ui.mFrom)} a ${formatMonthBR(ui.mTo)}`)}
    ${periodBarHtml(`<div class="field-group"><span class="label">Considerar</span>${segmentedHtml("inv-sent", ui.invOnlySent ? "sent" : "all", [["sent", "Só enviados"], ["all", "Também em preenchimento"]])}</div>`)}
    <section class="stat-row">
      ${statCard({ label: `Inventários enviados · ${formatMonthBR(lastMonth)}`, value: `${sentLast}<small>/${state.db.schools.length}</small>`, iconName: "send", tone: "brand" })}
      ${statCard({ label: "Valor estimado em estoque", value: useValue ? money(totalValue) : "—", hint: noPrice ? `${noPrice} contagem(ns) sem valor unitário` : "todos os itens com valor", iconName: "chart" })}
      ${statCard({ label: "Estoque em KG", value: fmtKg(totalKg), iconName: "package" })}
      ${statCard({ label: "Itens contados", value: fmtNumber(facts.length), hint: `${fmtNumber(new Set(facts.map(fact => `${fact.month}:${fact.schoolId}`)).size)} inventário(s)`, iconName: "listTodo" })}
    </section>
    <section class="an-grid">
      <article class="card chart-card span-2">
        <header class="chart-head"><div><h3>${useValue ? "Valor em estoque por mês" : "Estoque em KG por mês"}</h3><p>${useValue ? "Quantidade contada × valor unitário do insumo (Inventário de Insumos)" : "Defina o valor unitário dos insumos para ver em R$"}</p></div></header>
        ${columnChart({ labels: months.map(monthShort), series: [{ name: useValue ? "Valor" : "KG", color: "#6250d6", values: months.map(month => useValue ? byMonth.get(month)?.value || 0 : byMonth.get(month)?.kg || 0) }], fmt: useValue ? fmtMoneyShort : fmtKg, empty: "Nenhum inventário no período" })}
      </article>
      <article class="card chart-card span-2">
        <header class="chart-head wrap"><div><h3>Comparar por ${dimName.toLowerCase()}</h3><p>${ui.invDim === "month" ? "Variação contra o mês anterior" : "Ordenado pelo maior valor em estoque"}</p></div>
          ${segmentedHtml("inv-dim", ui.invDim, [["month", "Mês"], ["nutri", "Nutricionista"], ["school", "Escola"], ["route", "GRE"], ["category", "Categoria"], ["item", "Item"]])}</header>
        ${rows.length ? `<div class="table-scroll"><table class="data-table an-table">
          <thead><tr><th>${dimName}</th><th class="num">Inventários</th><th class="num">Itens</th><th class="num">KG</th><th class="num">Valor</th>${ui.invDim === "month" ? `<th class="num">vs. mês anterior</th>` : ""}<th class="num">Sem valor</th></tr></thead>
          <tbody>${rows.map(row => {
            const prev = ui.invDim === "month" ? prevOf(row.key) : null;
            return `<tr>
              <td><strong>${esc(row.label)}</strong></td>
              <td class="num">${row.schools.size}</td>
              <td class="num">${fmtNumber(row.rows)}</td>
              <td class="num">${fmtNumber(row.kg, 1)}</td>
              <td class="num"><strong>${row.value ? money(row.value) : "—"}</strong></td>
              ${ui.invDim === "month" ? `<td class="num">${prev ? deltaPill(useValue ? (row.value - prev.value) / (prev.value || 1) : (row.kg - prev.kg) / (prev.kg || 1)) : "<span class='muted'>—</span>"}</td>` : ""}
              <td class="num">${row.noPrice || "<span class='muted'>0</span>"}</td>
            </tr>`;
          }).join("")}</tbody>
        </table></div>` : emptyState("Nenhum inventário no período", ui.invOnlySent ? "Ainda não há inventários enviados. Mude para “Também em preenchimento” para ver os rascunhos." : "As contagens das nutricionistas aparecem aqui.", "package")}
      </article>
    </section>
  `);
  bindSegmented("inv-sent", value => { ui.invOnlySent = value === "sent"; });
  bindSegmented("inv-dim", value => { ui.invDim = value; });
}

// ================================================================ ANALYTICS · INVENTÁRIO × PEDIDOS × MATRICULADOS
function crossMonths() {
  const months = new Set();
  for (const order of mod().data.orders || []) months.add(order.month);
  for (const month of Object.keys(mod().data.inventoryCounts || {})) months.add(month);
  return [...months].sort().reverse();
}

function productionMonths() {
  const months = new Set((state.db.entries || []).map(entry => String(entry.date || "").slice(0, 7)).filter(Boolean));
  return [...months].sort().reverse();
}

function computeCross(ui) {
  const schools = state.db.schools;
  const prices = new Map(state.db.cards.map(card => [card.id, Number(card.price) || 0]));
  const meals = new Map();
  const days = new Map();
  for (const entry of state.db.entries || []) {
    if (!String(entry.date || "").startsWith(ui.crossProd) || entry.status === "not_served") continue;
    meals.set(entry.schoolId, (meals.get(entry.schoolId) || 0) + entryValue(entry, prices).meals);
    if (!days.has(entry.schoolId)) days.set(entry.schoolId, new Set());
    days.get(entry.schoolId).add(entry.date);
  }
  const orderKg = new Map();
  const orderLines = new Map();
  const orderValue = new Map();
  for (const fact of orderFacts({ month: ui.crossMonth })) {
    orderLines.set(fact.schoolId, (orderLines.get(fact.schoolId) || 0) + 1);
    if (fact.valueFinal) orderValue.set(fact.schoolId, (orderValue.get(fact.schoolId) || 0) + fact.valueFinal);
    if (fact.unit === "KG") orderKg.set(fact.schoolId, (orderKg.get(fact.schoolId) || 0) + fact.final);
  }
  const stockKg = new Map();
  const stockValue = new Map();
  for (const fact of inventoryFacts({ month: ui.crossMonth, onlySent: false })) {
    if (fact.unit === "KG") stockKg.set(fact.schoolId, (stockKg.get(fact.schoolId) || 0) + fact.qty);
    if (fact.value) stockValue.set(fact.schoolId, (stockValue.get(fact.schoolId) || 0) + fact.value);
  }
  const enrollments = mod().data.enrollments || {};
  let rows = schools.map(school => {
    const matric = enrollmentTotal(enrollments[school.id]);
    const m = meals.get(school.id) || 0;
    const d = days.get(school.id)?.size || 0;
    const kg = orderKg.get(school.id) || 0;
    const stock = stockKg.has(school.id) ? stockKg.get(school.id) : null;
    return {
      school, matric, meals: m, days: d, orderKg: kg, orderLines: orderLines.get(school.id) || 0, stockKg: stock, stockValue: stockValue.get(school.id) || 0, orderValue: orderValue.get(school.id) || 0,
      valuePerStudent: matric && orderValue.get(school.id) ? orderValue.get(school.id) / matric : null,
      perStudentDay: matric && d ? m / (matric * d) : null,
      gPerMeal: m && kg ? kg * 1000 / m : null,
      kgPerStudent: matric && kg ? kg / matric : null,
      stockRatio: kg && stock !== null ? stock / kg : null
    };
  }).filter(row => row.matric || row.meals || row.orderKg || row.stockKg !== null);
  const med = {
    perStudentDay: median(rows.map(row => row.perStudentDay)),
    gPerMeal: median(rows.map(row => row.gPerMeal)),
    kgPerStudent: median(rows.map(row => row.kgPerStudent))
  };
  for (const row of rows) {
    const flags = [];
    if (row.orderKg && !row.matric) flags.push(["danger", "Pede sem matriculados cadastrados"]);
    if (row.gPerMeal !== null && med.gPerMeal) {
      if (row.gPerMeal > med.gPerMeal * 1.5) flags.push(["danger", "Pede muito para o que produz"]);
      else if (row.gPerMeal < med.gPerMeal * 0.5) flags.push(["warn", "Pede pouco para o que produz"]);
    }
    if (row.perStudentDay !== null && med.perStudentDay) {
      if (row.perStudentDay > med.perStudentDay * 1.5) flags.push(["warn", "Produção acima do esperado p/ matriculados"]);
      else if (row.perStudentDay < med.perStudentDay * 0.5) flags.push(["warn", "Produção baixa p/ matriculados"]);
    }
    if (row.stockRatio !== null && row.stockRatio >= 1) flags.push(["warn", "Estoque maior que o pedido do mês"]);
    if (row.orderKg && !row.meals) flags.push(["neutral", "Sem refeições lançadas no mês de produção"]);
    row.flags = flags;
    row.severity = flags.reduce((sum, [tone]) => sum + (tone === "danger" ? 3 : tone === "warn" ? 2 : 1), 0);
  }
  return { rows, med };
}

function renderAnCruzamento() {
  const ui = anPeriod();
  const orderMonths = crossMonths();
  const prodMonths = productionMonths();
  if (!ui.crossMonth || !orderMonths.includes(ui.crossMonth)) ui.crossMonth = orderMonths.find(month => month <= currentMonth()) || orderMonths[0] || currentMonth();
  if (!ui.crossProd || !prodMonths.includes(ui.crossProd)) ui.crossProd = prodMonths.find(month => month <= ui.crossMonth) || prodMonths[0] || ui.crossMonth;
  ui.crossRoute ||= "todas";
  ui.crossNutri ||= "todas";
  ui.crossSearch ||= "";
  const { rows: all, med } = computeCross(ui);
  const query = normalizeText(ui.crossSearch);
  const rows = all
    .filter(row => ui.crossRoute === "todas" || row.school.route === ui.crossRoute)
    .filter(row => ui.crossNutri === "todas" || row.school.nutritionistIds?.[0] === ui.crossNutri || (row.school.nutritionistIds || []).includes(ui.crossNutri))
    .filter(row => !ui.crossOnlyAlerts || row.flags.length)
    .filter(row => !query || normalizeText(row.school.shortName).includes(query))
    .sort((a, b) => b.severity - a.severity || b.orderKg - a.orderKg);
  const alerts = all.filter(row => row.flags.some(([tone]) => tone !== "neutral")).length;
  const sumOrder = rows.reduce((sum, row) => sum + row.orderValue, 0);
  const sumStock = rows.reduce((sum, row) => sum + row.stockValue, 0);
  const monthOptions = (list, selected) => list.map(month => `<option value="${month}" ${month === selected ? "selected" : ""}>${formatMonthBR(month)}</option>`).join("");

  shell(`
    ${analyticsHead("O que a escola tem, o que pede e o que produz, comparado com os matriculados")}
    ${olderOrdersBar()}
    <section class="card an-filters">
      <div class="an-filter-row">
        <label class="field-group"><span class="label">Pedido e inventário de</span><select id="cross-month">${monthOptions(orderMonths.length ? orderMonths : [ui.crossMonth], ui.crossMonth)}</select></label>
        <label class="field-group"><span class="label">Produção (refeições) de</span><select id="cross-prod">${monthOptions(prodMonths.length ? prodMonths : [ui.crossProd], ui.crossProd)}</select></label>
        <label class="field-group"><span class="label">GRE</span><select id="cross-route"><option value="todas">Todas</option>${routeOptionsHtml(ui.crossRoute)}</select></label>
        <label class="field-group"><span class="label">Nutricionista</span><select id="cross-nutri"><option value="todas">Todas</option>${nutriList().map(n => `<option value="${n.id}" ${ui.crossNutri === n.id ? "selected" : ""}>${esc(n.name)}</option>`).join("")}</select></label>
        <label class="search-field">${icon("search")}<input id="cross-search" placeholder="Buscar escola..." value="${esc(ui.crossSearch)}" /></label>
        <label class="check-inline"><input type="checkbox" id="cross-alerts" ${ui.crossOnlyAlerts ? "checked" : ""} /> Só escolas com alerta</label>
      </div>
    </section>
    <section class="stat-row">
      ${statCard({ label: "Escolas analisadas", value: fmtNumber(all.length), iconName: "school", tone: "brand" })}
      ${statCard({ label: "Pedido por refeição (mediana)", value: med.gPerMeal ? `${fmtNumber(med.gPerMeal, 0)} g` : "—", hint: "KG pedidos ÷ refeições produzidas", iconName: "utensils" })}
      ${statCard({ label: "Refeições por aluno/dia (mediana)", value: med.perStudentDay ? fmtNumber(med.perStudentDay, 2) : "—", hint: "soma de todos os cards", iconName: "users" })}
      ${statCard({ label: "Escolas com alerta", value: fmtNumber(alerts), iconName: "alert", tone: alerts ? "warn" : "" })}
      ${statCard({ label: "Pedido em R$", value: `<span class="sm-val">${money(sumOrder)}</span>`, hint: `final de ${formatMonthBR(ui.crossMonth)} · escolas filtradas`, iconName: "cart" })}
      ${statCard({ label: "Estoque em R$", value: `<span class="sm-val">${money(sumStock)}</span>`, hint: sumOrder ? `${fmtNumber(sumStock / sumOrder * 100, 0)}% do valor do pedido` : "inventário contado", iconName: "package" })}
    </section>
    <section class="card chart-card">
      <header class="chart-head"><div><h3>Cruzamento por escola</h3><p>Pedido de ${formatMonthBR(ui.crossMonth)} (KG final, com ajustes enviados) · estoque contado em ${formatMonthBR(ui.crossMonth)} · refeições lançadas em ${formatMonthBR(ui.crossProd)}</p></div></header>
      ${rows.length ? `<div class="table-scroll"><table class="data-table an-table cross-table">
        <thead><tr><th>Escola</th><th class="num">Matriculados</th><th class="num">Refeições</th><th class="num">Ref./aluno/dia</th><th class="num">Pedido (KG)</th><th class="num">g por refeição</th><th class="num">KG por aluno</th><th class="num">Pedido (R$)</th><th class="num">Estoque (KG)</th><th class="num">Estoque (R$)</th><th>Leitura</th></tr></thead>
        <tbody>${rows.map(row => `<tr class="${row.severity >= 3 ? "row-danger" : row.severity >= 2 ? "row-warn" : ""}">
          <td data-label="Escola"><strong>${esc(row.school.shortName)}</strong><small>${esc(routeLabel(row.school.route))} · ${esc(nutriNamesOf(row.school) || "—")}</small></td>
          <td class="num" data-label="Matriculados">${row.matric ? fmtNumber(row.matric) : "<span class='muted'>—</span>"}</td>
          <td class="num" data-label="Refeições">${row.meals ? fmtNumber(row.meals) : "<span class='muted'>—</span>"}${row.days ? `<small>${row.days} dia(s)</small>` : ""}</td>
          <td class="num" data-label="Ref./aluno/dia">${row.perStudentDay !== null ? fmtNumber(row.perStudentDay, 2) : "<span class='muted'>—</span>"}</td>
          <td class="num" data-label="Pedido (KG)"><strong>${row.orderKg ? fmtNumber(row.orderKg, 1) : "<span class='muted'>—</span>"}</strong></td>
          <td class="num" data-label="g por refeição">${row.gPerMeal !== null ? `${fmtNumber(row.gPerMeal, 0)} g` : "<span class='muted'>—</span>"}${row.gPerMeal !== null && med.gPerMeal ? `<small>${deltaPill(row.gPerMeal / med.gPerMeal - 1, { digits: 0 })} vs. rede</small>` : ""}</td>
          <td class="num" data-label="KG por aluno">${row.kgPerStudent !== null ? fmtNumber(row.kgPerStudent, 2) : "<span class='muted'>—</span>"}</td>
          <td class="num" data-label="Pedido (R$)"><strong>${row.orderValue ? money(row.orderValue) : "<span class='muted'>—</span>"}</strong>${row.valuePerStudent !== null ? `<small>${money(row.valuePerStudent)}/aluno</small>` : ""}</td>
          <td class="num" data-label="Estoque (KG)">${row.stockKg !== null ? fmtNumber(row.stockKg, 1) : "<span class='muted'>sem inventário</span>"}${row.stockRatio !== null ? `<small>${fmtNumber(row.stockRatio * 100, 0)}% do pedido</small>` : ""}</td>
          <td class="num" data-label="Estoque (R$)"><strong>${row.stockValue ? money(row.stockValue) : "<span class='muted'>—</span>"}</strong>${row.stockValue && row.orderValue ? `<small>${fmtNumber(row.stockValue / row.orderValue * 100, 0)}% do pedido</small>` : ""}</td>
          <td data-label="Leitura" class="wrap">${row.flags.length ? row.flags.map(([tone, text]) => `<span class="chip ${tone}">${esc(text)}</span>`).join(" ") : `<span class="chip ok">${icon("check")} Coerente</span>`}</td>
        </tr>`).join("")}</tbody>
      </table></div>` : emptyState("Nada para cruzar", "Escolha outro mês ou limpe os filtros.", "table")}
      <div class="cross-legend">
        <p>${icon("info")} <span><b>Como ler:</b> cada escola é comparada com a <b>mediana da rede</b>. “Pede muito/pouco para o que produz” = gramas pedidas por refeição 50% acima/abaixo da mediana (${med.gPerMeal ? `${fmtNumber(med.gPerMeal, 0)} g` : "—"}). “Produção acima/baixa” = refeições por aluno por dia 50% acima/abaixo da mediana. “Estoque maior que o pedido” = o inventário contado já cobre o pedido do mês.</span></p>
        <p>${icon("alert")} <span>Valores em R$: quantidade × valor unitário do Inventário de Insumos (itens do pedido sem correspondente ou sem valor, como o horti, ficam fora). Só itens em KG entram no peso. O pedido de um mês costuma ser para o consumo daquele mês; por isso você escolhe o mês de produção separadamente.</span></p>
      </div>
    </section>
  `);
  const set = patch => { Object.assign(ui, patch); renderAnalytics(); };
  $("#cross-month").addEventListener("change", event => set({ crossMonth: event.target.value }));
  $("#cross-prod").addEventListener("change", event => set({ crossProd: event.target.value }));
  $("#cross-route").addEventListener("change", event => set({ crossRoute: event.target.value }));
  $("#cross-nutri").addEventListener("change", event => set({ crossNutri: event.target.value }));
  $("#cross-alerts").addEventListener("change", event => set({ crossOnlyAlerts: event.target.checked }));
  $("#cross-search").addEventListener("input", debounce(event => { ui.crossSearch = event.target.value; renderAnalytics(); focusEnd("#cross-search"); }, 250));
}

// ================================================================ ANALYTICS · NOTIFICAÇÕES
function renderAnNotificacoes() {
  const ui = anPeriod();
  ui.ntfDim ||= "school";
  const schools = schoolMap();
  const users = userMap();
  const months = monthsBetween(ui.mFrom, ui.mTo);
  const list = (mod().data.notifications || []).filter(item => {
    const month = String(item.createdAt || "").slice(0, 7);
    return month >= ui.mFrom && month <= ui.mTo;
  });
  const legacy = list.filter(item => !item.schoolIds?.length).length;
  const groups = new Map();
  const add = (key, item) => {
    const group = groups.get(key) || { key, count: 0, open: 0, done: 0, last: "" };
    group.count += 1;
    if (item.finalFile) group.done += 1; else group.open += 1;
    if (String(item.createdAt) > group.last) group.last = item.createdAt;
    groups.set(key, group);
  };
  for (const item of list) {
    if (ui.ntfDim === "nutri") { for (const id of item.targetIds || []) add(id, item); continue; }
    if (!item.schoolIds?.length) continue;
    const keys = ui.ntfDim === "route" ? [...new Set(item.schoolIds.map(id => schools.get(id)?.route || "SEM ROTA"))] : item.schoolIds;
    for (const key of keys) add(key, item);
  }
  const labelOf = key => ui.ntfDim === "school" ? schools.get(key)?.shortName || key : ui.ntfDim === "route" ? routeLabel(key) : users.get(key)?.name || key;
  const ranking = [...groups.values()].map(group => ({ ...group, label: labelOf(group.key) })).sort((a, b) => b.count - a.count || String(b.last).localeCompare(String(a.last)));
  const done = list.filter(item => item.finalFile);
  const closeDays = done.map(item => daysBetween(String(item.createdAt).slice(0, 10), String(item.closedAt || item.createdAt).slice(0, 10)));
  const avgClose = closeDays.length ? closeDays.reduce((sum, value) => sum + value, 0) / closeDays.length : null;
  const notifiedSchools = new Set(list.flatMap(item => item.schoolIds || [])).size;
  const perMonth = months.map(month => list.filter(item => String(item.createdAt).startsWith(month)).length);
  const dimName = { school: "Escola", route: "GRE", nutri: "Nutricionista" }[ui.ntfDim];

  shell(`
    ${analyticsHead(`Escolas que mais recebem notificações · ${formatMonthBR(ui.mFrom)} a ${formatMonthBR(ui.mTo)}`)}
    ${periodBarHtml()}
    <section class="stat-row">
      ${statCard({ label: "Notificações", value: fmtNumber(list.length), iconName: "alertCircle", tone: "brand" })}
      ${statCard({ label: "Escolas notificadas", value: fmtNumber(notifiedSchools), hint: `de ${state.db.schools.length} escolas`, iconName: "school" })}
      ${statCard({ label: "Em andamento", value: fmtNumber(list.length - done.length), iconName: "clock", tone: list.length - done.length ? "warn" : "" })}
      ${statCard({ label: "Tempo médio até concluir", value: avgClose === null ? "—" : `${fmtNumber(avgClose, 1)} dia(s)`, hint: `${done.length} concluída(s)`, iconName: "check" })}
    </section>
    <section class="an-grid">
      <article class="card chart-card">
        <header class="chart-head wrap"><div><h3>Quem mais recebe notificações</h3><p>Ranking por ${dimName.toLowerCase()} no período</p></div>
          ${segmentedHtml("ntf-dim", ui.ntfDim, [["school", "Escola"], ["route", "GRE"], ["nutri", "Nutricionista"]])}</header>
        ${hbarList(ranking.map(row => ({ label: row.label, value: row.count, sub: `${row.open} em andamento · ${row.done} concluída(s)` })), { fmt: value => `${value}`, color: "#e34948", limit: 15 })}
        ${legacy && ui.ntfDim !== "nutri" ? `<p class="form-hint">${icon("info")} ${legacy} notificação(ões) antiga(s) foram enviadas por nutricionista, sem escola: aparecem só na visão por nutricionista.</p>` : ""}
      </article>
      <article class="card chart-card">
        <header class="chart-head"><div><h3>Notificações por mês</h3><p>Data de envio</p></div></header>
        ${columnChart({ labels: months.map(monthShort), series: [{ name: "Notificações", color: "#e34948", values: perMonth }], fmt: value => `${value}`, empty: "Nenhuma notificação no período" })}
      </article>
      <article class="card chart-card span-2">
        <header class="chart-head"><div><h3>Detalhe por ${dimName.toLowerCase()}</h3></div></header>
        ${ranking.length ? `<div class="table-scroll"><table class="data-table an-table">
          <thead><tr><th>#</th><th>${dimName}</th>${ui.ntfDim === "school" ? "<th>GRE</th><th>Nutricionista</th>" : ""}<th class="num">Notificações</th><th class="num">Em andamento</th><th class="num">Concluídas</th><th>Última</th></tr></thead>
          <tbody>${ranking.map((row, index) => {
            const school = ui.ntfDim === "school" ? schools.get(row.key) : null;
            return `<tr>
              <td class="muted">${index + 1}</td>
              <td><strong>${esc(row.label)}</strong></td>
              ${school ? `<td>${esc(routeLabel(school.route))}</td><td>${esc(nutriNamesOf(school) || "—")}</td>` : ui.ntfDim === "school" ? "<td></td><td></td>" : ""}
              <td class="num"><strong>${row.count}</strong></td>
              <td class="num">${row.open || "<span class='muted'>0</span>"}</td>
              <td class="num">${row.done || "<span class='muted'>0</span>"}</td>
              <td>${fmtDate(String(row.last).slice(0, 10))}</td>
            </tr>`;
          }).join("")}</tbody>
        </table></div>` : emptyState("Nenhuma notificação no período", "", "alertCircle")}
      </article>
    </section>
  `);
  bindSegmented("ntf-dim", value => { ui.ntfDim = value; });
}

// ================================================================ PEDIDOS · HISTÓRICO
const HIST_ACTIONS = {
  draft: { label: "Rascunho salvo", tone: "neutral", icon: "save" },
  sent: { label: "Ajuste enviado", tone: "info", icon: "send" },
  returned: { label: "Devolvido pela coordenação", tone: "warn", icon: "arrowRight" },
  finalized: { label: "Finalizado pela coordenação", tone: "ok", icon: "check" }
};

function histEntries() {
  const entries = [];
  for (const order of mod().data.orders || []) {
    for (const entry of order.history || []) entries.push({ ...entry, order });
  }
  return entries.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

function histValue(value, line) {
  return value === null || value === undefined ? `<span class="muted">${fmtQty(line.qty)} <small>(previsto)</small></span>` : `<b>${fmtQty(value)}</b>`;
}

function renderHistoricoPedidos() {
  const m = mod();
  const ui = m.ui.hist ||= { order: "todos", school: "todas", nutri: "todas", action: "todas", search: "", open: new Set(), limit: 30 };
  const isAdmin = state.user.role === "admin";
  const schools = schoolMap();
  const users = userMap();
  const all = histEntries();
  const query = normalizeText(ui.search);
  const filtered = all
    .filter(entry => ui.order === "todos" || entry.order.id === ui.order)
    .filter(entry => ui.nutri === "todas" || entry.nutritionistId === ui.nutri)
    .filter(entry => ui.action === "todas" || entry.action === ui.action)
    .map(entry => ({
      ...entry,
      shown: entry.changes.filter(change => (ui.school === "todas" || change.schoolId === ui.school)
        && (!query || normalizeText(`${change.item} ${schools.get(change.schoolId)?.shortName}`).includes(query)))
    }))
    .filter(entry => (ui.school === "todas" && !query) || entry.shown.length);
  const visible = filtered.slice(0, ui.limit);
  const changesTotal = all.reduce((sum, entry) => sum + entry.changes.length, 0);
  const itemsTouched = new Set(all.flatMap(entry => entry.changes.map(change => `${entry.order.id}:${change.lineId}`))).size;
  const sends = all.filter(entry => entry.action === "sent").length;
  const schoolIds = [...new Set(all.flatMap(entry => entry.changes.map(change => change.schoolId)))].sort((a, b) => String(schools.get(a)?.shortName).localeCompare(String(schools.get(b)?.shortName), "pt-BR"));
  const byDay = new Map();
  for (const entry of visible) {
    const day = String(entry.at).slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(entry);
  }
  if (!ui.touched) visible.slice(0, 3).forEach(entry => ui.open.add(entry.id));

  shell(`
    ${pageHead({
      eyebrow: "Pedidos",
      title: "Histórico",
      subtitle: isAdmin ? "Tudo o que as nutricionistas mudaram nos pedidos: quando, em qual escola, qual item e de quanto para quanto." : "Tudo o que você mudou nos pedidos: quando, em qual escola, qual item e de quanto para quanto."
    })}
    <section class="stat-row">
      ${statCard({ label: "Registros no histórico", value: fmtNumber(all.length), iconName: "clock", tone: "brand" })}
      ${statCard({ label: "Alterações de quantidade", value: fmtNumber(changesTotal), hint: `${fmtNumber(itemsTouched)} item(ns) diferentes`, iconName: "edit" })}
      ${statCard({ label: "Envios de ajuste", value: fmtNumber(sends), iconName: "send" })}
      ${statCard({ label: "Última alteração", value: all[0] ? fmtDate(String(all[0].at).slice(0, 10)) : "—", hint: all[0] ? fmtDateTime(all[0].at).split(" ").slice(-1)[0] : "", iconName: "calendar" })}
    </section>
    ${olderOrdersBar()}
    <section class="filter-bar hist-filters">
      <label class="inline-field grow">Pedido<select id="hist-order"><option value="todos">Todos os pedidos</option>${(m.data.orders || []).map(order => `<option value="${order.id}" ${ui.order === order.id ? "selected" : ""}>${esc(order.title)} — ${esc(formatMonthBR(order.month))}</option>`).join("")}</select></label>
      <label class="inline-field">Escola<select id="hist-school"><option value="todas">Todas</option>${schoolIds.map(id => `<option value="${id}" ${ui.school === id ? "selected" : ""}>${esc(schools.get(id)?.shortName || id)}</option>`).join("")}</select></label>
      ${isAdmin ? `<label class="inline-field">Nutricionista<select id="hist-nutri"><option value="todas">Todas</option>${nutriList().map(n => `<option value="${n.id}" ${ui.nutri === n.id ? "selected" : ""}>${esc(n.name)}</option>`).join("")}</select></label>` : ""}
      <label class="inline-field">Tipo<select id="hist-action"><option value="todas">Todos</option>${Object.entries(HIST_ACTIONS).map(([key, item]) => `<option value="${key}" ${ui.action === key ? "selected" : ""}>${item.label}</option>`).join("")}</select></label>
      <label class="search-field">${icon("search")}<input id="hist-search" placeholder="Buscar item ou escola..." value="${esc(ui.search)}" /></label>
    </section>
    <section class="hist-timeline">
      ${[...byDay.entries()].map(([day, entries]) => `<div class="hist-day">
        <h3 class="hist-day-title">${icon("calendar")} ${fmtDate(day)}</h3>
        ${entries.map(entry => histCard(entry, { isAdmin, schools, users, open: ui.open.has(entry.id) })).join("")}
      </div>`).join("") || `<div class="panel">${emptyState("Nada no histórico", all.length ? "Nenhum registro com esses filtros." : isAdmin ? "Quando as nutricionistas salvarem ou enviarem ajustes, as alterações aparecem aqui." : "Quando você salvar ou enviar um ajuste de pedido, as alterações aparecem aqui.", "clock")}</div>`}
      ${filtered.length > visible.length ? `<button type="button" class="secondary hist-more" id="hist-more">Mostrar mais (${filtered.length - visible.length})</button>` : ""}
    </section>
  `);

  const set = patch => { Object.assign(ui, patch, { limit: 30 }); renderHistoricoPedidos(); };
  $("#hist-order").addEventListener("change", event => set({ order: event.target.value }));
  $("#hist-school").addEventListener("change", event => set({ school: event.target.value }));
  $("#hist-nutri")?.addEventListener("change", event => set({ nutri: event.target.value }));
  $("#hist-action").addEventListener("change", event => set({ action: event.target.value }));
  $("#hist-search").addEventListener("input", debounce(event => { ui.search = event.target.value; renderHistoricoPedidos(); focusEnd("#hist-search"); }, 250));
  $("#hist-more")?.addEventListener("click", () => { ui.limit += 30; renderHistoricoPedidos(); });
  document.querySelectorAll("[data-hist-toggle]").forEach(button => button.addEventListener("click", () => {
    const card = button.closest(".hist-card");
    const id = button.dataset.histToggle;
    ui.touched = true;
    const open = !card.classList.contains("is-open");
    card.classList.toggle("is-open", open);
    button.setAttribute("aria-expanded", String(open));
    if (open) ui.open.add(id); else ui.open.delete(id);
  }));
}

function histCard(entry, { isAdmin, schools, users, open }) {
  const action = HIST_ACTIONS[entry.action] || HIST_ACTIONS.draft;
  const time = new Date(entry.at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const changes = entry.shown || entry.changes;
  const nutriName = users.get(entry.nutritionistId)?.name || "";
  const who = entry.action === "finalized" || entry.action === "returned" ? entry.by || "Coordenação" : isAdmin ? nutriName || entry.by : "Você";
  const summary = changes.length
    ? `${changes.length} item(ns) alterado(s)`
    : entry.action === "sent" ? "Enviado sem alterações — vale o previsto"
    : entry.action === "finalized" ? "Pedido finalizado"
    : entry.action === "returned" ? "Liberado para alterar e enviar de novo" : "Sem alterações";
  const bySchool = new Map();
  for (const change of changes) {
    if (!bySchool.has(change.schoolId)) bySchool.set(change.schoolId, []);
    bySchool.get(change.schoolId).push(change);
  }
  return `<article class="card hist-card ${open && changes.length ? "is-open" : ""}">
    <button type="button" class="hist-head" ${changes.length ? `data-hist-toggle="${entry.id}" aria-expanded="${open}"` : "disabled"}>
      <span class="hist-ico tone-${action.tone}">${icon(action.icon)}</span>
      <span class="hist-main">
        <strong>${esc(action.label)}</strong>
        <small>${time} · ${esc(who)}${isAdmin && who !== nutriName && nutriName ? ` · ${esc(nutriName)}` : ""}</small>
        <small class="hist-order">${icon("cart")} ${esc(entry.order.title)} · ${esc(formatMonthBR(entry.order.month))}</small>
      </span>
      <span class="hist-sum">${esc(summary)}${entry.imported ? ` <span class="chip neutral" title="Registro montado a partir do ajuste que já existia antes do histórico">anterior</span>` : ""}</span>
      ${changes.length ? `<span class="chev">${icon("chevronDown")}</span>` : ""}
    </button>
    ${changes.length ? `<div class="hist-body">${[...bySchool.entries()].map(([schoolId, list]) => `<div class="hist-school">
      <h4>${icon("school")} ${esc(schools.get(schoolId)?.shortName || schoolId)}</h4>
      <table class="data-table hist-table">
        <thead><tr><th>Item</th><th class="num">Previsto</th><th class="num">Antes</th><th class="num">Depois</th><th class="num">vs. previsto</th></tr></thead>
        <tbody>${list.map(change => {
          const final = change.to === null || change.to === undefined ? change.qty : change.to;
          const diff = final - change.qty;
          return `<tr>
            <td class="ot-item">${esc(change.item)}${change.unit ? ` <small class="ot-unit">${esc(change.unit)}</small>` : ""}</td>
            <td class="num" data-label="Previsto">${fmtQty(change.qty)}</td>
            <td class="num" data-label="Antes">${histValue(change.from, change)}</td>
            <td class="num" data-label="Depois">${histValue(change.to, change)}</td>
            <td class="num" data-label="vs. previsto">${diff ? `<span class="diff ${diff > 0 ? "up" : "down"}">${diff > 0 ? "+" : ""}${fmtQty(diff)}</span>` : "<span class='muted'>—</span>"}</td>
          </tr>`;
        }).join("")}</tbody>
      </table>
    </div>`).join("")}</div>` : ""}
  </article>`;
}
// ================================================================ ANALYTICS · REGISTRO DE GÁS
function renderAnGas() {
  const ui = anPeriod();
  const data = mod().data;
  const schools = schoolMap();
  const users = userMap();
  const months = monthsBetween(ui.mFrom, ui.mTo);
  const records = (data.gasRecords || []).filter(item => item.month >= ui.mFrom && item.month <= ui.mTo);
  const totalQty = records.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  const totalValue = records.reduce((sum, item) => sum + (Number(item.total) || 0), 0);
  const byMonth = months.map(month => records.filter(item => item.month === month).reduce((sum, item) => sum + (Number(item.total) || 0), 0));

  const aggregate = keyOf => {
    const map = new Map();
    for (const item of records) {
      const key = keyOf(item);
      if (!key) continue;
      const row = map.get(key) || { key, qty: 0, value: 0, deliveries: 0 };
      row.qty += Number(item.quantity) || 0;
      row.value += Number(item.total) || 0;
      row.deliveries += 1;
      map.set(key, row);
    }
    return [...map.values()];
  };
  const bySchool = aggregate(item => item.schoolId).sort((a, b) => b.value - a.value || b.qty - a.qty);
  const byNutri = aggregate(item => item.nutritionistId).sort((a, b) => b.value - a.value || b.qty - a.qty);
  const topReceiving = [...bySchool].sort((a, b) => b.qty - a.qty).slice(0, 10);
  const maxQty = Math.max(1, ...bySchool.map(row => row.qty));

  shell(`
    ${analyticsHead(`Registro de Gás · ${formatMonthBR(ui.mFrom)} a ${formatMonthBR(ui.mTo)}`)}
    ${periodBarHtml()}
    <section class="stat-row">
      ${statCard({ label: "Botijões no período", value: fmtNumber(totalQty), iconName: "package", tone: "brand" })}
      ${statCard({ label: "Valor gasto no período", value: `<span class="sm-val">${money(totalValue)}</span>`, iconName: "chart", tone: totalValue ? "warn" : "" })}
      ${statCard({ label: "Escolas atendidas", value: fmtNumber(bySchool.length), iconName: "school" })}
      ${statCard({ label: "Média por escola", value: `<span class="sm-val">${money(bySchool.length ? totalValue / bySchool.length : 0)}</span>`, iconName: "calculator" })}
    </section>
    <section class="an-grid">
      <article class="card chart-card span-2">
        <header class="chart-head"><div><h3>Valor gasto por mês</h3><p>Soma de todos os registros de gás do mês</p></div></header>
        ${columnChart({ labels: months.map(monthShort), series: [{ name: "Valor", color: "#eb6834", values: byMonth }], fmt: value => fmtMoneyShort(value), empty: "Nenhum registro de gás no período" })}
      </article>
      <article class="card chart-card">
        <header class="chart-head"><div><h3>Quem mais recebe gás</h3><p>Botijões no período, por escola</p></div></header>
        ${topReceiving.length ? hbarList(topReceiving.map(row => ({ label: schools.get(row.key)?.shortName || row.key, value: row.qty, sub: `${row.deliveries} entrega(s) · ${money(row.value)}` })), { fmt: value => `${fmtNumber(value)} bot.`, color: "#2a78d6", limit: 10 }) : emptyState("Sem entregas no período", "Os registros do Registro de Gás aparecem aqui.", "package")}
      </article>
      <article class="card chart-card">
        <header class="chart-head"><div><h3>Por nutricionista</h3><p>Valor gasto nas escolas de cada nutricionista</p></div></header>
        ${byNutri.length ? `<div class="table-scroll"><table class="data-table an-table">
          <thead><tr><th>Nutricionista</th><th class="num">Botijões</th><th class="num">Valor</th></tr></thead>
          <tbody>${byNutri.map(row => `<tr><td><strong>${esc(users.get(row.key)?.name || row.key)}</strong></td><td class="num">${fmtNumber(row.qty)}</td><td class="num"><strong>${money(row.value)}</strong></td></tr>`).join("")}</tbody>
        </table></div>` : emptyState("Sem entregas no período", "", "package")}
      </article>
      <article class="card chart-card span-2">
        <header class="chart-head"><div><h3>Escolas: quem mais gasta</h3><p>Ordenado pelo valor gasto no período</p></div></header>
        ${bySchool.length ? `<div class="table-scroll"><table class="data-table an-table">
          <thead><tr><th>#</th><th>Escola</th><th>GRE</th><th class="bar-col">Botijões</th><th class="num">Entregas</th><th class="num">Botijões</th><th class="num">Valor</th></tr></thead>
          <tbody>${bySchool.map((row, index) => `<tr>
            <td class="muted">${index + 1}</td>
            <td><strong>${esc(schools.get(row.key)?.shortName || row.key)}</strong></td>
            <td>${esc(routeLabel(schools.get(row.key)?.route))}</td>
            <td class="bar-col"><span class="rank-bar"><i style="width:${(row.qty / maxQty * 100).toFixed(1)}%;background:#2a78d6"></i></span></td>
            <td class="num">${fmtNumber(row.deliveries)}</td>
            <td class="num">${fmtNumber(row.qty)}</td>
            <td class="num"><strong>${money(row.value)}</strong></td>
          </tr>`).join("")}</tbody>
        </table></div>` : emptyState("Sem entregas no período", "Os registros do Registro de Gás aparecem aqui.", "package")}
      </article>
    </section>
  `);
}

