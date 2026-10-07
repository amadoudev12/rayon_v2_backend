import { getTestDatabaseUrl } from "./test-database";

// Exécuté dans chaque processus de test AVANT l'import des fichiers de test :
// le client Prisma de l'application (src/lib/prisma.ts) se connectera ainsi à
// la base de test, jamais à la base de développement.
process.env.DATABASE_URL = getTestDatabaseUrl();
