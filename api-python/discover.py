from .base import create_app
import httpx
from fastapi import Query, HTTPException
from pydantic import BaseModel, Field
from typing import List, Optional
from bs4 import BeautifulSoup
from urllib.parse import urlparse, urljoin
import re
import time
import asyncio
from cachetools import TTLCache

# Creazione dell'app FastAPI
app = create_app()

# Configurazione
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
TIMEOUT = 10.0  # secondi

# Cache con TTL (Time To Live)
# Memorizza fino a 500 risultati per 24 ore
discovery_cache = TTLCache(maxsize=500, ttl=24*60*60)

# Domini noti con feed RSS
KNOWN_DOMAINS = {
    'wired.it': 'https://www.wired.it/feed/rss',
    'repubblica.it': 'https://www.repubblica.it/rss/homepage/rss2.0.xml',
    'ilpost.it': 'https://www.ilpost.it/feed/',
    'ansa.it': 'https://www.ansa.it/sito/notizie/tecnologia/tecnologia_rss.xml',
    'corriere.it': 'https://xml2.corriereobjects.it/rss/homepage.xml',
    'gazzetta.it': 'https://www.gazzetta.it/rss/home.xml',
    'tomshw.it': 'https://www.tomshw.it/feed/',
    'nytimes.com': 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml',
    'theverge.com': 'https://www.theverge.com/rss/index.xml',
    'bbc.co.uk': 'http://feeds.bbci.co.uk/news/world/rss.xml'
}

# Modelli di dati Pydantic
class FeedInfo(BaseModel):
    """Modello per rappresentare le informazioni di un feed RSS/Atom"""
    url: str = Field(..., description="URL completo del feed")
    source: str = Field(..., description="Metodo di discovery usato")
    title: str = Field(..., description="Titolo del feed se disponibile")

class DiscoveryResponse(BaseModel):
    """Modello di risposta per l'endpoint di discovery"""
    feeds: List[FeedInfo] = Field(..., description="Lista dei feed trovati")
    site: str = Field(..., description="URL base del sito analizzato")

async def find_feeds_via_autodiscovery(site_root: str, hostname: str) -> List[FeedInfo]:
    """
    Trova i feed RSS/Atom tramite autodiscovery analizzando i tag <link> nella home page.
    
    Args:
        site_root: URL base del sito (es. https://wired.it)
        hostname: Nome host estratto dall'URL (es. wired.it)
        
    Returns:
        Lista di oggetti FeedInfo trovati
    """
    feed_urls = []
    common_feed_identifiers = [
        'application/rss+xml',
        'application/atom+xml',
        'application/feed+json',
        'application/rss',
        'application/xml',
        'text/xml'
    ]

    try:
        print(f"Controllando l'autodiscovery sulla home page: {site_root}")
        
        headers = {
            'User-Agent': USER_AGENT,
            'Accept': 'text/html',
            'Cache-Control': 'no-cache'
        }
        
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            response = await client.get(site_root, headers=headers)
            
            if response.status_code == 200:
                html = response.text
                soup = BeautifulSoup(html, 'lxml')
                
                # Cerca i tag link con rel="alternate" che puntano a feed
                for link in soup.find_all('link', rel=lambda r: r and ('alternate' in r.lower() or 'feed' in r.lower())):
                    link_type = link.get('type', '')
                    if any(ident in link_type for ident in common_feed_identifiers):
                        feed_url = link.get('href')
                        if feed_url:
                            # Risolvi URL relativi
                            if feed_url.startswith('/'):
                                feed_url = site_root + feed_url
                            elif not feed_url.startswith('http'):
                                feed_url = site_root + '/' + feed_url
                            
                            # Ottieni il titolo se disponibile
                            title = link.get('title', f'Feed di {hostname}')
                            
                            feed_urls.append(FeedInfo(
                                url=feed_url,
                                source='autodiscovery',
                                title=title
                            ))
                
                print(f"Trovati {len(feed_urls)} feed tramite autodiscovery")
    except Exception as e:
        print(f"Errore durante l'autodiscovery: {str(e)}")
    
    return feed_urls

async def find_feeds_via_common_paths(site_root: str, hostname: str) -> List[FeedInfo]:
    """
    Trova i feed RSS/Atom provando percorsi comuni.
    
    Args:
        site_root: URL base del sito (es. https://wired.it)
        hostname: Nome host estratto dall'URL (es. wired.it)
        
    Returns:
        Lista di oggetti FeedInfo trovati
    """
    feed_urls = []
    possible_paths = [
        '/feed',            # Percorso comune
        '/rss',             # Percorso comune
        '/feed/rss',        # Wired, WordPress
        '/rss/index.xml',   # The Verge
        '/atom',            # Atom feed
        '/rss.xml',         # Percorso comune
        '/feed.xml',        # Percorso comune
        '/feeds/posts/default', # Blogger
        '/rssfeeds/',       # Alcuni siti di news
        '/index.xml',       # Hugo e altri generatori statici
        '/feed/atom',       # Atom alternativo
        '/atom.xml'         # Atom alternativo
    ]
    
    print('Tentativo con percorsi comuni...')
    
    headers = {
        'User-Agent': USER_AGENT,
        'Accept': 'application/xml, application/rss+xml, application/atom+xml'
    }
    
    # Crea un elenco di task per verificare tutti i percorsi in parallelo
    async with httpx.AsyncClient(timeout=5.0, verify=False) as client:
        tasks = []
        for path in possible_paths:
            test_url = site_root + path
            tasks.append(check_feed_url(client, test_url, path, hostname))
        
        # Esegui tutte le richieste in parallelo e raccogli i risultati
        results = await asyncio.gather(*tasks, return_exceptions=True)
        
        # Filtra i risultati validi (escludendo eccezioni)
        for result in results:
            if isinstance(result, FeedInfo):
                feed_urls.append(result)
    
    return feed_urls

