// 玻璃风格代码块组件
import React, { useState, useEffect } from 'react';
import { message } from 'antd';
import { ChevronDown, ChevronRight } from 'lucide-react';
import CodeHighlighter from '../../common/CodeHighlighter';
import { CopyOutlined, CheckOutlined } from '@ant-design/icons';
import CodeBlockPreview from '../../common/CodeBlockPreview';
import { useT } from '../../../i18n/hooks';

interface GlassCodeBlockProps {
  language?: string;
  children: string;
  className?: string;
  isStreaming?: boolean;
  conversationId?: string;
}

/**
 * 玻璃风格代码块组件
 * 提供代码高亮、复制、预览和折叠功能
 */
const GlassCodeBlock: React.FC<GlassCodeBlockProps> = ({
  language,
  children,
  className,
  isStreaming = false,
  conversationId
}) => {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const copyButtonRef = React.useRef<HTMLDivElement>(null);
  const copyTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = React.useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, []);
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);
  const [lockAtBottom, setLockAtBottom] = useState(true);

  // 流式输出时自动滚动到底部
  React.useLayoutEffect(() => {
    if (scrollContainerRef.current && isStreaming && expanded && lockAtBottom) {
      const el = scrollContainerRef.current;
      el.scrollTop = el.scrollHeight - el.clientHeight;
    }
  }, [children, isStreaming, expanded, lockAtBottom]);

  useEffect(() => {
    if (isStreaming) {
      setLockAtBottom(true);
    }
  }, [isStreaming]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      if (!mountedRef.current) return;
      setCopied(true);
      message.success(t('pages.chatSystem.messageDisplay.codeCopied'));
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        setCopied(false);
        // 清除可能残留的内联样式
        if (copyButtonRef.current) {
          copyButtonRef.current.style.color = '';
          copyButtonRef.current.style.background = '';
        }
      }, 500);
    } catch {
      if (mountedRef.current) message.error(t('pages.chatSystem.messageDisplay.copyFailed'));
    }
  };

  return (
    <div className={className} style={{
      margin: '12px 0',
      borderRadius: '6px',
      background: 'rgba(255, 255, 255, 1)',
      border: '1px solid rgba(139, 115, 85, 0.15)',
      boxShadow: 'none',
      overflow: 'hidden',
      transition: 'all 0.3s cubic-bezier(0.23, 1, 0.32, 1)'
    }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '10px 14px',
          cursor: 'pointer',
          background: 'rgba(245, 243, 240, 0.6)',
          borderBottom: expanded ? '1px solid rgba(139, 115, 85, 0.15)' : 'none'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {expanded ? (
            <ChevronDown size={16} strokeWidth={1.5} style={{ color: '#8b7355' }} />
          ) : (
            <ChevronRight size={16} strokeWidth={1.5} style={{ color: '#8b7355' }} />
          )}
          <span style={{
            color: '#8b7355',
            fontWeight: 500,
            fontSize: '12px',
            textTransform: 'uppercase',
            letterSpacing: '0.5px'
          }}>
            {language || 'text'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <CodeBlockPreview
            language={language || 'text'}
            content={children}
            isStreaming={isStreaming}
            conversationId={conversationId}
          />
          <div
            ref={copyButtonRef}
            onClick={(e) => {
              e.stopPropagation();
              handleCopy();
            }}
            style={{
              padding: '4px',
              borderRadius: '4px',
              color: copied ? '#b85845' : '#8b7355',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
              background: 'transparent'
            }}
            onMouseEnter={(e) => {
              if (!copied) {
                e.currentTarget.style.color = '#b85845';
                e.currentTarget.style.background = 'rgba(184, 88, 69, 0.08)';
              }
            }}
            onMouseLeave={(e) => {
              if (!copied) {
                e.currentTarget.style.color = '#8b7355';
                e.currentTarget.style.background = 'transparent';
              }
            }}
          >
            {copied ? <CheckOutlined style={{ fontSize: '14px' }} /> : <CopyOutlined style={{ fontSize: '14px' }} />}
          </div>
        </div>
      </div>
      {expanded && (
        <div
          ref={scrollContainerRef}
          onScroll={() => {
            if (!scrollContainerRef.current) return;
            const el = scrollContainerRef.current;
            const dist = el.scrollHeight - el.clientHeight - el.scrollTop;
            const nearBottom = dist <= 4;
            if (isStreaming) setLockAtBottom(nearBottom);
          }}
          style={{
            maxHeight: '400px',
            overflow: 'auto',
            background: 'rgba(255, 255, 255, 0.85)',
            scrollbarWidth: 'thin',
            scrollbarColor: 'rgba(139, 115, 85, 0.3) rgba(245, 243, 240, 0.6)'
          }}
          className="code-block-scrollbar"
        >
          <CodeHighlighter language={language} code={children} />
        </div>
      )}
    </div>
  );
};

export default React.memo(GlassCodeBlock);
