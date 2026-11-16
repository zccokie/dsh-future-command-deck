/**
 * Future Command Deck — Client half.
 *
 * The whole visual transformation lives here; the Host half is inert.
 * Registered into the Web page:
 *   1. a theme token override layer (future-tech palette, light + dark),
 *   2. one full-frame HUD overlay (grid, corner brackets, scan sweep),
 *   3. one `conversation.input.dock` entry that sits between the blank-session
 *      hero row and the composer card: the sector (workspace) selection deck
 *      while the Session is blank, the live-operations progress panel once the
 *      Session has content.
 */
window.__ModuleLoader__.load({
  id: 'dsh-future-command-deck',
  factory(require) {
    const React = require('react')
    const el = React.createElement
    const { useEffect, useMemo, useRef, useState } = React
    /**
     * Layout-effect variant: some hand-offs must land before the browser paints
     * (the launch fade below), and the fallback keeps the plugin working on a
     * React build that only ships useEffect.
     */
    const useLayoutEffect = React.useLayoutEffect ?? React.useEffect

    /**
     * Minimal observable value shared by two slot roots (the Session-scoped
     * command deck and the root-scoped session dock) that cannot pass props to
     * each other. Read through useStoreValue below.
     */
    function createValueStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set(next) {
          if (Object.is(value, next)) return
          value = next
          for (const listener of [...listeners]) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      }
    }

    /**
     * Live Session-log namespace, captured by {@link bindSessionLogNamespace}
     * inside an injected scope. Read through the getter below, never assigned
     * from a component.
     */
    const sessionLogNamespaceRef = { value: null }
    /** Current main-view Session id, published by the deck, read by the dock. */
    const currentSessionStore = createValueStore(undefined)
    /** Session created by the latest sector click, highlighted in the dock. */
    const lastDockedStore = createValueStore(undefined)
    /** Whether the top-right session dock is showing. */
    const dockHiddenStore = createValueStore(false)
    /** Main view mode published by the deck: 'sector' (主战区) or 'live'. */
    const mainModeStore = createValueStore(undefined)
    /**
     * Per-Session pin for the deck mode. A Session first seen in 主战区 stays on
     * the 主战区 screen even after its first task starts running (the output goes
     * to the dock); only an explicit open from a panel switches it to the
     * conversation (live) surface.
     */
    const deckModeOverrides = createValueStore(new Map())

    /** Pin one Session's deck mode ('sector' | 'live'). */
    function pinDeckMode(sessionId, mode) {
      if (sessionId === undefined) return
      const current = deckModeOverrides.get()
      if (current.get(sessionId) === mode) return
      const next = new Map(current)
      next.set(sessionId, mode)
      deckModeOverrides.set(next)
    }

    /**
     * Subscribe to a store. `useSyncExternalStore` is preferred (no tearing);
     * the fallback keeps the component working on a React build without it.
     */
    function useStoreValue(store) {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(store.subscribe, store.get, store.get)
      }
      const [value, setValue] = useState(store.get)
      useEffect(() => {
        const sync = () => setValue(store.get())
        sync()
        return store.subscribe(sync)
      }, [store])
      return value
    }

    /** Locale namespace owned by this package (dictionaries registered in apply). */
    const NS = 'future-command-deck'
    /** Stable package id; also the identity of the theme override layer. */
    const PACKAGE_ID = 'dsh-future-command-deck'
    /** Stylesheet tag id, so a reload never stacks duplicate style elements. */
    const STYLE_ID = 'future-command-deck/command-deck.css'
    /** `<html>` attribute that turns on focus mode (only the content column). */
    const FOCUS_ATTR = 'data-fcd-focus'
    /** localStorage key remembering the chosen shell mode across reloads. */
    const FOCUS_KEY = 'fcd.focus'
    /** `<html>` attribute present while the session dock occupies the top-right. */
    const DOCK_ATTR = 'data-fcd-dock'
    /**
     * `<html>` attribute present during the "launch" hand-off: from the frame the
     * Host switches the sending Session to its conversation layout until the new
     * 主战区 Session is on screen. The stylesheet fades the content column out of
     * that window so the two layout swaps never flash in front of the user.
     */
    const LAUNCH_ATTR = 'data-fcd-launching'
    /** Breathing room between the game panel and the input area below it (px). */
    const PANEL_CHROME_GAP = 10
    /** When the launch hand-off started, so the fade never holds too long. */
    let launchFadeStartedAt = 0
    /** How long the content column stays hidden before it fades back in (ms). */
    const LAUNCH_FADE_HOLD = 220
    /** Hard stop: the content column is never hidden longer than this (ms). */
    const LAUNCH_FADE_MAX = 1200

    /**
     * Fade the content column out immediately (called from a layout effect, so the
     * intermediate 对话 layout of the sending Session never paints), and arm a
     * hard-stop timer in case the follow-up Session never arrives.
     */
    function beginLaunchFade() {
      if (typeof document === 'undefined') return
      launchFadeStartedAt = Date.now()
      document.documentElement.setAttribute(LAUNCH_ATTR, '1')
      window.setTimeout(endLaunchFade, LAUNCH_FADE_MAX)
    }

    /**
     * Let the content column fade back in. Called by the deck once the new
     * 主战区 Session is mounted and blank; the hold length is measured from
     * {@link beginLaunchFade} so a fast hand-off still gets a readable transition.
     */
    function endLaunchFade() {
      if (typeof document === 'undefined') return
      const root = document.documentElement
      if (!root.hasAttribute(LAUNCH_ATTR)) return
      const wait = Math.max(0, LAUNCH_FADE_HOLD - (Date.now() - launchFadeStartedAt))
      window.setTimeout(() => {
        root.removeAttribute(LAUNCH_ATTR)
      }, wait)
    }

    // ---------------------------------------------------------------------
    // Shell mode (focus / full)
    // ---------------------------------------------------------------------

    /**
     * Read the stored shell mode. A missing value means "focus", so a fresh
     * launch opens as a bare command console; the user's explicit choice to
     * show the full shell is remembered instead.
     * @returns true when focus mode should be active.
     */
    function readFocusPreference() {
      try {
        const raw = window.localStorage.getItem(FOCUS_KEY)
        return raw === null ? true : raw === '1'
      } catch {
        // Private mode or a blocked storage backend: fall back to the default.
        return true
      }
    }

    /**
     * Install/remove the glass token layer; assigned by `apply` (it needs the
     * theme service). No-op until then.
     */
    let syncGlassTokens = () => {}

    /**
     * Reflect the shell mode on `<html>`; every focus-mode rule in the
     * stylesheet is scoped to this attribute, so removing it restores the
     * shipped three-column shell exactly.
     *
     * It also moves the **glass token layer**: translucent surfaces are a
     * cockpit-only look. In 完整界面 the layer is dropped, so Settings, the
     * Plugin Manager and every dialog get the shipped opaque backgrounds
     * instead of showing the canvas through their forms.
     *
     * @param on - whether focus mode should be active.
     */
    function applyFocusAttribute(on) {
      if (typeof document === 'undefined') return
      const root = document.documentElement
      if (on) root.setAttribute(FOCUS_ATTR, '1')
      else root.removeAttribute(FOCUS_ATTR)
      syncGlassTokens(on === true)
    }

    /** Persist the chosen shell mode; failures are cosmetic and ignored. */
    function writeFocusPreference(on) {
      try {
        window.localStorage.setItem(FOCUS_KEY, on ? '1' : '0')
      } catch {
        // Storage unavailable: the mode still applies for this page's lifetime.
      }
    }

    // ---------------------------------------------------------------------
    // Panel view (content / 赛博工地)
    // ---------------------------------------------------------------------

    /**
     * `<html>` attribute selecting what fills the Session panel while the user
     * is inside one specific Session: `content` (the native chat flow) or
     * `game` (the 赛博工地 overlay that runs on tool calls).
     *
     * Only the stylesheet's `[data-fcd-view="game"]` rules act on `game`; the
     * attribute is a pure view switch, so removing it restores the chat flow
     * without touching the host's layout.
     */
    const VIEW_ATTR = 'data-fcd-view'
    /** localStorage key remembering the chosen panel view across reloads. */
    const VIEW_KEY = 'fcd.view'
    /** The two panel views, in switch order. */
    const VIEW_CONTENT = 'content'
    const VIEW_GAME = 'game'
    /**
     * Shared value: the current panel view. Two slot roots need it — the switch
     * lives inside the arena overlay, the stylesheet needs the attribute — and
     * slot roots cannot pass props to each other, so it goes through a store.
     */
    const viewModeStore = createValueStore(VIEW_CONTENT)

    /**
     * Read the stored panel view. A missing or unrecognised value means
     * "content": the chat flow is the safe default, the game is opt-in.
     */
    function readViewPreference() {
      try {
        const raw = window.localStorage.getItem(VIEW_KEY)
        return raw === VIEW_GAME ? VIEW_GAME : VIEW_CONTENT
      } catch {
        return VIEW_CONTENT
      }
    }

    /** Persist the chosen panel view; storage failures stay cosmetic. */
    function writeViewPreference(view) {
      try {
        window.localStorage.setItem(VIEW_KEY, view)
      } catch {
        // Storage unavailable: the view still applies for this page's lifetime.
      }
    }

    /** Reflect the panel view on `<html>` for the stylesheet to key off. */
    function applyViewAttribute(view) {
      if (typeof document === 'undefined') return
      document.documentElement.setAttribute(VIEW_ATTR, view === VIEW_GAME ? VIEW_GAME : VIEW_CONTENT)
    }

    /**
     * Switch the panel view: store → attribute → localStorage, in that order,
     * so React re-renders from the store and the stylesheet follows in the same
     * tick (no frame where the game is mounted but the chat flow is still up).
     */
    function setPanelView(view) {
      const next = view === VIEW_GAME ? VIEW_GAME : VIEW_CONTENT
      viewModeStore.set(next)
      applyViewAttribute(next)
      writeViewPreference(next)
      // 切回内容时让聊天流重新贴底：它被 visibility 隐藏期间仍在滚动，
      // 但宿主可能因为尺寸没变而不再自动跟随，切回来手动补一次更稳。
      if (next === VIEW_CONTENT && typeof window !== 'undefined') {
        window.requestAnimationFrame(() => {
          const scroller = document.querySelector('[data-conversation-scroll]')
          if (scroller !== null) scroller.scrollTop = scroller.scrollHeight
        })
      }
    }

    // ---------------------------------------------------------------------
    // Theme
    // ---------------------------------------------------------------------

    /**
     * Theme token overrides: a deep-space command console in dark mode and a
     * cold cryo-lab variant in light mode. Every token carries both palettes
     * because `overrideTokens` picks one per active color scheme — a single
     * value would go illegible when the user switches scheme.
     *
     * Split in two layers:
     * - `THEME_TOKENS` — colours that never reveal the canvas (borders, text,
     *   states, buttons). Always stacked.
     * - `GLASS_TOKENS` — surfaces that do. Stacked only in focus mode.
     */
    const THEME_TOKENS = {
      // Borders: cyan-tinted hairlines instead of neutral grey
      '--dsw-alias-border-l1': { light: '#0e749019', dark: '#22d3ee1a' },
      '--dsw-alias-border-l2': { light: '#0e74902e', dark: '#22d3ee30' },
      '--dsw-alias-border-l3': { light: '#0e749040', dark: '#22d3ee42' },
      '--dsw-alias-border-l4': { light: '#0e749059', dark: '#22d3ee59' },

      // Brand accent
      '--dsw-alias-brand-primary': { light: '#0e8fb0', dark: '#22d3ee' },
      '--dsw-alias-brand-text': { light: '#0b6f8a', dark: '#7ceaff' },
      '--dsw-alias-brand-primary-invert': { light: '#ffffff', dark: '#03121a' },
      '--dsw-alias-button-info-fill': { light: '#0e8fb0', dark: '#22d3ee' },
      '--dsw-alias-button-info-hover': { light: '#0b7a95', dark: '#67e8f9' },

      // Text
      '--dsw-alias-label-primary': { light: '#07222f', dark: '#e4f7ff' },
      '--dsw-alias-label-secondary': { light: '#2d5064', dark: '#9fc0d2' },
      '--dsw-alias-label-tertiary': { light: '#517284', dark: '#7196aa' },
      '--dsw-alias-label-caption': { light: '#6a899c', dark: '#587c92' },
      '--dsw-alias-label-dimmed': { light: '#88a3b3', dark: '#446274' },
      '--dsw-alias-link': { light: '#0b7a95', dark: '#4dd6f0' },

      // States
      '--dsw-alias-state-business-primary': { light: '#0e8fb0', dark: '#22d3ee' },
      '--dsw-alias-state-business-tertiary': { light: '#0e8fb03d', dark: '#22d3ee3d' },
      '--dsw-alias-state-success-primary': { light: '#0f9d76', dark: '#2fe3a5' },
      '--dsw-alias-state-done-primary': { light: '#0f9d76', dark: '#2fe3a5' },
      '--dsw-alias-state-warn-primary': { light: '#b45309', dark: '#ffb937' },
      '--dsw-alias-state-error-primary': { light: '#d92d4f', dark: '#ff5c7a' },
      '--dsw-alias-state-idle-primary': { light: '#63808f', dark: '#6f93a8' },

      // Buttons and interactivity
      '--dsw-alias-button-primary-fill': { light: '#0e8fb0', dark: '#22d3ee' },
      '--dsw-alias-button-primary-hover': { light: '#0b7a95', dark: '#67e8f9' },
      '--dsw-alias-button-primary-dimmed': { light: '#0e8fb026', dark: '#22d3ee33' },
      '--dsw-alias-button-contrast-fill': { light: '#07222f', dark: '#d8f6ff' },
      '--dsw-alias-button-elevated-fill': { light: '#ffffff', dark: '#0e1728' },
      '--dsw-alias-button-floating-fill': { light: '#ffffff', dark: '#0a1120' },
      '--dsw-alias-button-floating-hover': { light: '#eef6fc', dark: '#152238' },
      '--dsw-alias-interactive-bg-hover': { light: '#0e749014', dark: '#22d3ee14' },
      '--dsw-alias-interactive-bg-active': { light: '#0e749022', dark: '#22d3ee26' },
      '--dsw-alias-interactive-bg-hover-solid': { light: '#e9f2fa', dark: '#152238' },

      // Composer, menus, markdown chrome
      '--dsw-alias-tooltip-bg': { light: '#07222f', dark: '#0b1526' },
      '--dsw-alias-scrollbar-bg-l1': { light: '#0e749040', dark: '#22d3ee33' },
      '--dsw-alias-scrollbar-hover-l1': { light: '#0e749080', dark: '#22d3ee66' },
    }

    /**
     * Glass surfaces: the only tokens that let the canvas show through.
     *
     * They are stacked as a **separate layer and only while focus mode is on**
     * (`data-fcd-focus`). That is what keeps 完整界面 honest: the glassy
     * `bg-base`/`bg-layer-*` values used to be global, so every Settings /
     * Plugin Manager window came out translucent and hard to read.
     */
    const GLASS_TOKENS = {
      // Surfaces
      '--dsw-alias-bg-base': { light: 'transparent', dark: 'transparent' },
      '--dsw-alias-bg-layer-1': { light: 'rgba(255,255,255,0.62)', dark: 'rgba(10,17,32,0.60)' },
      '--dsw-alias-bg-layer-2': { light: 'rgba(244,249,253,0.58)', dark: 'rgba(14,23,40,0.52)' },
      '--dsw-alias-bg-layer-3': { light: 'rgba(233,242,250,0.66)', dark: 'rgba(18,31,51,0.58)' },
      '--dsw-alias-bg-overlay': { light: 'rgba(255,255,255,0.94)', dark: 'rgba(10,17,32,0.92)' },
      '--dsw-alias-bg-module-platform': { light: 'rgba(244,249,253,0.7)', dark: 'rgba(14,23,40,0.62)' },
      '--dsw-alias-bg-multi-select': { light: 'rgba(233,242,250,0.75)', dark: 'rgba(18,31,51,0.68)' },
      '--dsw-alias-bg-skeleton': { light: '#0e74901f', dark: '#22d3ee1f' },
      '--dsw-specific-sidebar-fill': { light: 'rgba(231,241,250,0.55)', dark: 'rgba(4,7,14,0.52)' },

      // Composer, menus, markdown chrome
      '--dsw-specific-input-major': { light: 'rgba(255,255,255,0.72)', dark: 'rgba(10,18,32,0.58)' },
      '--dsw-specific-bubble': { light: 'rgba(232,243,251,0.78)', dark: 'rgba(14,23,40,0.62)' },
      '--dsw-specific-menu': { light: 'rgba(255,255,255,0.94)', dark: 'rgba(12,20,36,0.92)' },
      '--dsw-specific-selector': { light: 'rgba(244,249,253,0.8)', dark: 'rgba(16,28,48,0.7)' },
      '--dsw-specific-tip': { light: 'rgba(244,249,253,0.86)', dark: 'rgba(14,23,40,0.82)' },
      '--dsw-alias-markdown-code-block': { light: 'rgba(244,249,253,0.72)', dark: 'rgba(6,13,24,0.55)' },
      '--dsw-alias-markdown-code-block-banner': { light: 'rgba(233,242,250,0.8)', dark: 'rgba(11,21,38,0.6)' },
      '--dsw-alias-markdown-inline-code': { light: 'rgba(233,242,250,0.85)', dark: 'rgba(11,21,38,0.6)' },
      '--dsw-alias-menu-group-header-fill': { light: 'rgba(244,249,253,0.85)', dark: 'rgba(11,21,38,0.8)' },
      '--dsw-alias-toast-bg': { light: 'rgba(255,255,255,0.95)', dark: 'rgba(14,23,40,0.9)' },
      '--dsw-alias-turn-trigger-bg': { light: 'rgba(244,249,253,0.72)', dark: 'rgba(11,21,38,0.6)' },
      '--dsw-alias-turn-trigger-bg-hover': { light: 'rgba(233,242,250,0.85)', dark: 'rgba(21,34,56,0.7)' },
    }

    // ---------------------------------------------------------------------
    // Stylesheet
    // ---------------------------------------------------------------------

    /** All classes are `fcd-` prefixed; only theme tokens are shared with the host. */
    const CSS = `
.fcd-deck{
  --fcd-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  position:relative;isolation:isolate;box-sizing:border-box;
  flex:none;align-self:stretch;
  margin:0 0 2px;padding:9px 12px 11px;
  border-radius:12px;border:0;
  background:
    radial-gradient(120% 150% at 0% 0%,color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent) 0%,transparent 58%),
    linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-bg-layer-1) 96%,transparent),color-mix(in srgb,var(--dsw-alias-bg-base) 98%,transparent));
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,transparent),
    0 18px 44px -30px color-mix(in srgb,var(--dsw-alias-brand-primary) 75%,transparent);
  color:var(--dsw-alias-label-secondary);
  font-size:12px;line-height:1.35;overflow:hidden;container-type:inline-size;
}
.fcd-deck[data-mode="sector"]{
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent),
    0 26px 60px -46px color-mix(in srgb,var(--dsw-alias-brand-primary) 90%,transparent);
}
/* 实时执行面板与输入框卡片同宽并居中，保持主内容区的居中轴线 */
.fcd-deck[data-mode="live"]{
  width:min(calc(var(--dsh-composer-card-max-width,920px) - 2 * var(--dsh-composer-dock-inset,8px)),100%);
  margin-inline:auto;
}
/* --- 执行中：呼吸光晕 + 边框扫描光 --------------------------------------
   实时执行面板在 running 时把 data-running 置 true，这里长出两样东西：
   1) 一圈会呼吸的外发光 —— box-shadow 画在卡片盒外，不受 overflow:hidden 影响
      （那一条只裁子元素）；两套值之间插值，2.6s 一个来回。
   2) 一道绕边框跑的扫描光 —— ::after 用「双层遮罩求差」只在边缘留 1px 的环，
      再用 @property 把 conic-gradient 的起始角从 0 推到 360deg。
      @property 不被支持时角不动，退化成静态高光边，不会报错也不会闪。
   两条动效都在 prefers-reduced-motion 里关掉。 */
@property --fcd-sweep{
  syntax:'<angle>';inherits:false;initial-value:0deg}
.fcd-deck[data-running="true"]{
  animation:fcd-deckHalo 2.6s ease-in-out infinite}
@keyframes fcd-deckHalo{
  0%,100%{box-shadow:
    inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent),
    0 18px 44px -30px color-mix(in srgb,var(--dsw-alias-brand-primary) 90%,transparent),
    0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent),
    0 0 18px -6px color-mix(in srgb,var(--dsw-alias-brand-primary) 28%,transparent),
    0 0 46px -14px color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}
  50%{box-shadow:
    inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent),
    0 18px 44px -30px color-mix(in srgb,var(--dsw-alias-brand-primary) 95%,transparent),
    0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent),
    0 0 30px -2px color-mix(in srgb,var(--dsw-alias-brand-primary) 46%,transparent),
    0 0 74px -10px color-mix(in srgb,var(--dsw-alias-brand-primary) 34%,transparent)}}
.fcd-deck[data-running="true"]::after{
  content:'';position:absolute;inset:0;z-index:2;border-radius:inherit;pointer-events:none;
  padding:1px;
  background:conic-gradient(from var(--fcd-sweep),
    transparent 0deg 246deg,
    color-mix(in srgb,var(--dsw-alias-brand-primary) 0%,transparent) 258deg,
    color-mix(in srgb,var(--dsw-alias-brand-primary) 85%,transparent) 306deg,
    color-mix(in srgb,var(--dsw-alias-state-success-primary) 70%,transparent) 322deg,
    transparent 338deg 360deg);
  -webkit-mask:linear-gradient(#000,#000) content-box,linear-gradient(#000,#000);
  -webkit-mask-composite:xor;
  mask:linear-gradient(#000,#000) content-box,linear-gradient(#000,#000);
  mask-composite:exclude;
  animation:fcd-deckSweep 3.8s linear infinite}
@keyframes fcd-deckSweep{to{--fcd-sweep:360deg}}

.fcd-sheen{
  position:absolute;left:0;right:0;top:0;height:44%;pointer-events:none;z-index:0;
  background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent),transparent);
  animation:fcd-sheen 7s ease-in-out infinite;
}
.fcd-corners{position:absolute;inset:0;pointer-events:none;z-index:1}
.fcd-corner{position:absolute;width:12px;height:12px;border-color:var(--dsw-alias-brand-primary);opacity:.75}
.fcd-corner[data-c="tl"]{top:5px;left:5px;border-top:1px solid;border-left:1px solid;border-top-left-radius:3px}
.fcd-corner[data-c="tr"]{top:5px;right:5px;border-top:1px solid;border-right:1px solid;border-top-right-radius:3px}
.fcd-corner[data-c="bl"]{bottom:5px;left:5px;border-bottom:1px solid;border-left:1px solid;border-bottom-left-radius:3px}
.fcd-corner[data-c="br"]{bottom:5px;right:5px;border-bottom:1px solid;border-right:1px solid;border-bottom-right-radius:3px}

.fcd-head{position:relative;z-index:2;display:flex;align-items:center;gap:7px;min-height:20px}
.fcd-mark{width:7px;height:7px;flex:none;transform:rotate(45deg);background:var(--dsw-alias-brand-primary);
  box-shadow:0 0 9px color-mix(in srgb,var(--dsw-alias-brand-primary) 85%,transparent)}
.fcd-title{font-size:10.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--dsw-alias-brand-primary);white-space:nowrap}
.fcd-sub{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.fcd-rule{flex:1;min-width:10px;height:1px;
  background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 46%,transparent),transparent)}
.fcd-pill{display:inline-flex;align-items:center;gap:5px;height:18px;padding:0 7px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);
  font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;white-space:nowrap}
.fcd-pill[data-live="true"]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,transparent);color:var(--dsw-alias-state-success-primary)}
.fcd-pillDot{width:5px;height:5px;border-radius:50%;background:currentColor;box-shadow:0 0 6px currentColor;flex:none}
.fcd-pill[data-live="true"] .fcd-pillDot{animation:fcd-pulse 1.6s ease-in-out infinite}
.fcd-toggle{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;flex:none;
  border-radius:6px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0}
.fcd-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.fcd-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.fcd-toggle svg{width:12px;height:12px;transition:transform .2s ease}
.fcd-toggle[data-expanded="true"] svg{transform:rotate(180deg)}

.fcd-body{position:relative;z-index:2;margin-top:8px}
.fcd-sectors{display:grid;grid-template-columns:repeat(auto-fill,minmax(186px,1fr));gap:8px;max-height:262px;overflow-y:auto;scrollbar-width:thin;padding-right:2px}
.fcd-sector{position:relative;display:flex;flex-direction:column;gap:3px;min-height:74px;
  padding:8px 10px 9px;border-radius:10px;text-align:left;cursor:pointer;font:inherit;color:inherit;
  border:1px solid var(--dsw-alias-border-l2);
  background:linear-gradient(160deg,color-mix(in srgb,var(--dsw-alias-bg-layer-2) 92%,transparent),color-mix(in srgb,var(--dsw-alias-bg-base) 60%,transparent));
  transition:border-color .18s ease,box-shadow .18s ease,transform .18s ease}
.fcd-sector:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 72%,transparent);
  box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary) 32%,transparent),
    0 16px 28px -22px color-mix(in srgb,var(--dsw-alias-brand-primary) 95%,transparent);transform:translateY(-1px)}
.fcd-sector:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.fcd-sector[disabled]{opacity:.55;cursor:progress}
.fcd-sector[data-current="true"]{border-color:var(--dsw-alias-brand-primary);
  background:linear-gradient(160deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 17%,transparent),color-mix(in srgb,var(--dsw-alias-bg-base) 70%,transparent) 72%)}
.fcd-sector[data-current="true"]::after{content:"";position:absolute;left:10px;right:10px;top:0;height:1px;
  background:linear-gradient(90deg,transparent,var(--dsw-alias-brand-primary),transparent)}
.fcd-sectorTop{display:flex;align-items:center;gap:6px;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dsw-alias-label-caption)}
.fcd-sectorCode{color:var(--dsw-alias-brand-primary);font-family:var(--fcd-mono);font-variant-numeric:tabular-nums}
.fcd-sectorTag{margin-left:auto;font-size:9px;letter-spacing:.12em;color:var(--dsw-alias-brand-primary)}
.fcd-sectorName{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fcd-sectorPath{font-family:var(--fcd-mono);font-size:10.5px;color:var(--dsw-alias-label-tertiary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fcd-deploy{margin-left:auto;color:var(--dsw-alias-brand-primary);opacity:0;transition:opacity .15s ease;letter-spacing:.1em}
.fcd-sector:hover .fcd-deploy,.fcd-sector:focus-visible .fcd-deploy{opacity:1}
.fcd-sectorMeta{display:flex;align-items:center;gap:8px;margin-top:auto;padding-top:3px;
  font-size:10px;letter-spacing:.05em;color:var(--dsw-alias-label-caption);font-family:var(--fcd-mono)}
.fcd-sectorGhost{align-items:center;justify-content:center;text-align:center;border-style:dashed;
  color:var(--dsw-alias-label-tertiary);background:transparent;gap:4px}
.fcd-sectorGhost:hover{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}
.fcd-ghostIcon{font-size:15px;line-height:1;color:var(--dsw-alias-brand-primary)}
.fcd-ghostLabel{font-size:11.5px;font-weight:600;color:inherit}
.fcd-ghostHint{font-size:10px;letter-spacing:.06em;color:var(--dsw-alias-label-caption)}
.fcd-placeholder{display:flex;align-items:center;gap:8px;height:74px;padding:0 12px;border-radius:10px;
  border:1px dashed var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-size:11.5px}
.fcd-spinner{width:12px;height:12px;border-radius:50%;flex:none;
  border:1.5px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent);
  border-top-color:var(--dsw-alias-brand-primary);animation:fcd-spin .9s linear infinite}

.fcd-live{display:grid;gap:10px;grid-template-columns:minmax(0,1fr) minmax(0,1.05fr)}
@container (max-width:560px){.fcd-live{grid-template-columns:minmax(0,1fr)}}
.fcd-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(92px,1fr));gap:6px;align-content:start}
.fcd-metric{padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 70%,transparent);min-width:0}
.fcd-metricLabel{font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--dsw-alias-label-caption);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fcd-metricValue{font-family:var(--fcd-mono);font-size:13px;color:var(--dsw-alias-label-primary);
  font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fcd-planHead{display:flex;align-items:baseline;gap:7px;min-width:0}
.fcd-planLabel{font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dsw-alias-label-caption)}
.fcd-planValue{margin-left:auto;font-family:var(--fcd-mono);font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.fcd-bar{position:relative;height:6px;margin:6px 0 7px;border-radius:999px;overflow:hidden;
  background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}
.fcd-barFill{position:absolute;inset:0 auto 0 0;border-radius:999px;
  background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 58%,transparent),var(--dsw-alias-brand-primary));
  box-shadow:0 0 10px color-mix(in srgb,var(--dsw-alias-brand-primary) 70%,transparent);
  transition:width .45s cubic-bezier(.22,1,.36,1)}
.fcd-bar[data-live="true"] .fcd-barFill::after{content:"";position:absolute;inset:0;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);
  transform:translateX(-100%);animation:fcd-sweep 1.9s linear infinite}
.fcd-tasks{display:flex;flex-direction:column;gap:4px;max-height:84px;overflow:auto;
  scrollbar-width:thin;padding-right:2px}
.fcd-task{display:flex;align-items:center;gap:7px;min-width:0;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.fcd-taskDot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}
.fcd-task[data-status="in_progress"] .fcd-taskDot{background:var(--dsw-alias-state-business-primary);box-shadow:0 0 8px currentColor;animation:fcd-pulse 1.6s ease-in-out infinite}
.fcd-task[data-status="completed"] .fcd-taskDot{background:var(--dsw-alias-state-success-primary)}
.fcd-taskText{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fcd-task[data-status="completed"] .fcd-taskText{color:var(--dsw-alias-label-caption);text-decoration:line-through}
.fcd-empty{font-size:11.5px;color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;gap:7px;min-width:0}
.fcd-goalText{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}
.fcd-eq{display:inline-flex;align-items:flex-end;gap:2px;height:11px}
.fcd-eq span{display:block;width:2px;border-radius:1px;background:var(--dsw-alias-brand-primary);opacity:.85}
.fcd-eq span:nth-child(1){height:4px;animation:fcd-eq 1.1s ease-in-out infinite .05s}
.fcd-eq span:nth-child(2){height:9px;animation:fcd-eq 1.1s ease-in-out infinite .18s}
.fcd-eq span:nth-child(3){height:6px;animation:fcd-eq 1.1s ease-in-out infinite .32s}
.fcd-eq span:nth-child(4){height:10px;animation:fcd-eq 1.1s ease-in-out infinite .44s}
.fcd-eq span:nth-child(5){height:5px;animation:fcd-eq 1.1s ease-in-out infinite .58s}
.fcd-error{margin:7px 0 0;font-size:11px;color:var(--dsw-alias-state-error-primary);
  overflow-wrap:anywhere}

/* --- 透明背景：画布渐变在最底层，面板与输入框是玻璃层 ---------------
   宿主把 body 的背景色设成 --dsw-alias-bg-base；该令牌是 transparent，
   因此画布渐变从面板后面透出来。深/浅两套渐变用 :has() 跟随宿主主题属性。 */
:root{background:
    radial-gradient(85% 65% at 12% -10%, rgba(8,145,178,0.16), transparent 62%),
    radial-gradient(70% 55% at 88% -6%, rgba(124,92,255,0.12), transparent 60%),
    radial-gradient(120% 90% at 50% 118%, rgba(14,116,144,0.14), transparent 72%),
    #eef5fb;
  background-attachment:fixed}
:root:has(body[data-ds-dark-theme]){background:
    radial-gradient(85% 65% at 12% -10%, rgba(34,211,238,0.16), transparent 62%),
    radial-gradient(70% 55% at 88% -6%, rgba(124,92,255,0.13), transparent 60%),
    radial-gradient(120% 90% at 50% 118%, rgba(9,82,120,0.22), transparent 72%),
    #04070e;
  background-attachment:fixed}

/* --- 底部输入区：毛玻璃 ------------------------------------------------
   宿主在对话版式里给输入区座位铺的那层遮罩依赖 --dsw-alias-bg-base，而本皮肤
   把这个令牌改成了 transparent —— 遮罩于是变成「透明 → 透明」，正文会一直滚
   到输入框底下、从玻璃卡片后面透出来。
   这里不补不透明底色（那会在画布上压出一块死板的色块），而是把整块底部做成
   毛玻璃：座位 [data-composer-seat] 自己做 backdrop blur，把滚到它下面的正文
   磨砂掉；::before 再叠一层向下渐浓的 layer-1 半透明，并配 30px 的淡入蒙版，
   让磨砂边界的过渡是渐显而不是一刀切。
   注意 blur 必须挂在座位本身而不是 ::before 上：座位带 will-change:transform，
   对子元素来说是 backdrop root，挂在子元素上会「滤不到」后面真正的正文。
   生效条件沿用宿主那份规则的前提：[data-phase="active"]（对话版式）或
   [data-content-phase="active"]（右侧栏内嵌对话）。
   另加一条：**只在聚焦模式**。完整界面不套玻璃（表层令牌也已撤掉），输入区
   回到宿主原本的实心座位，不再叠 blur 和渐隐蒙版。 */
html[data-fcd-focus="1"] [data-phase="active"] [data-composer-seat],
html[data-fcd-focus="1"] [data-content-phase="active"] [data-composer-seat]{
  -webkit-backdrop-filter:blur(18px) saturate(1.25);
  backdrop-filter:blur(18px) saturate(1.25)}
html[data-fcd-focus="1"] [data-phase="active"] [data-composer-seat]::before,
html[data-fcd-focus="1"] [data-content-phase="active"] [data-composer-seat]::before{
  content:'';position:absolute;inset:0;z-index:-1;pointer-events:none;
  background:linear-gradient(180deg,
    color-mix(in srgb,var(--dsw-alias-bg-layer-1) 0%,transparent) 0px,
    color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent) 30px);
  -webkit-mask-image:linear-gradient(180deg,transparent 0px,#000 30px);
  mask-image:linear-gradient(180deg,transparent 0px,#000 30px)}
/* 我的面板与输入区加毛玻璃，让背景真的“透”出来 */
.fcd-deck,.fcd-dock{-webkit-backdrop-filter:blur(20px) saturate(1.2);backdrop-filter:blur(20px) saturate(1.2)}

/* --- 会话输出面板：把主区域的聊天流包成一块玻璃面板 ---------------
   [data-slot="conversation.chat.flow"] 的直接父节点就是聊天列（宿主按内容宽度居中），
   用 :has() 选中它包一层卡片外观；只在**聚焦模式 + 对话中**生效，
   完整界面与主战区界面都保持宿主原样。 */
html[data-fcd-focus="1"][data-fcd-mode="live"] div:has(> [data-slot="conversation.chat.flow"]){
  box-sizing:border-box;
  padding:12px 16px;
  border-radius:14px;
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent);
  -webkit-backdrop-filter:blur(20px) saturate(1.2);
  backdrop-filter:blur(20px) saturate(1.2);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,transparent),
    0 30px 70px -60px color-mix(in srgb,var(--dsw-alias-brand-primary) 90%,transparent);
  margin-block:10px;
  /* 宽表格 / 代码块 / 长 URL 会横向溢出，从圆角外面「穿」出去：
     这里横向裁在圆角内（clip 不产生滚动容器，也不动竖向），
     竖向上仍由内部的滚动容器负责，sticky 代码条的行为不变。
     overflow-y 必须显式写 visible：clip 与 visible 是允许的组合，
     写成 hidden 反而会多造一个滚动容器。 */
  overflow-x:clip;
  overflow-y:visible;
  isolation:isolate;
}

/* --- 浮层面板只在聚焦模式下出现 ---------------------------------------
   完整界面（三栏）交给宿主自己的布局，左右两块浮层面板一律隐藏；
   连装饰网格也一起收掉——那套网格是驾驶舱的皮肤，不该盖在设置/插件页上。 */
html:not([data-fcd-focus="1"]) .fcd-sectorPanel,
html:not([data-fcd-focus="1"]) .fcd-dock{display:none !important}
html:not([data-fcd-focus="1"]) .fcd-hudGrid{display:none !important}

/* --- 会话坞（右上角）：只做导航的窄版看板 -----------------------------
   主内容区保持居中，坞以浮层形式贴在右上角；内容列不做任何让位。
   宽度只留给「标题 / 所属战区 / 相对时间」三样东西：原来最宽 330px（主战区
   再放宽到 min(320px,28vw)），现在统一收窄，主战区不再单独放宽，坞在两种
   界面下是同一条窄边栏。
   宽度与左下的「战区会话」面板（.fcd-sectorPanel）完全一致：
   两边都是 min(208px,17vw)，窄窗口一起按 17vw 收缩，左右永远等宽。 */
.fcd-dock{position:absolute;right:16px;top:40px;z-index:3;box-sizing:border-box;
  width:min(208px,17vw);
  padding:8px 10px 6px;border-radius:12px;pointer-events:auto;border:0;
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 84%,transparent);
  box-shadow:0 28px 64px -44px rgba(0,0,0,.95),inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,transparent)}
html[data-fcd-focus="1"] .fcd-dock{top:34px}
/* 窄坞里放不下第二串标语：头部只留「会话坞 + 进行中计数 + 收起」 */
.fcd-dock .fcd-sub{display:none}
html[data-fcd-mode="sector"] .fcd-list{max-height:min(48vh,460px)}
.fcd-dockHead{display:flex;align-items:center;gap:6px;min-height:20px}
.fcd-picker{display:flex;align-items:center;gap:6px;width:100%;margin-top:6px;padding:5px 7px;
  border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 70%,transparent);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;cursor:pointer;text-align:left;min-width:0}
.fcd-picker:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent)}
.fcd-picker:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.fcd-pickerTitle{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
.fcd-pickerWhere{flex:none;max-width:38%;font-size:10px;color:var(--dsw-alias-label-tertiary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fcd-pickerCaret{flex:none;font-size:9px;color:var(--dsw-alias-label-caption);transition:transform .15s ease}
.fcd-pickerCaret[data-open="true"]{transform:rotate(180deg)}
.fcd-menu{margin-top:4px;max-height:min(42vh,330px);overflow-y:auto;scrollbar-width:thin;
  border-radius:8px;border:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 80%,transparent);padding:4px}
.fcd-menuGroup+.fcd-menuGroup{margin-top:2px}
.fcd-menuGroupTitle{font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--dsw-alias-label-caption);padding:4px 6px 2px}
.fcd-menuItem{display:flex;align-items:center;gap:6px;width:100%;padding:4px 6px;border:0;border-radius:6px;
  background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;text-align:left}
.fcd-menuItem:hover{background:var(--dsw-alias-interactive-bg-hover)}
.fcd-menuItem[data-selected="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);
  color:var(--dsw-alias-label-primary)}
.fcd-menuItem:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.fcd-menuLabel{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fcd-output{display:flex;flex-direction:column;gap:5px;width:100%;margin-top:6px;padding:7px 8px 8px;
  border-radius:9px;cursor:pointer;text-align:left;font:inherit;
  border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent);
  background:linear-gradient(160deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent),transparent 70%),
    color-mix(in srgb,var(--dsw-alias-bg-base) 45%,transparent)}
.fcd-output:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 60%,transparent);
  box-shadow:0 14px 30px -26px color-mix(in srgb,var(--dsw-alias-brand-primary) 95%,transparent)}
.fcd-output:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.fcd-outputHead{display:flex;align-items:center;gap:6px;min-width:0}
.fcd-outputLabel{font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--dsw-alias-label-caption)}
.fcd-outputOpen{margin-left:auto;font-size:11px;color:var(--dsw-alias-brand-primary);opacity:.8}
.fcd-outputText{display:-webkit-box;-webkit-line-clamp:8;-webkit-box-orient:vertical;overflow:hidden;
  font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.fcd-outputWhere{font-size:9.5px;letter-spacing:.08em;color:var(--dsw-alias-label-caption);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fcd-standby{display:flex;align-items:center;gap:8px;margin-top:6px;padding:14px 10px;border-radius:9px;
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 55%,transparent)}
.fcd-standbyDot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-caption);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-label-caption) 14%,transparent)}
.fcd-standbyText{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.fcd-rowDot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}
.fcd-rowDot[data-active="true"]{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 7px currentColor;
  animation:fcd-pulse 1.6s ease-in-out infinite}
/* 暂停在等用户确认：琥珀色、不呼吸（不是「活着」，是「等你」） */
.fcd-rowDot[data-wait="true"]{background:var(--dsw-alias-state-warning-primary,#f2b23c);
  box-shadow:0 0 7px color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f2b23c) 80%,transparent)}
.fcd-rowTag{flex:none;font-size:9px;letter-spacing:.08em;padding:1px 5px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.fcd-rowTag[data-live="true"]{color:var(--dsw-alias-state-success-primary);
  border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 52%,transparent)}
.fcd-list{display:flex;flex-direction:column;gap:1px;margin-top:6px;max-height:min(52vh,440px);
  overflow-y:auto;scrollbar-width:thin;padding-right:2px}
.fcd-item{display:flex;align-items:flex-start;gap:7px;width:100%;padding:6px 7px;border:0;border-radius:8px;
  background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;min-width:0}
.fcd-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.fcd-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.fcd-item[data-active="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,transparent)}
.fcd-itemMain{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
.fcd-itemTop{display:flex;align-items:center;gap:6px;min-width:0}
.fcd-itemTitle{flex:1;min-width:0;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-primary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fcd-itemBottom{display:flex;align-items:center;gap:6px;min-width:0;font-size:9.5px;color:var(--dsw-alias-label-caption)}
.fcd-itemWhere{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:.06em}
.fcd-itemAge{flex:none;font-family:var(--fcd-mono);opacity:.85}
/* 下面这套「正文 / 思考过程 / Markdown」样式目前**没有挂载点**：窄版会话坞
   的每一行只渲染标题、所属战区与相对时间，不读会话日志也不折叠轮次。
   将来要恢复逐轮正文时，直接复用这组类名即可，不用重写排版。 */
.fcd-itemPreview{display:block;margin-top:2px;font-size:10.5px;line-height:1.45;
  color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.fcd-itemBody{display:block;margin-top:3px;font-size:10.5px;line-height:1.5;
  color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
/* --- 思考过程：照主面板的样子收成默认折叠的一块 --------------------------- */
.fcd-reason{margin-top:3px;padding-left:7px;
  border-left:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,transparent)}
.fcd-reasonHead{display:flex;align-items:center;gap:6px;width:100%;padding:2px 0;
  border:0;background:transparent;font:inherit;text-align:left;
  font-size:9.5px;letter-spacing:.06em;color:var(--dsw-alias-label-caption);
  cursor:pointer;user-select:none}
.fcd-reasonHead:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.fcd-reasonHead::before{content:'▸';flex:none;font-size:8px;line-height:1;
  color:var(--dsw-alias-label-caption);transition:transform .15s ease}
.fcd-reasonHead[data-open="true"]::before{transform:rotate(90deg)}
.fcd-reasonHead:hover .fcd-reasonLabel{color:var(--dsw-alias-label-secondary)}
.fcd-reasonLabel{flex:none}
.fcd-reasonMeta{flex:none;opacity:.7;font-variant-numeric:tabular-nums}
.fcd-reasonBody{margin:2px 0 4px;font-size:10.5px;line-height:1.5;
  color:var(--dsw-alias-label-tertiary)}
.fcd-reasonBody .fcd-mdH{font-size:11px;color:var(--dsw-alias-label-secondary)}
.fcd-reasonRow{margin-top:4px}
/* --- 会话坞正文：Markdown 排版（完整输出，不截断） ------------------------- */
.fcd-md{display:block}
.fcd-md > *:first-child{margin-top:0}
.fcd-md > *:last-child{margin-bottom:0}
.fcd-md p{margin:4px 0}
.fcd-md .fcd-mdH{margin:8px 0 3px;font-size:11.5px;font-weight:600;line-height:1.3;
  color:var(--dsw-alias-label-primary)}
.fcd-md h1.fcd-mdH,.fcd-md h2.fcd-mdH{font-size:12.5px}
.fcd-md h3.fcd-mdH{font-size:12px}
.fcd-md strong{color:var(--dsw-alias-label-primary);font-weight:600}
.fcd-md em{font-style:italic}
.fcd-md del{opacity:.65}
.fcd-md a{color:var(--dsw-alias-brand-primary);text-decoration:underline;text-underline-offset:2px}
.fcd-md hr{border:0;border-top:1px solid var(--dsw-alias-border-l2);margin:7px 0}
.fcd-md ul,.fcd-md ol{margin:4px 0;padding-left:16px}
.fcd-md ul{list-style:disc}
.fcd-md ol{list-style:decimal}
.fcd-md li{margin:1px 0;line-height:1.5}
.fcd-md blockquote{margin:5px 0;padding:2px 0 2px 8px;
  border-left:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent);
  color:var(--dsw-alias-label-tertiary)}
.fcd-md table{border-collapse:collapse;margin:5px 0;width:100%;font-size:10px;display:block;overflow-x:auto}
.fcd-md th,.fcd-md td{border:1px solid var(--dsw-alias-border-l2);padding:2px 5px;text-align:left;
  vertical-align:top}
.fcd-md th{color:var(--dsw-alias-label-primary);font-weight:600;
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 60%,transparent)}
.fcd-md .fcd-mdInlineCode{padding:0 3px;border-radius:4px;font-family:var(--fcd-mono);font-size:10px;
  color:var(--dsw-alias-label-primary);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 75%,transparent)}
.fcd-md .fcd-mdCode{position:relative;margin:5px 0;padding:6px 7px;border-radius:7px;
  overflow-x:auto;font-family:var(--fcd-mono);font-size:10px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 78%,transparent)}
.fcd-md .fcd-mdCode code{display:block;white-space:pre;line-height:1.45;
  color:var(--dsw-alias-label-primary)}
.fcd-md .fcd-mdLang{position:absolute;top:3px;right:6px;font-size:8.5px;letter-spacing:.1em;
  text-transform:uppercase;color:var(--dsw-alias-label-caption)}
/* --- 主战区整块下移，贴近输入区底部 -------------------------------------- */
html[data-fcd-mode="sector"] [data-conversation-scroll]{justify-content:flex-end !important;
  padding-bottom:14px}

/* --- 发射转场：主内容列淡出 -> 新战区界面淡入 ---------------------------
   在主战区发消息时，宿主会先把这条会话切成「对话」版式（英雄区消失、
   输入框掉到底部、聊天流出现），随后插件再把主视图换成同一战区的新空白会话。
   这两次版式跳变如果直接渲染出来就是「页面跳一下」：
   [data-fcd-launching] 期间把整个内容列压到透明（且关闭过渡，保证跳变那
   一帧完全画不出来），新会话就位后再由 CSS 过渡淡入，观感上是一次跃迁。 */
[data-conversation-content]{transition:opacity .18s ease}
html[data-fcd-launching="1"] [data-conversation-content]{
  opacity:0;
  transition:none !important}
@media (prefers-reduced-motion:reduce){
  [data-conversation-content]{transition:none}
}
.fcd-sectorPanel{position:absolute;left:16px;top:40px;z-index:3;width:min(208px,17vw);box-sizing:border-box;
  padding:8px 9px 6px;border-radius:12px;pointer-events:auto;border:0;
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 82%,transparent);
  -webkit-backdrop-filter:blur(20px) saturate(1.2);backdrop-filter:blur(20px) saturate(1.2);
  box-shadow:0 28px 64px -44px rgba(0,0,0,.95),inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,transparent)}
html[data-fcd-focus="1"] .fcd-sectorPanel{top:34px}
.fcd-sectorPanel .fcd-title{font-size:10px;letter-spacing:.1em}
.fcd-sectorPanel .fcd-sub{display:none}
.fcd-listNarrow{max-height:min(52vh,430px);gap:0;margin-top:5px}
.fcd-itemTight{align-items:center;gap:6px;padding:5px 6px 5px 7px;border-radius:6px;
  transition:background-color .14s ease,box-shadow .14s ease}
.fcd-itemTight .fcd-itemMain{flex-direction:row;align-items:center;gap:6px;min-width:0}
.fcd-itemTight .fcd-itemTitle{font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary);
  letter-spacing:.01em;line-height:1.35}
.fcd-itemTight:hover .fcd-itemTitle{color:var(--dsw-alias-label-primary)}
.fcd-itemTight .fcd-itemTitle[data-current="true"]{color:var(--dsw-alias-brand-primary);font-weight:600}
.fcd-itemTight .fcd-itemAge{flex:none;min-width:30px;text-align:right;font-family:var(--fcd-mono);
  font-size:9px;line-height:1;letter-spacing:0;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-caption)}
.fcd-itemTight[data-active="true"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent)}
.fcd-itemTight[data-active="true"] .fcd-itemTitle{color:var(--dsw-alias-label-primary)}
.fcd-itemTight[data-current="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 13%,transparent);
  box-shadow:inset 2px 0 0 0 var(--dsw-alias-brand-primary)}
.fcd-sectorPanel .fcd-pill{height:15px;padding:0 5px;border:0;font-family:var(--fcd-mono);
  font-size:9px;letter-spacing:0;color:var(--dsw-alias-label-tertiary);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 70%,transparent)}
.fcd-dockHint{margin:6px 0 0;font-size:9.5px;letter-spacing:.06em;color:var(--dsw-alias-label-caption);text-align:center}
.fcd-homeButton{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:6px;
  cursor:pointer;white-space:nowrap;font-size:10px;letter-spacing:.1em;
  border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);
  color:var(--dsw-alias-brand-primary)}
.fcd-homeButton:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent)}
.fcd-homeButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.fcd-homeGlyph{font-size:12px;line-height:1}
.fcd-notice{margin:7px 0 0;font-size:11px;color:var(--dsw-alias-brand-primary);overflow-wrap:anywhere}

.fcd-focusToggle{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 7px;border-radius:6px;
  cursor:pointer;white-space:nowrap;font-size:10px;letter-spacing:.1em;
  border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-tertiary);
  transition:color .15s ease,border-color .15s ease,background-color .15s ease}
.fcd-focusToggle:hover{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent)}
.fcd-focusToggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.fcd-focusToggle[data-on="true"]{color:var(--dsw-alias-brand-primary);
  border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 48%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.fcd-focusToggle svg{width:11px;height:11px;flex:none}

/* --- 聚焦模式：只保留中间内容列 ------------------------------------------
   html 上的 data-fcd-focus 由 apply 挂上/摘掉，摘掉即完全恢复原三栏布局。
   选择器只用宿主稳定的 data-* 属性（slot 名、拖拽把手 side、窗口拖拽区），
   不依赖任何哈希类名。 */
html[data-fcd-focus="1"] div:has(> [data-shell-overlay]){
  grid-template-columns:0 minmax(0,1fr) 0 !important}
html[data-fcd-focus="1"] [data-slot="sidebar"],
html[data-fcd-focus="1"] [data-slot="rightbar"],
html[data-fcd-focus="1"] [data-side="sidebar"],
html[data-fcd-focus="1"] [data-side="rightbar"]{display:none !important}
/* 会话标题栏保留为一条窄的可拖动条（macOS 窗口拖动区在 header 上），
   但清掉标题、标签、工具等全部内容。 */
html[data-fcd-focus="1"] [data-slot="conversation.header"] > header{
  min-height:26px !important;padding:8px 0 0 !important;
  border-bottom:0 !important;background:transparent !important;
  grid-template-columns:minmax(0,1fr) !important}
html[data-fcd-focus="1"] [data-slot="conversation.header"] > header > *{display:none !important}


.fcd-emblem{color:var(--dsw-alias-brand-primary);filter:drop-shadow(0 0 10px color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent))}
.fcd-emblemRing{transform-origin:32px 32px;animation:fcd-orbit 22s linear infinite}
@keyframes fcd-orbit{to{transform:rotate(360deg)}}

.fcd-hud{position:absolute;inset:0;pointer-events:none;overflow:hidden}.fcd-hudGrid{position:absolute;inset:0;opacity:.55;
  background-image:
    linear-gradient(color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent) 1px,transparent 1px),
    linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent) 1px,transparent 1px);
  background-size:52px 52px;
  -webkit-mask-image:radial-gradient(135% 105% at 50% 45%,transparent 44%,#000 100%);
  mask-image:radial-gradient(135% 105% at 50% 45%,transparent 44%,#000 100%)}
.fcd-exitChip{position:absolute;top:30px;right:16px;z-index:2;pointer-events:auto;
  display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 9px;border-radius:999px;cursor:pointer;
  border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-bg-base) 84%,transparent);
  -webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);
  color:var(--dsw-alias-brand-primary);font-size:10px;letter-spacing:.1em;white-space:nowrap;
  box-shadow:0 10px 26px -18px color-mix(in srgb,var(--dsw-alias-brand-primary) 90%,transparent)}
.fcd-exitChip:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,transparent)}
.fcd-exitChip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.fcd-exitChip svg{width:11px;height:11px;flex:none}

/* ---------------------------------------------------------------------
   会话面板的两种视图：内容 / 赛博工地
   data-fcd-view 挂在 <html> 上（见 applyViewAttribute）。切到 game 时聊天流
   只做 visibility 隐藏：布局尺寸一点不动，宿主的滚动容器、自动贴底、流式
   追加全部照旧，切回来就是原样；游戏画面画在同一块矩形上。
   --------------------------------------------------------------------- */
html[data-fcd-focus="1"][data-fcd-mode="live"][data-fcd-view="game"] [data-slot="conversation.chat.flow"]{
  visibility:hidden}

/* 量出来的定位容器：fixed 全屏、不参与布局，内部按面板实测矩形摆放。
   组件会用自己的 rect 校正原点，所以外壳有没有 transform 都不影响。 */
.fcd-arenaRoot{position:fixed;inset:0;z-index:900;pointer-events:none}

/* 视图切换：内容 / 工地。贴在面板右上角，两种视图下位置一致。 */
.fcd-viewSwitch{position:absolute;z-index:6;display:inline-flex;align-items:stretch;gap:0;
  box-sizing:border-box;height:26px;padding:2px;border-radius:999px;pointer-events:auto;
  cursor:pointer;user-select:none;-webkit-user-select:none;
  background:color-mix(in srgb,var(--dsw-alias-bg-base) 80%,transparent);
  -webkit-backdrop-filter:blur(10px) saturate(1.2);backdrop-filter:blur(10px) saturate(1.2);
  box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent),
    0 12px 26px -22px rgba(0,0,0,.9)}
.fcd-viewSwitch button{display:inline-flex;flex:1 1 auto;align-items:center;justify-content:center;gap:4px;
  min-height:22px;padding:0 10px;
  border:0;border-radius:999px;cursor:pointer;background:transparent;
  touch-action:manipulation;-webkit-tap-highlight-color:transparent;
  color:var(--dsw-alias-label-caption);font-size:10.5px;letter-spacing:.08em;white-space:nowrap;
  transition:background-color .16s ease,color .16s ease}
.fcd-viewSwitch button:hover{color:var(--dsw-alias-label-primary)}
.fcd-viewSwitch button[data-on="true"]{
  /* 本插件的 --dsw-alias-bg-base 是 transparent（画布在最底层），
     所以选中态的文字用固定的深色，不再借用背景令牌。 */
  color:#04101f;
  background:linear-gradient(180deg,
    color-mix(in srgb,var(--dsw-alias-brand-primary) 92%,transparent),
    color-mix(in srgb,var(--dsw-alias-brand-primary) 72%,transparent))}
.fcd-viewSwitch button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.fcd-viewSwitch svg{width:10px;height:10px;flex:none}

/* 游戏面板本体：和会话输出卡片同尺寸、同圆角，叠在它上面。 */
.fcd-arena{position:absolute;box-sizing:border-box;border-radius:14px;overflow:hidden;
  /* 面板是纯展示层：不吃事件，避免任何子元素（画布/扫描层/句子卡）挡住上面的胶囊 */
  pointer-events:none;isolation:isolate;transition:opacity .2s ease;
  background:linear-gradient(180deg,#08102a 0%,#0b142e 58%,#101a34 100%);
  box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent),
    0 30px 70px -60px color-mix(in srgb,var(--dsw-alias-brand-primary) 90%,transparent)}
.fcd-arena canvas{display:block;width:100%;height:100%;
  /* 盘面可以拖：只有画布吃指针，面板其余部分仍然透明不拦事件 */
  pointer-events:auto;cursor:grab;touch-action:none}
.fcd-arena canvas[data-dragging="true"]{cursor:grabbing}
/* 扫描线 / 暗角：给画面一层 CRT 味，纯装饰、不吃事件 */
.fcd-arenaVignette{position:absolute;inset:0;pointer-events:none;
  background:
    repeating-linear-gradient(180deg,rgba(140,200,255,.05) 0 1px,transparent 1px 3px),
    radial-gradient(120% 90% at 50% 40%,transparent 52%,rgba(2,6,18,.72) 100%)}

/* HUD：全部走主题令牌，位置在画面上方，上下两组 */
.fcd-arenaHud{position:absolute;inset:0;pointer-events:none;
  display:flex;flex-direction:column;justify-content:space-between;
  padding:10px 12px;font-family:var(--fcd-mono)}
/* 罗盘贴在左边：HUD 一律靠右，左半圈留给盘面 */
.fcd-arenaHudTop{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap;
  justify-content:flex-end;padding-right:172px}
.fcd-arenaHudBottom{display:flex;align-items:flex-end;justify-content:flex-end;gap:8px}
/* 胶囊现在挂在根层（不下面板），下面这条只是兜底：万一被放进面板也别被压住 */
.fcd-arena .fcd-viewSwitch{z-index:6}
.fcd-arenaHead{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px 0 7px;
  border-radius:999px;background:rgba(6,12,28,.62);
  box-shadow:inset 0 0 0 1px rgba(120,190,255,.18);color:#cfe6ff;
  font-size:10px;letter-spacing:.14em;white-space:nowrap;
  -webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.fcd-arenaHead .fcd-mark{background:#57d2ff;box-shadow:0 0 10px rgba(87,210,255,.9)}
.fcd-arenaDot{width:6px;height:6px;border-radius:50%;background:#57d2ff;flex:none;
  box-shadow:0 0 8px rgba(87,210,255,.9)}
.fcd-arena[data-live="false"] .fcd-arenaDot{background:#f2b23c;box-shadow:0 0 8px rgba(242,178,60,.8)}
/* 读不到会话日志时的提示：不抢戏，但要能看见 */
.fcd-arenaSignal{display:inline-flex;align-items:center;height:16px;padding:0 5px;margin-left:2px;
  border-radius:4px;background:rgba(255,150,90,.16);color:#ffb27a;font-size:9px;letter-spacing:.08em;
  box-shadow:inset 0 0 0 1px rgba(255,150,90,.32)}
/* 统计条：楼层 / 连击 / 四类工具计数 */
.fcd-arenaStats{display:inline-flex;align-items:center;gap:10px;height:22px;padding:0 10px;
  overflow:hidden;
  border-radius:999px;background:rgba(6,12,28,.58);
  box-shadow:inset 0 0 0 1px rgba(120,190,255,.14);color:#a8c6e6;
  font-size:10px;letter-spacing:.06em;white-space:nowrap;
  -webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.fcd-arenaStat{display:inline-flex;align-items:center;gap:4px}
.fcd-arenaStat b{color:#eaf6ff;font-weight:600;font-variant-numeric:tabular-nums}
.fcd-arenaStat[data-kind="combo"] b{color:#ffd479}
/* 左侧：当前动作 + 最近三条工具流水 */
.fcd-arenaTicker{display:flex;flex-direction:column;align-items:flex-end;gap:4px;min-width:0;
  max-width:min(58%,520px);text-align:right}
.fcd-arenaNow{display:inline-flex;align-items:center;gap:6px;
  color:#dceeff;font-size:11px;letter-spacing:.04em;
  text-shadow:0 1px 8px rgba(2,8,20,.9)}
.fcd-arenaNow span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fcd-arenaChips{display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end}
.fcd-arenaChip{display:inline-flex;align-items:center;gap:3px;height:18px;padding:0 6px;border-radius:5px;
  background:rgba(8,16,34,.66);box-shadow:inset 0 0 0 1px rgba(120,190,255,.13);
  color:#9fbdd9;font-size:9.5px;letter-spacing:.04em;white-space:nowrap;
  max-width:160px;overflow:hidden;text-overflow:ellipsis}
.fcd-arenaChip[data-err="true"]{color:#ff9a9a;box-shadow:inset 0 0 0 1px rgba(255,120,120,.3)}
.fcd-arenaChip i{font-style:normal;opacity:.7;flex:none}
/* 右下：楼层徽标 */
.fcd-arenaFloor{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 10px;
  border-radius:999px;background:rgba(6,12,28,.58);
  box-shadow:inset 0 0 0 1px rgba(120,190,255,.14);color:#8fb2d2;font-size:10px;letter-spacing:.1em}
.fcd-arenaFloor b{color:#eaf6ff;font-size:15px;line-height:1;letter-spacing:0;
  font-variant-numeric:tabular-nums}
.fcd-arenaDial{display:inline-flex;align-items:center;gap:6px}
.fcd-arenaFloor .fcd-arenaMountain{font-family:"Songti SC","STSong","Noto Serif CJK SC",serif;
  font-size:13px;letter-spacing:0;color:#ffd479;margin-right:1px}
@media (prefers-reduced-motion:reduce){
  .fcd-arena{transition:none}
}

/* 罗盘旁边轮番出现的句子：右侧偏下，宋体竖排感（窄卡片 + 高行距），
   一轮结束换成「发现古墓」，朱印变色。 */
.fcd-arenaQuote{position:absolute;left:52%;top:calc(50% + 44px);z-index:2;
  display:flex;align-items:flex-start;gap:9px;max-width:min(40%,340px);
  padding:10px 12px 11px;border-radius:10px;pointer-events:none;
  background:linear-gradient(180deg,rgba(8,15,28,.55),rgba(6,11,22,.42));
  box-shadow:inset 0 0 0 1px rgba(120,190,255,.12),0 18px 40px -34px rgba(0,0,0,.9);
  -webkit-backdrop-filter:blur(8px) saturate(1.1);backdrop-filter:blur(8px) saturate(1.1);
  transition:background .3s ease,box-shadow .3s ease,opacity .45s ease,transform .45s ease}
.fcd-arenaQuote[data-hidden="true"]{opacity:0;transform:translateY(8px);pointer-events:none}
.fcd-arenaSeal{flex:none;width:18px;height:18px;border-radius:3px;display:inline-flex;
  align-items:center;justify-content:center;margin-top:1px;
  font-family:"Songti SC","STSong","Noto Serif CJK SC",serif;font-size:9px;line-height:1;
  color:#0b0f16;background:#c9a05a;box-shadow:0 0 0 1px rgba(201,160,90,.5)}
.fcd-arenaQuoteText{font-family:"Songti SC","STSong","Noto Serif CJK SC","Source Han Serif SC",serif;
  font-size:14px;line-height:1.7;letter-spacing:.08em;color:#c7dced;
  animation:fcd-quote-in .55s ease both}
.fcd-arenaQuote[data-found="true"]{background:linear-gradient(180deg,rgba(46,14,12,.6),rgba(24,8,8,.5));
  box-shadow:inset 0 0 0 1px rgba(232,80,60,.45),0 18px 40px -34px rgba(0,0,0,.9)}
.fcd-arenaQuote[data-found="true"] .fcd-arenaSeal{background:#e8503c;color:#120607;
  box-shadow:0 0 0 1px rgba(232,80,60,.6),0 0 12px rgba(232,80,60,.4)}
.fcd-arenaQuote[data-found="true"] .fcd-arenaQuoteText{color:#ffd479;font-size:15px;letter-spacing:.1em}
@keyframes fcd-quote-in{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.fcd-arenaQuoteText{animation:none}}

@keyframes fcd-sheen{0%,100%{opacity:.35;transform:translateY(-6%)}50%{opacity:.85;transform:translateY(6%)}}
@keyframes fcd-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes fcd-spin{to{transform:rotate(360deg)}}
@keyframes fcd-sweep{0%{transform:translateX(-100%)}100%{transform:translateX(220%)}}
@keyframes fcd-eq{0%,100%{transform:scaleY(.45)}50%{transform:scaleY(1)}}
@media (prefers-reduced-motion:reduce){
  .fcd-sheen,.fcd-spinner,.fcd-bar[data-live="true"] .fcd-barFill::after,
  .fcd-pill[data-live="true"] .fcd-pillDot,.fcd-taskDot,.fcd-eq span,.fcd-emblemRing,
  .fcd-deck[data-running="true"],.fcd-deck[data-running="true"]::after{animation:none}
  .fcd-sector{transition:none}
}
`

    /**
     * Insert this package's stylesheet once and hand back its disposer.
     * A reload of the Client half removes the previous tag through the effect,
     * so the check also covers the case where a tag survived a reload.
     */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const selector = 'style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']'
      if (document.querySelector(selector) !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = PACKAGE_ID
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }

    // ---------------------------------------------------------------------
    // Small helpers
    // ---------------------------------------------------------------------

    /** Hook stand-in used when a slot does not provide an optional standard prop. */
    function useNothing() {
      return undefined
    }

    /** Readable one-line description of a rejected promise. */
    function messageOf(reason) {
      if (reason instanceof Error) return reason.message
      return String(reason)
    }

    /** Stopwatch rendered as mm:ss (or hh:mm:ss past one hour). */
    function formatClock(ms) {
      const total = Math.max(0, Math.floor(ms / 1000))
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      const pad = (value) => (value < 10 ? '0' + String(value) : String(value))
      return (hours > 0 ? pad(hours) + ':' : '') + pad(minutes) + ':' + pad(seconds)
    }

    /** `S-01`-style sector code derived from list position. */
    function sectorCode(index) {
      const value = index + 1
      return 'S-' + (value < 10 ? '0' + String(value) : String(value))
    }

    /** Last path segment, used when a Workspace has no stored title. */
    function baseNameOf(path) {
      if (typeof path !== 'string' || path === '') return '—'
      const trimmed = path.replace(/[/\\]+$/, '')
      const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
      return cut === -1 ? trimmed : trimmed.slice(cut + 1)
    }

    /** Fold a todo projection into the counters the panel shows. */
    function summarizeTodos(todos) {
      const total = todos.length
      let done = 0
      const active = []
      for (const item of todos) {
        if (item.status === 'completed') done += 1
        else if (item.status === 'in_progress') active.push(item)
      }
      const percent = total === 0 ? 0 : Math.round((done / total) * 100)
      return { total, done, percent, active }
    }

    /**
     * Stopwatch that runs while `active` is true and keeps the start instant
     * across re-renders, so Uptime measures the running interval, not render age.
     */
    function useElapsed(active) {
      const [elapsed, setElapsed] = useState(0)
      const startedAt = useRef(null)
      useEffect(() => {
        if (!active) {
          startedAt.current = null
          setElapsed(0)
          return undefined
        }
        if (startedAt.current === null) startedAt.current = Date.now()
        const origin = startedAt.current
        setElapsed(Date.now() - origin)
        const timer = window.setInterval(() => {
          setElapsed(Date.now() - origin)
        }, 1000)
        return () => {
          window.clearInterval(timer)
        }
      }, [active])
      return elapsed
    }

    // ---------------------------------------------------------------------
    // Presentational pieces
    // ---------------------------------------------------------------------

    /** Four hairline brackets marking the panel's corners. */
    function Corners({ className }) {
      return el(
        'div',
        { className: className, 'aria-hidden': true },
        el('i', { className: 'fcd-corner', 'data-c': 'tl' }),
        el('i', { className: 'fcd-corner', 'data-c': 'tr' }),
        el('i', { className: 'fcd-corner', 'data-c': 'bl' }),
        el('i', { className: 'fcd-corner', 'data-c': 'br' }),
      )
    }

    /** Animated signal bars: only meaningful while the Session is executing. */
    function Equalizer() {      return el(
        'span',
        { className: 'fcd-eq', 'aria-hidden': true },
        el('span', null),
        el('span', null),
        el('span', null),
        el('span', null),
        el('span', null),
      )
    }

    /** Header chevron. */
    function Chevron() {
      return el(
        'svg',
        { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        el('path', {
          d: 'M4 6.5 8 10.5 12 6.5',
          stroke: 'currentColor',
          strokeWidth: '1.6',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** Focus-mode glyph: a frame with the content column marked. */
    function LayoutIcon() {
      return el(
        'svg',
        { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        el('rect', {
          x: 1.5, y: 2.5, width: 13, height: 11, rx: 1.6,
          stroke: 'currentColor', strokeWidth: '1.2', strokeOpacity: 0.75,
        }),
        el('path', { d: 'M4.6 2.5v11M1.5 2.5h13', stroke: 'currentColor', strokeWidth: '1.2', strokeOpacity: 0.35 }),
        el('rect', { x: 6.4, y: 5, width: 6.4, height: 6, rx: 1, fill: 'currentColor', fillOpacity: 0.55 }),
      )
    }

    /** One sector (workspace) tile. */
    function SectorTile({ item, index, current, running, busy, onPick, t }) {
      const title = typeof item.title === 'string' && item.title.trim() !== ''
        ? item.title
        : baseNameOf(item.path)
      const sessions = Array.isArray(item.sessionIds) ? item.sessionIds.length : 0
      return el(
        'button',
        {
          type: 'button',
          className: 'fcd-sector',
          'data-current': current ? 'true' : undefined,
          disabled: busy,
          title: item.path,
          'aria-label': t('deck.deploy') + ' ' + title + ' · ' + item.path,
          onClick: () => {
            onPick(item.workspaceId)
          },
        },
        el(
          'span',
          { className: 'fcd-sectorTop' },
          el('span', { className: 'fcd-sectorCode' }, sectorCode(index)),
          current ? el('span', { className: 'fcd-sectorTag' }, t('deck.current')) : null,
        ),
        el('span', { className: 'fcd-sectorName' }, title),
        el('span', { className: 'fcd-sectorPath' }, item.path),
        el(
          'span',
          { className: 'fcd-sectorMeta' },
          el('span', null, t('deck.sessions', { count: sessions })),
          // Only the current sector has a truthfully known run state; every
          // other tile offers the deploy affordance instead of a fake status.
          current
            ? el('span', null, (running ? '● ' : '○ ') + (running ? t('deck.running') : t('deck.idle')))
            : el('span', { className: 'fcd-deploy' }, t('deck.deploy') + ' →'),
        ),
      )
    }

    /** Sector grid: existing sectors plus the "open a new sector" ghost tile. */
    function SectorDeck({ items, phase, currentId, running, busy, onPick, onNew, t }) {
      if (phase === 'pending' && items.length === 0) {
        return el(
          'div',
          { className: 'fcd-sectors' },
          el(
            'div',
            { className: 'fcd-placeholder' },
            el('span', { className: 'fcd-spinner', 'aria-hidden': true }),
            el('span', null, t('deck.loading')),
          ),
        )
      }
      const tiles = items.map((item, index) =>
        el(SectorTile, {
          key: item.workspaceId,
          item,
          index,
          current: item.workspaceId === currentId,
          running,
          busy: busy,
          onPick,
          t,
        }))
      const ghost = el(
        'button',
        {
          key: '__new__',
          type: 'button',
          className: 'fcd-sector fcd-sectorGhost',
          disabled: busy,
          onClick: () => {
            onNew()
          },
        },
        el('span', { className: 'fcd-ghostIcon', 'aria-hidden': true }, '+'),
        el('span', { className: 'fcd-ghostLabel' }, t('deck.newSector')),
        el('span', { className: 'fcd-ghostHint' }, t('deck.newSectorHint')),
      )
      return el('div', { className: 'fcd-sectors' }, tiles, ghost)
    }

    /** Live operations panel: counters on the left, plan progress on the right. */
    function LiveDeck({ t, running, elapsed, todos, workspaceTitle, sessionId, goalObjective }) {
      const summary = summarizeTodos(todos)
      const recent = useMemo(() => {
        // Show in-progress work first, then the remaining plan, capped for the dock.
        const active = summary.active
        const rest = todos.filter((item) => item.status !== 'in_progress' && item.status !== 'completed')
        return [...active, ...rest].slice(0, 6)
        // `todos` is the projection snapshot (identity-stable until it changes).
      }, [todos])
      // Session ids carry a `session-` prefix; show the distinguishing head instead.
      const rawSession = typeof sessionId === 'string' ? sessionId : ''
      const bareSession = rawSession.startsWith('session-') ? rawSession.slice('session-'.length) : rawSession
      const shortSession = bareSession === '' ? '—' : bareSession.slice(0, 8)
      return el(
        'div',
        { className: 'fcd-live' },
        el(
          'div',
          { className: 'fcd-metrics' },
          el(
            'div',
            { className: 'fcd-metric' },
            el('div', { className: 'fcd-metricLabel' }, t('deck.elapsed')),
            el('div', { className: 'fcd-metricValue' }, formatClock(elapsed)),
          ),
          el(
            'div',
            { className: 'fcd-metric' },
            el('div', { className: 'fcd-metricLabel' }, t('deck.workspace')),
            el('div', { className: 'fcd-metricValue', title: workspaceTitle ?? '' }, workspaceTitle ?? '—'),
          ),
          el(
            'div',
            { className: 'fcd-metric' },
            el('div', { className: 'fcd-metricLabel' }, t('deck.session')),
            el('div', { className: 'fcd-metricValue' }, shortSession),
          ),
        ),
        el(
          'div',
          null,
          el(
            'div',
            { className: 'fcd-planHead' },
            el('span', { className: 'fcd-planLabel' }, t('deck.plan')),
            el(
              'span',
              { className: 'fcd-planValue' },
              summary.total === 0
                ? '—'
                : t('deck.complete', { done: summary.done, total: summary.total }),
            ),
          ),
          el(
            'div',
            {
              className: 'fcd-bar',
              'data-live': running ? 'true' : 'false',
              role: 'progressbar',
              'aria-valuemin': 0,
              'aria-valuemax': 100,
              'aria-valuenow': summary.percent,
              'aria-label': t('deck.plan'),
            },
            el('div', { className: 'fcd-barFill', style: { width: summary.percent + '%' } }),
          ),
          recent.length > 0
            ? el(
                'div',
                { className: 'fcd-tasks' },
                recent.map((item, index) =>
                  el(
                    'div',
                    { key: String(index) + ':' + item.content, className: 'fcd-task', 'data-status': item.status },
                    el('span', { className: 'fcd-taskDot', 'aria-hidden': true }),
                    el('span', { className: 'fcd-taskText', title: item.content }, item.content),
                  )),
              )
            : el(
                'div',
                { className: 'fcd-empty' },
                running ? el(Equalizer) : null,
                el(
                  'span',
                  { className: 'fcd-goalText', title: goalObjective ?? '' },
                  goalObjective === undefined || goalObjective === '' ? t('deck.noPlan') : '◎ ' + goalObjective,
                ),
              ),
        ),
      )
    }

    /**
     * The dock entry itself: chooses between the sector selection deck and the
     * live operations panel, owns the collapse state and the in-flight action.
     */
    function CommandDeck(props) {
      const { t, sessionId, openSector, openNewSector, openHome } = props
      // Optional standard props (see slot catalog); fall back to inert hooks so
      // the component still renders if an owner trims them.
      const useSession = props.useSession ?? useNothing
      const useSessionStatus = props.useSessionStatus ?? useNothing
      const useWorkspaces = props.useWorkspaces ?? useNothing
      const useProjection = props.useProjection ?? useNothing

      // 'blank' 还没有提示；'awaiting' 首轮任务正在跑（此时界面保持不变）；'active' 已有对话
      const stage = useSession((snapshot) => {
        if (snapshot === undefined) return 'blank'
        if (snapshot.blank === true) return 'blank'
        if (snapshot.awaitingFirstTurn === true) return 'awaiting'
        return 'active'
      })
      const workspaces = useWorkspaces((snapshot) => snapshot)
      const status = useSessionStatus((snapshot) => {
        if (sessionId === undefined) return undefined
        const entry = snapshot.get(sessionId)
        if (entry === undefined) return undefined
        return entry.running === true ? 'running' : 'idle'
      })
      const running = status === 'running'
      const todos = useProjection('todos') ?? []
      // The goal projection (when this profile carries one) supplies a mission
      // line while the run has no todo list yet.
      const goalProjection = useProjection('goal')
      const goalObjective = goalProjection === undefined || goalProjection === null
        ? undefined
        : goalProjection.goal?.objective

      const items = workspaces?.items ?? []
      const phase = workspaces?.phase ?? 'ready'
      const current = sessionId === undefined
        ? undefined
        : items.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId))

      const [manual, setManual] = useState(null)
      const [busy, setBusy] = useState(null)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      // 以 <html> 上的实际属性为准，避免与其他实例/热重载产生状态漂移
      const [focus, setFocus] = useState(() => typeof document !== 'undefined' && document.documentElement.hasAttribute(FOCUS_ATTR))
      const elapsed = useElapsed(running)

      // Share the main-view Session id and shell mode with the root-scoped dock.
      useEffect(() => {
        currentSessionStore.set(sessionId)
      }, [sessionId])

      // Docked-session confirmations clear themselves after a moment.
      useEffect(() => {
        if (notice === null) return undefined
        const timer = window.setTimeout(() => setNotice(null), 4500)
        return () => window.clearTimeout(timer)
      }, [notice])

      const toggleFocus = () => {
        setFocus((previous) => {
          const next = !previous
          applyFocusAttribute(next)
          writeFocusPreference(next)
          return next
        })
      }

      const pinned = useStoreValue(deckModeOverrides)
      // 在“主战区”里发起的会话一直留在主战区界面（输出走右上角会话坞），
      // 只有从左右面板显式点开才切到对话界面。
      useEffect(() => {
        if (sessionId === undefined) return
        if (stage === 'active') return
        // 已经显式从面板打开过的会话（pin = live）不再回钉到主战区
        if (pinned.has(sessionId)) return
        pinDeckMode(sessionId, 'sector')
      }, [sessionId, stage, pinned])
      const mode = stage === 'active' ? (pinned.get(sessionId) ?? 'live') : 'sector'

      // ---- 主战区「发射」语义 ---------------------------------------------
      // 在主战区里发起的任务：首轮被宿主受理的那一刻，主视图立刻回到**同一个
      // 战区**的空白新会话（战区选择界面原样不动），任务本身留在右上角会话坞里
      // 继续跑。想看某个任务的对话时，在会话坞 / 左上角面板里显式点开即可
      // （那会把这条会话 pin 成 live）。
      const launchedFromSector = useRef(new Set())

      // 新会话就位（又回到空白英雄区）后把内容列淡入回来，收掉发射转场。
      useLayoutEffect(() => {
        if (sessionId === undefined) return
        if (stage !== 'blank') return
        endLaunchFade()
      }, [sessionId, stage])

      // 用 layout effect：宿主把这条会话切成「对话」版式的那一帧，必须先把
      // 内容列淡出，否则英雄区→对话区→新英雄区的两次版式跳变会直接怼在眼前。
      useLayoutEffect(() => {
        if (sessionId === undefined) return
        // 还没发起任务（空白会话 / 未受理）就什么都不做，并允许这条会话下次再发射
        if (stage === 'blank') {
          launchedFromSector.current.delete(sessionId)
          return
        }
        // 只有仍处于「主战区」界面时才复位；显式打开的会话（live）保持原样
        if (mode !== 'sector') return
        // 同一条会话只复位一次，避免 stage 抖动时反复切视图
        if (launchedFromSector.current.has(sessionId)) return
        launchedFromSector.current.add(sessionId)
        beginLaunchFade()

        // 复位到同一战区的空白新会话；工作区列表还没就绪时退回「主战区」按钮的语义
        const workspaceId = current?.workspaceId
        const relaunch = () => {
          // 用户已经显式看别处了（主视图换人或切到对话界面）就不再抢主视图
          if (currentSessionStore.get() !== sessionId) return
          if (mainModeStore.get() !== 'sector') return
          const pending = workspaceId === undefined ? openHome() : openSector(workspaceId)
          Promise.resolve(pending).catch((reason) => {
            console.warn('[future-command-deck] 主战区复位失败:', reason)
          })
        }
        relaunch()
        // 宿主的会话列表里 blank 标记可能比本地快照晚一拍，那一拍里
        // openWorkspace 会把刚发起任务的会话当成空白会话复用；补一次重试是幂等的
        // （战区里已有空白会话时直接复用它，不会再建新的）。
        window.setTimeout(relaunch, 300)
      }, [sessionId, stage, mode])

      useEffect(() => {
        mainModeStore.set(mode)
        // 供样式表区分：live = 正在某个具体会话里（聊天流包成面板）
        document.documentElement.setAttribute('data-fcd-mode', mode)
      }, [mode])
      // Auto: the sector deck is always open, the live panel expands while work runs.
      const expanded = manual === null ? (mode === 'sector' || running) : manual
      const summary = summarizeTodos(todos)

      const pickSector = async (workspaceId) => {
        if (busy !== null) return
        setBusy(workspaceId)
        setError(null)
        try {
          await openSector(workspaceId)
          dockHiddenStore.set(false)
        } catch (reason) {
          setError(t('deck.openFailed', { message: messageOf(reason) }))
        } finally {
          setBusy(null)
        }
      }

      const pickNewSector = async () => {
        if (busy !== null) return
        setBusy('__new__')
        setError(null)
        try {
          await openNewSector()
        } catch (reason) {
          setError(t('deck.createFailed', { message: messageOf(reason) }))
        } finally {
          setBusy(null)
        }
      }

      const head = el(
        'header',
        { className: 'fcd-head' },
        el('span', { className: 'fcd-mark', 'aria-hidden': true }),
        el('span', { className: 'fcd-title' }, mode === 'sector' ? t('deck.sectorTitle') : t('deck.liveTitle')),
        el('span', { className: 'fcd-sub' }, mode === 'sector' ? t('deck.sectorSub') : t('deck.liveSub')),
        el('span', { className: 'fcd-rule', 'aria-hidden': true }),
        mode === 'live'
          ? el(
              'span',
              { className: 'fcd-pill', 'data-live': running ? 'true' : 'false' },
              el('span', { className: 'fcd-pillDot', 'aria-hidden': true }),
              el('span', null, running ? t('deck.running') : t('deck.idle')),
            )
          : el(
              'span',
              { className: 'fcd-pill' },
              el('span', null, t('deck.sectorCount', { count: items.length })),
            ),
        mode === 'live'
          ? el(
              'button',
              {
                type: 'button',
                className: 'fcd-homeButton',
                title: t('deck.homeHint'),
                'aria-label': t('deck.homeHint'),
                onClick: () => {
                  dockHiddenStore.set(false)
                  openHome()
                },
              },
              el('span', { className: 'fcd-homeGlyph', 'aria-hidden': true }, '⌂'),
              el('span', null, t('deck.home')),
            )
          : null,
        el(
          'button',
          {
            type: 'button',
            className: 'fcd-focusToggle',
            'data-on': focus ? 'true' : 'false',
            'aria-pressed': focus,
            title: focus ? t('deck.fullUiHint') : t('deck.focusHint'),
            'aria-label': focus ? t('deck.fullUiHint') : t('deck.focusHint'),
            onClick: toggleFocus,
          },
          el(LayoutIcon),
          el('span', null, focus ? t('deck.fullUi') : t('deck.focusMode')),
        ),
        el(
          'button',
          {
            type: 'button',
            className: 'fcd-toggle',
            'data-expanded': expanded ? 'true' : 'false',
            'aria-expanded': expanded,
            'aria-label': expanded ? t('deck.collapse') : t('deck.expand'),
            title: expanded ? t('deck.collapse') : t('deck.expand'),
            onClick: () => {
              setManual(!expanded)
            },
          },
          el(Chevron),
        ),
      )

      let body = null
      if (expanded) {
        body = el(
          'div',
          { className: 'fcd-body' },
          mode === 'sector'
            ? el(SectorDeck, {
                items,
                phase,
                currentId: current?.workspaceId,
                running,
                busy: busy !== null,
                onPick: pickSector,
                onNew: pickNewSector,
                t,
              })
            : el(LiveDeck, {
                t,
                running,
                elapsed,
                todos,
                workspaceTitle: current?.title ?? undefined,
                sessionId,
                goalObjective,
              }),
        )
      } else if (mode === 'live') {
        // Collapsed live panel keeps the essential readout on one line.
        body = el(
          'div',
          { className: 'fcd-body' },
          el(
            'div',
            { className: 'fcd-planHead' },
            el('span', { className: 'fcd-planLabel' }, t('deck.plan')),
            el(
              'span',
              { className: 'fcd-planValue' },
              summary.total === 0
                ? formatClock(elapsed)
                : t('deck.complete', { done: summary.done, total: summary.total }),
            ),
          ),
          el(
            'div',
            { className: 'fcd-bar', 'data-live': running ? 'true' : 'false' },
            el('div', { className: 'fcd-barFill', style: { width: summary.percent + '%' } }),
          ),
        )
      }

      return el(
        'section',
        {
          className: 'fcd-deck',
          'data-mode': mode,
          // 执行中才亮光晕：CSS 只认这一个稳定属性
          'data-running': running ? 'true' : 'false',
          'aria-label': mode === 'sector' ? t('deck.sectorTitle') : t('deck.liveTitle'),
        },
        el('span', { className: 'fcd-sheen', 'aria-hidden': true }),
        el(Corners, { className: 'fcd-corners' }),
        head,
        body,
        error === null
          ? null
          : el('p', { className: 'fcd-error', role: 'alert' }, error),
        error !== null || notice === null
          ? null
          : el('p', { className: 'fcd-notice', role: 'status' }, notice),
      )
    }

    /**
     * Hero emblem replacing the shipped fish: a targeting hexagon with an
     * orbiting ring, sized by the owner's `size` prop.
     */
    function HeroMark(props) {
      const size = typeof props.size === 'number' ? props.size : 34
      return el(
        'svg',
        {
          viewBox: '0 0 64 64',
          width: size,
          height: size,
          className: [props.className, 'fcd-emblem'].filter((value) => typeof value === 'string' && value !== '').join(' '),
          'aria-hidden': true,
          style: { display: 'block', flex: 'none', overflow: 'visible' },
        },
        el(
          'g',
          { className: 'fcd-emblemRing' },
          el('ellipse', {
            cx: 32,
            cy: 32,
            rx: 30,
            ry: 12,
            fill: 'none',
            stroke: 'currentColor',
            strokeOpacity: 0.55,
            strokeWidth: 1.2,
          }),
          el('circle', { cx: 60, cy: 32, r: 2.2, fill: 'currentColor' }),
        ),
        el('path', {
          d: 'M32 6 55 19v26L32 58 9 45V19z',
          fill: 'none',
          stroke: 'currentColor',
          strokeOpacity: 0.85,
          strokeWidth: 1.8,
          strokeLinejoin: 'round',
        }),
        el('path', {
          d: 'M32 15 47 23.5v17L32 49 17 40.5v-17z',
          fill: 'currentColor',
          fillOpacity: 0.1,
          stroke: 'currentColor',
          strokeOpacity: 0.5,
          strokeWidth: 1,
        }),
        el('circle', { cx: 32, cy: 32, r: 5.4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
        el('circle', { cx: 32, cy: 32, r: 1.9, fill: 'currentColor' }),
        el('path', {
          d: 'M32 15v-6M32 55v-6M17 23.5l-6-3M53 43.5l-6-3',
          stroke: 'currentColor',
          strokeOpacity: 0.5,
          strokeWidth: 1.2,
          strokeLinecap: 'round',
        }),
      )
    }

    // ---------------------------------------------------------------------
    // Markdown rendering for the dock transcript
    // ---------------------------------------------------------------------

    /**
     * Render one block of assistant Markdown into React nodes.
     *
     * The dock lives at the shell-overlay root, where the host's own chat
     * renderer is neither exported nor Session-scoped, so this is a small,
     * dependency-free subset of CommonMark — what agents actually emit:
     * fenced code, headings, lists, quotes, rules, tables and paragraphs.
     * Raw HTML is never interpreted: a transcript is data, and it must not be
     * able to inject markup into the shell.
     *
     * @param source - Markdown text of one assistant response.
     * @param keyPrefix - stable prefix so sibling blocks keep React identities.
     * @returns an array of React nodes.
     */
    function renderMarkdown(source, keyPrefix) {
      const prefix = keyPrefix ?? 'md'
      const lines = String(source).replace(/\r\n?/g, '\n').split('\n')
      const blocks = []
      let index = 0
      let sequence = 0
      const nextKey = () => prefix + '-b' + (sequence += 1)

      /** A line that opens a block of its own, so paragraph gathering stops. */
      const opensBlock = (text) =>
        /^\s*(```|~~~)/.test(text) ||
        /^#{1,6}\s/.test(text) ||
        /^\s*>/.test(text) ||
        /^\s*([-*+]|\d+[.)])\s+/.test(text) ||
        /^\s*([-*_])\1{2,}\s*$/.test(text)

      /** One table row → its trimmed cells. */
      const splitRow = (row) =>
        row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim())

      /** Paragraph text: single line breaks stay visible, nothing is dropped. */
      const paragraphNode = (text) => {
        const children = []
        text.split('\n').forEach((line, lineIndex) => {
          if (lineIndex > 0) children.push(el('br', { key: nextKey() }))
          for (const node of renderInline(line, nextKey())) children.push(node)
        })
        return el('p', { key: nextKey(), className: 'fcd-mdP' }, children)
      }

      while (index < lines.length) {
        const line = lines[index]

        // Blank lines are separators only.
        if (line.trim() === '') {
          index += 1
          continue
        }

        // Fenced code: ``` or ~~~, the opening info string labels the block.
        const fence = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/.exec(line)
        if (fence !== null) {
          const marker = fence[1]
          const language = fence[2]
          const body = []
          index += 1
          while (index < lines.length) {
            if (lines[index].trim().startsWith(marker)) {
              index += 1
              break
            }
            body.push(lines[index])
            index += 1
          }
          blocks.push(
            el(
              'pre',
              { key: nextKey(), className: 'fcd-mdCode' },
              language === '' ? null : el('span', { className: 'fcd-mdLang' }, language),
              el('code', null, body.join('\n')),
            ),
          )
          continue
        }

        // Heading: # … ######
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading !== null) {
          const level = heading[1].length
          blocks.push(
            el('h' + level, { key: nextKey(), className: 'fcd-mdH' }, renderInline(heading[2], nextKey())),
          )
          index += 1
          continue
        }

        // Horizontal rule: ---, ***, ___
        if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
          blocks.push(el('hr', { key: nextKey() }))
          index += 1
          continue
        }

        // Block quote: consecutive `>` lines render as nested Markdown.
        if (/^\s*>/.test(line)) {
          const quoted = []
          while (index < lines.length && /^\s*>/.test(lines[index])) {
            quoted.push(lines[index].replace(/^\s*>\s?/, ''))
            index += 1
          }
          blocks.push(el('blockquote', { key: nextKey() }, renderMarkdown(quoted.join('\n'), nextKey())))
          continue
        }

        // Table: a pipe row followed by a delimiter row.
        if (line.includes('|') && index + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[index + 1])) {
          const header = splitRow(line)
          index += 2
          const rows = []
          while (index < lines.length && lines[index].trim() !== '' && lines[index].includes('|')) {
            rows.push(splitRow(lines[index]))
            index += 1
          }
          blocks.push(
            el(
              'table',
              { key: nextKey() },
              el('thead', null, el('tr', null, header.map((cell, cellIndex) =>
                el('th', { key: 'h' + cellIndex }, renderInline(cell, nextKey()))))),
              el('tbody', null, rows.map((row, rowIndex) =>
                el('tr', { key: 'r' + rowIndex }, row.map((cell, cellIndex) =>
                  el('td', { key: 'c' + cellIndex }, renderInline(cell, nextKey())))))),
            ),
          )
          continue
        }

        // List: unordered or ordered; an indented non-item line continues the item.
        const bullet = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line)
        if (bullet !== null) {
          const ordered = /\d/.test(bullet[1])
          const items = []
          while (index < lines.length) {
            const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index])
            if (item === null) break
            let text = item[2]
            index += 1
            while (
              index < lines.length &&
              /^\s{2,}\S/.test(lines[index]) &&
              /^\s*([-*+]|\d+[.)])\s+/.test(lines[index]) === false
            ) {
              text += ' ' + lines[index].trim()
              index += 1
            }
            items.push(text)
          }
          blocks.push(
            el(
              ordered ? 'ol' : 'ul',
              { key: nextKey(), className: 'fcd-mdList' },
              items.map((text, itemIndex) => el('li', { key: 'i' + itemIndex }, renderInline(text, nextKey()))),
            ),
          )
          continue
        }

        // Paragraph: consecutive plain lines, up to the next block opener.
        const paragraph = []
        while (index < lines.length && lines[index].trim() !== '' && opensBlock(lines[index]) === false) {
          paragraph.push(lines[index])
          index += 1
        }
        blocks.push(paragraphNode(paragraph.join('\n')))
      }
      return blocks
    }

    /**
     * Inline Markdown: `code`, **bold**, *italic*, ~~strike~~ and links.
     * Everything else — including any raw HTML — passes through as text.
     * Links are restricted to schemes the shell can open safely; an image is
     * degraded to its own link, so a transcript never pulls a remote picture.
     */
    function renderInline(source, keyPrefix) {
      const text = String(source)
      const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(!?\[[^\]\n]*\]\([^)\s]+\))/g
      const nodes = []
      let cursor = 0
      let sequence = 0
      const nextKey = () => keyPrefix + '-i' + (sequence += 1)
      let match = pattern.exec(text)
      while (match !== null) {
        if (match.index > cursor) nodes.push(text.slice(cursor, match.index))
        const token = match[0]
        if (token.startsWith('`')) {
          nodes.push(el('code', { key: nextKey(), className: 'fcd-mdInlineCode' }, token.slice(1, -1)))
        } else if (token.startsWith('**')) {
          nodes.push(el('strong', { key: nextKey() }, token.slice(2, -2)))
        } else if (token.startsWith('~~')) {
          nodes.push(el('del', { key: nextKey() }, token.slice(2, -2)))
        } else if (token.startsWith('*')) {
          nodes.push(el('em', { key: nextKey() }, token.slice(1, -1)))
        } else {
          const link = /^(!?)\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token)
          const label = link === null ? token : link[2] === '' ? link[3] : link[2]
          const href = link === null ? undefined : link[3]
          const safe = href !== undefined && /^(https?:|mailto:|\/|#)/i.test(href) === true ? href : undefined
          nodes.push(
            el(
              'a',
              {
                key: nextKey(),
                className: 'fcd-mdLink',
                href: safe,
                target: safe === undefined ? undefined : '_blank',
                rel: 'noreferrer noopener',
              },
              label,
            ),
          )
        }
        cursor = match.index + token.length
        match = pattern.exec(text)
      }
      if (cursor < text.length) nodes.push(text.slice(cursor))
      return nodes
    }

    // ---------------------------------------------------------------------
    // Full transcript for the dock
    // ---------------------------------------------------------------------

    /**
     * Text of one message `content` list, keeping only what the panel shows:
     * `reasoning` (思考) and `tool-call` parts are dropped on purpose, so the
     * dock renders the answer itself and never the thinking behind it.
     */
    function messageTextOf(content) {
      if (!Array.isArray(content)) return ''
      const parts = []
      for (const part of content) {
        if (part === null || typeof part !== 'object') continue
        if (part.type !== 'text') continue
        if (typeof part.text !== 'string' || part.text === '') continue
        parts.push(part.text)
      }
      return parts.join('\n\n').trim()
    }

    /**
     * Reasoning (思考) text of one message `content` list, in its original
     * order. The dock shows it the way the main panel does — a collapsed
     * 「思考过程」 disclosure per turn — so it is folded separately from the
     * answer text and never mixed into it.
     */
    function reasoningTextOf(content) {
      if (!Array.isArray(content)) return ''
      const parts = []
      for (const part of content) {
        if (part === null || typeof part !== 'object') continue
        if (part.type !== 'reasoning') continue
        if (typeof part.text !== 'string' || part.text.trim() === '') continue
        parts.push(part.text)
      }
      return parts.join('\n\n').trim()
    }

    /**
     * Fold one history page of durable Session records into turn rows:
     * `turn/start` opens a row, `user/message` fills its prompt, and every
     * settled `assistant/message` step appends its visible text in order.
     * Reasoning events, tool calls, tool results and live stream frames are
     * skipped — the dock reads them from the durable log, not from the wire
     * stream, so a running Session shows each step once it settles.
     */
    function foldSessionRecords(records) {
      const turns = new Map()
      let openTurn
      const rowFor = (turn) => {
        const key = typeof turn === 'number' ? turn : openTurn ?? 0
        let row = turns.get(key)
        if (row === undefined) {
          row = { turn: key, prompt: '', steps: new Map() }
          turns.set(key, row)
        }
        openTurn = key
        return row
      }
      for (const record of records) {
        const event = record?.event ?? record
        if (event === null || typeof event !== 'object') continue
        if (event.type === 'turn/start') {
          if (typeof event.data?.turn === 'number') openTurn = event.data.turn
          continue
        }
        if (event.type === 'user/message') {
          // 只有真人输入进面板：agent-instructions / runtime-context / skill-catalog /
          // time-context / user-approval 都是宿主注入的上下文，不是用户说的话。
          const sourceKind = event.data?.source?.kind
          if (sourceKind !== undefined && sourceKind !== 'user') continue
          if (event.data?.role !== 'user') continue
          const text = messageTextOf(event.data?.content)
          if (text === '') continue
          const row = rowFor(event.data?.turn)
          row.prompt = row.prompt === '' ? text : row.prompt + '\n\n' + text
          continue
        }
        if (event.type === 'assistant/message') {
          const content = event.data?.message?.content
          const text = messageTextOf(content)
          const reasoning = reasoningTextOf(content)
          if (text === '' && reasoning === '') continue
          const row = rowFor(event.data?.turn)
          const step = typeof event.data?.step === 'number' ? event.data.step : row.steps.size + 1
          const previous = row.steps.get(step) ?? { text: '', reasoning: '' }
          // 同一步骤重试会多次落地，保留全部改写而不是覆盖
          row.steps.set(step, {
            text: text === '' ? previous.text : previous.text === '' ? text : previous.text + '\n\n' + text,
            reasoning:
              reasoning === ''
                ? previous.reasoning
                : previous.reasoning === ''
                  ? reasoning
                  : previous.reasoning + '\n\n' + reasoning,
          })
        }
      }
      return [...turns.values()]
        .sort((left, right) => left.turn - right.turn)
        .map((row) => {
          const steps = [...row.steps.entries()].sort((left, right) => left[0] - right[0])
          return {
            turn: row.turn,
            prompt: row.prompt,
            response: steps.map(([, step]) => step.text).filter((text) => text !== '').join('\n\n'),
            // 思考与正文分开收：面板里按「思考过程」折叠块显示，正文保持干净
            reasoning: steps.map(([, step]) => step.reasoning).filter((text) => text !== '').join('\n\n'),
          }
        })
    }

    /** 读取失败只往控制台报一次。 */
    let warnedReadFailure = false

    // ---------------------------------------------------------------------
    // 以下三块（resolveRemote / readSessionTurns / foldSessionRecords 与上面的
    // reasoningTextOf）是「逐轮正文」那条链路的底层实现。窄版会话坞现在**不挂载
    // 它们**：行内只有标题 / 所属战区 / 相对时间，坞也不再按行读会话日志。
    // 代码原样保留，将来要恢复「最新一轮正文 + 思考过程」时把 DockRow 的正文块
    // 接回来即可，Host 侧的读取能力和 CSS 都还在。
    // ---------------------------------------------------------------------

    /**
     * Gateway Remote namespace owning Session reads on the client context, when
     * the deployment provides one.
     */
    function resolveRemote(ctx) {
      if (typeof ctx?.get === 'function') {
        const service = ctx.get('remote')
        if (service !== undefined && service !== null) return service
      }
      try {
        return ctx?.remote
      } catch (error) {
        return undefined
      }
    }

    /**
     * The Gateway Remote's Session-log namespace (`remote.session`).
     *
     * Cordis guards nested service access: touching `remote.session` outside a
     * scope that injected BOTH `remote` and `remote.session` throws. So this
     * helper only ever *tries*, and {@link bindSessionLogNamespace} is the path
     * that actually works in a live page.
     */
    function sessionLogNamespace(remote) {
      try {
        const namespace = remote?.session
        return namespace === undefined ? null : namespace
      } catch {
        return null
      }
    }

    /**
     * Resolve the Session-log namespace inside a proper dependency scope.
     *
     * This is the difference between "the game reacts to tools" and "the game
     * idles forever": `ctx.get('remote').session` is refused by Cordis unless
     * both service entries were injected, so the reader is captured once, in a
     * `ctx.inject` scope, and reused by the polling component.
     */
    function bindSessionLogNamespace(ctx) {
      if (typeof ctx?.inject !== 'function') return () => {}
      try {
        return ctx.inject(['remote', 'remote.session'], (remoteCtx) => {
          let namespace = null
          try {
            namespace = remoteCtx.remote?.session ?? null
          } catch {
            namespace = null
          }
          sessionLogNamespaceRef.value = namespace
          return () => {
            sessionLogNamespaceRef.value = null
          }
        })
      } catch {
        return () => {}
      }
    }

    /**
     * Read the newest message-aligned history page of one Session through the
     * Gateway Remote (`session/events`) and fold it into full turns.
     *
     * This read is the only way to show a whole answer here: the projection the
     * dock paints its list rows from (`turnOutline`) is a *bounded preview* —
     * the host clips a prompt at 50 and a response at 120 characters — so the
     * expanded panel would otherwise end every turn in an ellipsis.
     *
     * Resolves to null when the endpoint is missing, rejected, or the read
     * fails; the caller then falls back to those previews.
     */
    async function readSessionTurns(remote, sessionId, signal) {
      const page = await readSessionRecordPage(sessionLogNamespace(remote), sessionId, signal, false)
      if (page.records === null) return { turns: null, hasMore: false, reason: page.reason }
      return { turns: foldSessionRecords(page.records), hasMore: page.hasMore, reason: null }
    }

    /**
     * One raw read of the newest history page of a Session through the Gateway
     * Remote. Both consumers share it: the (currently unmounted) transcript
     * preview folds it into turns, the 赛博工地 game folds its tool calls into
     * scene actions.
     *
     * The wire shape is the part that moves between Host releases, so every
     * unwrap step is defensive: the call may answer with `{ ok, value }`, a bare
     * value, or a value nested once more. Failure never throws — callers get
     * `records: null` plus a reason and simply do nothing.
     *
     * @param remote - the `remote` client service (undefined when absent).
     * @param sessionId - Session to read.
     * @param signal - AbortSignal owned by the caller's effect.
     * @param quiet - silence the one-shot console warning (per-poll reads).
     * @returns `{ records, hasMore, reason }`; `records` is null on failure.
     */
    async function readSessionRecordPage(namespace, sessionId, signal, quiet) {
      // 失败一律返回 { records: null, reason }：调用方据此回退或直接不画。
      // 日志默认只报一次，够排查、又不会因为一屏十几行刷满控制台。
      const fail = (reason) => {
        if (quiet !== true && reason !== 'aborted' && warnedReadFailure === false) {
          warnedReadFailure = true
          console.warn('[future-command-deck] 会话日志读取不可用，已退回投影预览：' + reason)
        }
        return { records: null, hasMore: false, reason }
      }
      if (namespace === undefined || namespace === null) return fail('no-namespace')
      // 命名空间本身也包一层：宿主版本不认识某个方法时访问就会抛错
      let endpoint
      try {
        // `events` 是现行端点，`page` 是它的弃用别名，两个都试
        endpoint = typeof namespace.events === 'function' ? namespace.events : namespace.page
      } catch (error) {
        return fail('namespace-threw')
      }
      if (typeof endpoint !== 'function') return fail('no-endpoint')
      let result
      try {
        result = await endpoint.call(namespace, { address: { kind: 'session', sessionId } }, signal)
      } catch (error) {
        return fail('call-threw:' + (error?.code ?? error?.message ?? 'unknown'))
      }
      if (signal?.aborted === true) return fail('aborted')
      // 网关的调用结果可能包在 { ok, value } 里，也可能是裸值或 { value }
      const unwrapped =
        result !== null && typeof result === 'object' && 'ok' in result
          ? result.ok === true
            ? result.value
            : result.error
          : result
      if (unwrapped !== null && typeof unwrapped === 'object' && 'ok' in unwrapped) {
        return fail('denied:' + (unwrapped.error?.code ?? 'unknown'))
      }
      const page =
        unwrapped !== null && typeof unwrapped === 'object' && 'value' in unwrapped && !('records' in unwrapped)
          ? unwrapped.value
          : unwrapped
      if (page === null || page === undefined) return fail('no-page')
      if (!Array.isArray(page.records)) return fail('no-records')
      return { records: page.records, hasMore: page.hasMore === true, reason: null }
    }

    // ---------------------------------------------------------------------
    // 赛博工地：把会话日志里的工具调用折成「画面动作」
    // ---------------------------------------------------------------------

    /**
     * Tool family → scene action. The game is a *reading* of the run, so the
     * mapping is by what the tool does to the workspace, not by its exact name:
     * a read scans blueprints, a write welds a plate, a shell command swings the
     * hammer. Unknown tools fall back to hauling, so a new tool still animates.
     */
    const TOOL_ACTION_RULES = [
      // 读：看图纸 / 扫描蓝图
      { action: 'read', test: /^(read|readfile|readtext|readimage|view|open|cat|notebookread)$/ },
      // 写：焊接并挂上一块楼板
      { action: 'build', test: /^(edit|multiedit|write|writefile|create|apply_patch|patch|notebookedit|replace)$/ },
      // 命令：抡大锤砸砖
      { action: 'smash', test: /^(bash|shell|execute|run|command|terminal|exec|powershell|taskexecute)$/ },
      // 检索：雷达扫描
      { action: 'scan', test: /^(grep|glob|search|find|list|ls|listdir|semanticsearch|codebase|ripgrep)$/ },
      // 联网：无人机起飞侦察
      { action: 'drone', test: /^(web|websearch|webfetch|fetch|browser|http|crawl|scrape|url|request)$/ },
      // 计划：立一块施工牌
      { action: 'flag', test: /^(todo|todowrite|todos|plan|task|taskcreate|taskupdate|update_plan)$/ },
      // 子代理：多来一个小工
      { action: 'helper', test: /^(agent|subagent|task_agent|delegate|workflow|spawn)$/ },
    ]

    /**
     * Classify one tool name into a scene action.
     * Tool names arrive as `Bash`, `read_file`, `mcp__server__tool`, `TodoWrite`…
     * so the lookup normalises to lowercase alphanumerics first.
     */
    function actionOfTool(name) {
      if (typeof name !== 'string' || name === '') return 'haul'
      const bare = name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name
      const key = bare.toLowerCase().replace(/[^a-z0-9]/g, '')
      for (const rule of TOOL_ACTION_RULES) {
        if (rule.test.test(key)) return rule.action
      }
      return 'haul'
    }

    /** Strip a string down to its basename for the HUD line. */
    function shortTargetOf(text) {
      if (typeof text !== 'string' || text === '') return ''
      const trimmed = text.replace(/^['"]|['"]$/g, '')
      const parts = trimmed.split(/[\\/]/)
      const base = parts[parts.length - 1] ?? ''
      return base.length > 22 ? base.slice(0, 21) + '…' : base
    }

    /**
     * The one human-readable target of a tool call: the first string value
     * among the usual path / command / pattern keys of the argument JSON.
     * The payload is model-emitted wire data, so every read is guarded.
     */
    function targetOfArgs(argsRaw) {
      if (typeof argsRaw !== 'string' || argsRaw === '') return ''
      let parsed
      try {
        parsed = JSON.parse(argsRaw)
      } catch {
        return ''
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
      for (const key of ['command', 'file_path', 'path', 'filePath', 'pattern', 'query', 'url', 'description']) {
        const value = parsed[key]
        if (typeof value === 'string' && value.trim() !== '') return value.trim()
      }
      return ''
    }

    /**
     * Read one log record's event object. Records may be wrapped (`{ event }`)
     * or bare, depending on the Host release.
     */
    function eventOfRecord(record) {
      const event = record !== null && typeof record === 'object' && 'event' in record ? record.event : record
      return event !== null && typeof event === 'object' ? event : null
    }

    /**
     * Fold log records into the flat, ordered list of scene events the game
     * consumes: one entry per tool call, carrying whether its result failed.
     *
     * Recognised shapes (both Host generations are read here):
     * - `tool/call`  → `data.callId`, `data.name`, `data.arguments` (JSON string)
     * - `tool/ptc-dispatch` → same payload with `data.subCallId` (sub-call of a
     *   `<code>` block, the only way those tools reach the log)
     * - `tool/result` → `data.message` with `content` blocks and `isError`
     * - `turn/end`   → a floor is completed (the building grows)
     *
     * @returns `{ seq, action, tool, target, at, error }` entries, oldest first.
     */
    function foldToolSceneEvents(records) {
      const calls = new Map()
      const events = []
      for (const record of records) {
        const event = eventOfRecord(record)
        if (event === null || typeof event.type !== 'string') continue
        // `seq` 可能长在事件体上，也可能长在记录信封上（两种宿主布局都见过）；
        // 拿不到序号就没法增量去重，直接跳过。
        const envelope = record !== null && typeof record === 'object' ? record : null
        const seq =
          typeof event.seq === 'number'
            ? event.seq
            : typeof envelope?.seq === 'number'
              ? envelope.seq
              : undefined
        if (seq === undefined) continue
        const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
        if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch') {
          const callId =
            typeof data.callId === 'string' ? data.callId : typeof data.subCallId === 'string' ? data.subCallId : undefined
          if (typeof data.name !== 'string' || callId === undefined) continue
          const argsRaw =
            typeof data.arguments === 'string'
              ? data.arguments
              : data.arguments !== null && typeof data.arguments === 'object'
                ? safeJson(data.arguments)
                : ''
          const target = targetOfArgs(argsRaw)
          const entry = {
            seq,
            action: actionOfTool(data.name),
            tool: data.name,
            target: shortTargetOf(target),
            at:
              typeof event.time === 'number'
                ? event.time
                : typeof envelope?.time === 'number'
                  ? envelope.time
                  : Date.now(),
            error: false,
          }
          calls.set(callId, entry)
          events.push(entry)
          continue
        }
        if (event.type === 'tool/result') {
          const message = data.message !== null && typeof data.message === 'object' ? data.message : {}
          const source = message.source !== null && typeof message.source === 'object' ? message.source : {}
          const callId =
            typeof message.toolCallId === 'string'
              ? message.toolCallId
              : typeof source.callId === 'string'
                ? source.callId
                : undefined
          const failed = message.isError === true || data.isError === true
          if (callId !== undefined && failed === true) {
            const entry = calls.get(callId)
            if (entry !== undefined) entry.error = true
          }
          continue
        }
        if (event.type === 'turn/end') {
          events.push({ seq, action: 'floor', tool: '', target: '', at: Date.now(), error: false })
        }
      }
      events.sort((left, right) => left.seq - right.seq)
      return events
    }

    /** JSON.stringify that never throws on cyclic or exotic wire values. */
    function safeJson(value) {
      try {
        return JSON.stringify(value)
      } catch {
        return ''
      }
    }


    // ---------------------------------------------------------------------
    // Session dock (top-right): every Workspace's Sessions, grouped
    // ---------------------------------------------------------------------

    /**
     * Latest turn text carried by the `turnOutline` projection: the response
     * when there is one, otherwise the prompt. Treated as wire data — an absent
     * or malformed projection simply yields no preview. List rows stay on this
     * bounded projection: a preview board wants one short line per Session.
     * @returns one shortened line, or undefined.
     */
    function turnPreviewOf(projectionSnapshot) {
      const outline = projectionSnapshot?.values?.turnOutline
      if (!Array.isArray(outline)) return undefined
      for (let index = outline.length - 1; index >= 0; index -= 1) {
        const entry = outline[index]
        if (entry === null || typeof entry !== 'object') continue
        const response = typeof entry.response === 'string' ? entry.response : ''
        const prompt = typeof entry.prompt === 'string' ? entry.prompt : ''
        const text = (response !== '' ? response : prompt).replace(/\s+/g, ' ').trim()
        if (text !== '') return text.length > 260 ? text.slice(0, 260) + '…' : text
      }
      return undefined
    }

    /** Stored title of a Session summary, falling back to its id. */
    function sessionTitleOf(summary, fallback) {
      if (summary !== undefined && summary !== null) {
        const title = summary.displayTitle ?? summary.title
        if (typeof title === 'string' && title.trim() !== '') return title
      }
      return fallback
    }

    /** Workspace label for a dock row. */
    function workspaceTitleOf(workspace) {
      return typeof workspace.title === 'string' && workspace.title !== ''
        ? workspace.title
        : baseNameOf(workspace.path)
    }

    /**
     * Flat, recency-ordered roster of every Session of every Workspace.
     *
     * `active` is the field the dock filters on: the Session is **still in
     * flight** — either the agent is running, or it is paused on something that
     * needs the user (an approval prompt). A Session that merely finished is not
     * active, so it leaves the board instead of piling up as history.
     */
    function buildRecentSessions(input) {
      const { workspaces, byId, statuses, projections, current, limit, includeCurrent } = input
      const rows = []
      for (const workspace of workspaces) {
        const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
        for (const id of sessionIds) {
          if (id === current && includeCurrent !== true) continue
          const summary = byId[id]
          const status = statuses !== undefined && typeof statuses.get === 'function' ? statuses.get(id) : undefined
          const running = status?.running === true
          // 等待用户确认（审批/回答）也算「还在跑」：任务没结束，只是暂停在等人
          const pending = status?.pendingInteraction !== undefined
          rows.push({
            id,
            current: id === current,
            title: sessionTitleOf(summary, id),
            workspace: workspaceTitleOf(workspace),
            updatedAt: typeof summary?.updatedAt === 'number' ? summary.updatedAt : 0,
            blank: summary?.blank === true,
            running,
            pending,
            active: running || pending,
            preview: turnPreviewOf(projections?.[id]),
          })
        }
      }
      // 真在跑的在最上（等确认的排在后面），同组按最近活动倒序：
      // 主战区刚「发射」的那条会话必须立刻站在最上面。
      rows.sort((left, right) => {
        if (left.running !== right.running) return left.running ? -1 : 1
        if (left.active !== right.active) return left.active ? -1 : 1
        return right.updatedAt - left.updatedAt
      })
      return rows.slice(0, limit)
    }

    /**
     * Compact age label for narrow rows: 刚刚 / 5分 / 3时 / 2天 / 11/10.
     * Tabular, fixed-width friendly, and it stops spelling out "分钟前" 20 times.
     */
    function shortAgeLabel(updatedAt, t) {
      if (typeof updatedAt !== 'number' || updatedAt <= 0) return ''
      const minutes = Math.floor((Date.now() - updatedAt) / 60000)
      if (minutes < 1) return t('dock.agoNow')
      if (minutes < 60) return t('dock.agoMinutes', { count: minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('dock.agoHours', { count: hours })
      const days = Math.floor(hours / 24)
      if (days < 7) return t('dock.agoDays', { count: days })
      const date = new Date(updatedAt)
      return (date.getMonth() + 1) + '/' + date.getDate()
    }

    /** Relative age label ("刚刚 / 3 分钟 / 2 小时 / 昨天"). */
    function ageLabel(updatedAt, t) {
      if (typeof updatedAt !== 'number' || updatedAt <= 0) return ''
      const minutes = Math.max(0, Math.round((Date.now() - updatedAt) / 60000))
      if (minutes < 1) return t('dock.now')
      if (minutes < 60) return t('dock.minutes', { count: minutes })
      const hours = Math.round(minutes / 60)
      if (hours < 24) return t('dock.hours', { count: hours })
      return t('dock.days', { count: Math.round(hours / 24) })
    }

    /**
     * One collapsible 「思考过程」 block, mirroring how the main panel shows
     * reasoning: a muted summary line that stays closed until it is clicked,
     * and Markdown rendered only while open. A reasoning trace is by far the
     * most expensive text on this board, so a closed block costs one line.
     */
    function ReasoningBlock(props) {
      const { text, label, meta, prefix } = props
      const [open, setOpen] = useState(false)
      const body = useMemo(() => (open === true ? renderMarkdown(text, prefix) : null), [open, text, prefix])
      return el(
        'div',
        { className: 'fcd-reason' },
        el(
          'button',
          {
            type: 'button',
            className: 'fcd-reasonHead',
            'data-open': open ? 'true' : 'false',
            'aria-expanded': open,
            onClick: (event) => {
              // 列表里这块在可点击的行内：点它只展开思考，别顺带展开整行
              if (typeof event?.stopPropagation === 'function') event.stopPropagation()
              setOpen((previous) => previous !== true)
            },
          },
          el('span', { className: 'fcd-reasonLabel' }, label),
          el('span', { className: 'fcd-reasonMeta' }, meta),
        ),
        body === null ? null : el('div', { className: 'fcd-reasonBody fcd-md' }, body),
      )
    }

    /**
     * One row of the narrow top-right dock: status dot + title, then the
     * Workspace the Session belongs to (所属项目) and its relative age.
     *
     * The row is **navigation only**: no transcript body, no reasoning block,
     * no output preview. That keeps the board narrow and means the dock never
     * touches the session log — opening a row is the only way to read it.
     */
    function DockRow(props) {
      const { row, t, onOpen } = props
      // 正文里的链接要能点开时不再有误触问题（行内已没有链接），保留这条判断
      // 是为了将来复用行模板时仍然安全。
      const expand = (event) => {
        const target = event?.target
        if (typeof Element !== 'undefined' && target instanceof Element && target.closest('a') !== null) return
        onOpen()
      }
      return el(
        'div',
        {
          className: 'fcd-item',
          'data-active': row.running ? 'true' : 'false',
          role: 'button',
          tabIndex: 0,
          // 窄栏会截断长标题，完整标题 + 所属战区放进原生提示气泡
          title: row.workspace === undefined || row.workspace === ''
            ? row.title
            : row.title + ' · ' + row.workspace,
          onClick: expand,
          onKeyDown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            onOpen()
          },
        },
        el('span', {
          className: 'fcd-rowDot',
          'data-active': row.running ? 'true' : 'false',
          // 暂停在等确认：不呼吸、亮琥珀色，一眼看出「要你去点一下」
          'data-wait': row.running ? 'false' : row.pending ? 'true' : 'false',
          'aria-hidden': true,
        }),
        el(
          'div',
          { className: 'fcd-itemMain' },
          el('span', { className: 'fcd-itemTop' }, el('span', { className: 'fcd-itemTitle' }, row.title)),
          el(
            'span',
            { className: 'fcd-itemBottom' },
            el('span', { className: 'fcd-itemWhere' }, row.workspace),
            el('span', { className: 'fcd-itemAge' }, shortAgeLabel(row.updatedAt, t)),
          ),
        ),
      )
    }

    /**
     * Top-right dock: a flat, recent-first board of the Sessions that actually
     * ran something. It is **navigation only** — clicking a row opens that
     * Session in the main area, and the dock hides itself right after because
     * the main view stops being the 主战区 screen.
     *
     * Rows carry three fields only (title / owning Workspace / relative age),
     * so the dock stays a narrow strip and never reads session logs: the
     * per-row `readTurns` fan-out that used to feed the transcript preview is
     * gone. The full conversation is one click away in the main view.
     */
    function SessionDock(props) {
      const { t, openSession } = props
      const useSessions = props.useSessions ?? useNothing
      const useSessionStatus = props.useSessionStatus ?? useNothing
      const useWorkspaces = props.useWorkspaces ?? useNothing

      const byId = useSessions((snapshot) => snapshot?.byId) ?? {}
      const statuses = useSessionStatus((snapshot) => snapshot)
      const workspaces = useWorkspaces((snapshot) => snapshot?.items) ?? []
      const projections = useSessions((snapshot) => snapshot?.projectionsBySession)
      const current = useStoreValue(currentSessionStore)
      const hidden = useStoreValue(dockHiddenStore)
      const mainMode = useStoreValue(mainModeStore)
      const shell = useShellState()

      // 这张看板只有「正在进行」的会话：跑完就自动消失，不累积历史。
      // 还在跑 = running，或暂停在等用户确认（pending）。
      const rows = useMemo(
        () =>
          buildRecentSessions({
            workspaces,
            byId,
            statuses,
            projections,
            current,
            limit: 8,
            includeCurrent: true,
          }).filter((row) => row.active === true && row.blank !== true),
        [workspaces, byId, statuses, projections, current],
      )
      // 只在「主战区」当值：进入某个会话后输出交回主区域，坞整体隐藏
      const visible = !hidden && shell.deck && mainMode === 'sector' && rows.length > 0

      useEffect(() => {
        if (!visible) return undefined
        document.documentElement.setAttribute(DOCK_ATTR, '1')
        return () => document.documentElement.removeAttribute(DOCK_ATTR)
      }, [visible])

      // 行内只显示标题 / 所属战区 / 相对时间，坞不再按行去读会话日志，
      // 因此这里既没有 rowTurns 缓存，也没有批量读取的副作用。
      if (!visible) return null
      // 列表里只有进行中的会话，计数就是行数
      const runningTotal = rows.length

      return el(
        'aside',
        { className: 'fcd-dock', 'aria-label': t('dock.title') },
        el(
          'header',
          { className: 'fcd-dockHead' },
          el('span', { className: 'fcd-mark', 'aria-hidden': true }),
          el('span', { className: 'fcd-title' }, t('dock.title')),
          el('span', { className: 'fcd-sub' }, t('dock.sub')),
          el('span', { className: 'fcd-rule', 'aria-hidden': true }),
          runningTotal > 0
            ? el(
                'span',
                { className: 'fcd-pill', 'data-live': 'true' },
                el('span', { className: 'fcd-pillDot', 'aria-hidden': true }),
                el('span', null, t('dock.runningCount', { count: runningTotal })),
              )
            : null,
          el(
            'button',
            {
              type: 'button',
              className: 'fcd-toggle',
              title: t('dock.hide'),
              'aria-label': t('dock.hide'),
              onClick: () => {
                dockHiddenStore.set(true)
              },
            },
            el(
              'svg',
              { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
              el('path', {
                d: 'M4 4l8 8M12 4l-8 8',
                stroke: 'currentColor',
                strokeWidth: '1.6',
                strokeLinecap: 'round',
              }),
            ),
          ),
        ),
        el(
          'div',
          { className: 'fcd-list' },
          rows.map((row) =>
            el(DockRow, {
              key: row.id,
              row,
              t,
              onOpen: () => {
                openSession(row.id)
              },
            })),
        ),
        el('p', { className: 'fcd-dockHint' }, t('dock.hint')),
      )
    }

    /**
     * Top-left panel: every Session of the Workspace the main view currently
     * sits in (the "selected sector"). Clicking a row promotes it to the main
     * execution area.
     */
    function SectorSessionsPanel(props) {
      const { t, openSession } = props
      const useSessions = props.useSessions ?? useNothing
      const useSessionStatus = props.useSessionStatus ?? useNothing
      const useWorkspaces = props.useWorkspaces ?? useNothing

      const byId = useSessions((snapshot) => snapshot?.byId) ?? {}
      const statuses = useSessionStatus((snapshot) => snapshot)
      const workspaces = useWorkspaces((snapshot) => snapshot?.items) ?? []
      const current = useStoreValue(currentSessionStore)
      const [collapsed, setCollapsed] = useState(false)

      const workspace = current === undefined
        ? undefined
        : workspaces.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(current))
      if (workspace === undefined) return null

      const rows = workspace.sessionIds.map((id) => {
        const summary = byId[id]
        const status = statuses !== undefined && typeof statuses.get === 'function' ? statuses.get(id) : undefined
        return {
          id,
          title: sessionTitleOf(summary, id),
          updatedAt: typeof summary?.updatedAt === 'number' ? summary.updatedAt : 0,
          running: status?.running === true,
          pending: status?.pendingInteraction !== undefined,
          blank: summary?.blank === true,
          current: id === current,
        }
      })

      return el(
        'aside',
        { className: 'fcd-sectorPanel', 'aria-label': t('sectorPanel.title') },
        el(
          'header',
          { className: 'fcd-dockHead' },
          el('span', { className: 'fcd-mark', 'aria-hidden': true }),
          el('span', { className: 'fcd-title', title: workspaceTitleOf(workspace) }, workspaceTitleOf(workspace)),
          el('span', { className: 'fcd-sub' }, t('sectorPanel.sub')),
          el('span', { className: 'fcd-rule', 'aria-hidden': true }),
          el('span', { className: 'fcd-pill' }, t('sectorPanel.count', { count: rows.length })),
          el(
            'button',
            {
              type: 'button',
              className: 'fcd-toggle',
              'data-expanded': collapsed ? 'false' : 'true',
              'aria-expanded': !collapsed,
              'aria-label': collapsed ? t('deck.expand') : t('deck.collapse'),
              title: collapsed ? t('deck.expand') : t('deck.collapse'),
              onClick: () => {
                setCollapsed((value) => !value)
              },
            },
            el(Chevron),
          ),
        ),
        collapsed
          ? null
          : el(
              'div',
              { className: 'fcd-list fcd-listNarrow' },
              rows.map((row) =>
                el(
                  'button',
                  {
                    key: row.id,
                    type: 'button',
                    className: 'fcd-item fcd-itemTight',
                    'data-active': row.running ? 'true' : 'false',
                    'data-current': row.current ? 'true' : 'false',
                    title: row.title,
                    onClick: () => {
                      openSession(row.id)
                    },
                  },
                  el('span', {
          className: 'fcd-rowDot',
          'data-active': row.running ? 'true' : 'false',
          // 暂停在等确认：不呼吸、亮琥珀色，一眼看出「要你去点一下」
          'data-wait': row.running ? 'false' : row.pending ? 'true' : 'false',
          'aria-hidden': true,
        }),
                  el(
                    'span',
                    { className: 'fcd-itemMain' },
                    el(
                      'span',
                      { className: 'fcd-itemTitle', 'data-current': row.current ? 'true' : undefined },
                      row.title,
                    ),
                  ),
                  el('span', { className: 'fcd-itemAge' }, shortAgeLabel(row.updatedAt, t)),
                )),
            ),
        collapsed ? null : el('p', { className: 'fcd-dockHint' }, t('sectorPanel.hint')),
      )
    }

    // ---------------------------------------------------------------------
    // 赛博工地：面板的第二种视图（工具调用 → 施工现场）
    // ---------------------------------------------------------------------

    /** Host slot the panel view is measured against (the chat scroll card). */
    const PANEL_FLOW_SELECTOR = '[data-slot="conversation.chat.flow"]'
    /** How often the overlay re-measures the panel while it is on screen (ms). */
    const FRAME_POLL_MS = 400
    /** 一次「到山」之后，那一格余辉衰减到 0 需要多久（秒）。 */
    const ACTION_GLOW_SECONDS = 2.4
    /** 一次工具调用之后，指针先定住多久再恢复慢转（ms）。 */
    const IDLE_HOLD_MS = 4500
    /** 慢转速度（度/秒）：执行中快一点，待命更慢——「罗盘一直在慢慢转」。 */
    const IDLE_DEG_PER_SEC = 5
    /** 怠速光效：多久往外荡一圈光（秒）、一圈活多久（秒）。 */
    const IDLE_WAVE_SECONDS = 2.2
    const IDLE_WAVE_LIFE = 2.8
    /**
     * 拖盘惯性：松手后按角速度继续滑行，指数摩擦减速，慢下来再吸附到最近的「山」。
     * 摩擦系数（1/s）、停止阈值与甩动上限都是「度/秒」；识别甩动还需要一个最小速度，
     * 免得轻轻一拖就转个不停。
     */
    const SPIN_FRICTION = 1.9
    const SPIN_STOP_DEG_PER_SEC = 24
    const SPIN_MAX_DEG_PER_SEC = 1800
    const FLING_MIN_DEG_PER_SEC = 70
    /** 估算甩动速度的采样窗口（ms）。 */
    const FLING_SAMPLE_MS = 110

    /**
     * 二十四山：古代罗盘最核心的一圈，从子（正北）起顺时针每山 15°。
     * 索引指到哪一格，就是哪一个山向。
     */
    const MOUNTAINS_24 = [
      '子', '癸', '丑', '艮', '寅', '甲', '卯', '乙',
      '辰', '巽', '巳', '丙', '午', '丁', '未', '坤',
      '申', '庚', '酉', '辛', '戌', '乾', '亥', '壬',
    ]
    /** 阳山用朱笔、阴山用墨色：六阳支 + 四阳干 + 四维卦。 */
    const YANG_MOUNTAINS = new Set(['子', '寅', '辰', '午', '申', '戌', '甲', '丙', '庚', '壬', '乾', '坤', '艮', '巽'])

    /**
     * 工具族 → 方位。八宫取的是后天八卦的四正（子午卯酉）与四维（乾坤艮巽），
     * 正好是二十四山里每隔 45° 的那八格，所以「工具落在哪一宫」与「罗盘转到哪一山」
     * 是同一件事。`deg` 同时是 ACTION_BEARING 的值。
     */
    const PALACES = [
      { deg: 0, action: 'read', gua: '坎', glyph: '☵', mountain: '子', hue: '#4fc3f7' },
      { deg: 45, action: 'build', gua: '艮', glyph: '☶', mountain: '艮', hue: '#e8c477' },
      { deg: 90, action: 'smash', gua: '震', glyph: '☳', mountain: '卯', hue: '#ff6b57' },
      { deg: 135, action: 'scan', gua: '巽', glyph: '☴', mountain: '巽', hue: '#5ce0c0' },
      { deg: 180, action: 'drone', gua: '离', glyph: '☲', mountain: '午', hue: '#ff9a4d' },
      { deg: 225, action: 'flag', gua: '坤', glyph: '☷', mountain: '坤', hue: '#d9c46a' },
      { deg: 270, action: 'helper', gua: '兑', glyph: '☱', mountain: '酉', hue: '#b9d7ef' },
      { deg: 315, action: 'haul', gua: '乾', glyph: '☰', mountain: '乾', hue: '#b79bff' },
    ]
    /** 扇区顺序（与 PALACES 一一对应，改一处必须同改另一处）。 */
    const ACTION_ORDER = PALACES.map((palace) => palace.action)
    /** 工具族 → 方位角度。 */
    const ACTION_BEARING = Object.fromEntries(PALACES.map((palace) => [palace.action, palace.deg]))
    /** 工具族 → 该宫颜色。 */
    const ACTION_HUE = Object.fromEntries(PALACES.map((palace) => [palace.action, palace.hue]))
    /** 角度 → 落在哪一山（二十四山，15° 一格）。 */
    const mountainOf = (deg) => MOUNTAINS_24[Math.round(normalizeDeg(deg) / 15) % MOUNTAINS_24.length]
    /** 角度 → 落在哪一宫（八宫，45° 一格）。 */
    const palaceOf = (deg) => PALACES[Math.round(normalizeDeg(deg) / 45) % PALACES.length]
    /** 角度归一化到 [0, 360)。 */
    function normalizeDeg(deg) {
      return ((deg % 360) + 360) % 360
    }
    /**
     * 「笔记」本地话术库（《盗墓笔记》）。
     *
     * 前 4 句是这套面板最早用的那几句，始终保留在最前面；其余是从公开语录整理来的，
     * 长度都控制在卡片里一行能读的程度。运行时还会去一言 API 抓新的句子追加进来
     * （见 refreshNotesQuotes），所以这里只是「离线可用的底子」。
     */
    const RUN_QUOTES = [
      '比鬼神更可怕的，是人心。',
      '有些面具戴得太久，就摘不下来了。',
      '用我一生，换你十年天真无邪。',
      '小三爷，你大胆地往前走啊，莫回头。',
      '你要是消失，至少我会发现。',
      '我是一个没有过去和未来的人。',
      '我们只是，好久不见。',
      '十年之后，如果你还记得我，就来长白山接我。',
      '还好，我没害死你。',
      '青山不改，绿水长流，后会有期。',
      '我只救不想死的人。',
      '有些事，不如不知道。',
      '麒麟竭生麒麟劫，十年别来思无邪。',
      '隔一扇青铜门，一人守一孤城。',
      '他身披风雪眼眸如月，是人间看不到的绝色。',
      '可惜，有些路走上去就不能回头。',
    ]

    /** localStorage 里缓存的话术池（含联网抓到的新句子）。 */
    const NOTES_STORE_KEY = 'fcd.notes.quotes'
    /** 多久之后再去网上补一批新句子。 */
    const NOTES_REFRESH_MS = 6 * 60 * 60 * 1000
    /** 一次补几句。 */
    const NOTES_FETCH_COUNT = 6
    /** 整批请求的硬超时，超时就当这次没补到。 */
    const NOTES_TIMEOUT_MS = 7000
    /** 话术池上限，防止越攒越大。 */
    const NOTES_POOL_LIMIT = 60
    /** 一言 API：文学 / 影视 / 诗词 / 哲学，CORS 全开，可直连。 */
    const NOTES_API = 'https://v1.hitokoto.cn/?c=d&c=h&c=i&c=k&encode=json&charset=utf-8'
    /** 带这些字眼的句子优先排在前面，更像「笔记」的调子。 */
    const NOTES_BIAS = ['墓', '棺', '青铜', '长白', '鬼', '地宫', '倒斗', '古', '十年', '无邪', '起灵']

    /**
     * 运行时话术池。`source` 只用于自检：local = 本地底库，cache = 用了缓存，
     * remote = 刚补过联网句子。
     */
    const notesQuoteStore = createValueStore({ lines: [...RUN_QUOTES], source: 'local' })
    /** 同一时间只允许一个补句请求在飞。 */
    let notesFetchInFlight = false

    /** 去掉空串/超长/重复项，保持原有顺序。 */
    function mergeQuotes(base, extra) {
      const seen = new Set()
      const lines = []
      for (const line of [...base, ...extra]) {
        if (typeof line !== 'string') continue
        const text = line.replace(/\s+/g, ' ').trim()
        if (text === '' || text.length > 42 || seen.has(text)) continue
        seen.add(text)
        lines.push(text)
        if (lines.length >= NOTES_POOL_LIMIT) break
      }
      return lines
    }

    /** 读本地缓存；坏数据一律当没有。 */
    function readNotesCache() {
      try {
        const raw = window.localStorage.getItem(NOTES_STORE_KEY)
        if (raw === null) return { lines: [], fetchedAt: 0 }
        const parsed = JSON.parse(raw)
        const lines = Array.isArray(parsed?.lines) ? parsed.lines : []
        const fetchedAt = typeof parsed?.fetchedAt === 'number' ? parsed.fetchedAt : 0
        return { lines, fetchedAt }
      } catch {
        return { lines: [], fetchedAt: 0 }
      }
    }

    /** 写本地缓存；隐私模式下写不进去也不影响本次运行。 */
    function writeNotesCache(lines, fetchedAt) {
      try {
        window.localStorage.setItem(NOTES_STORE_KEY, JSON.stringify({ lines, fetchedAt }))
      } catch {
        // 存不了就算了，下一次进来会重新抓
      }
    }

    /** 带「笔记」味道的句子排前面，其余按抓取顺序。 */
    function rankQuotes(lines) {
      const taste = (line) => (NOTES_BIAS.some((word) => line.includes(word)) ? 0 : 1)
      return [...lines].sort((left, right) => taste(left) - taste(right))
    }

    /**
     * 刷新话术池：先用「本地底库 + 缓存」立即出句子，缓存过期（或 force）
     * 时再去一言抓一批新句子追加进去并写回缓存。任何失败都静默降级。
     * @param force - true 时忽略缓存时间强制抓一批。
     */
    async function refreshNotesQuotes(force) {
      const cache = readNotesCache()
      const merged = mergeQuotes(RUN_QUOTES, cache.lines)
      notesQuoteStore.set({
        lines: merged,
        source: cache.lines.length > 0 ? 'cache' : 'local',
      })
      if (notesFetchInFlight) return
      if (force !== true && Date.now() - cache.fetchedAt < NOTES_REFRESH_MS) return
      if (typeof fetch !== 'function') return

      notesFetchInFlight = true
      // 并行取若干句，并给整批一个硬超时：一句卡住不会把「补句」永久挂起
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = window.setTimeout(() => controller?.abort(), NOTES_TIMEOUT_MS)
      try {
        const batches = await Promise.all(
          Array.from({ length: NOTES_FETCH_COUNT }, (_, index) =>
            fetch(`${NOTES_API}&_=${Date.now()}_${index}`, {
              mode: 'cors',
              cache: 'no-store',
              ...(controller === null ? {} : { signal: controller.signal }),
            })
              .then((response) => (response.ok ? response.json() : null))
              .catch(() => null)),
        )
        const fetched = batches
          .map((payload) => (typeof payload?.hitokoto === 'string' ? payload.hitokoto : null))
          .filter((line) => line !== null)
        if (fetched.length > 0) {
          const lines = mergeQuotes(RUN_QUOTES, rankQuotes([...fetched, ...cache.lines]))
          writeNotesCache(lines.filter((line) => !RUN_QUOTES.includes(line)), Date.now())
          notesQuoteStore.set({ lines, source: 'remote' })
        }
      } catch {
        // 断网 / 跨域被拦：保留本地与缓存，不打扰用户
      } finally {
        window.clearTimeout(timer)
        notesFetchInFlight = false
      }
    }

    /** 一轮任务跑完（会话停下）时压上去的那一句：发现古墓。 */
    const FOUND_QUOTE = '墓门开了——下面那一层，还没人进去过。'
    /** 句子轮换间隔与「发现古墓」的停留时长（ms）。 */
    const QUOTE_INTERVAL_MS = 7000
    const FOUND_HOLD_MS = 9000

    /** HUD snapshot shown before the engine has produced anything. */
    const EMPTY_ARENA_SNAPSHOT = Object.freeze({
      live: false,
      laps: 0,
      bearing: 0,
      mountain: '子',
      gua: '坎',
      combo: 0,
      counts: { read: 0, build: 0, smash: 0, scan: 0 },
      now: '',
      recent: [],
      signal: 'idle',
    })

    /** Clamp helper for the scene maths. */
    function clamp(value, min, max) {
      return value < min ? min : value > max ? max : value
    }

    /** Intersection of two viewport rectangles, or null when they miss. */
    function intersectRect(a, b) {
      const left = Math.max(a.left, b.left)
      const top = Math.max(a.top, b.top)
      const right = Math.min(a.right, b.right)
      const bottom = Math.min(a.bottom, b.bottom)
      if (right - left < 1 || bottom - top < 1) return null
      return { left, top, right, bottom }
    }

    /**
     * Top edge of the bottom chrome the game must not cover: the composer seat
     * (`[data-composer-seat]`) and this plugin's own execution deck above it.
     *
     * The conversation scroller routinely extends *behind* the composer (the
     * composer floats over the column), so clamping to the scroller alone still
     * lets the canvas paint over the input box. Only elements that actually
     * overlap the panel horizontally count.
     *
     * @param panel - the panel box the game is being fitted into.
     * @returns the highest such top edge, or null when nothing is in the way.
     */
    function readBottomChromeTop(panel) {
      if (typeof document === 'undefined') return null
      let limit = null
      const nodes = document.querySelectorAll('[data-composer-seat], .fcd-deck')
      for (const node of nodes) {
        const rect = node.getBoundingClientRect()
        if (rect.height < 8 || rect.width < 40) continue
        // 只避让和面板横向相交的那一块（右侧栏内嵌对话的座位不算）
        if (rect.right <= panel.left + 1 || rect.left >= panel.right - 1) continue
        if (rect.top <= panel.top + 1) continue
        limit = limit === null ? rect.top : Math.min(limit, rect.top)
      }
      return limit
    }

    /**
     * The **fixed** box of the Session panel, in viewport coordinates.
     *
     * The panel must not change size once it is up: the chat card grows with the
     * conversation, and the scrolling ancestor can animate during a layout
     * switch, so neither of their heights is a stable measurement. What IS
     * stable is the geometry around them:
     *
     * - `left/top/right` come from the chat card (a column: width fixed);
     * - `bottom` comes from the input area (`[data-composer-seat]`) and this
     *   plugin's own deck above it, minus {@link PANEL_CHROME_GAP}.
     *
     * Until the input area exists the function returns null — better to show
     * nothing for a few frames than to paint a panel at a wrong height and then
     * watch it jump.
     *
     * @returns `{ left, top, width, height }` or null while the box is unknown.
     */
    function readPanelRect() {
      if (typeof document === 'undefined') return null
      const flow = document.querySelector(PANEL_FLOW_SELECTOR)
      const card = flow === null ? null : flow.parentElement
      if (card === null) return null
      const rect = card.getBoundingClientRect()
      if (rect.width < 160) return null
      const chromeTop = readBottomChromeTop(rect)
      // 输入区还没渲染：这一拍先不量，等它出现（否则会先撑出一个偏高的面板）
      if (chromeTop === null) return null
      const left = Math.max(0, rect.left)
      const top = Math.max(0, rect.top)
      const right = Math.min(rect.right, window.innerWidth)
      const bottom = Math.min(chromeTop - PANEL_CHROME_GAP, window.innerHeight)
      const width = right - left
      const height = bottom - top
      if (width < 160 || height < 160) return null
      return { left, top, width, height }
    }

    /**
     * Track the panel rectangle and the overlay origin while the game view is
     * visible. The origin is the overlay root's own rect: it corrects for a
     * transformed ancestor turning `position: fixed` into something relative,
     * so the scene always lands exactly on the chat card.
     */
    function useArenaFrame(active, rootRef) {
      const [frame, setFrame] = useState(null)
      useEffect(() => {
        if (!active) {
          setFrame(null)
          return undefined
        }
        let disposed = false
        /** 已排队的重测（rAF 合并多次 resize/观察回调，一帧只量一次）。 */
        let pending = 0

        let misses = 0
        const measure = () => {
          if (disposed) return
          const panel = readPanelRect()
          const root = rootRef.current
          if (panel === null || root === null) {
            // 布局过渡里偶尔一次量不到（比如输入区正在动画）：**保留上一帧**。
            // 之前这里会清空，整层跟着卸载，胶囊跟着消失——表现就是「有时候点不动」。
            misses += 1
            return
          }
          misses = 0
          const origin = root.getBoundingClientRect()
          const next = { panel, origin: { left: origin.left, top: origin.top } }
          setFrame((previous) => {
            // 亚像素抖动会让 canvas 反复重建，这里只认 0.5px 以上的变化
            const near =
              previous !== null &&
              Math.abs(previous.panel.left - next.panel.left) < 0.5 &&
              Math.abs(previous.panel.top - next.panel.top) < 0.5 &&
              Math.abs(previous.panel.width - next.panel.width) < 0.5 &&
              Math.abs(previous.panel.height - next.panel.height) < 0.5 &&
              Math.abs(previous.origin.left - next.origin.left) < 0.5 &&
              Math.abs(previous.origin.top - next.origin.top) < 0.5
            return near ? previous : next
          })
        }

        // 变化一来就量：窗口缩放、面板随布局变化、输入区上下移动，都走这一条
        const schedule = () => {
          if (disposed || pending !== 0) return
          pending = window.requestAnimationFrame(() => {
            pending = 0
            measure()
          })
        }

        schedule()
        const timer = window.setInterval(measure, FRAME_POLL_MS)
        window.addEventListener('resize', schedule)

        // ResizeObserver 比 resize 事件灵敏：面板/输入区因为布局变化而变大小都会立即上报
        let observer = null
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(schedule)
          const flow = document.querySelector(PANEL_FLOW_SELECTOR)
          const card = flow === null ? null : flow.parentElement
          if (card !== null) observer.observe(card)
          const seats = document.querySelectorAll('[data-composer-seat]')
          for (const seat of seats) observer.observe(seat)
        }

        return () => {
          disposed = true
          if (pending !== 0) window.cancelAnimationFrame(pending)
          window.clearInterval(timer)
          window.removeEventListener('resize', schedule)
          if (observer !== null) observer.disconnect()
        }
      }, [active, rootRef])
      return frame
    }

    /**
     * Human line for one scene event: 「焊接 楼板 · client.js」.
     * Kept outside the engine so all copy still goes through `t()`.
     */
    function describeSceneEvent(t, entry) {
      if (entry.action === 'floor') return t('arena.act.floor')
      const verb = t('arena.act.' + entry.action)
      const target = typeof entry.target === 'string' && entry.target !== '' ? ' ' + entry.target : ''
      return verb + target
    }


    /**
     * 罗盘引擎（the 赛博罗盘 scene）。
     *
     * 不画工地，画一台仪表：外圈刻度 + 八个方位扇区 + 一根会「摆」过去的指针。
     * 每次工具调用把指针弹到对应方位（弹簧阻尼，带一点过冲），指针到位时
     * 从轴心放一圈同色脉冲，扇区留下余辉；跑完整轮（`turn/end`）指针整圈扫过一次，
     * 圈数 +1；工具报错则指针被撞一下并向反方向抖。
     *
     * 纯 canvas 手绘：无素材、无字体文件、无第三方库。React 只从 `onChange`
     * 那一个小快照里拿 HUD 数字，不参与逐帧渲染。
     *
     * @param canvas - 目标画布（尺寸由 `resize` 决定）。
     * @param onChange - HUD 快照回调。
     */
    function createArenaEngine(canvas, onChange) {
      const surface = canvas.getContext('2d')
      const reduceMotion =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches

      /** CSS 像素的绘制尺寸；后备存储按 DPR 放大。 */
      let width = 0
      let height = 0
      let dpr = 1
      let raf = 0
      let lastFrame = 0
      /** 场景时钟（秒）：怠速漂移、呼吸、脉冲都靠它。 */
      let clock = 0
      /** 会话是否在跑：只影响灯的亮度与怠速漂移幅度。 */
      let live = false
      /** 日志读取状态：'idle' | 'ok' | 'lost'，HUD 据此显示「断流」。 */
      let signal = 'idle'
      /** HUD 计数器（只统计四类主要工位）。 */
      const counts = { read: 0, build: 0, smash: 0, scan: 0 }
      /** 完成的圈数（每轮会话 = 指针扫一整圈）。 */
      let laps = 0
      let combo = 0
      let lastActionAt = 0
      let nowLabel = ''
      const recent = []

      /** 指针角度（度）。允许超出 ±360，整圈扫过靠它累加。 */
      let bearing = 0
      /** 弹簧速度（度/秒）。 */
      let velocity = 0
      /** 目标方位（度）。 */
      let target = 0
      /** 每个方位的余辉（0..1），到方位时置 1，之后线性衰减。 */
      const glow = { read: 0, build: 0, smash: 0, scan: 0, drone: 0, flag: 0, helper: 0, haul: 0 }
      /** 脉冲环：`{ t: 0..1, hue }`，从轴心向外扩散。 */
      const pulses = []
      /** 最近的几个方位：画成一根细的轨迹环。 */
      const trail = []
      /** 报错时的撞击强度（0..1），只做位移抖动，不做视觉特效。 */
      let jolt = 0
      /** 最后一次「有事件」的时刻：超过 IDLE_HOLD_MS 就开始慢慢巡航。 */
      let lastActivityAt = 0
      /** 怠速外扩光波：`{ t: 0..1, hue }`，慢转时定期从盘心往外荡。 */
      const waves = []
      /** 下一圈光波还有多久（秒）。 */
      let waveTimer = 0
      /** 上次发布的快照串，内容没变就不惊动 React。 */
      let published = ''
      /** 上次发布的角度与时间：转动过程中限流更新读数（约 8 次/秒）。 */
      let publishedBearing = 0
      let bearingPublishedAt = -1

      /** 角度→弧度（画布 0° 在正右方，方位读数 0° 也是正右方 = 索引位）。 */
      const rad = (deg) => (deg * Math.PI) / 180
      /** 把角度归一化到 [0, 360)。 */
      const normalize = (deg) => ((deg % 360) + 360) % 360
      /**
       * 罗盘几何：**圆心压在面板左边缘**，所以只有右半圈看得见——盘面像从
       * 左边探出来的一半。索引（固定不动的那根指针）在正右方 0°，
       * 盘面整体旋转把当前方位的扇区送到索引上，读数就是索引指着的那一格。
       */
      const dialOf = () => {
        const radius = Math.min(height * 0.5, width * 0.62)
        // 圆心略微探进面板（约 12% 半径）：盘面大半在外，但天池与磁针整根看得见
        return { cx: radius * 0.12, cy: height / 2, r: radius }
      }

      /** 把 HUD 需要的数字发包给 React；内容没变就不发。 */
      function publish() {
        if (typeof onChange !== 'function') return
        const snapshot = {
          live,
          laps,
          bearing: Math.round(normalize(bearing)) % 360,
          // 索引指着的那一格：山名与卦名（HUD 与画布读数共用）
          mountain: mountainOf(bearing),
          gua: palaceOf(bearing).gua,
          combo,
          counts: { ...counts },
          now: nowLabel,
          recent: recent.slice(0, 3),
          signal,
        }
        const key = JSON.stringify(snapshot)
        if (key === published) return
        published = key
        onChange(snapshot)
      }

      /** 调整后备存储尺寸并立刻重画一帧（尺寸没变就什么都不做）。 */
      function resize(cssWidth, cssHeight) {
        const nextWidth = Math.max(1, Math.round(cssWidth))
        const nextHeight = Math.max(1, Math.round(cssHeight))
        const ratio = typeof window === 'undefined' ? 1 : clamp(window.devicePixelRatio || 1, 1, 2.5)
        if (nextWidth === width && nextHeight === height && ratio === dpr) return
        width = nextWidth
        height = nextHeight
        dpr = ratio
        canvas.width = Math.round(width * dpr)
        canvas.height = Math.round(height * dpr)
        surface.setTransform(dpr, 0, 0, dpr, 0, 0)
        paint()
      }

      /**
       * 从当前指针走最短路径到某个方位：不绕远路，指针不会因为 350°→10°
       * 而倒着转 340 度。
       */
      function bearingToward(from, to) {
        const delta = ((((to - normalize(from)) % 360) + 540) % 360) - 180
        return from + delta
      }

      /** 一次工具调用：指针定向 + 余辉 + 脉冲 + 连击。 */
      function push(entry) {
        const action = entry.action === 'floor' ? 'floor' : entry.error === true ? 'bump' : entry.action
        const isFloor = action === 'floor'
        const isBump = action === 'bump'
        if (!isFloor && !isBump && counts[entry.action] !== undefined) counts[entry.action] += 1

        const now = Date.now()
        combo = now - lastActionAt < 4200 ? combo + 1 : 1
        lastActionAt = now
        lastActivityAt = now
        const label = typeof entry.label === 'string' && entry.label !== '' ? entry.label : action

        if (isFloor) {
          // 一整轮结束：指针扫满一圈，圈数 +1
          laps += 1
          target = bearing + 360
          pulses.push({ t: 0, hue: '#57d2ff', big: true })
        } else if (isBump) {
          // 报错：不换方位，撞一下 —— 给弹簧一个反向冲量
          jolt = 1
          velocity -= 150
          pulses.push({ t: 0, hue: '#ff7a7a' })
        } else {
          const deg = ACTION_BEARING[action]
          if (deg !== undefined) {
            target = bearingToward(bearing, deg)
            glow[action] = 1
            pulses.push({ t: 0, hue: ACTION_HUE[action] })
            trail.push({ angle: normalize(deg), hue: ACTION_HUE[action], life: 0 })
            while (trail.length > 8) trail.shift()
          }
        }

        nowLabel = label
        recent.unshift({ key: label + '|' + String(now), label, error: entry.error === true })
        while (recent.length > 3) recent.pop()
        publish()
      }

      /**
       * 用历史铺底：打开一条跑了很久的会话时，罗盘应该已经指向「最近的方位」，
       * 而不是从 0° 开始补放一串动画。
       */
      function seed(entries) {
        for (const entry of entries) {
          if (entry.action === 'floor') {
            laps += 1
            continue
          }
          if (entry.error === true) continue
          if (counts[entry.action] !== undefined) counts[entry.action] += 1
          if (ACTION_BEARING[entry.action] !== undefined) target = bearingToward(bearing, ACTION_BEARING[entry.action])
        }
        // 铺底时指针直接就位，不摆过去
        bearing = target
        velocity = 0
        lastActivityAt = Date.now()
        publish()
      }

      /** 会话执行状态：只影响灯的亮度与怠速幅度。 */
      function setLive(next) {
        const value = next === true
        if (value === live) return
        live = value
        publish()
      }

      /** 日志读取状态（'ok' | 'lost' | 'idle'）。 */
      function setSignal(next) {
        const value = next === 'ok' || next === 'lost' ? next : 'idle'
        if (value === signal) return
        signal = value
        publish()
      }

      /**
       * 鼠标/手指拖动盘面：跟手转，松手吸附到最近的「二十四山」。
       *
       * 坐标是**画布内**的 CSS 像素；盘心在左边，所以按下时记下指针相对盘心的角度，
       * 之后每次移动取角度差（走最短路径），盘面就跟着指针转。
       * 拖过盘心附近时角度会乱跳，所以半径小于 12% 的移动直接忽略。
       */
      let dragAngle = null
      /** 松手后的惯性角速度（度/秒）；0 表示没在滑行。 */
      let spin = 0
      /** 拖动过程的采样，用来估算松手瞬间的角速度。 */
      let dragSamples = []

      /** 开始拖动（记录起始角度，并清掉上一次的滑行）。 */
      function pointerDown(x, y) {
        dragAngle = pointerAngleOf(x, y)
        spin = 0
        dragSamples = []
        lastActivityAt = Date.now()
        velocity = 0
      }

      /** 拖动中：盘面跟手。 */
      function pointerMove(x, y) {
        if (dragAngle === null) return
        const { cx, cy, r } = dialOf()
        if (Math.hypot(x - cx, y - cy) < r * 0.12) return
        const angle = pointerAngleOf(x, y)
        if (angle === null) return
        let delta = angle - dragAngle
        if (delta > 180) delta -= 360
        if (delta < -180) delta += 360
        dragAngle = angle
        // 盘面旋转量是 -bearing，指针顺时针转 → bearing 减小，盘面就跟上了
        bearing -= delta
        target = bearing
        velocity = 0
        lastActivityAt = Date.now()
        dragSamples.push({ at: Date.now(), bearing })
        if (dragSamples.length > 10) dragSamples.shift()
        publish()
      }

      /**
       * 用最近 FLING_SAMPLE_MS 内的采样估算松手瞬间角速度（度/秒）。
       * bearing 是连续量，跨 360 也不会出现跳变。
       */
      function flingVelocity() {
        if (dragSamples.length < 2) return 0
        const last = dragSamples[dragSamples.length - 1]
        let first = dragSamples[0]
        for (let index = dragSamples.length - 1; index >= 0; index -= 1) {
          const sample = dragSamples[index]
          if (last.at - sample.at > FLING_SAMPLE_MS) break
          first = sample
        }
        const elapsed = last.at - first.at
        if (elapsed < 16) return 0
        return ((last.bearing - first.bearing) / elapsed) * 1000
      }

      /**
       * 松手：甩得够快就先惯性滑一段（摩擦减速），慢下来再吸附到最近的一山；
       * 轻轻一放则直接吸附。减少动效偏好下不甩，直接吸附。
       */
      function pointerUp() {
        if (dragAngle === null) return
        dragAngle = null
        const fling = flingVelocity()
        dragSamples = []
        lastActivityAt = Date.now()
        if (reduceMotion !== true && Math.abs(fling) >= FLING_MIN_DEG_PER_SEC) {
          spin = clamp(fling, -SPIN_MAX_DEG_PER_SEC, SPIN_MAX_DEG_PER_SEC)
          velocity = 0
        } else {
          spin = 0
          target = bearingToward(bearing, Math.round(normalize(bearing) / 15) * 15)
          velocity = 0
        }
        publish()
      }

      /** 指针相对盘心的角度（度）；离盘心太近时返回 null。 */
      function pointerAngleOf(x, y) {
        const { cx, cy } = dialOf()
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null
        if (Math.hypot(x - cx, y - cy) < 1) return null
        return (Math.atan2(y - cy, x - cx) * 180) / Math.PI
      }

      /** 一帧的物理：弹簧定向、余辉衰减、脉冲扩散、连击衰减。 */
      function step(delta) {
        clock += delta
        // 用户在设置里打开「减少动效」：立刻收掉惯性，别让它继续甩
        if (reduceMotion === true && spin !== 0) {
          spin = 0
          target = bearingToward(bearing, Math.round(normalize(bearing) / 15) * 15)
        }

        // 怠速巡航：没有新事件时让「目标」自己慢慢往前走，弹簧跟上去就是匀速慢转；
        // 一来工具调用，目标立刻改成那个方位，弹簧带着惯性摆过去——慢转 → 定位。
        const cruising = dragAngle === null && spin === 0 && reduceMotion !== true && Date.now() - lastActivityAt > IDLE_HOLD_MS
        if (cruising) {
          target += (live ? IDLE_DEG_PER_SEC : IDLE_DEG_PER_SEC * 0.5) * delta
        }

        // 怠速光效：慢慢转的同时，一圈圈柔光从盘心往外扩
        if (cruising) {
          waveTimer -= delta
          if (waveTimer <= 0) {
            waveTimer = IDLE_WAVE_SECONDS
            waves.push({ t: 0, hue: palaceOf(bearing).hue })
          }
        } else {
          waveTimer = 0
        }
        for (let index = waves.length - 1; index >= 0; index -= 1) {
          waves[index].t += delta / IDLE_WAVE_LIFE
          if (waves[index].t >= 1) waves.splice(index, 1)
        }

        if (spin !== 0) {
          // 惯性滑行：直接按角速度推盘面，指数摩擦减速（每帧衰减与帧长无关）
          bearing += spin * delta
          spin *= Math.exp(-SPIN_FRICTION * delta)
          target = bearing
          // 慢到阈值以下：把剩余角速度交给弹簧，顺手吸附到最近的一山
          if (Math.abs(spin) < SPIN_STOP_DEG_PER_SEC) {
            const residual = spin
            spin = 0
            target = bearingToward(bearing, Math.round(normalize(bearing) / 15) * 15)
            velocity = residual
          }
        } else {
          // 弹簧：刚度 55、阻尼 12 —— 到位前轻微过冲，像真的仪表指针
          const accel = (target - bearing) * 55 - velocity * 12
          velocity += accel * delta
          bearing += velocity * delta
          // 速度太快时截断，避免整圈动画出现残影
          velocity = clamp(velocity, -900, 900)
        }

        for (const action of ACTION_ORDER) {
          if (glow[action] > 0) glow[action] = Math.max(0, glow[action] - delta / ACTION_GLOW_SECONDS)
        }
        for (let index = pulses.length - 1; index >= 0; index -= 1) {
          pulses[index].t += delta / (pulses[index].big ? 1.6 : 0.9)
          if (pulses[index].t >= 1) pulses.splice(index, 1)
        }
        for (let index = trail.length - 1; index >= 0; index -= 1) {
          trail[index].life += delta
          if (trail[index].life > 6) trail.splice(index, 1)
        }
        if (jolt > 0) jolt = Math.max(0, jolt - delta * 2.6)
        // 指针还在摆的时候读数也得跟着走，但按 ~8 次/秒 限流
        if (Math.abs(bearing - publishedBearing) >= 1 && clock - bearingPublishedAt > 0.12) {
          publishedBearing = bearing
          bearingPublishedAt = clock
          publish()
        }
        if (combo > 0 && Date.now() - lastActionAt > 5200) {
          combo = 0
          publish()
        }
      }

      // ---- 绘制 -----------------------------------------------------------

      /** 古制罗盘的配色：朱红（阳山/南针）、墨（阴山）、黄铜（圈线）、青（索引）。 */
      const INK = {
        brass: 'rgba(214,180,120,.55)',
        brassDim: 'rgba(214,180,120,.22)',
        vermilion: '#e8503c',
        vermilionDim: 'rgba(232,80,60,.55)',
        ink: 'rgba(150,180,205,.62)',
        inkDim: 'rgba(150,180,205,.26)',
        steel: '#cfe2f2',
      }
      /** 宋体优先：汉字圈才像罗盘，不像仪表。 */
      const SERIF = '"Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", serif'
      const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'

      /** 底盘：深色漆面 + 从左侧圆心漫开的一点冷光。 */
      function drawPlate(geo) {
        const { cx, cy, r } = geo
        const plate = surface.createRadialGradient(cx, cy, r * 0.1, cx, cy, Math.max(width, height) * 0.9)
        plate.addColorStop(0, '#121a2c')
        plate.addColorStop(0.5, '#0a1120')
        plate.addColorStop(1, '#05080f')
        surface.fillStyle = plate
        surface.fillRect(0, 0, width, height)

        // 盘面外的一圈「木框」暗影
        const rim = surface.createRadialGradient(cx, cy, r * 0.98, cx, cy, r * 1.08)
        rim.addColorStop(0, 'rgba(214,180,120,.10)')
        rim.addColorStop(1, 'rgba(214,180,120,0)')
        surface.fillStyle = rim
        surface.beginPath()
        surface.arc(cx, cy, r * 1.08, 0, Math.PI * 2)
        surface.fill()
      }

      /** 画一个同心圆环（罗盘的每一层都靠它分界）。 */
      function ring(radius, color, lineWidth) {
        surface.strokeStyle = color
        surface.lineWidth = lineWidth
        surface.beginPath()
        surface.arc(0, 0, radius, 0, Math.PI * 2)
        surface.stroke()
      }

      /** 盘面：随方位一起转的所有圈层。 */
      function drawCard(geo) {
        const { cx, cy, r } = geo
        surface.save()
        surface.translate(cx, cy)
        surface.rotate(rad(-bearing))

        // ---- 圈层分界（黄铜细线） ----
        ring(r * 0.995, INK.brass, Math.max(1.2, r * 0.0075))
        ring(r * 0.905, INK.brassDim, 1)
        ring(r * 0.80, INK.brass, 1)
        ring(r * 0.665, INK.brassDim, 1)
        ring(r * 0.505, INK.brass, Math.max(1, r * 0.005))

        // ---- 最外圈：度数（每 5° 一刻，30° 一个数字，子午卯酉加长） ----
        const degreeFont = Math.max(8, Math.round(r * 0.042))
        surface.font = '500 ' + degreeFont + 'px ' + MONO
        surface.textAlign = 'center'
        surface.textBaseline = 'middle'
        for (let deg = 0; deg < 360; deg += 5) {
          const major = deg % 30 === 0
          const axis = deg % 90 === 0
          const length = axis ? r * 0.042 : major ? r * 0.03 : r * 0.016
          const angle = rad(deg)
          const outer = r * 0.995
          const inner = outer - length
          surface.strokeStyle = axis ? INK.vermilionDim : major ? 'rgba(200,215,235,.55)' : 'rgba(180,200,220,.22)'
          surface.lineWidth = axis ? Math.max(1.4, r * 0.007) : 1
          surface.beginPath()
          surface.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner)
          surface.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer)
          surface.stroke()
          if (major) {
            surface.fillStyle = 'rgba(190,210,230,.42)'
            surface.save()
            surface.translate(Math.cos(angle) * r * 0.945, Math.sin(angle) * r * 0.945)
            surface.rotate(rad(bearing))
            surface.fillText(String(deg), 0, 0)
            surface.restore()
          }
        }

        // ---- 二十四山：每山 15°，阳山朱笔、阴山墨色，字保持直立 ----
        const mountainFont = Math.max(10, Math.round(r * 0.062))
        surface.font = '600 ' + mountainFont + 'px ' + SERIF
        MOUNTAINS_24.forEach((mountain, index) => {
          const deg = index * 15
          const angle = rad(deg)
          const lit = mountain === mountainOf(bearing) ? 1 : 0
          surface.fillStyle = YANG_MOUNTAINS.has(mountain) ? INK.vermilion : INK.ink
          surface.globalAlpha = lit === 1 ? 1 : YANG_MOUNTAINS.has(mountain) ? 0.72 : 0.5
          surface.save()
          surface.translate(Math.cos(angle) * r * 0.852, Math.sin(angle) * r * 0.852)
          surface.rotate(rad(bearing))
          surface.fillText(mountain, 0, 0)
          surface.restore()
          surface.globalAlpha = 1
        })

        // ---- 后天八卦八宫：卦符 + 名，当前宫亮起 ----
        const glyphFont = Math.max(13, Math.round(r * 0.085))
        const guaFont = Math.max(9, Math.round(r * 0.045))
        PALACES.forEach((palace) => {
          const angle = rad(palace.deg)
          const lit = glow[palace.action]
          surface.save()
          surface.translate(Math.cos(angle) * r * 0.735, Math.sin(angle) * r * 0.735)
          surface.rotate(rad(bearing))
          surface.font = '400 ' + glyphFont + 'px ' + SERIF
          surface.fillStyle = palace.hue
          surface.globalAlpha = 0.42 + lit * 0.58
          surface.fillText(palace.glyph, 0, -glyphFont * 0.28)
          surface.font = '600 ' + guaFont + 'px ' + SERIF
          surface.globalAlpha = 0.3 + lit * 0.7
          surface.fillText(palace.gua, 0, glyphFont * 0.62)
          surface.restore()
          surface.globalAlpha = 1
        })

        // ---- 天池：子午线 + 池壁 ----
        const pool = r * 0.505
        const poolFill = surface.createRadialGradient(0, 0, 1, 0, 0, pool)
        poolFill.addColorStop(0, 'rgba(14,28,48,.95)')
        poolFill.addColorStop(0.7, 'rgba(8,16,30,.96)')
        poolFill.addColorStop(1, 'rgba(4,8,18,.98)')
        surface.fillStyle = poolFill
        surface.beginPath()
        surface.arc(0, 0, pool, 0, Math.PI * 2)
        surface.fill()
        // 子午线（红线）与卯酉线（细线）
        surface.strokeStyle = INK.vermilionDim
        surface.lineWidth = Math.max(1, r * 0.006)
        surface.beginPath()
        surface.moveTo(pool * 0.94, 0)
        surface.lineTo(-pool * 0.94, 0)
        surface.stroke()
        surface.strokeStyle = INK.brassDim
        surface.lineWidth = 1
        surface.beginPath()
        surface.moveTo(0, pool * 0.94)
        surface.lineTo(0, -pool * 0.94)
        surface.stroke()


        // ---- 余辉：当前山的那 15° 一格 ----
        const activeIndex = Math.round(normalize(bearing) / 15) % 24
        const lit = PALACES.reduce(
          (best, palace) => (glow[palace.action] > best.lit ? { hue: palace.hue, lit: glow[palace.action] } : best),
          { hue: '#4fc3f7', lit: 0 },
        )
        // 高亮画成 0.80–0.905 之间的扇形底带：字压在它上面，不会被弧线盖住
        const half = 7.2
        surface.save()
        surface.shadowColor = lit.hue
        surface.shadowBlur = r * 0.10 * lit.lit
        surface.fillStyle = lit.hue
        surface.globalAlpha = 0.10 + lit.lit * 0.22
        surface.beginPath()
        surface.arc(0, 0, r * 0.905, rad(activeIndex * 15 - half), rad(activeIndex * 15 + half))
        surface.arc(0, 0, r * 0.80, rad(activeIndex * 15 + half), rad(activeIndex * 15 - half), true)
        surface.closePath()
        surface.fill()
        // 两侧描边 + 一根指示线，指向索引
        surface.globalAlpha = 0.35 + lit.lit * 0.5
        surface.strokeStyle = lit.hue
        surface.lineWidth = Math.max(1, r * 0.005)
        surface.stroke()
        surface.restore()
        surface.globalAlpha = 1

        // ---- 最近的方位：落在八卦与天池之间的一圈细弧 ----
        for (const entry of trail) {
          const fade = clamp(1 - entry.life / 6, 0, 1)
          surface.strokeStyle = entry.hue
          surface.globalAlpha = 0.08 + fade * 0.28
          surface.lineWidth = Math.max(1.4, r * 0.012)
          surface.lineCap = 'round'
          surface.beginPath()
          surface.arc(0, 0, r * 0.60, rad(entry.angle - 4), rad(entry.angle + 4))
          surface.stroke()
        }
        surface.globalAlpha = 1
        surface.restore()
      }

      /**
       * 磁针：**不随盘转**，永远指南北（针尖朝上为子/北，朱红半截朝下为午/南）。
       * 盘面绕它转——这正是罗盘的用法：转内盘，针不动。
       */
      function drawNeedle(geo) {
        const { cx, cy, r } = geo
        const pool = r * 0.505
        const needle = pool * 0.86
        const halfWidth = Math.max(3, r * 0.017)
        // 针影
        surface.save()
        surface.shadowColor = 'rgba(232,80,60,.5)'
        surface.shadowBlur = r * 0.05
        // 子（北，钢色，朝上）
        surface.fillStyle = INK.steel
        surface.beginPath()
        surface.moveTo(cx, cy - needle)
        surface.lineTo(cx + halfWidth, cy)
        surface.lineTo(cx - halfWidth, cy)
        surface.closePath()
        surface.fill()
        // 午（南，朱红，朝下）
        surface.fillStyle = INK.vermilion
        surface.beginPath()
        surface.moveTo(cx, cy + needle)
        surface.lineTo(cx + halfWidth * 0.78, cy)
        surface.lineTo(cx - halfWidth * 0.78, cy)
        surface.closePath()
        surface.fill()
        surface.restore()
        // 顶针：天池中心的小轴
        surface.fillStyle = 'rgba(10,18,32,.96)'
        surface.beginPath()
        surface.arc(cx, cy, Math.max(3, r * 0.026), 0, Math.PI * 2)
        surface.fill()
        surface.strokeStyle = INK.brass
        surface.lineWidth = Math.max(1, r * 0.005)
        surface.beginPath()
        surface.arc(cx, cy, Math.max(3, r * 0.026), 0, Math.PI * 2)
        surface.stroke()
      }

      /** 索引（不动）：读数、三角标、到位脉冲。 */
      function drawIndex(geo) {
        const { cx, cy, r } = geo
        const palace = palaceOf(bearing)
        const lit = glow[palace.action] ?? 0

        // 脉冲：从轴心向外荡
        for (const pulse of pulses) {
          const progress = clamp(pulse.t, 0, 1)
          surface.strokeStyle = pulse.hue
          surface.globalAlpha = (1 - progress) * (pulse.big ? 0.45 : 0.34)
          surface.lineWidth = Math.max(1.2, r * 0.011 * (1 - progress))
          surface.beginPath()
          surface.arc(cx, cy, r * (0.16 + progress * (pulse.big ? 1.0 : 0.84)), 0, Math.PI * 2)
          surface.stroke()
        }
        surface.globalAlpha = 1

        // 索引三角：贴在盘沿，指向盘心
        surface.save()
        surface.shadowColor = palace.hue
        surface.shadowBlur = r * (0.03 + lit * 0.06)
        surface.fillStyle = palace.hue
        surface.beginPath()
        surface.moveTo(cx + r * 1.015, cy)
        surface.lineTo(cx + r * 0.965, cy - r * 0.026)
        surface.lineTo(cx + r * 0.965, cy + r * 0.026)
        surface.closePath()
        surface.fill()
        surface.restore()
        surface.strokeStyle = palace.hue
        surface.globalAlpha = 0.35 + lit * 0.4
        surface.lineWidth = 1
        surface.beginPath()
        surface.moveTo(cx + r * 1.015, cy)
        surface.lineTo(cx + r * 1.10, cy)
        surface.stroke()
        surface.globalAlpha = 1

        // 读数：度数 / 山 / 卦
        const value = String(Math.round(normalize(bearing)) % 360).padStart(3, '0')
        const bigFont = Math.max(18, Math.round(r * 0.135))
        surface.font = '600 ' + bigFont + 'px ' + MONO
        surface.textAlign = 'left'
        surface.textBaseline = 'middle'
        surface.fillStyle = 'rgba(232,248,255,.92)'
        surface.fillText(value + '°', cx + r * 1.13, cy - r * 0.035)
        const nameFont = Math.max(12, Math.round(r * 0.075))
        surface.font = '600 ' + nameFont + 'px ' + SERIF
        surface.fillStyle = palace.hue
        const mountain = mountainOf(bearing)
        surface.fillText(mountain + ' 山 · ' + palace.gua + '宫', cx + r * 1.13, cy + r * 0.075)
      }

      /** `'#rrggbb'` → `'rgba(r,g,b,a)'`：画布渐变只吃颜色字符串。 */
      function hexToRgba(hex, alpha) {
        const value = parseInt(String(hex).slice(1), 16)
        if (!Number.isFinite(value)) return 'rgba(87,210,255,' + alpha.toFixed(3) + ')'
        return (
          'rgba(' +
          ((value >> 16) & 255) + ',' +
          ((value >> 8) & 255) + ',' +
          (value & 255) + ',' +
          alpha.toFixed(3) + ')'
        )
      }

      /**
       * 怠速光效：一圈柔光从盘心往外扩，扩到盘沿之外再淡掉。
       * 只画在已绘制内容之上、不参与命中，纯氛围。
       */
      function drawWaves(geo) {
        const { cx, cy, r } = geo
        for (const wave of waves) {
          const progress = clamp(wave.t, 0, 1)
          // 先快后慢，像水面荡开
          const eased = 1 - Math.pow(1 - progress, 2.4)
          const radius = r * (0.14 + eased * 1.30)
          const fade = 1 - progress
          const hue = wave.hue
          // 柔光带：贴着波前的一层渐隐
          const bloom = surface.createRadialGradient(cx, cy, radius * 0.52, cx, cy, radius)
          bloom.addColorStop(0, hexToRgba(hue, 0))
          bloom.addColorStop(0.74, hexToRgba(hue, 0.20 * fade))
          bloom.addColorStop(0.92, hexToRgba(hue, 0.06 * fade))
          bloom.addColorStop(1, hexToRgba(hue, 0))
          surface.fillStyle = bloom
          surface.beginPath()
          surface.arc(cx, cy, radius, 0, Math.PI * 2)
          surface.fill()
          // 波前细环
          surface.strokeStyle = hexToRgba(hue, 0.46 * fade)
          surface.lineWidth = Math.max(1.2, r * 0.014 * fade)
          surface.beginPath()
          surface.arc(cx, cy, radius, 0, Math.PI * 2)
          surface.stroke()
        }
      }

      /** 一帧。 */
      function paint() {
        if (width <= 0 || height <= 0) return
        const geo = dialOf()
        surface.save()
        if (jolt > 0.02 && reduceMotion === false) {
          surface.translate((Math.random() - 0.5) * jolt * 5, (Math.random() - 0.5) * jolt * 5)
        }
        drawPlate(geo)
        drawCard(geo)
        drawWaves(geo)
        drawNeedle(geo)
        drawIndex(geo)
        surface.restore()
      }

      /** rAF 主循环。 */
      function frame(timestamp) {
        raf = window.requestAnimationFrame(frame)
        if (lastFrame === 0) lastFrame = timestamp
        const delta = Math.min(0.05, (timestamp - lastFrame) / 1000)
        lastFrame = timestamp
        if (delta <= 0) return
        step(delta)
        paint()
      }

      /** 启动（幂等）。 */
      function start() {
        if (raf !== 0 || typeof window === 'undefined') return
        lastFrame = 0
        raf = window.requestAnimationFrame(frame)
      }

      /** 停掉 rAF。 */
      function stop() {
        if (raf !== 0) window.cancelAnimationFrame(raf)
        raf = 0
      }

      return { resize, push, seed, setLive, setSignal, pointerDown, pointerMove, pointerUp, start, stop }
    }


    /**
     * Current shell facts the overlays need: focus mode on/off, whether the
     * command deck is on the page, which panel the main view sits in
     * (`sector` | `live`), and which panel view is up (`content` | `game`).
     */
    function readShellState() {
      if (typeof document === 'undefined') return { focus: false, deck: false, mode: 'sector', view: VIEW_CONTENT }
      const root = document.documentElement
      const mode = root.getAttribute('data-fcd-mode')
      const view = root.getAttribute(VIEW_ATTR)
      return {
        focus: root.hasAttribute(FOCUS_ATTR),
        deck: document.querySelector('.fcd-deck') !== null,
        mode: mode === 'live' ? 'live' : 'sector',
        view: view === VIEW_GAME ? VIEW_GAME : VIEW_CONTENT,
      }
    }

    /**
     * Watch the shell facts above. Returning the previous state when they
     * did not change keeps the frequent body mutations of a streaming turn from
     * re-rendering the overlay.
     */
    function useShellState() {
      const [state, setState] = useState(readShellState)
      useEffect(() => {
        // 首帧渲染时同一批挂载的面板可能还没进 DOM，观察器也来不及收到那次插入；
        // 挂上观察器后先补读一次，避免「要等下一次 DOM 变动面板才出现」。
        const read = () => {
          setState((previous) => {
            const next = readShellState()
            return previous.focus === next.focus &&
              previous.deck === next.deck &&
              previous.mode === next.mode &&
              previous.view === next.view
              ? previous
              : next
          })
        }
        read()
        const observer = new MutationObserver(read)
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: [FOCUS_ATTR, 'data-fcd-mode', VIEW_ATTR],
        })
        observer.observe(document.body, { childList: true, subtree: true })
        return () => observer.disconnect()
      }, [])
      return state
    }

    // ---- 视图切换控件 -----------------------------------------------------

    /** Icon: horizontal lines (the chat flow). */
    function ViewContentIcon() {
      return el(
        'svg',
        { viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': true },
        el('path', {
          d: 'M2 3.5h8M2 6h8M2 8.5h5',
          stroke: 'currentColor',
          strokeWidth: '1.3',
          strokeLinecap: 'round',
        }),
      )
    }

    /** Icon: a compass dial (rings + a needle). */
    function ViewGameIcon() {
      return el(
        'svg',
        { viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': true },
        el('circle', { cx: 6, cy: 6, r: 4.3, stroke: 'currentColor', strokeWidth: '1.2' }),
        el('path', {
          d: 'M6 1.4v1.5M6 9.1v1.5M1.4 6h1.5M9.1 6h1.5',
          stroke: 'currentColor',
          strokeWidth: '1.1',
          strokeLinecap: 'round',
        }),
        el('path', {
          d: 'M6 3.4 7.2 6 6 8.6 4.8 6Z',
          fill: 'currentColor',
          opacity: '0.85',
        }),
      )
    }

    /**
     * The 内容 / 工地 segmented switch. Rendered both over the chat panel and
     * inside the game HUD, always in the same corner, so switching back is
     * never a hunt.
     */
    function ViewSwitch({ t, view, onChange, style, nodeRef }) {
      const options = [
        { key: VIEW_CONTENT, label: t('arena.viewContent'), hint: t('arena.hintContent'), icon: ViewContentIcon },
        { key: VIEW_GAME, label: t('arena.viewGame'), hint: t('arena.hintGame'), icon: ViewGameIcon },
      ]
      /**
       * 指针**按下**就切，不等 click：
       * 面板尺寸/位置每 400ms 会重算一次，万一胶囊在按下与抬起之间挪了几像素，
       * 浏览器就不会再派发 click，表现成「有时候点不动」。按下即生效可以彻底避开。
       * 键盘（Enter/Space）走的是合成 click（detail === 0），保留一条通路。
       */
      const activate = (key) => {
        onChange(key)
      }
      return el(
        'div',
        {
          className: 'fcd-viewSwitch',
          style,
          role: 'group',
          'aria-label': t('arena.viewHint'),
          ref: nodeRef,
          // 整颗胶囊都是可点区域：落在按钮之间的缝或圆角内边距上，就直接切到另一侧
          onPointerDown: (event) => {
            if (event.button !== undefined && event.button > 0) return
            activate(view === VIEW_GAME ? VIEW_CONTENT : VIEW_GAME)
          },
        },
        options.map((option) =>
          el(
            'button',
            {
              key: option.key,
              type: 'button',
              'data-on': view === option.key ? 'true' : 'false',
              'aria-pressed': view === option.key,
              title: option.hint,
              onPointerDown: (event) => {
                // 只认主键（右键/中键不动），触摸与手写笔也算
                if (event.button !== undefined && event.button > 0) return
                event.stopPropagation()
                activate(option.key)
              },
              onClick: (event) => {
                // 指针路径已经在 pointerdown 里处理；detail === 0 是键盘触发的 click
                if (event.detail === 0) activate(option.key)
              },
            },
            el(option.icon),
            el('span', null, option.label),
          )),
      )
    }

    // ---- 工具流水轮询 -----------------------------------------------------

    /**
     * Poll the Session log while the game view is on screen and hand every new
     * tool call to the scene.
     *
     * Why a poll and not a subscription: the game needs the *committed* log —
     * the same source the Host replays a Session from — and the Gateway Remote
     * exposes it as pages. Reads only happen while the game is visible, the
     * Session is on screen, and the tab is awake, so the cost is one small read
     * per second at most.
     *
     * The effect only depends on the Session and whether the feed is live:
     * `readPage`, `describe` and the running flag go through refs, so a parent
     * re-render never resets the cursor (which would re-prime and double-count).
     */
    function useToolFeed(options) {
      const { active, sessionId, running, readPage, describe, engineRef } = options
      const runningRef = useRef(running)
      const readPageRef = useRef(readPage)
      const describeRef = useRef(describe)
      useEffect(() => {
        runningRef.current = running
        readPageRef.current = readPage
        describeRef.current = describe
      }, [running, readPage, describe])

      useEffect(() => {
        if (!active || sessionId === undefined) return undefined
        const controller = new AbortController()
        let stopped = false
        let timer = 0
        let lastSeq = -1
        let failures = 0
        const schedule = (delay) => {
          if (stopped) return
          timer = window.setTimeout(run, delay)
        }
        const run = async () => {
          if (stopped) return
          // 后台标签页不读：回来的时候一次读到的就是全部新事件
          if (typeof document !== 'undefined' && document.hidden) {
            schedule(2500)
            return
          }
          const read = readPageRef.current
          if (typeof read !== 'function') {
            schedule(4000)
            return
          }
          let page = null
          try {
            page = await read(sessionId, controller.signal)
          } catch {
            page = null
          }
          if (stopped) return
          const engine = engineRef.current
          if (page === null || page.records === null) {
            // 读不到就退避重试：画面照常跑，HUD 不跳字
            failures += 1
            // 连续失败才报「读不到日志」：偶发一次不值得吓人
            if (failures >= 2 && engine !== null) engine.setSignal('lost')
            schedule(Math.min(6000, 1200 * failures))
            return
          }
          failures = 0
          if (engine !== null) engine.setSignal('ok')
          const folded = foldToolSceneEvents(page.records)
          if (lastSeq < 0) {
            // 首次只铺底（工位计数 / 楼层），不回放历史：
            // 打开一条跑了半小时的会话，不该先放半分钟施工动画。
            if (engine !== null) engine.seed(folded)
            lastSeq = folded.length > 0 ? folded[folded.length - 1].seq : 0
          } else if (engine !== null) {
            for (const entry of folded) {
              if (entry.seq <= lastSeq) continue
              lastSeq = entry.seq
              const build = describeRef.current
              engine.push({ ...entry, label: typeof build === 'function' ? build(entry) : '' })
            }
          }
          schedule(runningRef.current ? 1000 : 4000)
        }
        run()
        return () => {
          stopped = true
          controller.abort()
          window.clearTimeout(timer)
        }
      }, [active, sessionId, engineRef])
    }

    // ---- 游戏面板 ---------------------------------------------------------

    /**
     * The 赛博工地 panel: canvas scene plus its HUD. Mounted only while the
     * game view is up, so the animation loop and the polling both stop the
     * moment the user switches back to the content view.
     */
    function ArenaPanel({ t, frame, running, sessionId, readPage }) {
      const canvasRef = useRef(null)
      const engineRef = useRef(null)
      const [snapshot, setSnapshot] = useState(EMPTY_ARENA_SNAPSHOT)
      const describe = React.useCallback((entry) => describeSceneEvent(t, entry), [t])

      // 罗盘旁边的句子：跑着的时候轮番换，一轮结束换成「发现古墓」
      // 池子 = 本地底库 + 联网补的句子，池子长度会变，所以用 ref 拿最新长度
      const notes = useStoreValue(notesQuoteStore)
      const quoteLines = notes.lines.length > 0 ? notes.lines : RUN_QUOTES
      const quoteCountRef = useRef(quoteLines.length)
      quoteCountRef.current = quoteLines.length
      const [quoteIndex, setQuoteIndex] = useState(0)
      const [found, setFound] = useState(false)
      const wasRunning = useRef(running)
      useEffect(() => {
        // 只有任务在跑的时候才轮换；待命时卡片淡出，不打扰
        if (found || running !== true) return undefined
        const timer = window.setInterval(() => {
          setQuoteIndex((index) => (index + 1) % Math.max(1, quoteCountRef.current))
        }, QUOTE_INTERVAL_MS)
        return () => window.clearInterval(timer)
      }, [found, running])
      useEffect(() => {
        const previous = wasRunning.current
        wasRunning.current = running
        // 只在「跑 → 停」的那一下触发，挂载时本来就是停的不算
        if (previous !== true || running === true) return undefined
        setFound(true)
        const timer = window.setTimeout(() => setFound(false), FOUND_HOLD_MS)
        return () => window.clearTimeout(timer)
      }, [running])

      // 面板打开时顺手看一下话术池是否过期（过期才真的发请求）
      useEffect(() => {
        void refreshNotesQuotes(false)
      }, [])

      // 引擎生命周期与画布同寿：切走即停 rAF，不留后台动画
      useEffect(() => {
        const canvas = canvasRef.current
        if (canvas === null) return undefined
        const engine = createArenaEngine(canvas, setSnapshot)
        engineRef.current = engine
        engine.resize(frame.panel.width, frame.panel.height)
        engine.start()
        return () => {
          engine.stop()
          engineRef.current = null
        }
        // frame 只在挂载时取一次，尺寸变化交给下面的 resize 效应
      }, [])

      // 面板尺寸变化（窗口缩放 / 侧栏收放）→ 重设画布，不用重建引擎
      useEffect(() => {
        const engine = engineRef.current
        if (engine !== null) engine.resize(frame.panel.width, frame.panel.height)
      }, [frame.panel.width, frame.panel.height])

      // 执行中/待命：画面一直是活的，只是灯更亮
      useEffect(() => {
        const engine = engineRef.current
        if (engine !== null) engine.setLive(running)
      }, [running])

      useToolFeed({ active: true, sessionId, running, readPage, describe, engineRef })

      // 拖盘：指针按下 → 跟手转，松开 → 吸附到最近的山
      const [dragging, setDragging] = useState(false)
      /** 事件坐标换成画布内的 CSS 像素（引擎自己知道盘心在哪）。 */
      const localPoint = (event) => {
        const canvas = canvasRef.current
        if (canvas === null) return null
        const rect = canvas.getBoundingClientRect()
        return { x: event.clientX - rect.left, y: event.clientY - rect.top }
      }
      const dragHandlers = {
        onPointerDown: (event) => {
          if (event.button !== undefined && event.button > 0) return
          const engine = engineRef.current
          const point = localPoint(event)
          if (engine === null || point === null) return
          // 拖盘期间不要顺带选中文字
          event.preventDefault()
          const canvas = canvasRef.current
          if (canvas !== null && typeof canvas.setPointerCapture === 'function') {
            try {
              canvas.setPointerCapture(event.pointerId)
            } catch {
              // 某些环境不支持指针捕获，退化成普通拖动
            }
          }
          setDragging(true)
          engine.pointerDown(point.x, point.y)
        },
        onPointerMove: (event) => {
          const engine = engineRef.current
          const point = localPoint(event)
          if (engine === null || point === null) return
          engine.pointerMove(point.x, point.y)
        },
        onPointerUp: () => {
          engineRef.current?.pointerUp()
          setDragging(false)
        },
        onPointerCancel: () => {
          engineRef.current?.pointerUp()
          setDragging(false)
        },
      }

      const stats = [
        { key: 'read', label: t('arena.kRead'), value: snapshot.counts.read },
        { key: 'build', label: t('arena.kBuild'), value: snapshot.counts.build },
        { key: 'smash', label: t('arena.kSmash'), value: snapshot.counts.smash },
        { key: 'scan', label: t('arena.kScan'), value: snapshot.counts.scan },
      ]

      return el(
        'div',
        {
          className: 'fcd-arena',
          'data-live': running ? 'true' : 'false',
          style: {
            left: frame.panel.left - frame.origin.left,
            top: frame.panel.top - frame.origin.top,
            width: frame.panel.width,
            height: frame.panel.height,
          },
        },
        el('canvas', {
          ref: canvasRef,
          role: 'img',
          'aria-label': t('arena.canvasLabel'),
          'data-dragging': dragging ? 'true' : 'false',
          ...dragHandlers,
        }),
        el('div', { className: 'fcd-arenaVignette', 'aria-hidden': true }),
        el(
          'div',
          { className: 'fcd-arenaHud' },
          el(
            'div',
            { className: 'fcd-arenaHudTop' },
            el(
              'span',
              { className: 'fcd-arenaHead' },
              el('span', { className: 'fcd-mark', 'aria-hidden': true }),
              el('span', null, t('arena.title')),
              el('span', { className: 'fcd-arenaDot', 'aria-hidden': true }),
              el('span', null, running ? t('arena.live') : t('arena.idle')),
              // 日志读不到时明确说一句：画面还在跑，但工具流水断了
              snapshot.signal === 'lost'
                ? el('span', { className: 'fcd-arenaSignal', title: t('arena.signalLost') }, t('arena.noLog'))
                : null,
            ),
            el(
              'span',
              { className: 'fcd-arenaStats' },
              stats.map((stat) =>
                el(
                  'span',
                  { key: stat.key, className: 'fcd-arenaStat' },
                  el('i', { 'aria-hidden': true }, stat.label),
                  el('b', null, String(stat.value)),
                )),
              snapshot.combo > 1
                ? el(
                    'span',
                    { className: 'fcd-arenaStat', 'data-kind': 'combo' },
                    el('i', { 'aria-hidden': true }, t('arena.combo')),
                    el('b', null, '×' + String(snapshot.combo)),
                  )
                : null,
            ),
          ),
          el(
            'div',
            { className: 'fcd-arenaHudBottom' },
            el(
              'div',
              { className: 'fcd-arenaTicker' },
              el(
                'div',
                { className: 'fcd-arenaNow' },
                el('span', { 'aria-hidden': true }, '▸'),
                el('span', null, snapshot.now === '' ? t('arena.waiting') : snapshot.now),
              ),
              el(
                'div',
                { className: 'fcd-arenaChips' },
                snapshot.recent.map((item) =>
                  el(
                    'span',
                    { key: item.key, className: 'fcd-arenaChip', 'data-err': item.error ? 'true' : 'false', title: item.label },
                    el('i', { 'aria-hidden': true }, item.error ? '✕' : '▣'),
                    el('span', null, item.label),
                  )),
              ),
            ),
            el(
              'span',
              { className: 'fcd-arenaDial' },
              el(
                'span',
                { className: 'fcd-arenaFloor', title: t('arena.bearingHint') },
                el('span', null, t('arena.bearing')),
                // 山名用宋体，和盘面上的字同一套写法
                el('b', { className: 'fcd-arenaMountain' }, snapshot.mountain),
                el('b', null, String(snapshot.bearing).padStart(3, '0') + '°'),
              ),
              el(
                'span',
                { className: 'fcd-arenaFloor' },
                el('span', null, t('arena.laps')),
                el('b', null, String(snapshot.laps)),
              ),
            ),
          ),
        ),
        el(
          'div',
          {
            className: 'fcd-arenaQuote',
            'data-found': found ? 'true' : 'false',
            // 待命且没有「发现古墓」时淡出：这句话属于运行中的画面
            'data-hidden': found || running ? 'false' : 'true',
            'aria-live': 'polite',
          },
          el('span', { className: 'fcd-arenaSeal', 'aria-hidden': true }, found ? t('arena.foundSeal') : t('arena.noteSeal')),
          el(
            'span',
            // key 一变就等于换节点，CSS 入场动画会重新播一次
            { className: 'fcd-arenaQuoteText', key: found ? 'found' : 'q' + String(quoteIndex) },
            found ? FOUND_QUOTE : quoteLines[quoteIndex % quoteLines.length],
          ),
        ),
      )
    }

    // ---- 根层壳：量面板 + 挂切换控件 ---------------------------------------

    /**
     * Root-scoped overlay that owns the panel-view switch and, in game view,
     * the 赛博工地 panel on top of the chat card.
     *
     * It only exists while focus mode is on and the main view sits inside one
     * specific Session — the same condition the stylesheet uses for the chat
     * card, so the switch can never appear over a screen that has no panel.
     */
    function ArenaOverlay(props) {
      const { t, readPage } = props
      const useSessionStatus = props.useSessionStatus ?? useNothing
      const shell = useShellState()
      const view = useStoreValue(viewModeStore)
      const sessionId = useStoreValue(currentSessionStore)
      const running = useSessionStatus((snapshot) => {
        if (sessionId === undefined || snapshot === undefined) return false
        const entry = snapshot.get(sessionId)
        return entry !== undefined && entry.running === true
      })
      const rootRef = useRef(null)
      const switchRef = useRef(null)
      const warnedRef = useRef(false)
      const [occluded, setOccluded] = useState(false)
      const visible = shell.focus && shell.mode === 'live'
      const frame = useArenaFrame(visible, rootRef)

      /**
       * 命中自检：胶囊画出来了不等于点得到——别的插件/宿主的浮层要是压在右上角，
       * 鼠标事件就被它吃掉，表现成「选不中」。这里每秒用 elementFromPoint 验一次，
       * 被挡住就抬到最高层并往左让开一格（console 会报出遮挡者，便于排查）。
       */
      useEffect(() => {
        if (!visible || frame === null) return undefined
        const check = () => {
          try {
            const node = switchRef.current
            if (node === null || typeof document.elementFromPoint !== 'function') return
            const rect = node.getBoundingClientRect()
            if (rect.width < 4 || rect.height < 4) return
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
            const covered = hit !== null && hit !== undefined && hit !== node && !node.contains(hit)
            setOccluded(covered)
            if (covered && warnedRef.current === false) {
              warnedRef.current = true
              const describe = (node) => {
                try {
                  const name = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : String(node)
                  const className = typeof node.className === 'string' ? node.className.split(' ')[0] : ''
                  const slot = typeof node.getAttribute === 'function' ? node.getAttribute('data-slot') : null
                  return name + (className === '' ? '' : '.' + className) + (slot === null ? '' : '[data-slot="' + slot + '"]')
                } catch {
                  return String(node)
                }
              }
              console.warn('[future-command-deck] 视图切换胶囊被遮挡，已自动避让。遮挡者：' + describe(hit))
            }
          } catch {
            // 某些环境（服务端渲染 / 无布局的测试环境）没有命中测试，忽略
          }
        }
        check()
        const timer = window.setInterval(check, 1000)
        return () => window.clearInterval(timer)
      }, [visible, frame])

      // 不在某个具体会话里（主战区 / 完整界面）：整层不渲染，页面保持原样。
      if (!visible) return null
      // 面板还没量到：先挂一个空容器，它自己的 rect 就是后面所有定位的原点。
      // 这个窗口只有一帧到几百毫秒，胶囊下一帧就跟上来。
      if (frame === null) {
        return el('div', { className: 'fcd-arenaRoot', ref: rootRef, 'aria-hidden': true })
      }

      const panelLeft = frame.panel.left - frame.origin.left
      const panelTop = frame.panel.top - frame.origin.top

      return el(
        'div',
        { className: 'fcd-arenaRoot', ref: rootRef },
        view === VIEW_GAME
          ? // key 绑会话：切到别的会话就是一块新盘面，不带上一场的圈数与读数
            el(ArenaPanel, { key: sessionId ?? 'none', t, frame, running, sessionId, readPage })
          : null,
        // 切换胶囊挂在**根层**、不在面板里：面板有 overflow:hidden、上面还压着画布与
        // 扫描层，放在里面一旦层叠出岔子就点不动了。这里两种视图都是同一个位置。
        el(ViewSwitch, {
          t,
          view,
          onChange: setPanelView,
          nodeRef: switchRef,
          style: occluded
            ? // 被别的浮层压住：抬到最上层，并往左让出一个身位
              {
                left: panelLeft + frame.panel.width - 44 - 140,
                top: panelTop + 12,
                transform: 'translateX(-100%)',
                zIndex: 9999,
              }
            : {
                // 离面板右边缘 44px：太贴边容易被窗口边缘的手柄/滚动条/别家浮层压住
                left: panelLeft + frame.panel.width - 44,
                top: panelTop + 12,
                transform: 'translateX(-100%)',
              },
        }),
        // 真要还是被挡住：在面板右下角再挂一枚同样的胶囊（那一角通常没人抢），
        // 只在自检到遮挡时出现，正常情况下一枚就够。
        occluded
          ? el(ViewSwitch, {
              t,
              view,
              onChange: setPanelView,
              style: {
                left: panelLeft + frame.panel.width - 44,
                top: panelTop + frame.panel.height - 40,
                transform: 'translateX(-100%)',
                zIndex: 9999,
              },
            })
          : null,
      )
    }


    /**
     * Frame-wide HUD: grid, corner brackets, and a slow scan sweep. While focus
     * mode is on and no command deck is on the page (any panel other than the
     * conversation), it also carries a small pill back to the full shell so the
     * mode can never trap the user.
     */
    function HudOverlay(props) {
      const { t } = props
      const shell = useShellState()
      const useSessions = props.useSessions ?? useNothing
      const byId = useSessions((snapshot) => snapshot?.byId)
      const current = useStoreValue(currentSessionStore)
      const dockHidden = useStoreValue(dockHiddenStore)
      // 手动收起后，只要还有别的会话在跑，就留一个恢复入口
      const mainMode = useStoreValue(mainModeStore)
      const useSessionStatus = props.useSessionStatus ?? useNothing
      const statuses = useSessionStatus((snapshot) => snapshot)
      // 只有「确实还有会话在跑」时才给恢复入口：没有进行中的任务，
      // 这张面板本来就是空的，不该留一颗没有意义的胶囊。
      const anyActive = useMemo(() => {
        if (statuses === undefined || statuses === null || typeof statuses.get !== 'function') return false
        for (const id of Object.keys(byId ?? {})) {
          if (id === current) continue
          const status = statuses.get(id)
          if (status?.running === true || status?.pendingInteraction !== undefined) return true
        }
        return false
      }, [statuses, byId, current])
      const restoreDock = shell.focus && dockHidden && shell.deck && mainMode === 'sector' && anyActive
      const escape = shell.focus && !shell.deck
      const exit = () => {
        applyFocusAttribute(false)
        writeFocusPreference(false)
      }
      return el(
        'div',
        { className: 'fcd-hud' },
        el('div', { className: 'fcd-hudGrid', 'aria-hidden': true }),
        restoreDock
          ? el(
              'button',
              {
                type: 'button',
                className: 'fcd-exitChip fcd-dockChip',
                title: t('dock.restore'),
                'aria-label': t('dock.restore'),
                onClick: () => {
                  dockHiddenStore.set(false)
                },
              },
              el('span', { 'aria-hidden': true }, '▤'),
              el('span', null, t('dock.title')),
            )
          : null,
        escape
          ? el(
              'button',
              {
                type: 'button',
                className: 'fcd-exitChip',
                title: t('deck.fullUiHint'),
                'aria-label': t('deck.fullUiHint'),
                onClick: exit,
              },
              el(LayoutIcon),
              el('span', null, t('deck.fullUi')),
            )
          : null,
      )
    }

    // ---------------------------------------------------------------------
    // Application operations shared by the deck
    // ---------------------------------------------------------------------

    /**
     * Select a sector: open (or reuse) that Workspace's blank Session, so the
     * Workspace chip above the composer follows the choice and the main view
     * becomes that sector's new-session screen. Existing conversations stay in
     * the top-right dock until they are clicked there.
     */
    async function openSector(ctx, workspaceId) {
      const uiWorkspace = ctx.get('uiWorkspace')
      if (uiWorkspace === undefined) throw new Error('workspace service is not available in this profile')
      await uiWorkspace.openWorkspace(workspaceId)
    }

    /** 主战区: start a fresh Session in the default Workspace (the home view). */
    function openHomeSector(ctx) {
      const uiWorkspace = ctx.get('uiWorkspace')
      if (uiWorkspace === undefined) throw new Error('workspace service is not available in this profile')
      uiWorkspace.startSession()
    }

    /** Promote one Session to the main view (the panel click action). */
    function openSessionInMain(ctx, sessionId) {
      const uiWorkspace = ctx.get('uiWorkspace')
      if (uiWorkspace === undefined) return
      // 显式打开 → 该会话即便原本是“主战区会话”也切到对话界面
      pinDeckMode(sessionId, 'live')
      uiWorkspace.openSession(sessionId)
    }

    /**
     * Open a new sector: pick a local directory, register it as a Workspace,
     * then deploy into it. Resolves to null when the user cancels the picker.
     */
    async function openNewSector(ctx) {
      const uiWorkspace = ctx.get('uiWorkspace')
      const workspaces = ctx.get('workspaces')
      if (uiWorkspace === undefined || workspaces === undefined) {
        throw new Error('workspace service is not available in this profile')
      }
      const path = await uiWorkspace.pickDirectory()
      if (path === null || path === '') return null
      const created = await workspaces.create({ path })
      await uiWorkspace.openWorkspace(created.workspaceId)
      return created.workspaceId
    }

    // ---------------------------------------------------------------------
    // Locale dictionaries (also read by Plugin Manager for display metadata)
    // ---------------------------------------------------------------------

    const DICT_ZH = {
      'meta.title': '未来指挥舱',
      'meta.description': '把 Harness 变成未来科技感的指挥台：输入框上方是战区（工作区）选择舱，运行中是实时执行面板与任务进度。',
      'deck.sectorTitle': '战区选择',
      'deck.sectorSub': 'SECTOR SELECT',
      'deck.liveTitle': '实时执行面板',
      'deck.liveSub': 'LIVE OPS',
      'deck.newSector': '开辟新战区',
      'deck.newSectorHint': '选择本地目录',
      'deck.loading': '正在扫描战区…',
      'deck.empty': '还没有战区，先开辟一个。',
      'deck.sessions': '{count} 个行动',
      'deck.sectorCount': '{count} 个战区',
      'deck.deploy': '停靠',
      'deck.enter': '部署',
      'deck.current': '当前',
      'deck.running': '执行中',
      'deck.idle': '待命',
      'deck.elapsed': '运行时长',
      'deck.plan': '任务进度',
      'deck.noPlan': '本轮暂无任务清单',
      'deck.workspace': '战区',
      'deck.session': '会话',
      'deck.complete': '{done}/{total} 已完成',
      'deck.activeTask': '{count} 项进行中',
      'deck.expand': '展开面板',
      'deck.collapse': '收起面板',
      'dock.title': '执行中',
      'dock.output': '执行输出',
      'dock.hide': '收起执行面板',
      'dock.restore': '显示执行中面板',
      'dock.standby': '待命中',
      'dock.now': '刚刚',
      'dock.minutes': '{count} 分钟前',
      'dock.hours': '{count} 小时前',
      'dock.days': '{count} 天前',
      'dock.agoNow': '刚刚',
      'dock.agoMinutes': '{count}分',
      'dock.agoHours': '{count}时',
      'dock.agoDays': '{count}天',
      'deck.home': '主战区',
      'deck.homeHint': '回到默认新会话界面',
      'dock.sub': 'LIVE RUNS',
      'dock.runningCount': '{count} 进行中',
      'dock.noOutput': '暂无输出',
      'dock.thinking': '思考过程',
      'dock.thinkingChars': '{count} 字',
      'sectorPanel.title': '战区会话',
      'sectorPanel.sub': 'SECTOR SESSIONS',
      'sectorPanel.count': '{count}',
      'sectorPanel.hint': '点击会话 → 切到主执行区',
      'dock.hint': '点击会话 → 进入该会话 · 结束后自动移除',
      'deck.docked': '已停靠 · 在右上角「会话坞」里点开',
      'deck.focusMode': '聚焦模式',
      'deck.fullUi': '完整界面',
      'deck.focusHint': '切换到聚焦模式：只显示内容区',
      'deck.fullUiHint': '切换到完整界面：显示侧栏与标题栏',
      'deck.pickFailed': '无法选择目录：{message}',
      'deck.createFailed': '无法建立战区：{message}',
      'deck.openFailed': '部署失败：{message}',
      // ---- 赛博工地：会话面板的第二种视图 ----
      'arena.viewContent': '内容',
      'arena.viewGame': '罗盘',
      'arena.viewHint': '会话面板视图',
      'arena.hintContent': '切到内容：查看这条会话的输出',
      'arena.hintGame': '切到罗盘：把工具调用变成指针方位',
      'arena.title': '赛博罗盘',
      'arena.live': '定向中',
      'arena.idle': '待命',
      'arena.laps': '圈',
      'arena.bearing': '方位',
      'arena.bearingHint': '索引指针当前指向的方位角',
      'arena.combo': '连击',
      'arena.waiting': '等待下一次工具调用…',
      'arena.noLog': '断流',
      'arena.noteSeal': '笔记',
      'arena.foundSeal': '发现',
      'arena.signalLost': '读不到这条会话的工具流水，画面按待命状态空转',
      'arena.canvasLabel': '赛博罗盘：工具调用会把盘面转到对应山向（读坎/子、改艮/艮、令震/卯、搜巽/巽、网离/午、计坤/坤、协兑/酉、搬乾/乾）；也可以用鼠标拖动盘面：松手会按拖动速度带惯性继续滑行，慢下来再吸附到最近的一山',
      'arena.kRead': '读',
      'arena.kBuild': '改',
      'arena.kSmash': '令',
      'arena.kScan': '搜',
      'arena.act.read': '扫描蓝图',
      'arena.act.build': '焊接楼板',
      'arena.act.smash': '抡锤拆建',
      'arena.act.scan': '雷达勘探',
      'arena.act.drone': '无人机侦察',
      'arena.act.flag': '立起施工牌',
      'arena.act.helper': '调度小工',
      'arena.act.haul': '搬运材料',
      'arena.act.bump': '被落物砸到',
      'arena.act.floor': '整圈扫过 · 新的一圈',
    }

    const DICT_EN = {
      'meta.title': 'Future command deck',
      'meta.description': 'Turns the Harness into a futuristic command console: a sector (workspace) selection deck above the composer and a live operations panel that tracks the running task.',
      'deck.sectorTitle': 'Sector select',
      'deck.sectorSub': 'SECTOR SELECT',
      'deck.liveTitle': 'Live ops',
      'deck.liveSub': 'LIVE OPS',
      'deck.newSector': 'Open a new sector',
      'deck.newSectorHint': 'Pick a local directory',
      'deck.loading': 'Scanning sectors…',
      'deck.empty': 'No sector yet. Open one to deploy.',
      'deck.sessions': '{count} ops',
      'deck.sectorCount': '{count} sectors',
      'deck.deploy': 'Dock',
      'deck.enter': 'Deploy',
      'deck.current': 'Current',
      'deck.running': 'Executing',
      'deck.idle': 'Standby',
      'deck.elapsed': 'Uptime',
      'deck.plan': 'Task progress',
      'deck.noPlan': 'No task list for this run',
      'deck.workspace': 'Sector',
      'deck.session': 'Session',
      'deck.complete': '{done}/{total} done',
      'deck.activeTask': '{count} in progress',
      'deck.expand': 'Expand panel',
      'deck.collapse': 'Collapse panel',
      'dock.title': 'Running',
      'dock.output': 'Output',
      'dock.hide': 'Hide the running panel',
      'dock.restore': 'Show the running panel',
      'dock.standby': 'Standby',
      'dock.now': 'just now',
      'dock.minutes': '{count}m ago',
      'dock.hours': '{count}h ago',
      'dock.days': '{count}d ago',
      'dock.agoNow': 'now',
      'dock.agoMinutes': '{count}m',
      'dock.agoHours': '{count}h',
      'dock.agoDays': '{count}d',
      'deck.home': 'Main sector',
      'deck.homeHint': 'Back to the default new-session view',
      'dock.sub': 'LIVE RUNS',
      'dock.runningCount': '{count} running',
      'dock.noOutput': 'No output yet',
      'dock.thinking': 'Thinking',
      'dock.thinkingChars': '{count} chars',
      'sectorPanel.title': 'Sector sessions',
      'sectorPanel.sub': 'SECTOR SESSIONS',
      'sectorPanel.count': '{count}',
      'sectorPanel.hint': 'Click a session to open it in the main area',
      'dock.hint': 'Click a session to open it · removed when it finishes',
      'deck.docked': 'Docked · open it from the session dock (top right)',
      'deck.focusMode': 'Focus',
      'deck.fullUi': 'Full UI',
      'deck.focusHint': 'Switch to focus mode: content column only',
      'deck.fullUiHint': 'Switch to the full shell: sidebars and header',
      'deck.pickFailed': 'Could not pick a directory: {message}',
      'deck.createFailed': 'Could not open that sector: {message}',
      'deck.openFailed': 'Deploy failed: {message}',
      // ---- Cyber site: the second panel view ----
      'arena.viewContent': 'Content',
      'arena.viewGame': 'Compass',
      'arena.viewHint': 'Panel view',
      'arena.hintContent': 'Switch to content: read this Session output',
      'arena.hintGame': 'Switch to the compass: tool calls swing the pointer',
      'arena.title': 'CYBER COMPASS',
      'arena.live': 'BEARING',
      'arena.idle': 'STANDBY',
      'arena.laps': 'LAP',
      'arena.bearing': 'BRG',
      'arena.bearingHint': 'Bearing the index pointer currently reads',
      'arena.combo': 'COMBO',
      'arena.waiting': 'Waiting for the next tool call…',
      'arena.noLog': 'NO LOG',
      'arena.noteSeal': 'NOTE',
      'arena.foundSeal': 'FOUND',
      'arena.signalLost': 'The tool stream of this Session is unreadable; the site keeps idling',
      'arena.canvasLabel': 'Cyber compass: tool calls turn the dial to their mountain (read Kan/Zi, write Gen, shell Zhen/Mao, search Xun, net Li/Wu, plan Kun, helper Dui/You, haul Qian); drag the dial with the mouse: releasing keeps it gliding with the flick speed, then it snaps to the nearest mountain',
      'arena.kRead': 'RD',
      'arena.kBuild': 'WR',
      'arena.kSmash': 'SH',
      'arena.kScan': 'SR',
      'arena.act.read': 'Scanning blueprints',
      'arena.act.build': 'Welding a floor plate',
      'arena.act.smash': 'Swinging the hammer',
      'arena.act.scan': 'Radar sweep',
      'arena.act.drone': 'Drone recon',
      'arena.act.flag': 'Planting the site sign',
      'arena.act.helper': 'Calling a helper bot',
      'arena.act.haul': 'Hauling materials',
      'arena.act.bump': 'Hit by a falling crate',
      'arena.act.floor': 'Full sweep · one more lap',
    }

    // ---------------------------------------------------------------------
    // Client plugin
    // ---------------------------------------------------------------------

    return {
      // Hard dependencies: slot registration, localized copy, and theme tokens.
      inject: ['slots', 'locale', 'theme'],
      apply(ctx) {
        // 0) 「笔记」话术池：先用本地底库+缓存立即能用，缓存过期时后台去一言补一批。
        ctx.effect(() => {
          void refreshNotesQuotes(false)
          return () => {}
        }, 'future-command-deck: notes quotes')

        // 1) Future-tech palette. `overrideTokens` stacks a layer over whichever
        //    base theme is active, so the user's light/dark preference survives.
        const theme = ctx.get('theme')
        if (theme !== undefined && typeof theme.overrideTokens === 'function') {
          ctx.effect(
            () => theme.overrideTokens(PACKAGE_ID, THEME_TOKENS),
            'future-command-deck: theme tokens',
          )
        }

        // 1b) Glass surfaces are a focus-mode-only layer. 完整界面（三栏、设置页、
        //     插件页、各种弹窗）不再套半透明表面：那些窗体本来就该是实心的，
        //     透出画布底色会让表单读不清。切换聚焦模式时由 applyFocusAttribute
        //     调 syncGlassTokens 挂上/摘掉这一层。
        if (theme !== undefined && typeof theme.overrideTokens === 'function') {
          ctx.effect(() => {
            let release = null
            const sync = (on) => {
              if (release !== null) {
                release()
                release = null
              }
              if (on === true) release = theme.overrideTokens(PACKAGE_ID + ':glass', GLASS_TOKENS)
            }
            syncGlassTokens = sync
            // 默认值是聚焦模式；主题实例可能比壳层就绪得晚，这里再对齐一次
            sync(readFocusPreference())
            return () => {
              if (syncGlassTokens === sync) syncGlassTokens = () => {}
              if (release !== null) {
                release()
                release = null
              }
            }
          }, 'future-command-deck: glass surfaces')
        }

        // 2) Stylesheet, removed when the plugin unloads.
        ctx.effect(() => installStyles(), 'future-command-deck: stylesheet')

        // 3) Shell mode: hide the left rail, right rail, and Session header
        //    chrome so a launch opens as just the content column. Disposing the
        //    effect removes the attribute, restoring the shipped shell exactly.
        ctx.effect(() => {
          applyFocusAttribute(readFocusPreference())
          return () => {
            applyFocusAttribute(false)
            // 卸载时把发射转场属性一起摘掉，避免界面停在淡出状态
            document.documentElement.removeAttribute(LAUNCH_ATTR)
          }
        }, 'future-command-deck: shell mode')

        // 3a) Session-log namespace for the 赛博工地 feed: captured inside an
        //     injected scope, because `remote.session` is refused outside one.
        //     The scope lives on this ctx, so unloading the plugin releases it.
        bindSessionLogNamespace(ctx)

        // 3b) Panel view (内容 / 工地): restored from the last choice and
        //     mirrored onto <html> for the stylesheet; unloading drops it back
        //     to the content view so the chat flow can never stay hidden.
        ctx.effect(() => {
          const initial = readViewPreference()
          viewModeStore.set(initial)
          applyViewAttribute(initial)
          return () => {
            applyViewAttribute(VIEW_CONTENT)
          }
        }, 'future-command-deck: panel view')

        // 4) Dictionaries for both `t()` in the slots and the Plugin Manager entry.
        const locale = ctx.get('locale')
        if (locale !== undefined && typeof locale.register === 'function') {
          ctx.effect(
            () => locale.register(NS, { zh: DICT_ZH, en: DICT_EN }),
            'future-command-deck: dictionaries',
          )
        }

        // 5) Session dock: grouped live overview of every Workspace's Sessions,
        //    pinned to the top-right corner. Clicking a row promotes that
        //    Session to the main view.
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'future-command-deck.dock',
              order: 880,
              locale: NS,
              inject: () => ({
                openSession: (sessionId) => openSessionInMain(ctx, sessionId),
              }),
            },
            SessionDock,
          ))

        // 6) Top-left sector panel: the Sessions of the Workspace the main view
        //    currently sits in; clicking one promotes it to the main area.
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'future-command-deck.sector-panel',
              order: 870,
              locale: NS,
              inject: () => ({
                openSession: (sessionId) => openSessionInMain(ctx, sessionId),
              }),
            },
            SectorSessionsPanel,
          ))

        // 7) Frame-wide HUD decoration (non-interactive, above the columns).
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'future-command-deck.hud', order: 900, locale: NS },
            HudOverlay,
          ))

        // 7b) 赛博工地：会话面板的「内容 / 工地」切换与游戏画面。
        //     只在聚焦模式 + 某个具体会话里出现（组件内部再判一次），
        //     数据走 Gateway Remote 的会话日志，轮询也只在画面可见时进行。
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'future-command-deck.arena',
              order: 890,
              locale: NS,
              inject: () => ({
                // 只读一页日志；quiet = 轮询失败不刷控制台。
                // 优先用注入作用域里捕获的命名空间（Cordis 只允许在那里访问
                // `remote.session`），退化时才走 ctx.get('remote')。
                readPage: async (sessionId, signal) => {
                  let namespace = sessionLogNamespaceRef.value
                  if (namespace === null) {
                    let remote
                    try {
                      remote = resolveRemote(ctx)
                    } catch {
                      remote = undefined
                    }
                    namespace = sessionLogNamespace(remote)
                  }
                  return readSessionRecordPage(namespace, sessionId, signal, true)
                },
              }),
            },
            ArenaOverlay,
          ))

        // 8) Hero emblem: replaces the blank-Session mark with a HUD targeting
        //    hexagon, so a fresh Session already reads as a command deck.
        ctx.slots.inject('conversation.hero.brand.mark', () =>
          ctx.slots.register({ name: 'conversation.hero.brand.mark' }, HeroMark))

        // 9) The command deck itself: full-width entry above the composer card.
        //    Order -10 keeps it above the shipped todo/goal docks in the same list.
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'future-command-deck.deck',
              order: -10,
              locale: NS,
              // Operations handed to the component; services are resolved lazily
              // so the entry still mounts in a profile without them.
              inject: () => ({
                openSector: (workspaceId) => openSector(ctx, workspaceId),
                openNewSector: () => openNewSector(ctx),
                openHome: () => openHomeSector(ctx),
              }),
            },
            CommandDeck,
          ))
      },
    }
  },
})
