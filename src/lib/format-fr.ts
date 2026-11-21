/**
 * Mise en forme française pour les textes produits par le serveur
 * (notifications, instructions de paiement). Les dates sont affichées en UTC,
 * heure légale de la Côte d'Ivoire et du Sénégal.
 */
const DATE = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export function formatDateFr(date: Date): string {
  return DATE.format(date);
}

/** Montant en francs CFA : « 30 000 FCFA » (espaces insécables normalisées). */
export function formatXof(amount: number): string {
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(amount).replace(/\s/g, " ")} FCFA`;
}
