import { execSync } from "node:child_process";
import { Client } from "pg";
import { getTestDatabaseUrl } from "./test-database";

/**
 * Exécuté une fois avant tous les tests : crée la base de test si besoin puis
 * y applique les migrations Prisma, pour qu'elle ait exactement le schéma de
 * production.
 */
export default async function globalSetup() {
  const testUrl = getTestDatabaseUrl();
  const url = new URL(testUrl);
  const databaseName = decodeURIComponent(url.pathname.slice(1));

  // On ne peut pas créer une base en étant connecté dessus : on passe par la
  // base de maintenance `postgres`, présente sur tout serveur PostgreSQL.
  const adminUrl = new URL(testUrl);
  adminUrl.pathname = "/postgres";

  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    // PostgreSQL n'a pas de `CREATE DATABASE IF NOT EXISTS`.
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName]);
    if (existing.rowCount === 0) {
      await client.query(`CREATE DATABASE "${databaseName.replaceAll('"', '""')}"`);
    }
  } finally {
    await client.end();
  }

  execSync("npx prisma migrate deploy", {
    // DIRECT_URL est prioritaire dans prisma.config.ts : on la force aussi,
    // sinon les migrations partiraient sur la vraie base.
    env: { ...process.env, DATABASE_URL: testUrl, DIRECT_URL: testUrl },
    stdio: "pipe",
  });
}
