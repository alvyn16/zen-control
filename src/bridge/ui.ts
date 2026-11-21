/**
 * In-chrome UI cards rendered into a single shadow root attached to a host in
 * the browser document. Page scripts cannot reach this tree. Every control has
 * an accessible label and keyboard support, and all card collections are
 * bounded so a long session cannot grow the DOM without limit.
 */
import type {
  ActivityTone,
  AnswerStatus,
  UiActivity,
  UiActivityAction,
  UiAnswer,
  UiBanner,
  UiConsent,
  UiProgress,
  UiQuestion,
  UiUpdateNotice,
} from "../shared/protocol.js";

export interface UiHandlers {
  onStop(progressId: string): void;
  onConsent(id: string, granted: boolean): void;
  onBannerAction(action: "pause" | "resume"): void;
  onUpdateAction(action: "install" | "dismiss" | "expand"): void;
}

/** Alias kept for code that refers to the combined callback set by its old name. */
export type ProgressHandlers = UiHandlers;

export interface QuestionHandlers {
  /** Return false to keep the card open when the connection is down. */
  send(answer: UiAnswer): boolean;
}

export interface ActivityHandlers {
  action(action: UiActivityAction): Promise<{ ok: boolean; error?: string }>;
}

interface ProgressView {
  id: string;
  card: HTMLElement;
  title: HTMLElement;
  step: HTMLElement;
  detail: HTMLElement;
  bar: HTMLElement;
  fill: HTMLElement;
  stop: HTMLButtonElement;
  stopping: boolean;
}

