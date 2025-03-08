// api/rss.js - Versione migliorata con normalizzazione dei feed
const fetch = require('node-fetch');
const { Agent } = require('https');
const { parseString } = require('xml2js');
const { promisify } = require('util');

// Converti parseString in una versione Promise
const parseXmlAsync = promisify(parseString);

// Agente HTTP personalizzato per saltare la verifica SSL in caso di problemi
const httpsAgent = new Agent({
  rejectUnauthorized: false
});

// Cache per ridurre le richieste ripetute (molto semplice, in produzione usare Redis o altro)
const cache = new Map();
const CACHE_TTL = 15 * 60 * 1000; // 15 minuti in millisecondi

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
  const { url, debug, bypassCache } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'URL parametro mancante' });
  }

  const feedUrl = decodeURIComponent(url);
  const isDebug = debug === 'true';
  const shouldBypassCache = bypassCache === 'true';
  
  try {
    // Controlla la cache, a meno che non sia esplicitamente bypassata
    if (!shouldBypassCache) {
      const cacheKey = feedUrl;
      const cachedData = cache.get(cacheKey);
      
      if (cachedData && (Date.now() - cachedData.timestamp) < CACHE_TTL) {
        if (isDebug) console.log('Servendo dalla cache');
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).json(cachedData.data);
      }
    }
    
    // Log per debugging
    if (isDebug) {
      console.log(`Processing request for: ${feedUrl}`);
    }
    
    // Determina gli header da usare in base al dominio
    let headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/xml, application/rss+xml, application/atom+xml, text/html, */*',
      'Cache-Control': 'no-cache'
    };
    
    // Header specializzati per Wired
    if (feedUrl.includes('wired.it')) {
      headers['Accept'] = 'application/rss+xml, application/xml, */*';
      if (isDebug) {
        console.log('Usando header specializzati per Wired');
      }
    }
    
    // Header specializzati per The Information
    if (feedUrl.includes('theinformation.com')) {
      headers['Accept'] = 'application/atom+xml, application/xml, */*';
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
        agent: httpsAgent,
        timeout: 10000 // 10 secondi
      });
      
      if (response.ok) {
        const contentType = response.headers.get('content-type') || 'application/xml';
        const isAtom = contentType.includes('atom') || feedUrl.includes('atom');
        const rawXml = await response.text();
        
        if (isDebug) {
          console.log(`Feed recuperato con content-type: ${contentType}`);
          console.log(`Primi 200 caratteri: ${rawXml.substring(0, 200)}`);
        }
        
        // Normalizza il feed (indipendentemente che sia RSS o Atom)
        const normalizedFeed = await normalizeFeed(rawXml, feedUrl, isDebug);
        
        // Salva in cache
        cache.set(feedUrl, {
          data: normalizedFeed,
          timestamp: Date.now()
        });
        
        // Imposta gli header appropriati
        res.setHeader('X-Cache', 'MISS');
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'public, max-age=300');
        
        return res.status(200).json(normalizedFeed);
      } else {
        if (isDebug) {
          console.log(`Recupero diretto fallito: ${response.status} ${response.statusText}`);
        }
        throw new Error(`Status code: ${response.status}`);
      }
    } catch (error) {
      if (isDebug) {
        console.error('Errore recupero diretto:', error.message);
      }
      
      // Se il tentativo diretto fallisce, prova con RSSBridge come fallback
      return tryRssBridgeFallback(feedUrl, res, isDebug);
    }
  } catch (error) {
    console.error('Errore generale:', error);
    res.status(500).json({ 
      error: 'Errore interno del server', 
      message: error.message,
      url: feedUrl
    });
  }
};

// Funzione per normalizzare sia i feed RSS che Atom in un formato uniforme
async function normalizeFeed(xmlData, feedUrl, isDebug) {
  try {
    // Determina se è un feed Atom o RSS
    const isAtom = xmlData.includes('<feed') && 
                   (xmlData.includes('xmlns="http://www.w3.org/2005/Atom"') || 
                    xmlData.includes('xmlns="http://purl.org/atom/'));
    
    if (isDebug) {
      console.log(`Rilevato feed di tipo: ${isAtom ? 'Atom' : 'RSS'}`);
    }
    
    // Passa i dati XML a xml2js per parsing
    const options = {
      explicitArray: false,
      trim: true,
      explicitRoot: false,
      mergeAttrs: true,
    };
    
    const parsedData = await parseXmlAsync(xmlData, options);
    
    // Normalizziamo in base al tipo di feed
    if (isAtom) {
      return normalizeAtomFeed(parsedData, feedUrl, isDebug);
    } else {
      return normalizeRssFeed(parsedData, feedUrl, isDebug);
    }
  } catch (error) {
    console.error('Errore nella normalizzazione del feed:', error);
    throw error;
  }
}

