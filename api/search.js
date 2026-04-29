// api/search.js — LeadPulse v3
// ─────────────────────────────────────────────────────────────────────────────
// Sources :
//   1. Recherche Entreprises (gouv.fr)     — données de base, SIREN, siège
//   2. Annuaire Entreprises (gouv.fr)      — compléments légaux
//   3. Pappers API                         — téléphone, dirigeants (PRIORITÉ)
//   4. Google Places API                   — note, avis, place_id
//   5. Brandfetch API                      — réseaux sociaux (Instagram, LinkedIn…)
//
// Variables d'environnement requises (Vercel → Settings → Environment Variables) :
//   PAPPERS_API_KEY        → https://www.pappers.fr/api
//   GOOGLE_PLACES_API_KEY  → https://console.cloud.google.com (Places API activée)
//   BRANDFETCH_API_KEY     → https://brandfetch.com/developers
// ─────────────────────────────────────────────────────────────────────────────

const PAPPERS_KEY       = process.env.PAPPERS_API_KEY        || '';
const GOOGLE_PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY  || '';
const BRANDFETCH_KEY    = process.env.BRANDFETCH_API_KEY      || '';

// ─── HELPERS EXTERNES ────────────────────────────────────────────────────────

/**
 * Pappers : téléphone + dirigeants à partir du SIREN.
 * Doc : https://www.pappers.fr/api/documentation
 * Gratuit jusqu'à 100 req/mois, puis ~29€/mois.
 */
async function fetchPappers(siren) {
  if (!PAPPERS_KEY) return {};
  try {
    const url = `https://api.pappers.fr/v2/entreprise?siren=${siren}&api_token=${PAPPERS_KEY}`;
    const r = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return {};
    const d = await r.json();
    return {
      phone:     d.siege?.telephone || d.siege?.telephone_formate || '',
      dirigeant: d.dirigeants?.[0]
        ? [d.dirigeants[0].prenom, d.dirigeants[0].nom].filter(Boolean).join(' ')
        : '',
      formeJuridique: d.forme_juridique || '',
      dateImmatriculation: d.date_immatriculation || '',
      capital: d.capital ? `${d.capital.toLocaleString('fr-FR')} €` : '',
    };
  } catch (e) {
    return {};
  }
}

/**
 * Google Places : note + nombre d'avis + place_id.
 * Doc : https://developers.google.com/maps/documentation/places/web-service
 * ~17$/1000 req (200$/mois offerts).
 *
 * Stratégie en 2 étapes :
 *   1. findplacefromtext  → place_id
 *   2. place details      → rating, user_ratings_total, url
 */
async function fetchGooglePlaces(name, address) {
  if (!GOOGLE_PLACES_KEY) return {};
  try {
    const input = encodeURIComponent(`${name} ${address}`);
    const findUrl = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json`
      + `?input=${input}&inputtype=textquery`
      + `&fields=place_id,rating,user_ratings_total,name`
      + `&key=${GOOGLE_PLACES_KEY}`;

    const r1 = await fetch(findUrl, { signal: AbortSignal.timeout(4000) });
    if (!r1.ok) return {};
    const d1 = await r1.json();
    const candidate = d1.candidates?.[0];
    if (!candidate) return {};

    // Étape 2 : détails pour récupérer l'URL Google Maps officielle
    const detailUrl = `https://maps.googleapis.com/maps/api/place/details/json`
      + `?place_id=${candidate.place_id}`
      + `&fields=rating,user_ratings_total,url,formatted_phone_number`
      + `&key=${GOOGLE_PLACES_KEY}`;

    const r2 = await fetch(detailUrl, { signal: AbortSignal.timeout(4000) });
    const d2 = r2.ok ? await r2.json() : { result: {} };
    const detail = d2.result || {};

    return {
      googleRating:       detail.rating       ?? candidate.rating       ?? null,
      googleReviewsCount: detail.user_ratings_total ?? candidate.user_ratings_total ?? null,
      googleMapsUrl:      detail.url || '',
      // Bonus : parfois Google a le téléphone formaté
      phoneFromGoogle:    detail.formatted_phone_number || '',
    };
  } catch (e) {
    return {};
  }
}

/**
 * Brandfetch : réseaux sociaux à partir du domaine.
 * Doc : https://docs.brandfetch.com
 * 500 req/mois gratuites, puis $99/mois.
 */
