export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });

  try {
    // Parse "coiffeur La Rochelle" → activite + ville
    const words = query.trim().split(' ');
    // Heuristic: last word(s) = city, first word(s) = activity
    // We'll just pass everything to the API and let it figure out
    const activite = words[0];
    const ville = words.slice(1).join(' ');

    // Map French terms to NAF codes
    const nafMap = {
      coiffeur: '96.02A',
      coiffeuse: '96.02A',
      restaurant: '56.10A',
      restauration: '56.10A',
      boulangerie: '10.71C',
      boulanger: '10.71C',
      pharmacie: '47.73Z',
      pharmacien: '47.73Z',
      dentiste: '86.23Z',
      médecin: '86.21Z',
      photographe: '74.20Z',
      avocat: '69.10Z',
      comptable: '69.20Z',
      architecte: '71.11Z',
      notaire: '69.10Z',
      opticien: '47.78A',
      fleuriste: '47.76Z',
      garage: '45.20A',
      plombier: '43.22A',
      electricien: '43.21A',
      coach: '85.51Z',
      salle: '93.11Z',
      agence: '68.31Z',
      immobilier: '68.31Z',
    };

    let nafCode = null;
    for (const [key, code] of Object.entries(nafMap)) {
      if (activite.toLowerCase().includes(key)) {
        nafCode = code;
        break;
      }
    }

    // Call API Recherche Entreprises (data.gouv.fr)
    let apiUrl;
    if (nafCode && ville) {
      apiUrl = `https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(activite)}&code_naf=${nafCode}&departement=&per_page=25`;
      // Also try with commune
      apiUrl = `https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(activite + ' ' + ville)}&code_naf=${nafCode}&per_page=25`;
    } else {
      apiUrl = `https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(query)}&per_page=25`;
    }

    const apiRes = await fetch(apiUrl, {
      headers: { 'Accept': 'application/json' }
    });
    const apiData = await apiRes.json();

    const results = apiData.results || [];

    // Filter by city name if provided
    const villeNorm = ville.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    
    const filtered = ville ? results.filter(r => {
      const siege = r.siege || {};
      const commune = (siege.libelle_commune || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return commune.includes(villeNorm) || villeNorm.includes(commune.split(' ')[0]);
    }) : results;

    const places = (filtered.length > 0 ? filtered : results).slice(0, 20).map(r => {
      const siege = r.siege || {};
      const adresse = [
        siege.numero_voie,
        siege.type_voie,
        siege.libelle_voie,
        siege.code_postal,
        siege.libelle_commune
      ].filter(Boolean).join(' ');

      return {
        name: r.nom_complet || r.nom_raison_sociale || '—',
        address: adresse,
        phone: '',
        website: '',
        siret: siege.siret || '',
        siren: r.siren || '',
        naf: r.activite_principale || '',
        nafLabel: r.libelle_activite_principale || '',
        rating: null,
        reviewCount: 0,
        mapsUrl: adresse ? `https://www.google.com/maps/search/${encodeURIComponent(adresse)}` : '',
      };
    });

    res.status(200).json({ places, total: apiData.total_results || places.length });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
