export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });

  const apiKey = process.env.GOOGLE_PLACES_KEY;

  try {
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&language=fr&key=${apiKey}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      return res.status(400).json({ error: data.error_message || data.status });
    }

    const places = (data.results || []).map(p => ({
      name: p.name,
      address: p.formatted_address || '',
      phone: '',
      website: '',
      rating: p.rating || null,
      reviewCount: p.user_ratings_total || 0,
      mapsUrl: `https://www.google.com/maps/place/?q=place_id:${p.place_id}`,
      placeId: p.place_id,
    }));

    const detailed = await Promise.all(places.map(async (p) => {
      try {
        const detailUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${p.placeId}&fields=formatted_phone_number,website&language=fr&key=${apiKey}`;
        const detailRes = await fetch(detailUrl);
        const detailData = await detailRes.json();
        const r = detailData.result || {};
        return { ...p, phone: r.formatted_phone_number || '', website: r.website || '' };
      } catch {
        return p;
      }
    }));

    res.status(200).json({ places: detailed });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
