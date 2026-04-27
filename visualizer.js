console.log("PitchPerfect: 终极专业版 (动态主屏显示) 加载成功！");

// --- 1. 基础数据生成 (A0 到 C8 完整 88 键) ---
const NOTE_FREQS = {};
const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// 生成所有音的频率
for (let midi = 21; midi <= 108; midi++) {
  let octave = Math.floor(midi / 12) - 1;
  let noteName = noteNames[midi % 12] + octave;
  NOTE_FREQS[noteName] = 440 * Math.pow(2, (midi - 69) / 12);
}

// 核心变量
let targetNote = "C4"; // 默认目标音
let targetFrequency = NOTE_FREQS[targetNote];
let targetMidi = 60; // C4 的 MIDI 编号
let targetPitchClass = 0; // C 的音级 (0-11)

// 获取 DOM
const targetNoteDisplay = document.getElementById("targetNote");
const targetFreqDisplay = document.getElementById("targetFreq");
const noteSelector = document.getElementById("noteSelector");
const playBtn = document.getElementById("playBtn");
const micBtn = document.getElementById("micBtn");
const debugFreq = document.getElementById("debugFreq");
const pitchIndicator = document.getElementById("pitchIndicator");
const feedbackText = document.getElementById("feedbackText");
const pianoContainer = document.getElementById("piano");

// --- 2. 动态生成下方的 88 键长钢琴 ---
const START_MIDI = 21; // A0
const END_MIDI = 108; // C8
let whiteKeyCount = 0;
const WHITE_KEY_WIDTH = 30;

function isBlackKey(midi) {
  return [1, 3, 6, 8, 10].includes(midi % 12);
}

for (let midi = START_MIDI; midi <= END_MIDI; midi++) {
  let key = document.createElement("div");
  key.className = "piano-key";
  key.id = `key-${midi}`;

  if (isBlackKey(midi)) {
    key.classList.add("black-key");
    key.style.left = `${whiteKeyCount * WHITE_KEY_WIDTH - 18 / 2}px`;
  } else {
    key.classList.add("white-key");
    key.style.left = `${whiteKeyCount * WHITE_KEY_WIDTH}px`;
    whiteKeyCount++;
  }
  pianoContainer.appendChild(key);
}
pianoContainer.style.width = `${whiteKeyCount * WHITE_KEY_WIDTH}px`;

// --- 3. UI 高亮联动逻辑 ---
function highlightTargets() {
  targetMidi = Math.round(69 + 12 * Math.log2(targetFrequency / 440));
  targetPitchClass = targetMidi % 12;

  document.querySelectorAll(".piano-key.target").forEach((el) => el.classList.remove("target"));
  document.querySelectorAll(".logic-key.target").forEach((el) => el.classList.remove("target"));

  let pianoKey = document.getElementById(`key-${targetMidi}`);
  if (pianoKey) {
    pianoKey.classList.add("target");
    pianoKey.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }

  let logicKey = document.getElementById(`pk-${targetPitchClass}`);
  if (logicKey) {
    logicKey.classList.add("target");
  }
}

// 填充 88 键下拉菜单
for (let note in NOTE_FREQS) {
  let option = document.createElement("option");
  option.value = note;
  option.text = `${note} (${NOTE_FREQS[note].toFixed(1)} Hz)`;
  if (note === "C4") option.selected = true;
  noteSelector.appendChild(option);
}

// 监听下拉菜单
noteSelector.addEventListener("change", (event) => {
  targetNote = event.target.value;
  targetFrequency = NOTE_FREQS[targetNote];

  // 下拉切换时，如果没有发声，重置大屏幕为目标音
  targetNoteDisplay.innerText = targetNote;
  targetFreqDisplay.innerText = `目标: ${targetFrequency.toFixed(1)} Hz`;
  targetNoteDisplay.style.color = "#4db8ff";
  targetNoteDisplay.style.textShadow = "0 0 20px rgba(77, 184, 255, 0.3)";

  highlightTargets();
});

highlightTargets();

// --- 4. 钢琴音源加载 ---
playBtn.innerText = "⏳ 载入钢琴音源...";
const synth = new Tone.Sampler({
  urls: { A0: "A0.mp3", C2: "C2.mp3", C4: "C4.mp3", C6: "C6.mp3", C8: "C8.mp3" },
  baseUrl: "https://tonejs.github.io/audio/salamander/",
  release: 1,
}).toDestination();

Tone.loaded().then(() => {
  playBtn.innerText = "🎹 播放参考音";
});

playBtn.addEventListener("click", async () => {
  await Tone.start();
  synth.triggerAttackRelease(targetNote, "2s");
});

