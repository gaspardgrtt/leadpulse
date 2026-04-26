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

    const apiUrl = `https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(query)}&per_page=25`;
    const apiRes = await fetch(apiUrl, { headers: { 'Accept': 'application/json' } });
    const apiData = await apiRes.json();
    const results = apiData.results || [];

    const places = results.slice(0, 20).map(r => {
      const nom = r.nom_compl
