// api/rss.js - Versione aggiornata con RSS2JSON
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
    
    // Usa RSS2JSON - un servizio gratuito che converte RSS in JSON
    // Il servizio gestisce i problemi di CORS e accesso ai feed
    const rss2jsonUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feedUrl)}`;
    
    console.log(`Fetching using RSS2JSON: ${rss2jsonUrl}`);
    
    const response = await fetch(rss2jsonUrl);
    
    if (!response.ok) {
      return res.status(response.status).json({ 
        error: `Errore con RSS2JSON: ${response.statusText}`,
        status: response.status
      });
    }
    
    // Ottieni i dati JSON
    const data = await response.json();
    
    // Verifica status
    if (data.status !== 'ok') {
      return res.status(400).json({
        error: 'Errore nel recupero del feed',
        message: data.message || 'RSS2JSON non è riuscito a elaborare il feed'
      });
    }
    
    // Restituisci il feed convertito in JSON
    res.status(200).json(data);
  } catch (error) {
    console.error('Errore nel proxy RSS:', error);
    res.status(500).json({ 
      error: 'Errore interno del server', 
      message: error.message 
    });
  }
};