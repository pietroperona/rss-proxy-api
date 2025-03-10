from fastapi import FastAPI, Query, HTTPException
from typing import List, Optional
import httpx
import feedparser
from bs4 import BeautifulSoup
import re
from urllib.parse import urlparse
from datetime import datetime
from mangum import Mangum
from cachetools import TTLCache
import time

# Crea l'app FastAPI
app = FastAPI()

# Configurazione
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
TIMEOUT = 15.0  # secondi
feed_cache = TTLCache(maxsize=500, ttl=15*60)  # 15 minuti di cache

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

@app.get("/api/discover")
async def discover_feeds(url: str = Query(..., description="URL del sito di cui trovare i feed RSS")):
    """Trova feed RSS/Atom per un dato URL di sito web"""
    # Normalizza l'URL
    normalized_url = url.strip()
    if not normalized_url.startswith('http'):
        normalized_url = 'https://' + normalized_url
    
    # Estrai il dominio base
    parsed_url = urlparse(normalized_url)
    hostname = parsed_url.hostname
    site_root = f"{parsed_url.scheme}://{hostname}"
    
    try:
        # Trova i feed
        all_feeds = []
        
        # 1. Feed da domini noti
        known_domain_feeds = find_feeds_via_known_domains(hostname)
        all_feeds.extend(known_domain_feeds)
        
        # 2. Se nessun feed trovato da domini noti, prova autodiscovery
        if len(all_feeds) == 0:
            # L'autodiscovery richiederebbe una chiamata HTTP reale
            # Ma qui usiamo solo i domini noti per semplicità
            pass
        
        return {"feeds": all_feeds, "site": site_root}
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Errore nella ricerca dei feed: {str(e)}")

@app.get("/api/rss")
async def get_rss_feed(
    url: str = Query(..., description="URL del feed RSS/Atom"),
    debug: bool = Query(False, description="Modalità debug"),
    bypassCache: bool = Query(False, description="Ignora la cache")
):
    """Scarica, normalizza e restituisce un feed RSS/Atom"""
    # Controlla la cache, a meno che non sia esplicitamente bypassata
    if not bypassCache and url in feed_cache:
        return feed_cache[url]
    
    # Simulazione di risposta per evitare chiamate HTTP
    if any(known_url in url for known_url in KNOWN_DOMAINS.values()):
        # Crea una risposta simulata
        response = {
            "feedType": "rss",
            "title": "Feed simulato",
            "description": "Feed simulato per esempio",
            "link": url,
            "items": [
                {
                    "id": "1",
                    "title": "Articolo di esempio 1",
                    "link": "https://example.com/article1",
                    "content": "Contenuto dell'articolo di esempio 1",
                    "description": "Descrizione dell'articolo 1",
                    "imageUrl": "https://example.com/image1.jpg",
                    "pubDate": datetime.now().isoformat(),
                    "categories": ["esempio", "simulazione"],
                    "author": "Test Author",
                    "sourceName": "Example Feed"
                },
                {
                    "id": "2",
                    "title": "Articolo di esempio 2",
                    "link": "https://example.com/article2",
                    "content": "Contenuto dell'articolo di esempio 2",
                    "description": "Descrizione dell'articolo 2",
                    "imageUrl": "https://example.com/image2.jpg",
                    "pubDate": datetime.now().isoformat(),
                    "categories": ["esempio", "test"],
                    "author": "Test Author",
                    "sourceName": "Example Feed"
                }
            ]
        }
        
        # Salva in cache
        feed_cache[url] = response
        
        return response
    else:
        # Feed non riconosciuto
        raise HTTPException(status_code=404, detail="Feed non trovato o non supportato")

@app.get("/api/image-proxy")
async def proxy_image(
    url: str = Query(..., description="URL dell'immagine da proxare"),
    width: Optional[int] = Query(None, description="Larghezza desiderata"),
    height: Optional[int] = Query(None, description="Altezza desiderata"),
    quality: int = Query(80, description="Qualità dell'immagine (1-100)")
):
    """Simula un proxy per immagini"""
    if not url:
        raise HTTPException(status_code=400, detail="URL parametro mancante")
    
    # In un ambiente reale, qui si scaricherebbe e processerebbe l'immagine
    # In questo caso, si restituisce solo un messaggio informativo
    return {
        "message": "Proxy immagine simulato",
        "original_url": url,
        "parameters": {
            "width": width,
            "height": height,
            "quality": quality
        }
    }

def find_feeds_via_known_domains(hostname):
    """Trova feed basati su mappature di domini noti"""
    feeds = []
    
    for domain, feed_url in KNOWN_DOMAINS.items():
        if domain in hostname:
            feeds.append({
                "url": feed_url,
                "source": "known_domain",
                "title": f'Feed di {domain}'
            })
    
    return feeds

# Handler per Vercel
handler = Mangum(app)