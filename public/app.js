// ---------- local storage ----------

const LS_GEMINI_KEY = 'zhVocab.geminiKey';
const LS_TTS_KEY = 'zhVocab.ttsKey';
const LS_LIBRARY = 'zhVocab.library';
const LS_MIGRATED = 'zhVocab.migratedSeed';

function getGeminiKey() {
  return localStorage.getItem(LS_GEMINI_KEY) || '';
}
function getTtsKey() {
  return localStorage.getItem(LS_TTS_KEY) || '';
}
function setKeys(geminiKey, ttsKey) {
  localStorage.setItem(LS_GEMINI_KEY, geminiKey);
  localStorage.setItem(LS_TTS_KEY, ttsKey);
}

function readLibrary() {
  try {
    return JSON.parse(localStorage.getItem(LS_LIBRARY)) || [];
  } catch {
    return [];
  }
}
function writeLibrary(list) {
  localStorage.setItem(LS_LIBRARY, JSON.stringify(list));
}

// One-time import of the word lists this app previously saved server-side,
// so switching to browser-only storage doesn't lose them. Never overwrites
// anything the user has already saved locally.
async function migrateSeedLibrary() {
  if (localStorage.getItem(LS_MIGRATED)) return;
  localStorage.setItem(LS_MIGRATED, '1');
  if (readLibrary().length > 0) return;
  try {
    const res = await fetch('seed-library.json');
    if (!res.ok) return;
    const seed = await res.json();
    if (Array.isArray(seed) && seed.length) writeLibrary(seed);
  } catch {
    // no seed file, nothing to migrate
  }
}

function getLibraryItems() {
  return readLibrary()
    .map(({ id, title, createdAt, entries }) => ({ id, title, createdAt, count: entries.length }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function libraryGet(id) {
  return readLibrary().find((x) => x.id === id) || null;
}

function librarySave({ id, title, entries }) {
  const list = readLibrary();

  if (id) {
    const idx = list.findIndex((x) => x.id === id);
    if (idx === -1) throw new Error('단어장을 찾을 수 없습니다.');
    const existingWords = new Set(list[idx].entries.map((e) => e.word));
    const toAdd = entries.filter((e) => !existingWords.has(e.word));
    list[idx].entries = list[idx].entries.concat(toAdd);
    writeLibrary(list);
    return { ...list[idx], added: toAdd.length, skipped: entries.length - toAdd.length };
  }

  const record = {
    id: crypto.randomUUID(),
    title: title && title.trim() ? title.trim() : `저장 ${new Date().toLocaleString('ko-KR')}`,
    createdAt: Date.now(),
    entries,
  };
  list.push(record);
  writeLibrary(list);
  return { ...record, added: entries.length, skipped: 0 };
}

function libraryDelete(id) {
  const list = readLibrary();
  const next = list.filter((x) => x.id !== id);
  if (next.length === list.length) throw new Error('찾을 수 없습니다.');
  writeLibrary(next);
}

// ---------- Gemini (called directly from the browser) ----------

const GEMINI_MODEL = 'gemini-3.6-flash';

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

const EXAMPLE_SYSTEM_PROMPT = `당신은 중국어 학습자를 위한 예문 생성 도우미입니다.
주어진 중국어 단어를 사용한 자연스럽고 실생활에서 쓸 법한 중국어 예문 1개와 그 한국어 번역을 만드세요.

아래 필드를 가진 JSON 객체 하나로만 응답하세요. 설명이나 마크다운 코드블록 없이 순수 JSON만 출력하세요.

{
  "example": "중국어 예문 (반드시 입력 단어를 포함)",
  "exampleTranslation": "예문의 자연스러운 한국어 번역"
}`;

function geminiErrorMessage(status, errBody) {
  if (status === 503) {
    return 'Gemini 서버에 요청이 몰려 있어 응답하지 못했습니다. 잠시 후 다시 시도해주세요.';
  }
  if (status === 429) {
    return 'Gemini API 요청 한도를 초과했습니다. 잠시 후(1분 내) 다시 시도해보시고, 계속되면 Google AI Studio에서 무료 할당량과 요금제를 확인해주세요.';
  }
  return `Gemini 요청 실패 (${status}): ${errBody?.error?.message || ''}`;
}

function extractJsonArray(text) {
  let s = text.trim();
  s = s.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('JSON 배열을 찾을 수 없습니다.');
  return JSON.parse(s.slice(start, end + 1));
}

async function callGeminiOnce(systemPrompt, userParts) {
  const key = getGeminiKey();
  if (!key) throw new Error('설정(⚙️)에서 Gemini API 키를 먼저 입력해주세요.');

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: userParts }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    }
  );

  if (!res.ok) {
    const errBody = await res.json().catch(() => null);
    throw new Error(geminiErrorMessage(res.status, errBody));
  }

  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
}

