import MarkdownCode from '../common/MarkdownCode';
import React from 'react';
import { Input } from 'antd';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

const { TextArea } = Input;

interface PromptEditorProps {
  content: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  placeholder?: string;
}

const PromptEditor: React.FC<PromptEditorProps> = ({
  content,
  onChange,
  readOnly = false,
  placeholder = '输入提示词内容...',
}) => {
  // Render markdown content
  const renderMarkdown = () => (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          pre: MarkdownCode,
          table({ children }) {
            return (
              <div style={{ overflowX: 'auto', marginBottom: '16px' }}>
                <table
                  style={{
                    borderCollapse: 'collapse',
                    width: '100%',
                    marginBottom: '16px',
                  }}
                >
                  {children}
                </table>
              </div>
            );
          },
          th({ children }) {
            return (
              <th
                style={{
                  border: '1px solid #ddd',
                  padding: '8px',
                  background: '#f5f5f5',
                  textAlign: 'left',
                }}
              >
                {children}
              </th>
            );
          },
          td({ children }) {
            return (
              <td
                style={{
                  border: '1px solid #ddd',
                  padding: '8px',
                }}
              >
                {children}
              </td>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );

  return (
    <div style={{ display: 'flex', gap: '16px', height: '100%', minWidth: 0 }}>
      {/* 左侧编辑器 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <TextArea
          value={content}
          onChange={(e) => !readOnly && onChange(e.target.value)}
          readOnly={readOnly}
          style={{
            flex: 1,
            fontFamily: 'Monaco, Consolas, "Courier New", monospace',
            fontSize: '14px',
            lineHeight: '1.6',
            resize: 'none',
            borderColor: 'rgba(139, 115, 85, 0.25)',
            borderRadius: '8px',
            wordBreak: 'break-word',
            overflowWrap: 'break-word'
          }}
          onFocus={(e) => {
            e.target.style.borderColor = '#b85845';
            e.target.style.boxShadow = '0 0 0 2px rgba(184, 88, 69, 0.1)';
          }}
          onBlur={(e) => {
            e.target.style.borderColor = 'rgba(139, 115, 85, 0.25)';
            e.target.style.boxShadow = 'none';
          }}
          placeholder={placeholder}
        />
      </div>

      {/* 右侧预览 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            padding: '16px',
            background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.95) 0%, rgba(250, 248, 245, 0.9) 100%)',
            border: '1px solid rgba(139, 115, 85, 0.15)',
            borderRadius: '8px',
            boxShadow: 'inset 0 1px 3px rgba(139, 115, 85, 0.08)',
            wordBreak: 'break-word',
            overflowWrap: 'break-word'
          }}
        >
          {renderMarkdown()}
        </div>
      </div>
    </div>
  );
};

export default PromptEditor;
