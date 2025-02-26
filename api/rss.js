// api/rss.js - Versione ulteriormente migliorata
const fetch = require('node-fetch');
const { Agent } = require('https');

// Agente HTTP personalizzato per saltare la verifica SSL in caso di problemi
const httpsAgent = new Agent({
  rejectUnauthorized: false
});

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
  const { url, service } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'URL parametro mancante' });
  }

  const feedUrl = decodeURIComponent(url);
  
  // Determina il servizio da usare (o usa il default)
  // Questo permette di specificare esplicitamente quale servizio usare
  const proxyService = service || 'auto';

  try {
    let data = null;
    let contentType = 'application/xml';
    
    console.log(`Fetching feed: ${feedUrl} using service: ${proxyService}`);

    // 1. Strategia: Usa un servizio specifico o prova automaticamente diversi
    if (proxyService === 'auto' || proxyService === 'direct') {
      try {
        const response = await fetch(feedUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml',
            'Accept-Language': 'en-US,en;q=0.5',
            'Referer': new URL(feedUrl).origin,
            'Cache-Control': 'no-cache'
          },
          agent: httpsAgent
        });
        
        if (response.ok) {
          data = await response.text();
          console.log('Direct fetch successful');
        }
      } catch (error) {
        console.log('Direct fetch failed:', error.message);
      }
    }

    // 2. Strategia: Prova rssbridge.org
    if (!data && (proxyService === 'auto' || proxyService === 'rssbridge')) {
      try {
        // rssbridge.org richiede l'URL nel formato corretto per il tipo di feed
        const urlObj = new URL(feedUrl);
        const hostname = urlObj.hostname;
        
        let bridgeUrl = "";
        
        // Configura URL specifici per domini popolari
        if (hostname.includes('repubblica.it')) {
          bridgeUrl = `https://rssbridge.org/api/?action=display&bridge=Repubblica&url=${encodeURIComponent(feedUrl)}&format=Atom`;
        } else if (hostname.includes('ansa.it')) {
          bridgeUrl = `https://rssbridge.org/api/?action=display&bridge=Ansa&url=${encodeURIComponent(feedUrl)}&format=Atom`;
        } else if (hostname.includes('corriere.it')) {
          bridgeUrl = `https://rssbridge.org/api/?action=display&bridge=Corriere&url=${encodeURIComponent(feedUrl)}&format=Atom`;
        } else {
          // Generic Bridge
          bridgeUrl = `https://rssbridge.org/api/?action=display&bridge=FeedExtractor&url=${encodeURIComponent(feedUrl)}&format=Atom`;
        }
        
        console.log(`Trying rssbridge: ${bridgeUrl}`);
        
        const response = await fetch(bridgeUrl, {
          agent: httpsAgent
        });
        
        if (response.ok) {
          data = await response.text();
          console.log('RSSBridge fetch successful');
        }
      } catch (error) {
        console.log('RSSBridge fetch failed:', error.message);
      }
    }

    // 3. Strategia: full-text RSS
    if (!data && (proxyService === 'auto' || proxyService === 'fulltextrss')) {
      try {
        const ftRssUrl = `https://fullrss.thefreethoughtproject.com/?url=${encodeURIComponent(feedUrl)}`;
        console.log(`Trying fulltextrss: ${ftRssUrl}`);
        
        const response = await fetch(ftRssUrl, {
          agent: httpsAgent
        });
        
        if (response.ok) {
          data = await response.text();
          console.log('FullTextRSS fetch successful');
        }
      } catch (error) {
        console.log('FullTextRSS fetch failed:', error.message);
      }
    }

    // 4. Strategia: Usare API di Feed Parser
    if (!data && (proxyService === 'auto' || proxyService === 'feedparser')) {
      try {
        const parserUrl = `https://api.feedparser.io/parse?url=${encodeURIComponent(feedUrl)}`;
        console.log(`Trying feedparser: ${parserUrl}`);
        
        const response = await fetch(parserUrl, {
          agent: httpsAgent
        });
        
        if (response.ok) {
          const jsonData = await response.json();
          data = jsonData;
          contentType = 'application/json';
          console.log('FeedParser fetch successful');
        }
      } catch (error) {
        console.log('FeedParser fetch failed:', error.message);
      }
    }

    // Verifica finale se abbiamo ottenuto dati
    if (!data) {
      return res.status(404).json({
        error: 'Impossibile recuperare il feed',
        message: 'Tutti i servizi di proxy hanno fallito'
      });
    }

    // Imposta gli header appropriati
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=300'); // Cache per 5 minuti
    
    // Invia il feed
    if (contentType === 'application/json') {
      res.status(200).json(data);
    } else {
      res.status(200).send(data);
    }
  } catch (error) {
    console.error('Errore generale:', error);
    res.status(500).json({ 
      error: 'Errore interno del server', 
      message: error.message 
    });
  }
};