async function fetchBrandfetch(domain) {
  if (!BRANDFETCH_KEY || !domain) return {};
  try {
    const r = await fetch(`https://api.brandfetch.io/v2/brands/${domain}`, {
      headers: { Authorization: `Bearer ${BRANDFETCH_KEY}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return {};
    const d = await r.json();
    const links = d.links || [];
    const find  = (type) => links.find(l => l.type === type)?.url || '';
    return {
      instagram: find('instagram'),
      linkedin:  find('linkedin'),
      twitter:   find('twitter'),
      facebook:  find('facebook'),
      youtube:   find('youtube'),
    };
  } catch (e) {
    return {};
  }
}

// ─── UTILITAIRES ─────────────────────────────────────────────────────────────

const EFFECTIF_MAP = {
  '00':'0 salarié','01':'1-2','02':'3-5','03':'6-9','11':'10-19',
  '12':'20-49','21':'50-99','22':'100-199','31':'200-249','32':'250-499',
  '41':'500-999','42':'1 000-1 999','51':'2 000-4 999','52':'5 000-9 999','53':'10 000+'
};

function formatEffectif(code) {
  if (!code) return '';
  return EFFECTIF_MAP[code] || '';
}

function cleanName(r) {
  if (r.nom_complet) return r.nom_complet.trim();
  if (r.nom_raison_sociale) return r.nom_raison_sociale.trim();
  const prenom = r.prenom_usuel || r.prenom_1 || '';
  const nom    = r.nom_usuel    || r.nom      || '';
  if (prenom || nom) return (prenom + ' ' + nom).trim();
  return 'Entreprise inconnue';
}

function buildAddress(s) {
  return [
    s.numero_voie,
    s.indice_repetition_etablissement,
    s.type_voie,
    s.libelle_voie,
    s.complement_adresse,
    s.code_postal,
    s.libelle_commune,
  ].filter(Boolean).join(' ');
}

function extractDomain(website) {
  if (!website) return '';
  try {
    const u = new URL(website.startsWith('http') ? website : 'https://' + website);
    return u.hostname.replace(/^www\./, '');
  } catch (e) {
    return '';
  }
}

function guessEmail(name, website) {
  const domain = extractDomain(website) || (
    name
      ? name.toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9\s-]/g, '')
          .trim()
          .split(/\s+/).slice(0, 2).join('') + '.fr'
      : ''
  );
  return domain ? 'contact@' + domain : '';
}

function calculateScore({ phone, website, email, effectif, anneeCreation, googleRating, instagram, linkedin }) {
  let score = 0;
  if (website)                                                       score += 2;
  if (phone)                                                         score += 2;
  if (email && !email.startsWith('contact@'))                        score += 2;
  else if (email)                                                    score += 1;
  if (effectif && effectif !== '0 salarié')                         score += 1;
  if (anneeCreation && (new Date().getFullYear() - parseInt(anneeCreation)) >= 3) score += 1;
  if (googleRating)                                                  score += 1;
  if (instagram || linkedin)                                         score += 1;
  return Math.min(score, 10);
}

// ─── HANDLER PRINCIPAL ───────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { query } = req.body || {};
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'Requête manquante' });
  }

  const q = query.trim();

  try {
    // ── SOURCE 1 : Recherche Entreprises ─────────────────────────────────────
    let apiData1;
    try {
      const r1 = await fetch(
        'https://recherche-entreprises.api.gouv.fr/search?q=' + encodeURIComponent(q) + '&per_page=25&minimal=false',
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }
      );
      if (!r1.ok) throw new Error('Status ' + r1.status);
      apiData1 = await r1.json();
    } catch (e) {
      try {
        const r1b = await fetch(
          'https://recherche-entreprises.api.gouv.fr/search?q=' + encodeURIComponent(q) + '&per_page=10',
          { signal: AbortSignal.timeout(6000) }
        );
        apiData1 = await r1b.json();
      } catch (e2) {
        return res.status(503).json({
          error: 'Base de données temporairement indisponible. Réessaie dans quelques instants.',
          detail: e.message,
        });
      }
    }

    const results = apiData1.results || [];
    if (results.length === 0) {
      return res.status(200).json({ places: [], total: 0 });
    }

    // ── SOURCE 2 : Annuaire Entreprises (compléments légaux) ─────────────────
    const sirenList = results.slice(0, 8).map(r => r.siren).filter(Boolean);
    const enrichMap   = {};   // annuaire
    const pappersMap  = {};   // pappers

    await Promise.allSettled([
      // Annuaire
      ...sirenList.map(async (siren) => {
        try {
          const r2 = await fetch(
            'https://annuaire-entreprises.data.gouv.fr/api/v3/unite_legale/' + siren,
            { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(3000) }
          );
          if (r2.ok) enrichMap[siren] = await r2.json();
        } catch (e) {}
      }),
      // ── SOURCE 3 : Pappers (téléphone fiable, dirigeants) ────────────────
      ...sirenList.map(async (siren) => {
        pappersMap[siren] = await fetchPappers(siren);
      }),
    ]);

    // ── MAPPING INTERMÉDIAIRE (avant enrichissement Google + Brandfetch) ─────
    const intermediate = results.map((r) => {
      const s      = r.siege      || {};
      const extra  = enrichMap[r.siren]  || {};
      const pappers = pappersMap[r.siren] || {};

      const nom     = cleanName(r);
      const adresse = buildAddress(s);

      // Téléphone : Pappers > siège > annuaire > Google (rempli après)
      const phone = pappers.phone
        || s.telephone
        || extra.telephone
        || '';

      // Site web
      const website = s.website || extra.site_internet || s.url || r.url || '';

      // Email
      const email = s.email || extra.email || guessEmail(nom, website);

      // Effectifs
      const effectif = formatEffectif(
        r.tranche_effectif_salarie || s.tranche_effectif_salarie || extra.tranche_effectif_salarie || ''
      );

      // Financier
      const ca             = r.chiffre_affaires || extra.chiffre_affaires || null;
      const capital        = pappers.capital || '';
      const dateCreation   = r.date_creation || extra.date_creation || '';
      const anneeCreation  = dateCreation ? dateCreation.substring(0, 4) : '';

      // NAF
      const nafCode  = r.activite_principale || s.activite_principale || '';
      const nafLabel = r.libelle_activite_principale || s.libelle_activite_principale || extra.libelle_activite_principale || '';

      // Forme juridique
      const formeJuridique = pappers.formeJuridique || r.nature_juridique || extra.forme_juridique || '';

      // Dirigeant
      const dirigeant = pappers.dirigeant || '';

      // Domain (pour Brandfetch)
      const domain = extractDomain(website);

      // Google Maps (URL de recherche — sera remplacé par l'URL officielle si Google Places répond)
      const mapsUrl = adresse
        ? 'https://www.google.com/maps/search/' + encodeURIComponent(nom + ' ' + adresse)
        : '';

      return {
        name: nom, address: adresse, phone, website, email,
        effectif, ca, capital, anneeCreation, nafLabel, nafCode,
        formeJuridique, dirigeant, domain,
        siret: s.siret || '', siren: r.siren || '',
        mapsUrl,
        // Champs enrichis à remplir dans l'étape suivante
        googleRating: null, googleReviewsCount: null, googleMapsUrl: '',
        instagram: '', linkedin: '', twitter: '', facebook: '', youtube: '',
      };
    });

    // ── SOURCES 4 & 5 : Google Places + Brandfetch (en parallèle) ────────────
    // Limités aux 8 premiers pour maîtriser les coûts API
    await Promise.allSettled(
      intermediate.slice(0, 8).map(async (lead) => {
        const [gPlaces, bFetch] = await Promise.all([
          fetchGooglePlaces(lead.name, lead.address),
          fetchBrandfetch(lead.domain),
        ]);

        // Google Places
        if (gPlaces.googleRating != null)  lead.googleRating       = gPlaces.googleRating;
        if (gPlaces.googleReviewsCount)    lead.googleReviewsCount = gPlaces.googleReviewsCount;
        if (gPlaces.googleMapsUrl)         lead.googleMapsUrl      = gPlaces.googleMapsUrl;
        // Téléphone bonus Google (si toujours vide)
        if (!lead.phone && gPlaces.phoneFromGoogle) lead.phone = gPlaces.phoneFromGoogle;

        // Brandfetch
        if (bFetch.instagram) lead.instagram = bFetch.instagram;
        if (bFetch.linkedin)  lead.linkedin  = bFetch.linkedin;
        if (bFetch.twitter)   lead.twitter   = bFetch.twitter;
        if (bFetch.facebook)  lead.facebook  = bFetch.facebook;
        if (bFetch.youtube)   lead.youtube   = bFetch.youtube;
      })
    );

    // ── SCORE FINAL ──────────────────────────────────────────────────────────
    const places = intermediate.map((lead) => ({
      ...lead,
      // Supprimer le champ interne domain
      domain: undefined,
      presenceScore: calculateScore({
        phone:         lead.phone,
        website:       lead.website,
        email:         lead.email,
        effectif:      lead.effectif,
        anneeCreation: lead.anneeCreation,
        googleRating:  lead.googleRating,
        instagram:     lead.instagram,
        linkedin:      lead.linkedin,
      }),
    }));

    return res.status(200).json({
      places,
      total: apiData1.total_results || places.length,
      // Info debug : quelles clés API sont actives
      _sources: {
        pappers:      !!PAPPERS_KEY,
        googlePlaces: !!GOOGLE_PLACES_KEY,
        brandfetch:   !!BRANDFETCH_KEY,
      },
    });

  } catch (e) {
    console.error('[LeadPulse search error]', e);
    return res.status(500).json({
      error: 'Erreur interne. Si le problème persiste, contacte le support.',
      detail: e.message,
    });
  }
}
