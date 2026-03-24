(function () {
  const ROUND_TIME = 20;

  function createState() {
    return {
      active: false,
      score: 0,
      time: 0,
      fishVisible: false,
      fishX: 50,
      fishY: 50,
      resultText: 'スコア 0'
    };
  }

  function createMinigameModule(elements) {
    function prepare(state) {
      state.active = false;
      state.score = 0;
      state.time = 0;
      state.fishVisible = false;
      state.resultText = 'スタートで開始';
      moveFish(state);
    }

    function start(state) {
      state.active = true;
      state.score = 0;
      state.time = ROUND_TIME;
      state.resultText = '';
      state.fishVisible = true;
      moveFish(state);
    }

    function stop(state) {
      state.active = false;
      state.fishVisible = false;
    }

    function update(state, dt) {
      if (!state.active) return;
      state.time = Math.max(0, state.time - dt);
      if (state.time === 0) {
        state.active = false;
        state.fishVisible = false;
        state.resultText = `スコア ${state.score} 匹`;
      }
    }

    function catchFish(state) {
      if (!state.active) return;
      state.score += 1;
      moveFish(state);
    }

    function moveFish(state) {
      const rect = elements.area.getBoundingClientRect();
      const minX = 48;
      const maxX = Math.max(minX, rect.width - 48);
      const minY = 42;
      const maxY = Math.max(minY, rect.height - 48);
      state.fishX = randomBetween(minX, maxX);
      state.fishY = randomBetween(minY, maxY);
    }

    function render(state, isOpen) {
      elements.overlay.classList.toggle('open', isOpen);
      elements.scoreLabel.textContent = `スコア ${state.score}`;
      elements.timeLabel.textContent = `のこり ${state.time.toFixed(1)}秒`;
      elements.resultText.textContent = state.resultText || `スコア ${state.score} 匹`;
      elements.startScreen.style.display = !state.active && state.time === 0 && !state.resultText.includes('匹')
        ? 'grid'
        : 'none';
      elements.resultLayer.classList.toggle('open', !state.active && state.time === 0 && state.resultText.includes('匹'));
      elements.fish.classList.toggle('visible', state.fishVisible && isOpen);
      elements.fish.style.left = `${state.fishX}px`;
      elements.fish.style.top = `${state.fishY}px`;
    }

    return {
      createState,
      prepare,
      start,
      stop,
      update,
      render,
      catchFish
    };
  }

  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  window.createMinigameModule = createMinigameModule;
})();
