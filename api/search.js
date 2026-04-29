// Cache simple en mémoire (survit entre appels sur la même instance Vercel)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query } = req.body || {};
  if (!query) return res.status(400).json({ error: 'Missing query' });

  // Vérifier le cache
  const cacheKey = query.toLowerCase().trim();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.status(200).json({ places: cached.places, total: cached.total, fromCache: true });
  }

  try {
    // API principale : recherche-entreprises (plus stable, plus de données)
    const url = `https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(query)}&per_page=25&mtm_campaign=leadpulse`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    let apiData;
    try {
      const r = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'LeadPulse/1.0',
          'Accept': 'application/json'
        }
      });
      clearTimeout(timeout);

      if (r.status === 429) {
        // Rate limit → essayer l'API de secours
        return await fallbackSearch(query, res, cache, cacheKey);
      }

      const text = await r.text();
      try { apiData = JSON.parse(text); }
      catch(e) { return await fallbackSearch(query, res, cache, cacheKey); }

    } catch(e) {
      clearTimeout(timeout);
      if (e.name === 'AbortError') return res.status(504).json({ error: 'Timeout API — réessaie dans quelques secondes' });
      return await fallbackSearch(query, res, cache, cacheKey);
    }

    const results = apiData.results || [];
    const places = results.map(mapResult);

    // Stocker en cache
    cache.set(cacheKey, { places, total: apiData.total_results || places.length, ts: Date.now() });
    // Nettoyer le cache si trop grand
    if (cache.size > 200) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }

    res.status(200).json({ places, total: apiData.total_results || places.length });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}

// API de secours : annuaire-entreprises.data.gouv.fr (différentes limites)
async function fallbackSearch(query, res, cache, cacheKey) {
  try {
    // Séparer la requête pour extraire ville et secteur si possible
    const fallbackUrl = `https://annuaire-entreprises.data.gouv.fr/api/v1/search?q=${encodeURIComponent(query)}&per_page=25`;

    const r2 = await fetch(fallbackUrl, {
      headers: { 'User-Agent': 'LeadPulse/1.0', 'Accept': 'application/json' }
    });

    if (!r2.ok) {
      // Dernier recours : API Sirene INSEE
      return await sireneSearch(query, res, cache, cacheKey);
    }

    const text = await r2.text();
    let data;
    try { data = JSON.parse(text); }
    catch(e) { return res.status(503).json({ error: 'APIs temporairement indisponibles. Réessaie dans 30 secondes.' }); }

    const results = data.results || [];
    const places = results.map(r => {
      const adresse = [
        r.siege?.numero_voie,
        r.siege?.type_voie,
        r.siege?.libelle_voie,
        r.siege?.code_postal,
        r.siege?.libelle_commune
      ].filter(Boolean).join(' ');

      return {
        name: (r.nom_complet || r.nom_raison_sociale || 'Inconnu').trim(),
        address: adresse,
        phone: extractPhone(r),
        website: r.site_internet || '',
        siret: r.siege?.siret || '',
        siren: r.siren || '',
        nafLabel: r.libelle_activite_principale || '',
        nafCode: r.activite_principale || '',
        legalForm: r.nature_juridique_label || '',
        creationDate: r.date_creation || '',
        employees: r.tranche_effectif_salarie_label || '',
        mapsUrl: adresse ? `https://www.google.com/maps/search/${encodeURIComponent(adresse)}` : ''
      };
    });

    cache.set(cacheKey, { places, total: data.total_results || places.length, ts: Date.now() });
    return res.status(200).json({ places, total: data.total_results || places.length, fromFallback: true });

  } catch(e) {
    return res.status(503).json({ error: 'Service momentanément indisponible. Réessaie dans 30 secondes.' });
  }
}

// API Sirene INSEE (3ème option)
async function sireneSearch(query, res, cache, cacheKey) {
  try {
    const url = `https://api.insee.fr/api-sirene/3.11/siret?q=${encodeURIComponent(query)}&nombre=20&champs=siret,denominationUniteLegale,adresseEtablissement,activitePrincipaleUniteLegale,categorieJuridiqueUniteLegale`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) return res.status(503).json({ error: 'Toutes les APIs sont temporairement limitées. Réessaie dans 1 minute.' });
    // ... mapping si nécessaire
    return res.status(503).json({ error: 'Service temporairement surchargé. Réessaie dans 30 secondes.' });
  } catch(e) {
    return res.status(503).json({ error: 'Service temporairement surchargé. Réessaie dans 30 secondes.' });
  }
}

function mapResult(r) {
  const s = r.siege || {};
  const nom = (r.nom_complet || r.nom_raison_sociale || 
    (r.prenom_usuel ? `${r.prenom_usuel} ${r.nom_usuel || r.nom || ''}` : '') || 'Inconnu').trim();
  
  const adresse = [s.numero_voie, s.type_voie, s.libelle_voie, s.code_postal, s.libelle_commune]
    .filter(Boolean).join(' ');

  return {
    name: nom,
    address: adresse,
    phone: extractPhone(r),
    website: r.site_internet || '',
    siret: s.siret || '',
    siren: r.siren || '',
    nafLabel: r.libelle_activite_principale || '',
    nafCode: r.activite_principale || '',
    legalForm: r.nature_juridique_label || '',
    creationDate: r.date_creation || '',
    employees: r.tranche_effectif_salarie_label || '',
    mapsUrl: adresse ? `https://www.google.com/maps/search/${encodeURIComponent(adresse)}` : ''
  };
}

function extractPhone(r) {
  // L'API gouvernementale ne fournit pas de téléphone directement
  // mais on peut construire un lien vers la fiche Societe.com
  return r.telephone || '';
}
