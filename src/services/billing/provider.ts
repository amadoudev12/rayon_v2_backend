import type { SubscriptionPaymentInput } from "@/services/subscription";

/**
 * Interface d'un prestataire de paiement d'abonnement (Mobile Money, carte).
 *
 * AUCUN prestataire n'est branché : leur intégration exige des identifiants
 * réels (compte marchand, clés d'API, secret de signature des notifications)
 * et un contrat. Ce fichier fixe le contrat que chaque intégration devra
 * respecter, pour que le reste de Rayon n'ait pas à changer :
 *
 * 1. `createCheckout` : obtient du prestataire une page ou une demande de
 *    paiement pour une organisation, une offre et une période ;
 * 2. `parseNotification` : VÉRIFIE la signature de la notification (webhook)
 *    avec le secret du prestataire, puis la traduit en paiement. Une
 *    notification non signée ou mal signée doit être rejetée ;
 * 3. le paiement est enregistré par `recordSubscriptionPayment`, idempotent
 *    sur (prestataire, référence) : une notification répétée est sans effet.
 *
 * Informations à fournir pour une intégration (ex : CinetPay, PayDunya, Wave
 * Business, Orange Money API) : identifiant marchand, clé d'API, secret de
 * signature des notifications, URL de retour, devise (XOF / GNF), pays visés.
 */
export type CheckoutRequest = {
  organizationId: number;
  plan: string;
  amount: number;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
  /** Numéro Mobile Money ou adresse du payeur, selon le prestataire. */
  customerContact?: string;
};

export type CheckoutResult = { providerReference: string; redirectUrl?: string; instructions?: string };

export interface SubscriptionPaymentProvider {
  /** Identifiant stable, enregistré dans `PaiementAbonnement.fournisseur`. */
  readonly id: string;
  createCheckout(request: CheckoutRequest): Promise<CheckoutResult>;
  /** Retourne null si la notification ne concerne pas un paiement (ex : test). */
  parseNotification(rawBody: Buffer, headers: Record<string, string | undefined>): Promise<
    (SubscriptionPaymentInput & { organizationId: number }) | null
  >;
}

const providers = new Map<string, SubscriptionPaymentProvider>();

export function registerProvider(provider: SubscriptionPaymentProvider) {
  providers.set(provider.id, provider);
}

export function getProvider(id: string): SubscriptionPaymentProvider {
  const provider = providers.get(id);
  if (!provider) throw new Error(`Prestataire de paiement « ${id} » non configuré.`);
  return provider;
}
