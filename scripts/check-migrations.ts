/**
 * Vérifie que l'historique des migrations produit exactement `schema.prisma`.
 *
 * Fonctionne uniquement sur la base de TEST isolée (TEST_DATABASE_URL) :
 *   1. applique les migrations (`prisma migrate deploy`) ;
 *   2. compare la base obtenue au schéma (`prisma migrate diff --exit-code`).
 *
 * Aucune autre base n'est lue ni modifiée. Code de sortie non nul si une
 * migration manque ou si le schéma a dérivé.
 *
 *   npm run db:check
 */
import { execSync } from "node:child_process";
import globalSetup from "../tests/setup/global-setup";
import { getTestDatabaseUrl } from "../tests/setup/test-database";

async function main() {
  const testUrl = getTestDatabaseUrl();
  await globalSetup();

  const env = { ...process.env, DATABASE_URL: testUrl, DIRECT_URL: testUrl };
  try {
    execSync(
      "npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code",
      { env, stdio: "pipe" },
    );
    console.log("OK : les migrations correspondent exactement à schema.prisma.");
  } catch (error) {
    const failure = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
    console.error(failure.stdout?.toString() ?? "", failure.stderr?.toString() ?? "");
    console.error(
      failure.status === 2
        ? "ÉCHEC : schema.prisma diffère de la base produite par les migrations (migration manquante ?)."
        : "ÉCHEC : la comparaison n'a pas pu être effectuée.",
    );
    process.exit(1);
  }
}

void main();
