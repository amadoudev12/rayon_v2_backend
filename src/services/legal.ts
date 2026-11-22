import { prisma } from "@/lib/prisma";
import { Errors } from "@/lib/api/errors";
import { LEGAL_DOCUMENTS, currentRelease, releaseHash, type LegalKind } from "@/legal/registry";
import { documentStatus, type AcceptedVersions } from "@/legal/status";
import type { LegalAcceptanceSource } from "@/generated/prisma/enums";

function describe(kind: LegalKind) {
  const { slug, title } = LEGAL_DOCUMENTS[kind];
  const { version, publishedAt } = currentRelease(kind);
  return { kind, slug, title, path: `/${slug}`, version, publishedAt };
}

/** Documents en vigueur (public). */
export function getCatalog() {
  return { terms: describe("terms"), privacy: describe("privacy") };
}

/** Texte d'une version : celle en vigueur par défaut, ou une ancienne (public). */
export function getDocument(slug: string, version?: string | null) {
  const document = Object.values(LEGAL_DOCUMENTS).find((item) => item.slug === slug);
  if (!document) throw Errors.notFound("Document introuvable");

  const current = currentRelease(document.kind);
  const release = version ? document.releases.find((item) => item.version === version) : current;
  if (!release) throw Errors.notFound("Version introuvable");

  return {
    kind: document.kind,
    slug: document.slug,
    title: document.title,
    version: release.version,
    publishedAt: release.publishedAt,
    summary: release.summary,
    sha256: releaseHash(release),
    isCurrent: release === current,
    versions: document.releases.map((item) => ({ version: item.version, publishedAt: item.publishedAt })).reverse(),
    intro: release.intro,
    sections: release.sections,
  };
}

/** Statut et historique des accords du compte connecté, et de lui seul. */
export async function getLegalStatus(userId: number) {
  const history = await prisma.acceptationJuridique.findMany({
    where: { userId },
    orderBy: [{ acceptedAt: "desc" }, { id: "desc" }],
    select: { id: true, termsVersion: true, privacyVersion: true, acceptedAt: true, source: true },
  });
  const documents = (["terms", "privacy"] as const).map((kind) => ({
    ...describe(kind),
    ...documentStatus(LEGAL_DOCUMENTS[kind], history),
  }));

  return { required: documents.some((item) => item.status === "acceptance_required"), documents, history };
}

/**
 * Ajoute un accord à l'historique, jamais de mise à jour. Un second envoi des
 * mêmes versions (double clic, deux onglets) ne change rien : la date du
 * premier accord fait foi.
 */
export async function recordAcceptance(userId: number, versions: AcceptedVersions, source: LegalAcceptanceSource) {
  await prisma.acceptationJuridique.createMany({ data: [{ userId, ...versions, source }], skipDuplicates: true });
}