// Funzione per normalizzare gli URL delle immagini
function normalizeImageUrl(url) {
  if (!url) return '';
  
  // Rimuovi spazi e caratteri non validi
  url = url.trim();
  
  // Gestisci URL che iniziano con //
  if (url.startsWith('//')) {
    return 'https:' + url;
  }
  
  // Verifica che l'URL abbia un protocollo
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return 'https://' + url;
  }
  
  return url;
}

// Normalizza feed Atom
function normalizeAtomFeed(parsedData, feedUrl, isDebug) {
  try {
    const feed = parsedData.feed;
    
    if (!feed) {
      throw new Error('Struttura del feed Atom non valida');
    }
    
    const title = feed.title && typeof feed.title === 'object' ? feed.title._ : feed.title || 'Feed senza titolo';
    const description = feed.subtitle || feed.tagline || '';
    
    // Assicurati che entries sia sempre un array
    const entries = feed.entry ? (Array.isArray(feed.entry) ? feed.entry : [feed.entry]) : [];
    
    const items = entries.map(entry => {
      // Gestione del link dell'articolo
      let articleLink = '';
      
      if (entry.link) {
        if (Array.isArray(entry.link)) {
          // Cerca un link con rel="alternate" o il primo link disponibile
          const alternateLink = entry.link.find(link => link.rel === 'alternate');
          articleLink = alternateLink ? alternateLink.href : (entry.link[0].href || '');
        } else {
          articleLink = entry.link.href || '';
        }
      }
      
      // Se non c'è un link specifico, usa l'id se sembra un URL
      if (!articleLink && entry.id && entry.id.startsWith('http')) {
        articleLink = entry.id;
      }
      
      // Gestione delle immagini
      let imageUrl = findImageInAtomEntry(entry);
      
      // Se non riesce a trovare un'immagine, cerca di estrarla dal contenuto
      if (!imageUrl && entry.content) {
        const content = typeof entry.content === 'object' ? entry.content._ : entry.content;
        if (content) {
          const imgMatch = /<img[^>]+src="([^"]+)"/.exec(content);
          if (imgMatch && imgMatch[1]) {
            imageUrl = imgMatch[1];
          }
        }
      }
      
      // Normalizza l'URL dell'immagine
      imageUrl = normalizeImageUrl(imageUrl);
      
      // Gestione del contenuto e della descrizione
      let content = '';
      let description = '';
      
      if (entry.content) {
        content = typeof entry.content === 'object' ? entry.content._ : entry.content;
      }
      
      if (entry.summary) {
        description = typeof entry.summary === 'object' ? entry.summary._ : entry.summary;
      } else if (content) {
        // Usa un estratto del contenuto come descrizione
        description = content.replace(/<[^>]+>/g, ' ').substring(0, 200) + '...';
      }
      
      // Gestione delle categorie
      let categories = [];
      
      if (entry.category) {
        if (Array.isArray(entry.category)) {
          categories = entry.category.map(cat => 
            typeof cat === 'object' ? (cat.term || cat.label || '') : cat
          );
        } else {
          const cat = typeof entry.category === 'object' ? 
            (entry.category.term || entry.category.label || '') : entry.category;
          categories = [cat];
        }
      }
      
      // Gestione della data
      let pubDate = entry.published || entry.updated || entry.issued || new Date().toISOString();
      
      return {
        id: entry.id || articleLink,
        title: typeof entry.title === 'object' ? entry.title._ : entry.title,
        link: articleLink,
        content: content,
        description: description,
        imageUrl: imageUrl,
        pubDate: pubDate,
        categories: categories,
        author: entry.author ? (entry.author.name || '') : '',
        sourceName: title
      };
    });
    
    return {
      feedType: 'atom',
      title: title,
      description: description,
      link: feedUrl,
      items: items
    };
  } catch (error) {
    console.error('Errore nel normalizzare il feed Atom:', error);
    throw error;
  }
}

