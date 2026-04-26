export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { query } = req.body || {};
  if (!query) return res.status(400).json({ error: 'Missing query' });
  try {
    const url = 'https://recherche-entreprises.api.gouv.fr/search?q=' + encodeURIComponent(query) + '&per_page=20';
    const r = await fetch(url);
    const text = await r.text();
    let apiData;
    try { apiData = JSON.parse(text); } catch(e) { return res.status(500).json({ error: 'API response invalid: ' + text.slice(0,200) }); }
    const results = apiData.results || [];
    const places = results.map(function(r) {
      var s = r.siege || {};
      var nom = r.nom_complet || r.nom_raison_sociale || (r.prenom_usuel ? r.prenom_usuel + ' ' + (r.nom_usuel || r.nom || '') : '') || 'Inconnu';
      var adresse = [s.numero_voie, s.type_voie, s.libelle_voie, s.code_postal, s.libelle_commune].filter(Boolean).join(' ');
      return {
        name: nom.trim(),
        address: adresse,
        phone: '',
        website: '',
        siret: s.siret || '',
        nafLabel: r.libelle_activite_principale || '',
        mapsUrl: adresse ? 'https://www.google.com/maps/search/' + encodeURIComponent(adresse) : ''
      };
    });
    res.status(200).json({ places: places, total: apiData.total_results || places.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
