/**
 * Sandbox Client — Node.js client untuk AI Sandbox Qwen (Python microservice).
 * Jika sandbox server tidak tersedia, fallback ke Groq SDK langsung.
 */

const SANDBOX_URL = process.env.SANDBOX_URL || 'http://localhost:8000';
const FALLBACK_ENABLED = process.env.SANDBOX_FALLBACK !== 'false';

let groqClient = null;

async function getGroqClient() {
  if (groqClient) return groqClient;
  const { default: Groq } = await import('groq-sdk');
  groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return groqClient;
}

/**
 * Cek apakah sandbox server hidup.
 */
export async function checkSandbox() {
  try {
    const resp = await fetch(`${SANDBOX_URL}/health`, { 
      signal: AbortSignal.timeout(3000) 
    });
    if (resp.ok) {
      const data = await resp.json();
      return data.status === 'ok';
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Chat non-streaming via sandbox (dengan fallback ke Groq SDK).
 */
export async function sandboxChat({ prompt, history, model, temperature, maxTokens, system }) {
  const sandboxAlive = await checkSandbox();
  
  if (sandboxAlive) {
    try {
      const resp = await fetch(`${SANDBOX_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          history: history || [],
          model: model || 'qwen/qwen3.6-27b',
          temperature: temperature || 0.7,
          max_tokens: maxTokens || 4096,
          system: system || null,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!resp.ok) throw new Error(`Sandbox HTTP ${resp.status}`);
      const data = await resp.json();
      return data.content;
    } catch (err) {
      console.error('Sandbox chat error:', err.message);
      if (!FALLBACK_ENABLED) throw err;
      // Fallback to Groq SDK
    }
  }
  
  // Fallback: Groq SDK langsung
  const client = await getGroqClient();
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  if (history) messages.push(...history);
  messages.push({ role: 'user', content: prompt });
  
  const completion = await client.chat.completions.create({
    model: model || 'qwen/qwen3.6-27b',
    messages,
    temperature: temperature || 0.7,
    max_tokens: maxTokens || 4096,
    stream: false,
  });
  
  return completion.choices[0]?.message?.content || '';
}

/**
 * Chat streaming via sandbox (dengan fallback ke Groq SDK).
 * Mengembalikan async generator yang yield { content, done }.
 */
export async function* sandboxChatStream({ prompt, history, model, temperature, maxTokens, system }) {
  const sandboxAlive = await checkSandbox();
  
  if (sandboxAlive) {
    try {
      const resp = await fetch(`${SANDBOX_URL}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          history: history || [],
          model: model || 'qwen/qwen3.6-27b',
          temperature: temperature || 0.7,
          max_tokens: maxTokens || 4096,
          system: system || null,
        }),
        signal: AbortSignal.timeout(60000),
      });
      
      if (!resp.ok) throw new Error(`Sandbox HTTP ${resp.status}`);
      
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          yield { content: '', done: true };
          return;
        }
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.startsWith('event: ')) continue;
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6);
            try {
              const data = JSON.parse(dataStr);
              if (data.content) {
                yield { content: data.content, done: false };
              }
              if (data.error) {
                yield { content: `\n\n[Sandbox Error: ${data.error}]`, done: false };
              }
            } catch {}
          }
        }
      }
    } catch (err) {
      console.error('Sandbox stream error:', err.message);
      if (!FALLBACK_ENABLED) throw err;
      // Fallback to Groq SDK
    }
  }
  
  // Fallback: Groq SDK streaming
  const client = await getGroqClient();
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  if (history) messages.push(...history);
  messages.push({ role: 'user', content: prompt });
  
  const stream = await client.chat.completions.create({
    model: model || 'qwen/qwen3.6-27b',
    messages,
    temperature: temperature || 0.7,
    max_tokens: maxTokens || 4096,
    stream: true,
  });
  
  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content || '';
    if (content) {
      yield { content, done: false };
    }
  }
  yield { content: '', done: true };
}

export default { sandboxChat, sandboxChatStream, checkSandbox };
