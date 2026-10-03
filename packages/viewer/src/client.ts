export { readBootstrap, loadViewerModel, imageUrl, type ViewerBootstrap, type ViewerClock, type ViewerDependencies, type ViewerModel } from "./browser/model.ts";
export { mountViewer } from "./browser/dom.ts";
import { mountViewer } from "./browser/dom.ts";

declare const __PIXELWATCH_RELEASE__: string;
if (typeof document !== "undefined" && typeof __PIXELWATCH_RELEASE__ !== "undefined") void mountViewer(document, location.href, __PIXELWATCH_RELEASE__);
