from fastapi import FastAPI, Query, HTTPException
from pydantic import BaseModel
from typing import List
import httpx
from bs4 import BeautifulSoup
from urllib.parse import urlparse
from mangum import Mangum
import time
from cachetools import TTLCache

# Creazione dell'app FastAPI
app = FastAPI()

# Aggiunta middleware CORS
from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configurazione
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
TIMEOUT = 10.0  # secondi
discovery_cache = TTLCache(maxsize=500, ttl=24*60*60)  # 24 ore di cache

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

# Modelli Pydantic
class FeedInfo(BaseModel):
    url: str
    source: str
    title: str

class DiscoveryResponse(BaseModel):
    feeds: List[FeedInfo]
    site: str

@app.get("/api/discover")
async def discover_feeds(url: str = Query(...)):
    """Trova feed RSS/Atom per un dato URL di sito web"""
    # Normalizza l'URL
    normalized_url = url.strip()
    if not normalized_url.startswith('http'):
        normalized_url = 'https://' + normalized_url
    
    # Estrai il dominio base
    parsed_url = urlparse(normalized_url)
    hostname = parsed_url.hostname
    site_root = f"{parsed_url.scheme}://{hostname}"
    
    # Controlla la cache
    cache_key = site_root
    if cache_key in discovery_cache:
        return {"feeds": discovery_cache[cache_key], "site": site_root}
    
    try:
        # Trova i feed
        all_feeds = []
        
        # 1. Prova l'autodiscovery
        autodiscovery_feeds = await find_feeds_via_autodiscovery(site_root, hostname)
        all_feeds.extend(autodiscovery_feeds)
        
        # 2. Se l'autodiscovery fallisce, prova i percorsi comuni
        if len(all_feeds) == 0:
            common_paths_feeds = await find_feeds_via_common_paths(site_root, hostname)
            all_feeds.extend(common_paths_feeds)
        
        # 3. Se ancora nessun feed, prova i domini noti
        if len(all_feeds) == 0:
            known_domain_feeds = find_feeds_via_known_domains(hostname)
            all_feeds.extend(known_domain_feeds)
        
        # Aggiorna la cache e restituisci
        feeds_dicts = [feed.dict() for feed in all_feeds]
        discovery_cache[cache_key] = feeds_dicts
        return {"feeds": feeds_dicts, "site": site_root}
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Errore nella ricerca dei feed: {str(e)}")

async def find_feeds_via_autodiscovery(site_root: str, hostname: str) -> List[FeedInfo]:
    """Trova feed usando i tag <link> nella home page"""
    feed_urls = []
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            response = await client.get(site_root, headers={'User-Agent': USER_AGENT})
            
            if response.status_code == 200:
                soup = BeautifulSoup(response.text, 'html.parser')
                
                for link in soup.find_all('link', rel=lambda r: r and ('alternate' in r.lower() or 'feed' in r.lower())):
                    if link.get('type') and any(x in link['type'] for x in ['rss', 'atom', 'xml']):
                        feed_url = link.get('href', '')
                        
                        # Risolvi URL relativi
                        if feed_url.startswith('/'):
                            feed_url = site_root + feed_url
                        elif not feed_url.startswith('http'):
                            feed_url = site_root + '/' + feed_url
                        
                        title = link.get('title', f'Feed di {hostname}')
                        feed_urls.append(FeedInfo(url=feed_url, source='autodiscovery', title=title))
    except Exception:
        pass
    
    return feed_urls

async def find_feeds_via_common_paths(site_root: str, hostname: str) -> List[FeedInfo]:
    """Trova feed verificando percorsi RSS comuni"""
    feed_urls = []
    common_paths = [
        '/feed',
        '/rss',
        '/feed/rss',
        '/rss.xml',
        '/feed.xml',
        '/atom.xml',
        '/index.xml'
    ]
    
    async with httpx.AsyncClient(timeout=5.0, verify=False) as client:
        for path in common_paths:
            try:
                test_url = site_root + path
                response = await client.head(test_url, headers={'User-Agent': USER_AGENT})
                
                if response.status_code == 200:
                    content_type = response.headers.get('content-type', '')
                    if any(x in content_type.lower() for x in ['xml', 'rss', 'atom']):
                        feed_urls.append(FeedInfo(
                            url=test_url, 
                            source='common_path',
                            title=f'Feed di {hostname}'
                        ))
            except Exception:
                continue
    
    return feed_urls

def find_feeds_via_known_domains(hostname: str) -> List[FeedInfo]:
    """Trova feed basati su mappature di domini noti"""
    feed_urls = []
    
    for domain, feed_url in KNOWN_DOMAINS.items():
        if domain in hostname:
            feed_urls.append(FeedInfo(
                url=feed_url,
                source='known_domain',
                title=f'Feed di {domain}'
            ))
    
    return feed_urls

# Crea l'handler per la funzione serverless di Vercel
handler = Mangum(app)