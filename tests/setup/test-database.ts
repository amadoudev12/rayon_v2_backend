import { config } from "dotenv";

// La configuration des tests vit dans `.env.test` (jamais dans `.env`) : la
// base de développement et la base de test ne partagent ainsi aucune variable.
config({ path: ".env.test", quiet: true });
// `.env` est lu ensuite (sans écraser) uniquement pour connaître DATABASE_URL
// et refuser une base de test qui serait la même.
config({ quiet: true });

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * URL de la base de test : uniquement `TEST_DATABASE_URL`.
 *
 * Les tests vident toutes les tables. Garde-fous, tous obligatoires :
 * - `TEST_DATABASE_URL` doit être définie : il n'y a AUCUN repli sur
 *   `DATABASE_URL` ;
 * - elle doit désigner une autre base que `DATABASE_URL` (et que `DIRECT_URL`) ;
 * - le nom de la base doit se terminer par `_test` ;
 * - le serveur doit être local, sauf dérogation explicite
 *   (`ALLOW_REMOTE_TEST_DATABASE=true`, réservée à la CI).
 */
export function getTestDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) {
    throw new Error(
      "TEST_DATABASE_URL est requise pour lancer les tests (voir .env.example et docker-compose.test.yml). " +
        "Les tests ne s'exécutent jamais sur DATABASE_URL.",
    );
  }

  const url = new URL(raw);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!databaseName.endsWith("_test")) {
    throw new Error(`Base de test refusée : « ${databaseName} » ne se termine pas par _test.`);
  }

  for (const name of ["DATABASE_URL", "DIRECT_URL"] as const) {
    const other = process.env[name];
    if (other && sameDatabase(new URL(other), url)) {
      throw new Error(`Base de test refusée : TEST_DATABASE_URL désigne la même base que ${name}.`);
    }
  }

  if (!LOCAL_HOSTS.has(url.hostname) && process.env.ALLOW_REMOTE_TEST_DATABASE !== "true") {
    throw new Error(`Base de test refusée : le serveur « ${url.hostname} » n'est pas local.`);
  }

  return url.toString();
}

function sameDatabase(a: URL, b: URL): boolean {
  const port = (url: URL) => url.port || "5432";
  const host = (url: URL) => (LOCAL_HOSTS.has(url.hostname) ? "localhost" : url.hostname);
  return host(a) === host(b) && port(a) === port(b) && a.pathname === b.pathname;
}
