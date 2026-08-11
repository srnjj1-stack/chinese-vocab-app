require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const AUDIO_DIR = path.join(__dirname, 'audio_cache');
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json');
const GEMINI_MODEL = 'gemini-flash-latest';

for (const dir of [DATA_DIR, AUDIO_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
if (!fs.existsSync(LIBRARY_FILE)) fs.writeFileSync(LIBRARY_FILE, '[]', 'utf8');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('이미지 파일만 업로드할 수 있습니다.'));
  },
});

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/audio', express.static(AUDIO_DIR));

// ---------- helpers ----------

function readLibrary() {
  try {
    return JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeLibrary(list) {
  fs.writeFileSync(LIBRARY_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function extractJsonArray(text) {
  let s = text.trim();
  s = s.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('JSON 배열을 찾을 수 없습니다.');
  return JSON.parse(s.slice(start, end + 1));
}

const ANALYZE_SYSTEM_PROMPT = `당신은 중국어 학습 자료를 구조화된 JSON으로 변환하는 도우미입니다.
입력(텍스트 또는 사진 속 텍스트)에는 중국어 단어, 그 단어의 한국어 뜻, 그리고 선택적으로 그 단어를 사용한 중국어 예문이 포함되어 있습니다.

각 단어 항목을 분석해서 아래 필드를 가진 JSON 배열로만 응답하세요. 설명이나 마크다운 코드블록 없이 순수 JSON 배열만 출력하세요.

[
  {
    "word": "중국어 단어",
    "pinyin": "한어병음(성조 포함)",
    "meaning": "한국어 뜻",
    "example": "중국어 예문 (없으면 빈 문자열)",
    "exampleTranslation": "예문의 자연스러운 한국어 번역 (예문이 없으면 빈 문자열)"
  }
]

규칙:
- 입력에 이미 한국어 뜻이 쓰여 있으면 그대로 사용하되 자연스럽게 다듬어도 됩니다. 없으면 정확한 한국어 뜻을 채우세요.
- 예문이 있는 경우에만 example과 exampleTranslation을 채우고, 예문이 없으면 둘 다 빈 문자열("")로 두세요. 예문이 없는데 지어내지 마세요.
- 사진에서 글자를 인식할 때 오탈자가 없도록 신중하게 확인하세요.
- 사진이 여러 장 주어질 수 있습니다. 모든 사진에 나온 단어를 순서대로 하나의 JSON 배열로 합쳐서 반환하세요.
- 입력에 여러 단어가 있으면 각각을 배열의 별도 원소로 만드세요.
- 매우 중요: 한 줄이나 한 항목 안에 한자 표기가 다른 단어가 "/", "、", "|", 쉼표, 괄호, 파생어·관련어 나열 등의 형태로 여러 개 함께 나와도, 한자 표기가 다르면 반드시 각각 독립된 배열 원소로 분리하세요. 예를 들어 "饭盒 도시락 (保温饭盒 보온 도시락 / 一次性饭盒 1회용 도시락)" 같은 입력은 饭盒, 保温饭盒, 一次性饭盒 을 각각 별도 항목 3개로 만들어야 합니다. "剩 남다 (过剩 과잉, 剩余 나머지)"도 剩, 过剩, 剩余 3개의 별도 항목으로 만드세요.
- 절대로 하나의 word 필드나 meaning 필드 안에 다른 한자 표기의 단어·병음·뜻을 함께 욱여넣지 마세요. 화면에 보이는 모든 서로 다른 한자 표기는 각자 하나의 독립된 배열 원소가 되어야 합니다.`;

async function callGemini(parts) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY 가 설정되지 않았습니다.');

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: ANALYZE_SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    }
  );

  if (!res.ok) {
    const errBody = await res.json().catch(() => null);
    throw new Error(`Gemini 요청 실패 (${res.status}): ${errBody?.error?.message || res.statusText}`);
  }

  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  return extractJsonArray(text);
}

async function analyzeText(rawText) {
  return callGemini([{ text: `다음 텍스트를 분석해줘:\n\n${rawText}` }]);
}

async function analyzeImages(files) {
  const imageParts = files.map((f) => ({
    inline_data: { mime_type: f.mimetype, data: f.buffer.toString('base64') },
  }));
  const promptText =
    files.length > 1
      ? `이 ${files.length}장의 사진 속 중국어 단어 학습 내용을 분석해줘. 모든 사진의 내용을 순서대로 하나의 JSON 배열로 합쳐서 줘.`
      : '이 사진 속 중국어 단어 학습 내용을 분석해줘.';

  return callGemini([...imageParts, { text: promptText }]);
}

async function synthesizeSpeech(text, voice) {
  const key = process.env.GOOGLE_TTS_API_KEY;
  if (!key) throw new Error('GOOGLE_TTS_API_KEY 가 설정되지 않았습니다.');

  const hash = crypto.createHash('sha256').update(`${voice}::${text}`).digest('hex');
  const filename = `${hash}.mp3`;
  const filepath = path.join(AUDIO_DIR, filename);

  if (fs.existsSync(filepath)) return filename;

  const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: 'cmn-CN', name: voice },
      audioConfig: { audioEncoding: 'MP3' },
    }),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => null);
    throw new Error(`Google TTS 요청 실패 (${res.status}): ${errBody?.error?.message || res.statusText}`);
  }

  const data = await res.json();
  fs.writeFileSync(filepath, Buffer.from(data.audioContent, 'base64'));
  return filename;
}

