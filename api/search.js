// api/search.js — LeadPulse v4
// ─────────────────────────────────────────────────────────────────────────────
// Source PRINCIPALE : Google Places API  → "barber Nice", "restaurant Bordeaux"
// Source SECONDAIRE : Recherche Entreprises (gouv.fr) → si Google Places vide
// Enrichissement   : Brandfetch (réseaux sociaux)
//
// Variables d'environnement Vercel :
//   GOOGLE_PLACES_API_KEY  ← obligatoire (Places API activée sur Google Cloud)
//   PAPPERS_API_KEY        ← optionnel
//   BRANDFETCH_API_KEY     ← optionnel
// ─────────────────────────────────────────────────────────────────────────────

const GOOGLE_PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY || '';
const PAPPERS_KEY       = process.env.PAPPERS_API_KEY       || '';
const BRANDFETCH_KEY    = process.env.BRANDFETCH_API_KEY    || '';

// ─── GOOGLE PLACES — RECHERCHE TEXTUELLE ────────────────────────────────────
async function searchGooglePlaces(query) {
  if (!GOOGLE_PLACES_KEY) return [];
  try {
    const searchUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json`
      + `?query=${encodeURIComponent(query)}`
      + `&language=fr`
      + `&key=${GOOGLE_PLACES_KEY}`;

    const r = await fetch(searchUrl, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    const d = await r.json();
    const places = d.results || [];
    if (places.length === 0) return [];

    // Récupérer les détails (téléphone, site) pour chaque résultat
    const details = await Promise.allSettled(
      places.slice(0, 20).map(p => fetchPlaceDetails(p.place_id, p))
    );

    return details
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);
  } catch (e) {
    console.error('[Google Places search error]', e.message);
    return [];
  }
}

async function fetchPlaceDetails(placeId, fallback = {}) {
  try {
    const url = `https://maps.googleapis.com/maps/api/place/details/json`
      + `?place_id=${placeId}`
      + `&fields=name,formatted_address,formatted_phone_number,website,rating,user_ratings_total,url,types,business_status`
      + `&language=fr`
      + `&key=${GOOGLE_PLACES_KEY}`;

    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const d = await r.json();
    const p = d.result || {};

    return {
      name:               p.name               || fallback.name || '',
      address:            p.formatted_address  || fallback.formatted_address || '',
      phone:              p.formatted_phone_number || '',
      website:            p.website            || '',
      googleRating:       p.rating             ?? fallback.rating ?? null,
      googleReviewsCount: p.user_ratings_total ?? fallback.user_ratings_total ?? null,
      googleMapsUrl:      p.url                || '',
      businessStatus:     p.business_status    || '',
      types:              p.types              || fallback.types || [],
      placeId,
      email: '', effectif: '', ca: null, capital: '',
      anneeCreation: '', nafLabel: '', nafCode: '',
      formeJuridique: '', dirigeant: '', siret: '', siren: '',
      instagram: '', linkedin: '', twitter: '', facebook: '',
    };
  } catch (e) {
    return null;
  }
}

// ─── BRANDFETCH — réseaux sociaux ───────────────────────────────────────────
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
    return {
      instagram: find('instagram'),
      linkedin:  find('linkedin'),
      twitter:   find('twitter'),
      facebook:  find('facebook'),
    };
  } catch (e) { return {}; }
}

// ─── GOUV.FR — fallback si Google Places non configuré ──────────────────────
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
      const website = s.website || s.url || r.url || '';
      return {
        name: nom, address: adresse,
        phone: s.telephone || '',
        website,
        email: '',
        googleRating: null, googleReviewsCount: null, googleMapsUrl: '',
        effectif: '', ca: null, capital: '',
        anneeCreation: r.date_creation?.substring(0,4) || '',
        nafLabel: r.libelle_activite_principale || '',
        nafCode: r.activite_principale || '',
        formeJuridique: r.nature_juridique || '',
        dirigeant: '',
        siret: s.siret || '', siren: r.siren || '',
        instagram: '', linkedin: '', twitter: '', facebook: '',
        types: [], placeId: '',
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

// ─── HANDLER PRINCIPAL ───────────────────────────────────────────────────────
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
    // ── Source principale : Google Places (ou gouv.fr en fallback) ───────────
    let leads = GOOGLE_PLACES_KEY
      ? await searchGooglePlaces(q)
      : await searchGouvFr(q);

    if (leads.length === 0) {
      return res.status(200).json({ places: [], total: 0 });
    }

    // ── Enrichissement Brandfetch (réseaux sociaux) ──────────────────────────
    await Promise.allSettled(
      leads.slice(0, 10).map(async (lead) => {
        const domain = extractDomain(lead.website);
        if (!domain) return;
        const bf = await fetchBrandfetch(domain);
        if (bf.instagram) lead.instagram = bf.instagram;
        if (bf.linkedin)  lead.linkedin  = bf.linkedin;
        if (bf.twitter)   lead.twitter   = bf.twitter;
        if (bf.facebook)  lead.facebook  = bf.facebook;
      })
    );

    // ── Finalisation ─────────────────────────────────────────────────────────
    leads = leads.map(lead => ({
      ...lead,
      email: lead.email || guessEmail(lead.name, lead.website),
      mapsUrl: lead.googleMapsUrl || (lead.address
        ? 'https://www.google.com/maps/search/' + encodeURIComponent(lead.name + ' ' + lead.address)
        : ''),
      presenceScore: calculateScore(lead),
    }));

    return res.status(200).json({
      places: leads,
      total:  leads.length,
      _sources: {
        googlePlaces: !!GOOGLE_PLACES_KEY,
        pappers:      !!PAPPERS_KEY,
        brandfetch:   !!BRANDFETCH_KEY,
      },
    });

  } catch (e) {
    console.error('[LeadPulse v4 error]', e);
    return res.status(500).json({ error: 'Erreur interne.', detail: e.message });
  }
}
