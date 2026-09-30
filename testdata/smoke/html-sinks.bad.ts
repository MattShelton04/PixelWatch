// Every line marked `expect-sink` must produce exactly one banned-sink lint error.
export function unsafe(target: HTMLElement, frame: HTMLIFrameElement, text: string): void {
  target.innerHTML = text; // expect-sink
  target.outerHTML = text; // expect-sink
  target["innerHTML"] = text; // expect-sink
  target.insertAdjacentHTML("beforeend", text); // expect-sink
  document.write(text); // expect-sink
  document.writeln(text); // expect-sink
  document.createRange().createContextualFragment(text); // expect-sink
  target.setHTMLUnsafe(text); // expect-sink
  Document.parseHTMLUnsafe(text); // expect-sink
  frame.srcdoc = text; // expect-sink
  const { outerHTML } = target; // expect-sink
  console.log(outerHTML);
  eval(text); // expect-sink
  new Function(text); // expect-sink
}