function requireGemini(res) {
  if (!process.env.GEMINI_API_KEY) {
    res.status(500).json({ error: 'GEMINI_API_KEY 가 .env 에 설정되지 않았습니다.' });
    return false;
  }
  return true;
}

// ---------- routes ----------

app.post('/api/analyze/text', async (req, res) => {
  if (!requireGemini(res)) return;
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: '분석할 텍스트가 없습니다.' });
    const entries = await analyzeText(text);
    res.json({ entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/analyze/image', upload.array('images', 10), async (req, res) => {
  if (!requireGemini(res)) return;
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: '이미지 파일이 없습니다.' });
    const entries = await analyzeImages(req.files);
    res.json({ entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tts', async (req, res) => {
  try {
    const { text, voice } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: '읽을 텍스트가 없습니다.' });
    const filename = await synthesizeSpeech(text, voice || 'cmn-CN-Wavenet-A');
    res.json({ url: `/audio/${filename}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/library', (req, res) => {
  const list = readLibrary()
    .map(({ id, title, createdAt, entries }) => ({ id, title, createdAt, count: entries.length }))
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json({ items: list });
});

app.get('/api/library/:id', (req, res) => {
  const item = readLibrary().find((x) => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: '찾을 수 없습니다.' });
  res.json(item);
});

app.post('/api/library', (req, res) => {
  const { title, entries } = req.body;
  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: '저장할 항목이 없습니다.' });
  }
  const list = readLibrary();
  const record = {
    id: crypto.randomUUID(),
    title: title && title.trim() ? title.trim() : `저장 ${new Date().toLocaleString('ko-KR')}`,
    createdAt: Date.now(),
    entries,
  };
  list.push(record);
  writeLibrary(list);
  res.json(record);
});

app.delete('/api/library/:id', (req, res) => {
  const list = readLibrary();
  const next = list.filter((x) => x.id !== req.params.id);
  if (next.length === list.length) return res.status(404).json({ error: '찾을 수 없습니다.' });
  writeLibrary(next);
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_COUNT' ? '사진은 최대 10장까지 한 번에 올릴 수 있습니다.' : err.message;
    return res.status(400).json({ error: msg });
  }
  if (err) return res.status(400).json({ error: err.message });
  next();
});

app.listen(PORT, () => {
  console.log(`중국어 단어 학습 앱 실행 중: http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) console.log('⚠ GEMINI_API_KEY 가 없습니다. .env 파일을 확인하세요.');
  if (!process.env.GOOGLE_TTS_API_KEY) console.log('⚠ GOOGLE_TTS_API_KEY 가 없습니다. .env 파일을 확인하세요.');
});
