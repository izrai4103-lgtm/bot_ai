import Groq from 'groq-sdk';

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { message, history = [], stream = false } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  const messages = [
    {
      role: 'system',
      content: 'Anda adalah asisten AI yang cerdas dan membantu. Gunakan bahasa Indonesia. Berikan jawaban yang informatif, terstruktur, dan mendalam. Gunakan format markdown untuk kode, tabel, atau daftar agar mudah dibaca.'
    },
    ...history.slice(-20),
    { role: 'user', content: message },
  ];

  // Streaming mode (SSE)
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    try {
      const streamResp = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages,
        temperature: 0.7,
        max_tokens: 2048,
        stream: true,
      });

      let fullContent = '';
      for await (const chunk of streamResp) {
        const content = chunk.choices[0]?.delta?.content || '';
        fullContent += content;
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }

      res.write(`data: ${JSON.stringify({ done: true, fullContent })}\n\n`);
      res.end();
    } catch (error) {
      console.error('Groq stream error:', error);
      res.write(`data: ${JSON.stringify({ error: 'Terjadi kesalahan saat memproses pesan.' })}\n\n`);
      res.end();
    }
    return;
  }

  // Non-streaming mode (fallback)
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages,
      temperature: 0.7,
      max_tokens: 2048,
    });

    const reply = completion.choices[0]?.message?.content || 'Maaf, saya tidak bisa merespons saat ini.';

    res.status(200).json({
      reply,
      usage: completion.usage,
    });
  } catch (error) {
    console.error('Groq API error:', error);
    res.status(500).json({ error: 'Terjadi kesalahan saat memproses pesan.' });
  }
}
