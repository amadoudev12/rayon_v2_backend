/**
 * Test de charge de l'API Rayon sur une base JETABLE (jamais une vraie base).
 *
 *   LOAD_DATABASE_URL=postgresql://…/rayon_load_test npx tsx scripts/load/run.ts
 *
 * 1. remplit la base (scripts/load/seed.sql) ;
 * 2. démarre l'API dans un processus séparé (port 4100) ;
 * 3. ouvre une session par compte (propriétaires et vendeurs) ;
 * 4. envoie un mélange réaliste de lectures et de ventes, par paliers
 *    d'utilisateurs simultanés, et mesure latences (p50/p95/p99), débit et erreurs.
 */
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { hash } from "bcrypt";

const url = process.env.LOAD_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("LOAD_DATABASE_URL doit désigner une base jetable *_test.");
const PORT = 4100;
/** Nombre d'instances de l'API (ports 4100, 4101…), réparties entre les utilisateurs virtuels. */
const INSTANCES = Number(process.env.LOAD_INSTANCES ?? 1);
const BASES = Array.from({ length: INSTANCES }, (_, index) => `http://localhost:${PORT + index}`);
const BASE = BASES[0]!;
const PASSWORD = "Charge123";
const STAGES = (process.env.LOAD_STAGES ?? "10,50,100").split(",").map(Number);
const STAGE_SECONDS = Number(process.env.LOAD_SECONDS ?? 20);

type Account = { email: string; token: string; organizationId: number; storeId: number; productIds: number[] };

function psql(args: string[], input?: string) {
  return execFileSync("docker", ["exec", "-i", "rayon-test-db", "psql", "-v", "ON_ERROR_STOP=1", "-q", "-U", "rayon_test", ...args], { input, maxBuffer: 1 << 26 }).toString();
}

async function seed() {
  const database = new URL(url!).pathname.slice(1);
  psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${database}`, "-c", `CREATE DATABASE ${database}`]);
  execFileSync("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url }, stdio: "ignore", shell: true });
  const started = Date.now();
  const sql = (await import("node:fs")).readFileSync("scripts/load/seed.sql", "utf8");
  psql(["-d", database, "-v", `hash=${await hash(PASSWORD, 12)}`], sql);
  console.log(`Base remplie en ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

async function waitForServer(base: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(`${base}/health/ready`)).ok) return;
    } catch {
      /* pas encore prêt */
    }
    await sleep(500);
  }
  throw new Error("Le serveur n'a pas démarré.");
}

