// api/huggingface.js - Endpoint proxy per Hugging Face Inference API
const fetch = require('node-fetch');

module.exports = async (req, res) => {
  // Abilita CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  // Gestisci le richieste OPTIONS (preflight)
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metodo non supportato' });
  }

  try {
    const { task, text, sourceLanguage, targetLanguage, options } = req.body;
    
    // Verifica i parametri richiesti
    if (!task || !text) {
      return res.status(400).json({ error: 'Parametri mancanti: task e text sono obbligatori' });
    }
    
    // Token di accesso Hugging Face (da impostare come variabile d'ambiente in Vercel)
    const HF_ACCESS_TOKEN = process.env.HUGGINGFACE_API_KEY;
    
    // Funzione per selezionare il modello appropriato in base al task e alle lingue
    const selectModel = (task, sourceLanguage, targetLanguage) => {
      if (task === 'translation') {
        // Gestione modelli di traduzione
        if (sourceLanguage === 'en' && targetLanguage === 'it') {
          return 'Helsinki-NLP/opus-mt-en-it'; // Inglese -> Italiano
        } else if (sourceLanguage === 'it' && targetLanguage === 'en') {
          return 'Helsinki-NLP/opus-mt-it-en'; // Italiano -> Inglese
        } else if (sourceLanguage && targetLanguage) {
          // Prova a vedere se esiste un modello specifico per la coppia di lingue
          return `Helsinki-NLP/opus-mt-${sourceLanguage}-${targetLanguage}`;
        }
        // Modello multilingual di fallback
        return 'facebook/mbart-large-50-many-to-many-mmt';
      } else if (task === 'summarization') {
        // Modelli per il riassunto
        if (sourceLanguage === 'it') {
          return 'Narrativa/it5-efficient-small-el32-news-summarization';
        } else {
          return 'facebook/bart-large-cnn';
        }
      } else if (task === 'text-generation') {
        // Modelli per generazione di testo
        return 'mistralai/Mistral-7B-Instruct-v0.2';
      } else if (task === 'language-detection') {
        // Modello per il rilevamento della lingua
        return 'papluca/xlm-roberta-base-language-detection';
      }
      
      // Modello di default
      return 'facebook/mbart-large-50-many-to-many-mmt';
    };
    
    // Seleziona il modello appropriato
    const modelId = options?.model || selectModel(task, sourceLanguage, targetLanguage);
    
    // Prepara l'URL per l'API di Hugging Face
    const apiUrl = `https://api-inference.huggingface.co/models/${modelId}`;
    
    // Prepara il payload in base al task
    let payload;
    switch (task) {
      case 'translation':
        if (modelId.includes('Helsinki-NLP')) {
          // Modelli Helsinki-NLP vogliono solo il testo
          payload = { inputs: text };
        } else if (modelId.includes('mbart')) {
          // mbart richiede source_language e target_language
          payload = {
            inputs: text,
            parameters: {
              source_language: sourceLanguage || 'en_XX',
              target_language: targetLanguage || 'it_IT'
            }
          };
        } else {
          payload = { inputs: text };
        }
        break;
        
      case 'summarization':
        payload = { 
          inputs: text,
          parameters: {
            max_length: options?.maxLength || 150,
            min_length: options?.minLength || 30,
            do_sample: options?.doSample !== undefined ? options.doSample : true
          }
        };
        break;
        
      case 'text-generation':
        payload = {
          inputs: text,
          parameters: {
            max_new_tokens: options?.maxTokens || 250,
            temperature: options?.temperature !== undefined ? options.temperature : 0.7,
            top_p: options?.topP !== undefined ? options.topP : 0.95,
            do_sample: options?.doSample !== undefined ? options.doSample : true
          }
        };
        break;
        
      case 'language-detection':
        payload = { inputs: text };
        break;
        
      default:
        payload = { inputs: text };
    }
    
    // Aggiungi eventuali parametri aggiuntivi
    if (options?.parameters) {
      payload.parameters = { ...payload.parameters, ...options.parameters };
    }
    
    // Prepara gli headers
    const headers = {
      'Content-Type': 'application/json'
    };
    
    // Aggiungi token di autenticazione se disponibile
    if (HF_ACCESS_TOKEN) {
      headers['Authorization'] = `Bearer ${HF_ACCESS_TOKEN}`;
    }
    
    // Funzione per gestire i retry in caso di errore "Model is loading"
    const fetchWithRetry = async (url, options, retries = 3, delay = 2000) => {
      try {
        const response = await fetch(url, options);
        
        if (response.status === 503 || response.status === 429) {
          const responseText = await response.text();
          
          // Se il modello sta caricando, attendiamo e riproviamo
          if (responseText.includes('Model is loading') && retries > 0) {
            console.log(`Modello in caricamento, riprovo tra ${delay/1000} secondi...`);
            
            // Attendiamo il tempo di delay prima di riprovare
            await new Promise(resolve => setTimeout(resolve, delay));
            
            // Ritentiamo con un ritardo esponenziale
            return fetchWithRetry(url, options, retries - 1, delay * 1.5);
          }
          
          throw new Error(`Errore API: ${response.status} - ${responseText}`);
        }
        
        return response;
      } catch (error) {
        if (retries > 0) {
          console.log(`Errore di rete, riprovo (${retries} tentativi rimasti): ${error.message}`);
          
          // Attendiamo il tempo di delay prima di riprovare
          await new Promise(resolve => setTimeout(resolve, delay));
          
          // Ritentiamo con un ritardo esponenziale
          return fetchWithRetry(url, options, retries - 1, delay * 1.5);
        }
        
        throw error;
      }
    };
    
    // Log per debug
    console.log(`Chiamata a HF: ${apiUrl} con modello: ${modelId}`);
    
    // Effettua la chiamata a Hugging Face con retry automatico
    const response = await fetchWithRetry(
      apiUrl, 
      {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(payload),
      },
      3, // Numero massimo di tentativi
      2000 // Ritardo iniziale in ms
    );
    
    // Gestione errori HTTP
    if (!response.ok) {
      console.error(`Errore HF: ${response.status} ${response.statusText}`);
      const errorText = await response.text();
      console.error(`Dettagli errore: ${errorText}`);
      return res.status(response.status).json({ 
        error: `Errore dall'API di Hugging Face: ${response.status}`,
        details: errorText
      });
    }
    
    // Elabora la risposta in base al content-type
    const contentType = response.headers.get('content-type') || '';
    let data;
    
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      const rawText = await response.text();
      try {
        // Tenta di parsare il testo come JSON
        data = JSON.parse(rawText);
      } catch (e) {
        // Fallback: considera il testo come puro testo
        data = { text: rawText };
      }
    }
    
    // Normalizza la risposta in base al task
    let result;
    switch(task) {
      case 'translation':
        // Modelli di traduzione Helsinki-NLP restituiscono un array con oggetti {translation_text}
        if (Array.isArray(data) && data[0] && data[0].translation_text) {
          result = { 
            translation: data[0].translation_text,
            model: modelId
          };
        } else if (data.translation_text) {
          result = { 
            translation: data.translation_text,
            model: modelId
          };
        } else {
          result = { 
            translation: data.text || JSON.stringify(data),
            model: modelId
          };
        }
        break;
        
      case 'summarization':
        // Modelli di summarization restituiscono un array con oggetti {summary_text}
        if (Array.isArray(data) && data[0] && data[0].summary_text) {
          result = { 
            summary: data[0].summary_text,
            model: modelId
          };
        } else if (data.summary_text) {
          result = { 
            summary: data.summary_text,
            model: modelId 
          };
        } else {
          result = { 
            summary: data.text || JSON.stringify(data),
            model: modelId
          };
        }
        break;
        
      case 'text-generation':
        // Modelli di generazione testo restituiscono un array con oggetti {generated_text}
        if (Array.isArray(data) && data[0] && data[0].generated_text) {
          result = { 
            generated_text: data[0].generated_text,
            model: modelId
          };
        } else if (data.generated_text) {
          result = { 
            generated_text: data.generated_text,
            model: modelId
          };
        } else {
          result = { 
            generated_text: data.text || JSON.stringify(data),
            model: modelId
          };
        }
        break;
        
      case 'language-detection':
        // Modelli di rilevamento lingua restituiscono array di scores
        if (Array.isArray(data) && data[0] && Array.isArray(data[0])) {
          // Trova la lingua con score più alto
          const scores = data[0];
          scores.sort((a, b) => b.score - a.score);
          result = { 
            detected_language: scores[0].label,
            score: scores[0].score,
            all_scores: scores,
            model: modelId
          };
        } else {
          result = { 
            detected_language: 'unknown',
            raw_response: data,
            model: modelId
          };
        }
        break;
        
      default:
        // Per altri task, restituisci la risposta non elaborata
        result = { ...data, model: modelId };
    }
    
    // Aggiungi informazioni sulla richiesta
    result.request = {
      task,
      model: modelId,
      timestamp: new Date().toISOString()
    };
    
    return res.status(200).json(result);
  } catch (error) {
    console.error('Errore generale:', error);
    return res.status(500).json({ 
      error: 'Errore interno del server', 
      message: error.message 
    });
  }
};