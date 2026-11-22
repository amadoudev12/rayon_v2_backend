import type { LegalRelease } from "@/legal/types";

// VERSION PUBLIÉE : NE JAMAIS MODIFIER CE FICHIER.
// Pour changer le texte (y compris remplir un champ « À COMPLÉTER »), créer
// une nouvelle version : docs/DOCUMENTS-JURIDIQUES.md.
export const privacyV1_0: LegalRelease = {
  version: "1.0",
  publishedAt: "2026-11-22",
  requiresAcceptance: true,
  summary: "Première version de la Politique de confidentialité de Rayon.",
  intro: [
    "Cette politique explique quelles données personnelles Rayon traite, pourquoi, pendant combien de temps et avec qui, ainsi que la manière d'exercer vos droits. Elle se réfère à la loi ivoirienne n° 2013-450 du 19 juin 2013 relative à la protection des données à caractère personnel.",
    "Les mentions « À COMPLÉTER » signalent des informations que l'éditeur doit encore publier. Elles ne valent pas déclaration qu'une formalité a été accomplie ou qu'une autorisation a été obtenue.",
  ],
  sections: [
    {
      id: "responsable",
      title: "Responsable du traitement et coordonnées",
      blocks: [
        "L'éditeur de Rayon est responsable du traitement des données des comptes, de la sécurité, des abonnements et de l'administration du Service.",
        {
          facts: [
            ["Responsable du traitement", "[À COMPLÉTER : identité ou dénomination sociale]"],
            ["Représentant", "[À COMPLÉTER : nom et qualité]"],
            ["Adresse", "[À COMPLÉTER : adresse complète]"],
            ["Contact pour les données personnelles", "[À COMPLÉTER : courrier électronique et téléphone]"],
            ["Correspondant à la protection des données", "[À COMPLÉTER : coordonnées, si un correspondant est désigné]"],
            ["Formalités auprès de l'ARTCI", "[À COMPLÉTER : références des déclarations et autorisations]"],
          ],
        },
        "Pour les données que chaque commerçant enregistre sur ses clients, fournisseurs et collaborateurs dans le cadre de son activité, le commerçant est responsable du traitement et l'éditeur de Rayon agit pour son compte, en qualité de sous-traitant.",
      ],
    },
    {
      id: "donnees",
      title: "Données personnelles collectées",
      blocks: [
        {
          facts: [
            ["Compte", "prénom, nom, adresse électronique ou numéro de téléphone, empreinte du mot de passe, état du compte, dates de création et de dernière activité"],
            ["Organisation", "nom, pays, devise, boutiques avec adresse et téléphone, rôle et boutique de rattachement de chaque membre"],
            ["Activité", "opérations saisies (ventes, stocks, achats, dépenses, inventaires, devis…) avec leur auteur et leur date"],
            ["Tiers saisis par les commerçants", "noms, coordonnées, achats, dettes et créances de leurs clients et fournisseurs"],
            ["Abonnement", "forfait, échéances, montants, moyen et références de paiement, reçus, historique"],
            ["Sécurité et technique", "adresse IP, navigateur ou appareil des sessions, dates de connexion, identifiant saisi lors des tentatives de connexion, journaux techniques"],
            ["Preuve d'acceptation", "identifiant interne du compte, versions des deux documents, date et heure, canal (inscription, site ou mobile)"],
            ["Administration", "interventions de l'administration de Rayon, avec leur motif"],
          ],
        },
        "La preuve d'acceptation ne contient ni adresse IP ni navigateur : ces informations n'y sont pas nécessaires. Rayon ne demande aucune donnée sensible et ne collecte aucun code secret de carte bancaire ou de Mobile Money.",
        "Les données proviennent de vous, de l'organisation qui a créé votre accès, du commerçant qui les a saisies ou de l'utilisation du Service.",
      ],
    },
    {
      id: "finalites",
      title: "Finalités des traitements",
      blocks: [
        {
          list: [
            "créer, authentifier et gérer les comptes et les droits d'accès ;",
            "fournir les fonctions de gestion de magasin et attribuer chaque opération à son auteur ;",
            "gérer les essais, abonnements, paiements, reçus et rappels d'échéance ;",
            "sécuriser le Service, limiter les tentatives abusives, détecter et analyser les incidents ;",
            "répondre aux demandes d'assistance et d'exercice des droits ;",
            "prouver l'acceptation des documents juridiques et respecter les obligations légales ;",
            "établir des statistiques de fonctionnement de la plateforme.",
          ],
        },
        "Rayon ne vend pas les données personnelles et ne les utilise pas pour de la publicité. Aucune prospection directe n'est adressée sans le consentement préalable qu'exige la loi. Aucune décision fondée sur le profilage d'une personne n'est prise automatiquement.",
      ],
    },
    {
      id: "bases-juridiques",
      title: "Bases juridiques",
      blocks: [
        "L'article 14 de la loi n° 2013-450 pose le principe du consentement préalable et exprès. Il permet d'y déroger lorsque le responsable est dûment autorisé et que le traitement est nécessaire à l'un des motifs qu'il énumère.",
        {
          facts: [
            ["Compte, fourniture du Service et sécurité des accès", "consentement exprès donné lors de l'acceptation ; nécessité pour l'exécution du contrat, dans la mesure des autorisations obtenues"],
            ["Abonnements, paiements et reçus", "consentement exprès ; exécution du contrat et respect des obligations légales, dans les mêmes conditions"],
            ["Preuve d'acceptation", "consentement exprès ; respect des obligations de preuve"],
            ["Données de tiers saisies par un commerçant", "base déterminée par ce commerçant, qui en est responsable"],
            ["Prospection, si elle est proposée un jour", "consentement préalable distinct, retirable gratuitement"],
          ],
        },
        "L'article 7 soumet à autorisation préalable de l'Autorité de protection certains traitements, notamment ceux qui portent sur des numéros de téléphone. L'article 5 soumet les autres à déclaration, sauf dispense. [À COMPLÉTER : état et références de ces formalités]",
        "Vous pouvez refuser de figurer dans les fichiers de Rayon en ne créant pas de compte ou en demandant sa clôture. Sans les données nécessaires au compte, le Service ne peut pas vous être fourni.",
      ],
    },
    {
      id: "conservation",
      title: "Durées de conservation",
      blocks: [
        "Les données ne sont pas conservées au-delà de ce qu'exigent leurs finalités, les obligations légales et les durées fixées par l'Autorité de protection (articles 16 et 43 de la loi).",
        {
          facts: [
            ["Compte et organisation", "pendant l'utilisation du Service, puis [À COMPLÉTER : durée après clôture]"],
            ["Données commerciales", "pendant la relation avec le commerçant, puis [À COMPLÉTER : durée après résiliation]"],
            ["Paiements et reçus d'abonnement", "[À COMPLÉTER : durée légale de conservation comptable applicable]"],
            ["Preuves d'acceptation", "pendant la relation, puis [À COMPLÉTER : durée de prescription applicable]"],
            ["Sessions", "validité de 30 jours, prolongée en cas d'utilisation du site ; historique des sessions : [À COMPLÉTER : durée de conservation]"],
            ["Journal de sécurité et journaux techniques", "[À COMPLÉTER : durée de conservation]"],
            ["Compteurs contre les tentatives abusives", "identifiants hachés, purgés périodiquement après un jour d'inactivité"],
            ["Ventes mises en attente", "utilisables pendant 24 heures, puis supprimées lors d'un nettoyage ultérieur"],
            ["Sauvegardes", "[À COMPLÉTER : fréquence et durée de conservation]"],
          ],
        },
      ],
    },
    {
      id: "destinataires",
      title: "Destinataires des données",
      blocks: [
        {
          list: [
            "les responsables et membres de votre organisation, selon leur rôle ;",
            "l'administration de Rayon, pour les comptes, organisations, abonnements, paiements et la sécurité. L'interface d'administration n'affiche pas l'activité commerciale des boutiques ; un accès technique à la base reste possible pour la maintenance et le support ;",
            "les prestataires techniques qui hébergent et acheminent les données ;",
            "les autorités légalement habilitées à les demander.",
          ],
        },
        {
          facts: [
            ["Vercel", "hébergement du site et acheminement des requêtes ; pays : [À COMPLÉTER : pays de traitement]"],
            ["Render", "hébergement du serveur applicatif et de ses journaux, avec le réseau de Cloudflare ; pays : [À COMPLÉTER : pays de traitement]"],
            ["Supabase", "hébergement de la base de données ; région de Londres, Royaume-Uni"],
            ["Opérateurs de paiement", "les opérateurs que vous utilisez pour payer, selon leurs propres conditions"],
          ],
        },
      ],
    },
    {
      id: "transferts",
      title: "Transferts hors de la CEDEAO",
      blocks: [
        "Les prestataires ci-dessus impliquent un traitement de données hors de la CEDEAO, notamment au Royaume-Uni. Les articles 7 et 26 de la loi n° 2013-450 exigent pour de tels transferts un niveau de protection supérieur ou équivalent et l'autorisation préalable de l'Autorité de protection.",
        "[À COMPLÉTER : références des autorisations de transfert et garanties applicables]",
      ],
    },
    {
      id: "securite",
      title: "Sécurité des données",
      blocks: [
        "Les mesures mises en œuvre dans l'application comprennent notamment :",
        {
          list: [
            "un accès au site et à son serveur en HTTPS ;",
            "des mots de passe enregistrés sous forme d'empreinte bcrypt, jamais en clair ;",
            "des sessions révocables et un cookie de session inaccessible aux scripts ;",
            "un contrôle des rôles et de l'organisation par le serveur ;",
            "une limitation des tentatives de connexion et d'inscription, et un journal de sécurité ;",
            "des journaux techniques sans mot de passe, jeton, cookie ni contenu de requête.",
          ],
        },
        "Aucun système n'est invulnérable. Signalez toute anomalie au contact indiqué dans cette politique. [À COMPLÉTER : procédure d'information en cas d'incident]",
      ],
    },
    {
      id: "droits",
      title: "Droits des utilisateurs",
      blocks: [
        {
          facts: [
            ["Information (article 28)", "connaître l'identité du responsable, les finalités, les destinataires, les durées et les transferts"],
            ["Accès (article 29)", "savoir si des données vous concernant sont traitées, en obtenir communication et l'origine"],
            ["Opposition (article 30)", "vous opposer au traitement pour motif légitime, et gratuitement à toute prospection"],
            ["Rectification (article 31)", "faire corriger, compléter, mettre à jour, verrouiller ou supprimer les données inexactes, périmées ou illicites"],
            ["Droits des ayants droit (article 32)", "faire prendre en compte le décès de la personne concernée"],
            ["Effacement (articles 33 à 36)", "obtenir l'effacement dans les cas prévus, sous réserve des obligations légales de conservation"],
            ["Portabilité (article 38)", "recevoir vos données dans un format électronique structuré et réutilisable"],
            ["Retrait du consentement", "le retirer à tout moment pour l'avenir ; le compte peut alors devoir être clôturé"],
          ],
        },
      ],
    },
    {
      id: "exercice-droits",
      title: "Modalités d'exercice des droits",
      blocks: [
        "Adressez votre demande à [À COMPLÉTER : courrier électronique ou adresse postale], en précisant le droit exercé et l'identifiant de votre compte. Une preuve d'identité proportionnée peut être demandée ; n'envoyez jamais votre mot de passe. [À COMPLÉTER : délai de réponse]",
        "Si la demande porte sur des données saisies par un commerçant, adressez-vous d'abord à lui ; l'éditeur l'assistera.",
        "Vous pouvez adresser une réclamation à l'Autorité de Régulation des Télécommunications/TIC de Côte d'Ivoire (ARTCI), chargée de la protection des données personnelles par les articles 46 et 47 de la loi. L'exercice de vos droits reste possible si vous refusez les documents ou si votre accès est suspendu.",
      ],
    },
    {
      id: "cookies",
      title: "Cookies et traceurs",
      blocks: [
        "À la date de publication de cette version, le code de Rayon n'utilise aucun traceur publicitaire ni outil de mesure d'audience. Il utilise uniquement :",
        {
          facts: [
            ["Cookie rayon_session", "authentification ; 30 jours, prolongés pendant l'utilisation"],
            ["Cookie active_store", "mémorisation de la boutique active ; un an"],
            ["Stockage du navigateur", "thème, état du menu, brouillon de vente et avis de mise à jour déjà masqués ; jusqu'à leur remplacement ou effacement"],
            ["Stockage sécurisé de l'application mobile", "jeton de session et boutique active ; effacés à la déconnexion"],
          ],
        },
        "Ces éléments servent au fonctionnement et au confort demandé. Vous pouvez les effacer dans votre navigateur ou appareil, ce qui vous déconnecte et réinitialise ces préférences. Les hébergeurs peuvent poser des éléments techniques de sécurité selon leurs propres politiques.",
      ],
    },
    {
      id: "modifications",
      title: "Modification de cette politique",
      blocks: [
        "Chaque version porte un numéro et une date et reste consultable. Un nouvel accord est demandé lorsqu'une modification touche aux finalités, aux données, aux destinataires, aux transferts ou aux droits. Une modification sans incidence de cette nature donne lieu à une simple information. Les accords antérieurs sont conservés.",
      ],
    },
  ],
};
