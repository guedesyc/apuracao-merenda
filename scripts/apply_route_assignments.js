const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const ROOT = path.resolve(__dirname, "..");
const ASSIGNMENTS_FILE = path.join(ROOT, "data", "official-route-assignments.json");

function loadDotEnv() {
  const envFile = [".env", "env.env"].map(file => path.join(ROOT, file)).find(file => fs.existsSync(file));
  if (!envFile) return;
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

function requiredEnv(name) {
  if (!process.env[name]) throw new Error(`Configure ${name} no ambiente, no arquivo .env ou no arquivo env.env.`);
  return process.env[name];
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(e\.?\s*m\.?|em|cmei)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function routeId(name) {
  return `route-${String(name || "sem-rota")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "sem-rota"}`;
}

function schoolName(school) {
  return typeof school === "string" ? school : school.name;
}

function bestMatch(target, rows, fields) {
  const needle = normalize(target);
  const exact = rows.find(row => fields.some(field => normalize(row[field]) === needle));
  if (exact) return exact;

  return rows.find(row => fields.some(field => {
    const haystack = normalize(row[field]);
    return haystack && needle && (haystack.includes(needle) || needle.includes(haystack));
  })) || null;
}

async function selectAll(client, table) {
  const { data, error } = await client.from(table).select("*");
  if (error) throw new Error(`${table}: ${error.message}`);
  return data || [];
}

async function main() {
  if (!process.argv.includes("--apply")) {
    throw new Error("Use: node scripts/apply_route_assignments.js --apply");
  }

  loadDotEnv();
  const config = JSON.parse(fs.readFileSync(ASSIGNMENTS_FILE, "utf8"));
  const client = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false }
  });

  const [profiles, schools] = await Promise.all([
    selectAll(client, "profiles"),
    selectAll(client, "schools")
  ]);

  const nutritionists = profiles.filter(profile => profile.role === "nutritionist");
  const desiredRoutes = new Map();
  const updates = [];
  const unmatchedNutritionists = [];
  const unmatchedSchools = [];

  for (const nutritionist of config.nutritionists) {
    const profile = bestMatch(nutritionist.name, nutritionists, ["name"]);
    if (!profile) {
      unmatchedNutritionists.push(nutritionist.name);
      continue;
    }

    for (const route of nutritionist.routes) {
      desiredRoutes.set(routeId(route.name), route.name);
      for (const schoolConfig of route.schools) {
        const name = schoolName(schoolConfig);
        const school = bestMatch(name, schools, ["name", "short_name"]);
        if (!school) {
          unmatchedSchools.push({ nutritionist: nutritionist.name, route: route.name, school: name });
          continue;
        }
        updates.push({
          schoolId: school.id,
          school: school.short_name || school.name,
          routeId: routeId(route.name),
          routeName: route.name
        });
      }
    }
  }

  const duplicateSchoolIds = updates
    .map(item => item.schoolId)
    .filter((id, index, list) => list.indexOf(id) !== index);

  if (unmatchedNutritionists.length || unmatchedSchools.length || duplicateSchoolIds.length) {
    console.log(JSON.stringify({ unmatchedNutritionists, unmatchedSchools, duplicateSchoolIds }, null, 2));
    throw new Error("Aplicacao interrompida: revise as pendencias acima.");
  }

  const routeRows = [...desiredRoutes.entries()].map(([id, name]) => ({ id, name }));
  const { error: routesError } = await client.from("routes").upsert(routeRows, { onConflict: "id" });
  if (routesError) throw routesError;

  let changed = 0;
  for (const update of updates) {
    const { error } = await client
      .from("schools")
      .update({ route_id: update.routeId, updated_at: new Date().toISOString() })
      .eq("id", update.schoolId)
      .neq("route_id", update.routeId);
    if (error) throw new Error(`${update.school}: ${error.message}`);
    changed += 1;
  }

  const outDir = path.join(ROOT, "route-previews");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `apply-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    appliedAt: new Date().toISOString(),
    routesUpserted: routeRows.length,
    schoolsChecked: updates.length,
    schoolUpdatesAttempted: changed,
    source: path.relative(ROOT, ASSIGNMENTS_FILE)
  }, null, 2));

  console.log(`Rotas garantidas: ${routeRows.length}`);
  console.log(`Escolas verificadas: ${updates.length}`);
  console.log(`Atualizacoes de rota tentadas: ${changed}`);
  console.log(`Relatorio salvo em: ${outFile}`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
