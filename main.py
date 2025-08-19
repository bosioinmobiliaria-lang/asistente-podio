
import os
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException

# Cargar variables de entorno desde .env
load_dotenv()

# --- Carga de Credenciales ---
PODIO_CLIENT_ID = os.getenv("PODIO_CLIENT_ID")
PODIO_CLIENT_SECRET = os.getenv("PODIO_CLIENT_SECRET")
PODIO_CONTACTOS_APP_ID = os.getenv("PODIO_CONTACTOS_APP_ID")
PODIO_CONTACTOS_APP_TOKEN = os.getenv("PODIO_CONTACTOS_APP_TOKEN")
PODIO_LEADS_APP_ID = os.getenv("PODIO_LEADS_APP_ID")
PODIO_LEADS_APP_TOKEN = os.getenv("PODIO_LEADS_APP_TOKEN")

# Validar que todas las credenciales estén presentes
if not all([PODIO_CLIENT_ID, PODIO_CLIENT_SECRET, PODIO_CONTACTOS_APP_ID, PODIO_CONTACTOS_APP_TOKEN, PODIO_LEADS_APP_ID, PODIO_LEADS_APP_TOKEN]):
    raise ValueError("Una o más variables de entorno de Podio no están configuradas. Revisa tu archivo .env")

app = FastAPI(
    title="Asistente Inmobiliario IA",
    description="Un asistente para interactuar con Podio usando lenguaje natural.",
    version="0.1.0"
)

# --- Lógica del Cliente de Podio ---
from pypodio2 import api

podio_client = None
try:
    podio_client = api.OAuthAppClient(
        PODIO_CLIENT_ID,
        PODIO_CLIENT_SECRET,
        PODIO_LEADS_APP_ID,
        PODIO_LEADS_APP_TOKEN,
    )
    print("Conexión con Podio establecida correctamente.")
except Exception as e:
    print(f"Error al conectar con Podio: {e}")


# --- Endpoints de la API ---

@app.get("/", summary="Endpoint de Bienvenida")
def read_root():
    """
    Endpoint de bienvenida que muestra un mensaje de estado.
    """
    return {"status": "ok", "message": "Asistente Inmobiliario IA está en línea."}

@app.get("/health", summary="Health Check")
def health_check():
    """
    Endpoint para verificar que el servicio está activo.
    """
    return {"status": "ok"}

# Aquí agregaremos los endpoints para las funciones que definimos (create_contact, etc.)

if __name__ == "__main__":
    import uvicorn
    print("Iniciando servidor en http://localhost:8000")
    uvicorn.run(app, host="0.0.0.0", port=8000)
