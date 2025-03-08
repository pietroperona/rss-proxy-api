from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

def create_app():
    """
    Crea e configura un'istanza dell'applicazione FastAPI con impostazioni
    comuni per tutte le API.
    """
    app = FastAPI()
    
    # Configurazione CORS per permettere richieste cross-origin
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    
    return app