import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism';
import oneLight from 'react-syntax-highlighter/dist/esm/styles/prism/one-light';
import vscDarkPlus from 'react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus';
import type { CodeHighlighterProps } from './CodeHighlighter';

const aliases: Record<string, string> = { 'c++': 'cpp', 'c#': 'csharp' };

export default function HighlightedCode({ code, language, theme = 'light', className }: CodeHighlighterProps) {
  const normalizedLanguage = language?.toLowerCase();
  const resolvedLanguage = normalizedLanguage ? (aliases[normalizedLanguage] ?? normalizedLanguage) : 'text';

  return <SyntaxHighlighter
    language={resolvedLanguage}
    style={theme === 'dark' ? vscDarkPlus : oneLight}
    className={className}
    customStyle={{ margin: 0, borderRadius: 0 }}
  >{code}</SyntaxHighlighter>;
}
