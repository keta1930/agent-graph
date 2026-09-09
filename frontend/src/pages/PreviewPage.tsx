import { getErrorMessage } from '../utils/errors';
import { loadMermaid } from '../utils/mermaid';
// src/pages/PreviewPage.tsx
import React, { useEffect, useMemo, useState, useRef, useId } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Space, Typography, message, Tooltip, Alert } from 'antd';
import { CheckOutlined } from '@ant-design/icons';
import { previewService } from '../services/previewService';

const { Title, Text } = Typography;

// 将 URL 参数中的内容进行解码
const decodeParam = (value: string | null): string => {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value || '';
  }
};

const PreviewPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const container = useRef<HTMLDivElement>(null);
  const diagramId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const renderRevision = useRef(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  const shareId = searchParams.get('id');
  const paramLang = (searchParams.get('lang') || 'text').toLowerCase();
  const paramTitle = searchParams.get('title') || '内容预览';
  const paramContent = useMemo(() => decodeParam(searchParams.get('c')), [searchParams]);

  const [lang, setLang] = useState<string>(paramLang);
  const [title, setTitle] = useState<string>(paramTitle);
  const [content, setContent] = useState<string>(paramContent);
  const [loading, setLoading] = useState<boolean>(false);

  const [copying, setCopying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleCopyLink = async () => {
    try {
      setCopying(true);
      await navigator.clipboard.writeText(window.location.href);
      message.success('Copy Success');
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 500);
    } catch (e) {
      message.error('复制失败：' + getErrorMessage(e));
    } finally {
      setCopying(false);
    }
  };

  // 通过短链ID加载内容（如有），否则使用URL参数
  useEffect(() => {
    let active = true;
    setError(null);
    setLoading(false);
    const load = async () => {
      if (!shareId) {
        setLang(paramLang);
        setTitle(paramTitle);
        setContent(paramContent);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const res = await previewService.getShare(shareId);
        if (!active) return;
        setLang(res.lang?.toLowerCase() || 'text');
        setTitle(res.title || '内容预览');
        setContent(res.content || '');
      } catch (e) {
        if (!active) return;
        setError('加载短链内容失败：' + getErrorMessage(e));
        // 回退为参数内容（如果存在）
        setLang(paramLang);
        setTitle(paramTitle);
        setContent(paramContent);
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [shareId, paramLang, paramTitle, paramContent]);

  useEffect(() => {
    if (lang !== 'mermaid' || !container.current) return;
    let active = true;
    const revision = ++renderRevision.current;
    const element = container.current;
    element.textContent = content;
    setError(null);
    void loadMermaid().then(async mermaid => {
      if (!active) return;
      const result = await mermaid.render('mermaid-' + diagramId + '-' + revision, content);
      if (!active) return;
      element.innerHTML = result.svg;
      result.bindFunctions?.(element);
    }).catch(error => { if (active) setError('图表渲染失败：' + getErrorMessage(error)); });
    return () => { active = false; };
  }, [lang, content, diagramId]);

  const renderContent = () => {
    if (!content?.trim()) {
      return <Alert type="info" message="没有可预览的内容" showIcon />;
    }

    if (lang === 'html') {
      return (
        <iframe
          title="HTML 预览"
          srcDoc={content}
          sandbox="allow-scripts allow-popups"
          style={{ width: '100%', height: '80vh', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff' }}
        />
      );
    }

    if (lang === 'svg') {
      const svgDoc = `<!DOCTYPE html><html><head><meta charset="utf-8" /></head><body style="margin:0;padding:16px;background:#fff;">${content}</body></html>`;
      return (
        <iframe
          title="SVG 预览"
          srcDoc={svgDoc}
          sandbox="allow-scripts"
          style={{ width: '100%', height: '80vh', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff' }}
        />
      );
    }

    if (lang === 'mermaid') {
      return (
        <div style={{ width: '100%', minHeight: '60vh', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 }}>
          {error && (
            <Alert type="error" message={error} showIcon style={{ marginBottom: 12 }} />
          )}
          <div ref={container} className="mermaid" style={{ overflow: 'auto' }} />
        </div>
      );
    }

    // 默认：纯文本显示
    return (
      <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 }}>
        {content}
      </pre>
    );
  };

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>{title}</Title>
        <Space>
          <Tooltip title="Copy URL">
            <Button loading={copying} onClick={handleCopyLink} icon={copied ? <CheckOutlined /> : undefined} style={copied ? { color: '#52c41a', borderColor: '#52c41a' } : undefined}>
              URL
            </Button>
          </Tooltip>
        </Space>
      </div>

      {loading && (
        <div style={{ marginBottom: 12 }}>
          <span style={{ marginLeft: 8 }}><Text type="secondary">加载中...</Text></span>
        </div>
      )}

      {renderContent()}
    </div>
  );
};

export default PreviewPage;