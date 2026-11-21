/**
 * Contrat d'un prestataire de paiement en ligne (SasPay, plus tard).
 *
 * AUCUN prestataire n'est branché : l'intégration de SasPay exige sa
 * documentation officielle et un compte approuvé. Rien ici ne suppose un
 * endpoint, un paramètre ou un format de signature : chaque adaptateur
 * traduit SA documentation vers ce contrat, sans que le reste de Rayon change.
 *
 * Règles imposées à tout adaptateur :
 * - appels au prestataire uniquement depuis le backend ; identifiants lus dans
 *   l'environnement, jamais journalisés ni renvoyés dans une erreur ;
 * - `verifyNotification` VÉRIFIE la signature selon la documentation
 *   officielle et lève `InvalidNotificationError` sinon ;
 * - `fetchTransaction` interroge le prestataire : c'est le statut RÉEL qui fait
 *   foi (une notification ou un retour navigateur n'est jamais une preuve).
 */

export type ProviderStatus = "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export type CheckoutRequest = {
  /** Référence interne unique de la transaction Rayon. */
  internalReference: string;
  amount: number;
  currency: string;
  description: string;
  organizationId: number;
};

export type CheckoutResult = {
  providerReference: string | null;
  /** Page de paiement du prestataire, si le parcours en utilise une. */
  redirectUrl?: string;
  instructions?: string;
};

export type ProviderNotification = {
  /** Identifiant unique de la notification (anti-rejeu). */
  eventId: string;
  internalReference: string;
  providerReference: string | null;
  status: ProviderStatus;
  amount: number | null;
  currency: string | null;
  method: string | null;
};

export type ProviderTransaction = {
  providerReference: string | null;
  status: ProviderStatus;
  amount: number | null;
  currency: string | null;
  method: string | null;
};

export class InvalidNotificationError extends Error {}

export interface SubscriptionPaymentProvider {
  /** Identifiant stable, enregistré dans `PaiementAbonnement.fournisseur`. */
  readonly id: string;
  createCheckout(request: CheckoutRequest): Promise<CheckoutResult>;
  verifyNotification(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<ProviderNotification>;
  /** Statut réel d'une transaction ; null si le prestataire ne la connaît pas. */
  fetchTransaction(internalReference: string, providerReference: string | null): Promise<ProviderTransaction | null>;
}

/** Paiement Mobile Money reçu hors ligne, confirmé par l'administration. */
export const MANUAL_PROVIDER = "MANUEL";

const providers = new Map<string, SubscriptionPaymentProvider>();

export function registerProvider(provider: SubscriptionPaymentProvider) {
  providers.set(provider.id, provider);
}

export function unregisterProvider(id: string) {
  providers.delete(id);
}

export function findProvider(id: string): SubscriptionPaymentProvider | null {
  return providers.get(id) ?? null;
}

/**
 * Prestataire utilisé pour les nouveaux paiements :
 * `SUBSCRIPTION_PAYMENT_PROVIDER` (ex : saspay, une fois intégré), sinon
 * paiement manuel. Un prestataire configuré mais absent est une erreur de
 * déploiement : signalée, jamais remplacée silencieusement.
 */
export function checkoutProviderId(): string {
  return process.env.SUBSCRIPTION_PAYMENT_PROVIDER?.trim() || MANUAL_PROVIDER;
}
