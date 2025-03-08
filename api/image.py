from .base import create_app
import httpx
from fastapi import Query, HTTPException, Response
from pydantic import BaseModel, Field
from typing import Optional
import io
from urllib.parse import urlparse
from cachetools import TTLCache
from PIL import Image
import time

# Creazione dell'app FastAPI
app = create_app()

# Configurazione
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
TIMEOUT = 10.0  # secondi

# Cache con TTL (Time To Live)
# Memorizza fino a 300 immagini per 24 ore
image_cache = TTLCache(maxsize=300, ttl=24*60*60)

# Domini problematici noti che richiedono header speciali
PROBLEMATIC_DOMAINS = [
    'media-assets.wired.it',
    'repubblica.it',
    'corriere.it',
    'gazzetta.it',
    'lastampa.it',
    'ilsole24ore.com',
    'wired.it',
    'ansa.it'
]

class ImageInfo(BaseModel):
    """Informazioni sull'immagine in cache"""
    data: bytes
    content_type: str
    timestamp: float

def should_use_proxy(url: str) -> bool:
    """
    Determina se un URL dovrebbe utilizzare il proxy.
    
    Args:
        url: URL dell'immagine
        
    Returns:
        True se l'URL dovrebbe usare il proxy, False altrimenti
    """
    # Controlla domini problematici noti
    domain = urlparse(url).netloc
    for problematic_domain in PROBLEMATIC_DOMAINS:
        if problematic_domain in domain:
            return True
    
    # Per default, usa il proxy solo per URL non HTTPS
    return not url.startswith('https://')

def get_domain_specific_headers(url: str) -> dict:
    """
    Ottiene header HTTP specifici per dominio.
    
    Args:
        url: URL dell'immagine
        
    Returns:
        Dizionario con gli header HTTP
    """
    domain = urlparse(url).netloc
    
    # Header di base
    headers = {
        'User-Agent': USER_AGENT,
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer': f"https://{domain}/",
        'Origin': f"https://{domain}"
    }
    
    # Header specifici per wired.it
    if 'wired.it' in domain:
        headers['Cookie'] = ''
        headers['Sec-Fetch-Dest'] = 'image'
        headers['Sec-Fetch-Mode'] = 'no-cors'
    
    # Header specifici per nytimes.com e repubblica.it
    if 'nytimes.com' in domain or 'repubblica.it' in domain:
        headers['Referer'] = f"https://{domain}/"
    
    return headers

async def fetch_image(image_url: str) -> tuple:
    """
    Scarica un'immagine da un URL.
    
    Args:
        image_url: URL dell'immagine da scaricare
        
    Returns:
        Tupla (dati immagine, content-type)
    """
    headers = get_domain_specific_headers(image_url)
    
    async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
        response = await client.get(image_url, headers=headers, follow_redirects=True)
        
        if response.status_code != 200:
            raise HTTPException(
                status_code=response.status_code,
                detail=f"Impossibile recuperare l'immagine: {response.status_code}"
            )
        
        content_type = response.headers.get('content-type', 'image/jpeg')
        return response.content, content_type

async def process_image(image_data: bytes, 
                        width: Optional[int] = None, 
                        height: Optional[int] = None, 
                        quality: int = 80,
                        output_format: Optional[str] = None) -> tuple:
    """
    Elabora un'immagine (ridimensiona, cambia formato, ecc.)
    
    Args:
        image_data: Dati binari dell'immagine
        width: Larghezza desiderata (opzionale)
        height: Altezza desiderata (opzionale)
        quality: Qualità dell'immagine (1-100)
        output_format: Formato di output (webp, jpeg, png)
        
    Returns:
        Tupla (dati immagine processati, content-type)
    """
    try:
        img = Image.open(io.BytesIO(image_data))
        
        # Ridimensiona se necessario
        if width or height:
            w = width if width else img.width
            h = height if height else img.height
            img = img.resize((w, h), Image.LANCZOS)
        
        # Determina il formato di output
        img_format = output_format.upper() if output_format else img.format or 'JPEG'
        content_type = f"image/{img_format.lower()}"
        
        # Normalizza il formato
        if img_format.lower() == 'webp':
            img_format = 'WEBP'
            content_type = 'image/webp'
        elif img_format.lower() in ('jpeg', 'jpg'):
            img_format = 'JPEG'
            content_type = 'image/jpeg'
        elif img_format.lower() == 'png':
            img_format = 'PNG'
            content_type = 'image/png'
        else:
            # Default a JPEG per sicurezza
            img_format = 'JPEG'
            content_type = 'image/jpeg'
        
        # Salva l'immagine elaborata
        output = io.BytesIO()
        save_params = {}
        
        if img_format == 'JPEG':
            save_params['quality'] = quality
            save_params['optimize'] = True
        elif img_format == 'PNG':
            save_params['optimize'] = True
        elif img_format == 'WEBP':
            save_params['quality'] = quality
        
        img.save(output, format=img_format, **save_params)
        processed_data = output.getvalue()
        
        return processed_data, content_type
        
    except Exception as e:
        print(f"Errore nell'elaborazione dell'immagine: {str(e)}")
        return image_data, "image/jpeg"  # Fallback ai dati originali

@app.get("/api/image-proxy-py")
async def proxy_image(
    url: str = Query(..., description="URL dell'immagine da recuperare"),
    width: Optional[int] = Query(None, description="Larghezza desiderata"),
    height: Optional[int] = Query(None, description="Altezza desiderata"),
    quality: int = Query(80, description="Qualità dell'immagine (1-100)"),
    format: Optional[str] = Query(None, description="Formato di output (webp, jpeg, png)")
):
    """
    Recupera un'immagine da un URL, la elabora opzionalmente e la restituisce.
    
    Questo proxy risolve problemi CORS e ottimizza le immagini.
    
    Args:
        url: URL dell'immagine da recuperare
        width: Larghezza desiderata (opzionale)
        height: Altezza desiderata (opzionale)
        quality: Qualità dell'immagine (1-100)
        format: Formato di output (webp, jpeg, png)
        
    Returns:
        Immagine elaborata
    """
    if not url:
        raise HTTPException(status_code=400, detail="URL parametro mancante")
    
    # Crea una chiave cache unica in base a tutti i parametri
    cache_key = f"{url}-{width}-{height}-{quality}-{format}"
    
    # Verifica la cache
    if cache_key in image_cache:
        cached_image = image_cache[cache_key]
        return Response(
            content=cached_image.data,
            media_type=cached_image.content_type,
            headers={
                "Cache-Control": "public, max-age=86400",
                "X-Cache": "HIT"
            }
        )
    
    try:
        # Scarica l'immagine
        image_data, content_type = await fetch_image(url)
        
        # Elabora l'immagine se necessario
        if width or height or format or quality != 80:
            processed_data, content_type = await process_image(
                image_data, width, height, quality, format
            )
        else:
            processed_data = image_data
        
        # Aggiorna la cache
        image_cache[cache_key] = ImageInfo(
            data=processed_data,
            content_type=content_type,
            timestamp=time.time()
        )
        
        # Restituisci l'immagine
        return Response(
            content=processed_data,
            media_type=content_type,
            headers={
                "Cache-Control": "public, max-age=86400",
                "X-Cache": "MISS"
            }
        )
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Errore nel proxy delle immagini: {str(e)}")

# Adapter per Vercel - necessario per l'integrazione con le funzioni serverless
from mangum import Mangum
handler = Mangum(app)