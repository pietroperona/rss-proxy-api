// api/rss.js
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

  // Gestisci le richieste OPTIONS (preflight)
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
    
    // Estrai l'hostname e il riferimento
    const hostname = urlObj.hostname;
    const referer = `${urlObj.protocol}//${hostname}/`;
    
    // Imposta un User-Agent realistico e variato
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    ];
    
    const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
    
    console.log(`Fetching RSS from: ${feedUrl} with User-Agent: ${randomUserAgent.substring(0, 20)}...`);
    
    // Fetch del feed RSS con header realistici
    const response = await fetch(feedUrl, {
      headers: {
        'User-Agent': randomUserAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Referer': referer,
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'Upgrade-Insecure-Requests': '1'
      },
      timeout: 15000 // 15 secondi di timeout
    });

    // Controlla la risposta
    if (!response.ok) {
      console.log(`Failed with status: ${response.status} - ${response.statusText}`);
      
      // Se il feed è bloccato, prova con una fallback strategy
      if (response.status === 403) {
        // Se il link è un feed feedburner, prova il link diretto
        if (hostname.includes('feedburner.com')) {
          const originalFeed = new URLSearchParams(urlObj.search).get('url');
          if (originalFeed) {
            console.log(`Attempting feedburner fallback to: ${originalFeed}`);
            // Redirect alla funzione stessa ma con l'URL originale
            return res.redirect(307, `/api/rss?url=${encodeURIComponent(originalFeed)}`);
          }
        }
        
        // Altre strategie di fallback potrebbero essere implementate qui
      }
      
      return res.status(response.status).json({ 
        error: `Errore nel recupero del feed: ${response.statusText}`,
        status: response.status,
        message: 'Il server RSS ha rifiutato la richiesta. L\'endpoint potrebbe bloccare richieste serverless.'
      });
    }

    // Leggi il contenuto
    const data = await response.text();
    
    // Verifica che sia effettivamente un XML
    if (!data.trim().startsWith('<?xml') && !data.trim().startsWith('<rss') && !data.trim().startsWith('<feed')) {
      return res.status(406).json({
        error: 'Il contenuto recuperato non sembra essere un feed XML valido',
        preview: data.substring(0, 100)
      });
    }
    
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