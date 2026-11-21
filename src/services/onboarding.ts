import { prisma } from "@/lib/prisma";
import { Errors } from "@/lib/api/errors";
import { slugify } from "@/lib/slug";
import { Role } from "@/generated/prisma/enums";
import type { OnboardingFormData } from "@/lib/validations/onboarding";
import { startTrial } from "@/services/subscription";
import { countryFromPhone } from "@/lib/country";

/**
 * Crée l'organisation et la première boutique d'un utilisateur qui vient de
 * s'inscrire, et le rend OWNER. Un utilisateur n'appartient qu'à une seule
 * organisation (garanti par l'unicité de `Membre.utilisateurId`), cette
 * fonction ne doit donc s'exécuter qu'une fois par compte.
 *
 * L'organisation reçoit automatiquement son essai gratuit unique (14 jours,
 * droits PREMIUM), dans la même transaction.
 */
export async function createOrganizationForUser(userId: number, input: OnboardingFormData) {
  const existingMembership = await prisma.membre.findUnique({ where: { utilisateurId: userId } });
  if (existingMembership) {
    throw Errors.conflict("Votre compte est déjà rattaché à une organisation.");
  }

  const slug = slugify(input.nomOrganisation);

  return prisma.$transaction(async (tx) => {
    const organization = await tx.organisation.create({
      data: {
        nom: input.nomOrganisation,
        slug,
        devise: input.devise,
        pays: input.pays ?? countryFromPhone(input.telephoneBoutique),
      },
    });

    const store = await tx.boutique.create({
      data: {
        organisationId: organization.id,
        nom: input.nomBoutique,
        adresse: input.adresseBoutique || null,
        telephone: input.telephoneBoutique || null,
        parDefaut: true,
      },
    });

    await tx.membre.create({
      data: {
        utilisateurId: userId,
        organisationId: organization.id,
        role: Role.OWNER,
      },
    });

    await startTrial(tx, organization.id, userId);

    return { organization, store };
  });
}
