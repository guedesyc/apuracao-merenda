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

function bestMatch(target, rows, fields) {
  const needle = normalize(target);
  const exact = rows.find(row => fields.some(field => normalize(row[field]) === needle));
  if (exact) return { row: exact, confidence: "exact" };

  const contains = rows.find(row => fields.some(field => {
    const haystack = normalize(row[field]);
    return haystack && needle && (haystack.includes(needle) || needle.includes(haystack));
  }));
  if (contains) return { row: contains, confidence: "partial" };

  return { row: null, confidence: "missing" };
}

function schoolName(school) {
  return typeof school === "string" ? school : school.name;
}

function shouldCreateSchool(school) {
  return typeof school === "object" && school !== null && school.createIfMissing === true;
}

async function selectAll(client, table) {
  const { data, error } = await client.from(table).select("*");
  if (error) throw new Error(`${table}: ${error.message}`);
  return data || [];
}

function countExpected(config) {
  return config.nutritionists.reduce((sum, nutritionist) => {
    return sum + nutritionist.routes.reduce((routeSum, route) => routeSum + route.schools.length, 0);
  }, 0);
}

async function main() {
  loadDotEnv();
  const config = JSON.parse(fs.readFileSync(ASSIGNMENTS_FILE, "utf8"));
  const client = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false }
  });

  const [profiles, schools, routes, currentAssignments] = await Promise.all([
    selectAll(client, "profiles"),
    selectAll(client, "schools"),
    selectAll(client, "routes"),
    selectAll(client, "nutritionist_schools")
  ]);

  const routeById = new Map(routes.map(route => [route.id, route.name]));
  const currentBySchool = new Map();
  for (const item of currentAssignments) currentBySchool.set(item.school_id, item.profile_id);

  const report = {
    createdAt: new Date().toISOString(),
    source: path.relative(ROOT, ASSIGNMENTS_FILE),
    expectedAssignments: countExpected(config),
    matched: [],
    unmatchedNutritionists: [],
    unmatchedSchools: [],
    schoolsToCreate: [],
    routeChanges: [],
    nutritionistChanges: []
  };

  for (const nutritionist of config.nutritionists) {
    const profileMatch = bestMatch(nutritionist.name, profiles.filter(profile => profile.role === "nutritionist"), ["name"]);
    if (!profileMatch.row) {
      report.unmatchedNutritionists.push({ nutritionist: nutritionist.name });
      continue;
    }

    for (const route of nutritionist.routes) {
      for (const schoolConfig of route.schools) {
        const name = schoolName(schoolConfig);
        const schoolMatch = bestMatch(name, schools, ["name", "short_name"]);
        if (!schoolMatch.row) {
          const item = { nutritionist: nutritionist.name, route: route.name, school: name };
          if (shouldCreateSchool(schoolConfig)) report.schoolsToCreate.push(item);
          else report.unmatchedSchools.push(item);
          continue;
        }

        const school = schoolMatch.row;
        const currentRoute = routeById.get(school.route_id) || "";
        const desiredRouteId = routeId(route.name);
        const currentProfileId = currentBySchool.get(school.id) || "";

        const item = {
          schoolId: school.id,
          school: school.short_name || school.name,
          schoolMatch: schoolMatch.confidence,
          desiredRoute: route.name,
          currentRoute,
          desiredNutritionistId: profileMatch.row.id,
          desiredNutritionist: profileMatch.row.name,
          nutritionistMatch: profileMatch.confidence,
          currentNutritionistId: currentProfileId
        };

        report.matched.push(item);
        if (school.route_id !== desiredRouteId) report.routeChanges.push(item);
        if (currentProfileId !== profileMatch.row.id) report.nutritionistChanges.push(item);
      }
    }
  }

  const outDir = path.join(ROOT, "route-previews");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  console.log(`Esperados: ${report.expectedAssignments}`);
  console.log(`Encontrados: ${report.matched.length}`);
  console.log(`Nutricionistas nao encontradas: ${report.unmatchedNutritionists.length}`);
  console.log(`Escolas nao encontradas: ${report.unmatchedSchools.length}`);
  console.log(`Escolas novas previstas: ${report.schoolsToCreate.length}`);
  console.log(`Mudancas de rota previstas: ${report.routeChanges.length}`);
  console.log(`Mudancas de nutricionista previstas: ${report.nutritionistChanges.length}`);
  console.log(`Relatorio salvo em: ${outFile}`);

  if (report.unmatchedNutritionists.length || report.unmatchedSchools.length) process.exitCode = 2;
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
