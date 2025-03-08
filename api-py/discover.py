from http.server import BaseHTTPRequestHandler
import json
import urllib.parse
import requests
from bs4 import BeautifulSoup
import re
from urllib.parse import urljoin, urlparse

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

# Cache semplice (per produzione usare una soluzione più robusta)
discovery_cache = {}
CACHE_TTL = 24 * 60 * 60  # 24 ore in secondi

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        # Gestione CORS
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET,OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 
                        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version')
        self.end_headers()

        # Gestione della richiesta OPTIONS (preflight)
        if self.command == 'OPTIONS':
            return

        # Estrai l'URL dai parametri della query
        parsed_path = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed_path.query)
        url = params.get('url', [''])[0]

        if not url:
            self.wfile.write(json.dumps({"error": "URL parametro mancante"}).encode())
            return

        try:
            # Normalizza l'URL per assicurarsi che sia completo
            base_url = urllib.parse.unquote(url)
            if not base_url.startswith('http'):
                base_url = 'https://' + base_url
            
            # Rimuovi eventuali path e mantieni solo il dominio base
            url_obj = urlparse(base_url)
            hostname = url_obj.hostname
            site_root = f"{url_obj.scheme}://{hostname}"
            
            print(f"Cercando feed RSS per: {site_root}")
            
            # Verifica la cache
            if site_root in discovery_cache:
                print("Servendo dalla cache")
                self.wfile.write(json.dumps(discovery_cache[site_root]).encode())
                return
            
            # Luoghi comuni dove cercare i feed
            possible_paths = [
                '/',                # Pagina principale
                '/feed',            # Percorso comune
                '/rss',             # Percorso comune
                '/feed/rss',        # Wired, WordPress
                '/rss/index.xml',   # The Verge
                '/atom',            # Atom feed
                '/rss.xml',         # Percorso comune
                '/feed.xml',        # Percorso comune
                '/feeds/posts/default', # Blogger
                '/rssfeeds/',       # Alcuni siti di news
                '/index.xml'        # Hugo e altri generatori statici
            ]
            
            feed_urls = []
            common_feed_identifiers = [
                'application/rss+xml',
                'application/atom+xml',
                'application/feed+json',
                'application/rss',
                'application/xml',
                'text/xml'
            ]

            # Prima controlla la home page per i link di autodiscovery
            try:
                print(f"Controllando l'autodiscovery sulla home page: {site_root}")
                
                headers = {
                    'User-Agent': USER_AGENT,
                    'Accept': 'text/html'
                }
                
                response = requests.get(site_root, headers=headers, timeout=TIMEOUT)
                
                if response.ok:
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
                                
                                feed_urls.append({
                                    'url': feed_url,
                                    'source': 'autodiscovery',
                                    'title': link.get('title', f'Feed di {hostname}')
                                })
                    
                    print(f"Trovati {len(feed_urls)} feed tramite autodiscovery")
            except Exception as e:
                print(f"Errore durante l'autodiscovery: {str(e)}")
            
            # Se l'autodiscovery fallisce, prova i percorsi comuni
            if len(feed_urls) == 0:
                print('Autodiscovery fallito. Tentativo con percorsi comuni...')
                
                for path in possible_paths:
                    test_url = site_root + path
                    try:
                        headers = {'User-Agent': USER_AGENT}
                        response = requests.head(test_url, headers=headers, timeout=5)
                        
                        if response.ok:
                            content_type = response.headers.get('content-type', '')
                            if ('xml' in content_type or 
                                'rss' in content_type or 
                                'atom' in content_type):
                                
                                feed_urls.append({
                                    'url': test_url,
                                    'source': 'common_path',
                                    'title': f'Feed di {hostname}'
                                })
                    except:
                        # Ignora gli errori per i singoli tentativi
                        pass
            
            # Se ancora non abbiamo trovato nulla, prova con domini noti
            if len(feed_urls) == 0:
                print('Tentativo con domini noti...')
                
                # Controlla se il dominio è noto
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
            
            # Salva in cache
            discovery_cache[site_root] = result
            
            # Ritorna i feed trovati
            self.wfile.write(json.dumps(result).encode())
            
        except Exception as e:
            print(f"Errore generale: {str(e)}")
            self.wfile.write(json.dumps({
                "error": "Errore interno del server", 
                "message": str(e)
            }).encode())