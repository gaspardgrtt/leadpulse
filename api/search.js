export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });

  try {
    const words = query.trim().split(' ');
    const ville = words.slice(1).join(' ');

    const apiUrl = `https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(query)}&per_page=25&include=siege`;
    const apiRes = await fetch(apiUrl, { headers: { 'Accept': 'application/json' } });
    const apiData = await apiRes.json();
    const results = apiData.results || [];

    const places = results.slice(0, 20).map(r => {
      const nom = r.nom_complet
        || r.nom_raison_sociale
        || [r.prenom_usuel, r.nom_usuel].filter(Boolean).join(' ')
        || [r.prenom_usuel, r.nom].filter(Boolean).join(' ')
        || '(nom inconnu)';

      const s = r.siege || {};
      const adresse = [s.numero_voie, s.type_voie, s.libelle_voie, s.code_postal, s.libelle_commune].filter(Boolean).join(' ');

      return {
        name: nom,
        address: adresse || ville || '',
        phone: '',
        website: '',
        siret: s.siret || '',
        nafLabel: r.libelle_activite_principale || '',
        mapsUrl: adresse ? `https://www.google.com/maps/search/${encodeURIComponent(adresse)}` : '',
        _raw_keys: Object.keys(r).join(','),
      };
    });

    res.status(200).json({ places, total: apiData.total_results || places.length, _debug: results[0] });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
