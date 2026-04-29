// api/search.js — LeadPulse v5
// ─────────────────────────────────────────────────────────────────────────────
// Source PRINCIPALE : Overpass API (OpenStreetMap) — 100% gratuit, sans clé
// Source SECONDAIRE : Recherche Entreprises (gouv.fr) — fallback nom entreprise
// Enrichissement   : Brandfetch (réseaux sociaux) — optionnel
//
// Aucune clé API obligatoire.
// BRANDFETCH_API_KEY → optionnel (500 req/mois free)
// ─────────────────────────────────────────────────────────────────────────────

const BRANDFETCH_KEY = process.env.BRANDFETCH_API_KEY || '';

// ─── MAPPING SECTEUR → TAGS OSM ─────────────────────────────────────────────
function queryToOsmTags(query) {
  const q = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const map = [
    [/barber|barbier|coiffeur|coiffure|hair/,        [['shop','hairdresser'],['shop','barber']]],
    [/onglerie|manucure|nail/,                        [['shop','nail_salon']]],
    [/esthetique|estheticien|beauty|spa|institut/,    [['shop','beauty'],['leisure','spa']]],
    [/tatouage|tattoo|piercing/,                      [['shop','tattoo']]],
    [/restaurant|resto|brasserie|bistro/,             [['amenity','restaurant']]],
    [/fast.?food|burger|kebab|tacos/,                 [['amenity','fast_food']]],
    [/pizza|pizzeria/,                                [['amenity','restaurant']]],
    [/sushi|japonais/,                                [['amenity','restaurant']]],
    [/cafe|café|coffee/,                              [['amenity','cafe']]],
    [/boulangerie|boulanger|patisserie/,              [['shop','bakery']]],
    [/bar|pub/,                                       [['amenity','bar'],['amenity','pub']]],
    [/salle.?(sport|fitness|muscu)|gym|crossfit/,     [['leisure','fitness_centre']]],
    [/yoga|pilates/,                                  [['leisure','fitness_centre']]],
    [/piscine|natation/,                              [['leisure','swimming_pool']]],
    [/garage|mecanique|carrosserie/,                  [['shop','car_repair']]],
    [/pharmacie/,                                     [['amenity','pharmacy']]],
    [/medecin|docteur|cabinet.medical/,               [['amenity','doctors']]],
    [/dentiste|dentaire/,                             [['amenity','dentist']]],
    [/avocat|juridique/,                              [['office','lawyer']]],
    [/immo|immobilier/,                               [['office','estate_agent']]],
    [/supermarche|supermarché|epicerie/,              [['shop','supermarket'],['shop','convenience']]],
    [/boucher|boucherie/,                             [['shop','butcher']]],
    [/fleuriste/,                                     [['shop','florist']]],
    [/librairie/,                                     [['shop','books']]],
    [/vetement|mode|boutique/,                        [['shop','clothes']]],
    [/hotel|hebergement/,                             [['tourism','hotel']]],
    [/plombier/,                                      [['craft','plumber']]],
    [/electricien/,                                   [['craft','electrician']]],
    [/peintre/,                                       [['craft','painter']]],
    [/informatique|ordinateur/,                       [['shop','computer']]],
    [/photographe/,                                   [['shop','photo']]],
    [/agence.voyage/,                                 [['shop','travel_agency']]],
    [/pressing|laverie|nettoyage/,                    [['shop','laundry'],['shop','dry_cleaning']]],
    [/opticien|lunette/,                              [['shop','optician']]],
    [/bijouterie|bijou/,                              [['shop','jewelry']]],
    [/librairie|papeterie/,                           [['shop','stationery']]],
    [/veterinaire|veto/,                              [['amenity','veterinary']]],
    [/ecole|cours|formation/,                         [['amenity','school'],['amenity','college']]],
    [/notaire/,                                       [['office','notary']]],
    [/comptable|expert.comptable/,                    [['office','accountant']]],
  ];
  for (const [regex, tags] of map) {
    if (regex.test(q)) return tags;
  }
  return null;
}

// ─── EXTRACTION VILLE ────────────────────────────────────────────────────────
function extractCity(query) {
  const words = query.trim().split(/\s+/);
  return words.length >= 2 ? words.slice(-2).join(' ') : query;
}

// ─── GÉOCODAGE VILLE → coordonnées ──────────────────────────────────────────
async function geocodeCity(city) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city + ' France')}&format=json&limit=1&countrycodes=fr`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'LeadPulse/1.0 contact@leadpulse.fr' },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d[0]) return null;
    return { lat: parseFloat(d[0].lat), lon: parseFloat(d[0].lon) };
  } catch (e) { return null; }
}

// ─── OVERPASS ────────────────────────────────────────────────────────────────
async function searchOverpass(tags, lat, lon, radius = 8000) {
  try {
    const tagQueries = tags.map(([k, v]) =>
      `node["${k}"="${v}"](around:${radius},${lat},${lon});\n` +
      `way["${k}"="${v}"](around:${radius},${lat},${lon});`
    ).join('\n');

    const overpassQuery = `[out:json][timeout:25];\n(\n${tagQueries}\n);\nout center 25;`;

    const r = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(overpassQuery),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return [];
    const d = await r.json();
    return d.elements || [];
  } catch (e) {
    console.error('[Overpass error]', e.message);
    return [];
  }
}

// ─── OSM → LeadPulse ─────────────────────────────────────────────────────────
function osmToLead(el) {
  const t = el.tags || {};
  const lat = el.lat || el.center?.lat;
  const lon = el.lon || el.center?.lon;
  const name = t.name || t['name:fr'] || '';
  if (!name) return null;

  const address = [
    t['addr:housenumber'], t['addr:street'],
    t['addr:postcode'],    t['addr:city'],
  ].filter(Boolean).join(' ');

  const phone   = (t.phone || t['contact:phone'] || t['contact:mobile'] || '').replace(/\s/g, '');
  const website = t.website || t['contact:website'] || '';
  const email   = t.email   || t['contact:email']   || '';
  const instagram = t['contact:instagram'] || t['instagram'] || '';
  const facebook  = t['contact:facebook']  || t['facebook']  || '';
  const mapsUrl   = lat && lon ? `https://www.google.com/maps?q=${lat},${lon}` : '';

  return {
    name, address, phone, website, email,
    googleRating: null, googleReviewsCount: null, googleMapsUrl: mapsUrl, mapsUrl,
    effectif: '', ca: null, capital: '', anneeCreation: '',
    nafLabel: t.shop || t.amenity || t.craft || t.office || t.leisure || '',
    nafCode: '', formeJuridique: '', dirigeant: '', siret: '', siren: '',
    instagram, facebook, linkedin: '', twitter: '',
  };
}

