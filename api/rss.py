from .base import create_app
import httpx
import feedparser
import asyncio
import re
from bs4 import BeautifulSoup
from fastapi import Query, HTTPException, Request
from pydantic import BaseModel, Field, HttpUrl
from typing import List, Optional, Dict, Any, Union
from urllib.parse import urlparse
from datetime import datetime
from cachetools import TTLCache
import time
import json

# Creazione dell'app FastAPI
app = create_app()

# Configurazione
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
TIMEOUT = 15.0  # secondi

# Cache con TTL (Time To Live)
# Memorizza fino a 500 risultati per 15 minuti
feed_cache = TTLCache(maxsize=500, ttl=15*60)

# Modelli di dati Pydantic
class FeedItem(BaseModel):
    """Modello per rappresentare un singolo articolo nel feed"""
    id: str
    title: str
    link: str
    content: str = ""
    description: str = ""
    imageUrl: str = ""
    pubDate: str
    categories: List[str] = []
    author: str = ""
    sourceName: str = ""

class FeedResponse(BaseModel):
    """Modello di risposta per l'endpoint RSS"""
    feedType: str
    title: str
    description: str = ""
    link: str
    items: List[FeedItem]

async def fetch_feed(feed_url: str, debug: bool = False) -> bytes:
    """
    Scarica il contenuto XML/JSON di un feed.
    
    Args:
        feed_url: URL del feed da scaricare
        debug: Se True, stampa informazioni di debug
        
    Returns:
        Contenuto del feed come bytes
    """
    if debug:
        print(f"Scaricamento feed: {feed_url}")
    
    # Determina gli header da usare in base al dominio
    headers = {
        'User-Agent': USER_AGENT,
        'Accept': 'application/xml, application/rss+xml, application/atom+xml, text/html, */*',
        'Cache-Control': 'no-cache'
    }
    
    # Header specializzati per siti specifici
    domain = urlparse(feed_url).netloc
    if 'wired.it' in domain:
        headers['Accept'] = 'application/rss+xml, application/xml, */*'
    elif 'theinformation.com' in domain:
        headers['Accept'] = 'application/atom+xml, application/xml, */*'
    
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            response = await client.get(feed_url, headers=headers, follow_redirects=True)
            
            if response.status_code != 200:
                raise HTTPException(
                    status_code=response.status_code,
                    detail=f"Impossibile recuperare il feed: {response.status_code}"
                )
            
            if debug:
                content_type = response.headers.get('content-type', '')
                print(f"Feed recuperato con content-type: {content_type}")
                print(f"Lunghezza contenuto: {len(response.content)} bytes")
            
            return response.content
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Timeout durante il recupero del feed")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Errore nel recupero del feed: {str(e)}")

def find_image_url(entry, content: str = "") -> str:
    """
    Trova l'URL dell'immagine di un articolo nel feed.
    
    Args:
        entry: Oggetto entry del feed
        content: Contenuto HTML dell'articolo (opzionale)
        
    Returns:
        URL dell'immagine o stringa vuota se non trovata
    """
    # 1. Controlla enclosure
    if hasattr(entry, 'enclosures') and entry.enclosures:
        for enclosure in entry.enclosures:
            if hasattr(enclosure, 'type') and 'image' in enclosure.type and hasattr(enclosure, 'href'):
                return enclosure.href
    
    # 2. Controlla media:content e media:thumbnail
    if hasattr(entry, 'media_content') and entry.media_content:
        for media in entry.media_content:
            if hasattr(media, 'url'):
                return media.url
    
    if hasattr(entry, 'media_thumbnail') and entry.media_thumbnail:
        for media in entry.media_thumbnail:
            if hasattr(media, 'url'):
                return media.url
    
    # 3. Cerca nel contenuto HTML
    if content:
        # Usa BeautifulSoup per trovare tag img
        soup = BeautifulSoup(content, 'lxml')
        img_tag = soup.find('img')
        if img_tag and img_tag.has_attr('src'):
            img_url = img_tag['src']
            if img_url.startswith('//'):
                return 'https:' + img_url
            return img_url
        
        # Fallback a regex
        img_match = re.search(r'<img[^>]+src=["\'](https?://[^"\']+)["\']', content)
        if img_match:
            return img_match.group(1)
    
    return ""