async function login(email: string): Promise<string> {
  const response = await fetch(`${BASE}/api/mobile/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({ identifiant: email, motDePasse: PASSWORD }),
  });
  if (!response.ok) throw new Error(`Connexion impossible (${email}) : ${response.status}`);
  return ((await response.json()) as { data: { token: string } }).data.token;
}

async function accounts(pattern: string): Promise<Account[]> {
  const rows = psql(["-d", new URL(url!).pathname.slice(1), "-At", "-F", "|", "-c",
    `SELECT u."email", m."organisationId", (SELECT b."id" FROM "Boutique" b WHERE b."organisationId" = m."organisationId" AND b."parDefaut"),
            (SELECT string_agg(p."id"::text, ',') FROM (SELECT "id" FROM "Produit" WHERE "organisationId" = m."organisationId" ORDER BY "id" LIMIT 200) p)
     FROM "Utilisateur" u JOIN "Membre" m ON m."utilisateurId" = u."id" WHERE u."email" LIKE '${pattern}' ORDER BY u."id"`]).trim().split("\n");
  const result: Account[] = [];
  for (const row of rows) {
    const [email, organizationId, storeId, products] = row.split("|");
    result.push({ email: email!, token: await login(email!), organizationId: Number(organizationId), storeId: Number(storeId), productIds: products!.split(",").map(Number) });
  }
  return result;
}

const pick = <T,>(items: T[]) => items[Math.floor(Math.random() * items.length)]!;

type Scenario = { name: string; weight: number; run: (owner: Account, seller: Account, base: string) => Promise<Response> };
const auth = (account: Account) => ({ Authorization: `Bearer ${account.token}` });

const SCENARIOS: Scenario[] = [
  { name: "GET tableau de bord", weight: 20, run: (o, _s, base) => fetch(`${base}/api/dashboard?storeId=${o.storeId}`, { headers: auth(o) }) },
  { name: "GET liste des ventes", weight: 15, run: (o, _s, base) => fetch(`${base}/api/sales?storeId=${o.storeId}&page=${1 + Math.floor(Math.random() * 20)}`, { headers: auth(o) }) },
  { name: "GET statistiques du mois", weight: 15, run: (o, _s, base) => fetch(`${base}/api/sales/stats?storeId=${o.storeId}&periode=month`, { headers: auth(o) }) },
  { name: "GET recherche produits", weight: 15, run: (o, _s, base) => fetch(`${base}/api/products?storeId=${o.storeId}&search=Article%20${1 + Math.floor(Math.random() * 99)}`, { headers: auth(o) }) },
  { name: "GET stock bas", weight: 10, run: (o, _s, base) => fetch(`${base}/api/stock?storeId=${o.storeId}&lowStock=true`, { headers: auth(o) }) },
  {
    name: "POST vente (vendeur)",
    weight: 25,
    run: (_o, s, base) =>
      fetch(`${base}/api/sales`, {
        method: "POST",
        headers: { ...auth(s), "Content-Type": "application/json", "Idempotency-Key": `load-${Date.now()}-${Math.random().toString(36).slice(2)}` },
        body: JSON.stringify({ boutiqueId: s.storeId, modePaiement: "CASH", lignes: [{ produitId: pick(s.productIds), quantite: 1 }, { produitId: pick(s.productIds), quantite: 2 }] }),
      }),
  },
];

function chooseScenario(): Scenario {
  const total = SCENARIOS.reduce((sum, scenario) => sum + scenario.weight, 0);
  let roll = Math.random() * total;
  for (const scenario of SCENARIOS) {
    roll -= scenario.weight;
    if (roll <= 0) return scenario;
  }
  return SCENARIOS[0]!;
}

const percentile = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : 0);

async function stage(users: number, owners: Account[], sellers: Account[]) {
  const latencies = new Map<string, number[]>();
  const errors = new Map<string, number>();
  const perBase = new Map<string, { count: number; total: number }>();
  const deadline = Date.now() + STAGE_SECONDS * 1000;
  await Promise.all(
    Array.from({ length: users }, async (_, index) => {
      // Un vendeur distinct par utilisateur virtuel (la limite est par vendeur).
      const seller = sellers[index % sellers.length]!;
      const owner = owners.find((item) => item.organizationId === seller.organizationId) ?? owners[0]!;
      while (Date.now() < deadline) {
        const scenario = chooseScenario();
        const started = performance.now();
        try {
          const base = BASES[index % BASES.length]!;
          const response = await scenario.run(owner, seller, base);
          const stat = perBase.get(base) ?? { count: 0, total: 0 };
          stat.count += 1;
          stat.total += performance.now() - started;
          perBase.set(base, stat);
          await response.arrayBuffer();
          if (!response.ok) errors.set(`${scenario.name} → ${response.status}`, (errors.get(`${scenario.name} → ${response.status}`) ?? 0) + 1);
        } catch {
          errors.set(`${scenario.name} → réseau`, (errors.get(`${scenario.name} → réseau`) ?? 0) + 1);
        }
        const list = latencies.get(scenario.name) ?? [];
        list.push(performance.now() - started);
        latencies.set(scenario.name, list);
      }
    }),
  );
  const all = [...latencies.values()].flat().sort((a, b) => a - b);
  console.log(`\n=== ${users} utilisateurs simultanés, ${STAGE_SECONDS} s : ${all.length} requêtes, ${(all.length / STAGE_SECONDS).toFixed(0)} req/s`);
  console.log(`Global : p50 ${percentile(all, 50).toFixed(0)} ms · p95 ${percentile(all, 95).toFixed(0)} ms · p99 ${percentile(all, 99).toFixed(0)} ms`);
  for (const [name, values] of latencies) {
    const sorted = values.sort((a, b) => a - b);
    console.log(`  ${name.padEnd(26)} n=${String(sorted.length).padStart(5)}  p50 ${percentile(sorted, 50).toFixed(0).padStart(5)} ms  p95 ${percentile(sorted, 95).toFixed(0).padStart(5)} ms  p99 ${percentile(sorted, 99).toFixed(0).padStart(5)} ms`);
  }
  if (BASES.length > 1) {
    console.log(`Par instance : ${[...perBase].map(([base, stat]) => `${base.split(":").pop()} n=${stat.count} moyenne ${(stat.total / stat.count).toFixed(0)} ms`).join(" · ")}`);
  }
  console.log(errors.size ? `Erreurs : ${JSON.stringify(Object.fromEntries(errors))}` : "Erreurs : aucune");
}

async function main() {
  if (process.env.LOAD_SKIP_SEED !== "true") await seed();
  // Lancé directement avec node (sans shell) : kill() arrête bien le serveur.
  const servers = BASES.map((_, index) => spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: url,
      DIRECT_URL: url,
      PORT: String(PORT + index),
      NODE_ENV: "production",
      LOG_HTTP: "false",
      AUTH_SECRET: "charge-secret-uniquement-pour-le-test-de-charge-0123456789",
      TRUST_PROXY_HOPS: "1",
    },
    stdio: ["ignore", "ignore", "inherit"],
  }));
  console.log(`Instances : ${INSTANCES} · pool par instance : ${process.env.DATABASE_POOL_MAX ?? 10} · paliers : ${STAGES.join(", ")} utilisateurs · ${STAGE_SECONDS} s chacun`);
  try {
    for (const base of BASES) await waitForServer(base);
    const owners = await accounts("owner%@charge.test");
    const sellers = await accounts("seller%@charge.test");
    console.log(`${owners.length} propriétaires et ${sellers.length} vendeurs connectés.`);
    for (const users of STAGES) await stage(users, owners, sellers);
  } finally {
    for (const server of servers) server.kill("SIGKILL");
  }
}

void main().then(() => process.exit(0), (error) => {
  console.error(error);
  process.exit(1);
});
