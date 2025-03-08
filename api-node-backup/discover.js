// api/discover.js - Endpoint per scoprire automaticamente i feed RSS
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

  // Controlla che ci sia l'URL base
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'URL parametro mancante' });
  }

  try {
    // Normalizza l'URL per assicurarsi che sia completo
    let baseUrl = decodeURIComponent(url);
    if (!baseUrl.startsWith('http')) {
      baseUrl = 'https://' + baseUrl;
    }
    
    // Rimuovi eventuali path e mantieni solo il dominio base
    const urlObj = new URL(baseUrl);
    const hostname = urlObj.hostname;
    const siteRoot = `${urlObj.protocol}//${hostname}`;
    
    console.log(`Cercando feed RSS per: ${siteRoot}`);
    
    // Luoghi comuni dove cercare i feed
    const possiblePaths = [
      '/',                // Pagina principale
      '/feed',            // Percorso comune
      '/rss',             // Percorso comune
      '/feed/rss',        // Wired, WordPress
      '/rss/index.xml',   // The Verge
      '/atom',            // Atom feed
      '/rss.xml',         // Percorso comune
      '/feed.xml',        // Percorso comune
      '/feeds/posts/default', // Blogger
      '/rssfeeds/',       // Alcuni siti di news
      '/index.xml'        // Hugo e altri generatori statici
    ];
    
    const feedUrls = [];
    const commonFeedIdentifiers = [
      'application/rss+xml',
      'application/atom+xml',
      'application/feed+json',
      'application/rss',
      'application/xml',
      'text/xml'
    ];

    // Prima controlla la home page per i link di autodiscovery
    try {
      console.log(`Controllando l'autodiscovery sulla home page: ${siteRoot}`);
      
      const response = await fetch(siteRoot, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html'
        },
        timeout: 10000
      });
      
      if (response.ok) {
        const html = await response.text();
        
        // Cerca i tag link con rel="alternate" che puntano a feed
        const linkRegex = /<link[^>]*rel=["'](?:alternate|feed)["'][^>]*>/gi;
        const links = html.match(linkRegex) || [];
        
        for (const link of links) {
          // Controlla se è un tipo di feed supportato
          if (commonFeedIdentifiers.some(type => link.includes(`type=["']${type}["']`))) {
            // Estrai l'URL dal link
            const hrefMatch = link.match(/href=["']([^"']+)["']/i);
            if (hrefMatch && hrefMatch[1]) {
              let feedUrl = hrefMatch[1];
              
              // Risolvi URL relativi
              if (feedUrl.startsWith('/')) {
                feedUrl = siteRoot + feedUrl;
              } else if (!feedUrl.startsWith('http')) {
                feedUrl = siteRoot + '/' + feedUrl;
              }
              
              feedUrls.push({
                url: feedUrl,
                source: 'autodiscovery'
              });
            }
          }
        }
        
        console.log(`Trovati ${feedUrls.length} feed tramite autodiscovery`);
      }
    } catch (error) {
      console.log(`Errore durante l'autodiscovery: ${error.message}`);
    }
    
    // Se l'autodiscovery fallisce, prova i percorsi comuni
    if (feedUrls.length === 0) {
      console.log('Autodiscovery fallito. Tentativo con percorsi comuni...');
      
      for (const path of possiblePaths) {
        const testUrl = siteRoot + path;
        try {
          console.log(`Testando: ${testUrl}`);
          
          const response = await fetch(testUrl, {
            method: 'HEAD',  // Usa HEAD per verificare solo l'esistenza
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 5000
          });
          
          if (response.ok) {
            const contentType = response.headers.get('content-type') || '';
            if (
              contentType.includes('xml') || 
              contentType.includes('rss') || 
              contentType.includes('atom')
            ) {
              feedUrls.push({
                url: testUrl,
                source: 'common_path'
              });
            }
          }
        } catch (error) {
          // Ignora gli errori per i singoli tentativi
        }
      }
    }
    
    // Se ancora non abbiamo trovato nulla, prova con alcuni feed noti per dominio specifico
    if (feedUrls.length === 0) {
      console.log('Tentativo con domini noti...');
      
      // Mappatura di domini noti
      const knownDomains = {
        'wired.it': 'https://www.wired.it/feed/rss',
        'repubblica.it': 'https://www.repubblica.it/rss/homepage/rss2.0.xml',
        'ilpost.it': 'https://www.ilpost.it/feed/',
        'ansa.it': 'https://www.ansa.it/sito/notizie/tecnologia/tecnologia_rss.xml',
        'corriere.it': 'https://xml2.corriereobjects.it/rss/homepage.xml',
        'gazzetta.it': 'https://www.gazzetta.it/rss/home.xml',
        'tomshw.it': 'https://www.tomshw.it/feed/'
      };
      
      // Controlla se il dominio è noto
      for (const [domain, feedUrl] of Object.entries(knownDomains)) {
        if (hostname.includes(domain)) {
          feedUrls.push({
            url: feedUrl,
            source: 'known_domain'
          });
        }
      }
    }
    
    // Ultimo tentativo: usa un servizio di discovery esterno
    if (feedUrls.length === 0) {
      console.log('Tentativo con servizio esterno...');
      
      try {
        const feedFinderUrl = `https://feed-finder.netdesperatedev.com/api/feeds?url=${encodeURIComponent(siteRoot)}`;
        const response = await fetch(feedFinderUrl);
        
        if (response.ok) {
          const data = await response.json();
          if (data && data.length > 0) {
            for (const feed of data) {
              feedUrls.push({
                url: feed.url,
                source: 'external_service'
              });
            }
          }
        }
      } catch (error) {
        console.log(`Errore con servizio esterno: ${error.message}`);
      }
    }
    
    // Rispondi con i feed trovati
    if (feedUrls.length > 0) {
      console.log(`Trovati ${feedUrls.length} feed RSS`);
      return res.status(200).json({ 
        feeds: feedUrls,
        site: siteRoot
      });
    } else {
      return res.status(404).json({ 
        error: 'Nessun feed RSS trovato',
        site: siteRoot 
      });
    }
  } catch (error) {
    console.error('Errore generale:', error);
    res.status(500).json({ 
      error: 'Errore interno del server', 
      message: error.message 
    });
  }
};