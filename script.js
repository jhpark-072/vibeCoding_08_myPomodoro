/**
 * 포모도로 플로우 (Pomodoro Flow)
 * - 25분 집중 / 5분 휴식 자동 전환
 * - Web Audio API 기반 무손실 알림음 및 3종 백색소음(파도, 비, 새소리)
 * - 원형 진행 링 및 브라우저 탭 실시간 연동
 * - 세션 카운터 (localStorage 연동)
 */

document.addEventListener('DOMContentLoaded', () => {
  // ==========================================
  // 1. 상수 및 초기 설정
  // ==========================================
  const FOCUS_TIME = 25 * 60; // 25분 (1500초)
  const REST_TIME = 5 * 60;   // 5분 (300초)

  // 상태 변수
  let currentMode = 'focus';  // 'focus' | 'rest'
  let isRunning = false;
  let timeLeft = FOCUS_TIME;
  let totalTime = FOCUS_TIME;
  let timerInterval = null;
  let targetEndTime = null;
  let completedSessions = parseInt(localStorage.getItem('pomodoro_sessions') || '0', 10);

  // 백색소음 상태
  let activeSound = 'off';    // 'off' | 'waves' | 'rain' | 'birds'
  let currentVolume = 0.5;
  let isMuted = false;

  // DOM 요소 참조
  const body = document.body;
  const timeDisplay = document.getElementById('time-display');
  const timeSubtext = document.getElementById('time-subtext');
  const modeBadge = document.getElementById('mode-badge');
  const modeText = document.getElementById('mode-text');
  const startBtn = document.getElementById('start-btn');
  const pauseBtn = document.getElementById('pause-btn');
  const resetBtn = document.getElementById('reset-btn');
  const sessionCountEl = document.getElementById('session-count');
  const resetSessionBtn = document.getElementById('reset-session-btn');
  const progressRing = document.getElementById('progress-ring-indicator');
  const ambientBtns = document.querySelectorAll('.ambient-btn');
  const volumeSlider = document.getElementById('volume-slider');
  const volumeLabel = document.getElementById('volume-label');
  const muteBtn = document.getElementById('mute-btn');
  const muteIcon = document.getElementById('mute-icon');

  // ==========================================
  // 2. Web Audio API 사운드 엔진
  // ==========================================
  let audioCtx = null;
  let ambientMasterGain = null;
  let ambientNodes = []; // 활성 오디오 노드 보관
  let birdInterval = null;

  // AudioContext 초기화 (사용자 인터랙션 시 자동 활성화)
  function initAudio() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContextClass();

      ambientMasterGain = audioCtx.createGain();
      ambientMasterGain.gain.setValueAtTime(isMuted ? 0 : currentVolume, audioCtx.currentTime);
      ambientMasterGain.connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }

  // 알림음 (Web Audio API 신시사이저 차임벨)
  function playAlarm(type) {
    initAudio();
    if (!audioCtx) return;

    const now = audioCtx.currentTime;

    if (type === 'focusEnd') {
      // 집중 완료 알림: 맑고 성취감을 주는 4화음 아르페지오 (C5 - E5 - G5 - C6)
      const freqs = [523.25, 659.25, 783.99, 1046.50];
      freqs.forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + i * 0.12);

        gain.gain.setValueAtTime(0.001, now + i * 0.12);
        gain.gain.exponentialRampToValueAtTime(0.28, now + i * 0.12 + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 1.2);

        osc.connect(gain);
        gain.connect(audioCtx.destination);

        osc.start(now + i * 0.12);
        osc.stop(now + i * 0.12 + 1.3);
      });
    } else {
      // 휴식 완료 알림: 리프레시를 알리는 상쾌한 2화음 비프 (G5 - C6)
      const notes = [
        { freq: 783.99, time: 0 },
        { freq: 1046.50, time: 0.18 }
      ];
      notes.forEach((note) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(note.freq, now + note.time);

        gain.gain.setValueAtTime(0.001, now + note.time);
        gain.gain.exponentialRampToValueAtTime(0.3, now + note.time + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + note.time + 0.8);

        osc.connect(gain);
        gain.connect(audioCtx.destination);

        osc.start(now + note.time);
        osc.stop(now + note.time + 0.9);
      });
    }
  }

  // 핑크 노이즈 버퍼 생성 (비/파도 백색소음 기반)
  function createPinkNoiseBuffer(duration = 5) {
    const bufferSize = audioCtx.sampleRate * duration;
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;

    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }
    return buffer;
  }

  // 백색소음 노드 중지 및 해제
  function stopAmbientSound() {
    if (birdInterval) {
      clearInterval(birdInterval);
      birdInterval = null;
    }
    ambientNodes.forEach(node => {
      try {
        if (node.stop) node.stop();
        node.disconnect();
      } catch (e) {
        // 이미 중단된 노드 예외 무시
      }
    });
    ambientNodes = [];
  }

  // 백색소음 재생
  function startAmbientSound(soundType) {
    stopAmbientSound();
    if (soundType === 'off') return;

    initAudio();
    if (!audioCtx) return;

    if (soundType === 'waves') {
      // 🌊 파도 소리: 필터링된 핑크 노이즈 + LFO 볼륨/필터 스웰링 (파도 밀려오고 빠져나감)
      const noise = audioCtx.createBufferSource();
      noise.buffer = createPinkNoiseBuffer(6);
      noise.loop = true;

      const filter = audioCtx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(320, audioCtx.currentTime);

      const waveGain = audioCtx.createGain();
      waveGain.gain.setValueAtTime(0.4, audioCtx.currentTime);

      // LFO로 파도 주기 시뮬레이션 (4.5초 주기)
      const lfo = audioCtx.createOscillator();
      lfo.frequency.setValueAtTime(0.22, audioCtx.currentTime);

      const lfoGain = audioCtx.createGain();
      lfoGain.gain.setValueAtTime(0.35, audioCtx.currentTime);

      lfo.connect(lfoGain);
      lfoGain.connect(waveGain.gain);

      noise.connect(filter);
      filter.connect(waveGain);
      waveGain.connect(ambientMasterGain);

      noise.start();
      lfo.start();
      ambientNodes.push(noise, filter, waveGain, lfo, lfoGain);

    } else if (soundType === 'rain') {
      // 🌧️ 빗소리: 핑크 노이즈 + 로우패스 필터 (차분하고 촉촉한 빗소리)
      const noise = audioCtx.createBufferSource();
      noise.buffer = createPinkNoiseBuffer(6);
      noise.loop = true;

      const filter = audioCtx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(1100, audioCtx.currentTime);

      const rainGain = audioCtx.createGain();
      rainGain.gain.setValueAtTime(0.55, audioCtx.currentTime);

      noise.connect(filter);
      filter.connect(rainGain);
      rainGain.connect(ambientMasterGain);

      noise.start();
      ambientNodes.push(noise, filter, rainGain);

    } else if (soundType === 'birds') {
      // 🐦 새소리: 잔잔한 숲 배경음 + 2~4초 간격의 감미로운 새 지저귐 주파수 합성
      const noise = audioCtx.createBufferSource();
      noise.buffer = createPinkNoiseBuffer(6);
      noise.loop = true;

      const bgFilter = audioCtx.createBiquadFilter();
      bgFilter.type = 'bandpass';
      bgFilter.frequency.setValueAtTime(650, audioCtx.currentTime);

      const bgGain = audioCtx.createGain();
      bgGain.gain.setValueAtTime(0.12, audioCtx.currentTime); // 매우 잔잔한 바람 배경

      noise.connect(bgFilter);
      bgFilter.connect(bgGain);
      bgGain.connect(ambientMasterGain);
      noise.start();
      ambientNodes.push(noise, bgFilter, bgGain);

      // 새 지저귐 함수
      const playChirp = () => {
        if (!audioCtx || activeSound !== 'birds') return;
        const now = audioCtx.currentTime;
        const count = 2 + Math.floor(Math.random() * 3); // 2~4회 지저귐
        const baseFreq = 2200 + Math.random() * 1200;

        for (let i = 0; i < count; i++) {
          const chirpOsc = audioCtx.createOscillator();
          const chirpGain = audioCtx.createGain();
          const startTime = now + i * 0.12;

          chirpOsc.type = 'sine';
          chirpOsc.frequency.setValueAtTime(baseFreq, startTime);
          chirpOsc.frequency.exponentialRampToValueAtTime(baseFreq + 700, startTime + 0.05);
          chirpOsc.frequency.exponentialRampToValueAtTime(baseFreq - 300, startTime + 0.1);

          chirpGain.gain.setValueAtTime(0.001, startTime);
          chirpGain.gain.exponentialRampToValueAtTime(0.22, startTime + 0.03);
          chirpGain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.1);

          chirpOsc.connect(chirpGain);
          chirpGain.connect(ambientMasterGain);

          chirpOsc.start(startTime);
          chirpOsc.stop(startTime + 0.11);
        }
      };

      playChirp();
      birdInterval = setInterval(() => {
        playChirp();
      }, 3000 + Math.random() * 2500);
    }
  }

  // ==========================================
  // 3. 타이머 및 원형 진행 링 로직
  // ==========================================

  // 시간 포맷 (MM:SS)
  function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  // 원형 진행 링 업데이트
  function updateProgressRing() {
    if (!progressRing) return;
    const radius = 140; // SVG viewBox(320x320) 기준 고정 반지름
    const circumference = 2 * Math.PI * radius; // 약 879.65

    // 진행률 (0: 시작 시점, 1: 완료 시점)
    const progress = 1 - (timeLeft / totalTime);
    const offset = circumference * progress;

    progressRing.style.strokeDasharray = `${circumference} ${circumference}`;
    progressRing.style.strokeDashoffset = offset;
  }

  // UI 및 타이틀 전체 동기화
  function updateUI() {
    const timeFormatted = formatTime(timeLeft);
    timeDisplay.textContent = timeFormatted;

    // 브라우저 탭 실시간 제목 업데이트
    const modeName = currentMode === 'focus' ? '집중 중 🎯' : '휴식 중 ☕';
    if (!isRunning && timeLeft !== totalTime) {
      document.title = `[일시정지] ${timeFormatted} - 포모도로`;
    } else {
      document.title = `[${timeFormatted}] ${modeName} | Pomodoro`;
    }

    // 모드 안내 텍스트
    if (currentMode === 'focus') {
      modeText.textContent = '집중 시간 (Focus)';
      timeSubtext.textContent = isRunning ? '현재 세션에 깊이 몰입해 보세요' : '준비되면 시작을 누르세요';
    } else {
      modeText.textContent = '휴식 시간 (Rest)';
      timeSubtext.textContent = isRunning ? '눈을 감고 편안하게 쉬어 가세요' : '충전 후 다시 집중해 보아요';
    }

    // 세션 카운터 업데이트
    sessionCountEl.textContent = completedSessions;

    // 원형 링 업데이트
    updateProgressRing();
  }

  // 모드 전환
  function setMode(mode, autoStart = false) {
    currentMode = mode;
    if (mode === 'focus') {
      body.classList.remove('mode-rest');
      body.classList.add('mode-focus');
      totalTime = FOCUS_TIME;
      timeLeft = FOCUS_TIME;
    } else {
      body.classList.remove('mode-focus');
      body.classList.add('mode-rest');
      totalTime = REST_TIME;
      timeLeft = REST_TIME;
    }

    if (autoStart) {
      startTimer();
    } else {
      pauseTimer();
      updateUI();
    }
  }

  // 타이머 1초 경과 틱 (Date.now 기반 정밀 동기화)
  function tick() {
    const remainingSeconds = Math.max(0, Math.ceil((targetEndTime - Date.now()) / 1000));
    timeLeft = remainingSeconds;
    updateUI();

    if (timeLeft <= 0) {
      handleSessionComplete();
    }
  }

  // 세션 완료 처리 (자동 전환)
  function handleSessionComplete() {
    clearInterval(timerInterval);
    timerInterval = null;
    isRunning = false;

    if (currentMode === 'focus') {
      // 25분 집중 종료 시
      completedSessions++;
      localStorage.setItem('pomodoro_sessions', completedSessions.toString());
      playAlarm('focusEnd');
      // 5분 휴식으로 자동 전환 후 시작
      setMode('rest', true);
    } else {
      // 5분 휴식 종료 시
      playAlarm('restEnd');
      // 25분 집중으로 자동 전환 후 시작
      setMode('focus', true);
    }
  }

  // 타이머 시작
  function startTimer() {
    initAudio();
    if (isRunning) return;

    isRunning = true;
    targetEndTime = Date.now() + timeLeft * 1000;
    timerInterval = setInterval(tick, 250); // 부드러운 체크

    startBtn.disabled = true;
    pauseBtn.disabled = false;
    updateUI();
  }

  // 타이머 일시정지
  function pauseTimer() {
    if (!isRunning && !timerInterval) return;

    isRunning = false;
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    startBtn.disabled = false;
    pauseBtn.disabled = true;
    updateUI();
  }

  // 타이머 초기화
  function resetTimer() {
    pauseTimer();
    timeLeft = currentMode === 'focus' ? FOCUS_TIME : REST_TIME;
    totalTime = timeLeft;
    updateUI();
  }

  // ==========================================
  // 4. 이벤트 리스너 바인딩
  // ==========================================

  // 타이머 조작 버튼
  startBtn.addEventListener('click', startTimer);
  pauseBtn.addEventListener('click', pauseTimer);
  resetBtn.addEventListener('click', resetTimer);

  // 세션 카운터 초기화 버튼
  resetSessionBtn.addEventListener('click', () => {
    if (confirm('완료한 세션 카운트를 초기화하시겠습니까?')) {
      completedSessions = 0;
      localStorage.setItem('pomodoro_sessions', '0');
      updateUI();
    }
  });

  // 백색소음 선택 버튼
  ambientBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      initAudio();
      ambientBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const sound = btn.dataset.sound;
      activeSound = sound;
      startAmbientSound(sound);
    });
  });

  // 음량 슬라이더
  volumeSlider.addEventListener('input', (e) => {
    initAudio();
    const val = parseInt(e.target.value, 10);
    currentVolume = val / 100;
    volumeLabel.textContent = `${val}%`;

    if (isMuted && val > 0) {
      isMuted = false;
      muteIcon.textContent = '🔊';
    }

    if (ambientMasterGain) {
      ambientMasterGain.gain.setValueAtTime(isMuted ? 0 : currentVolume, audioCtx.currentTime);
    }
  });

  // 음소거 토글 버튼
  muteBtn.addEventListener('click', () => {
    initAudio();
    isMuted = !isMuted;
    muteIcon.textContent = isMuted ? '🔇' : '🔊';

    if (ambientMasterGain) {
      ambientMasterGain.gain.setValueAtTime(isMuted ? 0 : currentVolume, audioCtx.currentTime);
    }
  });

  // 창 포커스 복귀 시 링 리사이즈 대응
  window.addEventListener('resize', updateProgressRing);

  // 초기 상태 로드
  updateUI();
});
