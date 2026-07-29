#!/bin/bash
# Setup Local AI Bot dengan Ollama + Qwen
echo "=== Setup Local AI Bot ==="

# 1. Install Ollama
if ! command -v ollama &> /dev/null; then
    echo "Menginstall Ollama..."
    curl -fsSL https://ollama.com/install.sh | bash
fi

# 2. Pull Qwen model (size ~4-8GB)
echo "Download Qwen model (pertama kali butuh waktu lama)..."
ollama pull qwen2.5:7b

# 3. Setup .env
cp .env.example .env
sed -i 's/USE_LOCAL_MODEL=false/USE_LOCAL_MODEL=true/' .env

# 4. Install Node.js dependencies
cd api && npm install && cd ..

# 5. Jalankan
echo ""
echo "=== Setup Selesai ==="
echo "Jalankan bot: node api/index.js"
echo "Buka: http://localhost:3000"
echo ""
echo "(Pertama kali Ollama butuh waktu loading model)"
