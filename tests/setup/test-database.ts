import "dotenv/config";

/**
 * URL de la base de test : `TEST_DATABASE_URL` si elle est définie, sinon la
 * base de `DATABASE_URL` suffixée par `_test` (ex : gestion_magazin_test).
 *
 * Les tests vident toutes les tables : on refuse donc catégoriquement toute
 * base dont le nom ne se termine pas par `_test`, pour ne jamais toucher aux
 * vraies données.
 */
export function getTestDatabaseUrl(): string {
  const explicit = process.env.TEST_DATABASE_URL;
  const base = explicit ?? process.env.DATABASE_URL;
  if (!base) {
    throw new Error("DATABASE_URL (ou TEST_DATABASE_URL) est requis pour lancer les tests.");
  }

  const url = new URL(base);
  if (!explicit) url.pathname = `${url.pathname}_test`;

  const databaseName = url.pathname.slice(1);
  if (!databaseName.endsWith("_test")) {
    throw new Error(
      `Base de test refusée : « ${databaseName} » ne se termine pas par _test. ` +
        "Les tests effacent les données, ils ne s'exécutent jamais sur une autre base.",
    );
  }
  return url.toString();
}
