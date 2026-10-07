import "dotenv/config";
import { createApp } from "@/app";
import { allowedOrigins, port } from "@/env";
import { getAuthSecret } from "@/lib/auth/token";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL est manquant. Configurez-le dans votre fichier .env avant de démarrer le serveur.");
}

if (!getAuthSecret()) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET est requis en production. Définissez un secret fort avant de démarrer.");
  }
  console.warn("AUTH_SECRET n'est pas défini : la connexion échouera tant qu'il manque (voir .env.example).");
}

const app = createApp();

app.listen(port(), () => {
  console.log("Démarrage du serveur...");
  console.log(`API Rayon démarrée sur http://localhost:${port()}`);
  console.log(`Origines autorisées : ${allowedOrigins().join(", ")}`);
  console.log(`Mode : ${process.env.NODE_ENV || "development"}`);
  console.log(`Base de données : ${process.env.DATABASE_URL}`);
  console.log('serveur demarré avec succès');
});
