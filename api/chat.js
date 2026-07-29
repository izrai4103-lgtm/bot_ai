import Groq from 'groq-sdk';
import { execSync } from 'child_process';

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// System prompt engineered from OpenAI prompting guide principles
const SYSTEM_PROMPT = `Kamu adalah asisten AI yang cerdas, membantu, dan efisien — bertenaga Groq Llama 3.3 70B.

# Personality
Kamu adalah kolaborator yang capable: approachable, steady, dan direct. Bantu user dengan sabar, respek, dan praktis. Gunakan bahasa Indonesia yang alami dan mudah dipahami.

# Gaya
- Jawab tepat sasaran, tidak bertele-tele. Beri konteks yang cukup lalu berhenti.
- Gunakan markdown untuk kode, tabel, atau daftar agar jawaban terstruktur.
- Prioritaskan kemajuan: jika perintah sudah cukup jelas, langsung kerjakan tanpa minta klarifikasi.
- Jika tidak yakin, gunakan asumsi yang masuk akal dan lanjutkan.
- Jika user mengoreksi, akui kesalahan dengan jujur dan langsung perbaiki.

# Tools
Kamu punya akses ke tool/system calls. Untuk tugas seperti lihat file, cari kode, jalankan perintah — sampaikan ke user untuk menggunakan CLI atau fitur yang sesuai.`;

// Composio tool execution
async function composioTool(toolName, params) {
  try {
    const result = execSync(
      `composio execute ${toolName} -d '${JSON.stringify(params)}' --skip-connection-check 2>/dev/null`,
      { timeout: 15000, encoding: 'utf-8' }
    );
    try {
      return JSON.parse(result);
    } catch {
      return { output: result.trim() };
    }
  } catch (e) {
    return { error: e.message || 'Tool execution failed' };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { message, history = [], stream = false } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.slice(-30),
    { role: 'user', content: message },
  ];

  // Streaming mode (SSE like OpenAI Responses API)
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    try {
      // Send preamble for perceived responsiveness (OpenAI best practice)
      res.write(`data: ${JSON.stringify({ content: '', preamble: true })}\n\n`);

      const streamResp = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages,
        temperature: 0.7,
        max_tokens: 4096,
        stream: true,
      });

      let fullContent = '';
      for await (const chunk of streamResp) {
        const content = chunk.choices[0]?.delta?.content || '';
        fullContent += content;
        if (content) {
          res.write(`data: ${JSON.stringify({ content })}\n\n`);
        }
      }

      res.write(`data: ${JSON.stringify({ done: true, fullContent })}\n\n`);
      res.end();
    } catch (error) {
      console.error('Groq stream error:', error);
      res.write(`data: ${JSON.stringify({ error: 'Maaf, terjadi kesalahan. Silakan coba lagi.' })}\n\n`);
      res.end();
    }
    return;
  }

  // Non-streaming mode
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages,
      temperature: 0.7,
      max_tokens: 4096,
    });

    const reply = completion.choices[0]?.message?.content || 'Maaf, saya tidak bisa merespons saat ini.';

    res.status(200).json({
      reply,
      usage: completion.usage,
    });
  } catch (error) {
    console.error('Groq API error:', error);
    res.status(500).json({ error: 'Maaf, terjadi kesalahan. Silakan coba lagi.' });
  }
}
