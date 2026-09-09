import { createContext, memo, useContext, useMemo, type ComponentProps } from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import GlassCodeBlock from './GlassCodeBlock';

interface MarkdownContextValue {
  content: string;
  isStreaming: boolean;
  conversationId?: string;
}

const MarkdownContext = createContext<MarkdownContextValue>({ content: '', isStreaming: false });
const remarkPlugins = [remarkGfm];

/** 从 Markdown 已识别的块范围判断围栏是否仍在接收内容。 */
function isOpenFence(source: string, quoteDepth: number) {
  const lines = source.trimEnd().split('\n');
  const opening = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0]);
  if (!opening) return false;
  const marker = opening[1];
  const quotePrefix = new RegExp(`^(?:[ \\t]*>[ \\t]?){${quoteDepth}}`);
  const lastLine = lines[lines.length - 1].replace(quotePrefix, '').trim();
  return lines.length === 1 || lastLine.length < marker.length || !lastLine.split('').every(character => character === marker[0]);
}

/** 使用 pre 节点区分围栏和行内代码，保持代码块组件身份稳定。 */
function MarkdownCodeBlock({ node, children }: ComponentProps<'pre'> & ExtraProps) {
  const { content, isStreaming, conversationId } = useContext(MarkdownContext);
  const codeNode = node?.children.find(child => child.type === 'element' && child.tagName === 'code');
  if (codeNode?.type !== 'element') return <pre>{children}</pre>;
  const classes = codeNode.properties.className;
  const languageClass = Array.isArray(classes) ? classes.find(value => typeof value === 'string' && value.startsWith('language-')) : undefined;
  const language = typeof languageClass === 'string' ? languageClass.slice('language-'.length) : undefined;
  const code = codeNode.children.map(child => child.type === 'text' ? child.value : '').join('').replace(/\n$/, '');
  const start = node?.position?.start.offset;
  const end = node?.position?.end.offset;
  const linePrefix = start === undefined ? '' : content.slice(content.lastIndexOf('\n', start - 1) + 1, start);
  const quoteDepth = linePrefix.split('>').length - 1;
  const receiving = isStreaming && start !== undefined && end !== undefined && end >= content.trimEnd().length && isOpenFence(content.slice(start, end), quoteDepth);
  return <GlassCodeBlock language={language} isStreaming={receiving} conversationId={conversationId}>{code}</GlassCodeBlock>;
}

function InlineCode({ children, className }: ComponentProps<'code'>) {
  return <code className={className} style={{ background: 'rgba(139, 115, 85, 0.08)', padding: '2px 6px', borderRadius: '3px', fontSize: '0.9em', fontFamily: "'SF Mono', monospace", color: '#b85845' }}>{children}</code>;
}

const components: Components = { pre: MarkdownCodeBlock, code: InlineCode };

interface SmartMarkdownProps {
  content: string;
  isStreaming?: boolean;
  conversationId?: string;
}

const SmartMarkdown = memo(function SmartMarkdown({ content, isStreaming = false, conversationId }: SmartMarkdownProps) {
  const value = useMemo(() => ({ content, isStreaming, conversationId }), [content, isStreaming, conversationId]);
  return (
    <MarkdownContext.Provider value={value}>
      <div style={{ fontFamily: "Cambria, Georgia, 'Times New Roman', serif, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', serif", fontSize: 'inherit' }}>
        <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>{content}</ReactMarkdown>
      </div>
    </MarkdownContext.Provider>
  );
});

export default SmartMarkdown;
