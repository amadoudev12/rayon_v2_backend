/** Typed error carrying the HTTP status it should be reported with. */
export class ApiError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/**
 * Levée par les lectures de page (`/api/pages/**`) quand le compte n'a pas sa
 * place sur la page demandée : le site redirige vers `redirect` au lieu
 * d'afficher une erreur (équivalent du `redirect()` des pages rendues côté
 * serveur).
 */
export class PageRedirect extends Error {
  readonly redirect: string;

  constructor(redirect: string) {
    super("Redirection");
    this.redirect = redirect;
  }
}

export const Errors = {
  unauthenticated: () => new ApiError(401, "Authentification requise"),
  accessRevoked: () =>
    new ApiError(401, "Votre accès à cette organisation a été retiré. Reconnectez-vous."),
  onboardingRequired: () =>
    new ApiError(409, "Aucune boutique configurée. Terminez l'inscription de votre organisation."),
  platformAccountOnly: () =>
    new ApiError(403, "Ce compte administre la plateforme et ne dispose d'aucun espace boutique."),
  organizationSuspended: () =>
    new ApiError(403, "Votre boutique est suspendue. Contactez l'administrateur de la plateforme."),
  forbidden: (message = "Action non autorisée pour votre rôle") => new ApiError(403, message),
  notFound: (message = "Ressource introuvable") => new ApiError(404, message),
  invalidId: () => new ApiError(400, "Identifiant invalide"),
  conflict: (message: string) => new ApiError(409, message),
};
