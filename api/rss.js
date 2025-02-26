const fetch = require('node-fetch');

module.exports = async (req, res) => {
  // Abilita CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  // Gestisci le richieste OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Controlla che ci sia l'URL del feed
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'URL parametro mancante' });
  }

  try {
    // Validazione URL per sicurezza
    const feedUrl = decodeURIComponent(url);
    const urlObj = new URL(feedUrl);
    
    // Opzionale: whitelist di domini consentiti
    const allowedDomains = [
      'wired.it',
      'ilpost.it',
      'repubblica.it',
      'ansa.it',
      'italiastartup.it',
      // Aggiungi altri domini qui
    ];
    
    // Verifica che il dominio sia nella whitelist
    const domain = urlObj.hostname.replace('www.', '');
    if (!allowedDomains.some(allowed => domain.endsWith(allowed))) {
      return res.status(403).json({ 
        error: 'Dominio non consentito', 
        domain: domain 
      });
    }

    // Fetch del feed RSS
  const response = await fetch(feedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    timeout: 10000 // 10 secondi di timeout
  });

    // Controlla la risposta
    if (!response.ok) {
      return res.status(response.status).json({ 
        error: `Errore nel recupero del feed: ${response.statusText}`,
        status: response.status
      });
    }

    // Leggi il contenuto
    const data = await response.text();
    
    // Imposta gli header appropriati
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Cache-Control', 'public, max-age=300'); // Cache per 5 minuti
    
    // Invia il feed
    res.status(200).send(data);
  } catch (error) {
    console.error('Errore nel proxy RSS:', error);
    res.status(500).json({ 
      error: 'Errore interno del server', 
      message: error.message 
    });
  }
};