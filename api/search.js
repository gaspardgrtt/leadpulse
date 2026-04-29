// api/search.js — LeadPulse v2
// Multi-source: Recherche Entreprises + Annuaire Entreprises (gouv.fr)
// Enrichissement : effectifs, SIRET, NAF, adresse, téléphone, email guess, CA

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query } = req.body || {};
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'Requête manquante' });
  }

  const q = query.trim();

  try {
    // ─── SOURCE 1 : Recherche Entreprises (API officielle) ───────────────────
    // Robuste, rapide, données de base fiables
    const url1 = 'https://recherche-entreprises.api.gouv.fr/search?q='
      + encodeURIComponent(q)
      + '&per_page=25&minimal=false';

    let apiData1;
    try {
      const r1 = await fetch(url1, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!r1.ok) throw new Error('Status ' + r1.status);
      const text = await r1.text();
      apiData1 = JSON.parse(text);
    } catch (e) {
      // Fallback: essayer sans per_page si erreur
      try {
        const r1b = await fetch(
          'https://recherche-entreprises.api.gouv.fr/search?q=' + encodeURIComponent(q) + '&per_page=10',
          { signal: AbortSignal.timeout(6000) }
        );
        apiData1 = await r1b.json();
      } catch (e2) {
        return res.status(503).json({
          error: 'Base de données temporairement indisponible. Réessaie dans quelques instants.',
          detail: e.message
        });
      }
    }

    const results = apiData1.results || [];
    if (results.length === 0) {
      return res.status(200).json({ places: [], total: 0 });
    }

    // ─── ENRICHISSEMENT ─────────────────────────────────────────────────────
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
      const nom = r.nom_usuel || r.nom || '';
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
        s.libelle_commune
      ].filter(Boolean).join(' ');
    }

    function guessEmail(name, website) {
      let domain = '';
      if (website) {
        try {
          const u = new URL(website.startsWith('http') ? website : 'https://' + website);
          domain = u.hostname.replace(/^www\./, '');
        } catch (e) {}
      }
      if (!domain && name) {
        domain = name.toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9\s-]/g, '')
          .trim()
          .split(/\s+/).slice(0, 2).join('')
          + '.fr';
      }
      return domain ? 'contact@' + domain : '';
    }

    // ─── SOURCE 2 : Annuaire des Entreprises (données complémentaires) ───────
    // Récupération en parallèle pour les premiers résultats
    const sirenList = results.slice(0, 8).map(r => r.siren).filter(Boolean);
    const enrichMap = {};

    await Promise.allSettled(
      sirenList.map(async (siren) => {
        try {
          const url2 = 'https://annuaire-entreprises.data.gouv.fr/api/v3/unite_legale/' + siren;
          const r2 = await fetch(url2, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(3000)
          });
          if (r2.ok) {
            const d2 = await r2.json();
            enrichMap[siren] = d2;
          }
        } catch (e) {
          // Enrichissement silencieux — non bloquant
        }
      })
    );

    // ─── MAPPING FINAL ───────────────────────────────────────────────────────
    const places = results.map((r) => {
      const s = r.siege || {};
      const extra = enrichMap[r.siren] || {};

      const nom = cleanName(r);
      const adresse = buildAddress(s);

      // Téléphone
      const phone = s.telephone || extra.telephone || '';

      // Site web
      const website = s.website || extra.site_internet || s.url || r.url || '';

      // Email
      const email = s.email || extra.email || guessEmail(nom, website);

      // Effectifs
      const effectifCode = r.tranche_effectif_salarie
        || s.tranche_effectif_salarie
        || extra.tranche_effectif_salarie
        || '';
      const effectif = formatEffectif(effectifCode);

      // Chiffre d'affaires (rarement disponible via API publique)
      const ca = r.chiffre_affaires || extra.chiffre_affaires || null;

      // Année de création
      const dateCreation = r.date_creation || extra.date_creation || '';
      const anneeCreation = dateCreation ? dateCreation.substring(0, 4) : '';

      // NAF
      const nafCode = r.activite_principale || s.activite_principale || '';
      const nafLabel = r.libelle_activite_principale
        || s.libelle_activite_principale
        || extra.libelle_activite_principale
        || '';

      // Forme juridique
      const formeJuridique = r.nature_juridique || extra.forme_juridique || '';

      // Google Maps
      const mapsUrl = adresse
        ? 'https://www.google.com/maps/search/' + encodeURIComponent(adresse)
        : '';

      return {
        name: nom,
        address: adresse,
        phone,
        website,
        email,
        effectif,
        ca,
        anneeCreation,
        nafLabel,
        nafCode,
        formeJuridique,
        siret: s.siret || '',
        siren: r.siren || '',
        mapsUrl,
        // Score de présence calculé côté serveur
        presenceScore: calculateScore({ phone, website, email, effectif, anneeCreation, mapsUrl }),
      };
    });

    return res.status(200).json({
      places,
      total: apiData1.total_results || places.length,
    });

  } catch (e) {
    console.error('[LeadPulse search error]', e);
    return res.status(500).json({
      error: 'Erreur interne. Si le problème persiste, contacte le support.',
      detail: e.message
    });
  }
}

function calculateScore({ phone, website, email, effectif, anneeCreation, mapsUrl }) {
  let score = 0;
  if (website) score += 3;
  if (phone) score += 2;
  if (email && !email.startsWith('contact@')) score += 2;
  else if (email) score += 1;
  if (effectif && effectif !== '0 salarié') score += 1;
  if (anneeCreation && (new Date().getFullYear() - parseInt(anneeCreation)) >= 3) score += 1;
  if (mapsUrl) score += 1;
  return Math.min(score, 10);
}