def normalize_feed(feed_data, feed_url: str, debug: bool = False) -> FeedResponse:
    """
    Normalizza i dati di un feed in un formato standard.
    
    Args:
        feed_data: Dati del feed da normalizzare
        feed_url: URL originale del feed
        debug: Se True, stampa informazioni di debug
        
    Returns:
        Oggetto FeedResponse normalizzato
    """
    # Determina il tipo di feed (RSS o Atom)
    feed_type = 'atom' if hasattr(feed_data.feed, 'xmlns') and 'atom' in getattr(feed_data.feed, 'xmlns', '') else 'rss'
    
    if debug:
        print(f"Tipo di feed rilevato: {feed_type}")
    
    # Estrai il titolo e la descrizione del feed
    feed_title = getattr(feed_data.feed, 'title', None) or urlparse(feed_url).netloc
    feed_description = getattr(feed_data.feed, 'description', '') or getattr(feed_data.feed, 'subtitle', '')
    
    # Normalizza gli articoli
    normalized_items = []
    
    for entry in feed_data.entries:
        # Estrai l'URL dell'articolo
        link = getattr(entry, 'link', '')
        
        # Estrai il titolo
        title = getattr(entry, 'title', 'No title')
        
        # Estrai il contenuto
        content = ''
        if hasattr(entry, 'content') and entry.content:
            # Atom feed
            if isinstance(entry.content, list) and len(entry.content) > 0:
                content = entry.content[0].value
            else:
                content = str(entry.content)
        elif hasattr(entry, 'description'):
            # RSS feed
            content = entry.description
        
        # Estrai la descrizione/sommario
        description = getattr(entry, 'summary', content)
        
        # Estrai la data di pubblicazione
        pub_date = None
        if hasattr(entry, 'published_parsed') and entry.published_parsed:
            pub_date = time.strftime('%Y-%m-%dT%H:%M:%SZ', entry.published_parsed)
        elif hasattr(entry, 'updated_parsed') and entry.updated_parsed:
            pub_date = time.strftime('%Y-%m-%dT%H:%M:%SZ', entry.updated_parsed)
        else:
            pub_date = datetime.now().isoformat()
        
        # Estrai l'ID
        id_value = getattr(entry, 'id', link)
        if not id_value:
            id_value = f"{link}_{time.time()}"
        
        # Estrai le categorie
        categories = []
        if hasattr(entry, 'tags'):
            for tag in entry.tags:
                if hasattr(tag, 'term'):
                    categories.append(tag.term)
                elif hasattr(tag, 'name'):
                    categories.append(tag.name)
                else:
                    categories.append(str(tag))
        
        # Trova l'URL dell'immagine
        image_url = find_image_url(entry, content)
        
        # Aggiungi l'articolo normalizzato
        normalized_items.append(FeedItem(
            id=id_value,
            title=title,
            link=link,
            content=content,
            description=description,
            imageUrl=image_url,
            pubDate=pub_date,
            categories=categories,
            author=getattr(entry, 'author', ''),
            sourceName=feed_title
        ))
    
    # Crea la risposta finale
    return FeedResponse(
        feedType=feed_type,
        title=feed_title,
        description=feed_description,
        link=feed_url,
        items=normalized_items
    )

@app.get("/api/rss-py", response_model=FeedResponse)
async def get_rss_feed(
    url: str = Query(..., description="URL del feed RSS/Atom"),
    debug: bool = Query(False, description="Modalità debug"),
    bypassCache: bool = Query(False, description="Ignora la cache")
):
    """
    Scarica, normalizza e restituisce un feed RSS/Atom.
    
    Args:
        url: URL del feed da elaborare
        debug: Se True, stampa informazioni di debug
        bypassCache: Se True, ignora la cache e scarica sempre il feed
        
    Returns:
        Oggetto FeedResponse con i dati del feed normalizzati
    """
    # Controlla la cache, a meno che non sia esplicitamente bypassata
    if not bypassCache:
        cache_key = url
        if cache_key in feed_cache:
            if debug:
                print('Servendo dalla cache')
            return feed_cache[cache_key]
    
    # Scarica il feed
    feed_content = await fetch_feed(url, debug)
    
    # Elabora il feed
    try:
        # Convertiamo prima in UTF-8 per gestire codifiche problematiche
        feed_text = feed_content.decode('utf-8', errors='replace')
        feed_data = feedparser.parse(feed_text)
        
        if not feed_data.entries:
            if debug:
                print(f"Nessun articolo trovato nel feed: {url}")
            raise HTTPException(status_code=404, detail="Nessun articolo trovato nel feed")
        
        # Normalizza il feed
        normalized_feed = normalize_feed(feed_data, url, debug)
        
        # Salva in cache
        feed_cache[url] = normalized_feed
        
        return normalized_feed
    
    except Exception as e:
        if debug:
            print(f"Errore nell'elaborazione del feed: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Errore nell'elaborazione del feed: {str(e)}")

# Adapter per Vercel - necessario per l'integrazione con le funzioni serverless
from mangum import Mangum
handler = Mangum(app)