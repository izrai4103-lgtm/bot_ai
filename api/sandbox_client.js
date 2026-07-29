/**
 * AI Sandbox Client — Node.js implementation for ELENA AI.
 * Menggunakan Google Gemini API sebagai model utama.
 * Support: chat & streaming, fallback models, stats.
 */

const GEMINI_API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Stats
const stats = { total_requests: 0, total_tokens: 0, errors: 0, last_request: null };

function buildGeminiMessages({ prompt, history, system }) {
  const contents = [];
  if (history) {
    for (const msg of history) {
      if (msg.role === 'assistant') contents.push({ role: 'model', parts: [{ text: msg.content }] });
      else if (msg.role === 'user') contents.push({ role: 'user', parts: [{ text: msg.content }] });
    }
  }
  contents.push({ role: 'user', parts: [{ text: prompt }] });
  
  const systemInstruction = system ? { parts: [{ text: system }] } : undefined;
  return { contents, systemInstruction };
}

async function geminiFetch(url, body, timeout = 60000) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Gemini HTTP ${resp.status}: ${errText.slice(0, 200)}`);
  }
  return resp;
}

// ============ CHAT (non-streaming) ============
export async function sandboxChat({ prompt, history, model, temperature, maxTokens, system }) {
  stats.total_requests++;
  stats.last_request = Date.now();

  const { contents, systemInstruction } = buildGeminiMessages({ prompt, history, system });
  const url = `${GEMINI_API_BASE}/${model || GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  try {
    const resp = await geminiFetch(url, {
      contents,
      systemInstruction,
      generationConfig: {
        temperature: temperature || 0.7,
        maxOutputTokens: maxTokens || 4096,
      },
    });
    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (data.usageMetadata) {
      stats.total_tokens += (data.usageMetadata.promptTokenCount || 0) + (data.usageMetadata.candidatesTokenCount || 0);
    }
    return text;
  } catch (err) {
    stats.errors++;
    throw err;
  }
}

// ============ CHAT STREAM ============
export async function* sandboxChatStream({ prompt, history, model, temperature, maxTokens, system }) {
  stats.total_requests++;
  stats.last_request = Date.now();

  const { contents, systemInstruction } = buildGeminiMessages({ prompt, history, system });
  const url = `${GEMINI_API_BASE}/${model || GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`;

  try {
    const resp = await geminiFetch(url, {
      contents,
      systemInstruction,
      generationConfig: {
        temperature: temperature || 0.7,
        maxOutputTokens: maxTokens || 4096,
      },
    }, 120000);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim() || line.startsWith(':')) continue;
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (text) yield { content: text, done: false };
          } catch {}
        }
      }
    }
    yield { content: '', done: true };
  } catch (err) {
    stats.errors++;
    yield { content: `\n\n⚠️ Error AI: ${err.message}`, done: false };
    yield { content: '', done: true };
  }
}

export async function checkSandbox() {
  return !!GEMINI_API_KEY;
}

export { stats };
export default { sandboxChat, sandboxChatStream, checkSandbox };
