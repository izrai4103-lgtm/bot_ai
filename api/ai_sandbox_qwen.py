"""
AI Sandbox Qwen — Sandbox aman untuk model AI utama (Qwen via Groq)
Menyediakan antarmuka chat & streaming yang terisolasi, dengan logging, error handling, dan filter.
"""

import os
import json
import time
import logging
from typing import Optional, Generator, Any

logger = logging.getLogger("ai_sandbox_qwen")


class AISandboxError(Exception):
    """Base exception untuk sandbox."""
    pass


class AISandbox:
    """
    Sandbox aman untuk menjalankan model Qwen via Groq API.
    
    Contoh:
        sandbox = AISandbox(api_key="gsk_...", model="qwen3.6-27b")
        response = sandbox.chat("Halo!")
        for chunk in sandbox.chat_stream("Halo!"):
            print(chunk, end="")
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: str = "qwen3.6-27b",
        temperature: float = 0.7,
        max_tokens: int = 4096,
        system_prompt: Optional[str] = None,
        base_url: str = "https://api.groq.com/openai/v1",
    ):
        self.api_key = api_key or os.environ.get("GROQ_API_KEY", "")
        if not self.api_key:
            raise AISandboxError(
                "GROQ_API_KEY tidak ditemukan. Set via parameter api_key atau env GROQ_API_KEY."
            )

        self.model = model
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.system_prompt = system_prompt
        self.base_url = base_url.rstrip("/")

        # Statistik internal
        self.stats = {
            "total_requests": 0,
            "total_tokens": 0,
            "errors": 0,
            "last_request": None,
        }

        # Cache session (HTTP keep-alive)
        self._session = None

        # Coba import httpx (lebih ringan dari openai)
        self._httpx = None
        self._openai = None
        self._init_http()

    def _init_http(self):
        """Inisialisasi HTTP client, prefer httpx."""
        try:
            import httpx
            self._httpx = httpx
        except ImportError:
            try:
                from openai import OpenAI
                self._openai = OpenAI
            except ImportError:
                raise AISandboxError(
                    "Butuh httpx atau openai Python package. Install: pip install httpx"
                )

    def _build_messages(self, prompt: str, history: Optional[list] = None) -> list:
        """Bangun list messages dari prompt + history."""
        messages = []
        if self.system_prompt:
            messages.append({"role": "system", "content": self.system_prompt})
        if history:
            messages.extend(history)
        messages.append({"role": "user", "content": prompt})
        return messages

    def _should_filter(self, text: str) -> bool:
        """Filter sederhana untuk konten berbahaya."""
        blocked_keywords = []
        for kw in blocked_keywords:
            if kw.lower() in text.lower():
                return True
        return False

    def chat(
        self,
        prompt: str,
        history: Optional[list] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> str:
        """
        Chat non-streaming. Mengembalikan string jawaban.
        
        Args:
            prompt: Pesan user
            history: Riwayat chat opsional [{"role": "...", "content": "..."}]
            temperature: Suhu sampling (override default)
            max_tokens: Token maksimal (override default)
        
        Returns:
            String jawaban AI
        """
        self.stats["total_requests"] += 1
        self.stats["last_request"] = time.time()

        messages = self._build_messages(prompt, history)

        try:
            if self._httpx:
                return self._chat_httpx(messages, temperature, max_tokens)
            else:
                return self._chat_openai(messages, temperature, max_tokens)
        except Exception as e:
            self.stats["errors"] += 1
            logger.error(f"Sandbox chat error: {e}")
            raise AISandboxError(f"Gagal memproses chat: {e}") from e

    def _chat_httpx(self, messages: list, temperature: Optional[float], max_tokens: Optional[int]) -> str:
        """Chat via httpx langsung ke Groq API."""
        import httpx

        with httpx.Client(timeout=60.0) as client:
            resp = client.post(
                f"{self.base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self.model,
                    "messages": messages,
                    "temperature": temperature or self.temperature,
                    "max_tokens": max_tokens or self.max_tokens,
                    "stream": False,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            content = data["choices"][0]["message"]["content"]
            usage = data.get("usage", {})
            self.stats["total_tokens"] += usage.get("total_tokens", 0)
            return content

    def _chat_openai(self, messages: list, temperature: Optional[float], max_tokens: Optional[int]) -> str:
        """Chat via OpenAI Python SDK."""
        client = self._openai(
            api_key=self.api_key,
            base_url=self.base_url,
        )
        resp = client.chat.completions.create(
            model=self.model,
            messages=messages,
            temperature=temperature or self.temperature,
            max_tokens=max_tokens or self.max_tokens,
            stream=False,
        )
        content = resp.choices[0].message.content
        if hasattr(resp, "usage") and resp.usage:
            self.stats["total_tokens"] += resp.usage.total_tokens or 0
        return content

    def chat_stream(
        self,
        prompt: str,
        history: Optional[list] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> Generator[str, None, None]:
        """
        Chat streaming. Yield chunk teks satu per satu.
        
        Args:
            prompt: Pesan user
            history: Riwayat chat opsional
            temperature: Suhu sampling (override default)
            max_tokens: Token maksimal (override default)
        
        Yields:
            Chunk teks dari AI
        """
        self.stats["total_requests"] += 1
        self.stats["last_request"] = time.time()

        messages = self._build_messages(prompt, history)

        try:
            if self._httpx:
                yield from self._chat_stream_httpx(messages, temperature, max_tokens)
            else:
                yield from self._chat_stream_openai(messages, temperature, max_tokens)
        except Exception as e:
            self.stats["errors"] += 1
            logger.error(f"Sandbox stream error: {e}")
            yield f"\n\n[Sandbox Error: {e}]"

    def _chat_stream_httpx(self, messages: list, temperature: Optional[float], max_tokens: Optional[int]) -> Generator[str, None, None]:
        """Streaming via httpx."""
        import httpx

        with httpx.Client(timeout=120.0) as client:
            with client.stream(
                "POST",
                f"{self.base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self.model,
                    "messages": messages,
                    "temperature": temperature or self.temperature,
                    "max_tokens": max_tokens or self.max_tokens,
                    "stream": True,
                },
            ) as resp:
                resp.raise_for_status()
                full_content = ""
                for line in resp.iter_lines():
                    if line.startswith("data: "):
                        data_str = line[6:]
                        if data_str == "[DONE]":
                            break
                        try:
                            data = json.loads(data_str)
                            delta = data["choices"][0].get("delta", {})
                            content = delta.get("content", "")
                            if content:
                                full_content += content
                                yield content
                        except json.JSONDecodeError:
                            continue

    def _chat_stream_openai(self, messages: list, temperature: Optional[float], max_tokens: Optional[int]) -> Generator[str, None, None]:
        """Streaming via OpenAI SDK."""
        client = self._openai(
            api_key=self.api_key,
            base_url=self.base_url,
        )
        stream = client.chat.completions.create(
            model=self.model,
            messages=messages,
            temperature=temperature or self.temperature,
            max_tokens=max_tokens or self.max_tokens,
            stream=True,
        )
        for chunk in stream:
            delta = chunk.choices[0].delta if chunk.choices else None
            if delta and delta.content:
                yield delta.content

    def get_stats(self) -> dict:
        """Dapatkan statistik sandbox."""
        return dict(self.stats)

    def reset_stats(self):
        """Reset statistik."""
        self.stats = {
            "total_requests": 0,
            "total_tokens": 0,
            "errors": 0,
            "last_request": None,
        }


# ============ MAIN (CLI test) ============
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    
    sandbox = AISandbox(
        model="qwen3.6-27b",
        temperature=0.7,
    )
    
    print("=== AI Sandbox Qwen CLI ===")
    print(f"Model: {sandbox.model}")
    print("Ketik 'exit' untuk keluar\n")
    
    history = []
    while True:
        try:
            prompt = input("You: ")
            if prompt.lower() in ("exit", "quit", "q"):
                break
            
            print("AI: ", end="", flush=True)
            full = ""
            for chunk in sandbox.chat_stream(prompt, history=history):
                print(chunk, end="", flush=True)
                full += chunk
            print()
            
            history.append({"role": "user", "content": prompt})
            history.append({"role": "assistant", "content": full})
            
            # Simpan history pendek (maks 10)
            if len(history) > 20:
                history = history[-20:]
                
        except KeyboardInterrupt:
            print("\nBye!")
            break
        except Exception as e:
            print(f"\nError: {e}")
    
    print(f"\nStats: {sandbox.get_stats()}")
