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

let audioContext, analyser, microphone, lowpassFilter;
let isMicActive = false;
let animationId;
// --- 6. 核心：双屏动态更新联动 ---
let lastActiveMidi = -1;
let lastActivePc = -1;

// YIN/时域音高检测在 4096 下响应更灵敏，延迟更低
const BUFF_SIZE = 4096;
const audioBuffer = new Float32Array(BUFF_SIZE);
// 平滑器：保存最近若干帧的频率，减少游标抖动
let pitchHistory = [];
const SMOOTHING_FRAMES = 5;

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
    lowpassFilter = audioContext.createBiquadFilter();
    lowpassFilter.type = "lowpass";
    // 人声音高主要在较低频段，先低通可降低高频噪声干扰
    lowpassFilter.frequency.value = 1200;
    lowpassFilter.Q.value = 0.5;

    microphone.connect(lowpassFilter);
    lowpassFilter.connect(analyser);

    isMicActive = true;
    pitchHistory = [];
    micBtn.innerText = "🎙️ 监听中...";
    micBtn.style.backgroundColor = "#4caf50";
    updatePitch();
  } catch (err) {
    alert("获取麦克风失败，请允许麦克风权限！\n错误信息: " + err.message);
  }
});

// --- 4. 【全新商业级核心】：YIN 算法 ---
function yinAlgorithm(buf, sampleRate) {
  let yinBuffer = new Float32Array(buf.length / 2);
  let threshold = 0.15; // 灵敏度阈值 (0.1到0.2最适合人声)

  // 1. 计算差分函数 (彻底消除泛音干扰)
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
  for (let t = 2; t < yinBuffer.length; t++) {
    if (yinBuffer[t] < threshold) {
      while (t + 1 < yinBuffer.length && yinBuffer[t + 1] < yinBuffer[t]) {
        t++;
      }
      tau = t;
      break;
    }
  }

  // 如果声音太小或全是环境底噪
  if (tau === -1) {
    let rms = 0;
    for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / buf.length);
    if (rms < 0.01) return -1;
  }
  if (tau === -1) return -1;

  // 4. 抛物线插值提升精度 (算出极精准的 Hz 小数点)
  let s0 = yinBuffer[tau - 1] || yinBuffer[tau];
  let s1 = yinBuffer[tau];
  let s2 = yinBuffer[tau + 1] || yinBuffer[tau];
  let shift = 0.5 * (s0 - s2) / (s0 - 2 * s1 + s2);

  return sampleRate / (tau + shift);
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

// --- 6. 核心：双屏动态更新联动 ---
function updatePitch() {
  analyser.getFloatTimeDomainData(audioBuffer);
  // 【修改点】：调用新的 YIN 算法
  let rawPitch = yinAlgorithm(audioBuffer, audioContext.sampleRate);
  let pitch = -1;

  // 【新增防抖逻辑】：中值滤波器
  if (rawPitch !== -1) {
    pitchHistory.push(rawPitch);
    if (pitchHistory.length > SMOOTHING_FRAMES) pitchHistory.shift(); // 保持数组长度
    // 取最近几帧的中位数，彻底干掉乱跳的毛刺
    const sortedArray = [...pitchHistory].sort((a, b) => a - b);
    pitch = sortedArray[Math.floor(sortedArray.length / 2)];
  } else {
    // 如果断声，清空历史
    pitchHistory = [];
  }

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

