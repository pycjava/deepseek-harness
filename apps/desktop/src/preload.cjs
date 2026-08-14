// @ts-check
/**
 * Preload for the DeepSeek Harness desktop shell.
 *
 * Injects a custom frameless title bar into the dsh web UI and bridges its
 * buttons to the main process over IPC. The title bar reuses the app's own CSS
 * variables (--dsw-*), so its colors track the light/dark theme with no
 * hard-coded palette. The SPA source is untouched — only injected nodes.
 *
 * Runs under contextIsolation + sandbox; DOM is shared with the page, so we can
 * build the bar in the page document while staying isolated from its JS.
 */
'use strict'

const { ipcRenderer } = require('electron')

const TITLEBAR_HEIGHT = 36

// Brand whale (from apps/web/public/favicon.svg), recolored via currentColor.
// eslint-disable-next-line @stylistic/js/max-len
const LOGO_PATH = 'M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z'

const svg = (inner, size = 11) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none" aria-hidden="true" focusable="false">${inner}</svg>`

const ICONS = {
  // eslint-disable-next-line @stylistic/js/max-len
  logo: `<svg width="16" height="16" viewBox="0 0 50 50" aria-hidden="true" focusable="false"><path fill="currentColor" d="${LOGO_PATH}"/></svg>`,
  minimize: svg('<rect x="1" y="5.25" width="9" height="1" fill="currentColor"/>'),
  maximize: svg('<rect x="1.25" y="1.25" width="8.5" height="8.5" stroke="currentColor" stroke-width="1" fill="none"/>'),
  restore: svg('<rect x="3" y="1" width="7" height="7" stroke="currentColor" stroke-width="1" fill="none"/><rect x="1" y="3" width="7" height="7" stroke="currentColor" stroke-width="1" fill="none"/>'),
  // eslint-disable-next-line @stylistic/js/max-len
  close: svg('<path d="M1.5 1.5 L9.5 9.5 M9.5 1.5 L1.5 9.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="square"/>'),
}

const STYLES = `
  #dsh-titlebar {
    position: fixed; top: 0; left: 0; right: 0;
    height: ${TITLEBAR_HEIGHT}px;
    display: flex; align-items: center; justify-content: space-between;
    padding-left: 12px;
    background: var(--dsw-alias-bg-base, #151517);
    border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2));
    color: var(--dsw-alias-label-primary, #f9fafb);
    font-family: var(--dsw-font-family, system-ui, sans-serif);
    font-size: 13px;
    -webkit-app-region: drag;
    -webkit-user-select: none;
    user-select: none;
    z-index: 2147483647;
  }
  .dsh-tb-brand {
    display: flex; align-items: center; gap: 8px;
    font-weight: 500; letter-spacing: 0.01em; opacity: 0.82;
  }
  .dsh-tb-logo { display: inline-flex; color: var(--dsw-alias-label-primary, #f9fafb); }
  .dsh-tb-controls {
    display: flex; align-items: center; height: 100%;
    -webkit-app-region: no-drag;
  }
  .dsh-tb-btn {
    width: 46px; height: ${TITLEBAR_HEIGHT}px;
    border: none; background: transparent; padding: 0; margin: 0;
    color: var(--dsw-alias-label-secondary, #cfd3d6);
    display: inline-flex; align-items: center; justify-content: center;
    cursor: default; outline: none;
  }
  .dsh-tb-btn:hover { background: var(--dsw-alias-fill-control-hover, rgba(128,128,128,0.15)); color: var(--dsw-alias-label-primary, currentColor); }
  .dsh-tb-btn:active { background: var(--dsw-alias-fill-control-active, rgba(128,128,128,0.25)); }
  .dsh-tb-btn[data-act="toggle"] .dsh-tb-restore { display: none; }
  .dsh-tb-btn[data-act="toggle"][data-maximized="true"] .dsh-tb-max { display: none; }
  .dsh-tb-btn[data-act="toggle"][data-maximized="true"] .dsh-tb-restore { display: inline-flex; }
  .dsh-tb-btn[data-act="close"]:hover { background: #e81123; color: #ffffff; }
  /* Push the SPA down by the title-bar height. #root is height:100% in the app,
     so box-sizing keeps its total height at 100% while its content box shrinks,
     keeping the bottom of the layout from being clipped. */
  #root { padding-top: ${TITLEBAR_HEIGHT}px; box-sizing: border-box; }
`

/** Build and inject the title bar into the page document. */
function injectTitlebar () {
  if (document.getElementById('dsh-titlebar')) return

  const style = document.createElement('style')
  style.id = 'dsh-titlebar-style'
  style.textContent = STYLES
  document.head.appendChild(style)

  const bar = document.createElement('div')
  bar.id = 'dsh-titlebar'
  bar.innerHTML = `
    <div class="dsh-tb-brand">
      <span class="dsh-tb-logo">${ICONS.logo}</span>
      <span class="dsh-tb-title">DeepSeek Harness</span>
    </div>
    <div class="dsh-tb-controls">
      <button class="dsh-tb-btn" type="button" data-act="minimize" title="最小化" aria-label="最小化">${ICONS.minimize}</button>
      <button class="dsh-tb-btn" type="button" data-act="toggle" title="最大化" aria-label="最大化">
        <span class="dsh-tb-max">${ICONS.maximize}</span><span class="dsh-tb-restore">${ICONS.restore}</span>
      </button>
      <button class="dsh-tb-btn" type="button" data-act="close" title="关闭" aria-label="关闭">${ICONS.close}</button>
    </div>
  `
  document.body.prepend(bar)

  bar.querySelector('.dsh-tb-controls').addEventListener('click', (event) => {
    const btn = event.target.closest('.dsh-tb-btn')
    if (!btn) return
    const act = btn.dataset.act
    if (act === 'minimize') ipcRenderer.send('win:minimize')
    else if (act === 'toggle') ipcRenderer.send('win:toggle-maximize')
    else if (act === 'close') ipcRenderer.send('win:close')
  })

  const toggleBtn = bar.querySelector('[data-act="toggle"]')
  ipcRenderer.on('win:maximize-changed', (_event, maximized) => {
    toggleBtn.dataset.maximized = String(maximized)
    toggleBtn.title = maximized ? '向下还原' : '最大化'
  })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectTitlebar)
} else {
  injectTitlebar()
}