// Gemini occasionally returns a well-formed but empty completion under load — retry once
// before giving up. Kept low (not more) so a flaky call doesn't burn through the free-tier
// quota faster than it helps.
async function callGemini(parts, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const text = await callGeminiOnce(ANALYZE_SYSTEM_PROMPT, parts);
    let entries;
    try {
      entries = extractJsonArray(text);
    } catch {
      entries = [];
    }
    if (entries.length > 0) return entries;
    if (attempt === retries) throw new Error('일시적인 오류로 분석하지 못했습니다. 다시 시도해주세요.');
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
}

async function generateExample(word, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const text = await callGeminiOnce(EXAMPLE_SYSTEM_PROMPT, [{ text: `단어: ${word}` }]);
    const s = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(s);
    } catch {
      parsed = null;
    }
    if (parsed && parsed.example && parsed.example.trim()) return parsed;
    if (attempt === retries) throw new Error('일시적인 오류로 예문을 만들지 못했습니다. 다시 시도해주세요.');
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
}

function analyzeText(rawText) {
  return callGemini([{ text: `다음 텍스트를 분석해줘:\n\n${rawText}` }]);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('이미지를 읽지 못했습니다.'));
    reader.readAsDataURL(file);
  });
}

async function analyzeImages(files) {
  const imageParts = await Promise.all(
    files.map(async (f) => ({ inline_data: { mime_type: f.type, data: await fileToBase64(f) } }))
  );
  const promptText =
    files.length > 1
      ? `이 ${files.length}장의 사진 속 중국어 단어 학습 내용을 분석해줘. 모든 사진의 내용을 순서대로 하나의 JSON 배열로 합쳐서 줘.`
      : '이 사진 속 중국어 단어 학습 내용을 분석해줘.';

  return callGemini([...imageParts, { text: promptText }]);
}

// ---------- Google Cloud TTS (also called directly from the browser) ----------

const ttsCache = new Map(); // word -> blob URL, in-memory for this page session only

async function synthesizeSpeech(text) {
  if (ttsCache.has(text)) return ttsCache.get(text);

  const key = getTtsKey();
  if (!key) throw new Error('설정(⚙️)에서 Google TTS API 키를 먼저 입력해주세요.');

  const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: 'cmn-CN', name: 'cmn-CN-Wavenet-A' },
      audioConfig: { audioEncoding: 'MP3' },
    }),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => null);
    throw new Error(`Google TTS 요청 실패 (${res.status}): ${errBody?.error?.message || res.statusText}`);
  }

  const data = await res.json();
  const byteChars = atob(data.audioContent);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mp3' }));

  ttsCache.set(text, url);
  return url;
}

// ---------- DOM wiring ----------

const form = document.getElementById('search-form');
const input = document.getElementById('word-input');
const searchBtn = document.getElementById('search-btn');
const photoInput = document.getElementById('photo-input');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const saveBar = document.getElementById('save-bar');
const saveTarget = document.getElementById('save-target');
const saveTitleInput = document.getElementById('save-title');
const saveBtn = document.getElementById('save-btn');
const libraryList = document.getElementById('library-list');
const audioPlayer = document.getElementById('audio-player');
const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const geminiKeyInput = document.getElementById('gemini-key-input');
const ttsKeyInput = document.getElementById('tts-key-input');
const settingsSaveBtn = document.getElementById('settings-save-btn');
const settingsCloseBtn = document.getElementById('settings-close-btn');

let currentEntries = [];

