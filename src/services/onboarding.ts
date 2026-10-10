import { prisma } from "@/lib/prisma";
import { Errors } from "@/lib/api/errors";
import { slugify } from "@/lib/slug";
import { Role } from "@/generated/prisma/enums";
import type { OnboardingFormData } from "@/lib/validations/onboarding";

/**
 * Crée l'organisation et la première boutique d'un utilisateur qui vient de
 * s'inscrire, et le rend OWNER. Un utilisateur n'appartient qu'à une seule
 * organisation (garanti par l'unicité de `Membre.utilisateurId`), cette
 * fonction ne doit donc s'exécuter qu'une fois par compte.
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

    return { organization, store };
  });
}