// ─── BRANDFETCH ──────────────────────────────────────────────────────────────
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
    const find = (type) => links.find(l => l.type === type)?.url || '';
    return { instagram: find('instagram'), linkedin: find('linkedin'), twitter: find('twitter'), facebook: find('facebook') };
  } catch (e) { return {}; }
}

// ─── GOUV.FR FALLBACK ────────────────────────────────────────────────────────
async function searchGouvFr(query) {
  try {
    const r = await fetch(
      'https://recherche-entreprises.api.gouv.fr/search?q=' + encodeURIComponent(query) + '&per_page=25&minimal=false',
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return [];
    const d = await r.json();
    return (d.results || []).map(r => {
      const s = r.siege || {};
      const nom = r.nom_complet || r.nom_raison_sociale || 'Entreprise inconnue';
      const adresse = [s.numero_voie, s.type_voie, s.libelle_voie, s.code_postal, s.libelle_commune].filter(Boolean).join(' ');
      const website = s.website || s.url || '';
      return {
        name: nom, address: adresse, phone: s.telephone || '', website, email: '',
        googleRating: null, googleReviewsCount: null, googleMapsUrl: '',
        mapsUrl: adresse ? 'https://www.google.com/maps/search/' + encodeURIComponent(nom + ' ' + adresse) : '',
        effectif: '', ca: null, capital: '', anneeCreation: r.date_creation?.substring(0,4) || '',
        nafLabel: r.libelle_activite_principale || '', nafCode: r.activite_principale || '',
        formeJuridique: r.nature_juridique || '', dirigeant: '',
        siret: s.siret || '', siren: r.siren || '',
        instagram: '', linkedin: '', twitter: '', facebook: '',
      };
    });
  } catch (e) { return []; }
}

// ─── UTILITAIRES ─────────────────────────────────────────────────────────────
function extractDomain(website) {
  if (!website) return '';
  try {
    const u = new URL(website.startsWith('http') ? website : 'https://' + website);
    return u.hostname.replace(/^www\./, '');
  } catch (e) { return ''; }
}

function guessEmail(name, website) {
  const domain = extractDomain(website);
  if (domain) return 'contact@' + domain;
  const slug = (name || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '').slice(0, 20);
  return slug ? `contact@${slug}.fr` : '';
}

function calculateScore({ phone, website, email, googleRating, instagram, linkedin, anneeCreation }) {
  let score = 0;
  if (website)                                                                    score += 2;
  if (phone)                                                                      score += 2;
  if (email && !email.startsWith('contact@'))                                     score += 2;
  else if (email)                                                                 score += 1;
  if (googleRating)                                                               score += 1;
  if (instagram || linkedin)                                                      score += 1;
  if (anneeCreation && (new Date().getFullYear() - parseInt(anneeCreation)) >= 3) score += 1;
  return Math.min(score, 10);
}

// ─── HANDLER ─────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { query } = req.body || {};
  if (!query?.trim()) return res.status(400).json({ error: 'Requête manquante' });

  const q = query.trim();

  try {
    let leads  = [];
    let source = 'gouv';

    const osmTags = queryToOsmTags(q);

    if (osmTags) {
      const city = extractCity(q);
      const geo  = await geocodeCity(city);

      if (geo) {
        const elements = await searchOverpass(osmTags, geo.lat, geo.lon);
        leads  = elements.map(osmToLead).filter(Boolean);
        source = 'osm';
      }
    }

    // Fallback gouv.fr
    if (leads.length === 0) {
      leads  = await searchGouvFr(q);
      source = 'gouv';
    }

    if (leads.length === 0) {
      return res.status(200).json({ places: [], total: 0 });
    }

    // Enrichissement Brandfetch
    await Promise.allSettled(
      leads.slice(0, 10).map(async (lead) => {
        const domain = extractDomain(lead.website);
        if (!domain) return;
        const bf = await fetchBrandfetch(domain);
        if (bf.instagram) lead.instagram = bf.instagram;
        if (bf.linkedin)  lead.linkedin  = bf.linkedin;
        if (bf.twitter)   lead.twitter   = bf.twitter;
        if (bf.facebook && !lead.facebook) lead.facebook = bf.facebook;
      })
    );

    leads = leads.map(lead => ({
      ...lead,
      email:         lead.email || guessEmail(lead.name, lead.website),
      presenceScore: calculateScore(lead),
    }));

    return res.status(200).json({
      places:  leads,
      total:   leads.length,
      _source: source,
      _sources: { osm: true, brandfetch: !!BRANDFETCH_KEY },
    });

  } catch (e) {
    console.error('[LeadPulse v5 error]', e);
    return res.status(500).json({ error: 'Erreur interne.', detail: e.message });
  }
};
