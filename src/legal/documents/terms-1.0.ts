import type { LegalRelease } from "@/legal/types";

// VERSION PUBLIÉE : NE JAMAIS MODIFIER CE FICHIER.
// Pour changer le texte (y compris remplir un champ « À COMPLÉTER »), créer
// une nouvelle version : docs/DOCUMENTS-JURIDIQUES.md.
export const termsV1_0: LegalRelease = {
  version: "1.0",
  publishedAt: "2026-11-22",
  requiresAcceptance: true,
  summary: "Première version des Conditions Générales d'Utilisation de Rayon.",
  intro: [
    "Les présentes Conditions Générales d'Utilisation (les « Conditions ») encadrent l'accès à Rayon et son utilisation, sur le site web et dans l'application mobile. Elles forment un contrat entre l'éditeur de Rayon et chaque personne qui crée ou utilise un compte.",
    "Les mentions « À COMPLÉTER » signalent des informations que l'éditeur doit encore publier. Elles ne valent ni déclaration ni engagement sur le point concerné.",
  ],
  sections: [
    {
      id: "editeur",
      title: "Présentation de Rayon et identification de l'éditeur",
      blocks: [
        "Rayon est un logiciel de gestion de magasin accessible en ligne. Son éditeur est identifié ci-dessous, conformément à l'article 5 de la loi n° 2013-546 du 30 juillet 2013 relative aux transactions électroniques.",
        {
          facts: [
            ["Nom ou dénomination sociale", "[À COMPLÉTER : nom et prénoms, ou dénomination sociale]"],
            ["Forme juridique et capital social", "[À COMPLÉTER : forme juridique et capital, s'il y a lieu]"],
            ["Adresse du siège ou de l'établissement", "[À COMPLÉTER : adresse complète]"],
            ["Registre du commerce (RCCM)", "[À COMPLÉTER : numéro RCCM]"],
            ["Identifiant fiscal", "[À COMPLÉTER : numéro d'identification fiscale]"],
            ["Représentant légal", "[À COMPLÉTER : nom et qualité]"],
            ["Courrier électronique", "[À COMPLÉTER : adresse de contact]"],
            ["Téléphone", "[À COMPLÉTER : numéro de téléphone]"],
          ],
        },
      ],
    },
    {
      id: "definitions",
      title: "Définitions",
      blocks: [
        {
          list: [
            "« Service » : le logiciel Rayon, son site web et son application mobile.",
            "« Commerçant » : la personne physique ou morale pour laquelle une organisation est créée dans Rayon.",
            "« Propriétaire » : le titulaire du compte qui administre l'organisation et son abonnement.",
            "« Collaborateur » : toute personne à qui le Commerçant donne un accès.",
            "« Utilisateur » : toute personne titulaire d'un compte, Propriétaire ou Collaborateur.",
            "« Données commerciales » : les produits, prix, stocks, ventes, achats, dépenses, clients, fournisseurs et autres informations enregistrés pour une organisation.",
          ],
        },
      ],
    },
    {
      id: "objet",
      title: "Objet du service",
      blocks: [
        "Rayon aide les commerçants à enregistrer et suivre leur activité : produits, stocks, ventes, créances, devis, achats, dépenses, clients, fournisseurs et indicateurs de gestion. Les fonctionnalités disponibles dépendent du forfait et du rôle de l'Utilisateur. Une fonctionnalité annoncée « à venir » n'est pas incluse tant qu'elle n'est pas disponible.",
        "Rayon est un outil de gestion. Il ne constitue ni un service de paiement entre le Commerçant et ses clients, ni un logiciel de comptabilité ou de facturation certifié, ni un conseil juridique, fiscal ou comptable.",
      ],
    },
    {
      id: "acceptation",
      title: "Conclusion du contrat et acceptation",
      blocks: [
        "Le contrat se conclut en français, par voie électronique, selon les étapes suivantes :",
        {
          list: [
            "la personne saisit ses informations, qu'elle peut relire et corriger avant de valider ;",
            "elle accède aux présentes Conditions et à la Politique de confidentialité ;",
            "elle coche la case d'acceptation, qui n'est jamais cochée d'avance, puis valide ;",
            "Rayon enregistre son accord avec la version de chaque document, la date et l'heure, puis confirme la création du compte en y donnant accès.",
          ],
        },
        "Un compte créé par un Commerçant ou par l'administration de Rayon, ou créé avant la publication des présentes, n'est pas réputé avoir accepté : l'accord est demandé à son titulaire lorsqu'il utilise Rayon.",
        "Chaque version publiée reste consultable et imprimable sur le site. L'Utilisateur retrouve l'historique de ses accords dans la rubrique « Informations juridiques ». Une personne qui refuse les Conditions ne peut pas utiliser les fonctionnalités protégées ; elle peut se déconnecter, consulter les documents et exercer ses droits auprès de l'éditeur.",
      ],
    },
    {
      id: "compte",
      title: "Création et sécurité des comptes",
      blocks: [
        "L'Utilisateur doit être âgé d'au moins dix-huit ans et avoir la capacité de s'engager. Celui qui agit pour une entreprise déclare y être habilité.",
        "Il fournit des informations exactes et un identifiant, adresse électronique ou numéro de téléphone, dont il a l'usage. Chaque compte est personnel.",
        {
          list: [
            "choisir un mot de passe robuste et le garder secret ;",
            "ne pas partager son compte, y compris entre collègues ;",
            "remplacer tout mot de passe temporaire dès la première connexion lorsque cela est demandé ;",
            "se déconnecter des appareils partagés ;",
            "signaler sans tarder toute utilisation suspecte à l'éditeur ou au responsable de son organisation.",
          ],
        },
      ],
    },
    {
      id: "utilisation",
      title: "Utilisation du logiciel",
      blocks: [
        "L'éditeur accorde à l'Utilisateur un droit d'utilisation personnel, non exclusif et non cessible, pour les besoins de l'organisation et pendant la durée d'accès au Service. Sont notamment interdits :",
        {
          list: [
            "l'usage illicite ou frauduleux, notamment la falsification d'opérations, le blanchiment de capitaux ou le financement du terrorisme ;",
            "l'accès aux données d'une autre organisation ou le contournement des droits, quotas et mesures de sécurité ;",
            "les actions destinées à perturber ou surcharger le Service ;",
            "la revente ou la mise à disposition du Service à des tiers sans accord écrit de l'éditeur ;",
            "l'enregistrement de données sensibles sans rapport avec la gestion du magasin, telles que la santé, la religion, l'origine ethnique ou les opinions politiques.",
          ],
        },
      ],
    },
    {
      id: "boutiques-collaborateurs",
      title: "Gestion des boutiques et des collaborateurs",
      blocks: [
        "Le Commerçant peut créer des boutiques et des accès dans les limites de son forfait. Il attribue les rôles, peut restreindre un Collaborateur à une boutique, réinitialiser son mot de passe et retirer son accès. Il veille à ce que chaque accès reste justifié et retire ceux qui ne le sont plus.",
        "Les opérations d'un Collaborateur sont visibles, selon les rôles, par les responsables de l'organisation et peuvent lui être attribuées nominativement. Le Commerçant informe ses Collaborateurs de ce suivi.",
        "Chaque Collaborateur accepte personnellement les Conditions. L'acceptation du Propriétaire ne vaut pas pour lui.",
      ],
    },
    {
      id: "responsabilite-commercant",
      title: "Responsabilité des commerçants",
      blocks: [
        "Le Commerçant est seul responsable de son activité, de ses relations avec ses clients, fournisseurs et salariés, ainsi que de ses obligations fiscales, comptables, sociales et de conservation de documents.",
        "Il est responsable des données personnelles de tiers qu'il enregistre, notamment celles de ses clients et fournisseurs : il les informe, recueille leur accord lorsque la loi l'exige et accomplit les formalités qui lui incombent auprès de l'Autorité de protection. L'éditeur les traite pour le compte du Commerçant, afin de fournir le Service, dans les conditions de la Politique de confidentialité.",
      ],
    },
    {
      id: "exactitude",
      title: "Exactitude des ventes, stocks, prix et informations enregistrées",
      blocks: [
        "Les stocks, créances, marges et bénéfices affichés par Rayon sont calculés à partir des informations saisies. Le Commerçant vérifie l'exactitude des ventes, quantités, prix, coûts, paiements, taxes et importations, et rapproche régulièrement les résultats de son stock physique et de ses encaissements réels.",
        "Pour préserver la traçabilité, certaines opérations ne peuvent pas être effacées : elles se corrigent par annulation, retour ou ajustement et restent dans l'historique. L'enregistrement d'un paiement ou d'un remboursement dans Rayon ne déplace aucun fonds.",
      ],
    },
    {
      id: "abonnements",
      title: "Abonnements et tarifs",
      blocks: [
        "À la date de publication de cette version, les forfaits sont les suivants, en francs CFA (XOF), sans remise pour les durées de 3, 6 ou 12 mois :",
        {
          facts: [
            ["Starter", "7 500 FCFA par mois : 1 boutique et 2 utilisateurs, Propriétaire inclus"],
            ["Business", "10 000 FCFA par mois : 2 boutiques et 5 utilisateurs, Propriétaire inclus"],
            ["Premium", "15 000 FCFA par mois : 10 boutiques et 10 utilisateurs, Propriétaire inclus"],
            ["Taxes", "[À COMPLÉTER : prix toutes taxes comprises ou hors taxes, et taux applicable]"],
          ],
        },
        "Le détail des fonctionnalités de chaque forfait figure dans la rubrique « Abonnement ». Le prix total est affiché avant toute commande et peut être vérifié avant confirmation. Un changement de tarif ne modifie pas une période déjà payée.",
        "Toute nouvelle organisation reçoit un essai gratuit unique de 14 jours avec les droits Premium. Il ne donne lieu à aucun prélèvement. Une organisation créée avant la mise en place des abonnements n'y est soumise qu'après attribution d'un abonnement ou d'un essai.",
        "Seul le Propriétaire gère l'abonnement. Une mise à niveau prend effet après confirmation du paiement ; son montant est la différence de prix mensuel multipliée par le nombre de jours restants, divisée par 30 et arrondie au franc supérieur, sans changement d'échéance. Un passage à un forfait inférieur prend effet à l'échéance et ne supprime pas les boutiques ou comptes existants.",
      ],
    },
    {
      id: "paiements",
      title: "Paiements, renouvellements et expirations",
      blocks: [
        "Le paiement s'effectue selon les instructions affichées lors de la commande, avec la référence fournie. La demande enregistrée et sa référence accusent réception de la commande. L'abonnement n'est activé qu'après confirmation de la réception des fonds ; un reçu est alors mis à disposition. Un montant incorrect ou un paiement inapplicable est examiné avant toute activation.",
        {
          list: [
            "aucun renouvellement n'est automatique et aucun prélèvement n'est effectué ;",
            "une demande restée impayée pendant 7 jours est annulée ;",
            "un renouvellement réglé avant l'échéance ou pendant les 7 jours de grâce part de l'ancienne échéance ;",
            "un paiement effectué pendant l'essai met fin à l'essai et ouvre immédiatement la période payée ;",
            "lorsque les limitations d'abonnement sont appliquées, le Service passe en lecture seule à la fin de l'essai, ou à l'issue des 7 jours de grâce qui suivent une période payée ;",
            "l'expiration d'un abonnement n'entraîne pas, à elle seule, la suppression des données.",
          ],
        },
        "Une rétrogradation ne donne pas lieu à remboursement. Toute autre demande de remboursement ou contestation de paiement est adressée à l'éditeur et instruite hors de l'application, dans le respect des droits légaux du client. [À COMPLÉTER : conditions et délais de remboursement]",
      ],
    },
    {
      id: "suspension-resiliation",
      title: "Suspension et résiliation",
      blocks: [
        "L'éditeur peut suspendre un abonnement, une organisation ou un compte en cas de manquement aux Conditions, de fraude, de risque pour la sécurité ou de demande d'une autorité compétente. Selon le cas, la suspension limite le Service à la lecture ou en coupe l'accès. Sauf urgence ou interdiction légale, l'intéressé est informé du motif et peut présenter ses observations. [À COMPLÉTER : délai et moyen de notification]",
        "Le Commerçant peut cesser d'utiliser Rayon en ne renouvelant pas son abonnement, ou demander la clôture de son compte à l'éditeur. L'éditeur peut résilier en cas de manquement grave ou non corrigé. [À COMPLÉTER : préavis et modalités de résiliation]",
        "Avant la clôture, le Commerçant peut demander une copie de ses données. Elles sont ensuite conservées ou supprimées selon la Politique de confidentialité. Une suspension ne prive personne de ses droits sur ses données personnelles.",
      ],
    },
    {
      id: "disponibilite",
      title: "Disponibilité et maintenance",
      blocks: [
        "L'éditeur met en œuvre des moyens raisonnables pour maintenir le Service accessible, sans garantir une disponibilité ininterrompue. Des interruptions peuvent résulter d'une maintenance, d'une mise à jour, d'un incident, d'un hébergeur ou des réseaux d'électricité et de télécommunication.",
        "Le Service nécessite une connexion internet et un appareil à jour. Le Commerçant prévoit une solution de secours pour enregistrer ses opérations pendant une interruption et conserve les documents que la loi lui impose de garder.",
      ],
    },
    {
      id: "propriete-intellectuelle",
      title: "Propriété intellectuelle",
      blocks: [
        "Le logiciel, son interface, ses textes, ses éléments graphiques et le signe Rayon restent la propriété de l'éditeur ou de leurs titulaires respectifs. Les Conditions n'en transfèrent aucun droit. Leur copie, adaptation ou exploitation est interdite hors des cas autorisés par la loi ou par écrit.",
        "Les Données commerciales restent au Commerçant. Il autorise l'éditeur à les héberger, sauvegarder et traiter dans la seule mesure nécessaire à la fourniture, à la sécurité et au support du Service.",
      ],
    },
    {
      id: "donnees-personnelles",
      title: "Données personnelles",
      blocks: [
        "La Politique de confidentialité décrit les traitements de données personnelles, les durées de conservation, les destinataires et les droits des personnes, en application de la loi n° 2013-450 du 19 juin 2013 relative à la protection des données à caractère personnel.",
      ],
    },
    {
      id: "limitation-responsabilite",
      title: "Limitation de responsabilité",
      blocks: [
        "Conformément à l'article 7 de la loi n° 2013-546, l'éditeur répond de la bonne exécution de ses obligations. Il peut s'exonérer en prouvant que l'inexécution est imputable à son cocontractant ou à un cas de force majeure.",
        "Dans les limites permises par la loi, l'éditeur ne répond pas des conséquences de saisies inexactes, d'un usage contraire aux Conditions, d'identifiants partagés par l'Utilisateur, des décisions de gestion du Commerçant, ni des dommages indirects ou imprévisibles.",
        "Aucune clause n'exclut une responsabilité qui ne peut pas l'être, notamment en cas de faute lourde ou intentionnelle, ni les droits impératifs des consommateurs. [À COMPLÉTER : plafond éventuel de responsabilité, à valider par un juriste]",
      ],
    },
    {
      id: "modifications",
      title: "Modification des conditions",
      blocks: [
        "L'éditeur peut modifier les Conditions. Chaque version porte un numéro et une date, et les versions antérieures restent consultables.",
        {
          list: [
            "modification qui touche aux droits ou obligations : un nouvel accord est demandé avant de poursuivre l'utilisation ;",
            "modification sans effet sur les droits ou obligations, par exemple une correction rédactionnelle : l'Utilisateur en est simplement informé dans l'application.",
          ],
        },
        "Les accords antérieurs sont conservés et ne sont jamais remplacés.",
      ],
    },
    {
      id: "droit-litiges",
      title: "Droit applicable et règlement des litiges",
      blocks: [
        "Les Conditions sont régies par le droit ivoirien, notamment les lois n° 2013-450 et n° 2013-546, et par les Actes uniformes OHADA applicables, sans priver un consommateur des protections impératives dont il bénéficie.",
        "Toute réclamation est d'abord adressée à l'éditeur, afin de rechercher une solution amiable. [À COMPLÉTER : coordonnées de réclamation, délai de réponse et médiation éventuelle]",
        "À défaut d'accord, le litige est porté devant la juridiction compétente selon la loi. [À COMPLÉTER : juridiction choisie entre professionnels, à valider par un juriste]",
      ],
    },
  ],
};
