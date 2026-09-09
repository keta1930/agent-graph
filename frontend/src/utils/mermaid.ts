interface MermaidRenderer {
  initialize: (config: { startOnLoad: boolean; theme: string; securityLevel: string; fontFamily: string }) => void;
  render: (id: string, content: string) => Promise<{ svg: string; bindFunctions?: (container: Element) => void }>;
}
declare global {
  interface Window { mermaid?: MermaidRenderer; }
}
let pending: Promise<MermaidRenderer> | undefined;

/** 共享 CDN 加载过程，失败后允许后续预览重试。 */
export function loadMermaid(): Promise<MermaidRenderer> {
  if (pending) return pending;
  pending = new Promise<MermaidRenderer>((resolve, reject) => {
    if (window.mermaid) { resolve(window.mermaid); return; }
    const script = document.createElement('script');
    script.id = 'mermaid-cdn-script';
    script.src = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';
    script.async = true;
    script.onload = () => {
      script.onload = null;
      script.onerror = null;
      if (window.mermaid) resolve(window.mermaid);
      else { script.remove(); reject(new Error('Mermaid did not initialize')); }
    };
    script.onerror = () => {
      script.remove();
      reject(new Error('Mermaid resource failed to load'));
    };
    document.head.appendChild(script);
  }).then(mermaid => {
    mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose', fontFamily: 'Segoe UI, Arial, sans-serif' });
    return mermaid;
  }).catch(error => { pending = undefined; throw error; });
  return pending;
}
