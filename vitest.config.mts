import { defineConfig } from "vitest/config";

/**
 * Tests d'intégration : les services, les règles d'accès et les routes sont
 * exécutés contre une vraie base PostgreSQL dédiée aux tests (voir tests/setup).
 */
export default defineConfig({
  // Résout les alias "@/..." définis dans tsconfig.json.
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/setup/global-setup.ts"],
    setupFiles: ["tests/setup/env.ts"],
    // Une seule base partagée, vidée avant chaque test : les fichiers de test
    // ne doivent pas s'exécuter en parallèle.
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
