import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { currentRequest } from "@/lib/http/context";

/** Événements tracés dans `JournalSecurite`. */
export type SecurityEvent =
  | "login.success"
  | "login.failure"
  | "logout"
  | "password.changed"
  | "password.change_failed"
  | "password.reset_by_manager"
  | "sessions.revoked"
  | "rate_limit.blocked";

/** Adresse IP du client (selon `trust proxy`), jamais de donnée secrète. */
export function requestIp(): string | null {
  const req = currentRequest();
  return req ? (req.ip ?? req.socket.remoteAddress ?? null) : null;
}

export function requestUserAgent(): string | null {
  return currentRequest()?.get("user-agent")?.slice(0, 300) ?? null;
}

/**
 * Trace un événement de sécurité. Ne fait jamais échouer la requête : la
 * journalisation sert l'enquête, pas la règle d'accès. Aucun mot de passe ni
 * jeton n'y est jamais écrit.
 */
export async function recordSecurityEvent(input: {
  evenement: SecurityEvent;
  utilisateurId?: number | null;
  identifiant?: string | null;
  metadonnees?: Prisma.InputJsonValue;
}): Promise<void> {
  try {
    await prisma.journalSecurite.create({
      data: {
        evenement: input.evenement,
        utilisateurId: input.utilisateurId ?? null,
        identifiant: input.identifiant?.slice(0, 254) ?? null,
        adresseIp: requestIp(),
        metadonnees: input.metadonnees,
      },
    });
  } catch (error) {
    console.error("Échec de l'écriture du journal de sécurité", error);
  }
}