// --- 5. 麦克风与音频检测 ---
let audioContext, analyser, microphone, lowpassFilter;
let isMicActive = false;
const BUFF_SIZE = 4096;
const audioBuffer = new Float32Array(BUFF_SIZE);
let pitchHistory = [];
const SMOOTHING_FRAMES = 5;
const MIN_RMS = 0.012;
const MIN_DETECT_FREQ = 60;   // 人声/练声有效下限
const MAX_DETECT_FREQ = 1200; // 人声有效上限，屏蔽 19kHz 这类假峰值

micBtn.addEventListener("click", async () => {
  if (isMicActive) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = BUFF_SIZE;
        
        // 低通滤波：过滤人声主频范围外的高频噪声
        lowpassFilter = audioContext.createBiquadFilter();
        lowpassFilter.type = "lowpass";
        lowpassFilter.frequency.value = 1200; 
        lowpassFilter.Q.value = 0.5;

        microphone = audioContext.createMediaStreamSource(stream);
        
        // 麦克风 -> 滤波器 -> 分析器
        microphone.connect(lowpassFilter);
        lowpassFilter.connect(analyser);

    isMicActive = true;
        pitchHistory = [];
    micBtn.innerText = "🎙️ 监听中...";
    micBtn.style.backgroundColor = "#4caf50";
    updatePitch();
  } catch (err) {}
});

// --- 【全新商业级核心】：YIN 算法 ---
function yinAlgorithm(buf, sampleRate) {
  let yinBuffer = new Float32Array(buf.length / 2);
  let threshold = 0.15; // 灵敏度阈值 (0.1到0.2最适合人声)
  const minTau = Math.max(2, Math.floor(sampleRate / MAX_DETECT_FREQ));
  const maxTau = Math.min(
    yinBuffer.length - 1,
    Math.ceil(sampleRate / MIN_DETECT_FREQ)
  );

  // 1. 计算差分函数
  for (let t = 0; t < yinBuffer.length; t++) {
    yinBuffer[t] = 0;
    for (let i = 0; i < yinBuffer.length; i++) {
      let delta = buf[i] - buf[i + t];
      yinBuffer[t] += delta * delta;
    }
  }

  // 2. 累积均值归一化差分
  yinBuffer[0] = 1;
  yinBuffer[1] = 1;
  let runningSum = 0;
  for (let t = 1; t < yinBuffer.length; t++) {
    runningSum += yinBuffer[t];
    yinBuffer[t] *= t / runningSum;
  }

  // 3. 寻找绝对阈值下的最优周期
  let tau = -1;
  for (let t = minTau; t <= maxTau; t++) {
    if (yinBuffer[t] < threshold) {
      while (t + 1 <= maxTau && yinBuffer[t + 1] < yinBuffer[t]) t++;
      tau = t;
      break;
    }
  }

  // 声音太小/环境噪声时返回 -1
  if (tau === -1) {
    let rms = 0;
    for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / buf.length);
    if (rms < 0.01) return -1;
  }
  if (tau === -1) return -1;

  // 4. 抛物线插值提升精度
  let s0 = yinBuffer[tau - 1] || yinBuffer[tau];
  let s1 = yinBuffer[tau];
  let s2 = yinBuffer[tau + 1] || yinBuffer[tau];
  let denom = s0 - 2 * s1 + s2;
  let shift = Math.abs(denom) > 1e-12 ? (0.5 * (s0 - s2)) / denom : 0;
  let freq = sampleRate / (tau + shift);

  if (freq < MIN_DETECT_FREQ || freq > MAX_DETECT_FREQ || !Number.isFinite(freq)) {
    return -1;
  }
  return freq;
}

// --- 6. 核心：双屏动态更新联动 ---
let lastActiveMidi = -1;
let lastActivePc = -1;

