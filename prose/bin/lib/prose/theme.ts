// Light, dark, or the system's setting, for the prose pages. Their styles
// switch with `@media (prefers-color-scheme: ...)` rules, including the ones
// in github-markdown.css, so forcing a mode rewrites each such rule's media
// text: the chosen scheme's rules always apply and the other's never do.
// System puts the original text back.
//
// The choice is a cookie. Browser storage is per origin, and each prose
// server has its own port, while a cookie for localhost covers every port,
// so the choice carries to the next review.

export type ThemeMode = "system" | "light" | "dark"

const COOKIE = "prose-theme"
const MODES: ThemeMode[] = ["system", "light", "dark"]
const LABELS: Record<ThemeMode, { icon: string; title: string }> = {
  system: { icon: "◐", title: "Theme: system (click for light)" },
  light: { icon: "☼", title: "Theme: light (click for dark)" },
  dark: { icon: "☾", title: "Theme: dark (click for system)" },
}

const systemDark = matchMedia("(prefers-color-scheme: dark)")
const originals = new WeakMap<CSSMediaRule, string>()

function saved(): ThemeMode {
  const value = document.cookie.match(/(?:^|;\s*)prose-theme=(\w+)/)?.[1]
  return MODES.includes(value as ThemeMode) ? value as ThemeMode : "system"
}

// A query that is always true, and one that is always false: a negative
// width is invalid, which makes its media query "not all"
const ALWAYS = "(min-width: 0px)"
const NEVER = "(max-width: -1px)"

function rewrite(rules: CSSRuleList, mode: ThemeMode) {
  for (const rule of rules) {
    if (rule instanceof CSSMediaRule) {
      const original = originals.get(rule) ?? rule.media.mediaText
      if (/prefers-color-scheme/.test(original)) {
        originals.set(rule, original)
        rule.media.mediaText = mode === "system" ? original : original.replace(
          /\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)/g,
          (_, scheme) => scheme === mode ? ALWAYS : NEVER,
        )
      }
    }
    if ("cssRules" in rule) rewrite((rule as CSSGroupingRule).cssRules, mode)
  }
}

export class Theme {
  mode = saved()
  #listeners: (() => void)[] = []
  #buttons: HTMLButtonElement[] = []

  constructor() {
    systemDark.addEventListener("change", () => {
      if (this.mode === "system") this.#emit()
    })
    this.#apply()
  }

  // whether the page shows dark now, for code that picks its own colors
  get dark() {
    return this.mode === "dark" || (this.mode === "system" && systemDark.matches)
  }

  onChange(listener: () => void) {
    this.#listeners.push(listener)
  }

  set(mode: ThemeMode) {
    this.mode = mode
    document.cookie = `${COOKIE}=${mode}; path=/; max-age=31536000; samesite=strict`
    this.#apply()
    this.#emit()
  }

  // A button that steps through system, light and dark
  button(id: string) {
    const b = document.createElement("button")
    b.type = "button"
    b.id = id
    b.addEventListener("click", () => this.set(MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]))
    this.#buttons.push(b)
    this.#label()
    return b
  }

  #apply() {
    for (const sheet of document.styleSheets) {
      try {
        rewrite(sheet.cssRules, this.mode)
      } catch {
        // a sheet from another origin can't be read; prose serves its own
      }
    }
    // conversation.css forces color-scheme from this, for light-dark() and
    // the trees in shadow roots
    if (this.mode === "system") delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = this.mode
    this.#label()
  }

  #label() {
    for (const b of this.#buttons) {
      b.textContent = LABELS[this.mode].icon
      b.title = LABELS[this.mode].title
      b.setAttribute("aria-label", LABELS[this.mode].title)
    }
  }

  #emit() {
    for (const listener of this.#listeners) listener()
  }
}
