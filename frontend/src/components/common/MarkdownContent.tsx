import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatexCached from '../../utils/rehypeKatexCached';
import remarkMathDelimiters from '../../utils/remarkMathDelimiters';
import 'katex/dist/katex.min.css';
import './MarkdownContent.css';

const remarkPlugins = [remarkGfm, remarkMath, remarkMathDelimiters];
const rehypePlugins = [rehypeKatexCached];

interface MarkdownContentProps {
  children: string;
  components?: Components;
  className?: string;
}

/** 为聊天和预览提供一致的 Markdown 与数学渲染。 */
export default function MarkdownContent({ children, components, className }: MarkdownContentProps) {
  return (
    <div className={className ? `markdown-content ${className}` : 'markdown-content'}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>{children}</ReactMarkdown>
    </div>
  );
}