function updatePitch() {
  analyser.getFloatTimeDomainData(audioBuffer);
  // 先做能量门限，静音/底噪不进入音高检测，避免跳到高频假值
  let rms = 0;
  for (let i = 0; i < audioBuffer.length; i++) rms += audioBuffer[i] * audioBuffer[i];
  rms = Math.sqrt(rms / audioBuffer.length);
  
  // 调用 YIN 算法 + 中值防抖
  let rawPitch = rms >= MIN_RMS ? yinAlgorithm(audioBuffer, audioContext.sampleRate) : -1;
  let pitch = -1;
  if (rawPitch !== -1) {
    pitchHistory.push(rawPitch);
    if (pitchHistory.length > SMOOTHING_FRAMES) pitchHistory.shift();
    let sortedArray = [...pitchHistory].sort((a, b) => a - b);
    pitch = sortedArray[Math.floor(sortedArray.length / 2)];
  } else {
    pitchHistory = [];
  }

  if (pitch !== -1) {
    debugFreq.innerText = `🎤 麦克风捕获: ${Math.round(pitch)} Hz`;
    debugFreq.style.color = "#4db8ff";

    // 获取用户绝对音高 MIDI 和音级 PC
    let currentMidiFloat = 69 + 12 * Math.log2(pitch / 440);
    let currentMidi = Math.round(currentMidiFloat);
    let currentPc = currentMidi % 12;
    let currentOctave = Math.floor(currentMidi / 12) - 1;
    let currentNoteName = noteNames[currentPc] + currentOctave;

    // ★★★ 【新增：顶部大字实时反馈系统】 ★★★
    targetNoteDisplay.innerText = currentNoteName;
    targetFreqDisplay.innerText = `实时: ${pitch.toFixed(1)} Hz`;

    if (currentMidi === targetMidi) {
      // 完全命中 (音准且八度对) -> 爆闪金色
      targetNoteDisplay.style.color = "#ffd700";
      targetNoteDisplay.style.textShadow = "0 0 20px rgba(255, 215, 0, 0.7)";
    } else if (currentPc === targetPitchClass) {
      // 音名对，八度错 -> 青色荧光
      targetNoteDisplay.style.color = "#00ffff";
      targetNoteDisplay.style.textShadow = "0 0 20px rgba(0, 255, 255, 0.6)";
    } else {
      // 完全跑调 -> 普通白色
      targetNoteDisplay.style.color = "#ffffff";
      targetNoteDisplay.style.textShadow = "0 0 10px rgba(255, 255, 255, 0.3)";
    }

    // 1. 更新底部游标 (基于精准的绝对频率计算音分)
    let cents = 1200 * Math.log2(pitch / targetFrequency);
    let clampedCents = Math.max(-50, Math.min(50, cents));
    pitchIndicator.style.left = `${((clampedCents + 50) / 100) * 100}%`;

    let absCents = Math.abs(cents);
    if (absCents <= 50) {
      if (absCents <= 15) {
        pitchIndicator.className = "indicator perfect";
        feedbackText.className = "feedback-text text-perfect";
        feedbackText.innerText = "✨ Perfect! ✨";
      } else {
        pitchIndicator.className = "indicator good";
        feedbackText.className = "feedback-text text-good";
        feedbackText.innerText = `偏${cents > 0 ? "高" : "低"} (${Math.round(cents)} Ct)`;
      }
    } else {
      pitchIndicator.className = "indicator bad";
      feedbackText.className = "feedback-text text-bad";
      feedbackText.innerText = "差太远 / 不在同一八度";
    }

    // 2. 更新 88 键面板 (精准的八度位置)
    if (currentMidi !== lastActiveMidi) {
      let oldKey = document.getElementById(`key-${lastActiveMidi}`);
      if (oldKey) oldKey.classList.remove("active");
      let newKey = document.getElementById(`key-${currentMidi}`);
      if (newKey) newKey.classList.add("active");
      lastActiveMidi = currentMidi;
    }

    // 3. 更新 12 键 Logic 面板 (无视八度)
    if (currentPc !== lastActivePc) {
      let oldPcKey = document.getElementById(`pk-${lastActivePc}`);
      if (oldPcKey) oldPcKey.classList.remove("active");
      let newPcKey = document.getElementById(`pk-${currentPc}`);
      if (newPcKey) newPcKey.classList.add("active");
      lastActivePc = currentPc;
    }
  } else {
    // 没声音时重置回“目标音”
    targetNoteDisplay.innerText = targetNote;
    targetFreqDisplay.innerText = `目标: ${targetFrequency.toFixed(1)} Hz`;
    targetNoteDisplay.style.color = "#4db8ff";
    targetNoteDisplay.style.textShadow = "0 0 20px rgba(77, 184, 255, 0.3)";

    debugFreq.innerText = `🎤 等待发声...`;
    debugFreq.style.color = "#aaaaaa";
    pitchIndicator.style.left = `50%`;
    pitchIndicator.className = "indicator default";
    feedbackText.className = "feedback-text text-default";
    feedbackText.innerText = "等待输入...";

    // 熄灭所有灯
    if (lastActiveMidi !== -1) {
      let oldKey = document.getElementById(`key-${lastActiveMidi}`);
      if (oldKey) oldKey.classList.remove("active");
      lastActiveMidi = -1;
    }
    if (lastActivePc !== -1) {
      let oldPcKey = document.getElementById(`pk-${lastActivePc}`);
      if (oldPcKey) oldPcKey.classList.remove("active");
      lastActivePc = -1;
    }
  }

  requestAnimationFrame(updatePitch);
}

