#!/bin/bash
# Setup Local AI Bot - Mode FULL LOCAL (no Groq)
echo "=== Setup ELENA Bot - Mode Local ==="

# 1. Install Ollama
if ! command -v ollama &> /dev/null; then
    echo "Menginstall Ollama..."
    curl -fsSL https://ollama.com/install.sh | bash
fi

# 2. Pull Qwen model (setara GPT-4o)
echo "Download Qwen2.5 14B (size ~9GB, pertama kali butuh waktu)..."
ollama pull qwen2.5:14b

# 3. Setup .env untuk local mode
cp -n .env.example .env 2>/dev/null || true
sed -i 's/USE_LOCAL_MODEL=false/USE_LOCAL_MODEL=true/' .env 2>/dev/null || true
sed -i 's/OLLAMA_MODEL=qwen2.5:7b/OLLAMA_MODEL=qwen2.5:14b/' .env 2>/dev/null || true

# 4. Install dependencies
cd api && npm install && cd ..

echo ""
echo "=== Setup Selesai ==="
echo ""
echo "Jalankan: node api/index.js"
echo "Buka:    http://localhost:3000"
echo ""
echo "Model: qwen2.5:14b (via Ollama - setara GPT-4o)"
echo "Note: Butuh ~9GB RAM/VRAM. Kalau kurang, ganti ke qwen2.5:7b"
echo "  di .env: OLLAMA_MODEL=qwen2.5:7b"