const FALLBACK_ACCENT = "#4ec3f7";
const MAX_QUESTIONS = 4;
const MAX_ACTIVITIES = 3;

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap {
  --bg: var(--arrowpanel-background, var(--panel-background, light-dark(#fcfcfd, #1b1a20)));
  --fg: var(--arrowpanel-color, var(--panel-color, light-dark(#15141a, #fbfbfe)));
  --accent: ${FALLBACK_ACCENT};
  --on-accent: #08131a;
  --border: color-mix(in srgb, var(--fg) 14%, transparent);
  --muted: color-mix(in srgb, var(--fg) 58%, transparent);
  --faint: color-mix(in srgb, var(--fg) 7%, transparent);
  --hover: color-mix(in srgb, var(--fg) 11%, transparent);
  --success: #1a7f37; --warning: #9a6700; --danger: #cf222e;
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
  display: flex; flex-direction: column; align-items: flex-end; gap: 10px;
  width: min(384px, calc(100vw - 28px)); pointer-events: none;
  color: var(--fg); color-scheme: light dark;
  font: 13px/1.45 "Segoe UI Variable Text", system-ui, -apple-system, sans-serif;
}
.wrap.dark { --success: #3fb950; --warning: #d29922; --danger: #ff7b72; }
.stack { display: flex; flex-direction: column; align-items: flex-end; gap: 10px; width: 100%; pointer-events: none; }
.banner {
  pointer-events: auto; display: flex; align-items: center; gap: 9px; width: 100%;
  padding: 8px 10px; border-radius: 12px; background: color-mix(in srgb, var(--bg) 94%, transparent);
  border: 1px solid var(--border); box-shadow: 0 10px 26px rgba(0,0,0,.16);
  backdrop-filter: blur(18px) saturate(140%);
}
.banner[hidden] { display: none; }
.banner[data-state="paused"] { border-color: color-mix(in srgb, var(--danger) 52%, transparent); }
.banner[data-state="pending"] { border-color: color-mix(in srgb, var(--warning) 48%, transparent); }
.dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--success); }
.banner[data-state="paused"] .dot { background: var(--danger); }
.banner[data-state="pending"] .dot { background: var(--warning); }
.text { flex: 1; min-width: 0; }
.title { margin: 0; font-size: 11.5px; font-weight: 650; overflow-wrap: anywhere; }
.detail { margin: 1px 0 0; font-size: 10.5px; color: var(--muted); overflow-wrap: anywhere; }
.detail[hidden] { display: none; }
button { font: inherit; cursor: pointer; }
button:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent) 65%, transparent); outline-offset: 2px; }
.btn { padding: 5px 9px; border-radius: 7px; border: 1px solid var(--border); background: var(--faint); color: var(--fg); font-size: 10.5px; font-weight: 650; }
.btn:hover { background: var(--hover); }
.card {
  pointer-events: auto; width: 100%; padding: 13px 14px 12px; border-radius: 16px;
  background: color-mix(in srgb, var(--bg) 96%, transparent);
  border: 1px solid var(--border); box-shadow: 0 18px 44px rgba(0,0,0,.22);
  backdrop-filter: blur(22px) saturate(150%); position: relative; overflow: hidden;
  animation: in 200ms cubic-bezier(.2,.9,.3,1); outline: none;
}
@keyframes in { from { opacity: 0; transform: translateY(10px) scale(.985); } to { opacity: 1; transform: none; } }
.head { display: flex; align-items: center; gap: 7px; min-height: 16px; margin-bottom: 8px; }
.brand { display: inline-flex; align-items: center; gap: 6px; font-size: 9px; font-weight: 650; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.brand .dot { background: var(--accent); }
.chip { margin-left: auto; font-size: 8.5px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--accent); background: color-mix(in srgb, var(--accent) 13%, transparent); padding: 2px 6px; border-radius: 999px; }
.h2 { margin: 0 0 6px; font-size: 14.5px; line-height: 1.35; font-weight: 650; overflow-wrap: anywhere; white-space: pre-wrap; }
.p { margin: 0 0 10px; font-size: 11.5px; line-height: 1.5; color: var(--muted); overflow-wrap: anywhere; white-space: pre-wrap; }
.p.context { margin-bottom: 5px; }
.actions { display: flex; align-items: center; gap: 8px; }
.primary { border: none; border-radius: 9px; padding: 7px 12px; background: var(--accent); color: var(--on-accent); font-size: 11.5px; font-weight: 650; }
.secondary { border: none; background: none; color: var(--muted); padding: 7px 6px; border-radius: 7px; font-size: 11.5px; }
.secondary:hover { color: var(--fg); background: var(--faint); }
.hint { margin: 9px 0 0; font-size: 10.5px; line-height: 1.4; color: var(--muted); }
.options { display: grid; gap: 6px; }
.option { display: flex; align-items: flex-start; gap: 9px; width: 100%; text-align: left; padding: 8px 9px; border-radius: 10px; border: 1px solid transparent; background: var(--faint); color: var(--fg); }
.option:hover { background: var(--hover); border-color: color-mix(in srgb, var(--accent) 30%, transparent); }
.option.selected { border-color: color-mix(in srgb, var(--accent) 55%, transparent); background: color-mix(in srgb, var(--accent) 11%, transparent); }
.option.sent { border-color: color-mix(in srgb, var(--accent) 70%, transparent); background: color-mix(in srgb, var(--accent) 18%, transparent); }
.key { flex: none; width: 17px; height: 17px; display: grid; place-items: center; border-radius: 5px; background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); font-size: 9.5px; font-weight: 700; }
.opt-label { display: block; font-size: 12.5px; font-weight: 550; overflow-wrap: anywhere; }
.opt-desc { display: block; margin-top: 2px; font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
.freeform { display: flex; gap: 6px; margin-top: 8px; }
.freeform input { flex: 1; min-width: 0; background: var(--faint); border: 1px solid var(--border); color: var(--fg); border-radius: 9px; padding: 8px 10px; font: inherit; font-size: 12px; }
.freeform input:focus { outline: none; border-color: color-mix(in srgb, var(--accent) 55%, transparent); }
.send { border: none; border-radius: 9px; padding: 0 11px; background: var(--accent); color: var(--on-accent); font-size: 11.5px; font-weight: 650; }
.send[disabled] { opacity: .45; cursor: default; }
.foot { display: flex; align-items: center; gap: 8px; margin-top: 9px; }
.foot .hint { flex: 1; margin: 0; }
.error { display: none; margin: 7px 0 0; font-size: 10.5px; color: var(--danger); }
.error.on { display: block; }
.stop { padding: 5px 10px; border-radius: 7px; border: 1px solid color-mix(in srgb, var(--danger) 38%, transparent); background: color-mix(in srgb, var(--danger) 11%, transparent); color: var(--danger); font-size: 11px; font-weight: 600; white-space: nowrap; }
.stop[disabled] { opacity: .65; cursor: default; }
.progress-row { display: flex; align-items: flex-start; gap: 10px; }
.progress-body { flex: 1; min-width: 0; }
.progress-title { margin: 0; font-size: 12.5px; font-weight: 600; overflow-wrap: anywhere; }
.bar { margin-top: 9px; height: 4px; border-radius: 999px; background: var(--faint); overflow: hidden; }
.bar[hidden] { display: none; }
.bar > div { height: 100%; width: 0%; background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 55%, transparent), var(--accent)); transition: width .3s ease; }
.activity-row { display: flex; align-items: flex-start; gap: 8px; }
.tone { flex: none; width: 7px; height: 7px; margin-top: 4px; border-radius: 50%; background: var(--accent); }
.card[data-tone="success"] .tone { background: var(--success); }
.card[data-tone="warning"] .tone { background: var(--warning); }
.close { margin-left: auto; border: none; background: none; color: var(--muted); font-size: 13px; width: 20px; height: 20px; border-radius: 5px; }
.action { display: inline-flex; align-items: center; margin-top: 8px; padding: 5px 9px; border-radius: 7px; border: 1px solid color-mix(in srgb, var(--accent) 32%, transparent); background: color-mix(in srgb, var(--accent) 11%, transparent); color: var(--accent); font-size: 11px; font-weight: 600; }
.action[disabled] { opacity: .6; }
.action-error { margin: 6px 0 0; font-size: 10.5px; color: var(--danger); }
.elapsed { position: absolute; left: 0; bottom: 0; height: 2px; width: 100%; transform-origin: left center; background: color-mix(in srgb, var(--accent) 55%, transparent); animation: drain var(--duration, 9000ms) linear forwards; }
@keyframes drain { from { transform: scaleX(1); } to { transform: scaleX(0); } }
@media (prefers-reduced-motion: reduce) { .card { animation: none; } .elapsed { display: none; } }
`;

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function tone(value: ActivityTone | undefined): ActivityTone {
  return value === "success" || value === "warning" ? value : "info";
}

function setOptional(node: HTMLElement, value: string | undefined): void {
  const text = value?.trim() ?? "";
  node.textContent = text;
  node.hidden = !text;
}

export class ZenMcpUi {
  readonly #doc: Document;
  readonly #handlers: UiHandlers;
  readonly #host: HTMLElement;
  readonly #root: ShadowRoot;
  readonly #wrap: HTMLElement;
  readonly #banner: HTMLElement;
  readonly #bannerTitle: HTMLElement;
  readonly #bannerDetail: HTMLElement;
  readonly #bannerButton: HTMLButtonElement;
  readonly #bannerUpdate: HTMLElement;
  readonly #updateIcon: HTMLButtonElement;
  readonly #updatePrompt: HTMLElement;
  readonly #updateLabel: HTMLElement;
  readonly #updateApply: HTMLButtonElement;
  readonly #updateDismiss: HTMLButtonElement;
  readonly #consentStack: HTMLElement;
  readonly #questionsStack: HTMLElement;
  readonly #progressStack: HTMLElement;
  readonly #activitiesStack: HTMLElement;
  readonly #questions = new Map<string, { card: HTMLElement; dismiss(): void }>();
  readonly #activities = new Map<string, { card: HTMLElement; dismiss(): void }>();
  #consent: { id: string; card: HTMLElement } | null = null;
  #progress: ProgressView | null = null;
  #bannerState: UiBanner["state"] = "active";

  constructor(doc: Document, handlers: UiHandlers) {
    this.#doc = doc;
    this.#handlers = handlers;

    this.#host = el(doc, "div", "zf-chrome-ui");
    this.#host.style.cssText =
      "position:fixed;right:0;bottom:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
    this.#root = this.#host.attachShadow({ mode: "open" });

    const style = el(doc, "style");
    style.textContent = STYLE;
    this.#wrap = el(doc, "div", "wrap");

    this.#banner = el(doc, "div", "banner");
    this.#banner.setAttribute("role", "status");
    this.#banner.setAttribute("aria-live", "polite");
    this.#banner.hidden = true;
    this.#banner.dataset.state = "active";
    this.#bannerTitle = el(doc, "p", "title");
    this.#bannerDetail = el(doc, "p", "detail");
    this.#bannerDetail.hidden = true;
    const bannerText = el(doc, "div", "text");
    bannerText.append(this.#bannerTitle, this.#bannerDetail);
    this.#bannerButton = el(doc, "button", "btn", "Pause");
    this.#bannerButton.type = "button";
    this.#bannerButton.addEventListener("click", () => {
      this.#handlers.onBannerAction(this.#bannerState === "paused" ? "resume" : "pause");
    });

    this.#bannerUpdate = el(doc, "span");
    this.#bannerUpdate.hidden = true;
    this.#updateIcon = el(doc, "button", "btn", "↑");
    this.#updateIcon.type = "button";
    this.#updateIcon.title = "Update available";
    this.#updateIcon.setAttribute("aria-label", "Update available");
    this.#updateIcon.addEventListener("click", () => this.#handlers.onUpdateAction("expand"));
    this.#updatePrompt = el(doc, "span");
    this.#updatePrompt.setAttribute("role", "group");
    this.#updatePrompt.setAttribute("aria-label", "Update available");
    this.#updateLabel = el(doc, "span");
    this.#updateApply = el(doc, "button", "btn", "Update");
    this.#updateApply.type = "button";
    this.#updateApply.setAttribute("aria-label", "Install the update");
    this.#updateApply.addEventListener("click", () => this.#handlers.onUpdateAction("install"));
    this.#updateDismiss = el(doc, "button", "btn", "×");
    this.#updateDismiss.type = "button";
    this.#updateDismiss.title = "Dismiss";
    this.#updateDismiss.setAttribute("aria-label", "Dismiss update notice");
    this.#updateDismiss.addEventListener("click", () => this.#handlers.onUpdateAction("dismiss"));
    this.#updatePrompt.append(this.#updateLabel, this.#updateApply, this.#updateDismiss);
    this.#bannerUpdate.append(this.#updateIcon, this.#updatePrompt);
    this.#banner.append(el(doc, "span", "dot"), bannerText, this.#bannerUpdate, this.#bannerButton);

    this.#consentStack = el(doc, "div", "stack");
    this.#questionsStack = el(doc, "div", "stack");
    this.#progressStack = el(doc, "div", "stack");
    this.#activitiesStack = el(doc, "div", "stack");
    this.#wrap.append(
      this.#banner, this.#consentStack, this.#questionsStack,
      this.#progressStack, this.#activitiesStack
    );
    this.#root.append(style, this.#wrap);
    doc.documentElement.appendChild(this.#host);
    this.refreshTheme();
  }

  refreshTheme(): void {
    const media = this.#doc.defaultView?.matchMedia?.("(prefers-color-scheme: dark)");
    this.#wrap.classList.toggle("dark", !!media?.matches);
    try {
      const probe = el(this.#doc, "span");
      probe.style.cssText =
        "position:absolute;opacity:0;pointer-events:none;color:var(--zen-primary-color, " +
        FALLBACK_ACCENT + ");";
      this.#wrap.appendChild(probe);
      const accent = getComputedStyle(probe).color || FALLBACK_ACCENT;
      probe.remove();
      if (accent && accent !== "rgba(0, 0, 0, 0)") {
        this.#wrap.style.setProperty("--accent", accent);
        this.#wrap.style.setProperty("--on-accent", luminance(accent) > 0.5 ? "#08131a" : "#ffffff");
      }
    } catch {
      // Theme probing is cosmetic.
    }
  }

  showBanner(banner: UiBanner | null): void {
    if (!banner) {
      this.#banner.hidden = true;
      return;
    }
    this.refreshTheme();
    this.#bannerState = banner.state;
    this.#banner.dataset.state = banner.state;
    this.#banner.hidden = false;
    this.#bannerTitle.textContent = banner.text;
    setOptional(this.#bannerDetail, banner.detail);
    this.#renderUpdate(banner.update);
    const paused = banner.state === "paused";
    this.#bannerButton.hidden = banner.state === "pending";
    this.#bannerButton.textContent = paused ? "Resume" : "Pause";
    this.#bannerButton.setAttribute("aria-label", paused ? "Resume agent access" : "Pause agent access");
  }

  #renderUpdate(notice: UiUpdateNotice | null | undefined): void {
    const active = !!notice && this.#bannerState === "active";
    this.#bannerUpdate.hidden = !active;
    if (!notice || !active) return;
    const version = `v${notice.latestVersion}`;
    this.#updateIcon.hidden = notice.state !== "icon";
    this.#updateIcon.title = `Update ${version} available`;
    this.#updatePrompt.hidden = notice.state === "icon";
    if (notice.state === "icon") return;
    this.#updateApply.hidden = false;
    this.#updateApply.textContent = "Update";
    this.#updateDismiss.hidden = false;
    if (notice.state === "installing") {
      this.#updateLabel.textContent = `Updating to ${version}…`;
      this.#updateApply.hidden = true;
      this.#updateDismiss.hidden = true;
    } else if (notice.state === "installed") {
      this.#updateLabel.textContent = "Updated. Restart client.";
      this.#updateApply.hidden = true;
    } else if (notice.state === "failed") {
      this.#updateLabel.textContent = "Update failed";
      this.#updateLabel.title = notice.message ?? "Run the updater from a terminal.";
      this.#updateApply.textContent = "Retry";
    } else {
      this.#updateLabel.textContent = version;
      this.#updateLabel.title = `Installed version ${notice.currentVersion}`;
    }
  }

  showConsent(consent: UiConsent): void {
    this.refreshTheme();
    this.cancelConsent();
    const doc = this.#doc;
    const card = el(doc, "article", "card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", consent.title);
    const head = el(doc, "div", "head");
    head.append(el(doc, "span", "brand", "ZEN MCP"), el(doc, "span", "chip", "Permission"));
    card.append(head, el(doc, "h2", "h2", consent.title), el(doc, "p", "p", consent.detail));
    const actions = el(doc, "div", "actions");
    const allow = el(doc, "button", "primary", consent.allowLabel);
    allow.type = "button";
    const deny = el(doc, "button", "secondary", consent.denyLabel);
    deny.type = "button";
    actions.append(allow, deny);
    card.append(actions, el(doc, "p", "hint", "Only this session gets access. No page is read before approval."));
    const finish = (granted: boolean): void => {
      this.#handlers.onConsent(consent.id, granted);
      this.cancelConsent(consent.id);
    };
    allow.addEventListener("click", () => finish(true));
    deny.addEventListener("click", () => finish(false));
    this.#consentStack.appendChild(card);
    this.#consent = { id: consent.id, card };
  }

  cancelConsent(id?: string): void {
    if (!this.#consent) return;
    if (id && this.#consent.id !== id) return;
    this.#consent.card.remove();
    this.#consent = null;
  }

  showQuestion(question: UiQuestion, opts: QuestionHandlers): void {
    this.refreshTheme();
    this.cancelQuestion(question.id);
    while (this.#questions.size >= MAX_QUESTIONS) {
      const oldest = this.#questions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#questions.get(oldest)?.dismiss();
    }
    const doc = this.#doc;
    const card = el(doc, "article", "card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", question.question);
    card.tabIndex = 0;
    const head = el(doc, "div", "head");
    head.append(
      el(doc, "span", "brand", "ZEN MCP"),
      el(doc, "span", "chip", question.multiSelect ? "Choose any" : "Question")
    );
    card.appendChild(head);
    if (question.context?.trim()) card.appendChild(el(doc, "p", "p context", question.context.trim()));
    card.appendChild(el(doc, "h2", "h2", question.question));
    const error = el(doc, "p", "error");
    card.appendChild(error);
    const selected = new Set<number>();
    const optionButtons: HTMLButtonElement[] = [];
    const optionsEl = el(doc, "div", "options");

    let input: HTMLInputElement | null = null;
    let footerSend: HTMLButtonElement | null = null;
    const updateSend = (): void => {
      if (!footerSend) return;
      const ready = selected.size > 0 || !!input?.value.trim();
      footerSend.disabled = !ready;
      footerSend.textContent = selected.size ? `Send ${selected.size}` : "Send";
    };
    const finish = (status: AnswerStatus, answer?: string, selectedLabels?: string[], freeform?: boolean, highlight?: HTMLElement): void => {
      const message: UiAnswer = {
        type: "ui.answer",
        id: question.id,
        status,
        ...(answer !== undefined ? { answer } : {}),
        ...(selectedLabels?.length ? { selectedLabels } : {}),
        ...(freeform !== undefined ? { freeform } : {}),
      };
      if (highlight) highlight.classList.add("sent");
      if (!opts.send(message)) {
        highlight?.classList.remove("sent");
        error.textContent = "The agent is reconnecting. Try again in a moment.";
        error.classList.add("on");
        return;
      }
      this.#dismissQuestion(question.id);
    };
    const freeformAnswer = (): void => {
      const typed = input?.value.trim() ?? "";
      const labels = [...selected].sort((a, b) => a - b).map((i) => question.options[i]?.label ?? "").filter(Boolean);
      if (!labels.length && !typed) return;
      input?.blur();
      finish("answered", [...labels, ...(typed ? [typed] : [])].join(", "), labels, !!typed);
    };

    question.options.forEach((option, index) => {
      const button = el(doc, "button", "option");
      button.type = "button";
      button.title = `Press ${index + 1} when this card is focused`;
      const text = el(doc, "span");
      text.append(el(doc, "span", "opt-label", option.label));
      if (option.description) text.append(el(doc, "span", "opt-desc", option.description));
      button.append(el(doc, "span", "key", String(index + 1)), text);
      button.addEventListener("click", () => {
        if (question.multiSelect) {
          if (selected.has(index)) {
            selected.delete(index);
            button.classList.remove("selected");
          } else {
            selected.add(index);
            button.classList.add("selected");
          }
          updateSend();
          return;
        }
        optionButtons.forEach((other) => {
          other.disabled = other !== button;
        });
        finish("answered", option.value?.trim() || option.label, [option.label], false, button);
      });
      optionButtons.push(button);
      optionsEl.appendChild(button);
    });
    if (question.options.length) card.appendChild(optionsEl);

    if (question.allowFreeform) {
      const form = el(doc, "form", "freeform");
      const field = el(doc, "input");
      field.type = "text";
      field.placeholder = question.options.length ? "Or type your own answer" : "Type your answer";
      field.setAttribute("aria-label", "Your answer");
      const send = el(doc, "button", "send", "Send");
      send.type = "submit";
      send.disabled = true;
      form.append(field, send);
      input = field;
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        freeformAnswer();
      });
      field.addEventListener("input", () => {
        send.disabled = !field.value.trim();
        updateSend();
        error.classList.remove("on");
      });
      card.appendChild(form);
    }

    const foot = el(doc, "div", "foot");
    foot.append(el(doc, "p", "hint", question.multiSelect ? "Your answer goes to the agent." : "Click an option, or ask for later."));
    if (question.multiSelect) {
      footerSend = el(doc, "button", "send", "Send");
      footerSend.type = "button";
      footerSend.disabled = true;
      footerSend.addEventListener("click", freeformAnswer);
      foot.appendChild(footerSend);
    }
    const later = el(doc, "button", "secondary", "Ask me later");
    later.type = "button";
    later.addEventListener("click", () => finish("deferred"));
    foot.appendChild(later);
    card.appendChild(foot);

    card.addEventListener("keydown", (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      if (event.key === "Escape") {
        card.blur();
      } else if (/^[1-9]$/.test(event.key)) {
        const index = Number(event.key) - 1;
        if (index < question.options.length) {
          event.preventDefault();
          optionButtons[index]?.click();
        }
      } else if (event.key === "Enter" && footerSend && !footerSend.disabled) {
        event.preventDefault();
        footerSend.click();
      }
    });

    this.#questionsStack.appendChild(card);
    this.#questions.set(question.id, { card, dismiss: () => this.#dismissQuestion(question.id) });
  }

  cancelQuestion(id: string): void {
    this.#dismissQuestion(id);
  }

  #dismissQuestion(id: string): void {
    const stored = this.#questions.get(id);
    if (!stored) return;
    this.#questions.delete(id);
    stored.card.remove();
  }

  showProgress(progress: UiProgress | null): void {
    if (!progress) {
      if (this.#progress) {
        this.#progress.card.remove();
        this.#progress = null;
      }
      return;
    }
    this.refreshTheme();
    if (this.#progress && this.#progress.id === progress.id) {
      this.#updateProgress(this.#progress, progress);
      return;
    }
    if (this.#progress) this.#progress.card.remove();
    const doc = this.#doc;
    const card = el(doc, "article", "card");
    card.dataset.tone = tone(progress.tone);
    const head = el(doc, "div", "head");
    head.append(el(doc, "span", "brand", "ZEN MCP"), el(doc, "span", "chip", "Working"));
    const body = el(doc, "div", "progress-body");
    const title = el(doc, "p", "progress-title");
    const step = el(doc, "p", "p", "");
    step.hidden = true;
    const detail = el(doc, "p", "p", "");
    detail.hidden = true;
    const bar = el(doc, "div", "bar");
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.hidden = true;
    const fill = el(doc, "div");
    bar.appendChild(fill);
    body.append(title, step, detail, bar);
    const stop = el(doc, "button", "stop", "Stop");
    stop.type = "button";
    stop.addEventListener("click", () => {
      if (view.stopping || view.stop.disabled) return;
      view.stopping = true;
      view.stop.disabled = true;
      view.stop.textContent = "Stopping…";
      this.#handlers.onStop(view.id);
    });
    const row = el(doc, "div", "progress-row");
    row.append(body, stop);
    card.append(head, row);
    const view = { id: progress.id, card, title, step, detail, bar, fill, stop, stopping: false };
    this.#progress = view;
    this.#progressStack.appendChild(card);
    this.#updateProgress(view, progress);
  }

  #updateProgress(view: ProgressView, progress: UiProgress): void {
    view.card.dataset.tone = tone(progress.tone);
    view.title.textContent = progress.title;
    setOptional(view.step, progress.step);
    setOptional(view.detail, progress.detail);
    const ratio =
      typeof progress.progress === "number" && Number.isFinite(progress.progress)
        ? Math.min(1, Math.max(0, progress.progress))
        : null;
    if (ratio === null) {
      view.bar.hidden = true;
      view.fill.style.width = "0%";
    } else {
      const percent = Math.round(ratio * 100);
      view.bar.hidden = false;
      view.bar.setAttribute("aria-valuenow", String(percent));
      view.fill.style.width = `${percent}%`;
    }
    if (progress.stopRequested) view.stopping = true;
    view.stop.hidden = !progress.stoppable;
    view.stop.disabled = view.stopping;
    view.stop.textContent = view.stopping ? "Stopping…" : "Stop";
  }

  showActivity(activity: UiActivity, opts: ActivityHandlers): void {
    this.refreshTheme();
    const existing = this.#activities.get(activity.id);
    if (existing) existing.dismiss();
    while (this.#activities.size >= MAX_ACTIVITIES) {
      const oldest = this.#activities.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#activities.get(oldest)?.dismiss();
    }
    const doc = this.#doc;
    const card = el(doc, "article", "card");
    card.dataset.tone = tone(activity.tone);
    const head = el(doc, "div", "head");
    head.append(el(doc, "span", "brand", "ZEN MCP"));
    const close = el(doc, "button", "close", "×");
    close.type = "button";
    close.title = "Dismiss";
    close.setAttribute("aria-label", "Dismiss");
    head.appendChild(close);
    const row = el(doc, "div", "activity-row");
    const text = el(doc, "div");
    text.append(el(doc, "p", "h2", activity.title));
    if (activity.detail?.trim()) text.append(el(doc, "p", "p", activity.detail.trim()));
    row.append(el(doc, "span", "tone"), text);
    card.append(head, row);

    let done = false;
    let remaining = Math.max(0, Number(activity.autoHideMs ?? 9_000));
    let timer: ReturnType<typeof setTimeout> | null = null;
    const dismiss = (): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      this.#activities.delete(activity.id);
      card.remove();
    };
    const schedule = (): void => {
      if (remaining <= 0 || done) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(dismiss, remaining);
    };
    close.addEventListener("click", dismiss);
    card.addEventListener("mouseenter", () => {
      if (timer) clearTimeout(timer);
    });
    card.addEventListener("mouseleave", schedule);

    const action = activity.actions[0];
    if (action) {
      const button = el(doc, "button", "action", `${action.label} →`);
      button.type = "button";
      button.addEventListener("click", async () => {
        if (button.disabled) return;
        button.disabled = true;
        button.textContent = "Working…";
        if (timer) clearTimeout(timer);
        try {
          const result = await opts.action(action);
          if (result.ok) {
            button.textContent = "Done";
            setTimeout(dismiss, 900);
          } else {
            button.disabled = false;
            button.textContent = `${action.label} →`;
            const error = el(doc, "p", "action-error", result.error || "That action could not be completed.");
            card.appendChild(error);
            remaining = Math.min(Math.max(remaining, 0) + 3_000, 15_000);
            schedule();
          }
        } catch (error) {
          button.disabled = false;
          button.textContent = `${action.label} →`;
          card.appendChild(el(doc, "p", "action-error", String((error as Error)?.message ?? error)));
        }
      });
      card.appendChild(button);
    }
    if (remaining > 0) {
      const elapsed = el(doc, "div", "elapsed");
      elapsed.style.setProperty("--duration", `${remaining}ms`);
      card.appendChild(elapsed);
    }
    this.#activitiesStack.appendChild(card);
    this.#activities.set(activity.id, { card, dismiss });
    schedule();
  }

  destroy(): void {
    this.cancelConsent();
    for (const question of this.#questions.values()) question.card.remove();
    this.#questions.clear();
    if (this.#progress) this.#progress.card.remove();
    this.#progress = null;
    for (const activity of this.#activities.values()) activity.dismiss();
    this.#activities.clear();
    this.#host.remove();
  }
}

function luminance(color: string): number {
  const match = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (!match) return 0;
  const [r, g, b] = match.slice(1, 4).map((value) => {
    const channel = Number(value) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
