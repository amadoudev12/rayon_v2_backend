import { log } from "@/lib/logger";
import { reconcilePayments } from "@/services/billing/payments";
import { runExpiryNotifications } from "@/services/notifications";
import { runSubscriptionMaintenance } from "@/services/subscription";

/**
 * Tâche périodique des abonnements, lancée par le serveur.
 *
 * Elle inscrit en base les changements échus (rétrogradations programmées),
 * rapproche les paiements (activation rejouée, statut vérifié auprès du
 * prestataire, transactions abandonnées) et crée les rappels d'échéance.
 * Les DROITS ne
 * dépendent jamais de cette tâche : ils sont recalculés à chaque requête.
 * Plusieurs instances peuvent tourner en même temps : chaque traitement est
 * idempotent (mise à jour conditionnelle).
 *
 * SUBSCRIPTION_JOBS_INTERVAL_MINUTES : période (60 par défaut) ; 0 désactive.
 */
export function startSubscriptionJobs(): () => void {
  const minutes = Number(process.env.SUBSCRIPTION_JOBS_INTERVAL_MINUTES ?? 60);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    log("info", "subscription_jobs.disabled");
    return () => {};
  }

  let running = false;
  const tick = async () => {
    if (running) return; // une exécution à la fois dans ce processus
    running = true;
    const steps = [
      ["maintenance", () => runSubscriptionMaintenance(new Date())],
      ["reconciliation", () => reconcilePayments(new Date())],
      ["notifications", () => runExpiryNotifications(new Date())],
    ] as const;
    try {
      // Étapes indépendantes : l'échec de l'une n'empêche pas les autres.
      for (const [name, step] of steps) {
        try {
          const result = await step();
          if (Object.values(result).some((value) => value > 0)) log("info", `subscription_jobs.${name}`, result);
        } catch (error) {
          log("error", `subscription_jobs.${name}_failed`, { error: error instanceof Error ? error.message : String(error) });
        }
      }
    } finally {
      running = false;
    }
  };

  const first = setTimeout(tick, 10_000);
  const timer = setInterval(tick, minutes * 60_000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
