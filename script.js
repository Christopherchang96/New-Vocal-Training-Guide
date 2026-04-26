console.log("PitchPerfect: 88键全音域版加载成功！");

// --- 1. 自动生成 A0 (MIDI 21) 到 C8 (MIDI 108) 的字典 ---
const NOTE_FREQS = {};
const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

for (let midi = 21; midi <= 108; midi++) {
  let octave = Math.floor(midi / 12) - 1;
  let noteName = noteNames[midi % 12] + octave;
  // 核心物理公式：MIDI 编号转 Hz 频率
  let freq = 440 * Math.pow(2, (midi - 69) / 12);
  NOTE_FREQS[noteName] = freq;
}

// 核心变量
let targetNote = "C4";
let targetFrequency = NOTE_FREQS[targetNote];

const targetNoteDisplay = document.getElementById("targetNote");
const targetFreqDisplay = document.getElementById("targetFreq");
const noteSelector = document.getElementById("noteSelector");
const playBtn = document.getElementById("playBtn");
const micBtn = document.getElementById("micBtn");
const debugFreq = document.getElementById("debugFreq");

// 标尺相关 DOM
const pitchIndicator = document.getElementById("pitchIndicator");
const feedbackText = document.getElementById("feedbackText");

// --- 3. 初始化真实钢琴音源 (Tone.Sampler) ---
// 先把按钮变灰，告诉用户正在下载真实钢琴声音
playBtn.innerText = "⏳ 载入钢琴音源...";
playBtn.disabled = true;
playBtn.style.opacity = "0.5";

const synth = new Tone.Sampler({
  urls: {
    A0: "A0.mp3",
    C2: "C2.mp3",
    C4: "C4.mp3",
    C6: "C6.mp3",
    C8: "C8.mp3",
  },
  // 这是 Tone.js 官方提供的开源大钢琴音色库
  baseUrl: "https://tonejs.github.io/audio/salamander/",
  release: 1, // 松开按键后的声音余波长度
}).toDestination();

// 当网络音频加载完毕后，恢复按钮
Tone.loaded().then(() => {
  console.log("真实钢琴音色加载完毕！");
  playBtn.innerText = "🎹 播放参考音";
  playBtn.disabled = false;
  playBtn.style.opacity = "1";
});

let audioContext;
let analyser;
let microphone;
let isMicActive = false;
let animationId;

// 【关键修复】将 Buffer Size 从 2048 提升到 8192，确保能测准低频 (A0~C3)
const BUFF_SIZE = 8192;
const audioBuffer = new Float32Array(BUFF_SIZE);

// --- 2. 获取 DOM 元素并填充下拉菜单 ---
function buildNoteSelector() {
  noteSelector.innerHTML = "";
  for (let note in NOTE_FREQS) {
    const option = document.createElement("option");
    option.value = note;
    const freqStr = NOTE_FREQS[note].toFixed(1);

    // 给一些特殊音符加上中文标记，方便识别
    if (note === "C4") option.text = `${note} (${freqStr} Hz) - 中央C`;
    else if (note === "A4") option.text = `${note} (${freqStr} Hz) - 标准音`;
    else option.text = `${note} (${freqStr} Hz)`;

    if (note === "C4") option.selected = true; // 默认选中 C4
    noteSelector.appendChild(option);
  }
}

// --- 2. 基础交互逻辑 ---
noteSelector.addEventListener("change", (event) => {
  targetNote = event.target.value;
  targetFrequency = NOTE_FREQS[targetNote];
  targetNoteDisplay.innerText = targetNote;
  targetFreqDisplay.innerText = targetFrequency.toFixed(1) + " Hz";
});

playBtn.addEventListener("click", async () => {
  await Tone.start();
  playBtn.innerText = "🔊 播放中...";
  synth.triggerAttackRelease(targetNote, "2s");
  setTimeout(() => {
    playBtn.innerText = "🎹 播放参考音";
  }, 2000);
});

buildNoteSelector();

// --- 3. 麦克风与音频流逻辑 ---
micBtn.addEventListener("click", async () => {
  if (isMicActive) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = BUFF_SIZE;
    microphone = audioContext.createMediaStreamSource(stream);
    microphone.connect(analyser);

    isMicActive = true;
    micBtn.innerText = "🎙️ 监听中...";
    micBtn.style.backgroundColor = "#4caf50";
    updatePitch();
  } catch (err) {
    alert("获取麦克风失败，请允许麦克风权限！\n错误信息: " + err.message);
  }
});

