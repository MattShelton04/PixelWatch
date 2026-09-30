// The allowed pattern: untrusted text only ever becomes a text node.
export function safe(target: HTMLElement, text: string): void {
  const label = document.createElement("span");
  label.textContent = text;
  target.replaceChildren(label, document.createTextNode(text));
}
