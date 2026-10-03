import type { ChangeResult, Changes, Side } from "@pixelwatch/schemas";
import { browserDependencies, imageUrl, loadViewerModel, readBootstrap, type ViewerBootstrap, type ViewerDependencies } from "./model.ts";

function text(value: string): string {
  // eslint-disable-next-line no-control-regex -- prevent capture text from controlling visual order
  return value.toWellFormed().replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, "").replaceAll("@", "＠");
}
function node<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K, value?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag); if (value !== undefined) element.textContent = text(value); return element;
}
function clear(root: HTMLElement): void { for (const image of root.querySelectorAll("img")) image.removeAttribute("src"); root.replaceChildren(); }
function sideState(side: Side): string {
  switch (side.state) { case "captured": return "Image expired or unavailable"; case "failed": return `Capture failed: ${side.category}`; case "missing": return `Capture missing: ${side.cause}`; case "absent": return `Absent: ${side.reason}`; case "none": return "No baseline revision"; }
}
function figure(document: Document, bootstrap: ViewerBootstrap, result: ChangeResult, revision: "base" | "head"): HTMLElement {
  const title = revision === "base" ? "Before" : "After"; const element = node(document, "figure"); element.setAttribute("aria-label", title);
  element.append(node(document, "figcaption", title)); const state = result[revision];
  const source = state.state === "captured" ? imageUrl(bootstrap, state, result.images?.[revision]) : undefined;
  if (source === undefined) element.append(node(document, "p", sideState(state)));
  else {
    const image = node(document, "img"); image.alt = `${title}: ${text(result.labels?.title ?? `${result.providerId}/${result.viewId}/${result.variantId}`)}`;
    image.loading = "eager"; image.decoding = "async"; image.width = state.state === "captured" ? state.width : 0; image.height = state.state === "captured" ? state.height : 0;
    image.addEventListener("error", () => { image.removeAttribute("src"); image.replaceWith(node(document, "p", "Image expired or unavailable")); }, { once: true });
    image.src = source; element.append(image);
  }
  return element;
}

function run(document: Document, root: HTMLElement, bootstrap: ViewerBootstrap, changes: Changes): void {
  if (changes.results.length === 0) { clear(root); root.append(node(document, "p", "No declared visual results. Review the coverage and capture failures above.")); return; }
  let selected = Math.max(0, changes.results.findIndex((result) => result.base.state === "captured" && result.head.state === "captured"));
  let page = Math.floor(selected / 100);
  const render = () => {
    clear(root); const label = node(document, "label", "Visual result"); label.htmlFor = "pw-result";
    const select = node(document, "select"); select.id = "pw-result";
    for (let index = page * 100; index < Math.min(changes.results.length, (page + 1) * 100); index++) {
      const result = changes.results[index]; if (result === undefined) continue;
      const option = node(document, "option", `${result.providerId}/${result.viewId}/${result.variantId} · ${result.status}${result.labels?.title === undefined ? "" : ` · ${result.labels.title}`}`); option.value = String(index); option.selected = selected === index; select.append(option);
    }
    select.addEventListener("change", () => { const index = Number(select.value); if (Number.isSafeInteger(index) && index >= page * 100 && index < Math.min(changes.results.length, (page + 1) * 100)) { selected = index; render(); document.getElementById("pw-result")?.focus(); } });
    const controls = node(document, "div"); controls.className = "pw-controls"; controls.append(label, select);
    const previous = node(document, "button", "Previous results"); previous.type = "button"; previous.disabled = page === 0;
    const next = node(document, "button", "Next results"); next.type = "button"; next.disabled = (page + 1) * 100 >= changes.results.length;
    previous.addEventListener("click", () => { if (page > 0) { page--; selected = page * 100; render(); document.getElementById("pw-result")?.focus(); } });
    next.addEventListener("click", () => { if ((page + 1) * 100 < changes.results.length) { page++; selected = page * 100; render(); document.getElementById("pw-result")?.focus(); } });
    controls.append(previous, next, node(document, "p", `Showing ${String(page * 100 + 1)}–${String(Math.min((page + 1) * 100, changes.results.length))} of ${String(changes.results.length)} results.`));
    const result = changes.results[selected]; if (result === undefined) return;
    const title = node(document, "h2", result.labels?.title ?? `${result.providerId}/${result.viewId}/${result.variantId}`);
    const state = node(document, "p", `Result: ${result.status}${result.reasons.length === 0 ? "" : ` · ${result.reasons.join(", ")}`}`);
    const pair = node(document, "div"); pair.className = "pw-pair"; pair.append(figure(document, bootstrap, result, "base"), figure(document, bootstrap, result, "head"));
    root.append(controls, title, state, pair);
  };
  render();
}

export async function mountViewer(document: Document, observedHref: string, compiledRelease: string, dependencies: ViewerDependencies = browserDependencies): Promise<void> {
  const root = document.getElementById("pixelwatch"); if (root === null) return;
  try {
    const bootstrap = readBootstrap(root.dataset, observedHref, compiledRelease);
    const model = await loadViewerModel(bootstrap, dependencies);
    if (model.changes === undefined) { clear(root); root.append(node(document, "p", "PixelWatch is ready. Open a run report from its PR comment or source report link.")); }
    else run(document, root, bootstrap, model.changes);
  } catch {
    clear(root); const message = node(document, "p", "Unable to load this report. It may be expired or incompatible. Use Reload report or PixelWatch home below."); message.setAttribute("role", "alert"); root.append(message);
  }
}