// --- 4. 音高检测算法 (Autocorrelation) ---
function autoCorrelate(buf, sampleRate) {
  let SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return -1; // 声音太小

  let r1 = 0,
    r2 = SIZE - 1,
    thres = 0.2;
  for (let i = 0; i < SIZE / 2; i++)
    if (Math.abs(buf[i]) < thres) {
      r1 = i;
      break;
    }
  for (let i = 1; i < SIZE / 2; i++)
    if (Math.abs(buf[SIZE - i]) < thres) {
      r2 = SIZE - i;
      break;
    }

  buf = buf.slice(r1, r2);
  SIZE = buf.length;

  let c = new Array(SIZE).fill(0);
  for (let i = 0; i < SIZE; i++) {
    for (let j = 0; j < SIZE - i; j++) {
      c[i] = c[i] + buf[j] * buf[j + i];
    }
  }

  let d = 0;
  while (c[d] > c[d + 1]) d++;
  let maxval = -1,
    maxpos = -1;
  for (let i = d; i < SIZE; i++) {
    if (c[i] > maxval) {
      maxval = c[i];
      maxpos = i;
    }
  }
  let T0 = maxpos;
  let x1 = c[T0 - 1],
    x2 = c[T0],
    x3 = c[T0 + 1];
  let a = (x1 + x3 - 2 * x2) / 2;
  let b = (x3 - x1) / 2;
  if (a) T0 = T0 - b / (2 * a);

  return sampleRate / T0;
}

// --- 5. 核心逻辑：游标更新与视觉反馈判定 ---
function updateGauge(cents) {
  // 限制游标在 -50 到 50 之间 (超出部分游标停在边缘)
  let clampedCents = Math.max(-50, Math.min(50, cents));

  // 把 -50 到 +50 映射到 CSS 的 left 属性 (0% 到 100%)
  let percentage = ((clampedCents + 50) / 100) * 100;
  pitchIndicator.style.left = `${percentage}%`;

  // 根据 PRD 设定的逻辑判定表现
  let absCents = Math.abs(cents);

  if (absCents <= 15) {
    // Perfect! 绿灯
    pitchIndicator.className = "indicator perfect";
    feedbackText.innerText = "✨ Perfect! (完美音准) ✨";
    feedbackText.className = "feedback-text text-perfect";
  } else if (absCents <= 50) {
    // Good 黄灯
    pitchIndicator.className = "indicator good";
    if (cents > 0) {
      feedbackText.innerText = `稍微偏高 (+${Math.round(cents)} Ct)`;
    } else {
      feedbackText.innerText = `稍微偏低 (${Math.round(cents)} Ct)`;
    }
    feedbackText.className = "feedback-text text-good";
  } else {
    // Out of Tune 红灯
    pitchIndicator.className = "indicator bad";
    if (cents > 0) {
      feedbackText.innerText = `太高了! (+${Math.round(cents)} Ct)`;
    } else {
      feedbackText.innerText = `太低了! (${Math.round(cents)} Ct)`;
    }
    feedbackText.className = "feedback-text text-bad";
  }
}

// --- 6. 持续执行的检测循环 ---
function updatePitch() {
  analyser.getFloatTimeDomainData(audioBuffer);
  let pitch = autoCorrelate(audioBuffer, audioContext.sampleRate);

  if (pitch !== -1) {
    debugFreq.innerText = `🎤 侦测频率: ${Math.round(pitch)} Hz`;
    debugFreq.style.color = "#4db8ff";

    // 【应用核心数学公式】: 计算音分差
    // Cents = 1200 * log2(用户频率 / 目标频率)
    let cents = 1200 * Math.log2(pitch / targetFrequency);

    // 调用上面的函数更新 UI
    updateGauge(cents);
  } else {
    debugFreq.innerText = `🎤 侦测频率: -- Hz`;
    debugFreq.style.color = "#aaaaaa";

    // 没声音时游标归位，恢复默认状态
    pitchIndicator.style.left = `50%`;
    pitchIndicator.className = "indicator default";
    feedbackText.innerText = "等待输入...";
    feedbackText.className = "feedback-text text-default";
  }

  animationId = requestAnimationFrame(updatePitch);
}