// Normalizza feed RSS
function normalizeRssFeed(parsedData, feedUrl, isDebug) {
  try {
    const channel = parsedData.rss ? parsedData.rss.channel : parsedData.channel;
    
    if (!channel) {
      throw new Error('Struttura del feed RSS non valida');
    }
    
    const title = channel.title || 'Feed senza titolo';
    const description = channel.description || '';
    
    // Assicurati che items sia sempre un array
    const rawItems = channel.item ? (Array.isArray(channel.item) ? channel.item : [channel.item]) : [];
    
    const items = rawItems.map(item => {
      // Gestione delle immagini
      let imageUrl = findImageInRssItem(item);
      
      // Se non trova immagini, prova a estrarla dalla descrizione
      if (!imageUrl && item.description) {
        const imgMatch = /<img[^>]+src="([^"]+)"/.exec(item.description);
        if (imgMatch && imgMatch[1]) {
          imageUrl = imgMatch[1];
        }
      }
      
      // Normalizza l'URL dell'immagine
      imageUrl = normalizeImageUrl(imageUrl);
      
      // Gestione delle categorie
      let categories = [];
      
      if (item.category) {
        if (Array.isArray(item.category)) {
          categories = item.category.map(cat => 
            typeof cat === 'object' ? (cat._ || '') : cat
          );
        } else {
          categories = [typeof item.category === 'object' ? (item.category._ || '') : item.category];
        }
      }
      
      return {
        id: item.guid ? (typeof item.guid === 'object' ? item.guid._ : item.guid) : item.link,
        title: item.title,
        link: item.link,
        content: item['content:encoded'] || item.description || '',
        description: item.description || '',
        imageUrl: imageUrl,
        pubDate: item.pubDate || item.date || new Date().toISOString(),
        categories: categories,
        author: item.author || item['dc:creator'] || '',
        sourceName: title
      };
    });
    
    return {
      feedType: 'rss',
      title: title,
      description: description,
      link: channel.link || feedUrl,
      items: items
    };
  } catch (error) {
    console.error('Errore nel normalizzare il feed RSS:', error);
    throw error;
  }
}

// Trova immagini in un item RSS
function findImageInRssItem(item) {
  // 1. Controlla enclosure
  if (item.enclosure) {
    if (Array.isArray(item.enclosure)) {
      const imageEnclosure = item.enclosure.find(enc => 
        enc.type && enc.type.startsWith('image/') && enc.url
      );
      if (imageEnclosure) return imageEnclosure.url;
    } else if (item.enclosure.url && (!item.enclosure.type || item.enclosure.type.startsWith('image/'))) {
      return item.enclosure.url;
    }
  }
  
  // 2. Controlla media:content
  if (item['media:content']) {
    if (Array.isArray(item['media:content'])) {
      const mediaContent = item['media:content'].find(media => 
        (!media.medium || media.medium === 'image') && media.url
      );
      if (mediaContent) return mediaContent.url;
    } else if (item['media:content'].url) {
      return item['media:content'].url;
    }
  }
  
  // 3. Controlla media:thumbnail
  if (item['media:thumbnail']) {
    if (Array.isArray(item['media:thumbnail'])) {
      if (item['media:thumbnail'][0].url) return item['media:thumbnail'][0].url;
    } else if (item['media:thumbnail'].url) {
      return item['media:thumbnail'].url;
    }
  }
  
  // 4. Controlla image
  if (item.image) {
    if (typeof item.image === 'object' && item.image.url) {
      return item.image.url;
    } else if (typeof item.image === 'string') {
      return item.image;
    }
  }
  
  return '';
}

