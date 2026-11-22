/**
 * Comptes concernés par l'acceptation des documents juridiques.
 *
 * LECTURE SEULE. N'affiche ni nom, ni email, ni téléphone : des décomptes et,
 * avec `--ids`, les identifiants internes des comptes qui doivent accepter.
 *
 *   npm run legal:report
 *   npm run legal:report -- --ids
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { LEGAL_DOCUMENTS, currentRelease } from "../src/legal/registry";
import { documentStatus, needsAcceptance } from "../src/legal/status";

async function main() {
  const users = await prisma.utilisateur.findMany({
    select: { id: true, actif: true, acceptationsJuridiques: { select: { termsVersion: true, privacyVersion: true } } },
    orderBy: { id: "asc" },
  });

  const required = users.filter((user) => needsAcceptance(user.acceptationsJuridiques));
  const informed = users.filter(
    (user) =>
      !required.includes(user) &&
      Object.values(LEGAL_DOCUMENTS).some((document) => documentStatus(document, user.acceptationsJuridiques).status === "updated"),
  );

  console.log(`CGU en vigueur                    : ${currentRelease("terms").version}`);
  console.log(`Politique en vigueur              : ${currentRelease("privacy").version}`);
  console.log(`Comptes                           : ${users.length}`);
  console.log(`Sans aucune preuve d'acceptation  : ${users.filter((user) => user.acceptationsJuridiques.length === 0).length}`);
  console.log(`Accord valide                     : ${users.length - required.length}`);
  console.log(`  dont à informer d'une mise à jour : ${informed.length}`);
  console.log(`Doivent accepter                  : ${required.length}`);
  console.log(`  dont comptes actifs               : ${required.filter((user) => user.actif).length}`);
  if (process.argv.includes("--ids")) console.log(`Identifiants : ${required.map((user) => user.id).join(", ") || "aucun"}`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
