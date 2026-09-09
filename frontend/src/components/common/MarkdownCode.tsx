import { isValidElement, type ComponentProps, type ReactNode } from 'react';
import CodeHighlighter from './CodeHighlighter';

/** 将 Markdown 围栏代码交给共享高亮器，行内代码保持原生渲染。 */
export default function MarkdownCode({ children }: { children?: ReactNode }) {
  if (!isValidElement<ComponentProps<'code'>>(children)) return <pre>{children}</pre>;
  const language = /language-([^\s]+)/.exec(children.props.className ?? '')?.[1];
  return <CodeHighlighter code={String(children.props.children ?? '').replace(/\n$/, '')} language={language} />;
}