// Trova immagini in un entry Atom
function findImageInAtomEntry(entry) {
  // 1. Controlla i link con rel=enclosure o rel=image
  if (entry.link) {
    if (Array.isArray(entry.link)) {
      const imageLink = entry.link.find(link => 
        (link.rel === 'enclosure' || link.rel === 'image') && 
        (link.type && link.type.startsWith('image/') || !link.type) &&
        link.href
      );
      if (imageLink) return imageLink.href;
    } else if (entry.link.rel && 
               (entry.link.rel === 'enclosure' || entry.link.rel === 'image') && 
               entry.link.href) {
      return entry.link.href;
    }
  }
  
  // 2. Controlla campi specifici di Atom
  if (entry.icon) return entry.icon;
  if (entry.logo) return entry.logo;
  
  // 3. Prova a trovare immagine dai namespaces media
  if (entry['media:thumbnail']) {
    if (typeof entry['media:thumbnail'] === 'object' && entry['media:thumbnail'].url) {
      return entry['media:thumbnail'].url;
    }
  }
  
  if (entry['media:content']) {
    if (Array.isArray(entry['media:content'])) {
      const mediaContent = entry['media:content'].find(media => 
        (!media.medium || media.medium === 'image') && media.url
      );
      if (mediaContent) return mediaContent.url;
    } else if (typeof entry['media:content'] === 'object' && entry['media:content'].url) {
      return entry['media:content'].url;
    }
  }
  
  return '';
}

// Tentativo di fallback usando RSSBridge
async function tryRssBridgeFallback(feedUrl, res, isDebug) {
  try {
    if (isDebug) {
      console.log('Tentativo con RSSBridge');
    }
    
    const hostname = new URL(feedUrl).hostname;
    
    let bridgeUrl = `https://rssbridge.org/api/?action=display&bridge=FeedExtractor&url=${encodeURIComponent(feedUrl)}&format=Json`;
    
    // Configura URL specifici per domini popolari
    if (hostname.includes('repubblica.it')) {
      bridgeUrl = `https://rssbridge.org/api/?action=display&bridge=Repubblica&url=${encodeURIComponent(feedUrl)}&format=Json`;
    } else if (hostname.includes('ansa.it')) {
      bridgeUrl = `https://rssbridge.org/api/?action=display&bridge=Ansa&url=${encodeURIComponent(feedUrl)}&format=Json`;
    } else if (hostname.includes('corriere.it')) {
      bridgeUrl = `https://rssbridge.org/api/?action=display&bridge=Corriere&url=${encodeURIComponent(feedUrl)}&format=Json`;
    }
    
    if (isDebug) {
      console.log(`URL RSSBridge: ${bridgeUrl}`);
    }
    
    const response = await fetch(bridgeUrl, {
      agent: httpsAgent,
      timeout: 15000
    });
    
    if (response.ok) {
      const data = await response.json();
      
      if (isDebug) {
        console.log('RSSBridge success');
      }
      
      // Normalizza la risposta RSSBridge
      const items = data.items.map(item => {
        // Estrai e normalizza l'URL dell'immagine dalle enclosures
        let imageUrl = '';
        if (item.enclosures && item.enclosures.length > 0) {
          imageUrl = normalizeImageUrl(item.enclosures[0]);
        }
        
        return {
          id: item.uid || item.uri,
          title: item.title,
          link: item.uri,
          content: item.content || '',
          description: item.content ? item.content.substring(0, 200) + '...' : '',
          imageUrl: imageUrl,
          pubDate: item.timestamp ? new Date(item.timestamp * 1000).toISOString() : new Date().toISOString(),
          categories: item.categories || [],
          author: item.author || '',
          sourceName: data.title || new URL(feedUrl).hostname.replace('www.', '')
        };
      });
      
      const normalizedData = {
        feedType: 'rssbridge',
        title: data.title || 'Feed da RSSBridge',
        description: data.description || '',
        link: feedUrl,
        items: items
      };
      
      // Salva in cache
      cache.set(feedUrl, {
        data: normalizedData,
        timestamp: Date.now()
      });
      
      // Imposta gli header
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Source', 'RSSBridge');
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=300');
      
      return res.status(200).json(normalizedData);
    } else {
      if (isDebug) {
        console.log(`RSSBridge fallito: ${response.status}`);
      }
      throw new Error(`RSSBridge fallito con status ${response.status}`);
    }
  } catch (error) {
    if (isDebug) {
      console.error('Errore RSSBridge:', error.message);
    }
    
    // Se anche RSSBridge fallisce, restituisci un errore
    return res.status(404).json({
      error: 'Impossibile recuperare il feed',
      message: 'Tutti i tentativi hanno fallito',
      url: feedUrl
    });
  }
}