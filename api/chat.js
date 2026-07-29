import Groq from 'groq-sdk';

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { message, history = [] } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    const messages = [
      { role: 'system', content: 'Kamu adalah asisten AI yang ramah dan membantu. Gunakan bahasa Indonesia. Jawab dengan singkat dan jelas.' },
      ...history,
      { role: 'user', content: message },
    ];

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages,
      temperature: 0.7,
      max_tokens: 1024,
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
