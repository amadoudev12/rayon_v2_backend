/**
 * Activation commerciale des abonnements : blocages (lecture seule,
 * fonctionnalités, quotas) et rappels d'échéance. Décision commerciale,
 * jamais un effet du déploiement.
 */
export const subscriptionsEnforced = () => process.env.SUBSCRIPTIONS_ENFORCED === "true";