function setStatus(text, isError = false) {
  statusEl.hidden = !text;
  statusEl.textContent = text || '';
  statusEl.classList.toggle('error', isError);
}

function setLoading(isLoading) {
  searchBtn.disabled = isLoading;
  input.disabled = isLoading;
}

function openSettings() {
  geminiKeyInput.value = getGeminiKey();
  ttsKeyInput.value = getTtsKey();
  settingsPanel.hidden = false;
}
function closeSettings() {
  settingsPanel.hidden = true;
}

settingsBtn.addEventListener('click', openSettings);
settingsCloseBtn.addEventListener('click', closeSettings);
settingsSaveBtn.addEventListener('click', () => {
  setKeys(geminiKeyInput.value.trim(), ttsKeyInput.value.trim());
  closeSettings();
  setStatus('설정을 저장했습니다.');
});

function createResultCard(entry) {
  const card = document.createElement('div');
  card.className = 'result-card';

  const wordRow = document.createElement('div');
  wordRow.className = 'word-row';

  const hanzi = document.createElement('span');
  hanzi.className = 'hanzi';
  hanzi.textContent = entry.word;

  const speakBtn = document.createElement('button');
  speakBtn.type = 'button';
  speakBtn.className = 'icon-btn';
  speakBtn.title = '발음 듣기';
  speakBtn.innerHTML = '<span class="speaker">🔊</span>';

  wordRow.append(hanzi, speakBtn);

  const pinyinEl = document.createElement('div');
  pinyinEl.className = 'pinyin';
  pinyinEl.textContent = entry.pinyin || '';

  const meaningEl = document.createElement('div');
  meaningEl.className = 'meaning';
  meaningEl.textContent = entry.meaning || '';

  const exampleBtn = document.createElement('button');
  exampleBtn.type = 'button';
  exampleBtn.className = 'example-btn';
  exampleBtn.textContent = '예문 보기';

  const exampleBox = document.createElement('div');
  exampleBox.className = 'example-box';
  exampleBox.hidden = true;

  const exampleZh = document.createElement('p');
  exampleZh.className = 'example-zh';
  const exampleKo = document.createElement('p');
  exampleKo.className = 'example-ko';
  exampleBox.append(exampleZh, exampleKo);

  card.append(wordRow, pinyinEl, meaningEl, exampleBtn, exampleBox);

  let exampleLoaded = Boolean(entry.example && entry.example.trim());
  if (exampleLoaded) {
    exampleZh.textContent = entry.example;
    exampleKo.textContent = entry.exampleTranslation || '';
  }

  speakBtn.addEventListener('click', async () => {
    speakBtn.disabled = true;
    try {
      audioPlayer.src = await synthesizeSpeech(entry.word);
      await audioPlayer.play();
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      speakBtn.disabled = false;
    }
  });

  exampleBtn.addEventListener('click', async () => {
    if (exampleLoaded) {
      exampleBox.hidden = !exampleBox.hidden;
      exampleBtn.textContent = exampleBox.hidden ? '예문 보기' : '예문 닫기';
      return;
    }

    exampleBtn.disabled = true;
    exampleBtn.textContent = '예문 만드는 중...';
    try {
      const data = await generateExample(entry.word);
      entry.example = data.example || '';
      entry.exampleTranslation = data.exampleTranslation || '';
      exampleZh.textContent = entry.example;
      exampleKo.textContent = entry.exampleTranslation;
      exampleBox.hidden = false;
      exampleBtn.textContent = '예문 닫기';
      exampleLoaded = true;
    } catch (err) {
      setStatus(err.message, true);
      exampleBtn.textContent = '예문 보기';
    } finally {
      exampleBtn.disabled = false;
    }
  });

  return card;
}

function renderResults(entries) {
  currentEntries = entries.map((e) => ({
    word: e.word,
    pinyin: e.pinyin || '',
    meaning: e.meaning || '',
    example: e.example || '',
    exampleTranslation: e.exampleTranslation || '',
  }));

  resultsEl.innerHTML = '';
  currentEntries.forEach((entry) => resultsEl.appendChild(createResultCard(entry)));
  saveBar.hidden = currentEntries.length === 0;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  setLoading(true);
  setStatus('조회 중...');
  resultsEl.innerHTML = '';
  saveBar.hidden = true;

  try {
    const entries = await analyzeText(text);
    if (!entries.length) throw new Error('결과를 찾을 수 없습니다.');
    renderResults(entries);
    setStatus('');
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    setLoading(false);
  }
});

