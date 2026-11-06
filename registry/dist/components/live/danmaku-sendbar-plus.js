(() => {
  'use strict';

  const { defineComponentMetadata } = coreApis.componentApis.define;
  const { componentsTags } = coreApis.componentApis.component;

  // ===== 配置 =====
  // GitHub 用户名, 用于仓库地址与第三方组件 owner
  const GITHUB = 'iiiMxy';
  // 展示给用户看的作者署名
  const AUTHOR = 'iMxy_';

  const BAR_CLASS = 'lp-danmaku-bar';
  const STYLE_ID = 'lp-danmaku-bar-style';
  const SEND_URL = 'https://api.live.bilibili.com/msg/send';
  const EMOTE_URL = 'https://api.live.bilibili.com/xlive/web-ucenter/v2/emoticon/GetEmoticons';

  // 原生输入栏的选择器. 网页全屏下 B 站用的是 .fullscreen-danmaku 这套容器,
  // 里面的结构是: INPUT.chat-input / SPAN.input-limit-hint / DIV.send-danmaku
  const NATIVE_BAR_SELECTOR = '.fullscreen-danmaku';

  // 想 1:1 使用原生图标时, 把它的 <svg>...</svg> 整段贴到这里(留空则用内置的画法)
  const EMOJI_ICON_SVG = '';

  // 拉不到 B 站表情包时使用的兜底字符表情
  const FALLBACK_EMOJIS = [
    '😀', '😂', '🤣', '😊', '😍', '🤔', '😭', '😡', '👍', '👎',
    '🎉', '❤️', '🔥', '👏', '🐶', '🍉', '⭐', '💯', '🤝', '😴',
  ];

  const REASONS = {
    f: '被系统过滤：关键词或风控，实际没有发出',
    k: '被直播间屏蔽：主播/房管设置的屏蔽词或等级墙',
  };

  // 组件运行在脚本沙箱中，页面全局变量需要通过 unsafeWindow 读取
  const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function waitFor(selector, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const element = document.querySelector(selector);
      if (element) {
        return element;
      }
      await sleep(300);
    }
    return null;
  }

  function getCsrf() {
    const matched = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/);
    return matched ? matched[1] : '';
  }

  let cachedRoomId = null;

  async function getRoomId() {
    if (cachedRoomId) {
      return cachedRoomId;
    }
    const global = page.__NEPTUNE_IS_MY_WAIFU__;
    const fromGlobal = global?.roomInitRes?.room_id ?? global?.roomInfoRes?.room_id;
    if (fromGlobal) {
      cachedRoomId = String(fromGlobal);
      return cachedRoomId;
    }
    const shortId = (location.pathname.match(/^\/(?:blanc\/)?(\d+)/) || [])[1];
    if (!shortId) {
      return null;
    }
    try {
      const response = await fetch(
        `https://api.live.bilibili.com/room/v1/Room/room_init?id=${shortId}`,
        { credentials: 'include' },
      );
      const json = await response.json();
      if (json?.data?.room_id) {
        cachedRoomId = String(json.data.room_id);
        return cachedRoomId;
      }
    } catch (error) {
      console.warn('[弹幕发送] room_init 请求失败', error);
    }
    cachedRoomId = shortId;
    return cachedRoomId;
  }

  async function sendDanmaku(text) {
    const csrf = getCsrf();
    if (!csrf) {
      return { ok: false, message: '未登录：cookie 里没有 bili_jct，请重新登录 B 站' };
    }
    const roomid = await getRoomId();
    if (!roomid) {
      return { ok: false, message: '拿不到房间号，请确认当前在直播间页面' };
    }

    const body = new URLSearchParams({
      roomid,
      msg: text,
      color: '16777215',
      fontsize: '25',
      mode: '1',
      bubble: '0',
      csrf,
      csrf_token: csrf,
      rnd: String(Math.floor(Date.now() / 1000)),
    });

    let response;
    try {
      response = await fetch(SEND_URL, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (error) {
      return { ok: false, message: `网络错误：${error?.message ?? error}` };
    }

    let json = null;
    try {
      json = await response.json();
    } catch (error) {
      /* 非 JSON 响应，交给下面统一处理 */
    }
    console.log('[弹幕发送] /msg/send ->', response.status, json);

    if (!response.ok) {
      return { ok: false, message: `HTTP ${response.status}` };
    }
    if (!json) {
      return { ok: false, message: '响应不是 JSON，可能被风控拦截' };
    }
    if (json.code !== 0) {
      const detail = json.message || json.msg || '发送失败';
      return { ok: false, message: `${detail}（code=${json.code}）` };
    }
    if (typeof json.msg === 'string' && REASONS[json.msg]) {
      return { ok: false, message: REASONS[json.msg] };
    }
    return { ok: true, message: '发送成功' };
  }

  function lockControlBar(locked) {
    try {
      page.EmbedPlayer?.instance?.changeCtrlVisible?.(true, !locked);
    } catch (error) {
      /* 播放器没有该 API 时忽略 */
    }
  }

  // ===== 隐藏原生输入栏 =====

  /** 自动定位原生输入栏：同时包含输入框、数字/数字 计数和「发送」按钮的容器 */
  function findNativeBar() {
    if (NATIVE_BAR_SELECTOR) {
      // 填了选择器就只认它，不再向下猜测，避免误伤粉丝留言框等其它输入框
      return document.querySelector(NATIVE_BAR_SELECTOR);
    }
    const sendButtons = [...document.querySelectorAll('button, div, span, a')].filter(
      element => element.childElementCount === 0 && element.textContent.trim() === '发送',
    );
    for (const button of sendButtons) {
      let node = button.parentElement;
      for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
        const rect = node.getBoundingClientRect();
        // 只认「一条细长输入栏」，避免误伤整个播放器或页面容器
        if (rect.height <= 0 || rect.height > 120 || rect.width < 200) {
          continue;
        }
        const hasInput = Boolean(node.querySelector('input, textarea, [contenteditable="true"]'));
        const hasCounter = /\d+\s*\/\s*\d+/.test(node.textContent || '');
        if (hasInput && hasCounter) {
          return node;
        }
      }
    }
    return null;
  }

  const hiddenNativeBars = [];

  function hideNativeBar() {
    const bar = findNativeBar();
    if (!bar || hiddenNativeBars.some(record => record.element === bar)) {
      return;
    }
    hiddenNativeBars.push({ element: bar, display: bar.style.display });
    bar.style.setProperty('display', 'none', 'important');
    console.log('[弹幕发送] 已隐藏原生输入栏', bar);
  }

  function restoreNativeBar() {
    hiddenNativeBars.forEach(record => {
      if (record.display) {
        record.element.style.display = record.display;
      } else {
        record.element.style.removeProperty('display');
      }
    });
    hiddenNativeBars.length = 0;
  }

  // ===== 表情 =====

  let emoteCache = null;
  let emoteLoading = false;

  async function loadEmotes() {
    if (emoteCache || emoteLoading) {
      return emoteCache;
    }
    emoteLoading = true;
    try {
      const roomId = await getRoomId();
      const response = await fetch(`${EMOTE_URL}?platform=pc&room_id=${roomId || 0}`, {
        credentials: 'include',
      });
      const json = await response.json();
      const packages = json?.data?.data ?? [];
      const list = [];
      packages.forEach(pack => {
        (pack.emoticons ?? []).forEach(emote => {
          if (emote?.url && emote?.emoji) {
            list.push({ text: emote.emoji, url: emote.url, desc: emote.descript || emote.emoji });
          }
        });
      });
      emoteCache = list.length ? list : null;
    } catch (error) {
      console.warn('[弹幕发送] 表情列表拉取失败', error);
      emoteCache = null;
    } finally {
      emoteLoading = false;
    }
    return emoteCache;
  }

  function insertAtCursor(input, text) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    const position = start + text.length;
    try {
      input.setSelectionRange(position, position);
    } catch (error) {
      /* 某些输入类型不支持 setSelectionRange，忽略 */
    }
    input.focus();
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** 仿 B 站直播原生表情按钮的小黄脸图标（内联 SVG，不依赖外部资源） */
  function createEmojiIcon() {
    if (EMOJI_ICON_SVG) {
      const template = document.createElement('template');
      template.innerHTML = EMOJI_ICON_SVG.trim();
      const node = template.content.firstElementChild;
      if (node) {
        return node;
      }
    }
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('aria-hidden', 'true');

    const face = document.createElementNS(SVG_NS, 'circle');
    face.setAttribute('cx', '12');
    face.setAttribute('cy', '12');
    face.setAttribute('r', '11');
    face.setAttribute('fill', '#FFD44D');

    // 左眼：竖向椭圆
    const leftEye = document.createElementNS(SVG_NS, 'ellipse');
    leftEye.setAttribute('cx', '8.6');
    leftEye.setAttribute('cy', '10.2');
    leftEye.setAttribute('rx', '1.55');
    leftEye.setAttribute('ry', '2.3');
    leftEye.setAttribute('fill', '#6B4A1B');

    // 右眼：眨眼弧线
    const wink = document.createElementNS(SVG_NS, 'path');
    wink.setAttribute('d', 'M13.6 10.2c.9-1.5 2.2-1.8 3.4-.9');
    wink.setAttribute('fill', 'none');
    wink.setAttribute('stroke', '#6B4A1B');
    wink.setAttribute('stroke-width', '1.7');
    wink.setAttribute('stroke-linecap', 'round');

    // 嘴：微笑弧
    const mouth = document.createElementNS(SVG_NS, 'path');
    mouth.setAttribute('d', 'M8.9 14.5c.9 1.4 1.9 2.1 3.1 2.1s2.2-.7 3.1-2.1');
    mouth.setAttribute('fill', 'none');
    mouth.setAttribute('stroke', '#6B4A1B');
    mouth.setAttribute('stroke-width', '1.7');
    mouth.setAttribute('stroke-linecap', 'round');

    svg.appendChild(face);
    svg.appendChild(leftEye);
    svg.appendChild(wink);
    svg.appendChild(mouth);
    return svg;
  }

  async function renderEmotes(panel) {
    panel.innerHTML = '';
    const list = await loadEmotes();
    if (!list) {
      FALLBACK_EMOJIS.forEach(character => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'lp-emote';
        button.textContent = character;
        button.dataset.text = character;
        panel.appendChild(button);
      });
      return;
    }
    list.forEach(item => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'lp-emote';
      button.dataset.text = item.text;
      button.title = item.desc;
      const image = document.createElement('img');
      image.src = item.url;
      image.alt = item.desc;
      image.loading = 'lazy';
      button.appendChild(image);
      panel.appendChild(button);
    });
  }

  // ===== 样式 =====

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .${BAR_CLASS} {
        position: absolute;
        left: 50%;
        bottom: 8px;
        transform: translateX(-50%);
        z-index: 80;
        display: flex;
        flex-direction: column;
        align-items: stretch;
        width: min(420px, 56%);
        opacity: 0;
        transition: opacity 0.2s ease-out;
        pointer-events: none;
      }
      .live-player-mounter:hover .${BAR_CLASS},
      .${BAR_CLASS}:focus-within,
      .${BAR_CLASS}.pinned {
        opacity: 1;
        pointer-events: auto;
      }
      .${BAR_CLASS} .lp-row {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .${BAR_CLASS} input {
        flex: 1 1 auto;
        min-width: 0;
        box-sizing: border-box;
        padding: 4px;
        font-size: 14px;
        line-height: normal;
        color: #fff;
        background-color: transparent;
        border: none;
        border-bottom: 2px solid rgba(255, 255, 255, 0.53);
        border-radius: 0;
        outline: none;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
        transition: border-bottom-color 0.2s ease-out;
      }
      .${BAR_CLASS} input:focus {
        border-bottom-color: var(--theme-color, #00aeec);
      }
      .${BAR_CLASS} input::placeholder {
        color: rgba(255, 255, 255, 0.53);
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
      }
      .${BAR_CLASS} .lp-emoji-btn {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        font-size: 16px;
        line-height: 1;
        color: #fff;
        background: transparent;
        border: none;
        cursor: pointer;
        opacity: 0.75;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
        transition: opacity 0.2s ease-out;
      }
      .${BAR_CLASS} .lp-emoji-btn svg {
        display: block;
        width: 20px;
        height: 20px;
      }
      .${BAR_CLASS} .lp-emoji-btn:hover {
        opacity: 1;
      }
      .${BAR_CLASS} .lp-status {
        position: absolute;
        left: 0;
        bottom: calc(100% + 2px);
        width: 100%;
        font-size: 12px;
        line-height: 1.5;
        text-align: center;
        word-break: break-all;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.95);
        opacity: 0;
        transition: opacity 0.2s ease-out;
        pointer-events: none;
      }
      .${BAR_CLASS} .lp-status.visible {
        opacity: 1;
      }
      .${BAR_CLASS} .lp-status.ok {
        color: #8ef0a0;
      }
      .${BAR_CLASS} .lp-status.fail {
        color: #ff9b9b;
      }
      .${BAR_CLASS} .lp-panel {
        position: absolute;
        left: 0;
        right: 0;
        bottom: calc(100% + 4px);
        display: none;
        grid-template-columns: repeat(auto-fill, 28px);
        gap: 4px;
        max-height: 200px;
        padding: 8px;
        overflow-y: auto;
        background: rgba(20, 20, 20, 0.92);
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
      }
      .${BAR_CLASS} .lp-panel.open {
        display: grid;
      }
      .${BAR_CLASS} .lp-emote {
        width: 28px;
        height: 28px;
        padding: 2px;
        font-size: 18px;
        line-height: 1;
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
      }
      .${BAR_CLASS} .lp-emote:hover {
        background: rgba(255, 255, 255, 0.15);
      }
      .${BAR_CLASS} .lp-emote img {
        width: 100%;
        height: 100%;
        object-fit: contain;
      }
      /* 隐藏内置组件残留的输入框，避免重叠 */
      .control-area .danmaku-send-bar {
        display: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  // ===== 输入栏 =====

  function createBar(registerTimer) {
    const wrapper = document.createElement('div');
    wrapper.className = BAR_CLASS;

    const status = document.createElement('div');
    status.className = 'lp-status';

    const row = document.createElement('div');
    row.className = 'lp-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 80;
    input.placeholder = '发个弹幕呗~';
    input.autocomplete = 'off';
    input.spellcheck = false;

    const emojiButton = document.createElement('button');
    emojiButton.type = 'button';
    emojiButton.className = 'lp-emoji-btn';
    emojiButton.title = '表情';
    emojiButton.setAttribute('aria-label', '表情');
    emojiButton.appendChild(createEmojiIcon());

    const panel = document.createElement('div');
    panel.className = 'lp-panel';

    row.appendChild(input);
    row.appendChild(emojiButton);
    // 提示与表情面板都是绝对定位，不参与布局，出现时不会把输入框顶上去
    wrapper.appendChild(status);
    wrapper.appendChild(panel);
    wrapper.appendChild(row);

    let sending = false;
    let statusTimer = 0;

    const showStatus = (text, kind, duration) => {
      status.textContent = text;
      status.className = `lp-status visible ${kind}`;
      clearTimeout(statusTimer);
      statusTimer = registerTimer(() => {
        status.className = 'lp-status';
      }, duration);
    };

    const doSend = async () => {
      const text = input.value.trim();
      if (!text || sending) {
        return;
      }
      sending = true;
      input.disabled = true;
      const result = await sendDanmaku(text);
      sending = false;
      input.disabled = false;
      if (result.ok) {
        input.value = '';
        showStatus(result.message, 'ok', 2000);
      } else {
        // 失败时保留内容，方便改词重发
        showStatus(result.message, 'fail', 6000);
        input.focus();
        input.select();
      }
    };

    input.addEventListener('focus', () => {
      lockControlBar(true);
      wrapper.classList.add('pinned');
    });
    input.addEventListener('blur', () => {
      lockControlBar(false);
      window.setTimeout(() => {
        if (!wrapper.contains(document.activeElement)) {
          wrapper.classList.remove('pinned');
        }
      }, 150);
    });

    input.addEventListener('keydown', event => {
      // 输入法组词中按回车是在选字，不能发送
      if (event.isComposing || event.keyCode === 229) {
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        void doSend();
      }
      if (event.key === 'Escape') {
        panel.classList.remove('open');
      }
      event.stopPropagation();
    });

    // 不抢输入框焦点
    emojiButton.addEventListener('mousedown', event => event.preventDefault());
    emojiButton.addEventListener('click', async event => {
      event.stopPropagation();
      panel.classList.toggle('open');
      if (panel.classList.contains('open') && !panel.dataset.loaded) {
        panel.dataset.loaded = '1';
        await renderEmotes(panel);
      }
    });

    panel.addEventListener('mousedown', event => event.stopPropagation());
    panel.addEventListener('click', event => {
      const button = event.target.closest('.lp-emote');
      if (!button) {
        return;
      }
      event.stopPropagation();
      insertAtCursor(input, button.dataset.text || button.textContent);
    });

    const onDocumentMouseDown = event => {
      if (!wrapper.contains(event.target)) {
        panel.classList.remove('open');
      }
    };
    document.addEventListener('mousedown', onDocumentMouseDown);

    wrapper.addEventListener('mousedown', event => event.stopPropagation());
    wrapper.addEventListener('click', event => event.stopPropagation());
    wrapper.addEventListener('dblclick', event => event.stopPropagation());

    const destroy = () => {
      clearTimeout(statusTimer);
      document.removeEventListener('mousedown', onDocumentMouseDown);
      wrapper.remove();
    };

    return { element: wrapper, destroy };
  }

  // ===== 生命周期 =====

  let disposer = null;

  function start() {
    if (disposer) {
      return;
    }
    const timers = new Set();
    const registerTimer = (callback, delay) => {
      const id = window.setTimeout(() => {
        timers.delete(id);
        callback();
      }, delay);
      timers.add(id);
      return id;
    };

    let mounted = null;

    const tick = async () => {
      const player = await waitFor('.live-player-mounter', 5000);
      if (!player) {
        return;
      }
      // 播放器重建后旧节点会失效，先销毁上一次的实例，避免事件监听泄漏
      if (mounted && !document.contains(mounted.element)) {
        mounted.destroy();
        mounted = null;
      }
      hideNativeBar();
      if (player.querySelector(`.${BAR_CLASS}`)) {
        return;
      }
      if (getComputedStyle(player).position === 'static') {
        player.style.position = 'relative';
      }
      injectStyle();
      mounted = createBar(registerTimer);
      player.appendChild(mounted.element);
      console.log('[弹幕发送] 输入栏已挂载');
    };

    // 播放器会随路由和全屏切换重建，定期检查并补挂
    const interval = window.setInterval(() => {
      void tick();
    }, 2000);
    void tick();

    disposer = () => {
      window.clearInterval(interval);
      timers.forEach(id => window.clearTimeout(id));
      timers.clear();
      mounted?.destroy();
      mounted = null;
      document.getElementById(STYLE_ID)?.remove();
      restoreNativeBar();
      console.log('[弹幕发送] 已清理');
    };
  }

  function stop() {
    disposer?.();
    disposer = null;
  }

  return defineComponentMetadata({
    name: 'liveDanmakuSendbarPlus',
    displayName: '直播弹幕发送栏 (可发送版)',
    tags: [componentsTags.live],
    author: {
      name: AUTHOR,
      link: `https://github.com/${GITHUB}`,
    },
    description:
      '在直播播放器底部提供弹幕输入栏, 支持插入表情, 直接调用发送接口并显示真实结果(成功 / 系统过滤 / 直播间屏蔽 / 错误码). 适用于网页全屏与全屏下的弹幕发送.',
    urlInclude: [/^https:\/\/live\.bilibili\.com\/(?:blanc\/)?\d+(?:[\/?#]|$)/],
    entry: start,
    reload: () => {
      stop();
      start();
    },
    unload: stop,
  });
})()
