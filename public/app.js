(() => {
  const READ_DELAY_MS = 3500;

  // ---------- tab switching ----------
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'library') loadLibraryList();
    });
  });

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function playAudioUrl(url) {
    return new Promise((resolve, reject) => {
      const audio = new Audio(url);
      audio.addEventListener('ended', resolve);
      audio.addEventListener('error', () => reject(new Error('오디오 재생 실패')));
      audio.play().catch(reject);
    });
  }

  async function fetchTts(text) {
    const resp = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'TTS 실패');
    return data.url;
  }

  async function getOrFetchAudio(entry, kind) {
    const key = kind === 'word' ? 'wordAudioUrl' : 'exampleAudioUrl';
    if (entry[key]) return entry[key];
    const text = kind === 'word' ? entry.word : entry.example;
    const url = await fetchTts(text);
    entry[key] = url;
    return url;
  }

  // ---------- card rendering ----------

  function buildCard(entry, index) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.idx = String(index);

    const head = document.createElement('div');
    head.className = 'card-head';

    const wordEl = document.createElement('span');
    wordEl.className = 'word';
    wordEl.textContent = entry.word || '';
    head.appendChild(wordEl);

    if (entry.pinyin) {
      const pinyinEl = document.createElement('span');
      pinyinEl.className = 'pinyin';
      pinyinEl.textContent = entry.pinyin;
      head.appendChild(pinyinEl);
    }

    const wordPlayBtn = document.createElement('button');
    wordPlayBtn.className = 'play-btn';
    wordPlayBtn.textContent = '🔊 발음';
    wordPlayBtn.addEventListener('click', async () => {
      wordPlayBtn.disabled = true;
      try {
        const url = await getOrFetchAudio(entry, 'word');
        await playAudioUrl(url);
      } catch (err) {
        alert(err.message);
      } finally {
        wordPlayBtn.disabled = false;
      }
    });
    head.appendChild(wordPlayBtn);
    card.appendChild(head);

    const meaningEl = document.createElement('div');
    meaningEl.className = 'meaning';
    meaningEl.textContent = entry.meaning || '';
    card.appendChild(meaningEl);

    if (entry.example && entry.example.trim()) {
      const exampleBox = document.createElement('div');
      exampleBox.className = 'example';

      const exCn = document.createElement('div');
      exCn.className = 'example-cn';
      exCn.textContent = entry.example;
      exampleBox.appendChild(exCn);

      if (entry.exampleTranslation) {
        const exKr = document.createElement('div');
        exKr.className = 'example-kr';
        exKr.textContent = entry.exampleTranslation;
        exampleBox.appendChild(exKr);
      }

      const exPlayBtn = document.createElement('button');
      exPlayBtn.className = 'play-btn';
      exPlayBtn.textContent = '🔊 예문 듣기';
      exPlayBtn.addEventListener('click', async () => {
        exPlayBtn.disabled = true;
        try {
          const url = await getOrFetchAudio(entry, 'example');
          await playAudioUrl(url);
        } catch (err) {
          alert(err.message);
        } finally {
          exPlayBtn.disabled = false;
        }
      });
      exampleBox.appendChild(exPlayBtn);
      card.appendChild(exampleBox);
    }

    return card;
  }

  function renderCards(container, entries) {
    container.innerHTML = '';
    entries.forEach((entry, idx) => container.appendChild(buildCard(entry, idx)));
  }

  // ---------- sequential "read all" ----------
  // stateRef is a mutable holder ({ entries: [...] }) so the listeners below can be
  // attached exactly once and still always see the latest entries — attaching a fresh
  // listener every time new data loads is what caused overlapping/jumbled playback before.

  function createSequentialPlayer({ container, stateRef, playBtn, stopBtn, kind }) {
    let running = false;
    let stopped = true;

    async function run() {
      if (running) return;
      const entries = stateRef.entries;
      const targets = entries
        .map((entry, idx) => ({ entry, idx }))
        .filter(({ entry }) => kind === 'word' || (entry.example && entry.example.trim()));

      if (targets.length === 0) {
        alert(kind === 'example' ? '예문이 있는 단어가 없습니다.' : '읽을 단어가 없습니다.');
        return;
      }

      running = true;
      stopped = false;
      playBtn.classList.add('hidden');
      stopBtn.classList.remove('hidden');

      for (const { entry, idx } of targets) {
        if (stopped) break;
        const cardEl = container.querySelector(`[data-idx="${idx}"]`);
        cardEl?.classList.add('active');
        cardEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });

        try {
          const url = await getOrFetchAudio(entry, kind);
          if (!stopped) {
            await playAudioUrl(url);
            if (!stopped) await delay(READ_DELAY_MS);
          }
        } catch (err) {
          console.error(err);
        }
        cardEl?.classList.remove('active');
      }

      stopped = true;
      running = false;
      playBtn.classList.remove('hidden');
      stopBtn.classList.add('hidden');
    }

    playBtn.addEventListener('click', run);
    stopBtn.addEventListener('click', () => {
      stopped = true;
    });
  }

  // ---------- "new study" tab ----------

  const textInput = document.getElementById('textInput');
  const pasteZone = document.getElementById('pasteZone');
  const imageInput = document.getElementById('imageInput');
  const imageThumbs = document.getElementById('imageThumbs');
  const clearImagesBtn = document.getElementById('clearImagesBtn');
  const analyzeBtn = document.getElementById('analyzeBtn');
  const analyzeStatus = document.getElementById('analyzeStatus');
  const resultsSection = document.getElementById('resultsSection');
  const cardsContainer = document.getElementById('cardsContainer');
  const playAllBtn = document.getElementById('playAllBtn');
  const stopAllBtn = document.getElementById('stopAllBtn');
  const playAllExampleBtn = document.getElementById('playAllExampleBtn');
  const stopAllExampleBtn = document.getElementById('stopAllExampleBtn');
  const saveTitle = document.getElementById('saveTitle');
  const saveBtn = document.getElementById('saveBtn');

  const newStudyState = { entries: [] };
  createSequentialPlayer({ container: cardsContainer, stateRef: newStudyState, playBtn: playAllBtn, stopBtn: stopAllBtn, kind: 'word' });
  createSequentialPlayer({ container: cardsContainer, stateRef: newStudyState, playBtn: playAllExampleBtn, stopBtn: stopAllExampleBtn, kind: 'example' });

  // ---------- image selection (file picker / paste / drag-drop) ----------

  let selectedImages = []; // File[]
  const thumbUrls = new WeakMap(); // File -> object URL

  function addImages(fileList) {
    const files = Array.from(fileList).filter((f) => /^image\//.test(f.type));
    selectedImages.push(...files);
    renderThumbs();
  }

  function removeImage(index) {
    const [file] = selectedImages.splice(index, 1);
    const url = thumbUrls.get(file);
    if (url) URL.revokeObjectURL(url);
    renderThumbs();
  }

  function renderThumbs() {
    imageThumbs.innerHTML = '';
    selectedImages.forEach((file, idx) => {
      let url = thumbUrls.get(file);
      if (!url) {
        url = URL.createObjectURL(file);
        thumbUrls.set(file, url);
      }
      const thumb = document.createElement('div');
      thumb.className = 'thumb';

      const img = document.createElement('img');
      img.src = url;
      thumb.appendChild(img);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-thumb';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => removeImage(idx));
      thumb.appendChild(removeBtn);

      imageThumbs.appendChild(thumb);
    });
    clearImagesBtn.classList.toggle('hidden', selectedImages.length === 0);
  }

  clearImagesBtn.addEventListener('click', () => {
    selectedImages.forEach((f) => {
      const url = thumbUrls.get(f);
      if (url) URL.revokeObjectURL(url);
    });
    selectedImages = [];
    renderThumbs();
  });

  imageInput.addEventListener('change', () => {
    addImages(imageInput.files);
    imageInput.value = '';
  });

  document.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (/^image\//.test(item.type)) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      addImages(files);
    }
  });

  pasteZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    pasteZone.classList.add('drag-over');
  });
  pasteZone.addEventListener('dragleave', () => pasteZone.classList.remove('drag-over'));
  pasteZone.addEventListener('drop', (e) => {
    e.preventDefault();
    pasteZone.classList.remove('drag-over');
    if (e.dataTransfer?.files?.length) addImages(e.dataTransfer.files);
  });

  analyzeBtn.addEventListener('click', async () => {
    const text = textInput.value.trim();
    const hasImages = selectedImages.length > 0;

    if (!text && !hasImages) {
      analyzeStatus.textContent = '텍스트를 입력하거나 사진을 붙여넣어/선택해주세요.';
      analyzeStatus.classList.add('error');
      return;
    }

    analyzeBtn.disabled = true;
    analyzeStatus.classList.remove('error');
    analyzeStatus.textContent = '분석 중입니다... (사진은 시간이 조금 더 걸릴 수 있어요)';
    resultsSection.classList.add('hidden');

    try {
      let entries;
      if (hasImages) {
        const form = new FormData();
        selectedImages.forEach((f, i) => form.append('images', f, f.name || `pasted-${i}.png`));
        const resp = await fetch('/api/analyze/image', { method: 'POST', body: form });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || '분석 실패');
        entries = data.entries;
      } else {
        const resp = await fetch('/api/analyze/text', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || '분석 실패');
        entries = data.entries;
      }

      if (!entries || entries.length === 0) throw new Error('분석된 단어가 없습니다.');

      newStudyState.entries = entries;
      renderCards(cardsContainer, newStudyState.entries);
      resultsSection.classList.remove('hidden');
      analyzeStatus.textContent = `${entries.length}개 단어를 분석했어요.`;
    } catch (err) {
      analyzeStatus.textContent = err.message;
      analyzeStatus.classList.add('error');
    } finally {
      analyzeBtn.disabled = false;
    }
  });

  saveBtn.addEventListener('click', async () => {
    if (newStudyState.entries.length === 0) return;
    saveBtn.disabled = true;
    try {
      const resp = await fetch('/api/library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: saveTitle.value, entries: newStudyState.entries }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || '저장 실패');
      alert(`저장되었습니다: ${data.title}`);
      saveTitle.value = '';
    } catch (err) {
      alert(err.message);
    } finally {
      saveBtn.disabled = false;
    }
  });

  // ---------- "library" tab ----------

  const libraryList = document.getElementById('libraryList');
  const libraryDetail = document.getElementById('libraryDetail');
  const libCardsContainer = document.getElementById('libCardsContainer');
  const libPlayAllBtn = document.getElementById('libPlayAllBtn');
  const libStopAllBtn = document.getElementById('libStopAllBtn');
  const libPlayAllExampleBtn = document.getElementById('libPlayAllExampleBtn');
  const libStopAllExampleBtn = document.getElementById('libStopAllExampleBtn');
  const backToListBtn = document.getElementById('backToListBtn');

  const libraryState = { entries: [] };
  createSequentialPlayer({ container: libCardsContainer, stateRef: libraryState, playBtn: libPlayAllBtn, stopBtn: libStopAllBtn, kind: 'word' });
  createSequentialPlayer({ container: libCardsContainer, stateRef: libraryState, playBtn: libPlayAllExampleBtn, stopBtn: libStopAllExampleBtn, kind: 'example' });

  async function loadLibraryList() {
    libraryDetail.classList.add('hidden');
    libraryList.classList.remove('hidden');
    libraryList.innerHTML = '<div class="empty-msg">불러오는 중...</div>';

    const resp = await fetch('/api/library');
    const data = await resp.json();
    if (!data.items || data.items.length === 0) {
      libraryList.innerHTML = '<div class="empty-msg">저장된 학습 내용이 없습니다.</div>';
      return;
    }

    libraryList.innerHTML = '';
    data.items.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'lib-item';

      const titleEl = document.createElement('div');
      titleEl.className = 'lib-title';
      titleEl.textContent = item.title;
      row.appendChild(titleEl);

      const metaEl = document.createElement('div');
      metaEl.className = 'lib-meta';
      metaEl.textContent = `${new Date(item.createdAt).toLocaleString('ko-KR')} · 단어 ${item.count}개`;
      row.appendChild(metaEl);

      const actions = document.createElement('div');
      actions.className = 'lib-actions';

      const openBtn = document.createElement('button');
      openBtn.className = 'secondary-btn';
      openBtn.textContent = '불러오기';
      openBtn.addEventListener('click', () => openLibraryItem(item.id));
      actions.appendChild(openBtn);

      const delBtn = document.createElement('button');
      delBtn.className = 'secondary-btn';
      delBtn.textContent = '삭제';
      delBtn.addEventListener('click', async () => {
        if (!confirm(`"${item.title}" 항목을 삭제할까요?`)) return;
        await fetch(`/api/library/${item.id}`, { method: 'DELETE' });
        loadLibraryList();
      });
      actions.appendChild(delBtn);

      row.appendChild(actions);
      libraryList.appendChild(row);
    });
  }

  async function openLibraryItem(id) {
    const resp = await fetch(`/api/library/${id}`);
    const item = await resp.json();
    if (!resp.ok) {
      alert(item.error || '불러오기 실패');
      return;
    }
    libraryList.classList.add('hidden');
    libraryDetail.classList.remove('hidden');
    libraryState.entries = item.entries;
    renderCards(libCardsContainer, libraryState.entries);
  }

  backToListBtn.addEventListener('click', loadLibraryList);
})();
