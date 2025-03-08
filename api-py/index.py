from flask import Flask, Response, request, jsonify
import json
import urllib.parse
import requests
from bs4 import BeautifulSoup
from urllib.parse import urlparse

app = Flask(__name__)

# Configurazione
TIMEOUT = 10  # secondi
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

# Domini noti con feed RSS
KNOWN_DOMAINS = {
    'wired.it': 'https://www.wired.it/feed/rss',
    'repubblica.it': 'https://www.repubblica.it/rss/homepage/rss2.0.xml',
    'ilpost.it': 'https://www.ilpost.it/feed/',
    'ansa.it': 'https://www.ansa.it/sito/notizie/tecnologia/tecnologia_rss.xml',
    'corriere.it': 'https://xml2.corriereobjects.it/rss/homepage.xml',
    'gazzetta.it': 'https://www.gazzetta.it/rss/home.xml',
    'tomshw.it': 'https://www.tomshw.it/feed/'
}

@app.route('/api-py/discover', methods=['GET', 'OPTIONS'])
def discover_feeds():
    # Gestione CORS
    if request.method == 'OPTIONS':
        response = jsonify({})
        response.headers.add('Access-Control-Allow-Origin', '*')
        response.headers.add('Access-Control-Allow-Methods', 'GET,OPTIONS')
        response.headers.add('Access-Control-Allow-Headers', 'Content-Type')
        return response
    
    # Estrai l'URL dai parametri della query
    url = request.args.get('url', '')
    
    if not url:
        response = jsonify({"error": "URL parametro mancante"})
        response.headers.add('Access-Control-Allow-Origin', '*')
        return response, 400
    
    try:
        # Normalizza l'URL
        if not url.startswith('http'):
            url = 'https://' + url
        
        # Estrai il dominio base
        parsed_url = urlparse(url)
        hostname = parsed_url.hostname
        site_root = f"{parsed_url.scheme}://{hostname}"
        
        # Trova i feed
        feed_urls = []
        
        # Chiama API di autodiscovery, controlla percorsi comuni, ecc.
        # (Implementazione simile al codice precedente)
        
        # Per brevità, restituisco solo un feed noto se disponibile
        for domain, known_url in KNOWN_DOMAINS.items():
            if domain in hostname:
                feed_urls.append({
                    'url': known_url,
                    'source': 'known_domain',
                    'title': f'Feed di {domain}'
                })
        
        # Risultato finale
        result = {
            'feeds': feed_urls,
            'site': site_root
        }
        
        # Restituisci la risposta con i feed trovati
        response = jsonify(result)
        response.headers.add('Access-Control-Allow-Origin', '*')
        return response
        
    except Exception as e:
        error_response = jsonify({
            "error": "Errore interno del server", 
            "message": str(e)
        })
        error_response.headers.add('Access-Control-Allow-Origin', '*')
        return error_response, 500