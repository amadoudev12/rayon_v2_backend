import "dotenv/config";
import { createApp } from "@/app";
import { port } from "@/env";
import { getAuthSecret } from "@/lib/auth/token";
import { log } from "@/lib/logger";
import { startSubscriptionJobs } from "@/jobs/subscription-jobs";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL est manquant. Configurez-le dans votre fichier .env avant de démarrer le serveur.");
}

const secret = getAuthSecret();
if (process.env.NODE_ENV === "production" && (!secret || secret.length < 32)) {
  throw new Error("AUTH_SECRET (32 caractères au moins) est requis en production. Générez-le : node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"");
}
if (!secret) {
  console.warn("AUTH_SECRET n'est pas défini : la connexion échouera tant qu'il manque (voir .env.example).");
}

const app = createApp();

const server = app.listen(port(), () => {
  log("info", "server.started", { port: port(), node: process.version });
});

// Maintenance des abonnements (changements de forfait échus).
const stopSubscriptionJobs = startSubscriptionJobs();

// Arrêt propre (déploiement, redémarrage) : les requêtes en cours se terminent.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log("info", "server.stopping", { signal });
    stopSubscriptionJobs();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
process.on("unhandledRejection", (reason) => log("error", "process.unhandled_rejection", { reason: String(reason) }));
