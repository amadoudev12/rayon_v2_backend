import { getTestDatabaseUrl } from "./test-database";

// Exécuté dans chaque processus de test AVANT l'import des fichiers de test :
// le client Prisma de l'application (src/lib/prisma.ts) se connectera ainsi à
// la base de test, jamais à la base de développement.
process.env.DATABASE_URL = getTestDatabaseUrl();

// Les tests vérifient le régime cible : clé d'idempotence obligatoire.
// (Le mode de transition est testé explicitement dans codex-corrections.)
process.env.IDEMPOTENCY_KEY_REQUIRED = "true";