async def check_feed_url(client, url: str, path: str, hostname: str) -> Optional[FeedInfo]:
    """
    Verifica se un URL specifico contiene un feed valido.
    
    Args:
        client: httpx.AsyncClient per effettuare la richiesta
        url: URL da verificare
        path: Percorso relativo del feed (usato per il titolo)
        hostname: Nome host estratto dall'URL
        
    Returns:
        FeedInfo se il feed è valido, None altrimenti o in caso di errore
    """
    try:
        # Usa head request per verificare solo l'esistenza e il content-type
        response = await client.head(url)
        
        if response.status_code == 200:
            content_type = response.headers.get('content-type', '')
            if any(x in content_type.lower() for x in ['xml', 'rss', 'atom', 'feed']):
                return FeedInfo(
                    url=url,
                    source='common_path',
                    title=f'Feed di {hostname} ({path})'
                )
    except Exception:
        # Ignora gli errori, semplicemente non aggiungiamo questo feed
        pass
    
    return None

def find_feeds_via_known_domains(hostname: str) -> List[FeedInfo]:
    """
    Trova i feed RSS basati su domini noti in un database predefinito.
    
    Args:
        hostname: Nome host estratto dall'URL (es. wired.it)
        
    Returns:
        Lista di oggetti FeedInfo trovati
    """
    feed_urls = []
    
    print('Tentativo con domini noti...')
    
    for domain, known_url in KNOWN_DOMAINS.items():
        if domain in hostname:
            feed_urls.append(FeedInfo(
                url=known_url,
                source='known_domain',
                title=f'Feed di {domain}'
            ))
    
    return feed_urls

@app.get("/api/discover-py", response_model=DiscoveryResponse)
async def discover_feeds(url: str = Query(..., description="URL del sito di cui trovare i feed RSS")):
    """
    Trova i feed RSS/Atom disponibili per il sito specificato.
    
    La ricerca avviene in tre fasi:
    1. Autodiscovery tramite tag <link> nella home page
    2. Tentativo con percorsi comuni
    3. Ricerca in un database di domini noti
    
    Args:
        url: URL del sito di cui trovare i feed (es. wired.it)
        
    Returns:
        Oggetto DiscoveryResponse con i feed trovati e l'URL del sito
    """
    # Normalizza l'URL
    if not url.startswith('http'):
        url = 'https://' + url
    
    # Estrai il dominio base
    parsed_url = urlparse(url)
    hostname = parsed_url.hostname
    site_root = f"{parsed_url.scheme}://{hostname}"
    
    # Verifica la cache
    cache_key = site_root
    if cache_key in discovery_cache:
        print(f"Servendo {site_root} dalla cache")
        cached_feeds = discovery_cache[cache_key]
        return DiscoveryResponse(feeds=cached_feeds, site=site_root)
    
    # Inizia la ricerca dei feed
    all_feeds = []
    
    # 1. Prova l'autodiscovery sulla home page
    feeds_from_autodiscovery = await find_feeds_via_autodiscovery(site_root, hostname)
    all_feeds.extend(feeds_from_autodiscovery)
    
    # 2. Se l'autodiscovery fallisce, prova i percorsi comuni
    if len(all_feeds) == 0:
        feeds_from_common_paths = await find_feeds_via_common_paths(site_root, hostname)
        all_feeds.extend(feeds_from_common_paths)
    
    # 3. Se ancora non abbiamo feed, prova con i domini noti
    if len(all_feeds) == 0:
        feeds_from_known_domains = find_feeds_via_known_domains(hostname)
        all_feeds.extend(feeds_from_known_domains)
    
    # Elimina duplicati in base all'URL
    unique_feeds = []
    seen_urls = set()
    for feed in all_feeds:
        if feed.url not in seen_urls:
            seen_urls.add(feed.url)
            unique_feeds.append(feed)
    
    # Aggiorna la cache
    discovery_cache[cache_key] = unique_feeds
    
    # Restituisci i feed trovati
    return DiscoveryResponse(feeds=unique_feeds, site=site_root)

# Adapter per Vercel - necessario per l'integrazione con le funzioni serverless
from mangum import Mangum
handler = Mangum(app)