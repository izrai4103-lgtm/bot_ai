"""
Sandbox Server — FastAPI server untuk AI Sandbox Qwen.
Berjalan sebagai microservice terpisah untuk mendukung Vercel (Node.js) deployment.
"""

import os
import json
import uuid
import logging
from typing import Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from ai_sandbox_qwen import AISandbox, AISandboxError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("sandbox_server")

# ============ MODELS ============

class ChatRequest(BaseModel):
    prompt: str = Field(..., description="Pesan user")
    history: Optional[list] = Field(None, description="Riwayat chat")
    temperature: Optional[float] = Field(None, ge=0, le=2)
    max_tokens: Optional[int] = Field(None, ge=1, le=16384)
    model: Optional[str] = Field("qwen/qwen3.6-27b")
    system: Optional[str] = Field(None, description="System prompt kustom")

class ChatResponse(BaseModel):
    id: str
    model: str
    content: str
    usage: dict

class StatsResponse(BaseModel):
    total_requests: int
    total_tokens: int
    errors: int
    last_request: Optional[float]

# ============ APP ============

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Sandbox server starting...")
    yield
    logger.info("Sandbox server shutting down.")

app = FastAPI(
    title="AI Sandbox Qwen",
    description="Sandbox untuk model AI utama (Qwen via Groq)",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Sandbox singleton
_sandbox: Optional[AISandbox] = None

def get_sandbox() -> AISandbox:
    global _sandbox
    if _sandbox is None:
        _sandbox = AISandbox(
            api_key=os.environ.get("GROQ_API_KEY"),
            model=os.environ.get("SANDBOX_MODEL", "qwen/qwen3.6-27b"),
            temperature=float(os.environ.get("SANDBOX_TEMPERATURE", "0.7")),
            max_tokens=int(os.environ.get("SANDBOX_MAX_TOKENS", "4096")),
        )
    return _sandbox


# ============ ENDPOINTS ============

@app.get("/")
@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": os.environ.get("SANDBOX_MODEL", "qwen/qwen3.6-27b"),
        "sandbox_ready": _sandbox is not None,
    }

@app.get("/stats")
async def stats():
    sandbox = get_sandbox()
    return sandbox.get_stats()

@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """Chat non-streaming."""
    try:
        sandbox = get_sandbox()
        
        # Set system prompt jika dikirim
        if request.system:
            sandbox.system_prompt = request.system
        
        content = sandbox.chat(
            prompt=request.prompt,
            history=request.history,
            temperature=request.temperature,
            max_tokens=request.max_tokens,
        )
        
        return ChatResponse(
            id=str(uuid.uuid4()),
            model=sandbox.model,
            content=content,
            usage=sandbox.get_stats(),
        )
    except AISandboxError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        logger.exception("Chat error")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/chat/stream")
async def chat_stream(request: ChatRequest):
    """Chat streaming via Server-Sent Events."""
    sandbox = get_sandbox()
    
    if request.system:
        sandbox.system_prompt = request.system
    
    async def event_generator():
        yield {"event": "start", "data": json.dumps({"model": sandbox.model})}
        
        try:
            full_content = ""
            for chunk in sandbox.chat_stream(
                prompt=request.prompt,
                history=request.history,
                temperature=request.temperature,
                max_tokens=request.max_tokens,
            ):
                full_content += chunk
                yield {"event": "chunk", "data": json.dumps({"content": chunk})}
            
            yield {"event": "done", "data": json.dumps({"content": full_content, "stats": sandbox.get_stats()})}
        except Exception as e:
            yield {"event": "error", "data": json.dumps({"error": str(e)})}
    
    return EventSourceResponse(event_generator())

@app.post("/reset")
async def reset():
    """Reset sandbox stats."""
    sandbox = get_sandbox()
    sandbox.reset_stats()
    return {"status": "ok"}

@app.post("/configure")
async def configure(
    model: Optional[str] = None,
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
    system: Optional[str] = None,
):
    """Konfigurasi sandbox runtime."""
    global _sandbox
    if _sandbox is None:
        _sandbox = AISandbox()
    if model:
        _sandbox.model = model
    if temperature is not None:
        _sandbox.temperature = temperature
    if max_tokens is not None:
        _sandbox.max_tokens = max_tokens
    if system is not None:
        _sandbox.system_prompt = system
    return {"status": "configured", "model": _sandbox.model}


# ============ MAIN ============
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8000"))
    logger.info(f"Starting sandbox server on port {port}")
    uvicorn.run(app, host="0.0.0.0", port=port)
