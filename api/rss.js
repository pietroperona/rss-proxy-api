// api/rss.js - Versione con debugging e ottimizzazioni
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
  const { url, debug } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'URL parametro mancante' });
  }

  const feedUrl = decodeURIComponent(url);
  const isDebug = debug === 'true';
  
  try {
    // Log per debugging
    if (isDebug) {
      console.log(`Processing request for: ${feedUrl}`);
    }
    
    // Determina gli header da usare in base al dominio
    let headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/xml, application/rss+xml, application/atom+xml, text/html',
      'Cache-Control': 'no-cache'
    };
    
    // Header specializzati per Wired
    if (feedUrl.includes('wired.it')) {
      headers['Accept'] = 'application/rss+xml, application/xml';
      if (isDebug) {
        console.log('Usando header specializzati per Wired');
      }
    }
    
    // Header specializzati per The Information
    if (feedUrl.includes('theinformation.com')) {
      headers['Accept'] = 'application/atom+xml, application/xml';
      if (isDebug) {
        console.log('Usando header specializzati per The Information');
      }
    }
    
    // Tentativo diretto
    try {
      if (isDebug) {
        console.log('Tentativo recupero diretto');
      }
      
      const response = await fetch(feedUrl, {
        headers,
        agent: httpsAgent
      });
      
      if (response.ok) {
        const data = await response.text();
        const contentType = response.headers.get('content-type') || 'application/xml';
        
        if (isDebug) {
          console.log(`Feed recuperato con content-type: ${contentType}`);
          console.log(`Primi 200 caratteri: ${data.substring(0, 200)}`);
        }
        
        // Trasforma il feed di Wired per rendere l'immagine più accessibile
        if (feedUrl.includes('wired.it')) {
          if (isDebug) {
            console.log('Applicando trasformazioni per Wired');
          }
          
          // Cerca di trasformare i tag media:thumbnail in qualcosa di più accessibile
          const transformedData = data.replace(
            /<media:thumbnail url="([^"]+)"([^>]*)\/>/g, 
            '<media:thumbnail url="$1"$2/><enclosure url="$1" type="image/jpeg"/>'
          );
          
          res.setHeader('Content-Type', contentType);
          res.setHeader('Cache-Control', 'public, max-age=300');
          return res.status(200).send(transformedData);
        }
        
        // Imposta gli header appropriati
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=300');
        
        // Invia il feed senza modifiche
        return res.status(200).send(data);
      } else {
        if (isDebug) {
          console.log(`Recupero diretto fallito: ${response.status} ${response.statusText}`);
        }
      }
    } catch (error) {
      if (isDebug) {
        console.error('Errore recupero diretto:', error.message);
      }
    }
    
    // Tentativo con RSSBridge come fallback
    try {
      if (isDebug) {
        console.log('Tentativo con RSSBridge');
      }
      
      const hostname = new URL(feedUrl).hostname;
      
      let bridgeUrl = `https://rssbridge.org/api/?action=display&bridge=FeedExtractor&url=${encodeURIComponent(feedUrl)}&format=Atom`;
      
      // Configura URL specifici per domini popolari
      if (hostname.includes('repubblica.it')) {
        bridgeUrl = `https://rssbridge.org/api/?action=display&bridge=Repubblica&url=${encodeURIComponent(feedUrl)}&format=Atom`;
      } else if (hostname.includes('ansa.it')) {
        bridgeUrl = `https://rssbridge.org/api/?action=display&bridge=Ansa&url=${encodeURIComponent(feedUrl)}&format=Atom`;
      } else if (hostname.includes('corriere.it')) {
        bridgeUrl = `https://rssbridge.org/api/?action=display&bridge=Corriere&url=${encodeURIComponent(feedUrl)}&format=Atom`;
      }
      
      if (isDebug) {
        console.log(`URL RSSBridge: ${bridgeUrl}`);
      }
      
      const response = await fetch(bridgeUrl, {
        agent: httpsAgent
      });
      
      if (response.ok) {
        const data = await response.text();
        
        if (isDebug) {
          console.log('RSSBridge success');
          console.log(`Primi 200 caratteri: ${data.substring(0, 200)}`);
        }
        
        // Imposta gli header appropriati
        res.setHeader('Content-Type', 'application/xml');
        res.setHeader('Cache-Control', 'public, max-age=300');
        
        // Invia il feed
        return res.status(200).send(data);
      } else {
        if (isDebug) {
          console.log(`RSSBridge fallito: ${response.status}`);
        }
      }
    } catch (error) {
      if (isDebug) {
        console.error('Errore RSSBridge:', error.message);
      }
    }
    
    // Se tutti i tentativi falliscono
    return res.status(404).json({
      error: 'Impossibile recuperare il feed',
      message: 'Tutti i tentativi hanno fallito',
      url: feedUrl
    });
  } catch (error) {
    console.error('Errore generale:', error);
    res.status(500).json({ 
      error: 'Errore interno del server', 
      message: error.message,
      url: feedUrl
    });
  }
};