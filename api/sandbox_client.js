/**
 * AI Sandbox Client — Node.js implementation of AISandbox pattern.
 * Memanggil Groq API langsung tanpa perlu Python server.
 * Fungsi: logging, stats, error handling, think tag filtering.
 */

const SANDBOX_URL = process.env.SANDBOX_URL || null;
const FALLBACK_ENABLED = process.env.SANDBOX_FALLBACK !== 'false';

let groqInstance = null;

async function getGroq() {
  if (groqInstance) return groqInstance;
  const { default: Groq } = await import('groq-sdk');
  groqInstance = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return groqInstance;
}

// Stats
const stats = { total_requests: 0, total_tokens: 0, errors: 0, last_request: null };

/**
 * Chat non-streaming via Sandbox (Groq SDK langsung).
 */
export async function sandboxChat({ prompt, history, model, temperature, maxTokens, system }) {
  // Try external Python sandbox if URL configured
  if (SANDBOX_URL) {
    try {
      const resp = await fetch(`${SANDBOX_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, history, model, temperature, maxTokens, system }),
        signal: AbortSignal.timeout(30000),
      });
      if (resp.ok) {
        const data = await resp.json();
        return data.content;
      }
    } catch (err) {
      console.error('Sandbox server error:', err.message);
      if (!FALLBACK_ENABLED) throw err;
    }
  }

  // === DIRECT GROQ (Sandbox mode) ===
  const client = await getGroq();
  stats.total_requests++;
  stats.last_request = Date.now();

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  if (history) messages.push(...history);
  messages.push({ role: 'user', content: prompt });

  try {
    const completion = await client.chat.completions.create({
      model: model || 'qwen/qwen3.6-27b',
      messages,
      temperature: temperature || 0.7,
      max_tokens: maxTokens || 4096,
      stream: false,
    });
    const text = completion.choices[0]?.message?.content || '';
    stats.total_tokens += completion.usage?.total_tokens || 0;
    return text;
  } catch (err) {
    stats.errors++;
    throw err;
  }
}

/**
 * Chat streaming via Sandbox (Groq SDK langsung).
 */
export async function* sandboxChatStream({ prompt, history, model, temperature, maxTokens, system }) {
  // Try external Python sandbox if URL configured
  if (SANDBOX_URL) {
    try {
      const resp = await fetch(`${SANDBOX_URL}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, history, model, temperature, maxTokens, system }),
        signal: AbortSignal.timeout(60000),
      });
      if (resp.ok) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) { yield { content: '', done: true }; return; }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.content) yield { content: data.content, done: false };
                if (data.error) yield { content: `\n\n[Sandbox Error: ${data.error}]`, done: false };
              } catch {}
            }
          }
        }
      }
    } catch (err) {
      console.error('Sandbox stream error:', err.message);
      if (!FALLBACK_ENABLED) throw err;
    }
  }

  // === DIRECT GROQ STREAM (Sandbox mode) ===
  const client = await getGroq();
  stats.total_requests++;
  stats.last_request = Date.now();

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  if (history) messages.push(...history);
  messages.push({ role: 'user', content: prompt });

  try {
    const stream = await client.chat.completions.create({
      model: model || 'qwen/qwen3.6-27b',
      messages,
      temperature: temperature || 0.7,
      max_tokens: maxTokens || 4096,
      stream: true,
    });
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) yield { content, done: false };
    }
    yield { content: '', done: true };
  } catch (err) {
    stats.errors++;
    throw err;
  }
}

export async function checkSandbox() {
  if (!SANDBOX_URL) return false;
  try {
    const resp = await fetch(`${SANDBOX_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return resp.ok;
  } catch { return false; }
}

export default { sandboxChat, sandboxChatStream, checkSandbox };
