import Groq from 'groq-sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAIN_PATH = join(__dirname, '..', 'plain.json');
const GITHUB_REPO = 'izrai4103-lgtm/bot_ai';

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// Get GitHub token from env or gh CLI
function getGitHubToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    return execSync('gh auth token', { encoding: 'utf-8', timeout: 5000 }).trim();
  } catch (e) {
    return '';
  }
}

// ============ PLAIN.JSON: Memory & Learning System ============

function loadPlain() {
  try {
    if (existsSync(PLAIN_PATH)) {
      return JSON.parse(readFileSync(PLAIN_PATH, 'utf-8'));
    }
  } catch (e) {
    console.error('plain.json load error:', e.message);
  }
  return {
    version: 1,
    created: new Date().toISOString().split('T')[0],
    learnings: [],
    knowledge: {},
    preferences: {},
    stats: { total_conversations: 0, total_learnings: 0, last_updated: null }
  };
}

function savePlain(data) {
  try {
    data.stats.last_updated = new Date().toISOString();
    writeFileSync(PLAIN_PATH, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('plain.json save error:', e.message);
    return false;
  }
}

// Push to GitHub via API
async function pushToGitHub(data) {
  const token = getGitHubToken();
  if (!token) return false;
  try {
    const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
    const getRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/plain.json`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' }
    });
    const existing = await getRes.json();
    const sha = existing.sha || '';

    const date = new Date().toISOString().split('T')[0];
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/plain.json`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github.v3+json'
      },
      body: JSON.stringify({
        message: `auto: update plain.json [${date}]`,
        content,
        sha: sha || undefined,
        branch: 'main',
      })
    });
    return res.ok;
  } catch (e) {
    console.error('GitHub push error:', e.message);
    return false;
  }
}

// Extract learnings from conversation using AI
async function extractLearnings(conversation, currentLearnings) {
  try {
    const existingJSON = JSON.stringify(currentLearnings.slice(-20));
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `Kamu adalah sistem ekstraksi pembelajaran dari percakapan.
Tugasmu: analisis percakapan ini dan extract hal-hal baru yang layak dipelajari.

Yang perlu diekstrak:
1. about_user: info pribadi tentang user (nama, hobi, pekerjaan, dll)
2. ai_taught: konsep/penjelasan penting yang AI ajarkan ke user
3. insight: wawasan menarik dari diskusi
4. preference: preferensi user (gaya coding, topik favorit, dll)

Existing learnings (jangan duplikat): ${existingJSON}

Return JSON array saja, tanpa markdown:
[{"type":"about_user|ai_taught|insight|preference","topic":"...","detail":"..."}]

Jika tidak ada yang baru, return []`
        },
        { role: 'user', content: conversation }
      ],
      temperature: 0.3,
      max_tokens: 1000,
    });

    const text = completion.choices[0]?.message?.content || '[]';
    const cleaned = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

// Build system prompt with learnings
function buildSystemPrompt(plain) {
  const learnings = plain.learnings || [];
  const knowledge = plain.knowledge || {};
  const prefs = plain.preferences || {};

  let ctx = '';

  // User preferences
  const prefKeys = Object.keys(prefs);
  if (prefKeys.length > 0) {
    ctx += '\n# Preferensi User:\n';
    prefKeys.forEach(k => { ctx += `- ${k}: ${prefs[k]}\n`; });
  }

  // Recent learnings
  const recent = learnings.slice(-15);
  if (recent.length > 0) {
    ctx += '\n# Yang saya pelajari:\n';
    recent.forEach(l => { ctx += `- ${l.topic}: ${l.detail}\n`; });
  }

  // Knowledge base
  const kTop = Object.keys(knowledge).slice(-5);
  if (kTop.length > 0) {
    ctx += '\n# Pengetahuan:\n';
    kTop.forEach(t => { ctx += `- ${t}: ${knowledge[t]}\n`; });
  }

  return `Kamu adalah asisten AI cerdas yang terus belajar dari setiap percakapan.

# Personality
Bantu user dengan sabar, respek, dan praktis. Gunakan bahasa Indonesia yang alami.
Jawab tepat sasaran. Gunakan markdown untuk kode/tabel/daftar.

# Memory
Kamu bisa mengingat informasi dari percakapan sebelumnya. Gunakan pengetahuan yang sudah kamu kumpulkan untuk memberikan jawaban yang lebih personal dan relevan.${ctx}

# Belajar
Setiap percakapan adalah kesempatan belajar. Perhatikan preferensi user, pelajari hal baru, dan gunakan pengetahuan itu di masa depan.`;
}

// ============ API HANDLER ============

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { message, history = [], stream = false } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  // Load & update plain.json
  const plain = loadPlain();
  plain.stats.total_conversations = (plain.stats.total_conversations || 0) + 1;

  const systemPrompt = buildSystemPrompt(plain);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-30),
    { role: 'user', content: message },
  ];

  // === STREAMING ===
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    try {
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
        const delta = chunk.choices[0]?.delta?.content || '';
        fullContent += delta;
        if (delta) {
          res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
        }
      }

      // Async learning extraction (fire & forget)
      const convText = history.map(h => `${h.role}: ${h.content}`).join('\n')
        + `\nuser: ${message}\nassistant: ${fullContent}`;

      extractLearnings(convText, plain.learnings).then(newL => {
        if (newL.length > 0) {
          plain.learnings = plain.learnings.concat(newL);
          plain.stats.total_learnings = (plain.stats.total_learnings || 0) + newL.length;
          savePlain(plain);
          pushToGitHub(plain);
        }
      });

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (error) {
      console.error('Groq stream error:', error);
      res.write(`data: ${JSON.stringify({ error: 'Maaf, terjadi kesalahan.' })}\n\n`);
      res.end();
    }
    return;
  }

  // === NON-STREAMING ===
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages,
      temperature: 0.7,
      max_tokens: 4096,
    });

    const reply = completion.choices[0]?.message?.content || 'Maaf, saya tidak bisa merespons.';

    // Async learning
    const convText = history.map(h => `${h.role}: ${h.content}`).join('\n')
      + `\nuser: ${message}\nassistant: ${reply}`;

    extractLearnings(convText, plain.learnings).then(newL => {
      if (newL.length > 0) {
        plain.learnings = plain.learnings.concat(newL);
        plain.stats.total_learnings = (plain.stats.total_learnings || 0) + newL.length;
        savePlain(plain);
        pushToGitHub(plain);
      }
    });

    res.status(200).json({ reply, usage: completion.usage });
  } catch (error) {
    console.error('Groq API error:', error);
    res.status(500).json({ error: 'Maaf, terjadi kesalahan.' });
  }
}