photoInput.addEventListener('change', async () => {
  const files = Array.from(photoInput.files || []);
  if (!files.length) return;

  setLoading(true);
  setStatus(`사진 ${files.length}장 분석 중...`);
  resultsEl.innerHTML = '';
  saveBar.hidden = true;

  try {
    const entries = await analyzeImages(files);
    if (!entries.length) throw new Error('사진에서 단어를 찾지 못했습니다.');
    renderResults(entries);
    setStatus(`${entries.length}개 단어를 찾았습니다.`);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    setLoading(false);
    photoInput.value = '';
  }
});

saveTarget.addEventListener('change', () => {
  saveTitleInput.hidden = saveTarget.value !== 'new';
});

saveBtn.addEventListener('click', () => {
  if (!currentEntries.length) return;
  try {
    const isNew = saveTarget.value === 'new';
    const data = isNew
      ? librarySave({ title: saveTitleInput.value.trim(), entries: currentEntries })
      : librarySave({ id: saveTarget.value, entries: currentEntries });

    saveTitleInput.value = '';
    setStatus(
      data.skipped > 0
        ? `"${data.title}"에 ${data.added}개 저장했습니다 (이미 있던 ${data.skipped}개 제외).`
        : `"${data.title}"에 저장했습니다.`
    );
    refreshLibrary();
    saveTarget.value = data.id;
    saveTitleInput.hidden = true;
  } catch (err) {
    setStatus(err.message, true);
  }
});

function renderLibrary(items) {
  libraryList.innerHTML = '';

  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'library-empty';
    p.textContent = '아직 저장된 단어장이 없어요.';
    libraryList.appendChild(p);
    return;
  }

  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'library-item';

    const info = document.createElement('div');
    info.className = 'library-info';
    const titleEl = document.createElement('span');
    titleEl.className = 'library-title';
    titleEl.textContent = item.title;
    const metaEl = document.createElement('span');
    metaEl.className = 'library-meta';
    metaEl.textContent = `${item.count}개 · ${new Date(item.createdAt).toLocaleDateString('ko-KR')}`;
    info.append(titleEl, metaEl);

    const actions = document.createElement('div');
    actions.className = 'library-actions';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'library-btn';
    openBtn.textContent = '열기';
    openBtn.addEventListener('click', () => {
      const item2 = libraryGet(item.id);
      if (!item2) return setStatus('불러오기에 실패했습니다.', true);
      renderResults(item2.entries);
      setStatus('');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'library-btn danger';
    deleteBtn.textContent = '삭제';
    deleteBtn.addEventListener('click', () => {
      if (!confirm(`"${item.title}"을(를) 삭제할까요?`)) return;
      try {
        libraryDelete(item.id);
        refreshLibrary();
      } catch (err) {
        setStatus(err.message, true);
      }
    });

    actions.append(openBtn, deleteBtn);
    row.append(info, actions);
    libraryList.appendChild(row);
  });
}

function renderSaveTarget(items) {
  const prevValue = saveTarget.value;
  saveTarget.innerHTML = '';

  const newOpt = document.createElement('option');
  newOpt.value = 'new';
  newOpt.textContent = '➕ 새 단어장 만들기';
  saveTarget.appendChild(newOpt);

  items.forEach((item) => {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = `${item.title} (${item.count}개)`;
    saveTarget.appendChild(opt);
  });

  const stillExists = prevValue && items.some((i) => i.id === prevValue);
  saveTarget.value = stillExists ? prevValue : 'new';
  saveTitleInput.hidden = saveTarget.value !== 'new';
}

function refreshLibrary() {
  const items = getLibraryItems();
  renderLibrary(items);
  renderSaveTarget(items);
}

async function init() {
  await migrateSeedLibrary();
  refreshLibrary();
  if (!getGeminiKey()) openSettings();
}

init();
