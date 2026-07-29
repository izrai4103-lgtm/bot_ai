import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PUBLIC = join(ROOT, 'public');

// ============ PLAIN.JSON ============
// Vercel serverless: /tmp is the only writable directory
const PLAIN_TMP = '/tmp/bot_ai_plain.json';

function defaultPlain() {
  return {
    version: 1,
    learnings: [],
    knowledge: { bot_name: 'Chat AI', language: 'Bahasa Indonesia', platform: 'Groq AI' },
    preferences: {},
    stats: { total_conversations: 0, total_learnings: 0, last_updated: null }
  };
}

function loadPlain() {
  // Always read from /tmp (writable directory)
  try {
    if (existsSync(PLAIN_TMP)) {
      const data = JSON.parse(readFileSync(PLAIN_TMP, 'utf-8'));
      if (data && data.version) return data;
    }
  } catch {}
  return defaultPlain();
}

function savePlain(data) {
  try {
    writeFileSync(PLAIN_TMP, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Save plain error:', err.message);
  }
}

function addLearning(userMsg, aiMsg) {
  const plain = loadPlain();
  if (plain.learnings.length > 500) {
    plain.learnings = plain.learnings.slice(-250);
  }
  plain.learnings.push({
    id: Date.now().toString(),
    user_message: userMsg,
    ai_response: aiMsg,
    timestamp: new Date().toISOString()
  });
  plain.stats.total_learnings = plain.learnings.length;
  plain.stats.total_conversations++;
  plain.stats.last_updated = new Date().toISOString();
  savePlain(plain);
  return plain;
}

// ============ GROQ CLIENT ============
let groq;
async function getGroq() {
  if (groq) return groq;
  const { default: Groq } = await import('groq-sdk');
  groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return groq;
}

// ============ SERVER ============
export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  const method = req.method;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
  if (method === 'OPTIONS') return res.status(200).end();

  // Parse body for POST/PUT
  let body = {};
  if (['POST', 'PUT'].includes(method)) {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {}
  }

  try {
    // ============ OPEN WEBUI API ENDPOINTS ============
    
    // GET /api/v1/ - Config/status
    if (path === '/api/v1/' || path === '/api/' || path === '/api') {
      return res.json({
        status: true,
        _debug_plain_path: PLAIN_TMP,
        name: 'Bot AI',
        version: '1.0.0',
        default_locale: 'id-ID',
        default_models: 'qwen/qwen3.6-27b',
        default_prompt_suggestions: [
          { content: 'Apa kabar?', title: ['Sapa', 'Sapa bot'] },
          { content: 'Jelaskan AI dalam bahasa sederhana', title: ['Edukasi', 'Belajar AI'] },
          { content: 'Bantu saya menulis kode Python', title: ['Kode', 'Python'] }
        ],
        features: {
          auth: false,
          enable_signup: false,
          enable_login_form: false,
          enable_api_keys: false,
          enable_web_search: false,
          enable_image_generation: false,
          enable_admin_export: false,
          enable_admin_chat_access: false,
          enable_admin_analytics: false,
          enable_community_sharing: false,
          enable_memories: true,
          enable_plugins: false,
          enable_autocomplete_generation: false,
          enable_direct_connections: false,
          enable_version_update_check: false,
          enable_pyodide_file_persistence: false
        },
        oauth: { providers: {} },
        ui: {}
      });
    }

    // GET /api/v1/models or /api/models
    if (path === '/api/v1/models' || path === '/api/models') {
      const models = [
        { id: 'qwen/qwen3.6-27b', name: 'Qwen 3.6 27B', owned_by: 'groq', info: { capabilities: { vision: false, chat: true } } }
      ];
      return res.json({ data: models });
    }

    // GET /api/v1/auth/ - Auth status (no auth mode)
    if (path.startsWith('/api/v1/auth')) {
      if (path.endsWith('/')) {
        return res.json({ status: true, user: { id: 'local', name: 'User', email: 'user@local', role: 'admin', profile_image_url: '/static/user.png' } });
      }
      return res.json({ status: true });
    }

    // Open WebUI auth endpoints
    if (path === '/api/v1/auths/' || path === '/api/v1/auths') {
      return res.json({ status: true, user: { id: 'local', name: 'User', email: 'user@local', role: 'admin' } });
    }

    // GET /api/v1/chats/ - List chats
    if (path.startsWith('/api/v1/chats')) {
      if (method === 'GET') return res.json([]);
      if (method === 'POST') return res.json({ id: Date.now().toString(), ...body });
      if (path.includes('/config')) return res.json({});
      if (method === 'DELETE') return res.json({ status: true });
      return res.json({ status: true });
    }

    // GET /api/v1/memories/
    if (path === '/api/v1/memories/' || path === '/api/v1/memories') {
      const plain = loadPlain();
      return res.json({ data: plain.learnings.map(l => ({ id: l.id, content: l.user_message + ' -> ' + l.ai_response, created_at: l.timestamp })) });
    }

    // GET /api/v1/configs/
    if (path.startsWith('/api/v1/configs') || path.startsWith('/api/v1/config')) {
      return res.json({ status: true });
    }

    // GET /api/v1/knowledge/
    if (path.startsWith('/api/v1/knowledge')) return res.json({ data: [] });

    // GET /api/v1/tools/
    if (path.startsWith('/api/v1/tools')) return res.json({ data: [] });

    // GET /api/v1/functions/
    if (path.startsWith('/api/v1/functions')) return res.json({ data: [] });

    // GET /api/v1/prompts/
    if (path.startsWith('/api/v1/prompts')) return res.json({ data: [] });

    // GET /api/v1/folders/
    if (path.startsWith('/api/v1/folders')) return res.json({ data: [] });

    // GET /api/v1/tags/
    if (path.startsWith('/api/v1/tags')) return res.json({ data: [] });

    // GET /api/v1/users/
    if (path.startsWith('/api/v1/users')) return res.json({ data: [] });

    // GET /api/v1/groups/
    if (path.startsWith('/api/v1/groups')) return res.json({ data: [] });

    // GET /api/v1/files/
    if (path.startsWith('/api/v1/files')) return res.json({ data: [] });

    // ============ OPENAI COMPATIBLE ENDPOINTS ============
    
    // GET /openai/models - List Groq models
    if (path === '/openai/models') {
      return res.json({
        data: [
          { id: 'qwen/qwen3.6-27b', object: 'model', owned_by: 'groq' }
        ]
      });
    }

    // POST /openai/chat/completions - Chat completion via Groq
    // POST /api/chat/completions
    if ((path === '/openai/chat/completions' || path === '/api/chat/completions' || path === '/api/v1/chat/completions') && method === 'POST') {
      const client = await getGroq();
      const model = body.model || 'qwen/qwen3.6-27b';
      const messages = body.messages || [];
      const stream = body.stream !== false;

      // Add system message with plain.json knowledge
      const plain = loadPlain();
      const systemMsg = `Kamu adalah asisten AI yang cakap, langsung, dan efisien.

# Personality
Kamu adalah kolaborator yang capable: mudah didekati, steady, dan direct. Jawab dengan singkat, padat, dan langsung ke inti. Gunakan bahasa Indonesia yang alami dan mudah dipahami.

# Aturan Utama
- Jawaban harus SINGKAT dan PADAT — maksimal 3-4 paragraf, lebih baik 1-2 paragraf
- Langsung ke inti jawaban, tanpa basa-basi
- Karena kamu sudah melalui fase analisis dan rangkuman, langsung berikan HASIL AKHIR berupa rangkuman atau jawaban konkret
- Jangan menjelaskan proses berpikir
- Jangan mengulang pertanyaan user

# Konteks Bot
Nama: ${plain.knowledge.bot_name || 'Chat AI'}
Bahasa: ${plain.knowledge.language || 'Bahasa Indonesia'}

${plain.learnings.length > 0 ? '# Data Pembelajaran\n' + plain.learnings.slice(-20).map(l => `- User: ${l.user_message}\n  AI: ${l.ai_response}`).join('\n') : ''}

${body.system ? '\n### Instruksi Tambahan\n' + body.system : ''}\`;

      const fullMessages = [
        { role: 'system', content: systemMsg },
        ...messages
      ];

      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        try {
          const streamResp = await client.chat.completions.create({
            model,
            messages: fullMessages,
            stream: true,
            temperature: body.temperature || 0.7,
            max_tokens: body.max_tokens || 4096
          });

          let fullResponse = '';
          for await (const chunk of streamResp) {
            const content = chunk.choices[0]?.delta?.content || '';
            if (content) fullResponse += content;
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, index: 0 }] })}\n\n`);
          }

          // Save to plain.json
          const lastMsg = messages[messages.length - 1];
          if (lastMsg && fullResponse) {
            addLearning(lastMsg.content || '', fullResponse);
          }

          res.write(`data: [DONE]\n\n`);
          return res.end();
        } catch (err) {
          res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
          return res.end();
        }
      } else {
        try {
          const completion = await client.chat.completions.create({
            model,
            messages: fullMessages,
            stream: false,
            temperature: body.temperature || 0.7,
            max_tokens: body.max_tokens || 4096
          });

          const lastMsg = messages[messages.length - 1];
          const responseText = completion.choices[0]?.message?.content || '';
          if (lastMsg && responseText) {
            addLearning(lastMsg.content || '', responseText);
          }

          return res.json(completion);
        } catch (err) {
          return res.status(500).json({ error: err.message });
        }
      }
    }

    // ============ OPENAI CONFIG ============
    if (path === '/openai/config') {
      return res.json({ ENABLE_OPENAI_API: true, OPENAI_API_BASE_URLS: ['https://api.groq.com/openai/v1'], OPENAI_API_KEYS: [process.env.GROQ_API_KEY || ''], OPENAI_API_CONFIGS: {} });
    }

    // ============ CUSTOM CHAT API (for frontend) ============
    if (path === '/api/chat' && method === 'POST') {
      const client = await getGroq();
      const { message, model, system } = body;
      if (!message) return res.status(400).json({ error: 'Message required' });

      const plain = loadPlain();
      const contextPrompt = `Kamu adalah asisten AI yang cakap, langsung, dan efisien.

# Personality
Kamu adalah kolaborator yang capable: mudah didekati, steady, dan direct. Jawab dengan singkat, padat, dan langsung ke inti. Gunakan bahasa Indonesia yang alami dan mudah dipahami.

# Aturan Utama
- Jawaban harus SINGKAT dan PADAT — maksimal 3-4 paragraf, lebih baik 1-2 paragraf
- Langsung ke inti jawaban, tanpa basa-basi
- Karena kamu sudah melalui fase "menganalisis" dan "merangkum", langsung berikan HASIL AKHIR berupa rangkuman atau jawaban konkret
- Jangan menjelaskan proses berpikir atau bagaimana kamu sampai pada jawaban
- Jangan mengulang pertanyaan user
- Jika diminta kode, berikan kode langsung tanpa penjelasan panjang
- Jika diminta penjelasan, berikan intisari saja

# Konteks Bot
Nama: ${plain.knowledge.bot_name || 'Chat AI'}
Bahasa: ${plain.knowledge.language || 'Bahasa Indonesia'}

# Data Pembelajaran
${plain.learnings.slice(-20).map(l => `- User: ${l.user_message}\n  AI: ${l.ai_response}`).join('\n')}

${system ? '\n### Instruksi Tambahan\n' + system : ''}\`;

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      try {
        const streamResp = await client.chat.completions.create({
          model: model || 'qwen/qwen3.6-27b',
          messages: [
            { role: 'system', content: contextPrompt },
            { role: 'user', content: message }
          ],
          stream: true,
          temperature: 0.7,
          max_tokens: 4096
        });

        let fullResponse = '';
        for await (const chunk of streamResp) {
          const content = chunk.choices[0]?.delta?.content || '';
          if (content) fullResponse += content;
          res.write(`data: ${JSON.stringify({ content })}\n\n`);
        }

        if (fullResponse) {
          addLearning(message, fullResponse);
        }

        res.write(`data: [DONE]\n\n`);
        return res.end();
      } catch (err) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        return res.end();
      }
    }

    // ============ PLAIN.JSON MANAGEMENT ============
    if (path === '/api/plain') {
      const plain = loadPlain();
      if (method === 'GET') return res.json(plain);
      if (method === 'POST') {
        if (body.action === 'reset') {
          savePlain({ version: 1, learnings: [], knowledge: plain.knowledge, preferences: {}, stats: { total_conversations: 0, total_learnings: 0, last_updated: null } });
          return res.json({ status: 'reset' });
        }
        if (body.action === 'update_knowledge') {
          plain.knowledge = { ...plain.knowledge, ...body.knowledge };
          savePlain(plain);
          return res.json(plain);
        }
        return res.json(plain);
      }
      return res.json(plain);
    }

    // ============ STATIC FILES FROM OPEN WEBUI ============
    if (path.startsWith('/static/')) {
      const filePath = join(ROOT, 'static', path.replace('/static/', ''));
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        const ext = extname(filePath);
        const mime = {
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.svg': 'image/svg+xml',
          '.ico': 'image/x-icon',
          '.webp': 'image/webp',
          '.json': 'application/json',
          '.xml': 'application/xml',
          '.txt': 'text/plain',
          '.html': 'text/html'
        }[ext] || 'application/octet-stream';
        const content = readFileSync(filePath);
        res.setHeader('Content-Type', mime);
        res.setHeader('Cache-Control', 'public, max-age=31536000');
        return res.end(content);
      }
    }

    // ============ DEBUG ============
    if (path === '/api/debug') {
      return res.json({
        plain_path: PLAIN_TMP,
        root: ROOT,
        exists_tmp: existsSync(PLAIN_TMP),
        node_version: process.version,
        deploy_time: new Date().toISOString()
      });
    }

    // ============ FAVICON ============
    if (path === '/favicon.ico') {
      try {
        const icon = readFileSync(join(ROOT, 'static', 'favicon.ico'));
        res.setHeader('Content-Type', 'image/x-icon');
        return res.end(icon);
      } catch {
        return res.status(404).end();
      }
    }

    // ============ FRONTEND - ChatGPT UI ============
    // Serve the frontend HTML for root and all non-matching routes
    const PUBLIC_DIR = join(ROOT, 'public');
    const htmlPath = join(PUBLIC_DIR, 'index.html');
    
    if (existsSync(htmlPath)) {
      const html = readFileSync(htmlPath, 'utf-8');
      res.setHeader('Content-Type', 'text/html');
      return res.end(html);
    }

    // Fallback 404
    return res.status(404).json({ error: 'Not found', path });
  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// force rebuild 1785301524
