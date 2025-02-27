// api/image-proxy.js
const fetch = require('node-fetch');
const { Agent } = require('https');
// Nota: È necessario installare sharp con: npm install sharp
// Per Vercel, aggiungerlo al package.json

// Agente HTTPS che salta la verifica SSL per siti problematici
const httpsAgent = new Agent({
  rejectUnauthorized: false
});

// Cache in-memory semplice (in produzione usare Redis o altra soluzione)
const imageCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 ore in millisecondi

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

  // Controlla che ci sia l'URL dell'immagine
  const { url, width, height, quality, format } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'URL parametro mancante' });
  }

  const imageUrl = decodeURIComponent(url);
  const cacheKey = `${imageUrl}-${width || 'orig'}-${height || 'orig'}-${quality || '80'}-${format || 'orig'}`;
  
  try {
    // Controlla la cache
    const cachedImage = imageCache.get(cacheKey);
    if (cachedImage && (Date.now() - cachedImage.timestamp) < CACHE_TTL) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('Content-Type', cachedImage.contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.status(200).send(cachedImage.data);
    }
    
    // Determina il dominio per header personalizzati
    const urlObj = new URL(imageUrl);
    const domain = urlObj.hostname;
    
    // Configura header specifici per dominio
    let headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
      'Referer': `${urlObj.protocol}//${domain}`,
      'Origin': `${urlObj.protocol}//${domain}`
    };
    
    // Aggiungi header specifici per wired.it
    if (domain.includes('wired.it')) {
      headers['Cookie'] = '';
      headers['Sec-Fetch-Dest'] = 'image';
      headers['Sec-Fetch-Mode'] = 'no-cors';
      headers['Sec-Fetch-Site'] = 'same-origin';
    }
    
    // Usa il referer del sito originale per siti di notizie che controllano il referer
    if (domain.includes('nytimes.com') || domain.includes('repubblica.it')) {
      headers['Referer'] = `https://${domain}/`;
    }

    const response = await fetch(imageUrl, {
      headers,
      agent: httpsAgent,
      timeout: 10000 // 10 secondi
    });

    if (!response.ok) {
      console.log(`Errore recupero immagine: ${response.status} ${response.statusText}`);
      return res.status(response.status).json({
        error: `Impossibile recuperare l'immagine: ${response.statusText}`,
        status: response.status
      });
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const imageBuffer = await response.buffer();
    
    // Processa l'immagine con sharp se richiesto
    let processedImage = imageBuffer;
    let finalContentType = contentType;
    
    if (width || height || format || quality) {
      try {
        let sharpInstance = sharp(imageBuffer);
        
        // Ridimensiona se width o height sono specificati
        if (width || height) {
          sharpInstance = sharpInstance.resize({
            width: width ? parseInt(width) : null,
            height: height ? parseInt(height) : null,
            fit: 'cover',
            position: 'center'
          });
        }
        
        // Converti il formato se richiesto
        if (format) {
          switch(format.toLowerCase()) {
            case 'webp':
              sharpInstance = sharpInstance.webp({ quality: parseInt(quality || '80') });
              finalContentType = 'image/webp';
              break;
            case 'jpeg':
            case 'jpg':
              sharpInstance = sharpInstance.jpeg({ quality: parseInt(quality || '80') });
              finalContentType = 'image/jpeg';
              break;
            case 'png':
              sharpInstance = sharpInstance.png({ quality: parseInt(quality || '80') });
              finalContentType = 'image/png';
              break;
            case 'avif':
              sharpInstance = sharpInstance.avif({ quality: parseInt(quality || '80') });
              finalContentType = 'image/avif';
              break;
          }
        } else if (quality) {
          // Se il formato non è specificato ma la qualità sì
          if (contentType.includes('jpeg') || contentType.includes('jpg')) {
            sharpInstance = sharpInstance.jpeg({ quality: parseInt(quality) });
          } else if (contentType.includes('png')) {
            sharpInstance = sharpInstance.png({ quality: parseInt(quality) });
          } else if (contentType.includes('webp')) {
            sharpInstance = sharpInstance.webp({ quality: parseInt(quality) });
          }
        }
        
        processedImage = await sharpInstance.toBuffer();
      } catch (err) {
        console.error('Errore nel processing dell\'immagine:', err);
        // Fallback all'immagine originale in caso di errore
        processedImage = imageBuffer;
        finalContentType = contentType;
      }
    }
    
    // Salva in cache
    imageCache.set(cacheKey, {
      data: processedImage,
      contentType: finalContentType,
      timestamp: Date.now()
    });
    
    // Pulisci la cache se diventa troppo grande
    if (imageCache.size > 1000) {
      const oldestKeys = [...imageCache.entries()]
        .sort((a, b) => a[1].timestamp - b[1].timestamp)
        .slice(0, 300)
        .map(entry => entry[0]);
      
      oldestKeys.forEach(key => imageCache.delete(key));
    }
    
    // Imposta gli header di risposta
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Content-Type', finalContentType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
    
    return res.status(200).send(processedImage);
  } catch (error) {
    console.error('Errore nel proxy delle immagini:', error);
    res.status(500).json({ error: 'Errore interno del server', message: error.message });
  }
};