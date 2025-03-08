from http.server import BaseHTTPRequestHandler
import json
import urllib.parse
import requests

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

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        
        # Parse query parameters
        query = urllib.parse.urlparse(self.path).query
        params = dict(urllib.parse.parse_qsl(query))
        
        url = params.get('url', '')
        
        if not url:
            response = {"error": "URL parametro mancante"}
        else:
            # Normalizza l'URL
            if not url.startswith('http'):
                url = 'https://' + url
                
            # Estrai il dominio
            hostname = urllib.parse.urlparse(url).hostname
            site_root = f"{urllib.parse.urlparse(url).scheme}://{hostname}"
            
            # Trova i feed per il dominio specifico
            feed_urls = []
            for domain, known_url in KNOWN_DOMAINS.items():
                if domain in hostname:
                    feed_urls.append({
                        'url': known_url,
                        'source': 'known_domain',
                        'title': f'Feed di {domain}'
                    })
            
            response = {
                'feeds': feed_urls,
                'site': site_root
            }
        
        # Write JSON response
        self.wfile.write(json.dumps(response).encode())
        return